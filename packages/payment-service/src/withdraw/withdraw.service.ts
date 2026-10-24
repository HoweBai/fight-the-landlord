// packages/payment-service/src/withdraw/withdraw.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import {
  ErrCode,
  WITHDRAW_PREFIX,
  type AdminPayWithdrawConfirmResponse,
  type AdminPayWithdrawReviewResponse,
  type PayWithdrawApplyResponse,
  type PayWithdrawInfo,
  type PayWithdrawalsPage,
  type PayWithdrawStatus,
} from '@fight-the-landlord/protocol';
import { fen2yuan } from '../channel/alipay/params';
import { ConfigCacheService } from '../config/config-cache.service';
import { DomainError } from '../http/errors';
import { UserLockService } from '../locks/user-lock.service';
import { paymentFundopOldestAgeSeconds, paymentFundopPending, paymentWithdrawOldestAgeSeconds, paymentWithdrawPending } from '../metrics/payment.metrics';
import { clampMineLimit, decodePayOrdersCursor, encodePayOrdersCursor } from '../orders/pay-orders-cursor';
import { CurrencyRpcClient, TRANSPORT_FAILURE_MESSAGE } from '../rpc/currency.client';
import { fundOpAnchor, replayAnchor } from '../scan/replay-anchor';
import { queryWithdrawDayTotal, WITHDRAW_DAY_TOTAL_SQL } from './withdraw-day-limit';

/**
 * 支付片 T10：**提现链**（申请即冻结 / claim 先行 / 超时回滚；规格 §3.2 状态机逐字 ·
 * §3.4④⑤ · §2.2.1 cap 纪律 · ⚙️15 幂等槽 · §2.6 指标写点；设计 §5.2/§5.3/§2.5）。
 *
 * ─── 状态机（§3.2 逐字）──────────────────────────────────────────────────────
 *  ```
 *  holding →(解析成功)→ pending →(claim: pending→approved)→ approved →(claim: approved→paid)→ paid
 *  holding →(解析明确失败)→ failed
 *  pending|approved →(claim with reason=rejected)→ rolling_back →(rb 落账)→ rejected
 *  pending|approved →(claim like timeout; scanned pending|approved AND timeout_at<NOW)→
 *                                 rolling_back →(rb 落账)→ timeout_rolled_back
 *  ```
 *
 * ─── 四条纪律（设计 §2.5 / §5.2 / §5.3）──────────────────────────────────────
 *  ① **申请在锁内三段**（`withUserLock`）：校验清单（开关·门槛·单笔·日限·cap〔**此刻**，
 *     fail-closed〕·无未解析 holding）→ INSERT `holding`+`active_slot=1` → `apply{withdraw:}`；
 *     锁内最多两发 RPC（withdrawable.get + apply，各 3s，见设计 §2.4 预算）。**禁缓存、禁只查
 *     一次** cap（§2.2.1）。
 *  ② **holding 只解析、永不回滚**（§5.3）：holding = hold 的 apply 结果未知；只有 hold 已确认
 *     落账才允许发 `withdraw_rb`。解析持续未知 ⇒ 无限重试 + `payment_fundop_oldest_age_seconds`
 *     告警（钱没动，等得起）。
 *  ③ **claim 先行**（§5.3）：一切迁移条件 UPDATE 先抢行，再动外部（钱），最后记完成列——
 *     驳回/超时 claim 与 confirm 互斥（谁先抢行谁生效，后到者 affected=0 ⇒ 15009），**双付面
 *     （线下已付 + 币回滚）被结构性消除**。
 *  ④ **回滚例外**（§2.5④）：`withdraw_rb` 明确失败/未知 ⇒ **留停留态 rolling_back + last_error**
 *     转人工（绝不误置终态、不释槽：误置 = 币未回而槽已放，破钱）；恢复扫描同锚重放收敛。
 *
 * ─── 时区 / 时钟 / 槽 ────────────────────────────────────────────────────────
 *  存储 UTC；日限归日一律 **+08:00 自然日**（CONVERT_TZ 偏移写法，照 ③ `finance-query`
 *  先例）；一切时间判定（timeout_at/日界）走 **DB 时钟 NOW(3)**（单点权威）。
 *  ⚙️15：在途 `active_slot=1`；提现四终态（`paid/rejected/timeout_rolled_back/failed`）
 *  置 NULL——终态终可再申请；`UNIQUE(user_id, active_slot)` 兜底「同用户至多一笔在途」。
 *
 * ─── 失败面（§2.4.1 #8 / §2.8 文案逐字）────────────────────────────────────
 *  15003（开关/门槛/0 分/占位/fail-closed/在途槽）· 15004（单笔/单日）· 15005（cap 不足）·
 *  管理写面非法源态 15009（message 含当前态与合法动作）。
 */
@Injectable()
export class WithdrawService {
  private readonly logger = new Logger(WithdrawService.name);

  /** ⚠️ **值导入**四个依赖（DI 陷阱纪律：类型导入会被擦除 ⇒ 容器解析崩）。 */
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigCacheService) private readonly configCache: ConfigCacheService,
    @Inject(CurrencyRpcClient) private readonly currency: CurrencyRpcClient,
    @Inject(UserLockService) private readonly locks: UserLockService,
  ) {}

  /* ────────────────────────────── 申请（锁内三段）────────────────────────────── */

  /**
   * `POST /api/pay/withdrawals`（§2.4.1 #8）：锁内三段 + 校验清单逐字（§3.2）。
   *
   * 响应 `status` 为首笔落账后的实际态：成功 ⇒ `pending`；明确失败 ⇒ `failed`（行已留档）；
   * 未知 ⇒ `holding`（循环④解析收敛）。校验拒绝（15003/15004/15005）⇒ 锁内抛、事务整体回滚、
   * **零行落库**。
   */
  async apply(userId: string, coins: unknown): Promise<PayWithdrawApplyResponse> {
    const result = await this.locks.withUserLock(userId, (manager) => this.applyWithin(manager, userId, coins));
    await this.refreshWithdrawGauges();
    return result;
  }

  /** 锁内体（见类头①；`manager` = 与行锁同事务 ⇒ 校验/插入/落账原子）。 */
  private async applyWithin(
    manager: EntityManager,
    userId: string,
    coins: unknown,
  ): Promise<PayWithdrawApplyResponse> {
    // ① 开关（15003；**只挡新建**——在途照常可审可确认、超时照常回滚，§5.3）。
    if (!this.configCache.withdrawEnabled()) {
      throw new DomainError(ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（功能未开放）');
    }
    // ② 门槛（15003；非整数/字符串/缺省同出口——严格类型，防 '2000000' 字符串比较穿透）。
    const minCoins = this.configCache.withdrawMinCoins();
    if (typeof coins !== 'number' || !Number.isSafeInteger(coins) || coins < minCoins) {
      throw new DomainError(ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（低于门槛）');
    }
    // ③ 单笔上限（15004）。
    if (coins > this.configCache.withdrawMaxCoinsPerOrder()) {
      throw new DomainError(ErrCode.PAY_WITHDRAW_LIMIT, '超出限额（单笔）');
    }
    // ④ 金额快照：amount_fen = floor(coins × 100 / coinPerYuan)（行内即出款快照；⚙️5 禁浮点，
    //    coins×100 ≤ 1e8 安全整数域内除法无精度险）。换算得 0 分 ⇒ 拒（15003）。
    const amountFen = Math.floor((coins * 100) / this.configCache.coinPerYuan());
    if (amountFen <= 0) {
      throw new DomainError(ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（低于门槛）');
    }
    // ⑤ 日限（15004）：归日 = `created_at` 落入 +08:00 自然日；计入 status ∈ 五态
    //    （**共享读** `queryWithdrawDayTotal`——钱包 summary 的 `dailyWithdrawRemainingCoins`
    //    消费同一件，禁第二实现，T13）。
    const dayTotal = await queryWithdrawDayTotal(manager, userId);
    if (dayTotal + coins > this.configCache.withdrawDailyMaxCoins()) {
      throw new DomainError(ErrCode.PAY_WITHDRAW_LIMIT, '超出限额（单日）');
    }
    // ⑥ cap（§2.2.1：**资金动作时刻**取数，禁缓存；RPC 失败 ⇒ fail-closed 拒 15003）。
    let cap: number;
    try {
      ({ cap } = await this.currency.withdrawable({ ownerId: userId }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`cap 取数失败（fail-closed 拒申请）user_id=${userId}: ${reason}`);
      throw new DomainError(ErrCode.PAY_WITHDRAW_UNAVAILABLE, `提现暂不可用（${TRANSPORT_FAILURE_MESSAGE}）`);
    }
    if (coins > cap) {
      throw new DomainError(ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT, '可提余额不足');
    }
    // ⑦ 本人无未解析 holding（提现/退款任一；§2.4 跨面占位——关掉「apply 结果未知的冻结尚未进
    //    cap、另一消费面孔秒级重复占用同一 cap 头寸」的残余窗）。
    const holds = (await manager.query(UNRESOLVED_HOLDING_SQL, [userId, userId])) as unknown[];
    if (holds.length > 0) {
      throw new DomainError(ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（有处理中申请，请稍后重试）');
    }
    // ⑧ INSERT `holding` + `active_slot=1`（timeout_at 由 DB 时钟生成；撞槽 UK ⇒ 15003 已有在途）。
    const withdrawNo = await this.insertHolding(manager, {
      userId,
      coins,
      amountFen,
      timeoutMinutes: this.configCache.withdrawTimeoutMinutes(),
    });
    // ⑨ 冻结（锁内第二发 RPC；锚先于落账——随 apply 请求过线）。首尝试不计 retry（非重放）。
    const outcome = await replayAnchor(
      this.currency,
      'withdraw_hold',
      fundOpAnchor('withdraw_hold', withdrawNo),
      {
        source: 'withdraw_hold',
        refId: withdrawNo,
        entries: [{ ownerId: userId, delta: -coins }],
      },
      { countRetry: false },
    );
    if (outcome.kind === 'applied') {
      await manager.query(WITHDRAW_HOLD_TO_PENDING_SQL, [withdrawNo]);
      return { withdrawNo, status: 'pending' };
    }
    if (outcome.kind === 'definitive_failure') {
      await manager.query(WITHDRAW_HOLD_TO_FAILED_SQL, [truncateTo255(outcome.message), withdrawNo]);
      return { withdrawNo, status: 'failed' };
    }
    // 未知 ⇒ 留 holding（§2.5①：绝不写假终态；循环④解析收敛）。
    return { withdrawNo, status: 'holding' };
  }

  /** 插行（单号撞 `uk_withdraw_no` ⇒ 换号重试；撞 `uk_withdrawals_user_active` ⇒ 15003）。 */
  private async insertHolding(
    manager: EntityManager,
    args: { userId: string; coins: number; amountFen: number; timeoutMinutes: number },
  ): Promise<string> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const withdrawNo = generateWithdrawNo();
      try {
        await manager.query(INSERT_WITHDRAWAL_SQL, [
          withdrawNo,
          args.userId,
          args.coins,
          args.amountFen,
          args.timeoutMinutes,
        ]);
        return withdrawNo;
      } catch (err) {
        if (isDuplicateEntryError(err) && errorMentionsKey(err, 'uk_withdrawals_user_active')) {
          // ⚙️15 幂等槽兜底：同用户至多一笔在途（前序校验的毫秒级竞态面）。
          throw new DomainError(ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（已有在途申请）');
        }
        if (isDuplicateEntryError(err) && errorMentionsKey(err, 'uk_withdraw_no')) {
          lastErr = err; // 单号碰撞（天文级罕见）⇒ 换号重试
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('提现单号生成冲突');
  }

  /* ─────────────────────── 玩家读面：`GET /api/pay/withdrawals/mine`（T13）─────────────────────── */

  /**
   * `GET /api/pay/withdrawals/mine`（§2.4.1 #9）：keyset（默认 20、≤50）· **只本人**
   * （`user_id` 是 WHERE 第一条件）。游标 **先于任何查询**校验（非法 ⇒ 10001，不落一次库）；
   * 多取一行判 hasMore（`nextCursor === null` ⇒ 终页）。游标件 = `pay-orders-cursor.ts`
   * 叶子共享（`epochMs:rowId` base64url，同 orders `mine` 口径；禁双实现）。
   */
  async mine(userId: string, query: { cursor?: unknown; limit?: unknown } = {}): Promise<PayWithdrawalsPage> {
    const limit = clampMineLimit(query.limit);
    const cursor = query.cursor === undefined ? null : decodePayOrdersCursor(query.cursor);

    const sql = WITHDRAW_MINE_SELECT_BASE + (cursor ? WITHDRAW_MINE_CURSOR_COND : '') + WITHDRAW_MINE_ORDER_LIMIT;
    const params: unknown[] = [userId];
    if (cursor) params.push(new Date(cursor.createdAtMs), new Date(cursor.createdAtMs), cursor.rowId);
    params.push(limit + 1); // 多取一行：判 hasMore，不入响应

    const rows = (await this.dataSource.query(sql, params)) as WithdrawMineRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    if (pageRows.length === 0) return { items: [], nextCursor: null };

    const items = pageRows.map(toPayWithdrawInfo);
    const last = pageRows[pageRows.length - 1]!;
    const nextCursor = hasMore
      ? encodePayOrdersCursor(toEpochMs(last.created_at, 'withdrawals.created_at'), toSafeInt(last.id, 'withdrawals.id'))
      : null;
    return { items, nextCursor };
  }

  /* ───────────────────────────── 循环④：holding 解析 ─────────────────────────── */

  /**
   * `resolveHolding()`（§3.4④ · §5.3）：全部 `holding` 行**同锚重放**（`withdraw:<no>`）——
   * 成功 ⇒ `pending`（记 `hold_confirmed_at`）；**明确失败** ⇒ `failed`（终态、释槽、`last_error`
   * 摘要）；未知 ⇒ 停留 + 下轮重试（>15m ⇒ 告警）。**永不回滚**（holding 的钱可能没动，rb 会凭空造钱）。
   *
   * @returns 本轮收敛（条件更新命中）的行数
   */
  async resolveHolding(): Promise<number> {
    const rows = (await this.dataSource.query(SELECT_HOLDING_SQL)) as Array<{
      withdraw_no?: unknown;
      user_id?: unknown;
      coins?: unknown;
    }>;
    let resolved = 0;
    for (const row of rows) {
      const no = String(row.withdraw_no);
      const outcome = await replayAnchor(this.currency, 'withdraw_hold', fundOpAnchor('withdraw_hold', no), {
        source: 'withdraw_hold',
        refId: no,
        entries: [{ ownerId: String(row.user_id), delta: -toSafeInt(row.coins, 'withdrawals.coins') }],
      });
      if (outcome.kind === 'applied') {
        const updated = await this.dataSource.query(WITHDRAW_HOLD_TO_PENDING_SQL, [no]);
        if (affectedRowsOf(updated, `提现 ${no} holding→pending`) === 1) resolved += 1;
      } else if (outcome.kind === 'definitive_failure') {
        const updated = await this.dataSource.query(WITHDRAW_HOLD_TO_FAILED_SQL, [
          truncateTo255(outcome.message),
          no,
        ]);
        if (affectedRowsOf(updated, `提现 ${no} holding→failed`) === 1) resolved += 1;
      }
      // unknown ⇒ 停留 holding（不迁任何态、零写）。
    }
    await this.refreshWithdrawGauges();
    return resolved;
  }

  /* ───────────────────────────── 循环⑤：超时回滚 ────────────────────────────── */

  /**
   * `rollbackTimeout()`（§3.4⑤ · §5.3）：**先 claim 后落账**两段——
   *  ⑤a 超时 claim（批量条件更新）：`pending|approved` 且 `timeout_at < NOW(3)` ⇒
   *     `rolling_back(reason=timeout)`（holding 不参与——只解析不回滚）；
   *  ⑤b 回滚恢复：`rolling_back` 且未落账（含驳回路径的停留行）⇒ 重放 `withdraw_rb:<no>` ⇒
   *     成功 ⇒ 按 `rollback_reason` 落 `rejected`/`timeout_rolled_back`（记 `rolled_back_at`、释槽）；
   *     非成功 ⇒ 留停留态 + `last_error`（§2.5④，转人工）。
   *
   * @returns 本轮回滚**落账**（达终态）的行数
   */
  async rollbackTimeout(): Promise<number> {
    await this.dataSource.query(WITHDRAW_TIMEOUT_CLAIM_SQL);
    const rows = (await this.dataSource.query(SELECT_ROLLING_BACK_SQL)) as RollbackTargetRow[];
    let rolledBack = 0;
    for (const row of rows) {
      if (await this.applyRollback(row)) rolledBack += 1;
    }
    await this.refreshWithdrawGauges();
    return rolledBack;
  }

  /** 单行回滚落账（审驳回路径与循环⑤共用）：rb 锚重放 ⇒ 终态或停留（见类头④）。
   *  `countRetry`（§2.6·5 语义：同锚**重放**才计）= 循环⑤传 true（扫描的家谱是重试）；
   *  审驳回的 inline 首尝试传 false（照 apply/即时入账的 `countRetry:false` 先例）。 */
  private async applyRollback(row: RollbackTargetRow, opts: { countRetry?: boolean } = {}): Promise<boolean> {
    const no = String(row.withdraw_no);
    const outcome = await replayAnchor(
      this.currency,
      'withdraw_rb',
      fundOpAnchor('withdraw_rb', no),
      {
        source: 'withdraw_rollback',
        refId: no,
        entries: [{ ownerId: String(row.user_id), delta: toSafeInt(row.coins, 'withdrawals.coins') }],
      },
      opts,
    );
    if (outcome.kind !== 'applied') {
      // 🔴 回滚例外（§2.5④）：绝不误置终态、不释槽；last_error 留摘要（replayAnchor 已 error 日志）。
      await this.dataSource.query(WITHDRAW_ROLLBACK_LAST_ERROR_SQL, [truncateTo255(outcome.message), no]);
      return false;
    }
    const terminalSql =
      row.rollback_reason === 'rejected' ? WITHDRAW_ROLLBACK_TO_REJECTED_SQL : WITHDRAW_ROLLBACK_TO_TIMEOUT_SQL;
    const updated = await this.dataSource.query(terminalSql, [no]);
    return affectedRowsOf(updated, `提现 ${no} 回滚落账`) === 1;
  }

  /** 读单行回滚目标（审驳回 claim 成功后的行读；字段集与循环⑤候选同形）。 */
  private async loadRollbackTarget(withdrawNo: string): Promise<RollbackTargetRow> {
    const rows = (await this.dataSource.query(SELECT_ROLLBACK_TARGET_SQL, [withdrawNo])) as RollbackTargetRow[];
    const row = rows[0];
    if (!row) {
      throw new Error(`提现 ${withdrawNo} 驳回 claim 后读不到行（不变量破坏）`);
    }
    return row;
  }

  /* ─────────────────────────────── 管理写面 ─────────────────────────────────── */

  /**
   * `POST /api/admin/pay/withdrawals/:withdrawNo/review`（§2.4.2 #6）：
   *  - approve：claim `pending→approved`（记审者/时刻/附言）；
   *  - reject：claim `pending|approved→rolling_back(reason=rejected)` ⇒ rb 落账 ⇒ `rejected`
   *    （rb 非成功 ⇒ 停留 `rolling_back`，响应返回**实际态**）。
   * 非法源态/不存在 ⇒ 15009（message 含当前态与合法动作；管理员 actor 由网关注入）。
   */
  async review(
    admin: string,
    withdrawNo: string,
    request: { action?: unknown; note?: unknown } | undefined,
  ): Promise<AdminPayWithdrawReviewResponse> {
    requireActor(admin);
    const action = request?.action;
    if (action !== 'approve' && action !== 'reject') {
      throw new DomainError(
        ErrCode.BAD_PARAM,
        `action 必须是 approve|reject（收到 ${JSON.stringify(action) ?? String(action)}）`,
      );
    }
    const note = normalizeNote(request?.note);

    if (action === 'approve') {
      const updated = await this.dataSource.query(WITHDRAW_APPROVE_SQL, [admin, note, withdrawNo]);
      if (affectedRowsOf(updated, `提现 ${withdrawNo} 审通过`) !== 1) {
        throw await this.stateConflict(withdrawNo, 'approve');
      }
      await this.refreshWithdrawGauges();
      return { withdrawNo, status: 'approved' };
    }

    // reject：claim 先行（与 confirm/超时扫描互斥）⇒ rb 落账 ⇒ 读实际态返回。
    const claimed = await this.dataSource.query(WITHDRAW_REJECT_CLAIM_SQL, [admin, note, withdrawNo]);
    if (affectedRowsOf(claimed, `提现 ${withdrawNo} 审驳回 claim`) !== 1) {
      throw await this.stateConflict(withdrawNo, 'reject');
    }
    await this.applyRollback(await this.loadRollbackTarget(withdrawNo), { countRetry: false });
    const status = await this.readStatus(withdrawNo);
    await this.refreshWithdrawGauges();
    return { withdrawNo, status };
  }

  /**
   * `POST /api/admin/pay/withdrawals/:withdrawNo/confirm`（§2.4.2 #7 / §5.4 人工打款台账）：
   * claim `WHERE status='approved'` ⇒ `paid` + `confirmed_by/at` + `voucher/confirm_note` + 释槽。
   * 非法源态/不存在 ⇒ 15009。**未登记 = 未打款**：claim 互斥再兜一层防重复付。
   */
  async confirmPaid(
    admin: string,
    withdrawNo: string,
    request: { voucher?: unknown; note?: unknown } | undefined,
  ): Promise<AdminPayWithdrawConfirmResponse> {
    requireActor(admin);
    const voucher = request?.voucher;
    if (typeof voucher !== 'string' || voucher.length === 0 || voucher.length > 64) {
      throw new DomainError(ErrCode.BAD_PARAM, 'voucher 必须是非空字符串（≤64 字符）');
    }
    const note = normalizeNote(request?.note);

    const updated = await this.dataSource.query(WITHDRAW_CONFIRM_PAID_SQL, [admin, voucher, note, withdrawNo]);
    if (affectedRowsOf(updated, `提现 ${withdrawNo} 确认打款`) !== 1) {
      throw await this.stateConflict(withdrawNo, 'confirm');
    }
    await this.refreshWithdrawGauges();
    return { withdrawNo, status: 'paid' };
  }

  /* ─────────────────────────────── 指标与内部 ────────────────────────────────── */

  /**
   * `payment_withdraw_pending{state}` / `_oldest_age_seconds{state}`（§2.6·7/8，
   * state ∈ pending/approved；年龄 = 最老 `created_at`，DB 时钟算）+ 同读刷
   * `payment_fundop_pending/_oldest_age_seconds{op=withdraw_hold|withdraw_rb}`（§2.6·3/4；
   * T9 交接：④⑤循环补其余两 op 标签）。写点 = apply/review/confirm 之后与 ④⑤ 循环末。
   */
  async refreshWithdrawGauges(): Promise<void> {
    const stats = (await this.dataSource.query(WITHDRAW_STATS_SQL)) as Array<{
      state?: unknown;
      cnt?: unknown;
      oldest?: unknown;
    }>;
    const byState = new Map(stats.map((r) => [String(r.state), r]));
    for (const state of ['pending', 'approved'] as const) {
      const row = byState.get(state);
      const cnt = Number(row?.cnt ?? 0);
      const oldest = Number(row?.oldest ?? 0);
      paymentWithdrawPending.labels(state).set(Number.isFinite(cnt) ? cnt : 0);
      paymentWithdrawOldestAgeSeconds.labels(state).set(Number.isFinite(oldest) ? oldest : 0);
    }

    const fundop = (await this.dataSource.query(WITHDRAW_FUNDOP_STATS_SQL)) as Array<{
      op?: unknown;
      cnt?: unknown;
      oldest?: unknown;
    }>;
    for (const row of fundop) {
      const op = String(row.op);
      if (op !== 'withdraw_hold' && op !== 'withdraw_rb') continue;
      const cnt = Number(row.cnt ?? 0);
      const oldest = Number(row.oldest ?? 0);
      paymentFundopPending.labels(op).set(Number.isFinite(cnt) ? cnt : 0);
      paymentFundopOldestAgeSeconds.labels(op).set(Number.isFinite(oldest) ? oldest : 0);
    }
  }

  /** 读现状（15009 message 的「当前态」素材；行不存在 ⇒ null）。 */
  private async readStatus(withdrawNo: string): Promise<PayWithdrawStatus> {
    const rows = (await this.dataSource.query(SELECT_WITHDRAW_STATUS_SQL, [withdrawNo])) as Array<{
      status?: unknown;
    }>;
    const status = rows[0]?.status;
    if (typeof status !== 'string') {
      throw new Error(`提现 ${withdrawNo} 读不到状态（不变量破坏）`);
    }
    return status as PayWithdrawStatus;
  }

  /** 15009（⚙️9）：message 含当前态与合法动作；行不存在 ⇒ 明说。 */
  private async stateConflict(withdrawNo: string, action: 'approve' | 'reject' | 'confirm'): Promise<DomainError> {
    const rows = (await this.dataSource.query(SELECT_WITHDRAW_STATUS_SQL, [withdrawNo])) as Array<{
      status?: unknown;
    }>;
    const current = typeof rows[0]?.status === 'string' ? String(rows[0]!.status) : null;
    const hints: Record<typeof action, string> = {
      approve: '仅 pending 可 approve',
      reject: '仅 pending/approved 可 reject',
      confirm: '仅 approved 可 confirm',
    };
    const message =
      current === null
        ? `提现单 ${withdrawNo} 不存在（无法 ${action}）`
        : `状态已变更：当前状态 ${current}，${hints[action]}`;
    return new DomainError(ErrCode.PAY_STATE_CONFLICT, message);
  }
}

/* ──────────────────────────── SQL 常量（全文钉）────────────────────────────── */
/* ⚠️ 全部裸 SQL（不用 entity；大 int、datetime(3)）；时间判定一律 DB `NOW(3)`；
 * 日界一律 `CONVERT_TZ(…,'+00:00','+08:00')` 偏移写法（不依赖 MySQL tz 表，照 ③ 先例）。 */

/** 日限合计（§3.2 归日口径逐字）——**迁至** `withdraw-day-limit.ts`（T13：钱包 summary 与
 *  本服务的 apply 双消费面共享；此处 re-export 保持既有消费面/测试导入零漂移）。 */
export { WITHDRAW_DAY_TOTAL_SQL };

/* ── T13：`GET /api/pay/withdrawals/mine` 的 keyset 读（静态段；投影 = `PayWithdrawInfo`）── */

/**
 * `mine` 读列（**列序 = protocol `PayWithdrawInfo` 素材**；`id` 前置 = keyset 内部列，
 * **必须真投影**——波 4 阻断-1（假库遮蔽族第 6 例）教训：缺列会让游标静默签出坏值，
 * 读取侧一律严格（`toSafeInt`，禁 `?? 0` 兜底）。参数 `[userId]`。
 */
export const WITHDRAW_MINE_SELECT_BASE =
  'SELECT `id`, `withdraw_no`, `coins`, `amount_fen`, `status`, `timeout_at`, `review_note`, `reviewed_at`, `confirmed_at`, `rolled_back_at`, `created_at` FROM `payment_withdrawals` WHERE `user_id` = ?';

/** keyset 游标条件（`(created_at, id)` 严格降序；同 orders `mine` 先例）。参数 `[Date, Date, rowId]`。 */
export const WITHDRAW_MINE_CURSOR_COND = ' AND (`created_at` < ? OR (`created_at` = ? AND `id` < ?))';

/** 排序 + 限行（多取一行判 hasMore）。参数 `[limit+1]`。 */
export const WITHDRAW_MINE_ORDER_LIMIT = ' ORDER BY `created_at` DESC, `id` DESC LIMIT ?';

/** 未解析 `holding` 占位（提现/退款任一；§2.4 跨面占位纪律）。参数 `[userId, userId]`。 */
export const UNRESOLVED_HOLDING_SQL =
  "SELECT `withdraw_no` AS `no` FROM `payment_withdrawals` WHERE `user_id` = ? AND `status` = 'holding' UNION ALL SELECT `refund_no` AS `no` FROM `payment_refunds` WHERE `user_id` = ? AND `status` = 'holding' LIMIT 1";

/** 申请插行（`holding` + `active_slot=1`；`timeout_at` 由 DB 时钟生成）。参数 `[no, userId, coins, amountFen, timeoutMinutes]`。 */
export const INSERT_WITHDRAWAL_SQL =
  'INSERT INTO `payment_withdrawals` (`withdraw_no`, `user_id`, `coins`, `amount_fen`, `timeout_at`, `active_slot`) VALUES (?, ?, ?, ?, NOW(3) + INTERVAL ? MINUTE, 1)';

/** 解析成功落账（holding→pending；记 `hold_confirmed_at`）。参数 `[no]`。 */
export const WITHDRAW_HOLD_TO_PENDING_SQL =
  "UPDATE `payment_withdrawals` SET `status`='pending', `hold_confirmed_at`=NOW(3) WHERE `withdraw_no`=? AND `status`='holding'";

/** 解析明确失败（holding→failed；**终态释槽** + `last_error` 摘要）。参数 `[lastError, no]`。 */
export const WITHDRAW_HOLD_TO_FAILED_SQL =
  "UPDATE `payment_withdrawals` SET `status`='failed', `active_slot`=NULL, `last_error`=? WHERE `withdraw_no`=? AND `status`='holding'";

/** 审通过 claim（pending→approved；记审者/时刻/附言）。参数 `[admin, note, no]`。 */
export const WITHDRAW_APPROVE_SQL =
  "UPDATE `payment_withdrawals` SET `status`='approved', `reviewed_by`=?, `reviewed_at`=NOW(3), `review_note`=? WHERE `withdraw_no`=? AND `status`='pending'";

/** 审驳回 claim（pending|approved→rolling_back；reason=rejected）。参数 `[admin, note, no]`。 */
export const WITHDRAW_REJECT_CLAIM_SQL =
  "UPDATE `payment_withdrawals` SET `status`='rolling_back', `rollback_reason`='rejected', `reviewed_by`=?, `reviewed_at`=NOW(3), `review_note`=? WHERE `withdraw_no`=? AND `status` IN ('pending','approved')";

/** 确认打款 claim（approved→paid；voucher 台账；**终态释槽**）。参数 `[admin, voucher, note, no]`。 */
export const WITHDRAW_CONFIRM_PAID_SQL =
  "UPDATE `payment_withdrawals` SET `status`='paid', `confirmed_by`=?, `confirmed_at`=NOW(3), `voucher`=?, `confirm_note`=?, `active_slot`=NULL WHERE `withdraw_no`=? AND `status`='approved'";

/** 超时 claim（批量；pending|approved 且 `timeout_at < NOW(3)` ⇒ rolling_back(reason=timeout)）。无参数。 */
export const WITHDRAW_TIMEOUT_CLAIM_SQL =
  "UPDATE `payment_withdrawals` SET `status`='rolling_back', `rollback_reason`='timeout' WHERE `status` IN ('pending','approved') AND `timeout_at` < NOW(3)";

/** 回滚落账终态（reason=rejected ⇒ rejected；释槽 + `rolled_back_at`）。参数 `[no]`。 */
export const WITHDRAW_ROLLBACK_TO_REJECTED_SQL =
  "UPDATE `payment_withdrawals` SET `status`='rejected', `rolled_back_at`=NOW(3), `active_slot`=NULL WHERE `withdraw_no`=? AND `status`='rolling_back' AND `rollback_reason`='rejected'";

/** 回滚落账终态（reason=timeout ⇒ timeout_rolled_back）。参数 `[no]`。 */
export const WITHDRAW_ROLLBACK_TO_TIMEOUT_SQL =
  "UPDATE `payment_withdrawals` SET `status`='timeout_rolled_back', `rolled_back_at`=NOW(3), `active_slot`=NULL WHERE `withdraw_no`=? AND `status`='rolling_back' AND `rollback_reason`='timeout'";

/** 回滚非成功的 `last_error` 摘要（§2.3 写点：解析/回滚失败摘要）。参数 `[message, no]`。 */
export const WITHDRAW_ROLLBACK_LAST_ERROR_SQL = 'UPDATE `payment_withdrawals` SET `last_error`=? WHERE `withdraw_no`=?';

/** 循环④候选（全部 `holding`；先老后新）。 */
export const SELECT_HOLDING_SQL =
  "SELECT `withdraw_no`, `user_id`, `coins` FROM `payment_withdrawals` WHERE `status` = 'holding' ORDER BY `created_at` ASC, `id` ASC";

/** 循环⑤回滚候选（`rolling_back` 且未落账——含驳回路径的停留行）。 */
export const SELECT_ROLLING_BACK_SQL =
  "SELECT `withdraw_no`, `user_id`, `coins`, `rollback_reason` FROM `payment_withdrawals` WHERE `status` = 'rolling_back' AND `rolled_back_at` IS NULL ORDER BY `created_at` ASC, `id` ASC";

/** 单行回滚目标读（审驳回 claim 成功后）。参数 `[no]`。 */
export const SELECT_ROLLBACK_TARGET_SQL =
  'SELECT `withdraw_no`, `user_id`, `coins`, `rollback_reason` FROM `payment_withdrawals` WHERE `withdraw_no` = ?';

/** 现状读（15009 message 素材）。参数 `[no]`。 */
export const SELECT_WITHDRAW_STATUS_SQL =
  'SELECT `status` FROM `payment_withdrawals` WHERE `withdraw_no` = ?';

/** `payment_withdraw_pending/_oldest_age_seconds{state}` 统计读（state ∈ pending/approved；无行 ⇒ 无结果行）。 */
export const WITHDRAW_STATS_SQL =
  "SELECT `status` AS `state`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_withdrawals` WHERE `status` IN ('pending','approved') GROUP BY `status`";

/** `payment_fundop_pending/_oldest_age_seconds{op}` 统计读（两 op 标签；UNION ALL 恒两行，缺面为 0）。 */
export const WITHDRAW_FUNDOP_STATS_SQL =
  "SELECT 'withdraw_hold' AS `op`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_withdrawals` WHERE `status` = 'holding' UNION ALL SELECT 'withdraw_rb' AS `op`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_withdrawals` WHERE `status` = 'rolling_back' AND `rolled_back_at` IS NULL";

/* ────────────────────────────── 工具与形状 ─────────────────────────────────── */

/** 回滚目标行（循环⑤与单行读同形）。 */
interface RollbackTargetRow {
  withdraw_no?: unknown;
  user_id?: unknown;
  coins?: unknown;
  rollback_reason?: unknown;
}

/** `mine` 读出的行（列名即 SQL 别名；`datetime(3)` 归一在这一层）。 */
interface WithdrawMineRow {
  id: unknown;
  withdraw_no: unknown;
  coins: unknown;
  amount_fen: unknown;
  status: unknown;
  timeout_at: unknown;
  review_note: unknown;
  reviewed_at: unknown;
  confirmed_at: unknown;
  rolled_back_at: unknown;
  created_at: unknown;
}

/** 状态机全值集（protocol `PayWithdrawStatus` 逐字；非状态机值 ⇒ 响亮抛）。 */
const WITHDRAW_STATUSES: readonly PayWithdrawStatus[] = [
  'holding',
  'pending',
  'approved',
  'paid',
  'rolling_back',
  'rejected',
  'timeout_rolled_back',
  'failed',
];

function asWithdrawStatus(value: unknown): PayWithdrawStatus {
  if (WITHDRAW_STATUSES.includes(value as PayWithdrawStatus)) return value as PayWithdrawStatus;
  // 不在状态机里的值不是合法状态（protocol/payment.ts 的联合类型注释）——响亮拒绝。
  throw new Error(`payment_withdrawals.status 非状态机值：${JSON.stringify(value)}`);
}

/** `datetime(3)` 的三种驱动形态 ⇒ epoch ms 整数（照 orders `mine` 先例）。 */
function toEpochMs(value: unknown, context: string): number {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(String(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`${context}：读出的时间不是有限毫秒（收到 ${JSON.stringify(value)}）`);
  }
  return ms;
}

function toEpochMsOrNull(value: unknown, context: string): number | null {
  return value === null || value === undefined ? null : toEpochMs(value, context);
}

/** 行 ⇒ REST 投影（protocol `PayWithdrawInfo` 十键逐字；`amountYuan` 为字符串——⚙️5 禁浮点）。 */
function toPayWithdrawInfo(row: WithdrawMineRow): PayWithdrawInfo {
  return {
    withdrawNo: String(row.withdraw_no),
    coins: toSafeInt(row.coins, 'withdrawals.coins'),
    amountYuan: fen2yuan(toSafeInt(row.amount_fen, 'withdrawals.amount_fen')),
    status: asWithdrawStatus(row.status),
    timeoutAt: toEpochMs(row.timeout_at, 'withdrawals.timeout_at'),
    reviewNote: row.review_note === null || row.review_note === undefined ? null : String(row.review_note),
    reviewedAt: toEpochMsOrNull(row.reviewed_at, 'withdrawals.reviewed_at'),
    confirmedAt: toEpochMsOrNull(row.confirmed_at, 'withdrawals.confirmed_at'),
    rolledBackAt: toEpochMsOrNull(row.rolled_back_at, 'withdrawals.rolled_back_at'),
    createdAt: toEpochMs(row.created_at, 'withdrawals.created_at'),
  };
}

/** ⚙️4：单号随机段（base36 6 位；`randomInt` 无模偏差）。 */
function randomBase36(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += randomInt(36).toString(36);
  return out;
}

/** ⚙️4：`wd_` + base36(毫秒) + 6 位随机 base36（字符集 `[0-9a-z_]`、长 ≤ 32）。 */
export function generateWithdrawNo(nowMs: number = Date.now()): string {
  return `${WITHDRAW_PREFIX}${nowMs.toString(36)}${randomBase36(6)}`;
}

/** 驱动回值判别：唯一键冲突（两种 UK 由 message 键名区分）。 */
function isDuplicateEntryError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ER_DUP_ENTRY';
}

function errorMentionsKey(err: unknown, key: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(key);
}

/** 数值列 ⇒ 安全整数（读不出 ⇒ 抛，不静默 NaN 进金额路径）。 */
function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/** 条件 UPDATE 的 `affectedRows` 判读（照 orders/scan 收紧口径：非整数 ⇒ 抛）。 */
function affectedRowsOf(result: unknown, context: string): number {
  const affected = (result as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof affected !== 'number' || !Number.isInteger(affected) || affected < 0) {
    throw new Error(`${context}：驱动未返回 affectedRows（收到 ${JSON.stringify(result)}）—— 拒绝继续`);
  }
  return affected;
}

/** `last_error` 列宽 255 的截断（写点清单：解析/回滚失败摘要）。 */
function truncateTo255(value: string): string {
  return value.length <= 255 ? value : value.slice(0, 255);
}

/** 管理操作者防线（网关 `x-admin-actor` 注入；写面绝无回退值）。 */
function requireActor(admin: unknown): asserts admin is string {
  if (typeof admin !== 'string' || admin.length === 0) {
    throw new DomainError(ErrCode.BAD_PARAM, '管理操作者缺失（x-admin-actor）');
  }
}

/** 审核/确认附言（可选 ≤255 列宽；非法形态当场拒，不静默截断）。 */
function normalizeNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string' || note.length > 255) {
    throw new DomainError(ErrCode.BAD_PARAM, 'note 必须是不超过 255 字符的字符串');
  }
  return note;
}

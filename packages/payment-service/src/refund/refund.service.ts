// packages/payment-service/src/refund/refund.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import {
  ErrCode,
  REFUND_PREFIX,
  type AdminPayRefundReviewResponse,
  type PayRefundApplyResponse,
  type PayRefundInfo,
  type PayRefundsPage,
  type PayRefundStatus,
} from '@fight-the-landlord/protocol';
import { AlipayClient, CHANNEL_CONFIG_ERROR } from '../channel/alipay/client';
import { fen2yuan } from '../channel/alipay/params';
import type { ChannelFailure, PaymentChannel, RefundRequest } from '../channel/payment-channel.interface';
import { DomainError } from '../http/errors';
import { UserLockService } from '../locks/user-lock.service';
import { paymentFundopOldestAgeSeconds, paymentFundopPending, paymentRefundTotal } from '../metrics/payment.metrics';
import { clampMineLimit, decodePayOrdersCursor, encodePayOrdersCursor } from '../orders/pay-orders-cursor';
import { CurrencyRpcClient, TRANSPORT_FAILURE_MESSAGE } from '../rpc/currency.client';
import { fundOpAnchor, replayAnchor } from '../scan/replay-anchor';
import { UNRESOLVED_HOLDING_SQL } from '../withdraw/withdraw.service';

/**
 * 支付片 T11：**退款链**（申请即冻结 / 审=渠道动作 / 驳回回滚；规格 §3.3 状态机逐字 ·
 * §3.4⑥⑦ · §2.2.1 cap 纪律 · ⚙️15 幂等槽 · §2.6 指标写点；设计 §6.1–§6.3 · §2.5 出站重试表）。
 *
 * ─── 状态机（§3.3 逐字）──────────────────────────────────────────────────────
 *  ```
 *  holding →(解析成功)→ pending →(claim: pending→approved)→ approved →(渠道成功)→ refunded（保留槽）
 *  pending|approved →(claim)→ rejecting →(rb 落账)→ rejected（释放槽）
 *  holding →(解析明确失败)→ failed（释放槽）
 *  approved 渠道明确失败 ⇒ 留 approved + last_error（退避表上限后停；人工面）
 *  ```
 *
 * ─── 四条纪律（设计 §2.5 / §6.1 / §6.2）─────────────────────────────────────
 *  ① **申请即冻结（锁内三段）**：校验（`order.status='credited'` · 槽 · `coins ≤ cap`（§2.2.1
 *     **此刻**取数，RPC 失败 ⇒ fail-closed 拒 15006）· 无未解析 `holding`）→ INSERT `holding`
 *     + `active_slot=1`（`amount_fen` = 订单行同单快照；`channel_out_request_no = refund_no`）
 *     → `apply{refund:<no>, refund_hold, −coins}`。杜绝「申请时过 cap、审批时已跨口径」的
 *     人工审窗口。锁内最多两发 RPC（withdrawable.get + apply，各 3s）。
 *  ② **审核 = 纯渠道动作**（§6.2）：钱在申请时已冻结——approve 后**唯一**动作是同步调
 *     `channel.refund`（`out_request_no = refund_no` 幂等键 ⇒ 重复退款不可能）；渠道成功 ⇒
 *     `refunded`（**无后续钱动作**——`refund_hold` 那一笔就是实际扣减）；驳回 ⇒ `refund_rb`
 *     回滚落账。
 *  ③ **`refunded` 保留槽**（⚙️15）：`UNIQUE(order_no, active_slot)` 的唯一键兼作「已退」结构
 *     标记，封死二次退款；仅 `rejected/failed` 置 NULL（可再发起——重报换新 `refund_no` ⇒
 *     新锚）。holding 只解析、**永不回滚**（rb 会凭空造钱）。
 *  ④ **回滚例外**（§2.5④）：`refund_rb` 明确失败/未知 ⇒ **留停留态 `rejecting` + last_error**
 *     转人工（绝不误置终态、不释槽）；恢复扫描（循环⑦）同锚重放收敛。
 *
 * ─── 出站重试（设计 §2.5 表：`trade.refund` 1s→5s→30s→2m→10m；上限后停 + 告警）────────
 *  approve 的渠道调用**就地**按退避表重试（初始 1 发 + 退避重试 5 发 = 上限 6 发；
 *  `REFUND_RETRY_BACKOFF_MS` 逐字；`sleep` 纯 `setTimeout` ⇒ fake timers 可测）。穷尽仍无成功
 *  回执 ⇒ **停**：留 `approved` + `last_error` + `payment_refund_total{channel_fail}` 计数
 *  （人工面 = 管理退款审核视图）；**不**释槽、**不**写假终态。
 *  ⚠️ 每发（第 2 发起）**先复核 claim**：退避间隙里该行可能已被驳回（approved→rejecting）——
 *  行已离开 `approved` ⇒ 停发（关掉「驳回回滚 + 渠道退款」双脚并出的窗口；已发出的那一发由
 *  `out_request_no` 幂等兜底，成功落账的 CAS `WHERE status='approved'` 失手时见 §CAS 失手）。
 *
 * ─── 未知结果收敛（规格 §3.3 **v1.1.4** 调和段；本片唯一的扫描渠道面）──────────────────
 *  穷尽后的 `last_error` **按最终失败类别落标记**（`classifyChannelFailure`）：
 *  - **未知**（传输级——超时/连接被拒/discard/验签失败；没拿到可信业务响应）⇒ `unknown:` 前缀；
 *  - **明确**（渠道有业务响应〔含业务拒，依 `channelCode/channelSubCode` 材质〕或本地配置缺失
 *    〔密钥未配的固定摘要 `CHANNEL_CONFIG_ERROR`〕）⇒ **不标记**、不重放，留人工面。
 *  `unknown:` 行由扫描低频重放收敛（`replayUnknown()`，循环⑧：每扫描周期 1 发，同
 *  `out_request_no` 幂等）：成功 ⇒ `refunded`；明确失败 ⇒ 替换 `last_error`（去前缀）停自动；
 *  仍未知 ⇒ 刷新标记（缀时刻）；`reviewed_at` 起 **>72h** 停自动（纯人工——手册纪律：驳回前
 *  先核渠道后台）。
 *
 * ─── CAS 失手（渠道已成为事实、但本地行已被他方处置）─────────────────────────
 *  渠道成功 → `UPDATE … WHERE refund_no=? AND status='approved'`；affected=0 且现状非 `refunded`
 *  ⇒ 不误置任何态（行保住他方写入的终态），把渠道单号写进 `last_error` 作对账线索 + error 级
 *  日志转人工（此为残余竞争窗——claim 只串行化本地迁移、不串行化外部渠道调用；登记见
 *  progress.md T11 行）。返回**实际态**（管理面「200 返回实际态」口径）。
 *
 * ─── 循环 ⑥⑦⑧（§3.4 + v1.1.4 §3.3）──────────────────────────────────────────
 *  ⑥ `resolveHolding()`：全部 `holding` 行同锚重放 `refund:<no>`（成功 ⇒ `pending` 记
 *     `hold_confirmed_at`；明确失败 ⇒ `failed` 释槽 + `last_error`；未知 ⇒ 停留 + 告警面）。
 *  ⑦ `rollbackRecovery()`：`rejecting` 行（「已 claim 未落账」集合）同锚重放 `refund_rb:<no>`
 *     ⇒ 落账 ⇒ `rejected` 释槽；非成功 ⇒ 留停留态 + `last_error`。
 *     ⚠️ **与 §3.4⑦ 逐字的偏离登记**：§3.4⑦ 写 `status='rejecting' AND rolled_back_at IS NULL`
 *     ——但 §2.3 冻结 DDL 的 `payment_refunds` **没有** `rolled_back_at` 列（该列只在
 *     `payment_withdrawals`；T3 迁移与真库逐字一致）。状态即事实：`rejecting` 行恰是「已 claim
 *     未落账」集合，rb 落账的条件更新（`WHERE status='rejecting'`）即移出候选 ⇒ 谓词取
 *     `status='rejecting'` 单条件（加列会破 §2.3 逐字 DDL，属方向相反的偏离）。
 *  ⑧ `replayUnknown()`（**v1.1.4 新增**）：`approved` + `unknown:` 标记（`reviewed_at` ≤72h）
 *     的行 ⇒ 同 `out_request_no` 低频重放（每扫描周期 1 发）；收敛语义见「未知结果收敛」段。
 *
 * ─── 槽 / 时钟 ──────────────────────────────────────────────────────────────
 *  ⚙️15：在途 `active_slot=1`；`refunded` **保留 1**（结构标记）；`rejected/failed` 置 NULL。
 *  一切时间判定走 **DB 时钟 NOW(3)**（单点权威）。
 *
 * ─── 失败面（§2.4.1 #6 / §2.8 文案逐字）─────────────────────────────────────
 *  15002（订单不存在/非本人）· 15006（未入账/处理中/已退过/超出可退额度/有处理中申请，请稍后
 *  重试/服务暂时不可用，请稍后重试）· 入参形状 10001 · 管理写面非法源态 15009。
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  /** ⚠️ **值导入**四个依赖（DI 陷阱纪律：类型导入会被擦除 ⇒ 容器解析崩）。 */
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(CurrencyRpcClient) private readonly currency: CurrencyRpcClient,
    @Inject(UserLockService) private readonly locks: UserLockService,
    @Inject(AlipayClient) private readonly channel: PaymentChannel,
  ) {}

  /* ────────────────────────────── 申请（锁内三段）────────────────────────────── */

  /**
   * `POST /api/pay/refunds`（§2.4.1 #6）：锁内三段 + 校验清单逐字（§3.3/设计 §6.1）。
   *
   * 响应 `status` 为首笔落账后的实际态：成功 ⇒ `pending`；明确失败 ⇒ `failed`（行已留档）；
   * 未知 ⇒ `holding`（循环⑥解析收敛）。校验拒绝（15002/15006）⇒ 锁内抛、事务整体回滚、
   * **零行落库**；入参形状（10001）在锁前拒。
   */
  async apply(
    userId: string,
    request: { orderNo?: unknown; reason?: unknown } | undefined,
  ): Promise<PayRefundApplyResponse> {
    const orderNo = request?.orderNo;
    if (typeof orderNo !== 'string' || orderNo.length === 0 || orderNo.length > 32) {
      throw new DomainError(
        ErrCode.BAD_PARAM,
        `orderNo 必须是 1..32 字符的字符串（收到 ${JSON.stringify(orderNo)}）`,
      );
    }
    const reason = request?.reason;
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 255) {
      throw new DomainError(
        ErrCode.BAD_PARAM,
        `reason 必须是 1..255 字符的字符串（收到 ${JSON.stringify(reason)}）`,
      );
    }

    const result = await this.locks.withUserLock(userId, (manager) =>
      this.applyWithin(manager, userId, orderNo, reason),
    );
    // §2.6·6：申请受理恰计一次（含 hold 明确失败 ⇒ failed 的行——申请动作发生过、行已留档）。
    paymentRefundTotal.labels('applied').inc();
    await this.refreshRefundGauges();
    return result;
  }

  /** 锁内体（见类头①；`manager` = 与行锁同事务 ⇒ 校验/插入/落账原子）。 */
  private async applyWithin(
    manager: EntityManager,
    userId: string,
    orderNo: string,
    reason: string,
  ): Promise<PayRefundApplyResponse> {
    // ① 该单（本人）：不存在/非本人 ⇒ 15002。
    const orders = (await manager.query(SELECT_ORDER_FOR_REFUND_SQL, [orderNo, userId])) as OrderForRefundRow[];
    const order = orders[0];
    if (!order) {
      throw new DomainError(ErrCode.PAY_ORDER_NOT_FOUND, '订单不存在或已失效');
    }
    // ② 已入账（仅 credited 可退；§3.3）。
    if (order.status !== 'credited') {
      throw new DomainError(ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（未入账）');
    }
    // ③ 槽（⚙️15）：该单在途/已退 ⇒ 15006（message 区分；UK 兜底在 INSERT 处）。
    const active = (await manager.query(SELECT_ORDER_ACTIVE_REFUND_SQL, [orderNo])) as ActiveRefundRow[];
    if (active.length > 0) {
      throw new DomainError(
        ErrCode.PAY_REFUND_UNAVAILABLE,
        active[0]!.status === 'refunded' ? '该笔充值暂不可退（已退过）' : '该笔充值暂不可退（处理中）',
      );
    }
    const coins = toSafeInt(order.coins, 'orders.coins');
    const amountFen = toSafeInt(order.amount_fen, 'orders.amount_fen');
    // ④ cap（§2.2.1：**资金动作时刻**取数，禁缓存；RPC 失败 ⇒ fail-closed 拒 15006）。
    let cap: number;
    try {
      ({ cap } = await this.currency.withdrawable({ ownerId: userId }));
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      this.logger.warn(`cap 取数失败（fail-closed 拒申请）user_id=${userId}: ${cause}`);
      throw new DomainError(ErrCode.PAY_REFUND_UNAVAILABLE, `该笔充值暂不可退（${TRANSPORT_FAILURE_MESSAGE}）`);
    }
    if (coins > cap) {
      throw new DomainError(ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（超出可退额度）');
    }
    // ⑤ 本人无未解析 holding（提现/退款任一；§2.4 跨面占位——T10 常量复用，不复制第二份）。
    const holds = (await manager.query(UNRESOLVED_HOLDING_SQL, [userId, userId])) as unknown[];
    if (holds.length > 0) {
      throw new DomainError(ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（有处理中申请，请稍后重试）');
    }
    // ⑥ INSERT `holding` + `active_slot=1`；`channel_out_request_no = refund_no`（§3.3 逐字）。
    const refundNo = await this.insertHolding(manager, { userId, orderNo, coins, amountFen, reason });
    // ⑦ 冻结（锁内第二发 RPC；锚先于落账——随 apply 请求过线）。首尝试不计 retry（非重放）。
    const outcome = await replayAnchor(
      this.currency,
      'refund_hold',
      fundOpAnchor('refund_hold', refundNo),
      {
        source: 'refund_hold',
        refId: refundNo,
        entries: [{ ownerId: userId, delta: -coins }],
      },
      { countRetry: false },
    );
    if (outcome.kind === 'applied') {
      await manager.query(REFUND_HOLD_TO_PENDING_SQL, [refundNo]);
      return { refundNo, status: 'pending' };
    }
    if (outcome.kind === 'definitive_failure') {
      await manager.query(REFUND_HOLD_TO_FAILED_SQL, [truncateTo255(outcome.message), refundNo]);
      return { refundNo, status: 'failed' };
    }
    // 未知 ⇒ 留 holding（§2.5①：绝不写假终态；循环⑥解析收敛）。
    return { refundNo, status: 'holding' };
  }

  /** 插行（撞 `uk_refund_no` ⇒ 换号重试；撞 `uk_refunds_order_active` ⇒ 15006「处理中」竞态兜底）。 */
  private async insertHolding(
    manager: EntityManager,
    args: { userId: string; orderNo: string; coins: number; amountFen: number; reason: string },
  ): Promise<string> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const refundNo = generateRefundNo();
      try {
        await manager.query(INSERT_REFUND_SQL, [
          refundNo,
          args.orderNo,
          args.userId,
          args.amountFen,
          args.coins,
          args.reason,
          refundNo, // channel_out_request_no = refund_no（§3.3）
        ]);
        return refundNo;
      } catch (err) {
        if (isDuplicateEntryError(err) && errorMentionsKey(err, 'uk_refunds_order_active')) {
          // ⚙️15 幂等槽兜底：同订单至多一笔在途（前序槽预检的毫秒级竞态面）。
          throw new DomainError(ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（处理中）');
        }
        if (isDuplicateEntryError(err) && errorMentionsKey(err, 'uk_refund_no')) {
          lastErr = err; // 单号碰撞（天文级罕见）⇒ 换号重试
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('退款单号生成冲突');
  }

  /* ──────────────────────── 玩家读面：`GET /api/pay/refunds/mine`（T13）──────────────────────── */

  /**
   * `GET /api/pay/refunds/mine`（§2.4.1 #7）：keyset（默认 20、≤50）· **只本人**
   * （`user_id` 是 WHERE 第一条件）。游标 **先于任何查询**校验（非法 ⇒ 10001，不落一次库）；
   * 多取一行判 hasMore（`nextCursor === null` ⇒ 终页）。游标件 = `pay-orders-cursor.ts`
   * 叶子共享（`epochMs:rowId` base64url，同 orders `mine` 口径；禁双实现）。
   */
  async mine(userId: string, query: { cursor?: unknown; limit?: unknown } = {}): Promise<PayRefundsPage> {
    const limit = clampMineLimit(query.limit);
    const cursor = query.cursor === undefined ? null : decodePayOrdersCursor(query.cursor);

    const sql = REFUND_MINE_SELECT_BASE + (cursor ? REFUND_MINE_CURSOR_COND : '') + REFUND_MINE_ORDER_LIMIT;
    const params: unknown[] = [userId];
    if (cursor) params.push(new Date(cursor.createdAtMs), new Date(cursor.createdAtMs), cursor.rowId);
    params.push(limit + 1); // 多取一行：判 hasMore，不入响应

    const rows = (await this.dataSource.query(sql, params)) as RefundMineRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    if (pageRows.length === 0) return { items: [], nextCursor: null };

    const items = pageRows.map(toPayRefundInfo);
    const last = pageRows[pageRows.length - 1]!;
    const nextCursor = hasMore
      ? encodePayOrdersCursor(toEpochMs(last.created_at, 'refunds.created_at'), toSafeInt(last.id, 'refunds.id'))
      : null;
    return { items, nextCursor };
  }

  /* ───────────────────────────── 循环⑥：holding 解析 ─────────────────────────── */

  /**
   * `resolveHolding()`（§3.4⑥ · §3.3）：全部 `holding` 行**同锚重放**（`refund:<no>`）——
   * 成功 ⇒ `pending`（记 `hold_confirmed_at`）；**明确失败** ⇒ `failed`（终态、释槽、
   * `last_error` 摘要）；未知 ⇒ 停留 + 下轮重试（>15m ⇒ 告警）。**永不回滚**（holding 的钱
   * 可能没动，rb 会凭空造钱）。
   *
   * @returns 本轮收敛（条件更新命中）的行数
   */
  async resolveHolding(): Promise<number> {
    const rows = (await this.dataSource.query(SELECT_REFUND_HOLDING_SQL)) as Array<{
      refund_no?: unknown;
      user_id?: unknown;
      coins?: unknown;
    }>;
    let resolved = 0;
    for (const row of rows) {
      const no = String(row.refund_no);
      const outcome = await replayAnchor(this.currency, 'refund_hold', fundOpAnchor('refund_hold', no), {
        source: 'refund_hold',
        refId: no,
        entries: [{ ownerId: String(row.user_id), delta: -toSafeInt(row.coins, 'refunds.coins') }],
      });
      if (outcome.kind === 'applied') {
        const updated = await this.dataSource.query(REFUND_HOLD_TO_PENDING_SQL, [no]);
        if (affectedRowsOf(updated, `退款 ${no} holding→pending`) === 1) resolved += 1;
      } else if (outcome.kind === 'definitive_failure') {
        const updated = await this.dataSource.query(REFUND_HOLD_TO_FAILED_SQL, [
          truncateTo255(outcome.message),
          no,
        ]);
        if (affectedRowsOf(updated, `退款 ${no} holding→failed`) === 1) resolved += 1;
      }
      // unknown ⇒ 停留 holding（不迁任何态、零写）。
    }
    await this.refreshRefundGauges();
    return resolved;
  }

  /* ───────────────────────────── 循环⑦：回滚恢复 ────────────────────────────── */

  /**
   * `rollbackRecovery()`（§3.4⑦ · §3.3）：`rejecting` 行（「已 claim 未落账」集合；见类头
   * 偏离登记）⇒ 重放 `refund_rb:<no>` ⇒ 落账 ⇒ `rejected`（释槽）；非成功 ⇒ 留停留态 +
   * `last_error`（§2.5④，转人工）。
   *
   * @returns 本轮回滚**落账**（达终态）的行数
   */
  async rollbackRecovery(): Promise<number> {
    const rows = (await this.dataSource.query(SELECT_REJECTING_SQL)) as RollbackTargetRow[];
    let rolledBack = 0;
    for (const row of rows) {
      if (await this.applyRollback(row)) rolledBack += 1;
    }
    await this.refreshRefundGauges();
    return rolledBack;
  }

  /** 单行回滚落账（审驳回路径与循环⑦共用）：rb 锚重放 ⇒ 终态或停留（见类头④）。
   *  `countRetry`（§2.6·5 语义：同锚**重放**才计）= 循环⑦传 true（扫描的家谱是重试）；
   *  审驳回的 inline 首尝试传 false（照 T10 applyRollback 同款口径）。 */
  private async applyRollback(row: RollbackTargetRow, opts: { countRetry?: boolean } = {}): Promise<boolean> {
    const no = String(row.refund_no);
    const outcome = await replayAnchor(
      this.currency,
      'refund_rb',
      fundOpAnchor('refund_rb', no),
      {
        source: 'refund_rollback',
        refId: no,
        entries: [{ ownerId: String(row.user_id), delta: toSafeInt(row.coins, 'refunds.coins') }],
      },
      opts,
    );
    if (outcome.kind !== 'applied') {
      // 🔴 回滚例外（§2.5④）：绝不误置终态、不释槽；last_error 留摘要（replayAnchor 已 error 日志）。
      await this.dataSource.query(REFUND_ROLLBACK_LAST_ERROR_SQL, [truncateTo255(outcome.message), no]);
      return false;
    }
    const updated = await this.dataSource.query(REFUND_ROLLBACK_TO_REJECTED_SQL, [no]);
    return affectedRowsOf(updated, `退款 ${no} 回滚落账`) === 1;
  }

  /** 读单行回滚目标（审驳回 claim 成功后的行读；字段集与循环⑦候选同形 + 渠道素材）。 */
  private async loadRefundTarget(refundNo: string): Promise<RefundTargetRow> {
    const rows = (await this.dataSource.query(SELECT_REFUND_TARGET_SQL, [refundNo])) as RefundTargetRow[];
    const row = rows[0];
    if (!row) {
      throw new Error(`退款 ${refundNo} claim 后读不到行（不变量破坏）`);
    }
    return row;
  }

  /* ─────────────────── 循环⑧：未知结果低频重放（v1.1.4 §3.3）─────────────────── */

  /**
   * `replayUnknown()`（**v1.1.4 新增**）：`status='approved' AND last_error LIKE 'unknown:%'`
   * 且 `reviewed_at` 在 **72h** 内的行 ⇒ 同 `out_request_no` 重放（**每扫描周期 1 发**，幂等）；
   * 逐行处置：
   *  - 渠道成功 ⇒ CAS `approved→refunded`（+`channel_refund_no`/`refunded_at`）；
   *  - 明确失败（业务响应/本地配置缺失）⇒ **替换** `last_error`（去前缀）**停自动**（人工面）；
   *  - 仍未知 ⇒ 刷新标记（缀时刻；下一周期再试；>72h 自然出候选 ⇒ 纯人工）。
   *
   * @returns 本轮重放**收敛**（达 `refunded`）的行数
   */
  async replayUnknown(): Promise<number> {
    const rows = (await this.dataSource.query(SELECT_APPROVED_UNKNOWN_SQL)) as RefundReplayRow[];
    let converged = 0;
    for (const row of rows) {
      const no = String(row.refund_no);
      const shot = await this.sendRefund(no, this.refundRequestOf(row));
      if (shot.done) {
        if (shot.status === 'refunded') {
          converged += 1;
          this.logger.log(`退款 ${no} 扫描重放成功 ⇒ refunded（未知结果收敛）`);
        } else {
          // CAS 失手（渠道已成、行被他方处置）：sendRefund 已留对账线索 + error 日志。
          this.logger.warn(`退款 ${no} 扫描重放发现行已被处置为 ${shot.status}——按 CAS 失手处置`);
        }
        continue;
      }
      if (classifyChannelFailure(shot.failure) === 'definite') {
        await this.dataSource.query(REFUND_CHANNEL_LAST_ERROR_SQL, [
          truncateTo255(shot.failure.lastError),
          no,
        ]);
        this.logger.warn(
          `退款 ${no} 扫描重放得**明确失败**（${shot.failure.channelCode ?? '本地配置缺失'}）⇒ 去 unknown: 标记、停自动转人工：${shot.failure.lastError}`,
        );
      } else {
        await this.dataSource.query(REFUND_CHANNEL_LAST_ERROR_SQL, [
          truncateTo255(`${REFUND_UNKNOWN_MARKER} [${new Date().toISOString()}] ${shot.failure.lastError}`),
          no,
        ]);
        this.logger.log(`退款 ${no} 扫描重放仍未知 ⇒ 刷新 unknown: 标记（下一扫描周期再试）：${shot.failure.lastError}`);
      }
    }
    await this.refreshRefundGauges();
    return converged;
  }

  /* ───────────── 渠道单发（inline 退避循环与扫描重放共用；成功 CAS 单点）───────────── */

  /** 渠道调用素材（inline `refundAtChannel` 与循环⑧同源——`channel_out_request_no` 是幂等键）。 */
  private refundRequestOf(target: RefundReplayRow | RefundTargetRow): RefundRequest {
    return {
      outTradeNo: String(target.order_no),
      refundAmount: fen2yuan(toSafeInt(target.amount_fen, 'refunds.amount_fen')), // ⚙️5：整数分 ⇒ 元字符串
      outRequestNo: String(target.channel_out_request_no),
      reason: String(target.reason),
    };
  }

  /**
   * 渠道退款**单发** + 成功落账 CAS（两调用方共用）：成功 ⇒ CAS `approved→refunded`
   * （affected=1 ⇒ `refunded`；**CAS 失手**见类头——不误置任何态、渠道单号写 `last_error`
   * 作对账线索 + error 日志，返回**实际态**）；渠道失败 ⇒ 原样返回 `ChannelFailure`
   * （分类归调用方：inline 记末发摘要、循环⑧按 v1.1.4 落标记）。
   */
  private async sendRefund(
    no: string,
    request: RefundRequest,
  ): Promise<{ done: true; status: PayRefundStatus } | { done: false; failure: ChannelFailure }> {
    const res = await this.channel.refund(request);
    if (!res.ok) return { done: false, failure: res };
    const updated = await this.dataSource.query(REFUND_TO_REFUNDED_SQL, [res.data.tradeNo, no]);
    if (affectedRowsOf(updated, `退款 ${no} approved→refunded`) === 1) {
      return { done: true, status: 'refunded' };
    }
    // CAS 失手：渠道退款已成为事实，但本地行已被他方处置（见类头「CAS 失手」）。
    const current = await this.readStatus(no);
    if (current === 'refunded') return { done: true, status: 'refunded' }; // 幂等重放面（他方已落同一事实）
    const note = truncateTo255(
      `渠道退款已成功（channel_refund_no=${res.data.tradeNo ?? 'null'}）但本地行已被处置为 ${current}——需人工对账`,
    );
    await this.dataSource.query(REFUND_ROLLBACK_LAST_ERROR_SQL, [note, no]);
    this.logger.error(`🔴 退款 ${no} CAS 失手：${note}`);
    return { done: true, status: current };
  }

  /* ─────────────────────────────── 管理写面 ─────────────────────────────────── */

  /**
   * `POST /api/admin/pay/refunds/:refundNo/review`（§2.4.2 #4）：
   *  - approve：claim `pending→approved`（记审者/时刻/附言）⇒ **同步渠道退款**（就地退避重试，
   *    见类头；成功 ⇒ `refunded`；穷尽/失败 ⇒ 停留 `approved` + `last_error` + `channel_fail`）；
   *  - reject：claim `pending|approved→rejecting` ⇒ rb 落账 ⇒ `rejected`（rb 非成功 ⇒ 停留
   *    `rejecting`，响应返回**实际态**）。
   * 非法源态/不存在 ⇒ 15009（message 含当前态与合法动作；管理员 actor 由网关注入）。
   */
  async review(
    admin: string,
    refundNo: string,
    request: { action?: unknown; note?: unknown } | undefined,
  ): Promise<AdminPayRefundReviewResponse> {
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
      const updated = await this.dataSource.query(REFUND_APPROVE_SQL, [admin, note, refundNo]);
      if (affectedRowsOf(updated, `退款 ${refundNo} 审通过`) !== 1) {
        throw await this.stateConflict(refundNo, 'approve');
      }
      paymentRefundTotal.labels('approved').inc();
      const status = await this.refundAtChannel(await this.loadRefundTarget(refundNo));
      await this.refreshRefundGauges();
      return { refundNo, status };
    }

    // reject：claim 先行（与 approve 的渠道进行面互斥——后到者 affected=0）⇒ rb 落账 ⇒ 读实际态。
    const claimed = await this.dataSource.query(REFUND_REJECT_CLAIM_SQL, [admin, note, refundNo]);
    if (affectedRowsOf(claimed, `退款 ${refundNo} 审驳回 claim`) !== 1) {
      throw await this.stateConflict(refundNo, 'reject');
    }
    paymentRefundTotal.labels('rejected').inc();
    await this.applyRollback(await this.loadRefundTarget(refundNo), { countRetry: false });
    const status = await this.readStatus(refundNo);
    await this.refreshRefundGauges();
    return { refundNo, status };
  }

  /**
   * 渠道退款（设计 §2.5 退避表）：初始 1 发 + 退避重试 5 发（1s→5s→30s→2m→10m）。
   * 成功 ⇒ CAS `approved→refunded`（§CAS 失手见类头）；穷尽 ⇒ 停：留 `approved` +
   * `last_error`（**按最终失败类别落标记**——未知 ⇒ `unknown:` 前缀转扫描低频重放；
   * 明确 ⇒ 直接留长文案）+ `channel_fail` 计数。
   *
   * @returns 处置后的**实际态**（`refunded` / `approved` / CAS 失手时的他方终态）
   */
  private async refundAtChannel(target: RefundTargetRow): Promise<PayRefundStatus> {
    const no = String(target.refund_no);
    const request = this.refundRequestOf(target);

    let lastError = '';
    let lastClass: ChannelFailureClass = 'unknown';
    for (let attempt = 0; attempt <= REFUND_RETRY_BACKOFF_MS.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(REFUND_RETRY_BACKOFF_MS[attempt - 1]!);
        // 每发前复核 claim：退避间隙里行可能已被驳回（approved→rejecting/rejected）——停发。
        const current = await this.readStatus(no);
        if (current !== 'approved') {
          this.logger.warn(`退款 ${no} 退避间隙中被处置（现状 ${current}）⇒ 停发渠道重试（不再发第 ${attempt + 1} 发）`);
          return current;
        }
      }

      const shot = await this.sendRefund(no, request);
      if (shot.done) return shot.status;
      lastError = shot.failure.lastError;
      lastClass = classifyChannelFailure(shot.failure);
      this.logger.warn(
        `退款 ${no} 渠道第 ${attempt + 1} 发失败（${shot.failure.channelCode ?? '无响应码'}；类别=${lastClass}）：${shot.failure.lastError}`,
      );
    }

    // 上限后停：留 approved + last_error + 计数（人工面；槽不释放——钱已冻结）。
    // 🔴 标记语义（v1.1.4 §3.3）：**未知**打 `unknown:` 前缀（转扫描低频重放收敛）；
    // **明确**（业务响应/本地配置缺失）不标记（不重放——重放也无新信息，留人工面）。
    const marked = lastClass === 'unknown' ? `${REFUND_UNKNOWN_MARKER} ${lastError}` : lastError;
    await this.dataSource.query(REFUND_CHANNEL_LAST_ERROR_SQL, [truncateTo255(marked), no]);
    paymentRefundTotal.labels('channel_fail').inc();
    this.logger.error(
      `退款 ${no} 渠道退避表穷尽（${REFUND_RETRY_BACKOFF_MS.length + 1} 发）仍无成功回执（最终失败类别=${lastClass}）` +
        `⇒ 留 approved ${lastClass === 'unknown' ? '（unknown: 标记，转扫描低频重放）' : '（转人工，不重放）'}：${lastError}`,
    );
    return this.readStatus(no);
  }

  /* ─────────────────────────────── 指标与内部 ────────────────────────────────── */

  /**
   * `payment_fundop_pending/_oldest_age_seconds{op=refund_hold|refund_rb}`（§2.6·3/4；
   * T9 交接：④⑤ 循环已写 withdraw 两 op，本服务补 refund 两 op）。写点 = apply/review 之后与
   * ⑥⑦ 循环末（照 T10 `refreshWithdrawGauges` 同款节奏；refund 无专属 `*_pending` gauge——
   * §2.6 十条恰数清单不含 `payment_refund_pending`）。
   */
  async refreshRefundGauges(): Promise<void> {
    const fundop = (await this.dataSource.query(REFUND_FUNDOP_STATS_SQL)) as Array<{
      op?: unknown;
      cnt?: unknown;
      oldest?: unknown;
    }>;
    for (const row of fundop) {
      const op = String(row.op);
      if (op !== 'refund_hold' && op !== 'refund_rb') continue;
      const cnt = Number(row.cnt ?? 0);
      const oldest = Number(row.oldest ?? 0);
      paymentFundopPending.labels(op).set(Number.isFinite(cnt) ? cnt : 0);
      paymentFundopOldestAgeSeconds.labels(op).set(Number.isFinite(oldest) ? oldest : 0);
    }
  }

  /** 读现状（15009 message 的「当前态」素材 + 退避复核；行不存在 ⇒ 抛，不变量破坏）。 */
  private async readStatus(refundNo: string): Promise<PayRefundStatus> {
    const rows = (await this.dataSource.query(SELECT_REFUND_STATUS_SQL, [refundNo])) as Array<{
      status?: unknown;
    }>;
    const status = rows[0]?.status;
    if (typeof status !== 'string') {
      throw new Error(`退款 ${refundNo} 读不到状态（不变量破坏）`);
    }
    return status as PayRefundStatus;
  }

  /** 15009（⚙️9）：message 含当前态与合法动作；行不存在 ⇒ 明说。 */
  private async stateConflict(refundNo: string, action: 'approve' | 'reject'): Promise<DomainError> {
    const rows = (await this.dataSource.query(SELECT_REFUND_STATUS_SQL, [refundNo])) as Array<{
      status?: unknown;
    }>;
    const current = typeof rows[0]?.status === 'string' ? String(rows[0]!.status) : null;
    const hints: Record<typeof action, string> = {
      approve: '仅 pending 可 approve',
      reject: '仅 pending/approved 可 reject',
    };
    const message =
      current === null
        ? `退款单 ${refundNo} 不存在（无法 ${action}）`
        : `状态已变更：当前状态 ${current}，${hints[action]}`;
    return new DomainError(ErrCode.PAY_STATE_CONFLICT, message);
  }
}

/* ──────────────────────────── SQL 常量（全文钉）────────────────────────────── */
/* ⚠️ 全部裸 SQL（不用 entity；int、datetime(3)）；时间判定一律 DB `NOW(3)`（单点权威）。 */

/** 该单（本人）读（申请第一检；列序 = 夹具/测试钉的形状）。参数 `[orderNo, userId]`。 */
export const SELECT_ORDER_FOR_REFUND_SQL =
  'SELECT `coins`, `amount_fen`, `status` FROM `payment_orders` WHERE `order_no` = ? AND `user_id` = ?';

/** 槽预检（该单在途/已退行；⚙️15）。参数 `[orderNo]`。 */
export const SELECT_ORDER_ACTIVE_REFUND_SQL =
  'SELECT `refund_no`, `status` FROM `payment_refunds` WHERE `order_no` = ? AND `active_slot` = 1';

/** 申请插行（`holding` + `active_slot=1`；末列 `channel_out_request_no` = refund_no——参数尾同值）。参数 `[no, orderNo, userId, amountFen, coins, reason, no]`。 */
export const INSERT_REFUND_SQL =
  'INSERT INTO `payment_refunds` (`refund_no`, `order_no`, `user_id`, `amount_fen`, `coins`, `reason`, `channel_out_request_no`, `active_slot`) VALUES (?, ?, ?, ?, ?, ?, ?, 1)';

/** 解析成功落账（holding→pending；记 `hold_confirmed_at`）。参数 `[no]`。 */
export const REFUND_HOLD_TO_PENDING_SQL =
  "UPDATE `payment_refunds` SET `status`='pending', `hold_confirmed_at`=NOW(3) WHERE `refund_no`=? AND `status`='holding'";

/** 解析明确失败（holding→failed；**终态释槽** + `last_error` 摘要）。参数 `[lastError, no]`。 */
export const REFUND_HOLD_TO_FAILED_SQL =
  "UPDATE `payment_refunds` SET `status`='failed', `active_slot`=NULL, `last_error`=? WHERE `refund_no`=? AND `status`='holding'";

/** 审通过 claim（pending→approved；记审者/时刻/附言）。参数 `[admin, note, no]`。 */
export const REFUND_APPROVE_SQL =
  "UPDATE `payment_refunds` SET `status`='approved', `reviewed_by`=?, `reviewed_at`=NOW(3), `review_note`=? WHERE `refund_no`=? AND `status`='pending'";

/** 审驳回 claim（pending|approved→rejecting；记审者/时刻/附言）。参数 `[admin, note, no]`。 */
export const REFUND_REJECT_CLAIM_SQL =
  "UPDATE `payment_refunds` SET `status`='rejecting', `reviewed_by`=?, `reviewed_at`=NOW(3), `review_note`=? WHERE `refund_no`=? AND `status` IN ('pending','approved')";

/** 渠道成功落账（approved→refunded；`channel_refund_no`/`refunded_at`；**保留槽**——不写 `active_slot`）。参数 `[channelRefundNo, no]`。 */
export const REFUND_TO_REFUNDED_SQL =
  "UPDATE `payment_refunds` SET `status`='refunded', `channel_refund_no`=?, `refunded_at`=NOW(3) WHERE `refund_no`=? AND `status`='approved'";

/** 渠道停（退避穷尽）的 `last_error` 摘要（approved 守卫 = 只写仍持 claim 的行）。参数 `[message, no]`。 */
export const REFUND_CHANNEL_LAST_ERROR_SQL =
  "UPDATE `payment_refunds` SET `last_error`=? WHERE `refund_no`=? AND `status`='approved'";

/** 回滚落账终态（rejecting→rejected；释槽）。参数 `[no]`。 */
export const REFUND_ROLLBACK_TO_REJECTED_SQL =
  "UPDATE `payment_refunds` SET `status`='rejected', `active_slot`=NULL WHERE `refund_no`=? AND `status`='rejecting'";

/** 回滚非成功 / CAS 失手的 `last_error` 摘要（§2.3 写点：refunds=渠道退款失败摘要；无守卫——两路共用）。参数 `[message, no]`。 */
export const REFUND_ROLLBACK_LAST_ERROR_SQL = 'UPDATE `payment_refunds` SET `last_error`=? WHERE `refund_no`=?';

/** 循环⑥候选（全部 `holding`；先老后新）。 */
export const SELECT_REFUND_HOLDING_SQL =
  "SELECT `refund_no`, `user_id`, `coins` FROM `payment_refunds` WHERE `status` = 'holding' ORDER BY `created_at` ASC, `id` ASC";

/** 循环⑦候选（`rejecting` = 「已 claim 未落账」集合；见类头偏离登记）。 */
export const SELECT_REJECTING_SQL =
  "SELECT `refund_no`, `user_id`, `coins` FROM `payment_refunds` WHERE `status` = 'rejecting' ORDER BY `created_at` ASC, `id` ASC";

/**
 * 循环⑧候选（v1.1.4 §3.3 未知结果收敛）：`approved` + `unknown:` 标记 + `reviewed_at` 72h 窗内；
 * 先老后新。>72h 的行**不再入候选**（停自动、保留标记转纯人工）。`reviewed_at` NULL 行被
 * 三值逻辑自然排除（approved 行恒有它，双保险）。
 */
export const SELECT_APPROVED_UNKNOWN_SQL =
  "SELECT `refund_no`, `order_no`, `amount_fen`, `reason`, `channel_out_request_no` FROM `payment_refunds` WHERE `status` = 'approved' AND `last_error` LIKE 'unknown:%' AND `reviewed_at` > NOW(3) - INTERVAL 72 HOUR ORDER BY `created_at` ASC, `id` ASC";

/** 单行读（渠道调用素材；审驳回回滚目标同用）。参数 `[no]`。 */
export const SELECT_REFUND_TARGET_SQL =
  'SELECT `refund_no`, `order_no`, `user_id`, `coins`, `amount_fen`, `reason`, `channel_out_request_no` FROM `payment_refunds` WHERE `refund_no` = ?';

/** 现状读（15009 message 素材 + 退避复核）。参数 `[no]`。 */
export const SELECT_REFUND_STATUS_SQL =
  'SELECT `status` FROM `payment_refunds` WHERE `refund_no` = ?';

/* ── T13：`GET /api/pay/refunds/mine` 的 keyset 读（静态段；投影 = `PayRefundInfo`）── */

/**
 * `mine` 读列（**列序 = protocol `PayRefundInfo` 素材**；`id` 前置 = keyset 内部列，
 * **必须真投影**——波 4 阻断-1 教训：缺列会让游标静默签出坏值，读取侧严格读，禁 `?? 0`）。
 * 参数 `[userId]`。
 */
export const REFUND_MINE_SELECT_BASE =
  'SELECT `id`, `refund_no`, `order_no`, `coins`, `amount_fen`, `status`, `reason`, `review_note`, `reviewed_at`, `refunded_at`, `created_at` FROM `payment_refunds` WHERE `user_id` = ?';

/** keyset 游标条件（`(created_at, id)` 严格降序；同 orders `mine` 先例）。参数 `[Date, Date, rowId]`。 */
export const REFUND_MINE_CURSOR_COND = ' AND (`created_at` < ? OR (`created_at` = ? AND `id` < ?))';

/** 排序 + 限行（多取一行判 hasMore）。参数 `[limit+1]`。 */
export const REFUND_MINE_ORDER_LIMIT = ' ORDER BY `created_at` DESC, `id` DESC LIMIT ?';

/** `payment_fundop_pending/_oldest_age_seconds{op}` 统计读（refund 两 op 标签；UNION ALL 恒两行，缺面为 0）。 */
export const REFUND_FUNDOP_STATS_SQL =
  "SELECT 'refund_hold' AS `op`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_refunds` WHERE `status` = 'holding' UNION ALL SELECT 'refund_rb' AS `op`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_refunds` WHERE `status` = 'rejecting'";

/**
 * `trade.refund` 出站退避表（设计 §2.5 逐字：1s → 5s → 30s → 2m → 10m）。
 * 语义 = **初始 1 发 + 本表 5 发重试 = 上限 6 发**；穷尽 ⇒ 停（留 `approved` + `last_error` +
 * `channel_fail` 计数）。等待 = 纯 `setTimeout`（`sleep`）⇒ fake timers 可测。
 */
export const REFUND_RETRY_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000, 600_000];

/**
 * 「渠道结果未知」的 `last_error` 标记前缀（v1.1.4 §3.3 逐字；循环⑧候选谓词 `LIKE 'unknown:%'`
 * 与它同源一处）。语义：渠道调用**没拿到可信业务响应**（传输级——超时/连接被拒/discard/验签
 * 失败）⇒ 结果未定 ⇒ 扫描低频重放收敛；**明确**失败（业务响应/本地配置缺失）不带此前缀。
 */
export const REFUND_UNKNOWN_MARKER = 'unknown:';

/** 渠道失败分类（v1.1.4 §3.3）：未知（无可信业务响应）/ 明确（业务响应或本地配置缺失）。 */
export type ChannelFailureClass = 'unknown' | 'definite';

/**
 * `ChannelFailure` ⇒ 类别（依 T6 材质面）：
 *  - `channelCode/channelSubCode` 在场 ⇒ **明确**（渠道有业务响应，含业务拒——支付宝 `code`/
 *    `sub_code` 是可判读的拒绝材料）；
 *  - 无渠道码且 `lastError === CHANNEL_CONFIG_ERROR` ⇒ **明确**（本地配置缺失——请求未出站、
 *    渠道零副作用，重放无意义；T6 固定摘要常量，逐字比较）；
 *  - 其余（传输抛错/验签失败/响应形状非法——没拿到可信结果）⇒ **未知**（渠道可能已执行，
 *    同 `out_request_no` 重放幂等安全）。
 */
export function classifyChannelFailure(res: ChannelFailure): ChannelFailureClass {
  if (res.channelCode !== null || res.channelSubCode !== null) return 'definite';
  if (res.lastError === CHANNEL_CONFIG_ERROR) return 'definite';
  return 'unknown';
}

/* ────────────────────────────── 工具与形状 ─────────────────────────────────── */

/** 该单读的行形态（列名即 SQL 别名）。 */
interface OrderForRefundRow {
  coins?: unknown;
  amount_fen?: unknown;
  status?: unknown;
}

/** 槽预检行形态。 */
interface ActiveRefundRow {
  refund_no?: unknown;
  status?: unknown;
}

/** 回滚目标行（循环⑦与单行读同形面）。 */
interface RollbackTargetRow {
  refund_no?: unknown;
  user_id?: unknown;
  coins?: unknown;
}

/** 渠道调用素材行（单行读全列）。 */
interface RefundTargetRow extends RollbackTargetRow {
  order_no?: unknown;
  amount_fen?: unknown;
  reason?: unknown;
  channel_out_request_no?: unknown;
}

/** 循环⑧候选行（v1.1.4；`refundRequestOf` 消费的最小素材面——与 RefundTargetRow 同形子集）。 */
interface RefundReplayRow {
  refund_no?: unknown;
  order_no?: unknown;
  amount_fen?: unknown;
  reason?: unknown;
  channel_out_request_no?: unknown;
}

/** `mine` 读出的行（列名即 SQL 别名；`datetime(3)` 归一在这一层）。 */
interface RefundMineRow {
  id: unknown;
  refund_no: unknown;
  order_no: unknown;
  coins: unknown;
  amount_fen: unknown;
  status: unknown;
  reason: unknown;
  review_note: unknown;
  reviewed_at: unknown;
  refunded_at: unknown;
  created_at: unknown;
}

/** 状态机全值集（protocol `PayRefundStatus` 逐字；非状态机值 ⇒ 响亮抛）。 */
const REFUND_STATUSES: readonly PayRefundStatus[] = [
  'holding',
  'pending',
  'approved',
  'rejecting',
  'rejected',
  'refunded',
  'failed',
];

function asRefundStatus(value: unknown): PayRefundStatus {
  if (REFUND_STATUSES.includes(value as PayRefundStatus)) return value as PayRefundStatus;
  // 不在状态机里的值不是合法状态（protocol/payment.ts 的联合类型注释）——响亮拒绝。
  throw new Error(`payment_refunds.status 非状态机值：${JSON.stringify(value)}`);
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

/** 行 ⇒ REST 投影（protocol `PayRefundInfo` 十键逐字；`amountYuan` 为字符串——⚙️5 禁浮点）。 */
function toPayRefundInfo(row: RefundMineRow): PayRefundInfo {
  return {
    refundNo: String(row.refund_no),
    orderNo: String(row.order_no),
    coins: toSafeInt(row.coins, 'refunds.coins'),
    amountYuan: fen2yuan(toSafeInt(row.amount_fen, 'refunds.amount_fen')),
    status: asRefundStatus(row.status),
    reason: String(row.reason),
    reviewNote: row.review_note === null || row.review_note === undefined ? null : String(row.review_note),
    reviewedAt: toEpochMsOrNull(row.reviewed_at, 'refunds.reviewed_at'),
    refundedAt: toEpochMsOrNull(row.refunded_at, 'refunds.refunded_at'),
    createdAt: toEpochMs(row.created_at, 'refunds.created_at'),
  };
}

/** 出站退避等待（纯 `setTimeout` ⇒ vitest fake timers 可驱动）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ⚙️4：单号随机段（base36 6 位；`randomInt` 无模偏差）。 */
function randomBase36(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += randomInt(36).toString(36);
  return out;
}

/** ⚙️4：`rf_` + base36(毫秒) + 6 位随机 base36（字符集 `[0-9a-z_]`、长 ≤ 32）。 */
export function generateRefundNo(nowMs: number = Date.now()): string {
  return `${REFUND_PREFIX}${nowMs.toString(36)}${randomBase36(6)}`;
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

/** 条件 UPDATE 的 `affectedRows` 判读（照 withdraw/orders 收紧口径：非整数 ⇒ 抛）。 */
function affectedRowsOf(result: unknown, context: string): number {
  const affected = (result as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof affected !== 'number' || !Number.isInteger(affected) || affected < 0) {
    throw new Error(`${context}：驱动未返回 affectedRows（收到 ${JSON.stringify(result)}）—— 拒绝继续`);
  }
  return affected;
}

/** `last_error` 列宽 255 的截断（写点清单：渠道失败/回滚失败/CAS 对账摘要）。 */
function truncateTo255(value: string): string {
  return value.length <= 255 ? value : value.slice(0, 255);
}

/** 管理操作者防线（网关 `x-admin-actor` 注入；写面绝无回退值）。 */
function requireActor(admin: unknown): asserts admin is string {
  if (typeof admin !== 'string' || admin.length === 0) {
    throw new DomainError(ErrCode.BAD_PARAM, '管理操作者缺失（x-admin-actor）');
  }
}

/** 审核附言（可选 ≤255 列宽；非法形态当场拒，不静默截断）。 */
function normalizeNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string' || note.length > 255) {
    throw new DomainError(ErrCode.BAD_PARAM, 'note 必须是不超过 255 字符的字符串');
  }
  return note;
}

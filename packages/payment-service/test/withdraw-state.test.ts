/**
 * 支付片 T10：**提现链套件**（任务卡 Test: `withdraw-state.test.ts`；
 * 规格 §3.2 提现状态机逐字 · §3.4④⑤ · §2.2.1 cap 纪律 · ⚙️15 幂等槽 · §2.6 指标写点 · §2.4.1 #8；
 * 设计 §5.2 申请（锁内三段）· §5.3 状态机与超时回滚 · §2.5 统一恢复模型）。
 *
 * 覆盖面（十六块）：
 *  ① 全部 SQL 常量**全文钉**（申请/解析/claim/回滚/扫描/统计；一个字符漂移即红）；
 *  ② ⚙️4 单号形状（`wd_` + base36(ms) + 6 随机）；
 *  ③ apply 正例全链：锁内三段（语句序）· RPC 锚/来源/entries 逐字 · 响应 `pending` ·
 *     `amount_fen` 快照（floor）；
 *  ④ 校验清单逐字负例：开关 15003 · 门槛 15003（含非整数/字符串/缺省）· 单笔 15004 ·
 *     日限 15004 · cap 不足 15005 · 未解析 `holding` 占位 15003（提现/退款任一）·
 *     在途槽 UK 15003「已有在途申请」；
 *  ⑤ cap RPC **fail-closed 专测**（超时/坏回执 ⇒ 15003「服务暂时不可用」变体；零行落库）；
 *  ⑥ `resolveHolding` 三态（成功⇒pending / 明确失败⇒failed+释槽 / 未知⇒停留 holding）——
 *     **永不回滚**（零 `withdraw_rb` 调用）；
 *  ⑦ claim 互斥（confirm vs 超时扫描两序恰一胜；reject vs confirm 两序恰一胜）+ 非法源态
 *     15009（message 含当前态与合法动作）；
 *  ⑧ 槽语义（终态四路全部释放：paid/rejected/timeout_rolled_back/failed；在途唯一；并发恰一）；
 *  ⑨ 日限归日口径（+08:00 自然日边界；计入五态/不计三态；**归 `created_at` 列**）；
 *  ⑩ 超时回滚（claim→rb→timeout_rolled_back；rb 未知⇒停留 rolling_back+last_error⇒下轮收敛；
 *     未到期不动）；
 *  ⑪ 驳回回滚（reject⇒rejected；rb 明确失败/未知⇒停留 rolling_back+last_error，响应实际态）；
 *  ⑫ `confirmPaid`（voucher/note 逐字 + claim 条件 + 参数校验负例）；
 *  ⑬ 开关只挡新建（关闸后在途照常可审/可确认可回滚）；
 *  ⑭ 指标写点（`payment_withdraw_pending{state}` / `_oldest_age_seconds{state}` +
 *     `payment_fundop_pending{op=withdraw_hold|withdraw_rb}` 同刷）；
 *  ⑮ 五个新 getter 真快照驱动（27/30/31/32/34；缺省照种子）；
 *  ⑯ 模块注册面 + 控制器真 HTTP（POST 200 / 401 / 409 映射；不用 fetch——假红族⑤纪律）。
 *
 * 夹具：**假 DataSource**（精确形状识别 + 锁等待链；SQL 一漂移就当场红）· 假 currency 客户端
 * （`apply` 可编程回执 + `withdrawable` 可编程失败）· 假 ConfigCache。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequestRaw } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
// ⚠️ **值导入**：`DataSource` 同时是 DI token（探针模块的 provide）——`import type` 会在运行期 undefined。
import { DataSource, type EntityManager } from 'typeorm';
import {
  ErrCode,
  WITHDRAW_PREFIX,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type CurrencyWithdrawableGetResponse,
} from '@fight-the-landlord/protocol';
import type { PayWithdrawApplyResponse } from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import {
  COIN_PER_YUAN_DEFAULT,
  ConfigCacheService,
  WITHDRAW_DAILY_MAX_COINS_DEFAULT,
  WITHDRAW_ENABLED_DEFAULT,
  WITHDRAW_MAX_COINS_PER_ORDER_DEFAULT,
  WITHDRAW_MIN_COINS_DEFAULT,
  WITHDRAW_TIMEOUT_MINUTES_DEFAULT,
} from '../src/config/config-cache.service';
import type { ConfigClient } from '../src/config/config.client';
import { DomainError, HTTP_STATUS } from '../src/http/errors';
import { LOCK_INSERT_IGNORE_SQL, LOCK_SELECT_FOR_UPDATE_SQL, UserLockService } from '../src/locks/user-lock.service';
import {
  paymentFundopOldestAgeSeconds,
  paymentFundopPending,
  paymentFundopRetryTotal,
  paymentWithdrawOldestAgeSeconds,
  paymentWithdrawPending,
} from '../src/metrics/payment.metrics';
import { CurrencyRpcClient, CurrencyServiceError } from '../src/rpc/currency.client';
import {
  INSERT_WITHDRAWAL_SQL,
  SELECT_HOLDING_SQL,
  SELECT_ROLLBACK_TARGET_SQL,
  SELECT_ROLLING_BACK_SQL,
  SELECT_WITHDRAW_STATUS_SQL,
  UNRESOLVED_HOLDING_SQL,
  WITHDRAW_APPROVE_SQL,
  WITHDRAW_CONFIRM_PAID_SQL,
  WITHDRAW_DAY_TOTAL_SQL,
  WITHDRAW_FUNDOP_STATS_SQL,
  WITHDRAW_HOLD_TO_FAILED_SQL,
  WITHDRAW_HOLD_TO_PENDING_SQL,
  WITHDRAW_REJECT_CLAIM_SQL,
  WITHDRAW_ROLLBACK_LAST_ERROR_SQL,
  WITHDRAW_ROLLBACK_TO_REJECTED_SQL,
  WITHDRAW_ROLLBACK_TO_TIMEOUT_SQL,
  WITHDRAW_STATS_SQL,
  WITHDRAW_TIMEOUT_CLAIM_SQL,
  WithdrawService,
  generateWithdrawNo,
} from '../src/withdraw/withdraw.service';
import { WithdrawController } from '../src/withdraw/withdraw.controller';
import { REDIS } from '../src/redis/redis.module';

const USER = 'user-t10-0001';
const OTHER_USER = 'user-t10-0002';
const ADMIN = 'admin-finance-01';

/* ======================================================================== *
 * ① SQL 常量全文钉（规格 §3.2/§3.4/§2.2.1/⚙️15 逐字）
 * ======================================================================== */
describe('① SQL 常量全文钉（规格 §3.2 状态机逐字；单测钉全字符）', () => {
  it('日限合计：五态计入 / 归 created_at 列 / +08:00 自然日（CONVERT_TZ 先例）', () => {
    expect(WITHDRAW_DAY_TOTAL_SQL).toBe(
      "SELECT COALESCE(SUM(`coins`), 0) AS `total` FROM `payment_withdrawals` WHERE `user_id` = ? AND `status` IN ('holding','pending','approved','paid','rolling_back') AND CONVERT_TZ(`created_at`, '+00:00', '+08:00') >= DATE(CONVERT_TZ(NOW(3), '+00:00', '+08:00')) AND CONVERT_TZ(`created_at`, '+00:00', '+08:00') < DATE(CONVERT_TZ(NOW(3), '+00:00', '+08:00')) + INTERVAL 1 DAY",
    );
  });

  it('未解析 holding 占位（提现/退款任一；LIMIT 1 判存在）', () => {
    expect(UNRESOLVED_HOLDING_SQL).toBe(
      "SELECT `withdraw_no` AS `no` FROM `payment_withdrawals` WHERE `user_id` = ? AND `status` = 'holding' UNION ALL SELECT `refund_no` AS `no` FROM `payment_refunds` WHERE `user_id` = ? AND `status` = 'holding' LIMIT 1",
    );
  });

  it('申请插行：holding + active_slot=1；timeout_at = NOW(3) + INTERVAL ? MINUTE（DB 时钟权威）', () => {
    expect(INSERT_WITHDRAWAL_SQL).toBe(
      'INSERT INTO `payment_withdrawals` (`withdraw_no`, `user_id`, `coins`, `amount_fen`, `timeout_at`, `active_slot`) VALUES (?, ?, ?, ?, NOW(3) + INTERVAL ? MINUTE, 1)',
    );
  });

  it('解析落账：holding→pending（记 hold_confirmed_at）/ holding→failed（释槽 + last_error）', () => {
    expect(WITHDRAW_HOLD_TO_PENDING_SQL).toBe(
      "UPDATE `payment_withdrawals` SET `status`='pending', `hold_confirmed_at`=NOW(3) WHERE `withdraw_no`=? AND `status`='holding'",
    );
    expect(WITHDRAW_HOLD_TO_FAILED_SQL).toBe(
      "UPDATE `payment_withdrawals` SET `status`='failed', `active_slot`=NULL, `last_error`=? WHERE `withdraw_no`=? AND `status`='holding'",
    );
  });

  it('审通过 claim（pending→approved，记审者）；审驳回 claim（pending|approved→rolling_back），reason=rejected', () => {
    expect(WITHDRAW_APPROVE_SQL).toBe(
      "UPDATE `payment_withdrawals` SET `status`='approved', `reviewed_by`=?, `reviewed_at`=NOW(3), `review_note`=? WHERE `withdraw_no`=? AND `status`='pending'",
    );
    expect(WITHDRAW_REJECT_CLAIM_SQL).toBe(
      "UPDATE `payment_withdrawals` SET `status`='rolling_back', `rollback_reason`='rejected', `reviewed_by`=?, `reviewed_at`=NOW(3), `review_note`=? WHERE `withdraw_no`=? AND `status` IN ('pending','approved')",
    );
  });

  it('确认打款 claim（approved→paid；voucher/note；**终态释槽**）', () => {
    expect(WITHDRAW_CONFIRM_PAID_SQL).toBe(
      "UPDATE `payment_withdrawals` SET `status`='paid', `confirmed_by`=?, `confirmed_at`=NOW(3), `voucher`=?, `confirm_note`=?, `active_slot`=NULL WHERE `withdraw_no`=? AND `status`='approved'",
    );
  });

  it('超时 claim（批量：pending|approved 且 timeout_at < NOW(3) ⇒ rolling_back(reason=timeout)）', () => {
    expect(WITHDRAW_TIMEOUT_CLAIM_SQL).toBe(
      "UPDATE `payment_withdrawals` SET `status`='rolling_back', `rollback_reason`='timeout' WHERE `status` IN ('pending','approved') AND `timeout_at` < NOW(3)",
    );
  });

  it('回滚落账终态：reason=rejected ⇒ rejected / reason=timeout ⇒ timeout_rolled_back（均释槽 + rolled_back_at）', () => {
    expect(WITHDRAW_ROLLBACK_TO_REJECTED_SQL).toBe(
      "UPDATE `payment_withdrawals` SET `status`='rejected', `rolled_back_at`=NOW(3), `active_slot`=NULL WHERE `withdraw_no`=? AND `status`='rolling_back' AND `rollback_reason`='rejected'",
    );
    expect(WITHDRAW_ROLLBACK_TO_TIMEOUT_SQL).toBe(
      "UPDATE `payment_withdrawals` SET `status`='timeout_rolled_back', `rolled_back_at`=NOW(3), `active_slot`=NULL WHERE `withdraw_no`=? AND `status`='rolling_back' AND `rollback_reason`='timeout'",
    );
    expect(WITHDRAW_ROLLBACK_LAST_ERROR_SQL).toBe(
      'UPDATE `payment_withdrawals` SET `last_error`=? WHERE `withdraw_no`=?',
    );
  });

  it('扫描候选：循环④ holding / 循环⑤ rolling_back 未落账（均先老后新）', () => {
    expect(SELECT_HOLDING_SQL).toBe(
      "SELECT `withdraw_no`, `user_id`, `coins` FROM `payment_withdrawals` WHERE `status` = 'holding' ORDER BY `created_at` ASC, `id` ASC",
    );
    expect(SELECT_ROLLING_BACK_SQL).toBe(
      "SELECT `withdraw_no`, `user_id`, `coins`, `rollback_reason` FROM `payment_withdrawals` WHERE `status` = 'rolling_back' AND `rolled_back_at` IS NULL ORDER BY `created_at` ASC, `id` ASC",
    );
    expect(SELECT_ROLLBACK_TARGET_SQL).toBe(
      'SELECT `withdraw_no`, `user_id`, `coins`, `rollback_reason` FROM `payment_withdrawals` WHERE `withdraw_no` = ?',
    );
    expect(SELECT_WITHDRAW_STATUS_SQL).toBe(
      'SELECT `status` FROM `payment_withdrawals` WHERE `withdraw_no` = ?',
    );
  });

  it('统计读（withdraw_pending/oldest_age 按 state；fundop pending/oldest_age 按 op——UNION ALL 恒两行）', () => {
    expect(WITHDRAW_STATS_SQL).toBe(
      "SELECT `status` AS `state`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_withdrawals` WHERE `status` IN ('pending','approved') GROUP BY `status`",
    );
    expect(WITHDRAW_FUNDOP_STATS_SQL).toBe(
      "SELECT 'withdraw_hold' AS `op`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_withdrawals` WHERE `status` = 'holding' UNION ALL SELECT 'withdraw_rb' AS `op`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_withdrawals` WHERE `status` = 'rolling_back' AND `rolled_back_at` IS NULL",
    );
  });
});

/* ======================================================================== *
 * ② ⚙️4 单号形状
 * ======================================================================== */
describe('② ⚙️4 单号形状（wd_ + base36(ms) + 6 随机）', () => {
  it('形状：前缀 wd_、字符集 [0-9a-z_]、长 ≤ 32、含 base36 时间戳段；两次生成不相等', () => {
    const fixed = generateWithdrawNo(1_793_900_000_000);
    expect(fixed.startsWith(WITHDRAW_PREFIX)).toBe(true);
    expect(fixed).toMatch(/^wd_[0-9a-z]+$/);
    expect(fixed.length).toBeLessThanOrEqual(32);
    expect(fixed).toContain((1_793_900_000_000).toString(36));

    const a = generateWithdrawNo();
    const b = generateWithdrawNo();
    expect(a).toMatch(/^wd_[0-9a-z]+$/);
    expect(a).not.toBe(b);
  });
});

/* ======================================================================== *
 * 夹具
 * ======================================================================== */

const DAY_MS = 86_400_000;
/** +08:00 自然日的起点（UTC 毫秒）——假库与真 SQL（CONVERT_TZ 偏移写法）**同向**。 */
function beijingDayStartMs(now: Date): number {
  const shifted = now.getTime() + 8 * 3_600_000;
  return Math.floor(shifted / DAY_MS) * DAY_MS - 8 * 3_600_000;
}

interface FakeWithdrawRow {
  id: number;
  withdraw_no: string;
  user_id: string;
  coins: number;
  amount_fen: number;
  status: string;
  timeout_at: Date;
  hold_confirmed_at: Date | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  voucher: string | null;
  confirm_note: string | null;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  last_error: string | null;
  active_slot: number | null;
  created_at: Date;
  updated_at: Date;
}

interface FakeRefundRow {
  refund_no: string;
  user_id: string;
  status: string;
}

const THE_FIVE_IN_FLIGHT = ['holding', 'pending', 'approved', 'paid', 'rolling_back'];

/**
 * 假 DataSource：识别全部 SQL 常量**精确形状**（一漂移即「未识别的 SQL」当场红）；
 * `transaction()` 供 `withUserLock`（INSERT IGNORE → FOR UPDATE 等待链，照 locks.test.ts）。
 */
class FakeWithdrawDb {
  now = new Date('2026-10-06T04:00:00.000Z'); // = +08:00 2026-10-06 12:00
  rows: FakeWithdrawRow[] = [];
  refunds: FakeRefundRow[] = [];
  readonly lockRows = new Set<string>();
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  /** 注入点：>0 ⇒ 下一次 INSERT 报 withdraw_no 撞 UK（模拟单号碰撞，验重生成重试）。 */
  noDupInjections = 0;
  private nextId = 1;
  private readonly tail = new Map<string, Promise<void>>();

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  seedRow(over: Partial<FakeWithdrawRow> = {}): FakeWithdrawRow {
    const id = this.nextId++;
    const row: FakeWithdrawRow = {
      id,
      withdraw_no: over.withdraw_no ?? `wd_seed${String(id).padStart(4, '0')}`,
      user_id: USER,
      coins: 1000,
      amount_fen: 1000,
      status: 'pending',
      timeout_at: new Date(this.now.getTime() + 4320 * 60_000),
      hold_confirmed_at: null,
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      confirmed_by: null,
      confirmed_at: null,
      voucher: null,
      confirm_note: null,
      rolled_back_at: null,
      rollback_reason: null,
      last_error: null,
      active_slot: 1,
      created_at: new Date(this.now.getTime() - 60_000),
      updated_at: this.now,
      ...over,
    };
    // 终态行按 ⚙️15 恒 active_slot=NULL（除非显式覆盖）。
    if (['paid', 'rejected', 'timeout_rolled_back', 'failed'].includes(row.status) && over.active_slot === undefined) {
      row.active_slot = null;
    }
    this.rows.push(row);
    return row;
  }

  /** 造一笔**退款** `holding` 行（跨面占位用例的 SQL 造法）。 */
  seedRefundHolding(userId = USER, refund_no = 'rf_hold_0001'): FakeRefundRow {
    const row: FakeRefundRow = { refund_no, user_id: userId, status: 'holding' };
    this.refunds.push(row);
    return row;
  }

  seedRefund(over: Partial<FakeRefundRow> = {}): FakeRefundRow {
    const row: FakeRefundRow = {
      refund_no: over.refund_no ?? `rf_seed${this.refunds.length + 1}`,
      user_id: over.user_id ?? USER,
      status: over.status ?? 'rejected',
    };
    this.refunds.push(row);
    return row;
  }

  /** 锁 SQL 之外的语句（事务内外共用同一执行面）。 */
  private core(sql: string, params: unknown[]): unknown {
    this.queries.push({ sql, params });
    const nowMs = this.now.getTime();
    const rowBy = (no: unknown): FakeWithdrawRow | undefined => this.rows.find((r) => r.withdraw_no === no);

    switch (sql) {
      case WITHDRAW_DAY_TOTAL_SQL: {
        const dayStart = beijingDayStartMs(this.now);
        const total = this.rows
          .filter(
            (r) =>
              r.user_id === params[0] &&
              THE_FIVE_IN_FLIGHT.includes(r.status) &&
              r.created_at.getTime() >= dayStart &&
              r.created_at.getTime() < dayStart + DAY_MS,
          )
          .reduce((sum, r) => sum + r.coins, 0);
        return [{ total }];
      }
      case UNRESOLVED_HOLDING_SQL: {
        const hit =
          this.rows.some((r) => r.user_id === params[0] && r.status === 'holding') ||
          this.refunds.some((r) => r.user_id === params[1] && r.status === 'holding');
        return hit ? [{ no: 'hold' }] : [];
      }
      case INSERT_WITHDRAWAL_SQL: {
        if (this.noDupInjections > 0) {
          this.noDupInjections -= 1;
          throw Object.assign(new Error("Duplicate entry 'wd_x' for key 'payment_withdrawals.uk_withdraw_no'"), {
            code: 'ER_DUP_ENTRY',
            errno: 1062,
          });
        }
        const [withdraw_no, user_id, coins, amount_fen, timeoutMinutes] = params;
        if (this.rows.some((r) => r.withdraw_no === withdraw_no)) {
          throw Object.assign(
            new Error(`Duplicate entry '${String(withdraw_no)}' for key 'payment_withdrawals.uk_withdraw_no'`),
            { code: 'ER_DUP_ENTRY', errno: 1062 },
          );
        }
        if (this.rows.some((r) => r.user_id === user_id && r.active_slot === 1)) {
          throw Object.assign(
            new Error(`Duplicate entry '${String(user_id)}-1' for key 'payment_withdrawals.uk_withdrawals_user_active'`),
            { code: 'ER_DUP_ENTRY', errno: 1062 },
          );
        }
        const id = this.nextId++;
        this.rows.push({
          id,
          withdraw_no: String(withdraw_no),
          user_id: String(user_id),
          coins: Number(coins),
          amount_fen: Number(amount_fen),
          status: 'holding',
          timeout_at: new Date(nowMs + Number(timeoutMinutes) * 60_000),
          hold_confirmed_at: null,
          reviewed_by: null,
          reviewed_at: null,
          review_note: null,
          confirmed_by: null,
          confirmed_at: null,
          voucher: null,
          confirm_note: null,
          rolled_back_at: null,
          rollback_reason: null,
          last_error: null,
          active_slot: 1,
          created_at: new Date(nowMs),
          updated_at: new Date(nowMs),
        });
        return { affectedRows: 1 };
      }
      case WITHDRAW_HOLD_TO_PENDING_SQL: {
        const row = rowBy(params[0]);
        if (!row || row.status !== 'holding') return { affectedRows: 0 };
        row.status = 'pending';
        row.hold_confirmed_at = new Date(nowMs);
        return { affectedRows: 1 };
      }
      case WITHDRAW_HOLD_TO_FAILED_SQL: {
        const row = rowBy(params[1]);
        if (!row || row.status !== 'holding') return { affectedRows: 0 };
        row.status = 'failed';
        row.active_slot = null;
        row.last_error = params[0] === null ? null : String(params[0]);
        return { affectedRows: 1 };
      }
      case WITHDRAW_APPROVE_SQL: {
        const row = rowBy(params[2]);
        if (!row || row.status !== 'pending') return { affectedRows: 0 };
        row.status = 'approved';
        row.reviewed_by = String(params[0]);
        row.reviewed_at = new Date(nowMs);
        row.review_note = params[1] === null ? null : String(params[1]);
        return { affectedRows: 1 };
      }
      case WITHDRAW_REJECT_CLAIM_SQL: {
        const row = rowBy(params[2]);
        if (!row || !['pending', 'approved'].includes(row.status)) return { affectedRows: 0 };
        row.status = 'rolling_back';
        row.rollback_reason = 'rejected';
        row.reviewed_by = String(params[0]);
        row.reviewed_at = new Date(nowMs);
        row.review_note = params[1] === null ? null : String(params[1]);
        return { affectedRows: 1 };
      }
      case WITHDRAW_CONFIRM_PAID_SQL: {
        const row = rowBy(params[3]);
        if (!row || row.status !== 'approved') return { affectedRows: 0 };
        row.status = 'paid';
        row.confirmed_by = String(params[0]);
        row.confirmed_at = new Date(nowMs);
        row.voucher = String(params[1]);
        row.confirm_note = params[2] === null ? null : String(params[2]);
        row.active_slot = null;
        return { affectedRows: 1 };
      }
      case WITHDRAW_TIMEOUT_CLAIM_SQL: {
        const hit = this.rows.filter(
          (r) => ['pending', 'approved'].includes(r.status) && r.timeout_at.getTime() < nowMs,
        );
        for (const r of hit) {
          r.status = 'rolling_back';
          r.rollback_reason = 'timeout';
        }
        return { affectedRows: hit.length };
      }
      case WITHDRAW_ROLLBACK_TO_REJECTED_SQL: {
        const row = rowBy(params[0]);
        if (!row || row.status !== 'rolling_back' || row.rollback_reason !== 'rejected') return { affectedRows: 0 };
        row.status = 'rejected';
        row.rolled_back_at = new Date(nowMs);
        row.active_slot = null;
        return { affectedRows: 1 };
      }
      case WITHDRAW_ROLLBACK_TO_TIMEOUT_SQL: {
        const row = rowBy(params[0]);
        if (!row || row.status !== 'rolling_back' || row.rollback_reason !== 'timeout') return { affectedRows: 0 };
        row.status = 'timeout_rolled_back';
        row.rolled_back_at = new Date(nowMs);
        row.active_slot = null;
        return { affectedRows: 1 };
      }
      case WITHDRAW_ROLLBACK_LAST_ERROR_SQL: {
        const row = rowBy(params[1]);
        if (!row) return { affectedRows: 0 };
        row.last_error = params[0] === null ? null : String(params[0]);
        return { affectedRows: 1 };
      }
      case SELECT_HOLDING_SQL: {
        return this.rows
          .filter((r) => r.status === 'holding')
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id - b.id)
          .map((r) => ({ withdraw_no: r.withdraw_no, user_id: r.user_id, coins: r.coins }));
      }
      case SELECT_ROLLING_BACK_SQL: {
        return this.rows
          .filter((r) => r.status === 'rolling_back' && r.rolled_back_at === null)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id - b.id)
          .map((r) => ({
            withdraw_no: r.withdraw_no,
            user_id: r.user_id,
            coins: r.coins,
            rollback_reason: r.rollback_reason,
          }));
      }
      case SELECT_ROLLBACK_TARGET_SQL: {
        const row = rowBy(params[0]);
        return row
          ? [
              {
                withdraw_no: row.withdraw_no,
                user_id: row.user_id,
                coins: row.coins,
                rollback_reason: row.rollback_reason,
              },
            ]
          : [];
      }
      case SELECT_WITHDRAW_STATUS_SQL: {
        const row = rowBy(params[0]);
        return row ? [{ status: row.status }] : [];
      }
      case WITHDRAW_STATS_SQL: {
        const out: Array<{ state: string; cnt: number; oldest: number }> = [];
        for (const state of ['pending', 'approved']) {
          const rows = this.rows.filter((r) => r.status === state);
          if (rows.length === 0) continue; // 真 SQL GROUP BY 同向：无行则无结果行
          const oldest = Math.min(...rows.map((r) => r.created_at.getTime()));
          out.push({ state, cnt: rows.length, oldest: Math.max(0, Math.floor((nowMs - oldest) / 1000)) });
        }
        return out;
      }
      case WITHDRAW_FUNDOP_STATS_SQL: {
        const holdRows = this.rows.filter((r) => r.status === 'holding');
        const rbRows = this.rows.filter((r) => r.status === 'rolling_back' && r.rolled_back_at === null);
        const stat = (rows: FakeWithdrawRow[]) =>
          rows.length === 0
            ? { cnt: 0, oldest: 0 }
            : {
                cnt: rows.length,
                oldest: Math.max(0, Math.floor((nowMs - Math.min(...rows.map((r) => r.created_at.getTime()))) / 1000)),
              };
        return [
          { op: 'withdraw_hold', ...stat(holdRows) },
          { op: 'withdraw_rb', ...stat(rbRows) },
        ];
      }
      default:
        throw new Error(`未识别的 SQL（服务侧语句形状漂移？）：${sql}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql === LOCK_INSERT_IGNORE_SQL || sql === LOCK_SELECT_FOR_UPDATE_SQL) {
      // 锁语句只经事务面；顶层出现 = 形状错（响亮）。
      throw new Error(`锁语句不得走顶层 query：${sql}`);
    }
    return this.core(sql, params);
  }

  /** `withUserLock` 的事务面（行锁等待链；照 locks.test.ts 同形）。 */
  async transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    let releaseWaiters: () => void = () => undefined;
    const manager = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql === LOCK_INSERT_IGNORE_SQL) {
          this.queries.push({ sql, params });
          const userId = String(params[0]);
          const existed = this.lockRows.has(userId);
          this.lockRows.add(userId);
          return { affectedRows: existed ? 0 : 1 };
        }
        if (sql === LOCK_SELECT_FOR_UPDATE_SQL) {
          this.queries.push({ sql, params });
          const userId = String(params[0]);
          const prev = this.tail.get(userId) ?? Promise.resolve();
          await prev;
          const completion = new Promise<void>((res) => {
            releaseWaiters = res;
          });
          this.tail.set(userId, completion);
          return this.lockRows.has(userId) ? [{ user_id: userId }] : [];
        }
        return this.core(sql, params);
      },
    } as unknown as EntityManager;

    try {
      return await fn(manager);
    } finally {
      releaseWaiters();
    }
  }
}

type WithdrawCfgOver = Partial<{
  withdrawEnabled: boolean;
  coinPerYuan: number;
  withdrawMinCoins: number;
  withdrawMaxCoinsPerOrder: number;
  withdrawDailyMaxCoins: number;
  withdrawTimeoutMinutes: number;
  withdrawReAuthEnabled: boolean;
}>;

function makeConfig(over: WithdrawCfgOver = {}): ConfigCacheService {
  return {
    withdrawEnabled: () => over.withdrawEnabled ?? true,
    coinPerYuan: () => over.coinPerYuan ?? COIN_PER_YUAN_DEFAULT,
    withdrawMinCoins: () => over.withdrawMinCoins ?? WITHDRAW_MIN_COINS_DEFAULT,
    withdrawMaxCoinsPerOrder: () => over.withdrawMaxCoinsPerOrder ?? WITHDRAW_MAX_COINS_PER_ORDER_DEFAULT,
    withdrawDailyMaxCoins: () => over.withdrawDailyMaxCoins ?? WITHDRAW_DAILY_MAX_COINS_DEFAULT,
    withdrawTimeoutMinutes: () => over.withdrawTimeoutMinutes ?? WITHDRAW_TIMEOUT_MINUTES_DEFAULT,
    withdrawReAuthEnabled: () => over.withdrawReAuthEnabled ?? false,
  } as unknown as ConfigCacheService;
}

const okApplyData = (req: CurrencyApplyRequest, replayed = false): CurrencyApplyData => ({
  opId: 1,
  actionId: req.actionId,
  entries: req.entries.map((e) => ({ ownerId: e.ownerId, balanceAfter: e.delta })),
  replayed,
});

function makeClient(
  over: {
    apply?: (req: CurrencyApplyRequest) => Promise<CurrencyApplyData>;
    withdrawable?: (req: { ownerId: string }) => Promise<CurrencyWithdrawableGetResponse>;
  } = {},
) {
  const apply = vi.fn(over.apply ?? (async (req: CurrencyApplyRequest) => okApplyData(req)));
  const withdrawable = vi.fn(
    over.withdrawable ?? (async () => ({ cap: 1_000_000, balance: 1_000_000 })),
  );
  return { client: { apply, withdrawable } as unknown as CurrencyRpcClient, apply, withdrawable };
}

function makeService(
  db: FakeWithdrawDb,
  cfg: ConfigCacheService = makeConfig(),
  client: CurrencyRpcClient = makeClient().client,
): WithdrawService {
  return new WithdrawService(db.dataSource, cfg, client, new UserLockService(db.dataSource));
}

/** 指标读数（各自直读——与 scan/orders 套件同式）。 */
const withdrawPending = async (state: string): Promise<number | undefined> =>
  (await paymentWithdrawPending.get()).values.find((v) => v.labels.state === state)?.value;
const withdrawOldest = async (state: string): Promise<number | undefined> =>
  (await paymentWithdrawOldestAgeSeconds.get()).values.find((v) => v.labels.state === state)?.value;
const fundopPending = async (op: string): Promise<number | undefined> =>
  (await paymentFundopPending.get()).values.find((v) => v.labels.op === op)?.value;
const fundopOldest = async (op: string): Promise<number | undefined> =>
  (await paymentFundopOldestAgeSeconds.get()).values.find((v) => v.labels.op === op)?.value;
const fundopRetry = async (op: string): Promise<number | undefined> =>
  (await paymentFundopRetryTotal.get()).values.find((v) => v.labels.op === op)?.value;

beforeEach(() => {
  paymentWithdrawPending.reset();
  paymentWithdrawOldestAgeSeconds.reset();
  paymentFundopPending.reset();
  paymentFundopOldestAgeSeconds.reset();
  paymentFundopRetryTotal.reset();
});

/* ======================================================================== *
 * ③ apply 正例全链
 * ======================================================================== */
describe('③ apply 正例：锁内三段（校验→插行→冻结）', () => {
  it('全链：语句序 = 锁 → 日限合计 → holding 占位查 → INSERT(holding,slot=1) → apply 冻结 → holding→pending；响应 pending', async () => {
    const db = new FakeWithdrawDb();
    const cfg = makeConfig({ withdrawTimeoutMinutes: 4320 });
    const { client, apply, withdrawable } = makeClient();
    const svc = makeService(db, cfg, client);

    const res = await svc.apply(USER, 1000);
    const no = res.withdrawNo;

    expect(res).toEqual({ withdrawNo: no, status: 'pending' });
    expect(no).toMatch(/^wd_[0-9a-z]+$/);

    // 语句序（锁内三段全程在场的机械证）：锁 → 日限 → 占位 → INSERT → 落账更新。
    const inner = db.queries.map((q) => q.sql);
    expect(inner).toEqual([
      LOCK_INSERT_IGNORE_SQL,
      LOCK_SELECT_FOR_UPDATE_SQL,
      WITHDRAW_DAY_TOTAL_SQL,
      UNRESOLVED_HOLDING_SQL,
      INSERT_WITHDRAWAL_SQL,
      WITHDRAW_HOLD_TO_PENDING_SQL,
      WITHDRAW_STATS_SQL,
      WITHDRAW_FUNDOP_STATS_SQL,
    ]);
    expect(db.queries[0]!.params).toEqual([USER]);
    expect(db.queries[1]!.params).toEqual([USER]);
    expect(db.queries[2]!.params).toEqual([USER]);
    expect(db.queries[3]!.params).toEqual([USER, USER]);
    // INSERT 参数逐字：单号/用户/币/分/超时分钟（timeout_at 由 DB 时钟生成——夹具同向）。
    expect(db.queries[4]!.params).toEqual([no, USER, 1000, 1000, 4320]);

    // 冻结 RPC：锚先于入账（随请求过线）、source/refId/entries 逐字、负 delta。
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `withdraw:${no}`,
      source: 'withdraw_hold',
      refId: no,
      entries: [{ ownerId: USER, delta: -1000 }],
    });
    // cap 取数在**资金动作时刻**（锁内）：每笔申请各读一次（禁缓存、禁只查一次）。
    expect(withdrawable).toHaveBeenCalledTimes(1);
    expect(withdrawable.mock.calls[0]![0]).toEqual({ ownerId: USER });

    const row = db.rows[0]!;
    expect(row.status).toBe('pending');
    expect(row.active_slot).toBe(1);
    expect(row.hold_confirmed_at).toEqual(db.now);
    expect(row.timeout_at).toEqual(new Date(db.now.getTime() + 4320 * 60_000));
  });

  it('amount_fen = floor(coins × 100 / coinPerYuan) 行内快照（后续改配置不影响在途单）', async () => {
    const db = new FakeWithdrawDb();
    const cfg = makeConfig({ coinPerYuan: 3 }); // 1000 币 ⇒ floor(100000/3) = 33333 分
    const svc = makeService(db, cfg);

    const res = await svc.apply(USER, 1000);
    const row = db.rows[0]!;
    expect(row.amount_fen).toBe(33333);
    expect(row.coins).toBe(1000);
    expect(res.status).toBe('pending');
  });

  it('单号撞 UK（uk_withdraw_no）⇒ 换号重试（成功落第二号；两次生成不同）', async () => {
    const db = new FakeWithdrawDb();
    db.noDupInjections = 1; // 第一次 INSERT 报 uk_withdraw_no 撞键（模拟碰撞）
    const svc = makeService(db);

    const res = await svc.apply(USER, 1000);
    const inserts = db.queries.filter((q) => q.sql === INSERT_WITHDRAWAL_SQL);
    expect(inserts).toHaveLength(2);
    const firstNo = inserts[0]!.params[0];
    const secondNo = inserts[1]!.params[0];
    expect(secondNo).not.toBe(firstNo);
    expect(res.withdrawNo).toBe(secondNo);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.withdraw_no).toBe(secondNo);
  });
});

/* ======================================================================== *
 * ④ 校验清单逐字（负例）
 * ======================================================================== */
describe('④ 校验清单逐字负例（§3.2：开关→门槛→单笔→(0分)→日限→cap→占位）', () => {
  const rejects = async (
    svc: WithdrawService,
    coins: unknown,
    code: ErrCode,
    message: string,
  ): Promise<void> => {
    await expect(svc.apply(USER, coins)).rejects.toMatchObject({ code, message });
  };

  it('开关关 ⇒ 15003「功能未开放」；零业务库写、零 RPC（锁在验前——语句恰两条锁语句）', async () => {
    const db = new FakeWithdrawDb();
    const { client, apply, withdrawable } = makeClient();
    const svc = makeService(db, makeConfig({ withdrawEnabled: false }), client);

    await rejects(svc, 1000, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（功能未开放）');
    // §5.2 锁内三段：校验**在锁内**（步②）——锁语句在场、业务 SQL 零条、行零落。
    expect(db.queries.map((q) => q.sql)).toEqual([LOCK_INSERT_IGNORE_SQL, LOCK_SELECT_FOR_UPDATE_SQL]);
    expect(db.rows).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
    expect(withdrawable).not.toHaveBeenCalled();
  });

  it('门槛：低于 min ⇒ 15003「低于门槛」；非整数/字符串/缺省同出口（严格类型）', async () => {
    const db = new FakeWithdrawDb();
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig(), client);

    for (const bad of [999, 0, -1000, 1.5, '1000', undefined, null, NaN]) {
      await rejects(svc, bad, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（低于门槛）');
    }
    expect(apply).not.toHaveBeenCalled();
    expect(db.queries.filter((q) => q.sql === INSERT_WITHDRAWAL_SQL)).toHaveLength(0);
  });

  it('单笔：超 max ⇒ 15004「超出限额（单笔）」（= max 放行）', async () => {
    const db = new FakeWithdrawDb();
    const svc = makeService(db, makeConfig({ withdrawMaxCoinsPerOrder: 50000 }));

    await rejects(svc, 50001, ErrCode.PAY_WITHDRAW_LIMIT, '超出限额（单笔）');
    expect(db.rows).toHaveLength(0);

    const res = await svc.apply(USER, 50000); // 边界 = 放行
    expect(res.status).toBe('pending');
  });

  it('0 分拒：floor 换算得 0 分 ⇒ 15003「低于门槛」（coinPerYuan 极大时 1000 币 < 1 分）', async () => {
    const db = new FakeWithdrawDb();
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig({ coinPerYuan: 200_000 }), client);

    await rejects(svc, 1000, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（低于门槛）');
    expect(apply).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(0);
  });

  it('日限：五态合计 + coins > max ⇒ 15004「超出限额（单日）」（合计只计本人）', async () => {
    const db = new FakeWithdrawDb();
    db.seedRow({ user_id: USER, status: 'paid', coins: 99_000 }); // 今日、计入（paid）
    db.seedRow({ user_id: OTHER_USER, status: 'paid', coins: 99_000 }); // 他人——不计
    const svc = makeService(db, makeConfig({ withdrawDailyMaxCoins: 100_000 }));

    await rejects(svc, 1001, ErrCode.PAY_WITHDRAW_LIMIT, '超出限额（单日）');
    expect(db.rows.filter((r) => r.status === 'holding')).toHaveLength(0);

    const res = await svc.apply(USER, 1000); // 99000+1000 = 100000 = max ⇒ 边界放行
    expect(res.status).toBe('pending');
  });

  it('cap 不足 ⇒ 15005「可提余额不足」（cap 来自 RPC 此刻读数；= cap 放行）', async () => {
    const db = new FakeWithdrawDb();
    const { client, withdrawable } = makeClient({
      withdrawable: async () => ({ cap: 3000, balance: 50_000 }),
    });
    const svc = makeService(db, makeConfig(), client);

    await rejects(svc, 3001, ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT, '可提余额不足');
    expect(withdrawable).toHaveBeenCalledTimes(1); // 失败面也已在动作时刻取数

    const res = await svc.apply(USER, 3000);
    expect(res.status).toBe('pending');
    expect(withdrawable).toHaveBeenCalledTimes(2); // 第二笔**再次**取数（禁缓存、禁只查一次）
  });

  it('holding 占位（提现行）⇒ 15003「有处理中申请，请稍后重试」', async () => {
    const db = new FakeWithdrawDb();
    db.seedRow({ status: 'holding' });
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig(), client);

    await rejects(svc, 1000, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（有处理中申请，请稍后重试）');
    expect(apply).not.toHaveBeenCalled();
    expect(db.queries.filter((q) => q.sql === INSERT_WITHDRAWAL_SQL)).toHaveLength(0);
  });

  it('holding 占位（**退款**行——SQL 造）⇒ 提现申请同样拒（跨面占位，§2.4）', async () => {
    const db = new FakeWithdrawDb();
    db.seedRefundHolding(USER, 'rf_cross_0001');
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig(), client);

    await rejects(svc, 1000, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（有处理中申请，请稍后重试）');
    expect(apply).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(0);
  });

  it('在途槽 UK（已有 pending）⇒ 15003「已有在途申请」（holding 占位查不中、UK 兜底）', async () => {
    const db = new FakeWithdrawDb();
    db.seedRow({ status: 'pending', active_slot: 1 });
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig(), client);

    await rejects(svc, 1000, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '提现暂不可用（已有在途申请）');
    expect(apply).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1); // 未新增
  });
});

/* ======================================================================== *
 * ⑤ cap RPC fail-closed 专测
 * ======================================================================== */
describe('⑤ cap RPC fail-closed（§2.2.1：不确定不放松）', () => {
  it('RPC 超时/传输失败 ⇒ 15003「服务暂时不可用，请稍后重试」变体；零行落库、零 apply', async () => {
    const db = new FakeWithdrawDb();
    const { client, apply } = makeClient({
      withdrawable: async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
      },
    });
    const svc = makeService(db, makeConfig(), client);

    await expect(svc.apply(USER, 1000)).rejects.toMatchObject({
      code: ErrCode.PAY_WITHDRAW_UNAVAILABLE,
      message: '提现暂不可用（服务暂时不可用，请稍后重试）',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(db.queries.filter((q) => q.sql === INSERT_WITHDRAWAL_SQL)).toHaveLength(0);
    expect(db.rows).toHaveLength(0);
  });

  it('坏回执（cap 非数/负）同出口 fail-closed（真实的形状守卫在 currency.client 层；此处注释对照）', async () => {
    const db = new FakeWithdrawDb();
    const { client } = makeClient({
      withdrawable: async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
      },
    });
    const svc = makeService(db, makeConfig(), client);

    await expect(svc.apply(USER, 1000)).rejects.toMatchObject({
      code: ErrCode.PAY_WITHDRAW_UNAVAILABLE,
      message: '提现暂不可用（服务暂时不可用，请稍后重试）',
    });
    expect(db.rows).toHaveLength(0);
  });
});

/* ======================================================================== *
 * ⑥ resolveHolding 三态（永不回滚）
 * ======================================================================== */
describe('⑥ resolveHolding：holding 只解析（成功/明确失败/未知）——**永不发 withdraw_rb**', () => {
  it('同锚解出成功 ⇒ pending + hold_confirmed_at；重试面计数 +1（循环内 = 重放）', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({ status: 'holding', coins: 600, user_id: USER });
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig(), client);

    expect(await svc.resolveHolding()).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.hold_confirmed_at).toEqual(db.now);
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `withdraw:${row.withdraw_no}`,
      source: 'withdraw_hold',
      refId: row.withdraw_no,
      entries: [{ ownerId: USER, delta: -600 }],
    });
    expect(await fundopRetry('withdraw_hold')).toBe(1);

    // 第二轮：行已 pending（不在 holding 候选）⇒ 0、零新 RPC
    expect(await svc.resolveHolding()).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('明确失败（14001）⇒ failed + 释槽 + last_error 摘要；锚不是 rb（零 withdraw_rb）', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({ status: 'holding', user_id: USER });
    const { client, apply } = makeClient({
      apply: async () => {
        throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'ownerId=u 余额不足：整批回滚（delta=-1000）');
      },
    });
    const svc = makeService(db, makeConfig(), client);

    expect(await svc.resolveHolding()).toBe(1);
    expect(row.status).toBe('failed');
    expect(row.active_slot).toBeNull();
    expect(row.last_error).toBe('ownerId=u 余额不足：整批回滚（delta=-1000）');
    expect(apply.mock.calls.every((c) => String(c[0]!.actionId).startsWith('withdraw:'))).toBe(true);

    // 释槽后（故障解除）可再申请
    const ok = makeService(db, makeConfig(), makeClient().client);
    expect((await ok.apply(USER, 1000)).status).toBe('pending');
  });

  it('结果未知 ⇒ 停留 holding（不改终态/不写 last_error）；下轮重放同锚收敛', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({ status: 'holding' });
    row.created_at = new Date(db.now.getTime() - 120_000); // 已停留 2 分钟
    let fail = true;
    const { client, apply } = makeClient({
      apply: async (req) => {
        if (fail) throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
        return okApplyData(req);
      },
    });
    const svc = makeService(db, makeConfig(), client);

    expect(await svc.resolveHolding()).toBe(0);
    expect(row.status).toBe('holding');
    expect(row.hold_confirmed_at).toBeNull();
    expect(row.last_error).toBeNull(); // 写点清单不含「未知」
    expect(await fundopRetry('withdraw_hold')).toBe(1);
    expect(await fundopPending('withdraw_hold')).toBe(1);
    expect(await fundopOldest('withdraw_hold')).toBe(120); // 告警哨兵（>900s 响）

    // 第二轮仍未知 ⇒ 同锚再重放
    expect(await svc.resolveHolding()).toBe(0);
    expect(apply.mock.calls[1]![0].actionId).toBe(apply.mock.calls[0]![0].actionId);

    // 第三轮远端恢复 ⇒ 收敛 pending
    fail = false;
    expect(await svc.resolveHolding()).toBe(1);
    expect(row.status).toBe('pending');
    expect(await fundopPending('withdraw_hold')).toBe(0);
  });
});

/* ======================================================================== *
 * ⑦ claim 互斥（confirm vs 超时扫描 / reject vs confirm）
 * ======================================================================== */
describe('⑦ claim 互斥：谁先抢行谁生效（条件 UPDATE；双付面结构性消除）', () => {
  it('confirm 先胜 ⇒ paid；随后超时扫描零命中（不误滚已付单）', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({
      status: 'approved',
      active_slot: 1,
      timeout_at: new Date(db.now.getTime() - 60_000), // 已过期
    });
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig(), client);

    const res = await svc.confirmPaid(ADMIN, row.withdraw_no, { voucher: 'V-001' });
    expect(res).toEqual({ withdrawNo: row.withdraw_no, status: 'paid' });

    expect(await svc.rollbackTimeout()).toBe(0); // 已 paid ⇒ 超时 claim 零命中、零 rb
    expect(row.status).toBe('paid');
    expect(apply).not.toHaveBeenCalled();
  });

  it('超时扫描先胜 ⇒ rolling_back ⇒ timeout_rolled_back；随后 confirm ⇒ 15009（message 含当前态与合法动作）', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({
      status: 'approved',
      active_slot: 1,
      timeout_at: new Date(db.now.getTime() - 60_000),
    });
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig(), client);

    expect(await svc.rollbackTimeout()).toBe(1);
    expect(row.status).toBe('timeout_rolled_back');
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `withdraw_rb:${row.withdraw_no}`,
      source: 'withdraw_rollback',
      refId: row.withdraw_no,
      entries: [{ ownerId: USER, delta: +1000 }],
    });

    await expect(svc.confirmPaid(ADMIN, row.withdraw_no, { voucher: 'V-002' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });
    try {
      await svc.confirmPaid(ADMIN, row.withdraw_no, { voucher: 'V-002' });
    } catch (err) {
      const message = (err as DomainError).message;
      expect(message).toContain('timeout_rolled_back'); // 当前态
      expect(message).toContain('approved'); // 合法动作面
    }
  });

  it('confirm 先胜（approved⇒paid）后 reject ⇒ 15009；reject 先胜（approved⇒rejected）后 confirm ⇒ 15009', async () => {
    const db = new FakeWithdrawDb();
    const byConfirm = db.seedRow({ status: 'approved' });
    const byReject = db.seedRow({ status: 'approved' });
    const svc = makeService(db);

    expect((await svc.confirmPaid(ADMIN, byConfirm.withdraw_no, { voucher: 'V-A' })).status).toBe('paid');
    await expect(svc.review(ADMIN, byConfirm.withdraw_no, { action: 'reject' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });

    expect((await svc.review(ADMIN, byReject.withdraw_no, { action: 'reject' })).status).toBe('rejected');
    await expect(svc.confirmPaid(ADMIN, byReject.withdraw_no, { voucher: 'V-B' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });
  });

  it('非法源态全表：holding 不可审、pending 不可 confirm、rolling_back 不可审/不可 confirm、不存在 15009', async () => {
    const db = new FakeWithdrawDb();
    const holding = db.seedRow({ status: 'holding' });
    const pending = db.seedRow({ status: 'pending' });
    const rb = db.seedRow({ status: 'rolling_back', rollback_reason: 'rejected' });
    const svc = makeService(db);

    await expect(svc.review(ADMIN, holding.withdraw_no, { action: 'approve' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });
    await expect(svc.confirmPaid(ADMIN, pending.withdraw_no, { voucher: 'V' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });
    await expect(svc.review(ADMIN, rb.withdraw_no, { action: 'reject' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });
    await expect(svc.confirmPaid(ADMIN, rb.withdraw_no, { voucher: 'V' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });
    await expect(svc.review(ADMIN, 'wd_missing0000', { action: 'approve' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });
    // 状态未被扰动
    expect([holding.status, pending.status, rb.status]).toEqual(['holding', 'pending', 'rolling_back']);
  });
});

/* ======================================================================== *
 * ⑧ 槽语义（⚙️15）
 * ======================================================================== */
describe('⑧ 槽语义：在途唯一；终态四路全部释放（可再申请）', () => {
  it('paid / rejected / timeout_rolled_back / failed 四条终态路径全部 active_slot=NULL，且行数释放后可再申请', async () => {
    const db = new FakeWithdrawDb();
    const paidRow = db.seedRow({ status: 'approved' });
    const rejRow = db.seedRow({ status: 'pending' });
    const tRow = db.seedRow({ status: 'approved', timeout_at: new Date(db.now.getTime() - 1000) });
    const failRow = db.seedRow({ status: 'holding' });
    const { client } = makeClient({
      apply: async (req) => {
        if (req.actionId === `withdraw:${failRow.withdraw_no}`) {
          throw new CurrencyServiceError(ErrCode.BAD_PARAM, '载荷非法');
        }
        return okApplyData(req);
      },
    });
    const svc = makeService(db, makeConfig(), client);

    await svc.confirmPaid(ADMIN, paidRow.withdraw_no, { voucher: 'V' });
    await svc.review(ADMIN, rejRow.withdraw_no, { action: 'reject' });
    await svc.resolveHolding(); // failRow ⇒ failed
    await svc.rollbackTimeout(); // tRow ⇒ timeout_rolled_back

    expect(paidRow.status).toBe('paid');
    expect(rejRow.status).toBe('rejected');
    expect(tRow.status).toBe('timeout_rolled_back');
    expect(failRow.status).toBe('failed');
    for (const row of [paidRow, rejRow, tRow, failRow]) {
      expect(row.active_slot, row.withdraw_no).toBeNull();
    }

    // 终态全释槽 ⇒ 同一用户可再申请（无 UK 拦截）。
    const res = await svc.apply(USER, 1000);
    expect(res.status).toBe('pending');
  });

  it('并发两申请（同用户）⇒ 锁串行 + UK 兜底恰一胜（败者 15003「已有在途申请」）', async () => {
    const db = new FakeWithdrawDb();
    const svc = makeService(db);

    const results = await Promise.allSettled([svc.apply(USER, 1000), svc.apply(USER, 2000)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: ErrCode.PAY_WITHDRAW_UNAVAILABLE,
      message: '提现暂不可用（已有在途申请）',
    });
    expect(db.rows.filter((r) => r.active_slot === 1)).toHaveLength(1);
  });
});

/* ======================================================================== *
 * ⑨ 日限归日口径（+08:00 自然日）
 * ======================================================================== */
describe('⑨ 日限归日口径（created_at ∈ +08:00 自然日；参与状态集逐字）', () => {
  it('+08:00 日界：恰在日首（含）计入、日首前 1ms（前一日）不计——UTC 存 / 北京时间切天', async () => {
    const db = new FakeWithdrawDb();
    const dayStart = beijingDayStartMs(db.now);
    // +08:00 今日 00:00 整（= UTC 昨日 16:00）—— 含边界
    db.seedRow({ status: 'paid', coins: 99_000, created_at: new Date(dayStart) });
    // +08:00 昨日 23:59:59.999 —— 不计（若误计 ⇒ 下面第一笔必拒）
    db.seedRow({ status: 'paid', coins: 99_000, created_at: new Date(dayStart - 1) });
    const svc = makeService(db, makeConfig({ withdrawDailyMaxCoins: 100_000 }));

    const res = await svc.apply(USER, 1000); // 99000 + 1000 = 100000 ⇒ 过（证明前一日行未计入）
    expect(res.status).toBe('pending');
  });

  it('状态集逐字（计入面）：holding/pending/approved/paid/rolling_back 都进合计', async () => {
    const db = new FakeWithdrawDb();
    // holding 99000 + pending 2000 = 101000（含 holding）——若 holding 未计入（2000+1000=3000 ≤ 100000）
    // 会在**步⑦占位拒**（15003），此处若得 15004 = holding 确已计入。
    db.seedRow({ status: 'holding', coins: 99_000 });
    db.seedRow({ status: 'pending', coins: 2000 });
    const svc = makeService(db, makeConfig({ withdrawDailyMaxCoins: 100_000 }));
    await expect(svc.apply(USER, 1000)).rejects.toMatchObject({
      code: ErrCode.PAY_WITHDRAW_LIMIT,
      message: '超出限额（单日）',
    });

    // approved 98000 + paid 1000 + rolling_back 1000 = 100000；+1000 ⇒ 101000 > max ⇒ 15004。
    // （若 approved/paid/rolling_back 任一未计入，步⑦会被在途槽 UK 拦成 15003「已有在途申请」——可判别。）
    const db2 = new FakeWithdrawDb();
    db2.seedRow({ status: 'approved', coins: 98_000 });
    db2.seedRow({ status: 'paid', coins: 1000 });
    db2.seedRow({ status: 'rolling_back', coins: 1000 });
    const svc2 = makeService(db2, makeConfig({ withdrawDailyMaxCoins: 100_000 }));
    await expect(svc2.apply(USER, 1000)).rejects.toMatchObject({
      code: ErrCode.PAY_WITHDRAW_LIMIT,
      message: '超出限额（单日）',
    });
  });

  it('状态集逐字（不计面）：rejected/timeout_rolled_back/failed 三态不计（含日界内）', async () => {
    const db = new FakeWithdrawDb();
    db.seedRow({ status: 'rejected', coins: 99_000 }); // 若误计 ⇒ 下面必拒 15004
    db.seedRow({ status: 'timeout_rolled_back', coins: 99_000 });
    db.seedRow({ status: 'failed', coins: 99_000 });
    const svc = makeService(db, makeConfig({ withdrawDailyMaxCoins: 100_000 }));

    const res = await svc.apply(USER, 1000); // 0 + 1000 ≤ 100000 ⇒ 过（终态行零贡献 + 无在途槽）
    expect(res.status).toBe('pending');
  });
});

/* ======================================================================== *
 * ⑩ 超时回滚
 * ======================================================================== */
describe('⑩ rollbackTimeout（循环⑤）：claim→rb→终态；未知停留；未到期不动', () => {
  it('pending 超时 ⇒ claim(reason=timeout) ⇒ rb 落账 ⇒ timeout_rolled_back + rolled_back_at + 释槽', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({
      status: 'pending',
      coins: 1500,
      timeout_at: new Date(db.now.getTime() - 1000),
    });
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig(), client);

    expect(await svc.rollbackTimeout()).toBe(1);
    expect(row.status).toBe('timeout_rolled_back');
    expect(row.rollback_reason).toBe('timeout');
    expect(row.rolled_back_at).toEqual(db.now);
    expect(row.active_slot).toBeNull();
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `withdraw_rb:${row.withdraw_no}`,
      source: 'withdraw_rollback',
      refId: row.withdraw_no,
      entries: [{ ownerId: USER, delta: +1500 }],
    });

    // 幂等：第二轮零候选
    expect(await svc.rollbackTimeout()).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('未到期/已终态/holding 一律不动；批扫多行（pending+approved 两态齐下）', async () => {
    const db = new FakeWithdrawDb();
    const fresh = db.seedRow({ status: 'pending', timeout_at: new Date(db.now.getTime() + 60_000) });
    const holding = db.seedRow({ status: 'holding', timeout_at: new Date(db.now.getTime() - 1000) });
    const paid = db.seedRow({ status: 'paid' });
    const p = db.seedRow({ status: 'pending', timeout_at: new Date(db.now.getTime() - 1) });
    const a = db.seedRow({ status: 'approved', timeout_at: new Date(db.now.getTime() - 1) });
    const svc = makeService(db);

    expect(await svc.rollbackTimeout()).toBe(2);
    expect([fresh.status, holding.status, paid.status]).toEqual(['pending', 'holding', 'paid']);
    expect([p.status, a.status]).toEqual(['timeout_rolled_back', 'timeout_rolled_back']);
  });

  it('rb 结果未知 ⇒ 停留 rolling_back + last_error 摘要（绝不误置终态）；下轮同锚重放收敛', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({
      status: 'pending',
      timeout_at: new Date(db.now.getTime() - 1000),
    });
    let fail = true;
    const { client, apply } = makeClient({
      apply: async (req) => {
        if (fail) throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
        return okApplyData(req);
      },
    });
    const svc = makeService(db, makeConfig(), client);

    expect(await svc.rollbackTimeout()).toBe(0);
    expect(row.status).toBe('rolling_back'); // 停留态（章④）
    expect(row.rollback_reason).toBe('timeout');
    expect(row.active_slot).toBe(1); // 绝不释槽（币未回而槽已放 = 破钱）
    expect(row.rolled_back_at).toBeNull();
    expect(row.last_error).toBe('服务暂时不可用，请稍后重试');
    expect(await fundopRetry('withdraw_rb')).toBe(1);
    expect(await fundopPending('withdraw_rb')).toBe(1);

    fail = false;
    expect(await svc.rollbackTimeout()).toBe(1);
    expect(row.status).toBe('timeout_rolled_back');
    expect(row.rolled_back_at).toEqual(db.now);
    expect(apply.mock.calls[1]![0].actionId).toBe(apply.mock.calls[0]![0].actionId); // 同锚
    expect(await fundopPending('withdraw_rb')).toBe(0);
  });
});

/* ======================================================================== *
 * ⑪ 驳回回滚（review reject）
 * ======================================================================== */
describe('⑪ review reject：claim→rb→rejected；rb 失败停留 rolling_back（响应实际态）', () => {
  it('pending 驳回 ⇒ rejected（审者列逐字 + 释槽 + 锚 withdraw_rb）', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({ status: 'pending', coins: 2000 });
    const { client, apply } = makeClient();
    const svc = makeService(db, makeConfig(), client);

    const res = await svc.review(ADMIN, row.withdraw_no, { action: 'reject', note: '风控要求' });
    expect(res).toEqual({ withdrawNo: row.withdraw_no, status: 'rejected' });
    expect(row.reviewed_by).toBe(ADMIN);
    expect(row.reviewed_at).toEqual(db.now);
    expect(row.review_note).toBe('风控要求');
    expect(row.rolled_back_at).toEqual(db.now);
    expect(row.active_slot).toBeNull();
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `withdraw_rb:${row.withdraw_no}`,
      source: 'withdraw_rollback',
      refId: row.withdraw_no,
      entries: [{ ownerId: USER, delta: +2000 }],
    });
    // §2.6·5：审驳回的 inline rb 是**首尝试**（不属「同锚重放机器」⇒ 不计 retry；
    // 计数面 = 循环⑤的扫描重放，见 ⑩）。
    expect(await fundopRetry('withdraw_rb')).toBeUndefined();
  });

  it('approved 也可驳回（pending|approved 同权）；approve 仅 pending（approved 再审 ⇒ 15009）', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({ status: 'approved' });
    const svc = makeService(db);

    expect((await svc.review(ADMIN, row.withdraw_no, { action: 'reject' })).status).toBe('rejected');

    const row2 = db.seedRow({ status: 'pending' });
    expect((await svc.review(ADMIN, row2.withdraw_no, { action: 'approve', note: undefined })).status).toBe('approved');
    expect(row2.reviewed_by).toBe(ADMIN);
    expect(row2.review_note).toBeNull();
    await expect(svc.review(ADMIN, row2.withdraw_no, { action: 'approve' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });
  });

  it('rb 明确失败 ⇒ 留 rolling_back + last_error + 响亮日志；响应返回**实际态** rolling_back', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({ status: 'pending' });
    const { client } = makeClient({
      apply: async () => {
        throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'ownerId=u 余额不足：整批回滚（delta=+1000）');
      },
    });
    const svc = makeService(db, makeConfig(), client);

    const res = await svc.review(ADMIN, row.withdraw_no, { action: 'reject' });
    expect(res.status).toBe('rolling_back'); // 「200 返回实际态」
    expect(row.status).toBe('rolling_back');
    expect(row.active_slot).toBe(1); // 绝不误置终态、不释槽
    expect(row.last_error).toBe('ownerId=u 余额不足：整批回滚（delta=+1000）');

    // 恢复扫描照常接力（下一轮同锚重放 ⇒ rejected）
    const ok = makeService(db, makeConfig(), makeClient().client);
    expect(await ok.rollbackTimeout()).toBe(1);
    expect(row.status).toBe('rejected');
  });
});

/* ======================================================================== *
 * ⑫ confirmPaid
 * ======================================================================== */
describe('⑫ confirmPaid：claim WHERE status=approved（voucher 台账登记）', () => {
  it('成功：paid + confirmed_by/at + voucher/note 逐字；P2 打款台账（voucher ≤64）', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({ status: 'approved' });
    const svc = makeService(db);

    const res = await svc.confirmPaid(ADMIN, row.withdraw_no, { voucher: '2026100622001688000000000001', note: '已转账' });
    expect(res).toEqual({ withdrawNo: row.withdraw_no, status: 'paid' });
    expect(row.confirmed_by).toBe(ADMIN);
    expect(row.confirmed_at).toEqual(db.now);
    expect(row.voucher).toBe('2026100622001688000000000001');
    expect(row.confirm_note).toBe('已转账');
    expect(row.active_slot).toBeNull();
  });

  it('参数校验负例：voucher 缺失/空/超 64/非串 ⇒ 10001；note 非串/超 255 ⇒ 10001；action 非法 ⇒ 10001', async () => {
    const db = new FakeWithdrawDb();
    const row = db.seedRow({ status: 'approved' });
    const pending = db.seedRow({ status: 'pending' });
    const svc = makeService(db);

    for (const voucher of [undefined, '', 'x'.repeat(65), 12345]) {
      await expect(
        svc.confirmPaid(ADMIN, row.withdraw_no, { voucher } as unknown as { voucher: string }),
      ).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    }
    await expect(
      svc.confirmPaid(ADMIN, row.withdraw_no, { voucher: 'V', note: 42 } as unknown as { voucher: string }),
    ).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    await expect(
      svc.confirmPaid(ADMIN, row.withdraw_no, { voucher: 'V', note: 'x'.repeat(256) }),
    ).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });

    const action = 'cancel' as unknown as 'approve';
    await expect(svc.review(ADMIN, pending.withdraw_no, { action })).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
    });
    // 全部负例零状态扰动
    expect(row.status).toBe('approved');
    expect(pending.status).toBe('pending');
  });
});

/* ======================================================================== *
 * ⑬ 开关只挡新建
 * ======================================================================== */
describe('⑬ 开关只挡新建（§5.3：中途关闭，在途照常可审可确认、超时照常回滚）', () => {
  it('withdrawEnabled=false：apply 拒；review/confirm/rb/超时扫描全照常', async () => {
    const db = new FakeWithdrawDb();
    const pending = db.seedRow({ status: 'pending' });
    const approved = db.seedRow({ status: 'approved' });
    const timeoutRow = db.seedRow({
      status: 'pending',
      timeout_at: new Date(db.now.getTime() - 1000),
    });
    const svc = makeService(db, makeConfig({ withdrawEnabled: false }));

    await expect(svc.apply(USER, 1000)).rejects.toMatchObject({
      code: ErrCode.PAY_WITHDRAW_UNAVAILABLE,
      message: '提现暂不可用（功能未开放）',
    });

    expect((await svc.review(ADMIN, pending.withdraw_no, { action: 'approve' })).status).toBe('approved');
    expect((await svc.confirmPaid(ADMIN, approved.withdraw_no, { voucher: 'V-OFF' })).status).toBe('paid');
    expect(await svc.rollbackTimeout()).toBe(1);
    expect(timeoutRow.status).toBe('timeout_rolled_back');
  });
});

/* ======================================================================== *
 * ⑭ 指标写点
 * ======================================================================== */
describe('⑭ 指标写点（§2.6：withdraw_pending/oldest_age{state} + fundop withdraw_hold/withdraw_rb 同刷）', () => {
  it('refresh 读数：pending/approved 各自计数与最老年龄；apply 成功后自动刷新', async () => {
    const db = new FakeWithdrawDb();
    db.seedRow({ status: 'pending', created_at: new Date(db.now.getTime() - 120_000) });
    db.seedRow({ status: 'approved', created_at: new Date(db.now.getTime() - 60_000) });
    db.seedRow({ status: 'paid' }); // 终态——不计
    const svc = makeService(db);

    await svc.refreshWithdrawGauges();
    expect(await withdrawPending('pending')).toBe(1);
    expect(await withdrawPending('approved')).toBe(1);
    expect(await withdrawOldest('pending')).toBe(120);
    expect(await withdrawOldest('approved')).toBe(60);

    // apply 成功后自动刷新（他用户新行 pending ⇒ pending 计数 2；USER 槽位被种行占满）
    const res = await svc.apply(OTHER_USER, 1000);
    expect(res.status).toBe('pending');
    expect(await withdrawPending('pending')).toBe(2);
  });

  it('fundop 同刷：holding ⇒ {op=withdraw_hold} 计数/年龄；rolling_back ⇒ {op=withdraw_rb}；claim 后迁移', async () => {
    const db = new FakeWithdrawDb();
    const holding = db.seedRow({ status: 'holding', created_at: new Date(db.now.getTime() - 300_000) });
    const svc = makeService(db);

    await svc.refreshWithdrawGauges();
    expect(await fundopPending('withdraw_hold')).toBe(1);
    expect(await fundopOldest('withdraw_hold')).toBe(300); // >900s 阈值 = PaymentFundOpStalled 哨兵
    expect(await fundopPending('withdraw_rb')).toBe(0);

    await svc.resolveHolding(); // holding ⇒ pending
    expect(await fundopPending('withdraw_hold')).toBe(0);
    expect(holding.status).toBe('pending');

    // 驳回 ⇒ rolling_back（rb 落账前经停留态；落账后归 0）
    const rejectRow = db.seedRow({ status: 'pending' });
    const { client } = makeClient({
      apply: async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
      },
    });
    const svc2 = makeService(db, makeConfig(), client);
    await svc2.review(ADMIN, rejectRow.withdraw_no, { action: 'reject' });
    expect(rejectRow.status).toBe('rolling_back');
    expect(await fundopPending('withdraw_rb')).toBe(1);
  });
});

/* ======================================================================== *
 * ⑮ 五个新 getter（真快照驱动；缺省照种子）
 * ======================================================================== */
describe('⑮ ConfigCache 五 getter（T10 消费面：27/30/31/32/34；缺省照种子）', () => {
  async function snapshotCache(values: Record<string, unknown>): Promise<ConfigCacheService> {
    process.env.CONFIG_SYNC_DISABLE_PUSH = '1';
    try {
      const client = {
        snapshot: async () => ({ config: values as never, version: 1 }),
      } as unknown as ConfigClient;
      const cache = new ConfigCacheService(client);
      cache.onModuleInit();
      await cache.waitForFirstSnapshot();
      return cache;
    } finally {
      delete process.env.CONFIG_SYNC_DISABLE_PUSH;
    }
  }

  it('快照值生效（五键逐字）', async () => {
    const cache = await snapshotCache({
      'pay.withdrawEnabled': { value: true, version: 1 },
      'pay.withdrawMinCoins': { value: 500, version: 1 },
      'pay.withdrawMaxCoinsPerOrder': { value: 20_000, version: 1 },
      'pay.withdrawDailyMaxCoins': { value: 60_000, version: 1 },
      'pay.withdrawTimeoutMinutes': { value: 60, version: 1 },
    });
    try {
      expect(cache.withdrawEnabled()).toBe(true);
      expect(cache.withdrawMinCoins()).toBe(500);
      expect(cache.withdrawMaxCoinsPerOrder()).toBe(20_000);
      expect(cache.withdrawDailyMaxCoins()).toBe(60_000);
      expect(cache.withdrawTimeoutMinutes()).toBe(60);
    } finally {
      cache.onApplicationShutdown();
    }
  });

  it('键缺失/坏值 ⇒ 各回种子（false / 1000 / 50000 / 100000 / 4320；越界/类型漂移同出口）', async () => {
    const cache = await snapshotCache({
      'pay.withdrawEnabled': { value: 'true', version: 1 }, // 严格 boolean：字符串不算
      'pay.withdrawMinCoins': { value: 0, version: 1 }, // 越界（<1）
      'pay.withdrawMaxCoinsPerOrder': { value: 1.5, version: 1 }, // 非整数
      'pay.withdrawDailyMaxCoins': { value: 1_000_001, version: 1 }, // 越界（>1e6）
      'pay.withdrawTimeoutMinutes': { value: 10081, version: 1 }, // 越界（>10080）
    });
    try {
      expect(cache.withdrawEnabled()).toBe(WITHDRAW_ENABLED_DEFAULT);
      expect(cache.withdrawMinCoins()).toBe(WITHDRAW_MIN_COINS_DEFAULT);
      expect(cache.withdrawMaxCoinsPerOrder()).toBe(WITHDRAW_MAX_COINS_PER_ORDER_DEFAULT);
      expect(cache.withdrawDailyMaxCoins()).toBe(WITHDRAW_DAILY_MAX_COINS_DEFAULT);
      expect(cache.withdrawTimeoutMinutes()).toBe(WITHDRAW_TIMEOUT_MINUTES_DEFAULT);
      // 种子逐字（规格 §2.5：27/30/31/32/34）
      expect([
        WITHDRAW_ENABLED_DEFAULT,
        WITHDRAW_MIN_COINS_DEFAULT,
        WITHDRAW_MAX_COINS_PER_ORDER_DEFAULT,
        WITHDRAW_DAILY_MAX_COINS_DEFAULT,
        WITHDRAW_TIMEOUT_MINUTES_DEFAULT,
      ]).toEqual([false, 1000, 50_000, 100_000, 4320]);
    } finally {
      cache.onApplicationShutdown();
    }
  });
});

/* ======================================================================== *
 * ⑯ 模块注册面 + 控制器真 HTTP
 * ======================================================================== */
describe('⑯ 注册面与控制器（真 Nest 管线 + node:http）', () => {
  it('AppModule：WithdrawController ∈ controllers、WithdrawService ∈ providers（未注册 = 真容器 404/启动崩）', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(controllers).toContain(WithdrawController);
    expect(providers).toContain(WithdrawService);
  });

  it('HTTP_STATUS：15003/15004/15005 → 409（不补则 4xx 静默变 500）', () => {
    expect(HTTP_STATUS[ErrCode.PAY_WITHDRAW_UNAVAILABLE]).toBe(409);
    expect(HTTP_STATUS[ErrCode.PAY_WITHDRAW_LIMIT]).toBe(409);
    expect(HTTP_STATUS[ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT]).toBe(409);
  });

  it('POST /api/pay/withdrawals：200 正例 / 401 缺身份 / 409+15xxx 错误码映射（真 HTTP）', async () => {
    const db = new FakeWithdrawDb();
    const { client } = makeClient();

    @Module({
      controllers: [WithdrawController],
      providers: [
        WithdrawService,
        { provide: DataSource, useValue: db.dataSource },
        { provide: ConfigCacheService, useValue: makeConfig() },
        { provide: CurrencyRpcClient, useValue: client },
        { provide: UserLockService, useValue: new UserLockService(db.dataSource) },
        // 提交 3：WithdrawController 新注入 REDIS（票据闸默认关，测试里 del 永远不被调；
        // 但 provider 必须存在否则真容器启动崩）。
        { provide: REDIS, useValue: { del: vi.fn().mockResolvedValue(0) } },
      ],
    })
    class WithdrawProbeModule {}

    const app = await NestFactory.create(WithdrawProbeModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const H = { 'x-user-id': USER, 'content-type': 'application/json' };

    try {
      const ok = await httpCall(port, '/api/pay/withdrawals', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ coins: 1000 }),
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.body) as { code: number; data: PayWithdrawApplyResponse };
      expect(body.code).toBe(ErrCode.OK);
      expect(body.data.withdrawNo).toMatch(/^wd_[0-9a-z]+$/);
      expect(body.data.status).toBe('pending');

      const noAuth = await httpCall(port, '/api/pay/withdrawals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coins: 1000 }),
      });
      expect(noAuth.status).toBe(401);
      expect(JSON.parse(noAuth.body) as { code: number }).toMatchObject({ code: ErrCode.UNAUTHENTICATED });

      const belowMin = await httpCall(port, '/api/pay/withdrawals', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ coins: 500 }),
      });
      expect(belowMin.status).toBe(409);
      expect(JSON.parse(belowMin.body) as { code: number }).toMatchObject({
        code: ErrCode.PAY_WITHDRAW_UNAVAILABLE,
        message: '提现暂不可用（低于门槛）',
      });

      const overMax = await httpCall(port, '/api/pay/withdrawals', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ coins: 50_001 }),
      });
      expect(overMax.status).toBe(409);
      expect(JSON.parse(overMax.body) as { code: number }).toMatchObject({ code: ErrCode.PAY_WITHDRAW_LIMIT });
    } finally {
      await app.close();
    }
  });
});

function httpCall(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = httpRequestRaw(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

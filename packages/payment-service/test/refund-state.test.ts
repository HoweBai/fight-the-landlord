/**
 * 支付片 T11：**退款链套件**（任务卡 Test: `refund-state.test.ts`；
 * 规格 §3.3 退款状态机逐字 · §3.4⑥⑦ · §2.2.1 cap 纪律 · ⚙️15 幂等槽（refunded 保留槽）· §2.6
 * （`payment_refund_total{result}` 写点）· §2.4.1 #6；设计 §6.1 申请即冻结 · §6.2 审核=纯渠道动作 ·
 * §6.3 状态机 · §2.5 出站重试表（trade.refund 退避 1s→5s→30s→2m→10m，上限后停）。
 *
 * 覆盖面（十五块）：
 *  ① 全部 SQL 常量**全文钉**（申请/解析/claim/渠道/回滚/扫描/统计；一个字符漂移即红）+
 *    退避表常量逐字 + **循环⑧候选 + `unknown:` 标记常量**（v1.1.4）；
 *  ② ⚙️4 单号形状（`rf_` + base36(ms) + 6 随机）；
 *  ③ apply 正例全链：锁内三段（语句序）· RPC 锚/来源/entries 逐字 · 响应 `pending` ·
 *     `amount_fen` = 同单快照 · `channel_out_request_no = refund_no`；
 *  ④ 校验清单逐字负例：order 不存在/非本人 15002 · 未入账 15006 · 槽（处理中/已退过）15006 ·
 *     cap 不足 15006「超出可退额度」· 未解析 `holding` 15006「稍后重试」（**SQL 造提现 holding**）·
 *     槽 UK 竞态 15006 · 入参形状 10001；
 *  ⑤ cap RPC **fail-closed 专测**（15006「服务暂时不可用」变体；零行落库）；
 *  ⑥ hold 三态（成功⇒pending / 明确失败⇒failed+释槽 / 未知⇒停留 holding）——**永不回滚**；
 *  ⑦ 解析循环⑥ `resolveHolding`（同锚重放三态；未知停留 + 告警面）；
 *  ⑧ **`refunded` 保留槽 ⇒ 二次申请 15006（结构断言：预检 + UK 双闸）**；
 *  ⑨ 驳回回滚 + 循环⑦（pending|approved 同权；rb 失败/未知 ⇒ 停留 `rejecting` + last_error ⇒
 *     循环⑦收敛；**rejected 释槽 ⇒ 可重报新 `rf_` 新锚**）；
 *  ⑩ approve 渠道成功 ⇒ `refunded`（`channel_refund_no` = `RefundData.tradeNo` · `refunded_at` ·
 *     **零货币动作**——`refund_hold` 即扣减）；
 *  ⑪ approve 渠道失败 ⇒ **退避序列 fake timers 断言**（1s→5s→30s→2m→10m 六发）⇒ 停 + 留
 *     `approved` + `last_error`（**分类落标记**：未知 ⇒ `unknown:` 前缀；业务拒/配置缺失 ⇒
 *     不标记）+ `channel_fail` 计数；每发前复核 claim（中途被驳 ⇒ 停发）；**分类器材质面专测**；
 *  ⑫ review 框架：action/note 负例 10001 · 15009 全表 · CAS 失手（渠道已成但行被处置）响亮留痕；
 *  ⑬ 指标：`payment_refund_total{result}` 四值写点 + `payment_fundop_{pending,oldest_age}`
 *     {op=refund_hold|refund_rb} 同刷；注册面；
 *  ⑭ 控制器真 HTTP（POST 200 / 401 / 15002⇒404 / 15006⇒409；不用 fetch——假红族⑤纪律）；
 *  ⑮ **循环⑧ `replayUnknown`（v1.1.4 §3.3 未知结果收敛）**：候选谓词（approved+标记+72h 窗）·
 *     重放成功 ⇒ `refunded`（锚原样/零货币动作）· 明确 ⇒ 去前缀停自动 · 未知 ⇒ 刷新标记（缀时刻）·
 *     超 72h 停自动 · CAS 失手。
 *
 * 夹具：**假 DataSource**（精确形状识别 + 锁等待链；SQL 一漂移就当场红）· 假 currency 客户端
 * （`apply` 可编程回执 + `withdrawable` 可编程失败）· 假渠道（`refund` 可编程回执）。
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
  REFUND_PREFIX,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type CurrencyWithdrawableGetResponse,
} from '@fight-the-landlord/protocol';
import type { PayRefundApplyResponse } from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import { AlipayClient, CHANNEL_CONFIG_ERROR, RESPONSE_VERIFY_FAILED } from '../src/channel/alipay/client';
import type {
  ChannelFailure,
  ChannelResult,
  PaymentChannel,
  RefundData,
  RefundRequest,
} from '../src/channel/payment-channel.interface';
import { DomainError, HTTP_STATUS } from '../src/http/errors';
import { LOCK_INSERT_IGNORE_SQL, LOCK_SELECT_FOR_UPDATE_SQL, UserLockService } from '../src/locks/user-lock.service';
import {
  paymentFundopOldestAgeSeconds,
  paymentFundopPending,
  paymentFundopRetryTotal,
  paymentRefundTotal,
} from '../src/metrics/payment.metrics';
import {
  classifyChannelFailure,
  INSERT_REFUND_SQL,
  REFUND_APPROVE_SQL,
  REFUND_CHANNEL_LAST_ERROR_SQL,
  REFUND_FUNDOP_STATS_SQL,
  REFUND_HOLD_TO_FAILED_SQL,
  REFUND_HOLD_TO_PENDING_SQL,
  REFUND_REJECT_CLAIM_SQL,
  REFUND_RETRY_BACKOFF_MS,
  REFUND_ROLLBACK_LAST_ERROR_SQL,
  REFUND_ROLLBACK_TO_REJECTED_SQL,
  REFUND_TO_REFUNDED_SQL,
  REFUND_UNKNOWN_MARKER,
  RefundService,
  SELECT_APPROVED_UNKNOWN_SQL,
  SELECT_ORDER_ACTIVE_REFUND_SQL,
  SELECT_ORDER_FOR_REFUND_SQL,
  SELECT_REFUND_HOLDING_SQL,
  SELECT_REFUND_STATUS_SQL,
  SELECT_REFUND_TARGET_SQL,
  SELECT_REJECTING_SQL,
  generateRefundNo,
} from '../src/refund/refund.service';
import { RefundController } from '../src/refund/refund.controller';
import { CurrencyRpcClient, CurrencyServiceError } from '../src/rpc/currency.client';
import { UNRESOLVED_HOLDING_SQL } from '../src/withdraw/withdraw.service';

const USER = 'user-t11-0001';
const OTHER_USER = 'user-t11-0002';
const ADMIN = 'admin-finance-01';

/* ======================================================================== *
 * ① SQL 常量全文钉（规格 §3.3/§3.4/§2.2.1/⚙️15 逐字）
 * ======================================================================== */
describe('① SQL 常量全文钉（规格 §3.3 状态机逐字；单测钉全字符）', () => {
  it('该单读（本人；申请第一检）与槽检查（order_no + active_slot=1）', () => {
    expect(SELECT_ORDER_FOR_REFUND_SQL).toBe(
      'SELECT `coins`, `amount_fen`, `status` FROM `payment_orders` WHERE `order_no` = ? AND `user_id` = ?',
    );
    expect(SELECT_ORDER_ACTIVE_REFUND_SQL).toBe(
      'SELECT `refund_no`, `status` FROM `payment_refunds` WHERE `order_no` = ? AND `active_slot` = 1',
    );
  });

  it('申请插行：holding + active_slot=1；`channel_out_request_no` = refund_no（§3.3 逐字）', () => {
    expect(INSERT_REFUND_SQL).toBe(
      'INSERT INTO `payment_refunds` (`refund_no`, `order_no`, `user_id`, `amount_fen`, `coins`, `reason`, `channel_out_request_no`, `active_slot`) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    );
  });

  it('解析落账：holding→pending（记 hold_confirmed_at）/ holding→failed（释槽 + last_error）', () => {
    expect(REFUND_HOLD_TO_PENDING_SQL).toBe(
      "UPDATE `payment_refunds` SET `status`='pending', `hold_confirmed_at`=NOW(3) WHERE `refund_no`=? AND `status`='holding'",
    );
    expect(REFUND_HOLD_TO_FAILED_SQL).toBe(
      "UPDATE `payment_refunds` SET `status`='failed', `active_slot`=NULL, `last_error`=? WHERE `refund_no`=? AND `status`='holding'",
    );
  });

  it('审通过 claim（pending→approved，记审者）；审驳回 claim（pending|approved→rejecting）', () => {
    expect(REFUND_APPROVE_SQL).toBe(
      "UPDATE `payment_refunds` SET `status`='approved', `reviewed_by`=?, `reviewed_at`=NOW(3), `review_note`=? WHERE `refund_no`=? AND `status`='pending'",
    );
    expect(REFUND_REJECT_CLAIM_SQL).toBe(
      "UPDATE `payment_refunds` SET `status`='rejecting', `reviewed_by`=?, `reviewed_at`=NOW(3), `review_note`=? WHERE `refund_no`=? AND `status` IN ('pending','approved')",
    );
  });

  it('渠道成功落账（approved→refunded；**保留槽**——不写 active_slot）与渠道停的 last_error（带 approved 守卫）', () => {
    expect(REFUND_TO_REFUNDED_SQL).toBe(
      "UPDATE `payment_refunds` SET `status`='refunded', `channel_refund_no`=?, `refunded_at`=NOW(3) WHERE `refund_no`=? AND `status`='approved'",
    );
    expect(REFUND_CHANNEL_LAST_ERROR_SQL).toBe(
      "UPDATE `payment_refunds` SET `last_error`=? WHERE `refund_no`=? AND `status`='approved'",
    );
  });

  it('回滚落账（rejecting→rejected；释槽）与回滚 last_error（无守卫——回滚/冲突两用）', () => {
    expect(REFUND_ROLLBACK_TO_REJECTED_SQL).toBe(
      "UPDATE `payment_refunds` SET `status`='rejected', `active_slot`=NULL WHERE `refund_no`=? AND `status`='rejecting'",
    );
    expect(REFUND_ROLLBACK_LAST_ERROR_SQL).toBe('UPDATE `payment_refunds` SET `last_error`=? WHERE `refund_no`=?');
  });

  it('扫描候选：循环⑥ holding（先老后新）/ 循环⑦ rejecting（「已 claim 未落账」集合）', () => {
    expect(SELECT_REFUND_HOLDING_SQL).toBe(
      "SELECT `refund_no`, `user_id`, `coins` FROM `payment_refunds` WHERE `status` = 'holding' ORDER BY `created_at` ASC, `id` ASC",
    );
    expect(SELECT_REJECTING_SQL).toBe(
      "SELECT `refund_no`, `user_id`, `coins` FROM `payment_refunds` WHERE `status` = 'rejecting' ORDER BY `created_at` ASC, `id` ASC",
    );
  });

  it('循环⑧候选（v1.1.4 §3.3 未知结果收敛）：approved + `unknown:` 标记 + reviewed_at 72h 窗内', () => {
    expect(SELECT_APPROVED_UNKNOWN_SQL).toBe(
      "SELECT `refund_no`, `order_no`, `amount_fen`, `reason`, `channel_out_request_no` FROM `payment_refunds` WHERE `status` = 'approved' AND `last_error` LIKE 'unknown:%' AND `reviewed_at` > NOW(3) - INTERVAL 72 HOUR ORDER BY `created_at` ASC, `id` ASC",
    );
    expect(REFUND_UNKNOWN_MARKER).toBe('unknown:');
  });

  it('单行读（渠道调用素材）与现状读（15009 message 素材）', () => {
    expect(SELECT_REFUND_TARGET_SQL).toBe(
      'SELECT `refund_no`, `order_no`, `user_id`, `coins`, `amount_fen`, `reason`, `channel_out_request_no` FROM `payment_refunds` WHERE `refund_no` = ?',
    );
    expect(SELECT_REFUND_STATUS_SQL).toBe('SELECT `status` FROM `payment_refunds` WHERE `refund_no` = ?');
  });

  it('未解析 holding 占位 = T10 常量复用（提现/退款任一；不复制第二份）', () => {
    expect(UNRESOLVED_HOLDING_SQL).toBe(
      "SELECT `withdraw_no` AS `no` FROM `payment_withdrawals` WHERE `user_id` = ? AND `status` = 'holding' UNION ALL SELECT `refund_no` AS `no` FROM `payment_refunds` WHERE `user_id` = ? AND `status` = 'holding' LIMIT 1",
    );
  });

  it('fundop 统计读（refund_hold/refund_rb 两标签；UNION ALL 恒两行）', () => {
    expect(REFUND_FUNDOP_STATS_SQL).toBe(
      "SELECT 'refund_hold' AS `op`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_refunds` WHERE `status` = 'holding' UNION ALL SELECT 'refund_rb' AS `op`, COUNT(*) AS `cnt`, COALESCE(TIMESTAMPDIFF(SECOND, MIN(`created_at`), NOW(3)), 0) AS `oldest` FROM `payment_refunds` WHERE `status` = 'rejecting'",
    );
  });

  it('出站退避表（设计 §2.5：trade.refund 1s→5s→30s→2m→10m；初始 1 发 + 退避重试 5 发 = 上限 6 发）', () => {
    expect(REFUND_RETRY_BACKOFF_MS).toEqual([1_000, 5_000, 30_000, 120_000, 600_000]);
  });
});

/* ======================================================================== *
 * ② ⚙️4 单号形状
 * ======================================================================== */
describe('② ⚙️4 单号形状（rf_ + base36(ms) + 6 随机）', () => {
  it('形状：前缀 rf_、字符集 [0-9a-z_]、长 ≤ 32、含 base36 时间戳段；两次生成不相等', () => {
    const fixed = generateRefundNo(1_793_900_000_000);
    expect(fixed.startsWith(REFUND_PREFIX)).toBe(true);
    expect(fixed).toMatch(/^rf_[0-9a-z]+$/);
    expect(fixed.length).toBeLessThanOrEqual(32);
    expect(fixed).toContain((1_793_900_000_000).toString(36));

    const a = generateRefundNo();
    const b = generateRefundNo();
    expect(a).toMatch(/^rf_[0-9a-z]+$/);
    expect(a).not.toBe(b);
  });
});

/* ======================================================================== *
 * 夹具
 * ======================================================================== */

interface FakeOrderRow {
  id: number;
  order_no: string;
  user_id: string;
  coins: number;
  amount_fen: number;
  status: string;
  created_at: Date;
}

interface FakeRefundRow {
  id: number;
  refund_no: string;
  order_no: string;
  user_id: string;
  amount_fen: number;
  coins: number;
  status: string;
  reason: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  channel_out_request_no: string;
  channel_refund_no: string | null;
  hold_confirmed_at: Date | null;
  refunded_at: Date | null;
  last_error: string | null;
  active_slot: number | null;
  created_at: Date;
  updated_at: Date;
}

interface FakeWithdrawHoldingRow {
  withdraw_no: string;
  user_id: string;
  status: string;
}

/**
 * 假 DataSource：识别全部 SQL 常量**精确形状**（一漂移即「未识别的 SQL」当场红）；
 * `transaction()` 供 `withUserLock`（INSERT IGNORE → FOR UPDATE 等待链，照 locks.test.ts）。
 */
class FakeRefundDb {
  now = new Date('2026-10-06T04:00:00.000Z'); // = +08:00 2026-10-06 12:00
  orders: FakeOrderRow[] = [];
  rows: FakeRefundRow[] = [];
  withdrawals: FakeWithdrawHoldingRow[] = [];
  readonly lockRows = new Set<string>();
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  /** 注入点：>0 ⇒ 下一次 INSERT 报 refund_no 撞 UK（模拟单号碰撞，验重生成重试）。 */
  noDupInjections = 0;
  /** 注入点：>0 ⇒ 下一次槽预检「看不见」在途行（模拟毫秒竞态面，验 UK 兜底）。 */
  blindSlotChecks = 0;
  private nextId = 1;
  private readonly tail = new Map<string, Promise<void>>();

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  seedOrder(over: Partial<FakeOrderRow> = {}): FakeOrderRow {
    const id = this.nextId++;
    const row: FakeOrderRow = {
      id,
      order_no: over.order_no ?? `pay_t11o${String(id).padStart(4, '0')}`,
      user_id: USER,
      coins: 600,
      amount_fen: 600,
      status: 'credited',
      created_at: new Date(this.now.getTime() - 3_600_000),
      ...over,
    };
    this.orders.push(row);
    return row;
  }

  seedRefund(over: Partial<FakeRefundRow> = {}): FakeRefundRow {
    const id = this.nextId++;
    const refund_no = over.refund_no ?? `rf_seed${String(id).padStart(4, '0')}`;
    const row: FakeRefundRow = {
      id,
      refund_no,
      order_no: over.order_no ?? `pay_t11o${String(id).padStart(4, '0')}`,
      user_id: USER,
      amount_fen: 600,
      coins: 600,
      status: 'pending',
      reason: '测试退款',
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      channel_out_request_no: refund_no,
      channel_refund_no: null,
      hold_confirmed_at: over.hold_confirmed_at !== undefined ? over.hold_confirmed_at : null,
      refunded_at: null,
      last_error: null,
      active_slot: 1,
      created_at: new Date(this.now.getTime() - 60_000),
      updated_at: this.now,
      ...over,
    };
    // 释放槽的两终态（rejected/failed）按 ⚙️15 恒 NULL；refunded **保留 1**（结构标记）。
    if (['rejected', 'failed'].includes(row.status) && over.active_slot === undefined) row.active_slot = null;
    if (row.status === 'refunded' && over.active_slot === undefined) row.active_slot = 1;
    this.rows.push(row);
    return row;
  }

  /** SQL 造提现 `holding` 行（跨面占位用例）。 */
  seedWithdrawHolding(withdraw_no = 'wd_hold_0001', userId = USER): FakeWithdrawHoldingRow {
    const row: FakeWithdrawHoldingRow = { withdraw_no, user_id: userId, status: 'holding' };
    this.withdrawals.push(row);
    return row;
  }

  private core(sql: string, params: unknown[]): unknown {
    this.queries.push({ sql, params });
    const nowMs = this.now.getTime();
    const refundBy = (no: unknown): FakeRefundRow | undefined => this.rows.find((r) => r.refund_no === no);

    switch (sql) {
      case SELECT_ORDER_FOR_REFUND_SQL: {
        const order = this.orders.find((o) => o.order_no === params[0] && o.user_id === params[1]);
        return order ? [{ coins: order.coins, amount_fen: order.amount_fen, status: order.status }] : [];
      }
      case SELECT_ORDER_ACTIVE_REFUND_SQL: {
        if (this.blindSlotChecks > 0) {
          this.blindSlotChecks -= 1;
          return [];
        }
        const hit = this.rows.find((r) => r.order_no === params[0] && r.active_slot === 1);
        return hit ? [{ refund_no: hit.refund_no, status: hit.status }] : [];
      }
      case UNRESOLVED_HOLDING_SQL: {
        const hit =
          this.withdrawals.some((r) => r.user_id === params[0] && r.status === 'holding') ||
          this.rows.some((r) => r.user_id === params[1] && r.status === 'holding');
        return hit ? [{ no: 'hold' }] : [];
      }
      case INSERT_REFUND_SQL: {
        if (this.noDupInjections > 0) {
          this.noDupInjections -= 1;
          throw Object.assign(new Error("Duplicate entry 'rf_x' for key 'payment_refunds.uk_refund_no'"), {
            code: 'ER_DUP_ENTRY',
            errno: 1062,
          });
        }
        const [refund_no, order_no, user_id, amount_fen, coins, reason, out_request_no] = params;
        if (this.rows.some((r) => r.refund_no === refund_no)) {
          throw Object.assign(
            new Error(`Duplicate entry '${String(refund_no)}' for key 'payment_refunds.uk_refund_no'`),
            { code: 'ER_DUP_ENTRY', errno: 1062 },
          );
        }
        if (this.rows.some((r) => r.order_no === order_no && r.active_slot === 1)) {
          throw Object.assign(
            new Error(`Duplicate entry '${String(order_no)}-1' for key 'payment_refunds.uk_refunds_order_active'`),
            { code: 'ER_DUP_ENTRY', errno: 1062 },
          );
        }
        const id = this.nextId++;
        this.rows.push({
          id,
          refund_no: String(refund_no),
          order_no: String(order_no),
          user_id: String(user_id),
          amount_fen: Number(amount_fen),
          coins: Number(coins),
          status: 'holding',
          reason: String(reason),
          reviewed_by: null,
          reviewed_at: null,
          review_note: null,
          channel_out_request_no: String(out_request_no),
          channel_refund_no: null,
          hold_confirmed_at: null,
          refunded_at: null,
          last_error: null,
          active_slot: 1,
          created_at: new Date(nowMs),
          updated_at: new Date(nowMs),
        });
        return { affectedRows: 1 };
      }
      case REFUND_HOLD_TO_PENDING_SQL: {
        const row = refundBy(params[0]);
        if (!row || row.status !== 'holding') return { affectedRows: 0 };
        row.status = 'pending';
        row.hold_confirmed_at = new Date(nowMs);
        return { affectedRows: 1 };
      }
      case REFUND_HOLD_TO_FAILED_SQL: {
        const row = refundBy(params[1]);
        if (!row || row.status !== 'holding') return { affectedRows: 0 };
        row.status = 'failed';
        row.active_slot = null;
        row.last_error = params[0] === null ? null : String(params[0]);
        return { affectedRows: 1 };
      }
      case REFUND_APPROVE_SQL: {
        const row = refundBy(params[2]);
        if (!row || row.status !== 'pending') return { affectedRows: 0 };
        row.status = 'approved';
        row.reviewed_by = String(params[0]);
        row.reviewed_at = new Date(nowMs);
        row.review_note = params[1] === null ? null : String(params[1]);
        return { affectedRows: 1 };
      }
      case REFUND_REJECT_CLAIM_SQL: {
        const row = refundBy(params[2]);
        if (!row || !['pending', 'approved'].includes(row.status)) return { affectedRows: 0 };
        row.status = 'rejecting';
        row.reviewed_by = String(params[0]);
        row.reviewed_at = new Date(nowMs);
        row.review_note = params[1] === null ? null : String(params[1]);
        return { affectedRows: 1 };
      }
      case REFUND_TO_REFUNDED_SQL: {
        const row = refundBy(params[1]);
        if (!row || row.status !== 'approved') return { affectedRows: 0 };
        row.status = 'refunded';
        row.channel_refund_no = params[0] === null ? null : String(params[0]);
        row.refunded_at = new Date(nowMs);
        // **保留槽**：不写 active_slot（⚙️15 结构标记）。
        return { affectedRows: 1 };
      }
      case REFUND_CHANNEL_LAST_ERROR_SQL: {
        const row = refundBy(params[1]);
        if (!row || row.status !== 'approved') return { affectedRows: 0 };
        row.last_error = params[0] === null ? null : String(params[0]);
        return { affectedRows: 1 };
      }
      case REFUND_ROLLBACK_TO_REJECTED_SQL: {
        const row = refundBy(params[0]);
        if (!row || row.status !== 'rejecting') return { affectedRows: 0 };
        row.status = 'rejected';
        row.active_slot = null;
        return { affectedRows: 1 };
      }
      case REFUND_ROLLBACK_LAST_ERROR_SQL: {
        const row = refundBy(params[1]);
        if (!row) return { affectedRows: 0 };
        row.last_error = params[0] === null ? null : String(params[0]);
        return { affectedRows: 1 };
      }
      case SELECT_REFUND_HOLDING_SQL: {
        return this.rows
          .filter((r) => r.status === 'holding')
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id - b.id)
          .map((r) => ({ refund_no: r.refund_no, user_id: r.user_id, coins: r.coins }));
      }
      case SELECT_REJECTING_SQL: {
        return this.rows
          .filter((r) => r.status === 'rejecting')
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id - b.id)
          .map((r) => ({ refund_no: r.refund_no, user_id: r.user_id, coins: r.coins }));
      }
      case SELECT_APPROVED_UNKNOWN_SQL: {
        // 与真 SQL 同向：approved + `unknown:%` + reviewed_at 72h 窗内（NULL 自然排除）。
        return this.rows
          .filter(
            (r) =>
              r.status === 'approved' &&
              typeof r.last_error === 'string' &&
              r.last_error.startsWith('unknown:') &&
              r.reviewed_at !== null &&
              r.reviewed_at.getTime() > nowMs - 72 * 3_600_000,
          )
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id - b.id)
          .map((r) => ({
            refund_no: r.refund_no,
            order_no: r.order_no,
            amount_fen: r.amount_fen,
            reason: r.reason,
            channel_out_request_no: r.channel_out_request_no,
          }));
      }
      case SELECT_REFUND_TARGET_SQL: {
        const row = refundBy(params[0]);
        return row
          ? [
              {
                refund_no: row.refund_no,
                order_no: row.order_no,
                user_id: row.user_id,
                coins: row.coins,
                amount_fen: row.amount_fen,
                reason: row.reason,
                channel_out_request_no: row.channel_out_request_no,
              },
            ]
          : [];
      }
      case SELECT_REFUND_STATUS_SQL: {
        const row = refundBy(params[0]);
        return row ? [{ status: row.status }] : [];
      }
      case REFUND_FUNDOP_STATS_SQL: {
        const holdRows = this.rows.filter((r) => r.status === 'holding');
        const rbRows = this.rows.filter((r) => r.status === 'rejecting');
        const stat = (rows: FakeRefundRow[]) =>
          rows.length === 0
            ? { cnt: 0, oldest: 0 }
            : {
                cnt: rows.length,
                oldest: Math.max(0, Math.floor((nowMs - Math.min(...rows.map((r) => r.created_at.getTime()))) / 1000)),
              };
        return [
          { op: 'refund_hold', ...stat(holdRows) },
          { op: 'refund_rb', ...stat(rbRows) },
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
  const withdrawable = vi.fn(over.withdrawable ?? (async () => ({ cap: 1_000_000, balance: 1_000_000 })));
  return { client: { apply, withdrawable } as unknown as CurrencyRpcClient, apply, withdrawable };
}

const okRefund = (tradeNo = '2026100622001688'): ChannelResult<RefundData> => ({
  ok: true,
  data: { tradeNo, fundChange: true },
});

function makeChannel(over: { refund?: (req: RefundRequest) => Promise<ChannelResult<RefundData>> } = {}) {
  const refund = vi.fn(over.refund ?? (async () => okRefund()));
  return { channel: { refund } as unknown as PaymentChannel, refund };
}

function makeService(
  db: FakeRefundDb,
  client: CurrencyRpcClient = makeClient().client,
  channel: PaymentChannel = makeChannel().channel,
): RefundService {
  return new RefundService(db.dataSource, client, new UserLockService(db.dataSource), channel);
}

/** 指标读数（各自直读——与 withdraw/scan 套件同式）。 */
const refundTotal = async (result: string): Promise<number | undefined> =>
  (await paymentRefundTotal.get()).values.find((v) => v.labels.result === result)?.value;
const fundopPending = async (op: string): Promise<number | undefined> =>
  (await paymentFundopPending.get()).values.find((v) => v.labels.op === op)?.value;
const fundopOldest = async (op: string): Promise<number | undefined> =>
  (await paymentFundopOldestAgeSeconds.get()).values.find((v) => v.labels.op === op)?.value;
const fundopRetry = async (op: string): Promise<number | undefined> =>
  (await paymentFundopRetryTotal.get()).values.find((v) => v.labels.op === op)?.value;

beforeEach(() => {
  paymentRefundTotal.reset();
  paymentFundopPending.reset();
  paymentFundopOldestAgeSeconds.reset();
  paymentFundopRetryTotal.reset();
});

/* ======================================================================== *
 * ③ apply 正例全链
 * ======================================================================== */
describe('③ apply 正例：锁内三段（校验→插行→冻结）', () => {
  it('全链：语句序 = 锁 → 该单读 → 槽检 → holding 占位查 → INSERT(holding,slot=1) → apply 冻结 → holding→pending；响应 pending', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder({ coins: 600, amount_fen: 600 });
    const { client, apply, withdrawable } = makeClient();
    const svc = makeService(db, client);

    const res = await svc.apply(USER, { orderNo: order.order_no, reason: '三块钱不想充了' });
    const no = res.refundNo;

    expect(res).toEqual({ refundNo: no, status: 'pending' });
    expect(no).toMatch(/^rf_[0-9a-z]+$/);

    // 语句序（锁内三段全程在场的机械证）：锁 → 该单 → 槽 → 占位 → INSERT → 落账更新 → 统计刷。
    const inner = db.queries.map((q) => q.sql);
    expect(inner).toEqual([
      LOCK_INSERT_IGNORE_SQL,
      LOCK_SELECT_FOR_UPDATE_SQL,
      SELECT_ORDER_FOR_REFUND_SQL,
      SELECT_ORDER_ACTIVE_REFUND_SQL,
      UNRESOLVED_HOLDING_SQL,
      INSERT_REFUND_SQL,
      REFUND_HOLD_TO_PENDING_SQL,
      REFUND_FUNDOP_STATS_SQL,
    ]);
    expect(db.queries[0]!.params).toEqual([USER]);
    expect(db.queries[1]!.params).toEqual([USER]);
    expect(db.queries[2]!.params).toEqual([order.order_no, USER]);
    expect(db.queries[3]!.params).toEqual([order.order_no]);
    expect(db.queries[4]!.params).toEqual([USER, USER]);
    // INSERT 参数逐字：单号/订单/用户/分（同单快照）/币/理由/**channel_out_request_no = 单号**（§3.3）。
    expect(db.queries[5]!.params).toEqual([no, order.order_no, USER, 600, 600, '三块钱不想充了', no]);

    // 冻结 RPC：锚先于落账、source/refId/entries 逐字、负 delta。
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `refund:${no}`,
      source: 'refund_hold',
      refId: no,
      entries: [{ ownerId: USER, delta: -600 }],
    });
    // cap 取数在**资金动作时刻**（锁内）：每笔申请各读一次（禁缓存、禁只查一次）。
    expect(withdrawable).toHaveBeenCalledTimes(1);
    expect(withdrawable.mock.calls[0]![0]).toEqual({ ownerId: USER });

    const row = db.rows[0]!;
    expect(row.status).toBe('pending');
    expect(row.active_slot).toBe(1);
    expect(row.hold_confirmed_at).toEqual(db.now);
    expect(row.channel_out_request_no).toBe(no);
    expect(row.amount_fen).toBe(600);
    expect(row.coins).toBe(600);
    // §2.6·6 写点：申请受理恰计一次。
    expect(await refundTotal('applied')).toBe(1);
  });

  it('amount_fen = 订单行同单快照（不是现算——后续改配置不影响）', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder({ coins: 333, amount_fen: 333 });
    const svc = makeService(db);

    await svc.apply(USER, { orderNo: order.order_no, reason: 'r' });
    expect(db.rows[0]!.amount_fen).toBe(333);
    expect(db.rows[0]!.coins).toBe(333);
  });

  it('单号撞 UK（uk_refund_no）⇒ 换号重试（成功落第二号；两次生成不同）', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    db.noDupInjections = 1; // 第一次 INSERT 报撞键（模拟碰撞）
    const svc = makeService(db);

    const res = await svc.apply(USER, { orderNo: order.order_no, reason: 'r' });
    const inserts = db.queries.filter((q) => q.sql === INSERT_REFUND_SQL);
    expect(inserts).toHaveLength(2);
    expect(inserts[1]!.params[0]).not.toBe(inserts[0]!.params[0]);
    expect(res.refundNo).toBe(inserts[1]!.params[0]);
    expect(db.rows).toHaveLength(1);
  });
});

/* ======================================================================== *
 * ④ 校验清单逐字（负例）
 * ======================================================================== */
describe('④ 校验清单逐字负例（§3.3：order 未入账 → 槽 → cap → 占位）', () => {
  const rejects = async (
    svc: RefundService,
    orderNo: unknown,
    code: ErrCode,
    message: string,
  ): Promise<void> => {
    await expect(svc.apply(USER, { orderNo, reason: '想退' })).rejects.toMatchObject({ code, message });
  };

  it('入参形状（锁前）：orderNo 非串/空/超 32；reason 非串/空/超 255 ⇒ 10001（零语句）', async () => {
    const db = new FakeRefundDb();
    const svc = makeService(db);

    for (const bad of [undefined, '', 'x'.repeat(33), 12345, null]) {
      await expect(svc.apply(USER, { orderNo: bad, reason: 'r' })).rejects.toMatchObject({
        code: ErrCode.BAD_PARAM,
      });
    }
    for (const bad of [undefined, '', 'x'.repeat(256), 42, null]) {
      await expect(svc.apply(USER, { orderNo: 'pay_x1', reason: bad })).rejects.toMatchObject({
        code: ErrCode.BAD_PARAM,
      });
    }
    expect(db.queries).toHaveLength(0); // 形状校验先于锁
  });

  it('订单不存在 / 非本人 ⇒ 15002「订单不存在或已失效」（锁在检前——每次恰 [锁,锁,该单读]；零行落库）', async () => {
    const db = new FakeRefundDb();
    db.seedOrder({ order_no: 'pay_other', user_id: OTHER_USER });
    const { client, apply } = makeClient();
    const svc = makeService(db, client);

    await rejects(svc, 'pay_missing', ErrCode.PAY_ORDER_NOT_FOUND, '订单不存在或已失效');
    await rejects(svc, 'pay_other', ErrCode.PAY_ORDER_NOT_FOUND, '订单不存在或已失效');
    expect(db.queries.map((q) => q.sql)).toEqual([
      LOCK_INSERT_IGNORE_SQL,
      LOCK_SELECT_FOR_UPDATE_SQL,
      SELECT_ORDER_FOR_REFUND_SQL,
      LOCK_INSERT_IGNORE_SQL,
      LOCK_SELECT_FOR_UPDATE_SQL,
      SELECT_ORDER_FOR_REFUND_SQL,
    ]);
    expect(db.rows).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('未入账（created/paid/closed）⇒ 15006「未入账」；credited 放行', async () => {
    const db = new FakeRefundDb();
    const created = db.seedOrder({ status: 'created' });
    const paid = db.seedOrder({ status: 'paid' });
    const closed = db.seedOrder({ status: 'closed' });
    const svc = makeService(db);

    for (const order of [created, paid, closed]) {
      await rejects(svc, order.order_no, ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（未入账）');
    }
    expect(db.rows).toHaveLength(0);

    const credited = db.seedOrder({ status: 'credited' });
    expect((await svc.apply(USER, { orderNo: credited.order_no, reason: 'r' })).status).toBe('pending');
  });

  it('槽：该单已有在途/已退行 ⇒ 15006「处理中」/「已退过」（pre-check 面）', async () => {
    const db = new FakeRefundDb();
    const inflight = db.seedOrder();
    db.seedRefund({ order_no: inflight.order_no, status: 'pending', active_slot: 1 });
    const done = db.seedOrder();
    db.seedRefund({ order_no: done.order_no, status: 'refunded', active_slot: 1 });
    const svc = makeService(db);

    await rejects(svc, inflight.order_no, ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（处理中）');
    await rejects(svc, done.order_no, ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（已退过）');
    expect(db.rows).toHaveLength(2); // 未新增
  });

  it('槽 UK 竞态（预检盲一瞬）⇒ INSERT 撞 uk_refunds_order_active ⇒ 15006「处理中」（结构兜底）', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    db.seedRefund({ order_no: order.order_no, status: 'approved', active_slot: 1 });
    db.blindSlotChecks = 1; // 预检看不见 ⇒ 由 UK 兜底
    const { client, apply } = makeClient();
    const svc = makeService(db, client);

    await rejects(svc, order.order_no, ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（处理中）');
    expect(apply).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
  });

  it('cap 不足 ⇒ 15006「超出可退额度」（= cap 放行；cap 来自 RPC 此刻读数）', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder({ coins: 600 });
    const { client, withdrawable } = makeClient({
      withdrawable: async () => ({ cap: 599, balance: 50_000 }),
    });
    const svc = makeService(db, client);

    await rejects(svc, order.order_no, ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（超出可退额度）');
    expect(withdrawable).toHaveBeenCalledTimes(1); // 失败面也已在动作时刻取数

    const { client: client2, withdrawable: withdrawable2 } = makeClient({
      withdrawable: async () => ({ cap: 600, balance: 50_000 }),
    });
    const svc2 = makeService(db, client2);
    expect((await svc2.apply(USER, { orderNo: order.order_no, reason: 'r' })).status).toBe('pending');
    expect(withdrawable2).toHaveBeenCalledTimes(1); // 第二笔**再次**取数（禁缓存、禁只查一次）
  });

  it('未解析 holding 占位：**SQL 造提现 holding 行** ⇒ 15006「有处理中申请，请稍后重试」（跨面占位）', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    db.seedWithdrawHolding('wd_cross_0001', USER);
    const { client, apply } = makeClient();
    const svc = makeService(db, client);

    await rejects(svc, order.order_no, ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（有处理中申请，请稍后重试）');
    expect(apply).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(0);
  });

  it('未解析 holding 占位：本人的**退款** holding 行（另一单）同样拒；他用户的 holding 不算', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    db.seedRefund({ refund_no: 'rf_hold_other_order', order_no: 'pay_other_order', status: 'holding', active_slot: 1 });
    const svc = makeService(db);

    await rejects(svc, order.order_no, ErrCode.PAY_REFUND_UNAVAILABLE, '该笔充值暂不可退（有处理中申请，请稍后重试）');

    const db2 = new FakeRefundDb();
    const order2 = db2.seedOrder();
    db2.seedRefund({ user_id: OTHER_USER, order_no: 'pay_otherb', status: 'holding', active_slot: 1 });
    const svc2 = makeService(db2);
    expect((await svc2.apply(USER, { orderNo: order2.order_no, reason: 'r' })).status).toBe('pending');
  });
});

/* ======================================================================== *
 * ⑤ cap RPC fail-closed 专测
 * ======================================================================== */
describe('⑤ cap RPC fail-closed（§2.2.1：不确定不放松；15006 变体）', () => {
  it('RPC 超时/传输失败 ⇒ 15006「服务暂时不可用，请稍后重试」变体；零行落库、零 apply', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    const { client, apply } = makeClient({
      withdrawable: async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
      },
    });
    const svc = makeService(db, client);

    await expect(svc.apply(USER, { orderNo: order.order_no, reason: 'r' })).rejects.toMatchObject({
      code: ErrCode.PAY_REFUND_UNAVAILABLE,
      message: '该笔充值暂不可退（服务暂时不可用，请稍后重试）',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(0);
  });
});

/* ======================================================================== *
 * ⑥ hold 三态（永不回滚）
 * ======================================================================== */
describe('⑥ apply 的 hold 三态（§2.5）：成功⇒pending / 明确失败⇒failed+释槽 / 未知⇒停留 holding', () => {
  it('明确失败（14001）⇒ failed + 释槽 + last_error 摘要；锚不是 rb（零 refund_rb）', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    const { client, apply } = makeClient({
      apply: async () => {
        throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'ownerId=u 余额不足：整批回滚（delta=-600）');
      },
    });
    const svc = makeService(db, client);

    const res = await svc.apply(USER, { orderNo: order.order_no, reason: 'r' });
    expect(res.status).toBe('failed');
    const row = db.rows[0]!;
    expect(row.status).toBe('failed');
    expect(row.active_slot).toBeNull();
    expect(row.last_error).toBe('ownerId=u 余额不足：整批回滚（delta=-600）');
    expect(apply.mock.calls.every((c) => String(c[0]!.actionId).startsWith('refund:'))).toBe(true);
    expect(await refundTotal('applied')).toBe(1); // 申请动作发生过（行已留档）

    // 释槽后（故障解除）可再申请 ⇒ 新单号、新锚（⚙️15）。
    const ok = makeService(db, makeClient().client);
    const again = await ok.apply(USER, { orderNo: order.order_no, reason: 'r2' });
    expect(again.status).toBe('pending');
    expect(again.refundNo).not.toBe(res.refundNo);
    const anchors = new Set(db.rows.map((r) => `refund:${r.refund_no}`));
    expect(anchors.size).toBe(2); // 旧锚（failed 行）与新锚（pending 行）并存
  });

  it('结果未知 ⇒ 停留 holding（不改终态/不写 last_error）；锚形 refund:<no>', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    const { client, apply } = makeClient({
      apply: async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
      },
    });
    const svc = makeService(db, client);

    const res = await svc.apply(USER, { orderNo: order.order_no, reason: 'r' });
    expect(res.status).toBe('holding');
    const row = db.rows[0]!;
    expect(row.status).toBe('holding');
    expect(row.active_slot).toBe(1);
    expect(row.last_error).toBeNull(); // 写点清单不含「未知」
    expect(apply.mock.calls[0]![0].actionId).toBe(`refund:${res.refundNo}`);
  });
});

/* ======================================================================== *
 * ⑦ 解析循环⑥（永不回滚）
 * ======================================================================== */
describe('⑦ resolveHolding（循环⑥）：holding 只解析（成功/明确失败/未知）——**永不发 refund_rb**', () => {
  it('同锚解出成功 ⇒ pending + hold_confirmed_at；重试面计数 +1（循环内 = 重放）', async () => {
    const db = new FakeRefundDb();
    const row = db.seedRefund({ status: 'holding', coins: 600, active_slot: 1 });
    const { client, apply } = makeClient();
    const svc = makeService(db, client);

    expect(await svc.resolveHolding()).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.hold_confirmed_at).toEqual(db.now);
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `refund:${row.refund_no}`,
      source: 'refund_hold',
      refId: row.refund_no,
      entries: [{ ownerId: USER, delta: -600 }],
    });
    expect(await fundopRetry('refund_hold')).toBe(1);

    // 第二轮：行已 pending（不在 holding 候选）⇒ 0、零新 RPC
    expect(await svc.resolveHolding()).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('明确失败（14001）⇒ failed + 释槽 + last_error 摘要；**零 refund_rb**', async () => {
    const db = new FakeRefundDb();
    const row = db.seedRefund({ status: 'holding', active_slot: 1 });
    const { client, apply } = makeClient({
      apply: async () => {
        throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'mock 余额不足');
      },
    });
    const svc = makeService(db, client);

    expect(await svc.resolveHolding()).toBe(1);
    expect(row.status).toBe('failed');
    expect(row.active_slot).toBeNull();
    expect(row.last_error).toBe('mock 余额不足');
    expect(apply.mock.calls.every((c) => String(c[0]!.actionId).startsWith('refund:'))).toBe(true);
  });

  it('结果未知 ⇒ 停留 holding（不改终态/不写 last_error）；下轮同锚重放收敛', async () => {
    const db = new FakeRefundDb();
    const row = db.seedRefund({ status: 'holding', created_at: new Date(db.now.getTime() - 1_200_000) });
    let fail = true;
    const { client, apply } = makeClient({
      apply: async (req) => {
        if (fail) throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
        return okApplyData(req);
      },
    });
    const svc = makeService(db, client);

    expect(await svc.resolveHolding()).toBe(0);
    expect(row.status).toBe('holding');
    expect(row.hold_confirmed_at).toBeNull();
    expect(row.last_error).toBeNull();
    expect(await fundopRetry('refund_hold')).toBe(1);
    expect(await fundopPending('refund_hold')).toBe(1);
    expect(await fundopOldest('refund_hold')).toBe(1200); // 告警哨兵（>900s 响）

    // 第二轮仍未知 ⇒ 同锚再重放；第三轮远端恢复 ⇒ 收敛 pending
    expect(await svc.resolveHolding()).toBe(0);
    expect(apply.mock.calls[1]![0].actionId).toBe(apply.mock.calls[0]![0].actionId);
    fail = false;
    expect(await svc.resolveHolding()).toBe(1);
    expect(row.status).toBe('pending');
    expect(await fundopPending('refund_hold')).toBe(0);
  });
});

/* ======================================================================== *
 * ⑧ refunded 保留槽 ⇒ 二次申请 15006（结构封死）
 * ======================================================================== */
describe('⑧ `refunded` 保留槽（⚙️15：结构封死二次退款）', () => {
  it('渠道成功 ⇒ refunded 行 active_slot=1；同单再申请 ⇒ 15006「已退过」（预检闸）', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    const { client } = makeClient();
    const { channel } = makeChannel();
    const svc = makeService(db, client, channel);

    const applied = await svc.apply(USER, { orderNo: order.order_no, reason: 'r' });
    const reviewed = await svc.review(ADMIN, applied.refundNo, { action: 'approve' });
    expect(reviewed.status).toBe('refunded');

    const row = db.rows[0]!;
    expect(row.status).toBe('refunded');
    expect(row.active_slot).toBe(1); // **保留槽**：唯一键兼作「已退」结构标记

    // 二次申请：预检命中已退行 ⇒ 15006「已退过」。
    await expect(svc.apply(USER, { orderNo: order.order_no, reason: '再退一次' })).rejects.toMatchObject({
      code: ErrCode.PAY_REFUND_UNAVAILABLE,
      message: '该笔充值暂不可退（已退过）',
    });

    // 结构层兜底：预检被绕过（竞态）⇒ UK 仍拒（INSERT 撞 uk_refunds_order_active）。
    db.blindSlotChecks = 1;
    await expect(svc.apply(USER, { orderNo: order.order_no, reason: '穿透试探' })).rejects.toMatchObject({
      code: ErrCode.PAY_REFUND_UNAVAILABLE,
      message: '该笔充值暂不可退（处理中）',
    });
    expect(db.rows).toHaveLength(1); // 始终一行：结构封死
  });
});

/* ======================================================================== *
 * ⑨ 驳回回滚（review reject）
 * ======================================================================== */
describe('⑨ review reject：claim→rb→rejected；rb 失败停留 rejecting（响应实际态）', () => {
  it('pending 驳回 ⇒ rejected（审者列逐字 + 释槽 + 锚 refund_rb + 正 delta + rejected 计数）', async () => {
    const db = new FakeRefundDb();
    const row = db.seedRefund({ status: 'pending', coins: 600 });
    const { client, apply } = makeClient();
    const svc = makeService(db, client);

    const res = await svc.review(ADMIN, row.refund_no, { action: 'reject', note: '不符合退款条件' });
    expect(res).toEqual({ refundNo: row.refund_no, status: 'rejected' });
    expect(row.reviewed_by).toBe(ADMIN);
    expect(row.reviewed_at).toEqual(db.now);
    expect(row.review_note).toBe('不符合退款条件');
    expect(row.active_slot).toBeNull();
    expect(apply.mock.calls[0]![0]).toEqual({
      actionId: `refund_rb:${row.refund_no}`,
      source: 'refund_rollback',
      refId: row.refund_no,
      entries: [{ ownerId: USER, delta: +600 }],
    });
    // §2.6·5：审驳回的 inline rb 是**首尝试**（不属「同锚重放机器」⇒ 不计 retry）。
    expect(await fundopRetry('refund_rb')).toBeUndefined();
    expect(await refundTotal('rejected')).toBe(1);
  });

  it('approved 也可驳回（pending|approved 同权）；approve 仅 pending（approved 再审 ⇒ 15009）', async () => {
    const db = new FakeRefundDb();
    const row = db.seedRefund({ status: 'approved' });
    const svc = makeService(db);

    expect((await svc.review(ADMIN, row.refund_no, { action: 'reject' })).status).toBe('rejected');

    const row2 = db.seedRefund({ status: 'pending' });
    const { channel } = makeChannel();
    const svc2 = makeService(db, makeClient().client, channel);
    expect((await svc2.review(ADMIN, row2.refund_no, { action: 'approve', note: undefined })).status).toBe('refunded');
    expect(row2.reviewed_by).toBe(ADMIN);
    expect(row2.review_note).toBeNull();
  });

  it('rb 未知/明确失败 ⇒ 留 rejecting + last_error + 响亮，响应返回**实际态**；循环⑦收敛', async () => {
    const db = new FakeRefundDb();
    const row = db.seedRefund({ status: 'pending' });
    const { client, apply } = makeClient({
      apply: async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
      },
    });
    const svc = makeService(db, client);

    const res = await svc.review(ADMIN, row.refund_no, { action: 'reject' });
    expect(res.status).toBe('rejecting'); // 「200 返回实际态」
    expect(row.status).toBe('rejecting');
    expect(row.active_slot).toBe(1); // 绝不误置终态、不释槽
    expect(row.last_error).toBe('服务暂时不可用，请稍后重试');
    expect(await refundTotal('rejected')).toBe(1); // 驳回**决定**已发生（回滚未落账照计）

    // 恢复扫描照常接力（下一轮同锚重放 ⇒ rejected）
    const { client: client2, apply: apply2 } = makeClient();
    const ok = makeService(db, client2);
    expect(await ok.rollbackRecovery()).toBe(1);
    expect(row.status).toBe('rejected');
    expect(row.active_slot).toBeNull();
    expect(apply2.mock.calls[0]![0].actionId).toBe(apply.mock.calls[0]![0].actionId); // 同锚
  });

  it('循环⑦：rejecting 行同锚重放收敛；未知 ⇒ 停留 + last_error 累积；已 rejected 不出候选', async () => {
    const db = new FakeRefundDb();
    const target = db.seedRefund({ status: 'rejecting', coins: 600 });
    const done = db.seedRefund({ status: 'rejected' });
    let fail = true;
    const { client, apply } = makeClient({
      apply: async (req) => {
        if (fail) throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
        return okApplyData(req);
      },
    });
    const svc = makeService(db, client);

    expect(await svc.rollbackRecovery()).toBe(0);
    expect(target.status).toBe('rejecting');
    expect(target.last_error).toBe('服务暂时不可用，请稍后重试');
    expect(await fundopRetry('refund_rb')).toBe(1);
    expect(await fundopPending('refund_rb')).toBe(1);

    fail = false;
    expect(await svc.rollbackRecovery()).toBe(1);
    expect(target.status).toBe('rejected');
    expect(target.active_slot).toBeNull();
    expect(done.status).toBe('rejected'); // 不受扰（不重放已落账行——零新 RPC）
    expect(apply.mock.calls.every((c) => c[0]!.refId === target.refund_no)).toBe(true);
  });

  it('rejected 释槽 ⇒ **可重报新 `rf_` 新锚**（⚙️15：重报换新号 ⇒ 新锚）', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    const svc = makeService(db);

    const first = await svc.apply(USER, { orderNo: order.order_no, reason: '第一次' });
    expect((await svc.review(ADMIN, first.refundNo, { action: 'reject' })).status).toBe('rejected');

    const second = await svc.apply(USER, { orderNo: order.order_no, reason: '重报' });
    expect(second.status).toBe('pending');
    expect(second.refundNo).not.toBe(first.refundNo);
    const anchors = db.rows.map((r) => `refund:${r.refund_no}`);
    expect(new Set(anchors).size).toBe(2);
  });
});

/* ======================================================================== *
 * ⑩ approve 渠道成功（纯渠道动作；无后续钱动作）
 * ======================================================================== */
describe('⑩ approve 渠道成功 ⇒ refunded（钱已冻结：审批只动渠道）', () => {
  it('channel.refund 入参逐字（out_trade_no/refund_amount 元串/out_request_no=refund_no/reason）⇒ refunded 落账', async () => {
    const db = new FakeRefundDb();
    const row = db.seedRefund({ status: 'pending', coins: 600, amount_fen: 600, reason: '不想要了' });
    const { client, apply } = makeClient();
    const { channel, refund } = makeChannel({ refund: async () => okRefund('2026100622001700123') });
    const svc = makeService(db, client, channel);

    const res = await svc.review(ADMIN, row.refund_no, { action: 'approve', note: '准' });
    expect(res).toEqual({ refundNo: row.refund_no, status: 'refunded' });

    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0]![0]).toEqual({
      outTradeNo: row.order_no,
      refundAmount: '6.00', // fen2yuan(600)——⚙️5 禁浮点
      outRequestNo: row.refund_no, // §3.3：channel_out_request_no = refund_no（幂等键）
      reason: '不想要了',
    });

    expect(row.status).toBe('refunded');
    expect(row.channel_refund_no).toBe('2026100622001700123'); // RefundData.tradeNo 承载
    expect(row.refunded_at).toEqual(db.now);
    expect(row.active_slot).toBe(1); // 保留槽
    expect(row.reviewed_by).toBe(ADMIN);
    // **无后续钱动作**：refund_hold 那一笔就是实际扣减——审批全程零货币调用。
    expect(apply).not.toHaveBeenCalled();
    expect(await refundTotal('approved')).toBe(1);
  });
});

/* ======================================================================== *
 * ⑪ approve 渠道失败（退避序列 + 分类落标记 + 停 approved）
 * ======================================================================== */
describe('⑪ approve 渠道失败：就地退避 1s→5s→30s→2m→10m（六发）⇒ 停 + approved + last_error（分类落标记）+ 计数', () => {
  it('fake timers 逐步放行：六发间隔逐字；上限后 approved/last_error/槽保留/channel_fail=1（**业务拒=明确 ⇒ 不标记**）', async () => {
    vi.useFakeTimers();
    try {
      const db = new FakeRefundDb();
      const row = db.seedRefund({ status: 'pending' });
      const failure: ChannelResult<RefundData> = {
        ok: false,
        code: ErrCode.PAY_CHANNEL_ERROR,
        lastError: '40004/ACQ.REFUND_AMOUNT_EXCEED: 退款金额超限',
        channelCode: '40004',
        channelSubCode: 'ACQ.REFUND_AMOUNT_EXCEED',
      };
      const { client } = makeClient();
      const { channel, refund } = makeChannel({ refund: async () => failure });
      const svc = makeService(db, client, channel);

      const pending = svc.review(ADMIN, row.refund_no, { action: 'approve' });
      await vi.advanceTimersByTimeAsync(0);
      expect(refund).toHaveBeenCalledTimes(1); // 初始 1 发（同步先试）
      for (const [i, wait] of REFUND_RETRY_BACKOFF_MS.entries()) {
        await vi.advanceTimersByTimeAsync(wait);
        expect(refund, `第 ${i + 2} 发须在退避 ${wait}ms 后`).toHaveBeenCalledTimes(i + 2);
      }
      const res = await pending;

      expect(res).toEqual({ refundNo: row.refund_no, status: 'approved' }); // 「200 返回实际态」
      expect(row.status).toBe('approved'); // 停留（人工面）
      expect(row.active_slot).toBe(1); // 槽不释放（钱已冻结）
      expect(row.last_error).toBe('40004/ACQ.REFUND_AMOUNT_EXCEED: 退款金额超限'); // 末发摘要
      expect(row.last_error!.startsWith(REFUND_UNKNOWN_MARKER)).toBe(false); // 明确（业务响应）⇒ 不标记、不重放
      expect(refund).toHaveBeenCalledTimes(REFUND_RETRY_BACKOFF_MS.length + 1); // 恰 6 发
      expect(await refundTotal('channel_fail')).toBe(1);
      expect(await refundTotal('approved')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('六发全「结果未知」（传输级：无渠道码）⇒ last_error 打 `unknown:` 前缀（v1.1.4：转扫描低频重放）', async () => {
    vi.useFakeTimers();
    try {
      const db = new FakeRefundDb();
      const row = db.seedRefund({ status: 'pending' });
      const { client } = makeClient();
      const { channel, refund } = makeChannel({
        refund: async () => ({
          ok: false,
          code: ErrCode.PAY_CHANNEL_ERROR,
          lastError: 'fetch failed: connect ECONNREFUSED 127.0.0.1:9',
          channelCode: null,
          channelSubCode: null,
        }),
      });
      const svc = makeService(db, client, channel);

      const pending = svc.review(ADMIN, row.refund_no, { action: 'approve' });
      await vi.runAllTimersAsync(); // 退避链整体放行（穷尽）
      const res = await pending;

      expect(res).toEqual({ refundNo: row.refund_no, status: 'approved' });
      expect(row.status).toBe('approved');
      expect(row.active_slot).toBe(1);
      expect(row.last_error).toBe(`${REFUND_UNKNOWN_MARKER} fetch failed: connect ECONNREFUSED 127.0.0.1:9`);
      expect(refund).toHaveBeenCalledTimes(REFUND_RETRY_BACKOFF_MS.length + 1);
      expect(await refundTotal('channel_fail')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('配置缺失（密钥未配的 15001 固定摘要）= 明确失败 ⇒ **不标记**（重放无意义，留人工面）', async () => {
    vi.useFakeTimers();
    try {
      const db = new FakeRefundDb();
      const row = db.seedRefund({ status: 'pending' });
      const { client } = makeClient();
      const { channel } = makeChannel({
        refund: async () => ({
          ok: false,
          code: ErrCode.PAY_CHANNEL_ERROR,
          lastError: CHANNEL_CONFIG_ERROR,
          channelCode: null,
          channelSubCode: null,
        }),
      });
      const svc = makeService(db, client, channel);

      const pending = svc.review(ADMIN, row.refund_no, { action: 'approve' });
      await vi.runAllTimersAsync();
      const res = await pending;

      expect(res).toEqual({ refundNo: row.refund_no, status: 'approved' });
      expect(row.last_error).toBe(CHANNEL_CONFIG_ERROR);
      expect(row.last_error!.startsWith(REFUND_UNKNOWN_MARKER)).toBe(false);
      expect(await refundTotal('channel_fail')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('分类器材质面（classifyChannelFailure）：渠道码/配置缺失 ⇒ 明确；传输/验签 ⇒ 未知', () => {
    const f = (over: Partial<ChannelFailure>): ChannelFailure => ({
      ok: false,
      code: ErrCode.PAY_CHANNEL_ERROR,
      lastError: 'x',
      channelCode: null,
      channelSubCode: null,
      ...over,
    });
    expect(classifyChannelFailure(f({ channelCode: '40004', channelSubCode: 'ACQ.REFUND_AMOUNT_EXCEED' }))).toBe('definite');
    expect(classifyChannelFailure(f({ channelCode: '40004' }))).toBe('definite');
    expect(classifyChannelFailure(f({ channelSubCode: 'ACQ.X' }))).toBe('definite');
    expect(classifyChannelFailure(f({ lastError: CHANNEL_CONFIG_ERROR }))).toBe('definite');
    expect(classifyChannelFailure(f({ lastError: 'fetch failed' }))).toBe('unknown');
    expect(classifyChannelFailure(f({ lastError: RESPONSE_VERIFY_FAILED }))).toBe('unknown');
    expect(classifyChannelFailure(f({ lastError: '渠道响应形状非法（无响应节点）' }))).toBe('unknown');
  });

  it('每发前复核 claim：退避中途被驳回（approved→rejecting）⇒ **停发**、返回真实态、不计 channel_fail', async () => {
    vi.useFakeTimers();
    try {
      const db = new FakeRefundDb();
      const row = db.seedRefund({ status: 'pending' });
      const { client } = makeClient();
      const { channel, refund } = makeChannel({
        refund: async () => ({
          ok: false,
          code: ErrCode.PAY_CHANNEL_ERROR,
          lastError: '服务暂时不可用，请稍后重试',
          channelCode: null,
          channelSubCode: null,
        }),
      });
      const svc = makeService(db, client, channel);

      const pending = svc.review(ADMIN, row.refund_no, { action: 'approve' });
      await vi.advanceTimersByTimeAsync(0);
      expect(refund).toHaveBeenCalledTimes(1);

      // 退避间隙：并发驳回落账（人工面第二管理员/运营）——行已离开 approved。
      row.status = 'rejected';
      row.active_slot = null;

      await vi.advanceTimersByTimeAsync(1_000); // 唤醒后先复核 ⇒ 停（不再发第二发）
      const res = await pending;
      expect(refund).toHaveBeenCalledTimes(1);
      expect(res).toEqual({ refundNo: row.refund_no, status: 'rejected' });
      expect(await refundTotal('channel_fail')).toBeUndefined(); // 非渠道穷尽——不计
      expect(await refundTotal('approved')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ======================================================================== *
 * ⑫ review 框架（参数/冲突/CAS 失手）
 * ======================================================================== */
describe('⑫ review 框架：action/note 负例 · 15009 全表 · 渠道已成但行被处置（CAS 失手）响亮留痕', () => {
  it('参数校验负例：action 非 approve|reject ⇒ 10001；note 非串/超 255 ⇒ 10001；缺 actor ⇒ 10001', async () => {
    const db = new FakeRefundDb();
    const row = db.seedRefund({ status: 'pending' });
    const svc = makeService(db);

    const bad = 'cancel' as unknown as 'approve';
    await expect(svc.review(ADMIN, row.refund_no, { action: bad })).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
    });
    await expect(
      svc.review(ADMIN, row.refund_no, { action: 'approve', note: 42 } as unknown as { action: 'approve' }),
    ).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    await expect(
      svc.review(ADMIN, row.refund_no, { action: 'approve', note: 'x'.repeat(256) }),
    ).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });
    await expect(svc.review('', row.refund_no, { action: 'approve' })).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
    });
    expect(row.status).toBe('pending'); // 零状态扰动
  });

  it('非法源态全表：holding 不可审、refunded 不可审、approved 不可 approve、rejecting 不可审、不存在 ⇒ 15009', async () => {
    const db = new FakeRefundDb();
    const holding = db.seedRefund({ status: 'holding' });
    const refunded = db.seedRefund({ status: 'refunded' });
    const approved = db.seedRefund({ status: 'approved' });
    const rejecting = db.seedRefund({ status: 'rejecting' });
    const { channel, refund } = makeChannel();
    const svc = makeService(db, makeClient().client, channel);

    for (const target of [holding, refunded, approved, rejecting]) {
      await expect(svc.review(ADMIN, target.refund_no, { action: 'approve' })).rejects.toMatchObject({
        code: ErrCode.PAY_STATE_CONFLICT,
      });
    }
    await expect(svc.review(ADMIN, 'rf_missing0000', { action: 'reject' })).rejects.toMatchObject({
      code: ErrCode.PAY_STATE_CONFLICT,
    });
    // 15009 message 含当前态与合法动作。
    try {
      await svc.review(ADMIN, refunded.refund_no, { action: 'approve' });
    } catch (err) {
      const message = (err as DomainError).message;
      expect(message).toContain('refunded');
      expect(message).toContain('pending');
    }
    expect(refund).not.toHaveBeenCalled(); // 非法源态零渠道调用
    expect([holding.status, refunded.status, approved.status, rejecting.status]).toEqual([
      'holding',
      'refunded',
      'approved',
      'rejecting',
    ]);
  });

  it('CAS 失手（渠道成功瞬间行已被处置）⇒ 绝不误置 refunded；last_error 留对账线索；返回真实态', async () => {
    const db = new FakeRefundDb();
    const row = db.seedRefund({ status: 'pending' });
    const { client } = makeClient();
    const { channel } = makeChannel({
      refund: async () => {
        // 渠道成功的同时，行被并发驳回/清退（模拟运营侧处置——双面窗口）。
        row.status = 'rejected';
        row.active_slot = null;
        return okRefund('2026100622001799999');
      },
    });
    const svc = makeService(db, client, channel);

    const res = await svc.review(ADMIN, row.refund_no, { action: 'approve' });
    expect(res.status).toBe('rejected'); // 实际态
    expect(row.status).toBe('rejected');
    expect(row.channel_refund_no).toBeNull(); // 未误置 refunded
    expect(row.last_error).toContain('2026100622001799999'); // 渠道单号留痕（对账线索）
    expect(row.last_error).toContain('人工');
  });
});

/* ======================================================================== *
 * ⑬ 指标与注册面
 * ======================================================================== */
describe('⑬ 指标写点与注册面', () => {
  it('refund_total 四值：applied/approved/rejected 各写点 + channel_fail（穷尽）', async () => {
    const db = new FakeRefundDb();
    const applyOrder = db.seedOrder();
    const okOrder = db.seedOrder();
    const rejOrder = db.seedOrder();
    const failOrder = db.seedOrder();
    const okRow = db.seedRefund({ status: 'pending', order_no: okOrder.order_no });
    const rejRow = db.seedRefund({ status: 'pending', order_no: rejOrder.order_no });
    const failRow = db.seedRefund({ status: 'pending', order_no: failOrder.order_no });
    const { client } = makeClient();
    const { channel, refund } = makeChannel({
      refund: async (req) => {
        if (req.outRequestNo === failRow.refund_no) {
          return {
            ok: false,
            code: ErrCode.PAY_CHANNEL_ERROR,
            lastError: '渠道不可用',
            channelCode: null,
            channelSubCode: null,
          };
        }
        return okRefund();
      },
    });
    const svc = makeService(db, client, channel);

    await svc.apply(USER, { orderNo: applyOrder.order_no, reason: 'r' }); // applied
    expect((await svc.review(ADMIN, okRow.refund_no, { action: 'approve' })).status).toBe('refunded');
    expect((await svc.review(ADMIN, rejRow.refund_no, { action: 'reject' })).status).toBe('rejected');

    vi.useFakeTimers();
    try {
      const pending = svc.review(ADMIN, failRow.refund_no, { action: 'approve' });
      await vi.runAllTimersAsync(); // 退避链整体放行（穷尽）
      expect((await pending).status).toBe('approved');
    } finally {
      vi.useRealTimers();
    }
    // okRow 1 发 + failRow 穷尽 6 发（逐请求计数——同一条假渠道服务两个审批面）。
    expect(refund.mock.calls.filter((c) => c[0]!.outRequestNo === failRow.refund_no)).toHaveLength(
      REFUND_RETRY_BACKOFF_MS.length + 1,
    );

    expect(await refundTotal('applied')).toBe(1);
    expect(await refundTotal('approved')).toBe(2); // okRow + failRow
    expect(await refundTotal('rejected')).toBe(1);
    expect(await refundTotal('channel_fail')).toBe(1);
  });

  it('fundop 同刷：holding ⇒ {op=refund_hold}；rejecting ⇒ {op=refund_rb}（计数/年龄）', async () => {
    const db = new FakeRefundDb();
    db.seedRefund({ status: 'holding', created_at: new Date(db.now.getTime() - 300_000) });
    db.seedRefund({ status: 'rejecting', created_at: new Date(db.now.getTime() - 60_000) });
    const svc = makeService(db);

    await svc.refreshRefundGauges();
    expect(await fundopPending('refund_hold')).toBe(1);
    expect(await fundopOldest('refund_hold')).toBe(300); // >900s 阈值 = PaymentFundOpStalled 哨兵
    expect(await fundopPending('refund_rb')).toBe(1);
    expect(await fundopOldest('refund_rb')).toBe(60);
  });

  it('AppModule：RefundController ∈ controllers、RefundService ∈ providers（未注册 = 真容器 404/启动崩）', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(controllers).toContain(RefundController);
    expect(providers).toContain(RefundService);
  });

  it('HTTP_STATUS：15006 → 409（不补则 4xx 静默变 500）', () => {
    expect(HTTP_STATUS[ErrCode.PAY_REFUND_UNAVAILABLE]).toBe(409);
  });
});

/* ======================================================================== *
 * ⑮ 循环⑧ replayUnknown（v1.1.4 §3.3 未知结果收敛）
 * ======================================================================== */
describe('⑮ replayUnknown（循环⑧）：`unknown:` 行同 out_request_no 低频重放（每扫描周期 1 发）', () => {
  /** 未知结果收敛的「渠道仍不可达」面（传输级：无渠道码 ⇒ 未知）。 */
  const unknownErr = (message: string): ChannelResult<RefundData> => ({
    ok: false,
    code: ErrCode.PAY_CHANNEL_ERROR,
    lastError: message,
    channelCode: null,
    channelSubCode: null,
  });

  /** SQL/行为面 seed：approved + `unknown:` 标记 + reviewed_at 在窗内（默认 1 分钟前）。 */
  const seedUnknownApproved = (db: FakeRefundDb, over: Partial<FakeRefundRow> = {}): FakeRefundRow =>
    db.seedRefund({
      status: 'approved',
      last_error: `${REFUND_UNKNOWN_MARKER} fetch failed（既往下线摘要）`,
      reviewed_by: ADMIN,
      reviewed_at: new Date(db.now.getTime() - 60_000),
      ...over,
    });

  it('重放成功 ⇒ refunded（out_request_no 锚原样、channel_refund_no/refunded_at 落账；零货币动作）；次轮出候选', async () => {
    const db = new FakeRefundDb();
    const row = seedUnknownApproved(db, { amount_fen: 600, reason: '不想要了' });
    const { client, apply } = makeClient();
    const { channel, refund } = makeChannel({ refund: async () => okRefund('2026100622001800011') });
    const svc = makeService(db, client, channel);

    expect(await svc.replayUnknown()).toBe(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0]![0]).toEqual({
      outTradeNo: row.order_no,
      refundAmount: '6.00', // fen2yuan(600)——⚙️5 禁浮点
      outRequestNo: row.refund_no, // channel_out_request_no = refund_no（§3.3 幂等键原样）
      reason: '不想要了',
    });
    expect(row.status).toBe('refunded');
    expect(row.channel_refund_no).toBe('2026100622001800011');
    expect(row.refunded_at).toEqual(db.now);
    expect(row.active_slot).toBe(1); // 保留槽
    expect(apply).not.toHaveBeenCalled(); // 零货币动作（refund_hold 即扣减）

    // 次轮：行已出候选（status 变了）⇒ 零新渠道调用（每扫描周期至多 1 发/行）。
    expect(await svc.replayUnknown()).toBe(0);
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('候选谓词：仅 `approved`+`unknown:`+72h 窗内——无标记/他态/超 72h 行零渠道调用（超窗标记保留）', async () => {
    const db = new FakeRefundDb();
    const hit = seedUnknownApproved(db);
    const noMarker = db.seedRefund({ status: 'approved' }); // 明确失败面（无前缀）⇒ 不重放
    const pendingRow = db.seedRefund({ status: 'pending', last_error: `${REFUND_UNKNOWN_MARKER} x` });
    const old = seedUnknownApproved(db, {
      reviewed_at: new Date(db.now.getTime() - 72 * 3_600_000 - 1), // >72h ⇒ 停自动
    });
    const { client } = makeClient();
    const { channel, refund } = makeChannel();
    const svc = makeService(db, client, channel);

    expect(await svc.replayUnknown()).toBe(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0]![0].outRequestNo).toBe(hit.channel_out_request_no);
    expect(hit.status).toBe('refunded');
    // 其余三行不受扰：
    expect(noMarker.status).toBe('approved');
    expect(pendingRow.status).toBe('pending');
    expect(old.status).toBe('approved');
    expect(old.last_error).toBe(`${REFUND_UNKNOWN_MARKER} fetch failed（既往下线摘要）`); // 标记保留（纯人工）
  });

  it('重放得**明确失败**（业务拒）⇒ 替换 last_error（去前缀）停自动——下轮零调用', async () => {
    const db = new FakeRefundDb();
    const row = seedUnknownApproved(db);
    const { client } = makeClient();
    const { channel, refund } = makeChannel({
      refund: async () => ({
        ok: false,
        code: ErrCode.PAY_CHANNEL_ERROR,
        lastError: '40004/ACQ.REFUND_NOT_ALLOW: 该笔交易不支持退款',
        channelCode: '40004',
        channelSubCode: 'ACQ.REFUND_NOT_ALLOW',
      }),
    });
    const svc = makeService(db, client, channel);

    expect(await svc.replayUnknown()).toBe(0);
    expect(row.status).toBe('approved');
    expect(row.last_error).toBe('40004/ACQ.REFUND_NOT_ALLOW: 该笔交易不支持退款'); // 去前缀（人工面）
    expect(row.last_error!.startsWith(REFUND_UNKNOWN_MARKER)).toBe(false);

    // 停自动：下一轮该行不再入候选（标记已除）——零新渠道调用。
    expect(await svc.replayUnknown()).toBe(0);
    expect(refund).toHaveBeenCalledTimes(1);
    // 扫描重放不掷 channel_fail（§2.6 恰数：该标签 = inline 退避穷尽计数）。
    expect(await refundTotal('channel_fail')).toBeUndefined();
  });

  it('重放得**配置缺失**（本地 15001 固定摘要）= 明确 ⇒ 同样去前缀、停自动', async () => {
    const db = new FakeRefundDb();
    const row = seedUnknownApproved(db);
    const { client } = makeClient();
    const { channel, refund } = makeChannel({
      refund: async () => ({
        ok: false,
        code: ErrCode.PAY_CHANNEL_ERROR,
        lastError: CHANNEL_CONFIG_ERROR,
        channelCode: null,
        channelSubCode: null,
      }),
    });
    const svc = makeService(db, client, channel);

    expect(await svc.replayUnknown()).toBe(0);
    expect(row.last_error).toBe(CHANNEL_CONFIG_ERROR);
    expect(await svc.replayUnknown()).toBe(0);
    expect(refund).toHaveBeenCalledTimes(1); // 停自动（去前缀后出候选）
  });

  it('重放仍**未知** ⇒ 刷新标记（缀 ISO 时刻与最新摘要；下轮仍入候选——每周期 1 发）', async () => {
    const db = new FakeRefundDb();
    const row = seedUnknownApproved(db, { last_error: `${REFUND_UNKNOWN_MARKER} 旧摘要` });
    let message = 'fetch failed: connect ECONNREFUSED 127.0.0.1:9 (1)';
    const { client } = makeClient();
    const { channel, refund } = makeChannel({ refund: async () => unknownErr(message) });
    const svc = makeService(db, client, channel);

    expect(await svc.replayUnknown()).toBe(0);
    expect(row.status).toBe('approved');
    expect(row.last_error!.startsWith(`${REFUND_UNKNOWN_MARKER} [`)).toBe(true); // 缀时刻
    expect(row.last_error).toContain('(1)');
    expect(row.last_error).not.toBe(`${REFUND_UNKNOWN_MARKER} 旧摘要`);

    // 下一扫描周期：仍入候选（标记在、窗内）⇒ 再发 1 发、再刷新。
    message = 'fetch failed: connect ECONNREFUSED 127.0.0.1:9 (2)';
    expect(await svc.replayUnknown()).toBe(0);
    expect(refund).toHaveBeenCalledTimes(2);
    expect(row.last_error).toContain('(2)');
    expect(row.last_error!.startsWith(REFUND_UNKNOWN_MARKER)).toBe(true);
  });

  it('重放成功瞬间行被他方处置（CAS 失手）⇒ 不误置 refunded；对账线索入 last_error；计 0', async () => {
    const db = new FakeRefundDb();
    const row = seedUnknownApproved(db);
    const { client } = makeClient();
    const { channel } = makeChannel({
      refund: async () => {
        row.status = 'rejected'; // 渠道成功的同时，行被并发驳回（双面窗口）
        row.active_slot = null;
        return okRefund('2026100622001899999');
      },
    });
    const svc = makeService(db, client, channel);

    expect(await svc.replayUnknown()).toBe(0);
    expect(row.status).toBe('rejected'); // 实际态
    expect(row.channel_refund_no).toBeNull(); // 未误置 refunded
    expect(row.last_error).toContain('2026100622001899999'); // 渠道单号留痕（对账线索）
    expect(row.last_error).toContain('人工');
  });
});

/* ======================================================================== *
 * ⑭ 控制器真 HTTP
 * ======================================================================== */
describe('⑭ POST /api/pay/refunds：200 正例 / 401 缺身份 / 404+15002 / 409+15006（真 HTTP）', () => {
  it('真 Nest 管线 + node:http 四口径', async () => {
    const db = new FakeRefundDb();
    const order = db.seedOrder();
    const notCredited = db.seedOrder({ status: 'created' });
    const { client } = makeClient();

    @Module({
      controllers: [RefundController],
      providers: [
        RefundService,
        { provide: DataSource, useValue: db.dataSource },
        { provide: CurrencyRpcClient, useValue: client },
        { provide: UserLockService, useValue: new UserLockService(db.dataSource) },
        { provide: AlipayClient, useValue: makeChannel().channel },
      ],
    })
    class RefundProbeModule {}

    const app = await NestFactory.create(RefundProbeModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const H = { 'x-user-id': USER, 'content-type': 'application/json' };

    try {
      const ok = await httpCall(port, '/api/pay/refunds', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ orderNo: order.order_no, reason: '不想要了' }),
      });
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.body) as { code: number; data: PayRefundApplyResponse };
      expect(body.code).toBe(ErrCode.OK);
      expect(body.data.refundNo).toMatch(/^rf_[0-9a-z]+$/);
      expect(body.data.status).toBe('pending');

      const noAuth = await httpCall(port, '/api/pay/refunds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderNo: order.order_no, reason: 'r' }),
      });
      expect(noAuth.status).toBe(401);
      expect(JSON.parse(noAuth.body) as { code: number }).toMatchObject({ code: ErrCode.UNAUTHENTICATED });

      const missing = await httpCall(port, '/api/pay/refunds', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ orderNo: 'pay_missing', reason: 'r' }),
      });
      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.body) as { code: number }).toMatchObject({
        code: ErrCode.PAY_ORDER_NOT_FOUND,
        message: '订单不存在或已失效',
      });

      const notYet = await httpCall(port, '/api/pay/refunds', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ orderNo: notCredited.order_no, reason: 'r' }),
      });
      expect(notYet.status).toBe(409);
      expect(JSON.parse(notYet.body) as { code: number }).toMatchObject({
        code: ErrCode.PAY_REFUND_UNAVAILABLE,
        message: '该笔充值暂不可退（未入账）',
      });
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

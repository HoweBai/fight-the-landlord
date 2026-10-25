/**
 * 财务读口（③ T6；规格 §2.7 + §2.11）——`GET /api/admin/wallet/ops[.csv]` ·
 * `GET /api/admin/wallet/ops/:opId` · `GET /api/admin/wallet/summary[.csv]`。
 *
 * 判据（全列；C17/C18/C19/C22 的 currency-service 半边）：
 *  - ops 列表：六过滤（source/actor/ownerId/from/to/cursor）全 AND、`from` 含边界 / `to` 不含边界
 *    （半开区间）、`new Date(ms)` 绑定、`f.id DESC LIMIT ?`、缺省 50 上限 100、
 *    `nextCursor=rows.length===limit?末行 flowId:null`（无存在性预查）；
 *  - `reversed` 旗 = `EXISTS(… CONCAT('admin:reverse:', o.id))`（MySQL TINYINT 0/1 ⇒ DTO boolean）；
 *  - 三 SQL（列表基句/详情/两 summary）**全文相等**断言（实现漂移一个字符就红——照
 *    `reconcile.test.ts` 的假库纪律；本文件的常量是**独立副本**，不从实现导入）；
 *  - op 详情：同 join 无过滤、`f.id` 升序、多账户 op 全 flows、不存在 ⇒ 404 借 10001「操作不存在」；
 *  - summary：source/day 两态、+08:00 切天（跨日样本）、缺省窗口 `to=now+1ms`/`from=to−30d`、
 *    空窗 ⇒ `rows:[], totals:{delta:0,flowCount:0}`、`k`=字符串 ∧ `delta/flowCount`=数字
 *    （假库按驱动真形态回值：SUM ⇒ DECIMAL 字符串、COUNT ⇒ number、DATE ⇒ Date）；
 *  - 两 CSV：BOM 首字节、行尾 `\r\n`、中文表头逐字、`csvCell` 消毒样本、文件名
 *    `flows-<yyyyMMdd-HHmmss>.csv` / `summary-….csv`、CSV 白名单去掉 cursor/limit（带上即 400）；
 *  - 未知 query 键 400 借 10001「未知查询参数：<key>」（⚙️9）；校验**先于**查库（假库零查询被钉）。
 *
 * 形态：**真 Nest 管线**（真 AdminFinanceController + 真 XAdminGuard + 真异常过滤器 +
 * globalPrefix `api`）+ 真 `FinanceQueryService` + 假 `DataSource`（内存三表 + SQL 解释器：
 * 条件子句逐条解释、不认识即抛——服务与假库各说各话时立刻红）。
 * ⚠️ 读端点**不带** `X-Admin-Actor`（断言信头只给 `x-admin`）——读面不强求该头（§2.7）。
 */
import 'reflect-metadata';
import { Module, ValidationPipe, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { CSV_BOM, CURRENCY_SOURCES, ErrCode } from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import { AdminFinanceController } from '../src/admin/admin-finance.controller';
import { FinanceQueryService } from '../src/admin/finance-query.service';
import { ReverseService } from '../src/admin/reverse.service';
import { ApplyService } from '../src/apply/apply.service';
import { ReconcileService } from '../src/reconcile/reconcile.service';
import { XAdminGuard } from '../src/http/x-admin.guard';

const AUTH = { 'x-admin': '1' };

/* ------------------------------------------------------------------ *
 * SQL 全文（规格 §2.7 逐字；**独立副本**——实现侧漂移一个字符就红）
 * ------------------------------------------------------------------ */

const OPS_BASE =
  'SELECT f.id AS flowId, f.op_id AS opId, o.action_id AS actionId, o.source, o.game_type AS gameType, o.actor, o.reason, ' +
  'o.ref_id AS refId, o.trace_id AS traceId, o.burned_residue AS burnedResidue, o.burned_rake AS burnedRake, f.owner_id AS ownerId, f.owner_type AS ownerType, ' +
  'f.delta, f.balance_after AS balanceAfter, f.created_at AS createdAt, ' +
  'u.phone, u.nickname, ' +
  "EXISTS(SELECT 1 FROM currency_ops r WHERE r.action_id = CONCAT('admin:reverse:', o.id)) AS reversed " +
  'FROM currency_flows f ' +
  'JOIN currency_ops o ON o.id = f.op_id ' +
  'LEFT JOIN users u ON u.id = f.owner_id';
const OPS_LIST_SUFFIX = ' ORDER BY f.id DESC LIMIT ?';
const OPS_DETAIL_SQL = `${OPS_BASE} WHERE f.op_id = ? ORDER BY f.id`;
const SUMMARY_SOURCE_SQL =
  'SELECT o.source AS k, o.game_type AS game_type, COALESCE(SUM(f.delta),0) AS delta, COUNT(*) AS flowCount ' +
  'FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id ' +
  'WHERE f.created_at >= ? AND f.created_at < ? GROUP BY o.source, o.game_type ORDER BY k, o.game_type';
const SUMMARY_DAY_SQL =
  "SELECT DATE(CONVERT_TZ(f.created_at,'+00:00','+08:00')) AS k, o.game_type AS game_type, COALESCE(SUM(f.delta),0) AS delta, COUNT(*) AS flowCount " +
  'FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id ' +
  'WHERE f.created_at >= ? AND f.created_at < ? GROUP BY k, o.game_type ORDER BY k, o.game_type';
const SUMMARY_BURN_SQL =
  'SELECT COALESCE(SUM(burned_residue),0) AS residue, COALESCE(SUM(burned_rake),0) AS rake, COUNT(*) - COUNT(burned_residue) AS unrecordedOps ' +
  "FROM currency_ops WHERE source = 'game_settle' AND created_at >= ? AND created_at < ?";
const SUMMARY_SKIPS_SQL =
  'SELECT COUNT(*) AS cnt, COUNT(DISTINCT owner_id) AS players, COALESCE(SUM(fee_amount),0) AS amount FROM currency_entry_fee_skips WHERE created_at >= ? AND created_at < ?';
const SUMMARY_BURN_BY_GAME_SQL =
  'SELECT o.game_type AS k, COALESCE(SUM(o.burned_residue),0) AS residue, COALESCE(SUM(o.burned_rake),0) AS rake, COUNT(*) - COUNT(o.burned_residue) AS unrecordedOps ' +
  "FROM currency_ops o WHERE o.source='game_settle' AND o.created_at >= ? AND o.created_at < ? GROUP BY o.game_type ORDER BY k";
const SUMMARY_SKIPS_BY_GAME_SQL =
  'SELECT game_type AS k, COUNT(*) AS cnt, COUNT(DISTINCT owner_id) AS players, COALESCE(SUM(fee_amount),0) AS amount ' +
  'FROM currency_entry_fee_skips WHERE created_at >= ? AND created_at < ? GROUP BY game_type ORDER BY k';
const SUMMARY_CARD_COUNTER_PURCHASES_SQL =
  'SELECT `kind` AS k, COUNT(*) AS cnt, COUNT(DISTINCT `owner_id`) AS players, COALESCE(SUM(`price`),0) AS amount ' +
  'FROM `card_counter_purchases` WHERE `created_at` >= ? AND `created_at` < ? GROUP BY `kind` ORDER BY k';
const SUMMARY_CARD_COUNTER_CONSUMPTIONS_SQL =
  'SELECT `kind` AS k, COUNT(*) AS cnt, COUNT(DISTINCT `owner_id`) AS players ' +
  'FROM `card_counter_consumptions` WHERE `created_at` >= ? AND `created_at` < ? GROUP BY `kind` ORDER BY k';

/** 零窗的固定行（DTO 形状：购买 game/hour；使用 pass/credit/none）。 */
const ZERO_CC_PURCHASES = [
  { kind: 'game', count: 0, players: 0, amount: 0 },
  { kind: 'hour', count: 0, players: 0, amount: 0 },
];
const ZERO_CC_CONSUMPTIONS = [
  { kind: 'pass', count: 0, players: 0 },
  { kind: 'credit', count: 0, players: 0 },
  { kind: 'none', count: 0, players: 0 },
];

const T = (iso: string) => new Date(iso);
const T1 = T('2026-10-05T10:00:00.000Z');
const T2 = T('2026-10-05T11:00:00.000Z');
const T3 = T('2026-10-05T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * 假 DataSource：ops/flows/users 三表 + SQL 解释器
 * ------------------------------------------------------------------ */

interface FakeOp {
  id: number;
  actionId: string;
  source: string;
  gameType: string | null;
  actor: string | null;
  reason: string | null;
  refId: string | null;
  traceId: string | null;
  createdAt: Date;
  burnedResidue: number | null;
  burnedRake: number | null;
}

interface FakeFlow {
  id: number;
  opId: number;
  ownerId: string;
  ownerType: string;
  delta: number;
  balanceAfter: number;
  createdAt: Date;
}

interface FakeUser {
  phone: string | null;
  nickname: string | null;
}

interface FakeSkipRow {
  id: number;
  roomCode: string;
  ownerId: string;
  seat: number | null;
  gameType: string;
  baseScore: number;
  feeAmount: number;
  reason: string;
  createdAt: Date;
}

/** 记牌器收费片：购买/消费块的行（summary 假库面）。 */
interface FakeCardCounterPurchase {
  kind: 'game' | 'hour';
  ownerId: string;
  price: number;
  createdAt: Date;
}

interface FakeCardCounterConsumption {
  kind: 'pass' | 'credit' | 'none';
  ownerId: string;
  createdAt: Date;
}

/** 条件子句 ⇒ 谓词（全部 AND；子句文本与服务侧构造逐字对应，不认识即抛）。 */
type Predicate = (row: { flow: FakeFlow; op: FakeOp }, value: unknown) => boolean;

const OPS_PREDICATES: Record<string, Predicate> = {
  'o.source = ?': (r, v) => r.op.source === v,
  'o.game_type = ?': (r, v) => r.op.gameType === v,
  'o.actor = ?': (r, v) => r.op.actor === v,
  'f.owner_id = ?': (r, v) => r.flow.ownerId === v,
  'f.created_at >= ?': (r, v) => r.flow.createdAt.getTime() >= (v as Date).getTime(),
  'f.created_at < ?': (r, v) => r.flow.createdAt.getTime() < (v as Date).getTime(),
  'f.id < ?': (r, v) => r.flow.id < Number(v),
};

class FakeFinanceDb {
  ops: FakeOp[] = [];
  flows: FakeFlow[] = [];
  users = new Map<string, FakeUser>();
  skips: FakeSkipRow[] = [];
  purchases: FakeCardCounterPurchase[] = [];
  consumptions: FakeCardCounterConsumption[] = [];
  queries: Array<{ sql: string; params: unknown[] }> = [];
  /**
   * `reversed` 旗的驱动回值形态注入面（真栈实测类：EXISTS 是 BIGINT，优化器走
   * semi-join/物化路径时 mysql2 回**字符串** `"0"/"1"`，普通路径回 number）。
   */
  reversedAsString = false;
  /** 非 0/1 回值注入面（响亮抛的负例；undefined = 正常计算）。 */
  reversedOverride: unknown = undefined;
  /** burn 两列回值注入面（非 null 的畸形驱动回值负例；undefined = 正常）。 */
  burnedRawOverride: unknown = undefined;
  /** A2：burnByGame 注入面（模拟跨查询快照漂移；undefined = 正常计算）。 */
  burnByGameOverride: unknown[] | undefined = undefined;
  private nextOpId = 1;
  private nextFlowId = 1;
  private nextSkipId = 1;

  addOp(over: Partial<FakeOp> & { actionId: string }): FakeOp {
    const op: FakeOp = {
      id: this.nextOpId++,
      source: 'admin_adjust',
      gameType: null,
      actor: 'admin',
      reason: null,
      refId: null,
      traceId: null,
      createdAt: T1,
      burnedResidue: null,
      burnedRake: null,
      ...over,
    };
    this.ops.push(op);
    return op;
  }

  addFlow(
    op: FakeOp,
    over: { ownerId: string; delta: number; balanceAfter: number; createdAt?: Date; ownerType?: string },
  ): FakeFlow {
    const flow: FakeFlow = {
      id: this.nextFlowId++,
      opId: op.id,
      ownerType: 'user',
      createdAt: T1,
      ...over,
    };
    this.flows.push(flow);
    return flow;
  }

  /** 大批量种子（50k 上限用例；逐条 addFlow 会慢一个量级）。 */
  addFlowRange(op: FakeOp, count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.flows.push({
        id: this.nextFlowId++,
        opId: op.id,
        ownerId: `bulk-${i}`,
        ownerType: 'user',
        delta: 1,
        balanceAfter: 1,
        createdAt: new Date(T1.getTime() + i),
      });
    }
  }

  addSkip(over: { ownerId: string; feeAmount: number; createdAt: Date } & Partial<FakeSkipRow>): FakeSkipRow {
    const row: FakeSkipRow = {
      id: this.nextSkipId++,
      roomCode: 'ABC123',
      seat: null,
      gameType: 'doudizhu',
      baseScore: 15,
      reason: 'insufficient_funds',
      ...over,
    };
    this.skips.push(row);
    return row;
  }

  addPurchase(over: FakeCardCounterPurchase): void {
    this.purchases.push(over);
  }

  addConsumption(over: FakeCardCounterConsumption): void {
    this.consumptions.push(over);
  }

  setUser(ownerId: string, user: FakeUser): void {
    this.users.set(ownerId, user);
  }

  reset(): void {
    this.ops = [];
    this.flows = [];
    this.users = new Map();
    this.skips = [];
    this.purchases = [];
    this.consumptions = [];
    this.queries = [];
    this.reversedAsString = false;
    this.reversedOverride = undefined;
    this.burnedRawOverride = undefined;
    this.burnByGameOverride = undefined;
    this.nextOpId = 1;
    this.nextFlowId = 1;
    this.nextSkipId = 1;
  }

  readonly dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.queries.push({ sql, params: [...params] });
      return Promise.resolve(this.exec(sql, params));
    },
  };

  /** 解释一条 SELECT：四 SQL 全文识别（其余当场抛）。 */
  private exec(sql: string, params: unknown[]): unknown {
    if (sql === SUMMARY_SOURCE_SQL) return this.summaryBySource(params);
    if (sql === SUMMARY_DAY_SQL) return this.summaryByDay(params);
    if (sql === SUMMARY_BURN_SQL) return this.summaryBurn(params);
    if (sql === SUMMARY_SKIPS_SQL) return this.summarySkips(params);
    if (sql === SUMMARY_BURN_BY_GAME_SQL) return this.summaryBurnByGame(params);
    if (sql === SUMMARY_SKIPS_BY_GAME_SQL) return this.summarySkipsByGame(params);
    if (sql === SUMMARY_CARD_COUNTER_PURCHASES_SQL) return this.summaryCardCounterPurchases(params);
    if (sql === SUMMARY_CARD_COUNTER_CONSUMPTIONS_SQL) return this.summaryCardCounterConsumptions(params);
    if (sql === OPS_DETAIL_SQL) return this.detail(params);
    if (sql.startsWith(OPS_BASE)) return this.list(sql, params);
    throw new Error(`FakeFinanceDb: 未识别的 SQL：${sql}`);
  }

  /** 列表：`<base>[ WHERE c1 AND c2…] ORDER BY f.id DESC LIMIT ?`。 */
  private list(sql: string, params: unknown[]): unknown {
    const rest = sql.slice(OPS_BASE.length);
    let conds: string[] = [];
    if (rest === OPS_LIST_SUFFIX) {
      conds = [];
    } else if (rest.startsWith(' WHERE ') && rest.endsWith(OPS_LIST_SUFFIX)) {
      const mid = rest.slice(' WHERE '.length, rest.length - OPS_LIST_SUFFIX.length);
      conds = mid.split(' AND ');
    } else {
      throw new Error(`FakeFinanceDb: 列表后缀不符：${sql}`);
    }
    const bound = [...params];
    const limit = Number(bound.pop());
    if (conds.length !== bound.length) {
      throw new Error(`FakeFinanceDb: 条件数 ${conds.length} ≠ 参数数 ${bound.length}：${sql}`);
    }
    const matched = this.joined().filter((row) =>
      conds.every((cond, i) => {
        const predicate = OPS_PREDICATES[cond];
        if (!predicate) throw new Error(`FakeFinanceDb: 不认识的条件子句：${cond}`);
        return predicate(row, bound[i]);
      }),
    );
    const sorted = [...matched].sort((a, b) => b.flow.id - a.flow.id);
    return sorted.slice(0, limit).map((row) => this.materialize(row));
  }

  /** 详情：全 flows、`f.id` 升序（无 LIMIT）。 */
  private detail(params: unknown[]): unknown {
    const opId = Number(params[0]);
    return this.joined()
      .filter((row) => row.op.id === opId)
      .sort((a, b) => a.flow.id - b.flow.id)
      .map((row) => this.materialize(row));
  }

  /** groupBy=source：k = source（字符串）、game_type 平铺、delta = DECIMAL ⇒ **字符串**。 */
  private summaryBySource(params: unknown[]): unknown {
    const [from, to] = params as [Date, Date];
    const groups = new Map<string, { k: string; gameType: string | null; delta: number; flowCount: number }>();
    for (const flow of this.flows) {
      if (flow.createdAt.getTime() < from.getTime() || flow.createdAt.getTime() >= to.getTime()) continue;
      const op = this.opOf(flow);
      const key = `${op.source}\u0000${op.gameType ?? ''}`;
      const group = groups.get(key) ?? { k: op.source, gameType: op.gameType, delta: 0, flowCount: 0 };
      group.delta += flow.delta;
      group.flowCount += 1;
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : String(a.gameType).localeCompare(String(b.gameType))))
      .map((g) => ({ k: g.k, game_type: g.gameType, delta: String(g.delta), flowCount: g.flowCount }));
  }

  /** groupBy=day：+08:00 切天；DATE() ⇒ Date 对象；按 (day, game_type) 展开。 */
  private summaryByDay(params: unknown[]): unknown {
    const [from, to] = params as [Date, Date];
    const groups = new Map<string, { k: Date; gameType: string | null; delta: number; flowCount: number }>();
    for (const flow of this.flows) {
      if (flow.createdAt.getTime() < from.getTime() || flow.createdAt.getTime() >= to.getTime()) continue;
      const op = this.opOf(flow);
      const shifted = new Date(flow.createdAt.getTime() + 8 * 60 * 60 * 1000);
      const k = new Date(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
      const key = `${k.getTime()}\u0000${op.gameType ?? ''}`;
      const group = groups.get(key) ?? { k, gameType: op.gameType, delta: 0, flowCount: 0 };
      group.delta += flow.delta;
      group.flowCount += 1;
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((a, b) =>
        a.k.getTime() - b.k.getTime() || String(a.gameType).localeCompare(String(b.gameType)),
      )
      .map((g) => ({ k: g.k, game_type: g.gameType, delta: String(g.delta), flowCount: g.flowCount }));
  }

  /** burn 块：窗口按 `op.createdAt`；residue/rake 合计（NULL 按 0）+ NULL 行数。 */
  private summaryBurn(params: unknown[]): unknown {
    const [from, to] = params as [Date, Date];
    const hits = this.ops.filter(
      (op) =>
        op.source === 'game_settle' &&
        op.createdAt.getTime() >= from.getTime() &&
        op.createdAt.getTime() < to.getTime(),
    );
    const residue = hits.reduce((acc, op) => acc + (op.burnedResidue ?? 0), 0);
    const rake = hits.reduce((acc, op) => acc + (op.burnedRake ?? 0), 0);
    const unrecordedOps = hits.filter((op) => op.burnedResidue === null).length;
    return [{ residue: String(residue), rake: String(rake), unrecordedOps }]; // SUM ⇒ DECIMAL 字符串（S13）
  }

  /** 漏收按玩法块：窗口按 `skips.createdAt`；COUNT ⇒ number、SUM ⇒ DECIMAL 字符串。 */
  private summarySkips(params: unknown[]): unknown {
    const [from, to] = params as [Date, Date];
    const hits = this.skips.filter(
      (s) => s.createdAt.getTime() >= from.getTime() && s.createdAt.getTime() < to.getTime(),
    );
    const players = new Set(hits.map((s) => s.ownerId)).size;
    const amount = hits.reduce((acc, s) => acc + s.feeAmount, 0);
    return [{ cnt: hits.length, players, amount: String(amount) }];
  }

  /** burn 按玩法：0..n 行；分组人数不存在，仅金额/条数/未记录数。 */
  private summaryBurnByGame(params: unknown[]): unknown {
    if (this.burnByGameOverride !== undefined) return this.burnByGameOverride;
    const [from, to] = params as [Date, Date];
    const groups = new Map<string | null, { residue: number; rake: number; unrecordedOps: number }>();
    for (const op of this.ops) {
      if (op.source !== 'game_settle') continue;
      if (op.createdAt.getTime() < from.getTime() || op.createdAt.getTime() >= to.getTime()) continue;
      const group = groups.get(op.gameType) ?? { residue: 0, rake: 0, unrecordedOps: 0 };
      group.residue += op.burnedResidue ?? 0;
      group.rake += op.burnedRake ?? 0;
      if (op.burnedResidue === null) group.unrecordedOps += 1;
      groups.set(op.gameType, group);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([k, group]) => ({
        k,
        residue: String(group.residue),
        rake: String(group.rake),
        unrecordedOps: group.unrecordedOps,
      }));
  }

  /** 漏收按玩法：0..n 行；`players` 为**该玩法内**去重。 */
  private summarySkipsByGame(params: unknown[]): unknown {
    const [from, to] = params as [Date, Date];
    const groups = new Map<string, { cnt: number; owners: Set<string>; amount: number }>();
    for (const skip of this.skips) {
      if (skip.createdAt.getTime() < from.getTime() || skip.createdAt.getTime() >= to.getTime()) continue;
      const group = groups.get(skip.gameType) ?? { cnt: 0, owners: new Set<string>(), amount: 0 };
      group.cnt += 1;
      group.owners.add(skip.ownerId);
      group.amount += skip.feeAmount;
      groups.set(skip.gameType, group);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, group]) => ({
        k,
        cnt: group.cnt,
        players: group.owners.size,
        amount: String(group.amount),
      }));
  }

  private summaryCardCounterPurchases(params: unknown[]): unknown {
    const [from, to] = params as [Date, Date];
    const groups = new Map<string, { cnt: number; owners: Set<string>; amount: number }>();
    for (const row of this.purchases) {
      if (row.createdAt.getTime() < from.getTime() || row.createdAt.getTime() >= to.getTime()) continue;
      const group = groups.get(row.kind) ?? { cnt: 0, owners: new Set<string>(), amount: 0 };
      group.cnt += 1;
      group.owners.add(row.ownerId);
      group.amount += row.price;
      groups.set(row.kind, group);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, group]) => ({
        k,
        cnt: group.cnt,
        players: group.owners.size,
        amount: String(group.amount),
      }));
  }

  private summaryCardCounterConsumptions(params: unknown[]): unknown {
    const [from, to] = params as [Date, Date];
    const groups = new Map<string, { cnt: number; owners: Set<string> }>();
    for (const row of this.consumptions) {
      if (row.createdAt.getTime() < from.getTime() || row.createdAt.getTime() >= to.getTime()) continue;
      const group = groups.get(row.kind) ?? { cnt: 0, owners: new Set<string>() };
      group.cnt += 1;
      group.owners.add(row.ownerId);
      groups.set(row.kind, group);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, group]) => ({ k, cnt: group.cnt, players: group.owners.size }));
  }

  private joined(): Array<{ flow: FakeFlow; op: FakeOp }> {
    return this.flows.map((flow) => ({ flow, op: this.opOf(flow) }));
  }

  private opOf(flow: FakeFlow): FakeOp {
    const op = this.ops.find((o) => o.id === flow.opId);
    if (op === undefined) throw new Error(`假库不变量破坏：flow#${flow.id} 无对应 op#${flow.opId}`);
    return op;
  }

  /** 行形状 = SQL 别名（真 MySQL 的列标签）：与 JSON 行字段逐一对应。 */
  private materialize(row: { flow: FakeFlow; op: FakeOp }): Record<string, unknown> {
    const { flow, op } = row;
    const user = this.users.get(flow.ownerId);
    let reversed: unknown = this.ops.some((o) => o.actionId === `admin:reverse:${op.id}`) ? 1 : 0;
    if (this.reversedAsString) reversed = String(reversed);
    if (this.reversedOverride !== undefined) reversed = this.reversedOverride;
    return {
      flowId: flow.id,
      opId: flow.opId,
      actionId: op.actionId,
      source: op.source,
      gameType: op.gameType,
      actor: op.actor,
      reason: op.reason,
      refId: op.refId,
      traceId: op.traceId,
      burnedResidue: this.burnedRawOverride === undefined ? op.burnedResidue : this.burnedRawOverride,
      burnedRake: op.burnedRake,
      ownerId: flow.ownerId,
      ownerType: flow.ownerType,
      delta: flow.delta,
      balanceAfter: flow.balanceAfter,
      createdAt: flow.createdAt,
      phone: user?.phone ?? null,
      nickname: user?.nickname ?? null,
      reversed,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 真 Nest 管线的 HTTP 探针
 * ------------------------------------------------------------------ */

@Module({})
class FinanceProbeModule {}

interface RawResult {
  status: number;
  headers: Headers;
  /** UTF-8 解码后的响应原文（CSV 断言用；BOM 保留为 U+FEFF 字符）。 */
  text: string;
  /** 原始字节（BOM 首字节断言用）。 */
  buffer: Buffer;
  json: any;
}

interface Probe {
  get: (path: string, headers?: Record<string, string>) => Promise<RawResult>;
  close: () => Promise<void>;
}

async function startProbe(db: FakeFinanceDb): Promise<Probe> {
  const service = new FinanceQueryService(db.dataSource as unknown as DataSource);
  const module: DynamicModule = {
    module: FinanceProbeModule,
    controllers: [AdminFinanceController],
    providers: [
      { provide: FinanceQueryService, useValue: service },
      // ③ T7：控制器构造新增 reverse 路由两依赖（本文件不触 reverse 面）——占位空对象仅供
      // 容器解析（照 `http-probe.ts` startWalletProbe 先例）；那一面一旦被误触会响亮报错。
      { provide: ReverseService, useValue: {} as ReverseService },
      { provide: ApplyService, useValue: {} as ApplyService },
      // ③ T8：控制器构造再增 reconcile 两路由依赖（本文件不触对账面）——同款占位空对象。
      { provide: ReconcileService, useValue: {} as ReconcileService },
    ],
  };
  const app: INestApplication = await NestFactory.create(module, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  return {
    get: async (path, headers = {}) => {
      const res = await fetch(`${url}${path}`, { method: 'GET', headers });
      const buffer = Buffer.from(await res.arrayBuffer());
      const text = buffer.toString('utf8');
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, text, buffer, json };
    },
    close: async () => {
      await app.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const db = new FakeFinanceDb();
let probe: Probe;

beforeAll(async () => {
  probe = await startProbe(db);
});
afterAll(async () => {
  await probe.close();
});
beforeEach(() => {
  db.reset();
});

/** 列表样本：op1（admin_adjust，两户，含 users 行与缺行）+ op2（signup_grant）+ 反转锚。 */
function seedOpsSample(): { opAdjust: FakeOp; opSignup: FakeOp } {
  const opAdjust = db.addOp({ actionId: 'admin:t6-1', source: 'admin_adjust', actor: 'admin', reason: '活动补偿', traceId: 'trace-1' });
  db.setUser('user-a', { phone: '13800000001', nickname: '阿甲' });
  db.addFlow(opAdjust, { ownerId: 'user-a', delta: 100, balanceAfter: 100, createdAt: T1 });
  db.addFlow(opAdjust, { ownerId: 'user-b', delta: -30, balanceAfter: 70, createdAt: T2 });
  const opSignup = db.addOp({ actionId: 'signup:user-c', source: 'signup_grant', actor: null, reason: null });
  db.setUser('user-c', { phone: null, nickname: '丙' });
  db.addFlow(opSignup, { ownerId: 'user-c', delta: 7, balanceAfter: 7, createdAt: T3 });
  // reversed 旗的 EXISTS 锚：`admin:reverse:<op1.id>`（无 flows 也计入 EXISTS）
  db.addOp({ actionId: `admin:reverse:${opAdjust.id}` });
  return { opAdjust, opSignup };
}

/** summary 样本：UTC 同一日的两笔（+08:00 下跨日）+ 另一 source 一笔（负额）。 */
function seedSummarySample(): void {
  const opAdjust = db.addOp({ actionId: 'admin:s-1', source: 'admin_adjust' });
  db.addFlow(opAdjust, { ownerId: 's1', delta: 10, balanceAfter: 10, createdAt: T('2026-10-05T15:59:59.000Z') });
  db.addFlow(opAdjust, { ownerId: 's2', delta: 20, balanceAfter: 30, createdAt: T('2026-10-05T16:00:00.000Z') });
  const opSettle = db.addOp({
    actionId: 'game:s-2',
    source: 'game_settle',
    createdAt: T('2026-10-05T15:00:00.000Z'),
    burnedResidue: 2,
    burnedRake: 3,
  });
  db.addFlow(opSettle, { ownerId: 's3', delta: -5, balanceAfter: 5, createdAt: T('2026-10-05T15:00:00.000Z') });
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('X-Admin fail-closed（五端点同守卫）+ 注册面', () => {
  it('无 X-Admin ⇒ 401/10002，且碰不到 handler（假库零查询）', async () => {
    const paths = [
      '/api/admin/wallet/ops',
      '/api/admin/wallet/ops.csv',
      '/api/admin/wallet/ops/1',
      '/api/admin/wallet/summary',
      '/api/admin/wallet/summary.csv',
    ];
    for (const path of paths) {
      const res = await probe.get(path);
      expect(res.status, path).toBe(401);
      expect(res.json, path).toEqual({
        code: ErrCode.UNAUTHENTICATED,
        message: 'admin header required',
        data: null,
      });
    }
    expect(db.queries).toEqual([]);
  });

  it('注册面（T6 教训）：AppModule 含 AdminFinanceController + FinanceQueryService；类上挂 XAdminGuard', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(AdminFinanceController);
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(FinanceQueryService);
    const guards = Reflect.getMetadata('__guards__', AdminFinanceController) as unknown[];
    expect(guards).toContain(XAdminGuard);
  });
});

describe('GET /api/admin/wallet/ops（JSON；§2.7）', () => {
  it('行形状逐字：join 列 + phone/nickname 缺行 ⇒ null + reversed 布尔 + epoch ms；缺省 limit 50', async () => {
    seedOpsSample();

    const res = await probe.get('/api/admin/wallet/ops', AUTH);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      code: ErrCode.OK,
      data: {
        rows: [
          {
            flowId: 3,
            opId: 2,
            actionId: 'signup:user-c',
            source: 'signup_grant',
            gameType: null,
            actor: null,
            reason: null,
            refId: null,
            traceId: null,
            burnedResidue: null,
            burnedRake: null,
            ownerId: 'user-c',
            ownerType: 'user',
            delta: 7,
            balanceAfter: 7,
            createdAt: T3.getTime(),
            phone: null,
            nickname: '丙',
            reversed: false,
          },
          {
            flowId: 2,
            opId: 1,
            actionId: 'admin:t6-1',
            source: 'admin_adjust',
            gameType: null,
            actor: 'admin',
            reason: '活动补偿',
            refId: null,
            traceId: 'trace-1',
            burnedResidue: null,
            burnedRake: null,
            ownerId: 'user-b',
            ownerType: 'user',
            delta: -30,
            balanceAfter: 70,
            createdAt: T2.getTime(),
            phone: null,
            nickname: null,
            reversed: true,
          },
          {
            flowId: 1,
            opId: 1,
            actionId: 'admin:t6-1',
            source: 'admin_adjust',
            gameType: null,
            actor: 'admin',
            reason: '活动补偿',
            refId: null,
            traceId: 'trace-1',
            burnedResidue: null,
            burnedRake: null,
            ownerId: 'user-a',
            ownerType: 'user',
            delta: 100,
            balanceAfter: 100,
            createdAt: T1.getTime(),
            phone: '13800000001',
            nickname: '阿甲',
            reversed: true,
          },
        ],
        nextCursor: null,
      },
    });
    // SQL 全文（无过滤形态：基句 + ORDER BY LIMIT ?）与缺省 limit=50
    expect(db.queries).toEqual([{ sql: `${OPS_BASE}${OPS_LIST_SUFFIX}`, params: [50] }]);
  });

  it('reversed=EXISTS(admin:reverse:<opId>)：无反转锚 ⇒ false（op2 行已在上例断言）', async () => {
    const op = db.addOp({ actionId: 'admin:t6-norev', source: 'admin_adjust' });
    db.addFlow(op, { ownerId: 'nr-1', delta: 5, balanceAfter: 5, createdAt: T1 });

    const res = await probe.get('/api/admin/wallet/ops', AUTH);

    expect(res.json.data.rows.map((r: any) => r.reversed)).toEqual([false]);
  });

  it('reversed 驱动回值三形态：number 0/1 与 string "0"/"1"（EXISTS 计划路径漂移）都转布尔；其余形态响亮抛', async () => {
    seedOpsSample();
    // 真栈实测（T10 联测）：EXISTS 经 semi-join/物化路径时 mysql2 回字符串 "0"/"1"
    db.reversedAsString = true;

    const res = await probe.get('/api/admin/wallet/ops', AUTH);
    expect(res.status).toBe(200);
    expect(res.json.data.rows.map((r: any) => r.reversed)).toEqual([false, true, true]);
    expect(res.json.data.rows.map((r: any) => typeof r.reversed)).toEqual(['boolean', 'boolean', 'boolean']);

    // 详情面同一条转换（同 join）
    const detail = await probe.get('/api/admin/wallet/ops/1', AUTH);
    expect(detail.json.data.rows.map((r: any) => r.reversed)).toEqual([true, true]);

    // 非 0/1 字符串仍响亮抛（500）——不静默吞成 false（负例钉住「其余形态照旧抛」）
    for (const bad of ['2', 'x']) {
      db.reversedOverride = bad;
      const failed = await probe.get('/api/admin/wallet/ops', AUTH);
      expect(failed.status, String(bad)).toBe(500);
    }
    db.reversedOverride = undefined;
    const recovered = await probe.get('/api/admin/wallet/ops', AUTH);
    expect(recovered.status).toBe(200);
  });

  it('burn 块（本片）：ops 列表带两字段实值；畸形驱动回值 ⇒ 500 响亮', async () => {
    const op = db.addOp({
      actionId: 'game:s-7',
      source: 'game_settle',
      createdAt: T1,
      burnedResidue: 5,
      burnedRake: 0,
    });
    db.addFlow(op, { ownerId: 's7', delta: -5, balanceAfter: 5, createdAt: T1 });

    const res = await probe.get('/api/admin/wallet/ops?source=game_settle&limit=50', AUTH);
    expect(res.status).toBe(200);
    const row = (res.json.data.rows as any[])[0];
    expect(row.burnedResidue).toBe(5);
    expect(row.burnedRake).toBe(0);

    db.burnedRawOverride = 'x'; // 真畸形（`'5'` 这类数字串会被 toSafeInt 收下，不是负例——须用转换函数真拒的形态）
    const bad = await probe.get('/api/admin/wallet/ops?source=game_settle&limit=50', AUTH);
    expect(bad.status).toBe(500);
  });

  it('六过滤全 AND：source/actor/ownerId/from/to/cursor 逐条 + 全组合（SQL 全文相等 + new Date 绑定）', async () => {
    seedOpsSample();
    const FR = T('2026-10-05T09:00:00.000Z').getTime();
    const TO = T('2026-10-05T12:00:00.000Z').getTime();

    const bySource = await probe.get('/api/admin/wallet/ops?source=signup_grant', AUTH);
    expect(bySource.json.data.rows.map((r: any) => r.flowId)).toEqual([3]);
    expect(db.queries.at(-1)).toEqual({
      sql: `${OPS_BASE} WHERE o.source = ?${OPS_LIST_SUFFIX}`,
      params: ['signup_grant', 50],
    });

    const byActor = await probe.get('/api/admin/wallet/ops?actor=admin', AUTH);
    expect(byActor.json.data.rows.map((r: any) => r.flowId)).toEqual([2, 1]);
    expect(db.queries.at(-1)!.sql).toBe(`${OPS_BASE} WHERE o.actor = ?${OPS_LIST_SUFFIX}`);

    const byOwner = await probe.get('/api/admin/wallet/ops?ownerId=user-b', AUTH);
    expect(byOwner.json.data.rows.map((r: any) => r.flowId)).toEqual([2]);
    expect(db.queries.at(-1)!.sql).toBe(`${OPS_BASE} WHERE f.owner_id = ?${OPS_LIST_SUFFIX}`);

    // from 含边界（T2 行在）、to 不含边界（T2 行不在）
    const from = await probe.get(`/api/admin/wallet/ops?from=${T2.getTime()}`, AUTH);
    expect(from.json.data.rows.map((r: any) => r.flowId)).toEqual([3, 2]);
    expect(db.queries.at(-1)!.sql).toBe(`${OPS_BASE} WHERE f.created_at >= ?${OPS_LIST_SUFFIX}`);
    expect(db.queries.at(-1)!.params).toEqual([new Date(T2.getTime()), 50]);

    const to = await probe.get(`/api/admin/wallet/ops?to=${T2.getTime()}`, AUTH);
    expect(to.json.data.rows.map((r: any) => r.flowId)).toEqual([1]);
    expect(db.queries.at(-1)!.params).toEqual([new Date(T2.getTime()), 50]);

    // 全组合（六条件按规格列序：source→actor→ownerId→from→to→cursor，再 LIMIT）
    const all = await probe.get(
      `/api/admin/wallet/ops?source=admin_adjust&actor=admin&ownerId=user-a&from=${FR}&to=${TO}&cursor=100&limit=10`,
      AUTH,
    );
    expect(all.json.data.rows.map((r: any) => r.flowId)).toEqual([1]);
    expect(db.queries.at(-1)).toEqual({
      sql:
        `${OPS_BASE} WHERE o.source = ? AND o.actor = ? AND f.owner_id = ? AND f.created_at >= ? ` +
        `AND f.created_at < ? AND f.id < ?${OPS_LIST_SUFFIX}`,
      params: ['admin_adjust', 'admin', 'user-a', new Date(FR), new Date(TO), 100, 10],
    });
  });

  it('keyset：limit=2 ⇒ nextCursor=末行 flowId；cursor 取下一页（恰满页照给）；短页 ⇒ null', async () => {
    const op = db.addOp({ actionId: 'admin:t6-keyset' });
    for (let i = 0; i < 4; i += 1) {
      db.addFlow(op, { ownerId: `ks-${i}`, delta: i + 1, balanceAfter: i + 1, createdAt: new Date(T1.getTime() + i * 1000) });
    }

    const page1 = await probe.get('/api/admin/wallet/ops?limit=2', AUTH);
    expect(page1.json.data.rows.map((r: any) => r.flowId)).toEqual([4, 3]);
    expect(page1.json.data.nextCursor).toBe(3);

    const page2 = await probe.get('/api/admin/wallet/ops?limit=2&cursor=3', AUTH);
    expect(page2.json.data.rows.map((r: any) => r.flowId)).toEqual([2, 1]);
    expect(page2.json.data.nextCursor).toBe(1);
    expect(db.queries.at(-1)).toEqual({
      sql: `${OPS_BASE} WHERE f.id < ?${OPS_LIST_SUFFIX}`,
      params: [3, 2],
    });

    // 短页（< limit）⇒ nextCursor = null（末页）
    const page3 = await probe.get('/api/admin/wallet/ops?limit=2&cursor=1', AUTH);
    expect(page3.json.data.rows).toEqual([]);
    expect(page3.json.data.nextCursor).toBeNull();
  });

  it('真分页读数：缺省 50 截 51 行（nextCursor=末行 flowId，无存在性预查）；limit=100 上限可用', async () => {
    const op = db.addOp({ actionId: 'admin:t6-bulk51' });
    db.addFlowRange(op, 51);

    const dflt = await probe.get('/api/admin/wallet/ops', AUTH);
    expect(dflt.json.data.rows).toHaveLength(50);
    expect(dflt.json.data.rows[0].flowId).toBe(51);
    expect(dflt.json.data.nextCursor).toBe(2); // 第 50 行 = flowId 2

    const full = await probe.get('/api/admin/wallet/ops?limit=100', AUTH);
    expect(full.json.data.rows).toHaveLength(51);
    expect(full.json.data.nextCursor).toBeNull();
  });

  it('过滤值非法 ⇒ 400 精确文案，且**未碰库**（校验先于查库）', async () => {
    const cases: Array<[string, string, string]> = [
      ['limit=0', 'limit 非法：须为 1–100 的整数', 'limit 下界'],
      ['limit=101', 'limit 非法：须为 1–100 的整数', 'limit 上限'],
      ['limit=abc', 'limit 非法：须为 1–100 的整数', 'limit 非数'],
      ['limit=1.5', 'limit 非法：须为 1–100 的整数', 'limit 小数'],
      ['limit=-1', 'limit 非法：须为 1–100 的整数', 'limit 负'],
      ['cursor=0', 'cursor 非法：须为正整数', 'cursor 下界'],
      ['cursor=abc', 'cursor 非法：须为正整数', 'cursor 非数'],
      ['from=abc', 'from 非法：须为非负整数（epoch 毫秒）', 'from 非数'],
      ['from=-5', 'from 非法：须为非负整数（epoch 毫秒）', 'from 负'],
      ['from=9007199254740991', 'from 非法：须为非负整数（epoch 毫秒）', 'from 超 Date 域'],
      ['to=1.5', 'to 非法：须为非负整数（epoch 毫秒）', 'to 小数'],
      ['source=bogus', 'source 非法：须为货币来源 allowlist 之一', 'source 非成员'],
      ['source=', 'source 非法：须为货币来源 allowlist 之一', 'source 空串'],
      ['source=admin_adjust&source=signup_grant', 'source 非法：须为货币来源 allowlist 之一', 'source 重复参数'],
      ['actor=Admin', 'actor 非法：须为 3–32 位小写字母/数字/._-', 'actor 大写'],
      ['actor=', 'actor 非法：须为 3–32 位小写字母/数字/._-', 'actor 空串'],
      [`actor=${'a'.repeat(33)}`, 'actor 非法：须为 3–32 位小写字母/数字/._-', 'actor 超长'],
      ['ownerId=', 'ownerId 非法：长度须为 1–36', 'ownerId 空串'],
      [`ownerId=${'o'.repeat(37)}`, 'ownerId 非法：长度须为 1–36', 'ownerId 超列宽'],
    ];
    for (const [qs, message, label] of cases) {
      const res = await probe.get(`/api/admin/wallet/ops?${qs}`, AUTH);
      expect(res.status, label).toBe(400);
      expect(res.json, label).toEqual({ code: ErrCode.BAD_PARAM, message, data: null });
    }
    expect(db.queries).toEqual([]);
  });

  it('allowlist 十一值全部放行（含 admin_reverse 与支付五源）；未知 query 键 ⇒ 400「未知查询参数：<key>」（未碰库）', async () => {
    for (const source of CURRENCY_SOURCES) {
      const res = await probe.get(`/api/admin/wallet/ops?source=${source}`, AUTH);
      expect(res.status, source).toBe(200);
    }

    const unknown = await probe.get('/api/admin/wallet/ops?foo=1', AUTH);
    expect(unknown.status).toBe(400);
    expect(unknown.json).toEqual({
      code: ErrCode.BAD_PARAM,
      message: '未知查询参数：foo',
      data: null,
    });
  });
});

describe('GET /api/admin/wallet/ops/:opId（详情；§2.7）', () => {
  it('多账户 op：全 flows、`f.id` 升序、行形状同列表；SQL 全文相等', async () => {
    const op = db.addOp({ actionId: 'admin:t6-multi', source: 'admin_adjust', actor: 'boss.super', reason: '三户发放', traceId: 'trace-m' });
    db.setUser('m1', { phone: '13900000001', nickname: '甲' });
    db.setUser('m3', { phone: null, nickname: null });
    db.addFlow(op, { ownerId: 'm1', delta: 10, balanceAfter: 10, createdAt: T1 });
    db.addFlow(op, { ownerId: 'm2', delta: 20, balanceAfter: 30, createdAt: T2 });
    db.addFlow(op, { ownerId: 'm3', delta: -25, balanceAfter: 5, createdAt: T3 });

    const res = await probe.get(`/api/admin/wallet/ops/${op.id}`, AUTH);

    expect(res.status).toBe(200);
    const rows = res.json.data.rows as any[];
    expect(rows.map((r) => r.flowId)).toEqual([1, 2, 3]); // f.id 升序（执行序）
    expect(rows.map((r) => r.ownerId)).toEqual(['m1', 'm2', 'm3']);
    expect(rows[0]).toEqual({
      flowId: 1,
      opId: op.id,
      actionId: 'admin:t6-multi',
      source: 'admin_adjust',
      gameType: null,
      actor: 'boss.super',
      reason: '三户发放',
      refId: null,
      traceId: 'trace-m',
      burnedResidue: null,
      burnedRake: null,
      ownerId: 'm1',
      ownerType: 'user',
      delta: 10,
      balanceAfter: 10,
      createdAt: T1.getTime(),
      phone: '13900000001',
      nickname: '甲',
      reversed: false,
    });
    expect(rows[1].phone).toBeNull(); // LEFT JOIN miss ⇒ null
    expect(db.queries).toEqual([{ sql: OPS_DETAIL_SQL, params: [op.id] }]);
  });

  it('reversed 旗随 EXISTS 翻转（详情面同 join）', async () => {
    const op = db.addOp({ actionId: 'admin:t6-rev', source: 'admin_adjust' });
    db.addFlow(op, { ownerId: 'r-1', delta: 3, balanceAfter: 3, createdAt: T1 });
    db.addOp({ actionId: `admin:reverse:${op.id}` });

    const res = await probe.get(`/api/admin/wallet/ops/${op.id}`, AUTH);

    expect(res.json.data.rows.map((r: any) => r.reversed)).toEqual([true]);
  });

  it('未知 query 键静默丢弃（非列表端点——⚙️9）；op 不存在 ⇒ 404 借 10001「操作不存在」', async () => {
    seedOpsSample();

    const ignored = await probe.get('/api/admin/wallet/ops/1?whatever=1', AUTH);
    expect(ignored.status).toBe(200);

    const missing = await probe.get('/api/admin/wallet/ops/999', AUTH);
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ code: ErrCode.BAD_PARAM, message: '操作不存在', data: null });
  });

  it('opId 非法（非十进制正整数）⇒ 400「opId 非法：须为正整数」且未碰库', async () => {
    for (const opId of ['abc', '0', '-1', '1.5', '1e3']) {
      const res = await probe.get(`/api/admin/wallet/ops/${opId}`, AUTH);
      expect(res.status, opId).toBe(400);
      expect(res.json, opId).toEqual({
        code: ErrCode.BAD_PARAM,
        message: 'opId 非法：须为正整数',
        data: null,
      });
    }
    expect(db.queries).toEqual([]);
  });
});

describe('GET /api/admin/wallet/summary（§2.7）', () => {
  it('groupBy=source（缺省）：分组行 + totals；k 字符串、delta/flowCount 数字（驱动回值转换）', async () => {
    seedSummarySample();
    const from = T('2026-10-05T00:00:00.000Z').getTime();
    const to = T('2026-10-07T00:00:00.000Z').getTime();

    const res = await probe.get(`/api/admin/wallet/summary?from=${from}&to=${to}`, AUTH);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      code: ErrCode.OK,
      data: {
        rows: [
          { k: 'admin_adjust', gameType: null, delta: 30, flowCount: 2 },
          { k: 'game_settle', gameType: null, delta: -5, flowCount: 1 },
        ],
        totals: { delta: 25, flowCount: 3 },
        burn: { residue: 2, rake: 3, unrecordedOps: 0 },
        burnByGame: [{ gameType: null, residue: 2, rake: 3, unrecordedOps: 0 }],
        entryFeeSkips: { cnt: 0, players: 0, amount: 0 },
        entryFeeSkipsByGame: [],
        cardCounterPurchases: ZERO_CC_PURCHASES,
        cardCounterConsumptions: ZERO_CC_CONSUMPTIONS,
      },
    });
    // 型别钉（S13）：假库按驱动真形态回值（SUM ⇒ DECIMAL 字符串、COUNT ⇒ number）
    expect(typeof res.json.data.rows[0].k).toBe('string');
    expect(typeof res.json.data.rows[0].delta).toBe('number');
    expect(typeof res.json.data.rows[0].flowCount).toBe('number');
    // 次序钉死：group → burn → skips → purchases → consumptions → burnByGame → skipsByGame
    expect(db.queries).toEqual([
      { sql: SUMMARY_SOURCE_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_BURN_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_SKIPS_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_CARD_COUNTER_PURCHASES_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_CARD_COUNTER_CONSUMPTIONS_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_BURN_BY_GAME_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_SKIPS_BY_GAME_SQL, params: [new Date(from), new Date(to)] },
    ]);
  });

  it('groupBy=day：+08:00 切天（UTC 同日两笔跨北京日界）+ totals；SQL 全文相等', async () => {
    seedSummarySample();
    const from = T('2026-10-05T00:00:00.000Z').getTime();
    const to = T('2026-10-07T00:00:00.000Z').getTime();

    const res = await probe.get(`/api/admin/wallet/summary?from=${from}&to=${to}&groupBy=day`, AUTH);

    expect(res.status).toBe(200);
    // 15:59:59Z（北京 10-05 23:59:59）与 15:00:00Z 同属 10-05；16:00:00Z（北京 10-06 00:00:00）归 10-06
    expect(res.json.data).toEqual({
      rows: [
        { k: '2026-10-05', gameType: null, delta: 5, flowCount: 2 },
        { k: '2026-10-06', gameType: null, delta: 20, flowCount: 1 },
      ],
      totals: { delta: 25, flowCount: 3 },
      burn: { residue: 2, rake: 3, unrecordedOps: 0 },
      burnByGame: [{ gameType: null, residue: 2, rake: 3, unrecordedOps: 0 }],
      entryFeeSkips: { cnt: 0, players: 0, amount: 0 },
      entryFeeSkipsByGame: [],
        cardCounterPurchases: ZERO_CC_PURCHASES,
        cardCounterConsumptions: ZERO_CC_CONSUMPTIONS,
    });
    expect(res.json.data.rows.map((r: any) => typeof r.k)).toEqual(['string', 'string']);
    // 次序钉死：group → burn → skips → purchases → consumptions → burnByGame → skipsByGame
    expect(db.queries).toEqual([
      { sql: SUMMARY_DAY_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_BURN_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_SKIPS_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_CARD_COUNTER_PURCHASES_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_CARD_COUNTER_CONSUMPTIONS_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_BURN_BY_GAME_SQL, params: [new Date(from), new Date(to)] },
      { sql: SUMMARY_SKIPS_BY_GAME_SQL, params: [new Date(from), new Date(to)] },
    ]);
  });

  it('半开区间：from 含边界、to 不含边界', async () => {
    seedSummarySample();
    const from = T('2026-10-05T15:00:00.000Z').getTime(); // = s3 行
    const to = T('2026-10-05T16:00:00.000Z').getTime(); // = s2 行（不含）

    const res = await probe.get(`/api/admin/wallet/summary?from=${from}&to=${to}`, AUTH);

    expect(res.json.data).toEqual({
      rows: [
        { k: 'admin_adjust', gameType: null, delta: 10, flowCount: 1 },
        { k: 'game_settle', gameType: null, delta: -5, flowCount: 1 },
      ],
      totals: { delta: 5, flowCount: 2 },
      burn: { residue: 2, rake: 3, unrecordedOps: 0 },
      burnByGame: [{ gameType: null, residue: 2, rake: 3, unrecordedOps: 0 }],
      entryFeeSkips: { cnt: 0, players: 0, amount: 0 },
      entryFeeSkipsByGame: [],
        cardCounterPurchases: ZERO_CC_PURCHASES,
        cardCounterConsumptions: ZERO_CC_CONSUMPTIONS,
    });
  });

  it('burn 块：窗口按 op.created_at；unrecordedOps 计 NULL 行', async () => {
    seedSummarySample();
    db.addOp({ actionId: 'game:s-9', source: 'game_settle', createdAt: T('2026-10-06T10:00:00.000Z') });
    const from = T('2026-10-05T00:00:00.000Z').getTime();
    const to = T('2026-10-07T00:00:00.000Z').getTime();

    const res = await probe.get(`/api/admin/wallet/summary?from=${from}&to=${to}`, AUTH);

    expect(res.json.data.burn).toEqual({ residue: 2, rake: 3, unrecordedOps: 1 });
  });

  it('缺省窗口逐字：to=now+1ms、from=to−30d；只给 to ⇒ from=to−30d；只给 from ⇒ to=now+1ms', async () => {
    const before = Date.now();
    const dflt = await probe.get('/api/admin/wallet/summary', AUTH);
    const after = Date.now();
    expect(dflt.status).toBe(200);
    const [fromMs, toMs] = (db.queries.at(-1)!.params as [Date, Date]).map((d) => d.getTime());
    expect(toMs - 1).toBeGreaterThanOrEqual(before);
    expect(toMs - 1).toBeLessThanOrEqual(after);
    expect(fromMs).toBe(toMs - 30 * DAY_MS);
    expect(db.queries.at(-7)!.sql).toBe(SUMMARY_SOURCE_SQL);
    expect(db.queries.at(-6)!.sql).toBe(SUMMARY_BURN_SQL);
    expect(db.queries.at(-5)!.sql).toBe(SUMMARY_SKIPS_SQL);
    expect(db.queries.at(-4)!.sql).toBe(SUMMARY_CARD_COUNTER_PURCHASES_SQL);
    expect(db.queries.at(-3)!.sql).toBe(SUMMARY_CARD_COUNTER_CONSUMPTIONS_SQL);
    expect(db.queries.at(-2)!.sql).toBe(SUMMARY_BURN_BY_GAME_SQL);
    expect(db.queries.at(-1)!.sql).toBe(SUMMARY_SKIPS_BY_GAME_SQL);

    const toOnly = await probe.get(`/api/admin/wallet/summary?to=${1_800_000_000_000}`, AUTH);
    expect(toOnly.status).toBe(200);
    expect(db.queries.at(-1)!.params).toEqual([
      new Date(1_800_000_000_000 - 30 * DAY_MS),
      new Date(1_800_000_000_000),
    ]);

    const before2 = Date.now();
    const fromOnly = await probe.get(`/api/admin/wallet/summary?from=${1_700_000_000_000}`, AUTH);
    const after2 = Date.now();
    expect(fromOnly.status).toBe(200);
    const params2 = db.queries.at(-1)!.params as [Date, Date];
    expect(params2[0].getTime()).toBe(1_700_000_000_000);
    expect(params2[1].getTime() - 1).toBeGreaterThanOrEqual(before2);
    expect(params2[1].getTime() - 1).toBeLessThanOrEqual(after2);
  });

  it('空窗 ⇒ rows:[] + totals 全 0（不是错误面）', async () => {
    seedSummarySample();
    const at = T('2000-01-01T00:00:00.000Z').getTime();

    const res = await probe.get(`/api/admin/wallet/summary?from=${at}&to=${at}`, AUTH);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      code: ErrCode.OK,
      data: {
        rows: [],
        totals: { delta: 0, flowCount: 0 },
        burn: { residue: 0, rake: 0, unrecordedOps: 0 },
        burnByGame: [],
        entryFeeSkips: { cnt: 0, players: 0, amount: 0 },
        entryFeeSkipsByGame: [],
        cardCounterPurchases: ZERO_CC_PURCHASES,
        cardCounterConsumptions: ZERO_CC_CONSUMPTIONS,
      },
    });
  });

  it('groupBy 非法 / from·to 非法 / 未知键 ⇒ 400（未碰库）', async () => {
    for (const [qs, message] of [
      ['groupBy=source2', 'groupBy 非法：须为 source 或 day'],
      ['groupBy=Source', 'groupBy 非法：须为 source 或 day'],
      ['groupBy=', 'groupBy 非法：须为 source 或 day'],
      ['from=abc', 'from 非法：须为非负整数（epoch 毫秒）'],
      ['to=-1', 'to 非法：须为非负整数（epoch 毫秒）'],
      ['group=source', '未知查询参数：group'],
    ] as Array<[string, string]>) {
      const res = await probe.get(`/api/admin/wallet/summary?${qs}`, AUTH);
      expect(res.status, qs).toBe(400);
      expect(res.json, qs).toEqual({ code: ErrCode.BAD_PARAM, message, data: null });
    }
    expect(db.queries).toEqual([]);
  });

  it('漏收块：有行时 cnt/players/amount 正确（去重人数 + 金额合计）；次序五连按 db.queries 锚定', async () => {
    seedSummarySample();
    db.addSkip({ ownerId: 'k-1', feeAmount: 1, createdAt: T('2026-10-05T15:00:00.100Z') });
    db.addSkip({ ownerId: 'k-1', feeAmount: 2, createdAt: T('2026-10-05T15:00:00.200Z') });
    db.addSkip({ ownerId: 'k-2', feeAmount: 3, createdAt: T('2026-10-05T15:00:00.300Z') });
    const from = T('2026-10-05T00:00:00.000Z').getTime();
    const to = T('2026-10-07T00:00:00.000Z').getTime();

    const res = await probe.get(`/api/admin/wallet/summary?from=${from}&to=${to}`, AUTH);

    expect(res.status).toBe(200);
    expect(res.json.data.entryFeeSkips).toEqual({ cnt: 3, players: 2, amount: 6 });
    expect(db.queries.at(-7)!.sql).toBe(SUMMARY_SOURCE_SQL);
    expect(db.queries.at(-6)!.sql).toBe(SUMMARY_BURN_SQL);
    expect(db.queries.at(-5)!.sql).toBe(SUMMARY_SKIPS_SQL);
    expect(db.queries.at(-4)!.sql).toBe(SUMMARY_CARD_COUNTER_PURCHASES_SQL);
    expect(db.queries.at(-3)!.sql).toBe(SUMMARY_CARD_COUNTER_CONSUMPTIONS_SQL);
    expect(db.queries.at(-2)!.sql).toBe(SUMMARY_BURN_BY_GAME_SQL);
    expect(db.queries.at(-1)!.sql).toBe(SUMMARY_SKIPS_BY_GAME_SQL);
  });

  it('漏收块：窗口按 skips.created_at（半开）——窗外行不计', async () => {
    seedSummarySample();
    db.addSkip({ ownerId: 'k-out', feeAmount: 9, createdAt: T('2026-10-01T00:00:00.000Z') }); // 窗外
    const from = T('2026-10-05T00:00:00.000Z').getTime();
    const to = T('2026-10-07T00:00:00.000Z').getTime();

    const res = await probe.get(`/api/admin/wallet/summary?from=${from}&to=${to}`, AUTH);

    expect(res.json.data.entryFeeSkips).toEqual({ cnt: 0, players: 0, amount: 0 });
  });

  it('记牌器购买/使用块：按 kind 聚合、窗口半开、使用含 none（固定行补零）', async () => {
    db.addPurchase({ kind: 'game', ownerId: 'cc-1', price: 10, createdAt: T('2026-10-05T10:00:00Z') });
    db.addPurchase({ kind: 'game', ownerId: 'cc-1', price: 10, createdAt: T('2026-10-05T10:00:01Z') });
    db.addPurchase({ kind: 'hour', ownerId: 'cc-2', price: 100, createdAt: T('2026-10-05T10:00:02Z') });
    // 窗外：不计
    db.addPurchase({ kind: 'game', ownerId: 'cc-3', price: 10, createdAt: T('2026-10-09T10:00:00Z') });
    db.addConsumption({ kind: 'credit', ownerId: 'cc-1', createdAt: T('2026-10-05T11:00:00Z') });
    db.addConsumption({ kind: 'none', ownerId: 'cc-2', createdAt: T('2026-10-05T11:00:01Z') });

    const from = T('2026-10-05T00:00:00.000Z').getTime();
    const to = T('2026-10-07T00:00:00.000Z').getTime();
    const res = await probe.get(`/api/admin/wallet/summary?from=${from}&to=${to}`, AUTH);

    expect(res.status).toBe(200);
    expect(res.json.data.cardCounterPurchases).toEqual([
      { kind: 'game', count: 2, players: 1, amount: 20 },
      { kind: 'hour', count: 1, players: 1, amount: 100 },
    ]);
    expect(res.json.data.cardCounterConsumptions).toEqual([
      { kind: 'pass', count: 0, players: 0 },
      { kind: 'credit', count: 1, players: 1 },
      { kind: 'none', count: 1, players: 1 },
    ]);
  });
});

describe('CSV 两面（§2.11）', () => {
  it('ops.csv：BOM 首字节 / 行尾 CRLF / 中文表头逐字 / 消毒样本（=cmd 前置 ’、负数不动）/ 文件名', async () => {
    const op1 = db.addOp({ actionId: 'admin:t6-csv', source: 'admin_adjust', actor: 'admin', reason: '=cmd|生变', traceId: 'tr' });
    db.setUser('csv-u1', { phone: null, nickname: '=1+1' });
    db.addFlow(op1, { ownerId: 'csv-u1', delta: 120, balanceAfter: 120, createdAt: T1 });
    const op2 = db.addOp({ actionId: 'admin:t6-csv2', source: 'admin_adjust', reason: '含,逗号"引号' });
    db.setUser('csv-u2', { phone: '123,456', nickname: null });
    db.addFlow(op2, { ownerId: 'csv-u2', delta: -30, balanceAfter: 90, createdAt: T2 });

    const res = await probe.get('/api/admin/wallet/ops.csv', AUTH);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="flows-\d{8}-\d{6}\.csv"$/,
    );
    // BOM = 首字节 EF BB BF（UTF-8 编码的 U+FEFF）
    expect([res.buffer[0], res.buffer[1], res.buffer[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    // 逐字全文：traceId 列**不在**（§2.11 列集合 = JSON 行字段去 traceId）；id DESC；
    // reason '=cmd…' 消毒前缀 `'`；'含,逗号"引号' 引号包裹 + 内部双写；-30 数字豁免；null ⇒ 空
    expect(res.text).toBe(
      CSV_BOM +
        [
          '流水ID,操作ID,幂等锚,来源,玩法,操作者,原因,关联ID,账户ID,账户类型,金额,操作后余额,时间,手机号,昵称,已冲正',
          `2,2,admin:t6-csv2,admin_adjust,—,admin,"含,逗号""引号",,csv-u2,user,-30,90,${T2.getTime()},"123,456",,false`,
          `1,1,admin:t6-csv,admin_adjust,—,admin,'=cmd|生变,,csv-u1,user,120,120,${T1.getTime()},,'=1+1,false`,
        ].join('\r\n') +
        '\r\n',
    );
    expect(/[^\r]\n/.test(res.text)).toBe(false); // 行尾一律 CRLF（无裸 LF）
  });

  it('ops.csv：过滤键照常可用（SQL 全文 + 50,001 探针上限绑定）；白名单去 cursor/limit（带上即 400）', async () => {
    const op = db.addOp({ actionId: 'admin:t6-csv-f', source: 'admin_adjust' });
    db.addFlow(op, { ownerId: 'f-1', delta: 1, balanceAfter: 1, createdAt: T1 });

    const res = await probe.get(
      `/api/admin/wallet/ops.csv?source=admin_adjust&from=${T1.getTime()}&to=${T3.getTime()}`,
      AUTH,
    );
    expect(res.status).toBe(200);
    expect(db.queries.at(-1)).toEqual({
      sql: `${OPS_BASE} WHERE o.source = ? AND f.created_at >= ? AND f.created_at < ?${OPS_LIST_SUFFIX}`,
      params: ['admin_adjust', new Date(T1.getTime()), new Date(T3.getTime()), 50_001],
    });

    for (const [path, key] of [
      ['/api/admin/wallet/ops.csv?limit=10', 'limit'],
      ['/api/admin/wallet/ops.csv?cursor=1', 'cursor'],
      ['/api/admin/wallet/summary.csv?limit=10', 'limit'],
      ['/api/admin/wallet/ops.csv?nope=1', 'nope'],
    ] as Array<[string, string]>) {
      const bad = await probe.get(path, AUTH);
      expect(bad.status, path).toBe(400);
      expect(bad.json, path).toEqual({
        code: ErrCode.BAD_PARAM,
        message: `未知查询参数：${key}`,
        data: null,
      });
    }
  });

  it('summary.csv：BOM / CRLF / 表头逐字 / 文件名；groupBy=day 可用、非法 ⇒ 400', async () => {
    seedSummarySample();
    const from = T('2026-10-05T00:00:00.000Z').getTime();
    const to = T('2026-10-07T00:00:00.000Z').getTime();

    const res = await probe.get(`/api/admin/wallet/summary.csv?groupBy=day&from=${from}&to=${to}`, AUTH);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="summary-\d{8}-\d{6}\.csv"$/,
    );
    expect([res.buffer[0], res.buffer[1], res.buffer[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.text).toBe(
      CSV_BOM +
        [
          '分组,玩法,金额合计,流水笔数',
          '2026-10-05,—,5,2',
          '2026-10-06,—,20,1',
        ].join('\r\n') +
        '\r\n',
    );

    const bySource = await probe.get(`/api/admin/wallet/summary.csv?from=${from}&to=${to}`, AUTH);
    expect(bySource.text).toBe(
      CSV_BOM +
        [
          '分组,玩法,金额合计,流水笔数',
          'admin_adjust,—,30,2',
          'game_settle,—,-5,1',
        ].join('\r\n') +
        '\r\n',
    );

    const bad = await probe.get('/api/admin/wallet/summary.csv?groupBy=week', AUTH);
    expect(bad.status).toBe(400);
    expect(bad.json.message).toBe('groupBy 非法：须为 source 或 day');
  });
});

describe('flows.csv 50,000 行上限（§2.11）', () => {
  it(
    '恰 50,000 行 ⇒ 全量出（上限不误伤）',
    async () => {
      const op = db.addOp({ actionId: 'admin:t6-cap' });
      db.addFlowRange(op, 50_000);

      const res = await probe.get('/api/admin/wallet/ops.csv', AUTH);

      expect(res.status).toBe(200);
      expect(res.text.split('\r\n')).toHaveLength(50_002); // 表头 + 50,000 行 + 末尾空段
    },
    30_000,
  );

  it(
    '超上限（50,001 行）⇒ 400 借 10001「范围过大，请收窄时间区间」（探针 LIMIT 50,001 的读数）',
    async () => {
      const op = db.addOp({ actionId: 'admin:t6-over' });
      db.addFlowRange(op, 50_001);

      const res = await probe.get('/api/admin/wallet/ops.csv', AUTH);

      expect(res.status).toBe(400);
      expect(res.json).toEqual({
        code: ErrCode.BAD_PARAM,
        message: '范围过大，请收窄时间区间',
        data: null,
      });
      // 探针上限确有上界（SQL 末参 = 50,001，不是全量拉）
      expect((db.queries.at(-1)!.params as unknown[]).at(-1)).toBe(50_001);
    },
    30_000,
  );
});

describe('A2 财务玩法维度（列表筛选/汇总展开/burn+漏收按玩法）', () => {
  const WINDOW = `from=${T1.getTime() - 1}&to=${T3.getTime() + 1}`;

  it('列表：gameType 精确筛选 + 行带 gameType；非法值 400 且未碰库', async () => {
    const ddz = db.addOp({ actionId: 'g-ddz', source: 'game_settle', gameType: 'doudizhu' });
    const pdk = db.addOp({ actionId: 'g-pdk', source: 'game_settle', gameType: 'paodekuai' });
    db.addFlow(ddz, { ownerId: 'a', delta: 10, balanceAfter: 10, createdAt: T1 });
    db.addFlow(pdk, { ownerId: 'b', delta: 20, balanceAfter: 20, createdAt: T2 });

    const res = await probe.get('/api/admin/wallet/ops?gameType=paodekuai&limit=50', AUTH);
    expect(res.status).toBe(200);
    expect(res.json.data.rows).toHaveLength(1);
    expect(res.json.data.rows[0]).toMatchObject({
      actionId: 'g-pdk',
      gameType: 'paodekuai',
      delta: 20,
    });

    const before = db.queries.length;
    const bad = await probe.get('/api/admin/wallet/ops?gameType=ddz', AUTH);
    expect(bad.status).toBe(400);
    expect(bad.json.message).toBe('gameType 非法：须为 doudizhu 或 paodekuai');
    expect(db.queries).toHaveLength(before);
  });

  it('summary(source)：同 source 两玩法 ⇒ 两行（k 相同、gameType 不同），totals = 各行之和', async () => {
    const ddz = db.addOp({ actionId: 'sum-ddz', source: 'game_settle', gameType: 'doudizhu' });
    const pdk = db.addOp({ actionId: 'sum-pdk', source: 'game_settle', gameType: 'paodekuai' });
    db.addFlow(ddz, { ownerId: 'a', delta: 10, balanceAfter: 10, createdAt: T1 });
    db.addFlow(pdk, { ownerId: 'b', delta: 20, balanceAfter: 20, createdAt: T2 });
    db.addFlow(pdk, { ownerId: 'c', delta: -5, balanceAfter: 15, createdAt: T2 });

    const res = await probe.get(`/api/admin/wallet/summary?groupBy=source&${WINDOW}`, AUTH);
    expect(res.status).toBe(200);
    const rows = res.json.data.rows as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { k: 'game_settle', gameType: 'doudizhu', delta: 10, flowCount: 1 },
      { k: 'game_settle', gameType: 'paodekuai', delta: 15, flowCount: 2 },
    ]);
    expect(res.json.data.totals).toEqual({ delta: 25, flowCount: 3 });
  });

  it('summary(day)：按 (day, gameType) 展开，同一天两玩法两行', async () => {
    const ddz = db.addOp({ actionId: 'day-ddz', source: 'game_settle', gameType: 'doudizhu' });
    const pdk = db.addOp({ actionId: 'day-pdk', source: 'game_settle', gameType: 'paodekuai' });
    db.addFlow(ddz, { ownerId: 'a', delta: 10, balanceAfter: 10, createdAt: T1 });
    db.addFlow(pdk, { ownerId: 'b', delta: 20, balanceAfter: 20, createdAt: T2 });

    const res = await probe.get(`/api/admin/wallet/summary?groupBy=day&${WINDOW}`, AUTH);
    expect(res.status).toBe(200);
    const rows = res.json.data.rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.gameType).sort()).toEqual(['doudizhu', 'paodekuai']);
    expect(res.json.data.totals).toEqual({ delta: 30, flowCount: 2 });
  });

  it('burn/漏收：保留总数（players 全局去重）并新增按玩法明细', async () => {
    const ddz = db.addOp({
      actionId: 'burn-ddz',
      source: 'game_settle',
      gameType: 'doudizhu',
      burnedResidue: 2,
      burnedRake: 3,
    });
    const pdk = db.addOp({
      actionId: 'burn-pdk',
      source: 'game_settle',
      gameType: 'paodekuai',
      burnedResidue: 1,
      burnedRake: 0,
    });
    db.addFlow(ddz, { ownerId: 'a', delta: -5, balanceAfter: 5, createdAt: T1 });
    db.addFlow(pdk, { ownerId: 'b', delta: -1, balanceAfter: 1, createdAt: T2 });
    db.addSkip({ ownerId: 'same', feeAmount: 1, gameType: 'doudizhu', createdAt: T1 });
    db.addSkip({ ownerId: 'same', feeAmount: 2, gameType: 'paodekuai', createdAt: T2 });

    const res = await probe.get(`/api/admin/wallet/summary?${WINDOW}`, AUTH);
    expect(res.status).toBe(200);
    const data = res.json.data;
    expect(data.burn).toEqual({ residue: 3, rake: 3, unrecordedOps: 0 });
    expect(data.burnByGame).toEqual([
      { gameType: 'doudizhu', residue: 2, rake: 3, unrecordedOps: 0 },
      { gameType: 'paodekuai', residue: 1, rake: 0, unrecordedOps: 0 },
    ]);
    // 全局 players = 1（同一人），分组 players 各 1 —— 不可相加
    expect(data.entryFeeSkips).toEqual({ cnt: 2, players: 1, amount: 3 });
    expect(data.entryFeeSkipsByGame).toEqual([
      { gameType: 'doudizhu', cnt: 1, players: 1, amount: 1 },
      { gameType: 'paodekuai', cnt: 1, players: 1, amount: 2 },
    ]);
  });

  it('空窗：by-game 数组为空、总数仍为 0/1 行形状', async () => {
    const res = await probe.get('/api/admin/wallet/summary?from=1&to=2', AUTH);
    expect(res.status).toBe(200);
    expect(res.json.data.burnByGame).toEqual([]);
    expect(res.json.data.entryFeeSkipsByGame).toEqual([]);
    expect(res.json.data.burn).toEqual({ residue: 0, rake: 0, unrecordedOps: 0 });
    expect(res.json.data.entryFeeSkips).toEqual({ cnt: 0, players: 0, amount: 0 });
  });

  it('CSV：流水与汇总表头均在“来源/分组”后插“玩法”', async () => {
    const op = db.addOp({ actionId: 'csv-pdk', source: 'game_settle', gameType: 'paodekuai' });
    db.addFlow(op, { ownerId: 'a', delta: 10, balanceAfter: 10, createdAt: T1 });

    const flows = await probe.get('/api/admin/wallet/ops.csv', AUTH);
    expect(flows.text.split('\r\n')[0]).toContain('来源,玩法,操作者');
    expect(flows.text).toContain('game_settle,跑得快');

    const summary = await probe.get(`/api/admin/wallet/summary.csv?${WINDOW}`, AUTH);
    expect(summary.text.startsWith('﻿分组,玩法,金额合计,流水笔数')).toBe(true);
    expect(summary.text).toContain('game_settle,跑得快');
  });

  it('跨查询快照漂移（byGame ≠ 总数）不得 500：只告警并返回读数', async () => {
    seedSummarySample();
    db.burnByGameOverride = [
      { k: null, residue: String(999), rake: String(999), unrecordedOps: 9 },
    ];

    const window = `from=${T('2026-10-05T00:00:00.000Z').getTime()}&to=${T('2026-10-07T00:00:00.000Z').getTime()}`;
    const res = await probe.get(`/api/admin/wallet/summary?${window}`, AUTH);
    expect(res.status).toBe(200);
    expect(res.json.data.burnByGame).toEqual([
      { gameType: null, residue: 999, rake: 999, unrecordedOps: 9 },
    ]);
    // 总数仍来自独立 SQL，不被 byGame 覆盖
    expect(res.json.data.burn).toEqual({ residue: 2, rake: 3, unrecordedOps: 0 });
  });
});

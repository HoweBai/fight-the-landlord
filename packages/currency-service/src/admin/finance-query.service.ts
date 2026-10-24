import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * 财务读口的**查询收口**（③ T6；规格 §2.7 + §2.11）——ops 列表 / op 详情 / summary 三 SQL 全文
 * 作为常量活在这里（**照 `reconcile.service.ts:36-37` 先例**：单测的假库按全文相等识别，
 * 实现侧改一个字符就当场红）；controller 薄（只做 query 校验/信封/CSV 拼装）。
 *
 * ─── SQL（规格 §2.7 逐字）────────────────────────────────────────────────
 *  - 列表/详情共用同一基句（`EXISTS(… CONCAT('admin:reverse:', o.id)) AS reversed` +
 *    `LEFT JOIN users` 取 phone/nickname）；列表动态过滤**全 AND**（按规格列序：
 *    source→actor→ownerId→from→to→cursor）+ `f.id DESC LIMIT ?`；详情 = `WHERE f.op_id = ?`
 *    `ORDER BY f.id`（升序、无 LIMIT）。
 *  - 时间过滤 `from` 含边界 / `to` 不含边界（半开区间）；epoch ms 一律 `new Date(ms)` 绑定
 *    （mysql2 本地时区 = 容器 UTC = 库内 UTC，⚙️1）。
 *  - summary 两分支（source / day）；day 用 `CONVERT_TZ(…,'+00:00','+08:00')` 偏移写法
 *    （北京时间切天；**不依赖 MySQL tz 表**）。
 *
 * ─── 驱动回值型别（钉，S13）──────────────────────────────────────────────
 *  - `reversed`：MySQL TINYINT/BIGINT 回值**随查询计划路径漂移**——number 0/1（普通路径）
 *    或字符串 `"0"/"1"`（EXISTS 经 semi-join/物化路径；真栈实测，⚙️14 同族）⇒ `toBoolFlag`
 *    两形态都转 boolean；其余形态响亮抛；
 *  - summary `delta/flowCount`：SUM ⇒ DECIMAL 字符串 / COUNT ⇒ number，一律经 `toNumberValue`
 *    转数字；`k`：source 分支即字符串，day 分支 `DATE()` 回 **Date** 对象 ⇒ 服务端格式化为
 *    `'YYYY-MM-DD'` 字符串（⚙️1 下往返恒等；不依赖 `dateStrings` 驱动开关）。
 *
 * ⚠️ 访问形态 = **裸 SQL**（同 `admin-wallet.controller.ts` / reconcile 先例：小读口不值一张
 * entity 映射，且 SQL 要能被单测全文钉）；过滤值的合法性已由 controller 先行 400
 * （列宽/枚举/整数域——不给 SQL 层留 500 路径）。
 */

/**
 * 列表/详情共用的基句（§2.7 **逐字**；换行仅为可读性，实际字符串是单空格连接）。
 * ⚠️ 列别名（flowId/opId/…/reversed）就是真 MySQL 的列标签——DTO 映射按别名取键。
 */
export const WALLET_OPS_SELECT_BASE =
  'SELECT f.id AS flowId, f.op_id AS opId, o.action_id AS actionId, o.source, o.actor, o.reason, ' +
  'o.ref_id AS refId, o.trace_id AS traceId, o.burned_residue AS burnedResidue, o.burned_rake AS burnedRake, f.owner_id AS ownerId, f.owner_type AS ownerType, ' +
  'f.delta, f.balance_after AS balanceAfter, f.created_at AS createdAt, ' +
  'u.phone, u.nickname, ' +
  "EXISTS(SELECT 1 FROM currency_ops r WHERE r.action_id = CONCAT('admin:reverse:', o.id)) AS reversed " +
  'FROM currency_flows f ' +
  'JOIN currency_ops o ON o.id = f.op_id ' +
  'LEFT JOIN users u ON u.id = f.owner_id';

/** 列表排序/分页后缀（§2.7：`ORDER BY f.id DESC LIMIT ?`；无过滤时 `WHERE` 整段省略）。 */
export const WALLET_OPS_LIST_SUFFIX = ' ORDER BY f.id DESC LIMIT ?';

/** 详情 SQL（§2.7：同 join 无过滤 + `WHERE f.op_id=? ORDER BY f.id`——升序、全 flows）。 */
export const WALLET_OPS_DETAIL_SQL = `${WALLET_OPS_SELECT_BASE} WHERE f.op_id = ? ORDER BY f.id`;

/** summary · groupBy=source（§2.7 **逐字**）。 */
export const SUMMARY_BY_SOURCE_SQL =
  'SELECT o.source AS k, COALESCE(SUM(f.delta),0) AS delta, COUNT(*) AS flowCount ' +
  'FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id ' +
  'WHERE f.created_at >= ? AND f.created_at < ? GROUP BY o.source ORDER BY k';

/** summary · groupBy=day（§2.7 **逐字**；+08:00 偏移写法切北京天）。 */
export const SUMMARY_BY_DAY_SQL =
  "SELECT DATE(CONVERT_TZ(f.created_at,'+00:00','+08:00')) AS k, COALESCE(SUM(f.delta),0) AS delta, COUNT(*) AS flowCount " +
  'FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id ' +
  'WHERE f.created_at >= ? AND f.created_at < ? GROUP BY k ORDER BY k';

/**
 * summary · burn 块（本片规格 §2.6b **逐字**）：窗口内 `source='game_settle'` 的
 * 残差/抽水合计 + NULL 行数（`unrecordedOps`；COUNT(col) 不计 NULL）。走 idx_ops_source_created。
 */
export const SUMMARY_BURN_SQL =
  'SELECT COALESCE(SUM(burned_residue),0) AS residue, COALESCE(SUM(burned_rake),0) AS rake, COUNT(*) - COUNT(burned_residue) AS unrecordedOps ' +
  "FROM currency_ops WHERE source = 'game_settle' AND created_at >= ? AND created_at < ?";

/**
 * summary · 漏收块（本片规格 §2.4d **逐字**）：窗口内 `currency_entry_fee_skips` 的
 * 笔数 / 去重人数 / 金额合计（半开窗；列序同既有两段）。走 idx_skips_created。
 */
export const SUMMARY_SKIPS_SQL =
  'SELECT COUNT(*) AS cnt, COUNT(DISTINCT owner_id) AS players, COALESCE(SUM(fee_amount),0) AS amount FROM currency_entry_fee_skips WHERE created_at >= ? AND created_at < ?';

/**
 * summary · 记牌器购买（记牌器收费片）：窗口内按 kind 的笔数/人数/金额（半开窗）。
 * 走 `idx_cc_purchase_created`。
 */
export const SUMMARY_CARD_COUNTER_PURCHASES_SQL =
  'SELECT `kind` AS k, COUNT(*) AS cnt, COUNT(DISTINCT `owner_id`) AS players, COALESCE(SUM(`price`),0) AS amount ' +
  'FROM `card_counter_purchases` WHERE `created_at` >= ? AND `created_at` < ? GROUP BY `kind` ORDER BY k';

/** summary · 记牌器使用（记牌器收费片）：窗口内按 kind 的笔数/人数（含 none = 未开通局次）。 */
export const SUMMARY_CARD_COUNTER_CONSUMPTIONS_SQL =
  'SELECT `kind` AS k, COUNT(*) AS cnt, COUNT(DISTINCT `owner_id`) AS players ' +
  'FROM `card_counter_consumptions` WHERE `created_at` >= ? AND `created_at` < ? GROUP BY `kind` ORDER BY k';

/**
 * `flows.csv` 单次行数上限（§2.11 逐字：50,000 行；超 ⇒ 400「范围过大，请收窄时间区间」）。
 */
export const FLOWS_CSV_MAX_ROWS = 50_000;

/**
 * CSV 查询的**探针上限** = 上限 + 1：一趟最多取 50,001 行，`rows.length > 50,000` ⇒ 400。
 * 与「全量拉再数」行为逐字等价，但**先给出上界**——导出整表（百万行）不会先把内存打爆。
 */
export const FLOWS_CSV_PROBE_LIMIT = FLOWS_CSV_MAX_ROWS + 1;

export type SummaryGroupBy = 'source' | 'day';

/** 过滤（已由 controller 校验通过：长度/枚举/整数域——服务侧只拼 SQL）。 */
export interface OpsListFilter {
  source?: string;
  actor?: string;
  ownerId?: string;
  /** epoch ms；`f.created_at >= from`（含边界）。 */
  from?: number;
  /** epoch ms；`f.created_at < to`（不含边界——半开区间）。 */
  to?: number;
}

/** 行形状逐字 = §2.7：join 列 + `reversed`（布尔）+ phone/nickname（LEFT JOIN miss ⇒ null）。 */
export interface AdminOpsRow {
  flowId: number;
  opId: number;
  actionId: string;
  source: string;
  actor: string | null;
  reason: string | null;
  refId: string | null;
  traceId: string | null;
  /** 结算销毁（本片）：截断残差；`null` = 未记录（非结算 op / 历史行 / 旧载荷）。 */
  burnedResidue: number | null;
  /** 结算销毁（本片）：抽水；null 语义同上。 */
  burnedRake: number | null;
  ownerId: string;
  ownerType: string;
  delta: number;
  balanceAfter: number;
  createdAt: number;
  phone: string | null;
  nickname: string | null;
  reversed: boolean;
}

export interface SummaryRow {
  k: string;
  delta: number;
  flowCount: number;
}

export interface SummaryBurn {
  residue: number;
  rake: number;
  /** 窗口内 `burned_residue` 为 NULL 的 game_settle op 条数（写路径两列恒同写同空；历史行如实呈现）。 */
  unrecordedOps: number;
}

/** 财务汇总 · 台费漏收块（本片）：窗口内免单笔数 / 去重人数 / 金额合计。 */
export interface EntryFeeSkipsSummary {
  cnt: number;
  players: number;
  amount: number;
}

/** 财务汇总 · 记牌器购买块（记牌器收费片；固定两行：game/hour，零窗补 0）。 */
export interface CardCounterPurchasesSummary {
  kind: 'game' | 'hour';
  count: number;
  players: number;
  amount: number;
}

/** 财务汇总 · 记牌器使用块（固定三行：pass/credit/none，零窗补 0；none = 未开通局次）。 */
export interface CardCounterConsumptionsSummary {
  kind: 'pass' | 'credit' | 'none';
  count: number;
  players: number;
}

export interface SummaryResult {
  rows: SummaryRow[];
  totals: { delta: number; flowCount: number };
  /** 结算销毁窗口合计（结算销毁上账片）。 */
  burn: SummaryBurn;
  /** 台费漏收窗口合计（本片）。 */
  entryFeeSkips: EntryFeeSkipsSummary;
  /** 记牌器购买窗口合计（记牌器收费片）。 */
  cardCounterPurchases: CardCounterPurchasesSummary[];
  /** 记牌器使用窗口合计（记牌器收费片）。 */
  cardCounterConsumptions: CardCounterConsumptionsSummary[];
}

export interface ListResult<T> {
  rows: T[];
  nextCursor: number | null;
}

/* ------------------------------------------------------------------ *
 * 驱动回值转换（读不出 ⇒ 抛，不静默编造读数；同 admin-wallet.controller 先例）
 * ------------------------------------------------------------------ */

function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/** `datetime(3)` 的三种驱动形态 ⇒ epoch ms 整数（照 `records.service.ts:110-115` 先例）。 */
function toEpochMs(value: unknown, context: string): number {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : new Date(String(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`${context}：读出的时间不是有限毫秒（收到 ${JSON.stringify(value)}）`);
  }
  return ms;
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** NULL 透传；非空值必须是安全整数，否则抛（响亮——「读不出」不得静默成 null）。 */
function toNullableSafeInt(value: unknown, context: string): number | null {
  if (value === null || value === undefined) return null;
  return toSafeInt(value, context);
}

/**
 * MySQL 布尔（TINYINT 0/1）⇒ DTO boolean（§2.7「reversed 以 MySQL 布尔出，DTO 转 boolean」）。
 *
 * ⚠️ **真栈实测（T10 联测，2026-10-05，⚙️14 同族）**：`EXISTS()` 是 BIGINT，mysql2 的回值
 * **随查询计划路径漂移**——优化器把 EXISTS 改写为 semi-join/物化路径时按查询协议元数据类型
 * 回**字符串** `"0"/"1"`（普通路径回 number）。两形态都认；**其余形态照旧响亮抛**
 * （不静默吞成 false——金额读面上「读不出」与「否」必须可区分）。
 */
function toBoolFlag(value: unknown, context: string): boolean {
  if (value === 0 || value === false || value === '0') return false;
  if (value === 1 || value === true || value === '1') return true;
  throw new Error(`${context}：读出的布尔旗不是 0/1（收到 ${JSON.stringify(value)}）`);
}

/** SUM（DECIMAL ⇒ 字符串）/COUNT（number）⇒ 数字（S13 型别钉；空值不静默归 0）。 */
function toNumberValue(value: unknown, context: string): number {
  if (value === null || value === undefined) {
    throw new Error(`${context}：读出值为空（期望数字）`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${context}：读出的值不是有限数字（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/**
 * day 分支的 `k`（`DATE()` 回 Date 对象——mysql2 以**本地时区**构造）⇒ `'YYYY-MM-DD'`。
 * ⚙️1：容器 TZ=UTC ⇒ 本地 = UTC ⇒ 往返恒等；用本地 getter 与 mysql2 的 DATE 解析同口径
 * （不用 getUTC*——那会在非 UTC 进程 TZ 下与驱动构造口径错开一天）。
 */
function formatDayKey(value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`summary day 分支：k 不是合法 Date（收到 ${JSON.stringify(value)}）`);
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
}

function toAdminOpsRow(row: Record<string, unknown>): AdminOpsRow {
  return {
    flowId: toSafeInt(row['flowId'], 'currency_flows.id'),
    opId: toSafeInt(row['opId'], 'currency_flows.op_id'),
    actionId: String(row['actionId']),
    source: String(row['source']),
    actor: toNullableString(row['actor']),
    reason: toNullableString(row['reason']),
    refId: toNullableString(row['refId']),
    traceId: toNullableString(row['traceId']),
    burnedResidue: toNullableSafeInt(row['burnedResidue'], 'currency_ops.burned_residue'),
    burnedRake: toNullableSafeInt(row['burnedRake'], 'currency_ops.burned_rake'),
    ownerId: String(row['ownerId']),
    ownerType: String(row['ownerType']),
    delta: toSafeInt(row['delta'], 'currency_flows.delta'),
    balanceAfter: toSafeInt(row['balanceAfter'], 'currency_flows.balance_after'),
    createdAt: toEpochMs(row['createdAt'], 'currency_flows.created_at'),
    phone: toNullableString(row['phone']),
    nickname: toNullableString(row['nickname']),
    reversed: toBoolFlag(row['reversed'], 'reversed 旗（EXISTS）'),
  };
}

function toSummaryRow(row: Record<string, unknown>, groupBy: SummaryGroupBy): SummaryRow {
  return {
    k: groupBy === 'source' ? String(row['k']) : formatDayKey(row['k']),
    delta: toNumberValue(row['delta'], 'summary.delta'),
    flowCount: toNumberValue(row['flowCount'], 'summary.flowCount'),
  };
}

@Injectable()
export class FinanceQueryService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /**
   * `GET /api/admin/wallet/ops`（列表）与 `flows.csv` 变体共用：
   * 动态过滤按规格列序全 AND 拼接；`limit` 为**必填**（JSON = 50/100；CSV 探针 = 50,001）。
   * `nextCursor = rows.length===limit ? 末行 flowId : null`（⚙️18：**不做存在性预查**）。
   */
  async listOps(
    filter: OpsListFilter,
    cursor: number | null,
    limit: number,
  ): Promise<ListResult<AdminOpsRow>> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.source !== undefined) {
      conds.push('o.source = ?');
      params.push(filter.source);
    }
    if (filter.actor !== undefined) {
      conds.push('o.actor = ?');
      params.push(filter.actor);
    }
    if (filter.ownerId !== undefined) {
      conds.push('f.owner_id = ?');
      params.push(filter.ownerId);
    }
    if (filter.from !== undefined) {
      conds.push('f.created_at >= ?');
      params.push(new Date(filter.from));
    }
    if (filter.to !== undefined) {
      conds.push('f.created_at < ?');
      params.push(new Date(filter.to));
    }
    if (cursor !== null) {
      conds.push('f.id < ?');
      params.push(cursor);
    }
    params.push(limit);

    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    const rows = (await this.dataSource.query(
      `${WALLET_OPS_SELECT_BASE}${where}${WALLET_OPS_LIST_SUFFIX}`,
      params,
    )) as Array<Record<string, unknown>>;
    const mapped = rows.map(toAdminOpsRow);
    return {
      rows: mapped,
      nextCursor: rows.length === limit ? mapped[mapped.length - 1]!.flowId : null,
    };
  }

  /**
   * `GET /api/admin/wallet/ops/:opId`（详情）：同 join 无过滤、`f.id` 升序、全 flows。
   * 空集 = op 不存在（每个 op 至少一行 flow——apply 同事务成对写入）⇒ controller 翻 404。
   */
  async getOp(opId: number): Promise<AdminOpsRow[]> {
    const rows = (await this.dataSource.query(WALLET_OPS_DETAIL_SQL, [opId])) as Array<
      Record<string, unknown>
    >;
    return rows.map(toAdminOpsRow);
  }

  /**
   * `GET /api/admin/wallet/summary`（两分支）+ `summary.csv`：窗口 `[from, to)`（半开）、
   * 分组行 + totals（totals = 各行聚合之和——Σ组和 ≡ 总和，无需第二 SQL）。
   */
  async summary(groupBy: SummaryGroupBy, from: number, to: number): Promise<SummaryResult> {
    const sql = groupBy === 'source' ? SUMMARY_BY_SOURCE_SQL : SUMMARY_BY_DAY_SQL;
    const rows = (await this.dataSource.query(sql, [new Date(from), new Date(to)])) as Array<
      Record<string, unknown>
    >;
    const mapped = rows.map((row) => toSummaryRow(row, groupBy));
    const totals = mapped.reduce(
      (acc, row) => ({ delta: acc.delta + row.delta, flowCount: acc.flowCount + row.flowCount }),
      { delta: 0, flowCount: 0 },
    );
    // 本片：burn 块（次序钉死——**先** group 查询、**后** burn 查询；测试按 db.queries 锚定）
    const burnRows = (await this.dataSource.query(SUMMARY_BURN_SQL, [new Date(from), new Date(to)])) as Array<
      Record<string, unknown>
    >;
    if (burnRows.length !== 1) {
      throw new Error(`summary burn：聚合查询应恰回一行（收到 ${burnRows.length} 行）`);
    }
    const burnRow = burnRows[0]!;
    const burn: SummaryBurn = {
      residue: toNumberValue(burnRow['residue'], 'summary.burn.residue'),
      rake: toNumberValue(burnRow['rake'], 'summary.burn.rake'),
      unrecordedOps: toNumberValue(burnRow['unrecordedOps'], 'summary.burn.unrecordedOps'),
    };
    // 本片：漏收块（次序钉死——**先** group、**后** burn、**后** skips；测试按 db.queries 锚定）
    const skipRows = (await this.dataSource.query(SUMMARY_SKIPS_SQL, [new Date(from), new Date(to)])) as Array<
      Record<string, unknown>
    >;
    if (skipRows.length !== 1) {
      throw new Error(`summary skips：聚合查询应恰回一行（收到 ${skipRows.length} 行）`);
    }
    const skipRow = skipRows[0]!;
    const entryFeeSkips: EntryFeeSkipsSummary = {
      cnt: toNumberValue(skipRow['cnt'], 'summary.entryFeeSkips.cnt'),
      players: toNumberValue(skipRow['players'], 'summary.entryFeeSkips.players'),
      amount: toNumberValue(skipRow['amount'], 'summary.entryFeeSkips.amount'),
    };
    // 记牌器收费片：购买块 + 使用块（次序钉死：group → burn → skips → purchases → consumptions）。
    const purchaseRows = (await this.dataSource.query(SUMMARY_CARD_COUNTER_PURCHASES_SQL, [
      new Date(from),
      new Date(to),
    ])) as Array<Record<string, unknown>>;
    const purchasesByKind = new Map(purchaseRows.map((row) => [String(row['k']), row]));
    const cardCounterPurchases: CardCounterPurchasesSummary[] = (['game', 'hour'] as const).map(
      (kind) => {
        const row = purchasesByKind.get(kind);
        return {
          kind,
          count: row === undefined ? 0 : toNumberValue(row['cnt'], 'summary.cardCounterPurchases.cnt'),
          players:
            row === undefined ? 0 : toNumberValue(row['players'], 'summary.cardCounterPurchases.players'),
          amount:
            row === undefined ? 0 : toNumberValue(row['amount'], 'summary.cardCounterPurchases.amount'),
        };
      },
    );
    const consumptionRows = (await this.dataSource.query(SUMMARY_CARD_COUNTER_CONSUMPTIONS_SQL, [
      new Date(from),
      new Date(to),
    ])) as Array<Record<string, unknown>>;
    const consumptionsByKind = new Map(consumptionRows.map((row) => [String(row['k']), row]));
    const cardCounterConsumptions: CardCounterConsumptionsSummary[] = (
      ['pass', 'credit', 'none'] as const
    ).map((kind) => {
      const row = consumptionsByKind.get(kind);
      return {
        kind,
        count:
          row === undefined ? 0 : toNumberValue(row['cnt'], 'summary.cardCounterConsumptions.cnt'),
        players:
          row === undefined
            ? 0
            : toNumberValue(row['players'], 'summary.cardCounterConsumptions.players'),
      };
    });
    return {
      rows: mapped,
      totals,
      burn,
      entryFeeSkips,
      cardCounterPurchases,
      cardCounterConsumptions,
    };
  }
}

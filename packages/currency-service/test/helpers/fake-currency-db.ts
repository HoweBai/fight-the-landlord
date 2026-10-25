/**
 * `apply.test.ts` / `apply.concurrency.test.ts` 共用的**假 DB 夹具**（本仓单测不用真 DB）。
 *
 * ⚠️ 它仿真的是**事务契约**（本任务承重的控制流全在「SQL 序列 + 事务边界」这一层）：
 *  - `transaction(cb)`：开一份 scratch（账户/ops/flows + 自增序），回调成功 ⇒ 写回
 *    （commit）、抛错 ⇒ **丢弃 scratch**（rollback）——「批内其他账户零变化 / 失败无残留」
 *    据此可判；但**真 InnoDB 的并发原子性不由本夹具证明**（那是 T10 slice-17 burst 的判据，
 *    见 `apply.concurrency.test.ts` 文件头）。
 *  - `dataSource.query`（T4 起）：**非事务直读面**（`GetService` 的 miss 回源 + T8 对账的
 *    两条判定 SQL 与逐键余额读 + ② 金币场 T8 的机器人总和 + **支付片 T4 的 cap_raw 聚合**）
 *    ——只认余额单行读（**普通形态**；
 *    事务侧快照的 ⚙️14① 锁定读形态由 `run()` 分认）+ T8 的账实相符/孤儿计数/机器人总和三条
 *    （**全文相等**识别 —— 规格 §2.12 / §11.1 的 SQL 漂移一个字符就当场红）+ cap_raw 聚合
 *    （**全文相等**识别，规格 §2.2.1/⚙️17 同族）；其余 SQL 当场
 *    reject（读路径 SQL 一漂移就红）。⚠️ 池 gauge 读与逐键回源**共用**同一单行余额 SQL
 *    （参数 'robot-pool'），不另立识别式。
 *    记录进 `directQueries`（「回源了吗 / 建行了吗 / 对账跑了吗」的判据面）。
 *  - 语句按**精确形状**识别（带 `?` 占位与反引号），实现侧 SQL 一漂移就当场红。
 *  - 事务路径的快照读**只认 ⚙️14① 锁定读形态**（`SELECT balance, owner_type … FOR UPDATE`）：
 *    实现若漂回普通 SELECT（RR 下读不到并发已提交行 = ⚙️12 的假闭合）⇒ 「未识别的 SQL」当场红。
 *  - `beforeStatement` 钩子 = 「并发会话已提交的写」注入面（用例在 INSERT IGNORE 前
 *    种入一个账户来模拟「并发他人首建」）。
 *  - 撞 `uk_action_id` ⇒ 抛**形如 mysql2** 的 `ER_DUP_ENTRY` 错误（code + errno + 含
 *    `uk_action_id` 的 message），让 `isDuplicateEntryError` 的判读走真实形态。
 */

export interface FakeAccount {
  ownerType: string;
  balance: number;
}

export interface FakeOpRow {
  id: number;
  actionId: string;
  requestHash: string;
  source: string;
  actor: string | null;
  reason: string | null;
  refId: string | null;
  traceId: string | null;
  burnedResidue: number | null;
  burnedRake: number | null;
}

export interface FakeFlowRow {
  id: number;
  opId: number;
  ownerId: string;
  ownerType: string;
  delta: number;
  balanceAfter: number;
}

/** 本片 T3：`currency_entry_fee_skips` 的行（skip 服务单测的断言面）。 */
export interface FakeSkipRow {
  id: number;
  roomCode: string;
  ownerId: string;
  seat: number | null;
  baseScore: number;
  feeAmount: number;
  reason: string;
  traceId: string | null;
}

/** 记牌器收费片：`card_counter_purchases` 行（购买服务的断言面）。 */
export interface FakePurchaseRow {
  id: number;
  actionId: string;
  ownerId: string;
  kind: 'game' | 'hour';
  hours: number | null;
  credits: number | null;
  price: number;
}

/** 记牌器收费片：`card_counter_entitlements` 行（按 owner 唯一）。 */
export interface FakeEntitlementRow {
  ownerId: string;
  credits: number;
  /** epoch ms（null = 无包时）——夹具用 number 便于断言；SQL 里是 datetime(3)。 */
  passExpiresAt: number | null;
}

/** 记牌器收费片：`card_counter_consumptions` 行（消费幂等/审计）。 */
export interface FakeConsumptionRow {
  id: number;
  roomCode: string;
  ownerId: string;
  seat: number | null;
  kind: 'pass' | 'credit' | 'none';
  expiresAt: number | null;
  traceId: string | null;
}

export interface Statement {
  sql: string;
  params: unknown[];
}

/** 钩子看到的**事务内视角**（写回 scratch —— 模拟「另一会话的写对本事务可见」）。 */
export interface FakeSession {
  accounts: Map<string, FakeAccount>;
  purchases: FakePurchaseRow[];
  entitlements: Map<string, FakeEntitlementRow>;
  consumptions: FakeConsumptionRow[];
}

interface Scratch {
  accounts: Map<string, FakeAccount>;
  ops: FakeOpRow[];
  flows: FakeFlowRow[];
  purchases: FakePurchaseRow[];
  entitlements: Map<string, FakeEntitlementRow>;
  consumptions: FakeConsumptionRow[];
  nextOpId: number;
  nextFlowId: number;
  nextPurchaseId: number;
  nextConsumptionId: number;
}

/** 本实现的语句形状（逐字；与 `apply.service.ts` 的常量一一对应）。 */
const SQL = {
  opsInsert: /^INSERT INTO `currency_ops` \(`action_id`, `request_hash`, `source`, `actor`, `reason`, `ref_id`, `trace_id`, `burned_residue`, `burned_rake`\) VALUES \(/,
  opsSelect: /^SELECT `id`, `request_hash` FROM `currency_ops` WHERE `action_id` = \?$/,
  typeSelect: /^SELECT `owner_type` FROM `currency_accounts` WHERE `owner_id` = \?$/,
  /** ⚙️14②：⚙️12 重查的锁定读形态（与步 a 的普通读**分认**，可判别实现漂移）。 */
  typeSelectForUpdate: /^SELECT `owner_type` FROM `currency_accounts` WHERE `owner_id` = \? FOR UPDATE$/,
  balanceUpdate:
    /^UPDATE `currency_accounts` SET `balance` = `balance` \+ \? WHERE `owner_id` = \? AND `balance` \+ \? >= 0$/,
  accountInsertIgnore: /^INSERT IGNORE INTO `currency_accounts` \(`owner_id`, `owner_type`, `balance`\) VALUES \(/,
  balanceSelect: /^SELECT `balance` FROM `currency_accounts` WHERE `owner_id` = \?$/,
  /** ⚙️14①：快照步的锁定读形态（余额**与** owner_type 一并读出；两列 + FOR UPDATE）。 */
  balanceSnapshotForUpdate:
    /^SELECT `balance`, `owner_type` FROM `currency_accounts` WHERE `owner_id` = \? FOR UPDATE$/,
  flowInsert: /^INSERT INTO `currency_flows` \(`op_id`, `owner_id`, `owner_type`, `delta`, `balance_after`\) VALUES \(/,
  flowsByOp: /^SELECT `owner_id`, `balance_after` FROM `currency_flows` WHERE `op_id` = \? ORDER BY `owner_id`$/,
  skipInsertIgnore: /^INSERT IGNORE INTO `currency_entry_fee_skips` \(`room_code`, `owner_id`, `seat`, `base_score`, `fee_amount`, `reason`, `trace_id`\) VALUES \(/,
  // 记牌器收费片：购买/权益/消费
  purchaseInsert: /^INSERT INTO `card_counter_purchases` \(`action_id`, `owner_id`, `kind`, `hours`, `credits`, `price`\) VALUES \(/,
  entitlementGameUpsert: /^INSERT INTO `card_counter_entitlements` \(`owner_id`, `credits`, `pass_expires_at`\) VALUES \(\?, \?, NULL\) ON DUPLICATE KEY UPDATE `credits` = `credits` \+ \?$/,
  entitlementHourUpsert: /^INSERT INTO `card_counter_entitlements` \(`owner_id`, `credits`, `pass_expires_at`\) VALUES \(\?, 0, DATE_ADD\(NOW\(3\), INTERVAL \? HOUR\)\) ON DUPLICATE KEY UPDATE `pass_expires_at` = DATE_ADD\(GREATEST\(COALESCE\(`pass_expires_at`, NOW\(3\)\), NOW\(3\)\), INTERVAL \? HOUR\)$/,
  purchaseSelect: /^SELECT `kind`, `hours`, `credits`, `price` FROM `card_counter_purchases` WHERE `action_id` = \? LIMIT 1$/,
  entitlementSelect: /^SELECT `credits`, `pass_expires_at` FROM `card_counter_entitlements` WHERE `owner_id` = \?$/,
  entitlementSelectForUpdate: /^SELECT `credits`, `pass_expires_at` FROM `card_counter_entitlements` WHERE `owner_id` = \? FOR UPDATE$/,
  entitlementConsumeSelect: /^SELECT `credits`, `pass_expires_at`, NOW\(3\) AS `db_now` FROM `card_counter_entitlements` WHERE `owner_id` = \? FOR UPDATE$/,
  consumptionSelect: /^SELECT `kind`, `expires_at` FROM `card_counter_consumptions` WHERE `room_code` = \? AND `owner_id` = \?$/,
  consumptionInsert: /^INSERT INTO `card_counter_consumptions` \(`room_code`, `owner_id`, `seat`, `kind`, `expires_at`, `trace_id`\) VALUES \(/,
  creditsDecrement: /^UPDATE `card_counter_entitlements` SET `credits` = `credits` - 1 WHERE `owner_id` = \? AND `credits` > 0$/,
} as const;

/**
 * T8 对账的两条判定 SQL（规格 §2.12 表**逐字**的副本）——直读面按**全文相等**识别：
 * 实现侧 SQL 一漂移（哪怕一个空格/别名）就落到「未识别」reject ⇒ 当场红。
 * ⚠️ 这里**故意**不从 `reconcile.service.ts` 导入（本夹具是判据的一半：必须独立持有
 * 规格原文，否则实现漂移会被「两边一起改」静默带走）。
 */
const RECONCILE_DRIFT_SELECT =
  'SELECT a.owner_id, a.balance, COALESCE(f.total,0) FROM currency_accounts a LEFT JOIN (SELECT owner_id, SUM(delta) total FROM currency_flows GROUP BY owner_id) f ON f.owner_id = a.owner_id WHERE a.balance <> COALESCE(f.total,0)';

const RECONCILE_ORPHAN_COUNT =
  "SELECT COUNT(DISTINCT f.owner_id) FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id LEFT JOIN users u ON u.id = f.owner_id WHERE o.source = 'signup_grant' AND u.id IS NULL";

/**
 * ② 金币场 T8 的表总 SQL（实现侧 `reconcile.service.ts` 的独立副本 —— 同「全文相等」纪律）。
 * ⚠️ 池的那条读与**逐键回源共用**同一条单行余额 SQL（无需新识别式）；只有本总和式是新的。
 */
const RECONCILE_ROBOT_ACCOUNTS_SUM =
  "SELECT COALESCE(SUM(`balance`), 0) FROM `currency_accounts` WHERE `owner_type` = 'robot' AND `owner_id` LIKE 'bot-%'";

/**
 * 支付片 T4（规格 §2.2.1 公式 + ⚙️17 JOIN 先例写法）：`currency.withdrawable.get` 的
 * cap_raw 单条读 —— 与实现侧**全文相等**识别（SQL 漂移一个字符 ⇒ 落到「未识别」reject）。
 * ⚠️ 独立持有原文（**不从 `withdrawable.service.ts` 导入** —— 本夹具是判据的一半）。
 * 占位次序 = [ownerId, ...6 源（规格次序）]；无 GROUP BY 聚合 + COALESCE ⇒ 恒 1 行。
 */
const WITHDRAWABLE_CAP_RAW_SELECT =
  'SELECT COALESCE(SUM(f.delta), 0) AS total FROM currency_flows f JOIN currency_ops o ON o.id=f.op_id WHERE f.owner_id = ? AND o.source IN (?, ?, ?, ?, ?, ?)';

/** 形如 mysql2 的 ER_DUP_ENTRY（`isDuplicateEntryError` 的三种判读都有真形态可读）。 */
export function duplicateEntryError(actionId: string): Error {
  return duplicateKeyError('currency_ops.uk_action_id', actionId);
}

/** 形如 mysql2 的唯一键冲突（任意索引名；`isDuplicateEntryError` 按 message 里的索引名判别）。 */
export function duplicateKeyError(index: string, value: string): Error {
  const err = new Error(`Duplicate entry '${value}' for key '${index}'`) as Error & {
    code: string;
    errno: number;
  };
  err.code = 'ER_DUP_ENTRY';
  err.errno = 1062;
  return err;
}

/**
 * 模拟 `utf8mb4_0900_ai_ci` 的排序序（**故意与 JS code-unit 序分歧**）：折叠大小写后比较，
 * 平手再按原文。混合大小写（'B' vs 'a'）下与 JS 序相反 —— 这正是 ⚙️13 的判别力来源：
 * 实现若裸信 SQL 的 `ORDER BY owner_id`，混合大小写重放用例当场红。
 */
export function mysqlAiCiCompare(a: string, b: string): number {
  const foldedA = a.toLowerCase();
  const foldedB = b.toLowerCase();
  if (foldedA < foldedB) return -1;
  if (foldedA > foldedB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class FakeCurrencyDb {
  accounts = new Map<string, FakeAccount>();
  ops: FakeOpRow[] = [];
  flows: FakeFlowRow[] = [];
  /**
   * T8：`users` 表的**存在性替身**（孤儿赠送判定的 LEFT JOIN 面）—— 只影响检查③；
   * 未登记 ⇒ 该 owner 的 `signup_grant` 流水按「users 行不存在」计（默认空集 = 全算孤儿，
   * 用例显式登记「非孤儿」）。
   */
  registeredUsers = new Set<string>();
  /** 本片 T3：`currency_entry_fee_skips` 的行表（skip 写边的落行断言面；直写非事务）。 */
  skips: FakeSkipRow[] = [];
  /** 记牌器收费片：三张新表的行表（事务 scratch 写回；回滚 = 丢弃 scratch）。 */
  purchases: FakePurchaseRow[] = [];
  entitlements = new Map<string, FakeEntitlementRow>();
  consumptions: FakeConsumptionRow[] = [];
  /** 每次 `transaction()` 一条，按调用序；`committed=false` = 走了回滚路径。 */
  txLog: Array<{ statements: Statement[]; committed: boolean }> = [];
  /** 每条语句处理**之前**的注入钩子（null = 无注入）。 */
  beforeStatement: ((sql: string, params: unknown[], session: FakeSession) => void) | null = null;

  /**
   * `dataSource.query()`（**非事务直读**，T4 get 读路径 + T8 对账）的语句记录。
   * ⚠️ 与 `txLog` 分开：直读不走事务，读路径/对账检查**绝不**写库（§2.4「不建行」+
   * §2.12 检查①「不自修」）。
   */
  readonly directQueries: Statement[] = [];
  /** T8 注入面：> 0 ⇒ 该次直读 query 直接 reject（每次消一个；「查询抛错 ⇒ last_success 不 set」）。 */
  directFailuresRemaining = 0;
  /** T8 注入面：非 null ⇒ 下一条直读 query 挂起（返回该 promise），由用例放行（在途一轮）。 */
  private heldDirect: Promise<unknown> | null = null;

  private nextOpId = 1;
  private nextFlowId = 1;
  private nextSkipId = 1;
  private nextPurchaseId = 1;
  private nextConsumptionId = 1;

  constructor(private readonly timeline: string[] = []) {}

  /** T8：挂起下一条直读 query（关停闸用例让「第 1 轮在途」）。 */
  holdNextDirectQuery(): { resolve: (value: unknown) => void } {
    let resolve!: (value: unknown) => void;
    this.heldDirect = new Promise((r) => (resolve = r));
    return { resolve };
  }

  seedAccount(ownerId: string, ownerType: string, balance: number): void {
    this.accounts.set(ownerId, { ownerType, balance });
  }

  /** 直接种入「胜者已提交」的 ops+flows（撞键用例构造并发胜者）。 */
  seedCommittedOp(
    op: { actionId: string; requestHash: string; source?: string },
    flows: Array<{ ownerId: string; ownerType?: string; delta: number; balanceAfter: number }>,
  ): number {
    const opId = this.nextOpId++;
    this.ops.push({
      id: opId,
      actionId: op.actionId,
      requestHash: op.requestHash,
      source: op.source ?? 'admin_adjust',
      actor: 'admin',
      reason: 'seed',
      refId: null,
      traceId: null,
      burnedResidue: null,
      burnedRake: null,
    });
    for (const flow of flows) {
      this.flows.push({
        id: this.nextFlowId++,
        opId,
        ownerId: flow.ownerId,
        ownerType: flow.ownerType ?? 'user',
        delta: flow.delta,
        balanceAfter: flow.balanceAfter,
      });
    }
    return opId;
  }

  /** 树到 `ApplyService` / `GetService` / `ReconcileService` 构造函数第一参的形状（测试里 `as unknown as DataSource`）。 */
  readonly dataSource = {
    /**
     * **非事务直读**（`GetService` 的 miss 回源 + T8 对账三处：账实相符 / 逐键余额 /
     * 孤儿计数 + 支付片 T4 的 cap_raw 聚合）。只认这几条**精确形状**；其余语句 reject ——
     * 实现侧在读路径/对账里漂出别的 SQL（或 §2.12 判定 SQL 漂移）当场红。
     */
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.directQueries.push({ sql, params: [...params] });
      if (this.directFailuresRemaining > 0) {
        this.directFailuresRemaining -= 1;
        return Promise.reject(new Error('db down（仿真）'));
      }
      if (this.heldDirect !== null) {
        const held = this.heldDirect;
        this.heldDirect = null;
        return held;
      }
      if (SQL.skipInsertIgnore.test(sql)) {
        // 本片 T3：skip 写边经 `dataSource.query` 非事务直写（幂等写 = 唯一键 + INSERT IGNORE）。
        // 「重复 ⇒ affectedRows 0」语义照 `accountInsertIgnore` 先例（行数与内容都不变）。
        const [roomCode, ownerId, seat, baseScore, feeAmount, reason, traceId] = params as [
          string, string, number | null, number, number, string, string | null,
        ];
        if (this.skips.some((s) => s.roomCode === roomCode && s.ownerId === ownerId)) {
          return Promise.resolve({ affectedRows: 0 });
        }
        this.skips.push({
          id: this.nextSkipId++,
          roomCode, ownerId, seat, baseScore, feeAmount, reason, traceId,
        });
        return Promise.resolve({ affectedRows: 1 });
      }
      if (SQL.balanceSelect.test(sql)) {
        const account = this.accounts.get(params[0] as string);
        return Promise.resolve(account === undefined ? [] : [{ balance: account.balance }]);
      }
      // 记牌器收费片：购买行/权益的**直读**面（购买响应与 status 端点）
      if (SQL.purchaseSelect.test(sql)) {
        const row = this.purchases.find((p) => p.actionId === (params[0] as string));
        return Promise.resolve(
          row === undefined
            ? []
            : [{ kind: row.kind, hours: row.hours, credits: row.credits, price: row.price }],
        );
      }
      if (SQL.entitlementSelect.test(sql) || SQL.entitlementSelectForUpdate.test(sql)) {
        const row = this.entitlements.get(params[0] as string);
        return Promise.resolve(
          row === undefined
            ? []
            : [
                {
                  credits: row.credits,
                  pass_expires_at: row.passExpiresAt === null ? null : new Date(row.passExpiresAt),
                },
              ],
        );
      }
      // 消费冲突回读面（直读；无行 ⇒ []）
      if (SQL.consumptionSelect.test(sql)) {
        const [roomCode, ownerId] = params as [string, string];
        const row = this.consumptions.find(
          (c) => c.roomCode === roomCode && c.ownerId === ownerId,
        );
        return Promise.resolve(
          row === undefined
            ? []
            : [
                {
                  kind: row.kind,
                  expires_at: row.expiresAt === null ? null : new Date(row.expiresAt),
                },
              ],
        );
      }
      if (sql === WITHDRAWABLE_CAP_RAW_SELECT) {
        // 支付片 T4 真语义：Σ f.delta where owner 匹配 ∩ op.source ∈ 6 源集合（参数次序照规格：
        // params[0] = ownerId，params[1..6] = 6 源）。回值形态照真驱动：SUM ⇒ DECIMAL 字符串
        // （COALESCE 恒 1 行；无命中流水 ⇒ '0'）——实现侧必须自己转数并判安全整数。
        const ownerId = params[0] as string;
        const sources = params.slice(1) as string[];
        let total = 0;
        for (const flow of this.flows) {
          if (flow.ownerId !== ownerId) continue;
          const op = this.ops.find((o) => o.id === flow.opId);
          if (op !== undefined && sources.includes(op.source)) total += flow.delta;
        }
        return Promise.resolve([{ total: String(total) }]);
      }
      if (sql === RECONCILE_DRIFT_SELECT) {
        // 检查①真语义：LEFT JOIN 求差（账户 balance ≠ 其全部流水 delta 之和才出列；
        // 无流水的账户合计按 COALESCE 为 0）。列标签与实现侧读的**表达式原文**一致。
        const totals = new Map<string, number>();
        for (const flow of this.flows) {
          totals.set(flow.ownerId, (totals.get(flow.ownerId) ?? 0) + flow.delta);
        }
        const rows: Array<Record<string, unknown>> = [];
        for (const [ownerId, account] of this.accounts) {
          const total = totals.get(ownerId) ?? 0;
          if (account.balance !== total) {
            rows.push({ owner_id: ownerId, balance: account.balance, 'COALESCE(f.total,0)': total });
          }
        }
        return Promise.resolve(rows);
      }
      if (sql === RECONCILE_ORPHAN_COUNT) {
        // 检查③真语义：signup_grant 流水 ∩ owner 不在 `users`（registeredUsers 替身）的
        // **去重**计数（非 signup 源不算 —— 只诊断赠送）。
        const orphanOwners = new Set<string>();
        for (const flow of this.flows) {
          const op = this.ops.find((o) => o.id === flow.opId);
          if (op?.source === 'signup_grant' && !this.registeredUsers.has(flow.ownerId)) {
            orphanOwners.add(flow.ownerId);
          }
        }
        return Promise.resolve([{ 'COUNT(DISTINCT f.owner_id)': orphanOwners.size }]);
      }
      if (sql === RECONCILE_ROBOT_ACCOUNTS_SUM) {
        // ② T8 真语义：`owner_type='robot'` 且 `owner_id LIKE 'bot-%'` 的余额总和 ——
        // **不含池**（'robot-pool' 无 'bot-' 前缀；无行 ⇒ COALESCE 归 0）。列标签 = 表达式原文。
        let total = 0;
        for (const [ownerId, account] of this.accounts) {
          if (account.ownerType === 'robot' && ownerId.startsWith('bot-')) total += account.balance;
        }
        return Promise.resolve([{ 'COALESCE(SUM(`balance`), 0)': total }]);
      }
      return Promise.reject(new Error(`FakeCurrencyDb 未识别的直读 SQL（读路径/对账不得用它）：${sql}`));
    },
    transaction: async <T>(
      cb: (manager: {
        query: (sql: string, params?: unknown[]) => Promise<unknown>;
      }) => Promise<T>,
    ): Promise<T> => {
      const scratch: Scratch = {
        accounts: new Map([...this.accounts].map(([ownerId, a]) => [ownerId, { ...a }])),
        ops: [...this.ops],
        flows: [...this.flows],
        purchases: [...this.purchases],
        entitlements: new Map([...this.entitlements].map(([ownerId, e]) => [ownerId, { ...e }])),
        consumptions: [...this.consumptions],
        nextOpId: this.nextOpId,
        nextFlowId: this.nextFlowId,
        nextPurchaseId: this.nextPurchaseId,
        nextConsumptionId: this.nextConsumptionId,
      };
      const record = { statements: [] as Statement[], committed: false };
      this.txLog.push(record);
      const manager = {
        query: (sql: string, params: unknown[] = []) => this.run(sql, params, scratch, record),
      };
      let result: T;
      try {
        result = await cb(manager);
      } catch (err) {
        this.timeline.push('rollback');
        throw err; // 回滚 = 丢弃 scratch（this.* 原封不动）
      }
      // commit：scratch 写回
      this.accounts = scratch.accounts;
      this.ops = scratch.ops;
      this.flows = scratch.flows;
      this.purchases = scratch.purchases;
      this.entitlements = scratch.entitlements;
      this.consumptions = scratch.consumptions;
      this.nextOpId = scratch.nextOpId;
      this.nextFlowId = scratch.nextFlowId;
      this.nextPurchaseId = scratch.nextPurchaseId;
      this.nextConsumptionId = scratch.nextConsumptionId;
      record.committed = true;
      this.timeline.push('commit');
      return result;
    },
  };

  private run(
    sql: string,
    params: unknown[],
    scratch: Scratch,
    record: { statements: Statement[]; committed: boolean },
  ): Promise<unknown> {
    record.statements.push({ sql, params: [...params] });
    // 代理钩子的保存点（2026-10-26）：假库不仿真回滚，只把语句记入序列；
    // 保存点的真实回滚/毒化语义由 conformance slice-30 真 MySQL 判。
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/.test(sql)) {
      return Promise.resolve({ affectedRows: 0 });
    }
    this.beforeStatement?.(sql, params, {
      accounts: scratch.accounts,
      purchases: scratch.purchases,
      entitlements: scratch.entitlements,
      consumptions: scratch.consumptions,
    });

    if (SQL.opsInsert.test(sql)) {
      const actionId = params[0] as string;
      if (scratch.ops.some((op) => op.actionId === actionId)) {
        return Promise.reject(duplicateEntryError(actionId));
      }
      const id = scratch.nextOpId++;
      scratch.ops.push({
        id,
        actionId,
        requestHash: params[1] as string,
        source: params[2] as string,
        actor: (params[3] ?? null) as string | null,
        reason: (params[4] ?? null) as string | null,
        refId: (params[5] ?? null) as string | null,
        traceId: (params[6] ?? null) as string | null,
        burnedResidue: (params[7] ?? null) as number | null,
        burnedRake: (params[8] ?? null) as number | null,
      });
      return Promise.resolve({ insertId: id, affectedRows: 1 });
    }
    if (SQL.opsSelect.test(sql)) {
      const actionId = params[0] as string;
      return Promise.resolve(
        scratch.ops
          .filter((op) => op.actionId === actionId)
          .map((op) => ({ id: op.id, request_hash: op.requestHash })),
      );
    }
    if (SQL.typeSelect.test(sql)) {
      const account = scratch.accounts.get(params[0] as string);
      return Promise.resolve(account === undefined ? [] : [{ owner_type: account.ownerType }]);
    }
    if (SQL.typeSelectForUpdate.test(sql)) {
      // ⚙️14②：重查的锁定读 —— 副本里看到的语义与普通读一致（真假锁在 InnoDB，
      // 本夹具的判别力在**形状**：普通读形态进不了这个分支）。
      const account = scratch.accounts.get(params[0] as string);
      return Promise.resolve(account === undefined ? [] : [{ owner_type: account.ownerType }]);
    }
    if (SQL.balanceUpdate.test(sql)) {
      const delta = params[0] as number;
      const account = scratch.accounts.get(params[1] as string);
      if (account === undefined || account.balance + delta < 0) return Promise.resolve({ affectedRows: 0 });
      account.balance += delta;
      return Promise.resolve({ affectedRows: 1 });
    }
    if (SQL.accountInsertIgnore.test(sql)) {
      const ownerId = params[0] as string;
      if (scratch.accounts.has(ownerId)) return Promise.resolve({ affectedRows: 0 });
      scratch.accounts.set(ownerId, { ownerType: params[1] as string, balance: 0 });
      return Promise.resolve({ affectedRows: 1 });
    }
    if (SQL.balanceSnapshotForUpdate.test(sql)) {
      // ⚙️14①：事务路径唯一的快照读形态（普通 `SELECT balance` 在事务里**不认** ——
      // 实现若漂回普通读，走不到本分支、当场「未识别的 SQL」红）。两列一并返回，
      // 让实现的 owner_type 断言有判别面。
      const account = scratch.accounts.get(params[0] as string);
      return Promise.resolve(
        account === undefined ? [] : [{ balance: account.balance, owner_type: account.ownerType }],
      );
    }
    if (SQL.flowInsert.test(sql)) {
      const id = scratch.nextFlowId++;
      scratch.flows.push({
        id,
        opId: params[0] as number,
        ownerId: params[1] as string,
        ownerType: params[2] as string,
        delta: params[3] as number,
        balanceAfter: params[4] as number,
      });
      return Promise.resolve({ insertId: id, affectedRows: 1 });
    }
    if (SQL.flowsByOp.test(sql)) {
      const opId = params[0] as number;
      return Promise.resolve(
        scratch.flows
          .filter((flow) => flow.opId === opId)
          // ⚙️13：回放重建的 CASE —— 这里按**MySQL 列 collation 序**返回（不是 JS 序），
          // 逼实现侧自己重排（`apply.service.ts` 的 `replay()`）。
          .sort((a, b) => mysqlAiCiCompare(a.ownerId, b.ownerId))
          .map((flow) => ({ owner_id: flow.ownerId, balance_after: flow.balanceAfter })),
      );
    }
    // ─── 记牌器收费片（购买/权益/消费）────────────────────────────────────
    if (SQL.purchaseInsert.test(sql)) {
      const [actionId, ownerId, kind, hours, credits, price] = params as [
        string, string, 'game' | 'hour', number | null, number | null, number,
      ];
      if (scratch.purchases.some((p) => p.actionId === actionId)) {
        return Promise.reject(duplicateKeyError('uk_cc_purchase_action', actionId));
      }
      const id = scratch.nextPurchaseId++;
      scratch.purchases.push({ id, actionId, ownerId, kind, hours, credits, price });
      return Promise.resolve({ insertId: id, affectedRows: 1 });
    }
    if (SQL.entitlementGameUpsert.test(sql)) {
      const ownerId = params[0] as string;
      const insertCredits = params[1] as number; // INSERT VALUES credits
      const addCredits = params[2] as number;   // ON DUPLICATE KEY UPDATE credits + N
      const existing = scratch.entitlements.get(ownerId);
      const hasExisting = existing !== undefined;
      scratch.entitlements.set(ownerId, {
        ownerId,
        credits: hasExisting
          ? (existing!.credits ?? 0) + addCredits  // UPDATE path: + N
          : insertCredits,                         // INSERT path: = N
        passExpiresAt: existing?.passExpiresAt ?? null,
      });
      return Promise.resolve({ affectedRows: hasExisting ? 2 : 1 });
    }
    if (SQL.entitlementHourUpsert.test(sql)) {
      const ownerId = params[0] as string;
      const hours = params[1] as number;
      const now = Date.now();
      const existing = scratch.entitlements.get(ownerId);
      const base = Math.max(existing?.passExpiresAt ?? now, now);
      scratch.entitlements.set(ownerId, {
        ownerId,
        credits: existing?.credits ?? 0,
        passExpiresAt: base + hours * 3_600_000,
      });
      return Promise.resolve({ affectedRows: 1 });
    }
    if (SQL.purchaseSelect.test(sql)) {
      const actionId = params[0] as string;
      const row = scratch.purchases.find((p) => p.actionId === actionId);
      return Promise.resolve(
        row === undefined
          ? []
          : [{ kind: row.kind, hours: row.hours, credits: row.credits, price: row.price }],
      );
    }
    if (SQL.entitlementSelect.test(sql) || SQL.entitlementSelectForUpdate.test(sql)) {
      const ownerId = params[0] as string;
      const row = scratch.entitlements.get(ownerId);
      return Promise.resolve(
        row === undefined
          ? []
          : [
              {
                credits: row.credits,
                pass_expires_at: row.passExpiresAt === null ? null : new Date(row.passExpiresAt),
              },
            ],
      );
    }
    if (SQL.entitlementConsumeSelect.test(sql)) {
      // 消费路径：DB 时间 `NOW(3)` 由夹具当次现算（到期判定只用 DB 时间，不用服务端时钟）。
      const ownerId = params[0] as string;
      const row = scratch.entitlements.get(ownerId);
      return Promise.resolve(
        row === undefined
          ? []
          : [
              {
                credits: row.credits,
                pass_expires_at: row.passExpiresAt === null ? null : new Date(row.passExpiresAt),
                db_now: new Date(),
              },
            ],
      );
    }
    if (SQL.consumptionSelect.test(sql)) {
      const [roomCode, ownerId] = params as [string, string];
      const row = scratch.consumptions.find(
        (c) => c.roomCode === roomCode && c.ownerId === ownerId,
      );
      return Promise.resolve(
        row === undefined
          ? []
          : [
              {
                kind: row.kind,
                expires_at: row.expiresAt === null ? null : new Date(row.expiresAt),
              },
            ],
      );
    }
    if (SQL.consumptionInsert.test(sql)) {
      const [roomCode, ownerId, seat, kind, expiresAt, traceId] = params as [
        string, string, number | null, 'pass' | 'credit' | 'none', Date | null, string | null,
      ];
      if (scratch.consumptions.some((c) => c.roomCode === roomCode && c.ownerId === ownerId)) {
        return Promise.reject(duplicateKeyError('uk_cc_consume_room_owner', `${roomCode}:${ownerId}`));
      }
      const id = scratch.nextConsumptionId++;
      scratch.consumptions.push({
        id,
        roomCode,
        ownerId,
        seat: seat ?? null,
        kind,
        expiresAt: expiresAt === null ? null : expiresAt.getTime(),
        traceId: traceId ?? null,
      });
      return Promise.resolve({ insertId: id, affectedRows: 1 });
    }
    if (SQL.creditsDecrement.test(sql)) {
      const ownerId = params[0] as string;
      const row = scratch.entitlements.get(ownerId);
      if (row === undefined || row.credits <= 0) return Promise.resolve({ affectedRows: 0 });
      row.credits -= 1;
      return Promise.resolve({ affectedRows: 1 });
    }
    return Promise.reject(new Error(`FakeCurrencyDb 未识别的 SQL：${sql}`));
  }
}

/**
 * 假 Redis（余额缓存帮助层语义的替身）：真存储 + 调用记录 + 失败注入面。
 * `timeline` 与 `FakeCurrencyDb` 共用时可断言「commit 先于写穿 SET」。
 * T8 起兼作 `SCAN` 的替身（`scan`/`scanPageSize` —— 对账检查②的游标循环判别面）。
 *
 * ─── T12 扩展（广告片 claim 双键服务；**全仓零 watch/multi 假库先例 ⇒ 本类首创**）───
 * 本区语义逐字对应规格 §2.6 的 WATCH/MULTI 条件删/条件写形态，**注释与单测互指**：
 * 直接语义自证住在 `test/claim.service.test.ts` 的「FakeRedis 扩展语义」组（先读它，再读这里）。
 *  - `expire`：键在 ⇒ `1` 且记 TTL；键不在 ⇒ `0`（真 Redis 语义）。TTL **只是一张表**
 *    （`ttls`）——假库不做时间流逝，窗过期语义由栈内 slice-24 ③ 覆盖；
 *  - `set … 'EX' n ['NX']`：`NX` 命中已存在键 ⇒ 返 `null` 且**不写**；无 `EX` 的 SET ⇒
 *    清该键 TTL（真语义）；**未识别的选项形态 ⇒ 当场抛**（形态漂移现形，同 scan 纪律）；
 *  - `watch`/`unwatch`/`multi`/`exec`：
 *    · `watch(keys…)` 对每个键记**当时的写版本快照**；任何写（含「对手」写/直接 `store.set`
 *      种入/队列内 DEL/SET）使版本 **+1**；SET 恒 +1（真 Redis 连**同值 SET** 也算写），
 *      DEL 仅在**真删到**时 +1（无命中不触发失效）；
 *    · `exec()`：被 WATCH 的键在 EXEC 前**被改** ⇒ 返 **`null`（事务弃——队列一条都不执行）**；
 *      未变 ⇒ 依序执行，返 ioredis 形态的结果数组 `[[null, 各命令结果], …]`；EXEC 后
 *      （弃或提交）WATCH 状态清空（真语义）；
 *    · 判定按「**被改过**」而非「值不同」：A→B→A 的中间写同样弃事务（真 Redis 语义）。
 *  - `secondClient()`：「**同库第二客户端**」——共享键值/TTL/写版本，**独立** WATCH 快照与
 *    `calls`/`failKeys`（本类就是「两客户端」并发交错构造的另一半：对手写经由它落库）；
 *  - `injectBefore(op, fn, opts)`：**交错注入面**——下一次（`repeat` 期每次）指定 op 进入时
 *    先调用 `fn`（可异步；先消费再调用，`fn` 内的写不会自触发）。仅**顶层方法**触发
 *    （`exec` 队列内的命令不触发——那是 exec 的原子执行段）。「在 watch 与 exec 之间手动
 *    插入对手操作」即以此为落点（claim.service.test.ts 的两处交错用例各用一个窗口）。
 */
export type FakeRedisOp = 'get' | 'set' | 'del' | 'scan' | 'expire' | 'watch' | 'unwatch' | 'multi' | 'exec';

/**
 * T12：假 Redis 的**共享存储层**（`secondClient()` 与本体同一实例——「同库」就是它）：
 * 键值 + **写版本号** + TTL 表。
 *  - 写版本 = WATCH/EXEC 判定的唯一依据：**任何**写路径（顶层 `set`/`del`、`exec` 队列内
 *    命令、测试直接 `store.set(...)` 的种入、对手客户端的写）经覆写即 **+1**；
 *  - SET 恒记写（真 Redis 连同值 SET 也算「被改」——WATCH 按**被改过**而非「值不同」判定，
 *    A→B→A 的中间写同样弃事务）；
 *  - DEL 仅在**真删到**时记写（无命中不算被改——真 Redis 语义）；
 *  - TTL **只是一张表**：假库不做时间流逝（窗过期语义由栈内 slice-24 ③ 覆盖），
 *    `expire`/`set EX` 写它只为「续期是否回 900」类断言提供读面。
 */
class FakeRedisStore extends Map<string, string> {
  readonly versions = new Map<string, number>();
  readonly ttls = new Map<string, number>();

  versionOf(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  override set(key: string, value: string): this {
    super.set(key, value);
    this.versions.set(key, this.versionOf(key) + 1);
    return this;
  }

  override delete(key: string): boolean {
    if (!super.has(key)) return false;
    super.delete(key);
    this.versions.set(key, this.versionOf(key) + 1);
    return true;
  }
}

/** `set` 的选项形态（**只认实现侧调用**：`'EX' n` / `'EX' n 'NX'`；漂移 ⇒ 当场抛，同 scan 纪律）。 */
interface SetOptions {
  ex?: number;
  nx: boolean;
}

function parseSetOptions(args: unknown[]): SetOptions {
  if (args.length === 0) return { nx: false };
  if (args[0] === 'EX' && typeof args[1] === 'number' && args.length === 2) {
    return { ex: args[1], nx: false };
  }
  if (args[0] === 'EX' && typeof args[1] === 'number' && args[2] === 'NX' && args.length === 3) {
    return { ex: args[1], nx: true };
  }
  throw new Error(`FakeRedis（T12）未识别的 set 选项形态：${args.map(String).join(' ')}`);
}

type QueuedCommand =
  | { kind: 'set'; key: string; value: string; opts: SetOptions }
  | { kind: 'del'; key: string }
  | { kind: 'expire'; key: string; seconds: number };

/** T12：MULTI 链（ioredis 形态：命令排队、返回 this 可链式；`exec()` 一次性执行）。 */
class FakeMulti {
  private readonly queue: QueuedCommand[] = [];

  constructor(private readonly redis: FakeRedis) {}

  set(key: string, value: string, ...args: unknown[]): this {
    this.queue.push({ kind: 'set', key, value, opts: parseSetOptions(args) });
    return this;
  }

  del(key: string): this {
    this.queue.push({ kind: 'del', key });
    return this;
  }

  expire(key: string, seconds: number): this {
    this.queue.push({ kind: 'expire', key, seconds });
    return this;
  }

  async exec(): Promise<Array<[null, unknown]> | null> {
    return this.redis.execQueued(this.queue);
  }
}

export class FakeRedis {
  /** 共享存储层（键值/写版本/TTL）——「同库第二客户端」共享的就是它。 */
  private readonly shared: FakeRedisStore;
  calls: Array<{ op: FakeRedisOp; key: string; value?: string }> = [];
  /** 命中该键的 get/set/del 直接抛（「Redis 挂了」注入面）。 */
  failKeys = new Set<string>();
  /**
   * T8：SCAN 的页大小（0 = 一页全量）。> 0 时按键序分页、游标 = 已发偏移 ——
   * 用例设 1 逼实现的**游标循环**（单发 SCAN 的实现在第 2 页漏处理 ⇒ 当场红）。
   */
  scanPageSize = 0;

  /** 本连接（客户端）的 WATCH 快照：键 → watch 时的写版本；EXEC 对它比对（弃/提交）。 */
  private readonly watchedAt = new Map<string, number>();
  /** T12 注入面：下一次（`repeat` 期每次）指定 op 进入时先调用的钩子（先消费再调用——不自触发）。 */
  private pendingBefore: { op: FakeRedisOp; key?: string; fn: () => void | Promise<void>; repeat: boolean } | null =
    null;

  constructor(
    private readonly timeline: string[] = [],
    shared?: FakeRedisStore,
  ) {
    this.shared = shared ?? new FakeRedisStore();
  }

  /** 键值存储（共享层；直接 `redis.store.set(...)` 种入/对改**也**记写版本——WATCH 判定依赖它）。 */
  get store(): FakeRedisStore {
    return this.shared;
  }

  /** TTL 表（假库不做时间流逝——只作「续期是否回 900」等断言的读面）。 */
  get ttls(): Map<string, number> {
    return this.shared.ttls;
  }

  /**
   * T12：**同库第二客户端**——共享键值/写版本/TTL，**独立** WATCH 快照与 `calls`/`failKeys`
   * （本类即「两客户端 + 手动插入对手操作」交错构造的另一半：对手写经由它落库）。
   */
  secondClient(): FakeRedis {
    return new FakeRedis(this.timeline, this.shared);
  }

  /**
   * T12：**交错注入面** —— 下一次（`opts.repeat` 为 true 则此后每次）指定 op 进入时先调用
   * `fn`（可异步）。仅**顶层方法**触发（`exec` 队列内的命令不触发——那是 exec 的原子
   * 执行段）。「在 watch 与 exec 之间手动插入对手操作」即以此为落点（claim.service.test.ts
   * 的两个交错用例各用一个窗口；key 过滤：watch 按 keys 包含匹配，其余按单键相等）。
   */
  injectBefore(op: FakeRedisOp, fn: () => void | Promise<void>, opts: { key?: string; repeat?: boolean } = {}): void {
    this.pendingBefore = { op, key: opts.key, fn, repeat: opts.repeat ?? false };
  }

  private async runPending(op: FakeRedisOp, key?: string): Promise<void> {
    const pending = this.pendingBefore;
    if (pending === null || pending.op !== op) return;
    if (pending.key !== undefined && pending.key !== key) return;
    if (!pending.repeat) this.pendingBefore = null;
    await pending.fn();
  }

  /** T12：EXPIRE（键在 ⇒ 1（TTL 记入）；键不在 ⇒ 0——真 Redis 语义）。 */
  async expire(key: string, seconds: number): Promise<number> {
    this.calls.push({ op: 'expire', key, value: String(seconds) });
    this.timeline.push(`expire:${key}`);
    if (this.failKeys.has(key)) throw new Error('redis down（仿真）');
    await this.runPending('expire', key);
    return this.applyExpire(key, seconds);
  }

  /** T12：WATCH —— 对每个键记**当时的写版本快照**（注入钩子在此取快照**前**落点）。 */
  async watch(...keys: string[]): Promise<'OK'> {
    this.calls.push({ op: 'watch', key: keys.join(',') });
    const pending = this.pendingBefore;
    if (pending !== null && pending.op === 'watch' && (pending.key === undefined || keys.includes(pending.key))) {
      if (!pending.repeat) this.pendingBefore = null;
      await pending.fn();
    }
    for (const key of keys) this.watchedAt.set(key, this.shared.versionOf(key));
    return 'OK';
  }

  /** T12：UNWATCH（清快照——条件删的「否则 UNWATCH」分支）。 */
  async unwatch(): Promise<'OK'> {
    this.calls.push({ op: 'unwatch', key: '' });
    await this.runPending('unwatch');
    this.watchedAt.clear();
    return 'OK';
  }

  /** T12：MULTI 链（set/del/expire 排队；`exec()` 原子执行——WATCH 失效则整体弃）。 */
  multi(): FakeMulti {
    this.calls.push({ op: 'multi', key: '' });
    return new FakeMulti(this);
  }

  /**
   * T12：`FakeMulti.exec()` 的委托 —— 注入钩子（exec 路径）⇒ **脏检查** ⇒ 依序应用。
   * 被 WATCH 的键在 EXEC 前被改 ⇒ 返 `null` 且**队列一条都不执行**（事务弃）；
   * 未变 ⇒ 依序执行、返 ioredis 形态的结果数组 `[[null, 各命令结果], …]`。
   * EXEC 后（弃或提交）WATCH 状态一律清空（真语义）。
   */
  async execQueued(queue: QueuedCommand[]): Promise<Array<[null, unknown]> | null> {
    this.calls.push({ op: 'exec', key: '' });
    await this.runPending('exec');
    let dirty = false;
    for (const [key, at] of this.watchedAt) {
      if (this.shared.versionOf(key) !== at) {
        dirty = true;
        break;
      }
    }
    this.watchedAt.clear();
    if (dirty) return null;
    const results: Array<[null, unknown]> = [];
    for (const cmd of queue) {
      if (cmd.kind === 'set') results.push([null, this.applySet(cmd.key, cmd.value, cmd.opts)]);
      else if (cmd.kind === 'del') results.push([null, this.applyDel(cmd.key)]);
      else results.push([null, this.applyExpire(cmd.key, cmd.seconds)]);
    }
    return results;
  }

  private applySet(key: string, value: string, opts: SetOptions): 'OK' | null {
    if (opts.nx && this.shared.has(key)) return null; // NX 命中已存在键 ⇒ 不写
    this.shared.set(key, value);
    if (opts.ex !== undefined) this.shared.ttls.set(key, opts.ex);
    else this.shared.ttls.delete(key); // 无 EX 的 SET ⇒ 清 TTL（真语义）
    return 'OK';
  }

  private applyDel(key: string): number {
    const existed = this.shared.delete(key);
    this.shared.ttls.delete(key);
    return existed ? 1 : 0;
  }

  private applyExpire(key: string, seconds: number): number {
    if (!this.shared.has(key)) return 0;
    this.shared.ttls.set(key, seconds);
    return 1;
  }

  /**
   * T8：只认实现侧的调用形态 `('MATCH', pattern, 'COUNT', n)`（形态漂移 ⇒ 这里现形）；
   * 返回 `[nextCursor, keys]`（游标 '0' = 翻页结束；键序为确定性排序）。
   */
  async scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
    const pattern = args[0] === 'MATCH' ? String(args[1]) : '';
    this.calls.push({ op: 'scan', key: pattern });
    const matches = [...this.store.keys()]
      .filter((key) => (pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern))
      .sort();
    if (this.scanPageSize <= 0 || this.scanPageSize >= matches.length) {
      return ['0', matches];
    }
    const offset = Number(cursor);
    const page = matches.slice(offset, offset + this.scanPageSize);
    const next = offset + this.scanPageSize >= matches.length ? '0' : String(offset + this.scanPageSize);
    return [next, page];
  }

  async get(key: string): Promise<string | null> {
    this.calls.push({ op: 'get', key });
    if (this.failKeys.has(key)) throw new Error('redis down（仿真）');
    await this.runPending('get', key);
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    const opts = parseSetOptions(args);
    this.calls.push({ op: 'set', key, value });
    this.timeline.push(`set:${key}`);
    if (this.failKeys.has(key)) throw new Error('redis down（仿真）');
    await this.runPending('set', key);
    return this.applySet(key, value, opts);
  }

  async del(key: string): Promise<number> {
    this.calls.push({ op: 'del', key });
    this.timeline.push(`del:${key}`);
    if (this.failKeys.has(key)) throw new Error('redis down（仿真）');
    await this.runPending('del', key);
    return this.applyDel(key);
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DataSource, type EntityManager } from 'typeorm';
import {
  CURRENCY_SOURCES,
  ErrCode,
  currencyApplyHash,
  normalizeOwnerType,
  validateCurrencyApply,
  type CurrencyApplyResponse,
  type CurrencyOwnerType,
} from '@fight-the-landlord/protocol';
import { REDIS, setBalance } from '../redis/redis.module';
import {
  CURRENCY_SOURCE_INVALID,
  currencyApplyEntriesTotal,
  currencyApplyTotal,
  currencyReconcileCacheDriftTotal,
} from '../metrics/currency.metrics';

/**
 * 货币核心（T3；规格 §2.3 判定算法 **逐字**）：`currency.apply` —— **唯一写边**的内核。
 *
 * ─── 算法骨架（§2.3 步骤 1–4，逐条对应）──────────────────────────────────
 *  ① 单事务首步 `INSERT currency_ops`（`request_hash = currencyApplyHash()`）——**唯一写边**
 *     的幂等锚。命中 `uk_action_id`（重放/并发撞键）⇒ 事务整体回滚（错误穿出
 *     `dataSource.transaction` 回调即回滚）⇒ 转「重放判定」（**新事务**读 ops 比对 hash：
 *     相同 ⇒ 按 `flows ORDER BY owner_id` 重建响应 `replayed:true`；不同 ⇒ 14002）。
 *  ② 逐 entry（**ownerId 升序** = 指纹序 = 重建序，⚙️3）：
 *     a. 类型闸 SELECT（普通快照读；行在且异型 ⇒ 10001 + level=error）；首写固化（⚙️1）。
 *     b. 余额步（三步，§5.3 逐字）：条件 UPDATE（`balance + delta >= 0` 由 **SQL** 裁决；
 *        成功判据 = `affectedRows === 1`，0/1 之外 ⇒ 内部错响亮 —— **⚙️14③**）；
 *        0 行 ⇒ `INSERT IGNORE(owner_id, owner_type, balance)` 消化「行不存在」与
 *        「并发首建」二义（**不改写既有行** ⇒ 首写类型固化）—— 判读其受影响行数（⚙️12）：
 *        0（行已存在，可能是并发他人首建）⇒ 先**锁定读**重查 `owner_type`（**⚙️14②**；
 *        异型 ⇒ 10001）⇒ **重试本步一次**；仍 0 ⇒ **14001**（整批回滚）。
 *     c. 同事务**锁定读**快照 `SELECT balance, owner_type … FOR UPDATE`（**⚙️14①**：读到
 *        自身未提交写值 + 最新已提交版本的 `owner_type` 并断言一致——闭合「步 a 之后、
 *        并发事务首写**异型**行并提交、本事务 UPDATE 按当前读命中并成功」的 POS 路径）
 *        ⇒ 该条 `balanceAfter`。
 *  ③ 全部 entry 走完后再逐条 `INSERT currency_flows` ⇒ 提交。
 *  ④ **提交后**写穿缓存（§2.11）：失败不回滚（warn + counter；权威值在 MySQL 与响应里）。
 *
 * ─── 错误姿态（R220 信封，与 `record.rpc.controller` 同口径）─────────────
 *  - **业务错误不抛**：校验失败/10001/14001/14002 ⇒ `{ok:false, code, message}`（中文原因）。
 *  - **系统级故障抛**（DB 不可达、驱动回执畸形、不变量破坏）⇒ 由 T4 的 RPC 控制器映射
 *    `UPSTREAM_UNAVAILABLE`，调用方 3s 超时纪律兜底（§2.3 末段）。
 *  - 幂等/并发正确性的**真语义在 MySQL**（单事务 + `uk_action_id` + 条件 UPDATE）；
 *    单测（含 `apply.concurrency.test.ts`）只钉**控制流**，不声称证明原子性（C7 真栈
 *    载体 = T10 slice-17 并发 burst）。⚙️14：T3 审查以**真库双会话**实证了 ⚙️12「普通
 *    SELECT 重查」在 REPEATABLE READ 下的**假闭合**（读不到并发已提交行；正 delta 时
 *    条件 UPDATE 按当前读直接命中并发首写行成功收尾、到不了重查点）——本版即订正形态
 *    （重查/快照②处改锁定读 + `affectedRows === 1` 收紧）；真库双会话负向用例留 ② 准入。
 *
 * ⚠️ **DI 纪律**：`DataSource` 与仓内先例一致**值导入**（`import type` 会让容器解析不到
 * token —— 单测与 tsc 都看不见，真容器启动即崩）；`Redis` 只作参数类型 ⇒ `import type` 安全。
 */

/** 一次 apply = 一行 ops（§2.10 DDL 列序逐字；`created_at` 走列默认值）。 */
const OPS_INSERT_SQL =
  'INSERT INTO `currency_ops` (`action_id`, `request_hash`, `source`, `actor`, `reason`, `ref_id`, `trace_id`, `burned_residue`, `burned_rake`) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

/** 重放判定：读幂等锚（新事务；不复用已回滚事务的连接/快照）。 */
const OPS_SELECT_SQL = 'SELECT `id`, `request_hash` FROM `currency_ops` WHERE `action_id` = ?';

/**
 * 重放重建的读面。⚠️ **不得裸信本 SQL 的 `ORDER BY owner_id`**（⚙️13）：列 collation 是
 * `utf8mb4_0900_ai_ci`（大小写不敏感），与 hash/执行序的 **JS code-unit 升序**在混合大小写
 * 下不一致（'B'(0x42) < 'a'(0x61) 是 JS 序，MySQL 折叠后相反）⇒ 读出后**应用层按与
 * `currencyApplyHash` 同一比较器**（`byOwnerIdAsc`）重排（见 `replay()`）。
 */
const FLOWS_BY_OP_SQL =
  'SELECT `owner_id`, `balance_after` FROM `currency_flows` WHERE `op_id` = ? ORDER BY `owner_id`';

/** a. 类型闸（普通快照读；行不存在 ⇒ `[]` ⇒ 放行，首写由 INSERT IGNORE 固化）。 */
const OWNER_TYPE_SELECT_SQL = 'SELECT `owner_type` FROM `currency_accounts` WHERE `owner_id` = ?';

/**
 * ⚙️14②：⚙️12 重查（INSERT IGNORE 0 行分支）改**锁定读** —— REPEATABLE READ 下普通
 * SELECT 读不到并发已提交行（T3 审查真库双会话实证）；`FOR UPDATE` 读**最新已提交版本**，
 * 异型行才真的看得见（⇒ 10001）。
 */
const OWNER_TYPE_SELECT_FOR_UPDATE_SQL =
  'SELECT `owner_type` FROM `currency_accounts` WHERE `owner_id` = ? FOR UPDATE';

/** 余额步的条件更新：**扣款够不够只由本 SQL 裁决**（§2.11 表末行）。 */
const BALANCE_UPDATE_SQL =
  'UPDATE `currency_accounts` SET `balance` = `balance` + ? WHERE `owner_id` = ? AND `balance` + ? >= 0';

/** 首建行（⚙️1：列清单必须含 `owner_type` —— 缺了会被列默认 `'user'` 覆盖）。 */
const ACCOUNT_INSERT_IGNORE_SQL =
  'INSERT IGNORE INTO `currency_accounts` (`owner_id`, `owner_type`, `balance`) VALUES (?, ?, 0)';

/**
 * c. 快照（**⚙️14①**：普通 SELECT ⇒ **锁定读 + 带 `owner_type`**）—— 锁定读读**最新
 * 已提交版本**：既取 `balanceAfter`（本事务自身未提交写值对自身可见），又当场断言并发
 * 首写的 `owner_type` 与归一化传入值一致（异型 ⇒ 10001、整批回滚）。
 */
const BALANCE_SNAPSHOT_FOR_UPDATE_SQL =
  'SELECT `balance`, `owner_type` FROM `currency_accounts` WHERE `owner_id` = ? FOR UPDATE';

/** 流水逐条（只增不改、永不清洗）。 */
const FLOW_INSERT_SQL =
  'INSERT INTO `currency_flows` (`op_id`, `owner_id`, `owner_type`, `delta`, `balance_after`) ' +
  'VALUES (?, ?, ?, ?, ?)';

/**
 * 业务拒绝（10001/14001）：只在事务回调内抛 —— 错误穿出回调 ⇒ 驱动回滚**整批**，
 * 然后由 `apply()` 统一翻成 `{ok:false}` 信封（**不**穿到调用方）。
 * `logLevel`：owner_type 异型是「响亮 error」（§2.12 日志列），其余拒绝为 warn。
 */
class ApplyRejectError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
    readonly logLevel: 'warn' | 'error',
  ) {
    super(message);
    this.name = 'ApplyRejectError';
  }
}

/**
 * **可选事务内钩子**（记牌器收费片）：在 ops/flows 写完之后、commit 之前执行，
 * 接收同一 `EntityManager`（参与同一事务；抛错 ⇒ 整批回滚）。
 *
 * 仅供**同进程**的货币写边（如购买端点）使用；RPC `currency.apply` 不经过它。
 */
export type ApplyEffect = (manager: EntityManager) => Promise<void>;

/**
 * effect 的**业务拒绝**（记牌器收费片）：`applyWithEffect` 捕获它并翻成
 * `{ok:false, code, message}`（与 `ApplyRejectError` 同姿态，事务已整批回滚）。
 * 与私有 `ApplyRejectError` 分开是因为 effect 由**其它服务类**提供，必须可构造/可识别。
 */
export class ApplyEffectRejectError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApplyEffectRejectError';
  }
}

/** 执行序 = 指纹序 = 重建序（⚙️3）：纯码点比较，与 `currencyApplyHash` 的内部排序同式。 */
function byOwnerIdAsc(a: { ownerId: string }, b: { ownerId: string }): number {
  return a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0;
}

/**
 * 驱动回执的 `affectedRows` 判读：**必须**是整数 —— 读不出（undefined/畸形）就抛。
 * 这里**不得**把「读不出」当 0：那会让条件更新成功的写被再执行一次（重复扣款），
 * 或把成功当失败误报 14001。
 */
function affectedRowsOf(result: unknown, context: string): number {
  const affected = (result as { affectedRows?: unknown } | null)?.affectedRows;
  if (typeof affected !== 'number' || !Number.isInteger(affected)) {
    throw new Error(`${context}：驱动未返回 affectedRows（收到 ${JSON.stringify(result)}）—— 拒绝继续`);
  }
  return affected;
}

/** `currency_ops.id`（bigint 读出转 number——⚙️6；本片量级远低于 2^53，但形态必须校验）。 */
function insertIdOf(result: unknown): number {
  const id = (result as { insertId?: unknown } | null)?.insertId;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`currency_ops INSERT 未返回自增 id（收到 ${JSON.stringify(result)}）`);
  }
  return id;
}

/** 从库里读出的 number/bigint ⇒ 安全整数（读不出 ⇒ 抛，不静默转 NaN）。 */
function toSafeNumber(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/**
 * 撞键判定：**只认 `uk_action_id`**（重放/并发撞键）。mysql2 的驱动错误带
 * `code='ER_DUP_ENTRY'`/`errno=1062`；message 里必须出现 `uk_action_id`（真 MySQL 的
 * 1062 文案含索引名，假 DB 同形）。
 *
 * ⚠️ 记牌器收费片收紧：effect 还会写 `card_counter_purchases` 的
 * `uk_cc_purchase_action` ——「**任何 1062 都算撞键**」会把别的唯一键冲突误导向
 * `replay()`（读不到本 actionId 的 ops 行 ⇒ 不变量守卫抛系统错）。收紧后其余 1062
 * 原样抛系统错（响亮），不得静默重放。
 * ⚠️ 误判代价不对称：把本应撞键的判成系统错会丢掉幂等（可重试救）；把别的 1062
 * 误判成撞键 = 把真实约束冲突藏起来。后者更坏。
 */
function isDuplicateEntryError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown };
  const message = typeof e.message === 'string' ? e.message : '';
  // 只认 `for key '...uk_action_id'`（MySQL 8 带表前缀、5.7 不带；避免 actionId/requestId 的
  // **值**里恰好含 uk_action_id 时把别的唯一键 1062 误导向 replay）。
  if (!/for key '(?:[^']*\.)?uk_action_id'/i.test(message)) return false;
  return e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /Duplicate entry/i.test(message);
}

/** 校验失败时的 actionId 观测面（可能根本不是字符串 ⇒ 原样 JSON 化）。 */
function actionIdOf(req: unknown): string {
  const actionId = (req as { actionId?: unknown } | null)?.actionId;
  return typeof actionId === 'string' ? actionId : JSON.stringify(actionId ?? null);
}

/** 校验失败时的 source 标签：allowlist 之外（含缺省/非法）一律 `invalid` 哨兵（防基数无界）。 */
function sourceLabelOf(req: unknown): string {
  const source = (req as { source?: unknown } | null)?.source;
  return typeof source === 'string' && (CURRENCY_SOURCES as readonly string[]).includes(source)
    ? source
    : CURRENCY_SOURCE_INVALID;
}

@Injectable()
export class ApplyService {
  private readonly logger = new Logger(ApplyService.name);

  /**
   * ⚠️ **显式 `@Inject(...)`**（本仓既有惯例）：不依赖 `emitDecoratorMetadata` 发出的
   * `design:paramtypes`（vitest/esbuild 不发它 ⇒ 只靠类型的注入在单测里会静默注入 `undefined`）。
   */
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * 唯一写边入口（T4 的 RPC 控制器唯一调用方）。
   *
   * 入参取 `unknown`：**唯一校验点** `validateCurrencyApply`（T2 契约）就在下一行 ——
   * 让「调用方先自己校验」成为不可能（线到的一切都从这扇门过）。
   * 返回**信封**（`RpcResult<CurrencyApplyData>`）：业务错误不抛（R220）。
   */
  async apply(req: unknown): Promise<CurrencyApplyResponse> {
    return this.applyWithEffect(req, async () => undefined);
  }

  /**
   * 唯一写边的**同一内核** + 可选事务钩子（记牌器收费片）。`apply(req)` ≡
   * `applyWithEffect(req, noop)` —— 校验/事务体/重放/指标/日志/写穿**只有一份**。
   *
   * effect 在 flows 写完之后、commit 之前执行，接收同一 `EntityManager`；抛错 ⇒
   * 整批回滚。重放分支**不执行** effect（原事务已原子提交）。
   */
  async applyWithEffect(req: unknown, effect: ApplyEffect): Promise<CurrencyApplyResponse> {
    // ── 校验入口（§2.3 末段：失败 ⇒ 10001 + 中文原因；先于**任何**库操作）────────
    let request: {
      actionId: string;
      source: string;
      entries: Array<{ ownerId: string; ownerType?: CurrencyOwnerType; delta: number }>;
      actor?: string;
      reason?: string;
      refId?: string;
      burn?: { residue: number; rake: number };
      meta?: { traceId: string };
    };
    try {
      validateCurrencyApply(req);
      request = req as typeof request;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `currency.apply reject actionId=${actionIdOf(req)} code=${ErrCode.BAD_PARAM} reason=${message}`,
      );
      currencyApplyTotal.inc({ source: sourceLabelOf(req), result: 'reject' });
      return { ok: false, code: ErrCode.BAD_PARAM, message };
    }

    const source = request.source;
    // 执行序 = 指纹序（⚙️3）：排序后再执行；ownerType 归一化一次、全程复用（⚙️1）。
    const entries = [...request.entries].sort(byOwnerIdAsc).map((entry) => ({
      ownerId: entry.ownerId,
      ownerType: normalizeOwnerType(entry.ownerType),
      delta: entry.delta,
    }));
    const requestHash = currencyApplyHash(request);

    // ── ① 单事务：ops 首步 → 逐 entry 三步 → flows 逐条 → 提交 ────────────────
    let committed: { opId: number; balances: Array<{ ownerId: string; balanceAfter: number }> };
    try {
      committed = await this.dataSource.transaction(async (manager) => {
        const insertedOp = await manager.query(OPS_INSERT_SQL, [
          request.actionId,
          requestHash,
          request.source,
          request.actor ?? null,
          request.reason ?? null,
          request.refId ?? null,
          request.meta?.traceId ?? null,
          request.burn?.residue ?? null,
          request.burn?.rake ?? null,
        ]);
        const opId = insertIdOf(insertedOp);

        const balances: Array<{ ownerId: string; balanceAfter: number }> = [];
        for (const entry of entries) {
          // a. 类型闸（普通快照读）
          await this.assertOwnerTypeMatches(manager, entry.ownerId, entry.ownerType, false);
          await this.applyBalanceStep(manager, entry.ownerId, entry.ownerType, entry.delta); // b. 余额步
          // c. 快照：⚙️14① 锁定读 + owner_type 断言（并发异型首写 ⇒ 10001、整批回滚）
          const balanceAfter = await this.snapshotBalance(manager, entry.ownerId, entry.ownerType);
          balances.push({ ownerId: entry.ownerId, balanceAfter });
        }
        // ③ 全部 entry 完成后再逐条写流水（§2.3 步骤 3 的次序；与 entry 交错写不是本算法）
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]!;
          await manager.query(FLOW_INSERT_SQL, [
            opId,
            entry.ownerId,
            entry.ownerType,
            entry.delta,
            balances[i]!.balanceAfter,
          ]);
        }
        // ④ effect（记牌器收费片）：同一事务、flows 之后、commit 之前；抛错 ⇒ 整批回滚。
        await effect(manager);
        return { opId, balances };
      });
    } catch (err) {
      // 撞 `uk_action_id`（重放/并发撞键）⇒ 事务已整体回滚 ⇒ 转重放判定（新事务读）
      if (isDuplicateEntryError(err)) {
        return await this.replay(request.actionId, requestHash, source);
      }
      if (err instanceof ApplyRejectError || err instanceof ApplyEffectRejectError) {
        // 业务拒绝：整批回滚已由驱动完成（错误穿出事务回调）——这里只翻信封 + 观测
        const code = err.code;
        const logLevel = err instanceof ApplyRejectError ? err.logLevel : 'warn';
        const line =
          `currency.apply reject actionId=${request.actionId} code=${code} reason=${err.message}`;
        if (logLevel === 'error') this.logger.error(line);
        else this.logger.warn(line);
        currencyApplyTotal.inc({ source, result: 'reject' });
        return { ok: false, code, message: err.message };
      }
      // 系统级故障：不吞（T4 控制器 ⇒ UPSTREAM_UNAVAILABLE；调用方 10007 映射）
      throw err;
    }

    // ── 提交成功：指标 → ④ 写穿缓存（失败不回滚）→ 响应 ────────────────────
    currencyApplyTotal.inc({ source, result: 'ok' });
    currencyApplyEntriesTotal.inc(entries.length);
    this.logger.log(
      `currency.apply ok actionId=${request.actionId} opId=${committed.opId} entries=${entries.length}`,
    );
    await this.writeThrough(committed.balances);
    return {
      ok: true,
      data: {
        opId: committed.opId,
        actionId: request.actionId,
        entries: committed.balances,
        replayed: false,
      },
    };
  }

  /**
   * a. 类型闸（`locking=false`，普通快照读）/ ⚙️12 重查（**`locking=true`，⚙️14② 锁定读**）
   * ——同一断言两处调用：行在且 ≠ 归一化 ownerType ⇒ **10001** + 响亮 error 日志（首写固化
   * 不可变，⚙️1）。行不存在 ⇒ 放行（首写由 INSERT IGNORE 固化）。
   */
  private async assertOwnerTypeMatches(
    manager: EntityManager,
    ownerId: string,
    ownerType: CurrencyOwnerType,
    locking: boolean,
  ): Promise<void> {
    const sql = locking ? OWNER_TYPE_SELECT_FOR_UPDATE_SQL : OWNER_TYPE_SELECT_SQL;
    const rows = (await manager.query(sql, [ownerId])) as Array<{ owner_type: unknown }>;
    if (rows.length === 0) return;
    this.assertOwnerTypeValue(ownerId, String(rows[0]!.owner_type), ownerType);
  }

  /**
   * 异型 ⇒ **10001**（响亮 error；错误穿出事务回调 ⇒ 驱动整批回滚）。行存在性由调用点保证
   * （步 a / ⚙️14② 重查 / ⚙️14① 快照三处共用）。
   */
  private assertOwnerTypeValue(ownerId: string, existing: string, expected: CurrencyOwnerType): void {
    if (existing !== expected) {
      throw new ApplyRejectError(
        ErrCode.BAD_PARAM,
        `ownerId=${ownerId} 的 ownerType 已固化为 '${existing}'，与本次请求的 '${expected}' 不一致（首写不可变）`,
        'error',
      );
    }
  }

  /**
   * b. 余额步（§5.3 三步 + ⚙️12 判读 + **⚙️14 订正**，逐字）：
   *  1) 条件 UPDATE（`balance + delta >= 0`）—— 回执**恰 1 行** ⇒ 成功；0/1 之外 ⇒ 内部错
   *     响亮（**⚙️14③**：不得静默按成功）；
   *  2) 0 行 ⇒ `INSERT IGNORE`（消化「行不存在」与「并发首建」二义；**不改写既有行**）；
   *     受影响行数 = 0（行已存在，可能是并发他人首建）⇒ 先**锁定读**重查 `owner_type`
   *     （**⚙️14②**：RR 下普通 SELECT 读不到并发已提交行 = 等于没查；异型 ⇒ 10001）；
   *  3) **重试本步一次**（INSERT IGNORE 真的建了行时也要补这一次 —— 上一次 UPDATE
   *     发生在行存在之前）；仍 0 行 ⇒ **14001**（本错误穿出事务回调 ⇒ 整批回滚）。
   */
  private async applyBalanceStep(
    manager: EntityManager,
    ownerId: string,
    ownerType: CurrencyOwnerType,
    delta: number,
  ): Promise<void> {
    const updated = await manager.query(BALANCE_UPDATE_SQL, [delta, ownerId, delta]);
    if (this.updateAffected(updated, `余额条件更新 ownerId=${ownerId}`) === 1) return;

    const inserted = await manager.query(ACCOUNT_INSERT_IGNORE_SQL, [ownerId, ownerType]);
    if (affectedRowsOf(inserted, `账户首建 INSERT IGNORE ownerId=${ownerId}`) === 0) {
      // ⚙️12：行已存在（典型 = 余额不足；也可能是并发他人首建的 —— 那条窄洞里
      // 类型闸的 SELECT 发生在行出现**之前**，必须在这里补一次一致性检查）。
      // ⚙️14②：重查必须是**锁定读**——普通 SELECT 在 RR 下读不到并发已提交行。
      await this.assertOwnerTypeMatches(manager, ownerId, ownerType, true);
    }

    const retried = await manager.query(BALANCE_UPDATE_SQL, [delta, ownerId, delta]);
    if (this.updateAffected(retried, `余额条件更新重试 ownerId=${ownerId}`) === 0) {
      throw new ApplyRejectError(
        ErrCode.E_INSUFFICIENT_FUNDS,
        `ownerId=${ownerId} 余额不足：整批回滚（delta=${delta}）`,
        'warn',
      );
    }
  }

  /**
   * ⚙️14③：条件 UPDATE 的回执判读**收紧为「恰 0/1 行」**——成功判据 `affectedRows === 1`；
   * 0/1 之外（含 > 1）⇒ 内部错**响亮**：error 日志 + 系统级错抛穿（**不得**静默按成功 ——
   * 那会把多行误写/重复扣款带进流水）。`owner_id` 有主键/唯一约束 ⇒ > 1 物理上不可达，
   * 属不变量守卫。
   */
  private updateAffected(result: unknown, context: string): 0 | 1 {
    const affected = affectedRowsOf(result, context);
    if (affected !== 0 && affected !== 1) {
      const reason = `${context}：affectedRows=${affected}（owner_id 有唯一约束 ⇒ 0/1 之外是不变量破坏）`;
      this.logger.error(`currency.apply internal error ${reason}`);
      throw new Error(reason);
    }
    return affected;
  }

  /**
   * c. 快照（**⚙️14①**：锁定读 + `owner_type` 断言）：普通 SELECT 在 RR 下读不到并发已
   * 提交行（⚙️12 假闭合同源）；`FOR UPDATE` 读**最新已提交版本**——既取 `balanceAfter`
   * （自身未提交写值对自身可见），又当场捕获「步 a 之后并发首写的**异型**行」（异型 ⇒
   * 10001、整批回滚）。行丢了 = 不变量破坏 ⇒ 抛。
   */
  private async snapshotBalance(
    manager: EntityManager,
    ownerId: string,
    ownerType: CurrencyOwnerType,
  ): Promise<number> {
    const rows = (await manager.query(BALANCE_SNAPSHOT_FOR_UPDATE_SQL, [ownerId])) as Array<{
      balance: unknown;
      owner_type: unknown;
    }>;
    if (rows.length === 0) {
      throw new Error(`currency_accounts 快照读不到 ownerId=${ownerId} 的行（余额步刚保证它在）`);
    }
    this.assertOwnerTypeValue(ownerId, String(rows[0]!.owner_type), ownerType);
    return toSafeNumber(rows[0]!.balance, `currency_accounts.balance ownerId=${ownerId}`);
  }

  /**
   * 重放判定（§2.3「重放判定（新事务）」逐字）：读 ops 比对 `request_hash` ——
   * 相同 ⇒ 按 flows 重建响应（`replayed:true`，**历史值**；序 = 应用层按 hash 同一比较器
   * 重排的 JS code-unit 升序，⚙️13）；不同 ⇒ **14002**（`{ok:false}` + 响亮 error 日志
   * ——「同 id 不同内容」永远是人祸）。
   *
   * ⚠️ **不复用原事务连接/快照**（REPEATABLE READ 下原（已回滚的）事务可能读不到并发
   * 已提交行）—— 这里开**新事务**；并发撞键的锁等待窗口由调用方 3s 超时纪律兜底。
   * ⚠️ 重放**不**写穿缓存：重建值是历史快照（后续 op 可能已再改余额），写回会把缓存
   * 拽回旧值 —— 缓存的新鲜度只由新时代的写穿/读穿/对账负责。
   */
  private async replay(
    actionId: string,
    requestHash: string,
    source: string,
  ): Promise<CurrencyApplyResponse> {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const ops = (await manager.query(OPS_SELECT_SQL, [actionId])) as Array<{
        id: unknown;
        request_hash: unknown;
      }>;
      if (ops.length === 0) {
        // 撞键（uk_action_id）后读不到行 = 不变量破坏（撞键意味着胜者已提交且不可删）——
        // 系统级故障姿态：抛，不静默编造「重放成功」。
        throw new Error(`currency_ops 撞键后读不到 actionId=${actionId} 的行（不变量破坏）`);
      }
      const opId = toSafeNumber(ops[0]!.id, 'currency_ops.id');
      if (ops[0]!.request_hash !== requestHash) {
        return { conflict: true as const, opId, entries: [] };
      }
      const flows = (await manager.query(FLOWS_BY_OP_SQL, [opId])) as Array<{
        owner_id: unknown;
        balance_after: unknown;
      }>;
      // ⚙️13：读出后按**与 `currencyApplyHash` 同一比较器**（JS code-unit 升序）重排 ——
      // 响应 `entries` 的序 = 执行序 = 指纹序（⚙️3），与 DB 列 collation 的序无关。
      const entries = flows
        .map((row) => ({
          ownerId: String(row.owner_id),
          balanceAfter: toSafeNumber(row.balance_after, 'currency_flows.balance_after'),
        }))
        .sort(byOwnerIdAsc);
      return { conflict: false as const, opId, entries };
    });

    if (outcome.conflict) {
      const message = `actionId=${actionId} 已被不同载荷使用（同 id 不同内容）`;
      this.logger.error(`currency.apply reject actionId=${actionId} code=${ErrCode.E_ACTION_CONFLICT} reason=${message}`);
      currencyApplyTotal.inc({ source, result: 'reject' });
      return { ok: false, code: ErrCode.E_ACTION_CONFLICT, message };
    }

    this.logger.log(
      `currency.apply replay actionId=${actionId} opId=${outcome.opId} entries=${outcome.entries.length}`,
    );
    currencyApplyTotal.inc({ source, result: 'replay' });
    return {
      ok: true,
      data: { opId: outcome.opId, actionId, entries: outcome.entries, replayed: true },
    };
  }

  /**
   * ④ 写穿缓存（§2.11）：**提交后**逐条 SET；失败**不回滚**（权威值在 MySQL 与响应里）
   * ⇒ level=warn（`cache_write_failed`）+ `currency_reconcile_cache_drift_total` inc
   * （best-effort；对账检查 2 会 DEL 掉下读回源）。
   * ⚠️ 逐条 try/catch：一条失败不得跳过其余条（多账户批里每条独立）。
   */
  private async writeThrough(
    balances: Array<{ ownerId: string; balanceAfter: number }>,
  ): Promise<void> {
    for (const { ownerId, balanceAfter } of balances) {
      try {
        await setBalance(this.redis, ownerId, balanceAfter);
      } catch (err) {
        currencyReconcileCacheDriftTotal.inc();
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(`cache_write_failed ownerId=${ownerId} balance=${balanceAfter} reason=${reason}`);
      }
    }
  }
}

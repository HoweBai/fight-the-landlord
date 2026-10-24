/**
 * 货币核心（P2-①）的**协议契约面**（规格 §2.2 导出面逐字；唯一真源，禁双份实现）。
 *
 * 服务端（currency-service）与调用方（user-service / ② 的对局结算 / 支付片）共用本文件：
 * allowlist、ownerId/delta 约束、`request_hash` 规范化都在这里收口（§5.4）。
 *
 * ⚠️ **本文件经 `src/index.ts` 的 `export *` 进入客户端依赖面**（`apps/client` 只允许依赖本包，
 * vite alias 直指 `packages/protocol/src/index.ts`）⇒ **不得静态引入 `node:crypto` 等 node 内建**：
 * Vite 会把 node 内建在浏览器侧换成「一旦访问就抛错」的空模块（dev 形态还会把命名导入改写成
 * 顶层解构 ⇒ `export *` 一求值整包就炸）。sha256 因此是下面这份**纯 TS 零依赖实现**；
 * 其逐字节正确性由 `currency.test.ts` 用 `node:crypto`（仅测试侧）交叉复算兜住。
 */
import type { RpcMeta, RpcResult } from './rpc';
import { ProtocolError } from './validate';

/** source allowlist（② 金币场已扩容：+game_settle/+robot_pool/+relief_grant；③ T1：+admin_reverse——写入口单点；
 *  支付片 T1：+5 源 `recharge/refund_hold/refund_rollback/withdraw_hold/withdraw_rollback`；台费片 T1：+`entry_fee`，
 *  二者均**追加在尾** ⇒ 共 12 值）。 */
export const CURRENCY_SOURCES = [
  'signup_grant',
  'admin_adjust',
  'game_settle',
  'robot_pool',
  'relief_grant',
  'admin_reverse',
  'recharge',
  'refund_hold',
  'refund_rollback',
  'withdraw_hold',
  'withdraw_rollback',
  'entry_fee',
  // 记牌器收费片（尾追第 13 源）
  'card_counter',
] as const;
export type CurrencySource = (typeof CURRENCY_SOURCES)[number];

/** ownerType allowlist（`robot` 为 ② 的机器人虚拟币池预埋，本片无写入者）。 */
export const CURRENCY_OWNER_TYPES = ['user', 'robot'] as const;
export type CurrencyOwnerType = (typeof CURRENCY_OWNER_TYPES)[number];

export interface CurrencyEntryIn {
  ownerId: string;
  /** 缺省归一 `'user'`；参与 request_hash（§2.3 字段表）。 */
  ownerType?: CurrencyOwnerType;
  /** 正 = 入账、负 = 出账；≠0 且 |delta| ≤ cap（source 化：缺省 1,000,000，`game_settle`/`robot_pool` 为 2^31−1）。 */
  delta: number;
}

/**
 * 结算销毁（本片；仅 `game_settle`）：截断残差 / 抽水，**二者恒同在**。
 * 写者 = room-service 结算（`computeSettlement` 的 residue/rakeTotal 原样）；
 * 两值上限 2^31−1 = int 列容量哨兵（越界会落 MySQL 1264 ⇒ 伪 10007 重试链）。
 */
export interface CurrencyBurn {
  /** 截断残差（floor 分摊零头），`0 ≤ n ≤ 2^31−1`。 */
  residue: number;
  /** 抽水，`0 ≤ n ≤ 2^31−1`。 */
  rake: number;
}

export interface CurrencyApplyRequest {
  /** 幂等锚（非空、≤128；服务端不做格式白名单——形状约定见设计 §5.1）。 */
  actionId: string;
  source: string;
  entries: CurrencyEntryIn[];
  /** `admin_adjust` / `admin_reverse` 必填；≤64。 */
  actor?: string;
  /** `admin_adjust` / `admin_reverse` 必填；≤255（列宽）。 */
  reason?: string;
  /** 业务关联（② 对局 ID）；≤128。 */
  refId?: string;
  /** 仅 `game_settle` 可携带（结算销毁两列的来源）；「在场」谓词统一 = `!== undefined`。 */
  burn?: CurrencyBurn;
  meta?: RpcMeta;
}

export interface CurrencyApplyData {
  opId: number;
  actionId: string;
  /** 按 ownerId 升序（⚙️3 = 执行序 = 重建序）。 */
  entries: Array<{ ownerId: string; balanceAfter: number }>;
  replayed: boolean;
}

export type CurrencyApplyResponse = RpcResult<CurrencyApplyData>;

export interface CurrencyGetRequest {
  ownerIds: string[];
  meta?: RpcMeta;
}

export interface CurrencyGetData {
  balances: Array<{ ownerId: string; balance: number; exists: boolean }>;
}

export type CurrencyGetResponse = RpcResult<CurrencyGetData>;

/**
 * `currency.withdrawable.get`（支付片 T1 契约面，规格 §2.2 逐字；**仅类型**——运行期键
 * `RPC_PATTERNS.currencyWithdrawableGet` 归 `rpc.ts`，由 T4「键↔接收侧同提交」加入，J21 先例）。
 *
 * 语义（规格 §2.2.1，唯一实现点 = currency-service）：`cap = max(0, min(cap_raw, balance))`，
 * `cap_raw` 按 6 源集合（recharge/game_settle/refund_hold/refund_rollback/withdraw_hold/withdraw_rollback）
 * 求和；`cap ≤ balance` 由 `min` 结构恒成立。**消费纪律**：提现/退款两消费面在资金动作时刻
 * （锁内）调用，**禁缓存、禁只查一次**；RPC 取数失败 ⇒ fail-closed 拒（15003/15006）。
 *
 * ⚠️ 请求形状**逐字** `{ ownerId: string }`（规格如此，无 `meta?` 键）：发送侧经
 * `{ ownerId, ...metaFromTrace() }` 展开附加 meta（R1104 先例），类型面不加键。
 */
export interface CurrencyWithdrawableGetRequest {
  ownerId: string;
}

/** `currency.withdrawable.get` 的数据面（规格 §2.2 逐字；`balance` 与 `currency.get` 同源读）。 */
export interface CurrencyWithdrawableGetResponse {
  /** 已 clamp 的可离场额度（分池唯一实现点；`cap ≤ balance`）。 */
  cap: number;
  /** 当前余额（与 `currency.get` 同源读）。 */
  balance: number;
}

/** ownerId 的字符集与长度（§2.3 字段表；user.id(uuid) / 未来 robotId 都落在面内）。 */
const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,36}$/;
/** 单笔 delta 的绝对值上限（§2.3 缺省值：1,000,000；source 化例外见下）。 */
const MAX_ABS_DELTA = 1_000_000;

/**
 * **source 化上限**（② 金币场 §8 / C23）：缺省 = `MAX_ABS_DELTA`（1,000,000）；
 * `game_settle` / `robot_pool` 抬到 **2^31−1**（int 列容量）。
 *
 * 支付五源（§2.1）**不设专属上限**：走缺省 1e6（覆盖 500 元 = 50,000 币与 1,000 元/日口径）。
 *
 * ⚠️ **哨兵语义 = 抓算法 bug，不是经济参数**：现档位下单局真实上界 ≈3.15e8（余 ~6.8×）。
 * 为什么不是 1e12（对设计 §2 D3 的订正）：`balance`/`delta`/`balance_after`/`money_delta`
 * 列均为 int——`(2^31−1, 1e12]` 区间会「过协议校验但落库 1264 报错 ⇒ 伪 10007 ⇒ 重试/outbox」，
 * 与「哨兵 = 终态 10001」语义相悖；取 int 容量后 `>2^31−1` 在**校验层**即为 10001 终态。
 */
export const MAX_ABS_DELTA_BY_SOURCE: Partial<Record<CurrencySource, number>> = {
  game_settle: 2_147_483_647,
  robot_pool: 2_147_483_647,
};

/**
 * ownerType 归一化（§2.3）：**缺省（undefined）⇒ `'user'`**；`'user'`/`'robot'` 原样；
 * 其余（含 `null`、空串、陌生值）⇒ 抛 `ProtocolError`（中文原因——与 `parseConfigValue` 同口径）。
 */
export function normalizeOwnerType(v: unknown): CurrencyOwnerType {
  if (v === undefined) return 'user';
  if ((CURRENCY_OWNER_TYPES as readonly unknown[]).includes(v)) return v as CurrencyOwnerType;
  throw new ProtocolError(
    `ownerType 只允许 ${CURRENCY_OWNER_TYPES.join(' / ')}（缺省归一为 'user'；收到 ${JSON.stringify(v)}）`,
  );
}

/**
 * `currency.apply` 的**唯一校验点**（§2.3 字段表 + §5.4）：非法 ⇒ 抛 `ProtocolError`（中文原因）。
 *
 * 覆盖：actionId 非空 ≤128；source ∈ allowlist；entries 1..20 且 ownerId 不重复；
 * ownerId `[A-Za-z0-9_-]{1,36}`；delta 为 ≠0 整数且 |delta| ≤ cap
 * （cap 按 source 取：缺省 1,000,000；`game_settle`/`robot_pool` 为 2^31−1——§8）；
 * ownerType（若有）∈ allowlist；`admin_adjust` / `admin_reverse` ⇒ actor/reason 必填
 * （③ T1 两源**内核同规**；「1..200」是 admin 端点 body 预闸，内核不加——规格 S6）；
 * actor ≤64 / reason ≤255 / refId ≤128。
 * burn（本片，**若有**）⇒ 四条规则、次序即契约：形状 → 范围（0..2^31−1）→ 来源（仅 game_settle）
 * → 不变量（`Σentries + residue + rake === 0`）；缺席不校验（旧载荷兼容）。
 */
export function validateCurrencyApply(req: unknown): void {
  if (!isObj(req)) throw new ProtocolError('currency.apply 请求必须是对象');
  const { actionId, source, entries, actor, reason, refId, burn } = req;

  if (typeof actionId !== 'string' || actionId.length === 0 || actionId.length > 128) {
    throw new ProtocolError(`actionId 必须是 1..128 字符的非空字符串（收到 ${JSON.stringify(actionId)}）`);
  }
  if (typeof source !== 'string' || !(CURRENCY_SOURCES as readonly string[]).includes(source)) {
    throw new ProtocolError(`source 必须是 ${CURRENCY_SOURCES.join(' / ')} 之一（收到 ${JSON.stringify(source)}）`);
  }
  // source 已过 allowlist ⇒ 收窄安全（§8 逐字：缺省 1e6；消息里的上限显示 cap）
  const cap = MAX_ABS_DELTA_BY_SOURCE[source as CurrencySource] ?? MAX_ABS_DELTA;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 20) {
    throw new ProtocolError(
      `entries 必须是 1..20 条的数组（收到 ${Array.isArray(entries) ? String(entries.length) : JSON.stringify(entries)} 条）`,
    );
  }
  const seenOwnerIds = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry: unknown = entries[i];
    if (!isObj(entry)) throw new ProtocolError(`entries[${i}] 必须是对象`);
    const { ownerId, ownerType, delta } = entry;

    if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) {
      throw new ProtocolError(
        `entries[${i}].ownerId 必须是 1..36 字符的 [A-Za-z0-9_-] 字符串（收到 ${JSON.stringify(ownerId)}）`,
      );
    }
    if (seenOwnerIds.has(ownerId)) {
      throw new ProtocolError(`entries 的 ownerId 不得重复（重复：${ownerId}）`);
    }
    seenOwnerIds.add(ownerId);
    if (ownerType !== undefined) normalizeOwnerType(ownerType); // 非法 ⇒ 抛（原因由归一化函数给）
    if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > cap) {
      throw new ProtocolError(
        `entries[${i}].delta 必须是 ≠0 的整数且 |delta| ≤ ${cap}（收到 ${JSON.stringify(delta)}）`,
      );
    }
  }

  if (actor !== undefined && (typeof actor !== 'string' || actor.length > 64)) {
    throw new ProtocolError(`actor 必须是 ≤64 字符的字符串（收到 ${JSON.stringify(actor)}）`);
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 255)) {
    throw new ProtocolError(`reason 必须是 ≤255 字符的字符串（收到 ${JSON.stringify(reason)}）`);
  }
  if (refId !== undefined && (typeof refId !== 'string' || refId.length > 128)) {
    throw new ProtocolError(`refId 必须是 ≤128 字符的字符串（收到 ${JSON.stringify(refId)}）`);
  }
  if (source === 'admin_adjust' || source === 'admin_reverse') {
    // ③ T1（规格 §2.8/S6）：admin_reverse 与 admin_adjust **内核同规**——同一分支收口，
    // 消息里点名真实 source（防两处复制粘贴漂移；不得给任一源加 ≤200，那是端点 body 的事）。
    if (typeof actor !== 'string' || actor.length === 0) {
      throw new ProtocolError(`source=${source} 时 actor 必填（非空）`);
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new ProtocolError(`source=${source} 时 reason 必填（非空）`);
    }
  }

  // ── 结算销毁（本片；次序即契约：形状 → 范围 → 来源 → 不变量，前者先报）────────────
  if (burn !== undefined) {
    if (!isObj(burn) || !('residue' in burn) || !('rake' in burn)) {
      throw new ProtocolError('burn 必须是含 residue 与 rake 两个字段的对象');
    }
    const { residue, rake } = burn;
    if (typeof residue !== 'number' || !Number.isInteger(residue) || residue < 0 || residue > 2147483647) {
      throw new ProtocolError(`burn.residue 必须是 0 ≤ n ≤ 2147483647 的整数（收到 ${JSON.stringify(residue)}）`);
    }
    if (typeof rake !== 'number' || !Number.isInteger(rake) || rake < 0 || rake > 2147483647) {
      throw new ProtocolError(`burn.rake 必须是 0 ≤ n ≤ 2147483647 的整数（收到 ${JSON.stringify(rake)}）`);
    }
    if (source !== 'game_settle') {
      throw new ProtocolError(`burn 仅 game_settle 来源可携带（收到 ${JSON.stringify(source)}）`);
    }
    // entries 上方已逐条校验（对象 + delta 为整数）⇒ 收窄求和安全
    const entrySum = (entries as Array<{ delta: number }>).reduce((acc, entry) => acc + entry.delta, 0);
    if (entrySum + residue + rake !== 0) {
      throw new ProtocolError(
        `burn 与分录金额不符：Σentries(${entrySum}) + residue(${residue}) + rake(${rake}) 必须为 0`,
      );
    }
  }
}

/**
 * `currency.get` 的**唯一校验点**（§2.4）：ownerIds 1..50 条、逐条同 §2.3 的 ownerId 约束；
 * **允许重复**（响应与请求同序一一对应）。非法 ⇒ 抛 `ProtocolError`（中文原因）。
 */
export function validateCurrencyGet(req: unknown): void {
  if (!isObj(req)) throw new ProtocolError('currency.get 请求必须是对象');
  const { ownerIds } = req;
  if (!Array.isArray(ownerIds) || ownerIds.length < 1 || ownerIds.length > 50) {
    throw new ProtocolError(
      `ownerIds 必须是 1..50 条的数组（收到 ${Array.isArray(ownerIds) ? String(ownerIds.length) : JSON.stringify(ownerIds)} 条）`,
    );
  }
  for (let i = 0; i < ownerIds.length; i++) {
    const ownerId: unknown = ownerIds[i];
    if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) {
      throw new ProtocolError(
        `ownerIds[${i}] 必须是 1..36 字符的 [A-Za-z0-9_-] 字符串（收到 ${JSON.stringify(ownerId)}）`,
      );
    }
  }
}

/** 台费免单 reason 三值（本片规格 §2.4a 逐字；有界标签域 —— **绝不含 action_conflict**）。 */
export const ENTRY_FEE_SKIP_REASONS = ['insufficient_funds', 'unknown_outcome', 'internal_error'] as const;
export type EntryFeeSkipReason = (typeof ENTRY_FEE_SKIP_REASONS)[number];

/**
 * `currency.entryFeeSkip`（本片）：台费免单**逐笔记账**（写边；`RpcResult` 信封）。
 * 幂等写 = `INSERT IGNORE` + `(room_code, owner_id)` 唯一键（**并采、双源防重**：调用侧
 * 「单次不重试」防调用内重发；唯一键防同房二开跨调用）；应答数据 = `{inserted: boolean}`
 * （本次是否新落行 —— 记账判别三步的判别面）。
 */
export interface CurrencyEntryFeeSkipRequest {
  /** 1..16（真形态 = 恰 6 位 `[0-9A-Z]`；校验照 `record.moneyDelta` 前例、列宽照 `game_records.room_code`）。 */
  roomCode: string;
  /** `[A-Za-z0-9_-]{1,36}`（同 entries.ownerId）。 */
  ownerId: string;
  /** 可选：座位 0..2（房 maxPlayers=3）。 */
  seat?: number;
  /** 房底分（正整数 ≤ 8191——与档位表容量上界同域，规格 §2.4c 逐字；评审 r1 F-T1-1 处置）。 */
  baseScore: number;
  /** 单笔台费（正整数 ≤ 1,000,000；公式上界 8191，此界为域哨兵）。 */
  feeAmount: number;
  reason: EntryFeeSkipReason;
  meta?: RpcMeta;
}

/** `currency.entryFeeSkip` 应答数据（r2-delta-F1）：本次是否新落行。 */
export interface CurrencyEntryFeeSkipData {
  inserted: boolean;
}

export type CurrencyEntryFeeSkipResponse = RpcResult<CurrencyEntryFeeSkipData>;

/** 记牌器收费片：`currency.cardCounterConsume`（room → currency；写边、幂等按 room+owner）。 */
export interface CurrencyCardCounterConsumeRequest {
  /** 1..16（真形态 = 恰 6 位 `[0-9A-Z]`；列宽同 game_records.room_code）。 */
  roomCode: string;
  /** `[A-Za-z0-9_-]{1,36}`。 */
  ownerId: string;
  /** 可选：座位 0..2。 */
  seat?: number;
  meta?: RpcMeta;
}

/** `currency.cardCounterConsume` 应答数据：本局是否开通、来源、包时到期（epoch ms）。 */
export interface CurrencyCardCounterConsumeData {
  active: boolean;
  source: 'pass' | 'credit' | 'none';
  expiresAt: number | null;
}

export type CurrencyCardCounterConsumeResponse = RpcResult<CurrencyCardCounterConsumeData>;

/** `currency.cardCounterConsume` 的唯一校验点：非法 ⇒ 抛 `ProtocolError`（中文原因）。 */
export function validateCurrencyCardCounterConsume(req: unknown): void {
  if (!isObj(req)) throw new ProtocolError('currency.cardCounterConsume 请求必须是对象');
  const { roomCode, ownerId, seat } = req;
  if (typeof roomCode !== 'string' || roomCode.length === 0 || roomCode.length > 16) {
    throw new ProtocolError(`roomCode 必须是 1..16 字符的非空字符串（收到 ${JSON.stringify(roomCode)}）`);
  }
  if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) {
    throw new ProtocolError(`ownerId 必须是 1..36 字符的 [A-Za-z0-9_-] 字符串（收到 ${JSON.stringify(ownerId)}）`);
  }
  if (seat !== undefined && (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat > 2)) {
    throw new ProtocolError(`seat 必须是 0..2 的整数（收到 ${JSON.stringify(seat)}）`);
  }
}

/**
 * `currency.entryFeeSkip` 的**唯一校验点**（本片 C19）：非法 ⇒ 抛 `ProtocolError`（中文原因）。
 * 服务层入参取 `unknown` 过门（照 `apply.service.ts` 的 207-229 形态）。
 */
export function validateCurrencyEntryFeeSkip(req: unknown): void {
  if (!isObj(req)) throw new ProtocolError('currency.entryFeeSkip 请求必须是对象');
  const { roomCode, ownerId, seat, baseScore, feeAmount, reason } = req;

  if (typeof roomCode !== 'string' || roomCode.length === 0 || roomCode.length > 16) {
    throw new ProtocolError(`roomCode 必须是 1..16 字符的非空字符串（收到 ${JSON.stringify(roomCode)}）`);
  }
  if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) {
    throw new ProtocolError(`ownerId 必须是 1..36 字符的 [A-Za-z0-9_-] 字符串（收到 ${JSON.stringify(ownerId)}）`);
  }
  if (seat !== undefined && (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat > 2)) {
    throw new ProtocolError(`seat 必须是 0..2 的整数（收到 ${JSON.stringify(seat)}）`);
  }
  if (typeof baseScore !== 'number' || !Number.isInteger(baseScore) || baseScore <= 0 || baseScore > 8191) {
    throw new ProtocolError(`baseScore 必须是正整数且 ≤ 8191（收到 ${JSON.stringify(baseScore)}）`);
  }
  if (typeof feeAmount !== 'number' || !Number.isInteger(feeAmount) || feeAmount <= 0 || feeAmount > 1_000_000) {
    throw new ProtocolError(`feeAmount 必须是正整数且 ≤ 1000000（收到 ${JSON.stringify(feeAmount)}）`);
  }
  if (typeof reason !== 'string' || !(ENTRY_FEE_SKIP_REASONS as readonly string[]).includes(reason)) {
    throw new ProtocolError(
      `reason 必须是 ${ENTRY_FEE_SKIP_REASONS.join(' / ')} 之一（收到 ${JSON.stringify(reason)}）`,
    );
  }
}

/**
 * `request_hash`（§2.3 ⚙️2，逐字节钉死）：`sha256(JSON.stringify(规范化对象))`，小写 hex 定长 64。
 *
 * 规范化对象**键序固定**：`{ source, entries, actor, reason, refId }`（本片：`burn` 仅**在场**时
 * 于**末位**追加 `{residue, rake}`；缺席省略 ⇒ 旧载荷 canonical 逐字节不变）；
 * `entries` 按 **ownerId 升序**，每条 `{ ownerId, ownerType, delta }`——`ownerType` 取**归一化值**、
 * **永不省略**；`actor/reason/refId` 以 `?? null` 出现。**actionId 不参与**（幂等锚在 `uk_action_id`，
 * 指纹只认载荷）。
 */
export function currencyApplyHash(input: {
  source: string;
  entries: CurrencyEntryIn[];
  actor?: string;
  reason?: string;
  refId?: string;
  burn?: CurrencyBurn;
}): string {
  const entries = [...input.entries]
    .sort((a, b) => (a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0))
    .map((e) => ({ ownerId: e.ownerId, ownerType: normalizeOwnerType(e.ownerType), delta: e.delta }));
  const canonical = JSON.stringify({
    source: input.source,
    entries,
    actor: input.actor ?? null,
    reason: input.reason ?? null,
    refId: input.refId ?? null,
    // 本片 D4「有才出现」：burn 缺席 ⇒ undefined ⇒ JSON.stringify 省略该键 ⇒ canonical 串
    // 与加片前逐字节相同（历史指纹兼容的判据；金标向量一字不改仍绿）。
    ...(input.burn !== undefined ? { burn: { residue: input.burn.residue, rake: input.burn.rake } } : {}),
  });
  return sha256HexUtf8(canonical);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ------------------------------------------------------------------ *
 * sha256（纯 TS，零依赖；见文件头「不得静态引入 node 内建」的理由）
 *
 * 语义与 `node:crypto` / WHATWG TextEncoder 完全一致：
 * UTF-8 编码（孤立代理 ⇒ U+FFFD），输出小写 hex 定长 64。
 * `currency.test.ts` 对长度 0..140 的输入扫填充边界（55/56/63/64/65/119/120）做交叉复算。
 * ------------------------------------------------------------------ */

/** SHA-256 轮常量（FIPS 180-4）。 */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

/** 循环右移（32 位无符号）。 */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** WHATWG UTF-8 编码（与 TextEncoder 同语义：孤立代理 ⇒ U+FFFD）。 */
function utf8Bytes(input: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let cp = input.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = (cp - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000; // 代理对 ⇒ 补充平面码点
        i += 1;
      } else {
        cp = 0xfffd; // 孤立高位代理
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd; // 孤立低位代理
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

function sha256HexUtf8(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64; // 0x80 + 8 字节长度域，补齐到 64 的倍数
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x1_0000_0000), false); // 长度域 = 64 位大端
  dv.setUint32(total - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');
}

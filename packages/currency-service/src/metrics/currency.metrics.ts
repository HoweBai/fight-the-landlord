import { createCounter, createGauge } from '@fight-the-landlord/shared';

/**
 * currency-service 的指标定义（货币片规格 §2.12 表的七条 + ② 金币场 §11.1 三条）。
 *
 * ⚠️ **本文件只定义、不写入**：写点在 `apply.service.ts`（T3 三条）·
 * `reconcile.service.ts`（T8 的其余四条 + ② 的两个 gauge）· `wallet.controller.ts`
 * （② 的 `currency_relief_total` —— 已在此扩展）。全部经 shared 的
 * `createCounter/createGauge` 构造器（监控片 §2.3 的 registry 同一性纪律 ——
 * 不许直连 prom-client）。
 *
 * ⚠️ **显式 `ReturnType<typeof createCounter>` 注记不是风格偏好**：本包不直接依赖
 * prom-client（类型无法在声明里命名）⇒ 不加注记时 `tsc` 报 TS2742（declaration emit
 * 要求类型可命名）。先例：user-service 的 `records.metrics.ts`。
 */

/** `currency_apply_total` 的 result 值域（§2.12 表逐字；三个桶互斥）。 */
export type CurrencyApplyResult = 'ok' | 'replay' | 'reject';

/**
 * source 标签的**校验失败哨兵**：请求在「source ∈ allowlist」成立**之前**就被拒时，
 * 无法用真实 source 打标签 —— 直接用请求里的原串会让标签基数无界（§2.12 明确
 * `source`（allowlist 值域）就是防这个）。哨兵是 allowlist 之外的唯一固定值。
 */
export const CURRENCY_SOURCE_INVALID = 'invalid';

/**
 * `currency.apply` 调用次数（每次调用 +1——含重放与拒绝；§2.12 表逐字）。
 *
 * 标签：`source`（allowlist 值域，校验失败 ⇒ `invalid` 哨兵）·
 * `result ∈ {ok, replay, reject}`（reject 涵盖 10001 校验/ownerType 异型与 14001/14002）。
 */
export const currencyApplyTotal: ReturnType<typeof createCounter> = createCounter(
  'currency_apply_total',
  'currency.apply 调用次数（含重放与拒绝；reject 涵盖校验 10001 / 余额不足 14001 / 冲突 14002）。',
  ['source', 'result'],
);

/**
 * 仅**写成功**（`replayed:false`）批按 entries 条数累加（§2.12 表逐字）。
 * 重放与拒绝**不**累加（它们没有「写」发生）—— 无标签（值域天然唯一）。
 */
export const currencyApplyEntriesTotal: ReturnType<typeof createCounter> = createCounter(
  'currency_apply_entries_total',
  '写成功（replayed:false）的 currency.apply 批按 entries 条数累加；重放/拒绝不累加。',
);

/**
 * 🔴 **两处同一计数器**（§2.12 表末行 + §2.11）：对账检查 2 的漂移删除（T8）
 * 与 apply 写穿失败（T3，`cache_write_failed` 路径）。
 *
 * ⚠️ T3 提前定义它的原因：写穿失败路径**先落地**（apply 提交后逐条 SET）——
 * 不定义则 §2.11 写死的「失败 ⇒ counter inc」无处可写；T8 只需补其余四条。
 */
export const currencyReconcileCacheDriftTotal: ReturnType<typeof createCounter> = createCounter(
  'currency_reconcile_cache_drift_total',
  '缓存漂移处理次数（对账删除 + apply 写穿失败，两处同一计数器）。',
);

/**
 * T8（§2.12 表逐字）：对账轮次计数 —— 每轮**开始** +1（含查询抛错的失败轮；
 * 与 `currency_reconcile_last_success_timestamp_seconds` 成对读：
 * runs 在涨而 last_success 不涨 = 轮轮失败）。
 */
export const currencyReconcileRunsTotal: ReturnType<typeof createCounter> = createCounter(
  'currency_reconcile_runs_total',
  '对账循环轮次计数（每轮开始 +1；失败轮也计）。',
);

/**
 * T8（§2.12 表逐字）：**启动置 0**（「从未成功」语义 —— 首启 / 一直失败都要能被
 * 告警规则命中）；一轮三检查**无异常执行完** set = epoch 秒。
 * ⚠️ 漂移是「检查结果」**不算失败**（照 set）；查询抛错 ⇒ **不 set**。
 */
export const currencyReconcileLastSuccessTimestampSeconds: ReturnType<typeof createGauge> = createGauge(
  'currency_reconcile_last_success_timestamp_seconds',
  '最近一次三检查无异常执行完的 epoch 秒；启动置 0（「从未成功」）。',
);

/** T8（§2.12 表逐字）：每轮 set = 账实不符账户数（0 = 健康；**只报不改**）。 */
export const currencyReconcileDriftAccounts: ReturnType<typeof createGauge> = createGauge(
  'currency_reconcile_drift_accounts',
  '最近一轮账实不符（currency_accounts.balance ≠ SUM(currency_flows.delta)）的账户数（0 = 健康）。',
);

/** T8（§2.12 表逐字）：每轮 set = 孤儿赠送账户数（COUNT DISTINCT）。 */
export const currencyOrphanSignupGrants: ReturnType<typeof createGauge> = createGauge(
  'currency_orphan_signup_grants',
  '最近一轮孤儿赠送账户数（source=signup_grant 且 users 行不存在的去重 ownerId 数）。',
);

/* ================================================================== *
 * ② 金币场（T8；规格 §11.1 三条，名字**逐字**）
 * ================================================================== */

/**
 * T8（§11.1 逐字）：机器人虚拟池余额（`owner_id='robot-pool'`）——对账循环**每轮刷新**
 * （写点在 `reconcile.service.ts` 轮末）。告警规则 `CurrencyRobotPoolLow`
 * （`< 1000000` 持续 10m）消费它；账户未种子 ⇒ **0**（不是「缺指标」——规则要能命中
 * 「池根本没建」这种形态）。
 */
export const currencyRobotPoolBalance: ReturnType<typeof createGauge> = createGauge(
  'currency_robot_pool_balance',
  "机器人虚拟池（owner_id='robot-pool'）余额；对账循环每轮刷新（未种子 ⇒ 0）。",
);

/**
 * T8（§11.1 逐字）：机器人账户余额总和（`owner_type='robot'` 且 `owner_id LIKE 'bot-%'`，
 * **不含池本身**）——对账循环每轮刷新。僵尸余额的观测面（§7：不补、不删）。
 */
export const currencyRobotAccountsBalanceSum: ReturnType<typeof createGauge> = createGauge(
  'currency_robot_accounts_balance_sum',
  "机器人账户（owner_type='robot' 且 owner_id LIKE 'bot-%'，不含池）余额总和；对账循环每轮刷新。",
);

/** `currency_relief_total` 的 result 值域（§11.1 逐字；三桶互斥）。 */
export type CurrencyReliefResult = 'granted' | 'replayed' | 'rejected';

/**
 * T8（§11.1 逐字）：救助端点处置计数。
 *  - `granted`：首次发放成功；
 *  - `replayed`：同日重领（apply 重放，**含 14002 翻码**——对外都是「已领过」）；
 *  - `rejected`：14004 两种拒绝（开关关「救助暂未开放」/ 余额充足「余额充足，无需救助」）。
 *  ⚠️ 配置不可用的 503/10007 **不进桶**（那是可用性故障，不是「拒绝发放」）。
 */
export const currencyReliefTotal: ReturnType<typeof createCounter> = createCounter(
  'currency_relief_total',
  '救助端点处置计数（granted=首次发放 / replayed=同日重领含 14002 翻码 / rejected=14004 两种拒绝）。',
  ['result'],
);

/* ================================================================== *
 * 广告小片 T11（规格 §2.7 逐字）
 * ================================================================== */

/** `relief_callback_total` 的 result 值域（§2.7 逐字；五桶互斥——一回调恰入一桶）。 */
export type ReliefCallbackResult = 'accepted' | 'claim_invalid' | 'bad_sign' | 'malformed' | 'error';

/**
 * T11（§2.7 逐字）：**回调面**处置计数——一回调一计（每次回调恰入一桶）：
 *  - `accepted`：发放 granted / 重放（账本先行或 apply）/ 正向裁决拒绝 / done 短路；
 *  - `claim_invalid`：claim 不存在/过期/畸形（不建键，只计回调面）；
 *  - `bad_sign` / `malformed`：验签不过 / 载荷畸形（4xx 侧，平台不重试）；
 *  - `error`：瞬态（含 claim 读取故障；5xx 可重投）。
 * ⚠️ 与 `currency_relief_total`（发放面）**不同源不同值域**（后者本体零改动）。本任务
 *    只落定义；**写点在 T14**（回调业务链终态处就近分桶）。告警 `ReliefCallbackBroken`
 *    （bad_sign|error）与 `ReliefGrantZero` 消费本指标。
 */
export const reliefCallbackTotal: ReturnType<typeof createCounter> = createCounter(
  'relief_callback_total',
  '广告回调处置计数（accepted/claim_invalid/bad_sign/malformed/error 五桶互斥，一回调恰入一桶；写点 T14）。',
  ['result'],
);

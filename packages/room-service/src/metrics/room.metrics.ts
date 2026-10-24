// packages/room-service/src/metrics/room.metrics.ts
import { createCounter, createGauge } from '@fight-the-landlord/shared';

/**
 * ⚠️ **显式注解**（不是从推断来）：`createGauge/createCounter` 的返回类型在 .d.ts 里若走
 * 推断，会引用 `shared/node_modules/prom-client` 的**非便携路径**（TS2742 —— 而
 * `prom-client` **不是** room-service 的依赖，不能直接 import 它的类型）。
 * `ReturnType<typeof …>` 的注解既保住完整类型（prom-client 的方法面都在），又只引用
 * 本包可见的符号 ⇒ 声明产物便携。
 */
type GaugeOf = ReturnType<typeof createGauge>;
type CounterOf = ReturnType<typeof createCounter>;

/**
 * room-service 的业务指标**定义**（监控片 · 规格 §2.2 终表）。
 *
 * 🔴 **模块级导出常量** —— 三个写点各在别的文件里直接 import，不走 Nest DI：
 *  - `ws_connections` / `games_ended_total` ⇒ `gateway/ws.gateway.ts`（WsModule）；
 *  - `games_started_total` ⇒ `rooms/rooms.start.ts`（StartModule）；
 *  - `rooms_active` ⇒ `metrics/room-metrics.service.ts`（注册进 WsModule）；
 *  - `match_queue_length` ⇒ `match/match.service.ts`（挂既有扫描环，O4）。
 *
 * ⚠️ 为什么不做成一个可注入的 MetricsService：写点横跨三个模块（Ws/Start/Match），
 * 注入它会让每个模块都多一条依赖边（`rooms.start.ts` 头上那条 CJS 环的教训同族）；
 * 指标**天然是进程级单例**（shared 的 `createGauge/createCounter` 强制注册进唯一 registry），
 * 直接 import 常量与注入的语义等价而无装配风险（`ws.module.wiring.test.ts` 挡不住的那类）。
 */

/**
 * WS 活跃连接数（规格 §2.2）。
 *
 * 语义 = `WsGateway.activeConnections.size`：**按 `userId` 去重**的一条逻辑连接。
 * inc 点在**鉴权通过 + 注册完成之后**（拒握手不计入）；硬换手（新连接顶掉从未观测到
 * 断开的旧连接）**不**再加一、其后的陈旧断线也**不**减 —— 一对加减恰一次。
 */
export const wsConnections: GaugeOf = createGauge(
  'ws_connections',
  'room-service 当前活跃的 WS 连接数（按 userId 计；同一用户的硬换手连接替换不重复计数）。',
);

/** 开局计数（规格 §2.2）：`RoomStartService` 的「确实开起来了」点 —— `game.start` 成功且房间已写 `playing`。 */
export const gamesStartedTotal: CounterOf = createCounter(
  'games_started_total',
  '已开局的对局数（room-service 开局成功点计数；game.start 失败的假开局不计入）。',
);

/** 结算计数（规格 §2.2）：`WsGateway.onGameEvent` 的 `game.ended` 处理点，每条事件恰一次。 */
export const gamesEndedTotal: CounterOf = createCounter(
  'games_ended_total',
  '已结束的对局数（room-service 收到 game.ended 事件计数）。',
);

/**
 * 活跃房间数（规格 §2.2）。
 *
 * **全栈口径（Y5）**：Redis `SCAN room:*` 聚合（派生键除外）—— 键空间对所有实例
 * 可见 ⇒ 现部署（单实例）下与全局等价；多实例时它仍报全栈值（与 `games_active`
 * 的 per-instance 语义刻意不同）。
 */
export const roomsActive: GaugeOf = createGauge(
  'rooms_active',
  '活跃房间数（全栈口径：Redis SCAN 聚合 room:* 非派生键；单实例部署下与全局等价）。',
);

/**
 * 匹配队列长度（规格 §2.2）。
 *
 * 挂 `match.service.ts` 的**既有扫描环**（周期 = config `room.matchScanIntervalMs`，
 * 种子 5s；ZCARD 为本片新增读命令）——**没有**新计时器。
 * 🔴 **region 维求和**：同一 `(mode, baseScore)` 在多个 region 上的队列长度在本指标上
 * **相加**（现部署只有 `global` 一个 region，求和是给地理扩展留的口径）。
 */
export const matchQueueLength: GaugeOf = createGauge(
  'match_queue_length',
  '匹配队列长度（按 mode/game_type/player_count/base_score；同一档位在多个 region 上的队列长度求和——现部署只有 global 一个 region）。',
  ['mode', 'game_type', 'player_count', 'base_score'],
);

// ─── 风控片 T2（规格 §2.12 room 行；写点全在 match.service.ts 的选择链内）────────

/**
 * 谓词拒绝计数（风控规格 §2.12）。
 *
 * 口径（§2.4-5 写点）：**随机抽取**时每一对**被谓词拒绝**的候选计一次——
 * 按谓词分桶（双谓词同时拒绝同一对 ⇒ 两条各 +1）；**记忆拒绝不计**（不是谓词拒绝）。
 * 告警 `MatchPredicateRejectionHigh` 的分子。
 */
export const matchPredicateRejectionsTotal: CounterOf = createCounter(
  'match_predicate_rejections_total',
  '匹配谓词拒绝计数（随机抽取中每对谓词拒绝计一次，按 predicate 分；记忆拒绝不计）。',
  ['predicate'],
);

/**
 * 抽选轮次计数（风控规格 §2.12）：**每轮每个「≥3 真人」的队列桶**计一次
 *（未到 3 人的窗口/补位路径不属于「抽选」，不计）。告警的分母（拒绝率 = 拒绝/轮次）。
 */
export const matchSelectionRoundsTotal: CounterOf = createCounter(
  'match_selection_rounds_total',
  '匹配随机抽选的轮次计数（每轮每个 ≥3 真人的队列桶计一次；谓词拒绝率告警的分母）。',
);

/**
 * 「≥3 人但抽不出合法组」计数（风控规格 §2.12 · §2.4-5 的**可观测定义**）：
 * ≥3 人且本轮随机贪心未凑出 3 人组 ⇒ +1（**不做组合搜索判定** —— 贪心失败即计，
 * 即便随后的「最大合法子集」路径救回了成局）。
 */
export const matchNoLegalGroupTotal: CounterOf = createCounter(
  'match_no_legal_group_total',
  '≥3 人但本轮随机贪心未凑出合法三人组的桶次计数（可观测定义：不做组合搜索）。',
);

// ─── ② 金币场 T5（规格 §11.1 逐字；偏差登记：结果标签按处置分流）──────────────
//
// 六个指标名以规格 §11.1 为准（对设计 D11 的细化：`result` 标签 = `ok|replayed|
// retried|r2|outboxed|dropped`，比设计的 `insufficient|timeout|conflict|invalid`
// 更贴运维口径）。写点全在 `currency/settle.service.ts` 与 `currency/settle.sweeper.ts`；
// `currency_robot_topup_total` / `currency_robot_ensure_failed_total` 的**写点**在 T6
//（机器人资金面）——本任务只把名称与骨架挂上（§11.1 的分工），避免 T6 再定义一次
//（同名二次注册会让进程启动即崩）。

/**
 * 结算处置计数（规格 §11.1）。
 *
 * 语义（**每个结算事件**在 `result` 维度上的落地）：
 *  - `ok` / `replayed`：apply 成功（含 outbox 重发成功、r2 轮成功）——**终态**；
 *  - `retried`：每发出一次退避重发（读边或写边，300ms/1s 阶梯）；
 *  - `r2`：进入 14001 的重算轮（`actionId :r2`）；
 *  - `outboxed`：结算载荷存入 `settle:outbox`（终态前的中转）；
 *  - `dropped`：终态且未动钱（守卫不齐 / 10001 / 14002 / 余额读最终失败 / outbox 超龄放弃）。
 * 因此一次结算可能贡献多条（如 `retried` + `ok`）；「结算了多少局」看 `ok|replayed`。
 */
export const currencySettleResultTotal: CounterOf = createCounter(
  'currency_settle_result_total',
  '金币场结算处置计数（ok|replayed|retried|r2|outboxed|dropped；终态看 ok|replayed）。',
  ['result'],
);

/**
 * 截断残差销毁额（规格 §4：`residue = P − Σg[i] ∈ [0, 赢家数)`，销毁不挪用）。
 * **零和局也 inc 0**（保证任何一局金币局之后该序列必然出现——H 组判据据此核对）。
 */
export const currencySettleResidueTotal: CounterOf = createCounter(
  'currency_settle_residue_total',
  '金币场结算的截断残差销毁总额（floor 分摊余数；无截断时为 0）。',
);

/**
 * 补偿队列条目数（规格 §11.1）。
 *
 * **口径 = 两箱之和**（`settle:outbox` + `recordmoney:outbox`）—— 它们共同构成
 * 「钱/账面没走完」的补偿队列，告警（`CurrencySettleOutboxStuck`）盯的是同一个面。
 * 由 sweeper 每轮（10s）刷新。
 */
export const currencySettleOutboxSize: GaugeOf = createGauge(
  'currency_settle_outbox_size',
  '金币场结算补偿队列条目数（settle:outbox + recordmoney:outbox 之和；sweeper 每轮刷新）。',
);

/**
 * 补偿队列**最老条目**的年龄（秒）（规格 §11.1 / §5）。
 * 告警阈值 = **> 300s**（`CurrencySettleOutboxStuck`）；TTL=1h 只做清理、不做告警。
 * 空队列 ⇒ 0。由 sweeper 每轮刷新。
 */
export const currencySettleOutboxOldestSeconds: GaugeOf = createGauge(
  'currency_settle_outbox_oldest_seconds',
  '金币场结算补偿队列最老条目的年龄（秒；空队列为 0；告警阈值 >300s）。',
);

/**
 * 机器人资金动作计数（规格 §11.1 逐字；**写点在 T6**，本任务只挂名称与骨架）：
 * `action ∈ refill|recall` —— 结算后/ensure 的补款与回收各计一次。
 */
export const currencyRobotTopupTotal: CounterOf = createCounter(
  'currency_robot_topup_total',
  '机器人虚拟币补款/回收动作计数（action=refill|recall；写点 T6）。',
  ['action'],
);

/**
 * 机器人 ensure 失败计数（规格 §11.1 逐字；**写点在 T6**，本任务只挂名称与骨架）。
 */
export const currencyRobotEnsureFailedTotal: CounterOf = createCounter(
  'currency_robot_ensure_failed_total',
  '机器人 ensure（补给观测 → 注资）失败计数（写点 T6；失败走既有补位失败路径）。',
);

// ─── 台费片（规格 §2.4a 逐字；写点全在 rooms.start.ts 的收费块）────────────

/**
 * 台费免单计数（本片）：有界标签 **×3**（`insufficient_funds` | `unknown_outcome` | `internal_error`）。
 * **绝不含 conflict** —— 冲突不是漏收（14002 ⟺ 已收），装进标签域会让「台费收/漏」面板
 * 出现系统性假漏收回潮（r2-delta-F2）。
 * 判别三步（r2-delta-F1）：`inserted=true` / RPC 失败 ⇒ inc；`inserted=false`（同房二开重复）⇒ 不计。
 */
export const entryFeeSkippedTotal: CounterOf = createCounter(
  'entry_fee_skipped_total',
  '台费免单计数（按 reason：insufficient_funds|unknown_outcome|internal_error；同房重复免单不重复计）。',
  ['reason'],
);

/** 台费 14002 冲突计数（本片；无标签）：同锚已有成功提交（视为已收）——不记 skips、不计漏收。 */
export const entryFeeConflictTotal: CounterOf = createCounter(
  'entry_fee_conflict_total',
  '台费 op 冲突计数（14002：同锚已有成功提交，台费已收——不是漏收）。',
);

// ─── 记牌器收费片（写点 = rooms.start.ts 状态块）────────────────────────────

/**
 * 记牌器开局消费计数（本片；有界标签 source = pass|credit|none|unknown）。
 * `none` = 无权益（也计，衡量「未开通局次」）；`unknown` = 消费 RPC 未知态（fail-open）。
 */
export const cardCounterConsumedTotal: CounterOf = createCounter(
  'card_counter_consumed_total',
  '记牌器开局消费计数（按 source：pass|credit|none|unknown）。',
  ['source'],
);

/** 记牌器消费 RPC 失败/未知态计数（无标签；与 consumed 的 unknown 桶互为对照）。 */
export const cardCounterConsumeErrorTotal: CounterOf = createCounter(
  'card_counter_consume_error_total',
  '记牌器消费 RPC 失败/未知态计数（fail-open：本局仍开通）。',
);

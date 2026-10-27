// packages/robot-service/src/robot/robot.metrics.ts
import { createCounter } from '@fight-the-landlord/shared';

/**
 * robot-service 的**决策面**指标（监控片规格 §2.2 的 robot 两行；设计 Y4）。
 *
 * 两个 counter 都经 shared 的 `createCounter` 构造（规格 §2.3 的 registry 同一性纪律——
 * 不许直连 prom-client），随 `/metrics` 独立指标端口（9100 系以外的 9005）暴露。
 *
 * ⚠️ **显式 `ReturnType<typeof createCounter>` 注记不是风格偏好**：本包不直接依赖
 * prom-client（类型无法在声明里命名）⇒ 不加注记时 `tsc` 报 TS2742（declaration emit
 * 要求类型可命名）。注记让声明按字面写入（`ReturnType<typeof createCounter>`），
 * 不跨包引用 prom-client 的路径。后续以 shared 构造器定义指标的包同理。
 *
 * ⚠️ **标签值域全部有界**（基数 = 长期存储成本；本仓纪律）：
 *  - `robot_decisions_total{result,skill}`：`result ∈ {douzero,rule}`（= 协议
 *    `RobotDecideResponse.source`，即设计的 `result` 名）、`skill ∈ SKILL_LEVELS`（恰 3 值）；
 *  - `robot_decision_errors_total{reason}`：`reason` ⊆ `ROBOT_DECISION_ERROR_REASONS`（见下）。
 */

/** `robot_decisions_total{result}` 的值域（= 决策**来源**，协议 `source` 字段逐字）。 */
export const ROBOT_DECISION_RESULTS = ['douzero', 'rule'] as const;
export type RobotDecisionResult = (typeof ROBOT_DECISION_RESULTS)[number];

/**
 * `robot_decision_errors_total{reason}` 的值域（**有界**；`bot.player.ts` 的两条失败路径写它）：
 *
 *  - `douzero_timeout`       —— 调用被超时/中止（`DouZeroClient` 的 5s `AbortSignal.timeout`
 *    ⇒ `TimeoutError`；`AbortError` 同档）；
 *  - `douzero_http_error`    —— 非 2xx（client 抛 `DouZero HTTP <status>: …`）；
 *  - `douzero_bad_response`  —— 2xx 但应答解析失败（`response.json()` 的 `SyntaxError`）；
 *  - `douzero_unreachable`   —— 连接层失败（拒连 / DNS / `fetch failed` 族）；
 *  - `douzero_invalid_cards` —— 调用**成功**但返回了不在手里的牌（`isPlausible` 拒绝，
 *    同样回落规则引擎 —— 它是一次失败的**决策**，与「牌权」无关）。
 *
 * 五档都指向同一件事：DouZero 没能给出可用决策、本次决策回落了规则引擎。
 * 分类函数 = `classifyDouZeroFailure()`（只此一处，别在别处再写第二份判定）。
 */
export const ROBOT_DECISION_ERROR_REASONS = [
  'douzero_timeout',
  'douzero_http_error',
  'douzero_bad_response',
  'douzero_unreachable',
  'douzero_invalid_cards',
] as const;
export type RobotDecisionErrorReason = (typeof ROBOT_DECISION_ERROR_REASONS)[number];

/**
 * 决策**收口**计数（写点在 `RobotService.decide` —— 每次决策恰一次）。
 *
 * ⚠️ **叫抢期恒为 `result="rule"`**（协议：DouZero 没有叫抢模型，`bot.player.ts` 对
 * `state === 'bidding'` 直接返回 `{kind:'pass',source:'rule'}`）⇒ 它**不是失败信号**，
 * 面板/告警不得把 `result="rule"` 读成 DouZero 出问题；「机器人失败」读下行
 * `robot_decision_errors_total`（设计 Y4）。
 *
 * `skill` 取请求的 `skillLevel` —— 来源 = 入座时 `RobotPool` 抽档写进 `BotInstance` 的
 * 难度（随 `robot.decide` 请求下发），本服务内没有第二个更权威的读点。
 */
export const robotDecisionsTotal: ReturnType<typeof createCounter> = createCounter(
  'robot_decisions_total',
  '机器人**完成**的决策次数（result=决策来源 douzero|rule · skill=难度档 · game_type）。DouZero 错误率 = errors/decisions；PDK 规则 bot 错误率 = errors/(decisions+errors)。',
  ['result', 'skill', 'game_type'],
);

/** DouZero 未能给出可用决策（回落规则引擎）的次数；`reason` 值域见 `ROBOT_DECISION_ERROR_REASONS`。 */
export const robotDecisionErrorsTotal: ReturnType<typeof createCounter> = createCounter(
  'robot_decision_errors_total',
  'DouZero 未能给出可用决策的次数（按 reason/玩法；随后回落规则引擎并仍完成决策）。',
  ['reason', 'game_type'],
);

/** A1：PDK 规则 bot 抛错（不进 decisions ⇒ 错误率 = errors/(decisions+errors)）。 */
export const robotRuleErrorsTotal: ReturnType<typeof createCounter> = createCounter(
  'robot_rule_errors_total',
  'PDK 规则 bot 决策抛错次数（reason=decision_error，按玩法；抛错不进 decisions）。',
  ['game_type', 'reason'],
);

/**
 * 把 DouZero 调用抛出的错误分进有界的 `reason` 值域（`bot.player.ts` 的回落 catch 里调）。
 *
 * 判别依据来自 `DouZeroClient` 的**既有抛出形态**（同一仓库内两处必须同步演进）：
 * 超时 = `AbortSignal.timeout` 的 `TimeoutError`（DOMException）；非 2xx = 自带前缀的
 * `DouZero HTTP <status>`；解析失败 = `response.json()` 的 `SyntaxError`；其余（`fetch failed`
 * 族）一律归连接层。**未知错误也必须有归属**（`douzero_unreachable` 兜底）——标签不得出现
 * 无界的错误文本。
 */
export function classifyDouZeroFailure(error: unknown): RobotDecisionErrorReason {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'douzero_timeout';
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.startsWith('DouZero HTTP ')) return 'douzero_http_error';
  if (error instanceof SyntaxError) return 'douzero_bad_response';
  return 'douzero_unreachable';
}

/**
 * §9 机器人系统的**服务间**契约（`docs/design.md` §3.4 / §4.2 / §9.6）。
 *
 * ⚠️ 本文件的类型**永不**出现在任何 S→C 消息、REST 响应或日志里：
 *  - `RobotDecideRequest.view` 是 **`PlayerView`**（裁剪视图，§9.5：机器人只拿与人类完全相同的可见信息）；
 *  - `BotInstance.botId` / `skillLevel` / `personality.thinkingSpeed` 是**内部**字段 —— 出站由 `validateOutbound()` / `assertNoLeak()`
 *    机械拦住（`FORBIDDEN_OUTBOUND_KEYS` = `actionLog`/`isRobot`/`botId`/`skillLevel`/`thinkingSpeed`/`deviceId`〔风控片 T1 追加〕）。
 *
 * 传输形态（**本切片**）：与 `game.start` / `robot.acquire` 一致，走**内部 HTTP + `X-Internal-Token`**
 * 的过渡形态；§4.2 的 TCP RPC 迁移（`connectMicroservice` + 3103/3105）是**新登记偏差 N20**，
 * 归独立小片 P4（切片 11 的范围裁决，R200）。
 */

import type { RpcMeta } from './rpc';
import type { GameView } from './views';
import type { GameType } from './game';
import type { PdkRobotFeatures } from './pdk/types';

/** §9.3 的三档难度。 */
export type SkillLevel = 'beginner' | 'intermediate' | 'advanced';

/** §9.3 的性格参数（难度分级靠 `skillLevel`→模型（§9.3），思考延迟靠 `thinkingSpeed`）。 */
export interface BotPersonality {
  /** **基础手速**（ms，1–3s）：与难度无关；每回合实际延迟 = 该值 ± 300ms（夹到 [1000,3000]）。 */
  thinkingSpeed: number;
}

/** §3.4 的机器人实例。`botId` 内部、`displayId` 对外（与人类同构 `p_<8位>`）。 */
export interface BotInstance {
  /** 内部 ID（`bot-<uuid8>`），**永不下发**。 */
  botId: string;
  /** 对外 ID，与人类玩家同构：`p_<8位>`。它才是 `Seat.userId` / `GamePlayer.id`。 */
  displayId: string;
  skillLevel: SkillLevel;
  personality: BotPersonality;
  /** 绑定中的房间；空闲时为 `null`（§9.6 归池时清空）。 */
  roomCode: string | null;
  /** 绑定中的座位；空闲时为 `null`。 */
  seat: number | null;
  gamesPlayed: number;
  /** §9.6 池回收用：出池（空闲）时刻的毫秒时间戳；绑定中为 `undefined`。 */
  idleSince?: number;
  /**
   * 多玩法（Task 2.6 / D10）：所属玩法。**旧记录可能缺失** ⇒ 视为 doudizhu；
   * `release` 从记录推导（不信任调用方），归池写 `bot:pool:{gameType}`。
   */
  gameType?: GameType;
}

/** `robot.acquire`（room → robot，§4.2/§9.6 第 1 条）：`seats` 为**空缺座位号**。 */
export interface RobotAcquireRequest {
  roomCode: string;
  seats: number[];
  /** 多玩法：缺失 = doudizhu（旧调用）。 */
  gameType?: GameType;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/** `robot.acquire` 的响应：每个空缺座位一个机器人，`roomCode`/`seat` **由 robot-service 写入**。 */
export interface RobotAcquireResponse {
  bots: BotInstance[];
}

/** `robot.availability`（room → robot，片② D5）：**不带业务字段** —— 答案只取决于开关 + DouZero 现状。 */
export interface RobotAvailabilityRequest {
  /** 多玩法：缺失 = doudizhu（旧调用）。 */
  gameType?: GameType;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**）。 */
  meta?: RpcMeta;
}

/**
 * `robot.availability` 的响应（片② D5）。
 * `canProvide=false` 的两个原因：DouZero 不可达 / 三档模型不齐备。
 * ⚠️ 调用方（room-service）**只认 `false`**：RPC 失败、超时、字段缺失一律按「能给」处理（fail-open）。
 */
export interface RobotAvailabilityResponse {
  canProvide: boolean;
  reason?: 'douzero-unreachable' | 'models-incomplete';
}

/** `robot.release`（room → robot，§9.6 归池）：把 `botId` 放回 `bot:pool:{gameType}`。 */
export interface RobotReleaseRequest {
  botIds: string[];
  /** 多玩法：缺失 = doudizhu（旧调用；新调用应由 bot 记录推导）。 */
  gameType?: GameType;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

export interface RobotReleaseResponse {
  released: number;
}

/**
 * §4.2 的**公开**特征：由 game-service 从 `GameSession.actionLog` 投影而来。
 *
 * ⚠️ 只含**已经打出过的牌**（那是全体可见信息）；**不含**任何未出的手牌 ——
 * 「未出的手牌一律不可派生」（design.md §4.2 的例外说明）。
 */
export interface DdzRobotFeatures {
  /**
   * 多玩法（Task 2.6）：玩法判别位。**过渡期可选**（部署窗口里的旧 service 不发）——
   * 缺失按 doudizhu 处理。
   */
  gameType?: 'doudizhu';
  position: 'landlord' | 'landlord_down' | 'landlord_up';
  /** 上一手牌（公开）。 */
  lastMove: number[];
  lastMovePosition: string;
  /**
   * 上一手牌的**规则字段**（`type` / `keyRank` / `length`）—— 跟牌判定要用它。
   *
   * 🔴 **它为什么存在**（协议 ④ 的连带面，**不是**一个可有可无的冗余字段）：
   * 协议 ④ 之前，机器人是从 `PlayerView.lastPlayedHand` 里拿这个目标的 ——
   * 那是一个**显示字段**。退役它之后，机器人（**按设计没有 `session`**，
   * 见 `no-session-boundary.gate`）就失去了唯一的规则输入来源。
   * 而本仓**明令禁止重新解析 `cards` 反推** `type`/`length`（玩法 §5 要点 / `play.ts:68`）⇒
   * 必须由服务端把**已经算好的**规则字段投影过来。
   *
   * 🔵 这一补**修好了一层错位**：规则输入现在回到正路（由 session 投影出的公开信息，
   * 与 `playedCards` / `actionSeq` 同一来源），**不是**从显示层偷。**别把它当回归来「修」掉**。
   *
   * `null` = 尚无上一手牌（首出）。
   */
  lastMoveMeta: { type: number; keyRank: number; length: number } | null;
  /** 三家剩余张数（公开）。 */
  numCardsLeft: Record<string, number>;
  /** 三家**已经打出过**的牌（DouZero 编码），按 position 分组。 */
  playedCards: { landlord: number[]; landlord_down: number[]; landlord_up: number[] };
  /** 按出牌顺序的全部动作（公开）：`play` 是牌数组，`pass` 是空数组。 */
  actionSeq: number[][];
}

/** 按玩法判别的机器人特征联合（Task 2.6；pdk 类型唯一归属 `pdk/types.ts`）。 */
export type RobotFeatures = DdzRobotFeatures | PdkRobotFeatures;

/** `robot.decide`（game → robot，§4.2/§9.4）：**只传裁剪视图 + 公开特征**，绝不传 `GameSession`。 */
export interface RobotDecideRequest {
  roomCode: string;
  botId: string;
  skillLevel: SkillLevel;
  /** 多玩法：缺失 = doudizhu（旧调用）。 */
  gameType?: GameType;
  /** 【裁剪视图】绝不含他人手牌（§9.5）。 */
  view: GameView;
  /** 【公开信息特征】由 game-service 从 `actionLog` 派生（§4.2）。 */
  features: RobotFeatures;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/**
 * `robot.decide` 的响应（§4.2）。
 *
 * `source` 如实标注**决策来源**（不是难度档位）：`'douzero'`（调 DouZero 成功）
 * 或 `'rule'`（DouZero 抛错/超时/给出不在手里的牌之后的**降级**，§9.3）。
 * **动作是否合法由 game-service 裁判**（§9.4）：被拒必须回退规则引擎重决策，不得直接 pass。
 *
 * ⚠️ **叫抢阶段的约定（切片 11 执行期裁决 R215，写进契约以免口口相传）**：
 * 本响应**只有** `'play' | 'pass'` 两种 `kind`（§4.2 的形状如此，不新增字段），由 game-service
 * 按**当前阶段**解释：出牌阶段 = 出牌 / 过牌；**叫抢阶段 = 抢 / 不抢**（`kind:'play'` 表示抢）。
 * DouZero 没有叫抢模型，叫抢一律走规则引擎（`source:'rule'`）。这样同一个二进制响应在两阶段
 * 各有唯一含义，不需要第二个真源（例如再加 `grab?: boolean`）。
 */
export interface RobotDecideResponse {
  kind: 'play' | 'pass';
  cards?: number[];
  source: 'rule' | 'douzero';
}

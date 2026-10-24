import type { Card, LastPlayedHand, BidDecision } from '@fight-the-landlord/protocol';
import type {
  GameSessionBase,
  GamePlayerBase,
  ActionLogEntryBase,
} from '../core/session';

export enum GameState {
  Init = 'init',
  Bidding = 'bidding',
  Playing = 'playing',
  Ended = 'ended',
}

/**
 * `lastPlayedHand` 的**唯一**形状来自契约包（切片 9 / R157）：
 *  - `cards` 是 **DouZero** 编码（接口/存储层口径，§1.4）；
 *  - `keyRank` 是**内部 Rank**（`2` = 15）；
 *  - `length` 按玩法 §4.1 的**单位**取值（顺子=张数 / 连对·飞机=组数 / 其余=0）。
 * 切片 9 之前这里是 `{ cards; type: string; rank: number }`——第二个真源，
 * 正是 C19（牌值双口径）与 C20（`length` 单位）的滋生地。
 */
export type { LastPlayedHand };

/**
 * 结算结果的**唯一**形状来自契约包（玩法 §8.5 / 主规格 §6.3）。
 *
 * 切片 10（N1）之前这里有一份**同名不同形**的内部接口（`landlordSeats` 有、`baseScore`
 * 与 `spring` 无），于是 `settle.ts` 产出的载荷过不了网关的 `validateOutbound`，
 * `game.settlement` **整条**被拦掉 —— 不是字段是 `undefined`，而是事件根本不存在。
 * 与 `LastPlayedHand` 同一手法（R157）：**不允许有第二个形状**。
 */
export type { DdzSettlementResult } from '@fight-the-landlord/protocol';

export interface GamePlayer extends GamePlayerBase<Card> {
  /** 地主标记（ddz 专有）。 */
  isLandlord: boolean;
}

/**
 * 出牌历史的一条记录（§3.2）。
 *
 * `version` 是**该次状态转移之后**的版本号；`cards` 是 DouZero 编码
 * （`kind === 'pass'` 时恒为 `[]`）。
 */
export interface ActionLogEntry extends ActionLogEntryBase<Card> {}

export interface GameSession extends GameSessionBase<Card> {
  gameType: 'doudizhu';
  playerCount: 3;
  rules?: never;
  roomCode: string;
  /** 底分（§3.2）。开局时由 room-service 从档位表推导、经 `game.start` 显式写入（无代码缺省）。 */
  baseScore: number;
  state: GameState;
  players: GamePlayer[];  // 按座位顺序 [0, 1, 2]
  bottomCards: Card[];  // 地主底牌
  currentPlayer: number;  // 当前操作玩家索引
  lastPlayedHand: LastPlayedHand | null;
  lastPlayerIdx: number;  // 最后出牌玩家索引
  /**
   * 本回合截止时刻（§3.2 / 玩法 §9.2/§9.3）：毫秒时间戳 = 回合开始时刻 + 行动者档位时长
   * （正常 30000 / 连续超时 10000 / 托管 2000；机器人座位恒按正常档），每次**回合**转移后重算
   * （治理态变更不算回合转移）。**必填**（R472 收口：此前用 game-service 的**可选** module
   * 增强承载，与规格的必填形状不一致）。
   */
  turnDeadlineAt: number;
  version: number;  // 版本号，用于断线重连
  /**
   * 出牌历史：**状态转移序列**（§3.2）。DouZero 的 `played_cards_*` /
   * `card_play_action_seq` 特征由它派生（**唯一**投影是 `ddz/features.ts` 的
   * `buildPublicFeatures()`），也是将来事件重放的前提。
   *
   * ⚠️ 它记录三家全部牌面，属最高敏感数据：**`actionLog` 永不出站**（§6.4，
   * `FORBIDDEN_OUTBOUND_KEYS` 机械保证）。出站的只是由它投影出的**公开**信息
   * 「已经打出过的牌」（§4.2 的例外说明）。
   */
  actionLog: ActionLogEntry[];
  bidPhase: {
    currentBidder: number;
    landlordCaller: number;  // -1 表示尚无
    landlordCandidate: number;  // -1 表示尚无
    bidPasses: number;  // 连续不叫次数
    grabActions: number;  // 抢地主决策次数
    bidMultiplier: number;
    redealCount: number;  // 流局次数
    /**
     * 本轮已发生的叫抢决策（协议 ⑦ 的**内部形状** —— R157：内部形状**就是**契约形状）。
     * 按发生顺序；流局重发时清空（新的一轮）；地主确定后**保留**（它不含敏感信息，少一个清理点）。
     */
    decisions: BidDecision[];
    /**
     * 🔴 片① R2：本轮**第一条 `grab=true`** 的座位；本轮无人声称则 `-1`。
     *
     * 它是「反抢权」的判据之一（§4.1 的 `landlordCandidate !== firstCaller` ⟺ ≥2 人声称）。
     * ⚠️ **内部字段，永不出站** —— `PlayerView.bidPhase` 不含它（§5.4）。
     * ⚠️ 每轮开始时归 `-1`（`createSession` / `resetBidding` 两处都要写）。
     */
    firstCaller: number;
    /**
     * 🔴 片① R2：反抢是否**已派发**（本轮一次性）。
     *
     * 它让「轮次结束」判据对**决策计数单调**：`grabActions >= (antiRobGranted ? 4 : 3)`。
     * 没有它，反抢者一「不抢」会让判据恒真 ⇒ 叫抢永不终止（§4.2 的 ⚠️②）。
     * ⚠️ **内部字段，永不出站**。
     */
    antiRobGranted: boolean;
  };
  playPhase: {
    bombCount: number;
    landlordPlays: number;
    farmerPlays: number;
    consecutivePasses: number;
  };
  // ── 服务端内部字段（R472：由 game-service 的 module 增强上移到本接口） ──
  // ⚠️ 它们**全部不出站**（§6.4）：`PlayerView` 是独立的裁剪形状，只带
  //    `winner`/`cardCounts` 等公开投影（`view.builder` 负责）。
  /** 胜负方；未结束时为 undefined（§4.2 的 `PlayerView.winner`）。 */
  winner?: 'landlord' | 'farmer';
  /**
   * 机器人内部 ID，按座位索引；仅服务端持有（§4.2）。
   * 人类玩家为 undefined。**永不出站**。
   */
  botIds?: Array<string | undefined>;
  /**
   * 机器人难度，按座位索引（§4.2 的 `StartGameRequest.players[].skillLevel`）。
   * `robot.decide` 需要它来选双轨（§9.3）。人类玩家为 undefined。**永不出站**。
   */
  botSkillLevels?: Array<'beginner' | 'intermediate' | 'advanced' | undefined>;
  /**
   * 机器人**基础手速**（ms，1–3s），按座位索引；人类玩家为 undefined。**永不出站**。
   *
   * 可选：部署窗口内升级前创建的旧会话没有该键 ⇒ 消费侧用默认值 2000ms
   * （`game.service.ts` 的 `DEFAULT_THINKING_SPEED`）。
   */
  botThinkingSpeeds?: Array<number | undefined>;
  /**
   * 🔴 记录片 T2：**发牌后、叫抢前**的 17×3 初始手牌**冻结副本**（按座位序 [0, 1, 2]）。
   *
   * 它是「历史记录」里初始手牌的唯一来源 —— 结算时刻的 `players[].hand` 已是**残牌**
   * （出牌逐张 `splice` 摘除、地主还并入过底牌），从那里取不到原手牌。写入点 =
   * `ddz/game.ts` 的 `dealCards()`，**在内部排序之后**以切片写入；流局重发会再次
   * `dealCards()`（`bid.ts:185`）⇒ 快照被**覆盖**为新发牌，旧快照不留。
   *
   * **冻结** = 与后续被摘除/排序的 `hand` **不共享数组引用**（浅切片）——
   * 出牌/底牌并入都改不到它（反向判据见 `game.test.ts` 的 C2 用例）。
   *
   * ⚠️ **可选 + 内部字段，永不出站**：`PlayerView` 是独立裁剪形状，不含它。
   * 之所以可选 = 部署窗口守卫（r3-3）：升级前创建的旧会话（SESSION_TTL 1h 内）
   * 反序列化后**没有**这个键 ⇒ 发布侧「无快照 ⇒ 不附 record、绝不抛」；
   * `createSession` 不预设（未发牌 = 无快照），判「有快照」用真值判断即可。
   */
  initialHands?: Card[][];
  /** 创建时刻（§3.2）：毫秒时间戳（R472 收口前是 `Date`）。 */
  createdAt: number;
  /** 结束时刻（§3.2）：毫秒时间戳；未结束时为 `null`（R472 收口前是 `Date`）。 */
  finishedAt: number | null;
}

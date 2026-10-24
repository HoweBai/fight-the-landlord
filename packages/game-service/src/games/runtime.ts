/**
 * 玩法 runtime 接口（A′ 插件内核，S1）。
 *
 * game-service 保留玩法无关内核（Redis 会话、per-room 写队列、CAS、计时器、事件发布、
 * 机器人驱动、指标）；每个玩法实现本接口。**斗地主行为零变化**：DdzRuntime 只是
 * 现有 `shared/ddz/*` 纯函数的适配层。
 */
import type {
  Card,
  GameMeta,
  GameType,
  GameView,
  PdkRobotFeatures,
  RobotFeatures,
  SettlementResult,
  StartGameRequest,
} from '@fight-the-landlord/protocol';
import type {
  GameAction,
  GameSessionBase,
  GovernanceDurations,
} from '@fight-the-landlord/shared';

/** `game.start` 的玩家形状（复用契约，不另立真源）。 */
export type StartGamePlayer = StartGameRequest['players'][number];

export interface CreateGameInput {
  roomCode: string;
  gameType: GameType;
  playerCount: number;
  baseScore: number;
  /** 已按 seat 升序。 */
  players: StartGamePlayer[];
  /** 玩法规则快照；斗地主不用。 */
  rules?: unknown;
  random: () => number;
  /** 内部测试钩子（仅 INTERNAL_TEST_HOOKS=1）。 */
  seed?: number;
  testDeck?: Card[];
}

export interface RuntimeCtx {
  now: number;
  random: () => number;
  governance: GovernanceDurations;
  /** 本次动作/超时的行动者座位（orchestrator 从 userId/计时器解析后传入）。 */
  actorSeat: number;
}

export interface Transition<S extends GameSessionBase> {
  session: S;
  ended: boolean;
}

/** 记录信封（`game.ended` 的 `record` 字段；room-service 消费后不转发客户端）。 */
export interface DdzRecordEnvelope {
  startedAt: number;
  seats: Array<{ seat: number; playerId: string; hand: string }>;
  bottomCards: string;
  gameType?: 'doudizhu';
  playerCount?: 3;
}
export interface PdkRecordEnvelope {
  startedAt: number;
  seats: Array<{ seat: number; playerId: string; hand: string; playedCount: number }>;
  unusedCards?: string;
  gameType: 'paodekuai';
  playerCount: 2 | 3 | 4;
}
export type RecordEnvelope = DdzRecordEnvelope | PdkRecordEnvelope;

/** 机器人公开特征联合（pdk 类型见 protocol/pdk/types）。 */
export type GameRobotFeatures = RobotFeatures | PdkRobotFeatures;

export interface GameRobotInput {
  view: GameView;
  features: GameRobotFeatures;
}

export interface GameRuntime<S extends GameSessionBase = GameSessionBase> {
  readonly gameType: GameType;
  readonly meta: GameMeta;

  create(input: CreateGameInput): S;
  applyAction(session: S, action: GameAction, ctx: RuntimeCtx): Transition<S>;
  onTimeout(session: S, ctx: RuntimeCtx): Transition<S>;
  isFinished(session: S): boolean;
  /** 补齐终局字段（winner/winnerSeats/state/finishedAt）；orchestrator 在 isFinished 为真时调用。 */
  finish(session: S, now: number): S;
  settle(session: S): SettlementResult;

  buildView(session: S, seat: number): GameView;
  /** 按 session.players 遍历；替代 ddz 专用 buildAllSeatViews/SEATS。 */
  buildAllViews(session: S): GameView[];
  buildRobotInput(session: S, seat: number): GameRobotInput;
  buildRecord(session: S): RecordEnvelope | undefined;

  /** 当前行动者；斗地主叫抢用 bidPhase.currentBidder，跑得快用 currentPlayer。 */
  currentActor(session: S): number;
  /** 当前计时阶段；斗地主叫抢/出牌两档，跑得快恒 play。 */
  timerPhase(session: S): 'bid' | 'play';
  turnDuration(session: S, seat: number, policy: GovernanceDurations): number;
  /** 超时、托管、机器人降级共用的自动动作。 */
  autoAction(session: S, seat: number): GameAction;
}

/** 供 registry 存储擦除泛型用（各 runtime 的 S 不同）。 */
export type AnyGameRuntime = GameRuntime<any>;

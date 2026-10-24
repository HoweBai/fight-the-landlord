/**
 * 牌局驱动的**玩法无关骨架**（Task 4.4 接口预留；pdk 实现在 S7 的 `pdk-driver.ts`）。
 *
 * 本文件只定义 S7 要实现的接缝，不提供实现 —— 现有 `ddz-driver.ts` 保持原样。
 *
 * 硬约束（spec §6.5 / §5.2）：
 *  - **独立 oracle**：驱动判「出什么牌/能不能过」只能来自公开视图与自己的计算，
 *    **不得 import `protocol/src/pdk/rule`**（否则等于拿被测实现当裁判）；
 *  - **确定性通道**：pdk 经 `game.start.seed/testDeck`（仅 `INTERNAL_TEST_HOOKS=1`）
 *    构造固定手牌；不得靠概率撞场景；
 *  - **结算判据**：至少覆盖零和、座位完整、`remaining` 与记录 `playedCount` 一致。
 */
import type { Card, GameType } from '@fight-the-landlord/protocol';

/** 驱动只读的出站视图骨架（ddz/pdk 的交集；各自 driver 可收窄）。 */
export interface GameDriverView {
  roomCode: string;
  version: number;
  state: string;
  seat: number;
  hand: Card[];
  cardCounts: number[];
  currentPlayer: number;
  /** 跑得快专有：服务端算好的过牌许可（ddz 无此字段）。 */
  canPass?: boolean;
}

/** 驱动的机械动作（与线格式 `game.play` / `game.pass` 同形）。 */
export type GameDriverAction =
  | { kind: 'play'; cards: Card[] }
  | { kind: 'pass' };

/** 结算判据的入参（各玩法 driver 自行收窄到自己的结算向量）。 */
export interface GameDriverSettlement {
  baseScore: number;
  scoreChanges: Array<{ seat: number; delta: number }>;
}

/** 建桌 + 开局的确定性钩子（room-service `startRoom` options 的子集）。 */
export interface GameDriverStartHooks {
  seed?: number;
  testDeck?: Card[];
}

/** 一个玩法的 conformance 驱动。 */
export interface ConformanceGameDriver<V extends GameDriverView = GameDriverView> {
  readonly gameType: GameType;
  readonly playerCount: number;
  /**
   * 当前行动者的动作（**独立 oracle**）；返回 `null` 表示「本驱动不出来」
   * （调用方按场景失败处理，不得静默跳步）。
   */
  decide(view: V): GameDriverAction | null;
  /** 结算守恒断言（零和 + 座位覆盖）；失败抛 `ConformanceError`。 */
  assertSettlement(settlement: GameDriverSettlement): void;
}

/** 驱动工厂：S7 的 pdk 场景按人数/确定性钩子构造驱动。 */
export type ConformanceGameDriverFactory<V extends GameDriverView = GameDriverView> = (options: {
  playerCount: number;
  hooks?: GameDriverStartHooks;
}) => ConformanceGameDriver<V>;

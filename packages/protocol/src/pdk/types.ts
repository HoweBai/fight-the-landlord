/**
 * 跑得快的协议类型（**pdk 视图/结算/机器人特征的唯一归属**）。
 *
 * - 视图/结算/特征在 Task 0.4 先以独立类型存在；Task 0.5 再并入
 *   `GameView` / `SettlementResult` 联合。
 * - `PdkHandType`/`PdkParsedHand` 先定义在这里，Task 3.2 的 `pdk/rule.ts` 只做 re-export，
 *   避免“类型在 rule、特征在 types”两处各有一份。
 */
import type { PdkAirplaneWings, PdkRulesConfig } from './rules';
import type { GameType } from '../game';
import type { Card, GameViewBase } from '../views';

export enum PdkHandType {
  Invalid = 0,
  Single = 1,
  Pair = 2,
  Trio = 3,
  TrioWithSingle = 4,
  TrioWithPair = 5,
  FourWithTwo = 6,
  Straight = 7,
  ConsecutivePairs = 8,
  Airplane = 9,
  AirplaneWithWings = 10,
  Bomb = 11,
}

export interface PdkParsedHand {
  type: PdkHandType;
  /** 顺子/连对/飞机取**最大**点数；其余取主牌点数。 */
  keyRank: number;
  /** 顺子=张数 / 连对=对子数 / 飞机=三张数 / 炸弹=4 / 其余=0。 */
  length: number;
  /** 仅 AirplaneWithWings 有值。 */
  wingMode?: PdkAirplaneWings;
}

/** 跑得快出站视图。 */
export interface PdkPlayerView extends GameViewBase<Card> {
  gameType: 'paodekuai';
  playerCount: 2 | 3 | 4;
  state: 'playing' | 'ended';
  /** 服务端算好：首出 false，跟牌 true。 */
  canPass: boolean;
  /** 当前已打出的炸弹数（显示/结算预览）。 */
  bombCount: number;
  /** 本局规则快照；字段名不得叫 `rules`（禁出站键）。 */
  pdkRules: PdkRulesConfig;
  /** 结束时有值。 */
  winnerSeats?: number[];
}

/** 新玩法共用的零和结算向量。 */
export interface SettlementVector {
  roomCode: string;
  gameType: GameType;
  playerCount: number;
  baseScore: number;
  winnerSeats: number[];
  scoreChanges: Array<{ seat: number; delta: number }>;
}

/** 跑得快结算。 */
export interface PdkSettlementResult extends SettlementVector {
  gameType: 'paodekuai';
  playerCount: 2 | 3 | 4;
  remaining: number[];
  multiplier: number;
  bombCount: number;
  guan: boolean;
  spring: boolean;
  baobenSeats: number[];
}

/** 跑得快机器人公开特征（只含已打出/公开信息）。 */
export interface PdkRobotFeatures {
  gameType: 'paodekuai';
  seat: number;
  /** 上一手牌；首出为 null。`cards` 是 DouZero 点数数组。 */
  lastMove: (PdkParsedHand & { cards: number[] }) | null;
  numCardsLeft: number[];
  playedCards: number[][];
  actionSeq: number[][];
  passCount: number;
  bombCount: number;
  canPass: boolean;
  /** 本局规则快照；字段名不得叫 `rules`。 */
  pdkRules: PdkRulesConfig;
}

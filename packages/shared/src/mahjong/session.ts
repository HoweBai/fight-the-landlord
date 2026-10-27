/**
 * 麻将会话（服务端内部；纯规则层共用）。
 *
 * T2 先给内核窗口/类型判别提供形状；T5 再补完整状态机字段。
 * `actionLog` 用麻将自己的条目类型（`GameSessionBase<P,L>` 的 L 位）。
 */
import type {
  MahjongActionRecord,
  MahjongHuInfo,
  MahjongMeldView,
  MahjongPhase,
  MahjongRulesConfig,
  MahjongScoreEvent,
  MahjongSuit,
  Tile,
} from '@fight-the-landlord/protocol';
import type { ActionLogEntryBase, GamePlayerBase, GameSessionBase } from '../core/session';

export interface MahjongPlayer extends GamePlayerBase<Tile> {
  melds: MahjongMeldView[];
  discards: Tile[];
  lackSuit: MahjongSuit | null;
  isOut: boolean;
  hu: MahjongHuInfo | null;
  /** 换三张选择（3 张同花色）；窗口结算后清空。 */
  exchangePick: Tile[];
  /** 过水锁：本次摸牌前不能胡的牌型 + 当时番。 */
  passedHu: Array<{ tile: number; fan: number }>;
}

export type MahjongActionLogEntry = { version: number; seat: number; action: MahjongActionRecord; auto?: boolean };

export interface MahjongPendingClaims {
  discard: Tile;
  fromSeat: number;
  candidates: number[];
  responses: Array<{ seat: number; claim: 'hu' | 'gang' | 'peng' | 'pass' }>;
  /** 胡候选的当前番（过水加番判定/展示）。 */
  fanBySeat?: Record<number, number>;
}

export interface MahjongSession extends GameSessionBase<Tile, MahjongActionLogEntry> {
  gameType: 'mahjong';
  state: MahjongPhase;
  dealerSeat: number;
  /** 牌墙（服务端内部，永不出站）。 */
  wall: Tile[];
  wallCount: number;
  players: MahjongPlayer[];
  rules: MahjongRulesConfig;
  /** 已胡座位（结算/日志用）。 */
  winnerSeats?: number[];
  pendingClaims: MahjongPendingClaims | null;
  lastDiscard: { seat: number; tile: Tile } | null;
  lastDraw: { seat: number; tile: Tile; fromKong: boolean } | null;
  scoreEvents: MahjongScoreEvent[];
  /** 换三张方向（记录/回放审计）。 */
  exchangeDirection?: 'clockwise' | 'counterclockwise' | 'opposite';
  /** 本局 RNG 种子（服务端审计；永不出站）。 */
  rngSeed?: string;
  /** 当前窗口 id（与 runtime.windowId 同源）。 */
  windowId: string;
}

/** T2 用：动作日志的基础形状（不含旧 ddz 的 play/pass 语义）。 */
export type MahjongBaseLogEntry = ActionLogEntryBase<Tile>;

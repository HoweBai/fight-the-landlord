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
import { dealMahjong } from './deck';

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

export type MahjongActionLogEntry = MahjongActionRecord;

export interface MahjongPendingClaims {
  kind: 'claim' | 'rob';
  discard: Tile;
  fromSeat: number;
  candidates: number[];
  responses: Array<{ seat: number; claim: 'hu' | 'gang' | 'peng' | 'pass' }>;
  /** 胡候选的当前番（过水加番判定/展示）。 */
  fanBySeat?: Record<number, number>;
  /** 抢杠窗口：待应用的补杠。 */
  gangMeldIndex?: number;
}

export interface MahjongSession extends GameSessionBase<Tile, MahjongActionRecord> {  gameType: 'mahjong';
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
  /** 窗口序号（windowId 的稳定后缀）。 */
  windowSeq: number;
  /** 荒庄标记 / 结束原因。 */
  liuju?: boolean;
  endReason?: 'threeWinners' | 'wallEmpty';
}

/** T2 用：动作日志的基础形状（不含旧 ddz 的 play/pass 语义）。 */
export type MahjongBaseLogEntry = ActionLogEntryBase<Tile>;

export interface CreateMahjongSessionInput {
  roomCode: string;
  baseScore: number;
  players: Array<{ id: string; seat: number; isBot: boolean }>;
  rules: MahjongRulesConfig;
  random: () => number;
  testWall?: readonly Tile[];
  rngSeed?: string;
  createdAt?: number;
}

/** 建局：发牌 4×13 + 56；换三张开则 state=exchange，否则直接 lack。 */
export function createMahjongSession(input: CreateMahjongSessionInput): MahjongSession {
  const deal = dealMahjong(input.random, input.testWall);
  const players: MahjongPlayer[] = input.players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({
      id: p.id,
      seat: p.seat,
      hand: deal.hands[p.seat] ?? [],
      isBot: p.isBot,
      isOffline: false,
      timeoutCount: 0,
      trustee: false,
      melds: [],
      discards: [],
      lackSuit: null,
      isOut: false,
      hu: null,
      exchangePick: [],
      passedHu: [],
    }));
  const exchange = input.rules.exchangeThreeEnabled;
  return {
    roomCode: input.roomCode,
    gameType: 'mahjong',
    playerCount: 4,
    baseScore: input.baseScore,
    state: exchange ? 'exchange' : 'lack',
    players,
    currentPlayer: 0,
    turnDeadlineAt: 0,
    version: 1,
    actionLog: [],
    createdAt: input.createdAt ?? Date.now(),
    finishedAt: null,
    rules: input.rules,
    dealerSeat: Math.floor(input.random() * 4),
    wall: deal.wall,
    wallCount: deal.wall.length,
    pendingClaims: null,
    lastDiscard: null,
    lastDraw: null,
    scoreEvents: [],
    windowId: exchange ? 'exchange' : 'lack',
    windowSeq: 0,
    rngSeed: input.rngSeed,
    initialHands: deal.hands.map((h) => [...h]),
  };
}

export function isMahjongFinished(session: MahjongSession): boolean {
  return session.state === 'ended';
}

export function finishMahjong(session: MahjongSession, now: number): MahjongSession {
  const winnerSeats = session.players.filter((p) => p.isOut).map((p) => p.seat);
  const endReason = session.endReason ?? (winnerSeats.length >= 3 ? 'threeWinners' : 'wallEmpty');
  return {
    ...session,
    state: 'ended',
    finishedAt: now,
    winnerSeats,
    liuju: session.liuju ?? endReason === 'wallEmpty',
    endReason,
    windowId: 'ended',
    pendingClaims: null,
  };
}

/**
 * 麻将出站视图 / 结算 / 记录 / 机器人特征（协议层唯一归属）。
 *
 * 禁出站（view/record 投影必须遵守）：
 * - 牌墙 `wall`、他人 `hand`、`rngSeed`、`botId`/`skillLevel`/`thinkingSpeed`、`passedHu` 内部结构；
 * - 已胡者手牌只能进 `revealedHands[].tiles`（字段名不是 `hand`，避免撞禁键）。
 */
import type { GameViewBase } from '../views';
import type { SettlementVector } from '../pdk/types';
import type { MahjongActionRecord } from './actions';
import type { MahjongClaim } from './actions';
import type { MahjongRulesConfig } from './rules';
import type { MahjongSuit, Tile } from './tile';

export type MahjongPhase = 'exchange' | 'lack' | 'play' | 'claim' | 'rob' | 'draw' | 'ended';

export type MahjongMeldKind = 'peng' | 'gang' | 'angang';

export interface MahjongMeldView {
  kind: MahjongMeldKind;
  tiles: Tile[];
  /** 碰/明杠的来源座位；暗杠/补杠为 undefined。 */
  fromSeat?: number;
}

export interface MahjongHuInfo {
  seat: number;
  /** 点炮者；自摸为 null。 */
  fromSeat: number | null;
  tile: Tile;
  fan: number;
  multiplier: number;
  items: string[];
  selfDraw: boolean;
}

export interface MahjongClaimOption {
  claim: MahjongClaim;
  tile?: Tile;
  /** 胡候选时的当前番（展示/排序用）。 */
  fan?: number;
}

/** 分数事件账（结算/记录展示用；scoreChanges 由它截断后汇总）。 */
export type MahjongScoreEvent =
  | {
      kind: 'gang';
      seq: number;
      seat: number;
      gang: 'melded' | 'added' | 'concealed';
      tile: Tile;
      payers: Array<{ seat: number; amount: number }>;
    }
  | {
      kind: 'hu';
      seq: number;
      seat: number;
      fromSeat: number | null;
      fan: number;
      multiplier: number;
      payers: Array<{ seat: number; amount: number }>;
      items: string[];
    }
  | {
      kind: 'transfer';
      seq: number;
      ref: number;
      fromSeat: number;
      toSeat: number;
      amount: number;
      reason: 'gangShoot';
    }
  | {
      kind: 'refund';
      seq: number;
      ref: number;
      fromSeat: number;
      toSeats: Array<{ seat: number; amount: number }>;
      reason: 'robbed' | 'shootAfterGang' | 'notReady';
    }
  | { kind: 'chajiao'; seq: number; fromSeat: number; toSeat: number; amount: number; fan: number }
  | {
      kind: 'huazhu';
      seq: number;
      seat: number;
      amount: number;
      mode: 'payEach' | 'burn48';
      payees: Array<{ seat: number; amount: number }>;
    };

export interface MahjongFanDetail {
  seat: number;
  fan: number;
  multiplier: number;
  items: string[];
}

export interface MahjongPlayerView extends GameViewBase<Tile> {
  gameType: 'mahjong';
  playerCount: 4;
  state: MahjongPhase;
  dealerSeat: number;
  /** 牌墙剩余张数（永不下发牌墙本身）。 */
  wallCount: number;
  /** 按座位；未定缺为 null。 */
  lackSuits: Array<MahjongSuit | null>;
  melds: MahjongMeldView[][];
  discards: Tile[][];
  isOut: boolean[];
  huInfos: MahjongHuInfo[];
  /** 当前窗口待决策座位。 */
  activeSeats: number[];
  /** 仅接收者可用的候选动作；服务端算好，客户端只展示。 */
  claimsForMe: MahjongClaimOption[];
  tingTiles?: Tile[];
  maxFanForMe?: number;
  /** 规则快照（字段名不是 rules）。 */
  mahjongRules: MahjongRulesConfig;
  /** 杠分/临时分投影；终局以结算为准。 */
  pendingScoreChanges?: Array<{ seat: number; delta: number }>;
  /** 已胡者亮牌；只含已胡者。 */
  revealedHands: Array<{ seat: number; tiles: Tile[]; huTile: Tile }>;
  /** 当前多行动者窗口 id（客户端原样回传）。 */
  windowId?: string;
}

export interface MahjongSettlementResult extends SettlementVector {
  gameType: 'mahjong';
  playerCount: 4;
  winnerSeats: number[];
  /** 截断后事件净额；零和；不含 burn/rake。 */
  scoreChanges: Array<{ seat: number; delta: number }>;
  fanDetails: MahjongFanDetail[];
  events: MahjongScoreEvent[];
  /** 花猪罚分（burn 的一半；不含抽水）。 */
  burn: Array<{ seat: number; amount: number; reason: 'flowerPig' }>;
  /** 抽水（burn 的另一半）。 */
  rakeTotal: number;
  chajiao: Array<{ from: number; to: number; amount: number }>;
  liuju: boolean;
  huazhuSeats: number[];
  endReason: 'threeWinners' | 'wallEmpty';
  writtenOff: Array<{ seat: number; amount: number; reason: string }>;
}

export interface MahjongRecordSeat {
  seat: number;
  playerId: string;
  isRobot: boolean;
  /** 发牌后、换三张前的初始 13 张（27 位计数串）。 */
  hand: string;
  /** 终局手牌（含胡牌张，13/14 张）。 */
  finalHand?: string;
  melds: MahjongMeldView[];
  discards: Tile[];
  lackSuit: MahjongSuit | null;
  isOut: boolean;
  hu?: MahjongHuInfo;
  fan?: number;
  multiplier?: number;
  delta: number;
}

export interface MahjongRecordEnvelope {
  startedAt: number;
  gameType: 'mahjong';
  playerCount: 4;
  dealerSeat: number;
  rules: MahjongRulesConfig;
  /** 服务端审计；不得出站到历史接口。 */
  rngSeed?: string;
  seats: MahjongRecordSeat[];
  actions: MahjongActionRecord[];
  resultSummary: {
    fanDetails: MahjongFanDetail[];
    events: MahjongScoreEvent[];
    burn: Array<{ seat: number; amount: number; reason: 'flowerPig' }>;
    rakeTotal: number;
    writtenOff: Array<{ seat: number; amount: number; reason: string }>;
    liuju: boolean;
    huazhuSeats: number[];
    endReason: 'threeWinners' | 'wallEmpty';
  };
}

/** 历史接口的裁剪形态：只给自己的手牌，不给他人未胡手牌/rngSeed。 */
export interface MahjongRecordView {
  roomCode: string;
  endedAt: number;
  gameType: 'mahjong';
  mode: 'random' | 'practice' | 'gold';
  playerCount: 4;
  dealerSeat: number;
  ownSeat: number;
  ownHand?: string;
  seats: Array<{
    seat: number;
    nickname?: string;
    isRobot?: boolean;
    melds: MahjongMeldView[];
    discards: Tile[];
    lackSuit: MahjongSuit | null;
    isOut: boolean;
    hu?: MahjongHuInfo;
    fan?: number;
    delta: number;
  }>;
}

/** 机器人公开特征：只含已公开信息；不含任何手牌/牌墙/RNG。 */
export interface MahjongRobotFeatures {
  gameType: 'mahjong';
  seat: number;
  phase: MahjongPhase;
  wallCount: number;
  melds: MahjongMeldView[][];
  discards: Tile[][];
  lackSuits: Array<MahjongSuit | null>;
  isOut: boolean[];
  activeSeats: number[];
  lastDiscard: { seat: number; tile: Tile } | null;
  lastDraw: { seat: number; fromKong: boolean } | null;
  claimsForMe: MahjongClaimOption[];
}

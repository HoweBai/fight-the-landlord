/**
 * 出站结构定义。字段名**逐字**对照 docs/design.md：
 *  - `Seat` / `RoomInfo` / `RoomPlayer` → §3.1
 *  - `PlayerView` → §4.2
 *  - `SettlementResult` → docs/games/doudizhu.md §8.5
 */

import type { GameType } from './game';
import type { PdkPlayerView } from './pdk/types';
import { ProtocolError } from './validate';

/**
 * 一张牌。**全系统唯一的牌形状**（R696）：协议 / Redis / 内存手牌 / 客户端同构。
 *
 * 与 R695 同一精神——不留第二套：`shared/src/card/card.ts` 的
 * `Card { suit, rank, color }` 已退役。
 */
export interface Card {
  /** DouZero 编码（R695：全系统唯一编码）：3–14 / 17(=2) / 20(小王) / 30(大王)。 */
  r: number;
  /** 花色：0♠ 1♥ 2♣ 3♦ 4王。**两张王都是 4**（颜色差异由 `r` 区分，见 `colorOf`）。 */
  s: number;
}

/** 房间内的座位占用。**服务端内部结构**，含 `isRobot`，永不下发。 */
export interface Seat {
  userId: string;
  seat: number;
  isRobot: boolean;
}

/** 房间列表项 / 创建响应（§3.1） */
export interface RoomInfo {
  code: string;
  /** ② 金币场：`'gold'` 仅经匹配进入（REST 建房保持 practice-only，`rooms.dto.ts` 不动）。 */
  mode: 'random' | 'practice' | 'gold';
  status: 'waiting' | 'playing' | 'finished' | 'cancelled';
  /** **当前已占座位数**（旧客户端房态显示依赖它；容量看 `maxPlayers`）。 */
  playerCount: number;
  maxPlayers: number;
  baseScore: number;
  /** 多玩法：过渡期可选；缺失 = doudizhu。 */
  gameType?: GameType;
}

/** 下发给客户端的房间成员（已裁剪，**绝不含 `isRobot`**） */
export interface RoomPlayer {
  id: string;
  seat: number;
  cardCount?: number;
  /**
   * ② 金币场（D7）：钱包余额——**仅金币场**填充（开局时三座 `currency.get`，读失败**省略**该字段，
   * 客户端显示「—」）；免费场/好友房**永不出现**（整场统一「—」的不可区分性红线）。
   */
  balance?: number;
  /**
   * 昵称（昵称片）：**可选** —— 缺省 = 服务端不知道（RPC 失败 / 存量用户 / 未分配）；
   * 机器人通常由 room-service 分配展示昵称（2026-10-22 拟人昵称片），与人类同样下发。
   * 客户端回落「玩家N」；不使用 `null`，沿用 `balance?` 的「缺省即无真值」惯例。
   */
  nickname?: string;
}

/** 上一手牌。`keyRank` 为 **DouZero 编码**（`2` = 17），`length` 单位见玩法 §4.1。 */
export interface LastPlayedHand {
  cards: Card[];
  type: number;
  keyRank: number;
  length: number;
}

/**
 * 一条**桌面历史动作**（协议 ④ / 上位 §4.4）。
 *
 * ⚠️ `cards: null` **不是**「缺省值」，而是一条**显式事实**：该座位**「不出」**。
 * 窗口 = 2、按发生顺序（旧 → 新）、**「不出」也占一手**。
 *
 * 🔵 它顺手消灭了一个 hack：旧契约里没有任何字段能表达「谁刚过了牌」，
 * 于是「不出」气泡是**客户端自己编的**（`table.vue` 的 `bubble` / R656）。新规则下
 * `cards: null` 就是**服务端的原话** ⇒ 那个机制整条退役。
 */
export interface RecentActionBase<P = Card> {
  seat: number;
  cards: P[] | null;
}

/** 旧代码兼容别名；首版两种玩法都用 Card。 */
export type RecentAction = RecentActionBase<Card>;

/**
 * 一条**叫抢决策**（协议 ⑦ / 用户 2026-09-28 裁决）。
 *
 * `kind` 是**服务端算好的措辞依据**：`'call'` ⇒ 叫地主/不叫，`'rob'` ⇒ 抢地主/不抢。
 * 前端**只能从它派生文案**，不得由 `grabActions`/`landlordCandidate` 反推（上位 §4.3）。
 */
export interface BidDecision {
  seat: number;
  kind: 'call' | 'rob';
  grab: boolean;
}

/**
 * 出站对局视图的**公共骨架**（多玩法片）。
 *
 * ⚠️ `gameType`/`playerCount` 过渡期**可选**：旧服务发出的 ddz 消息没有它们，
 * 新客户端只有字段缺失时才缺省 doudizhu/3；空串/非法值必须报错。
 * ⚠️ `cardCounts`/`trustees` 是变长数组：斗地主仍恰 3，跑得快 2/3/4。
 */
export interface GameViewBase<P = Card> {
  roomCode: string;
  gameType?: GameType;
  playerCount?: number;
  /** 状态版本号。同一次状态转移内发出的多条消息共享同一版本。 */
  version: number;
  state: string;
  /** 本局的**底分**（协议 ⑥）。牌桌据此显示「XX场 底分 N」。 */
  baseScore: number;
  /** 接收者自己的座位 */
  seat: number;
  /** **仅自己的手牌**，DouZero 编码 + 花色 */
  hand: P[];
  /** 各座位手牌张数，按座位索引；长度 = playerCount。 */
  cardCounts: number[];
  /** 按座位的托管态（徽标数据面；与 cardCounts 同族）。 */
  trustees: boolean[];
  currentPlayer: number;
  /** 桌面历史牌：斗地主窗口 2；跑得快按人数（2/3→2、4→3，见 `pdkRecentActionsWindow`）；旧→新、「不出」用 null。 */
  recentActions: RecentActionBase<P>[];
  /** 本回合截止时刻（毫秒时间戳）。客户端倒计时与重连恢复都依赖它。 */
  turnDeadlineAt: number;
  /** 预留：麻将多决策窗口；首版两种玩法恒 [currentPlayer]。 */
  activeSeats?: number[];
}

/**
 * 出站的对局视图（斗地主）。**这是 ddz 唯一的出站对局类型**（§6.4）。
 *
 * 永不出站的字段（任何 S→C 消息、任何 REST 响应、任何日志都不得出现）：
 * `actionLog`、他人的 `hand`、`isRobot`、`botId`、`skillLevel`。
 * `validateOutbound` 会机械地检查这一点。
 */
export interface PlayerView extends GameViewBase<Card> {
  /** 过渡期可选：缺失 = doudizhu（旧服务）。 */
  gameType?: 'doudizhu';
  state: 'init' | 'bidding' | 'playing' | 'ended';
  /** 斗地主线上仍恰 3 元组（旧客户端类型依赖）；pdk 用基类的变长数组。 */
  cardCounts: [number, number, number];
  trustees: [boolean, boolean, boolean];
  /** 叫抢阶段恒为 `null`；`state === 'playing'` 后三家皆可见 */
  bottomCards: Card[] | null;
  /** 地主座位；未确定时为 `null`。**「谁是地主」的唯一来源。** */
  landlordSeat: number | null;
  bidPhase: {
    /** 叫抢阶段的**行动者**在这里，不在 `currentPlayer`（玩法 §9.1） */
    currentBidder: number;
    bidMultiplier: number;
    /** `-1` 表示本轮尚无 */
    landlordCandidate: number;
    /** 本轮已完成的决策次数（0..4 —— 片① R2 起允许一次反抢） */
    grabActions: number;
    redealCount: number;
    /**
     * 当前行动者该用哪套措辞（协议 ③）。
     * 派生依据是「本轮**是否已有人声称**」（`landlordCandidate`），**不是** `grabActions`。
     */
    kind: 'call' | 'rob';
    /** 本轮**已发生**的叫抢决策，按发生顺序；最多 4 条（一轮制 + 一次反抢，天然有界）。 */
    decisions: BidDecision[];
  };
  playPhase: { bombCount: number };
  winner?: 'landlord' | 'farmer';
}

/** 出站对局视图联合（按 `gameType` 判别；缺失 ⇒ 斗地主）。 */
export type GameView = PlayerView | PdkPlayerView;

/**
 * 视图玩法解析的**唯一入口**（spec §4.5.1 / S5.3）。
 *
 * - `gameType` **缺失**（旧服务端视图）且没有 pdk 专属字段 ⇒ `doudizhu`；
 * - `gameType === 'paodekuai'` ⇒ `paodekuai`；
 * - pdk 专属字段存在但 `gameType` 缺失 / 未知 id ⇒ `ProtocolError`
 *   —— **绝不**把跑得快视图当斗地主渲染（fail closed）。
 */
export function resolveGameType(view: GameViewBase): GameType {
  if (view.gameType === 'paodekuai') return 'paodekuai';
  if (view.gameType === 'doudizhu' || view.gameType === undefined) {
    if (view.gameType === undefined && ('canPass' in view || 'pdkRules' in view)) {
      throw new ProtocolError(
        'view has paodekuai fields but no gameType (refusing to render pdk as doudizhu)',
      );
    }
    return 'doudizhu';
  }
  throw new ProtocolError(`unknown gameType: ${String(view.gameType)}`);
}

/** 结算结果（玩法 §8.5）。**斗地主保持旧 9 键**；跑得快用 PdkSettlementResult。 */
export interface DdzSettlementResult {
  roomCode: string;
  baseScore: number;
  winner: 'landlord' | 'farmer';
  landlordSeat: number;
  farmerSeats: number[];
  multiplier: number;
  spring: 'none' | 'spring' | 'anti-spring';
  landlordScoreChange: number;
  farmerScoreChange: number;
}

/** ack 响应（§6.2）。响应通过 socket.io 的 ack 回调返回，不是独立事件。 */
export interface Ack<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

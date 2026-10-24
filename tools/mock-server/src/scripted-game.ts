/**
 * 脚本化对局。**这不是规则实现**——它只是一个「足够像」的假状态机，
 * 让前端能在后端就绪之前开发 UI。
 *
 * 刻意不做的事：不校验牌型、不判胜负规则、不算春天。
 * 刻意要做的事（这几条正是 mock 的价值所在）：
 *  1. 严格按 `packages/protocol` 的契约发出消息（服务层每条都过 `validateOutbound`）
 *  2. **按座位裁剪** —— 每个玩家只看到自己的手牌，他人只有张数
 *  3. 遵守玩法 §2/§3.4 的阶段语义：**叫抢阶段底牌不并入、也不可见**；
 *     地主确定的那一刻才并入底牌（20 张）并公开
 *  4. 复现 §6.2 的时序：一次状态转移发 `state_update` + `current_turn`，共享同一 version
 */

import { type Card, type PlayerView, type DdzSettlementResult } from '@fight-the-landlord/protocol';

export const MOCK_ROOM_CODE = 'MOCK01';
const BASE_SCORE = 100;
/** mock 固定让座位 0 当地主 */
const LANDLORD_SEAT = 0;

export interface Transition {
  /** 每个座位收到的裁剪视图（同一次状态转移共享同一 version） */
  seatViews: PlayerView[];
  version: number;
  /** 该版本轮到谁 */
  currentSeat: number;
  /** 本局是否结束；结束时为结算结果 */
  settled: DdzSettlementResult | null;
}

/**
 * 一副 54 张。R696：牌是 `{r, s}` —— `r` 是 DouZero 编码（2 是 17，不是 15），
 * `s` 是花色（0♠ 1♥ 2♣ 3♦ 4王）。
 *
 * 这里给**真实花色**（同点数四张分属 0–3），不是统一取 0：
 * mock 的价值之一就是「严格按 protocol 的契约发消息」，形状失真就失去意义。
 */
function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (let r = 3; r <= 14; r++) {
    for (let s = 0; s < 4; s++) deck.push({ r, s });
  }
  for (let s = 0; s < 4; s++) deck.push({ r: 17, s }); // 2
  deck.push({ r: 20, s: 4 }); // 小王
  deck.push({ r: 30, s: 4 }); // 大王
  return deck;
}

/** 手牌的规范顺序（与 `shared` 的 `compareCards` 同口径：先点数、再花色）。 */
const byRankThenSuit = (a: Card, b: Card): number => a.r - b.r || a.s - b.s;

export class ScriptedGame {
  private readonly seats: { id: string; hand: Card[] }[];
  private version = 0;
  private currentSeat = 0;
  private landlordSeat: number | null = null;
  private readonly bottomCards: Card[];
  /**
   * 协议 ④ 的窗口（**与 `shared/ddz/recent.ts` 同形实现** —— mock 只依赖 protocol，
   * 不为这三行加一个 shared 依赖；形状与窗口长度**逐字对齐**那一份）。
   */
  private recentActions: PlayerView['recentActions'] = [];
  private readonly passCount = [0, 0, 0];
  /**
   * mock 的**脚本状态**：最后出过牌的人（`-1` = 还没人出过牌）。一墩结束时出牌权交回
   * **最后出牌者**（玩法 §6.2-5）。
   *
   * ⚠️ **不要**把它改成从 `recentActions` 反推（2026-09-28 评审实测的恒退化）：触发一墩结束的
   * `passCount[seat] >= 2`（同一家连过两次，其间**不可能**有出牌）保证窗口 2 个槽**恒为两条「不出」**
   * ⇒ 从窗口取的「最后出牌者」恒为 `-1` ⇒ 每一次一墩结束都退化为「停在本家」，与旧行为**恒不同**。
   *
   * 这不违反「`recentActions` 只能有一处实现」的纪律：那条管的是**投影**（窗口是出站视图，
   * 由 `play()`/`pass()` 维护、与 `shared/ddz/recent.ts` 同形）；本字段是 mock **自己的脚本状态**
   * （与 `currentSeat` / `passCount` 同类），不是第二份投影 —— 且窗口只有 2 个槽，
   * **结构上**表达不了「最后出牌者」（它可能已滑出窗口）。
   */
  private lastPlayedSeat = -1;
  private state: PlayerView['state'] = 'init';
  private readonly turnMs = 30_000;
  private turnDeadlineAt = Date.now() + 30_000;
  private bombCount = 0;
  private winner: 'landlord' | 'farmer' | null = null;

  constructor(playerIds: string[]) {
    const deck = fullDeck();
    this.bottomCards = deck.slice(0, 3);
    this.seats = playerIds.map((id, seat) => ({
      id,
      hand: deck.slice(3 + seat * 17, 3 + (seat + 1) * 17).sort(byRankThenSuit),
    }));
  }

  /**
   * 发牌：三家各 **17** 张，底牌**不并入**、对外不可见（玩法 §2）。
   * 状态进入 bidding，叫抢由座位 0 起。
   */
  deal(): Transition {
    this.state = 'bidding';
    this.landlordSeat = null;
    this.currentSeat = 0;
    this.recentActions = [];
    this.lastPlayedSeat = -1;
    this.bump();
    return this.snapshot();
  }

  /**
   * 叫抢（mock 简化：一轮制，座位 0 一抢即定）。
   * **地主确定的那一刻才把底牌并入其手牌**（玩法 §3.4），随后公开。
   */
  bid(seat: number, grab: boolean): Transition {
    if (this.state === 'bidding' && seat === LANDLORD_SEAT && grab) {
      this.landlordSeat = LANDLORD_SEAT;
      this.seats[LANDLORD_SEAT].hand = [
        ...this.seats[LANDLORD_SEAT].hand,
        ...this.bottomCards,
      ].sort(byRankThenSuit);
      this.state = 'playing';
      this.currentSeat = LANDLORD_SEAT;
    }
    this.bump();
    return this.snapshot();
  }

  play(seat: number, cards: Card[]): Transition {
    const hand = this.seats[seat].hand;
    for (const c of cards) {
      // R697 同口径：按 `(r, s)` 精确摘除。⚠️ **不得用 `indexOf`** ——
      // 对 `Card` 对象做的是引用相等，而调用方传进来的是**另一个**对象 ⇒ 恒 -1。
      const i = hand.findIndex((h) => h.r === c.r && h.s === c.s);
      if (i >= 0) hand.splice(i, 1); // 不校验牌型，只做移除
    }
    // 协议 ④：出牌就是往窗口尾部追加一项（旧 → 新），窗口只留最后两手。
    // 旧实现在这里写 `lastPlayedHand`（含 type/keyRank/length）+ `lastPlayerIdx` —— 两个字段
    // 都已退役；窗口只带**牌面**（规则态是服务端的事，mock 不判牌型）。
    this.recentActions = [
      ...this.recentActions,
      { seat, cards: [...cards].sort(byRankThenSuit) },
    ].slice(-2);
    // 轮转的脚本状态（见 `lastPlayedSeat` 的声明注释）：本次出牌者 = 「最后出牌者」。
    this.lastPlayedSeat = seat;
    this.passCount[0] = 0;
    this.passCount[1] = 0;
    this.passCount[2] = 0;
    if (cards.length >= 4) this.bombCount += 1;

    if (hand.length === 0) {
      this.winner = seat === this.landlordSeat ? 'landlord' : 'farmer';
      this.state = 'ended';
    } else {
      this.currentSeat = (seat + 1) % 3;
    }
    this.bump();
    return this.snapshot();
  }

  pass(seat: number): Transition {
    this.passCount[seat] += 1;
    if (this.passCount[seat] >= 2) {
      this.passCount[0] = 0;
      this.passCount[1] = 0;
      this.passCount[2] = 0;
      // 窗口**不需要被清**（旧实现在这里写 `lastPlayedHand = null`）—— 「不出」天然表达在窗口里。
      // 轮转读**脚本状态** `lastPlayedSeat`，**不是**窗口：一墩结束时窗口两槽恒是「不出」，
      // 反推必退化（原因与实测见该字段的声明注释）。
      this.currentSeat = this.lastPlayedSeat === -1 ? seat : this.lastPlayedSeat;
    } else {
      this.currentSeat = (seat + 1) % 3;
    }
    // 两条返回路径都追加「不出」（显式的 `cards: null`）—— 窗口由本方法照旧维护，不因轮转改动。
    this.recentActions = [...this.recentActions, { seat, cards: null }].slice(-2);
    this.bump();
    return this.snapshot();
  }

  getVersion(): number {
    return this.version;
  }

  getCurrentSeat(): number {
    return this.currentSeat;
  }

  getViewFor(seat: number): PlayerView {
    return this.viewFor(seat);
  }

  private bump(): void {
    this.version += 1;
    this.turnDeadlineAt = Date.now() + this.turnMs;
  }

  /** 为每个座位生成**裁剪后**的视图 —— 这是 mock 最重要的价值 */
  private snapshot(): Transition {
    const seatViews = this.seats.map((_, viewer) => this.viewFor(viewer));
    return {
      seatViews,
      version: this.version,
      currentSeat: this.currentSeat,
      settled: this.state === 'ended' ? this.settlement() : null,
    };
  }

  private viewFor(viewer: number): PlayerView {
    const playing = this.state === 'playing' || this.state === 'ended';
    return {
      roomCode: MOCK_ROOM_CODE,
      version: this.version,
      state: this.state,
      baseScore: BASE_SCORE,
      seat: viewer,
      // 只有自己的手牌（叫抢阶段 17 张，地主确定后 20 张）
      hand: [...this.seats[viewer].hand].sort(byRankThenSuit),
      cardCounts: [this.seats[0].hand.length, this.seats[1].hand.length, this.seats[2].hand.length],
      // 挂机治理（C25）：mock 不实现治理规则 ⇒ 三座托管态恒 false（字段形状照契约）。
      trustees: [false, false, false],
      // 叫抢阶段为 null；进入 playing 后三家皆可见（§6.4）
      bottomCards: playing ? [...this.bottomCards] : null,
      // 「谁是地主」的唯一来源
      landlordSeat: playing ? this.landlordSeat : null,
      currentPlayer: this.state === 'playing' ? this.currentSeat : 0,
      recentActions: this.recentActions,
      turnDeadlineAt: this.turnDeadlineAt,
      bidPhase: {
        // 叫抢阶段的行动者在这里，不在 currentPlayer
        currentBidder: this.state === 'bidding' ? this.currentSeat : 0,
        bidMultiplier: this.landlordSeat === null ? 1 : 2,
        landlordCandidate: this.landlordSeat ?? -1,
        grabActions: this.landlordSeat === null ? 0 : 1,
        redealCount: 0,
        // 协议③：kind 的**唯一**实现是 shared 的 `bidKindOf` —— mock 只依赖
        // `protocol`（没有 `shared` 依赖），这里**同形表达**同一规则（本轮没人声称 ⇒ call）。
        kind: this.landlordSeat === null ? 'call' : 'rob',
        // 协议⑦：与 mock 自己的 `grabActions` 模型保持一致 —— 它把叫抢简化成
        // 「座位 0 一抢即定」，故有地主时恰好一条决策（首称 ⇒ kind 为 `call`）。
        decisions:
          this.landlordSeat === null
            ? []
            : [{ seat: LANDLORD_SEAT, kind: 'call', grab: true }],
      },
      playPhase: { bombCount: this.bombCount },
      ...(this.winner ? { winner: this.winner } : {}),
    };
  }

  /**
   * 结算载荷（契约 §8.5 的 9 个字段）。
   *
   * ⚠️ **这是 mock 的第二真源**，因此必须仍与玩法 §8.2 的口径一致（切片 10 / R192）：
   * 倍数 = `bidMultiplier × 2^bombCount × 春天倍数`（**乘法**）。旧实现写成 `bombCount + 1`
   * —— 既把炸弹当加法，又整条丢掉了叫抢倍数（mock 固定一抢 ⇒ `bidMultiplier = 2`）。
   * mock **不承担**春天（它不统计 `landlordPlays`/`farmerPlays` ⇒ 恒 `'none'`，
   * **不要**照 mock 推断春天的行为）。真实口径以 `packages/shared/src/ddz/settle.ts` 为准。
   */
  private settlement(): DdzSettlementResult {
    const bidMultiplier = this.landlordSeat === null ? 1 : 2;
    const multiplier = bidMultiplier * 2 ** this.bombCount;
    const unit = BASE_SCORE * multiplier;
    const landlordWon = this.winner === 'landlord';
    const landlordSeat = this.landlordSeat ?? LANDLORD_SEAT;
    return {
      roomCode: MOCK_ROOM_CODE,
      baseScore: BASE_SCORE,
      winner: this.winner ?? 'landlord',
      landlordSeat,
      farmerSeats: [0, 1, 2].filter((s) => s !== landlordSeat),
      multiplier,
      spring: 'none',
      landlordScoreChange: landlordWon ? unit * 2 : -unit * 2,
      farmerScoreChange: landlordWon ? -unit : unit,
    };
  }
}

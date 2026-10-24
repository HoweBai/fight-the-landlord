import { describe, it, expect, beforeEach } from 'vitest';
import type { Card } from '@fight-the-landlord/protocol';
import { handleBid, BID_MULTIPLIER_CAP, bidKindOf } from './bid';
import { GameState, GameSession } from './types';
import { compareCards, createSession, dealCards } from './game';

/**
 * 手牌的指纹。⚠️ **不得用 `cards.join(',')`** —— `Card[]` 下它对所有**同长度**
 * 手牌都产出 `"[object Object],…"`，两边恒等 ⇒ 判据退化成恒绿（spec §3.5-B 记的
 * 正是这个形态；`table.vue` 的选中清空判据踩的是同一个坑）。
 */
const fingerprint = (cards: Card[]): string => cards.map((c) => `${c.r}-${c.s}`).join(',');

describe('handleBid', () => {
  let session: ReturnType<typeof dealCards>;

  beforeEach(() => {
    // 片① R1：注入常量随机源 ⇒ 起始座位恒为座位 0（与改动前的行为一致）。
    const created = createSession('ROOM1', ['user-1', 'user-2', 'user-3'], () => 0);
    session = dealCards(created);
  });

  it('throws when game is not in bidding state', () => {
    const ended = { ...session, state: GameState.Ended };
    expect(() => handleBid(ended, 'user-1', true)).toThrow('not in bidding state');
  });

  it('throws when player not found', () => {
    expect(() => handleBid(session, 'unknown', true)).toThrow('not found');
  });

  it('throws when not current bidder turn', () => {
    expect(() => handleBid(session, 'user-2', true)).toThrow('Not your turn');
  });

  it('accepts bid and updates multiplier', () => {
    const result = handleBid(session, 'user-1', true);
    expect(result.bidPhase.landlordCandidate).toBe(0);
    expect(result.bidPhase.bidMultiplier).toBe(2);
    expect(result.bidPhase.grabActions).toBe(1);
  });

  it('accepts pass', () => {
    const result = handleBid(session, 'user-1', false);
    expect(result.bidPhase.bidPasses).toBe(1);
  });

  it('moves currentBidder to next player after bid', () => {
    const result = handleBid(session, 'user-1', true);
    expect(result.bidPhase.currentBidder).toBe(1);
  });

  it('moves currentBidder to next player after pass', () => {
    const result = handleBid(session, 'user-1', false);
    expect(result.bidPhase.currentBidder).toBe(1);
  });

  it('finalizes when grabActions >= 3', () => {
    let s = handleBid(session, 'user-1', true);
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false);
    expect(s.state).toBe(GameState.Playing);
    expect(s.players[0].isLandlord).toBe(true);
    // C15：地主确定后手牌必须已经是 20 张（底牌已并入）
    expect(s.players[0].hand).toHaveLength(20);
  });

  it('increments version on each action', () => {
    const before = session.version;
    const result = handleBid(session, 'user-1', true);
    expect(result.version).toBe(before + 1);
  });

  it('does not mutate input session', () => {
    const before = session.version;
    handleBid(session, 'user-1', true);
    expect(session.version).toBe(before);
  });

  // ── C15 / R101：底牌并入地主手牌（三处同改的「真源」这一处）────────────
  it('地主确定时把 bottomCards 并入其 hand，恰好 20 张且是「原手牌 ∪ 底牌」（C15 / 玩法 §2.3/§3.4-2）', () => {
    const before = dealCards(createSession('ROOM-C15', ['user-1', 'user-2', 'user-3'], () => 0));
    const landlordBefore = [...before.players[0]!.hand].sort(compareCards);
    const bottom = [...before.bottomCards].sort(compareCards);
    expect(landlordBefore).toHaveLength(17);
    expect(bottom).toHaveLength(3);

    let s = handleBid(before, 'user-1', true); // 座位 0 抢
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false);

    expect(s.state).toBe(GameState.Playing);
    expect(s.players[0]!.isLandlord).toBe(true);
    expect(s.players[0]!.hand).toHaveLength(20);
    expect([...s.players[0]!.hand].sort(compareCards)).toEqual(
      [...landlordBefore, ...bottom].sort(compareCards),
    );
    // 农民的 17 张不得被碰
    expect(s.players[1]!.hand).toHaveLength(17);
    expect(s.players[2]!.hand).toHaveLength(17);
    // 玩法 §3.4-5：bottomCards 保留不清空（可见性裁剪要用）
    expect(s.bottomCards).toHaveLength(3);
    // 玩法 §3.4-1/6/7：进入 playing 的同一转移里完成
    expect(s.currentPlayer).toBe(0);
    expect(s.lastPlayedHand).toBeNull();
    expect(s.lastPlayerIdx).toBe(-1);
  });

  it('地主手牌并入后不再有别的补偿空间：20 张是最终值，重复调用 handler 不会变成 23（C15 回归）', () => {
    let s = handleBid(dealCards(createSession('ROOM-C15B', ['a', 'b', 'c'], () => 0)), 'a', true);
    s = handleBid(s, 'b', false);
    s = handleBid(s, 'c', false);
    const first = s.players[0]!.hand.length;
    // 进入 playing 后再叫抢必须被拒（不是「继续叫」），因此不存在第二次并入
    expect(() => handleBid(s, 'a', true)).toThrow('not in bidding state');
    expect(s.players[0]!.hand.length).toBe(first);
    expect(first).toBe(20);
  });

  // ── C24 / R104：流局后回到座位 0（单点推进）──────────────────────────
  it('流局后 currentBidder 回到座位 0（C24：不得双重推进）', () => {
    // ⚠️ 片① R1：R104/C24 已作废（重发改为**重摇**）—— 夹具传常零源 ⇒ 重摇仍得座位 0。
    //    断言逐字未动。
    let s = handleBid(session, 'user-1', false, () => 0);
    s = handleBid(s, 'user-2', false, () => 0);
    s = handleBid(s, 'user-3', false, () => 0);
    expect(s.state).toBe(GameState.Bidding);
    expect(s.bidPhase.currentBidder).toBe(0);
    expect(s.bidPhase.grabActions).toBe(0);
    expect(s.bidPhase.bidPasses).toBe(0);
    expect(s.bidPhase.bidMultiplier).toBe(1);
    expect(s.bidPhase.redealCount).toBe(1);
  });

  it('连续两次流局后仍从座位 0 起（旧实现是 0 → 1 → 2 的推进）', () => {
    // ⚠️ 片① R1：常零源 ⇒ 每次重摇都得座位 0；断言逐字未动。
    let s = session;
    for (let round = 0; round < 2; round += 1) {
      s = handleBid(s, 'user-1', false, () => 0);
      s = handleBid(s, 'user-2', false, () => 0);
      s = handleBid(s, 'user-3', false, () => 0);
      expect(s.bidPhase.currentBidder).toBe(0);
    }
    expect(s.bidPhase.redealCount).toBe(2);
    expect(s.state).toBe(GameState.Bidding);
  });

  // ── C4 / R102：流局必须重新发牌 ─────────────────────────────────────
  it('流局重新洗牌发牌：手牌与底牌全部改变、每家仍是 17 张、底牌仍是 3 张（C4 / 玩法 §3.3）', () => {
    const handsBefore = session.players.map((p) => fingerprint(p.hand));
    const bottomBefore = fingerprint(session.bottomCards);

    let s = handleBid(session, 'user-1', false);
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false);

    for (const p of s.players) expect(p.hand).toHaveLength(17);
    expect(s.bottomCards).toHaveLength(3);
    // ⚠️ 概率判据：54 张牌重洗后三家手牌与底牌**全部**与上一轮逐位相同的概率可以忽略；
    //    这条断言钉的是「真的调了 dealCards」，而不是「看起来像重发了」。
    const handsAfter = s.players.map((p) => fingerprint(p.hand));
    expect(handsAfter.join('|')).not.toBe(handsBefore.join('|'));
    expect(fingerprint(s.bottomCards)).not.toBe(bottomBefore);
    // 同一副牌只发一次：三家手牌 + 底牌合起来必须**恰好**是一整副牌
    // （防止「重发时忘了清旧手牌」导致同一张牌出现两次）。
    // ⚠️ R696 **之前**不能写 `new Set(all).size === 54`：DouZero 编码不含花色，
    //    54 张牌只有 15 个不同值（3..14、17、20、30），去重后必然是 15。
    //    **现在牌带花色的（`{r, s}`），这条更强的断言可用了** ⇒ 两条一起断言：
    //    ① 54 个 `(r, s)` 互不相同（R696 新增的能力）；② 点数分布恰好是标准牌堆。
    const all = [...s.players.flatMap((p) => p.hand), ...s.bottomCards];
    expect(all).toHaveLength(54);
    expect(new Set(all.map((c) => `${c.r}-${c.s}`)).size).toBe(54);
    const counts = new Map<number, number>();
    for (const c of all) counts.set(c.r, (counts.get(c.r) ?? 0) + 1);
    const deckDistribution = new Map<number, number>();
    for (let rank = 3; rank <= 14; rank += 1) deckDistribution.set(rank, 4);
    deckDistribution.set(17, 4); // R695：2 就是 17（不再是内部 Rank 的 15）× 4
    deckDistribution.set(20, 1); // 小王
    deckDistribution.set(30, 1); // 大王
    expect(counts).toEqual(deckDistribution);
  });

  it('流局重发是一次状态转移：version 恰好 +1（玩法 §3.4-8 / 主规格 §3.2）', () => {
    let s = handleBid(session, 'user-1', false);
    s = handleBid(s, 'user-2', false);
    const beforeReset = s.version;
    s = handleBid(s, 'user-3', false);
    expect(s.version).toBe(beforeReset + 1);
  });

  // ── C23 / R103：倍数上限 8 ──────────────────────────────────────────
  it('三人全抢 → bidMultiplier 恰好 8（不是 16/24；C23）', () => {
    let s = handleBid(session, 'user-1', true);
    s = handleBid(s, 'user-2', true);
    s = handleBid(s, 'user-3', true);
    expect(s.bidPhase.bidMultiplier).toBe(BID_MULTIPLIER_CAP);
    expect(s.bidPhase.bidMultiplier).toBe(8);
    // 片① R2：T,T,T ⇒ 第 3 拍后派发反抢帧（首个声称者 = 座位 0）⇒ 本轮**尚未**收口。
    // ⚠️ 旧断言「一轮制下三个『抢』⇒ 座位 2 是地主、state = Playing」随本片作废（规格 §6.1）。
    expect(s.state).toBe(GameState.Bidding);
    // 反抢者「不抢」⇒ 地主仍是**末位声称者**（座位 2），本轮随之收口。
    s = handleBid(s, 'user-1', false);
    expect(s.state).toBe(GameState.Playing);
    expect(s.players[2]!.isLandlord).toBe(true);
    expect(s.bidPhase.landlordCandidate).toBe(2);
  });

  it('「抢」只在自己那一步 ×2，不抢不变（倍数只能取 1/2/4/8）', () => {
    let s = handleBid(session, 'user-1', false);
    expect(s.bidPhase.bidMultiplier).toBe(1);
    s = handleBid(s, 'user-2', true);
    expect(s.bidPhase.bidMultiplier).toBe(2);
    s = handleBid(s, 'user-3', false);
    expect(s.bidPhase.bidMultiplier).toBe(2);
  });

  // ── R105：随机指定地主的路径必须写 landlordCandidate ────────────────
  it('第 3 次流局随机指定地主时，landlordCandidate 必须落地（玩法 §3.4-3 / R105）', () => {
    // 走到第 3 次流局：每次三家全不抢
    // ⚠️ 片① R1：常零源 ⇒ 每次重发都从座位 0 起（断言逐字未动）；最后的随机地主也因
    //    注入源而确定（座位 0）。
    let s = session;
    for (let round = 0; round < 3; round += 1) {
      s = handleBid(s, 'user-1', false, () => 0);
      s = handleBid(s, 'user-2', false, () => 0);
      s = handleBid(s, 'user-3', false, () => 0);
    }
    expect(s.bidPhase.redealCount).toBe(3);
    expect(s.state).toBe(GameState.Playing); // 第 3 次不再重发，直接指定
    const landlord = s.players.find((p) => p.isLandlord)!;
    expect(landlord).toBeDefined();
    // 「谁是地主」的唯一来源：client 与 robot 都只能读它
    expect(s.bidPhase.landlordCandidate).toBe(landlord.seat);
    // 随机地主也要拿底牌（§3.4 第 2 条对两条路径都成立）
    expect(landlord.hand).toHaveLength(20);
    // 随机指定时不因流局次数翻倍：流局已把倍数归位为 1
    expect(s.bidPhase.bidMultiplier).toBe(1);
  });

  it('随机指定地主的路径也必须写 landlordCandidate（R105 直接探针，不经流局重发）', () => {
    // 直接摆到「第 3 次流局的那一步」：前两轮已流局完，本轮前两人已表态且都不抢，
    // 座位 2 再「不抢」就是唯一触发**随机指定**路径的入口。
    const staged = {
      ...session,
      bidPhase: {
        ...session.bidPhase,
        currentBidder: 2,
        grabActions: 2,
        bidPasses: 2,
        redealCount: 2,
      },
    };

    const s = handleBid(staged, 'user-3', false);

    expect(s.state).toBe(GameState.Playing);
    const landlord = s.players.find((p) => p.isLandlord)!;
    // 旧实现只设 isLandlord、不写 landlordCandidate（实测 -1）⇒ 客户端与机器人不知道谁是地主
    expect(s.bidPhase.landlordCandidate).toBe(landlord.seat);
  });

  /**
   * 协议 ⑦：每次决策都追加一条 `decisions`，且 `kind` 是**决策发生那一刻**算好的。
   *
   * ⚠️ 用 `landlordCandidate === -1` 判「叫」而不是 `grabActions === 0`：
   * 「第一家不叫、第二家叫」时，第二家仍然是**叫地主**（本轮还没有人声称）。
   */
  it('协议⑦：每次决策追加一条 decisions（kind 就地算好）', () => {
    const s1 = handleBid(session, 'user-1', false); // 第一家「不叫」
    expect(s1.bidPhase.decisions).toHaveLength(1);
    expect(s1.bidPhase.decisions[0]).toEqual({ seat: 0, kind: 'call', grab: false });

    const s2 = handleBid(s1, 'user-2', true); // 第二家「叫地主」
    expect(s2.bidPhase.decisions).toHaveLength(2);
    expect(s2.bidPhase.decisions[1]).toEqual({ seat: 1, kind: 'call', grab: true });

    const s3 = handleBid(s2, 'user-3', true); // 第三家「抢地主」
    expect(s3.bidPhase.decisions).toHaveLength(3);
    expect(s3.bidPhase.decisions[2]).toEqual({ seat: 2, kind: 'rob', grab: true });
  });

  /** 🔴 反例：第一家**不叫**之后，第二家仍然是「叫」—— 这是 `grabActions === 0` 派生法会错的地方。 */
  it('协议⑦反例：第一家不叫 ⇒ 第二家的 kind 仍是 call', () => {
    const s1 = handleBid(session, 'user-1', false);
    expect(s1.bidPhase.landlordCandidate).toBe(-1);
    const s2 = handleBid(s1, 'user-2', true);
    expect(s2.bidPhase.decisions[1]!.kind).toBe('call');
  });

  /** 流局重发 ⇒ 新的一轮，`decisions` 必须清空。 */
  it('协议⑦：流局重发后 decisions 清空', () => {
    let s = handleBid(session, 'user-1', false);
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false); // 三家全不抢 ⇒ 流局
    expect(s.bidPhase.redealCount).toBe(1);
    expect(s.bidPhase.decisions).toEqual([]);
  });

  /** 地主确定 ⇒ 进入 playing；`decisions` 保留（它是**无人读的数据**，但也不清 —— 少一个清理点）。 */
  it('协议⑦：地主确定后 decisions 仍在（本轮结果可读）', () => {
    let s = handleBid(session, 'user-1', true);
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false);
    expect(s.state).toBe(GameState.Playing);
    expect(s.bidPhase.decisions).toHaveLength(3);
  });

  /** `bidKindOf` 是**唯一**的派生实现（`view.builder` 直接用它，不得各自实现）。 */
  it('bidKindOf：landlordCandidate === -1 ⇒ call，否则 rob', () => {
    expect(bidKindOf({ landlordCandidate: -1 })).toBe('call');
    expect(bidKindOf({ landlordCandidate: 0 })).toBe('rob');
    expect(bidKindOf({ landlordCandidate: 2 })).toBe('rob');
  });
});

/**
 * 片① R2 的真值表判据（规格 §3）。
 * 记号：`b(i)` = 第 i 位决策者「抢」，`p(i)` = 「不抢」。决策顺序恒为 s0→s1→s2。
 * ⚠️ 一律传 `() => 0` 让起始座位确定（Task 1 的可注入随机源）。
 */
describe('片① R2：反抢真值表', () => {
  const start = () => dealCards(createSession('ROOM1', ['u0', 'u1', 'u2'], () => 0));

  /** 走完一串决策；每步断言「轮到的是谁」以防派发错人（§4.2 的 ⚠️①）。 */
  function run(s: GameSession, seq: Array<boolean | null>): GameSession {
    let cur = s;
    for (const bid of seq) {
      if (cur.state !== GameState.Bidding) return cur; // 已收口，剩余 seq 忽略
      const seat = cur.bidPhase.currentBidder;
      expect(seat, '不得把行动者指到 -1 或不存在的座位').toBeGreaterThanOrEqual(0);
      cur = handleBid(cur, `u${seat}`, bid === true, () => 0);
    }
    return cur;
  }

  it('#1 全不叫 ⇒ 流局重发（不进入反抢）', () => {
    const after = run(start(), [false, false, false]);
    expect(after.state).toBe(GameState.Bidding); // 重发后仍 bidding
    expect(after.bidPhase.grabActions).toBe(0);  // resetBidding 归零
    expect(after.bidPhase.firstCaller).toBe(-1);
    expect(after.bidPhase.antiRobGranted).toBe(false);
  });

  it('#2 叫/不叫/不叫 ⇒ 座位 0 当地主、倍数 2', () => {
    const after = run(start(), [true, false, false]);
    expect(after.state).toBe(GameState.Playing);
    expect(after.players[0]!.isLandlord).toBe(true);
    expect(after.bidPhase.bidMultiplier).toBe(2);
  });

  it('#3 不叫/叫/不叫 ⇒ 座位 1 当地主（反抢权归「首次声称者」s1，但首=末 ⇒ 不派发）', () => {
    const after = run(start(), [false, true, false]);
    expect(after.state).toBe(GameState.Playing);
    expect(after.players[1]!.isLandlord).toBe(true);
  });

  it('#4 不叫/叫/叫 ⇒ 反抢者 = s1；他抢 ⇒ 他当地主', () => {
    // 前 3 拍后应当仍在 bidding，且行动者被指到 s1
    const mid = run(start(), [false, true, true]);
    expect(mid.state).toBe(GameState.Bidding);
    expect(mid.bidPhase.currentBidder).toBe(1);
    expect(mid.bidPhase.antiRobGranted).toBe(true);
    const done = handleBid(mid, 'u1', true, () => 0);
    expect(done.state).toBe(GameState.Playing);
    expect(done.players[1]!.isLandlord).toBe(true);
  });

  it('#4′ 不叫/叫/叫 ⇒ 反抢者**不抢** ⇒ 末位声称者 s2 当地主（且本轮必须结束）', () => {
    const mid = run(start(), [false, true, true]);
    const done = handleBid(mid, 'u1', false, () => 0);
    expect(done.state).toBe(GameState.Playing);
    expect(done.players[2]!.isLandlord).toBe(true);
  });

  it('#5 叫/叫/不叫 ⇒ 反抢者 = s0', () => {
    const mid = run(start(), [true, true, false]);
    expect(mid.bidPhase.currentBidder).toBe(0);
    expect(mid.bidPhase.antiRobGranted).toBe(true);
  });

  it('#6 叫/不叫/叫 ⇒ 反抢者 = s0', () => {
    const mid = run(start(), [true, false, true]);
    expect(mid.bidPhase.currentBidder).toBe(0);
    // ⚠️ 补强：`currentBidder === 0` 单条**不具区分力** —— 旧实现的
    //    `(末位决策者 + 1) % 3` 恰也等于 0（3 拍走完一个座位循环）。
    //    `antiRobGranted` 才是「反抢帧确实被派发」的机械判据（§4.2 ⚠️①）。
    expect(mid.bidPhase.antiRobGranted).toBe(true);
  });

  it('#7 叫/叫/叫 ⇒ 反抢者 = s0；他抢 ⇒ 倍数仍 8（前 3 拍已 3 次声称 ⇒ 8 保持不变）', () => {
    const mid = run(start(), [true, true, true]);
    expect(mid.bidPhase.currentBidder).toBe(0);
    const done = handleBid(mid, 'u0', true, () => 0);
    expect(done.players[0]!.isLandlord).toBe(true);
    expect(done.bidPhase.bidMultiplier).toBe(8);
  });

  it('🔴 反抢那一抢**会**加分（前 3 拍 2 次声称 ⇒ 4 → 8）—— 修「第 4 次不贡献」这个错陈述', () => {
    // 形状 #6（抢/不抢/抢）：前 3 拍 m = 2 → 4，派发反抢给 firstCaller（座位 0）
    const mid = run(start(), [true, false, true]);
    expect(mid.bidPhase.antiRobGranted).toBe(true);
    expect(mid.bidPhase.bidMultiplier).toBe(4);        // 派发时
    const done = handleBid(mid, 'u0', true, () => 0);   // 反抢者「抢」
    expect(done.bidPhase.bidMultiplier).toBe(8);        // ⇒ 升到 8（不是「不变」）
  });

  it('#8 不叫/不叫/叫 ⇒ 座位 2 当地主', () => {
    const after = run(start(), [false, false, true]);
    expect(after.state).toBe(GameState.Playing);
    expect(after.players[2]!.isLandlord).toBe(true);
  });

  it('🔴 终止性负例：反抢者「不抢」⇒ 本轮**必须**结束、不得再派发反抢', () => {
    const mid = run(start(), [true, true, false]);
    const done = handleBid(mid, 'u0', false, () => 0);
    expect(done.state).toBe(GameState.Playing);
    expect(done.bidPhase.grabActions).toBe(4);
  });
});

/**
 * 片① R1：流局重发是**新的一轮** ⇒ 起始座位**重新摇**（R104 的「一律回座位 0」已作废）。
 *
 * ⚠️ 这条判据必须能**区分「重摇」与「恒 0 / 推进」**：只传 `() => 0` 的用例三种实现
 * （重摇 / 硬编码 0 / `(末位 + 1) % 3`）全都绿 —— 因此这里注入 `() => 0.9`，
 * 只有真正的重摇（`floor(0.9 × 3) = 2`）才能过。
 */
describe('片① R1：流局重发重摇起始座位', () => {
  it('三家全不叫 ⇒ 重发后由注入随机源定座位（() => 0.9 ⇒ 座位 2，不是恒 0）', () => {
    let s = dealCards(createSession('ROOM-R1', ['u0', 'u1', 'u2'], () => 0));
    for (let i = 0; i < 3; i += 1) {
      s = handleBid(s, `u${i}`, false, () => 0.9);
    }
    expect(s.state).toBe(GameState.Bidding);
    expect(s.bidPhase.redealCount).toBe(1);
    expect(s.bidPhase.currentBidder).toBe(2);
  });
});

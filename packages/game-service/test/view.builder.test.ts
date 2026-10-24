import { describe, it, expect } from 'vitest';
import {
  GameState,
  HandType,
  compareCards,
  handlePlayCards,
  type GameSession,
} from '@fight-the-landlord/shared';
import { ProtocolError, assertNoLeak, validateOutbound, type Card } from '@fight-the-landlord/protocol';
import {
  buildAllSeatViews,
  buildPlayerView,
  findSeatByUserId,
  remainingTurnMs,
  TURN_TIMEOUT_MS,
} from '../src/game/view.builder';

/**
 * R696：牌是 `{r, s}`。本文件的断言只关心**点数与张数**，故 `s` 取 0。
 * （同点数会重复出现的夹具——如 `[30, 30, 30]`——得到的是三个相等的对象，
 * 对 view.builder 的用途没有影响：它只数张数、只透传。）
 */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

/**
 * 手工构造一个会话，让每个座位的牌都不同，便于断言「只看到自己的」。
 *
 * ⚠️ **本文件不在 `tsc` 的 `include` 内**（`packages/game-service/tsconfig.json` 只收
 * `src/**`）⇒ 夹具的形状漂移**长期不可见**。R472 收口时实测它缺 `baseScore` /
 * `turnDeadlineAt`、多一个早已删除的 `deck`、`createdAt` 还是 `Date`；这里按 §3.2 补齐。
 */
function makeSession(over: Partial<GameSession> = {}): GameSession {
  const base: GameSession = {
    roomCode: 'ROOM01',
    gameType: 'doudizhu',
    playerCount: 3,
    baseScore: 100,
    state: GameState.Bidding,
    players: [
      { id: 'alice', seat: 0, hand: h(3, 4, 5), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      { id: 'bob', seat: 1, hand: h(6, 7, 8, 9), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      { id: 'carol', seat: 2, hand: h(10, 11), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
    ],
    bottomCards: h(12, 13, 14),
    currentPlayer: 0,
    lastPlayedHand: null,
    lastPlayerIdx: -1,
    turnDeadlineAt: 0,
    version: 7,
    actionLog: [
      { version: 6, seat: 0, cards: h(3, 4), kind: 'play' },
      { version: 7, seat: 1, cards: [], kind: 'pass' },
    ],
    bidPhase: {
      currentBidder: 1,
      landlordCaller: -1,
      landlordCandidate: -1,
      bidPasses: 0,
      grabActions: 2,
      bidMultiplier: 1,
      redealCount: 0,
      decisions: [],
      firstCaller: -1,
      antiRobGranted: false,
    },
    playPhase: { bombCount: 0, landlordPlays: 0, farmerPlays: 0, consecutivePasses: 0 },
    createdAt: 0,
    finishedAt: null,
  };
  return { ...base, ...over };
}

describe('buildPlayerView', () => {
  it('gives each seat only its own hand and the three card counts', () => {
    const session = makeSession();

    const alice = buildPlayerView(session, 0);
    const bob = buildPlayerView(session, 1);
    const carol = buildPlayerView(session, 2);

    expect(alice.hand).toEqual(h(3, 4, 5));
    expect(bob.hand).toEqual(h(6, 7, 8, 9));
    expect(carol.hand).toEqual(h(10, 11));

    for (const view of [alice, bob, carol]) {
      expect(view.cardCounts).toEqual([3, 4, 2]);
      expect(view.seat).toBeDefined();
      expect(view.version).toBe(7);
      expect(view.roomCode).toBe('ROOM01');
    }
  });

  /**
   * 2026-10-21：`createSession` 的缺省底分改为 0 哨兵（真实值由 `game.start` 写入）。
   * 出站视图校验是 0 哨兵的**第一道**响亮网（`validateOutbound` 要求 baseScore > 0）。
   */
  it('🔴 baseScore 0（未设置哨兵）⇒ 出站校验抛 ProtocolError', () => {
    expect(() => buildPlayerView(makeSession({ baseScore: 0 }), 0)).toThrow(ProtocolError);
  });

  it('never leaks other players hands, isRobot, botId, skillLevel or actionLog', () => {
    const session = makeSession({
      players: [
        { id: 'alice', seat: 0, hand: h(3), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        {
          id: 'p_12345678',
          seat: 1,
          hand: h(6, 7),
          isLandlord: false,
          isBot: true,
          isOffline: false,
          botId: 'bot-internal-uuid',
          skillLevel: 'advanced',
        } as never,
        { id: 'carol', seat: 2, hand: h(10), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      ],
      actionLog: [{ version: 1, seat: 0, cards: h(3), kind: 'play' }],
    } as never);

    const serialized = JSON.stringify(buildPlayerView(session, 0));
    expect(serialized).not.toContain('isRobot');
    expect(serialized).not.toContain('isBot');
    expect(serialized).not.toContain('botId');
    expect(serialized).not.toContain('skillLevel');
    expect(serialized).not.toContain('actionLog');
    expect(serialized).not.toContain('bot-internal-uuid');
    // 他人手牌的牌面不得出现
    expect(serialized).not.toContain('"6"');
  });

  it('hides the bottom cards during bidding and reveals them afterwards', () => {
    const bidding = makeSession({ state: GameState.Bidding });
    expect(buildPlayerView(bidding, 0).bottomCards).toBeNull();

    const playing = makeSession({ state: GameState.Playing });
    expect(buildPlayerView(playing, 0).bottomCards).toEqual(h(12, 13, 14));
  });

  it('reports landlordSeat as null until a landlord exists', () => {
    expect(buildPlayerView(makeSession(), 0).landlordSeat).toBeNull();
  });

  it('reports landlordSeat from the landlord flag when playing', () => {
    const session = makeSession({
      state: GameState.Playing,
      players: [
        { id: 'alice', seat: 0, hand: h(3), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'bob', seat: 1, hand: h(6), isLandlord: true, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'carol', seat: 2, hand: h(10), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      ],
    });
    expect(buildPlayerView(session, 0).landlordSeat).toBe(1);
  });

  // ❌ 旧用例（切片 8 删除）：'keeps the hand/cardCounts invariant by folding the bottom
  //    cards into the landlord hand' —— 它断言的是「补偿」本身（会话里地主 2 张、view 里 5 张）。
  //    C15 修好后这不再是真实形态，留着它等于把补偿锁死。

  it('地主手牌由会话自带（20 张），view.builder 不再并入底牌（C15 / R101）', () => {
    // ⚠️ 这是**真实形态**：`finalizeBidding()` 已经把底牌并进地主手牌，
    //    所以会话里就是 20 张。若 view.builder 还留着补偿，这里会得到 23 张 ⇒ 用例红。
    // ⚠️ 计划里的夹具写成 `[…, 14, 15, 16, 17, …]`，但 **15/16 不是合法的 DouZero 牌值**
    //    （DouZero 编码里「2」是 17；合法值是 3..14、17、20、30）——
    //    照抄会在 validateOutbound 的 assertCardArray 上抛 ProtocolError，测不到补偿这一层。
    const hand17 = h(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 17, 17, 20, 30);
    const session = makeSession({
      state: GameState.Playing,
      bottomCards: h(12, 13, 14),
      players: [
        { id: 'alice', seat: 0, hand: h(3, 4, 5), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        {
          id: 'bob',
          seat: 1,
          hand: [...hand17, ...h(12, 13, 14)].sort(compareCards), // 17 + 3 = 20
          isLandlord: true,
          isBot: false,
          isOffline: false,
          timeoutCount: 0,
          trustee: false,
        },
        { id: 'carol', seat: 2, hand: h(30, 30, 30), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      ],
    });

    const bob = buildPlayerView(session, 1);
    expect(bob.hand).toHaveLength(20);
    expect(bob.cardCounts[1]).toBe(20);
    expect(bob.hand.length).toBe(bob.cardCounts[bob.seat]); // 协议不变式（validate.ts:100）

    // 地主能完整看到底牌（§6.4：playing 后三家皆可见）
    for (const c of h(12, 13, 14)) expect(bob.hand).toContainEqual(c);
    expect(bob.bottomCards).toEqual(h(12, 13, 14));

    // 农民侧只看到张数，自己的手牌不受影响
    const alice = buildPlayerView(session, 0);
    expect(alice.hand).toEqual(h(3, 4, 5));
    expect(alice.cardCounts).toEqual([3, 20, 3]);
    expect(alice.bottomCards).toEqual(h(12, 13, 14));
  });

  it('底牌并入只发生一次：view.builder 不得对同一份会话重复并入（反向断言）', () => {    const session = makeSession({
      state: GameState.Playing,
      bottomCards: h(12, 13, 14),
      players: [
        { id: 'alice', seat: 0, hand: h(3), isLandlord: true, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'bob', seat: 1, hand: h(6), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'carol', seat: 2, hand: h(10), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      ],
    });

    const first = buildPlayerView(session, 0);
    const second = buildPlayerView(session, 0);
    // 两次调用必须逐字段相等 —— 旧实现的 `hand.push(...)` 会**修改会话对象**，
    // 第二次调用就变成 1 + 3 + 3 = 7 张（这正是「补偿」最阴的一面：它污染了真源）。
    expect(second.hand).toEqual(first.hand);
    expect(session.players[0]!.hand).toEqual(h(3));
    expect(first.hand).toEqual(h(3)); // 会话里没有底牌就是没有，view 不许凭空造
  });

  /**
   * R118：**牌堆守恒**。
   *
   * 为什么需要它：C15 的「三处同改」在门禁里原本**只有新增用例在守** ——
   * 实测发现「补偿二没删干净」会让地主 23 张，而旧实现的补偿在 `hand.push(...)` 之后
   * 又 `cardCounts[seat] = hand.length`，于是 `validate.ts:100` 的
   * `hand.length === cardCounts[seat]` 被**人为**满足（23 === 23），
   * 协议校验**不检查牌堆守恒** ⇒ 既有 61 条 game-service 用例一条也抓不到。
   *
   * ⚠️ **守恒式的正确写法**（写这条时踩过坑，记下来）：
   * C15 之后**底牌是地主手牌的一部分**（`finalizeBidding()` 已并入），所以
   * `sum(cardCounts)` 本身就已经把底牌算进去了 —— **不能再单独加一次 `bottomCards.length`**，
   * 那样会得到 54 + 3 = 57 这个假失败（实测撞到）。
   * 一局刚发完牌、一张未出时：`sum(cardCounts) === 54`；
   * 出牌过程中：`sum(cardCounts) + 已出张数 === 54`（底牌**不**参与）。
   */
  it('牌堆守恒：三家手牌之和 = 54（底牌已在地主手牌内，不再单独相加，R118）', () => {
    // 完整的 54 张：3..14 各 4 张、17（即「2」）×4、20（小王）×1、30（大王）×1
    // R696：这里用**真实花色**（同点数四张分属 0–3），不是统一取 0 ——
    // 这个用例断言「三家手牌之和 = 54」，只有 `(r, s)` 互不相同才真的等于一整副牌。
    const fullDeck = (): Card[] => {
      const cards: Card[] = [];
      for (let r = 3; r <= 14; r += 1) {
        for (let s = 0; s < 4; s += 1) cards.push({ r, s });
      }
      for (let s = 0; s < 4; s += 1) cards.push({ r: 17, s });
      cards.push({ r: 20, s: 4 }, { r: 30, s: 4 });
      return cards;
    };
    const deck = fullDeck();
    // 地主 20 张（含底牌）、两农民各 17 张 —— 与 `finalizeBidding()` 的真实形态一致
    const bottom = deck.slice(0, 3);
    const landlordHand = [...deck.slice(3, 20), ...bottom];
    const farmerA = deck.slice(20, 37);
    const farmerB = deck.slice(37, 54);

    const session = makeSession({
      state: GameState.Playing,
      bottomCards: bottom,
      players: [
        { id: 'alice', seat: 0, hand: landlordHand, isLandlord: true, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'bob', seat: 1, hand: farmerA, isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'carol', seat: 2, hand: farmerB, isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      ],
    });

    const view = buildPlayerView(session, 1);
    // 一张未出 ⇒ 三家手牌之和必须恰好是整副牌。底牌**已经**在地主 hand 里，故不另加。
    const sum = view.cardCounts.reduce((a, b) => a + b, 0);
    expect(sum).toBe(54);
    // 底牌仍然是地主手牌的子集（不是「另存一份」的副本）
    expect(view.bottomCards!.every((c) => session.players[0]!.hand.includes(c))).toBe(true);
    // 三家份额：地主 20、两农民各 17（份额与守恒正交，一并钉住真实形态）
    expect(view.cardCounts).toEqual([20, 17, 17]);
  });

  it('协议 ④：recentActions 是 actionLog 的窗口投影（旧 → 新、「不出」是显式 null）', () => {
    // 夹具的 actionLog 恰好是「座位 0 出一手 + 座位 1 过牌」⇒ 投影照着它写。
    const session = makeSession({ state: GameState.Playing });

    const view = buildPlayerView(session, 0);
    expect(view.recentActions).toEqual([
      { seat: 0, cards: h(3, 4) },
      { seat: 1, cards: null }, // pass ⇒ 显式 null（不是 []）
    ]);

    // ⚠️ **成对迁移**（本片 §1 判据账）：两条退役字段**不得**再出现在出站视图上，
    //    且它们的**同形键**不许以任何形式回来（防止「并存一段时间」的漂移）。
    expect('lastPlayedHand' in view).toBe(false);
    expect('lastPlayerIdx' in view).toBe(false);
  });

  it('协议 ④：窗口只留最后两手（更早的动作被挤掉）', () => {
    const session = makeSession({
      state: GameState.Playing,
      actionLog: [
        { version: 4, seat: 0, cards: h(3), kind: 'play' },
        { version: 5, seat: 1, cards: [], kind: 'pass' },
        { version: 6, seat: 2, cards: h(9), kind: 'play' },
        { version: 7, seat: 0, cards: [], kind: 'pass' },
      ],
    });

    expect(buildPlayerView(session, 0).recentActions).toEqual([
      { seat: 2, cards: h(9) },
      { seat: 0, cards: null },
    ]);
  });

  /**
   * 协议 ④ 的**等价迁移**（原 C19 的在线口径）：`type` / `keyRank` / `length` 这三个**规则字段**
   * 协议 ④ 之后**不再出站** —— 它们只活在 `GameSession.lastPlayedHand` →（`features.ts` 投影）
   * `RobotFeatures.lastMoveMeta` 这条**内部 RPC** 上（Task A3），而 conformance 走的是客户端
   * WS 面 ⇒ 那条在线判据**没有输入**了（`checkSingleCaliber` 已随 Task A4 重写为
   * `checkRecentWindow`，只比对牌面）。本用例把搬走的那半条口径钉在这里：
   *  ① 规则字段（`type` / `keyRank` / `length`）**留在服务端**——那是跟牌判定的输入；
   *  ② 线格式（`recentActions`）**只剩牌面**——三个规则字段一个都不出站。
   *
   * 🔴 **等价判据在「这里」，而且必须走生产代码**：本用例的上一版是「往会话里塞一个
   * `lastPlayedHand` 字面量、再断言那个字面量」—— `makeSession` 是 `{...base, ...over}`
   * ⇒ 那测的是**对象展开**，是一条**恒真断言**（唯一能让它红的变异只有「`buildPlayerView`
   * 反过来去改会话的规则字段」这种很窄的情形）。现在两端都是被测实现的产物：状态转移由
   * `handlePlayCards()` 跑、出站投影由 `buildPlayerView()` 跑；把 `lastPlayedHand` 的写入
   * 去掉、写错 `keyRank`/`length`，或让投影漏出规则字段，都会在这里红。
   */
  it('协议④ 等价迁移：单张的规则字段（type/keyRank/length）留在服务端、线格式只剩牌面（原 C19 的在线口径）', () => {
    // ⚠️ **夹具钉死三家手牌**（不用 `dealCards()`：它随机洗牌，按具体牌值断言会 flaky）；
    //    基线是「首出」形态（`lastPlayedHand: null` / `lastPlayerIdx: -1`）⇒ 单张 5 必然合法；
    //    `actionLog: []` ⇒ 窗口起点为空，② 才能断言「窗口**恰好**是这一手」。
    const session = makeSession({
      state: GameState.Playing,
      currentPlayer: 0,
      actionLog: [],
      players: [
        { id: 'alice', seat: 0, hand: h(5, 6), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'bob', seat: 1, hand: h(6), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'carol', seat: 2, hand: h(8), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      ],
    });

    // **真**状态转移：`handlePlayCards`（shared `ddz/play.ts`）是 `lastPlayedHand` 的唯一写入点。
    const next = handlePlayCards(session, 'alice', h(5));

    // ① 规则字段**留在服务端**（跟牌判定的输入、`RobotFeatures.lastMoveMeta` 的真源）。
    expect(next.lastPlayedHand!.type).toBe(HandType.Single);
    expect(next.lastPlayedHand!.keyRank).toBe(5);
    expect(next.lastPlayedHand!.length).toBe(0);
    // ② 线格式**只剩牌面**（协议 ④）：逐字等于这一手，三个规则字段一个都不在。
    expect(buildPlayerView(next, 1).recentActions).toEqual([{ seat: 0, cards: h(5) }]);
  });

  /**
   * ⚠️ **已随协议 ④ 删除**（成对迁移的另一半）：原先这里有一条「连对的 `length` 是组数 3
   * 而不是 6 张（C20）」的用例 —— 它断言的是 `view.lastPlayedHand.length` 的透传，
   * 而跟牌目标（`type`/`keyRank`/`length`）**已不在出站面上**（规则态留在服务端）。
   * **原性质仍在守**：`shared/ddz/play.test.ts` 的
   * 「连对的 lastPlayedHand.length 取对子组数 3，而不是 6 张（C20/R157）」盯着会话侧的同一条事实。
   */

  it('exposes bidPhase.currentBidder as the bid-phase actor', () => {
    const view = buildPlayerView(makeSession(), 0);
    expect(view.bidPhase.currentBidder).toBe(1);
    expect(view.bidPhase.grabActions).toBe(2);
  });

  /**
   * 🔴 子层键集**穷尽**判据（片① §5.4）：`PlayerView.bidPhase` 的键集**恰为**契约的 7 个键。
   *
   * 为什么需要它 —— 三道既有闸对**子键**全都盲（片① Task 1 给会话加了两个内部字段
   * `firstCaller` / `antiRobGranted`，它们**永不出站**）：
   *  ① `FORBIDDEN_OUTBOUND_KEYS`（`protocol/src/validate.ts:37-44`）**不含**这两个字段；
   *  ② `assertNoLeak` 只认那个黑名单 ⇒ 抓不到它们；
   *  ③ 顶层键集穷尽判据（`game.controller.test.ts` 的 N6）只钉 `Object.keys(view)` ——
   *     而 `bidPhase` 作为顶层的一个键**始终在场**，子键换血它一无所知。
   * ⇒ 若有人把 `bidPhase: { ...session.bidPhase, kind: ... }` 整块展开，`firstCaller` /
   * `antiRobGranted`（以及 `bidPasses` / `landlordCaller`）会**原样出站**，而三闸全绿。
   * **只有下面这条能抓。**
   *
   * 期望值 = **实测契约**：本用例落地时先跑一次打印 `Object.keys(view.bidPhase).sort()`
   * 并原样粘入（不是照 §5.3 的字段清单猜的）。若 `firstCaller` / `antiRobGranted` 出现在
   * 打印结果里，那是**缺陷**（视图被整块展开），不是「期望值要更新」。
   *
   * 变异自证（本用例落地时做过）：把 `view.builder.ts` 的 `bidPhase` 构造改成
   * `{ ...session.bidPhase, kind: bidKindOf(...) }` ⇒ 本用例**红**（多出 4 个内部键），
   * 其余闸（validateOutbound / assertNoLeak / 顶层键集）**全绿** ⇒ 证明这条闸是唯一拦截者。
   */
  it('🔴 PlayerView.bidPhase 的键集**恰为**契约集合（穷尽）—— 内部字段不得出站', () => {
    const view = buildPlayerView(makeSession(), 0);
    expect(Object.keys(view.bidPhase).sort()).toEqual([
      'bidMultiplier',
      'currentBidder',
      'decisions',
      'grabActions',
      'kind',
      'landlordCandidate',
      'redealCount',
    ]);
  });

  it('carries turnDeadlineAt through', () => {
    const view = buildPlayerView(makeSession({ turnDeadlineAt: 1_700_000_000_000 }), 0);
    expect(view.turnDeadlineAt).toBe(1_700_000_000_000);
  });

  it('passes the winner through when the game has ended', () => {
    const view = buildPlayerView(makeSession({ state: GameState.Ended, winner: 'farmer' }), 0);
    expect(view.winner).toBe('farmer');
  });

  it('omits winner while the game is running', () => {
    expect('winner' in buildPlayerView(makeSession(), 0)).toBe(false);
  });

  it('rejects an out-of-range seat instead of producing an invalid view', () => {
    for (const seat of [-1, 3, 1.5, Number.NaN]) {
      expect(() => buildPlayerView(makeSession(), seat)).toThrow(/seat must be 0, 1 or 2/);
    }
  });

  it('throws a ProtocolError when a hand contains an invalid DouZero card', () => {
    const session = makeSession({
      players: [
        { id: 'alice', seat: 0, hand: h(99), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'bob', seat: 1, hand: [], isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'carol', seat: 2, hand: [], isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      ],
    });
    expect(() => buildPlayerView(session, 0)).toThrow(ProtocolError);
  });

  /**
   * 挂机治理 T3：`trustees` 的**唯一生产写入点**（规格 C5 / C23 的 view 半边）。
   *  - 按座位数组（照 `cardCounts` 先例），三家看到的数组相同；
   *  - **机器人座位恒 false**：判定按 `botIds` 的**座位下标**，⛔ 不按 `p.id`
   *    （`GamePlayer.id` 是对外 displayId、与 botId 恒不相等——用 id 比的实现会在这里红）。
   */
  describe('挂机治理：PlayerView.trustees（T3 生产）', () => {
    it('按座位透传人类玩家的 trustee 标记（恰三元）', () => {
      const session = makeSession({
        players: [
          { id: 'alice', seat: 0, hand: h(3), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
          { id: 'bob', seat: 1, hand: h(6, 7), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 3, trustee: true },
          { id: 'carol', seat: 2, hand: h(10), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        ],
      });

      for (const seat of [0, 1, 2]) {
        const view = buildPlayerView(session, seat);
        expect(view.trustees).toEqual([false, true, false]);
        expect(view.trustees).toHaveLength(3);
      }
    });

    it('机器人座位恒 false —— 即使会话里被置了 trustee（按 botIds 座位下标判，不按 id）', () => {
      const session = makeSession({
        players: [
          { id: 'alice', seat: 0, hand: h(3), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: true },
          // 生产形态：displayId（p_…）与 botId（内部 uuid）恒不相等；isBot 恒 false。
          { id: 'p_12345678', seat: 1, hand: h(6), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: true },
          { id: 'carol', seat: 2, hand: h(10), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: true },
        ],
        botIds: [undefined, 'bot-internal-uuid', undefined],
      });

      expect(buildPlayerView(session, 0).trustees).toEqual([true, false, true]);
    });

    it('view 过得了 assertPlayerView（validateOutbound）；坏 trustees 形状被拒（判别力）', () => {
      const view = buildPlayerView(makeSession(), 0);
      // buildPlayerView 内部已过 validateOutbound（→ assertPlayerView）；这里再显式走一次。
      expect(() =>
        validateOutbound({ type: 'game.state_update', version: view.version, payload: view }),
      ).not.toThrow();
      // 负对照：坏形状确实会被拦（证明上一条不是空转）。
      expect(() =>
        validateOutbound({
          type: 'game.state_update',
          version: view.version,
          payload: { ...view, trustees: [false, true] },
        }),
      ).toThrow(/trustees/);
    });
  });
});

describe('buildAllSeatViews', () => {
  it('produces one view per seat with the shared version', () => {
    const views = buildAllSeatViews(makeSession());
    expect(views).toHaveLength(3);
    expect(views.map((v) => v.seat)).toEqual([0, 1, 2]);
    expect(new Set(views.map((v) => v.version))).toEqual(new Set([7]));
  });
});

describe('findSeatByUserId', () => {
  it('maps the gateway-injected user id to a seat', () => {
    expect(findSeatByUserId(makeSession(), 'bob')).toBe(1);
  });

  it('returns -1 for a user that is not in the session (→ 12004)', () => {
    expect(findSeatByUserId(makeSession(), 'mallory')).toBe(-1);
  });
});

describe('remainingTurnMs', () => {
  it('falls back to a full turn when no deadline is set', () => {
    expect(remainingTurnMs(makeSession(), 1000)).toBe(TURN_TIMEOUT_MS);
  });

  it('never returns a negative remaining time', () => {
    expect(remainingTurnMs(makeSession({ turnDeadlineAt: 1000 }), 5000)).toBe(0);
  });

  it('returns the time left until the deadline', () => {
    expect(remainingTurnMs(makeSession({ turnDeadlineAt: 31_000 }), 1000)).toBe(30_000);
  });
});

/**
 * C8 / R205 + §6.4：`actionLog` **永不出站**。
 *
 * 双层判据（R213）：
 *  ① `assertNoLeak(view)` —— 裁剪视图里**没有** `actionLog` 这个键；
 *  ② `validateOutbound` —— 即使有人把它塞进载荷，契约校验器也**当场拦下**（负对照）。
 * 只做 ① 是不够的：它只证明「今天没写」，证明不了「写了会被拦」。
 */
describe('actionLog 永不出站（C8/R205）', () => {
  it('① 裁剪视图里没有 actionLog，且过得了 assertNoLeak', () => {
    const session = makeSession();
    for (const seat of [0, 1, 2]) {
      const view = buildPlayerView(session, seat);
      expect(Object.keys(view)).not.toContain('actionLog');
      expect(() => assertNoLeak(view)).not.toThrow();
    }
  });

  it('② 负对照：把 actionLog 塞进出站载荷 ⇒ validateOutbound 当场拦下', () => {
    const view = buildPlayerView(makeSession(), 0);
    expect(() =>
      validateOutbound({
        type: 'game.state_update',
        version: view.version,
        payload: { ...view, actionLog: [{ version: 1, seat: 0, cards: h(3), kind: 'play' }] },
      }),
    ).toThrow(/actionLog/);
  });
});

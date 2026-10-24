import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handlePlayCards, handlePass, handlePlayTimeout, checkWinCondition, assertPlayInvariants } from './play';
import { GameState } from './types';
import { createSession, dealCards } from './game';
import { HandType } from '../rule/rule';
import type { Card } from '@fight-the-landlord/protocol';
import { Rank } from '../card/card';

/**
 * R696：牌是 `{r, s}`。
 *
 * ⚠️ **花色统一取 0，不按位置轮换**：本文件的夹具里，手牌与打出的牌是**独立构造**的。
 * 若两边花色赋值不一致（手牌 `{5,2}`、打的 `{5,0}`），`handlePlayCards` 的
 * **精确摘除**会找不到牌而误报「不在手里」。统一取 0 时同点数的牌在两边完全相等，
 * 逐张摘除即可；而「手里只有一张却送两张」仍会被正确拒绝。
 * （「同点数**不同花色**的牌不在手里 ⇒ 拒」需要不同花色，属 game-service 层的用例。）
 */
const h = (...ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

/**
 * C5/R204 的 spy 缝：`play.ts` 内部**相对导入** `../rule/autoplay`，
 * 因此替身必须 mock 这个**相对路径**（mock 按模块解析图生效；mock
 * `@fight-the-landlord/shared` 的桶文件**拦不住** play.ts 的这条内部导入）。
 *
 * 默认透传真实实现（其余用例不受影响）；用例可用 `engine.mockImplementation(...)`
 * 接管返回值来证明「实现确实采用了引擎的返回值」。
 */
const { engine } = vi.hoisted(() => ({ engine: vi.fn() }));
vi.mock('../rule/autoplay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rule/autoplay')>();
  const spied = ((hand: unknown, target: unknown) => {
    // 无论是否被用例接管，都**经过 `engine`**（否则「被调用」这条断言会假绿）
    const result = engine(hand, target);
    if (engine.getMockImplementation()) return result;
    return actual.findSmallestBeatingCards(hand as never, target as never);
  }) as typeof actual.findSmallestBeatingCards;
  return { ...actual, findSmallestBeatingCards: spied };
});

describe('handlePlayCards', () => {
  let session: ReturnType<typeof dealCards>;

  beforeEach(() => {
    const created = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    session = dealCards(created);
  });

  it('throws when game is not in playing state', () => {
    expect(() => handlePlayCards(session, 'user-1', h(1))).toThrow('not in playing state');
  });

  it('throws when player not found', () => {
    const playingSession = { ...session, state: GameState.Playing };
    expect(() => handlePlayCards(playingSession, 'unknown', h(1))).toThrow('not found');
  });

  it('throws when not current player turn', () => {
    const playingSession = { ...session, state: GameState.Playing, currentPlayer: 1 };
    expect(() => handlePlayCards(playingSession, 'user-1', h(1))).toThrow('Not your turn');
  });

  /**
   * C19 / R158 的**唯一**判别形态：同点数的「2」不能互相压过。
   *
   * ⚠️ **R695 之后 C19 在结构上已不可能**（成因是双编码：待出牌把 DouZero 当 `Rank` 用
   * `2` → 17，而上一手经 `douzeroIntToCard` 还原成内部 Rank `2` → 15，于是 `17 > 15` 为真）。
   * 全系统只剩 DouZero 一套编码 ⇒ **没有「还原」这一步可以忘**。
   * 本用例保留为**行为判据**：它仍然钉住「同点数的 2 压不过 2」这个语义，
   * 换了实现之后依然必须成立 —— 只是它不再是双编码的判别器了。
   */
  it('同点数的 2 不能压过上一手的 2（C19/R158）', () => {
    const base = {
      ...session,
      state: GameState.Playing,
      currentPlayer: 1,
      lastPlayerIdx: 0,
      lastPlayedHand: { cards: h(17), type: HandType.Single, keyRank: 17, length: 0 },
      players: session.players.map((p, idx) => ({
        ...p,
        hand: idx === 1 ? h(17, 3) : p.hand,
        isLandlord: idx === 0,
      })),
    };
    expect(() => handlePlayCards(base, 'user-2', h(17))).toThrow('cannot beat');
  });

  /** 正对照：A（14）**不能**压 2（17），而 2（17）能压 A（14）—— 证明上面那条不是「什么都拒绝」。 */
  it('单张比较用 DouZero 编码：A 压不过 2，2 压得过 A（C19/R158）', () => {
    const mk = (lastCards: Card[], lastKeyRank: number, hand: Card[]) => ({
      ...session,
      state: GameState.Playing,
      currentPlayer: 1,
      lastPlayerIdx: 0,
      lastPlayedHand: { cards: lastCards, type: HandType.Single, keyRank: lastKeyRank, length: 0 },
      players: session.players.map((p, idx) => ({
        ...p,
        hand: idx === 1 ? hand : p.hand,
        isLandlord: idx === 0,
      })),
    });
    expect(() => handlePlayCards(mk(h(17), 17, h(14)), 'user-2', h(14))).toThrow('cannot beat');
    expect(handlePlayCards(mk(h(14), 14, h(17)), 'user-2', h(17)).lastPlayedHand!.keyRank).toBe(17);
  });

  /**
   * C20 / R157：`lastPlayedHand` 记录的是**契约字段**，`length` 按 §4.1 单位。
   * 连对取「对子组数」= 3（**不是** 6 张）。
   */
  it('连对的 lastPlayedHand.length 取对子组数 3，而不是 6 张（C20/R157）', () => {
    const player1Hand = h(3, 3, 4, 4, 5, 5, 6);
    const next = handlePlayCards(
      {
        ...session,
        state: GameState.Playing,
        currentPlayer: 1,
        lastPlayerIdx: -1,
        lastPlayedHand: null,
        players: session.players.map((p, idx) => ({
          ...p,
          hand: idx === 1 ? player1Hand : p.hand,
          isLandlord: idx === 0,
        })),
      },
      'user-2',
      h(3, 3, 4, 4, 5, 5),
    );
    expect(next.lastPlayedHand).toEqual({
      cards: h(3, 3, 4, 4, 5, 5),
      type: HandType.PairStraight,
      keyRank: 3,
      length: 3,
    });
  });

  /**
   * C6 / R203：`parseHand` 对非法牌型返回 `HandType.Invalid`（不再抛错）之后，
   * **拒绝动作的责任在 `handlePlayCards`**，且**文案逐字不变** `不支持的牌型: …`
   * —— N2 的覆盖闸与 `SPEC_ROWS` 规格闸都靠它映射到 `13006`（§11.1）。
   *
   * 旧实现下这句是从 `parseHand` 内部抛出的；若不显式拒绝，非法牌型会一路走到
   * `canBeat` 并被判成「压不过上一手」（另一条文案），§11.1 的逐因映射随之出错。
   */
  it('非法牌型 ⇒ 显式拒绝，文案逐字 `不支持的牌型`（C6/R203）', () => {
    const base = {
      ...session,
      state: GameState.Playing,
      currentPlayer: 1,
      lastPlayerIdx: -1,
      lastPlayedHand: null,
      players: session.players.map((p, idx) => ({
        ...p,
        hand: idx === 1 ? h(3, 4) : p.hand,
        isLandlord: idx === 0,
      })),
    };
    expect(() => handlePlayCards(base, 'user-2', h(3, 4))).toThrow('不支持的牌型');
  });

  /**
   * **R697 的三条正负对照**（spec §9.3 逐字要求）。
   *
   * ⚠️ 这三条**必须用显式花色**（`cs([[r, s], …])`），不能用本文件通行的 `h()`
   * —— `h()` 把花色统一取 0，同点数的牌在两边完全相等，「同点数不同花色」这种输入
   * **根本构造不出来**，三条里有两会退化成恒绿。
   */
  describe('R697：按身份精确摘除', () => {
    /** 带显式花色的夹具。 */
    const cs = (...pairs: Array<[number, number]>): Card[] => pairs.map(([r, s]) => ({ r, s }));

    const playingWith = (hand: Card[]) => ({
      ...session,
      state: GameState.Playing,
      currentPlayer: 1,
      lastPlayerIdx: -1,
      lastPlayedHand: null,
      players: session.players.map((p, idx) => ({
        ...p,
        hand: idx === 1 ? hand : p.hand,
        isLandlord: idx === 0,
      })),
    });

    it('① 送一张 `(r,s)` **不在手里**的牌（同点数、不同花色）⇒ 拒', () => {
      // 手里是 ♠5（s=0）与 ♠6；送 ♦5（s=3）—— 点数对、花色不对
      const s = playingWith(cs([5, 0], [6, 0]));
      expect(() => handlePlayCards(s, 'user-2', cs([5, 3]))).toThrow(/not in hand/);
    });

    it('② 送**两张完全相同**的 `(r,s)`（手里有同点数的**两张不同花色**）⇒ 拒', () => {
      // ⚠️ 夹具必须是「手里有两张 5、花色不同」——
      //    若手里只有一张 5，按点数摘也会在第二次耗尽而拒 ⇒ 两种语义**都通过**，
      //    这条就没有判别力（实测：变异为按点数摘时它**不会红**）。
      //    手里有两张 5 时，按点数摘会**错误接受**，性状才区分得开。
      const s = playingWith(cs([5, 0], [5, 1], [6, 0]));
      expect(() => handlePlayCards(s, 'user-2', cs([5, 0], [5, 0]))).toThrow(/not in hand/);
    });

    it('③ 合法的「两张同点数、不同花色」⇒ 接受，且手牌**精确减少两张**', () => {
      const s = playingWith(cs([5, 0], [5, 3], [6, 0]));
      const next = handlePlayCards(s, 'user-2', cs([5, 0], [5, 3]));
      // 必须是**恰好**剩 ♠6 —— 只判 `length === 1` 证明不了「摘对了哪两张」
      expect(next.players[1]!.hand).toEqual(cs([6, 0]));
    });
  });

  /**
   * §3.2 / R205：`handlePlayCards` 在**每次**状态转移里追加一条 `actionLog`
   * （`kind: 'play'`，`cards` 为打出的牌，`version` 是**转移之后**的版本号）。
   */
  it('每次出牌都追加 actionLog（§3.2/R205）', () => {
    const next = handlePlayCards(
      {
        ...session,
        state: GameState.Playing,
        currentPlayer: 1,
        lastPlayerIdx: -1,
        lastPlayedHand: null,
        players: session.players.map((p, idx) => ({
          ...p,
          hand: idx === 1 ? h(3, 3, 4, 4, 5, 5) : p.hand,
          isLandlord: idx === 0,
        })),
      },
      'user-2',
      h(3, 3, 4, 4, 5, 5),
    );

    expect(next.actionLog).toHaveLength(1);
    expect(next.actionLog[0]).toEqual({
      version: next.version,
      seat: 1,
      cards: h(3, 3, 4, 4, 5, 5),
      kind: 'play',
    });
  });
});

describe('handlePass', () => {
  let playingSession: ReturnType<typeof dealCards>;

  beforeEach(() => {
    const created = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(created);
    playingSession = {
      ...dealt,
      state: GameState.Playing,
      players: dealt.players.map(p => ({ ...p, isLandlord: p.seat === 0 })),
      currentPlayer: 1, // user-2 is at index 1
      lastPlayedHand: { cards: h(20), type: HandType.Single, keyRank: 20, length: 0 },
      lastPlayerIdx: 0, // user-1 last played
    };
  });

  it('throws when game is not in playing state', () => {
    const nonPlayingSession = { ...playingSession, state: GameState.Init };
    expect(() => handlePass(nonPlayingSession, 'user-2')).toThrow('not in playing state');
  });

  it('throws when player not found', () => {
    expect(() => handlePass(playingSession, 'unknown')).toThrow('not found');
  });

  it('throws when not current player turn', () => {
    expect(() => handlePass(playingSession, 'user-1')).toThrow('Not your turn');
  });

  it('throws when trying to pass after last played', () => {
    const passSession = { ...playingSession, lastPlayerIdx: 1 };
    expect(() => handlePass(passSession, 'user-2')).toThrow('Cannot pass when you last played');
  });

  it('increments consecutivePasses', () => {
    const result = handlePass(playingSession, 'user-2');
    expect(result.playPhase.consecutivePasses).toBe(1);
    expect(result.currentPlayer).toBe(2);
  });

  it('resets after 2 consecutive passes', () => {
    // player 0 (landlord) last played, player 1 passes, player 2 passes -> player 0 gets turn again
    let s = handlePass(playingSession, 'user-2');
    s = handlePass(s, 'user-3');
    expect(s.playPhase.consecutivePasses).toBe(0);
    expect(s.lastPlayedHand).toBeNull();
    expect(s.lastPlayerIdx).toBe(0); // player 0 (user-1, landlord) still last played a hand
    expect(s.currentPlayer).toBe(0); // player 0 gets turn again
  });

  it('increments version', () => {
    const before = playingSession.version;
    const result = handlePass(playingSession, 'user-2');
    expect(result.version).toBe(before + 1);
  });

  it('does not mutate input', () => {
    const before = playingSession.version;
    handlePass(playingSession, 'user-2');
    expect(playingSession.version).toBe(before);
  });

  /** C18 / §6.2-2：首出（`lastPlayedHand === null`）时任何人都不能过牌。 */
  it('首出时不能过牌（C18/§6.2-2）', () => {
    const opening = { ...playingSession, lastPlayedHand: null, lastPlayerIdx: -1 };
    expect(() => handlePass(opening, 'user-2')).toThrow('Cannot pass on the opening lead');
  });

  /** §6.2 的第 2、3 条缺一不可：第 3 条单独存在时，开局 `lastPlayerIdx === -1` 会让约束对所有人失效。 */
  it('首出且自己就是 lastPlayerIdx 时，命中的是「首出」而不是「最后出牌者」（顺序固定，R159）', () => {
    const opening = { ...playingSession, lastPlayedHand: null, lastPlayerIdx: 1 };
    expect(() => handlePass(opening, 'user-2')).toThrow('Cannot pass on the opening lead');
  });

  /** R160：不变式 1 —— `currentPlayer === lastPlayerIdx` 时不得再有 `lastPlayedHand`。 */
  it('assertPlayInvariants 拦住 currentPlayer === lastPlayerIdx 且 lastPlayedHand !== null 的坏状态（R160）', () => {
    const broken = { ...playingSession, currentPlayer: 1, lastPlayerIdx: 1 };
    expect(() => assertPlayInvariants(broken)).toThrow('invariant violated');
    // 负对照：正常形态（两家过牌后回到最后出牌者）**不**违反不变式
    expect(() =>
      assertPlayInvariants({ ...playingSession, lastPlayedHand: null, currentPlayer: 0, lastPlayerIdx: 0,
        playPhase: { ...playingSession.playPhase, consecutivePasses: 0 } }),
    ).not.toThrow();
  });
});

describe('checkWinCondition', () => {
  it('returns landlord when landlord has no cards', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);
    const winner = checkWinCondition({
      ...dealt,
      state: GameState.Playing,
      players: dealt.players.map((p, idx) => ({
        ...p,
        hand: idx === 0 ? [] : h(1, 2, 3),
        isLandlord: idx === 0,
      })),
    });
    expect(winner).toBe('landlord');
  });

  /**
   * C16 / §7：农民是**团队**，**任一**农民出完牌即农民方获胜。
   * 夹具刻意只清空**一名**农民的手牌 —— 旧实现 `farmers.every(...)` 在这条输入下
   * 返回 `null`（对局不结束 ⇒ 正常对局路径必然卡死），因此它有判别力。
   */
  it('returns farmer when ANY one farmer has no cards (C16)', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);
    const winner = checkWinCondition({
      ...dealt,
      state: GameState.Playing,
      players: dealt.players.map((p, idx) => ({
        ...p,
        hand: idx === 1 ? [] : h(1, 2, 3), // 只有座位 1（农民）出完了
        isLandlord: idx === 0,
      })),
    });
    expect(winner).toBe('farmer');
  });

  /** 负对照：地主与两名农民都有牌 ⇒ 未结束。 */
  it('returns null while nobody has emptied their hand', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);
    expect(
      checkWinCondition({
        ...dealt,
        state: GameState.Playing,
        players: dealt.players.map((p, idx) => ({ ...p, hand: h(1, 2, 3), isLandlord: idx === 0 })),
      }),
    ).toBeNull();
  });
});

describe('handlePlayTimeout（玩法 §9.1 的出牌超时）', () => {
  const playing = () => {
    const dealt = dealCards(createSession('ROOM1', ['user-1', 'user-2', 'user-3']));
    return {
      ...dealt,
      state: GameState.Playing,
      players: dealt.players.map((p, idx) => ({ ...p, isLandlord: idx === 0 })),
    };
  };

  it('过牌也追加 actionLog（kind=pass、cards=[]，§3.2/R205）', () => {
    const s = {
      ...playing(),
      currentPlayer: 0,
      lastPlayerIdx: 2,
      lastPlayedHand: { cards: h(7), type: HandType.Single, keyRank: 7, length: 0 },
      actionLog: [],
    };
    const next = handlePass(s, 'user-1');
    expect(next.actionLog).toEqual([{ version: next.version, seat: 0, cards: [], kind: 'pass' }]);
  });

  it('首出超时 ⇒ 打手牌中点数最小的单张（§9.1 首出分支）', () => {
    const s = { ...playing(), currentPlayer: 1, lastPlayedHand: null, lastPlayerIdx: -1 };
    const hand = h(20, 3, 30, 17);
    const withHand = { ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, hand } : p)) };

    const next = handlePlayTimeout(withHand, 'user-2');

    expect(next.lastPlayedHand).toEqual({ cards: h(3), type: HandType.Single, keyRank: 3, length: 0 });
    expect(next.players[1]!.hand).toEqual(h(20, 30, 17));
    expect(next.version).toBe(withHand.version + 1);
  });

  /** 一墩回到最后出牌者（`lastPlayedHand === null`）时，过牌非法 ⇒ 同样打最小单张。 */
  it('两家过牌后回到最后出牌者，超时也打最小单张（§9.1 的「为什么必须有首出分支」）', () => {
    const s = { ...playing(), currentPlayer: 0, lastPlayedHand: null, lastPlayerIdx: 0 };
    const withHand = {
      ...s,
      players: s.players.map((p, i) => (i === 0 ? { ...p, hand: h(20, 3) } : p)),
    };

    expect(handlePlayTimeout(withHand, 'user-1').lastPlayedHand!.cards).toEqual(h(3));
  });

  /**
   * §9.1 的**跟牌**分支（① 同型最小可压 / ② 最小炸弹 / ③ 王炸 / ④ 过牌）。
   *
   * ⚠️ 切片 9 的旧行为是「能过牌就过牌」——那是**白送回合**：明明有牌可压却不出。
   * 下面第 ①、② 条在旧实现下必红（打出的 `lastPlayedHand` 仍是上一手牌、只 +1 次 pass）。
   */
  /**
   * 构造「跟牌」局面：座位 2 出了 `last` ⇒ 座位 0 是行动者（`(2+1)%3`）。
   *
   * ⚠️ 行动者**必须**是最后出牌者的下家：否则单次过牌会把 `currentPlayer` 推到
   * `lastPlayerIdx`，当场违反 §6.3 不变式 1（夹具自己造出来的非法状态）。
   */
  function following(opts: { hand: Card[]; last: { cards: Card[]; type: HandType; keyRank: number; length: number } }) {
    const s = { ...playing(), currentPlayer: 0, lastPlayerIdx: 2, lastPlayedHand: opts.last };
    return { ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, hand: opts.hand } : p)) };
  }

  it('① 跟单张超时 ⇒ 打**最小可压**单张（旧行为是过牌 ⇒ RED）', () => {
    const s = following({ hand: h(5, 6, 9), last: { cards: h(7), type: HandType.Single, keyRank: 7, length: 0 } });

    const next = handlePlayTimeout(s, 'user-1');

    expect(next.lastPlayedHand!.cards).toEqual(h(9));
    expect(next.lastPlayedHand!.type).toBe(HandType.Single);
    expect(next.players[0]!.hand).toEqual(h(5, 6));
    expect(next.playPhase.consecutivePasses).toBe(0); // **不是**过牌
  });

  it('② 跟顺子超时 ⇒ 打**同长度**的最小顺子（旧实现 7 型无解 ⇒ 只能过牌/甩炸弹）', () => {
    // 上一手：3-4-5-6-7（length=5）。手牌里能压的同长顺子最小是 4-5-6-7-8。
    const s = following({
      hand: h(3, 4, 5, 6, 7, 8, 9, 10, 11, 12),
      last: { cards: h(3, 4, 5, 6, 7), type: HandType.Straight, keyRank: 3, length: 5 },
    });

    const next = handlePlayTimeout(s, 'user-1');

    expect(next.lastPlayedHand!.cards).toEqual(h(4, 5, 6, 7, 8));
    expect(next.lastPlayedHand!.type).toBe(HandType.Straight);
  });

  it('③ 无可压 ⇒ 过牌（§9.1 第 ④ 步）；正对照见上方 ①（可压时必须 play）', () => {
    // 上一手是单张 2（R695：DouZero 编码 17）：手里既没有更大的单张、也没有炸弹/王炸
    const s = following({ hand: h(3, 4, 5), last: { cards: h(17), type: HandType.Single, keyRank: 17, length: 0 } });

    const next = handlePlayTimeout(s, 'user-1');

    expect(next.playPhase.consecutivePasses).toBe(1);
    expect(next.currentPlayer).toBe(1);
    expect(next.lastPlayedHand!.cards).toEqual(h(17)); // 过牌不清空上一手
    expect(next.players[0]!.hand).toEqual(h(3, 4, 5)); // 一张都没出
  });

  it('⑤ 面对**王炸** ⇒ 只能过牌，不得甩炸弹（超时路径不得吃到非法动作）', () => {
    const s = following({
      hand: h(3, 3, 3, 3), // 四条 3：合法动作里**没有**任何能压王炸的（引擎面对王炸返回 null）
      last: { cards: h(20, 30), type: HandType.Rocket, keyRank: 30, length: 0 },
    });

    const next = handlePlayTimeout(s, 'user-1');

    expect(next.playPhase.consecutivePasses).toBe(1);
    expect(next.players[0]!.hand).toEqual(h(3, 3, 3, 3)); // 炸弹没被甩出去
  });

  /** R106 的 `catch` 路径要靠一个**不可能状态**来覆盖：currentPlayer 手牌为空但 state 仍是 playing。 */
  it('手牌为空时报错（不可能状态），交给调用方记 error 并重挂计时器', () => {
    const s = { ...playing(), currentPlayer: 1, lastPlayedHand: null, lastPlayerIdx: -1 };
    const withHand = { ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, hand: [] } : p)) };
    expect(() => handlePlayTimeout(withHand, 'user-2')).toThrow('has no card to play');
  });

  /**
   * C5 收口（R204）：首出分支**必须**由规则引擎给出，且**采用它的返回值**。
   *
   * 为什么需要这条：上面两条判据只断言「结果是最小单张」，而那个结果**两种实现都能满足**
   * —— 旧实现自带一个 `reduce` 取最小的循环。只有「引擎被调用 **且** 它的返回值就是
   * 打出的牌」才证明 §9.1 的首出分支确实是**引擎在负责**（C5 的「规则引擎优先」）。
   *
   * 反向断言（判别力）：让替身返回一张**不是**最小的牌（如手牌里的 9），
   * 断言打出的就是 9 —— 若实现自己算最小（忽略引擎返回值），这条必红。
   */
  it('首出 ⇒ 规则引擎被调用且**返回值被采用**（C5/R204）', () => {
    const s = { ...playing(), currentPlayer: 0, lastPlayedHand: null, lastPlayerIdx: -1 };
    const withHand = {
      ...s,
      players: s.players.map((p, i) => (i === 0 ? { ...p, hand: h(20, 3, 9) } : p)),
    };

    const card = (rank: Rank): Card => ({ r: rank, s: 0 });
    engine.mockClear(); // 本文件前面的用例也走过引擎，计数必须从这条开始

    try {
      // 1) 正对照：引擎返回真正的最小单张 ⇒ 打出的就是它
      engine.mockImplementation(() => [card(Rank.Rank3)]);
      expect(handlePlayTimeout(withHand, 'user-1').lastPlayedHand!.cards).toEqual(h(3));
      expect(engine).toHaveBeenCalledTimes(1);
      // 目标必须是 **Invalid**（首出语义），不是「上一手牌」
      expect(engine.mock.calls[0]![1]).toMatchObject({ type: HandType.Invalid });

      // 2) 判别力：引擎返回 9（不是最小）⇒ 打出的必须是 9，
      //    证明实现**没有**自己算最小（旧实现自带一个 reduce 循环，会在这里红）
      engine.mockImplementation(() => [card(Rank.Rank9)]);
      expect(handlePlayTimeout(withHand, 'user-1').lastPlayedHand!.cards).toEqual(h(9));
    } finally {
      engine.mockReset();
    }
  });
});

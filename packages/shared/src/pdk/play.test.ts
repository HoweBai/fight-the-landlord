/**
 * Task 3.3 / spec §5.3 + §5.5：跑得快回合流转与胜负。
 *
 * 判据：首出不可过；跟牌可过；其余玩家都过后回到最后出牌者重新首出；
 * 精确按 `(r,s)` 摘牌；非法牌型/压不过/不是自己回合一律拒绝；
 * 出完立即结束；`playedCount` 只统计实际打出的牌。
 */
import { describe, expect, it } from 'vitest';
import { PdkHandType, type Card } from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES } from './rules';
import { createPdkDeck } from './deck';
import type { PdkPlayer, PdkSession, PdkSessionInput } from './types';
import {
  createPdkSession,
  finishPdk,
  handlePdkPass,
  handlePdkPlay,
  handlePdkTimeout,
  isPdkFinished,
} from './play';

const C = (r: number, s = 0): Card => ({ r, s });
const key = (c: Card): string => `${c.r},${c.s}`;

function player(id: string, seat: number, hand: Card[], over: Partial<PdkPlayer> = {}): PdkPlayer {
  return {
    id,
    seat,
    hand,
    isBot: false,
    isOffline: false,
    timeoutCount: 0,
    trustee: false,
    playedCount: 0,
    ...over,
  };
}

/** 小型固定会话（不依赖 16 张发牌；用于单步状态转移）。 */
function fixture(over: Partial<PdkSession> = {}): PdkSession {
  return {
    roomCode: 'PDK001',
    gameType: 'paodekuai',
    playerCount: 3,
    baseScore: 15,
    state: 'playing',
    players: [
      player('a', 0, [C(3, 0), C(3, 1), C(3, 2), C(9)]),
      player('b', 1, [C(4), C(5)]),
      player('c', 2, [C(6), C(7)]),
    ],
    currentPlayer: 0,
    turnDeadlineAt: 0,
    version: 1,
    actionLog: [],
    createdAt: 0,
    finishedAt: null,
    rules: DEFAULT_PDK_RULES,
    lastPlayedHand: null,
    lastPlayerIdx: -1,
    consecutivePasses: 0,
    bombCount: 0,
    ...over,
  };
}

function input(over: Partial<PdkSessionInput> = {}): PdkSessionInput {
  const playerCount = over.playerCount ?? 3;
  return {
    roomCode: 'PDK001',
    playerCount,
    baseScore: 15,
    rules: DEFAULT_PDK_RULES,
    players: Array.from({ length: playerCount }, (_, seat) => ({
      id: `p${seat}`,
      seat,
      isBot: false,
    })),
    random: () => 0.5,
    ...over,
  };
}

/** 把红桃3 移到指定座位的第一张（确定性首出）。 */
function deckWithHeart3At(index: number): Card[] {
  const deck = createPdkDeck();
  const i = deck.findIndex((c) => c.r === 3 && c.s === 1);
  const [heart3] = deck.splice(i, 1);
  deck.splice(index, 0, heart3!);
  return deck;
}


describe('createPdkSession（Task 3.3）', () => {
  it('3 人：按 testDeck 发牌、红桃3 持有者先出、version=1、initialHands 冻结快照', () => {
    const deck = deckWithHeart3At(16); // 第二份第一张 ⇒ seat1
    const session = createPdkSession(input({ playerCount: 3, testDeck: deck }));

    expect(session.gameType).toBe('paodekuai');
    expect(session.playerCount).toBe(3);
    expect(session.state).toBe('playing');
    expect(session.version).toBe(1);
    expect(session.currentPlayer).toBe(1);
    expect(session.lastPlayedHand).toBeNull();
    expect(session.lastPlayerIdx).toBe(-1);
    expect(session.consecutivePasses).toBe(0);
    expect(session.players.map((p) => p.hand.length)).toEqual([16, 16, 16]);
    expect(session.players.map((p) => p.playedCount)).toEqual([0, 0, 0]);
    expect(session.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(session.rules).toBe(DEFAULT_PDK_RULES);
    expect('unusedCards' in session).toBe(false);
    // 快照是独立副本（后续出牌摘牌不得改到它）
    expect(session.initialHands!.map((h) => h.map(key))).toEqual(
      session.players.map((p) => p.hand.map(key)),
    );
    expect(session.initialHands![0]).not.toBe(session.players[0]!.hand);
  });

  it('2 人：第三份进 unusedCards（16 张，且不出现在两家手牌里）', () => {
    const deck = deckWithHeart3At(0); // seat0
    const session = createPdkSession(input({ playerCount: 2, testDeck: deck }));

    expect(session.currentPlayer).toBe(0);
    expect(session.unusedCards).toHaveLength(16);
    expect(session.players.map((p) => p.hand.length)).toEqual([16, 16]);
    const inHands = new Set(session.players.flatMap((p) => p.hand.map(key)));
    for (const card of session.unusedCards!) expect(inHands.has(key(card))).toBe(false);
  });

  it('4 人：每人 12 张，红桃3 在第三份时 seat2 先出', () => {
    const deck = deckWithHeart3At(24); // 24..35 = seat2
    const session = createPdkSession(input({ playerCount: 4, testDeck: deck }));

    expect(session.players.map((p) => p.hand.length)).toEqual([12, 12, 12, 12]);
    expect(session.currentPlayer).toBe(2);
  });
});

describe('handlePdkPlay：精确摘牌 / 回合推进 / 牌型校验', () => {
  it('首出：摘掉对应 (r,s) 的牌、记录解析结果、轮到下家、version/actionLog 前进', () => {
    const s = fixture();
    const next = handlePdkPlay(s, 'a', [C(3, 0)]);

    expect(next.players[0]!.hand.map(key)).toEqual(['3,1', '3,2', '9,0']);
    expect(next.players[0]!.playedCount).toBe(1);
    expect(next.lastPlayedHand).toEqual({ type: PdkHandType.Single, keyRank: 3, length: 0 });
    expect(next.lastPlayerIdx).toBe(0);
    expect(next.consecutivePasses).toBe(0);
    expect(next.currentPlayer).toBe(1);
    expect(next.version).toBe(2);
    expect(next.actionLog).toEqual([
      { version: 2, seat: 0, cards: [C(3, 0)], kind: 'play' },
    ]);
    // 原会话不可变
    expect(s.players[0]!.hand).toHaveLength(4);
    expect(s.version).toBe(1);
  });

  it('精确摘牌按 (r,s)：打出 ♥5 不会摘掉 ♠5', () => {
    const s = fixture({
      players: [
        player('a', 0, [C(5, 0), C(5, 1), C(6, 0)]),
        player('b', 1, [C(6)]),
        player('c', 2, [C(7)]),
      ],
    });
    const next = handlePdkPlay(s, 'a', [C(5, 1)]);
    expect(next.players[0]!.hand.map(key)).toEqual(['5,0', '6,0']);
  });

  it('非法：不是自己回合 / 玩家不存在 / 状态非 playing / 牌不在手 / 牌型非法', () => {
    const s = fixture({ currentPlayer: 1 });
    expect(() => handlePdkPlay(s, 'a', [C(3)])).toThrow('Not your turn');
    expect(() => handlePdkPlay(fixture(), 'nobody', [C(3)])).toThrow('not found');
    expect(() => handlePdkPlay(fixture({ state: 'ended' }), 'a', [C(3)])).toThrow(
      'not in playing state',
    );
    expect(() => handlePdkPlay(fixture(), 'a', [C(8)])).toThrow('not in hand');
    expect(() => handlePdkPlay(fixture(), 'a', [C(3), C(9)])).toThrow('Invalid pdk hand');
    // 失败路径不得产生部分摘牌
    const after = fixture();
    expect(() => handlePdkPlay(after, 'a', [C(3), C(8)])).toThrow('not in hand');
    expect(after.players[0]!.hand).toHaveLength(4);
  });

  it('跟牌：必须同型且能压过；压不过/不同型拒绝', () => {
    const led = handlePdkPlay(fixture(), 'a', [C(9)]);
    // b 手牌 4,5；5 压不过 9
    expect(() => handlePdkPlay(led, 'b', [C(5)])).toThrow('cannot beat last hand');
    // 对子（不同型）也不行
    expect(() => handlePdkPlay(led, 'b', [C(4), C(5)])).toThrow();
    // 合法：b 没有更大单张，先给 b 一手更大的牌
    const rich = fixture({
      currentPlayer: 1,
      lastPlayedHand: { type: PdkHandType.Single, keyRank: 9, length: 0 },
      lastPlayerIdx: 0,
      players: [
        player('a', 0, [C(3)]),
        player('b', 1, [C(10)]),
        player('c', 2, [C(7)]),
      ],
    });
    const next = handlePdkPlay(rich, 'b', [C(10)]);
    expect(next.currentPlayer).toBe(2);
  });

  it('炸弹压非炸弹；炸弹计数只统计裸四张（四带二/AAA 不计）', () => {
    const base = fixture({
      players: [
        player('a', 0, [C(3)]),
        player('b', 1, [C(7), C(7), C(7), C(7), C(8)]),
        player('c', 2, [C(9)]),
      ],
      currentPlayer: 1,
      lastPlayedHand: { type: PdkHandType.Single, keyRank: 10, length: 0 },
      lastPlayerIdx: 0,
    });
    const bomb = handlePdkPlay(base, 'b', [C(7), C(7), C(7), C(7)]);
    expect(bomb.bombCount).toBe(1);

    const fourWithTwo = handlePdkPlay(
      fixture({
        currentPlayer: 1,
        players: [
          player('a', 0, [C(3)]),
          player('b', 1, [C(7), C(7), C(7), C(7), C(8), C(9)]),
          player('c', 2, [C(9)]),
        ],
      }),
      'b',
      [C(7), C(7), C(7), C(7), C(8), C(9)],
    );
    expect(fourWithTwo.lastPlayedHand!.type).toBe(PdkHandType.FourWithTwo);
    expect(fourWithTwo.bombCount).toBe(0);

    const aces = handlePdkPlay(
      fixture({
        currentPlayer: 1,
        players: [
          player('a', 0, [C(5)]),
          player('b', 1, [C(14), C(14), C(14), C(5)]),
          player('c', 2, [C(6)]),
        ],
      }),
      'b',
      [C(14), C(14), C(14)],
    );
    expect(aces.lastPlayedHand!.type).toBe(PdkHandType.Trio);
    expect(aces.bombCount).toBe(0);
  });

  it('出完手中所有牌 ⇒ 立即结束（state=ended / winnerSeats / finishedAt）', () => {
    const s = fixture({
      players: [
        player('a', 0, [C(3)]),
        player('b', 1, [C(4)]),
        player('c', 2, [C(5)]),
      ],
    });
    const next = handlePdkPlay(s, 'a', [C(3)]);

    expect(next.state).toBe('ended');
    expect(next.winnerSeats).toEqual([0]);
    expect(typeof next.finishedAt).toBe('number');
    expect(isPdkFinished(next)).toBe(true);
    // 已结束的会话不可再出牌
    expect(() => handlePdkPlay(next, 'b', [C(4)])).toThrow('not in playing state');
  });
});

describe('handlePdkPass：过牌与全过重置', () => {
  it('首出不可过牌', () => {
    expect(() => handlePdkPass(fixture(), 'a')).toThrow('Cannot pass on the opening lead');
  });

  it('跟牌可过：consecutivePasses+1、轮到下家、上一手保持不变', () => {
    const led = handlePdkPlay(fixture(), 'a', [C(9)]);
    const after = handlePdkPass(led, 'b');

    expect(after.consecutivePasses).toBe(1);
    expect(after.currentPlayer).toBe(2);
    expect(after.lastPlayedHand).toEqual(led.lastPlayedHand);
    expect(after.lastPlayerIdx).toBe(0);
    expect(after.actionLog.at(-1)).toEqual({ version: after.version, seat: 1, cards: [], kind: 'pass' });
    expect(after.players[1]!.playedCount).toBe(0);
  });

  it('3 人：其余两人都过后回到最后出牌者重新首出（lastPlayedHand 清空）', () => {
    const led = handlePdkPlay(fixture(), 'a', [C(9)]);
    const p1 = handlePdkPass(led, 'b');
    const reset = handlePdkPass(p1, 'c');

    expect(reset.currentPlayer).toBe(0);
    expect(reset.lastPlayedHand).toBeNull();
    expect(reset.lastPlayerIdx).toBe(-1);
    expect(reset.consecutivePasses).toBe(0);
    // 重新首出可选任意合法牌型
    const leadAgain = handlePdkPlay(reset, 'a', [C(3, 0), C(3, 1)]);
    expect(leadAgain.lastPlayedHand!.type).toBe(PdkHandType.Pair);
  });

  it('2 人：另一家过一次即重置', () => {
    const two = fixture({
      playerCount: 2,
      players: [player('a', 0, [C(9), C(3)]), player('b', 1, [C(4)])],
    });
    const led = handlePdkPlay(two, 'a', [C(9)]);
    const reset = handlePdkPass(led, 'b');
    expect(reset.currentPlayer).toBe(0);
    expect(reset.lastPlayedHand).toBeNull();
    expect(reset.consecutivePasses).toBe(0);
  });

  it('最后出牌者不能过牌（防御）；不是自己回合也不能过', () => {
    const weird = fixture({
      lastPlayedHand: { type: PdkHandType.Single, keyRank: 3, length: 0 },
      lastPlayerIdx: 0,
    });
    expect(() => handlePdkPass(weird, 'a')).toThrow('Cannot pass when you last played');
    const led = handlePdkPlay(fixture(), 'a', [C(9)]);
    expect(() => handlePdkPass(led, 'c')).toThrow('Not your turn');
  });
});

describe('finishPdk / isPdkFinished', () => {
  it('finishPdk 设 ended/finishedAt/winnerSeats，且重复调用幂等', () => {
    const s = fixture({
      players: [player('a', 0, []), player('b', 1, [C(4)]), player('c', 2, [C(5)])],
    });
    const done = finishPdk(s, 1234);
    expect(done.state).toBe('ended');
    expect(done.finishedAt).toBe(1234);
    expect(done.winnerSeats).toEqual([0]);
    expect(finishPdk(done, 9999)).toBe(done); // 幂等：已结束原样返回
  });

  it('isPdkFinished：state=ended 或任一手牌为空', () => {
    expect(isPdkFinished(fixture())).toBe(false);
    expect(
      isPdkFinished(fixture({ players: [player('a', 0, []), player('b', 1, [C(4)])], playerCount: 2 })),
    ).toBe(true);
  });
});

describe('handlePdkTimeout（Task 3.3 的最小实现；3.5 接 autoplay）', () => {
  it('首出超时：打出最小的单张（点数、花色升序）', () => {
    const s = fixture({
      players: [
        player('a', 0, [C(9, 2), C(3, 3), C(3, 0)]),
        player('b', 1, [C(4)]),
        player('c', 2, [C(5)]),
      ],
    });
    const next = handlePdkTimeout(s);
    expect(next.lastPlayedHand).toEqual({ type: PdkHandType.Single, keyRank: 3, length: 0 });
    expect(next.players[0]!.hand.map(key)).toEqual(['9,2', '3,3']);
  });

  it('跟牌超时：有解 ⇒ 打最小可压；无解 ⇒ 过牌', () => {
    const led = handlePdkPlay(fixture(), 'a', [C(9)]);
    // b 手牌 4,5，压不过 9 ⇒ 过牌
    const passed = handlePdkTimeout(led);
    expect(passed.consecutivePasses).toBe(1);
    expect(passed.actionLog.at(-1)!.kind).toBe('pass');

    // 同样面对单张 9，b 有 10 ⇒ 打 10
    const rich = fixture({
      currentPlayer: 1,
      players: [
        player('a', 0, [C(3)]),
        player('b', 1, [C(10), C(4)]),
        player('c', 2, [C(7)]),
      ],
      lastPlayedHand: { type: PdkHandType.Single, keyRank: 9, length: 0 },
      lastPlayerIdx: 0,
    });
    const beat = handlePdkTimeout(rich);
    expect(beat.actionLog.at(-1)).toMatchObject({ seat: 1, kind: 'play', cards: [C(10)] });
    expect(beat.players[1]!.hand.map(key)).toEqual(['4,0']);
  });

  it('无牌可打 / 非进行中 ⇒ 抛错', () => {
    expect(() =>
      handlePdkTimeout(
        fixture({ players: [player('a', 0, []), player('b', 1, [C(4)]), player('c', 2, [C(5)])] }),
      ),
    ).toThrow('no card to play');
    expect(() => handlePdkTimeout(fixture({ state: 'ended' }))).toThrow('not in playing state');
  });
});

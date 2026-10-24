/**
 * Task 3.1 / spec §5.2 + §5.3：2/3/4 人发牌与首出解析。
 *
 * - 3 人 16/16/16、4 人 12×4、2 人 16/16 + 16 张扣牌（`unusedCards`，永不出站）；
 * - 首出：红桃 3→4→…→A→2 找第一张在玩家手中的红桃；全被扣时用注入的随机源。
 */
import { describe, expect, it } from 'vitest';
import { ProtocolError, type Card } from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES } from './rules';
import { createPdkDeck } from './deck';
import {
  HEART_LEAD_ORDER,
  dealPdk,
  resolveFirstLeader,
} from './deal';
import type { PdkSessionInput } from './types';

const heart = (r: number): Card => ({ r, s: 1 });
const spade = (r: number): Card => ({ r, s: 0 });

function input(over: Partial<PdkSessionInput> = {}): PdkSessionInput {
  const playerCount = over.playerCount ?? 3;
  const players = Array.from({ length: playerCount }, (_, seat) => ({
    id: `p${seat}`,
    seat,
    isBot: false,
  }));
  return {
    roomCode: 'PDK001',
    playerCount,
    baseScore: 15,
    rules: DEFAULT_PDK_RULES,
    players,
    random: () => 0.5,
    ...over,
  };
}

/** 确定性 LCG（测试内联；不用 Math.random）。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const key = (c: Card): string => `${c.r},${c.s}`;
const allCards = (hands: Card[][], unused?: Card[]): Card[] => [...hands.flat(), ...(unused ?? [])];

describe('dealPdk：2/3/4 人发牌', () => {
  it('3 人：16/16/16，48 张全覆盖、无重复、无扣牌', () => {
    const dealt = dealPdk(input({ playerCount: 3 }));
    expect(dealt.hands.map((h) => h.length)).toEqual([16, 16, 16]);
    expect('unusedCards' in dealt).toBe(false);
    const cards = allCards(dealt.hands);
    expect(cards).toHaveLength(48);
    expect(new Set(cards.map(key)).size).toBe(48);
  });

  it('4 人：12×4，48 张全覆盖、无扣牌', () => {
    const dealt = dealPdk(input({ playerCount: 4 }));
    expect(dealt.hands.map((h) => h.length)).toEqual([12, 12, 12, 12]);
    expect('unusedCards' in dealt).toBe(false);
    expect(new Set(allCards(dealt.hands).map(key)).size).toBe(48);
  });

  it('2 人：16/16 + 第三份 16 张扣牌（与两家手牌不重叠）', () => {
    const dealt = dealPdk(input({ playerCount: 2 }));
    expect(dealt.hands.map((h) => h.length)).toEqual([16, 16]);
    expect(dealt.unusedCards).toHaveLength(16);
    const cards = allCards(dealt.hands, dealt.unusedCards);
    expect(cards).toHaveLength(48);
    expect(new Set(cards.map(key)).size).toBe(48);
  });

  it('只发 pdk 合法牌（无王、无被去掉的六张）', () => {
    const legal = new Set(createPdkDeck().map(key));
    const dealt = dealPdk(input({ playerCount: 4 }));
    for (const c of allCards(dealt.hands)) expect(legal.has(key(c))).toBe(true);
  });

  it('testDeck：按给定顺序连续切份（3 人 / 2 人第三份进扣牌）', () => {
    const deck = createPdkDeck();
    const three = dealPdk(input({ playerCount: 3, testDeck: deck }));
    expect(three.hands[0]).toEqual(deck.slice(0, 16));
    expect(three.hands[1]).toEqual(deck.slice(16, 32));
    expect(three.hands[2]).toEqual(deck.slice(32, 48));

    const two = dealPdk(input({ playerCount: 2, testDeck: deck }));
    expect(two.hands[0]).toEqual(deck.slice(0, 16));
    expect(two.hands[1]).toEqual(deck.slice(16, 32));
    expect(two.unusedCards).toEqual(deck.slice(32, 48));
  });

  it('不修改调用方的 testDeck 数组', () => {
    const deck = createPdkDeck();
    const snapshot = deck.map(key);
    dealPdk(input({ testDeck: deck }));
    expect(deck.map(key)).toEqual(snapshot);
  });

  it('注入随机源：同序列 ⇒ 同发牌；不同序列 ⇒ 不同发牌（不是 Math.random）', () => {
    const a = dealPdk(input({ random: lcg(1) }));
    const b = dealPdk(input({ random: lcg(1) }));
    expect(a.hands.map((h) => h.map(key))).toEqual(b.hands.map((h) => h.map(key)));

    const c = dealPdk(input({ random: lcg(99) }));
    expect(c.hands.map((h) => h.map(key))).not.toEqual(a.hands.map((h) => h.map(key)));
  });

  it('非法 testDeck ⇒ ProtocolError（非 48 张 / 重复 / 含 pdk 非法牌）', () => {
    const deck = createPdkDeck();
    expect(() => dealPdk(input({ testDeck: deck.slice(0, 47) }))).toThrow(ProtocolError);

    const duplicated = [...deck];
    duplicated[0] = { ...duplicated[1]! };
    expect(() => dealPdk(input({ testDeck: duplicated }))).toThrow(ProtocolError);

    const withJoker = [...deck];
    withJoker[0] = { r: 20, s: 4 };
    expect(() => dealPdk(input({ testDeck: withJoker }))).toThrow(ProtocolError);

    const withRemoved = [...deck];
    withRemoved[0] = { r: 17, s: 0 }; // 黑桃2（已被去掉）
    expect(() => dealPdk(input({ testDeck: withRemoved }))).toThrow(ProtocolError);
  });

  it('players 与 playerCount/座位不匹配 ⇒ ProtocolError', () => {
    expect(() => dealPdk(input({ playerCount: 3, players: [{ id: 'a', seat: 0, isBot: false }] }))).toThrow(
      ProtocolError,
    );
    expect(() =>
      dealPdk(
        input({
          playerCount: 2,
          players: [
            { id: 'a', seat: 0, isBot: false },
            { id: 'b', seat: 2, isBot: false },
          ],
        }),
      ),
    ).toThrow(ProtocolError);
  });

  it('随机源返回非有限数 ⇒ ProtocolError（不得静默产生 NaN 索引）', () => {
    expect(() => dealPdk(input({ random: () => Number.NaN }))).toThrow(ProtocolError);
    expect(() => resolveFirstLeader([[spade(3)], [spade(4)]], 2, () => Number.NaN)).toThrow(
      ProtocolError,
    );
  });
});

describe('resolveFirstLeader：红桃 3→4→…→A→2', () => {
  const hand = (...cards: Card[]): Card[] => cards;

  it('红桃顺序常量逐字（3..14、17）', () => {
    expect(HEART_LEAD_ORDER).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17]);
  });

  it('红桃3 在谁手里谁先出（3 人）', () => {
    const hands = [hand(spade(4)), hand(heart(4)), hand(heart(3), heart(4))];
    expect(resolveFirstLeader(hands, 3, () => 0)).toBe(2);
  });

  it('红桃3 不在场时按 4→…→2 顺延；更小的红桃优先', () => {
    const hands = [hand(heart(5)), hand(heart(4)), hand(heart(3))];
    expect(resolveFirstLeader(hands, 3, () => 0)).toBe(2);

    const noThree = [hand(heart(5)), hand(heart(4)), hand(spade(3))];
    expect(resolveFirstLeader(noThree, 3, () => 0)).toBe(1);
  });

  it('红桃 A / 红桃2 也按顺序参与（K < A < 2）', () => {
    const hands = [hand(heart(17)), hand(heart(14)), hand(heart(13))];
    expect(resolveFirstLeader(hands, 3, () => 0)).toBe(2); // K 最先
    const kGone = [hand(heart(17)), hand(heart(14)), hand(spade(13))];
    expect(resolveFirstLeader(kGone, 3, () => 0)).toBe(1); // A
    const aGone = [hand(heart(17)), hand(spade(14)), hand(spade(13))];
    expect(resolveFirstLeader(aGone, 3, () => 0)).toBe(0); // 红桃2
  });

  it('2 人局所有红桃都被扣 ⇒ 注入随机源决定（可复现）', () => {
    const hands = [hand(spade(3)), hand(spade(4))];
    expect(resolveFirstLeader(hands, 2, () => 0.25)).toBe(0);
    expect(resolveFirstLeader(hands, 2, () => 0.75)).toBe(1);
    expect(resolveFirstLeader(hands, 2, lcg(7))).toBe(resolveFirstLeader(hands, 2, lcg(7)));
  });

  it('hands 数量与 playerCount 不符 ⇒ ProtocolError', () => {
    expect(() => resolveFirstLeader([hand(heart(3))], 2, () => 0)).toThrow(ProtocolError);
    expect(() => resolveFirstLeader([hand(heart(3)), hand(spade(3)), hand(spade(4))], 2, () => 0)).toThrow(
      ProtocolError,
    );
  });
});

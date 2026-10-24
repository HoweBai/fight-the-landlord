import { describe, it, expect } from 'vitest';
import type { Card } from '@fight-the-landlord/protocol';
import { Rank } from '../card/card';
import { HandType, parseHand, canBeat, isContinuous, analyzeCards } from './rule';

/** R696：牌是 `{r, s}`。规则引擎**只读 `r`**（`analyzeCards` 只数点数），故 `s` 取常量。 */
function makeCard(rank: Rank): Card {
  return { r: rank, s: 0 };
}

function makeCards(...ranks: Rank[]) {
  return ranks.map(r => makeCard(r));
}

describe('isContinuous', () => {
  it('valid 5-card straight', () => {
    expect(isContinuous([Rank.Rank3, Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7])).toBe(true);
  });
  it('rejects ranks >= 2', () => {
    expect(isContinuous([Rank.RankA, Rank.Rank2])).toBe(false);
  });
  it('rejects non-continuous', () => {
    expect(isContinuous([Rank.Rank3, Rank.Rank4, Rank.Rank6])).toBe(false);
  });
  it('empty returns false', () => {
    expect(isContinuous([])).toBe(false);
  });
  it('single rank is continuous', () => {
    expect(isContinuous([Rank.Rank5])).toBe(true);
  });
});

describe('parseHand - simple types', () => {
  it('single', () => {
    const result = parseHand([makeCard(Rank.Rank7)]);
    expect(result.type).toBe(HandType.Single);
    expect(result.keyRank).toBe(Rank.Rank7);
  });
  it('pair', () => {
    const result = parseHand([makeCard(Rank.RankQ), makeCard(Rank.RankQ)]);
    expect(result.type).toBe(HandType.Pair);
    expect(result.keyRank).toBe(Rank.RankQ);
  });
  it('trio', () => {
    const result = parseHand([makeCard(Rank.Rank5), makeCard(Rank.Rank5), makeCard(Rank.Rank5)]);
    expect(result.type).toBe(HandType.Trio);
  });
  it('bomb', () => {
    const result = parseHand([makeCard(Rank.Rank10), makeCard(Rank.Rank10), makeCard(Rank.Rank10), makeCard(Rank.Rank10)]);
    expect(result.type).toBe(HandType.Bomb);
    expect(result.keyRank).toBe(Rank.Rank10);
  });
  it('rocket', () => {
    const result = parseHand([makeCard(Rank.RankBlackJoker), makeCard(Rank.RankRedJoker)]);
    expect(result.type).toBe(HandType.Rocket);
  });
});

/**
 * C6 / R203：非法牌型返回**类型化的 `HandType.Invalid`**，不再 `throw`。
 *
 * 这条判据就是 C6 的「启用」半边：`HandType.Invalid` 此前是**死代码**（`parseHand` 只抛错），
 * 于是 `rule/autoplay.ts` 的 Invalid 分支（首出打最小单张）永远不可达。
 * 没有这条断言，C6 的启用就没有判据。
 * 拒绝的责任上移到 `ddz/play.ts` 的 `handlePlayCards`（文案逐字 `不支持的牌型: …`）。
 */
describe('parseHand - 非法牌型返回 HandType.Invalid（C6/R203）', () => {
  it('无法识别的组合 ⇒ Invalid（不再抛错）', () => {
    // 两张不同点数的单牌：既不是对子，也不是任何带牌结构
    const result = parseHand(makeCards(Rank.Rank3, Rank.Rank4));
    expect(result.type).toBe(HandType.Invalid);
    expect(result.keyRank).toBe(0);
    expect(result.length).toBe(0);
    expect(result.cards).toHaveLength(2);
  });

  it('「两个四条」这类畸形组合同样是 Invalid', () => {
    const result = parseHand(
      makeCards(
        Rank.Rank3, Rank.Rank3, Rank.Rank3, Rank.Rank3,
        Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5,
      ),
    );
    expect(result.type).toBe(HandType.Invalid);
  });

  it('空数组**仍然抛错**（参数错误，不是牌型非法）', () => {
    expect(() => parseHand([])).toThrow('不能出空牌');
  });
});

describe('parseHand - complex types', () => {
  it('straight 5 cards', () => {
    const cards = makeCards(Rank.Rank3, Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7);
    const result = parseHand(cards);
    expect(result.type).toBe(HandType.Straight);
    expect(result.length).toBe(5);
  });
  it('pair straight 3 pairs', () => {
    const cards = [
      makeCard(Rank.Rank5), makeCard(Rank.Rank5),
      makeCard(Rank.Rank6), makeCard(Rank.Rank6),
      makeCard(Rank.Rank7), makeCard(Rank.Rank7),
    ];
    const result = parseHand(cards);
    expect(result.type).toBe(HandType.PairStraight);
    expect(result.length).toBe(3);
  });
  it('trio with single', () => {
    const cards = [makeCard(Rank.Rank8), makeCard(Rank.Rank8), makeCard(Rank.Rank8), makeCard(Rank.Rank3)];
    const result = parseHand(cards);
    expect(result.type).toBe(HandType.TrioWithSingle);
  });
  it('trio with pair', () => {
    const cards = [makeCard(Rank.Rank9), makeCard(Rank.Rank9), makeCard(Rank.Rank9), makeCard(Rank.Rank4), makeCard(Rank.Rank4)];
    const result = parseHand(cards);
    expect(result.type).toBe(HandType.TrioWithPair);
  });
});

describe('canBeat', () => {
  it('rocket beats everything', () => {
    const rocket = parseHand([makeCard(Rank.RankBlackJoker), makeCard(Rank.RankRedJoker)]);
    const bomb = parseHand(makeCards(Rank.Rank10, Rank.Rank10, Rank.Rank10, Rank.Rank10));
    expect(canBeat(rocket, bomb)).toBe(true);
  });
  it('bomb beats non-bomb', () => {
    const bomb = parseHand(makeCards(Rank.RankK, Rank.RankK, Rank.RankK, Rank.RankK));
    const trio = parseHand(makeCards(Rank.Rank5, Rank.Rank5, Rank.Rank5));
    expect(canBeat(bomb, trio)).toBe(true);
  });
  it('same type higher rank wins', () => {
    const high = parseHand([makeCard(Rank.RankA)]);
    const low = parseHand([makeCard(Rank.Rank7)]);
    expect(canBeat(high, low)).toBe(true);
    expect(canBeat(low, high)).toBe(false);
  });
  it('different types lose (except bomb)', () => {
    const pair = parseHand([makeCard(Rank.Rank5), makeCard(Rank.Rank5)]);
    const single = parseHand([makeCard(Rank.RankA)]);
    expect(canBeat(single, pair)).toBe(false);
  });
});

describe('analyzeCards', () => {
  it('correctly categorizes a mixed hand', () => {
    const cards = [
      makeCard(Rank.Rank3),
      makeCard(Rank.Rank4), makeCard(Rank.Rank4),
      makeCard(Rank.Rank5), makeCard(Rank.Rank5), makeCard(Rank.Rank5),
      makeCard(Rank.Rank6), makeCard(Rank.Rank6), makeCard(Rank.Rank6), makeCard(Rank.Rank6),
      makeCard(Rank.RankJ),
    ];
    const a = analyzeCards(cards);
    expect(a.fours).toEqual([Rank.Rank6]);
    expect(a.trios).toEqual([Rank.Rank5]);
    expect(a.pairs).toEqual([Rank.Rank4]);
    expect(a.ones).toEqual([Rank.Rank3, Rank.RankJ]);
  });
});

describe('parseHand - 飞机带单翅膀与 4 三张特判（DouZero 生成器对齐）', () => {
  it('飞机带单：对子可以当两张单翼', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5,
    ));
    expect(result.type).toBe(HandType.PlaneWithSingles);
    expect(result.length).toBe(2);
    expect(result.keyRank).toBe(Rank.Rank3);
  });

  it('飞机带单：主体之外 1 单 + 1 对 = 3 张翅膀（长度 3）', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank7, Rank.Rank7, Rank.Rank8,
    ));
    expect(result.type).toBe(HandType.PlaneWithSingles);
    expect(result.length).toBe(3);
    expect(result.keyRank).toBe(Rank.Rank3);
  });

  it('4 三张特判：三连飞机 + 另一组三张当翅膀', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank7, Rank.Rank7, Rank.Rank7,
    ));
    expect(result.type).toBe(HandType.PlaneWithSingles);
    expect(result.length).toBe(3);
    expect(result.keyRank).toBe(Rank.Rank3);
  });

  it('4 三张特判：连续段在低位时按主体起点比较', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank7, Rank.Rank7, Rank.Rank7,
    ));
    expect(result.type).toBe(HandType.PlaneWithSingles);
    expect(result.length).toBe(3);
    expect(result.keyRank).toBe(Rank.Rank5);
  });

  it('4 组三张全连续 ⇒ 仍然是裸飞机（长度 4）', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
    ));
    expect(result.type).toBe(HandType.Plane);
    expect(result.length).toBe(4);
  });

  it('反例：没有 3 组连续主体 ⇒ Invalid', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank7, Rank.Rank7, Rank.Rank7,
    ));
    expect(result.type).toBe(HandType.Invalid);
  });

  it('反例：四张同点不能当翅膀', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5,
    ));
    expect(result.type).toBe(HandType.Invalid);
  });

  it('反例：两个炸弹仍不认作四带两对', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4, Rank.Rank4,
    ));
    expect(result.type).toBe(HandType.Invalid);
  });
});

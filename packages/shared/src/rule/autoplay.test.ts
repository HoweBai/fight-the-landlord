/**
 * E4 / R202：`findSmallestBeatingCards()` 必须覆盖**全部 14 种牌型**，且是**最小**的合法跟牌。
 *
 * 判据形态（R202）：14 型**逐型一条「同型最小可压」**用例 + 三条边界
 * （王炸 ⇒ `null`、炸弹 ⇒ 只被更大炸弹/王炸跟、`Invalid` ⇒ 最小单张）。
 *
 * 夹具一律构造成**唯一解**（手牌里能压过目标的组合恰好只有一种），
 * 这样断言的是行为而不只是「某个合法组合」——否则用例会被弱化成「非空即可」。
 */
import { describe, it, expect } from 'vitest';
import { HandType, parseHand, canBeat } from './rule';
import { findSmallestBeatingCards } from './autoplay';
import type { Card } from '@fight-the-landlord/protocol';
import { Rank } from '../card/card';

/** R696：牌是 `{r, s}`。跟牌引擎**只读 `r`**，故 `s` 取常量。 */
const c = (rank: Rank): Card => ({ r: rank, s: 2 });
const hand = (...ranks: Rank[]): Card[] => ranks.map(c);

/** 只比较点数多重集：花色不参与牌型判定（`rule.ts` 的 `analyzeCards` 只数点数）。 */
const ranksOf = (cards: Card[] | null): number[] =>
  (cards ?? []).map((x) => x.r).sort((a, b) => a - b);
const expectedRanks = (ranks: Rank[]): number[] => [...ranks].sort((a, b) => a - b);

describe('findSmallestBeatingCards：14 种牌型的同型最小可压（E4/R202）', () => {
  const cases: Array<[string, Card[], Card[], Rank[]]> = [
    ['单张', hand(Rank.Rank5), hand(Rank.Rank6, Rank.Rank9), [Rank.Rank6]],
    [
      '对子',
      hand(Rank.Rank5, Rank.Rank5),
      hand(Rank.Rank6, Rank.Rank6, Rank.Rank9, Rank.Rank9),
      [Rank.Rank6, Rank.Rank6],
    ],
    [
      '三张',
      hand(Rank.Rank5, Rank.Rank5, Rank.Rank5),
      hand(Rank.Rank7, Rank.Rank7, Rank.Rank7),
      [Rank.Rank7, Rank.Rank7, Rank.Rank7],
    ],
    [
      '三带一',
      hand(Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank3),
      hand(Rank.Rank7, Rank.Rank7, Rank.Rank7, Rank.Rank4),
      [Rank.Rank7, Rank.Rank7, Rank.Rank7, Rank.Rank4],
    ],
    [
      '三带二',
      hand(Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank3, Rank.Rank3),
      hand(Rank.Rank7, Rank.Rank7, Rank.Rank7, Rank.Rank4, Rank.Rank4),
      [Rank.Rank7, Rank.Rank7, Rank.Rank7, Rank.Rank4, Rank.Rank4],
    ],
    [
      '顺子（同长度）',
      hand(Rank.Rank3, Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7),
      hand(Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7, Rank.Rank8),
      [Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7, Rank.Rank8],
    ],
    [
      '连对（同组数）',
      hand(Rank.Rank3, Rank.Rank3, Rank.Rank4, Rank.Rank4, Rank.Rank5, Rank.Rank5),
      hand(Rank.Rank4, Rank.Rank4, Rank.Rank5, Rank.Rank5, Rank.Rank6, Rank.Rank6),
      [Rank.Rank4, Rank.Rank4, Rank.Rank5, Rank.Rank5, Rank.Rank6, Rank.Rank6],
    ],
    [
      '飞机',
      hand(
        Rank.Rank3, Rank.Rank3, Rank.Rank3,
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
      ),
      hand(
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
      ),
      [
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
      ],
    ],
    [
      '飞机带单',
      hand(
        Rank.Rank3, Rank.Rank3, Rank.Rank3,
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank7,
      ),
      hand(
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank8,
      ),
      [
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank8,
      ],
    ],
    [
      '飞机带对',
      hand(
        Rank.Rank3, Rank.Rank3, Rank.Rank3,
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank7, Rank.Rank7,
      ),
      hand(
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank8, Rank.Rank8,
      ),
      [
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank8, Rank.Rank8,
      ],
    ],
    [
      '炸弹',
      hand(Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5),
      hand(Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank6),
      [Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank6],
    ],
    [
      '四带二（两张单牌）',
      hand(Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank4, Rank.Rank4),
      hand(Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank3, Rank.Rank8),
      [Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank3, Rank.Rank8],
    ],
    [
      '四带两对',
      hand(
        Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank3, Rank.Rank3, Rank.Rank4, Rank.Rank4,
      ),
      hand(
        Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank7, Rank.Rank7, Rank.Rank8, Rank.Rank8,
      ),
      [
        Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank7, Rank.Rank7, Rank.Rank8, Rank.Rank8,
      ],
    ],
    [
      // 表内**唯一**的「无解」行：王炸不可被压 ⇒ `null`（这条同时把 `Rocket` 型纳入覆盖）
      '王炸（无解）',
      hand(Rank.RankBlackJoker, Rank.RankRedJoker),
      hand(Rank.Rank2, Rank.Rank2, Rank.Rank2, Rank.Rank2),
      [],
    ],
    [
      // 协调者 2026-09-15 的**真实缺陷反例**：主体点数有 4 张（5 有四张）。
      // 旧实现把主体的第 4 张当翅膀 ⇒ `[5,5,5,6,6,6,5,7]` ⇒ 同点数 4 张 ⇒ `parseHand` 判 Invalid。
      // 期望：翅膀取 7、8（最小且合法的组合）。
      '飞机带单：主体点数有 4 张时不得把第 4 张当翅膀',
      hand(Rank.Rank3, Rank.Rank3, Rank.Rank3, Rank.Rank4, Rank.Rank4, Rank.Rank4, Rank.Rank5, Rank.Rank6),
      hand(
        Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank7, Rank.Rank7, Rank.Rank7,
        Rank.Rank8, Rank.Rank9,
      ),
      [
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank7, Rank.Rank8,
      ],
    ],
  ];

  for (const [name, target, myHand, expected] of cases) {
    it(`${name}：返回能压过的**最小**组合`, () => {
      const parsedTarget = parseHand(target);
      const got = findSmallestBeatingCards(myHand, parsedTarget);
      expect(ranksOf(got)).toEqual(expectedRanks(expected));

      /**
       * **自洽性判据**（协调者 2026-09-15 裁决）：非 `null` 的结果必须是**合法牌型**
       * 且**真的能压过**目标 —— 「返回的动作过不了 `parseHand`」是**非法动作**，
       * 任何策略偏好都不能豁免（game-service 会以 `13006` 拒绝，而规则引擎是确定性的
       * ⇒ 重决策还是同一个非法手 ⇒ 有合法跟牌却只能 pass）。
       *
       * 这条比逐型人工核对更能防同类形态错误（实测抓到过「飞机带单把主体的第 4 张
       * 当成翅膀 ⇒ 同点数 4 张 ⇒ `Invalid`」）。
       */
      if (got) {
        const parsed = parseHand(got);
        expect(parsed.type, `${name}：返回的牌组必须能被 parseHand 识别`).not.toBe(HandType.Invalid);
        expect(parsed.type, `${name}：跟牌必须是同型`).toBe(parsedTarget.type);
        expect(canBeat(parsed, parsedTarget), `${name}：返回的牌组必须真的能压过目标`).toBe(true);
      }
    });
  }

  it('用例表覆盖全部 14 种牌型（不漏型）', () => {
    const covered = new Set(cases.map(([, target]) => parseHand(target).type));
    expect([...covered].sort((a, b) => a - b)).toEqual(
      [
        HandType.Single, HandType.Pair, HandType.Trio, HandType.TrioWithSingle,
        HandType.TrioWithPair, HandType.Straight, HandType.PairStraight, HandType.Plane,
        HandType.PlaneWithSingles, HandType.PlaneWithPairs, HandType.Bomb, HandType.FourWithTwo,
        HandType.FourWithTwoPairs, HandType.Rocket,
      ].sort((a, b) => a - b),
    );
  });
});

describe('findSmallestBeatingCards：DouZero 生成器对齐的新翅膀形态', () => {
  it('飞机带单：只有对子能当两张翅膀时也能压', () => {
    const target = parseHand(hand(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank6,
    ));
    const got = findSmallestBeatingCards(
      hand(
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank9, Rank.Rank9,
      ),
      target,
    );
    expect(ranksOf(got)).toEqual(expectedRanks([
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank9, Rank.Rank9,
    ]));
  });

  it('飞机带单：单张 + 对子混合翅膀', () => {
    const target = parseHand(hand(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank7, Rank.Rank8,
    ));
    const got = findSmallestBeatingCards(
      hand(
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank7, Rank.Rank7, Rank.Rank7,
        Rank.Rank9, Rank.Rank9, Rank.Rank10,
      ),
      target,
    );
    // 主体 555666777；全单张只有 9、10 两个点数（不够 3 张）⇒ 只能 99 + 10
    expect(ranksOf(got)).toEqual(expectedRanks([
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank7, Rank.Rank7, Rank.Rank7,
      Rank.Rank9, Rank.Rank9, Rank.Rank10,
    ]));
  });

  it('4 三张特判：非连续的第 4 组三张可当翅膀', () => {
    const target = parseHand(hand(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank7, Rank.Rank8,
    ));
    const got = findSmallestBeatingCards(
      hand(
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank9, Rank.Rank9, Rank.Rank9,
      ),
      target,
    );
    expect(ranksOf(got)).toEqual(expectedRanks([
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank9, Rank.Rank9, Rank.Rank9,
    ]));
  });

  it('4 组三张全连续 ⇒ 不能当长度 3 的飞机带单（会解析成裸飞机）', () => {
    const target = parseHand(hand(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank7, Rank.Rank8,
    ));
    const got = findSmallestBeatingCards(
      hand(
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank7, Rank.Rank7, Rank.Rank7,
      ),
      target,
    );
    expect(got).toBeNull();
  });
});

describe('findSmallestBeatingCards：三条边界（E4/R202）', () => {
  it('顺子：手牌里只有**更长**的顺子时不得用它跟（长度必须相同，玩法 §5 第 5 条）', () => {
    // 目标：10,J,Q,K,A（最小 5 张顺子，keyRank = A）。手牌：3..8（6 张，唯一能凑的一段）。
    // 两个方向的长度不匹配都被这条挡住 —— 手牌里的 5 张子段最小是 3..7（≤ 目标）⇒ 无解。
    const target = parseHand(
      hand(Rank.Rank10, Rank.RankJ, Rank.RankQ, Rank.RankK, Rank.RankA),
    );
    const longerOnly = hand(
      Rank.Rank3, Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7, Rank.Rank8,
    );
    expect(findSmallestBeatingCards(longerOnly, target)).toBeNull();

    // 正对照：同长度且更大的顺子必须能跟（否则上面的 null 只是「探针瞎了」）
    const five = parseHand(hand(Rank.Rank3, Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7));
    expect(
      findSmallestBeatingCards(hand(Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7, Rank.Rank8), five),
    ).not.toBeNull();
  });

  it('面对**王炸**不得返回任何牌（旧实现返回炸弹，是非法动作）', () => {
    const rocket = parseHand(hand(Rank.RankBlackJoker, Rank.RankRedJoker));
    expect(
      findSmallestBeatingCards(hand(Rank.Rank2, Rank.Rank2, Rank.Rank2, Rank.Rank2), rocket),
    ).toBeNull();
  });

  it('面对炸弹只能返回更大的炸弹或王炸（不得拆成四带二）', () => {
    const bomb5 = parseHand(hand(Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5));
    const got = findSmallestBeatingCards(
      hand(Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank3),
      bomb5,
    );
    expect(parseHand(got!).type).toBe(HandType.Bomb);
  });

  it('首出（Invalid）⇒ **最小**单张（旧实现返回最大单张）', () => {
    // 一条无法识别的组合（两张不同点数）⇒ `HandType.Invalid`（R203：不再 throw）
    const invalid = parseHand(hand(Rank.Rank3, Rank.Rank4));
    expect(invalid.type).toBe(HandType.Invalid);
    const got = findSmallestBeatingCards(hand(Rank.Rank9, Rank.Rank3, Rank.Rank7), invalid);
    expect(ranksOf(got)).toEqual([Rank.Rank3]);
  });

  it('王炸：只有王炸能压过「四带二 + 对 K」（同型四带二/炸弹都压不过 ⇒ 唯一解）', () => {
    const target = parseHand(
      hand(Rank.Rank10, Rank.Rank10, Rank.Rank10, Rank.Rank10, Rank.RankK, Rank.RankK),
    );
    expect(target.type).toBe(HandType.FourWithTwo);
    const got = findSmallestBeatingCards(hand(Rank.RankBlackJoker, Rank.RankRedJoker), target);
    expect(ranksOf(got)).toEqual(expectedRanks([Rank.RankBlackJoker, Rank.RankRedJoker]));
  });

  it('炸弹不得被拆（四条永远优先作为炸弹使用，不得当 kicker）', () => {
    // 手牌：三条 7 + 四条 5 + 单张 9。目标「三带一」必须用单张 9 当带牌，
    // 不得从四条 5 里抽一张（那会拆掉炸弹）。
    const target = parseHand(hand(Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank3));
    const got = findSmallestBeatingCards(
      hand(
        Rank.Rank7, Rank.Rank7, Rank.Rank7,
        Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank9,
      ),
      target,
    );
    expect(ranksOf(got)).toEqual(
      expectedRanks([Rank.Rank7, Rank.Rank7, Rank.Rank7, Rank.Rank9]),
    );
  });
});

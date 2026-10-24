/**
 * Task 3.5 / spec §5.7：跑得快 autoplay（超时/托管/规则 bot 共用）。
 *
 * 口径：
 *  - 首出：`chooseLeadPdk` 打最小单张；
 *  - 跟牌：`findSmallestBeatingPdk` —— 优先同型同 length 的**最小可压**，无解再找**最小炸弹**；
 *  - 关闭的牌型不得产出；炸弹可拆；返回的牌必须真实来自手牌且能被 `parsePdkHand` 判为合法。
 */
import { describe, expect, it } from 'vitest';
import {
  PdkHandType,
  parsePdkHand,
  type Card,
  type PdkParsedHand,
  type PdkRulesConfig,
} from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES } from './rules';
import { chooseLeadPdk, findSmallestBeatingPdk } from './autoplay';

const rules = (over: Partial<PdkRulesConfig> = {}): PdkRulesConfig => ({
  ...DEFAULT_PDK_RULES,
  ...over,
});

/** 按点数列表造手牌（花色按出现次序轮转 0..3）。 */
function hand(ranks: number[]): Card[] {
  return ranks.map((r, i) => ({ r, s: i % 4 }));
}

const chosen = (cards: Card[] | null): number[] | null =>
  cards === null ? null : cards.map((c) => c.r).sort((a, b) => a - b);

const target = (ranks: number[], r: PdkRulesConfig = rules()): PdkParsedHand =>
  parsePdkHand(hand(ranks), r);

describe('chooseLeadPdk：首出最小单张', () => {
  it('取点数最小的单张；同点取花色较小者', () => {
    const picked = chooseLeadPdk(
      [
        { r: 9, s: 2 },
        { r: 3, s: 3 },
        { r: 3, s: 0 },
      ],
      rules(),
    );
    expect(picked).toEqual([{ r: 3, s: 0 }]);
  });

  it('空手牌 ⇒ []（没有可出的动作；runtime 应先判结束）', () => {
    expect(chooseLeadPdk([], rules())).toEqual([]);
  });
});

describe('findSmallestBeatingPdk：同型最小可压', () => {
  it('单张：取 > target 的最小点数；无解 ⇒ null', () => {
    expect(chosen(findSmallestBeatingPdk(hand([3, 6, 7]), target([5]), rules()))).toEqual([6]);
    expect(findSmallestBeatingPdk(hand([3, 4]), target([5]), rules())).toBeNull();
  });

  it('对子 / 三张：同型最小；三张可以从四张里拆（炸弹可拆）', () => {
    expect(chosen(findSmallestBeatingPdk(hand([6, 6, 7]), target([5, 5]), rules()))).toEqual([6, 6]);
    // 四张 6 拆出三张 6 压三张 5
    const trio = findSmallestBeatingPdk(hand([6, 6, 6, 6, 9]), target([5, 5, 5]), rules());
    expect(chosen(trio)).toEqual([6, 6, 6]);
    expect(parsePdkHand(trio!, rules()).type).toBe(PdkHandType.Trio);
  });

  it('三带一 / 三带二：主体最小，带牌取最小合法组合', () => {
    expect(
      chosen(findSmallestBeatingPdk(hand([6, 6, 6, 3, 4]), target([5, 5, 5, 9]), rules())),
    ).toEqual([3, 6, 6, 6]);
    expect(
      chosen(
        findSmallestBeatingPdk(
          hand([6, 6, 6, 3, 3, 4]),
          target([5, 5, 5, 9, 9], rules({ trioWithPairEnabled: true })),
          rules({ trioWithPairEnabled: true }),
        ),
      ),
    ).toEqual([3, 3, 6, 6, 6]);
  });

  it('三带二关闭 ⇒ 不产出该牌型（防御）', () => {
    const t = { type: PdkHandType.TrioWithPair, keyRank: 5, length: 0 };
    expect(
      findSmallestBeatingPdk(
        hand([6, 6, 6, 3, 3]),
        t,
        rules({ trioWithPairEnabled: false }),
      ),
    ).toBeNull();
  });

  it('顺子：同 length、起点最小；可从四张里拆一张', () => {
    expect(
      chosen(findSmallestBeatingPdk(hand([4, 5, 6, 7, 8, 9]), target([3, 4, 5, 6, 7]), rules())),
    ).toEqual([4, 5, 6, 7, 8]);
    // 手牌里 8 有四张，仍可只取一张组顺子
    expect(
      chosen(
        findSmallestBeatingPdk(
          hand([4, 5, 6, 7, 8, 8, 8, 8]),
          target([3, 4, 5, 6, 7]),
          rules(),
        ),
      ),
    ).toEqual([4, 5, 6, 7, 8]);
    // 长度必须一致：目标 6 张顺子，手里只有 5 张的顺子 ⇒ 无解
    expect(
      findSmallestBeatingPdk(hand([4, 5, 6, 7, 8]), target([3, 4, 5, 6, 7, 8]), rules()),
    ).toBeNull();
  });

  it('连对：同对数、最大点数更大、起点最小', () => {
    expect(
      chosen(
        findSmallestBeatingPdk(
          hand([6, 6, 7, 7, 8, 8, 9]),
          target([3, 3, 4, 4, 5, 5]),
          rules(),
        ),
      ),
    ).toEqual([6, 6, 7, 7, 8, 8]);
  });

  it('飞机：裸飞机（开启时）；关闭时不产出', () => {
    const r = rules({ bareAirplaneEnabled: true });
    expect(
      chosen(findSmallestBeatingPdk(hand([5, 5, 5, 6, 6, 6, 9]), target([3, 3, 3, 4, 4, 4], r), r)),
    ).toEqual([5, 5, 5, 6, 6, 6]);
    expect(
      findSmallestBeatingPdk(
        hand([5, 5, 5, 6, 6, 6, 9]),
        target([3, 3, 3, 4, 4, 4], r),
        rules({ bareAirplaneEnabled: false }),
      ),
    ).toBeNull();
  });

  it('飞机带对 / 带单：形状跟随 target，翅膀取最小', () => {
    const pairsRules = rules({ airplaneWings: 'both' });
    const pairsTarget = target([3, 3, 3, 4, 4, 4, 7, 7, 8, 8], pairsRules);
    const pairs = findSmallestBeatingPdk(
      hand([5, 5, 5, 6, 6, 6, 7, 7, 8, 8]),
      pairsTarget,
      pairsRules,
    );
    expect(parsePdkHand(pairs!, pairsRules)).toMatchObject({
      type: PdkHandType.AirplaneWithWings,
      wingMode: 'pairs',
    });

    const singlesTarget = target([3, 3, 3, 4, 4, 4, 7, 8], pairsRules);
    const singles = findSmallestBeatingPdk(
      hand([5, 5, 5, 6, 6, 6, 7, 8]),
      singlesTarget,
      pairsRules,
    );
    expect(parsePdkHand(singles!, pairsRules)).toMatchObject({
      type: PdkHandType.AirplaneWithWings,
      wingMode: 'singles',
    });
    // wings=pairs 时不得产出带单
    expect(
      findSmallestBeatingPdk(
        hand([5, 5, 5, 6, 6, 6, 7, 8]),
        singlesTarget,
        rules({ airplaneWings: 'pairs' }),
      ),
    ).toBeNull();
  });

  it('四带二：主体最小；带牌默认不同点单牌，允许对子时取更小组合', () => {
    expect(
      chosen(findSmallestBeatingPdk(hand([6, 6, 6, 6, 3, 4]), target([5, 5, 5, 5, 8, 9]), rules())),
    ).toEqual([3, 4, 6, 6, 6, 6]);
    // 允许对子：33 < 34 ⇒ 取对子
    expect(
      chosen(
        findSmallestBeatingPdk(
          hand([6, 6, 6, 6, 3, 3, 4]),
          target([5, 5, 5, 5, 8, 9]),
          rules({ fourWithTwoPairKickerAllowed: true }),
        ),
      ),
    ).toEqual([3, 3, 6, 6, 6, 6]);
    // 关闭四带二 ⇒ 不产出
    expect(
      findSmallestBeatingPdk(
        hand([6, 6, 6, 6, 3, 4]),
        target([5, 5, 5, 5, 8, 9]),
        rules({ fourWithTwoEnabled: false }),
      ),
    ).toBeNull();
  });
});

describe('findSmallestBeatingPdk：炸弹兜底与炸弹对炸弹', () => {
  it('非炸弹目标：同型有解时优先同型，不浪费炸弹', () => {
    const picked = findSmallestBeatingPdk(
      hand([6, 3, 3, 3, 3]),
      target([5]),
      rules(),
    );
    expect(chosen(picked)).toEqual([6]);
  });

  it('非炸弹目标无同型解 ⇒ 最小炸弹（可压过任何非炸弹）', () => {
    const picked = findSmallestBeatingPdk(hand([3, 3, 3, 3, 9, 9, 9, 9]), target([10]), rules());
    expect(chosen(picked)).toEqual([3, 3, 3, 3]);
    expect(parsePdkHand(picked!, rules()).type).toBe(PdkHandType.Bomb);
  });

  it('炸弹目标：只能更大炸弹；无更大炸弹 ⇒ null', () => {
    expect(
      chosen(findSmallestBeatingPdk(hand([8, 8, 8, 8, 9, 9, 9, 9]), target([7, 7, 7, 7]), rules())),
    ).toEqual([8, 8, 8, 8]);
    expect(findSmallestBeatingPdk(hand([6, 6, 6, 6]), target([7, 7, 7, 7]), rules())).toBeNull();
  });

  it('target=Invalid（首出）⇒ 走 chooseLeadPdk；空手牌 ⇒ null', () => {
    const invalid: PdkParsedHand = { type: PdkHandType.Invalid, keyRank: 0, length: 0 };
    expect(chosen(findSmallestBeatingPdk(hand([9, 3]), invalid, rules()))).toEqual([3]);
    expect(findSmallestBeatingPdk([], invalid, rules())).toBeNull();
  });

  it('返回的牌全部来自手牌（多重集口径）', () => {
    const h = hand([3, 4, 5, 6, 7, 8, 9]);
    const picked = findSmallestBeatingPdk(h, target([3, 4, 5, 6, 7]), rules());
    expect(picked).not.toBeNull();
    const pool = h.map((c) => `${c.r},${c.s}`);
    for (const c of picked!) {
      const idx = pool.indexOf(`${c.r},${c.s}`);
      expect(idx).toBeGreaterThanOrEqual(0);
      pool.splice(idx, 1);
    }
  });
});

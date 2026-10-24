/**
 * Task 3.2 / spec §5.4：跑得快牌型解析与比较的真值表。
 *
 * 关键口径（全部由本文件钉住）：
 *  - AAA 不是炸弹（三张 A = 裸三张）；KKKK 是最大炸弹（黑桃 A 已去掉 ⇒ 四张 A 不存在）；
 *  - 顺子/连对/飞机取**最大点数**为 keyRank，且不含 2；
 *  - 飞机翅膀：pairs 默认；singles 点数两两不同；`both` 先 pairs 后 singles；
 *    翅膀不得与三张同点；**不得拆第 4 个三张**（333444555666 在裸飞机关闭时非法）；
 *  - 炸弹可拆（解析只看当前选中的牌，不看整手牌）。
 */
import { describe, expect, it } from 'vitest';
import type { Card } from '../views';
import type { PdkRulesConfig } from './rules';
import { PdkHandType, type PdkParsedHand } from './types';
import { canBeatPdk, parsePdkHand } from './rule';

/** 与 spec §4.7.1 / DEFAULT_PDK_RULES 同值（protocol 不能依赖 shared，测试内联一份）。 */
const BASE_RULES: PdkRulesConfig = {
  bareTrioEnabled: true,
  trioWithPairEnabled: false,
  bareAirplaneEnabled: false,
  fourWithTwoEnabled: true,
  fourWithTwoPairKickerAllowed: false,
  airplaneWings: 'pairs',
  bombMultiplierEnabled: true,
  guanMultiplierEnabled: true,
  springMultiplierEnabled: true,
  multiplierCap: 64,
  baobenEnabled: true,
};

const rules = (over: Partial<PdkRulesConfig> = {}): PdkRulesConfig => ({ ...BASE_RULES, ...over });

/** 只填点数；花色按出现次序轮转（解析器不看花色，但牌元仍是合法的 0..3）。 */
const cards = (ranks: number[]): Card[] => ranks.map((r, i) => ({ r, s: i % 4 }));

const parse = (ranks: number[], r: PdkRulesConfig = rules()): PdkParsedHand =>
  parsePdkHand(cards(ranks), r);

const INVALID: PdkParsedHand = { type: PdkHandType.Invalid, keyRank: 0, length: 0 };

describe('基础牌型', () => {
  it('单张 / 对子 / 红桃2（17）单张', () => {
    expect(parse([3])).toEqual({ type: PdkHandType.Single, keyRank: 3, length: 0 });
    expect(parse([17])).toEqual({ type: PdkHandType.Single, keyRank: 17, length: 0 });
    expect(parse([9, 9])).toEqual({ type: PdkHandType.Pair, keyRank: 9, length: 0 });
  });

  it('裸三张：默认开；关闭后非法（三带一不受影响）', () => {
    expect(parse([3, 3, 3])).toEqual({ type: PdkHandType.Trio, keyRank: 3, length: 0 });
    expect(parse([3, 3, 3], rules({ bareTrioEnabled: false }))).toEqual(INVALID);
    expect(parse([3, 3, 3, 4], rules({ bareTrioEnabled: false }))).toEqual({
      type: PdkHandType.TrioWithSingle,
      keyRank: 3,
      length: 0,
    });
  });

  it('AAA 是裸三张，不是炸弹（炸弹恰四张同点；KKKK 是最大炸弹）', () => {
    expect(parse([14, 14, 14])).toEqual({ type: PdkHandType.Trio, keyRank: 14, length: 0 });
    expect(parse([13, 13, 13, 13])).toEqual({ type: PdkHandType.Bomb, keyRank: 13, length: 4 });
  });

  it('三带一：3+1（带牌不同点）', () => {
    expect(parse([5, 5, 5, 9])).toEqual({ type: PdkHandType.TrioWithSingle, keyRank: 5, length: 0 });
  });

  it('三带二：默认关；开启后 3+2 合法，关闭时非法', () => {
    expect(parse([5, 5, 5, 9, 9])).toEqual(INVALID);
    expect(parse([5, 5, 5, 9, 9], rules({ trioWithPairEnabled: true }))).toEqual({
      type: PdkHandType.TrioWithPair,
      keyRank: 5,
      length: 0,
    });
  });

  it('四带二：默认开；两张带牌默认必须不同点；允许对子带牌时 4+对 合法', () => {
    expect(parse([5, 5, 5, 5, 8, 9])).toEqual({
      type: PdkHandType.FourWithTwo,
      keyRank: 5,
      length: 0,
    });
    expect(parse([5, 5, 5, 5, 8, 8])).toEqual(INVALID);
    expect(parse([5, 5, 5, 5, 8, 8], rules({ fourWithTwoPairKickerAllowed: true }))).toEqual({
      type: PdkHandType.FourWithTwo,
      keyRank: 5,
      length: 0,
    });
    expect(parse([5, 5, 5, 5, 8, 9], rules({ fourWithTwoEnabled: false }))).toEqual(INVALID);
  });

  it('炸弹：恰四张同点；四带二的四张不是炸弹', () => {
    expect(parse([5, 5, 5, 5])).toEqual({ type: PdkHandType.Bomb, keyRank: 5, length: 4 });
    expect(parse([5, 5, 5, 5, 8, 9])!.type).toBe(PdkHandType.FourWithTwo);
  });

  it('炸弹可拆：手里有四张 7，只出三张 7 带一张 8 仍然是三带一', () => {
    // 解析只看**当前选中的牌**（整手牌是否有第 4 张 7 不影响）。
    expect(parse([7, 7, 7, 8])).toEqual({
      type: PdkHandType.TrioWithSingle,
      keyRank: 7,
      length: 0,
    });
  });
});

describe('顺子 / 连对（3–A，不含 2；keyRank 取最大点数）', () => {
  it('顺子 ≥5 张连续单牌；A 可作最高', () => {
    expect(parse([3, 4, 5, 6, 7])).toEqual({ type: PdkHandType.Straight, keyRank: 7, length: 5 });
    expect(parse([10, 11, 12, 13, 14])).toEqual({
      type: PdkHandType.Straight,
      keyRank: 14,
      length: 5,
    });
  });

  it('4 张连续单牌不是顺子；含 2 也不是顺子', () => {
    expect(parse([3, 4, 5, 6])).toEqual(INVALID);
    expect(parse([11, 12, 13, 14, 17])).toEqual(INVALID); // JQKA2
  });

  it('连对 ≥2 个连续对子；同样不含 2', () => {
    expect(parse([3, 3, 4, 4])).toEqual({
      type: PdkHandType.ConsecutivePairs,
      keyRank: 4,
      length: 2,
    });
    expect(parse([3, 3, 4, 4, 5, 5])).toEqual({
      type: PdkHandType.ConsecutivePairs,
      keyRank: 5,
      length: 3,
    });
    expect(parse([13, 13, 14, 14])).toEqual({
      type: PdkHandType.ConsecutivePairs,
      keyRank: 14,
      length: 2,
    });
    expect(parse([14, 14, 17, 17])).toEqual(INVALID);
  });

  it('顺子/连对不连续或点数重复形状 ⇒ 非法', () => {
    expect(parse([3, 4, 5, 6, 8])).toEqual(INVALID);
    expect(parse([3, 3, 4, 5])).toEqual(INVALID);
  });
});

describe('飞机与翅膀（H17 口径）', () => {
  it('裸飞机：默认关；开启后两个连续三张合法', () => {
    expect(parse([3, 3, 3, 4, 4, 4])).toEqual(INVALID);
    expect(parse([3, 3, 3, 4, 4, 4], rules({ bareAirplaneEnabled: true }))).toEqual({
      type: PdkHandType.Airplane,
      keyRank: 4,
      length: 2,
    });
  });

  it('飞机带对（默认）：2 个三张 + 2 个不同点对子', () => {
    expect(parse([3, 3, 3, 4, 4, 4, 5, 5, 6, 6])).toEqual({
      type: PdkHandType.AirplaneWithWings,
      keyRank: 4,
      length: 2,
      wingMode: 'pairs',
    });
  });

  it('飞机带单：仅在 singles/both 下合法；单翅点数两两不同', () => {
    expect(parse([3, 3, 3, 4, 4, 4, 5, 6])).toEqual(INVALID); // 默认 pairs
    expect(
      parse([3, 3, 3, 4, 4, 4, 5, 6], rules({ airplaneWings: 'singles' })),
    ).toEqual({
      type: PdkHandType.AirplaneWithWings,
      keyRank: 4,
      length: 2,
      wingMode: 'singles',
    });
    // 单翅同点（5,5）非法
    expect(
      parse([3, 3, 3, 4, 4, 4, 5, 5], rules({ airplaneWings: 'singles' })),
    ).toEqual(INVALID);
  });

  it('both：先 pairs、再 singles；wingMode 是区分位', () => {
    expect(
      parse([3, 3, 3, 4, 4, 4, 5, 5, 6, 6], rules({ airplaneWings: 'both' })),
    ).toMatchObject({ type: PdkHandType.AirplaneWithWings, wingMode: 'pairs' });
    expect(
      parse([3, 3, 3, 4, 4, 4, 5, 6], rules({ airplaneWings: 'both' })),
    ).toMatchObject({ type: PdkHandType.AirplaneWithWings, wingMode: 'singles' });
  });

  it('翅膀不得与三张同点；对翅点数不得重复', () => {
    // 333 + 444 + 33 + 55：5 张 3 ⇒ 拆出的 33 与三张同点 ⇒ 非法
    expect(parse([3, 3, 3, 3, 3, 4, 4, 4, 5, 5])).toEqual(INVALID);
    // 对翅同点（四张 5）⇒ 不是两个不同点的对子
    expect(parse([3, 3, 3, 4, 4, 4, 5, 5, 5, 5])).toEqual(INVALID);
  });

  it('不得拆第 4 个三张：333444555666 在裸飞机关闭时非法（singles/both 亦然）', () => {
    for (const airplaneWings of ['pairs', 'singles', 'both'] as const) {
      expect(
        parse([3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6], rules({ airplaneWings })),
      ).toEqual(INVALID);
    }
    expect(
      parse(
        [3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6],
        rules({ bareAirplaneEnabled: true }),
      ),
    ).toEqual({ type: PdkHandType.Airplane, keyRank: 6, length: 4 });
  });

  it('飞机序列不含 2；A 可作最高（QQQKKKAAA）', () => {
    expect(parse([12, 12, 12, 13, 13, 13, 14, 14, 14], rules({ bareAirplaneEnabled: true })))
      .toEqual({ type: PdkHandType.Airplane, keyRank: 14, length: 3 });
    expect(parse([14, 14, 14, 17, 17, 17], rules({ bareAirplaneEnabled: true }))).toEqual(INVALID);
  });
});

describe('canBeatPdk：同型比较 / 炸弹 / 形状不可互压', () => {
  const cc = (ranks: number[], r: PdkRulesConfig = rules()): PdkParsedHand => parse(ranks, r);

  it('同型同长度：主键大者胜；相等不胜', () => {
    expect(canBeatPdk(cc([4]), cc([3]), rules())).toBe(true);
    expect(canBeatPdk(cc([3]), cc([4]), rules())).toBe(false);
    expect(canBeatPdk(cc([3]), cc([3]), rules())).toBe(false);
  });

  it('A 高顺压 7 高顺（keyRank 取最大，不是最小）', () => {
    expect(cc([10, 11, 12, 13, 14]).keyRank).toBe(14);
    expect(canBeatPdk(cc([10, 11, 12, 13, 14]), cc([3, 4, 5, 6, 7]), rules())).toBe(true);
  });

  it('同型不同长度不能比（顺子 5 vs 6、连对 2 vs 3、飞机 2 vs 3）', () => {
    expect(canBeatPdk(cc([4, 5, 6, 7, 8, 9]), cc([3, 4, 5, 6, 7]), rules())).toBe(false);
    expect(canBeatPdk(cc([4, 4, 5, 5, 6, 6]), cc([3, 3, 4, 4]), rules())).toBe(false);
    expect(
      canBeatPdk(
        cc([4, 4, 4, 5, 5, 5, 6, 6, 6], rules({ bareAirplaneEnabled: true })),
        cc([3, 3, 3, 4, 4, 4], rules({ bareAirplaneEnabled: true })),
        rules({ bareAirplaneEnabled: true }),
      ),
    ).toBe(false);
  });

  it('炸弹压任何非炸弹；非炸弹压不过炸弹；炸弹之间按点数', () => {
    const straightA = cc([10, 11, 12, 13, 14]);
    expect(canBeatPdk(cc([3, 3, 3, 3]), straightA, rules())).toBe(true);
    expect(canBeatPdk(straightA, cc([3, 3, 3, 3]), rules())).toBe(false);
    expect(canBeatPdk(cc([13, 13, 13, 13]), cc([12, 12, 12, 12]), rules())).toBe(true);
    expect(canBeatPdk(cc([12, 12, 12, 12]), cc([13, 13, 13, 13]), rules())).toBe(false);
    expect(canBeatPdk(cc([13, 13, 13, 13]), cc([13, 13, 13, 13]), rules())).toBe(false);
  });

  it('飞机带单与飞机带对不可互压（both 模式下 wingMode 区分）', () => {
    const pairWings = cc([3, 3, 3, 4, 4, 4, 5, 5, 6, 6], rules({ airplaneWings: 'both' }));
    const singleWings = cc([3, 3, 3, 4, 4, 4, 5, 6], rules({ airplaneWings: 'both' }));
    expect(singleWings.wingMode).toBe('singles');
    expect(pairWings.wingMode).toBe('pairs');
    expect(canBeatPdk(singleWings, pairWings, rules({ airplaneWings: 'both' }))).toBe(false);
    expect(canBeatPdk(pairWings, singleWings, rules({ airplaneWings: 'both' }))).toBe(false);
  });

  it('不同牌型不可互压；Invalid 永远不胜/不被胜', () => {
    expect(canBeatPdk(cc([4, 4]), cc([3]), rules())).toBe(false);
    expect(canBeatPdk(cc([4, 4, 4, 5]), cc([3, 3, 3]), rules())).toBe(false);
    expect(canBeatPdk(INVALID, cc([3]), rules())).toBe(false);
    expect(canBeatPdk(cc([3]), INVALID, rules())).toBe(false);
  });

  it('防御：牌型在当前规则快照下被关闭 ⇒ 不可参与比较', () => {
    const trio = { type: PdkHandType.Trio, keyRank: 5, length: 0 };
    const pair = cc([4, 4]);
    expect(canBeatPdk(trio, pair, rules({ bareTrioEnabled: false }))).toBe(false);
    expect(canBeatPdk(pair, trio, rules({ bareTrioEnabled: false }))).toBe(false);
  });
});

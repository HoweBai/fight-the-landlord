import { describe, expect, it } from 'vitest';
import { PdkHandType, parsePdkHand, type Card, type PdkRulesConfig } from '@fight-the-landlord/protocol';
import { suggestPdkPlays } from '../src/game/pdk-hint';

/**
 * 审查 P1-1/P2-1：首出提示必须覆盖 14/16 张合法组合，且不得再靠
 * 「枚举 1..12 + 特判 15」的任意子集暴力（65k 组合、~55ms、漏 7/8 连对）。
 *
 * 这里用**差分测试**证明结构化生成与「全部子集 + parsePdkHand」等价：
 * 牌型只看点数多重集，花色只影响具体选哪张，故按 rank key 比较。
 */
const DEFAULT_RULES: PdkRulesConfig = {
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

const card = (r: number, s: number): Card => ({ r, s });
const rankKey = (cards: readonly Card[]): string =>
  cards.map((c) => c.r).sort((a, b) => a - b).join(',');

function bruteRankKeys(hand: readonly Card[], rules: PdkRulesConfig): Set<string> {
  const found = new Set<string>();
  const n = hand.length;
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const picked: Card[] = [];
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) picked.push(hand[i]!);
    if (parsePdkHand(picked, rules).type !== PdkHandType.Invalid) found.add(rankKey(picked));
  }
  return found;
}

const structuredRankKeys = (hand: readonly Card[], rules: PdkRulesConfig): Set<string> =>
  new Set(suggestPdkPlays(hand, null, rules).map(rankKey));

/** 3–10 各两张 = 16 张八连对。 */
const eightPairs: Card[] = [3, 4, 5, 6, 7, 8, 9, 10].flatMap((r) => [card(r, 0), card(r, 1)]);

/** 3–9 各两张（14 张七连对）+ K/A 两张单牌 = 16 张。 */
const sevenPairsPlus: Card[] = [
  ...([3, 4, 5, 6, 7, 8, 9] as const).flatMap((r) => [card(r, 0), card(r, 1)]),
  card(13, 0),
  card(14, 0),
];

/** 3/4/5/6 各三张（12）+ 7/8/9/10 四张单牌 = 16 张（4 连三 + 4 单）。 */
const fourTrioFourSingles: Card[] = [
  ...([3, 4, 5, 6] as const).flatMap((r) => [card(r, 0), card(r, 1), card(r, 2)]),
  card(7, 0),
  card(8, 0),
  card(9, 0),
  card(10, 0),
];

/** 四个炸弹 = 16 张（四张同点可拆三/四带二）。 */
const fourBombs: Card[] = [3, 4, 5, 6].flatMap((r) => [0, 1, 2, 3].map((s) => card(r, s)));

/** 混合手牌（重复点数 + 顺子尾巴）。 */
const mixed: Card[] = [
  card(3, 0), card(3, 1), card(4, 0), card(5, 0), card(5, 1), card(5, 2),
  card(6, 0), card(7, 0), card(8, 0), card(9, 0), card(9, 1), card(10, 0),
  card(11, 0), card(12, 0), card(13, 0), card(14, 0),
];

describe('提示结构化生成：14/16 张与差分等价（审查 P1-1/P2-1）', () => {
  it('八连对（16 张）可被首出提示', () => {
    const plays = suggestPdkPlays(eightPairs, null, DEFAULT_RULES);
    expect(plays.map(rankKey)).toContain('3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10');
  });

  it('七连对（14 张）可被首出提示', () => {
    const plays = suggestPdkPlays(sevenPairsPlus, null, DEFAULT_RULES);
    expect(plays.map(rankKey)).toContain('3,3,4,4,5,5,6,6,7,7,8,8,9,9');
  });

  it('4 连三 + 4 单（16 张）在 wings=both 时可被提示', () => {
    const rules = { ...DEFAULT_RULES, airplaneWings: 'both' as const };
    const plays = suggestPdkPlays(fourTrioFourSingles, null, rules);
    expect(plays.map(rankKey)).toContain('3,3,3,4,4,4,5,5,5,6,6,6,7,8,9,10');
  });

  it('4 人 12 张：6 连对 / 12 顺 / 4 裸三均可提示', () => {
    const sixPairs: Card[] = [3, 4, 5, 6, 7, 8].flatMap((r) => [card(r, 0), card(r, 1)]);
    expect(suggestPdkPlays(sixPairs, null, DEFAULT_RULES).map(rankKey)).toContain(
      '3,3,4,4,5,5,6,6,7,7,8,8',
    );

    const straight: Card[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((r) => card(r, 0));
    expect(suggestPdkPlays(straight, null, DEFAULT_RULES).map(rankKey)).toContain(
      '3,4,5,6,7,8,9,10,11,12,13,14',
    );

    const trios: Card[] = [3, 4, 5, 6].flatMap((r) => [card(r, 0), card(r, 1), card(r, 2)]);
    expect(
      suggestPdkPlays(trios, null, { ...DEFAULT_RULES, bareAirplaneEnabled: true }).map(rankKey),
    ).toContain('3,3,3,4,4,4,5,5,5,6,6,6');
  });

  it.each([
    ['八连对', eightPairs],
    ['七连对+单', sevenPairsPlus],
    ['4 连三+4 单', fourTrioFourSingles],
    ['四炸弹', fourBombs],
    ['混合手牌', mixed],
  ])('差分：%s 的结构化集合 = 全子集暴力集合', (_label, hand) => {
    expect(structuredRankKeys(hand, DEFAULT_RULES)).toEqual(bruteRankKeys(hand, DEFAULT_RULES));
  });

  it('差分：规则开关变体下仍等价（三带二/裸飞机/翅膀 both/对子带牌）', () => {
    const rules: PdkRulesConfig = {
      ...DEFAULT_RULES,
      trioWithPairEnabled: true,
      bareAirplaneEnabled: true,
      fourWithTwoPairKickerAllowed: true,
      airplaneWings: 'both',
    };
    for (const hand of [sevenPairsPlus, fourTrioFourSingles, fourBombs]) {
      expect(structuredRankKeys(hand, rules)).toEqual(bruteRankKeys(hand, rules));
    }
  });

  it('候选数上界：最坏 16 张手牌 < 2000（当前子集枚举为 4008）', () => {
    for (const hand of [eightPairs, mixed]) {
      expect(suggestPdkPlays(hand, null, DEFAULT_RULES).length).toBeLessThan(2000);
    }
  });
});

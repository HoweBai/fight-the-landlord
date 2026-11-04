import { describe, expect, it } from 'vitest';
import type { Tile } from '@fight-the-landlord/protocol';
import { EMPTY_HU_CONTEXT } from './features';
import { canHuShape, huDecompositions, isSevenPairs } from './hu';
import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES } from './rules';
import { scoreBestHand } from './scoring';
import { tingTiles } from './ting';

const t = (s: 0 | 1 | 2, r: number): Tile => ({ s, r });
const tiles = (s: 0 | 1 | 2, ranks: number[]): Tile[] => ranks.map((r) => t(s, r));
const score = (hand: Tile[], lack: 0 | 1 | 2 = 2, rules = DEFAULT_CHENGDU_RULES, winning?: Tile) =>
  scoreBestHand({
    hand,
    melds: [],
    lackSuit: lack,
    winningTile: winning ?? hand[hand.length - 1]!,
    context: EMPTY_HU_CONTEXT,
    rules,
  });

describe('mahjong hu decomposition', () => {
  it('标准型：4 副 + 将', () => {
    const hand = [
      ...tiles(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3]),
      t(1, 5),
      t(1, 5),
    ];
    expect(canHuShape(hand, [], 2)).toBe(true);
    expect(huDecompositions(hand, [], 2).length).toBeGreaterThan(0);
  });

  it('缺门有牌 ⇒ 不能胡', () => {
    const hand = [...tiles(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3]), t(2, 5), t(2, 5)];
    expect(canHuShape(hand, [], 2)).toBe(false);
  });

  it('七对：四张算两对', () => {
    const hand = [
      ...tiles(0, [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]),
    ];
    expect(isSevenPairs(hand)).toBe(true);
    expect(canHuShape(hand, [], 1)).toBe(true);
  });
});

describe('chengdu named scoring', () => {
  it('平胡 1 番 ×1', () => {
    const hand = [...tiles(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3]), t(1, 5), t(1, 5)];
    const r = score(hand, 2);
    expect(r.baseName).toBe('pingHu');
    expect(r.fan).toBe(1);
    expect(r.multiplier).toBe(1);
  });

  it('对对胡 2 番 ×2', () => {
    const hand = [...tiles(0, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]), t(1, 5), t(1, 5)];
    const r = score(hand, 2, DEFAULT_CHENGDU_RULES, t(0, 4));
    expect(r.baseName).toBe('duiDuiHu');
    expect(r.fan).toBe(2);
    expect(r.multiplier).toBe(2);
  });

  it('清一色 3 番 ×4', () => {
    const hand = [...tiles(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4]), t(0, 5), t(0, 5)];
    const r = score(hand, 1);
    expect(r.baseName).toBe('qingYiSe');
    expect(r.fan).toBe(3);
    expect(r.multiplier).toBe(4);
  });

  it('七对 3 番；龙七对 5 番（定义四张不计根）', () => {
    const qidui = [...tiles(0, [1, 1, 2, 2, 3, 3]), ...tiles(1, [4, 4, 5, 5, 6, 6, 7, 7])];
    const q = score(qidui, 2);
    expect(q.baseName).toBe('qiDui');
    expect(q.fan).toBe(3);

    const long = [...tiles(0, [1, 1, 1, 1, 2, 2, 3, 3]), ...tiles(1, [4, 4, 5, 5, 6, 6])];
    const l = score(long, 2);
    expect(l.baseName).toBe('longQiDui');
    expect(l.fan).toBe(5);
    expect(l.multiplier).toBe(16);
    expect(l.items.join('|')).not.toContain('根');
  });

  it('清龙七对 6 番 ×32', () => {
    const hand = [...tiles(0, [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6])];
    const r = score(hand, 1);
    expect(r.baseName).toBe('qingLongQiDui');
    expect(r.fan).toBe(6);
    expect(r.multiplier).toBe(32);
  });

  it('天胡/地胡开启时只算该主番', () => {
    const rules = { ...DEFAULT_CHENGDU_RULES, optionalFans: { ...DEFAULT_CHENGDU_RULES.optionalFans, tianHu: 6 } };
    const hand = [...tiles(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3]), t(1, 5), t(1, 5)];
    const r = scoreBestHand({
      hand,
      melds: [],
      lackSuit: 2,
      winningTile: hand[hand.length - 1]!,
      context: { ...EMPTY_HU_CONTEXT, tianHu: true, selfDraw: true },
      rules,
    });
    expect(r.baseName).toBe('tianHu');
    expect(r.fan).toBe(6);
    expect(r.items).toEqual(['天胡+6']);
  });
});

describe('sbr additive scoring', () => {
  it('3 番封顶：清一色+七对+根 = 5 → 3 / 8 分', () => {
    const hand = [...tiles(0, [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6])];
    const r = score(hand, 1, DEFAULT_SBR_RULES);
    expect(r.fan).toBe(3);
    expect(r.multiplier).toBe(8);
  });

  it('自摸加 1 分（addPoint）', () => {
    const hand = [...tiles(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3]), t(1, 5), t(1, 5)];
    const r = scoreBestHand({
      hand,
      melds: [],
      lackSuit: 2,
      winningTile: hand[hand.length - 1]!,
      context: { ...EMPTY_HU_CONTEXT, selfDraw: true },
      rules: DEFAULT_SBR_RULES,
    });
    expect(r.fan).toBe(0);
    expect(r.selfDrawBonusBase).toBe(1);
  });
});

describe('ting', () => {
  it('13 张听 4 筒', () => {
    const hand = [...tiles(0, [1, 2, 3, 4, 5, 6, 7, 8, 9]), ...tiles(1, [1, 1, 2, 3])];
    const waits = tingTiles(hand, [], 2, DEFAULT_CHENGDU_RULES);
    expect(waits).toEqual([t(1, 1), t(1, 4)]);
  });

  it('三番起胡：平胡听牌不算听', () => {
    const rules = { ...DEFAULT_CHENGDU_RULES, minFanToHu: 3 };
    const hand = [...tiles(0, [1, 2, 3, 4, 5, 6, 7, 8, 9]), ...tiles(1, [1, 1, 2, 3])];
    expect(tingTiles(hand, [], 2, rules)).toEqual([]);
  });
});

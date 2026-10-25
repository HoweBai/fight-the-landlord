import { describe, expect, it } from 'vitest';
import type { Card, PdkRulesConfig } from '@fight-the-landlord/protocol';
import { cueForPdkPlay } from '../src/audio/pdk-play-cues';

/**
 * 跑得快牌型 → 语音 cue（2026-10-25）。
 *
 * fixture 约束（48 张牌堆）：重复点数只用 3–13；A 用 s∈{1,2,3}；2 只用 {r:17,s:1}；
 * 炸弹固定 7。`Pair15/Trio15` 是合成牌（牌堆只有一张 2），显式豁免。
 */
const RULES: PdkRulesConfig = {
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

const c = (r: number, s = 1): Card => ({ r, s });

describe('cueForPdkPlay：牌型 → 语音', () => {
  it('单张/对子/三张按点数选音；2 → *15', () => {
    expect(cueForPdkPlay([c(3)], RULES)).toBe('Single3');
    expect(cueForPdkPlay([c(12)], RULES)).toBe('Single12'); // Q 是合法单张
    expect(cueForPdkPlay([c(14)], RULES)).toBe('Single14');
    expect(cueForPdkPlay([c(17)], RULES)).toBe('Single15');

    expect(cueForPdkPlay([c(7, 1), c(7, 2)], RULES)).toBe('Pair7');
    expect(cueForPdkPlay([c(14, 1), c(14, 2)], RULES)).toBe('Pair14');
    // 合成牌（真实牌堆只有一张 2）
    expect(cueForPdkPlay([c(17, 1), c(17, 1)], RULES)).toBe('Pair15');

    expect(cueForPdkPlay([c(7, 1), c(7, 2), c(7, 3)], RULES)).toBe('Trio7');
  });

  it('顺子/连对/飞机/三带一/四带二/炸弹', () => {
    expect(cueForPdkPlay([3, 4, 5, 6, 7].map((r) => c(r)), RULES)).toBe('Straight');
    expect(cueForPdkPlay([c(3, 1), c(3, 2), c(4, 1), c(4, 2)], RULES)).toBe('PairStraight');
    expect(cueForPdkPlay([c(7, 1), c(7, 2), c(7, 3), c(3)], RULES)).toBe('TrioWithSingle');
    expect(
      cueForPdkPlay([c(7, 1), c(7, 2), c(7, 3), c(3, 1), c(3, 2)], {
        ...RULES,
        trioWithPairEnabled: true,
      }),
    ).toBe('TrioWithPair');
    expect(
      cueForPdkPlay([c(7, 0), c(7, 1), c(7, 2), c(7, 3), c(3), c(4)], RULES),
    ).toBe('FourWithTwo');
    expect(
      cueForPdkPlay([c(7, 0), c(7, 1), c(7, 2), c(7, 3)], RULES),
    ).toBe('Bomb');
  });

  it('规则开关：关闭的牌型 ⇒ null；对子带牌/翅膀形态按规则选音', () => {
    expect(
      cueForPdkPlay([c(7, 1), c(7, 2), c(7, 3)], { ...RULES, bareTrioEnabled: false }),
    ).toBeNull();
    expect(
      cueForPdkPlay([c(7, 1), c(7, 2), c(7, 3), c(3, 1), c(3, 2)], RULES),
    ).toBeNull(); // trioWithPairEnabled 默认 false
    expect(
      cueForPdkPlay([c(7, 0), c(7, 1), c(7, 2), c(7, 3), c(3), c(4)], {
        ...RULES,
        fourWithTwoEnabled: false,
      }),
    ).toBeNull();
    expect(
      cueForPdkPlay([c(7, 0), c(7, 1), c(7, 2), c(7, 3), c(3, 1), c(3, 2)], {
        ...RULES,
        fourWithTwoPairKickerAllowed: true,
      }),
    ).toBe('FourWithTwo');
    expect(
      cueForPdkPlay([c(3, 1), c(3, 2), c(3, 3), c(4, 1), c(4, 2), c(4, 3)], {
        ...RULES,
        bareAirplaneEnabled: true,
      }),
    ).toBe('Plane');
    expect(
      cueForPdkPlay([c(3, 1), c(3, 2), c(3, 3), c(4, 1), c(4, 2), c(4, 3)], RULES),
    ).toBeNull(); // bareAirplaneEnabled 默认 false
    expect(
      cueForPdkPlay(
        [c(3, 1), c(3, 2), c(3, 3), c(4, 1), c(4, 2), c(4, 3), c(5, 1), c(5, 2), c(6, 1), c(6, 2)],
        RULES,
      ),
    ).toBe('Plane'); // 带两对翅膀
    expect(
      cueForPdkPlay(
        [c(3, 1), c(3, 2), c(3, 3), c(4, 1), c(4, 2), c(4, 3), c(5), c(6)],
        { ...RULES, airplaneWings: 'singles' },
      ),
    ).toBe('Plane');
  });

  it('空牌/非法/无 rules/王 ⇒ null；不抛', () => {
    expect(cueForPdkPlay([], RULES)).toBeNull();
    expect(cueForPdkPlay([c(3), c(5)], RULES)).toBeNull();
    expect(cueForPdkPlay([c(20, 4)], RULES)).toBeNull(); // 小王
    expect(cueForPdkPlay([c(30, 4)], RULES)).toBeNull(); // 大王
    expect(cueForPdkPlay([c(3)], null)).toBeNull();
    expect(cueForPdkPlay([c(3)], undefined)).toBeNull();
    expect(() => cueForPdkPlay([c(3)], { ...RULES, airplaneWings: 'nope' as never })).not.toThrow();
  });
});

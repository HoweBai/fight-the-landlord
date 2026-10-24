import { describe, it, expect } from 'vitest';
import { PDK_AIRPLANE_WINGS, type PdkRulesConfig } from './rules';

describe('PdkRulesConfig 契约', () => {
  it('翅膀枚举恰为 pairs/singles/both', () => {
    expect(PDK_AIRPLANE_WINGS).toEqual(['pairs', 'singles', 'both']);
  });

  it('默认配置的形状可赋值给契约类型', () => {
    const config: PdkRulesConfig = {
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
    expect(config.airplaneWings).toBe('pairs');
  });
});

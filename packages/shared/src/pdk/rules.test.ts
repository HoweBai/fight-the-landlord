import { describe, it, expect } from 'vitest';
import { ProtocolError, type PdkRulesConfig } from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES, parsePdkRules } from './rules';

describe('DEFAULT_PDK_RULES', () => {
  it('与 spec §4.7.1 默认值一致', () => {
    expect(DEFAULT_PDK_RULES).toEqual({
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
    } satisfies PdkRulesConfig);
  });

  it('默认对象冻结，调用方不能改坏', () => {
    expect(Object.isFrozen(DEFAULT_PDK_RULES)).toBe(true);
  });
});

describe('parsePdkRules', () => {
  it('undefined/null ⇒ 默认值副本（不是同一引用）', () => {
    const a = parsePdkRules(undefined);
    const b = parsePdkRules(null);
    expect(a).toEqual(DEFAULT_PDK_RULES);
    expect(b).toEqual(DEFAULT_PDK_RULES);
    expect(a).not.toBe(DEFAULT_PDK_RULES);
    expect(a).not.toBe(b);
  });

  it('部分键合并默认值', () => {
    expect(parsePdkRules({ trioWithPairEnabled: true, multiplierCap: 16 })).toEqual({
      ...DEFAULT_PDK_RULES,
      trioWithPairEnabled: true,
      multiplierCap: 16,
    });
  });

  it('严格类型：boolean/枚举/cap 范围', () => {
    expect(() => parsePdkRules({ bareTrioEnabled: 'true' })).toThrow(ProtocolError);
    expect(() => parsePdkRules({ airplaneWings: 'pair' })).toThrow(ProtocolError);
    expect(() => parsePdkRules({ multiplierCap: 0 })).toThrow(ProtocolError);
    expect(() => parsePdkRules({ multiplierCap: 1025 })).toThrow(ProtocolError);
    expect(() => parsePdkRules({ multiplierCap: 1.5 })).toThrow(ProtocolError);
  });

  it('未知键抛错（防拼写漂移）', () => {
    expect(() => parsePdkRules({ barenTrioEnabled: true })).toThrow(/unknown key/);
  });

  it('非对象抛错', () => {
    expect(() => parsePdkRules('x')).toThrow(ProtocolError);
    expect(() => parsePdkRules([])).toThrow(ProtocolError);
  });
});

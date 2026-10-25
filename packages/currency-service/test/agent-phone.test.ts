import { describe, expect, it } from 'vitest';
import { hmacPhone, maskPhone, normalizePhone } from '../src/agent/agent.util';

/**
 * 2026-10-26 r3 审查 Important #2：自玩特判依赖「同一手机号 ⇒ 同一 HMAC」。
 * 只 trim 时 `+86`/分隔符/全角变体都能绕过 ⇒ 代理可在自己名下拿佣金。
 */
describe('normalizePhone：手机号归一（自玩 HMAC 的唯一输入）', () => {
  it('11 位本地号原样', () => {
    expect(normalizePhone('13800000000')).toBe('13800000000');
    expect(normalizePhone(' 13800000000 ')).toBe('13800000000');
  });

  it('+86 / 86 / 0086 前缀与分隔符归一为 11 位', () => {
    expect(normalizePhone('+8613800000000')).toBe('13800000000');
    expect(normalizePhone('+86 138-0000-0000')).toBe('13800000000');
    expect(normalizePhone('8613800000000')).toBe('13800000000');
    expect(normalizePhone('008613800000000')).toBe('13800000000');
    expect(normalizePhone('(138) 0000 0000')).toBe('13800000000');
  });

  it('全角数字归一', () => {
    expect(normalizePhone('１３８００００００００')).toBe('13800000000');
  });

  it('不认识/非手机号格式保留 trim 原值（不擅自改写）', () => {
    expect(normalizePhone(' agent-x ')).toBe('agent-x');
    expect(normalizePhone('12345')).toBe('12345');
    expect(normalizePhone('23800000000')).toBe('23800000000'); // 非 1 开头
  });

  it('变体号与本地号 HMAC 相等（自玩特判不可绕过）', () => {
    const base = hmacPhone('13800000000');
    expect(hmacPhone('+8613800000000')).toBe(base);
    expect(hmacPhone('138-0000-0000')).toBe(base);
    expect(hmacPhone(' 13800000000 ')).toBe(base);
    expect(hmacPhone('１３８００００００００')).toBe(base);
    expect(hmacPhone('13900000000')).not.toBe(base);
  });

  it('脱敏基于归一值', () => {
    expect(maskPhone('+8613800001234')).toBe('138****1234');
  });
});

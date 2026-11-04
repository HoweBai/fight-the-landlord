import { describe, expect, it } from 'vitest';
import { affectedRowsOf } from '../src/agent/agent-sql.util';

describe('affectedRowsOf', () => {
  it('正常返回整数；缺失/非整数抛错', () => {
    expect(affectedRowsOf({ affectedRows: 1 }, 'x')).toBe(1);
    expect(affectedRowsOf({ affectedRows: 0 }, 'x')).toBe(0);
    expect(() => affectedRowsOf({}, 'x')).toThrow(/affectedRows/);
    expect(() => affectedRowsOf({ affectedRows: 1.5 }, 'x')).toThrow(/affectedRows/);
    expect(() => affectedRowsOf(null, 'x')).toThrow(/affectedRows/);
  });
});

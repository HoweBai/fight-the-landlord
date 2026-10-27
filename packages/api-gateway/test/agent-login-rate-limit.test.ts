import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_LOGIN_FAIL,
  clearAgentLoginFailures,
  isAgentLoginBlocked,
  recordAgentLoginFailure,
} from '../src/http/rate-limit';

function makeRedis() {
  const counters = new Map<string, number>();
  const redis = {
    get: vi.fn(async (key: string) => (counters.has(key) ? String(counters.get(key)) : null)),
    incr: vi.fn(async (key: string) => {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n;
    }),
    pexpire: vi.fn(async () => 1),
    del: vi.fn(async (key: string) => {
      counters.delete(key);
      return 1;
    }),
  };
  return { redis, counters };
}

describe('代理登录失败桶（与 admin 桶独立）', () => {
  it('键形状 ratelimit:agent-login-fail:<ip>；阈值 5/5min', () => {
    expect(AGENT_LOGIN_FAIL).toEqual({ max: 5, windowMs: 300_000 });
  });

  it('第 1 次失败设 PEXPIRE；第 5 次后 blocked；clear 解锁', async () => {
    const { redis, counters } = makeRedis();
    const ip = '1.2.3.4';
    await recordAgentLoginFailure(redis as never, ip);
    expect(redis.pexpire).toHaveBeenCalledWith('ratelimit:agent-login-fail:1.2.3.4', 300_000);

    for (let i = 1; i < AGENT_LOGIN_FAIL.max; i += 1) {
      await recordAgentLoginFailure(redis as never, ip);
    }
    expect(await isAgentLoginBlocked(redis as never, ip)).toBe(true);
    expect(counters.get('ratelimit:agent-login-fail:1.2.3.4')).toBe(5);

    await clearAgentLoginFailures(redis as never, ip);
    expect(await isAgentLoginBlocked(redis as never, ip)).toBe(false);
  });

  it('admin 桶计数不影响 agent 桶（键独立）', async () => {
    const { redis } = makeRedis();
    const ip = '5.6.7.8';
    for (let i = 0; i < 10; i += 1) {
      await redis.incr(`ratelimit:admin-login-fail:${ip}`);
    }
    expect(await isAgentLoginBlocked(redis as never, ip)).toBe(false);
  });
});

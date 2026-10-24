import { describe, it, expect, vi } from 'vitest';
import {
  HTTP_RATE_LIMIT,
  THROTTLED_RATE_LIMIT,
  WS_CONN_LIMIT,
  hitHttpLimit,
  httpRateLimitKey,
  acquireWsConnSlot,
  isThrottled,
  releaseWsConnSlot,
  riskLimitFlagKey,
  touchWsConnSlot,
  wsConnRateLimitKey,
} from '../src/http/rate-limit';

/**
 * 只实现被测用到的四个命令，但**语义与真实 Redis 一致**（ZSET 成员真的进出、
 * `ZREMRANGEBYSCORE` 真的按分数删、`EXPIRE` 真的记 TTL）。
 *
 * 为什么状态化：R132③ 的教训 —— 替身比真实现宽容就是**静默假绿**
 * （例如 `zadd` 是 `vi.fn()` 而不真的记账，那么「第 21 次拒绝」永远测不出来）。
 *
 * 风控 T7 追加 `exists`（`flags` Set 真的存成员）：限流档旗的读点
 * （`isThrottled`）需要「旗在/旗无」两态各有判别力。
 */
function fakeRedis() {
  const zsets = new Map<string, Map<string, number>>();
  const ttls = new Map<string, number>();
  /** 风控旗（`risk:limit:*` / `risk:banned:*`）的状态化替身。 */
  const flags = new Set<string>();
  const redis = {
    zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
      const z = zsets.get(key);
      if (!z) return 0;
      let n = 0;
      for (const [m, s] of [...z]) {
        if (s >= min && s <= max) {
          z.delete(m);
          n += 1;
        }
      }
      return n;
    }),
    zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const z = zsets.get(key) ?? new Map<string, number>();
      zsets.set(key, z);
      z.set(member, score);
      return 1;
    }),
    zrem: vi.fn(async (key: string, member: string) =>
      (zsets.get(key)?.delete(member) ?? false) ? 1 : 0,
    ),
    expire: vi.fn(async (key: string, s: number) => {
      ttls.set(key, s);
      return 1;
    }),
    exists: vi.fn(async (key: string) => (flags.has(key) ? 1 : 0)),
  };
  return { redis: redis as never, zsets, ttls, flags, exists: redis.exists };
}

describe('§5.4 限流（R141）', () => {
  it('HTTP：窗口内前 20 次放行、第 21 次拒绝；窗口滑过后恢复', async () => {
    const { redis, ttls } = fakeRedis();
    const t0 = 1_000_000;
    for (let i = 0; i < HTTP_RATE_LIMIT.max; i += 1) {
      expect(await hitHttpLimit(redis, 'u1', t0 + i)).toBe(false);
    }
    expect(await hitHttpLimit(redis, 'u1', t0 + 100)).toBe(true);          // 第 21 次
    expect(await hitHttpLimit(redis, 'u1', t0 + HTTP_RATE_LIMIT.windowMs + 1)).toBe(false); // 滑窗
    expect(ttls.get(httpRateLimitKey('u1'))).toBe(5);                     // TTL = 窗口长度
  });

  it('HTTP：维度是**每个 userId 各自一个桶**（别人的桶满不影响我）', async () => {
    const { redis } = fakeRedis();
    for (let i = 0; i < HTTP_RATE_LIMIT.max; i += 1) await hitHttpLimit(redis, 'u1', 1000 + i);
    expect(await hitHttpLimit(redis, 'u1', 1100)).toBe(true);
    expect(await hitHttpLimit(redis, 'u2', 1100)).toBe(false);
  });

  it('WS 连接：第 6 条被拒，释放一条后可以再进（ZREM 真的生效）', async () => {
    const { redis, ttls } = fakeRedis();
    for (let i = 0; i < WS_CONN_LIMIT.max; i += 1) {
      expect(await acquireWsConnSlot(redis, '10.0.0.1', `s${i}`)).toBe(true);
    }
    expect(await acquireWsConnSlot(redis, '10.0.0.1', 's6')).toBe(false);
    expect(ttls.get(wsConnRateLimitKey('10.0.0.1'))).toBe(WS_CONN_LIMIT.ttlSeconds);
    await releaseWsConnSlot(redis, '10.0.0.1', 's0');
    expect(await acquireWsConnSlot(redis, '10.0.0.1', 's7')).toBe(true);
    // 不同 IP 各自一个桶
    expect(await acquireWsConnSlot(redis, '10.0.0.2', 'x1')).toBe(true);
  });

  /**
   * R141③ 的兜底语义（§5.4 逐字：「对每个 IP 的连接 key 设 TTL 兜底，防止进程崩溃
   * 导致计数泄漏」）：连接存活时 engine.io 每 30s 一个 `heartbeat`，我们借它续期。
   * 不续期的话 TTL 会把**长连接**当成崩溃残留删掉 ⇒ 限流被绕过（第 6 条能挤进来）。
   */
  it('WS 连接：心跳续期把 TTL 打回满额（否则长连接会被 TTL 兜底误删）', async () => {
    const { redis, ttls } = fakeRedis();
    await acquireWsConnSlot(redis, '10.0.0.1', 's0');
    ttls.set(wsConnRateLimitKey('10.0.0.1'), 1); // 模拟「已经跑了 59 秒」

    await touchWsConnSlot(redis, '10.0.0.1');

    expect(ttls.get(wsConnRateLimitKey('10.0.0.1'))).toBe(WS_CONN_LIMIT.ttlSeconds);
  });

  it('键名逐字（§5.4 的 `ratelimit:{dimension}:{key}`）', () => {
    expect(httpRateLimitKey('u1')).toBe('ratelimit:http:u1');
    expect(wsConnRateLimitKey('10.0.0.1')).toBe('ratelimit:ws-conn:10.0.0.1');
  });
});

/**
 * 风控 T7（规格 §2.6-1/2/4 / C9 网关侧 · 单元面）：**HTTP 限流档** ——
 * 旗 `risk:limit:{userId}` 在 ⇒ 3 次 / 1000ms，对**同一键** `ratelimit:http:{userId}` 判定；
 * 阈值经 `hitHttpLimit` 的 `limit` 参数化（**判定逻辑唯一**，不复制第二套）。
 */
describe('风控 T7：HTTP 限流档（§2.6-1/2/4）', () => {
  it('阈值与键名逐字（规格值；键 = §2.3 的 `risk:limit:{userId}`）', () => {
    // 断言**字面量**（用常量自比会让「把阈值改成别的数」测不出来）；与 room 侧 WS 档同值。
    expect(THROTTLED_RATE_LIMIT).toEqual({ max: 3, windowMs: 1000 });
    expect(riskLimitFlagKey('u1')).toBe('risk:limit:u1');
  });

  it('hitHttpLimit 阈值参数化：同一判定逻辑按 3/1s 档判定、**同一键**（第 4 次拒绝、窗口滑过恢复）', async () => {
    const { redis, ttls } = fakeRedis();
    const t0 = 1_000_000;
    for (let i = 0; i < THROTTLED_RATE_LIMIT.max; i += 1) {
      expect(await hitHttpLimit(redis, 'u1', t0 + i, THROTTLED_RATE_LIMIT)).toBe(false);
    }
    expect(await hitHttpLimit(redis, 'u1', t0 + 10, THROTTLED_RATE_LIMIT)).toBe(true); // 第 4 次
    // 键形状**不变**（§2.6-2 逐字：对「同一键」`ratelimit:http:{userId}` 滑窗）
    expect(ttls.get(httpRateLimitKey('u1'))).toBe(1); // ceil(1000/1000)
    // 窗口滑过 ⇒ 恢复（与正常档同一条清理路径）
    expect(await hitHttpLimit(redis, 'u1', t0 + THROTTLED_RATE_LIMIT.windowMs + 1, THROTTLED_RATE_LIMIT)).toBe(false);
  });

  it('isThrottled：旗在 ⇒ true、旗无 ⇒ false；旗读故障 ⇒ **false（单独 catch，不抛）**（R11/F8）', async () => {
    const { redis, flags, exists } = fakeRedis();
    expect(await isThrottled(redis, 'u1')).toBe(false);
    expect(exists).toHaveBeenCalledWith('risk:limit:u1');

    flags.add('risk:limit:u1');
    expect(await isThrottled(redis, 'u1')).toBe(true);

    // 旗读故障：不抛、按无旗（调用方据此走正常阈值；绝不吞进 fail-closed 管道）
    const broken = {
      exists: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    };
    await expect(isThrottled(broken as never, 'u1')).resolves.toBe(false);
  });
});

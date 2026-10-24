import { vi } from 'vitest';
import type { Redis } from 'ioredis';

/**
 * robot-service 的**假 Redis**（§9.6 的池：String / Hash / ZSET 三种类型）。
 *
 * ⚠️ 按**真实语义**实现（R212④，切片 7.1 的教训：「替身的宽容度就是对缺陷的容忍度」）：
 *  - `ZADD` 的 `score` 是**数字**，`ZRANGEBYSCORE` 支持 `-inf` / `+inf` 与 `LIMIT`；
 *  - `ZREM` / `ZCARD` / `DEL` / `EXISTS` **不看成员类型**（String / Hash / ZSET 都算「存在」）；
 *  - `HSET` **无条件覆盖**，`HDEL` 在 Hash 为空时删键（与真实 Redis 一致）。
 *
 * 只实现被测代码真正用到的方法；没实现的方法**直接抛错**，避免「用了个假方法却静默通过」。
 */
export function createFakeRedis() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  const zsets = new Map<string, Map<string, number>>();
  const ttls = new Map<string, number>();

  const exists = (key: string): boolean => strings.has(key) || hashes.has(key) || zsets.has(key);

  /** `MATCH` 的 glob → 正则（只实现 `*` 与 `?`，真实 `SCAN` 也只认这两种）。 */
  const globToRegExp = (pattern: string): RegExp =>
    new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    );

  /** 键空间里**所有**键（`SCAN` 的可见集合：三种类型都算「键存在」）。 */
  const allKeys = (): string[] => [
    ...new Set([...strings.keys(), ...hashes.keys(), ...zsets.keys()]),
  ];

  const byScore = (key: string, min: number, max: number): Array<[string, number]> =>
    [...(zsets.get(key) ?? new Map<string, number>())]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] - b[1]));

  const api = {
    strings,
    hashes,
    zsets,
    /**
     * `SET key value` / `SET key value EX <seconds>` —— **两种形态都要有真实语义**（R212）。
     *
     * ⚠️ 旧替身**静默忽略** `EX`（只 `strings.set`）⇒ 「`bot:bound` 的 TTL 丢了」这种缺陷
     * 在单测里**看不见**。这里：带 `EX` 就记 TTL；带**不认识的** mode 直接抛
     * （替身比真 Redis 宽容就是对缺陷的容忍度）。
     */
    set: vi.fn(async (key: string, value: string, mode?: string, ttlSeconds?: number) => {
      strings.set(key, value);
      if (mode !== undefined) {
        if (String(mode).toUpperCase() !== 'EX' || typeof ttlSeconds !== 'number') {
          throw new Error(`fake-redis: unsupported SET mode ${String(mode)}`);
        }
        ttls.set(key, ttlSeconds);
      }
      return 'OK' as const;
    }),
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        // 真实 DEL 不看类型
        if (strings.delete(key)) removed += 1;
        else if (hashes.delete(key)) removed += 1;
        else if (zsets.delete(key)) removed += 1;
        ttls.delete(key);
      }
      return removed;
    }),
    exists: vi.fn(async (...keys: string[]) => keys.filter(exists).length),
    expire: vi.fn(async (key: string, seconds: number) => {
      if (!exists(key)) return 0;
      ttls.set(key, seconds);
      return 1;
    }),
    ttl: vi.fn(async (key: string) => (exists(key) ? (ttls.get(key) ?? -1) : -2)),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      hashes.set(key, { ...(hashes.get(key) ?? {}), [field]: value });
      return 1;
    }),
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
    hgetall: vi.fn(async (key: string) => hashes.get(key) ?? {}),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const hash = hashes.get(key);
      if (!hash) return 0;
      let removed = 0;
      for (const field of fields) {
        if (field in hash) {
          delete hash[field];
          removed += 1;
        }
      }
      if (Object.keys(hash).length === 0) hashes.delete(key);
      return removed;
    }),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const zset = zsets.get(key) ?? new Map<string, number>();
      const isNew = !zset.has(member);
      zset.set(member, Number(score));
      zsets.set(key, zset);
      return isNew ? 1 : 0;
    }),
    zrem: vi.fn(async (key: string, ...members: string[]) => {
      const zset = zsets.get(key);
      if (!zset) return 0;
      let removed = 0;
      for (const member of members) if (zset.delete(member)) removed += 1;
      if (zset.size === 0) zsets.delete(key);
      return removed;
    }),
    zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
    zscore: vi.fn(async (key: string, member: string) => {
      const score = zsets.get(key)?.get(member);
      return score === undefined ? null : String(score);
    }),
    /**
     * `ZRANGEBYSCORE key min max [LIMIT offset count]`。
     * `-inf` / `+inf` 真的实现（**不是**「一律返回全部」）：切片 7.1 的教训是
     * 替身一旦比真 Redis 宽容，边界缺陷就会静默通过。
     */
    zrangebyscore: vi.fn(
      async (key: string, min: string | number, max: string | number, ...rest: unknown[]) => {
        const lo = min === '-inf' ? -Infinity : Number(min);
        const hi = max === '+inf' ? Infinity : Number(max);
        let rows = byScore(key, lo, hi).map(([member]) => member);
        const limitIdx = rest.findIndex((v) => String(v).toUpperCase() === 'LIMIT');
        if (limitIdx >= 0) {
          const offset = Number(rest[limitIdx + 1] ?? 0);
          const count = Number(rest[limitIdx + 2] ?? 0);
          rows = rows.slice(offset, offset + count);
        }
        return rows;
      },
    ),
    on: vi.fn(),
    quit: vi.fn(async () => undefined),
    /**
     * `PING`（§2.4 / R267 的健康检查依赖探测）。
     *
     * 真实语义：连通 ⇒ `'PONG'`；连接不可用 ⇒ **reject**。用例用
     * `redis.ping.mockRejectedValueOnce(...)` 构造 `degraded` 分支。
     */
    ping: vi.fn(async (): Promise<string> => 'PONG'),
    /**
     * 游标式 `SCAN cursor MATCH pattern COUNT n`（§7.3 偏差 A8：遍历**不得**用 `KEYS`）。
     *
     * 真实语义：`MATCH` 是 glob 过滤（`*`/`?`），游标 `'0'` 表示「遍历结束」。
     * 这里「第一次调用返回全部命中键 + 游标 0」—— 对小键空间这是**合法**的真实行为
     * （SCAN 只保证「完整遍历一次一定拿到所有键」，不保证分批形状）。
     * 第二次带非 0 游标进来会返回空（因为这里永远不会给出非 0 游标）。
     */
    scan: vi.fn(async (cursor: string, ...args: unknown[]): Promise<[string, string[]]> => {
      if (cursor !== '0') return ['0', []];
      const matchIndex = args.findIndex((arg) => String(arg).toUpperCase() === 'MATCH');
      const pattern = matchIndex >= 0 ? String(args[matchIndex + 1]) : '*';
      const re = globToRegExp(pattern);
      return ['0', allKeys().filter((key) => re.test(key)).sort()];
    }),
  };

  return api;
}

export type FakeRedis = ReturnType<typeof createFakeRedis>;

/** 交给 `RobotPool` 使用（仅测试）。 */
export function asRedis(fake: FakeRedis): Redis {
  return fake as unknown as Redis;
}

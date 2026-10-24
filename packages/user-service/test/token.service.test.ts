import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  TokenService,
  sessionKey,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../src/auth/token.service';

/** 只用得到 set/del/exists 的 Redis 替身；TTL 靠记录 EX 秒数断言。 */
function fakeRedis() {
  const store = new Map<string, number>(); // key -> 过期时刻（未用，仅记录存在性）
  const ttl = new Map<string, number>();
  return {
    store,
    ttl,
    set: vi.fn(async (key: string, _v: string, _ex: string, seconds: number) => {
      store.set(key, 1);
      ttl.set(key, seconds);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  } as any;
}

describe('TokenService（§5.1）', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let service: TokenService;

  beforeEach(() => {
    redis = fakeRedis();
    service = new TokenService(new JwtService({ secret: 'test-secret' }), redis);
  });

  it('access 2h / refresh 7d，且两张令牌各写一个 session:{jti}（TTL = 剩余有效期）', async () => {
    const pair = await service.issuePair({ id: 'u1', phone: '13800000000' });
    expect(redis.set).toHaveBeenCalledTimes(2);

    const access = service.verify(pair.accessToken, 'access');
    const refresh = service.verify(pair.refreshToken, 'refresh');
    expect(access.exp - access.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(refresh.exp - refresh.iat).toBe(REFRESH_TOKEN_TTL_SECONDS);
    expect(redis.ttl.get(sessionKey(access.jti))).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(redis.ttl.get(sessionKey(refresh.jti))).toBe(REFRESH_TOKEN_TTL_SECONDS);
  });

  it('refresh token 不能当 access token 用（R24）', async () => {
    const pair = await service.issuePair({ id: 'u1', phone: '13800000000' });
    expect(() => service.verify(pair.refreshToken, 'access')).toThrow(/typ/);
  });

  it('轮换：旧 refresh token 立即失效，新的一张可用', async () => {
    const first = await service.issuePair({ id: 'u1', phone: '13800000000' });
    const rotated = await service.rotate(first.refreshToken);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    const again = await service.rotate(first.refreshToken); // 旧的重放
    expect(again.ok).toBe(false);
    expect((await service.rotate(rotated.pair.refreshToken)).ok).toBe(true);
  });

  it('被吊销的 jti 不再活跃（登出语义）', async () => {
    const pair = await service.issuePair({ id: 'u1', phone: '13800000000' });
    const claims = service.verify(pair.accessToken, 'access');
    expect(await service.isActive(claims.jti)).toBe(true);
    await service.revoke(claims.jti);
    expect(await service.isActive(claims.jti)).toBe(false);
  });

  it('并发轮换：两个 rotate 同时进行，恰好一个 ok（旧 jti 必须被原子占用）', async () => {
    const first = await service.issuePair({ id: 'u1', phone: '13800000000' });
    const issuedBefore = redis.set.mock.calls.length; // issuePair 写了 2 个键

    // 旧实现是 exists + del（check-then-act）：两个并发 refresh 会双双通过存在性检查，
    // 于是都发出新令牌 —— 重放窗口。现在占用旧 jti 的唯一手段是 DEL 的返回值。
    const [a, b] = await Promise.all([
      service.rotate(first.refreshToken),
      service.rotate(first.refreshToken),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(redis.set.mock.calls.length - issuedBefore).toBe(2); // 只发出了一对
    const loser = a.ok ? b : a;
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.code).toBe(ErrCode.TOKEN_EXPIRED);
  });
});

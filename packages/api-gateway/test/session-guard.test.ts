import { describe, it, expect, vi } from 'vitest';
import { SessionGuard, sessionKey } from '../src/auth/session.guard';

describe('SessionGuard（§5.1 白名单）', () => {
  it('jti 在白名单 → true', async () => {
    const redis = { exists: vi.fn(async () => 1) } as any;
    const guard = new SessionGuard(redis);
    expect(await guard.isActive('jti-1')).toBe(true);
    expect(redis.exists).toHaveBeenCalledWith(sessionKey('jti-1'));
  });

  it('jti 不在白名单 → false', async () => {
    const guard = new SessionGuard({ exists: vi.fn(async () => 0) } as any);
    expect(await guard.isActive('jti-x')).toBe(false);
  });

  it('Redis 故障 → 抛错（调用方翻成 10007，不得静默放行）', async () => {
    const guard = new SessionGuard({ exists: vi.fn(async () => { throw new Error('down'); }) } as any);
    await expect(guard.isActive('jti-1')).rejects.toThrow('down');
  });

  it('键形状就是 user-service 的 session:{jti}（只复制键名，不 import 对方代码）', () => {
    expect(sessionKey('abc')).toBe('session:abc');
  });
});

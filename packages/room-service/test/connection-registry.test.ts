import { describe, expect, it, vi } from 'vitest';
import { ConnectionRegistry, userRoom } from '../src/coordination/connection-registry.service';
import { RedisIoAdapter } from '../src/gateway/redis-io.adapter';

describe('ConnectionRegistry（跨 Pod 顶替）', () => {
  it('register：断开同 user 的旧 socket，写属主与代次，加入用户房间', async () => {
    const oldDisconnect = vi.fn();
    const redis = { incr: vi.fn().mockResolvedValue(2), set: vi.fn() } as any;
    const fetchSockets = vi.fn().mockResolvedValue([{ id: 'old', disconnect: oldDisconnect }]);
    const io = { in: vi.fn().mockReturnValue({ fetchSockets }) } as any;
    const socket = { id: 'new', data: {} as Record<string, unknown>, join: vi.fn() } as any;

    await new ConnectionRegistry(redis).register(io, socket, 'u1');

    expect(io.in).toHaveBeenCalledWith(userRoom('u1'));
    expect(fetchSockets).toHaveBeenCalled();
    expect(oldDisconnect).toHaveBeenCalledWith(true);
    expect(redis.set).toHaveBeenCalledWith(
      'ws:owner:u1',
      expect.stringContaining('"socketId":"new"'),
      'PX',
      3600000,
    );
    expect(socket.data.connGeneration).toBe(2);
    expect(socket.join).toHaveBeenCalledWith(userRoom('u1'));
  });

  it('unregister：属主归本连接时删除，且本地 gauge 无条件递减', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(1) } as any;
    const dec = vi.fn();
    const socket = { id: 's1', data: { userId: 'u1', connGeneration: 2 } } as any;

    await expect(new ConnectionRegistry(redis).unregister(socket, dec)).resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, 'ws:owner:u1', '2', 's1');
    expect(dec).toHaveBeenCalledTimes(1);
  });

  it('unregister：属主不归本连接（跨 Pod 顶替）仍递减本地 gauge', async () => {
    const redis = { eval: vi.fn().mockResolvedValue(0) } as any;
    const dec = vi.fn();
    const socket = { id: 'old', data: { userId: 'u1', connGeneration: 1 } } as any;

    await expect(new ConnectionRegistry(redis).unregister(socket, dec)).resolves.toBe(false);
    expect(dec).toHaveBeenCalledTimes(1);
  });

  it('unregister：Redis 失败不阻断本地 gauge 递减', async () => {
    const redis = { eval: vi.fn().mockRejectedValue(new Error('down')) } as any;
    const dec = vi.fn();
    const socket = { id: 's2', data: { userId: 'u2', connGeneration: 3 } } as any;

    await expect(new ConnectionRegistry(redis).unregister(socket, dec)).resolves.toBe(false);
    expect(dec).toHaveBeenCalledTimes(1);
  });
});

describe('RedisIoAdapter', () => {
  it('createIOServer 挂载适配器构造函数', () => {
    const adapter = new RedisIoAdapter({} as any);
    (adapter as any).adapterConstructor = class FakeAdapter { init() {} close() {} };
    const server = adapter.createIOServer(0, {});
    expect(typeof server.adapter).toBe('function');
  });
});

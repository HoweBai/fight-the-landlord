import { describe, expect, it, vi } from 'vitest';
import { ProxyGateway } from '../src/gateway/proxy.gateway';
import { attachWsConnSlot } from '../src/http/rate-limit';

describe('ProxyGateway 优雅停机（spec 2026-10-27 D16）', () => {
  it('SIGTERM 时释放每个连接的 WS 名额并断开', async () => {
    const gw = Object.create(ProxyGateway.prototype) as any;
    gw.logger = { error: vi.fn() };
    gw.redis = { zrem: vi.fn().mockResolvedValue(1) };

    const request = {};
    attachWsConnSlot(request, { ip: '203.0.113.7', member: 'm-1' });
    const withSlot = { id: 'c1', request, disconnect: vi.fn() };
    const withoutSlot = { id: 'c2', request: {}, disconnect: vi.fn() };
    gw.clients = new Set([withSlot, withoutSlot]);

    await gw.onApplicationShutdown();

    expect(gw.redis.zrem).toHaveBeenCalledWith('ratelimit:ws-conn:203.0.113.7', 'm-1');
    expect(withSlot.disconnect).toHaveBeenCalledWith(true);
    expect(withoutSlot.disconnect).toHaveBeenCalledWith(true);
    expect(gw.clients.size).toBe(0);
  });

  it('释放失败只记日志，不阻断其它连接关闭', async () => {
    const gw = Object.create(ProxyGateway.prototype) as any;
    gw.logger = { error: vi.fn() };
    gw.redis = { zrem: vi.fn().mockRejectedValue(new Error('redis down')) };

    const request = {};
    attachWsConnSlot(request, { ip: '203.0.113.8', member: 'm-2' });
    const client = { id: 'c3', request, disconnect: vi.fn() };
    gw.clients = new Set([client]);

    await expect(gw.onApplicationShutdown()).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(gw.logger.error).toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { WsGateway } from '../src/gateway/ws.gateway';

/**
 * 事件驱动推送必须只投本地（C4：每个副本都处理同一 game.ended，走适配器广播会 N 倍重复）。
 * 请求驱动广播仍走跨 Pod 的 `server.to`。
 */
describe('WsGateway 广播通道', () => {
  function gateway() {
    const localEmit = vi.fn();
    const crossEmit = vi.fn();
    const localTo = vi.fn().mockReturnValue({ emit: localEmit });
    const crossTo = vi.fn().mockReturnValue({ emit: crossEmit });
    const gw = Object.create(WsGateway.prototype) as any;
    gw.server = { local: { to: localTo }, to: crossTo };
    return { gw, localEmit, crossEmit, localTo, crossTo };
  }

  it('broadcastLocal 走 server.local.to', () => {
    const { gw, localEmit, crossEmit, localTo, crossTo } = gateway();
    gw.broadcastLocal('r1', 'game.finished', 7, { ok: true });
    expect(localTo).toHaveBeenCalledWith('r1');
    expect(localEmit).toHaveBeenCalledWith('game.finished', expect.objectContaining({ version: 7 }));
    expect(crossTo).not.toHaveBeenCalled();
    expect(crossEmit).not.toHaveBeenCalled();
  });

  it('broadcast 走跨 Pod 的 server.to', () => {
    const { gw, localEmit, crossEmit, localTo, crossTo } = gateway();
    gw.broadcast('r1', 'room.state_update', 0, { ok: true });
    expect(crossTo).toHaveBeenCalledWith('r1');
    expect(crossEmit).toHaveBeenCalledWith('room.state_update', expect.any(Object));
    expect(localTo).not.toHaveBeenCalled();
    expect(localEmit).not.toHaveBeenCalled();
  });
});

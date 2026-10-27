import { describe, expect, it, vi } from 'vitest';
import { LeaderLease } from '../src/coordination/leader-lease.service';
import { FinalizationGuard } from '../src/coordination/finalization-guard.service';
import { WsGateway } from '../src/gateway/ws.gateway';

describe('LeaderLease', () => {
  it('抢到锁 ⇒ leader', async () => {
    const redis = { set: vi.fn().mockResolvedValue('OK') } as any;
    await expect(new LeaderLease(redis).isLeader()).resolves.toBe(true);
  });

  it('锁在别处 ⇒ 非 leader', async () => {
    const redis = { set: vi.fn().mockResolvedValue(null), eval: vi.fn().mockResolvedValue(0) } as any;
    await expect(new LeaderLease(redis).isLeader()).resolves.toBe(false);
  });

  it('锁是自己的 ⇒ 续约后仍为 leader', async () => {
    const redis = { set: vi.fn().mockResolvedValue(null), eval: vi.fn().mockResolvedValue(1) } as any;
    await expect(new LeaderLease(redis).isLeader()).resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalled();
  });
});

describe('FinalizationGuard', () => {
  it('同一 (roomCode, version) 只放行一次', async () => {
    const redis = { set: vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null) } as any;
    const guard = new FinalizationGuard(redis);
    await expect(guard.claim('r1', 7)).resolves.toBe(true);
    await expect(guard.claim('r1', 7)).resolves.toBe(false);
    expect(redis.set).toHaveBeenCalledWith('room:finalized:r1:7', '1', 'EX', 86400, 'NX');
  });
});

describe('局终副作用唯一执行', () => {
  const event = { event: 'game.ended', roomCode: 'r1', version: 7 } as any;

  function gatewayWith(leader: boolean, claimed: boolean) {
    const gw = Object.create(WsGateway.prototype) as any;
    gw.leader = { isLeader: vi.fn().mockResolvedValue(leader) };
    gw.finalizer = { claim: vi.fn().mockResolvedValue(claimed) };
    gw.finalizeRoomEnd = vi.fn().mockResolvedValue(undefined);
    gw.roomsService = { updateStatus: vi.fn().mockResolvedValue(undefined) };
    gw.resolveGameEventType = vi.fn().mockReturnValue('doudizhu');
    return gw;
  }

  it('非 leader 不执行结算/终态', async () => {
    const gw = gatewayWith(false, true);
    await gw.finalizeGameEndedOnce(event, undefined);
    expect(gw.finalizeRoomEnd).not.toHaveBeenCalled();
    expect(gw.roomsService.updateStatus).not.toHaveBeenCalled();
  });

  it('leader 但幂等键已被抢 ⇒ 不执行', async () => {
    const gw = gatewayWith(true, false);
    await gw.finalizeGameEndedOnce(event, undefined);
    expect(gw.finalizeRoomEnd).not.toHaveBeenCalled();
    expect(gw.roomsService.updateStatus).not.toHaveBeenCalled();
  });

  it('leader 且抢到幂等键 ⇒ 结算先于终态', async () => {
    const gw = gatewayWith(true, true);
    await gw.finalizeGameEndedOnce(event, undefined);
    expect(gw.finalizeRoomEnd).toHaveBeenCalledWith(event, undefined);
    expect(gw.roomsService.updateStatus).toHaveBeenCalledWith('r1', 'finished');
    expect(gw.finalizeRoomEnd.mock.invocationCallOrder[0]).toBeLessThan(
      gw.roomsService.updateStatus.mock.invocationCallOrder[0],
    );
  });
});

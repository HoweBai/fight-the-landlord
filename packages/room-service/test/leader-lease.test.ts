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

  /**
   * 🔴 2026-10-28：`release()` 此前**没有调用点** ⇒ 滚动更新/重启后旧实例的锁要等 TTL 120s，
   * 新实例在这段时间恒非 leader ⇒ 撮合/自动开局/回收/结算整体空窗 ≤2 分钟。本组钉住
   * 「关停即释放」这一钩子（Nest 的 `onApplicationShutdown`，由 `enableShutdownHooks` 驱动）。
   */
  it('关停 ⇒ 释放自己的锁（COMPARE_DEL，不是续约脚本）', async () => {
    const redis = { set: vi.fn(), eval: vi.fn().mockResolvedValue(1) } as any;
    const lease = new LeaderLease(redis);

    await lease.onApplicationShutdown();

    expect(redis.eval, '关停必须发起一次释放（否则新实例要空窗到 TTL）').toHaveBeenCalledTimes(1);
    const [script, numKeys, key, id] = redis.eval.mock.calls[0] as [string, number, string, string];
    expect(script, '释放用的是 COMPARE_DEL（只删「值仍是自己」的锁）').toContain("redis.call('DEL', KEYS[1])");
    expect(script, '不得误用续约脚本（RENEW 只 PEXPIRE、不释放）').not.toContain('PEXPIRE');
    expect(numKeys).toBe(1);
    expect(key).toBe('ftl:room:leader');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('关停时 Redis 故障 ⇒ 只 warn、不抛（关停不得被拖住，TTL 兜底）', async () => {
    const redis = { set: vi.fn(), eval: vi.fn().mockRejectedValue(new Error('redis down')) } as any;
    await expect(new LeaderLease(redis).onApplicationShutdown()).resolves.toBeUndefined();
  });
});

describe('FinalizationGuard', () => {
  it('同一 (roomCode, version) 只放行一次', async () => {
    const redis = { set: vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null) } as any;
    const guard = new FinalizationGuard(redis);
    await expect(guard.claim('r1', 7)).resolves.toBe(true);
    await expect(guard.claim('r1', 7)).resolves.toBe(false);
    expect(redis.set).toHaveBeenCalledWith('room:finalized:r1:legacy:7', '1', 'EX', 86400, 'NX');
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

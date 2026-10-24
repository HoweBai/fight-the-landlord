import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrCode, type PdkPlayerView } from '@fight-the-landlord/protocol';
import type { PdkSession } from '@fight-the-landlord/shared';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';
import { pdkService, seedPdkSession } from './helpers-pdk';

/**
 * Task 4.2：托管（`game.trustee`）的 pdk 路径。
 *
 * pdk 没有叫抢，行动者恒由 runtime 的 `currentActor`（= `currentPlayer`）给出；
 * 托管开关的守卫/版本/推送/计时器收缩沿既有通用逻辑，不得出现 ddz 分支。
 */
vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

describe('Task 4.2：pdk 托管（GameService 通用路径）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRedisDouble();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('当前行动者开启托管：version+1、trustee=true、deadline 收缩到 trustee 档、视图反映', async () => {
    const service = pdkService();
    const before = await seedPdkSession(service, 'PDK-TR1');
    const actorId = before.players[before.currentPlayer]!.id;

    const res = await service.applyTrustee({
      roomCode: 'PDK-TR1',
      userId: actorId,
      on: true,
      via: 'manual',
    });
    expect(res.version).toBe(before.version + 1);

    const after = (await service.getSession<PdkSession>('PDK-TR1'))!;
    const actorSeat = after.players.findIndex((p) => p.id === actorId);
    expect(after.players[actorSeat]!.trustee).toBe(true);
    // R8①：deadline 收缩到 max(0, min(剩余, trustee=2s)) ⇒ 不延长
    expect(after.turnDeadlineAt - Date.now()).toBeLessThanOrEqual(2_000);
    expect(after.turnDeadlineAt - Date.now()).toBeGreaterThan(0);

    // 推送里的 pdk 视图（按座位投递）反映托管态
    const lastEvent = redisDouble._published
      .map(([, payload]) => JSON.parse(payload) as { event: string; seatViews?: PdkPlayerView[] })
      .filter((e) => e.event === 'game.state_updated')
      .at(-1)!;
    expect(lastEvent.seatViews).toHaveLength(3);
    expect(lastEvent.seatViews![actorSeat]!.trustees[actorSeat]).toBe(true);
  });

  it('非行动者开启托管：version+1 但 deadline 不变（C13）', async () => {
    const service = pdkService();
    const before = await seedPdkSession(service, 'PDK-TR2');
    const nonActor = before.players.find((p) => p.seat !== before.currentPlayer)!;

    await service.applyTrustee({
      roomCode: 'PDK-TR2',
      userId: nonActor.id,
      on: true,
      via: 'manual',
    });

    const after = (await service.getSession<PdkSession>('PDK-TR2'))!;
    expect(after.turnDeadlineAt).toBe(before.turnDeadlineAt);
    expect(after.players[nonActor.seat]!.trustee).toBe(true);
  });

  it('手动 off（阈值未到）：只清 trustee、不清 timeoutCount', async () => {
    const service = pdkService();
    const before = await seedPdkSession(service, 'PDK-TR3');
    const actorId = before.players[before.currentPlayer]!.id;
    // 先制造一次超时计数（同一座位），再手动 on/off
    await service['onTurnTimeout']('PDK-TR3');
    const afterTimeout = (await service.getSession<PdkSession>('PDK-TR3'))!;
    const seat = before.currentPlayer;
    expect(afterTimeout.players[seat]!.timeoutCount).toBe(1);

    await service.applyTrustee({ roomCode: 'PDK-TR3', userId: actorId, on: true, via: 'manual' });
    await service.applyTrustee({ roomCode: 'PDK-TR3', userId: actorId, on: false, via: 'manual' });

    const after = (await service.getSession<PdkSession>('PDK-TR3'))!;
    expect(after.players[seat]!.trustee).toBe(false);
    expect(after.players[seat]!.timeoutCount).toBe(1);
  });

  it('已结束的 pdk 会话：托管 ⇒ 13005 GAME_OVER', async () => {
    const service = pdkService();
    await seedPdkSession(service, 'PDK-TR4', {
      over: { state: 'ended', finishedAt: Date.now(), winnerSeats: [0] },
    });

    let error: unknown;
    try {
      await service.applyTrustee({ roomCode: 'PDK-TR4', userId: 'p1', on: true, via: 'manual' });
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: ErrCode.GAME_OVER });
  });
});

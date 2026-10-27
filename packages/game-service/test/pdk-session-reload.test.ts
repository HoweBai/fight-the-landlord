import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PdkSession } from '@fight-the-landlord/shared';
import { buildPdkPlayerView } from '../src/games/pdk/view';
import { resetRedisDouble } from './helpers-ioredis';
import { pdkService, seedPdkSession } from './helpers-pdk';

/**
 * 审查 P0-2：pdk 会话重载后 `trustees` 不得恒 false。
 *
 * `saveSession` 的 `JSON.stringify` 把稀疏 `botIds` 空洞写成 `null`；`loadSession`
 * 的 pdk 早退分支绕过了 ddz 的 `botIds` 归一化 ⇒ 视图把 `null` 当机器人。
 */
vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

describe('pdk 会话重载后的托管视图（审查 P0-2）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRedisDouble();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('重载后人类受托座位仍为 true，机器人座位恒 false', async () => {
    const service = pdkService();
    const before = await seedPdkSession(service, 'PDK-RL1', { robotSeats: [1] });
    // 座位 0 人类开启托管；座位 1 是机器人；座位 2 人类未托管
    await service.applyTrustee({
      roomCode: 'PDK-RL1',
      userId: before.players[0]!.id,
      on: true,
      via: 'manual',
    });

    // 新实例 = 空缓存，强制从 Redis JSON 重载（模拟重启/多副本）
    const reloaded = pdkService();
    const session = (await reloaded.getSession<PdkSession>('PDK-RL1'))!;

    expect(session.botIds).toEqual([undefined, 'bot-1', undefined]);
    expect(buildPdkPlayerView(session, 0).trustees).toEqual([true, false, false]);
    expect(buildPdkPlayerView(session, 1).trustees).toEqual([true, false, false]);
    expect(buildPdkPlayerView(session, 2).trustees).toEqual([true, false, false]);
  });

  it('重载后关闭托管仍生效（回归）', async () => {
    const service = pdkService();
    const before = await seedPdkSession(service, 'PDK-RL2', { robotSeats: [1] });
    const humanId = before.players[0]!.id;

    await service.applyTrustee({ roomCode: 'PDK-RL2', userId: humanId, on: true, via: 'manual' });
    const reloaded = pdkService();
    await reloaded.applyTrustee({ roomCode: 'PDK-RL2', userId: humanId, on: false, via: 'manual' });

    const session = (await pdkService().getSession<PdkSession>('PDK-RL2'))!;
    expect(buildPdkPlayerView(session, 0).trustees).toEqual([false, false, false]);
  });
});

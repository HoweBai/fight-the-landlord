import { describe, expect, it, vi } from 'vitest';
import { metricsRegistry } from '@fight-the-landlord/shared';
import { PlayerStatsService } from '../src/players/player-stats.service';

const BASE = {
  totalPlayers: 10, onlineNow: 0, newToday: 1, new7d: 2, active1d: 3,
  active7d: 4, active30d: 5, inactive14d: 6, inactive30d: 7, neverActive: 1,
};

function makeService() {
  const players = { summaryBase: vi.fn(async () => ({ ...BASE })) };
  const redis = {
    zcount: vi.fn(async () => 2),
    set: vi.fn(async () => 'OK'),
    zremrangebyscore: vi.fn(async () => 1),
  };
  return {
    service: new PlayerStatsService(players as never, redis as never),
    players,
    redis,
  };
}

describe('PlayerStatsService（2026-10-22）', () => {
  it('单轮写 gauge + 快照 + 清理 presence', async () => {
    const { service, redis } = makeService();
    const out = await service.runOnce(1_800_000_000_000);
    expect(out.onlineNow).toBe(2);
    expect(redis.zremrangebyscore).toHaveBeenCalled();
    const snapshot = JSON.parse(String((redis.set.mock.calls[0] as unknown[])[1]));
    expect(snapshot).toMatchObject({ totalPlayers: 10, active1d: 3, onlineNow: 2 });
    expect((redis.set.mock.calls[0] as unknown[] | undefined)?.[2]).toBe('PX');

    const text = await metricsRegistry().metrics();
    for (const name of ['players_total', 'players_active_1d', 'players_active_7d', 'players_active_30d', 'players_inactive_14d', 'players_inactive_30d', 'players_online_presence']) {
      expect(text).toContain(name);
    }
  });

  it('Redis 失败不抛错（只跳过快照/清理）', async () => {
    const players = { summaryBase: vi.fn(async () => ({ ...BASE })) };
    const redis = {
      zcount: vi.fn().mockRejectedValue(new Error('down')),
      set: vi.fn().mockRejectedValue(new Error('down')),
      zremrangebyscore: vi.fn().mockRejectedValue(new Error('down')),
    };
    const service = new PlayerStatsService(players as never, redis as never);
    await expect(service.runOnce(1_800_000_000_000)).resolves.toMatchObject({ onlineNow: 0 });
  });
});

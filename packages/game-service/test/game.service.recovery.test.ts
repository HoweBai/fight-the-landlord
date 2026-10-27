import { describe, expect, it, vi } from 'vitest';
import { GameService } from '../src/game/game.service';

function fakeRedis(keys: string[], values: Record<string, string | null>) {
  return {
    scan: vi.fn().mockResolvedValue(['0', keys]),
    get: vi.fn(async (key: string) => values[key] ?? null),
  } as any;
}

describe('GameService 启动恢复回合定时器', () => {
  it('按 turnDeadlineAt 重建 playing 会话的定时器', async () => {
    const deadline = Date.now() + 5000;
    const redis = fakeRedis(['game:session:r1'], {
      'game:session:r1': JSON.stringify({
        state: 'playing',
        gameType: 'doudizhu',
        playerCount: 3,
        players: [],
        botIds: [],
        turnDeadlineAt: deadline,
      }),
    });
    const svc = new GameService(redis);
    const spy = vi.spyOn(svc as any, 'startTurnTimer').mockImplementation(() => undefined);

    await svc.onModuleInit();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ state: 'playing' }),
      { overrideMs: expect.any(Number) },
    );
  });

  it('跳过 ended/init/坏数据', async () => {
    const redis = fakeRedis(
      ['game:session:ended', 'game:session:init', 'game:session:bad'],
      {
        'game:session:ended': JSON.stringify({
          state: 'ended',
          gameType: 'doudizhu',
          playerCount: 3,
          players: [],
          botIds: [],
          turnDeadlineAt: Date.now(),
        }),
        'game:session:init': JSON.stringify({
          state: 'init',
          gameType: 'doudizhu',
          playerCount: 3,
          players: [],
          botIds: [],
          turnDeadlineAt: Date.now(),
        }),
        'game:session:bad': '{not-json',
      },
    );
    const svc = new GameService(redis);
    const spy = vi.spyOn(svc as any, 'startTurnTimer').mockImplementation(() => undefined);

    await svc.onModuleInit();

    expect(spy).not.toHaveBeenCalled();
  });

  it('扫描失败不阻止启动', async () => {
    const redis = { scan: vi.fn().mockRejectedValue(new Error('redis down')) } as any;
    const svc = new GameService(redis);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});

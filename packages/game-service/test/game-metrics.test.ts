/**
 * 监控片 T4（规格 §2.2）：`games_active` —— 15s 采样 `GameService` 进程内缓存
 * （`activeSessionCount()` = `cache.size`；**per-instance 语义**写进 HELP）。
 *
 * 判据三面：① 采样读数来自注入的 service；② **真的** `GameService` 的 getter 反映会话数；
 * ③ 自重排链 + 关停闸（shutdown 后不再排 timer —— 照 `records-cleanup.service.ts` 成例）。
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { GameService } from '../src/game/game.service';
import {
  GAME_METRICS_SAMPLE_INTERVAL_MS,
  GameMetricsService,
} from '../src/metrics/game-metrics.service';
import { gamesActive } from '../src/metrics/game.metrics';

/** 不 import prom-client 的结构读数（它不是 game-service 的依赖）。 */
async function gaugeValue(metric: { get(): Promise<unknown> }): Promise<number> {
  const { values } = (await metric.get()) as { values: Array<{ value: number }> };
  return values[0]?.value ?? 0;
}

const fakeGame = (count: number) =>
  ({ activeSessionCount: () => count }) as unknown as GameService;

describe('GameMetricsService：games_active（15s 采样 cache.size）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('注入假 service（size 3）⇒ gauge=3', async () => {
    const service = new GameMetricsService(fakeGame(3));

    service.sampleOnce();

    await expect(gaugeValue(gamesActive)).resolves.toBe(3);
  });

  it('关停后不再排 timer：15s 定时器真的在跑，shutdown 清掉后不再采样', async () => {
    const activeSessionCount = vi.fn(() => 1);
    const service = new GameMetricsService({ activeSessionCount } as unknown as GameService);
    vi.useFakeTimers();
    try {
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(GAME_METRICS_SAMPLE_INTERVAL_MS);
      expect(activeSessionCount, '定时器真的在跑（不是死代码）').toHaveBeenCalledTimes(1);

      service.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(GAME_METRICS_SAMPLE_INTERVAL_MS * 3);
      expect(activeSessionCount, 'shutdown 之后不得再采样').toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount(), '不得留下任何定时器').toBe(0);
    } finally {
      service.onApplicationShutdown();
    }
  });

  it('真 GameService：activeSessionCount() = cache.size —— 开局一场 ⇒ 1；同房重开不翻倍', async () => {
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
      publish: vi.fn(async () => 1),
      quit: vi.fn(async () => undefined),
    };
    const service = new GameService(redis as unknown as Redis);
    service.random = () => 0;

    try {
      expect(service.activeSessionCount()).toBe(0);

      await service.startGame({
        roomCode: 'GMTR1',
        baseScore: 100,
        players: [
          { id: 'u1', seat: 0, isRobot: false },
          { id: 'u2', seat: 1, isRobot: false },
          { id: 'u3', seat: 2, isRobot: false },
        ],
      });
      expect(service.activeSessionCount(), '一场会话 ⇒ 1').toBe(1);

      await service.startGame({
        roomCode: 'GMTR1',
        baseScore: 100,
        players: [
          { id: 'u1', seat: 0, isRobot: false },
          { id: 'u2', seat: 1, isRobot: false },
          { id: 'u3', seat: 2, isRobot: false },
        ],
      });
      expect(service.activeSessionCount(), 'game.start 幂等（复用会话）⇒ 不翻倍').toBe(1);
    } finally {
      await service.onApplicationShutdown(); // 清回合定时器
    }
  });
});

/**
 * 监控片 T3（规格 §2.2）：room-service 两侧采集单测 ——
 *  - `RoomMetricsService`：`rooms_active`（15s，`SCAN room:*` 排派生键，照
 *    `rooms.service.ts` 的 `scanAllRooms()` 判别）；
 *  - `MatchService` 扫描环内的 `match_queue_length`（ZCARD 为本片**新增**读命令；
 *    region 维**求和**、挂既有 config 驱动的扫描环 —— **没有**新计时器）。
 *
 * ⚠️ 指标是**模块级单例**（`src/metrics/room.metrics.ts`）⇒ 断言直接读 prom-client 当前值。
 * 本文件每个用例都在动作前显式走过一轮被测路径，故不依赖用例执行顺序。
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { MatchService } from '../src/match/match.service';
import {
  ROOM_METRICS_SAMPLE_INTERVAL_MS,
  RoomMetricsService,
} from '../src/metrics/room-metrics.service';
import { matchQueueLength, roomsActive } from '../src/metrics/room.metrics';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';
import { exactSeriesValue, labeledValue, metricValue } from './helpers/metric-readout';

describe('RoomMetricsService：rooms_active（SCAN room:*，排派生键）', () => {
  it('两条房间键 + 三条派生键 ⇒ gauge=2（派生键不得计入）', async () => {
    const scan = vi.fn(async (cursor: string) =>
      cursor === '0'
        ? ['0', ['room:AAA', 'room:AAA:seats', 'room:AAA:cardcount', 'room:BBB', 'room:BBB:bots']]
        : ['0', []],
    );
    const pipeline = vi.fn(() => ({
      hget: vi.fn().mockReturnThis(),
      exec: async () => [[null, 'doudizhu'], [null, 'doudizhu']],
    }));
    const service = new RoomMetricsService({ scan, pipeline } as unknown as Redis);

    await service.sampleOnce();

    await expect(metricValue(roomsActive)).resolves.toBe(2);
    expect(scan, 'SCAN 的 pattern 必须是 room:*（照 rooms.service.scanAllRooms 的同一跳）').toHaveBeenCalledWith(
      expect.anything(),
      'MATCH',
      'room:*',
      'COUNT',
      100,
    );
  });

  it('15s 自重排；shutdown 后不再采样（关停闸 —— 迟到回执不得复活循环）', async () => {
    const scan = vi.fn(async () => ['0', []]);
    const pipeline = vi.fn(() => ({ hget: vi.fn().mockReturnThis(), exec: async () => [] }));
    const service = new RoomMetricsService({ scan, pipeline } as unknown as Redis);
    vi.useFakeTimers();
    try {
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(ROOM_METRICS_SAMPLE_INTERVAL_MS);
      expect(scan, '定时器真的在跑（不是死代码）').toHaveBeenCalledTimes(1);

      service.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(ROOM_METRICS_SAMPLE_INTERVAL_MS * 3);
      expect(scan.mock.calls.length, 'shutdown 之后不得再采样').toBe(1);
    } finally {
      service.onApplicationShutdown();
      vi.useRealTimers();
    }
  });
});

describe('MatchService：match_queue_length 挂既有扫描环（ZCARD 聚合）', () => {
  /** 窄替身：扫键 → ZCARD → ZRANGE 空（processQueue 空队早返 ⇒ 无匹配副作用）。 */
  function makeService(keys: () => string[], depthOf: (key: string) => number) {
    const redis = {
      scan: vi.fn(async (cursor: string) => (cursor === '0' ? ['0', keys()] : ['0', []])),
      zcard: vi.fn(async (key: string) => depthOf(key)),
      zrange: vi.fn(async () => []),
    };
    const service = new MatchService(
      redis as unknown as Redis,
      {} as never,
      {} as never,
      asConfigCache(makeConfigCache()),
      {} as never,
    );
    return { service, redis };
  }

  const made: MatchService[] = [];
  afterEach(async () => {
    for (const s of made) await s.onApplicationShutdown();
    made.length = 0;
  });

  it('同 (mode, base_score) 的多条 region 键**求和**；不同档位各占一条序列', async () => {
    const depths: Record<string, number> = {
      'match:queue:random:15:global': 2,
      'match:queue:random:15:asia': 3,
      'match:queue:practice:80:global': 1,
    };
    const keys = Object.keys(depths);
    const { service } = makeService(() => keys, (key) => depths[key] ?? 0);
    made.push(service);

    await service.scanOnce();

    await expect(
      labeledValue(matchQueueLength, { mode: 'random', game_type: 'doudizhu', player_count: '3', base_score: '15' }),
      'random/15：两条 region 键求和 = 2+3',
    ).resolves.toBe(5);
    await expect(
      labeledValue(matchQueueLength, { mode: 'practice', game_type: 'doudizhu', player_count: '3', base_score: '80' }),
      '不同档位各占一条序列（不是互相覆盖）',
    ).resolves.toBe(1);
  });

  it('多玩法：同底分的不同玩法/人数**不聚合**（game_type/player_count 进标签）', async () => {
    const depths: Record<string, number> = {
      'match:queue:random:15:global': 2,
      'match:queue:random:paodekuai:3:15:global': 4,
      'match:queue:random:paodekuai:2:15:global': 1,
    };
    const keys = Object.keys(depths);
    const { service } = makeService(() => keys, (key) => depths[key] ?? 0);
    made.push(service);

    await service.scanOnce();

    await expect(
      labeledValue(matchQueueLength, { mode: 'random', game_type: 'doudizhu', player_count: '3', base_score: '15' }),
    ).resolves.toBe(2);
    await expect(
      labeledValue(matchQueueLength, { mode: 'random', game_type: 'paodekuai', player_count: '3', base_score: '15' }),
    ).resolves.toBe(4);
    await expect(
      labeledValue(matchQueueLength, { mode: 'random', game_type: 'paodekuai', player_count: '2', base_score: '15' }),
    ).resolves.toBe(1);
  });

  it('队列消失（键被删、SCAN 扫不到）⇒ 下一轮归零，不留陈旧读数', async () => {
    let keys = ['match:queue:random:15:global'];
    const { service } = makeService(() => keys, () => 4);
    made.push(service);

    await service.scanOnce();
    await expect(
      labeledValue(matchQueueLength, { mode: 'random', game_type: 'doudizhu', player_count: '3', base_score: '15' }),
    ).resolves.toBe(4);

    keys = []; // 队列清空 ⇒ Redis 自动删键 ⇒ 不再被扫到
    await service.scanOnce();
    await expect(
      labeledValue(matchQueueLength, { mode: 'random', game_type: 'doudizhu', player_count: '3', base_score: '15' }),
    ).resolves.toBe(0);
  });

  it('ZCARD 失败不拖垮匹配轮，且该档位**不写假 0**（宁留旧值）', async () => {
    let failing = false;
    const redis = {
      scan: vi.fn(async () => ['0', ['match:queue:random:15:global']]),
      zcard: vi.fn(async () => {
        if (failing) throw new Error('redis hiccup');
        return 4;
      }),
      zrange: vi.fn(async () => []),
    };
    const service = new MatchService(
      redis as unknown as Redis,
      {} as never,
      {} as never,
      asConfigCache(makeConfigCache()),
      {} as never,
    );
    made.push(service);

    await service.scanOnce();
    expect(await labeledValue(matchQueueLength, { mode: 'random', game_type: 'doudizhu', player_count: '3', base_score: '15' })).toBe(4);

    failing = true;
    await expect(service.scanOnce(), '读深失败不得让整轮扫描 reject').resolves.toBeUndefined();
    expect(
      await labeledValue(matchQueueLength, { mode: 'random', game_type: 'doudizhu', player_count: '3', base_score: '15' }),
      '读不到 ≠ 队列为空（不得写成假 0）',
    ).toBe(4);
  });
});

describe('A1：rooms_active 按玩法采样', () => {
  it('按 game_type 分组；pipeline 整条失败保留旧值', async () => {
    const exec = vi.fn(async () => [[null, 'doudizhu'], [null, 'paodekuai']]);
    const pipelineObj = { hget: vi.fn().mockReturnThis(), exec };
    const pipeline = vi.fn(() => pipelineObj);
    const scan = vi.fn(async (cursor: string) =>
      cursor === '0' ? ['0', ['room:AAA', 'room:BBB']] : ['0', []],
    );
    const service = new RoomMetricsService({ scan, pipeline } as unknown as Redis);

    await service.sampleOnce();
    const ddz = await exactSeriesValue(roomsActive, { game_type: 'doudizhu' });
    const pdk = await exactSeriesValue(roomsActive, { game_type: 'paodekuai' });
    expect(ddz).toBe(1);
    expect(pdk).toBe(1);

    exec.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.sampleOnce()).rejects.toThrow('redis down');
    expect(await exactSeriesValue(roomsActive, { game_type: 'doudizhu' })).toBe(ddz);
    expect(await exactSeriesValue(roomsActive, { game_type: 'paodekuai' })).toBe(pdk);
  });
});

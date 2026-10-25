/**
 * Task 2.4 / spec RH3-c/d：pdk 开局重试预算（start_attempts）、终局取消、warning 区分、
 * 机器人归池、waiting timeout 快路径。
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { Redis } from 'ioredis';
import { ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import {
  RoomStartService,
  START_ATTEMPTS_MAX,
  START_CANCELLED_WARNING_MESSAGE,
  START_RETRY_WARNING_MESSAGE,
} from '../src/rooms/rooms.start';
import { RoomsService } from '../src/rooms/rooms.service';
import { GameClient } from '../src/gateway/game.client';
import { RobotClient } from '../src/gateway/robot.client';
import { CHANNELS } from '../src/channels';
import { botsKey } from '../src/rooms/rooms.bots';
import { ROOM_TTL_SECONDS, startAttemptsKey } from '../src/rooms/rooms.seats';
import { createFakeRedis, asRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';
import { exactSeriesValue } from './helpers/metric-readout';
import { gameStartFailuresTotal } from '../src/metrics/room.metrics';
import { ReconnectService } from '../src/reconnect/reconnect.service';

describe('pdk 开局重试预算（Task 2.4）', () => {
  let redis: FakeRedis;
  let rooms: RoomsService;
  let configCache: ConfigCacheStub;
  let service: RoomStartService;
  let calls: Array<{ pattern: string; data: unknown }>;
  let rpcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    redis = createFakeRedis();
    configCache = makeConfigCache();
    configCache.paodekuaiEnabled.mockReturnValue(true);
    rooms = new RoomsService(asRedis(redis), asConfigCache(configCache));
    calls = [];
    rpcSend = vi.fn((pattern: string, data: unknown) => {
      calls.push({ pattern, data });
      if (pattern === RPC_PATTERNS.robotAcquire) {
        const seats = (data as { seats?: number[] }).seats ?? [1];
        return of({
          ok: true,
          data: {
            bots: seats.map((s) => ({
              botId: `bot-${s}`,
              displayId: `p_${String(s).padStart(8, '0')}`,
              skillLevel: 'beginner',
              personality: { thinkingSpeed: 900 },
              roomCode: 'PDK001',
              seat: s,
              gamesPlayed: 0,
            })),
          },
        });
      }
      return of({ ok: true, data: { released: 1 } });
    });
    const proxy = { send: rpcSend } as never;
    service = new RoomStartService(
      asRedis(redis) as Redis,
      rooms,
      new GameClient(proxy),
      new RobotClient(proxy),
      { get: vi.fn(), apply: vi.fn() } as never,
      { ensureBots: vi.fn(), afterSettle: vi.fn() } as never,
      new ReconnectService(asRedis(redis)),
      asConfigCache(configCache),
    );
  });

  async function pdkRoom(code = 'PDK001', humans = ['u1']): Promise<void> {
    await rooms.create({ mode: 'practice', roomCode: code, gameType: 'paodekuai' });
    for (const id of humans) await rooms.join(code, id, 'paodekuai');
  }

  const warnings = () =>
    (redis.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === CHANNELS.matchEvents)
      .map(([, raw]) => JSON.parse(String(raw)) as Record<string, unknown>)
      .filter((e) => e.event === 'system_warning');

  it('失败 1–4 次 ⇒ retryable（房留 waiting）；第 5 次 ⇒ fatal（取消 + 清票 + 已取消 warning + 归池）', async () => {
    await pdkRoom(); // 1 真人 ⇒ 首次 fillBots 补 2 个机器人并落绑定表
    configCache.pdkRules.mockImplementation(() => {
      throw new Error('bad config');
    });
    const onSeats = vi.fn(async () => undefined);

    for (let attempt = 1; attempt < START_ATTEMPTS_MAX; attempt += 1) {
      const outcome = await service.startRoomOutcome('PDK001', { strict: false, onSeats });
      expect(outcome, `attempt ${attempt}`).toBe('retryable');
      expect((await rooms.findOne('PDK001'))!.status).toBe('waiting');
      expect(redis.strings.get(startAttemptsKey('PDK001'))).toBe(String(attempt));
    }
    expect(onSeats, '重试期间票必须留着（人票两空防线）').not.toHaveBeenCalled();

    const final = await service.startRoomOutcome('PDK001', { strict: false, onSeats });

    expect(final).toBe('fatal');
    expect((await rooms.findOne('PDK001'))!.status).toBe('cancelled');
    expect(onSeats, '终局取消要清票（spec §4.6.3）').toHaveBeenCalledTimes(1);
    expect(redis.strings.get(startAttemptsKey('PDK001'))).toBe(String(START_ATTEMPTS_MAX));
    // warning 序列：前四次「正在重试」、最后一次「已取消」
    expect(warnings().map((w) => w.message)).toEqual([
      ...Array.from({ length: START_ATTEMPTS_MAX - 1 }, () => START_RETRY_WARNING_MESSAGE),
      START_CANCELLED_WARNING_MESSAGE,
    ]);
    // 归池：release 带绑定表里的内部 botId；绑定键清空
    const releases = calls.filter((c) => c.pattern === RPC_PATTERNS.robotRelease);
    expect(releases).toHaveLength(1);
    expect((releases[0]!.data as { botIds: string[] }).botIds).toEqual(['bot-1', 'bot-2']);
    expect(redis.hashes.has(botsKey('PDK001'))).toBe(false);
  });

  it('retryable 不取消房/不归池（票与房都留待下一轮）', async () => {
    await pdkRoom('PDK002', ['u1', 'u2', 'u3']);
    configCache.pdkRules.mockImplementation(() => {
      throw new Error('bad config');
    });

    const outcome = await service.startRoomOutcome('PDK002', { strict: false });

    expect(outcome).toBe('retryable');
    expect((await rooms.findOne('PDK002'))!.status).toBe('waiting');
    expect(calls.some((c) => c.pattern === RPC_PATTERNS.robotRelease)).toBe(false);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({ code: 10007, message: START_RETRY_WARNING_MESSAGE });
  });

  it('waiting timeout ⇒ 第一次失败即 fatal（不等 5 次）', async () => {
    await pdkRoom('PDK003', ['u1', 'u2', 'u3']);
    configCache.pdkRules.mockImplementation(() => {
      throw new Error('bad config');
    });
    // 房间的 waiting 窗口已过（timeoutAt 由 create 写入；把 RoomsService 的时钟推后）
    rooms.setClock(() => Date.now() + 31_000);

    const outcome = await service.startRoomOutcome('PDK003', { strict: false });

    expect(outcome).toBe('fatal');
    expect((await rooms.findOne('PDK003'))!.status).toBe('cancelled');
    expect(redis.strings.get(startAttemptsKey('PDK003'))).toBe('1');
    expect(warnings().at(-1)).toMatchObject({ message: START_CANCELLED_WARNING_MESSAGE });
  });

  it('start_attempts 带房间 TTL，且 deleteRoom 一并删除', async () => {
    await pdkRoom('PDK004', ['u1', 'u2', 'u3']);
    configCache.pdkRules.mockImplementation(() => {
      throw new Error('bad config');
    });
    await service.startRoomOutcome('PDK004', { strict: false });

    expect(await redis.ttl(startAttemptsKey('PDK004'))).toBe(ROOM_TTL_SECONDS);

    await rooms.deleteRoom('PDK004');
    expect(redis.strings.has(startAttemptsKey('PDK004'))).toBe(false);
  });

  it('A1：rules 失败按 reason=rules 计数；第 5 次取消额外计 cancelled', async () => {
    await pdkRoom('PDKM1');
    configCache.pdkRules.mockImplementation(() => {
      throw new Error('bad config');
    });
    const before = (await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'rules',
    })) ?? 0;
    for (let i = 0; i < START_ATTEMPTS_MAX; i += 1) {
      await service.startRoomOutcome('PDKM1', { strict: false });
    }
    expect(await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'rules',
    })).toBeGreaterThanOrEqual(before + START_ATTEMPTS_MAX);
    expect(await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'cancelled',
    })).toBeGreaterThanOrEqual(1);
  });

  it('A1：bot fill 失败计 reason=bot_fill（不出现 rules）', async () => {
    const original = rpcSend.getMockImplementation()!;
    rpcSend.mockImplementation((pattern: string, data: unknown) =>
      pattern === RPC_PATTERNS.robotAcquire
        ? of({ ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'down' })
        : original(pattern, data),
    );
    await pdkRoom('PDKM2');
    const beforeBot = (await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'bot_fill',
    })) ?? 0;
    const beforeRules = (await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'rules',
    })) ?? 0;

    const outcome = await service.startRoomOutcome('PDKM2', { strict: false });

    expect(outcome).toBe('retryable');
    expect(await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'bot_fill',
    })).toBe(beforeBot + 1);
    expect(await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'rules',
    })).toBe(beforeRules);
  });

  it('A1：pending_write 失败计 reason=pending_write', async () => {
    await pdkRoom('PDKM3');
    const originalHset = redis.hset.bind(redis);
    vi.spyOn(redis, 'hset').mockImplementation(async (key: string, ...args: never[]) => {
      if (String(key).startsWith('match:pending:')) throw new Error('redis down');
      return originalHset(key, ...(args as never[]));
    });
    const before = (await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'pending_write',
    })) ?? 0;

    const outcome = await service.startRoomOutcome('PDKM3', { strict: false });

    expect(outcome).toBe('retryable');
    expect(await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'paodekuai', reason: 'pending_write',
    })).toBe(before + 1);
  });
});

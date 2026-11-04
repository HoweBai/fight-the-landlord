/**
 * T11 / spec §3.2：麻将开局资损闸。
 *
 * `sbr` 预设的 48×底花猪 burn 在金币场默认**不开**；仅 `game.mahjong.sbrGoldEnabled=true`
 * 放行。失败走 `failPdkStart`（不 announce/不 start/房间保持 waiting）——与规则读取失败同形。
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { Redis } from 'ioredis';
import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES } from '@fight-the-landlord/shared';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { RoomStartService } from '../src/rooms/rooms.start';
import { RoomsService } from '../src/rooms/rooms.service';
import { GameClient } from '../src/gateway/game.client';
import { RobotClient } from '../src/gateway/robot.client';
import { createFakeRedis, asRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';
import { ReconnectService } from '../src/reconnect/reconnect.service';

describe('RoomStartService：麻将 sbr 金币场资损闸', () => {
  let redis: FakeRedis;
  let rooms: RoomsService;
  let configCache: ConfigCacheStub;
  let service: RoomStartService;
  let calls: Array<{ pattern: string; data: unknown }>;

  beforeEach(() => {
    redis = createFakeRedis();
    configCache = makeConfigCache();
    rooms = new RoomsService(asRedis(redis), asConfigCache(configCache));
    calls = [];
    const rpcSend = vi.fn((pattern: string, data: unknown) => {
      calls.push({ pattern, data });
      return of({ ok: true, data: {} });
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

  async function mahjongRoom(code = 'MJ001'): Promise<void> {
    await rooms.create({ mode: 'gold', roomCode: code, gameType: 'mahjong' });
    for (const id of ['u1', 'u2', 'u3', 'u4']) await rooms.join(code, id, 'mahjong');
  }

  it('金币场 + sbr(burn48) + 闸关 ⇒ 不开局，房间仍 waiting', async () => {
    await mahjongRoom();
    configCache.mahjongRules.mockReturnValue({ ...DEFAULT_SBR_RULES });
    configCache.mahjongSbrGoldEnabled.mockReturnValue(false);

    const outcome = await service.startRoomOutcome('MJ001', { strict: false });

    expect(outcome).not.toBe('started');
    expect((await rooms.findOne('MJ001'))!.status).toBe('waiting');
    expect(calls.some((c) => c.pattern === RPC_PATTERNS.gameStart)).toBe(false);
  });

  it('闸开 ⇒ 正常开局并带麻将规则快照', async () => {
    await mahjongRoom();
    configCache.mahjongRules.mockReturnValue({ ...DEFAULT_SBR_RULES });
    configCache.mahjongSbrGoldEnabled.mockReturnValue(true);

    const outcome = await service.startRoomOutcome('MJ001', { strict: false });

    expect(outcome).toBe('started');
    const start = calls.find((c) => c.pattern === RPC_PATTERNS.gameStart)?.data as {
      gameType?: string;
      rules?: unknown;
    };
    expect(start.gameType).toBe('mahjong');
    expect(start.rules).toEqual(DEFAULT_SBR_RULES);
  });

  it('chengdu(payEach) 金币场不读闸 ⇒ 默认规则正常开局', async () => {
    await mahjongRoom();
    configCache.mahjongRules.mockReturnValue({ ...DEFAULT_CHENGDU_RULES });
    configCache.mahjongSbrGoldEnabled.mockReturnValue(false);

    const outcome = await service.startRoomOutcome('MJ001', { strict: false });

    expect(outcome).toBe('started');
  });
});

/**
 * Task 2.4 / spec §4.6.3：跑得快开局链（规则快照 / 顺序 / strict / onSeats 后置 / 能力位）。
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { Redis } from 'ioredis';
import { DEFAULT_PDK_RULES } from '@fight-the-landlord/shared';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { RoomStartService, START_RETRY_WARNING_MESSAGE } from '../src/rooms/rooms.start';
import { RoomsService } from '../src/rooms/rooms.service';
import { GameClient } from '../src/gateway/game.client';
import { RobotClient } from '../src/gateway/robot.client';
import { CHANNELS } from '../src/channels';
import { createFakeRedis, asRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';
import { ReconnectService } from '../src/reconnect/reconnect.service';

describe('RoomStartService：跑得快开局链（Task 2.4）', () => {
  let redis: FakeRedis;
  let rooms: RoomsService;
  let configCache: ConfigCacheStub;
  let service: RoomStartService;
  let calls: Array<{ pattern: string; data: unknown }>;
  let handlers: Map<string, (data: unknown, index: number) => unknown>;
  let rpcSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    redis = createFakeRedis();
    configCache = makeConfigCache();
    configCache.paodekuaiEnabled.mockReturnValue(true);
    rooms = new RoomsService(asRedis(redis), asConfigCache(configCache));
    calls = [];
    handlers = new Map();
    rpcSend = vi.fn((pattern: string, data: unknown) => {
      calls.push({ pattern, data });
      const handler = handlers.get(pattern);
      if (handler) return handler(data, calls.filter((c) => c.pattern === pattern).length - 1);
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

  async function pdkRoom(code = 'PDK001', humans = ['u1', 'u2', 'u3']): Promise<void> {
    await rooms.create({ mode: 'practice', roomCode: code, gameType: 'paodekuai' });
    for (const id of humans) await rooms.join(code, id, 'paodekuai');
  }

  const publishEvents = () =>
    (redis.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === CHANNELS.matchEvents)
      .map(([, raw]) => JSON.parse(String(raw)) as Record<string, unknown>);

  const startPayload = () => calls.find((c) => c.pattern === RPC_PATTERNS.gameStart)?.data as {
    gameType?: string;
    playerCount?: number;
    rules?: unknown;
    seed?: number;
    testDeck?: unknown;
  };

  it('成功：outcome=started，game.start 带 gameType/playerCount/rules，房间 playing', async () => {
    await pdkRoom();

    const outcome = await service.startRoomOutcome('PDK001', { strict: false });

    expect(outcome).toBe('started');
    expect((await rooms.findOne('PDK001'))!.status).toBe('playing');
    const payload = startPayload();
    expect(payload.gameType).toBe('paodekuai');
    expect(payload.playerCount).toBe(3);
    expect(payload.rules).toEqual(DEFAULT_PDK_RULES);
  });

  it('顺序：读规则成功 → announce → game.start → onSeats（pdk 后置）', async () => {
    await pdkRoom();
    const order: string[] = [];
    handlers.set(RPC_PATTERNS.gameStart, () => {
      order.push('start');
      return of({ ok: true, data: {} });
    });
    const publish = redis.publish as ReturnType<typeof vi.fn>;
    const realPublish = publish.getMockImplementation()!;
    publish.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === CHANNELS.matchEvents) order.push('announce');
      return realPublish(...args);
    });

    const outcome = await service.startRoomOutcome('PDK001', {
      strict: false,
      onSeats: async () => {
        order.push('onSeats');
      },
    });

    expect(outcome).toBe('started');
    expect(order).toEqual(['announce', 'start', 'onSeats']);
  });

  it('规则快照不可用 ⇒ retryable：不 announce、不 start、不 onSeats；房留 waiting；warning(10007)', async () => {
    await pdkRoom();
    configCache.pdkRules.mockImplementation(() => {
      throw new Error('bad pdk config');
    });
    const onSeats = vi.fn(async () => undefined);

    const outcome = await service.startRoomOutcome('PDK001', { strict: false, onSeats });

    expect(outcome).toBe('retryable');
    expect((await rooms.findOne('PDK001'))!.status).toBe('waiting');
    expect(calls.some((c) => c.pattern === RPC_PATTERNS.gameStart)).toBe(false);
    expect(onSeats).not.toHaveBeenCalled();
    expect(publishEvents().filter((e) => e.event === 'room.matched')).toEqual([]);
    const warning = publishEvents().find((e) => e.event === 'system_warning');
    expect(warning).toMatchObject({
      playerIds: ['u1', 'u2', 'u3'],
      code: 10007,
      message: START_RETRY_WARNING_MESSAGE,
    });
  });

  it('onSeats（后置）失败 ⇒ 仍 started、房 playing（不把已开局的房判失败）', async () => {
    await pdkRoom();

    const outcome = await service.startRoomOutcome('PDK001', {
      strict: false,
      onSeats: async () => {
        throw new Error('ticket cleanup down');
      },
    });

    expect(outcome).toBe('started');
    expect((await rooms.findOne('PDK001'))!.status).toBe('playing');
    expect(calls.some((c) => c.pattern === RPC_PATTERNS.gameStart)).toBe(true);
  });

  it('记牌器能力位：pdk 不调用 updateCardCounterStatuses（D17），ddz 仍调用', async () => {
    await pdkRoom();
    const spy = vi.spyOn(service as unknown as { updateCardCounterStatuses: () => Promise<void> }, 'updateCardCounterStatuses');

    await service.startRoomOutcome('PDK001', { strict: false });
    expect(spy).not.toHaveBeenCalled();

    await rooms.create({ mode: 'practice', roomCode: 'DDZ001' });
    await rooms.join('DDZ001', 'd1');
    await service.startRoomOutcome('DDZ001', { strict: false });
    expect(spy).toHaveBeenCalled();
  });

  it('ddz 旧路径：strict:false 的 game.start 失败仍写 playing（legacy-failed，N36）', async () => {
    await rooms.create({ mode: 'practice', roomCode: 'DDZ001' });
    await rooms.join('DDZ001', 'd1');
    handlers.set(RPC_PATTERNS.gameStart, () => throwError(() => new Error('game down')));

    const outcome = await service.startRoomOutcome('DDZ001', { strict: false });

    expect(outcome).toBe('legacy-failed');
    expect((await rooms.findOne('DDZ001'))!.status).toBe('playing');
    expect(await service.startRoom('DDZ001', { strict: false })).toBe(false);
  });

  it('ddz strict:true 失败 ⇒ fatal（房留 waiting、不写 playing）', async () => {
    await rooms.create({ mode: 'practice', roomCode: 'DDZ002' });
    await rooms.join('DDZ002', 'd1');
    handlers.set(RPC_PATTERNS.gameStart, () => throwError(() => new Error('game down')));

    const outcome = await service.startRoomOutcome('DDZ002', { strict: true });

    expect(outcome).toBe('fatal');
    expect((await rooms.findOne('DDZ002'))!.status).toBe('waiting');
  });

  it('seed/testDeck 透传给 game.start（内部测试钩子，Task 4.4）', async () => {
    await pdkRoom();
    const deck = Array.from({ length: 48 }, (_, i) => ({ r: 3 + (i % 15), s: i % 4 }));

    await service.startRoomOutcome('PDK001', { strict: false, seed: 42, testDeck: deck });

    expect(startPayload()).toMatchObject({ seed: 42, testDeck: deck });
  });
});

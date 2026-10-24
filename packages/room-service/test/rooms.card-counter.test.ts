/**
 * 记牌器收费片 T10：`RoomStartService.updateCardCounterStatuses`（规格 §2.5；C24–C29 的单测半边）。
 *
 * 状态块在 `startRoom` 尾部、`startAndAnnounce === true` 之后（所有模式）：
 *  - 总开关关 / 非金币场 / 两价皆 0 / 收费态四分支；
 *  - 收费态逐位 `currency.cardCounterConsume`（并发；未知态 fail-open）；
 *  - 结果写 `room:{code}:ccstate` + 发布 `match:events` 的 `card_counter` 事件。
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { Redis } from 'ioredis';
import { ErrCode, RPC_PATTERNS, type BotInstance } from '@fight-the-landlord/protocol';
import { RoomStartService } from '../src/rooms/rooms.start';
import { RoomsService } from '../src/rooms/rooms.service';
import { ccstateKey } from '../src/rooms/rooms.seats';
import { GameClient } from '../src/gateway/game.client';
import { RobotClient } from '../src/gateway/robot.client';
import { CHANNELS } from '../src/channels';
import { ReconnectService } from '../src/reconnect/reconnect.service';
import { asRedis, createFakeRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';
import { labeledValue } from './helpers/metric-readout';
import {
  cardCounterConsumedTotal,
  cardCounterConsumeErrorTotal,
} from '../src/metrics/room.metrics';

function botOf(seatNo: number, botId: string): BotInstance {
  return {
    botId,
    displayId: `p_${String(seatNo).padStart(8, '0')}`,
    skillLevel: 'beginner',
    personality: { thinkingSpeed: 900 },
    roomCode: 'ROOM01',
    seat: seatNo,
    gamesPlayed: 0,
  };
}

describe('RoomStartService：记牌器开局状态块', () => {
  let redis: FakeRedis;
  let rooms: RoomsService;
  let configCache: ConfigCacheStub;
  let service: RoomStartService;
  let calls: Array<{ pattern: string; data: unknown }>;
  let handlers: Map<string, (data: unknown, index: number) => unknown>;
  let currency: {
    get: ReturnType<typeof vi.fn>;
    apply: ReturnType<typeof vi.fn>;
    cardCounterConsume: ReturnType<typeof vi.fn>;
  };
  let robotFunding: { ensureBots: ReturnType<typeof vi.fn>; afterSettle: ReturnType<typeof vi.fn> };

  function rpcStub() {
    const send = vi.fn((pattern: string, data: unknown) => {
      const index = calls.filter((c) => c.pattern === pattern).length;
      calls.push({ pattern, data });
      const handler = handlers.get(pattern);
      if (handler) return handler(data, index);
      if (pattern === RPC_PATTERNS.robotAcquire) {
        const seats = (data as { seats?: number[] }).seats ?? [1];
        return of({ ok: true, data: { bots: seats.map((s) => botOf(s, `bot-${s}`)) } });
      }
      return of({ ok: true, data: {} });
    });
    return { send } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createFakeRedis();
    configCache = makeConfigCache();
    configCache.cardCounterEnabled.mockReturnValue(true);
    rooms = new RoomsService(asRedis(redis), asConfigCache(configCache));
    calls = [];
    handlers = new Map();
    const proxy = rpcStub();
    currency = {
      get: vi.fn(async (req: { ownerIds: string[] }) => ({
        balances: req.ownerIds.map((ownerId) => ({ ownerId, balance: 100, exists: true })),
      })),
      apply: vi.fn(),
      cardCounterConsume: vi.fn(async () => ({ active: true, source: 'credit', expiresAt: null })),
    };
    robotFunding = { ensureBots: vi.fn(async () => undefined), afterSettle: vi.fn() };
    service = new RoomStartService(
      asRedis(redis) as Redis,
      rooms,
      new GameClient(proxy),
      new RobotClient(proxy),
      currency as never,
      robotFunding as never,
      new ReconnectService(asRedis(redis)),
      asConfigCache(configCache),
    );
  });

  async function makeRoom(code: string, mode: 'practice' | 'gold', humans: string[]): Promise<void> {
    await rooms.create({ mode, roomCode: code, ...(mode === 'gold' ? { baseScore: 15 } : {}) });
    for (const id of humans) await rooms.join(code, id);
  }

  const cardCounterEvents = () =>
    (redis.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === CHANNELS.matchEvents)
      .map(([, message]) => JSON.parse(String(message)) as Record<string, unknown>)
      .filter((event) => event.event === 'card_counter');

  async function ccstate(code: string): Promise<Record<string, string>> {
    return (await redis.hgetall(ccstateKey(code))) as Record<string, string>;
  }

  it('总开关关：全真人 inactive、不消费、仍写状态并发布', async () => {
    configCache.cardCounterEnabled.mockReturnValue(false);
    await makeRoom('CC01', 'practice', ['u1']);

    expect(await service.startRoom('CC01', { strict: true })).toBe(true);

    expect(currency.cardCounterConsume).not.toHaveBeenCalled();
    expect(await ccstate('CC01')).toEqual({ '0': JSON.stringify({ active: false }) });
    expect(cardCounterEvents()).toEqual([
      { event: 'card_counter', userId: 'u1', roomCode: 'CC01', active: false },
    ]);
  });

  it('非金币场（免费场/好友房）：active=总开关、不消费', async () => {
    await makeRoom('CC02', 'practice', ['u1']);

    expect(await service.startRoom('CC02', { strict: true })).toBe(true);

    expect(currency.cardCounterConsume).not.toHaveBeenCalled();
    expect(await ccstate('CC02')).toEqual({ '0': JSON.stringify({ active: true }) });
    expect(cardCounterEvents()[0]).toMatchObject({ userId: 'u1', active: true });
  });

  it('金币场收费态：逐位真人消费、结果入状态/事件；机器人零调用；指标按 source 计数', async () => {
    const beforeCredit = (await labeledValue(cardCounterConsumedTotal, { source: 'credit' })) ?? 0;
    await makeRoom('CC03', 'gold', ['u1']);

    expect(await service.startRoom('CC03', { strict: true })).toBe(true);

    expect(currency.cardCounterConsume).toHaveBeenCalledTimes(1);
    expect(currency.cardCounterConsume).toHaveBeenCalledWith({
      roomCode: 'CC03',
      ownerId: 'u1',
      seat: 0,
    });
    expect(await ccstate('CC03')).toEqual({
      '0': JSON.stringify({ active: true, source: 'credit' }),
    });
    expect(cardCounterEvents()).toEqual([
      { event: 'card_counter', userId: 'u1', roomCode: 'CC03', active: true, source: 'credit' },
    ]);
    const afterCredit = (await labeledValue(cardCounterConsumedTotal, { source: 'credit' })) ?? 0;
    expect(afterCredit).toBe(beforeCredit + 1);
  });

  it('消费未知态：fail-open active=true/source=unknown + 错误指标', async () => {
    const beforeErr = await metricValue(cardCounterConsumeErrorTotal);
    currency.cardCounterConsume.mockRejectedValue(new Error('currency down'));
    await makeRoom('CC04', 'gold', ['u1']);

    expect(await service.startRoom('CC04', { strict: true })).toBe(true);

    expect(await ccstate('CC04')).toEqual({
      '0': JSON.stringify({ active: true, source: 'unknown' }),
    });
    expect(cardCounterEvents()[0]).toMatchObject({ active: true, source: 'unknown' });
    expect(await metricValue(cardCounterConsumeErrorTotal)).toBe(beforeErr + 1);
  });

  it('无权益 none：active=false/source=none（状态与事件一致）', async () => {
    currency.cardCounterConsume.mockResolvedValue({ active: false, source: 'none', expiresAt: null });
    await makeRoom('CC09', 'gold', ['u1']);

    expect(await service.startRoom('CC09', { strict: true })).toBe(true);

    expect(await ccstate('CC09')).toEqual({
      '0': JSON.stringify({ active: false, source: 'none' }),
    });
    expect(cardCounterEvents()[0]).toMatchObject({ active: false, source: 'none' });
  });

  it('逐位并发：两位真人的 consume 都在任一 resolve 之前发出（Promise.all）', async () => {
    const issued: string[] = [];
    let release: Array<() => void> = [];
    currency.cardCounterConsume.mockImplementation(
      (req: { ownerId: string }) =>
        new Promise((resolve) => {
          issued.push(req.ownerId);
          release.push(() => resolve({ active: true, source: 'credit', expiresAt: null }));
        }),
    );
    await makeRoom('CC10', 'gold', ['u1', 'u2']);

    const starting = service.startRoom('CC10', { strict: true });
    for (let i = 0; i < 100 && issued.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(issued.sort(), '两位真人都必须先发出（而不是串行等第一笔）').toEqual(['u1', 'u2']);
    for (const fn of release) fn();
    expect(await starting).toBe(true);
  });

  it('单键 0（perGame=0, perHour>0）：仍走消费（已有权益照常扣）', async () => {
    configCache.cardCounterPrices.mockReturnValue({ perGame: 0, perHour: 100 });
    await makeRoom('CC05', 'gold', ['u1']);

    expect(await service.startRoom('CC05', { strict: true })).toBe(true);
    expect(currency.cardCounterConsume).toHaveBeenCalledTimes(1);
  });

  it('两价皆 0：免费态 active=总开关、不消费（金币场）', async () => {
    configCache.cardCounterPrices.mockReturnValue({ perGame: 0, perHour: 0 });
    await makeRoom('CC06', 'gold', ['u1']);

    expect(await service.startRoom('CC06', { strict: true })).toBe(true);

    expect(currency.cardCounterConsume).not.toHaveBeenCalled();
    expect(await ccstate('CC06')).toEqual({ '0': JSON.stringify({ active: true }) });
  });

  it('开局失败（ok=false）：零消费、零状态、零发布', async () => {
    handlers.set(RPC_PATTERNS.gameStart, () =>
      of({ ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'down' }),
    );
    await makeRoom('CC07', 'gold', ['u1']);

    expect(await service.startRoom('CC07', { strict: true })).toBe(false);

    expect(currency.cardCounterConsume).not.toHaveBeenCalled();
    expect(await ccstate('CC07')).toEqual({});
    expect(cardCounterEvents()).toEqual([]);
  });

  it('deleteRoom 删除集包含 ccstate（房间回收不留孤儿）', async () => {
    await makeRoom('CC08', 'practice', ['u1']);
    expect(await service.startRoom('CC08', { strict: true })).toBe(true);
    expect(await ccstate('CC08')).not.toEqual({});

    await rooms.deleteRoom('CC08');
    expect(await ccstate('CC08')).toEqual({});
  });
});

/** 无标签指标读数（与 helpers/metric-readout 的 `labeledValue` 配对）。 */
async function metricValue(metric: { get(): Promise<unknown> }): Promise<number> {
  const { values } = (await metric.get()) as { values: Array<{ value: number }> };
  return values[0]?.value ?? 0;
}

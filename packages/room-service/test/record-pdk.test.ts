import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { PdkSettlementResult, RecordWriteRequest } from '@fight-the-landlord/protocol';
import { WsGateway, type GameEvent } from '../src/gateway/ws.gateway';
import { RoomsService } from '../src/rooms/rooms.service';
import { nicknamesKey } from '../src/rooms/rooms.seats';
import { asRedis, createFakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

/**
 * Task 4.3（spec §4.9.2 / §4.6.3）：`game.ended` 的 **pdk 记录信封** → `record.write`。
 *
 * 判据：
 *  - 座位数按 `playerCount`（`exactlySeats(0..playerCount-1)`），2/3 人都不因「不是 3 座」被跳过；
 *  - pdk 请求带 `gameType`/`playerCount`/`seats[].playedCount`/可选 `unusedCards`，**无 `bottomCards`**；
 *  - 机器人座 userId=NULL、robotId 按座位对齐（与 ddz 同口径）；
 *  - 房间玩法与信封不符 / 结算形状不符 ⇒ WARN 跳过（不写错表）。
 */

const pdkResult = (over: Partial<PdkSettlementResult> = {}): PdkSettlementResult => ({
  roomCode: 'PDK1',
  gameType: 'paodekuai',
  playerCount: 3,
  baseScore: 15,
  winnerSeats: [0],
  scoreChanges: [
    { seat: 0, delta: 90 },
    { seat: 1, delta: -60 },
    { seat: 2, delta: -30 },
  ],
  remaining: [0, 4, 2],
  multiplier: 1,
  bombCount: 0,
  guan: false,
  spring: false,
  baobenSeats: [],
  ...over,
});

type Envelope = NonNullable<GameEvent['record']>;

const HAND16 = '11'.repeat(16);
const UNUSED32 = '22'.repeat(16);

function makeHarness() {
  const redis = createFakeRedis();
  const config = makeConfigCache();
  config.paodekuaiEnabled.mockReturnValue(true);
  config.paodekuaiNonThreePlayerEnabled.mockReturnValue(true);
  config.paodekuaiTwoPlayerEnabled.mockReturnValue(true);
  const rooms = new RoomsService(asRedis(redis), asConfigCache(config));
  const recordClient = { write: vi.fn().mockResolvedValue(true) };
  const settle = { settle: vi.fn().mockResolvedValue(undefined), bindBroadcast: vi.fn() };
  const gateway = new WsGateway(
    asRedis(redis),
    {} as never,
    {} as never,
    rooms,
    { startRoom: vi.fn().mockResolvedValue(true) } as never,
    {} as never,
    { release: vi.fn().mockResolvedValue(1) } as never,
    recordClient as never,
    asConfigCache(config),
    { get: vi.fn(), apply: vi.fn() } as never,
    settle as never,
    { report: vi.fn() } as never,
    { ensure: vi.fn().mockResolvedValue(new Map()) } as never,
  );
  const serverEmit = vi.fn();
  gateway.server = { to: vi.fn(() => ({ emit: serverEmit })) } as never;
  return { redis, config, rooms, recordClient, settle, gateway, serverEmit };
}

async function makeThreeSeatPdkRoom(redis: ReturnType<typeof createFakeRedis>, rooms: RoomsService) {
  await rooms.create({ mode: 'random', roomCode: 'PDK1', gameType: 'paodekuai', playerCount: 3 });
  await rooms.join('PDK1', 'alice', 'paodekuai');
  await rooms.addBot('PDK1', 'p_bot1');
  await rooms.addBot('PDK1', 'p_bot2');
  await redis.hset('room:PDK1:bots', '1', 'bot-int-1');
  await redis.hset('room:PDK1:bots', '2', 'bot-int-2');
  await redis.hset(nicknamesKey('PDK1'), { p_bot1: '阿豆', p_bot2: '小北' });
}

describe('Task 4.3：pdk 记录组装与 record.write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Logger.overrideLogger(new Logger());
  });

  it('3 人：座位序 / playedCount / gameType+playerCount / 无 bottomCards / 机器人 userId=null', async () => {
    const { redis, rooms, recordClient, gateway } = makeHarness();
    await makeThreeSeatPdkRoom(redis, rooms);

    const record: Envelope = {
      gameType: 'paodekuai',
      playerCount: 3,
      startedAt: 1_700_000_000_000,
      seats: [
        { seat: 2, playerId: 'p_bot2', hand: HAND16, playedCount: 14 },
        { seat: 0, playerId: 'alice', hand: HAND16, playedCount: 16 },
        { seat: 1, playerId: 'p_bot1', hand: HAND16, playedCount: 12 },
      ],
    };
    gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'PDK1',
      version: 7,
      result: pdkResult(),
      record,
    });

    await vi.waitFor(() => expect(recordClient.write).toHaveBeenCalledTimes(1));
    const request = recordClient.write.mock.calls[0]![0] as RecordWriteRequest;
    expect(request).toEqual({
      roomCode: 'PDK1',
      gameVersion: 7,
      mode: 'random',
      baseScore: expect.any(Number),
      gameType: 'paodekuai',
      playerCount: 3,
      result: pdkResult(),
      seats: [
        {
          seat: 0,
          userId: 'alice',
          isRobot: false,
          robotId: null,
          hand: HAND16,
          playedCount: 16,
          nickname: null,
        },
        {
          seat: 1,
          userId: null,
          isRobot: true,
          robotId: 'bot-int-1',
          hand: HAND16,
          playedCount: 12,
          nickname: '阿豆',
        },
        {
          seat: 2,
          userId: null,
          isRobot: true,
          robotId: 'bot-int-2',
          hand: HAND16,
          playedCount: 14,
          nickname: '小北',
        },
      ],
      startedAt: 1_700_000_000_000,
      endedAt: expect.any(Number),
    });
    expect(request).not.toHaveProperty('bottomCards');
    expect(request).not.toHaveProperty('unusedCards');
    // 绝不写 displayId
    expect(JSON.stringify(request.seats)).not.toContain('p_bot');
  });

  it('2 人：信封座位恰 0..1、unusedCards 原样透传、无 bottomCards', async () => {
    const { redis, rooms, recordClient, gateway } = makeHarness();
    await rooms.create({ mode: 'random', roomCode: 'PDK2', gameType: 'paodekuai', playerCount: 2 });
    await rooms.join('PDK2', 'alice', 'paodekuai');
    await rooms.addBot('PDK2', 'p_bot1');
    await redis.hset('room:PDK2:bots', '1', 'bot-int-1');

    const result = pdkResult({
      roomCode: 'PDK2',
      playerCount: 2,
      winnerSeats: [1],
      scoreChanges: [
        { seat: 0, delta: -30 },
        { seat: 1, delta: 30 },
      ],
      remaining: [2, 0],
      multiplier: 2,
      bombCount: 1,
    });
    gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'PDK2',
      version: 8,
      result,
      record: {
        gameType: 'paodekuai',
        playerCount: 2,
        startedAt: 1_700_000_000_000,
        seats: [
          { seat: 1, playerId: 'p_bot1', hand: HAND16, playedCount: 16 },
          { seat: 0, playerId: 'alice', hand: HAND16, playedCount: 14 },
        ],
        unusedCards: UNUSED32,
      },
    });

    await vi.waitFor(() => expect(recordClient.write).toHaveBeenCalledTimes(1));
    const request = recordClient.write.mock.calls[0]![0] as RecordWriteRequest;
    expect(request.gameType).toBe('paodekuai');
    expect(request.playerCount).toBe(2);
    expect(request.unusedCards).toBe(UNUSED32);
    expect(request).not.toHaveProperty('bottomCards');
    expect(request.seats.map((s) => [s.seat, s.playedCount])).toEqual([
      [0, 14],
      [1, 16],
    ]);
  });

  it('形状不符：信封座位数 ≠ playerCount ⇒ WARN 跳过、不写', async () => {
    const { redis, rooms, recordClient, gateway } = makeHarness();
    await makeThreeSeatPdkRoom(redis, rooms);

    gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'PDK1',
      version: 9,
      result: pdkResult(),
      record: {
        gameType: 'paodekuai',
        playerCount: 3,
        startedAt: 1_700_000_000_000,
        seats: [
          { seat: 0, playerId: 'alice', hand: HAND16, playedCount: 16 },
          { seat: 1, playerId: 'p_bot1', hand: HAND16, playedCount: 12 },
        ],
      },
    });

    await vi.waitFor(() =>
      expect(recordClient.write).not.toHaveBeenCalled(),
    );
    // 等 fire-and-forget 链把跳过日志走完（barrier：后续记录写仍可用）
    await new Promise((r) => setTimeout(r, 10));
    expect(recordClient.write).not.toHaveBeenCalled();
  });

  it('ws 映射：pdk game.ended ⇒ game.finished {gameType,winnerSeats} + game.settlement 向量', async () => {
    const { redis, rooms, recordClient, gateway, serverEmit, settle } = makeHarness();
    await makeThreeSeatPdkRoom(redis, rooms);

    gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'PDK1',
      version: 7,
      result: pdkResult(),
      record: {
        gameType: 'paodekuai',
        playerCount: 3,
        startedAt: 1_700_000_000_000,
        seats: [
          { seat: 0, playerId: 'alice', hand: HAND16, playedCount: 16 },
          { seat: 1, playerId: 'p_bot1', hand: HAND16, playedCount: 12 },
          { seat: 2, playerId: 'p_bot2', hand: HAND16, playedCount: 14 },
        ],
      },
    });
    await vi.waitFor(() => expect(recordClient.write).toHaveBeenCalledTimes(1));

    const callOf = (type: string) =>
      serverEmit.mock.calls.find(([name]) => name === type)?.[1] as
        | { version: number; payload: unknown }
        | undefined;

    // 斗地主旧形状 {winner} 不得出现在 pdk 局
    expect(callOf('game.finished')?.payload).toEqual({
      gameType: 'paodekuai',
      winnerSeats: [0],
    });
    expect(callOf('game.settlement')?.payload).toEqual(pdkResult());
    // 结算服务拿到的是同一份 pdk 向量（按玩法分支由 settle-service 负责）
    expect(settle.settle).toHaveBeenCalledWith(expect.objectContaining({ result: pdkResult() }));
  });

  it('玩法不符：pdk 信封投到斗地主房 ⇒ 跳过（不写错表）', async () => {
    const { rooms, recordClient, gateway } = makeHarness();
    // 斗地主房（缺省 gameType）
    await rooms.create({ mode: 'random', roomCode: 'DDZ1', playerCount: 3 });
    await rooms.join('DDZ1', 'alice');
    await rooms.addBot('DDZ1', 'p_bot1');
    await rooms.addBot('DDZ1', 'p_bot2');

    gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'DDZ1',
      version: 10,
      result: pdkResult(),
      record: {
        gameType: 'paodekuai',
        playerCount: 3,
        startedAt: 1_700_000_000_000,
        seats: [
          { seat: 0, playerId: 'alice', hand: HAND16, playedCount: 16 },
          { seat: 1, playerId: 'p_bot1', hand: HAND16, playedCount: 12 },
          { seat: 2, playerId: 'p_bot2', hand: HAND16, playedCount: 14 },
        ],
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(recordClient.write).not.toHaveBeenCalled();
  });
});

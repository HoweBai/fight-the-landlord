/**
 * Task 2.2 / spec §4.6.2（D16）：REST join 与 WS `room.join` 都必须校验 gameType；
 * 缺省 = doudizhu（旧客户端）；玩法不符 ⇒ `12012 GAME_UNAVAILABLE`，且**占座之前**拒绝。
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Socket } from 'socket.io';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RoomsService } from '../src/rooms/rooms.service';
import { createFakeRedis, asRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';
import { C, makeDeps, makeSocket, route } from './helpers/router-deps';
import { seat } from './helpers/room-fixture';

describe('REST/service join 的 gameType 守卫（Task 2.2）', () => {
  let redis: FakeRedis;
  let cache: ConfigCacheStub;
  let service: RoomsService;

  beforeEach(async () => {
    redis = createFakeRedis();
    cache = makeConfigCache();
    cache.paodekuaiEnabled.mockReturnValue(true);
    service = new RoomsService(asRedis(redis), asConfigCache(cache));
    await service.create({ mode: 'random', roomCode: 'PDK001', gameType: 'paodekuai' });
    await service.create({ mode: 'random', roomCode: 'DDZ001' });
  });

  it('旧客户端（无 gameType）进跑得快房 ⇒ 12012，且**不占座**', async () => {
    const err = await service.join('PDK001', 'old-user').catch((e: unknown) => e);

    expect(err).toMatchObject({ code: ErrCode.GAME_UNAVAILABLE });
    expect(await redis.hgetall('room:PDK001:seats')).toEqual({}); // 占座之前拒绝
  });

  it('带正确 gameType ⇒ 入座；斗地主房带跑得快 ⇒ 12012', async () => {
    const joined = await service.join('PDK001', 'pdk-user', 'paodekuai');
    expect(joined.players).toEqual([seat('pdk-user', 0)]);

    const err = await service.join('DDZ001', 'pdk-user', 'paodekuai').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrCode.GAME_UNAVAILABLE });
    expect(await redis.hgetall('room:DDZ001:seats')).toEqual({});
  });

  it('旧客户端进斗地主房（缺省 doudizhu）⇒ 入座（零破坏）', async () => {
    const joined = await service.join('DDZ001', 'old-user');
    expect(joined.players).toEqual([seat('old-user', 0)]);
  });
});

describe('WS room.join 的 gameType 守卫（Task 2.2）', () => {
  const roomOf = (gameType: 'doudizhu' | 'paodekuai') => ({
    code: 'ROOM1',
    mode: 'random' as const,
    players: [seat('alice', 0)],
    maxPlayers: 3,
    status: 'waiting' as const,
    baseScore: 15,
    createdAt: Date.now(),
    timeoutAt: Date.now() + 30_000,
    gameType,
  });

  function sock(): Socket {
    return makeSocket('alice') as unknown as Socket;
  }

  it('旧客户端（无 gameType）进跑得快房 ⇒ ack 12012；不 join socket、不 touch、不清票', async () => {
    const { deps, rooms, reconnect, match } = makeDeps();
    rooms.findOne.mockResolvedValue(roomOf('paodekuai'));

    const socket = sock();
    const ack = await route(deps, socket, C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(ErrCode.GAME_UNAVAILABLE);
    expect(socket.join).not.toHaveBeenCalled();
    expect(reconnect.touch).not.toHaveBeenCalled();
    expect(match.cancelQueue).not.toHaveBeenCalled();
  });

  it('带正确 gameType ⇒ 正常入座（旧客户端进斗地主房同样放行）', async () => {
    const { deps, rooms } = makeDeps();
    rooms.findOne.mockResolvedValue(roomOf('paodekuai'));

    const pdkAck = await route(
      deps,
      sock(),
      C('room.join', { roomCode: 'ROOM1', gameType: 'paodekuai' }),
    );
    expect(pdkAck.code).toBe(ErrCode.OK);

    const { deps: ddzDeps, rooms: ddzRooms } = makeDeps();
    ddzRooms.findOne.mockResolvedValue(roomOf('doudizhu'));
    const oldAck = await route(ddzDeps, sock(), C('room.join', { roomCode: 'ROOM1' }));
    expect(oldAck.code).toBe(ErrCode.OK);
  });

  it('入座后的 room.state_update 回调带 gameType/playerCount（WS 出站由 gateway 组装）', async () => {
    const { deps, rooms, roomStateEvents } = makeDeps();
    rooms.findOne.mockResolvedValue(roomOf('paodekuai'));

    await route(deps, sock(), C('room.join', { roomCode: 'ROOM1', gameType: 'paodekuai' }));

    expect(roomStateEvents).toHaveLength(1);
    expect(roomStateEvents[0]).toMatchObject({
      roomCode: 'ROOM1',
      status: 'waiting',
      gameType: 'paodekuai',
      playerCount: 3,
    });
  });

  it('RH4：重连 ack 的 trustees 按**实际长度**改写（4 人不被截成 3 元组）', async () => {
    const { deps, reconnect, game } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue({
      roomCode: 'ROOM1',
      source: 'record',
      status: 'playing',
    });
    game.view.mockResolvedValue({
      roomCode: 'ROOM1',
      version: 3,
      state: 'playing',
      seat: 2,
      trustees: [true, true, true, true],
      cardCounts: [5, 5, 5, 5],
      hand: [],
      recentActions: [],
      currentPlayer: 0,
      baseScore: 15,
      turnDeadlineAt: Date.now(),
      playerCount: 4,
      gameType: 'paodekuai',
    });

    const ack = await route(deps, sock(), C('game.reconnect', {}));

    expect(ack.code).toBe(ErrCode.OK);
    expect((ack.data as { trustees: boolean[] }).trustees).toEqual([true, true, false, true]);
  });
});

/**
 * Task 2.2 / spec §4.6.2：`POST /api/rooms` 的玩法/人数、GET 列表的 `gameType` 过滤，
 * 以及 12012 的 HTTP 4xx 映射（REST 不得变 500）。
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { validate } from 'class-validator';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RoomsController } from '../src/rooms/rooms.controller';
import { CreateRoomDto } from '../src/rooms/rooms.dto';
import { DomainError } from '../src/http/errors';
import type { Room, RoomsService } from '../src/rooms/rooms.service';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';

const room = (over: Partial<Room> = {}): Room => ({
  code: 'AAA111',
  mode: 'random',
  baseScore: 15,
  players: [],
  maxPlayers: 3,
  status: 'waiting',
  createdAt: Date.now(),
  timeoutAt: Date.now() + 30_000,
  gameType: 'doudizhu',
  ...over,
});

describe('POST /api/rooms 的 gameType/playerCount（Task 2.2）', () => {
  let cache: ConfigCacheStub;
  let rooms: {
    findAll: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    join: ReturnType<typeof vi.fn>;
    setFillDeadline: ReturnType<typeof vi.fn>;
  };
  let controller: RoomsController;

  beforeEach(() => {
    cache = makeConfigCache();
    cache.friendRoomEnabled.mockReturnValue(true);
    rooms = { findAll: vi.fn(), create: vi.fn(), join: vi.fn(), setFillDeadline: vi.fn() };
    controller = new RoomsController(rooms as unknown as RoomsService, asConfigCache(cache));
  });

  it('DTO 有 gameType/playerCount 的校验元数据（whitelist 不会剥掉它们）', async () => {
    const ok = Object.assign(new CreateRoomDto(), {
      mode: 'random',
      gameType: 'paodekuai',
      playerCount: 4,
    });
    await expect(validate(ok)).resolves.toEqual([]);

    const badGame = Object.assign(new CreateRoomDto(), { mode: 'random', gameType: 'ddz' });
    expect((await validate(badGame)).length).toBeGreaterThan(0);

    const badCount = Object.assign(new CreateRoomDto(), { mode: 'random', playerCount: 4.5 });
    expect((await validate(badCount)).length).toBeGreaterThan(0);
  });

  it('create 把玩法/人数原样交给 service，并在 RoomInfo 出站 gameType', async () => {
    rooms.create.mockResolvedValue(
      room({ code: 'PDK123', gameType: 'paodekuai', maxPlayers: 4 }),
    );

    const resp = await controller.create({
      mode: 'random',
      gameType: 'paodekuai',
      playerCount: 4,
    } as CreateRoomDto);

    expect(rooms.create).toHaveBeenCalledWith(
      { mode: 'random', gameType: 'paodekuai', playerCount: 4 },
      expect.any(Object),
    );
    expect(resp.code).toBe(ErrCode.OK);
    expect(resp.data).toMatchObject({ code: 'PDK123', gameType: 'paodekuai', maxPlayers: 4 });
  });

  it('service 抛 12012 ⇒ HTTP 400 + 信封码 12012（不得落成 500）', async () => {
    rooms.create.mockRejectedValue(new DomainError(ErrCode.GAME_UNAVAILABLE, '该玩法暂未开放'));

    const err = await controller
      .create({ mode: 'random', gameType: 'paodekuai' } as CreateRoomDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(400);
    expect((err as HttpException).getResponse()).toMatchObject({ code: ErrCode.GAME_UNAVAILABLE });
  });
});

describe('GET /api/rooms 的 gameType 过滤（Task 2.2）', () => {
  let cache: ConfigCacheStub;
  let rooms: { findAll: ReturnType<typeof vi.fn> };
  let controller: RoomsController;

  beforeEach(() => {
    cache = makeConfigCache();
    cache.friendRoomEnabled.mockReturnValue(true);
    rooms = { findAll: vi.fn() };
    controller = new RoomsController(rooms as unknown as RoomsService, asConfigCache(cache));
  });

  it('缺省只返回斗地主房（旧房间缺 gameType 也按斗地主计）', async () => {
    rooms.findAll.mockResolvedValue([
      room({ code: 'DDZ001' }),
      room({ code: 'LEGACY', gameType: undefined }),
      room({ code: 'PDK001', gameType: 'paodekuai' }),
    ]);

    const resp = await controller.findAll();

    expect(resp.data.map((r) => r.code)).toEqual(['DDZ001', 'LEGACY']);
  });

  it('gameType=paodekuai 只返回跑得快房', async () => {
    rooms.findAll.mockResolvedValue([
      room({ code: 'DDZ001' }),
      room({ code: 'PDK001', gameType: 'paodekuai' }),
    ]);

    const resp = await controller.findAll('paodekuai');

    expect(resp.data.map((r) => r.code)).toEqual(['PDK001']);
  });

  it('非法 gameType ⇒ 10001（协议语义，不静默当斗地主）', async () => {
    const err = await controller.findAll('ddz').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getResponse()).toMatchObject({ code: ErrCode.BAD_PARAM });
    expect(rooms.findAll, '非法查询不得触碰 service').not.toHaveBeenCalled();
  });
});

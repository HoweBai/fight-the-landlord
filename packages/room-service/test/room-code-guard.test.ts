import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RoomsController } from '../src/rooms/rooms.controller';
import { RoomsService, type Room } from '../src/rooms/rooms.service';
import { CreateRoomDto } from '../src/rooms/rooms.dto';
import { MANUAL_ROOM_TIMEOUT_MS } from '../src/rooms/rooms.timeout';
import { createFakeRedis, asRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

/**
 * 审查 P0-1：`POST /api/rooms` 不得把客户端自带 `roomCode` 透传到 service。
 *
 * 背景：`POST` 在网关后已认证，但 controller 曾把 `dto` 原样透传；任何已认证玩家
 * 拿到进行中金币房号后即可覆盖 `room:{code}` 元数据（mode/gameType），局终结算
 * 静默跳过或记录丢失。HTTP 无任何合法传码调用点 ⇒ 入口剥离 + service 纵深校验。
 */
const room = (over: Partial<Room> = {}): Room => ({
  code: 'AAA111',
  mode: 'random',
  baseScore: 15,
  maxPlayers: 3,
  status: 'waiting',
  createdAt: Date.now(),
  timeoutAt: Date.now() + 30_000,
  players: [],
  gameType: 'doudizhu',
  ...over,
});

describe('建房 roomCode 收口（审查 P0-1）', () => {
  let cache: ReturnType<typeof makeConfigCache>;
  let rooms: {
    create: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    join: ReturnType<typeof vi.fn>;
    setFillDeadline: ReturnType<typeof vi.fn>;
  };
  let controller: RoomsController;

  beforeEach(() => {
    cache = makeConfigCache();
    cache.friendRoomEnabled.mockReturnValue(true);
    rooms = {
      create: vi.fn().mockResolvedValue(room({ code: 'NEW123' })),
      findAll: vi.fn(),
      join: vi.fn(),
      setFillDeadline: vi.fn(),
    };
    controller = new RoomsController(rooms as unknown as RoomsService, asConfigCache(cache));
  });

  it('HTTP 请求体带 roomCode 时，controller 不把它交给 service', async () => {
    await controller.create({ mode: 'practice', roomCode: 'EVIL01' } as unknown as CreateRoomDto);

    expect(rooms.create).toHaveBeenCalledWith(
      { mode: 'practice' },
      { timeoutMs: MANUAL_ROOM_TIMEOUT_MS },
    );
    expect(rooms.create.mock.calls[0]![0]).not.toHaveProperty('roomCode');
  });

  it('其余合法字段仍原样透传（gameType/playerCount/baseScore）', async () => {
    await controller.create({
      mode: 'practice',
      gameType: 'paodekuai',
      playerCount: 4,
      baseScore: 80,
      roomCode: 'EVIL01',
    } as unknown as CreateRoomDto);

    expect(rooms.create).toHaveBeenCalledWith(
      { mode: 'practice', gameType: 'paodekuai', playerCount: 4, baseScore: 80 },
      { timeoutMs: MANUAL_ROOM_TIMEOUT_MS },
    );
  });
});

describe('RoomsService 对内部 roomCode 的纵深校验（审查 P0-1）', () => {
  let service: RoomsService;
  let redis: FakeRedis;

  beforeEach(() => {
    redis = createFakeRedis();
    service = new RoomsService(asRedis(redis), asConfigCache(makeConfigCache()));
  });

  it.each([
    ['空串', ''],
    ['含冒号（可注入派生键）', 'ABC:seats'],
    ['含空白', 'A B C'],
    ['超长', 'X'.repeat(33)],
  ])('非法房号（%s）⇒ 10001 且不写 meta', async (_label, code) => {
    await expect(service.create({ mode: 'practice', roomCode: code })).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
    });
    expect(redis.hashes.size).toBe(0);
  });

  it('已存在的房号 ⇒ 10001，且不覆盖原房 meta', async () => {
    await service.create({ mode: 'practice', roomCode: 'DUP001' });
    const before = { ...redis.hashes.get('room:DUP001')! };

    await expect(
      service.create({ mode: 'gold', roomCode: 'DUP001' }),
    ).rejects.toMatchObject({ code: ErrCode.BAD_PARAM });

    expect(redis.hashes.get('room:DUP001')).toEqual(before);
  });

  it('短码合法（兼容既有夹具；不强制 6 位）', async () => {
    await expect(service.create({ mode: 'practice', roomCode: 'ROOM1' })).resolves.toMatchObject({
      code: 'ROOM1',
      mode: 'practice',
    });
  });
});

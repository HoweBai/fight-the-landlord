/**
 * Task 2.2 / spec §4.6.2：`RoomMeta` / `RoomInfo` 的玩法字段。
 *
 * 三条硬约束：
 *  ① `RoomMeta.gameType` 进 `META_FIELDS`，但**旧 Hash 缺它不得当坏房**（读作 doudizhu + WARN）；
 *  ② `writeMeta` 写 `gameType ?? 'doudizhu'` —— 绝不落盘字符串 `"undefined"`；
 *  ③ `RoomInfo.playerCount` 仍是**当前占用**（不是容量），容量看 `maxPlayers`。
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger, type LogRecord } from '@fight-the-landlord/shared';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RoomsService, toRoomInfo } from '../src/rooms/rooms.service';
import { startAttemptsKey } from '../src/rooms/rooms.seats';
import { createFakeRedis, asRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';

describe('RoomMeta / RoomInfo 多玩法字段（Task 2.2）', () => {
  let redis: FakeRedis;
  let cache: ConfigCacheStub;
  let service: RoomsService;

  beforeEach(() => {
    redis = createFakeRedis();
    cache = makeConfigCache();
    service = new RoomsService(asRedis(redis), asConfigCache(cache));
  });

  afterEach(() => {
    Logger.overrideLogger(new Logger());
  });

  it('create 默认写 gameType=doudizhu；Hash 恰八个字段，且没有字符串 "undefined"', async () => {
    const created = await service.create({ mode: 'random', roomCode: 'META01' });

    expect(created.gameType).toBe('doudizhu');
    expect(created.maxPlayers).toBe(3);
    const hash = redis.hashes.get('room:META01')!;
    expect(Object.keys(hash).sort()).toEqual(
      ['baseScore', 'code', 'createdAt', 'gameType', 'maxPlayers', 'mode', 'status', 'timeoutAt'].sort(),
    );
    expect(hash.gameType).toBe('doudizhu');
    expect(hash.gameType).not.toBe('undefined');
    for (const value of Object.values(hash)) expect(typeof value).toBe('string');
  });

  it('create 跑得快 3 人 / 4 人 ⇒ gameType 与 maxPlayers 跟随；档位读 pdk 表', async () => {
    cache.paodekuaiEnabled.mockReturnValue(true);
    cache.paodekuaiNonThreePlayerEnabled.mockReturnValue(true);
    cache.baseScoreLevels.mockResolvedValue([{ name: '跑得快休闲', baseScore: 30 }]);

    const three = await service.create({ mode: 'random', roomCode: 'PDK003', gameType: 'paodekuai' });
    expect(three).toMatchObject({ gameType: 'paodekuai', maxPlayers: 3, baseScore: 30 });
    expect(cache.baseScoreLevels).toHaveBeenCalledWith('paodekuai');

    const four = await service.create({
      mode: 'random',
      roomCode: 'PDK004',
      gameType: 'paodekuai',
      playerCount: 4,
    });
    expect(four).toMatchObject({ gameType: 'paodekuai', maxPlayers: 4 });
    expect(redis.hashes.get('room:PDK004')!.maxPlayers).toBe('4');
  });

  it('旧 Hash 缺 gameType ⇒ 读作 doudizhu（房间不消失）；写回补齐后再读一致', async () => {
    await service.create({ mode: 'random', roomCode: 'OLD001' });
    // 模拟部署窗口里的旧服务写下的 Hash（没有 gameType 字段）
    delete redis.hashes.get('room:OLD001')!.gameType;

    const old = await service.findOne('OLD001');
    expect(old).not.toBeNull();
    expect(old!.gameType).toBe('doudizhu');

    // 任意一次写回（updateStatus 走 writeMeta）必须补齐 —— 不得把 undefined 写成字符串
    await service.updateStatus('OLD001', 'finished');
    expect(redis.hashes.get('room:OLD001')!.gameType).toBe('doudizhu');

    const again = await service.findOne('OLD001');
    expect(again!.gameType).toBe('doudizhu');
  });

  it('非法 gameType（含历史写回的字符串 "undefined"）⇒ doudizhu + WARN（不消失）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

    await service.create({ mode: 'random', roomCode: 'BAD001' });
    redis.hashes.get('room:BAD001')!.gameType = 'undefined';

    const room = await service.findOne('BAD001');
    expect(room).not.toBeNull();
    expect(room!.gameType).toBe('doudizhu');
    expect(records.some((r: LogRecord) => r.msg.includes('gameType'))).toBe(true);
  });

  it('玩法关闭 / 人数未开放 ⇒ 12012（且一个键都不写）', async () => {
    const disabled = await service
      .create({ mode: 'random', roomCode: 'PDKX01', gameType: 'paodekuai' })
      .catch((e: unknown) => e);
    expect(disabled).toMatchObject({ code: ErrCode.GAME_UNAVAILABLE });
    expect(redis.hashes.has('room:PDKX01')).toBe(false);

    cache.paodekuaiEnabled.mockReturnValue(true); // 玩法开，但 2/4 人闸仍关
    const four = await service
      .create({ mode: 'random', roomCode: 'PDKX02', gameType: 'paodekuai', playerCount: 4 })
      .catch((e: unknown) => e);
    expect(four).toMatchObject({ code: ErrCode.GAME_UNAVAILABLE });
    expect(redis.hashes.has('room:PDKX02')).toBe(false);

    const ddzFour = await service
      .create({ mode: 'random', roomCode: 'DDZX01', playerCount: 4 })
      .catch((e: unknown) => e);
    expect(ddzFour).toMatchObject({ code: ErrCode.GAME_UNAVAILABLE });
    expect(redis.hashes.has('room:DDZX01')).toBe(false);

    cache.doudizhuEnabled.mockReturnValue(false);
    const ddzOff = await service
      .create({ mode: 'random', roomCode: 'DDZX02' })
      .catch((e: unknown) => e);
    expect(ddzOff).toMatchObject({ code: ErrCode.GAME_UNAVAILABLE });
    expect(redis.hashes.has('room:DDZX02')).toBe(false);
    cache.doudizhuEnabled.mockReturnValue(true);
  });

  it('deleteRoom 删除集包含 room:{code}:start_attempts（开局重试预算键）', async () => {
    await service.create({ mode: 'random', roomCode: 'DEL001' });
    redis.strings.set(startAttemptsKey('DEL001'), '3');

    await service.deleteRoom('DEL001');

    expect(redis.strings.has(startAttemptsKey('DEL001'))).toBe(false);
  });

  it('toRoomInfo：gameType 出站、playerCount = 当前占用（容量在 maxPlayers）', async () => {
    cache.paodekuaiEnabled.mockReturnValue(true);
    await service.create({ mode: 'random', roomCode: 'INFO01', gameType: 'paodekuai' });
    await service.join('INFO01', 'u1', 'paodekuai');

    const info = toRoomInfo((await service.findOne('INFO01'))!);
    expect(info).toEqual({
      code: 'INFO01',
      mode: 'random',
      status: 'waiting',
      playerCount: 1,
      maxPlayers: 3,
      baseScore: 15,
      gameType: 'paodekuai',
    });
  });
});

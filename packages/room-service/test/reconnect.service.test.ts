import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { RECONNECT_HASH_KEY, ReconnectService } from '../src/reconnect/reconnect.service';
import { asRedis, createFakeRedis, type FakeRedis } from './helpers/fake-redis';

/**
 * `ReconnectService` 的契约测试（规格 v1.1 §2.1 写点 / §2.2 resolver / §2.7 退役清单）。
 *
 * ⚠️ 窗口时代（30 秒窗口、独立键 `SET … EX 35`、只读校验方法、可注入时钟）
 * 已随用户裁决 K1 整体退役（退役符号名见规格 §2.7，本文件不再引用）。
 * 时间确定性改由**假时钟**承载（`vi.useFakeTimers` + `setSystemTime`）——
 * `touch()` 的 `connectedAt` 断言因此不再依赖构造注入；负对照「不得写独立键 /
 * 不得对不存在的键 `expire`」保留为回归判据。
 */
describe('ReconnectService', () => {
  let redis: FakeRedis;
  let service: ReconnectService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    redis = createFakeRedis();
    service = new ReconnectService(asRedis(redis));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── touch：在线观测点写入（§2.1 的统一写入口）────────────────

  it('touch 只写哈希字段，不再写独立键（窗口退役）', async () => {
    await service.touch('alice', 'sock-1', 'ROOM1');

    const raw = await redis.hget(RECONNECT_HASH_KEY, 'alice');
    expect(JSON.parse(raw!)).toEqual({ socketId: 'sock-1', roomCode: 'ROOM1', connectedAt: Date.now() });
    expect(redis.set).not.toHaveBeenCalled(); // 独立键写入已退役
    expect(redis.ttls.has(RECONNECT_HASH_KEY)).toBe(false); // 哈希无 TTL
    expect(redis.expire).not.toHaveBeenCalled(); // 对不存在的键 expire 的旧形态不得回归
  });

  it('roomCode 缺省时沿用已有记录的房间（disconnect / 换链路场景）', async () => {
    await redis.hset(
      RECONNECT_HASH_KEY,
      'alice',
      JSON.stringify({ socketId: 'old-sock', roomCode: 'ROOM9', connectedAt: 1 }),
    );

    vi.setSystemTime(Date.now() + 30_000);
    const record = await service.touch('alice', 'sock-2');

    expect(record).toEqual({ socketId: 'sock-2', roomCode: 'ROOM9', connectedAt: Date.now() });
    expect(JSON.parse((await redis.hget(RECONNECT_HASH_KEY, 'alice'))!).roomCode).toBe('ROOM9');
  });

  it('每次 touch 都把 connectedAt 刷成当前时刻（在线观测点刷新）', async () => {
    const first = await service.touch('alice', 'sock-1', 'ROOM1');
    vi.setSystemTime(Date.now() + 60_000);
    const second = await service.touch('alice', 'sock-2', 'ROOM1');

    expect(first!.connectedAt).toBe(1_700_000_000_000);
    expect(second!.connectedAt).toBe(Date.now());
    expect(JSON.parse((await redis.hget(RECONNECT_HASH_KEY, 'alice'))!).connectedAt).toBe(Date.now());
  });

  it('既无 roomCode 也无既有记录时不写任何键（玩家从未入房）', async () => {
    const record = await service.touch('nobody', 'sock-1');

    expect(record).toBeNull();
    expect(await redis.hget(RECONNECT_HASH_KEY, 'nobody')).toBeNull();
    expect(redis.set).not.toHaveBeenCalled();
  });

  // ─── clearConnection：显式离开 ──────────────────────────────────

  it('clearConnection 只删哈希（显式离开）', async () => {
    await service.touch('alice', 'sock-1', 'ROOM1');
    await service.clearConnection('alice');

    expect(await redis.hget(RECONNECT_HASH_KEY, 'alice')).toBeNull();
    expect(redis.hdel).toHaveBeenCalledWith(RECONNECT_HASH_KEY, 'alice');
    expect(redis.del).not.toHaveBeenCalled(); // 独立键已退役
  });

  it('clearConnection 对从未入房的玩家是幂等的', async () => {
    await expect(service.clearConnection('nobody')).resolves.toBeUndefined();
  });

  describe('resolveRecoverableRoom（规格 v1.1 §2.2：存活谓词）', () => {
    const seedRoom = (r: FakeRedis, code: string, status: string) =>
      r.hset(`room:${code}`, 'status', status);

    it('无任何凭据 → null', async () => {
      expect(await service.resolveRecoverableRoom('alice')).toBeNull();
    });

    it('双候选同时存活 ⇒ pending 优先（最新开局结果）', async () => {
      await redis.hset('match:pending:alice', 'roomCode', 'ROOM-B');
      await service.touch('alice', 'sock-1', 'ROOM-A');
      await seedRoom(redis, 'ROOM-A', 'playing');
      await seedRoom(redis, 'ROOM-B', 'playing');

      expect(await service.resolveRecoverableRoom('alice')).toEqual({
        roomCode: 'ROOM-B', source: 'ticket', status: 'playing',
      });
    });

    it('pending 指向已死房 ⇒ 回退存活哈希（一轮审查阻断项的单测回归）', async () => {
      await redis.hset('match:pending:alice', 'roomCode', 'DEAD');
      await service.touch('alice', 'sock-1', 'ROOM-A');
      await seedRoom(redis, 'ROOM-A', 'playing');
      // 刻意不铺 DEAD 的房间键

      expect(await service.resolveRecoverableRoom('alice')).toEqual({
        roomCode: 'ROOM-A', source: 'record', status: 'playing',
      });
    });

    it('都不存活但房间键在 ⇒ 第二遍返回（供 13005/13009 映射）', async () => {
      await service.touch('alice', 'sock-1', 'ROOM-A');
      await seedRoom(redis, 'ROOM-A', 'finished');

      expect(await service.resolveRecoverableRoom('alice')).toEqual({
        roomCode: 'ROOM-A', source: 'record', status: 'finished',
      });
    });

    it('损坏记录（JSON 解析失败）按缺席跳过，不阻断其它候选', async () => {
      await redis.hset(RECONNECT_HASH_KEY, 'alice', 'not-json');
      await redis.hset('match:pending:alice', 'roomCode', 'ROOM-B');
      await seedRoom(redis, 'ROOM-B', 'waiting');

      expect((await service.resolveRecoverableRoom('alice'))!.roomCode).toBe('ROOM-B');
    });

    it('记录缺 roomCode ⇒ 按缺席跳过（readRecord 的字段校验，无候选 ⇒ null）', async () => {
      await redis.hset(RECONNECT_HASH_KEY, 'alice', JSON.stringify({ socketId: 's' }));

      expect(await service.resolveRecoverableRoom('alice')).toBeNull();
    });

    it('毒键（WRONGTYPE）按缺席跳过并记 WARN（不得上抛）', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      // ⚠️ 播种用直 hset（不得先调 service.touch —— 它自己会读一次 hget，把 once 拒绝吃掉）
      await redis.hset(
        RECONNECT_HASH_KEY,
        'alice',
        JSON.stringify({ socketId: 's', roomCode: 'ROOM-A', connectedAt: 0 }),
      );
      await seedRoom(redis, 'ROOM-A', 'playing');
      // 下一次 hget = resolver 的 ticket 读取 ⇒ 毒键被跳过 ⇒ 走 record 候选
      (redis.hget as any).mockRejectedValueOnce(
        new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
      );

      expect(await service.resolveRecoverableRoom('alice')).toEqual({
        roomCode: 'ROOM-A', source: 'record', status: 'playing',
      });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('record 候选毒键（reconnect:active 键整体 WRONGTYPE）⇒ 按缺席跳过，不阻断 ticket 候选', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await redis.hset('match:pending:alice', 'roomCode', 'ROOM-B');
      await seedRoom(redis, 'ROOM-B', 'waiting');
      // 调用序：① ticket 读取（正常）⇒ ② record 读取（毒键）—— 用 once 链精确命中第 2 次
      const realHget = (redis.hget as any).getMockImplementation()!;
      (redis.hget as any)
        .mockImplementationOnce(realHget)
        .mockRejectedValueOnce(
          new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
        );

      expect(await service.resolveRecoverableRoom('alice')).toEqual({
        roomCode: 'ROOM-B', source: 'ticket', status: 'waiting',
      });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('双候选都指向已死房（无房间键）⇒ null（第二遍也无线索）', async () => {
      await redis.hset('match:pending:alice', 'roomCode', 'DEAD-1');
      await redis.hset(
        RECONNECT_HASH_KEY,
        'alice',
        JSON.stringify({ socketId: 's', roomCode: 'DEAD-2', connectedAt: 0 }),
      );

      expect(await service.resolveRecoverableRoom('alice')).toBeNull();
    });

    it('连接级读失败（非 WRONGTYPE）⇒ 上抛（不得静默跳过存活候选）', async () => {
      await service.touch('alice', 'sock-1', 'ROOM-A');
      await seedRoom(redis, 'ROOM-A', 'playing');
      (redis.hget as any).mockRejectedValueOnce(new Error('Connection is closed.'));

      await expect(service.resolveRecoverableRoom('alice')).rejects.toThrow('Connection is closed.');
    });

    it('房间键在但 status 字段缺失（坏 meta）⇒ 按不存在处理', async () => {
      await service.touch('alice', 'sock-1', 'ROOM-A');
      await redis.hset('room:ROOM-A', 'other', 'x'); // 键在、无 status

      expect(await service.resolveRecoverableRoom('alice')).toBeNull();
    });
  });
});

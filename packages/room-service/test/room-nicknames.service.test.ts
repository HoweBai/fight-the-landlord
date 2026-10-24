import { describe, expect, it, vi } from 'vitest';
import { ROOM_TTL_SECONDS } from '../src/rooms/rooms.seats';
import { RoomNicknamesService } from '../src/rooms/room-nicknames.service';
import { seat } from './helpers/room-fixture';

/** 最小 Redis Hash 仿真：只实现本服务用到的 hgetall/hset/expire。 */
function fakeRedis(initial: Record<string, string> = {}) {
  const hash = new Map<string, string>(Object.entries(initial));
  const hgetall = vi.fn(async () => Object.fromEntries(hash));
  const hset = vi.fn(async (_key: string, fields: Record<string, string>) => {
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
    return Object.keys(fields).length;
  });
  const expire = vi.fn(async () => 1);
  return { redis: { hgetall, hset, expire } as never, hash, hgetall, hset, expire };
}

function fakeClient(result: Map<string, string | null>) {
  return { getNicknames: vi.fn(async () => result) };
}

describe('RoomNicknamesService.ensure', () => {
  it('缓存命中 ⇒ 不回源', async () => {
    const { redis } = fakeRedis({ u1: '阿豆' });
    const client = fakeClient(new Map());
    const service = new RoomNicknamesService(redis, client as never);

    const result = await service.ensure('ROOM1', [seat('u1', 0)]);

    expect(result.get('u1')).toBe('阿豆');
    expect(client.getNicknames).not.toHaveBeenCalled();
  });

  it('缓存里的机器人 displayId 也会返回；回源只查人类', async () => {
    const { redis } = fakeRedis({ p_abc: '阿豆' });
    const client = fakeClient(new Map([['u1', '小北']]));
    const service = new RoomNicknamesService(redis, client as never);

    const result = await service.ensure('ROOM1', [seat('u1', 0), seat('p_abc', 1, true)]);

    expect(result.get('p_abc')).toBe('阿豆');
    expect(result.get('u1')).toBe('小北');
    // 机器人 displayId 绝不进 RPC
    expect(client.getNicknames).toHaveBeenCalledWith(['u1']);
  });

  it('无缓存负例：机器人 displayId 不参与回源，也不出现在结果里', async () => {
    const { redis } = fakeRedis();
    const client = fakeClient(new Map());
    const service = new RoomNicknamesService(redis, client as never);

    const result = await service.ensure('ROOM1', [seat('p_abc', 1, true)]);

    expect(result.has('p_abc')).toBe(false);
    expect(client.getNicknames).not.toHaveBeenCalled();
  });

  it('缓存缺失 ⇒ 只对**人类**座位批量回源，并写缓存 + TTL', async () => {
    const { redis, hash, hset, expire } = fakeRedis();
    const client = fakeClient(
      new Map([
        ['u1', '阿豆'],
        ['u2', null],
      ]),
    );
    const service = new RoomNicknamesService(redis, client as never);

    const result = await service.ensure('ROOM1', [
      seat('u1', 0),
      seat('bot-1', 1, true),
      seat('u2', 2),
    ]);

    expect(client.getNicknames).toHaveBeenCalledWith(['u1', 'u2']);
    expect(result.get('u1')).toBe('阿豆');
    expect(result.has('u2')).toBe(false);
    // 空串 = 「已知无昵称」哨兵，避免存量用户每次推送都重查
    expect(hash.get('u2')).toBe('');
    expect(hset).toHaveBeenCalledWith('room:ROOM1:nicknames', { u1: '阿豆', u2: '' });
    expect(expire).toHaveBeenCalledWith('room:ROOM1:nicknames', ROOM_TTL_SECONDS);
  });

  it('哨兵命中 ⇒ 不再回源', async () => {
    const { redis } = fakeRedis({ u1: '' });
    const client = fakeClient(new Map());
    const service = new RoomNicknamesService(redis, client as never);

    await service.ensure('ROOM1', [seat('u1', 0)]);

    expect(client.getNicknames).not.toHaveBeenCalled();
  });

  it('回源失败（空 map）⇒ 不写缓存，本次返回已缓存的部分', async () => {
    const { redis, hset } = fakeRedis({ u9: '已缓存' });
    const client = fakeClient(new Map());
    const service = new RoomNicknamesService(redis, client as never);

    const result = await service.ensure('ROOM1', [seat('u1', 0), seat('u9', 1)]);

    expect(result.get('u9')).toBe('已缓存');
    expect(result.has('u1')).toBe(false);
    expect(hset).not.toHaveBeenCalled();
  });
});

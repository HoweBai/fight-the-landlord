import { describe, expect, it, vi } from 'vitest';
import {
  BOT_DISPLAY_NAMES,
  BOT_NAMES_RELEASE_LOCK_LUA,
  assignBotDisplayNames,
  ensureBotDisplayNames,
  fnv1a32,
} from '../src/rooms/bot-names';
import { botNamesLockKey, nicknamesKey, ROOM_TTL_SECONDS } from '../src/rooms/rooms.seats';
import { asRedis, createFakeRedis, type FakeRedis } from './helpers/fake-redis';

const FORBIDDEN = ['机器人', '人机', '电脑', 'AI', 'bot', '系统', '官方'];

describe('BOT_DISPLAY_NAMES：池内容机械约束', () => {
  it('≥ 200、唯一、trim 后 2–8 字、不含禁词', () => {
    expect(BOT_DISPLAY_NAMES.length).toBeGreaterThanOrEqual(200);
    expect(new Set(BOT_DISPLAY_NAMES).size).toBe(BOT_DISPLAY_NAMES.length);
    for (const name of BOT_DISPLAY_NAMES) {
      expect(name).toBe(name.trim());
      expect(name.length).toBeGreaterThanOrEqual(2);
      expect(name.length).toBeLessThanOrEqual(8);
      for (const word of FORBIDDEN) {
        expect(name.includes(word), `「${name}」含禁词「${word}」`).toBe(false);
      }
    }
  });
});

describe('fnv1a32', () => {
  it('稳定且落在 32 位无符号范围', () => {
    for (const input of ['', 'ROOM1:p_abc:1', '中文房号']) {
      const a = fnv1a32(input);
      expect(a).toBe(fnv1a32(input));
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(2 ** 32);
    }
  });

  it('已知答案（FNV-1a 32 位标准向量）', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });
});

describe('assignBotDisplayNames：纯函数分配', () => {
  it('按 seat 升序返回，输入顺序不影响结果', () => {
    const robots = [
      { seat: 2, displayId: 'p_00000002' },
      { seat: 0, displayId: 'p_00000000' },
      { seat: 1, displayId: 'p_00000001' },
    ];
    const forward = assignBotDisplayNames('ROOM-A', robots);
    const backward = assignBotDisplayNames('ROOM-A', [...robots].reverse());
    expect(forward).toEqual(backward);
    expect(forward.map((r) => r.displayId)).toEqual([
      'p_00000000',
      'p_00000001',
      'p_00000002',
    ]);
    expect(forward.map((r) => r.nickname)).toEqual(backward.map((r) => r.nickname));
  });

  it('同输入幂等', () => {
    const robots = [
      { seat: 0, displayId: 'p_a' },
      { seat: 1, displayId: 'p_b' },
    ];
    expect(assignBotDisplayNames('ROOM-B', robots)).toEqual(
      assignBotDisplayNames('ROOM-B', robots),
    );
  });

  it('批内去重，且避开 taken 中的昵称', () => {
    const robots = [
      { seat: 0, displayId: 'p_a' },
      { seat: 1, displayId: 'p_b' },
      { seat: 2, displayId: 'p_c' },
    ];
    const first = assignBotDisplayNames('ROOM-C', robots);
    const taken = first.map((r) => r.nickname);
    const second = assignBotDisplayNames('ROOM-C', robots, taken);
    expect(new Set(second.map((r) => r.nickname)).size).toBe(second.length);
    for (const name of second.map((r) => r.nickname)) {
      expect(taken).not.toContain(name);
    }
  });

  it('taken 覆盖整池 ⇒ 跳过该机器人（不死循环）', () => {
    const robots = [{ seat: 0, displayId: 'p_a' }];
    expect(assignBotDisplayNames('ROOM-D', robots, BOT_DISPLAY_NAMES)).toEqual([]);
  });

  it('固定 displayId/seat，50 个 roomCode 的结果集合 > 1（跨房换名）', () => {
    const robots = [{ seat: 1, displayId: 'p_abc12345' }];
    const names = new Set(
      Array.from({ length: 50 }, (_, i) =>
        assignBotDisplayNames(`ROOM-${i}`, robots)[0]?.nickname,
      ),
    );
    expect(names.size).toBeGreaterThan(1);
  });
});

function fakeRedis(): { redis: FakeRedis; raw: ReturnType<typeof createFakeRedis> } {
  const raw = createFakeRedis();
  return { redis: raw, raw };
}

describe('ensureBotDisplayNames：房间级落盘', () => {
  const robots = [
    { seat: 0, displayId: 'p_00000000' },
    { seat: 1, displayId: 'p_00000001' },
  ];

  it('写入昵称 Hash 并设置 TTL，释放锁', async () => {
    const { redis } = fakeRedis();
    await ensureBotDisplayNames(asRedis(redis), 'ROOM1', robots);

    for (const robot of robots) {
      const name = await redis.hget(nicknamesKey('ROOM1'), robot.displayId);
      expect(name).toBeTruthy();
    }
    expect(await redis.ttl(nicknamesKey('ROOM1'))).toBe(ROOM_TTL_SECONDS);
    expect(await redis.exists(botNamesLockKey('ROOM1'))).toBe(0);
  });

  it('已存在 displayId 不覆盖', async () => {
    const { redis } = fakeRedis();
    await redis.hset(nicknamesKey('ROOM1'), { p_00000000: '既有名字' });

    await ensureBotDisplayNames(asRedis(redis), 'ROOM1', robots);

    expect(await redis.hget(nicknamesKey('ROOM1'), 'p_00000000')).toBe('既有名字');
  });

  it('taken 来自房间 Hash：新机器人避开已写名字（D5 房内不重名）', async () => {
    const { redis } = fakeRedis();
    // 先算出新机器人在「无 taken」时的确定性首选名，再把这个名字预置给另一个 displayId。
    const [wouldPick] = assignBotDisplayNames('ROOM1', [
      { seat: 0, displayId: 'p_00000000' },
    ]);
    expect(wouldPick).toBeDefined();
    await redis.hset(nicknamesKey('ROOM1'), { p_other: wouldPick!.nickname });

    await ensureBotDisplayNames(
      asRedis(redis),
      'ROOM1',
      [{ seat: 0, displayId: 'p_00000000' }],
      { sleep: async () => undefined },
    );

    const assigned = await redis.hget(nicknamesKey('ROOM1'), 'p_00000000');
    expect(assigned).toBeTruthy();
    // 若 taken 退化成 []，这里会重新选到 wouldPick ⇒ 红。
    expect(assigned).not.toBe(wouldPick!.nickname);
    // 已有名字保持不变。
    expect(await redis.hget(nicknamesKey('ROOM1'), 'p_other')).toBe(wouldPick!.nickname);
  });

  it('抢锁抛错 ⇒ fail-open：不向外抛、不读/写 Hash', async () => {
    const { redis } = fakeRedis();
    redis.set.mockRejectedValue(new Error('redis down'));

    await expect(
      ensureBotDisplayNames(asRedis(redis), 'ROOM1', robots, {
        sleep: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(redis.hgetall).not.toHaveBeenCalled();
    expect(redis.hsetnx).not.toHaveBeenCalled();
  });

  it('释放锁 eval 抛错 ⇒ fail-open（名字已写，TTL 兜底）', async () => {
    const { redis } = fakeRedis();
    redis.eval.mockRejectedValue(new Error('eval failed'));

    await expect(
      ensureBotDisplayNames(asRedis(redis), 'ROOM1', robots, {
        sleep: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(await redis.hget(nicknamesKey('ROOM1'), 'p_00000000')).toBeTruthy();
  });

  it('Hash 里的空串哨兵不参与撞名，也不导致异常', async () => {
    const { redis } = fakeRedis();
    await redis.hset(nicknamesKey('ROOM1'), { u_legacy: '' });

    await ensureBotDisplayNames(
      asRedis(redis),
      'ROOM1',
      [{ seat: 0, displayId: 'p_00000000' }],
      { sleep: async () => undefined },
    );

    expect(await redis.hget(nicknamesKey('ROOM1'), 'p_00000000')).toBeTruthy();
    // 哨兵原样保留（不能被写成空昵称或删除）。
    expect(await redis.hget(nicknamesKey('ROOM1'), 'u_legacy')).toBe('');
  });

  it('锁被占用 ⇒ 自旋后放弃，不写、不抛', async () => {
    const { redis } = fakeRedis();
    redis.set.mockResolvedValue(null);
    const sleep = vi.fn(async () => undefined);

    await expect(
      ensureBotDisplayNames(asRedis(redis), 'ROOM1', robots, { sleep, spinAttempts: 3 }),
    ).resolves.toBeUndefined();

    expect(sleep).toHaveBeenCalledTimes(3);
    expect(redis.hgetall).not.toHaveBeenCalled();
    expect(redis.hsetnx).not.toHaveBeenCalled();
  });

  it('读 Hash 抛错 ⇒ 仍分配并写（fail-open）', async () => {
    const { redis } = fakeRedis();
    redis.hgetall.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      ensureBotDisplayNames(asRedis(redis), 'ROOM1', robots, { sleep: async () => undefined }),
    ).resolves.toBeUndefined();

    expect(await redis.hget(nicknamesKey('ROOM1'), 'p_00000000')).toBeTruthy();
  });

  it('写 Hash 抛错 ⇒ 不向外抛（fail-open）', async () => {
    const { redis } = fakeRedis();
    redis.hsetnx.mockRejectedValue(new Error('write failed'));

    await expect(
      ensureBotDisplayNames(asRedis(redis), 'ROOM1', robots, { sleep: async () => undefined }),
    ).resolves.toBeUndefined();
  });

  it('部分 hsetnx 成功后抛错 ⇒ 昵称键仍有 TTL', async () => {
    const { redis } = fakeRedis();
    const original = redis.hsetnx.getMockImplementation()!;
    let calls = 0;
    redis.hsetnx.mockImplementation(async (key, field, value) => {
      calls += 1;
      if (calls === 2) throw new Error('second write failed');
      return original(key, field, value);
    });

    await ensureBotDisplayNames(asRedis(redis), 'ROOM1', robots, {
      sleep: async () => undefined,
    });

    expect(await redis.ttl(nicknamesKey('ROOM1'))).toBe(ROOM_TTL_SECONDS);
  });

  it('robots 为空 ⇒ 零 Redis 调用', async () => {
    const { redis } = fakeRedis();
    await ensureBotDisplayNames(asRedis(redis), 'ROOM1', []);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.hgetall).not.toHaveBeenCalled();
    expect(redis.hsetnx).not.toHaveBeenCalled();
  });
});

describe('锁脚本替身语义（makeFakeEval）', () => {
  it('token 不匹配 ⇒ 不删锁；匹配 ⇒ 删除', async () => {
    const { redis } = fakeRedis();
    const key = botNamesLockKey('ROOM1');
    await redis.set(key, 'holder-token', 'EX', 3, 'NX');

    expect(await redis.eval(BOT_NAMES_RELEASE_LOCK_LUA, 1, key, 'other-token')).toBe(0);
    expect(await redis.exists(key)).toBe(1);

    expect(await redis.eval(BOT_NAMES_RELEASE_LOCK_LUA, 1, key, 'holder-token')).toBe(1);
    expect(await redis.exists(key)).toBe(0);
  });

  it('未注册脚本仍抛错（替身纪律）', async () => {
    const { redis } = fakeRedis();
    await expect(redis.eval('return 1', 0, 'k')).rejects.toThrow('只实现了');
  });
});

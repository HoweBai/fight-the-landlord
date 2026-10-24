/**
 * Task 2.1 / spec §4.6.1：`room.match` 的玩法/人数维度。
 *
 * 三条契约：
 *  ① 缺省（旧客户端）⇒ 斗地主/3，入队键仍是旧 3 段；
 *  ② 同 `(mode, gameType, playerCount, baseScore, region)` ⇒ 12009；任一维度不同 ⇒
 *     先按**旧票的真实键** cancelQueue，再按本次请求入新队（不得双入队）；
 *  ③ 探测键来自 `match:meta`（`queueKeyOfTicket`），不得用解析值重建。
 */
import { describe, it, expect } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { C, makeDeps, makeSocket, route } from './helpers/router-deps';

const legacyTicket = (over: Record<string, unknown> = {}) => ({
  playerId: 'alice',
  mode: 'random',
  baseScore: 15,
  region: 'global',
  enteredAt: Date.now(),
  latency: 0,
  attempts: 0,
  ...over,
});

describe('room.match 的 gameType / playerCount 维度（Task 2.1）', () => {
  it('旧客户端载荷（无 gameType/playerCount）⇒ 斗地主/3（DEFAULT + GameMeta.defaultPlayerCount）', async () => {
    const { deps, match } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(0);
    expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, {
      gameType: 'doudizhu',
      playerCount: 3,
    });
  });

  it('跑得快 3 人载荷 ⇒ 维度原样透传（协议校验已在 validateClientMessage 完成）', async () => {
    const { deps, match, configCache } = makeDeps();
    configCache.paodekuaiEnabled.mockReturnValue(true);
    const ack = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 3 }),
    );

    expect(ack.code).toBe(0);
    expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, {
      gameType: 'paodekuai',
      playerCount: 3,
    });
  });

  it('跑得快 4 人载荷 ⇒ playerCount 原样透传（不在 router 写死 3）', async () => {
    const { deps, match, configCache } = makeDeps();
    configCache.paodekuaiEnabled.mockReturnValue(true);
    configCache.paodekuaiNonThreePlayerEnabled.mockReturnValue(true);
    const ack = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 4 }),
    );

    expect(ack.code).toBe(0);
    expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, {
      gameType: 'paodekuai',
      playerCount: 4,
    });
  });

  it('同维度重复（跑得快 3 人、meta 与队列一致）⇒ 12009，不 cancel、不入队', async () => {
    const { deps, redis, match } = makeDeps();
    match.readMeta.mockResolvedValue(
      legacyTicket({
        gameType: 'paodekuai',
        playerCount: 3,
        queueKey: 'match:queue:random:paodekuai:3:15:global',
      }),
    );
    await redis.zadd('match:queue:random:paodekuai:3:15:global', Date.now(), 'alice');

    const ack = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 3 }),
    );

    expect(ack.code).toBe(12009);
    expect(match.cancelQueue).not.toHaveBeenCalled();
    expect(match.addToQueue).not.toHaveBeenCalled();
  });

  it('旧票（ddz/3）+ 同维度请求 ⇒ 12009（旧键探测不得被新维度改坏）', async () => {
    const { deps, redis, match } = makeDeps();
    await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(12009);
    expect(match.cancelQueue).not.toHaveBeenCalled();
    expect(match.addToQueue).not.toHaveBeenCalled();
  });

  it('换玩法重排：旧 ddz 票 + 跑得快请求 ⇒ 先 cancel 旧票、再按新维度入队', async () => {
    const { deps, redis, match, configCache } = makeDeps();
    configCache.paodekuaiEnabled.mockReturnValue(true);
    await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');

    const ack = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 3 }),
    );

    expect(ack.code).toBe(0);
    expect(match.cancelQueue).toHaveBeenCalledWith('alice');
    expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, {
      gameType: 'paodekuai',
      playerCount: 3,
    });
  });

  it('换人数重排：旧跑得快 3 人票 + 4 人请求 ⇒ 先 cancel、再按 4 人入队', async () => {
    const { deps, redis, match, configCache } = makeDeps();
    configCache.paodekuaiEnabled.mockReturnValue(true);
    configCache.paodekuaiNonThreePlayerEnabled.mockReturnValue(true);
    match.readMeta.mockResolvedValue(
      legacyTicket({
        gameType: 'paodekuai',
        playerCount: 3,
        queueKey: 'match:queue:random:paodekuai:3:15:global',
      }),
    );
    await redis.zadd('match:queue:random:paodekuai:3:15:global', Date.now(), 'alice');

    const ack = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 4 }),
    );

    expect(ack.code).toBe(0);
    expect(match.cancelQueue).toHaveBeenCalledWith('alice');
    expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, {
      gameType: 'paodekuai',
      playerCount: 4,
    });
  });

  it('跑得快孤儿票（meta 过期、5 段队列残留）⇒ 探测命中并先清理，再入队', async () => {
    const { deps, redis, match, configCache } = makeDeps();
    configCache.paodekuaiEnabled.mockReturnValue(true);
    await redis.zadd('match:queue:random:paodekuai:3:15:global', Date.now(), 'alice');
    match.readMeta.mockResolvedValue(null);

    const ack = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 3 }),
    );

    expect(ack.code).toBe(0);
    expect(match.cancelQueue).toHaveBeenCalledWith('alice');
    expect(match.addToQueue).toHaveBeenCalled();
  });

  it('探测键来自 meta.queueKey：实际键命中 ⇒ 12009（不得按维度重建成空键）', async () => {
    const { deps, redis, match } = makeDeps();
    // 真实键与按维度构造出来的不同（模拟历史/迁移形态）；meta 的 queueKey 才是唯一真源。
    match.readMeta.mockResolvedValue(
      legacyTicket({
        gameType: 'doudizhu',
        playerCount: 3,
        queueKey: 'match:queue:random:legacy-shape:global',
      }),
    );
    await redis.zadd('match:queue:random:legacy-shape:global', Date.now(), 'alice');

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(12009);
    expect(match.cancelQueue).not.toHaveBeenCalled();
    expect(match.addToQueue).not.toHaveBeenCalled();
  });
});

/**
 * Task 2.2 / spec §4.6.2：`room.match` 的玩法开放 / 人数闸（12012）。
 *
 * 顺序与 `modeEnabled` 相同：dup 探测之后、入队之前 —— 已在队列里的人先拿 12009
 *（他的排队状态没变），闸只拦**新的**入队。
 */
describe('room.match 的玩法/人数闸（Task 2.2）', () => {
  it('跑得快未开放（种子 false）⇒ 12012，不入队', async () => {
    const { deps, match } = makeDeps(); // 桩缺省 paodekuaiEnabled=false

    const ack = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 3 }),
    );

    expect(ack.code).toBe(ErrCode.GAME_UNAVAILABLE);
    expect(ack.message).toBe('该玩法暂未开放');
    expect(match.addToQueue).not.toHaveBeenCalled();
  });

  it('跑得快已开放但 nonThree 关：3 人放行、4 人 12012', async () => {
    const { deps, match, configCache } = makeDeps();
    configCache.paodekuaiEnabled.mockReturnValue(true);
    configCache.paodekuaiNonThreePlayerEnabled.mockReturnValue(false);

    const four = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 4 }),
    );
    expect(four.code).toBe(ErrCode.GAME_UNAVAILABLE);
    expect(four.message).toBe('该玩法暂不支持该人数');
    expect(match.addToQueue).not.toHaveBeenCalled();

    const three = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 3 }),
    );
    expect(three.code).toBe(0);
    expect(match.addToQueue).toHaveBeenCalled();
  });

  it('nonThree 开 ⇒ 跑得快 2/4 人放行（首版只开 3 的闸在运营侧）', async () => {
    const { deps, match, configCache } = makeDeps();
    configCache.paodekuaiEnabled.mockReturnValue(true);
    configCache.paodekuaiNonThreePlayerEnabled.mockReturnValue(true);

    for (const count of [2, 4]) {
      const ack = await route(
        deps,
        makeSocket('alice'),
        C('room.match', { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: count }),
      );
      expect(ack.code, `playerCount=${count}`).toBe(0);
    }
    expect(match.addToQueue).toHaveBeenCalledTimes(2);
  });

  it('斗地主 4 人（不在 supportedPlayerCounts）⇒ 12012（不得静默按 3 人入队）', async () => {
    const { deps, match } = makeDeps();

    const ack = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'random', baseScore: 15, gameType: 'doudizhu', playerCount: 4 }),
    );

    expect(ack.code).toBe(ErrCode.GAME_UNAVAILABLE);
    expect(match.addToQueue).not.toHaveBeenCalled();
  });

  it('practice（好友房匹配面）同样受玩法闸管控 —— 不是 random 专属', async () => {
    const { deps, match } = makeDeps(); // pdk 缺省未开放

    const ack = await route(
      deps,
      makeSocket('alice'),
      C('room.match', { mode: 'practice', baseScore: 15, gameType: 'paodekuai', playerCount: 3 }),
    );

    expect(ack.code).toBe(ErrCode.GAME_UNAVAILABLE);
    expect(match.addToQueue).not.toHaveBeenCalled();
  });
});

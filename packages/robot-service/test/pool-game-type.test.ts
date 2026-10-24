/**
 * Task 2.6 / spec D10：**按玩法的机器人池**。
 *
 * - 池键 `bot:pool:{gameType}`；斗地主读旧 `bot:pool:ddz` 并迁移（双向读、只写新池）；
 * - `BotInstance.gameType` 持久化；`release` 从 bot 记录推导（不信任调用方）；
 * - `reclaimIdle/listIdle/poolSize/takeIdle` 全部按玩法参数化（pdk 空闲机器人必须能被回收）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BotInstance } from '@fight-the-landlord/protocol';
import {
  GAME_TYPE,
  IDLE_RECLAIM_MS,
  RobotPool,
  botKey,
  botPoolKey,
} from '../src/robot/robot.pool';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';
import { asRedis, createFakeRedis, type FakeRedis } from './helpers/fake-redis';

const legacyBot = (botId: string): BotInstance => ({
  botId,
  displayId: `p_${botId.slice(-8).padStart(8, '0')}`,
  skillLevel: 'beginner',
  personality: { thinkingSpeed: 1200 },
  roomCode: null,
  seat: null,
  gamesPlayed: 0,
  idleSince: 1_000,
});

describe('RobotPool 按玩法隔离（Task 2.6）', () => {
  let redis: FakeRedis;
  let pool: RobotPool;
  let now: number;

  beforeEach(() => {
    redis = createFakeRedis();
    now = 1_700_000_000_000;
    pool = new RobotPool(asRedis(redis), () => now, asConfigCache(makeConfigCache()));
    pool.random = () => 0.1;
  });

  it('pdk acquire/release：池键 bot:pool:paodekuai，BotInstance.gameType 持久化', async () => {
    const [bot] = await pool.acquire('R-PDK', [0], 'paodekuai');
    expect(bot!.gameType).toBe('paodekuai');

    await pool.release([bot!.botId]);

    expect(await redis.zscore(botPoolKey('paodekuai'), bot!.botId)).not.toBeNull();
    expect(await redis.zscore(botPoolKey('doudizhu'), bot!.botId)).toBeNull();
    expect(await redis.zscore(botPoolKey('ddz'), bot!.botId)).toBeNull();
    const stored = JSON.parse((await redis.get(botKey(bot!.botId)))!) as BotInstance;
    expect(stored.gameType).toBe('paodekuai');
  });

  it('ddz 默认：acquire 不写 gameType 语义为 doudizhu；release 写**新池**（不写旧 ddz 池）', async () => {
    const [bot] = await pool.acquire('R-DDZ', [0]);
    expect(bot!.gameType).toBe('doudizhu');

    await pool.release([bot!.botId]);

    expect(await redis.zscore(botPoolKey(GAME_TYPE), bot!.botId)).not.toBeNull(); // 'doudizhu'
    expect(await redis.zscore(botPoolKey('ddz'), bot!.botId)).toBeNull();
  });

  it('旧池双读：bot:pool:ddz 的空闲机器人被 ddz acquire 复用，release 后迁到新池', async () => {
    const legacy = legacyBot('bot-legacy01');
    await redis.set(botKey(legacy.botId), JSON.stringify(legacy));
    await redis.zadd(botPoolKey('ddz'), legacy.idleSince!, legacy.botId);

    const [reused] = await pool.acquire('R-NEW', [0]);

    expect(reused!.botId).toBe(legacy.botId);
    expect(reused!.gameType).toBe('doudizhu'); // 迁移到规范玩法
    expect(await redis.zscore(botPoolKey('ddz'), legacy.botId)).toBeNull(); // 取出即出旧池

    await pool.release([legacy.botId]);
    expect(await redis.zscore(botPoolKey('doudizhu'), legacy.botId)).not.toBeNull();
    expect(await redis.zscore(botPoolKey('ddz'), legacy.botId)).toBeNull();
  });

  it('玩法隔离：pdk acquire 不拿 ddz 旧池里的空闲机器人', async () => {
    const legacy = legacyBot('bot-legacy02');
    await redis.set(botKey(legacy.botId), JSON.stringify(legacy));
    await redis.zadd(botPoolKey('ddz'), legacy.idleSince!, legacy.botId);

    const [bot] = await pool.acquire('R-PDK2', [0], 'paodekuai');

    expect(bot!.botId).not.toBe(legacy.botId);
    expect(bot!.gameType).toBe('paodekuai');
    // 旧池里的 ddz 机器人原样留着（不被 pdk 抽走）
    expect(await redis.zscore(botPoolKey('ddz'), legacy.botId)).not.toBeNull();
  });

  it('pdk 空闲机器人可被 reclaimIdle 回收（不只扫 ddz 池）', async () => {
    const [bot] = await pool.acquire('R-GONE', [0], 'paodekuai');
    await pool.release([bot!.botId]);
    now += IDLE_RECLAIM_MS + 1; // 超过 10 分钟；R-GONE 房间不存在

    const reclaimed = await pool.reclaimIdle();

    expect(reclaimed).toContain(bot!.botId);
    expect(await redis.zscore(botPoolKey('paodekuai'), bot!.botId)).toBeNull();
    expect(await redis.get(botKey(bot!.botId))).toBeNull();
  });

  it('listIdle/poolSize 按玩法参数化（pdk 不被 ddz 的池读数聚合）', async () => {
    const [ddz] = await pool.acquire('R-D', [0]);
    const [pdk] = await pool.acquire('R-P', [0], 'paodekuai');
    await pool.release([ddz!.botId, pdk!.botId]);

    await expect(pool.listIdle('paodekuai')).resolves.toEqual([
      expect.objectContaining({ botId: pdk!.botId, gameType: 'paodekuai' }),
    ]);
    await expect(pool.listIdle('doudizhu')).resolves.toEqual([
      expect.objectContaining({ botId: ddz!.botId, gameType: 'doudizhu' }),
    ]);
    await expect(pool.poolSize('paodekuai')).resolves.toBe(1);
    await expect(pool.poolSize('doudizhu')).resolves.toBe(1);
  });

  it('旧记录缺 gameType ⇒ 视为 doudizhu（release 从记录推导，不信任调用方）', async () => {
    const legacy = legacyBot('bot-legacy03');
    // 绑定中的旧记录（无 gameType）
    await redis.set(
      botKey(legacy.botId),
      JSON.stringify({ ...legacy, roomCode: 'R-OLD', seat: 2, idleSince: undefined }),
    );

    await pool.release([legacy.botId]);

    expect(await redis.zscore(botPoolKey('doudizhu'), legacy.botId)).not.toBeNull();
    const stored = JSON.parse((await redis.get(botKey(legacy.botId)))!) as BotInstance;
    expect(stored.gameType).toBe('doudizhu');
  });
});

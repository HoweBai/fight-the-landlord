/**
 * Task 2.1（spec §4.6.1 / D5）：队列键的两套形状与**实际键透传**。
 *
 * 判据分两层：
 *  ① 纯函数 —— 斗地主恒旧 3 段键（零迁移）、跑得快新 5 段键、解析器带 `legacy` 标记、
 *     `queueKeyOfTicket` 是**唯一**的发票→键映射；
 *  ② 服务层 —— `addToQueue`/`readMeta`/`cancelQueue`/扫描/`failMatch` 全部使用
 *     票/扫描结果里的**真实键**，绝不按解析值重建（spec §4.6.1 的机械红线）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  matchQueueKey,
  parseMatchQueueKey,
  queueKeyOfTicket,
  type MatchTicket,
} from '../src/match/match.service';
import { makeMatchServiceHarness } from './helpers/match-service-harness';

const ticket = (over: Partial<MatchTicket> = {}): MatchTicket => ({
  playerId: 'p1',
  mode: 'random',
  baseScore: 15,
  region: 'global',
  enteredAt: 0,
  latency: 0,
  attempts: 0,
  ...over,
});

describe('matchQueueKey（D5：斗地主旧 3 段 / 跑得快新 5 段）', () => {
  it('斗地主恒旧 3 段键：match:queue:{mode}:{baseScore}:{region}（不因 playerCount 多出一段）', () => {
    expect(matchQueueKey('random', 'doudizhu', 3, 15)).toBe('match:queue:random:15:global');
    expect(matchQueueKey('gold', 'doudizhu', 3, 80, 'cn-east')).toBe('match:queue:gold:80:cn-east');
    expect(matchQueueKey('practice', 'doudizhu', 3, 1200)).toBe(
      'match:queue:practice:1200:global',
    );
  });

  it('跑得快新 5 段键：match:queue:{mode}:paodekuai:{playerCount}:{baseScore}:{region}', () => {
    expect(matchQueueKey('random', 'paodekuai', 3, 15)).toBe(
      'match:queue:random:paodekuai:3:15:global',
    );
    expect(matchQueueKey('gold', 'paodekuai', 2, 480, 'cn-east')).toBe(
      'match:queue:gold:paodekuai:2:480:cn-east',
    );
    expect(matchQueueKey('practice', 'paodekuai', 4, 1200)).toBe(
      'match:queue:practice:paodekuai:4:1200:global',
    );
  });
});

describe('parseMatchQueueKey（先 5 段、再 3 段；未知玩法/人数 ⇒ null）', () => {
  it('旧 3 段 ⇒ 斗地主/3 + legacy=true（部署窗口里的存量队列照常可扫）', () => {
    expect(parseMatchQueueKey('match:queue:random:15:global')).toEqual({
      key: 'match:queue:random:15:global',
      mode: 'random',
      gameType: 'doudizhu',
      playerCount: 3,
      baseScore: 15,
      region: 'global',
      legacy: true,
    });
    expect(parseMatchQueueKey('match:queue:gold:1200:cn-east')).toEqual({
      key: 'match:queue:gold:1200:cn-east',
      mode: 'gold',
      gameType: 'doudizhu',
      playerCount: 3,
      baseScore: 1200,
      region: 'cn-east',
      legacy: true,
    });
  });

  it('新 5 段 ⇒ 原玩法/人数 + legacy=false', () => {
    expect(parseMatchQueueKey('match:queue:random:paodekuai:3:15:global')).toEqual({
      key: 'match:queue:random:paodekuai:3:15:global',
      mode: 'random',
      gameType: 'paodekuai',
      playerCount: 3,
      baseScore: 15,
      region: 'global',
      legacy: false,
    });
    expect(parseMatchQueueKey('match:queue:gold:paodekuai:4:480:cn-east')).toMatchObject({
      gameType: 'paodekuai',
      playerCount: 4,
      baseScore: 480,
      region: 'cn-east',
      legacy: false,
    });
  });

  it('未知玩法/不支持的人数/坏键 ⇒ null（调用方跳过，不得把整轮扫描带崩）', () => {
    expect(parseMatchQueueKey('match:queue:random:ranked:3:15:global')).toBeNull();
    expect(parseMatchQueueKey('match:queue:random:paodekuai:5:15:global')).toBeNull();
    expect(parseMatchQueueKey('match:queue:random:doudizhu:2:15:global')).toBeNull();
    expect(parseMatchQueueKey('match:queue:ranked:15:global')).toBeNull();
    expect(parseMatchQueueKey('match:queue:random:abc:global')).toBeNull();
    expect(parseMatchQueueKey('match:meta:u1')).toBeNull();
  });

  it('两种形状的往返：parse(matchQueueKey(...)) 原样拆回（含 legacy 标记）', () => {
    const ddz = matchQueueKey('practice', 'doudizhu', 3, 80, 'cn-east');
    expect(parseMatchQueueKey(ddz)).toMatchObject({
      mode: 'practice',
      gameType: 'doudizhu',
      playerCount: 3,
      baseScore: 80,
      region: 'cn-east',
      legacy: true,
    });
    const pdk = matchQueueKey('random', 'paodekuai', 2, 15);
    expect(parseMatchQueueKey(pdk)).toMatchObject({
      mode: 'random',
      gameType: 'paodekuai',
      playerCount: 2,
      baseScore: 15,
      region: 'global',
      legacy: false,
    });
  });
});

describe('queueKeyOfTicket（发票 → 键的唯一映射）', () => {
  it('有 queueKey ⇒ 原键（哪怕它不符合当前构造规则）', () => {
    const t = ticket({ queueKey: 'match:queue:legacy-weird-key' });
    expect(queueKeyOfTicket(t)).toBe('match:queue:legacy-weird-key');
  });

  it('旧票（缺 gameType/playerCount/queueKey）⇒ 旧 3 段键（不得重建新键）', () => {
    expect(queueKeyOfTicket(ticket({ mode: 'gold', baseScore: 80, region: 'cn-east' }))).toBe(
      'match:queue:gold:80:cn-east',
    );
  });

  it('新票（有 gameType/playerCount）⇒ 按玩法构造：ddz 旧 3 段、pdk 新 5 段', () => {
    expect(queueKeyOfTicket(ticket({ gameType: 'doudizhu', playerCount: 3 }))).toBe(
      'match:queue:random:15:global',
    );
    expect(queueKeyOfTicket(ticket({ gameType: 'paodekuai', playerCount: 4 }))).toBe(
      'match:queue:random:paodekuai:4:15:global',
    );
  });
});

describe('服务层：真实键透传（不得用解析值重建新键）', () => {
  const harnesses: Array<ReturnType<typeof makeMatchServiceHarness>> = [];
  const make = (): ReturnType<typeof makeMatchServiceHarness> => {
    const h = makeMatchServiceHarness();
    harnesses.push(h);
    return h;
  };
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.service.onApplicationShutdown();
  });

  it('addToQueue 写跑得快 5 段键；meta 带 gameType/playerCount/queueKey；readMeta 原样读回', async () => {
    const { service, redis } = make();
    service.setClock(() => 1_700_000_000_000);

    await service.addToQueue('p1', 'random', 15, undefined, undefined, {
      gameType: 'paodekuai',
      playerCount: 3,
    });

    expect(redis.zadd).toHaveBeenCalledWith(
      'match:queue:random:paodekuai:3:15:global',
      1_700_000_000_000,
      'p1',
    );
    expect(redis._hashes.get('match:meta:p1')).toMatchObject({
      gameType: 'paodekuai',
      playerCount: '3',
      queueKey: 'match:queue:random:paodekuai:3:15:global',
    });
    expect(await service.readMeta('p1')).toMatchObject({
      gameType: 'paodekuai',
      playerCount: 3,
      queueKey: 'match:queue:random:paodekuai:3:15:global',
    });
  });

  it('斗地主新票仍写旧 3 段键（零迁移）；legacy meta（无新字段）原样读回', async () => {
    const { service, redis } = make();
    service.setClock(() => 1000);

    await service.addToQueue('p1', 'random', 15);
    expect(redis.zadd).toHaveBeenCalledWith('match:queue:random:15:global', 1000, 'p1');
    expect(redis._hashes.get('match:meta:p1')).toMatchObject({
      gameType: 'doudizhu',
      playerCount: '3',
      queueKey: 'match:queue:random:15:global',
    });

    // 旧服务写的 meta（只有三座时代的字段）—— 必须读成 legacy 且不凭空补字段
    await redis.hset('match:meta:old', {
      playerId: 'old',
      mode: 'random',
      baseScore: '15',
      region: 'global',
      enteredAt: '1',
      latency: '0',
      attempts: '0',
    });
    const old = (await service.readMeta('old'))!;
    expect('gameType' in old).toBe(false);
    expect('playerCount' in old).toBe(false);
    expect('queueKey' in old).toBe(false);
    expect(queueKeyOfTicket(old)).toBe('match:queue:random:15:global');
  });

  it('cancelQueue 用 meta 的 queueKey / 旧 3 段键 —— 两票各清各的队列', async () => {
    const { service, redis } = make();
    service.setClock(() => 1000);

    // 新跑得快票
    await service.addToQueue('pdk', 'random', 15, undefined, undefined, {
      gameType: 'paodekuai',
      playerCount: 2,
    });
    // 旧斗地主票（meta 只有旧字段）
    await redis.hset('match:meta:legacy', {
      playerId: 'legacy',
      mode: 'random',
      baseScore: '15',
      region: 'global',
      enteredAt: '1',
      latency: '0',
      attempts: '0',
    });
    await redis.zadd('match:queue:random:15:global', 1, 'legacy');

    await service.cancelQueue('pdk');
    await service.cancelQueue('legacy');

    expect(redis._zsets.get('match:queue:random:paodekuai:2:15:global')?.has('pdk')).toBe(false);
    expect(redis._zsets.get('match:queue:random:15:global')?.has('legacy')).toBe(false);
    expect(redis._hashes.has('match:meta:pdk')).toBe(false);
    expect(redis._hashes.has('match:meta:legacy')).toBe(false);
  });

  it('addToQueue 按玩法校验底分：pdk 读 game.levels.paodekuai；不在表 ⇒ 10001（不建键）', async () => {
    const { service, redis, configCache } = make();
    configCache.baseScoreLevels.mockImplementation(async (gameType?: string) =>
      gameType === 'paodekuai'
        ? [{ name: '跑得快休闲', baseScore: 30 }]
        : [{ name: '休闲场', baseScore: 15 }],
    );
    service.setClock(() => 1000);

    await service.addToQueue('p1', 'random', 30, undefined, undefined, {
      gameType: 'paodekuai',
      playerCount: 3,
    });
    expect(configCache.baseScoreLevels).toHaveBeenCalledWith('paodekuai');
    expect(redis._zsets.get('match:queue:random:paodekuai:3:30:global')?.has('p1')).toBe(true);

    const err = await service
      .addToQueue('p2', 'random', 15, undefined, undefined, {
        gameType: 'paodekuai',
        playerCount: 3,
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrCode.BAD_PARAM });
    expect(redis._zsets.get('match:queue:random:paodekuai:3:15:global')).toBeUndefined();
    expect(redis._hashes.has('match:meta:p2')).toBe(false);
  });

  it('扫描按**实际键**读队列：跑得快 5 段键被 zrange，旧 3 段键不被触碰', async () => {
    const { service, redis, configCache } = make();
    // 关补机器人：2 人队列停在等待提示路径，不触发（本任务尚未支持的）pdk 开局。
    configCache.freeBotFillEnabled.mockReturnValue(false);
    service.setClock(() => 1_700_000_000_000);
    await service.addToQueue('u1', 'random', 15, undefined, undefined, {
      gameType: 'paodekuai',
      playerCount: 2,
    });
    await service.addToQueue('u2', 'random', 15, undefined, undefined, {
      gameType: 'paodekuai',
      playerCount: 2,
    });
    service.setClock(() => 1_700_000_001_000);

    await service.scanOnce();

    const zrange = redis.zrange as unknown as { mock: { calls: unknown[][] } };
    const keys = zrange.mock.calls.map((c) => String(c[0]));
    expect(keys).toContain('match:queue:random:paodekuai:2:15:global');
    expect(keys, '不得按解析值重建斗地主旧键').not.toContain('match:queue:random:15:global');
  });

  it('failMatch 按**实际键** ZREM（跑得快队列超时 ⇒ 只清 5 段键）', async () => {
    const { service, redis, configCache } = make();
    configCache.freeBotFillEnabled.mockReturnValue(false);
    service.setClock(() => 1_700_000_000_000);
    await service.addToQueue('u1', 'random', 15, undefined, undefined, {
      gameType: 'paodekuai',
      playerCount: 2,
    });
    // 越过无机器人路径的总等待上限（桩缺省 300s）
    service.setClock(() => 1_700_000_400_000);

    await service.scanOnce();

    expect(redis.zrem).toHaveBeenCalledWith('match:queue:random:paodekuai:2:15:global', 'u1');
    expect(redis._zsets.get('match:queue:random:paodekuai:2:15:global')?.has('u1')).toBe(false);
    expect(redis._hashes.has('match:meta:u1')).toBe(false);
    const events = (redis.publish as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(([channel]) => channel === 'match:events')
      .map(([, payload]) => JSON.parse(String(payload)) as { event: string; playerIds: string[] });
    expect(events).toEqual([
      { event: 'match.timeout', playerIds: ['u1'], code: 12007, message: expect.any(String) },
    ]);
  });
});

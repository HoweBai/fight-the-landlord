import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ValidationPipe, Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { ErrCode } from '@fight-the-landlord/protocol';
// 2026-10-21：缺省底分不再有代码常量——本文件的主角是「省略 ⇒ 表内数值最小档」。
import { RoomsService } from '../src/rooms/rooms.service';
import { DomainError } from '../src/http/errors';
import { CreateRoomDto } from '../src/rooms/rooms.dto';
import { asRedis, createFakeRedis, type FakeRedis } from './helpers/fake-redis';
import {
  asConfigCache,
  makeConfigCache,
  type ConfigCacheStub,
} from './helpers/config-cache.stub';

/**
 * 片规格 §2.4 协议⑤ + §2.1（room-service 经配置快照缓存读档位表——片⑦ T7 起
 * `ConfigCacheService.baseScoreLevels()`；缓存为空窗口内才即时 RPC）：**建房时底分必须属于档位表**。
 *
 * 三条纪律（写在这里，因为它们正是这些用例存在的理由）：
 *
 *  1. 🔴 **「读不到档位表」与「底分非法」是两件事故，码不同**（`10007` vs `10001`）——
 *     用例分别断言两者，否则「把读不到当成没有档位」的实现会**安静地**混过去；
 *  2. 🔴 **拿不到表 ⇒ 失败，绝不静默放行**：最强的探针不是「非法值被拒」（那种实现下
 *     它**照样**是被拒的），而是「**合法值在表不可用时也必须失败**」+「没有房间落库」；
 *  3. **省略 `baseScore` 也读表**（2026-10-21 起：缺省 = 表内数值最小档）——
 *     用「桩被调用一次」钉住；缓存命中时是进程内读，不是每请求 RPC。
 *
 * ⚠️ **判别力自证（实测记录）**：把 `create()` 里那段校验整段注释掉 ⇒ 本文件 **2 条红**
 *（「非法值被拒」与「拿不到 ⇒ 不得静默放行」；另两条是正例 / 省略取最低档，本就不测校验）；
 * 把「拿不到 ⇒ 抛」改成 `catch { return [] }` **且空表即放行** ⇒ 第 3 条红
 *（原文：`promise resolved "{ code: 'KTXR1O', … baseScore: 999 … }" instead of rejecting`
 * —— 即非法底分**真的建出了房**）。
 * 详见 `.superpowers/sdd/task-2-report.md` 的 RED 原文。
 */
describe('RoomsService.create：底分的档位校验（片规格 §2.4 协议⑤）', () => {
  let redis: FakeRedis;
  let configCache: ConfigCacheStub;
  let svc: RoomsService;

  beforeEach(() => {
    redis = createFakeRedis();
    // 桩只给**一档**（规格 §2.2 的「休闲场 15」）—— 校验用的是**表里的值**，不是常量。
    configCache = makeConfigCache([{ name: '休闲场', baseScore: 15 }]);
    svc = new RoomsService(asRedis(redis), asConfigCache(configCache));
  });

  /** M4 同族（`message.router.test.ts` 的成例）：`Logger.overrideLogger` 是**进程级**的，用后必须还原。 */
  afterEach(() => {
    Logger.overrideLogger(new Logger());
  });

  it('非法 baseScore 被拒（BAD_PARAM），非法值不得落库', async () => {
    await expect(svc.create({ mode: 'random', baseScore: 999 })).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
    });
    // 「被拒」必须**同时**是「什么都没写下去」：抛在 `writeMeta` 之后也算「被拒」，
    // 但那时 Redis 里已经躺着一间非法底分的房（标题里那句话的机械形态）。
    expect(redis.hashes.size, '非法底分不得落库').toBe(0);
  });

  it('合法 baseScore 通过', async () => {
    const room = await svc.create({ mode: 'random', baseScore: 15 });
    expect(room.baseScore).toBe(15);
    // 正对照：真的落库了（否则上面那条「非法值不得落库」在「什么都没写」的实现下也是绿的）
    expect(redis.hashes.get(`room:${room.code}`)?.baseScore).toBe('15');
  });

  it('🔴 拿不到档位表 ⇒ 抛错，**不得**静默放行（否则非法值绕过校验）', async () => {
    // ⚠️ 拒因用**带内部详情的消息**（Task 3g 修复 I1 的探针形态）：真身（缓存 → 快照）
    // 的传输失败文案是固定的（不发详情），但本 catch **不得内插 `err.message`** 的纪律
    // 与具体上游无关 —— 用一条「若被内插就会泄露」的消息来钉住它。
    configCache.baseScoreLevels.mockRejectedValue(
      new Error('user-service unavailable: connect ECONNREFUSED 172.28.0.9:3101'),
    );

    // ① 非法值：码必须是 **10007**（上游不可用），**不是** 10001（校验失败）——
    //    两者混同会让「读不到表」看起来像「客户端传错了」。
    await expect(svc.create({ mode: 'random', baseScore: 999 })).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
    // ② 🔴 **合法值同样必须失败** —— 这一条才是抓「`catch { return [] }` ⇒ 空表被当成
    //    『没有档位』⇒ 跳过校验」的探针：那种实现下 ① 恰好也是「被拒」（只是码错），
    //    而 ② 会**成功建出房**（本文件实测：改成 `return []` 后 ② 红）。
    await expect(svc.create({ mode: 'random', baseScore: 15 })).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
    // ③ 省略底分同样必须失败：缺省现在也来自档位表（最低档），不得绕过表读。
    await expect(svc.create({ mode: 'random' })).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
    expect(redis.hashes.size, '拿不到档位表时不得落库').toBe(0);
  });

  /**
   * 🔴 **Task 3g 修复 I1**：`DomainError` 的消息是**面向调用方**的 —— HTTP 面
   * `toHttpException`（`http/errors.ts:40`）把它**原样**放进 `{code,message}` 信封，
   * WS 面（`message.router.ts` 的 DomainError 分支）照实 ack。
   *
   * 修前的实现是 `` `底分档位表不可用：${err.message}` `` ⇒ 客户端会读到
   * `user-service unavailable: connect ECONNREFUSED 172.28.0.9:3101` 这类**内部详情**。
   * 处置照 `MatchService.assertKnownBaseScore`（同一次读的另一条路径、同一个码）：
   * 消息**固定**（两条路径逐字同句），详情**只进日志**。
   *
   * 断言两半（缺一不可）：① 消息里没有详情；② 日志里**有**详情（「不透传 ≠ 不留痕」）。
   */
  it('🔴 修复 I1：读不到档位表时，消息里没有内部详情、但日志里有（不透传 ≠ 不留痕）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

    configCache.baseScoreLevels.mockRejectedValue(
      new Error('user-service unavailable: connect ECONNREFUSED 172.28.0.9:3101'),
    );

    const err = (await svc
      .create({ mode: 'random', baseScore: 15 })
      .catch((e: unknown) => e)) as DomainError;

    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    // ② 固定文案 —— 与 `MatchService.assertKnownBaseScore` 逐字同句（两条路同一次读）
    expect(err.message).toBe('底分档位表不可用');
    // ① 详情一个字都不许进消息（ip:port 与下游服务名都是内部拓扑）
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('172.28.0.9');
    expect(err.message).not.toContain('user-service');
    // 正对照：详情必须**在日志里** —— 否则这条「修复」把排障线索也一起修掉了
    expect(records.map((r) => r.msg).join('\n')).toContain('172.28.0.9:3101');
    expect(records.map((r) => r.msg).join('\n')).toContain('Base score levels unavailable');
  });

  it('不传 baseScore ⇒ 取档位表最低档（且确实读表）', async () => {
    const room = await svc.create({ mode: 'random' });
    expect(room.baseScore).toBe(15);
    expect(configCache.baseScoreLevels).toHaveBeenCalledTimes(1);
  });

  /**
   * 2026-10-21：缺省底分改为「档位表数值最小档」。
   *
   * 判别力：桩表首项刻意**不是**最小档 —— 若实现退化成 `levels[0]`（或又写死 15），
   * 本用例会红。底分经 `create()` → 房间元数据 → `game.start` → 结算落进真实对局。
   */
  it('🔴 缺省取数值最小档，不是数组首项、也不是代码常量', async () => {
    configCache = makeConfigCache([
      { name: '大场', baseScore: 80 },
      { name: '小场', baseScore: 5 },
      { name: '中场', baseScore: 15 },
    ]);
    svc = new RoomsService(asRedis(redis), asConfigCache(configCache));

    const room = await svc.create({ mode: 'random' });
    expect(room.baseScore).toBe(5);
  });

  it('🔴 表非空但元素坏 ⇒ 10007（不得算出 NaN / 字符串强转值）', async () => {
    configCache = makeConfigCache([
      { name: '坏档', baseScore: '5' },
    ] as unknown as { name: string; baseScore: number }[]);
    svc = new RoomsService(asRedis(redis), asConfigCache(configCache));

    // 省略路径（min 推导）与显式路径（成员校验）都必须按「表不可用」失败。
    await expect(svc.create({ mode: 'random' })).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
    await expect(svc.create({ mode: 'random', baseScore: 5 })).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
    expect(redis.hashes.size, '坏表不得落库').toBe(0);
  });

  it('🔴 表含 null 元素 / 空表 ⇒ 10007（直改库的坏快照也不得抛 TypeError 或算出 Infinity）', async () => {
    for (const bad of [[null], []] as unknown as { name: string; baseScore: number }[][]) {
      configCache = makeConfigCache(bad);
      svc = new RoomsService(asRedis(redis), asConfigCache(configCache));
      await expect(svc.create({ mode: 'random' })).rejects.toMatchObject({
        code: ErrCode.UPSTREAM_UNAVAILABLE,
      });
    }
    expect(redis.hashes.size, '坏表不得落库').toBe(0);
  });
});

/**
 * 协议⑤ 的**那扇门**（`POST /api/rooms` 的 DTO）。
 *
 * ⚠️ `main.ts` 的 `ValidationPipe({ whitelist: true })` 会把**未声明**的属性**静默剥掉**
 * （不报错）—— 少了 `baseScore` 这个字段，上面那组校验**从 HTTP 面根本到不了**：
 * `{"mode":"random","baseScore":999}` 会以缺省底分建房**成功**（计划 Task 4 的验收
 * 因此会红）。本组用例用**同一个 pipe 配置**（逐字照 `main.ts`）钉住这扇门。
 *
 * 判据是**一对**（R115）：正例证明 `baseScore` 真的活下来；负例证明这口 pipe 的
 * `whitelist` 真的在剥东西 —— 只写正例的话，「pipe 根本没生效」也会绿。
 */
describe('CreateRoomDto：baseScore 必须能穿过 whitelist（否则协议⑤ 从 HTTP 面到不了）', () => {
  // ⚠️ 与 `main.ts` 的 `new ValidationPipe({ whitelist: true, transform: true })` 逐字同参。
  const pipe = () => new ValidationPipe({ whitelist: true, transform: true });
  const meta = { type: 'body' as const, metatype: CreateRoomDto };

  it('正例：声明过的 baseScore 保留下来（`@IsOptional() @IsInt()` 的元数据挡掉了剥离）', async () => {
    const out = (await pipe().transform({ mode: 'random', baseScore: 15 }, meta)) as CreateRoomDto;
    expect(out.baseScore).toBe(15);
    expect(out.mode).toBe('random');
  });

  it('负例：**未声明**的字段被剥掉（证明 whitelist 真的开着，正例不是假绿）', async () => {
    const out = (await pipe().transform(
      { mode: 'random', userId: 'attacker' },
      meta,
    )) as CreateRoomDto & { userId?: string };
    expect(out.userId).toBeUndefined();
  });
});

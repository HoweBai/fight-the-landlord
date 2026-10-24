import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { RoomsService } from '../src/rooms/rooms.service';
import { RoomsReaperTask } from '../src/rooms/rooms.reaper';
import { cardCountKey, fillAtKey, seatsKey } from '../src/rooms/rooms.seats';
import { asRedis, createFakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

/**
 * **N31① + N31②（R523）**：房间回收任务 —— 一次收两半。
 *
 * 判据纪律（R243/R253/R115）：**全部用绝对性质** ——「这三个键必须**都为 0**」，
 * **不用**「房间总数变少了」这类**相对量**（在共享 Redis 上它必然因第三方写入假红，
 * 而对本条要抓的「键还在」**完全免疫**）。
 *
 * 为什么必须断言**三个键**：只删 `room:{code}` 的实现会留下 `room:{code}:seats` /
 * `room:{code}:cardcount` 两个**孤儿** —— `findAll()`（A8）刻意排除带 `:` 的键，
 * 所以它们**看不见也回收不到**。只断言主键的判据在那种实现上照样绿。
 */
/**
 * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原的话，
 * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到自己的
 * 日志行）。还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

describe('N31：房间回收（终局清理 + waiting 过期）', () => {
  /**
   * 造一个「**三键俱全**」的房间 —— 专门用来抓「只删主键」的实现。
   * `create()` 建 `room:{code}`、`join()` 建 `room:{code}:seats`、
   * 手工 hset 建 `room:{code}:cardcount`（真正的写入方在 `ws.gateway.writeCardCounts()`）。
   */
  async function seedRoom(code: string) {
    const redis = createFakeRedis();
    const service = new RoomsService(asRedis(redis), asConfigCache(makeConfigCache()));
    await service.create({ mode: 'random', roomCode: code });
    await service.join(code, `u-${code}`);
    await redis.hset(cardCountKey(code), { [`u-${code}`]: '17' });
    return { redis, service, reaper: new RoomsReaperTask(service, asConfigCache(makeConfigCache())) };
  }

  const threeKeysExist = async (redis: ReturnType<typeof createFakeRedis>, code: string) =>
    (await redis.exists(`room:${code}`)) +
    (await redis.exists(seatsKey(code))) +
    (await redis.exists(cardCountKey(code)));

  it('waiting 且越过 timeoutAt ⇒ 回收，且**三个键都为 0**（N31②：`isWaitingExpired` 的首个消费者）', async () => {
    const { redis, reaper } = await seedRoom('REAP01');
    // 正对照前置：三键此时**确实都在**（否则「回收后为 0」可能是空测）
    expect(await threeKeysExist(redis, 'REAP01')).toBe(3);

    // 远超过 `create()` 写入的 `timeoutAt`（= 创建时刻 + 30s）
    const reaped = await reaper.reapOnce(Date.now() + 10 * 60_000);

    expect(reaped).toContain('REAP01');
    expect(await threeKeysExist(redis, 'REAP01')).toBe(0);
  });

  it('正对照：waiting 但**未**过期 ⇒ 不得回收', async () => {
    const { redis, reaper } = await seedRoom('REAP02');

    const reaped = await reaper.reapOnce(Date.now());

    expect(reaped).not.toContain('REAP02');
    expect(await threeKeysExist(redis, 'REAP02')).toBe(3);
  });

  it('playing ⇒ **即使** now 远超创建时的 timeoutAt 也不得回收（§3.1：状态本身才是判据）', async () => {
    const { redis, service, reaper } = await seedRoom('REAP03');
    await service.updateStatus('REAP03', 'playing');

    const reaped = await reaper.reapOnce(Date.now() + 10 * 60_000);

    expect(reaped).not.toContain('REAP03');
    expect(await threeKeysExist(redis, 'REAP03')).toBe(3);
  });

  it('finished ⇒ 立即回收（N31①：旧实现全仓**没有任何删除点**，打完的房间挂满一小时）', async () => {
    const { redis, service, reaper } = await seedRoom('REAP04');
    await service.updateStatus('REAP04', 'finished');

    // ⚠️ 传**当前**时刻：终局的回收**不得**依赖等待窗口过期
    const reaped = await reaper.reapOnce(Date.now());

    expect(reaped).toContain('REAP04');
    expect(await threeKeysExist(redis, 'REAP04')).toBe(0);
  });

  it('cancelled ⇒ 立即回收', async () => {
    const { redis, service, reaper } = await seedRoom('REAP05');
    await service.updateStatus('REAP05', 'cancelled');

    expect(await reaper.reapOnce(Date.now())).toContain('REAP05');
    expect(await threeKeysExist(redis, 'REAP05')).toBe(0);
  });

  it('幂等：对已经回收过的房间再跑一轮不抛、也不再重复上报', async () => {
    const { reaper } = await seedRoom('REAP06');
    const later = Date.now() + 10 * 60_000;

    expect(await reaper.reapOnce(later)).toContain('REAP06');
    await expect(reaper.reapOnce(later)).resolves.toEqual([]);
  });

  it('空栈（没有任何房间）⇒ 回收一轮返回空数组，不抛', async () => {
    const service = new RoomsService(asRedis(createFakeRedis()), asConfigCache(makeConfigCache()));
    const reaper = new RoomsReaperTask(service, asConfigCache(makeConfigCache()));
    await expect(reaper.reapOnce()).resolves.toEqual([]);
  });

  /**
   * **W3（片⑥ · spec §3.2）**：两个 `reapOnce()` **并发** ⇒ 房间与**全部派生键**清干净、**不抛**。
   *
   * ⚠️ **如实记：这条今天不会红**（spec §3.2 明文要求这么写）。回收的每一步都是**幂等原语**
   *（`DEL` 对不存在的键返回 0），所以「谁先谁后」不影响终态 —— 判据断言的是**终态**。
   * 留着它的理由**不是**它现在有判别力，而是：将来有人往回收里加一步**非幂等**的动作
   *（例如「先读一眼再删」「删之前改状态」）时，它才会红。**不得**假装它现在能抓缺陷。
   *
   * ⚠️ 与上面「幂等」那条的区别：那条是**顺序**两次（第二次必然看见空），
   * 这条是**真并发**（`Promise.all`，两个实例可能都读到同一个房间）。
   *
   * ⚠️ `room:{code}:bots`（R207 的绑定表）**不在** `deleteRoom` 的删除集里 —— 那是**已知**
   * 的既有形态（它自带 3600s TTL 兜底），本片不动它，因此这里**不**把它算进判据。
   */
  it('W3：两个 reapOnce() 并发 ⇒ 房间与全部派生键清干净、不抛', async () => {
    const { redis, reaper } = await seedRoom('REAP07');
    // 补上第四个键（`fillat`：手动房的补位死线），让「四个键都清干净」是完整的
    await redis.set(fillAtKey('REAP07'), String(Date.now()), 'EX', 3600);
    const keysExist = async () =>
      (await redis.exists(`room:REAP07`)) +
      (await redis.exists(seatsKey('REAP07'))) +
      (await redis.exists(cardCountKey('REAP07'))) +
      (await redis.exists(fillAtKey('REAP07')));
    // 前置正对照：四个键此刻**确实都在**（否则「回收后为 0」可能是空测）
    expect(await keysExist()).toBe(4);

    const later = Date.now() + 10 * 60_000;
    const results = await Promise.all([reaper.reapOnce(later), reaper.reapOnce(later)]);

    // 「不抛」由上面那行本身承担（`reapOnce` 会 reject）；这里再钉住「真的回收了」
    expect(results.flat(), '两个实例中至少有一个要如实上报这个房间').toContain('REAP07');
    expect(await keysExist()).toBe(0);
  });

  // ── 判据 11（单测半边）：定时器链路 `source: 'timer'`（R1107）──────────────
  //
  // R1107「无来源不编造」的**另一半**：定时器起的一轮**不是**「没有来源」——
  // 它以「**这一轮**扫描」为来源 ⇒ 每轮自建一个 traceId + `source: 'timer'`
  //（spec §3 载体表的「定时器」行）。ALS 里**没有值**时才该降级成 `null` + `bootstrap`。
  //
  // 观测口与判据 6′ 同形：Nest 的 logger 是**进程级**的 ⇒ `Logger.overrideLogger`
  // 装一个捕获 sink，服务自己 `new Logger(...)` 打的行就全部进来（不必抓 stdout）。
  it('判据 11：扫描器一轮的日志带 source=timer 且 traceId 非空（无来源才该是 null）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

    const { reaper } = await seedRoom('REAP11');
    const reaped = await reaper.reapOnce(Date.now() + 10 * 60_000);

    // 反空测：这一轮必须**真的**扫到并回收了房间 —— `Reaped` 行只在回收数 > 0 时打，
    // 钉住返回值是为了让「找不到行」这种哑红**先**以「什么都没扫到」的形态暴露出来。
    expect(reaped, '这一轮必须真的回收了房间（否则断言的是空）').toContain('REAP11');
    const line = records.find((r) => r.msg.includes('Reaped'));
    expect(line, '扫描完成的那行日志必须在（否则本判据空转）').toBeDefined();
    expect(line!.source).toBe('timer');
    expect(line!.traceId).not.toBeNull();
  });

  /**
   * **复核⑭ / R1107 的另一半**：**轮级 catch** 的行也必须有来源。
   *
   * `Room reap failed` 起于「`reapOnce` 整轮抛错」的那次兜底 —— 它由 `setInterval`
   * 回调直接注册，不在 `reapOnce` 的 ALS 之内 ⇒ 不包的话这行会落在 `bootstrap`
   * （**假话**：它恰恰说明一轮**定时回收**失败了）。⇒ 回调体外再包一层
   * `{ traceId: null, source: 'timer' }`。
   *
   * `traceId: null` 是**接受的取舍**（spec §6 已登记；注释写在 `startReapLoop` 里）：
   * 这一层看不到内层工作单元（`reapOnce` 自建）的 id，替代方案要给它加签名参数，
   * 代价大于收益。
   */
  it('判据 11（轮级 catch 半边）：回收循环的兜底行带 source=timer 且 traceId=null（复核⑭）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

    const reaper = new RoomsReaperTask(
      new RoomsService(asRedis(createFakeRedis()), asConfigCache(makeConfigCache())),
      asConfigCache(makeConfigCache()),
    );
    const spy = vi.spyOn(reaper, 'reapOnce').mockRejectedValue(new Error('boom'));

    vi.useFakeTimers();
    try {
      reaper.startReapLoop();
      // 桩的 `cycleMs` 缺省 = `CYCLE_MS_DEFAULTS['room.reapIntervalMs']`（60000）。
      await vi.advanceTimersByTimeAsync(60_000); // 触发恰好一轮
    } finally {
      reaper.onApplicationShutdown();
      vi.useRealTimers();
    }

    // 反空测：这一轮必须**真的**跑过（否则「找不到兜底行」的失败原因无从判别 ——
    // 是「没触发」还是「包法错了」）
    expect(spy, '起循环后必须真的触发过一轮（否则断言的是空）').toHaveBeenCalledTimes(1);
    const line = records.find((r) => r.msg.includes('Room reap failed'));
    expect(line, '轮级 catch 的那行必须在（否则本判据空转）').toBeDefined();
    expect(line!.source).toBe('timer');
    expect(line!.traceId).toBeNull();
  });
});

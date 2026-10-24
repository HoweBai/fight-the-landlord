/**
 * E9 / §9.6 的池闭环（R201/R207）—— 全部用**按真实语义**的假 Redis，不连真 Redis。
 *
 * 判据（计划 Task 5 的五条 + 本条新增的 ZSET 形状）：
 *  ① 池空 ⇒ `acquire({roomCode:'R1', seats:[1,2]})` 创建 2 个 bot（内部 `botId` +
 *     对外 `displayId === /^p_[0-9A-Za-z]{8}$/`，`roomCode`/`seat` **由 robot-service 写入**）；
 *  ② **幂等**：同 `{roomCode:'R1', seats:[1]}` 再调 ⇒ 同一个 `botId`/`displayId`，
 *     `ZCARD bot:pool:ddz` 不变；
 *  ③ `release({botIds})` ⇒ 两个 bot 回池、`bot:{botId}` 的 `roomCode`/`seat` 清空、`idleSince` 有值；
 *  ④ 回收：`idleSince` 超过 10 分钟且 `roomCode` 指向的房间不存在 ⇒ `ZREM`；
 *  ⑤ **对局中不回收**（`room:{roomCode}` 存在 ⇒ 留着）。
 *
 * ⚠️ 池是 **ZSET**（§10.1：`member = botId`、`score = idleSince`），
 * 所以「在不在池里」用 `ZCARD` / `ZSCORE` 断言，**不是** `SCARD`/`SISMEMBER`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import {
  BOT_ROOM_TTL_SECONDS,
  GAME_TYPE,
  IDLE_RECLAIM_MS,
  RobotPool,
  botBoundKey,
  botKey,
  botPoolKey,
  botRoomKey,
} from '../src/robot/robot.pool';
import { RobotReclaimTask } from '../src/robot/robot.reclaim.task';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';
import { asRedis, createFakeRedis, type FakeRedis } from './helpers/fake-redis';

const DISPLAY_ID = /^p_[0-9A-Za-z]{8}$/;

/**
 * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原的话，
 * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到自己的
 * 日志行）。还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

describe('RobotPool —— §9.6 池闭环（R201/R207）', () => {
  let redis: FakeRedis;
  let pool: RobotPool;
  let now: number;
  let configCache: ConfigCacheStub;

  beforeEach(() => {
    redis = createFakeRedis();
    now = 1_700_000_000_000;
    configCache = makeConfigCache();
    pool = new RobotPool(asRedis(redis), () => now, asConfigCache(configCache));
    // 固定随机源：难度分布与思考延迟都变成确定值（**只**影响参数，不影响被测语义）
    pool.random = () => 0.1;
  });

  it('① 池空 ⇒ 为每个空缺座位创建一个机器人，房间/座位由 robot-service 写入', async () => {
    const bots = await pool.acquire('R1', [1, 2]);

    expect(bots).toHaveLength(2);
    expect(bots.map((b) => b.seat)).toEqual([1, 2]);
    for (const bot of bots) {
      expect(bot.botId).toMatch(/^bot-[0-9a-f]{8}$/); // 内部 id（永不出站）
      expect(bot.displayId).toMatch(DISPLAY_ID); // 对外 id（与人类同构）
      expect(bot.displayId.startsWith('bot')).toBe(false); // §9.1-1：不得有 bot 前缀
      expect(bot.roomCode).toBe('R1');
      expect(bot.skillLevel).toBe('beginner'); // random=0.1 < 0.15
      expect(bot.personality.thinkingSpeed).toBe(1200); // 1000 + floor(0.1 * 2000)
      // 绑定中 ⇒ **不在**池里（结构性的「池里的一定空闲」）
      expect(await redis.zscore(botPoolKey(GAME_TYPE), bot.botId)).toBeNull();
    }
    expect(await pool.poolSize()).toBe(0);

    // 记录落盘：`bot:{botId}` 是 String(JSON)，含 displayId 与绑定信息
    const stored = await pool.get(bots[0]!.botId);
    expect(stored).toMatchObject({ roomCode: 'R1', seat: 1, displayId: bots[0]!.displayId });
    // 幂等索引：座位 → botId
    expect(await redis.hget(botRoomKey('R1'), '1')).toBe(bots[0]!.botId);
  });

  it('② 幂等：同 {roomCode, seat} 再调 ⇒ 同一个 bot，池计数不变（A7⑤ 重试的前提）', async () => {
    const first = await pool.acquire('R1', [1]);
    const second = await pool.acquire('R1', [1]);

    expect(second).toHaveLength(1);
    expect(second[0]!.botId).toBe(first[0]!.botId);
    expect(second[0]!.displayId).toBe(first[0]!.displayId);
    expect(await pool.poolSize()).toBe(0);
    // 池里也没有凭空多出记录
    expect(redis.zadd).toHaveBeenCalledTimes(0);
  });

  it('③ release ⇒ 回池 + 清空绑定 + 打上 idleSince', async () => {
    const bots = await pool.acquire('R1', [1, 2]);
    const ids = bots.map((b) => b.botId);

    const released = await pool.release(ids);

    expect(released).toBe(2);
    expect(await pool.poolSize()).toBe(2);
    for (const botId of ids) {
      const bot = await pool.get(botId);
      expect(bot!.roomCode).toBeNull();
      expect(bot!.seat).toBeNull();
      expect(bot!.idleSince).toBe(now);
      expect(Number(await redis.zscore(botPoolKey(GAME_TYPE), botId))).toBe(now);
    }
    // 座位索引被清掉（否则下一次 acquire 会复用一个「已归池」的机器人）
    expect(await redis.hget(botRoomKey('R1'), '1')).toBeNull();
  });

  it('③′ 归池后再 acquire ⇒ **复用**池里的机器人（不新建）', async () => {
    const bots = await pool.acquire('R1', [1, 2]);
    await pool.release(bots.map((b) => b.botId));

    const reused = await pool.acquire('R2', [0, 1]);

    expect(reused.map((b) => b.botId).sort()).toEqual(bots.map((b) => b.botId).sort());
    expect(reused.map((b) => b.roomCode)).toEqual(['R2', 'R2']);
    expect(await pool.poolSize()).toBe(0); // 又被绑定了 ⇒ 出池
  });

  /**
   * **片⑦ E3**：抽档比例读 `ConfigCacheService.skillDistribution()` ——
   * 「改键 ⇒ **下一次抽档**生效」（spec E3 的热项口径）。
   *
   * 判别力：随机源固定 0.1 —— 种子分布（0.15/0.35/0.5）下它是 `beginner`；
   * 把分布改成只给 advanced ⇒ 同一个 0.1 必须抽到 `advanced`。抽档不读缓存的实现
   * （仍读 env / 常量）这一拍会红。
   */
  it('③″ 片⑦ E3：自定义分布 ⇒ 下一次抽档即生效（读的必须是 ConfigCache）', async () => {
    configCache.skillDistribution.mockReturnValue([
      ['beginner', 0],
      ['intermediate', 0],
      ['advanced', 1],
    ]);

    const [bot] = await pool.acquire('R1', [1]);

    expect(bot!.skillLevel).toBe('advanced'); // 0.1 落进 advanced 的区间
    expect(configCache.skillDistribution).toHaveBeenCalled();
  });

  it('④ 回收：idleSince 超过 10 分钟且房间不存在 ⇒ ZREM + 删记录', async () => {
    const bots = await pool.acquire('R1', [1]);
    await pool.release([bots[0]!.botId]);
    // 模拟「房间早已过期」（room:{code} 不存在）
    now += IDLE_RECLAIM_MS + 1;

    const reclaimed = await pool.reclaimIdle();

    expect(reclaimed).toEqual([bots[0]!.botId]);
    expect(await pool.poolSize()).toBe(0);
    expect(await pool.get(bots[0]!.botId)).toBeNull();
  });

  it('⑤ 对局中不回收：roomCode 的房间**仍存在** ⇒ 留着（正对照见 ④）', async () => {
    const bots = await pool.acquire('R1', [1]);
    await pool.release([bots[0]!.botId]);
    // 手工造出「在池里、但 roomCode 指向的房间还在」的形态
    const bot = (await pool.get(bots[0]!.botId))!;
    await redis.set(botKey(bot.botId), JSON.stringify({ ...bot, roomCode: 'R1' }));
    await redis.set('room:R1', JSON.stringify({ code: 'R1' })); // 房间存在
    now += IDLE_RECLAIM_MS + 1;

    const reclaimed = await pool.reclaimIdle();

    expect(reclaimed).toEqual([]);
    expect(await pool.poolSize()).toBe(1);
    expect(await pool.get(bot.botId)).not.toBeNull();
  });

  it('⑤′ 刚归池的机器人**不**在回收窗口内（阈值是 10 分钟，不是 0）', async () => {
    const bots = await pool.acquire('R1', [1]);
    await pool.release([bots[0]!.botId]);

    expect(await pool.reclaimIdle()).toEqual([]);
    expect(await pool.poolSize()).toBe(1);
  });

  /**
   * **幽灵成员不得吃掉池容量**（conformance agent 在取 RED 时受控复现、协调者独立复核）。
   *
   * 现场事实：`ZCARD bot:pool:ddz` = **2**，而那两个成员的 `EXISTS bot:<id>` **都是 0**
   * —— 索引有、记录无。
   *
   * 根因（`takeIdle()`）：**先 `zrem` 再 `get`**，`get` 返回 `null` 时直接
   * `return null` ⇒ 这个名额**永久消失**，而调用方以为「池空」去新建 ⇒ 容量净减。
   * 与 `reclaimIdle()`（会清悬挂）**口径不一致**。
   *
   * ⚠️ 判据必须能区分「修好了」与「碰巧拿到了一个机器人」：
   *  - ① 悬挂者被**清掉**（`ZSCORE` 为 null）—— 这是**净减 1** 的直接反面；
   *  - ② 两次 `acquire` **都**拿到机器人（证明不是「拿到 null 就放弃」）；
   *  - ③ 池里**没有**幽灵（`poolSize()` 与 `listIdle()` 一致）——
   *    只断言「返回了机器人」在旧实现下**也可能绿**（旧实现会新建一个，
   *    而悬挂成员留在池里 ⇒ 那正是缺陷本身）。
   */
  it('⑤″ 池里的**幽灵成员**（索引有、记录无）不得吃掉容量，且必须被清掉', async () => {
    const poolKey = botPoolKey(GAME_TYPE);
    const DANGLING = 'bot-DANGLING';
    // 合成悬挂成员：**只** zadd 进池，**不**写 `bot:{botId}` 记录
    await redis.zadd(poolKey, 0, DANGLING);
    expect(await redis.exists(botKey(DANGLING))).toBe(0);
    // ⚠️ 这里必须用**裸 `ZCARD`** 而不是 `poolSize()`：要展示的正是「索引层说 1、
    // 真实清单说 0」的分叉（现场实测的形态）。修好之后 `poolSize()` 会如实报 0。
    expect(await redis.zcard(poolKey)).toBe(1); // 索引层的假象
    expect(await pool.poolSize()).toBe(0); // 真实口径（修前此处是 1 —— 缺陷的可观测形态）

    // ① 第一次 acquire：必须**跨过**悬挂者去新建（不返回 null、不抛）
    const [first] = await pool.acquire('R1', [1]);
    expect(first).toBeDefined();
    expect(first!.botId).not.toBe(DANGLING);
    // 悬挂成员被清掉（净减 1 的反面）
    expect(await redis.zscore(poolKey, DANGLING)).toBeNull();

    // ② 再 acquire 一次仍能拿到机器人（证明不是「拿到 null 就放弃」）
    const [second] = await pool.acquire('R2', [1]);
    expect(second).toBeDefined();
    expect(second!.botId).not.toBe(DANGLING);

    // ③ 池的口径一致：`poolSize()`（索引）与 `listIdle()`（真记录）不得分叉
    expect(await pool.listIdle()).toEqual([]);
    expect(await pool.poolSize()).toBe(0);
  });

  /**
   * 正对照：**真实**空闲机器人照样被 `acquire` 复用（幽灵清理不得误伤正常成员）。
   *
   * 没有这一条，把 `takeIdle()` 写成「一律返回 null」也能让上面的用例绿。
   */
  it('⑤‴ 正对照：幽灵与真实空闲并存时，真实那个被复用（清理不误伤）', async () => {
    const poolKey = botPoolKey(GAME_TYPE);
    const [real] = await pool.acquire('R0', [0]);
    await pool.release([real!.botId]); // real 回池，带 idleSince
    await redis.zadd(poolKey, 0, 'bot-GHOST'); // 幽灵的 score 更小 ⇒ 排在前面

    const [got] = await pool.acquire('R1', [1]);

    expect(got!.botId).toBe(real!.botId); // 复用的是真实那个
    expect(await redis.zscore(poolKey, 'bot-GHOST')).toBeNull(); // 幽灵被清掉
    expect(await pool.poolSize()).toBe(0);
  });

  /**
   * ─────────────────────────────────────────────────────────────────────
   * **N21 / R247**：`bot:bound:{botId}` 反向视图 + 兜底回收的**第二轮**
   * ─────────────────────────────────────────────────────────────────────
   *
   * 缺陷（切片 11 登记）：`bot:pool` 是**空闲集合**（绑定中的机器人 `ZREM` 出池），
   * 所以「`release` 丢失、机器人一直绑定」这种机器人在池里**结构上扫不到** ——
   * 池那一轮**永远**看不见它，`reclaimIdle()` 也就永远回收不到。
   */
  it('N21：acquire 必须写绑定索引（与 ZREM 出池成对），release 必须删掉它（与 ZADD 成对）', async () => {
    const [bot] = await pool.acquire('R1', [1]);
    const botId = bot!.botId;

    const raw = await redis.get(botBoundKey(botId));
    expect(raw, 'acquire 没写 bot:bound 索引').toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({ roomCode: 'R1', seat: 1, boundAt: now });
    // TTL 与房间一致（3600s）——「写了个键但没 TTL」是这类索引最容易漏的一半
    expect(await redis.ttl(botBoundKey(botId))).toBe(BOT_ROOM_TTL_SECONDS);

    const released = await pool.release([botId]);
    expect(released).toBe(1);
    expect(await redis.get(botBoundKey(botId)), 'release 没清 bot:bound 索引').toBeNull();
    // 成对：归池那一侧 `ZADD` 真的发生了（否则「删了视图」也可能是把两个都没做）
    expect(await redis.zscore(botPoolKey(GAME_TYPE), botId)).toBe(String(now));
  });

  it('N21：兜底回收必须扫得到「`release` 丢失」的绑定机器人（房间已不存在）', async () => {
    const [bot] = await pool.acquire('GONE1', [1]);
    const botId = bot!.botId;
    // 只让「房间键」消失（模拟 room-service 崩了、release 从未发出）：
    // 机器人仍在**绑定中**（不在池里、有 bot:bound 视图）—— 这正是池那一轮看不见的形态
    expect(await redis.zscore(botPoolKey(GAME_TYPE), botId)).toBeNull();

    const reclaimed = await pool.reclaimIdle(now + IDLE_RECLAIM_MS + 1);

    expect(
      reclaimed,
      `回收没扫到绑定的孤儿机器人 ${botId}（N21 的核心判据）—— 实际 ${JSON.stringify(reclaimed)}`,
    ).toContain(botId);
    expect(await redis.get(botBoundKey(botId)), '回收后反向视图必须清掉').toBeNull();
    expect(await pool.get(botId), '回收后权威记录必须清掉').toBeNull();
  });

  it('N21 正对照：房间**还在**的绑定机器人**不得**被回收（§9.6「对局中的机器人不得回收」）', async () => {
    const [bot] = await pool.acquire('ALIVE', [1]);
    await redis.set('room:ALIVE', JSON.stringify({ code: 'ALIVE' }));
    // ⚠️ 刻意把 `now` 推过 10 分钟：`boundAt` **不单独**触发回收（一局可以打很久，
    // 用 boundAt 单独判会误杀对局中的机器人；计划 R247 的措辞与 §9.6 冲突，见裁决 R261）。
    const reclaimed = await pool.reclaimIdle(now + IDLE_RECLAIM_MS + 1);

    expect(reclaimed).not.toContain(bot!.botId);
    expect(await redis.get(botBoundKey(bot!.botId))).not.toBeNull(); // 视图也留着
    expect(await pool.get(bot!.botId)).not.toBeNull();
  });

  it('N21：`bot:{botId}` 是**权威** —— 视图悬挂（记录没了 / 权威说空闲）时只清视图，不误回收', async () => {
    // ① 权威记录不存在 ⇒ 视图悬挂
    await redis.set(botBoundKey('bot-GHOSTV'), JSON.stringify({ roomCode: 'X1', seat: 0, boundAt: now }));
    // ② 权威说它**空闲**（release 的 DEL 丢了）⇒ 视图悬挂
    const [idleBot] = await pool.acquire('R7', [1]);
    await pool.release([idleBot!.botId]);
    await redis.set(
      botBoundKey(idleBot!.botId),
      JSON.stringify({ roomCode: 'R7', seat: 1, boundAt: now }),
    );

    // ⚠️ 这里刻意**不**把 now 推过 10 分钟：`idleBot` 是**真的空闲**（在池里、idleSince=now），
    // 推过去的话第一轮（§9.6 的空闲回收）本来就会合法地回收它 —— 那与本条要测的
    // 「视图悬挂只清视图」混在一起就不可判了。
    const reclaimed = await pool.reclaimIdle(now + 1000);

    expect(reclaimed).toEqual([]); // 两条都不是「该回收」的候选
    expect(await redis.get(botBoundKey('bot-GHOSTV')), '悬挂视图必须清掉').toBeNull();
    expect(await redis.get(botBoundKey(idleBot!.botId)), '权威说空闲 ⇒ 视图必须清掉').toBeNull();
    expect(await pool.get(idleBot!.botId), '空闲机器人不得被这轮误删').not.toBeNull();
  });

  it('N21：视图与权威不一致 ⇒ **按权威走**（修正视图），并按权威的房间判定回收', async () => {
    const [bot] = await pool.acquire('REAL01', [2]);
    const botId = bot!.botId;
    // 视图写了一个**错的**房间号（而那个房间恰好存在）
    await redis.set(botBoundKey(botId), JSON.stringify({ roomCode: 'WRONG1', seat: 9, boundAt: now }));
    await redis.set('room:WRONG1', 'x');
    // 权威指向的 REAL01 **不存在** ⇒ 必须按权威回收（若按视图走会被 WRONG1 骗过去）
    expect(await pool.reclaimIdle(now + IDLE_RECLAIM_MS + 1)).toContain(botId);
    expect(await pool.get(botId)).toBeNull();
  });

  it('N21：坏视图（非 JSON / 缺字段）不得把回收打崩，且必须被清掉', async () => {
    await redis.set(botBoundKey('bot-BAD1'), 'not-json');
    await redis.set(botBoundKey('bot-BAD2'), JSON.stringify({ roomCode: 'R1' }));

    const reclaimed = await pool.reclaimIdle(now + IDLE_RECLAIM_MS + 1);

    expect(reclaimed).toEqual([]);
    expect(await redis.get(botBoundKey('bot-BAD1'))).toBeNull();
    expect(await redis.get(botBoundKey('bot-BAD2'))).toBeNull();
  });

  /**
   * **W2（片⑥ · spec §3.2）**：两个 `reclaimIdle()` **并发**（`Promise.all`，真并发）。
   *
   * ⚠️ **直接调池**（不是 `RobotReclaimTask`）—— 那才是「双开执行同一段逻辑」的真形态：
   * 任务类只是 `setInterval` 的壳，双开时**每个实例都会调一次**这个方法。
   *
   * 判据取**不变量**（spec §0.3），三个都要有：
   *  ① 该回收的两个（池里的空闲 + `release` 丢失的绑定孤儿）**回收干净**；
   *  ② **对局中的那个一格未动**（房间还在 ⇒ 不得回收，§9.6 逐字）；
   *  ③ **不抛**（两个实例都会遍历同一批候选 ⇒ 第二次的 `DEL`/`ZREM` 必然打在已被删的键上）。
   *
   * ⚠️ **不**断言「恰好一个回收了它」：两次 `DEL`/`ZREM` 都是幂等的，两个实例**都**上报
   * 同一个机器人是**允许**的（`reclaimed` 是各自的 Set，跨实例去重不在契约里）。
   * 若断言「合计恰好一次」，这条会随交错顺序随机红 —— 那是在测调度，不是在测不变量。
   */
  it('W2：两个 reclaimIdle() 并发 ⇒ 该收的收干净、对局中的那个一格未动、不抛', async () => {
    /**
     * ⚠️ **三个机器人必须先各就各位、再归池**（本用例实测踩过）：`release` 会把机器人放回
     * 空闲集合，而 `acquire` 会**复用**池里最久的那一个 ⇒ 先 release 再 acquire 会让「三个」
     * 变成**同一个**机器人（实测：`aliveId === orphanId`，判据因此红在一个毫不相干的断言上）。
     */
    const [alive] = await pool.acquire('R-ALIVE', [1]); // ① 「对局中」（下面手工把它的绑定摆回去）
    const aliveId = alive!.botId;
    // ② 「绑定孤儿」：房间没了，但绑定视图还在（`release` 丢失 ⇒ 池那一轮看不见它）
    const [orphan] = await pool.acquire('R-GONE', [1]);
    const orphanId = orphan!.botId;
    // ③ 「普通空闲」：已归池、房间早就没了 ⇒ 池那一轮的候选
    const [idle] = await pool.acquire('R-IDLE', [1]);
    const idleId = idle!.botId;
    expect(new Set([aliveId, orphanId, idleId]).size, '三个机器人必须是三个').toBe(3);

    await pool.release([idleId]);
    // ① 的续：把它也归池（这样它才是池那一轮的候选），再手工摆回「绑定信息指向一个**存在**的房间」
    await pool.release([aliveId]);
    // —— 正是 §9.6「对局中的机器人不得回收」要挡的形态（见上面用例 ⑤ 的同款构造）
    const aliveRec = (await pool.get(aliveId))!;
    await redis.set(botKey(aliveId), JSON.stringify({ ...aliveRec, roomCode: 'R-ALIVE' }));
    await redis.set('room:R-ALIVE', 'x'); // 房间存在

    const later = now + IDLE_RECLAIM_MS + 1;
    const passes = await Promise.all([pool.reclaimIdle(later), pool.reclaimIdle(later)]);
    const reclaimed = new Set(passes.flat());

    // 反空测：这一轮**真的**回收了东西（否则下面「该收的收干净」可能只是没人干活）
    expect(reclaimed.size, '两个实例合起来一个都没回收 —— 判据退化成空测').toBeGreaterThan(0);
    // ① 该回收的都回收了
    expect([...reclaimed].sort()).toEqual([orphanId, idleId].sort());
    for (const botId of [orphanId, idleId]) {
      expect(await pool.get(botId), `${botId} 的权威记录必须删掉`).toBeNull();
      expect(await redis.zscore(botPoolKey(GAME_TYPE), botId), `${botId} 必须出池`).toBeNull();
      expect(await redis.get(botBoundKey(botId)), `${botId} 的绑定视图必须清掉`).toBeNull();
    }
    // ② 对局中的那个：一格未动
    expect(reclaimed.has(aliveId), '房里那个不得被回收（§9.6）').toBe(false);
    expect(await pool.get(aliveId), '权威记录必须还在').not.toBeNull();
    expect(
      await redis.zscore(botPoolKey(GAME_TYPE), aliveId),
      '还留在池里（两个实例都不得把它 ZREM 掉）',
    ).not.toBeNull();
  });

  it('片② D2/J5c：每新绑定恰好抽 2 个随机数，幂等命中 0 个', async () => {
    let draws = 0;
    pool.random = () => { draws += 1; return 0.1; };

    await pool.acquire('R1', [1]);
    expect(draws).toBe(2);          // skillLevel + thinkingSpeed
    await pool.acquire('R1', [1]);  // 幂等命中 ⇒ 不再抽
    expect(draws).toBe(2);
  });

  it('片② D2/J5：release 后再 acquire ⇒ 难度与基础手速都重抽并写回', async () => {
    const seq = [0.1, 0.1, 0.9, 0.9];   // 每次新绑定 = [难度, 手速]
    pool.random = () => seq.shift()!;

    const [a] = await pool.acquire('R1', [1]);
    await pool.release([a.botId]);
    const [b] = await pool.acquire('R2', [1]);

    expect(a.skillLevel).toBe('beginner');
    expect(a.personality.thinkingSpeed).toBe(1200);   // 1000 + floor(0.1 * 2000)
    expect(b.skillLevel).toBe('advanced');
    expect(b.personality.thinkingSpeed).toBe(2800);   // 1000 + floor(0.9 * 2000)
    expect((await pool.get(b.botId))?.skillLevel).toBe('advanced');   // 写回要落盘
    expect((await pool.get(b.botId))?.personality.thinkingSpeed).toBe(2800); // 手速也必须落盘
  });

  it('基础手速采样边界：[1000, 3000)', async () => {
    pool.random = () => 0;
    const [low] = await pool.acquire('RB0', [0]);
    expect(low!.personality.thinkingSpeed).toBe(1000);

    pool.random = () => 0.999999;
    const [high] = await pool.acquire('RB1', [0]);
    expect(high!.personality.thinkingSpeed).toBe(2999);
  });

  it('难度分布按 §9.3 三档；基础手速统一 1–3s、与难度无关', async () => {
    // 每个新绑定消费 2 个随机数：[难度, 手速]
    const seq = [0.1, 0.5, 0.3, 0.5, 0.6, 0.5];
    pool.random = () => seq.shift()!;

    const [beg] = await pool.acquire('R9', [0]);
    expect(beg!.skillLevel).toBe('beginner');
    expect(beg!.personality.thinkingSpeed).toBe(2000); // 1000 + floor(0.5 * 2000)

    const [mid] = await pool.acquire('R9', [1]);
    expect(mid!.skillLevel).toBe('intermediate');
    expect(mid!.personality.thinkingSpeed).toBe(2000);

    const [adv] = await pool.acquire('R9', [2]);
    expect(adv!.skillLevel).toBe('advanced');
    expect(adv!.personality.thinkingSpeed).toBe(2000);
  });

  it('片② J24：老记录（personality 带 errorRate）仍可读、值无损', async () => {
    // 直塞一条「本片之前写下的」旧形状记录：多一个 personality.errorRate 与一个无关字段
    const legacy = {
      botId: 'bot-legacy01',
      displayId: 'p_legacy01',
      skillLevel: 'beginner',
      personality: { thinkingSpeed: 900, errorRate: 0.15 },
      roomCode: null,
      seat: null,
      gamesPlayed: 3,
      legacyExtra: 'x',
    };
    await redis.set(botKey('bot-legacy01'), JSON.stringify(legacy));

    const bot = await pool.get('bot-legacy01');

    expect(bot).not.toBeNull();
    expect(bot!.skillLevel).toBe('beginner');
    expect(bot!.personality.thinkingSpeed).toBe(900);
    expect(bot!.gamesPlayed).toBe(3);
  });

  it('片② J24：新记录的 personality 只剩 thinkingSpeed（字段集只减不增）', async () => {
    const [bot] = await pool.acquire('R1', [1]);

    const persisted = JSON.parse((await redis.get(botKey(bot!.botId)))!) as Record<string, unknown>;

    expect(Object.keys(persisted.personality as object).sort()).toEqual(['thinkingSpeed']);
    // 多玩法（Task 2.6）：新增 `gameType` 是**有意的契约扩展**（池按玩法隔离的前提）。
    expect(Object.keys(persisted).sort()).toEqual(
      ['botId', 'displayId', 'gamesPlayed', 'gameType', 'personality', 'roomCode', 'seat', 'skillLevel'].sort(),
    );
  });
});

/**
 * §9.6 的**定期回收节奏**（`RobotReclaimTask`）：用假计时器证明「确实周期触发」，
 * 而不是只证明 `reclaimIdle()` 这个函数本身可用（那是上一条用例的事）。
 *
 * ─── 片⑦ E5 的改造（同 T7 模板）────────────────────────────────────────
 * 周期不再来自 env 常量（`ROBOT_RECLAIM_INTERVAL_MS` 已退役）—— 改读
 * `configCache.reclaimIntervalMs()`；`setInterval` → `setTimeout` **自重排**链
 * （C9 口径：本轮按旧值跑完、其后按新值排下一轮）；带**关停闸**（在途一轮的迟到
 * 回执不得在关停后复活循环 —— 与 `ConfigCacheService` 同款的两半判据）。
 */
describe('RobotReclaimTask —— 定期回收的节奏（§9.6；片⑦ E5 自重排）', () => {
  /** 一个可由用例放行的挂起 promise（把「一轮在途」钉在精确时刻；T7 模板同款）。 */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('按周期触发 reclaimIdle（周期读缓存，缺省 60000=种子），shutdown 后不再触发', async () => {
    vi.useFakeTimers();
    try {
      const redis = createFakeRedis();
      const cache = makeConfigCache();
      const pool = new RobotPool(asRedis(redis), () => 1_700_000_000_000, asConfigCache(cache));
      const spy = vi.spyOn(pool, 'reclaimIdle').mockResolvedValue([]);
      const task = new RobotReclaimTask(pool, asConfigCache(cache));

      task.startReclaimLoop();
      task.startReclaimLoop(); // 幂等：不得装两个计时器
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(cache.reclaimIntervalMs, '周期必须读 ConfigCache（env 常量已退役）').toHaveBeenCalled();

      task.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(60_000 * 3);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **C9（片规格 §4 / T7 模板口径）**：周期改小 ⇒ **第 N+1 轮触发点 = 第 N 轮结束 + 新值**
   * （当前一轮按旧值跑完）。判别力：`setInterval` 未退役的实现下周期改不动（第 2 轮永远
   * 只有旧节拍）；「启动时读一次存起来」的实现同样红。
   */
  it('C9：改小 1000→100 后第 2 轮触发点 = 第 1 轮结束 + 100（+99 不触发）', async () => {
    const redis = createFakeRedis();
    const cache = makeConfigCache();
    const pool = new RobotPool(asRedis(redis), () => 1_700_000_000_000, asConfigCache(cache));
    const round = deferred<string[]>();
    const spy = vi.spyOn(pool, 'reclaimIdle').mockReturnValue(round.promise);
    cache.reclaimIntervalMs.mockReturnValue(1_000);
    const task = new RobotReclaimTask(pool, asConfigCache(cache));

    vi.useFakeTimers();
    try {
      task.startReclaimLoop(); // 第 1 轮排在 t=1000（旧值）
      await vi.advanceTimersByTimeAsync(1_000); // 第 1 轮开始（在途：reclaimIdle 未回）
      expect(spy).toHaveBeenCalledTimes(1);

      cache.reclaimIntervalMs.mockReturnValue(100); // 一轮**在途期间**改小
      round.resolve([]); // 第 1 轮结束
      await vi.advanceTimersByTimeAsync(0); // flush：其后按新值排下一轮

      await vi.advanceTimersByTimeAsync(99);
      expect(spy, '第 1 轮结束 + 99ms：第 2 轮还没到点').toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        spy,
        '第 2 轮触发点 = 第 1 轮结束 + 100（新值）—— setInterval 实现下这里是恒 1',
      ).toHaveBeenCalledTimes(2);
    } finally {
      task.onApplicationShutdown();
      vi.useRealTimers();
    }
  });

  /**
   * **关停闸（T6 审查 Important-2 同构）**：第 1 轮在途时关停 ⇒ 迟到的回执不得再排定时器。
   * 两半判据缺一不可：① 定时器引用为 null（闸被删掉时非 null）；② 工作方法不再被调
   * （「排了又被别处清掉」的漏过形态）。
   */
  it('关停闸：第 1 轮在途时关停 ⇒ 迟到回执不再排定时器', async () => {
    const redis = createFakeRedis();
    const cache = makeConfigCache();
    const pool = new RobotPool(asRedis(redis), () => 1_700_000_000_000, asConfigCache(cache));
    const round = deferred<string[]>();
    const spy = vi.spyOn(pool, 'reclaimIdle').mockReturnValue(round.promise);
    cache.reclaimIntervalMs.mockReturnValue(1_000);
    const task = new RobotReclaimTask(pool, asConfigCache(cache));

    vi.useFakeTimers();
    try {
      task.startReclaimLoop(); // 第 1 轮排在 t=1000
      await vi.advanceTimersByTimeAsync(1_000); // 第 1 轮开始（在途）
      expect(spy, '反空测：第 1 轮必须真的在途').toHaveBeenCalledTimes(1);

      task.onApplicationShutdown(); // 关停发生在在途期间
      round.resolve([]); // 迟到的回执（第 1 轮结束）
      await vi.advanceTimersByTimeAsync(0); // flush：无闸时这条回执会在此**复活**循环

      expect(
        (task as unknown as { timer: unknown }).timer,
        '关停后不得再排定时器（闸被删掉时这里会非 null）',
      ).toBeNull();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(spy, '放行后不得再扫（无复活循环）').toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **R1107 / 判据 11（单测半边）/ 复核⑭**：回收循环是**定时器驱动**的一轮工作
   *（spec §3 载体表「定时器」行）⇒ 一轮里 `Reclaimed …` 那行必须带**这一轮自建**的
   * traceId + `source: 'timer'`（ALS 里**真**没有值时才该降级 `null` + `bootstrap`）。
   *
   * ⚠️ 用**假计时器驱动循环**（不是直接调 `reclaimOnce()`）：包裹点在定时回调体
   * （本任务类的工作就在回调里 —— 直接调 `pool.reclaimIdle()`，不经任务类的方法）
   * ⇒ 要证的正是「**一轮定时回收**」这条链。
   *
   * 观测口与 room-service 两条扫描器**同形**：`Logger.overrideLogger` 装捕获 sink
   *（Nest 的 logger 是**进程级**的，`RobotPool` 自己 `new Logger(...)` 打的行也进来）。
   */
  it('判据 11：回收循环一轮的日志带 source=timer 且 traceId 非空（无来源才该是 null）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'robot-service' }));

    let now = 1_700_000_000_000;
    const redis = createFakeRedis();
    const cache = makeConfigCache();
    const pool = new RobotPool(asRedis(redis), () => now, asConfigCache(cache));
    const [bot] = await pool.acquire('RECL11', [1]);
    await pool.release([bot!.botId]);
    now += IDLE_RECLAIM_MS + 1; // 越过 §9.6 的 10 分钟阈值 ⇒ 下一轮是**该回收**的

    const task = new RobotReclaimTask(pool, asConfigCache(cache));
    vi.useFakeTimers();
    try {
      task.startReclaimLoop();
      await vi.advanceTimersByTimeAsync(60_000); // 触发恰好一轮（周期=缓存缺省值）
    } finally {
      task.onApplicationShutdown();
      vi.useRealTimers();
    }

    // 反空测①：这一轮必须**真的**回收了机器人（`Reclaimed …` 行只在回收 > 0 时打）
    expect(await pool.get(bot!.botId), '这一轮必须真的回收了机器人（否则断言的是空）').toBeNull();
    // 反空测②：那行日志真的在记录里（找不到行 ⇒ 显式挂掉，而不是后续断言晦涩报错）
    const line = records.find((r) => r.msg.includes('Reclaimed'));
    expect(line, '回收完成的那行日志必须在（否则本判据空转）').toBeDefined();
    expect(line!.source).toBe('timer');
    expect(line!.traceId).not.toBeNull();
  });
});

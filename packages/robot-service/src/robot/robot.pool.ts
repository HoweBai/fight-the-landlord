// packages/robot-service/src/robot/robot.pool.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
// ⚠️ **必须是值导入**（不能写 `import type Redis`）：Nest 的构造注入靠 `emitDecoratorMetadata`
// 发出的**运行期**类引用；类型导入被完全抹掉 ⇒ 元数据退化成 `Object` ⇒ 注入不到
// `RedisProviderModule` 提供的 `Redis` token（切片 11 门禁期实测：容器里 `this.redis === undefined`
// ⇒ `/api/robots/acquire` 500 `Cannot read properties of undefined (reading 'hget')`，而单测直接
// `new RobotPool(fakeRedis)` 全绿 —— 见执行期裁决 R216/R217）。token 由 `redis.provider.module.ts`
// 的 `{ provide: Redis, useFactory }` 定义，两处必须是**同一个**导入形态。
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_GAME_TYPE,
  GAME_TYPES,
  type BotInstance,
  type GameType,
  type SkillLevel,
} from '@fight-the-landlord/protocol';
// ⚠️ **值导入**（DI 陷阱纪律）：容器要按类型解析构造参数。
import { ConfigCacheService } from '../config/config-cache.service';

/**
 * §10.1 的 `bot:pool:{gameType}`：**规范玩法 id**（Task 2.6 / D1）。
 *
 * ⚠️ `'ddz'` 只是**旧池键别名**（部署窗口里的存量池）：斗地主 acquire 先读新池、空则读
 * `bot:pool:ddz` 并迁移；release **只写新池**。
 */
export const GAME_TYPE: GameType = 'doudizhu';

/** 旧斗地主池键别名（只读；Task 2.6 的双读迁移）。 */
export const LEGACY_DDZ_GAME_TYPE = 'ddz';

/** §9.6 的兜底回收阈值：空闲超过 **10 分钟** 且房间不存在。 */
export const IDLE_RECLAIM_MS = 10 * 60 * 1000;

/**
 * `takeIdle()` 单次调用最多「丢弃」多少个幽灵成员。
 *
 * 纯**防御性**上界（池的成员数本就有界；正常数据下第一次就命中）：
 * 病态数据（整池都是悬挂成员）时不让它空转到天荒地老，取不到就当作池空。
 */
export const MAX_TAKE_IDLE_SCAN = 64;

/** 房间相关键的 TTL（与 `room:{code}` 的 3600s 一致）。 */
export const BOT_ROOM_TTL_SECONDS = 3600;

/** §9.3 拟人化基础手速区间（ms）：与难度无关，1–3s。 */
export const THINKING_SPEED_RANGE: readonly [number, number] = [1000, 3000];

/** §10.1：空闲机器人集合（`member = botId`，`score = idleSince`）。 */
export const botPoolKey = (gameType: string = GAME_TYPE): string => `bot:pool:${gameType}`;

/**
 * 某玩法要读的池键（Task 2.6 / D10）：
 *  - 斗地主 = 新池 `bot:pool:doudizhu` **＋** 旧池 `bot:pool:ddz`（双读迁移）；
 *  - 其余玩法 = 自己的池。
 */
function poolKeysOf(gameType: GameType): string[] {
  return gameType === DEFAULT_GAME_TYPE
    ? [botPoolKey(DEFAULT_GAME_TYPE), botPoolKey(LEGACY_DDZ_GAME_TYPE)]
    : [botPoolKey(gameType)];
}

/** R201：`bot:{botId}` = String(JSON `BotInstance`)。 */
export const botKey = (botId: string): string => `bot:${botId}`;

/**
 * 幂等索引：`bot:room:{roomCode}`（Hash，`field = seat` → `botId`）。
 *
 * ⚠️ **执行期裁决**：§10.1 的键表里没有这个键。R201 要求 `acquire` **幂等**
 * （同一 `{roomCode, seat}` 重复调用必须返回**同一个** `BotInstance`，否则 A7⑤ 的重试
 * 会重复创建、把前一个变成孤儿），而 `bot:{botId}` 是「按 id 索引」的、无法反查
 * 「这个房间的这个座位是谁」。**唯一**不引入第二真源的做法就是这张座位→botId 的索引。
 * 它由 robot-service 独占写入，room-service 侧的 `room:{code}:bots`（R207）是另一张表
 * （供 `release` 用），两者语义不同、不互相读取。
 */
export const botRoomKey = (roomCode: string): string => `bot:room:${roomCode}`;

/**
 * R247（N21）：**绑定中**的反向视图 —— `bot:bound:{botId}`，String(JSON)
 * `{ roomCode, seat, boundAt }`，TTL 与房间一致（3600s）。
 *
 * ⚠️ **权威仍然是 `bot:{botId}`**（含 `roomCode`/`seat`/`idleSince`）：本键只用于
 * **发现候选**（「这个 bot 现在绑在哪个房间」的反查），判定「是否绑定 / 是否该回收」
 * 一律以 `bot:{botId}` 为准，并与它交叉核对（不一致就按权威走并清掉悬挂的视图）。
 * 与切片 11 给 `bot:room:*` 的地位相同：它是**视图**，不是第二个真源。
 *
 * 存在的理由（§9.6 的兜底回收）：`bot:pool:{gameType}` 是**空闲集合**（绑定中的机器人
 * `ZREM` 出池），因此「`release` 丢失、机器人一直绑定」这种机器人在池里**结构上扫不到**
 * （切片 11 登记的 N21）。有了这张反向索引，`reclaimIdle()` 才能第二轮扫到它。
 */
export const botBoundKey = (botId: string): string => `bot:bound:${botId}`;

/** `bot:bound:{botId}` 的内容（**视图**；权威见 `botKey`）。 */
export interface BotBoundView {
  roomCode: string;
  seat: number;
  boundAt: number;
}

/** `bot:bound:*` 前缀（SCAN 用；同时是「键 → botId」的唯一解析处）。 */
const BOT_BOUND_PREFIX = 'bot:bound:';

/**
 * §9.6 的机器人池：**创建/复用/绑定/归池/兜底回收**。
 *
 * 结构性的不变式（R201）：**池里的一定空闲** ——
 *  - 空闲（未被绑定）⇒ 在 `bot:pool:{gameType}` 里（`ZADD`，score = `idleSince`）；
 *  - 绑定中 ⇒ `ZREM` 出池。
 * 因此「从池里取出来的机器人一定没有房间」不需要额外校验。
 */
/**
 * 机器人池（§9.6 / §10.1）。**必须带 `@Injectable()`** —— 缺了它 Nest 会用
 * `new RobotPool()` **无参构造**，`this.redis` 静默变成 `undefined`（只在容器里炸：
 * `/api/robots/acquire` → 500），而单测因为都是手动 `new RobotPool(fakeRedis)` 而全绿。
 */
@Injectable()
export class RobotPool {
  private readonly logger = new Logger(RobotPool.name);

  /** 可注入的随机源（**仅测试**用；生产恒为 `Math.random`）。 */
  random: () => number = Math.random;

  constructor(
    private readonly redis: Redis,
    /**
     * 时钟（**仅测试**用）。
     *
     * ⚠️ `@Optional()` 不能省：带默认值的参数在 Nest 眼里仍是一个**待注入的依赖**
     * （它看不见默认值），而 `() => number` 没有对应 provider ⇒ 启动即崩
     * （与 `GAME_CLIENT` 的 `useClass` 同一个坑，见 R216/R217）。
     */
    @Optional()
    private readonly clock: () => number = () => Date.now(),
    /**
     * 片⑦ E3（design D3）：抽档比例的真源 —— `robot.skillDistribution` 经
     * `ConfigCacheService` 读快照（**下一次抽档生效**；旧 env `ROBOT_SKILL_DISTRIBUTION`
     * 已退役）。由 `RobotModule` → `ConfigCacheModule` 提供（进程内单例）。
     */
    private readonly configCache: ConfigCacheService,
  ) {}

  /**
   * §9.6 第 1/2 条：为 `seats` 里的**每个空缺座位**分配一个机器人，并把 `roomCode`/`seat`
   * **由 robot-service 写入**返回的 `BotInstance`（不是由调用方补）。
   *
   * **幂等**（R201）：同一 `{roomCode, seat}` 再次调用返回**同一个** bot
   * （`bot:room:{roomCode}` 的座位索引命中即复用），池计数不因此净增。
   * 复用顺序：本房间该座位已绑定 → 池中空闲（取 `idleSince` 最小者）→ 新建。
   */
  async acquire(
    roomCode: string,
    seats: number[],
    gameType: GameType = DEFAULT_GAME_TYPE,
  ): Promise<BotInstance[]> {
    const bots: BotInstance[] = [];
    for (const seat of [...seats].sort((a, b) => a - b)) {
      const bound = await this.findBound(roomCode, seat, gameType);
      if (bound) {
        bots.push(bound);
        continue;
      }
      const idle = await this.takeIdle(gameType);
      // 🔴 抽要在「复用 or 新建」之前 —— 池里捞回来的实例带着**上一局**的难度与基础手速（D2）
      const roll = this.roll();
      const fresh: BotInstance = idle
        ? {
            ...idle,
            gameType,
            skillLevel: roll.skillLevel,
            personality: { thinkingSpeed: roll.thinkingSpeed },
          }
        : this.createBot(roll, gameType);
      const assigned: BotInstance = { ...fresh, gameType, roomCode, seat, idleSince: undefined };
      await this.persist(assigned);
      await this.redis.hset(botRoomKey(roomCode), String(seat), assigned.botId);
      await this.redis.expire(botRoomKey(roomCode), BOT_ROOM_TTL_SECONDS);
      await this.bind(assigned.botId, roomCode, seat, gameType);
      this.logger.log(
        `Acquired ${gameType} bot ${assigned.botId} (${assigned.displayId}) for ${roomCode} seat ${seat}`,
      );
      bots.push(assigned);
    }
    return bots;
  }

  /**
   * §9.6 归池：`botId` 放回 `bot:pool:{gameType}` 并**清空** `roomCode`/`seat`，
   * 同时打上 `idleSince`（兜底回收的唯一判据）。
   *
   * 多玩法（Task 2.6 / D10）：玩法**从 bot 记录推导**（`bot.gameType ?? doudizhu`），
   * 不信任调用方 —— 房键过期时调用方可能拿不到 room.gameType。
   */
  async release(botIds: string[]): Promise<number> {
    let released = 0;
    for (const botId of botIds) {
      const bot = await this.get(botId);
      if (!bot) continue;
      const gameType = bot.gameType ?? DEFAULT_GAME_TYPE;
      // 先按**绑定时的** roomCode/seat 清索引，再清空绑定（顺序反了就拿不到座位号）
      if (bot.roomCode !== null && bot.seat !== null) {
        await this.redis.hdel(botRoomKey(bot.roomCode), String(bot.seat));
      }
      const idleSince = this.clock();
      await this.persist({ ...bot, gameType, roomCode: null, seat: null, idleSince });
      // 归池：两个视图**成对**出现（与 `acquire` 的 `bind()` 对称）——
      // `ZADD bot:pool:{gameType}`（池 = 空闲集合）与 `DEL bot:bound`（绑定视图消失）必须是
      // 同一次状态转移的两个投影，分开写在两处就又成了「第二真源」。
      // ⚠️ 规范池是**唯一写入目标**（旧 `bot:pool:ddz` 只读不写 —— D10）。
      await this.redis.zadd(botPoolKey(gameType), idleSince, botId);
      await this.redis.del(botBoundKey(botId));
      released += 1;
      this.logger.log(
        `Released ${gameType} bot ${botId} back to the pool (idleSince=${idleSince})`,
      );
    }
    return released;
  }

  /**
   * §9.6 的**兜底回收** —— 两轮（N21/R247）：
   *
   * **第一轮（§9.6 逐字）**：`bot:pool` 里 `idleSince` 早于 `now - 10min`、且 `roomCode`
   * 指向的房间**已不存在**的空闲机器人。
   *
   * **第二轮（N21 的核心）**：扫 `bot:bound:*`（**绑定中**的反向视图）。
   * 为什么必须有这一轮：`bot:pool` 是**空闲集合**（绑定中的机器人 `ZREM` 出池），
   * 所以「`release` 丢失、机器人一直绑定」这种机器人在池里**结构上扫不到** ——
   * 池那一轮**永远**看不见它。
   *
   * ⚠️ **对局中的机器人不得回收**（§9.6 逐字）：第二轮的判据仍是
   * `room:{roomCode}` **不存在**。`boundAt` 只用于**日志与交叉核对**，**不单独触发回收** ——
   * 一局可以打很久，而「房间还在 ⇒ 对局可能仍在进行」，用 `boundAt` 单独判会**误杀对局中
   * 的机器人**（本片计划 R247 的措辞与 §9.6 及它自己的正对照用例冲突，见执行期裁决 R261）。
   *
   * ⚠️ **权威是 `bot:{botId}`**：反向视图只用来**发现候选**，判定一律以 `bot:{botId}` 为准，
   * 不一致就按权威走并清掉/修正悬挂的视图。
   */
  async reclaimIdle(now: number = this.clock()): Promise<string[]> {
    const reclaimed = new Set<string>();

    // ── 第一轮：**所有玩法的池**里的空闲机器人（§9.6 的候选集；Task 2.6：pdk 也要收回）──
    // 旧 `bot:pool:ddz` 一并扫（存量机器人不得成为永久垃圾）。
    const poolKeys = [
      ...new Set([...GAME_TYPES.map((g) => botPoolKey(g)), botPoolKey(LEGACY_DDZ_GAME_TYPE)]),
    ];
    for (const poolKey of poolKeys) {
      const candidates = await this.redis.zrangebyscore(
        poolKey,
        '-inf',
        String(now - IDLE_RECLAIM_MS),
      );
      for (const botId of candidates) {
        const bot = await this.get(botId);
        if (bot && bot.roomCode !== null) {
          const roomExists = await this.redis.exists(`room:${bot.roomCode}`);
          if (roomExists) continue; // 房间还在 ⇒ 不得回收
        }
        await this.redis.zrem(poolKey, botId);
        await this.redis.del(botKey(botId));
        reclaimed.add(botId);
        this.logger.warn(`Reclaimed idle bot ${botId} from ${poolKey}`);
      }
    }

    // ── 第二轮：绑定中（`release` 丢失）的机器人（N21）─────────────────
    for (const key of await this.scanKeys(`${BOT_BOUND_PREFIX}*`)) {
      const botId = key.slice(BOT_BOUND_PREFIX.length);
      if (reclaimed.has(botId)) continue; // 两轮都命中时只算一次（不得重复删）

      const view = await this.readBoundView(key);
      if (!view) {
        // 坏数据 / 缺字段：视图本身不可信 ⇒ 清掉（下一个人不必再猜）
        await this.redis.del(key);
        this.logger.warn(`Dropped corrupt bound view ${key}`);
        continue;
      }

      const bot = await this.get(botId); // **权威**
      if (!bot) {
        // 权威记录没了 ⇒ 反向视图悬挂（机器人已被回收 / 记录被清）
        await this.redis.del(key);
        this.logger.warn(`Dropped dangling bound view ${key} (no bot record)`);
        continue;
      }
      if (bot.roomCode === null) {
        // 权威说它**空闲** ⇒ 视图悬挂（`release` 的 DEL 丢了）
        await this.redis.del(key);
        this.logger.warn(`Dropped bound view ${key}: authority says the bot is idle`);
        continue;
      }
      /** 权威里的房间号（`bot:{botId}`）：后面所有判定都用它，**不用视图里的那个**。 */
      const authorityRoom = bot.roomCode;
      if (bot.roomCode !== view.roomCode || bot.seat !== view.seat) {
        // 视图与权威不一致 ⇒ **按权威走**，并把视图修正过来（否则这条兜底下次又看见错误房间）
        this.logger.warn(
          `Bound view ${key} disagrees with the authority (view=${view.roomCode}/${view.seat}, ` +
            `bot=${bot.roomCode}/${bot.seat}) — following bot:${botId}`,
        );
        view.roomCode = authorityRoom;
        // 权威缺 seat（`null`）时保留视图里的座位号：视图可以不完全可信，
        // 但**不能**因为这个把「房间已不存在 ⇒ 该回收」的判定一起丢掉（下一段用的是 authorityRoom）。
        if (bot.seat !== null) view.seat = bot.seat;
        await this.redis.set(
          key,
          JSON.stringify(view),
          'EX',
          BOT_ROOM_TTL_SECONDS,
        );
      }

      const roomExists = await this.redis.exists(`room:${authorityRoom}`);
      if (roomExists) {
        // §9.6：**对局中的机器人不得回收**。绑得久只记 warn（`boundAt` 不单独触发回收）。
        const age = now - view.boundAt;
        if (age > IDLE_RECLAIM_MS) {
          this.logger.warn(
            `Bot ${botId} has been bound for ${age}ms in room ${authorityRoom}, but the room still ` +
              `exists — not reclaiming (§9.6: bots in a game must not be reclaimed)`,
          );
        }
        continue;
      }
      await this.redis.del(key);
      await this.redis.del(botKey(botId));
      reclaimed.add(botId);
      this.logger.warn(
        `Reclaimed bound bot ${botId} (the room ${authorityRoom} referenced by the view is gone; ` +
          `boundAt age=${now - view.boundAt}ms)`,
      );
    }

    return [...reclaimed];
  }

  /**
   * **绑定**：一次状态转移的**两个视图**必须在同一段代码里成对出现（R247）：
   *  ① `ZREM bot:pool:{gameType}` —— 池 = **空闲集合**（绑定中 ⇒ 出池）；
   *  ② `SET bot:bound:{botId} … EX 3600` —— 反向视图（让兜底回收看得见它）。
   *
   * ⚠️ `takeIdle()` 内部**也**会 `ZREM`（那是「取出」动作的一部分，还得顺手清悬挂成员）；
   * 这里再删一次是**幂等**的，换来的好处是「绑定」这件事的**两个投影写在一起**，
   * 读代码的人不必横跨两个函数才能确认它们成对。
   */
  private async bind(
    botId: string,
    roomCode: string,
    seat: number,
    gameType: GameType,
  ): Promise<void> {
    const view: BotBoundView = { roomCode, seat, boundAt: this.clock() };
    // 双读迁移：从旧 `bot:pool:ddz` 取出的机器人也必须从旧池移除。
    for (const key of poolKeysOf(gameType)) await this.redis.zrem(key, botId);
    await this.redis.set(botBoundKey(botId), JSON.stringify(view), 'EX', BOT_ROOM_TTL_SECONDS);
  }

  /** 解析反向视图；形状不对 ⇒ `null`（调用方负责清掉）。 */
  private async readBoundView(key: string): Promise<BotBoundView | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<BotBoundView>;
      if (
        typeof value.roomCode !== 'string' ||
        typeof value.seat !== 'number' ||
        typeof value.boundAt !== 'number'
      ) {
        return null;
      }
      return { roomCode: value.roomCode, seat: value.seat, boundAt: value.boundAt };
    } catch {
      return null;
    }
  }

  /** 游标式 `SCAN`（§7.3 偏差 A8：**任何**遍历都不得用 `KEYS`）。 */
  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  /** 读回一个机器人实例（不存在 ⇒ `null`）。 */
  async get(botId: string): Promise<BotInstance | null> {
    const raw = await this.redis.get(botKey(botId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BotInstance;
    } catch {
      this.logger.error(`Corrupt bot record for ${botId}`);
      return null;
    }
  }

  /** 池中**空闲**机器人清单（按玩法；斗地主含旧池双读）。 */
  async listIdle(gameType: GameType = DEFAULT_GAME_TYPE): Promise<BotInstance[]> {
    const ids = new Set<string>();
    for (const key of poolKeysOf(gameType)) {
      for (const botId of await this.redis.zrangebyscore(key, '-inf', '+inf')) ids.add(botId);
    }
    const bots: BotInstance[] = [];
    for (const botId of ids) {
      const bot = await this.get(botId);
      if (bot) bots.push(bot);
    }
    return bots;
  }

  /** 本房间已绑定的座位 → botId（幂等索引的读侧；玩法不符视为未绑定）。 */
  async findBound(
    roomCode: string,
    seat: number,
    gameType: GameType = DEFAULT_GAME_TYPE,
  ): Promise<BotInstance | null> {
    const botId = await this.redis.hget(botRoomKey(roomCode), String(seat));
    if (!botId) return null;
    const bot = await this.get(botId);
    // 索引有、记录没了（被回收/被清）⇒ 当作未绑定，否则会返回一个不存在的机器人
    if (!bot || bot.roomCode !== roomCode || bot.seat !== seat) return null;
    // 多玩法：同房同座的玩法必须一致（旧记录缺 gameType ⇒ doudizhu）。
    if ((bot.gameType ?? DEFAULT_GAME_TYPE) !== gameType) return null;
    return bot;
  }

  /**
   * 从池里取一个**空闲**机器人（取 `idleSince` 最小者）；池空 ⇒ `null`。
   *
   * ⚠️ **幽灵成员（索引有、记录无）不得吃掉池容量**（conformance agent 受控复现 +
   * 协调者独立复核的既有缺陷；键表见 §10.1）：
   *
   *  旧实现「**先 `zrem` 再 `get`**，`get` 为 `null` 就 `return null`」有两个后果：
   *   ① 那个成员**已经**被 `zrem` 掉了，但函数报「池空」⇒ 调用方 `createBot()` 新建
   *      ⇒ **容量净减**（现场实测：`ZCARD bot:pool:ddz` = 2，而两个成员的
   *      `EXISTS bot:<id>` 都是 0）；
   *   ② 与 `reclaimIdle()` 的**口径不一致**（那个会清悬挂）。
   *
   *  现在改成「**取到记录真实存在的成员为止**」：空记录 ⇒ `zrem` 清掉 ⇒ `continue`。
   *  循环上限 `MAX_TAKE_IDLE_SCAN` 是**防御性**的（池的成员数本就有上界；
   *  上限只用来保证病态数据下也不空转，取不到就当作池空）。
   */
  private async takeIdle(gameType: GameType = DEFAULT_GAME_TYPE): Promise<BotInstance | null> {
    const poolKeys = poolKeysOf(gameType);
    for (let scanned = 0; scanned < MAX_TAKE_IDLE_SCAN; scanned += 1) {
      let pickedKey: string | null = null;
      let botId: string | undefined;
      // 规范池优先、旧池兜底（斗地主双读）。
      for (const key of poolKeys) {
        const ids = await this.redis.zrangebyscore(key, '-inf', '+inf', 'LIMIT', 0, 1);
        if (ids[0]) {
          pickedKey = key;
          botId = ids[0];
          break;
        }
      }
      if (!pickedKey || !botId) return null;
      await this.redis.zrem(pickedKey, botId);
      const bot = await this.get(botId);
      // 悬挂成员（记录不存在 / 已损坏）⇒ 已 zrem，继续找下一个，**不要**当作池空
      if (!bot) {
        this.logger.warn(`Dropped dangling pool member ${botId} (no bot record)`);
        continue;
      }
      // 迁移：取出的机器人归入**请求的**玩法（旧 ddz 池成员 ⇒ doudizhu）。
      return { ...bot, gameType, roomCode: null, seat: null, idleSince: undefined };
    }
    this.logger.error(
      `takeIdle gave up after ${MAX_TAKE_IDLE_SCAN} dangling members — treating the pool as empty`,
    );
    return null;
  }

  /**
   * 池中空闲机器人数量（运维/conformance 用）。
   *
   * ⚠️ **不能直接用 `ZCARD`**：幽灵成员（索引有、记录无）会让它与 `listIdle()` 分叉
   * —— 索引层报 2、真实清单 0（这正是现场实测到的形态）。口径必须与 `takeIdle()`
   * 的「取到记录存在为止」一致，否则 conformance 的池检查判据会被幽灵**免疫**。
   *
   * ⚠️ 这里**只读不写**（不下 `zrem`）：它被当作观测接口用（`GET /api/robots/list`
   * 的诊断口径），清理是 `takeIdle()` / `reclaimIdle()` 的职责。
   */
  async poolSize(gameType: GameType = DEFAULT_GAME_TYPE): Promise<number> {
    const ids = new Set<string>();
    for (const key of poolKeysOf(gameType)) {
      for (const botId of await this.redis.zrangebyscore(key, '-inf', '+inf')) ids.add(botId);
    }
    let alive = 0;
    for (const botId of ids) {
      if (await this.get(botId)) alive += 1;
    }
    return alive;
  }

  /** 新建机器人：值**必须**由调用方抽好（`acquire` 的新绑定分支负责抽）。 */
  private createBot(
    roll: { skillLevel: SkillLevel; thinkingSpeed: number },
    gameType: GameType,
  ): BotInstance {
    const hex = uuidv4().replace(/-/g, '');
    return {
      botId: `bot-${hex.substring(0, 8)}`,
      displayId: `p_${hex.substring(8, 16)}`,
      skillLevel: roll.skillLevel,
      personality: { thinkingSpeed: roll.thinkingSpeed },
      roomCode: null,
      seat: null,
      gamesPlayed: 0,
      gameType,
    };
  }

  /** 抽一次：skillLevel（可配比例）+ 1–3s 基础手速（与难度无关）。**只在新建绑定时调用**。 */
  private roll(): { skillLevel: SkillLevel; thinkingSpeed: number } {
    const skillLevel = this.pickSkillLevel();
    const [min, max] = THINKING_SPEED_RANGE;
    return { skillLevel, thinkingSpeed: Math.floor(this.random() * (max - min)) + min };
  }

  /** §9.3 的难度分布（片⑦ E3：读 `ConfigCacheService` 的快照 —— 改键下一拍抽档生效）。 */
  private pickSkillLevel(): SkillLevel {
    const roll = this.random();
    const dist = this.configCache.skillDistribution();
    let cumulative = 0;
    let last: SkillLevel = dist[dist.length - 1][0];
    for (const [level, weight] of dist) {
      cumulative += weight;
      last = level;
      if (roll < cumulative) return level;
    }
    return last;   // 兜底 = 最后一档（**不是** 'beginner'：浮点残差不许静默塞给某一档）
  }

  private async persist(bot: BotInstance): Promise<void> {
    // `idleSince: undefined` 会被 `JSON.stringify` 丢掉 ⇒ 绑定中的记录**没有**该字段
    await this.redis.set(botKey(bot.botId), JSON.stringify(bot));
  }
}

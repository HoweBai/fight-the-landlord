// packages/room-service/src/rooms/rooms.service.ts
import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { DEFAULT_GAME_TYPE, ErrCode, GAME_META, isGameType, type GameType, type Seat } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';
import { ConfigCacheService } from '../config/config-cache.service';
import { claimSeat, readSeats, releaseSeat, cardCountKey, fillAtKey, nicknamesKey, roomBalancesKey, ccstateKey, seatsKey, startAttemptsKey, ROOM_TTL_SECONDS } from './rooms.seats';
import { MANUAL_ROOM_TIMEOUT_MS, WAITING_TIMEOUT_MS, manualFillDeadlineAt } from './rooms.timeout';

export type RoomStatus = 'waiting' | 'playing' | 'finished' | 'cancelled';
/**
 * ② 金币场 §2.1：内部房间形状的 mode **三值化**（`gold` 由匹配路径写入房间元数据——
 * 「选了金币场真的生效」的载体，结算守卫（T5）就是从它读 `mode === 'gold'`）。
 * ⚠️ **REST 建房是另一回事**：`rooms.dto.ts` 的枚举**保持二值**（practice-only，勿跟改）。
 */
export type RoomMode = 'random' | 'practice' | 'gold';

/** `room:{code}` 里**持久化**的元数据（R124：座位不在其中）。 */
export interface RoomMeta {
  code: string;
  mode: RoomMode;
  /**
   * 多玩法（Task 2.2 / spec §4.6.2）：过渡期可选 —— 旧 Hash 缺该字段读作 `doudizhu`
   *（不视为坏房）；新写入一律 `gameType ?? 'doudizhu'`。
   */
  gameType?: GameType;
  baseScore: number;
  /** 容量 = 该玩法/人数的座位数（旧房间 3；跑得快 2/3/4 —— spec D6）。 */
  maxPlayers: number;
  status: RoomStatus;
  createdAt: number;
  /** §3.1：`waiting` 状态的超时时刻（`waitingTimeoutAt()` 是唯一写入侧）。 */
  timeoutAt: number;
}

/** §3.1 的服务端内部形状：元数据 + **从 seats Hash 投影出来**的 `players`。 */
export interface Room extends RoomMeta {
  players: Seat[];
}

/** §3.1：`GET /api/rooms` 的列表项。**唯一**的对外房间形状。 */
export interface RoomInfo {
  code: string;
  mode: RoomMode;
  status: RoomStatus;
  /** **当前已占座位数**（旧客户端房态显示依赖它；容量看 `maxPlayers`）。 */
  playerCount: number;
  maxPlayers: number;
  baseScore: number;
  /** 多玩法（Task 2.2）：缺省语义 = doudizhu（旧客户端忽略新增字段）。 */
  gameType?: GameType;
}

/**
 * 「**只有还在 `waiting` 才取消**」的原子 CAS（本片 · spec §2 / R1002）。
 *
 * ⚠️ **必须原子**：`updateStatus()` 是「读 → 写」两步、中间有真实 `await` ⇒
 * 在「判 `waiting`」与「写 `cancelled`」之间，另一个定时器可以把房间推进到 `playing`
 *（`startRoom` 只认 `waiting`）⇒ 随后 `cancelled` 覆盖上去 ⇒ **房间变终态、玩家还坐在里面**。
 * ⚠️ 那**不是多实例专属**：同一进程的两个 `setInterval` 交错即可命中。
 *
 * 用 `EVAL` 的理由：Redis **单线程执行脚本** ⇒ 判与写在同一次往返内完成，中间插不进别的命令。
 *
 * ⚠️ 只改 `status` 与 `timeoutAt` 两格 —— 与 `updateStatus()` 离开 `waiting` 时改的**是同一对**
 *（`{...room, status, timeoutAt}` 在 `status !== 'waiting'` 时只有这两格变化）
 * ⇒ §10.1 的 `META_FIELDS` **恰好八个**不受影响（不是重写整张 Hash）。
 */
export const CANCEL_IF_WAITING_LUA = `
if redis.call('HGET', KEYS[1], 'status') == 'waiting' then
  redis.call('HSET', KEYS[1], 'status', 'cancelled')
  redis.call('HSET', KEYS[1], 'timeoutAt', '0')
  return 1
end
return 0
`;

/** 内部 Room → 对外 RoomInfo（§6.4 的同类裁剪思路：只出该出的字段）。 */
export function toRoomInfo(room: Room): RoomInfo {
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    playerCount: room.players.length,
    maxPlayers: room.maxPlayers,
    baseScore: room.baseScore,
    // 旧房间（读作 doudizhu）也显式出站：新客户端据此选 board；
    // 旧客户端忽略新增字段（D16）。
    gameType: room.gameType ?? DEFAULT_GAME_TYPE,
  };
}

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);
  private readonly redis: Redis;
  /** ⚠️ 可注入（R914）：判据要断言**具体时刻/随机值**时注入，否则那类判据不可判。 */
  private clock: () => number = () => Date.now();
  private random: () => number = () => Math.random();

  constructor(
    redis: Redis,
    /**
     * 片⑦ T7：底分档位表经 **`ConfigCacheService`**（进程内快照缓存，T6 落地）读 ——
     * 缓存非空（哪怕旧）一律用缓存；**仅缓存为空的窗口内**才触发一次即时 RPC 拉取
     *（design D2 的失败语义分层；与旧「每次 RPC」的差异已在缓存类注释里显式登记）。
     * ⚠️ **值导入**（不是 `import type`）：`emitDecoratorMetadata` 需要运行期的类引用，
     * 类型导入会在容器解析依赖时变成 `Object` ⇒ 启动即崩（本仓已知的 DI 陷阱）。
     */
    private readonly configCache: ConfigCacheService,
  ) {
    this.redis = redis;
    this.logger.log('Connected to Redis');
  }

  /** 注入时钟（照 `MatchService.setClock()` 的成例；测试用）。 */
  setClock(clock: () => number): void {
    this.clock = clock;
  }

  /**
   * 当前时刻（**读注入的时钟**）。
   *
   * ⚠️ 扫描器**不得**自己 `Date.now()`：本片所有时间判据（死线）都建立在
   * 「谁读时刻谁就得能被注入」之上，否则「死线落在 20–30 秒」这类判据不可判（R914）。
   */
  now(): number {
    return this.clock();
  }

  /** 注入随机源（R914；测试用 —— 补位死线是「20s + rand[0,10s)」，不注入就判不了具体值）。 */
  setRandom(random: () => number): void {
    this.random = random;
  }

  /**
   * §7.3 偏差 A8：**禁止 `KEYS`**（它会阻塞 Redis 单线程），改用游标式 `SCAN`。
   *
   * 同时排除 `room:{code}:cardcount` / `room:{code}:seats` 这类派生键：
   * `MATCH room:*` 会把它们一并扫出来。
   */
  async findAll(): Promise<Room[]> {
    // §7.3：终态（`cancelled`）房间**不进对外列表**。
    // ⚠️ **回收任务不得建在 `findAll()` 上**（N31/R523 执行期发现）：`cancelled` 会被这里滤掉
    //    ⇒ 回收方永远扫不到它，而它对外**不可见**、只能等 `EXPIRE 3600` ⇒ 一旦有房间被
    //    `updateStatus('cancelled')`，它就是**隐形**的堆积源。回收请用 `listForReap()`。
    return (await this.scanAllRooms()).filter((room) => room.status !== 'cancelled');
  }

  /**
   * **N31 / R523**：回收任务的枚举入口 —— **包含** `cancelled`（与 `findAll()` 的唯一差别）。
   *
   * 维护类代码走这里；对外 API 走 `findAll()`。两者共用 `scanAllRooms()` 这一份扫描实现
   * ⇒ 不会出现「两份遍历逻辑各自漂移」（本仓为「第二真源」付过多次代价）。
   */
  async listForReap(): Promise<Room[]> {
    return this.scanAllRooms();
  }

  /**
   * 扫出**全部**房间（含 `cancelled`）—— `findAll()` / `listForReap()` 的唯一底层实现。
   *
   * 排除 `room:{code}:seats` / `room:{code}:cardcount` 这类**派生键**（`MATCH room:*` 会把它们
   * 一并扫出来）；元数据损坏的房间直接跳过（`readMeta` 记 error 并返回 null）。
   */
  private async scanAllRooms(): Promise<Room[]> {
    const rooms: Room[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'room:*', 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        // 排除 room:{code}:cardcount / room:{code}:seats 这类派生键
        if (key.slice('room:'.length).includes(':')) continue;
        const meta = await this.readMeta(key.slice('room:'.length));
        if (!meta) continue;
        rooms.push({ ...meta, players: await readSeats(this.redis, meta.code) });
      }
    } while (cursor !== '0');
    return rooms;
  }

  /**
   * 建房。
   *
   * ⚠️ **`timeoutMs` 是入参**（本片 · R913）：本方法被**两条路径共用** ——
   * `POST /api/rooms`（手动房）与匹配的 `createGameRoom`。手动房的回收窗口要**更宽**
   *（`MANUAL_ROOM_TIMEOUT_MS`：补位死线上界 + 10 秒）才能让补位不被回收贴脸删掉。
   * **缺省**保持 `WAITING_TIMEOUT_MS` ⇒ 匹配路径的现状一字不变。
   */
  async create(
    dto: {
      mode: RoomMode;
      roomCode?: string;
      baseScore?: number;
      /** 多玩法（Task 2.2）：缺省 = doudizhu。 */
      gameType?: GameType;
      /** 缺省 = `GameMeta[gameType].defaultPlayerCount`（ddz 3 / pdk 3）。 */
      playerCount?: number;
    },
    options: { timeoutMs?: number } = {},
  ): Promise<Room> {
    const gameType = dto.gameType ?? DEFAULT_GAME_TYPE;
    const playerCount = dto.playerCount ?? GAME_META[gameType].defaultPlayerCount;
    /**
     * 多玩法（Task 2.2 / D9/D16）：玩法开放与人数闸由 **room-service** 判定
     *（protocol 校验器拿不到配置）⇒ 统一 `12012 GAME_UNAVAILABLE`。
     * 放在档位读取**之前**：关着的玩法不得因为档位表故障被报成 10007。
     */
    if (!this.configCache.gameEnabled(gameType)) {
      throw new DomainError(ErrCode.GAME_UNAVAILABLE, '该玩法暂未开放');
    }
    if (!this.configCache.supportsRoomPlayerCount(gameType, playerCount)) {
      throw new DomainError(ErrCode.GAME_UNAVAILABLE, '该玩法暂不支持该人数');
    }
    // 片规格 §2.4 协议⑤：底分**必须属于档位表**（多玩法 D8：按玩法取表）。
    // 🔴 **拿不到档位表就失败，绝不静默放行** —— 否则非法值直接绕过校验。
    // 2026-10-21：省略 baseScore 也读表 —— 缺省 = 表内**数值最小档**（不再有代码常量）。
    let levels: { name: string; baseScore: number }[];
    try {
      // 片⑦ T7：来源从 `ConfigClient.levels()`（每次 RPC）换成配置缓存
      //（`baseScoreLevels()`）—— **catch 块与 10007 翻译逐字不动**（T6 结转的硬义务③）。
      levels = await this.configCache.baseScoreLevels(gameType);
    } catch (err) {
      // 🔴 **读不到 ≠ 没有档位**：原样抛 `ConfigServiceError` 会让 HTTP 面经
      // `toHttpException()` 的「未知错误 ⇒ `10001`」分支变成 400/10001，而片规格 §2.4
      // 明写这条路径的码是 **`10007 UPSTREAM_UNAVAILABLE`** 且**请求失败**
      // ⇒ 在这里翻成领域错误（controller 照 §11.2 的码表映射成 503）。
      //
      // 🔴 **详情只进日志，绝不进消息**（Task 3g 修复 I1）：`toHttpException` 把
      // `DomainError.message` **原样**透给客户端（`http/errors.ts:40`），WS 面的
      // DomainError 分支同样照实 ack（`message.router.ts`）⇒ 内插 `err.message` 就是
      // 把 `user-service unavailable: connect ECONNREFUSED 172.28.0.9:3100` 这类
      // **下游异常文本**当业务文案发给玩家。消息给**固定的一句面向调用方的话** ——
      // 与 `MatchService.assertKnownBaseScore`（同一次读的另一条路径）**逐字同句**。
      this.logger.warn(
        `Base score levels unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new DomainError(ErrCode.UPSTREAM_UNAVAILABLE, '底分档位表不可用');
    }
    // room 侧 `readLevels()` 不校验元素；min 推导前必须自证。位置在成员校验**之前**：
    // 「显式值 + 坏表」也按表不可用处置（10007），而不是报成客户端传错（10001）。
    // 显式查 null/空表：直改库可能写出 [null] 或 []（写入口之外），既要避免
    // `l.baseScore` 抛 TypeError（会落到 10001），也要避免 `Math.min(...[]) = Infinity`。
    const wellFormed =
      levels.length > 0 &&
      levels.every(
        (l) => l !== null && typeof l === 'object' && Number.isInteger(l.baseScore) && l.baseScore > 0,
      );
    if (!wellFormed) {
      this.logger.warn(`Base score levels malformed: ${JSON.stringify(levels)}`);
      throw new DomainError(ErrCode.UPSTREAM_UNAVAILABLE, '底分档位表不可用');
    }
    if (dto.baseScore !== undefined && !levels.some((l) => l.baseScore === dto.baseScore)) {
      throw new DomainError(ErrCode.BAD_PARAM, '底分不属于档位表');
    }

    const code = dto.roomCode ?? this.generateCode();
    // `createdAt` 与 `timeoutAt` **必须**来自同一个 `now`（同一个 `this.clock()`）：
    // 两次取时刻会让 `timeoutAt - createdAt` 抖动，判据就不可判了。
    const now = this.clock();
    const meta: RoomMeta = {
      code,
      mode: dto.mode,
      gameType,
      baseScore: dto.baseScore ?? Math.min(...levels.map((l) => l.baseScore)),
      maxPlayers: playerCount,
      status: 'waiting',
      createdAt: now,
      timeoutAt: now + (options.timeoutMs ?? WAITING_TIMEOUT_MS),
    };
    await this.writeMeta(meta);
    this.logger.log(`Room ${code} created`);
    return { ...meta, players: [] };
  }

  /**
   * §10.2 / C11：入座**必须原子**（`HSETNX`），**禁止 `GET` → 改 → `SET`**。
   *
   * 检查顺序固定（R127）：房间存在（`12001`）→ 未开局（`12008`）→ 占座（满 ⇒ `12002`）。
   * 同一 `userId` 重复入座是幂等的（R126，`claimSeat` 内部处理），返回原座位。
   */
  async join(code: string, userId: string, gameType: GameType = DEFAULT_GAME_TYPE): Promise<Room> {
    const room = await this.findOne(code);
    if (!room) throw new DomainError(ErrCode.ROOM_NOT_FOUND, '房间不存在');
    if (room.status !== 'waiting') throw new DomainError(ErrCode.ROOM_ALREADY_STARTED, '游戏已开始');
    /**
     * 多玩法（Task 2.2 / D16 / RB1）：**占座之前**校验玩法 —— 旧客户端（缺省 doudizhu）
     * 进跑得快房 ⇒ `12012`，且**一个座位都不占**（否则旧客户端会占着 pdk 的座却渲染不了）。
     */
    if ((room.gameType ?? DEFAULT_GAME_TYPE) !== gameType) {
      throw new DomainError(ErrCode.GAME_UNAVAILABLE, '房间玩法与客户端不符');
    }

    const claimed = await claimSeat(this.redis, code, userId, false, room.maxPlayers);
    if (!claimed) throw new DomainError(ErrCode.ROOM_FULL, '房间已满');

    this.logger.log(`User ${userId} joined room ${code} at seat ${claimed.seat}`);
    return { ...room, players: await readSeats(this.redis, code) };
  }

  async findOne(code: string): Promise<Room | null> {
    const meta = await this.readMeta(code);
    if (!meta) return null;
    return { ...meta, players: await readSeats(this.redis, code) };
  }

  /**
   * 退房**腾座位**（本片 · spec §3.5 / R906）—— `join` 的对称操作。
   *
   * **为什么必须有它**：本片引入「满即开局 / 不足则补机器人」之后，漏座的 `3/3` 房间
   * **永远开不了局**（满分支不触发：人早走了；不足分支也不触发：座位数说满了）。
   * 而 MVP **没有踢人**（`12005` 是保留码）⇒「自己退房」是唯一的离开方式 ⇒ 它必须能腾座位。
   *
   * ⚠️ **只在 `waiting` 时腾**（R916）：`playing`/`finished` 的对局里，玩家退出**不得**动座位
   * —— 座位的真源是对局，动它会让 `game-service` 的座位映射与 `room.players` **分叉**
   *（R124 亲口警告的那种漂移）。对局中的离开维持现状：座位留着、对局继续。
   *
   * ⚠️ **幂等**（R126 同族）：没坐过 / 已经走了 ⇒ 无声返回，不抛。
   */
  async leaveSeat(code: string, userId: string): Promise<Room> {
    const room = await this.findOne(code);
    if (!room) throw new DomainError(ErrCode.ROOM_NOT_FOUND, '房间不存在');
    if (room.status !== 'waiting') return room; // R916：对局中不动座位

    const mine = room.players.find((p) => p.userId === userId);
    if (mine) {
      // 座位号取自权威座位表（R128），不推导
      await releaseSeat(this.redis, code, mine.seat, userId);
      this.logger.log(`User ${userId} left seat ${mine.seat} in room ${code}`);
    }
    return { ...room, players: await readSeats(this.redis, code) };
  }

  /**
   * 读 / 写**补位死线**（本片 · spec §3.1 / R904b）。
   *
   * ⚠️ 落派生键而非元数据字段：§10.1 的 `META_FIELDS` 恰好八个，加字段会让 `readMeta`
   * 把它当坏数据。⚠️ TTL 与房间一致（3600s）—— 它与 `seats` / `cardcount` 同为派生物。
   */
  async setFillDeadline(code: string, at: number): Promise<void> {
    const key = fillAtKey(code);
    await this.redis.set(key, String(at), 'EX', ROOM_TTL_SECONDS);
  }

  /** 没写过 ⇒ `null`（**不是** 0、也不抛）—— 「还没抽过死线」是一个合法状态。 */
  async readFillDeadline(code: string): Promise<number | null> {
    const raw = await this.redis.get(fillAtKey(code));
    return raw === null ? null : Number(raw);
  }

  /**
   * **占用变化 ⇒ 重置等待窗口**（本片 · spec §3.1 / R904）。
   *
   * 入座 / 退座都调它：`timeoutAt` 与补位死线都以「**最后一次占用变化**」为原点重算。
   * 不重置的话，房主建完房、挑个玩法、想两秒 —— 窗口已经跑掉一大半，「等人」的名不副实。
   *
   * ⚠️ **`createdAt` 不动**（`writeMeta` 收的是整个 `Room`）：它要留在**建房**那一刻。
   * 代价是重置过的房间 `timeoutAt - createdAt > 窗口本身`（这里是 **刻意**的，不是笔误）——
   * 两者的语义不同：`createdAt` 是「这房什么时候建的」，`timeoutAt` 是「等到什么时候为止」。
   *
   * ⚠️ **`playing` 一律跳过**（R916）：离开 `waiting` 时 `timeoutAt` 已归零表示「窗口已关闭」，
   * 复活它是 E6 明文禁止的。
   */
  async resetWaitingWindow(code: string): Promise<void> {
    const room = await this.findOne(code);
    if (!room) return; // 房间没了：无声返回（调用方是「玩家进出」这类不该因此报错的路径）
    if (room.status !== 'waiting') return;

    const now = this.clock();
    await this.writeMeta({ ...room, timeoutAt: now + MANUAL_ROOM_TIMEOUT_MS });
    await this.setFillDeadline(code, manualFillDeadlineAt(now, this.random));
  }

  /**
   * **只有还在 `waiting` 才取消**（原子 CAS）—— 脚本与理由见 `CANCEL_IF_WAITING_LUA`。
   *
   * @returns 真的取消了 ⇒ `true`；房间不在 / 已不是 `waiting` ⇒ `false`（**都不抛** ——
   * 调用方是「补位失败」的降级路径，那条路上不该再抛）
   */
  async cancelIfStillWaiting(code: string): Promise<boolean> {
    const result = await this.redis.eval(CANCEL_IF_WAITING_LUA, 1, `room:${code}`);
    return Number(result) === 1;
  }

  async updateStatus(code: string, status: RoomStatus): Promise<Room> {
    const room = await this.findOne(code);
    if (!room) throw new DomainError(ErrCode.ROOM_NOT_FOUND, '房间不存在');
    // E6：离开 `waiting` 即「等待窗口已关闭」⇒ `timeoutAt` 归零，免得读侧拿一个
    // 已经过去的时刻去判 `isWaitingExpired`（状态本身已是判据，但留一个过期时刻
    // 会让人误以为这个房间「正在超时」）。
    const next: Room = { ...room, status, timeoutAt: status === 'waiting' ? room.timeoutAt : 0 };
    await this.writeMeta(next);
    return next;
  }

  /**
   * **N31 / R523**：回收一个房间 —— 删 `room:{code}` **及其派生键**（§10.1）。
   *
   * ⚠️ **五个键必须一起删**：只删主键会留下 `room:{code}:seats` / `room:{code}:cardcount` /
   * `room:{code}:fillat` / `room:{code}:balances` 四个**孤儿** —— `findAll()`（A8）刻意排除了
   * 带 `:` 的键，所以它们**看不见也回收不到**，而 `claimSeat` 甚至还能往一个「已不存在的房间」里占座。
   * 唯一的兜底是各自的 `EXPIRE`（3600s）。
   * ⚠️ **幂等**：房间本来就不存在时 `DEL` 只返回 0，不抛 —— 回收任务必须能重复跑。
   * ⚠️ `room:{code}:bots`（R207 的绑定表）**不在**删除集里（它由归池在局终显式清、自带 TTL 兜底，
   * 与 `rooms.reaper.test.ts` 的 W3 判据口径一致）—— 本方法**不动**它。
   */
  async deleteRoom(code: string): Promise<void> {
    await this.redis.del(
      `room:${code}`,
      seatsKey(code),
      cardCountKey(code),
      fillAtKey(code),
      roomBalancesKey(code),
      nicknamesKey(code),
      ccstateKey(code),
      // 多玩法 Task 2.2 / spec RH3-d：开局重试预算键随房回收（否则留孤儿）。
      startAttemptsKey(code),
    );
  }

  /** §9.6 第 3 条：机器人也走**同一个**原子占座入口（`isRobot: true`，`userId` 暂为真实 `bot-*` id）。 */
  async addBot(roomCode: string, botId: string): Promise<Room> {
    const room = await this.findOne(roomCode);
    if (!room) throw new DomainError(ErrCode.ROOM_NOT_FOUND, '房间不存在');

    const claimed = await claimSeat(this.redis, roomCode, botId, true, room.maxPlayers);
    if (!claimed) throw new DomainError(ErrCode.ROOM_FULL, '房间已满');

    return { ...room, players: await readSeats(this.redis, roomCode) };
  }

  /**
   * §10.1：`room:{code}` 是 **Hash**（N9），字段**恰好**这八个（Task 2.2 起含 `gameType`）。
   *
   * 这张表同时驱动 `writeMeta`（落盘哪些字段）与 `readMeta`（字段集校验），
   * 因此**不存在**「写多了一个字段」或「读少了一个字段」的漂移面。
   */
  private static readonly META_FIELDS = [
    'code',
    'mode',
    'gameType',
    'baseScore',
    'maxPlayers',
    'status',
    'createdAt',
    'timeoutAt',
  ] as const satisfies ReadonlyArray<keyof RoomMeta>;

  /**
   * **旧房间兼容**（spec §4.6.2 / N3-a）：`gameType` 是部署窗口里唯一允许缺失的字段 ——
   * 缺/非法（含历史写回的字符串 `"undefined"`）一律读作 `doudizhu` + WARN，
   * **不得**让等待中的旧房间变成 `null`（列表消失、join 12001）。
   */
  private static readonly OPTIONAL_META_FIELDS = ['gameType'] as const;

  /**
   * 元数据写回（**一次 `HSET` 全字段**，不做逐字段读-改-写 —— C11 的教训）。
   *
   * ⚠️ **绝不**把 `players` 写进元数据（R124）：座位的真源是 `room:{code}:seats`，
   * 两处都存就必然出现「Hash 说 3 人、Hash 说 2 人」的漂移，而并发场景下漂移是**必现**的。
   * 字段由 `META_FIELDS` 机械枚举，因此调用方传进来的 `Room`（含 `players`）**不可能**
   * 悄悄多写一个字段。
   *
   * ⚠️ **必须**显式补 `EXPIRE`：String 时代是 `SET ... EX 3600`（一次调用带 TTL），
   * 而 `HSET` **不会**给键设任何 TTL —— 漏掉它 §10.1 的 3600s 就静默丢了
   * （房间键永不回收）。这是本次 Hash 化最容易踩的坑。
   */
  private async writeMeta(source: RoomMeta): Promise<void> {
    const key = `room:${source.code}`;
    const flat: Record<string, string> = {};
    for (const field of RoomsService.META_FIELDS) {
      // 过渡期可选字段：**不得**把 `undefined` 写成字符串 `"undefined"`（N3-a）——
      // 缺失语义 = doudizhu，落盘也一样。
      flat[field] = field === 'gameType' ? (source.gameType ?? DEFAULT_GAME_TYPE) : String(source[field]);
    }
    await this.redis.hset(key, flat);
    await this.redis.expire(key, ROOM_TTL_SECONDS);
  }

  /**
   * 元数据读回（§10.1：Hash 里**全部**是字符串 ⇒ 这里逐字段 `Number(...)` 还原类型）。
   *
   * 字段集**恰好**是 `META_FIELDS`：缺字段/多字段一律当作坏数据（记 error 并返回 `null`，
   * 与 `readSeats` 的「坏数据不得把服务打崩」同一策略）。
   */
  private async readMeta(code: string): Promise<RoomMeta | null> {
    const key = `room:${code}`;
    const flat = await this.redis.hgetall(key);
    if (Object.keys(flat).length === 0) return null; // 键不存在
    const optional = new Set<string>(RoomsService.OPTIONAL_META_FIELDS);
    const missing = RoomsService.META_FIELDS.filter((field) => !optional.has(field) && !(field in flat));
    if (missing.length > 0) {
      this.logger.error(`Corrupt room metadata ${key}: missing ${missing.join(',')}`);
      return null;
    }
    // 多玩法（N3-a）：缺/非法 `gameType`（含字符串 "undefined"）⇒ doudizhu + WARN。
    let gameType: GameType = DEFAULT_GAME_TYPE;
    if (flat.gameType !== undefined) {
      if (isGameType(flat.gameType)) {
        gameType = flat.gameType;
      } else {
        this.logger.warn(
          `Corrupt room metadata ${key}: invalid gameType ${JSON.stringify(flat.gameType)} — treating as doudizhu`,
        );
      }
    }
    return {
      code: flat.code,
      mode: flat.mode as RoomMode,
      gameType,
      baseScore: Number(flat.baseScore),
      maxPlayers: Number(flat.maxPlayers),
      status: flat.status as RoomStatus,
      createdAt: Number(flat.createdAt),
      timeoutAt: Number(flat.timeoutAt),
    };
  }

  /**
   * §3.1：6 位大写 base36 房间号。
   *
   * ⚠️ **必须 `padEnd(6, '0')`**（对账表 N8）：`Math.random()` 的 base36 表示可能很短
   * （恰为 `0` 时是 `"0"`，`0.5` 时是 `"0.i"`），`substring(2, 8)` 于是返回**空串/1~5 个字符**，
   * 而网关对路径参数有形状闸 `/^[0-9A-Z]{6}$/`（P0/R72）⇒ 这样的房间号**永远进不去**（被判 `10001`）。
   */
  private generateCode(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase().padEnd(6, '0');
  }

  /**
   * 匹配成功后建局：人类按传入顺序原子坐 0…n-1（§8.2）。
   *
   * 🔴 片规格 §2.4：`baseScore` **随队列进来**（匹配键的第三段）—— 它是
   * 「选了底分真的生效」这条链的起点（房间元数据 → `game.start` → 结算）。
   * 校验由 `create()` 统一承担（不属于档位表 ⇒ `10001`）。
   */
  async createGameRoom(
    playerIds: string[],
    mode: RoomMode,
    baseScore: number,
    /** 多玩法（Task 2.2）：缺省 ddz/3（既有调用零改动；Task 2.3/2.4 起由匹配维度传入）。 */
    gameType: GameType = DEFAULT_GAME_TYPE,
    playerCount?: number,
  ): Promise<Room> {
    const room = await this.create({ mode, baseScore, gameType, playerCount });
    for (const playerId of playerIds) {
      const claimed = await claimSeat(this.redis, room.code, playerId, false, room.maxPlayers);
      if (!claimed) throw new DomainError(ErrCode.ROOM_FULL, '房间已满');
    }
    const players = await readSeats(this.redis, room.code);
    this.logger.log(
      `Game room ${room.code} created with ${players.length} players (mode: ${mode}, baseScore: ${baseScore})`,
    );
    return { ...room, players };
  }
}

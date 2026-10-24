import type Redis from 'ioredis';
import type { Seat } from '@fight-the-landlord/protocol';

/**
 * §10.1：房间座位 Hash。`field = seat`（'0'|'1'|'2'）→ value = JSON `Seat`。
 *
 * ℹ️ 字段名是**座位号**而不是 `userId`（R125）—— 只有 `maxPlayers` 个可能取值，
 * 因此 `HLEN` 天然 ≤ `maxPlayers`，「检查人数 + 占座」不需要是两次操作。
 */
export function seatsKey(code: string): string {
  return `room:${code}:seats`;
}

/**
 * §10.1：房间的「三家手牌张数」**派生键**。`field = userId` → value = 张数（字符串）。
 *
 * **N35 / R521**：写入方就是 **room-service 自己** —— 它本来就收到 `game:events` 的
 * `seatViews[].cardCounts`（权威口径），因此**不需要**让 `game-service` 去写别人的键。
 * 读方是 `message.router.ts` 的 `buildRoomPlayers()`（§6.4 规则 3 的 `cardCount?`）。
 * ⚠️ 键名是**单一真源**：读写两侧都必须经这个函数 —— N35 的原始缺陷正是「**有读无写**」，
 * 而当时两侧各自内联拼字符串，谁也发现不了对面不存在。
 */
export function cardCountKey(code: string): string {
  return `room:${code}:cardcount`;
}

/** §10.1：房间相关键的 TTL（与 `room:{code}` 的 3600s 一致）。 */
export const ROOM_TTL_SECONDS = 3600;

/**
 * ② 金币场 T5：**开局三座余额**的派生键 `room:{code}:balances`（`field = seat` → 余额字符串）。
 *
 * 写入方 = `RoomStartService.storeGoldBalances()`（仅金币场开局时对三座做一次
 * `currency.get`；**读失败 ⇒ 不写键** = 省略字段，不阻塞开局）；读方 =
 * `message.router.ts` 的 `buildRoomPlayers()`（`RoomPlayer.balance?` —— 免费场/好友房
 * 无此键 ⇒ 字段永不出现，整场统一「—」的不可区分性红线靠它成立）。
 *
 * ⚠️ 键名是**单一真源**（同 `cardCountKey`：读写两侧各自内联拼字符串就是 N35 那类
 * 「有读无写」缺陷的温床）；⚠️ 它必须进 `deleteRoom` 的删除集（否则回收后留孤儿键）。
 */
export function roomBalancesKey(code: string): string {
  return `room:${code}:balances`;
}

/**
 * 记牌器收费片：本局开通状态的派生键 `room:{code}:ccstate`（`field = seat` →
 * JSON `{ active, source? }`）。写入方 = `RoomStartService` 状态块；读方 = 重连/重发补推。
 *
 * ⚠️ **刻意不叫 `cardcounter`**（与既有的 `cardcount` 只差一个词 —— 手误会污染三家手牌
 * 张数的 Hash）。⚠️ 必须进 `deleteRoom` 的删除集（TTL 与房间一致）。
 */
export function ccstateKey(code: string): string {
  return `room:${code}:ccstate`;
}

/**
 * 昵称片：`field = userId` → 昵称（空串 = **已知无昵称**的哨兵，避免存量用户每次
 * 状态推送都重查）。TTL 与房间一致；`deleteRoom` 必须一并删除。
 */
export function nicknamesKey(code: string): string {
  return `room:${code}:nicknames`;
}

/**
 * 昵称分配短锁（2026-10-22 机器人拟人昵称片）：
 * `SET room:{code}:botnames:lock <token> EX 3 NX`。
 *
 * - 只包住「读昵称 Hash → 分配 → HSETNX」，不包开局全流程；
 * - `deleteRoom` **不删**该键（它不是房间派生数据），靠 3s TTL 自动过期；
 * - 锁失败是 fail-open：昵称缺失回落「玩家N」，不阻塞开局。
 */
export function botNamesLockKey(code: string): string {
  return `room:${code}:botnames:lock`;
}

/**
 * **补位死线**（本片 · spec §3.1 / R904b）：派生键 `room:{code}:fillat`，值是**毫秒时间戳**。
 *
 * ⚠️ 为什么不是元数据 Hash 的一个字段：§10.1 的 `META_FIELDS` **恰好七个**，
 * 加字段会让 `readMeta` 把它当坏数据。⇒ 走派生键（与 `seats` / `cardcount` 同形）。
 *
 * ⚠️ 为什么要落盘：每轮扫描现抽会让同一个房间的死线**漂移**
 *（玩家等多久取决于它被扫到几次），判据也不可判。
 */
export function fillAtKey(code: string): string {
  return `room:${code}:fillat`;
}

/**
 * 开局重试预算（Task 2.4 / spec RH3-d）：派生键 `room:{code}:start_attempts`，值是
 * INCR 计数（成功开局/重试预算耗尽后随房回收）。
 *
 * ⚠️ 为什么落派生键而不是 `RoomMeta` 字段：§10.1 的 `META_FIELDS` 是**机械闸**（恰好
 * 那几个字段），加字段会让 `readMeta` 把它当坏数据。
 * ⚠️ **必须进 `deleteRoom` 的删除集**（RH3-d），否则回收后留孤儿键。
 */
export function startAttemptsKey(code: string): string {
  return `room:${code}:start_attempts`;
}

/** 形状校验：非法 JSON / 缺字段一律当作**没有这个座位**，绝不让坏数据把服务打崩。 */function parseSeat(raw: string | null): Seat | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<Seat>;
    if (
      typeof value.userId !== 'string' ||
      typeof value.seat !== 'number' ||
      typeof value.isRobot !== 'boolean'
    ) {
      return null;
    }
    return { userId: value.userId, seat: value.seat, isRobot: value.isRobot };
  } catch {
    return null;
  }
}

/**
 * §10.2：**原子**占座（C11 的修复点）。
 *
 * 顺序尝试 `HSETNX` 座位 0…maxPlayers-1：`HSETNX` 是 Redis 单命令原子操作，
 * **不存在**「读到空位 → 别人也读到 → 两人都写」的窗口 —— 这正是旧实现
 * `GET → push → SET` 的缺陷（并发 20 路实测：20 人全部"成功"，房间里只剩 1 人）。
 *
 * 幂等（R126）：`HSETNX` 失败后回读该座位，若已属于同一个 `userId` 就返回它。
 * 这一读**不是**读改写：它不参与写入决定，只用于「我是不是已经坐下了」。
 *
 * ⚠️ 座位字段**不得**用 `HSET` 写（无条件覆盖 ⇒ 会顶掉别人已占的座位）。
 */
export async function claimSeat(
  redis: Redis,
  code: string,
  userId: string,
  isRobot: boolean,
  maxPlayers: number,
): Promise<Seat | null> {
  const key = seatsKey(code);
  for (let seat = 0; seat < maxPlayers; seat += 1) {
    const claimed = await redis.hsetnx(key, String(seat), JSON.stringify({ userId, seat, isRobot }));
    if (claimed === 1) {
      await redis.expire(key, ROOM_TTL_SECONDS);
      return { userId, seat, isRobot };
    }
    const occupant = parseSeat(await redis.hget(key, String(seat)));
    if (occupant?.userId === userId) return occupant;
  }
  return null;
}

/** 读回座位（**按 `seat` 升序** —— Hash 字段顺序不是契约，R128）。 */
export async function readSeats(redis: Redis, code: string): Promise<Seat[]> {
  const raw = await redis.hgetall(seatsKey(code));
  return Object.values(raw ?? {})
    .map(parseSeat)
    .filter((value): value is Seat => value !== null)
    .sort((a, b) => a.seat - b.seat);
}

/**
 * 腾座位（本片 · spec §3.5 / R906）—— `claimSeat` 的**对称操作**。
 *
 * ⚠️ **座位号必须从 `room.players` 读，不得本地推导**（R128：数组下标 ≠ 座位号）。
 * 因此本函数只接受**已经查好的座位号**，由调用方（`RoomsService.leaveSeat`）负责取。
 *
 * ⚠️ **幂等**：该座位不是这个人 / 座位已经空了 ⇒ **无声返回 `false`**，绝不抛
 *（「走了两次」「压根没坐过」都不是错误 —— 退房路径不该因为这种竞态报错）。
 *
 * ⚠️ **只删自己那一格**：`HDEL` 只碰这一个字段；别人的座位一行不动。
 *
 * @returns 真的删掉了一格 ⇒ `true`；本来就没坐 ⇒ `false`
 */
export async function releaseSeat(redis: Redis, code: string, seat: number, userId: string): Promise<boolean> {
  const key = seatsKey(code);
  const occupant = parseSeat(await redis.hget(key, String(seat)));
  if (!occupant || occupant.userId !== userId) return false;
  await redis.hdel(key, String(seat));
  return true;
}

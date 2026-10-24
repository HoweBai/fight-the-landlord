import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { matchPendingKey } from '../match/match-keys';

/**
 * §10.1 的 `reconnect:active` 哈希字段内容：
 * `field = playerId` → `{ socketId, roomCode, connectedAt }`。
 *
 * `connectedAt` 是**在线观测点**（规格 v1.1 §2.1）——它记录的不是「入房时刻」，
 * 而是「服务端最近一次观测到该玩家仍在线/仍可恢复」的时刻。窗口/过期概念已随
 * 规格 §2.7 整体退役：记录**存在即候选**，是否可恢复由 resolver（§2.2）的存活谓词决定。
 */
export interface ReconnectRecord {
  socketId: string;
  roomCode: string;
  connectedAt: number;
}

/** 规格 §2.2：凭据解析命中结果。`status` 命中时必为非空串。 */
export interface RecoverableRoom {
  roomCode: string;
  source: 'ticket' | 'record';
  status: string;
}

/** 存活谓词（§3.1）：这两个房态下「对局未结束」。 */
const ALIVE_ROOM_STATUSES: ReadonlySet<string> = new Set(['waiting', 'playing']);

/** 毒键（WRONGTYPE）判定 —— 数据形状损坏，与「连接级读失败」必须分开（规格 §0.3-2）。 */
function isWrongTypeError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('WRONGTYPE');
}

/** §10.1：`reconnect:active` 是 **Hash**，TTL 列是 `—`（**不设 TTL**）。 */
export const RECONNECT_HASH_KEY = 'reconnect:active';

/**
 * 断线重连记录的读写（规格 v1.1 §2.1 写点 / §2.2 resolver）。
 *
 * 模型是「**写点（在线观测点）+ resolver**」：
 *  - `touch()` 在规格 §2.1 的五个时机把记录刷新为 `connectedAt = now`；
 *  - `resolveRecoverableRoom()` 以候选（`match:pending` → 记录）+ 存活谓词决定能回到哪个房间。
 *
 * 窗口/独立键/TTL/时钟注入已整体退役（用户裁决 K1 / 规格 §2.7）：
 * 哈希**不设 TTL**、不做时间判定；过期概念不存在 ⇒ 全仓唯一的删除点是
 * 显式离开（`clearConnection`）。独立键 `reconnect:active:{playerId}` 不再写入，
 * 存量孤儿键无读取方、自然过期（无迁移动作）。
 */
@Injectable()
export class ReconnectService {
  private readonly logger = new Logger(ReconnectService.name);

  constructor(private readonly redis: Redis) {}

  /**
   * 写入 / 刷新在线观测点（规格 §2.1 的统一写入口）：`room.join` 成功、
   * `game.reconnect` 成功、服务端观测到 `disconnect`、以及「新连接建立但该玩家的
   * 上一个连接从未被观测到断开」四条既有时机都调用它（开局写点由 `rooms.start`
   * 随规格 §2.5 接入同一方法）。
   *
   * 只写哈希字段 `reconnect:active`（不设 TTL）——独立键 `SET … EX 35` 已随 §2.7 退役。
   *
   * `roomCode` 缺省时沿用已有记录的房间 —— `disconnect` / 换链路时调用方
   * 不必再去查一次房间。两者都没有（玩家从未入房）时返回 `null` 且不写任何键。
   */
  async touch(playerId: string, socketId: string, roomCode?: string): Promise<ReconnectRecord | null> {
    const existing = await this.readRecord(playerId);
    const code = roomCode ?? existing?.roomCode;
    if (!code) return null;

    const record: ReconnectRecord = { socketId, roomCode: code, connectedAt: Date.now() };
    const raw = JSON.stringify(record);

    await this.redis.hset(RECONNECT_HASH_KEY, playerId, raw);
    this.logger.log(`Reconnect record refreshed for ${playerId} in room ${code} (socket ${socketId})`);
    return record;
  }

  /**
   * 显式离开（`room.leave`）：删哈希字段 —— 唯一的删除点。
   *
   * 过期**不**走这里（也不存在过期）：窗口退役后记录不因时间而失效（规格 §2.7），
   * 是否可恢复由 resolver 的存活谓词（房间还在不在）决定。
   */
  async clearConnection(playerId: string): Promise<void> {
    await this.redis.hdel(RECONNECT_HASH_KEY, playerId);
  }

  /**
   * 公开薄封装（本片 §2.3）：`room.leave` 清理单闸读取记录的凭据面 ——
   * 形状与语义和私有 `readRecord` **完全一致**（缺字段/坏 JSON ⇒ `null`；
   * WRONGTYPE ⇒ 按缺席 + WARN；连接级读失败 ⇒ 上抛）。
   */
  async getRecord(playerId: string): Promise<ReconnectRecord | null> {
    return this.readRecord(playerId);
  }

  /**
   * 读一个 Hash 字段，带毒键处置：WRONGTYPE（键类型损坏）⇒ `null`（按缺席，记 WARN）；
   * **连接级读失败（其余任何 ioredis 错误）⇒ 上抛** —— 沿用各调用方既有失败方向，
   * 绝不允许「Redis 抖一下就把存活候选降级成缺席」（规格 v1.1 §0.3-2）。
   */
  private async safeHget(key: string, field: string): Promise<string | null> {
    try {
      return await this.redis.hget(key, field);
    } catch (err) {
      if (isWrongTypeError(err)) {
        this.logger.warn(`Corrupt Redis key ${key} (WRONGTYPE) — candidate skipped`);
        return null;
      }
      throw err;
    }
  }

  /**
   * 凭据解析（规格 v1.1 §2.2 的单一实现；`handleReconnect` / 补推 / `handleResync` /
   * `forwardAction` 四处共用——全仓不得有第二份「哈希+pending 择优」读取）：
   *  候选 `[match:pending → reconnect:active]`（pending 天然无陈旧：每局新写、TTL 300s、
   *  join/leave 即清）；第一遍按**存活谓词**（`room.status ∈ {waiting, playing}`）取首个；
   *  都不存活 ⇒ 第二遍取首个「房间键存在」（`status !== null`）者；都没有 ⇒ `null`。
   */
  async resolveRecoverableRoom(playerId: string): Promise<RecoverableRoom | null> {
    const candidates: Array<{ source: 'ticket' | 'record'; roomCode: string }> = [];

    const ticketRoom = await this.safeHget(matchPendingKey(playerId), 'roomCode');
    if (ticketRoom) candidates.push({ source: 'ticket', roomCode: ticketRoom });
    const record = await this.readRecord(playerId);
    if (record) candidates.push({ source: 'record', roomCode: record.roomCode });

    let firstExisting: RecoverableRoom | null = null;
    for (const cand of candidates) {
      const status = await this.safeHget(`room:${cand.roomCode}`, 'status');
      if (status === null) continue; // 键不存在 / status 缺失（坏 meta）⇒ 按不存在（规格 §2.2）
      if (ALIVE_ROOM_STATUSES.has(status)) return { ...cand, status };
      firstExisting ??= { ...cand, status };
    }
    return firstExisting;
  }

  /** 解析哈希字段（无字段或损坏 → `null`）。**不做任何窗口判定**。 */
  private async readRecord(playerId: string): Promise<ReconnectRecord | null> {
    // record 候选的 WRONGTYPE 与 ticket 同待遇（规格 §0.3-2「候选损坏按缺席」，对称）；
    // 连接级错误仍由 safeHget 上抛。
    const raw = await this.safeHget(RECONNECT_HASH_KEY, playerId);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<ReconnectRecord>;
      if (typeof parsed.roomCode !== 'string' || parsed.roomCode.length === 0) return null;
      return {
        socketId: typeof parsed.socketId === 'string' ? parsed.socketId : '',
        roomCode: parsed.roomCode,
        connectedAt: Number(parsed.connectedAt) || 0,
      };
    } catch {
      return null; // 解析失败 ⇒ 按缺席（旧实现此处 error 日志删除：规格 §2.2「不打日志噪声」）
    }
  }
}

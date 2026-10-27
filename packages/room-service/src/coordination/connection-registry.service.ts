import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';

/** socket.io 的「用户房间」：跨 Pod 顶替与定向推送共用同一个名字。 */
export const userRoom = (userId: string): string => `user:${userId}`;

/** 连接代次与属主键的 TTL：连接存活时由 socket.io 心跳维持会话，不依赖这个键。 */
const OWNER_TTL_MS = 60 * 60 * 1000;

/** 只有「属主键仍归本次连接」时才删除；否则保留新连接的属主。 */
const COMPARE_DEL = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok, owner = pcall(cjson.decode, v)
if not ok then return 0 end
if tostring(owner.gen) == ARGV[1] and owner.socketId == ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/**
 * 跨 Pod 连接登记（spec 2026-10-27 D12）。
 *
 * - `ws:generation:{userId}`：单调代次，用于属主清理；
 * - `ws:owner:{userId}`：当前属主（pod / socketId / 代次），TTL 兜底；
 * - `user:{userId}` socket.io 房间：适配器启用后 `fetchSockets()` 能看到所有 Pod 上的连接。
 *
 * ⚠️ 本地 `ws_connections` gauge 的 inc/dec 仍由 WsGateway 的本地 `activeConnections`
 * 配对（本地在册就本地 dec）—— 代次只用于清 Redis 属主，**不得**用来跳过本地 dec，
 * 否则跨 Pod 顶替会永久抬高旧 Pod 的 gauge。
 */
@Injectable()
export class ConnectionRegistry {
  constructor(@Inject(Redis) private readonly redis: Redis) {}

  async register(io: Server, socket: Socket, userId: string): Promise<void> {
    const room = userRoom(userId);
    const previous = await io.in(room).fetchSockets();
    for (const s of previous) {
      if (s.id !== socket.id) s.disconnect(true);
    }
    const gen = await this.redis.incr(`ws:generation:${userId}`);
    const owner = JSON.stringify({
      pod: process.env.HOSTNAME ?? 'unknown',
      socketId: socket.id,
      gen,
    });
    await this.redis.set(`ws:owner:${userId}`, owner, 'PX', OWNER_TTL_MS);
    (socket.data as Record<string, unknown>).connGeneration = gen;
    await socket.join(room);
  }

  /** 清理属主键；`dec` 是本地 gauge 的递减，**无论属主键是否归本连接都要执行**。 */
  async unregister(socket: Socket, dec: () => void): Promise<boolean> {
    const userId = (socket.data as { userId?: string }).userId;
    const gen = (socket.data as { connGeneration?: number }).connGeneration;
    let removed = false;
    if (userId && gen !== undefined) {
      try {
        const res = await this.redis.eval(COMPARE_DEL, 1, `ws:owner:${userId}`, String(gen), socket.id);
        removed = Number(res) === 1;
      } catch {
        // 属主键清理失败不影响本地 gauge；TTL 兜底。
      }
    }
    dec();
    return removed;
  }
}

import type { Redis } from 'ioredis';
import type { Socket } from 'socket.io';
import { ccstateKey } from '../rooms/rooms.seats';

/**
 * 记牌器收费片：房间状态（`room:{code}:ccstate`）的**读/发**共用件。
 *
 * 写入方 = `RoomStartService.updateCardCounterStatuses`；读/发点 = 三条重连补发路径
 * （`WsGateway.replayActiveGame` / `handleReconnect` / `handleResync`）。
 * 键名唯一真源 = `rooms.seats.ccstateKey`（不在本文件重写字面量）。
 */
export interface CardCounterStatusPayload {
  roomCode: string;
  active: boolean;
  source?: 'pass' | 'credit' | 'none' | 'unknown';
}

/** 读本房本座状态；无行/坏 JSON/坏形状 ⇒ `null`（调用方 fail-closed，不补发）。 */
export async function readCardCounterStatus(
  redis: Redis,
  roomCode: string,
  seat: number,
): Promise<CardCounterStatusPayload | null> {
  const raw = await redis.hget(ccstateKey(roomCode), String(seat));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { active?: unknown; source?: unknown };
    if (typeof parsed.active !== 'boolean') return null;
    const payload: CardCounterStatusPayload = { roomCode, active: parsed.active };
    if (
      parsed.source === 'pass' ||
      parsed.source === 'credit' ||
      parsed.source === 'none' ||
      parsed.source === 'unknown'
    ) {
      payload.source = parsed.source;
    }
    return payload;
  } catch {
    return null;
  }
}

/** 定向发 `game.card_counter`（房间级、`version` 恒 0）。 */
export function emitCardCounterStatus(socket: Socket, status: CardCounterStatusPayload): void {
  socket.emit('game.card_counter', { version: 0, payload: status });
}

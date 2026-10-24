import type Redis from 'ioredis';
import type { SkillLevel } from '@fight-the-landlord/protocol';
import { ROOM_TTL_SECONDS } from './rooms.seats';

/**
 * 一条**已绑定到座位**的机器人（`game.start` 的 `players[]` 要带 `botId` + `skillLevel` +
 * `thinkingSpeed`，
 * §9.6 第 4 条）。
 *
 * ⚠️ 本类型原先住在 `match.service.ts`（那里定义了它）—— 本片把开局链抽到
 * `rooms.start.ts` 之后，它跟着搬家到这里（绑定表自己的模块），否则 rooms 侧
 * 为了一个类型反过来 import match 侧，又成环。
 */
export interface BotBinding {
  seat: number;
  botId: string;
  skillLevel: SkillLevel;
  /** 基础手速（ms，1–3s）：随 `game.start` 透传给 game-service，**永不下发客户端**。 */
  thinkingSpeed: number;
  displayId: string;
}

/**
 * §9.6 第 4 条 / R207：`room:{code}:bots` —— **座位 → 内部 `botId`** 的绑定表。
 *
 * 为什么必须单独存一张：`room:{code}:seats` 里存的是**对外** `displayId`（`p_<8位>`，
 * §9.2 的不可区分性要求），而局终归池需要的是**内部** `botId`
 * （`robot.release({ botIds })`）。出站结构与内部结构分离，因此绑定关系必须另存。
 *
 * 类型是 **Hash**（`field = seat` → `botId`），TTL 与房间一致（§10.1 的 3600s）。
 */
export function botsKey(code: string): string {
  return `room:${code}:bots`;
}

/** 写入绑定（`HSET` 逐座位；重复调用幂等）。 */
export async function writeBotBindings(
  redis: Redis,
  code: string,
  bindings: ReadonlyArray<{ seat: number; botId: string }>,
): Promise<void> {
  if (bindings.length === 0) return;
  for (const { seat, botId } of bindings) {
    await redis.hset(botsKey(code), String(seat), botId);
  }
  await redis.expire(botsKey(code), ROOM_TTL_SECONDS);
}

/** 读回本房间**全部**机器人的内部 id（按座位升序；无绑定 ⇒ 空数组）。 */
export async function readBotBindings(redis: Redis, code: string): Promise<string[]> {
  const raw = await redis.hgetall(botsKey(code));
  return Object.entries(raw ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, botId]) => botId);
}

/** 局终归池后删键（R207：`game.ended` 分支里 release + 删键是**同一次**动作）。 */
export async function clearBotBindings(redis: Redis, code: string): Promise<void> {
  await redis.del(botsKey(code));
}

import { Inject, Injectable } from '@nestjs/common';
import type { Seat } from '@fight-the-landlord/protocol';
import Redis from 'ioredis';
import { NicknameClient } from '../gateway/nickname.client';
import { nicknamesKey, ROOM_TTL_SECONDS } from './rooms.seats';

/**
 * 房间昵称缓存（昵称片 · 设计 D4）。
 *
 * `ensure` 是唯一入口：读 `room:{code}:nicknames`，只对**缺失的人类 userId** 批量回源；
 * 成功后把 `nickname ?? ''` 写回（空串 = 已知无昵称）。回源失败（空 map）**不写缓存**，
 * 下次状态推送再试。返回的 Map **只含非空昵称**（调用方据此决定是否加字段）。
 */
@Injectable()
export class RoomNicknamesService {
  constructor(
    @Inject(Redis) private readonly redis: Redis,
    private readonly client: NicknameClient,
  ) {}

  async ensure(code: string, players: readonly Seat[]): Promise<Map<string, string>> {
    const key = nicknamesKey(code);
    const cached = new Map<string, string | null>();
    for (const [userId, value] of Object.entries((await this.redis.hgetall(key)) ?? {})) {
      cached.set(userId, value === '' ? null : value);
    }

    const humanIds = [...new Set(players.filter((p) => !p.isRobot).map((p) => p.userId))];
    const missing = humanIds.filter((userId) => !cached.has(userId));

    if (missing.length > 0) {
      const fetched = await this.client.getNicknames(missing);
      const fields: Record<string, string> = {};
      for (const userId of missing) {
        if (!fetched.has(userId)) continue;
        const nickname = fetched.get(userId) ?? null;
        cached.set(userId, nickname);
        fields[userId] = nickname ?? '';
      }
      if (Object.keys(fields).length > 0) {
        await this.redis.hset(key, fields);
        await this.redis.expire(key, ROOM_TTL_SECONDS);
      }
    }

    const out = new Map<string, string>();
    for (const [userId, nickname] of cached) if (nickname) out.set(userId, nickname);
    return out;
  }
}

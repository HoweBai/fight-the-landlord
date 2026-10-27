import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * 局终副作用唯一执行闸（spec 2026-10-27 D13）。
 *
 * `game.ended` 经 Redis pub/sub 被**每个** room-service 副本收到；广播必须每副本都做，
 * 但结算/记账/写记录/归池/指标只能做一次。`(roomCode, version)` 作为幂等键：
 * 与 leader lease 叠加，lease 切换窗口内也最多一个执行者。
 */
@Injectable()
export class FinalizationGuard {
  constructor(@Inject(Redis) private readonly redis: Redis) {}

  async claim(roomCode: string, version: number): Promise<boolean> {
    const key = `room:finalized:${roomCode}:${version}`;
    const res = await this.redis.set(key, '1', 'EX', 86_400, 'NX');
    return res === 'OK';
  }
}

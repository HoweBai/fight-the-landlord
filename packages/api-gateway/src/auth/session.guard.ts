import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** §5.1 的白名单键形状。user-service 是写入方；网关只读。 */
export function sessionKey(jti: string): string {
  return `session:${jti}`;
}

/**
 * api-gateway 自己的 Redis DI token（R30）。
 *
 * 与 `user-service` 的 `REDIS` **同名但各自一份** —— 两边都不跨包 import
 * Nest 代码，也不为它新建 workspace 包（R23）。
 */
export const REDIS = 'REDIS';

/** 令牌吊销的唯一查询点（R26）。Redis 故障必须上抛：宁可 503 也不放行已吊销的令牌。 */
@Injectable()
export class SessionGuard {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async isActive(jti: string): Promise<boolean> {
    return (await this.redis.exists(sessionKey(jti))) === 1;
  }
}

import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

/** payment-service 的 Redis token（与 user-service 的 `REDIS = 'REDIS'` 同值——跨仓 Redis token 统一）。 */
export const REDIS = 'REDIS';

/**
 * 本服务的 Redis 连接工厂（与 user-service 的同签名）。
 *
 * `maxRetriesPerRequest: 1` + `enableOfflineQueue: false`：让 Redis 不可用快速失败。
 * 票据验证 `DEL` 命令在 withdrawal 入口调用——不可用时直接 fail-closed（拦截提现），
 * 而不是排队拖死请求。
 */
export function createRedis(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}

@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: createRedis }],
  exports: [REDIS],
})
export class RedisModule {}

import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../auth/token.service';

/**
 * 本服务的 Redis 连接的**唯一**工厂（§5.1 的 session 白名单）。
 *
 * `maxRetriesPerRequest: 1` + `enableOfflineQueue: false`：让「Redis 不可用」**快速失败**。
 * ioredis 默认会把命令排队重试 20 次（实测一次真实故障要 ~10s 才 reject），而这张
 * 白名单在每次签发/轮换/登出时都要写 —— 堆在重试队列里只会把请求拖死。
 *
 * ⚠️ 提成独立函数的原因见 §2.4 / R267：健康检查要复用本服务**已有**的连接。
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

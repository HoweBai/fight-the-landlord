import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from './auth/session.guard';

/**
 * `api-gateway` 自己的 Redis 连接（R30：与 `user-service` 的 `REDIS` **同名但各自一份**）。
 *
 * ⚠️ 提出这个 provider 的直接原因是 §2.4 / R267：健康检查需要复用本服务**已有**的
 * Redis，**不得**为它再 `new Redis()`。此前这段 `useFactory` 内联在 `app.module.ts` 里，
 * 外部无从复用。
 *
 * ⚠️ 选项**逐字保留**（R26/S6 的语义，不要「顺手」去掉）：
 * `maxRetriesPerRequest: 1` + `enableOfflineQueue: false` —— 网关**每个**鉴权请求都要查
 * 白名单，而 ioredis 默认会排队重试 20 次 ⇒ 真实故障下 503 要 ~10s 才返回（实测）。
 * 这里要的是**快速失败**：宁可立刻回 `10007`，也不把网关的请求堆在重试队列里。
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
export class RedisProviderModule {}

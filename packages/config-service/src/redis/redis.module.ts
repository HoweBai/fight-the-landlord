import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * `REDIS` 注入令牌 —— 本服务**自建的最小面**（r1 计划审查 I-8）。
 *
 * user-service 的同名令牌住在 `auth/token.service.ts`（那个服务要签发/吊销会话，令牌是
 * 它的副产物）；config-service 没有 auth 面（T3 的管理令牌是无状态 JWT），硬造一个空壳
 * `token.service.ts` 只为对齐文件名，反而把「这里没有会话服务」这条信息埋掉。
 */
export const REDIS = 'REDIS';

/**
 * 本服务 Redis 连接的**唯一**工厂（承担 `config:changed` 广播）。
 *
 * `maxRetriesPerRequest: 1` + `enableOfflineQueue: false`：让「Redis 不可用」**快速失败**。
 * ioredis 默认会把命令排队重试 20 次（实测一次真实故障要 ~10s 才 reject），而写路径
 * 每次都 publish —— 堆在重试队列里只会把管理面请求拖死（C12 的设计前提就是它**快速**抛、
 * 让 `announced:false` 及时可见）。
 *
 * ⚠️ 健康检查复用本服务**已有**的连接（`HealthService` 注入同一个 `REDIS`），不新建。
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

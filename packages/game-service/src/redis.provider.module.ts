import { Module, Global, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * `game-service` 的 Redis 连接的**唯一**工厂（§10.2 的会话真源 + §4.4 的 pub/sub）。
 *
 * ⚠️ 提出这个 provider 的直接原因是 §2.4 / R267：健康检查需要复用本服务**已有**的
 * Redis，**不得**为它再 `new Redis()`。此前这个连接藏在 `GameService` 的构造函数里
 * （`this.redis = new Redis(...)`）⇒ 外部无从复用，只能新建第二个连接源。
 *
 * 形态与 `room-service`/`robot-service` 的 `redis.provider.module.ts` **同款**
 * （`@Global()` + `provide: Redis`），token 就是类本身。
 */
export function createRedis(): Redis {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  // S7（R142）：**不得**用裸 `console.error` —— 它绕过 `Logger.overrideLogger`
  // 安装的脱敏器（`packages/api-gateway/test/no-raw-console.test.ts` 是这条的机械闸）。
  redis.on('error', (err: Error) =>
    new Logger('RedisProvider').error(`Redis error: ${err.message}`),
  );
  return redis;
}

@Global()
@Module({
  providers: [{ provide: Redis, useFactory: createRedis }],
  exports: [Redis],
})
export class RedisProviderModule {}

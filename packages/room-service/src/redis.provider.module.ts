import { Module, Global, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
/**
 * 本服务的 Redis 连接的**唯一**工厂。
 *
 * ⚠️ 提出来是为了让判据能钉住「provider 与消费方拿的是**同一个**工厂」
 * （§2.4 / R267：健康检查**不得**新建连接）。
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

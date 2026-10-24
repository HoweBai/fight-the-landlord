import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from './redis/redis.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { ConfigModule } from './config/config.module';
import { AdminModule } from './admin/admin.module';
import { configDatabaseOptions } from './database.config';

/**
 * config-service 的装配。
 *
 * T3 起挂 `ConfigModule`（三个接口面：玩家子集 / 管理面 / `config.snapshot` RPC）；
 * ③ T2 起挂 `AdminModule`（账号 CRUD；`src/admin/` —— ⚠️ 与 `src/config/admin.controller.ts`
 * 同名异径，管理面装配分居两模块）；③ T3 起 AdminModule 另含登录事件服务与首启引导
 * （`OnApplicationBootstrap`，容器启动时按 §2.13 三态处理）。迁移的登记 = `database.config.ts`
 * 的 glob（`dist/migrations/*.js`，新增迁移文件即自动被 `migrationsRun` 拾取）。
 * ⚠️ **值导入**（不是 `import type`）：DI 需要类的运行期身份，`import type` 会在容器
 * 启动时崩（本仓既有陷阱）。
 */
@Module({
  imports: [
    // 选项集中在 `database.config.ts`（与 TypeORM CLI 的 `data-source.ts` **共用同一份**）——
    // `synchronize: false` + `migrations` + `migrationsRun: true` + 独立的 `migrations_config`。
    TypeOrmModule.forRoot(configDatabaseOptions()),
    RedisModule,
    ConfigModule,
    AdminModule,
  ],
  controllers: [HealthController],
  // §2.4：健康检查复用 `RedisModule`（`@Global`）的 `REDIS` 与 TypeORM 的 `DataSource`
  // —— 二者都由上面的 `imports` 提供，**不新建连接**。
  providers: [HealthService],
})
export class AppModule {}

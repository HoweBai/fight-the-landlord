import { join } from 'node:path';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * config-service 的 MySQL 连接选项（克隆自 user-service 的同名文件）。
 *
 * ⚠️ **唯一来源**：`app.module.ts`（运行期）与 `data-source.ts`（TypeORM CLI）都从这里取，
 * 免得两处各写一份 `synchronize`/`migrations` —— 那种漂移在本仓已有前科。
 */

/** 迁移脚本目录（`dist/migrations/*.js`；`__dirname` 对 dist 与 src 两种执行形态都成立）。 */
export const migrationsGlob = (): string => join(__dirname, 'migrations/*.js');

/** 实体目录（CLI 需要；运行期由 `autoLoadEntities` 承担）。 */
export const entitiesGlob = (): string => join(__dirname, '**/*.entity.js');

/**
 * 纯 MySQL 连接选项（`type` 收窄成字面量 `'mysql'`：`DataSourceOptions` 是各驱动程序
 * 选项的**联合类型**，`type` 不收窄的话 `new DataSource(...)` 侧会因判别属性丢失而报错）。
 */
function mysqlConnectionOptions() {
  return {
    type: 'mysql' as const,
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '3306'),
    username: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'root',
    database: process.env.DB_NAME ?? 'fight_the_landlord',
    /** 与 user-service 同口径：显式迁移，`synchronize` 关掉。 */
    synchronize: false,
    /** 迁移脚本（编译产物）。⚠️ 与 `data-source.ts` 共用 `migrationsGlob()`。 */
    migrations: [migrationsGlob()],
    /** 启动时自动跑迁移（新库靠它建表；已存在的库首跑只写迁移表）。 */
    migrationsRun: process.env.DB_MIGRATIONS_RUN !== 'false',
    /** 片⑦：与 user-service 共库 ⇒ 迁移表**必须**独立（否则互相把对方的记录当「未知已执行」）。 */
    migrationsTableName: 'migrations_config',
  };
}

/** 运行期（Nest `TypeOrmModule.forRoot`）选项。 */
export function configDatabaseOptions(): TypeOrmModuleOptions {
  return { ...mysqlConnectionOptions(), autoLoadEntities: true };
}

/** CLI（`data-source.ts`）选项：与运行期**同一份**连接/迁移配置（少了 Nest 专属的字段）。 */
export function configDataSourceOptions() {
  return mysqlConnectionOptions();
}

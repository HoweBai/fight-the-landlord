import { join } from 'node:path';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * payment-service 的 MySQL 连接选项（克隆自 currency-service 的同名文件）。
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
    migrationsRun: true,
    /**
     * ⚙️1（支付片）：与 user / config / currency **共库**（`fight_the_landlord`）⇒ 迁移表
     * **必须第四份独立**（user 默认 `migrations`、config 是 `migrations_config`、
     * currency 是 `migrations_currency`）—— 否则 TypeORM 只认表名，payment 的迁移会被
     * 另三家的记录当成「未知已执行」而互相搅乱（T3 的五表迁移就挂在这份表上）。
     * `boot.test.ts` 有一条「与另三份逐字互异」的判据把拷贝忘改名的形态钉死。
     */
    migrationsTableName: 'migrations_payment',
  };
}

/** 运行期（Nest `TypeOrmModule.forRoot`）选项。 */
export function paymentDatabaseOptions(): TypeOrmModuleOptions {
  return { ...mysqlConnectionOptions(), autoLoadEntities: true };
}

/** CLI（`data-source.ts`）选项：与运行期**同一份**连接/迁移配置（少了 Nest 专属的字段）。 */
export function paymentDataSourceOptions() {
  return mysqlConnectionOptions();
}

import { join } from 'node:path';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * user-service 的 MySQL 连接选项（§2.3 的 `DB_*` 环境变量，§10.3 的迁移策略）。
 *
 * ⚠️ **唯一来源**：`app.module.ts`（运行期）与 `data-source.ts`（TypeORM CLI）都从这里取，
 * 免得两处各写一份 `synchronize`/`migrations` —— 那种漂移在本仓已有前科
 * （同一语义两处实现 ⇒ 一处改了另一处没改，而**单侧测试测不出来**）。
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
    /**
     * §10.3 逐字：「`synchronize: true` **仅限开发环境**；MVP 上线前须改为显式迁移脚本」。
     * E7：现在就是显式迁移。**关掉它**是判据的一半，另一半是「关了仍然可用」
     * （容器重启后 `users` 表 7 列还在 ⇒ 由 `migrationsRun` 保证）。
     */
    synchronize: false,
    /** 迁移脚本（编译产物）。⚠️ 与 `data-source.ts` 共用 `migrationsGlob()`。 */
    migrations: [migrationsGlob()],
    /**
     * R248（用户裁决）：**启动时自动跑迁移**。新库（docker volume 被清掉时）靠它建表，
     * 已存在的库首跑只会写 `migrations` 表（迁移里是 `CREATE TABLE IF NOT EXISTS`）。
     */
    migrationsRun: process.env.DB_MIGRATIONS_RUN !== 'false',
  };
}

/** 运行期（Nest `TypeOrmModule.forRoot`）选项。 */
export function userDatabaseOptions(): TypeOrmModuleOptions {
  return { ...mysqlConnectionOptions(), autoLoadEntities: true };
}

/** CLI（`data-source.ts`）选项：与运行期**同一份**连接/迁移配置（少了 Nest 专属的字段）。 */
export function userDataSourceOptions() {
  return mysqlConnectionOptions();
}

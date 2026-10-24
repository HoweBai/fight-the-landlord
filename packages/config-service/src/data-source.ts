import { DataSource } from 'typeorm';
import { configDataSourceOptions, entitiesGlob, migrationsGlob } from './database.config';

/**
 * TypeORM CLI 用的 `DataSource`（克隆自 user-service 的同名文件）。
 *
 * ⚠️ 它与**运行期**（`app.module.ts` → `configDatabaseOptions()`）共用 `database.config.ts`
 * 的同一份连接/迁移选项，因此 CLI 看到的 `synchronize`/`migrations`/`migrationsTableName`
 * 与容器里跑的**逐字相同**。只有 `entities` 是 CLI 额外需要的（运行期靠 `autoLoadEntities`）。
 *
 * ⚠️ **单导出纪律（③ T2 Step 4 实测补遗）**：本文件**只许有一个 DataSource 导出**——
 * typeorm 0.3.31 的 `CommandUtils.loadDataSource` 会把模块里每个 `isDataSource` 导出都收集
 * 起来（**不去重**），>1 个即抛「must contain only one export of DataSource instance」。
 * 此前沿用的 `export const AppDataSource` + `export default AppDataSource` 双写形态会让
 * `migration:run`/`migration:revert` **恒失败**（首轮真栈 revert 演练抓到；本文件去掉了
 * `export default`。⚠️ user-service / currency-service 的同名文件仍是双导出形态——不在本片
 * 射程，留档勿照抄）。
 *
 * 用法（⚠️ **先 `pnpm build`** —— 本仓没有 ts-node，CLI 读的是 `dist/`）：
 *   pnpm --filter @fight-the-landlord/config-service build
 *   pnpm --filter @fight-the-landlord/config-service migration:run
 */
export const AppDataSource = new DataSource({
  ...configDataSourceOptions(),
  entities: [entitiesGlob()],
  migrations: [migrationsGlob()],
});

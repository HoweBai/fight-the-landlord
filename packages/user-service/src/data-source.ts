import { DataSource } from 'typeorm';
import { entitiesGlob, migrationsGlob, userDataSourceOptions } from './database.config';

/**
 * TypeORM CLI 用的 `DataSource`（E7）。
 *
 * ⚠️ 它与**运行期**（`app.module.ts` → `userDatabaseOptions()`）共用 `database.config.ts`
 * 的同一份连接/迁移选项，因此 CLI 看到的 `synchronize`/`migrations` 与容器里跑的**逐字相同**。
 * 只有 `entities` 是 CLI 额外需要的（运行期靠 `autoLoadEntities`）。
 *
 * ⚠️ **单导出纪律（风控 T4 真库 revert 演练实测补遗；与 config-service 的 ③ T2 修复逐字同款）**：
 * 本文件**只许有一个 DataSource 导出** —— typeorm 0.3.31 的 `CommandUtils.loadDataSource`
 * 会把模块里每个 `isDataSource` 导出都收集起来（**不去重**），>1 个即抛
 * 「must contain only one export of DataSource instance」。此前双写形态
 * （`export const AppDataSource` + `export default AppDataSource`）会让
 * `migration:run`/`migration:revert` **恒失败**（T4 首轮 revert 演练当场抓到；本文件去掉了
 * `export default`。⚠️ currency-service 的同名文件仍是双导出形态——不在本片射程，留档勿照抄）。
 *
 * 用法（⚠️ **先 `pnpm build`** —— 本仓没有 ts-node，CLI 读的是 `dist/`）：
 *   pnpm --filter @fight-the-landlord/user-service build
 *   pnpm --filter @fight-the-landlord/user-service migration:run
 */
export const AppDataSource = new DataSource({
  ...userDataSourceOptions(),
  entities: [entitiesGlob()],
  migrations: [migrationsGlob()],
});

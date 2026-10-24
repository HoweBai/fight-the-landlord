import { DataSource } from 'typeorm';
import { paymentDataSourceOptions, entitiesGlob, migrationsGlob } from './database.config';

/**
 * TypeORM CLI 用的 `DataSource`（克隆自 currency-service 的同名文件）。
 *
 * ⚠️ 它与**运行期**（`app.module.ts` → `paymentDatabaseOptions()`）共用 `database.config.ts`
 * 的同一份连接/迁移选项，因此 CLI 看到的 `synchronize`/`migrations`/`migrationsTableName`
 * 与容器里跑的**逐字相同**。只有 `entities` 是 CLI 额外需要的（运行期靠 `autoLoadEntities`）。
 *
 * 用法（⚠️ **先 `pnpm build`** —— 本仓没有 ts-node，CLI 读的是 `dist/`）：
 *   pnpm --filter @fight-the-landlord/payment-service build
 *   pnpm --filter @fight-the-landlord/payment-service migration:run
 */
export const AppDataSource = new DataSource({
  ...paymentDataSourceOptions(),
  entities: [entitiesGlob()],
  migrations: [migrationsGlob()],
});

export default AppDataSource;

/**
 * 迁移辅助函数（**故意放在 `migrations/` 之外**）。
 *
 * 🔴 TypeORM 通过 `glob('dist/migrations/*.js')` 发现迁移，而
 * `DirectoryExportedClassesLoader.loadFileClasses` 会把**模块里每一个函数型导出**都收进
 * 迁移列表（`typeof exported === 'function'`；数组/普通对象还会递归展开）—— 随后
 * `MigrationExecutor.getMigrations` 要求名字**末 13 位**是数字时间戳，否则连接初始化直接抛
 * `TypeORMError: … migration name is wrong`，服务在真栈里**永远起不来**。
 *
 * ⇒ 任何**不是迁移类**的导出都必须待在这个目录（`src/migration-support/`，不会被
 * `migrations/*.js` 匹配到）。判据见 `test/migration.test.ts` 的「迁移发现判据」用例。
 */

/**
 * 迁移时现算救助门槛：`MIN(斗地主档位 baseScore) × 斗地主 entryMultiplier`。
 * 旧键缺失/非法 ⇒ 15 × 10 = 150（正常种子）。
 */
export function computeReliefThreshold(levels: unknown, multiplier: unknown): number {
  const m =
    typeof multiplier === 'number' &&
    Number.isInteger(multiplier) &&
    multiplier >= 1 &&
    multiplier <= 100
      ? multiplier
      : 10;
  if (Array.isArray(levels)) {
    const scores = levels
      .map((item) =>
        item !== null && typeof item === 'object' && 'baseScore' in item
          ? (item as { baseScore?: unknown }).baseScore
          : undefined,
      )
      .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
    if (scores.length > 0) return Math.min(...scores) * m;
  }
  return 15 * m;
}

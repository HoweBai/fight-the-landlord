import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 跑得快风控种子（2026-10-25）：`game.paodekuai.risk.winRateThreshold` = 0.8、
 * `game.paodekuai.risk.minGames` = 100。
 *
 * - **version 起点 = 全表 MAX（至少 1）**：照 `1796600000000-SplitGameConfig` 的纪律——
 *   新键若从 1 起写，在旧键版本更高的库里后续 PUT 永远推不动全局 version；
 * - `INSERT IGNORE`：现有库/重放可重跑，且**不覆盖**运营已改的值；
 * - `down()` 只删本迁移新增的两键。
 */
export class PdkRiskConfigSeed1796700000000 implements MigrationInterface {
  name = 'PdkRiskConfigSeed1796700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const maxRows = (await queryRunner.query(
      'SELECT MAX(`version`) AS maxVersion FROM `platform_config`',
    )) as Array<{ maxVersion: number | string | null }>;
    const rawMax = Number(maxRows[0]?.maxVersion ?? 0);
    const version = Number.isFinite(rawMax) ? Math.max(1, rawMax) : 1;

    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES (?, ?, ?, NOW(3), ?), (?, ?, ?, NOW(3), ?)',
      [
        'game.paodekuai.risk.winRateThreshold',
        JSON.stringify(0.8),
        version,
        'seed',
        'game.paodekuai.risk.minGames',
        JSON.stringify(100),
        version,
        'seed',
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM `platform_config` WHERE `key` IN (?, ?)', [
      'game.paodekuai.risk.winRateThreshold',
      'game.paodekuai.risk.minGames',
    ]);
  }
}

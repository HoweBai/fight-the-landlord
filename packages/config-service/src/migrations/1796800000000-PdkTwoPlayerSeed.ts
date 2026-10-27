import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 跑得快 2 人场种子（2026-10-25）：`game.paodekuai.twoPlayerEnabled` = false。
 *
 * - **version 起点 = 全表 MAX（至少 1）**：照 `1796700000000-PdkRiskConfigSeed` 的纪律；
 * - `INSERT IGNORE`：现有库/重放可重跑，且**不覆盖**运营已改的值；
 * - `down()` 只删本迁移新增的键。
 */
export class PdkTwoPlayerSeed1796800000000 implements MigrationInterface {
  name = 'PdkTwoPlayerSeed1796800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const maxRows = (await queryRunner.query(
      'SELECT MAX(`version`) AS maxVersion FROM `platform_config`',
    )) as Array<{ maxVersion: number | string | null }>;
    const rawMax = Number(maxRows[0]?.maxVersion ?? 0);
    const version = Number.isFinite(rawMax) ? Math.max(1, rawMax) : 1;

    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES (?, ?, ?, NOW(3), ?)',
      ['game.paodekuai.twoPlayerEnabled', JSON.stringify(false), version, 'seed'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM `platform_config` WHERE `key` = ?', [
      'game.paodekuai.twoPlayerEnabled',
    ]);
  }
}

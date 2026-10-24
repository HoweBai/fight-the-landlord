import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 玩法开放开关（2026-10-24）：斗地主总开关种子。
 *
 * - `game.doudizhu.enabled = true`（保持现状；跑得快继续用它自己的总开关）。
 * - `INSERT IGNORE`：现有库/重放可重跑（同既有种子迁移），且**不覆盖**管理员已改的值。
 */
export class DdzEnabledSeed1796500000000 implements MigrationInterface {
  name = 'DdzEnabledSeed1796500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('game.doudizhu.enabled', 'true', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'game.doudizhu.enabled'");
  }
}

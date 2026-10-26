import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 跑得快风控按人数 + 自动限流种子（2026-10-26 / B 组 spec D1/D4）。
 *
 * 新增 7 键：2/3/4 人各一对 `winRateThreshold`/`minGames`（0.8/100），
 * 以及 PDK 自动限流阈值 `autoThrottleScore=50`。
 *
 * - **version 起点 = 全表 MAX（至少 1）**：照 `1796600000000-SplitGameConfig` 的纪律；
 * - `INSERT IGNORE`：现有库/重放可重跑，且**不覆盖**运营已改的值；
 * - `down()` 只删本迁移新增的 7 键；
 * - 旧 PDK 两键（`game.paodekuai.risk.winRateThreshold`/`minGames`）保留，作为对应人数键
 *   缺失时的回退，不在本迁移内改动。
 */
const KEYS: ReadonlyArray<readonly [key: string, value: unknown]> = [
  ['game.paodekuai.risk.player2.winRateThreshold', 0.8],
  ['game.paodekuai.risk.player2.minGames', 100],
  ['game.paodekuai.risk.player3.winRateThreshold', 0.8],
  ['game.paodekuai.risk.player3.minGames', 100],
  ['game.paodekuai.risk.player4.winRateThreshold', 0.8],
  ['game.paodekuai.risk.player4.minGames', 100],
  ['game.paodekuai.risk.autoThrottleScore', 50],
];

export class PdkRiskPlayerCountSeed1797000000006 implements MigrationInterface {
  name = 'PdkRiskPlayerCountSeed1797000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const maxRows = (await queryRunner.query(
      'SELECT MAX(`version`) AS maxVersion FROM `platform_config`',
    )) as Array<{ maxVersion: number | string | null }>;
    const rawMax = Number(maxRows[0]?.maxVersion ?? 0);
    const version = Number.isFinite(rawMax) ? Math.max(1, rawMax) : 1;

    const placeholders = KEYS.map(() => '(?, ?, ?, NOW(3), ?)').join(', ');
    const params = KEYS.flatMap(([key, value]) => [
      key,
      JSON.stringify(value),
      version,
      'seed',
    ]);
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) ' +
        `VALUES ${placeholders}`,
      params,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const placeholders = KEYS.map(() => '?').join(', ');
    await queryRunner.query(
      `DELETE FROM \`platform_config\` WHERE \`key\` IN (${placeholders})`,
      KEYS.map(([key]) => key),
    );
  }
}

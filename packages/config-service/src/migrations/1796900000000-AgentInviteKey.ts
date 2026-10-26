import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 代理分润客户端开关种子（2026-10-26）：`agent.inviteEnabled` = `false`（暗上线）。
 *
 * - **version 起点 = 全表 MAX（至少 1）**：照 `1796600000000-SplitGameConfig` 的纪律
 *   —— 新键若从 1 起写，在旧键版本更高的库里后续 PUT 永远推不动全局 version；
 * - `INSERT IGNORE`：现有库/重放可重跑，且**不覆盖**运营已改的值；
 * - `down()` 只删本迁移新增的键。
 * - 类名**不得**以 `Currency` 开头（currency-service 的迁移测试按该前缀取首个匹配）；
 *   时间戳与 currency 的 `1797000000000-AgentDomain` 不同号。
 */
export class AgentInviteKey1796900000000 implements MigrationInterface {
  name = 'AgentInviteKey1796900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const maxRows = (await queryRunner.query(
      'SELECT MAX(`version`) AS maxVersion FROM `platform_config`',
    )) as Array<{ maxVersion: number | string | null }>;
    const rawMax = Number(maxRows[0]?.maxVersion ?? 0);
    const version = Number.isFinite(rawMax) ? Math.max(1, rawMax) : 1;

    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES (?, ?, ?, NOW(3), ?)',
      ['agent.inviteEnabled', JSON.stringify(false), version, 'seed'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM `platform_config` WHERE `key` = ?', [
      'agent.inviteEnabled',
    ]);
  }
}

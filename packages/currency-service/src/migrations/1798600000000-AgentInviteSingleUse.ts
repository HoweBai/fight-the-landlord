import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 一次性邀请码（2026-11-03）：`agent_invite_codes` 增加消费痕迹。
 *
 * - `used_by`：消费该码的玩家 `owner_id`（UUID，varchar(36) 与 users.id 同口径）；
 * - `used_at`：消费时间（datetime(3)，与 `NOW(3)` 同精度）；
 * - `status` 仍为 varchar(10)，新增取值 `used`（active → used 终端态）；
 * - `down()` 先把 used 重置回 active 再删列（仅开发库回滚；生产不逆向已消费数据）。
 */
export class AgentInviteSingleUse1798600000000 implements MigrationInterface {
  name = 'AgentInviteSingleUse1798600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `agent_invite_codes` ' +
        'ADD COLUMN `used_by` varchar(36) NULL DEFAULT NULL, ' +
        'ADD COLUMN `used_at` datetime(3) NULL DEFAULT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "UPDATE `agent_invite_codes` SET `status` = 'active' WHERE `status` = 'used'",
    );
    await queryRunner.query(
      'ALTER TABLE `agent_invite_codes` DROP COLUMN `used_by`, DROP COLUMN `used_at`',
    );
  }
}

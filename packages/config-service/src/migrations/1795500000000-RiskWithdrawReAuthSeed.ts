import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 提交 3（⚙️1）：第 **48** 个配置键的种子迁移——`risk.withdrawReAuthEnabled=false`。
 *
 * 严格 boolean、种子 false（暗上线——默认关闭，客户端不弹密码框，服务端票据闸放行）。
 * 消费方：payment-service WithdrawController.apply() 票据闸。
 *
 * ⚠️ **时间戳 1795500000000 —— 合并期由 1795300000000 改号**：本片与主线已有的
 * `1795300000000-ClientAccessGateSeed.ts` **撞了同一个时间戳**（TypeORM 平手 ⇒ 次序非确定）。
 * 合并裁决 = 主线保 1795300000000，本迁移让位 1795500000000（仍 > 既有最大 1795400000000）。
 * 本迁移此前从未在任何库执行过 ⇒ 改名不留已执行记录的孤儿。
 */
export class RiskWithdrawReAuthSeed1795500000000 implements MigrationInterface {
  name = 'RiskWithdrawReAuthSeed1795500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('risk.withdrawReAuthEnabled', 'false', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM `platform_config` WHERE `key` = 'risk.withdrawReAuthEnabled'",
    );
  }
}

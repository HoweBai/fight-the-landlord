import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 记牌器片：第 **50** 键 `game.cardCounterEnabled` 的种子迁移——
 * 斗地主牌桌记牌器总开关，严格 boolean，种子 **true**（保持现状）；
 * 管理后台置 false ⇒ 客户端左上角入口不渲染、累积器不启动。
 */
export class CardCounterSeed1795700000000 implements MigrationInterface {
  name = 'CardCounterSeed1795700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `value` 是 json 列：单引号里是 JSON boolean 字面量 true（严格 boolean——写入口拒字符串）。
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('game.cardCounterEnabled', 'true', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM `platform_config` WHERE `key` = 'game.cardCounterEnabled'");
  }
}

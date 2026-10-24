import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 记牌器收费片：第 **51/52** 键的价格种子迁移 ——
 * `game.cardCounterPricePerGameCoins`（10 金币/局）与
 * `game.cardCounterPricePerHourCoins`（100 金币/小时）。
 *
 * ⚠️ `value` 是 json 列：单引号里是 JSON number 字面量（严格整数——写入口拒字符串）。
 * ⚠️ 时间戳必须 > `1795700000000`（记牌器总开关种子）且全仓唯一。
 */
export class CardCounterPrices1795800000000 implements MigrationInterface {
  name = 'CardCounterPrices1795800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'INSERT IGNORE INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('game.cardCounterPricePerGameCoins', '10', 1, NOW(3), 'seed')," +
        "('game.cardCounterPricePerHourCoins', '100', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM `platform_config` WHERE `key` = 'game.cardCounterPricePerGameCoins'",
    );
    await queryRunner.query(
      "DELETE FROM `platform_config` WHERE `key` = 'game.cardCounterPricePerHourCoins'",
    );
  }
}

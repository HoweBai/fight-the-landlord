import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 配置中心持久表 `platform_config`（规格 §2.1 的 DDL 逐字）+ 九键种子（规格 §2.2：
 * 默认 = 种子 = 现值，含裁决 8 的 `friendRoomEnabled=false`）。
 *
 * ⚠️ **形状逐字照 `user-service` 的 `1789100000000-BaseScoreLevels.ts`**：类名 `<Name><时间戳>`、
 * `name` 属性与类名一致、SQL 用 `CREATE TABLE IF NOT EXISTS`、charset/排序规则逐字一致。
 *
 * ⚠️ **种子写在本迁移里**：迁移只跑一次（记录在**独立**的 `migrations_config` 表，
 * 见 `database.config.ts`），所以直接 `INSERT` 即可，不需要幂等写法。
 *
 * ⚠️ 时间戳 `1789200000000` 晚于 user-service 的两个迁移 —— 两服务的迁移表虽独立，
 * 但保持「同一库内时间戳单调」仍是排障友好的习惯。
 */
export class PlatformConfig1789200000000 implements MigrationInterface {
  name = 'PlatformConfig1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `platform_config` (' +
        '`key` varchar(64) NOT NULL, ' +
        '`value` json NOT NULL, ' +
        '`version` bigint NOT NULL DEFAULT 1, ' +
        '`updated_at` datetime(3) NOT NULL, ' +
        '`updated_by` varchar(64) NOT NULL, ' +
        'PRIMARY KEY (`key`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    // `value` 是 json 列：单引号里是合法 JSON 文本 ⇒ MySQL 8 按 JSON 解析入库
    // （`'true'`/`'60000'` 也是 JSON 字面量，不是字符串值）。
    await queryRunner.query(
      'INSERT INTO `platform_config` (`key`, `value`, `version`, `updated_at`, `updated_by`) VALUES ' +
        "('robot.skillDistribution', '{\"beginner\":0.15,\"intermediate\":0.35,\"advanced\":0.5}', 1, NOW(3), 'seed'), " +
        "('robot.ruleFallback', 'true', 1, NOW(3), 'seed'), " +
        "('robot.modelBySkill', '{\"beginner\":\"sl\",\"intermediate\":\"douzero_WP\",\"advanced\":\"douzero_ADP\"}', 1, NOW(3), 'seed'), " +
        "('robot.reclaimIntervalMs', '60000', 1, NOW(3), 'seed'), " +
        "('room.matchScanIntervalMs', '5000', 1, NOW(3), 'seed'), " +
        "('room.autostartIntervalMs', '5000', 1, NOW(3), 'seed'), " +
        "('room.reapIntervalMs', '60000', 1, NOW(3), 'seed'), " +
        "('room.friendRoomEnabled', 'false', 1, NOW(3), 'seed'), " +
        "('game.baseScoreLevels', '[{\"name\":\"休闲场\",\"baseScore\":15},{\"name\":\"标准场\",\"baseScore\":80},{\"name\":\"竞技场\",\"baseScore\":480},{\"name\":\"豪侠场\",\"baseScore\":1200}]', 1, NOW(3), 'seed')",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `platform_config`');
  }
}

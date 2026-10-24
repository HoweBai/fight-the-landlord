import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 底分档位表（规格 §2.2）。
 *
 * ⚠️ **片⑦（T13）起为遗留表/迁移，无读者，待确认后清理**：底分档位已收编进 config-service
 * 的配置中心（`game.baseScoreLevels` 五十一键之一）；迁移与建表**保留**（表留库，不删数据）。
 *
 * ⚠️ **形状逐字照 `InitialUsers1789000000000`**：类名 `<Name><timestamp>`、
 * `name` 属性与类名一致、SQL 用 `CREATE TABLE IF NOT EXISTS`。
 * `charset=utf8mb4` 与排序规则**必须**一致 —— 场次名是中文。
 *
 * ⚠️ **种子写在本迁移里**（规格 §2.2）：迁移只跑一次（TypeORM 记在 `migrations` 表），
 * 所以直接 `INSERT` 即可，不需要幂等写法。
 */
export class BaseScoreLevels1789100000000 implements MigrationInterface {
  name = 'BaseScoreLevels1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `base_score_levels` (' +
        '`id` int NOT NULL AUTO_INCREMENT, ' +
        '`name` varchar(32) NOT NULL, ' +
        '`base_score` int NOT NULL, ' +
        '`sort_order` int NOT NULL, ' +
        '`enabled` tinyint(1) NOT NULL DEFAULT 1, ' +
        'PRIMARY KEY (`id`), ' +
        'UNIQUE KEY `IDX_base_score_levels_base_score` (`base_score`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
    );
    await queryRunner.query(
      'INSERT INTO `base_score_levels` (`name`, `base_score`, `sort_order`, `enabled`) VALUES ' +
        "('休闲场', 15, 1, 1), ('标准场', 80, 2, 1), ('竞技场', 480, 3, 1), ('豪侠场', 1200, 4, 1)",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `base_score_levels`');
  }
}

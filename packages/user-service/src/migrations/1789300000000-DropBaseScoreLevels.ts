import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 删除遗留表 `base_score_levels`（台账 N47 关闭；设计 §5.2-8 / §10.3）。
 *
 * ⚠️ **为什么可以删**：底分档位已收编进 config-service 配置中心的 `game.baseScoreLevels` 键
 * （片⑦ T13 `0da4448` 起代码侧 entity / service / controller / RPC controller 全删）⇒
 * 旧表**零读取方**（T13 后本仓各服务 `src` 里 `base_score_levels` 只剩迁移文件自身）。
 *
 * ⚠️ **不删历史迁移文件**（`1789100000000-BaseScoreLevels.ts` 保留）：TypeORM 按时间戳顺序重放
 * ⇒ 新库 = 建表 → 删表 → **终态无表**；`down()` 即逆操作。历史完整、可回放，比「删文件」少一类
 * 未证实行为（r1 无法核验项：迁移表里有记录、代码里没这个类时 TypeORM 会怎么处理）。
 *
 * ⚠️ **形状逐字照 `InitialUsers1789000000000`**：类名 `<Name><timestamp>`、
 * `name` 属性与类名一致、SQL 幂等（`DROP TABLE IF EXISTS` —— 与建表迁移的
 * `CREATE TABLE IF NOT EXISTS` 同一条理由：迁移只跑一次，但重放/半执行场景下不许抛错）。
 *
 * ⚠️ **部署即执行**：`migrationsRun: true`（R248）⇒ 服务下一次启动时本删除**自动执行**，
 * 无需人工登库；执行记录落在 `migrations` 表（证据见债务清理批汇报）。
 */
export class DropBaseScoreLevels1789300000000 implements MigrationInterface {
  name = 'DropBaseScoreLevels1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `base_score_levels`');
  }

  /**
   * 逆操作 = **重建表结构**（照 `1789100000000-BaseScoreLevels` 的 create 语句逐字）。
   *
   * ⚠️ **空表即可**（不回填四档种子）：旧表零读者，回滚需要的性质是「表回来了」，
   * 不是「四行缺省回来了」—— 缺省四档的真源现在在 `platform_config`。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
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
  }
}

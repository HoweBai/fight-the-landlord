import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 结算销毁上账（本片 T2；设计 §2.1 / 规格 §2.1 **逐字**）：`currency_ops` 尾追两列 + 一索引。
 *  - `burned_residue` / `burned_rake`：**NULL = 未记录**（历史行/旧格式载荷）、`0 = 结算过且无销毁`
 *    —— 两态必须可区分（「不伪造读数」纪律）；不得改成 `NOT NULL DEFAULT 0`。
 *  - `idx_ops_source_created (source, created_at)`：summary 的 burn 块窗口合计走它
 *    （报表成本与历史总量脱钩）。
 * ⚠️ 类名不得叫 `Currency…`（migration.test 以 `/^Currency\d+$/` 取 readdir 首个匹配 ⇒ 抢位假红）。
 */
export class BurnOnOp1792022400000 implements MigrationInterface {
  name = 'BurnOnOp1792022400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `currency_ops` ' +
        'ADD COLUMN `burned_residue` int NULL DEFAULT NULL, ' +
        'ADD COLUMN `burned_rake` int NULL DEFAULT NULL, ' +
        'ADD KEY `idx_ops_source_created` (`source`, `created_at`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `currency_ops` ' +
        'DROP KEY `idx_ops_source_created`, ' +
        'DROP COLUMN `burned_rake`, ' +
        'DROP COLUMN `burned_residue`',
    );
  }
}

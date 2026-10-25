import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A2（spec D4/D5/§6.2）：`currency_ops.game_type` 历史回填（**数据迁移，可重入**）。
 *
 * - 只回填四个游戏相关来源；非游戏来源保持 NULL（未标注玩法）；
 * - keyset 分批（`id > ? ORDER BY id LIMIT 500`），避免 append-only 账本上的无界 UPDATE；
 * - 每批 `UPDATE ... WHERE id IN (...) AND game_type IS NULL` ⇒ 重跑幂等；
 * - `down` 为 no-op（列由 DDL 迁移的 down 删除；数据随之丢弃，可从来源重算）。
 */
export class GameTypeOnOpsBackfill1797000000001 implements MigrationInterface {
  name = 'GameTypeOnOpsBackfill1797000000001';

  /** 批次 SQL（测试按此全文识别）。 */
  static readonly SELECT_BATCH =
    'SELECT `id` FROM `currency_ops` ' +
    "WHERE `game_type` IS NULL AND `source` IN ('game_settle','robot_pool','entry_fee','card_counter') " +
    'AND `id` > ? ORDER BY `id` LIMIT 500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    let lastId = 0;
    for (;;) {
      const rows = (await queryRunner.query(GameTypeOnOpsBackfill1797000000001.SELECT_BATCH, [
        lastId,
      ])) as Array<{ id: unknown }>;
      if (rows.length === 0) return;
      const ids = rows.map((row) => Number(row.id));
      if (ids.some((id) => !Number.isSafeInteger(id))) {
        throw new Error(
          `currency_ops 回填：id 不是安全整数（收到 ${JSON.stringify(rows)}）—— 拒绝继续`,
        );
      }
      const placeholders = ids.map(() => '?').join(', ');
      await queryRunner.query(
        `UPDATE \`currency_ops\` SET \`game_type\` = 'doudizhu' WHERE \`id\` IN (${placeholders}) AND \`game_type\` IS NULL`,
        ids,
      );
      lastId = ids[ids.length - 1]!;
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no-op：回填数据由 DDL down 与列一起删除。
  }
}

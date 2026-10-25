import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A2（spec D9/§6.5）：PDK 玩家行逐座投影历史回填（**数据迁移，可重入**）。
 *
 * - 从父行 `score_changes` 的 `[{seat, delta}]` 取本座 delta；畸形/缺座 ⇒ 0；
 * - `won = seat === winner_seat`；
 * - keyset 分批（`id > ? ORDER BY id LIMIT 500`），每行 UPDATE 重算（重跑幂等）；
 * - `jsonOf` 双形态：`string ⇒ JSON.parse`，`object ⇒ 原样`（照 records.service 既有惯例）；
 * - `down` no-op（列由 DDL 迁移的 down 删除）。
 */
export class PdkRecordPlayerBackfill1797000000004 implements MigrationInterface {
  name = 'PdkRecordPlayerBackfill1797000000004';

  static readonly BATCH_SIZE = 500;

  static readonly SELECT_BATCH =
    'SELECT p.id, p.seat, r.winner_seat, r.score_changes ' +
    'FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id ' +
    'WHERE p.id > ? ORDER BY p.id LIMIT 500';

  static readonly UPDATE_ROW =
    'UPDATE `game_record_players_pdk` SET score_change = ?, won = ? WHERE id = ?';

  public async up(queryRunner: QueryRunner): Promise<void> {
    let lastId = 0;
    for (;;) {
      const rows = (await queryRunner.query(PdkRecordPlayerBackfill1797000000004.SELECT_BATCH, [
        lastId,
      ])) as Array<{
        id: unknown;
        seat: unknown;
        winner_seat: unknown;
        score_changes: unknown;
      }>;
      if (rows.length === 0) return;
      for (const row of rows) {
        const id = Number(row.id);
        const seat = Number(row.seat);
        const winnerSeat = Number(row.winner_seat);
        if (!Number.isSafeInteger(id) || !Number.isSafeInteger(seat)) {
          throw new Error(
            `game_record_players_pdk 回填：id/seat 不是安全整数（收到 ${JSON.stringify(row)}）—— 拒绝继续`,
          );
        }
        const delta = scoreChangesOf(row.score_changes).find((c) => c.seat === seat)?.delta ?? 0;
        const won = seat === winnerSeat ? 1 : 0;
        await queryRunner.query(PdkRecordPlayerBackfill1797000000004.UPDATE_ROW, [delta, won, id]);
      }
      lastId = Number(rows[rows.length - 1]!.id);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no-op：回填数据由 DDL down 与列一起删除。
  }
}

/** JSON 列双形态归一（string ⇒ parse；object ⇒ 原样；畸形 ⇒ []）。 */
function scoreChangesOf(raw: unknown): Array<{ seat: number; delta: number }> {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const seat = Number((item as { seat?: unknown }).seat);
    const delta = Number((item as { delta?: unknown }).delta);
    if (!Number.isSafeInteger(seat) || !Number.isSafeInteger(delta)) return [];
    return [{ seat, delta }];
  });
}

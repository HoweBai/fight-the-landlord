/**
 * C2 记录对账 SQL（只读；唯一真源；测试侧独立誊写 `toBe`）。
 *
 * 参数次序统一：`[from, to, lastId, pageSize]`。
 *  - `currency_ops.created_at` / `currency_entry_fee_skips.created_at` / ddz `game_records.ended_at`
 *    是 `DATETIME(3)` ⇒ 绑定 `Date`；
 *  - pdk `game_records_pdk.ended_at` 是 `BIGINT`（epoch ms）⇒ 绑定 number；
 *  - `lastId`/`pageSize` 绑定 number。
 * keyset：
 *  - ops/flows/skips 按各自 `id`；
 *  - records+players 按 **`p.id AS player_id`**（一局多行，按 `r.id` 会切掉同局剩余玩家）。
 */
export const RECORDS_RECONCILE_OPS_SQL =
  'SELECT o.id, o.action_id, o.ref_id, o.source, o.game_type, o.created_at, o.burned_residue, o.burned_rake ' +
  'FROM currency_ops o ' +
  "WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ? AND o.id > ? " +
  'ORDER BY o.id ASC LIMIT ?';

export const RECORDS_RECONCILE_FLOWS_SQL =
  'SELECT f.id, f.op_id, f.owner_id, f.owner_type, f.delta ' +
  'FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id ' +
  "WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ? AND f.id > ? " +
  'ORDER BY f.id ASC LIMIT ?';

export const RECORDS_RECONCILE_DDZ_SQL =
  'SELECT p.id AS player_id, r.id AS record_id, r.room_code, r.game_version, r.mode, r.base_score, r.ended_at, ' +
  'p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change ' +
  'FROM game_records r JOIN game_record_players p ON p.record_id = r.id ' +
  'WHERE r.ended_at >= ? AND r.ended_at < ? AND p.id > ? ' +
  'ORDER BY p.id ASC LIMIT ?';

export const RECORDS_RECONCILE_PDK_SQL =
  'SELECT p.id AS player_id, r.id AS record_id, r.room_code, r.game_version, r.game_type, r.mode, r.base_score, r.ended_at, ' +
  'p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change ' +
  'FROM game_records_pdk r JOIN game_record_players_pdk p ON p.record_id = r.id ' +
  'WHERE r.ended_at >= ? AND r.ended_at < ? AND p.id > ? ' +
  'ORDER BY p.id ASC LIMIT ?';

export const RECORDS_RECONCILE_SKIPS_SQL =
  'SELECT s.id, s.room_code, s.owner_id, s.game_type ' +
  'FROM currency_entry_fee_skips s ' +
  'WHERE s.created_at >= ? AND s.created_at < ? AND s.id > ? ' +
  'ORDER BY s.id ASC LIMIT ?';

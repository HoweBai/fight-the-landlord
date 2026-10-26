/**
 * C2（RecordsReconcileService）测试。
 *
 * 本文件先落 Task 1 的判据：13 个指标名 + 5 条 SQL 全文（测试侧独立誊写，禁 import 实现文本
 * 作断言 —— 实现漂移一个字符就红）。服务行为用例在 Task 2 追加。
 */
import { describe, expect, it } from 'vitest';
import { metricsRegistry } from '@fight-the-landlord/shared';
// 副作用导入：让 metrics 模块在 shared registry 上完成注册（本测试只读名字）。
import '../src/metrics/currency.metrics';
import {
  RECORDS_RECONCILE_DDZ_SQL,
  RECORDS_RECONCILE_FLOWS_SQL,
  RECORDS_RECONCILE_OPS_SQL,
  RECORDS_RECONCILE_PDK_SQL,
  RECORDS_RECONCILE_SKIPS_SQL,
} from '../src/reconcile/records-reconcile.sql';

const METRIC_NAMES = [
  'currency_records_reconcile_orphan_ops',
  'currency_records_reconcile_missing_ops',
  'currency_records_reconcile_null_no_op',
  'currency_records_reconcile_amount_mismatch',
  'currency_records_reconcile_pending',
  'currency_records_reconcile_null_money_delta',
  'currency_records_reconcile_entry_fee_suspect',
  'currency_records_reconcile_entry_fee_unknown',
  'currency_records_reconcile_entry_fee_orphan_ops',
  'currency_records_reconcile_config_unavailable',
  'currency_records_reconcile_truncated',
  'currency_records_reconcile_runs_total',
  'currency_records_reconcile_last_success_timestamp_seconds',
] as const;

describe('C2 指标名（只报不改）', () => {
  it('13 个指标全部注册在 shared registry', () => {
    for (const name of METRIC_NAMES) {
      expect(metricsRegistry().getSingleMetric(name), `${name} 不在 shared registry`).toBeDefined();
    }
  });
});

describe('C2 SQL 全文（独立誊写）', () => {
  it('OPS：source IN + 窗口 + id keyset', () => {
    expect(RECORDS_RECONCILE_OPS_SQL).toBe(
      'SELECT o.id, o.action_id, o.ref_id, o.source, o.game_type, o.created_at, o.burned_residue, o.burned_rake ' +
        'FROM currency_ops o ' +
        "WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ? AND o.id > ? " +
        'ORDER BY o.id ASC LIMIT ?',
    );
  });

  it('FLOWS：join ops + 窗口 + f.id keyset', () => {
    expect(RECORDS_RECONCILE_FLOWS_SQL).toBe(
      'SELECT f.id, f.op_id, f.owner_id, f.owner_type, f.delta ' +
        'FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id ' +
        "WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ? AND f.id > ? " +
        'ORDER BY f.id ASC LIMIT ?',
    );
  });

  it('DDZ：记录+玩家按 p.id（player_id）keyset（防多玩家记录跨页丢行）', () => {
    expect(RECORDS_RECONCILE_DDZ_SQL).toBe(
      'SELECT p.id AS player_id, r.id AS record_id, r.room_code, r.game_version, r.mode, r.base_score, r.ended_at, ' +
        'p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change ' +
        'FROM game_records r JOIN game_record_players p ON p.record_id = r.id ' +
        'WHERE r.ended_at >= ? AND r.ended_at < ? AND p.id > ? ' +
        'ORDER BY p.id ASC LIMIT ?',
    );
  });

  it('PDK：记录+玩家按 p.id，带 r.game_type', () => {
    expect(RECORDS_RECONCILE_PDK_SQL).toBe(
      'SELECT p.id AS player_id, r.id AS record_id, r.room_code, r.game_version, r.game_type, r.mode, r.base_score, r.ended_at, ' +
        'p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change ' +
        'FROM game_records_pdk r JOIN game_record_players_pdk p ON p.record_id = r.id ' +
        'WHERE r.ended_at >= ? AND r.ended_at < ? AND p.id > ? ' +
        'ORDER BY p.id ASC LIMIT ?',
    );
  });

  it('SKIPS：带 game_type + s.id keyset', () => {
    expect(RECORDS_RECONCILE_SKIPS_SQL).toBe(
      'SELECT s.id, s.room_code, s.owner_id, s.game_type ' +
        'FROM currency_entry_fee_skips s ' +
        'WHERE s.created_at >= ? AND s.created_at < ? AND s.id > ? ' +
        'ORDER BY s.id ASC LIMIT ?',
    );
  });
});

/**
 * C3 资金异常检测 —— `fund-scan.ts` 的**常量/SQL 判据面**（spec §5.2/§5.3）。
 *
 * 本文件从 Task 1 起逐任务扩展：
 *  - Task 1：8 条 SQL 全文/参数面/常量逐值；
 *  - Task 2：`FundScanCollector.collect` 的四信号判定、窗口、cap、降级/失败。
 *
 * ⚠️ SQL 文本是**测试侧独立誊写**（断言执行面，不是回抄实现常量）；任何一条漂移 ⇒ `toBe` 红。
 */
import { describe, expect, it } from 'vitest';
import {
  FUND_DETAIL_CAP,
  FUND_GROUP_CAP,
  FUND_MAX_REASONS_PER_CHECK_GAME,
  FUND_OPS_SQL,
  FUND_OPS_WINDOW_MS,
  FUND_PAIR_MIN_GAMES_24H,
  FUND_PAIR_MIN_GAMES_7D,
  FUND_PAIR_MIN_NET_WIN,
  FUND_PAIR_PDK_SQL,
  FUND_PAIR_WIN_RATE,
  FUND_QUERY_MAX_EXECUTION_MS,
  FUND_RAKE_COUNTS_DDZ_SQL,
  FUND_RAKE_COUNTS_PDK_SQL,
  FUND_RAKE_MIN_AMOUNT,
  FUND_RAKE_MIN_GAMES,
  FUND_SAME_DEVICE_DDZ_SQL,
  FUND_SAME_DEVICE_MIN_GAMES,
  FUND_SAME_DEVICE_PDK_SQL,
  FUND_SCAN_WINDOW_24H_MS,
  FUND_WIN_REFS_DDZ_SQL,
  FUND_WIN_REFS_PDK_SQL,
  FUND_WINDOW_7D_MS,
} from '../src/risk/fund-scan';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── 规格 §5.2：常量逐值（测试侧独立誊写）────────────────────────────────────

describe('C3 常量（spec §5.2）', () => {
  it('窗口/阈值/上限逐值', () => {
    expect(FUND_WINDOW_7D_MS).toBe(7 * DAY_MS);
    expect(FUND_SCAN_WINDOW_24H_MS).toBe(26 * HOUR_MS);
    expect(FUND_OPS_WINDOW_MS).toBe(27 * HOUR_MS);
    expect(FUND_SAME_DEVICE_MIN_GAMES).toBe(3);
    expect(FUND_PAIR_MIN_GAMES_7D).toBe(5);
    expect(FUND_PAIR_WIN_RATE).toBe(0.8);
    expect(FUND_PAIR_MIN_NET_WIN).toBe(1000);
    expect(FUND_PAIR_MIN_GAMES_24H).toBe(10);
    expect(FUND_RAKE_MIN_GAMES).toBe(20);
    expect(FUND_RAKE_MIN_AMOUNT).toBe(5000);
    expect(FUND_MAX_REASONS_PER_CHECK_GAME).toBe(3);
    expect(FUND_GROUP_CAP).toBe(5000);
    expect(FUND_DETAIL_CAP).toBe(200_000);
    expect(FUND_QUERY_MAX_EXECUTION_MS).toBe(30_000);
  });
});

// ─── 规格 §5.3：8 条 SQL 全文（独立誊写；`toBe` 全等）────────────────────────

describe('C3 SQL 全文（spec §5.3）', () => {
  it('① 同设备同桌 · 斗地主：设备 last_seen 窗 + 确定性 ORDER BY + LIMIT', () => {
    expect(FUND_SAME_DEVICE_DDZ_SQL).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.user_id AS user_a, b.user_id AS user_b, d.device_id AS device_id, COUNT(*) AS games ' +
        'FROM game_record_players a ' +
        'JOIN game_record_players b ON b.record_id = a.record_id AND b.user_id IS NOT NULL AND a.user_id < b.user_id AND b.is_robot = 0 ' +
        'JOIN game_records r ON r.id = a.record_id ' +
        'JOIN user_devices d ON d.user_id = a.user_id ' +
        'JOIN user_devices e ON e.user_id = b.user_id AND e.device_id = d.device_id ' +
        "JOIN users ua ON ua.id = a.user_id AND ua.status='active' " +
        "JOIN users ub ON ub.id = b.user_id AND ub.status='active' " +
        "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode IN ('random','gold') AND a.user_id IS NOT NULL AND a.is_robot = 0 AND d.last_seen_at >= ? AND e.last_seen_at >= ? " +
        'GROUP BY a.user_id, b.user_id, d.device_id ' +
        'HAVING COUNT(*) >= ? ' +
        'ORDER BY games DESC, a.user_id ASC, b.user_id ASC, d.device_id ASC ' +
        'LIMIT ?',
    );
  });

  it('② 同设备同桌 · 跑得快：同形 + _pdk 表', () => {
    expect(FUND_SAME_DEVICE_PDK_SQL).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.user_id AS user_a, b.user_id AS user_b, d.device_id AS device_id, COUNT(*) AS games ' +
        'FROM game_record_players_pdk a ' +
        'JOIN game_record_players_pdk b ON b.record_id = a.record_id AND b.user_id IS NOT NULL AND a.user_id < b.user_id AND b.is_robot = 0 ' +
        'JOIN game_records_pdk r ON r.id = a.record_id ' +
        'JOIN user_devices d ON d.user_id = a.user_id ' +
        'JOIN user_devices e ON e.user_id = b.user_id AND e.device_id = d.device_id ' +
        "JOIN users ua ON ua.id = a.user_id AND ua.status='active' " +
        "JOIN users ub ON ub.id = b.user_id AND ub.status='active' " +
        "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode IN ('random','gold') AND a.user_id IS NOT NULL AND a.is_robot = 0 AND d.last_seen_at >= ? AND e.last_seen_at >= ? " +
        'GROUP BY a.user_id, b.user_id, d.device_id ' +
        'HAVING COUNT(*) >= ? ' +
        'ORDER BY games DESC, a.user_id ASC, b.user_id ASC, d.device_id ASC ' +
        'LIMIT ?',
    );
  });

  it('③ PDK 2 人对子：7d 聚合 + 26h 条件计数', () => {
    expect(FUND_PAIR_PDK_SQL).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.user_id AS user_a, b.user_id AS user_b, COUNT(*) AS games_7d, SUM(CASE WHEN a.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins_a, SUM(CASE WHEN b.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins_b, COALESCE(SUM(a.money_delta), 0) AS net_a, COALESCE(SUM(b.money_delta), 0) AS net_b, SUM(CASE WHEN r.ended_at >= ? THEN 1 ELSE 0 END) AS games_24h ' +
        'FROM game_record_players_pdk a ' +
        'JOIN game_record_players_pdk b ON b.record_id = a.record_id AND b.user_id IS NOT NULL AND a.user_id < b.user_id AND b.is_robot = 0 ' +
        'JOIN game_records_pdk r ON r.id = a.record_id ' +
        "JOIN users ua ON ua.id = a.user_id AND ua.status='active' " +
        "JOIN users ub ON ub.id = b.user_id AND ub.status='active' " +
        "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.player_count = 2 AND r.mode IN ('random','gold') AND a.user_id IS NOT NULL AND a.is_robot = 0 " +
        'GROUP BY a.user_id, b.user_id ' +
        'HAVING COUNT(*) >= ? ' +
        'ORDER BY games_7d DESC, a.user_id ASC, b.user_id ASC ' +
        'LIMIT ?',
    );
  });

  it('④ 金币局局数 · 斗地主：mode=gold 精确 + 26h 窗', () => {
    expect(FUND_RAKE_COUNTS_DDZ_SQL).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(30000) */ p.user_id AS user_id, COUNT(*) AS games ' +
        'FROM game_record_players p ' +
        'JOIN game_records r ON r.id = p.record_id ' +
        "JOIN users u ON u.id = p.user_id AND u.status='active' " +
        "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 " +
        'GROUP BY p.user_id ' +
        'HAVING COUNT(*) >= ? ' +
        'ORDER BY games DESC, p.user_id ASC ' +
        'LIMIT ?',
    );
  });

  it('⑤ 金币局胜局 ref · 斗地主：p.won=1 + 确定性主键序', () => {
    expect(FUND_WIN_REFS_DDZ_SQL).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(30000) */ p.user_id AS user_id, r.room_code AS room_code, r.game_version AS game_version ' +
        'FROM game_record_players p ' +
        'JOIN game_records r ON r.id = p.record_id ' +
        "JOIN users u ON u.id = p.user_id AND u.status='active' " +
        "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 AND p.won = 1 " +
        'ORDER BY p.id ASC ' +
        'LIMIT ?',
    );
  });

  it('⑥ 金币局局数 · 跑得快：同形 + _pdk 表', () => {
    expect(FUND_RAKE_COUNTS_PDK_SQL).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(30000) */ p.user_id AS user_id, COUNT(*) AS games ' +
        'FROM game_record_players_pdk p ' +
        'JOIN game_records_pdk r ON r.id = p.record_id ' +
        "JOIN users u ON u.id = p.user_id AND u.status='active' " +
        "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 " +
        'GROUP BY p.user_id ' +
        'HAVING COUNT(*) >= ? ' +
        'ORDER BY games DESC, p.user_id ASC ' +
        'LIMIT ?',
    );
  });

  it('⑦ 金币局胜局 ref · 跑得快：p.won=1（A2 迁移已回填）', () => {
    expect(FUND_WIN_REFS_PDK_SQL).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(30000) */ p.user_id AS user_id, r.room_code AS room_code, r.game_version AS game_version ' +
        'FROM game_record_players_pdk p ' +
        'JOIN game_records_pdk r ON r.id = p.record_id ' +
        "JOIN users u ON u.id = p.user_id AND u.status='active' " +
        "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 AND p.won = 1 " +
        'ORDER BY p.id ASC ' +
        'LIMIT ?',
    );
  });

  it('⑧ 结算 op 抽水：source=game_settle + 27h 窗 + 非 NULL', () => {
    expect(FUND_OPS_SQL).toBe(
      'SELECT /*+ MAX_EXECUTION_TIME(30000) */ o.ref_id AS ref_id, o.burned_rake AS burned_rake ' +
        'FROM currency_ops o ' +
        "WHERE o.source = 'game_settle' AND o.created_at >= ? AND o.created_at < ? AND o.burned_rake IS NOT NULL " +
        'ORDER BY o.id ASC ' +
        'LIMIT ?',
    );
  });
});

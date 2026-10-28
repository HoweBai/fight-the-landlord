// packages/user-service/src/risk/fund-scan.ts
import type { GameType } from '@fight-the-landlord/protocol';
import type { ScanReason } from './reviews.service';

/**
 * C3 资金异常检测 —— 四信号的**只读采集与判定**（spec
 * `docs/superpowers/specs/2026-10-28-pdk-trust-c3-fund-anomaly-design.md` §5）。
 *
 * ─── 归属与边界（spec D1/D13）────────────────────────────────────────────
 *  - 本文件**不持状态机**：只读 8 条查询 → 产出 `FundCollection`；评分/队列/降级由
 *    `ScanService` + `ReviewsService` 现有唯一写入口承担（同一轮同一快照）。
 *  - `currency_ops` 与记录表**只读**（零 INSERT/UPDATE/DELETE）；`currency_ops` 走
 *    `idx_ops_source_created`（`source='game_settle' AND created_at` 窗口），内存按 `ref_id' 关联
 *    —— `ref_id` 无索引，禁止按它 JOIN 记录表（spec D13）。
 *  - 每条 SQL 带 MySQL 优化器提示 `MAX_EXECUTION_TIME(30000)`（成本上限）与确定性 `ORDER BY`
 *    （截断/复跑结果确定）；`LIMIT` 只是结果上限，超行 = `truncated`（该查询结果整段丢弃）。
 *
 * ─── 四信号（spec D2/D5–D8）─────────────────────────────────────────────
 *  - `sameDevice`：同 `device_id` 且同桌 ≥3 局（7d 窗；两条设备行都必须 7d 内见过）——两玩法；
 *  - `pairWinRate`：PDK 2 人固定对子 ≥5 局（7d），同一方胜率 ≥80% 且该方净赢 ≥1000 金币；
 *  - `pairFrequency`：PDK 2 人固定对子 ≥10 局（「24h」口径，扫窗 26h，吸收 C1 晚到）；
 *  - `highRake`：金币局（`mode='gold'`）「24h」口径 ≥20 局，且获胜局对应 settle op 的
 *    `Σmax(burned_rake)` ≥5000（同 ref 取最大；NULL 跳过）。
 *  对子两侧账号都记命中；四信号合并为评分的一项 `hit3`（`ScanService` 侧）。
 *
 * ─── 窗口（spec D3）─────────────────────────────────────────────────────
 *  - 7d = `FUND_WINDOW_7D_MS`；
 *  - 「24h」信号扫窗 = **26h**（24h + C1 outbox 24h 晚到与 1h 扫描周期/相位的余量；非硬保证，
 *    见 spec §6.1-7）；
 *  - ops 扫窗 = 27h（26h + `settle:outbox` 1h TTL）。
 *  全部按记录 `ended_at` 计数（DDZ `DATETIME(3)` ⇒ 绑 Date；PDK `BIGINT` ⇒ 绑 number ms）。
 */

// ─── 常量（spec §5.2；测试侧独立誊写）────────────────────────────────────────

/** 7d 窗（`sameDevice` / `pairWinRate`）。 */
export const FUND_WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
/** 「24h」口径的**扫窗** 26h（24h + 2h 晚到/相位余量；spec D3）。 */
export const FUND_SCAN_WINDOW_24H_MS = 26 * 60 * 60 * 1000;
/** 结算 op 扫窗 27h（26h + settle outbox 1h TTL；spec D13）。 */
export const FUND_OPS_WINDOW_MS = 27 * 60 * 60 * 1000;

/** 同设备同桌最少局数（U7：7d≥3）。 */
export const FUND_SAME_DEVICE_MIN_GAMES = 3;
/** 对子胜率最少局数（U7：7d≥5）。 */
export const FUND_PAIR_MIN_GAMES_7D = 5;
/** 对子胜率阈值（U7：≥80%）。 */
export const FUND_PAIR_WIN_RATE = 0.8;
/** 对子净赢门槛（U7：≥1000 金币）。 */
export const FUND_PAIR_MIN_NET_WIN = 1000;
/** 对子频次门槛（U7：24h≥10 局；扫窗 26h）。 */
export const FUND_PAIR_MIN_GAMES_24H = 10;
/** 高抽水最少金币局数（U7：24h≥20 局；扫窗 26h）。 */
export const FUND_RAKE_MIN_GAMES = 20;
/** 高抽水金额门槛（U7：抽水上界≥5000 金币）。 */
export const FUND_RAKE_MIN_AMOUNT = 5000;

/** 每个 `(check, gameType)` 每用户 reasons 上限（spec D10：按玩法分别封顶，防证据互挤）。 */
export const FUND_MAX_REASONS_PER_CHECK_GAME = 3;
/** 分组查询结果上限（同设备/对子/局数）。 */
export const FUND_GROUP_CAP = 5000;
/** 明细查询结果上限（胜局 ref / settle op）。 */
export const FUND_DETAIL_CAP = 200_000;
/** 单查询成本上限（MySQL 优化器提示；超时按 `sql` 失败计）。 */
export const FUND_QUERY_MAX_EXECUTION_MS = 30_000;

// ─── SQL（spec §5.3 逐字；`?` 占位次序见每段注释）────────────────────────────

/**
 * ① 同设备同桌 · 斗地主。
 * params: `[from7d:Date, now:Date, deviceFrom:Date, deviceFrom:Date, min:number, limit:number]`
 */
export const FUND_SAME_DEVICE_DDZ_SQL =
  `SELECT /*+ MAX_EXECUTION_TIME(${FUND_QUERY_MAX_EXECUTION_MS}) */ a.user_id AS user_a, b.user_id AS user_b, d.device_id AS device_id, COUNT(*) AS games ` +
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
  'LIMIT ?';

/**
 * ② 同设备同桌 · 跑得快（params 同 ①；表 = `_pdk`）。
 */
export const FUND_SAME_DEVICE_PDK_SQL =
  `SELECT /*+ MAX_EXECUTION_TIME(${FUND_QUERY_MAX_EXECUTION_MS}) */ a.user_id AS user_a, b.user_id AS user_b, d.device_id AS device_id, COUNT(*) AS games ` +
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
  'LIMIT ?';

/**
 * ③ PDK 2 人对子（7d 聚合 + 26h 条件计数）。
 * params: `[cutoff26h:number, from7d:number, now:number, min7d:number, limit:number]`
 */
export const FUND_PAIR_PDK_SQL =
  `SELECT /*+ MAX_EXECUTION_TIME(${FUND_QUERY_MAX_EXECUTION_MS}) */ a.user_id AS user_a, b.user_id AS user_b, COUNT(*) AS games_7d, SUM(CASE WHEN a.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins_a, SUM(CASE WHEN b.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins_b, COALESCE(SUM(a.money_delta), 0) AS net_a, COALESCE(SUM(b.money_delta), 0) AS net_b, SUM(CASE WHEN r.ended_at >= ? THEN 1 ELSE 0 END) AS games_24h ` +
  'FROM game_record_players_pdk a ' +
  'JOIN game_record_players_pdk b ON b.record_id = a.record_id AND b.user_id IS NOT NULL AND a.user_id < b.user_id AND b.is_robot = 0 ' +
  'JOIN game_records_pdk r ON r.id = a.record_id ' +
  "JOIN users ua ON ua.id = a.user_id AND ua.status='active' " +
  "JOIN users ub ON ub.id = b.user_id AND ub.status='active' " +
  "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.player_count = 2 AND r.mode IN ('random','gold') AND a.user_id IS NOT NULL AND a.is_robot = 0 " +
  'GROUP BY a.user_id, b.user_id ' +
  'HAVING COUNT(*) >= ? ' +
  'ORDER BY games_7d DESC, a.user_id ASC, b.user_id ASC ' +
  'LIMIT ?';

/**
 * ④ 金币局局数 · 斗地主。
 * params: `[from26h:Date, now:Date, min:number, limit:number]`
 */
export const FUND_RAKE_COUNTS_DDZ_SQL =
  `SELECT /*+ MAX_EXECUTION_TIME(${FUND_QUERY_MAX_EXECUTION_MS}) */ p.user_id AS user_id, COUNT(*) AS games ` +
  'FROM game_record_players p ' +
  'JOIN game_records r ON r.id = p.record_id ' +
  "JOIN users u ON u.id = p.user_id AND u.status='active' " +
  "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 " +
  'GROUP BY p.user_id ' +
  'HAVING COUNT(*) >= ? ' +
  'ORDER BY games DESC, p.user_id ASC ' +
  'LIMIT ?';

/**
 * ⑤ 金币局胜局 ref · 斗地主。
 * params: `[from26h:Date, now:Date, limit:number]`
 */
export const FUND_WIN_REFS_DDZ_SQL =
  `SELECT /*+ MAX_EXECUTION_TIME(${FUND_QUERY_MAX_EXECUTION_MS}) */ p.user_id AS user_id, r.room_code AS room_code, r.game_version AS game_version ` +
  'FROM game_record_players p ' +
  'JOIN game_records r ON r.id = p.record_id ' +
  "JOIN users u ON u.id = p.user_id AND u.status='active' " +
  "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 AND p.won = 1 " +
  'ORDER BY p.id ASC ' +
  'LIMIT ?';

/**
 * ⑥ 金币局局数 · 跑得快（params 同 ④；表 = `_pdk`）。
 */
export const FUND_RAKE_COUNTS_PDK_SQL =
  `SELECT /*+ MAX_EXECUTION_TIME(${FUND_QUERY_MAX_EXECUTION_MS}) */ p.user_id AS user_id, COUNT(*) AS games ` +
  'FROM game_record_players_pdk p ' +
  'JOIN game_records_pdk r ON r.id = p.record_id ' +
  "JOIN users u ON u.id = p.user_id AND u.status='active' " +
  "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 " +
  'GROUP BY p.user_id ' +
  'HAVING COUNT(*) >= ? ' +
  'ORDER BY games DESC, p.user_id ASC ' +
  'LIMIT ?';

/**
 * ⑦ 金币局胜局 ref · 跑得快（params 同 ⑤；`p.won` 自 A2 迁移起存在并已回填）。
 */
export const FUND_WIN_REFS_PDK_SQL =
  `SELECT /*+ MAX_EXECUTION_TIME(${FUND_QUERY_MAX_EXECUTION_MS}) */ p.user_id AS user_id, r.room_code AS room_code, r.game_version AS game_version ` +
  'FROM game_record_players_pdk p ' +
  'JOIN game_records_pdk r ON r.id = p.record_id ' +
  "JOIN users u ON u.id = p.user_id AND u.status='active' " +
  "WHERE r.ended_at >= ? AND r.ended_at < ? AND r.mode = 'gold' AND p.user_id IS NOT NULL AND p.is_robot = 0 AND p.won = 1 " +
  'ORDER BY p.id ASC ' +
  'LIMIT ?';

/**
 * ⑧ 结算 op 抽水（params: `[from27h:Date, now:Date, limit:number]`）。
 */
export const FUND_OPS_SQL =
  `SELECT /*+ MAX_EXECUTION_TIME(${FUND_QUERY_MAX_EXECUTION_MS}) */ o.ref_id AS ref_id, o.burned_rake AS burned_rake ` +
  'FROM currency_ops o ' +
  "WHERE o.source = 'game_settle' AND o.created_at >= ? AND o.created_at < ? AND o.burned_rake IS NOT NULL " +
  'ORDER BY o.id ASC ' +
  'LIMIT ?';

// ─── 采集结果的类型面（Task 2 实现 `FundScanCollector`）────────────────────────

/** 四信号。 */
export type FundCheck = 'sameDevice' | 'pairWinRate' | 'pairFrequency' | 'highRake';

/** 失败查询的归属：两玩法 + 跨玩法的 ops。 */
export type FundScope = 'doudizhu' | 'paodekuai' | 'ops';

/** 失败原因：SQL 失败/超时 = `sql`；结果超 cap = `truncated`（spec D12）。 */
export interface FundFailure {
  scope: FundScope;
  reason: 'sql' | 'truncated';
}

/** 去重后的命中项（每用户每 check 每玩法一条；指标写点用）。 */
export interface FundHit {
  check: FundCheck;
  gameType: GameType;
}

/** 一轮采集的完整产出。 */
export interface FundCollection {
  /** 每用户 cap 后的 reasons（排序确定；不含胜率/设备）。 */
  reasonsByUser: Map<string, ScanReason[]>;
  /** 每用户去重命中项（`(check, gameType)` 唯一）。 */
  hitsByUser: Map<string, FundHit[]>;
  /** C3 命中用户数（只算 C3）。 */
  hitUsers: number;
  /** 需要冻结的玩法（查询失败/截断）。 */
  degradedGames: GameType[];
  /** 失败查询清单（gauge 写点用）。 */
  failures: FundFailure[];
}

// packages/user-service/src/risk/fund-scan.ts
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
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
  /** 被 `(check, gameType)` 封顶丢弃的 reason 条数（可观测性；spec D10）。 */
  droppedByCap: number;
  /** 需要冻结的玩法（查询失败/截断）。 */
  degradedGames: GameType[];
  /** 失败查询清单（gauge 写点用）。 */
  failures: FundFailure[];
}

/** 采集的可注入面（测试用小窗口/小 cap；生产用默认常量）。 */
export interface FundScanOptions {
  window7dMs?: number;
  scanWindow24hMs?: number;
  opsWindowMs?: number;
  groupCap?: number;
  detailCap?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const FUND_CHECK_ORDER: Record<FundCheck, number> = {
  sameDevice: 0,
  pairWinRate: 1,
  pairFrequency: 2,
  highRake: 3,
};
// C3 只产 doudizhu/paodekuai；`mahjong` 键仅用于 `GameType` 全集穷尽（并入麻将后必须补，
// 否则 `Record<GameType, number>` 缺键 ⇒ tsc 红）。排序值永不被读。
const FUND_GAME_ORDER: Record<GameType, number> = { doudizhu: 0, paodekuai: 1, mahjong: 2 };

/** `Number()` 归一（mysql2 的 COUNT/SUM 可能回字符串）；非有限 ⇒ 0。 */
function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

interface SameDeviceRow {
  user_a: unknown;
  user_b: unknown;
  device_id: unknown;
  games: unknown;
}

interface PairRow {
  user_a: unknown;
  user_b: unknown;
  games_7d: unknown;
  wins_a: unknown;
  wins_b: unknown;
  net_a: unknown;
  net_b: unknown;
  games_24h: unknown;
}

interface CountRow {
  user_id: unknown;
  games: unknown;
}

interface WinRefRow {
  user_id: unknown;
  room_code: unknown;
  game_version: unknown;
}

interface OpRow {
  ref_id: unknown;
  burned_rake: unknown;
}

/** 排序/封顶前的中间项。`sortKey` 越大越严重；`tie` 定序。 */
interface FundEntry {
  check: FundCheck;
  gameType: GameType;
  sortKey: number;
  tie: string;
  reason: ScanReason;
}

/**
 * C3 四信号的只读采集器（spec §5.4）。
 *
 * 单查询失败/超行**不抛**：记 `failures` 并把对应玩法加入 `degradedGames`（ops 失败 ⇒ 两玩法），
 * 其余查询继续 —— 「部分可用优于整轮失败」；正确性不依赖 SQL 的 `HAVING`（JS 侧全部复核）。
 * 误释放防线：查询失败的游戏被降级 ⇒ `ScanService` 把 `degradedGames` 传给状态机冻结该玩法。
 */
export class FundScanCollector {
  private readonly logger = new Logger(FundScanCollector.name);

  constructor(private readonly dataSource: DataSource) {}

  async collect(now: number, opts: FundScanOptions = {}): Promise<FundCollection> {
    const window7dMs = opts.window7dMs ?? FUND_WINDOW_7D_MS;
    const scanWindow24hMs = opts.scanWindow24hMs ?? FUND_SCAN_WINDOW_24H_MS;
    const opsWindowMs = opts.opsWindowMs ?? FUND_OPS_WINDOW_MS;
    const groupCap = opts.groupCap ?? FUND_GROUP_CAP;
    const detailCap = opts.detailCap ?? FUND_DETAIL_CAP;

    const nowDate = new Date(now);
    const from7d = new Date(now - window7dMs);
    const from26h = new Date(now - scanWindow24hMs);
    const from27h = new Date(now - opsWindowMs);
    // ⚠️ 时间列口径（2026-10-29 真栈实证）：PDK 记录表 `ended_at` 是 **BIGINT epoch-ms**
    //（A2/麻将记录迁移），查询 ②⑥⑦ 的时间窗必须绑 `number`；绑 `Date` 会被 MySQL 当字符串
    // 转数字（只取年份前缀）⇒ 窗口恒空、sameDevice(pdk) / highRake(pdk) 静默不响。
    // 设备 `last_seen_at` 与 `currency_ops.created_at` 仍是 DATETIME ⇒ 继续绑 `Date`。
    const nowMs = now;
    const from7dMs = now - window7dMs;
    const from26hMs = now - scanWindow24hMs;
    const windowHours7d = Math.round(window7dMs / HOUR_MS);
    const windowHours24h = Math.round(scanWindow24hMs / HOUR_MS);

    const failures: FundFailure[] = [];
    const degraded = new Set<GameType>();
    const degrade = (scope: FundScope): void => {
      if (scope === 'doudizhu') degraded.add('doudizhu');
      else if (scope === 'paodekuai') degraded.add('paodekuai');
      else {
        degraded.add('doudizhu');
        degraded.add('paodekuai');
      }
    };

    /** 单查询：失败/超行 ⇒ 记录 + 降级 + 返回 null（该查询结果整段丢弃）。 */
    const run = async <T>(
      sql: string,
      params: unknown[],
      scope: FundScope,
      cap: number,
    ): Promise<T[] | null> => {
      try {
        const rows = (await this.dataSource.query(sql, params)) as T[];
        if (rows.length > cap) {
          failures.push({ scope, reason: 'truncated' });
          degrade(scope);
          this.logger.error(
            `fund scan query truncated: scope=${scope} rows=${rows.length} cap=${cap}（结果整段丢弃）`,
          );
          return null;
        }
        return rows;
      } catch (err) {
        failures.push({ scope, reason: 'sql' });
        degrade(scope);
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error(`fund scan query failed: scope=${scope} reason=${reason}`);
        return null;
      }
    };

    // 顺序固定（spec §5.4；测试按此钉调用次序）。
    const sameDeviceDdz = await run<SameDeviceRow>(
      FUND_SAME_DEVICE_DDZ_SQL,
      [from7d, nowDate, from7d, from7d, FUND_SAME_DEVICE_MIN_GAMES, groupCap + 1],
      'doudizhu',
      groupCap,
    );
    const sameDevicePdk = await run<SameDeviceRow>(
      FUND_SAME_DEVICE_PDK_SQL,
      // 前两参 = PDK BIGINT ended_at（number）；后两参 = user_devices DATETIME last_seen_at（Date）。
      [from7dMs, nowMs, from7d, from7d, FUND_SAME_DEVICE_MIN_GAMES, groupCap + 1],
      'paodekuai',
      groupCap,
    );
    const pairRows = await run<PairRow>(
      FUND_PAIR_PDK_SQL,
      [now - scanWindow24hMs, now - window7dMs, now, FUND_PAIR_MIN_GAMES_7D, groupCap + 1],
      'paodekuai',
      groupCap,
    );
    const countsDdz = await run<CountRow>(
      FUND_RAKE_COUNTS_DDZ_SQL,
      [from26h, nowDate, FUND_RAKE_MIN_GAMES, groupCap + 1],
      'doudizhu',
      groupCap,
    );
    const refsDdz = await run<WinRefRow>(
      FUND_WIN_REFS_DDZ_SQL,
      [from26h, nowDate, detailCap + 1],
      'doudizhu',
      detailCap,
    );
    const countsPdk = await run<CountRow>(
      FUND_RAKE_COUNTS_PDK_SQL,
      [from26hMs, nowMs, FUND_RAKE_MIN_GAMES, groupCap + 1],
      'paodekuai',
      groupCap,
    );
    const refsPdk = await run<WinRefRow>(
      FUND_WIN_REFS_PDK_SQL,
      [from26hMs, nowMs, detailCap + 1],
      'paodekuai',
      detailCap,
    );
    const ops = await run<OpRow>(
      FUND_OPS_SQL,
      [from27h, nowDate, detailCap + 1],
      'ops',
      detailCap,
    );

    const entriesByUser = new Map<string, FundEntry[]>();
    const add = (
      userId: unknown,
      check: FundCheck,
      gameType: GameType,
      sortKey: number,
      tie: string,
      detail: Record<string, unknown>,
    ): void => {
      const id = String(userId);
      if (id.length === 0 || id === 'null' || id === 'undefined') return;
      let list = entriesByUser.get(id);
      if (list === undefined) {
        list = [];
        entriesByUser.set(id, list);
      }
      list.push({ check, gameType, sortKey, tie, reason: { check, detail } });
    };

    // ── 同设备同桌（① ②）：games 再复核（正确性不依赖 SQL HAVING）───────────────
    for (const [rows, gameType] of [
      [sameDeviceDdz, 'doudizhu'],
      [sameDevicePdk, 'paodekuai'],
    ] as const) {
      for (const row of rows ?? []) {
        const games = toInt(row.games);
        if (games < FUND_SAME_DEVICE_MIN_GAMES) continue;
        const deviceId = String(row.device_id);
        add(row.user_a, 'sameDevice', gameType, games, `${String(row.user_b)}|${deviceId}`, {
          gameType,
          windowHours: windowHours7d,
          pairUserId: String(row.user_b),
          deviceId,
          games,
        });
        add(row.user_b, 'sameDevice', gameType, games, `${String(row.user_a)}|${deviceId}`, {
          gameType,
          windowHours: windowHours7d,
          pairUserId: String(row.user_a),
          deviceId,
          games,
        });
      }
    }

    // ── PDK 2 人对子（③）────────────────────────────────────────────────────
    for (const row of pairRows ?? []) {
      const games = toInt(row.games_7d);
      if (games < FUND_PAIR_MIN_GAMES_7D) continue;
      const winsA = toInt(row.wins_a);
      const winsB = toInt(row.wins_b);
      const netA = toInt(row.net_a);
      const netB = toInt(row.net_b);
      const dominantUserId = winsA >= winsB ? String(row.user_a) : String(row.user_b);
      const wins = Math.max(winsA, winsB);
      const winRate = wins / games;
      const netWin = winsA >= winsB ? netA : netB;

      if (winRate >= FUND_PAIR_WIN_RATE && netWin >= FUND_PAIR_MIN_NET_WIN) {
        add(row.user_a, 'pairWinRate', 'paodekuai', netWin, String(row.user_b), {
          gameType: 'paodekuai',
          playerCount: 2,
          windowHours: windowHours7d,
          pairUserId: String(row.user_b),
          dominantUserId,
          games,
          wins,
          winRate,
          netWin,
        });
        add(row.user_b, 'pairWinRate', 'paodekuai', netWin, String(row.user_a), {
          gameType: 'paodekuai',
          playerCount: 2,
          windowHours: windowHours7d,
          pairUserId: String(row.user_a),
          dominantUserId,
          games,
          wins,
          winRate,
          netWin,
        });
      }

      const games24h = toInt(row.games_24h);
      if (games24h >= FUND_PAIR_MIN_GAMES_24H) {
        add(row.user_a, 'pairFrequency', 'paodekuai', games24h, String(row.user_b), {
          gameType: 'paodekuai',
          playerCount: 2,
          windowHours: windowHours24h,
          pairUserId: String(row.user_b),
          games: games24h,
        });
        add(row.user_b, 'pairFrequency', 'paodekuai', games24h, String(row.user_a), {
          gameType: 'paodekuai',
          playerCount: 2,
          windowHours: windowHours24h,
          pairUserId: String(row.user_a),
          games: games24h,
        });
      }
    }

    // ── 高抽水（④–⑦ ⑧）：金币局 ≥20 + 胜局抽水上界 ≥5000 ──────────────────────
    const refRake = new Map<string, number>();
    for (const row of ops ?? []) {
      const ref = String(row.ref_id);
      const rake = toInt(row.burned_rake);
      const prev = refRake.get(ref);
      if (prev === undefined || rake > prev) refRake.set(ref, rake); // 同 ref 取 max（防 r2/重试双计）
    }
    const rakeByGame: Array<{
      gameType: GameType;
      counts: CountRow[] | null;
      refs: WinRefRow[] | null;
    }> = [
      { gameType: 'doudizhu', counts: countsDdz, refs: refsDdz },
      { gameType: 'paodekuai', counts: countsPdk, refs: refsPdk },
    ];
    for (const { gameType, counts, refs } of rakeByGame) {
      if (counts === null || refs === null || ops === null) continue; // 数据不全 ⇒ 该玩法已降级
      const qualifying = new Map<string, number>();
      for (const row of counts) {
        const games = toInt(row.games);
        if (games >= FUND_RAKE_MIN_GAMES) qualifying.set(String(row.user_id), games);
      }
      if (qualifying.size === 0) continue;
      const rakeUpper = new Map<string, number>();
      for (const row of refs) {
        const userId = String(row.user_id);
        if (!qualifying.has(userId)) continue;
        const ref = `${String(row.room_code)}:${String(row.game_version)}`;
        const rake = refRake.get(ref);
        if (rake !== undefined) rakeUpper.set(userId, (rakeUpper.get(userId) ?? 0) + rake);
      }
      for (const [userId, games] of qualifying) {
        const rakeUpperBound = rakeUpper.get(userId) ?? 0;
        if (rakeUpperBound < FUND_RAKE_MIN_AMOUNT) continue;
        add(userId, 'highRake', gameType, rakeUpperBound, '', {
          gameType,
          windowHours: windowHours24h,
          games,
          rakeUpperBound,
        });
      }
    }

    // ── 排序 + 每 (check, gameType) 封顶 + 落 Map ─────────────────────────────
    const reasonsByUser = new Map<string, ScanReason[]>();
    const hitsByUser = new Map<string, FundHit[]>();
    let droppedByCap = 0;
    for (const [userId, list] of entriesByUser) {
      list.sort(
        (a, b) =>
          FUND_CHECK_ORDER[a.check] - FUND_CHECK_ORDER[b.check] ||
          FUND_GAME_ORDER[a.gameType] - FUND_GAME_ORDER[b.gameType] ||
          b.sortKey - a.sortKey ||
          a.tie.localeCompare(b.tie),
      );
      const kept: ScanReason[] = [];
      const perKey = new Map<string, number>();
      const hits = new Map<string, FundHit>();
      for (const entry of list) {
        const key = `${entry.check}:${entry.gameType}`;
        hits.set(key, { check: entry.check, gameType: entry.gameType });
        const keptCount = perKey.get(key) ?? 0;
        if (keptCount >= FUND_MAX_REASONS_PER_CHECK_GAME) {
          droppedByCap += 1;
          continue;
        }
        perKey.set(key, keptCount + 1);
        kept.push(entry.reason);
      }
      if (kept.length > 0) {
        reasonsByUser.set(userId, kept);
        hitsByUser.set(userId, [...hits.values()]);
      }
    }

    return {
      reasonsByUser,
      hitsByUser,
      hitUsers: reasonsByUser.size,
      droppedByCap,
      degradedGames: (['doudizhu', 'paodekuai'] as const).filter((game) => degraded.has(game)),
      failures,
    };
  }
}

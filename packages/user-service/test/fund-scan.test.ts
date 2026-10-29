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
  FundScanCollector,
  type FundCollection,
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

// ─── Task 2：FundScanCollector（四信号判定/窗口/降级/cap）────────────────────────

const T0 = Date.parse('2026-10-28T12:00:00.000Z');

type Row = Record<string, unknown>;

/** 8 条 SQL 的回执面（按常量精确识别；未识别 ⇒ reject，形状漂移当场红）。 */
class FakeFundDb {
  sameDeviceDdz: Row[] = [];
  sameDevicePdk: Row[] = [];
  pair: Row[] = [];
  countsDdz: Row[] = [];
  refsDdz: Row[] = [];
  countsPdk: Row[] = [];
  refsPdk: Row[] = [];
  ops: Row[] = [];
  failSql = new Set<string>();
  queries: Array<{ sql: string; params: unknown[] }> = [];

  dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.queries.push({ sql, params });
      if (this.failSql.has(sql)) return Promise.reject(new Error('db down（仿真）'));
      switch (sql) {
        case FUND_SAME_DEVICE_DDZ_SQL:
          return Promise.resolve(this.sameDeviceDdz);
        case FUND_SAME_DEVICE_PDK_SQL:
          return Promise.resolve(this.sameDevicePdk);
        case FUND_PAIR_PDK_SQL:
          return Promise.resolve(this.pair);
        case FUND_RAKE_COUNTS_DDZ_SQL:
          return Promise.resolve(this.countsDdz);
        case FUND_WIN_REFS_DDZ_SQL:
          return Promise.resolve(this.refsDdz);
        case FUND_RAKE_COUNTS_PDK_SQL:
          return Promise.resolve(this.countsPdk);
        case FUND_WIN_REFS_PDK_SQL:
          return Promise.resolve(this.refsPdk);
        case FUND_OPS_SQL:
          return Promise.resolve(this.ops);
        default:
          return Promise.reject(new Error(`FakeFundDb 未识别的 SQL：${sql}`));
      }
    },
  };
}

const collect = (db: FakeFundDb, now = T0, opts = {}) =>
  new FundScanCollector(db.dataSource as never).collect(now, opts);

const reasonsOf = (result: FundCollection, user: string, check: string) =>
  (result.reasonsByUser.get(user) ?? []).filter((reason) => reason.check === check);

describe('C3 FundScanCollector（spec §5.4）', () => {
  it('查询顺序固定 + 窗口参数逐毫秒（DDZ/设备/ops = Date；PDK ended_at = number；LIMIT = cap+1）', async () => {
    const db = new FakeFundDb();

    await collect(db);

    expect(db.queries.map((q) => q.sql)).toEqual([
      FUND_SAME_DEVICE_DDZ_SQL,
      FUND_SAME_DEVICE_PDK_SQL,
      FUND_PAIR_PDK_SQL,
      FUND_RAKE_COUNTS_DDZ_SQL,
      FUND_WIN_REFS_DDZ_SQL,
      FUND_RAKE_COUNTS_PDK_SQL,
      FUND_WIN_REFS_PDK_SQL,
      FUND_OPS_SQL,
    ]);
    const from7d = new Date(T0 - FUND_WINDOW_7D_MS);
    const from26h = new Date(T0 - FUND_SCAN_WINDOW_24H_MS);
    const from27h = new Date(T0 - FUND_OPS_WINDOW_MS);
    expect(db.queries[0]!.params).toEqual([
      from7d,
      new Date(T0),
      from7d,
      from7d,
      FUND_SAME_DEVICE_MIN_GAMES,
      FUND_GROUP_CAP + 1,
    ]);
    // ② PDK 的 `ended_at` 是 BIGINT epoch-ms ⇒ 前两参 number；设备 last_seen_at 仍是 DATETIME ⇒ Date。
    expect(db.queries[1]!.params).toEqual([
      T0 - FUND_WINDOW_7D_MS,
      T0,
      from7d,
      from7d,
      FUND_SAME_DEVICE_MIN_GAMES,
      FUND_GROUP_CAP + 1,
    ]);
    expect(db.queries[2]!.params).toEqual([
      T0 - FUND_SCAN_WINDOW_24H_MS,
      T0 - FUND_WINDOW_7D_MS,
      T0,
      FUND_PAIR_MIN_GAMES_7D,
      FUND_GROUP_CAP + 1,
    ]);
    expect(db.queries[3]!.params).toEqual([
      from26h,
      new Date(T0),
      FUND_RAKE_MIN_GAMES,
      FUND_GROUP_CAP + 1,
    ]);
    expect(db.queries[4]!.params).toEqual([from26h, new Date(T0), FUND_DETAIL_CAP + 1]);
    // ⑥⑦ PDK 的 `ended_at` 是 BIGINT epoch-ms ⇒ number（绑 Date 会静默空窗，2026-10-29 真栈实证）。
    expect(db.queries[5]!.params).toEqual([
      T0 - FUND_SCAN_WINDOW_24H_MS,
      T0,
      FUND_RAKE_MIN_GAMES,
      FUND_GROUP_CAP + 1,
    ]);
    expect(db.queries[6]!.params).toEqual([T0 - FUND_SCAN_WINDOW_24H_MS, T0, FUND_DETAIL_CAP + 1]);
    expect(db.queries[7]!.params).toEqual([from27h, new Date(T0), FUND_DETAIL_CAP + 1]);
  });

  it('空数据 ⇒ 零命中/零降级/零失败/hitUsers=0', async () => {
    const result = await collect(new FakeFundDb());

    expect(result.reasonsByUser.size).toBe(0);
    expect(result.hitsByUser.size).toBe(0);
    expect(result.hitUsers).toBe(0);
    expect(result.droppedByCap).toBe(0);
    expect(result.degradedGames).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('同设备同桌：games=3 命中两侧；games=2 不命中（JS 复核）；字段完整', async () => {
    const hit = new FakeFundDb();
    hit.sameDeviceDdz = [{ user_a: 'u-A', user_b: 'u-B', device_id: 'dev-1', games: 3 }];

    const result = await collect(hit);

    expect(reasonsOf(result, 'u-A', 'sameDevice')).toEqual([
      {
        check: 'sameDevice',
        detail: { gameType: 'doudizhu', windowHours: 168, pairUserId: 'u-B', deviceId: 'dev-1', games: 3 },
      },
    ]);
    expect(reasonsOf(result, 'u-B', 'sameDevice')).toEqual([
      {
        check: 'sameDevice',
        detail: { gameType: 'doudizhu', windowHours: 168, pairUserId: 'u-A', deviceId: 'dev-1', games: 3 },
      },
    ]);
    expect(result.hitsByUser.get('u-A')).toEqual([{ check: 'sameDevice', gameType: 'doudizhu' }]);
    expect(result.hitUsers).toBe(2);

    const miss = new FakeFundDb();
    miss.sameDeviceDdz = [{ user_a: 'u-A', user_b: 'u-B', device_id: 'dev-1', games: 2 }];
    expect((await collect(miss)).hitUsers).toBe(0);
  });

  it('同设备同桌：同对子两台设备 ⇒ 两条 reason；PDK 行标 paodekuai', async () => {
    const db = new FakeFundDb();
    db.sameDeviceDdz = [
      { user_a: 'u-A', user_b: 'u-B', device_id: 'dev-1', games: 5 },
      { user_a: 'u-A', user_b: 'u-B', device_id: 'dev-2', games: 3 },
    ];
    db.sameDevicePdk = [{ user_a: 'u-A', user_b: 'u-C', device_id: 'dev-1', games: 3 }];

    const result = await collect(db);

    const aReasons = reasonsOf(result, 'u-A', 'sameDevice');
    expect(aReasons).toHaveLength(3);
    expect(aReasons.map((r) => r.detail.deviceId)).toEqual(['dev-1', 'dev-2', 'dev-1']);
    expect(aReasons[2]!.detail.gameType).toBe('paodekuai');
    expect(result.hitsByUser.get('u-A')).toEqual([
      { check: 'sameDevice', gameType: 'doudizhu' },
      { check: 'sameDevice', gameType: 'paodekuai' },
    ]);
  });

  it('对子胜率：5 局 100% 净赢 1000 命中两侧；net=999 / 4 局不命中；80% 恰好命中', async () => {
    const base = {
      user_a: 'u-A',
      user_b: 'u-B',
      games_7d: '5',
      wins_a: '5',
      wins_b: 0,
      net_a: '1000',
      net_b: '-1000',
      games_24h: '3',
    };
    const hitDb = new FakeFundDb();
    hitDb.pair = [base];
    const result = await collect(hitDb);
    expect(reasonsOf(result, 'u-A', 'pairWinRate')).toEqual([
      {
        check: 'pairWinRate',
        detail: {
          gameType: 'paodekuai',
          playerCount: 2,
          windowHours: 168,
          pairUserId: 'u-B',
          dominantUserId: 'u-A',
          games: 5,
          wins: 5,
          winRate: 1,
          netWin: 1000,
        },
      },
    ]);
    expect(reasonsOf(result, 'u-B', 'pairWinRate')[0]!.detail).toEqual({
      gameType: 'paodekuai',
      playerCount: 2,
      windowHours: 168,
      pairUserId: 'u-A',
      dominantUserId: 'u-A',
      games: 5,
      wins: 5,
      winRate: 1,
      netWin: 1000,
    });
    expect(result.hitsByUser.get('u-A')).toEqual([
      { check: 'pairWinRate', gameType: 'paodekuai' },
    ]);

    const lowNet = new FakeFundDb();
    lowNet.pair = [{ ...base, net_a: '999' }];
    expect((await collect(lowNet)).hitUsers).toBe(0);

    const fewGames = new FakeFundDb();
    fewGames.pair = [{ ...base, games_7d: '4' }];
    expect((await collect(fewGames)).hitUsers).toBe(0);

    const exactRate = new FakeFundDb();
    exactRate.pair = [{ ...base, wins_a: '4' }];
    expect(reasonsOf(await collect(exactRate), 'u-A', 'pairWinRate')[0]!.detail.winRate).toBe(0.8);
  });

  it('对子胜率：B 支配（wins_b > wins_a）⇒ dominantUserId=uB、netWin=net_b（审查 M7a）', async () => {
    const db = new FakeFundDb();
    db.pair = [
      {
        user_a: 'u-A',
        user_b: 'u-B',
        games_7d: 5,
        wins_a: 0,
        wins_b: 5,
        net_a: -1500,
        net_b: 1500,
        games_24h: 5,
      },
    ];

    const result = await collect(db);
    const detailA = reasonsOf(result, 'u-A', 'pairWinRate')[0]!.detail;
    const detailB = reasonsOf(result, 'u-B', 'pairWinRate')[0]!.detail;

    expect(detailA.dominantUserId).toBe('u-B');
    expect(detailA.wins).toBe(5);
    expect(detailA.netWin).toBe(1500);
    expect(detailB.pairUserId).toBe('u-A');
    expect(result.hitUsers).toBe(2);
  });

  it('截断：对子分组超 cap ⇒ truncated + 仅 paodekuai 降级（审查 M7b）', async () => {
    const row = {
      user_a: 'u-A',
      user_b: 'u-B',
      games_7d: 10,
      wins_a: 10,
      wins_b: 0,
      net_a: 1500,
      net_b: -1500,
      games_24h: 10,
    };
    const db = new FakeFundDb();
    db.pair = [row, { ...row, user_b: 'u-C' }];

    const result = await collect(db, T0, { groupCap: 1 });

    expect(result.failures).toEqual([{ scope: 'paodekuai', reason: 'truncated' }]);
    expect(result.degradedGames).toEqual(['paodekuai']);
    expect(result.hitUsers).toBe(0); // 对子结果整段丢弃
  });

  it('非法回执（字符串/NaN/负数字符串）⇒ Number() 归零，不命中也不抛（审查 M7c）', async () => {
    const db = new FakeFundDb();
    db.sameDeviceDdz = [{ user_a: 'u-A', user_b: 'u-B', device_id: 'dev-1', games: 'oops' }];
    db.pair = [
      {
        user_a: 'u-A',
        user_b: 'u-B',
        games_7d: 'abc',
        wins_a: 'x',
        wins_b: null,
        net_a: 'NaN',
        net_b: undefined,
        games_24h: '--',
      },
    ];
    db.countsDdz = [{ user_id: 'u-C', games: 'NaN' }];
    db.refsDdz = [{ user_id: 'u-C', room_code: 'R1', game_version: 1 }];
    db.ops = [{ ref_id: 'R1:1', burned_rake: 'oops' }];

    const result = await collect(db);

    expect(result.hitUsers).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('对子频次：games_24h=10 命中；9 不命中；与对子胜率同时命中 ⇒ 两条 hit', async () => {
    const row = {
      user_a: 'u-A',
      user_b: 'u-B',
      games_7d: 10,
      wins_a: 10,
      wins_b: 0,
      net_a: 1500,
      net_b: -1500,
      games_24h: 10,
    };
    const db = new FakeFundDb();
    db.pair = [row];
    const result = await collect(db);

    expect(reasonsOf(result, 'u-A', 'pairFrequency')).toEqual([
      {
        check: 'pairFrequency',
        detail: {
          gameType: 'paodekuai',
          playerCount: 2,
          windowHours: 26,
          pairUserId: 'u-B',
          games: 10,
        },
      },
    ]);
    expect(result.hitsByUser.get('u-A')).toEqual([
      { check: 'pairWinRate', gameType: 'paodekuai' },
      { check: 'pairFrequency', gameType: 'paodekuai' },
    ]);

    const nine = new FakeFundDb();
    nine.pair = [{ ...row, games_24h: 9 }];
    expect(reasonsOf(await collect(nine), 'u-A', 'pairFrequency')).toEqual([]);
    expect(reasonsOf(await collect(nine), 'u-A', 'pairWinRate')).toHaveLength(1);
  });

  it('高抽水：20 局 & 5000 命中；4999/19 局不命中；同 ref 取 max；NULL/无 op 按 0', async () => {
    const db = new FakeFundDb();
    db.countsDdz = [{ user_id: 'u-C', games: '20' }];
    db.refsDdz = [
      { user_id: 'u-C', room_code: 'R1', game_version: 7 },
      { user_id: 'u-C', room_code: 'R2', game_version: 8 },
    ];
    db.ops = [
      { ref_id: 'R1:7', burned_rake: '3000' },
      { ref_id: 'R1:7', burned_rake: '7000' }, // 同 ref ⇒ max=7000（不是 10000）
      { ref_id: 'R2:8', burned_rake: null },
    ];

    const result = await collect(db);

    expect(reasonsOf(result, 'u-C', 'highRake')).toEqual([
      {
        check: 'highRake',
        detail: { gameType: 'doudizhu', windowHours: 26, games: 20, rakeUpperBound: 7000 },
      },
    ]);

    const low = new FakeFundDb();
    low.countsDdz = [{ user_id: 'u-C', games: 20 }];
    low.refsDdz = [{ user_id: 'u-C', room_code: 'R1', game_version: 1 }];
    low.ops = [{ ref_id: 'R1:1', burned_rake: 4999 }];
    expect((await collect(low)).hitUsers).toBe(0);

    const few = new FakeFundDb();
    few.countsDdz = [{ user_id: 'u-C', games: 19 }];
    few.refsDdz = [{ user_id: 'u-C', room_code: 'R1', game_version: 1 }];
    few.ops = [{ ref_id: 'R1:1', burned_rake: 9000 }];
    expect((await collect(few)).hitUsers).toBe(0);

    const noOp = new FakeFundDb();
    noOp.countsDdz = [{ user_id: 'u-C', games: 20 }];
    noOp.refsDdz = [{ user_id: 'u-C', room_code: 'R9', game_version: 9 }];
    expect((await collect(noOp)).hitUsers).toBe(0);
  });

  it('高抽水：PDK 分桶 + 非获胜局别人的 ref 不计入本用户', async () => {
    const db = new FakeFundDb();
    db.countsPdk = [{ user_id: 'u-C', games: 20 }];
    db.refsPdk = [{ user_id: 'u-D', room_code: 'R1', game_version: 1 }];
    db.ops = [{ ref_id: 'R1:1', burned_rake: 9000 }];

    expect((await collect(db)).hitUsers).toBe(0); // 抽水只归胜局用户（u-D）

    db.refsPdk.push({ user_id: 'u-C', room_code: 'R2', game_version: 2 });
    db.ops.push({ ref_id: 'R2:2', burned_rake: 5000 });
    const result = await collect(db);
    expect(reasonsOf(result, 'u-C', 'highRake')[0]!.detail).toEqual({
      gameType: 'paodekuai',
      windowHours: 26,
      games: 20,
      rakeUpperBound: 5000,
    });
  });

  it('失败隔离：对子 SQL 抛 ⇒ 降级 paodekuai，其余信号照常', async () => {
    const db = new FakeFundDb();
    db.failSql.add(FUND_PAIR_PDK_SQL);
    db.sameDeviceDdz = [{ user_a: 'u-A', user_b: 'u-B', device_id: 'dev-1', games: 3 }];

    const result = await collect(db);

    expect(result.failures).toEqual([{ scope: 'paodekuai', reason: 'sql' }]);
    expect(result.degradedGames).toEqual(['paodekuai']);
    expect(result.hitUsers).toBe(2);
  });

  it('失败隔离：ops SQL 抛 ⇒ 两玩法降级，sameDevice/对子仍产出', async () => {
    const db = new FakeFundDb();
    db.failSql.add(FUND_OPS_SQL);
    db.pair = [
      { user_a: 'u-A', user_b: 'u-B', games_7d: 5, wins_a: 5, wins_b: 0, net_a: 1500, net_b: -1500, games_24h: 10 },
    ];
    db.countsDdz = [{ user_id: 'u-C', games: 20 }];
    db.refsDdz = [{ user_id: 'u-C', room_code: 'R1', game_version: 1 }];

    const result = await collect(db);

    expect(result.failures).toEqual([{ scope: 'ops', reason: 'sql' }]);
    expect(result.degradedGames).toEqual(['doudizhu', 'paodekuai']);
    expect(reasonsOf(result, 'u-C', 'highRake')).toEqual([]);
    expect(result.hitUsers).toBe(2);
  });

  it('截断：明细超 cap ⇒ truncated + 降级 + 该查询整段丢弃', async () => {
    const db = new FakeFundDb();
    db.countsDdz = [{ user_id: 'u-C', games: 20 }];
    db.refsDdz = [{ user_id: 'u-C', room_code: 'R1', game_version: 1 }];
    db.ops = [
      { ref_id: 'R1:1', burned_rake: 9000 },
      { ref_id: 'R2:1', burned_rake: 1 },
      { ref_id: 'R3:1', burned_rake: 1 },
    ];

    const result = await collect(db, T0, { detailCap: 2 });

    expect(result.failures).toEqual([{ scope: 'ops', reason: 'truncated' }]);
    expect(result.degradedGames).toEqual(['doudizhu', 'paodekuai']);
    expect(reasonsOf(result, 'u-C', 'highRake')).toEqual([]); // ops 结果整段丢弃
  });

  it('reasons cap：同 (check,game) 至多 3 条且按 games 降序；两玩法证据都保留', async () => {
    const db = new FakeFundDb();
    db.sameDeviceDdz = [
      { user_a: 'u-A', user_b: 'u-B', device_id: 'dev-1', games: 4 },
      { user_a: 'u-A', user_b: 'u-C', device_id: 'dev-1', games: 6 },
      { user_a: 'u-A', user_b: 'u-D', device_id: 'dev-1', games: 5 },
      { user_a: 'u-A', user_b: 'u-E', device_id: 'dev-1', games: 3 },
    ];
    db.sameDevicePdk = [{ user_a: 'u-A', user_b: 'u-F', device_id: 'dev-9', games: 3 }];

    const result = await collect(db);

    const reasons = reasonsOf(result, 'u-A', 'sameDevice');
    expect(reasons).toHaveLength(FUND_MAX_REASONS_PER_CHECK_GAME + 1);
    expect(result.droppedByCap).toBe(1); // 4 条 ddz 证据只留 3 条
    expect(reasons.slice(0, 3).map((r) => r.detail.games)).toEqual([6, 5, 4]);
    expect(reasons[3]!.detail.gameType).toBe('paodekuai');
    expect(result.hitsByUser.get('u-A')).toEqual([
      { check: 'sameDevice', gameType: 'doudizhu' },
      { check: 'sameDevice', gameType: 'paodekuai' },
    ]);
  });

  it('hitUsers 只算 C3 命中用户（并集去重）', async () => {
    const db = new FakeFundDb();
    db.sameDeviceDdz = [{ user_a: 'u-A', user_b: 'u-B', device_id: 'dev-1', games: 3 }];
    db.countsDdz = [{ user_id: 'u-C', games: 20 }];
    db.refsDdz = [{ user_id: 'u-C', room_code: 'R1', game_version: 1 }];
    db.ops = [{ ref_id: 'R1:1', burned_rake: 5000 }];

    const result = await collect(db);

    expect(result.hitUsers).toBe(3);
  });
});

/**
 * 风控片 T5 —— 检测链核心：`ReviewsService`（队列 upsert 状态机 + 自动限流）与
 * `ScanService`（SQL1/2/3 + 判定 + 锁 + 自愈 + 指标）。判据 **C16·C17·C18**
 * （规格 §2.5-1..6 · §2.12 · ⚙️3/5/10/15/19/20/24）。
 *
 * 本片 T6：间隔 = 配置第 38 键 `risk.scanIntervalMs`（**排期处现读**）+ 首排动作
 * （⚙️5–⚙️7）；旧 env 注入面 `RISK_SCAN_INTERVAL_MS` 已退役（注入族用例已迁移为假缓存注入）。
 *
 * ─── 夹具（四件，形态照 T4 / 记录清理先例）──────────────────────────────────
 *  - **FakeRiskDb**：仿真 `risk_reviews` / `risk_actions` 的行存储；锁定读仿真
 *    「最新一行（**任意 status**）」（⚙️10 的 F1 语义承重面）。锁定读只认**规格逐字**
 *    独立誊写的文本；写入语句按形状识别（形状漂移 ⇒ 未识别 ⇒ 当场红）。
 *  - **FakeScanDb**：仿真 SQL1/2/3 + 复核读 + open 计数的回执；SQL 只认规格逐字文本。
 *  - **FakeRedis**：`SET … NX/EX`、`GET`、`DEL` 的键值语义（锁与旗全由它观测；调用序列
 *    全记录）；`ReviewsService` 用例里还充当 `risk:limit` 旗的观测面。
 *  - **ReviewsService 替身**（ScanService 用例）：`applyScanResult = vi.fn()` —— 两服务的
 *    注入面解耦（编排断言 vs 状态机断言分开取证）。
 *
 * ⚠️ 假库**不证** InnoDB 并发/时态 —— 真栈双会话演练（⚙️14 先例形）读数在 progress 核销节。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  createCapturingSink,
  createRedactingLogger,
  metricsRegistry,
  type LogRecord,
} from '@fight-the-landlord/shared';
import { ReviewsService, RISK_UPSERT_LOCK_SQL, type ScanReason } from '../src/risk/reviews.service';
import {
  ScanService,
  RISK_SCAN_DEFAULT_INTERVAL_MS,
  RISK_SCAN_FIRST_RUN_DELAY_MS,
  RISK_SCAN_LOCK_KEY,
  RISK_SCAN_LOCK_TTL_SECONDS,
  RISK_BANNED_FLAG_TTL_SECONDS,
  RISK_WIN_RATE_SQL,
  RISK_DEVICE_COUNT_SQL,
  RISK_BANNED_USERS_SQL,
  RISK_USER_STATUS_SQL,
} from '../src/risk/scan.service';
import { SNAPSHOT_BOOT_WAIT_MS, type ConfigCacheService } from '../src/config/config-cache.service';
import { riskScanLastSuccessTimestampSeconds } from '../src/risk/risk.metrics';

const DAY_MS = 86_400_000;
/** 固定时间轴原点（`now` 注入；不随真实时钟漂移）。 */
const T0 = Date.parse('2026-10-05T12:00:00.000Z');

// ─── 规格逐字（**测试侧独立誊写** —— 断言执行面，不是回抄实现常量）──────────────

/** 规格 ⚙️10 逐字（全文相等断言 + FakeRiskDb 唯一认得的锁定读文本）。 */
const SPEC_RISK_UPSERT_LOCK_SQL =
  'SELECT id,status,score,handled_by,handled_at FROM risk_reviews WHERE user_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE';
/** 规格 §2.5-2 SQL1（胜率）逐字。 */
const SPEC_RISK_WIN_RATE_SQL =
  "SELECT p.user_id, COUNT(*) AS games, SUM(p.won) AS wins FROM game_record_players p JOIN game_records r ON r.id=p.record_id JOIN users u ON u.id = p.user_id AND u.status='active' WHERE r.mode IN ('random','gold') AND p.user_id IS NOT NULL GROUP BY p.user_id";
/** 规格 §2.5-2 SQL2（设备数）逐字。 */
const SPEC_RISK_DEVICE_COUNT_SQL =
  "SELECT d.user_id, COUNT(DISTINCT d.device_id) AS devices FROM user_devices d JOIN users u ON u.id = d.user_id AND u.status='active' WHERE d.last_seen_at >= ? GROUP BY d.user_id";
/** 规格 §2.5-4 SQL3（自愈名单）逐字。 */
const SPEC_RISK_BANNED_USERS_SQL = "SELECT id FROM users WHERE status='banned'";
/** 规格 §2.5-4 复核读逐字（写旗前复核 status）。 */
const SPEC_RISK_USER_STATUS_SQL = 'SELECT status FROM users WHERE id=?';
/** 自动解除的审计 reason（规格 §2.5-3 逐字）。 */
const SPEC_AUTO_RELEASE_REASON = '指标回落，自动解除';

interface Statement {
  sql: string;
  params: unknown[];
}

// ─── FakeRiskDb（ReviewsService 的状态机存储）────────────────────────────────

interface ReviewRow {
  id: number;
  user_id: string;
  score: number;
  reasons: string;
  status: string;
  handled_by: string | null;
  handled_at: Date | null;
}

interface ActionRow {
  user_id: string;
  action: string;
  actor: string;
  reason: string | null;
  review_id: number | null;
}

function mkReview(over: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 1,
    user_id: 'u-A',
    score: 25,
    reasons: '[]',
    status: 'open',
    handled_by: null,
    handled_at: null,
    ...over,
  };
}

class FakeRiskDb {
  reviews: ReviewRow[] = [];
  actions: ActionRow[] = [];
  /** 全部语句的观测面（次序/参数全靠它）。 */
  queries: Statement[] = [];
  /** `dataSource.transaction` 被调用次数。 */
  transactions = 0;
  /** true ⇒ actions 的 INSERT 直接 reject（「事务中段失败 ⇒ 整批回滚」用例）。 */
  failActionInsert = false;

  dataSource = {
    // 事务替身：抛出 ⇒ 存储回滚（「同事务」的存储面语义；真 InnoDB 证据在真栈演练）。
    transaction: async <T,>(cb: (manager: unknown) => Promise<T>): Promise<T> => {
      this.transactions += 1;
      const reviewsBefore = this.reviews.map((r) => ({ ...r }));
      const actionsBefore = this.actions.map((a) => ({ ...a }));
      try {
        return await cb(this.manager);
      } catch (err) {
        this.reviews = reviewsBefore;
        this.actions = actionsBefore;
        throw err;
      }
    },
  };

  manager = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => this.exec(sql, params),
  };

  private exec(sql: string, params: unknown[]): Promise<unknown> {
    this.queries.push({ sql, params });
    // 锁定读：只认规格逐字文本 ⇒ 取最新一行（任意 status；⚙️10/F1）。
    if (sql === SPEC_RISK_UPSERT_LOCK_SQL) {
      const [userId] = params as [string];
      const rows = this.reviews
        .filter((r) => r.user_id === userId)
        .sort((a, b) => b.id - a.id);
      if (rows.length === 0) return Promise.resolve([]);
      const latest = rows[0]!;
      return Promise.resolve([
        {
          id: latest.id,
          status: latest.status,
          score: latest.score,
          handled_by: latest.handled_by,
          handled_at: latest.handled_at,
        },
      ]);
    }
    // 新条目（恒 open）。
    const ins = /^INSERT INTO risk_reviews \(user_id, score, reasons, status\) VALUES \(\?, \?, \?, 'open'\)$/.exec(
      sql,
    );
    if (ins) {
      const [userId, score, reasons] = params as [string, number, string];
      // id = 现最大 + 1（不依赖既有行的手工 id ⇒ 复跑锁定读时「最新一行」判定成立）。
      const id = this.reviews.reduce((max, r) => Math.max(max, r.id), 0) + 1;
      this.reviews.push({
        id,
        user_id: userId,
        score,
        reasons,
        status: 'open',
        handled_by: null,
        handled_at: null,
      });
      return Promise.resolve({ insertId: id, affectedRows: 1 });
    }
    // 任意 `UPDATE risk_reviews SET … WHERE id = ?`（SET 段解析：`col = ?` 或 `col = 'lit'`）。
    const upd = /^UPDATE risk_reviews SET (.+) WHERE id = \?$/.exec(sql);
    if (upd) {
      const id = Number(params[params.length - 1]);
      const row = this.reviews.find((r) => r.id === id);
      if (!row) return Promise.reject(new Error(`FakeRiskDb：risk_reviews 无 id=${id} 行`));
      let pi = 0;
      for (const seg of upd[1]!.split(', ')) {
        const m = /^([a-z_]+) = (\?|'([^']*)')$/.exec(seg);
        if (!m) return Promise.reject(new Error(`FakeRiskDb 无法解析 SET 段: ${seg}`));
        const value = m[2] === '?' ? params[pi++] : m[3]!;
        (row as unknown as Record<string, unknown>)[m[1]!] = value;
      }
      if (pi !== params.length - 1) {
        return Promise.reject(new Error('FakeRiskDb：SET 段参数数与 ? 占位不符'));
      }
      return Promise.resolve({ affectedRows: 1 });
    }
    const act = /^INSERT INTO risk_actions \(user_id, action, actor, reason, review_id, detail\) VALUES \(\?, \?, \?, \?, \?, \?\)$/.exec(
      sql,
    );
    if (act) {
      if (this.failActionInsert) {
        return Promise.reject(new Error('actions insert boom（仿真：事务中段失败）'));
      }
      // 波 2 F2：INSERT 增 `detail` 列（第 6 参；T6 孤儿旗留痕用）——本替身不消费它
      //（T5 断言面 = 五核心列；形状仍按全文识别，漂移 ⇒ 未识别 ⇒ 当场红）。
      const [user_id, action, actor, reason, review_id] = params as [
        string,
        string,
        string,
        string | null,
        number | null,
        string | null,
      ];
      this.actions.push({ user_id, action, actor, reason, review_id });
      return Promise.resolve({ affectedRows: 1 });
    }
    return Promise.reject(new Error(`FakeRiskDb 未识别的 SQL：${sql}`));
  }

  /** 该用户的全部写入语句（除锁定读）；断言「零写」用。 */
  writesFor(userId: string): Statement[] {
    return this.queries.filter((q) => q.sql !== SPEC_RISK_UPSERT_LOCK_SQL && q.params[0] === userId);
  }

  /** 某测试用户的 actions 行（按发生顺序）。 */
  actionsOf(userId: string): ActionRow[] {
    return this.actions.filter((a) => a.user_id === userId);
  }
}

// ─── FakeScanDb（ScanService 的统计/自愈回执面）──────────────────────────────

class FakeScanDb {
  winRows: Array<{ user_id: string; games: number | string; wins: number | string }> = [];
  deviceRows: Array<{ user_id: string; devices: number | string }> = [];
  bannedIds: string[] = [];
  /** 复核读的回执（缺 ⇒ 返回 [] —— 「行已不在」形态）。 */
  statuses = new Map<string, string>();
  openCount = 0;
  queries: Statement[] = [];
  /** > 0 ⇒ 该次 query 直接 reject（每次消一个；库故障用例）。 */
  failuresRemaining = 0;
  private held: Promise<unknown> | null = null;

  holdNextQuery(): { resolve: (value: unknown) => void } {
    let resolve!: (value: unknown) => void;
    this.held = new Promise((r) => (resolve = r));
    return { resolve };
  }

  dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.queries.push({ sql, params });
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
        return Promise.reject(new Error('db down（仿真）'));
      }
      if (this.held !== null) {
        const held = this.held;
        this.held = null;
        return held;
      }
      if (sql === SPEC_RISK_WIN_RATE_SQL) return Promise.resolve(this.winRows);
      if (sql === SPEC_RISK_DEVICE_COUNT_SQL) return Promise.resolve(this.deviceRows);
      if (sql === SPEC_RISK_BANNED_USERS_SQL) {
        return Promise.resolve(this.bannedIds.map((id) => ({ id })));
      }
      if (sql === SPEC_RISK_USER_STATUS_SQL) {
        const [id] = params as [string];
        const status = this.statuses.get(id);
        return Promise.resolve(status === undefined ? [] : [{ status }]);
      }
      if (/^SELECT COUNT\(\*\) AS cnt FROM risk_reviews WHERE status='open'$/.test(sql)) {
        return Promise.resolve([{ cnt: this.openCount }]);
      }
      return Promise.reject(new Error(`FakeScanDb 未识别的 SQL：${sql}`));
    },
  };
}

// ─── FakeRedis ──────────────────────────────────────────────────────────────

interface RedisCall {
  op: 'set' | 'get' | 'del';
  key: string;
  args: unknown[];
}

class FakeRedis {
  store = new Map<string, string>();
  calls: RedisCall[] = [];
  /** 这些键的 GET 直接 reject（终审 F1：旗读失败 ⇒ 决策路径照抛，不做「按无旗」）。 */
  failGetsFor = new Set<string>();

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    this.calls.push({ op: 'set', key, args: [value, ...args] });
    const i = args.indexOf('NX');
    if (i >= 0 && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.calls.push({ op: 'get', key, args: [] });
    if (this.failGetsFor.has(key)) throw new Error('redis boom（仿真）');
    return this.store.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    this.calls.push({ op: 'del', key, args: [] });
    return this.store.delete(key) ? 1 : 0;
  }

  /** 某 op 对该 key 的调用次数。 */
  count(op: RedisCall['op'], key: string): number {
    return this.calls.filter((c) => c.op === op && c.key === key).length;
  }
}

// ─── 配置替身 / 指标读数 ────────────────────────────────────────────────────

/** ReviewsService 用（只读 riskAutoThrottle）。 */
function makeReviewsConfig(autoThrottle = true): ConfigCacheService {
  return { riskAutoThrottle: vi.fn(() => autoThrottle) } as unknown as ConfigCacheService;
}

/**
 * ScanService 用（本片 T6 起循环消费面全给：风控四 getter + `riskScanIntervalMs` + 首排两把手
 * `hasSnapshot`（就绪）/ `waitForFirstSnapshot`（已 resolve）—— 形态照 `records-cleanup.test.ts`
 * 的 `makeCache`。间隔句柄经返回值上的 `riskScanIntervalMs` 取：用例内
 * `as ReturnType<typeof vi.fn>` 读调用次数/改值，断言「现读」发生处）。
 */
function makeScanConfig(
  over: Partial<
    Record<'minGames' | 'winRateThreshold' | 'deviceLimit' | 'deviceWindowDays' | 'intervalMs', number>
  > = {},
): ConfigCacheService {
  return {
    riskMinGames: vi.fn(() => over.minGames ?? 100),
    riskWinRateThreshold: vi.fn(() => over.winRateThreshold ?? 0.8),
    riskDeviceLimit: vi.fn(() => over.deviceLimit ?? 3),
    riskDeviceWindowDays: vi.fn(() => over.deviceWindowDays ?? 30),
    riskScanIntervalMs: vi.fn(() => over.intervalMs ?? 3_600_000),
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
  } as unknown as ConfigCacheService;
}

/**
 * 从 shared registry 的文本输出读一条**无标签**指标的当前值（名称写错/落错 registry
 * ⇒ 抛错，绝不静默回 0 假绿；照 records-cleanup.test.ts 先例）。
 */
async function simpleMetric(name: string): Promise<number> {
  const text = await metricsRegistry().metrics();
  const m = new RegExp(`^${name} (-?[\\d.eE+]+)$`, 'm').exec(text);
  if (!m) throw new Error(`registry 输出里没有 ${name}（指标名写错或没落进 shared registry？）`);
  return Number(m[1]);
}

/**
 * 推平微任务队列（无定时器参与的在途轮次断言用 —— 纯 promise 链，逐 turn 排干）。
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** 读一条**带标签**指标的值（例：`risk_scan_runs_total{result="ok"}`；缺系列 ⇒ 0）。 */
async function labeledMetric(name: string, labels: string): Promise<number> {
  const text = await metricsRegistry().metrics();
  const m = new RegExp(`^${name}${labels} ([\\d.eE+]+)$`, 'm').exec(text);
  return m ? Number(m[1]) : 0;
}

// ════════════════════════════════════════════════════════════════════════════

describe('风控片 T5：检测链核心（C16·C17·C18）', () => {
  let captured: ReturnType<typeof createCapturingSink>;

  beforeEach(() => {
    captured = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'user-service' }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    Logger.overrideLogger(new Logger());
    vi.useRealTimers();
  });

  // ── SQL 常量钉（全文相等 —— 不是 toContain）──────────────────────────────

  it('SQL 常量全文 == 规格逐字：锁定读（⚙️10）· SQL1/2/3（§2.5-2/4）', () => {
    expect(RISK_UPSERT_LOCK_SQL).toBe(SPEC_RISK_UPSERT_LOCK_SQL);
    expect(RISK_WIN_RATE_SQL).toBe(SPEC_RISK_WIN_RATE_SQL);
    expect(RISK_DEVICE_COUNT_SQL).toBe(SPEC_RISK_DEVICE_COUNT_SQL);
    expect(RISK_BANNED_USERS_SQL).toBe(SPEC_RISK_BANNED_USERS_SQL);
    expect(RISK_USER_STATUS_SQL).toBe(SPEC_RISK_USER_STATUS_SQL);
  });

  // ── ReviewsService：状态机（§2.5-3 全行 · ⚙️10 · ⚙️19 自动侧 · ⚙️20）─────

  describe('ReviewsService.applyScanResult（upsert 状态机）', () => {
    let db: FakeRiskDb;
    let redis: FakeRedis;

    const mkSvc = (autoThrottle = true) =>
      new ReviewsService(
        db.dataSource as never,
        redis as never,
        makeReviewsConfig(autoThrottle),
      );

    const R25: ScanReason[] = [{ check: 'winRate', detail: { games: 101, wins: 90, winRate: 90 / 101 } }];
    const R50: ScanReason[] = [
      { check: 'winRate', detail: { games: 101, wins: 90, winRate: 90 / 101 } },
      { check: 'devices', detail: { devices: 5 } },
    ];

    beforeEach(() => {
      db = new FakeRiskDb();
      redis = new FakeRedis();
    });

    it('无行 + score=25 ⇒ INSERT open（reasons 原文）；零审计、零旗、恰一条写语句', async () => {
      await mkSvc().applyScanResult('u-A', 25, R25, T0);

      expect(db.transactions).toBe(1);
      expect(db.queries[0]).toEqual({ sql: SPEC_RISK_UPSERT_LOCK_SQL, params: ['u-A'] });
      expect(db.reviews).toHaveLength(1);
      const row = db.reviews[0]!;
      expect(row.status).toBe('open');
      expect(row.score).toBe(25);
      expect(JSON.parse(row.reasons)).toEqual(R25);
      expect(db.actions).toHaveLength(0);
      expect(redis.calls.filter((c) => c.key.startsWith('risk:limit:'))).toHaveLength(0);
      // 恰一条写语句（INSERT）——不是 UPDATE。
      expect(db.queries).toHaveLength(2);
    });

    it('无行 + score=50 ⇒ 仍只 INSERT open（⚙️20：无条目 ⇒ 不置旗、不迁 throttled）', async () => {
      await mkSvc().applyScanResult('u-A', 50, R50, T0);

      expect(db.reviews).toHaveLength(1);
      expect(db.reviews[0]!.status).toBe('open');
      expect(db.actions).toHaveLength(0);
      expect(redis.calls).toHaveLength(0);
    });

    it('无行 + score=0 ⇒ 零写（仅锁定读——score<25 的并集用户是自动回落的无操作通道）', async () => {
      await mkSvc().applyScanResult('u-A', 0, [], T0);

      expect(db.queries).toEqual([{ sql: SPEC_RISK_UPSERT_LOCK_SQL, params: ['u-A'] }]);
      expect(db.reviews).toHaveLength(0);
      expect(redis.calls).toHaveLength(0);
    });

    it('open + 25 ⇒ 只 UPDATE score/reasons（仍 open；无旗无审计）', async () => {
      db.reviews.push(mkReview({ id: 7, status: 'open', score: 25, reasons: '[]' }));

      await mkSvc().applyScanResult('u-A', 25, R25, T0);

      const row = db.reviews[0]!;
      expect(row.status).toBe('open');
      expect(row.score).toBe(25);
      expect(JSON.parse(row.reasons)).toEqual(R25);
      expect(row.handled_by).toBeNull();
      expect(db.actions).toHaveLength(0);
      expect(redis.calls).toHaveLength(0);
      expect(db.queries).toHaveLength(2); // 锁定读 + UPDATE
    });

    it('open + 50 且 autoThrottle=true ⇒ 置旗 auto 7d + 迁 throttled(system) + auto_throttle 审计', async () => {
      db.reviews.push(mkReview({ id: 7, status: 'open', score: 25, reasons: '[]' }));

      await mkSvc(true).applyScanResult('u-A', 50, R50, T0);

      const row = db.reviews[0]!;
      expect(row.status).toBe('throttled');
      expect(row.score).toBe(50);
      expect(JSON.parse(row.reasons)).toEqual(R50);
      expect(row.handled_by).toBe('system');
      expect(row.handled_at).toEqual(new Date(T0));
      // 旗：值 JSON 逐字 {source:'auto',at} + EX 7d。
      const flagSet = redis.calls.find((c) => c.op === 'set' && c.key === 'risk:limit:u-A');
      expect(flagSet?.args).toEqual([
        JSON.stringify({ source: 'auto', at: T0 }),
        'EX',
        604_800,
      ]);
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'auto_throttle', actor: 'system', reason: null, review_id: 7 },
      ]);
    });

    it('open + score<25 ⇒ 零写（无 UPDATE、无审计行、无旗——设计 §5.2 表头「score ≥ 25 时…分流」）', async () => {
      db.reviews.push(mkReview({ id: 7, status: 'open', score: 25, reasons: '[]' }));

      await mkSvc().applyScanResult('u-A', 0, [], T0);

      expect(db.queries).toEqual([{ sql: SPEC_RISK_UPSERT_LOCK_SQL, params: ['u-A'] }]);
      expect(db.reviews[0]!.score).toBe(25); // 原行原样（不被 0 覆写）
      expect(db.reviews[0]!.reasons).toBe('[]');
      expect(db.actions).toHaveLength(0);
      expect(redis.calls).toHaveLength(0);
    });

    it('open + 50 但 autoThrottle=false ⇒ 只 UPDATE（不置旗、不迁、不审计）', async () => {
      db.reviews.push(mkReview({ id: 7, status: 'open', score: 25, reasons: '[]' }));

      await mkSvc(false).applyScanResult('u-A', 50, R50, T0);

      const row = db.reviews[0]!;
      expect(row.status).toBe('open');
      expect(row.score).toBe(50);
      expect(db.actions).toHaveLength(0);
      expect(redis.calls).toHaveLength(0);
    });

    it('终审 F1：open + 50 但旗=manual ⇒ 旗不动（零 set/del）+ 条目迁 throttled（handled_* 保持不动）+ 无审计行', async () => {
      db.reviews.push(mkReview({ id: 7, status: 'open', score: 25, reasons: '[]' }));
      const manualValue = JSON.stringify({ source: 'manual', at: T0 - 1000 });
      redis.store.set('risk:limit:u-A', manualValue);

      await mkSvc(true).applyScanResult('u-A', 50, R50, T0);

      const row = db.reviews[0]!;
      expect(row.status).toBe('throttled'); // 条目照迁（用户确实处于人工限流中）
      expect(row.score).toBe(50);
      expect(JSON.parse(row.reasons)).toEqual(R50);
      expect(row.handled_by).toBeNull(); // 🔴 保持不动（绝不盖成 'system'）
      expect(row.handled_at).toBeNull();
      expect(redis.store.get('risk:limit:u-A')).toBe(manualValue); // 旗逐字节未变
      expect(redis.count('set', 'risk:limit:u-A')).toBe(0);
      expect(redis.count('del', 'risk:limit:u-A')).toBe(0);
      expect(db.actions).toHaveLength(0); // 无实际变更 ⇒ 无审计行
      expect(db.queries).toHaveLength(2); // 锁定读 + 一条 UPDATE（无审计 INSERT）
    });

    it('终审 F1 回归③：open + 50 且旗=auto（预置）⇒ 现行为（SET 续期 + 迁 throttled + auto_throttle 审计）', async () => {
      db.reviews.push(mkReview({ id: 7, status: 'open', score: 25, reasons: '[]' }));
      redis.store.set('risk:limit:u-A', JSON.stringify({ source: 'auto', at: T0 - 1000 }));

      await mkSvc(true).applyScanResult('u-A', 50, R50, T0);

      const row = db.reviews[0]!;
      expect(row.status).toBe('throttled');
      expect(row.handled_by).toBe('system');
      const flagSet = redis.calls.find((c) => c.op === 'set' && c.key === 'risk:limit:u-A');
      expect(flagSet?.args).toEqual([
        JSON.stringify({ source: 'auto', at: T0 }),
        'EX',
        604_800,
      ]);
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'auto_throttle', actor: 'system', reason: null, review_id: 7 },
      ]);
    });

    it('终审 F1 链：manual 旗穿越 revive（throttle→ban→unban 残局 → 涨分 revive → ≥50 → <50）⇒ 旗全程 manual、零改写零删除、仅 reopen 一条审计', async () => {
      // 手动 throttle/ban/unban 的行级残局（三动作本身归 risk-admin.test.ts）：最新行 =
      // unban 回迁的 dismissed；`risk:limit` manual 旗仍在（T6 三动作都不动本旗）。
      db.reviews.push(
        mkReview({
          id: 3,
          status: 'dismissed',
          score: 25,
          handled_by: 'admin-a',
          handled_at: new Date(T0 - 1000),
        }),
      );
      const manualValue = JSON.stringify({ source: 'manual', at: T0 - 2000 });
      redis.store.set('risk:limit:u-A', manualValue);
      const svc = mkSvc(true);

      await svc.applyScanResult('u-A', 50, R50, T0); // 涨分 revive ⇒ 新 open 行
      const revived = db.reviews.find((r) => r.id !== 3)!;
      expect(revived.status).toBe('open');

      await svc.applyScanResult('u-A', 50, R50, T0 + 1000); // open + 旗 manual ⇒ ②（迁 throttled、handled_* 不动）
      expect(revived.status).toBe('throttled');
      expect(revived.handled_by).toBeNull();

      await svc.applyScanResult('u-A', 0, [], T0 + 2000); // <50 且处置者非 system ⇒ 人工档零写（无 auto 解除面）

      expect(redis.store.get('risk:limit:u-A')).toBe(manualValue); // 逐字节未变（manual 全程）
      expect(redis.count('set', 'risk:limit:u-A'), '旧缺陷：此处置 auto 会漂移 manual 旗').toBe(0);
      expect(redis.count('del', 'risk:limit:u-A'), '旧缺陷续：下轮 release 会删掉它').toBe(0);
      expect(db.actionsOf('u-A').map((a) => a.action)).toEqual(['reopen']); // 仅 revive 一条，无 auto 系审计
    });

    it('终审 F1 边界：旗读失败 ⇒ 拒绝（决策读不做「按无旗」——Redis 故障窗口不许把 manual 漂成 auto）', async () => {
      db.reviews.push(mkReview({ id: 7, status: 'open', score: 25, reasons: '[]' }));
      redis.store.set('risk:limit:u-A', JSON.stringify({ source: 'manual', at: T0 }));
      redis.failGetsFor.add('risk:limit:u-A');

      await expect(mkSvc(true).applyScanResult('u-A', 50, R50, T0)).rejects.toThrowError(
        /redis boom/,
      );

      // 事务回滚：条目未迁、旗原样、无审计（下一轮重试收敛）。
      expect(db.reviews[0]!.status).toBe('open');
      expect(db.reviews[0]!.score).toBe(25);
      expect(db.actions).toHaveLength(0);
      expect(redis.count('set', 'risk:limit:u-A')).toBe(0);
    });

    it('throttled(auto) + 50 ⇒ 旗续期（SET 重发 + EX 7d）；**不刷审计**（risk_actions 零行）', async () => {
      db.reviews.push(
        mkReview({ id: 9, status: 'throttled', score: 50, handled_by: 'system', handled_at: new Date(T0 - 1000) }),
      );
      redis.store.set('risk:limit:u-A', JSON.stringify({ source: 'auto', at: T0 - 1000 }));

      await mkSvc().applyScanResult('u-A', 50, R50, T0);

      const row = db.reviews[0]!;
      expect(row.status).toBe('throttled'); // 状态不动
      expect(row.score).toBe(50);
      expect(JSON.parse(row.reasons)).toEqual(R50);
      const flagSet = redis.calls.find((c) => c.op === 'set');
      expect(flagSet?.args).toEqual([JSON.stringify({ source: 'auto', at: T0 }), 'EX', 604_800]);
      expect(redis.count('del', 'risk:limit:u-A')).toBe(0);
      expect(db.actions).toHaveLength(0); // 续期不刷审计
    });

    it('throttled(auto) + 25 ⇒ 删旗 + unthrottle(system) 审计 + 回迁 open（handled_by=system/now）', async () => {
      db.reviews.push(
        mkReview({ id: 9, status: 'throttled', score: 50, handled_by: 'system', handled_at: new Date(T0 - 1000) }),
      );
      redis.store.set('risk:limit:u-A', JSON.stringify({ source: 'auto', at: T0 - 1000 }));

      await mkSvc().applyScanResult('u-A', 25, R25, T0);

      const row = db.reviews[0]!;
      expect(row.status).toBe('open'); // score≥25 ⇒ 回 open
      expect(row.score).toBe(25);
      expect(row.handled_by).toBe('system');
      expect(row.handled_at).toEqual(new Date(T0));
      expect(redis.count('del', 'risk:limit:u-A')).toBe(1);
      expect(redis.store.has('risk:limit:u-A')).toBe(false);
      expect(db.actionsOf('u-A')).toEqual([
        {
          user_id: 'u-A',
          action: 'unthrottle',
          actor: 'system',
          reason: SPEC_AUTO_RELEASE_REASON,
          review_id: 9,
        },
      ]);
    });

    it('throttled(auto) + 0 ⇒ 删旗 + unthrottle 审计 + 回迁 **dismissed**（reason「指标回落，自动解除」）', async () => {
      db.reviews.push(
        mkReview({ id: 9, status: 'throttled', score: 50, handled_by: 'system', handled_at: new Date(T0 - 1000) }),
      );
      redis.store.set('risk:limit:u-A', JSON.stringify({ source: 'auto', at: T0 - 1000 }));

      await mkSvc().applyScanResult('u-A', 0, [], T0);

      const row = db.reviews[0]!;
      expect(row.status).toBe('dismissed'); // score<25 ⇒ dismissed
      expect(row.score).toBe(0);
      expect(row.handled_by).toBe('system');
      expect(redis.count('del', 'risk:limit:u-A')).toBe(1);
      expect(db.actionsOf('u-A')).toHaveLength(1);
      expect(db.actionsOf('u-A')[0]!.action).toBe('unthrottle');
      expect(db.actionsOf('u-A')[0]!.reason).toBe(SPEC_AUTO_RELEASE_REASON);
    });

    it('throttled(manual) ⇒ 一律不动旗（人工解除是唯一通道）；score≥25 仅 UPDATE', async () => {
      db.reviews.push(
        mkReview({ id: 9, status: 'throttled', score: 50, handled_by: 'admin-a', handled_at: new Date(T0 - 1000) }),
      );
      redis.store.set('risk:limit:u-A', JSON.stringify({ source: 'manual', at: T0 - 1000 }));

      await mkSvc().applyScanResult('u-A', 25, R25, T0);
      expect(db.reviews[0]!.status).toBe('throttled');
      expect(db.reviews[0]!.score).toBe(25);
      expect(db.reviews[0]!.handled_by).toBe('admin-a'); // 处置者不被覆盖
      expect(redis.calls).toHaveLength(0); // 旗零操作（连 set 续期都没有）
      expect(db.actions).toHaveLength(0);
    });

    it('throttled(manual) + score<25 ⇒ 零写（不回落——回落只属于 auto 档）', async () => {
      db.reviews.push(
        mkReview({ id: 9, status: 'throttled', score: 50, handled_by: 'admin-a', handled_at: new Date(T0 - 1000) }),
      );

      await mkSvc().applyScanResult('u-A', 0, [], T0);

      expect(db.queries).toEqual([{ sql: SPEC_RISK_UPSERT_LOCK_SQL, params: ['u-A'] }]);
      expect(redis.calls).toHaveLength(0);
      expect(db.actions).toHaveLength(0);
    });

    it('dismissed + 同分 ⇒ 不动（抑制语义：人工判过后同分不复活）', async () => {
      db.reviews.push(
        mkReview({ id: 3, status: 'dismissed', score: 25, handled_by: 'admin-a', handled_at: new Date(T0 - 1000) }),
      );

      await mkSvc().applyScanResult('u-A', 25, R25, T0);

      expect(db.queries).toEqual([{ sql: SPEC_RISK_UPSERT_LOCK_SQL, params: ['u-A'] }]);
      expect(db.reviews).toHaveLength(1);
      expect(db.reviews[0]!.status).toBe('dismissed'); // 原行原样
      expect(db.actions).toHaveLength(0);
    });

    it('dismissed + 降分 ⇒ 不动', async () => {
      db.reviews.push(
        mkReview({ id: 3, status: 'dismissed', score: 25, handled_by: 'admin-a', handled_at: null }),
      );

      await mkSvc().applyScanResult('u-A', 0, [], T0);

      expect(db.reviews).toHaveLength(1);
      expect(db.actions).toHaveLength(0);
    });

    it('dismissed + 涨分 ⇒ **INSERT 新 open**（reasons 附 revived 全文）+ reopen(system) 审计', async () => {
      const handledAt = new Date(T0 - 86_400_000);
      db.reviews.push(
        mkReview({ id: 3, status: 'dismissed', score: 25, handled_by: 'admin-a', handled_at: handledAt }),
      );

      await mkSvc().applyScanResult('u-A', 50, R50, T0);

      expect(db.reviews).toHaveLength(2); // 旧行保留（历史可查），新行 open
      const fresh = db.reviews.find((r) => r.id !== 3)!;
      expect(fresh.status).toBe('open');
      expect(fresh.score).toBe(50);
      expect(JSON.parse(fresh.reasons)).toEqual([
        ...R50,
        {
          check: 'revived',
          detail: {
            prevReviewId: 3,
            prevScore: 25,
            handledBy: 'admin-a',
            handledAt: handledAt.toISOString(),
          },
        },
      ]);
      expect(db.reviews.find((r) => r.id === 3)!.status).toBe('dismissed'); // 旧行不动
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'reopen', actor: 'system', reason: null, review_id: fresh.id },
      ]);
      // reopen 是**新高分**触发的重开：不带旗操作（自动武装只在 open 分支）。
      expect(redis.calls).toHaveLength(0);
    });

    it('banned（最新行）⇒ 跳过产出（score=50 也零写）', async () => {
      db.reviews.push(
        mkReview({ id: 4, status: 'banned', score: 50, handled_by: 'admin-a', handled_at: new Date(T0 - 1000) }),
      );

      await mkSvc().applyScanResult('u-A', 50, R50, T0);

      expect(db.queries).toEqual([{ sql: SPEC_RISK_UPSERT_LOCK_SQL, params: ['u-A'] }]);
      expect(db.reviews).toHaveLength(1);
      expect(redis.calls).toHaveLength(0);
      expect(db.actions).toHaveLength(0);
    });

    it('F1：分支对象 = 锁定读的**最新一行（任意 status）**——最新 dismissed 抑制 older open', async () => {
      // older=open（若实现只取 open/throttled 会把这条路走成 UPDATE/INSERT ⇒ 本用例红）
      db.reviews.push(mkReview({ id: 1, status: 'open', score: 25, reasons: '[]' }));
      db.reviews.push(
        mkReview({ id: 2, status: 'dismissed', score: 25, handled_by: 'admin-a', handled_at: new Date(T0 - 1000) }),
      );

      await mkSvc().applyScanResult('u-A', 25, R25, T0);

      expect(db.reviews).toHaveLength(2); // 不得 INSERT
      expect(db.reviews[0]!.status).toBe('open'); // older open 不得被 UPDATE
      expect(db.reviews[0]!.reasons).toBe('[]');
      expect(db.reviews[1]!.status).toBe('dismissed');
      expect(db.actions).toHaveLength(0);
    });

    it('F1：最新 banned 时 older open 不救场（跳过按最新一行判定）', async () => {
      db.reviews.push(mkReview({ id: 1, status: 'open', score: 25, reasons: '[]' }));
      db.reviews.push(
        mkReview({ id: 2, status: 'banned', score: 50, handled_by: 'admin-a', handled_at: new Date(T0 - 1000) }),
      );

      await mkSvc().applyScanResult('u-A', 50, R50, T0);

      expect(db.reviews).toHaveLength(2);
      expect(db.reviews[0]!.status).toBe('open');
      expect(db.reviews[0]!.score).toBe(25);
      expect(db.actions).toHaveLength(0);
    });

    it('审计行与状态变更**同事务**：中段失败 ⇒ 整批回滚（状态未变、无半程审计、旗未动）', async () => {
      db.reviews.push(mkReview({ id: 7, status: 'open', score: 25, reasons: '[]' }));
      db.failActionInsert = true; // 状态 UPDATE 之后、审计 INSERT 处炸

      await expect(mkSvc(true).applyScanResult('u-A', 50, R50, T0)).rejects.toThrowError(
        /actions insert boom/,
      );

      expect(db.reviews[0]!.status).toBe('open'); // 回滚：状态未迁
      expect(db.reviews[0]!.score).toBe(25);
      expect(db.actions).toHaveLength(0);
      // 🔴 旗**写**是最后一步：审计失败 ⇒ 根本没走到置旗（旗不会先于落库存在）。
      // （终审 F1 起武装前有一次旗**读**——`op: 'get'` 不在「写」计。）
      expect(redis.count('set', 'risk:limit:u-A')).toBe(0);
      expect(redis.count('del', 'risk:limit:u-A')).toBe(0);
    });
  });

  // ── ScanService：统计/判定/编排 ──────────────────────────────────────────

  describe('ScanService.runScanOnce（SQL1/2/3 + 判定 + 锁 + 自愈 + 指标）', () => {
    let db: FakeScanDb;
    let redis: FakeRedis;
    let reviews: { applyScanResult: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      db = new FakeScanDb();
      redis = new FakeRedis();
      reviews = { applyScanResult: vi.fn(async () => undefined) };
    });

    const mkSvc = (cache = makeScanConfig()) =>
      new ScanService(db.dataSource as never, redis as never, cache, reviews as never);

    /** 调用表：userId → { score, reasons }。 */
    const callsByUser = () =>
      Object.fromEntries(
        reviews.applyScanResult.mock.calls.map((c) => [
          c[0] as string,
          { score: c[1] as number, reasons: c[2] as unknown },
        ]),
      );

    it('命中矩阵：games>minGames 边界（=100 不算 / 101 且 winRate>0.8 算）；score∈{0,25,50}；并集合并', async () => {
      db.winRows = [
        { user_id: 'u-both', games: 101, wins: '81' }, // 字符串 wins（mysql2 Decimal 形态）⇒ Number 归一后 81/101>0.8
        { user_id: 'u-win', games: 101, wins: 90 },
        { user_id: 'u-bound-games', games: 100, wins: 100 }, // 恰 = minGames ⇒ 不 >
        { user_id: 'u-bound-rate', games: 125, wins: 100 }, // winRate 恰 = 0.8 ⇒ 不 >
      ];
      db.deviceRows = [
        { user_id: 'u-both', devices: 5 }, // 两命中 ⇒ 50
        { user_id: 'u-dev', devices: 4 }, // SQL2-only（games=0、hit1=false）⇒ 25
        { user_id: 'u-bound-dev', devices: 3 }, // 恰 = limit ⇒ 不 >
      ];

      const result = await mkSvc().runScanOnce(T0);

      expect(result).toEqual({ skipped: false, users: 6, flagged: 3 });
      // 语句面：SQL1（无参）→ SQL2（cutoff = now − 30d，逐毫秒）。
      expect(db.queries[0]).toEqual({ sql: SPEC_RISK_WIN_RATE_SQL, params: [] });
      expect(db.queries[1]).toEqual({
        sql: SPEC_RISK_DEVICE_COUNT_SQL,
        params: [new Date(T0 - 30 * DAY_MS)],
      });
      const calls = callsByUser();
      expect(calls['u-both']).toEqual({
        score: 50,
        reasons: [
          { check: 'winRate', detail: { games: 101, wins: 81, winRate: 81 / 101 } },
          { check: 'devices', detail: { devices: 5 } },
        ],
      });
      expect(calls['u-win']).toEqual({
        score: 25,
        reasons: [{ check: 'winRate', detail: { games: 101, wins: 90, winRate: 90 / 101 } }],
      });
      expect(calls['u-dev']).toEqual({
        score: 25,
        reasons: [{ check: 'devices', detail: { devices: 4 } }],
      });
      // 边界与无命中用户也**都被调用**（score=0、reasons 空）——规格 §2.5-2 括号：
      // 「score=0 ⇒ 本轮结束（但仍参与 … auto 旗回落判定）」⇒ 并集全量进状态机，
      // 回落（throttled(auto) 的解限）才有触达面。
      for (const id of ['u-bound-games', 'u-bound-rate', 'u-bound-dev']) {
        expect(calls[id], id).toEqual({ score: 0, reasons: [] });
      }
      // 每个调用都带 now 注入（同轮同一时刻）。
      for (const c of reviews.applyScanResult.mock.calls) expect(c[3]).toBe(T0);
    });

    it('窗口天数每轮现读：改 getter ⇒ 下一轮 SQL2 参数随之变（逐毫秒）', async () => {
      const cache = makeScanConfig({ deviceWindowDays: 30 });
      const svc = mkSvc(cache);

      await svc.runScanOnce(T0);
      (cache.riskDeviceWindowDays as ReturnType<typeof vi.fn>).mockReturnValue(7);
      await svc.runScanOnce(T0);

      const cutoffs = db.queries
        .filter((q) => q.sql === SPEC_RISK_DEVICE_COUNT_SQL)
        .map((q) => q.params[0]);
      expect(cutoffs).toEqual([new Date(T0 - 30 * DAY_MS), new Date(T0 - 7 * DAY_MS)]);
    });

    it('阈值每轮现读：minGames 改小后同一数据从 0 命中变命中', async () => {
      db.winRows = [{ user_id: 'u-A', games: 5, wins: 5 }];
      const cache = makeScanConfig({ minGames: 100 });
      const svc = mkSvc(cache);

      await svc.runScanOnce(T0);
      expect(callsByUser()['u-A']).toEqual({ score: 0, reasons: [] });

      (cache.riskMinGames as ReturnType<typeof vi.fn>).mockReturnValue(1);
      await svc.runScanOnce(T0);
      expect(callsByUser()['u-A']).toEqual({
        score: 25,
        reasons: [{ check: 'winRate', detail: { games: 5, wins: 5, winRate: 1 } }],
      });
    });

    it('锁：抢到（SET key 实例id EX 600 NX）⇒ 轮末 compare-and-delete 释放；GET==我 才 DEL', async () => {
      const svc = mkSvc();

      await svc.runScanOnce(T0);

      const set = redis.calls.find((c) => c.op === 'set' && c.key === RISK_SCAN_LOCK_KEY);
      expect(set?.args[0]).toEqual(expect.any(String)); // 实例 id（值随实例）
      expect((set?.args[0] as string).length).toBeGreaterThan(0);
      expect(set?.args.slice(1)).toEqual(['EX', RISK_SCAN_LOCK_TTL_SECONDS, 'NX']);
      expect(RISK_SCAN_LOCK_TTL_SECONDS).toBe(600);
      // CAD：GET 到自己的 id ⇒ DEL；锁键轮末不残留。
      const ops = redis.calls.filter((c) => c.key === RISK_SCAN_LOCK_KEY).map((c) => c.op);
      expect(ops).toEqual(['set', 'get', 'del']);
      expect(redis.store.has(RISK_SCAN_LOCK_KEY)).toBe(false);
    });

    it('锁：抢不到（键已被他人持有）⇒ 记 debug + 跳过本轮（零统计/零写旗/不删他人锁）', async () => {
      redis.store.set(RISK_SCAN_LOCK_KEY, 'other-instance');
      const before = await labeledMetric('risk_scan_runs_total', '{result="ok"}');
      const svc = mkSvc();

      const result = await svc.runScanOnce(T0);

      expect(result).toEqual({ skipped: true, users: 0, flagged: 0 });
      expect(db.queries).toHaveLength(0); // 一条统计都没发
      expect(reviews.applyScanResult).not.toHaveBeenCalled();
      expect(redis.count('del', RISK_SCAN_LOCK_KEY)).toBe(0); // 不删他人锁
      expect(redis.store.get(RISK_SCAN_LOCK_KEY)).toBe('other-instance');
      expect(await labeledMetric('risk_scan_runs_total', '{result="ok"}')).toBe(before);
      const dbg = captured.records.filter((r) => r.level === 'debug');
      expect(dbg.some((r) => r.msg.includes('lock'))).toBe(true);
    });

    it('锁：CAD 判别力——轮末 GET 值≠我的 id（他人已接管）⇒ 不 DEL', async () => {
      const svc = mkSvc();
      const gate = db.holdNextQuery();
      const p = svc.runScanOnce(T0);
      await flushMicrotasks(); // 让轮次走到被挂起的 SQL1
      expect(db.queries).toHaveLength(1); // 反空测：真的在途

      redis.store.set(RISK_SCAN_LOCK_KEY, 'other-instance'); // 模拟 EX 到期后他人接管
      gate.resolve([]);
      await p;

      expect(redis.count('del', RISK_SCAN_LOCK_KEY)).toBe(0);
      expect(redis.store.get(RISK_SCAN_LOCK_KEY)).toBe('other-instance');
    });

    it('自愈：SQL3 名单 → 复核读（仍 banned 才写旗；已解封竞态 ⇒ 不写）；旗值/EX 逐字', async () => {
      db.bannedIds = ['u-ban1', 'u-ban2'];
      db.statuses.set('u-ban1', 'banned');
      db.statuses.set('u-ban2', 'active'); // 名单读出后、写旗前被解封（设计 r1-F14 竞态负例）

      await mkSvc().runScanOnce(T0);

      // 复核读逐人执行（防「只读名单就写旗」）。
      const recheckQueries = db.queries.filter((q) => q.sql === SPEC_RISK_USER_STATUS_SQL);
      expect(recheckQueries.map((q) => q.params)).toEqual([['u-ban1'], ['u-ban2']]);
      const flagSets = redis.calls.filter((c) => c.op === 'set' && c.key.startsWith('risk:banned:'));
      expect(flagSets).toHaveLength(1);
      expect(flagSets[0]!.key).toBe('risk:banned:u-ban1');
      expect(flagSets[0]!.args).toEqual(['1', 'EX', RISK_BANNED_FLAG_TTL_SECONDS]);
      expect(RISK_BANNED_FLAG_TTL_SECONDS).toBe(7_776_000);
    });

    it('指标：成功轮 ⇒ runs{ok}+1、last_success=完成时刻（秒）、轮末 gauge=open 计数', async () => {
      db.openCount = 7;
      const okBefore = await labeledMetric('risk_scan_runs_total', '{result="ok"}');
      vi.setSystemTime(T0);

      await mkSvc().runScanOnce(T0);

      expect(await labeledMetric('risk_scan_runs_total', '{result="ok"}')).toBe(okBefore + 1);
      expect(await simpleMetric('risk_scan_last_success_timestamp_seconds')).toBe(T0 / 1000);
      expect(await simpleMetric('risk_reviews_open')).toBe(7);
    });

    it('失败轮：SQL 抛 ⇒ runs{fail}+1、last_success 不擦、异常上抛、锁照常释放', async () => {
      riskScanLastSuccessTimestampSeconds.set(123);
      const failBefore = await labeledMetric('risk_scan_runs_total', '{result="fail"}');
      db.failuresRemaining = 1; // SQL1 就抛
      const svc = mkSvc();

      await expect(svc.runScanOnce(T0)).rejects.toThrowError(/db down/);

      expect(await labeledMetric('risk_scan_runs_total', '{result="fail"}')).toBe(failBefore + 1);
      expect(await simpleMetric('risk_scan_last_success_timestamp_seconds')).toBe(123);
      expect(redis.count('del', RISK_SCAN_LOCK_KEY)).toBe(1); // finally 释放照走
    });

    it('单用户失败不拖垮整轮：一人 applyScanResult 抛 ⇒ 其余照跑、轮记 ok、warn 留痕', async () => {
      db.winRows = [
        { user_id: 'u-bad', games: 5, wins: 5 },
        { user_id: 'u-good', games: 5, wins: 5 },
      ];
      reviews.applyScanResult.mockRejectedValueOnce(new Error('apply boom（仿真）'));
      const okBefore = await labeledMetric('risk_scan_runs_total', '{result="ok"}');
      vi.setSystemTime(T0);

      const result = await mkSvc(makeScanConfig({ minGames: 1 })).runScanOnce(T0);

      expect(result.skipped).toBe(false);
      expect(reviews.applyScanResult).toHaveBeenCalledTimes(2); // 两人都尝试
      expect(await labeledMetric('risk_scan_runs_total', '{result="ok"}')).toBe(okBefore + 1);
      expect(await simpleMetric('risk_scan_last_success_timestamp_seconds')).toBe(T0 / 1000); // 部分失败 ⇒ 仍刷
      const warns = captured.records.filter((r) => r.level === 'warn');
      expect(warns.some((r) => r.msg.includes('u-bad') && r.msg.includes('applyScanResult'))).toBe(
        true,
      );
    });

    it('波2 F7：全量候选失败 ⇒ 按失败轮处理（runs{fail}+1、不记 ok、last_success 不推进）', async () => {
      db.winRows = [
        { user_id: 'u-1', games: 5, wins: 5 },
        { user_id: 'u-2', games: 5, wins: 5 },
      ];
      reviews.applyScanResult.mockRejectedValue(new Error('drift boom（仿真）'));
      riskScanLastSuccessTimestampSeconds.set(123);
      const failBefore = await labeledMetric('risk_scan_runs_total', '{result="fail"}');
      const okBefore = await labeledMetric('risk_scan_runs_total', '{result="ok"}');

      await expect(mkSvc(makeScanConfig({ minGames: 1 })).runScanOnce(T0)).rejects.toThrowError(
        /all-candidates-failed/,
      );

      expect(await labeledMetric('risk_scan_runs_total', '{result="fail"}')).toBe(failBefore + 1);
      expect(await labeledMetric('risk_scan_runs_total', '{result="ok"}'), '不记 ok').toBe(okBefore);
      expect(
        await simpleMetric('risk_scan_last_success_timestamp_seconds'),
        '全量失败 ⇒ 不推进（否则 RiskScanStalled 永不响）',
      ).toBe(123);
    });

    it('波2 F7：全量失败走定时路径 ⇒ error 行含 all-candidates-failed 字样（告警可见面）', async () => {
      db.winRows = [{ user_id: 'u-1', games: 5, wins: 5 }];
      reviews.applyScanResult.mockRejectedValue(new Error('drift boom（仿真）'));
      const svc = mkSvc(makeScanConfig({ minGames: 1 }));
      svc.onModuleInit();

      await vi.advanceTimersByTimeAsync(RISK_SCAN_FIRST_RUN_DELAY_MS);

      const errors = captured.records.filter((r) => r.level === 'error');
      expect(errors.some((r) => r.msg.includes('all-candidates-failed'))).toBe(true);
      svc.onApplicationShutdown();
    });

    it('波2 F7 负向：空库（n=0）⇒ 照常 ok（全量失败判据不许在空集上误判）', async () => {
      const okBefore = await labeledMetric('risk_scan_runs_total', '{result="ok"}');

      const result = await mkSvc().runScanOnce(T0);

      expect(result).toEqual({ skipped: false, users: 0, flagged: 0 });
      expect(await labeledMetric('risk_scan_runs_total', '{result="ok"}')).toBe(okBefore + 1);
    });

    it('心跳日志：每轮一条（users/flagged/durationMs 读数；timer 来源 + 自建 traceId）', async () => {
      db.winRows = [{ user_id: 'u-A', games: 5, wins: 5 }];

      await mkSvc(makeScanConfig({ minGames: 1 })).runScanOnce(T0);

      const rounds = (): LogRecord[] =>
        captured.records.filter((r) => r.msg.includes('risk scan done'));
      expect(rounds()).toHaveLength(1);
      const line = rounds()[0]!;
      expect(line.level).toBe('log');
      expect(line.source).toBe('timer');
      expect(line.traceId).not.toBeNull();
      expect(line.msg).toContain('users=1');
      expect(line.msg).toContain('flagged=1');
      expect(line.msg).toMatch(/durationMs=\d+/);
    });
  });

  // ── ScanService：节奏（自重排 + 首排动作 + 关停闸；照清理骨架先例）────────────

  describe('ScanService 节奏（首轮 30s / 间隔配置现读 / 首排动作 / 关停闸）', () => {
    let db: FakeScanDb;
    let redis: FakeRedis;
    let reviews: { applyScanResult: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      db = new FakeScanDb();
      redis = new FakeRedis();
      reviews = { applyScanResult: vi.fn(async () => undefined) };
    });

    const mkSvc = (cache = makeScanConfig()) =>
      new ScanService(db.dataSource as never, redis as never, cache, reviews as never);
    const rounds = () => db.queries.filter((q) => q.sql === SPEC_RISK_WIN_RATE_SQL).length;

    it('常量：默认间隔 1h、首轮延迟 30s（配置面只改**间隔**、不改首轮延迟）', () => {
      // `RISK_SCAN_DEFAULT_INTERVAL_MS` 现为 `config-cache.service` 的 re-export —— 引用面不变
      // （本断言同时钉 re-export 的值面与可达性）。
      expect(RISK_SCAN_DEFAULT_INTERVAL_MS).toBe(3_600_000);
      expect(RISK_SCAN_FIRST_RUN_DELAY_MS).toBe(30_000);
    });

    it('节奏：启动后 30s 首轮；随后按缓存现读的 1h 默认自重排（advance 边界两侧）', async () => {
      const svc = mkSvc();
      svc.onModuleInit();

      await vi.advanceTimersByTimeAsync(RISK_SCAN_FIRST_RUN_DELAY_MS - 1);
      expect(rounds(), '29.999s 时点：首轮还没到').toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(rounds()).toBe(1);

      await vi.advanceTimersByTimeAsync(RISK_SCAN_DEFAULT_INTERVAL_MS - 1);
      expect(rounds(), '未到 1h：不排第 2 轮').toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(rounds()).toBe(2);

      svc.onApplicationShutdown();
    });

    it('假缓存注入：riskScanIntervalMs=100 ⇒ 第 2 轮触发点 = 第 1 轮结束 + 100（+99 不触发）', async () => {
      const svc = mkSvc(makeScanConfig({ intervalMs: 100 }));
      svc.onModuleInit();

      await vi.advanceTimersByTimeAsync(RISK_SCAN_FIRST_RUN_DELAY_MS);
      expect(rounds(), '首轮仍在 30s（配置的是**间隔**，不是首轮延迟）').toBe(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(rounds(), '第 1 轮结束 + 99ms：第 2 轮还没到点').toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        rounds(),
        '第 2 轮触发点 = 第 1 轮结束 + 100（重排处现读的缓存注入值）',
      ).toBe(2);

      svc.onApplicationShutdown();
    });

    it('重排现读（本片核心 ⚙️7）：一轮跑完 ⇒ 下一轮延迟 = 现读值；改值 ⇒ 再下一轮用新值', async () => {
      const cache = makeScanConfig();
      const riskScanIntervalMs = cache.riskScanIntervalMs as ReturnType<typeof vi.fn>;
      const svc = mkSvc(cache);
      expect(
        riskScanIntervalMs,
        '构造期不得读间隔（旧形态 = 构造期读 env —— 「现读」的判别力靠这个前置态支撑）',
      ).not.toHaveBeenCalled();

      svc.onModuleInit(); // 快路径：hasSnapshot=true ⇒ 同帧打启动行（读 #1）+ 排首轮 30s
      expect(riskScanIntervalMs, '启动行恰读一次').toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(RISK_SCAN_FIRST_RUN_DELAY_MS); // 首轮跑完
      expect(rounds()).toBe(1);
      expect(riskScanIntervalMs, '排期处恰再读一次（读 #2）').toHaveBeenCalledTimes(2);

      // 首轮收尾现读 = 默认 3600000 ⇒ 第 2 轮 @ +3600000。改值发生在其后 ⇒ 已排定的一轮不撤：
      riskScanIntervalMs.mockReturnValue(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(
        rounds(),
        '改值不撤已排定的一轮（+3000 时点第 2 轮仍未到）',
      ).toBe(1);
      await vi.advanceTimersByTimeAsync(3_600_000 - 3_000);
      expect(
        rounds(),
        '第 2 轮触发点 = 第 1 轮结束 + 3600000（旧形态「构造期读一次」也能过这句——判别力在下一段）',
      ).toBe(2);

      // 第 2 轮收尾现读 = 新值 3000 ⇒ 第 3 轮 @ +3000（改键自该轮收尾排期起生效）：
      await vi.advanceTimersByTimeAsync(2_999);
      expect(rounds(), '3000 改值后 +2999：第 3 轮未到点').toBe(2);
      riskScanIntervalMs.mockReturnValue(7_000); // 第 3 轮未跑完：再改（影响第 3 轮收尾的现读）
      await vi.advanceTimersByTimeAsync(1);
      expect(
        rounds(),
        '第 3 轮触发点 = 第 2 轮结束 + 3000（现读新值 3000 —— 构造期读一次的实现这里会是 +3600000）',
      ).toBe(3);

      // 第 3 轮收尾现读 = 7000 ⇒ 第 4 轮 @ +7000：
      await vi.advanceTimersByTimeAsync(6_999);
      expect(rounds()).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(rounds(), '第 4 轮触发点 = 第 3 轮结束 + 7000（再次现读）').toBe(4);

      svc.onApplicationShutdown();
    });

    it('首排动作三态：晚到（wait 后 resolve ⇒ 用缓存值）/超时（缺省）/超时后迟到 ⇒ 恰一次排期', async () => {
      const startedLines = (): LogRecord[] =>
        captured.records.filter((r) => r.msg.includes('Risk scan loop started'));

      // 态 1 · 晚到：hasSnapshot=false，快照在等待窗内就绪 ⇒ 续体用缓存值打行 + 排首轮。
      {
        db = new FakeScanDb();
        const cache = makeScanConfig({ intervalMs: 3_000 });
        let resolveWait!: () => void;
        const wait = new Promise<void>((r) => (resolveWait = r));
        cache.hasSnapshot = () => false;
        cache.waitForFirstSnapshot = () => wait;
        const svc = mkSvc(cache);

        svc.onModuleInit();
        expect(startedLines(), '等待期：启动行还没打（打印唯一落点 = afterSnapshotReady）').toHaveLength(0);
        expect(vi.getTimerCount(), '等待路：有界等待定时器恰一枚').toBe(1);

        resolveWait(); // 快照就绪（早于超时）
        await vi.advanceTimersByTimeAsync(0); // 微任务冲刷：settle ⇒ afterSnapshotReady
        expect(startedLines()).toHaveLength(1);
        expect(startedLines()[0]!.msg, '晚到路：interval = 缓存解析值（非缺省）').toContain(
          'interval 3000ms',
        );
        expect(vi.getTimerCount(), '败方定时器已清 + 首轮已排 = 恰一枚').toBe(1);

        await vi.advanceTimersByTimeAsync(RISK_SCAN_FIRST_RUN_DELAY_MS);
        expect(rounds(), '晚到路：首轮仍按 30s 常数排').toBe(1);
        svc.onApplicationShutdown();
      }

      // 态 2 · 超时：等待窗（SNAPSHOT_BOOT_WAIT_MS）到点 ⇒ 按缺省解析先打行排期（降级拓扑；下一轮重排自愈）。
      {
        db = new FakeScanDb();
        const cache = makeScanConfig({}); // 缺省 3600000 = 缓存「快照不可用回落种子」的替身
        cache.hasSnapshot = () => false;
        cache.waitForFirstSnapshot = () => new Promise<void>(() => {}); // 永不就绪
        const svc = mkSvc(cache);

        svc.onModuleInit();
        await vi.advanceTimersByTimeAsync(SNAPSHOT_BOOT_WAIT_MS - 1);
        expect(startedLines(), '超时前 1ms：仍未打行排期（有界等待的上界）').toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(startedLines(), '超时到点：按缺省解析打行排期').toHaveLength(2);
        expect(startedLines()[1]!.msg).toContain('interval 3600000ms');
        expect(vi.getTimerCount(), '等待定时器已消费 + 首轮在挂 = 恰一枚').toBe(1);

        await vi.advanceTimersByTimeAsync(RISK_SCAN_FIRST_RUN_DELAY_MS);
        expect(rounds(), '降级拓扑照样跑首轮').toBe(1);
        svc.onApplicationShutdown();
      }

      // 态 3 · 超时后迟到（r1 🟠1 的要害形态）：once 闸让就绪路 no-op —— 否则双排期双链。
      {
        db = new FakeScanDb();
        const cache = makeScanConfig({ intervalMs: 3_000 });
        let resolveWait!: () => void;
        const wait = new Promise<void>((r) => (resolveWait = r));
        cache.hasSnapshot = () => false;
        cache.waitForFirstSnapshot = () => wait;
        const svc = mkSvc(cache);

        svc.onModuleInit();
        await vi.advanceTimersByTimeAsync(SNAPSHOT_BOOT_WAIT_MS); // 超时路先赢（打行 + 排 30s 首轮）
        expect(startedLines()).toHaveLength(3);
        expect(vi.getTimerCount(), '首轮已排 = 恰一枚').toBe(1);

        resolveWait(); // 快照 >10s 迟到
        await vi.advanceTimersByTimeAsync(0);
        expect(
          startedLines(),
          'once 闸：就绪路 no-op（双排期实现这里会打第二条启动行）',
        ).toHaveLength(3);
        expect(vi.getTimerCount(), 'once 闸：不双排期（双链实现这里是 2）').toBe(1);

        await vi.advanceTimersByTimeAsync(RISK_SCAN_FIRST_RUN_DELAY_MS);
        expect(rounds(), '恰一条链：30s 到点恰跑一轮（双链会跑两轮）').toBe(1);
        expect(vi.getTimerCount(), '该轮收尾重排（现读 3000）= 恰一枚').toBe(1);
        svc.onApplicationShutdown();
      }
    });

    it('首排动作：续体关停闸（等待期间 shutdown ⇒ 零排期；getTimerCount()===0 终态）', async () => {
      const cache = makeScanConfig({ intervalMs: 3_000 });
      let resolveWait!: () => void;
      const wait = new Promise<void>((r) => (resolveWait = r));
      cache.hasSnapshot = () => false;
      cache.waitForFirstSnapshot = () => wait;
      const svc = mkSvc(cache);

      svc.onModuleInit();
      expect(vi.getTimerCount(), '反空测：等待定时器在挂').toBe(1);

      svc.onApplicationShutdown(); // 等待期间关停
      resolveWait(); // 就绪路迟到：settle ⇒ afterSnapshotReady（关停闸在此拦住）
      await vi.advanceTimersByTimeAsync(0);

      expect(
        captured.records.filter((r) => r.msg.includes('Risk scan loop started')),
        '关停闸：迟到的续体不得打启动行、不得排期',
      ).toHaveLength(0);
      expect(vi.getTimerCount(), '终态：胜方 settle 清掉等待定时器 + 零排期').toBe(0);
      await vi.advanceTimersByTimeAsync(RISK_SCAN_FIRST_RUN_DELAY_MS + 1);
      expect(db.queries, '关停后零轮（无复活链）').toHaveLength(0);
    });

    it('启动行 interval 位 = 解析值（⚙️6 逐字；快路径同帧打印）', () => {
      const svc = mkSvc(makeScanConfig({ intervalMs: 3_000 }));

      svc.onModuleInit();
      // 快路径「真同步」的证明方式 = 本测试全程不 await、不推进定时器：
      // `onModuleInit` 返回时启动行**已在 sink 里**，首轮定时器**已挂上**（同帧解析+打+排）。
      const started = captured.records.filter((r) => r.msg.includes('Risk scan loop started'));
      expect(started).toHaveLength(1);
      expect(started[0]!.msg).toBe(
        'Risk scan loop started (first run in 30000ms, interval 3000ms)',
      );
      expect(vi.getTimerCount(), '首轮定时器同帧排定').toBe(1);
      expect(db.queries, '排首轮 ≠ 跑首轮（同帧不得有查询）').toHaveLength(0);

      svc.onApplicationShutdown();
    });

    it('onModuleInit：last_success 先置 0（「从未成功」语义 ⇒ RiskScanStalled 必命中）', async () => {
      riskScanLastSuccessTimestampSeconds.set(999);
      const svc = mkSvc();

      svc.onModuleInit();

      expect(await simpleMetric('risk_scan_last_success_timestamp_seconds')).toBe(0);
      svc.onApplicationShutdown();
    });

    it('关停闸：第 1 轮在途时关停 ⇒ 迟到的回执不再排下一轮', async () => {
      const svc = mkSvc();
      svc.onModuleInit();

      const gate = db.holdNextQuery();
      await vi.advanceTimersByTimeAsync(RISK_SCAN_FIRST_RUN_DELAY_MS);
      expect(db.queries, '反空测：第 1 轮必须真的在途').toHaveLength(1);

      svc.onApplicationShutdown();
      gate.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      const settled = db.queries.length;

      expect(
        (svc as unknown as { timer: unknown }).timer,
        '关停后不得再排定时器（闸被删掉时这里会非 null）',
      ).toBeNull();
      await vi.advanceTimersByTimeAsync(10 * RISK_SCAN_DEFAULT_INTERVAL_MS);
      expect(db.queries, '放行后不得再跑（无复活循环）').toHaveLength(settled);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════

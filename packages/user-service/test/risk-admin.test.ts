/**
 * 风控片 T6 —— user 管理端点（判据 **C19**；规格 §2.8 四端点 · §2.7-1/3 封禁写/解封 ·
 * ⚙️19 五动作×状态迁移 · §2.13 错误映射；T5 遗留裁决第 0 条 = 1213 重试一次再失败 ⇒ 409；
 * 波 2 评审订正 **F2**（`risk:banned` 旗写后置 COMMIT 之后 + unban 源态放宽清孤儿旗）与
 * **F6**（reviewId 陈旧断言仅条目态动作 + 存在性先于其余校验）的用例已含在本文件；
 * **终审 F2**（详情 `bannedFlagPresent` 展示位）用例在 HTTP 面节）。
 *
 * ─── 夹具（三件，形态照 T5 / config-service 审计读口先例）──────────────────────
 *  - **FakeRiskAdminDb**：内存四表（reviews/actions/users/devices）+ **SQL 解释器**
 *    （keyset 列表按条件子句文本逐条解释、不认识 ⇒ 当场抛）；写语句按**全文常量**识别
 *    （漂移 ⇒ 未识别 ⇒ 红）；`dataSource.transaction` 带快照回滚语义 + **死锁注入面**
 *    （`failActionInsertOnce/Always` 挂 1213 形态 ⇒ 重试路径可测）。
 *  - **FakeRedis**：`SET/GET/DEL/MGET` 键值语义 + 故障注入（`failGet`/`failMget` —— R11
 *    旗读 fail-open 的取证面）。
 *  - **真 Nest 管线探针**（照 `admin-users.controller.test.ts`）：真 `AdminRiskController`
 *    + 真 `AdminRiskService`/`ReviewsService` + 真 `XAdminGuard` + 真异常过滤器 + globalPrefix。
 *
 * ⚠️ 假库**不证** InnoDB 并发/时态与真 HTTP 全链 —— 真栈演练读数在 progress 核销节。
 * ⚠️ `listen(0)` 在 Windows 上偶发撞已知假红族 ⑤（判别法：同一次 run 同文件某阶段绿另阶段红）。
 */
import 'reflect-metadata';
import { Logger, Module, ValidationPipe, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { CSV_BOM, ErrCode } from '@fight-the-landlord/protocol';
import {
  createCapturingSink,
  createRedactingLogger,
  metricsRegistry,
} from '@fight-the-landlord/shared';
import {
  ReviewsService,
  RiskConflictError,
  RISK_ADMIN_REVIEW_TRANSITION_SQL,
  RISK_BANNED_FLAG_TTL_SECONDS,
  RISK_UPSERT_LOCK_SQL,
  RISK_USER_STATUS_SQL,
  RISK_USER_STATUS_UPDATE_SQL,
  riskBannedKey,
  riskLimitKey,
} from '../src/risk/reviews.service';
import {
  ACTIONS_SELECT_BASE,
  AdminRiskService,
  REVIEWS_SELECT_BASE,
  RISK_DEVICE_COUNT_WINDOW_SQL,
  RISK_DEVICE_OTHERS_SQL,
  RISK_DEVICES_SELECT_SQL,
  RISK_ENTRIES_SQL,
  RISK_STATS_SQL,
  RISK_STATS_PDK_SQL,
} from '../src/risk/admin-risk.service';
import { AdminRiskController } from '../src/risk/admin-risk.controller';
import {
  DeviceBindingsService,
  DEVICE_BINDING_SELECT_SQL,
  DEVICE_BINDING_INSERT_IGNORE_SQL,
  DEVICE_BINDING_DELETE_SQL,
  DEVICE_BINDING_LOCK_SELECT_SQL,
  DEVICE_UNBIND_AUDIT_INSERT_SQL,
  riskBindingKey,
} from '../src/risk/device-bindings.service';
import { ADMIN_ACTOR_HEADER, ADMIN_HEADER } from '../src/http/x-admin.guard';
import type { ConfigCacheService } from '../src/config/config-cache.service';

/** 固定时间轴原点（`now` 注入；不随真实时钟漂移）。 */
const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const DAY_MS = 86_400_000;

// ─── 规格逐字/契约逐字（**测试侧独立誊写** —— 断言执行面，不是回抄实现常量）──────

/** 管理动作的 review 行迁移（T6 定死的写入形；列序 = 状态/处置者/处置时刻/行 id）。 */
const SPEC_ADMIN_TRANSITION_SQL =
  'UPDATE risk_reviews SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?';
/** 用户状态迁移（封禁/解封共用：'banned'/'active' 由动作决定）。 */
const SPEC_USER_STATUS_UPDATE_SQL = 'UPDATE users SET status = ? WHERE id = ?';
/** 状态机冲突文案前缀（规格 §2.13：「当前状态不允许该动作」，并指明合法动作）。 */
const CONFLICT_PREFIX = '当前状态不允许该动作';
/** 1213 重试再失败文案（T5 遗留裁决第 0 条逐字）。 */
const CONCURRENCY_MESSAGE = '并发冲突，请重试';

/** 2026-10-25 跑得快详情 stats SQL 逐字（spec §5.5；**测试侧独立誊写**）。 */
const SPEC_RISK_STATS_PDK_SQL =
  "SELECT COUNT(*) AS games, COALESCE(SUM(CASE WHEN p.seat = r.winner_seat THEN 1 ELSE 0 END), 0) AS wins FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id WHERE p.user_id = ? AND r.mode IN ('random', 'gold') AND p.is_robot = 0";

const AUTH_READ = { [ADMIN_HEADER]: '1' };
const AUTH_WRITE = { [ADMIN_HEADER]: '1', [ADMIN_ACTOR_HEADER]: 'tester' };

// ─── 行形状 ─────────────────────────────────────────────────────────────────

interface ReviewRow {
  id: number;
  user_id: string;
  score: number;
  reasons: unknown;
  status: string;
  created_at: Date;
  updated_at: Date;
  handled_by: string | null;
  handled_at: Date | null;
}

interface ActionRow {
  id: number;
  user_id: string;
  action: string;
  actor: string;
  reason: string | null;
  review_id: number | null;
  detail: unknown;
  created_at: Date;
}

interface DeviceRow {
  user_id: string;
  device_id: string;
  first_seen_at: Date;
  last_seen_at: Date;
}

function mkReview(over: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 1,
    user_id: 'u-A',
    score: 25,
    reasons: [{ check: 'winRate', detail: { games: 101, wins: 90 } }],
    status: 'open',
    created_at: new Date(T0 - 3_600_000),
    updated_at: new Date(T0 - 3_600_000),
    handled_by: null,
    handled_at: null,
    ...over,
  };
}

function mkAction(over: Partial<ActionRow> = {}): ActionRow {
  return {
    id: 1,
    user_id: 'u-A',
    action: 'dismiss',
    actor: 'admin',
    reason: '示例',
    review_id: 1,
    detail: null,
    created_at: new Date(T0 - 1_800_000),
    ...over,
  };
}

// ─── FakeRiskAdminDb ────────────────────────────────────────────────────────

interface Statement {
  sql: string;
  params: unknown[];
}

type Predicate<R> = (row: R, value: unknown) => boolean;

const REVIEW_PREDICATES: Record<string, Predicate<ReviewRow>> = {
  'status = ?': (r, v) => r.status === v,
  'id < ?': (r, v) => r.id < Number(v),
};

const ACTION_PREDICATES: Record<string, Predicate<ActionRow>> = {
  'user_id = ?': (r, v) => r.user_id === v,
  'action = ?': (r, v) => r.action === v,
  'actor = ?': (r, v) => r.actor === v,
  'created_at >= ?': (r, v) => r.created_at.getTime() >= (v as Date).getTime(),
  'created_at < ?': (r, v) => r.created_at.getTime() < (v as Date).getTime(),
  'id < ?': (r, v) => r.id < Number(v),
};

/** 审计 INSERT 的契约文本（波 2 F2 起含 `detail` 列；只按全文识别）。 */
const ACTION_INSERT_SQL_TEXT =
  'INSERT INTO risk_actions (user_id, action, actor, reason, review_id, detail) VALUES (?, ?, ?, ?, ?, ?)';

class FakeRiskAdminDb {
  reviews: ReviewRow[] = [];
  actions: ActionRow[] = [];
  devices: DeviceRow[] = [];
  /**
   * 设备绑定片 `user_device_bindings` 表：userId → {device_id, bound_at}
   * （1:1；与 `devices` 的 1:N 历史链分表）。
   */
  bindings = new Map<string, { device_id: string; bound_at: Date }>();
  /** users 表：id → status（缺席 = 用户不存在）。 */
  users = new Map<string, string>();
  /** 胜率统计的定值回执（SQL 真形态的 JOIN 不在假库重演；缺省 {0,0}）。 */
  winStats = new Map<string, { games: number; wins: number }>();
  /** 跑得快详情统计的定值回执（2026-10-25；缺省 {0,0}）。 */
  pdkWinStats = new Map<string, { games: number; wins: number }>();
  queries: Statement[] = [];
  /** `dataSource.transaction` 调用次数（1213 重试断言面）。 */
  transactions = 0;
  /** 审计 INSERT 注入（once 消一次 / always 恒炸 —— 1213 形态用 `deadlockErr()` 造）。 */
  failActionInsertOnce: Error | null = null;
  failActionInsertAlways: Error | null = null;
  private nextReviewId = 1;
  private nextActionId = 1;

  /** 跨对象 call-order 观测（可选共享数组；波 2 F2「旗写在 COMMIT 之后」的断言面）。 */
  constructor(private readonly sharedLog: string[] = []) {}

  /** 1213 死锁的两种驱动形态（mysql2 裸形态 / TypeORM 包裹形态）。 */
  static deadlockErr(): Error {
    const e = new Error('Deadlock found when trying to get lock; try restarting transaction');
    (e as unknown as { errno: number }).errno = 1213;
    return e;
  }

  readonly dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> =>
      Promise.resolve(this.exec(sql, params)),
    // 事务替身：抛出 ⇒ 存储回滚（「同事务」的存储面语义；真 InnoDB 证据在真栈演练）。
    transaction: async <T,>(cb: (manager: unknown) => Promise<T>): Promise<T> => {
      this.transactions += 1;
      this.sharedLog.push('tx:begin');
      const snap = this.snapshot();
      try {
        const result = await cb(this.manager);
        this.sharedLog.push('tx:end');
        return result;
      } catch (err) {
        this.sharedLog.push('tx:rollback');
        this.restore(snap);
        throw err;
      }
    },
  };

  manager = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> =>
      Promise.resolve(this.exec(sql, params)),
  };

  private snapshot() {
    return {
      reviews: this.reviews.map((r) => ({ ...r })),
      actions: this.actions.map((a) => ({ ...a })),
      users: new Map(this.users),
      bindings: new Map(this.bindings),
    };
  }

  private restore(snap: ReturnType<FakeRiskAdminDb['snapshot']>): void {
    this.reviews = snap.reviews;
    this.actions = snap.actions;
    this.users = snap.users;
    this.bindings = snap.bindings;
  }

  addReview(over: Partial<ReviewRow> = {}): ReviewRow {
    const row = mkReview({ id: this.nextReviewId++, ...over });
    this.reviews.push(row);
    return row;
  }

  addAction(over: Partial<ActionRow> = {}): ActionRow {
    const row = mkAction({ id: this.nextActionId++, ...over });
    this.actions.push(row);
    return row;
  }

  /** 某用户按发生顺序的审计行（断言面五键 = 规格 §2.8 审计行的核心列）。 */
  actionsOf(userId: string): Array<{
    user_id: string;
    action: string;
    actor: string;
    reason: string | null;
    review_id: number | null;
  }> {
    return this.actions
      .filter((a) => a.user_id === userId)
      .map((a) => ({
        user_id: a.user_id,
        action: a.action,
        actor: a.actor,
        reason: a.reason,
        review_id: a.review_id,
      }));
  }

  /** 用例间隔离（探针应用只装配一次；服务持有本对象引用）。 */
  reset(): void {
    this.reviews = [];
    this.actions = [];
    this.devices = [];
    this.bindings = new Map();
    this.users = new Map();
    this.winStats = new Map();
    this.pdkWinStats = new Map();
    this.queries = [];
    this.transactions = 0;
    this.failActionInsertOnce = null;
    this.failActionInsertAlways = null;
    this.nextReviewId = 1;
    this.nextActionId = 1;
    this.sharedLog.length = 0;
  }

  exec(sql: string, params: unknown[]): unknown {
    this.queries.push({ sql, params });

    // ── 写面（全文识别；漂移 ⇒ 未识别 ⇒ 当场红）──────────────────────────
    if (sql === RISK_UPSERT_LOCK_SQL) {
      const [userId] = params as [string];
      const rows = this.reviews.filter((r) => r.user_id === userId).sort((a, b) => b.id - a.id);
      if (rows.length === 0) return [];
      const latest = rows[0]!;
      return [
        {
          id: latest.id,
          status: latest.status,
          score: latest.score,
          handled_by: latest.handled_by,
          handled_at: latest.handled_at,
        },
      ];
    }
    if (sql === RISK_ADMIN_REVIEW_TRANSITION_SQL) {
      const [status, handledBy, handledAt, id] = params as [string, string, Date, number];
      const row = this.reviews.find((r) => r.id === Number(id));
      if (!row) throw new Error(`FakeRiskAdminDb：risk_reviews 无 id=${String(id)} 行`);
      row.status = status;
      row.handled_by = handledBy;
      row.handled_at = handledAt;
      row.updated_at = handledAt;
      return { affectedRows: 1 };
    }
    if (sql === ACTION_INSERT_SQL_TEXT) {
      if (this.failActionInsertAlways !== null) throw this.failActionInsertAlways;
      if (this.failActionInsertOnce !== null) {
        const err = this.failActionInsertOnce;
        this.failActionInsertOnce = null;
        throw err;
      }
      const [user_id, action, actor, reason, review_id, detail] = params as [
        string,
        string,
        string,
        string | null,
        number | null,
        string | null,
      ];
      this.actions.push({
        id: this.nextActionId++,
        user_id,
        action,
        actor,
        reason,
        review_id,
        detail,
        created_at: new Date(),
      });
      return { affectedRows: 1 };
    }
    if (sql === RISK_USER_STATUS_SQL) {
      const [userId] = params as [string];
      const status = this.users.get(userId);
      return status === undefined ? [] : [{ status }];
    }
    if (sql === RISK_USER_STATUS_UPDATE_SQL) {
      const [status, userId] = params as [string, string];
      if (!this.users.has(userId)) return { affectedRows: 0 };
      this.users.set(userId, status);
      return { affectedRows: 1 };
    }

    // ── 设备绑定片（user_device_bindings + device_unbind 审计）─────────────────
    if (sql === DEVICE_BINDING_SELECT_SQL) {
      const [userId] = params as [string];
      const row = this.bindings.get(userId);
      return row ? [{ device_id: row.device_id, bound_at: row.bound_at }] : [];
    }
    if (sql === DEVICE_BINDING_LOCK_SELECT_SQL) {
      const [userId] = params as [string];
      const row = this.bindings.get(userId);
      return row ? [{ device_id: row.device_id }] : [];
    }
    if (sql === DEVICE_BINDING_INSERT_IGNORE_SQL) {
      const [userId, deviceId] = params as [string, string];
      if (this.bindings.has(userId)) return { affectedRows: 0 }; // PK 裁决：首台已占
      this.bindings.set(userId, { device_id: deviceId, bound_at: new Date() });
      return { affectedRows: 1 };
    }
    if (sql === DEVICE_BINDING_DELETE_SQL) {
      const [userId] = params as [string];
      const existed = this.bindings.delete(userId);
      return { affectedRows: existed ? 1 : 0 };
    }
    if (sql === DEVICE_UNBIND_AUDIT_INSERT_SQL) {
      // 与五动作审计同形的故障注入面（once）：验证解绑事务回滚 ⇒ 绑行仍在、post-commit DEL 不发。
      if (this.failActionInsertOnce !== null) {
        const err = this.failActionInsertOnce;
        this.failActionInsertOnce = null;
        throw err;
      }
      const [user_id, actor, detail] = params as [string, string, string | null];
      this.actions.push({
        id: this.nextActionId++,
        user_id,
        action: 'device_unbind',
        actor,
        reason: null,
        review_id: null,
        detail,
        created_at: new Date(),
      });
      return { affectedRows: 1 };
    }

    // ── 读面 ────────────────────────────────────────────────────────────
    if (sql.startsWith(REVIEWS_SELECT_BASE)) {
      return this.execKeyset(REVIEWS_SELECT_BASE, REVIEW_PREDICATES, sql, params, this.reviews);
    }
    if (sql.startsWith(ACTIONS_SELECT_BASE)) {
      return this.execKeyset(ACTIONS_SELECT_BASE, ACTION_PREDICATES, sql, params, this.actions);
    }
    if (sql === RISK_STATS_SQL) {
      const [userId] = params as [string];
      const s = this.winStats.get(userId) ?? { games: 0, wins: 0 };
      return [{ games: s.games, wins: s.wins }];
    }
    if (sql === SPEC_RISK_STATS_PDK_SQL) {
      const [userId] = params as [string];
      const s = this.pdkWinStats.get(userId) ?? { games: 0, wins: 0 };
      return [{ games: s.games, wins: s.wins }];
    }
    if (sql === RISK_DEVICE_COUNT_WINDOW_SQL) {
      const [userId, cutoff] = params as [string, Date];
      const set = new Set(
        this.devices
          .filter((d) => d.user_id === userId && d.last_seen_at.getTime() >= cutoff.getTime())
          .map((d) => d.device_id),
      );
      return [{ devices: set.size }];
    }
    if (sql === RISK_DEVICES_SELECT_SQL) {
      const [userId] = params as [string];
      return this.devices
        .filter((d) => d.user_id === userId)
        .sort((a, b) => b.last_seen_at.getTime() - a.last_seen_at.getTime())
        .map((d) => ({ ...d }));
    }
    if (sql === RISK_DEVICE_OTHERS_SQL) {
      const [deviceId, selfUserId] = params as [string, string];
      return this.devices
        .filter((d) => d.device_id === deviceId && d.user_id !== selfUserId)
        .sort((a, b) => b.last_seen_at.getTime() - a.last_seen_at.getTime())
        .flatMap((d) => {
          const status = this.users.get(d.user_id);
          return status === undefined ? [] : [{ user_id: d.user_id, status }];
        })
        .slice(0, 20);
    }
    if (sql === RISK_ENTRIES_SQL) {
      const [userId] = params as [string];
      return this.reviews
        .filter((r) => r.user_id === userId)
        .sort((a, b) => b.id - a.id)
        .slice(0, 10)
        .map((r) => ({
          id: r.id,
          score: r.score,
          status: r.status,
          handled_by: r.handled_by,
          handled_at: r.handled_at,
          created_at: r.created_at,
        }));
    }
    throw new Error(`FakeRiskAdminDb：未识别的 SQL：${sql}`);
  }

  /** `<base>[ WHERE <cond…>] ORDER BY id DESC[ LIMIT ?]` 解释（不认识 ⇒ 抛）。 */
  private execKeyset<R extends { id: number }>(
    base: string,
    predicates: Record<string, Predicate<R>>,
    sql: string,
    params: unknown[],
    rows: R[],
  ): unknown[] {
    let rest = sql.slice(base.length);
    let limit: number | null = null;
    const bound = [...params];
    if (rest.endsWith(' LIMIT ?')) {
      limit = Number(bound.pop());
      rest = rest.slice(0, -' LIMIT ?'.length);
    }
    const ORDER = ' ORDER BY id DESC';
    if (!rest.endsWith(ORDER)) throw new Error(`FakeRiskAdminDb：排序后缀不符：${sql}`);
    rest = rest.slice(0, -ORDER.length);
    let conds: string[] = [];
    if (rest.length > 0) {
      if (!rest.startsWith(' WHERE ')) throw new Error(`FakeRiskAdminDb：WHERE 形态不符：${sql}`);
      conds = rest.slice(' WHERE '.length).split(' AND ');
    }
    if (conds.length !== bound.length) {
      throw new Error(`FakeRiskAdminDb：条件数 ${conds.length} ≠ 参数数 ${bound.length}：${sql}`);
    }
    const matched = rows.filter((row) =>
      conds.every((cond, i) => {
        const predicate = predicates[cond];
        if (!predicate) throw new Error(`FakeRiskAdminDb：不认识的条件子句：${cond}`);
        return predicate(row, bound[i]);
      }),
    );
    const sorted = [...matched].sort((a, b) => b.id - a.id);
    return (limit === null ? sorted : sorted.slice(0, limit)).map((r) => ({ ...r }));
  }
}

// ─── FakeRedis ──────────────────────────────────────────────────────────────

interface RedisCall {
  op: 'set' | 'get' | 'del' | 'mget' | 'exists';
  key: string;
  args: unknown[];
}

class FakeRedis {
  store = new Map<string, string>();
  calls: RedisCall[] = [];
  /** true ⇒ `get` 恒抛（R11 fail-open / unthrottle 校验读取的取证面）。 */
  failGet = false;
  /** true ⇒ `mget` 恒抛（hits fail-open 的取证面）。 */
  failMget = false;
  /** true ⇒ `set` 恒抛（波 2 F2：后置旗写失败 ⇒ warn + 不回滚的取证面）。 */
  failSet = false;
  /** true ⇒ `exists` 恒抛（终审 F2：bannedFlagPresent 展示位 fail-open 的取证面）。 */
  failExists = false;

  /** 跨对象 call-order 观测（可选共享数组；与 FakeRiskAdminDb 同一条）。 */
  constructor(private readonly sharedLog: string[] = []) {}

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    this.calls.push({ op: 'set', key, args: [value, ...args] });
    this.sharedLog.push(`redis:set:${key}`);
    if (this.failSet) throw new Error('redis down（仿真：set 失败）');
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.calls.push({ op: 'get', key, args: [] });
    this.sharedLog.push(`redis:get:${key}`);
    if (this.failGet) throw new Error('redis down（仿真）');
    return this.store.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    this.calls.push({ op: 'del', key, args: [] });
    this.sharedLog.push(`redis:del:${key}`);
    return this.store.delete(key) ? 1 : 0;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    this.calls.push({ op: 'mget', key: keys.join(','), args: keys });
    this.sharedLog.push(`redis:mget:${keys.join(',')}`);
    if (this.failMget) throw new Error('redis down（仿真）');
    return keys.map((k) => this.store.get(k) ?? null);
  }

  async exists(key: string): Promise<number> {
    this.calls.push({ op: 'exists', key, args: [] });
    this.sharedLog.push(`redis:exists:${key}`);
    if (this.failExists) throw new Error('redis down（仿真）');
    return this.store.has(key) ? 1 : 0;
  }

  count(op: RedisCall['op'], key: string): number {
    return this.calls.filter((c) => c.op === op && c.key === key).length;
  }

  reset(): void {
    this.store = new Map();
    this.calls = [];
    this.failGet = false;
    this.failMget = false;
    this.failSet = false;
    this.failExists = false;
  }
}

// ─── 配置替身 / 指标读数 ────────────────────────────────────────────────────

function makeConfig(windowDays = 30): ConfigCacheService {
  return {
    riskAutoThrottle: vi.fn(() => true),
    riskDeviceWindowDays: vi.fn(() => windowDays),
  } as unknown as ConfigCacheService;
}

/** 读一条带标签指标（例：`risk_actions_total{action="dismiss"}`；缺系列 ⇒ 0）。 */
async function labeledMetric(name: string, labels: string): Promise<number> {
  const text = await metricsRegistry().metrics();
  const m = new RegExp(`^${name}${labels} ([\\d.eE+]+)$`, 'm').exec(text);
  return m ? Number(m[1]) : 0;
}

const NOW_MS = T0;

// ════════════════════════════════════════════════════════════════════════════
// A. ReviewsService.applyAdminAction（五动作 × 迁移 × 审计同事务 + 1213 重试）
// ════════════════════════════════════════════════════════════════════════════

describe('风控片 T6：管理端点（C19）', () => {
  let captured: ReturnType<typeof createCapturingSink>;

  beforeEach(() => {
    captured = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'user-service' }));
  });

  afterEach(() => {
    Logger.overrideLogger(new Logger());
  });

  describe('A. 管理动作事务（⚙️19 × §2.13 × 1213 遗留裁决）', () => {
    let db: FakeRiskAdminDb;
    let redis: FakeRedis;

    const mkSvc = () =>
      new ReviewsService(db.dataSource as never, redis as never, makeConfig());

    /** 该动作对 reviews 行的写入语句（除锁定读）。 */
    const reviewWrites = () => db.queries.filter((q) => q.sql === RISK_ADMIN_REVIEW_TRANSITION_SQL);

    beforeEach(() => {
      db = new FakeRiskAdminDb();
      redis = new FakeRedis();
    });

    it('SQL 常量全文 == T6 契约逐字（迁移两条语句被单测钉）', () => {
      expect(RISK_ADMIN_REVIEW_TRANSITION_SQL).toBe(SPEC_ADMIN_TRANSITION_SQL);
      expect(RISK_USER_STATUS_UPDATE_SQL).toBe(SPEC_USER_STATUS_UPDATE_SQL);
    });

    it('SQL 常量全文 == 规格逐字：跑得快详情 stats（mode/is_robot/user 三子句）', () => {
      expect(RISK_STATS_PDK_SQL).toBe(SPEC_RISK_STATS_PDK_SQL);
    });

    // ── dismiss ────────────────────────────────────────────────────────

    it('dismiss：open ⇒ dismissed（handled_by=actor/handled_at=now）+ 审计同事务；旗零操作', async () => {
      const row = db.addReview({ id: 7, status: 'open', score: 25 });

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'dismiss',
        actor: 'tester',
        reason: '误报，人工排除',
        reviewId: 7,
        now: NOW_MS,
      });

      expect(db.transactions).toBe(1);
      expect(db.queries[0]).toEqual({ sql: RISK_UPSERT_LOCK_SQL, params: ['u-A'] }); // 锁定读在首
      expect(row.status).toBe('dismissed');
      expect(row.handled_by).toBe('tester');
      expect(row.handled_at).toEqual(new Date(NOW_MS));
      expect(db.actionsOf('u-A')).toEqual([
        {
          user_id: 'u-A',
          action: 'dismiss',
          actor: 'tester',
          reason: '误报，人工排除',
          review_id: 7,
        },
      ]);
      expect(redis.calls.filter((c) => c.key.startsWith('risk:'))).toHaveLength(0);
    });

    it('dismiss 源态非法（dismissed 行）⇒ 409 文案「当前状态不允许该动作」；零写零审计', async () => {
      db.addReview({ id: 3, status: 'dismissed', handled_by: 'admin-a' });

      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'dismiss',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      await expect(p).rejects.toBeInstanceOf(RiskConflictError);
      await expect(p).rejects.toThrowError(new RegExp(`^${CONFLICT_PREFIX}.*dismiss`));
      expect(db.queries).toEqual([{ sql: RISK_UPSERT_LOCK_SQL, params: ['u-A'] }]); // 只有锁定读
      expect(db.actions).toHaveLength(0);
    });

    it('dismiss 无条目 ⇒ 409（无行也走同一冲突面）；零写', async () => {
      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'dismiss',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      await expect(p).rejects.toBeInstanceOf(RiskConflictError);
      expect(db.actions).toHaveLength(0);
    });

    // ── throttle ───────────────────────────────────────────────────────

    it('throttle：open ⇒ throttled + 审计 + 旗 manual（JSON {source:manual,at}，**无 TTL**）', async () => {
      const row = db.addReview({ id: 5, status: 'open' });

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'throttle',
        actor: 'tester',
        reason: '疑似代打',
        now: NOW_MS,
      });

      expect(row.status).toBe('throttled');
      expect(row.handled_by).toBe('tester');
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'throttle', actor: 'tester', reason: '疑似代打', review_id: 5 },
      ]);
      const set = redis.calls.find((c) => c.op === 'set' && c.key === riskLimitKey('u-A'));
      // ⚠️ args 恰一项：manual = **无 TTL**（带上 EX 即红）。
      expect(set?.args).toEqual([JSON.stringify({ source: 'manual', at: NOW_MS })]);
    });

    it('throttle 源态非法（非 open）⇒ 409；旗零操作（负对照：不许先置旗）', async () => {
      db.addReview({ id: 5, status: 'throttled', handled_by: 'admin-a' });

      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'throttle',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      await expect(p).rejects.toBeInstanceOf(RiskConflictError);
      expect(redis.calls).toHaveLength(0);
      expect(db.actions).toHaveLength(0);
    });

    // ── unthrottle（按旗校验——F6 孤儿旗）───────────────────────────────

    it('unthrottle：旗在 + 条目 throttled ⇒ 删旗 + 审计 + 条目**顺带**迁 dismissed', async () => {
      const row = db.addReview({ id: 9, status: 'throttled', handled_by: 'admin-a' });
      redis.store.set(riskLimitKey('u-A'), JSON.stringify({ source: 'manual', at: T0 - 1000 }));

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'unthrottle',
        actor: 'tester',
        reason: '复核解除',
        now: NOW_MS,
      });

      expect(row.status).toBe('dismissed');
      expect(row.handled_by).toBe('tester');
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'unthrottle', actor: 'tester', reason: '复核解除', review_id: 9 },
      ]);
      expect(redis.count('del', riskLimitKey('u-A'))).toBe(1);
      expect(redis.store.has(riskLimitKey('u-A'))).toBe(false);
    });

    it('unthrottle：旗在 + 条目 dismissed（孤儿旗）⇒ **仅删旗** + 审计（条目零写入）', async () => {
      db.addReview({ id: 9, status: 'dismissed', handled_by: 'admin-a' });
      redis.store.set(riskLimitKey('u-A'), JSON.stringify({ source: 'auto', at: T0 - 1000 }));

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'unthrottle',
        actor: 'tester',
        reason: 'recover',
        now: NOW_MS,
      });

      expect(reviewWrites()).toHaveLength(0); // 条目不动（「不看条目」的实体面）
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'unthrottle', actor: 'tester', reason: 'recover', review_id: 9 },
      ]);
      expect(redis.store.has(riskLimitKey('u-A'))).toBe(false);
    });

    it('unthrottle：旗在 + **无条目** ⇒ 仅删旗 + 审计 review_id=null', async () => {
      redis.store.set(riskLimitKey('u-A'), JSON.stringify({ source: 'auto', at: T0 - 1000 }));

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'unthrottle',
        actor: 'tester',
        reason: 'recover',
        now: NOW_MS,
      });

      expect(reviewWrites()).toHaveLength(0);
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'unthrottle', actor: 'tester', reason: 'recover', review_id: null },
      ]);
      expect(redis.count('del', riskLimitKey('u-A'))).toBe(1);
    });

    it('unthrottle：旗不在 ⇒ 409（源态**按旗不看条目**——条目为 throttled 也不放行）；零写零 DEL', async () => {
      // 🔴 判别力承重面：条目 = throttled（最诱人的错解「按条目允许」会在这里放行 ⇒ 本用例红）。
      db.addReview({ id: 9, status: 'throttled', handled_by: 'system' });

      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'unthrottle',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      await expect(p).rejects.toBeInstanceOf(RiskConflictError);
      expect(redis.count('del', riskLimitKey('u-A'))).toBe(0);
      expect(reviewWrites()).toHaveLength(0);
      expect(db.actions).toHaveLength(0);
    });

    // ── ban / unban ────────────────────────────────────────────────────

    it('ban：users.status=banned + 最新条目（任意态）⇒ banned + 旗 EX 7776000 + 审计', async () => {
      db.users.set('u-A', 'active');
      const row = db.addReview({ id: 4, status: 'dismissed', handled_by: 'admin-a' });

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: '确认作弊',
        now: NOW_MS,
      });

      expect(db.users.get('u-A')).toBe('banned');
      expect(row.status).toBe('banned');
      expect(row.handled_by).toBe('tester');
      const flagSet = redis.calls.find((c) => c.op === 'set' && c.key === riskBannedKey('u-A'));
      expect(flagSet?.args).toEqual(['1', 'EX', RISK_BANNED_FLAG_TTL_SECONDS]);
      expect(RISK_BANNED_FLAG_TTL_SECONDS).toBe(7_776_000);
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'ban', actor: 'tester', reason: '确认作弊', review_id: 4 },
      ]);
    });

    it('ban：无条目亦可执行（仅 users.status + 旗 + 审计 review_id=null；行表零变化）', async () => {
      db.users.set('u-A', 'active');

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      expect(db.users.get('u-A')).toBe('banned');
      expect(reviewWrites()).toHaveLength(0);
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'ban', actor: 'tester', reason: 'r', review_id: null },
      ]);
      expect(redis.count('set', riskBannedKey('u-A'))).toBe(1);
    });

    it('ban：已在封禁状态 ⇒ 409（文案指引 unban）；用户未写、旗零操作、零审计', async () => {
      db.users.set('u-A', 'banned');

      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      await expect(p).rejects.toThrowError(new RegExp(`${CONFLICT_PREFIX}.*unban`));
      expect(db.users.get('u-A')).toBe('banned');
      expect(redis.calls).toHaveLength(0);
      expect(db.actions).toHaveLength(0);
    });

    it('ban：用户不存在 ⇒ 404 域错（11004）；零写零旗', async () => {
      const p = mkSvc().applyAdminAction({
        userId: 'ghost',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      await expect(p).rejects.toMatchObject({ code: ErrCode.USER_NOT_FOUND });
      expect(redis.calls).toHaveLength(0);
      expect(db.actions).toHaveLength(0);
    });

    it('unban：banned ⇒ users.status=active + 行 banned⇒dismissed + DEL 旗 + 审计', async () => {
      db.users.set('u-A', 'banned');
      const row = db.addReview({ id: 6, status: 'banned', handled_by: 'admin-a' });

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'unban',
        actor: 'tester',
        reason: '申诉核实后解封',
        now: NOW_MS,
      });

      expect(db.users.get('u-A')).toBe('active');
      expect(row.status).toBe('dismissed');
      expect(row.handled_by).toBe('tester');
      expect(redis.count('del', riskBannedKey('u-A'))).toBe(1);
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'unban', actor: 'tester', reason: '申诉核实后解封', review_id: 6 },
      ]);
    });

    it('unban：banned + 无条目 ⇒ status=active + 审计 review_id=null + DEL（无条目亦可解）', async () => {
      db.users.set('u-A', 'banned');

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'unban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      expect(db.users.get('u-A')).toBe('active');
      expect(reviewWrites()).toHaveLength(0);
      expect(db.actionsOf('u-A')[0]).toMatchObject({ action: 'unban', review_id: null });
      expect(redis.count('del', riskBannedKey('u-A'))).toBe(1);
    });

    it('unban：不在封禁状态 ⇒ 409；**DEL 零调用**（负对照：不许乱删旗）', async () => {
      db.users.set('u-A', 'active');

      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'unban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      await expect(p).rejects.toBeInstanceOf(RiskConflictError);
      expect(redis.count('del', riskBannedKey('u-A'))).toBe(0);
      expect(db.actions).toHaveLength(0);
    });

    // ── 波 2 F2：旗写后置（COMMIT 之后）+ unban 清孤儿旗 ──────────────────

    it('F2：旗写在事务 COMMIT 之后（call-order 断言：tx:end 先于 redis:set）', async () => {
      const log: string[] = [];
      const db2 = new FakeRiskAdminDb(log);
      const redis2 = new FakeRedis(log);
      db2.users.set('u-A', 'active');
      const svc = new ReviewsService(db2.dataSource as never, redis2 as never, makeConfig());

      await svc.applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      expect(log).toEqual(['tx:begin', 'tx:end', `redis:set:${riskBannedKey('u-A')}`]);
    });

    it('F2：旗写失败（Redis set 抛）⇒ ban 仍 ok（DB 已定局）+ warn 一行（不回滚/不翻错）', async () => {
      db.users.set('u-A', 'active');
      db.addReview({ id: 4, status: 'open' });
      redis.failSet = true;

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      expect(db.users.get('u-A')).toBe('banned'); // 事务已提交、不回滚
      expect(db.actionsOf('u-A')).toHaveLength(1);
      const warns = captured.records.filter((r) => r.level === 'warn');
      expect(warns.some((r) => r.msg.includes('risk ban flag set failed'))).toBe(true);
    });

    it('F2：unban 源态放宽——status 已 active 但旗在（崩溃遗留孤儿旗）⇒ 200：删旗 + 审计（detail 注明）', async () => {
      db.users.set('u-A', 'active'); // 崩溃遗留：DB 已回 active……
      const row = db.addReview({ id: 6, status: 'banned', handled_by: 'admin-a' });
      redis.store.set(riskBannedKey('u-A'), '1'); // ……但旗没删掉

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'unban',
        actor: 'tester',
        reason: '清理孤儿旗',
        now: NOW_MS,
      });

      expect(db.users.get('u-A')).toBe('active'); // 未再写用户状态（本就是 active）
      expect(row.status).toBe('dismissed'); // 条目为 banned ⇒ 顺带迁
      expect(redis.count('del', riskBannedKey('u-A'))).toBe(1);
      expect(redis.store.has(riskBannedKey('u-A'))).toBe(false);
      const audit = db.actions.find((a) => a.user_id === 'u-A')!;
      expect(audit.action).toBe('unban');
      expect(audit.detail).toEqual(JSON.stringify({ orphanFlagCleanup: true }));
    });

    // ── reviewId（可选）＝陈旧提交断言（F6：**仅条目态动作** dismiss|throttle|unthrottle）──

    it('reviewId 与锁读的最新条目不符 ⇒ 409（条目已变化）；零写', async () => {
      db.addReview({ id: 7, status: 'open' });

      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'dismiss',
        actor: 'tester',
        reason: 'r',
        reviewId: 6, // 陈旧
        now: NOW_MS,
      });

      await expect(p).rejects.toThrowError(/条目已变化/);
      expect(reviewWrites()).toHaveLength(0);
      expect(db.actions).toHaveLength(0);
    });

    it('reviewId 提供但无任何条目 ⇒ 409（条目态动作）；零写', async () => {
      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'dismiss',
        actor: 'tester',
        reason: 'r',
        reviewId: 3,
        now: NOW_MS,
      });

      await expect(p).rejects.toBeInstanceOf(RiskConflictError);
      expect(db.actions).toHaveLength(0);
    });

    it('F6：ban **不消费** reviewId——陈旧 reviewId（扫描在 GET→POST 间涨分复活的新行）⇒ 200（不得 409）', async () => {
      db.users.set('u-A', 'active');
      db.addReview({ id: 7, status: 'open' }); // 提交者看到的条目
      const revived = db.addReview({ id: 8, status: 'open' }); // GET 之后扫描涨分复活出的新行

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: '确认作弊',
        reviewId: 7, // 陈旧——但 ban 的源态是 users.status，不误伤
        now: NOW_MS,
      });

      expect(db.users.get('u-A')).toBe('banned');
      expect(revived.status).toBe('banned'); // 迁的是锁定读最新行（8）
      expect(db.reviews.find((r) => r.id === 7)!.status).toBe('open'); // 旧行不动
      expect(db.actionsOf('u-A')).toEqual([
        { user_id: 'u-A', action: 'ban', actor: 'tester', reason: '确认作弊', review_id: 8 },
      ]);
    });

    it('F6：ban + reviewId + 用户不存在 ⇒ 404（存在性先于其余校验，不再被陈旧断言抢成 409）', async () => {
      const p = mkSvc().applyAdminAction({
        userId: 'ghost',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        reviewId: 999,
        now: NOW_MS,
      });

      await expect(p).rejects.toMatchObject({ code: ErrCode.USER_NOT_FOUND });
      expect(db.actions).toHaveLength(0);
      expect(redis.calls).toHaveLength(0);
    });

    // ── 同事务回滚 / 旗顺序纪律 ────────────────────────────────────────

    it('审计与状态变更**同事务**：审计 INSERT 炸 ⇒ 状态/用户/旗全部回滚（旗在最后一步才碰）', async () => {
      db.users.set('u-A', 'active');
      db.addReview({ id: 4, status: 'open' });
      db.failActionInsertOnce = new Error('audit insert boom（仿真）');

      await expect(
        mkSvc().applyAdminAction({
          userId: 'u-A',
          action: 'ban',
          actor: 'tester',
          reason: 'r',
          now: NOW_MS,
        }),
      ).rejects.toThrowError(/audit insert boom/);

      expect(db.users.get('u-A')).toBe('active'); // 用户状态回滚
      // ⚠️ 经 db.reviews 读（回滚 = 快照替换；用例早前持有的行引用是回滚前的对象，会看旧值）。
      expect(db.reviews.find((r) => r.id === 4)!.status).toBe('open'); // 条目状态回滚
      expect(db.actions).toHaveLength(0);
      expect(redis.calls.filter((c) => c.key === riskBannedKey('u-A'))).toHaveLength(0); // 旗未写
    });

    // ── 1213（T5 遗留裁决第 0 条）：重试一次；再失败 ⇒ 409「并发冲突，请重试」──

    it('1213 重试一次：首事务死锁、重试成功 ⇒ 单条审计行（不重复写）、指标恰 +1', async () => {
      db.users.set('u-A', 'active');
      db.addReview({ id: 4, status: 'open' });
      db.failActionInsertOnce = FakeRiskAdminDb.deadlockErr();
      const before = await labeledMetric('risk_actions_total', '{action="ban"}');

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      expect(db.transactions).toBe(2); // 恰一次重试
      expect(db.actionsOf('u-A')).toHaveLength(1); // 不重复写
      expect(db.users.get('u-A')).toBe('banned');
      expect(await labeledMetric('risk_actions_total', '{action="ban"}')).toBe(before + 1);
      expect(redis.count('set', riskBannedKey('u-A'))).toBe(1);
    });

    it('1213 重试再失败 ⇒ 409「并发冲突，请重试」（RiskConflictError）；零审计、指标不增', async () => {
      db.users.set('u-A', 'active');
      db.failActionInsertAlways = FakeRiskAdminDb.deadlockErr();
      const before = await labeledMetric('risk_actions_total', '{action="ban"}');

      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      await expect(p).rejects.toBeInstanceOf(RiskConflictError);
      await expect(p).rejects.toThrowError(CONCURRENCY_MESSAGE);
      expect(db.transactions).toBe(2); // 重试恰一次，不无限循环
      expect(db.actions).toHaveLength(0);
      expect(await labeledMetric('risk_actions_total', '{action="ban"}')).toBe(before);
    });

    it('非 1213 的事务错误**不重试**（transactions 恰 1；原错误上抛）', async () => {
      db.users.set('u-A', 'active');
      db.failActionInsertOnce = new Error('boom-other（仿真）');

      const p = mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      await expect(p).rejects.toThrowError(/boom-other/);
      expect(db.transactions).toBe(1);
    });

    it('1213 的 TypeORM 包裹形态（driverError.errno）同样触发重试', async () => {
      db.users.set('u-A', 'active');
      const wrapped = new Error('QueryFailedError（仿真）');
      (wrapped as unknown as { driverError: unknown }).driverError = FakeRiskAdminDb.deadlockErr();
      db.failActionInsertOnce = wrapped;

      await mkSvc().applyAdminAction({
        userId: 'u-A',
        action: 'ban',
        actor: 'tester',
        reason: 'r',
        now: NOW_MS,
      });

      expect(db.transactions).toBe(2);
      expect(db.actionsOf('u-A')).toHaveLength(1);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. HTTP 探针（真 Nest 管线：控制器 + 真服务 + 假库）
// ════════════════════════════════════════════════════════════════════════════

@Module({})
class RiskProbeModule {
  static wiring(db: FakeRiskAdminDb, redis: FakeRedis): DynamicModule {
    const reviews = new ReviewsService(db.dataSource as unknown as DataSource, redis as never, makeConfig());
    // 设备绑定片：真 DeviceBindingsService（假库解释其全部 SQL + 假 Redis 承接写透/DEL）。
    const deviceBindings = new DeviceBindingsService(
      db.dataSource as unknown as DataSource,
      redis as never,
    );
    const adminRisk = new AdminRiskService(
      db.dataSource as unknown as DataSource,
      redis as never,
      makeConfig(),
      deviceBindings,
    );
    return {
      module: RiskProbeModule,
      controllers: [AdminRiskController],
      providers: [
        { provide: ReviewsService, useValue: reviews },
        { provide: AdminRiskService, useValue: adminRisk },
        { provide: DeviceBindingsService, useValue: deviceBindings },
      ],
    };
  }
}

interface RawResult {
  status: number;
  headers: Headers;
  text: string;
  buffer: Buffer;
  json: any;
}

interface Probe {
  get: (path: string, headers?: Record<string, string>) => Promise<RawResult>;
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<RawResult>;
  del: (path: string, headers?: Record<string, string>) => Promise<RawResult>;
}

describe('风控片 T6：HTTP 面（真 Nest 管线 + 假库；§2.8 / §2.13 / CSV 契约）', () => {
  let db: FakeRiskAdminDb;
  let redis: FakeRedis;
  let app: INestApplication;
  let probe: Probe;
  let captured: ReturnType<typeof createCapturingSink>;

  beforeEach(() => {
    captured = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'user-service' }));
  });

  afterEach(() => {
    Logger.overrideLogger(new Logger());
  });

  beforeAll(async () => {
    db = new FakeRiskAdminDb();
    redis = new FakeRedis();
    app = await NestFactory.create(RiskProbeModule.wiring(db, redis), { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    // 逐字同 `src/main.ts`（差异面 = internal-token 中间件 + TCP 微服务 —— 那是每跳
    // 服务间边界，有独立栈级判据；本夹具只覆盖 `/api/admin/risk/*` 控制器面）。
    const origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const fetchIt = async (path: string, init: RequestInit): Promise<RawResult> => {
      const res = await fetch(`${origin}${path}`, init);
      const buffer = Buffer.from(await res.arrayBuffer());
      const text = buffer.toString('utf-8');
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, text, buffer, json };
    };
    probe = {
      get: (path, headers = {}) => fetchIt(path, { headers }),
      post: (path, body, headers = {}) =>
        fetchIt(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      del: (path, headers = {}) => fetchIt(path, { method: 'DELETE', headers }),
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // 应用只装配一次；用例间隔离 = 假库/假 Redis 重置（服务持有同一引用）。
    db.reset();
    redis.reset();
  });

  it('guard 读面 fail-closed：缺 X-Admin ⇒ 401/10002，且碰不到 handler（零查询）', async () => {
    const res = await probe.get('/api/admin/risk/reviews');
    expect(res.status).toBe(401);
    expect(res.json).toEqual({
      code: ErrCode.UNAUTHENTICATED,
      message: 'admin header required',
      data: null,
    });
    expect(db.queries).toHaveLength(0);
  });

  it('POST 写面 actor fail-closed：缺/非法 X-Admin-Actor ⇒ 401「管理身份缺失」；零事务', async () => {
    const body = { userId: 'u-A', action: 'dismiss', reason: 'r' };
    // 缺 X-Admin ⇒ 401（既有语义）
    const noAdmin = await probe.post('/api/admin/risk/actions', body);
    expect(noAdmin.status).toBe(401);
    expect(noAdmin.json.message).toBe('admin header required');
    // 缺 actor
    const noActor = await probe.post('/api/admin/risk/actions', body, { [ADMIN_HEADER]: '1' });
    expect(noActor.status).toBe(401);
    expect(noActor.json).toEqual({
      code: ErrCode.UNAUTHENTICATED,
      message: '管理身份缺失',
      data: null,
    });
    // 非法 actor（正则拒：长度/大小写/字符集/首字符）
    for (const actor of ['', 'ab', 'Admin', 'admin!', '.admin', 'a'.repeat(33)]) {
      const res = await probe.post('/api/admin/risk/actions', body, {
        [ADMIN_HEADER]: '1',
        [ADMIN_ACTOR_HEADER]: actor,
      });
      expect(res.status, `actor=${JSON.stringify(actor)} 必须 401`).toBe(401);
      expect(res.json.code).toBe(ErrCode.UNAUTHENTICATED);
    }
    // 读端点**不强求** actor：带 X-Admin 即可 200（不回归）
    const read = await probe.get('/api/admin/risk/reviews', { [ADMIN_HEADER]: '1' });
    expect(read.status).toBe(200);
    expect(db.transactions).toBe(0); // 写面全被拦——一次事务都没开
  });

  it('POST 参数校验（400 借 10001，校验先于任何 IO）：action 5 值白名单 / reason / userId / reviewId', async () => {
    const bad = async (body: unknown) => {
      const res = await probe.post('/api/admin/risk/actions', body, AUTH_WRITE);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.code).toBe(ErrCode.BAD_PARAM);
    };
    // 管理面合法集 = 5 值：系统专用动作提交 ⇒ 400
    await bad({ userId: 'u-A', action: 'auto_throttle', reason: 'r' });
    await bad({ userId: 'u-A', action: 'reopen', reason: 'r' });
    await bad({ userId: 'u-A', action: 'nope', reason: 'r' });
    await bad({ userId: 'u-A', reason: 'r' });
    // reason 必填 1..200
    await bad({ userId: 'u-A', action: 'dismiss' });
    await bad({ userId: 'u-A', action: 'dismiss', reason: '' });
    await bad({ userId: 'u-A', action: 'dismiss', reason: 'r'.repeat(201) });
    await bad({ userId: 'u-A', action: 'dismiss', reason: 5 });
    // userId 1..36
    await bad({ action: 'dismiss', reason: 'r' });
    await bad({ userId: 'a'.repeat(37), action: 'dismiss', reason: 'r' });
    // reviewId 正整数（提供时）
    await bad({ userId: 'u-A', action: 'dismiss', reason: 'r', reviewId: 0 });
    await bad({ userId: 'u-A', action: 'dismiss', reason: 'r', reviewId: '5' });
    await bad({ userId: 'u-A', action: 'dismiss', reason: 'r', reviewId: 1.5 });
    expect(db.transactions).toBe(0); // 全部被参数闸拦下
  });

  it('POST 成功：actor 取自 X-Admin-Actor，响应 {code:0, data:{ok:true}}，审计行落地', async () => {
    db.addReview({ id: 7, status: 'open' });

    const res = await probe.post(
      '/api/admin/risk/actions',
      { userId: 'u-A', action: 'dismiss', reviewId: 7, reason: '复核排除' },
      AUTH_WRITE,
    );

    expect(res.status).toBe(200); // @HttpCode(200)（管理页按 200 分流）
    expect(res.json).toEqual({ code: ErrCode.OK, data: { ok: true } });
    expect(db.actionsOf('u-A')).toEqual([
      { user_id: 'u-A', action: 'dismiss', actor: 'tester', reason: '复核排除', review_id: 7 },
    ]);
  });

  it('POST 非法源态 ⇒ 409 借 10001「当前状态不允许该动作」；ban 幽灵用户 ⇒ 404 借 11004', async () => {
    const conflict = await probe.post(
      '/api/admin/risk/actions',
      { userId: 'u-A', action: 'dismiss', reason: 'r' },
      AUTH_WRITE,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json).toEqual({
      code: ErrCode.BAD_PARAM,
      message: `${CONFLICT_PREFIX}（dismiss 仅适用于 open 条目）`,
      data: null,
    });

    const notFound = await probe.post(
      '/api/admin/risk/actions',
      { userId: 'ghost', action: 'ban', reason: 'r' },
      AUTH_WRITE,
    );
    expect(notFound.status).toBe(404);
    expect(notFound.json).toEqual({ code: ErrCode.USER_NOT_FOUND, message: '未找到该用户', data: null });

    expect(db.actions).toHaveLength(0);
  });

  it('GET reviews：形状逐字 + status 过滤 + keyset（cursor/limit 上限 100）+ nextCursor 恰满页', async () => {
    db.addReview({ id: 1, status: 'open', user_id: 'u-1' });
    db.addReview({ id: 2, status: 'dismissed', user_id: 'u-2', handled_by: 'admin-a', handled_at: new Date(T0 - 60_000) });
    db.addReview({ id: 3, status: 'open', user_id: 'u-3' });

    const all = await probe.get('/api/admin/risk/reviews', AUTH_READ);
    expect(all.status).toBe(200);
    expect(all.json.code).toBe(ErrCode.OK);
    expect(all.json.data.nextCursor).toBeNull(); // 3 行 < 默认 50
    expect(all.json.data.items).toHaveLength(3);
    // 形状逐字（id DESC；epoch ms；handledBy/handledAt 可 null）
    expect(all.json.data.items[0]).toEqual({
      id: 3,
      userId: 'u-3',
      score: 25,
      reasons: [{ check: 'winRate', detail: { games: 101, wins: 90 } }],
      status: 'open',
      createdAt: T0 - 3_600_000,
      updatedAt: T0 - 3_600_000,
      handledBy: null,
      handledAt: null,
    });
    expect(all.json.data.items[1].handledBy).toBe('admin-a');
    expect(all.json.data.items[1].handledAt).toBe(T0 - 60_000);

    // status 过滤
    const open = await probe.get('/api/admin/risk/reviews?status=open', AUTH_READ);
    expect(open.json.data.items.map((x: { id: number }) => x.id)).toEqual([3, 1]);

    // keyset：cursor=3 ⇒ id<3；恰满页给 nextCursor（无预查）
    const page = await probe.get('/api/admin/risk/reviews?limit=2', AUTH_READ);
    expect(page.json.data.items.map((x: { id: number }) => x.id)).toEqual([3, 2]);
    expect(page.json.data.nextCursor).toBe(2);
    const page2 = await probe.get('/api/admin/risk/reviews?limit=2&cursor=2', AUTH_READ);
    expect(page2.json.data.items.map((x: { id: number }) => x.id)).toEqual([1]);
    expect(page2.json.data.nextCursor).toBeNull();

    // 白名单与上限
    const unknown = await probe.get('/api/admin/risk/reviews?foo=1', AUTH_READ);
    expect(unknown.status).toBe(400);
    expect(unknown.json.message).toBe('未知查询参数：foo');
    const tooBig = await probe.get('/api/admin/risk/reviews?limit=101', AUTH_READ);
    expect(tooBig.status).toBe(400);
    const zeroCursor = await probe.get('/api/admin/risk/reviews?cursor=0', AUTH_READ);
    expect(zeroCursor.status).toBe(400);
  });

  it('GET users/:userId：404 借 11004；userId 长度闸先于 IO', async () => {
    const missing = await probe.get('/api/admin/risk/users/ghost', AUTH_READ);
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ code: ErrCode.USER_NOT_FOUND, message: '未找到该用户', data: null });

    const before = db.queries.length;
    const tooLong = await probe.get(`/api/admin/risk/users/${'a'.repeat(37)}`, AUTH_READ);
    expect(tooLong.status).toBe(400);
    expect(tooLong.json.code).toBe(ErrCode.BAD_PARAM);
    expect(db.queries.length).toBe(before); // 零查询
  });

  it('GET users/:userId：详情形状逐字（stats/devices+others≤20/entries≤10/hits/accountStatus/limitSource）', async () => {
    db.users.set('u-A', 'active');
    db.winStats.set('u-A', { games: 12, wins: 9 });
    // 设备：三台 —— 一台在窗口外（仅进原文、不进 deviceCount）
    db.devices.push({
      user_id: 'u-A',
      device_id: 'dev-old',
      first_seen_at: new Date(T0 - 100 * DAY_MS),
      last_seen_at: new Date(T0 - 40 * DAY_MS),
    });
    db.devices.push({
      user_id: 'u-A',
      device_id: 'dev-1',
      first_seen_at: new Date(T0 - 10 * DAY_MS),
      last_seen_at: new Date(T0 - 1 * DAY_MS),
    });
    db.devices.push({
      user_id: 'u-A',
      device_id: 'dev-2',
      first_seen_at: new Date(T0 - 5 * DAY_MS),
      last_seen_at: new Date(T0 - 2 * DAY_MS),
    });
    // dev-1 的关联账号：25 个 ⇒ others 截断 20；其一已封禁
    db.users.set('other-0', 'banned');
    for (let i = 0; i < 25; i += 1) {
      const id = `other-${i}`;
      if (!db.users.has(id)) db.users.set(id, 'active');
      db.devices.push({
        user_id: id,
        device_id: 'dev-1',
        first_seen_at: new Date(T0 - 86_400_000),
        last_seen_at: new Date(T0 - 3_600_000),
      });
    }
    // 条目 12 条 ⇒ entries 截断 10
    for (let i = 1; i <= 12; i += 1) {
      db.addReview({ id: i, user_id: 'u-A', status: i === 12 ? 'throttled' : 'dismissed' });
    }
    redis.store.set('risk:hit:u-A:sameIp', '7');
    redis.store.set('risk:hit:u-A:sameDevice', '3');
    redis.store.set(riskLimitKey('u-A'), JSON.stringify({ source: 'auto', at: T0 - 1000 }));

    const res = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);

    expect(res.status).toBe(200);
    const data = res.json.data;
    expect(data.userId).toBe('u-A');
    expect(data.accountStatus).toBe('active');
    expect(data.limitSource).toBe('auto');
    expect(data.stats).toEqual({
      games: 12,
      wins: 9,
      winRate: 9 / 12,
      deviceCount: 2, // 窗口内 2 台
      byGame: {
        doudizhu: { games: 12, wins: 9, winRate: 9 / 12 },
        paodekuai: { games: 0, wins: 0, winRate: 0 },
      },
    });
    expect(data.devices).toHaveLength(3); // 原文 3 台（含窗口外）
    const d1 = data.devices.find((d: { deviceId: string }) => d.deviceId === 'dev-1');
    expect(d1.firstSeenAt).toBe(T0 - 10 * DAY_MS);
    expect(d1.lastSeenAt).toBe(T0 - 1 * DAY_MS);
    expect(d1.others).toHaveLength(20); // ≤20
    expect(d1.others[0]).toEqual({ userId: 'other-0', accountStatus: 'banned' });
    expect(data.devices.find((d: { deviceId: string }) => d.deviceId === 'dev-old').others).toEqual([]);
    expect(data.entries).toHaveLength(10); // 最近 10 条
    expect(data.entries[0]).toEqual({
      id: 12,
      score: 25,
      status: 'throttled',
      handledBy: null,
      handledAt: null,
      createdAt: T0 - 3_600_000,
    });
    expect(data.hits).toEqual({ sameIp: 7, sameDevice: 3 });
    expect(data.binding).toBeNull(); // 设备绑定片：无绑定行 ⇒ null（与 devices 历史链分离）
  });

  it('GET users/:userId：stats 顶层 = 两玩法合计，byGame 分玩法；查询顺序 ddz → pdk → device', async () => {
    db.users.set('u-A', 'active');
    db.winStats.set('u-A', { games: 12, wins: 9 });
    db.pdkWinStats.set('u-A', { games: 5, wins: 4 });

    const res = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);

    expect(res.status).toBe(200);
    expect(res.json.data.stats).toEqual({
      games: 17,
      wins: 13,
      winRate: 13 / 17,
      deviceCount: 0,
      byGame: {
        doudizhu: { games: 12, wins: 9, winRate: 9 / 12 },
        paodekuai: { games: 5, wins: 4, winRate: 4 / 5 },
      },
    });
    const sqls = db.queries.map((q) => q.sql);
    const iDdz = sqls.indexOf(RISK_STATS_SQL);
    const iPdk = sqls.indexOf(SPEC_RISK_STATS_PDK_SQL);
    const iDev = sqls.indexOf(RISK_DEVICE_COUNT_WINDOW_SQL);
    expect(iDdz).toBeGreaterThanOrEqual(0);
    expect(iPdk).toBeGreaterThan(iDdz);
    expect(iDev).toBeGreaterThan(iPdk);
  });

  it('GET users/:userId：limitSource 三态（manual / null）；旗读失败 ⇒ 按无旗（null）+ error 日志', async () => {
    db.users.set('u-A', 'active');

    const none = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);
    expect(none.json.data.limitSource).toBeNull();

    redis.store.set(riskLimitKey('u-A'), JSON.stringify({ source: 'manual', at: T0 }));
    const manual = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);
    expect(manual.json.data.limitSource).toBe('manual');

    redis.failGet = true;
    const failOpen = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);
    expect(failOpen.status).toBe(200);
    expect(failOpen.json.data.limitSource).toBeNull(); // R11：按无旗（不 500）
    const errors = captured.records.filter((r) => r.level === 'error');
    expect(errors.some((r) => r.msg.includes('risk limit flag read failed'))).toBe(true);
  });

  it('GET users/:userId：hits MGET 失败 ⇒ 两键都 0（fail-open）+ error 日志；空旗 ⇒ 0', async () => {
    db.users.set('u-A', 'active');

    const empty = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);
    expect(empty.json.data.hits).toEqual({ sameIp: 0, sameDevice: 0 });

    redis.failMget = true;
    const failOpen = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);
    expect(failOpen.status).toBe(200);
    expect(failOpen.json.data.hits).toEqual({ sameIp: 0, sameDevice: 0 });
    const errors = captured.records.filter((r) => r.level === 'error');
    expect(errors.some((r) => r.msg.includes('risk hit counters read failed'))).toBe(true);
  });

  it('bannedFlagPresent（终审 F2）：旗在 ⇒ true / 无旗 ⇒ false / 旗读抛 ⇒ false + warn（不 500）', async () => {
    db.users.set('u-A', 'active');

    // ② 无旗 ⇒ false（常规态）
    const none = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);
    expect(none.status).toBe(200);
    expect(none.json.data.bannedFlagPresent).toBe(false);

    // ① 旗在 ⇒ true —— 孤儿态（status 已 active 但旗还在；管理面据此解锁 unban 重发的入口）
    redis.store.set(riskBannedKey('u-A'), '1');
    const withFlag = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);
    expect(withFlag.json.data.accountStatus).toBe('active');
    expect(withFlag.json.data.bannedFlagPresent).toBe(true);

    // ③ 旗读抛 ⇒ false + warn（展示位 fail-open，绝不 500）
    redis.failExists = true;
    const failOpen = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);
    expect(failOpen.status).toBe(200);
    expect(failOpen.json.data.bannedFlagPresent).toBe(false);
    const warns = captured.records.filter((r) => r.level === 'warn');
    expect(warns.some((r) => r.msg.includes('risk banned flag read failed'))).toBe(true);
  });

  // ─── 设备绑定片（P-r5：详情 binding 聚合 + DELETE 人工解绑）────────────────────

  it('设备绑定：详情聚合 binding —— 有行 ⇒ {deviceId,boundAt(epoch ms)}；bound_at 取绑定表不是设备链', async () => {
    db.users.set('u-A', 'active');
    db.bindings.set('u-A', { device_id: 'dev-bound-0001', bound_at: new Date(T0 - 2 * DAY_MS) });

    const res = await probe.get('/api/admin/risk/users/u-A', AUTH_READ);
    expect(res.status).toBe(200);
    expect(res.json.data.binding).toEqual({ deviceId: 'dev-bound-0001', boundAt: T0 - 2 * DAY_MS });
  });

  it('DELETE device-binding：成功 ⇒ 200{ok}；行删除 + Redis 键 DEL + device_unbind 审计（detail 含旧设备）', async () => {
    db.users.set('u-A', 'active');
    db.bindings.set('u-A', { device_id: 'dev-bound-0001', bound_at: new Date(T0 - 2 * DAY_MS) });
    redis.store.set(riskBindingKey('u-A'), 'dev-bound-0001');

    const res = await probe.del('/api/admin/risk/users/u-A/device-binding', AUTH_WRITE);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ code: ErrCode.OK, data: { ok: true } });
    expect(db.bindings.has('u-A')).toBe(false);
    expect(redis.store.has(riskBindingKey('u-A'))).toBe(false);
    expect(redis.calls.some((c) => c.op === 'del' && c.key === riskBindingKey('u-A'))).toBe(true);
    const audit = db.actionsOf('u-A');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'device_unbind',
      actor: 'tester',
      reason: null,
      review_id: null,
    });
    // detail 是 JSON 字符串（json 列）⇒ 解析后含旧设备指纹。
    const row = db.actions.find((a) => a.action === 'device_unbind')!;
    expect(JSON.parse(row.detail as string)).toEqual({ previousDeviceId: 'dev-bound-0001' });
  });

  it('DELETE device-binding：无绑定行 ⇒ 404 借 11004；零审计、零 Redis DEL（事务内先验存在）', async () => {
    db.users.set('u-A', 'active'); // 人在、没绑

    const res = await probe.del('/api/admin/risk/users/u-A/device-binding', AUTH_WRITE);
    expect(res.status).toBe(404);
    expect(res.json.code).toBe(ErrCode.USER_NOT_FOUND);
    expect(db.actionsOf('u-A')).toHaveLength(0);
    expect(redis.calls.some((c) => c.op === 'del' && c.key === riskBindingKey('u-A'))).toBe(false);
  });

  it('DELETE device-binding：写面 actor fail-closed（缺 X-Admin-Actor ⇒ 401）+ userId 长度闸先于 IO', async () => {
    const noActor = await probe.del('/api/admin/risk/users/u-A/device-binding', AUTH_READ);
    expect(noActor.status).toBe(401);
    expect(noActor.json.message).toBe('管理身份缺失');

    const before = db.queries.length;
    const tooLong = await probe.del(
      `/api/admin/risk/users/${'a'.repeat(37)}/device-binding`,
      AUTH_WRITE,
    );
    expect(tooLong.status).toBe(400);
    expect(db.queries.length).toBe(before); // 零查询
  });

  it('DELETE device-binding：审计 INSERT 失败 ⇒ 事务回滚（绑行仍在）且 post-commit 的 Redis DEL 不发', async () => {
    db.users.set('u-A', 'active');
    db.bindings.set('u-A', { device_id: 'dev-bound-0001', bound_at: new Date(T0 - 2 * DAY_MS) });
    redis.store.set(riskBindingKey('u-A'), 'dev-bound-0001');
    db.failActionInsertOnce = new Error('audit insert deadlock（仿真）');

    const res = await probe.del('/api/admin/risk/users/u-A/device-binding', AUTH_WRITE);
    expect(res.status).toBe(500); // 非 DomainError 未知错误原样上抛
    expect(db.bindings.has('u-A')).toBe(true); // 回滚：DELETE 被撤销
    expect(redis.store.has(riskBindingKey('u-A'))).toBe(true); // COMMIT 未发生 ⇒ DEL 未发
    expect(db.actionsOf('u-A')).toHaveLength(0);
  });

  it('GET actions：过滤（userId/action/actor/from/to）+ keyset；未知键 400', async () => {
    db.addAction({ id: 1, user_id: 'u-A', action: 'dismiss', actor: 'admin-a', created_at: new Date(T0 - 10_000) });
    db.addAction({ id: 2, user_id: 'u-A', action: 'ban', actor: 'tester', created_at: new Date(T0 - 5000) });
    db.addAction({ id: 3, user_id: 'u-B', action: 'ban', actor: 'tester', created_at: new Date(T0) });

    const all = await probe.get('/api/admin/risk/actions', AUTH_READ);
    expect(all.json.data.items).toHaveLength(3);
    expect(all.json.data.items[0]).toEqual({
      id: 3,
      userId: 'u-B',
      action: 'ban',
      actor: 'tester',
      reason: '示例',
      reviewId: 1,
      detail: null,
      createdAt: T0,
    });

    const filtered = await probe.get(
      `/api/admin/risk/actions?userId=u-A&action=ban&actor=tester&from=${T0 - 6000}&to=${T0}`,
      AUTH_READ,
    );
    expect(filtered.json.data.items.map((x: { id: number }) => x.id)).toEqual([2]);

    const unknown = await probe.get('/api/admin/risk/actions?status=open', AUTH_READ);
    expect(unknown.status).toBe(400);
    expect(unknown.json.message).toBe('未知查询参数：status');
  });

  it('GET actions.csv：BOM 首字节 / CRLF / 中文表头 / 消毒（=cmd 前置 ’）/ 文件名 risk-actions-<ts>.csv / 全量不分页', async () => {
    db.addAction({ id: 1, user_id: 'u-A', action: 'dismiss', actor: 'admin-a', reason: '=cmd|calc', review_id: 7 });
    db.addAction({ id: 2, user_id: 'u-B', action: 'ban', actor: 'tester', reason: '含"引号,与逗号', review_id: null });
    for (let i = 3; i <= 60; i += 1) {
      db.addAction({ id: i, user_id: `u-${i}`, action: 'unban', actor: 'tester', reason: null });
    }

    const res = await probe.get('/api/admin/risk/actions.csv', AUTH_READ);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="risk-actions-\d{8}-\d{6}\.csv"$/,
    );
    // BOM 首字节 EF BB BF
    expect([res.buffer[0], res.buffer[1], res.buffer[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe(CSV_BOM + 'ID,用户ID,动作,操作者,理由,条目ID,详情,时间');
    // 消毒：=cmd|calc 前置单引号；含引号/逗号整格双引号包裹 + 内部引号双写
    expect(res.text).toContain("1,u-A,dismiss,admin-a,'=cmd|calc,7,,");
    expect(res.text).toContain('2,u-B,ban,tester,"含""引号,与逗号",,');
    // 60 行全量出（JSON 会按 limit 截断；CSV 无分页）＝ 表头 + 60 行 + 末尾 CRLF 空串
    expect(lines).toHaveLength(62);

    // CSV 白名单 = JSON 版去 cursor/limit：带上即 400
    const withCursor = await probe.get('/api/admin/risk/actions.csv?cursor=5', AUTH_READ);
    expect(withCursor.status).toBe(400);
    expect(withCursor.json.message).toBe('未知查询参数：cursor');
    const withLimit = await probe.get('/api/admin/risk/actions.csv?limit=10', AUTH_READ);
    expect(withLimit.status).toBe(400);
  });

  it('GET actions：limit 缺省 50 / 上限 100（101 ⇒ 400）', async () => {
    for (let i = 1; i <= 51; i += 1) db.addAction({ id: i, user_id: 'u-A' });

    const dflt = await probe.get('/api/admin/risk/actions', AUTH_READ);
    expect(dflt.json.data.items).toHaveLength(50); // 缺省 50
    expect(dflt.json.data.nextCursor).toBe(2); // 恰满页 ⇒ 给 cursor

    const ok = await probe.get('/api/admin/risk/actions?limit=100', AUTH_READ);
    expect(ok.json.data.items).toHaveLength(51);

    const tooBig = await probe.get('/api/admin/risk/actions?limit=101', AUTH_READ);
    expect(tooBig.status).toBe(400);
  });
});

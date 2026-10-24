import 'reflect-metadata';
import { Module, ValidationPipe, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { CSV_BOM, ErrCode } from '@fight-the-landlord/protocol';
import { ADMIN_HEADER } from '../src/config/admin.controller';
import {
  ACCOUNT_CHANGES_SELECT_BASE,
  AdminChangesService,
  CONFIG_CHANGES_SELECT_BASE,
} from '../src/admin/admin-changes.service';
import { LOGIN_EVENTS_SELECT_BASE, LoginEventsService } from '../src/admin/login-events.service';
import { AuditController } from '../src/admin/audit.controller';

/**
 * 审计三读口（规格 §2.5）+ 三 CSV 变体（§2.11）+ query 白名单（⚙️9/§2.10）——判据 C16/C22 的
 * config-service 半边。
 *
 * 形态：**真 Nest 管线**（真 AuditController + 真 XAdminGuard + 真异常过滤器 + globalPrefix `api`）
 * + 真 `AdminChangesService` / `LoginEventsService` + 假 `DataSource`（内存三表 + **SQL 解释器**）。
 * 假库按**条件子句文本**逐条解释 WHERE（不认识的条件 ⇒ 当场抛——服务与假库各说各话时立刻红），
 * 并记录每条 SQL 供「校验先于查库」「ORDER BY id DESC LIMIT ? 形态」类断言。
 *
 * 判据（逐条 = §2.5/§2.10/§2.11）：
 *  - 三读口行形状逐字（字段集合/ epoch ms / oldValue/detail 可 null / success 布尔 / id DESC）；
 *  - 过滤键逐条 + 组合（AND）；from 含边界、to 不含边界（**半开区间**，口径 = §2.7）；
 *  - keyset：`limit` 缺省 50、上限 100；`nextCursor = rows.length===limit ? 末行 id : null`
 *    （**无存在性预查**——恰满页也给 nextCursor）；cursor 取下一页；
 *  - 未知 query 键 ⇒ 400 借 10001「未知查询参数：<key>」；`.csv` 白名单 = JSON 版去 `cursor/limit`
 *    （带上即 400）；过滤值长度/型别自查（key ≤64 / actor ≤32 / username ≤32 / action ≤16）——
 *    非法一律 400 **且未碰库**（校验先于查询）；
 *  - 三 CSV：首字节 BOM（EF BB BF）、行尾 `\r\n`、表头中文逐字、`csvCell` 消毒样本
 *    （`=cmd` 前置 `'`、负数不动）、文件名三档 `<名>-<yyyyMMdd-HHmmss>.csv`、**无分页**（全量出）。
 */

const AUTH = { [ADMIN_HEADER]: '1' };

const T = (iso: string) => new Date(iso);
const T1 = T('2026-10-05T10:00:00.000Z');
const T2 = T('2026-10-05T11:00:00.000Z');
const T3 = T('2026-10-05T12:00:00.000Z');

/* ------------------------------------------------------------------ *
 * 假 DataSource：三表 + SQL 解释器
 * ------------------------------------------------------------------ */

interface FakeConfigChangeRow {
  id: number;
  key: string;
  old_value: unknown; // null 或已解析的 JSON 值（模拟 mysql2 对 json 列的解析回值）
  new_value: unknown;
  actor: string;
  created_at: Date;
}

interface FakeLoginEventRow {
  id: number;
  username: string;
  account_id: number | null;
  ip: string | null;
  success: number; // tinyint(1) 的驱动形态
  created_at: Date;
}

interface FakeAccountChangeRow {
  id: number;
  target_id: number;
  username: string;
  action: string;
  detail: unknown;
  actor: string;
  created_at: Date;
}

/** 条件子句 ⇒ 谓词（全部 AND；子句文本与服务侧构造逐字对应，不认识即抛）。 */
type Predicate<R> = (row: R, value: unknown) => boolean;

const CONFIG_CHANGE_PREDICATES: Record<string, Predicate<FakeConfigChangeRow>> = {
  '`key` = ?': (r, v) => r.key === v,
  'actor = ?': (r, v) => r.actor === v,
  'created_at >= ?': (r, v) => r.created_at.getTime() >= (v as Date).getTime(),
  'created_at < ?': (r, v) => r.created_at.getTime() < (v as Date).getTime(),
  'id < ?': (r, v) => r.id < Number(v),
};

const LOGIN_EVENT_PREDICATES: Record<string, Predicate<FakeLoginEventRow>> = {
  'username = ?': (r, v) => r.username === v,
  'success = ?': (r, v) => r.success === Number(v),
  'created_at >= ?': (r, v) => r.created_at.getTime() >= (v as Date).getTime(),
  'created_at < ?': (r, v) => r.created_at.getTime() < (v as Date).getTime(),
  'id < ?': (r, v) => r.id < Number(v),
};

const ACCOUNT_CHANGE_PREDICATES: Record<string, Predicate<FakeAccountChangeRow>> = {
  'target_id = ?': (r, v) => r.target_id === Number(v),
  'actor = ?': (r, v) => r.actor === v,
  'action = ?': (r, v) => r.action === v,
  'created_at >= ?': (r, v) => r.created_at.getTime() >= (v as Date).getTime(),
  'created_at < ?': (r, v) => r.created_at.getTime() < (v as Date).getTime(),
  'id < ?': (r, v) => r.id < Number(v),
};

class FakeAuditDb {
  configChanges: FakeConfigChangeRow[] = [];
  loginEvents: FakeLoginEventRow[] = [];
  accountChanges: FakeAccountChangeRow[] = [];
  queries: Array<{ sql: string; params: unknown[] }> = [];
  private nextConfigId = 1;
  private nextEventId = 1;
  private nextAccountChangeId = 1;

  addConfigChange(over: Partial<FakeConfigChangeRow> & { key: string }): FakeConfigChangeRow {
    const row: FakeConfigChangeRow = {
      id: this.nextConfigId++,
      old_value: null,
      new_value: true,
      actor: 'admin',
      created_at: T1,
      ...over,
    };
    this.configChanges.push(row);
    return row;
  }

  addLoginEvent(over: Partial<FakeLoginEventRow> & { username: string }): FakeLoginEventRow {
    const row: FakeLoginEventRow = {
      id: this.nextEventId++,
      account_id: null,
      ip: null,
      success: 0,
      created_at: T1,
      ...over,
    };
    this.loginEvents.push(row);
    return row;
  }

  addAccountChange(
    over: Partial<FakeAccountChangeRow> & { target_id: number; action: string },
  ): FakeAccountChangeRow {
    const row: FakeAccountChangeRow = {
      id: this.nextAccountChangeId++,
      username: 'target.user',
      detail: null,
      actor: 'admin',
      created_at: T1,
      ...over,
    };
    this.accountChanges.push(row);
    return row;
  }

  reset(): void {
    this.configChanges = [];
    this.loginEvents = [];
    this.accountChanges = [];
    this.queries = [];
    this.nextConfigId = 1;
    this.nextEventId = 1;
    this.nextAccountChangeId = 1;
  }

  readonly dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> =>
      Promise.resolve(this.exec(sql, params)),
  };

  /** 解释一条 SELECT：`<base>[ WHERE <cond…>] ORDER BY id DESC[ LIMIT ?]`。 */
  private exec(sql: string, params: unknown[]): unknown {
    this.queries.push({ sql, params });

    let rest: string;
    let rows: Array<{ id: number }>;
    let predicates: Record<string, (row: any, value: unknown) => boolean>;
    if (sql.startsWith(CONFIG_CHANGES_SELECT_BASE)) {
      rest = sql.slice(CONFIG_CHANGES_SELECT_BASE.length);
      rows = this.configChanges;
      predicates = CONFIG_CHANGE_PREDICATES;
    } else if (sql.startsWith(LOGIN_EVENTS_SELECT_BASE)) {
      rest = sql.slice(LOGIN_EVENTS_SELECT_BASE.length);
      rows = this.loginEvents;
      predicates = LOGIN_EVENT_PREDICATES;
    } else if (sql.startsWith(ACCOUNT_CHANGES_SELECT_BASE)) {
      rest = sql.slice(ACCOUNT_CHANGES_SELECT_BASE.length);
      rows = this.accountChanges;
      predicates = ACCOUNT_CHANGE_PREDICATES;
    } else {
      throw new Error(`FakeAuditDb: 未识别的 SQL：${sql}`);
    }

    let limit: number | null = null;
    const boundParams = [...params];
    if (rest.endsWith(' LIMIT ?')) {
      limit = Number(boundParams.pop());
      rest = rest.slice(0, -' LIMIT ?'.length);
    }
    const ORDER = ' ORDER BY id DESC';
    if (!rest.endsWith(ORDER)) throw new Error(`FakeAuditDb: 排序后缀不符：${sql}`);
    rest = rest.slice(0, -ORDER.length);

    let conds: string[] = [];
    if (rest.length > 0) {
      if (!rest.startsWith(' WHERE ')) throw new Error(`FakeAuditDb: WHERE 形态不符：${sql}`);
      conds = rest.slice(' WHERE '.length).split(' AND ');
    }
    if (conds.length !== boundParams.length) {
      throw new Error(`FakeAuditDb: 条件数 ${conds.length} ≠ 参数数 ${boundParams.length}：${sql}`);
    }
    const matched = rows.filter((row) =>
      conds.every((cond, i) => {
        const predicate = predicates[cond];
        if (!predicate) throw new Error(`FakeAuditDb: 不认识的条件子句：${cond}`);
        return predicate(row, boundParams[i]);
      }),
    );
    const sorted = [...matched].sort((a, b) => b.id - a.id);
    return (limit === null ? sorted : sorted.slice(0, limit)).map((r) => ({ ...r }));
  }
}

/* ------------------------------------------------------------------ *
 * 真 Nest 管线的 HTTP 探针
 * ------------------------------------------------------------------ */

@Module({})
class AuditProbeModule {
  static wiring(changes: AdminChangesService, events: LoginEventsService): DynamicModule {
    return {
      module: AuditProbeModule,
      controllers: [AuditController],
      providers: [
        { provide: AdminChangesService, useValue: changes },
        { provide: LoginEventsService, useValue: events },
      ],
    };
  }
}

interface RawResult {
  status: number;
  headers: Headers;
  /** UTF-8 解码后的响应原文（CSV 断言用；BOM 保留为 U+FEFF 字符）。 */
  text: string;
  /** 原始字节（BOM 首字节断言用）。 */
  buffer: Buffer;
  json: any;
}

interface Probe {
  get: (path: string, headers?: Record<string, string>) => Promise<RawResult>;
  close: () => Promise<void>;
}

async function startProbe(db: FakeAuditDb): Promise<Probe> {
  const changes = new AdminChangesService(db.dataSource as unknown as DataSource);
  const events = new LoginEventsService(db.dataSource as unknown as DataSource);
  const app: INestApplication = await NestFactory.create(AuditProbeModule.wiring(changes, events), {
    logger: false,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  return {
    get: async (path, headers = {}) => {
      const res = await fetch(`${url}${path}`, { method: 'GET', headers });
      const buffer = Buffer.from(await res.arrayBuffer());
      const text = buffer.toString('utf8');
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, text, buffer, json };
    },
    close: async () => {
      await app.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const db = new FakeAuditDb();
let probe: Probe;

beforeAll(async () => {
  probe = await startProbe(db);
});
afterAll(async () => {
  await probe.close();
});
beforeEach(() => {
  db.reset();
});

function seedConfigChanges(): void {
  db.addConfigChange({ key: 'room.friendRoomEnabled', old_value: null, new_value: true, actor: 'admin', created_at: T1 });
  db.addConfigChange({ key: '=SKETCHY', old_value: { a: 1 }, new_value: 12.5, actor: '=cmd', created_at: T2 });
  db.addConfigChange({ key: 'room.reapIntervalMs', old_value: 60000, new_value: -12.5, actor: 'admin', created_at: T3 });
}

function seedLoginEvents(): void {
  db.addLoginEvent({ username: 'admin', account_id: 1, ip: '203.0.113.7', success: 1, created_at: T1 });
  db.addLoginEvent({ username: 'ghost.user', account_id: null, ip: null, success: 0, created_at: T2 });
  db.addLoginEvent({ username: 'a,b', account_id: 2, ip: '=1.2.3.4', success: 0, created_at: T3 });
}

function seedAccountChanges(): void {
  db.addAccountChange({
    target_id: 3,
    username: 'victim.user',
    action: 'role',
    detail: { from: 'viewer', to: 'finance' },
    actor: 'boss.super',
    created_at: T1,
  });
  db.addAccountChange({
    target_id: 3,
    username: 'victim.user',
    action: 'disable',
    detail: null,
    actor: 'boss.super',
    created_at: T2,
  });
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('X-Admin fail-closed（六端点同守卫）', () => {
  it('六个端点无 X-Admin ⇒ 401 + 10002，且碰不到 handler（假库零查询）', async () => {
    const paths = [
      '/api/admin/config/changes',
      '/api/admin/config/changes.csv',
      '/api/admin/login-events',
      '/api/admin/login-events.csv',
      '/api/admin/accounts/changes',
      '/api/admin/accounts/changes.csv',
    ];
    for (const path of paths) {
      const res = await probe.get(path);
      expect(res.status, path).toBe(401);
      expect(res.json.code, path).toBe(ErrCode.UNAUTHENTICATED);
      expect(res.json.data, path).toBeNull();
    }
    expect(db.queries).toEqual([]);
  });
});

describe('GET /api/admin/config/changes（JSON；§2.5）', () => {
  it('行形状逐字 + id DESC + epoch ms + oldValue 可 null；无参 ⇒ 缺省 limit 50', async () => {
    seedConfigChanges();

    const res = await probe.get('/api/admin/config/changes', AUTH);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      code: ErrCode.OK,
      data: {
        rows: [
          { id: 3, key: 'room.reapIntervalMs', oldValue: 60000, newValue: -12.5, actor: 'admin', createdAt: T3.getTime() },
          { id: 2, key: '=SKETCHY', oldValue: { a: 1 }, newValue: 12.5, actor: '=cmd', createdAt: T2.getTime() },
          { id: 1, key: 'room.friendRoomEnabled', oldValue: null, newValue: true, actor: 'admin', createdAt: T1.getTime() },
        ],
        nextCursor: null,
      },
    });
    // SQL 形态：无过滤 ⇒ 基句 + ORDER BY id DESC LIMIT ?（缺省 50）；不缓存（每次查库）
    expect(db.queries).toEqual([
      { sql: `${CONFIG_CHANGES_SELECT_BASE} ORDER BY id DESC LIMIT ?`, params: [50] },
    ]);
  });

  it('过滤 key/actor + from 含边界 / to 不含边界（半开区间）', async () => {
    db.addConfigChange({ key: 'k.a', actor: 'u.one', created_at: T('2026-10-05T10:00:00.000Z') });
    db.addConfigChange({ key: 'k.b', actor: 'u.two', created_at: T('2026-10-05T11:00:00.000Z') });
    db.addConfigChange({ key: 'k.c', actor: 'u.one', created_at: T('2026-10-05T12:00:00.000Z') });
    db.addConfigChange({ key: 'k.d', actor: 'u.two', created_at: T('2026-10-05T13:00:00.000Z') });
    db.addConfigChange({ key: 'k.e', actor: 'u.one', created_at: T('2026-10-05T14:00:00.000Z') });

    const byKey = await probe.get('/api/admin/config/changes?key=k.c', AUTH);
    expect(byKey.json.data.rows.map((r: any) => r.key)).toEqual(['k.c']);

    const byActor = await probe.get('/api/admin/config/changes?actor=u.two', AUTH);
    expect(byActor.json.data.rows.map((r: any) => r.key)).toEqual(['k.d', 'k.b']); // id DESC

    // from = 12:00 ⇒ 含 12:00 行（13:00/14:00 也在窗口内）；to = 13:00 ⇒ 不含 13:00 行
    const from = await probe.get(
      `/api/admin/config/changes?from=${T('2026-10-05T12:00:00.000Z').getTime()}`,
      AUTH,
    );
    expect(from.json.data.rows.map((r: any) => r.key)).toEqual(['k.e', 'k.d', 'k.c']);

    const to = await probe.get(
      `/api/admin/config/changes?to=${T('2026-10-05T13:00:00.000Z').getTime()}`,
      AUTH,
    );
    expect(to.json.data.rows.map((r: any) => r.key)).toEqual(['k.c', 'k.b', 'k.a']);

    // 组合：AND
    const comb = await probe.get(
      `/api/admin/config/changes?key=k.c&actor=u.one&from=${T('2026-10-05T11:00:00.000Z').getTime()}&to=${T('2026-10-05T13:00:00.000Z').getTime()}`,
      AUTH,
    );
    expect(comb.json.data.rows.map((r: any) => r.key)).toEqual(['k.c']);
    // 过滤值按序进 SQL（key→actor→from→to，日期以 new Date(ms) 绑定）
    expect(db.queries.at(-1)!.sql).toBe(
      `${CONFIG_CHANGES_SELECT_BASE} WHERE \`key\` = ? AND actor = ? AND created_at >= ? AND created_at < ? ORDER BY id DESC LIMIT ?`,
    );
    expect(db.queries.at(-1)!.params).toEqual([
      'k.c',
      'u.one',
      new Date(T('2026-10-05T11:00:00.000Z').getTime()),
      new Date(T('2026-10-05T13:00:00.000Z').getTime()),
      50,
    ]);
  });

  it('keyset：limit=2 ⇒ nextCursor=末行 id；cursor 取下一页（恰满页照给）；短页 ⇒ null', async () => {
    for (let i = 1; i <= 4; i += 1) {
      db.addConfigChange({ key: `k.${i}`, created_at: T1 });
    }

    const page1 = await probe.get('/api/admin/config/changes?limit=2', AUTH);
    expect(page1.json.data.rows.map((r: any) => r.id)).toEqual([4, 3]);
    expect(page1.json.data.nextCursor).toBe(3);

    // 恰满页 ⇒ 照给末行 id（不做存在性预查——下一页才知道是不是空）
    const page2 = await probe.get('/api/admin/config/changes?limit=2&cursor=3', AUTH);
    expect(page2.json.data.rows.map((r: any) => r.id)).toEqual([2, 1]);
    expect(page2.json.data.nextCursor).toBe(1);
    expect(db.queries.at(-1)!.sql).toBe(
      `${CONFIG_CHANGES_SELECT_BASE} WHERE id < ? ORDER BY id DESC LIMIT ?`,
    );
    expect(db.queries.at(-1)!.params).toEqual([3, 2]);

    // 短页（< limit）⇒ nextCursor = null（末页）
    const page3 = await probe.get('/api/admin/config/changes?limit=2&cursor=1', AUTH);
    expect(page3.json.data.rows).toEqual([]);
    expect(page3.json.data.nextCursor).toBeNull();
  });

  it('恰满页 ⇒ nextCursor = 末行 id（不做存在性预查——至多多一次空页）', async () => {
    db.addConfigChange({ key: 'k.1' });
    db.addConfigChange({ key: 'k.2' });

    const res = await probe.get('/api/admin/config/changes?limit=2', AUTH);

    expect(res.json.data.rows.map((r: any) => r.id)).toEqual([2, 1]);
    expect(res.json.data.nextCursor).toBe(1); // 恰满页照给（不预查是否真有下一页）

    const empty = await probe.get('/api/admin/config/changes?limit=2&cursor=1', AUTH);
    expect(empty.json.data.rows).toEqual([]);
    expect(empty.json.data.nextCursor).toBeNull();
  });

  it('真分页读数：缺省 50 截 51 行；limit=100 一次出全（上限 100）', async () => {
    for (let i = 1; i <= 51; i += 1) {
      db.addConfigChange({ key: `k.${String(i).padStart(2, '0')}` });
    }

    const dflt = await probe.get('/api/admin/config/changes', AUTH);
    expect(dflt.json.data.rows).toHaveLength(50);
    expect(dflt.json.data.rows[0].id).toBe(51);
    expect(dflt.json.data.nextCursor).toBe(2); // 末行 = 第 50 行 ⇒ id 2

    const full = await probe.get('/api/admin/config/changes?limit=100', AUTH);
    expect(full.json.data.rows).toHaveLength(51);
    expect(full.json.data.nextCursor).toBeNull();
  });

  it('过滤值非法 ⇒ 400 精确文案，且**未碰库**（校验先于查询）', async () => {
    const cases: Array<[string, string, string]> = [
      ['limit=101', 'limit 非法：须为 1–100 的整数', 'limit 上限'],
      ['limit=0', 'limit 非法：须为 1–100 的整数', 'limit 下界'],
      ['limit=abc', 'limit 非法：须为 1–100 的整数', 'limit 非数'],
      ['limit=1.5', 'limit 非法：须为 1–100 的整数', 'limit 小数'],
      ['limit=-1', 'limit 非法：须为 1–100 的整数', 'limit 负'],
      ['cursor=0', 'cursor 非法：须为正整数', 'cursor 下界'],
      ['cursor=abc', 'cursor 非法：须为正整数', 'cursor 非数'],
      ['from=abc', 'from 非法：须为非负整数（epoch 毫秒）', 'from 非数'],
      ['from=-5', 'from 非法：须为非负整数（epoch 毫秒）', 'from 负'],
      ['from=9007199254740991', 'from 非法：须为非负整数（epoch 毫秒）', 'from 超 Date 域'],
      ['to=1.5', 'to 非法：须为非负整数（epoch 毫秒）', 'to 小数'],
      ['key=', 'key 非法：长度须为 1–64', 'key 空串'],
      [`actor=${'a'.repeat(33)}`, 'actor 非法：长度须为 1–32', 'actor 超列宽'],
      [`key=${'k'.repeat(65)}`, 'key 非法：长度须为 1–64', 'key 超列宽'],
      ['key=a&key=b', 'key 非法：长度须为 1–64', '重复参数（数组）'],
    ];
    for (const [qs, message, label] of cases) {
      const res = await probe.get(`/api/admin/config/changes?${qs}`, AUTH);
      expect(res.status, label).toBe(400);
      expect(res.json, label).toEqual({ code: ErrCode.BAD_PARAM, message, data: null });
    }
    expect(db.queries).toEqual([]);
  });

  it('未知 query 键 ⇒ 400 借 10001「未知查询参数：<key>」（未碰库）', async () => {
    const res = await probe.get('/api/admin/config/changes?foo=1', AUTH);

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ code: ErrCode.BAD_PARAM, message: '未知查询参数：foo', data: null });
    expect(db.queries).toEqual([]);
  });
});

describe('GET /api/admin/login-events（JSON；§2.5）', () => {
  it('行形状逐字：success 布尔、accountId/ip 可 null、epoch ms、id DESC', async () => {
    seedLoginEvents();

    const res = await probe.get('/api/admin/login-events', AUTH);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      code: ErrCode.OK,
      data: {
        rows: [
          { id: 3, username: 'a,b', accountId: 2, ip: '=1.2.3.4', success: false, createdAt: T3.getTime() },
          { id: 2, username: 'ghost.user', accountId: null, ip: null, success: false, createdAt: T2.getTime() },
          { id: 1, username: 'admin', accountId: 1, ip: '203.0.113.7', success: true, createdAt: T1.getTime() },
        ],
        nextCursor: null,
      },
    });
  });

  it('过滤 username / success（0|1）/ from / to（半开区间）', async () => {
    seedLoginEvents();

    const byUser = await probe.get('/api/admin/login-events?username=ghost.user', AUTH);
    expect(byUser.json.data.rows.map((r: any) => r.id)).toEqual([2]);

    const ok = await probe.get('/api/admin/login-events?success=1', AUTH);
    expect(ok.json.data.rows.map((r: any) => r.id)).toEqual([1]);

    const fail = await probe.get('/api/admin/login-events?success=0', AUTH);
    expect(fail.json.data.rows.map((r: any) => r.id)).toEqual([3, 2]);

    const to = await probe.get(`/api/admin/login-events?to=${T2.getTime()}`, AUTH);
    expect(to.json.data.rows.map((r: any) => r.id)).toEqual([1]); // to 不含边界（T2 行不在）

    const from = await probe.get(`/api/admin/login-events?from=${T2.getTime()}`, AUTH);
    expect(from.json.data.rows.map((r: any) => r.id)).toEqual([3, 2]); // from 含边界（T2 行在）
  });

  it('keyset 分页（limit/cursor/nextCursor）', async () => {
    seedLoginEvents();

    const page1 = await probe.get('/api/admin/login-events?limit=1', AUTH);
    expect(page1.json.data.rows.map((r: any) => r.id)).toEqual([3]);
    expect(page1.json.data.nextCursor).toBe(3);

    const page2 = await probe.get('/api/admin/login-events?limit=1&cursor=3', AUTH);
    expect(page2.json.data.rows.map((r: any) => r.id)).toEqual([2]);
    expect(page2.json.data.nextCursor).toBe(2);
  });

  it('success 非法 / username 超列宽 ⇒ 400 精确文案（未碰库）', async () => {
    for (const [qs, message] of [
      ['success=2', 'success 非法：须为 0 或 1'],
      ['success=true', 'success 非法：须为 0 或 1'],
      ['success=', 'success 非法：须为 0 或 1'],
      [`username=${'a'.repeat(33)}`, 'username 非法：长度须为 1–32'],
    ] as Array<[string, string]>) {
      const res = await probe.get(`/api/admin/login-events?${qs}`, AUTH);
      expect(res.status, qs).toBe(400);
      expect(res.json, qs).toEqual({ code: ErrCode.BAD_PARAM, message, data: null });
    }
    expect(db.queries).toEqual([]);
  });

  it('未知 query 键 ⇒ 400「未知查询参数：<key>」', async () => {
    const res = await probe.get('/api/admin/login-events?from2=1', AUTH);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ code: ErrCode.BAD_PARAM, message: '未知查询参数：from2', data: null });
  });
});

describe('GET /api/admin/accounts/changes（JSON；§2.5）', () => {
  it('行形状逐字：detail 对象/null、targetId、epoch ms、id DESC', async () => {
    seedAccountChanges();

    const res = await probe.get('/api/admin/accounts/changes', AUTH);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      code: ErrCode.OK,
      data: {
        rows: [
          {
            id: 2,
            targetId: 3,
            username: 'victim.user',
            action: 'disable',
            detail: null,
            actor: 'boss.super',
            createdAt: T2.getTime(),
          },
          {
            id: 1,
            targetId: 3,
            username: 'victim.user',
            action: 'role',
            detail: { from: 'viewer', to: 'finance' },
            actor: 'boss.super',
            createdAt: T1.getTime(),
          },
        ],
        nextCursor: null,
      },
    });
  });

  it('过滤 targetId / actor / action 组合（AND）', async () => {
    seedAccountChanges();
    db.addAccountChange({ target_id: 7, username: 'other.user', action: 'role', actor: 'ops.user', created_at: T3 });

    const byTarget = await probe.get('/api/admin/accounts/changes?targetId=7', AUTH);
    expect(byTarget.json.data.rows.map((r: any) => r.id)).toEqual([3]);

    const byAction = await probe.get('/api/admin/accounts/changes?action=role', AUTH);
    expect(byAction.json.data.rows.map((r: any) => r.id)).toEqual([3, 1]);

    const comb = await probe.get('/api/admin/accounts/changes?actor=boss.super&action=disable', AUTH);
    expect(comb.json.data.rows.map((r: any) => r.id)).toEqual([2]);
  });

  it('targetId 非法 / action 超列宽 / 未知键 ⇒ 400（未碰库）', async () => {
    for (const [qs, message] of [
      ['targetId=0', 'targetId 非法：须为正整数'],
      ['targetId=abc', 'targetId 非法：须为正整数'],
      [`action=${'a'.repeat(17)}`, 'action 非法：长度须为 1–16'],
      ['cursor=0', 'cursor 非法：须为正整数'],
      ['what=1', '未知查询参数：what'],
    ] as Array<[string, string]>) {
      const res = await probe.get(`/api/admin/accounts/changes?${qs}`, AUTH);
      expect(res.status, qs).toBe(400);
      expect(res.json, qs).toEqual({ code: ErrCode.BAD_PARAM, message, data: null });
    }
    expect(db.queries).toEqual([]);
  });
});

describe('CSV 三面（§2.11）', () => {
  it('config-changes.csv：BOM 首字节 / 行尾 CRLF / 中文表头 / 消毒样本（=cmd 前置 ’、负数不动）/ 文件名', async () => {
    seedConfigChanges();

    const res = await probe.get('/api/admin/config/changes.csv', AUTH);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="config-changes-\d{8}-\d{6}\.csv"$/,
    );
    // BOM = 首字节 EF BB BF（UTF-8 编码的 U+FEFF）
    expect([res.buffer[0], res.buffer[1], res.buffer[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    // 逐字全文：id DESC；'=SKETCHY'/'=cmd' 消毒前缀 `'`；JSON 单元格引号双写；null ⇒ 空；-12.5 数字豁免
    expect(res.text).toBe(
      CSV_BOM +
        [
          'ID,配置键,旧值,新值,操作者,时间',
          `3,room.reapIntervalMs,60000,-12.5,admin,${T3.getTime()}`,
          `2,'=SKETCHY,"{""a"":1}",12.5,'=cmd,${T2.getTime()}`,
          `1,room.friendRoomEnabled,,true,admin,${T1.getTime()}`,
        ].join('\r\n') +
        '\r\n',
    );
    // 行尾一律 CRLF（无裸 LF）
    expect(/[^\r]\n/.test(res.text)).toBe(false);
  });

  it('login-events.csv：BOM / CRLF / 表头逐字 / 消毒（IP 与含逗号用户名）/ 文件名', async () => {
    seedLoginEvents();

    const res = await probe.get('/api/admin/login-events.csv', AUTH);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="login-events-\d{8}-\d{6}\.csv"$/,
    );
    expect([res.buffer[0], res.buffer[1], res.buffer[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.text).toBe(
      CSV_BOM +
        [
          'ID,用户名,账号ID,IP,成功,时间',
          `3,"a,b",2,'=1.2.3.4,false,${T3.getTime()}`,
          `2,ghost.user,,,false,${T2.getTime()}`,
          `1,admin,1,203.0.113.7,true,${T1.getTime()}`,
        ].join('\r\n') +
        '\r\n',
    );
  });

  it('account-changes.csv：BOM / CRLF / 表头逐字 / detail JSON 引号双写 / 文件名', async () => {
    seedAccountChanges();

    const res = await probe.get('/api/admin/accounts/changes.csv', AUTH);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="account-changes-\d{8}-\d{6}\.csv"$/,
    );
    expect([res.buffer[0], res.buffer[1], res.buffer[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.text).toBe(
      CSV_BOM +
        [
          'ID,目标账号ID,用户名,动作,详情,操作者,时间',
          `2,3,victim.user,disable,,boss.super,${T2.getTime()}`,
          `1,3,victim.user,role,"{""from"":""viewer"",""to"":""finance""}",boss.super,${T1.getTime()}`,
        ].join('\r\n') +
        '\r\n',
    );
  });

  it('CSV 不分页：60 行全量出（JSON 会截 50）；过滤键照常可用', async () => {
    for (let i = 1; i <= 60; i += 1) {
      db.addConfigChange({ key: i === 60 ? 'needle.key' : `k.${String(i).padStart(2, '0')}` });
    }

    const all = await probe.get('/api/admin/config/changes.csv', AUTH);
    expect(all.text.split('\r\n')).toHaveLength(62); // 表头 + 60 行 + 末尾空段

    const filtered = await probe.get('/api/admin/config/changes.csv?key=needle.key', AUTH);
    expect(filtered.text.split('\r\n')).toHaveLength(3); // 表头 + 1 行 + 末尾空段
    expect(filtered.text).toContain('needle.key');
  });

  it('.csv 白名单 = JSON 版去掉 cursor/limit（带上即 400「未知查询参数」）；未知键同拒', async () => {
    for (const [path, key] of [
      ['/api/admin/config/changes.csv?limit=10', 'limit'],
      ['/api/admin/config/changes.csv?cursor=1', 'cursor'],
      ['/api/admin/login-events.csv?limit=10', 'limit'],
      ['/api/admin/accounts/changes.csv?cursor=1', 'cursor'],
    ] as Array<[string, string]>) {
      const res = await probe.get(path, AUTH);
      expect(res.status, path).toBe(400);
      expect(res.json, path).toEqual({
        code: ErrCode.BAD_PARAM,
        message: `未知查询参数：${key}`,
        data: null,
      });
    }

    const unknown = await probe.get('/api/admin/login-events.csv?nope=1', AUTH);
    expect(unknown.status).toBe(400);
    expect(unknown.json.message).toBe('未知查询参数：nope');
    expect(db.queries).toEqual([]);
  });
});

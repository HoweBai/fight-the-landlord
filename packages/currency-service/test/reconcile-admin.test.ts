/**
 * 对账面板（③ T8；规格 §2.7 reconcile 段 + ⚙️5 + 设计 §5.7）——状态四字段 + `inFlight` 互斥 + 两端点。
 *
 * 判据（全列；C21 的 currency-service 半边）：
 *  - 状态四字段（**内存态**；新进程 ⇒ 全 null = 「未知」，不得伪造）：
 *    **每一轮尝试（成败都）**刷 `lastAttemptAt`（epoch ms；设计 G7——面板要能表达
 *    「最近一次**尝试**失败于何时」）；成功轮另刷 `lastSuccessAt` + `lastResult`；
 *    失败轮刷 `lastError` = `String(err).slice(0, 500)`（截断边界钉）；**失败轮不动上一成功面**
 *    （lastSuccessAt/lastResult 保留）、**成功轮不擦 lastError**（「最近一次错误」——
 *    规格只写「成功另刷后两项」，本文件把该读法钉成可审的断言）。
 *  - 互斥 `inFlight` 旗（手动与定时链共用，`runReconcileInner` 入口 set / finally 清）：
 *    手动遇在跑 ⇒ 抛 `ReconcileInFlightError`（控制器翻 **409 借 10001**「对账正在运行」）
 *    且**零新读数**（不叠跑）；定时轮遇旗 ⇒ 跳过本轮（一行 warn、**不写** `lastAttemptAt`
 *    ——本轮未尝试、零读数）+ **照常自重排**。
 *  - `runWithTrace` 包裹不叠（T8b）：手动一轮所有日志行恰一个 traceId（两层嵌套会分家——
 *    定时链半边由 `reconcile.test.ts` 钉）；**跳过轮无包裹**（warn 行 `currentTrace()` undefined）。
 *  - 端点（**真 Nest 管线**：真 `AdminFinanceController` + 真 `XAdminGuard` + 真异常过滤器）：
 *    `GET /api/admin/wallet/reconcile` 初始 `{四字段 null, running:false}`（读端点不强求 actor）；
 *    `POST /api/admin/wallet/reconcile/run` ⇒ 200 `data` = 一轮读数（GET 随即可读回同值）；
 *    在跑 ⇒ 409 `{code:10001, message:'对账正在运行', data:null}`；写方法 actor fail-closed
 *    （缺 `X-Admin` / 缺或非法 `X-Admin-Actor` ⇒ 401，零读数；v1.1.5：写端点统一强制）。
 *
 * 形态：单测层用 `FakeCurrencyDb`/`FakeRedis` 直驱服务（照 `reconcile.test.ts` 夹具）；
 * HTTP 层真 Nest 管线，`ReconcileService` 由**委托壳**提供 —— 壳（纯对象）不带生命周期钩子：
 * 真件经 `useValue` 进容器会触发 `onModuleInit`（10s 首跑定时器 + 指标清零），与本章无关
 * （循环节奏/指标是 `reconcile.test.ts` 的判据）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, Module, ValidationPipe, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { currentTrace } from '@fight-the-landlord/shared';
import {
  CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS,
  ReconcileInFlightError,
  ReconcileService,
} from '../src/reconcile/reconcile.service';
import type { ConfigCacheService } from '../src/config/config-cache.service';
import {
  RecordsReconcileService,
  type RecordsReconcileStatus,
} from '../src/reconcile/records-reconcile.service';
import { AdminFinanceController } from '../src/admin/admin-finance.controller';
import { FinanceQueryService } from '../src/admin/finance-query.service';
import { ReverseService } from '../src/admin/reverse.service';
import { ApplyService } from '../src/apply/apply.service';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

/** 固定时间轴原点（epoch ms 断言；不随真实时钟漂移）。 */
const T0 = Date.parse('2026-10-05T12:00:00.000Z');

const STATUS_PATH = '/api/admin/wallet/reconcile';
const RUN_PATH = '/api/admin/wallet/reconcile/run';
const READ_AUTH = { 'x-admin': '1' };
const AUTH = { 'x-admin': '1', 'x-admin-actor': 'finance.one' };

/**
 * C2：记录对账状态委托壳的固定读数。**纯对象 ⇒ 无 `onModuleInit`**（不会启 10s 首跑定时器）；
 * GET 的加性 `records` 字段据此精确断言，POST（老服务）响应里**不得**出现它。
 */
const RECORDS_STATUS: RecordsReconcileStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastResult: null,
  lastError: null,
  running: false,
};

/**
 * 假 ConfigCache（本片 T8 起循环消费面三件：间隔 getter + 首排两把手——缺省 = 快路径
 * 就绪 + 1h；只有定时链用例需要传短间隔）。
 */
function makeCache(intervalMs = 3_600_000): ConfigCacheService {
  return {
    reconcileIntervalMs: () => intervalMs,
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
  } as unknown as ConfigCacheService;
}

/* ------------------------------------------------------------------ *
 * 单测层：状态四字段 + inFlight 互斥（`FakeCurrencyDb`/`FakeRedis` + 假时钟）
 * ------------------------------------------------------------------ */

describe('§2.7 对账面板状态与互斥（服务层）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  /**
   * 构造被测服务（假 DB + 假 Redis + 假缓存；缺省缓存 = 快路径就绪 + 1h）。
   */
  const mkService = (
    db: FakeCurrencyDb,
    redis: FakeRedis,
    cache: ConfigCacheService = makeCache(),
  ): ReconcileService =>
    new ReconcileService(db.dataSource as unknown as DataSource, redis as unknown as Redis, cache);

  it('四字段初值：新进程未跑过 ⇒ 前四项全 null、running=false（「未知」如实呈现，不伪造）', () => {
    const svc = mkService(new FakeCurrencyDb(), new FakeRedis());
    expect(svc.getStatus()).toEqual({
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastResult: null,
      lastError: null,
      running: false,
    });
  });

  it('成功轮：attempt/success/result 三字段刷新（epoch ms + 读数对象），error 仍 null；running 回 false', async () => {
    const db = new FakeCurrencyDb();
    db.seedAccount('x', 'user', 100); // balance 100、无流水 ⇒ 漂移轮（漂移是「检查结果」不算失败）
    const svc = mkService(db, new FakeRedis());

    const result = await svc.runReconcileOnce();

    expect(result.driftAccounts).toBe(1);
    expect(svc.getStatus()).toEqual({
      lastAttemptAt: T0,
      lastSuccessAt: T0,
      lastResult: result,
      lastError: null,
      running: false,
    });
  });

  it('失败轮（首轮即失败）：只刷 attempt + error —— success/result 保持 null；running 回 false', async () => {
    const db = new FakeCurrencyDb();
    const svc = mkService(db, new FakeRedis());
    db.directFailuresRemaining = 1; // 检查①查询抛 ⇒ 失败轮

    await expect(svc.runReconcileOnce()).rejects.toThrow('db down');

    expect(svc.getStatus()).toEqual({
      lastAttemptAt: T0,
      lastSuccessAt: null,
      lastResult: null,
      lastError: String(new Error('db down（仿真）')), // 'Error: db down（仿真）'（String(err) 形态）
      running: false,
    });
  });

  it('成功后失败：attempt/error 刷新，上一成功面（success/result）原封保留；成功也不擦旧 error', async () => {
    const db = new FakeCurrencyDb();
    const svc = mkService(db, new FakeRedis());
    const first = await svc.runReconcileOnce(); // 成功基线（T0）

    vi.setSystemTime(T0 + 60_000);
    db.directFailuresRemaining = 1;
    await expect(svc.runReconcileOnce()).rejects.toThrow('db down');

    let st = svc.getStatus();
    expect(st.lastAttemptAt).toBe(T0 + 60_000);
    expect(st.lastError).toBe(String(new Error('db down（仿真）')));
    expect(st.lastSuccessAt, '失败轮不擦上一成功时间').toBe(T0);
    expect(st.lastResult, '失败轮不擦上一成功读数').toEqual(first);

    // 再跑成功一轮：attempt/success/result 刷新；lastError 保留（「最近一次错误」——规格只写
    // 「成功另刷后两项」；面板据 lastAttemptAt vs lastSuccessAt 判新旧）
    vi.setSystemTime(T0 + 120_000);
    const second = await svc.runReconcileOnce();
    st = svc.getStatus();
    expect(st.lastAttemptAt).toBe(T0 + 120_000);
    expect(st.lastSuccessAt).toBe(T0 + 120_000);
    expect(st.lastResult).toEqual(second);
    expect(st.lastError).toBe(String(new Error('db down（仿真）')));
  });

  it('lastError 截断：`String(err).slice(0, 500)`（600 字错误 ⇒ 恰 500 字）', async () => {
    const long = 'x'.repeat(600);
    const failingDs = {
      query: () => Promise.reject(new Error(long)),
    } as unknown as DataSource;
    const svc = new ReconcileService(failingDs, new FakeRedis() as unknown as Redis, makeCache());

    await expect(svc.runReconcileOnce()).rejects.toThrow('xxxx');

    const lastError = svc.getStatus().lastError;
    expect(lastError).toBe(`Error: ${long}`.slice(0, 500));
    expect(lastError!.length).toBe(500);
  });

  it('互斥·手动遇旗：在跑一轮时再手动 ⇒ 抛 ReconcileInFlightError（零新读数、不叠跑；running 如实翻转）', async () => {
    const db = new FakeCurrencyDb();
    const svc = mkService(db, new FakeRedis());
    const gate = db.holdNextDirectQuery();
    const first = svc.runReconcileOnce(); // 在途（挂起在检查①）
    expect(db.directQueries, '反空测：第一轮必须真的在途').toHaveLength(1);
    expect(svc.getStatus().running, '在途 ⇒ running=true').toBe(true);

    await expect(svc.runReconcileOnce()).rejects.toThrow(ReconcileInFlightError);
    await expect(svc.runReconcileOnce()).rejects.toThrow('对账正在运行'); // 文案（HTTP 409 逐字同源）
    expect(db.directQueries, '被拒的手动触发零新读数').toHaveLength(1);

    gate.resolve([]); // 放行第一轮（检查① 空集 ⇒ 全零读数）
    const result = await first;
    expect(result.driftAccounts).toBe(0);
    expect(svc.getStatus().running).toBe(false);
    expect(svc.getStatus().lastResult).toEqual(result);
  });

  it('互斥·定时遇旗：跳过本轮（恰一行 warn、不写 attempt、零新读数）+ 照常自重排；跳过轮无 trace 包裹', async () => {
    const db = new FakeCurrencyDb();
    const svc = mkService(db, new FakeRedis(), makeCache(100));

    const skipTraceIds: Array<string | null | undefined> = [];
    warnSpy.mockImplementation((msg: unknown) => {
      if (String(msg).includes('currency reconcile skipped')) skipTraceIds.push(currentTrace()?.traceId);
    });

    const gate = db.holdNextDirectQuery();
    const manual = svc.runReconcileOnce(); // 手动一轮在途
    const attemptAt = svc.getStatus().lastAttemptAt; // 手动轮入口已写（= T0）
    const readsBefore = db.directQueries.length; // 1（挂起中的检查①）

    svc.onModuleInit(); // 排 10s 首跑
    await vi.advanceTimersByTimeAsync(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS); // 定时轮到点 ⇒ 遇旗跳过

    expect(
      warnSpy.mock.calls.map((args) => String(args[0])).filter((m) => m.includes('currency reconcile skipped')),
      '「跳过本轮并记日志」= 恰一行 warn',
    ).toHaveLength(1);
    expect(skipTraceIds, '跳过轮无 runWithTrace 包裹（本轮未尝试 ⇒ 无「这一轮」的 trace）').toEqual([undefined]);
    expect(db.directQueries, '跳过 = 零新读数').toHaveLength(readsBefore);
    expect(svc.getStatus().lastAttemptAt, '跳过不写 lastAttemptAt（本轮未尝试）').toBe(attemptAt);

    // 放行手动轮 ⇒ 正常收尾（4 条直读：检查①③ + 池/总和两 gauge；缓存空 ⇒ 检查②零读）
    gate.resolve([]);
    await manual;
    const readsAfterManual = db.directQueries.length;
    expect(readsAfterManual).toBe(4);

    // 跳过时**已自重排**（+100ms = 注入间隔）：下一轮照常起跑
    await vi.advanceTimersByTimeAsync(100);
    expect(db.directQueries, '跳过轮自重排 ⇒ 到点照跑下一轮').toHaveLength(readsAfterManual + 4);

    svc.onApplicationShutdown();
  });

  it('T8b·包裹不叠（手动路径）：一轮所有日志行同 traceId（恰一层）；每轮自建（两轮 id 不同）', async () => {
    const db = new FakeCurrencyDb();
    db.seedAccount('u-drift', 'user', 100); // 检查①漂移 ⇒ 轮内先出一条 drift error 行
    const svc = mkService(db, new FakeRedis());

    const lines: Array<{ msg: string; traceId: string | null | undefined }> = [];
    const record = (msg: unknown): void => {
      lines.push({ msg: String(msg), traceId: currentTrace()?.traceId });
    };
    logSpy.mockImplementation(record);
    errorSpy.mockImplementation(record);

    await svc.runReconcileOnce();
    expect(lines.map((l) => l.msg).some((m) => m.includes('currency reconcile drift')), '反空测：漂移行').toBe(true);
    expect(lines.map((l) => l.msg).some((m) => m.includes('currency reconcile done')), '摘要行').toBe(true);
    expect(lines.every((l) => typeof l.traceId === 'string' && l.traceId.length > 0), '每轮自建 id').toBe(true);
    const ids1 = new Set(lines.map((l) => l.traceId));
    expect(ids1.size, `一轮恰一个 traceId（收到：${[...ids1].join(' / ')}）`).toBe(1);

    lines.length = 0;
    await svc.runReconcileOnce();
    expect(new Set(lines.map((l) => l.traceId)).size, '第 2 轮同判据').toBe(1);
    expect(lines[0]!.traceId, '每轮自建：第 2 轮 id ≠ 第 1 轮 id').not.toBe([...ids1][0]);
  });
});

/* ------------------------------------------------------------------ *
 * HTTP 层：两端点（真 Nest 管线；委托壳不带生命周期钩子）
 * ------------------------------------------------------------------ */

@Module({})
class ReconcileProbeModule {}

interface HttpResult {
  status: number;
  body: any;
}

interface ReconcileProbe {
  get: (path: string, headers?: Record<string, string>) => Promise<HttpResult>;
  postJson: (path: string, body: unknown, headers?: Record<string, string>) => Promise<HttpResult>;
  close: () => Promise<void>;
}

/** 逐用例换新假库与新服务实例；ds 经 ctx **动态**取当前 db（beforeEach 换库也生效）。 */
const ctx: { db: FakeCurrencyDb; redis: FakeRedis; svc: ReconcileService } = {
  db: new FakeCurrencyDb(),
  redis: new FakeRedis(),
  svc: null as unknown as ReconcileService,
};

const probeDs = {
  transaction: ((cb: (manager: unknown) => Promise<unknown>) =>
    ctx.db.dataSource.transaction(cb)) as unknown,
  query: (sql: string, params: unknown[] = []): Promise<unknown> => ctx.db.dataSource.query(sql, params),
} as unknown as DataSource;

async function startProbe(): Promise<ReconcileProbe> {
  const module: DynamicModule = {
    module: ReconcileProbeModule,
    controllers: [AdminFinanceController],
    providers: [
      // 本文件不触 ops/summary/reverse 面 —— 占位空对象仅供容器解析（照 `http-probe.ts` 先例）。
      { provide: FinanceQueryService, useValue: {} as FinanceQueryService },
      { provide: ReverseService, useValue: {} as ReverseService },
      { provide: ApplyService, useValue: {} as ApplyService },
      // 委托壳：方法直通**当前** ctx.svc（真件）；纯对象 ⇒ 无 `onModuleInit`（不启循环）。
      {
        provide: ReconcileService,
        useValue: {
          getStatus: () => ctx.svc.getStatus(),
          runReconcileOnce: () => ctx.svc.runReconcileOnce(),
        } as unknown as ReconcileService,
      },
      // C2：记录对账只加 GET 状态（无手动触发）；委托壳同款——纯对象，无生命周期钩子。
      {
        provide: RecordsReconcileService,
        useValue: { getStatus: () => RECORDS_STATUS } as unknown as RecordsReconcileService,
      },
    ],
  };
  const app: INestApplication = await NestFactory.create(module, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResult> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  };

  return {
    get: (path, headers) => request('GET', path, undefined, headers),
    postJson: (path, body, headers) => request('POST', path, body, headers),
    close: async () => {
      await app.close();
    },
  };
}

let probe: ReconcileProbe;

beforeAll(async () => {
  probe = await startProbe();
});
afterAll(async () => {
  await probe.close();
});
beforeEach(() => {
  ctx.db = new FakeCurrencyDb();
  ctx.redis = new FakeRedis();
  ctx.svc = new ReconcileService(probeDs, ctx.redis as unknown as Redis, makeCache());
});

describe('GET/POST /api/admin/wallet/reconcile（§2.7；真 Nest 管线）', () => {
  it('GET 初始：四字段 null + running:false + 加性 records（读端点不强求 actor 头）', async () => {
    const res = await probe.get(STATUS_PATH, READ_AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: {
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastResult: null,
        lastError: null,
        running: false,
        records: RECORDS_STATUS,
      },
    });
  });

  it('POST run：200 = 一轮读数（当前假库全零）；GET 随即可读回同值（attempt/success 为 epoch ms）', async () => {
    const run = await probe.postJson(RUN_PATH, {}, AUTH);

    expect(run.status).toBe(200);
    // C2：POST **完全不变**——响应里没有 records 字段（不跑 records、不改响应）。
    expect(run.body).toEqual({
      code: ErrCode.OK,
      data: { driftAccounts: 0, cacheDriftDeleted: 0, orphanSignupGrants: 0, robotPoolBalance: 0, robotAccountsBalanceSum: 0 },
    });

    const status = await probe.get(STATUS_PATH, READ_AUTH);
    expect(status.status).toBe(200);
    const data = status.body.data;
    expect(typeof data.lastAttemptAt).toBe('number');
    expect(typeof data.lastSuccessAt).toBe('number');
    expect(data.lastResult).toEqual(run.body.data);
    expect(data.lastError).toBeNull();
    expect(data.running).toBe(false);
    expect(data.records).toEqual(RECORDS_STATUS); // 记录对账状态独立于旧对账面
  });

  it('POST 在跑 ⇒ 409 借 10001「对账正在运行」（不叠跑、零新读数）；GET 如实报 running:true；首轮照常收尾', async () => {
    const gate = ctx.db.holdNextDirectQuery();
    const firstPromise = probe.postJson(RUN_PATH, {}, AUTH);
    await vi.waitFor(() => {
      expect(ctx.db.directQueries, '第一轮已进检查①（挂起中）').toHaveLength(1);
    });

    const during = await probe.get(STATUS_PATH, READ_AUTH);
    expect(during.body.data.running).toBe(true);
    expect(during.body.data.records).toEqual(RECORDS_STATUS);

    const second = await probe.postJson(RUN_PATH, {}, AUTH);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ code: ErrCode.BAD_PARAM, message: '对账正在运行', data: null });
    expect(ctx.db.directQueries, '409 不叠跑（零新读数）').toHaveLength(1);

    gate.resolve([]); // 放行第一轮
    const first = await firstPromise;
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toEqual({
      code: ErrCode.OK,
      data: { driftAccounts: 0, cacheDriftDeleted: 0, orphanSignupGrants: 0, robotPoolBalance: 0, robotAccountsBalanceSum: 0 },
    });

    const after = await probe.get(STATUS_PATH, READ_AUTH);
    expect(after.body.data.running).toBe(false);
    expect(after.body.data.lastResult).toEqual(first.body.data);
  });

  it('写方法 actor fail-closed（v1.1.5）：缺 X-Admin / 缺或非法 X-Admin-Actor ⇒ 401，且零读数', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{}, 'admin header required'],
      [{ 'x-admin': '0' }, 'admin header required'],
      [{ 'x-admin': '1' }, '管理身份缺失'],
      [{ 'x-admin': '1', 'x-admin-actor': 'BAD' }, '管理身份缺失'],
    ];

    for (const [headers, message] of cases) {
      const res = await probe.postJson(RUN_PATH, {}, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.body, JSON.stringify(headers)).toEqual({
        code: ErrCode.UNAUTHENTICATED,
        message,
        data: null,
      });
    }
    expect(ctx.db.directQueries, 'guard 拒于 handler 之前：零读数').toHaveLength(0);
  });
});

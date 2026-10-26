/**
 * C2（RecordsReconcileService）测试。
 *
 * Task 1 判据：13 个指标名 + 5 条 SQL 全文（测试侧独立誊写，禁 import 实现文本作断言）。
 * Task 2 判据（spec v4 §5.7 / plan Task 2）：只读事务 RR/会话复位/keyset 分页（player_id）/
 * 四态宽限（pending/orphan/missing/null）/金额五面（flow/玩家/符号/幅度/守恒）/台费七态/
 * 跨界/旧标签/分页/截断/超时 abort/轮次；**库零写**。
 *
 * ⚠️ 假 DB 按 SQL **全文相等**识别（实现漂移一个字符 ⇒ 未识别 reject）；时间轴用 fake timers
 * 固定（`NOW`），所有年龄边界可精确到 1ms。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { metricsRegistry } from '@fight-the-landlord/shared';
// 副作用导入：让 metrics 模块在 shared registry 上完成注册（本测试只读名字）。
import '../src/metrics/currency.metrics';
import {
  RECORDS_RECONCILE_ENTRY_FEE_ORPHAN_GRACE_MS,
  RECORDS_RECONCILE_FIRST_RUN_DELAY_MS,
  RECORDS_RECONCILE_NULL_GRACE_MS,
  RECORDS_RECONCILE_OP_GRACE_MS,
  RECORDS_RECONCILE_ORPHAN_GRACE_MS,
  RECORDS_RECONCILE_PAIR_MARGIN_MS,
  RECORDS_RECONCILE_TARGET_WINDOW_MS,
  RecordsReconcileService,
  RecordsReconcileTimeoutError,
  RecordsReconcileTruncatedError,
  type RecordsReconcileCounts,
} from '../src/reconcile/records-reconcile.service';
import { ReconcileInFlightError } from '../src/reconcile/reconcile.service';
import type { ConfigCacheService } from '../src/config/config-cache.service';
import {
  RECORDS_RECONCILE_DDZ_SQL,
  RECORDS_RECONCILE_FLOWS_SQL,
  RECORDS_RECONCILE_OPS_SQL,
  RECORDS_RECONCILE_PDK_SQL,
  RECORDS_RECONCILE_SKIPS_SQL,
} from '../src/reconcile/records-reconcile.sql';
import {
  currencyRecordsReconcileAmountMismatch,
  currencyRecordsReconcileConfigUnavailable,
  currencyRecordsReconcileEntryFeeOrphanOps,
  currencyRecordsReconcileEntryFeeSuspect,
  currencyRecordsReconcileEntryFeeUnknown,
  currencyRecordsReconcileLastSuccessTimestampSeconds,
  currencyRecordsReconcileMissingOps,
  currencyRecordsReconcileNullMoneyDelta,
  currencyRecordsReconcileNullNoOp,
  currencyRecordsReconcileOrphanOps,
  currencyRecordsReconcilePending,
  currencyRecordsReconcileRunsTotal,
  currencyRecordsReconcileTruncated,
} from '../src/metrics/currency.metrics';
import { AppModule } from '../src/app.module';
import { FakeCurrencyDb } from './helpers/fake-currency-db';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

/* ================================================================== *
 * Task 2：服务行为
 * ================================================================== */

interface MetricLike {
  get(): Promise<{
    values: Array<{ value: number; labels: Partial<Record<string, string | number>> }>;
  }>;
}

async function metricValue(metric: MetricLike, labels?: Record<string, string>): Promise<number> {
  const { values } = await metric.get();
  return values
    .filter(
      (v) =>
        labels === undefined ||
        Object.entries(labels).every(([name, expected]) => String(v.labels[name]) === expected),
    )
    .reduce((sum, v) => sum + v.value, 0);
}

type Game = 'doudizhu' | 'paodekuai';

/** 逐玩法 10 个 gauge 的断言（缺省 0 —— 成功轮会 set 全部，含 0）。 */
async function expectGameGauges(
  gameType: Game,
  expected: Partial<Omit<RecordsReconcileCounts, 'configUnavailable'>> & { configUnavailable?: 0 | 1 },
): Promise<void> {
  const get = (m: MetricLike): Promise<number> => metricValue(m, { game_type: gameType });
  expect(await get(currencyRecordsReconcileOrphanOps), `${gameType} orphan_ops`).toBe(
    expected.orphanOps ?? 0,
  );
  expect(await get(currencyRecordsReconcileMissingOps), `${gameType} missing_ops`).toBe(
    expected.missingOps ?? 0,
  );
  expect(await get(currencyRecordsReconcileNullNoOp), `${gameType} null_no_op`).toBe(
    expected.nullNoOp ?? 0,
  );
  expect(await get(currencyRecordsReconcileAmountMismatch), `${gameType} amount_mismatch`).toBe(
    expected.amountMismatch ?? 0,
  );
  expect(await get(currencyRecordsReconcilePending), `${gameType} pending`).toBe(
    expected.pending ?? 0,
  );
  expect(await get(currencyRecordsReconcileNullMoneyDelta), `${gameType} null_money_delta`).toBe(
    expected.nullMoneyDelta ?? 0,
  );
  expect(await get(currencyRecordsReconcileEntryFeeSuspect), `${gameType} entry_fee_suspect`).toBe(
    expected.entryFeeSuspect ?? 0,
  );
  expect(await get(currencyRecordsReconcileEntryFeeUnknown), `${gameType} entry_fee_unknown`).toBe(
    expected.entryFeeUnknown ?? 0,
  );
  expect(await get(currencyRecordsReconcileEntryFeeOrphanOps), `${gameType} entry_fee_orphan`).toBe(
    expected.entryFeeOrphanOps ?? 0,
  );
  expect(await get(currencyRecordsReconcileConfigUnavailable), `${gameType} config_unavailable`).toBe(
    expected.configUnavailable ?? 0,
  );
}

type Percents = readonly { baseScore: number; percent: number }[] | null;

function makeCache(
  percents: { doudizhu?: Percents; paodekuai?: Percents } = {},
): { cache: ConfigCacheService; entryFeePercents: ReturnType<typeof vi.fn> } {
  // ⚠️ 不用 `??`：`null` 是**合法入参**（配置不可用），只有 `undefined` 才回落默认 `[]`。
  const entryFeePercents = vi.fn((gameType: Game) =>
    percents[gameType] === undefined ? [] : percents[gameType],
  );
  const cache = {
    entryFeePercents,
    reconcileIntervalMs: () => 3_600_000,
    hasSnapshot: () => true,
    waitForFirstSnapshot: () => Promise.resolve(),
  } as unknown as ConfigCacheService;
  return { cache, entryFeePercents };
}

const USERS = ['u-alice', 'u-bob', 'u-carol'] as const;

interface SeedGoldGameOptions {
  gameType?: Game;
  /** settle op 的 game_type（旧 PDK op 标 ddz 的兼容面）。 */
  opGameType?: Game;
  room?: string;
  version?: number;
  endedAt?: number;
  /** settle op 的 created_at。 */
  createdAt?: number;
  refId?: string;
  mode?: string;
  baseScore?: number;
  deltas?: [number, number, number];
  scoreChanges?: [number, number, number];
  moneyDeltas?: [number | null, number | null, number | null];
  burn?: { residue: number | null; rake: number | null };
  seedRecord?: boolean;
  seedSettleOp?: boolean;
  seedSettleFlows?: boolean;
  settleFlows?: Array<{ ownerId: string; ownerType?: string; delta: number; balanceAfter?: number }>;
  fee?: 'op' | 'skip' | 'none';
  feeGameType?: Game;
  skipGameType?: Game;
  feeDelta?: number;
  feeCreatedAt?: number;
}

let roomSeq = 0;

/** 种一局（默认 = 完全一致的金币局：settle op + 3 flows + 记录 + 3 条台费 op）。 */
function seedGoldGame(
  db: FakeCurrencyDb,
  opts: SeedGoldGameOptions = {},
): { room: string; version: number; endedAt: number; createdAt: number; recordId: number | null; opId: number | null } {
  const gameType = opts.gameType ?? 'doudizhu';
  const room = opts.room ?? `room-${++roomSeq}`;
  const version = opts.version ?? 1;
  const endedAt = opts.endedAt ?? NOW - HOUR;
  const createdAt = opts.createdAt ?? endedAt + 5 * MINUTE;
  const deltas = opts.deltas ?? [150, -100, -50];
  const scoreChanges = opts.scoreChanges ?? [200, -120, -80];
  const moneyDeltas = opts.moneyDeltas ?? deltas;
  const burn = opts.burn ?? { residue: 0, rake: 0 };

  let recordId: number | null = null;
  if (opts.seedRecord !== false) {
    recordId = db.seedRecord({
      gameType,
      roomCode: room,
      gameVersion: version,
      mode: opts.mode ?? 'gold',
      baseScore: opts.baseScore ?? 15,
      endedAt,
      players: USERS.map((userId, seat) => ({
        seat,
        userId,
        moneyDelta: moneyDeltas[seat]!,
        scoreChange: scoreChanges[seat]!,
      })),
    });
  }

  let opId: number | null = null;
  if (opts.seedSettleOp !== false) {
    const flows =
      opts.settleFlows ??
      (opts.seedSettleFlows === false
        ? []
        : USERS.map((ownerId, seat) => ({
            ownerId,
            ownerType: 'user',
            delta: deltas[seat]!,
            balanceAfter: 1_000 + deltas[seat]!,
          })));
    opId = db.seedCommittedOp(
      {
        actionId: `settle:${room}:${version}`,
        requestHash: `hash-${room}-${version}`,
        source: 'game_settle',
        gameType: opts.opGameType ?? gameType,
        refId: opts.refId ?? `${room}:${version}`,
        burnedResidue: burn.residue,
        burnedRake: burn.rake,
        createdAt,
      },
      flows,
    );
  }

  const fee = opts.fee ?? (opts.seedRecord !== false && opts.seedSettleOp !== false ? 'op' : 'none');
  const feeCreatedAt = opts.feeCreatedAt ?? endedAt - 30 * MINUTE;
  if (fee === 'op') {
    for (const ownerId of USERS) {
      db.seedCommittedOp(
        {
          actionId: `entryfee:${room}:${ownerId}`,
          requestHash: `fee-${room}-${ownerId}`,
          source: 'entry_fee',
          gameType: opts.feeGameType ?? gameType,
          refId: room,
          createdAt: feeCreatedAt,
        },
        [{ ownerId, ownerType: 'user', delta: opts.feeDelta ?? -1, balanceAfter: 999 }],
      );
    }
  } else if (fee === 'skip') {
    for (const ownerId of USERS) {
      db.seedSkip({
        roomCode: room,
        ownerId,
        gameType: opts.skipGameType ?? gameType,
        createdAt: feeCreatedAt,
      });
    }
  }

  return { room, version, endedAt, createdAt, recordId, opId };
}

function mkService(
  db: FakeCurrencyDb,
  cache: ConfigCacheService = makeCache().cache,
): RecordsReconcileService {
  return new RecordsReconcileService(db.dataSource as unknown as DataSource, cache);
}

function txStatements(db: FakeCurrencyDb): Array<{ sql: string; params: unknown[] }> {
  return db.txLog.flatMap((tx) => tx.statements);
}

function countStatements(db: FakeCurrencyDb, sql: string): number {
  return txStatements(db).filter((s) => s.sql === sql).length;
}

describe('RecordsReconcileService（C2 Task 2）', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it('注册面（T6 教训）：`RecordsReconcileService` 在 AppModule 的 providers 里', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(RecordsReconcileService);
  });

  it('常量口径（spec v4）：48h 目标窗 / 24h 余量 / 25h·2h 宽限 / 10s 首跑', () => {
    expect(RECORDS_RECONCILE_TARGET_WINDOW_MS).toBe(48 * HOUR);
    expect(RECORDS_RECONCILE_PAIR_MARGIN_MS).toBe(24 * HOUR);
    expect(RECORDS_RECONCILE_ORPHAN_GRACE_MS).toBe(25 * HOUR);
    expect(RECORDS_RECONCILE_OP_GRACE_MS).toBe(2 * HOUR);
    expect(RECORDS_RECONCILE_NULL_GRACE_MS).toBe(2 * HOUR);
    expect(RECORDS_RECONCILE_ENTRY_FEE_ORPHAN_GRACE_MS).toBe(25 * HOUR);
    expect(RECORDS_RECONCILE_FIRST_RUN_DELAY_MS).toBe(10_000);
  });

  it('一致 ddz 局 ⇒ 全 0；RR/会话变量复位/SET 先于首读/参数类型（DATETIME=Date、PDK BIGINT=number）', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db);
    const svc = mkService(db);

    const runsBefore = await metricValue(currencyRecordsReconcileRunsTotal);
    const result = await svc.runOnce();

    expect(result).toMatchObject({
      orphanOps: 0,
      missingOps: 0,
      nullNoOp: 0,
      amountMismatch: 0,
      pending: 0,
      nullMoneyDelta: 0,
      entryFeeSuspect: 0,
      entryFeeUnknown: 0,
      entryFeeOrphanOps: 0,
      configUnavailable: 0,
      truncated: false,
    });
    expect(result.byGame.doudizhu).toMatchObject({ orphanOps: 0, amountMismatch: 0 });
    expect(result.byGame.paodekuai).toMatchObject({ orphanOps: 0, amountMismatch: 0 });
    await expectGameGauges('doudizhu', {});
    await expectGameGauges('paodekuai', {});
    expect(await metricValue(currencyRecordsReconcileTruncated)).toBe(0);
    expect(await metricValue(currencyRecordsReconcileLastSuccessTimestampSeconds)).toBe(NOW / 1000);

    // 面板状态
    const status = svc.getStatus();
    expect(status.lastAttemptAt).toBe(NOW);
    expect(status.lastSuccessAt).toBe(NOW);
    expect(status.lastResult).toEqual(result);
    expect(status.lastError).toBeNull();
    expect(status.running).toBe(false);

    // runs_total 每轮开始 +1
    expect(await metricValue(currencyRecordsReconcileRunsTotal)).toBe(runsBefore + 1);

    // 事务契约
    expect(db.txIsolations).toEqual(['REPEATABLE READ']);
    expect(db.txLog).toHaveLength(1);
    expect(db.txLog[0]!.committed).toBe(true);
    const stmts = txStatements(db);
    expect(stmts.slice(0, 3).map((s) => s.sql)).toEqual([
      'SET SESSION max_execution_time = 30000',
      'SET SESSION lock_wait_timeout = 30',
      'SET SESSION innodb_lock_wait_timeout = 30',
    ]);
    expect(stmts.slice(-3).map((s) => s.sql)).toEqual([
      'SET SESSION max_execution_time = DEFAULT',
      'SET SESSION lock_wait_timeout = DEFAULT',
      'SET SESSION innodb_lock_wait_timeout = DEFAULT',
    ]);
    // SET 三条先于首读
    const firstSelect = stmts.findIndex((s) => s.sql.startsWith('SELECT'));
    expect(stmts.slice(0, firstSelect).every((s) => s.sql.startsWith('SET SESSION'))).toBe(true);
    // 库零写：事务里只有 SELECT / SET SESSION
    expect(stmts.every((s) => /^(SELECT|SET SESSION)\b/.test(s.sql))).toBe(true);

    // 参数类型：ops/flows/ddz/skips = Date；pdk = number（BIGINT epoch ms）
    const opsStmt = stmts.find((s) => s.sql === RECORDS_RECONCILE_OPS_SQL)!;
    expect(opsStmt.params[0]).toBeInstanceOf(Date);
    expect(opsStmt.params[1]).toBeInstanceOf(Date);
    expect(typeof opsStmt.params[2]).toBe('number');
    expect(typeof opsStmt.params[3]).toBe('number');
    const ddzStmt = stmts.find((s) => s.sql === RECORDS_RECONCILE_DDZ_SQL)!;
    expect(ddzStmt.params[0]).toBeInstanceOf(Date);
    const pdkStmt = stmts.find((s) => s.sql === RECORDS_RECONCILE_PDK_SQL)!;
    expect(typeof pdkStmt.params[0]).toBe('number');
    expect(typeof pdkStmt.params[1]).toBe('number');
    const skipStmt = stmts.find((s) => s.sql === RECORDS_RECONCILE_SKIPS_SQL)!;
    expect(skipStmt.params[0]).toBeInstanceOf(Date);
  });

  it('一致 pdk 局 ⇒ 全 0（按玩法分桶）', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, { gameType: 'paodekuai', room: 'pdk-ok' });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result).toMatchObject({ orphanOps: 0, amountMismatch: 0, missingOps: 0 });
    expect(result.byGame.paodekuai).toMatchObject({ orphanOps: 0, amountMismatch: 0 });
    await expectGameGauges('paodekuai', {});
  });

  it('🔴 PDK BIGINT ended_at 以字符串返回（TypeORM bigNumberStrings）⇒ 记录侧判定仍工作', async () => {
    // 真实驱动（mysql2 + TypeORM 默认 bigNumberStrings=true）把 BIGINT 读成数字字符串；
    // `Date.parse('1793…')` 恒 NaN ⇒ 记录侧/台费侧会永久失明。本用例用 faithful 假形态钉住。
    const db = new FakeCurrencyDb();
    seedGoldGame(db, {
      gameType: 'paodekuai',
      seedSettleOp: false,
      fee: 'none',
      room: 'pdk-bigint-string',
      endedAt: NOW - 3 * HOUR,
    });
    const svc = mkService(db, makeCache({ paodekuai: null }).cache);
    const result = await svc.runOnce();
    expect(result.missingOps).toBe(1);
    expect(result.byGame.paodekuai.missingOps).toBe(1);
    expect(result.byGame.paodekuai.configUnavailable).toBe(1);
    expect(result.orphanOps).toBe(0);
  });

  it('ddz 与 pdk 同 room:version ⇒ 按 gameType key 精确配对，不互串（旧标签兼容不误报）', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, { gameType: 'doudizhu', room: 'same-key', version: 7, fee: 'skip' });
    seedGoldGame(db, { gameType: 'paodekuai', room: 'same-key', version: 7, fee: 'skip' });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result).toMatchObject({ orphanOps: 0, missingOps: 0, amountMismatch: 0, nullNoOp: 0 });
  });

  it('旧 PDK settle op 标 ddz（room:version 唯一）⇒ 兼容配对到 pdk 记录，不报孤儿/缺失', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, {
      gameType: 'paodekuai',
      opGameType: 'doudizhu',
      room: 'old-pdk',
      fee: 'skip',
    });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result).toMatchObject({ orphanOps: 0, missingOps: 0, amountMismatch: 0, pending: 0 });
    expect(result.byGame.paodekuai.orphanOps).toBe(0);
  });

  it('op 无记录：<25h pending；≥25h orphan（边界 25h 归 orphan）', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, {
      seedRecord: false,
      fee: 'none',
      createdAt: NOW - (25 * HOUR - 1),
    });
    seedGoldGame(db, {
      seedRecord: false,
      fee: 'none',
      createdAt: NOW - 25 * HOUR,
    });
    seedGoldGame(db, {
      seedRecord: false,
      fee: 'none',
      createdAt: NOW - (25 * HOUR + 1),
    });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.pending).toBe(1);
    expect(result.orphanOps).toBe(2);
    await expectGameGauges('doudizhu', { pending: 1, orphanOps: 2 });
  });

  it('记录无 op：≤2h pending；>2h 非零 ⇒ missing；任一 NULL 无非零 ⇒ nullNoOp；全 0 跳过', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, {
      seedSettleOp: false,
      fee: 'skip',
      endedAt: NOW - (2 * HOUR - 1),
      room: 'rec-pending',
    });
    seedGoldGame(db, {
      seedSettleOp: false,
      fee: 'skip',
      endedAt: NOW - (2 * HOUR + 1),
      room: 'rec-missing',
    });
    seedGoldGame(db, {
      seedSettleOp: false,
      fee: 'skip',
      endedAt: NOW - (2 * HOUR + 1),
      room: 'rec-null-mixed',
      moneyDeltas: [null, 0, 0],
    });
    seedGoldGame(db, {
      seedSettleOp: false,
      fee: 'skip',
      endedAt: NOW - (2 * HOUR + 1),
      room: 'rec-all-null',
      moneyDeltas: [null, null, null],
    });
    seedGoldGame(db, {
      seedSettleOp: false,
      fee: 'skip',
      endedAt: NOW - (2 * HOUR + 1),
      room: 'rec-all-zero',
      deltas: [0, 0, 0],
      scoreChanges: [0, 0, 0],
    });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.pending).toBe(1);
    expect(result.missingOps).toBe(1);
    expect(result.nullNoOp).toBe(2);
    await expectGameGauges('doudizhu', { pending: 1, missingOps: 1, nullNoOp: 2 });
  });

  it('money_delta NULL（有 op）：op 年龄 ≤2h pending；>2h nullMoneyDelta（不判金额不一致）', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, {
      room: 'null-pending',
      endedAt: NOW - 2 * HOUR,
      createdAt: NOW - (2 * HOUR - 1),
      moneyDeltas: [null, -100, -50],
      fee: 'skip',
    });
    seedGoldGame(db, {
      room: 'null-late',
      endedAt: NOW - 3 * HOUR,
      createdAt: NOW - (2 * HOUR + 1),
      moneyDeltas: [null, -100, -50],
      fee: 'skip',
    });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.pending).toBe(1);
    expect(result.nullMoneyDelta).toBe(1);
    expect(result.amountMismatch).toBe(0);
    await expectGameGauges('doudizhu', { pending: 1, nullMoneyDelta: 1 });
  });

  it('金额五面：flow≠money_delta / 无玩家行 / 非零无 flow / 符号幅度 / 守恒', async () => {
    const db = new FakeCurrencyDb();
    // ① flow 与 money_delta 不等
    seedGoldGame(db, {
      room: 'm-delta',
      fee: 'skip',
      settleFlows: [
        { ownerId: USERS[0], delta: 151 },
        { ownerId: USERS[1], delta: -100 },
        { ownerId: USERS[2], delta: -50 },
      ],
    });
    // ② flow owner 在记录里没有玩家行
    seedGoldGame(db, {
      room: 'm-owner',
      fee: 'skip',
      settleFlows: [
        { ownerId: USERS[0], delta: 150 },
        { ownerId: USERS[1], delta: -100 },
        { ownerId: USERS[2], delta: -50 },
        { ownerId: 'u-ghost', delta: 0 },
      ],
    });
    // ③ 非零 money_delta 无 flow
    seedGoldGame(db, {
      room: 'm-missing-flow',
      fee: 'skip',
      settleFlows: [
        { ownerId: USERS[0], delta: 150 },
        { ownerId: USERS[1], delta: -100 },
      ],
    });
    // ④ 赢家 score_change < delta
    seedGoldGame(db, {
      room: 'm-win-bound',
      fee: 'skip',
      scoreChanges: [100, -120, -80],
    });
    // ⑤ 输家 score_change > delta
    seedGoldGame(db, {
      room: 'm-lose-bound',
      fee: 'skip',
      scoreChanges: [200, -50, -80],
    });
    // ⑥ 守恒（sum + residue + rake ≠ 0）
    seedGoldGame(db, {
      room: 'm-conservation',
      fee: 'skip',
      burn: { residue: 10, rake: 10 },
    });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.amountMismatch).toBe(6);
    await expectGameGauges('doudizhu', { amountMismatch: 6 });
  });

  it('日志聚合：每桶最多 3 条样例 room/version（一行/玩法，不逐条刷屏）', async () => {
    const db = new FakeCurrencyDb();
    for (let i = 0; i < 4; i += 1) {
      seedGoldGame(db, {
        seedSettleOp: false,
        fee: 'skip',
        room: `sample-${i}`,
        endedAt: NOW - 3 * HOUR,
      });
    }
    const svc = mkService(db);
    await svc.runOnce();
    const lines = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((message) => message.includes('records reconcile samples doudizhu'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sample-0');
    expect(lines[0]).not.toContain('sample-3'); // 第 4 条不进样例（每桶上限 3）
  });

  it('守恒：burn 任一 NULL ⇒ 跳过（不误报）；mode 非 gold 的 settle op ⇒ mismatch', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, {
      room: 'burn-null',
      fee: 'skip',
      burn: { residue: null, rake: null },
    });
    seedGoldGame(db, {
      room: 'non-gold-op',
      fee: 'none',
      mode: 'friend',
    });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.amountMismatch).toBe(1); // 仅 non-gold
  });

  it('ref 畸形 ⇒ 仅目标窗内的 op 计 mismatch（窗口外不报）', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, {
      seedRecord: false,
      fee: 'none',
      room: 'bad-ref-in',
      refId: 'no-colon',
      createdAt: NOW - HOUR,
    });
    seedGoldGame(db, {
      seedRecord: false,
      fee: 'none',
      room: 'bad-ref-out',
      refId: 'no-colon',
      createdAt: NOW - RECORDS_RECONCILE_TARGET_WINDOW_MS - MINUTE,
    });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.amountMismatch).toBe(1);
  });

  it('台费：有 op 以流水为历史事实（不比当前费额）/ skip 通过', async () => {
    const db = new FakeCurrencyDb();
    const actual = seedGoldGame(db, { room: 'fee-op', feeDelta: -1 });
    seedGoldGame(db, { room: 'fee-skip', fee: 'skip' });
    const svc = mkService(db, makeCache({ doudizhu: [{ baseScore: 15, percent: 100 }] }).cache);
    const result = await svc.runOnce();
    expect(actual.room).toBe('fee-op');
    expect(result.entryFeeSuspect).toBe(0);
    expect(result.entryFeeUnknown).toBe(0);
    expect(result.amountMismatch).toBe(0);
  });

  it('台费都无：当前费率 >0 ⇒ suspect；fee=0/档位缺失 ⇒ unknown；percents=null ⇒ configUnavailable', async () => {
    // 记录正常结算（settle op 一致），只留「没有台费 op / skip」这一个变量。
    const seedRecordOnly = (room: string): FakeCurrencyDb => {
      const db = new FakeCurrencyDb();
      seedGoldGame(db, { room, fee: 'none' });
      return db;
    };

    const suspect = mkService(
      seedRecordOnly('fee-suspect'),
      makeCache({ doudizhu: [{ baseScore: 15, percent: 10 }] }).cache,
    );
    const suspectResult = await suspect.runOnce();
    expect(suspectResult.entryFeeSuspect).toBe(3);
    expect(suspectResult.entryFeeUnknown).toBe(0);
    expect(suspectResult.configUnavailable).toBe(0);

    // fee=0（档位存在但费率为 0）⇒ unknown
    const unknownZero = mkService(
      seedRecordOnly('fee-zero'),
      makeCache({ doudizhu: [{ baseScore: 15, percent: 0 }] }).cache,
    );
    expect((await unknownZero.runOnce()).entryFeeUnknown).toBe(3);

    // 档位缺失（baseScore 不在表内）⇒ entryFeeOf=0 ⇒ unknown
    const unknownMissing = mkService(
      seedRecordOnly('fee-level-missing'),
      makeCache({ doudizhu: [{ baseScore: 80, percent: 10 }] }).cache,
    );
    const unknownResult = await unknownMissing.runOnce();
    expect(unknownResult.entryFeeSuspect).toBe(0);
    expect(unknownResult.entryFeeUnknown).toBe(3);
    expect(unknownResult.configUnavailable).toBe(0);

    const unavailable = mkService(seedRecordOnly('fee-cfg'), makeCache({ doudizhu: null }).cache);
    const unavailableResult = await unavailable.runOnce();
    expect(unavailableResult.entryFeeSuspect).toBe(0);
    expect(unavailableResult.entryFeeUnknown).toBe(0);
    expect(unavailableResult.configUnavailable).toBe(1);
    expect(unavailableResult.byGame.doudizhu.configUnavailable).toBe(1);
    await expectGameGauges('doudizhu', { configUnavailable: 1 });
  });

  it('percents=null 但全部有 op/skip ⇒ 不触发 configUnavailable（按需读取）', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, { room: 'cfg-op', fee: 'op' });
    seedGoldGame(db, { room: 'cfg-skip', fee: 'skip' });
    const svc = mkService(db, makeCache({ doudizhu: null }).cache);
    const result = await svc.runOnce();
    expect(result.configUnavailable).toBe(0);
    expect(result.entryFeeSuspect).toBe(0);
    expect(result.entryFeeUnknown).toBe(0);
  });

  it('台费 op 无记录：≤25h pending（含恰 25h）；>25h entryFeeOrphanOps', async () => {
    const db = new FakeCurrencyDb();
    db.seedCommittedOp(
      {
        actionId: 'entryfee:fee-old-24:u-x',
        requestHash: 'h1',
        source: 'entry_fee',
        gameType: 'doudizhu',
        refId: 'fee-old-24',
        createdAt: NOW - (25 * HOUR - 1),
      },
      [],
    );
    db.seedCommittedOp(
      {
        actionId: 'entryfee:fee-old-25:u-x',
        requestHash: 'h2',
        source: 'entry_fee',
        gameType: 'doudizhu',
        refId: 'fee-old-25',
        createdAt: NOW - 25 * HOUR,
      },
      [],
    );
    db.seedCommittedOp(
      {
        actionId: 'entryfee:fee-old-26:u-x',
        requestHash: 'h3',
        source: 'entry_fee',
        gameType: 'doudizhu',
        refId: 'fee-old-26',
        createdAt: NOW - (25 * HOUR + 1),
      },
      [],
    );
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.pending).toBe(2);
    expect(result.entryFeeOrphanOps).toBe(1);
  });

  it('台费 op：flow 面异常（0 条 / 2 条 / owner 不符 / delta≥0）⇒ amountMismatch', async () => {
    const db = new FakeCurrencyDb();
    const { room } = seedGoldGame(db, { room: 'fee-flow', fee: 'none' });
    const feeOp = (owner: string, flows: Array<{ ownerId: string; delta: number }>) =>
      db.seedCommittedOp(
        {
          actionId: `entryfee:${room}:${owner}`,
          requestHash: `fee-flow-${owner}`,
          source: 'entry_fee',
          gameType: 'doudizhu',
          refId: room,
          createdAt: NOW - 30 * MINUTE,
        },
        flows,
      );
    feeOp(USERS[0], []);
    feeOp(USERS[1], [
      { ownerId: USERS[1], delta: -1 },
      { ownerId: USERS[1], delta: -1 },
    ]);
    feeOp(USERS[2], [{ ownerId: 'u-other', delta: -1 }]);
    const svc = mkService(db, makeCache({ doudizhu: [] }).cache);
    const result = await svc.runOnce();
    // 3 个真人座各一条台费 op；三条流水面都异常 ⇒ 3 条 mismatch（U2 的 owner 不符）
    expect(result.amountMismatch).toBe(3);
  });

  it('台费 op：delta=0 ⇒ mismatch（不要求正负号的不是台费）', async () => {
    const db = new FakeCurrencyDb();
    const { room } = seedGoldGame(db, { room: 'fee-zero-delta', fee: 'none' });
    db.seedCommittedOp(
      {
        actionId: `entryfee:${room}:${USERS[0]}`,
        requestHash: 'fee-zero-delta',
        source: 'entry_fee',
        gameType: 'doudizhu',
        refId: room,
        createdAt: NOW - 30 * MINUTE,
      },
      [{ ownerId: USERS[0], delta: 0 }],
    );
    const svc = mkService(db, makeCache({ doudizhu: [] }).cache);
    const result = await svc.runOnce();
    expect(result.amountMismatch).toBe(1);
  });

  it('台费 op 有记录但 owner 非真人座 ⇒ mismatch；记录非 gold ⇒ mismatch', async () => {
    const db = new FakeCurrencyDb();
    const { room } = seedGoldGame(db, { room: 'fee-ghost', fee: 'none' });
    db.seedCommittedOp(
      {
        actionId: `entryfee:${room}:u-ghost`,
        requestHash: 'fee-ghost',
        source: 'entry_fee',
        gameType: 'doudizhu',
        refId: room,
        createdAt: NOW - 30 * MINUTE,
      },
      [{ ownerId: 'u-ghost', delta: -1 }],
    );
    const { room: friendRoom } = seedGoldGame(db, {
      room: 'fee-friend',
      mode: 'friend',
      fee: 'none',
      seedSettleOp: false,
    });
    db.seedCommittedOp(
      {
        actionId: `entryfee:${friendRoom}:${USERS[0]}`,
        requestHash: 'fee-friend',
        source: 'entry_fee',
        gameType: 'doudizhu',
        refId: friendRoom,
        createdAt: NOW - 30 * MINUTE,
      },
      [{ ownerId: USERS[0], delta: -1 }],
    );
    const svc = mkService(db, makeCache({ doudizhu: null }).cache);
    const result = await svc.runOnce();
    expect(result.amountMismatch).toBe(2);
    expect(result.configUnavailable).toBe(1);
  });

  it('台费 action 畸形 ⇒ 仅目标窗内 op 计 mismatch', async () => {
    const db = new FakeCurrencyDb();
    db.seedCommittedOp(
      {
        actionId: 'not-an-entryfee-action',
        requestHash: 'bad-action',
        source: 'entry_fee',
        gameType: 'doudizhu',
        refId: 'bad-room',
        createdAt: NOW - HOUR,
      },
      [],
    );
    db.seedCommittedOp(
      {
        actionId: 'not-an-entryfee-action-out',
        requestHash: 'bad-action-out',
        source: 'entry_fee',
        gameType: 'doudizhu',
        refId: 'bad-room-out',
        createdAt: NOW - RECORDS_RECONCILE_TARGET_WINDOW_MS - MINUTE,
      },
      [],
    );
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.amountMismatch).toBe(1);
  });

  it('旧 PDK 标签：台费 op / skip 标 ddz 仍能命中 pdk 记录（不误报 suspect）', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, {
      gameType: 'paodekuai',
      room: 'pdk-fee-legacy',
      fee: 'op',
      feeGameType: 'doudizhu',
    });
    seedGoldGame(db, {
      gameType: 'paodekuai',
      room: 'pdk-skip-legacy',
      fee: 'skip',
      skipGameType: 'doudizhu',
    });
    const svc = mkService(db, makeCache({ paodekuai: [{ baseScore: 15, percent: 10 }] }).cache);
    const result = await svc.runOnce();
    expect(result.entryFeeSuspect).toBe(0);
    expect(result.entryFeeUnknown).toBe(0);
  });

  it('skip 按玩法分桶：pdk skip 不能免掉 ddz 记录的台费检查', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, {
      gameType: 'doudizhu',
      room: 'ddz-with-pdk-skip',
      fee: 'skip',
      skipGameType: 'paodekuai',
    });
    const svc = mkService(db, makeCache({ doudizhu: [{ baseScore: 15, percent: 10 }] }).cache);
    const result = await svc.runOnce();
    expect(result.entryFeeSuspect).toBe(3);
    expect(result.byGame.doudizhu.entryFeeSuspect).toBe(3);
  });

  it('分页：3 人局 pageSize=2 ⇒ 跨页聚合仍 3 行（按 player_id，不切记录）', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, { room: 'page-3p' });
    const svc = mkService(db);
    const result = await svc.runOnce({ pageSize: 2 });
    expect(result).toMatchObject({ amountMismatch: 0, missingOps: 0, nullMoneyDelta: 0 });
    expect(countStatements(db, RECORDS_RECONCILE_DDZ_SQL)).toBe(2); // 2 行满页 + 1 行尾页
  });

  it('分页：5,001 条 ops ⇒ 两页消费完（不漏行）', async () => {
    const db = new FakeCurrencyDb();
    for (let i = 0; i < 5_001; i += 1) {
      db.seedCommittedOp(
        {
          actionId: `settle:bulk-${i}:1`,
          requestHash: `bulk-${i}`,
          source: 'game_settle',
          gameType: 'doudizhu',
          refId: `bulk-${i}:1`,
          createdAt: NOW - 26 * HOUR,
        },
        [],
      );
    }
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.orphanOps).toBe(5_001);
    expect(countStatements(db, RECORDS_RECONCILE_OPS_SQL)).toBe(2);
  });

  it('单查询超 maxTotalRows（可注入）⇒ TruncatedError + truncated=1 + last_success 不推进', async () => {
    const db = new FakeCurrencyDb();
    for (let i = 0; i < 3; i += 1) {
      db.seedCommittedOp(
        {
          actionId: `settle:trunc-${i}:1`,
          requestHash: `trunc-${i}`,
          source: 'game_settle',
          gameType: 'doudizhu',
          refId: `trunc-${i}:1`,
          createdAt: NOW - 26 * HOUR,
        },
        [],
      );
    }
    const svc = mkService(db);
    await expect(svc.runOnce({ pageSize: 2, maxTotalRows: 2 })).rejects.toBeInstanceOf(
      RecordsReconcileTruncatedError,
    );
    expect(await metricValue(currencyRecordsReconcileTruncated)).toBe(1);
    expect(svc.getStatus().lastSuccessAt).toBeNull();
    expect(svc.getStatus().lastError).toContain('2');

    // 下一轮成功 ⇒ truncated 归 0
    await svc.runOnce();
    expect(await metricValue(currencyRecordsReconcileTruncated)).toBe(0);
  });

  it('查询抛 ⇒ 整轮失败但 finally 仍复位会话变量（同 manager）；下轮可自愈', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, { room: 'fail-mid' });
    const svc = mkService(db);
    db.failNextTxQueryMatching = /^SELECT o\.id/;
    await expect(svc.runOnce()).rejects.toThrow('db down');
    expect(db.txLog[0]!.committed).toBe(false);
    const failedSqls = db.txLog[0]!.statements.map((s) => s.sql);
    expect(failedSqls).toContain('SET SESSION max_execution_time = DEFAULT');
    expect(failedSqls).toContain('SET SESSION lock_wait_timeout = DEFAULT');
    expect(failedSqls).toContain('SET SESSION innodb_lock_wait_timeout = DEFAULT');
    expect(svc.getStatus().lastSuccessAt).toBeNull();
    expect(svc.getStatus().lastError).toContain('db down');

    await svc.runOnce();
    expect(svc.getStatus().lastSuccessAt).toBe(NOW);
  });

  it('缺表 1146 ⇒ 整轮失败 + 明确部署顺序日志 + last_success 不推进（D18）', async () => {
    const db = new FakeCurrencyDb();
    const svc = mkService(db);
    db.failNextTxQueryMatching = /^SELECT p\.id/;
    db.failNextTxQueryError = Object.assign(
      new Error("Table 'fight_the_landlord.game_records' doesn't exist"),
      { code: 'ER_NO_SUCH_TABLE', errno: 1146 },
    );
    await expect(svc.runOnce()).rejects.toThrow("doesn't exist");
    expect(svc.getStatus().lastSuccessAt).toBeNull();
    expect(svc.getStatus().lastError).toContain("doesn't exist");
    expect(
      errorSpy.mock.calls.some(
        (args) => String(args[0]).includes('缺表（1146）') && String(args[0]).includes('部署'),
      ),
    ).toBe(true);
  });

  it('SET 自身失败也必复位（SET 在 try 内）——防会话变量泄漏到连接上的下一轮', async () => {
    const db = new FakeCurrencyDb();
    const svc = mkService(db);
    db.failNextTxQueryMatching = /^SET SESSION max_execution_time = 30000$/;
    await expect(svc.runOnce()).rejects.toThrow('db down');
    const sqls = db.txLog[0]!.statements.map((s) => s.sql);
    expect(sqls).not.toContain(RECORDS_RECONCILE_OPS_SQL);
    expect(sqls).toContain('SET SESSION max_execution_time = DEFAULT');
    expect(sqls).toContain('SET SESSION lock_wait_timeout = DEFAULT');
    expect(sqls).toContain('SET SESSION innodb_lock_wait_timeout = DEFAULT');
  });

  it('轮级超时 ⇒ abort：不写 gauge、last_success 不推进；inFlight 待事务 settle 后才清（不重叠）', async () => {
    let release!: () => void;
    const transaction = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const ds = { transaction } as unknown as DataSource;
    const svc = new RecordsReconcileService(ds, makeCache().cache);

    // 预置可辨识的 gauge：超时轮不得覆盖
    const { setGame } = await import('@fight-the-landlord/shared');
    setGame(currencyRecordsReconcileOrphanOps, 'doudizhu', 7);
    currencyRecordsReconcileTruncated.set(1);

    const pending = svc.runOnce({ timeoutMs: 100 });
    const settled = pending.then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(100);
    const err = await settled;
    expect(err).toBeInstanceOf(RecordsReconcileTimeoutError);
    expect(await metricValue(currencyRecordsReconcileOrphanOps, { game_type: 'doudizhu' })).toBe(7);
    expect(await metricValue(currencyRecordsReconcileTruncated)).toBe(1);
    expect(svc.getStatus().lastSuccessAt).toBeNull();
    expect(svc.getStatus().running).toBe(true); // 事务还没 settle

    // 在途闸：超时后、事务 settle 前，下一轮不得叠跑
    await expect(svc.runOnce()).rejects.toBeInstanceOf(ReconcileInFlightError);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.getStatus().running).toBe(false);
  });

  it('跨界：窗口外 1ms 不计；from 恰在窗内（含）；to 恰在窗外（不含）', async () => {
    const db = new FakeCurrencyDb();
    const from = NOW - RECORDS_RECONCILE_TARGET_WINDOW_MS;
    // op 在窗口外（ref 也畸形 ⇒ 不得报）
    seedGoldGame(db, {
      seedRecord: false,
      fee: 'none',
      room: 'edge-op-out',
      refId: 'no-colon',
      createdAt: from - 1,
    });
    // op 恰在 from ⇒ orphan
    seedGoldGame(db, {
      seedRecord: false,
      fee: 'none',
      room: 'edge-op-in',
      createdAt: from,
    });
    // 记录在窗口外 ⇒ 不报
    seedGoldGame(db, {
      seedSettleOp: false,
      fee: 'skip',
      room: 'edge-rec-out',
      endedAt: from - 1,
    });
    // 记录恰在 from ⇒ missing（年龄 >2h）
    seedGoldGame(db, {
      seedSettleOp: false,
      fee: 'skip',
      room: 'edge-rec-in',
      endedAt: from,
    });
    // 记录恰在 to ⇒ 窗外（[from, to)）
    seedGoldGame(db, {
      seedSettleOp: false,
      fee: 'skip',
      room: 'edge-rec-to',
      endedAt: NOW,
    });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.orphanOps).toBe(1);
    expect(result.missingOps).toBe(1);
  });

  it('配对余量：op 在目标窗外、记录在窗内（及反向）⇒ 正常配对，不误报孤儿/缺失', async () => {
    const db = new FakeCurrencyDb();
    // op 早于窗口 30m，记录晚于窗口起点 1h（均在查询余量内）
    seedGoldGame(db, {
      room: 'margin-op-out',
      createdAt: NOW - RECORDS_RECONCILE_TARGET_WINDOW_MS - 30 * MINUTE,
      endedAt: NOW - (RECORDS_RECONCILE_TARGET_WINDOW_MS - HOUR),
    });
    // op 在窗内、记录早于窗口 1h
    seedGoldGame(db, {
      room: 'margin-rec-out',
      createdAt: NOW - HOUR,
      endedAt: NOW - RECORDS_RECONCILE_TARGET_WINDOW_MS - HOUR,
      feeCreatedAt: NOW - RECORDS_RECONCILE_TARGET_WINDOW_MS - 90 * MINUTE,
    });
    const svc = mkService(db);
    const result = await svc.runOnce();
    expect(result.orphanOps).toBe(0);
    expect(result.missingOps).toBe(0);
    expect(result.pending).toBe(0);
  });

  it('byGame 分桶与 totals 汇总；configUnavailable 总计 = 两玩法 OR', async () => {
    const db = new FakeCurrencyDb();
    // ddz：op 无记录 26h ⇒ orphan
    seedGoldGame(db, {
      seedRecord: false,
      fee: 'none',
      room: 'bygame-ddz-orphan',
      createdAt: NOW - 26 * HOUR,
    });
    // pdk：记录无 op 3h 非零 ⇒ missing；percents null ⇒ configUnavailable(pdk)
    seedGoldGame(db, {
      gameType: 'paodekuai',
      seedSettleOp: false,
      fee: 'none',
      room: 'bygame-pdk-missing',
      endedAt: NOW - 3 * HOUR,
    });
    const svc = mkService(db, makeCache({ paodekuai: null }).cache);
    const result = await svc.runOnce();
    expect(result.orphanOps).toBe(1);
    expect(result.missingOps).toBe(1);
    expect(result.configUnavailable).toBe(1);
    expect(result.byGame.doudizhu).toMatchObject({ orphanOps: 1, configUnavailable: 0 });
    expect(result.byGame.paodekuai).toMatchObject({ missingOps: 1, configUnavailable: 1 });
    await expectGameGauges('doudizhu', { orphanOps: 1, configUnavailable: 0 });
    await expectGameGauges('paodekuai', { missingOps: 1, configUnavailable: 1 });
  });

  it('库零写：一轮前后 ops/flows/skips/records/players 行数与内容不变', async () => {
    const db = new FakeCurrencyDb();
    seedGoldGame(db, { room: 'zero-write-a' });
    seedGoldGame(db, { room: 'zero-write-b', fee: 'skip' });
    const before = {
      ops: JSON.stringify(db.ops),
      flows: JSON.stringify(db.flows),
      skips: JSON.stringify(db.skips),
      records: JSON.stringify(db.records),
      players: JSON.stringify(db.players),
    };
    const svc = mkService(db);
    await svc.runOnce();
    expect(JSON.stringify(db.ops)).toBe(before.ops);
    expect(JSON.stringify(db.flows)).toBe(before.flows);
    expect(JSON.stringify(db.skips)).toBe(before.skips);
    expect(JSON.stringify(db.records)).toBe(before.records);
    expect(JSON.stringify(db.players)).toBe(before.players);
    expect(db.directQueries).toHaveLength(0); // 不走非事务直读
  });

  it('循环：启动置 last_success=0；10s 首跑；1h 自重排；关停后不再排', async () => {
    const db = new FakeCurrencyDb();
    const svc = mkService(db);
    svc.onModuleInit();
    expect(await metricValue(currencyRecordsReconcileLastSuccessTimestampSeconds)).toBe(0);

    await vi.advanceTimersByTimeAsync(RECORDS_RECONCILE_FIRST_RUN_DELAY_MS - 1);
    expect(db.txLog).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.txLog).toHaveLength(1);
    expect(await metricValue(currencyRecordsReconcileLastSuccessTimestampSeconds)).toBe(
      (NOW + RECORDS_RECONCILE_FIRST_RUN_DELAY_MS) / 1000,
    );

    await vi.advanceTimersByTimeAsync(3_600_000 - 1);
    expect(db.txLog).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.txLog).toHaveLength(2);

    svc.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(db.txLog).toHaveLength(2);
  });

  it('首快照未就绪 ⇒ 首跑延后到快照就绪（有界等待内，不带着空配置跑首轮）', async () => {
    const db = new FakeCurrencyDb();
    let resolveSnapshot!: () => void;
    const snapshotReady = new Promise<void>((resolve) => {
      resolveSnapshot = resolve;
    });
    const base = makeCache().cache as unknown as Record<string, unknown>;
    const cache = {
      ...base,
      hasSnapshot: () => false,
      waitForFirstSnapshot: () => snapshotReady,
    } as unknown as ConfigCacheService;
    const svc = new RecordsReconcileService(db.dataSource as unknown as DataSource, cache);
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(db.txLog, '快照未就绪：10s 首跑不得起跑').toHaveLength(0);

    resolveSnapshot();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(RECORDS_RECONCILE_FIRST_RUN_DELAY_MS - 1);
    expect(db.txLog).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.txLog).toHaveLength(1);
    svc.onApplicationShutdown();
  });

  it('循环：失败轮不推进 last_success，下一轮照排并自愈', async () => {
    const db = new FakeCurrencyDb();
    const svc = mkService(db);
    svc.onModuleInit();
    db.failNextTxQueryMatching = /^SELECT o\.id/;

    await vi.advanceTimersByTimeAsync(RECORDS_RECONCILE_FIRST_RUN_DELAY_MS);
    expect(db.txLog).toHaveLength(1);
    expect(db.txLog[0]!.committed).toBe(false);
    expect(svc.getStatus().lastSuccessAt).toBeNull();
    expect(svc.getStatus().lastError).toContain('db down');

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(db.txLog).toHaveLength(2);
    expect(db.txLog[1]!.committed).toBe(true);
    expect(svc.getStatus().lastSuccessAt).toBe(NOW + RECORDS_RECONCILE_FIRST_RUN_DELAY_MS + 3_600_000);
    svc.onApplicationShutdown();
  });
});

/**
 * C2 基准（plan Task 6）：10k/20k 行的一轮（分页 5,000）耗时。
 * 行都在 60h 前（窗外、查询余量内）⇒ 只测「读取+分页+分类」，不产生判据；软时限 5s
 * （spec：>5s 触发优化登记）。用 `process.hrtime`（不被 fake timers 影响）。
 */
describe('C2 基准：10k/20k 一轮耗时', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  function seedBulk(db: FakeCurrencyDb, opsCount: number, recordCount: number): void {
    for (let i = 0; i < opsCount; i += 1) {
      db.seedCommittedOp(
        {
          actionId: `bench-op-${i}`,
          requestHash: `bench-op-${i}`,
          source: 'game_settle',
          gameType: 'doudizhu',
          refId: `bench-room-${i}:1`,
          createdAt: NOW - 60 * HOUR,
        },
        [],
      );
    }
    for (let i = 0; i < recordCount; i += 1) {
      db.seedRecord({
        gameType: 'doudizhu',
        roomCode: `bench-rec-${i}`,
        gameVersion: 1,
        mode: 'gold',
        endedAt: NOW - 60 * HOUR,
        players: [0, 1, 2].map((seat) => ({
          seat,
          userId: `bench-user-${i}-${seat}`,
          moneyDelta: 1,
          scoreChange: 0,
        })),
      });
    }
  }

  async function benchmark(opsCount: number, recordCount: number): Promise<number> {
    const db = new FakeCurrencyDb();
    seedBulk(db, opsCount, recordCount);
    const svc = mkService(db);
    const startedAt = process.hrtime.bigint();
    const result = await svc.runOnce();
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // 窗外 filler 不得产生判据（跑完一圈的完整性自证）。
    expect(result.orphanOps).toBe(0);
    expect(result.missingOps).toBe(0);
    expect(result.pending).toBe(0);
    // 读数进测试输出（plan Task 6：>5s 触发优化登记）。
    // eslint-disable-next-line no-console
    console.log(`C2 benchmark: ${opsCount} ops / ${recordCount} records → ${elapsedMs.toFixed(1)}ms`);
    return elapsedMs;
  }

  it('10k ops + 10k players（3,334 局）一轮 < 15s（软上限；读数入报告，>5s 触发优化登记）', async () => {
    const elapsed = await benchmark(10_000, 3_334);
    expect(elapsed, `10k 基准耗时 ${elapsed.toFixed(1)}ms`).toBeLessThan(15_000);
  });

  it('20k ops + 20k players（6,667 局）一轮 < 15s（软上限；读数入报告，>5s 触发优化登记）', async () => {
    const elapsed = await benchmark(20_000, 6_667);
    expect(elapsed, `20k 基准耗时 ${elapsed.toFixed(1)}ms`).toBeLessThan(15_000);
  });
});

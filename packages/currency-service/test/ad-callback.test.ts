/**
 * 广告小片 T14：**回调业务链**（账本先行 / 落序 / 计数六路径）——本片最核心的一件。
 *
 * ─── 链序契约（规格 §2.4/§2.6/§2.7 + 设计 §2/§4.3；逐段照落，不许「优化」）────────
 *  验签（T13）→ ① read(nonce)（`'read-failure'` ⇒ 瞬态）→ ② 记录 `done` ⇒ 短路
 *  （回调面 accepted；发放面**不计**；200）→ ③ **账本先行**（`ledgerExists(relief:{userId}:{date})`
 *  ⇒ `markDone('replayed')`；发放面 replayed；accepted）→ ④ 正向裁决（快照缺 ⇒ 瞬态【不落 done】；
 *  开关关 ⇒ `markDone('disabled')` ⇒ rejected；余额 ≥ 门槛 ⇒ `markDone('balance_ok')` ⇒ rejected）
 *  → ⑤ apply（`actionId = relief:{userId}:{date}`，**内嵌 claim 签发日**——不看回调处理时刻，
 *  设计 §3 口径）：granted ⇒ **立即计 granted** ⇒ `markDone('granted')`；replayed/14002 ⇒
 *  计 replayed ⇒ `markDone('replayed')`。
 *
 * ─── 计数六路径（§2.7 表；一回调在**回调面**恰入一桶、**发放面**只记真实裁决）────────
 *  ① done 短路 ⇒ 回调面 accepted / 发放面不计        ② 账本先行 ⇒ accepted / replayed
 *  ③ 正向拒绝 ⇒ accepted / rejected                  ④ apply granted ⇒ accepted / granted
 *  ⑤ apply replay / 14002 ⇒ accepted / replayed       ⑥ 瞬态 ⇒ error / 不计
 *
 * ─── 判据来源与形态 ────────────────────────────────────────────────────────
 *  - 落序两注入（设计 §7 逐字）：(a) apply 抛错 ⇒ 保持 issued + 5xx（`transient`），重投 ⇒
 *    发放且落 `done:granted`；(b) **apply 已提交但记录写失败** ⇒ 重投走**账本先行** ⇒ replayed、
 *    `done:replayed`、金额不再增。
 *  - 夹具：**真** `ClaimService`/`ApplyService`/`GetService` + `FakeRedis`/`FakeCurrencyDb`
 *    （claim.service.test.ts 先例），账本读面 = 本地最小 DataSource 包装（只认 `ledgerExists`
 *    的 SQL **独立副本**；其余直读面**透传** FakeCurrencyDb —— 未识别 SQL 当场 reject，
 *    实现 SQL 一漂移就红）。验签器与 `ConfigCacheService` = **可控替身**（真身行为面由
 *    `ads-verifier.test.ts`/`config-cache.test.ts` 承重）。
 *  - 「5xx」在服务层 = `transient` 结果；映射面（v1.4 §2.4 表：终态 200 `{"isValid":true}` /
 *    瞬态 503 `{"isValid":false}`）由 `ads.controller.ts` 的 `AD_NOTIFY_MAP` 给，本文件以
 *    断言引用之（真 HTTP 面在 `ads.controller.test.ts`）。
 *  - 窗尾（确认+14:59 ⇒ 发放；+15:01 ⇒ claim_invalid 且不建键）：FakeRedis **不做时间流逝**
 *    （假库 T12 段已登记）⇒「窗过期」以**删记录键**如实建模（真 Redis 在 TTL 到点即如此）；
 *    确认续期面以 `ttls` 表（两键回 900）断言。
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { RPC_PATTERNS, type ConfigAdChannelGetResponse } from '@fight-the-landlord/protocol';
import { runWithTrace } from '@fight-the-landlord/shared';
import { AppModule } from '../src/app.module';
import { ApplyService } from '../src/apply/apply.service';
import { GetService } from '../src/apply/get.service';
import { ConfigCacheService } from '../src/config/config-cache.service';
import { currencyReliefTotal, reliefCallbackTotal } from '../src/metrics/currency.metrics';
import { ClaimService, RELIEF_CLAIM_DONE_TTL_SECONDS, RELIEF_CLAIM_TTL_SECONDS } from '../src/ads/claim.service';
import type { ReliefResult } from '../src/ads/claim.service';
import { DefaultRewardedCallbackVerifier, type CallbackSecretReader } from '../src/ads/ads-verifier';
import type { RewardedCallbackRequest, RewardedCallbackVerifier } from '../src/ads/ads-verifier';
import { AdCallbackService } from '../src/ads/ad-callback.service';
import type { AdCallbackOutcome } from '../src/ads/ad-callback.service';
import { AD_CHANNEL_RPC_PROXY, AD_CHANNEL_CLIENT_TIMEOUT_MS, AdChannelConfigService, AdChannelUnavailableError } from '../src/ads/ad-channel.config.service';
import { AD_NOTIFY_MAP } from '../src/ads/ads.controller';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';

/* ------------------------------------------------------------------ *
 * 键形/记录帮助（规格 §2.6 逐字；**测试侧独立副本** —— 不 import 实现，防两边一起改）
 * ------------------------------------------------------------------ */

const REC = (nonce: string): string => `relief:claim:${nonce}`;
const IDX = (userId: string): string => `relief:claim:u:${userId}`;

/** 账本按 actionId 存在性读的 SQL —— **独立副本**（实现漂移 ⇒ 透传 FakeCurrencyDb ⇒ 未识别当场 reject）。 */
const LEDGER_EXISTS_SQL = 'SELECT 1 FROM `currency_ops` WHERE `action_id` = ? LIMIT 1';

/** 一次回调请求的最小载荷（v1.4 GET query；extra = claim nonce；签名面由替身/真签用例自理）。 */
const notifyRequest = (extra: string): RewardedCallbackRequest => ({
  query: new URLSearchParams({ extra, trans_id: 't-1' }),
});

/* ---- v1.4 真签构造（仅「真验签器端到端」用例；测试侧独立算法副本，不 import 实现） ---- */

const CALLBACK_SECRET = 'c'.repeat(64);
const signHex = (transId: string, secret: string): string =>
  createHash('sha256').update(`${secret}:${transId}`, 'utf8').digest('hex');

/** v1.4 八字段 + 真签 query（缺省齐全；over 覆写值；给 sign 覆写则不自动签）。 */
const signedQuery = (over: Record<string, string> = {}, secret: string = CALLBACK_SECRET): URLSearchParams => {
  const fields: Record<string, string> = {
    adpid: '123456',
    provider: 'china',
    platform: 'Android',
    trans_id: 't-1',
    user_id: 'u-1',
    extra: 'n-x',
    ...over,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) q.set(k, v);
  if (!Object.prototype.hasOwnProperty.call(over, 'sign')) q.set('sign', signHex(fields.trans_id, secret));
  return q;
};

/** 密钥读面桩（窄接口结构兼容；impl 可给成功图/缺键图/抛错）。 */
const secretReaderOf = (impl: CallbackSecretReader['get']): CallbackSecretReader => ({ get: impl });
const workingSecretReader = (): CallbackSecretReader =>
  secretReaderOf(async () => ({ 'ad.callbackSecret': CALLBACK_SECRET }));

/* ------------------------------------------------------------------ *
 * 指标读面（结构类型，不引 prom-client 类型；照 relief.test.ts 成例）
 * ------------------------------------------------------------------ */

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

/** 两计数器的全桶快照（逐路径断言 = 前后差分；`toEqual` 精确等 ⇒「其余桶恰 0」一并钉住）。 */
type CounterSnapshot = Record<
  | 'cbAccepted'
  | 'cbClaimInvalid'
  | 'cbBadSign'
  | 'cbMalformed'
  | 'cbError'
  | 'reliefGranted'
  | 'reliefReplayed'
  | 'reliefRejected',
  number
>;

async function snapshot(): Promise<CounterSnapshot> {
  return {
    cbAccepted: await metricValue(reliefCallbackTotal, { result: 'accepted' }),
    cbClaimInvalid: await metricValue(reliefCallbackTotal, { result: 'claim_invalid' }),
    cbBadSign: await metricValue(reliefCallbackTotal, { result: 'bad_sign' }),
    cbMalformed: await metricValue(reliefCallbackTotal, { result: 'malformed' }),
    cbError: await metricValue(reliefCallbackTotal, { result: 'error' }),
    reliefGranted: await metricValue(currencyReliefTotal, { result: 'granted' }),
    reliefReplayed: await metricValue(currencyReliefTotal, { result: 'replayed' }),
    reliefRejected: await metricValue(currencyReliefTotal, { result: 'rejected' }),
  };
}

function delta(before: CounterSnapshot, after: CounterSnapshot): CounterSnapshot {
  const out = {} as CounterSnapshot;
  for (const key of Object.keys(before) as Array<keyof CounterSnapshot>) {
    out[key] = after[key] - before[key];
  }
  return out;
}

/** 全零差分（路径期望的基底；用例只写「应为 1」的位）。 */
const ZERO: CounterSnapshot = {
  cbAccepted: 0,
  cbClaimInvalid: 0,
  cbBadSign: 0,
  cbMalformed: 0,
  cbError: 0,
  reliefGranted: 0,
  reliefReplayed: 0,
  reliefRejected: 0,
};

/* ------------------------------------------------------------------ *
 * 夹具：账本读面的最小包装（只认 ledgerExists 的 SQL；其余透传 FakeCurrencyDb）
 * ------------------------------------------------------------------ */

class LedgerDb {
  /** 每次账本读的 actionId（链序/口径判据：「③ 先于 ④」「锚 = 签发日」都读它）。 */
  readonly ledgerQueries: string[] = [];
  /** 竞窗注入面：> 0 ⇒ 该次账本读返回「不存在」（模拟「账本先行与 apply 之间并发插入」——⑤ 路径的确定性构造）。 */
  ledgerMissesRemaining = 0;
  readonly dataSource: { query: (sql: string, params?: unknown[]) => Promise<unknown>; transaction: unknown };

  constructor(fake: FakeCurrencyDb) {
    this.dataSource = {
      query: (sql: string, params: unknown[] = []) => {
        if (sql === LEDGER_EXISTS_SQL) {
          this.ledgerQueries.push(String(params[0]));
          if (this.ledgerMissesRemaining > 0) {
            this.ledgerMissesRemaining -= 1;
            return Promise.resolve([]);
          }
          return Promise.resolve(fake.ops.some((op) => op.actionId === params[0]) ? [{ '1': 1 }] : []);
        }
        return fake.dataSource.query(sql, params); // 其余直读面照假库（未识别 SQL ⇒ 当场 reject）
      },
      transaction: fake.dataSource.transaction,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 验签器替身（真身行为面在 ads-verifier.test.ts；此处 scriptable）
 * ------------------------------------------------------------------ */

type VerifierStub = RewardedCallbackVerifier & { calls: RewardedCallbackRequest[] };

/** 默认替身：读 query 的 extra 放行（= 好形状 + 验签通过；v1.4 GET 回调无 body）；`resolveClaim` 一旦被调即响亮。 */
function makeVerifier(over: Partial<RewardedCallbackVerifier> = {}): VerifierStub {
  const calls: RewardedCallbackRequest[] = [];
  return {
    calls,
    verify: async (req) => {
      calls.push(req);
      return { ok: true, extra: req.query.get('extra') ?? '', transId: 't-1' };
    },
    resolveClaim: async () => {
      // T13 报告移交：回调链 ① 按自己的 read 步取 state/result，**不得**消费 resolveClaim——
      // 调用即红（若未来链序变化需要它，这条守卫会在同一点响亮，不会静默漂移）。
      throw new Error('resolveClaim 不应被回调链调用（链序 ① 走 ClaimService.read 直读）');
    },
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * 总夹具：真服务栈 + 可控配置/验签替身
 * ------------------------------------------------------------------ */

interface Harness {
  svc: AdCallbackService;
  apply: ApplyService;
  db: FakeCurrencyDb;
  redis: FakeRedis;
  ledger: LedgerDb;
  verifier: VerifierStub;
  claims: ClaimService;
  config: { available: boolean; enabled: boolean; amount: number; threshold: number | null };
}

function buildHarness(verifier: VerifierStub = makeVerifier()): Harness {
  const db = new FakeCurrencyDb();
  const redis = new FakeRedis();
  const ledger = new LedgerDb(db);
  const ds = ledger.dataSource as unknown as DataSource;
  const apply = new ApplyService(ds, redis as unknown as Redis);
  const get = new GetService(ds, redis as unknown as Redis);
  const claims = new ClaimService(redis as unknown as Redis);
  const config = { available: true, enabled: true, amount: 200, threshold: 150 };
  const configStub = {
    hasSnapshot: () => config.available,
    reliefEnabled: () => config.enabled,
    reliefAmount: () => config.amount,
    reliefThresholdCoins: () => config.threshold,
  } as unknown as ConfigCacheService;
  const svc = new AdCallbackService(verifier, claims, configStub, get, apply, ds);
  return { svc, apply, db, redis, ledger, verifier, claims, config };
}

/** 直接种入 issued/done 记录（T12 记录值形逐字；done 态按语义**不**种索引——done 落定时已删）。 */
function seedClaim(
  h: Harness,
  nonce: string,
  over: { userId: string; date: string; state?: 'issued' | 'done'; result?: ReliefResult },
): void {
  const state = over.state ?? 'issued';
  const value: Record<string, unknown> = { userId: over.userId, date: over.date, state };
  if (over.result !== undefined) value['result'] = over.result;
  h.redis.store.set(REC(nonce), JSON.stringify(value));
  if (state === 'issued') h.redis.store.set(IDX(over.userId), nonce);
}

const notify = (h: Harness, extra: string): Promise<AdCallbackOutcome> => h.svc.processCallback(notifyRequest(extra));

const THRESHOLD = 15 * 10; // 默认倍率 10、桩最低档 15 ⇒ 150（与 wallet 同式；不再 import 代码常量）

describe('T14 回调业务链（账本先行 / 落序 / 计数六路径）', () => {
  afterEach(() => {
    vi.useRealTimers(); // 窗尾用例的 Date 假时钟兜底还原（异常路径也不漏）
  });

  /* ==================================================================== *
   * ① 指标「inc ⇒ values」真值（T11 Minor：防空转——写点是本任务）
   * ==================================================================== */

  it('指标不空转：relief_callback_total / currency_relief_total 的 inc ⇒ values 真值（前后差分恰 +1）', async () => {
    const before = await snapshot();
    reliefCallbackTotal.inc({ result: 'accepted' });
    currencyReliefTotal.inc({ result: 'granted' });
    const after = await snapshot();
    expect(delta(before, after)).toEqual({ ...ZERO, cbAccepted: 1, reliefGranted: 1 });
  });

  /* ==================================================================== *
   * ② 正路（④ granted + 签发日锚）
   * ==================================================================== */

  it('正路：issued 记录 ⇒ apply granted ⇒ 落 done:granted；op/flow/缓存/两指标五面对账——actionId 内嵌 claim 签发日（≠ 今天也照签）', async () => {
    const h = buildHarness();
    seedClaim(h, 'n-grant', { userId: 'u-grant', date: '2026-10-05' }); // 签发日刻意 ≠ 处理日
    h.db.seedAccount('u-grant', 'user', 0);
    const before = await snapshot();

    const outcome = await notify(h, 'n-grant');

    expect(outcome).toBe('success-terminal');
    // 记录：done:granted（48h TTL）；索引键已删（done 落定面）
    expect(JSON.parse(h.redis.store.get(REC('n-grant')) ?? 'null')).toEqual({
      userId: 'u-grant',
      date: '2026-10-05',
      state: 'done',
      result: 'granted',
    });
    expect(h.redis.ttls.get(REC('n-grant'))).toBe(RELIEF_CLAIM_DONE_TTL_SECONDS);
    expect(h.redis.store.has(IDX('u-grant'))).toBe(false);
    // 账本：actionId = relief:<userId>:<claim 签发日>（设计 §3 口径——不看回调处理时刻）
    const op = h.db.ops.find((row) => row.actionId === 'relief:u-grant:2026-10-05');
    expect(op, 'ops 里没有以 claim 签发日为锚的 relief op').toBeDefined();
    expect(op).toMatchObject({ source: 'relief_grant', actor: null, reason: null, refId: 'u-grant' });
    // 账本先行读取的锚 = 同一签发日（③ 用的 actionId 与 ⑤ apply 的逐字一致）
    expect(h.ledger.ledgerQueries).toEqual(['relief:u-grant:2026-10-05']);
    // flow / 余额 / 缓存
    expect(
      h.db.flows
        .filter((flow) => flow.opId === op!.id)
        .map(({ ownerId, ownerType, delta: d, balanceAfter }) => ({ ownerId, ownerType, delta: d, balanceAfter })),
    ).toEqual([{ ownerId: 'u-grant', ownerType: 'user', delta: 200, balanceAfter: 200 }]);
    expect(h.db.accounts.get('u-grant')!.balance).toBe(200);
    expect(h.redis.store.get('currency:balance:u-grant')).toBe('200');
    // 计数六路径之 ④：回调面 accepted / 发放面 granted
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefGranted: 1 });
  });

  /* ==================================================================== *
   * ③ done 短路（计数路径 ①）——顺序重投
   * ==================================================================== */

  it('done 短路：记录 done ⇒ accepted、发放面不计、不重跑 apply；记录零改写（短路口是只读）', async () => {
    const h = buildHarness();
    seedClaim(h, 'n-done', { userId: 'u-done', date: '2026-10-05', state: 'done', result: 'granted' });
    h.db.seedAccount('u-done', 'user', 0);
    const opsBefore = h.db.ops.length;
    const versionBefore = h.redis.store.versionOf(REC('n-done'));
    const ledgerBefore = h.ledger.ledgerQueries.length;
    const before = await snapshot();

    const outcome = await notify(h, 'n-done');

    expect(outcome).toBe('success-terminal');
    expect(h.db.ops.length).toBe(opsBefore); // 未触 apply
    expect(h.db.txLog.length).toBe(0); // 事务都没开
    expect(h.redis.store.versionOf(REC('n-done'))).toBe(versionBefore); // 记录未被改写（仅 ② 短路）
    expect(h.ledger.ledgerQueries.length).toBe(ledgerBefore); // ② 短路先于 ③ 账本（链序判据）
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1 }); // 发放面恰 0
  });

  /* ==================================================================== *
   * ④ claim 无效（无凭证；不建键；200 接受词 = success-terminal）
   * ==================================================================== */

  it('claim 无效：记录不存在 ⇒ claim_invalid / success-terminal（线上 200 接受词）；不建键、不进账本', async () => {
    const h = buildHarness();
    const keysBefore = [...h.redis.store.keys()].sort();
    const before = await snapshot();

    const outcome = await notify(h, 'no-such-nonce');

    expect(outcome).toBe('success-terminal'); // 线上 = 200 + 接受词（确定性，重投不可改变结局）
    expect([...h.redis.store.keys()].sort()).toEqual(keysBefore); // 不建键
    expect(h.ledger.ledgerQueries.length).toBe(0); // ① 归类即止：账本都没查（链序判据）
    expect(h.db.ops.length).toBe(0);
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbClaimInvalid: 1 }); // 不计 accepted
  });

  /* ==================================================================== *
   * ⑤ 窗尾（确认+14:59 / +15:01）
   * ==================================================================== */

  it('窗尾：确认+14:59 回调 ⇒ 发放（窗内）；+15:01 ⇒ claim_invalid 且不建键（窗过期——FakeRedis 不做时间流逝，删记录键如实建模）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // 只假 Date：不影响任何真定时器面
    const h = buildHarness();
    vi.setSystemTime(new Date('2026-10-05T01:00:00Z')); // 沪 2026-10-05 09:00

    // 签发（窗起点前）：两键 TTL = 900
    const early = await h.claims.findOrCreate('u-tail-early');
    const late = await h.claims.findOrCreate('u-tail-late');
    h.db.seedAccount('u-tail-early', 'user', 0);
    h.db.seedAccount('u-tail-late', 'user', 0);
    expect(early.date).toBe('2026-10-05');

    // 确认（+14:00）：复用同 nonce + 续期（两键同置 900）——窗的有效起点 = 确认
    vi.setSystemTime(new Date('2026-10-05T01:14:00Z')); // +14:00
    const confirmed = await h.claims.findOrCreate('u-tail-early');
    expect(confirmed).toEqual({ nonce: early.nonce, date: '2026-10-05', reused: true });
    expect(h.redis.ttls.get(REC(early.nonce))).toBe(RELIEF_CLAIM_TTL_SECONDS);
    expect(h.redis.ttls.get(IDX('u-tail-early'))).toBe(RELIEF_CLAIM_TTL_SECONDS);

    // 确认+14:59 ⇒ 窗内 ⇒ 发放
    vi.setSystemTime(new Date('2026-10-05T01:14:59Z')); // +14:59
    const inWindow = await notify(h, early.nonce);
    expect(inWindow).toBe('success-terminal');
    expect(JSON.parse(h.redis.store.get(REC(early.nonce)) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'granted',
    });
    expect(h.db.accounts.get('u-tail-early')!.balance).toBe(200);

    // 确认+15:01 ⇒ 窗过期：真 Redis 已把两个键 TTL 到点移除；FakeRedis 无时间流逝 ⇒ 删记录键如实建模
    vi.setSystemTime(new Date('2026-10-05T01:15:01Z')); // +15:01
    h.redis.store.delete(REC(late.nonce)); // 过期（建模）
    const keysBefore = [...h.redis.store.keys()].sort();
    const before = await snapshot();

    const expired = await notify(h, late.nonce);

    expect(expired).toBe('success-terminal'); // claim_invalid 归 200 一类
    expect([...h.redis.store.keys()].sort()).toEqual(keysBefore); // 不建键（键面零变化）
    expect(h.db.accounts.get('u-tail-late')!.balance).toBe(0); // 分文未发
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbClaimInvalid: 1 });
  });

  /* ==================================================================== *
   * ⑥ 落序两注入（设计 §7 之 (a)/(b)）——本任务最核心判据
   * ==================================================================== */

  it('落序 (a)：apply 抛错 ⇒ 记录保持 issued + transient（5xx 可重投）；重投 ⇒ 发放且落 done:granted', async () => {
    const h = buildHarness();
    seedClaim(h, 'n-retry', { userId: 'u-retry', date: '2026-10-05' });
    h.db.seedAccount('u-retry', 'user', 0);
    // 注入：第一条 currency_ops INSERT 前抛错（apply 事务回滚路径；失败恰一次）
    let failures = 1;
    h.db.beforeStatement = (sql) => {
      if (failures > 0 && sql.startsWith('INSERT INTO `currency_ops`')) {
        failures -= 1;
        throw new Error('db down（注入：apply 提交前抛错）');
      }
    };
    const before = await snapshot();

    const first = await notify(h, 'n-retry');

    expect(first).toBe('transient');
    expect(AD_NOTIFY_MAP['transient'].status).toBeGreaterThanOrEqual(500); // 线上 5xx
    // 落序：记录保持 issued（未落 done）、金额零变化、账本零流水
    expect(JSON.parse(h.redis.store.get(REC('n-retry')) ?? 'null')).toMatchObject({ state: 'issued' });
    expect(h.db.ops.length).toBe(0);
    expect(h.db.accounts.get('u-retry')!.balance).toBe(0);
    expect(h.redis.store.get(IDX('u-retry'))).toBe('n-retry'); // 索引仍在（issued 未动）
    // 计数路径 ⑥：回调面 error、发放面不计
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbError: 1 });

    // 重投（注入解除）⇒ 发放且落 done:granted
    const mid = await snapshot();
    const second = await notify(h, 'n-retry');
    expect(second).toBe('success-terminal');
    expect(JSON.parse(h.redis.store.get(REC('n-retry')) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'granted',
    });
    expect(h.db.accounts.get('u-retry')!.balance).toBe(200);
    expect(h.db.ops.length).toBe(1);
    expect(delta(mid, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefGranted: 1 });
  });

  it('落序 (b)：apply 已提交但记录写失败 ⇒ 重投走**账本先行** ⇒ replayed、done:replayed、金额不再增（不撞余额闸）', async () => {
    const h = buildHarness();
    seedClaim(h, 'n-writefail', { userId: 'u-writefail', date: '2026-10-05' });
    h.db.seedAccount('u-writefail', 'user', 0);
    // 注入：第一次 MULTI EXEC（= markDone 的条件写）抛错 ⇒ 记录写失败（apply 已提交）
    h.redis.injectBefore('exec', () => {
      throw new Error('redis down（注入：记录写失败）');
    });
    const before = await snapshot();

    const first = await notify(h, 'n-writefail');

    expect(first).toBe('transient'); // 线上 5xx（等平台重投）
    // 金钱事实已发生：apply 已提交（op/flow/余额/缓存全部就位）；记录保持 issued（未落 done）
    expect(h.db.ops.some((op) => op.actionId === 'relief:u-writefail:2026-10-05')).toBe(true);
    expect(h.db.accounts.get('u-writefail')!.balance).toBe(200);
    expect(JSON.parse(h.redis.store.get(REC('n-writefail')) ?? 'null')).toMatchObject({ state: 'issued' });
    // 计数：granted **与 apply 返回同点计入**（发放面）+ 回调面 accepted（终态已达成）——
    // 记录写失败不再重复入 error 桶（一回调一计）
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefGranted: 1 });

    // 重投：① read issued ⇒ ③ **账本先行**（op 已在）⇒ replayed 终态；不重跑裁决/apply
    const mid = await snapshot();
    const opsBefore = h.db.ops.length;
    const flowsBefore = h.db.flows.length;

    const second = await notify(h, 'n-writefail');

    expect(second).toBe('success-terminal');
    expect(JSON.parse(h.redis.store.get(REC('n-writefail')) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'replayed',
    });
    expect(h.db.ops.length).toBe(opsBefore); // 金额不再增
    expect(h.db.flows.length).toBe(flowsBefore);
    expect(h.db.accounts.get('u-writefail')!.balance).toBe(200); // 余额未再变（若绕过账本先行，
    // 余额 200 ≥ 门槛 150 会被②裁决拒成 balance_ok——正是账本先行要绕开的形态）
    expect(h.ledger.ledgerQueries).toEqual([
      'relief:u-writefail:2026-10-05', // 首发申请的账本读（miss）
      'relief:u-writefail:2026-10-05', // 重投的账本读（命中）
    ]);
    expect(delta(mid, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefReplayed: 1 });
  });

  /* ==================================================================== *
   * ⑦ 配置不可用（hasSnapshot 缺）——瞬态、不落 done、可重投
   * ==================================================================== */

  it('配置不可用（hasSnapshot 缺）⇒ 不落 done、transient（5xx 可重投）；账本先行在前、apply 未达', async () => {
    const h = buildHarness();
    seedClaim(h, 'n-cfg', { userId: 'u-cfg', date: '2026-10-05' });
    h.db.seedAccount('u-cfg', 'user', 0);
    h.config.available = false;
    const before = await snapshot();

    const outcome = await notify(h, 'n-cfg');

    expect(outcome).toBe('transient');
    expect(JSON.parse(h.redis.store.get(REC('n-cfg')) ?? 'null')).toMatchObject({ state: 'issued' });
    expect(h.db.txLog.length).toBe(0); // apply 未达
    expect(h.ledger.ledgerQueries).toEqual(['relief:u-cfg:2026-10-05']); // ③ 在 ④ 之前（链序）
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbError: 1 });
  });

  /* ==================================================================== *
   * ⑧ 计数六路径逐行（§2.7 表）
   * ==================================================================== */

  it('计数六路径逐行（§2.7 表：①done短路 ②账本先行 ③正向拒绝 ④granted ⑤apply replay ⑥瞬态）', async () => {
    const h = buildHarness();

    // ① done 短路 ⇒ accepted / 发放面不计
    seedClaim(h, 'n-p1', { userId: 'u-p1', date: '2026-10-05', state: 'done', result: 'granted' });
    let before = await snapshot();
    expect(await notify(h, 'n-p1')).toBe('success-terminal');
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1 });

    // ② 账本先行判重放 ⇒ accepted / replayed（预置同锚流水 + 记录保持 issued）
    seedClaim(h, 'n-p2', { userId: 'u-p2', date: '2026-10-05' });
    h.db.seedCommittedOp(
      { actionId: 'relief:u-p2:2026-10-05', requestHash: 'seeded-hash', source: 'relief_grant' },
      [{ ownerId: 'u-p2', delta: 200, balanceAfter: 200 }],
    );
    const txBeforeP2 = h.db.txLog.length;
    before = await snapshot();
    expect(await notify(h, 'n-p2')).toBe('success-terminal');
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefReplayed: 1 });
    expect(h.db.txLog.length).toBe(txBeforeP2); // **不重跑裁决/apply**（连事务都没开——短线在 ③）

    // ③ 正向裁决拒绝（开关关 / 余额充足各一）⇒ accepted / rejected
    seedClaim(h, 'n-p3a', { userId: 'u-p3a', date: '2026-10-05' });
    h.config.enabled = false;
    before = await snapshot();
    expect(await notify(h, 'n-p3a')).toBe('success-terminal');
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefRejected: 1 });
    expect(JSON.parse(h.redis.store.get(REC('n-p3a')) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'disabled',
    });
    h.config.enabled = true;

    seedClaim(h, 'n-p3b', { userId: 'u-p3b', date: '2026-10-05' });
    h.db.seedAccount('u-p3b', 'user', THRESHOLD); // 恰 150 ⇒ 拒
    before = await snapshot();
    expect(await notify(h, 'n-p3b')).toBe('success-terminal');
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefRejected: 1 });
    expect(JSON.parse(h.redis.store.get(REC('n-p3b')) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'balance_ok',
    });

    // ④ apply granted ⇒ accepted / granted
    seedClaim(h, 'n-p4', { userId: 'u-p4', date: '2026-10-05' });
    h.db.seedAccount('u-p4', 'user', THRESHOLD - 1); // 149 ⇒ 放行（边界另一侧）
    before = await snapshot();
    expect(await notify(h, 'n-p4')).toBe('success-terminal');
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefGranted: 1 });

    // ⑤ apply replay ⇒ accepted / replayed（账本先行与 apply 之间的**竞窗**：账本读 miss 恰一次）。
    // 预置 = **真 ApplyService 铸出的同载荷流水**（request_hash 必然逐字一致 ⇒ apply 走 replay
    // 而非 14002——「RPC 预置同锚流水」的设计 §7 构造在单测面的等价形态），再把余额压回门槛下。
    seedClaim(h, 'n-p5', { userId: 'u-p5', date: '2026-10-05' });
    h.db.seedAccount('u-p5', 'user', 0);
    const preGrant = await h.apply.apply({
      actionId: 'relief:u-p5:2026-10-05',
      source: 'relief_grant',
      entries: [{ ownerId: 'u-p5', delta: 200 }],
      refId: 'u-p5',
    });
    expect(preGrant.ok).toBe(true);
    const preDrop = await h.apply.apply({
      actionId: 'admin:p5-drop',
      source: 'admin_adjust',
      actor: 'admin',
      reason: '测试回落',
      entries: [{ ownerId: 'u-p5', delta: -200 }],
    });
    expect(preDrop.ok).toBe(true);
    const opsBeforeP5 = h.db.ops.length;
    h.ledger.ledgerMissesRemaining = 1; // 竞窗注入：账本读「恰好错过」⇒ apply 重放接住
    before = await snapshot();
    expect(await notify(h, 'n-p5')).toBe('success-terminal');
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefReplayed: 1 });
    expect(h.db.ops.length).toBe(opsBeforeP5); // 未新增流水（apply 判重放）
    expect(JSON.parse(h.redis.store.get(REC('n-p5')) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'replayed',
    });

    // ⑥ 瞬态（claim 读取故障）⇒ error / 发放面不计
    seedClaim(h, 'n-p6', { userId: 'u-p6', date: '2026-10-05' });
    h.redis.failKeys.add(REC('n-p6')); // 读取故障（'read-failure' ≠ null）
    before = await snapshot();
    expect(await notify(h, 'n-p6')).toBe('transient');
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbError: 1 });
    h.redis.failKeys.delete(REC('n-p6'));
    expect(JSON.parse(h.redis.store.get(REC('n-p6')) ?? 'null')).toMatchObject({ state: 'issued' }); // 保持可重投
  });

  /**
   * 2026-10-24：救助门槛 = 平台级绝对金币 `currency.reliefThresholdCoins`。
   * 🔴 判别力：门槛 50 ⇒ 50/49（仍硬编码 150 的实现会红）。
   * 档位表不可用 ⇒ 瞬态（不落 done、等平台重投）——与「从未拉到快照」同族。
   */
  it('🔴 门槛跟随平台级配置：门槛 50 ⇒ 50 拒 / 49 放行；不可用 ⇒ 瞬态不落 done', async () => {
    const h = buildHarness();
    h.config.threshold = 50;

    seedClaim(h, 'n-min5-suff', { userId: 'u-min5-suff', date: '2026-10-05' });
    h.db.seedAccount('u-min5-suff', 'user', 50);
    expect(await notify(h, 'n-min5-suff')).toBe('success-terminal');
    expect(JSON.parse(h.redis.store.get(REC('n-min5-suff')) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'balance_ok',
    });

    seedClaim(h, 'n-min5-edge', { userId: 'u-min5-edge', date: '2026-10-05' });
    h.db.seedAccount('u-min5-edge', 'user', 49);
    expect(await notify(h, 'n-min5-edge')).toBe('success-terminal');
    expect(JSON.parse(h.redis.store.get(REC('n-min5-edge')) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'granted',
    });

    seedClaim(h, 'n-min5-down', { userId: 'u-min5-down', date: '2026-10-05' });
    h.db.seedAccount('u-min5-down', 'user', 0);
    h.config.threshold = null;
    const before = await snapshot();
    expect(await notify(h, 'n-min5-down')).toBe('transient');
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbError: 1 });
    expect(JSON.parse(h.redis.store.get(REC('n-min5-down')) ?? 'null')).toMatchObject({
      state: 'issued',
    });
  });

  it('14002（同日改金额再领/竞窗）⇒ 翻成 replayed 终态（不把冲突透给平台）；金额不再增', async () => {
    const h = buildHarness();
    seedClaim(h, 'n-14002', { userId: 'u-14002', date: '2026-10-05' });
    h.db.seedAccount('u-14002', 'user', 0);
    // 预置：真流水（amount=200 时代的同锚 op）+ 余额压回门槛下
    const pre = await h.apply.apply({
      actionId: 'relief:u-14002:2026-10-05',
      source: 'relief_grant',
      entries: [{ ownerId: 'u-14002', delta: 200 }],
      refId: 'u-14002',
    });
    expect(pre.ok).toBe(true);
    await h.apply.apply({
      actionId: 'admin:14002-drop',
      source: 'admin_adjust',
      actor: 'admin',
      reason: '测试回落',
      entries: [{ ownerId: 'u-14002', delta: -200 }],
    });
    h.config.amount = 300; // 同日改金额 ⇒ 同 actionId、异载荷 ⇒ apply 会回 14002
    h.ledger.ledgerMissesRemaining = 1; // 竞窗注入（同 ⑤）
    const before = await snapshot();
    const opsBefore = h.db.ops.length;

    const outcome = await notify(h, 'n-14002');

    expect(outcome).toBe('success-terminal'); // 终态成功面（线上 200 接受词）
    expect(JSON.parse(h.redis.store.get(REC('n-14002')) ?? 'null')).toMatchObject({
      state: 'done',
      result: 'replayed',
    });
    expect(h.db.ops.length).toBe(opsBefore); // 未新增
    expect(h.db.accounts.get('u-14002')!.balance).toBe(0); // 300 未被发放
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbAccepted: 1, reliefReplayed: 1 });
  });

  /* ==================================================================== *
   * ⑨ 空串 extra 链（T13 修后语义）+ 验签分类面
   * ==================================================================== */

  it("空串 extra 链（T13 修后语义）：验签通过 + resolveClaim('') ⇒ claim_invalid ⇒ success-terminal（线上 200 接受词）且不建键", async () => {
    const h = buildHarness(); // 替身验签器放行 ⇒ extra='' 进链
    const keysBefore = [...h.redis.store.keys()].sort();
    const before = await snapshot();

    const outcome = await notify(h, '');

    expect(outcome).toBe('success-terminal');
    expect([...h.redis.store.keys()].sort()).toEqual(keysBefore);
    expect(delta(before, await snapshot())).toEqual({ ...ZERO, cbClaimInvalid: 1 });
  });

  it('验签分类面端到端（真 DefaultRewardedCallbackVerifier + v1.4 真签）：缺字段 ⇒ reject-malformed（200/true）；空串 extra ⇒ 真签通过 → claim_invalid 终态', async () => {
    const db = new FakeCurrencyDb();
    const redis = new FakeRedis();
    const ledger = new LedgerDb(db);
    const ds = ledger.dataSource as unknown as DataSource;
    const claims = new ClaimService(redis as unknown as Redis);
    const realVerifier = new DefaultRewardedCallbackVerifier(claims, workingSecretReader());
    const svc = new AdCallbackService(
      realVerifier,
      claims,
      {
        hasSnapshot: () => true,
        reliefEnabled: () => true,
        reliefThresholdCoins: () => 150,
      } as unknown as ConfigCacheService,
      new GetService(ds, redis as unknown as Redis),
      new ApplyService(ds, redis as unknown as Redis),
      ds,
    );
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      // 缺业务必填（provider 空串）⇒ 形状分类即灭 ⇒ malformed（确定性拒绝，不依赖密钥；200/true 止投）
      const beforeMissing = await snapshot();
      const missing = await svc.processCallback({ query: signedQuery({ provider: '' }) });
      expect(missing).toBe('reject-malformed');
      expect(delta(beforeMissing, await snapshot())).toEqual({ ...ZERO, cbMalformed: 1 });
      expect(AD_NOTIFY_MAP['reject-malformed'].status).toBe(200);
      expect(AD_NOTIFY_MAP['reject-malformed'].body).toBe(JSON.stringify({ isValid: true }));

      // 空串 extra：形状放行且签名真过（sign 只吃 secret+trans_id）⇒ 链读 claim('') = null
      // ⇒ claim_invalid 终态（**不是**瞬态；若误归 malformed/transient，本断言当场红）
      const keysBefore = [...redis.store.keys()].sort();
      const beforeEmpty = await snapshot();
      const empty = await svc.processCallback({ query: signedQuery({ extra: '' }) });
      expect(empty).toBe('success-terminal');
      expect(delta(beforeEmpty, await snapshot())).toEqual({ ...ZERO, cbClaimInvalid: 1 });
      expect([...redis.store.keys()].sort()).toEqual(keysBefore); // 不建键
    } finally {
      warn.mockRestore();
    }
  });

  it('验签坏签名 ⇒ reject-sign / bad_sign 桶（200/true 终态）；验签器抛 AdChannelUnavailableError ⇒ transient / error 桶', async () => {
    const h1 = buildHarness(makeVerifier({ verify: async () => ({ ok: false, reason: 'bad_sign' }) }));
    const before1 = await snapshot();
    expect(await notify(h1, 'n-sign')).toBe('reject-sign');
    expect(AD_NOTIFY_MAP['reject-sign'].status).toBe(200);
    expect(AD_NOTIFY_MAP['reject-sign'].body).toBe(JSON.stringify({ isValid: true }));
    expect(delta(before1, await snapshot())).toEqual({ ...ZERO, cbBadSign: 1 });

    const h2 = buildHarness(
      makeVerifier({
        verify: async () => {
          throw new AdChannelUnavailableError('回调密钥不可用（未配置/拉取失败）');
        },
      }),
    );
    seedClaim(h2, 'n-nc', { userId: 'u-nc', date: '2026-10-05' });
    const before2 = await snapshot();
    expect(await notify(h2, 'n-nc')).toBe('transient');
    expect(delta(before2, await snapshot())).toEqual({ ...ZERO, cbError: 1 });
    expect(JSON.parse(h2.redis.store.get(REC('n-nc')) ?? 'null')).toMatchObject({ state: 'issued' }); // 未落 done
  });

  it('裁决序：开关关 ⇒ 连余额都不查（余额读取面零触碰）；余额 < 门槛的判定用 get 真值', async () => {
    const h = buildHarness();
    seedClaim(h, 'n-order', { userId: 'u-order', date: '2026-10-05' });
    h.config.enabled = false;
    const readsBefore = h.db.directQueries.length;

    expect(await notify(h, 'n-order')).toBe('success-terminal');

    expect(h.db.directQueries.length).toBe(readsBefore); // 余额回源未发生（次序即判据）
    expect(h.db.txLog.length).toBe(0);
  });

  /* ==================================================================== *
   * ⑩ AdChannelConfigService（现拉 + lastGood；无 lastGood ⇒ 抛瞬态）
   * ==================================================================== */

  describe('AdChannelConfigService：现拉 · 整图替换 · lastGood · 无 lastGood ⇒ 抛瞬态（规格 §2.3）', () => {
    /* 假 proxy / 订阅对象（rxjs 等价物手写最小化；照 payment pay-channel.config.test.ts 同族） */
    interface SendCall {
      pattern: string;
      data: unknown;
    }
    interface ObserverLike {
      next(value: unknown): void;
      error(err: unknown): void;
    }
    interface SubscriptionLike {
      subscribe(observer: ObserverLike): { unsubscribe(): void };
    }

    function fakeProxy(handler: (call: SendCall, index: number) => SubscriptionLike) {
      const calls: SendCall[] = [];
      const send = vi.fn((pattern: string, data: unknown) => {
        const call = { pattern, data };
        calls.push(call);
        return handler(call, calls.length - 1);
      });
      return { proxy: { send } as never, send, calls };
    }
    const ofValue = (value: unknown): SubscriptionLike => ({
      subscribe: (observer) => {
        observer.next(value);
        return { unsubscribe: () => undefined };
      },
    });
    const throwErr = (err: unknown): SubscriptionLike => ({
      subscribe: (observer) => {
        observer.error(err);
        return { unsubscribe: () => undefined };
      },
    });
    const neverObs = (counter?: { count: number }): SubscriptionLike => ({
      subscribe: () => ({
        unsubscribe: () => {
          if (counter) counter.count += 1;
        },
      }),
    });

    const VALUES = { 'ad.callbackSecret': 'secret-a' } as ConfigAdChannelGetResponse['values'];
    /** 回落 WARN 文案（照 pay 先例形态；**不含任何值**）。 */
    const FALLBACK_WARN = '广告回调密钥拉取失败，使用上次成功值（trace 见 meta）';

    it('打 RPC_PATTERNS.configAdChannelGet：载荷 = {pullToken, meta}（meta 在场）；解包 res.data.values；pullToken 逐调用读 env（`||` 空串=未设）', async () => {
      const saved = process.env.AD_CHANNEL_PULL_TOKEN;
      const { proxy, calls } = fakeProxy(() => ofValue({ ok: true, data: { values: VALUES } }));
      const svc = new AdChannelConfigService(proxy);
      try {
        process.env.AD_CHANNEL_PULL_TOKEN = 'tok-1';
        const res = await runWithTrace({ traceId: 'trace-t14-1', source: 'rpc' }, () => svc.get());
        expect(res).toEqual(VALUES);

        delete process.env.AD_CHANNEL_PULL_TOKEN;
        await svc.get();
      } finally {
        if (saved === undefined) delete process.env.AD_CHANNEL_PULL_TOKEN;
        else process.env.AD_CHANNEL_PULL_TOKEN = saved;
      }
      expect(calls).toEqual([
        {
          pattern: RPC_PATTERNS.configAdChannelGet,
          data: { pullToken: 'tok-1', meta: { traceId: 'trace-t14-1' } },
        },
        { pattern: RPC_PATTERNS.configAdChannelGet, data: { pullToken: '' } }, // 空串=未设；现拉逐调用
      ]);
    });

    it('成功 ⇒ **整图替换**（图 B 少键则键消失）；`{}` 是**有效图**（照常替换）且其后失败回落到新图', async () => {
      let step = 0;
      const { proxy } = fakeProxy(() => {
        step += 1;
        if (step === 1) return ofValue({ ok: true, data: { values: VALUES } });
        if (step === 2) return ofValue({ ok: true, data: { values: {} } });
        return throwErr(new Error('down'));
      });
      const svc = new AdChannelConfigService(proxy);
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        expect(await svc.get()).toEqual({ 'ad.callbackSecret': 'secret-a' }); // 图 A
        const second = await svc.get();
        expect(second).toEqual({}); // 图 B = {}（有效图，非 null）；toEqual 已排除 merge 残留
        expect(await svc.get()).toEqual({}); // 失败回落 = 整图替换后的 {}（不是旧图 A）
        expect(warn.mock.calls.map((a) => String(a[0]))).toContain(FALLBACK_WARN);
      } finally {
        warn.mockRestore();
      }
    });

    it('失败且无 lastGood ⇒ **抛瞬态**（AdChannelUnavailableError——回调 5xx 可重投；不得回落 null/空图）', async () => {
      const { proxy } = fakeProxy(() =>
        ofValue({ ok: false, code: 10002, message: '拉取令牌无效' }),
      );
      const svc = new AdChannelConfigService(proxy);
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const err = await svc.get().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AdChannelUnavailableError);
        expect((err as Error).name).toBe('AdChannelUnavailableError');
        expect((err as Error).message).not.toContain('10002'); // 不回显内部码/topology
        // 正对照：原因必须进日志（不透传 ≠ 不留痕）
        expect(warn.mock.calls.map((a) => String(a[0])).some((m) => m.includes('10002'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('失败且有 lastGood ⇒ 回落 + WARN 逐字恰一条（不含任何值）；10002/10007/传输故障**不按码分支**同路', async () => {
      for (const failure of [
        { ok: false, code: 10002, message: '拉取令牌无效' },
        { ok: false, code: 10007, message: '广告回调密钥存储未启用' },
      ]) {
        let call = 0;
        const { proxy } = fakeProxy(() =>
          (call += 1) === 1 ? ofValue({ ok: true, data: { values: VALUES } }) : ofValue(failure),
        );
        const svc = new AdChannelConfigService(proxy);
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
          await expect(svc.get(), JSON.stringify(failure)).resolves.toEqual(VALUES);
          await expect(svc.get(), JSON.stringify(failure)).resolves.toEqual(VALUES); // 回落
          const msgs = warn.mock.calls.map((args) => String(args[0]));
          expect(msgs.filter((m) => m === FALLBACK_WARN), JSON.stringify(failure)).toHaveLength(1);
          expect(msgs.some((m) => m.includes('secret-a'))).toBe(false); // WARN 不含值
        } finally {
          warn.mockRestore();
        }
      }

      // 传输故障（订阅 error）同路回落
      let failureCall = 0;
      const transport = fakeProxy(() =>
        (failureCall += 1) === 1
          ? ofValue({ ok: true, data: { values: VALUES } })
          : throwErr(new Error('connect ECONNREFUSED')),
      );
      const svc = new AdChannelConfigService(transport.proxy);
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await expect(svc.get()).resolves.toEqual(VALUES);
        await expect(svc.get()).resolves.toEqual(VALUES); // 回落
        expect(
          warn.mock.calls.map((a) => String(a[0])).filter((m) => m === FALLBACK_WARN),
        ).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('超时（1000ms）⇒ 有 lastGood 回落 / 无 lastGood 抛；恰 1 次 send（不重试）+ 退订', async () => {
      vi.useFakeTimers();
      const unsubscribed = { count: 0 };
      let mode: 'ok' | 'hang' = 'ok';
      const { proxy, calls } = fakeProxy(() =>
        mode === 'hang' ? neverObs(unsubscribed) : ofValue({ ok: true, data: { values: VALUES } }),
      );
      const svc = new AdChannelConfigService(proxy);
      try {
        await expect(svc.get()).resolves.toEqual(VALUES); // 暖 lastGood
        mode = 'hang';
        const p = svc.get();
        const expectation = expect(p).resolves.toEqual(VALUES); // 超时 ⇒ 回落
        await vi.advanceTimersByTimeAsync(AD_CHANNEL_CLIENT_TIMEOUT_MS - 100);
        expect(calls).toHaveLength(2); // 仍在挂起（不是立刻失败、也不是没有超时）
        await vi.advanceTimersByTimeAsync(150);
        await expectation;
        expect(calls).toHaveLength(2); // 不重试
        expect(unsubscribed.count).toBe(1); // 超时 ⇒ 退订（不泄漏订阅）

        // 无 lastGood（新实例）⇒ 超时抛瞬态
        const fresh = new AdChannelConfigService(proxy);
        const p2 = fresh.get();
        const expectation2 = expect(p2).rejects.toBeInstanceOf(AdChannelUnavailableError);
        await vi.advanceTimersByTimeAsync(AD_CHANNEL_CLIENT_TIMEOUT_MS + 1);
        await expectation2;
      } finally {
        vi.useRealTimers();
      }
    });

    it('导出常量：AD_CHANNEL_CLIENT_TIMEOUT_MS = 1000（照 pay 同值）', () => {
      expect(AD_CHANNEL_CLIENT_TIMEOUT_MS).toBe(1000);
    });
  });

  /* ==================================================================== *
   * ⑪ 注册面（T6/T11 教训：未注册 = 真容器解析注入即崩）与映射面
   * ==================================================================== */

  it('注册面：AdCallbackService / AdChannelConfigService / DefaultRewardedCallbackVerifier ∈ AppModule.providers；ClientsModule 注册 AD_CHANNEL_RPC_PROXY', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(AdCallbackService);
    expect(providers).toContain(AdChannelConfigService);
    expect(providers).toContain(DefaultRewardedCallbackVerifier);

    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    const hasProxy = imports.some((entry) => {
      const provides = (entry as { providers?: Array<{ provide?: unknown }> } | undefined)?.providers;
      return Array.isArray(provides) && provides.some((p) => p?.provide === AD_CHANNEL_RPC_PROXY);
    });
    expect(hasProxy, 'AppModule imports 里没有 AD_CHANNEL_RPC_PROXY 的 ClientsModule 注册').toBe(true);
  });

  it('映射面（§2.4 表）：终态三值 ⇒ 200 + {"isValid":true}；瞬态 ⇒ 503 + {"isValid":false}', () => {
    expect(AD_NOTIFY_MAP['success-terminal']).toEqual({
      status: 200,
      body: JSON.stringify({ isValid: true }),
    });
    expect(AD_NOTIFY_MAP['transient']).toEqual({
      status: 503,
      body: JSON.stringify({ isValid: false }),
    });
    for (const outcome of ['reject-sign', 'reject-malformed'] as const) {
      expect(AD_NOTIFY_MAP[outcome]).toEqual({
        status: 200,
        body: JSON.stringify({ isValid: true }),
      });
    }
  });
});

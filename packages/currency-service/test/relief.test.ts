/**
 * `GET /api/wallet/relief[?claim=]`（广告片 T15；规格 §2.5 **逐字**）：查询语义族 ——
 * **旧 `POST`（② 金币场 T8）已随本片退役**（旁路 404 单列一例）。
 *
 * ─── 契约（§2.5 逐字）─────────────────────────────────────────────────────
 *  - 身份**只**取 `X-User-Id`（缺/空 ⇒ 10002/401，照 balance 端点先例）；`claim` 是
 *    **查询参数**（非身份面）：数组取首元素、非字符串/空串视同未携（与网关
 *    `whitelistedQueryOf` 的丢弃口径同形——直连形态同口径）。
 *  - **响应信封**：`{code:0, data:{eligible, grantedToday, amount, balance, claim?, reason?}}`
 *    ——`amount`/`balance` **恒在场**；`claim` 仅签发/复用在场；`reason` 仅不可领/终态
 *    拒绝/失效在场。
 *  - **判定次序（无 claim，逐字）**：①快照不可用 ⇒ 503/10007 · ②**今日已发**（账本当日
 *    `actionId` = `reliefActionId(userId, 现在)` 存在）⇒ `{grantedToday:true, reason:
 *    '今天已经领过了'}`（**先于开关与余额闸**——余额回升后的已领用户不得看到「余额充足」）·
 *    ③开关关 ⇒ '救助暂未开放' · ④余额 ≥ 平台级绝对门槛 ⇒ '余额充足，无需救助' ·
 *    ⑤eligible ⇒ 调 T12 `findOrCreate`（签发/复用 + 续期）随响应返回。
 *  - **携 claim（轮询只读，不签发不续期）**：①记录 `userId` ≠ JWT 本人 ⇒ 按「不存在」处理 ·
 *    ②账本（JWT 本人 + **时钟当日** actionId）已真 ⇒ 成功面（**先于记录态**——Redis 丢失/
 *    跨零点兜底）· ③记录 `done` ⇒ granted/replayed ⇒ 成功面；disabled/balance_ok ⇒ 对应
 *    reason · ④`issued` ⇒ pending `{eligible:true, grantedToday:false}` · ⑤不存在 ⇒
 *    `reason:'领取凭证已失效，请重试'`。
 *  - 读取故障（Redis 连接异常）⇒ **503/10007**（r3 🟡-6：瞬态可重投，**不得**归「失效」）。
 *  - `currency_relief_total` 在本端点**零写点**（§2.7：旧 POST 的五处写点已迁至回调链）。
 *
 * ─── 夹具 ────────────────────────────────────────────────────────────────
 *  - 真 `GetService`/`ClaimService` + `FakeCurrencyDb`/`FakeRedis`；
 *  - 账本读面 = 本地 `LedgerDb` 最小包装（只认 `ledgerExists` 的 SQL —— **独立副本**，
 *    实现漂移一个字符 ⇒ 透传 FakeCurrencyDb ⇒ 未识别当场 reject；照 `ad-callback.test.ts`
 *    成例）；
 *  - `ConfigCacheService` = **可控替身**（真身行为面由 `config-cache.test.ts` 承重）；
 *  - HTTP 走真 Nest 管线（状态码/信封是真的 —— `helpers/http-probe.ts`）。
 */
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { ClaimService } from '../src/ads/claim.service';
import { GetService } from '../src/apply/get.service';
import { ConfigCacheService } from '../src/config/config-cache.service';
import { TRANSPORT_FAILURE_MESSAGE } from '../src/config/config.client';
import { reliefActionId } from '../src/wallet/wallet.controller';
import { FakeCurrencyDb, FakeRedis } from './helpers/fake-currency-db';
import { startWalletProbe, type HttpProbe } from './helpers/http-probe';

/** 键形/记录帮助（规格 §2.6 逐字；**测试侧独立副本** —— 不 import 实现，防两边一起改）。 */
const REC = (nonce: string): string => `relief:claim:${nonce}`;
const IDX = (userId: string): string => `relief:claim:u:${userId}`;

/** 余额缓存键（`redis.module` 的键形；本地独立副本）。 */
const KEY = (ownerId: string): string => `currency:balance:${ownerId}`;

/** 账本按 actionId 存在性读的 SQL —— **独立副本**（实现漂移 ⇒ 透传 FakeCurrencyDb ⇒ 未识别当场 reject）。 */
const LEDGER_EXISTS_SQL = 'SELECT 1 FROM `currency_ops` WHERE `action_id` = ? LIMIT 1';

/** 服务端「今天」（Asia/Shanghai）—— 测试侧独立副本（不 import 实现，防两边一起改）。 */
const shanghaiToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** 配置替身的三键 + 可用性（`hasSnapshot`）—— 用例按需改，每个用例先 `setConfig` 复位。 */
interface ConfigState {
  available: boolean;
  enabled: boolean;
  amount: number;
  /** 2026-10-24：平台级绝对门槛（null = 不可用 ⇒ 钱路径 fail-closed）。 */
  threshold: number | null;
}

/**
 * 账本读面的最小包装（只认 `ledgerExists` 的 SQL；其余透传 FakeCurrencyDb）——照
 * `ad-callback.test.ts` 的同名类（T14 先例）。`ledgerQueries` = 口径判据面（
 * 「锚 = 时钟当日 `reliefActionId`」直接读它）。
 */
class LedgerDb {
  readonly ledgerQueries: string[] = [];
  readonly dataSource: { query: (sql: string, params?: unknown[]) => Promise<unknown>; transaction: unknown };

  constructor(fake: FakeCurrencyDb) {
    this.dataSource = {
      query: (sql: string, params: unknown[] = []) => {
        if (sql === LEDGER_EXISTS_SQL) {
          this.ledgerQueries.push(String(params[0]));
          return Promise.resolve(fake.ops.some((op) => op.actionId === params[0]) ? [{ '1': 1 }] : []);
        }
        return fake.dataSource.query(sql, params); // 其余直读面照假库（未识别 SQL ⇒ 当场 reject）
      },
      transaction: fake.dataSource.transaction,
    };
  }
}

describe('GET /api/wallet/relief（T15；规格 §2.5 逐字）', () => {
  let db: FakeCurrencyDb;
  let redis: FakeRedis;
  let ledger: LedgerDb;
  let claims: ClaimService;
  let probe: HttpProbe;
  let config: { state: ConfigState; svc: ConfigCacheService };

  /** 每个用例开头复位配置面（顺序执行的共享替身 —— 别让上一个用例的状态漏进来）。 */
  const setConfig = (over: Partial<ConfigState> = {}): void => {
    Object.assign(config.state, { available: true, enabled: true, amount: 200, threshold: 150 }, over);
  };

  const get = (userId: string | null, query = '') =>
    probe.get(`/api/wallet/relief${query}`, userId === null ? {} : { 'x-user-id': userId });

  /** 直接种入 issued/done 记录（T12 记录值形逐字；done 态按语义**不**种索引——done 落定时已删）。 */
  const seedClaim = (
    nonce: string,
    over: { userId: string; date: string; state?: 'issued' | 'done'; result?: string },
  ): void => {
    const state = over.state ?? 'issued';
    const value: Record<string, unknown> = { userId: over.userId, date: over.date, state };
    if (over.result !== undefined) value['result'] = over.result;
    redis.store.set(REC(nonce), JSON.stringify(value));
    if (state === 'issued') redis.store.set(IDX(over.userId), nonce);
  };

  /** 种入「当日已发」的账本行（回调链 T14 写入的形态：`relief:<user>:<签发日>`）。 */
  const seedGrantedToday = (userId: string, date = shanghaiToday()): void => {
    db.seedCommittedOp({ actionId: `relief:${userId}:${date}`, requestHash: `h-${userId}`, source: 'relief_grant' }, []);
  };

  const redisWrites = (): Array<{ op: string; key: string }> =>
    redis.calls.filter((c) => c.op === 'set' || c.op === 'del' || c.op === 'expire' || c.op === 'exec');

  /**
   * 预热余额缓存（`redis.store` 直写**不**记入 `calls`）——消掉 `GetService` 读穿写缓存
   * （miss ⇒ SET）对「零写/键数不变」断言的污染；被打点用例的余额读随即走缓存命中（纯 get）。
   */
  const seedBalanceCache = (userId: string, balance: number): void => {
    redis.store.set(KEY(userId), String(balance));
  };

  beforeAll(async () => {
    db = new FakeCurrencyDb();
    redis = new FakeRedis();
    ledger = new LedgerDb(db);
    const dataSource = db.dataSource as unknown as DataSource;
    const getSvc = new GetService(dataSource, redis as unknown as Redis);
    claims = new ClaimService(redis as unknown as Redis);
    const state: ConfigState = { available: true, enabled: true, amount: 200, threshold: 150 };
    const svc = {
      hasSnapshot: () => state.available,
      reliefEnabled: () => state.enabled,
      reliefAmount: () => state.amount,
      reliefThresholdCoins: () => state.threshold,
    } as unknown as ConfigCacheService;
    config = { state, svc };
    probe = await startWalletProbe(getSvc, svc, claims, ledger.dataSource as unknown as DataSource);
  });
  afterAll(async () => {
    await probe.close();
  });
  afterEach(() => {
    vi.useRealTimers(); // 跨日用例的 Date 假时钟兜底还原（异常路径也不漏）
  });

  /* ==================================================================== *
   * 身份面 / 旁路（旧 POST 退役）
   * ==================================================================== */

  it('缺 / 空 X-User-Id ⇒ 401/10002（两形态；库/账本/缓存都未被触碰）', async () => {
    setConfig();
    const opsBefore = db.ops.length;
    const readsBefore = db.directQueries.length;
    const ledgerBefore = ledger.ledgerQueries.length;
    const redisBefore = redis.calls.length;

    const missing = await get(null);
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({
      code: ErrCode.UNAUTHENTICATED,
      message: 'X-User-Id header is required',
      data: null,
    });

    const empty = await get('');
    expect(empty.status).toBe(401);
    expect(empty.body.code).toBe(ErrCode.UNAUTHENTICATED);

    expect(db.ops.length).toBe(opsBefore);
    expect(db.directQueries.length).toBe(readsBefore);
    expect(ledger.ledgerQueries.length).toBe(ledgerBefore);
    expect(redis.calls.length).toBe(redisBefore);
  });

  it('旧 POST 退役 ⇒ 404（发放唯一入口 = 广告回调；本路由不再注册）—— 零库/零账本/零缓存触碰', async () => {
    setConfig();
    const opsBefore = db.ops.length;
    const ledgerBefore = ledger.ledgerQueries.length;
    const redisBefore = redis.calls.length;

    const res = await probe.postJson('/api/wallet/relief', {}, { 'x-user-id': 'u-relief-old-post' });

    expect(res.status).toBe(404);
    expect(db.ops.length).toBe(opsBefore);
    expect(ledger.ledgerQueries.length).toBe(ledgerBefore);
    expect(redis.calls.length).toBe(redisBefore);
  });

  it('非法 X-User-Id（字符集外）⇒ 400/10001（get 契约校验直透，不静默当 0；账本读不发生）', async () => {
    setConfig();
    const ledgerBefore = ledger.ledgerQueries.length;

    const res = await get('bad id!');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrCode.BAD_PARAM);
    expect(ledger.ledgerQueries.length).toBe(ledgerBefore); // 校验先于任何 IO（含账本读）
  });

  it('身份只认头：`?userId=<别人>` 无视 —— 签发签给头持有者（索引键在本人、不在别人）', async () => {
    setConfig();
    db.seedAccount('u-relief-me', 'user', 0);
    db.seedAccount('u-relief-other', 'user', 999);

    const res = await get('u-relief-me', '?userId=u-relief-other');

    expect(res.status).toBe(200);
    const data = res.body.data as { eligible: boolean; claim?: string };
    expect(data.eligible).toBe(true);
    expect(redis.store.has(IDX('u-relief-me'))).toBe(true);
    expect(redis.store.has(IDX('u-relief-other'))).toBe(false);
    expect(JSON.parse(redis.store.get(REC(data.claim!))!)).toMatchObject({ userId: 'u-relief-me' });
  });

  /* ==================================================================== *
   * 无 claim 路径：五步次序（①–⑤）
   * ==================================================================== */

  it('① 快照不可用（从未拉到）⇒ 503/10007 固定文案 —— 不默认放行（零库/零账本/零缓存触碰）', async () => {
    setConfig({ available: false, enabled: true }); // 开关状态「无从谈起」——照样必须拒
    const opsBefore = db.ops.length;
    const readsBefore = db.directQueries.length;
    const ledgerBefore = ledger.ledgerQueries.length;
    const redisBefore = redis.calls.length;

    const res = await get('u-relief-cfgdown');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: TRANSPORT_FAILURE_MESSAGE,
      data: null,
    });
    expect(db.ops.length).toBe(opsBefore);
    expect(db.directQueries.length).toBe(readsBefore);
    expect(ledger.ledgerQueries.length).toBe(ledgerBefore);
    expect(redis.calls.length).toBe(redisBefore);
  });

  it('② 今日已发优先于余额闸（余额回升场景）：账本当日 actionId 在 ⇒「今天已经领过了」，不签凭证', async () => {
    setConfig(); // 门槛 = 15 × 10 = 150
    const u = 'u-relief-recovered';
    db.seedAccount(u, 'user', 500); // 已领用户余额又回升 ≥ 门槛 —— 最像「余额充足」的错面子
    seedBalanceCache(u, 500);
    seedGrantedToday(u);
    const keysBefore = redis.store.size;
    const writesBefore = redisWrites().length;

    const res = await get(u);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: true, amount: 200, balance: 500, reason: '今天已经领过了' },
    });
    // 账本查询逐字 = 时钟当日锚（reliefActionId 的既有函数）
    expect(ledger.ledgerQueries.at(-1)).toBe(reliefActionId(u, new Date()));
    expect(redis.store.size).toBe(keysBefore); // 不签发
    expect(redisWrites().length).toBe(writesBefore);
  });

  it('② 今日已发优先于开关：开关关也照「今天已经领过了」（次序即判据）', async () => {
    setConfig({ enabled: false });
    const u = 'u-relief-granted-off';
    db.seedAccount(u, 'user', 0);
    seedGrantedToday(u);

    const res = await get(u);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      eligible: false,
      grantedToday: true,
      amount: 200,
      balance: 0,
      reason: '今天已经领过了',
    });
  });

  it('③ 开关关（未领）⇒「救助暂未开放」；余额充足也照旧（③ 先于 ④）；不签凭证', async () => {
    setConfig({ enabled: false });
    db.seedAccount('u-relief-off-poor', 'user', 0);
    db.seedAccount('u-relief-off-rich', 'user', 500); // 余额充足也接不到 ④ 的文案
    seedBalanceCache('u-relief-off-poor', 0);
    seedBalanceCache('u-relief-off-rich', 500);
    const keysBefore = redis.store.size;
    const writesBefore = redisWrites().length;

    const poor = await get('u-relief-off-poor');
    const rich = await get('u-relief-off-rich');

    expect(poor.status).toBe(200);
    expect(rich.status).toBe(200);
    expect(poor.body.data).toEqual({
      eligible: false,
      grantedToday: false,
      amount: 200,
      balance: 0,
      reason: '救助暂未开放',
    });
    expect(rich.body.data).toEqual({
      eligible: false,
      grantedToday: false,
      amount: 200,
      balance: 500,
      reason: '救助暂未开放',
    });
    expect(redis.store.size).toBe(keysBefore);
    expect(redisWrites().length).toBe(writesBefore);
  });

  it('④ 余额 ≥ 门槛 ⇒「余额充足，无需救助」；门槛边界 150/149 与倍率读数面双向可判；不签凭证', async () => {
    setConfig(); // threshold = 150
    db.seedAccount('u-relief-suff', 'user', 150); // 恰 150 ⇒ 拒
    db.seedAccount('u-relief-edge', 'user', 149); // 149 ⇒ 放行（签发，不发放）
    db.seedAccount('u-relief-m20', 'user', 299); // 倍率改 20 ⇒ 门槛 300 ⇒ 299（<300）反而放行
    db.seedAccount('u-relief-m20b', 'user', 300); // 缩放后的边界另一侧：恰 300 ⇒ 拒
    seedBalanceCache('u-relief-suff', 150);
    seedBalanceCache('u-relief-edge', 149);
    seedBalanceCache('u-relief-m20', 299);
    seedBalanceCache('u-relief-m20b', 300);
    const keysBefore = redis.store.size;

    const suff = await get('u-relief-suff');
    expect(suff.status).toBe(200);
    expect(suff.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: false, amount: 200, balance: 150, reason: '余额充足，无需救助' },
    });

    const edge = await get('u-relief-edge');
    expect(edge.body.data).toMatchObject({ eligible: true, grantedToday: false, amount: 200, balance: 149 });
    expect(redis.store.size).toBe(keysBefore + 2); // 仅 edge 一例签发（rec + idx）

    // 倍率真的被读（299@m20 放行 = 判别格：照死 150 的实现会错拒）；缩放后的边界另一侧：
    setConfig({ threshold: 300 });
    const m20 = await get('u-relief-m20'); // 299 < 300 ⇒ 放行
    expect(m20.body.data).toMatchObject({ eligible: true });
    const m20b = await get('u-relief-m20b'); // 300 ≥ 300 ⇒ 拒
    expect(m20b.status).toBe(200);
    expect(m20b.body.data).toMatchObject({ eligible: false, reason: '余额充足，无需救助' });
  });

  /**
   * 2026-10-24：门槛 = 平台级绝对金币 `currency.reliefThresholdCoins`。
   * 🔴 判别力：门槛 50 ⇒ 50/49（若实现仍硬编码 150，边界会错）。
   */
  it('④′ 门槛跟随平台级配置：门槛 50 ⇒ 50 拒 / 49 放行；门槛不可用 ⇒ 503/10007', async () => {
    setConfig({ threshold: 50 });
    db.seedAccount('u-min5-suff', 'user', 50);
    db.seedAccount('u-min5-edge', 'user', 49);
    seedBalanceCache('u-min5-suff', 50);
    seedBalanceCache('u-min5-edge', 49);

    const suff = await get('u-min5-suff');
    expect(suff.status).toBe(200);
    expect(suff.body.data).toMatchObject({ eligible: false, reason: '余额充足，无需救助' });

    const edge = await get('u-min5-edge');
    expect(edge.status).toBe(200);
    expect(edge.body.data).toMatchObject({ eligible: true });

    // 档位表不可用（键缺失/坏值）：钱路径 fail-closed，不签发。
    setConfig({ threshold: null });
    const keysBefore = redis.store.size;
    const down = await get('u-min5-edge');
    expect(down.status).toBe(503);
    expect(down.body.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(redis.store.size).toBe(keysBefore);
  });

  it('⑤ eligible ⇒ 签发：claim = 22 字符 base64url；rec/idx 双键（TTL 900）+ 记录形逐字', async () => {
    setConfig();
    const u = 'u-relief-issue';
    db.seedAccount(u, 'user', 30); // < 150

    const res = await get(u);

    expect(res.status).toBe(200);
    const data = res.body.data as { eligible: boolean; grantedToday: boolean; amount: number; balance: number; claim: string };
    expect(res.body.code).toBe(ErrCode.OK);
    expect(data.eligible).toBe(true);
    expect(data.grantedToday).toBe(false);
    expect(data.amount).toBe(200);
    expect(data.balance).toBe(30);
    expect(data.claim).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const rec = JSON.parse(redis.store.get(REC(data.claim))!) as Record<string, unknown>;
    expect(rec).toEqual({ userId: u, date: shanghaiToday(), state: 'issued' });
    expect(redis.store.get(IDX(u))).toBe(data.claim);
    expect(redis.ttls.get(REC(data.claim))).toBe(900);
    expect(redis.ttls.get(IDX(u))).toBe(900);
  });

  it('⑤ 复用：两连 GET 同 nonce + **续期**（TTL 回 900）；键数不增', async () => {
    setConfig();
    const u = 'u-relief-reuse';
    db.seedAccount(u, 'user', 0);

    const first = await get(u);
    const nonce = (first.body.data as { claim: string }).claim;
    const keysAfterFirst = redis.store.size;

    // 扰动两键 TTL（若实现复用时不续期，下面的 900 断言必红）
    redis.ttls.set(REC(nonce), 111);
    redis.ttls.set(IDX(u), 111);

    const second = await get(u);

    expect((second.body.data as { claim: string }).claim).toBe(nonce); // 同一凭证
    expect((second.body.data as { eligible: boolean }).eligible).toBe(true);
    expect(redis.ttls.get(REC(nonce))).toBe(900); // 续期（复用分支两键 EXPIRE 同置）
    expect(redis.ttls.get(IDX(u))).toBe(900);
    expect(redis.store.size).toBe(keysAfterFirst); // 连发不增键
  });

  it('无 claim + `?claim=` 空串 ⇒ 视同未携（签发路径 —— 与网关丢弃口径同形）', async () => {
    setConfig();
    const u = 'u-relief-empty-claim';
    db.seedAccount(u, 'user', 0);

    const res = await get(u, '?claim=');

    expect(res.status).toBe(200);
    expect((res.body.data as { eligible: boolean }).eligible).toBe(true);
    expect((res.body.data as { claim?: string }).claim).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('今日已发口径 = 时钟当日锚（跨 UTC 日界：D 日已领、D+1 配额复位；非「有流水就算」）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // 只假 Date：HTTP 探针的定时器保持真的
    setConfig();
    const u = 'u-relief-crossday';
    db.seedAccount(u, 'user', 90);
    seedGrantedToday(u, '2026-10-05'); // 签发日 D 的账本行（回调链写入形态）

    vi.setSystemTime(new Date('2026-10-05T15:59:59Z')); // 上海 2026-10-05 23:59:59
    const d1 = await get(u);
    expect(d1.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: true, amount: 200, balance: 90, reason: '今天已经领过了' },
    });
    expect(ledger.ledgerQueries.at(-1)).toBe('relief:u-relief-crossday:2026-10-05');

    vi.setSystemTime(new Date('2026-10-05T16:00:01Z')); // 上海 2026-10-06 00:00:01（UTC 日界另一侧）
    const d2 = await get(u);
    expect((d2.body.data as { eligible: boolean }).eligible).toBe(true); // 新日 ⇒ 可领
    expect(ledger.ledgerQueries.at(-1)).toBe('relief:u-relief-crossday:2026-10-06');
    const nonce = (d2.body.data as { claim: string }).claim;
    expect(JSON.parse(redis.store.get(REC(nonce))!)).toMatchObject({ date: '2026-10-06' }); // 新签锚 D+1
  });

  it('reliefActionId：日期按 Asia/Shanghai 计算（UTC 日界两侧定值向量；本地时区实现会歪）', () => {
    expect(reliefActionId('u1', new Date('2026-10-03T15:59:59Z'))).toBe('relief:u1:2026-10-03');
    expect(reliefActionId('u1', new Date('2026-10-03T16:00:00Z'))).toBe('relief:u1:2026-10-04');
    expect(reliefActionId('u1', new Date('2026-10-03T23:30:00Z'))).toBe('relief:u1:2026-10-04');
    expect(reliefActionId('bot_x-9', new Date('2026-10-04T00:00:00Z'))).toBe('relief:bot_x-9:2026-10-04');
  });

  /* ==================================================================== *
   * 携 claim 路径：轮询五态 + 跨主体 + 只读 + 账本优先
   * ==================================================================== */

  it('五态·issued ⇒ pending（eligible:true / grantedToday:false）；**只读自证**：不签发、不续期、键数不变', async () => {
    setConfig();
    const u = 'u-relief-poll-issued';
    db.seedAccount(u, 'user', 40);
    seedBalanceCache(u, 40); // 余额读走缓存命中（纯 get）——让「本请求全部 Redis 动作」只剩 get
    seedClaim('nonce-issued-0000000000', { userId: u, date: shanghaiToday() });
    // 扰动 TTL：若实现续期（违规），900 覆盖 555 ⇒ 断言必红
    redis.ttls.set(REC('nonce-issued-0000000000'), 555);
    redis.ttls.set(IDX(u), 555);
    const callsBefore = redis.calls.length;
    const keysBefore = redis.store.size;

    const res = await get(u, '?claim=nonce-issued-0000000000');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: true, grantedToday: false, amount: 200, balance: 40 },
    });
    // 只读自证：本请求对 Redis 的全部动作恰为 get（零 set/del/expire/exec/watch）
    const pollCalls = redis.calls.slice(callsBefore);
    expect(pollCalls.length).toBeGreaterThan(0);
    expect(pollCalls.every((c) => c.op === 'get')).toBe(true);
    expect(redis.ttls.get(REC('nonce-issued-0000000000'))).toBe(555); // 未续期
    expect(redis.ttls.get(IDX(u))).toBe(555);
    expect(redis.store.size).toBe(keysBefore); // 键数不变（不签发）
  });

  it('五态·done = granted ⇒ 成功面（{grantedToday:true, eligible:false} + amount/balance；无 claim/reason）', async () => {
    setConfig();
    const u = 'u-relief-poll-granted';
    db.seedAccount(u, 'user', 240);
    seedClaim('nonce-granted-000000000', { userId: u, date: shanghaiToday(), state: 'done', result: 'granted' });

    const res = await get(u, '?claim=nonce-granted-000000000');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: true, amount: 200, balance: 240 },
    });
  });

  it('五态·done = replayed ⇒ 成功面（同日重放对用户即「已到账」）', async () => {
    setConfig();
    const u = 'u-relief-poll-replayed';
    db.seedAccount(u, 'user', 240);
    seedClaim('nonce-replayed-00000000', { userId: u, date: shanghaiToday(), state: 'done', result: 'replayed' });

    const res = await get(u, '?claim=nonce-replayed-00000000');

    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: true, amount: 200, balance: 240 },
    });
  });

  it('五态·done = disabled ⇒ 终态拒绝「救助暂未开放」（grantedToday:false）', async () => {
    setConfig();
    const u = 'u-relief-poll-disabled';
    db.seedAccount(u, 'user', 30);
    seedClaim('nonce-disabled-00000000', { userId: u, date: shanghaiToday(), state: 'done', result: 'disabled' });

    const res = await get(u, '?claim=nonce-disabled-00000000');

    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: false, amount: 200, balance: 30, reason: '救助暂未开放' },
    });
  });

  it('五态·done = balance_ok ⇒ 终态拒绝「余额充足，无需救助」', async () => {
    setConfig();
    const u = 'u-relief-poll-balanceok';
    db.seedAccount(u, 'user', 500);
    seedClaim('nonce-balanceok-0000000', { userId: u, date: shanghaiToday(), state: 'done', result: 'balance_ok' });

    const res = await get(u, '?claim=nonce-balanceok-0000000');

    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: false, amount: 200, balance: 500, reason: '余额充足，无需救助' },
    });
  });

  it('五态·记录不存在（含过期的非凭证）⇒「领取凭证已失效，请重试」；不建键', async () => {
    setConfig();
    const u = 'u-relief-poll-ghost';
    db.seedAccount(u, 'user', 12);
    seedBalanceCache(u, 12);
    const keysBefore = redis.store.size;
    const writesBefore = redisWrites().length;

    const res = await get(u, '?claim=nonce-never-existed000');

    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: false, amount: 200, balance: 12, reason: '领取凭证已失效，请重试' },
    });
    expect(redis.store.size).toBe(keysBefore); // claim_invalid 不建键
    expect(redisWrites().length).toBe(writesBefore);
  });

  it('跨主体：记录 userId ≠ JWT 本人 ⇒ 按「不存在」处理（失效文案；amount/balance 恒取 JWT 侧）', async () => {
    setConfig();
    const me = 'u-relief-poll-me';
    db.seedAccount(me, 'user', 7);
    db.seedAccount('u-relief-poll-victim', 'user', 999);
    seedClaim('nonce-other-user-0000', { userId: 'u-relief-poll-victim', date: shanghaiToday() });

    const res = await get(me, '?claim=nonce-other-user-0000');

    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: false, amount: 200, balance: 7, reason: '领取凭证已失效，请重试' },
    });
  });

  it('账本优先：时钟当日已真 ⇒ 成功面（先于记录态——issued 也直接成功面；Redis 记录丢失也兜底）', async () => {
    setConfig();
    const u = 'u-relief-ledger-first';
    db.seedAccount(u, 'user', 90);
    seedGrantedToday(u);
    seedClaim('nonce-ledger-first-000', { userId: u, date: shanghaiToday() }); // issued：若实现先看记录态会错报 pending

    const withIssued = await get(u, '?claim=nonce-ledger-first-000');
    expect(withIssued.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: true, amount: 200, balance: 90 },
    });

    // 记录整体丢失（Redis 数据面丢失）⇒ 账本仍真 ⇒ 成功面（不是「失效」）
    const lost = await get(u, '?claim=nonce-vanished-0000000');
    expect(lost.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: true, amount: 200, balance: 90 },
    });
  });

  it('跨零点轮询兜底：账本查询 = 时钟当日（D+1 必 miss）⇒ 由记录路径（done:granted）出成功面', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setConfig();
    const u = 'u-relief-poll-crossday';
    db.seedAccount(u, 'user', 240);
    seedGrantedToday(u, '2026-10-05'); // 账本行只有 D 日锚
    seedClaim('nonce-crossday-00000000', { userId: u, date: '2026-10-05', state: 'done', result: 'granted' });

    vi.setSystemTime(new Date('2026-10-05T16:30:00Z')); // 上海 2026-10-06 00:30
    const res = await get(u, '?claim=nonce-crossday-00000000');

    expect(ledger.ledgerQueries.at(-1)).toBe('relief:u-relief-poll-crossday:2026-10-06'); // 时钟当日（非签发日）
    expect(res.body).toEqual({
      code: ErrCode.OK,
      data: { eligible: false, grantedToday: true, amount: 200, balance: 240 },
    });
  });

  /* ==================================================================== *
   * 瞬态（503/10007）：读取故障 ≠ 失效；签发故障 ⇒ 503
   * ==================================================================== */

  it('携 claim：Redis 读取故障（连接异常）⇒ 503/10007 —— **不得**归「领取凭证已失效」（r3 🟡-6）', async () => {
    setConfig();
    const u = 'u-relief-poll-rdown';
    db.seedAccount(u, 'user', 10);
    seedClaim('nonce-readfail-0000000', { userId: u, date: shanghaiToday() });
    redis.failKeys.add(REC('nonce-readfail-0000000'));

    const res = await get(u, '?claim=nonce-readfail-0000000');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: TRANSPORT_FAILURE_MESSAGE,
      data: null,
    });
  });

  it('无 claim：签发路径 Redis 故障（findOrCreate 瞬态）⇒ 503/10007；不残留半成品键', async () => {
    setConfig();
    const u = 'u-relief-issuedown';
    db.seedAccount(u, 'user', 0);
    seedBalanceCache(u, 0);
    redis.failKeys.add(IDX(u)); // 签发首步 GET(idx) 即抛 ⇒ ClaimTransientError
    const keysBefore = redis.store.size;

    const res = await get(u);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
      message: TRANSPORT_FAILURE_MESSAGE,
      data: null,
    });
    expect(redis.store.size).toBe(keysBefore); // 零残留
  });
});

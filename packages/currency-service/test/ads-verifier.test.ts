/**
 * 广告片 T13 + **T0 回填已落**（规格 v1.4 §2.4）：**回调验签器**单测。
 *
 * ─── 判据形态 ───────────────────────────────────────────────────────────
 *  ① 验签面（**真算法**：`sign = sha256("<secret>:<trans_id>")` hex；GET query 入参）：
 *     · 真签正例（固定 secret；测试侧独立签名副本，不 import 实现）⇒ `{ok:true, extra, transId}`；
 *     · 大写 hex sign 边界（双侧 lowercase 归一 ⇒ 通过）；
 *     · 坏签名（改一位 / 非 hex / 长度不符 / 服务端密钥不同）⇒ `{ok:false, reason:'bad_sign'}`；
 *     · 形状：缺五枚业务必填/其空串 ⇒ `malformed`（**不抛**——形状分类不需要密钥）；
 *       缺/空 `sign` ⇒ `bad_sign`（规格逐字，且不触发密钥读面）；
 *       `extra` 空串在场 ⇒ 放行（验签通过带 `extra:''`，交 claim 层）；
 *     · `cpm?` 可选字段照收（签名不覆盖它）；
 *     · 密钥拉取抛 `AdChannelUnavailableError` / 密钥图缺键 ⇒ verify **原样上抛同瞬态类**。
 *  ② `resolveClaim` 三分类各一：ok（真 `ClaimService.read` + FakeRedis）/
 *     invalid（不存在 + 畸形记录）/ readFailure（读取故障，与 invalid 互斥）。
 *
 * ─── 硬约束 ────────────────────────────────────────────────────────────
 *  **单测不得依赖真 Redis**（同 T12 口径；CI Stage 4 无 redis）——`helpers/fake-currency-db.ts`
 *  的 FakeRedis；readFailure 沿既有 `failKeys` 面（get 抛错 ⇒ `read` 归 `'read-failure'`）。
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { AD_CHANNEL_KEYS } from '@fight-the-landlord/protocol';
import { ClaimService } from '../src/ads/claim.service';
import { DefaultRewardedCallbackVerifier, type CallbackSecretReader } from '../src/ads/ads-verifier';
import { AdChannelUnavailableError } from '../src/ads/ad-channel.config.service';
import { FakeRedis } from './helpers/fake-currency-db';

/* ------------------------------------------------------------------ *
 * 键形/样本帮助（测试侧独立副本——不 import 实现，防两边一起改）
 * ------------------------------------------------------------------ */

const SECRET_KEY = AD_CHANNEL_KEYS[0];
/** 固定测试密钥（32B hex 形态，与夹具同形但**故意不读夹具**——单测要零环境依赖）。 */
const SECRET = 'a'.repeat(64);

const REC = (nonce: string): string => `relief:claim:${nonce}`;

/** 记录 JSON（§2.6 值形；over 覆写按需——照 claim.service.test.ts 先例）。 */
const recordJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ userId: 'u-1', date: '2026-10-01', state: 'issued', ...over });

/** 八字段 wire 全集（不含 sign；cpm? 可叠加）。 */
const VALID_FIELDS = {
  adpid: '123456',
  provider: 'china',
  platform: 'Android',
  trans_id: 'T-1',
  user_id: 'u-1',
  extra: 'nonce-0000000000000000',
} as const;

/** 测试侧**独立**签名副本（官方算法逐字；刻意不 import 产品实现——防两边一起错）。 */
const signHex = (transId: string, secret: string): string =>
  createHash('sha256').update(`${secret}:${transId}`, 'utf8').digest('hex');

/** URLSearchParams 构造（缺省真签；over 可覆写任一值；给 sign 覆写则不再自动签）。 */
const signedQuery = (over: Record<string, string> = {}, secret: string = SECRET): URLSearchParams => {
  const fields: Record<string, string> = { ...VALID_FIELDS, ...over };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) q.set(k, v);
  if (!Object.prototype.hasOwnProperty.call(over, 'sign')) q.set('sign', signHex(fields.trans_id, secret));
  return q;
};

/** 缺字段：从全集删一枚再签（`sign` 一枚不补签——缺 sign 归 bad_sign；其余字段缺/空形状面先归 malformed）。 */
const queryWithout = (key: string): URLSearchParams => {
  const fields: Record<string, string> = { ...VALID_FIELDS };
  delete fields[key];
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) q.set(k, v);
  if (key !== 'sign') q.set('sign', signHex(fields.trans_id ?? '', SECRET));
  return q;
};

/** 密钥读面桩（窄接口 `CallbackSecretReader` 结构兼容）。 */
const secretReaderOf = (impl: CallbackSecretReader['get']): CallbackSecretReader => ({ get: impl });
const workingSecrets = (): CallbackSecretReader =>
  secretReaderOf(async () => ({ [SECRET_KEY]: SECRET }));

describe('T13 验签器（v1.4 T0 回填：GET query + sha256(secret:trans_id)）', () => {
  let redis: FakeRedis;
  let verifier: DefaultRewardedCallbackVerifier;

  beforeEach(() => {
    redis = new FakeRedis();
    // 真 ClaimService（窄接口 `ClaimReader` 结构兼容）——resolveClaim 三分类调真 read
    verifier = new DefaultRewardedCallbackVerifier(
      new ClaimService(redis as unknown as Redis),
      workingSecrets(),
    );
  });

  /* ================================================================ *
   * ① 验签面（真算法；query 形态）
   * ================================================================ */

  it('真签正例：八字段齐 + sha256(secret:trans_id) ⇒ {ok:true, extra, transId}', async () => {
    await expect(verifier.verify({ query: signedQuery() })).resolves.toEqual({
      ok: true,
      extra: VALID_FIELDS.extra,
      transId: 'T-1',
    });
  });

  it('算法正交点：签名只吃 secret+trans_id——改 extra/adpid/provider 等不影响验签通过', async () => {
    // （身份改串的拒绝在链上 claim 层；验签器按官方算法对此不敏感——钉住这一性质防「增强」）
    await expect(
      verifier.verify({ query: signedQuery({ extra: 'tampered-nonce-0000000000' }) }),
    ).resolves.toMatchObject({ ok: true, transId: 'T-1' });
  });

  it('大写 hex sign 边界：双侧 lowercase 归一 ⇒ 验签通过（平台 sign 大小写都合法）', async () => {
    const upper = signHex('T-1', SECRET).toUpperCase();
    expect(upper).toMatch(/^[0-9A-F]+$/); // 先自证测试输入确为大写
    await expect(verifier.verify({ query: signedQuery({ sign: upper }) })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('可选字段：带 cpm（签名不覆盖它）⇒ 验签通过', async () => {
    await expect(verifier.verify({ query: signedQuery({ cpm: '1250' }) })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("坏签名：sign 改一位（等长 hex）⇒ {ok:false, reason:'bad_sign'}", async () => {
    const good = signHex('T-1', SECRET);
    // 确定性翻转：替换首字为**必不相同**的小写 hex（≥'8'→'0'，否则→'8'）——
    // 不得以「与原值可能相同」的翻构造例（小写 hex 下偶发空翻 = 假绿/误发面）。
    const flipped = (good[0] >= '8' ? '0' : '8') + good.slice(1);
    expect(flipped).not.toBe(good);
    expect(flipped).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifier.verify({ query: signedQuery({ sign: flipped }) })).resolves.toEqual({
      ok: false,
      reason: 'bad_sign',
    });
  });

  it("坏签名：sign 非 hex（含 g/空格）/ 长度不符 ⇒ {ok:false, reason:'bad_sign'}", async () => {
    await expect(
      verifier.verify({ query: signedQuery({ sign: 'g'.repeat(64) }) }),
    ).resolves.toEqual({ ok: false, reason: 'bad_sign' });
    await expect(verifier.verify({ query: signedQuery({ sign: 'abc' }) })).resolves.toEqual({
      ok: false,
      reason: 'bad_sign',
    });
  });

  it('坏签名：服务端密钥不同（如夹具错配）⇒ bad_sign（确定性失败，不抛）', async () => {
    const otherVerifier = new DefaultRewardedCallbackVerifier(
      new ClaimService(redis as unknown as Redis),
      secretReaderOf(async () => ({ [SECRET_KEY]: 'b'.repeat(64) })),
    );
    await expect(otherVerifier.verify({ query: signedQuery() })).resolves.toEqual({
      ok: false,
      reason: 'bad_sign',
    });
  });

  it("缺必填字段（adpid/provider/platform/trans_id 各缺一）⇒ malformed——**不抛**（形状面不需要密钥）", async () => {
    for (const missing of ['adpid', 'provider', 'platform', 'trans_id'] as const) {
      await expect(verifier.verify({ query: queryWithout(missing) })).resolves.toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it("user_id 空串/缺字段 ⇒ 形状合格（平台常态：仅信息性，身份只来自 extra；2026-10-18 真机回调为 user_id=）", async () => {
    // 官方 wire 全集含 user_id，但平台未绑定用户时发**空值**（真机实抓：`user_id=`）。
    // 规格 §2.4：user_id 仅信息性、不作受益依据 ⇒ 不得因它把回调判成 malformed。
    await expect(verifier.verify({ query: signedQuery({ user_id: '' }) })).resolves.toEqual({
      ok: true,
      extra: VALID_FIELDS.extra,
      transId: 'T-1',
    });
    await expect(verifier.verify({ query: queryWithout('user_id') })).resolves.toEqual({
      ok: true,
      extra: VALID_FIELDS.extra,
      transId: 'T-1',
    });
  });

  it("缺 sign / 空 sign ⇒ bad_sign（规格 §2.4:196 逐字；**不是** malformed）", async () => {
    await expect(verifier.verify({ query: queryWithout('sign') })).resolves.toEqual({
      ok: false,
      reason: 'bad_sign',
    });
    await expect(verifier.verify({ query: signedQuery({ sign: '' }) })).resolves.toEqual({
      ok: false,
      reason: 'bad_sign',
    });
  });

  it('缺 sign 时密钥读面**不得被调用**（确定性失败先于配置面——未配置期缺 sign 也不得变 503）', async () => {
    const noRead = new DefaultRewardedCallbackVerifier(
      new ClaimService(redis as unknown as Redis),
      secretReaderOf(async () => {
        throw new Error('密钥读面不应被调用（缺 sign 必须在拉取密钥之前判定 bad_sign）');
      }),
    );
    await expect(noRead.verify({ query: queryWithout('sign') })).resolves.toEqual({
      ok: false,
      reason: 'bad_sign',
    });
    await expect(noRead.verify({ query: signedQuery({ sign: '' }) })).resolves.toEqual({
      ok: false,
      reason: 'bad_sign',
    });
  });

  it("缺 extra 字段（在场性要求）⇒ malformed；但空串 extra **放行**给 claim 层（验签通过带 extra:''）", async () => {
    await expect(verifier.verify({ query: queryWithout('extra') })).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });
    await expect(verifier.verify({ query: signedQuery({ extra: '' }) })).resolves.toEqual({
      ok: true,
      extra: '',
      transId: 'T-1',
    });
  });

  it("空串必填（adpid/provider/platform/trans_id）⇒ malformed（设计沉默，无 claim 侧归属通路）", async () => {
    for (const empty of ['adpid', 'provider', 'platform', 'trans_id'] as const) {
      await expect(verifier.verify({ query: signedQuery({ [empty]: '' }) })).resolves.toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('密钥拉取不可用（AdChannelUnavailableError）⇒ verify 原样上抛同瞬态类（回调层归 5xx 等重投）', async () => {
    const boom = new AdChannelUnavailableError('config.adChannel.get 拉取失败（无 lastGood）');
    const failing = new DefaultRewardedCallbackVerifier(
      new ClaimService(redis as unknown as Redis),
      secretReaderOf(async () => {
        throw boom;
      }),
    );
    await expect(failing.verify({ query: signedQuery() })).rejects.toThrow(AdChannelUnavailableError);
  });

  it('密钥图在场但缺键（{} 全未配置）⇒ 抛 AdChannelUnavailableError（同瞬态口径——不伪装确定性失败）', async () => {
    const unconfigured = new DefaultRewardedCallbackVerifier(
      new ClaimService(redis as unknown as Redis),
      secretReaderOf(async () => ({})),
    );
    await expect(unconfigured.verify({ query: signedQuery() })).rejects.toThrow(
      AdChannelUnavailableError,
    );
  });

  /* ================================================================ *
   * ② resolveClaim（三分类；调真 ClaimService.read）
   * ================================================================ */

  it('ok：记录在场 ⇒ {userId, date}（issued 与 done 皆同——身份只来自 claim 记录）', async () => {
    redis.store.set(REC('n-issued'), recordJson());
    redis.store.set(REC('n-done'), recordJson({ state: 'done', result: 'granted' }));

    await expect(verifier.resolveClaim('n-issued')).resolves.toEqual({ userId: 'u-1', date: '2026-10-01' });
    await expect(verifier.resolveClaim('n-done')).resolves.toEqual({ userId: 'u-1', date: '2026-10-01' });
  });

  it('invalid：不存在（含过期同义）⇒ {invalid:true}——上层 claim_invalid（200、不建键）', async () => {
    await expect(verifier.resolveClaim('never-existed-nonce00')).resolves.toEqual({ invalid: true });
  });

  it('invalid：畸形记录（非 JSON / 形状不符——T12 读作 null）⇒ {invalid:true}（「畸形 ⇒ invalid」归类）', async () => {
    redis.store.set(REC('n-bad-json'), 'not-json{');
    redis.store.set(REC('n-bad-shape'), JSON.stringify({ userId: 'u-1' }));

    await expect(verifier.resolveClaim('n-bad-json')).resolves.toEqual({ invalid: true });
    await expect(verifier.resolveClaim('n-bad-shape')).resolves.toEqual({ invalid: true });
  });

  it("readFailure：读取故障（Redis 连接异常）⇒ {readFailure:true}（瞬态）——**不得与 invalid 混同**（同载荷双侧）", async () => {
    redis.store.set(REC('n-2'), recordJson());
    redis.failKeys.add(REC('n-2'));

    const failure = await verifier.resolveClaim('n-2');
    expect(failure).toEqual({ readFailure: true });
    expect(failure).not.toEqual({ invalid: true }); // 与「不存在」分类互斥

    redis.failKeys.delete(REC('n-2')); // 解除故障 ⇒ 同载荷归 ok（判别力对照）
    await expect(verifier.resolveClaim('n-2')).resolves.toEqual({ userId: 'u-1', date: '2026-10-01' });
  });
});

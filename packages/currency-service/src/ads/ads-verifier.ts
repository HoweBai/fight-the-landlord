/**
 * 广告片 T13 / **T0 回填已落**（规格 v1.4 §2.4/§8 官方实文）：**回调验签器**。
 *
 * ─── 契约出处 ─────────────────────────────────────────────────────────────
 *  规格 v1.4 §2.4（方法 = HTTP GET；字段全集；`sign = sha256(secret:trans_id)`；
 *  响应 JSON `{"isValid":…}`）· 设计 §4.2（两个独立可测单元：验签
 *  `query → {ok:true, extra, transId} | {ok:false, reason}`；claim 解析
 *  `resolveClaim(extra) → {userId, date} | 失败分类`）。
 *
 * ─── 形状分类面（实现无关；不需要密钥）────────────────────────────────────
 *  GET query 字段全集（wire 名逐字）：`adpid · provider · platform · sign ·
 *  trans_id · user_id · extra · cpm?`。
 *  - 四枚业务字段（`adpid/provider/platform/trans_id`）**非空必填**，缺一/空串 ⇒
 *    `{ok:false, reason:'malformed'}`（确定性拒绝）；`user_id` **允许空/缺**（平台未绑定
 *    用户时真机实抓为 `user_id=`；规格 §2.4：仅信息性、不作受益依据）；
 *  - **`sign` 独立判定**（规格 §2.4 逐字：「缺 `sign` / 验签失败 ⇒ `bad_sign` 桶」）：
 *    缺/空 sign ⇒ `{ok:false, reason:'bad_sign'}`，在**拉取密钥之前**返回
 *    （确定性失败不依赖配置——未配置期缺 sign 也不得变 503）；
 *  - `extra` **必须在场、空串放行**（T13 审查裁定沿用：空串属平台文档常态
 *    「如无需要则为空」⇒ 交 `resolveClaim('')` ⇒ `claim_invalid`，不归 malformed）；
 *  - `cpm` 可选、本层不消费（收益信息面，签名亦不覆盖它）；
 *  - **无 ts、无时间窗**（v1.4 字段全集无时间；重放防护由 claim 状态 + 账本锚幂等承担，
 *    trans_id 不独立落库去重）。
 *
 * ─── 验签核心（唯一算法点）────────────────────────────────────────────────
 *  `sign = sha256("<secret>:<trans_id>")` hex lowercase（官方示例逐字）：
 *  - `secret` = 第四键空间唯一键 `ad.callbackSecret`，经 `AdChannelConfigService`
 *    **每回调现拉 + lastGood**；拉取失败无回落 / 密钥图缺键 ⇒ 抛
 *    `AdChannelUnavailableError`（**瞬态**：回调 5xx 等平台重投；不伪装成坏签名）；
 *  - 双侧 hex lowercase 归一；`timingSafeEqual` 常数时间比较（先比长度/字集，防等长前提外抛）；
 *  - 缺/空 `sign` ⇒ `bad_sign`（不查密钥，先于配置面）；签名非 hex/不匹配 ⇒ `bad_sign`（确定性拒绝）。
 *  - 身份只来自 `extra` 里的 claim（§2.4/§2.9）：`user_id` 仅信息性，**不**作受益依据，
 *    本层不与任何身份面交叉校验。
 *
 * ─── 接线 ─────────────────────────────────────────────────────────────────
 *  DI 纪律：被注入类一律**值导入**（类型导入会被擦除 ⇒ 容器启动即崩）；
 *  形参类型用窄接口（`ClaimReader` / `CallbackSecretReader`），单测可注桩。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AD_CHANNEL_KEYS, type AdChannelKey } from '@fight-the-landlord/protocol';
import { ClaimService } from './claim.service';
import type { ReliefResult } from './claim.service';
import { AdChannelConfigService, AdChannelUnavailableError } from './ad-channel.config.service';

/** 验签器入参：GET 回调的 query（控制器从 `req.url` 解析后原样传入；GET 无 body）。 */
export interface RewardedCallbackRequest {
  query: URLSearchParams;
}

/**
 * 确定性拒绝原因（词面封闭；映射回调指标 `relief_callback_total{result}` 的
 * `malformed` / `bad_sign` 两桶——§2.7 枚举逐字）。
 *  - `malformed`：query 畸形/缺五枚业务必填字段（`extra` 空串**不**在此列——交 claim 层）；
 *  - `bad_sign`：缺/空 `sign`、签名非 hex、或与 `sha256(secret:trans_id)` 不符。
 *
 * `extra` 空串归 claim 层（设计 §4.3 逐字「`extra` 无法解析为 claim ⇒ 拒发
 * `not_granted:claim_invalid`」）⇒ well-formed 路径 ⇒ `resolveClaim('')`
 * ⇒ `{invalid:true}` ⇒ `claim_invalid` / 200 / 监控桶归属正确。
 */
export type RewardedCallbackReason = 'bad_sign' | 'malformed';

/** 验签输出：`{ok:true, extra, transId}`（`transId` 为 wire `trans_id` 的内部名——链内日志唯一消费点）。 */
export type RewardedCallbackVerifyResult =
  | { ok: true; extra: string; transId: string }
  | { ok: false; reason: RewardedCallbackReason };

/**
 * `resolveClaim` 的最小读面（**窄接口**——结构兼容 T12 `ClaimService.read` 逐字；
 * 单测可注入桩/假库。`'read-failure'` = 连接故障（瞬态，**不与 `null` 混同**）。
 */
export interface ClaimReader {
  read(
    nonce: string,
  ): Promise<
    { userId: string; date: string; state: 'issued' | 'done'; result?: ReliefResult } | null | 'read-failure'
  >;
}

/** 密钥图消费面的最小读面（结构兼容 `AdChannelConfigService.get` 逐字；单测可注桩）。 */
export interface CallbackSecretReader {
  get(): Promise<Partial<Record<(typeof AD_CHANNEL_KEYS)[number], string>>>;
}

/**
 * claim 解析三分类（简报 Interfaces 逐字）：
 *  - `{userId, date}`：记录在场（issued/done 皆同——身份只来自 claim 记录，state 属回调链）；
 *  - `{invalid: true}`：不存在/过期/畸形（T12 读作 `null`）⇒ 上层 `claim_invalid`（200、
 *    **不建键**）；
 *  - `{readFailure: true}`：Redis 读取故障（瞬态）⇒ 上层 5xx 可重投（**不得**归 claim_invalid）。
 */
export type ResolveClaimResult =
  | { userId: string; date: string }
  | { invalid: true }
  | { readFailure: true };

/** 验签器契约（本期唯一实现 = 同文件 `DefaultRewardedCallbackVerifier`）。 */
export interface RewardedCallbackVerifier {
  /** 验签：形状分类（malformed）→ 签名校验（bad_sign）；密钥不可用 ⇒ 抛瞬态。 */
  verify(request: RewardedCallbackRequest): Promise<RewardedCallbackVerifyResult>;
  /** claim 解析（三分类；消费 T12 `read`）。 */
  resolveClaim(extra: string): Promise<ResolveClaimResult>;
}

/** 形状分类抽取后的字段（内部形；wire `trans_id`/`user_id` 在此改名）。 */
interface CallbackFields {
  adpid: string;
  provider: string;
  platform: string;
  sign: string;
  transId: string;
  userId: string;
  extra: string;
}

/** 第四键空间唯一键具名常量（防未来扩键时下标漂移；与 protocol `AD_CHANNEL_KEYS` 单键对钉）。 */
const CALLBACK_SECRET_KEY: AdChannelKey = AD_CHANNEL_KEYS[0];

/**
 * 形状分类：query 解析 → 五枚业务必填非空 + `extra` 在场（空串放行）。
 * 不合格 ⇒ `null` ⇒ 上层归 `malformed`（确定性拒绝；不需要密钥）。
 *
 * 分字段守卫（v1.4 §2.4 裁定）：
 *  - `extra`：在场即收——空串交 `resolveClaim('')`；
 *  - 四枚业务必填（`adpid/provider/platform/trans_id`）：空串按「无可用值」论 ⇒ malformed；
 *  - `user_id`：**可选**（缺省/空串一律收作 `''`）——平台未绑定用户时真机回调为 `user_id=`，
 *    且规格 §2.4 明示其「仅信息性、不作受益依据」⇒ 不得因它拒绝回调（2026-10-18 真机修复）；
 *  - `sign` **不在此守卫**：缺/空沉到签名面归 `bad_sign`（规格逐字；且不触发密钥读面）。
 *
 * 值**不 trim**（byte-exact：trans_id 参与签名；claim nonce 为 base64url 原值）。
 */
function extractCallbackFields(request: RewardedCallbackRequest): CallbackFields | null {
  const params = request.query;
  const adpid = params.get('adpid');
  const provider = params.get('provider');
  const platform = params.get('platform');
  const sign = params.get('sign');
  const transId = params.get('trans_id');
  const userId = params.get('user_id');
  const extra = params.get('extra');
  if (typeof extra !== 'string') return null; // extra 缺字段 ⇒ malformed；空串放行（设计 §4.3）
  if (!adpid || !provider || !platform || !transId) return null;
  return { adpid, provider, platform, sign: sign ?? '', transId, userId: userId ?? '', extra };
}

/** 缺省实现（v1.4 算法已落；类形状与分类面不变）。 */
@Injectable()
export class DefaultRewardedCallbackVerifier implements RewardedCallbackVerifier {
  /**
   * ⚠️ **值导入**两依赖（DI 陷阱纪律）+ 显式 `@Inject`（不依赖
   * `emitDecoratorMetadata` 的隐式注入——vitest/esbuild 不发 `design:paramtypes`）。
   * 形参类型用窄接口（`ClaimService` / `AdChannelConfigService` 结构兼容）。
   */
  constructor(
    @Inject(ClaimService) private readonly claims: ClaimReader,
    @Inject(AdChannelConfigService) private readonly channelSecrets: CallbackSecretReader,
  ) {}

  /**
   * 验签（分类先行）：形状不合格 ⇒ **确定性分类** `{ok:false, reason:'malformed'}`
   * （不依赖密钥）；形状合格 ⇒ 签名核心（密钥不可用 ⇒ 抛瞬态；签名不符 ⇒ bad_sign）。
   */
  async verify(request: RewardedCallbackRequest): Promise<RewardedCallbackVerifyResult> {
    const fields = extractCallbackFields(request);
    if (fields === null) return { ok: false, reason: 'malformed' };
    return this.verifySignedFields(fields);
  }

  /** claim 解析三分类（消费 T12 `read`；`'read-failure'` 与 `null` **不得混同**）。 */
  async resolveClaim(extra: string): Promise<ResolveClaimResult> {
    const record = await this.claims.read(extra);
    if (record === 'read-failure') return { readFailure: true }; // 瞬态 ⇒ 回调 5xx 等重投
    if (record === null) return { invalid: true }; // 不存在/过期/畸形 ⇒ claim_invalid（不建键）
    return { userId: record.userId, date: record.date };
  }

  /**
   * 验签核心（v1.4 唯一算法点）：
   *  ⓪ 缺/空 `sign` ⇒ `bad_sign`（**先于密钥读面**——确定性失败不依赖配置，规格 §2.4:196）；
   *  ① 现拉密钥图（失败无 lastGood ⇒ `AdChannelUnavailableError` 瞬态，原样上抛）；
   *  ② 密钥缺键同样按瞬态（平台开通前/管理页未配 —— 保持可重投，不伪装确定性失败）；
   *  ③ `expected = sha256("<secret>:<trans_id>")` hex lowercase；平台 sign 归一 lowercase；
   *  ④ 长度/hex 字集不等或 `timingSafeEqual` 不符 ⇒ `bad_sign`；相符 ⇒ 放行（带 extra/transId）。
   */
  private async verifySignedFields(fields: CallbackFields): Promise<RewardedCallbackVerifyResult> {
    if (!fields.sign) return { ok: false, reason: 'bad_sign' };
    const values = await this.channelSecrets.get();
    const secret = values[CALLBACK_SECRET_KEY];
    if (!secret) {
      // 密钥图在场但缺键（={} 全未配置）：与「拉取不可用」同属瞬态（§2.3 无 lastGood 口径）。
      throw new AdChannelUnavailableError(
        '广告回调密钥未配置（ad.callbackSecret 缺键）——按瞬态处置（回调 5xx，等平台重投）',
      );
    }
    const expected = createHash('sha256').update(`${secret}:${fields.transId}`, 'utf8').digest('hex');
    const actual = fields.sign.toLowerCase();
    if (!/^[0-9a-f]+$/.test(actual) || actual.length !== expected.length) {
      return { ok: false, reason: 'bad_sign' };
    }
    if (!timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return { ok: false, reason: 'bad_sign' };
    }
    return { ok: true, extra: fields.extra, transId: fields.transId };
  }
}

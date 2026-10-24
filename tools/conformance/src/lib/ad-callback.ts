/**
 * 广告片 T20 / **T0 回填已落**（规格 v1.4 §2.4/§8）：**回调签名 helper**
 * （slice-18 G 组与 slice-24 共用）。
 *
 * ─── 它是什么 / 为什么存在 ─────────────────────────────────────────────────────
 * 平台回调的**本地签名**：conformance 要投递「平台会发来的」回调样本（正路 / 坏签名 /
 * 改串…），需要一个与产品侧验签核心独立的签名面。**不建 stub 容器**
 * （起飞实读：ads 无出站调用——支付宝 stub 先例的成立原因不存在；规格 §5.4 逐字）。
 *
 * ─── 真实算法（官方文档实文；规格 v1.4 §2.4 唯一算法点）──────────────────────
 *  - 方法 = HTTP **GET**（字段走 query，无 body）；
 *  - 字段全集（wire 名**逐字**）：`adpid · provider(china/global) · platform
 *    (iOS/Android/weixin-mp) · sign · trans_id · user_id · extra · cpm?`——**无 ts**；
 *  - **`sign = sha256("<secret>:<trans_id>")` hex lowercase**（摘要只吃密钥与交易号；
 *    其余字段不参与签名——改串样本改 `extra` 不影响签名合法性，坏签名身份由验签后
 *    「claim 不存在/不匹配」在链上另路兜底的形态由切片构造）；
 *  - 应答唯一确认信号 = JSON `{"isValid": true}`（切片侧断言，不在本文件）。
 *
 * ─── 密钥同源（byte-exact；错一枚字符 ⇒ 全量 bad_sign 假红）──────────────────
 *  `tools/conformance/fixtures/ad-callback/callback-secret.txt`（生成器
 *  `generate-fixtures.mjs` 产物；32B hex、无尾换行）= 本文件签名 + conformance-stack.sh
 *  经管理面 PUT 入 `ad_channel_config` 的**同一枚值**；产品侧验签器经第四键空间现拉。
 *  `AD_CALLBACK_KEYS_DIR` 可指它处（栈脚本注入先例）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 回调字段（v1.4 §2.4 wire 全集；与 `ads-verifier.ts` 的 `CallbackFields` **逐字同形**）。
 *  `extra` = claim nonce（22 字符 base64url；空串属平台文档常态「如无需要则为空」——
 * 空串样本要走 claim 层，不参与形状拒绝）。
 */
export interface AdCallbackFields {
  adpid: string;
  provider: string;
  platform: string;
  trans_id: string;
  user_id: string;
  extra: string;
  cpm?: string;
}

/** 回调 query 参数形态（字段 + `sign`）。 */
export type AdCallbackParams = Record<string, string>;

/**
 * 共享密钥装载失败（**夹具面故障**——区别于「刻意构造的坏签名样本」）：
 * 缺文件/空文件都响亮抛，绝不静默降级成无签名样本（那会让下游把坏样本当负例）。
 */
export class AdCallbackSecretLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdCallbackSecretLoadError';
  }
}

/** fixtures 目录（本文件编译后在 `dist/lib/` ⇒ 同深度相对路径；`/keys` 挂载先例的可覆盖点）。 */
const DEFAULT_KEYS_DIR = join(__dirname, '..', '..', 'fixtures', 'ad-callback');

/**
 * 只读装载广告回调共享密钥（签名面）。
 *  - 缺文件/空文件 ⇒ 抛 `AdCallbackSecretLoadError`（响亮——先跑生成器）；
 *  - **尾部行结束符统剥**（`\r?\n` 任意个；生成器不写尾换行，此剥为跨平台/编辑器误改兜底；
 *    值本身为 hex、内部不含空白，剥尾安全）；
 *  - `AD_CALLBACK_KEYS_DIR` 可指它处。
 */
export function loadAdCallbackSecret(keysDir = process.env.AD_CALLBACK_KEYS_DIR || DEFAULT_KEYS_DIR): string {
  const file = join(keysDir, 'callback-secret.txt');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new AdCallbackSecretLoadError(
      `广告回调共享密钥夹具读不到：${file}（${(err as Error).message}）——` +
        `先跑 tools/conformance/fixtures/ad-callback/generate-fixtures.mjs`,
    );
  }
  const secret = raw.replace(/\r?\n+$/g, '');
  if (!secret) {
    throw new AdCallbackSecretLoadError(`广告回调共享密钥夹具为空：${file}——重跑 generate-fixtures.mjs`);
  }
  return secret;
}

/**
 * 唯一算法点（官方示例逐字；规格 v1.4 §2.4）：对 `"<secret>:<trans_id>"` 做一次
 * sha256，输出 **hex lowercase**（产品侧验签双侧归一大小写后常数时间比较）。
 */
export function signAdCallbackSource(transId: string, secret: string): string {
  return createHash('sha256').update(`${secret}:${transId}`, 'utf8').digest('hex');
}

/**
 * 回调整体签名（便捷面）：`fields` ⇒ 附 `sign`（= sha256(secret:trans_id)）的 query 参数形态。
 * 密钥缺省从夹具文件装载（亦可显式传入——轮换探针用）。
 */
export function signAdCallback(fields: AdCallbackFields, secret?: string): AdCallbackParams {
  const sec = secret ?? loadAdCallbackSecret();
  const params: AdCallbackParams = {
    adpid: fields.adpid,
    provider: fields.provider,
    platform: fields.platform,
    trans_id: fields.trans_id,
    user_id: fields.user_id,
    extra: fields.extra,
  };
  if (fields.cpm !== undefined) params.cpm = fields.cpm;
  params.sign = signAdCallbackSource(fields.trans_id, sec);
  return params;
}

/**
 * 目标传输形态（GET query；URLSearchParams 逐值编码——nonce 的 base64url 字母表天然安全）。
 */
export function toQueryString(params: AdCallbackParams): string {
  return new URLSearchParams(params).toString();
}

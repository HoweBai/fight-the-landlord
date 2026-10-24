/**
 * 广告片（规格 §2.3 克隆先例）：广告回调密钥的**独立键空间**（第四键空间，工作名 1 枚，
 * T0-2 回填可改名——影响面 = 本常量 + redact 名 + 测试，低）。
 *
 * ⚠️ 本键**不入** `CONFIG_KEYS`（49 键面零改动）：广告凭据是**第四键空间**，
 * **不进广播快照**（结构上不在 49 键面），只经**专用拉取通道** `config.adChannel.get`
 * 下发（消费侧 = currency-service 回调链：每次现拉 + lastGood，无 lastGood ⇒ 回调 5xx，
 * §2.3）。第 41 键 `ad.reliefAdpid` 是参数键（在广播面），与本键空间无涉。
 *
 * ⚠️ 本文件是**纯常量/类型**——**不 import 任何 `node:*` 或运行期依赖**：它经
 * `src/index.ts` 的 `export *` 进入客户端依赖面（`apps/client` 只允许依赖本包，
 * Vite 会把 node 内建换成「一旦访问就抛错」的空模块）。与 `./rpc.ts` 之间是
 * `import type` 的类型级反向引用（编译期擦除，无运行期依赖）——同 `./pay-channel.ts` 先例。
 */
import type { RpcMeta } from './rpc';

/** 键名单恰 1 枚（工作名，T0-2 回填可改名——规格 §2.3）——**顺序即管理页显示序**。 */
export const AD_CHANNEL_KEYS = ['ad.callbackSecret'] as const;
export type AdChannelKey = (typeof AD_CHANNEL_KEYS)[number];

/**
 * 机密集 = **全键**（规格 §2.3：「`AD_CHANNEL_SECRET_KEYS` = 全键」）——管理 GET 对密键
 * 只回指纹不回明文（`value` 恒 null）；审计对密键落 `{"redacted":true,"fingerprint":"<12hex>"}`
 * （照 pay/notify 先例，§2.3）。
 */
export const AD_CHANNEL_SECRET_KEYS = ['ad.callbackSecret'] as const satisfies readonly AdChannelKey[];

/**
 * `config.adChannel.get` 入参（规格 §2.3）：广告凭据**专用拉取通道**
 * （currency-service → config-service）。
 *
 * `pullToken` 与 env `AD_CHANNEL_PULL_TOKEN` 以**常数时间**比对
 * （`timingSafeEqual(sha256(a), sha256(b))`；env 未设（`||` 空串）⇒ 一律拒——§2.3）；
 * T7 接收侧消费（pattern 常量与接收侧同提交，J21 闸）。
 */
export interface ConfigAdChannelGetRequest {
  pullToken: string;
  /** R1104/R1105 同款：RPC 元数据（每调用 `.send` 带 `...metaFromTrace()`）。 */
  meta?: RpcMeta;
}

/**
 * `config.adChannel.get` 响应 data（规格 §2.3；照 `config.payChannel.get` 先例）：
 * `values` 仅含**已配置**键（缺键不补）；消费面读 `res.values`。`RpcResult` 信封在调用侧包，
 * 不在类型内（照 `config.snapshot` R220 先例）。
 */
export interface ConfigAdChannelGetResponse {
  values: Partial<Record<AdChannelKey, string>>;
}

/**
 * 支付配置管理化片（规格 §2.1 / 设计 D1 逐字）：支付渠道凭据的**独立键空间**。
 *
 * ⚠️ 六键**不入** `CONFIG_KEYS`（49 键面零改动）：
 * 渠道键是**第二键空间**，**不进广播快照**（`config.snapshot` 响应里不得出现
 * `pay.channel` 子串，§5.2 ⑤），只经**专用拉取通道** `config.payChannel.get`
 * 下发（payment-service 每渠道调用现拉，D3/§3.3）。
 *
 * ⚠️ 本文件是**纯常量/类型**——**不 import 任何 `node:*` 或运行期依赖**：它经
 * `src/index.ts` 的 `export *` 进入客户端依赖面（`apps/client` 只允许依赖本包，
 * Vite 会把 node 内建换成「一旦访问就抛错」的空模块）。与 `./rpc.ts` 之间是
 * `import type` 的类型级反向引用（编译期擦除，无运行期依赖）——同 `./currency.ts` 先例。
 */
import type { RpcMeta } from './rpc';

/** 渠道键六项（⚙️1 逐字）——**顺序即管理页显示序**（§2.4 的 GET 按此序组装响应）。 */
export const PAY_CHANNEL_KEYS = [
  'pay.channel.gatewayUrl',
  'pay.channel.appId',
  'pay.channel.privateKey',
  'pay.channel.publicKey',
  'pay.channel.sellerId',
  'pay.channel.publicBaseUrl',
] as const;
export type PayChannelKey = (typeof PAY_CHANNEL_KEYS)[number];

/**
 * 机密集（⚙️1：`privateKey` 为 v1 唯一）——管理 GET 对密键只回指纹不回明文
 * （`value` 恒 null，§2.4）；审计对密键落 `{"redacted":true,"fingerprint":"<12hex>"}`（⚙️17）。
 */
export const PAY_CHANNEL_SECRET_KEYS = ['pay.channel.privateKey'] as const satisfies readonly PayChannelKey[];

/**
 * `config.payChannel.get` 入参（§2.5 逐字）：渠道凭据**专用拉取通道**（payment → config-service）。
 *
 * `pullToken` 与 env `PAY_CHANNEL_PULL_TOKEN` 以**常数时间**比对
 * （`timingSafeEqual(sha256(a), sha256(b))`；env 未设 ⇒ 一律拒——§2.5 服务端序①）。
 */
export interface ConfigPayChannelGetRequest {
  pullToken: string;
  /** R1104/R1105 同款：RPC 元数据（每调用 `.send` 带 `...metaFromTrace()`，D3/§2.5）。 */
  meta?: RpcMeta;
}

/**
 * `config.payChannel.get` 响应 data（§2.5 逐字）：`values` 仅含**已配置**键（缺键不补）；
 * 密钥类值为 base64(PEM)（= 旧 env 格式，读侧零改）。`RpcResult` 信封在调用侧包，
 * 不在类型内（照 `config.snapshot` R220 先例）。
 */
export interface ConfigPayChannelGetResponse {
  values: Partial<Record<PayChannelKey, string>>;
}

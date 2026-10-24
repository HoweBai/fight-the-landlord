/**
 * 通知通道管理化片（规格 §2.1 / 设计 D1 逐字）：通知凭据（SMTP/IM）的**独立键空间**（第三键空间）。
 *
 * ⚠️ 九键**不入** `CONFIG_KEYS`（49 键面零改动）：通知键是独立键空间，**不进广播快照**
 * （`config.snapshot` 响应里不得出现 `notify.` 子串，§5.2 ②），只经**专用拉取通道**
 * `config.notifyChannel.get` 下发（消费端 = alert-relay / am-renderer，30s 轮询、无 meta，⚙️8）。
 *
 * ⚠️ 本文件是**纯常量/类型**——**不 import 任何 `node:*` 或运行期依赖**：它经
 * `src/index.ts` 的 `export *` 进入客户端依赖面（`apps/client` 只允许依赖本包，
 * Vite 会把 node 内建换成「一旦访问就抛错」的空模块）。与 `./rpc.ts` 之间是
 * `import type` 的类型级反向引用（编译期擦除，无运行期依赖）——同 `./pay-channel.ts` 先例。
 */
import type { RpcMeta } from './rpc';

/** 九键逐字（⚙️1）——**顺序即管理页显示序与拉取地图组装序**。 */
export const NOTIFY_CHANNEL_KEYS = [
  'notify.smtp.host', 'notify.smtp.port', 'notify.smtp.user', 'notify.smtp.pass',
  'notify.email.to',
  'notify.webhook.feishuUrl', 'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl', 'notify.webhook.dingtalkSecret',
] as const;
export type NotifyChannelKey = (typeof NOTIFY_CHANNEL_KEYS)[number];

/**
 * 机密集（⚙️1：`smtp.pass` + 三 URL + `dingtalkSecret`）——**按消费方切分**：
 * 「邮件组」= 前 5 键（am-renderer）·「IM 组」= 后 4 键（alert-relay）——两处消费面**不相交**。
 * 管理 GET 对密键只回指纹不回明文（`value` 恒 null，§2.4）；审计对密键落
 * `{"redacted":true,"fingerprint":"<12hex>"}`（§3.1）。
 */
export const NOTIFY_CHANNEL_SECRET_KEYS = [
  'notify.smtp.pass', 'notify.webhook.feishuUrl', 'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl', 'notify.webhook.dingtalkSecret',
] as const satisfies readonly NotifyChannelKey[];

/**
 * `config.notifyChannel.get` 入参（§2.5 逐字）：通知凭据**专用拉取通道**
 * （alert-relay / am-renderer → config-service）。
 *
 * `pullToken` 与 env `NOTIFY_CHANNEL_PULL_TOKEN` 以**常数时间**比对
 * （`timingSafeEqual(sha256(a), sha256(b))`；env 未设 ⇒ 一律拒——§2.5 服务端序①）。
 */
export interface ConfigNotifyChannelGetRequest { pullToken: string; meta?: RpcMeta }

/**
 * `config.notifyChannel.get` 响应 data（§2.5 逐字）：`values` 仅含**已配置**键（缺键不补）；
 * 值 = 存储 canonical（URL 逐字保真）。`RpcResult` 信封在调用侧包，不在类型内
 * （照 `config.snapshot` R220 先例）。⚠️ 消费端**不带 meta**（relay/renderer 非 Nest 服务、
 * 无 trace 基建——⚙️8 偏离登记）：`meta?` 字段照 R1104/R1105 先例保留，服务端不依赖之。
 */
export interface ConfigNotifyChannelGetResponse { values: Partial<Record<NotifyChannelKey, string>> }

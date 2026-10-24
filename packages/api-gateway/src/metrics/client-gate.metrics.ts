/**
 * api-gateway 的指标定义（客户端接入片 T5；**prom-client 注册骨架**）。
 *
 * ⚠️ **本文件只定义、不写入**：写点在 `auth/client-gate.middleware.ts`（HTTP 第 0 步的
 * 拒绝/未识别两个收口）—— 与 payment-service 的 `payment.metrics.ts` 同一分工。
 *
 * ⚠️ **一切指标必须经 shared 的 `createCounter`（不直连 prom-client）**：
 * 那对构造器强制 `registers: [metricsRegistry()]`（单例注册表同一性纪律 —— 直连
 * prom-client 的类构造器会静默落进 globalRegistry，`/metrics` 输出里看不到它、且
 * **不会报错**）。
 *
 * 两计名（规格 §0 逐字；**无前缀** —— 与 `http_requests_total` 一族同形）：
 *  `client_gate_blocked_total{platform}` · `client_gate_unidentified_total`。
 */
import { createCounter } from '@fight-the-landlord/shared';

/**
 * `client_gate_blocked_total{platform}`（§0 逐字；`platform` ∈ `app/h5`）。
 *
 * **写点 = `auth/client-gate.middleware.ts` 的单一拒绝收口**：每一次 403+10008 恰计一次
 * （platform 已被 `classifyClientPlatform` 归一为枚举 —— 标签值不可能出现原始头值）。
 * 语义与 `client_gate_unidentified_total` 互补：本项证明「闸咬到了」，那一项证明
 * 「还有识别不了的流量在打」—— ⛔ 不得把二者相加/相减去推「某端实际流量」（推不出的，
 * 未识别桶不归属任何端；设计 §5.1）。
 *
 * ⚠️ **显式 `ReturnType<typeof createCounter>` 注记不是风格偏好**：本包不直接依赖
 * prom-client（类型无法在声明里命名）⇒ 不加注记时 `tsc` 报 TS2742（declaration emit
 * 要求类型可命名）。先例：currency-service `currency.metrics.ts`。
 */
export const clientGateBlockedTotal: ReturnType<typeof createCounter> = createCounter(
  'client_gate_blocked_total',
  '客户端接入闸拒绝数（按端）',
  ['platform'],
);

/**
 * `client_gate_unidentified_total`（§0 逐字；**无标签**）。
 *
 * **写点 = 同上**：计数面 = **非豁免** `/api/*` 请求中未带（或非法）平台头者
 * —— 豁免三路（admin/health/config）**排除**（防被管理端与探针流量淹没；C27）。
 * 语义 = **只读「存在性」信号**（老包 App / 脚本 / 小程序混在一个数里，**不归属任何端**）
 * —— ⛔ 判据不得把它写成「某端流量」推断（设计 §5.1）。
 */
export const clientGateUnidentifiedTotal: ReturnType<typeof createCounter> = createCounter(
  'client_gate_unidentified_total',
  '非豁免面未带/非法端标识的请求数（只读存在性信号；不归属任何端）',
);

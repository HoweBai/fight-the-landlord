/**
 * payment-service 的指标定义（**prom-client 注册骨架**；支付片规格 §2.6 的十条指标
 * T6–T15 全数落地）。
 *
 * ⚠️ **本文件只定义、不写入**：写点在各自的业务文件（T6 渠道层 / T7 订单链 / T8 回调链 /
 * T9 资金底座 / T10/T11 提现退款链 / T15 日自检）—— 与 currency-service 的
 * `currency.metrics.ts` 同一分工。
 *
 * ⚠️ **一切指标必须经 shared 的 `createCounter/createGauge`（不直连 prom-client）**：
 * 那对构造器强制 `registers: [metricsRegistry()]`（单例注册表同一性纪律 —— 直连
 * prom-client 的类构造器会静默落进 globalRegistry，`/metrics` 输出里看不到它、且
 * **不会报错**）。`boot.test.ts` 有一条源码级判据把「不得 import prom-client / 不得
 * 直呼构造器」钉住。
 *
 * 十条指标名（规格 §2.6 逐字；前缀 `payment_`，端口 9007）：
 *  `payment_notify_total{result}`（ok/bad_sign/amount_mismatch/unknown_order/reopen）·
 *  `payment_order_pending{state}`（pending_pay/paid_uncredited）·
 *  `payment_fundop_pending{op}`（pay/withdraw_hold/withdraw_rb/refund_hold/refund_rb）·
 *  `payment_fundop_oldest_age_seconds{op}` · `payment_fundop_retry_total{op}` ·
 *  `payment_refund_total{result}`（applied/approved/rejected/channel_fail）·
 *  `payment_withdraw_pending{state}`（pending/approved）·
 *  `payment_withdraw_oldest_age_seconds{state}` ·
 *  `payment_outbound_fail_total{api}`（wap_pay/query/refund/close）·
 *  `payment_reconcile_diff`。
 */
import { createCounter, createGauge } from '@fight-the-landlord/shared';

/**
 * `payment_outbound_fail_total{api}`（§2.6·10 逐字；`api` ∈ `wap_pay/query/refund/close`）。
 *
 * **写点 = T6 `channel/alipay/client.ts` 的单一失败收口**（`AlipayClient.fail()`）：
 * 每一次渠道调用"没拿到可信成功结果"（配置缺失/坏 · 传输/超时/非 200 · 验签失败 ·
 * 业务拒绝）**恰计一次**；`query` 的 `ACQ.TRADE_NOT_EXIST` 是渠道的明确回答（`found:false`）
 * ⇒ **不计数**。语义 = "这一发出去但没有可用回执的渠道调用"。
 *
 * ⚠️ **显式 `ReturnType<typeof createCounter>` 注记不是风格偏好**：本包不直接依赖
 * prom-client（类型无法在声明里命名）⇒ 不加注记时 `tsc` 报 TS2742（declaration emit
 * 要求类型可命名）。先例：currency-service `currency.metrics.ts`。
 */
export const paymentOutboundFailTotal: ReturnType<typeof createCounter> = createCounter(
  'payment_outbound_fail_total',
  'Outbound Alipay channel call failures by API (one increment per call without a trusted success result)',
  ['api'],
);

/**
 * `payment_order_pending{state}`（§2.6·2 逐字；`state` ∈ `pending_pay/paid_uncredited`）。
 *
 * **写点 = T7 `orders/orders.service.ts`**：两扫描轮末（`closeExpired`/`sweepCreated`）+ `sync`
 * 造成 paid 迁移时刷新（`refreshOrderPendingGauges`）——语义 = 两张「在途」形态的**行数**
 * 直读（`pending_pay` = `status='created'`；`paid_uncredited` = `status='paid'`，
 * 即入账重试面）。T9 的循环把两扫描挂上周期后读数自然持续前进。
 */
export const paymentOrderPending: ReturnType<typeof createGauge> = createGauge(
  'payment_order_pending',
  'Payment orders pending, by state (pending_pay = status created awaiting payment; paid_uncredited = paid awaiting crediting)',
  ['state'],
);

/**
 * `payment_notify_total{result}`（§2.6·1 逐字；`result` ∈
 * `ok/bad_sign/amount_mismatch/unknown_order/reopen`）。
 *
 * **写点 = T8 `notify/notify.service.ts`**（单一收口）——语义 = 每一条回调**恰好一计**：
 *  - `ok`      验签 + 四项校验通过且订单达到 ≥paid（首达 `paid` 与幂等 `already` 都算）；
 *  - `bad_sign` **信任门**不过：不可验签（公钥缺失/坏）· 验签失败 · `app_id`/`seller_id`
 *    ≠ 本方（含未配置）· `trade_status` 非成功集 —— 「密钥错配或攻击的第一道铃」
 *    （哨兵 = 告警 `PaymentNotifyBadSignSpike`）；
 *  - `amount_mismatch` / `unknown_order` / `reopen` 见 `notify.service.ts` 文件头映射表。
 *
 * ⚠️ **notify_log 只落「通过验签的四类」**（ok/amount_mismatch/unknown_order/reopen；
 * §2.3「仅存验签通过的通知」）——`bad_sign` **只计数不落库**（防垃圾无限增长）。
 */
export const paymentNotifyTotal: ReturnType<typeof createCounter> = createCounter(
  'payment_notify_total',
  'Alipay notify handling results (ok / bad_sign / amount_mismatch / unknown_order / reopen)',
  ['result'],
);

/**
 * `payment_fundop_pending{op}`（§2.6·3 逐字；`op` ∈ `pay/withdraw_hold/withdraw_rb/
 * refund_hold/refund_rb`）。
 *
 * **语义 = 待收敛的资金动作行数**（各自停留态的行数直读）：
 *  - `pay` = `payment_orders.status='paid'`（已收款、待入账）——**写点 = T9
 *    `scan/scan.service.ts`**（循环③轮末 + `creditOrder` 尝试后；T10/T11 的 ④⑤⑥⑦
 *    循环接力写其余四 op）。
 *
 * 哨兵 = 告警 `PaymentFundOpStalled`（由配套的 `…_oldest_age_seconds` 表达式驱动；
 * 本 gauge 供面板读数）。
 */
export const paymentFundopPending: ReturnType<typeof createGauge> = createGauge(
  'payment_fundop_pending',
  'Pending fund operations awaiting resolution, by op (pay = paid awaiting crediting)',
  ['op'],
);

/**
 * `payment_fundop_oldest_age_seconds{op}`（§2.6·4 逐字）：**最老待收敛行的年龄（秒）**。
 *
 * **写点 = T9 `scan/scan.service.ts`**（DB 时钟 `NOW(3)` 计算——单点权威；无行 ⇒ 0）。
 * 分档告警阈值（设计 §10/§2.5 表逐行）：`pay`/`withdraw_hold`/`refund_hold` > 900s、
 * `withdraw_rb`/`refund_rb` > 3600s ⇒ `PaymentFundOpStalled`（warning）——「钱动了没落账」
 * 的统一哨兵。
 */
export const paymentFundopOldestAgeSeconds: ReturnType<typeof createGauge> = createGauge(
  'payment_fundop_oldest_age_seconds',
  'Age in seconds of the oldest pending fund operation, by op (alert threshold: 900s forward / 3600s rollback)',
  ['op'],
);

/**
 * `payment_fundop_retry_total{op}`（§2.6·5 逐字）：**同锚重放次数**（恢复模型②）。
 *
 * **写点 = T9 `scan/replay-anchor.ts` 的 `replayAnchor()`**（单一收口）：每次重放恰计
 * 一次；**首尝试**路径（notify/sync 即时入账等）显式 `countRetry:false` 不计——语义 =
 * 「重试机器运转量」，不是「资金动作总量」。
 */
export const paymentFundopRetryTotal: ReturnType<typeof createCounter> = createCounter(
  'payment_fundop_retry_total',
  'Same-anchor replays performed by the recovery machinery, by op',
  ['op'],
);

/**
 * `payment_refund_total{result}`（§2.6·6 逐字；`result` ∈ `applied/approved/rejected/channel_fail`）。
 *
 * **写点 = T11 `refund/refund.service.ts`**（每笔退款在其生命周期的四个事件点各恰一计）：
 *  - `applied`  —— 申请**受理**（行已落库；含 hold 明确失败 ⇒ `failed` 的行——申请动作发生过）；
 *  - `approved` —— 审通过 claim 成功（`pending→approved`；其后渠道失败停留 approved 也计）；
 *  - `rejected` —— 审驳回 claim 成功（`pending|approved→rejecting`；回滚未落账也计——「决定」已发生）；
 *  - `channel_fail` —— 审通过后渠道退避表（1s→5s→30s→2m→10m，上限 6 发）穷尽仍无成功回执
 *    ⇒ 停留 `approved` + `last_error` 转人工（管理退款审核视图 = 人工面）。
 */
export const paymentRefundTotal: ReturnType<typeof createCounter> = createCounter(
  'payment_refund_total',
  'Refund lifecycle events by result (applied / approved / rejected / channel_fail)',
  ['result'],
);

/**
 * `payment_withdraw_pending{state}`（§2.6·7 逐字；`state` ∈ `pending/approved`）。
 *
 * **写点 = T10 `withdraw/withdraw.service.ts` 的 `refreshWithdrawGauges()`**（apply/review/
 * confirm 之后与扫描 ④⑤ 循环末）：语义 = 两张「提现在途」形态的**行数**直读
 * （`pending` = 待审；`approved` = 已审待打款）——`paid` 等终态不计（§3.2 状态机）。
 */
export const paymentWithdrawPending: ReturnType<typeof createGauge> = createGauge(
  'payment_withdraw_pending',
  'Withdrawals pending settlement, by state (pending = frozen awaiting review; approved = reviewed awaiting manual payment)',
  ['state'],
);

/**
 * `payment_withdraw_oldest_age_seconds{state}`（§2.6·8 逐字）：**最老在途提现的年龄（秒）**。
 *
 * **写点 = T10 `withdraw/withdraw.service.ts` 的 `refreshWithdrawGauges()`**（DB 时钟
 * `NOW(3)` 计算——单点权威；无行 ⇒ 0）。哨兵 = 告警 `WithdrawBacklog`
 * （`> 172800`（48h）for 10m，warning）。
 */
export const paymentWithdrawOldestAgeSeconds: ReturnType<typeof createGauge> = createGauge(
  'payment_withdraw_oldest_age_seconds',
  'Age in seconds of the oldest pending withdrawal, by state (alert threshold: 172800s backlog)',
  ['state'],
);

/**
 * `payment_reconcile_diff`（§2.6·10 逐字）：**日自检差异**（规格 §3.5 · ⚙️17；设计 §8/§14 R12）。
 *
 * **写点 = T15 `scan/scan.service.ts` 的 `runReconcileOnce()`**（日自检轮末；`pay.reconcileIntervalMs` 配置键）：
 *  - 入账勾稽 diff = |`Σ payment_orders.coins(status='credited')` − `SUM(f.delta)`（`currency_flows f
 *    JOIN currency_ops o ON o.id=f.op_id WHERE o.source='recharge'`）|；
 *  - 锚勾稽：孤儿锚（ops 有锚、本地无行 ⇒ 计入）+ 行无锚（非法态 ⇒ 计入；holding/failed 结构豁免）
 *    的**计数**；
 *  - gauge 值 = 三项之和（**任一勾稽非零即置 >0**——两类量化纲不同，>0 才是处置信号；
 *    分项读数在日志行）。
 *
 * 哨兵 = 告警 `PaymentReconcileDiff`（`> 0` for 10m，critical——钱的事故面第一道铃；
 * 失败轮**不擦旧值**：宁可陈旧，不把真实差异抹成 0）。
 */
export const paymentReconcileDiff: ReturnType<typeof createGauge> = createGauge(
  'payment_reconcile_diff',
  'Daily reconcile difference (|credited coins - recharge flows| + orphan anchors + unanchored rows; any non-zero => >0)',
);

/** 玩家管理页 / Grafana 08（2026-10-22）：入账成功订单数（仅 credited；already/stalled/skipped 不计）。 */
export const paymentRechargeCreditedTotal: ReturnType<typeof createCounter> = createCounter(
  'payment_recharge_credited_total',
  '充值入账成功订单数（仅 creditOrder 返回 credited 时 +1；重放/并发已落账/停留 paid 不计）。',
);

/** 玩家管理页 / Grafana 08（2026-10-22）：入账成功金额（分；毛充值，未扣退款）。 */
export const paymentRechargeFenTotal: ReturnType<typeof createCounter> = createCounter(
  'payment_recharge_fen_total',
  '充值入账成功金额（分，毛充值未扣退款；仅 credited 时累加）。',
);

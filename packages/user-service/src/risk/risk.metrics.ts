// packages/user-service/src/risk/risk.metrics.ts
import { createCounter, createGauge } from '@fight-the-landlord/shared';

/**
 * 风控片 user-service 的**四个指标定义**（规格 §2.12 逐字；设计 Y4/§2.4bis —— 面板
 * 「风控 / Risk」与 `RiskScanStalled` 告警的读面）。
 *
 * 🔴 **写点在别的文件**（`scan.service.ts` / `reviews.service.ts` / `admin-risk.controller.ts`，
 * T5/T6 落地）——本任务的交付只是**定义面**（名字/标签/help 逐字进 shared registry）：
 *  - `risk_scan_runs_total{result}` ⇒ T5 每轮开始 +1（`ok`/`fail` 分记）；
 *  - `risk_scan_last_success_timestamp_seconds` ⇒ T5 成功轮 set（秒）；启动置 0
 *    （「从未成功」语义 —— 首启 / 一直失败都要被 `RiskScanStalled` 命中）；失败轮**不擦**；
 *  - `risk_reviews_open` ⇒ T5 轮末 set = `status='open'` 计数（队列水位）；
 *  - `risk_actions_total{action}` ⇒ T6 每次处置动作 +1（值域 = 动作七值全集）。
 *
 * ⚠️ **显式 `ReturnType<typeof createCounter/createGauge>` 注记不是风格偏好**：本包不直接
 * 依赖 prom-client（类型无法在声明里命名）⇒ 不加注记时 `tsc` 报 TS2742（declaration emit
 * 要求类型可命名）。注记让声明按字面写入，不跨包引用 prom-client 的路径
 * （先例：`room.metrics.ts:36-39` / 本包 `records.metrics.ts`）。
 */

/** 扫描轮次计数（规格 §2.12；`result` 值域 `ok|fail`，每轮开始恰 +1）。 */
export const riskScanRunsTotal: ReturnType<typeof createCounter> = createCounter(
  'risk_scan_runs_total',
  '风险扫描轮次计数（result=ok|fail；每轮开始 +1，成败分记）。',
  ['result'],
);

/**
 * 「最近一次成功」的 Unix 时间戳（**秒**）。
 *
 * 🔴 语义的一半在**初值**：`onModuleInit` 先置 **0** —— 「从未成功」（首启 / 一直失败）
 * 也会被 `RiskScanStalled`（`time() - 值 > 7200`）命中；失败轮**不擦**（值保留上一次成功）。
 */
export const riskScanLastSuccessTimestampSeconds: ReturnType<typeof createGauge> = createGauge(
  'risk_scan_last_success_timestamp_seconds',
  '风险扫描最近一次成功的 Unix 时间戳（秒）。启动置 0（「从未成功」语义，供 RiskScanStalled 判读）；成功轮写；失败轮不擦。',
);

/** 队列水位（规格 §2.12）：`risk_reviews` 中 `status='open'` 的条目数（扫描轮末刷新）。 */
export const riskReviewsOpen: ReturnType<typeof createGauge> = createGauge(
  'risk_reviews_open',
  'risk_reviews 中 status=open 的条目数（扫描轮末刷新 = 队列水位）。',
);

/** 处置动作计数（规格 §2.12）：`action` 值域 = 动作七值全集（`reopen` 仅系统产生）。 */
export const riskActionsTotal: ReturnType<typeof createCounter> = createCounter(
  'risk_actions_total',
  '风控处置动作计数（action=auto_throttle|throttle|unthrottle|ban|unban|dismiss|reopen）。',
  ['action'],
);

/** A1：风控胜率命中次数（按玩法；设备命中不纳入本指标）。 */
export const riskScanHitsTotal: ReturnType<typeof createCounter> = createCounter(
  'risk_scan_hits_total',
  '风控胜率命中次数（按玩法；每用户每玩法命中 +1；设备命中不纳入本指标）。',
  ['game_type'],
);

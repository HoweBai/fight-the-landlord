import { Counter, Registry, collectDefaultMetrics } from 'prom-client';
import type { SinkName } from './config';

/**
 * 本包**自带**的 prom-client 注册表（规格 §2.6：**不经** shared —— relay 是独立
 * 进程/独立镜像，没有任何 Nest 侧的装配；shared 的注册表是八服务的，两者互不相干）。
 *
 * 暴露面 = `alert_deliveries_total{sink,result}` + prom-client 默认集
 * （`process_*`/`nodejs_*`：relay 自身的存活/内存可见性——「监控链自己死了」也要看得见）。
 *
 * ⚠️ 标签值域**全有界**：`sink ∈ {feishu,dingtalk,wecom}`、`result ∈ {ok,error}`；
 * **URL/secret 永不进标签**（S2③）—— 标签是长期存储，凭据进标签 = 凭据进 TSDB。
 *
 * 预置 6 条 0 序列（见下）：让 `/metrics` 与面板从第一秒就有基线，不必等首投；
 * 也让「某槽今天一次都没发过」和「槽不存在」在读数上可区分。
 */

/** 结果值域（计数器只认这两个）。 */
export type DeliveryOutcome = 'ok' | 'error';

const registry = new Registry();
// 默认集在这里注册一次（模块级单例；本进程只 import 一次）。
collectDefaultMetrics({ register: registry });

const alertDeliveriesTotal = new Counter({
  name: 'alert_deliveries_total',
  help: '告警投递次数（按槽位与结果；result=error 含超时与连接层失败）。',
  labelNames: ['sink', 'result'],
  registers: [registry],
});

const ALL_SINKS: readonly SinkName[] = ['feishu', 'dingtalk', 'wecom'];
const ALL_RESULTS: readonly DeliveryOutcome[] = ['ok', 'error'];
for (const sink of ALL_SINKS) {
  for (const result of ALL_RESULTS) {
    alertDeliveriesTotal.inc({ sink, result }, 0); // 预置 0（inc 0 = 建序列，不是投递）
  }
}

/** 记一次投递结果（server.ts 在 allSettled 逐槽回写；恰一次/次）。 */
export function recordDelivery(sink: SinkName, result: DeliveryOutcome): void {
  alertDeliveriesTotal.inc({ sink, result });
}

/** `/metrics` 的文本（OpenMetrics 之外的惯用 text/plain; version=0.0.4，与 shared 同款）。 */
export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

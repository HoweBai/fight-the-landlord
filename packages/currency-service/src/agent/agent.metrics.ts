import { createCounter } from '@fight-the-landlord/shared';

/**
 * 代理分润指标（spec §12.1）。本文件只定义、不写入；写点在
 * `agent-ledger.service.ts` / `agent-gap.service.ts` / `apply.service.ts`。
 * 全部经 shared 的 `createCounter`（监控片 registry 同一性纪律）。
 */
export const agentHookFailuresTotal: ReturnType<typeof createCounter> = createCounter(
  'agent_hook_failures_total',
  '代理钩子语句级失败次数（保存点已回滚、主事务继续）。',
  ['source'],
);

export const agentLedgerGapsTotal: ReturnType<typeof createCounter> = createCounter(
  'agent_ledger_gaps_total',
  '代理记账缺口行写入次数（agent_ledger_gaps）。',
);

export const agentRevenueEventsTotal: ReturnType<typeof createCounter> = createCounter(
  'agent_revenue_events_total',
  '台费收入事件（reason = commissioned/unbound/quota_exhausted/no_payee）。',
  ['reason'],
);

export const agentCommissionEntriesTotal: ReturnType<typeof createCounter> = createCounter(
  'agent_commission_entries_total',
  '佣金行数（按 level）。',
  ['level'],
);

export const agentCommissionMicroTotal: ReturnType<typeof createCounter> = createCounter(
  'agent_commission_micro_total',
  '佣金累计 micro（1/10000 金币）。',
);

export const agentQuotaAdminCappedTotal: ReturnType<typeof createCounter> = createCounter(
  'agent_quota_admin_capped_total',
  'admin_adjust 正数被单日额度上限裁剪的次数。',
);

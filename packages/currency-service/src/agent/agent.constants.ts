import type { CurrencySource } from '@fight-the-landlord/protocol';

/** 1 金币 = 10000 micro（佣金内部单位）。 */
export const MICRO_PER_COIN = 10_000;

/** 比例上限 = 100% = 10000bp。 */
export const RATE_BP_MAX = 10_000;

/** 代理树最大深度（含直接代理）。 */
export const AGENT_MAX_DEPTH = 5;

/** 计数佣金来源。 */
export const AGENT_ENTRY_FEE_SOURCE = 'entry_fee' as const;

/** 代理相关 source 的用途分类（13 源全覆盖，编译期 `Record<CurrencySource, …>` 强制）。 */
export type AgentSourcePurpose = 'quota' | 'entry_fee' | 'none';

export const AGENT_SOURCE_PURPOSE: Record<CurrencySource, AgentSourcePurpose> = {
  signup_grant: 'none',
  admin_adjust: 'quota',
  game_settle: 'none',
  robot_pool: 'none',
  relief_grant: 'none',
  admin_reverse: 'quota',
  recharge: 'quota',
  refund_hold: 'quota',
  refund_rollback: 'quota',
  withdraw_hold: 'quota',
  withdraw_rollback: 'quota',
  entry_fee: 'entry_fee',
  card_counter: 'none',
};

/** 未知 source（理论上不可达）按 none —— fail-safe：绝不静默计入额度。 */
export function classifyAgentSource(source: string): AgentSourcePurpose {
  return (AGENT_SOURCE_PURPOSE as Record<string, AgentSourcePurpose>)[source] ?? 'none';
}

/** revenue event 的跳过原因（有界枚举）。 */
export const AGENT_SKIP_REASONS = ['unbound', 'quota_exhausted', 'no_payee'] as const;
export type AgentSkipReason = (typeof AGENT_SKIP_REASONS)[number];

/** 结算状态机（有界枚举）。 */
export const AGENT_SETTLEMENT_STATUSES = ['pending', 'paid', 'rejected', 'cancelled'] as const;
export type AgentSettlementStatus = (typeof AGENT_SETTLEMENT_STATUSES)[number];

/** 代理状态（有界枚举）。 */
export const AGENT_STATUSES = ['active', 'frozen'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** 比例链每级结果的原因（有界枚举）。 */
export const AGENT_PAYOUT_REASONS = [
  'normal',
  'frozen_skip',
  'self_skip',
  'negative_skip',
] as const;
export type AgentPayoutReason = (typeof AGENT_PAYOUT_REASONS)[number];

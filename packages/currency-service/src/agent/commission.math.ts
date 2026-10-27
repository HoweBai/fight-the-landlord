import {
  MICRO_PER_COIN,
  RATE_BP_MAX,
  AGENT_MAX_DEPTH,
  type AgentPayoutReason,
  type AgentStatus,
} from './agent.constants';

/**
 * 代理佣金/额度的**纯函数**（无 DB、无 Nest）。
 *
 * 设计真源：spec §2.3/§2.4/D15。单位：`micro = 1/10000 金币`；
 * `rate_bp = 百分比 × 100`。所有函数对非安全整数/越界值**抛错**——
 * 静默修正会把数据损坏变成账目错误。
 */

export interface ChainAgent {
  agentId: string;
  /** 0..10000。 */
  rateBp: number;
  status: AgentStatus;
  /** 手机号 HMAC（自玩判定）。 */
  phoneHash: string;
}

export interface ChainPayout {
  agentId: string;
  /** 0 = 直接代理。 */
  level: number;
  rateBp: number;
  /** 本次实付级差 bp。 */
  paidBp: number;
  /** base × paidBp；0 表示本级不付。 */
  micro: number;
  reason: AgentPayoutReason;
}

export interface ChainResult {
  payouts: ChainPayout[];
  /** 链上最高比例（正常树 = 顶层比例；数据损坏时仍是**上界**）。 */
  topRateBp: number;
  /** base × topRateBp（对账上界；实际 Σmicro ≤ 它）。 */
  expectedMaxMicro: number;
}

function assertSafeInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${name} 必须是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return value;
}

function assertRate(rateBp: unknown, agentId: string): number {
  const n = assertSafeInt(rateBp, `agent(${agentId}).rateBp`);
  if (n < 0 || n > RATE_BP_MAX) {
    throw new Error(`agent(${agentId}).rateBp 越界：${n}（应在 0..${RATE_BP_MAX}）`);
  }
  return n;
}

/**
 * 级差分配（spec §2.3 逐字）：
 * - 冻结 ⇒ 付 0 且**推进档位**（份额归平台）；
 * - 自玩 ⇒ 付 0 且**不推进档位**（份额顺延给上一级）；
 * - 负级差 ⇒ 付 0 且 `lastPaidBp = max(lastPaidBp, rateBp)`（绝不倒贴）；
 * - 否则 `paidBp = rateBp − lastPaidBp`。
 *
 * `topRateBp = max(chain.rateBp)`（不是 `chain[last]`）：数据损坏（父 < 子）时
 * 仍保证 `Σmicro ≤ base × topRateBp`。
 */
export function computeChainPayouts(input: {
  base: number;
  chain: readonly ChainAgent[];
  playerPhoneHash: string;
}): ChainResult {
  const base = assertSafeInt(input.base, 'base');
  if (base < 0) throw new Error(`base 不能为负（收到 ${base}）`);
  if (typeof input.playerPhoneHash !== 'string') throw new Error('playerPhoneHash 必须是字符串');
  const chain = input.chain;
  if (chain.length > AGENT_MAX_DEPTH) {
    throw new Error(`代理链深度 ${chain.length} 超过上限 ${AGENT_MAX_DEPTH}（数据损坏）`);
  }
  const seen = new Set<string>();
  let topRateBp = 0;
  for (const agent of chain) {
    if (seen.has(agent.agentId)) {
      throw new Error(`代理链出现重复 agentId=${agent.agentId}（数据损坏）`);
    }
    seen.add(agent.agentId);
    topRateBp = Math.max(topRateBp, assertRate(agent.rateBp, agent.agentId));
    if (agent.status !== 'active' && agent.status !== 'frozen') {
      throw new Error(`agent(${agent.agentId}).status 非法：${String(agent.status)}`);
    }
    if (typeof agent.phoneHash !== 'string') {
      throw new Error(`agent(${agent.agentId}).phoneHash 必须是字符串`);
    }
  }

  if (base === 0) {
    return { payouts: [], topRateBp, expectedMaxMicro: 0 };
  }

  const payouts: ChainPayout[] = [];
  let lastPaidBp = 0;
  for (let level = 0; level < chain.length; level += 1) {
    const agent = chain[level]!;
    const rateBp = assertRate(agent.rateBp, agent.agentId);
    if (agent.status === 'frozen') {
      payouts.push({ agentId: agent.agentId, level, rateBp, paidBp: 0, micro: 0, reason: 'frozen_skip' });
      lastPaidBp = rateBp;
      continue;
    }
    if (agent.phoneHash === input.playerPhoneHash) {
      payouts.push({ agentId: agent.agentId, level, rateBp, paidBp: 0, micro: 0, reason: 'self_skip' });
      continue;
    }
    const paidBp = rateBp - lastPaidBp;
    if (paidBp < 0) {
      payouts.push({ agentId: agent.agentId, level, rateBp, paidBp: 0, micro: 0, reason: 'negative_skip' });
      lastPaidBp = Math.max(lastPaidBp, rateBp);
      continue;
    }
    payouts.push({
      agentId: agent.agentId,
      level,
      rateBp,
      paidBp,
      micro: base * paidBp,
      reason: 'normal',
    });
    lastPaidBp = rateBp;
  }

  return { payouts, topRateBp, expectedMaxMicro: base * topRateBp };
}

export interface QuotaState {
  inflow: number;
  consumed: number;
}

export interface QuotaDeltaResult extends QuotaState {
  /** 本次实际抵扣的入账额（仅负 delta 有意义）。 */
  deducted: number;
}

/**
 * 额度更新（spec §2.2）：
 * - 正 delta ⇒ 全额入账（admin_adjust 的日限由调用方先裁剪）；
 * - 负 delta ⇒ **最多抵扣未消耗本金** `min(-delta, max(0, inflow − consumed))`。
 *
 * 因此 `inflow ≥ consumed` 恒成立、额度永不为负；「赢钱后提现」不会压低未来佣金。
 */
export function applyQuotaDelta(state: QuotaState, delta: number): QuotaDeltaResult {
  const inflow = assertSafeInt(state.inflow, 'inflow');
  const consumed = assertSafeInt(state.consumed, 'consumed');
  const d = assertSafeInt(delta, 'delta');
  if (inflow < 0 || consumed < 0) throw new Error('inflow/consumed 不能为负');
  if (consumed > inflow) throw new Error(`不变量破坏：consumed(${consumed}) > inflow(${inflow})`);

  if (d >= 0) return { inflow: inflow + d, consumed, deducted: 0 };
  const available = Math.max(0, inflow - consumed);
  const deducted = Math.min(-d, available);
  return { inflow: inflow - deducted, consumed, deducted };
}

export interface SettlementTotals {
  totalCoins: number;
  carryAfter: number;
}

/**
 * 结算取整（spec §6.2）：
 * - `total = carryBefore + totalMicro`；
 * - `total > 0` ⇒ `totalCoins = floor(total / 10000)`、`carryAfter = total − totalCoins×10000`；
 * - `total ≤ 0` ⇒ 不付（totalCoins 0）、负余额/零头继续结转。
 */
export function computeSettlementTotals(carryBefore: number, totalMicro: number): SettlementTotals {
  const carry = assertSafeInt(carryBefore, 'carryBefore');
  const micro = assertSafeInt(totalMicro, 'totalMicro');
  const total = carry + micro;
  if (!Number.isSafeInteger(total)) throw new Error('carryBefore + totalMicro 溢出安全整数');
  if (total <= 0) return { totalCoins: 0, carryAfter: total };
  const totalCoins = Math.floor(total / MICRO_PER_COIN);
  return { totalCoins, carryAfter: total - totalCoins * MICRO_PER_COIN };
}

import { describe, expect, it } from 'vitest';
import {
  MICRO_PER_COIN,
  classifyAgentSource,
  AGENT_SOURCE_PURPOSE,
} from '../src/agent/agent.constants';
import {
  applyQuotaDelta,
  computeChainPayouts,
  computeSettlementTotals,
  type ChainAgent,
} from '../src/agent/commission.math';

const agent = (
  id: string,
  rateBp: number,
  opts: Partial<Pick<ChainAgent, 'status' | 'phoneHash'>> = {},
): ChainAgent => ({
  agentId: id,
  rateBp,
  status: opts.status ?? 'active',
  phoneHash: opts.phoneHash ?? `phone-${id}`,
});

const PLAYER = 'phone-player';

describe('classifyAgentSource：13 源全覆盖', () => {
  it('矩阵穷尽 13 个 currency source；未知按 none', () => {
    expect(Object.keys(AGENT_SOURCE_PURPOSE).sort()).toEqual(
      [
        'signup_grant',
        'admin_adjust',
        'game_settle',
        'robot_pool',
        'relief_grant',
        'admin_reverse',
        'recharge',
        'refund_hold',
        'refund_rollback',
        'withdraw_hold',
        'withdraw_rollback',
        'entry_fee',
        'card_counter',
      ].sort(),
    );
    expect(classifyAgentSource('entry_fee')).toBe('entry_fee');
    for (const source of [
      'recharge',
      'admin_adjust',
      'admin_reverse',
      'refund_hold',
      'refund_rollback',
      'withdraw_hold',
      'withdraw_rollback',
    ]) {
      expect(classifyAgentSource(source), source).toBe('quota');
    }
    for (const source of [
      'signup_grant',
      'game_settle',
      'robot_pool',
      'relief_grant',
      'card_counter',
      'unknown_source',
    ]) {
      expect(classifyAgentSource(source), source).toBe('none');
    }
  });
});

describe('computeChainPayouts：级差/冻结/自玩/负级差', () => {
  it('级差望远镜：60/80/90、base=1 ⇒ 6000/2000/1000 micro，Σ=top', () => {
    const r = computeChainPayouts({
      base: 1,
      chain: [agent('a', 6000), agent('b', 8000), agent('c', 9000)],
      playerPhoneHash: PLAYER,
    });
    expect(r.payouts.map((p) => [p.agentId, p.paidBp, p.micro, p.reason])).toEqual([
      ['a', 6000, 6000, 'normal'],
      ['b', 2000, 2000, 'normal'],
      ['c', 1000, 1000, 'normal'],
    ]);
    expect(r.topRateBp).toBe(9000);
    expect(r.expectedMaxMicro).toBe(9000);
    expect(r.payouts.reduce((s, p) => s + p.micro, 0)).toBe(9000);
  });

  it('小额累计：fee=1、80%，5 局 = 40000 micro = 4 金币', () => {
    let sum = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = computeChainPayouts({ base: 1, chain: [agent('a', 8000)], playerPhoneHash: PLAYER });
      sum += r.payouts[0]!.micro;
    }
    expect(sum).toBe(40000);
    expect(computeSettlementTotals(0, sum)).toEqual({ totalCoins: 4, carryAfter: 0 });
  });

  it('冻结：付 0 且推进档位（上级拿 20%），Σ=30% ≤ top 90%', () => {
    const r = computeChainPayouts({
      base: 100,
      chain: [agent('a', 6000, { status: 'frozen' }), agent('b', 8000), agent('c', 9000)],
      playerPhoneHash: PLAYER,
    });
    expect(r.payouts.map((p) => [p.agentId, p.paidBp, p.micro, p.reason])).toEqual([
      ['a', 0, 0, 'frozen_skip'],
      ['b', 2000, 200000, 'normal'],
      ['c', 1000, 100000, 'normal'],
    ]);
    expect(r.payouts.reduce((s, p) => s + p.micro, 0)).toBe(300000);
    expect(r.expectedMaxMicro).toBe(900000);
  });

  it('自玩：付 0 且不推进档位（上级拿 80%），Σ=top', () => {
    const r = computeChainPayouts({
      base: 100,
      chain: [agent('a', 6000, { phoneHash: PLAYER }), agent('b', 8000), agent('c', 9000)],
      playerPhoneHash: PLAYER,
    });
    expect(r.payouts.map((p) => [p.agentId, p.paidBp, p.micro, p.reason])).toEqual([
      ['a', 0, 0, 'self_skip'],
      ['b', 8000, 800000, 'normal'],
      ['c', 1000, 100000, 'normal'],
    ]);
    expect(r.payouts.reduce((s, p) => s + p.micro, 0)).toBe(900000);
  });

  it('冻结优先于自玩', () => {
    const r = computeChainPayouts({
      base: 100,
      chain: [
        agent('a', 6000, { status: 'frozen', phoneHash: PLAYER }),
        agent('b', 8000),
        agent('c', 9000),
      ],
      playerPhoneHash: PLAYER,
    });
    expect(r.payouts[0]!.reason).toBe('frozen_skip');
    expect(r.payouts[1]!.micro).toBe(200000);
    expect(r.payouts[2]!.micro).toBe(100000);
  });

  it('顶层自玩：Σ=80% < top 90%，平台拿剩余', () => {
    const r = computeChainPayouts({
      base: 100,
      chain: [agent('a', 6000), agent('b', 8000), agent('c', 9000, { phoneHash: PLAYER })],
      playerPhoneHash: PLAYER,
    });
    expect(r.payouts.map((p) => p.micro)).toEqual([600000, 200000, 0]);
    expect(r.payouts.reduce((s, p) => s + p.micro, 0)).toBeLessThanOrEqual(r.expectedMaxMicro);
  });

  it('负级差：付 0 且不降低 lastPaidBp，绝不倒贴', () => {
    const r = computeChainPayouts({
      base: 100,
      chain: [agent('a', 8000), agent('b', 6000)],
      playerPhoneHash: PLAYER,
    });
    expect(r.payouts.map((p) => [p.agentId, p.paidBp, p.micro, p.reason])).toEqual([
      ['a', 8000, 800000, 'normal'],
      ['b', 0, 0, 'negative_skip'],
    ]);
    expect(r.topRateBp).toBe(8000);
    expect(r.payouts.reduce((s, p) => s + p.micro, 0)).toBe(800000);
    expect(r.expectedMaxMicro).toBe(800000);
  });

  it('重复 agent / 超深 / 越界比例 / 非法状态 ⇒ 抛错（不静默修正）', () => {
    expect(() =>
      computeChainPayouts({
        base: 1,
        chain: [agent('a', 1000), agent('a', 2000)],
        playerPhoneHash: PLAYER,
      }),
    ).toThrow(/重复/);
    expect(() =>
      computeChainPayouts({
        base: 1,
        chain: Array.from({ length: 6 }, (_, i) => agent(`a${i}`, 1000)),
        playerPhoneHash: PLAYER,
      }),
    ).toThrow(/深度/);
    expect(() =>
      computeChainPayouts({ base: 1, chain: [agent('a', 10001)], playerPhoneHash: PLAYER }),
    ).toThrow(/越界/);
    expect(() =>
      computeChainPayouts({
        base: 1,
        chain: [agent('a', 1000, { status: 'paused' as never })],
        playerPhoneHash: PLAYER,
      }),
    ).toThrow(/status/);
  });

  it('随机性质：非增比例 + 随机冻结/自玩 ⇒ 逐行 micro=base×paidBp、Σ≤expectedMax', () => {
    let seed = 20261026;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let iter = 0; iter < 2000; iter += 1) {
      const depth = 1 + Math.floor(rand() * 5);
      const rates: number[] = [];
      let rate = Math.floor(rand() * 10001);
      for (let i = 0; i < depth; i += 1) {
        rates.push(rate);
        rate = Math.floor(rand() * (rate + 1));
      }
      const chain = rates.map((r, i) =>
        agent(`a${i}`, r, {
          status: rand() < 0.2 ? 'frozen' : 'active',
          phoneHash: rand() < 0.2 ? PLAYER : `phone-a${i}`,
        }),
      );
      const base = 1 + Math.floor(rand() * 8191);
      const out = computeChainPayouts({ base, chain, playerPhoneHash: PLAYER });
      let sumMicro = 0;
      let sumPaidBp = 0;
      for (const p of out.payouts) {
        expect(p.micro).toBe(base * p.paidBp);
        expect(p.micro).toBeGreaterThanOrEqual(0);
        sumMicro += p.micro;
        sumPaidBp += p.paidBp;
      }
      expect(sumMicro).toBeLessThanOrEqual(out.expectedMaxMicro);
      expect(sumPaidBp).toBeLessThanOrEqual(out.topRateBp);
    }
  });
});

describe('applyQuotaDelta：净入金（负出账只抵扣未消耗本金）', () => {
  it('正入账全额', () => {
    expect(applyQuotaDelta({ inflow: 0, consumed: 0 }, 1000)).toEqual({
      inflow: 1000,
      consumed: 0,
      deducted: 0,
    });
  });

  it('负出账在未消耗本金内全额抵扣', () => {
    expect(applyQuotaDelta({ inflow: 1000, consumed: 200 }, -300)).toEqual({
      inflow: 700,
      consumed: 200,
      deducted: 300,
    });
  });

  it('负出账超过未消耗本金 ⇒ 只抵扣到 consumed，额度不为负', () => {
    expect(applyQuotaDelta({ inflow: 1000, consumed: 800 }, -500)).toEqual({
      inflow: 800,
      consumed: 800,
      deducted: 200,
    });
  });

  it('赢钱后提现不压低未来佣金：已消耗部分不被倒扣', () => {
    const afterConsume = { inflow: 1000, consumed: 1000 };
    const afterWithdraw = applyQuotaDelta(afterConsume, -2000);
    expect(afterWithdraw).toEqual({ inflow: 1000, consumed: 1000, deducted: 0 });
  });

  it('不变量破坏（consumed > inflow）⇒ 抛错', () => {
    expect(() => applyQuotaDelta({ inflow: 10, consumed: 20 }, 5)).toThrow(/不变量/);
  });
});

describe('computeSettlementTotals：取整与结转', () => {
  it('0/9999/10000/5000+6000/负余额', () => {
    expect(computeSettlementTotals(0, 0)).toEqual({ totalCoins: 0, carryAfter: 0 });
    expect(computeSettlementTotals(0, 9999)).toEqual({ totalCoins: 0, carryAfter: 9999 });
    expect(computeSettlementTotals(0, MICRO_PER_COIN)).toEqual({ totalCoins: 1, carryAfter: 0 });
    expect(computeSettlementTotals(5000, 6000)).toEqual({ totalCoins: 1, carryAfter: 1000 });
    expect(computeSettlementTotals(0, -5000)).toEqual({ totalCoins: 0, carryAfter: -5000 });
    expect(computeSettlementTotals(0, -15000)).toEqual({ totalCoins: 0, carryAfter: -15000 });
  });
});

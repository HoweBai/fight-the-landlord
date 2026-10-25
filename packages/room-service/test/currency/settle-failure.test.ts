/**
 * ② 金币场 T5（规格 §5 失败分级表逐条 + 收尾链）：**写边/读边的分级**与**收尾三态**。
 *
 * 判据形态：
 *  - 超时/传输/10007 ⇒ 同 id 同载荷重发 ≤2 次（300ms/1s）；超时后重发 replayed ⇒
 *    **只记一次账**（apply 恰好两次、moneyDelta/广播各恰好一次）；
 *  - 14001 ⇒ 重读重算、`:r2` 至多一轮（断言第二次 actionId 与重算后的 entries）；
 *    仍 14001 ⇒ 入 outbox（round=2）；
 *  - 10001/14002 ⇒ 终态：**一次 apply 都不重发**、不入 outbox、dropped + ERROR；
 *  - 读边失败 ⇒ 同阶梯重发；最终失败 ⇒ dropped 且**不调 apply**（不编造 delta）；
 *  - `game.balances` 三态：成功=balanceAfter / replayed=历史快照（标注=结算时刻值）/
 *    全零=get 值；零 delta 座无 balanceAfter ⇒ 机器人钩子跳过该座。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { CurrencyServiceError } from '../../src/currency/currency.client';
import { metricValue } from '../helpers/metric-readout';
import { currencySettleResidueTotal } from '../../src/metrics/room.metrics';
import {
  applyOk,
  balancesFor,
  installSink,
  makeHarness,
  restoreLogger,
  resultCount,
  validInput,
  type SettleHarness,
} from './helpers';

afterEach(() => {
  restoreLogger();
});

const ENTRY = [
  { ownerId: 'alice', ownerType: 'user', delta: 30 },
  { ownerId: 'bot-int-1', ownerType: 'robot', delta: -15 },
  { ownerId: 'carol', ownerType: 'user', delta: -15 },
];

/** 用假定时器把 settle 推到结束（退避 300ms/1s 的阶梯）。 */
async function settleWithTimers(h: SettleHarness, input = validInput()): Promise<void> {
  vi.useFakeTimers();
  try {
    const p = h.svc.settle(input);
    const expectation = expect(p).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await expectation;
  } finally {
    vi.useRealTimers();
  }
}

describe('10007（超时/传输）：同 id 同载荷重发 ≤2 次 ⇒ 仍失败入 settle:outbox', () => {
  it('apply 恰 3 次（首发+2 重发，载荷逐字相同）；outbox 条目结构逐字段；两个指标', async () => {
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply.mockRejectedValue(
      new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'transport down'),
    );
    const retriedBefore = await resultCount('retried');
    const outboxedBefore = await resultCount('outboxed');

    await settleWithTimers(h);

    expect(h.currency.apply).toHaveBeenCalledTimes(3);
    for (const call of h.currency.apply.mock.calls) {
      expect(call[0]).toEqual({
        actionId: 'settle:ROOM01:7',
        source: 'game_settle',
        entries: ENTRY,
        refId: 'ROOM01:7',
        burn: { residue: 0, rake: 0 },
        gameType: 'doudizhu',
      });
    }
    await expect(resultCount('retried')).resolves.toBe(retriedBefore + 2);
    await expect(resultCount('outboxed')).resolves.toBe(outboxedBefore + 1);

    const outbox = await h.redis.hgetall('settle:outbox');
    const entry = JSON.parse(outbox['ROOM01:7']!) as Record<string, unknown>;
    expect(entry).toEqual({
      actionId: 'settle:ROOM01:7',
      entries: ENTRY,
      roomCode: 'ROOM01',
      gameVersion: 7,
      round: 1,
      residue: 0,
      rakeTotal: 0,
      seats: [
        { seat: 0, ownerId: 'alice', ownerType: 'user' },
        { seat: 1, ownerId: 'bot-int-1', ownerType: 'robot' },
        { seat: 2, ownerId: 'carol', ownerType: 'user' },
      ],
      createdAt: expect.any(Number),
      // 多玩法（Task 2.5 / N2）：条目本身带玩法/人数（重发从条目取，不得缺省 3 座）。
      gameType: 'doudizhu',
      playerCount: 3,
    });
    // 收尾链**不得**在 outbox 路径发生（没有 effective 的 apply 结果）
    expect(h.broadcasts).toEqual([]);
    expect(h.record.moneyDelta).not.toHaveBeenCalled();
    expect(h.robotHook.afterSettle).not.toHaveBeenCalled();
  });

  it('ERROR 日志响亮（含 roomCode/version）', async () => {
    const records = installSink();
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply.mockRejectedValue(
      new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'transport down'),
    );

    await settleWithTimers(h);

    const line = records.find((r) => r.msg.includes('outboxed'));
    expect(line, '入箱必须 ERROR（宁可账面可见地没结算，不可静默）').toBeDefined();
    expect(line!.level).toBe('error');
    expect(line!.msg).toContain('ROOM01');
  });

  it('入箱**写入失败** ⇒ ERROR「未入箱、按 actionId 对账」+ dropped（**不计 outboxed**——条目不存在）', async () => {
    const records = installSink();
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply.mockRejectedValue(
      new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'transport down'),
    );
    h.redis.hset.mockRejectedValueOnce(new Error('redis write down'));
    const outboxedBefore = await resultCount('outboxed');
    const droppedBefore = await resultCount('dropped');

    await settleWithTimers(h);

    // 本流程只有入箱这一次 hset（收尾链未发生）——确认失败的正是写箱
    expect(h.redis.hset).toHaveBeenCalledTimes(1);
    await expect(
      resultCount('outboxed'),
      '写箱失败不得计 outboxed：条目不存在，sweeper 永远不会认领它（虚假承诺会把告警面口径带偏）',
    ).resolves.toBe(outboxedBefore);
    await expect(resultCount('dropped'), '钱未动且无自动重试 ⇒ 落 dropped 口径').resolves.toBe(
      droppedBefore + 1,
    );
    await expect(h.redis.hgetall('settle:outbox'), '条目确实没入箱').resolves.toEqual({});
    const line = records.find((r) => r.msg.includes('NOT queued'));
    expect(line, '写箱失败必须响亮 ERROR（否则钱静默没结算且无队列留痕）').toBeDefined();
    expect(line!.level).toBe('error');
    expect(line!.msg).toContain('manual reconciliation by actionId=settle:ROOM01:7');
    expect(records.some((r) => r.msg.includes('sweeper will resend'))).toBe(false);
  });
});

describe('超时后重发 replayed ⇒ 只记一次账', () => {
  it('apply 恰 2 次；replayed 响应照走收尾；广播用历史快照值（语义=结算时刻值）', async () => {
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply
      .mockRejectedValueOnce(new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'timed out'))
      .mockImplementationOnce(async (req: { actionId: string; entries: typeof ENTRY }) =>
        applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }, true),
      );
    const retriedBefore = await resultCount('retried');
    const replayedBefore = await resultCount('replayed');

    await settleWithTimers(h);

    // 只记一次账：一次成功（replayed）——apply 恰两次、moneyDelta 恰一次、广播恰一次
    expect(h.currency.apply).toHaveBeenCalledTimes(2);
    expect(h.record.moneyDelta).toHaveBeenCalledTimes(1);
    expect(h.record.moneyDelta).toHaveBeenCalledWith({
      roomCode: 'ROOM01',
      gameVersion: 7,
      deltas: [
        { seat: 0, delta: 30 },
        { seat: 1, delta: -15 },
        { seat: 2, delta: -15 },
      ],
    });
    expect(h.broadcasts).toEqual([
      {
        roomCode: 'ROOM01',
        version: 7,
        balances: [
          { seat: 0, balance: 1030 },
          { seat: 1, balance: 985 },
          { seat: 2, balance: 985 },
        ],
      },
    ]);
    expect(h.robotHook.afterSettle).toHaveBeenCalledTimes(1);
    await expect(resultCount('retried')).resolves.toBe(retriedBefore + 1);
    await expect(resultCount('replayed')).resolves.toBe(replayedBefore + 1);
    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
  });
});

describe('成功（ok）：收尾三件事的完整契约', () => {
  it('广播=balanceAfter（三座升序）/ moneyDelta matched 齐三座 / 机器人钩子收机器人座的 balanceAfter', async () => {
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: typeof ENTRY }) =>
      applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }),
    );
    const okBefore = await resultCount('ok');

    await h.svc.settle(validInput());

    await expect(resultCount('ok')).resolves.toBe(okBefore + 1);
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]!.balances).toEqual([
      { seat: 0, balance: 1030 },
      { seat: 1, balance: 985 },
      { seat: 2, balance: 985 },
    ]);
    expect(h.record.moneyDelta).toHaveBeenCalledTimes(1);
    expect(h.configCache.rakePercent).toHaveBeenCalledWith('doudizhu');
    expect(h.robotHook.afterSettle).toHaveBeenCalledWith([{ botId: 'bot-int-1', balanceAfter: 985 }], 'doudizhu');
    await expect(h.redis.hgetall('recordmoney:outbox')).resolves.toEqual({});
  });
});

describe('14001 ⇒ 重读余额、重算、`:r2` 重发至多一轮', () => {
  it('r2 成功：第二次 apply 带 `:r2` 与重算后的 entries；广播/回写用新值', async () => {
    const h = makeHarness();
    // 农民赢（地主 alice 应付 60）：第一读 alice 100（全付）；第二读（r2 重读）alice 只剩 25 ⇒ 截断
    const farmersWin = validInput({
      result: {
        roomCode: 'ROOM01',
        baseScore: 15,
        winner: 'farmer',
        landlordSeat: 0,
        farmerSeats: [1, 2],
        multiplier: 2,
        spring: 'none',
        landlordScoreChange: -60,
        farmerScoreChange: 30,
      },
    });
    h.currency.get
      .mockResolvedValueOnce(balancesFor({ alice: 100 }))
      .mockResolvedValueOnce(balancesFor({ alice: 25 }));
    h.currency.apply.mockRejectedValueOnce(
      new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'insufficient'),
    );
    h.currency.apply.mockImplementationOnce(async (req: { actionId: string; entries: typeof ENTRY }) =>
      applyOk(req.actionId, req.entries, { alice: 0, 'bot-int-1': 1012, carol: 1012 }),
    );
    const r2Before = await resultCount('r2');
    const residueBefore = await metricValue(currencySettleResidueTotal);

    await h.svc.settle(farmersWin);

    expect(h.currency.get).toHaveBeenCalledTimes(2);
    expect(h.currency.apply).toHaveBeenCalledTimes(2);
    const first = h.currency.apply.mock.calls[0]![0] as { actionId: string; entries: unknown; burn: unknown };
    expect(first.actionId).toBe('settle:ROOM01:7');
    expect(first.entries).toEqual([
      { ownerId: 'alice', ownerType: 'user', delta: -60 },
      { ownerId: 'bot-int-1', ownerType: 'robot', delta: 30 },
      { ownerId: 'carol', ownerType: 'user', delta: 30 },
    ]);
    const second = h.currency.apply.mock.calls[1]![0] as { actionId: string; entries: unknown; burn: unknown };
    expect(second.actionId).toBe('settle:ROOM01:7:r2');
    // 重算：P=25、g=floor(30×25/60)=12 ⇒ 残差 1
    expect(second.entries).toEqual([
      { ownerId: 'alice', ownerType: 'user', delta: -25 },
      { ownerId: 'bot-int-1', ownerType: 'robot', delta: 12 },
      { ownerId: 'carol', ownerType: 'user', delta: 12 },
    ]);
    expect(first.burn).toEqual({ residue: 0, rake: 0 }); // 第一轮 alice 付满 60 ⇒ 无销毁
    expect(second.burn).toEqual({ residue: 1, rake: 0 }); // 重算截断 ⇒ 残差 1
    await expect(resultCount('r2')).resolves.toBe(r2Before + 1);
    // 残差指标 +1（第一轮无截断残差 0、第二轮残差 1）
    await expect(metricValue(currencySettleResidueTotal)).resolves.toBe(residueBefore + 1);
    expect(h.broadcasts[0]!.balances).toEqual([
      { seat: 0, balance: 0 },
      { seat: 1, balance: 1012 },
      { seat: 2, balance: 1012 },
    ]);
  });

  it('r2 仍 14001 ⇒ 入 outbox（round=2、actionId 带 `:r2`，不再是原载荷）', async () => {
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor({ alice: 100 }));
    h.currency.apply.mockRejectedValue(
      new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'insufficient'),
    );
    const r2Before = await resultCount('r2');

    await h.svc.settle(validInput());

    expect(h.currency.apply).toHaveBeenCalledTimes(2); // 首发 + r2，各一次（14001 不属重发类）
    await expect(resultCount('r2')).resolves.toBe(r2Before + 1);
    const outbox = await h.redis.hgetall('settle:outbox');
    const entry = JSON.parse(outbox['ROOM01:7']!) as { actionId: string; round: number };
    expect(entry.actionId).toBe('settle:ROOM01:7:r2');
    expect(entry.round).toBe(2);
  });
});

describe('10001 / 14002 ⇒ 终态：不重试、不入 outbox、dropped + ERROR', () => {
  it('10001：apply 恰 1 次；无 outbox；无收尾；dropped +1', async () => {
    const records = installSink();
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply.mockRejectedValue(new CurrencyServiceError(ErrCode.BAD_PARAM, 'type gate'));
    const droppedBefore = await resultCount('dropped');

    await h.svc.settle(validInput());

    expect(h.currency.apply).toHaveBeenCalledTimes(1); // 确定性回滚 ⇒ 同参重发无益
    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
    await expect(resultCount('dropped')).resolves.toBe(droppedBefore + 1);
    expect(h.record.moneyDelta).not.toHaveBeenCalled();
    const line = records.find((r) => r.msg.includes('10001'));
    expect(line?.level).toBe('error');
  });

  it('14002：同上；ERROR 明示 money_delta 留 NULL 与 currency_flows 核对', async () => {
    const records = installSink();
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply.mockRejectedValue(new CurrencyServiceError(ErrCode.E_ACTION_CONFLICT, 'conflict'));

    await h.svc.settle(validInput());

    expect(h.currency.apply).toHaveBeenCalledTimes(1);
    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
    expect(h.record.moneyDelta).not.toHaveBeenCalled();
    const line = records.find((r) => r.msg.includes('14002'));
    expect(line?.level).toBe('error');
    expect(line!.msg).toContain('currency_flows');
  });
});

describe('读边（currency.get）失败：同阶梯重发；最终失败 ⇒ dropped 且不调 apply', () => {
  it('10007 恒失败 ⇒ get 恰 3 次、apply 0 次、dropped +1、无广播', async () => {
    const h = makeHarness();
    h.currency.get.mockRejectedValue(
      new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'read down'),
    );
    const droppedBefore = await resultCount('dropped');

    await settleWithTimers(h);

    expect(h.currency.get).toHaveBeenCalledTimes(3);
    expect(h.currency.apply).not.toHaveBeenCalled();
    await expect(resultCount('dropped')).resolves.toBe(droppedBefore + 1);
    expect(h.broadcasts).toEqual([]);
  });

  it('一次 10007 后成功 ⇒ 照常结算（读边重发的判别力 —— 实现决策①）', async () => {
    const h = makeHarness();
    h.currency.get
      .mockRejectedValueOnce(new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'blip'))
      .mockResolvedValueOnce(balancesFor());
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: typeof ENTRY }) =>
      applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }),
    );

    await settleWithTimers(h);

    expect(h.currency.get).toHaveBeenCalledTimes(2);
    expect(h.currency.apply).toHaveBeenCalledTimes(1);
  });
});

describe('全零局（三态之二）：不调 apply，仍走「广播(get 值) + moneyDelta(全 0)」，机器人钩子整体跳过', () => {
  it('余额全 0 ⇒ entries 空；广播=get 值；deltas 含 0；hook 不调', async () => {
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor({}, 0));
    const okBefore = await resultCount('ok');

    await h.svc.settle(validInput());

    expect(h.currency.apply).not.toHaveBeenCalled();
    await expect(resultCount('ok')).resolves.toBe(okBefore + 1);
    expect(h.broadcasts[0]!.balances).toEqual([
      { seat: 0, balance: 0 },
      { seat: 1, balance: 0 },
      { seat: 2, balance: 0 },
    ]);
    expect(h.record.moneyDelta).toHaveBeenCalledWith({
      roomCode: 'ROOM01',
      gameVersion: 7,
      deltas: [
        { seat: 0, delta: 0 },
        { seat: 1, delta: 0 },
        { seat: 2, delta: 0 },
      ],
    });
    expect(h.robotHook.afterSettle).not.toHaveBeenCalled();
  });

  it('零 delta 座无 balanceAfter ⇒ 机器人钩子跳过该座（广播仍用结算前读数兜底）', async () => {
    const h = makeHarness();
    // 机器人座余额 0 ⇒ 应付 15 被截到 0 ⇒ 无 entry ⇒ 钩子没有它的输入
    h.currency.get.mockResolvedValue(balancesFor({ 'bot-int-1': 0 }));
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: typeof ENTRY }) =>
      applyOk(req.actionId, req.entries, { alice: 1015, carol: 985 }),
    );

    await h.svc.settle(validInput());

    expect(h.robotHook.afterSettle).not.toHaveBeenCalled();
    expect(h.broadcasts[0]!.balances).toEqual([
      { seat: 0, balance: 1015 },
      { seat: 1, balance: 0 }, // 零 delta 座：结算前读数（= 结算时刻值）
      { seat: 2, balance: 985 },
    ]);
  });
});

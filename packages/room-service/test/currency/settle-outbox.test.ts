/**
 * ② 金币场 T5（规格 §5 outbox 段逐字）：**补偿队列 + sweeper**。
 *
 * 判据形态（brief Step 4）：
 *  - 入箱（结构逐字段）由 `settle-failure.test.ts` 覆盖；这里覆盖**重发与收敛**：
 *    原样重发（同 id 同载荷）、成功后**完整收尾**（广播 + moneyDelta + 机器人钩子）、
 *    `recordmoney:outbox` 的 `matched` 齐三座收敛；
 *  - **TTL=1h**：超龄 ⇒ ERROR 放弃 + 指标 + 删条目（**不重发**）；
 *  - 指标：size（两箱之和）/ oldest（秒；空 ⇒ 0）；
 *  - 自重排链：10s 常量、关停闸（照 `rooms.reaper.ts` 的成例）。
 *
 * ⚠️ 重发路径**不得重算**：entries 原样来自条目（`currency.get` 在这条路上零调用 ——
 * 余额早已不可复现，重算会得到另一种账）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { CurrencyServiceError } from '../../src/currency/currency.client';
import { SETTLE_SWEEP_INTERVAL_MS, SettleSweeper } from '../../src/currency/settle.sweeper';
import {
  currencySettleOutboxOldestSeconds,
  currencySettleOutboxSize,
  currencySettleResidueTotal,
  currencySettleResultTotal,
  recordWriteFailuresTotal,
} from '../../src/metrics/room.metrics';
import { exactSeriesValue, metricValue } from '../helpers/metric-readout';
import { asRedis } from '../helpers/fake-redis';
import {
  applyOk,
  installSink,
  makeHarness,
  restoreLogger,
  resultCount,
  type SettleHarness,
} from './helpers';

afterEach(() => {
  restoreLogger();
});

const NOW = 1_700_000_000_000;

const ENTRY = [
  { ownerId: 'alice', ownerType: 'user', delta: 30 },
  { ownerId: 'bot-int-1', ownerType: 'robot', delta: -15 },
  { ownerId: 'carol', ownerType: 'user', delta: -15 },
];

const SEATS = [
  { seat: 0, ownerId: 'alice', ownerType: 'user' },
  { seat: 1, ownerId: 'bot-int-1', ownerType: 'robot' },
  { seat: 2, ownerId: 'carol', ownerType: 'user' },
];

const settleEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  actionId: 'settle:ROOM01:7',
  entries: ENTRY,
  roomCode: 'ROOM01',
  gameVersion: 7,
  round: 1,
  seats: SEATS,
  createdAt: NOW,
  ...over,
});

const moneyEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  roomCode: 'ROOM01',
  gameVersion: 7,
  deltas: [
    { seat: 0, delta: 30 },
    { seat: 1, delta: -15 },
    { seat: 2, delta: -15 },
  ],
  createdAt: NOW,
  ...over,
});

async function seedSettle(h: SettleHarness, entry: Record<string, unknown>): Promise<void> {
  await h.redis.hset('settle:outbox', 'ROOM01:7', JSON.stringify(entry));
}

async function seedMoney(h: SettleHarness, entry: Record<string, unknown>): Promise<void> {
  await h.redis.hset('recordmoney:outbox', 'ROOM01:7', JSON.stringify(entry));
}

function makeSweeper(h: SettleHarness): SettleSweeper {
  return new SettleSweeper(asRedis(h.redis), h.svc);
}

describe('settle:outbox 原样重发 ⇒ 成功走完整收尾并从箱中清除', () => {
  it('同 id 同载荷重发；广播 + moneyDelta + 机器人钩子照走；不重算（get 零调用）', async () => {
    const h = makeHarness();
    await seedSettle(h, settleEntry());
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: typeof ENTRY }) =>
      applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }),
    );
    const okBefore = await resultCount('ok');

    await makeSweeper(h).sweepOnce(NOW);

    expect(h.currency.apply).toHaveBeenCalledWith({
      actionId: 'settle:ROOM01:7',
      source: 'game_settle',
      entries: ENTRY,
      refId: 'ROOM01:7',
    });
    const legacyArg = h.currency.apply.mock.calls[0]![0] as Record<string, unknown>;
    expect('burn' in legacyArg, '旧条目重发**不带** burn 键（旧指纹 ⇒ 可重放；该 op 两列 NULL）').toBe(false);
    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
    await expect(resultCount('ok')).resolves.toBe(okBefore + 1);
    expect(h.currency.get, '重发路径不得重算（余额不可复现）').not.toHaveBeenCalled();
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
    expect(h.record.moneyDelta).toHaveBeenCalledTimes(1);
    expect(h.robotHook.afterSettle).toHaveBeenCalledWith([{ botId: 'bot-int-1', balanceAfter: 985 }], 'doudizhu');
  });

  it('replayed 重发同样算送达（replayed 指标；条目清除）', async () => {
    const h = makeHarness();
    await seedSettle(h, settleEntry());
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: typeof ENTRY }) =>
      applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }, true),
    );
    const replayedBefore = await resultCount('replayed');

    await makeSweeper(h).sweepOnce(NOW);

    await expect(resultCount('replayed')).resolves.toBe(replayedBefore + 1);
    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
  });

  it('新条目（含 residue/rakeTotal）⇒ 带 burn 重发（与首发同指纹可重放）；D6：重发不计 residue 指标', async () => {
    const h = makeHarness();
    await seedSettle(h, settleEntry({ residue: 1, rakeTotal: 2 }));
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: typeof ENTRY }) =>
      applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }, true),
    );
    const residueBefore = await metricValue(currencySettleResidueTotal);

    await makeSweeper(h).sweepOnce(NOW);

    expect(h.currency.apply).toHaveBeenCalledWith({
      actionId: 'settle:ROOM01:7',
      source: 'game_settle',
      entries: ENTRY,
      refId: 'ROOM01:7',
      burn: { residue: 1, rake: 2 },
    });
    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
    // D6：outbox 重发路径不增 residue 指标（条目新字段只服务 apply 载荷）
    await expect(metricValue(currencySettleResidueTotal)).resolves.toBe(residueBefore);
  });

  it('顺序钉死（规格 §5：成功 ⇒ 收尾**并**清除，收尾在前、清除在后）：finalize 全链先于 hdel', async () => {
    const h = makeHarness();
    await seedSettle(h, settleEntry());
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: typeof ENTRY }) =>
      applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }),
    );

    await makeSweeper(h).sweepOnce(NOW);

    // 判据形态照仓内成例（`mock.invocationCallOrder`）。finalize 的三步同序执行
    // （① 广播 → ② moneyDelta → ③ 机器人钩子）⇒ 断言**末两步**先于 hdel，即「完整收尾
    // 已发生」先于「从箱清除」。若退回「先清后收尾」，此断言必红：清箱→收尾的崩溃窗里
    // 钱已动而广播/moneyDelta 永久缺失且无队列/告警留痕。
    const hdelOrder = h.redis.hdel.mock.invocationCallOrder[0]!;
    expect(
      h.record.moneyDelta.mock.invocationCallOrder[0]!,
      '② moneyDelta 必须先于 hdel',
    ).toBeLessThan(hdelOrder);
    expect(
      h.robotHook.afterSettle.mock.invocationCallOrder[0]!,
      '③ 机器人钩子（finalize 最后一步）必须先于 hdel',
    ).toBeLessThan(hdelOrder);
    // 正向对照：条目确实被清（顺序断言不得靠「根本没清箱」通过）
    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
    expect(h.broadcasts).toHaveLength(1);
  });
});

describe('settle:outbox 失败处置', () => {
  it('10001（终态）⇒ 删条目 + ERROR + dropped；不再重发', async () => {
    const records = installSink();
    const h = makeHarness();
    await seedSettle(h, settleEntry());
    h.currency.apply.mockRejectedValue(new CurrencyServiceError(ErrCode.BAD_PARAM, 'type gate'));
    const droppedBefore = await resultCount('dropped');

    await makeSweeper(h).sweepOnce(NOW);

    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
    await expect(resultCount('dropped')).resolves.toBe(droppedBefore + 1);
    expect(records.some((r) => r.msg.includes('outbox resend terminal'))).toBe(true);
  });

  it('14001（重发仍不足）⇒ 留在箱中（下一轮再试；TTL 兜底），不删不 drop', async () => {
    const records = installSink();
    const h = makeHarness();
    await seedSettle(h, settleEntry());
    h.currency.apply.mockRejectedValue(
      new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'insufficient'),
    );
    const droppedBefore = await resultCount('dropped');

    await makeSweeper(h).sweepOnce(NOW);

    expect(await h.redis.hgetall('settle:outbox')).toHaveProperty('ROOM01:7');
    await expect(resultCount('dropped')).resolves.toBe(droppedBefore);
    expect(records.some((r) => r.msg.includes('kept for next sweep'))).toBe(true);
  });

  it('10007（传输）⇒ 留在箱中', async () => {
    const h = makeHarness();
    await seedSettle(h, settleEntry());
    h.currency.apply.mockRejectedValue(
      new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'down'),
    );

    await makeSweeper(h).sweepOnce(NOW);

    expect(await h.redis.hgetall('settle:outbox')).toHaveProperty('ROOM01:7');
  });

  it('TTL=1h：超龄 ⇒ ERROR「放弃」+ dropped + 删条目，且**不重发**', async () => {
    const records = installSink();
    const h = makeHarness();
    await seedSettle(h, settleEntry({ createdAt: NOW - 3_600_001 }));
    const droppedBefore = await resultCount('dropped');

    await makeSweeper(h).sweepOnce(NOW);

    expect(h.currency.apply, '超龄条目不得重发（放弃 = 交人工 runbook）').not.toHaveBeenCalled();
    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
    await expect(resultCount('dropped')).resolves.toBe(droppedBefore + 1);
    const line = records.find((r) => r.msg.includes('abandoned'));
    expect(line?.level).toBe('error');
  });

  it('坏 JSON 条目 ⇒ ERROR + 删除（否则每 10s 刷一条）', async () => {
    const records = installSink();
    const h = makeHarness();
    await h.redis.hset('settle:outbox', 'ROOM01:7', '{ not json');

    await makeSweeper(h).sweepOnce(NOW);

    await expect(h.redis.hgetall('settle:outbox')).resolves.toEqual({});
    expect(records.some((r) => r.msg.includes('Corrupt settle:outbox entry'))).toBe(true);
  });
});

describe('recordmoney:outbox：matched 齐三座 ⇒ 收敛清除', () => {
  it('partial（[0]）⇒ 保留 + WARN；齐三座 ⇒ 清除 + 日志', async () => {
    const records = installSink();
    const h = makeHarness();
    await seedMoney(h, moneyEntry());
    const sweeper = makeSweeper(h);

    h.record.moneyDelta.mockResolvedValueOnce({ matched: [0] });
    await sweeper.sweepOnce(NOW);
    expect(await h.redis.hgetall('recordmoney:outbox'), 'partial ⇒ 必须保留').toHaveProperty('ROOM01:7');
    expect(records.some((r) => r.msg.includes('still partial'))).toBe(true);

    h.record.moneyDelta.mockResolvedValueOnce({ matched: [0, 1, 2] });
    await sweeper.sweepOnce(NOW);
    await expect(h.redis.hgetall('recordmoney:outbox')).resolves.toEqual({});
    expect(records.some((r) => r.msg.includes('converged'))).toBe(true);
    expect(h.record.moneyDelta).toHaveBeenCalledWith({
      roomCode: 'ROOM01',
      gameVersion: 7,
      deltas: [
        { seat: 0, delta: 30 },
        { seat: 1, delta: -15 },
        { seat: 2, delta: -15 },
      ],
    });
  });

  it('调用抛错 ⇒ 保留（下一轮再试）', async () => {
    const h = makeHarness();
    await seedMoney(h, moneyEntry());
    h.record.moneyDelta.mockRejectedValue(new Error('user-service down'));

    await makeSweeper(h).sweepOnce(NOW);

    expect(await h.redis.hgetall('recordmoney:outbox')).toHaveProperty('ROOM01:7');
  });

  it('TTL=1h：超龄 ⇒ ERROR + 删条目（money_delta 留 NULL，人工 runbook）', async () => {
    const records = installSink();
    const h = makeHarness();
    await seedMoney(h, moneyEntry({ createdAt: NOW - 3_600_001 }));

    await makeSweeper(h).sweepOnce(NOW);

    await expect(h.redis.hgetall('recordmoney:outbox')).resolves.toEqual({});
    expect(records.some((r) => r.msg.includes('recordmoney:outbox entry abandoned'))).toBe(true);
    expect(h.record.moneyDelta, '超龄条目不得重发').not.toHaveBeenCalled();
  });
});

describe('指标：currency_settle_outbox_size / _oldest_seconds（每轮刷新）', () => {
  it('两箱之和；oldest 取两侧最老（秒）；清空后归零', async () => {
    const h = makeHarness();
    await seedSettle(h, settleEntry({ createdAt: NOW - 400_000 })); // 400s
    await seedMoney(h, moneyEntry({ createdAt: NOW - 100_000 })); // 100s
    // 两侧都「留箱」：apply 传输失败 + moneyDelta partial
    h.currency.apply.mockRejectedValue(new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'down'));
    h.record.moneyDelta.mockResolvedValue({ matched: [0] });
    const sweeper = makeSweeper(h);

    await sweeper.sweepOnce(NOW);

    await expect(metricValue(currencySettleOutboxSize)).resolves.toBe(2);
    await expect(metricValue(currencySettleOutboxOldestSeconds)).resolves.toBe(400);

    await h.redis.del('settle:outbox', 'recordmoney:outbox');
    await sweeper.sweepOnce(NOW);

    await expect(metricValue(currencySettleOutboxSize)).resolves.toBe(0);
    await expect(metricValue(currencySettleOutboxOldestSeconds)).resolves.toBe(0);
  });
});

describe('自重排链：10s 常量周期 + 关停闸（照 rooms.reaper 成例）', () => {
  it('onModuleInit 起链、每 10s 扫一轮；shutdown 后不再扫', async () => {
    const h = makeHarness();
    const sweeper = makeSweeper(h);
    vi.useFakeTimers();
    try {
      sweeper.onModuleInit();
      const hgetall = h.redis.hgetall as unknown as ReturnType<typeof vi.fn>;
      expect(hgetall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SETTLE_SWEEP_INTERVAL_MS);
      const afterFirst = hgetall.mock.calls.length;
      expect(afterFirst, '10s 后必须真的扫了一轮（不是死代码）').toBeGreaterThanOrEqual(2);

      await vi.advanceTimersByTimeAsync(SETTLE_SWEEP_INTERVAL_MS);
      expect(hgetall.mock.calls.length).toBeGreaterThan(afterFirst);

      sweeper.onApplicationShutdown();
      const frozen = hgetall.mock.calls.length;
      await vi.advanceTimersByTimeAsync(SETTLE_SWEEP_INTERVAL_MS * 3);
      expect(hgetall.mock.calls.length, 'shutdown 之后不得再扫').toBe(frozen);
    } finally {
      sweeper.onApplicationShutdown();
      vi.useRealTimers();
    }
  });

  it('A1：recordmoney 超龄放弃计 money_delta + dropped{game_type}', async () => {
    const h = makeHarness();
    const entry = moneyEntry({ gameType: 'paodekuai', createdAt: 0 });
    const beforeDropped = (await exactSeriesValue(currencySettleResultTotal, {
      result: 'dropped', game_type: 'paodekuai',
    })) ?? 0;
    const beforeMoney = (await exactSeriesValue(recordWriteFailuresTotal, {
      game_type: 'paodekuai', kind: 'money_delta',
    })) ?? 0;

    await h.svc.resendRecordMoneyOutboxEntry('f1', entry as never, Date.now());

    expect(await exactSeriesValue(currencySettleResultTotal, {
      result: 'dropped', game_type: 'paodekuai',
    })).toBe(beforeDropped + 1);
    expect(await exactSeriesValue(recordWriteFailuresTotal, {
      game_type: 'paodekuai', kind: 'money_delta',
    })).toBe(beforeMoney + 1);
  });

  it('A1：outbox gauge 按 game_type 分组；hgetall 失败保持旧值', async () => {
    const h = makeHarness();
    const sweeper = makeSweeper(h);
    await seedSettle(h, settleEntry({ gameType: 'paodekuai', createdAt: Date.now() }));
    await seedMoney(h, moneyEntry({ createdAt: Date.now() })); // 缺省 gameType ⇒ ddz
    // 让两条都留在箱里：settle 重发失败、money 部分匹配
    h.currency.apply.mockRejectedValueOnce(new Error('down'));
    h.record.moneyDelta.mockResolvedValueOnce({ matched: [0] });
    await sweeper.sweepOnce(Date.now());

    const pdk = await exactSeriesValue(currencySettleOutboxSize, { game_type: 'paodekuai' });
    const ddz = await exactSeriesValue(currencySettleOutboxSize, { game_type: 'doudizhu' });
    expect(pdk).toBe(1);
    expect(ddz).toBe(1);

    h.redis.hgetall.mockRejectedValueOnce(new Error('redis down'));
    await sweeper.sweepOnce(Date.now()).catch(() => undefined);

    expect(await exactSeriesValue(currencySettleOutboxSize, { game_type: 'paodekuai' })).toBe(pdk);
    expect(await exactSeriesValue(currencySettleOutboxSize, { game_type: 'doudizhu' })).toBe(ddz);
  });

  it('A1：未知 gameType 的 outbox 条目归 ddz 并汇总 WARN', async () => {
    const h = makeHarness();
    const sweeper = makeSweeper(h);
    await seedMoney(h, moneyEntry({ gameType: 'pdk', createdAt: Date.now() }));
    h.record.moneyDelta.mockResolvedValueOnce({ matched: [0] }); // 部分匹配 ⇒ 留箱
    const before = (await exactSeriesValue(currencySettleOutboxSize, { game_type: 'doudizhu' })) ?? 0;

    await sweeper.sweepOnce(Date.now());

    // gauge 是**绝对快照**（不是累计）：本用例箱里恰 1 条 ⇒ ddz=1（before 可能被前序用例抬高）
    expect(await exactSeriesValue(currencySettleOutboxSize, { game_type: 'doudizhu' })).toBe(1);
    expect(await exactSeriesValue(currencySettleOutboxSize, { game_type: 'paodekuai' })).toBe(0);
  });
});

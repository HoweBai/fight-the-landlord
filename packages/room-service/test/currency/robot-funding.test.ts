/**
 * ② 金币场 T6：**机器人资金面**（`RobotFunding`）的单测 —— 规格 §7 逐字，C6/C12/C22 的
 * 单元级载体。
 *
 * ─── 两条边 ────────────────────────────────────────────────────────────
 *  - `ensureBots`（金币场 `fillBots` 内、`game.start` 前）：`currency.get(botIds)` →
 *    缺失（exists=false，观测按 0）或 `balance < refillLine` ⇒ `rr` apply 补到 `target`
 *    （entries 双条、双方 ownerType='robot'）；**失败一律抛**（走既有补位失败路径）。
 *  - `afterSettle`（结算收尾第 ③ 步钩子）：按 apply 响应 `balanceAfter` ——
 *    `< refillLine` ⇒ 补；`> recallLine` ⇒ `rc` 回收至 target；带内 / 空批 ⇒ 零动作。
 *    **fail-open**：绝不 reject，逐座独立 try/catch。
 *
 * ─── 判据形态（本仓纪律）───────────────────────────────────────────────
 *  - 指标是**进程级单例** ⇒ 一律 before/after 差值；`topup` 只在 `replayed === false`
 *    时计数（replayed = 钱早已动过，重复计会让 runbook 的「补给/回收速率」虚高）。
 *  - `actionId` **逐字**断言（`rr:<botId>:<target>:<观测|0>` / `rc:...`）—— 它是幂等锚，
 *    也是「同观测重复触发 ⇒ replayed 不双补」的全部机制；断言从 `robotWaterLevels`
 *    派生 target（水位函数本身的正确性由 `robot-water.test.ts` 钉死）。
 *  - 日志用捕获 sink（M4：`Logger.overrideLogger` 是进程级的 ⇒ afterEach 必须还原）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrCode, type CurrencyApplyRequest } from '@fight-the-landlord/protocol';
import {
  ROBOT_POOL_OWNER_ID,
  RobotFunding,
  robotWaterLevels,
} from '../../src/currency/robot-funding';
import {
  CurrencyServiceError,
  type CurrencyClient,
} from '../../src/currency/currency.client';
import type { ConfigCacheService } from '../../src/config/config-cache.service';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from '../helpers/config-cache.stub';
import { installSink, restoreLogger } from './helpers';
import { labeledValue, metricValue } from '../helpers/metric-readout';
import {
  currencyRobotEnsureFailedTotal,
  currencyRobotTopupTotal,
} from '../../src/metrics/room.metrics';

const BOT = 'bot-int-1';
/** 缺省 top = max(种子档位 1200) × entryMultiplier(10) = 12000（规格 §6）。 */
const TOP = 12000;
const LEVELS = robotWaterLevels(BOT, TOP);

/** `currency.get` 的形状化替身：按 ownerId 给 {balance, exists}。 */
const getReturns =
  (entries: Record<string, { balance: number; exists?: boolean }>) =>
  async (req: { ownerIds: string[] }) => ({
    balances: req.ownerIds.map((ownerId) => ({
      ownerId,
      balance: entries[ownerId]?.balance ?? 0,
      exists: entries[ownerId]?.exists ?? true,
    })),
  });

/** `currency.apply` 的成功响应（entries 与请求同源；`balanceAfter` 取 delta 位——用例不依赖）。 */
const applyOk =
  (replayed = false) =>
  async (req: CurrencyApplyRequest) => ({
    opId: 1,
    actionId: req.actionId,
    entries: req.entries.map((e) => ({ ownerId: e.ownerId, balanceAfter: e.delta })),
    replayed,
  });

interface FundingHarness {
  svc: RobotFunding;
  currency: { get: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> };
  configCache: ConfigCacheStub;
}

function makeHarness(): FundingHarness {
  const currency = {
    get: vi.fn(getReturns({ [BOT]: { balance: 0, exists: false } })),
    apply: vi.fn(applyOk()),
  };
  const configCache = makeConfigCache();
  const svc = new RobotFunding(
    currency as unknown as CurrencyClient,
    asConfigCache(configCache) as unknown as ConfigCacheService,
  );
  return { svc, currency, configCache };
}

const topupCount = async (
  action: 'refill' | 'recall',
  gameType = 'doudizhu',
): Promise<number> =>
  (await labeledValue(currencyRobotTopupTotal, { action, game_type: gameType })) ?? 0;
const ensureFailedCount = async (gameType = 'doudizhu'): Promise<number> =>
  (await labeledValue(currencyRobotEnsureFailedTotal, { game_type: gameType })) ?? 0;

describe('RobotFunding.ensureBots：补给观测 → 注资（规格 §7 上半）', () => {
  let h: FundingHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('缺失账户（exists=false）⇒ rr 从池补满到 target：actionId/entries/ownerType/source/refId 逐字；topup{refill} +1', async () => {
    const before = await topupCount('refill');
    const failedBefore = await ensureFailedCount();

    await h.svc.ensureBots([BOT]);

    // 一次批量 get（不是逐座）
    expect(h.currency.get).toHaveBeenCalledTimes(1);
    expect(h.currency.get).toHaveBeenCalledWith({ ownerIds: [BOT] });
    expect(h.currency.apply).toHaveBeenCalledTimes(1);
    expect(h.currency.apply).toHaveBeenCalledWith({
      actionId: `rr:${BOT}:${LEVELS.target}:0`,
      source: 'robot_pool',
      refId: BOT,
      entries: [
        { ownerId: ROBOT_POOL_OWNER_ID, ownerType: 'robot', delta: -LEVELS.target },
        { ownerId: BOT, ownerType: 'robot', delta: LEVELS.target },
      ],
    });
    await expect(topupCount('refill')).resolves.toBe(before + 1);
    await expect(ensureFailedCount()).resolves.toBe(failedBefore);
  });

  it('exists=false 时观测**恒按 0**（即使响应里 balance 字段带着非 0 值 —— 契约形状的守门）', async () => {
    h.currency.get.mockImplementation(getReturns({ [BOT]: { balance: 999, exists: false } }));

    await h.svc.ensureBots([BOT]);

    const req = h.currency.apply.mock.calls[0]![0] as CurrencyApplyRequest;
    expect(req.actionId, '缺失账户的观测是 0（不借用 balance 字段）').toBe(
      `rr:${BOT}:${LEVELS.target}:0`,
    );
  });

  it('余额低于补给线 ⇒ 按观测补差额（x = target − 观测）；actionId 带观测值', async () => {
    h.currency.get.mockImplementation(getReturns({ [BOT]: { balance: 5000 } }));
    expect(5000, '夹具前提：5000 必须低于该 bot 的补给线').toBeLessThan(LEVELS.refillLine);

    await h.svc.ensureBots([BOT]);

    expect(h.currency.apply).toHaveBeenCalledWith({
      actionId: `rr:${BOT}:${LEVELS.target}:5000`,
      source: 'robot_pool',
      refId: BOT,
      entries: [
        { ownerId: ROBOT_POOL_OWNER_ID, ownerType: 'robot', delta: -(LEVELS.target - 5000) },
        { ownerId: BOT, ownerType: 'robot', delta: LEVELS.target - 5000 },
      ],
    });
  });

  it('余额恰在补给线上（== refillLine）⇒ 不动（判定是严格小于）', async () => {
    h.currency.get.mockImplementation(getReturns({ [BOT]: { balance: LEVELS.refillLine } }));

    await h.svc.ensureBots([BOT]);

    expect(h.currency.apply).not.toHaveBeenCalled();
  });

  it('余额充足 ⇒ 零 apply、零指标（只观测）', async () => {
    h.currency.get.mockImplementation(getReturns({ [BOT]: { balance: 20000 } }));
    const before = await topupCount('refill');

    await h.svc.ensureBots([BOT]);

    expect(h.currency.apply).not.toHaveBeenCalled();
    await expect(topupCount('refill')).resolves.toBe(before);
  });

  it('批次混合（缺失 / 达标 / 低水位）⇒ 只对需要的两座 apply，顺序按入参', async () => {
    const lowBot = 'bot-int-2';
    const okBot = 'bot-int-3';
    const low = robotWaterLevels(lowBot, TOP);
    h.currency.get.mockImplementation(
      async (req: { ownerIds: string[] }) => ({
        balances: req.ownerIds.map((ownerId) => ({
          ownerId,
          balance: ownerId === lowBot ? low.refillLine - 1 : ownerId === okBot ? 20000 : 0,
          exists: ownerId !== BOT,
        })),
      }),
    );

    await h.svc.ensureBots([BOT, okBot, lowBot]);

    const applied = h.currency.apply.mock.calls.map((c) => (c[0] as CurrencyApplyRequest).actionId);
    expect(applied).toEqual([
      `rr:${BOT}:${LEVELS.target}:0`,
      `rr:${lowBot}:${low.target}:${low.refillLine - 1}`,
    ]);
  });

  it('空列表（房满、无机器人座）⇒ 零调用', async () => {
    await h.svc.ensureBots([]);
    expect(h.currency.get).not.toHaveBeenCalled();
    expect(h.currency.apply).not.toHaveBeenCalled();
  });

  it('get 失败 ⇒ **抛**（走既有补位失败路径）+ ensure_failed +1；apply 不得被调', async () => {
    const failedBefore = await ensureFailedCount();
    h.currency.get.mockRejectedValue(
      new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'currency-service down'),
    );

    await expect(h.svc.ensureBots([BOT])).rejects.toThrow('currency-service down');

    expect(h.currency.apply).not.toHaveBeenCalled();
    await expect(ensureFailedCount()).resolves.toBe(failedBefore + 1);
  });

  it('apply 失败（14001 池空）⇒ **抛**（不是 fail-open —— ensure 与开局同生共死）+ 指标 + 日志点名池', async () => {
    const records = installSink();
    try {
      const failedBefore = await ensureFailedCount();
      h.currency.apply.mockRejectedValue(
        new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'insufficient'),
      );

      await expect(h.svc.ensureBots([BOT])).rejects.toBeInstanceOf(CurrencyServiceError);

      await expect(ensureFailedCount()).resolves.toBe(failedBefore + 1);
      expect(
        records.some((r) => r.msg.includes('14001') && r.msg.includes('pool')),
        '日志必须点名「池余额不足（14001）」——runbook 充值的触发信号',
      ).toBe(true);
    } finally {
      restoreLogger();
    }
  });

  it('同观测重复触发 ⇒ **同 id 同载荷**（apply 第二次带同一 actionId）；replayed ⇒ 不重复计速率', async () => {
    const before = await topupCount('refill');
    h.currency.get.mockImplementation(getReturns({ [BOT]: { balance: 5000 } }));

    await h.svc.ensureBots([BOT]); // 第一次：真动钱
    h.currency.apply.mockImplementation(applyOk(true)); // 第二次：下游回放（观测尚未可见）
    await h.svc.ensureBots([BOT]);

    expect(h.currency.apply).toHaveBeenCalledTimes(2);
    const first = h.currency.apply.mock.calls[0]![0] as CurrencyApplyRequest;
    const second = h.currency.apply.mock.calls[1]![0] as CurrencyApplyRequest;
    expect(second.actionId, '同观测 ⇒ 同 actionId（幂等锚）').toBe(first.actionId);
    expect(second.entries, '同 id ⇒ 同载荷').toEqual(first.entries);
    await expect(topupCount('refill'), 'replayed 不得重复计（钱只动了一次）').resolves.toBe(before + 1);
  });

  it('top 逐调用推导：entryMultiplier 变化 ⇒ target/actionId 随 max(baseScoreLevels)×倍数 联动', async () => {
    h.configCache.entryMultiplier.mockReturnValue(20);
    const top20k = 1200 * 20;
    const expected = robotWaterLevels(BOT, top20k);

    await h.svc.ensureBots([BOT]);

    expect((h.currency.apply.mock.calls[0]![0] as CurrencyApplyRequest).actionId).toBe(
      `rr:${BOT}:${expected.target}:0`,
    );
  });

  it('top 不可推导（baseScoreLevels 抛）⇒ 抛 + 指标（不吞配置故障）', async () => {
    const failedBefore = await ensureFailedCount();
    h.configCache.baseScoreLevels.mockRejectedValue(new Error('config snapshot down'));

    await expect(h.svc.ensureBots([BOT])).rejects.toThrow('config snapshot down');

    expect(h.currency.get).not.toHaveBeenCalled();
    await expect(ensureFailedCount()).resolves.toBe(failedBefore + 1);
  });

  it('top < 15（违反不变量前提）⇒ 响亮失败（不是带着破掉的不变量去动钱）', async () => {
    const small = makeHarness();
    small.configCache.baseScoreLevels.mockResolvedValue([{ name: 'tiny', baseScore: 1 }]);

    await expect(small.svc.ensureBots([BOT])).rejects.toThrow(/must be an integer ≥ 15/);

    expect(small.currency.apply).not.toHaveBeenCalled();
  });
});

describe('RobotFunding.afterSettle：结算后动作（规格 §7 下半；fail-open）', () => {
  let h: FundingHarness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('balanceAfter < refillLine ⇒ rr 补（观测 = balanceAfter，非 0 —— 结算后观测的是真实余额）', async () => {
    const after = LEVELS.refillLine - 100;
    const before = await topupCount('refill');

    await h.svc.afterSettle([{ botId: BOT, balanceAfter: after }]);

    expect(h.currency.get, '结算后以 balanceAfter 为准 —— 不需要再 get').not.toHaveBeenCalled();
    expect(h.currency.apply).toHaveBeenCalledWith({
      actionId: `rr:${BOT}:${LEVELS.target}:${after}`,
      source: 'robot_pool',
      refId: BOT,
      entries: [
        { ownerId: ROBOT_POOL_OWNER_ID, ownerType: 'robot', delta: -(LEVELS.target - after) },
        { ownerId: BOT, ownerType: 'robot', delta: LEVELS.target - after },
      ],
    });
    await expect(topupCount('refill')).resolves.toBe(before + 1);
  });

  it('balanceAfter > recallLine ⇒ rc 回收至 target（bot→pool 方向）+ topup{recall} +1', async () => {
    const after = LEVELS.recallLine + 5000;
    const before = await topupCount('recall');

    await h.svc.afterSettle([{ botId: BOT, balanceAfter: after }]);

    expect(h.currency.apply).toHaveBeenCalledWith({
      actionId: `rc:${BOT}:${LEVELS.target}:${after}`,
      source: 'robot_pool',
      refId: BOT,
      entries: [
        { ownerId: BOT, ownerType: 'robot', delta: -(after - LEVELS.target) },
        { ownerId: ROBOT_POOL_OWNER_ID, ownerType: 'robot', delta: after - LEVELS.target },
      ],
    });
    await expect(topupCount('recall')).resolves.toBe(before + 1);
  });

  it('带内（≥补给线且≤回收线）⇒ 零动作（余额随输赢漂移的常态）', async () => {
    await h.svc.afterSettle([{ botId: BOT, balanceAfter: LEVELS.target }]);
    expect(h.currency.apply).not.toHaveBeenCalled();
  });

  it('零 delta 座（无 balanceAfter）不入参 ⇒ 本函数零动作；全零批同样零调用', async () => {
    // 契约（T5 finalize 已过滤）：零 delta 座没有 balanceAfter，不会抵达本函数。
    await h.svc.afterSettle([]);
    expect(h.currency.apply).not.toHaveBeenCalled();
    expect(h.currency.get).not.toHaveBeenCalled();
  });

  it('**fail-open**：单座失败不抛、继续下一座；ensure_failed 每失败一座 +1', async () => {
    const records = installSink();
    try {
      const badBot = 'bot-int-9';
      const failedBefore = await ensureFailedCount();
      const bad = robotWaterLevels(badBot, TOP);
      h.currency.apply.mockImplementationOnce(async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'transport');
      });

      await expect(
        h.svc.afterSettle([
          { botId: badBot, balanceAfter: bad.refillLine - 50 },
          { botId: BOT, balanceAfter: LEVELS.refillLine - 100 },
        ]),
        'fail-open：绝不 reject',
      ).resolves.toBeUndefined();

      expect(h.currency.apply).toHaveBeenCalledTimes(2);
      expect(
        (h.currency.apply.mock.calls[1]![0] as CurrencyApplyRequest).actionId,
        '第一座失败不得吞掉第二座的动作',
      ).toBe(`rr:${BOT}:${LEVELS.target}:${LEVELS.refillLine - 100}`);
      await expect(ensureFailedCount()).resolves.toBe(failedBefore + 1);
      expect(records.some((r) => r.msg.includes('fail-open'))).toBe(true);
    } finally {
      restoreLogger();
    }
  });

  it('池空（14001）⇒ WARN 点名池 + 指标（fail-open：收尾链不受阻）', async () => {
    const records = installSink();
    try {
      const failedBefore = await ensureFailedCount();
      h.currency.apply.mockRejectedValue(
        new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'insufficient'),
      );

      await expect(
        h.svc.afterSettle([{ botId: BOT, balanceAfter: LEVELS.refillLine - 1 }]),
      ).resolves.toBeUndefined();

      await expect(ensureFailedCount()).resolves.toBe(failedBefore + 1);
      expect(records.some((r) => r.msg.includes('14001'))).toBe(true);
    } finally {
      restoreLogger();
    }
  });

  it('整批配置不可推导（baseScoreLevels 抛）⇒ 跳过全批、不抛 + 指标 + WARN', async () => {
    const records = installSink();
    try {
      const failedBefore = await ensureFailedCount();
      h.configCache.baseScoreLevels.mockRejectedValue(new Error('config down'));

      await expect(
        h.svc.afterSettle([{ botId: BOT, balanceAfter: LEVELS.refillLine - 1 }]),
      ).resolves.toBeUndefined();

      expect(h.currency.apply).not.toHaveBeenCalled();
      await expect(ensureFailedCount()).resolves.toBe(failedBefore + 1);
      expect(records.some((r) => r.msg.includes('fail-open'))).toBe(true);
    } finally {
      restoreLogger();
    }
  });

  it('确定性锚：同一 (botId, balanceAfter) 的 actionId 与 ensure 路径同构（rr 族同形）', async () => {
    const after = LEVELS.refillLine - 100;
    await h.svc.afterSettle([{ botId: BOT, balanceAfter: after }]);
    const fromAfterSettle = (h.currency.apply.mock.calls[0]![0] as CurrencyApplyRequest).actionId;

    const h2 = makeHarness();
    h2.currency.get.mockImplementation(getReturns({ [BOT]: { balance: after } }));
    await h2.svc.ensureBots([BOT]);
    const fromEnsure = (h2.currency.apply.mock.calls[0]![0] as CurrencyApplyRequest).actionId;

    expect(fromEnsure, '同 (botId, target, 观测) ⇒ 同 actionId —— 两条路径的幂等锚是同一个').toBe(
      fromAfterSettle,
    );
  });
});

describe('RobotFunding：水位按玩法取档位/倍率（2026-10-24 平行化）', () => {
  it('paodekuai 与 doudizhu 各自算 top，actionId 里的 target 不同', async () => {
    const h = makeHarness();
    h.configCache.baseScoreLevels.mockImplementation(async (gameType?: string) =>
      gameType === 'paodekuai' ? [{ name: 'x', baseScore: 15 }] : [{ name: 'x', baseScore: 1200 }],
    );
    h.configCache.entryMultiplier.mockImplementation((gameType?: string) =>
      gameType === 'paodekuai' ? 20 : 10,
    );

    await h.svc.ensureBots([BOT], 'paodekuai');
    const pdkTop = 15 * 20;
    expect(h.currency.apply.mock.calls[0]![0].actionId).toBe(
      `rr:${BOT}:${robotWaterLevels(BOT, pdkTop).target}:0`,
    );

    h.currency.apply.mockClear();
    await h.svc.ensureBots([BOT], 'doudizhu');
    const ddzTop = 1200 * 10;
    expect(h.currency.apply.mock.calls[0]![0].actionId).toBe(
      `rr:${BOT}:${robotWaterLevels(BOT, ddzTop).target}:0`,
    );
  });

  it('A1：补款与 ensure 失败按 game_type 计数', async () => {
    const h = makeHarness();
    const beforeRefill = await topupCount('refill', 'paodekuai');
    await h.svc.ensureBots(['bot-1'], 'paodekuai');
    expect(await topupCount('refill', 'paodekuai')).toBe(beforeRefill + 1);

    const beforeFailed = await ensureFailedCount('paodekuai');
    h.currency.get.mockRejectedValueOnce(new Error('down'));
    await h.svc.ensureBots(['bot-2'], 'paodekuai').catch(() => undefined);
    expect(await ensureFailedCount('paodekuai')).toBe(beforeFailed + 1);
  });
});

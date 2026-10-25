import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import type { Redis } from 'ioredis';
import type { BotInstance } from '@fight-the-landlord/protocol';
import { ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { CurrencyServiceError } from '../src/currency/currency.client';
import { RoomStartService } from '../src/rooms/rooms.start';
import { RoomsService } from '../src/rooms/rooms.service';
import { roomBalancesKey, ROOM_TTL_SECONDS } from '../src/rooms/rooms.seats';
import { GameClient } from '../src/gateway/game.client';
import { RobotClient } from '../src/gateway/robot.client';
import { ReconnectService } from '../src/reconnect/reconnect.service';
import { asRedis, createFakeRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';
import { labeledValue, metricValue, exactSeriesValue } from './helpers/metric-readout';
import { entryFeeConflictTotal, entryFeeSkippedTotal } from '../src/metrics/room.metrics';

/**
 * 台费收费块（本片规格 §2.3 逐字；C7–C18/C28）。
 *
 * 装配同 `rooms.start.test.ts`：真 `RoomsService` + 假 Redis + 真 `GameClient/RobotClient`（假 proxy）；
 * `CurrencyClient` 轻替身（`get`/`apply`/`entryFeeSkip` 三个 vi.fn）；配置缓存用 stub
 * （缺省 = 种子 4 行 ×0 ⇒ fee==0 ⇒ 既有路径零行为；本组用例显式覆写费率）。
 */
describe('RoomStartService 收费块（本片：位置/短路/逐人并发/重试快照/四分支/回写/免单）', () => {
  let redis: FakeRedis;
  let rooms: RoomsService;
  let configCache: ConfigCacheStub;
  let service: RoomStartService;
  let calls: Array<{ pattern: string; data: unknown }>;
  let handlers: Map<string, (data: unknown, index: number) => unknown>;
  let currency: {
    get: ReturnType<typeof vi.fn>;
    apply: ReturnType<typeof vi.fn>;
    entryFeeSkip: ReturnType<typeof vi.fn>;
  };
  let captured: ReturnType<typeof createCapturingSink>;

  const FEE_ON = [{ baseScore: 15, percent: 10 }]; // 15 × 10% ⇒ fee = max(1, floor(1.5)) = 1
  const okApply = (req: { actionId: string; entries: Array<{ ownerId: string }> }) => ({
    opId: 1,
    actionId: req.actionId,
    entries: req.entries.map((e) => ({ ownerId: e.ownerId, balanceAfter: 99 })),
    replayed: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createFakeRedis();
    configCache = makeConfigCache();
    rooms = new RoomsService(asRedis(redis), asConfigCache(configCache));
    calls = [];
    handlers = new Map();
    const send = vi.fn((pattern: string, data: unknown) => {
      const index = calls.filter((c) => c.pattern === pattern).length;
      calls.push({ pattern, data });
      const handler = handlers.get(pattern);
      if (handler) return handler(data, index);
      if (pattern === RPC_PATTERNS.robotAcquire) {
        const seats = (data as { seats?: number[] }).seats ?? [1];
        return of({
          ok: true,
          data: {
            bots: seats.map((s): BotInstance => ({
              botId: `bot-${s}`,
              displayId: `p_${String(s).padStart(8, '0')}`,
              skillLevel: 'beginner',
              personality: { thinkingSpeed: 900 },
              roomCode: 'ENT000',
              seat: s,
              gamesPlayed: 0,
            })),
          },
        });
      }
      return of({ ok: true, data: {} });
    });
    const proxy = { send } as never;
    currency = {
      get: vi.fn(async () => ({ balances: [] })),
      apply: vi.fn(async (req: { actionId: string; entries: Array<{ ownerId: string }> }) => okApply(req)),
      entryFeeSkip: vi.fn(async () => ({ inserted: true })),
    };
    captured = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(captured.sink, { service: 'room-service' }));
    service = new RoomStartService(
      asRedis(redis) as Redis,
      rooms,
      new GameClient(proxy),
      new RobotClient(proxy),
      currency as never,
      { ensureBots: vi.fn(async () => undefined), afterSettle: vi.fn() } as never,
      new ReconnectService(asRedis(redis)),
      asConfigCache(configCache),
    );
  });

  /** 金币房 + 入座（满 3 真人 ⇒ 不补位；2 真人 ⇒ 补 1 机器人）。 */
  async function goldRoom(code: string, humans: string[]): Promise<void> {
    await rooms.create({ mode: 'gold', roomCode: code });
    for (const id of humans) await rooms.join(code, id);
  }

  const warns = (): string[] =>
    captured.records.filter((r) => r.level === 'warn').map((r) => String(r.msg));
  const errors = (): string[] =>
    captured.records.filter((r) => r.level === 'error').map((r) => String(r.msg));

  it('C7/C27 反面：game.start 失败（strict）⇒ 零 apply；非金币场（practice）⇒ 零 apply 零 skip', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    handlers.set(RPC_PATTERNS.gameStart, () => of({ ok: false, code: 10007, message: 'down' }));
    await goldRoom('ENT01', ['u1', 'u2', 'u3']);
    const failed = await service.startRoom('ENT01', { strict: true });
    expect(failed).toBe(false);
    expect(currency.apply).not.toHaveBeenCalled();

    handlers.clear();
    await rooms.create({ mode: 'practice', roomCode: 'ENT02' });
    await rooms.join('ENT02', 'u1');
    const okPractice = await service.startRoom('ENT02', { strict: true });
    expect(okPractice).toBe(true);
    expect(currency.apply).not.toHaveBeenCalled();
    expect(currency.entryFeeSkip).not.toHaveBeenCalled();
  });

  it('C8：三人 ⇒ 恰三条 op（逐字段）；机器人零 entries 零调用', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    await goldRoom('ENT03', ['u1', 'u2']); // 2 真人 ⇒ 补 1 机器人

    expect(await service.startRoom('ENT03', { strict: true })).toBe(true);

    expect(currency.apply).toHaveBeenCalledTimes(2);
    const payloads = currency.apply.mock.calls.map((c) => c[0]);
    expect(payloads).toEqual([
      {
        actionId: 'entryfee:ENT03:u1',
        source: 'entry_fee',
        entries: [{ ownerId: 'u1', delta: -1 }],
        refId: 'ENT03',
      },
      {
        actionId: 'entryfee:ENT03:u2',
        source: 'entry_fee',
        entries: [{ ownerId: 'u2', delta: -1 }],
        refId: 'ENT03',
      },
    ]);
    // 机器人零调用：载荷里不出现任何 displayId 形态的 ownerId
    for (const p of payloads) {
      expect(String(p.entries[0].ownerId)).toMatch(/^u\d$/);
    }
  });

  it('C9：该房 fee==0 四种来源（空表 / 未命中 / percent=0 / 形状坏归一）⇒ 零 apply 零 skip 零指标', async () => {
    const skippedBefore = (await labeledValue(entryFeeSkippedTotal, { reason: 'insufficient_funds' })) ?? 0;
    const conflictBefore = await metricValue(entryFeeConflictTotal);

    const cases = [
      ['ENT11', '空表（快照缺失/键缺失/形状坏的归一形态）', []],
      ['ENT12', '未命中该房 baseScore', [{ baseScore: 80, percent: 10 }]],
      ['ENT13', '该档 percent=0', [{ baseScore: 15, percent: 0 }]],
    ] as const;
    for (const [code, label, table] of cases) {
      configCache.entryFeePercents.mockReturnValue(table as never);
      await goldRoom(code, ['u1', 'u2', 'u3']);
      expect(await service.startRoom(code, { strict: true }), label).toBe(true);
    }

    expect(currency.apply).not.toHaveBeenCalled();
    expect(currency.entryFeeSkip).not.toHaveBeenCalled();
    expect((await labeledValue(entryFeeSkippedTotal, { reason: 'insufficient_funds' })) ?? 0).toBe(skippedBefore);
    expect(await metricValue(entryFeeConflictTotal)).toBe(conflictBefore);
    expect(warns().filter((m) => m.includes('entry_fee.skipped'))).toEqual([]);
  });

  it('C10：重试 = 首尝试载荷快照（两尝试之间改费率 ⇒ 载荷不变）；同锚（actionId 恒同）', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    currency.apply
      .mockImplementationOnce(async () => {
        // 首尝试失败前**中途改费率**（若实现「重试时重读配置」⇒ 第二发 fee 会变 7）
        configCache.entryFeePercents.mockReturnValue([{ baseScore: 15, percent: 50 }]);
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '传输失败');
      })
      .mockImplementation(async (req: { actionId: string; entries: Array<{ ownerId: string }> }) => okApply(req));

    await goldRoom('ENT20', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('ENT20', { strict: true })).toBe(true);

    expect(currency.apply).toHaveBeenCalledTimes(4); // u1×2（失败+重发）+ u2/u3 各 1
    const u1Calls = currency.apply.mock.calls.filter(
      (c) => (c[0] as { actionId: string }).actionId === 'entryfee:ENT20:u1',
    );
    expect(u1Calls).toHaveLength(2);
    expect(u1Calls[0]![0]).toEqual(u1Calls[1]![0]); // 同锚同载荷快照（fee 仍 1）
    expect((u1Calls[1]![0] as { entries: Array<{ delta: number }> }).entries[0]!.delta).toBe(-1);
  });

  it('C11：三人**并发发起**（屏障式判据：三发齐才放行）', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    const starts: string[] = [];
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => (releaseAll = resolve));
    currency.apply.mockImplementation(async (req: { actionId: string; entries: Array<{ ownerId: string }> }) => {
      starts.push(req.actionId);
      if (starts.length === 3) releaseAll();
      await gate; // 串行实现会在第一发上死等到用例超时 ⇒ 当场红
      return okApply(req);
    });

    await goldRoom('ENT30', ['u1', 'u2', 'u3']);
    const ok = await service.startRoom('ENT30', { strict: true });

    expect(ok).toBe(true);
    expect(starts).toHaveLength(3);
  });

  it('C12：同房二开 ⇒ 第二笔同锚同载荷（replayed:true）⇒ 钱只动一次；重放路径照常回写余额', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    await goldRoom('ENT40', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('ENT40', { strict: true })).toBe(true);
    const firstPayload = currency.apply.mock.calls[0]![0];

    // 模拟「房间留 waiting 供扫描重试」的形态：复位为 waiting 后再开一次（同扫描器的重开路径）
    await rooms.updateStatus('ENT40', 'waiting');
    /**
     * 🔴 判别力（T5 评审 Important）：先**删掉**第一次开局写下的派生键 —— 否则键上残留
     * 首开的 `'99'` + TTL，即便实现改成「replayed 时不回写」，下面两条断言也因**残留值**
     * 恒真（空测）。删键之后，「键存在且值 = 重放响应的 balanceAfter」才咬得住。
     */
    await redis.del(roomBalancesKey('ENT40'));
    expect(redis.hashes.has(roomBalancesKey('ENT40'))).toBe(false);
    /**
     * 重放响应用**区别于首开**的 balanceAfter（77 ≠ 99）—— 回写唯一真源 = 响应
     * `entries[].balanceAfter`：残留值/硬编码值都会被下面逐座的断言咬红。
     */
    currency.apply.mockImplementation(async (req: { actionId: string; entries: Array<{ ownerId: string }> }) => ({
      opId: 1,
      actionId: req.actionId,
      entries: req.entries.map((e) => ({ ownerId: e.ownerId, balanceAfter: 77 })),
      replayed: true,
    }));
    expect(await service.startRoom('ENT40', { strict: true })).toBe(true);

    const u1Second = currency.apply.mock.calls
      .slice(3)
      .find((c) => (c[0] as { actionId: string }).actionId === 'entryfee:ENT40:u1');
    expect(u1Second![0]).toEqual(firstPayload); // 同锚同载荷 ⇒ 服务端重放判定 ⇒ 钱只动一次（钱面在 apply 的 uk_action_id）
    // 重放路径照常回写（响应 entries[].balanceAfter 被写进派生键）—— 键为删后重写，三座值恰 = 重放响应的 77
    expect(redis.hashes.get(roomBalancesKey('ENT40'))).toEqual({ '0': '77', '1': '77', '2': '77' });
    expect(redis.ttls.get(roomBalancesKey('ENT40'))).toBe(ROOM_TTL_SECONDS);
  });

  it('C13：14002 ⇒ 响亮日志 + entry_fee_conflict_total +1；零 skips 调用、零 skipped 指标、不回写', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    const conflictBefore = await metricValue(entryFeeConflictTotal);
    const skippedBefore = (await labeledValue(entryFeeSkippedTotal, { reason: 'unknown_outcome' })) ?? 0;
    currency.apply.mockImplementation(async () => {
      throw new CurrencyServiceError(ErrCode.E_ACTION_CONFLICT, '该操作已存在');
    });

    await goldRoom('ENT50', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('ENT50', { strict: true })).toBe(true);

    expect(await metricValue(entryFeeConflictTotal)).toBe(conflictBefore + 3);
    expect(currency.entryFeeSkip).not.toHaveBeenCalled();
    expect((await labeledValue(entryFeeSkippedTotal, { reason: 'unknown_outcome' })) ?? 0).toBe(skippedBefore);
    expect(errors().filter((m) => m.includes('entry fee conflict')).length).toBe(3);
    expect(redis.hashes.get(roomBalancesKey('ENT50')) ?? {}).toEqual({}); // 冲突路径不回写（无回执）
  });

  it('C14：14001 ⇒ 免单 insufficient_funds —— skip 载荷逐字段 + 指标 + 逐笔日志；账户分毫不动（无 op）', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    const before = (await labeledValue(entryFeeSkippedTotal, { reason: 'insufficient_funds' })) ?? 0;
    currency.apply.mockImplementation(async (req: { entries: Array<{ ownerId: string }> }) => {
      if (req.entries[0]!.ownerId === 'u2') {
        throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'ownerId=u2 余额不足：整批回滚（delta=-1）');
      }
      return okApply(req as never);
    });

    await goldRoom('ENT60', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('ENT60', { strict: true })).toBe(true);

    // T5 评审 Minor-2：14001 是**确定性失败**（规格 D4 只许 10007 重试）—— u2 的 apply 恰 1 发；
    // 「14001 也重试到耗尽再免单」的变异在此必红（对照先例 = C15b 的 10001 不重试 :327）。
    const u2ApplyCalls = currency.apply.mock.calls.filter(
      (c) => (c[0] as { entries: Array<{ ownerId: string }> }).entries[0]!.ownerId === 'u2',
    );
    expect(u2ApplyCalls).toHaveLength(1);

    expect(currency.entryFeeSkip).toHaveBeenCalledTimes(1);
    expect(currency.entryFeeSkip).toHaveBeenCalledWith({
      roomCode: 'ENT60',
      ownerId: 'u2',
      seat: 1,
      baseScore: 15,
      feeAmount: 1,
      reason: 'insufficient_funds',
    });
    expect((await labeledValue(entryFeeSkippedTotal, { reason: 'insufficient_funds' })) ?? 0).toBe(before + 1);
    const line = warns().find((m) => m.includes('entry_fee.skipped'));
    expect(line).toContain('roomCode=ENT60');
    expect(line).toContain('ownerId=u2');
    expect(line).toContain('feeAmount=1');
    expect(line).toContain('reason=insufficient_funds');
    expect(line).toContain('opActionId=entryfee:ENT60:u2');
  });

  it('C15：unknown_outcome（≤2 重试耗尽）与 internal_error（其它业务码）各一条可判别用例', async () => {
    vi.useFakeTimers();
    try {
      configCache.entryFeePercents.mockReturnValue(FEE_ON);
      const beforeUnknown = (await labeledValue(entryFeeSkippedTotal, { reason: 'unknown_outcome' })) ?? 0;
      currency.apply.mockImplementation(async () => {
        throw new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '传输失败');
      });

      await goldRoom('ENT70', ['u1', 'u2', 'u3']);
      const pending = service.startRoom('ENT70', { strict: true });
      /**
       * T5 评审 Minor-1：退避**确切排程**逐档钉死（300ms / 1000ms；常量真源 =
       * `ENTRY_FEE_RETRY_BACKOFF_MS`）—— 逐档边界 advance（差 1ms 不得放行 + 到点恰好放行）：
       * [200,200]（t=200 就出第二发 ⇒ 299 处计数已 6）、[300,999]/[300,1001]（第三发时点偏差
       * ⇒ 999/1 两条断言咬红）、[2000,…]（首档超 300 ⇒ 到点计数仍 3）等错误阶梯都不是通过态；
       * 不再是单跳 1400ms 只能咬「总退避 > 1400」的半钉。
       */
      await vi.advanceTimersByTimeAsync(0); // 首发三发落地（0 退避）
      expect(currency.apply).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(299); // 第一档 300ms：299ms 处第二发仍未发
      expect(currency.apply).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1); // t=300：第二发 ×3
      expect(currency.apply).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(999); // 第二档 1000ms：999ms 处第三发仍未发
      expect(currency.apply).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(1); // t=1300（=300+1000）：第三发 ×3
      expect(currency.apply).toHaveBeenCalledTimes(9); // 每人恰 ≤3 次尝试（首发 + 2 重试）
      expect(await pending).toBe(true);

      const unknownCalls = currency.entryFeeSkip.mock.calls.filter(
        (c) => (c[0] as { reason: string }).reason === 'unknown_outcome',
      );
      expect(unknownCalls).toHaveLength(3);
      expect((await labeledValue(entryFeeSkippedTotal, { reason: 'unknown_outcome' })) ?? 0).toBe(beforeUnknown + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('C15b：10001（确定性业务码）⇒ 不重试、直接 internal_error；异常（非 CurrencyServiceError）⇒ 同', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    currency.apply.mockImplementation(async () => {
      throw new CurrencyServiceError(ErrCode.BAD_PARAM, '参数非法');
    });

    await goldRoom('ENT71', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('ENT71', { strict: true })).toBe(true);

    expect(currency.apply).toHaveBeenCalledTimes(3); // 每人恰 1 发（不重试）
    const reasons = currency.entryFeeSkip.mock.calls.map((c) => (c[0] as { reason: string }).reason);
    expect(reasons).toEqual(['internal_error', 'internal_error', 'internal_error']);
  });

  it('C15c：非 CurrencyServiceError 异常（如驱动不变量）⇒ internal_error（不重试）', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    currency.apply.mockImplementation(async () => {
      throw new Error('驱动回执畸形');
    });

    await goldRoom('ENT72', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('ENT72', { strict: true })).toBe(true);

    expect(currency.apply).toHaveBeenCalledTimes(3);
    expect(currency.entryFeeSkip.mock.calls.map((c) => (c[0] as { reason: string }).reason)).toEqual([
      'internal_error',
      'internal_error',
      'internal_error',
    ]);
  });

  it('C16：判别三步 —— inserted=true ⇒ 指标+日志；false ⇒ 仅 debug 零指标；RPC 失败 ⇒ 指标照计 + warn「落行失败」', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    // ① inserted=false：同房二开重复免单 ⇒ 零指标、零 warn
    const before = (await labeledValue(entryFeeSkippedTotal, { reason: 'insufficient_funds' })) ?? 0;
    currency.apply.mockImplementation(async () => {
      throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, '余额不足');
    });
    currency.entryFeeSkip.mockResolvedValue({ inserted: false });
    await goldRoom('ENT80', ['u1', 'u2', 'u3']);
    await service.startRoom('ENT80', { strict: true });
    expect((await labeledValue(entryFeeSkippedTotal, { reason: 'insufficient_funds' })) ?? 0).toBe(before);
    expect(warns().filter((m) => m.includes('entry_fee.skipped'))).toEqual([]);

    // ② RPC 失败：指标照计 + warn 注明「落行失败」
    currency.entryFeeSkip.mockRejectedValue(new CurrencyServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '传输失败'));
    await goldRoom('ENT81', ['u1', 'u2', 'u3']);
    await service.startRoom('ENT81', { strict: true });
    expect((await labeledValue(entryFeeSkippedTotal, { reason: 'insufficient_funds' })) ?? 0).toBe(before + 3);
    expect(warns().filter((m) => m.includes('落行失败')).length).toBe(3);
  });

  it('C18：apply 抛 / skip RPC 抛 / 回写抛 ⇒ startRoom 仍返回 true、开局不受影响', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    /**
     * ⚠️ 与任务书唯一的偏离（1 token；证据见 t5-c18-verbatim.log）：任务书原句为
     * `mockImplementation`（**恒抛**）—— 但恒抛下「回写抛」这条腿**不可达**（apply 全败 ⇒
     * 从不走到 writeBackFeeBalance），末条断言（'entry fee write-back failed'）在任务书
     * 自己的实现下也必红（已实证：388 行断言红）。改 `mockImplementationOnce`（首发抛、
     * 其余沿用 beforeEach 的成功桩）后三条腿全部可达：u1 = apply 抛 + skip RPC 抛；
     * u2/u3 = 回写抛（hset 注入命中）—— 与用例标题/规格 C18 三腿、代码注释
     * 「回写才命中注入」逐条对齐。
     */
    currency.apply.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    currency.entryFeeSkip.mockRejectedValue(new Error('skip boom'));

    const original = redis.hset.getMockImplementation()!;
    // ⚠️ 参数类型照 `hset` 自身签名（任务书作 `never` ⇒ tsc 两向不兼容、lint 必红；
    // 先例 = `match.service.test.ts` 的 `createGameRoom` 替换，逐参写实类型）。
    redis.hset.mockImplementation(
      async (key: string, fieldOrObject: string | Record<string, string>, value?: string) => {
        if (key === roomBalancesKey('ENT90')) throw new Error('redis down（仿真）');
        return original(key, fieldOrObject, value);
      },
    );

    await goldRoom('ENT90', ['u1', 'u2', 'u3']); // 满座 ⇒ 补位不触及 hset；回写才命中注入
    const ok = await service.startRoom('ENT90', { strict: true });

    expect(ok).toBe(true);
    expect((await rooms.findOne('ENT90'))!.status).toBe('playing');
    expect(warns().some((m) => m.includes('entry fee write-back failed'))).toBe(true);
  });

  it('C28：成功后 room:{code}:balances 座位值 = 响应 balanceAfter（覆盖扣前值）+ EXPIRE 续期', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);
    // 扣前值先落派生键（storeGoldBalances 读边），收费后应被回写覆盖
    currency.get.mockResolvedValue({
      balances: [
        { ownerId: 'u1', balance: 500, exists: true },
        { ownerId: 'u2', balance: 500, exists: true },
        { ownerId: 'u3', balance: 500, exists: true },
      ],
    });

    await goldRoom('ENT91', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('ENT91', { strict: true })).toBe(true);

    const key = roomBalancesKey('ENT91');
    expect(redis.hashes.get(key)).toEqual({ '0': '99', '1': '99', '2': '99' });
    expect(redis.ttls.get(key)).toBe(ROOM_TTL_SECONDS);
  });

  it('A1：台费免单/冲突按 game_type 计数', async () => {
    configCache.entryFeePercents.mockReturnValue(FEE_ON);

    currency.apply.mockImplementation(async () => {
      throw new CurrencyServiceError(ErrCode.E_ACTION_CONFLICT, '该操作已存在');
    });
    const beforeConflict = (await exactSeriesValue(entryFeeConflictTotal, {
      game_type: 'doudizhu',
    })) ?? 0;
    await goldRoom('A1F01', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('A1F01', { strict: true })).toBe(true);
    expect(await exactSeriesValue(entryFeeConflictTotal, {
      game_type: 'doudizhu',
    })).toBe(beforeConflict + 3);

    currency.apply.mockImplementation(async (req: { entries: Array<{ ownerId: string }> }) => {
      if (req.entries[0]!.ownerId === 'u2') {
        throw new CurrencyServiceError(ErrCode.E_INSUFFICIENT_FUNDS, 'ownerId=u2 余额不足');
      }
      return okApply(req as never);
    });
    const beforeSkip = (await exactSeriesValue(entryFeeSkippedTotal, {
      game_type: 'doudizhu', reason: 'insufficient_funds',
    })) ?? 0;
    await goldRoom('A1F02', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('A1F02', { strict: true })).toBe(true);
    expect(await exactSeriesValue(entryFeeSkippedTotal, {
      game_type: 'doudizhu', reason: 'insufficient_funds',
    })).toBe(beforeSkip + 1);
  });
});

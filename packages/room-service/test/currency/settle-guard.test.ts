/**
 * ② 金币场 T5（规格 §4 守卫逐条 / C25）：**结算守卫**与输入取数。
 *
 * 判据形态（brief Step 2）：
 *  - **正对照先行**：守卫全过的金币局 ⇒ 真的走到 apply（否则下面每条「不调 apply」
 *    都可能是空测 —— R115 的纪律）；
 *  - 每条缺失分支 ⇒ WARN + `dropped` 指标 + **不调 get/apply**；
 *  - `mode` 非 gold ⇒ **静默**（免费场/好友房是正常路径，不许刷 WARN、不许计指标）；
 *  - 房间缺失 ⇒ WARN 但**不计指标**（无从判定是不是金币局）；
 *  - 机器人座 ownerId = **内部 botId**（入参透传的 `botBySeat`）——绝不出 displayId；
 *  - settle 内**不重读** bots 键（假 Redis 的 hgetall 在整个 settle 里零调用）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { CurrencyServiceError } from '../../src/currency/currency.client';
import { goldRoom, installSink, makeHarness, restoreLogger, resultCount, validInput, balancesFor, applyOk, ROOM_CODE, VERSION } from './helpers';

afterEach(() => {
  restoreLogger();
});

describe('守卫正对照：全过的金币局真的走到 apply（反空测）', () => {
  it('apply 被调用、entries 用 botId（不是 displayId）、metric/收尾链落地', async () => {
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: never }) =>
      applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }),
    );

    await h.svc.settle(validInput());

    expect(h.currency.apply).toHaveBeenCalledTimes(1);
    const req = h.currency.apply.mock.calls[0]![0] as {
      actionId: string;
      source: string;
      refId: string;
      entries: Array<{ ownerId: string; ownerType: string; delta: number }>;
      burn: { residue: number; rake: number };
    };
    expect(req.actionId).toBe(`settle:${ROOM_CODE}:${VERSION}`);
    expect(req.source).toBe('game_settle');
    expect(req.refId).toBe(`${ROOM_CODE}:${VERSION}`);
    // 🔴 机器人座 ownerId = 内部 botId（`p_bot0001` 永不出现）—— C25 的正向半边
    expect(req.entries).toEqual([
      { ownerId: 'alice', ownerType: 'user', delta: 30 },
      { ownerId: 'bot-int-1', ownerType: 'robot', delta: -15 },
      { ownerId: 'carol', ownerType: 'user', delta: -15 },
    ]);
    // 本片：销毁两值随载荷**恒带**（零和局 ⇒ 0/0，不是缺席）
    expect(req.burn).toEqual({ residue: 0, rake: 0 });
    expect(JSON.stringify(req)).not.toContain('p_bot');
    await expect(resultCount('ok')).resolves.toBeGreaterThanOrEqual(1);
    // settle 内**不重读** bots 键（判据：假 Redis 的 hgetall 零调用）
    expect(h.redis.hgetall).not.toHaveBeenCalled();
  });
});

describe('守卫：mode 非 gold ⇒ 静默跳过（正常路径，不 WARN 不指标不调资金边）', () => {
  it('random 房：无日志行、零资金调用、dropped 不变', async () => {
    const records = installSink();
    const h = makeHarness();
    const before = await resultCount('dropped');

    await h.svc.settle(validInput({ room: goldRoom({ mode: 'random' }) }));

    expect(h.currency.get).not.toHaveBeenCalled();
    expect(h.currency.apply).not.toHaveBeenCalled();
    expect(records.filter((r) => r.msg.includes('Currency settle'))).toEqual([]);
    await expect(resultCount('dropped')).resolves.toBe(before);
  });
});

describe('守卫：房间缺失（TTL 窗）⇒ WARN 跳过，但**不计指标**', () => {
  it('room=null：WARN 一行、零资金调用、dropped 不变（无从判定是否金币局）', async () => {
    const records = installSink();
    const h = makeHarness();
    const before = await resultCount('dropped');

    await h.svc.settle(validInput({ room: null }));

    expect(h.currency.get).not.toHaveBeenCalled();
    const line = records.find((r) => r.msg.includes('room data missing'));
    expect(line, '房间缺失必须 WARN（否则是静默）').toBeDefined();
    expect(line!.level).toBe('warn');
    await expect(resultCount('dropped')).resolves.toBe(before);
  });
});

describe('守卫：result / version / 座位 / 机器人映射（缺任 ⇒ WARN + dropped + 不调资金边）', () => {
  it('result 缺 ⇒ WARN + dropped', async () => {
    const records = installSink();
    const h = makeHarness();
    const before = await resultCount('dropped');

    await h.svc.settle(validInput({ result: undefined }));

    expect(records.some((r) => r.msg.includes('carries no result'))).toBe(true);
    expect(h.currency.get).not.toHaveBeenCalled();
    expect(h.currency.apply).not.toHaveBeenCalled();
    await expect(resultCount('dropped')).resolves.toBe(before + 1);
  });

  it('version 缺（undefined / 0 / 负数）⇒ WARN + dropped（actionId 防 undefined 的核心守卫）', async () => {
    const records = installSink();
    const before = await resultCount('dropped');

    for (const version of [undefined, 0, -1] as const) {
      const h = makeHarness();
      await h.svc.settle(validInput({ version }));
      expect(h.currency.get).not.toHaveBeenCalled();
      expect(h.currency.apply).not.toHaveBeenCalled();
    }

    expect(records.filter((r) => r.msg.includes('carries no version'))).toHaveLength(3);
    await expect(resultCount('dropped')).resolves.toBe(before + 3);
  });

  it('三座位不齐（缺 seat 2）⇒ WARN + dropped，且**不读余额**（守卫先于读边）', async () => {
    const records = installSink();
    const h = makeHarness();
    const before = await resultCount('dropped');
    const room = goldRoom();
    room.players = room.players.filter((p) => p.seat !== 2);

    await h.svc.settle(validInput({ room }));

    expect(records.some((r) => r.msg.includes('seats incomplete'))).toBe(true);
    expect(h.currency.get).not.toHaveBeenCalled();
    await expect(resultCount('dropped')).resolves.toBe(before + 1);
  });

  it('C25：机器人座映射缺（botBySeat 空）⇒ WARN + dropped + 不调 apply', async () => {
    const records = installSink();
    const h = makeHarness();
    const before = await resultCount('dropped');

    await h.svc.settle(validInput({ botBySeat: new Map() }));

    expect(records.some((r) => r.msg.includes('robot seat mapping missing'))).toBe(true);
    expect(h.currency.get).not.toHaveBeenCalled();
    expect(h.currency.apply).not.toHaveBeenCalled();
    await expect(resultCount('dropped')).resolves.toBe(before + 1);
  });

  it('守卫⑤的反面：全人类三座不受 bots 映射影响（botBySeat 空也照常结算）', async () => {
    const h = makeHarness();
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply.mockImplementation(
      async (req: { actionId: string; entries: Parameters<typeof applyOk>[1] }) =>
        applyOk(req.actionId, req.entries, {}),
    );

    await h.svc.settle(validInput({ room: goldRoom({}, false), botBySeat: new Map() }));

    expect(h.currency.apply).toHaveBeenCalledTimes(1);
  });
});

describe('守卫边缘：settle() 绝不 reject（fire-and-forget 的 crash-loop 红线）', () => {
  it('非 CurrencyServiceError（编程错误）逃逸 ⇒ 顶层兜底：resolved + ERROR + dropped', async () => {
    const records = installSink();
    const h = makeHarness();
    const before = await resultCount('dropped');
    h.currency.get.mockResolvedValue(balancesFor());
    h.currency.apply.mockRejectedValue(new TypeError('boom'));

    await expect(h.svc.settle(validInput())).resolves.toBeUndefined();

    expect(records.some((r) => r.msg.includes('unexpected error'))).toBe(true);
    await expect(resultCount('dropped')).resolves.toBe(before + 1);
  });

  it('未知 5 位码 ⇒ 按可重试处置（同 id 重发；而**不是**直接 dropped）——实现决策②的判别力', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.currency.get.mockResolvedValue(balancesFor());
      // 既非 10007/14001/10001/14002 的码（例如未来新增码）：按可重试处置（见文件头决策②）
      h.currency.apply.mockRejectedValue(new CurrencyServiceError(ErrCode.ILLEGAL_ACTION, 'unknown'));

      const p = h.svc.settle(validInput());
      const expectation = expect(p).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      await expectation;

      expect(h.currency.apply).toHaveBeenCalledTimes(3); // 首发 + 2 次重发
    } finally {
      vi.useRealTimers();
    }
  });
});

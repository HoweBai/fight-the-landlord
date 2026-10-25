/**
 * Task 2.3 / spec §4.6.1：2/3/4 人匹配**逐函数**参数化。
 *
 * 旧实现的组大小全是写死的 3（`>= 3`/`=== 3`/子集 `>= 3`/无机器人路径「恰好 3 真人」）；
 * 本文件按**队列维度**逐项钉住：
 *  - 4 人凑 4、2 人凑 2（含无机器人路径）；
 *  - 3 人桶与 2 人桶**互不串**（同底分也按玩法/人数隔离）；
 *  - 最大合法子集 / 到点兜底同样读 playerCount（4 人局允许 3 人 + 机器人先开）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeMatchServiceHarness, type MatchServiceHarness } from './helpers/match-service-harness';
import { exactSeriesValue } from './helpers/metric-readout';
import { matchPredicateRejectionsTotal, matchSelectionRoundsTotal } from '../src/metrics/room.metrics';

const T0 = 1_700_000_000_000;

describe('2/3/4 人匹配参数化（Task 2.3）', () => {
  const harnesses: MatchServiceHarness[] = [];
  const make = (): MatchServiceHarness => {
    const h = makeMatchServiceHarness();
    harnesses.push(h);
    return h;
  };
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.service.onApplicationShutdown();
  });

  /** 开跑得快（默认 2/3/4 全开；要测闸关闭的用例显式传 false）。 */
  function enablePdk(h: MatchServiceHarness, nonThree = true, two = true): void {
    h.configCache.paodekuaiEnabled.mockReturnValue(true);
    h.configCache.paodekuaiTwoPlayerEnabled.mockReturnValue(two);
    h.configCache.paodekuaiNonThreePlayerEnabled.mockReturnValue(nonThree);
  }

  async function enqueuePdk(h: MatchServiceHarness, ids: string[], playerCount: number): Promise<void> {
    h.clock.set(T0);
    for (const id of ids) {
      await h.service.addToQueue(id, 'random', 15, undefined, undefined, {
        gameType: 'paodekuai',
        playerCount,
      });
    }
  }

  it('4 人：四人齐 ⇒ 恰一个 4 人组（组大小读 playerCount，不写死 3）', async () => {
    const h = make();
    enablePdk(h);
    await enqueuePdk(h, ['u1', 'u2', 'u3', 'u4'], 4);
    h.clock.set(T0 + 1_000); // 窗口未到也应直接成组（≥playerCount）

    await h.service.scanOnce();

    expect(h.rooms.createGameRoom).toHaveBeenCalledTimes(1);
    expect(h.rooms.createGameRoom).toHaveBeenCalledWith(
      ['u1', 'u2', 'u3', 'u4'],
      'random',
      15,
      'paodekuai',
      4,
    );
  });

  it('2 人：两人齐 ⇒ 直接成 2 人组（无「必须 3 人」门槛）', async () => {
    const h = make();
    enablePdk(h);
    await enqueuePdk(h, ['a1', 'a2'], 2);

    await h.service.scanOnce();

    expect(h.rooms.createGameRoom).toHaveBeenCalledWith(['a1', 'a2'], 'random', 15, 'paodekuai', 2);
  });

  it('隔离：同底分的 2 人桶与 3 人桶各成各的房（玩法/人数是分组维度）', async () => {
    const h = make();
    enablePdk(h);
    h.clock.set(T0);
    for (const id of ['a1', 'a2']) {
      await h.service.addToQueue(id, 'random', 15, undefined, undefined, {
        gameType: 'paodekuai',
        playerCount: 2,
      });
    }
    for (const id of ['b1', 'b2', 'b3']) {
      await h.service.addToQueue(id, 'random', 15, undefined, undefined, {
        gameType: 'paodekuai',
        playerCount: 3,
      });
    }

    await h.service.scanOnce();

    expect(h.rooms.createGameRoom).toHaveBeenCalledTimes(2);
    expect(h.rooms.createGameRoom.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        ['a1', 'a2'],
        ['b1', 'b2', 'b3'],
      ]),
    );
    const counts = h.rooms.createGameRoom.mock.calls.map((c) => c[4]);
    expect(counts.sort()).toEqual([2, 3]);
  });

  it('无机器人路径（processQueueNoBots）同样按 playerCount：4 名真人开 4 人房', async () => {
    const h = make();
    enablePdk(h);
    h.configCache.freeBotFillEnabled.mockReturnValue(false);
    await enqueuePdk(h, ['u1', 'u2', 'u3', 'u4'], 4);

    await h.service.scanOnce();

    expect(h.rooms.createGameRoom).toHaveBeenCalledWith(
      ['u1', 'u2', 'u3', 'u4'],
      'random',
      15,
      'paodekuai',
      4,
    );
  });

  it('最大合法子集（maxLegalSubset）读 playerCount：4 人局允许 3 人 + 机器人先开', async () => {
    const h = make();
    enablePdk(h);
    h.configCache.riskPredicateSameDevice.mockReturnValue(true);
    h.clock.set(T0);
    // u1/u2 同设备互斥；u3/u4 无冲突 ⇒ 4 人贪心抽不出 4 人组，最大合法子集 = 3。
    const enqueue = (id: string, deviceId: string) =>
      h.service.addToQueue(id, 'random', 15, undefined, { deviceId }, {
        gameType: 'paodekuai',
        playerCount: 4,
      });
    await enqueue('u1', 'dev-shared');
    await enqueue('u2', 'dev-shared');
    await enqueue('u3', 'dev-a');
    await enqueue('u4', 'dev-b');
    h.clock.set(T0 + 31_000); // 越过补位窗口 ⇒ 子集可以直接带机器人开

    await h.service.scanOnce();

    expect(h.rooms.createGameRoom).toHaveBeenCalledTimes(1);
    expect(h.rooms.createGameRoom).toHaveBeenCalledWith(
      ['u1', 'u3', 'u4'],
      'random',
      15,
      'paodekuai',
      4,
    );
  });

  it('A1：PDK 抽选轮与谓词拒绝带 game_type=paodekuai', async () => {
    const h = make();
    enablePdk(h);
    const beforeRounds = (await exactSeriesValue(matchSelectionRoundsTotal, {
      game_type: 'paodekuai',
    })) ?? 0;
    await enqueuePdk(h, ['a1', 'a2'], 2);
    await h.service.scanOnce();
    expect(await exactSeriesValue(matchSelectionRoundsTotal, {
      game_type: 'paodekuai',
    })).toBe(beforeRounds + 1);

    const beforeRej = (await exactSeriesValue(matchPredicateRejectionsTotal, {
      predicate: 'sameDevice', game_type: 'paodekuai',
    })) ?? 0;
    await (h.service as unknown as {
      accountRejection: (...args: unknown[]) => Promise<void>;
    }).accountRejection(
      'a1', 'a2', { ok: false, memory: false, rejected: [{ name: 'sameDevice' }] }, T0, new Set(), 'paodekuai',
    );
    expect(await exactSeriesValue(matchPredicateRejectionsTotal, {
      predicate: 'sameDevice', game_type: 'paodekuai',
    })).toBe(beforeRej + 1);
  });

  it('B 组：2 人 PDK 同 device 票不同房；谓词拒绝指标 game_type=paodekuai', async () => {
    const h = make();
    enablePdk(h);
    h.configCache.riskPredicateSameDevice.mockReturnValue(true);
    h.clock.set(T0);
    for (const id of ['a1', 'a2']) {
      await h.service.addToQueue(id, 'random', 15, undefined, { deviceId: 'dev-1' }, {
        gameType: 'paodekuai',
        playerCount: 2,
      });
    }
    const before = (await exactSeriesValue(matchPredicateRejectionsTotal, {
      predicate: 'sameDevice',
      game_type: 'paodekuai',
    })) ?? 0;
    h.clock.set(T0 + 31_000);
    await h.service.scanOnce();

    for (const call of h.rooms.createGameRoom.mock.calls) {
      const ids = call[0] as string[];
      expect(ids.includes('a1') && ids.includes('a2')).toBe(false);
    }
    expect(
      await exactSeriesValue(matchPredicateRejectionsTotal, {
        predicate: 'sameDevice',
        game_type: 'paodekuai',
      }),
    ).toBeGreaterThan(before);
  });

  it('B 组：4 人 PDK 全同 device 不会两人同房；谓词拒绝指标 game_type=paodekuai', async () => {
    const h = make();
    enablePdk(h);
    h.configCache.riskPredicateSameDevice.mockReturnValue(true);
    h.clock.set(T0);
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      await h.service.addToQueue(id, 'random', 15, undefined, { deviceId: 'dev-1' }, {
        gameType: 'paodekuai',
        playerCount: 4,
      });
    }
    const before = (await exactSeriesValue(matchPredicateRejectionsTotal, {
      predicate: 'sameDevice',
      game_type: 'paodekuai',
    })) ?? 0;
    h.clock.set(T0 + 31_000);
    await h.service.scanOnce();

    for (const call of h.rooms.createGameRoom.mock.calls) {
      const ids = call[0] as string[];
      // 同 device 的任意两人都不得同组；全同 device 时最多只应有一个真人进组。
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeLessThanOrEqual(1);
    }
    expect(
      await exactSeriesValue(matchPredicateRejectionsTotal, {
        predicate: 'sameDevice',
        game_type: 'paodekuai',
      }),
    ).toBeGreaterThan(before);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PdkHandType } from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES, type PdkSession } from '@fight-the-landlord/shared';
import { resetRedisDouble } from './helpers-ioredis';
import { pdkService, seedPdkSession } from './helpers-pdk';
import { pdkPlayers } from './fixtures/pdk-fixtures';

/**
 * Task 4.2（spec §5.7 / §6.3）：GameService 的**通用**超时路径驱动 pdk。
 *
 * 判据：
 *  - `startGame(pdk)` 走 `runtime.timerPhase='play'` 的计时器；30s 后自动动作；
 *  - 首出超时 = 最小单张；跟牌无解 = 过牌（由 `shared/pdk/autoplay` 同源保证）；
 *  - 超时成功才累加 `timeoutCount`（人类座位），机器人座位豁免。
 */
vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

describe('Task 4.2：pdk 超时（GameService 通用路径）', () => {
  beforeEach(() => {
    resetRedisDouble();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('startGame(pdk)：安装 play 计时器，30s 后行动者自动打最小单张并累加 timeoutCount', async () => {
    vi.useFakeTimers();
    const service = pdkService();

    await service.startGame({
      roomCode: 'PDK-TO1',
      gameType: 'paodekuai',
      playerCount: 3,
      baseScore: 15,
      rules: DEFAULT_PDK_RULES,
      players: pdkPlayers([]),
    });
    const before = (await service.getSession<PdkSession>('PDK-TO1'))!;
    expect(before.state).toBe('playing');
    expect(service['timers'].has('PDK-TO1')).toBe(true);

    const leader = before.currentPlayer;
    await vi.advanceTimersByTimeAsync(30_000);

    const after = (await service.getSession<PdkSession>('PDK-TO1'))!;
    expect(after.version).toBe(before.version + 1);
    expect(after.lastPlayedHand?.type).toBe(PdkHandType.Single);
    expect(after.players[leader]!.hand).toHaveLength(15);
    expect(after.players[leader]!.timeoutCount).toBe(1);
    expect(after.players[leader]!.trustee).toBe(false);
    // 到达下一行动者（人类）⇒ 新的计时器已安装
    expect(service['timers'].has('PDK-TO1')).toBe(true);
  });

  it('首出超时：最小单张（夹具座位 0 持红桃 3）', async () => {
    const service = pdkService();
    await seedPdkSession(service, 'PDK-TO2');

    await service['onTurnTimeout']('PDK-TO2');

    const after = (await service.getSession<PdkSession>('PDK-TO2'))!;
    expect(after.lastPlayedHand).toMatchObject({ type: PdkHandType.Single, keyRank: 3 });
    expect(after.players[0]!.hand).toHaveLength(15);
    expect(after.players[0]!.hand.some((c) => c.r === 3 && c.s === 1)).toBe(false);
    expect(after.currentPlayer).toBe(1);
    expect(after.players[0]!.timeoutCount).toBe(1);
  });

  it('跟牌超时无解：过牌（12 张 A 高顺子；座位 1 无 4/无炸弹）', async () => {
    const service = pdkService();
    const seeded = await seedPdkSession(service, 'PDK-TO3');
    await service.playCards('PDK-TO3', 'p0', seeded.players[0]!.hand.slice(0, 12));

    const beforeTimeout = (await service.getSession<PdkSession>('PDK-TO3'))!;
    expect(beforeTimeout.currentPlayer).toBe(1);

    await service['onTurnTimeout']('PDK-TO3');

    const after = (await service.getSession<PdkSession>('PDK-TO3'))!;
    expect(after.consecutivePasses).toBe(1);
    expect(after.players[1]!.hand).toEqual(beforeTimeout.players[1]!.hand);
    expect(after.lastPlayedHand).toEqual(beforeTimeout.lastPlayedHand);
    expect(after.players[1]!.timeoutCount).toBe(1);
  });

  it('机器人座位超时不累加治理量（botIds 座位豁免）', async () => {
    const service = pdkService();
    // 座位 0 是机器人（首出者）⇒ 超时不应写 timeoutCount/trustee
    await seedPdkSession(service, 'PDK-TO4', { robotSeats: [0] });

    await service['onTurnTimeout']('PDK-TO4');

    const after = (await service.getSession<PdkSession>('PDK-TO4'))!;
    expect(after.players[0]!.timeoutCount).toBe(0);
    expect(after.players[0]!.trustee).toBe(false);
  });
});

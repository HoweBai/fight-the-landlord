import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PdkSettlementResult } from '@fight-the-landlord/protocol';
import { isPdkSettlementResult } from '@fight-the-landlord/protocol';
import type { PdkSession } from '@fight-the-landlord/shared';
import { redisDouble, resetRedisDouble } from './helpers-ioredis';
import { pdkService, seedPdkSession } from './helpers-pdk';

/**
 * Task 4.3：pdk **结算 + 记录**经 GameService 发布到 `game:events`。
 *
 * 判据（spec §4.5.2 / §4.6.3 / §4.9.2）：
 *  - `game.ended.result` 是 pdk 向量（gameType/winnerSeats/scoreChanges/remaining…），零和；
 *  - `game.ended.record` 是 pdk 信封：16 张=32 hex、playedCount、无底牌、2 人局带 unusedCards；
 *  - 终局 `game.state_updated` 的 pdk 视图带 `winnerSeats`（N17 最后一手视图）。
 */
vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

interface PublishedEvent {
  event: 'game.started' | 'game.state_updated' | 'game.ended';
  roomCode: string;
  gameType?: string;
  playerCount?: number;
  version: number;
  seatViews?: Array<Record<string, unknown>>;
  result?: PdkSettlementResult;
  record?: Record<string, unknown>;
}

function eventsOf(roomCode: string): PublishedEvent[] {
  return redisDouble._published
    .map(([, payload]) => JSON.parse(payload) as PublishedEvent)
    .filter((event) => event.roomCode === roomCode);
}

/** 用固定牌堆走完一局（座位 0：12 张顺子 → 三张 4 → 单张 2）。 */
async function playToEnd(service: ReturnType<typeof pdkService>, roomCode: string, playerCount: 2 | 3): Promise<void> {
  const seeded = (await service.getSession<PdkSession>(roomCode))!;
  await service.playCards(roomCode, 'p0', seeded.players[0]!.hand.slice(0, 12));
  for (let seat = 1; seat < playerCount; seat += 1) await service.pass(roomCode, `p${seat}`);

  const mid = (await service.getSession<PdkSession>(roomCode))!;
  await service.playCards(roomCode, 'p0', mid.players[0]!.hand.slice(0, 3));
  for (let seat = 1; seat < playerCount; seat += 1) await service.pass(roomCode, `p${seat}`);

  const last = (await service.getSession<PdkSession>(roomCode))!;
  await service.playCards(roomCode, 'p0', [last.players[0]!.hand[0]!]);
}

describe('Task 4.3：pdk 结算与记录发布（GameService）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRedisDouble();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('3 人完整局：game.ended 带 pdk 向量 + 记录信封（playedCount/无底牌）', async () => {
    const service = pdkService();
    await seedPdkSession(service, 'PDK-SR1');
    await playToEnd(service, 'PDK-SR1', 3);

    const ended = eventsOf('PDK-SR1').filter((e) => e.event === 'game.ended');
    expect(ended).toHaveLength(1);
    const event = ended[0]!;
    expect(event.gameType).toBe('paodekuai');
    expect(event.playerCount).toBe(3);

    const result = event.result!;
    expect(isPdkSettlementResult(result)).toBe(true);
    expect(result.gameType).toBe('paodekuai');
    expect(result.winnerSeats).toEqual([0]);
    expect(result.remaining).toEqual([0, 16, 16]);
    expect(result.scoreChanges.reduce((sum, c) => sum + c.delta, 0)).toBe(0);

    const record = event.record! as {
      gameType: string;
      playerCount: number;
      seats: Array<{ seat: number; playerId: string; hand: string; playedCount: number }>;
      unusedCards?: string;
      bottomCards?: string;
    };
    expect(record.gameType).toBe('paodekuai');
    expect(record.playerCount).toBe(3);
    expect(record.seats.map((s) => s.seat)).toEqual([0, 1, 2]);
    expect(record.seats.every((s) => s.hand.length === 32)).toBe(true);
    expect(record.seats.map((s) => s.playedCount)).toEqual([16, 0, 0]);
    expect(record).not.toHaveProperty('bottomCards');
    expect(record).not.toHaveProperty('unusedCards');

    // N17：终局 state_updated 的 pdk 视图带 winnerSeats
    const endedView = eventsOf('PDK-SR1')
      .filter((e) => e.event === 'game.state_updated')
      .at(-1)!
      .seatViews!.find((v) => v.seat === 0)!;
    expect(endedView.state).toBe('ended');
    expect(endedView.winnerSeats).toEqual([0]);
  });

  it('2 人局：记录信封带 unusedCards（32 hex），playedCount 按实际出牌', async () => {
    const service = pdkService();
    await seedPdkSession(service, 'PDK-SR2', { playerCount: 2 });
    await playToEnd(service, 'PDK-SR2', 2);

    const event = eventsOf('PDK-SR2').filter((e) => e.event === 'game.ended')[0]!;
    expect(event.result!.playerCount).toBe(2);
    expect(event.result!.winnerSeats).toEqual([0]);

    const record = event.record! as {
      playerCount: number;
      unusedCards?: string;
      seats: Array<{ seat: number; hand: string; playedCount: number }>;
    };
    expect(record.playerCount).toBe(2);
    expect(record.unusedCards).toHaveLength(32);
    expect(record.seats.map((s) => [s.seat, s.playedCount])).toEqual([
      [0, 16],
      [1, 0],
    ]);
    expect(record.seats.every((s) => s.hand.length === 32)).toBe(true);
  });
});

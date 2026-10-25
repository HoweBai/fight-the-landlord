/**
 * Task 2.5 / spec §4.5.2 §4.9.2：按玩法结算。
 *
 * - pdk 用 `scoreChanges` 向量（2/3/4 人）；`resolveSeats`/`coversAllSeats` 按 playerCount；
 * - `game.balances` / `record.moneyDelta` 对 pdk 带 gameType/playerCount（2/4 人不得缺省成 3 座）；
 * - 斗地主 9 键旧路径**零变化**（不新增字段、广播/回写形状逐字不变）。
 */
import { describe, expect, it } from 'vitest';
import type { PdkSettlementResult } from '@fight-the-landlord/protocol';
import type { Room } from '../../src/rooms/rooms.service';
import { computeSettlement } from '../../src/currency/settle.service';
import { applyOk, makeHarness, resultFixture, validInput } from './helpers';
import { exactSeriesValue } from '../helpers/metric-readout';
import {
  currencySettleResultTotal, currencySettleResidueTotal, recordWriteFailuresTotal,
} from '../../src/metrics/room.metrics';

const pdkResult = (
  playerCount: 2 | 3 | 4,
  scoreChanges: number[],
  over: Partial<PdkSettlementResult> = {},
): PdkSettlementResult => ({
  roomCode: 'ROOM01',
  gameType: 'paodekuai',
  playerCount,
  baseScore: 15,
  winnerSeats: [0],
  scoreChanges: scoreChanges.map((delta, seat) => ({ seat, delta })),
  remaining: scoreChanges.map((_, seat) => (seat === 0 ? 0 : 5)),
  multiplier: 1,
  bombCount: 0,
  guan: false,
  spring: false,
  baobenSeats: [],
  ...over,
});

const pdkRoom = (playerCount: 2 | 3 | 4): Room => ({
  code: 'ROOM01',
  mode: 'gold',
  gameType: 'paodekuai',
  baseScore: 15,
  maxPlayers: playerCount,
  status: 'playing',
  createdAt: 0,
  timeoutAt: 0,
  players: Array.from({ length: playerCount }, (_, seat) => ({
    seat,
    userId: `u${seat}`,
    isRobot: false,
  })),
});

describe('pdk 结算：2/3/4 人向量（Task 2.5）', () => {
  for (const [playerCount, changes] of [
    [3, [30, -15, -15]],
    [2, [15, -15]],
    [4, [30, -10, -10, -10]],
  ] as const) {
    it(`${playerCount} 人：apply + ${playerCount} 座广播 + moneyDelta 带 gameType/playerCount`, async () => {
      const h = makeHarness();
      const result = pdkResult(playerCount, [...changes]);
      const owners = result.scoreChanges.map((_, seat) => `u${seat}`);
      h.currency.get.mockResolvedValue({
        balances: owners.map((ownerId) => ({ ownerId, balance: 1000, exists: true })),
      });
      h.currency.apply.mockImplementation(async (req: { actionId: string; entries: Array<{ ownerId: string; delta: number }> }) =>
        applyOk(req.actionId, req.entries, Object.fromEntries(owners.map((o) => [o, 1000]))),
      );

      await h.svc.settle({
        roomCode: 'ROOM01',
        version: 7,
        result,
        room: pdkRoom(playerCount),
        botBySeat: new Map(),
      });

      expect(h.currency.apply).toHaveBeenCalledTimes(1);
      expect(h.broadcasts).toHaveLength(1);
      expect(h.broadcasts[0]).toMatchObject({ gameType: 'paodekuai', playerCount });
      expect(h.broadcasts[0]!.balances).toHaveLength(playerCount);
      expect(h.record.moneyDelta).toHaveBeenCalledWith(
        expect.objectContaining({
          roomCode: 'ROOM01',
          gameVersion: 7,
          gameType: 'paodekuai',
          playerCount,
          deltas: result.scoreChanges,
        }),
      );
    });
  }

  it('全保本（全零向量）⇒ 不调 apply，但广播 + moneyDelta(全 0) 照走', async () => {
    const h = makeHarness();
    const result = pdkResult(2, [0, 0]);
    h.currency.get.mockResolvedValue({
      balances: ['u0', 'u1'].map((ownerId) => ({ ownerId, balance: 1000, exists: true })),
    });

    await h.svc.settle({
      roomCode: 'ROOM01',
      version: 7,
      result,
      room: pdkRoom(2),
      botBySeat: new Map(),
    });

    expect(h.currency.apply).not.toHaveBeenCalled();
    expect(h.broadcasts[0]).toMatchObject({ gameType: 'paodekuai', playerCount: 2 });
    expect(h.record.moneyDelta).toHaveBeenCalledWith(
      expect.objectContaining({ playerCount: 2, deltas: [{ seat: 0, delta: 0 }, { seat: 1, delta: 0 }] }),
    );
  });

  it('座位/人数不符（pdk 2 人结果、房间 3 座）⇒ dropped，不结算', async () => {
    const h = makeHarness();
    const result = pdkResult(2, [15, -15]);

    await h.svc.settle({
      roomCode: 'ROOM01',
      version: 7,
      result,
      room: pdkRoom(3),
      botBySeat: new Map(),
    });

    expect(h.currency.apply).not.toHaveBeenCalled();
    expect(h.broadcasts).toHaveLength(0);
  });

  it('computeSettlement 吃 scoreChanges：pdk 向量原样成为 deltas/entries', () => {
    const result = pdkResult(4, [30, -10, -10, -10]);
    const seats = result.scoreChanges.map((_, seat) => ({
      seat,
      ownerId: `u${seat}`,
      ownerType: 'user' as const,
    }));
    const balances = new Map(seats.map((s) => [s.ownerId, 1000]));

    const computed = computeSettlement({
      roomCode: 'ROOM01',
      version: 7,
      round: 1,
      result,
      seats,
      balances,
      rakePercent: 0,
    });

    expect(computed.deltas).toEqual(result.scoreChanges);
    expect(computed.entries).toEqual(
      result.scoreChanges.map((c) => ({ ownerId: `u${c.seat}`, ownerType: 'user', delta: c.delta })),
    );
    expect(computed.residue).toBe(0);
  });

  it('斗地主旧路径：广播/moneyDelta 不带 gameType/playerCount（9 键零变化）', async () => {
    const h = makeHarness();
    h.currency.get.mockResolvedValue({
      balances: ['alice', 'bot-int-1', 'carol'].map((ownerId) => ({ ownerId, balance: 1000, exists: true })),
    });
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: Array<{ ownerId: string; delta: number }> }) =>
      applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }),
    );

    await h.svc.settle(validInput());

    expect(resultFixture().winner).toBe('landlord'); // 反空测：夹具真的是 ddz 9 键结果
    expect(h.broadcasts[0]).not.toHaveProperty('gameType');
    expect(h.broadcasts[0]).not.toHaveProperty('playerCount');
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

  it('A1：PDK 结算 ok 与残差按 game_type 计数', async () => {
    const h = makeHarness();
    const input = validInput({ room: pdkRoom(3), result: pdkResult(3, [30, -15, -15]) });
    h.currency.get.mockResolvedValue({
      balances: ['u0', 'u1', 'u2'].map((ownerId) => ({ ownerId, balance: 1000, exists: true })),
    });
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: Array<{ ownerId: string; delta: number }> }) =>
      applyOk(req.actionId, req.entries, { u0: 1000, u1: 1000, u2: 1000 }),
    );
    const okBefore = (await exactSeriesValue(currencySettleResultTotal, {
      result: 'ok', game_type: 'paodekuai',
    })) ?? 0;
    const residueBefore = (await exactSeriesValue(currencySettleResidueTotal, {
      game_type: 'paodekuai',
    })) ?? 0;

    await h.svc.settle(input);

    expect(await exactSeriesValue(currencySettleResultTotal, {
      result: 'ok', game_type: 'paodekuai',
    })).toBe(okBefore + 1);
    const residueAfter = (await exactSeriesValue(currencySettleResidueTotal, {
      game_type: 'paodekuai',
    })) ?? 0;
    expect(residueAfter - residueBefore).toBe(0);
  });

  it('A1：moneyDelta 失败/部分计 kind=money_delta', async () => {
    const h = makeHarness();
    const input = validInput({ room: pdkRoom(3), result: pdkResult(3, [30, -15, -15]) });
    h.currency.get.mockResolvedValue({
      balances: ['u0', 'u1', 'u2'].map((ownerId) => ({ ownerId, balance: 1000, exists: true })),
    });
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: Array<{ ownerId: string; delta: number }> }) =>
      applyOk(req.actionId, req.entries, { u0: 1000, u1: 1000, u2: 1000 }),
    );
    h.record.moneyDelta.mockRejectedValueOnce(new Error('down'));
    const before = (await exactSeriesValue(recordWriteFailuresTotal, {
      game_type: 'paodekuai', kind: 'money_delta',
    })) ?? 0;

    await h.svc.settle(input);

    expect(await exactSeriesValue(recordWriteFailuresTotal, {
      game_type: 'paodekuai', kind: 'money_delta',
    })).toBe(before + 1);
  });
});

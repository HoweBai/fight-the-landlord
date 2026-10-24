/**
 * Task 2.5 / spec N2/H6：两个 outbox 条目都带 gameType/playerCount，重发按条目回写；
 * 旧条目缺字段 ⇒ 斗地主/3（形状与旧版逐字一致）。
 */
import { describe, expect, it } from 'vitest';
import type { SettleOutboxEntry, RecordMoneyOutboxEntry } from '../../src/currency/settle.service';
import { applyOk, makeHarness } from './helpers';

const NOW = 1_700_000_000_000;

describe('settle:outbox 的玩法/人数（Task 2.5）', () => {
  it('pdk 2 人条目：重发广播带 gameType/playerCount、moneyDelta 同样带（不得缺省 3 座）', async () => {
    const h = makeHarness();
    const seats = [
      { seat: 0, ownerId: 'u0', ownerType: 'user' as const },
      { seat: 1, ownerId: 'u1', ownerType: 'user' as const },
    ];
    const entries = [
      { ownerId: 'u0', ownerType: 'user' as const, delta: 15 },
      { ownerId: 'u1', ownerType: 'user' as const, delta: -15 },
    ];
    const entry: SettleOutboxEntry = {
      actionId: 'settle:ROOM01:7',
      entries,
      roomCode: 'ROOM01',
      gameVersion: 7,
      round: 1,
      residue: 0,
      rakeTotal: 0,
      seats,
      createdAt: NOW,
      gameType: 'paodekuai',
      playerCount: 2,
    };
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: typeof entries }) =>
      applyOk(req.actionId, req.entries, { u0: 1015, u1: 985 }),
    );

    await h.svc.resendSettleOutboxEntry('ROOM01:7', entry, NOW);

    expect(h.broadcasts).toEqual([
      {
        roomCode: 'ROOM01',
        version: 7,
        balances: [
          { seat: 0, balance: 1015 },
          { seat: 1, balance: 985 },
        ],
        gameType: 'paodekuai',
        playerCount: 2,
      },
    ]);
    expect(h.record.moneyDelta).toHaveBeenCalledWith({
      roomCode: 'ROOM01',
      gameVersion: 7,
      gameType: 'paodekuai',
      playerCount: 2,
      deltas: [
        { seat: 0, delta: 15 },
        { seat: 1, delta: -15 },
      ],
    });
  });

  it('旧条目（无 gameType/playerCount）⇒ 斗地主/3，形状逐字不变', async () => {
    const h = makeHarness();
    const seats = [
      { seat: 0, ownerId: 'alice', ownerType: 'user' as const },
      { seat: 1, ownerId: 'bot-int-1', ownerType: 'robot' as const },
      { seat: 2, ownerId: 'carol', ownerType: 'user' as const },
    ];
    const entries = [
      { ownerId: 'alice', ownerType: 'user' as const, delta: 30 },
      { ownerId: 'bot-int-1', ownerType: 'robot' as const, delta: -15 },
      { ownerId: 'carol', ownerType: 'user' as const, delta: -15 },
    ];
    const entry: SettleOutboxEntry = {
      actionId: 'settle:ROOM01:7',
      entries,
      roomCode: 'ROOM01',
      gameVersion: 7,
      round: 1,
      residue: 0,
      rakeTotal: 0,
      seats,
      createdAt: NOW,
    };
    h.currency.apply.mockImplementation(async (req: { actionId: string; entries: typeof entries }) =>
      applyOk(req.actionId, req.entries, { alice: 1030, 'bot-int-1': 985, carol: 985 }),
    );
    h.record.moneyDelta.mockResolvedValue({ matched: [0, 1, 2] });

    await h.svc.resendSettleOutboxEntry('ROOM01:7', entry, NOW);

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
});

describe('recordmoney:outbox 的玩法/人数（Task 2.5）', () => {
  it('pdk 4 人条目：请求带 gameType/playerCount；matched 齐 4 座才清除', async () => {
    const h = makeHarness();
    const entry: RecordMoneyOutboxEntry = {
      roomCode: 'ROOM01',
      gameVersion: 7,
      gameType: 'paodekuai',
      playerCount: 4,
      deltas: [
        { seat: 0, delta: 30 },
        { seat: 1, delta: -10 },
        { seat: 2, delta: -10 },
        { seat: 3, delta: -10 },
      ],
      createdAt: NOW,
    };
    h.record.moneyDelta.mockResolvedValueOnce({ matched: [0, 1, 2] }); // 缺 3 ⇒ 留箱
    await h.redis.hset('recordmoney:outbox', 'ROOM01:7', JSON.stringify(entry));

    await h.svc.resendRecordMoneyOutboxEntry('ROOM01:7', entry, NOW);
    expect(h.redis.hashes.get('recordmoney:outbox')?.['ROOM01:7']).toBeDefined();
    expect(h.record.moneyDelta).toHaveBeenLastCalledWith(
      expect.objectContaining({ gameType: 'paodekuai', playerCount: 4 }),
    );

    h.record.moneyDelta.mockResolvedValueOnce({ matched: [0, 1, 2, 3] });
    await h.svc.resendRecordMoneyOutboxEntry('ROOM01:7', entry, NOW);
    expect(h.redis.hashes.get('recordmoney:outbox')?.['ROOM01:7']).toBeUndefined();
  });

  it('旧条目缺字段 ⇒ doudizhu/3；请求形状与旧版逐字一致', async () => {
    const h = makeHarness();
    const entry: RecordMoneyOutboxEntry = {
      roomCode: 'ROOM01',
      gameVersion: 7,
      deltas: [
        { seat: 0, delta: 30 },
        { seat: 1, delta: -15 },
        { seat: 2, delta: -15 },
      ],
      createdAt: NOW,
    };
    h.record.moneyDelta.mockResolvedValueOnce({ matched: [0, 1, 2] });

    await h.svc.resendRecordMoneyOutboxEntry('ROOM01:7', entry, NOW);

    expect(h.record.moneyDelta).toHaveBeenCalledWith({
      roomCode: 'ROOM01',
      gameVersion: 7,
      deltas: entry.deltas,
    });
  });
});

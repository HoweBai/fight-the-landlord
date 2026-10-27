/**
 * 麻将资金结算（spec §4.6）：**逐事件截断**。
 *
 * 判据：每个 payer 只按**当时余额**付这一笔；付不起 ⇒ 该笔收款人少收，
 * 不把缺口摊给其他赢家；burn 只烧剩余余额；抽水只对正收益计。
 * 所有期望值手算（不重引入被测公式）。
 */
import { describe, expect, it } from 'vitest';
import type { MahjongScoreEvent, MahjongSettlementResult } from '@fight-the-landlord/protocol';
import { computeMahjongSettlement } from '../../src/currency/settle.service';

const SEATS = [
  { seat: 0, ownerId: 'alice', ownerType: 'user' as const },
  { seat: 1, ownerId: 'bob', ownerType: 'user' as const },
  { seat: 2, ownerId: 'carol', ownerType: 'user' as const },
  { seat: 3, ownerId: 'dave', ownerType: 'user' as const },
];

function result(over: Partial<MahjongSettlementResult> = {}): MahjongSettlementResult {
  return {
    roomCode: 'MJ01',
    gameType: 'mahjong',
    playerCount: 4,
    baseScore: 1,
    winnerSeats: [2],
    scoreChanges: [
      { seat: 0, delta: 0 },
      { seat: 1, delta: -2 },
      { seat: 2, delta: 7 },
      { seat: 3, delta: -5 },
    ],
    fanDetails: [],
    events: [
      {
        kind: 'gang',
        seq: 1,
        seat: 0,
        gang: 'melded',
        tile: { s: 0, r: 1 },
        payers: [
          { seat: 1, amount: 2 },
          { seat: 3, amount: 2 },
        ],
      },
      {
        kind: 'hu',
        seq: 2,
        seat: 2,
        fromSeat: 0,
        fan: 1,
        multiplier: 1,
        payers: [{ seat: 0, amount: 4 }],
        items: ['平胡'],
      },
      { kind: 'chajiao', seq: 3, fromSeat: 3, toSeat: 2, amount: 3, fan: 1 },
    ],
    burn: [{ seat: 3, amount: 48, reason: 'flowerPig' }],
    rakeTotal: 0,
    chajiao: [{ from: 3, to: 2, amount: 3 }],
    liuju: false,
    huazhuSeats: [3],
    endReason: 'wallEmpty',
    writtenOff: [],
    ...over,
  };
}

const bal = (entries: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(entries));

function run(
  over: Partial<MahjongSettlementResult> = {},
  balances: Record<string, number> = { alice: 1000, bob: 1000, carol: 1000, dave: 1000 },
  rakePercent = 0,
) {
  return computeMahjongSettlement({
    roomCode: 'MJ01',
    version: 7,
    round: 1,
    result: result(over),
    seats: SEATS,
    balances: bal(balances),
    rakePercent,
  });
}

describe('computeMahjongSettlement：逐事件截断', () => {
  it('余额充足：逐座净额与事件一致；burn 单独截断并计入 deltas', () => {
    const out = run();
    expect(out.actionId).toBe('settle:MJ01:7');
    expect(out.deltas).toEqual([
      { seat: 0, delta: 0 },
      { seat: 1, delta: -2 },
      { seat: 2, delta: 7 },
      { seat: 3, delta: -53 },
    ]);
    expect(out.burnPenalty).toBe(48);
    expect(out.rakeTotal).toBe(0);
    expect(out.residue).toBe(0);
    expect(out.entries).toEqual([
      { ownerId: 'bob', ownerType: 'user', delta: -2 },
      { ownerId: 'carol', ownerType: 'user', delta: 7 },
      { ownerId: 'dave', ownerType: 'user', delta: -53 },
    ]);
    expect(out.entries.reduce((a, e) => a + e.delta, 0) + out.rakeTotal + out.burnPenalty).toBe(0);
  });

  it('payer 余额不足：只影响这一笔的收款人（不转嫁）', () => {
    // bob 只有 1（杠应付 2）；alice 0（胡应付 4）；dave 4（杠 2 + 查叫 3 只剩 2）。
    const out = run({}, { alice: 0, bob: 1, carol: 100, dave: 4 });
    expect(out.deltas).toEqual([
      { seat: 0, delta: 0 },
      { seat: 1, delta: -1 },
      { seat: 2, delta: 5 },
      { seat: 3, delta: -4 },
    ]);
    // dave 事件后余额 0 ⇒ 48 的花猪 burn 一分也烧不到。
    expect(out.burnPenalty).toBe(0);
    expect(out.entries.reduce((a, e) => a + e.delta, 0)).toBe(0);
  });

  it('转移事件按 seq 顺序：先收到的杠分可以转给胡牌者', () => {
    const events: MahjongScoreEvent[] = [
      {
        kind: 'gang',
        seq: 1,
        seat: 0,
        gang: 'melded',
        tile: { s: 0, r: 1 },
        payers: [{ seat: 1, amount: 2 }],
      },
      { kind: 'transfer', seq: 2, ref: 1, fromSeat: 0, toSeat: 2, amount: 2, reason: 'gangShoot' },
    ];
    const out = run(
      {
        scoreChanges: [
          { seat: 0, delta: 0 },
          { seat: 1, delta: -2 },
          { seat: 2, delta: 2 },
          { seat: 3, delta: 0 },
        ],
        events,
        burn: [],
        chajiao: [],
        huazhuSeats: [],
        endReason: 'threeWinners',
      },
      { alice: 0, bob: 100, carol: 0, dave: 100 },
    );
    expect(out.deltas).toEqual([
      { seat: 0, delta: 0 },
      { seat: 1, delta: -2 },
      { seat: 2, delta: 2 },
      { seat: 3, delta: 0 },
    ]);
  });

  it('抽水只对正收益计（10%）：赢家少收，rake 进销毁桶', () => {
    const out = run({ burn: [], chajiao: [], huazhuSeats: [], endReason: 'threeWinners' }, undefined, 10);
    // 原净额：0 / -2 / +7 / -5；carol +7 ⇒ rake floor(0.7)=0（整数截断）。
    expect(out.rakeTotal).toBe(0);
    const out2 = run(
      {
        scoreChanges: [
          { seat: 0, delta: -10 },
          { seat: 1, delta: 0 },
          { seat: 2, delta: 10 },
          { seat: 3, delta: 0 },
        ],
        events: [
          {
            kind: 'hu',
            seq: 1,
            seat: 2,
            fromSeat: 0,
            fan: 1,
            multiplier: 1,
            payers: [{ seat: 0, amount: 10 }],
            items: ['平胡'],
          },
        ],
        burn: [],
        chajiao: [],
        huazhuSeats: [],
        endReason: 'threeWinners',
      },
      { alice: 100, bob: 100, carol: 0, dave: 100 },
      10,
    );
    expect(out2.deltas[2]).toEqual({ seat: 2, delta: 9 });
    expect(out2.rakeTotal).toBe(1);
    expect(out2.entries.reduce((a, e) => a + e.delta, 0) + out2.rakeTotal).toBe(0);
  });

  it('余额缺失按 0：赢家收不到钱、burn 为 0（不造负余额）', () => {
    const out = run({}, {});
    expect(out.deltas.every((d) => d.delta === 0)).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.burnPenalty).toBe(0);
  });

  it('事件账与 scoreChanges 不一致 ⇒ fail closed', () => {
    expect(() =>
      run({ scoreChanges: [{ seat: 0, delta: 999 }, { seat: 1, delta: 0 }, { seat: 2, delta: 0 }, { seat: 3, delta: 0 }] }),
    ).toThrow(/event\/score mismatch/);
  });

  it('scoreChanges 不覆盖 4 座 ⇒ fail closed（形状守卫）', () => {
    expect(() => run({ events: [], scoreChanges: [], burn: [], chajiao: [], huazhuSeats: [] })).toThrow(
      /scoreChanges length/,
    );
  });
});

/**
 * ② 金币场 T5（规格 §4 逐字）：**结算算法**的单测矩阵 —— 直接打纯函数
 * `computeSettlement`（不含守卫/分级/IO）。
 *
 * 矩阵（brief Step 1 逐条）：零和（rake0 无截断）/ 单输家截断 / 双赢家分摊 /
 * rake 10% / 全零（余额全 0）/ 余额 exists=false / 分差为 0 的座（向量含 0、无 entry）。
 *
 * 判据纪律：所有期望值**手算**（不重引入被测公式）—— 逐座 delta、residue、rakeTotal、
 * entries 非零过滤与座位序、actionId（含 `:r2`）。
 */
import { describe, expect, it } from 'vitest';
import type { DdzSettlementResult, PdkSettlementResult } from '@fight-the-landlord/protocol';
import { computeSettlement, type SettleSeatRef } from '../../src/currency/settle.service';

const SEATS: SettleSeatRef[] = [
  { seat: 0, ownerId: 'alice', ownerType: 'user' },
  { seat: 1, ownerId: 'bot-aaaa1111', ownerType: 'robot' },
  { seat: 2, ownerId: 'carol', ownerType: 'user' },
];

/** 地主坐 0 赢（±2u）：30 / −15 / −15。 */
const LANDLORD_WINS = (over: Partial<DdzSettlementResult> = {}): DdzSettlementResult => ({
  roomCode: 'ROOM01',
  baseScore: 15,
  winner: 'landlord',
  landlordSeat: 0,
  farmerSeats: [1, 2],
  multiplier: 2,
  spring: 'none',
  landlordScoreChange: 30,
  farmerScoreChange: -15,
  ...over,
});

/** 农民赢：−60 / +30 / +30。 */
const FARMERS_WIN = (over: Partial<DdzSettlementResult> = {}): DdzSettlementResult =>
  LANDLORD_WINS({
    winner: 'farmer',
    landlordScoreChange: -60,
    farmerScoreChange: 30,
    ...over,
  });

const balances = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries));

describe('computeSettlement：零和（rake=0、无截断）', () => {
  it('地主赢：逐座 ±，vectors 含全部三座，entries 恰为非零三条，residue/rake=0，Σentries=0', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 7,
      round: 1,
      result: LANDLORD_WINS(),
      seats: SEATS,
      balances: balances({ alice: 1000, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 0,
    });

    expect(out.actionId).toBe('settle:ROOM01:7');
    expect(out.deltas).toEqual([
      { seat: 0, delta: 30 },
      { seat: 1, delta: -15 },
      { seat: 2, delta: -15 },
    ]);
    expect(out.entries).toEqual([
      { ownerId: 'alice', ownerType: 'user', delta: 30 },
      { ownerId: 'bot-aaaa1111', ownerType: 'robot', delta: -15 },
      { ownerId: 'carol', ownerType: 'user', delta: -15 },
    ]);
    expect(out.residue).toBe(0);
    expect(out.rakeTotal).toBe(0);
    // 零和自明（规格 §4 末行）：无截断、rake=0 ⇒ Σentries 恒 0
    expect(out.entries.reduce((acc, e) => acc + e.delta, 0)).toBe(0);
  });

  it('round=2 ⇒ actionId 带 `:r2` 后缀（重算轮的唯一形态）', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 7,
      round: 2,
      result: LANDLORD_WINS(),
      seats: SEATS,
      balances: balances({ alice: 1000, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 0,
    });
    expect(out.actionId).toBe('settle:ROOM01:7:r2');
  });
});

describe('computeSettlement：单输家截断 + 双赢家分摊（最大余数法）', () => {
  it('地主输、余额 25 < 应付 60 ⇒ 两赢家 13/12（零头给座位小者）；residue 0', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 9,
      round: 1,
      result: FARMERS_WIN(),
      seats: SEATS,
      balances: balances({ alice: 25, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 0,
    });

    // 截断：alice 只付 25；g=floor(30×25/60)=12、frac 各 30 ⇒ R=1 给座位小者 seat1
    expect(out.deltas).toEqual([
      { seat: 0, delta: -25 },
      { seat: 1, delta: 13 },
      { seat: 2, delta: 12 },
    ]);
    expect(out.residue).toBe(0);
    expect(out.rakeTotal).toBe(0);
    expect(out.entries.reduce((acc, e) => acc + e.delta, 0)).toBe(0);
  });

  it('三座余额都充足 ⇒ 无截断、无残差（双赢家各 30）', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 9,
      round: 1,
      result: FARMERS_WIN(),
      seats: SEATS,
      balances: balances({ alice: 1000, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: -60 },
      { seat: 1, delta: 30 },
      { seat: 2, delta: 30 },
    ]);
    expect(out.residue).toBe(0);
  });
});

describe('computeSettlement：抽水（rakePercent=10，floor 口径）', () => {
  it('地主赢 30 ⇒ g=30、rake=floor(3)=3、实收 27；Σentries = −(0+3)', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 11,
      round: 1,
      result: LANDLORD_WINS(),
      seats: SEATS,
      balances: balances({ alice: 1000, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 10,
    });

    expect(out.deltas).toEqual([
      { seat: 0, delta: 27 },
      { seat: 1, delta: -15 },
      { seat: 2, delta: -15 },
    ]);
    expect(out.rakeTotal).toBe(3); // floor(30 × 10 / 100)
    expect(out.residue).toBe(0);
    expect(out.entries.reduce((acc, e) => acc + e.delta, 0)).toBe(-3);
  });

  it('逐赢家 floor（不是先求和再抽）：两赢家各 g=15 ⇒ 各 rake=floor(1.5)=1、各实收 14', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 11,
      round: 1,
      // 守恒的合成局（Σraw=0）：地主 −30、两农民各 +15 ⇒ P=30、g 各 floor(15×30/30)=15
      result: FARMERS_WIN({ landlordScoreChange: -30, farmerScoreChange: 15 }),
      seats: SEATS,
      balances: balances({ alice: 1000, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 10,
    });

    expect(out.deltas).toEqual([
      { seat: 0, delta: -30 },
      { seat: 1, delta: 14 },
      { seat: 2, delta: 14 },
    ]);
    // 逐家 floor ⇒ rakeTotal=2（先求和再 floor 会得 floor(30×10/100)=3 ⇒ 本判据能抓住）
    expect(out.rakeTotal).toBe(2);
  });
});

describe('computeSettlement：全零 / 余额缺失（exists=false 按 0）', () => {
  it('全零（三座余额全 0）⇒ P=0 ⇒ 赢家 g=0 ⇒ entries 空、deltas 全 0（不调 apply 的判据）', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 13,
      round: 1,
      result: FARMERS_WIN(),
      seats: SEATS,
      balances: balances({ alice: 0, 'bot-aaaa1111': 0, carol: 0 }),
      rakePercent: 0,
    });

    expect(out.entries).toEqual([]);
    expect(out.deltas).toEqual([
      { seat: 0, delta: 0 },
      { seat: 1, delta: 0 },
      { seat: 2, delta: 0 },
    ]);
    expect(out.residue).toBe(0);
  });

  it('余额缺失（Map 无该 ownerId = exists=false）按 0：该座付 0、不产生 entry，向量仍含 0', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 13,
      round: 1,
      result: LANDLORD_WINS(),
      seats: SEATS,
      balances: balances({ alice: 1000, 'bot-aaaa1111': 15 }), // carol 缺失 ⇒ 0
      rakePercent: 0,
    });

    // carol 应付 15、余额（缺失⇒0）⇒ 付 0；P=15；g=floor(30×15/30)=15
    expect(out.entries).toEqual([
      { ownerId: 'alice', ownerType: 'user', delta: 15 },
      { ownerId: 'bot-aaaa1111', ownerType: 'robot', delta: -15 },
    ]);
    expect(out.deltas[1]).toEqual({ seat: 1, delta: -15 });
    expect(out.deltas[2]).toEqual({ seat: 2, delta: 0 }); // 零 delta 座在向量中仍出现
    expect(out.residue).toBe(0);
  });

  it('分差为 0 的座（理论不发生）：不产生 entry，但 deltas 向量含 0（规格 §4 末行）', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 13,
      round: 1,
      result: LANDLORD_WINS({ farmerScoreChange: 0 } as never), // 合成：农民分差 0 ⇒ 双方无人动账
      seats: SEATS,
      balances: balances({ alice: 1000, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 0,
    });

    expect(out.entries).toEqual([]);
    expect(out.deltas).toEqual([
      { seat: 0, delta: 0 },
      { seat: 1, delta: 0 },
      { seat: 2, delta: 0 },
    ]);
  });
});

describe('B 组：PDK 2/4 人输光截断（2026-10-26）', () => {
  const pdk2Seats: SettleSeatRef[] = [
    { seat: 0, ownerId: 'alice', ownerType: 'user' },
    { seat: 1, ownerId: 'bob', ownerType: 'user' },
  ];
  const pdk4Seats: SettleSeatRef[] = [
    { seat: 0, ownerId: 'alice', ownerType: 'user' },
    { seat: 1, ownerId: 'bob', ownerType: 'user' },
    { seat: 2, ownerId: 'carol', ownerType: 'user' },
    { seat: 3, ownerId: 'dave', ownerType: 'user' },
  ];
  const pdk2 = (over: Partial<PdkSettlementResult> = {}): PdkSettlementResult => ({
    roomCode: 'ROOM01',
    gameType: 'paodekuai',
    playerCount: 2,
    baseScore: 15,
    winnerSeats: [0],
    scoreChanges: [
      { seat: 0, delta: 960 },
      { seat: 1, delta: -960 },
    ],
    remaining: [0, 16],
    multiplier: 64,
    bombCount: 0,
    guan: false,
    spring: false,
    baobenSeats: [],
    ...over,
  });
  const pdk4 = (over: Partial<PdkSettlementResult> = {}): PdkSettlementResult => ({
    roomCode: 'ROOM01',
    gameType: 'paodekuai',
    playerCount: 4,
    baseScore: 15,
    winnerSeats: [0],
    scoreChanges: [
      { seat: 0, delta: 30 },
      { seat: 1, delta: -10 },
      { seat: 2, delta: -10 },
      { seat: 3, delta: -10 },
    ],
    remaining: [0, 4, 4, 4],
    multiplier: 1,
    bombCount: 0,
    guan: false,
    spring: false,
    baobenSeats: [],
    ...over,
  });

  it('2 人：输家余额 1 < 应付 960 ⇒ 实付 1、赢家池 1、零残差/抽水、无负余额', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 1,
      round: 1,
      result: pdk2(),
      seats: pdk2Seats,
      balances: balances({ alice: 1000, bob: 1 }),
      rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: 1 },
      { seat: 1, delta: -1 },
    ]);
    expect(out.entries).toEqual([
      { ownerId: 'alice', ownerType: 'user', delta: 1 },
      { ownerId: 'bob', ownerType: 'user', delta: -1 },
    ]);
    expect(out.residue).toBe(0);
    expect(out.rakeTotal).toBe(0);
  });

  it('4 人：一个输家余额 1、其余 1000 ⇒ 实付 1/10/10、赢家池 21、零残差、无负余额', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 1,
      round: 1,
      result: pdk4(),
      seats: pdk4Seats,
      balances: balances({ alice: 1000, bob: 1, carol: 1000, dave: 1000 }),
      rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: 21 },
      { seat: 1, delta: -1 },
      { seat: 2, delta: -10 },
      { seat: 3, delta: -10 },
    ]);
    expect(out.residue).toBe(0);
    expect(out.rakeTotal).toBe(0);
  });

  it('4 人 + rake 10%：按实际池 21 抽水 2、赢家实收 19、残差 0', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 1,
      round: 1,
      result: pdk4(),
      seats: pdk4Seats,
      balances: balances({ alice: 1000, bob: 1, carol: 1000, dave: 1000 }),
      rakePercent: 10,
    });
    expect(out.rakeTotal).toBe(2);
    expect(out.residue).toBe(0);
    expect(out.deltas[0]).toEqual({ seat: 0, delta: 19 });
    expect(out.deltas.reduce((sum, d) => sum + d.delta, 0)).toBe(-2); // 赢家 19 - 输家 21
  });
});

describe('computeSettlement：最大余数法（2026-10-26 spec C3–C11）', () => {
  const seatsOf = (n: 2 | 3 | 4): SettleSeatRef[] =>
    Array.from({ length: n }, (_, seat) => ({ seat, ownerId: `u${seat}`, ownerType: 'user' as const }));

  const pdkResult = (deltas: number[], playerCount: 2 | 3 | 4): PdkSettlementResult => ({
    roomCode: 'ROOM01',
    gameType: 'paodekuai',
    playerCount,
    baseScore: 1,
    winnerSeats: deltas.flatMap((delta, seat) => (delta > 0 ? [seat] : [])),
    scoreChanges: deltas.map((delta, seat) => ({ seat, delta })),
    remaining: deltas.map(() => 0),
    multiplier: 1,
    bombCount: 0,
    guan: false,
    spring: false,
    baobenSeats: [],
  });

  it('C3 两赢家截断：raw 8/8、P=15 ⇒ 8/7', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 10,
      round: 1,
      result: pdkResult([8, 8, -16], 3),
      seats: seatsOf(3),
      balances: balances({ u0: 1000, u1: 1000, u2: 15 }),
      rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: 8 },
      { seat: 1, delta: 7 },
      { seat: 2, delta: -15 },
    ]);
    expect(out.residue).toBe(0);
  });

  it('C4 余数不等：raw 5/11、P=15 ⇒ +1 给余数大的 raw 5 ⇒ 5/10', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 11,
      round: 1,
      result: pdkResult([5, 11, -16], 3),
      seats: seatsOf(3),
      balances: balances({ u0: 1000, u1: 1000, u2: 15 }),
      rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: 5 },
      { seat: 1, delta: 10 },
      { seat: 2, delta: -15 },
    ]);
    expect(out.residue).toBe(0);
  });

  it('C4b 最大余数在较大座位：raw 11@seat0、5@seat1、P=15 ⇒ 10/5（座位序实现会得 11/4）', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 11,
      round: 1,
      result: pdkResult([11, 5, -16], 3),
      seats: seatsOf(3),
      balances: balances({ u0: 1000, u1: 1000, u2: 15 }),
      rakePercent: 0,
    });
    // g: 10（frac 5）/4（frac 11）⇒ R=1 给 seat1
    expect(out.deltas).toEqual([
      { seat: 0, delta: 10 },
      { seat: 1, delta: 5 },
      { seat: 2, delta: -15 },
    ]);
    expect(out.residue).toBe(0);
  });


  it('C5 R=2：raw 2/2/2、输家 −6 余额 5 ⇒ 2/2/1、输家 −5', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 12,
      round: 1,
      result: pdkResult([2, 2, 2, -6], 4),
      seats: seatsOf(4),
      balances: balances({ u0: 1000, u1: 1000, u2: 1000, u3: 5 }),
      rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: 2 },
      { seat: 1, delta: 2 },
      { seat: 2, delta: 1 },
      { seat: 3, delta: -5 },
    ]);
    expect(out.residue).toBe(0);
  });

  it('C6 多赢家 + 抽水：C1 场景 rake 10% ⇒ gain 13/12、rake 1/1、delta 12/11', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 12,
      round: 1,
      result: FARMERS_WIN(),
      seats: SEATS,
      balances: balances({ alice: 25, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 10,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: -25 },
      { seat: 1, delta: 12 },
      { seat: 2, delta: 11 },
    ]);
    expect(out.rakeTotal).toBe(2);
    expect(out.residue).toBe(0);
    expect(out.entries.reduce((acc, e) => acc + e.delta, 0)).toBe(-2);
  });

  it('C6b 零头先分发后抽水：raw 10/10、P=19、rake 10% ⇒ 9/9', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 13,
      round: 1,
      result: FARMERS_WIN({ landlordScoreChange: -20, farmerScoreChange: 10 }),
      seats: SEATS,
      balances: balances({ alice: 19, 'bot-aaaa1111': 1000, carol: 1000 }),
      rakePercent: 10,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: -19 },
      { seat: 1, delta: 9 },
      { seat: 2, delta: 9 },
    ]);
    expect(out.rakeTotal).toBe(1);
    expect(out.residue).toBe(0);
    // 判别力：residue/rakeTotal 抓当前实现（无 LRM ⇒ residue 1 / rake 0）；
    // deltas 抓「LRM + 旧抽水基数」（会得 −19/10/9）
  });

  it('C8 精度回归（合成算例）：大数整除不得少 1、残差不得虚增', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 14,
      round: 1,
      result: FARMERS_WIN({ landlordScoreChange: -433_049_076, farmerScoreChange: 216_524_538 }),
      seats: SEATS,
      balances: balances({ alice: 1_000_000_000, 'bot-aaaa1111': 1_000_000_000, carol: 1_000_000_000 }),
      rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: -433_049_076 },
      { seat: 1, delta: 216_524_538 },
      { seat: 2, delta: 216_524_538 },
    ]);
    expect(out.residue).toBe(0);
  });
  // 覆盖限制：C8 只钉「旧 double 截断实现」；「LRM + double」在协议可达输入下不可观测
  //（P≤S、DDZ 双农民等 raw / PDK 单赢家），BigInt 属硬化项（spec §1.3），不另补非守恒向量。

  it('M-1 输入断言：余额非整数 ⇒ 抛错（settle 顶层记 dropped、钱不动）', () => {
    expect(() =>
      computeSettlement({
        roomCode: 'ROOM01',
        version: 16,
        round: 1,
        result: FARMERS_WIN(),
        seats: SEATS,
        balances: balances({ alice: 10.5, 'bot-aaaa1111': 1000, carol: 1000 }),
        rakePercent: 0,
      }),
    ).toThrow(/allocation input invalid/);
  });

  it('C11 防御：无赢家（三方全负）⇒ residue=P、不抛错', () => {
    const out = computeSettlement({
      roomCode: 'ROOM01',
      version: 15,
      round: 1,
      result: LANDLORD_WINS({ landlordScoreChange: -10, farmerScoreChange: -5 }),
      seats: SEATS,
      balances: balances({ alice: 100, 'bot-aaaa1111': 100, carol: 100 }),
      rakePercent: 0,
    });
    expect(out.deltas).toEqual([
      { seat: 0, delta: -10 },
      { seat: 1, delta: -5 },
      { seat: 2, delta: -5 },
    ]);
    expect(out.residue).toBe(20);
    expect(out.entries.reduce((acc, e) => acc + e.delta, 0)).toBe(-(out.residue + out.rakeTotal));
  });
});

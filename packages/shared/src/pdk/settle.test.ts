/**
 * Task 3.4 / spec §5.6：跑得快结算。
 *
 * 公式：`倍数 = min(cap, 2^炸弹数 × 关牌?2:1 × 春天?2:1)`；
 * 输家付 `剩余张数 × 底分 × 倍数`，赢家所得为输家之和（零和）；
 * 保本（剩 1 张的输家）付 0；2 人局春天不适用。
 */
import { describe, expect, it } from 'vitest';
import type { Card, PdkRulesConfig } from '@fight-the-landlord/protocol';
import { PdkHandType } from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES } from './rules';
import type { PdkSession } from './types';
import { settlePdk } from './settle';

const rules = (over: Partial<PdkRulesConfig> = {}): PdkRulesConfig => ({
  ...DEFAULT_PDK_RULES,
  ...over,
});

const filler = (n: number): Card[] =>
  Array.from({ length: n }, (_, i) => ({ r: 3 + (i % 12), s: i % 4 }));

function finished(over: {
  playerCount?: 2 | 3 | 4;
  remaining?: number[];
  played?: number[];
  bombCount?: number;
  winnerSeat?: number;
  rules?: PdkRulesConfig;
  baseScore?: number;
  winnerSeats?: number[];
} = {}): PdkSession {
  const playerCount = over.playerCount ?? 3;
  const winnerSeat = over.winnerSeat ?? 0;
  const remaining = over.remaining ?? Array.from({ length: playerCount }, (_, s) => (s === winnerSeat ? 0 : 2));
  const played = over.played ?? Array.from({ length: playerCount }, () => 5);
  return {
    roomCode: 'PDK001',
    gameType: 'paodekuai',
    playerCount,
    baseScore: over.baseScore ?? 15,
    state: 'ended',
    players: Array.from({ length: playerCount }, (_, seat) => ({
      id: `p${seat}`,
      seat,
      hand: filler(remaining[seat]!),
      isBot: false,
      isOffline: false,
      timeoutCount: 0,
      trustee: false,
      playedCount: played[seat]!,
    })),
    currentPlayer: winnerSeat,
    turnDeadlineAt: 0,
    version: 5,
    actionLog: [],
    createdAt: 0,
    finishedAt: 1,
    rules: over.rules ?? rules(),
    lastPlayedHand: { type: PdkHandType.Single, keyRank: 3, length: 0 },
    lastPlayerIdx: winnerSeat,
    consecutivePasses: 0,
    bombCount: over.bombCount ?? 0,
    winnerSeats: over.winnerSeats ?? [winnerSeat],
  };
}

const deltas = (result: ReturnType<typeof settlePdk>): number[] =>
  result.scoreChanges.map((c) => c.delta);

describe('settlePdk：基础公式与零和', () => {
  it('3 人默认：输家按剩余张数 × 底分，赢家所得 = 输家之和（零和）', () => {
    const result = settlePdk(
      finished({ remaining: [0, 2, 3], played: [5, 4, 3] }),
    );

    expect(result).toMatchObject({
      roomCode: 'PDK001',
      gameType: 'paodekuai',
      playerCount: 3,
      baseScore: 15,
      winnerSeats: [0],
      remaining: [0, 2, 3],
      multiplier: 1,
      bombCount: 0,
      guan: false,
      spring: false,
      baobenSeats: [],
    });
    expect(deltas(result)).toEqual([75, -30, -45]);
    expect(deltas(result).reduce((a, b) => a + b, 0)).toBe(0);
    expect(result.scoreChanges.map((c) => c.seat)).toEqual([0, 1, 2]);
  });

  it('2 人：一名输家，赢家所得 = 其支付；零和', () => {
    const result = settlePdk(finished({ playerCount: 2, remaining: [0, 4], played: [5, 4] }));
    expect(result.playerCount).toBe(2);
    expect(result.remaining).toEqual([0, 4]);
    expect(deltas(result)).toEqual([60, -60]);
    expect(deltas(result).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('4 人：三名输家，座位升序、零和', () => {
    const result = settlePdk(
      finished({ playerCount: 4, remaining: [0, 1, 2, 3], played: [5, 4, 3, 2] }),
    );
    expect(result.playerCount).toBe(4);
    expect(result.scoreChanges.map((c) => c.seat)).toEqual([0, 1, 2, 3]);
    // 保本默认开：剩 1 张的 seat1 付 0
    expect(deltas(result)).toEqual([75, 0, -30, -45]);
    expect(result.baobenSeats).toEqual([1]);
  });
});

describe('settlePdk：翻倍项（炸弹 / 关牌 / 春天）与封顶', () => {
  it('炸弹：2^bombCount 翻倍（只统计裸四张，由 session.bombCount 提供）', () => {
    const result = settlePdk(
      finished({ remaining: [0, 2, 3], played: [5, 4, 3], bombCount: 2 }),
    );
    expect(result.bombCount).toBe(2);
    expect(result.multiplier).toBe(4);
    expect(deltas(result)).toEqual([300, -120, -180]);
  });

  it('关牌：至少一名输家一张未出 ⇒ ×2（guan=true）', () => {
    const result = settlePdk(
      finished({ remaining: [0, 2, 3], played: [5, 0, 3] }),
    );
    expect(result.guan).toBe(true);
    expect(result.spring).toBe(false);
    expect(result.multiplier).toBe(2);
    expect(deltas(result)).toEqual([150, -60, -90]);
  });

  it('春天：所有输家一张未出 ⇒ 关牌与春天叠乘 ×4（3 人）', () => {
    const result = settlePdk(
      finished({ remaining: [0, 2, 3], played: [5, 0, 0] }),
    );
    expect(result.guan).toBe(true);
    expect(result.spring).toBe(true);
    expect(result.multiplier).toBe(4);
    expect(deltas(result)).toEqual([300, -120, -180]);
  });

  it('4 人春天：三名输家都未出牌 ⇒ ×4', () => {
    const result = settlePdk(
      finished({ playerCount: 4, remaining: [0, 2, 2, 2], played: [5, 0, 0, 0] }),
    );
    expect(result.guan).toBe(true);
    expect(result.spring).toBe(true);
    expect(result.multiplier).toBe(4);
  });

  it('2 人局春天不适用：只有一名输家未出 ⇒ 只有关牌 ×2', () => {
    const result = settlePdk(
      finished({ playerCount: 2, remaining: [0, 3], played: [5, 0] }),
    );
    expect(result.guan).toBe(true);
    expect(result.spring).toBe(false);
    expect(result.multiplier).toBe(2);
  });

  it('逐项开关：关炸弹 / 关关牌 / 关春天各自生效（事实字段仍如实）', () => {
    const noBomb = settlePdk(
      finished({
        remaining: [0, 2, 3],
        played: [5, 0, 0],
        bombCount: 3,
        rules: rules({ bombMultiplierEnabled: false }),
      }),
    );
    expect(noBomb.multiplier).toBe(4); // 关牌×春天

    const noGuan = settlePdk(
      finished({ remaining: [0, 2, 3], played: [5, 0, 3], rules: rules({ guanMultiplierEnabled: false }) }),
    );
    expect(noGuan.guan).toBe(true);
    expect(noGuan.multiplier).toBe(1);

    const noSpring = settlePdk(
      finished({
        remaining: [0, 2, 3],
        played: [5, 0, 0],
        rules: rules({ springMultiplierEnabled: false }),
      }),
    );
    expect(noSpring.spring).toBe(true);
    expect(noSpring.multiplier).toBe(2); // 仅关牌
  });

  it('封顶：multiplier 不超过 multiplierCap（默认 64）', () => {
    const capped = settlePdk(
      finished({ remaining: [0, 2, 3], played: [5, 4, 3], bombCount: 10 }),
    );
    expect(capped.multiplier).toBe(64);

    const custom = settlePdk(
      finished({
        remaining: [0, 2, 3],
        played: [5, 4, 3],
        bombCount: 10,
        rules: rules({ multiplierCap: 8 }),
      }),
    );
    expect(custom.multiplier).toBe(8);
  });
});

describe('settlePdk：保本边界', () => {
  it('剩 1 张的输家付 0（baobenSeats），其他输家照常乘倍数', () => {
    const result = settlePdk(
      finished({
        remaining: [0, 1, 4],
        played: [5, 4, 3],
        bombCount: 1,
        rules: rules({ multiplierCap: 64 }),
      }),
    );
    expect(result.multiplier).toBe(2);
    expect(result.baobenSeats).toEqual([1]);
    expect(deltas(result)).toEqual([120, 0, -120]); // seat2: 4×15×2
  });

  it('保本关闭：剩 1 张照常支付，baobenSeats 为空', () => {
    const result = settlePdk(
      finished({ remaining: [0, 1, 4], rules: rules({ baobenEnabled: false }) }),
    );
    expect(result.baobenSeats).toEqual([]);
    expect(deltas(result)).toEqual([75, -15, -60]); // 1×15 + 4×15
  });

  it('所有输家都保本 ⇒ 赢家所得 0（仍零和、仍返回结算向量）', () => {
    const result = settlePdk(
      finished({ playerCount: 2, remaining: [0, 1], played: [5, 4] }),
    );
    expect(result.baobenSeats).toEqual([1]);
    expect(deltas(result)).toEqual([0, 0]);
    expect(result.scoreChanges.reduce((a, c) => a + c.delta, 0)).toBe(0);
  });
});

describe('settlePdk：输入守卫', () => {
  it('未结束 / 赢家不唯一 ⇒ 抛错（结算只对已结束的一局）', () => {
    const notFinished = finished({ winnerSeats: [] });
    notFinished.players[0]!.hand = filler(1); // 无人出完
    expect(() => settlePdk(notFinished)).toThrow();

    const twoWinners = finished({ winnerSeats: [0, 1] });
    twoWinners.players[1]!.hand = [];
    expect(() => settlePdk(twoWinners)).toThrow();
  });
});

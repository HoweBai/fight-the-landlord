import { describe, it, expect } from 'vitest';
import { validateOutbound } from '@fight-the-landlord/protocol';
import type { Card } from '@fight-the-landlord/protocol';
import { settleGame } from './settle';
import { GameState, type GameSession } from './types';
import { createSession, dealCards } from './game';

/** R696：牌是 `{r, s}`。结算只数**张数**（`hand.length`），故 `s` 取常量即可。 */
const threeCards = (): Card[] => [3, 4, 5].map((r) => ({ r, s: 0 }));

/**
 * 夹具：**显式**给出 `playPhase`，否则 C3 落地后 `farmerPlays: 0` 会自动变成春天，
 * 把 C1 的乘法判据污染成 C3 的（R183）。
 */
function finishedSession(
  over: {
    landlordSeat?: number;
    winner: 'landlord' | 'farmer';
    bidMultiplier?: number;
    bombCount?: number;
    landlordPlays?: number;
    farmerPlays?: number;
    baseScore?: number;
    /** 打乱 players 顺序，用来暴露「下标 ≠ 座位」的 C2 缺陷。 */
    playerOrder?: number[];
  },
): GameSession {
  const landlordSeat = over.landlordSeat ?? 0;
  const base = dealCards(createSession('ROOM1', ['u0', 'u1', 'u2']));
  const order = over.playerOrder ?? [0, 1, 2];
  const players = order.map((seat) => {
    const isLandlord = seat === landlordSeat;
    const hand = isLandlord
      ? over.winner === 'landlord'
        ? []
        : threeCards()
      : over.winner === 'farmer' && seat === (landlordSeat + 1) % 3
        ? []
        : threeCards();
    return { ...base.players[seat]!, seat, isLandlord, hand };
  });
  return {
    ...base,
    state: GameState.Playing,
    baseScore: over.baseScore ?? 100,
    players,
    playPhase: {
      bombCount: over.bombCount ?? 0,
      landlordPlays: over.landlordPlays ?? 0,
      farmerPlays: over.farmerPlays ?? 1,
      consecutivePasses: 0,
    },
    bidPhase: { ...base.bidPhase, bidMultiplier: over.bidMultiplier ?? 1 },
  };
}

describe('settleGame', () => {
  it('throws when game not finished', () => {
    const dealt = dealCards(createSession('ROOM1', ['user-1', 'user-2', 'user-3']));
    expect(() => settleGame(dealt)).toThrow('Game not finished');
  });

  /**
   * 2026-10-21：`createSession` 的底分改由调用方写入（缺省 0 哨兵）。
   * 结算金额 = 底分 × 倍数；0/负数/小数若漏进来会静默算出错误金币 —— 必须响亮失败。
   * 位置判据：同一文件的「未结束局先报 Game not finished」仍绿（守卫在 winner/landlord 之后）。
   */
  it('🔴 底分必须是正整数（0 哨兵不得流入结算）', () => {
    expect(() => settleGame(finishedSession({ winner: 'landlord', baseScore: 0 }))).toThrow('Invalid baseScore');
    expect(() => settleGame(finishedSession({ winner: 'landlord', baseScore: -1 }))).toThrow('Invalid baseScore');
    expect(() => settleGame(finishedSession({ winner: 'landlord', baseScore: 1.5 }))).toThrow('Invalid baseScore');
  });

  it('C1：倍数 = bidMultiplier × 2^bombCount（**乘法**，不是加法）', () => {
    const result = settleGame(finishedSession({ winner: 'landlord', bidMultiplier: 2, bombCount: 1, farmerPlays: 2 }));
    expect(result.multiplier).toBe(4); // 旧加法实现给 3
  });

  it('C2：landlordSeat 取**座位号**，与 players 数组下标无关', () => {
    const result = settleGame(
      finishedSession({ winner: 'landlord', landlordSeat: 1, playerOrder: [2, 0, 1] }),
    );
    expect(result.landlordSeat).toBe(1); // 下标是 2 ⇒ 旧实现给 2
    expect([...result.farmerSeats].sort()).toEqual([0, 2]);
  });

  it('C3 春天：地主胜且两农民一手未出 ⇒ spring，倍数 ×2', () => {
    const result = settleGame(finishedSession({ winner: 'landlord', bidMultiplier: 2, farmerPlays: 0 }));
    expect(result.spring).toBe('spring');
    expect(result.multiplier).toBe(4);
  });

  it('C3 反春：农民胜且地主只出过一手 ⇒ anti-spring，倍数 ×2', () => {
    const result = settleGame(finishedSession({ winner: 'farmer', bidMultiplier: 2, landlordPlays: 1 }));
    expect(result.spring).toBe('anti-spring');
    expect(result.multiplier).toBe(4);
  });

  it('C3 非春天：农民胜且地主出过两手 ⇒ none', () => {
    const result = settleGame(finishedSession({ winner: 'farmer', bidMultiplier: 2, landlordPlays: 2 }));
    expect(result.spring).toBe('none');
    expect(result.multiplier).toBe(2);
  });

  it('C26：底分来自 session.baseScore（不是硬编码 100）', () => {
    const result = settleGame(finishedSession({ winner: 'landlord', baseScore: 200, bidMultiplier: 2, farmerPlays: 2 }));
    expect(result.baseScore).toBe(200);
    expect(result.landlordScoreChange).toBe(200 * 2 * 2); // baseScore × 倍数 × 2
    expect(result.farmerScoreChange).toBe(-200 * 2);
  });

  it('§8.4：四种（胜方 × 春天）组合下分数都守恒', () => {
    const cases = [
      { winner: 'landlord' as const, landlordPlays: 3, farmerPlays: 0 },
      { winner: 'landlord' as const, landlordPlays: 3, farmerPlays: 2 },
      { winner: 'farmer' as const, landlordPlays: 1, farmerPlays: 2 },
      { winner: 'farmer' as const, landlordPlays: 4, farmerPlays: 2 },
    ];
    for (const c of cases) {
      const r = settleGame(finishedSession({ ...c, bidMultiplier: 2, bombCount: 2 }));
      expect(r.landlordScoreChange + r.farmerScoreChange * r.farmerSeats.length).toBe(0);
    }
  });

  it('N1：返回值逐字段等于契约 SettlementResult（**过得了网关的出站校验**）', () => {
    const result = settleGame(finishedSession({ winner: 'landlord', bidMultiplier: 2, farmerPlays: 2 }));
    expect(Object.keys(result).sort()).toEqual(
      [
        'baseScore', 'farmerScoreChange', 'farmerSeats', 'landlordScoreChange',
        'landlordSeat', 'multiplier', 'roomCode', 'spring', 'winner',
      ].sort(),
    );
    // 旧实现的返回值在这一行抛 `$.payload.baseScore must be a finite number, got undefined`
    expect(() => validateOutbound({ type: 'game.settlement', version: 1, payload: result })).not.toThrow();
  });

  /** C16 的判别形态（切片 9 改写，本片保留）：**只有一名**农民手牌为空。 */
  it('settles a farmer win when a single farmer has emptied their hand (C16)', () => {
    const r = settleGame(finishedSession({ winner: 'farmer', landlordPlays: 3 }));
    expect(r.winner).toBe('farmer');
    expect(r.farmerSeats).toHaveLength(2);
  });
});

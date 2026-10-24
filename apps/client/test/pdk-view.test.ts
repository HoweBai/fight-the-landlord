import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { PdkSettlementResult } from '@fight-the-landlord/protocol';
import { useGameStore } from '../src/stores/game';

/**
 * S5.3：store 的**事件联合**（pdk 结算 / game.finished 新形状）。
 *
 * 事件按 `type@version` 幂等；pdk 载荷原样入库（页面按玩法分派）。
 */
const pdkSettlement = (): PdkSettlementResult => ({
  roomCode: 'PDK1',
  gameType: 'paodekuai',
  playerCount: 3,
  baseScore: 15,
  winnerSeats: [0],
  scoreChanges: [
    { seat: 0, delta: 30 },
    { seat: 1, delta: -30 },
    { seat: 2, delta: 0 },
  ],
  remaining: [0, 4, 2],
  multiplier: 1,
  bombCount: 0,
  guan: false,
  spring: false,
  baobenSeats: [],
});

describe('S5.3：store 事件联合', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('game.finished（pdk）⇒ {gameType, winnerSeats}；ddz 旧形状不变', () => {
    const store = useGameStore();
    store.applyEvent({
      type: 'game.finished',
      version: 5,
      payload: { gameType: 'paodekuai', winnerSeats: [1] },
    });
    expect(store.finished).toEqual({ gameType: 'paodekuai', winnerSeats: [1] });

    const fresh = useGameStore();
    fresh.$reset();
    fresh.applyEvent({
      type: 'game.finished',
      version: 5,
      payload: { winner: 'farmer' },
    });
    expect(fresh.finished).toEqual({ winner: 'farmer' });
  });

  it('game.settlement（pdk 向量）原样入库；ddz 9 键照旧', () => {
    const store = useGameStore();
    const result = pdkSettlement();
    store.applyEvent({ type: 'game.settlement', version: 6, payload: result });
    expect(store.settlement).toEqual(result);

    const fresh = useGameStore();
    fresh.$reset();
    const ddz = {
      roomCode: 'R1',
      baseScore: 15,
      winner: 'landlord' as const,
      landlordSeat: 0,
      farmerSeats: [1, 2],
      multiplier: 2,
      spring: 'none' as const,
      landlordScoreChange: 30,
      farmerScoreChange: -15,
    };
    fresh.applyEvent({ type: 'game.settlement', version: 2, payload: ddz });
    expect(fresh.settlement).toEqual(ddz);
  });

  it('事件幂等：同 type@version 第二次返回 false、不覆盖', () => {
    const store = useGameStore();
    const event = {
      type: 'game.finished' as const,
      version: 7,
      payload: { gameType: 'paodekuai' as const, winnerSeats: [2] },
    };
    expect(store.applyEvent(event)).toBe(true);
    expect(store.applyEvent(event)).toBe(false);
    expect(store.finished).toEqual({ gameType: 'paodekuai', winnerSeats: [2] });
  });
});

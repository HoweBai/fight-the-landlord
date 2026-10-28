import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  DEFAULT_CHENGDU_RULES,
  type MahjongPlayerView,
  type Tile,
} from '@fight-the-landlord/protocol';
import { useGameStore } from '../src/stores/game';

/**
 * T11：store 的麻将感知。
 *
 * - 麻将视图按 `gameType` 窄化；ddz 系 getter 全部让位（不得把麻将当斗地主）；
 * - 多行动者窗口：`isMyTurn` 看 `activeSeats`，`actorSeat` 给窗口首座；
 * - `game.current_turn` 的 `seats`/`windowId`、`game.finished` 的麻将形状原样落库；
 * - 麻将专属字段存在但缺 `gameType` ⇒ 丢弃（fail closed）。
 */
function tile(s: 0 | 1 | 2, r: number): Tile {
  return { s, r };
}

function mahjongView(over: Partial<MahjongPlayerView> = {}): MahjongPlayerView {
  return {
    roomCode: 'MJ1',
    gameType: 'mahjong',
    playerCount: 4,
    version: 1,
    state: 'play',
    baseScore: 1,
    seat: 0,
    hand: [
      tile(0, 1), tile(0, 1), tile(0, 2), tile(0, 2), tile(0, 3), tile(0, 3),
      tile(1, 4), tile(1, 5), tile(1, 6), tile(2, 7), tile(2, 8), tile(2, 9),
      tile(1, 9), tile(0, 9),
    ],
    cardCounts: [14, 13, 13, 13],
    trustees: [false, false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 1_700_000_030_000,
    activeSeats: [0],
    tingSeats: [],
    dealerSeat: 0,
    wallCount: 40,
    lackSuits: [0, 1, 2, null],
    melds: [[], [], [], []],
    discards: [[], [], [], []],
    isOut: [false, false, false, false],
    huInfos: [],
    claimsForMe: [],
    mahjongRules: DEFAULT_CHENGDU_RULES,
    revealedHands: [],
    windowId: 'turn:1',
    ...over,
  };
}

describe('T11：store 麻将视图', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('麻将快照 ⇒ mahjong；ddz getter 全部让位；手牌走 mahjongView', () => {
    const store = useGameStore();
    expect(store.applySnapshot(mahjongView())).toBe('applied');

    expect(store.gameType).toBe('mahjong');
    expect(store.activeMode).toBe('mahjong');
    expect(store.playerCount).toBe(4);
    expect(store.mahjongView?.wallCount).toBe(40);
    expect(store.hand).toEqual([]);
    expect(store.ddzView).toBeNull();
    expect(store.landlordSeat).toBeNull();
    expect(store.bottomCards).toBeNull();
    expect(store.ddzBidPhase).toBeNull();
    expect(store.ddzPlayPhase).toBeNull();
  });

  it('多行动者窗口：actorSeat=首座，isMyTurn 看 activeSeats 是否包含我', () => {
    const store = useGameStore();
    store.applySnapshot(mahjongView({ seat: 0, activeSeats: [2, 0] }));
    store.setMySeat(0);
    expect(store.actorSeat).toBe(2);
    expect(store.isMyTurn).toBe(true);

    store.applySnapshot(mahjongView({ version: 2, seat: 0, activeSeats: [2] }));
    expect(store.isMyTurn).toBe(false);

    store.setMySeat(2);
    expect(store.isMyTurn).toBe(true);
  });

  it('game.current_turn 保存 seats/windowId（旧形状缺省不影响）', () => {
    const store = useGameStore();
    store.applySnapshot(mahjongView());
    expect(
      store.applyEvent({
        type: 'game.current_turn',
        version: 2,
        payload: { seat: 0, seats: [0, 2], timeoutMs: 15000, windowId: 'claim:4' },
      }),
    ).toBe(true);
    expect(store.activeTurn).toMatchObject({
      seat: 0,
      seats: [0, 2],
      windowId: 'claim:4',
      timeoutMs: 15000,
    });
  });

  it('game.finished 保存麻将形状（winnerSeats/endReason/huazhuSeats）', () => {
    const store = useGameStore();
    store.applySnapshot(mahjongView());
    store.applyEvent({
      type: 'game.finished',
      version: 9,
      payload: {
        gameType: 'mahjong',
        winnerSeats: [0, 2],
        endReason: 'threeWinners',
        huazhuSeats: [3],
      },
    });
    expect(store.finished).toEqual({
      gameType: 'mahjong',
      winnerSeats: [0, 2],
      endReason: 'threeWinners',
      huazhuSeats: [3],
    });
  });

  it('麻将专属字段存在但缺 gameType ⇒ 丢弃（fail closed）', () => {
    const store = useGameStore();
    const malformed = { ...mahjongView(), gameType: undefined };
    expect(store.applySnapshot(malformed as never)).toBe('discarded');
    expect(store.view).toBeNull();
  });
});

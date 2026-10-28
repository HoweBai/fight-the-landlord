import { describe, expect, it } from 'vitest';
import { DEFAULT_CHENGDU_RULES, type MahjongPlayerView, type Tile } from '@fight-the-landlord/protocol';
import {
  pickDiscardTile,
  pickExchangeTiles,
  pickLackSuit,
  pickMahjongAction,
} from '../src/lib/mahjong-driver';

/** 独立 oracle 的纯策略单测（不连真栈；真栈由 slice-36 覆盖）。 */
const t = (s: 0 | 1 | 2, r: number): Tile => ({ s, r });

function view(over: Partial<MahjongPlayerView> = {}): MahjongPlayerView {
  return {
    roomCode: 'MJ1',
    gameType: 'mahjong',
    playerCount: 4,
    version: 1,
    state: 'play',
    baseScore: 15,
    seat: 0,
    hand: [],
    cardCounts: [0, 0, 0, 0],
    trustees: [false, false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 0,
    activeSeats: [0],
    dealerSeat: 0,
    wallCount: 40,
    lackSuits: [null, null, null, null],
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

describe('mahjong-driver oracle', () => {
  it('换三张：数量最多的一门取 3 张', () => {
    const hand = [
      t(0, 1), t(0, 2), t(0, 3), t(0, 4), t(0, 5),
      t(1, 1), t(1, 2), t(1, 3), t(1, 4),
      t(2, 1), t(2, 2), t(2, 3), t(2, 4),
    ];
    const picked = pickExchangeTiles(hand);
    expect(picked).toHaveLength(3);
    expect(picked.every((x) => x.s === 0)).toBe(true);
  });

  it('定缺：数量最少的一门（并列按万→筒→条）', () => {
    expect(pickLackSuit([t(0, 1), t(0, 2), t(1, 1), t(1, 2), t(1, 3), t(2, 1)])).toBe(2);
    expect(pickLackSuit([t(0, 1), t(0, 2), t(1, 1), t(1, 2), t(2, 1), t(2, 2)])).toBe(0);
  });

  it('出牌：有缺门牌先打缺门；没有则打第一张', () => {
    const withLack = view({
      hand: [t(0, 1), t(1, 2), t(2, 3)],
      lackSuits: [2, null, null, null],
    });
    expect(pickDiscardTile(withLack)).toEqual(t(2, 3));
    const noLack = view({ hand: [t(0, 1), t(1, 2)], lackSuits: [null, null, null, null] });
    expect(pickDiscardTile(noLack)).toEqual(t(0, 1));
  });

  it('响应窗口：能胡就胡，否则过', () => {
    const claim = view({
      state: 'claim',
      claimsForMe: [{ claim: 'hu', tile: t(0, 1) }, { claim: 'pass' }],
    });
    expect(pickMahjongAction(claim)).toEqual({ type: 'claim', claim: 'hu' });
    const pass = view({ state: 'claim', claimsForMe: [{ claim: 'pass' }] });
    expect(pickMahjongAction(pass)).toEqual({ type: 'claim', claim: 'pass' });
  });

  it('自摸窗口：能胡就 selfDrawHu，否则打缺门/第一张', () => {
    const hu = view({
      state: 'play',
      hand: [t(0, 1)],
      claimsForMe: [{ claim: 'hu', tile: t(0, 1) }],
    });
    expect(pickMahjongAction(hu)).toEqual({ type: 'selfDrawHu' });
    const discard = view({
      state: 'play',
      hand: [t(0, 1), t(2, 9)],
      lackSuits: [2, null, null, null],
    });
    expect(pickMahjongAction(discard)).toEqual({ type: 'discard', tile: t(2, 9) });
  });
});

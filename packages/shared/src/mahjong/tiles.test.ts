import { describe, expect, it } from 'vitest';
import type { Tile } from '@fight-the-landlord/protocol';
import {
  MAHJONG_WALL_AFTER_DEAL,
  createMahjongDeck,
  dealMahjong,
} from './deck';
import {
  autoExchangePick,
  exchangeDirectionFor,
  exchangeHands,
  exchangeTarget,
  validateExchangePick,
} from './exchange';
import { autoLackSuit, canDiscard, canPengOrGang, validateLackSuit } from './lack';
import { makeAddedGang, makeConcealedGang, makeMeldedGang, makePeng } from './meld';

const t = (s: 0 | 1 | 2, r: number): Tile => ({ s, r });

describe('mahjong deck/deal', () => {
  it('108 张、每种 4 张；发牌 4×13 + 56', () => {
    const deck = createMahjongDeck();
    expect(deck).toHaveLength(108);
    const counts = new Map<string, number>();
    for (const tile of deck) counts.set(`${tile.s}-${tile.r}`, (counts.get(`${tile.s}-${tile.r}`) ?? 0) + 1);
    expect(counts.size).toBe(27);
    expect([...counts.values()].every((n) => n === 4)).toBe(true);

    const deal = dealMahjong(() => 0.5, deck);
    expect(deal.hands).toHaveLength(4);
    expect(deal.hands.every((h) => h.length === 13)).toBe(true);
    expect(deal.wall).toHaveLength(MAHJONG_WALL_AFTER_DEAL);
    expect(deal.hands.flat().length + deal.wall.length).toBe(108);
  });
});

describe('mahjong exchange', () => {
  const hand0 = [t(0, 1), t(0, 2), t(0, 3), t(1, 1), t(1, 2), t(1, 3), t(1, 4), t(2, 1), t(2, 2), t(2, 3), t(2, 4), t(2, 5), t(2, 6)];
  const hand1 = [t(0, 4), t(0, 5), t(0, 6), t(1, 5), t(1, 6), t(1, 7), t(1, 8), t(2, 7), t(2, 8), t(2, 9), t(0, 7), t(0, 8), t(0, 9)];
  const hand2 = [t(1, 1), t(1, 2), t(1, 3), t(2, 1), t(2, 2), t(2, 3), t(0, 1), t(0, 2), t(0, 3), t(0, 4), t(0, 5), t(0, 6), t(0, 7)];
  const hand3 = [t(2, 1), t(2, 2), t(2, 3), t(0, 1), t(0, 2), t(0, 3), t(1, 1), t(1, 2), t(1, 3), t(1, 4), t(1, 5), t(1, 6), t(1, 7)];
  const hands = [hand0, hand1, hand2, hand3];
  const picks = [hand0.slice(0, 3), hand1.slice(0, 3), hand2.slice(0, 3), hand3.slice(0, 3)];

  it('同花色 3 张校验', () => {
    expect(() => validateExchangePick(hand0, hand0.slice(0, 3))).not.toThrow();
    expect(() => validateExchangePick(hand0, [t(0, 1), t(1, 1), t(0, 2)])).toThrow(/同花色/);
    expect(() => validateExchangePick(hand0, [t(0, 9), t(0, 9), t(0, 9)])).toThrow(/不在手牌/);
  });

  it('方向映射与同时交换', () => {
    expect(exchangeTarget(0, 'clockwise')).toBe(1);
    expect(exchangeTarget(0, 'counterclockwise')).toBe(3);
    expect(exchangeTarget(0, 'opposite')).toBe(2);
    expect(exchangeDirectionFor(() => 0, 'random')).toBe('clockwise');
    expect(exchangeDirectionFor(() => 0.99, 'opposite')).toBe('opposite');

    const out = exchangeHands(hands, picks, 'clockwise');
    expect(out.map((h) => h.length)).toEqual([13, 13, 13, 13]);
    // seat 0 交出自己的 pick，收到 seat 3 的 pick
    expect(out[0]!.some((x) => x.s === 0 && x.r <= 3)).toBe(false);
    expect(out[0]!.filter((x) => x.s === 2 && x.r <= 3)).toHaveLength(6);
  });

  it('超时自动选：张数最少且 ≥3 的花色，取最小 3 张', () => {
    const hand = [t(0, 1), t(0, 2), t(0, 3), t(0, 4), t(0, 5), t(1, 1), t(1, 2), t(1, 3), t(1, 4), t(2, 1), t(2, 2), t(2, 3), t(2, 4)];
    expect(autoExchangePick(hand)).toEqual([t(1, 1), t(1, 2), t(1, 3)]);
  });
});

describe('mahjong lack', () => {
  it('2 门强制缺第三门；1 门只能在另两门选', () => {
    const twoSuits = [t(0, 1), t(0, 2), t(1, 1)];
    expect(() => validateLackSuit(twoSuits, 2)).not.toThrow();
    expect(() => validateLackSuit(twoSuits, 0)).toThrow(/缺少/);
    expect(autoLackSuit(twoSuits)).toBe(2);

    const oneSuit = [t(0, 1), t(0, 2)];
    expect(() => validateLackSuit(oneSuit, 0)).toThrow(/另外两门/);
    expect(autoLackSuit(oneSuit)).toBe(1);
  });

  it('3 门任选；自动选张数最少', () => {
    const hand = [t(0, 1), t(0, 2), t(1, 1), t(1, 2), t(1, 3), t(1, 4), t(2, 1), t(2, 2), t(2, 3), t(2, 4), t(2, 5), t(2, 6), t(2, 7)];
    expect(autoLackSuit(hand)).toBe(0);
    expect(() => validateLackSuit(hand, 1)).not.toThrow();
  });

  it('有缺门牌只能打缺门；缺门牌不能碰/杠', () => {
    const hand = [t(0, 1), t(0, 2), t(1, 1), t(1, 1)];
    expect(canDiscard(hand, 0, t(0, 1))).toBe(true);
    expect(canDiscard(hand, 0, t(1, 1))).toBe(false);
    expect(canPengOrGang(hand, 0, t(0, 1))).toBe(false);
    expect(canPengOrGang(hand, 0, t(1, 1))).toBe(true);
  });
});

describe('mahjong meld', () => {
  it('碰/明杠/暗杠/补杠移除正确张数', () => {
    const hand = [t(0, 1), t(0, 1), t(0, 1), t(0, 1), t(1, 1)];
    const peng = makePeng(hand, t(0, 1), 1);
    expect(peng.hand).toHaveLength(3);
    expect(peng.meld.tiles).toHaveLength(3);

    const gang = makeMeldedGang(hand, t(0, 1), 1);
    expect(gang.hand).toHaveLength(2);
    expect(gang.meld.tiles).toHaveLength(4);

    const an = makeConcealedGang(hand, t(0, 1));
    expect(an.hand).toHaveLength(1);
    expect(an.meld.kind).toBe('angang');

    const added = makeAddedGang([t(0, 1)], peng.meld, t(0, 1));
    expect(added.hand).toHaveLength(0);
    expect(added.meld.tiles).toHaveLength(4);
  });
});

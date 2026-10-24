import { describe, it, expect } from 'vitest';
import * as codec from './codec';
import {
  DOUZERO_2,
  RANK_BLACK_JOKER,
  RANK_RED_JOKER,
  toDisplay,
  isValidDouZeroCard,
  suitSymbol,
  colorOf,
} from './codec';

describe('R695：全系统统一 DouZero 编码，内部 Rank 已删除', () => {
  it('2 的编码是 17，且全系统只有这一个 2', () => {
    expect(DOUZERO_2).toBe(17);
  });

  it('toInternalRank / toDouZero / RANK_2 这三个符号已不存在', () => {
    // 它们的存在本身就是缺陷的温床：C19「同点数的 2 互相压过」正是双编码造成的。
    const mod = codec as unknown as Record<string, unknown>;
    expect(mod.toInternalRank).toBeUndefined();
    expect(mod.toDouZero).toBeUndefined();
    expect(mod.RANK_2).toBeUndefined();
  });

  it('toDisplay 直接吃 DouZero 编码（不再经过内部 Rank）', () => {
    expect(toDisplay(DOUZERO_2)).toBe('2');
    expect(toDisplay(14)).toBe('A');
    expect(toDisplay(13)).toBe('K');
    expect(toDisplay(12)).toBe('Q');
    expect(toDisplay(11)).toBe('J');
    expect(toDisplay(3)).toBe('3');
    expect(toDisplay(RANK_BLACK_JOKER)).toBe('小王');
    expect(toDisplay(RANK_RED_JOKER)).toBe('大王');
  });

  it('validates card values', () => {
    for (const n of [3, 14, 17, 20, 30]) expect(isValidDouZeroCard(n)).toBe(true);
    for (const n of [0, 1, 2, 15, 16, 18, 19, 21, 31, 3.5, NaN]) {
      expect(isValidDouZeroCard(n)).toBe(false);
    }
    expect(isValidDouZeroCard('17')).toBe(false);
  });
});

describe('R696：展示向助手（客户端渲花色用）', () => {
  it('suitSymbol 覆盖四个花色与王', () => {
    expect(suitSymbol(0)).toBe('♠');
    expect(suitSymbol(1)).toBe('♥');
    expect(suitSymbol(2)).toBe('♣');
    expect(suitSymbol(3)).toBe('♦');
    expect(suitSymbol(4)).toBe(''); // 王没有花色符号
  });

  it('colorOf 对两王按 r 区分 —— 两张王的 s 都是 4，光看花色分不出来', () => {
    expect(colorOf({ r: 5, s: 0 })).toBe('black');
    expect(colorOf({ r: 5, s: 1 })).toBe('red');
    expect(colorOf({ r: 5, s: 2 })).toBe('black');
    expect(colorOf({ r: 5, s: 3 })).toBe('red');
    expect(colorOf({ r: RANK_BLACK_JOKER, s: 4 })).toBe('black');
    expect(colorOf({ r: RANK_RED_JOKER, s: 4 })).toBe('red');
  });
});

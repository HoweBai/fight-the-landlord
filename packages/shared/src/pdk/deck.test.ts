/**
 * Task 3.1 / spec §5.1：跑得快 48 张牌堆。
 *
 * 48 = 54 − 大小王 − 黑桃2 − 梅花2 − 方块2 − 黑桃A；**保留红桃2**（K7）。
 * 花色 0♠ 1♥ 2♣ 3♦；牌值 r：3–14、17(=2)；无王。
 */
import { describe, expect, it } from 'vitest';
import { createPdkDeck } from './deck';

const key = (c: { r: number; s: number }): string => `${c.r},${c.s}`;

describe('createPdkDeck（48 张）', () => {
  it('恰 48 张且无重复', () => {
    const deck = createPdkDeck();
    expect(deck).toHaveLength(48);
    expect(new Set(deck.map(key)).size).toBe(48);
  });

  it('无大小王（s=4 / r>=20 一律不出现）', () => {
    const deck = createPdkDeck();
    expect(deck.some((c) => c.r >= 20)).toBe(false);
    expect(deck.some((c) => c.s === 4)).toBe(false);
  });

  it('被去掉的六张不在：大小王、黑桃A、黑桃2、梅花2、方块2', () => {
    const deck = createPdkDeck();
    const present = new Set(deck.map(key));
    for (const removed of [
      { r: 20, s: 4 }, // 小王
      { r: 30, s: 4 }, // 大王
      { r: 14, s: 0 }, // 黑桃A
      { r: 17, s: 0 }, // 黑桃2
      { r: 17, s: 2 }, // 梅花2
      { r: 17, s: 3 }, // 方块2
    ]) {
      expect(present.has(key(removed)), `${key(removed)} 不应在牌堆里`).toBe(false);
    }
  });

  it('保留红桃2（红桃花色完整：3..A + 2）', () => {
    const deck = createPdkDeck();
    expect(deck.some((c) => c.r === 17 && c.s === 1)).toBe(true);
    const hearts = deck.filter((c) => c.s === 1).map((c) => c.r).sort((a, b) => a - b);
    expect(hearts).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17]);
  });

  it('花色张数：♠11 / ♥13 / ♣12 / ♦12（A 缺黑桃、2 只留红桃）', () => {
    const deck = createPdkDeck();
    const counts = [0, 1, 2, 3].map((s) => deck.filter((c) => c.s === s).length);
    expect(counts).toEqual([11, 13, 12, 12]);
  });

  it('每次返回**新数组**（调用方洗牌不得污染下一次）', () => {
    const a = createPdkDeck();
    const b = createPdkDeck();
    expect(a).not.toBe(b);
    a.pop();
    expect(createPdkDeck()).toHaveLength(48);
  });
});

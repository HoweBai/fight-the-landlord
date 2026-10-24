import { describe, expect, it } from 'vitest';
import { keyedHandOrder } from '../src/components/hand-keys';

const card = (r: number, s: number) => ({ r, s });

describe('keyedHandOrder', () => {
  it('唯一牌面：key 按 order 返回，index 保持原始下标', () => {
    const cards = [card(3, 0), card(5, 1), card(4, 2)];
    expect(keyedHandOrder(cards, [1, 2, 0])).toEqual([
      { index: 1, key: '5-1' },
      { index: 2, key: '4-2' },
      { index: 0, key: '3-0' },
    ]);
  });

  it('删掉第一张后，剩余牌的 key 逐一不变', () => {
    const before = keyedHandOrder([card(3, 0), card(5, 1), card(4, 2)], [2, 1, 0]);
    const after = keyedHandOrder([card(5, 1), card(4, 2)], [1, 0]);
    const survivingKeys = before.filter((e) => e.index !== 0).map((e) => e.key);
    expect(after.map((e) => e.key)).toEqual(survivingKeys);
  });

  it('重复牌面：key 唯一且带出现序号；删除其中一张时允许另一张序号变化', () => {
    const before = keyedHandOrder([card(20, 4), card(20, 4), card(30, 4)], [0, 1, 2]);
    expect(before.map((e) => e.key)).toEqual(['20-4', '20-4#1', '30-4']);
    expect(new Set(before.map((e) => e.key)).size).toBe(3);

    const after = keyedHandOrder([card(20, 4), card(30, 4)], [0, 1]);
    expect(after.map((e) => e.key)).toEqual(['20-4', '30-4']);
  });
});

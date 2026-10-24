import type { Card as ProtocolCard } from '@fight-the-landlord/protocol';
import { cardKey } from '../game/card-key';

export interface KeyedHandCard {
  /** cards 里的原始下标（选中/toggle 语义不变）。 */
  index: number;
  /** 稳定 key。 */
  key: string;
}

/**
 * 为展示顺序的每张牌生成稳定 key。
 *
 * - 正常单副牌：(r,s) 唯一 ⇒ key = `${r}-${s}`
 * - 重复牌面（仅测试/探针）：追加按**原始顺序**分配的出现序号 `#1`、`#2`…
 *
 * 出现序号按 `cards` 原始顺序分配，再按 `order` 映射到展示顺序 ——
 * 这样排序变化不会让重复牌的序号互换。
 */
export function keyedHandOrder(
  cards: readonly ProtocolCard[],
  order: readonly number[],
): KeyedHandCard[] {
  const seen = new Map<string, number>();
  const keys = cards.map((c) => {
    const base = cardKey(c);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
  return order.map((index) => ({ index, key: keys[index]! }));
}

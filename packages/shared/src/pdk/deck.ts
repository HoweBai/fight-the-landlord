/**
 * 跑得快牌堆（Task 3.1 / spec §5.1）。
 *
 * 48 张 = 54 张（`createDeck()`）去掉：
 *  - 大小王（`r = 20/30`、`s = 4`）；
 *  - 黑桃2（`s = 0, r = 17`）、梅花2（`s = 2`）、方块2（`s = 3`）；
 *  - 黑桃A（`s = 0, r = 14`）；
 * **保留红桃2**（`s = 1, r = 17`）—— 红桃花色完整（3..A + 2）。
 *
 * 牌值编码复用 DouZero：3–14、17(=2)；花色 0♠ 1♥ 2♣ 3♦。
 */
import { ProtocolError, type Card } from '@fight-the-landlord/protocol';
import { createDeck } from '../card/card';

/** 跑得快牌堆张数（唯一常量，测试/发牌校验共用）。 */
export const PDK_DECK_SIZE = 48;

/** 被去掉的牌（除大小王外）：黑桃A、黑桃2、梅花2、方块2。 */
const REMOVED_CARDS = new Set(['14,0', '17,0', '17,2', '17,3']);

const cardKey = (c: Card): string => `${c.r},${c.s}`;

/** 是否属于跑得快 48 张合法集合（无王、无被去掉的四张）。 */
export function isPdkCard(c: Card): boolean {
  if (c.s < 0 || c.s > 3) return false;
  if (c.r < 3 || c.r > 17) return false;
  if (c.r === 15 || c.r === 16) return false;
  return !REMOVED_CARDS.has(cardKey(c));
}

/** 新的一副 48 张（每次返回新数组；顺序与 `createDeck()` 过滤后的顺序一致）。 */
export function createPdkDeck(): Card[] {
  return createDeck().filter(isPdkCard);
}

/**
 * `testDeck`（内部测试钩子）的合法性校验（spec §5.2）：
 * **恰 48 张、全部属于跑得快合法牌集合、无重复** —— 否则抛 `ProtocolError`
 *（game-service 的 `game.start` 会把它映射成 `10001`；不得把“牌堆错误”当成测试红）。
 */
export function assertPdkDeck(cards: readonly Card[]): void {
  if (!Array.isArray(cards) || cards.length !== PDK_DECK_SIZE) {
    throw new ProtocolError(
      `testDeck must contain exactly ${PDK_DECK_SIZE} cards, got ${Array.isArray(cards) ? cards.length : JSON.stringify(cards)}`,
    );
  }
  const seen = new Set<string>();
  for (const card of cards) {
    if (!card || typeof card.r !== 'number' || typeof card.s !== 'number' || !isPdkCard(card)) {
      throw new ProtocolError(`testDeck contains a card outside the paodekuai deck: ${JSON.stringify(card)}`);
    }
    const key = cardKey(card);
    if (seen.has(key)) {
      throw new ProtocolError(`testDeck contains a duplicate card: ${key}`);
    }
    seen.add(key);
  }
}

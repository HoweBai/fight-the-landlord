import type { Card } from '@fight-the-landlord/protocol';

/**
 * `shared` 的牌相关常量。
 *
 * ⚠️ **牌的类型不在这里**（R696）：全系统唯一的牌形状是 `protocol.Card`（`{r, s}`）。
 * 本文件此前导出的 `Card { suit, rank, color }` 已**退役**——留着就是第二个真源。
 *
 * 保留的只有两样：
 *  - `Suit`：与 `protocol` 的 `s` **同值**（0♠ 1♥ 2♣ 3♦ 4王）。`protocol` 出于
 *    「零依赖」不导出枚举，只把值域写在 `Card.s` 的文档里；本枚举是它在服务端的落点。
 *  - `Rank`：R695 之后**只保留符号**，`Rank2` 的值已从 15 改为 17。
 */

export enum Suit {
  Spade = 0,
  Heart,
  Club,
  Diamond,
  Joker,
}

export enum Rank {
  Rank3 = 3,
  Rank4,
  Rank5,
  Rank6,
  Rank7,
  Rank8,
  Rank9,
  Rank10,
  RankJ,
  RankQ,
  RankK,
  RankA,
  /** R695：全系统统一 DouZero 编码 —— 2 就是 17，不再是 15 */
  Rank2 = 17,
  RankBlackJoker = 20,
  RankRedJoker = 30,
}

/**
 * 一副 54 张（含大小王）。
 *
 * ⚠️ **2 必须单独加，不能靠循环上界覆盖**（R695 之后 `Rank2 = 17` 与 `RankA(14)`
 * **不连续**）：
 *  - 上界写 `<= Rank2` ⇒ 循环跑 3..17，产出 15 点 × 4 + 2 王 = **62 张**，
 *    其中 15/16 不是合法 DouZero 牌值；
 *  - 上界写 `<= RankA` ⇒ 只有 12 点 × 4 + 2 王 = **50 张**，**四张 2 全丢**。
 *
 * 两条都由 `card.test.ts` 的 `creates 54 cards` 守着（实测各红一次）。
 */
export function createDeck(): Card[] {
  const deck: Card[] = [];

  // 3..A：连续的 12 个点数（Rank3 = 3 … RankA = 14）
  for (let s = Suit.Spade; s <= Suit.Diamond; s++) {
    for (let r = Rank.Rank3; r <= Rank.RankA; r++) {
      deck.push({ r, s });
    }
  }

  // 2 单独加（见上方说明）
  for (let s = Suit.Spade; s <= Suit.Diamond; s++) {
    deck.push({ r: Rank.Rank2, s });
  }

  // 两张王：`s` 都是 4（Joker），颜色差异由 `r` 区分（`protocol.colorOf`）
  deck.push({ r: Rank.RankBlackJoker, s: Suit.Joker });
  deck.push({ r: Rank.RankRedJoker, s: Suit.Joker });

  return deck;
}

export function shuffleDeck(deck: Card[]): void {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

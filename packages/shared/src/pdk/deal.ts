/**
 * 跑得快发牌与首出（Task 3.1 / spec §5.2 + §5.3）。
 *
 * 发牌：
 *  - 3 人各 16 张；4 人各 12 张；2 人 48 张分 3 份×16，前两份给两家，第三份进 `unusedCards`。
 *  - 随机源可注入（`input.random`）；`testDeck` 给定时**不再洗牌**，按给定顺序连续切份。
 *
 * 首出：
 *  - 每局第一手从红桃 3→4→…→A→2 找第一张在玩家手中的红桃；持有者先出。
 *  - 2 人局扣牌可能包含全部红桃（极端）⇒ 由注入随机源指定。
 */
import { ProtocolError, type Card } from '@fight-the-landlord/protocol';
import { assertPdkDeck, createPdkDeck, PDK_DECK_SIZE } from './deck';
import type { PdkSessionInput } from './types';

/** 首出查找顺序（r；花色恒为红桃 `s = 1`）。3..A 连续，2 是 17。 */
export const HEART_LEAD_ORDER = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17] as const;

/** `dealPdk` 的产物：按座位升序的手牌；2 人局额外返回扣牌。 */
export interface PdkDealResult {
  hands: Card[][];
  /** 2 人局扣下的第三份 16 张；3/4 人局**不出现该键**。 */
  unusedCards?: Card[];
}

function assertPlayers(input: PdkSessionInput): void {
  if (input.playerCount !== 2 && input.playerCount !== 3 && input.playerCount !== 4) {
    throw new ProtocolError(`playerCount must be 2 | 3 | 4, got ${JSON.stringify(input.playerCount)}`);
  }
  if (!Array.isArray(input.players) || input.players.length !== input.playerCount) {
    throw new ProtocolError(
      `players must contain exactly playerCount (${input.playerCount}) entries, got ${
        Array.isArray(input.players) ? input.players.length : JSON.stringify(input.players)
      }`,
    );
  }
  const seats = new Set(input.players.map((p) => p.seat));
  for (let seat = 0; seat < input.playerCount; seat += 1) {
    if (!seats.has(seat)) {
      throw new ProtocolError(
        `players must occupy seats 0..${input.playerCount - 1} (missing ${seat})`,
      );
    }
  }
}

/** Fisher–Yates 的**副本**洗牌（不修改入参）；随机值必须有限。 */
function shuffleWith<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const roll = random();
    if (!Number.isFinite(roll)) {
      throw new ProtocolError(`random() must return a finite number, got ${JSON.stringify(roll)}`);
    }
    const j = Math.min(i, Math.max(0, Math.floor(roll * (i + 1))));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * 发牌（2/3/4 人）。
 *
 * 手牌保持**发牌顺序**（不在本函数排序；视图/客户端展示按需排序）。
 * `testDeck` 校验失败、玩家座位不完整 ⇒ `ProtocolError`。
 */
export function dealPdk(input: PdkSessionInput): PdkDealResult {
  assertPlayers(input);

  let deck: Card[];
  if (input.testDeck !== undefined) {
    assertPdkDeck(input.testDeck);
    // 冻结副本：调用方后续改数组不得影响已发出的手牌。
    deck = input.testDeck.map((c) => ({ ...c }));
  } else {
    deck = shuffleWith(createPdkDeck(), input.random);
  }
  if (deck.length !== PDK_DECK_SIZE) {
    throw new ProtocolError(`pdk deck must contain ${PDK_DECK_SIZE} cards, got ${deck.length}`);
  }

  const perSeat = input.playerCount === 4 ? 12 : 16;
  const hands = Array.from({ length: input.playerCount }, (_, seat) =>
    deck.slice(seat * perSeat, (seat + 1) * perSeat),
  );

  // 2 人局：第三份（第 33..48 张）扣下，永不出站。
  return input.playerCount === 2 ? { hands, unusedCards: deck.slice(32, 48) } : { hands };
}

/**
 * 首出者（spec §5.3）：红桃 3→4→…→A→2 的第一张持有者；都没有（2 人局全被扣）⇒
 * `floor(random() * playerCount)`（夹到 `0..playerCount-1`）。
 */
export function resolveFirstLeader(
  hands: readonly Card[][],
  playerCount: number,
  random: () => number,
): number {
  if (!Array.isArray(hands) || hands.length !== playerCount) {
    throw new ProtocolError(
      `hands must contain exactly playerCount (${playerCount}) hands, got ${
        Array.isArray(hands) ? hands.length : JSON.stringify(hands)
      }`,
    );
  }
  if (playerCount !== 2 && playerCount !== 3 && playerCount !== 4) {
    throw new ProtocolError(`playerCount must be 2 | 3 | 4, got ${JSON.stringify(playerCount)}`);
  }

  for (const rank of HEART_LEAD_ORDER) {
    for (let seat = 0; seat < playerCount; seat += 1) {
      if (hands[seat]!.some((c: Card) => c.r === rank && c.s === 1)) return seat;
    }
  }

  const roll = random();
  if (!Number.isFinite(roll)) {
    throw new ProtocolError(`random() must return a finite number, got ${JSON.stringify(roll)}`);
  }
  return Math.min(playerCount - 1, Math.max(0, Math.floor(roll * playerCount)));
}

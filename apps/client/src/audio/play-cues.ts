/**
 * 牌型 → 播报 cue（spec 2026-10-22 · U5-2/U5-4）。
 *
 * ⚠️ **只做「牌面 → 音效」的纯选择**：`parseHand` 来自 `@fight-the-landlord/protocol`
 * （2026-10-12 出牌提示裁决已放行），这里不判合法性、不判胜负、不重写任何规则。
 *
 * 点数编码（DouZero）：3–14 / 17(=2) / 20(小王) / 30(大王)；素材序号 15 = 2。
 */
import { HandType, parseHand, type Card } from '@fight-the-landlord/protocol';
import type { CueName } from './cues';

const SINGLE_BY_RANK: Record<number, CueName> = {
  3: 'Single3',
  4: 'Single4',
  5: 'Single5',
  6: 'Single6',
  7: 'Single7',
  8: 'Single8',
  9: 'Single9',
  10: 'Single10',
  11: 'Single11',
  12: 'Single12',
  13: 'Single13',
  14: 'Single14',
  17: 'Single15',
  20: 'SingleLittleJoker',
  30: 'SingleBigJoker',
};

const PAIR_BY_RANK: Record<number, CueName> = {
  3: 'Pair3',
  4: 'Pair4',
  5: 'Pair5',
  6: 'Pair6',
  7: 'Pair7',
  8: 'Pair8',
  9: 'Pair9',
  10: 'Pair10',
  11: 'Pair11',
  12: 'Pair12',
  13: 'Pair13',
  14: 'Pair14',
  17: 'Pair15',
};

const TRIO_BY_RANK: Record<number, CueName> = {
  3: 'Trio3',
  4: 'Trio4',
  5: 'Trio5',
  6: 'Trio6',
  7: 'Trio7',
  8: 'Trio8',
  9: 'Trio9',
  10: 'Trio10',
  11: 'Trio11',
  12: 'Trio12',
  13: 'Trio13',
  14: 'Trio14',
  17: 'Trio15',
};

/**
 * 点数 → 单/对/三张 cue（斗地主与跑得快共用）。
 * ⚠️ 显式 `CueName | null`：`noUncheckedIndexedAccess` 未开，直接索引会被推成 `CueName`。
 */
export function cueForSingleRank(r: number): CueName | null {
  return SINGLE_BY_RANK[r] ?? null;
}
export function cueForPairRank(r: number): CueName | null {
  return PAIR_BY_RANK[r] ?? null;
}
export function cueForTrioRank(r: number): CueName | null {
  return TRIO_BY_RANK[r] ?? null;
}

/**
 * 给出牌选一条播报 cue。
 *
 * 空牌 / 非法牌型 / 未知点数 / `parseHand` 抛错 ⇒ `null`（调用方静默）。
 * 绝不抛：音频层不得把牌桌打崩。
 */
export function cueForPlay(cards: Card[]): CueName | null {
  if (!Array.isArray(cards) || cards.length === 0) return null;

  let parsed: ReturnType<typeof parseHand>;
  try {
    parsed = parseHand(cards);
  } catch {
    return null;
  }

  switch (parsed.type) {
    case HandType.Single:
      return cueForSingleRank(parsed.keyRank);
    case HandType.Pair:
      return cueForPairRank(parsed.keyRank);
    case HandType.Trio:
      return cueForTrioRank(parsed.keyRank);
    case HandType.Straight:
      return 'Straight';
    case HandType.PairStraight:
      return 'PairStraight';
    case HandType.Plane:
    case HandType.PlaneWithSingles:
    case HandType.PlaneWithPairs:
      return 'Plane';
    case HandType.TrioWithSingle:
      return 'TrioWithSingle';
    case HandType.TrioWithPair:
      return 'TrioWithPair';
    case HandType.FourWithTwo:
      return 'FourWithTwo';
    case HandType.FourWithTwoPairs:
      return 'FourWithTwoPairs';
    case HandType.Bomb:
      return 'Bomb';
    case HandType.Rocket:
      return 'Rocket';
    default:
      return null;
  }
}

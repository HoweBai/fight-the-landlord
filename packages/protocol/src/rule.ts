/**
 * 牌型解析与大小比较（玩法 §4 / §5）。
 *
 * **从 `packages/shared` 迁到 protocol**（2026-10-12，客户端出牌提示项 ⑤ 裁决）：
 * 客户端是哑终端，但「出牌提示」需要 `parseHand` / `canBeat` / `HandType` 来枚举
 * 合法候选并自检——这些是**纯函数**（只依赖 `Card {r,s}`），放在 protocol 让前端
 * 能从唯一允许的 `@fight-the-landlord/protocol` 入口拿到，避免本地重写规则。
 *
 * ⚠️ 本文件**不依赖** `@fight-the-landlord/shared`（protocol 零依赖红线）；
 * `Rank` 枚举已替换为 DouZero 数值常量（3..14 / 17=2 / 20=小王 / 30=大王），与 codec.ts 同源。
 */
import type { Card } from "./views";

/** DouZero 点数（与 codec.ts 同源，不重复定义语义）。 */
const RANK_2 = 17;
const RANK_BLACK_JOKER = 20;
const RANK_RED_JOKER = 30;

export enum HandType {
  Invalid = 0,
  Single,
  Pair,
  Trio,
  TrioWithSingle,
  TrioWithPair,
  Straight,
  PairStraight,
  Plane,
  PlaneWithSingles,
  PlaneWithPairs,
  Bomb,
  FourWithTwo,
  FourWithTwoPairs,
  Rocket,
}

export const handTypeNames: Record<HandType, string> = {
  [HandType.Single]: "单张",
  [HandType.Pair]: "对子",
  [HandType.Trio]: "三张",
  [HandType.TrioWithSingle]: "三带一",
  [HandType.TrioWithPair]: "三带二",
  [HandType.Straight]: "顺子",
  [HandType.PairStraight]: "连对",
  [HandType.Plane]: "飞机",
  [HandType.PlaneWithSingles]: "飞机带单",
  [HandType.PlaneWithPairs]: "飞机带对",
  [HandType.Bomb]: "炸弹",
  [HandType.FourWithTwo]: "四带二",
  [HandType.FourWithTwoPairs]: "四带两对",
  [HandType.Rocket]: "王炸",
  [HandType.Invalid]: "无效",
};

export interface ParsedHand {
  type: HandType;
  keyRank: number;
  length: number;
  cards: Card[];
}

export interface HandAnalysis {
  counts: Map<number, number>;
  fours: number[];
  trios: number[];
  pairs: number[];
  ones: number[];
}

export function isContinuous(ranks: number[]): boolean {
  if (ranks.length === 0) return false;
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] >= RANK_2) return false;
    if (i > 0 && ranks[i - 1] + 1 !== ranks[i]) return false;
  }
  return true;
}

export function analyzeCards(cards: Card[]): HandAnalysis {
  const counts = new Map<number, number>();
  for (const c of cards) {
    counts.set(c.r, (counts.get(c.r) ?? 0) + 1);
  }
  const fours: number[] = [], trios: number[] = [], pairs: number[] = [], ones: number[] = [];
  for (const [r, count] of counts) {
    if (count === 4) fours.push(r);
    else if (count === 3) trios.push(r);
    else if (count === 2) pairs.push(r);
    else ones.push(r);
  }
  fours.sort((a, b) => a - b);
  trios.sort((a, b) => a - b);
  pairs.sort((a, b) => a - b);
  ones.sort((a, b) => a - b);
  return { counts, fours, trios, pairs, ones };
}

export function parseHand(cards: Card[]): ParsedHand {
  if (cards.length === 0) throw new Error("不能出空牌");
  const a = analyzeCards(cards);

  if (cards.length === 2 && a.counts.get(RANK_BLACK_JOKER) === 1 && a.counts.get(RANK_RED_JOKER) === 1) {
    return { type: HandType.Rocket, keyRank: RANK_RED_JOKER, length: 0, cards };
  }
  if (a.fours.length === 1 && cards.length === 4) {
    return { type: HandType.Bomb, keyRank: a.fours[0], length: 0, cards };
  }
  if (a.fours.length === 1) {
    if (cards.length === 6 && (a.ones.length === 2 || a.pairs.length === 1)) {
      return { type: HandType.FourWithTwo, keyRank: a.fours[0], length: 0, cards };
    }
    if (cards.length === 8 && a.pairs.length === 2) {
      return { type: HandType.FourWithTwoPairs, keyRank: a.fours[0], length: 0, cards };
    }
  }
  if (a.trios.length === 1) {
    if (cards.length === 4 && a.ones.length === 1) {
      return { type: HandType.TrioWithSingle, keyRank: a.trios[0], length: 0, cards };
    }
    if (cards.length === 5 && a.pairs.length === 1) {
      return { type: HandType.TrioWithPair, keyRank: a.trios[0], length: 0, cards };
    }
  }
  if (isContinuous(a.trios) && a.trios.length >= 2) {
    const planeLen = a.trios.length;
    if (planeLen * 3 === cards.length) {
      return { type: HandType.Plane, keyRank: a.trios[0], length: planeLen, cards };
    }
    /**
     * 飞机带单（对齐 DouZero 生成器）：`n` 张翅膀中，每个非主体点数最多 2 张
     * （对子可以当两张单牌用）；不得出现四张同点。
     */
    if (
      planeLen * 4 === cards.length &&
      a.fours.length === 0 &&
      a.ones.length + 2 * a.pairs.length === planeLen
    ) {
      return { type: HandType.PlaneWithSingles, keyRank: a.trios[0], length: planeLen, cards };
    }
    if (planeLen * 5 === cards.length && a.pairs.length === planeLen) {
      return { type: HandType.PlaneWithPairs, keyRank: a.trios[0], length: planeLen, cards };
    }
  }
  /**
   * 4 三张特判（对齐 DouZero 生成器）：恰 4 个三张、12 张牌，其中 3 个连续时，
   * 把连续 3 组当主体、剩下那组三张当 3 张单翼。比较点数 = **主体起点**。
   * 4 组全连续时上面的裸飞机分支已命中，不会到这里。
   */
  if (a.trios.length === 4 && cards.length === 12) {
    if (isContinuous(a.trios.slice(1))) {
      return { type: HandType.PlaneWithSingles, keyRank: a.trios[1], length: 3, cards };
    }
    if (isContinuous(a.trios.slice(0, 3))) {
      return { type: HandType.PlaneWithSingles, keyRank: a.trios[0], length: 3, cards };
    }
  }
  if (isContinuous(a.ones) && a.ones.length === cards.length && cards.length >= 5) {
    return { type: HandType.Straight, keyRank: a.ones[0], length: cards.length, cards };
  }
  if (isContinuous(a.pairs) && a.pairs.length * 2 === cards.length && a.pairs.length >= 3) {
    return { type: HandType.PairStraight, keyRank: a.pairs[0], length: a.pairs.length, cards };
  }
  if (a.counts.size === 1) {
    const r = [...a.counts.keys()][0];
    if (cards.length === 1) return { type: HandType.Single, keyRank: r, length: 0, cards };
    if (cards.length === 2) return { type: HandType.Pair, keyRank: r, length: 0, cards };
    if (cards.length === 3) return { type: HandType.Trio, keyRank: r, length: 0, cards };
  }
  return { type: HandType.Invalid, keyRank: 0, length: 0, cards };
}

export interface BeatTarget {
  type: HandType;
  keyRank: number;
  length: number;
}

export function canBeat(newHand: BeatTarget, lastHand: BeatTarget): boolean {
  if (newHand.type === HandType.Rocket) return true;
  if (lastHand.type === HandType.Rocket) return false;
  if (newHand.type === HandType.Bomb && lastHand.type !== HandType.Bomb) return true;
  if (newHand.type !== lastHand.type) return false;
  const lenTypes = [
    HandType.Straight,
    HandType.PairStraight,
    HandType.Plane,
    HandType.PlaneWithSingles,
    HandType.PlaneWithPairs,
  ];
  if (lenTypes.includes(newHand.type) && newHand.length !== lastHand.length) return false;
  return newHand.keyRank > lastHand.keyRank;
}

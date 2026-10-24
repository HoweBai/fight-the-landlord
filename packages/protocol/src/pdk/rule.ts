/**
 * 跑得快牌型解析与比较（Task 3.2 / spec §5.4）。
 *
 * 类型（`PdkHandType` / `PdkParsedHand`）的**唯一归属**是 `./types.ts`（S0 决策）；
 * 本文件只放纯函数，客户端 hint / shared autoplay / robot bot 共用。
 *
 * 口径摘要：
 *  - 炸弹 = **恰四张同点**；AAA 是裸三张；KKKK 是最大炸弹（黑桃 A 已去掉 ⇒ 四张 A 不存在）。
 *  - 顺子/连对/飞机：3–A（**不含 2**），`keyRank` 一律取**最大点数**（不是斗地主的最小口径）。
 *  - 解析优先级：炸弹 → 四带二 → 飞机（含翅膀）→ 顺子 → 连对 → 三带二 → 三带一 →
 *    裸三张 → 对子 → 单张（避免同一手牌多解）。
 *  - 飞机翅膀：pairs 默认 / singles / both（先 pairs 后 singles）；翅不能与三张同点、
 *    单翅/对翅点数两两不同；**不得拆第 4 个三张**（H17）。
 */
import type { Card } from '../views';
import type { PdkRulesConfig } from './rules';
import { PdkHandType, type PdkParsedHand } from './types';

const INVALID = (): PdkParsedHand => ({ type: PdkHandType.Invalid, keyRank: 0, length: 0 });

/** 牌元形状（解析器不校验牌堆归属；jokers/15/16 不是 pdk 牌值）。 */
function isPdkRankCard(c: Card): boolean {
  return (
    typeof c === 'object' &&
    c !== null &&
    Number.isInteger(c.r) &&
    Number.isInteger(c.s) &&
    c.s >= 0 &&
    c.s <= 3 &&
    c.r >= 3 &&
    c.r <= 17 &&
    c.r !== 15 &&
    c.r !== 16
  );
}

type Counts = Map<number, number>;

function rankCounts(cards: readonly Card[]): Counts | null {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const counts: Counts = new Map();
  for (const card of cards) {
    if (!isPdkRankCard(card)) return null;
    counts.set(card.r, (counts.get(card.r) ?? 0) + 1);
  }
  return counts;
}

const sortedRanks = (counts: Counts): number[] => [...counts.keys()].sort((a, b) => a - b);

/** 升序点数是否连续且最大不超过 `maxRank`（顺子/连对/飞机均以 A=14 为上限，不含 2=17）。 */
function isConsecutive(ranks: readonly number[], maxRank = 14): boolean {
  if (ranks.length === 0) return false;
  if (ranks[ranks.length - 1]! > maxRank) return false;
  for (let i = 1; i < ranks.length; i += 1) {
    if (ranks[i] !== ranks[i - 1]! + 1) return false;
  }
  return true;
}

function rankWithCount(counts: Counts, n: number): number | null {
  for (const [rank, count] of counts) {
    if (count === n) return rank;
  }
  return null;
}

function allCounts(counts: Counts, expected: number): boolean {
  for (const count of counts.values()) {
    if (count !== expected) return false;
  }
  return true;
}

/** 四带二：6 张 = 四张同点 + 2 张带牌（默认不同点单牌；可配置允许对子）。 */
function parseFourWithTwo(counts: Counts, len: number, rules: PdkRulesConfig): PdkParsedHand | null {
  if (len !== 6 || !rules.fourWithTwoEnabled) return null;
  const fours = [...counts].filter(([, count]) => count === 4);
  if (fours.length !== 1) return null;
  const fourRank = fours[0]![0];
  const rest = [...counts].filter(([rank]) => rank !== fourRank);
  const singlesKicker = rest.length === 2 && rest.every(([, count]) => count === 1);
  const pairKicker =
    rules.fourWithTwoPairKickerAllowed && rest.length === 1 && rest[0]![1] === 2;
  if (!singlesKicker && !pairKicker) return null;
  return { type: PdkHandType.FourWithTwo, keyRank: fourRank, length: 0 };
}

/**
 * 飞机（裸 / 带翅膀）。长度先决定 n：
 *  - 裸飞机：`len = 3n`；
 *  - 带对翅：`len = 5n`（3n + 2n）；
 *  - 带单翅：`len = 4n`（3n + n）。
 */
function parseAirplane(counts: Counts, len: number, rules: PdkRulesConfig): PdkParsedHand | null {
  const tryBare = (): PdkParsedHand | null => {
    if (!rules.bareAirplaneEnabled || len % 3 !== 0) return null;
    const n = len / 3;
    if (n < 2) return null;
    for (let start = 3; start + n - 1 <= 14; start += 1) {
      let ok = true;
      for (let i = 0; i < n; i += 1) {
        if ((counts.get(start + i) ?? 0) !== 3) {
          ok = false;
          break;
        }
      }
      if (ok && counts.size === n) {
        return { type: PdkHandType.Airplane, keyRank: start + n - 1, length: n };
      }
    }
    return null;
  };

  const tryWings = (mode: 'pairs' | 'singles'): PdkParsedHand | null => {
    if (rules.airplaneWings !== mode && rules.airplaneWings !== 'both') return null;
    const factor = mode === 'pairs' ? 5 : 4;
    if (len % factor !== 0) return null;
    const n = len / factor;
    if (n < 2) return null;

    for (let start = 3; start + n - 1 <= 14; start += 1) {
      const trioRanks = Array.from({ length: n }, (_, i) => start + i);
      let triosOk = true;
      for (const rank of trioRanks) {
        if ((counts.get(rank) ?? 0) < 3) {
          triosOk = false;
          break;
        }
      }
      if (!triosOk) continue;

      // 扣掉三张；三张同点若还有第 4 张 ⇒ 不能把它当翅膀（H17）。
      const leftover = new Map(counts);
      let sharesTrioRank = false;
      for (const rank of trioRanks) {
        const remaining = (leftover.get(rank) ?? 0) - 3;
        if (remaining > 0) {
          sharesTrioRank = true;
          break;
        }
        leftover.delete(rank);
      }
      if (sharesTrioRank) continue;

      if (leftover.size !== n) continue;
      if (mode === 'pairs') {
        if (!allCounts(leftover, 2)) continue;
        return {
          type: PdkHandType.AirplaneWithWings,
          keyRank: start + n - 1,
          length: n,
          wingMode: 'pairs',
        };
      }
      if (!allCounts(leftover, 1)) continue;
      return {
        type: PdkHandType.AirplaneWithWings,
        keyRank: start + n - 1,
        length: n,
        wingMode: 'singles',
      };
    }
    return null;
  };

  // 优先级：裸飞机 → pairs → singles（`both` 按 spec 先 pairs 后 singles）。
  return (
    tryBare() ??
    (rules.airplaneWings === 'pairs'
      ? tryWings('pairs')
      : rules.airplaneWings === 'singles'
        ? tryWings('singles')
        : (tryWings('pairs') ?? tryWings('singles')))
  );
}

/**
 * 解析一手牌（`rules` 是本局快照；关闭的牌型解析为 `Invalid`）。
 *
 * ⚠️ 只解析**当前选中的牌**，不看整手牌 —— 因此「炸弹可以拆」自然成立。
 */
export function parsePdkHand(cards: Card[], rules: PdkRulesConfig): PdkParsedHand {
  const counts = rankCounts(cards);
  if (!counts) return INVALID();
  const len = cards.length;

  // ① 炸弹：恰四张同点
  if (len === 4 && counts.size === 1) {
    return { type: PdkHandType.Bomb, keyRank: firstRank(counts), length: 4 };
  }

  // ② 四带二（6 张 = 四张 + 2 带牌）
  const fourWithTwo = parseFourWithTwo(counts, len, rules);
  if (fourWithTwo) return fourWithTwo;

  // ③ 飞机（含翅膀）
  const airplane = parseAirplane(counts, len, rules);
  if (airplane) return airplane;

  // ④ 顺子：≥5 张连续单牌（3–A，不含 2）
  if (len >= 5 && counts.size === len && allCounts(counts, 1)) {
    const ranks = sortedRanks(counts);
    if (isConsecutive(ranks)) {
      return { type: PdkHandType.Straight, keyRank: ranks[ranks.length - 1]!, length: len };
    }
  }

  // ⑤ 连对：≥2 个连续对子（3–A，不含 2）
  if (len >= 4 && len % 2 === 0 && counts.size === len / 2 && allCounts(counts, 2)) {
    const ranks = sortedRanks(counts);
    if (isConsecutive(ranks)) {
      return {
        type: PdkHandType.ConsecutivePairs,
        keyRank: ranks[ranks.length - 1]!,
        length: ranks.length,
      };
    }
  }

  // ⑥ 三带二 / 三带一 / 裸三张
  if (len === 5 && counts.size === 2) {
    const trio = rankWithCount(counts, 3);
    const pair = rankWithCount(counts, 2);
    if (trio !== null && pair !== null) {
      return rules.trioWithPairEnabled
        ? { type: PdkHandType.TrioWithPair, keyRank: trio, length: 0 }
        : INVALID();
    }
  }
  if (len === 4 && counts.size === 2) {
    const trio = rankWithCount(counts, 3);
    const single = rankWithCount(counts, 1);
    if (trio !== null && single !== null) {
      return { type: PdkHandType.TrioWithSingle, keyRank: trio, length: 0 };
    }
  }
  if (len === 3 && counts.size === 1) {
    return rules.bareTrioEnabled
      ? { type: PdkHandType.Trio, keyRank: firstRank(counts), length: 0 }
      : INVALID();
  }

  // ⑦ 对子 / 单张
  if (len === 2 && counts.size === 1) {
    return { type: PdkHandType.Pair, keyRank: firstRank(counts), length: 0 };
  }
  if (len === 1) {
    return { type: PdkHandType.Single, keyRank: firstRank(counts), length: 0 };
  }

  return INVALID();
}

function firstRank(counts: Counts): number {
  return counts.keys().next().value as number;
}

/** 该牌型在当前规则快照下是否可出（防御：跨快照/手工构造的比较不生效）。 */
function isShapeAllowed(hand: PdkParsedHand, rules: PdkRulesConfig): boolean {
  switch (hand.type) {
    case PdkHandType.Invalid:
      return false;
    case PdkHandType.Trio:
      return rules.bareTrioEnabled;
    case PdkHandType.TrioWithPair:
      return rules.trioWithPairEnabled;
    case PdkHandType.Airplane:
      return rules.bareAirplaneEnabled;
    case PdkHandType.FourWithTwo:
      return rules.fourWithTwoEnabled;
    case PdkHandType.AirplaneWithWings:
      if (hand.wingMode === 'pairs') {
        return rules.airplaneWings === 'pairs' || rules.airplaneWings === 'both';
      }
      if (hand.wingMode === 'singles') {
        return rules.airplaneWings === 'singles' || rules.airplaneWings === 'both';
      }
      return false;
    default:
      return true;
  }
}

/**
 * `candidate` 能否压过 `target`（spec §5.4 比较口径）。
 *
 * - 炸弹压任何非炸弹；炸弹之间按点数；没有王炸。
 * - 非炸弹须**同牌型、同 length**（顺子张数/连对对数/飞机三张数）；带牌不参与比较。
 * - 飞机带单与飞机带对是不同形状（`wingMode`），互不相压。
 */
export function canBeatPdk(
  candidate: PdkParsedHand,
  target: PdkParsedHand,
  rules: PdkRulesConfig,
): boolean {
  if (!candidate || !target) return false;
  if (candidate.type === PdkHandType.Invalid || target.type === PdkHandType.Invalid) return false;
  if (!isShapeAllowed(candidate, rules) || !isShapeAllowed(target, rules)) return false;

  const candidateBomb = candidate.type === PdkHandType.Bomb;
  const targetBomb = target.type === PdkHandType.Bomb;
  if (candidateBomb || targetBomb) {
    if (!candidateBomb) return false;
    if (!targetBomb) return true;
    return candidate.keyRank > target.keyRank;
  }

  if (candidate.type !== target.type) return false;
  if (candidate.length !== target.length) return false;
  if (candidate.type === PdkHandType.AirplaneWithWings) {
    // 带单 vs 带对不可互压（both 模式下 wingMode 是区分位）。
    if (!candidate.wingMode || candidate.wingMode !== target.wingMode) return false;
  }
  return candidate.keyRank > target.keyRank;
}

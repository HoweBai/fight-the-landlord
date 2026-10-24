/**
 * 跑得快提示（S6.2 / spec D45）。
 *
 * 客户端**不实现规则**：候选牌型与大小全部由 `protocol/pdk/rule` 判定
 *（`parsePdkHand` / `canBeatPdk`）；本文件只做**组合枚举 + 排序**。
 * `rules` 恒取本局服务端快照（`PdkPlayerView.pdkRules`），关闭的牌型不会产出。
 */
import {
  PdkHandType,
  canBeatPdk,
  parsePdkHand,
  type Card,
  type PdkParsedHand,
  type PdkRulesConfig,
} from '@fight-the-landlord/protocol';

const byCard = (a: Card, b: Card): number => a.r - b.r || a.s - b.s;
const cardKey = (c: Card): string => `${c.r},${c.s}`;

/** 一手牌的**张数**（与规则解析结果一一对应；仅用于确定枚举大小）。 */
function handSize(parsed: PdkParsedHand): number {
  switch (parsed.type) {
    case PdkHandType.Single:
      return 1;
    case PdkHandType.Pair:
      return 2;
    case PdkHandType.Trio:
      return 3;
    case PdkHandType.TrioWithSingle:
      return 4;
    case PdkHandType.TrioWithPair:
      return 5;
    case PdkHandType.FourWithTwo:
      return 6;
    case PdkHandType.Straight:
      return parsed.length;
    case PdkHandType.ConsecutivePairs:
      return parsed.length * 2;
    case PdkHandType.Airplane:
      return parsed.length * 3;
    case PdkHandType.AirplaneWithWings:
      return parsed.wingMode === 'pairs' ? parsed.length * 5 : parsed.length * 4;
    case PdkHandType.Bomb:
      return 4;
    default:
      return 0;
  }
}

function combinations(hand: readonly Card[], size: number, visit: (cards: Card[]) => void): void {
  if (size < 1 || size > hand.length) return;
  const picked: Card[] = [];
  const dfs = (start: number, remaining: number): void => {
    if (remaining === 0) {
      visit([...picked]);
      return;
    }
    for (let i = start; i <= hand.length - remaining; i += 1) {
      picked.push(hand[i]!);
      dfs(i + 1, remaining - 1);
      picked.pop();
    }
  };
  dfs(0, size);
}

interface Candidate {
  cards: Card[];
  parsed: PdkParsedHand;
}

/** 候选去重键（同一手牌的不同顺序 / 不同花色选择只保留一份）。 */
const dedupeKey = (cards: readonly Card[]): string => cards.map(cardKey).sort().join('|');

function rankSeq(cards: readonly Card[]): number[] {
  return cards.map((c) => c.r).sort((a, b) => a - b);
}

function compareCandidate(a: Candidate, b: Candidate): number {
  const aBomb = a.parsed.type === PdkHandType.Bomb;
  const bBomb = b.parsed.type === PdkHandType.Bomb;
  if (aBomb !== bBomb) return aBomb ? 1 : -1; // 非炸弹优先（不浪费炸弹）
  if (a.parsed.keyRank !== b.parsed.keyRank) return a.parsed.keyRank - b.parsed.keyRank;
  if (a.cards.length !== b.cards.length) return a.cards.length - b.cards.length;
  const ra = rankSeq(a.cards);
  const rb = rankSeq(b.cards);
  for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
  return 0;
}

/**
 * 枚举提示候选。
 *
 * - `target === null`（首出）：枚举所有常见张数（1–12、15）的组合，保留能被解析成合法牌型的；
 * - 跟牌：只枚举「同型张数」与「炸弹 4 张」两种大小，再按 `canBeatPdk` 过滤。
 *
 * 返回按「非炸弹 → 主键小 → 张数少」排序；**无解 ⇒ `[]`**（页面隐藏/降级提示入口）。
 */
export function suggestPdkPlays(
  hand: readonly Card[],
  target: PdkParsedHand | null,
  rules: PdkRulesConfig,
): Card[][] {
  if (hand.length === 0) return [];
  const sorted = [...hand].sort(byCard);
  const sizes: number[] = [];
  if (target) {
    const size = handSize(target);
    for (const n of [size, 4]) if (n >= 1 && n <= sorted.length && !sizes.includes(n)) sizes.push(n);
  } else {
    for (let n = 1; n <= Math.min(12, sorted.length); n += 1) sizes.push(n);
    if (sorted.length >= 15) sizes.push(15);
  }

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const size of sizes) {
    combinations(sorted, size, (cards) => {
      const parsed = parsePdkHand(cards, rules);
      if (parsed.type === PdkHandType.Invalid) return;
      if (target && !canBeatPdk(parsed, target, rules)) return;
      const key = dedupeKey(cards);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ cards: cards.map((c) => ({ ...c })), parsed });
    });
  }
  candidates.sort(compareCandidate);
  return candidates.map((c) => c.cards);
}

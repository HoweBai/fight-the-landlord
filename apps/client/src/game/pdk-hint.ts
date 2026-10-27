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

interface RankGroup {
  rank: number;
  /** 同点牌按花色升序；枚举时取前 k 张（花色不影响牌型/比较）。 */
  cards: Card[];
}

/** 按点数分组（升序）。 */
function groupByRank(sorted: readonly Card[]): RankGroup[] {
  const groups = new Map<number, Card[]>();
  for (const card of sorted) {
    const at = groups.get(card.r);
    if (at) at.push(card);
    else groups.set(card.r, [card]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rank, cards]) => ({ rank, cards }));
}

/**
 * 枚举**点数多重集**（每个点数取 0..该点张数），而不是任意牌子集。
 *
 * 为什么这样等价且更快：
 *  - 牌型/比较只看点数多重集，同点取哪几张花色对结果无影响 ⇒ 每个多重集取
 *    花色最小的代表即可；
 *  - 枚举量 = Π(count+1)（16 张、点数分布最散时约 2.8 万），远小于
 *    Σ_{k=1..16} C(16,k) ≈ 6.5 万；
 *  - 跟牌仍枚举同一多重集空间，再在叶子按「目标张数 / 炸弹 4 张」过滤；
 *  - 14/16 张组合（7/8 连对、4 连三+4 单）天然包含，不再依赖张数白名单。
 *
 * 候选仍逐手交 `parsePdkHand` 裁决 —— 客户端不实现规则。
 */
function enumerateRankSelections(groups: readonly RankGroup[], visit: (cards: Card[]) => void): void {
  const picked: Card[] = [];
  const dfs = (index: number): void => {
    if (index === groups.length) {
      if (picked.length > 0) visit([...picked]);
      return;
    }
    const group = groups[index]!;
    for (let take = 0; take <= group.cards.length; take += 1) {
      for (let i = 0; i < take; i += 1) picked.push(group.cards[i]!);
      dfs(index + 1);
      for (let i = 0; i < take; i += 1) picked.pop();
    }
  };
  dfs(0);
}

interface Candidate {
  cards: Card[];
  parsed: PdkParsedHand;
}

/** 候选去重键：点数多重集（花色已归一成最小代表）。 */
const dedupeKey = (cards: readonly Card[]): string =>
  cards
    .map((c) => c.r)
    .sort((a, b) => a - b)
    .join(',');

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
 * - `target === null`（首出）：按点数多重集枚举**全部**合法牌型（含 14/16 张）；
 * - 跟牌：只保留「同型张数」与「炸弹 4 张」两种大小，再按 `canBeatPdk` 过滤。
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
  const allowedSizes = target
    ? new Set([handSize(target), 4].filter((n) => n >= 1 && n <= sorted.length))
    : null;

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  enumerateRankSelections(groupByRank(sorted), (cards) => {
    if (allowedSizes && !allowedSizes.has(cards.length)) return;
    const parsed = parsePdkHand(cards, rules);
    if (parsed.type === PdkHandType.Invalid) return;
    if (target && !canBeatPdk(parsed, target, rules)) return;
    const key = dedupeKey(cards);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ cards: cards.map((c) => ({ ...c })), parsed });
  });
  candidates.sort(compareCandidate);
  return candidates.map((c) => c.cards);
}

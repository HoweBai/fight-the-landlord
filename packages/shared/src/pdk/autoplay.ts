/**
 * 跑得快 autoplay（Task 3.5 / spec §5.7）。
 *
 * 超时/托管与规则机器人**共用**这两条策略：
 *  - 首出：`chooseLeadPdk` —— 最小单张（单张恒合法）；
 *  - 跟牌：`findSmallestBeatingPdk` —— 同型同 length 的**最小可压**；无解则取**最小炸弹**
 *    （炸弹可压任何非炸弹）；面对炸弹只能取更大的炸弹；无解返回 `null`（调用方过牌）。
 *
 * 实现方式：只枚举**可能成型的组合大小**（目标同型大小 + 炸弹 4 张），逐个用
 * `parsePdkHand`/`canBeatPdk` 校验 —— 关闭的牌型、翅膀形状、炸弹可拆等口径与
 * 规则解析器**同源**，不在本文件复制规则。
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

/** 首出策略：最小单张（点数、花色升序）。空手牌 ⇒ `[]`。 */
export function chooseLeadPdk(hand: readonly Card[], rules: PdkRulesConfig): Card[] {
  // 单张恒合法；规则快照保留给将来的策略细化（首版只打最小单张，spec §5.7）。
  void rules;
  if (hand.length === 0) return [];
  return [{ ...[...hand].sort(byCard)[0]! }];
}

/** 一手牌在规则下的牌型大小（张数）；用于确定需要枚举的组合大小。 */
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

interface Candidate {
  cards: Card[];
  parsed: PdkParsedHand;
  /** 炸弹候选排在非炸弹之后（同型有解时不得浪费炸弹）。 */
  bomb: boolean;
}

const ranksOf = (cards: readonly Card[]): number[] => cards.map((c) => c.r).sort((a, b) => a - b);
const suitsOf = (cards: readonly Card[]): number[] => [...cards].sort(byCard).map((c) => c.s);

function lexicographicLess(a: readonly number[], b: readonly number[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return a.length < b.length;
}

/** `a` 是否严格优于 `b`：非炸弹优先 → 主键更小 → 点数序列更小 → 花色序列更小。 */
function better(a: Candidate, b: Candidate): boolean {
  if (a.bomb !== b.bomb) return !a.bomb;
  if (a.parsed.keyRank !== b.parsed.keyRank) return a.parsed.keyRank < b.parsed.keyRank;
  const ra = ranksOf(a.cards);
  const rb = ranksOf(b.cards);
  if (lexicographicLess(ra, rb)) return true;
  if (lexicographicLess(rb, ra)) return false;
  return lexicographicLess(suitsOf(a.cards), suitsOf(b.cards));
}

/** 枚举 `hand` 中大小为 `size` 的组合（按排序后的手牌，保证确定性）。 */
function forEachCombination(
  hand: readonly Card[],
  size: number,
  visit: (cards: Card[]) => void,
): void {
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

/**
 * 跟牌策略：从手牌里找能压过 `target` 的**最小**合法组合；无解返回 `null`。
 *
 * - `target.type === Invalid`（无上一手）⇒ 走 `chooseLeadPdk`；
 * - 炸弹可拆：同型组合不会排除四条里的牌；只有**恰好 4 张同点**才解析成炸弹。
 * - 关闭的牌型由 `parsePdkHand`/`canBeatPdk` 过滤，不在此处重复规则。
 */
export function findSmallestBeatingPdk(
  hand: readonly Card[],
  target: PdkParsedHand,
  rules: PdkRulesConfig,
): Card[] | null {
  if (!target || target.type === PdkHandType.Invalid) {
    const lead = chooseLeadPdk(hand, rules);
    return lead.length === 0 ? null : lead;
  }
  if (hand.length === 0) return null;

  const sorted = [...hand].sort(byCard);
  // 可压过目标的组合大小：同型大小；或炸弹（恰 4 张同点）。
  const sizes =
    target.type === PdkHandType.Bomb
      ? [4]
      : [...new Set([handSize(target), 4])].filter(
          (size) => size >= 1 && size <= sorted.length,
        );

  let best: Candidate | null = null;
  for (const size of sizes) {
    forEachCombination(sorted, size, (cards) => {
      const parsed = parsePdkHand(cards, rules);
      if (!canBeatPdk(parsed, target, rules)) return;
      const candidate: Candidate = {
        cards: [...cards].sort(byCard),
        parsed,
        bomb: parsed.type === PdkHandType.Bomb,
      };
      if (best === null || better(candidate, best)) best = candidate;
    });
  }

  return best === null ? null : (best as Candidate).cards.map((c) => ({ ...c }));
}

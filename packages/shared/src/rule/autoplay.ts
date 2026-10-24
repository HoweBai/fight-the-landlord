import type { Card } from '@fight-the-landlord/protocol';
import { Rank } from '../card/card';
import { HandType, ParsedHand, analyzeCards, parseHand, type BeatTarget } from './rule';

/**
 * 规则引擎的**跟牌**实现（玩法 §9.1 的 ①②③，E4/R202）：找出能压过 `opponentHand` 的
 * **最小**合法组合；`null` 表示**无解**（调用方据此 pass）。
 *
 * `target` 的类型是 `ParsedHand | BeatTarget`：实现只用 `type`/`keyRank`/`length` 三个字段，
 * 而**超时路径**（`handlePlayTimeout`）手上只有持久化的 `lastPlayedHand`（没有 `cards`）
 * —— 放宽入参让两条调用方共用这**唯一**的实现（R157：比较字段只读持久化字段，不重新解析）。
 *
 * 实现口径（R202 逐条）：
 *  1. **覆盖全部 14 种牌型**：同型跟牌走 `findSameTypeBeat`（12 型），`Bomb` / `Rocket`
 *     由调用方的兜底段处理；
 *  2. **最小性**：同型取能压过的**最小 keyRank**；带牌（kicker / 翅膀）取**最小**的合法组合；
 *  3. `target.type === Invalid`（首出 / 一墩回到自己）⇒ 返回手牌中**点数最小**的**单张**
 *     （单张永远合法 ⇒ 动作一定可执行；旧实现返回**最大**单张，与玩法 §9.1 相反）；
 *  4. **面对王炸 ⇒ `null`**（玩法 §5 第 1 条：王炸不可被压）；面对炸弹只返回**更大的炸弹**
 *     或**王炸**（不返回「四带二」等四张的其它牌型）；**炸弹不得被拆** —— 四条只在
 *     「当炸弹使用」时被取用（`smallestRankWith` 的 `excludeFours`），绝不当单张/对子/kicker；
 *  5. 返回 `null` 表示无解。
 *
 * ⚠️ 本函数只保证「按玩法 §4 的牌型定义是合法的」；对局的最终裁判仍是 `handlePlayCards`
 * （按 §6.1 全链校验，含「牌在不在手里」与「压不压得过」）。
 */
export function findSmallestBeatingCards(
  playerHand: Card[],
  opponentHand: ParsedHand | BeatTarget,
): Card[] | null {
  // ③ 首出 / 一墩回到自己：打**最小**单张
  if (opponentHand.type === HandType.Invalid) {
    if (playerHand.length === 0) return null;
    const smallest = playerHand.reduce((min, c) => (c.r < min.r ? c : min), playerHand[0]!);
    return [smallest];
  }

  // ④ 王炸不可被压（必须**先于**「我方是王炸」判定，玩法 §5 的两条互斥）
  if (opponentHand.type === HandType.Rocket) return null;

  // ① 同型跟牌
  const sameType = findSameTypeBeat(playerHand, opponentHand);
  if (sameType) return sameType;

  // ④ 炸弹兜底：面对非炸弹牌型，最小的炸弹即可压过；面对炸弹则要更大的炸弹。
  // 四条当炸弹用是优先语义：`analyzeCards` 把四条归入 `a.fours`（不进入 ones/pairs/trios），
  // 因此同型跟牌天然取不到它们 ——「炸弹不得被拆」由此结构性成立。
  const bomb = takeBomb(playerHand, opponentHand.type === HandType.Bomb ? opponentHand.keyRank : 0);
  if (bomb) return bomb;

  // ④ 王炸收尾（能压过除王炸外的一切）
  return takeRocket(playerHand);
}

/** 同型最小可压；无解（或该型由兜底段处理）返回 `null`。 */
function findSameTypeBeat(hand: Card[], opp: ParsedHand | BeatTarget): Card[] | null {
  switch (opp.type) {
    case HandType.Single:
      return takeSingle(hand, opp.keyRank);
    case HandType.Pair:
      return takePair(hand, opp.keyRank);
    case HandType.Trio:
      return takeTrio(hand, opp.keyRank);
    case HandType.TrioWithSingle:
      return takeTrioWithKickers(hand, opp.keyRank, 1);
    case HandType.TrioWithPair:
      return takeTrioWithKickers(hand, opp.keyRank, 2);
    case HandType.Straight:
      return takeRun(hand, opp.keyRank, opp.length, 1);
    case HandType.PairStraight:
      return takeRun(hand, opp.keyRank, opp.length, 2);
    case HandType.Plane:
      return takeRun(hand, opp.keyRank, opp.length, 3);
    case HandType.PlaneWithSingles:
      return takePlaneWithWings(hand, opp.keyRank, opp.length, 1);
    case HandType.PlaneWithPairs:
      return takePlaneWithWings(hand, opp.keyRank, opp.length, 2);
    case HandType.FourWithTwo:
      return takeFourWithKickers(hand, opp.keyRank, 2, false);
    case HandType.FourWithTwoPairs:
      return takeFourWithKickers(hand, opp.keyRank, 2, true);
    default:
      // `Bomb` / `Rocket` / `Invalid`：由调用方的兜底段处理
      return null;
  }
}

// ─── 通用取牌 ─────────────────────────────────────────────────────────

/** `rank → 张数`。 */
function countByRank(cards: Card[]): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const c of cards) counts.set(c.r, (counts.get(c.r) ?? 0) + 1);
  return counts;
}

/** 取指定点数的前 `count` 张。 */
function takeOfRank(hand: Card[], rank: Rank, count: number): Card[] {
  const picked: Card[] = [];
  for (const c of hand) {
    if (c.r === rank) {
      picked.push(c);
      if (picked.length === count) break;
    }
  }
  return picked;
}

/**
 * 手牌里**点数 > keyRank** 且张数 ≥ `count` 的**最小**点数；无解返回 `null`。
 *
 * `excludeFours`（默认 `true`）把张数为 4 的点数**整组排除** —— 这是「炸弹不得被拆」的
 * 机械表达（四条是炸弹，不能当单张/对子/三张使用）。
 */
function smallestRankWith(
  hand: Card[],
  keyRank: number,
  count: number,
  excludeFours = true,
): Rank | null {
  const counts = countByRank(hand);
  let best: Rank | null = null;
  for (const [rank, n] of counts) {
    if (rank <= keyRank) continue;
    if (excludeFours && n === 4) continue;
    if (n < count) continue;
    if (best === null || rank < best) best = rank;
  }
  return best;
}

/** 点数集合里**最小**的 `need` 个点数（可要求每个点数至少 `perRank` 张；排除四条）。 */
function smallestRanks(hand: Card[], need: number, perRank: number, exclude: ReadonlySet<Rank>): Rank[] | null {
  const counts = countByRank(hand);
  const candidates = [...counts.keys()]
    .filter((r) => !exclude.has(r) && counts.get(r)! < 4 && counts.get(r)! >= perRank)
    .sort((a, b) => a - b);
  return candidates.length >= need ? candidates.slice(0, need) : null;
}

// ─── 逐型实现 ─────────────────────────────────────────────────────────

function takeSingle(hand: Card[], keyRank: number): Card[] | null {
  const rank = smallestRankWith(hand, keyRank, 1);
  return rank === null ? null : takeOfRank(hand, rank, 1);
}

function takePair(hand: Card[], keyRank: number): Card[] | null {
  const rank = smallestRankWith(hand, keyRank, 2);
  return rank === null ? null : takeOfRank(hand, rank, 2);
}

function takeTrio(hand: Card[], keyRank: number): Card[] | null {
  const rank = smallestRankWith(hand, keyRank, 3);
  return rank === null ? null : takeOfRank(hand, rank, 3);
}

/**
 * 三带一 / 三带二：主体取**最小可压**的三张（张数为 3 或 4 的点数都算「有三张」），
 * 带牌从**去掉主体**的余牌里取最小的合法组合（三带一 ⇒ 1 张单牌；三带二 ⇒ 1 个对子）。
 *
 * 若最小主体的点数凑不出带牌，则**依次试更大的主体**（不能因为一个组合不成型就宣布无解）。
 */
function takeTrioWithKickers(hand: Card[], keyRank: number, kickerSize: 1 | 2): Card[] | null {
  const counts = countByRank(hand);
  const trioRanks = [...counts.keys()]
    .filter((r) => r > keyRank && counts.get(r)! >= 3)
    .sort((a, b) => a - b);

  for (const rank of trioRanks) {
    const body = takeOfRank(hand, rank, 3);
    const rest = hand.filter((c) => !body.includes(c));
    // ⚠️ 主体点数**必须排除**：主体点数有 4 张时（四条），`rest` 里还剩第 4 张，
    // 若它被选成带牌，同一点数就有 4 张 ⇒ `parseHand` 得到 `Invalid`（非法动作）。
    const kickers =
      kickerSize === 1
        ? takeKickers(rest, 1, 0, new Set([rank]))
        : takeKickers(rest, 0, 1, new Set([rank]));
    if (kickers === null) continue;
    return [...body, ...kickers];
  }
  return null;
}

/**
 * 带牌（kicker / 翅膀）：`singles` 张**互不同点数**的单牌，或 `pairs` 个**互不同点数**的对子，取**最小**。
 *
 * `exclude` 是**主体点数集合**：翅膀不得与主体同点数（玩法 §4.2 要点 2 —— 同点数会让该点数
 * 变成 4 张，牌型随之不成立）。⚠️ 这一条**不能只靠「张数 = 4 的点数整组跳过」**：主体只取走
 * 3 张时，第 4 张仍留在 `rest` 里，而它在 `rest` 里的张数是 **1**（不是 4），会被当成合法带牌
 * 选进来 ⇒ 结果同点数 4 张 ⇒ `parseHand` 判为 `Invalid`（实测形态，协调者 2026-09-15 反例）。
 *
 * **不得拆炸弹**（`rest` 里张数为 4 的点数同样整组跳过，R202-4）；点数升序 ⇒ 取到的就是最小组合。
 */
function takeKickers(rest: Card[], singles: number, pairs: number, exclude: ReadonlySet<Rank>): Card[] | null {
  if (pairs > 0) {
    const ranks = smallestRanks(rest, pairs, 2, exclude);
    if (ranks === null) return null;
    return ranks.flatMap((r) => takeOfRank(rest, r, 2));
  }
  const ranks = smallestRanks(rest, singles, 1, exclude);
  if (ranks === null) return null;
  return ranks.flatMap((r) => takeOfRank(rest, r, 1));
}

/**
 * 顺子 / 连对 / 飞机主体：`groupLen` 为每个点数的张数（1 / 2 / 3），
 * `length` 为**组数**（顺子的 `length` 单位是张数，与 `groupLen === 1` 同值，玩法 §4.1）。
 *
 * 主体必须**连续**且不含 2 与王（`r < Rank2`），起点取**最小**的可压值。
 */
function takeRun(hand: Card[], keyRank: number, length: number, groupLen: 1 | 2 | 3): Card[] | null {
  if (length < MIN_RUN_LENGTH[groupLen]) return null;
  const counts = countByRank(hand);
  for (let start = Rank.Rank3; start + length - 1 < Rank.Rank2; start++) {
    if (start <= keyRank) continue;
    // **整段**都必须齐（`groupLen` 张且不依赖炸弹）：只查起点会让 5 张顺子去跟 6 张顺子
    // —— 那是**非法跟牌**（玩法 §5 第 5 条：长度必须相同）。
    let ok = true;
    for (let r = start; r < start + length; r++) {
      const n = counts.get(r as Rank) ?? 0;
      if (n < groupLen || (groupLen === 1 && n === 4)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const cards: Card[] = [];
    for (let r = start; r < start + length; r++) cards.push(...takeOfRank(hand, r as Rank, groupLen));
    return cards;
  }
  return null;
}

/** 各主体的**最小**组数（玩法 §4：顺子 ≥5 张、连对 ≥3 组、飞机 ≥2 组）。 */
const MIN_RUN_LENGTH: Record<1 | 2 | 3, number> = { 1: 5, 2: 3, 3: 2 };

/** 飞机带单 / 飞机带对：主体取最小可压的连续三张，翅膀取**去掉主体后**最小的合法组合。 */
function takePlaneWithWings(hand: Card[], keyRank: number, planeLen: number, wingSize: 1 | 2): Card[] | null {
  if (planeLen < MIN_RUN_LENGTH[3]) return null;
  const counts = countByRank(hand);
  for (let start = Rank.Rank3; start + planeLen - 1 < Rank.Rank2; start++) {
    if (start <= keyRank) continue;
    let ok = true;
    for (let r = start; r < start + planeLen; r++) {
      if ((counts.get(r as Rank) ?? 0) < 3) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const body: Card[] = [];
    const bodyRanks = new Set<Rank>();
    for (let r = start; r < start + planeLen; r++) {
      body.push(...takeOfRank(hand, r as Rank, 3));
      bodyRanks.add(r as Rank);
    }
    const rest = hand.filter((c) => !body.includes(c));
    // ⚠️ `bodyRanks` **必须**传给翅膀：主体点数有 4 张时第 4 张留在 `rest` 里，
    // 若被选成翅膀 ⇒ 同点数 4 张 ⇒ `parseHand` 得到 `Invalid`（协调者 2026-09-15 反例）。
    if (wingSize === 1) {
      const wings = takePlaneSinglesWings(rest, planeLen, bodyRanks);
      if (wings === null) continue; // 起点可行但翅膀凑不齐 ⇒ 试更大的主体
      const candidate = [...body, ...wings];
      /**
       * 自检（与 hint 同纪律）：4 组连续三张 + 其中一组的翅膀会被解析成**裸飞机**，
       * 不是飞机带单；此外特判会按「主体起点」重新归类。候选必须恰好是
       * PlaneWithSingles / 同长度 / 同起点才算数。
       */
      const parsed = parseHand(candidate);
      if (
        parsed.type !== HandType.PlaneWithSingles ||
        parsed.length !== planeLen ||
        parsed.keyRank !== start
      ) {
        continue;
      }
      return candidate;
    }
    const wings = takeKickers(rest, 0, planeLen, bodyRanks);
    if (wings === null) continue;
    return [...body, ...wings];
  }
  return null;
}

/**
 * 飞机带单的翅膀（对齐 DouZero 生成器）：恰 `count` 张，非主体点数每点可取 1 或 2 张
 * （对子可以当两张单牌）；手牌中的四条不拆。返回**最小**合法组合：
 *  ① 对子数少的优先（全单张 → 混合 → 全对子）；
 *  ② 同对子数下，按实际牌点升序逐张比较。
 * 正常组合无解且 `count === 3` 时，允许用一组三张当翅膀（4 三张特判）。
 */
function takePlaneSinglesWings(
  rest: Card[],
  count: number,
  exclude: ReadonlySet<Rank>,
): Card[] | null {
  const counts = countByRank(rest);
  const candidates = [...counts.keys()]
    .filter((r) => !exclude.has(r) && counts.get(r)! >= 1 && counts.get(r)! < 4)
    .sort((a, b) => a - b);

  type Pick = { rank: Rank; take: 1 | 2 };
  const picked: Pick[] = [];
  let best: Pick[] | null = null;

  const rankList = (picks: Pick[]): number[] => {
    const out: number[] = [];
    for (const p of picks) for (let i = 0; i < p.take; i += 1) out.push(p.rank);
    return out;
  };
  const better = (a: Pick[], b: Pick[] | null): boolean => {
    if (b === null) return true;
    const pairsA = a.filter((p) => p.take === 2).length;
    const pairsB = b.filter((p) => p.take === 2).length;
    if (pairsA !== pairsB) return pairsA < pairsB;
    const ca = rankList(a);
    const cb = rankList(b);
    for (let i = 0; i < Math.min(ca.length, cb.length); i += 1) {
      if (ca[i] !== cb[i]) return ca[i]! < cb[i]!;
    }
    return false;
  };

  const dfs = (index: number, remaining: number): void => {
    if (remaining === 0) {
      if (better(picked, best)) best = [...picked];
      return;
    }
    if (index >= candidates.length) return;
    const rank = candidates[index]!;
    dfs(index + 1, remaining);
    picked.push({ rank, take: 1 });
    dfs(index + 1, remaining - 1);
    picked.pop();
    if (remaining >= 2 && counts.get(rank)! >= 2) {
      picked.push({ rank, take: 2 });
      dfs(index + 1, remaining - 2);
      picked.pop();
    }
  };
  dfs(0, count);

  // ⚠️ `best` 只在 `dfs` 闭包里赋值；TS 的控制流分析看不见闭包写入，
  // 会把它窄化成 `never` ⇒ 显式断言回声明类型。
  const chosen = best as Pick[] | null;
  if (chosen !== null) {
    const wings: Card[] = [];
    for (const p of chosen) wings.push(...takeOfRank(rest, p.rank, p.take));
    return wings;
  }

  if (count === 3) {
    const trioRank = candidates.find((r) => counts.get(r)! >= 3);
    if (trioRank !== undefined) return takeOfRank(rest, trioRank, 3);
  }
  return null;
}

/**
 * 四带二（`asPairs=false`：2 张单牌**或** 1 个对子）/ 四带两对（`asPairs=true`：2 个对子）。
 *
 * 四张主体必须是**炸弹**（点数 4 张）且大于 `keyRank`；带牌取最小合法组合（不拆更大的炸弹）。
 */
function takeFourWithKickers(hand: Card[], keyRank: number, count: number, asPairs: boolean): Card[] | null {
  const counts = countByRank(hand);
  const fourRanks = [...counts.keys()].filter((r) => counts.get(r) === 4).sort((a, b) => a - b);

  for (const rank of fourRanks) {
    if (rank <= keyRank) continue;
    const body = takeOfRank(hand, rank, 4);
    const rest = hand.filter((c) => !body.includes(c));
    // 主体是四条 ⇒ 它在 `rest` 里张数为 0，已被 `smallestRanks` 的 `>= perRank` 过滤掉；
    // 仍显式排除以表达「翅膀不得与主体同点数」这条规格（玩法 §4.2 要点 2）。
    const excludeBody = new Set<Rank>([rank]);
    if (asPairs) {
      // 四带两对：**恰好 2 个**对子（`count` 是对子的**个数**，不是张数）
      const pairs = takeKickers(rest, 0, count, excludeBody);
      if (pairs === null) continue;
      return [...body, ...pairs];
    }
    // 四带二：2 张单牌**或** 1 个对子（两者同点数 ⇒ 张数与 `count` 相同，故这一条可以合并判定）
    const wings = takeKickers(rest, 0, 1, excludeBody) ?? takeKickers(rest, count, 0, excludeBody);
    if (wings === null || wings.length !== count) continue;
    return [...body, ...wings];
  }
  return null;
}

/** 最小炸弹：点数 > `minKeyRank` 的最小四条。`minKeyRank <= 0` 表示「任意炸弹都可」。 */
function takeBomb(hand: Card[], minKeyRank: number): Card[] | null {
  const a = analyzeCards(hand);
  const rank = a.fours.find((r) => r > minKeyRank);
  return rank === undefined ? null : takeOfRank(hand, rank, 4);
}

/** 王炸（小王 + 大王）。 */
function takeRocket(hand: Card[]): Card[] | null {
  const a = analyzeCards(hand);
  if (a.counts.get(Rank.RankBlackJoker) !== 1 || a.counts.get(Rank.RankRedJoker) !== 1) return null;
  return [
    hand.find((c) => c.r === Rank.RankBlackJoker)!,
    hand.find((c) => c.r === Rank.RankRedJoker)!,
  ];
}

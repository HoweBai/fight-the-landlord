/**
 * 项 ⑤：出牌提示（客户端纯枚举 + protocol 规则自检）。
 *
 * **职责边界**：
 *  - 本文件**只做组合枚举**（从手牌里挑出若干张），**不做规则判断**；
 *  - 每张候选是否合法 / 能否压过目标，**全部委托 `protocol.parseHand` / `protocol.canBeat`**
 *    （source-boundary ⑤ 闸：禁本地实现，只能从 protocol 导入）；
 *  - 提示结果是「一组可出的牌」，**不代替用户出牌**——用户点了才发。
 *
 * **算法**：按牌型分组枚举候选（单张 / 对子 / 三张 / 炸弹 / 王炸 / 顺子…），
 * 同型取**最小**能压过目标的，再按「同型升序 → 炸弹 → 王炸」排序。
 * 20 张手牌候选数 < 100，parseHand+canBeat 自检 < 5ms。
 */
import type { Card, RecentAction } from "@fight-the-landlord/protocol";
import { canBeat, HandType, parseHand, type BeatTarget, type ParsedHand } from "@fight-the-landlord/protocol";

/** 跟牌目标：解析后的牌型（type/keyRank/length）。`null` 表示「我是首出，无目标」。 */
export type BeatTargetView = BeatTarget | null;

/**
 * 从 recentActions 里**推出跟牌目标**。
 *
 * 规则：取窗口里**最后一条 `cards !== null`** 的动作；若该动作的座位是我自己
 * （我刚出的牌，现在轮到别人跟 / 或新一轮我首出）⇒ 返回 `null`（无目标）。
 *
 * ⚠️ 固有限制：窗口只有 2，且「不出」占一手 ⇒ 以下场景目标可能判错：
 *  - 我出、A 过、B 过 ⇒ 窗口最后非 null 是「我出的」⇒ 正确返回 null；
 *  - A 出、B 过、我出 ⇒ 窗口最后非 null 是「我出的」⇒ 正确返回 null（我又该首出了）；
 *  这两种正好是「我该首出」的情形，与 `null` 语义一致。
 */
export function buildBeatTarget(
  recentActions: readonly RecentAction[],
  mySeat: number,
): BeatTargetView {
  // 从后往前找第一条非 null
  for (let i = recentActions.length - 1; i >= 0; i--) {
    const a = recentActions[i]!;
    if (!a.cards) continue;
    if (a.seat === mySeat) return null; // 最后一手是我出的 ⇒ 我首出
    return parseHand(a.cards);
  }
  return null; // 窗口里全是 pass 或空 ⇒ 首出
}

/** 候选提示：一组可出的牌 + 它的牌型信息。 */
export interface HintCandidate {
  cards: Card[];
  parsed: ParsedHand;
}

/**
 * 从手牌里枚举**能压过目标**的候选（目标为 null 时枚举所有合法出牌）。
 *
 * 返回顺序：同型按 keyRank 升序（最小的先给），炸弹在同型之后，王炸最后。
 * 每个候选都经 `parseHand` + `canBeat` 自检（非法 / 压不过的丢弃）。
 */
export function suggestPlays(hand: readonly Card[], target: BeatTargetView): HintCandidate[] {
  const counts = new Map<number, Card[]>();
  for (const c of hand) {
    const arr = counts.get(c.r) ?? [];
    arr.push(c);
    counts.set(c.r, arr);
  }
  const ranks = [...counts.keys()].sort((a, b) => a - b);

  const candidates: HintCandidate[] = [];
  const tryPush = (cards: Card[]): void => {
    if (cards.length === 0) return;
    let parsed: ParsedHand;
    try {
      parsed = parseHand(cards);
    } catch {
      return;
    }
    if (parsed.type === HandType.Invalid) return;
    if (target && !canBeat(parsed, target)) return;
    candidates.push({ cards, parsed });
  };

  // 单张 / 对子 / 三张
  for (const r of ranks) {
    const arr = counts.get(r)!;
    tryPush([arr[0]!]);
    if (arr.length >= 2) tryPush([arr[0]!, arr[1]!]);
    if (arr.length >= 3) tryPush([arr[0]!, arr[1]!, arr[2]!]);
  }

  // 炸弹（四张）
  for (const r of ranks) {
    const arr = counts.get(r)!;
    if (arr.length === 4) tryPush([...arr]);
  }

  // 王炸
  const smallJoker = hand.find((c) => c.r === 20);
  const bigJoker = hand.find((c) => c.r === 30);
  if (smallJoker && bigJoker) tryPush([smallJoker, bigJoker]);

  // 顺子（5+ 连续单张，不含 2/王）
  const straightRanks = ranks.filter((r) => r >= 3 && r <= 14);
  for (let i = 0; i < straightRanks.length; i++) {
    const run: Card[] = [];
    let cur = straightRanks[i]!;
    while (counts.has(cur)) {
      run.push(counts.get(cur)![0]!);
      cur++;
    }
    if (run.length >= 5) {
      // 枚举所有长度 ≥5 的连续子段
      for (let len = 5; len <= run.length; len++) {
        for (let start = 0; start + len <= run.length; start++) {
          tryPush(run.slice(start, start + len));
        }
      }
    }
  }

  // 排序：先按牌型优先级（同型 < 炸弹 < 王炸），同型按 keyRank 升序
  const typePriority = (t: HandType): number => {
    if (t === HandType.Rocket) return 3;
    if (t === HandType.Bomb) return 2;
    return 1;
  };
  candidates.sort((a, b) => {
    const pa = typePriority(a.parsed.type);
    const pb = typePriority(b.parsed.type);
    if (pa !== pb) return pa - pb;
    return a.parsed.keyRank - b.parsed.keyRank;
  });

  return candidates;
}

/**
 * 穷尽型**存在性**判定：手牌里是否存在**至少一手**能压过目标的牌。
 *
 * 用于动作行「要不起」保守隐藏：确凿无压制时才返回 `false`（隐藏出牌/提示），
 * 枚举不到 / 结构不确定的情形**一律返回 `true`**（保守放行，永不剥夺出牌入口）。
 *
 * 与 `suggestPlays` 的关系：后者的候选枚举只覆盖单/对/三/炸弹/王炸/顺子，
 * **不能**拿它当「要不起」判据（手里有更大三带一会被误判为压不过）；
 * 本函数按 `target.type` 穷尽枚举**同型**候选（含三带一/三带二/连对/飞机带翼/
 * 四带二/四带两对），外加炸弹/王炸越级路径。
 *
 * 纪律（source-boundary ⑤）：这里**只组合候选牌**；候选合不合法、能不能压，
 * 全部经 `parseHand` + `canBeat` 自检，客户端不重写任何规则。
 *
 * 翅膀选取：飞机带单的翅膀可以是单张或对子（对子当两张单牌），还可能是一组
 * 三张（4 三张特判）——因此必须枚举组合，不能只取一个代表；每个候选仍交给
 * `parseHand` + `canBeat` 自检，客户端不重写任何规则。
 */
export function hasBeatablePlay(
  hand: readonly Card[],
  target: BeatTargetView,
): boolean {
  // 我首出（无目标）⇒ 永远能出，按钮全显。
  if (!target) return true;

  const groups = new Map<number, Card[]>();
  for (const card of hand) {
    const arr = groups.get(card.r) ?? [];
    arr.push(card);
    groups.set(card.r, arr);
  }
  const ranks = [...groups.keys()].sort((a, b) => a - b);

  /** 组合候选自检：牌型解析 + 能否压过，全部委托 protocol（不在本地判规则）。 */
  const beats = (cards: Card[]): boolean => {
    let parsed: ParsedHand;
    try {
      parsed = parseHand(cards);
    } catch {
      return false;
    }
    if (parsed.type === HandType.Invalid) return false;
    return canBeat(parsed, target);
  };

  /** 取点数 r 的前 n 张（调用方已确认该点数张数够）。 */
  const take = (r: number, n: number): Card[] => groups.get(r)!.slice(0, n);

  /**
   * 选 k 个**互不相同**、且不属于主体点数 `bodyRanks` 的翅膀点数，每点至少
   * 有余量取 `need` 张；贪心取最小的 k 个（代表组合，见函数注释）。取不到 ⇒ null。
   */
  const pickWingRanks = (
    bodyRanks: readonly number[],
    need: 1 | 2,
    k: number,
  ): number[] | null => {
    const blocked = new Set(bodyRanks);
    const picked: number[] = [];
    for (const r of ranks) {
      if (blocked.has(r)) continue;
      if (groups.get(r)!.length >= need) picked.push(r);
      if (picked.length === k) return picked;
    }
    return null;
  };

  /**
   * 越级路径：炸弹（四张同点）与王炸。能否越级**全由 `canBeat` 自检**
   *（炸弹压非炸弹、王炸通吃、王炸不可压 —— 这些规则一个字节不抄到本地）。
   */
  const wildcardBeater = (): boolean => {
    for (const r of ranks) {
      const arr = groups.get(r)!;
      if (arr.length === 4 && beats([...arr])) return true;
    }
    const smallJoker = hand.find((c) => c.r === 20);
    const bigJoker = hand.find((c) => c.r === 30);
    if (smallJoker && bigJoker && beats([smallJoker, bigJoker])) return true;
    return false;
  };

  /** 枚举区间 3..14 内长度为 len 的连续点数窗（顺子/连对/飞机主体，2 与王不入主体）。 */
  const continuousWindows = (len: number): number[][] => {
    const windows: number[][] = [];
    for (let start = 3; start + len - 1 <= 14; start++) {
      const windowRanks: number[] = [];
      for (let r = start; r < start + len; r++) windowRanks.push(r);
      windows.push(windowRanks);
    }
    return windows;
  };

  /** 主体窗口每点至少 need 张 ⇒ 拼出候选牌。 */
  const windowCards = (
    windowRanks: readonly number[],
    need: number,
  ): Card[] | null => {
    const cards: Card[] = [];
    for (const r of windowRanks) {
      const arr = groups.get(r);
      if (!arr || arr.length < need) return null;
      cards.push(...arr.slice(0, need));
    }
    return cards;
  };

  /**
   * 飞机带单的翅膀组合（与规则引擎同语义）：恰 `need` 张，非主体点数每点取 1 或 2 张；
   * 正常组合无解且 `need === 3` 时，允许用一组三张当翅膀（4 三张特判）。
   * 每个候选都经 `beats()` 自检（含「四组连续三张会解析成裸飞机」这类边界）。
   */
  const tryPlaneSinglesWings = (
    body: Card[],
    bodyRanks: readonly number[],
    need: number,
  ): boolean => {
    const blocked = new Set(bodyRanks);
    const candidates = ranks.filter(
      (r) => !blocked.has(r) && groups.get(r)!.length >= 1 && groups.get(r)!.length < 4,
    );
    const picked: Array<{ r: number; take: 1 | 2 }> = [];
    const dfs = (index: number, remaining: number): boolean => {
      if (remaining === 0) {
        const wings = picked.flatMap((p) => take(p.r, p.take));
        return beats([...body, ...wings]);
      }
      if (index >= candidates.length) return false;
      const r = candidates[index]!;
      if (dfs(index + 1, remaining)) return true;
      picked.push({ r, take: 1 });
      if (dfs(index + 1, remaining - 1)) return true;
      picked.pop();
      if (remaining >= 2 && groups.get(r)!.length >= 2) {
        picked.push({ r, take: 2 });
        if (dfs(index + 1, remaining - 2)) return true;
        picked.pop();
      }
      return false;
    };
    if (dfs(0, need)) return true;
    if (need === 3) {
      for (const r of candidates) {
        if (groups.get(r)!.length === 3 && beats([...body, ...take(r, 3)])) return true;
      }
    }
    return false;
  };

  switch (target.type) {
    // 单张：任一张牌都是候选（大小交给自检）。
    case HandType.Single:
      for (const card of hand) if (beats([card])) return true;
      return wildcardBeater();

    // 对子 / 三张：每个点数取 2 / 3 张。
    case HandType.Pair:
      for (const r of ranks) {
        if (groups.get(r)!.length >= 2 && beats(take(r, 2))) return true;
      }
      return wildcardBeater();

    case HandType.Trio:
      for (const r of ranks) {
        if (groups.get(r)!.length >= 3 && beats(take(r, 3))) return true;
      }
      return wildcardBeater();

    // 三带一：三张主体 + 1 张**异点**翅膀。
    case HandType.TrioWithSingle:
      for (const r of ranks) {
        if (groups.get(r)!.length < 3) continue;
        const wing = pickWingRanks([r], 1, 1);
        if (wing && beats([...take(r, 3), ...take(wing[0]!, 1)])) return true;
      }
      return wildcardBeater();

    // 三带二：三张主体 + 1 对**异点**翅膀。
    case HandType.TrioWithPair:
      for (const r of ranks) {
        if (groups.get(r)!.length < 3) continue;
        const wing = pickWingRanks([r], 2, 1);
        if (wing && beats([...take(r, 3), ...take(wing[0]!, 2)])) return true;
      }
      return wildcardBeater();

    // 顺子：等长连续单张窗（长度不同压不过，由 canBeat 自检兜底）。
    case HandType.Straight: {
      const len = target.length;
      // parseHand 只可能产出 5..12 张顺子；超出即枚举盲区 ⇒ 保守放行。
      if (len < 5 || len > 12) return true;
      for (const w of continuousWindows(len)) {
        const cards = windowCards(w, 1);
        if (cards && beats(cards)) return true;
      }
      return wildcardBeater();
    }

    // 连对：等长连续对子窗（≥3 对）。
    case HandType.PairStraight: {
      const len = target.length;
      if (len < 3 || len > 10) return true;
      for (const w of continuousWindows(len)) {
        const cards = windowCards(w, 2);
        if (cards && beats(cards)) return true;
      }
      return wildcardBeater();
    }

    // 飞机（裸）：等长连续三张窗（≥2 节）。
    case HandType.Plane: {
      const len = target.length;
      if (len < 2 || len > 12) return true;
      for (const w of continuousWindows(len)) {
        const cards = windowCards(w, 3);
        if (cards && beats(cards)) return true;
      }
      return wildcardBeater();
    }

    // 飞机带单：连续三张主体 + len 张翅膀（每点 1 或 2 张；含 4 三张特判）。
    case HandType.PlaneWithSingles: {
      const len = target.length;
      if (len < 2 || len > 12) return true;
      for (const w of continuousWindows(len)) {
        const body = windowCards(w, 3);
        if (body && tryPlaneSinglesWings(body, w, len)) return true;
      }
      return wildcardBeater();
    }

    // 飞机带对：连续三张主体 + len 个异点对翼。
    case HandType.PlaneWithPairs: {
      const len = target.length;
      if (len < 2 || len > 12) return true;
      for (const w of continuousWindows(len)) {
        const body = windowCards(w, 3);
        if (!body) continue;
        const wingRanks = pickWingRanks(w, 2, len);
        if (!wingRanks) continue;
        const candidate = [...body];
        for (const wr of wingRanks) candidate.push(...take(wr, 2));
        if (beats(candidate)) return true;
      }
      return wildcardBeater();
    }

    // 炸弹：同型更大的炸弹 + 王炸，都走越级枚举 + 自检。
    case HandType.Bomb:
      return wildcardBeater();

    // 四带二：四张主体 +（两张异点单翼 **或** 一对异点翅膀）。
    case HandType.FourWithTwo:
      for (const r of ranks) {
        if (groups.get(r)!.length !== 4) continue;
        const body = take(r, 4);
        const singleWings = pickWingRanks([r], 1, 2);
        if (singleWings) {
          const candidate = [
            ...body,
            ...take(singleWings[0]!, 1),
            ...take(singleWings[1]!, 1),
          ];
          if (beats(candidate)) return true;
        }
        const pairWing = pickWingRanks([r], 2, 1);
        if (pairWing && beats([...body, ...take(pairWing[0]!, 2)])) return true;
      }
      return wildcardBeater();

    // 四带两对：四张主体 + 两对互不相同的异点翅膀。
    case HandType.FourWithTwoPairs:
      for (const r of ranks) {
        if (groups.get(r)!.length !== 4) continue;
        const wingRanks = pickWingRanks([r], 2, 2);
        if (!wingRanks) continue;
        const candidate = [...take(r, 4)];
        for (const wr of wingRanks) candidate.push(...take(wr, 2));
        if (beats(candidate)) return true;
      }
      return wildcardBeater();

    // 王炸：除王炸外的任何候选都会被 canBeat 否决；自身持王炸（单副牌下与目标
    // 同时出现是不可达状态）的结论也交给自检，不在本地写「王炸最大」这条规则。
    case HandType.Rocket:
      return wildcardBeater();

    // Invalid 等 protocol 未覆盖 / 未来新增牌型：枚举盲区 ⇒ 保守放行。
    default:
      return true;
  }
}

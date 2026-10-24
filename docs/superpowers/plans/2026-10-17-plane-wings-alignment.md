# 斗地主规则对齐 DouZero 生成器 · 实施计划 v1.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让玩家规则支持 DouZero 生成器实际产出的两种飞机带单形态：对子/混合翅膀，以及 4 三张特判。

**架构：** `parseHand` 是唯一真源；`findSmallestBeatingCards`（规则引擎）与客户端 `hasBeatablePlay`（提示）同步支持新形态，且每个候选仍交回 `parseHand`/`canBeat` 自检。

**技术栈：** TypeScript · vitest · Vue 3 (uni-app)。

## Global Constraints

- 上游唯一：`docs/superpowers/specs/2026-10-17-plane-wings-alignment-design.md`。
- 每次改动一个提交；提交信息结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个改动必须同时有测试；交付前跑通受影响包的测试与 lint。
- **不新增依赖**。
- 规则唯一真源 = `packages/protocol/src/rule.ts`；`shared`/`client` 不得复制规则判定，只能组合候选后调用 `parseHand`/`canBeat`。
- 4 三张特判的比较点数 = **主体起点**（不是 DouZero 过滤器的「最大三张」）。
- **不支持**：两个炸弹作四带两对、`3333+4` 当三带二、特判携带多余单牌、四张同点作翅膀。

---

## 文件结构总览

```
修改
  packages/protocol/src/rule.ts                  # 解析规则（唯一真源）
  packages/shared/src/rule/rule.test.ts          # parseHand 用例
  packages/shared/src/rule/autoplay.ts           # 规则引擎（最小可压）
  packages/shared/src/rule/autoplay.test.ts      # 引擎用例
  apps/client/src/game/hint.ts                   # hasBeatablePlay
  apps/client/test/hint.test.ts                  # 提示用例（含一条翻面）
  apps/client/test/hint-crosscheck.test.ts       # 固定目标补一条
  docs/games/doudizhu.md                         # 规则文档
  docs/design.md                                 # 偏差说明
```

---

### Task 1: protocol — `parseHand` 支持对子翅膀与 4 三张特判

**Files:**
- Modify: `packages/protocol/src/rule.ts:124-135`
- Test: `packages/shared/src/rule/rule.test.ts`

**Interfaces:**
- Produces: `parseHand(cards)` 对 `333444+55` 返回 `PlaneWithSingles`（len 2, key 3）；对 `333444555+777` 返回 `PlaneWithSingles`（len 3, key 3）。

- [ ] **Step 1: 写失败测试**

在 `packages/shared/src/rule/rule.test.ts` 末尾追加：

```ts
describe('parseHand - 飞机带单翅膀与 4 三张特判（DouZero 生成器对齐）', () => {
  it('飞机带单：对子可以当两张单翼', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5,
    ));
    expect(result.type).toBe(HandType.PlaneWithSingles);
    expect(result.length).toBe(2);
    expect(result.keyRank).toBe(Rank.Rank3);
  });

  it('飞机带单：主体之外 1 单 + 1 对 = 3 张翅膀（长度 3）', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank7, Rank.Rank7, Rank.Rank8,
    ));
    expect(result.type).toBe(HandType.PlaneWithSingles);
    expect(result.length).toBe(3);
    expect(result.keyRank).toBe(Rank.Rank3);
  });

  it('4 三张特判：三连飞机 + 另一组三张当翅膀', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank7, Rank.Rank7, Rank.Rank7,
    ));
    expect(result.type).toBe(HandType.PlaneWithSingles);
    expect(result.length).toBe(3);
    expect(result.keyRank).toBe(Rank.Rank3);
  });

  it('4 三张特判：连续段在低位时按主体起点比较', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank7, Rank.Rank7, Rank.Rank7,
    ));
    expect(result.type).toBe(HandType.PlaneWithSingles);
    expect(result.length).toBe(3);
    expect(result.keyRank).toBe(Rank.Rank5);
  });

  it('4 组三张全连续 ⇒ 仍然是裸飞机（长度 4）', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
    ));
    expect(result.type).toBe(HandType.Plane);
    expect(result.length).toBe(4);
  });

  it('反例：没有 3 组连续主体 ⇒ Invalid', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank7, Rank.Rank7, Rank.Rank7,
    ));
    expect(result.type).toBe(HandType.Invalid);
  });

  it('反例：四张同点不能当翅膀', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5,
    ));
    expect(result.type).toBe(HandType.Invalid);
  });

  it('反例：两个炸弹仍不认作四带两对', () => {
    const result = parseHand(makeCards(
      Rank.Rank3, Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4, Rank.Rank4,
    ));
    expect(result.type).toBe(HandType.Invalid);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @fight-the-landlord/shared exec vitest run src/rule/rule.test.ts
```

预期：FAIL —— `333444+55` 当前返回 `Invalid`；特判用例也失败。

- [ ] **Step 3: 实现**

`packages/protocol/src/rule.ts` 的飞机分支改为：

```ts
  if (isContinuous(a.trios) && a.trios.length >= 2) {
    const planeLen = a.trios.length;
    if (planeLen * 3 === cards.length) {
      return { type: HandType.Plane, keyRank: a.trios[0], length: planeLen, cards };
    }
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @fight-the-landlord/shared exec vitest run src/rule/rule.test.ts
pnpm --filter @fight-the-landlord/protocol run lint
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/rule.ts packages/shared/src/rule/rule.test.ts
git commit -m "feat(rule): 飞机带单支持对子翅膀与 4 三张特判

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: shared — 规则引擎支持新翅膀形态

**Files:**
- Modify: `packages/shared/src/rule/autoplay.ts:238-268`
- Test: `packages/shared/src/rule/autoplay.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseHand`。
- Produces: `findSmallestBeatingCards` 能返回对子/混合翅膀、以及非四连的 4 三张特判。

- [ ] **Step 1: 写失败测试**

在 `packages/shared/src/rule/autoplay.test.ts` 的边界 describe 之前追加：

```ts
describe('findSmallestBeatingCards：DouZero 生成器对齐的新翅膀形态', () => {
  it('飞机带单：只有对子能当两张翅膀时也能压', () => {
    const target = parseHand(hand(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank6,
    ));
    const got = findSmallestBeatingCards(
      hand(
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank9, Rank.Rank9,
      ),
      target,
    );
    expect(ranksOf(got)).toEqual(expectedRanks([
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank9, Rank.Rank9,
    ]));
  });

  it('飞机带单：单张 + 对子混合翅膀', () => {
    const target = parseHand(hand(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank7, Rank.Rank8,
    ));
    const got = findSmallestBeatingCards(
      hand(
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank7, Rank.Rank7, Rank.Rank7,
        Rank.Rank9, Rank.Rank9, Rank.Rank10,
      ),
      target,
    );
    // 主体 555666777；全单张只有 9、10 两个点数（不够 3 张）⇒ 只能 99 + 10
    expect(ranksOf(got)).toEqual(expectedRanks([
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank7, Rank.Rank7, Rank.Rank7,
      Rank.Rank9, Rank.Rank9, Rank.Rank10,
    ]));
  });

  it('4 三张特判：非连续的第 4 组三张可当翅膀', () => {
    const target = parseHand(hand(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank7, Rank.Rank8,
    ));
    const got = findSmallestBeatingCards(
      hand(
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank9, Rank.Rank9, Rank.Rank9,
      ),
      target,
    );
    expect(ranksOf(got)).toEqual(expectedRanks([
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank6, Rank.Rank6,
      Rank.Rank9, Rank.Rank9, Rank.Rank9,
    ]));
  });

  it('4 组三张全连续 ⇒ 不能当长度 3 的飞机带单（会解析成裸飞机）', () => {
    const target = parseHand(hand(
      Rank.Rank3, Rank.Rank3, Rank.Rank3,
      Rank.Rank4, Rank.Rank4, Rank.Rank4,
      Rank.Rank5, Rank.Rank5, Rank.Rank5,
      Rank.Rank6, Rank.Rank7, Rank.Rank8,
    ));
    const got = findSmallestBeatingCards(
      hand(
        Rank.Rank4, Rank.Rank4, Rank.Rank4,
        Rank.Rank5, Rank.Rank5, Rank.Rank5,
        Rank.Rank6, Rank.Rank6, Rank.Rank6,
        Rank.Rank7, Rank.Rank7, Rank.Rank7,
      ),
      target,
    );
    expect(got).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @fight-the-landlord/shared exec vitest run src/rule/autoplay.test.ts
```

预期：FAIL —— 对子/混合翅膀与特判都返回 `null`。

- [ ] **Step 3: 实现**

`packages/shared/src/rule/autoplay.ts`：

1. 顶部 import 加 `parseHand`：

```ts
import { HandType, ParsedHand, analyzeCards, parseHand, type BeatTarget } from './rule';
```

2. 在 `takePlaneWithWings` 之前新增：

```ts
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

  if (best !== null) return best.flatMap((p) => takeOfRank(rest, p.rank, p.take));

  if (count === 3) {
    const trioRank = candidates.find((r) => counts.get(r)! >= 3);
    if (trioRank !== undefined) return takeOfRank(rest, trioRank, 3);
  }
  return null;
}
```

3. `takePlaneWithWings` 的翅膀分支改为：

```ts
    const rest = hand.filter((c) => !body.includes(c));
    if (wingSize === 1) {
      const wings = takePlaneSinglesWings(rest, planeLen, bodyRanks);
      if (wings === null) continue;
      const candidate = [...body, ...wings];
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @fight-the-landlord/shared exec vitest run src/rule/autoplay.test.ts src/rule/rule.test.ts
pnpm --filter @fight-the-landlord/shared run lint
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/rule/autoplay.ts packages/shared/src/rule/autoplay.test.ts
git commit -m "feat(rule-engine): 支持飞机带单对子翅膀与 4 三张特判

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: client — `hasBeatablePlay` 同步新形态

**Files:**
- Modify: `apps/client/src/game/hint.ts:312-326`
- Test: `apps/client/test/hint.test.ts:212-240`
- Test: `apps/client/test/hint-crosscheck.test.ts:126-138`

**Interfaces:**
- Consumes: Task 1 的 `parseHand`。
- Produces: `hasBeatablePlay` 对只有对子/混合翅膀或特判能压的手牌返回 `true`。

- [ ] **Step 1: 写失败/翻面测试**

`apps/client/test/hint.test.ts` 的“飞机带单”用例中，把用例标题与这条断言一起改：

```ts
  it("飞机带单：主体 + 等量翅膀；单翼可含 2/王，对子可当两张单翼，缺翼不行", () => {
```

```ts
    expect(
      hasBeatablePlay([c(7), c(7), c(7), c(8), c(8), c(8), c(9), c(9)], t),
      "同点两张可以当两张单翼（对齐 DouZero 生成器）",
    ).toBe(true);
```

并追加：

```ts
  it("飞机带单：4 三张特判（非连续的第 4 组三张当翅膀）", () => {
    const t = targetOf(
      c(3), c(3), c(3), c(4), c(4), c(4), c(5), c(5), c(5),
      c(6), c(7), c(8),
    );
    expect(
      hasBeatablePlay(
        [c(4), c(4), c(4), c(5), c(5), c(5), c(6), c(6), c(6), c(9), c(9), c(9)],
        t,
      ),
      "444555666 + 999 是合法的飞机带单（特判）",
    ).toBe(true);
  });

  it("飞机带单：4 组三张全连续时不能当长度 3 的飞机带单", () => {
    const t = targetOf(
      c(3), c(3), c(3), c(4), c(4), c(4), c(5), c(5), c(5),
      c(6), c(7), c(8),
    );
    expect(
      hasBeatablePlay(
        [c(4), c(4), c(4), c(5), c(5), c(5), c(6), c(6), c(6), c(7), c(7), c(7)],
        t,
      ),
      "444555666777 会被解析成裸飞机（长度 4），压不过长度 3 的飞机带单",
    ).toBe(false);
  });
```

`apps/client/test/hint-crosscheck.test.ts` 的 `fixedTargets` 增加一条：

```ts
      [card(3, 0), card(3, 1), card(3, 2), card(4, 0), card(4, 1), card(4, 2), card(8, 0), card(8, 1)], // 飞机带单（对子翅膀）
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/hint.test.ts test/hint-crosscheck.test.ts
```

预期：FAIL —— 翻面断言仍为 `false`；特判用例为 `false`。

- [ ] **Step 3: 实现**

`apps/client/src/game/hint.ts` 的 `hasBeatablePlay` 内，在 `windowCards` 之后新增：

```ts
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
```

`PlaneWithSingles` 分支替换为：

```ts
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
```

同时更新函数头注中“翅膀选取只需一个代表组合”的段落（第 148-150 行），改为说明对子/单张翅膀会影响存在性，必须枚举。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/hint.test.ts test/hint-crosscheck.test.ts test/table-*.test.ts
pnpm --filter @fight-the-landlord/client run lint
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/game/hint.ts apps/client/test/hint.test.ts apps/client/test/hint-crosscheck.test.ts
git commit -m "feat(client): 出牌提示支持飞机带单对子翅膀与 4 三张特判

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 文档与全量回归

**Files:**
- Modify: `docs/games/doudizhu.md:184-226`
- Modify: `docs/design.md:2230`
- Modify: `docs/superpowers/plans/deviation-ledger.md`（如存在相关登记）

- [ ] **Step 1: 更新玩法文档**

`docs/games/doudizhu.md`：

- 牌型表“飞机带单”行改为：

```markdown
| 飞机带单 | 飞机主体 + `n` 张翅膀（每个非主体点数最多 2 张，可含对子） | 三张组数 ×4 | 最小三张点数 | **三张组数** |
```

- §4.2 的翅膀表“飞机带单 的翅膀”行改为：

```markdown
| 飞机带单 的翅膀 | 允许为 `2` 或王；`n` 张翅膀中，每个非主体点数最多 2 张（对子可当两张单牌）；不得出 4 张同点 |
```

- 规则要点第 4 条改为：

```markdown
4. 翅膀张数不足或结构不符为非法牌型，返回 `13006`；**4 三张特判**（恰 4 个三张、其中 3 个连续时，剩下那组三张当翅膀）合法，比较点数取**主体起点**；
```

- 变更记录末尾追加：

```markdown
> **v1.2（2026-10-17）**：对齐 DouZero 生成器 —— 飞机带单允许对子/混合翅膀，并支持 4 三张特判；`3333+4444` 的四带两对与检测器怪癖仍**不支持**。
```

- 文末 `[已实现]` 段更新为当前 `rule.ts` 的行为，并删除“`333444 + 55` 非法”的旧示例。

- [ ] **Step 2: 更新偏差说明**

`docs/design.md:2230` 那段改为：

```markdown
> 原记录为「飞机翅膀完全未校验」。玩法规格 `docs/games/doudizhu.md` §4.2 已由**严格派**改为**宽松派**（带牌一律允许 `2` 与王），并进一步对齐 DouZero 生成器（飞机带单允许对子/混合翅膀 + 4 三张特判），`rule.ts` 的行为与规格一致，**不再是偏差**。
```

- [ ] **Step 3: 文档闸与全量回归**

```bash
pnpm --filter @fight-the-landlord/protocol test
pnpm --filter @fight-the-landlord/shared test
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/game-service test
pnpm --filter @fight-the-landlord/robot-service test
pnpm --filter @fight-the-landlord/protocol run lint
pnpm --filter @fight-the-landlord/shared run lint
pnpm --filter @fight-the-landlord/client run lint
```

预期：全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add docs/games/doudizhu.md docs/design.md docs/superpowers/plans/deviation-ledger.md
git commit -m "docs: 飞机带单翅膀规则对齐 DouZero 生成器

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 最终验证

- [ ] 受影响包全量测试 + lint（见 Task 4 Step 3）。
- [ ] `git status` 干净，`git log --oneline` 每个任务一条提交。

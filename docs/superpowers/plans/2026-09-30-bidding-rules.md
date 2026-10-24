# 片① 「叫抢规则」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把叫抢规则从「座位 0 先叫 + 恰好 3 次决策」改成「随机座位先叫 + 一次反抢（决策数上界 4）」，并让机器人在叫抢期恒 pass。

**Architecture:** 改动集中在 `packages/shared/src/ddz/`（纯函数状态机）—— 新增两个**内部**字段（`firstCaller` / `antiRobGranted`）与一个**可注入的随机源参数**，出站视图形状**不变**。其余包只是跟随：protocol 放宽出站闸、robot-service 删掉叫抢决策、game-service 注入随机源 + 迁移老会话、conformance 补新分支场景、客户端只需作废一段过期论证。

**Tech Stack:** TypeScript（strict + `noUnusedLocals`/`noUnusedParameters`/`noEmitOnError`）· NestJS · vitest · pnpm workspace + turbo。

**规格**：`docs/superpowers/specs/2026-09-30-bidding-rules-design.md`（v4，已过四轮审查）。**本计划中 §N 的引用都指该规格。**

---

## Global Constraints

- **判据只增不减**：不得删除或弱化既有断言；因语义变化必须改的断言在任务里**显式列出并说明理由**。
- **每次改动一个 commit**（CLAUDE.md）；提交信息结尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 🔴 **`firstCaller` / `antiRobGranted` 是内部字段，永不出站**；`PlayerView.bidPhase` 的键集**不得**变化。
- 🔴 **除 §7.1 的老会话迁移外，任何位置都不得读 `decisions` 做判定**（`docs/games/doudizhu.md:107`）。
- 🔴 **`BID_MULTIPLIER_CAP` 的数值 8 不变**（反抢那一抢**同样 ×2** —— 每次声称无条件 `min(m × 2, 8)`，**任何路径都不越过 8** ⇒ `{1,2,4,8}` 值域不变）。
  > ⚠️ **清洗轮订正（2026-09-30）**：本括注原写「4 次声称时第 4 次因 cap 不再加分」—— 机制表述**错**（只对「前 3 拍已 3 次声称」成立；前 3 拍 2 次声称时反抢那一抢把 4 升到 8）；**结论（数值 8 不变、值域 `{1,2,4,8}`、「不许顺手改成 16」）不变**。依据：`bid.ts:70` 每次声称无条件 `Math.min(m * 2, BID_MULTIPLIER_CAP)`。
- 🔴 **难度体系在本片不重建**（片② 的「按档换模型」负责）；本片只删除 `bot.player.ts` 里已无消费者的叫抢逻辑。
- 验证命令统一用 `pnpm --filter <包名> exec vitest run <文件>`；全量门禁 `pnpm run ci`（六阶段）。
- 涉及**测试夹具**的改动：只改夹具的**注入方式**，不改用例的语义断言（除非该断言确实因新规则失效）。

---

## 文件结构

| 文件 | 职责 | 本片动它做什么 |
|---|---|---|
| `packages/shared/src/ddz/types.ts:80-93` | `GameSession.bidPhase` 的形状 | 加两个内部字段 |
| `packages/shared/src/ddz/game.ts` | 会话构造 + 发牌 | `createSession` 加 `random`，起始座位随机 |
| `packages/shared/src/ddz/bid.ts` | **叫抢状态机（本片核心）** | 反抢判据 + 流局重摇 + 注释作废 |
| `packages/protocol/src/validate.ts:172-174` | 出站硬闸 | `decisions` 上界 3 → 4 |
| `packages/protocol/src/views.ts:121-122,129` | 契约注释 | 值域与上界 |
| `packages/robot-service/src/robot/bot.player.ts` | 机器人决策 | 删叫抢分支与三个死符号 |
| `packages/game-service/src/game/game.service.ts` | 会话驱动 + 加载 | 注入随机源（4 处）+ 老会话迁移 |
| `packages/game-service/test/view.builder.test.ts` | 视图判据 | 补字面量字段 + **新增子层键集穷尽判据** |
| `tools/conformance/src/slices/slice-11-robot-system.ts` | 在线判据 | 新增「2 声称」场景 + 订正过期注释 |
| `apps/client/src/pages/table/table.vue` | 牌桌视图 | 作废「不可达」论证（+ 量具决定是否加护栏） |
| `docs/games/doudizhu.md`、`docs/design.md` | **规则唯一来源** | 同步新规则 |

---

### Task 1: 新字段落地 + 全仓编译恢复 + 起始座位可注入

**Files:**
- Modify: `packages/shared/src/ddz/types.ts:80-93`
- Modify: `packages/shared/src/ddz/game.ts:17-47`
- Modify: `packages/shared/src/ddz/features.test.ts:43-52`
- Modify: `packages/shared/src/ddz/types.test.ts:47-56`
- Modify: `packages/game-service/test/view.builder.test.ts:32-61`
- Modify: `packages/game-service/test/game.robot.test.ts:40`（夹具里的 `bidPhase` 字面量，若有）
- Test: `packages/shared/src/ddz/game.test.ts`（新建，若不存在则加到 `bid.test.ts` 末尾）

**Interfaces:**
- Produces: `createSession(roomCode: string, playerIds: string[], random?: () => number): GameSession`
- Produces: `GameSession['bidPhase']` 新增 `firstCaller: number`（`-1` = 本轮无人声称）、`antiRobGranted: boolean`
- 后续任务依赖：Task 2 读写这两个字段；Task 5 给 game-service 的调用点传 `random`。

> ⚠️ 两个字段设为**必填** ⇒ 全仓**手写 `bidPhase` 字面量**的测试会 `tsc` 失败。本任务必须在同一步里把它们补上，否则树停在编译不过的状态。

- [ ] **Step 1: 写失败判据（起始座位可注入）**

在 `packages/shared/src/ddz/game.test.ts` 新建（若已有该文件则追加 describe 块）：

```ts
import { describe, it, expect } from 'vitest';
import { createSession } from './game';
import { dealCards } from './game';

describe('createSession 的随机起始座位（片① R1）', () => {
  it('传 () => 0 ⇒ 座位 0 先叫', () => {
    const s = dealCards(createSession('R', ['u0', 'u1', 'u2'], () => 0));
    expect(s.bidPhase.currentBidder).toBe(0);
  });

  it('传 () => 0.9 ⇒ 座位 2 先叫（不是恒 0）', () => {
    const s = dealCards(createSession('R', ['u0', 'u1', 'u2'], () => 0.9));
    expect(s.bidPhase.currentBidder).toBe(2);
  });

  it('新会话的两个新字段有确定初值', () => {
    const s = createSession('R', ['u0', 'u1', 'u2'], () => 0);
    expect(s.bidPhase.firstCaller).toBe(-1);
    expect(s.bidPhase.antiRobGranted).toBe(false);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm --filter @fight-the-landlord/shared exec vitest run src/ddz/game.test.ts`
Expected: FAIL —— `createSession` 只接受 2 个参数（TS2554），且 `firstCaller` 不存在。

- [ ] **Step 3: 改类型（`types.ts:80-93`）**

在 `decisions: BidDecision[];` 之后、`};` 之前加：

```ts
    /**
     * 🔴 片① R2：本轮**第一条 `grab=true`** 的座位；本轮无人声称则 `-1`。
     *
     * 它是「反抢权」的判据之一（§4.1 的 `landlordCandidate !== firstCaller` ⟺ ≥2 人声称）。
     * ⚠️ **内部字段，永不出站** —— `PlayerView.bidPhase` 不含它（§5.4）。
     * ⚠️ 每轮开始时归 `-1`（`createSession` / `resetBidding` 两处都要写）。
     */
    firstCaller: number;
    /**
     * 🔴 片① R2：反抢是否**已派发**（本轮一次性）。
     *
     * 它让「轮次结束」判据对**决策计数单调**：`grabActions >= (antiRobGranted ? 4 : 3)`。
     * 没有它，反抢者一「不抢」会让判据恒真 ⇒ 叫抢永不终止（§4.2 的 ⚠️②）。
     * ⚠️ **内部字段，永不出站**。
     */
    antiRobGranted: boolean;
```

- [ ] **Step 4: 改 `game.ts` 的 `createSession`**

```ts
/**
 * 建立会话。`random` 是**可注入的随机源**（照 `BotPlayer.random` 的既有范式），
 * 默认 `Math.random` ⇒ 生产行为不变，测试可传常量函数获得确定性。
 *
 * ⚠️ 片① R1：它决定**叫抢的起始座位**（不再是写死的 0）。`dealCards` 会**保留**
 * 这个值（它只重置 `bidPhase` 之外的东西；见 `dealCards` 的实现），所以在这里摇一次即可。
 */
export function createSession(
  roomCode: string,
  playerIds: string[],
  random: () => number = Math.random,
): GameSession {
```

并把 `bidPhase` 字面量改成：

```ts
    bidPhase: {
      currentBidder: Math.floor(random() * 3),
      landlordCaller: -1,
      landlordCandidate: -1,
      bidPasses: 0,
      grabActions: 0,
      bidMultiplier: 1,
      redealCount: 0,
      decisions: [],
      firstCaller: -1,
      antiRobGranted: false,
    },
```

- [ ] **Step 5: 补两处 shared 侧的手写字面量（`tsc` 必需）**

`packages/shared/src/ddz/features.test.ts:43-52` 与 `packages/shared/src/ddz/types.test.ts:47-56` 里的 `bidPhase: { … }` 各补两行：

```ts
      firstCaller: -1,
      antiRobGranted: false,
```

- [ ] **Step 6: 补 game-service 侧的手写字面量（**CI 阶段 2/6 才会红，`pnpm build` 抓不到**）**

`packages/game-service/test/view.builder.test.ts:52-61` 的 `bidPhase: { … }` 同样补两行。
⚠️ 该文件 `:33` 有显式类型标注 `const base: GameSession = {…}` ⇒ 缺字段是 **TS2739**；
它在 `tsconfig.test.json` 的 include 内（`lint` 跑 `tsc --noEmit -p tsconfig.test.json`），
而**不在**包的 `tsconfig.json`（只 include `src/**`）⇒ `pnpm build` **看不见它**。

- [ ] **Step 7: 跑判据 + 全仓 lint**

Run: `pnpm --filter @fight-the-landlord/shared exec vitest run src/ddz/game.test.ts`
Expected: PASS（3 条）
Run: `pnpm run ci`
Expected: 阶段 1/2/3/5/6 全过；**阶段 4（test）会有唯一一处红：`packages/game-service` 的 14 条**，
且红数**浮动**（起始座位随机 ⇒ 1/3 概率过）—— 那是**规格 §6.2 明文预期**的 R1 连带项，
修复归属 **Task 6**（它 Consumes Task 5 的注入点）。
⚠️ **Task 1 单独不可能绿**（Task 5 的 TDD RED 入口要求 `service.random` 先不存在 ⇒ `TS2339`）
⚠️ 若阶段 2/6 红，那**才是**漏了手写字面量 ——
`grep -rn "landlordCandidate:" packages apps tools | grep -v node_modules` 逐个核（只改 `GameSession` 侧，`PlayerView` 侧不动）。
（2026-09-30 订正：原文写「六阶段全过」，与计划自己的 Task 5→6 排序矛盾 —— 实现者指出，已改。）

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/ddz/types.ts packages/shared/src/ddz/game.ts \
        packages/shared/src/ddz/game.test.ts packages/shared/src/ddz/features.test.ts \
        packages/shared/src/ddz/types.test.ts packages/game-service/test/view.builder.test.ts
git commit -m "feat(ddz): 叫抢起始座位可注入 + firstCaller/antiRobGranted 内部字段（片① R1，规格 §5.1）"
```

---

### Task 2: 反抢判据重构（本片核心）

**Files:**
- Modify: `packages/shared/src/ddz/bid.ts`（`:6-11` 注释、`:20` 注释、`:48-84` 判据、`:134-153` `resetBidding`、`:59` 注释）
- Test: `packages/shared/src/ddz/bid.test.ts`（新增真值表判据块）

**Interfaces:**
- Consumes: Task 1 的 `firstCaller` / `antiRobGranted`
- Produces: `handleBid(session, playerId, bid, random?: () => number): GameSession`
- Produces: `resetBidding` 变成 `resetBidding(session, random)`（**模块私有**，不导出）

- [ ] **Step 1: 写真值表判据（8 组合 + 反抢两出口 + 终止性）**

在 `packages/shared/src/ddz/bid.test.ts` 追加：

```ts
/**
 * 片① R2 的真值表判据（规格 §3）。
 * 记号：`b(i)` = 第 i 位决策者「抢」，`p(i)` = 「不抢」。决策顺序恒为 s0→s1→s2。
 * ⚠️ 一律传 `() => 0` 让起始座位确定（Task 1 的可注入随机源）。
 */
describe('片① R2：反抢真值表', () => {
  const start = () => dealCards(createSession('ROOM1', ['u0', 'u1', 'u2'], () => 0));

  /** 走完一串决策；每步断言「轮到的是谁」以防派发错人（§4.2 的 ⚠️①）。 */
  function run(s: GameSession, seq: Array<boolean | null>): GameSession {
    let cur = s;
    for (const bid of seq) {
      if (cur.state !== GameState.Bidding) return cur; // 已收口，剩余 seq 忽略
      const seat = cur.bidPhase.currentBidder;
      expect(seat, '不得把行动者指到 -1 或不存在的座位').toBeGreaterThanOrEqual(0);
      cur = handleBid(cur, `u${seat}`, bid === true, () => 0);
    }
    return cur;
  }

  it('#1 全不叫 ⇒ 流局重发（不进入反抢）', () => {
    const after = run(start(), [false, false, false]);
    expect(after.state).toBe(GameState.Bidding); // 重发后仍 bidding
    expect(after.bidPhase.grabActions).toBe(0);  // resetBidding 归零
    expect(after.bidPhase.firstCaller).toBe(-1);
    expect(after.bidPhase.antiRobGranted).toBe(false);
  });

  it('#2 叫/不叫/不叫 ⇒ 座位 0 当地主、倍数 2', () => {
    const after = run(start(), [true, false, false]);
    expect(after.state).toBe(GameState.Playing);
    expect(after.players[0]!.isLandlord).toBe(true);
    expect(after.bidPhase.bidMultiplier).toBe(2);
  });

  it('#3 不叫/叫/不叫 ⇒ 座位 1 当地主（反抢权归「首次声称者」s1，但首=末 ⇒ 不派发）', () => {
    const after = run(start(), [false, true, false]);
    expect(after.state).toBe(GameState.Playing);
    expect(after.players[1]!.isLandlord).toBe(true);
  });

  it('#4 不叫/叫/叫 ⇒ 反抢者 = s1；他抢 ⇒ 他当地主', () => {
    const after = run(start(), [false, true, true]);
    // 前 3 拍后应当仍在 bidding，且行动者被指到 s1
    const mid = run(start(), [false, true, true]);
    expect(mid.state).toBe(GameState.Bidding);
    expect(mid.bidPhase.currentBidder).toBe(1);
    expect(mid.bidPhase.antiRobGranted).toBe(true);
    const done = handleBid(mid, 'u1', true, () => 0);
    expect(done.state).toBe(GameState.Playing);
    expect(done.players[1]!.isLandlord).toBe(true);
  });

  it('#4′ 不叫/叫/叫 ⇒ 反抢者**不抢** ⇒ 末位声称者 s2 当地主（且本轮必须结束）', () => {
    const mid = run(start(), [false, true, true]);
    const done = handleBid(mid, 'u1', false, () => 0);
    expect(done.state).toBe(GameState.Playing);
    expect(done.players[2]!.isLandlord).toBe(true);
  });

  it('#5 叫/叫/不叫 ⇒ 反抢者 = s0', () => {
    const mid = run(start(), [true, true, false]);
    expect(mid.bidPhase.currentBidder).toBe(0);
    expect(mid.bidPhase.antiRobGranted).toBe(true);
  });

  it('#6 叫/不叫/叫 ⇒ 反抢者 = s0', () => {
    const mid = run(start(), [true, false, true]);
    expect(mid.bidPhase.currentBidder).toBe(0);
  });

  it('#7 叫/叫/叫 ⇒ 反抢者 = s0；他抢 ⇒ 倍数仍 8（第 4 次声称不贡献）', () => {
    const mid = run(start(), [true, true, true]);
    expect(mid.bidPhase.currentBidder).toBe(0);
    const done = handleBid(mid, 'u0', true, () => 0);
    expect(done.players[0]!.isLandlord).toBe(true);
    expect(done.bidPhase.bidMultiplier).toBe(8);
  });

  it('#8 不叫/不叫/叫 ⇒ 座位 2 当地主', () => {
    const after = run(start(), [false, false, true]);
    expect(after.state).toBe(GameState.Playing);
    expect(after.players[2]!.isLandlord).toBe(true);
  });

  it('🔴 终止性负例：反抢者「不抢」⇒ 本轮**必须**结束、不得再派发反抢', () => {
    const mid = run(start(), [true, true, false]);
    const done = handleBid(mid, 'u0', false, () => 0);
    expect(done.state).toBe(GameState.Playing);
    expect(done.bidPhase.grabActions).toBe(4);
  });
});
```

> ⚠️ **清洗轮订正（2026-09-30）**：上面代码块（计划副本）里 `#7` 标题的括注「（第 4 次声称不贡献）」是机制陈述错误的**副本** ——
> 真身 `bid.test.ts` 的 `#7` 标题已改准为「（前 3 拍已 3 次声称 ⇒ 8 保持不变）」（断言值一字未动），并另增用例
> 「🔴 反抢那一抢**会**加分（前 3 拍 2 次声称 ⇒ 4 → 8）—— 修「第 4 次不贡献」这个错陈述」。本代码块保留为计划原样。

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm --filter @fight-the-landlord/shared exec vitest run src/ddz/bid.test.ts`
Expected: FAIL —— `#4`/`#4′`/`#5`/`#6`/`#7`/终止性负例全红（旧实现在第 3 拍就 `finalizeBidding` 了）。

- [ ] **Step 3: 改 `bid.ts:6-11` 与 `:20` 的注释**

`:6-11` 的 `BID_MULTIPLIER_CAP` docblock 里「将来若允许反抢（多轮），第一个要改的就是这里」改成：

```ts
 * **必须显式写出上限**：它是「**一轮最多 4 次声称**」这一前提的机械表达
 * （片① R2 起允许**一次**反抢 ⇒ 决策数上界 4，但第 4 次声称因 cap **不再加分**）。
 * 数值 **8 不变** ⇒ `bidMultiplier ∈ {1, 2, 4, 8}`。将来若允许**多轮**反抢（>1 次），
 * 第一个要改的就是这里。
```

> ⚠️ **清洗轮订正（2026-09-30）**：上面代码块（计划副本）里「但第 4 次声称因 cap **不再加分**」机制表述**错**（只对「前 3 拍已 3 次声称」成立；前 3 拍 2 次声称时反抢那一抢把 4 升到 8）。`bid.ts` 现行 docblock 已改准为「反抢那一抢**同样 ×2**、每次声称**无条件** `min(m * 2, 8)`，但**任何路径都不越过 8**」（含 ⚠️ 订正注；docblock **行数净零** ⇒ `export const` 仍在 `:12`、`Math.min(...)` 仍在 `:70`，全仓 `bid.ts:70` 引用不漂）。本代码块保留为计划原样。

`:20` 的「⚠️ 这是**本仓一轮制**（每名玩家恰好决策一次）下的语义映射，不是普适规则。」改成：

```ts
 * ⚠️ 这是**本仓一轮制**（片① R2 起：每名玩家至多决策两次 —— 首次叫者可被派发一次反抢）
 * 下的语义映射，不是普适规则。
```

- [ ] **Step 4: 改 `bid.ts:59-84` 的判据（按规格 §4.2）**

保留 `:60` 那行推进**原位不动**（这样非反抢路径与旧实现逐字节一致），在它之后插入①，并把②的判据条件改写：

```ts
  // 唯一的 currentBidder 推进点（R104）：`resetBidding` **覆盖**为 0，不再推进。
  newPhase.currentBidder = (playerIdx + 1) % 3;

  newPhase.decisions = [...(session.bidPhase.decisions ?? []), {
    seat: playerIdx,
    kind: decisionKind,
    grab: bid,
  }];

  /**
   * 片① R2 ①：**派发反抢**（本轮一次性）。见规格 §4.2。
   *
   * 触发条件 = 「走满 3 次决策」**且**「≥2 人声称」（后者由
   * `landlordCandidate !== firstCaller` 一个比较表达：全不叫时两者都是 -1 相等，
   * 单人声称时两者相等；≥2 人时末位与首位必不同）。
   *
   * 🔴 **行动者必须显式赋值**，**不得**复用上一行的 `(playerIdx + 1) % 3`：
   * 3 次决策恰好走完一个座位循环 ⇒ 那个公式**恒等于「首个决策者」**，而它**不是**
   * 「首个声称者」（#4 的不叫/叫/叫 即反例）。而 `handleBid` 只校验
   * `playerIdx === currentBidder` ⇒ 指错人时**规则违规静默通过、连错误码都没有**。
   */
  if (
    !newPhase.antiRobGranted &&
    newPhase.grabActions === 3 &&
    newPhase.landlordCandidate !== newPhase.firstCaller
  ) {
    newPhase.antiRobGranted = true;
    newPhase.currentBidder = newPhase.firstCaller;
    return { ...session, bidPhase: newPhase, version: session.version + 1 };
  }

  /**
   * 片① R2 ②：**收口**。
   *
   * 🔴 判据必须对**决策计数单调**（`antiRobGranted ? 4 : 3`）—— 若写成
   * `grabActions >= 3 && landlordCandidate !== firstCaller`，反抢者一「不抢」
   * 该条件仍为真 ⇒ 行动者被反复指回同一人 ⇒ **叫抢永不结束**。
   */
  if (newPhase.grabActions >= (newPhase.antiRobGranted ? 4 : 3)) {
    if (newPhase.landlordCandidate !== -1) {
      return finalizeBidding({ ...session, bidPhase: newPhase }, newPhase.landlordCandidate);
    }
    // 三家全不抢 → 流局（此处 `antiRobGranted` 必为 false：全不叫 ⇒ 两人都是 -1 ⇒ 不派发）
    newPhase.redealCount++;
    if (newPhase.redealCount >= 3) {
      // 第 3 次流局不再重发，随机指定一名地主（倍数已归位为 1）
      const randomIdx = Math.floor(random() * 3);
      return finalizeBidding({ ...session, bidPhase: newPhase }, randomIdx);
    }
    return resetBidding({ ...session, bidPhase: newPhase }, random);
  }

  return { ...session, bidPhase: newPhase, version: session.version + 1 };
}
```

并删除原 `:68-82` 那段旧判据。

- [ ] **Step 5: 改 `handleBid` 的签名与 `resetBidding`**

`handleBid` 签名加第 4 参：

```ts
export function handleBid(
  session: GameSession,
  playerId: string,
  bid: boolean,
  random: () => number = Math.random,
): GameSession {
```

`resetBidding`（`:134-153`）加 `random` 参数、重摇起始座位、重置两个新字段：

```ts
function resetBidding(session: GameSession, random: () => number): GameSession {
  const redealt = dealCards(session);
  return {
    ...redealt,
    actionLog: [],
    bidPhase: {
      // 片① R1：流局重发是**新的一轮** ⇒ 起始座位**重新摇**（不再一律回座位 0 —— R104 作废）
      currentBidder: Math.floor(random() * 3),
      landlordCaller: -1,
      landlordCandidate: -1,
      bidPasses: 0,
      grabActions: 0,
      bidMultiplier: 1,
      redealCount: session.bidPhase.redealCount,
      decisions: [],
      firstCaller: -1,
      antiRobGranted: false,
    },
  };
}
```

同时把 `resetBidding` 上方 `:132` 的注释「R104：流局后**一律回到座位 0**（玩法 §3.1），因此这里是**覆盖**而非推进。」改成：

```ts
 * 🔴 **R104 已由片① R1 作废**：流局后**不再回到座位 0**，起始座位与 `createSession`
 * 一样由注入的 `random` 摇定。这里是**覆盖**而非推进这一点不变。
```

- [ ] **Step 6: 跑判据**

Run: `pnpm --filter @fight-the-landlord/shared exec vitest run src/ddz/bid.test.ts`
Expected: PASS（新增 10 条 + 既有的）

⚠️ 既有用例里断言「流局后回到座位 0」的（`bid.test.ts` 里搜 `currentBidder`）会红 ——
把那些夹具改成传 `() => 0`（起始座位 0），**不要**改断言语义。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/ddz/bid.ts packages/shared/src/ddz/bid.test.ts
git commit -m "feat(ddz): 反抢（一次，决策数上界 4）+ 流局重摇起始座位（片① R1/R2，规格 §3/§4.2）"
```

---

### Task 3: 出站硬闸与契约注释（上界 3 → 4）

**Files:**
- Modify: `packages/protocol/src/validate.ts:172-174`
- Modify: `packages/protocol/src/views.ts:121-122,129`
- Modify: `packages/protocol/src/messages.test.ts:199-202`

**Interfaces:**
- Consumes: 无
- Produces: `validateOutbound` 允许 `bidPhase.decisions.length <= 4`

> 🔴 **本任务必须先于任何会产出 4 条决策的部署**：闸不放宽时，第 4 条决策会让 `buildPlayerView` **当场抛错**
> ⇒ **整条 `game.state_update` 发不出去** ⇒ 客户端表现是「UI 卡住、无任何报错」。

- [ ] **Step 1: 改判据（先写失败用例）**

`packages/protocol/src/messages.test.ts:199-202` 附近，把「恰好 3 条合法 / 4 条非法」改成「4 条合法 / 5 条非法」：

```ts
  it('bidPhase.decisions 允许 4 条（片① R2 的反抢）、拒绝 5 条', () => {
    const mk = (n: number) => ({
      type: 'game.state_update' as const,
      version: 1,
      payload: {
        /* …与既有用例同形的 view… */
        bidPhase: {
          kind: 'rob' as const,
          currentBidder: 0,
          landlordCandidate: 1,
          bidMultiplier: 4,
          decisions: Array.from({ length: n }, (_, i) => ({ seat: i % 3, kind: 'rob' as const, grab: true })),
        },
      },
    });
    expect(() => validateOutbound(mk(4))).not.toThrow();
    expect(() => validateOutbound(mk(5))).toThrow(/at most 4 items/);
  });
```

⚠️ 复用该文件**既有**那条用例的完整 payload 形状（不要自造 view —— 缺字段会先撞别的校验）。

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm --filter @fight-the-landlord/protocol exec vitest run src/messages.test.ts`
Expected: FAIL —— 4 条时抛 `/at most 3 items/`。

- [ ] **Step 3: 放宽闸**

`packages/protocol/src/validate.ts:172-174`：

```ts
  if (bp.decisions.length > 4) {
    throw new ProtocolError(
      `${path}.bidPhase.decisions must have at most 4 items (一轮制 + 一次反抢), got ${bp.decisions.length}`,
    );
  }
```

- [ ] **Step 4: 改契约注释**

`packages/protocol/src/views.ts:121-122`：

```ts
    /** 本轮已完成的决策次数（0..4 —— 片① R2 起允许一次反抢） */
    grabActions: number;
```

`packages/protocol/src/views.ts:129`：

```ts
    /** 本轮**已发生**的叫抢决策，按发生顺序；最多 4 条（一轮制 + 一次反抢，天然有界）。 */
```

- [ ] **Step 5: 跑判据**

Run: `pnpm --filter @fight-the-landlord/protocol exec vitest run`
Expected: PASS（注意 `views` 的键集判据**不应**受影响 —— 本任务不新增出站字段）

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/validate.ts packages/protocol/src/views.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): 出站闸放宽到 4 条叫抢决策（片① R2，规格 §5.3）"
```

---

### Task 4: 机器人叫抢恒 pass（删掉三个死符号）

**Files:**
- Modify: `packages/robot-service/src/robot/bot.player.ts:4`（import）、`:12-13`、`:52-55`、`:139-146`、`:189-214`
- Modify: `packages/robot-service/test/robot.decide.test.ts:179-193`

**Interfaces:**
- Produces: `BotPlayer.decide()` 在 `state === 'bidding'` 时恒返回 `{ kind: 'pass', source: 'rule' }`

> 🔴 **必须「整块删除 `decideBid`」，不是「把函数体改成恒返回」**：`tsconfig.base.json:7` 的
> `noUnusedParameters` 会让「保留 `decideBid` 但其 `req` 不再被读」直接 `TS6133` ⇒ `pnpm build` 失败。

- [ ] **Step 1: 改判据（反号）**

`packages/robot-service/test/robot.decide.test.ts:179-193` 的用例名与断言改成：

```ts
  it('片① R3：叫抢阶段机器人**既不叫也不抢** ⇒ 恒 pass（且不调用 DouZero）', async () => {
    const bot = new BotPlayer(douZeroStub);
    bot.random = () => 1; // 即使不失误也必须是 pass
    const res = await bot.decide(request({ skillLevel: 'advanced', view: biddingView() }));
    expect(res.kind).toBe('pass');
    expect(res.source).toBe('rule');
    expect(douZeroStub.getMove).not.toHaveBeenCalled();
  });
```

⚠️ 既有的两个夹具（`[17,20,30]` 全是大牌 ⇒ 旧实现必抢）保留，只把期望从 `'play'` 改成 `'pass'` ——
**它们从「证明会抢」变成「证明再大的牌也不抢」，判别力更强**。

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm --filter @fight-the-landlord/robot-service exec vitest run test/robot.decide.test.ts`
Expected: FAIL —— 大牌夹具仍返回 `kind: 'play'`。

- [ ] **Step 3: 改 `decide`（`:52-55`）**

```ts
  async decide(req: RobotDecideRequest): Promise<RobotDecideResponse> {
    // 片① R3：机器人在叫抢阶段**既不叫也不抢**（规格 §1-3）。
    // 叫抢没有 AI 模型可用（上游 kwai/DouZero 树里没有叫抢模型），
    // 而「按手牌强度抢」的策略已由用户裁决废除 ⇒ 恒 pass。
    if (req.view.state === 'bidding') return { kind: 'pass', source: 'rule' };
    return this.decidePlay(req);
  }
```

- [ ] **Step 4: 整块删除三处死符号**

- `decideBid`（`:139-146`）整个方法
- `BID_GRAB_THRESHOLD`（`:12-13`）
- `errorRateOf`（`:189-194`）
- `handStrength`（`:196-214`）
- `:4` 的 `DOUZERO_2,` 这一行 import

- [ ] **Step 5: 跑判据 + 构建（构建必须过 —— 这是本步的主要判据）**

Run: `pnpm --filter @fight-the-landlord/robot-service exec vitest run`
Expected: PASS（全包）
Run: `pnpm --filter @fight-the-landlord/robot-service build`
Expected: 退出码 0（**这一步专门抓 `noUnusedLocals`/`noUnusedParameters` 的漏网**）

- [ ] **Step 6: Commit**

```bash
git add packages/robot-service/src/robot/bot.player.ts packages/robot-service/test/robot.decide.test.ts
git commit -m "feat(robot): 叫抢阶段机器人恒 pass —— 删除 decideBid/handStrength/errorRateOf（片① R3，规格 §5.5）"
```

---

### Task 5: 随机源注入 4 个调用点 + 老会话迁移

**Files:**
- Modify: `packages/game-service/src/game/game.service.ts`（`:175`、`:281`、`:598`、`:668`、`:725-736`、`:139-147`）
- Test: `packages/game-service/test/game.service.random.test.ts`（新建）

**Interfaces:**
- Produces: `GameService.random: () => number`（public 可写字段，默认 `Math.random`）
- Produces: `applyDecisionToSession(session, playerId, decision, random)`（模块私有，**多一个形参**）
- Produces: `loadSession` 对无 `firstCaller` 的老会话做**一次性迁移**

> 🔴🔴 **本任务最阴的洞**：`applyDecisionToSession`（`:725-736`）是**模块级自由函数**（没有 `this`），
> 而机器人驱动链的 `handleBid` 在 `:731`。因为签名有默认值 `= Math.random`，**漏传不报错、静默退化**
> ⇒ 含机器人的房仍不确定 ⇒ 测试以「看起来好了」的形态留下 flaky。
> **全仓 `createSession`/`handleBid` 调用点只有 4 处**：`:175` / `:281` / `:668` / `:731`。

- [ ] **Step 1: 写失败判据（注入必须覆盖机器人驱动链）**

新建 `packages/game-service/test/game.service.random.test.ts`（夹具照 `game.service.test.ts:1-28` 逐字抄）：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameState } from '@fight-the-landlord/shared';
import { GameService } from '../src/game/game.service';
import type { Redis } from 'ioredis';
import { redisDouble, resetRedisDouble, type RedisDouble } from './helpers-ioredis';

vi.mock('ioredis', async () => {
  const { ioredisMockModule } = await import('./helpers-ioredis');
  return ioredisMockModule();
});

describe('片① R1：随机源注入覆盖全部 4 个调用点', () => {
  let service: GameService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRedisDouble();
    service = new GameService(redisDouble as unknown as Redis);
    service.random = () => 0.9; // 恒 0.9 ⇒ 起始座位 = floor(0.9 * 3) = 2
  });

  const humans = [
    { id: 'user-1', seat: 0, isRobot: false },
    { id: 'user-2', seat: 1, isRobot: false },
    { id: 'user-3', seat: 2, isRobot: false },
  ];

  it('startGame 用注入的 random（createSession 调用点 :175）', async () => {
    await service.startGame({ roomCode: 'RND1', baseScore: 100, players: humans });
    const s = await service.getSnapshot('RND1');
    expect(s!.bidPhase.currentBidder).toBe(2);
  });

  it('🔴 机器人驱动链的流局重摇也吃注入的 random（handleBid 调用点 :731，自由函数）', async () => {
    // 三机器人房 ⇒ 叫抢恒 pass（片① R3）⇒ 三轮全不叫 ⇒ `resetBidding` 与
    // 「第 3 次流局随机指定地主」都会走 `applyDecisionToSession` → `handleBid`（:731）。
    // 若那一处漏传 `this.random` ⇒ 本断言会**flaky 地红**（座位变成真随机）。
    await service.startGame({
      roomCode: 'RND2',
      baseScore: 100,
      players: [
        { id: 'p_a', seat: 0, isRobot: true, botId: 'bot-a', skillLevel: 'beginner' },
        { id: 'p_b', seat: 1, isRobot: true, botId: 'bot-b', skillLevel: 'beginner' },
        { id: 'p_c', seat: 2, isRobot: true, botId: 'bot-c', skillLevel: 'beginner' },
      ],
    });
    // ⚠️ 机器人房需要等驱动环推进 —— 照 `game.robot.test.ts:75-87` 的等待方式
    //     （轮询 `getSnapshot` 直到 `state === GameState.Playing`，带上界）。
    const s = await waitForPlaying(service, 'RND2');
    expect(s.players.findIndex((p) => p.isLandlord)).toBe(2); // floor(0.9 * 3)
  });
});
```

> 🔵 **这条判据为什么必需**：`createSession` / `handleBid` 的 `random` **有默认值**（生产行为不变），
> 所以漏传**不会编译失败**。而 `applyDecisionToSession` 的 `random` **不给默认值**（见 Step 4）⇒
> 漏传是 `TS2554` **编译错** —— 那是**结构性**防线；这条**行为**判据补的是「传了但传错值」的形态。

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm --filter @fight-the-landlord/game-service exec vitest run test/game.service.random.test.ts`
Expected: FAIL —— `service.random` 不存在（**TS2339**：`Property 'random' does not exist on type 'GameService'`）。

- [ ] **Step 3: 加可注入字段**

在 `GameService` 类里（`robotDelay` `:94` 附近，那里已有同款 public 可写字段的先例）：

```ts
  /**
   * 片① R1：**可注入的随机源**。默认 `Math.random` ⇒ 生产行为与改动前一致。
   * 测试设 `service.random = () => 0` 以获得确定的起始座位（规格 §5.2 / §5.6）。
   *
   * ⚠️ 它必须一路传到 `createSession` / `handleBid` —— **全仓只有 4 个调用点**：
   * `:175 startGame` · `:281 bid()` · `:668 onTurnTimeout` · `:731 applyDecisionToSession`。
   * 最后一处在**模块级自由函数**里（没有 `this`）⇒ 必须给它加形参、由 `:598` 传进来。
   * 漏任何一处**都不会编译失败**（签名有默认值）⇒ 会静默退化成真随机。
   */
  random: () => number = Math.random;
```

- [ ] **Step 4: 传参（逐点）**

```ts
// :175（createSession）
const session = createSession(roomCode, playerIds, this.random);

// :281（bid() 闭包）
handleBid(session, playerId, grab, this.random),

// :668（onTurnTimeout）
? handleBid(session, playerId, false, this.random)

// :725-736（自由函数：加形参）
// 🔴 `random` **不给默认值** —— 这是**结构性防线**：漏传是 TS2554 编译错，
//    而不是像 `createSession`/`handleBid` 那样静默退化成真随机。
//    （那两处必须有默认值，否则全仓每个测试调用点都要改。）
function applyDecisionToSession(
  session: GameSession,
  playerId: string,
  decision: { kind: 'play' | 'pass'; cards?: number[] },
  random: () => number,
): GameSession {
  if (session.state === GameState.Bidding) {
    return handleBid(session, playerId, decision.kind === 'play', random);
  }
  // …其余不变…
}

// :598（调用方，类方法内 ⇒ 有 this）
updated = applyDecisionToSession(session, playerId, decision, this.random);
```

- [ ] **Step 5: 加老会话迁移（`loadSession` `:139-147`）**

```ts
    const data = await this.redis.get(`game:session:${roomCode}`);
    if (!data) return null;
    try {
      const session = JSON.parse(data) as GameSession;
      // 🔴 片① R2 的一次性迁移（规格 §7.1）。这是**唯一**允许读 `decisions` 做判定的位置。
      // ⚠️ `bidPhase?.` —— 缺 bidPhase 的会话会让本函数抛 TypeError（现有 try 只包 JSON.parse）。
      if (session.bidPhase && session.bidPhase.firstCaller === undefined) {
        const bp = session.bidPhase;
        const firstGrab = (bp.decisions ?? []).find((d) => d.grab);
        // ⚠️ `decisions` 整个缺失（协议⑦ 之前的会话）时**不能**落 -1：
        //    否则 grabActions∈{1,2} 的中途房仍会「必然误触发反抢」⇒ currentBidder = -1 ⇒ 永久停摆。
        //    退化到 landlordCandidate = 「不派发反抢」= 旧行为，正是兼容所需。
        bp.firstCaller = firstGrab?.seat ?? (bp.landlordCandidate >= 0 ? bp.landlordCandidate : -1);
        bp.antiRobGranted = bp.grabActions >= 3;
      }
      return session;
    } catch {
      this.logger.error(`Corrupt session in Redis for room ${roomCode}`);
      return null;
    }
```

⚠️ **不要**改 `version`（会破坏在途客户端的 CAS）；不需要手动落盘 —— 下一次状态转移经 `finishTransition` 自然写回。

- [ ] **Step 6: 加迁移判据（三条）**

在 `game.service.random.test.ts` 追加：

```ts
describe('片① §7.1：老会话迁移', () => {
  it('有 decisions 的老会话：firstCaller = 第一条 grab=true 的座位', async () => { /* … */ });
  it('已走满 3 拍的老会话：antiRobGranted = true（⇒ 不派发反抢）', async () => { /* … */ });
  it('🔴 负例：decisions **整个缺失** + 中途房 ⇒ firstCaller = landlordCandidate（**不得**是 -1）', async () => {
    // 断言：迁移后 firstCaller !== -1，且「载入后 currentBidder 绝不可能是 -1」
  });
});
```

- [ ] **Step 7: 跑判据**

Run: `pnpm --filter @fight-the-landlord/game-service exec vitest run test/game.service.random.test.ts`
Expected: PASS（5 条）

- [ ] **Step 8: Commit**

```bash
git add packages/game-service/src/game/game.service.ts packages/game-service/test/game.service.random.test.ts
git commit -m "feat(game): 随机源注入全部 4 个调用点 + 老会话一次性迁移（片① R1，规格 §5.6/§7.1）"
```

---

### Task 6: 夹具确定性恢复（R1 的连带面）

**Files（逐个设 `service.random = () => 0`）:**
- Modify: `packages/shared/src/ddz/bid.test.ts`（起始座位相关用例传 `() => 0`）
- Modify: `packages/game-service/test/game.timer.test.ts:62-76/96-99/218/314`
- Modify: `packages/game-service/test/game.service.test.ts:98/109/117/156/172-174`
- Modify: `packages/game-service/test/game.controller.test.ts:281-295`
- Modify: `packages/game-service/test/game.robot.test.ts:90-93/169-194`
- Modify: `packages/game-service/test/full-game.test.ts:61-81` **与 `:84-88`**（INTEG3 同样要注入）

**Interfaces:**
- Consumes: Task 1 的 `createSession(random)` + Task 5 的 `GameService.random`

> 🔴 **本任务不做则那些用例从「恒过」变「1/3 概率过」= flaky，比红更糟**（规格 §6.2）。
> ⚠️ **文件级统一注入**：`full-game.test.ts` 的 `:84-88`（INTEG3）也用 `user-1` 抢 —— 只改 `:61-81` 会漏。

- [ ] **Step 1: 逐文件注入**

在每份夹具的 `beforeEach` / service 构造处加：

```ts
  service.random = () => 0; // 片① R1：起始座位确定（座位 0 先叫），与改动前的行为一致
```

`shared` 侧的 `bid.test.ts` 则给 `createSession(...)` 传第三参 `() => 0`。

- [ ] **Step 2: 跑受影响的两个包**

Run: `pnpm --filter @fight-the-landlord/shared exec vitest run`
Run: `pnpm --filter @fight-the-landlord/game-service exec vitest run`
Expected: 全 PASS

- [ ] **Step 3: 🔴 把 `game.robot.test.ts:190` 的隐式顺序断言改成不依赖顺序**

`:190` 的 `expect(order.slice(0,3)).toEqual(['bot-0','bot-1','bot-2'])` **字面没有「座位 0」**，
却同时钉住「首个决策者是座位 0」「按座位递增」「恰好 3 条决策」三件事。改成：

```ts
    // 片①：不再断言「前三条恰好是 bot-0/1/2」（那隐含了「座位 0 先叫 + 按座位递增」）。
    // 改为断言**绝对性质**：三席各决策至少一次、且总数在合法上界内。
    expect(new Set(order).size).toBe(3);
    expect(order.length).toBeGreaterThanOrEqual(3);
    expect(order.length).toBeLessThanOrEqual(4);
```

- [ ] **Step 4: 全仓门禁**

Run: `pnpm run ci`
Expected: 六阶段全过

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/ddz/bid.test.ts packages/game-service/test/
git commit -m "test: 夹具显式注入 random —— R1 之后恢复确定性（片①，规格 §6.2）"
```

---

### Task 7: 视图子层键集穷尽判据（防内部字段出站）

**Files:**
- Modify: `packages/game-service/test/view.builder.test.ts`（新增一条用例）

**Interfaces:**
- Consumes: `buildPlayerView`（不变）

> 🔵 **为什么需要**：`FORBIDDEN_OUTBOUND_KEYS`（`validate.ts:37-42`）不含 `firstCaller`/`antiRobGranted`，
> `assertNoLeak` 抓不到它们，而**顶层**键集已被 `game.controller.test.ts:138` 钉住 ⇒
> 若有人把 `bidPhase: { ...session.bidPhase }` **整块**塞进视图，**只有**这条新判据能抓（子键）。

- [ ] **Step 1: 写判据**

```ts
  it('🔴 PlayerView.bidPhase 的键集**恰为**契约集合（穷尽）—— 内部字段不得出站', () => {
    const view = buildPlayerView(makeSession(), 0);
    expect(Object.keys(view.bidPhase).sort()).toEqual([
      'bidMultiplier',
      'currentBidder',
      'decisions',
      'grabActions',
      'kind',
      'landlordCandidate',
      'redealCount',
    ]);
  });
```

⚠️ 期望值以**实际契约**为准：先跑一次打印 `Object.keys(view.bidPhase).sort()`，
把它**原样**粘进断言（不要凭 §5.3 的字段清单猜）。

- [ ] **Step 2: 跑它**

Run: `pnpm --filter @fight-the-landlord/game-service exec vitest run test/view.builder.test.ts`
Expected: PASS。⚠️ 若 `firstCaller`/`antiRobGranted` 出现在结果里 ⇒ **说明视图被整块展开，是缺陷**，回去改 `view.builder.ts`。

- [ ] **Step 3: Commit**

```bash
git add packages/game-service/test/view.builder.test.ts
git commit -m "test(game): 视图 bidPhase 子层键集穷尽判据（片①，规格 §5.4）"
```

---

### Task 8: conformance —— 补「2 声称 ⇒ 第 4 拍」场景

**Files:**
- Modify: `tools/conformance/src/slices/slice-08-bidding.ts`（新增一组；现有 `grabs=[true,false,false]` 保留）
- Modify: `tools/conformance/src/slices/slice-11-robot-system.ts:63-66`（注释订正）
- Test: `node tools/conformance/dist/run.js slice-08`（真栈）

**Interfaces:**
- Consumes: Task 2 的 `handleBid`（经真服务端）

> 🔴 **现状：新规则的唯一新增分支在线判据为零** —— 现有场景全是「1 声称」⇒ 反抢**永不触发**（规格 §8）。

- [ ] **Step 1: 加场景（2 声称）**

在 `slice-08-bidding.ts` 里照现有那组的形状新增：

```ts
  // ── 片① R2 组：2 声称 ⇒ 第 4 拍（反抢）──────────────────────────────
  // ⚠️ 行动者一律从**视图**读取（`view.bidPhase.currentBidder`），不得假设座位 0。
  step('片① R2：2 人声称 ⇒ 叫抢进入第 4 拍（反抢），且本轮必须结束');
  // 1) 依次让前两位「抢」、第三位「不抢」
  // 2) 断言：第 3 拍后仍 state==='bidding' 且 currentBidder === 首次声称者的座位
  // 3) 让反抢者「不抢」⇒ 断言 state==='playing' 且 isLandlord 是**末位声称者**
  // 4) 另起一局：让反抢者「抢」⇒ 断言 isLandlord 是**反抢者**
```

- [ ] **Step 2: 订正 slice-11 的过期注释**

`slice-11-robot-system.ts:63-66` 那段「人类**必坐 seat 0** 且 `bidPhase.currentBidder` 初值 **0**」改成：

```ts
 *     ⚠️ 片① R1 之后**不再成立**：起始座位是随机的 ⇒ 本切片的第 1 组不再能假定
 *     「人类在自己的**首个**回合决策」。行动者一律从视图读（`:459` 的轮询本来就这么做），
 *     但第 1 组的**判别力**随之减弱（测的窗口可能早于人类的首个决策）—— 记在规格 §5.7。
```

- [ ] **Step 3: 跑它（真栈）**

```bash
pnpm --filter @fight-the-landlord/conformance build
node tools/conformance/dist/run.js slice-08
```
Expected: 全绿，且新组出现在输出里（逐条 ✅ 可辨认）。

- [ ] **Step 4: 跑 slice-11（确认 12 次上界仍够用）**

```bash
node tools/conformance/dist/run.js slice-11
```
Expected: 全绿。⚠️ 上界 **不改**（规格 §8 的算式：最坏 = 两轮流局 3+3 + 一轮 4 = **10** < 12）。

- [ ] **Step 5: Commit**

```bash
git add tools/conformance/src/slices/
git commit -m "test(conformance): 补「2 声称 ⇒ 第 4 拍」场景 + 订正 slice-11 的过期前提（片① R2，规格 §8）"
```

---

### Task 9: 客户端 —— 作废过期论证 + 重新量纵向预算

**Files:**
- Modify: `apps/client/src/pages/table/table.vue:228-229, 940-941`
- Modify: `apps/client/test/table-center.test.ts:255-256`
- Create: `.tmp_shots/table-fix/measure-bid2.mjs`（真浏览器量具，gitignored）
- Modify（若量具结论要求）: `apps/client/src/pages/table/table.vue` 的中央样式

**Interfaces:**
- Consumes: 无（纯客户端）
- Produces: **一份读数**（新可达态下的中央纵向预算）⇒ 决定是否加护栏

> 🔵 护栏（`.table__clock { flex-shrink: 0 }`）**早就在**（`table.vue:953`）；
> 真正的缺口是：量具当时量的「真实可达态」**不含中央回显**，而反抢让「同一轮内同一玩家决策两次」可达
> ⇒ 新可达态 = **我的（中央）回显与我的钟同场**（规格 §9）。

- [ ] **Step 1: 作废四处论证文字（改注释，不改代码）**

`table.vue:228-229`、`table.vue:940-941`、`table-center.test.ts:255-256` 三处，把
「**不可达**：一轮制叫抢下「我决策后当前叫抢者必已前进」」改成：

```
 * ⚠️ **片① R2 起这条「不可达」已作废**：反抢让「同一轮内同一玩家决策两次」可达
 * ⇒ 「我的中央回显 + 我的钟」**同场可达**。护栏（`flex-shrink: 0`）仍在、钟不会被压扁，
 * 但中央余量本就只剩 0.2~0.3px ⇒ 回显那一行进来会**外溢**。
 * 新可达态的实测读数见 `.tmp_shots/table-fix/` 的量具输出（规格 §9）。
```

`docs/superpowers/plans/2026-09-29-table-rework-handoff.md:135-139` **与 `:140`** 同样标注作废。

- [ ] **Step 2: 写量具（照 `.tmp_shots/table-fix/final-check.mjs` 同族）**

新建 `.tmp_shots/table-fix/measure-bid2.mjs`：真 chromium + CDP，跑真路径到「叫抢期·轮到我」，
然后**注入**「我的回显在场」并把 `currentBidder` 指回我（复现新可达态），量：

```js
// 需要采集的派生量（照 final-check.mjs 的 sample() 形状）
{
  centerOverflowPx:  /* .table__center 底边 − .table__mid 底边，>0 = 外溢 */,
  clockSize:         /* .table__clock 的 w×h，设计值 88×92 */,
  midH:              /* .table__mid 可用高 */,
  echoPresent:       /* 回显是否在场（自检：必须为 true） */,
}
```

- [ ] **Step 3: 跑量具，拿到读数**

```bash
node .tmp_shots/table-fix/measure-bid2.mjs --cdp-port 18807 --base-url http://localhost:5174/
```
Expected: 输出一组读数（`echoPresent === true` 的自检必须先过，否则量的是别的态）。

- [ ] **Step 4: 按读数决定护栏（二选一，写进提交信息）**

- 若 `centerOverflowPx <= 0`（不溢出）⇒ **不加护栏**，在规格 §9 记「新可达态实测不溢出」
  > ⚠️ **2026-09-30 订正（片① Task 9 · 实测轮）**：本行按**盒子**口径写，不足以覆盖实测全貌 ——
  > **实际结果：盒 `centerOverflowPx` = 0 / 内容在盒外对称外溢 ±19.1px ⇒ 不改样式**。实现者把
  > **两套读数**都记进规格 §9（偏离**是对的**：照本行只记「不溢出」会把内容缺口掩盖）；
  > 完整裁决（**口径 = 内容** · 两候选被否 · 第三条路登记）见规格 §9「编排者裁决」条。
  > 读数：`.tmp_shots/table-fix/bid2-measure-bid2.json` · `bid2-run2-measure-bid2.json`。
- 若 `centerOverflowPx > 0` ⇒ 二选一：**调中段高度** 或 **给中央加裁切**。
  ⚠️ **不得**改成给手牌区做缓冲（会动 `HAND_ROW_W` 的账 —— `table.vue` 的既有红线注释）。

- [ ] **Step 5: 跑客户端判据 + 门禁**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run`
Run: `pnpm run ci`
Expected: 六阶段全过

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/pages/table/table.vue apps/client/test/table-center.test.ts
git add docs/superpowers/plans/2026-09-29-table-rework-handoff.md
git commit -m "docs(client): 作废「回显+钟不可达」论证（片① R2）+ 新可达态纵向预算实测：<结论>"
```

---

### Task 10: 文档同步（规则的唯一来源）

**Files:**
- Modify: `docs/games/doudizhu.md:86`、`:99-102`、`:111-130`
- Modify: `docs/design.md:288, 290, 508, 511, 1866`
- Modify: `docs/superpowers/plans/deviation-ledger.md:182, 310`（C24 重新开启/改判）

**Interfaces:**
- Consumes: Task 2 的最终规则

> ⚠️ `docs/games/doudizhu.md` 是**规则的唯一来源** —— 不列进清单就是「改了代码没改规则文档」。

- [ ] **Step 1: 改 `doudizhu.md:86`**

「每轮流局重新开始后，**一律由座位 0 起**，按 0→1→2 顺序，每人决策一次」改成：

```
每轮**起始座位随机**（`createSession` / `resetBidding` 各摇一次，见 `shared/ddz/game.ts` 的注入式
`random`），按座位循环顺序，每人**至少**决策一次；若本轮有 ≥2 人声称，**首次声称者**额外获得
**一次**反抢机会（本轮最后一次）。
```

- [ ] **Step 2: 改 `doudizhu.md:99-102`（倍数）**

「一轮最多 3 次抢 ⇒ 上限 8」改成：

```
一轮最多 **4 次声称**（3 次 + 1 次反抢）⇒ 但第 4 次因 `BID_MULTIPLIER_CAP = 8` **不再加分**
⇒ 上限仍为 8，`bidMultiplier ∈ {1, 2, 4, 8}`。
```

> ⚠️ **清洗轮订正（2026-09-30）**：上面代码块（计划副本）里「⇒ 但第 4 次因 `BID_MULTIPLIER_CAP = 8` **不再加分**」机制表述**错**（只对「前 3 拍已 3 次声称」成立；前 3 拍 2 次声称时反抢那一抢把 4 升到 8）。`doudizhu.md` 现行正文已改准为「反抢那一抢**同样 ×2**（每次声称无条件 `min(m × 2, 8)`），但**任何路径都不越过 8** ⇒ 上限仍为 8」（2026-09-30 修复轮，其后附有 `>` 订正注）。本代码块保留为计划原样。

- [ ] **Step 3: 改 `doudizhu.md:111-130` 的 §3.2 伪码与结语**

伪码补上反抢分支；`:130` 的「这一条覆盖了「1 人抢 + 2 人不抢」「2 人抢 + 1 人不抢」「3 人全抢」与「3 人全不抢」全部四种情形，无遗漏分支。」改成：

```
轮次结束的判据是 `grabActions >= (antiRobGranted ? 4 : 3)`（**对决策计数单调** ⇒ 必然终止）。
八种 (抢/不抢) 组合的确定结果见设计规格 §3 的真值表。
```

- [ ] **Step 4: 改 `design.md` 四处与 C24**

`docs/design.md:288/290/508/511` 的「一轮制 ⇒ 最多 3 条」「`grabActions`（0..3）」→ 「最多 4 条」「（0..4）」。
`docs/design.md:1866` 的 C24 条目加订正行：

```
**片① 订正（2026-09-30）**：R104「流局后一律回到座位 0」已被片① R1 作废（起始座位随机）。
```

- [ ] **Step 5: 台账（C24 / R104 显式作废）**

`docs/superpowers/plans/deviation-ledger.md:182` 与 `:310` 的 C24 记录处加：

```
> 🔴 **2026-09-30 片① 重新裁决**：R104（`resetBidding` 无条件置 0）**作废** ——
> 起始座位改为随机（规格 `2026-09-30-bidding-rules-design.md` §5.1）。
> 下一个读到这里的人：**随机座位是规格要求的，不是 bug，不要「修」回去。**
```

- [ ] **Step 6: 提交**

```bash
git add docs/games/doudizhu.md docs/design.md docs/superpowers/plans/deviation-ledger.md
git commit -m "docs: 叫抢规则同步（随机起始座位 + 一次反抢）+ R104/C24 显式作废（片①）"
```

---

### Task 11: 全量验收

**Files:** 无（只跑判据、出读数）

- [ ] **Step 1: 全仓门禁**

```bash
pnpm run ci
```
Expected: 六阶段全过（`1/6 install` … `6/6 eslint-forbidden`，末行 `=== [ci] 六阶段全部通过 ===`），退出码 0。

- [ ] **Step 2: conformance 全片**

```bash
pnpm --filter @fight-the-landlord/conformance build
for s in slice-05 slice-06 slice-07 slice-07.1 slice-08 slice-09 slice-10 slice-11 slice-12 \
         slice-07.2-security slice-07.2-boundary slice-07.2-hardening slice-07.2-deploy \
         slice-07.2-rpc slice-07.3-edge slice-07.4-pipeline slice-07.5-backup; do
  node tools/conformance/dist/run.js "$s" > ".superpowers/sdd/bidding-rules/logs/$s.log" 2>&1
  echo "$s ⇒ exit $?"
done
```
Expected: 逐片 exit 0。⚠️ `slice-07.5-backup` 在本机会因缺 `flock`/`script(1)` 低于 CI 基线（**本机跳 14 条**，如实记、**不回填**）。

- [ ] **Step 3: 基线闸**

```bash
node scripts/check-baselines.mjs full <把上面 17 片日志合并成一个文件>
node scripts/check-baselines.mjs --self-test
```
Expected: self-test 4/4；`full` 唯一 1 条违规 = `slice-07.5-backup`（结构性，如实记）。
⚠️ **若因本片新增判据使某片计数高于基线 ⇒ 不违规**（判据只增不减）。**不得**用本机读数回填 `baselines.json`。

- [ ] **Step 4: 真浏览器探针**

```bash
node scripts/browser-e2e.mjs --scenario full
```
Expected: gate 22/22 · full 39/39 · 0 ❌

- [ ] **Step 5: 收口报告**

写 `.superpowers/sdd/bidding-rules/final-report.md`，逐条列出：跑过的命令、**本次产生的日志路径**、读数。
⚠️ **任何「跑了」的表述必须指向本次产生的日志**（规格来源的那条教训）。

- [ ] **Step 6: Commit**

```bash
git add .superpowers/  # 若该目录被 gitignore 则本步无提交，如实记
git commit -m "chore: 片① 全量验收读数"
```

---

## 自检（计划写完后的三问）

**1. 规格覆盖**：§5 的改动清单逐条对照 —— §5.1 Task 1/2 ✓ · §5.2 Task 1/5 ✓ · §5.3 Task 3 ✓ ·
§5.4 Task 7 ✓ · §5.5 Task 4 ✓ · §5.6 Task 5 ✓ · §5.7 Task 8 ✓ · §5.8 无改动 ✓ · §5.9 Task 9 ✓ ·
§5.10 Task 10 ✓ · §6 Task 2/6 ✓ · §7 Task 5/8/10 ✓ · §8 Task 8 ✓ · §9 Task 9 ✓ · §10 无改动（登记）✓ · §11 无改动 ✓

**2. 占位符扫描**：Task 5 的测试体**已补给真代码**（含夹具照抄来源与 `waitForPlaying` 的等待方式引用）。
**仅剩 Task 8 一处**依赖本文件既有夹具（`slice-08-bidding.ts` 的既有组）—— 实现者必须照同文件既有写法填；
**实施时若发现无法照抄，先回来补计划，不要自由发挥。**
另注：Task 5 的 `applyDecisionToSession` 的 `random` **无默认值** ⇒ 漏传是编译错（结构性防线），
这条是**在写计划时才定下来的**，优于规格 §5.6 的原始描述 —— 实施后请回填进规格。

**3. 类型一致性**：`createSession(roomCode, playerIds, random?)` · `handleBid(session, playerId, bid, random?)` ·
`applyDecisionToSession(session, playerId, decision, random)`（**注意是 4 个形参，无默认值**）·
`GameService.random: () => number` —— 全计划一致 ✓

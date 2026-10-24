# 花色协议（协议侧）实施计划

> ## ✅ 本计划已执行完毕（2026-09-21）
>
> **结果**：8 个 Task 全部收口，合入 `master`（merge commit `d70977a`），
> `feat/suit-protocol` 分支已删除。
>
> **完成判据全部满足**：`pnpm run ci` 六阶段全绿（合并前后各跑一遍）·
> conformance **13/13** · 真浏览器探针 `--scenario full` **20/20** ·
> `test lint --force` 29/29 · `build --force` 10/10 · `build:app` DONE ·
> **全仓 tsc 84 → 0**。
>
> ⚠️ **下面的 Step 复选框有意保持未勾选**：本计划是**按方法执行**的（R706：改动面由 `tsc` 反推），
> 而不是逐字照做——执行期有多处**有据的偏离**。**真实记录不在这里，在下面两处**：
>
> | 想知道什么 | 去哪看 |
> |---|---|
> | 逐 task 收尾时的实测增量、每个执行期发现 | [`2026-09-20-suit-change-surface.md`](2026-09-20-suit-change-surface.md)（**改动面清单**，含全部方法论结论） |
> | 每个决策的理由、改了什么、为什么 | `git log 7a97f28..d70977a`（11 个实施提交，每个都有详细 message） |
> | 关键的执行期发现（4 个 `tsc` 看不见的真缺陷） | 同上两者的「执行期发现」段 |
>
> **下一步**：spec 的 **R700 拆两份串行**，本份是**第①份（协议侧）**。
> **第②份（素材/观感侧）尚未开工** —— 见 spec §6（素材接入）与 §7（音效）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让全系统认识花色——一张牌的形状从 `number`（DouZero 整数）变成 `{r, s}`，同时把内部 Rank 编码彻底删除，`2` 在所有层都是 `17`。

**Architecture:** 按 spec R706 定的方法执行：**先只改类型定义、跑 `tsc` 让编译器列出全部改动点**，再按包收敛。本计划**不提供逐文件清单**——v1/v2/v3 连续三版人工列举都被独立复核判定「系统性不全」（v3 漏了 23 处，覆盖全部 7 个包）。清单由 `tsc` 产出，见 Task 1。

**Tech Stack:** TypeScript 5.7 · pnpm 9.15 workspaces + turbo · NestJS 10（后端 7 包）· Vue 3 + uni-app（客户端）· vitest

**Spec:** `docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md`（v4，627 行，已定稿）

---

## Global Constraints

以下约束适用于**每一个** task，不再逐条重复：

- **编码唯一（R695）**：全系统只有 DouZero 一套编码。`2` 在**所有**层都是 `17`。`toInternalRank()` / `toDouZero()` **删除**。`Rank` **枚举保留**（`Rank2` 由 15 改成 17）——删的是「15 这套编码」，不是 `Rank` 符号。
- **牌形状唯一（R696）**：`{r: number, s: number}`，`r` 用 DouZero 编码，`s ∈ 0♠ 1♥ 2♣ 3♦ 4王`（两张王**都是 4**）。全系统只有 `protocol.Card` 一个牌类型；`shared/src/card/card.ts` 的 `Card {suit, rank, color}` **退役**。
- **出牌载荷（R697）**：`game.play` 载荷为 `{ cards: Card[] }`；服务端**按身份精确摘除**（逐个在行动者手里找 `(r,s)` 完全相等的牌并移除），任一找不到即拒。这是**破坏性契约变更**，两端必须同一个 PR。
- **提交纪律，两种粒度要分清**：
  - **每个 task 结束时，该 task 触及的包必须 `tsc` 干净、该包测试全绿、`build` 通过**——这是逐 task 的验收。
  - ⚠️ **唯一的例外是 Task 1**：它只改 `protocol`，提交后**下游包会红**。这是 R706 方法的**必要第一步**（清单必须从编译器报错里长出来），**不是**可跳过的中间态。所以本片**允许** Task 1 的 commit 下游不编译，**但仅此一个**——Task 2 起，每个 task 结束时后端侧必须恢复可编译。
  - 判据：Task 1 提交后 `pnpm --filter @fight-the-landlord/protocol lint` 必须**干净**（本包绿是硬要求）；下游的红是**预期产物**，要被 Step 10 收集进清单。
- **改动面由 `tsc` 反推（R706）**：任何「还要改哪些文件」的判断都必须以一次**真实的 `tsc` 报错**为依据。追不到报错的条目，要么属于 spec §3.5 的三类（断言绕过 / 运行期静默 / 注释文档），要么是清单错误。
- **清单是逐层增长的，不是一次出全**（实测）：修好一层，下一层才会浮出来。两个已证实的例子——`game-service/src/game/game.controller.ts:102`（人类出牌的 HTTP 入口 DTO）在 Task 1 的清单里**不存在**，因为那时 `shared.handlePlayCards` 还吃 `number[]`，两边一致；客户端 `components/*.vue` 也不存在，因为 `stores/game.ts` 先断了。
  ⇒ **每个 task 收尾时必须重跑一次**（先 build protocol）：
  ```bash
  cd /d/Code/pokergame
  pnpm --filter @fight-the-landlord/protocol build && pnpm -r --no-bail lint
  ```
  把**新增**的报错追加到 `docs/superpowers/plans/2026-09-20-suit-change-surface.md`。清单的闭环复核在 Task 8 Step 3。
- **禁止实现状态标记**：本片的文档改动**不得**引入 `[已实现]` / `[待实现]` / `[部分实现]` / `[偏差]` 之外的标记（`docs/design.md` 用这三标记，沿用）。
- **门禁证据卫生（R682）**：门禁日志的 mtime 必须**晚于**最后一次改动/commit。
- **提交**：每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。**禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

### 共享验证命令

```bash
# 后端 7 包的类型检查（lint = 两个 tsconfig，第二条专查测试文件）
pnpm --filter <包名> lint

# 客户端类型检查（含 .vue）
pnpm --filter @fight-the-landlord/client lint      # = vue-tsc --noEmit

# 单包测试
pnpm --filter <包名> test

# 全仓（收口时用）
pnpm run ci
```

> ⚠️ **Windows 环境事实**：本机 `node_modules` 是 Windows 侧重装的；`pnpm lint` 找不到 `tsc` 说明装漏了，先 `pnpm install`。

---

## File Structure

本片**不预先规划文件结构**——改动面由 Task 1 的 `tsc` 输出决定（R706）。唯一预先确定的是**新增/变化的契约定义**：

| 文件 | 职责变化 |
|---|---|
| `packages/protocol/src/views.ts` | **新增** `Card` 接口；`LastPlayedHand.cards` / `PlayerView.hand` / `PlayerView.bottomCards` 三处变 `Card[]` |
| `packages/protocol/src/codec.ts` | 删两个转换函数与 `RANK_2`；`toDisplay()` 简化；**新增** `suitSymbol(s)` / `colorOf(card)` |
| `packages/protocol/src/validate.ts` | `assertCardArray` 从「整数数组」改为「`Card` 对象数组」 |
| `packages/shared/src/card/card.ts` | `Rank2` 15→17；`createDeck()` 循环上界改 `RankA`；`Card{suit,rank,color}` 退役；删 `suitSymbol`（重复实现） |
| `packages/shared/src/ddz/types.ts` | `GamePlayer.hand` / `GameSession.bottomCards` / `ActionLogEntry.cards` 变 `Card[]` |

---

## Task 1: protocol 契约改形状 + `tsc` 反推改动面

**这是本计划唯一一个「改动面未知」的 task，也是 R706 方法的落地点。**

**Files:**
- Modify: `packages/protocol/src/views.ts`
- Modify: `packages/protocol/src/codec.ts`
- Modify: `packages/protocol/src/validate.ts`
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/codec.test.ts`
- Create: `docs/superpowers/plans/2026-09-20-suit-change-surface.md`（`tsc` 产出的改动面清单）

**Interfaces:**
- Produces:
  - `protocol.Card`：`{ r: number; s: number }`
  - `protocol.suitSymbol(s: number): string`
  - `protocol.colorOf(card: ProtocolCard): 'red' | 'black'`
  - `protocol.DOUZERO_2 = 17`（`RANK_2` 删除）
  - 三处契约字段变 `Card[]`

---

- [ ] **Step 1: 先确认基线是绿的**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/protocol test
pnpm --filter @fight-the-landlord/protocol lint
```

Expected: 全绿。**若这里就是红的，先停下来修基线**——带着红的基线做破坏性改动，后面分不清哪条红是新的。

- [ ] **Step 2: 写失败的测试 —— `codec` 的新形状**

替换 `packages/protocol/src/codec.test.ts` 中所有涉及 `toInternalRank` / `toDouZero` / `RANK_2` 的用例（这些符号即将不存在），并新增：

```ts
import { DOUZERO_2, RANK_BLACK_JOKER, RANK_RED_JOKER, toDisplay, suitSymbol, colorOf } from './codec';

describe('R695：全系统统一 DouZero 编码，内部 Rank 已删除', () => {
  it('2 的 DouZero 编码是 17', () => {
    expect(DOUZERO_2).toBe(17);
  });

  it('toInternalRank / toDouZero 这两个转换函数已不存在', () => {
    const codec = require('./codec') as Record<string, unknown>;
    expect(codec.toInternalRank).toBeUndefined();
    expect(codec.toDouZero).toBeUndefined();
    expect(codec.RANK_2).toBeUndefined();
  });

  it('toDisplay 直接吃 DouZero 编码', () => {
    expect(toDisplay(DOUZERO_2)).toBe('2');   // 17 → '2'（不再经过内部 Rank）
    expect(toDisplay(14)).toBe('A');
    expect(toDisplay(RANK_BLACK_JOKER)).toBe('小王');
    expect(toDisplay(RANK_RED_JOKER)).toBe('大王');
    expect(toDisplay(3)).toBe('3');
  });
});

describe('R696：展示向助手', () => {
  it('suitSymbol 覆盖四个花色与王', () => {
    expect(suitSymbol(0)).toBe('♠');
    expect(suitSymbol(1)).toBe('♥');
    expect(suitSymbol(2)).toBe('♣');
    expect(suitSymbol(3)).toBe('♦');
    expect(suitSymbol(4)).toBe('');
  });

  it('colorOf 对两王按 r 区分（两张王的 s 都是 4，光看 s 分不出来）', () => {
    expect(colorOf({ r: 5, s: 0 })).toBe('black');
    expect(colorOf({ r: 5, s: 1 })).toBe('red');
    expect(colorOf({ r: 5, s: 2 })).toBe('black');
    expect(colorOf({ r: 5, s: 3 })).toBe('red');
    expect(colorOf({ r: RANK_BLACK_JOKER, s: 4 })).toBe('black');
    expect(colorOf({ r: RANK_RED_JOKER, s: 4 })).toBe('red');
  });
});
```

> **本计划对 spec 的一处细化**：spec §3.1 写的是 `colorOf(s)`，但两张王的 `s` **都是 4**，`colorOf(s)` **无法区分大小王的花色**。故签名定为 **`colorOf(card)`**（对王读 `r`）。spec §3.1 自己写了「protocol 版需自行定王的符号」，本计划即在此行使该自由。

- [ ] **Step 3: 跑测试确认它失败**

```bash
pnpm --filter @fight-the-landlord/protocol test
```

Expected: FAIL — `toInternalRank` 仍存在（`已不存在` 那条红）、`suitSymbol` / `colorOf` 未导出（`is not a function`）。

- [ ] **Step 4: 改 `codec.ts`**

完整替换 `packages/protocol/src/codec.ts` 内容：

```ts
/**
 * 牌值编码的唯一真源。
 *
 * **全系统只有一套编码：DouZero**（R695）。`2` 在所有层都是 `17`。
 * 历史上存在第二套「内部 Rank」（`2` = 15）与两个转换函数
 * `toInternalRank()` / `toDouZero()`——它们正是 C19「同点数的 2 互相压过」
 * 那个缺陷的成因。R695 之后，**没有「还原」这一步可以忘**。
 *
 * 其余点数（3..14、小王 20、大王 30）与玩法 §1.2 的大小序同构：
 *   `3 < 4 < … < 14 < 17 < 20 < 30`
 */

/** DouZero 编码里的 2 —— **全系统唯一的 2** */
export const DOUZERO_2 = 17;
/** 小王 */
export const RANK_BLACK_JOKER = 20;
/** 大王 */
export const RANK_RED_JOKER = 30;

/** DouZero 编码 → 牌面文字（前端展示用，不含任何规则判断） */
export function toDisplay(douzeroInt: number): string {
  if (douzeroInt === RANK_BLACK_JOKER) return '小王';
  if (douzeroInt === RANK_RED_JOKER) return '大王';
  if (douzeroInt === DOUZERO_2) return '2';
  if (douzeroInt === 14) return 'A';
  if (douzeroInt === 13) return 'K';
  if (douzeroInt === 12) return 'Q';
  if (douzeroInt === 11) return 'J';
  return String(douzeroInt);
}

/** 花色 → 符号（0♠ 1♥ 2♣ 3♦ 4王）。**只做展示**，不含任何规则判断。 */
export function suitSymbol(s: number): string {
  return ['♠', '♥', '♣', '♦', ''][s] ?? '';
}

/**
 * 牌的显示颜色。**只做展示**。
 *
 * ⚠️ 参数是**整张牌**而不是 `s`：两张王的 `s` **都是 4**，光看花色分不出大小王，
 * 必须读 `r`（小王 20 黑 / 大王 30 红）。
 */
export function colorOf(card: { r: number; s: number }): 'red' | 'black' {
  if (card.r === RANK_RED_JOKER) return 'red';
  if (card.r === RANK_BLACK_JOKER) return 'black';
  return card.s === 1 || card.s === 3 ? 'red' : 'black';
}

/** 校验一个整数是否为合法的 DouZero 牌值 */
export function isValidDouZeroCard(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return false;
  if (v >= 3 && v <= 14) return true;
  return v === DOUZERO_2 || v === RANK_BLACK_JOKER || v === RANK_RED_JOKER;
}
```

- [ ] **Step 5: 跑 codec 测试确认通过**

```bash
pnpm --filter @fight-the-landlord/protocol test -- codec
```

Expected: PASS。

- [ ] **Step 6: 改 `views.ts` —— 新增 `Card`、三处字段变形状**

在 `packages/protocol/src/views.ts` 的 `Seat` 之前插入：

```ts
/**
 * 一张牌。**全系统唯一的牌形状**（R696）：协议 / Redis / 内存手牌 / 客户端同构。
 */
export interface Card {
  /** DouZero 编码（R695：全系统唯一编码）：3–14 / 17(=2) / 20(小王) / 30(大王)。 */
  r: number;
  /** 花色：0♠ 1♥ 2♣ 3♦ 4王。**两张王都是 4**。 */
  s: number;
}
```

然后把三处字段改掉：

```ts
// LastPlayedHand
export interface LastPlayedHand {
  cards: Card[];        // ← 原 number[]
  type: number;
  keyRank: number;
  length: number;
}

// PlayerView
  /** **仅自己的手牌**，DouZero 编码 + 花色 */
  hand: Card[];                        // ← 原 number[]
  ...
  /** 叫抢阶段恒为 `null`；`state === 'playing'` 后三家皆可见 */
  bottomCards: Card[] | null;          // ← 原 number[] | null
```

同时把 `LastPlayedHand` 的文档注释里「`keyRank` 为**内部 Rank**（`2` = 15）」改成「`keyRank` 为 **DouZero 编码**（`2` = 17）」。`PlayerView` 的「**仅自己的手牌**，DouZero 编码」后面补「+ 花色」。

- [ ] **Step 7: 改 `validate.ts` —— 卡牌校验从「整数」改为「对象」**

把 `assertCardArray` 替换为：

```ts
/**
 * `Card[]` 的形状校验（R696）。
 *
 * ⚠️ **不做同 `r` 去重**——两张王的 `r` 本就不同（20 / 30），去重规则无处生效；
 * 四条同点数不同花色的牌是合法的。
 */
function assertCardArray(v: unknown, path: string): asserts v is Card[] {
  if (!Array.isArray(v)) throw new ProtocolError(`${path} must be an array`);
  v.forEach((c, i) => {
    if (!isObj(c)) {
      throw new ProtocolError(`${path}[${i}] must be a Card object with {r, s}`);
    }
    if (!isValidDouZeroCard(c.r)) {
      throw new ProtocolError(
        `${path}[${i}].r is not a valid DouZero card value: ${JSON.stringify(c.r)}`,
      );
    }
    if (!Number.isInteger(c.s) || (c.s as number) < 0 || (c.s as number) > 4) {
      throw new ProtocolError(`${path}[${i}].s must be an integer in 0..4, got ${JSON.stringify(c.s)}`);
    }
  });
}
```

`validate.ts` 顶部需要 `import type { Card } from './views';`。

- [ ] **Step 8: 改 `messages.ts` —— `game.play` 载荷**

```ts
| { type: 'game.play'; meta: RequestMeta; payload: { cards: Card[] } }
```

`messages.ts` 顶部加 `import type { Card } from './views';`（若已有 `views` 的 import 则合并）。

- [ ] **Step 9: 建改动面清单文件（先放骨架）**

创建 `docs/superpowers/plans/2026-09-20-suit-change-surface.md`：

```markdown
# 花色改动面清单（`tsc` 反推，R706）

> **本文件由 `tsc` 产出，不是人工列举。**
> 依据：`docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md` §3.4（R706）。
> 每一条都必须能追到一次真实的 `tsc` 报错；追不到的须说明它属于 spec §3.5 的三类之一。

**基线 commit**：（填 `git rev-parse --short HEAD`）
**生成时刻**：（填 `date`）

## 判据自证（Task 1 Step 11）

`tsc` 输出里三个包的报错计数 —— **任一为 0 都说明该包没被覆盖，清单是假的**：

| 包 | 报错计数 |
|---|---|
| `packages/shared` | （填实测） |
| `packages/game-service` | （填实测） |
| `apps/client` | （填实测） |

## 后端 7 包

（由 `pnpm lint` 的报错填充，每条一行：`文件:行 — 报错摘要`）

## 客户端

（由 `vue-tsc --noEmit` 的报错填充）

## 测试计数基线（Task 6 Step 3 / Task 7 Step 3 冻结）

> ⚠️ **必须实测，不得照抄任何文档或台账。** 台账里的计数来自不同日期。

| 范围 | 测量时刻 | commit | 实测值 |
|---|---|---|---|
| conformance 13 切片（逐条计数） | | | |
| `apps/client`（passed / skipped） | | | |

## 收口复核（Task 8 Step 3）

- [ ] 清单每一条都已处理
- [ ] 实改的文件都在清单里（不在的须说明它从哪条 `tsc` 报错追出，或属于 spec §3.5 的哪一类）
- [ ] 三个判据自证计数均 > 0
```

- [ ] **Step 10: 构建 `protocol`，然后跑 `tsc` 收集全部报错**

> ⚠️ **必须先 build，否则清单是假的。** `packages/protocol/package.json` 的 `"types": "./dist/index.d.ts"` —— 下游包解析的是 **`dist/` 的声明文件**，不是 `src/`。不 build 就 lint，下游会全部报 `Done`（零报错），因为 `dist/` 还是上一次构建的旧形状。
>
> **这一步是实测踩出来的**：第一次跑 `pnpm -r lint` 得到 0 个后端报错，是 Step 11 的自证判据（三个包的计数必须 > 0）把它抓住了——**自证判据存在的意义就在这里**。

```bash
cd /d/Code/pokergame
git rev-parse --short HEAD        # 记进清单的「基线 commit」
pnpm --filter @fight-the-landlord/protocol build
pnpm -r --no-bail lint 2>&1 | tee /tmp/suit-tsc.txt | tail -60
```

> ⚠️ 用 `--no-bail`，否则 pnpm 遇到第一个失败的包就停，后面的包不会跑。

Expected: **大量报错**——这是**预期的**，protocol 是根契约，下游全断。把报错**按包归类**填进 Step 9 的清单文件。

- [ ] **Step 11: 判据自证 —— 证明这份清单「来自 tsc」而不是事后补的**

spec §3.4 要求这条判据必须自证判别力（**探针判别力自证**，`R115`/`R150`）。做法：**从报错里挑一处已知必然存在的**，确认它确实在输出里。

```bash
grep -c 'packages/shared/src' /tmp/suit-tsc.txt
grep -c 'apps/client/src' /tmp/suit-tsc.txt
grep -c 'packages/game-service' /tmp/suit-tsc.txt
```

Expected: 三个包**都 > 0**。

**判别力证明**：若某个计数为 0，说明 `tsc` **没有覆盖该包**（配置漏了、或该包没跑到）——此时清单是**假的**，必须先去修 lint 命令，不得继续。把三个实测数字记进清单文件。

- [ ] **Step 12: 把报错逐条落成任务项**

按包把 `/tmp/suit-tsc.txt` 的报错整理进清单文件，每条一行：`文件:行 — 报错摘要`。**不要在这一步修任何东西**——这一步只产出清单。

- [ ] **Step 13: 提交**

```bash
git add packages/protocol/ docs/superpowers/plans/2026-09-20-suit-change-surface.md
git commit -m "feat(protocol)!: 牌形状改 {r,s} + 统一 DouZero 编码（R695/R696/R697）

BREAKING CHANGE: PlayerView.hand / bottomCards / LastPlayedHand.cards 从 number[]
改为 Card[]；game.play 载荷改 { cards: Card[] }；toInternalRank / toDouZero 删除。

本 commit 只改 protocol 包，下游包此时编译不过——这是 R706 方法的第一步：
由 tsc 产出改动面清单（docs/superpowers/plans/2026-09-20-suit-change-surface.md），
不人工列举。后续 task 按包收敛。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `shared` —— 规则引擎与牌堆

**Files:**
- Modify: `packages/shared/src/card/card.ts`（`Rank2`→17、`createDeck` 上界、`Card` 退役、删 `suitSymbol`）
- Modify: `packages/shared/src/index.ts`（barrel 收口）
- Modify: `packages/shared/src/ddz/*.ts`、`packages/shared/src/rule/*.ts`
- 其余以 Task 1 的清单为准

**Interfaces:**
- Consumes: Task 1 的 `protocol.Card` / `protocol.DOUZERO_2` / `protocol.suitSymbol` / `protocol.colorOf`
- Produces: `shared` 包全部内部结构使用 `protocol.Card`

---

- [ ] **Step 1: 修 `createDeck()` 的循环上界（这是本片唯一的数值地雷）**

`packages/shared/src/card/card.ts`：`Rank.Rank2` 由 15 改成 17，**同时**把 `createDeck()` 的内层循环上界从 `<= Rank.Rank2` 改成 `<= Rank.RankA`。

```ts
export enum Rank {
  Rank3 = 3,
  // …（中间不变）
  RankA,
  Rank2 = 17,          // ← R695：全系统唯一编码里 2 就是 17
  RankBlackJoker = 20,
  RankRedJoker = 30,
}

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (let s = Suit.Spade; s <= Suit.Diamond; s++) {
    // ⚠️ 上界必须是 RankA(14)，**不得**写 Rank2 —— Rank2 现在是 17，
    // 写它会产出 15 个点数 × 4 花色 + 2 王 = 62 张，其中 15/16 不是合法牌值。
    for (let r = Rank.Rank3; r <= Rank.RankA; r++) {
      deck.push({ r, s: s as number });
    }
  }
  deck.push({ r: Rank.RankBlackJoker, s: 4 });
  deck.push({ r: Rank.RankRedJoker, s: 4 });
  return deck;
}
```

- [ ] **Step 2: 跑 `card.test.ts` 确认地雷被抓住（★ 关键一步）**

```bash
pnpm --filter @fight-the-landlord/shared test -- card.test
```

Expected: **PASS**（若 `createDeck` 上界改对了）。

**判别力自证**：把上界**临时**改回 `<= Rank.Rank2`，再跑一次——必须红（`expect(deck).toHaveLength(54)` 失败，实测 62）。看到红之后**改回 `RankA`**。

> 这一步就是 spec §11-2 的订正所要求的：v3 把这个地雷标成 `[人盯]`，实际**单测立刻能抓**。**必须亲手看到那一次红**，否则等于没验证这条判据有判别力。

- [ ] **Step 3: `Card` 退役 + 删重复的 `suitSymbol`**

`packages/shared/src/card/card.ts`：
- 删除 `export interface Card { suit; rank; color }`、`CardColor`、`suitSymbols`、`suitSymbol()`、`rankFromChar` / `rankToString` / `rankNames` / `charToRank`、`type Deck = Card[]`——**以 Task 1 清单里 `tsc` 报出的实际消费方为准**：grep 确认哪些还有消费者，有则改为使用 `protocol.Card`，无则删。
- `Suit` 枚举**保留**（`0–4`，与 `protocol` 的 `s` 同值）。

⚠️ **两份 `suitSymbol` 必须只留一份**（spec §3.1 v4 补）：`shared` 这份删掉，展示向助手统一用 `protocol.suitSymbol`。留着就是 R695 要消灭的「两套口径」。

- [ ] **Step 4: 收口 barrel**

`packages/shared/src/index.ts`：若 Task 1 清单显示 `card/hand.ts` / `card/hand-impl.ts` 无消费者，删这两个文件与其测试，**并同时删 `export * from './card/hand'`**（否则 barrel 指向不存在的模块，立即编译报错）。`export * from './card/card'` 按 Step 3 的结果决定去留。

- [ ] **Step 5: 按清单收敛 `ddz/` 与 `rule/`**

```bash
pnpm --filter @fight-the-landlord/shared lint 2>&1 | head -60
```

按报错逐条修。**已知的要点**（来自 spec §3.5-D，不是清单替代品）：

- `ddz/game.ts` 的 `cardToInt` / `intToCard` —— **删除**，不是「简化」。改造后其生产消费者全部消失（`game.ts` 的 `dealCards` 直接持 `Card`、`play.ts` 的超时分支、`game.service.ts:615` 附近），留着就是零调用的换算壳。
- `ddz/game.ts:66` 的 `toDouZero(card.rank)` —— **整行删除**。
- `ddz/play.ts:10-25` 的 `douzeroIntToCard` —— **删除**。它在改造后无输入可言（超时分支吃的是真手牌 `Card[]`），保留只能编造花色，会被 §3.3 的身份精确摘除拒掉。
- `rule/rule.ts` / `rule/autoplay.ts` —— 读 `.rank` 改读 `.r`（实测共 6 处：`rule.ts:66`、`autoplay.ts:33/92/100/311/312`），`Card` 的 import 来源改 `@fight-the-landlord/protocol`。
- `ddz/features.ts` 的 `buildPublicFeatures()` —— ⚠️ **必须新增投影** `.map(c => c.r)`：`RobotFeatures` 的 `playedCards` / `actionSeq` / `lastMove` 是 **DouZero 点数**（AI 契约），而改造后 `actionLog` / `lastPlayedHand.cards` 是 `Card[]`。**漏投影时 `tsc` 不报**（`number[][]` 的 push 吃 `Card` 不报错只在严格模式下报，务必人看一遍）。
- `ddz/bid.ts` 的底牌并入地主手牌 —— 合并与排序改 `Card[]`。

- [ ] **Step 6: 跑 shared 全量测试**

```bash
pnpm --filter @fight-the-landlord/shared test
```

Expected: 全绿。**性质是「改形状不降强度」**——用例数**不得减少**（基线口径：字面 `it(`/`it.each(` = 143，整包含 `shared/test/`；只算 `src/**` 是 138）。若某条用例因为断言对象消失而必须改，**改断言而不是删用例**。

- [ ] **Step 7: 类型检查干净**

```bash
pnpm --filter @fight-the-landlord/shared lint
```

Expected: 无输出（干净）。

- [ ] **Step 8: 提交**

```bash
git add packages/shared/
git commit -m "feat(shared)!: 牌形状改 {r,s}、Rank2 15→17、删内部 Rank 转换

- Rank.Rank2 由 15 改成 17（R695）；createDeck() 循环上界改 RankA(14)，
  否则会产出 62 张含非法值 15/16
- shared 的 Card{suit,rank,color} 退役，统一用 protocol.Card
- 删重复的 suitSymbol（展示向助手只留 protocol 一份）
- 删 cardToInt / intToCard / douzeroIntToCard（改造后零消费者）
- features.ts 补 DouZero 点数投影（AI 契约必须保持 rank-only）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `game-service`

**这是 R697 服务端行为的落地点——按身份精确摘除。**

**Files:**
- Modify: `packages/game-service/src/game/game.controller.ts`（HTTP 入口 DTO）
- Modify: `packages/game-service/src/rpc/game.rpc.controller.ts`（RPC 入口）
- Modify: `packages/game-service/src/game/game.service.ts`（动作应用、机器人决策落地）
- Modify: `packages/game-service/src/game/view.builder.ts`
- 其余以 Task 1 的清单为准

**Interfaces:**
- Consumes: `protocol.Card`、`shared.handlePlayCards(session, playerId, cards: Card[])`
- Produces: 服务端**按 `(r,s)` 精确摘除**的行为；机器人决策的回填函数

---

- [ ] **Step 1: 先写失败的测试 —— 精确摘除的三个正负对照（spec §9.3）**

在 `packages/game-service/test/` 新开或用既有 play 测试文件，写：

```ts
describe('R697：game.play 按身份精确摘除', () => {
  it('送一张 (r,s) 不在手里的牌（同点数不同花色）⇒ 拒', async () => {
    // 构造：行动者手里有 {r:5,s:0}，送 {r:5,s:1}
    // 断言：被拒，错误码沿用「牌不在手里」映射（见 rule-error.mapping.ts）
  });

  it('送两张完全相同的 (r,s)（手里只有一张）⇒ 拒', async () => {
    // 构造：手里只有一张 {r:5,s:0}，送两张一样的
  });

  it('合法的「两张同点数不同花色」⇒ 接受，且手牌精确减少两张', async () => {
    // 构造：手里 {r:5,s:0} 与 {r:5,s:1}，两张都送
    // 断言：接受，hand.length 减 2，且剩下的牌里这两张都不在了
  });
});
```

> 三条都要在**未改实现**的当前代码上先跑一遍，确认它们**红**。第三条在改造前会**红**（载荷形状不同）——但前两条的语义是**新增**的，改造前可能因形状不符而红得没有信息量。**如实记录每条的红是什么**，这决定了它们是否真的在钉 R697。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @fight-the-landlord/game-service test
```

Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现精确摘除**

`shared` 的 `handlePlayCards(session, playerId, cards)` 改为按 `(r, s)` 完全相等逐个在行动者手里查找并移除；任一找不到即抛「牌不在手里」类错误（沿用既有映射，见 `rule-error.mapping.ts`；**映射表与文案需同步核对**——`N2` 的覆盖闸会抓）。

- [ ] **Step 4: 修两个入口的 DTO**

- `packages/game-service/src/game/game.controller.ts:102` —— `@Body() dto: { cards: Card[]; baseVersion?: number }`（这是**人类出牌的唯一 HTTP 入口**，v3 的清单完全没列）
- `packages/game-service/src/rpc/game.rpc.controller.ts:84` —— 把 `as { grab?: boolean; cards?: number[] }` 的类型断言改掉；⚠️ **这是 `as` 绕过，`tsc` 不会主动报**（spec §3.5-A）。

- [ ] **Step 5: 机器人决策回填 —— 与 ③ 共用同一个挑法函数**

按 spec §4 的 C8：`RobotDecideResponse.cards` 是 **rank-only** `number[]`，服务端要为其补花色。**硬要求**：

1. 挑法**确定性**（取同点数里 `s` 最小的那张）；
2. **与「game-service 本地兜底」（`ruleDecision`）共用同一个函数**——不得各写一份；
3. 回填**必须落在既有判重之前**：`game.service.ts` 用 `JSON.stringify(fallback) !== JSON.stringify(first)` 判「被拒动作 == 规则引擎动作」，回填若在比较之后，两边类型不同 ⇒ **判重恒不等** ⇒ 兜底重试**必然多跑一次**。

```ts
/**
 * 为 rank-only 的决策补花色（§4 的 ① 与 ③ **共用**）。
 * 取同点数里 `s` 最小的那张 —— 确定性使断言可复现。
 */
export function backfillSuits(hand: Card[], ranks: number[]): Card[] { /* … */ }
```

- [ ] **Step 6: 为 C8 加一条判据 —— 证明重试路径仍可被跳过**

```ts
it('规则引擎产出的动作与回填后的动作相同时，判重命中（不触发多余重试）', () => {
  // 构造：让 ruleDecision 与 backfillSuits 对同一手牌产出相同结果
  // 断言：JSON.stringify 比较**相等**（即判重命中）
});
```

Expected: PASS。**这条是 C8 的唯一证据**——没有它，「判重恒不等」这个缺陷不会被任何东西抓住。

- [ ] **Step 7: 收敛剩余报错**

```bash
pnpm --filter @fight-the-landlord/game-service lint 2>&1 | head -60
pnpm --filter @fight-the-landlord/game-service test
```

按报错逐条修。**已知要点**：`view.builder.ts` 组装 `Card[]` 下发；`game.service.ts` 的动作应用与 `applyDecisionToSession` 的 `cards?: number[]` 要改。

- [ ] **Step 8: 提交**

```bash
git add packages/game-service/
git commit -m "feat(game-service)!: game.play 按身份精确摘除（R697）

- handlePlayCards 按 (r,s) 完全相等摘除，找不到即拒
- 两个入口的 DTO 改 Card[]（HTTP game.controller + RPC game.rpc.controller）
- 机器人决策回填：确定性挑法 + 与规则兜底共用同一函数（C8）
- 回填落在既有 JSON.stringify 判重之前，并加判据证明重试路径仍可跳过

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `robot-service`

**Files:** 以 Task 1 的清单为准

**Interfaces:**
- Consumes: `protocol.Card`、`protocol.RobotFeatures`（**保持 rank-only 不变**）
- Produces: robot-service 编译通过、测试全绿

---

- [ ] **Step 1: 收敛编译错误**

```bash
pnpm --filter @fight-the-landlord/robot-service lint 2>&1 | head -60
```

**已知要点**（spec §3.5-E 的订正）：`src/robot/bot.player.ts` 的受影响区间是 **`:139-148`**（`isPlausible(cards: number[], view)`）与 **`:150-151`**（`toCards` 用 `intToCard` 造 Card）——v3 写 `:137-145` 且漏了后半段，**别照着旧清单找**。

⚠️ **`src/robot/douzero.client.ts` 不应改动**（DouZero 接口本就是点数）。若 `tsc` 报它，先怀疑是别处的类型渗过来了。

- [ ] **Step 2: 跑测试**

```bash
pnpm --filter @fight-the-landlord/robot-service test
```

⚠️ `test/bot.player.test.ts` 与 `test/robot.decide.test.ts` 里 view 夹具要变 `Card[]`，而 **DouZero 侧断言（captured 的 hand、`decision.cards`）必须保持 `number[]`**。注意 `robot.decide.test.ts` 里 `keyRank: 15` 的地方**必须改 17**（R695）。

- [ ] **Step 3: 提交**

```bash
git add packages/robot-service/
git commit -m "feat(robot-service): 适配 Card[] 形状，DouZero 契约保持 rank-only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `room-service` + `api-gateway`

**Files:** 以 Task 1 的清单为准

**Interfaces:**
- Consumes: `protocol.Card`
- Produces: 两个包编译通过、测试全绿

---

- [ ] **Step 1: 确认源码侧是否真的零改动**

```bash
pnpm --filter @fight-the-landlord/room-service lint 2>&1 | head -40
pnpm --filter @fight-the-landlord/api-gateway lint 2>&1 | head -40
```

spec §3.4 的判断是：**`room-service` 源码侧纯透传**（`gateway/game.client.ts:84-87`、`gateway/message.router.ts:316`），要改的只是**测试夹具** —— 但 **v3 的清单里 `room-service` 连一行都没有**。用这里的 `tsc` 输出验证这个判断，若源码也报了，以 `tsc` 为准。

- [ ] **Step 2: 改夹具并跑测试**

```bash
pnpm --filter @fight-the-landlord/room-service test
pnpm --filter @fight-the-landlord/api-gateway test
```

**已知落点**：`room-service/test/ws.gateway.test.ts:595-600` 的 `playerView()` 夹具（`hand: [3,4]`，显式类型 ⇒ 直接编译错）。

⚠️ **`room-service/test/message.router.test.ts:580-589`、`game.client.test.ts:106,112,234`、`api-gateway/test/proxy.gateway.test.ts:616`** 这些 `{cards:[3,4]}` 透传用例，**编译与运行都不受影响**，但 R697 之后它们**不再覆盖任何合法载荷形状**（校验挪到了 game-service）。这是**闸看不见的边缘**——如实记一笔，不要假装它们还有覆盖力。

- [ ] **Step 3: 提交**

```bash
git add packages/room-service/test/ packages/api-gateway/
git commit -m "test(room-service,api-gateway): 夹具适配 Card[] 形状

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `tools`（mock-server + conformance）

**Files:** 以 Task 1 的清单为准

**Interfaces:**
- Consumes: `protocol.Card`
- Produces: conformance 13 个切片全部适配

---

- [ ] **Step 1: 收敛 `tools/mock-server`**

```bash
pnpm --filter @fight-the-landlord/mock-server lint 2>&1 | head -30
```

**已知落点**：`src/scripted-game.ts:103` 的 `cards.map(c => c === 17 ? 15 : c)` 是 R695 后应删的**双编码残留**；文件内的 `viewFor()`（`:170-177`）与 `LastPlayedHand` 字面量也要改；另 `src/index.ts:179` 的 `entry.game.play(mySeat, msg.payload.cards)` 随签名变化（v3 只写了 `scripted-game.ts`）。

⚠️ `:103` 单独删**编译器不报错**，但同文件 `:104-109` 的 `lastPlayedHand` 字面量**必然编译报错** ⇒ 这个残留不可能被漏。

- [ ] **Step 2: 收敛 `tools/conformance`**

```bash
pnpm --filter @fight-the-landlord/conformance lint 2>&1 | head -80
```

**已知要点**：

- `src/lib/ddz-driver.ts` 的 `toInternalRank` 7 处调用（`:24,201,209,211,212,231,233`），含 `extremeByRank()` / `smallestBeatingSingle()` 这类**动作选择**逻辑，不只是断言；
- **9 个切片**受影响（v3 只点了 8 个名字，**漏 `slice-07.2-rpc`**）：`slice-05` / `slice-07.2-{boundary,hardening,rpc,security}` / `slice-08`（自带 `PlayerViewWire`）/ `slice-09` / `slice-10` / `slice-11`；
- ⚠️ **`sameHand` / `sorted` 的 `Number(c)` 退化面是 4 个切片**（`security:75-85`、`boundary:113-123`、`hardening:317-323`、`rpc:211-221` 各有一份逐字副本）——**v3 只点了 security 一个**。`Number({r,s})` = `NaN` ⇒ 同长度手牌**永远「相等」**：`!sameHand(a,b)` 断言变**红**（会被发现），`sameHand(...)` 正断言**假绿**（不会被发现）。**四处都要改成显式比较 `(a.r===b.r && a.s===b.s)`**；
- `slice-11-robot-system.ts:108` 的 `const DOUZERO_2_CODE = 17;`（`:267` 使用）—— 该常量语义未变（17 仍是 2），但**它旁边若有 `toInternalRank` 的注释要一并订正**；
- `slice-09-play-rotation.ts:26` 有句注释描述 `createDeck` 是「`4 花色 × (3..2) + 2 王`」—— `tsc` 不管注释，**要人工改**。

> **判别力自证**（`R115`/`R150`）：改 `sameHand` 之前，先**故意保留一处** `Number(c)` 的旧写法，跑该切片确认它有**恰好一条**断言变红。看到红之后再改。这证明这组断言真的在钉手牌形状，而不是恒绿。

- [ ] **Step 3: 先实测并冻结基线，再跑 conformance**

> ⚠️ **不要照抄本计划或台账里的计数当基线。** 台账里的计数来自**不同日期**的不同门禁记录（实测：`slice-06` 在台账里出现过 94 / 124 / 249，客户端测试出现过 169 / 251 / 276 / 279 / 281）。混抄会得到一个**假基线**，而假基线的后果是「计数下降也看不出来」——正是本片要防的那类恒绿。

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/conformance test 2>&1 | tee /tmp/conformance-baseline.txt
```

把 13 个切片的**实测计数**逐条记进 `docs/superpowers/plans/2026-09-20-suit-change-surface.md` 的「conformance 基线」一节，注明测量时刻与基线 commit。**这份实测值才是基线**，此后只允许增。

**判别力自证**：故意把某个切片的一条断言注释掉，重跑，确认计数**真的下降 1**。看到下降后改回。这证明「计数」这个量确实反映用例数，而不是恒定的读数。

- [ ] **Step 4: 全量跑，确认不低于基线**

```bash
pnpm --filter @fight-the-landlord/conformance test
```

Expected: 13 个切片全绿，**每个切片的计数 ≥ Step 3 冻结的实测值**。

- [ ] **Step 5: 提交**

```bash
git add tools/
git commit -m "test(tools): mock-server 与 conformance 适配 Card[] 形状

- 删 scripted-game 的双编码残留 c === 17 ? 15 : c
- 4 个切片的 sameHand/sorted 从 Number(c) 改为显式 (r,s) 比较
  （Number({r,s}) = NaN ⇒ 同长度手牌恒等 ⇒ 正断言假绿）
- 补 slice-07.2-rpc（v3 清单漏的第 9 个切片）
- 订正 slice-09 描述 createDeck 的过期注释

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `apps/client`

**Files:** 以 Task 1 的清单为准

**Interfaces:**
- Consumes: `protocol.Card`、`protocol.suitSymbol` / `colorOf`
- Produces: 客户端渲染花色；`data-value` 锚点保持

---

- [ ] **Step 1: 收敛源码（含 3 个 v3 漏掉的组件）**

```bash
pnpm --filter @fight-the-landlord/client lint 2>&1 | head -60
```

**已知落点**（spec §5，**仍以 `tsc` 为准**）：

| 位置 | 改什么 |
|---|---|
| `src/stores/game.ts` | 三处字段变 `Card[]`；getter 纯透传 |
| `src/components/Card.vue` | 花色渲染。⚠️ **`:75` 的 `:data-value="value"` 是必须写死的绑定点**——`value: number` 要改成传 `.r`（或组件直接接受 `Card`）。`data-value` 全仓 **38 行 / 8 个文件**引用，是探针与既有断言的锚点，**语义不得变**（仍是 DouZero 点数） |
| `src/components/Hand.vue` | ⚠️ **`:49` 的 `props.cards[a] - props.cards[b]` 必须换成显式函数式比较器**：两个 `Card` 相减是 `NaN` ⇒ **排序静默变成「不排序」**。**只按协议给的 `r`/`s` 数值**，不得调任何换算函数 |
| **`src/components/PlayArea.vue:22`** | v3 漏：prop `cards: readonly number[] \| null` 变 `Card[]` |
| **`src/components/BottomCards.vue:18`** | v3 漏：prop `cards: number[] \| null` 变 `Card[]`（另 `:36` 的 `<Card :value="0">`） |
| **`src/components/Seat.vue:92`** | v3 漏：`<Card :value="0" size="small" face-down />`。全仓 `<Card>` 调用点**仅 3 处**（`Hand.vue:57`、`BottomCards.vue:36`、`Seat.vue:92`） |
| `src/pages/table/table.vue` | 出牌原样回传 `Card`；⚠️ **`:81-86` 的 `watch(() => store.hand.join(','), …)` 必须改成** `` cards.map(c => `${c.r}-${c.s}`).join(',') `` —— `join(',')` 在 `Card[]` 下是 `"[object Object]"` ⇒ **指纹只剩长度** ⇒ 同长度换牌不清空选中 ⇒ **会把没选的牌发出去** |

- [ ] **Step 2: 为两个静默点各加一条判据**

```ts
it('hand 内容变化（长度不变）时清空选中', () => {
  // 构造：同长度换一张牌
  // 断言：selected 被清空
});

it('手牌排序按花色维度生效', () => {
  // 构造：同点数不同花色的牌
  // 断言：排序结果稳定且符合比较器（证明不是「NaN ⇒ 不排序」）
});
```

Expected: 两条都 PASS；**改造前第二条应红**（NaN 排序不生效）。

- [ ] **Step 3: 先实测并冻结客户端测试基线**

> ⚠️ **同样不要照抄计数。** 台账里客户端测试出现过 169 / 251 / 276 / 279 / 281 五个不同的读数（不同日期）。抄错基线 = 计数下降也看不出来。

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test 2>&1 | tee /tmp/client-baseline.txt | tail -20
```

把 `passed` / `skipped` 的**实测值**记进 `docs/superpowers/plans/2026-09-20-suit-change-surface.md`，注明测量时刻与基线 commit。此后**只允许增**（`.length` / 计数类断言与牌形状无关，**不必全改**；因断言对象消失而必须改的，**改断言不删用例**）。

- [ ] **Step 4: 收敛测试面（18 个文件，v3 只点名了 2 个）**

```bash
pnpm --filter @fight-the-landlord/client test 2>&1 | tail -40
```

按报错逐个修。**已知要点**：
- `test/helpers/fake-socket.ts:94-102` 的 `playerViewFixture`（默认 `hand=[3..17,20,30,3,4]`）要先改，它是下游夹具的源头；
- `test/source-boundary.test.ts` 的 `toInternalRank`（`:96`）**与 `:281` 的第二条清单**都要处理（v3 只说「两条」，实际出现 2 次）；
- **`test/helpers/comment-stripping.test.ts:88-89`**（v3 漏）—— 逐字拷贝源闸的 21 条禁用标识符，源闸删符号后这份**下游拷贝**变死条目（R377 假绿）；
- **`test/card-hand-interaction.test.ts:298,305`**（v3 漏）—— 正则 `/toInternalRank|toDouZero/` 死条目。

> **死条目的处理纪律（R377）**：删掉源闸的符号后，这批拷贝里的同名条目**不会自己失效报警**——它们只是永远不命中。必须**删条目或换同族标识符**，并按该闸既有做法补正负对照，否则「零命中」变成假绿。

- [ ] **Step 5: 真浏览器探针（本片唯一能证明「观感真的变了」的判据）**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client build:h5
node scripts/browser-e2e.mjs --scenario full
```

Expected: 探针 **20/20**（`--scenario full` 会真打完一局再开第二局）。⚠️ 探针**独占**跑：8 容器 healthy + `DEL ratelimit:ws-conn:::ffff:172.19.0.1` + 清残留 vite；`kill -TERM -<pgid>`，**禁止** `pkill -f vite`。

- [ ] **Step 6: App 端构建**

```bash
pnpm --filter @fight-the-landlord/client build:app
```

Expected: DONE。

- [ ] **Step 7: 提交**

```bash
git add apps/client/
git commit -m "feat(client)!: 牌桌渲染花色，手牌回传 Card[]

- Card.vue 渲花色（protocol.suitSymbol / colorOf），data-value 锚点语义不变
- Hand.vue 排序改显式函数式比较器（原 a-b 在 Card 下是 NaN ⇒ 排序静默失效）
- table.vue 手牌指纹改 r-s 拼接（原 join(',') 只剩长度 ⇒ 会发出没选的牌）
- 补 v3 漏的 3 个组件：PlayArea / BottomCards / Seat
- 处理 4 处死条目（source-boundary x2、comment-stripping、card-hand-interaction）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 文档收口 + 总门禁

**Files:**
- Modify: `docs/games/doudizhu.md`
- Modify: `docs/design.md`
- Modify: `docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md`（状态改「已定稿」）
- Modify: `docs/superpowers/plans/2026-09-20-suit-change-surface.md`（收口复核）

**Interfaces:**
- Consumes: Task 1–7 的全部产物
- Produces: 全绿门禁 + 文档与实现同一真源

---

- [ ] **Step 1: 收口 `doudizhu.md` 的「内部 Rank」**

```bash
grep -n '内部 Rank' docs/games/doudizhu.md
```

当前实测 **5 处**：`:54`（§1.4）· `:228`（§5）· `:246`（§6.1 第 5 步）· `:418` · `:420`（§10）。

⚠️ **判据只覆盖其中一部分**（spec §9.4 的 v4 订正）：`§1.3`（`:46` 的「`2` = **15**」）与 `§11`（`:436` 的「内部**编码**」）**不含该字样，`grep` 抓不到**，必须**人工改写这两处**。

```bash
grep -rn '内部 Rank' docs/games/doudizhu.md   # 期望：0
grep -n '2.*=.*15\|内部编码' docs/games/doudizhu.md   # 人工核对，确认无残留第二套编码
```

- [ ] **Step 2: 收口 `docs/design.md`**

⚠️ 该文件「内部 Rank」**0 命中**（v3 的「一并收口」措辞过期）。实际待改点是：
- **§3.6（`:343`）** —— 点名 `toInternalRank()` / `toDouZero()` 为唯一真源，这两个函数已删除；
- **`:1762`** —— C19 行（C19 的成因是双编码，R695 后该缺陷结构上不可能，此处应改为「已由 R695 消除」）。

- [ ] **Step 3: 复核改动面清单 —— 判据 R706 的最终自证**

打开 `docs/superpowers/plans/2026-09-20-suit-change-surface.md`，逐条核对：

- 清单里**每一条**是否都已被某个 task 处理？
- 有没有**实际改了但不在清单里**的文件？（若有一一说明它是从哪条 `tsc` 报错追出来的；追不出来的，说明它属于 spec §3.5 的三类之一）
- Task 1 Step 11 记录的三个计数（shared / client / game-service）**都 > 0** 吗？

**这一步是 R706 判据的闭环**：如果清单与实改不一致，说明「清单来自 tsc」这个前提有问题，必须在这里暴露，而不是留着。

- [ ] **Step 4: 全仓门禁**

```bash
cd /d/Code/pokergame
pnpm run ci
```

Expected: 六阶段全绿。

```bash
turbo run test lint --force      # 期望 29/29 / 0 cached
turbo run build --force          # 期望 10/10
```

- [ ] **Step 5: 把 spec 状态改为「已定稿」**

`docs/superpowers/specs/2026-09-18-suit-protocol-and-assets-design.md` 头部：

```markdown
> **日期**：2026-09-18 · **状态**：设计规格 v4（**已定稿**）
```

- [ ] **Step 6: 提交**

```bash
git add docs/
git commit -m "docs: 花色协议收口 —— doudizhu.md / design.md 与实现同一真源

- doudizhu.md 的「内部 Rank」收口（实测 5 处），另人工改写 :46 与 :436
  （这两处不含该字样，grep 判据抓不到）
- design.md §3.6(:343) 与 :1762(C19) 收口；该文件「内部 Rank」本就 0 命中
- 改动面清单复核闭环（R706 判据的最终自证）
- spec v4 状态改已定稿

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完成判据

协议侧完成的标志是**全部满足**：

1. `grep -rn 'toInternalRank\|toDouZero\|RANK_2' packages/ apps/ tools/` **不含实现**（只剩文档/注释里的历史说明，且须显式标注「已删除」）；
2. `grep -rn '内部 Rank' docs/games/doudizhu.md` = **0**，且 `:46` / `:436` 已人工改写；
3. `pnpm run ci` 六阶段全绿；
4. `turbo run test lint --force` = 29/29 / 0 cached；`turbo run build --force` = 10/10；
5. conformance 13 个切片的计数**不低于**基线（见 Task 6 Step 3）；
6. 客户端 `node scripts/browser-e2e.mjs --scenario full` = **20/20**；
7. `pnpm --filter @fight-the-landlord/client build:app` = DONE；
8. `docs/superpowers/plans/2026-09-20-suit-change-surface.md` 的复核结论为「清单与实改一致」；
9. R697 的三条正负对照（spec §9.3）在**未修复的实现上先红过**，原文记录在计划或 commit 里。

## 自审记录

- **Spec 覆盖**：R695 → Task 1（codec）+ Task 2（Rank2/createDeck）；R696 → Task 1（Card + 三处字段）；R697 → Task 3（精确摘除 + 两条路径）；R706 → Task 1（Step 9–12）+ Task 8（Step 3 闭环）；§4 C8 → Task 3（Step 5–6）；§5 客户端 → Task 7；§9.4 文档收口 → Task 8；§3.5 的三类 → 分散在 Task 1（A 类）、Task 2/5/6/7（B 类）、Task 2/6（C 类）。
- **占位符扫描**：Task 2–7 的「按 `tsc` 报错收敛」**不是占位符**——它们是 R706 方法的执行步骤，每条都给了**确切命令 + 已知落点 + 测试基线**。Task 1 与 Task 8 的全部步骤是完整可执行的。
- **命名一致性**：`backfillSuits`（Task 3 Step 5）在 Task 3 Step 6 的判据里同名引用；`protocol.Card` 的字段名 `r` / `s` 全篇一致；`DOUZERO_2` 在 Task 1（定义）与 Task 4/6（校验）同名。
- **与 spec 的一处显式偏离（已在计划内说明）**：`colorOf` 的签名从 spec 的 `colorOf(s)` 改为 `colorOf(card)`，理由是两张王的 `s` 都是 4、光看花色分不出大小王；spec §3.1 自己写了「protocol 版需自行定王的符号」，本计划即行使该自由。
- **自审时抓到并修掉的一处自身缺陷**：初稿把「测试计数基线」写成了具体数字（客户端 `169 passed`、`slice-06` 199 等），核对台账后发现那些数字来自**不同日期**的不同门禁记录（客户端实测出现过 169 / 251 / 276 / 279 / 281；`slice-06` 出现过 94 / 124 / 249）。**抄错基线的后果是「计数下降也看不出来」——正是本片要防的那类恒绿。** 已改为 **Task 6 Step 3 / Task 7 Step 3 的「先实测、再冻结」**，并各配一条判别力自证（故意制造一次下降，确认读数真的会动）。

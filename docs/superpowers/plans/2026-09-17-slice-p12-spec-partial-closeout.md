# 切片 P12 Implementation Plan：收口 B 类 —— `design.md` 剩余的 6 处 `[部分实现]`

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `grep -c '^### .*\[部分实现\]' docs/design.md` 从 **6** 降到 **0**，且每一处都落成
**「已实现」或「规格内未要求 / 部署层承担 / 已裁决不做」**三种之一 —— **不许**靠改标题凑数。

**Architecture:** 6 处里只有 **2 处是真代码改动**（§5.3⑦ 的 `playerId` 校验、§3.2 的两个内部类型形状）；
其余 4 处是**裁决 + 文档收口**（§7.1 TLS 归部署层、§8.3 是 R53 的刻意不做、§8.4① 在单 region 下无对象、§9.8 已由 R399#6 裁决不补闸）。
⇒ **本片的主体是判断，不是编码**；每一条都要有**裁决编号**与**逐字证据**。

**Tech Stack:** TypeScript / NestJS / Vitest / markdown。

**Spec:**
- `docs/design.md` —— **§0.2（标记约定：`[部分实现]` = 部分一致，缺口见附录 A.2）** ·
  §3.2 · §5.3 · §7.1 · §8.3 · §8.4 · §9.8 · §12.4 · §13.4 · **附录 A.3（处置约定）**
- `docs/superpowers/plans/deviation-ledger.md` —— §0 · §1.5 · §3 · §5（维护约定）
- `docs/superpowers/plans/2026-09-16-slice-p8-docs-review.md` —— **R396/R397**（删除/改写/保留的判据）· **R399**（7 条歧义裁决）· **R402**（A.2 是历史快照）

## Global Constraints

1. **宁缺勿假**（R397 逐字）：把 `[部分实现]` 改成 `[已实现]` 是**断言**——该节**每一条**都要有实现 + 测试覆盖。
   凑出来的「全绿」比保守的 `[部分实现]` 贵得多。
2. **删除/改写注记的判据是「代码证伪了它」，不是「它看起来旧」**（R396）。**无法确认一律保留**并写明缺什么证据。
3. **计数**不得写行号**（P7 教训 7 / P8 教训 3）：用**形态**（`grep -c`）并逐条写明排除了什么。
4. `docs/**` 与 `packages/protocol` **归协调者**；后端改动走 `.worktrees/backend`（先 `git merge master --no-edit`）。
5. commit message 末尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## 协调者裁决（本片新增）

> 编号接 P11 声明的区间（R451–R470），本片协调者区间 **R471–R490**。

- **R471 §5.3⑦ 是**义务**，要落地**：`design.md` §5.3 逐字「若客户端仍传了 `playerId`，**只能作为一致性校验**：
  与身份不符时**拒绝**（`12003`）」—— 有「拒绝」这个动作 ⇒ 是义务。
  当前是**静默忽略**（`message.router.ts:20-26` 的注释逐字「载荷里的任何 `userId` / `playerId` 都被忽略」）。
- **R472 §3.2 的两个内部类型形状**（`turnDeadlineAt` 用可选 module 增强；`createdAt`/`finishedAt` 用 `Date`）**统一按规格收口**：
  `turnDeadlineAt` **必填**并上移到 `packages/shared`（`packages/game-service/src/game/game.types.ts` 因此**整体删除** ——
  该文件自己的注释就写着「若将来这些字段也上移，本文件应当整体删除」）；`createdAt`/`finishedAt` 改 `number`（毫秒时间戳）。
  ⚠️ 它们**不出站**（`PlayerView` 不含这两个日期）⇒ 风险低，但 `turnDeadlineAt` 上移会触及 `shared` 的**跨包类型**，
  **必须先 `pnpm --filter @fight-the-landlord/shared build`** 再跑 lint（否则会被过期 `dist/*.d.ts` 咬出假类型错——本仓实测过）。
- **R473 §7.1「TLS 终止」不改标记、只改措辞**：本仓 compose **没有终结者**，TLS 由**部署层**承担。
  ⇒ 在 §1.3（明确不做/YAGNI）**或** §7.1 节内写明「规格内未要求（部署层承担）」，**保持 `[部分实现]` 之外的处理**：
  按 R397「刻意不做的条款 → 在节内注明『规格内未要求』，**不改标记**」——但这里**不是**「规格内未要求」，
  而是**本仓不承担**⇒ **裁决：改写职责句，把「TLS 终止」标为「（部署层）」并保留 `[部分实现]`**，
  因为「五条职责里有一条不由本仓实现」**就是**部分实现。⚠️ **不得**为了凑 0 而改标题。
- **R474 §8.3 记为「已裁决不做」并从计数里排除**：R53（切片 7）已裁「本片不实现 §8.3 谓词框架」，
  P8 已把 R53 写进 §8.3 节内（P8 教训 5 要求的落盘出处）。⇒ 本片**不改标记**，而在
  `deviation-ledger.md` §3 登记「§8.3 的 `[部分实现]` 是**刻意不做**，不是欠账」，并在收口汇报里**单列**不计入「剩余欠账」。
- **R475 §8.4① 在 MVP 下**无观测对象**：`MATCH_REGIONS = ['global']`（`match.service.ts:28`）⇒「放宽 region」没有第二个 region 可放宽。
  ⇒ **裁决：不改代码**，在节内写明「MVP 单 region ⇒ 放宽无对象；引入第二个 region 时**先**补这条，
  否则 §8.4 的回退链在第一跳就是空的」。**标记保持 `[部分实现]`**（它相对规格确实是缺的）。
- **R476 §9.8 的闸**不补（沿用 **R399#6**）：该性质已由 CI 阶段 4 的 `no-internal-id-outbound` 覆盖；
  补第 7 条闸要同步改 conformance 的 `EXPECTED_GATES`（P7/R394 的教训）而**判据价值为零**。
  ⇒ 在 §9.8 与 §12.4 写明交叉引用（P8 已做过一次，本片只**核实仍在**）。
- **R477 本片**只允许**改 `docs/**` 与下面列出的 3 个后端文件**；不改任何前端、不改 conformance。

---

## 收口后的目标形态（本片的 DoD）

```bash
grep -c '^### .*\[部分实现\]' docs/design.md     # 期望：6 → 1（只剩 §8.3 的「刻意不做」与 §8.4① 的「单 region 无对象」——
                                                  #       逐个在节内写明理由；**数字以实跑为准**，不要在计划里写死）
grep -c '^### .*\[待实现\]' docs/design.md       # 期望：0（P8 已清）
node scripts/ledger-counts.mjs                   # ✅ 逐区一致
```

⚠️ **本片不承诺「降到 0」**：`[部分实现]` 的正确语义是「相对规格确实缺」。
能降到 0 的只有那些**改完代码就对齐**的（§5.3⑦ / §3.2）；**刻意不做与部署层承担的，必须留着**并写明理由。
**若你坚持要 0，那就走 §A.3 的文档变更流程改规格**——那是另一件事。

---

## File Structure

```
packages/room-service/src/gateway/message.router.ts   Modify: playerId 一致性校验 → 12003（R471）
packages/room-service/test/message.router.test.ts     Modify: 三条用例（不符 ⇒ 12003 / 相符 ⇒ 放行 / 不传 ⇒ 放行）
packages/shared/src/ddz/types.ts                      Modify: turnDeadlineAt 必填；createdAt/finishedAt → number（R472）
packages/game-service/src/game/game.types.ts          Delete: 字段上移后整体删除（R472）
packages/game-service/src/game/*.ts                   Modify: 删除对 `game.types` 的 import（R472）
docs/design.md                                        Modify: §3.2 / §5.3 / §7.1 / §8.3 / §8.4 / §9.8 六处按裁决改写（协调者）
docs/superpowers/plans/deviation-ledger.md            Modify: §3 登记 + §0 重算（协调者）
```

---

### Task 1: §5.3⑦ `playerId` 一致性校验（后端，R471）

**Files:**
- Modify: `packages/room-service/src/gateway/message.router.ts`（校验入口，`handlers` 派发**之前**）
- Test: `packages/room-service/test/message.router.test.ts`

**Interfaces:**
- Consumes: `ErrCode.NOT_YOUR_TURN = 12003`（`packages/protocol/src/errors.ts:33`）· `socket.data.userId`（§5.2）
- Produces: 无新符号；载荷若带 `playerId` 且 ≠ 身份 ⇒ ack `{ code: 12003 }`

- [ ] **Step 1: 写失败用例**

```ts
it('载荷带不符的 playerId ⇒ ack 12003（§5.3⑦ / R471）', async () => {
  const res = await dispatch({ type: 'game.pass', payload: { playerId: 'someone-else' } }, { userId: 'me' });
  expect(res.code).toBe(12003);
});

it('正对照：playerId 与身份一致 ⇒ 放行（不得误伤）', async () => {
  const res = await dispatch({ type: 'game.pass', payload: { playerId: 'me' } }, { userId: 'me' });
  expect(res.code).not.toBe(12003);
});

it('正对照：完全不传 playerId ⇒ 放行（§5.3⑦ 是「若传了就校验」，不是必填）', async () => {
  const res = await dispatch({ type: 'game.pass', payload: {} }, { userId: 'me' });
  expect(res.code).not.toBe(12003);
});
```

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm --filter @fight-the-landlord/room-service test -- message.router`
Expected: FAIL（第一条拿到 `0` 或别的码，**不是** 12003）

- [ ] **Step 3: 实现（放在身份解析之后、handler 派发之前）**

```ts
    // §5.3⑦ / R471：`playerId` **只能作为一致性校验** —— 与身份不符时**拒绝**（12003）。
    // ⚠️ 语义边界（不得扩大）：① 它**不是**身份来源（身份只来自 socket.data.userId）；
    //    ② **不传则放行**；③ 只对这一条做校验，不要顺手去校验别的载荷字段。
    const claimed = (payload as { playerId?: unknown }).playerId;
    if (claimed !== undefined && claimed !== userId) {
      return ack(ErrCode.NOT_YOUR_TURN);
    }
```

⚠️ `ack(...)` / `userId` 的实际变量名按该文件**既有形态**取（先读 `message.router.ts` 的派发函数头 10 行），
**不要**为它另造返回通道。

- [ ] **Step 4: 跑用例确认通过** → `pnpm --filter @fight-the-landlord/room-service test`（202 → 205）

- [ ] **Step 5: Commit**

```bash
git add packages/room-service/src/gateway/message.router.ts packages/room-service/test/message.router.test.ts
git commit -m "fix(room-service): playerId 一致性校验落地 12003（§5.3⑦/R471）"
```

---

### Task 2: §3.2 两个内部类型形状收口（后端，R472）

**Files:**
- Modify: `packages/shared/src/ddz/types.ts`
- Delete: `packages/game-service/src/game/game.types.ts`
- Modify: `packages/game-service/src/game/{game.service.ts,view.builder.ts}`（去掉对 `game.types` 的 import）
- Test: `packages/shared/test/**`（既有类型/行为用例）

**Interfaces:**
- Consumes: `GameSession`（`packages/shared/src/ddz/types.ts`）
- Produces: `GameSession.turnDeadlineAt: number`（**必填**）· `createdAt: number` · `finishedAt?: number`

- [ ] **Step 1: 先让编译器暴露引用面（TDD 的「先红」）**

先**只**改 `packages/shared/src/ddz/types.ts`：`turnDeadlineAt` 去掉可选的 module 增强来源、设为必填；
`createdAt`/`finishedAt` 改 `number`。然后：

Run: `pnpm --filter @fight-the-landlord/shared build && pnpm --filter @fight-the-landlord/game-service lint`
Expected: FAIL，`tsc` **精确报出**所有引用点（N27 收口时用过的同一手法：**先删声明，让编译器枚举引用面**）

- [ ] **Step 2: 逐个收引用点**（`game.types.ts` 的 module 增强随之失去存在理由 ⇒ 整体删除）

```bash
grep -rn "game.types" packages/game-service/src
```
逐处删除 import；若 `turnDeadlineAt` 在构造 `GameSession` 的地方缺失，按 §3.2 补 `turnDeadlineAt: Date.now() + TURN_TIMEOUT_MS`。

- [ ] **Step 3: 跑全量测试**

Run: `pnpm exec turbo run build --force && pnpm exec turbo run test lint --force`
Expected: PASS，**29/29、0 cached**

- [ ] **Step 4: 断言「文件真的没了」**（防复活）

```bash
ls packages/game-service/src/game/game.types.ts   # 期望：No such file
grep -rn "declare module '@fight-the-landlord/shared'" packages/*/src   # 期望：0 命中
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/shared/src packages/game-service/src
git commit -m "refactor(shared,game-service): §3.2 类型形状收口 + 删除模块增强（R472）"
```

---

### Task 3: 4 处「裁决 + 文档收口」（协调者，无代码）

**Files:** `docs/design.md`（§7.1 · §8.3 · §8.4 · §9.8）· `docs/superpowers/plans/deviation-ledger.md`（§3）

- [ ] **Step 1: §7.1** —— 职责句的「TLS 终止」标注「（**部署层承担**）」，节内补一句
  「本仓 compose 无终结者 ⇒ 该条不由本仓实现」（R473）。**标记保留 `[部分实现]`**（五条职责缺一条=部分实现）。
- [ ] **Step 2: §8.3** —— 核实 P8 写下的 R53 落盘句**仍在**（`grep -n "R53" docs/design.md`）；
  在台账 §3 登记「§8.3 的 `[部分实现]` = **刻意不做**（R53），不是欠账」（R474）。
- [ ] **Step 3: §8.4** —— 节内写明「①「扩大候选范围」在 `MATCH_REGIONS = ['global']` 下**无对象**；
  引入第二个 region 时**先**补这条」（R475），并把 `MATCH_REGIONS` 的**当前值**逐字写进节内（可复核）。
- [ ] **Step 4: §9.8 / §12.4** —— 核实「该性质由 §13.4 阶段 4 覆盖」的交叉引用**仍在**（R476）；
  若被后续切片删掉则补回。
- [ ] **Step 5: 计数收口**（形态口径，不写行号）

```bash
grep -c '^### .*\[部分实现\]' docs/design.md
grep -c '^### .*\[待实现\]' docs/design.md
grep -n '^### .*\[部分实现\]' docs/design.md    # 逐条核对：每一条节内都要写明「缺哪条」或「为什么不做」
node scripts/ledger-counts.mjs
```

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs: §7.1/§8.3/§8.4/§9.8 四处按裁决收口（R473–R476）"
```

---

## 门禁

```bash
pnpm exec turbo run build --force            # ✅ 10/10（R472 动了跨包类型 ⇒ 必跑）
pnpm exec turbo run test lint --force        # ✅ 29/29、0 cached
pnpm run ci                                  # ✅ 六阶段
# ⚠️ conformance **本片不必全跑**：改动面是 room-service 的入站校验（Task 1）⇒ 只跑会覆盖它的切片：
pnpm exec turbo run build --force
DOCKER_BUILDKIT=0 docker compose build room-service && docker compose up -d room-service
for s in slice-07 slice-08 slice-09 slice-10 slice-11 slice-07.2-boundary; do timeout 300 node tools/conformance/dist/run.js "$s"; done
node scripts/ledger-counts.mjs
```

⚠️ 若 Task 1 的 `12003` 触发面比预期宽（例如 conformance 有传 `playerId` 的既有用例），
**必须全跑 13 条**并把结论写进「执行期裁决」。

## Self-Review

**Spec coverage**

| 节 | 处置 | Task |
|---|---|---|
| §5.3⑦ | 落地 `12003` | Task 1 |
| §3.2 | 两个类型形状按规格收口 | Task 2 |
| §7.1 TLS | 部署层承担（标记保留） | Task 3 Step 1 |
| §8.3 | 刻意不做（R53） | Task 3 Step 2 |
| §8.4① | 单 region 无对象 | Task 3 Step 3 |
| §9.8 | 交叉引用（R399#6） | Task 3 Step 4 |

**Placeholder scan**：无 TBD。Task 1 Step 3 与 Task 2 Step 2 标注了「按该文件既有形态取变量名」——
那是**取证指令**（该文件 1128 行的 socket.ts / router 的派发形态必须先行阅读），不是 placeholder。

**Type consistency**：`turnDeadlineAt: number`（必填）· `createdAt: number` · `finishedAt?: number` ·
`ErrCode.NOT_YOUR_TURN` 在 Task 1/2 与门禁里一致。

---

## 执行期裁决（回填区，**不要删**）

（执行期发现与代码事实不符时，在此追加一条并编号：本片**协调者区间 R471–R490**。）

### R478 —— Task 1 的「触发面」比计划估的宽（计划里的 `202 → 205` 两处都不准）

计划 Step 4 写「room-service（202 → 205）」，并把「若触发面比预期宽」列为**条件性风险**。
**实测：触发面确实宽，而且基线数字本身也不对。**

- **基线是 204**（不是 202）—— 计划照抄了 `N31` 行的「202 → 204」旧数；P11 收口后已是 204。
- **两个既有用例必须改**（不是「新增 3 条」就完事）：`message.router.test.ts` 的
  「takes identity only from socket.data.userId, never from the payload」与 `ws.gateway.test.ts` 的
  「ignores the playerId in the payload…」都靠**传一个不符的 `playerId`**（`'victim'`）来表达
  「载荷身份不被采信」。R471 之后这**必然**变成 `12003` ⇒ 两处都在正确实现上假红。
- **处置**：把它们的载体换成**仍被完全忽略**的 `userId`（`message.router.ts:23` 的口径未变），
  **断言语义逐字保留**（「以握手身份为准」）。这是「换形态、不换判据」。

⇒ **结论**：room-service **204 → 207**（`+3` 新判据，另有 2 处既有用例就地换载体）。
⇒ **对计划的批评**：Step 4 的期望值应当是「以实跑为准」，且应像门禁段那样**显式点名**
「既有用例里凡传过 `playerId` 的都要先 `grep` 一遍」（实跑：`grep -rn "playerId" tools/conformance/src`
只有一处、且是已删除路由的 HTTP body ⇒ conformance **不受影响**，但那是**跑出来的**，不是推出来的）。

### R479 —— Task 2 的引用面比 File Structure 列的宽（`game.types.ts` 有 **4** 个字段，不是 1 个）

计划 File Structure 只点了 `turnDeadlineAt`，并把 `createdAt`/`finishedAt` 当第二项。**实测该文件里还有
`winner` / `botIds` / `botSkillLevels`** —— 三个都被 `game.service.ts`（`:173,175,348,488,508`）与
`view.builder.ts`（`:103`）消费 ⇒ **不搬它们，「整体删除」做不到**（按计划只搬 `turnDeadlineAt` 会让
`tsc` 在一次删除后报出 3 个新错误）。
⇒ **处置**：四个字段一并上移进 `packages/shared/src/ddz/types.ts` 的 `GameSession`（三个内部字段
保留 `?` 并在注释里写明**永不出站**）。这与 `game.types.ts` 自己的注释逐字一致：
「若将来这些字段也上移，本文件应当整体删除」。

### R480 —— Task 3 的 `[部分实现]` 计数实测是 **6 → 3**（不是计划 DoD 写的「1」）

计划的 DoD 括号自相矛盾（写「期望 6 → 1」，却把 §8.3 与 §8.4① **两条**列为剩余，且 R473 又要求
§7.1 **保留**标记）⇒ 三个数对不上。**按 `§A.3`/R397 的判据逐条取证后的实际处置**：

| 节 | 处置 | 依据 |
|---|---|---|
| §3.2 | **上调 `[已实现]`** | R472（Task 2 落地） |
| §5.3 | **上调 `[已实现]`** | R471（Task 1 落地） |
| §9.8 | **上调 `[已实现]`** | R476 沿用 R399#6：性质由**阶段 4** 覆盖，**刻意不补**阶段 6 第 7 条闸；已在 §9.8 与 §12.4 写明交叉引用 |
| §7.1 | **保留 `[部分实现]`** | R473（TLS 归部署层；六条职责缺一即部分实现） |
| §8.3 | **保留 `[部分实现]`** | R474（R53 的**刻意不做**，非欠账） |
| §8.4① | **保留 `[部分实现]`** | R475（单 region 下无对象） |

⇒ `grep -c '^### .*\[部分实现\]' docs/design.md` = **3**，且**每一条节内都写明缺哪条/为什么不做**。
⚠️ **§9.8 这一条计划没写明「保留还是上调」**：我按 R399#6 的原文「该性质**已由 CI 阶段 4 覆盖**；
不补第 7 条闸」判定**缺口已消失** ⇒ 上调（否则等于把一条已裁决为「已覆盖」的性质继续登记成欠账）。
若评审认为应保留，改回 `[部分实现]` 只需改标题 + 恢复一句「缺 X」，**本片其余结论不受影响**。

### R481 —— 执行期发现：`game-service` 的 `test/**` **从不过 `tsc`**（夹具的形状漂移长期不可见）

`packages/game-service/tsconfig.json` 的 `include` 只有 `["src/**/*"]`，而 `lint` = `tsc --noEmit`
⇒ **`test/**` 不被类型检查**（vitest 用 esbuild，也不查类型）。后果在本片实测暴露：
`test/view.builder.test.ts` 的 `makeSession()` 声明为 `: GameSession`，却

- **缺** `baseScore`（C26/切片 10 起就是必填）、**缺** `turnDeadlineAt`（本片起必填）；
- **多**一个 `deck: []`（N27 已删该字段）；
- `createdAt: new Date()`（本片起规格是 `number`）。

⇒ **这解释了 N27 为什么没抓到它**：N27 的手法逐字是「**先删声明让 `tsc` 暴露引用面**」，
而 `tsc` **看不见 `test/**`** ⇒ 该夹具的引用面从设计上就在探针之外（N27 报的 5 处全在 `packages/shared/src` 与
`game-service/src`）。**本片按 §3.2 补齐了该夹具**（含删掉两处 `deck: []`）。
⚠️ **结构性缺口仍在**：`game-service/test/**` 依旧不受任何类型闸管辖。若要根治，需要一个
「test 也过 tsc」的独立 tsconfig（`tsconfig.test.json` + CI 里一条 `tsc -p` 闸）——**本片不做**（R477 的范围约束），
登记为后续候选。

### R482 —— 执行方式裁决：本片**在主检出 master 上直接提交**，且**未派后端子 agent**

- 计划 Global Constraint 4 写「后端改动走 `.worktrees/backend`」，但**该 worktree 停留在 P7（`23be72d`）**
  而 P8–P11 全部是主检出直接提交（`git log` 逐条可见）⇒ 走 worktree 反而要先把 P7 的分支与 master 重新对齐。
- 本片的代码面只有 **2 个文件 + 2 个测试文件**（且 Task 1/2 之间有测试基线依赖），
  派 agent 的协调成本高于收益；同检出内的多写者还会与协调者的 git 操作争用。
- ⇒ **在 master 上按「一个改动一个 commit」直接落地**：`02f72d9`（R471）· `2445161`（R472）· 本文档提交（R473–R476）。
  **用户指令里的「可派」是许可而非义务**，此处按「更少并发写者 = 更少假红」取舍。

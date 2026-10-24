# 独立小片 P7 实施计划：收掉最后两条真缺陷（R253 同族判据 · 遗留第二契约）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `deviation-ledger.md` §3 里**仅有的两条「代码相关」遗留**收掉 —— 它们是 P6 之后台账里最后两条**真缺陷**：
1. **B1**：`slice-07.2-rpc` 第 6 组**仍有**一条与 R253 同族的**相对量**池判据（`poolAfterSecond.length === poolAfterFirst.length`）⇒ 按 **R340** 已定型的解法换成绝对性质；
2. **B2**：`packages/shared/src/protocol/message.ts` 是一份**与 §6.1/§6.2/§6.3 直接冲突的「遗留第二契约」**，仍被 `shared/src/index.ts` 导出、**0 个消费者**、**无任何闸守着** ⇒ 按 **R361** 整条删除（含它的测试与覆盖率排除项）。

**Architecture:** 本片**不加功能、不动分层**。两个设计取舍：① **B1 照抄已实证的解法**（R340 的三条绝对性质 + 纯谓词 + **窗口紧贴被测动作** + 判别力自证）—— 不再重新设计，因为 P6 已经把「窗口边界」这个坑实测出来了（宽窗口 1 条违规 / 窄窗口 0 条）；② **B2 选择删除而不是标 deprecated** —— 它违反的是本仓**反复付过代价的那条原则**（「同一事实不得有两个真源」），而「标 deprecated 保留」等于让一个与规格矛盾的契约继续存在于**唯一契约包的旁边**，且它的类型名与真契约**重名易误 import**（见 R361 的判据）。

**Tech Stack:** TypeScript / Vitest / pnpm workspace + Turborepo / Docker Compose / conformance（`tools/conformance`）

**Spec:**
- `docs/design.md` —— **§6.1（心跳，逐字）· §6.2（消息信封，逐字「没有 `seq` 字段」）· §6.3（消息清单）· §4.2（RPC 契约）· §9.6（池）**
- `docs/superpowers/plans/deviation-ledger.md` —— §3 的两条新登记（P6 写的）· §1.5 N22/N26 · §5 维护约定
- `docs/superpowers/plans/agent-briefs.md` —— 「切片 P3/P4/P5/P6 新增的通用教训」（尤其 P6 的**相对量判据收尾**与新第 5 条「计划里的事实断言也要被 agent 复核」）
- `docs/superpowers/plans/2026-09-16-slice-p6-engineering-debt.md` —— **R340/R341** 的原文（B1 的解法真源）

---

## Global Constraints

逐字照抄 `2026-09-13-parallel-dev.md`（端口 / Vitest / `Transport.TCP` + `@MessagePattern` / 对外 REST 与内部 RPC 不共用方法 / socket.io ack / `baseVersion` CAS + `13004` / 5 位数字错误码 / 身份只从网关注入 / 裁剪 / 牌值编码 / 前端哑终端 / **`packages/protocol` 协调者独占、是唯一契约源**）。

### 本切片的绑定数值

| 项 | 值 |
|---|---|
| B1 的判据面 | `tools/conformance/src/slices/slice-07.2-rpc.ts` 的**第 6 组**（`robot.acquire` 幂等，现 `:755-771`） |
| **要删的**判据（相对量） | `checks.eq(poolAfterSecond.length, poolAfterFirst.length, …)`（现 `:766-771`） |
| B1 必须保留的既有断言 | 两次 acquire 返回**同一个** `botId` / **同一个** `displayId`（现 `:764-765`） |
| B1 的窗口边界（R340 已实证） | 窗口**右端紧贴第 2 次 `rpcCall`**；**不得**用「第 1 次 acquire 之后」那次读当左端（会继承旧等式的假红） |
| B2 的删除面 | `packages/shared/src/protocol/message.ts` + `packages/shared/src/protocol/message.test.ts` + `packages/shared/src/index.ts` 的那一行 re-export + `packages/shared/vitest.config.ts` 的 `exclude` 项 |
| 门禁（协调者） | `turbo run test lint --force`（**29/29**）· `build --force`（10/10）· `pnpm run ci` · 前端三条 · 8 容器 healthy · **13/13** conformance · 覆盖率 |

### 协调者已实测的前置事实（**本片据此划定范围**）

1. **B1 确实还在**（我贴过原文）：`slice-07.2-rpc.ts:766-771` 就是 `poolAfterSecond.length === poolAfterFirst.length` 那条等式。**它与 R253 逐字同形、同一失效机制**（P6 的 conformance agent 实测它在池空/池非空两种前置下**都绿** —— 因为第 2 次 acquire 走幂等路径 `findBound()` 命中即 `continue`、**完全不碰池**）。
2. **B2 的「0 消费者」已用两条独立证据确认**：
   - `grep -rn "ClientMessageType\|ServerMessageType\|ServerEventName\|GameMessage\|ServerEvent\b" packages apps tools --include=*.ts`（排除 node_modules/dist）⇒ 除了**它自己**（`:2/:16/:32/:39`）与**它自己的测试**（`message.test.ts`），**其余命中全部来自真契约包**（`packages/protocol/src/messages.ts` 的 `ClientMessageType`/`ServerMessageType`、`:73` 的 `CLIENT_MESSAGE_TYPES`）与真消费者（`apps/client/src/net/socket.ts`、`tools/conformance/src/lib/{client,ddz-driver}.ts`）。
   - `grep -rn "@fight-the-landlord/shared" apps/` ⇒ **只有 `apps/client/test/source-boundary.test.ts` 的「禁止引用」闸**（`it('源码中没有任何 @fight-the-landlord/shared 的引用')`）⇒ 前端**从结构上**到不了这个文件。
3. **它与规格的冲突是逐字的**（不是「风格旧」）：
   - 含 `'ping'`（`:3`）⇒ 与 §6.1 逐字「**不使用任何应用层 `ping` / `pong` 消息**」冲突；
   - `GameMessage` 含 `seq?: number`（`:34`）⇒ 与 §6.2 逐字「**没有 `seq` 字段**」冲突；
   - `ServerEventName` 里的 `game.deal_cards` / `game.bid_result` / `game.landlord` / `game.play_turn` / `game.card_played` / `game.player_pass` / `game.game_over` / `room.chat_message` / `error` ⇒ §6.3 的消息清单里**都不存在**（`game.bid_result`/`game.play_turn` 台账 §3 已记「已无生产者」）；
   - 它的两个接口是 `{ type, seq?, payload }` / `{ event, data }` ⇒ 与真契约的 `ClientRequestWire = { reqId, baseVersion, timestamp, payload }`（`protocol/src/messages.ts:26-40`）**不同形**。
4. **它的存在还被一处覆盖率配置「供着」**：`packages/shared/vitest.config.ts` 的 `exclude` 里有 `'src/protocol/message.ts'`，理由写着「纯类型声明，编译产物只剩 `"use strict"`」（R290）。删除该文件后，这条排除**必须一并删掉**（否则是遗留的死配置）。
5. **`packages/protocol` 是唯一契约源**：`README.md` 与 `agent-briefs.md` 都逐字写着；本仓为「第二真源」付过多次代价（R23 族、N1 的「同名不同形」）。
6. **切片条数基线（P6 门禁实测）**：`slice-11` **50** · `slice-07.2-rpc` **61** · `slice-07.2-deploy` 104 · `slice-07.2-hardening` 103 · `slice-07.2-boundary` 82 · `slice-07.2-security` 40 · `slice-07.1` 28 · `slice-07` 39 · `slice-10` 185 · `slice-09` 160 · `slice-08` 55 · `slice-06` 174 · `slice-05` 29。**`shared` 单测 171 条**、行覆盖率 **97.58%**。

---

## 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接 P6 的 **R342**，从 **R360** 起。**派工前先查已用最大编号**（P5 教训：划区间前必须查）：
> ```bash
> grep -rhno "R[0-9]\{3\}" docs/ --include=*.md | sed 's/.*://' | sort -u | tail -5   # 现为 …R342
> ```
> **后端 agent 用 R370–R389**，**conformance agent 用 R390–R409**，协调者保留 **R360–R369**。

- **R360 B1 的解法照抄 R340，不重新设计；但**窗口边界与受控构造**必须按 R340/R341 的实测结论落地。**

  **计划怎么写**：P6 的 conformance agent 已把「相对量 → 绝对性质」的完整解法写在计划 `2026-09-16-slice-p6-engineering-debt.md` 的 R340/R341 里。
  **裁决**：**逐字沿用**，因为 P6 已经把两个反直觉的坑实测出来了：
  1. **窗口右端必须紧贴第 2 次 acquire** —— 若用「第 1 次 acquire 之后」那次读当左端，**新判据会继承旧等式的同一个假红**（P6 实测同一份观测值：宽窗口 1 条违规 / 窄窗口 0 条）；
  2. **受控第三方写入必须 ≥2 个真实成员、且先 acquire 两个再一起 release**（只注入一个时幂等路径不碰池 ⇒ **旧等式照样绿**，构造不出 RED）。
  ⚠️ **但 B1 的载体不同**（`slice-07.2-rpc` 第 6 组 vs `slice-11` 第 6 组）⇒ **`slice-11` 的谓词不得直接复制粘贴**：先读 `slice-07.2-rpc.ts` 第 6 组的**实际**读写顺序（`poolAfterFirst` 在哪读、第 2 次 acquire 在哪调），再决定在哪插一次 `poolMembers()`。⚠️ 若两处的池操作序列**确实逐字相同**，把谓词抽到 `tools/conformance/src/lib/**` 作为**唯一实现**（并在两处引用它，**不得**留两份副本 —— 那就是本片要消灭的东西）。

- **R361 B2 的处置：**整条删除**（文件 + 它的测试 + `index.ts` 的 re-export + 覆盖率排除项），不是「标 deprecated 保留」。**

  **计划怎么写**：P6 的 agent 发现它并建议「登记进 §3 或立 N 条（整体删除或显式 deprecated 标注）」；`deviation-ledger.md` §3 登记为「**未立条**」。
  **事实是什么**（见前置事实 2/3/4/5）：**0 个生产消费者**（含前端结构性不可达）、与 §6.1/§6.2/§6.3 **逐字冲突**、类型名与真契约**重名**、**无闸**、还被一处覆盖率 `exclude` 供着。
  **裁决：删除。** 三条理由：
  1. **它违反的是本仓付过多次代价的那条原则**（「同一事实不得有两个真源」）。「标 deprecated 保留」= 让一个**与规格矛盾的契约**继续躺在**唯一契约包旁边** —— 下一个 session 仍会 grep 到它、仍可能误 import。
  2. **它的类型名与真契约重名**（`ClientMessageType`/`GameMessage`…）⇒ 误 import 的后果不是编译错，而是**静默用了错的那份**（`seq` 字段「合法」、`'ping'` 消息「合法」）。
  3. **YAGNI**：它不是「将来要用的接口」，而是早期骨架的残骸（§6.3 的消息清单里没有它任何一条）。
  ⚠️ **落地清单（4 处，缺一不可）**：① 删 `packages/shared/src/protocol/message.ts`；② 删 `packages/shared/src/protocol/message.test.ts`；③ 删 `packages/shared/src/index.ts` 的 `export * from './protocol/message';` 行；④ 删 `packages/shared/vitest.config.ts` 的 `exclude` 项 `'src/protocol/message.ts'` **及其注释**（并把注释里「两个文件」的表述改成实际剩下的那个）。
  ⚠️ **判据（必须自证）**：① `grep -rn` 那五个类型名 ⇒ **零命中**（除真契约包的同名导出）；② `pnpm --filter @fight-the-landlord/shared test:coverage` ⇒ **绿**、且**行覆盖率不下降**（删的是纯类型文件 ⇒ 预期**略升或持平**）；③ **一条防复活的机械闸**：新增源码闸断言 `packages/shared/src/**` 里**不得出现** `'game.deal_cards'` / `'game.bid_result'` / `'game.play_turn'` / `'game.card_played'` / `'game.player_pass'` / `'game.game_over'` / `'room.chat_message'` 这些**已废除或从未存在的**消息名（§6.3 是清单真源），并带**判别力自证**（注入一行 ⇒ 必须红）。
  ⚠️ **如果 agent 在核实中发现它其实有消费者**（与前置事实 2 矛盾）⇒ **立刻停手并上报**，不要删（P6 教训：计划里的「零命中」是协调者测的，但采样点可能漏）。

- **R362 门禁的期望值必须按**实际运行**更新，不得沿用 P6 的计数。**

  **事实**：删除 B2 会改变 `shared` 的单测条数（现 **171**）与文件数；B1 会改变 `slice-07.2-rpc` 的条数（现 **61**，预计 +4 —— 与 R340 的 `slice-11` 同款：三条正对照 + 一条负对照）。
  **裁决**：门禁里**先跑、后写期望值**；汇报里必须写「P6 基线 → 本片实测」的对照。⚠️ 若 `slice-07.2-rpc` 的条数**没变**，说明新判据没真的加进去（或自证被省了）⇒ **那是缺陷，不是省事**。
  ⚠️ **`slice-11` 的 50 项不得回归**（B1 若把谓词抽到 `lib/` 并改了 `slice-11` 的引用，必须证明它仍 50 项绿）。

- **R363 本片**不得顺手清理 `design.md` / `doudizhu.md` 的其余过期注记。**

  **事实**：`design.md` 仍有 **22 处**未核实的内联 `[偏差]` 与 **18 处** `[部分实现]`/`[待实现]` 标题标记；`doudizhu.md` 有 2 条过期注记（都已登记在台账 §3）。
  **裁决**：**本片只做 B1+B2**（R362 的门禁 + 两处改动已经够一次收口）。文档复审是**独立的下一片**（它需要逐节核对「实现是否真的完成了这一节的全部条款」，与代码改动混在一起会让「门禁红了到底是哪一类」变得不可判）。⇒ 本片汇报里**明确写**「文档复审未做」。

---

## 执行模型（与切片 5–11 / P3–P6 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | 事实核查（**已完成**）、评审、合并、门禁、`docs/**` 收口（台账销两条 + agent-briefs 实测块） |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | **Task 1**（B2 删除 + 防复活闸）。编号区间 **R370–R389** |
| **conformance agent** | `/home/howe/pokergame`（主检出，`tools/conformance/**`） | **Task 2**（B1 判据换形态 + 判别力/抗第三方写入自证）。编号区间 **R390–R409** |
| 前端 | —— | **本片无前端改动**（前端结构性不可达 B2，见前置事实 2） |

**开工前固定动作（两个 agent 都逐字执行）**：

```bash
# 后端 agent
cd /home/howe/pokergame/.worktrees/backend
pwd && git branch --show-current          # 必须输出 feat/backend
git merge master --no-edit                # 协调者已把本计划推到 master
CI=true pnpm install --store-dir .pnpm-store   # ⚠️ 必须带 --store-dir
pnpm exec turbo run build --force

# conformance agent（主检出，master）
cd /home/howe/pokergame
pwd && git branch --show-current          # 必须是 master
pnpm exec turbo run build --force         # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
```

**⚠️ conformance 必须独占跑**（网关按 IP 计并发 WS 连接、上限 5）；跑任何切片期间其他人不得重建/重启容器。
**⚠️ 两个 agent 并发时的纪律**（P6 实证有效）：后端 agent **不得**动任何容器；conformance agent **独占**容器。

**汇报格式**（统一）：完成情况 / 改动清单（文件 + 一句话 + commit sha）/ 阻塞未完成 / 需要协调者裁决的事项 / 我发现的文档未记录的问题 / 执行期裁决（你的区间）。

---

## File Structure

```
packages/shared/src/protocol/message.ts            **Delete**（B2，R361）
packages/shared/src/protocol/message.test.ts       **Delete**（B2）
packages/shared/src/index.ts                      Modify: 去掉 `export * from './protocol/message'`
packages/shared/vitest.config.ts                  Modify: 去掉 `exclude` 的 `src/protocol/message.ts` + 改注释
packages/shared/test/no-legacy-message-names.gate.test.ts   **Create**：防复活闸（R361 判据 ③）
  （文件名/位置以 `shared` 既有 test 组织方式为准；先 `ls packages/shared/src/**/*.test.ts` 看惯例）

tools/conformance/src/slices/slice-07.2-rpc.ts     Modify: 第 6 组删相对量等式 + 换绝对性质（B1/R360）
tools/conformance/src/lib/**                       （可选）Modify: 把谓词抽成唯一实现（仅当两处池序列确实逐字相同）

docs/superpowers/plans/deviation-ledger.md         Modify: §3 销掉两条登记 + §1.5 记 B2 的处置（协调者）
docs/superpowers/plans/agent-briefs.md             Modify: 门禁实测 + 教训（协调者）
docs/superpowers/plans/2026-09-16-slice-p7-last-defects.md   本文件追加「门禁实测」
```

---

## Task 1（后端 agent）：B2 —— 删除遗留第二契约 + 建防复活闸（R361）

**Files:** 见上 File Structure 的 `packages/shared/**`

- [ ] **Step 1: 先复核「零消费者」（**不得**只信本计划的转述）**
```bash
cd /home/howe/pokergame/.worktrees/backend
grep -rn "ClientMessageType\|ServerMessageType\|ServerEventName\|GameMessage\|ServerEvent\b" \
  packages apps tools --include=*.ts | grep -v node_modules | grep -v "/dist/" | grep -v "packages/protocol/src"
grep -rn "@fight-the-landlord/shared" apps/ --include=*.ts --include=*.vue | grep -v node_modules
```
✅ 期望：第一条除 `packages/shared/src/protocol/message{,.test}.ts` **外零命中**；第二条只有 `source-boundary.test.ts` 的**禁止引用**闸。
⚠️ **若发现真消费者 ⇒ 停手并上报**（R361 的 ⚠️）。
- [ ] **Step 2: 先取「删掉会红什么」的基线 + 覆盖率基线**
```bash
pnpm --filter @fight-the-landlord/shared test:coverage 2>&1 | tail -12   # 记下 All files 行覆盖率与用例数（P6 基线：97.58% / 171 条）
pnpm exec turbo run test lint --force 2>&1 | tail -4                     # 记下 29/29
```
- [ ] **Step 3: 删四处**（见 R361 的落地清单 ①–④）
- [ ] **Step 4: 建防复活闸**（R361 判据 ③）
  新增一条源码级闸：扫描 `packages/shared/src/**`，断言**不得出现**下面这些**已废除或从未存在**的消息名字面量（§6.3 是清单真源）：
  `'game.deal_cards'` · `'game.bid_turn'` · `'game.bid_result'` · `'game.landlord'` · `'game.play_turn'` · `'game.card_played'` · `'game.player_pass'` · `'game.game_over'` · `'room.chat_message'` · `'room.joined'` · `'room.players_updated'` · `'game.match_found'` · `'ping'`
  ⚠️ **必须带判别力自证**（R115/R150）：一条「临时注入一行含 `'game.bid_result'` 的源码 ⇒ 闸必须红」的自证（用临时文件 + `finally` 删除 + 断言删除成功）；**并且**先 `grep -rn` 把这些名字在 `packages/shared/src` 的**实际命中集合**列出来（R150 逐字：写源码闸前先量底数）。
  ⚠️ **注意 `'ping'` 的风险**：它是**通用单词**，可能出现在注释或无关字符串里 ⇒ 若底数 grep 显示它会误报，就**不要**把它放进闸里，并在注释里写明「为什么排除它」（**不得**为了闸好看而放宽整条闸）。
  ⚠️ 闸要做到**零命中是结果、不是状态**（R242/R250 族）：不要写 `NOT_YET_*` 清单。
- [ ] **Step 5: 跑绿 + 覆盖率复核**
```bash
pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ 绿；行覆盖率**不低于** Step 2 的基线
pnpm exec turbo run test lint --force                    # ✅ 29/29（条数可能因删测试而变，**以实测为准**）
pnpm exec turbo run build --force                        # ✅ 10/10
```
- [ ] **Step 6: 提交**（`refactor(shared): 删除遗留第二契约 protocol/message.ts（R361）`）

**Task 1 DoD**：四处删除齐备；覆盖率**不下降**；防复活闸绿 **且** 判别力自证的红原文已取得；`grep` 零消费者原文贴进汇报；「意外发现消费者就停手」的分支已确认未触发。

---

## Task 2（conformance agent）：B1 —— 第 6 组相对量判据换形态（R360）

**Files:** Modify `tools/conformance/src/slices/slice-07.2-rpc.ts`（第 6 组）；可选 Modify `tools/conformance/src/lib/**`

- [ ] **Step 0: 读 R340/R341 原文 + 量 `slice-07.2-rpc` 第 6 组的实际池操作序列**
```bash
cd /home/howe/pokergame
sed -n '/### R340/,/### R342/p' docs/superpowers/plans/2026-09-16-slice-p6-engineering-debt.md | head -80
sed -n '700,775p' tools/conformance/src/slices/slice-07.2-rpc.ts
```
  **先量、再动手**：`poolAfterFirst` 是在哪读的？第 2 次 `rpcCall` 在哪？⇒ 决定 `poolBeforeSecond` 插在哪（R340：**紧贴第 2 次 acquire**）。
- [ ] **Step 1: 取两件「修前」证据**（与 R340 逐字同款；**都要实测原文**）
  **(a) 旧等式会假红**：构造**受控的第三方池写入**（必须 **≥2 个真实成员**、`roomCode` 用**别的**房间号、**先 acquire 两个再一起 release**），落在「第 1 次 acquire 之后、第 2 次之前」⇒ **旧等式必须红**。
  **(b) 旧等式对绝对退化免疫**：两次读都喂空池 ⇒ 旧等式**照样绿**。
  ⚠️ `finally` 里清理你加的成员与 `bot:{id}` 记录，并**断言清理成功**（清理不干净会让**同轮其它切片**假红 —— A7 的 e2e 就是因为这个被刻意不做的）。
- [ ] **Step 2: 换形态**。删掉那条等式，改为**绝对性质**（至少覆盖 R340 的三条）：
  1. **窗口内没有新增池成员**（`poolAfterSecond` 中不在 `poolBeforeSecond` 里的成员必须为空 —— **不是**比较长度）；
  2. **第 2 次 acquire 的那个 bot 不得回池**；
  3. **每个池成员都必须有 `bot:{botId}` 记录**（悬挂为 0 —— 与 `slice-11` 第 5/6 组、本文件第 2 组**同源**）。
  ⚠️ **保留**既有断言：两次 acquire 返回**同一个** `botId` / **同一个** `displayId`。
  ⚠️ **不重复实现**：若 `slice-11` 第 6 组的池序列与本处**逐字相同** ⇒ 把谓词抽到 `tools/conformance/src/lib/**` 作为**唯一实现**并两处引用；若**不同** ⇒ 各自实现并在汇报里写明「为什么不能共用」（**不得**为了共用而把两处的语义拉平）。
- [ ] **Step 3: 自证判别力**（R115）：给新判据配**注入式**反向判据（谓词是纯函数最好）——「造一个窗口内新增成员」「造一个被占用的 bot 回池」「造一个缺记录成员」各必须各报 **1** 条违规，**且每条坏输入只触发一条**（防「抓到的是另一条分支」的空测），再加一条**空窗口负对照** ⇒ 0 条。
- [ ] **Step 4: 抗第三方写入的自证（核心）**：用 Step 1(a) 的**同一构造** —— 注入真实第三方成员后跑**新**判据 ⇒ **必须绿**。⇒ 得到**同一构造下「旧红 / 新绿」的成对对照**，那就是「新形态更稳」的证明。⚠️ 同样 `finally` 清理 + 断言清理成功。
- [ ] **Step 5: 跑（独占，每条套 `timeout`，不传 `CONFORMANCE_STEPS`）**
```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force
pnpm --filter @fight-the-landlord/conformance build
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc   # ✅ 通过（条数按 R362 以实测为准）
timeout 300 node tools/conformance/dist/run.js slice-11         # ✅ **50 项不得回归**
```
  **顺序无关性**（门禁的一部分）：池**空**跑一次、池**非空**（种子 2 个）再跑一次 `slice-07.2-rpc`，两次都绿。
- [ ] **Step 6: 提交**（`test(conformance): slice-07.2-rpc 第 6 组换绝对量判据（R253 同族, R390）`）

**Task 2 DoD**：`slice-07.2-rpc` 与 `slice-11`（50）全绿；**旧等式在受控第三方写入下红的原文** + **新判据在同一构造下绿的原文** + 谓词判别力自证（每条坏输入只触发一条）；池空/池非空两次跑的尾行；探针/注入物清理干净（`git status --short` 只含你的 conformance 改动）。

---

## 门禁（协调者，两个 agent 都 settle **之后**执行；conformance 独占）

```bash
cd /home/howe/pokergame
git merge feat/backend --no-edit

pnpm exec turbo run test lint --force      # ✅ 29/29、0 cached（**条数按 R362 以实测为准**）
pnpm exec turbo run build --force          # ✅ 10/10
pnpm run ci                                # ✅ §13.4 六阶段全绿
pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ ≥ 80% 且**不低于 P6 基线 97.58%**
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 前端回归（预期零改动）

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8 个容器全部 healthy
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ 13/13（`slice-11` **必须仍是 50**；`slice-07.2-rpc` 按实测记新数）
docker compose logs api-gateway | grep -c 'Blocked outbound'   # ✅ 0

# 顺序无关性（门禁的一部分，协调者独立复核）
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc   # ✅ 池空
# 种子：经 robot RPC acquire 两个 → 一起 release ⇒ 池里 2 个空闲成员
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc   # ✅ 池非空

# B2 的回头验收
grep -rn "ClientMessageType\|ServerMessageType\|ServerEventName\|GameMessage\|ServerEvent\b" \
  packages apps tools --include=*.ts | grep -v node_modules | grep -v "/dist/" | grep -v "packages/protocol/src" \
  | grep -v "packages/shared/test/no-legacy"     # ✅ 只应有新增的防复活闸（它的字面量列表）
```

**收口（协调者）**：
1. `deviation-ledger.md`：§3 **销掉** B1/B2 两条登记（改成「✅ 已随 P7 处置」）+ §1.5 记 B2 的处置（若按裁决删了，说明它是「第二真源」而不是「未实现的计划」）；§0 用 `node scripts/ledger-counts.mjs` 重算。
2. `agent-briefs.md`：追加 P7 门禁实测 + 教训（至少两条：**「遗留第二契约」的识别手法**（重名 + 无消费者 + 与规格逐字冲突 + 只有自己的测试在测它）；**为什么选删除而不是 deprecated**）。
3. 本计划文件追加「门禁实测」块。

---

## Self-Review

**Spec coverage**

| 项 | 落在哪个 Task |
|---|---|
| B1 `slice-07.2-rpc` 相对量判据 | Task 2（R360 + 门禁的顺序无关性复核） |
| B2 遗留第二契约 | Task 1（R361，4 处删除 + 防复活闸） |
| 门禁期望值 | R362（先跑后写，`slice-11` 50 不得回归） |
| `design.md` 22 处 + 18 处标题标记 + `doudizhu.md` 2 条 | **明确不做**（R363）—— 独立下一片 |

**Placeholder scan**：无 TBD。B1 的绝对性质写明了三条必须覆盖的性质 + 判别力自证 + 抗第三方写入的成对对照；B2 写明了四处删除清单、零消费者的**两条独立证据**、「意外发现消费者就停手」的退路，以及闸要**先量底数**再定正则（含 `'ping'` 可能误报的例外说明）。

**Type consistency**：B1 保留既有 `botId`/`displayId` 断言、只替换那条等式；若抽谓词到 `lib/`，`slice-11` 第 6 组必须**引用同一个实现**（否则就是两个真源）。B2 删除后 `shared/src/index.ts` 不再导出那些类型名 —— 与 `packages/protocol` 的同名导出**不再冲突**。裁决区间与 P6 不重叠（R360–R369 协调者 / R370–R389 后端 / R390–R409 conformance）。

**⚠️ 本片的三个高风险点（执行时优先验证）**
1. **B1 的窗口边界**（R360/R340 的实测结论）：按「第 1 次 acquire 之后」写左端 ⇒ **新判据继承旧假红**。这是本片最容易做错的一处。
2. **B2 的删除面有 4 处**：只删文件而忘了 `index.ts` 的 re-export 或覆盖率的 `exclude`，会留下「死配置供着一个不存在的文件」（后者会让 vitest 的 exclude 指空）。
3. **门禁的条数**：删测试文件会改变 `shared` 条数、换判据会改变 `slice-07.2-rpc` 条数 ⇒ **先跑后写**；`slice-11` 的 **50** 是硬底线。

---

## 执行期裁决（回填区，**不要删**）

（执行期发现与代码事实不符时，在此追加一条并编号：**后端 agent 用 R370–R389、conformance agent 用 R390–R409**，说明「计划怎么写 / 事实是什么 / 怎么改的」。）

### conformance agent（Task 2 / B1）—— R390–R393（本片 conformance 区间 R390–R409，本次用到 R393）

- **R390 两处池操作序列**不是**逐字相同 ⇒ 谓词抽到 `lib/` 作唯一实现，但 Redis 探针外壳**不**共用。**

  **计划怎么写**（Task 2 Step 2、R360 的 ⚠️）：「若两处池操作序列**逐字相同** ⇒ 把谓词抽到
  `tools/conformance/src/lib/**` 作为唯一实现并两处引用；若**不同** ⇒ 各自实现并在汇报里写明
  为什么不能共用」。

  **事实是什么**（逐行比对两处的**观测点**）：
  - `slice-07.2-rpc:754` 读 A（第 1 次 acquire **之后**，旧等式的左端）→ `:757` 第 2 次 `rpcCall`
    → 两条 `botId`/`displayId` 断言 → `:767` 读 C。**没有窗口左端 B**；四步之间是两次 acquire
    的调度/IO 间隙。
  - `slice-11:998` 读 A → `:1013` 读 B（紧贴第 2 次 acquire 的上一行）→ `:1016` 第 2 次 `rpcCall`
    → `:1032-1033` 两条断言 → `:1035` 读 C。**有**窗口左端 B。
  - 即：**外层顺序同形（读A → [读B] → 第2次 rpcCall → 两条同一性断言 → 读C），但 B 与信息
    语句的有无不同** ⇒ 按计划的字面判据「逐字相同」**不成立**。
  - ⚠️ 但真正会被复制成两份的**不是那个序列，而是纯谓词本身**（三条绝对性质的实现），
    两处**逐字相同**。计划要消灭的是「同一事实的第二真源」，而重复的谓词正是它。
  - ⚠️ 另一个方向（把 `slice-11` 的 `redisCli`/`redisLines` 换成 `lib/redis`）**明确不做**：
    两处的**签名与错误路径语义不同** —— `slice-11` 的 `redisCli` 返回 `{status, stdout, stderr}`
    并由调用方判退出码，`slice-07.2-rpc` 的形态是「退出码非 0 即抛」。拉平会改掉 `slice-11`
    第 5 组既有的错误路径语义 —— 那正是 R360 逐字禁止的「为了共用而把两处的语义拉平」。

  **怎么改的**：新建 `tools/conformance/src/lib/pool-idempotency.ts`，把 `danglingMembers` 与
  `idempotentAcquireViolations` 作为**唯一实现**；`slice-11` 删掉本地的两份定义改为 import，
  `slice-07.2-rpc` 第 6 组引用同一个谓词。两处的**序列与探针外壳各自保留**。
  验收：`slice-11` 仍 **50** 项（硬底线；那条谓词在它第 5/6 两组都在用 ⇒ 抽走后的行为由它自己证明）。

- **R391 「注入 ≥2 个真实成员」在 `seats` 上还有一层：两次 acquire 必须用**各自**的 `seats`。**

  **计划怎么写**（Step 1(a)、R341 逐字）：「必须注入 **≥2 个真实成员**……**先把两个都 acquire，
  再一起 release**」。

  **事实是什么**：`acquire()` 的幂等键**包含 `seats`**（`findBound(roomCode, seat)` 命中即 `continue`），
  而注入器第一版两次都传 `{roomCode: ALT, seats: [1, 2]}`
  ⇒ 第 2 次调用**逐字**返回第 1 次的那**两个** bot（两条 `continue`）⇒ release 同一对 bot 两次
  ⇒ 实测原文 `❌ 注入器：两次注入必须是两个不同的 bot：["bot-a505e054","bot-36da248c","bot-a505e054","bot-36da248c"]`
  （**四个 id、两对相同**）。R341 第 2 点只点了 `takeIdle()` 的 `idleSince` 复用，
  **没**点「`seats` 也在幂等键里」这条 —— 它是同一个坑的第二个入口。

  **怎么改的**：注入器两次调用改传 `seats:[1]` 与 `seats:[2]`（各自一个座位）⇒ 实测拿到两个不同的
  bot（`["bot-a505e054","bot-36da248c"]`），再**一起** release。

- **R392 受控第三方写入的 RED 用**忠实复刻的探针**取，不在切片里插临时代码。**

  **计划怎么写**（Step 1(a)）：「构造**受控的第三方池写入** —— 落在『第 1 次 acquire 之后、
  第 2 次之前』⇒ **旧等式必须红**」。P6 的 R341 第 3 点用「在切片侧 `spawnSync` 一个
  `BLPOP` 握手」的**临时代码**把切片卡在窗口内。

  **事实是什么**：本仓切片里**没有** `redis-cli BLPOP` 这类同步挂起点，要照 R341 做就得在
  `slice-07.2-rpc.ts` 里插一段临时代码 —— 而那是**唯一会被提交的文件**，插入/撤销本身有风险
  （R341 实测还撞到 `spawnSync` 默认 20s `timeout` 把 60s 的 `BLPOP` 先杀掉）。

  **怎么改的**：改用 `tools/conformance/dist/p7-probe.js`（该目录被 `.gitignore` 忽略 ⇒ **不进提交**）
  **逐字复刻**切片的读写序列（同一 `IDEM_ROOM` 形状、同一 `ROBOT_RPC` + `RPC_PATTERNS.robotAcquire`、
  同一 `poolMembers()` 口径），在「读 A 之后」用 `spawnSync` **同步阻塞**本进程、让子进程
  （`p7-inject-third-party.js`）经**正式 RPC** 注入。**在同一份观测值上同时求值三条判据**：
  旧等式（宽窗口 A→C）/ 旧等式（窄窗口 B→C）/ 新谓词（窄窗口 B→C）/ 新谓词（若误用宽窗口）。
  这满足 P3 教训第 1 条的取证要求（「要么在修前代码上实跑，要么用**受控复现**复现同一机制」），
  而且**判别力更干净**：四条判据读的是**同一份** `ZRANGE` 输出，不掺任何时间差。
  ⚠️ 代价（如实登记）：探针是**复刻**而不是切片本身 ⇒ 它证明的是**机制**（旧形态在同一份观测值上红、
  新形态绿），不是「切片进程内那一行会红」。切片内的**新**判据本身由 Step 5 的两次实跑覆盖。

- **R393 新判据的窗口是**读 B → 第 2 次 acquire**（不是纯逻辑意义上的零宽），残留风险已量化。**

  **计划怎么写**（R340/R360）：「窗口**右端紧贴第 2 次 `rpcCall`**」。

  **事实是什么**：实际窗口是「`poolMembers()`（读 B）→ `await rpcCall(...)` 真正发出」这段，
  含一次 `spawnSync redis-cli`（约几十 ms）与一次 TCP 连接建立 ⇒ **仍然不是零宽**：第三方
  `release` 理论上可以落在读 B 之后、acquire 之前。
  但它在本仓**结构上不会**造成误报：`packages/robot-service/src/robot/robot.pool.ts` 里
  **只有 `release()`（`:177`）对池做 `ZADD`**，其余三处都是 `ZREM`（`:219`/`:306`/`:395`，
  归池兜底与 `takeIdle()` 的幽灵清理），`acquire()` 的池侧动作只有 `takeIdle()` 的 `ZREM`
  ⇒ 「窗口内新增成员」只可能来自别的房间/别的运行的 `release`，而窗口已从「两次 acquire 之间」
  收窄到「一次 RPC 调用前后」。

  **怎么改的**：按 R340 落地（读 B 紧贴第 2 次 `rpcCall` 的上一行，中间**不插任何语句**），
  并把这条残留窗口与它的量化写进代码注释与本次汇报，**不**为了让它更稳去动产品代码。
### P7 后端 agent（Task 1 / B2）：R370–R378

- **R370 覆盖率与用例条数的预期：覆盖率必然持平（不可能是「略升」）；条数是 171 → 187（−5 +21）。**

  **计划怎么写**：R361 判据②写「删的是纯类型文件 ⇒ 预期**略升或持平**」；Task 1 Step 5 写「`shared` 的用例条数会变（**预期 −5 左右**，因为它自己的 5 条用例）」。
  **事实是什么**：`packages/shared/src/protocol/message.ts` **本来就在 `coverage.exclude` 里**（R290 为它加的）⇒ 它**从来不在行覆盖率的分母**里。删掉文件 + 删掉那条排除项之后，分子与分母**同时不变** ⇒ 读数**必然逐位相同**。实测：`14 files / 171 tests / All files 97.58%` → `14 files / 187 tests / All files 97.58%`，EXIT=0。⚠️ 条数的「−5」只算了减法，没算新增的防复活闸自己的 **+21**（1 条扫描根哨兵 + 1 条零命中 + 13 条消息名自证 + 5 条类型名自证 + 1 条负对照）。
  **裁决**：判据按「**不低于**基线」执行（持平即通过）；汇报里写明「略升」在机制上不可能出现，并点出**真正的危险动作是「只删排除项、不删文件」**（那才会让读数掉）。条数以实测 187 为准（R362 的「先跑后写」）。

- **R371 Task 1 Step 1 的两条复核命令各有采样盲区（补充三条证据后才够格叫「零消费者」）。**

  **计划怎么写**：只给两条 grep —— ① 五个类型名（`--include=*.ts`，排除 `packages/protocol/src`）；② `@fight-the-landlord/shared` 且只在 `apps/` 下找。
  **事实是什么**：两条各缺三个采样面：① `--include=*.ts` 漏 `.vue`/`.js`/`.mjs`/`.tsx`/`.json`（前端是 Vue 工程）；② 只搜**类型名**，不搜**模块路径** —— 消费者也可以用桶导出 `from '@fight-the-landlord/shared'`、或按路径 import `shared/protocol/message`；③ 第二条只搜 `apps/`，而 `packages/{robot,game,user,room}-service`、`api-gateway` **都**依赖 `@fight-the-landlord/shared`。补测三条命令**全部零命中**（`protocol/message` 路径那条的唯一命中是 `shared/vitest.config.ts` 里我改写的注释与 `.turbo/*.log` 的历史缓存日志）：`grep -rn "protocol/message\|protocol\\message" packages apps tools scripts`（排除 node_modules/dist/.turbo）；`grep -rn "@fight-the-landlord/shared" packages apps tools scripts`（命中集合逐类核对：五个服务 `main.ts`/规则代码的**真实 import**、各包 `package.json` 的 workspace 依赖、`pnpm-lock.yaml`、注释/README、闸与脚本里的命令 —— **没有一处** import 消息类型，决定性证据是同一命令族的五个类型名 grep 零命中）；`grep -rn "ClientMessageType\|…" --include=*.vue --include=*.js --include=*.mjs --include=*.tsx` ⇒ 0。
  **裁决**：结论与前置事实 2 一致（**零消费者**，不触发 R361 的「停手上报」退路），但证据面按上面三条加宽；「零命中是协调者测的、采样点可能漏」这条 P6 教训**确实有实际内容**（前两条命令本身漏了三个面）。

- **R372 `docs/design.md` §6.3 的「旧消息名 → 新消息名（迁移映射表）」逐字指向被删文件 —— 这是第 5 处「指向不存在文件的说明」，本片未改（R363 + `docs/**` 对本 agent 只读）。**

  **计划怎么写**：R361 的落地清单只有 4 处（两个文件 + `index.ts` 的 re-export + `coverage.exclude`），且第 ④ 项特意要求「不要留下指向不存在文件的说明」；R363 又说本片**不得**顺手清理 `design.md`。
  **事实是什么**：§6.3 那张表的第一句逐字写着「**`packages/shared/src/protocol/message.ts` 定义了 24 个旧消息名。实现必须按此表迁移，不得继续下发旧名**」，而该文件已不存在。它的**内容价值仍在**（映射表是 §6.3 判「哪些名字已废除」的真源之一，本片的闸就是照它 + §6.3 清单建的），失效的只是**它指着一个已删除的文件**这一点。另：表里写的「24 个旧消息名」**经实测正确**（`git show f9291da:packages/shared/src/protocol/message.ts | grep -cE "^\s*\| '"` ⇒ **24**，分族为 `ClientMessageType` **11** + `ServerEventName` **13**）—— 记这一笔是因为我落盘前口算成 23 并写进了裁决草稿，被上面那条命令当场推翻（P6 教训 5 的同族：**裁决里的数字必须来自命令，不来自心算**）。
  **裁决**：**不改**（R363 明令本片只做 B1+B2；`design.md` 归协调者的文档复审片）。⇒ 登记给协调者，建议改法二选一：① 把主语从文件改成「§6.3 之前的旧契约（源文件已随 R361 删除）」；② 整表迁到 `deviation-ledger.md` 的历史节并在 §6.3 留一行指针。**不得**因为「文件没了」就把整张表删掉 —— 它是「旧名 → 新名」的唯一映射真源（§6.3 逐字：「错误码有别名表、消息名同样需要」）。

- **R373 防复活闸不能放在 `packages/shared/src/`（会扫到它自己）；计划的 File Structure 与「照 shared 惯例」两条指示互相矛盾，按前者 + 别包源码闸惯例落在 `packages/shared/test/`。**

  **计划怎么写**：File Structure 写 `packages/shared/test/no-legacy-message-names.gate.test.ts **Create**`，**但**同一行又写「（文件名/位置以 `shared` 既有 test 组织方式为准；先 `ls`/`grep` 看惯例）」——而 `shared` 的既有惯例是**14 个测试文件全部内联在 `src/**/*.test.ts`**，`packages/shared/test/` 此前**不存在**。
  **事实是什么**：闸的清单里**必然**包含那些被禁的字面量 ⇒ 放在 `src/` 里它会**扫到它自己**；两条出路都更差：把清单拆成 `'game.' + 'bid_result'`（不可读，且下一个人不会这么写）、或给自身开白名单（R242/R250 明令禁止的形态）。而本仓的**源码级闸**恰恰都在 `test/`：实测 `find packages apps -path "*/test/*.gate.test.ts"` ⇒ **4 个既有**（`api-gateway` 3 个 + `room-service` 1 个），且 `packages/{api-gateway,game-service,robot-service,room-service,user-service}` **五个服务都有 `test/` 目录**用同一种形态（`shared` 此前是唯一的例外：它的 14 个测试文件全部内联在 `src/**/*.test.ts`）。
  **裁决**：落在 `packages/shared/test/no-legacy-message-names.gate.test.ts`（与协调者门禁里的 `grep -v "packages/shared/test/no-legacy"` 逐字一致，也让 `shared` 与其余五个服务的 test 组织方式对齐）。⚠️ 副作用一条（**不是本片引入的例外**）：`shared/tsconfig.json` 是 `rootDir: ./src` + `include: ["src/**/*"]` ⇒ `test/` **不进 `tsc --noEmit`**（`lint` 不管它）；`api-gateway` 的 tsconfig 逐字同形、它的 4 个 `test/*.gate.test.ts` 同样不在 lint 范围内 ⇒ 这是本仓源码闸的**既有形态**。相对路径按 R179 用 `new URL('../src', import.meta.url)` 解析，并配一条**哨兵断言**（扫描集合必须含 `index.ts` 与 `ddz/game.ts`、且非空）证明解析到了真实目录。

- **R374 判别力自证的注入物必须带点前缀：`turbo run test lint --force` 会并发跑 `shared:test` 与 `shared:lint`，探针会被那次 `tsc` 读到（P6 教训 4 的「门禁负载下变成假红」）。**

  **计划怎么写**：只要求「临时注入一行含 `'game.bid_result'` 的源码 ⇒ 闸必须红（临时文件 + `finally` 删除 + 断言删除成功）」。
  **事实是什么**：`turbo.json` 里 `test` 的 `dependsOn` 是 `["build"]`（**同包**）、`lint` 是 `["^build"]`（**依赖包的 build**）⇒ `shared:lint`（`tsc --noEmit`，`include` 覆盖 `src/` 全树）与 `shared:test`+`shared:build` **在同一个门禁里并发**。探针写进 `src/` 时，并发的那次 `tsc` 可能读到一个「本不该存在的源码文件」，让自证变成**并发噪声源**。实测（先量后写）：**点前缀文件不被 tsc 的 glob 收录** —— 把 `export const zzProbe: number = "…";` 放进 `packages/shared/src/.zz-tsc-probe.ts`，`pnpm --filter @fight-the-landlord/shared lint` 仍 **EXIT=0**；删后无残留。
  **裁决**：探针用 `.zz-legacy-contract-probe.ts`（点前缀）；闸的扫描器**不过滤**点前缀（点文件同样受管辖，已在注释写明）⇒ 自证不引入并发噪声，管辖范围不缩小。删除后**断言删除成功且回到零命中**。

- **R375 类型名一族必须是「声明形态」的正则，不能按裸名字匹配（否则在唯一合法的写法上假红）。**

  **计划怎么写**：Step 4 只要求禁**消息名字面量**，没提类型名；但协调者门禁的回头验收命令写了 `| grep -v "packages/shared/test/no-legacy"     # ✅ 只应有新增的防复活闸（它的字面量列表）` ⇒ 隐含闸里会有那 5 个类型名。
  **事实是什么**：R361 的三条理由里最危险的一条是**类型名重名**（误 import 不报错、静默用错的那份）⇒ 闸该守它。但若按**裸名字**禁，`import type { ClientMessageType } from '@fight-the-landlord/protocol'`（**引用唯一契约源**，完全合法）会当场假红 —— 假红最终逼人删闸（R150）。另实测：删文件后，五个类型名在 `packages/shared/src` 的**声明形态**与**裸名字**都零命中。
  **裁决**：两族判据 —— ① 13 个消息名用**带引号的字面量**形态；② 5 个类型名只匹配**声明形态** `\b(?:interface|type|enum|class)\s+NAME\b`（`\b` 保证 `ServerEventName` 不会漏、`ServerEventPayload` 不会误伤），并**配一条负对照用例**：注入 `import type { ClientMessageType, ServerMessageType } from '@fight-the-landlord/protocol';` ⇒ 闸**必须不报**（自证「不假红」与「必须红」是同一套探针）。

- **R376 `'ping'` 不从闸里排除，但必须用「带引号的字面量」形态（底数原文见下）。**

  **计划怎么写**：「⚠️ `'ping'` 是通用单词，可能出现在注释或无关字符串里 ⇒ 若底数 grep 显示它会**误报**，就**不要**把它放进闸里…**不得**为了闸好看而放宽整条闸」。
  **事实是什么**（R150 逐字：先量底数）：
  ```bash
  # 删文件之后，packages/shared/src 里的实际命中集合
  grep -rn "ping" packages/shared/src                      # 0（裸子串：连 pingInterval/mapping 都没有）
  grep -rnE "['\"]ping['\"]" packages/shared/src           # 0（带引号）
  # 删文件之前，13 个名字的命中**全部**落在被删的两个文件里（message.ts 13 行 + message.test.ts 8 行）
  ```
  ⇒ 两种形态当下都零命中，`ping` **不会**误报。但裸子串的**未来**误报面真实存在（仓库别处已有 `pingInterval: 30000` / `pingTimeout`，见 §6.1 的 `[已实现]`）。
  **裁决**：**保留** `ping`，但用带引号的字面量形态 ⇒ 它只命中「真的把 `'ping'` 当消息名写」这一件事。排除它 = 白丢一条判别力（而 §6.1 逐字禁止应用层 `ping`，正是最该被守住的一条）；带引号形态同时消除了通用单词的误报面。闸的注释里写明这段推理与底数。

- **R377 判别力自证要逐个名字各一条（18 条注入 + 1 条负对照），而不是计划要求的那 1 条。**

  **计划怎么写**：「一条『临时注入一行含 `'game.bid_result'` 的源码 ⇒ 闸必须红』的自证」。
  **事实是什么**：只注入一条，只能证明**那一条** pattern 是活的；清单里其余 17 条可能是拼错/转义错/写了自己不匹配的形态（`new RegExp` 的清单是**字符串拼出来的**，比字面量正则更容易死）—— 而清单里的**死条目会让「零命中」变成假绿**（R242/R250 族：本仓已有 `allFilesStillHttp`、`NOT_YET_MIGRATED` 两次「判据恒绿」的前科）。
  **裁决**：`it.each` 对**每一个**禁止名做一次注入式自证，并断言**每条坏输入恰好触发一条**违规（防「抓到的是另一条分支」的空测）；另加 1 条负对照（合法 import 不假红）与 2 条真判据（扫描根哨兵 + 零命中）⇒ 本闸共 **21 条用例**（这也是 R370 里 171 → 187 的 +21 来源）。

- **R378 `tsc` 不清理陈旧产物：删掉源码后 `packages/shared/dist/protocol/message.{js,d.ts,map}` 仍在（本片已在本 worktree 清理并重建验证；主检出/其它 worktree 需注意）。**

  **计划怎么写**：4 处删除清单**隐含**「删了源码就删干净了」；没有任何一步涉及构建产物。
  **事实是什么**：`tsc` 只写不删 —— 删源码后 `turbo run build --force` 不会移除 `packages/shared/dist/protocol/message.{js,d.ts,js.map,d.ts.map}`（实测其内容逐字是 `ClientMessageType = 'ping' | …`、`GameMessage.seq`）与 `message.test.*`。**影响面实测有限**：① `dist/` 是 gitignore 的、且 `.dockerignore` 有 `**/dist` ⇒ **镜像里不会有**；② 新的 `dist/index.d.ts` **不再** re-export `./protocol/message`（实测 grep 零命中）⇒ 这两个陈旧文件**经公开入口不可达**（谁要真用只能写深路径 import，而全仓零消费者）。但它仍是一份「第二契约的尸体」，且**主检出的 dist 同样带这份陈旧产物**。
  **裁决**：本 worktree **清理并重建**（`rm -rf packages/shared/dist && turbo run build --force` ⇒ `dist/protocol` 不存在，10/10 绿）；**不**把「清理 dist」写进门禁（那会把「产物目录是构建副产物」这条约定改掉，且 Docker 构建本就全新 COPY）。⇒ 建议协调者在主检出跑门禁前 `rm -rf packages/shared/dist`（或至少确认 `ls packages/shared/dist/protocol` 不存在），并在收口时记一条「删源码要顺手看产物目录」的教训。

---

### 协调者（门禁期）：R394 —— 把新闸注册进 `ci.sh` 第 6 阶段，**当场撞出 conformance 的一条活判据**

**计划怎么写**：计划**没有**要求把新闸注册进 `ci.sh`（后端 agent 在汇报里把它列为「建议协调者决定」的一项，并注明「不注册也不丢覆盖：阶段 4/5 已经在跑它」）。

**事实是什么**：
1. 我（协调者）**采纳了注册**：`scripts/ci.sh` 第 6 阶段加第 6 条 `run_gate "shared/no-legacy-message-names.gate"`。理由：§12.4 的形态就是「源码级闸逐个列出以便从输出判读覆盖面」，而这个新闸**只**在 `shared` 的测试套件里跑（阶段 4 的 29 个 turbo 任务之一）⇒ 门禁输出里看不到它单独通过与否。
2. **注册立刻打红了 `slice-07.2-hardening`**（第一次全量 13 条跑出 `exit=1`）：
   ```
   ❌ slice-07.2-hardening 失败：探针负对照：真实接线 + 一个「每个过滤名都能找到同名文件」的合成解析器 ⇒ 不报违规：期望 0，实际 1
   ```
   **根因**（读代码得出，不是猜）：那条负对照的合成解析器是
   `(pkg) => EXPECTED_GATES.filter(g => g.pkg === pkg).map(g => `${g.filter}.test.ts`)`
   —— 它**只能**为 `EXPECTED_GATES` 里出现过的包造出文件。新闸属于 `shared`，当时**不在** `EXPECTED_GATES` 里 ⇒ 解析器对 `shared` 返回**空数组** ⇒ `gateWiringViolations` 判「过滤名 `no-legacy-message-names.gate` 匹配不到任何文件（会跑 0 个用例而恒绿）」⇒ 负对照从「期望 0」变成「实际 1」。
3. ⚠️ **这条负对照是活的、不是空测** —— 它抓到的正是「真实 `ci.sh` 里出现了一条 conformance 不认识的接线」。如果它当时**绿**，那才说明它是恒绿的。
4. **修法与它的副作用**：把 `{ pkg: 'shared', filter: 'no-legacy-message-names.gate' }` 加进 `tools/conformance/src/slices/slice-07.2-hardening.ts` 的 `EXPECTED_GATES`（并把「五条闸」表述改成六条）。副作用是**更强的保护**：`missingExpected` 现在也会守住这条闸 —— 它从 `ci.sh` 里静默消失会**红**；而如果我当时选择「撤掉 `ci.sh` 的那一行」来换绿，就同时**失去**这两层保护（这正好是本仓「假红逼人把判据改弱」的教科书形态）。

**怎么改的**：`scripts/ci.sh` +1 条 `run_gate`（收口时与 `docs/**` 一起提交）；conformance 的 `EXPECTED_GATES` +1 条 + 两处「五条 → 六条」表述；**未**动那两条判据的逻辑本身。
**复核**：`pnpm run ci` 第 6 阶段 = `8 / 8 / 5 / 6 / 3 / **21**` passed（新闸 21 条），六阶段全绿；`slice-07.2-hardening` 恢复 **103** 项绿；全量 13 条重跑 13/13。

> ⚠️ **给后来人的一条**：`ci.sh` 的第 6 阶段闸清单与 conformance 的 `EXPECTED_GATES` 是**两份必须同步的清单**（一份是产品、一份是判据）—— **加闸要同时改两处**，漏了第二处就会在门禁里红（这次是好事，因为那条负对照是活的）。别用「撤掉 `ci.sh` 那一行」来换绿。

---

## 门禁实测（协调者，两个 agent 都 settle 之后；conformance 独占）

**HEAD = `3982d50`（合并 `feat/backend`）+ 收口提交**（后端 agent `78c0f15`/`23be72d`；conformance agent `b3c77fc`/`2f171d1`）。
全部 `--force`、**0 cached**。**主检出的 `packages/shared/dist` 已先 `rm -rf` 再重建**（R378：`tsc` 只写不删）。

```bash
cd /home/howe/pokergame
git merge feat/backend --no-edit            # ⚠️ 冲突：两个 agent 各自回填同一节 ⇒ 协调者保留双方（标记行已删）
rm -rf packages/shared/dist                 # ✅ R378：清掉第二契约的陈旧产物
pnpm exec turbo run build --force          # ✅ 10/10, 0 cached ⇒ ls packages/shared/dist/protocol = 不存在
pnpm exec turbo run test lint --force      # ✅ 29/29, 0 cached
timeout 1200 pnpm run ci                   # ✅ CI_EXIT=0 ——「六阶段全部通过」
#  第 6 阶段现 **6** 条闸：client/source-boundary ✓ 8 · room-service/no-internal-http.gate ✓ 8
#    · api-gateway/outbound-timeout.gate ✓ 5 · api-gateway/no-route-outside-api.gate ✓ 6
#    · game-service/rule-error-mapping ✓ 3 · **shared/no-legacy-message-names.gate ✓ 21**（P7 新增）
pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ 187 tests · All files 97.58%（不低于 P6 基线）· EXIT=0
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK
                                           #    （**零前端改动**：产物哈希与 P5/P6 一致）

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8/8 healthy
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ⚠️ **第一轮**：slice-07.2-hardening ❌ exit=1（R394：新闸注册进 ci.sh 但不在 conformance 的 EXPECTED_GATES 里）
# ✅ **修好后第二轮 13/13**：
#   slice-11 50（**硬底线不回归**）· slice-07.2-rpc **65**（61 → +4：三条正对照 + 一条负对照）
#   · slice-07.2-deploy 104 · slice-07.2-hardening **103** · slice-07.2-boundary 82 · slice-07.2-security 40
#   · slice-07.1 28 · slice-07 39 · slice-10 185 · slice-09 160 · slice-08 55 · slice-06 269 · slice-05 29

# 顺序无关性（协调者独立复核，池空/池非空各跑一次）
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc    # ✅ 池空（ZCARD=0）⇒ 65 项
timeout 300 node tools/conformance/dist/run.js slice-11          # ✅ 池空 ⇒ 50 项
# 种子：经 robot RPC acquire 两个 → 一起 release ⇒ ZCARD=2
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc    # ✅ 池非空（ZCARD=2）⇒ 65 项
# 收尾：清掉种子成员与 bot:{id} 记录 ⇒ ZCARD 回到 0

docker compose logs api-gateway | grep -c 'Blocked outbound'                                    # ✅ 0
docker compose logs game-service robot-service | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET'   # ✅ 0

# B2 的回头验收（精确口径）
grep -rn "protocol/message" packages apps tools scripts --include=*.ts | grep -v node_modules | grep -v "/dist/"
#  ⇒ 只剩 3 处**注记性**引用（vitest.config 的历史注释 + 新闸自己的 docblock），无 import
grep -rnE "['\"](game\\.deal_cards|game\\.bid_result|game\\.play_turn|game\\.card_played|game\\.player_pass|game\\.game_over|room\\.chat_message)['\"]" packages/*/src apps/*/src
#  ⇒ 仅 `packages/protocol/src/messages.test.ts`（用它们做「未知消息类型必须被拒」的样本，属 C8 的守卫，合法）
```

**关闭/登记的项**：**B1**（`slice-07.2-rpc` 第 6 组判据换形态，`slice-07.2-rpc` 61 → **65**，谓词抽到 `tools/conformance/src/lib/pool-idempotency.ts` 作唯一实现）· **B2**（删遗留第二契约：2 个文件 + `index.ts` re-export + `vitest.config.ts` 排除项，并新增 21 条防复活闸）· **R394**（新闸注册进 `ci.sh` 第 6 阶段 + 同步 conformance 的 `EXPECTED_GATES`）。
**`shared` 用例数 171 → 187**（−5 删它自己的测试，+21 新闸）；**行覆盖率 97.58% 持平**（R370：该文件本就在 `coverage.exclude` 里、从不在分母）。
**对账表 §0 不变（79 条：78 已关闭 / 0 部分关闭 / 1 仍开放）** —— 本片销掉的是 §3「文档待更新」里的两条登记，不是偏差条目。

**⚠️ 门禁期唯一的红（R394）与它的价值**：见回填区 R394 —— 它证明 `slice-07.2-hardening` 的「接线负对照」是**活判据**，并给出「`ci.sh` 闸清单与 conformance `EXPECTED_GATES` 必须同步」这条规矩。

---

## 下一步

- ✅ 已完成：Task 1–2 → 协调者合并（冲突已解：两个 agent 各自回填同一节，保留双方）、跑门禁、收口 `design.md`（§6.3 历史注记 / §13.3 排除项 / §12.4+§13.4 六条闸）与台账。
- 本片之后：台账里**不再有代码相关的真缺陷**；剩下的只有**文档复审**（`design.md` 22 处 `[偏差]` + 18 处标题标记 + `doudizhu.md` 2 条）与产品向的 **N13**（风控 roadmap §16）。

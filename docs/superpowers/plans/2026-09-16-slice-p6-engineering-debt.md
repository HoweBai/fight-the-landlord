# 独立小片 P6 实施计划：工程债收尾（R253 相对量判据 · `reflect-metadata` 直接依赖 · 过期文档注记 · R119 实证）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收掉 P5 之后**只剩工程债**的那几项 —— 它们都在台账里**只登记、没立条**，因此每个新 session 都要重新核对一遍事实：① `slice-11` 第 6 组那条**相对量**池判据（R253）**换形态**为绝对性质；② 补 `api-gateway` 缺的 `reflect-metadata` **直接依赖**；③ 把 `design.md` 里一批**已被代码证伪**的内联 `[偏差]` 注记清掉、并把 §3「文档待更新」表里**自己已过期**的行销掉；④ **先实证** R119（`GameService.timers` 触发后是否自我清理）再决定立条或关闭。

**本片的价值主张：不加功能，只消除「下一个 session 会重新踩一遍」的认知债。** 每一项都有一条**机械判据**背书，而不是「看起来修过了」。

**Architecture:** 本片**不动分层、不加产品行为**。两个设计取舍：① **R253 的形态** —— 相对量判据（「两次 acquire 之间 `ZCARD` 不净增」）在「多运行共享同一 Redis」的仓库里**不可能稳定**（P3 教训第 2 条：第三方 `release` 是 `void` 异步、`reclaimIdle()` 每 60s 一次），而它对「池退化成 0 / 容量静默丢失」**完全免疫** ⇒ 改为**绝对性质**；② **文档清理以「代码为准」** —— 每条注记删/留都必须附**当前代码的实测证据**，不得凭注记自己的措辞判断（P5 教训：§3 表本身已有 5 行过期，其中一行是协调者上片自己写错的）。

**Tech Stack:** TypeScript / NestJS 10 / ioredis / pnpm workspace + Turborepo / Docker Compose / Vitest / conformance（`tools/conformance`）

**Spec:**
- `docs/design.md` —— §3.1/§3.4/§4.2/§5.5/§6.1/§6.5/§7.1/§9.1/§9.5/§11.4/§12.5（内联 `[偏差]` 与小节标记）· §2.3/§10.1
- `docs/superpowers/plans/deviation-ledger.md` —— §3「文档待更新」全表 · §1.2 E10 · §1.5 N 系列 · §5 维护约定
- `docs/superpowers/plans/agent-briefs.md` —— 「已知环境事实」+「切片 P3/P4/P5 新增的通用教训」
- **本片的来由（协调者逐条实测 + 一次只读审计）**：P5 收口后 MVP 偏差清单已关闭，但**工程债不是偏差**，所以它们既不会被 A.2 的 DoD 覆盖、也不会被门禁抓到。本片把它们立条并清掉。

---

## Global Constraints

逐字照抄 `2026-09-13-parallel-dev.md`（端口 / Vitest / `Transport.TCP` + `@MessagePattern` / 对外 REST 与内部 RPC 不共用方法 / socket.io ack / `baseVersion` CAS + `13004` / 5 位数字错误码 / 身份只从网关注入 / 裁剪 / 牌值编码 / 前端哑终端 / `packages/protocol` 协调者独占）。

### 本切片的绑定数值

| 项 | 值 |
|---|---|
| R253 的判据面 | `tools/conformance/src/slices/slice-11-robot-system.ts` 的 `runIdempotentAcquire()`（**第 6 组**，`roomCode = 'S11IDEM'`、`seats: [1]`） |
| 幂等判据（**保留**，已存在） | 两次 acquire 返回**同一个** `botId` / 同一个 `displayId`（R201） |
| **要删的**判据（相对量） | `checks.eq(poolAfterSecond.length, poolAfterFirst.length, …)`（现 `:953-958`） |
| 池键 | `bot:pool:ddz`（ZSET，无 TTL）；权威记录 `bot:{botId}`（无 TTL）；视图 `bot:room:{roomCode}` / `bot:bound:{botId}`（TTL 3600s） |
| `reflect-metadata` 版本 | 与 `user-service` / `room-service` / `game-service` / `robot-service` **同版本线**（以 `pnpm-lock.yaml` 现有解析结果为准，不新起一条） |
| 门禁（协调者） | `turbo run test lint --force`（29/29）· `build --force`（10/10）· `pnpm run ci` 六阶段 · 前端三条 · 8 容器 healthy · **13/13** conformance · 覆盖率 97.58% |

### 协调者已实测的六条前置事实（**本片据此划定范围**）

1. **R253 仍在**：`slice-11-robot-system.ts:953-958` 就是那条相对量等式。（其余五条 R243/R250 重写的判据已是绝对性质。）
2. **`api-gateway` 确实缺 `reflect-metadata` 直接依赖**：`package.json` 的 `dependencies` 里没有它；今天能跑只因 `@nestjs/common/index.js` 内部 `require` 了它。（`user-service`/`room-service`/`game-service`/`robot-service` 都有。）
3. **R119 的机制已被既有测试实证**：`packages/game-service/test/game.timer.test.ts` 的注释逐字写着 ——「⚠️ 计划 Task 4 Step 1 这里写的是 `timers.has('ROOM-T3') === false`，但**两条实现都做不到** —— 同 ②：触发后的旧句柄仍留在 map 里。真正的判据是『没有安装新计时器』。」并且 `timers` 的唯一消费者是 `clearTimer()` 自己（`grep -rn "timers\.\(has\|size\|get\|keys\)" packages apps tools` 只命中 `game.service.ts:432` 与那条测试注释）⇒ **无内存泄漏（每房一条、可覆盖）、无判据依赖它**。
4. **`design.md` 现有 33 处内联 `[偏差]`**（`grep -n "\[偏差\]" docs/design.md`），其中 §3.1 已清零。**§3 表登记的 13 条里，5 条本身已过期**（注记早被 P3/P4 删掉或改写了）。
5. **`web/` 整个目录已删除**（`5be7522`，A6/S4/S5）⇒ 所有指向 `web/index.html` 的注记（§1.4:92、§3.4:288、§9.1:1010-1013、§12.5:1323-1327、§2.3 的 `WEB_DIR` 行）**都已被代码证伪**。
6. **`design.md` 的小节标题标记与正文自相矛盾**：`:343 ### 4.2 TCP RPC 契约 [待实现]` 而正文 `:437` 已写「`[已实现]`（P4/N20 收口）」；同类还有 `:566 §5.5`、`:774 §6.5`、`:1057 §9.5`。

---

## 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接 P5 的 **R308**，从 **R309** 起。**派工前先划定区间**（P4 教训第 7 条 + P5 教训：**划区间前先查已用最大编号**）：
> ```bash
> grep -rhno "R[0-9]\{3\}" docs/ --include=*.md | sed 's/.*://' | sort -u | tail -5   # 现为 …R308
> ```
> **后端 agent 用 R320–R339**，**conformance agent 用 R340–R359**，协调者保留 **R309–R319**。

- **R309 R119 的正确处置：登记为「已实证、无影响」，并写清「为什么它无害」——不是立条、也不是静默关闭。**

  **事实**（协调者实测 + 既有测试的逐字注释，见前置事实 3）：计时器**触发后**旧 `TimerHandle` 仍留在 `GameService.timers` map 里（`createBidTimer`/`createPlayTimer` 只在 `clear()` 里 `clearTimeout`，回调自身不删表项）。但：
  - `timers` 的**唯一**读取点是 `clearTimer(roomCode)`（`game.service.ts:432`）与 `startTurnTimer` 开头的 `this.clearTimer(roomCode)`（`:417`）⇒ 每房**至多一条**表项，**不是泄漏**（记忆有界）；
  - **没有任何生产或测试判据依赖 `timers.has()` / `timers.size` 表达「有活动计时器」** —— `game.timer.test.ts:195-200` 的「任一时刻至多一个活动计时器」用的是 `size === 1` + 「新句柄 ≠ 旧句柄」，那两条在两种实现下都成立。
  **裁决**：**不改生产代码**（YAGNI：改它要动被 8 个测试文件覆盖的计时器路径，收益是「表项更干净」，风险是「把已验证的对局推进逻辑碰坏」）。**改为**：在 `deviation-ledger.md` §1.2 的 **E 区之后**新增一条 **N26**，判定写「**已实证、无影响**」，并写明「**判据不可依赖 `timers.has`**（若要依赖，必须先让回调自删表项）」。⚠️ **不得**把它写成「已关闭的缺陷」——它不是缺陷，是**一条给后来人的约束**。

- **R310 `reflect-metadata` 只补进 `api-gateway`，且必须实证「补之前会红、补之后会绿」。**

  **计划怎么写**：`agent-briefs.md` 把它登记为「环境事实（已写进 briefs）」并注明「补它会动 `pnpm-lock.yaml`，且今天无实际故障，登记为环境事实」。
  **裁决**：**补它**。理由：① `api-gateway` 是**唯一**一个 `package.json` 里没有它、却**大量使用 decorator**（`@Controller`/`@Injectable`/`@WebSocketGateway`/`@Catch`）的服务 —— 「今天能跑」依赖的是**传递依赖的副作用**；② 它已经**咬过一次**：`agent-briefs.md` 记着「单测里 `import 'reflect-metadata'` 会直接 `Failed to load url`」⇒ 这是**已发生**的摩擦，不是理论风险；③ 本片要动 `pnpm-lock.yaml` 的窗口就是现在（P6 是工程债片，改根配置合理）。
  ⚠️ **判据（必须自证）**：先在**修前**状态取一条 RED —— 在 `packages/api-gateway/test/` 下临时写一个 `import 'reflect-metadata'` 的探针文件 ⇒ 实测 `Failed to load url`（把原文贴进汇报）；补依赖 + `pnpm install --store-dir .pnpm-store` 后 ⇒ 同一个探针**绿**；随后**删除探针**（不留脚手架）。
  ⚠️ 顺带**核实**：`packages/user-service/src/health/health.service.ts` 用的 `@Inject(DataSource)`（`DataSource` 是 TypeORM 的**抽象类**，`@nestjs/typeorm` 注册的 token 实际是 `'DataSource'` 字符串）在补了 `reflect-metadata` 之后是否仍正确解析（既有的 6 条 health 用例会覆盖它；若仍然绿，**不动它**，只在本片汇报里记一条「为何两种 token 都能工作」的说明）。
  ⚠️ 若 `pnpm install` 因沙箱写 `~/.pnpm-store` 失败 ⇒ 带 `--store-dir .pnpm-store`（`.gitignore` 已忽略）；**不得**为此改 `daemon.json` 或系统配置。

- **R311 文档清理的判据是「代码」，不是「注记的措辞」；每条处置必须附当前代码/文件系统的实测证据。**

  这是 P5 的直接教训：§3 表里 13 行有 **5 行本身已过期**（§3.1 注记早在 P3 `182c660` 被删；§2.3 / §10.1 / §4.2 已被 P3/P4 修好；§5.5 那一行**从来就指错了位置** —— `design.md` 的 §5.5 从第一版起就只有标题标记、没有内联 `[偏差]`）。⇒ **规则**：
  1. 每条注记的处置（删/改写/保留）必须附 `grep`/`read` 的**原文**；
  2. **删注记**之前必须证明「注记陈述的事实已被代码证伪」——即找到**当前代码**里实现该行为的行（本片由后端 agent 逐条取证）；
  3. **保留**的也要写理由（例如「注记仍成立」或「无法确认 ⇒ 不删」）——**不得**因为「看起来像旧的」就删。
  ⚠️ **无法确认的项一律保留 + 在台账里写「无法确认 + 缺什么证据」**（§5 第 5 条的精神：宁可多一条挂着的，也不要删掉一条真注记）。

- **R312 本片清理的范围就是 §3 表点名的位置，外加它漏登但同源的 `web/` 簇 —— 不做全库 `[偏差]` 普查。**

  **事实**：`design.md` 现有 **33** 处内联 `[偏差]`，§3 表只点名了其中约 10 处；协调者实测又有 5 处**同源**（都因 `web/` 删除而作废：`:92` §1.4、`:288` §3.4、`:1010-1013` §9.1、`:1323-1327` §12.5、`:144` §2.3 的 `WEB_DIR` 行）。
  **裁决**：本片清理 = **§3 表点名的 + 上述 `web/` 簇**（都是「已被删除的文件/已关闭的偏差」这一类，判据硬、争议小）。**其余 20 余处一律不动** —— 它们需要逐条读代码才能判，且**未在任何台账里立条**。⇒ 在 `deviation-ledger.md` §3 追加一行**明确登记**「`design.md` 仍有约 20 处未核实的内联 `[偏差]`，**未立条、未处置**」+ 给出**一条可复现的枚举命令**（`grep -n "\[偏差\]" docs/design.md`），这样下一个人不必再凭印象判断「还有多少」。
  ⚠️ **推论的推论**：本片**不**宣称「`design.md` 的注记已清干净」。汇报里必须写清**还剩多少**。

- **R313 小节标题标记（`[待实现]`/`[部分实现]`）只改「正文已写 `[已实现]`」那种**自相矛盾**的，不改其余。**

  **事实**：至少四处自相矛盾或已证伪：`:343 §4.2`（正文 `:437` 已写 `[已实现]`）、`:566 §5.5`（脱敏已实现，S7）、`:774 §6.5`（CAS 已实现）、`:1057 §9.5`（已实现，S4/N20）。
  **裁决**：这四处改成 `[已实现]`（并各补一句「谁关的」）。**其余标记不动** —— 「`[部分实现]` 是否已该升级」需要逐节核对全节条款，**不在本片范围**（同 R312 的理由）。⚠️ 每一处改动都要在注记里写清**依据的 commit 或裁决号**，否则下一个人无法复核。

---

## 执行模型（与切片 5–11 / P3 / P4 / P5 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | 事实核查（**已完成**）、评审、合并、门禁、`docs/**` 收口（§3 表销行 + R119→N26 + agent-briefs 实测块） |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | **Task 1–2**（`reflect-metadata` + 逐条取证）。编号区间 **R320–R339** |
| **conformance agent** | `/home/howe/pokergame`（主检出，`tools/conformance/**`） | **Task 3**（R253 判据换形态 + 判别力/抗第三方写入的自证）。编号区间 **R340–R359** |
| 前端 | —— | **本片无前端改动** |

**开工前固定动作（两个 agent 都逐字执行）**：

```bash
# 后端 agent
cd /home/howe/pokergame/.worktrees/backend
pwd && git branch --show-current          # 必须输出 feat/backend
git merge master --no-edit                # 协调者已把本计划推到 master
CI=true pnpm install --store-dir .pnpm-store   # ⚠️ 必须带 --store-dir（工作区外的 ~/.pnpm-store 会被沙箱拒绝）
pnpm exec turbo run build --force

# conformance agent（主检出，master）
cd /home/howe/pokergame
pwd && git branch --show-current          # 必须是 master
pnpm exec turbo run build --force         # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
```

**⚠️ conformance 必须独占跑**（网关按 IP 计并发 WS 连接、上限 5）；跑任何切片期间其他人不得重建/重启容器。

**汇报格式**（统一，逐条对应 DoD 并附**实际命令与输出**）：完成情况 / 改动清单（文件 + 一句话 + commit sha）/ 阻塞未完成 / 需要协调者裁决的事项 / 我发现的文档未记录的问题。

---

## File Structure

```
packages/api-gateway/package.json                  Modify: 加 `reflect-metadata` 直接依赖（R310）
pnpm-lock.yaml                                     Modify: 上述依赖的解析结果（协调者独占，后端 agent 可改）
packages/api-gateway/test/reflect-metadata.probe.test.ts   **临时**：取 RED/GREEN 后删除（R310，不留脚手架）

tools/conformance/src/slices/slice-11-robot-system.ts       Modify: 第 6 组删相对量等式 + 加绝对性质（Task 3/R253）

docs/design.md                                     Modify: §1.4 / §2.3(WEB_DIR) / §3.4 / §4.2(标记) / §5.5(标记) /
                                                          §6.1 / §6.5(标记+注记) / §7.1 / §9.1 / §9.5(标记+注记) /
                                                          §11.4 / §12.5（删/改写，逐条附代码证据）
docs/superpowers/plans/deviation-ledger.md          Modify: §3 表销 5 行 + 新增「未核实余量」行 + 新增 **N26**（R119 实证）
docs/superpowers/plans/agent-briefs.md             Modify: 门禁实测 + 教训（协调者）
docs/superpowers/plans/2026-09-16-slice-p6-engineering-debt.md   本文件追加「门禁实测」
```

---

## Task 1（后端 agent）：`api-gateway` 补 `reflect-metadata` 直接依赖（R310）

**Files:** Modify `packages/api-gateway/package.json`、`pnpm-lock.yaml`；**临时** `packages/api-gateway/test/reflect-metadata.probe.test.ts`（用后删除）

- [ ] **Step 1: 先取 RED（必须实测，不得推断）**
```bash
cd /home/howe/pokergame/.worktrees/backend
cat > packages/api-gateway/test/reflect-metadata.probe.test.ts <<'EOF'
// 临时探针（R310）：只为取「补依赖前会红」的 RED 原文，取完即删。
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
describe('probe', () => { it('loads', () => { expect(1).toBe(1); }); });
EOF
pnpm --filter @fight-the-landlord/api-gateway test -- reflect-metadata.probe 2>&1 | tail -20
# ✅ 期望红：`Failed to load url reflect-metadata … Does the file exist?`（把原文贴进汇报）
```
  ⚠️ 若**意外是绿的**（例如某处已把它装成 devDependency 或 hoist 变了）⇒ 停下来，把 grep 原文与 `pnpm why reflect-metadata` 的输出贴进汇报，并**不要**继续改 `package.json`（那就变成无判据的改动）。
- [ ] **Step 2: 补依赖**
```bash
# 版本取仓库既有解析结果（不新起版本线）：先看别的服务怎么写
grep -h '"reflect-metadata"' packages/*/package.json
pnpm --filter @fight-the-landlord/api-gateway add reflect-metadata@<既有版本>
CI=true pnpm install --store-dir .pnpm-store
```
  ⚠️ `pnpm-lock.yaml` 的 diff **只应**新增 `api-gateway` 对它的引用（若把既有包的版本也翻了，说明版本写成 `^x` 而既有是别的范围 ⇒ 改用**逐字相同**的范围）。
- [ ] **Step 3: 取 GREEN + 删探针**
```bash
pnpm --filter @fight-the-landlord/api-gateway test -- reflect-metadata.probe 2>&1 | tail -8   # ✅ 绿
rm packages/api-gateway/test/reflect-metadata.probe.test.ts
git status --short   # ✅ 不得留下探针
```
- [ ] **Step 4: 全量回归 + 核实 `@Inject(DataSource)`**
```bash
pnpm exec turbo run test lint --force     # ✅ 29/29 全绿、0 cached
pnpm exec turbo run build --force         # ✅ 10/10
```
  ⚠️ 顺带核实 `packages/user-service/src/health/health.service.ts` 的 `@Inject(DataSource)`：补了 `reflect-metadata` 之后 `user-service` 的 6 条 health 用例是否仍绿。**无论结论如何都不要改它** —— 只在汇报里记一条说明（`DataSource` 是抽象类、`@nestjs/typeorm` 注册的 token 是 `'DataSource'` 字符串；两种形态为何都能工作）。
- [ ] **Step 5: 提交**（`chore(api-gateway): 补 reflect-metadata 直接依赖（R310）`）

---

## Task 2（后端 agent）：逐条取证 —— 为每个「要删的注记」找到**当前代码**里的反证（R311）

**Files:** 无（只读取证）；产出是**汇报里的证据表**

**背景**：协调者已经用只读审计核过一轮（结论见「协调者已实测的前置事实」与下方清单），但**裁决 R311 要求每条处置都附代码原文**。你的活是**独立复核并补齐证据**（不要相信这份计划里的转述 —— 它就是上一轮的产物）。

- [ ] **Step 1: 逐条取证**，对下面每一条给出「结论（删/改写/保留）/ 反证原文（文件:行 + 代码）/ 复核命令」：

| # | `design.md` 位置 | 注记大意 | 需要找到的反证 |
|---|---|---|---|
| 1 | `:803` §6.5 | 「幂等**零实现**…无 `baseVersion` 概念」 | `baseVersion` CAS 的实现 + `seq` 已从协议删除 |
| 2 | `:589` §6.1 | 「`pingInterval: 10000/20000`，且另有应用层 `ping`/`pong`」 | 真实的 `pingInterval/pingTimeout` 值 + 应用层心跳已删 |
| 3 | `:590` §6.1 | 「`WsGateway` 没有任何 `@SubscribeMessage`…`new Server()` 独立实例」 | `@SubscribeMessage` 的真实数量 + `@WebSocketServer()` |
| 4 | `:1244` §11.4 | 「一个错误码都没落地，全部是硬编码字符串」 | `ErrCode` 枚举 + 生产代码用 `ErrCode.*` |
| 5 | `:884` §7.1 | 「白名单含 `'/'` ⇒ `isPublicPath()` 恒为真」 | 白名单的**真实**内容 + `isPublicPath` 的实现 |
| 6 | `:880` §7.1 | 「`GET /api/games/:roomCode` 无需鉴权且返回完整 `GameSession`」 | 该路由现在的鉴权 + 裁剪视图 |
| 7 | `:886` §7.1 | 「`ProxyGateway` 没有 `@WebSocketGateway` 装饰器」 | 装饰器现在存在 |
| 8 | `:887` §7.1 | 「api-gateway 无任何限流；compose 无 `REDIS_URL`」 | 限流实现 + compose 里的 `REDIS_URL` |
| 9 | `:1061` §9.5 | 「`robot.controller.ts:15` 接收客户端传来的整个 `session`」 | 该文件现状 + `RobotDecideRequest` 的形状 + 源码闸 |
| 10 | `:1064` §9.5 | 「`bot.player.ts` 用「总牌堆 − 手牌」反推并硬分配三家」 | 那些函数是否还在 + 闸是否钉住「不得复活」 |
| 11 | `:92` §1.4 | 「**现状**：`web/index.html` 是…临时验证工具，但其违反 §12 的部分必须删除」 | `web/` 目录不存在 + 删除它的 commit |
| 12 | `:1323-1327` §12.5 | 整节「当前违规（必须在 P1 前清除）」列 `web/index.html:517/243/419` | 同上（文件已删 ⇒ 该节已无主体） |
| 13 | `:288` §3.4 | 「存在两套机器人 ID 规则：前端硬编码 `bot-1`/`bot-2`（`web/index.html:199`）」 | `web/` 已删 + ID 规则现状 |
| 14 | `:1010-1013` §9.1 | 「两条均被违反：…机器人回合由**浏览器**驱动（`web/index.html:243`/`:419`）」 | `web/` 已删 + §9.4 服务端驱动已落地 |
| 15 | `:144` §2.3 | env 表里的 `WEB_DIR \| api-gateway \| <repo>/web` | 代码/compose 里 `WEB_DIR` **0 命中** |
| 16 | `:343` / `:566` / `:774` / `:1057` 标题标记 | `[待实现]`（正文却已实现或已写 `[已实现]`） | 各节正文的 `[已实现]` 段或落地的代码 |

- [ ] **Step 2: 对**每一条**给出一个**可复现的复核命令**（`grep -n` / `sed -n` 一行），让协调者能一条命令复算你的结论。
- [ ] **Step 3: 明确列出「无法确认」的项**（若某条你找不到反证，就写「保留 + 缺什么证据」，**不得**猜）。
- [ ] **Step 4: 提交**（`docs(plan): P6 Task 2 —— 过期注记的逐条代码取证（R311）`，把证据表追加到本计划文件的「取证表」节）
  ⚠️ 你可以改**本计划文件**（追加取证表），其余 `docs/**` 归协调者。

**Task 2 DoD**：16 条的结论 + 反证原文 + 复核命令全部齐备；「无法确认」项显式列出。

---

## Task 3（conformance agent）：R253 —— 第 6 组相对量判据换形态（绝对性质）

**Files:** Modify `tools/conformance/src/slices/slice-11-robot-system.ts`（`runIdempotentAcquire()`）

**事实**：现判据是 `checks.eq(poolAfterSecond.length, poolAfterFirst.length, …)`（`:953-958`）。它是**相对量**：
- 它实际断言的是「**我这两次读池之间没有第三方动过池**」—— 而 `releaseRobots()` 是 `void` 异步、`reclaimIdle()` 每 60s 一次、跨运行的晚到 `release` 也会落地（P3 实测：robot-service 日志里有非本次运行的补位局与 release 交错，把 `ZCARD` 从 2 抬到 4）；
- 它对「池退化成 0 / 容量静默丢失 / 幽灵成员」**完全免疫**（那正是 N22 藏很久的原因）。

- [ ] **Step 0: 先取「修前 RED 的存在性证据」**
  R253 不是「修一个缺陷」，而是「换判据形态」⇒ **修前它不会红**。所以你要证明的不是「修前会红」，而是**两件事**（都要实测原文）：
  1. **旧形态会假红**：构造一次**受控的第三方写入**（例如在两次读池之间，经 `robot.release` 放一个**别的** `{roomCode}` 的机器人回池，或直接 `ZADD` 一个带真实 `bot:{id}` 记录的探针成员）⇒ 旧等式**必须红**（把 RED 原文贴进汇报）。⚠️ 构造必须**清理干净**（`finally` 里删除你加进去的成员与记录，并**断言清理成功**）。
  2. **旧形态对绝对退化免疫**：说明（可只做推理 + 一条演示）「把池容量清成 0」时旧等式**照样绿** —— 这是它该被换掉的全部理由。
- [ ] **Step 1: 换形态**。删掉那条等式，改为**绝对性质**（至少覆盖）：
  - **幂等的绝对形态**：第二次 acquire 返回的 `botId` 必须是**第一次那个**，且**不得产生新成员** —— 判据要写成「窗口内**没有新增**池成员」（`poolAfterSecond` 中不在 `poolAfterFirst` 里的成员必须为**空**），**而不是**比较长度；
  - **不得把「第二次 acquire 的那个 bot」放回池**（它被占用中）；
  - **每个池成员都必须有 `bot:{botId}` 记录**（悬挂为 0 —— 与 `slice-07.2-rpc` 第 2 组、`slice-11` 第 5 组**同源**）；
  - ⚠️ **保留**既有的「同一 `botId`/`displayId`」断言（那是最强的一条）。
- [ ] **Step 2: 自证判别力**（R115）：给新判据配一条**注入式反向判据** —— 例如「把这个窗口里的成员集合手工造出一个『新增成员』喂给谓词 ⇒ 谓词必须报违规」（谓词若是纯函数更好，可像 `slice-07.2-deploy` 的 `readinessViolations` 那样做）。
- [ ] **Step 3: 抗第三方写入的自证（本条的**核心**）**：用 Step 0.1 的同一个受控构造 —— 在两次读池之间注入一个**真实的第三方池成员**（带 `bot:{id}` 记录），然后跑**新**判据 ⇒ **必须绿**（旧判据在同一构造下是红的）。两个形态**在同一构造下的对照**就是「新形态更稳」的证明。⚠️ 同样要在 `finally` 里清理 + 断言清理成功。
- [ ] **Step 4: 跑（独占）**
```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force
pnpm --filter @fight-the-landlord/conformance build
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-11        # ✅ 50 项（R253 换形态后 46 → +4 判别力自证）
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc  # ✅ 61 项（同源判据）
```
  ⚠️ **顺序无关性**（R243/R250 的门禁一部分）：池**空**跑一次、池**非空**（种子 2 个成员）再跑一次，两次都必须绿。
- [ ] **Step 5: 提交**（`test(conformance): slice-11 第 6 组换绝对量判据（R253, R340）`）

**Task 3 DoD**：`slice-11` 与 `slice-07.2-rpc` 全绿（含池空/池非空两种前置）；**旧判据在受控第三方写入下红的原文** + **新判据在同一构造下绿的原文** + 谓词判别力自证；临时成员/记录清理干净（`git status --short` 只含你的 conformance 改动）。

---

## 门禁（协调者，两个 agent 都 settle **之后**执行；conformance 独占）

```bash
cd /home/howe/pokergame
git merge feat/backend --no-edit

pnpm exec turbo run test lint --force      # ✅ 29/29、0 cached
pnpm exec turbo run build --force          # ✅ 10/10
pnpm run ci                                # ✅ §13.4 六阶段全绿
pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ 97.58% ≥ 80
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 前端回归（预期零改动）

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8 个容器全部 healthy
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ 13/13（`slice-11` 50 · `slice-07.2-rpc` 61 · `slice-07.2-deploy` 104 · `slice-07.2-hardening` 103
#    · boundary 82 · security 40 · 07.1 28 · 07 39 · 10 185 · 09 160 · 08 55 · 06 199 · 05 29）
docker compose logs api-gateway | grep -c 'Blocked outbound'   # ✅ 0

# R253 的顺序无关性（门禁的一部分）
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-11         # ✅ 池空 ⇒ 通过
# 种子：经 robot RPC acquire 两个再 release ⇒ 池里 2 个空闲成员
timeout 300 node tools/conformance/dist/run.js slice-11         # ✅ 池非空 ⇒ 通过

# R310 的回头验收：补了依赖之后，从零解析仍然完整
CI=true pnpm install --frozen-lockfile --store-dir .pnpm-store  # ✅ Lockfile is up to date
```

**收口（协调者）**：
1. `docs/design.md`：按 Task 2 的取证表**逐条**删/改（R311/R312/R313 —— 只动 §3 表点名的 + `web/` 簇 + 四处自相矛盾的标题标记）；**其余 `[偏差]` 一律不动**，并在台账登记「未核实余量」。
2. `deviation-ledger.md`：§3 表**销掉 5 行已过期的**（§3.1 / §5.5 / §2.3 / §10.1 / §4.2）+ 拆掉 `497` 行的 1/3 + 修正 `514` 行（协调者 P5 自己写错的「仍未处理」清单）+ 追加「未核实余量」行；§1.5 新增 **N26**（R119 的实证与约束，R309）。
3. `agent-briefs.md`：追加 P6 门禁实测块 + 教训（**至少**三条：相对量判据的收尾、`reflect-metadata` 这类「隐性传递依赖」的识别手法、以及「台账自己会过期」这件事本身）。
4. 本计划文件追加「门禁实测」块。

---

## Self-Review

**Spec coverage**

| 项 | 落在哪个 Task |
|---|---|
| R253 相对量判据换形态 | Task 3（+ 门禁的顺序无关性复核） |
| `api-gateway` 缺 `reflect-metadata` | Task 1（R310） |
| §3 表点名的过期注记 | Task 2 取证 + 协调者收口（R311/R312） |
| §3 表**自己**已过期的 5 行 | 协调者收口（R311，销行 + 修正 `514` 行） |
| `web/` 簇同源注记 | Task 2 第 11–15 条 + 协调者收口（R312） |
| 四处自相矛盾的标题标记 | Task 2 第 16 条 + 协调者收口（R313） |
| R119 | 协调者收口成 **N26**（R309，**不改代码**） |
| 「其余 ~20 处 `[偏差]` 未核实」 | 台账登记 + 枚举命令（R312） |

**Placeholder scan**：无 TBD。R253 的「绝对性质」写明了**必须覆盖的四条**与**必须自证的三件事**；R310 写明了 RED 的取法与「意外绿了就停」的退路；Task 2 的 16 条逐条给了「需要找到的反证」。

**Type consistency**：`slice-11` 第 6 组的既有断言（同一 `botId`/`displayId`）与新增绝对性质**共存**，不重命名既有 helper；`N26` 编号接 P5 的 `N25`；裁决区间与 P5 不重叠（R309–R319 协调者 / R320–R339 后端 / R340–R359 conformance）。

**⚠️ 本片的四个高风险点（执行时优先验证）**
1. **Task 1 的 RED 可能取不到**（若 `reflect-metadata` 被某个 hoist 路径意外解析到）⇒ 那就**停手并上报**，不要凭「应该会红」继续改配置（P3 教训第 1 条）。
2. **Task 3 的受控第三方写入会污染共享 Redis** ⇒ `finally` 清理 + **断言清理成功**是硬要求；清理不干净会让**同轮其它切片**假红（A7 的 e2e 就是因为这个被刻意不做的）。
3. **Task 2 是「删文档」** ⇒ 删错一条真注记的代价比多留一条大得多 ⇒ 凡「无法确认」一律**保留**并写清缺什么证据。
4. **`pnpm-lock.yaml` 是协调者独占文件**（R23 族）⇒ 后端 agent 在本片**被显式授权**改它（R310），但**只许**新增 `api-gateway` 的 `reflect-metadata` 引用，**不得**顺带升级任何既有包。

---

## 取证表（Task 2 / R311，后端 agent：逐条代码取证）

**取证基线**：`feat/backend` @ `1bdd30a`（本片 Task 1 的提交；该提交**未**触碰 `docs/**`，
`docs/design.md` 与本计划文件都与 `aff7ace` 逐字一致）。**行号实测未漂移** —— 下面每条引用的
`docs/design.md` 行号与计划 Task 2 表里审计时的行号**完全一致**（每条都附了可复现命令）。
`web/` 目录的删除 commit = **`5be7522`**（`fix(security): 删除客户端可达的内部面（web 页/开局/机器人路由）… A6/S4/S5/N5/N11`）。

**结论口径（R311）**：`删除` = 注记陈述的事实被**当前代码**证伪；`改写` = 事实已变、但整条删掉会丢失
仍成立的说明面或制造悬空引用；`保留` = 注记仍成立；`无法确认` = 找不到反证 ⇒ **一律保留**。
⚠️ **本片 16 条里「无法确认」= 0 条，「保留」= 0 条**；两条 `改写` 各有独立的机械理由（见 §R321/R322 标注处）。

### 汇总

| # | `design.md` 位置 | 注记大意 | 结论 |
|---|---|---|---|
| 1 | `:803` §6.5 | 幂等**零实现** · 无 `baseVersion` 概念 | **删除** |
| 2 | `:589` §6.1 | `pingInterval: 10000/20000` + 另有应用层 `ping`/`pong` | **删除** |
| 3 | `:590` §6.1 | `WsGateway` 无任何 `@SubscribeMessage` · `new Server()` 独立实例 | **删除** |
| 4 | `:1244` §11.4 | 一个错误码都没落地，全部硬编码字符串 | **删除**（附 1 处遗留字面量） |
| 5 | `:884` §7.1 | 白名单含 `'/'` ⇒ `isPublicPath()` 恒真 | **删除** |
| 6 | `:880` §7.1 | `GET /api/games/:roomCode` 无需鉴权 + 返回完整 `GameSession` | **删除** |
| 7 | `:886` §7.1 | `ProxyGateway` 没有 `@WebSocketGateway` 装饰器 | **删除** |
| 8 | `:887` §7.1 | api-gateway 无限流 · compose 无 `REDIS_URL` | **删除** |
| 9 | `:1061` §9.5 | `robot.controller.ts:15` 接收客户端传来的整个 `session` | **删除** |
| 10 | `:1064` §9.5 | `bot.player.ts` 用「总牌堆 − 手牌」反推并硬分配三家 | **删除** |
| 11 | `:92` §1.4 | 「**现状**：`web/index.html` 是…临时验证工具」 | **改写**（保留锚点，换成 `apps/client`） |
| 12 | `:1319-1327` §12.5 | 整节「当前违规（必须在 P1 前清除）」列 `web/index.html:517/243/419` | **改写**（不是删整节：有 2 处入站引用） |
| 13 | `:288` §3.4 | 存在两套机器人 ID 规则（前端硬编码 `bot-1`/`bot-2`） | **删除** |
| 14 | `:1010-1013` §9.1 | 两条不可协商约束均被违反 | **删除** |
| 15 | `:144` §2.3 | env 表里的 `WEB_DIR` 行 | **删除**（整行） |
| 16 | `:343`/`:566`/`:774`/`:1057` 标题标记 | `[待实现]` 与正文/代码矛盾 | **改写** → `[已实现]`（4 处；依据见下） |

---

#### 1 · §6.5 `design.md:803` —— 「幂等**零实现**…无 `baseVersion` 概念」 ⇒ **删除**

反证原文：

- `packages/game-service/src/game/game.service.ts:322-327` —— CAS 已落地：
```ts
    if (baseVersion !== undefined && baseVersion !== session.version) {
      throw new GameError(
        ErrCode.VERSION_CONFLICT,
        `Version conflict: expected ${baseVersion}, current ${session.version}`,
        409,
      );
    }
```
- `packages/protocol/src/messages.ts:4` —— ` * **没有 \`seq\` 字段**（§6.2）：请求关联由 socket.io 的 ack 回调承担，`
- `packages/protocol/src/validate.ts:239` —— `  assertNum(body.baseVersion, '$.baseVersion');`

⚠️ 一条必须写下来的**边界**：`seq` 在**真契约包** `packages/protocol` 里确已删除，但
`packages/shared/src/protocol/message.ts:34` 仍有 `seq?: number`（一份**遗留的第二契约**，被
`packages/shared/src/index.ts:13` 导出、**0 个生产消费者**，只有它自己的测试用）。注记本身断言的是
§6.5 的幂等机制「零实现」，已被 CAS 直接证伪 ⇒ **仍判删除**；那份遗留契约单独登记为发现项（见汇报）。

复核命令：
```bash
sed -n '803p' docs/design.md; sed -n '322,327p' packages/game-service/src/game/game.service.ts; \
  sed -n '3,5p' packages/protocol/src/messages.ts; sed -n '239p' packages/protocol/src/validate.ts
```

#### 2 · §6.1 `design.md:589` —— 「`pingInterval: 10000 / pingTimeout: 20000`，且另有应用层 `ping`/`pong`」 ⇒ **删除**

反证原文：

- `packages/room-service/src/gateway/ws.gateway.ts:109-111`：
```ts
  // §6.1：只用 socket.io 内置心跳；应用层 ping/pong 已删除
  pingInterval: 30000,
  pingTimeout: 90000,
```
- `packages/api-gateway/src/gateway/proxy.gateway.ts:86-87` —— 同一组值（`pingInterval: 30000,` / `pingTimeout: 90000,`）。
- **应用层心跳不存在**：`grep -rn "@SubscribeMessage('" packages/*/src` 的 9 个 handler 里没有 `ping`/`pong`；
  `packages/protocol/src/messages.ts:73-83` 的 `CLIENT_MESSAGE_TYPES` 九条里**没有** `'ping'`。

复核命令：
```bash
sed -n '589p' docs/design.md; sed -n '108,111p' packages/room-service/src/gateway/ws.gateway.ts; \
  sed -n '86,87p' packages/api-gateway/src/gateway/proxy.gateway.ts; sed -n '73,83p' packages/protocol/src/messages.ts
```

#### 3 · §6.1 `design.md:590` —— 「没有任何 `@SubscribeMessage`」+「`new Server()` 独立实例」 ⇒ **删除**

反证原文：

- `grep -c "@SubscribeMessage('" packages/room-service/src/gateway/ws.gateway.ts` = **9**
  （`room.match`/`room.unmatch`/`room.join`/`room.leave`/`game.bid`/`game.play`/`game.pass`/`game.reconnect`/`game.resync`）。
- `packages/room-service/src/gateway/ws.gateway.ts:116-118`：
```ts
  /** 由 Nest 注入的、真正挂在 HTTP server 上的 socket.io 实例（不是 new Server()）。 */
  @WebSocketServer()
  server!: Server;
```
- `grep -rn "new Server(" packages/*/src` 在 `room-service` 里**只**命中注释（`ws.gateway.ts:98`、`:116`）—— 生产代码 0 处。

复核命令：
```bash
sed -n '590p' docs/design.md; grep -n "@SubscribeMessage('" packages/room-service/src/gateway/ws.gateway.ts; \
  sed -n '116,118p' packages/room-service/src/gateway/ws.gateway.ts; grep -rn "new Server(" packages/*/src
```

#### 4 · §11.4 `design.md:1244` —— 「一个错误码都没落地，全部是硬编码字符串」 ⇒ **删除**

反证原文：

- `packages/protocol/src/errors.ts:12-16`：
```ts
export enum ErrCode {
  OK = 0,

  // 1xxxx 通用
  BAD_PARAM = 10001,
```
  （枚举覆盖 §11.2 全表，由 `packages/protocol/src/errors.test.ts` 的 `SPEC_CODES` 机械对账。）
- 生产代码里 `ErrCode.` 命中 **179 处 / 27 个文件**
  （`grep -rn "ErrCode\." packages/*/src --include=*.ts | grep -v "\.test\." | wc -l`）。

⚠️ 唯一的遗留字面量：`packages/api-gateway/src/gateway/proxy.gateway.ts:282` 仍是
`client.emit('system.error', { version: 0, payload: { code: 10007, message: err.message } });`
—— 它是**数值**（不是字符串），且值正确。它不构成「全部硬编码字符串」的反例，但收口时可顺手改成
`ErrCode.UPSTREAM_UNAVAILABLE`（**本片不改**，它不在 R312 的范围内）。

复核命令：
```bash
sed -n '1244p' docs/design.md; sed -n '12,16p' packages/protocol/src/errors.ts; \
  grep -rn "ErrCode\." packages/*/src --include=*.ts | grep -vc "\.test\."; \
  grep -rn "code: 1[0-9]\{4\}" packages/*/src --include=*.ts | grep -v "\.test\."
```

#### 5 · §7.1 `design.md:884` —— 「白名单含 `'/'`…`isPublicPath()` 恒为真」 ⇒ **删除**

反证原文：

- `packages/api-gateway/src/auth/jwt.middleware.ts:72-78`（白名单**恰好 5 条精确条目**，无 `'/'`）：
```ts
  private readonly publicPaths = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/refresh',
    '/api/health',
    '/api/health/live',
  ];
```
- `packages/api-gateway/src/auth/jwt.middleware.ts:175-178` —— 判定是**精确**包含：
```ts
  private isPublicPath(path: string): boolean {
    ...
    return this.publicPaths.includes(path);
  }
```

复核命令：
```bash
sed -n '884p' docs/design.md; sed -n '72,78p;175,178p' packages/api-gateway/src/auth/jwt.middleware.ts
```

#### 6 · §7.1 `design.md:880` —— 「该路由无需鉴权且返回完整 `GameSession`」 ⇒ **删除**

反证原文：

- **必须鉴权**：该路由不在 `publicPaths`（同第 5 条的 `jwt.middleware.ts:72-78`），
  而 `HttpRateLimitMiddleware` 的装配串是 `consumer.apply(JwtMiddleware, …).forRoutes('*')` ⇒ 无 token 先 401。
- **返回裁剪视图**：`packages/game-service/src/game/game.controller.ts:62-68` 走 `this.view(roomCode, userId)`，
  其 docblock（`:55`）逐字写：`座位**只**由 \`X-User-Id\` 在会话中定位（§5.3），**不接受** \`?seat=\` 覆盖（S2/S8/R74）`；
- `packages/game-service/src/game/game.service.ts:214-222` —— 唯一实现是「按 `X-User-Id` 定位座位 + 裁剪」：
```ts
  async getViewForUser(roomCode: string, userId: string): Promise<PlayerView> {
    const session = await this.getSession(roomCode);
    if (!session) throw new GameError(ErrCode.ROOM_NOT_FOUND, 'Game not found', 404);

    const seat = findSeatByUserId(session, userId);
    if (seat < 0) throw new GameError(ErrCode.NOT_IN_ROOM, 'You are not in this game', 403);
```

复核命令：
```bash
sed -n '880p' docs/design.md; sed -n '72,78p' packages/api-gateway/src/auth/jwt.middleware.ts; \
  sed -n '55p;62,68p' packages/game-service/src/game/game.controller.ts; sed -n '214,222p' packages/game-service/src/game/game.service.ts
```

#### 7 · §7.1 `design.md:886` —— 「`ProxyGateway` 没有 `@WebSocketGateway` 装饰器」 ⇒ **删除**

反证原文：`packages/api-gateway/src/gateway/proxy.gateway.ts:82` 就是装饰器（并已带 §5.4 的传输层限流）：
```ts
@WebSocketGateway({
  cors: true,
  namespace: '/ws/ddz',
  path: '/socket.io/',
  pingInterval: 30000,
  pingTimeout: 90000,
  // N15/R246：§5.4 的单 IP 并发连接 5 挪到 **engine.io 的传输层**判 …
  allowRequest: delegateAllowRequest,
})
```

复核命令：
```bash
sed -n '886p' docs/design.md; sed -n '82,91p' packages/api-gateway/src/gateway/proxy.gateway.ts
```

#### 8 · §7.1 `design.md:887` —— 「无任何限流实现；compose 中没有 `REDIS_URL`」 ⇒ **删除**

反证原文：

- `packages/api-gateway/src/http/rate-limit.ts:4` —— `export const HTTP_RATE_LIMIT = { max: 20, windowMs: 5000 } as const;`
  （§5.4 单用户 20 次/5s）；`:15` —— `export const WS_CONN_LIMIT = { max: 5, ttlSeconds: 60 } as const;`（§5.4 单 IP 并发 5）。
- `packages/api-gateway/src/app.module.ts:31` —— `consumer.apply(JwtMiddleware, HttpRateLimitMiddleware).forRoutes('*');`
- `docker-compose.yml:226` —— `      - REDIS_URL=redis://redis:6379`（在 `api-gateway:` 块内，块首行为 `:210`）。

复核命令：
```bash
sed -n '887p' docs/design.md; sed -n '4p;15p' packages/api-gateway/src/http/rate-limit.ts; \
  sed -n '31p' packages/api-gateway/src/app.module.ts; sed -n '210p;226p' docker-compose.yml
```

#### 9 · §9.5 `design.md:1061` —— 「`robot.controller.ts:15` 接收客户端传来的整个 `session`」 ⇒ **删除**

反证原文：

- `packages/robot-service/src/robot/robot.controller.ts:8-10`（文件自身的 docblock 逐字）：
```
 * ⚠️⚠️ **`acquire` / `release` / `decide` 三条 HTTP 路由已整条删除**（N20/P4，R218）。
```
  该文件现存处理器只有 `@Post('create')`（`:27`）、`@Post('remove')`（`:33`）、`@Get('list')`（`:40`）—— 都不收 `session`。
- `packages/protocol/src/robot.ts:84-92` —— 决策入参是**裁剪视图**、**没有** `session` 字段：
```ts
export interface RobotDecideRequest {
  roomCode: string;
  botId: string;
  skillLevel: SkillLevel;
  /** 【裁剪视图】绝不含他人手牌（§9.5）。 */
  view: PlayerView;
  /** 【公开信息特征】由 game-service 从 `actionLog` 派生（§4.2）。 */
  features: RobotFeatures;
}
```
- 机械闸（已在 `turbo run test` 里）：`packages/robot-service/test/no-session-boundary.test.ts:51-55`：
```ts
  it('robot.controller.ts 没有 move 路由，也不出现 session', () => {
    const src = read('robot/robot.controller.ts');
    expect(src).not.toMatch(/@Post\(\s*'move'/);
    expect(src).not.toMatch(/\bsession\b/);
```
  同文件 `:29-36` 是**探针判别力自证**（正/负对照），符合 R212①。

复核命令：
```bash
sed -n '1061p' docs/design.md; sed -n '8,10p;27p;33p;40p' packages/robot-service/src/robot/robot.controller.ts; \
  sed -n '84,92p' packages/protocol/src/robot.ts; sed -n '51,55p' packages/robot-service/test/no-session-boundary.test.ts
```

#### 10 · §9.5 `design.md:1064` —— 「`bot.player.ts:90-132` 用「总牌堆 − 手牌」反推再硬分配三家」 ⇒ **删除**

反证原文：

- `grep -c "computePlayedCards\|computeActionSeq\|getAllCards" packages/robot-service/src/robot/bot.player.ts` = **0**
  （三个启发式/硬编码函数都已删除）。该文件现存注释（`:23`）逐字说明数据源已换成 `features`。
- 机械闸**钉住「不得复活」**：`packages/robot-service/test/no-session-boundary.test.ts:44-49`：
```ts
  it('bot.player.ts 的伪造特征函数不得复活（C7/C8）', () => {
    const src = read('robot/bot.player.ts');
    for (const dead of ['computePlayedCards', 'computeActionSeq', 'getAllCards']) {
      expect(src, `${dead} 是切片 11 删除的伪造实现，不得复活`).not.toContain(dead);
    }
  });
```
- 真实实现：`packages/shared/src/ddz/features.ts:38-39`（`playedCards` 只来自 `actionLog` 的 `kind === 'play'` 记录）：
```
 * `kind === 'play'` 记录（旧实现 `bot.player.ts` 的 `computePlayedCards()` 用
 * 「总牌堆 − 当前手牌」反推再按 `lastPlayerIdx` 倒序硬分配给三家 —— 那是伪造特征，C8）。
```

复核命令：
```bash
sed -n '1064p' docs/design.md; grep -c "computePlayedCards\|computeActionSeq\|getAllCards" packages/robot-service/src/robot/bot.player.ts; \
  sed -n '44,49p' packages/robot-service/test/no-session-boundary.test.ts; sed -n '38,39p' packages/shared/src/ddz/features.ts
```

#### 11 · §1.4 `design.md:92` —— 「**现状**：`web/index.html` 是…临时验证工具」 ⇒ **改写**（⚠️ R321）

反证原文：

- `ls web` ⇒ `ls: cannot access 'web': No such file or directory`
- `git log --oneline -1 --diff-filter=D -- web/index.html` ⇒ `5be7522 fix(security): 删除客户端可达的内部面（web 页/开局/机器人路由）+ 边缘剥掉客户端身份头（A6/S4/S5/N5/N11，R135-R138/R146）`
- **真实现状**是 `apps/client`（`apps/client/package.json:6`）：
  `"description": "斗地主客户端骨架。哑终端：只依赖 @fight-the-landlord/protocol，不含任何游戏规则。",`

⚠️ **为什么是「改写」而不是「删除」**：`:92` **没有** `[偏差]` 标记
（`sed -n '92p' docs/design.md | grep -c 偏差` = **0**）—— 它是 §1.4 的「**现状**」bullet，与 `:91` 的「目标态」bullet 成对。
整条删掉会让 §1.4 只剩「目标态」而**失去现状面**。⇒ 建议改写为「现状：`apps/client`（Vue3 + Vite 哑终端，
§12；P1 已交付）」，把 `web/index.html` 那段作废。

复核命令：
```bash
sed -n '89,93p' docs/design.md; sed -n '92p' docs/design.md | grep -c 偏差; ls web; \
  git log --oneline -1 --diff-filter=D -- web/index.html; sed -n '6p' apps/client/package.json
```

#### 12 · §12.5 `design.md:1319-1327` —— 整节「当前违规（必须在 P1 前清除）」 ⇒ **改写**（⚠️ R321）

反证原文：

- 该节表体三行**全部**指向已删除的文件（`sed -n '1323,1327p' docs/design.md`）：
```
| `web/index.html:517` `findBeatingHand()`（约 115 行的牌型比较实现） | **F01** |
| `web/index.html:243` `autoBidBots()` | 12.1 原则 + **F05/F07** |
| `web/index.html:419` `autoPlayBots()` | 12.1 原则 + **F01/F05/F07** |
```
- `web/` 已删（`5be7522`）；`grep -rn "findBeatingHand\|autoBidBots\|autoPlayBots" apps packages tools` = **0 命中**（`docs/` 除外 —— 命中就在 `design.md` 自己这三行里）。

⚠️ **为什么不能删整节（这条是本表唯一「计划没预见到」的约束）**：§12.5 有**两处入站引用**，
删掉标题会留下悬空指向 ——
`grep -n "§12\.5" docs/design.md` = `1451:- 删除前端三处违规（§12.5）`（§14.2 的交付清单）
与 `1647:| A6 | \`web/index.html:243,419,517\` | … | §12.5 |`（附录 A.2 的 A6 行）。
⇒ 处置应为**改写**：保留 `### 12.5 …` 锚点，把表体换成「**已清除**（`5be7522`，A6/S4/S5/N5/N11），
违反的 F01/F05/F07 见 §12.2」。
（同第 11 条：该节标题同样**没有** `[偏差]` 标记，`sed -n '1319p' docs/design.md | grep -c 偏差` = 0。）

复核命令：
```bash
sed -n '1319,1327p' docs/design.md; sed -n '1319p' docs/design.md | grep -c 偏差; ls web; \
  git log --oneline -1 --diff-filter=D -- web/index.html; grep -rn "findBeatingHand\|autoBidBots\|autoPlayBots" apps packages tools | wc -l; \
  grep -n "§12\.5" docs/design.md
```

#### 13 · §3.4 `design.md:288` —— 「存在两套机器人 ID 规则：前端硬编码 `bot-1`/`bot-2`（`web/index.html:199`），匹配服务生成 `bot-{uuid8}`」 ⇒ **删除**

反证原文：

- `web/` 已删（`5be7522`），因此「前端硬编码」这一半**结构上不可能成立**。
- `grep -rn "bot-1\|bot-2" apps/client/src packages/*/src | grep -v test` = **0 命中**。
- ID 规则现状（**契约层**，`packages/protocol/src/robot.ts:29-32`）：
```ts
  /** 内部 ID（`bot-<uuid8>`），**永不下发**。 */
  botId: string;
  /** 对外 ID，与人类玩家同构：`p_<8位>`。它才是 `Seat.userId` / `GamePlayer.id`。 */
  displayId: string;
```
- 机械闸：`packages/robot-service/test/no-internal-id-outbound.test.ts:23`（R211② 的源码闸谓词
  `LEAKY_ASSIGNMENT` ——「不得把 `bot` 前缀的 id 当作**对外** id」）+ `:26-30` 的**探针判别力自证**（正/负对照）
  + `:33-38` 的**生成式断言** `expect(src).toMatch(/displayId:\s*`p_\$\{/);`。

复核命令：
```bash
sed -n '288p' docs/design.md; git log --oneline -1 --diff-filter=D -- web/index.html; \
  grep -rn "bot-1\|bot-2" apps/client/src packages/*/src | grep -v test | wc -l; \
  sed -n '29,32p' packages/protocol/src/robot.ts; sed -n '23p;26,30p;33,38p' packages/robot-service/test/no-internal-id-outbound.test.ts
```

#### 14 · §9.1 `design.md:1010-1013` —— 「当前两条均被违反」 ⇒ **删除**

反证原文：

- 第 1 条（明文下发 `bot-1`/`bot-2`）：`web/` 已删；`grep -rn "bot-1\|bot-2" apps/client/src packages/*/src | grep -v test` = **0**；
  对外 id 闸见第 13 条（`no-internal-id-outbound.test.ts`）。
- 第 2 条（机器人回合由**浏览器**驱动 `web/index.html:243/419`）：`web/` 已删；
  `grep -rn "autoBidBots\|autoPlayBots" apps/client/src packages/*/src` = **0 命中**；
  服务端驱动**已落地** —— `packages/game-service/src/game/game.service.ts:477`
  `private async driveRobotTurn(roomCode: string): Promise<void> {`，
  两个调用点 `:185` 与 `:367` 都是 `void this.driveRobotTurn(...)`；
  决策走 RPC：`packages/game-service/src/game/robot.client.ts:50`
  `.send<RpcResult<RobotDecideResponse>>(RPC_PATTERNS.robotDecide, req)`。
- 注记末尾提到的 `bot.move` 在契约里不存在：`grep -rn "bot\.move" apps/client/src packages/*/src` = 0。

复核命令：
```bash
sed -n '1010,1013p' docs/design.md; grep -rn "autoBidBots\|autoPlayBots\|bot\.move" apps/client/src packages/*/src | wc -l; \
  grep -n "driveRobotTurn" packages/game-service/src/game/game.service.ts; grep -n "robotDecide" packages/game-service/src/game/robot.client.ts
```

#### 15 · §2.3 `design.md:144` —— env 表里的 `WEB_DIR` 行 ⇒ **删除**（整行）

反证原文：`grep -rn "WEB_DIR" packages apps tools scripts docker-compose.yml docker-compose.override.yml .github`
= **只有** `docs/design.md:144` 自身那一行（`| \`WEB_DIR\` | api-gateway | \`<repo>/web\` | 临时验证页面目录 |`）。
代码与两份 compose **0 命中**（`web/` 已随 `5be7522` 删除，`Dockerfile.api-gateway` 的 `COPY web ./web` 与
`main.ts` 的启动期 `readFileSync` 也已删除 —— 见 R138）。

复核命令：
```bash
sed -n '144p' docs/design.md; grep -rn "WEB_DIR" packages apps tools scripts docker-compose.yml docker-compose.override.yml .github 2>/dev/null; \
  grep -c "WEB_DIR" packages/api-gateway/src/main.ts
```

#### 16 · 标题标记 `:343` §4.2 / `:566` §5.5 / `:774` §6.5 / `:1057` §9.5 ⇒ **改写** → `[已实现]`（⚠️ R322）

四处现况（`grep -n "^#\{2,4\} .*\[待实现\]" docs/design.md`）：
```
343:### 4.2 TCP RPC 契约 `[待实现]`
566:### 5.5 脱敏 `[待实现]`
774:### 6.5 幂等与并发控制（新增契约）`[待实现]`
1057:### 9.5 可见信息边界（新增契约）`[待实现]`
```

各自的落地证据：

- **§4.2**：正文 `:437-441` 已经写着 `[已实现]（独立小片 **P4 / N20** 收口）`（**四处里唯一正文自带 `[已实现]` 的**），
  代码侧 `packages/game-service/src/main.ts:56` 与 `packages/robot-service/src/main.ts:45` 的 `connectMicroservice`，
  `grep -rn "@MessagePattern" packages/*/src` 共 21 处。
- **§5.5**：正文**没有** `[已实现]` 段（见下方 R322）。落地证据在代码：`packages/shared/src/logging/redact.ts:55`
  `export function redactText(text: string): string {`，以及**五个服务各自**的
  `Logger.overrideLogger(createRedactingLogger(...))`：`api-gateway/src/main.ts:21`、`user-service/src/main.ts:20`、
  `room-service/src/main.ts:19`、`game-service/src/main.ts:22`、`robot-service/src/main.ts:22`；
  配套机械闸 `packages/api-gateway/test/no-raw-console.test.ts`（`console.*` 只许出现在五个 `main.ts` 白名单里）。
- **§6.5**：同第 1 条（`game.service.ts:322` 的 CAS；`:372`/`getView` 侧的 `version` 单调推进）。
- **§9.5**：同第 9/10 条（`RobotDecideRequest.view` 是 `PlayerView` + `no-session-boundary.test.ts` 三道源码闸）；
  正文**没有** `[已实现]` 段。

复核命令：
```bash
grep -n "^#\{2,4\} .*\[待实现\]" docs/design.md; sed -n '437,441p' docs/design.md; \
  grep -n "connectMicroservice" packages/game-service/src/main.ts packages/robot-service/src/main.ts; \
  grep -rn "Logger.overrideLogger" packages/*/src/main.ts; \
  sed -n '322p' packages/game-service/src/game/game.service.ts; sed -n '88,89p' packages/protocol/src/robot.ts
```

⚠️ **给协调者的一条硬提示**：**R313 说这「四处正文已写 `[已实现]`」，实测只有 §4.2 是。**
§5.5 / §6.5 / §9.5 的正文没有 `[已实现]` 段 —— 它们的依据是**代码**（见上）。
R313 的**结论**（这四处改 `[已实现]`）完全可以执行，但依据必须写成「代码 + 台账」而不是「正文已写」，
否则下一个人复核时会找不到那句话（同 §5 维护约定第 1 条：关掉一条要写清关闭者 commit/裁决号）。

---

### 「无法确认」清单（R311 的硬要求）

**无。** 16 条全部找到了当前代码/文件系统的反证（每条都附了可复现命令）。
⇒ 本表**没有**因「无法确认」而保留的条目；两条 `改写`（#11 §1.4、#12 §12.5）与一处
`改写`（#16 四处标题标记）的理由都不是「无法确认」，而是「删掉会丢失仍成立的说明面/制造悬空引用」。
**⚠️ 本片不宣称 `design.md` 的 `[偏差]` 已清干净** —— 现有 **33** 处内联 `[偏差]`（口径见 R323：
原样 `grep -c` 是 **36**，要减掉 3 处非内联提及）里，本片只处置了 §3 点名 + `web/` 簇的那几条；
余量按 R312 由协调者在台账登记（**用 R323 下方那条命令**，不要用计划里给的原样命令 —— 它会多算 3）。
✅ **收口后实测**：那 11 处已全部清理 ⇒ `design.md` 现为 **22** 处内联 `[偏差]`（33 − 11），
**余量 22 处已登记在 `deviation-ledger.md` §3**（并写明「未核实、未立条」）。

### 与计划的偏差（细节见汇报「执行期裁决」节）

| 编号 | 计划怎么说 | 事实 | 落在本表的哪一条 |
|---|---|---|---|
| **R320** | R310 的 ⚠️：「`@nestjs/typeorm` 注册的 token 实际是 `'DataSource'` **字符串**」 | `getDataSourceToken()` 对**默认**数据源返回 **`DataSource` 类本身**（命名数据源才是 `${name}DataSource` 字符串）⇒ `@Inject(DataSource)` **本来就正确** | Task 1 Step 4 的核实结论 |
| **R321** | 计划/台账把 §1.4:92 与 §12.5 称作「内联 `[偏差]` 注记」 | 这两处**没有** `[偏差]` 标记（`grep -c 偏差` = 0），是「现状」bullet 与「当前违规」小节；且 §12.5 有 2 处入站引用 ⇒ 不能删标题 | #11、#12 |
| **R322** | R313：「四处**正文已写 `[已实现]`**」 | 只有 §4.2 的正文有 `[已实现]`；§5.5/§6.5/§9.5 正文没有，依据是代码 | #16 |
| **R323** | 前置事实 4：「现有 **33** 处内联 `[偏差]`（`grep -n "\[偏差\]" docs/design.md`）」 | 那条命令的**原样输出是 36 行**（36 vs 33）—— 差额是 3 处**非内联**提及（`:40` 图例行、`:1452` 指的是 `docs/games/doudizhu.md`、`:1668` 收尾规则）。这直接影响 R312 要求的「未核实余量」行与它的枚举命令 | 见下方命令 |

（R320–R323 的完整「计划怎么写 / 事实是什么 / 怎么改的」见后端 agent 的汇报；本文件按派工约束只追加取证表。）

**R323 的复核命令**（`36` = `33` 处内联 + `3` 处非内联提及）：
```bash
grep -c '\[偏差\]' docs/design.md                                  # 36（计划前置事实 4 引用的原样命令）
grep -n '\[偏差\]' docs/design.md | grep -vE '^(40|1452|1668):' | wc -l   # 33 = 真正的内联注记数
sed -n '40p;1452p;1668p' docs/design.md                            # 被排除的 3 处：图例行 / doudizhu.md 引用 / 收尾规则
```

## 执行期裁决（回填区，**不要删**）

（执行期发现与代码事实不符时，在此追加一条并编号：**后端 agent 用 R320–R339、conformance agent 用 R340–R359**，说明「计划怎么写 / 事实是什么 / 怎么改的」。）

### conformance agent（Task 3 / R253）—— R340–R342（本片 conformance 区间 R340–R359，本次用到 R342）

- **R340 「窗口内不净增」必须写成纯谓词的三条绝对性质，且窗口**紧贴第 2 次 acquire**。**

  **计划怎么写**（Task 3 Step 1）：「删掉那条等式，改为绝对性质：①幂等的绝对形态（同一 `botId` +
  窗口内没有新增池成员，写成 `poolAfterSecond` 中不在 `poolAfterFirst` 里的成员必须为空）；
  ②不得把第二次 acquire 的 bot 放回池；③每个池成员都必须有 `bot:{id}` 记录」。

  **事实是什么**：
  1. 谓词抽成了纯函数 `idempotentAcquireViolations(before, after, secondBotId, exists)`
     （**唯一实现**：实际判定与 R115 的判别力自证共用它 ⇒ 「抓得住」不需要写 Redis）。
  2. ⚠️ **窗口的右边界按字面照做会继承旧判据的假红**：计划写的 `poolAfterFirst` 是「第 1 次 acquire
     **之后**」那次读，而它与「第 2 次 acquire **之后**」的读之间**横跨了我两次 acquire 之间的
     调度/IO 间隙** ⇒ 第三方的 `release` 落在那个间隙里就同时进了 `after` 而没进 `before`
     ⇒ 新判据会**和旧等式一样红**。受控构造实测（同一份观测值）：**宽窗口报 1 条违规、窄窗口 0 条**。
  3. `slice-11` 的 `acquire()` 对池**没有任何入池路径**（`findBound()` 命中即 `continue`；
     只有 `release()` 会 `ZADD`）⇒ 把窗口收紧到「那次 acquire 本身」之后，「没有新增成员」
     只可能由 acquire 自己造成，与墙钟/第三方无关。

  **怎么改的**：在 `rpcCall(第二次 acquire)` **之前**加一次 `poolMembers()` 读作窗口左端
  （`poolBeforeSecond`），谓词用 `(poolBeforeSecond, poolAfterSecond)`。实际判定 + 四条合成自证
  （正对照×3 + 负对照×1）落在 `slice-11-robot-system.ts` 的 `runIdempotentAcquire()`。
  既有的「同一 `botId` / 同一 `displayId`」两条断言**原样保留**。
  受控构造成对证据（同一构造、同一机制）：
  - 旧等式 RED（**真实切片**，受控注入用临时代码把切片卡在窗口内）：
    `❌ slice-11 失败：第二次 acquire 不得在池里净增机器人（ZCARD 0 → 2；池成员 ["bot-de1597c7","bot-ffb7d146"]）：期望 0，实际 2`
  - 新判据 GREEN（同一构造）：
    `✅ 第二次 acquire 的**绝对性质**必须全部成立（R253/R312…）—— 违规 0 条：无（窗口 ["bot-eaae40ed","bot-4513c114"] → ["bot-eaae40ed","bot-4513c114"]；…）`
  - 判别力自证（四条，逐条只触发一条违规）：
    `C1 窗口内新增成员 ⇒ 1 条` / `C2 被占用的 bot 回池 ⇒ 1 条` / `C3 池成员缺记录 ⇒ 1 条` / `C4 干净输入 ⇒ 0 条`
  - 旧形态对**绝对退化**免疫（它该被换掉的全部理由）：
    `旧等式喂「两次读都是空池」（容量静默丢失为 0）⇒ ✅ 照样绿`；
    对照 `两次读都是同一个非空池 ⇒ 也照样绿` —— 它对「池里到底有没有东西」完全不敏感。

- **R341 「受控第三方池写入」的构造有一个反直觉前提：必须注入 **≥2 个**、且**先把两个都 acquire 出来再一起 release**。**

  **计划怎么写**（R253 说明、Task 3 Step 0.1/Step 3）：「经 `robot.release` 放一个**别的** `{roomCode}`
  的机器人回池，或直接 `ZADD` + `SET` 一个探针记录」。

  **事实是什么**（两次实测踩空，都记下来避免下一个人重走）：
  1. **只注入一个 ≠ 旧等式的失效形态**：第 2 次 acquire 走的是**幂等路径**（`findBound` 命中即
     `continue`，**完全不碰池**）⇒ 那一个成员会**原样留在窗口前后的两次读里**、长度不变
     ⇒ **旧等式照样绿**（第一次写探针时就撞上了这条，差点把「构造失败」读成「旧判据没问题」）。
     真正的失效形态是「**窗口内净增 ≥1**」⇒ 必须注入 **≥2 个**成员，而它们**不**被这次 acquire 取走
     （窗口 = 第 2 次 acquire 本身，acquire 不碰池）。
  2. **「acquire 一个 → release 它 → 再 acquire 下一个 → release」只造出**一个**成员**：
     第 2 次 acquire 会把刚 release 的那个**复用**回来（`takeIdle()` 取 `idleSince` 最小者）
     ⇒ 两次 release 落到**同一个 `botId`**。正确写法：**先把两个都 acquire（都处于绑定中、都在池外）
     再一起 release**（实测原文：`❌ 两次注入必须是两个不同的 bot：["bot-dfe76e13","bot-dfe76e13"]`）。
  3. ⚠️ 要让注入落在「真实切片的两条语句之间」，用了一个**临时代码**（跑完即撤，**不在提交里**）：
     在切片侧 `spawnSync` 一个 `BLPOP p6:gate` / `RPUSH p6:gate-ready` / `BLPOP p6:release` 的握手，
     `spawnSync` 会**同步阻塞切片进程** ⇒ 窗口内切片侧没有并发，注入落在 `poolBeforeSecond` 之后、
     `poolAfterSecond` 之前是**确定的**。另外 `spawnSync` 的 `timeout` 默认 20s，而 `BLPOP` 传的是 60
     ⇒ 命令先被杀、`stdout` 为空 ⇒ 症状是「切片在窗口里等 60 秒后继续」（实测撞过一次，见 R341-b）。
  4. 注入的成员必须是**真实**成员（`bot:{id}` 由 robot-service 自己写）：用**正式 RPC**
     `robot.acquire` → `robot.release` 造，而不是 `ZADD` + 手写记录（后者会顺手证明不了「记录形状」）。

  **怎么改的**：探针/注入器放在 `tools/conformance/dist/`（该目录被 `.gitignore` 忽略；**不进提交**），
  `finally` 里清理并在**正常路径**断言清理成功：
  `✅ 清理成功：ZCARD 回到基线，受控成员与 bot:{id} 记录均为 0`（`ZCARD 0 → 0`、`TTL bot-p6probe1 = -2`）。
  ⚠️ 探针**要求池为空**（基线非空时第 1 次 acquire 会消耗掉一个基线成员，让清理断言红得莫名其妙）
  ⇒ 已在探针里加了一条显式前置断言。

  **R341-b（同一条裁决的副产物）**：`slice-11` 第 6 组的判据条数 **46 → 50**
  （+4 = R115 的三条正对照 + 一条负对照）。计划 §门禁里「`slice-11` 46」是**旧数**，
  门禁按 **50** 验收；其余切片的条数不变。

  ⚠️ 同一条裁决的**余量**：`slice-07.2-rpc` 第 6 组（`tools/conformance/src/slices/slice-07.2-rpc.ts:767`）
  **仍有一条同源的相对量等式**（R253 只点名了 `slice-11`）。本次**未动它**（超出 Task 3 的文件范围）：
  实测它在「池空」与「池非空（种子 2 个）」两种前置下都绿（因为第 2 次 acquire 走幂等路径、不碰池），
  但它与 R253 是同族残留、且对绝对退化同样免疫 ⇒ 建议协调者立条（它的形态与 R340 的解完全相同）。

---

## 门禁实测（协调者，两个 agent 都 settle 之后；conformance 独占）

**HEAD = `df2ce0e`**（`feat/backend` 已合并；后端 agent `1bdd30a` + 取证表 `f9421d1`/`8900b1e`；conformance agent `afe3254`/`91b2a2b`）。
全部 `--force`、**0 cached**。

```bash
cd /home/howe/pokergame
git merge feat/backend --no-edit            # ✅ auto-merge 计划文件，无冲突
pnpm exec turbo run test lint --force      # ✅ Tasks: 29 successful, 29 total / Cached: 0 cached
pnpm exec turbo run build --force          # ✅ Tasks: 10 successful, 10 total / Cached: 0 cached
timeout 1200 pnpm run ci                   # ✅ CI_EXIT=0 ——「=== [ci] 六阶段全部通过 ===」
#  1/6 install 1s · 2/6 lint 9s · 3/6 build 11s · 4/6 test 27s · 5/6 coverage 2s · 6/6 5s
#  第 6 阶段：client/source-boundary ✓ 8 · room-service/no-internal-http.gate ✓ 8
#    · api-gateway/outbound-timeout.gate ✓ 5 · api-gateway/no-route-outside-api.gate ✓ 6
#    · game-service/rule-error-mapping ✓ 3
pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ All files 97.58% ≥ 80，EXIT=0
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK
                                           #    （**本片零前端改动**：产物哈希与 P5 一致）

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8/8 healthy（§14.4 的 DoD 逐字）
for p in 3000 3001 3002 3003 3005; do printf ':%s ' $p; curl -s localhost:$p/api/health; echo; done
#  ✅ :3001 = {"checks":{"redis":"up","mysql":"up"}}；其余四个恰好 {"redis":"up"}

docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ slice-11 通过：**50** 项断言，99.2s      （46 → +4：三条正对照 + 一条负对照）
# ✅ slice-07.2-rpc 61 · slice-07.2-deploy 104 · slice-07.2-hardening 103 · slice-07.2-boundary 82
# ✅ slice-07.2-security 40 · slice-07.1 28 · slice-07 39 · slice-10 185 · slice-09 160
# ✅ slice-08 55 · slice-06 174 · slice-05 29
# ⇒ **13/13 全绿**

docker compose logs api-gateway | grep -c 'Blocked outbound'                                    # ✅ 0
docker compose logs game-service robot-service | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET'   # ✅ 0
```

**R253 的顺序无关性（门禁的一部分，协调者独立复核 —— 不只是相信 agent 的报告）**：
```bash
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
docker compose exec -T redis redis-cli ZCARD bot:pool:ddz   # ✅ 0
timeout 300 node tools/conformance/dist/run.js slice-11     # ✅ 池空 ⇒ 50 项，99.7s
# 种子：经 robot RPC（真线格式 `<len>#<JSON>`，R228）acquire 两个 → **一起** release ⇒ 池里 2 个空闲成员
docker compose exec -T redis redis-cli ZCARD bot:pool:ddz   # ✅ 2
timeout 300 node tools/conformance/dist/run.js slice-11     # ✅ 池非空 ⇒ 50 项，59.7s
# 收尾：清掉种子成员与 bot:{id} 记录 ⇒ ZCARD 回到 0（**不留污染**）
```

**关闭/登记的项**：**R253**（判据换形态）· **R310**（补依赖）· **R119 → 新登记 N26**（实证无影响 + 一条约束，不改代码）· `design.md` **12 处**过期注记清理 · 台账 §3 销掉 **5 行自己已过期的**登记。
**对账表 §0 现为 79 条：78 已关闭 / 0 部分关闭 / 1 仍开放**（`node scripts/ledger-counts.mjs` 已校验逐区一致；仍开放 = **N13**）。

**⚠️ 执行期发现的真问题（四条，全部由 agent 顶回计划里的错误事实）**：
1. **R320** —— 计划说「`@nestjs/typeorm` 注册的 token 实际是 `'DataSource'` 字符串」**是错的**：`getDataSourceToken()` 对**默认**数据源返回 `DataSource ?? Connection`（**类本身**），只有命名数据源才是 `${name}DataSource`。⇒ `health.service.ts` 的 `@Inject(DataSource)` 本来就正确。
2. **R321** —— §1.4 与 §12.5 **不是内联 `[偏差]`**（`grep -c 偏差` = 0）；且 §12.5 有 **2 处入站引用**（§14.2 清单 + A.2 的 A6 行）⇒ **只能改写、不能删标题锚点**。
3. **R322** —— R313 的前提「四处正文已写 `[已实现]`」**只对 §4.2 一处成立**；其余三处的依据是**代码**（§5.5 → `redact.ts` + 五处 `Logger.overrideLogger`；§6.5 → `game.service.ts:322` 的 CAS；§9.5 → `RobotDecideRequest.view` + 三道源码闸）⇒ 四处注记都写了「依据 = 代码/裁决号」。
4. **R323** —— 计划前置事实 4 给的枚举命令**口径不对**：`grep -n '\[偏差\]' docs/design.md` 原样输出 **36** 行，因含 **3 处非内联提及**（`:40` 图例行、`doudizhu.md` 引用行、文末「标记约定」行）⇒ 正确口径要 `grep -vE '^(40|145[0-9]|166[0-9]):'`，得 **33**（清理后 **21**）。

**新登记的未立条工程债（写进 `deviation-ledger.md` §3）**：
- `tools/conformance/src/slices/slice-07.2-rpc.ts` 第 6 组**仍有一条与 R253 同源的相对量等式**（实测池空/池非空都绿 —— 同一机制：第 2 次 acquire 走幂等路径、完全不碰池 ⇒ 它对「池退化成 0」同样免疫）。
- `packages/shared/src/protocol/message.ts` 是一份与 §6.2/§6.3 **冲突的遗留「第二契约」**（含 `seq?: number` 与 `'ping'`，0 个生产消费者，仍被 `shared/src/index.ts` 导出，**无任何闸守着它**）。
- `docs/games/doudizhu.md` 的两条内联 `[偏差]`（C16/C17）已过期。
- `design.md` **仍有 22 处未核实的内联 `[偏差]`** —— **本片刻意不宣称已清干净**（R312）。

---

## 下一步

- ✅ 已完成：Task 1–3（后端 agent Task 1–2 · conformance agent Task 3）→ 协调者合并 `feat/backend`、跑门禁、收口 `design.md`（12 处）与台账（§3 销 5 行 + **N26** + 未核实余量）。
- **MVP 范围内的偏差已全部关闭**；唯一仍开放的是 **N13**（风控 roadmap §16）。
- **留给后来人的四项**（全部登记在 `deviation-ledger.md` §3）：`slice-07.2-rpc` 第 6 组的同源相对量判据 · `shared/src/protocol/message.ts` 遗留第二契约的处置 · `doudizhu.md` 两条过期注记 · `design.md` 剩余 22 处未核实的 `[偏差]`。

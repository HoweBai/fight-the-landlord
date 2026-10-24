# 切片 8 实施计划：叫抢地主

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「叫抢地主」从「能跑通但三处违反玩法规格」修成「与 `docs/games/doudizhu.md` §2/§3/§9 逐条一致」：底牌**真的并入地主手牌**（并在同一片删掉两处补偿）、流局**真的重新发牌且回到座位 0**、倍数上限收敛到 **8**、超时动作抛错后**重挂计时器且不静默吞错**，并给前端补上真正的叫抢 UI 与一条「1 抢 + 2 不抢」的端到端 conformance 用例。

> 🔴 **2026-09-30 全文件订正（片① R1）**：本计划里所有「**流局回座位 0** / `currentBidder` **覆盖为 0** /
> 一律由座位 0 起」的表述**已作废** —— 起始座位改为**随机**（`createSession` / `resetBidding` 各摇一次；
> 见 `docs/games/doudizhu.md` §3.1 v1.3）。**随机座位是规格要求的，不是 bug，不要「修」回去。**
> 本文件保留作历史记录（不删原文），逐处订正见正文中的 🔴 标注。

**Architecture:** 规则真源仍是 `packages/shared/src/ddz/`（纯状态机，`handleBid`/`dealCards`），game-service 只做「取会话 → CAS → 调规则引擎 → 落盘/推送/重挂计时器」的外壳，room-service 只按 `PlayerView.bidPhase.currentBidder` 决定「轮到谁」并下发 `game.current_turn`，前端只读 `PlayerView` 渲染。底牌并入手牌发生在**规则引擎的状态转移里**（`finalizeBidding`），因此 game-service 与 robot-service 的两处补偿**必须同片删除**，否则地主会拿到 23 或 21 张。

**Tech Stack:** TypeScript / NestJS 10 / ioredis / Vitest / pnpm workspace + Turborepo / Vue 3 + Pinia + Vite（`apps/client`）/ socket.io 4

**Spec:**
- `docs/design.md` v4.2 —— 权威依据。本切片主要落在 **§3.2（`GameSession` 的 `bidPhase`/`bottomCards`）、§3.5、§6.3（消息清单）、§6.4（可见性裁剪）、§7.1（`game.bid` 的 403 归属校验）、§9.4（回合驱动与行动者判定）、§10.4（Redis 生命周期）、§11.2（错误码）、§12（前端约束 F01/F02/F09/F10）**
- `docs/games/doudizhu.md` v1.2 —— **规则唯一来源**。本切片逐条落实 **§2（发牌与底牌并入）、§3.1（三个计数器 + 倍数上限 8 + 流局回座位 0）、§3.2（结束条件）、§3.3（流局重新发牌）、§3.4（进入出牌阶段的 9 条）、§9.1（叫抢超时替 `currentBidder` 决策）、§9.2（计时器重挂）**
  ⚠️ **2026-09-30 修复轮标注（原句保留）**：本行是**当时（v1.2）**的落实清单 —— §3.1 现为**五个**计数器
  （＋`firstCaller` / `antiRobGranted`）、「流局回座位 0」已由文件头订正块作废（起始座位随机）、
  倍数上限段现读「最多 4 次声称；反抢同样 ×2、任何路径不越过 8 ⇒ 上限仍 8」。
- `docs/superpowers/plans/deviation-ledger.md` §2「切片 8（叫抢地主）」—— 本片的待办清单来源：**C4 / C15 / C22① / C23 / C24** + 前端叫抢 UI + conformance「1 抢 2 不抢」
- `docs/superpowers/plans/2026-09-13-parallel-dev.md` —— 切片表第 8 行 + Global Constraints 12 条
- `docs/superpowers/plans/agent-briefs.md` —— 角色、工作区、**已知环境事实**（bind-mount 陷阱、`--ignore-scripts`、门禁必须 `--force`）
- `docs/superpowers/plans/2026-09-13-slice-07-match-and-join.md` —— 上一片计划（本片沿用其结构，并沿用 R62/R66「替身必须同步」「计划缺陷就地修正」的教训）

---

## Global Constraints

逐字照抄 `2026-09-13-parallel-dev.md`，每个任务都隐含本节：

| # | 约束 |
|---|------|
| 1 | **端口**：HTTP `3000/3001/3002/3003/3005`，内部 RPC `3103/3105`，douzero `2021`，redis `6379`，mysql `3306` |
| 2 | **测试框架 Vitest**（不是 Jest）。`packages/shared` 行覆盖率 ≥ 80% |
| 3 | **服务间通信必须用 `Transport.TCP`** + `@MessagePattern`，pattern 名与 DTO 见 §4.2 |
| 4 | **对外 REST 与内部 RPC 严禁共用同一个方法**：对外走 `game.view`（裁剪），对内走 `game.snapshot`（完整） |
| 5 | **WebSocket**：socket.io 4，namespace `/ws/ddz`，dot 命名；**ack 承载响应**；**没有 `seq` 字段** |
| 6 | **幂等**：动作请求必须带 `baseVersion`，CAS 失败返回 `13004`。`13002`/`13003` 已废弃、不得使用 |
| 7 | **错误码必须是 5 位数字**（§11.2）。禁止新增字符串错误码；旧字符串码只能出现在 §11.4 的别名表里 |
| 8 | **身份只从网关注入的 `X-User-Id`（HTTP）或 socket 握手 `auth.userId`（WS）取**。**严禁**信任请求体里的 `userId`/`playerId` |
| 9 | **裁剪**：`PlayerView` 是唯一的出站对局类型。`actionLog`、他人 `hand`、`isRobot`、`botId`、`skillLevel` **永不出站** |
| 10 | **牌值编码**：接口/存储层用 DouZero 编码（`2` = 17）；**进入牌型判定前必须还原为内部 Rank**（`2` = 15） |
| 11 | **前端哑终端**：禁止任何游戏规则、牌型判定、游戏常量、货币计算（§12 的 F01–F10） |
| 12 | **契约包 `packages/protocol` 由协调者拥有**。两端**只读**；任何改动（尤其破坏性）必须两端同一个 PR |

### 本切片的绑定数值（来自玩法 §2/§3/§9 与主规格 §3.2/§6.4/§11.2，**逐字**）

| 项 | 值 |
|---|---|
| 发牌 | 每人 **17** 张（51 张），余 **3** 张底牌；底牌在叫抢阶段**不可见**（§2.1/§2.2） |
| 地主手牌 | **20 张** = 原 17 张 ∪ 3 张底牌，**在 `finalizeBidding` 的同一次状态转移里**并入（§2.3/§3.4 第 2 条） |
| `bottomCards` 字段 | 并入后**保留不清空**，供可见性裁剪使用（§3.4 第 5 条） |
| `grabActions` | **每完成一次决策 +1**（「抢」与「不抢」都计入），用途是判定**一轮是否走满 3 次** |
| `bidPasses` | 仅「不抢」+1；**每轮起始清零** |
| `landlordCandidate` | 仅「抢」时写入当前决策者；**随机指定地主的路径同样必须写入**（§3.4 第 3 条） |
| 倍数 | 每「抢」一次 ×2，初始 1，每轮重置 1 ⇒ `bidMultiplier ∈ {1, 2, 4, 8}`，**上限 8** |
| 轮次结束判据 | **唯一**判据 `grabActions >= 3`；此后「有 candidate → 他为地主；无 candidate → 流局」（§3.2） |
| 流局 | `redealCount++`；`< 3` → **重新洗牌发牌** + 叫抢状态归位 + **回到座位 0**；`>= 3` → 随机指定地主（倍数保持 1） |
| 随机地主的 `landlordCandidate` | 必须写入（否则客户端与机器人不知道谁是地主，§3.4 第 3 条） |
| 进入 `playing` | 同一转移内完成 §3.4 的 9 条：`state` / 手牌并入 / `landlordCandidate` / `isLandlord` / `bottomCards` 保留 / `currentPlayer = 地主` / `lastPlayedHand = null` / `lastPlayerIdx = -1` / `version + 1` |
| 叫抢超时 | 视为**不抢**，替 **`bidPhase.currentBidder`** 决策（§9.1） |
| 计时器 | 开局即挂；**每次状态转移后重挂**（**含超时动作本身**）；重挂前先清旧句柄；结束时清除不重挂（§9.2） |
| 叫抢相关错误码 | `12003` NOT_YOUR_TURN（非当前叫抢者）、`13009` GAME_NOT_STARTED（`state === 'init'`）、`13004` VERSION_CONFLICT、`13005` GAME_OVER |

### 协调者裁决（本片新增，执行时不得再自行解释）

- **R101 底牌并入手牌是「一次转移、三处同改」，任一漏改都是硬失败。**
  - ① **真源**：`packages/shared/src/ddz/bid.ts` 的 `finalizeBidding()` 把 `bottomCards` 并入地主 `hand`（排序）；
  - ② **删补偿一**：`packages/robot-service/src/robot/bot.player.ts:28-31` 的 `handForDouZero.concat(bottomCards)`；
  - ③ **删补偿二**：`packages/game-service/src/game/view.builder.ts:75-79` 的 `hand.push(...session.bottomCards)`。
  **为什么漏改会硬失败**（这是本片最容易半途而废的地方）：
  - 漏删 ② ⇒ 机器人视角 **23 张**（20 + 3），DouZero 输入直接错；
  - 漏删 ③ ⇒ 地主手牌 **23 张**，且 `protocol/src/validate.ts:100` 的 `hand.length === cardCounts[seat]` 不变式会被**人为**满足，掩盖真实张数；
  - 只删 ③ 不做 ① ⇒ `hand.length(17) !== cardCounts[landlord](20)` ⇒ `validateOutbound` 在服务端**当场抛错**，三家都收不到推送（比假绿更糟：整局推送链路停摆）。
  因此本片**必须**在 `packages/game-service/test/view.builder.test.ts` 把当前那条「补偿行为用例」改写成「**真实形态**用例」（地主会话里就是 20 张），而不是删掉了事。
- **R102 流局重新发牌的实现位置在 `resetBidding()`，用 `dealCards()` 复用唯一发牌实现。**
  玩法 §3.3 逐字：「流局**必须重新洗牌发牌**（手牌与底牌全部改变）」。`resetBidding` 是唯一的流局出口，
  因此它必须调用 `game.ts` 的 `dealCards()`（洗牌 + 17/17/17 + 3 底牌 + `state = bidding` + `version + 1`），
  再叠加「叫抢状态归位」。**不得**在 `bid.ts` 里重新实现一份洗牌/发牌（`dealCards` 是唯一发牌真源，
  重复实现会立刻产生第二个真相源——这正是 C7「牌值映射单一真源」同一类缺陷）。
  ⚠️ 副作用（**必须一起改测试**）：`dealCards` 会调用 `shuffleDeck`，而 `shuffleDeck` 会调用
  `Math.random()`。既有用例若依赖「流局后手牌不变」，在本片之后必须改成「手牌**变了**」。
- **R103 `bidMultiplier` 上限写 `8`，且**只能在「抢」时 ×2**。**
  玩法 §3.1：一轮最多 3 次「抢」⇒ 取值只能落在 `{1,2,4,8}`。`Math.min(newPhase.bidMultiplier * 2, 8)`
  与「不设上限」在本规则下**行为等价**，但**上限必须显式写出来**：它是「一轮制」这一前提的机械表达，
  将来改成多轮反抢时，第一个该改的就是这个常量。常量命名为 `BID_MULTIPLIER_CAP = 8` 并**导出**，
  让测试可以引用它而不是再写一个字面量 `8`（第二个真相源）。
  ⚠️ **本片不改 `settle.ts` 的倍数合成方式**（`bombCount + bidMultiplier` 的加法是 **C1**，归切片 10）。
  🔴 **2026-09-30 订正（片①）**：反抢已落地（一轮最多 **4** 次声称），但上限**仍是 8** ——
  反抢那一抢**同样 ×2**（每次声称无条件 `min(m×2, 8)`）、只是**任何路径都不越过 8**。
  **不要**因「上界 4」把常量改成 16（玩法 §3.1 v1.3 与 `settle.ts` 的 `{1,2,4,8}` 值域都依赖它）。
  ⚠️ **修复轮订正（2026-09-30）**：本 bullet 原写「第 4 次因 `BID_MULTIPLIER_CAP` 不再加分（`min(8×2, 8) = 8`）」——
  机制表述**错**（那只对「前 3 拍已 3 次声称」成立；前 3 拍 2 次声称时反抢那一抢把 4 升到 8）；**结论（上限 8 / 不许改 16）不变**。
- **R104 `currentBidder` 只有一个推进点。**
  旧实现有**两个**：`handleBid` 里 `(playerIdx + 1) % 3` 推一次，`resetBidding` 里
  `(session.bidPhase.currentBidder + 1) % 3` 又推一次 ⇒ 流局后不回座位 0（实测起始座位 `0→1→2`）。
  裁决：`resetBidding` **无条件把 `currentBidder` 置为 `0`**（玩法 §3.1「每轮流局重新开始后，一律由座位 0 起」），
  并**删掉** `resetBidding` 里那次推进。这样「推进」只剩 `handleBid` 一处，流局是**覆盖**而不是**再推进**。
  🔴 **2026-09-30 订正（片① R1）**：本条裁决中的**「置为 `0`」部分已作废** —— 起始座位改为**随机**
  （`resetBidding` 用注入的 `random` 重摇；玩法 §3.1 的引文已随 v1.3 更新）。「**覆盖而非推进**」这一点
  **保留不变**。**随机座位是规格要求的，不是 bug，不要「修」回去。**
- **R105 随机指定地主的路径必须写 `landlordCandidate`（玩法 §3.4 第 3 条）。**
  这不是清单里的独立编号，而是 **C15 的同一代码块**（`finalizeBidding` 的两个调用点之一）：
  旧实现只在「有人抢」的分支经 `newPhase.landlordCandidate` 带值，随机分支传进去的
  `landlordCandidate` 仍是 `-1` ⇒ `PlayerView.landlordCandidate = -1`、`landlordSeat` 只能靠
  `players[].isLandlord` 兜底。本片既然要动 `finalizeBidding`，**必须在同一处把它写对**：
  `finalizeBidding` 负责把 `bidPhase.landlordCandidate = landlordIdx` 落定（对两条路径都成立）。
  归属仍是切片 8（同一次改动、同一片验收），不另立条目。
- **R106 超时动作抛错后必须「重挂计时器 + 不静默吞错」，但**不得**留下 tight loop。**
  规格（玩法 §9.2 第 2 条）：每次状态转移后必须重挂，**包括超时动作本身**。
  裁决：
  1. `catch` 里**必须**记 `logger.error`（带上房间号、座位、原始错误文本），**不得**只 `log` 一行或吞掉；
  2. `catch` 里**必须**重挂计时器（用当前会话状态，不推进任何计数器），使「下一次超时」仍会发生；
  3. `catch` 里**不得**修改会话（不改 `version`、不落盘、不推送）—— 否则等于替服务端编造了一次转移；
  4. 为防瞬时 tight loop，重挂的延时取 `TURN_TIMEOUT_MS`（30s，与正常回合一致），**不得**写 `0`/`1`。
  ⚠️ **本片不做 §9.1 的「首出超时打最小单张」**（那是 C5，归切片 9）：切片 8 只保证
  「超时后对局**仍在推进**（有计时器）且错误**可见**（日志）」。因此**本片不新增**对
  `handlePass` 失败后的兜底出牌逻辑。
- **R107 前端的叫抢 UI 只做「接线与禁用」，不做任何规则判断。**
  §12 的 F01/F02/F09/F10 禁止前端出现「叫抢规则」「倍数计算」「底分常量」：
  - 行动者只读 `PlayerView.bidPhase.currentBidder`（store 已有 `actorSeat` getter，本片复用）；
  - 按钮只发 `game.bid { grab: true|false }`，**不带**任何版本外的推断；
  - 倍数、地主、底牌**一律只显示服务端给的字段**（不得出现 `×2`、`8` 这类本地计算）。
  可测的接线判据（否则「UI 已实现」无法验收）：
  ① 不是我的回合 ⇒ 两个按钮 `disabled`；
  ② 是我的回合 ⇒ 按钮可点，点击发 `game.bid` 且 `payload.grab` 正确；
  ③ 叫抢阶段**不得**渲染出牌/过牌按钮；出牌阶段**不得**渲染抢/不抢按钮。
  为了让这三条可断言，模板必须给按钮加**稳定的 class**：抢 = `.table__bid-grab`、
  不抢 = `.table__bid-pass`、出牌 = `.table__play`、过牌 = `.table__pass`（当前两处都是 `.btn--primary` 的裸选择器，
  未来任何样式调整都会让用例静默失配 —— 这是「用例必须钉住结构而不是外观」）。
- **R108 game-service 的 `handleBid` 超时用例必须用**结构性判据**，不得依赖墙钟。**
  `pnpm exec turbo run test --force` 会并发跑 29 个任务（见 `agent-briefs.md`「切片 7 新增的通用教训」第 4 条）。
  断言只允许用：`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(...)` 推进；
  断言对象是**会话字段**（`bidPhase.currentBidder` / `version` / `timers.has(roomCode)`），
  以及**日志调用**（spy `Logger.error`）。**不得**断言 `Date.now()` 的差值。
- **R109 `packages/protocol` 本片零改动。**
  需要的字段（`bidPhase.currentBidder` / `bidMultiplier` / `landlordCandidate` / `grabActions` / `redealCount`）
  与错误码（`12003` / `13009` / `13004` / `13005`）都已存在（切片 0 定义）。
  任何「顺手改契约」的冲动都必须先停下来问协调者（Global Constraint 12）。
- **R110 本片新增 conformance 用例 `slice-08`，并把它挂进 `tools/conformance/package.json` 与 `run.ts`。**
  用例名 `slice-08`，标题「叫抢地主」。**判据的主线是「1 抢 + 2 不抢」这一条真实链路**：
  它是 `grabActions` 语义（按**决策次数**计，不是按「抢」的次数计）的**唯一**可判别形态
  ——旧实现若把 `grabActions` 误读为「抢的次数」，这条会**永不结束**（`grabActions=1 < 3` 且 `bidPasses=2 < 3`）。
  conformance 必须**同时钉住张数**：地主 `hand.length === 20`、两农民 `17`、三家 `cardCounts` 一致、
  且 `bottomCards` 是地主手牌的**子集**。这三条合起来才足以证明 C15 的三处改动是**一致的**。

---

## 执行模型（与切片 5/6/7 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | Task 6（conformance）、评审、合并、门禁 |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | Task 1、2、3、4 |
| **前端 agent** | `.worktrees/frontend`（`feat/frontend`） | Task 5 |

**开工前固定动作**（两端都要）：

```bash
cd /home/howe/pokergame/.worktrees/<你的角色>
git merge master --no-edit        # master 已含切片 7 与 7.2-P0/P1 的全部裁决
pnpm install && pnpm build        # dist/ 是 gitignore 的；不重装会因解析不到 protocol 而假失败
```

**本片的文件集互不相交**：后端只动 `packages/{shared,game-service,robot-service}/**`，
前端只动 `apps/client/**` ⇒ 两条线可以真正并行，合并应干净。

> ⚠️ **`packages/shared` 是后端 agent 的写区**（它属于「后端骨架」那一侧，见 `agent-briefs.md` 的可写清单）。
> 前端 agent **依然不得** import 它（Global Constraint 11 / F03），本片也不给前端新增任何对它的依赖。

---

## File Structure

```
packages/shared/src/ddz/bid.ts                       Modify: C4 流局重发 + C15 底牌并入 + C23 上限 8 + C24 单点推进 + R105 随机地主写 candidate
packages/shared/src/ddz/bid.test.ts                  Modify: 上述五条的行为用例（含「流局后手牌真的换了」）
packages/shared/src/ddz/game.ts                      Modify: 导出 dealCards 供 bid.ts 复用（已导出，仅确认）；无行为改动
packages/game-service/src/game/view.builder.ts       Modify: 删掉补偿二（底牌并入）
packages/game-service/test/view.builder.test.ts      Modify: 把「补偿行为用例」改写成「真实 20 张形态用例」
packages/game-service/src/game/game.service.ts       Modify: C22① 超时抛错后重挂计时器 + 不吞错
packages/game-service/test/game.timer.test.ts        Modify: 超时重挂 / 抛错不吞 / 单一活动计时器 用例
packages/game-service/test/full-game.test.ts         Modify: 叫抢结束时地主 20 张 + 底牌子集 + candidate 落地
packages/robot-service/src/robot/bot.player.ts       Modify: 删掉补偿一（+3）
packages/robot-service/test/bot.player.test.ts       Create: 地主手牌不再 +3、农民手牌原样

apps/client/src/pages/table.vue                      Modify: 叫抢 UI 稳定 class + 行动者/禁用依据写明
apps/client/test/table-bid-ui.test.ts                Create: 叫抢按钮接线（禁用/发 game.bid/阶段互斥/无本地倍数）
apps/client/test/source-boundary.test.ts             Modify: （若需要）把新增模板 class 纳入既有静态扫描断言

tools/conformance/src/slices/slice-08-bidding.ts     Create: 「1 抢 + 2 不抢」端到端用例
tools/conformance/src/run.ts                         Modify: 注册 slice-08
tools/conformance/package.json                       Modify: 加 conformance:slice-08 脚本
```

---

## Task 1: `shared/bid.ts` —— 底牌并入 + 单一推进 + 上限 8（C15/C24/C23/R101/R102/R104）

**为什么单独成任务**：这是**规则真源**的一次改动，三个编号（C15/C23/C24）都落在同一个文件、
同一段控制流里。评审可以只看这一个文件 + 它的用例就判定「规则是否与玩法 §3 一致」。
Task 2/3/4 都是它的**连带**（删补偿、重挂计时器），所以本任务必须**先**做，且必须**一次做完**
（R101：漏一处就是硬失败）。

**Files:**
- Modify: `packages/shared/src/ddz/bid.ts`
- Modify: `packages/shared/src/ddz/bid.test.ts`
- Test: `packages/shared/src/ddz/bid.test.ts`

**Interfaces:**
- Consumes: `dealCards(session: GameSession): GameSession`（`./game`，**本片不改它**，只复用）、
  `GameState`（`./types`）、`GameSession`/`GamePlayer`（`./types`）
- Produces（Task 2/3/4 与 conformance 都依赖这些**行为**，不新增导出名）：
  - `handleBid` 的两条出口都保证：进 `playing` 时 `players[landlordIdx].hand.length === 20`，
    且 `hand` 恰为「原 17 张 ∪ `bottomCards`」（排序后）；
  - `bidPhase.landlordCandidate === landlordIdx`（**两条路径都成立**，R105）；
  - 流局（`redealCount < 3`）后：`currentBidder === 0`、`grabActions === 0`、`bidPasses === 0`、
    `bidMultiplier === 1`、`state === 'bidding'`、**手牌与底牌已重新洗牌发牌**；
  - `BID_MULTIPLIER_CAP = 8`（**新导出常量**，供测试与 reader 引用，R103）

- [ ] **Step 1: 写失败测试**

把 `packages/shared/src/ddz/bid.test.ts` 里现有的这两条**删掉**（它们锁的正是本片要废除的行为）：

```ts
// 删除：'resets bidding after 3 passes' —— 它只断言「还是 bidding」，对流局重发毫无约束
// 删除：'finalizes when grabActions >= 3' 里的 expect(s.players[0].isLandlord).toBe(true) 之后
//        需要补 20 张断言（不是删除整条，是加强）
```

在 `describe('handleBid')` 末尾**新增**下面六组用例（**保留**既有的「throws when…」三条与
「accepts bid / accepts pass」「moves currentBidder…」「increments version」「does not mutate input session」）：

```ts
  // ── C15 / R101：底牌并入地主手牌（三处同改的「真源」这一处）────────────
  it('地主确定时把 bottomCards 并入其 hand，恰好 20 张且是「原手牌 ∪ 底牌」（C15 / 玩法 §2.3/§3.4-2）', () => {
    const before = dealCards(createSession('ROOM-C15', ['user-1', 'user-2', 'user-3']));
    const landlordBefore = [...before.players[0]!.hand].sort((a, b) => a - b);
    const bottom = [...before.bottomCards].sort((a, b) => a - b);
    expect(landlordBefore).toHaveLength(17);
    expect(bottom).toHaveLength(3);

    let s = handleBid(before, 'user-1', true); // 座位 0 抢
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false);

    expect(s.state).toBe(GameState.Playing);
    expect(s.players[0]!.isLandlord).toBe(true);
    expect(s.players[0]!.hand).toHaveLength(20);
    expect([...s.players[0]!.hand].sort((a, b) => a - b)).toEqual(
      [...landlordBefore, ...bottom].sort((a, b) => a - b),
    );
    // 农民的 17 张不得被碰
    expect(s.players[1]!.hand).toHaveLength(17);
    expect(s.players[2]!.hand).toHaveLength(17);
    // 玩法 §3.4-5：bottomCards 保留不清空（可见性裁剪要用）
    expect(s.bottomCards).toHaveLength(3);
    // 玩法 §3.4-1/6/7：进入 playing 的同一转移里完成
    expect(s.currentPlayer).toBe(0);
    expect(s.lastPlayedHand).toBeNull();
    expect(s.lastPlayerIdx).toBe(-1);
  });

  it('地主手牌并入后不再有别的补偿空间：20 张是最终值，重复调用 handler 不会变成 23（C15 回归）', () => {
    let s = handleBid(dealCards(createSession('ROOM-C15B', ['a', 'b', 'c'])), 'a', true);
    s = handleBid(s, 'b', false);
    s = handleBid(s, 'c', false);
    const first = s.players[0]!.hand.length;
    // 进入 playing 后再叫抢必须被拒（不是「继续叫」），因此不存在第二次并入
    expect(() => handleBid(s, 'a', true)).toThrow('not in bidding state');
    expect(s.players[0]!.hand.length).toBe(first);
    expect(first).toBe(20);
  });

  // ── C24 / R104：流局后回到座位 0（单点推进）──────────────────────────
  it('流局后 currentBidder 回到座位 0（C24：不得双重推进）', () => {
    let s = handleBid(session, 'user-1', false);
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false);
    expect(s.state).toBe(GameState.Bidding);
    expect(s.bidPhase.currentBidder).toBe(0);
    expect(s.bidPhase.grabActions).toBe(0);
    expect(s.bidPhase.bidPasses).toBe(0);
    expect(s.bidPhase.bidMultiplier).toBe(1);
    expect(s.bidPhase.redealCount).toBe(1);
  });

  it('连续两次流局后仍从座位 0 起（旧实现是 0 → 1 → 2 的推进）', () => {
    let s = session;
    for (let round = 0; round < 2; round += 1) {
      s = handleBid(s, 'user-1', false);
      s = handleBid(s, 'user-2', false);
      s = handleBid(s, 'user-3', false);
      expect(s.bidPhase.currentBidder).toBe(0);
    }
    expect(s.bidPhase.redealCount).toBe(2);
    expect(s.state).toBe(GameState.Bidding);
  });

  // ── C4 / R102：流局必须重新发牌 ─────────────────────────────────────
  it('流局重新洗牌发牌：手牌与底牌全部改变、每家仍是 17 张、底牌仍是 3 张（C4 / 玩法 §3.3）', () => {
    const handsBefore = session.players.map((p) => p.hand.join(','));
    const bottomBefore = session.bottomCards.join(',');

    let s = handleBid(session, 'user-1', false);
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false);

    for (const p of s.players) expect(p.hand).toHaveLength(17);
    expect(s.bottomCards).toHaveLength(3);
    // ⚠️ 概率判据：54 张牌重洗后三家手牌与底牌**全部**与上一轮逐位相同的概率可以忽略；
    //    这条断言钉的是「真的调了 dealCards」，而不是「看起来像重发了」。
    const handsAfter = s.players.map((p) => p.hand.join(','));
    expect(handsAfter.join('|')).not.toBe(handsBefore.join('|'));
    expect(s.bottomCards.join(',')).not.toBe(bottomBefore);
    // 同一副牌只发一次：三家手牌 + 底牌必须两两不重叠（防止「重发时忘了清旧手牌」）
    const all = [...s.players.flatMap((p) => p.hand), ...s.bottomCards];
    expect(all).toHaveLength(54);
    expect(new Set(all).size).toBe(54);
  });

  it('流局重发是一次状态转移：version 恰好 +1（玩法 §3.4-8 / 主规格 §3.2）', () => {
    let s = handleBid(session, 'user-1', false);
    s = handleBid(s, 'user-2', false);
    const beforeReset = s.version;
    s = handleBid(s, 'user-3', false);
    expect(s.version).toBe(beforeReset + 1);
  });

  // ── C23 / R103：倍数上限 8 ──────────────────────────────────────────
  it('三人全抢 → bidMultiplier 恰好 8（不是 16/24；C23）', () => {
    let s = handleBid(session, 'user-1', true);
    s = handleBid(s, 'user-2', true);
    s = handleBid(s, 'user-3', true);
    expect(s.bidPhase.bidMultiplier).toBe(BID_MULTIPLIER_CAP);
    expect(s.bidPhase.bidMultiplier).toBe(8);
    // 一轮制下三个「抢」⇒ 最后一次抢的人（座位 2）是地主
    expect(s.state).toBe(GameState.Playing);
    expect(s.players[2]!.isLandlord).toBe(true);
    expect(s.bidPhase.landlordCandidate).toBe(2);
  });

  it('「抢」只在自己那一步 ×2，不抢不变（倍数只能取 1/2/4/8）', () => {
    let s = handleBid(session, 'user-1', false);
    expect(s.bidPhase.bidMultiplier).toBe(1);
    s = handleBid(s, 'user-2', true);
    expect(s.bidPhase.bidMultiplier).toBe(2);
    s = handleBid(s, 'user-3', false);
    expect(s.bidPhase.bidMultiplier).toBe(2);
  });

  // ── R105：随机指定地主的路径必须写 landlordCandidate ────────────────
  it('第 3 次流局随机指定地主时，landlordCandidate 必须落地（玩法 §3.4-3 / R105）', () => {
    // 走到第 3 次流局：每次三家全不抢
    let s = session;
    for (let round = 0; round < 3; round += 1) {
      s = handleBid(s, 'user-1', false);
      s = handleBid(s, 'user-2', false);
      s = handleBid(s, 'user-3', false);
    }
    expect(s.bidPhase.redealCount).toBe(3);
    expect(s.state).toBe(GameState.Playing); // 第 3 次不再重发，直接指定
    const landlord = s.players.find((p) => p.isLandlord)!;
    expect(landlord).toBeDefined();
    // 「谁是地主」的唯一来源：client 与 robot 都只能读它
    expect(s.bidPhase.landlordCandidate).toBe(landlord.seat);
    // 随机地主也要拿底牌（§3.4 第 2 条对两条路径都成立）
    expect(landlord.hand).toHaveLength(20);
    // 随机指定时不因流局次数翻倍：流局已把倍数归位为 1
    expect(s.bidPhase.bidMultiplier).toBe(1);
  });
```

顶部 import 改成（**新增** `BID_MULTIPLIER_CAP` 与 `createSession`）：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { handleBid, BID_MULTIPLIER_CAP } from './bid';
import { GameState } from './types';
import { createSession, dealCards } from './game';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/shared test -- bid`
Expected: FAIL —— 至少这几条**必然红**（这就是 RED 证据，必须抄进汇报）：

- `BID_MULTIPLIER_CAP is not exported`（常量还不存在）；
- 「地主确定时把 bottomCards 并入」：`hand.length` 实际 **17**（期望 20）；
- 「流局后 currentBidder 回到座位 0」：实际 **1**（旧实现双重推进）；
- 「流局重新洗牌发牌」：手牌与底牌**逐位相同**；
- 「三人全抢 → 恰好 8」：实际 **16**（上限 24 时 1→2→4→8→… 一轮三次抢是 8 —— 注意：
  一轮只有 3 次决策，因此这条在旧实现下**也是 8**；它没有区分力，只作**防回归**，
  真正的 C23 判别力在**常量导出与否**上。**汇报里必须如实标注**，不得把它当成 RED 证据）；
- 「第 3 次流局随机指定地主」：`landlordCandidate` 实际 **-1**。

- [ ] **Step 3: 改 `packages/shared/src/ddz/bid.ts`**

整文件替换为下面这份（**逐字**，注释是给下一个读者的规格锚点，不要删）：

```ts
import { GameState, GameSession } from './types';
import { dealCards } from './game';

/**
 * 叫抢倍数上限（玩法 §3.1）。
 *
 * 一轮叫抢最多 3 次「抢」⇒ `bidMultiplier ∈ {1, 2, 4, 8}`。
 * **必须显式写出上限**：它是「一轮制」这一前提的机械表达；将来若允许反抢（多轮），
 * 第一个要改的就是这里。不要因为「一轮制下不可达」就省掉它（旧实现写 24，误导性极强）。
 */
export const BID_MULTIPLIER_CAP = 8;

export function handleBid(session: GameSession, playerId: string, bid: boolean): GameSession {
  const playerIdx = session.players.findIndex((p) => p.id === playerId);
  if (playerIdx === -1) {
    throw new Error(`Player ${playerId} not found`);
  }
  if (session.state !== GameState.Bidding) {
    throw new Error('Game is not in bidding state');
  }
  if (playerIdx !== session.bidPhase.currentBidder) {
    throw new Error('Not your turn to bid');
  }

  const newPhase = { ...session.bidPhase };
  // 玩法 §3.1：**每完成一次决策都 +1**（「抢」与「不抢」都计入）—— 这是判定轮次结束的唯一计数器。
  newPhase.grabActions++;

  if (bid) {
    // landlordCaller 是历史字段（保留形状）；landlordCandidate 才是「谁是地主」的真源。
    newPhase.landlordCaller = playerIdx;
    newPhase.landlordCandidate = playerIdx;
    newPhase.bidMultiplier = Math.min(newPhase.bidMultiplier * 2, BID_MULTIPLIER_CAP);
  } else {
    newPhase.bidPasses++;
  }

  // 唯一的 currentBidder 推进点（R104）：`resetBidding` **覆盖**为 0，不再推进。
  newPhase.currentBidder = (playerIdx + 1) % 3;

  // 玩法 §3.2：轮次结束的**唯一**判据是「一轮走满 3 次决策」。
  // 这一条覆盖「1 抢 2 不抢」「2 抢 1 不抢」「3 全抢」「3 全不抢」四种情形，无遗漏分支。
  if (newPhase.grabActions >= 3) {
    if (newPhase.landlordCandidate !== -1) {
      return finalizeBidding({ ...session, bidPhase: newPhase }, newPhase.landlordCandidate);
    }
    // 三家全不抢 → 流局
    newPhase.redealCount++;
    if (newPhase.redealCount >= 3) {
      // 第 3 次流局不再重发，随机指定一名地主（倍数已归位为 1）
      const randomIdx = Math.floor(Math.random() * 3);
      return finalizeBidding({ ...session, bidPhase: newPhase }, randomIdx);
    }
    return resetBidding({ ...session, bidPhase: newPhase });
  }

  return { ...session, bidPhase: newPhase, version: session.version + 1 };
}

/**
 * 地主确定 → 进入出牌阶段（玩法 §3.4 的 9 条在**同一次状态转移**里完成）。
 *
 * R101：底牌并入地主手牌**就在这里**，它是唯一真源；game-service 的
 * `view.builder` 与 robot-service 的 `bot.player` 的两处补偿**必须同时删除**，
 * 否则地主/机器人视角会变成 23 张。
 */
function finalizeBidding(session: GameSession, landlordIdx: number): GameSession {
  const players = session.players.map((p, idx) => {
    if (idx !== landlordIdx) return { ...p, isLandlord: false };
    // §3.4-2：`landlord.hand = sort([...landlord.hand, ...bottomCards])`（DouZero 编码）
    return {
      ...p,
      isLandlord: true,
      hand: [...p.hand, ...session.bottomCards].sort((a, b) => a - b),
    };
  });

  return {
    ...session,
    players,
    state: GameState.Playing,
    currentPlayer: landlordIdx,
    lastPlayerIdx: -1, // §3.4-7：地主首出不受跟牌约束
    lastPlayedHand: null,
    bidPhase: {
      // §3.4-3 / R105：两条路径（有人抢 / 随机指定）都必须把 candidate 落定 ——
      // 它是「谁是地主」的唯一来源，客户端与机器人都只能读它。
      ...session.bidPhase,
      landlordCandidate: landlordIdx,
    },
    // §3.4-5：bottomCards **保留不清空**（可见性裁剪依赖它）
    version: session.version + 1, // §3.4-8
  };
}

/**
 * 流局（玩法 §3.3）：**必须重新洗牌发牌**，而不是沿用原手牌重开叫抢。
 *
 * R102：发牌的唯一实现是 `game.ts` 的 `dealCards()`，这里**复用**它，
 * 绝不重新实现洗牌/发牌（那会立刻产生第二个真相源）。
 * `dealCards` 负责：洗牌、17/17/17、3 张底牌、`state = bidding`、`version + 1`。
 *
 * R104：流局后**一律回到座位 0**（玩法 §3.1），因此这里是**覆盖**而非推进。
 */
function resetBidding(session: GameSession): GameSession {
  const redealt = dealCards(session);
  return {
    ...redealt,
    bidPhase: {
      currentBidder: 0,
      landlordCaller: -1,
      landlordCandidate: -1,
      bidPasses: 0,
      grabActions: 0,
      bidMultiplier: 1,
      // redealCount 跨轮累计（玩法 §3.2 要点 3）
      redealCount: session.bidPhase.redealCount,
    },
  };
}
```

> 🔴 **2026-09-30 修复轮标注（片①）**：上面代码块里 `BID_MULTIPLIER_CAP` 的注释「一轮叫抢最多 3 次「抢」」
> （与正文 R103 原句同源）**已过期** —— 一轮最多 **4** 次声称，且反抢那一抢**同样 ×2**（`min(m×2, 8)`）、
> 只是**任何路径都不越过 8**（上限 8 与 `{1,2,4,8}` 值域**不变**）。现行逐字注释见 `packages/shared/src/ddz/bid.ts:4-12`；
> 本代码块里的「`resetBidding` **覆盖**为 0」句见文件头订正块。

> ⚠️ **`dealCards` 会 `version + 1`**，`resetBidding` 不再自己加 —— 一次流局**恰好**一次
> `version + 1`（否则 CAS 的 `baseVersion` 会与客户端观测到的版本号错位）。
> 实现完成后请跑一次 `grep -n "version + 1" packages/shared/src/ddz/bid.ts` 确认：
> 只应出现在 `handleBid` 的普通出口与 `finalizeBidding` 两处（`resetBidding` 里**没有**）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/shared test`
Expected: PASS（`shared` 全部用例）

⚠️ 如果 `settle.test.ts` / `play.test.ts` 因为「流局重发」而红，**不要改它们的断言** ——
先判断是不是它们**显式构造了 3 次不抢**（那属于「锁定了旧行为」，可以顺手改成新行为，
并在汇报里点名）；若不是，说明 Task 1 的实现越界了。

- [ ] **Step 5: 全量验证并提交**

```bash
pnpm --filter @fight-the-landlord/shared test && pnpm --filter @fight-the-landlord/shared lint
pnpm test && pnpm lint
git add packages/shared
git commit -m "fix(shared): 叫抢流局重新发牌+回座位0、底牌并入地主手牌、倍数上限 8（C4/C15/C23/C24，玩法 §2/§3）"
```

> ⚠️ **此时 `pnpm test` 的 game-service 会红**（`view.builder` 的补偿二现在**双重并入**，
> 地主变成 23 张，`validateOutbound` 当场抛错）。这是**预期**的中间态，由 Task 2 立刻收口。
> 若你希望每个 commit 都全绿，可把 Task 1 与 Task 2 合成一个 commit —— **但不要**把 Task 1 拆到 Task 2 之后。

---

## Task 2: `game-service/view.builder.ts` —— 删掉补偿二（R101 / C15 三处同改之二）

**为什么紧跟 Task 1**：Task 1 之后**服务端推送链路是断的**（见上）。本任务是把它接回来的**唯一**动作，
且它的判据就是把 `view.builder.test.ts` 里那条「补偿行为用例」改写成「真实形态用例」。
两件事必须同一个 commit。

**Files:**
- Modify: `packages/game-service/src/game/view.builder.ts:71-79`
- Modify: `packages/game-service/test/view.builder.test.ts`（那条 `keeps the hand/cardCounts invariant by folding the bottom cards into the landlord hand`）
- Test: `packages/game-service/test/view.builder.test.ts`

**Interfaces:**
- Consumes: Task 1 的行为（`finalizeBidding` 已并入底牌）
- Produces: `buildPlayerView(session, seat)` **不再修改** `session.players[seat].hand`；
  它只做裁剪。地主 `PlayerView.hand.length === 20` 完全来自会话本身。

- [ ] **Step 1: 写失败测试（把补偿用例改写成真实形态）**

在 `packages/game-service/test/view.builder.test.ts` 里把这条用例**整条替换**：

```ts
  // ❌ 旧用例（本片删除）：它断言的是「补偿」本身 —— 会话里地主只有 5 张、
  //    view 里给出 8 张。C15 修好后这不可能是真实形态，留着它等于把补偿锁死。
  // it('keeps the hand/cardCounts invariant by folding the bottom cards into the landlord hand', …)
```

```ts
  it('地主手牌由会话自带（20 张），view.builder 不再并入底牌（C15 / R101）', () => {
    // ⚠️ 这是**真实形态**：`finalizeBidding()` 已经把底牌并进地主手牌，
    //    所以会话里就是 20 张。若 view.builder 还留着补偿，这里会得到 23 张 ⇒ 用例红。
    const hand20 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 17, 20];
    const session = makeSession({
      state: GameState.Playing,
      bottomCards: [12, 13, 14],
      players: [
        { id: 'alice', seat: 0, hand: [3, 4, 5], isLandlord: false, isBot: false, isOffline: false },
        {
          id: 'bob',
          seat: 1,
          hand: [...hand20, 12, 13, 14].sort((a, b) => a - b), // 17 + 3 = 20
          isLandlord: true,
          isBot: false,
          isOffline: false,
        },
        { id: 'carol', seat: 2, hand: [30, 30, 30], isLandlord: false, isBot: false, isOffline: false },
      ],
    });

    const bob = buildPlayerView(session, 1);
    expect(bob.hand).toHaveLength(20);
    expect(bob.cardCounts[1]).toBe(20);
    expect(bob.hand.length).toBe(bob.cardCounts[bob.seat]); // 协议不变式（validate.ts:100）

    // 地主能完整看到底牌（§6.4：playing 后三家皆可见）
    for (const c of [12, 13, 14]) expect(bob.hand).toContain(c);
    expect(bob.bottomCards).toEqual([12, 13, 14]);

    // 农民侧只看到张数，自己的手牌不受影响
    const alice = buildPlayerView(session, 0);
    expect(alice.hand).toEqual([3, 4, 5]);
    expect(alice.cardCounts).toEqual([3, 20, 3]);
    expect(alice.bottomCards).toEqual([12, 13, 14]);
  });

  it('底牌并入只发生一次：view.builder 不得对同一份会话重复并入（反向断言）', () => {
    const session = makeSession({
      state: GameState.Playing,
      bottomCards: [12, 13, 14],
      players: [
        { id: 'alice', seat: 0, hand: [3], isLandlord: true, isBot: false, isOffline: false },
        { id: 'bob', seat: 1, hand: [6], isLandlord: false, isBot: false, isOffline: false },
        { id: 'carol', seat: 2, hand: [10], isLandlord: false, isBot: false, isOffline: false },
      ],
    });

    const first = buildPlayerView(session, 0);
    const second = buildPlayerView(session, 0);
    // 两次调用必须逐字段相等 —— 旧实现的 `hand.push(...)` 会**修改会话对象**，
    // 第二次调用就变成 1 + 3 + 3 = 7 张（这正是「补偿」最阴的一面：它污染了真源）。
    expect(second.hand).toEqual(first.hand);
    expect(session.players[0]!.hand).toEqual([3]);
    expect(first.hand).toEqual([3]); // 会话里没有底牌就是没有，view 不许凭空造
  });
```

> ⚠️ 第二条用例**对旧实现是 RED**（旧实现第一条 `buildPlayerView` 就把底牌 push 进了
> `session.players[0].hand`，第二次变成 7 张），因此它是**真判别力**的那条。
> 第一条用例的价值是钉住「20 张」这一目标形态。汇报里必须分别说明两条的证据强度。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/game-service test -- view.builder`
Expected: FAIL —— 第一条：`bob.hand` 长度 23（期望 20）；
第二条：`second.hand` 为 7 张（或 `session.players[0].hand` 被污染成 4 张）。

- [ ] **Step 3: 删掉补偿二**

`packages/game-service/src/game/view.builder.ts` 里**删除**这段（原 71-79 行）：

```ts
  // ❌ 删除：底牌归地主、避免 hand.length !== cardCounts[seat] 的补偿
  if (ownsLandlord && bottomCardsVisible && session.bottomCards.length === 3) {
    hand.push(...session.bottomCards);
    hand.sort((a, b) => a - b);
    cardCounts[seat as 0 | 1 | 2] = hand.length;
  }
```

同时删掉**因此不再使用**的局部变量（`room-service`/`game-service` 的 lint 是 `tsc --noEmit` 且
`noUnusedLocals: true`，留着会直接构建失败）：

```ts
  const landlord = players.find((p) => p.isLandlord && p.seat >= 0 && p.seat <= 2);
  const ownsLandlord = landlord !== undefined && landlord.seat === seat;
```

⇒ 改为只保留 `landlordSeat` 计算需要的那部分：

```ts
  const landlord = players.find((p) => p.isLandlord && p.seat >= 0 && p.seat <= 2);

  const candidate = session.bidPhase?.landlordCandidate ?? -1;
  const landlordSeat =
    landlord !== undefined
      ? landlord.seat
      : candidate >= 0 && candidate <= 2
        ? candidate
        : null;
```

并在 `const hand = players[seat]?.hand ?? [];` 上方加注释说明**为什么这里不做任何并入**：

```ts
  // ⚠️ 这里**不得**并入底牌（R101）：底牌由 `shared/ddz/bid.ts` 的 `finalizeBidding()`
  // 在状态转移里并进地主手牌，是唯一真源。此处若再并入，地主会拿到 23 张；
  // `protocol/src/validate.ts` 的 `hand.length === cardCounts[seat]` 会被**人为**满足，掩盖真实张数。
  // 播放阶段 `bottomCards` 仍然照发（§6.4：三家皆可见），但它是「展示用副本」，不是手牌来源。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/game-service test`
Expected: PASS（`game-service` 全部用例）

- [ ] **Step 5: 全量验证并提交**

```bash
pnpm --filter @fight-the-landlord/game-service test && pnpm test && pnpm lint
git add packages/game-service/src/game/view.builder.ts packages/game-service/test/view.builder.test.ts
git commit -m "fix(game-service): 删除底牌并入的视图补偿，地主手牌以会话为唯一真源（C15/R101）"
```

---

## Task 3: `robot-service/bot.player.ts` —— 删掉补偿一（R101 / C15 三处同改之三）

**Files:**
- Modify: `packages/robot-service/src/robot/bot.player.ts:24-31`
- Test: `packages/robot-service/test/bot.player.test.ts`（**Create**）

**Interfaces:**
- Consumes: Task 1 的行为（地主会话手牌已是 20 张）
- Produces: `BotPlayer.decideMove()` 送给 DouZero 的 `context.hand` **恒等于**
  `player.hand`（排序后），**不再**按 position 追加 `bottomCards`；
  `context.bottomCards` 仍照传（DouZero 协议里有这个字段，见 `douzero.client.ts:10`）。

- [ ] **Step 1: 写失败测试**

Create `packages/robot-service/test/bot.player.test.ts`：

```ts
/**
 * C15 / R101 三处同改之三：机器人**不得**再给地主补底牌。
 *
 * 为什么值得一条独立用例：这个 `+3` 是**服务端行为**（送进 DouZero 的特征），
 * 出站裁剪（§6.4/§9.8）拦不住它，UI 上也看不出来 —— 只有断言「送给 DouZero 的 hand」
 * 才抓得到。旧实现下地主会拿到 20 + 3 = **23** 张。
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { GameState, createSession, dealCards, type GameSession } from '@fight-the-landlord/shared';
import { BotPlayer } from '../src/robot/bot.player';
import type { DouZeroClient } from '../src/robot/douzero.client';

/** 用真实的手牌形状构造会话：地主 20 张（含底牌），农民各 17 张。 */
function makePlayingSession(landlordSeat: number): GameSession {
  const dealt = dealCards(createSession('ROOM-BOT', ['p0', 'p1', 'p2']));
  const bottom = dealt.bottomCards;
  return {
    ...dealt,
    state: GameState.Playing,
    bottomCards: bottom,
    players: dealt.players.map((p) =>
      p.seat === landlordSeat
        ? { ...p, isLandlord: true, hand: [...p.hand, ...bottom].sort((a, b) => a - b) }
        : p,
    ),
  };
}

function makePlayer(session: GameSession) {
  const captured: Array<{ position: string; hand: number[]; bottomCards: number[] }> = [];
  const client = {
    getMove: vi.fn(async (ctx: { position: string; hand: number[]; bottomCards: number[] }) => {
      captured.push({ position: ctx.position, hand: [...ctx.hand], bottomCards: [...ctx.bottomCards] });
      return []; // 空数组 = pass，避免触发真实策略
    }),
  } as unknown as DouZeroClient;
  return { bot: new BotPlayer(client), captured };
}

describe('BotPlayer.decideMove —— 地主不再补底牌（C15/R101）', () => {
  it('地主的手牌原样送给 DouZero：20 张，不是 23 张', async () => {
    const session = makePlayingSession(0);
    const { bot, captured } = makePlayer(session);

    await bot.decideMove(session, 'p0');

    expect(captured).toHaveLength(1);
    expect(captured[0]!.position).toBe('landlord');
    expect(captured[0]!.hand).toHaveLength(20);
    expect(captured[0]!.hand).toEqual([...session.players[0]!.hand].sort((a, b) => a - b));
    // bottomCards 仍要照传（DouZero 的特征里有它），但它不得再混进 hand
    expect(captured[0]!.bottomCards).toHaveLength(3);
  });

  it('农民的手牌不受影响（17 张，且不含底牌）', async () => {
    const session = makePlayingSession(0);
    const { bot, captured } = makePlayer(session);

    await bot.decideMove(session, 'p1');

    expect(captured[0]!.hand).toHaveLength(17);
    for (const c of session.bottomCards) {
      // 农民手牌里可能出现与底牌同值的牌，因此只断言「不是把底牌整组塞进来」
      expect(captured[0]!.hand.length).toBe(17);
    }
  });

  it('地主在座位 1 时同样不补（按 seat 而非座位 0 硬编码）', async () => {
    const session = makePlayingSession(1);
    const { bot, captured } = makePlayer(session);

    await bot.decideMove(session, 'p1');

    expect(captured[0]!.position).toBe('landlord');
    expect(captured[0]!.hand).toHaveLength(20);
  });
});
```

> ⚠️ 若 `packages/robot-service/test/` 下已有 vitest 配置或共享 setup（例如 `internal-token.test.ts` 的模式），
> **照它的写法来**（不要新建第二套 setup）。`robot-service` 的 `test` 脚本已存在，直接跑即可。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/robot-service test -- bot.player`
Expected: FAIL —— 地主 `hand` 长度 **23**（20 + 3）。

- [ ] **Step 3: 删掉补偿一**

`packages/robot-service/src/robot/bot.player.ts` 的 24-31 行改为：

```ts
    // 确定机器人位置（landlord/landlord_down/landlord_up）
    const position = this.getPosition(player.seat, session);

    // ⚠️ **不得**再给地主补底牌（C15/R101）：底牌已由 `shared/ddz/bid.ts` 的
    // `finalizeBidding()` 并入 `player.hand`（地主 20 张）。旧实现在这里
    // `concat(session.bottomCards)` ⇒ DouZero 看到 23 张，特征全错。
    // `context.bottomCards` 仍然照传（DouZero 协议要求），但它只是**展示/特征**副本。
    const handForDouZero = [...player.hand].sort((a, b) => a - b);
```

（`let` → `const`；`position` 仍在下面被用于 `DouZeroContext.position`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/robot-service test`
Expected: PASS

- [ ] **Step 5: 全量验证并提交**

```bash
pnpm --filter @fight-the-landlord/robot-service test && pnpm test && pnpm lint
git add packages/robot-service/src/robot/bot.player.ts packages/robot-service/test/bot.player.test.ts
git commit -m "fix(robot-service): 删除地主手牌的 +3 底牌补偿（C15/R101 三处同改之三）"
```

---

## Task 4: `game-service/game.service.ts` —— 超时抛错后重挂计时器且不吞错（C22① / R106）

**背景（读之前先看这段，否则会把它当成小修）**：旧实现对超时动作的错误有两副面孔：

```ts
// 旧实现（packages/game-service/src/game/game.service.ts:360-369）
try {
  const updated = session.state === GameState.Bidding
    ? handleBid(session, playerId, false)
    : handlePass(session, playerId);
  updated.turnDeadlineAt = Date.now() + TURN_TIMEOUT_MS;
  await this.finishTransition(roomCode, updated);
} catch (err) {
  this.logger.error(`Timeout action failed for room ${roomCode}: ${String(err)}`);  // ← 只记一行
  // ← 既不重挂计时器，也不推进任何计数
}
```

`applyAction` 一开头就 `this.clearTimer(roomCode)`，而 `finishTransition` 只在**成功**时重挂。
因此**一旦超时动作抛错，这个房间从此再也没有活动计时器**：之后所有玩家的回合都不会超时、
对局永久停摆（这正是玩法 §11 对 C28 的描述：「不是超时行为不对，是这一局再也走不动」）。

**Files:**
- Modify: `packages/game-service/src/game/game.service.ts`（`onTurnTimeout`，约 341-370 行）
- Test: `packages/game-service/test/game.timer.test.ts`
- Test: `packages/game-service/test/full-game.test.ts`（叫抢收口的整局断言，Step 1 一并补）

**Interfaces:**
- Consumes: `startTurnTimer(roomCode, session)`（本文件私有，已有）、`TURN_TIMEOUT_MS`、`GameState`
- Produces: `onTurnTimeout(roomCode)` 的三条可观测行为：
  1. 成功路径：与现状一致（推进会话 → `finishTransition` → 重挂）；
  2. **失败路径**：`logger.error` 记录（可 spy）+ **重挂计时器**（`timers.has(roomCode) === true`）
     + **不修改会话**（`version` 不变、Redis 里没有新写入）；
  3. 房间已消失（`session === null`）：直接返回，不重挂（没有可挂的回合）。

- [ ] **Step 1: 写失败测试**

在 `packages/game-service/test/game.timer.test.ts` 末尾**新增**：

```ts
  // ── C22① / R106：超时动作抛错后必须重挂计时器，且不得静默吞错 ──────────
  it('超时动作抛错后仍重挂计时器（否则该房间永久停摆，C22）', async () => {
    await service.startGame(startDto('ROOM-T1'));
    expect(service['timers'].has('ROOM-T1')).toBe(true);

    // 把当前行动者推进到座位 1，再让「座位 1 的超时动作」必定抛错：
    // bidding 状态下 handleBid 只在 `playerIdx !== currentBidder` 时抛
    // —— 我们直接把 currentBidder 改成一个不存在的座位，制造同样类型的异常。
    await service.bid('ROOM-T1', 'user-1', false); // currentBidder → 1
    const session = await service.getSession('ROOM-T1');
    session!.bidPhase.currentBidder = 7; // 座位 7 不存在 ⇒ players[7] 为 undefined
    await service.saveSessionForTest('ROOM-T1', session!);

    const errorSpy = vi.spyOn(service['logger'], 'error');
    await vi.advanceTimersByTimeAsync(30_000);

    // ① 不静默吞错：日志里有这条
    expect(errorSpy).toHaveBeenCalled();
    // ② 必须重挂：房间仍有活动计时器（旧实现这里是 false ⇒ 永久停摆）
    expect(service['timers'].has('ROOM-T1')).toBe(true);
    // ③ 不替服务端编造状态转移：version 未被改动
    const after = await service.getSession('ROOM-T1');
    expect(after!.version).toBe(session!.version);
    errorSpy.mockRestore();
  });

  it('任一时刻至多一个活动计时器（玩法 §9.2 第 3 条）', async () => {
    await service.startGame(startDto('ROOM-T2'));
    const first = service['timers'].get('ROOM-T2');
    await service.bid('ROOM-T2', 'user-1', false);
    const second = service['timers'].get('ROOM-T2');
    expect(service['timers'].size).toBe(1);
    expect(second).not.toBe(first); // 旧句柄被清掉、换成了新的
  });

  it('房间已消失时不重挂（没有可挂的回合）', async () => {
    await service.startGame(startDto('ROOM-T3'));
    service['cache'].delete('ROOM-T3');
    redis._store.delete('game:session:ROOM-T3');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service['timers'].has('ROOM-T3')).toBe(false);
  });
```

> ⚠️ **需要给 `GameService` 加一个测试用出口**：上面第一条用例要在「动过内存里的会话对象」
> 之后把它写回缓存/Redis。二选一：
> ① 在 `game.service.ts` 里加一个**仅供测试**的 `async saveSessionForTest(roomCode, session)`
>    （内部直接 `return this.saveSession(roomCode, session)`），并在注释里写明「仅供测试，生产路径不调用」；
> ② 若你发现**不必**动会话就能构造出抛错场景（例如注入一个会抛的 action），**优先用 ②**，
>    不要为了用例往生产类上加方法。
> **本步骤禁止**为了让用例通过而把 `onTurnTimeout` 的 `catch` 改成 `throw` —— 超时**不能**
> 变成未捕获的 rejection（那会让 Node 进程留下未处理错误）。

**同一文件里再补一条**：既有用例 `'does not throw when the timer fires but the game is gone'`
已经覆盖了「房间消失」这一支，上面第三条是它的**加强版**（额外断言不重挂）。两条并存，不要删旧的。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/game-service test -- game.timer`
Expected: FAIL ——
- 第一条：`service['timers'].has('ROOM-T1')` 为 **false**（旧实现 catch 里不重挂）；
- 第二条：**可能已经绿**（`startTurnTimer` 里已有 `clearTimer`）—— 它只作**防回归**，
  汇报里如实标注「无 RED 证据」；
- 第三条：**可能已经绿**（房间不存在时旧实现也不重挂）—— 同样如实标注。

- [ ] **Step 3: 改 `onTurnTimeout`**

```ts
  /**
   * 回合超时 = 服务端**内部自动行为**，不向客户端返回错误码（§11.2 的 `13007` 保留不用）。
   *
   * 叫抢阶段的行动者是 `bidPhase.currentBidder`，**不是** `currentPlayer`
   * （玩法 §9.1 / 偏差 C28）—— 叫抢期 `currentPlayer` 恒为 0，用它会替错人决策。
   *
   * C22① / R106：超时动作**抛错**时（例如当前行动者的座位在会话里已不存在）
   * 必须「**不静默吞错 + 重挂计时器**」：
   *  ① 记 `logger.error`（带房间、座位、原始错误）；
   *  ② 用**当前会话**重挂 30s 计时器 —— 否则这个房间从此再也没有活动计时器，
   *     之后所有回合都不再超时，对局**永久停摆**（`applyAction` 一开头就 clearTimer，
   *     而 `finishTransition` 只在成功路径重挂）；
   *  ③ **不修改会话、不落盘、不推送** —— 抛错意味着这次自动动作没有发生，
   *     替服务端编造一次状态转移会让 `version` 与客户端观测错位。
   *
   * ⚠️ 本任务**不做** §9.1 的「出牌超时打最小单张」（C5，归切片 9）。
   */
  private async onTurnTimeout(roomCode: string): Promise<void> {
    const session = await this.getSession(roomCode);
    if (!session) return;

    const actorSeat =
      session.state === GameState.Bidding ? session.bidPhase.currentBidder : session.currentPlayer;
    const playerId = session.players[actorSeat]?.id;
    this.logger.log(`Turn timeout for room ${roomCode}: seat ${actorSeat} (${playerId ?? 'unknown'})`);
    if (!playerId) {
      // 座位不存在（会话被外部改坏 / 人数不足）：不会自愈，但**必须**重挂，
      // 否则这一局静默停摆且没有任何后续信号。
      this.logger.error(
        `Timeout action impossible for room ${roomCode}: seat ${actorSeat} has no player`,
      );
      this.startTurnTimer(roomCode, session);
      return;
    }

    try {
      const updated =
        session.state === GameState.Bidding
          ? handleBid(session, playerId, false)
          : handlePass(session, playerId);
      updated.turnDeadlineAt = Date.now() + TURN_TIMEOUT_MS;
      await this.finishTransition(roomCode, updated);
    } catch (err) {
      this.logger.error(
        `Timeout action failed for room ${roomCode} (seat ${actorSeat}, ${playerId}): ${String(err)}`,
      );
      // R106③：不落盘、不改 version；R106②：重挂，使下一次超时仍会发生。
      this.startTurnTimer(roomCode, session);
    }
  }
```

> ⚠️ `startTurnTimer(roomCode, session)` 内部第一件事就是 `clearTimer(roomCode)`，
> 因此重挂不会泄漏旧句柄（§9.2 第 3 条）。
> ⚠️ `state === Ended` 时 `startTurnTimer` 会直接 return（不挂），这是对的（§9.2 第 4 条）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/game-service test`
Expected: PASS

- [ ] **Step 5: 补整局断言并提交**

在 `packages/game-service/test/full-game.test.ts` 的 `'handles the bid flow'` 里**追加**（不要删旧断言）：

```ts
    // C15/R101：地主拿到 20 张，且底牌确实在其手牌里
    expect(bid3.players[2]!.hand).toHaveLength(20);
    expect(bid3.bottomCards).toHaveLength(3);
    for (const c of bid3.bottomCards) expect(bid3.players[2]!.hand).toContain(c);
    // 农民仍是 17
    expect(bid3.players[0]!.hand).toHaveLength(17);
    expect(bid3.players[1]!.hand).toHaveLength(17);
    // §3.4-3：landlordCandidate 是「谁是地主」的唯一来源
    expect(bid3.bidPhase.landlordCandidate).toBe(2);
```

```bash
pnpm --filter @fight-the-landlord/game-service test && pnpm test && pnpm lint
git add packages/game-service/src/game/game.service.ts packages/game-service/test/game.timer.test.ts packages/game-service/test/full-game.test.ts
git commit -m "fix(game-service): 超时动作抛错后重挂计时器且不静默吞错（C22①/R106）"
```

---

## Task 5: 前端 —— 叫抢 UI 的接线与阶段互斥（R107 / §12 F01-F02 / 切片表第 8 行）（前端 agent）

**Files:**
- Modify: `apps/client/src/pages/table.vue`（给四个动作按钮加稳定 class；注释写明禁用依据）
- Create: `apps/client/test/table-bid-ui.test.ts`
- Modify: `apps/client/test/source-boundary.test.ts`（**仅当**它的静态扫描会因为新 class 而失败时；多数情况下不用改）

**Interfaces:**
- Consumes: `useGameStore` 的 `isBidding` / `isPlaying` / `actorSeat` / `isMyTurn` / `landlordSeat` / `bottomCards` /
  `hand` / `cardCounts`；`getGameSession().client.send('game.bid', { grab })`
- Produces: 四个稳定选择器（**R107 要求，测试要与它对齐**）：
  `.table__bid-grab`（抢）、`.table__bid-pass`（不抢）、`.table__play`（出牌）、`.table__pass`（过牌）；
  外加既有 `.table__actions` 容器不变。

- [ ] **Step 1: 写失败测试**

> ⚠️ **先读 `apps/client/test/helpers/fake-socket.ts`**：`playerViewFixture(over)` 用 `{...默认, ...over}`
> 覆盖顶层字段，因此 **`bidPhase` / `cardCounts` 都要写全**（`bidPhase` 不合并、只替换；
> `cardCounts` 由 fixture 在最后按 `hand.length` 重算，传 `cardCounts` 只影响别的座位）。
> 下面每条用例里都已经写全，**不要**简写成 `{ currentBidder: 0 }` ——
> 那会得到一个残缺对象，而 `PlayerView` 的字段契约是 `protocol` 拥有的（本片不得改契约）。

Create `apps/client/test/table-bid-ui.test.ts`：

```ts
/**
 * 切片 8：叫抢 UI 的**接线**（§12 F01/F09/F10 + R107）。
 *
 * 判别力说明：这里**不**断言任何规则（倍数、谁能抢、几张牌），那些是服务端的；
 * 只断言三件事：
 *  ① 行动者取自服务端的 `bidPhase.currentBidder`（不是 `currentPlayer`）；
 *  ② 点击发 `game.bid` 且 `payload.grab` 正确；
 *  ③ 阶段互斥：叫抢阶段没有出牌/过牌按钮，出牌阶段没有抢/不抢按钮。
 * 第 ③ 条是真实缺陷面：旧模板两处都用 `.btn--primary` 裸选择器，
 * 任何样式/结构调整都会让「UI 走查」静默失配。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table.vue';
import { FakeSocket, serverMessage, playerViewFixture } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  stopGameSession();
});

function mountTable(opts: { mySeat: number }) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', opts.mySeat);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  return { wrapper, socket, store };
}

describe('table.vue 的叫抢 UI（§9.1 / R107）', () => {
  it('轮到别人叫抢时两个按钮都禁用（行动者读 bidPhase.currentBidder）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 1 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat: 1,
          // ⚠️ `playerViewFixture` **不合并** `bidPhase`：它整体替换（`...over` 在默认字段之后，
          //    而 `bidPhase` 是顶层字段）。所以这里必须给出**完整**的 bidPhase，
          //    只写 `{ currentBidder: 0 }` 会得到一个残缺对象（旧夹具没有 `bidder` 这个键）。
          bidPhase: {
            currentBidder: 0,
            bidMultiplier: 1,
            landlordCandidate: -1,
            grabActions: 0,
            redealCount: 0,
          },
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(store.actorSeat).toBe(0); // 服务端说行动者是座位 0
    expect(wrapper.find('.table__bid-grab').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.table__bid-pass').attributes('disabled')).toBeDefined();
  });

  it('轮到我叫抢时按钮可点，点击发 game.bid 且 grab 正确', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 1 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat: 1,
          bidPhase: {
            currentBidder: 1,
            bidMultiplier: 1,
            landlordCandidate: -1,
            grabActions: 0,
            redealCount: 0,
          },
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(store.isMyTurn).toBe(true);

    await wrapper.find('.table__bid-grab').trigger('click');
    expect(socket.emittedOf('game.bid')).toHaveLength(1);
    expect(socket.emittedOf('game.bid')[0]!.env.payload).toEqual({ grab: true });

    socket.emittedOf('game.bid')[0]!.ack(null, { code: 0 });
    await wrapper.vm.$nextTick();

    await wrapper.find('.table__bid-pass').trigger('click');
    expect(socket.emittedOf('game.bid')).toHaveLength(2);
    expect(socket.emittedOf('game.bid')[1]!.env.payload).toEqual({ grab: false });
  });

  it('叫抢阶段不得出现出牌/过牌按钮，出牌阶段不得出现抢/不抢按钮（阶段互斥）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });

    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          bidPhase: {
            currentBidder: 0,
            bidMultiplier: 1,
            landlordCandidate: -1,
            grabActions: 0,
            redealCount: 0,
          },
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__bid-grab').exists()).toBe(true);
    expect(wrapper.find('.table__play').exists()).toBe(false);
    expect(wrapper.find('.table__pass').exists()).toBe(false);

    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({ state: 'playing', seat: 0, version: 2, landlordSeat: 0 }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__bid-grab').exists()).toBe(false);
    expect(wrapper.find('.table__play').exists()).toBe(true);
    expect(wrapper.find('.table__pass').exists()).toBe(true);
  });

  it('模板里没有任何本地倍数/底分计算（§12 F02/F10）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 2,
          landlordSeat: 0,
          cardCounts: [20, 17, 17],
          hand: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 17, 20, 20, 30, 30],
          bidPhase: {
            currentBidder: 0,
            bidMultiplier: 2,
            landlordCandidate: 0,
            grabActions: 3,
            redealCount: 0,
          },
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    const text = wrapper.text();
    // 倍数只显示服务端字段（若模板要显示，必须直接绑 store.view.bidPhase.bidMultiplier）；
    // 这里只做**反向**断言：不得出现「×2 / x2 / 底分 / baseScore」这类本地推导痕迹。
    expect(text).not.toMatch(/×\s*\d/);
    expect(text).not.toContain('底分');
  });
});
```

> ⚠️ **`playerViewFixture` 的现有签名**：先读 `apps/client/test/helpers/fake-socket.ts`，
> 按它**真实的**参数形状写（可能需要 `bidder` / `bidMultiplier` / `landlordSeat` 之类的可选项）。
> 若缺字段，**改 helper 的 fixture**（它是测试夹具，属于前端 agent 的写区），
> **不要**在用例里手搓一个 `PlayerView`（那会绕过 `PlayerView` 的字段契约）。
> 这是上一片 F1「夹具名写错、照抄写不出可编译的用例」的同类陷阱。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/client && pnpm test -- table-bid-ui`
Expected: FAIL —— `wrapper.find('.table__bid-grab')` 找不到元素（模板还没有这些 class）。

- [ ] **Step 3: 改 `apps/client/src/pages/table.vue`**

`<script setup>` 顶部注释块里补一条（说明禁用依据，防止后人改成 `currentPlayer`）：

```ts
 *  - 叫抢阶段的行动者：`bidPhase.currentBidder`，**不是** `currentPlayer`（玩法 §9.1）
 *  - 叫抢按钮的禁用依据是 `store.isMyTurn`（= `actorSeat === mySeat`，而 `actorSeat`
 *    在 bidding 期取 `bidPhase.currentBidder`）——**不得**另起一套本地判断（R107）
```

模板的动作区（原 152-173 行）改为（**只加 class 与注释，不改行为**）：

```vue
      <div class="table__actions">
        <template v-if="store.isBidding">
          <!-- 叫抢：行动者由服务端的 bidPhase.currentBidder 决定（store.actorSeat），前端不做规则判断 -->
          <button
            type="button"
            class="btn btn--primary table__bid-grab"
            :disabled="busy || !store.isMyTurn"
            @click="bid(true)"
          >
            抢
          </button>
          <button type="button" class="btn table__bid-pass" :disabled="busy || !store.isMyTurn" @click="bid(false)">
            不抢
          </button>
        </template>
        <template v-else-if="store.isPlaying">
          <button
            type="button"
            class="btn btn--primary table__play"
            :disabled="busy || !store.isMyTurn || selected.length === 0"
            @click="play"
          >
            出牌（{{ selected.length }}）
          </button>
          <button type="button" class="btn table__pass" :disabled="busy || !store.isMyTurn" @click="pass">过牌</button>
        </template>
        <span v-else-if="!store.isMyTurn" class="table__muted">等待其他玩家…</span>
      </div>
```

`bid()` 保持不变（**它已经是对的**，不要再包一层本地状态）：

```ts
function bid(grab: boolean) {
  void send('game.bid', { grab });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/client && pnpm test && pnpm lint && pnpm build`
Expected: 全绿（`vue-tsc` 干净、build OK）

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/pages/table.vue apps/client/test/table-bid-ui.test.ts apps/client/test/helpers/fake-socket.ts
git commit -m "feat(client): 叫抢 UI 接线与阶段互斥（稳定选择器，R107）"
```

---

## Task 6: conformance —— 切片 8 用例「1 抢 + 2 不抢」（协调者）

**Files:**
- Create: `tools/conformance/src/slices/slice-08-bidding.ts`
- Modify: `tools/conformance/src/run.ts`
- Modify: `tools/conformance/package.json`

**Interfaces:**
- Consumes: `HarnessClient`（`lib/client.ts`，切片 5 已有）、`registerUser`（`lib/http.ts`）、
  `Checks` / `step` / `info` / `assertNoLeak`（`lib/assert.ts`）、`ErrCode`、真实后端 3000–3003 + Redis + MySQL
- Produces: `runSlice08(): Promise<Checks>`

> ⚠️ **陷阱一**：`assertNoLeak()` 的黑名单含 `players`，而 `room.join` 的 ack **合法地**带
> `data.players: RoomPlayer[]`（§6.3）⇒ **不得**对它调用 `assertNoLeak()`（与切片 7 同一条陷阱）。
> `game.deal` / `game.state_update` 的 payload 是 `PlayerView`，**可以**用。
>
> ⚠️ **陷阱二**：推送的线格式是 `{ version, payload }`（§6.2 信封），
> 所以叫抢状态要从 `message.payload.state` / `message.payload.bidPhase.currentBidder` 读，
> **不是** `message.state`。

- [ ] **Step 1: 写用例**

Create `tools/conformance/src/slices/slice-08-bidding.ts`（**整文件**：头注释 + 类型 + 辅助原语 + `runSlice08`）：

```ts
/**
 * 切片 8 conformance：叫抢地主（玩法 §2/§3/§9 + 主规格 §6.4）。
 *
 * 主线是「**1 抢 + 2 不抢**」这一条真实链路，判别力来自四组断言：
 *  1. **`grabActions` 按「决策次数」计**（玩法 §3.1 的 ⚠️）：若误读为「抢的次数」，
 *     这条链路会永不结束（grabActions=1 < 3 且 bidPasses=2 < 3）⇒ 用例超时；
 *  2. **底牌并入地主手牌**（C15/R101）：地主 `hand.length === 20`、两农民 17、
 *     且 `bottomCards ⊆ 地主 hand`；同时三家 `hand.length === cardCounts[seat]`
 *     （协议不变式，三个改动哪一个漏了都会在这里红）；
 *  3. **倍数**：1 次「抢」⇒ `bidMultiplier === 2`（上限 8 的边界另有单测，见 shared/bid.test.ts）；
 *  4. **叫抢结束的收口**：`state === 'playing'`、`landlordSeat` = 抢者的座位、
 *     `bidPhase.landlordCandidate` 同一值、`currentPlayer` = 地主。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, info, sleep, step } from '../lib/assert';
import { registerUser } from '../lib/http';
import { HarnessClient } from '../lib/client';

/** 出站线格式的 `PlayerView`（§6.4）。只声明本用例真正读的字段。 */
interface PlayerViewWire {
  roomCode: string;
  version: number;
  state: 'init' | 'bidding' | 'playing' | 'ended';
  seat: number;
  hand: number[];
  cardCounts: [number, number, number];
  bottomCards: number[] | null;
  landlordSeat: number | null;
  currentPlayer: number;
  bidPhase: {
    currentBidder: number;
    bidMultiplier: number;
    landlordCandidate: number;
    grabActions: number;
    redealCount: number;
  };
}

const STEP_TIMEOUT_MS = 8000;
const MATCH_TIMEOUT_MS = 25_000;

/** 「取一局」的返回：主流程与反例流程共用同一套形状（DRY，见下方 Step 1 的 ③/⑤）。 */
interface FreshRoom {
  roomCode: string;
  clients: HarnessClient[];
  /** seat → client，用于「轮到谁就叫谁说话」。 */
  bySeat: Map<number, HarnessClient>;
  /** client → seat，用于反例里选一个「不是当前叫抢者」的客户端。 */
  seatOf: Map<HarnessClient, number>;
  /** 发牌后的裁剪视图（叫抢起点）。 */
  view: PlayerViewWire;
}

/**
 * 起一局真实的三人对局：入队 → `room.matched` → `room.join` → 等 `game.deal`。
 *
 * ⚠️ 每次调用都必须用**新的三个账号**：同账号再次 `room.match` 会撞 `12009`，
 * 再次 `room.join` 同一房间会撞 `12004`（切片 7 的 R63/12009 语义）。
 */
async function startFreshRoom(labelPrefix: string): Promise<FreshRoom> {
  const clients: HarnessClient[] = [];
  for (let i = 0; i < 3; i += 1) {
    const user = await registerUser(i);
    clients.push(await HarnessClient.connect(`${labelPrefix}${i}`, user));
  }
  for (const client of clients) {
    const ack = await client.send('room.match', { mode: 'random' });
    if (ack.code !== ErrCode.OK) throw new Error(`${client.label} room.match code=${ack.code}`);
  }
  const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', MATCH_TIMEOUT_MS)));
  const roomCode = matched[0]!.payload.roomCode as string;

  const bySeat = new Map<number, HarnessClient>();
  const seatOf = new Map<HarnessClient, number>();
  for (const [i, client] of clients.entries()) {
    const seat = matched[i]!.payload.seat as number;
    bySeat.set(seat, client);
    seatOf.set(client, seat);
    const ack = await client.send('room.join', { roomCode });
    if (ack.code !== ErrCode.OK) throw new Error(`${client.label} room.join code=${ack.code}`);
  }

  const deals = await Promise.all(clients.map((c) => c.waitFor('game.deal', MATCH_TIMEOUT_MS)));
  return { roomCode, clients, bySeat, seatOf, view: deals[0]!.payload as PlayerViewWire };
}

/**
 * 取该客户端**最近一次**收到的裁剪视图（同步，不等待）。
 *
 * 叫抢阶段三家的 `state_update` 版本是同步推进的，因此用任一方的最新视图取
 * `bidPhase.currentBidder` 与 `version` 都成立（§6.2：一次转移的所有消息共享同一 version）。
 * ⚠️ 不要用 `game.deal` 里那次快照去算后续动作的 `baseVersion` —— 版本已经往前走了，会拿到 `13004`。
 */
function currentView(client: HarnessClient): PlayerViewWire {
  const latest = client.last('game.state_update') ?? client.last('game.deal');
  if (!latest) throw new Error(`尚未收到任何 game.* 推送（room=${roomCode}）`);
  return latest.payload as PlayerViewWire;
}

/** 等一条 version **严格大于**给定值的裁剪视图。 */
async function waitForNewerVersion(client: HarnessClient, version: number): Promise<PlayerViewWire> {
  const msg = await client.waitFor(
    'game.state_update',
    STEP_TIMEOUT_MS,
    (m: any) => (m.payload as PlayerViewWire).version > version,
  );
  return msg.payload as PlayerViewWire;
}

/**
 * 等该客户端拿到**恰好** `version` 那一版裁剪视图（可能已经在 `received` 里）。
 *
 * 与 `waitForNewerVersion` 的区别是「等哪一版」：叫抢收口时三家都必须拿到
 * **同一个 version** 的快照才能比 `cardCounts`；用「更新即可」会三家比到不同版本。
 */
async function waitForVersion(client: HarnessClient, version: number): Promise<PlayerViewWire> {
  const existing = [...client.received]
    .reverse()
    .find((r) => (r.message?.payload as PlayerViewWire | undefined)?.version === version);
  if (existing) return existing.message.payload as PlayerViewWire;
  const msg = await client.waitFor(
    'game.state_update',
    STEP_TIMEOUT_MS,
    (m: any) => (m.payload as PlayerViewWire).version === version,
  );
  return msg.payload as PlayerViewWire;
}
export async function runSlice08(): Promise<Checks> {
  const checks = new Checks();
  const rooms: FreshRoom[] = [];

  try {
    step('起第 1 局（3 个新账号 → 匹配 → join → game.deal）');
    const room = await startFreshRoom('P');
    rooms.push(room);
    const { clients, bySeat, roomCode } = room;
    checks.that(bySeat.size === 3, `三人成局，roomCode = ${roomCode}`);

    step('叫抢阶段：底牌恒 null、每家 17 张、无地主（§6.4 / 玩法 §2）');
    // `startFreshRoom()` 已经等到三家各自的 `game.deal`；这里只做断言，不再重复等待。
    const deals = clients.map((c) => {
      const msg = c.last('game.deal');
      if (!msg) throw new Error(`${c.label} 没有 game.deal`);
      return msg;
    });
    for (const [i, deal] of deals.entries()) {
      const view = deal.payload as PlayerViewWire;
      assertNoLeak(view, `game.deal(P${i})`);
      checks.eq(view.state, 'bidding', `P${i} 发牌后状态`);
      checks.eq(view.bottomCards, null, `P${i} 叫抢阶段底牌不可见（§6.4）`);
      checks.eq(view.hand.length, 17, `P${i} 发牌手牌张数`);
      checks.eq(view.hand.length, view.cardCounts[view.seat], `P${i} hand.length === cardCounts[seat]`);
      checks.eq(view.landlordSeat, null, `P${i} 叫抢阶段无地主`);
    }

    step('按**服务端给的顺序**叫抢：1 抢 + 2 不抢（grabActions 按决策次数计，玩法 §3.1）');
    let version = currentView(clients[0]!).version;
    const grabs = [true, false, false];
    let grabSeat = -1;

    for (let round = 0; round < 3; round += 1) {
      const bidder = currentView(clients[0]!).bidPhase.currentBidder;
      const actor = bySeat.get(bidder);
      if (!actor) throw new Error(`currentBidder=${bidder} 没有对应客户端（座位集合 ${[...bySeat.keys()].join(',')}）`);

      const grab = grabs[round]!;
      if (grab) grabSeat = bidder;

      const ack = await actor.send('game.bid', { grab }, version);
      checks.eq(ack.code, ErrCode.OK, `座位 ${bidder} game.bid(grab=${grab}) code`);

      const next = await waitForNewerVersion(actor, version);
      assertNoLeak(next, `game.state_update(round ${round})`);
      version = next.version;

      if (round < 2) {
        checks.eq(next.state, 'bidding', `第 ${round + 1} 次决策后仍在叫抢`);
        checks.eq(next.bidPhase.grabActions, round + 1, `grabActions = 已完成决策次数（第 ${round + 1} 次）`);
        checks.eq(next.bidPhase.bidMultiplier, round === 0 ? 2 : 2, '1 次「抢」⇒ 倍数 2（不抢不再翻倍）');
      } else {
        checks.eq(next.state, 'playing', '第 3 次决策后进入出牌阶段');
        checks.eq(next.bidPhase.grabActions, 3, 'grabActions = 3（一轮走满）');
        checks.eq(next.bidPhase.landlordCandidate, grabSeat, 'landlordCandidate = 抢者座位（§3.4-3）');
        checks.eq(next.landlordSeat, grabSeat, 'landlordSeat = 抢者座位');
        checks.eq(next.currentPlayer, grabSeat, 'currentPlayer = 地主（§3.4-6）');
        checks.eq(next.bidPhase.bidMultiplier, 2, '倍数 = 2（上限 8 的边界由 shared 单测覆盖）');
        checks.that(
          Array.isArray(next.bottomCards) && next.bottomCards.length === 3,
          `playing 后 bottomCards 可见且为 3 张：${JSON.stringify(next.bottomCards)}`,
        );
        const bottom = [...(next.bottomCards as number[])].sort((a, b) => a - b);

        // 每家都拿同一套真相：地主 20 / 农民 17，且地主 hand 真的含底牌（C15/R101 核心判据）
        for (const client of clients) {
          const latest = await waitForVersion(client, version);
          assertNoLeak(latest, `playing 视图(${client.label})`);
          const seat = latest.seat;
          const isLandlord = seat === grabSeat;
          checks.eq(latest.hand.length, isLandlord ? 20 : 17, `${client.label}(seat ${seat}) 手牌张数`);
          checks.eq(latest.hand.length, latest.cardCounts[seat], `${client.label} hand.length === cardCounts[seat]`);
          checks.eq(latest.cardCounts[grabSeat], 20, `${client.label} 看到的地主张数 = 20`);
          for (const s of [0, 1, 2]) {
            if (s === grabSeat) continue;
            checks.eq(latest.cardCounts[s], 17, `${client.label} 看到的农民(seat ${s})张数 = 17`);
          }
          if (isLandlord) {
            for (const c of bottom) {
              if (!latest.hand.includes(c)) {
                throw new Error(`${client.label} 地主手牌缺少底牌 ${c}：hand=${JSON.stringify(latest.hand)}（C15 未并入）`);
              }
            }
            checks.ok(`${client.label} 是地主：20 张，且底牌 ${bottom.join(',')} 全部在 hand 内（C15/R101）`);
          }
        }

        // 反例 A：叫抢已结束，再发 game.bid ⇒ 13001（且不推进任何状态）
        const late = await actor.send('game.bid', { grab: true }, version);
        checks.eq(late.code, ErrCode.ILLEGAL_ACTION, 'playing 后再叫抢的 code（§11.1）');
        // 反例 B：**另一个座位**在 playing 阶段叫抢 —— 同样必须被拒（不能只测 actor 自己）
        const other = clients.find((c) => c !== actor)!;
        const otherAck = await other.send('game.bid', { grab: true }, version);
        checks.eq(otherAck.code, ErrCode.ILLEGAL_ACTION, 'playing 阶段另一座位再叫抢的 code');
      }
    }

    step('反例：非当前叫抢者抢 ⇒ 12003，且被拒的动作不推进 version / currentBidder');
    const room2 = await startFreshRoom('Q');
    rooms.push(room2);
    const bidder2 = currentView(room2.clients[0]!).bidPhase.currentBidder;
    const wrong = room2.clients.find((c) => c !== room2.bySeat.get(bidder2))!;
    info(`room2 当前叫抢者 = 座位 ${bidder2}，用座位 ${room2.seatOf.get(wrong)} 的客户端去抢`);
    const before = currentView(room2.clients[0]!);
    const badAck = await wrong.send('game.bid', { grab: true }, before.version);
    checks.eq(badAck.code, ErrCode.NOT_YOUR_TURN, '非当前叫抢者 game.bid 的 code');

    // 反向断言（R68：不能只用 waitFor 证明「没发生」）：
    // 正向等一小段静默窗，再断言版本与行动者都没变。
    await sleep(300);
    const after = currentView(room2.clients[0]!);
    checks.eq(after.version, before.version, '被拒的动作不推进 version');
    checks.eq(after.bidPhase.currentBidder, bidder2, '被拒的动作不推进 currentBidder');
    checks.eq(after.bidPhase.grabActions, before.bidPhase.grabActions, '被拒的动作不增加 grabActions');

    return checks;
  } finally {
    for (const room of rooms) {
      for (const client of room.clients) client.close();
    }
  }
}
```

> ⚠️ 执行者有**两件事**必须做（否则用例要么编译不过、要么是空测）：
> ① **先用真实接口核对一遍**：`HarnessClient.last()` / `waitFor()` / `received[]` 的
>    **返回形状**（`lib/client.ts` 里 `last()` 返回的是**消息**、`received[]` 的元素是
>    `{type, message, at}`）——本计划按这个形状写，若实现已变，**以实现为准**并在汇报里点名；
> ② **`registerUser(i)` 每次都必须是新账号**：`startFreshRoom()` 被调用两次，若两次传入同一批
>    index 而复用了手机号，第二次会撞 `11001`（注册）或 `12009`（排队）。
>    `registerUser` 内部已经用时间戳 + 随机数拼手机号，因此**复用同一个 index 是安全的**；
>    但若你改成「预注册账号再复用」，必须自己保证唯一性。
> **本步骤的验收标准不是「照抄能编译」，而是「三层断言真的在跑」**：
> 每组断言都必须打印（`checks.eq` / `checks.ok`），失败时能一眼看出是哪一层
> （发牌 / 叫抢推进 / 收口 20-17-2 / 反例 13001·12003）。

- [ ] **Step 2: 注册用例**

`tools/conformance/src/run.ts`：

```ts
import { runSlice08 } from './slices/slice-08-bidding';
```

```ts
  'slice-08': { title: '叫抢地主', run: runSlice08 },
```

`tools/conformance/package.json` 的 `scripts` 里加：

```json
    "conformance:slice-08": "node dist/run.js slice-08"
```

- [ ] **Step 3: 构建并跑（镜像必须是当前代码）**

```bash
# ① 工作区产物：docker-compose.yml:154 把宿主 packages/robot-service/dist bind-mount 进容器，
#    对 robot-service 重建镜像无效 ⇒ 必须先 build（agent-briefs.md 的已知环境事实）
pnpm exec turbo run build --force

# ② 镜像：机器上 daemon.json 的 registry-mirrors 全挂 ⇒ 必须用经典构建器
DOCKER_BUILDKIT=0 docker compose build
docker compose up -d

# ③ conformance
pnpm --filter @fight-the-landlord/conformance build
node tools/conformance/dist/run.js slice-08
```

Expected: `✅ slice-08 通过：N 项断言`（N 应 ≥ 25）

- [ ] **Step 4: 回归（切片 5/6/7 不得被打回）**

```bash
node tools/conformance/dist/run.js slice-07   # ✅ 39 项（本片动了 game.bid，必须回归）
node tools/conformance/dist/run.js slice-06   # ✅ 94+ 项
node tools/conformance/dist/run.js slice-05   # ✅ 29 项
```

⚠️ 若 `slice-05` 红在「叫抢」那一步，**先怀疑本片的 C15 改动**（它改了地主手牌与版本流转），
不要先怀疑环境。

- [ ] **Step 5: 提交**

```bash
git add tools/conformance
git commit -m "test(conformance): slice-08 叫抢地主（1 抢 2 不抢 → 地主 20 张、倍数 2、candidate 落地）"
```

---

## 门禁（协调者，合并后执行）

**三条环境事实必须先做，否则你测的是旧代码**（`agent-briefs.md`「已知环境事实」逐字）：

```bash
# ① bind-mount 陷阱：宿主 packages/robot-service/dist 被挂进容器 ⇒ 对 robot-service 重建镜像无效
pnpm exec turbo run build --force

# ② 镜像必须重建，且本机 registry-mirrors 全挂 ⇒ 必须用经典构建器
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d

# ③ 门禁必须 --force（Cached: N cached / FULL TURBO 是回放，不是真跑）
pnpm exec turbo run test lint --force      # 期望 29/29；基线见下方「基线」段
pnpm exec turbo run build --force          # 期望 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build

node tools/conformance/dist/run.js slice-08        # 本片用例
node tools/conformance/dist/run.js slice-07        # 回归（本片动了 game.bid）
node tools/conformance/dist/run.js slice-06        # 回归
node tools/conformance/dist/run.js slice-05        # 回归
node tools/conformance/dist/run.js slice-07.2-security   # 回归（安全片不得被打回）
node tools/conformance/dist/run.js slice-07.2-boundary   # 回归
```

**基线（切片 7.2-P0/P1 之后，master `3ff3101`，全部 `--force`、0 cached）**：
`protocol` 39 · `shared` 91 · `robot` 7 · `api-gateway` 81 · `game-service` 61 · `room-service` 134 ·
`user-service` 29 · `client` 137(+2 skipped)；`slice-07.2-boundary` 70 · `slice-07.2-security` 39 ·
`slice-07` 39 · `slice-06` 94 · `slice-05` 29。

> ⚠️ **停止应用容器会让 3000–3003 空出来但服务不可用**；`docker compose stop` 后务必
> `docker compose up -d` 恢复，否则 `room-service` 的 `match.service.test` 会假失败。

---

## Self-Review

**1. Spec coverage**（对照 `deviation-ledger.md` §2「切片 8」清单逐条）

| 清单项 | 落在哪个任务 | 判据 |
|---|---|---|
| C4 流局重新发牌 | Task 1 Step 3（`resetBidding` 调 `dealCards`） | `bid.test.ts`「手牌与底牌全部改变 + 54 张不重叠」 |
| **C15 底牌并入（三处同片同改）** | Task 1 Step 3（真源）+ Task 2（删补偿二）+ Task 3（删补偿一） | `bid.test.ts` 20 张 ∪ 关系 · `view.builder.test.ts` 「不再并入 / 不污染会话」· `bot.player.test.ts` 「20 而非 23」· conformance 地主 20 张且底牌在手 |
| C23 倍数上限 8 | Task 1 Step 3（`BID_MULTIPLIER_CAP`） | `bid.test.ts` 导出常量 + 「三抢恰好 8」+「不抢不变」 |
| C24 `currentBidder` 双重推进 | Task 1 Step 3（`resetBidding` 覆盖为 0） | `bid.test.ts`「流局回座位 0」+「连续两次流局」 |
| C22① 超时重挂 + 不吞错 | Task 4（`onTurnTimeout`） | `game.timer.test.ts`「抛错后 `timers.has` 为 true」「日志有 error」「version 不变」 |
| 前端叫抢 UI（读 `currentBidder`） | Task 5 | `table-bid-ui.test.ts` 四条（禁用/发送/阶段互斥/无本地计算） |
| conformance「1 抢 2 不抢」 | Task 6（`slice-08`） | `slice-08` 全绿 + 三处回归 slice-05/06/07 |
| （R105 附属项）随机地主写 `landlordCandidate` | Task 1（与 C15 同一代码块） | `bid.test.ts`「第 3 次流局随机指定」 |

**2. Placeholder scan**：本计划正文无 TBD/TODO；两处**显式标注**的「执行者按真实实现收敛」
（Task 4 Step 1 的测试出口二选一、Task 6 Step 1 的三点收敛）都给了**收敛判据**而不是「自己看着办」，
这是有意的：那些位置依赖执行时的真实夹具/路由形状，写死会制造「照抄写不出可编译用例」的计划缺陷
（切片 7 的 F1 就是这个）。

**3. Type consistency**：三处使用**同一批**字段名 —— `bidPhase.currentBidder` / `bidMultiplier` /
`landlordCandidate` / `grabActions` / `redealCount`（与 `protocol/src/views.ts:67-76` 逐字一致）；
新导出只有 `BID_MULTIPLIER_CAP`（`shared/ddz/bid.ts`）与四个 CSS class（`table__bid-grab` /
`table__bid-pass` / `table__play` / `table__pass`），两者在计划里都只定义一次、引用处逐字相同。
**不引入** `lastPlayedIdx`、`landlordSeats` 这类同义异名。

**4. 计划缺陷就地修正栏**（沿用切片 5/6/7 的做法：执行期发现的计划缺陷在此编号，由协调者落盘）

- **R111（预留编号）**：执行期若发现本计划某步不可执行（夹具名/行号/签名与真实代码不符），
  由执行者在汇报里给出「计划第几任务第几步 + 真实代码 + 建议改法」，协调者据此改本文件并顺延编号。
  **不要**默默绕开——绕开的结果是计划与代码分叉，下一片的人会照着错的计划走。

---

## 执行期裁决（后端 Task 1–4 已落地，2026-09-15）

- **R116 `computePlayedCards()` 的「再减一次底牌」是 C15 的第三处连带补偿，已并入本片。**
  后端执行期实测：`packages/robot-service/src/robot/bot.player.ts` 的 `computePlayedCards()`
  先用「总牌堆 − 各家手牌」算已出牌，**又单独减了一次 `session.bottomCards`**。
  C15 之前那次减法是**必要**的（底牌当时不在任何 `hand` 里）；C15 把底牌并入地主手牌之后，
  扣手牌**已经**把底牌算进去，于是它变成**双重扣减** ⇒ 与底牌同值的牌被提前判成「没出」。
  **裁决：并入本片**（而不是记进 C8/切片 11）。理由三条：
  ① 它与 R101 的两处补偿是**同一个根因**（C15 改了手牌口径，三处下游跟着口径变了），
     留一处必然在切片 11 被当成「C8 的启发式伪造」一起重写，届时没人知道这里曾经是**对的**；
  ② 修复是**删除**一行半（去掉局部变量与那段循环），零新增逻辑，回归面只有 robot-service；
  ③ 本片改动 `bot.player.ts` 已经在动这个文件，分两片改同一函数是额外风险。
  ⚠️ **C8 的归属不变**：该函数里「把已出牌按 `lastPlayerIdx` 逆序平摊给三家」的**分配**仍是
  伪造特征，仍归 C8 / 切片 11。本片只修**扣减口径**。
- **R117 R68② 的实战版：一个「显然成立」的断言可能是 no-op 变异（本片实测踩中两次）。**
  为 R116 写用例时，最先写出的两条（「刚发完牌 ⇒ `playedCards` 全空」、
  「一个农民出一张 ⇒ 恰好 1 张已出」）**对双重扣减没有区分力**，变异测试下**全绿**。
  实测原因：底牌并入地主手牌后，扣手牌时**已经**把那几张从计数扣到 0，
  再减一次命中 `if (cnt > 0)` 守卫 ⇒ **什么都不做**（对被测输入恒等）。
  真正有分歧的条件是：**某个底牌值在地主手牌里只剩「底牌自身」的份数**，
  第一次扣除在存量稀少的值上提前耗尽计数。据此构造的紧凑手牌夹具（地主手牌 15 张中
  只剩 `[20]`，把大王打出去）在变异下 `37 → 34`，**恰好少 3 张**（= 底牌数）。
  ⇒ 结论与 R68② 一致但更具体：**变异全绿时先怀疑变异是 no-op，不是用例不够；
  而要确认某个变异不是 no-op，必须构造出「第一次扣除会提前耗尽」的输入形状。**
- **R118 计划 Task 1 Step 5 的「预期中间态」是错的（后端实测）：做完 Task 1 后 game-service 反而全绿。**
  计划称「补偿二变成双重并入 ⇒ 23 张 ⇒ `validateOutbound` 当场抛错」。实测 **29/29 全绿**，
  原因是补偿在 `hand.push(...)` 之后又执行了 `cardCounts[seat] = hand.length`
  ⇒ `protocol/src/validate.ts:100` 的 `hand.length === cardCounts[seat]` 被**人为**满足（23 === 23），
  而协议校验**不检查牌堆守恒**。**这条结论很重要**：
  它意味着「C15 三处同改」在门禁里**只有本片新增的用例在守**，既有 61 条 game-service 用例
  一条也抓不到 23 张。⇒ 已按后端建议补一条**保守的守恒断言**（`view.builder.test.ts`）：
  `sum(cardCounts) + played = 54`（用完整 54 张的会话，**只做守恒、不钉 20/17**，
  避免与 §3.3/§3.4 的份额细节耦合）。
  至于「在 `validateOutbound` 或 view 层加机械闸」——属**契约侧**（`packages/protocol` 归协调者，
  且 R109 本片零改动），**登记为后续加固项**，不在本片做。
  ⚠️ **写这条守恒断言时又踩了一次**：第一版写成
  `sum(cardCounts) + played + bottomCards.length === 54` ⇒ 实测 **57 = 54 + 3** 假失败。
  原因是 C15 之后**底牌已经是地主手牌的一部分**，不能再单独相加。
  正确形态是 `sum(cardCounts) === 54`（一张未出时），并把「底牌 ⊆ 地主 hand」单独断言。
  ⇒ 教训：**守恒式的每一项都要先问「它是否已被另一项包含」**（与 R117 的「no-op 变异」同源）。
- **R119 计划 Task 4 Step 1 的三条计时器断言判别力不足，已改成结构性判据（后端发现）。**
  实测：计时器触发后**旧句柄仍留在 `timers` map 里**（`createBidTimer` 只是 `setTimeout` 的薄包装，
  触发后无人从 map 删除）⇒ 计划写的 `timers.has(roomCode)` 在**旧实现下也是 true**（死句柄），
  而「房间消失后 `has` 为 false」在新旧实现下**都做不到**。已改为：
  ① `timers.get(roomCode)` **不是**触发时那只句柄（证明重挂了新句柄）；
  ② 再过一个回合时长会**第二次**触发超时（证明挂的是**活**计时器，而不是换了个死句柄）；
  ③「房间消失」那条改成「未安装新计时器（句柄不变）」。
  ⚠️ **顺带发现一个潜在隐患（本片不改生产语义，登记）**：`timers` **从不自我清理**
  ⇒ 它记录的是「曾经挂过」，任何把 `timers.has` 当「有活动计时器」用的代码（含 §9.2 第 3 条的验收）
  都不可靠。记忆增长有界（每房间一条），不构成泄漏，但**判据不可靠**。建议单独立条跟进。
- **R120 计划 Task 2 Step 1 的夹具含非法牌值（后端发现，同前端 R112②）。**
  计划给的 `hand20` 里 `15/16` **不是合法 DouZero 编码**（合法值只有 3–14 / 17 / 20 / 30），
  照抄会在 `assertCardArray` 抛 `ProtocolError`（是报错，不是断言失败），**测不到补偿那一层**。
  已改为合法的 17 张再 ∪ 底牌。
- **R121 计划 Task 1 Step 1 的 `new Set(all).size === 54` 不可能成立（后端发现）。**
  DouZero 编码**不含花色**，54 张牌只有 **15** 个不同值。已改为按**值分布**校验
  （3..14 各 4 张、17 四张、20 一张、30 一张）—— 这才是「重发时忘了清旧手牌」的真正判据。
- **R122 计划 Task 4 Step 1 的第一条用例走不到 `catch`（后端发现，计划自相矛盾）。**
  按 R106 的设计，「`currentBidder = 7` ⇒ `players[7]` 为 undefined」会命中 `!playerId`
  **前置守卫**（记 error + 重挂 + return），**`catch` 一次都不进**。已改为经**公开 API**
  构造真实抛错形态：地主首出 → 两农民过牌 ⇒ `currentPlayer === lastPlayerIdx`
  ⇒ `handlePass` 抛 `Cannot pass when you last played`（正是 C5/§9.1 的场景，切片 8 只做重挂+不吞错）。
  ✅ **附带收益**：因为走公开 API，**不必**按计划给 `GameService` 加 `saveSessionForTest`
  （计划里「优先用方案 ②」的裁决被正确执行）。守卫分支另用「直接往 `service['cache']` 写残缺会话」
  （与本文件既有 `service['cache'].delete(...)` 同款）单独覆盖。
- **R123（观察，不改行为）`handleBid` 的结束判据已按玩法 §3.2 收敛。**
  旧判据是「`candidate !== -1 && grabActions >= 3`」，新判据是「`grabActions >= 3` → 有 candidate 则收口、
  否则流局」，与 §3.2 的表述逐字一致；`bidPasses` 现在**只作统计**（不再触发流局），与 §3.1 的表格一致。
  这条是 R101/R104 的必然结果，登记以免读者以为是行为漂移。

## 执行期裁决（前端 Task 5 已落地，2026-09-15）

- **R112 Task 5 Step 1 的用例有三处不可直接执行，已按真实实现收敛（前端执行期发现；计划缺陷）。**
  三条都属于「计划给了看似可编译的片段，但真实语义下要么 race、要么直接抛异常」，与切片 7 的 F1 同类：

  ① **「一次 mount 里 ack 后接着点第二个按钮」永远到不了第二个请求**（最坑的一条）。
     `game.bid ∈ CAS_MESSAGES`：`GameClient.send` 在 `currentVersion = 1` 时置
     `awaitingStateVersion = 1`，而 `finishRequest` 见 `stillAwaitingState` 为真时**不释放串行队列**
     （`apps/client/src/net/socket.ts:869-887`，M06/§6.5）。于是 ack 之后组件 `busy` 仍为 `true`、
     `send` 也会被判 `blocked`，`emittedOf('game.bid')` **永远到不了 2**。
     ⇒ 收敛为 `it.each` 的**两次独立 mount**（seat 1 抢 / seat 2 不抢），并补断言
     `baseVersion === 1`（§6.5 的真实值，**不是** `0`）。
     ⚠️ 这条教训比用例本身重要：**照抄的人会看到一个永远不可能变绿的断言**，
     极易误判成「模板缺 class」，把串行队列语义问题一路带到绿。
  ② **20 张手牌的字面量必须全合法**：`packages/protocol/src/codec.ts:53-57` 的 `assertCardArray`
     只接受 3–14 / 17 / 20 / 30，且强制 `hand.length === cardCounts[seat]`。
     计划初稿里的 `15/16` 会让 `socket.push` **抛 `ProtocolError`**（是报错，不是断言失败）。
  ③ **`vi.resetModules()` 对静态 import 是 no-op**：已求值的模块不会被重置，留着只会造成
     「模块已隔离」的错觉。真正的隔离来自 `stopGameSession()`（模块级 handle 单例）+ 每用例新建 pinia。
     **新增前端测试不要照抄这一行。**
- **R113 计划 Task 5 关于夹具的描述有一处不准确（已核对真实夹具）。**
  `apps/client/test/helpers/fake-socket.ts` 的 `playerViewFixture(over)` 用 `{...默认, ...over}` 覆盖
  **顶层**字段：
  - `bidPhase` **必须写全**（整体替换、不合并）；
  - `cardCounts` 的**第 `seat` 位一定会被 `hand.length` 覆盖**（fixture 在 `...over` 之后重算）
    ⇒ 对它「写不写等价」，只有**别人的**座位会被传入值影响。
  计划里「`bidPhase`/`cardCounts` 都要写全」的后半句因此不准确（写全无害但不必要，且会掩盖这一点）。
  下一位执行者读这一段即可，不必再重读一遍夹具。
- **R114 前端用例的判别力构型（沿用 R64 的「真区分力」要求）。**
  计划 Task 5 的第 4 条（「模板里没有本地倍数/底分计算」）**在改动前的树上就是绿的 ⇒ 对旧模板零区分力**。
  执行者没有用空测充数，而是加强为三段，并让判别力**可证**：
  (a) 渲染文本不得出现 `×N` / `底分`；
  (b) **机械源码扫描** `src/pages/table.vue`（§12.4 的 MVP 形态）：`×N`、`底分`、`baseScore`、
      对 `multiplier`/`bidMultiplier` 做 `* + - %`、`Math.pow(2`；
  (c) **正对照**：扫描器对合成样本必须报错（`'<span>×2 底分</span>'` → 命中 2 条），
      否则「扫不到」可能只是扫描器写错了（与 R68②「变异必须先自证生效」同源）。
  ⚠️ 扫描**只覆盖牌桌模板**：`apps/client/src/pages/lobby.vue` 的 `底分 {{ room.baseScore }}`
  是**原样展示服务端字段**（§12.1 哑终端允许），把它扫进去是假红。
  另外夹具必须让 `currentPlayer !== bidPhase.currentBidder`（执行者定为 `currentPlayer = mySeat`、
  `currentBidder = 0/1`）——否则「误用 `currentPlayer`」这类回归**无区分力**
  （变异 A 实测：只有把禁用依据改成 `store.view?.currentPlayer !== store.mySeat` 才打红 2 条）。
- **R115 jsdom 下 `trigger('click')` 打在 `disabled` 按钮上是静默 no-op（新通用教训，前端实测）。**
  探针正对照：`disabled = true → clicks = 0`、`disabled = false → clicks = 1`（事件根本不派发）。
  推论很硬：**任何「按钮被禁用 ⇒ 点它也不会发请求」的反向断言都是空测**；
  要抓住「本该禁用却可点」，**唯一**可靠的手段是断言 `disabled` 属性本身
  （本片 `table-bid-ui.test.ts` 第 ① 条就是这个形状）。
  ⇒ 已与「`vi.waitFor` 不能证明『没发生』」（R68①）并列，写进
  `agent-briefs.md` 的「切片 8 新增的通用教训」。

---

## 下一步

本片合并后：**切片 7.1（C11 原子入座 + E10 单测去网络依赖）→ 切片 7.2 完整片（S4/S5/S6/S7/A6/A7 + N5/N6 + R98，必须在切片 9 前）→ 切片 9（出牌轮转）→ 10 → 11**。

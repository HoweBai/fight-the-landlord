# 切片 9 实施计划：出牌轮转

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「出牌轮转」从「能跑通但五处违反玩法规格、且**正常对局路径必然卡死**」修成「一局能真的打到分出胜负、无卡死」：`lastPlayedHand` 契约化并把牌值收敛到**单一内部 Rank 口径**（C19/C20）、过牌补上「首出」前置（C18）、农民胜利条件 `every → some`（C16）、出牌超时不再无条件过牌而是**打最小单张**（C5）、规则引擎错误映射**可枚举**并配一条「所有 throw 都有映射 + 与玩法 §11.1 逐因对账」的机械闸（C6+N2），并给前端补上选牌/出牌/过牌与倒计时的**接线判据**以及 N15 的「被踢线后不再自动重连」。

**Architecture:** 规则真源仍是 `packages/shared/src/ddz/`（纯状态机，`handlePlayCards` / `handlePass` / `handlePlayTimeout`），game-service 只做「取会话 → CAS → 调规则引擎 → 落盘/推送/重挂计时器」的外壳并把规则引擎抛出的字符串错误映射成契约码，room-service 只按 `PlayerView.currentPlayer` 下发 `game.current_turn`，前端只读 `PlayerView` 渲染、**不做任何合法性判断**。本片的核心结构改动有两条：① `GameSession.lastPlayedHand` 直接复用契约类型 `LastPlayedHand`（`{cards, type, keyRank, length}`），跟牌比较**只读持久化字段**、禁止重新解析 `cards` 反推 —— C19（牌值双口径）与 C20（`length` 单位）是同一个根因的两面；② 规则引擎抛错的映射从「散落在 `classifyRuleError` 里的正则」变成**可枚举的规格表** + 一条机械闸。

**Tech Stack:** TypeScript / NestJS 10 / ioredis / Vitest / pnpm workspace + Turborepo / Vue 3 + Pinia + Vite（`apps/client`）/ socket.io 4

**Spec:**
- `docs/design.md` v4.2 —— 权威依据。本切片落在 **§3.2（`GameSession`）、§4.4（`game:events` 推送）、§6.2（信封）、§6.3（消息清单）、§6.4（可见性裁剪）、§6.5（CAS 与 `13004`）、§7.4（game-service）、§11.1/§11.2（错误码）、§12（前端约束 F01/F06/F10）**
- `docs/games/doudizhu.md` v1.2 —— **玩法唯一来源**。本片逐条落实 **§1.4（编码边界）、§4.1（`length` 单位）、§4.3（非法牌型 → `13006`）、§5（牌型比较，含「`length` 必须来自持久化字段」）、§6.1（出牌 11 步）、§6.2（过牌 8 步）、§6.3（状态不变式 1–4）、§7（胜负判定）、§9.1（超时可执行定义）、§9.2（计时器）、§11.1（错误码映射）**
- `docs/superpowers/plans/deviation-ledger.md` §2「切片 9（出牌轮转）」—— 本片的待办清单来源：**C5 / C16 / C18 / C19 / C20 / C6+N2** + 前端选牌/出牌/过牌与倒计时 + **N15**；§1.5 的 **N16/N17 由本片新登记**
- `docs/superpowers/plans/2026-09-13-parallel-dev.md` —— 切片表第 9 行 + Global Constraints 12 条
- `docs/superpowers/plans/agent-briefs.md` —— 角色、工作区、**已知环境事实**（robot-service 的 bind-mount、`DOCKER_BUILDKIT=0`、门禁必须 `--force`、`timeout` 是廉价保险）
- `docs/superpowers/plans/2026-09-15-slice-08-bidding.md` —— 上一片计划（本片沿用其结构、裁决格式与门禁写法）

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

### 本切片的绑定数值（来自玩法 §4/§5/§6/§7/§9 与主规格 §6.4/§11.2，**逐字**）

| 项 | 值 |
|---|---|
| 牌值口径 | 手牌与 `lastPlayedHand.cards` 用 **DouZero**（`2` = 17）；**进入判定前一律还原为内部 Rank**（`2` = 15，§1.4） |
| `lastPlayedHand` 形状 | `{ cards: number[]; type: number; keyRank: number; length: number }`（主规格 §3.2 / §6.3；`keyRank` 取**内部 Rank**） |
| `lastPlayedHand.length` 单位 | 顺子 → **张数**；连对 → **对子组数**；飞机/飞机带单/飞机带对 → **三张组数**；其余 → `0`（§4.1） |
| 比较时 `length` 来源 | **必须**取自 `lastPlayedHand.length` 持久化字段，**不得**重新解析 `cards` 反推（§5 末注） |
| 过牌两条前置 | ① `lastPlayedHand !== null`；② 该玩家不是 `lastPlayerIdx` —— **缺一不可**，违反 → `13001`（§6.2-2/3） |
| 出牌校验顺序 | 回合归属 `12003` → 牌在手中（否则 `13001`）→ 牌型合法且压得过（否则 `13006`）（§6.1-1/2/3、§11.1） |
| 胜负判定 | 地主手牌 0 → 地主胜；**任一**农民手牌 0 → 农民胜（§7） |
| 出牌超时 | 过牌合法 ⇒ 过牌；否则 ⇒ 打**手牌中点数最小的单张**（§9.1 第 ④ 步与「首出」分支） |
| 计时器 | 每次状态转移后重挂（**含超时动作本身**）；任一时刻**至多一个**活动计时器；结束即清除（§9.2） |
| 一墩结束 | 两家过牌 ⇒ `lastPlayedHand = null`、`currentPlayer = lastPlayerIdx`、`consecutivePasses = 0`（§6.2-5） |
| 不变式（§6.3） | ① `lastPlayedHand !== null ⇒ currentPlayer !== lastPlayerIdx`；② `currentPlayer ∈ {0,1,2}`；③ `lastPlayedHand === null ⇒ consecutivePasses === 0`；④ `state === 'playing'` 且某玩家手牌为 0 ⇒ 已结束 |
| 本片相关错误码 | `12003` 非当前回合、`12004` 不在房间、`13001` 操作非法、`13004` 版本冲突、`13005` 已结束、`13006` 出牌不合法 |

### 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接切片 8 的 **R123**，从 **R157** 起。执行期若发现下列任一条与代码事实不符，**就地记「执行期裁决」并写进计划文件**，不要静默偏离。

- **R157 `lastPlayedHand` 直接复用契约类型，且跟牌比较**只**读持久化字段。**
  - `packages/shared/src/ddz/types.ts` 的 `GameSession.lastPlayedHand` 改为 `LastPlayedHand | null`，其中 `LastPlayedHand` **从 `@fight-the-landlord/protocol` 的 `views.ts` 引入并 re-export`**（type-only import，不引入运行期耦合）。删除 shared 里 `{ cards; type: string; rank: number }` 这个**第二形状**。
  - `canBeat()` 的入参类型收窄为 `BeatTarget = { type: HandType; keyRank: number; length: number }`，**不再接受 `cards`** —— 让「重新解析 `cards` 反推」在类型上就写不出来。`ParsedHand` 结构上满足 `BeatTarget`，因此既有调用点（`beat.ts`、`rule.test.ts`）零改动。
  - 为什么与切片 10 的 **N1** 同一手法却现在就做：`lastPlayedHand` 是**本片的主角**，留两套形状会让 C19/C20 的修复变成「在两个真源之间搬运」；`SettlementResult` 的同一处理仍归切片 10（本片**不动** `SettlementResult` 与 `settle.ts` 的倍数/座位/底分逻辑）。
- **R158 牌值单一口径：判定路径**只**吃内部 Rank。**
  `handlePlayCards` 里 `parseHand(cards.map(int => ({ rank: int as Rank })))` 是把 DouZero 编码当 Rank 用（`2` 变成 `17`），而 `lastPlayedHand.cards` 却经 `douzeroIntToCard` 还原成 `15` —— 两者一比就得出「`2` 能压 `2`」。裁决：**所有**进入判定的牌都必须走既有适配器 `douzeroIntToCard()`（它内部就是 `toInternalRank`），严禁再出现 `rank: int as Rank` 这种直通写法。
  **判据（唯一可判别形态）**：`lastPlayedHand` 是单张 `2`（`cards: [17]`、`keyRank: 15`）时，再出单张 `2`（`[17]`）必须被拒（`15 > 15` 为假）；旧实现下 `17 > 15` 为真 ⇒ **用例红**。
- **R159 过牌的两条前置都要有，且顺序固定（C18）。**
  顺序必须是：`state` → 玩家存在 → 回合归属 → **`lastPlayedHand !== null`** → `lastPlayerIdx !== playerIdx`。新错误文本固定为 `Cannot pass on the opening lead`，映射 `13001`。
  为什么顺序不能反：反了以后「首出且自己就是上一手出牌者」会先命中第 3 条的文本，用例就只能钉住一条分支。第 3 条在修好不变式 1 之后**是冗余的纵深防御**（§6.2 明说），**不得**因此删掉它。
- **R160 §6.3 的不变式 1–3 落成 `assertPlayInvariants()`，在 `handlePlayCards` / `handlePass` 的每一次返回前校验。**
  第 4 条（手牌为 0 ⇒ 已结束）**不在** `play.ts` 里断言：手牌归零的那一瞬间 `state` 仍是 `playing`，置 `ended` 由 game-service 的 `finishTransition` 在同一次转移里完成（在 `play.ts` 断言它必然误报）。
  判据：把会话改坏成 `currentPlayer === lastPlayerIdx` 且 `lastPlayedHand !== null` 时必须抛错，而不是静默继续。
- **R161 C16 的修法是「删掉重复实现」而不只是改两个字面量。**
  `farmers.every(...)` 出现在 `play.ts:144` 与 `settle.ts:40` **两份重复实现**里 —— 这正是它必须被修两次的原因。裁决：`settle.ts` 删除本地 `checkWinCondition`，改为 `import { checkWinCondition } from './play'`（`play.ts` 是唯一真源，无循环依赖）。本片**只**动「胜负判定」这一件事，`settle.ts` 的加法倍数/座位语义/硬编码 100/春天零实现**一律不动**（C1/C2/C3/C26 归切片 10）。
  判据：至少一条「**只有一名**农民手牌为空」的用例（旧的 `play.test.ts:107` 把两名农民都清空 ⇒ `every`/`some` 同真，**没有判别力**，必须改写）。
- **R162 C5 只做「保证可执行」的那一半，另一半**明确**归切片 11。**
  玩法 §9.1 的四步里，① 同型最小可压 / ② 最小炸弹 / ③ 王炸 依赖 `rule/autoplay.ts` 补满 14 种牌型、`Invalid` 分支返回最小单张、面对王炸不得返回炸弹（对账表 **E4**，**归切片 11** 的「接上调用方」）。今天调用它是**引入非法动作**。
  裁决：本片实现 §9.1 的 ④ 与「首出」分支，判据用**结构性条件**（不依赖不变式 1 的证明）：
  ```
  可过牌 ⇔ lastPlayedHand !== null && lastPlayerIdx !== 当前行动者   → handlePass
  否则（首出 / 一墩回到最后出牌者）                                → 打手牌中点数最小的单张
  ```
  单张永远合法 ⇒ 超时动作**一定可执行**，对局不可能再卡死在超时上。因此对账表 **C5 = 部分关闭**，剩余的一半（最优跟牌）**写进对账表**归切片 11，**不得**写成「已关闭」。
- **R163 超时动作与人类动作走同一条校验链。**
  `packages/shared/src/ddz/play.ts` 新增 `handlePlayTimeout(session, playerId)`，它**只做分支选择**，真正推进状态一律复用 `handlePlayCards` / `handlePass` ⇒ `version + 1`、`§6.3` 不变式、胜负判定、§9.2 重挂计时器全部自然继承。
  `game.service.ts` 的 `onTurnTimeout` 出牌分支改调它（叫抢分支不动，仍是 `handleBid(session, playerId, false)`）。⚠️ 改完 `handlePass` 在 `game.service.ts` 里**不再被使用** ⇒ 必须从 import 列表里删掉（`noUnusedLocals: true`，否则 lint 红）。
- **R164 C6+N2 的最小交付 = 映射可枚举 + 两条机械闸（并**顺带**修正与玩法 §11.1 方向相反的两处错配）。**
  - 映射表从 `game.service.ts` 移到新文件 `packages/game-service/src/game/rule-error.mapping.ts`，导出 `RuleErrorMapping { pattern; code; basis }` 的 `RULE_ERROR_MAPPINGS`（**顺序即优先级**）与 `classifyRuleError()`。`game.service.ts` 改为 import 它（`game.controller.ts` 与测试里原先从 `game.service` 取 `classifyRuleError` 的**唯一**调用点是 `game.service.test.ts`，随之改 import 路径）。
  - 机械闸文件 `packages/game-service/test/rule-error-mapping.test.ts`，两组断言：
    1. **覆盖闸**：扫描 `packages/shared/src/{ddz,rule}/**/*.ts` 的**每一处** `throw new Error(...)`（**必须支持模板字面量**，见 R171/切片 7.2 的 R150 教训），断言每一条都能被 `RULE_ERROR_MAPPINGS` 里某条 pattern 命中；
    2. **规格闸**：一张 `SPEC_ROWS`（玩法 §11.1 的逐因映射逐字抄写）逐行断言 `classifyRuleError(new Error(msg)) === code`。
  - **顺带修正（新登记 N16）**：现映射把「压不过上一手」映射成 `13001`、把「牌不在手中」映射成 `13006`，而玩法 §6.1-2/3 与 §11.1 要求**恰好相反**（压不过 → `13006`；牌不在手中 → `13001`）。`design.md` §11.2 只定义码义、**逐因映射的唯一出处是玩法 §11.1** ⇒ 按 §11.1 收敛。连带改 `packages/game-service/test/game.service.test.ts:123-124`（两行的期望值互换）。
  - 本片**不**启用 `HandType.Invalid`（`parseHand` 继续 throw）：`autoplay.ts:5` 与 `beat.ts:5` 依赖那个分支，启用它与 **E4** 是同一次改动 ⇒ **C6 = 部分关闭**，剩余一半（返回 `Invalid` 的类型化结果）归切片 11。
- **R165 前端本片只做「接线判据 + N15」，一条合法性判断都不许加（R167 见下）。**
  选牌/出牌/过牌/倒计时在切片 2–8 已经写好（`table.vue` / `Hand.vue` / `Card.vue` / `useCountdown.ts`）。本片前端交付的是**判据**：
  ① 不是我的回合 ⇒ 两个按钮 `disabled`（断言 **`disabled` 属性本身**，R115：jsdom 里点 disabled 按钮是静默 no-op，反向断言会变空测）；
  ② 轮到且已选牌 ⇒ 点击发 `game.play`，`payload.cards` 是选中的 **DouZero 值**、`baseVersion` = 已应用版本；
  ③ 点击发 `game.pass`，`payload` 为 `{}`；
  ④ 倒计时以服务端 `turnDeadlineAt` 为基准（F06），到 0 **不**改变任何按钮的可用性、也**不**本地发任何请求；
  ⑤ **F01 判别力**：`lastPlayedHand === null`（首出）时 `.table__pass` **不得**被禁用，点击照发 `game.pass` —— 「首出不能过牌」是**规则**，由服务端判 `13001`；前端若「好心」禁用，这条用例立刻红。
- **R166 N15 的前端半边：被服务端踢线后**不再自动重连 + 明确提示**。**
  - **终止依据是 `disconnect` 的 reason（`io server disconnect`），不是错误码**；`system.error{10006}` 只用来决定**文案**（`10006` = 同一 IP 并发连接数超限，§5.4 上限 5）。
  - 为什么不能拿 `10006` 当终止依据：HTTP 维度的限流也返回 `10006`（§5.4 的单用户 20 次/5 秒），那种情况下链路是好的、**必须**继续自动重连。
  - `ReconnectReason['kind']` 新增 `'server_rejected'`；`useGameSession` 对它**只提示、不导航**（`navigate('table')` 会把用户拽回一张连不上的牌桌）。
  - **正对照（探针判别力，R115/R150 同族）**：同一份用例里必须证明「`transport close` 仍然会发 `game.reconnect`」——否则「没有发重连」的断言可能只是探针坏了。
  - **后端半边（把限额检查挪到 namespace middleware / engine.io `allowRequest`，让客户端拿到 `connect_error`）本片不做**：它会改 R152 已实测的语义与 `slice-07.2-hardening` 第 8 步的判据，收益只是一个更干净的拒绝形态。⇒ **N15 = 部分关闭**，剩余一半登记为独立小片（P3）。
- **R167 `protocol` 本片零改动。**
  `LastPlayedHand` / `PlayerView` / `ErrCode` / `CLIENT_ACTION` 都已在切片 0 定义；`10006` 的 `CLIENT_ACTION` 是 `TOAST`（不改）。任何「顺手改契约」的冲动都必须先停下来问协调者（Global Constraint 12）。
- **R168 conformance `slice-09` 的两个场景 + 一个反例，且**不得** import `@fight-the-landlord/shared`。**
  - **场景 A（地主赢）**：地主每墩**首出**手牌中最大的一张单张，两农民依次过牌 ⇒ 两墩过牌把出牌权交回地主（§6.2-5）⇒ 20 墩后地主手牌为 0 ⇒ `game.finished{winner:'landlord'}` + `game.settlement`。
  - **场景 B（农民赢，这是 C16 的**唯一**判据）**：地主首出**最小**单张；在两位农民里挑**能压过它**的那位（用 `toInternalRank` 比较单张点数，**它不是一个规则引擎，只是 §10 的值映射**），用其**最小的能压过的单张**压过；地主与另一农民过牌 ⇒ 出牌权交给该农民；此后该农民每墩首出最小单张、另两家过牌 ⇒ 17 墩后该农民手牌为 0 ⇒ `game.finished{winner:'farmer'}`。**旧实现（`every`）下对局在这里不结束 ⇒ 用例超时红。**
  - **场景 C（C18 反例）**：新屋里地主在 `lastPlayedHand === null` 时发 `game.pass` ⇒ `13001`，且**被拒的动作不推进 version / currentPlayer**（正向等一段静默窗再断言，R68：`waitFor` 不能证明「没发生」）；随后地主正常出一张牌成功 ⇒ 证明这次拒绝没有把房间弄死。
  - **口径断言（C19 在线判据）**：场景 A/C 里每一手单张的 `lastPlayedHand` 都必须满足 `keyRank === toInternalRank(cards[0])`、`length === 0`、`type === 1`。旧实现下打 `2`（DouZero 17）会写出 `keyRank = 17` ⇒ **红**。
  - **只读 `PlayerView`**：conformance 驱动牌局只能靠「手牌 + 单张点数」这种最小信息，**不得**用 `@fight-the-landlord/shared` 的 `parseHand`/`canBeat` 造输入（那是拿被测实现当裁判）。
  - **连接名额（R155）**：三个场景是**三个房间** ⇒ 每次开新房前先关掉上一房的客户端并 `sleep(400)` 等 `ZREM`；`startFreshRoom` 抛出前必须先 `close()` 已连上的客户端（R156）。
- **R169 测试连带清单（不改测试 = 保留缺陷）。**
  本片**必须**同片修改的既有用例：
  | 文件 | 为什么要改 |
  |---|---|
  | `packages/shared/src/ddz/play.test.ts` | `handlePass` 的 `beforeEach` 夹具 `lastPlayedHand` 是 `null` ⇒ 补上非空 `lastPlayedHand`，「最后出牌者不能过牌」那条要单独设 `lastPlayerIdx`；`checkWinCondition` 的 farmer 用例必须改成「只有一名农民为空」 |
  | `packages/shared/src/ddz/settle.test.ts` | 只在 `settle.ts` 删掉本地 `checkWinCondition` 后核对 import 是否还好；**加法倍数的 `:35` 一行都不许动**（切片 10） |
  | `packages/game-service/test/view.builder.test.ts` | `lastPlayedHand` 夹具从 `{cards, type:'1', rank}` 改为契约形状；补一条**连对** `length = 3`（不是 6）的判别用例 |
  | `packages/game-service/test/game.service.test.ts` | `:123`（压不过）`13001 → 13006`、`:124`（不在手中）`13006 → 13001`（N16） |
  | `packages/game-service/test/game.timer.test.ts` | `stageTimeoutThatThrows` 那条路径**修好之后不再抛错**（它变成了「首出超时打最小单张」）⇒ 改成两条：① 首出超时打最小单张；② 跟牌超时过牌。R106 的 `catch` 路径改用「手牌为空」这个不可能状态来覆盖 |
  | `packages/robot-service/test/bot.player.test.ts` | `:130` 的 `{cards:[20], type:'1', rank:20}` 在新的联合类型下**编译/断言都会红** ⇒ 改为契约形状（`bot.player.ts` 只读 `.cards`，行为不变） |
  | `packages/room-service/test/ws.gateway.test.ts` | 夹具里 `lastPlayedHand: null`（无需改）；仅**回归**确认 |
- **R170 本片新登记的对账表条目（执行时写进 `deviation-ledger.md`）。**
  - **N16**：`classifyRuleError` 的「压不过上一手 / 牌不在手中」两条映射与玩法 §6.1/§11.1 **方向相反** ⇒ 切片 9 关闭（含测试连带）。
  - **N17**：对局结束时**不下发** `state = 'ended'` 的 `PlayerView`（`finishTransition` 只发 `game.ended`）⇒ 客户端 `store.view.state` 永远观察不到 `'ended'`、局终仍显示「出牌中」。**归切片 10**（结算页本来就需要这一版视图）。
  - **C5 / C6 / N15** 在本片之后都是**部分关闭**，必须在判定里写清剩下的是哪一半（对账表 §5 第 5 条）。
- **R171 机械闸与判据的三条通用纪律（前几片真金白银换来的，本片继续照做）。**
  ① 源码级机械闸**必须自带探针判别力**判据（正对照：正则真的命中某段真实代码；负对照：某个近似写法不被命中）——否则闸会在某次无害重构后静默变成恒真/恒假，而恒假的表现是「在正对照上红」，最诱人的修法恰好是把正对照删掉（R150）。
  ② 断言「没发生」之前，先证明探针能观测到「发生」（R115 / 切片 7.2 通用教训 3）。
  ③ 涉及墙钟/定时的断言优先改成**结构性判据**（句柄被换掉、排入的延时值、分派序号）；`game.timer.test.ts` 全程 `vi.useFakeTimers()`，不断言 `Date.now()` 差值（R108/R119）。
- **R172（计划自身的缺陷，协调者评审期发现并就地修正）：§7 的「结束」路径**不发** `game.state_update` ⇒ 终局手不能等版本推进。**
  `game.service.finishTransition()` 在 `winner` 成立时直接 `saveSession` + `publishEnded`（只发 `game.ended` ⇒ 客户端收 `game.finished` + `game.settlement`）后**立即 return**，**不**走 `publishSeatViews`。因此 conformance 驱动里「把手里最后一张打完」那一手**必须**等 `game.finished`，用通用的 `playAndSync`（它等「更新的快照版本」）会在这一手上白等 8 秒然后**超时假红**——即使在已修的实现上也会红。
  修正：Task 8 新增 `playFinalHand(actor, cards, checks, what)`（发请求 → 断言 ack 0 → `waitFor('game.finished')` 返回 winner），两个场景的循环都在 `view.hand.length === 1` 时改用它并 `break`。
  **连带事实（与 N17 互证）**：局终的 `state = 'ended'` 视图**从不**下发，客户端只能从事件得知结束 ⇒ N17（局终视图）确实缺，归切片 10。

---

## 执行模型（与切片 5/6/7/8 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | Task 8（conformance）、评审、合并、门禁、文档收口 |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | Task 1、2、3、4、5 |
| **前端 agent** | `.worktrees/frontend`（`feat/frontend`） | Task 6、7 |

**开工前固定动作**（两端都要，逐字执行）：

```bash
cd /home/howe/pokergame/.worktrees/<你的角色>
pwd && git branch --show-current
git merge master --no-edit        # master 已含切片 7.2 收口与 R157–R171 的全部裁决
pnpm install && pnpm build        # dist/ 是 gitignore 的；不重装会因解析不到 protocol 而假失败
```

**本片的文件集互不相交**：后端只动 `packages/{shared,game-service}/**`（`robot-service` 只有测试夹具随类型改动），前端只动 `apps/client/**`，协调者只动 `tools/conformance/**` 与 `docs/**` ⇒ 三条线可真正并行，合并应干净。

> ⚠️ `packages/shared` 是**后端 agent** 的写区（见 `agent-briefs.md` 的可写清单）。前端 agent **依然不得** import 它（Global Constraint 11 / F03）。

**汇报格式**（所有 agent 统一，逐条对应 DoD 并附**实际命令与输出**）：完成情况 / 改动清单（文件 + 一句话 + commit sha）/ 阻塞未完成 / 需要协调者裁决的事项 / 我发现的文档未记录的问题。

---

## File Structure

```
packages/shared/src/ddz/types.ts                    Modify: lastPlayedHand 复用契约类型（R157）
packages/shared/src/rule/rule.ts                    Modify: canBeat 入参收窄为 BeatTarget（R157）
packages/shared/src/ddz/play.ts                     Modify: C18 过牌前置 + C19 口径 + C20 length + 不变式 + handlePlayTimeout（R158/R159/R160/R162/R163）
packages/shared/src/ddz/play.test.ts                Modify: 上列全部行为用例（含「2 不能压 2」与「只有一名农民为空」）
packages/shared/src/ddz/settle.ts                   Modify: 删除重复的 checkWinCondition，改 import 唯一真源（R161）
packages/shared/src/ddz/settle.test.ts              Modify: 仅核对（倍数一行都不动）
packages/game-service/src/game/view.builder.ts      Modify: lastPlayedHand 原样透传契约形状（C20）
packages/game-service/src/game/rule-error.mapping.ts Create: 可枚举映射表 + classifyRuleError（N2/R164）
packages/game-service/src/game/game.service.ts      Modify: onTurnTimeout 用 handlePlayTimeout；import 调整（C5/R163）
packages/game-service/test/view.builder.test.ts     Modify: 夹具形状 + 连对 length 判别用例
packages/game-service/test/game.service.test.ts     Modify: classifyRuleError 的 import 路径 + N16 两行期望值
packages/game-service/test/game.timer.test.ts       Modify: 首出超时打最小单张 / 跟牌超时过牌 / catch 路径重挂
packages/game-service/test/rule-error-mapping.test.ts Create: 覆盖闸 + 规格闸 + 探针判别力（N2/R164）
packages/robot-service/test/bot.player.test.ts      Modify: lastPlayedHand 夹具形状（R169）

apps/client/src/net/socket.ts                       Modify: 服务端踢线 ⇒ 终止自动恢复 + 明确提示（N15/R166）
apps/client/src/composables/useGameSession.ts       Modify: server_rejected 只提示不导航（N15/R166）
apps/client/test/table-play-ui.test.ts              Create: 选牌/出牌/过牌/倒计时/F01 判据（R165）
apps/client/test/connection-rejected.test.ts        Create: N15 的 4 条（含 transport close 正对照）
apps/client/src/pages/table.vue                     Modify: 仅在判据要求时（预期零改动；若改了必须写清原因）

tools/conformance/src/slices/slice-09-play-rotation.ts  Create: 场景 A/B/C（协调者）
tools/conformance/src/run.ts                            Modify: 注册 slice-09
tools/conformance/package.json                          Modify: conformance:slice-09 脚本
```

---

## Task 1: `lastPlayedHand` 契约化 + 牌值单一口径（C19/C20/R157/R158）

**Files:**
- Modify: `packages/shared/src/ddz/types.ts`
- Modify: `packages/shared/src/rule/rule.ts:143-151`
- Modify: `packages/shared/src/ddz/play.ts:25-99`
- Test: `packages/shared/src/ddz/play.test.ts`
- Modify: `packages/game-service/src/game/view.builder.ts:84-92`
- Test: `packages/game-service/test/view.builder.test.ts:233-243`

**Interfaces:**
- Produces: `GameSession.lastPlayedHand: LastPlayedHand | null`（契约形状，从 `@fight-the-landlord/protocol` 复用）；`canBeat(newHand: BeatTarget, lastHand: BeatTarget): boolean`；`BeatTarget = { type: HandType; keyRank: number; length: number }`
- Consumes: `douzeroIntToCard()`（`play.ts` 内已有）、`parseHand()`、`toInternalRank()`

- [ ] **Step 1: 写失败用例（C19 的判别形态 + C20 的 length 口径）**

在 `packages/shared/src/ddz/play.test.ts` 顶部补 import 与两条用例（`describe('handlePlayCards')` 内）：

```ts
import { HandType } from '../rule/rule';
```

```ts
  /**
   * C19 / R158 的**唯一**判别形态：同点数的「2」不能互相压过。
   *
   * 旧实现把待出牌的 DouZero 编码当 Rank 用（`2` → 17），而上一手却经
   * `douzeroIntToCard` 还原成内部 Rank（`2` → 15）⇒ `17 > 15` 为真 ⇒ **2 压 2**。
   */
  it('同点数的 2 不能压过上一手的 2（C19/R158）', () => {
    const base = {
      ...session,
      state: GameState.Playing,
      currentPlayer: 1,
      lastPlayerIdx: 0,
      lastPlayedHand: { cards: [17], type: HandType.Single, keyRank: 15, length: 0 },
      players: session.players.map((p, idx) => ({
        ...p,
        hand: idx === 1 ? [17, 3] : p.hand,
        isLandlord: idx === 0,
      })),
    };
    expect(() => handlePlayCards(base, 'user-2', [17])).toThrow('cannot beat');
  });

  /** 正对照：A（14）**不能**压 2（15），而 2（17）能压 A（14）—— 证明上面那条不是「什么都拒绝」。 */
  it('单张比较用内部 Rank：A 压不过 2，2 压得过 A（C19/R158）', () => {
    const mk = (lastCards: number[], lastKeyRank: number, hand: number[]) => ({
      ...session,
      state: GameState.Playing,
      currentPlayer: 1,
      lastPlayerIdx: 0,
      lastPlayedHand: { cards: lastCards, type: HandType.Single, keyRank: lastKeyRank, length: 0 },
      players: session.players.map((p, idx) => ({
        ...p,
        hand: idx === 1 ? hand : p.hand,
        isLandlord: idx === 0,
      })),
    });
    expect(() => handlePlayCards(mk([17], 15, [14]), 'user-2', [14])).toThrow('cannot beat');
    expect(handlePlayCards(mk([14], 14, [17]), 'user-2', [17]).lastPlayedHand!.keyRank).toBe(15);
  });

  /**
   * C20 / R157：`lastPlayedHand` 记录的是**契约字段**，`length` 按 §4.1 单位。
   * 连对取「对子组数」= 3（**不是** 6 张）。
   */
  it('连对的 lastPlayedHand.length 取对子组数 3，而不是 6 张（C20/R157）', () => {
    const player1Hand = [3, 3, 4, 4, 5, 5, 6];
    const next = handlePlayCards(
      {
        ...session,
        state: GameState.Playing,
        currentPlayer: 1,
        lastPlayerIdx: -1,
        lastPlayedHand: null,
        players: session.players.map((p, idx) => ({
          ...p,
          hand: idx === 1 ? player1Hand : p.hand,
          isLandlord: idx === 0,
        })),
      },
      'user-2',
      [3, 3, 4, 4, 5, 5],
    );
    expect(next.lastPlayedHand).toEqual({
      cards: [3, 3, 4, 4, 5, 5],
      type: HandType.PairStraight,
      keyRank: 3,
      length: 3,
    });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/shared test -- play.test.ts`
Expected: FAIL —— 第一条 `expected function to throw`（旧实现 `2` 压得过 `2`）；第三条 `length` 拿不到（旧结构只有 `rank`，没有 `length`）。

- [ ] **Step 3: `types.ts` 复用契约类型**

```ts
// packages/shared/src/ddz/types.ts
import type { LastPlayedHand } from '@fight-the-landlord/protocol';

/**
 * `lastPlayedHand` 的**唯一**形状来自契约包（切片 9 / R157）：
 *  - `cards` 是 **DouZero** 编码（接口/存储层口径，§1.4）；
 *  - `keyRank` 是**内部 Rank**（`2` = 15）；
 *  - `length` 按玩法 §4.1 的**单位**取值（顺子=张数 / 连对·飞机=组数 / 其余=0）。
 * 切片 9 之前这里是 `{ cards; type: string; rank: number }`——第二个真源，
 * 正是 C19（牌值双口径）与 C20（`length` 单位）的滋生地。
 */
export type { LastPlayedHand };
```

并把 `GameSession` 里的那一行换成：

```ts
  /** 最后一手公开牌（§6.1-5）。**唯一**形状来自契约包，见上方 `LastPlayedHand`。 */
  lastPlayedHand: LastPlayedHand | null;
  lastPlayerIdx: number;  // 最后出牌玩家索引
```

- [ ] **Step 4: `rule.ts` 把 `canBeat` 的入参收窄**

```ts
/**
 * 比较只需要这三个字段（玩法 §5）。
 *
 * ⚠️ **刻意不接受 `cards`**：§5 末注要求第 5 条的长度比较**必须**取自持久化字段，
 * 而 `handlePlayCards` 的旧实现是重新 `parseHand(cards)` 反推 —— 那既让
 * 「`length` 单位」多出一处解释权，也是 C19（DouZero 当 Rank 用）的温床（R157）。
 * `ParsedHand` 结构上满足本类型，因此既有调用点无需改动。
 */
export interface BeatTarget {
  type: HandType;
  keyRank: number;
  length: number;
}

export function canBeat(newHand: BeatTarget, lastHand: BeatTarget): boolean {
  // …函数体一字不改（第 144–150 行原样保留）
}
```

- [ ] **Step 5: `play.ts` 改判定与记录**

```ts
import { parseHand, canBeat, HandType, type BeatTarget } from '../rule/rule';
```

`handlePlayCards` 里三处：

```ts
  // Parse the hand being played（R158：**进入判定前一律还原为内部 Rank**）
  const playedHand = parseHand(cards.map((int) => douzeroIntToCard(int)));

  // Validate against last played hand（R157：**只**读持久化字段，禁止重新解析 cards 反推）
  if (session.lastPlayedHand && session.lastPlayerIdx !== playerIdx) {
    const last: BeatTarget = session.lastPlayedHand;
    if (!canBeat(playedHand, last)) {
      throw new Error('Invalid move - cannot beat last hand');
    }
  }
```

```ts
    // §6.1-5：记录契约形状（keyRank = 内部 Rank；length 按 §4.1 单位）
    lastPlayedHand: {
      cards,
      type: playedHand.type,
      keyRank: playedHand.keyRank,
      length: playedHand.length,
    },
```

（`douzeroIntToCard` 已是文件内的既有函数，**不要**再写第二份映射；`Suit`/`CardColor`/`Rank` 仍在 `douzeroIntToCard` 里使用，import 不需要删。）

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/shared test -- play.test.ts`
Expected: PASS

- [ ] **Step 7: `view.builder.ts` 原样透传 + 夹具与连对判别用例**

`packages/game-service/src/game/view.builder.ts` 的 `lastPlayedHand` 分支整段替换为：

```ts
    // R157：内部形状**就是**契约形状（`shared` 复用 `protocol` 的 `LastPlayedHand`），
    // 因此这里是**原样透传**：不得再自己拼 `length: cards.length`（C20 的错就此消失），
    // 也不得重新解析 `cards` 反推比较字段。`validateOutbound` 仍会机械校验三个数字字段。
    lastPlayedHand: session.lastPlayedHand,
```

`packages/game-service/test/view.builder.test.ts` —— 顶部 import 补 `HandType`（`@fight-the-landlord/shared` 的 index 已导出 `rule/rule`）：

```ts
import { GameState, HandType, type GameSession } from '@fight-the-landlord/shared';
```

```ts
  it('passes the contract-shaped lastPlayedHand through (keyRank + §4.1 length)', () => {
    const session = makeSession({
      state: GameState.Playing,
      lastPlayedHand: { cards: [3, 4, 5, 6, 7], type: HandType.Straight, keyRank: 3, length: 5 },
      lastPlayerIdx: 2,
    });

    const view = buildPlayerView(session, 0);
    expect(view.lastPlayedHand).toEqual({
      cards: [3, 4, 5, 6, 7],
      type: HandType.Straight,
      keyRank: 3,
      length: 5,
    });
    expect(view.lastPlayerIdx).toBe(2);
  });

  /**
   * C20 的**判别力**用例：连对的 `length` 是「对子组数」= 3，**不是** 6 张。
   * 旧实现写 `length: session.lastPlayedHand.cards.length` ⇒ 这里会是 6 ⇒ 红。
   */
  it('keeps length=3 for a pair-straight (組數, not card count) — C20', () => {
    const session = makeSession({
      state: GameState.Playing,
      lastPlayedHand: { cards: [3, 3, 4, 4, 5, 5], type: HandType.PairStraight, keyRank: 3, length: 3 },
      lastPlayerIdx: 1,
    });

    expect(buildPlayerView(session, 0).lastPlayedHand).toEqual({
      cards: [3, 3, 4, 4, 5, 5],
      type: HandType.PairStraight,
      keyRank: 3,
      length: 3,
    });
  });
```

（`makeSession` 的夹具类型来自 `../src/game/game.types`，其中 `GameSession` 的 `lastPlayedHand` 现在就是契约形状 ⇒ 旧的 `{cards, type:'1', rank}` 会在 `tsc` 下直接报错，这正是我们要的「类型即闸门」。）

- [ ] **Step 8: 连带修 `bot.player.test.ts` 的夹具（R169）**

`packages/robot-service/test/bot.player.test.ts:130`：

```ts
      lastPlayedHand: { cards: [20], type: 1, keyRank: 20, length: 0 },
```

（`bot.player.ts` 只读 `.cards`，行为不变；不改这一行 `tsc --noEmit` 会报 `'rank' does not exist`。）

- [ ] **Step 9: 全量回归**

Run:
```bash
pnpm exec turbo run test lint --force
```
Expected: 全绿（`shared` 与 `game-service`、`robot-service` 用例数不减）。

- [ ] **Step 10: 提交**

```bash
git add packages/shared/src/ddz/types.ts packages/shared/src/rule/rule.ts \
        packages/shared/src/ddz/play.ts packages/shared/src/ddz/play.test.ts \
        packages/game-service/src/game/view.builder.ts packages/game-service/test/view.builder.test.ts \
        packages/robot-service/test/bot.player.test.ts
git commit -m "fix(shared,game-service): lastPlayedHand 契约化 + 牌值单一口径（C19/C20, R157/R158）"
```

---

## Task 2: 过牌前置 + §6.3 不变式（C18/R159/R160）

**Files:**
- Modify: `packages/shared/src/ddz/play.ts`
- Test: `packages/shared/src/ddz/play.test.ts`

**Interfaces:**
- Produces: `assertPlayInvariants(session: GameSession): void`（`@fight-the-landlord/shared` 导出）
- Consumes: Task 1 的 `BeatTarget`

- [ ] **Step 1: 写失败用例**

`describe('handlePass')` 的 `beforeEach` 夹具补上非空 `lastPlayedHand`（否则本片之后**所有**过牌用例都会撞新的前置）：

```ts
    playingSession = {
      ...dealt,
      state: GameState.Playing,
      players: dealt.players.map(p => ({ ...p, isLandlord: p.seat === 0 })),
      currentPlayer: 1, // user-2 is at index 1
      lastPlayedHand: { cards: [20], type: HandType.Single, keyRank: 20, length: 0 },
      lastPlayerIdx: 0, // user-1 last played
    };
```

新增三条：

```ts
  /** C18 / §6.2-2：首出（`lastPlayedHand === null`）时任何人都不能过牌。 */
  it('首出时不能过牌（C18/§6.2-2）', () => {
    const opening = { ...playingSession, lastPlayedHand: null, lastPlayerIdx: -1 };
    expect(() => handlePass(opening, 'user-2')).toThrow('Cannot pass on the opening lead');
  });

  /** §6.2 的第 2、3 条缺一不可：第 3 条单独存在时，开局 `lastPlayerIdx === -1` 会让约束对所有人失效。 */
  it('首出且自己就是 lastPlayerIdx 时，命中的是「首出」而不是「最后出牌者」（顺序固定，R159）', () => {
    const opening = { ...playingSession, lastPlayedHand: null, lastPlayerIdx: 1 };
    expect(() => handlePass(opening, 'user-2')).toThrow('Cannot pass on the opening lead');
  });

  /** R160：不变式 1 —— `currentPlayer === lastPlayerIdx` 时不得再有 `lastPlayedHand`。 */
  it('assertPlayInvariants 拦住 currentPlayer === lastPlayerIdx 且 lastPlayedHand !== null 的坏状态（R160）', () => {
    const broken = { ...playingSession, currentPlayer: 1, lastPlayerIdx: 1 };
    expect(() => assertPlayInvariants(broken)).toThrow('invariant violated');
    // 负对照：正常形态（两家过牌后回到最后出牌者）**不**违反不变式
    expect(() =>
      assertPlayInvariants({ ...playingSession, lastPlayedHand: null, currentPlayer: 0, lastPlayerIdx: 0,
        playPhase: { ...playingSession.playPhase, consecutivePasses: 0 } }),
    ).not.toThrow();
  });
```

并在顶部 import 里加上 `assertPlayInvariants`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/shared test -- play.test.ts`
Expected: FAIL —— 首出过牌**没有**抛错（旧实现缺 §6.2-2）；`assertPlayInvariants is not a function`。

- [ ] **Step 3: 实现**

`play.ts`，`handlePass` 的两条前置（顺序照 R159 固定）：

```ts
  if (playerIdx !== session.currentPlayer) {
    throw new Error('Not your turn');
  }
  // §6.2-2（C18）：首出（无人出过牌）时**任何人**都不能过牌。
  // 第 2、3 条缺一不可：只有第 3 条时，开局 lastPlayerIdx === -1 会让约束对所有人失效，
  // 一旦两家过牌就会写出 currentPlayer = lastPlayerIdx = -1 ⇒ 对局永久卡死（实测形态）。
  if (session.lastPlayedHand === null) {
    throw new Error('Cannot pass on the opening lead');
  }
  // §6.2-3：最后出牌者不能过牌（修好不变式 1 之后这是**冗余的纵深防御**，不得删除）。
  if (session.lastPlayerIdx === playerIdx) {
    throw new Error('Cannot pass when you last played');
  }
```

文件末尾新增（R160）：

```ts
/**
 * 玩法 §6.3 的状态不变式 1–3，在**每次状态转移之后、返回之前**校验（R160）。
 *
 * 第 4 条（某玩家手牌为 0 ⇒ 对局已结束）**刻意不在这里**：手牌归零的那一瞬间
 * `state` 仍是 `playing`，置 `ended` 由 game-service 的 `finishTransition` 在同一次
 * 转移里完成 —— 在这里断言它必然误报。
 */
export function assertPlayInvariants(session: GameSession): void {
  if (session.lastPlayedHand !== null && session.currentPlayer === session.lastPlayerIdx) {
    throw new Error(
      'invariant violated: lastPlayedHand !== null requires currentPlayer !== lastPlayerIdx',
    );
  }
  if (!Number.isInteger(session.currentPlayer) || session.currentPlayer < 0 || session.currentPlayer > 2) {
    throw new Error(`invariant violated: currentPlayer must be 0/1/2, got ${String(session.currentPlayer)}`);
  }
  if (session.lastPlayedHand === null && session.playPhase.consecutivePasses !== 0) {
    throw new Error('invariant violated: lastPlayedHand === null requires consecutivePasses === 0');
  }
}
```

在 `handlePlayCards` 与 `handlePass` 的**每一个**返回之前调用它。写法照下面这样，避免「有人加了一个 return 忘了校验」：

```ts
  const next: GameSession = { /* 原 return 的对象字面量原样搬到这里 */ };
  assertPlayInvariants(next);
  return next;
```

（`handlePass` 有两个返回点：两家过牌的重置分支、普通推进分支 —— 两处都要走同一个 `next` + 校验 + return。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/shared test`
Expected: PASS（`play.test.ts` 全绿，其余文件不回归）

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/ddz/play.ts packages/shared/src/ddz/play.test.ts
git commit -m "fix(shared): 过牌补上 lastPlayedHand !== null 前置 + §6.3 不变式断言（C18, R159/R160）"
```

---

## Task 3: 农民胜利条件 `every → some`（C16/R161）

**Files:**
- Modify: `packages/shared/src/ddz/settle.ts:35-42`
- Test: `packages/shared/src/ddz/play.test.ts:91-120`

**Interfaces:**
- Produces: `checkWinCondition` 的**唯一**实现（`play.ts`）；`settle.ts` 不再有本地副本
- Consumes: Task 2 的 `play.ts`

- [ ] **Step 1: 写失败用例（判别力必须来自「只有一名农民为空」）**

把 `play.test.ts` 的 `it('returns farmer when all farmers have no cards', ...)` 整条替换为：

```ts
  /**
   * C16 / §7：农民是**团队**，**任一**农民出完牌即农民方获胜。
   * 夹具刻意只清空**一名**农民的手牌 —— 旧实现 `farmers.every(...)` 在这条输入下
   * 返回 `null`（对局不结束 ⇒ 正常对局路径必然卡死），因此它有判别力。
   */
  it('returns farmer when ANY one farmer has no cards (C16)', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);
    const winner = checkWinCondition({
      ...dealt,
      state: GameState.Playing,
      players: dealt.players.map((p, idx) => ({
        ...p,
        hand: idx === 1 ? [] : [1, 2, 3], // 只有座位 1（农民）出完了
        isLandlord: idx === 0,
      })),
    });
    expect(winner).toBe('farmer');
  });

  /** 负对照：地主与两名农民都有牌 ⇒ 未结束。 */
  it('returns null while nobody has emptied their hand', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);
    expect(
      checkWinCondition({
        ...dealt,
        state: GameState.Playing,
        players: dealt.players.map((p, idx) => ({ ...p, hand: [1, 2, 3], isLandlord: idx === 0 })),
      }),
    ).toBeNull();
  });
```

并在 `packages/shared/src/ddz/settle.test.ts` 里补一条**只经 `settleGame()`** 的用例（证明 `settle.ts` 用的是同一份判定，而不是自己那份）：

```ts
  /** C16：`settleGame()` 也必须按「任一农民为空」判胜（它此前有一份**重复**实现）。 */
  it('settles a farmer win when a single farmer has emptied their hand (C16)', () => {
    const session = createSession('ROOM1', ['user-1', 'user-2', 'user-3']);
    const dealt = dealCards(session);
    const result = settleGame({
      ...dealt,
      state: GameState.Playing,
      players: dealt.players.map((p, idx) => ({
        ...p,
        hand: idx === 1 ? [] : [1, 2, 3],
        isLandlord: idx === 0,
      })),
    });
    expect(result.winner).toBe('farmer');
    expect(result.farmerSeats).toEqual([1, 2]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/shared test -- play.test.ts settle.test.ts`
Expected: FAIL —— `期望 "farmer"，实际 null`（两处都是 `every`）。

- [ ] **Step 3: 实现（删掉重复实现，只留一个真源）**

`packages/shared/src/ddz/play.ts`：

```ts
  // §7：农民是团队 —— **任一**农民出完牌即农民方获胜（C16；旧实现写成了 every）。
  if (farmers.some(p => p.hand.length === 0)) return 'farmer';
```

`packages/shared/src/ddz/settle.ts`：删掉文件末尾的本地 `function checkWinCondition(...)`（第 35–42 行整段），改为从唯一真源导入：

```ts
import { GameSession, SettlementResult } from './types';
import { checkWinCondition } from './play';
```

（`settle.ts` 的其余内容**一行都不要动**：加法倍数、`landlordSeats`、硬编码 `100`、春天零实现都是 C1/C2/C3/C26，归切片 10。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/shared test`
Expected: PASS（`play.test.ts` + `settle.test.ts` 全绿，`settle.test.ts:35` 的加法倍数断言**保持原样通过**——那是切片 10 的活）

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/ddz/play.ts packages/shared/src/ddz/settle.ts \
        packages/shared/src/ddz/play.test.ts packages/shared/src/ddz/settle.test.ts
git commit -m "fix(shared): 农民胜利改为「任一农民出完牌」并删掉重复实现（C16, §7）"
```

---

## Task 4: 出牌超时打最小单张（C5/R162/R163）

**Files:**
- Modify: `packages/shared/src/ddz/play.ts`（新增 `handlePlayTimeout`）
- Modify: `packages/game-service/src/game/game.service.ts:14` 与 `:376-382`
- Test: `packages/shared/src/ddz/play.test.ts`、`packages/game-service/test/game.timer.test.ts`

**Interfaces:**
- Produces: `handlePlayTimeout(session: GameSession, playerId: string): GameSession`
- Consumes: `handlePass` / `handlePlayCards`（同为 `play.ts` 的导出）

- [ ] **Step 1: 写失败用例（shared 侧：分支选择本身）**

`play.test.ts` 新增 `describe('handlePlayTimeout（§9.1）')`：

```ts
describe('handlePlayTimeout（玩法 §9.1 的出牌超时）', () => {
  const playing = () => {
    const dealt = dealCards(createSession('ROOM1', ['user-1', 'user-2', 'user-3']));
    return {
      ...dealt,
      state: GameState.Playing,
      players: dealt.players.map((p, idx) => ({ ...p, isLandlord: idx === 0 })),
    };
  };

  it('首出超时 ⇒ 打手牌中点数最小的单张（§9.1 首出分支）', () => {
    const s = { ...playing(), currentPlayer: 1, lastPlayedHand: null, lastPlayerIdx: -1 };
    const hand = [20, 3, 30, 17];
    const withHand = { ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, hand } : p)) };

    const next = handlePlayTimeout(withHand, 'user-2');

    expect(next.lastPlayedHand).toEqual({ cards: [3], type: HandType.Single, keyRank: 3, length: 0 });
    expect(next.players[1]!.hand).toEqual([20, 30, 17]);
    expect(next.version).toBe(withHand.version + 1);
  });

  /** 一墩回到最后出牌者（`lastPlayedHand === null`）时，过牌非法 ⇒ 同样打最小单张。 */
  it('两家过牌后回到最后出牌者，超时也打最小单张（§9.1 的「为什么必须有首出分支」）', () => {
    const s = { ...playing(), currentPlayer: 0, lastPlayedHand: null, lastPlayerIdx: 0 };
    const withHand = {
      ...s,
      players: s.players.map((p, i) => (i === 0 ? { ...p, hand: [20, 3] } : p)),
    };

    expect(handlePlayTimeout(withHand, 'user-1').lastPlayedHand!.cards).toEqual([3]);
  });

  it('跟牌超时 ⇒ 过牌（§9.1 第 ④ 步）', () => {
    const s = {
      ...playing(),
      currentPlayer: 1,
      lastPlayerIdx: 0,
      lastPlayedHand: { cards: [17], type: HandType.Single, keyRank: 15, length: 0 },
    };

    const next = handlePlayTimeout(s, 'user-2');

    expect(next.playPhase.consecutivePasses).toBe(1);
    expect(next.currentPlayer).toBe(2);
    expect(next.lastPlayedHand).not.toBeNull(); // 过牌不清空上一手
  });

  /** R106 的 `catch` 路径要靠一个**不可能状态**来覆盖：currentPlayer 手牌为空但 state 仍是 playing。 */
  it('手牌为空时报错（不可能状态），交给调用方记 error 并重挂计时器', () => {
    const s = { ...playing(), currentPlayer: 1, lastPlayedHand: null, lastPlayerIdx: -1 };
    const withHand = { ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, hand: [] } : p)) };
    expect(() => handlePlayTimeout(withHand, 'user-2')).toThrow('has no card to play');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/shared test -- play.test.ts`
Expected: FAIL —— `handlePlayTimeout is not a function`

- [ ] **Step 3: 实现 `handlePlayTimeout`**

`play.ts` 末尾：

```ts
/**
 * 玩法 §9.1「出牌阶段超时」的**可执行**半边（R162/R163）。
 *
 * 判据是**结构性**的（不依赖不变式 1 的证明）：
 *   可过牌 ⇔ `lastPlayedHand !== null && lastPlayerIdx !== 当前行动者`；
 *   否则（首出 / 两家过牌后回到最后出牌者）打**手牌中点数最小的单张** ——
 *   单张永远合法，因此超时动作**一定可执行**，对局不可能再卡死在超时上。
 *
 * ⚠️ §9.1 的 ①②③（同型最小可压 / 最小炸弹 / 王炸）**不在这里**：它们依赖
 * `rule/autoplay.ts` 补满 14 种牌型、`Invalid` 分支返回最小单张、面对王炸不得返回
 * 炸弹（对账表 **E4**），归**切片 11**。今天调用它只会产生非法动作。
 */
export function handlePlayTimeout(session: GameSession, playerId: string): GameSession {
  const playerIdx = session.players.findIndex(p => p.id === playerId);
  if (playerIdx === -1) {
    throw new Error(`Player ${playerId} not found`);
  }

  const canPass = session.lastPlayedHand !== null && session.lastPlayerIdx !== playerIdx;
  if (canPass) return handlePass(session, playerId);

  const hand = session.players[playerIdx]!.hand;
  if (hand.length === 0) {
    // 不可能状态（手牌为 0 时对局应当已结束）：**必须抛错**，让 game.service 的 catch
    // 记 error + 重挂计时器，而不是静默吞掉（R106）。
    throw new Error(`Player ${playerId} has no card to play`);
  }

  // 「点数最小」按**内部 Rank** 取（§1.4 的唯一口径，R158）。
  const smallest = hand.reduce((min, c) => (toInternalRank(c) < toInternalRank(min) ? c : min), hand[0]!);
  return handlePlayCards(session, playerId, [smallest]);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/shared test -- play.test.ts`
Expected: PASS

- [ ] **Step 5: 重写 `game.timer.test.ts` 的三条计时器用例（R169）**

把 `stageTimeoutThatThrows()` 整个删掉，换成两个**真实形态**的准备函数与三条用例（顶部 import 补 `import { toInternalRank } from '@fight-the-landlord/protocol';`）：

```ts
  /** 开局 → 1 抢 2 不抢 → playing，返回地主席位。 */
  async function startPlayingGame(roomCode: string): Promise<number> {
    await service.startGame(startDto(roomCode));
    await service.bid(roomCode, 'user-1', true);
    await service.bid(roomCode, 'user-2', false);
    await service.bid(roomCode, 'user-3', false);
    const playing = (await service.getSession(roomCode))!;
    expect(playing.state).toBe(GameState.Playing);
    return playing.currentPlayer; // 地主
  }

  /** §1.4 的「点数最小」按**内部 Rank** 取（DouZero 值恰好单调，但口径必须写死）。 */
  const smallestByRank = (hand: number[]): number =>
    hand.reduce((m, c) => (toInternalRank(c) < toInternalRank(m) ? c : m), hand[0]!);

  it('首出超时 ⇒ 打手牌中最小的单张，并重挂计时器（C5/R162/R163）', async () => {
    await startPlayingGame('ROOM-P1');
    const before = (await service.getSession('ROOM-P1'))!;
    const actor = before.players[before.currentPlayer]!;
    const smallest = smallestByRank(actor.hand);
    const fired = service['timers'].get('ROOM-P1');
    const errorSpy = vi.spyOn(service['logger'], 'error');

    await vi.advanceTimersByTimeAsync(30_000);

    const after = (await service.getSession('ROOM-P1'))!;
    expect(after.version).toBe(before.version + 1);
    expect(after.lastPlayedHand!.cards).toEqual([smallest]);
    expect(after.players[before.currentPlayer]!.hand).toHaveLength(actor.hand.length - 1);
    expect(after.currentPlayer).toBe((before.currentPlayer + 1) % 3);
    // §9.2：超时动作本身也要重挂；⚠️ 判据必须是「句柄被换掉」（R119：timers 从不自我清理）
    expect(service['timers'].get('ROOM-P1')).not.toBe(fired);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('跟牌超时 ⇒ 过牌（§9.1 第 ④ 步）', async () => {
    const landlord = await startPlayingGame('ROOM-P2');
    const opening = (await service.getSession('ROOM-P2'))!;
    await service.playCards('ROOM-P2', opening.players[landlord]!.id, [
      smallestByRank(opening.players[landlord]!.hand),
    ]);

    const before = (await service.getSession('ROOM-P2'))!;
    await vi.advanceTimersByTimeAsync(30_000);
    const after = (await service.getSession('ROOM-P2'))!;

    expect(after.playPhase.consecutivePasses).toBe(1);
    expect(after.lastPlayedHand).not.toBeNull();
    expect(after.version).toBe(before.version + 1);
  });

  it('超时动作抛错（不可能状态：手牌为空）后仍记 error + 重挂 + 不落盘（R106 旧路径的替代覆盖）', async () => {
    await startPlayingGame('ROOM-P3');
    const session = (await service.getSession('ROOM-P3'))!;
    service['cache'].set('ROOM-P3', {
      ...session,
      players: session.players.map((p, i) =>
        i === session.currentPlayer ? { ...p, hand: [] } : p,
      ),
    });
    const fired = service['timers'].get('ROOM-P3');
    const errorSpy = vi.spyOn(service['logger'], 'error');

    await vi.advanceTimersByTimeAsync(30_000);

    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('has no card to play');
    expect(service['timers'].get('ROOM-P3')).not.toBe(fired); // 重挂
    expect((await service.getSession('ROOM-P3'))!.version).toBe(session.version); // 不编造状态转移
    errorSpy.mockRestore();
  });
```

⚠️ 上面第三条用的是 `service['cache']`（与既有 `ROOM-T4` 用例同款私有出口），**不要**为测试往生产类加方法。

- [ ] **Step 6: `game.service.ts` 接线**

```ts
import {
  GameState,
  checkWinCondition,
  createSession,
  dealCards,
  handleBid,
  handlePlayCards,
  handlePlayTimeout,   // ← 新增
  settleGame,
} from '@fight-the-landlord/shared';
```

`onTurnTimeout` 的出牌分支：

```ts
      const updated =
        session.state === GameState.Bidding
          ? handleBid(session, playerId, false)
          : handlePlayTimeout(session, playerId);
```

⚠️ `handlePass` 在 `game.service.ts` 里**不再被使用** ⇒ 从 import 列表里删掉（`noUnusedLocals: true`，否则 `lint` 红）。同时更新 `onTurnTimeout` 的注释：把「⚠️ 本任务**不做** §9.1 的『出牌超时打最小单张』（C5，归切片 9）」改成事实描述 —— 出牌阶段现在走 `handlePlayTimeout`，首出/回到最后出牌者打最小单张，跟牌过牌；最优跟牌（同型可压/炸弹/王炸）归切片 11。

- [ ] **Step 7: 跑测试确认通过**

Run:
```bash
pnpm exec turbo run test lint --force
```
Expected: 全绿（`game-service` 的计时器用例 3 条新形态通过）。

- [ ] **Step 8: 提交**

```bash
git add packages/shared/src/ddz/play.ts packages/shared/src/ddz/play.test.ts \
        packages/game-service/src/game/game.service.ts packages/game-service/test/game.timer.test.ts
git commit -m "fix(game-service,shared): 出牌超时改打最小单张，不再无条件过牌（C5, R162/R163）"
```

---

## Task 5: 规则引擎错误映射可枚举 + 两条机械闸（C6/N2/N16/R164）

**Files:**
- Create: `packages/game-service/src/game/rule-error.mapping.ts`
- Modify: `packages/game-service/src/game/game.service.ts:1-16,393-414`
- Test: `packages/game-service/test/rule-error-mapping.test.ts`（新建）
- Test: `packages/game-service/test/game.service.test.ts:118-128,3`

**Interfaces:**
- Produces: `RULE_ERROR_MAPPINGS: readonly RuleErrorMapping[]`、`classifyRuleError(err: unknown): ErrCode`、`interface RuleErrorMapping { pattern: RegExp; code: ErrCode; basis: string }`
- Consumes: `ErrCode`（`@fight-the-landlord/protocol`）

- [ ] **Step 1: 写失败用例（覆盖闸 + 规格闸 + 探针判别力）**

新建 `packages/game-service/test/rule-error-mapping.test.ts`：

```ts
/**
 * N2 / R164：规则引擎的错误映射必须**可枚举**，并且有两道机械闸：
 *  ① **覆盖闸**：`packages/shared/src/{ddz,rule}` 里**每一处** `throw new Error(...)` 都能被
 *     `RULE_ERROR_MAPPINGS` 的某条 pattern 命中 —— 任何人新增一个 `throw` 都会当场红；
 *  ② **规格闸**：`SPEC_ROWS` 逐行抄自玩法 §11.1，断言 `classifyRuleError` 给出**文档写的那个码**
 *     （N16：本片把「压不过」与「牌不在手中」两条方向相反的错配收敛回文档）。
 *
 * ⚠️ 扫描器**必须支持模板字面量**（R150 的教训）：`play.ts` 里最关键的几条
 * （`Card ${card} not in hand`、`不支持的牌型: ${...}`、`Invalid DouZero card int: ${int}`）
 * 全是模板字面量，只匹配 `'…'` 的正则会**静默漏扫**它们，闸就变成了恒真。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RULE_ERROR_MAPPINGS, classifyRuleError } from '../src/game/rule-error.mapping';

// ⚠️ 路径解析照 `apps/client/test/helpers/source-scan.ts` 的既有写法（**不要**用 `__dirname`：
//    本仓的测试由 vitest 以 ESM 语义加载）。
const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_SRC = resolve(HERE, '../../../shared/src');
const SCAN_DIRS = ['ddz', 'rule'] as const;

/** 把 `throw new Error(...)` 的实参**静态化**：剥掉 `${...}` 插值，只留模板的字面部分。 */
export function staticMessageOf(arg: string): string {
  return arg.replace(/\$\{[^}]*\}/g, '');
}

/** 扫出源码里所有 `throw new Error(<字面量>)`；返回静态化后的文本。 */
export function scanThrows(source: string): string[] {
  const out: string[] = [];
  const re = /throw new Error\(\s*([`'"])([\s\S]*?)\1\s*\)/g;
  for (const m of source.matchAll(re)) out.push(staticMessageOf(m[2]!));
  return out;
}

function collectThrowSites(): Array<{ file: string; message: string }> {
  const sites: Array<{ file: string; message: string }> = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(SHARED_SRC, dir);
    for (const entry of readdirSync(abs)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const file = join(abs, entry);
      if (!statSync(file).isFile()) continue;
      for (const message of scanThrows(readFileSync(file, 'utf8'))) {
        sites.push({ file: `${dir}/${entry}`, message });
      }
    }
  }
  return sites;
}

/** 规格表：逐行抄自 `docs/games/doudizhu.md` §11.1（`design.md` §11.2 只定义码义）。 */
const SPEC_ROWS: ReadonlyArray<{ message: string; code: ErrCode; basis: string }> = [
  { message: 'Not your turn', code: ErrCode.NOT_YOUR_TURN, basis: '§11.1 非当前回合玩家操作' },
  { message: 'Not your turn to bid', code: ErrCode.NOT_YOUR_TURN, basis: '§11.1 非当前叫抢者决策' },
  { message: 'Game is not in playing state', code: ErrCode.ILLEGAL_ACTION, basis: '§11.1 阶段不符' },
  { message: 'Game is not in bidding state', code: ErrCode.ILLEGAL_ACTION, basis: '§11.1 state !== bidding 时收到 game.bid' },
  { message: 'Cannot pass on the opening lead', code: ErrCode.ILLEGAL_ACTION, basis: '§6.2-2 / §11.1 首出过牌' },
  { message: 'Cannot pass when you last played', code: ErrCode.ILLEGAL_ACTION, basis: '§6.2-3 / §11.1 最后出牌者过牌' },
  { message: 'Card 7 not in hand', code: ErrCode.ILLEGAL_ACTION, basis: '§6.1-2 / §11.1 牌不在手中（N16：原为 13006）' },
  { message: 'Invalid move - cannot beat last hand', code: ErrCode.INVALID_CARDS, basis: '§6.1-3 / §11.1 压不过上一手（N16：原为 13001）' },
  { message: '不支持的牌型: 3,4', code: ErrCode.INVALID_CARDS, basis: '§4.3 / §11.1 牌型非法' },
  { message: '不能出空牌', code: ErrCode.INVALID_CARDS, basis: '§4.3 非法牌组（空手出牌应走 game.pass）' },
  { message: 'Player p1 not found', code: ErrCode.NOT_IN_ROOM, basis: '§5.3 身份映射' },
  { message: 'Invalid DouZero card int: 99', code: ErrCode.INVALID_CARDS, basis: '防御：牌值不在 DouZero 值域（当前不可达）' },
  { message: 'Game not finished', code: ErrCode.ILLEGAL_ACTION, basis: '内部前置：结算前必须已有胜负（不可达）' },
  { message: 'Player p1 has no card to play', code: ErrCode.ILLEGAL_ACTION, basis: '§9.1 兜底（不可能状态）' },
];

describe('规则引擎错误映射（N2/R164）', () => {
  it('规格闸：玩法 §11.1 的逐因映射逐行成立（N16 的两处错配已收敛）', () => {
    for (const row of SPEC_ROWS) {
      expect(classifyRuleError(new Error(row.message)), `${row.message}（${row.basis}）`).toBe(row.code);
    }
  });

  it('覆盖闸：shared/src/{ddz,rule} 的每一处 throw 都有映射', () => {
    const sites = collectThrowSites();
    // 探针：扫描器真的读到了代码，而不是「什么也没扫到」的恒真闸
    expect(sites.map((s) => s.file)).toEqual(
      expect.arrayContaining(['ddz/play.ts', 'ddz/bid.ts', 'ddz/settle.ts', 'rule/rule.ts']),
    );
    expect(sites.length).toBeGreaterThanOrEqual(12);
    for (const site of sites) {
      const hit = RULE_ERROR_MAPPINGS.find((m) => m.pattern.test(site.message));
      expect(hit, `${site.file} 的 throw「${site.message}」没有任何映射（新增 throw 必须同步加映射）`).toBeDefined();
    }
  });

  it('探针判别力：扫描器支持模板字面量，且未映射的文本确实不被任何 pattern 命中（R150/R171①）', () => {
    // 正对照：模板字面量必须被扫到（只匹配 '…' 的写法会漏掉 play.ts 里最关键的几条）
    expect(scanThrows('throw new Error(`Card ${c} not in hand`);')).toEqual(['Card  not in hand']);
    expect(scanThrows("throw new Error('Not your turn');")).toEqual(['Not your turn']);
    // 负对照：闸门对**未映射**的文本给出 undefined（否则覆盖闸也是恒真）
    expect(RULE_ERROR_MAPPINGS.find((m) => m.pattern.test('definitely-unmapped-message'))).toBeUndefined();
    // 兜底仍必须是契约内的码，而不是 500
    expect(classifyRuleError(new Error('definitely-unmapped-message'))).toBe(ErrCode.ILLEGAL_ACTION);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/game-service test -- rule-error-mapping`
Expected: FAIL —— `Cannot find module '../src/game/rule-error.mapping'`

- [ ] **Step 3: 建映射表文件（把 `game.service.ts:393-414` 的映射搬过来并修正 N16 两行）**

新建 `packages/game-service/src/game/rule-error.mapping.ts`：

```ts
// packages/game-service/src/game/rule-error.mapping.ts
import { ErrCode } from '@fight-the-landlord/protocol';

export interface RuleErrorMapping {
  /** 匹配规则引擎抛出的**原始文本**（§11.4 的别名表：规则引擎抛字符串，偏差 E5）。 */
  readonly pattern: RegExp;
  readonly code: ErrCode;
  /** 这条映射的规格依据（给评审与机械闸读；机械闸见 test/rule-error-mapping.test.ts）。 */
  readonly basis: string;
}

/**
 * 规则引擎错误 → 契约错误码的**唯一**映射表（N2 的「映射可枚举」）。
 *
 * **顺序即优先级**：越权/阶段判定必须排在牌型判定之前（§5.3），否则会把
 * 「不在你的回合」误判成「出牌不合法」。
 *
 * ⚠️ 每一行都有 `docs/games/doudizhu.md` §11.1 的逐因依据；新增 `throw` 时
 * **必须**在这里同步加一行，否则 `rule-error-mapping.test.ts` 的覆盖闸会红。
 * ⚠️ 别把「不是牌型错误」的文本写宽：`/not in hand/i` 与 `/cannot beat/i` 的方向
 * 在 N16 里被纠正过（前者 13001、后者 13006），改宽会一次性打回两条。
 */
export const RULE_ERROR_MAPPINGS: readonly RuleErrorMapping[] = [
  { pattern: /not your turn/i, code: ErrCode.NOT_YOUR_TURN, basis: '§5.3 / §11.1（含 Not your turn to bid）' },
  { pattern: /player .* not found/i, code: ErrCode.NOT_IN_ROOM, basis: '§5.3 身份映射' },
  {
    pattern: /not in playing state|not in bidding state|not started/i,
    code: ErrCode.ILLEGAL_ACTION,
    basis: '§11.1 阶段不符（state !== bidding 时收到 game.bid 等）',
  },
  { pattern: /cannot pass on the opening lead/i, code: ErrCode.ILLEGAL_ACTION, basis: '§6.2-2 首出过牌' },
  { pattern: /cannot pass when you last played/i, code: ErrCode.ILLEGAL_ACTION, basis: '§6.2-3 最后出牌者过牌' },
  { pattern: /has no card to play/i, code: ErrCode.ILLEGAL_ACTION, basis: '§9.1 兜底（不可能状态）' },
  { pattern: /not in hand/i, code: ErrCode.ILLEGAL_ACTION, basis: '§6.1-2 / §11.1 牌不在手中（N16）' },
  { pattern: /cannot beat/i, code: ErrCode.INVALID_CARDS, basis: '§6.1-3 / §11.1 压不过上一手（N16）' },
  { pattern: /不能出空牌/i, code: ErrCode.INVALID_CARDS, basis: '§4.3 非法牌组' },
  { pattern: /不支持的牌型/i, code: ErrCode.INVALID_CARDS, basis: '§4.3 / §11.1 牌型非法' },
  { pattern: /invalid douzero card/i, code: ErrCode.INVALID_CARDS, basis: '防御：牌值不在 DouZero 值域（当前不可达）' },
  { pattern: /game not finished/i, code: ErrCode.ILLEGAL_ACTION, basis: '内部前置：结算前必须已有胜负（不可达）' },
];

/**
 * 规则引擎抛的是字符串（偏差 E5），这里是**唯一**的映射实现（§11.2）。
 * 未识别的错误按「操作非法」处理，而不是悄悄变成 500。
 */
export function classifyRuleError(err: unknown): ErrCode {
  const message = err instanceof Error ? err.message : String(err);
  for (const mapping of RULE_ERROR_MAPPINGS) {
    if (mapping.pattern.test(message)) return mapping.code;
  }
  return ErrCode.ILLEGAL_ACTION;
}
```

- [ ] **Step 4: `game.service.ts` 改 import 并删掉旧映射**

- 删除文件末尾的 `classifyRuleError` 函数（第 393–414 行整段）与它的注释块；
- 顶部加 `import { classifyRuleError } from './rule-error.mapping';`；
- `applyAction` 里的调用点（第 245 行）不变。

`packages/game-service/test/game.service.test.ts`：
- 第 3 行的 import 去掉 `classifyRuleError`（只留 `GameService`）；
- 新增 `import { classifyRuleError } from '../src/game/rule-error.mapping';`
- 第 123–124 行的期望值按 N16 互换：

```ts
    expect(classifyRuleError(new Error('Invalid move - cannot beat last hand'))).toBe(13006);
    expect(classifyRuleError(new Error('Card 99 not in hand'))).toBe(13001);
```

（第 125–127 行不动：`不能出空牌` → `13006`、`Game is not in playing state` → `13001`、未知文本 → `13001`。）

- [ ] **Step 5: 跑测试确认通过**

Run:
```bash
pnpm exec turbo run test lint --force
```
Expected: 全绿。若 lint 报 `classifyRuleError` 未使用或重复声明，说明第 4 步没删干净。

- [ ] **Step 6: 提交**

```bash
git add packages/game-service/src/game/rule-error.mapping.ts packages/game-service/src/game/game.service.ts \
        packages/game-service/test/rule-error-mapping.test.ts packages/game-service/test/game.service.test.ts
git commit -m "refactor(game-service): 规则引擎错误映射可枚举 + 覆盖/规格双闸，修正两处方向相反的错配（N2/N16, R164）"
```

---

## Task 6: 前端 —— 选牌 / 出牌 / 过牌 / 倒计时的接线判据（R165）

**Files:**
- Create: `apps/client/test/table-play-ui.test.ts`
- Modify: `apps/client/src/pages/table.vue`（**预期零改动**；只有在用例暴露真实缺陷时才改，且必须在汇报里写清改了什么、为什么）

**Interfaces:**
- Consumes: `table.vue` 的稳定 class `.table__play` / `.table__pass`（R107 已建立）、`store.actorSeat`、`store.isMyTurn`、`store.deadlineAt`、`useCountdown`
- Produces: 无可复用代码（本片前端交付的是**判据**）

- [ ] **Step 1: 建用例文件（夹具约束先读 `test/helpers/fake-socket.ts`）**

```ts
/**
 * 切片 9：出牌/过牌 UI 的**接线**（§12 F01/F06/F10 + R165）。
 *
 * 判别力说明：这里**不**断言任何规则（什么牌能出、能不能过、牌型是什么），
 * 那些是服务端的。只断言五件事：
 *  ① 不是我的回合 ⇒ 两个按钮 `disabled`（断言属性本身，R115：jsdom 里点 disabled 是静默 no-op）；
 *  ② 选牌后可点，点击发 `game.play`，载荷是选中的 **DouZero 值**、`baseVersion` = 已应用版本；
 *  ③ 点击发 `game.pass`，载荷为 `{}`；
 *  ④ 倒计时以服务端 `turnDeadlineAt` 为基准，到 0 **不**动任何按钮、**不**发任何请求（F06）；
 *  ⑤ **F01 判别力**：首出（`lastPlayedHand === null`）时过牌按钮**不得**被禁用 ——
 *     「首出不能过牌」是规则，由服务端判 `13001`；前端若自行禁用，这条立刻红。
 *
 * ⚠️ 夹具约束（读 `helpers/fake-socket.ts` + `protocol/validate.ts` 后收敛的）：
 *  1. `playerViewFixture` 只做**顶层**覆盖，`bidPhase` 这类嵌套对象**整体替换、不合并**；
 *  2. `validateInbound` 逐张校验牌值（只允许 3–14 / 17 / 20 / 30）且强制
 *     `hand.length === cardCounts[seat]`；
 *  3. `game.play`/`game.pass` 是 CAS 消息：ack 0 之后串行队列要等 `game.state_update`
 *     把 version 推过 `baseVersion` 才释放（§6.5/R112）⇒ 「一次 mount 里连点两次」发不出第二个请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PlayerView } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table.vue';
import { FakeSocket, playerViewFixture, serverMessage } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  stopGameSession();
});

function bidPhase(over: Partial<PlayerView['bidPhase']> = {}): PlayerView['bidPhase'] {
  return { currentBidder: 0, bidMultiplier: 1, landlordCandidate: -1, grabActions: 0, redealCount: 0, ...over };
}

/** 出牌阶段的合法手牌：17 张、全部是合法 DouZero 值。 */
const PLAYING_HAND = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30, 3, 4];

/** `playerViewFixture` 的 `...over` 是**顶层覆盖**，`bidPhase` 必须整份给出（R171 / 切片 8 教训 3）。 */
function playingView(over: Partial<PlayerView> = {}): PlayerView {
  return playerViewFixture({
    state: 'playing',
    version: 2,
    landlordSeat: 0,
    bottomCards: [3, 4, 5],
    hand: PLAYING_HAND,
    lastPlayedHand: { cards: [20], type: 1, keyRank: 20, length: 0 },
    lastPlayerIdx: 0,
    bidPhase: bidPhase(),
    ...over,
  });
}

function mountTable(opts: { mySeat: number }) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', opts.mySeat);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}

describe('table.vue 的出牌/过牌 UI（R165）', () => {
  it('不是我的回合时两个按钮都禁用（断言 disabled 属性本身，R115）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 1 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 1, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    expect(store.isMyTurn).toBe(false);
    expect(wrapper.find('.table__play').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.table__pass').attributes('disabled')).toBeDefined();
  });

  it('轮到我且已选牌时可点，点击发 game.play（DouZero 值 + baseVersion = 已应用版本）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    // 未选牌 ⇒ 出牌禁用（否则会发出空牌，服务端只能回 13006）
    expect(wrapper.find('.table__play').attributes('disabled')).toBeDefined();

    /**
     * ⚠️ 选择器必须**限定在我方选牌区** `.table__me`：牌桌中间还渲染了两手**不可交互**的牌
     * （上一手 `.table__middle` + 底牌），`.card` 会先命中它们。
     */
    const myCards = wrapper.findAll('.table__me .card');
    expect(myCards).toHaveLength(PLAYING_HAND.length);
    await myCards[0]!.trigger('click'); // 手牌第一张是 DouZero 值 3
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__play').attributes('disabled')).toBeUndefined();

    await wrapper.find('.table__play').trigger('click');

    const sent = socket.emittedOf('game.play');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.env.payload).toEqual({ cards: [3] });
    expect(sent[0]!.env.baseVersion).toBe(2);
  });

  it('点击过牌发 game.pass，载荷为空对象', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    await wrapper.find('.table__pass').trigger('click');

    const sent = socket.emittedOf('game.pass');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.env.payload).toEqual({});
    expect(sent[0]!.env.baseVersion).toBe(2);
  });

  /**
   * F01 / R165⑤：首出（`lastPlayedHand === null`）时过牌**是服务端要拒绝的动作**，
   * 前端**不得**替服务端判断合法性（若「好心」禁用，这条立刻红）。
   */
  it('首出时过牌按钮不禁用，点击照发 game.pass（合法性归服务端，F01）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({ seat: 0, currentPlayer: 0, lastPlayedHand: null, lastPlayerIdx: -1 }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    const pass = wrapper.find('.table__pass');
    expect(pass.exists()).toBe(true);
    expect(pass.attributes('disabled'), '首出时前端不得自行禁用过牌（那是规则，属服务端）').toBeUndefined();

    await pass.trigger('click');
    expect(socket.emittedOf('game.pass')).toHaveLength(1);
  });

  it('倒计时以服务端 turnDeadlineAt 为基准；到 0 不动按钮、不发任何请求（F06）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00.000Z'));

    const { wrapper, socket } = mountTable({ mySeat: 0 });
    const deadline = Date.now() + 5000;
    socket.push(
      serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, turnDeadlineAt: deadline }), 2),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__me-head .seat__timer').text()).toBe('5s');

    await vi.advanceTimersByTimeAsync(3000);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__me-head .seat__timer').text()).toBe('2s');

    await vi.advanceTimersByTimeAsync(3000); // 越过 deadline
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__me-head .seat__timer').text()).toBe('0s');
    // F06：本地时间不参与规则判定 —— 到点后前端既不替服务端发动作，也不改按钮可用性
    expect(socket.emitted).toHaveLength(0);
    expect(wrapper.find('.table__play').attributes('disabled')).toBeDefined(); // 仍在「未选牌」态
    expect(wrapper.find('.table__pass').attributes('disabled')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `cd apps/client && pnpm test -- table-play-ui`
Expected: PASS（**预期模板零改动**）。若某条红，先判断它暴露的是**真实缺陷**还是夹具写错（`bidPhase` 整体替换、牌值必须合法、CAS 不释放队列 —— 三条都在文件头上写着）；真实缺陷才动 `table.vue`，并在汇报里单列。

- [ ] **Step 3: 全量前端回归**

Run:
```bash
cd apps/client && pnpm test && pnpm lint && pnpm build
```
Expected: 三绿（`vue-tsc --noEmit` 干净；既有 142 项不回归）。

- [ ] **Step 4: 提交**

```bash
git add apps/client/test/table-play-ui.test.ts apps/client/src/pages/table.vue
git commit -m "test(client): 出牌/过牌/倒计时的接线判据 + 首出过牌不得本地禁用（R165/F01）"
```

---

## Task 7: 前端 —— 被服务端踢线后不再自动重连（N15/R166）

**Files:**
- Modify: `apps/client/src/net/socket.ts`（`ReconnectReason`、`attachSocket` 的 disconnect 分支、`lastServerErrorCode`、`serverRejected`、`handleSocketReconnect`）
- Modify: `apps/client/src/composables/useGameSession.ts`（`onReconnect` 的 `server_rejected` 分支）
- Create: `apps/client/test/connection-rejected.test.ts`

**Interfaces:**
- Produces: `ReconnectReason['kind']` 增加 `'server_rejected'`
- Consumes: `ErrCode.RATE_LIMITED`（`10006`）、`FakeSocket.emitDisconnect(reason)` / `emitConnect()` / `emittedOf()`

- [ ] **Step 1: 写失败用例（必须含 `transport close` 正对照）**

新建 `apps/client/test/connection-rejected.test.ts`：

```ts
/**
 * N15 / R166：**被服务端踢线**（§5.4 的单 IP 并发连接上限 5）之后不得自动重连，
 * 并且要给出明确文案。
 *
 * 事实（R152 实测）：socket.io 服务端在握手**之后**拒绝时，客户端观察到的序列是
 *   `connect` → `system.error {10006}` → `disconnect(reason = 'io server disconnect')`，
 * **不是** `connect_error`。因此：
 *  - **终止依据是 disconnect 的 reason**，不是错误码；
 *  - `system.error{10006}` 只决定**文案**（HTTP 维度的限流也返回 10006，那时链路是好的、
 *    必须继续自动重连）。
 *
 * ⚠️ R171②：断言「没有发 game.reconnect」之前，必须先证明探针**能观测到发生** ——
 * 本文件第 1 条就是那个正对照（`transport close` ⇒ 重连照常发出）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGameSession, type GameSession, type SessionNotice } from '../src/net/session';
import type { ReconnectReason } from '../src/net/socket';
import { FakeSocket, serverMessage } from './helpers/fake-socket';

let socket: FakeSocket;
let session: GameSession;
let notices: SessionNotice[];
let reasons: ReconnectReason[];

function boot(): void {
  socket = new FakeSocket();
  notices = [];
  reasons = [];
  session = createGameSession({
    socketFactory: () => socket,
    currentVersion: () => 5,
    applySnapshot: () => {},
    applyEvent: () => {},
    onRoomMatched: () => {},
    onRoomState: () => {},
    onRefreshSnapshot: () => {},
    onReconnect: (reason) => reasons.push(reason),
    onNotice: (notice) => notices.push(notice),
  });
  socket.emitConnect(); // 首次连接（hasConnected 之前）
}

beforeEach(() => boot());
afterEach(() => session.disconnect());

describe('N15：服务端踢线后的重连处置（R166）', () => {
  /** 正对照：链路自己断了（transport close）⇒ 重连必须照常发生（探针判别力）。 */
  it('正对照：transport close 后 socket 重连 ⇒ 仍发 game.reconnect', async () => {
    socket.emitDisconnect('transport close');
    socket.emitConnect();

    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
  });

  it('io server disconnect（收到过 10006）⇒ 不再自动重连，且给出明确文案', async () => {
    socket.push(serverMessage('system.error', { code: 10006, message: 'too many connections from this IP' }, 0));
    socket.emitDisconnect('io server disconnect');

    expect(reasons.map((r) => r.kind)).toEqual(['server_rejected']);
    expect(reasons[0]!.message).toContain('10006');
    expect(reasons[0]!.message).toContain('已停止自动重连');
    expect(notices.some((n) => n.level === 'error' && n.text.includes('已停止自动重连'))).toBe(true);

    // 即使之后又收到 connect（手动重连/底层重建），也不得再发 game.reconnect
    socket.emitConnect();
    await Promise.resolve();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(0);
  });

  it('io server disconnect 但**没有** 10006 ⇒ 同样终止恢复（依据是 reason，不是码）', () => {
    socket.emitDisconnect('io server disconnect');

    expect(reasons.map((r) => r.kind)).toEqual(['server_rejected']);
    expect(reasons[0]!.message).not.toContain('10006');
  });

  it('10006 之后是 transport close ⇒ **仍然**自动重连（HTTP 维度的限流不影响链路恢复）', async () => {
    socket.push(serverMessage('system.error', { code: 10006, message: 'rate limited' }, 0));
    socket.emitDisconnect('transport close');
    socket.emitConnect();

    expect(reasons).toHaveLength(0); // 没有终止信号
    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/client && pnpm test -- connection-rejected`
Expected: FAIL —— 第 2/3 条拿不到 `server_rejected`（`ReconnectReason` 里还没有这个 kind，`disconnect` 仍走不读 reason 的旧分支）。

- [ ] **Step 3: `socket.ts` 实现**

① `ReconnectReason` 的 kind 联合里加一项（放在 `version_rollback` 之后）：

```ts
    | 'server_rejected'
```

② 类字段：

```ts
  /** 最近一条 `system.error` 的码；只用来决定「被踢线」的文案（R166）。 */
  private lastServerErrorCode: number | null = null;
  /**
   * 服务端**主动断开**过本连接（`io server disconnect`）⇒ 终止本会话的自动恢复。
   *
   * 这是 N15 的前端半边：socket.io 客户端本身对被服务端踢下线**不会**自动重连，
   * 但我们的 `game.reconnect` 恢复流程仍会被后续的 `connect` 事件触发 —— 那会进入
   * 「连上即被踢」的循环。置位后 `handleSocketReconnect()` 直接早退。
   * 恢复路径是**用户动作**（关闭其它窗口后重新进入 / 刷新页面），不是自动重试。
   */
  private serverRejected = false;
```

③ `attachSocket` 的两处：

```ts
    this.socket.on('disconnect', (...args: unknown[]) => {
      this.handleSocketDisconnect(typeof args[0] === 'string' ? args[0] : undefined);
    });
```

```ts
    this.socket.on('connect', () => {
      const isReconnect = this.hasConnected;
      this.hasConnected = true;
      // 新连接作废上一条错误码：它只用于解释**紧接着**的那次断开（R166）。
      this.lastServerErrorCode = null;
      if (!isReconnect || this.destroyed) return;
      void this.handleSocketReconnect();
    });
```

④ `handleServerMessage` 里记录错误码（放在 `validateInbound` 之后、分发之前）：

```ts
    if (msg.type === 'system.error') {
      this.lastServerErrorCode = (msg.payload as { code: number }).code;
    }
```

⑤ 新增私有方法（放在 `handleSocketReconnect` 之前）：

```ts
  /**
   * socket 断开的统一入口（M06：先释放在途请求，避免 UI 永久 loading）。
   *
   * R166：`io server disconnect` = **服务端主动踢线**（§5.4 的并发连接上限就是这条通道）。
   * 此时置 `serverRejected` 并发出一条 `server_rejected` 信号：
   *  - 信号**不是**为了导航（`useGameSession` 对它只提示、不导航），而是让 UI 有明确文案；
   *  - 终止恢复的依据是 **reason**，`system.error{10006}` 只决定文案 ——
   *    HTTP 维度的限流同样是 `10006`，那时链路是好的、必须继续自动重连。
   */
  private handleSocketDisconnect(reason?: string): void {
    this.releasePendingAndWakeWaiters();
    if (reason !== 'io server disconnect') return;

    this.serverRejected = true;
    const code = this.lastServerErrorCode;
    const head = code === null ? '服务端主动断开了连接' : `服务端拒绝该连接（code=${code}）`;
    const tail =
      code === ErrCode.RATE_LIMITED
        ? '：同一 IP 的并发连接数已达上限（§5.4 为 5），已停止自动重连；请关闭其它窗口或设备后重新进入'
        : '：已停止自动重连';
    this.emitReconnect({ kind: 'server_rejected', version: this.currentVersion, message: `${head}${tail}` });
  }
```

⚠️ 顶部 import 里加 `ErrCode`（与 `CAS_MESSAGES` 同一个 `@fight-the-landlord/protocol` import 语句）。

⑥ `handleSocketReconnect` 开头加早退：

```ts
  private async handleSocketReconnect(): Promise<void> {
    // R166：服务端踢过线就**不再**自动恢复（否则会进入 connect/kick 循环）。
    if (this.serverRejected) return;
    if (this.reconnectInFlight) return;
    // …其余原样
```

- [ ] **Step 4: `useGameSession.ts` 的提示分支**

```ts
    onReconnect: (reason: SessionReconnectReason) => {
      /**
       * R166 / N15：`server_rejected` 是**终止性**信号（服务端踢线）——
       * 只给明确提示，**不导航**：回到牌桌只会得到一张连不上的桌子。
       */
      if (reason.kind === 'server_rejected') {
        notice.value = { level: 'error', text: reason.message };
        return;
      }
      notice.value = { level: 'warn', text: reason.message };
      // …其余原样（snapshot_unavailable 早退 + canShowTable 守卫）
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/client && pnpm test -- connection-rejected`
Expected: PASS（4 条）

- [ ] **Step 6: 全量前端回归**

Run:
```bash
cd apps/client && pnpm test && pnpm lint && pnpm build
```
Expected: 三绿（尤其 `reconnect-flow.test.ts` / `snapshot-version.test.ts` / `error-disposition.test.ts` 不回归 —— 它们覆盖 `transport close` 与快照回退两条路径）。

- [ ] **Step 7: 提交**

```bash
git add apps/client/src/net/socket.ts apps/client/src/composables/useGameSession.ts \
        apps/client/test/connection-rejected.test.ts
git commit -m "fix(client): 被服务端踢线后终止自动重连并给出明确提示（N15, R166）"
```

---

## Task 8: conformance `slice-09`（协调者，R168）

**Files:**
- Create: `tools/conformance/src/slices/slice-09-play-rotation.ts`
- Modify: `tools/conformance/src/run.ts:18-43`
- Modify: `tools/conformance/package.json`（scripts）

**Interfaces:**
- Consumes: 后端 Task 1–5 的语义；`toInternalRank`（`@fight-the-landlord/protocol`）；`HarnessClient` / `Checks` / `registerUser`
- Produces: `runSlice09(): Promise<Checks>`，注册为 `slice-09`

- [ ] **Step 1: 写用例（三个场景；**不得** import `@fight-the-landlord/shared`）**

```ts
/**
 * 切片 9 conformance：出牌轮转（玩法 §4.1/§5/§6/§7/§9.1/§11.1 + 主规格 §6.4）。
 *
 * 三个场景：
 *  A（地主赢）—— 地主每墩首出最大单张、两农民过牌 ⇒ 20 墩后地主手牌为 0；
 *    同时逐手钉住 `lastPlayedHand` 的口径（C19 的在线判据）。
 *  B（农民赢）—— **C16 的唯一判据**：地主首出最小单张，能压过它的那位农民用**最小的可压单张**
 *    压过，随后该农民每墩首出最小单张、另两家过牌 ⇒ 17 墩后该农民手牌为 0 ⇒ 农民胜。
 *    旧实现（`farmers.every`）在这里**不结束对局** ⇒ 本用例超时红。
 *  C（C18 反例）—— 首出时过牌 ⇒ 13001，且被拒的动作不推进 version/currentPlayer；
 *    随后正常出牌成功 ⇒ 房间没被弄死。
 *
 * ⚠️ 驱动只用手牌 + 单张点数（`toInternalRank`，§10 的值映射）算动作，
 * **不** import `@fight-the-landlord/shared` 的 `parseHand`/`canBeat` —— 那等于拿被测实现当裁判。
 * ⚠️ R155：三个场景是三个房间（同一 IP 的并发 WS 上限 5）⇒ 开新房前先关掉上一房并 `sleep(400)`。
 * ⚠️ R156：`startFreshRoom` 抛出前必须 `close()` 已连上的客户端，否则事件循环被吊住。
 */
import { ErrCode, toInternalRank } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import { registerUser } from '../lib/http';
import { HarnessClient } from '../lib/client';

interface LastPlayedHandWire { cards: number[]; type: number; keyRank: number; length: number }

interface PlayViewWire {
  roomCode: string; version: number; state: 'init' | 'bidding' | 'playing' | 'ended';
  seat: number; hand: number[]; cardCounts: [number, number, number];
  bottomCards: number[] | null; landlordSeat: number | null;
  currentPlayer: number; lastPlayerIdx: number; lastPlayedHand: LastPlayedHandWire | null;
  playPhase: { bombCount: number }; turnDeadlineAt: number;
  bidPhase: { currentBidder: number; bidMultiplier: number; landlordCandidate: number; grabActions: number; redealCount: number };
}

const STEP_TIMEOUT_MS = 8000;
const MATCH_TIMEOUT_MS = 25_000;
const MAX_TRICKS = 30;

interface FreshRoom {
  roomCode: string; clients: HarnessClient[];
  bySeat: Map<number, HarnessClient>; deals: PlayViewWire[];
}
```

`startFreshRoom(labelPrefix)` 与 `currentView()` / `waitForVersion()` / `waitForNewerVersion()` **照抄 `slice-08-bidding.ts` 的同名实现**（含 catch 里 `client.close()`），只把 `PlayerViewWire` 换成 `PlayViewWire`。再新增三个驱动原语：

```ts
/** 等三家都拿到**同一个** version（deterministic baseVersion 的来源）。 */
async function syncAll(room: FreshRoom, version: number): Promise<void> {
  await Promise.all(room.clients.map((c) => waitForVersion(c, version)));
}

/** 打出一手并等三家同步到新版本；返回新版本。`payload` 已是 DouZero 值。 */
async function playAndSync(
  room: FreshRoom, actor: HarnessClient, cards: number[], checks: Checks, what: string,
): Promise<PlayViewWire> {
  const before = currentView(actor);
  const ack = await actor.send('game.play', { cards }, before.version);
  checks.eq(ack.code, ErrCode.OK, `${what}（seat ${before.seat}）`);
  const next = await waitForNewerVersion(actor, before.version);
  await syncAll(room, next.version);
  return next;
}

/** 过牌并等三家同步到新版本。 */
async function passAndSync(
  room: FreshRoom, actor: HarnessClient, checks: Checks, what: string,
): Promise<PlayViewWire> {
  const before = currentView(actor);
  const ack = await actor.send('game.pass', {}, before.version);
  checks.eq(ack.code, ErrCode.OK, `${what}（seat ${before.seat}）`);
  const next = await waitForNewerVersion(actor, before.version);
  await syncAll(room, next.version);
  return next;
}

/**
 * 出**终局手**（把手里最后一张打完）。
 *
 * ⚠️ 这一手**不会**有 `game.state_update`：§7 的结束路径在 `finishTransition` 里直接
 * `saveSession` + `publishEnded`（只发 `game.ended` ⇒ 客户端收到 `game.finished` + `game.settlement`），
 * **不**走 `publishSeatViews`。因此终局手**必须**等 `game.finished`，用 `playAndSync`
 * 等「更新版本」会白等 8 秒然后超时（这是本计划初稿的缺陷，执行期修正）。
 */
async function playFinalHand(
  actor: HarnessClient, cards: number[], checks: Checks, what: string,
): Promise<'landlord' | 'farmer'> {
  const before = currentView(actor);
  const ack = await actor.send('game.play', { cards }, before.version);
  checks.eq(ack.code, ErrCode.OK, `${what}（终局手，seat ${before.seat}）`);
  const finished = await actor.waitFor('game.finished', STEP_TIMEOUT_MS);
  return finished.payload.winner as 'landlord' | 'farmer';
}

/** 只手牌 + 单张点数（§10 的值映射），不碰规则引擎。 */
function smallestBeatingSingle(hand: number[], lead: number): number | null {
  const target = toInternalRank(lead);
  const candidates = hand.filter((c) => toInternalRank(c) > target)
    .sort((a, b) => toInternalRank(a) - toInternalRank(b));
  return candidates[0] ?? null;
}

/** C19 的在线判据：单张的 `lastPlayedHand` 必须是内部 Rank 口径 + §4.1 的 length=0。 */
function checkSingleCaliber(view: PlayViewWire, played: number, violations: string[]): void {
  const lph = view.lastPlayedHand;
  const where = `v${view.version}`;
  if (!lph) return violations.push(`${where}: lastPlayedHand 为 null，但刚打出一张牌`);
  if (lph.cards.length !== 1) violations.push(`${where}: cards 应为 1 张，实际 ${JSON.stringify(lph.cards)}`);
  if (lph.type !== 1) violations.push(`${where}: 单张的 type 应为 1，实际 ${lph.type}`);
  if (lph.length !== 0) violations.push(`${where}: 单张的 length 应为 0，实际 ${lph.length}`);
  if (lph.keyRank !== toInternalRank(played)) {
    violations.push(`${where}: keyRank 应为内部 Rank ${toInternalRank(played)}，实际 ${lph.keyRank}（DouZero 口径？C19）`);
  }
}
```

`runSlice09()` 主体（**带步骤选择器，理由见 Step 3**）：

```ts
/** 步骤 id：`a`=地主赢 · `b`=农民赢 · `c`=首出过牌反例。 */
const ALL_STEPS = ['a', 'b', 'c'] as const;
type StepId = (typeof ALL_STEPS)[number];

/**
 * 步骤选择器 `CONFORMANCE_STEPS`（默认=全部）。
 *
 * `run.js` 是 **fail-fast**：一次跑只暴露**第一条**失败的断言，而本片有三个独立的
 * 判别点（C16 / C18 / C20）需要各自的 RED 原文 ⇒ 负对照必须能逐步取。
 * **门禁 / 最终判定一律不带该环境变量。** 未列出的 id 直接抛错（手误不能被当成「筛过了」）。
 */
function selectedSteps(): Set<StepId> {
  const raw = process.env.CONFORMANCE_STEPS;
  if (!raw) return new Set(ALL_STEPS);
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !(ALL_STEPS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new ConformanceError(`CONFORMANCE_STEPS 里有未知步骤：${unknown.join(', ')}（合法值：${ALL_STEPS.join(',')}）`);
  }
  return new Set(ids as StepId[]);
}

export async function runSlice09(): Promise<Checks> {
  const checks = new Checks();
  const rooms: FreshRoom[] = [];
  const steps = selectedSteps();

  try {
    if (steps.has('a')) {
      // ── 场景 A：地主赢（§6.2-5 的出牌权回归 + C19/C20 口径）────────────
      step('场景 A：地主每墩首出最大单张，两农民过牌 ⇒ 20 墩打到地主胜');
      const roomA = await startFreshRoom('A');
      rooms.push(roomA);
      await playBiddingToPlaying(roomA, checks);
      const landlordSeat = currentView(roomA.clients[0]!).landlordSeat;
      if (landlordSeat === null) throw new ConformanceError('场景 A：进入 playing 后 landlordSeat 仍为 null');
      const landlord = roomA.bySeat.get(landlordSeat)!;
      const farmersA = roomA.clients.filter((c) => c !== landlord);
      const caliberViolations: string[] = [];
      let tricks = 0;

      for (let i = 0; i < MAX_TRICKS; i += 1) {
        const view = currentView(landlord);
        if (view.hand.length === 0) break;
        const card = view.hand.reduce((m, c) => (toInternalRank(c) > toInternalRank(m) ? c : m), view.hand[0]!);
        if (view.hand.length === 1) {
          // 终局手：不会有 state_update，等 game.finished（见 playFinalHand 的注释）
          const winner = await playFinalHand(landlord, [card], checks, `地主第 ${i + 1} 墩首出单张`);
          checks.eq(winner, 'landlord', '地主出完最后一张 ⇒ game.finished{landlord}');
          tricks += 1;
          break;
        }
        const played = await playAndSync(roomA, landlord, [card], checks, `地主第 ${i + 1} 墩首出单张`);
        checkSingleCaliber(played, card, caliberViolations);
        tricks += 1;
        for (const farmer of farmersA) {
          await passAndSync(roomA, farmer, checks, `${farmer.label} 过牌`);
        }
      }

      const finishedA = await landlord.waitFor('game.finished', STEP_TIMEOUT_MS);
      checks.eq(finishedA.payload.winner, 'landlord', '地主出完 20 张 ⇒ game.finished{landlord}');
      checks.eq(tricks, 20, '地主恰好用了 20 墩（每墩 1 张，无卡死）');
      checks.eq(caliberViolations, [], '每一手 lastPlayedHand 的口径（keyRank=内部 Rank / length=0 / type=1，C19/C20）');
      const settledA = await landlord.waitFor('game.settlement', STEP_TIMEOUT_MS);
      checks.eq(settledA.payload.winner, 'landlord', 'game.settlement 的 winner');
      info(
        `场景 A 出现过的牌值：${JSON.stringify([...new Set(roomA.clients.flatMap((c) => (c.last('game.deal')?.payload?.hand ?? []) as number[]))].sort((x, y) => x - y))}`,
      );

      // 局终后再操作 ⇒ 13005（不是 0、也不是 500）
      const afterEnd = await landlord.send('game.play', { cards: [3] }, currentView(landlord).version);
      checks.eq(afterEnd.code, ErrCode.GAME_OVER, 'ended 后再出牌 ⇒ 13005');

      // R155：换房前先关客户端并静置，等 disconnect 的 ZREM 落地
      for (const client of roomA.clients) client.close();
      await sleep(400);
    }

    if (steps.has('b')) {
      // ── 场景 B：农民赢（C16 的唯一判据）──────────────────────────────
      step('场景 B：地主首出最小单张 → 某农民压过并连打 ⇒ 农民胜（C16）');
      const roomB = await startFreshRoom('B');
      rooms.push(roomB);
      await playBiddingToPlaying(roomB, checks);
      const landlordSeatB = currentView(roomB.clients[0]!).landlordSeat!;
      const landlordB = roomB.bySeat.get(landlordSeatB)!;
      const farmersB = roomB.clients.filter((c) => c !== landlordB);

      const lead = Math.min(...currentView(landlordB).hand.map((c) => toInternalRank(c)));
      const leadCard = currentView(landlordB).hand.find((c) => toInternalRank(c) === lead)!;
      await playAndSync(roomB, landlordB, [leadCard], checks, '地主首出最小单张');

      const beater = farmersB.find((f) => smallestBeatingSingle(currentView(f).hand, leadCard) !== null);
      if (!beater) {
        throw new ConformanceError(`场景 B：两名农民都压不过地主的最小单张 ${leadCard}（概率极低）—— 重跑该切片`);
      }
      const beatCard = smallestBeatingSingle(currentView(beater).hand, leadCard)!;
      await playAndSync(roomB, beater, [beatCard], checks, '农民用最小的可压单张压过');

      const otherFarmer = farmersB.find((f) => f !== beater)!;
      await passAndSync(roomB, landlordB, checks, '地主过牌');
      await passAndSync(roomB, otherFarmer, checks, '另一农民过牌');

      const caliberViolationsB: string[] = [];
      let farmerTricks = 0;
      for (let i = 0; i < MAX_TRICKS; i += 1) {
        const view = currentView(beater);
        if (view.hand.length === 0) break;
        const card = view.hand.reduce((m, c) => (toInternalRank(c) < toInternalRank(m) ? c : m), view.hand[0]!);
        if (view.hand.length === 1) {
          // 终局手：不会有 state_update，等 game.finished（C16 的判别点就在这里）
          const winner = await playFinalHand(beater, [card], checks, `农民第 ${i + 1} 墩首出单张`);
          checks.eq(winner, 'farmer', '任一农民出完牌 ⇒ 农民胜（C16；旧实现 every 会在这里超时红）');
          farmerTricks += 1;
          break;
        }
        const played = await playAndSync(roomB, beater, [card], checks, `农民第 ${i + 1} 墩首出单张`);
        checkSingleCaliber(played, card, caliberViolationsB);
        farmerTricks += 1;
        await passAndSync(roomB, landlordB, checks, '地主过牌');
        await passAndSync(roomB, otherFarmer, checks, '另一农民过牌');
      }

      const finishedB = await beater.waitFor('game.finished', STEP_TIMEOUT_MS);
      checks.eq(finishedB.payload.winner, 'farmer', '任一农民出完牌 ⇒ 农民胜（C16；旧实现 every 在此超时）');
      checks.eq(farmerTricks, 16, '压过那一手之后该农民恰好再首出 16 墩');
      checks.eq(caliberViolationsB, [], '场景 B 每一手的 lastPlayedHand 口径');
      const settledB = await beater.waitFor('game.settlement', STEP_TIMEOUT_MS);
      checks.eq(settledB.payload.winner, 'farmer', 'game.settlement 的 winner = farmer');
      checks.that(
        Array.isArray(settledB.payload.farmerSeats) && settledB.payload.farmerSeats.includes(currentView(beater).seat),
        `farmerSeats 含胜方座位：${JSON.stringify(settledB.payload.farmerSeats)}`,
      );

      for (const client of roomB.clients) client.close();
      await sleep(400);
    }

    if (steps.has('c')) {
      // ── 场景 C：C18 反例（首出不能过牌）──────────────────────────────
      step('场景 C：首出时 game.pass ⇒ 13001，且不推进状态；随后正常出牌成功（C18）');
      const roomC = await startFreshRoom('C');
      rooms.push(roomC);
      await playBiddingToPlaying(roomC, checks);
      const landlordC = roomC.bySeat.get(currentView(roomC.clients[0]!).landlordSeat!)!;
      const before = currentView(landlordC);
      checks.eq(before.lastPlayedHand, null, '场景 C 起点：首出（lastPlayedHand === null）');

      const badPass = await landlordC.send('game.pass', {}, before.version);
      checks.eq(badPass.code, ErrCode.ILLEGAL_ACTION, '首出过牌 ⇒ 13001（玩法 §6.2-2）');

      // R68：不能只用 waitFor 证明「没发生」—— 正向等一段静默窗再断言状态原封不动
      await sleep(300);
      const after = currentView(landlordC);
      checks.eq(after.version, before.version, '被拒的过牌不推进 version');
      checks.eq(after.currentPlayer, before.currentPlayer, '被拒的过牌不改 currentPlayer');

      const smallest = after.hand.reduce((m, c) => (toInternalRank(c) < toInternalRank(m) ? c : m), after.hand[0]!);
      const recovered = await playAndSync(roomC, landlordC, [smallest], checks, '首出被拒后仍能正常出牌');
      checks.eq(recovered.lastPlayedHand?.keyRank, toInternalRank(smallest), 'C19：keyRank 用内部 Rank');
    }

    info(`场景：${[...steps].join(',')} · 房间：${rooms.map((r) => r.roomCode).join(' / ')}`);
    return checks;
  } finally {
    for (const room of rooms) {
      for (const client of room.clients) client.close();
    }
  }
}
```

`playBiddingToPlaying(room, checks)`：照 `slice-08` 的「1 抢 + 2 不抢」写（第 1 位抢、后两位不抢；收口时断言 `state === 'playing'`），并 `assertNoLeak` 每一版 `PlayerView`。

- [ ] **Step 2: 注册**

`tools/conformance/src/run.ts`：`import { runSlice09 } from './slices/slice-09-play-rotation';`，并在 `CASES` 里加：

```ts
  'slice-09': { title: '出牌轮转（一局打到分出胜负）', run: runSlice09 },
```

`tools/conformance/package.json` 的 scripts 里加：

```json
    "conformance:slice-09": "node dist/run.js slice-09",
```

- [ ] **Step 3: 编译并跑（**负对照优先**：先在**未修**的当前栈上取 RED）**

```bash
pnpm --filter @fight-the-landlord/conformance build

# ① 负对照（当前 8 个容器就是**未含本片修复**的 master 镜像，别急着重建！）
#    run.js 是 fail-fast ⇒ 三个判别点要分开取（步骤选择器见文件头）
timeout 300 env CONFORMANCE_STEPS=c node tools/conformance/dist/run.js slice-09   # C18 期望 RED
timeout 300 env CONFORMANCE_STEPS=a node tools/conformance/dist/run.js slice-09   # C20/C19 期望 RED
timeout 300 env CONFORMANCE_STEPS=b node tools/conformance/dist/run.js slice-09   # C16 期望 RED（超时）

# ② 未知步骤 id 必须抛错（否则手误会被当成「筛过了」）
timeout 60 env CONFORMANCE_STEPS=zzz node tools/conformance/dist/run.js slice-09   # 期望 ❌ 未知步骤

# ③ 三条合跑（未修栈上**必须**红，且红在第一条断言）
timeout 300 node tools/conformance/dist/run.js slice-09
```

⚠️ **绿的那一刻在协调者合并之后**（本任务只交付用例 + 负对照证据）。别为了让它在未修栈上变绿而改弱判据 —— 那种「修法」比红更糟。

- [ ] **Step 4: 负对照（证明用例有判别力）**

在**未含**本片修复的镜像（当前 8 个容器就是）上按 Step 3 的 `CONFORMANCE_STEPS` 逐条取 RED 原文，写进计划文件的「执行期裁决」：

| 判别点 | 期望 RED | 说明 |
|---|---|---|
| **C20** | `每一手 lastPlayedHand 的口径…`：`单张的 length 应为 0，实际 1` | **确定性红**：旧 `view.builder` 写 `length: cards.length` |
| **C18** | `首出过牌 ⇒ 13001`：实际 `0` | 旧实现首出可以过牌（`code 0`），随后 `currentPlayer = -1` |
| **C16** | `等 game.finished 超时（8000ms）` | 旧 `farmers.every` 下农民出完牌对局不结束 |
| **C19** | `keyRank 应为内部 Rank 15，实际 17` | **只在真的打出 DouZero `17`（2）时才有分歧** —— 其余牌值两个口径恒等。因此：① 输出里已 `info` 打印本局出现过的牌值，**必须**据此说明这一跑有没有覆盖到 `2`；② **没红不等于 C19 有覆盖**，C19 的判别性主证据是 `shared/ddz/play.test.ts` 的「`2` 不能压 `2`」（R158） |
| **C5** | 场景 A 里若地主首出后**卡死**（不再有 `state_update`）⇒ 超时 | 出牌超时要在**真实 30s** 后才触发，conformance 不覆盖它；C5 的判别性主证据是 `game.timer.test.ts`（fake timers）。**不要把这条读成 e2e 覆盖**（对账表 §4 的同款声明） |

> ⚠️ 负对照要**先确认栈是未修的**（本片合并前取的镜像）；合并后重跑同一命令应转为 ✅。别把新代码和旧镜像混在一起。

- [ ] **Step 5: 提交**

```bash
git add tools/conformance/src/slices/slice-09-play-rotation.ts tools/conformance/src/run.ts tools/conformance/package.json
git commit -m "test(conformance): slice-09 出牌轮转（地主胜/农民胜/首出过牌反例，C5/C16/C18/C19）"
```

---

## 门禁（协调者，合并后执行）

```bash
# ① 工作区 DoD（合并 feat/backend + feat/frontend 之后）
pnpm exec turbo run test lint --force      # 期望 29/29；⚠️ 不 --force 看到的绿可能是 turbo 回放的日志
pnpm exec turbo run build --force          # 期望 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build
cd /home/howe/pokergame

# ② 跑 conformance 前**必须先在主检出** build（docker-compose.yml:154 把宿主
#    packages/robot-service/dist bind-mount 进容器 ⇒ 对 robot-service 重建镜像无效）
pnpm exec turbo run build --force
# 镜像必须重建；本机 daemon.json 的 registry-mirrors 全挂 ⇒ 必须用经典构建器
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d

# ③ 每条切片套 timeout（R156：失败路径泄漏的 socket 会把 run.js 永久吊住），
#    且**不带** CONFORMANCE_STEPS（那个环境变量只用于逐步取负对照的 RED 原文）
timeout 300 node tools/conformance/dist/run.js slice-09
timeout 300 node tools/conformance/dist/run.js slice-08
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary
timeout 300 node tools/conformance/dist/run.js slice-07.2-security
timeout 300 node tools/conformance/dist/run.js slice-07.1
timeout 300 node tools/conformance/dist/run.js slice-07
timeout 300 node tools/conformance/dist/run.js slice-06
timeout 300 node tools/conformance/dist/run.js slice-05
```

**判据汇总（逐条写进 `agent-briefs.md` 的门禁实测段）**：
- 关闭：**C16 / C18 / C19 / C20 / N16**；
- **部分关闭（必须写清剩下的一半）**：**C5**（剩 §9.1 ①②③ 最优跟牌 ⇒ 切片 11，与 E4 同改）、**C6**（剩 `HandType.Invalid` 启用与类型化结果 ⇒ 切片 11）、**N15**（剩后端把限额挪到 namespace middleware ⇒ 独立小片 P3）；
- 新登记：**N17**（局终不下发 `state='ended'` 视图 ⇒ 切片 10）；
- 新增「切片 9 新增的通用教训」（执行期真的撞出来的才写，没撞到就不编）。

**已知的两个门禁陷阱**：
1. **Redis 里的旧会话**：本片把 `GameSession.lastPlayedHand` 换成了契约形状；TTL（1h）内残留的旧会话若被读到，`validateOutbound` 会因 `keyRank` 为 `undefined` 当场抛错。症状是「某个旧房间的视图推送 500」。处置：`docker compose exec -T redis redis-cli --scan --pattern 'game:session:*'` 后逐个 `del`（**不是**产品缺陷，是发版期的数据形状迁移）。
2. **连接名额**：`slice-09` 自己开三个房间，跨切片跑时若报 `code=-1`，先按 `agent-briefs.md` 的「已知环境事实」清 `ratelimit:ws-conn:*` 再重跑 —— **不要**去动 §5.4 的 5。

---

## Self-Review

**1. Spec coverage**

| 规格条款 | 落在哪 |
|---|---|
| 玩法 §1.4 / §10 编码边界 | Task 1（R158，`douzeroIntToCard` 唯一入口） |
| 玩法 §4.1 `length` 单位 | Task 1（`length: playedHand.length` + view 透传 + 连对判别用例） |
| 玩法 §5 比较（含「length 必须来自持久化字段」） | Task 1（`BeatTarget` 收窄 + 只读 `session.lastPlayedHand`） |
| 玩法 §6.1 出牌 11 步 | Task 1（第 4/5/9/10 步）+ 已有实现（第 6/7 步炸弹与春天计数） |
| 玩法 §6.2 过牌 8 步（第 2、3 条） | Task 2（R159） |
| 玩法 §6.3 不变式 1–3 | Task 2（`assertPlayInvariants`） |
| 玩法 §6.3 不变式 4 | 已有：`game.service.finishTransition`（§7 的 ended 写入切片 2 已落） |
| 玩法 §7 胜负判定 | Task 3（`some` + 唯一真源） |
| 玩法 §9.1 出牌超时可执行定义 | Task 4（④ + 首出）；①②③ 明确归切片 11 |
| 玩法 §9.2 计时器重挂 | Task 4（复用 `finishTransition`）+ 既有 `game.timer.test.ts` |
| 玩法 §11.1 错误码映射 | Task 5（`SPEC_ROWS` 逐行对账 + N16 两处修正） |
| 主规格 §6.4 裁剪 | Task 1（`validateOutbound` 兜底）+ conformance `assertNoLeak` |
| 主规格 §11.2 错误码 | Task 5（全部走 `ErrCode`，零字符串码） |
| 主规格 §12 F01 / F06 / F10 | Task 6（首出不禁用 + 倒计时以服务端为基准 + 无本地计算回归） |
| 对账表切片 9 清单（C5/C16/C18/C19/C20/C6+N2 + 前端 + conformance） | Task 1–8 全覆盖 |
| N15 | Task 7（前端半边）+ 明确登记剩余半边 |

**2. Placeholder scan**：本计划无 TBD/TODO；每个代码步骤都给了可粘贴的实现或精确到行的替换指令；`Task 8` 里「照抄 slice-08 的同名实现」指的是**逐字的既有函数**（`startFreshRoom`/`currentView`/`waitForVersion`/`waitForNewerVersion`，见 `tools/conformance/src/slices/slice-08-bidding.ts:69-152`），不是留空。

**3. Type consistency**：`LastPlayedHand`（`cards/type/keyRank/length`）在 `protocol/views.ts` 定义、`shared/ddz/types.ts` re-export、`play.ts` 生产、`view.builder.ts` 透传、conformance 的 `LastPlayedHandWire` 消费 —— 五处同名同形；`handlePlayTimeout` / `assertPlayInvariants` / `RULE_ERROR_MAPPINGS` / `classifyRuleError` / `BeatTarget` 在每个引用它们的任务里都写了确切签名；`ReconnectReason.kind` 的 `'server_rejected'` 在 `socket.ts` 定义、`useGameSession.ts` 分支、`connection-rejected.test.ts` 断言 —— 三处一致。

---

## 执行期裁决（已回填，**不要删**）

> 格式照切片 8：编号 + 现象（实际命令与输出）+ 结论 + 是否改了计划。
> **编号冲突已裁决**：`R174–R177` 归 conformance 方（已随 `e81c84f` 写进代码注释，保留不动）；协调者/后端发现的另外三条改记 `R178–R180`。

### 一、计划自身的缺陷（9 条，全部由执行期实测发现；逐条留证，不改写历史）

| 编号 | 缺陷 | 现象 / 实测证据 | 处置 |
|---|---|---|---|
| **R172** | §7 的结束路径**不发** `game.state_update` ⇒ 终局手不能等版本推进 | `finishTransition` 命中 winner 时只 `publishEnded` 后 return。conformance 实测：场景 A 第 20 墩必须走 `playFinalHand()`；用计划初稿的 `playAndSync`（等更新版本）会白等 8s，**在已修的实现上也会假红** | 协调者评审期就地修正计划（`9e8a1bc`）：新增 `playFinalHand()`，两场景在 `hand.length === 1` 时改用它并 `break` |
| **R173** | 前端选中态按**牌值**记录 ⇒ 同一点数最多只能选一张 | 前端 RED 原文：`两张 3 都选中后应恰好 2 个高亮: expected +0 to be 2`（点第二张 `3` 把第一张**取消**）⇒ **对子/三张/炸弹/四带二/连对从 UI 永远送不出去**；且 `Hand.vue` 用 `includes(value)` 把同点数整组高亮（UI 说谎） | 协调者裁决**本片修**（选中态改按 `store.hand` **下标** + 手牌指纹 watcher 兜新鲜度），登记 **N18**；前端 `db8b698` |
| **R174** | 过牌/行动者按**客户端连接顺序**假定轮转顺序 | conformance 实测：座位与连接顺序不一致时向非当前回合者发 `game.bid`/`game.pass` ⇒ `12003`。**修好后也会红**（用例本身是坏的） | conformance 方修（`passCurrent()` 一律按 `currentPlayer` 从 `bySeat` 取）；计划 Task 8 的固定顺序作废 |
| **R175** | 未考虑 §5.4 的 **per-socket WS 消息限额** | 实测 RED：`地主第 18 墩首出单张（seat 0）：期望 0，实际 10006`（`room-service/src/gateway/message.router.ts:32` 的 `WS_RATE_LIMIT = { max: 20, windowMs: 5000 }`，按 socketId） | conformance 方修（`sendThrottled()`，同一 client 两条消息 ≥300ms ≈ 16.7 条/5s） |
| **R176** | `checks.eq(caliberViolations, [])` **永远不可能通过** | `Checks.eq` 用 `!==` 比较 ⇒ 两个不同的数组引用永不相等；**即便在已修的实现上也红**（这是判据自身写错，不是用例无判别力） | conformance 方改成 `checks.that(v.length === 0, …)` 并把违例原文拼进消息（RED 才看得到是哪一手） |
| **R177** | 叫抢驱动每轮读 `clients[0]` 的 `currentBidder` **之前**未同步三家 | 实测 RED：`叫抢第 3/3 次决策：座位 1 game.bid(grab=false)：期望 0，实际 12003`。`waitForNewerVersion(actor)` 只保证**行动者**拿到新版，而 `firstView(room)` 走 `clients[0]` | conformance 方修**两处**：`slice-09` 与**已合并的** `slice-08-bidding.ts`（同款竞态，门禁里会偶发假红） |
| **R178** | Task 5 的映射表**漏了 §6.3 不变式的 3 条 `throw`** | Task 2 新增 `assertPlayInvariants` 抛 3 条 `invariant violated: …`，而计划给的 `RULE_ERROR_MAPPINGS` 一行都没给它们 ⇒ 覆盖闸会在**自己的正对照**上红 | 后端补一条刻意写宽的 `/invariant violated/i`（不变式是**内部防御**，触发即规则引擎自己把状态写坏，对外只能按「操作非法」处置；写宽避免「每加一条不变式就要加一行映射」的噪音） |
| **R179** | Task 5 的 `SHARED_SRC = '../../../shared/src'` **两个环境都不成立** | 协调者用 `path.resolve`+`statSync` 实测：`../../../shared/src` 在 worktree 与主检出**都 ENOENT**；后端一度改成五级形式 ⇒ 在 worktree 里**扫到主检出的旧源码**（本片新增的 `Cannot pass on the opening lead`/`has no card to play` **从未进过闸** ⇒ 闸恒真，其 `PLANT 0` 调试打印即此症），在主检出里 ENOENT ⇒ 门禁红 | 后端改为**向上找到含 `packages/shared/src` 的那层**（`findSharedSrc`，找不到就抛错，不静默）；并把「真的扫到本检出新增文案」做成**硬断言**。协调者复跑：`3 tests` 全绿且正对照 `['Cannot pass on the opening lead', 'Player  has no card to play']` 通过 |
| **R180** | Task 4 Step 6 的「删掉 `handlePass` import」指令**是错的** | `handlePass` 仍被**人类过牌**路径使用（`pass()` → `applyAction(..., handlePass(...))`）⇒ 照删会 `TS6133`/lint 红；另 `onTurnTimeout` 的 R106 例子（`Cannot pass when you last played`）随 C5 修复**已不可达** | 后端正确地**没有**照做；并把过期例子改成唯一可达的防御分支（当前行动者手牌为空），同时写明 R106 机制本身不变 |

### 二、负对照实测（未修栈 = 合并前的 master 镜像；用例构建 `e81c84f`）

| 步骤 | 命令（都套 `timeout`） | ❌ 原文 | 该跑是否覆盖 C19 |
|---|---|---|---|
| 未知步骤 id | `CONFORMANCE_STEPS=zzz node dist/run.js slice-09` | `CONFORMANCE_STEPS 里有未知步骤：zzz（合法值：a,b,c）`（**在任何网络动作之前**抛错） | 无网络动作 |
| **C18** | `CONFORMANCE_STEPS=c …` | `首出过牌 ⇒ 13001（玩法 §6.2-2）：期望 13001，实际 0` | 未打出任何牌 ⇒ 未覆盖 |
| **C20** | `CONFORMANCE_STEPS=a …` | `每一手 lastPlayedHand 的口径（…；在线可观测 19 手） ⇒ v5: 单张的 length 应为 0，实际 1`（19 条，**确定性红**） | 见下 |
| **C19** | 同上 | `v11: keyRank 应为内部 Rank 15，实际 17（DouZero 口径？C19）` | 两跑之一地主打出 `17` ⇒ **真的覆盖到**（探针非恒真）；另一跑地主无 `2` ⇒ 未覆盖 |
| **C16** | `CONFORMANCE_STEPS=b …` | `B1 等 game.finished 超时（8000ms）` | 中止于超时 ⇒ 无牌值证据 |
| 三条合跑（门禁形态） | `node dist/run.js slice-09` | 同上口径断言（含 `v11`/`v14` 两条 keyRank 违例） | fail-fast 只暴露场景 A 的第一条 ⇒ **合跑只证明 C20（+本跑机会性 C19）**；C18/C16 的判别力由分步 ②/④ 各自取到 |

**明确不构成 e2e 覆盖的两处（不许读成已覆盖）**：
- **C5**：需要真实 30s 超时才触发；判别性证据是 `game.timer.test.ts` 的 fake timers（结构性判据：句柄被换掉 / 手牌真的少一张 / 不落盘）。
- **C19**：只有**真的打出 DouZero `17`（2）**时才与旧实现分歧（其余牌值两个口径恒等）；判别性主证据是 `packages/shared/src/ddz/play.test.ts` 的「同点数的 `2` 不能压过上一手的 `2`」（R158）。conformance 在每个场景进 `playing` 时 `info` 打印三家完整手牌（`handsInfo`），使任一跑的 C19 覆盖度**可判读**。

### 三、连带修改的既有用例（不改测试 = 保留缺陷）

`play.test.ts`（`handlePass` 夹具补非空 `lastPlayedHand`；`checkWinCondition` 的 farmer 用例改为「**只有一名**农民为空」）· `settle.test.ts`（新增一条只经 `settleGame()` 的农民胜用例）· `view.builder.test.ts`（契约形状透传 + 连对 `length = 3` 判别）· `game.service.test.ts`（N16 两行期望值互换 `13001 ↔ 13006`）· `game.timer.test.ts`（`stageTimeoutThatThrows` 作废，重写为「首出打最小单张 / 跟牌过牌 / 手牌为空走 catch 路径」）· `bot.player.test.ts`（`lastPlayedHand` 夹具改契约形状）。

### 四、执行期新增的对账表条目（细节见 `deviation-ledger.md`）

- **N16**：`classifyRuleError` 的「压不过上一手」与「牌不在手中」两条映射与 `doudizhu.md` §6.1/§11.1 **方向相反** ⇒ 本片关闭（`1b0548a`）。
- **N17**：局终**不下发** `state = 'ended'` 的视图；经 conformance 实测，更强的事实是「**最后一手的视图整体缺失**」——逐手口径断言天然少一手（场景 A 19/20、场景 B 15/16），客户端只能从 `game.finished`/`game.settlement` 得知结束 ⇒ 归**切片 10**。
- **N18**：前端选中态按**牌值**记录 ⇒ 对子/三张/炸弹送不出去 + 同点数整组高亮 ⇒ 本片关闭（`db8b698`，R173）。

---

## 门禁实测（已通过，master `cb2b208`）

```bash
pnpm exec turbo run test lint --force      # ✅ Tasks: 29 successful, 29 total · Cached: 0 cached
#   protocol 39 · shared 127 · game-service 73 · robot-service 15 · room-service 157
#   api-gateway 106 · user-service 29 · client 154 (+2 skipped)
pnpm exec turbo run build --force          # ✅ 10/10 · 0 cached
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 154 passed · vue-tsc 干净 · build OK

pnpm exec turbo run build --force          # ⚠️ 先 build（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d   # 8 容器 healthy
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 155 项，26.1s（新增）
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项，6.9s
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 53 项，15.5s
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22 项，9.6s
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项，5.2s
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项，4.9s
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项，2.0s
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项，33.4s
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 249 项，0.4s
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项，56.0s
```

**conformance 10/10 全绿**（每条都套了 `timeout`、**不带** `CONFORMANCE_STEPS`）。

⚠️ **`slice-09` 的第一次门禁不是绿的，而且不是本片的缺陷**：它在 `A0 等 game.settlement 超时（8000ms）` 上红。
根因是 **N1** —— `game.settlement` 的载荷（内部 `SettlementResult`）**过不了网关的出站校验**，
`[ProxyGateway] Blocked outbound game.settlement …: ProtocolError: $.payload.baseScore must be a finite number, got undefined`
（网关日志 6 条 = 2 次对局结束 × 3 家）⇒ 消息**不转发**，客户端只收 `game.finished`。
处置：**本片不修 N1**（它是切片 10 的头条，只改形状会把 `spring:'none'`/写死的 `baseScore` 当**正确**结算推给前端），
把场景 A/B 的 `game.settlement` 断言换成「如实播报 + 根因注释 + 切片 10 修好后应恢复的断言」（`cb2b208`）。
**这是本片最有价值的一次发现**：它只有在「第一次真的把一局打完」时才可能出现，此前任何切片都到不了。

## 下一步

1. 协调者把本计划提交到 master，并把 `feat/backend` / `feat/frontend` 各自 `git merge master --no-edit`；
2. 派三方（后端 Task 1–5 / 前端 Task 6–7 / 协调者 Task 8），每方按「开工前固定动作」起步；
3. 两方汇报后：协调者评审 → 合并 → 跑门禁 → 回填「执行期裁决」→ 收口 `deviation-ledger.md`（C16/C18/C19/C20 关闭；C5/C6/N15 部分关闭；新增 N16/N17）与 `agent-briefs.md`（门禁实测 + 通用教训）与 `2026-09-13-parallel-dev.md` 的进度块；
4. **下一片 = 切片 10（结算）**：C1（倍数改乘法）/ C2（座位语义）/ C3（春天·反春）/ C26（`baseScore`）/ **N1**（结算载荷逐字段等于 `SettlementResult`）+ 前端结算页 + **N17**（局终下发 `state='ended'` 视图）+ conformance 分数守恒。

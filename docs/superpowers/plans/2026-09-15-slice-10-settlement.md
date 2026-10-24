# 切片 10 实施计划：结算

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「结算」从「**事件根本到不了客户端**（`game.settlement` 被网关出站校验整条拦掉）、倍数用加法、座位语义混用数组下标、春天零实现、底分硬编码 100、局终不下发 `ended` 视图」修成「一局打完后三家**都收到**逐字段等于契约 `SettlementResult` 的结算载荷、分数量值按玩法 §8.4 守恒、春天/反春两条路径都有在线判据、局终有一版 `state='ended'` 的裁剪视图、前端有一个只做展示的结算页」。

**Architecture:** 结算真源仍是 `packages/shared/src/ddz/settle.ts`（纯函数：读 `GameSession` → 返回契约 `SettlementResult`）。本片的结构改动只有三条，且都是「删掉第二个真源」：① `shared` 的**内部** `SettlementResult`（`{winner, landlordSeats, …}`）直接删除，改为 re-export `packages/protocol` 的契约类型 —— 这正是 N1 的根因（同名不同形 ⇒ 网关 `validateOutbound` 拦掉事件），一次对齐即可同时消灭「形状漂移」与「字段缺失」；② `GameSession.baseScore` 从 game-service 的**模块增强**（`game.types.ts`）上移到 `packages/shared` 的接口本体，`settleGame()` 读它而不是硬编码 100；③ 局终视图：`game-service.finishTransition()` 在置 `ended` 后**先**发一次 `game.state_updated`（⇒ 客户端拿到 `state='ended'` 的 `PlayerView`，即此前整体缺失的终局那一手），**再**发 `game.ended`；room-service 对 `state==='ended'` 的视图**不发** `game.current_turn`（终局没有「下一回合」）。前端只新增一个纯展示组件 `Settlement.vue`，**零计算**（F01/F02/F10/M09）。

**Tech Stack:** TypeScript / NestJS 10 / ioredis / Vitest / pnpm workspace + Turborepo / Vue 3 + Pinia + Vite（`apps/client`）/ socket.io 4

**Spec:**
- `docs/games/doudizhu.md` v1.2 —— **玩法唯一来源**。本片逐条落实 **§8.1（底分）· §8.2（倍数 = `bidMultiplier × 2^bombCount × 春天倍数`，**乘法**）· §8.3（春天/反春）· §8.4（分数变动与守恒）· §8.5（`SettlementResult` 唯一形状，`landlordSeat` 用**座位号**）**；连带 §6.1 第 7 步（`landlordPlays`/`farmerPlays` 计数）
- `docs/design.md` v4.2 —— 权威依据。本片落在 **§3.2（`GameSession.baseScore`）· §4.2（`game.start` 的 `baseScore` 链路）· §4.4（`game:events` 翻译表）· §6.2（快照类/事件类）· §6.3（消息清单）· §6.4（可见性裁剪 + 出站校验）· §6.7（推送顺序）· §8.5（结算结构引用）· §12（F01/F02/F10/M07/M09）**
- `docs/superpowers/plans/deviation-ledger.md` §2「切片 10（结算）」—— 本片待办：**C1 / C2 / C3 / C26 / N1 / 前端结算页 / N17 / conformance 分数守恒**；§1.5 的 **N1**（后果实测校正）与 **N17**
- `docs/superpowers/plans/agent-briefs.md` —— 「切片 10 开工前必读的三条」+「已知环境事实」（robot-service 的 bind-mount、`DOCKER_BUILDKIT=0`、**开发命令不带 `-f`**、门禁必须 `--force`、每条 conformance 套 `timeout` 且**不带** `CONFORMANCE_STEPS`）
- `docs/superpowers/plans/2026-09-15-slice-09-play-rotation.md` —— 上一片计划（本片沿用其结构、裁决格式与门禁写法）；其 R172（终局手没有 `state_update`）本片由 N17 正面解决

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

### 本切片的绑定数值（逐字，来自玩法 §8 与主规格 §3.2/§6.3/§6.7）

| 项 | 值 |
|---|---|
| 默认底分 | `baseScore` 默认 **100**，由房间决定；**必须**由 game-service 开局写入 `GameSession.baseScore`，`settleGame()` **不得硬编码**（§8.1） |
| 倍数合成 | `倍数 = bidMultiplier × 2^bombCount × 春天倍数`（§8.2）—— **乘法**，不是加法 |
| 春天倍数 | `spring === 'none'` ⇒ **1**；`'spring'` / `'anti-spring'` ⇒ **2** |
| 春天 | 地主胜 **且** `farmerPlays === 0` ⇒ `spring: 'spring'`（§8.3） |
| 反春 | 农民胜 **且** `landlordPlays === 1` ⇒ `spring: 'anti-spring'`（§8.3） |
| 分数变动 | 地主胜：地主 `+ baseScore × 倍数 × 2`、每名农民 `− baseScore × 倍数`；农民胜：地主 `− baseScore × 倍数 × 2`、每名农民 `+ baseScore × 倍数`（§8.4） |
| 分数守恒 | `landlordScoreChange + farmerScoreChange × farmerSeats.length === 0`（§8.4） |
| `SettlementResult` 形状 | `{ roomCode, baseScore, winner, landlordSeat, farmerSeats, multiplier, spring, landlordScoreChange, farmerScoreChange }` —— **恰好 9 个字段**，多一个/少一个都是偏差（§8.5 + 主规格 §6.3 的 `game.settlement` 载荷） |
| `landlordSeat` | **座位号**（不是 `players` 数组下标；§8.5 末注） |
| 局终视图 | 对局结束时下发的最后一份 `PlayerView` 必须 `state === 'ended'` 且带 `winner`（§4.2 `PlayerView.winner`；N17） |
| 推送顺序 | 同一次状态转移内 `game.state_update` **先于** `game.current_turn`；结算与 `game.finished` **同版本**（§6.7 / §6.3） |
| 本片相关错误码 | `13005` 已结束（不得变成 500）、`12003` 非当前回合；**本片不新增任何错误码** |

### 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接切片 9 执行期的 **R181**，从 **R182** 起。执行期若发现下列任一条与代码事实不符，**就地记「执行期裁决」并写进计划文件**，不要静默偏离。

- **R182 N1 的根因修法是「删掉第二个形状」，不是「补字段」。**
  - `packages/shared/src/ddz/types.ts` 里的内部 `interface SettlementResult`（`landlordSeats` / 无 `baseScore` / 无 `spring` / 无 `roomCode`）**整个删除**；该文件改为 `export type { SettlementResult } from '@fight-the-landlord/protocol'`（与切片 9 的 `LastPlayedHand` 完全同一手法，R157）。`settleGame()` 的返回类型因此**就是**契约类型。
  - 判据（唯一可判别形态）：`settleGame(session)` 的返回值直接喂给 `validateOutbound({ type: 'game.settlement', version: 1, payload: result })` **必须不抛**。旧实现的返回值在这条上必然抛 `$.payload.baseScore must be a finite number, got undefined`（这就是网关日志的原文）。
  - **`packages/protocol` 本片零改动**：契约类型与 `assertSettlement` 早已就位（`views.ts:82`、`validate.ts:121`），本片只是**终于按它产出**。
  - 为什么不能只补字段：`landlordSeats` 与 `landlordSeat` 并存过一天，就还会有第三个调用点读错那一个（切片 9 的 `lastPlayedHand` 是同一个教训）。
- **R183 C1：倍数是乘法，且按 §8.4 把「底分」与「单家得失」分开命名。**
  - `const multiplier = session.bidPhase.bidMultiplier * 2 ** session.playPhase.bombCount * springMultiplier;`
  - `const unitScore = session.baseScore * multiplier;`（§8.4 末注**点名**要求改名：旧的局部变量名 `baseScore = 100 * multiplier` 与「底分」冲突）
  - 判据：`bombCount = 1` + `bidMultiplier = 2` ⇒ `multiplier === 4`（旧加法 3）。**该用例的夹具必须让春天不成立**（`farmerPlays > 0`），否则 `4 × 2 = 8` 会把 C1 的判据污染成 C3 的（这是本片最容易写错的一条）。
- **R184 C2：`landlordSeat` 取**座位号**，`farmerSeats` 同样取座位号。**
  `session.players.find(p => p.isLandlord)` 之后用 `landlord.seat`，**不得**用 `session.players.indexOf(landlord)`。3 人局按座位顺序时两者恰好恒等 ⇒ 判据必须用**座位与下标不一致**的夹具（如 `players` 顺序为 seat `[2,0,1]`、地主是 seat `1` ⇒ 期望 `landlordSeat === 1`，旧实现给 `0`）。
- **R185 C3：春天判定必须在倍数之前，顺序固定。**
  顺序：`winner` → `spring` → `springMultiplier` → `multiplier` → `unitScore` → `landlordScoreChange` / `farmerScoreChange`。`resolveSpring()` 只有两条规则（§8.3 逐字）：
  ```
  地主胜 && farmerPlays === 0        ⇒ 'spring'
  农民胜 && landlordPlays === 1      ⇒ 'anti-spring'
  否则                                ⇒ 'none'
  ```
  ⚠️ 反春是 `landlordPlays === 1`（**恰好一手**），不是 `<= 1`、也不是 `0`。计数来自 §6.1 第 7 步（`play.ts:79-80` 已统计，本片只是**开始读它**）。
- **R186 C26：`baseScore` 上移到 `GameSession` 接口本体，并补上房间 → 会话的最后一跳。**
  - `packages/shared/src/ddz/types.ts` 的 `GameSession` 新增 **必填** `baseScore: number;`（§3.2 原文：底分，开局时由 room-service 经 `game.start` 写入，默认 100）。
  - `packages/shared/src/ddz/game.ts` 导出 `DEFAULT_BASE_SCORE = 100` 并由 `createSession()` 写入 `baseScore`（§8.1 默认值；**唯一**的 shared 侧默认值）。
  - `packages/game-service/src/game/game.types.ts` 的模块增强**删掉 `baseScore` 那一条**（其余 `turnDeadlineAt` / `winner` / `botIds` 保留 —— 它们是别的切片的范围，本片不顺手扩大）。`view.builder.ts` 的 `DEFAULT_BASE_SCORE` 改为从 `@fight-the-landlord/shared` re-export（**不得**出现第三份 100）。
  - **新登记 N19**（本片发现并顺手关闭）：`room-service/src/match/match.service.ts:394` 的 `startGame` 把 `baseScore` **硬编码 `100`**，不读 `room.baseScore` ⇒ 即使 `settleGame()` 改读 `session.baseScore`，房间底分仍然**永远到不了会话**（§3.1 `Room.baseScore` → §4.2 `StartGameRequest.baseScore` 的那一跳是断的）。本片改为传 `room.baseScore`（`room` 在该作用域已可用），并加一条「房间底分 ≠ 100 时载荷里就是那个值」的用例。
- **R187 N17：局终必须下发 `state='ended'` 的裁剪视图，且终局不发 `game.current_turn`。**
  - `packages/game-service/src/game/game.service.ts` 的 `finishTransition()` 在 `winner` 分支里：`saveSession` → **`publishSeatViews('game.state_updated', session)`** → `publishEnded(...)` →（原有 log）→ `return`。
    - 顺序**不可反**：§6.7 要求同一次转移内 `game.state_update` 先到并被应用，客户端渲染结算时才有最终手牌张数（`game.current_turn` 与 `game.settlement` 都不带 `cardCounts`）。
    - 这一版视图正是此前**整体缺失**的那一手（切片 9 实测：场景 A 在线可观测 19/20、场景 B 15/16）。
  - `publishEnded()` 里的 `{ ...settleGame(session), roomCode }` 改为 `settleGame(session)`（`roomCode` 现在就在契约类型里，再拼一次就是第二个真源）。
  - `packages/room-service/src/gateway/ws.gateway.ts` 的 `onGameEvent()`：`game.state_updated` 的循环里，对 `view.state === 'ended'` 的座位**只发 `game.state_update`，不发 `game.current_turn`**（终局没有「下一回合」；`currentTurnPayload()` 会给出一个 30s 的假 `timeoutMs`）。
  - 判据（结构性，不依赖时间）：① 三家都收到 `state==='ended'` 的 `game.state_update`，其 `version` 等于最终版、`cardCounts` 里胜者为 0；② 该快照在 `client.received` 里的下标**小于** `game.settlement` 的下标；③ **没有** version 等于该最终版的 `game.current_turn`，**正对照**：上一版（非终局）确实有 `game.current_turn`（否则「没有」可能只是探针坏了）。
- **R188 前端结算页：只渲染服务端字段，零计算（F01/F02/F10/M09）。**
  - 新建 `apps/client/src/components/Settlement.vue`，`props: { settlement: SettlementResult }`（类型来自 `@fight-the-landlord/protocol`），`table.vue` 用 `<Settlement v-if="store.settlement" :settlement="store.settlement" />` 渲染。
  - 稳定 class（给测试当锚点，**不得**改名）：`.table__settlement`（容器）/ `.settlement__winner` / `.settlement__spring` / `.settlement__multiplier` / `.settlement__base-score` / `.settlement__landlord-seat` / `.settlement__farmer-seats` / `.settlement__landlord-delta` / `.settlement__farmer-delta`。
  - `spring` 的文案映射是本组件**唯一**的本地映射：`'none' → '无'`、`'spring' → '春天'`、`'anti-spring' → '反春天'`。这是**展示文案**，不是规则判断；除此之外**不得**出现任何算术（`+`/`*`/`%`）作用于结算数字 —— `landlordScoreChange` / `farmerScoreChange` / `multiplier` 一律**原样渲染**（`+800` 这种带符号串是**服务端**给的数字，不做符号美化）。
  - 判据：喂一条真实形状的 `game.settlement` 事件 ⇒ 六个字段各自的 DOM 文本逐字等于夹具值 + `spring` 三态文案映射（三条参数化）+ **没有**任何本地计算结果（用夹具值设计成「算不出来」的数，例如 `multiplier: 4` 但 `landlordScoreChange: 777`，若前端偷偷算就会红）。
- **R189 前端 N17：终局态 UI 与「结束」文案。**
  - `apps/client/src/stores/game.ts` 新增 getter `isEnded: (s) => s.view?.state === 'ended'`。
  - `table.vue` 的动作区新增一支：`v-else-if="store.isEnded"` ⇒ 渲染 `<span class="table__ended">本局结束</span>`；**不得**在终局渲染 `.table__play` / `.table__pass` / `.table__bid-grab` / `.table__bid-pass`；顶栏的 `出牌中` / `叫抢中` 在终局不得出现（三态文案：`叫抢中` / `出牌中` / `已结束`）。
  - `M07` 不变：**只有**收到 `game.finished` 或 `game.settlement` 才显示结算/结果；`state === 'ended'` 只表示「没有下一步动作」，不预判胜负 —— 因此「本局结束」这一支**不得**自己读 `winner` 去拼结果文案（`winner` 由 `.table__settlement` / `finished` 渲染）。
  - 判据：`state:'ended'` 的夹具 ⇒ `.table__ended` 存在且四个动作 class **全部不存在**（断言 DOM 里没有该节点，而不是「点了没反应」——R115：jsdom 里点 `disabled` 按钮是静默 no-op）；**正对照**：同一份用例先喂 `state:'playing'` ⇒ `.table__play`/`.table__pass` 存在（证明选择器与夹具都能观测到「存在」）。
- **R190 conformance 本片交付三件东西。**
  1. **抽共享驱动**：slice-09 与 slice-10 都要「起房 → 叫抢到 playing → 每墩首出单张、两家过牌 → 打到分出胜负」。把 slice-09 里的驱动函数抽到**新文件** `tools/conformance/src/lib/ddz-driver.ts`（`FreshRoom` / `startFreshRoom` / `sendThrottled` / `currentView` / `firstView` / `waitForNewerVersion` / `waitForVersion` / `syncAll` / `extremeByRank` / `smallestBeatingSingle` / `checkSingleCaliber` / `deckValues` / `handsInfo` / `playAndSync` / `passAndSync` / `playFinalHand` / `passCurrent` / `playBiddingToPlaying` / `MAX_TRICKS` / `MSG_INTERVAL_MS` / `STEP_TIMEOUT_MS` / `MATCH_TIMEOUT_MS`），`slice-09` 改为 import 它，**行为与断言一条都不改**（先跑一遍 slice-09 确认仍然 155 项绿）。
     - 唯一允许的例外：`selectedSteps()` / `ALL_STEPS` 留在各自切片文件里（步骤 id 是切片自己的）。
  2. **`slice-10`**：两个房间（场景 A 地主胜 + 春天；场景 B 农民胜 + 反春），逐条断言见 Task C2。**不得** import `@fight-the-landlord/shared`（R168 同款纪律：拿被测实现当裁判）。
  3. **恢复 `slice-09` 的结算断言**：把两处 `info('N1（切片 10）…')` 换成真的 `waitFor('game.settlement')` + `winner` 断言（注释里已把写法逐字写好），删掉「本片不断言它到达」的长注释并改写为「N1 已由切片 10 关闭」。
- **R191 测试连带清单（不改测试 = 保留缺陷）。**
  | 文件 | 为什么要改 |
  |---|---|
  | `packages/shared/src/ddz/settle.test.ts` | 全面重写：旧的 `landlordSeats` 断言与新形状不兼容；`:35` 那条**断言了加法**（期望 3，修好应为 4）；两条旧用例的 `farmerPlays: 0` 在 C3 落地后**必然**变成春天 ⇒ 夹具必须逐条显式给出 `playPhase` |
  | `packages/shared/src/ddz/types.test.ts` | `describe('SettlementResult')` 的夹具是旧内部形状（无 `roomCode`/`baseScore`/`spring`、有 `landlordSeats`）⇒ 改为契约形状，并**新增**一条「shared 的 `SettlementResult` 就是 protocol 的那一个」的类型断言 |
  | `packages/room-service/test/match.service.test.ts` | `:530` 的 `baseScore: 100` 在 R186 之后来自 `room.baseScore`；房间夹具底分若为 100 则**无需改值**，但必须**新增**一条「底分 ≠ 100 时原样传递」的用例（否则 N19 无判据） |
  | `packages/game-service/test/game.service.test.ts`（或 `full-game.test.ts`） | 新增 N17 的发布断言（ended 视图 + `game.ended` 顺序 + 载荷形状） |
  | `packages/room-service/test/ws.gateway.test.ts` | 新增「`state==='ended'` 不发 `game.current_turn`」+ 正对照 |
  | `apps/client/test/table-play-ui.test.ts` / `table-bid-ui.test.ts` | 回归即可（本片不改它们的夹具语义）；**若** `state:'ended'` 的新分支让它们的「非我回合」断言失配，改的是新用例而不是把它们放宽 |
  > `packages/shared/src/ddz/settle.test.ts` 里那条「**两名农民手牌都为空**」的恒真用例（`every`/`some` 同真）**已由切片 9 改写**（现为「只有一名农民为空」，判别性在 `play.test.ts`）⇒ 本片**复核并写清结论**（不改行为，只在汇报里说明）。
- **R192 mock-server 的结算是「第二真源」，按 C1 对齐（工具侧，协调者）。**
  `tools/mock-server/src/scripted-game.ts:201` 现在是 `const multiplier = this.bombCount + 1;`（**加法**）、`spring: 'none'` 恒真 —— 前端 agent 的 mock 联调与 `mock-e2e.test.ts` 会照着它错。改为 `const multiplier = 2 ** this.bombCount;`（mock 的 `bidMultiplier` 恒为 1/2、无抢的合成逻辑；**必须**在文件头注释里写明「mock 只复刻 §8.2 的炸弹因子，不承担叫抢倍数与春天的规格」），并把 `spring` 的计算留给 mock 自己已有的计数（若无计数则显式写 `'none'` **并加注释说明 mock 不覆盖春天**）。判据：mock 的结算在 `bombCount = 1` 时 `multiplier === 2`（旧实现给 2 —— ⚠️ 这个值**恰好相同**，因此**必须**另加一条 `bombCount = 2 ⇒ multiplier === 4`（旧实现给 3）；只有它具备判别力）。
- **R193 判据纪律（切片 7/8/9 的教训，本片继续照做）。**
  ① **不要**用 `Checks.eq` 比数组/对象字面量（R176）：判数组用 `checks.that(arr.length === 0, …)`，判字段集用 `JSON.stringify(Object.keys(x).sort())` 比字符串；
  ② 断言「**没有**发生」之前，先证明探针能观测到「**发生**」（R115 / R152）；
  ③ 源码级机械闸必须自带**探针判别力**（正/负对照），且路径解析必须在**两个环境**各验一次（R179：worktree 里写错一层会静默扫到主检出的旧源码 ⇒ 闸恒绿）；
  ④ 涉及墙钟的用例优先用**结构性判据**（下标顺序、字段值、句柄是否被换掉）；
  ⑤ 门禁必须 `--force`（turbo 会回放缓存日志），conformance 每条套 `timeout`。

---

## 执行模型（与切片 5/6/7/8/9 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | 评审、合并、门禁、`docs/**` 收口、**委托** conformance 一方（文件归协调者所有） |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | Task B1、B2、B3 |
| **前端 agent** | `.worktrees/frontend`（`feat/frontend`） | Task F1、F2 |
| **conformance 方** | `/home/howe/pokergame`（master，**只动 `tools/conformance/**`**） | Task C1、C2、C3 |

**开工前固定动作**（两个 worktree 都要，逐字执行）：

```bash
cd /home/howe/pokergame/.worktrees/<你的角色>
pwd && git branch --show-current
git merge master --no-edit        # master 已含切片 9 收口与 R182–R193 的全部裁决
pnpm install && pnpm build        # dist/ 是 gitignore 的；不重装会因解析不到 protocol 而假失败
```

**本片的文件集互不相交**：后端只动 `packages/{shared,game-service,room-service}/**`，前端只动 `apps/client/**`，conformance 只动 `tools/conformance/**`，协调者只动 `docs/**` 与 `tools/mock-server/**` ⇒ 四条线可真正并行，合并应干净。

> ⚠️ `packages/shared` 是**后端 agent** 的写区（见 `agent-briefs.md`）。前端 agent **依然不得** import 它（Global Constraint 11 / F03）。
> ⚠️ conformance 方**不得**改 `packages/**` 与 `apps/**`：发现后端/前端的问题，写进汇报由协调者转派。

**汇报格式**（所有 agent 统一，逐条对应 DoD 并附**实际命令与输出**）：完成情况 / 改动清单（文件 + 一句话 + commit sha）/ 阻塞未完成 / 需要协调者裁决的事项 / 我发现的文档未记录的问题。

---

## File Structure

```
packages/shared/src/ddz/types.ts                    Modify: GameSession.baseScore 必填（§3.2/R186）+ 删内部 SettlementResult、re-export 契约类型（R182）
packages/shared/src/ddz/game.ts                     Modify: DEFAULT_BASE_SCORE + createSession 写入 baseScore（R186）
packages/shared/src/ddz/settle.ts                   Modify: 契约化 + C1 乘法 + C2 座位语义 + C3 春天 + C26 底分（R182–R186）
packages/shared/src/ddz/settle.test.ts              Modify: 全面重写（形状 / 乘法 / 座位 / 春天两条 / 守恒 / baseScore / validateOutbound）
packages/shared/src/ddz/types.test.ts               Modify: SettlementResult 夹具改契约形状 + 「就是 protocol 的那一个」
packages/game-service/src/game/game.types.ts        Modify: 删模块增强里的 baseScore（R186）
packages/game-service/src/game/view.builder.ts      Modify: DEFAULT_BASE_SCORE 改 re-export shared（R186）
packages/game-service/src/game/game.service.ts      Modify: finishTransition 发 ended 视图 + publishEnded 不再拼 roomCode（R187）
packages/game-service/src/game/rule-error.mapping.ts Modify: 登记 settle.ts 新增 throw 的映射（N2 覆盖闸要求，执行期裁决 R194）
packages/game-service/test/game.service.test.ts     Modify: N17 发布断言（ended 视图 + 顺序 + 载荷形状）
packages/room-service/src/match/match.service.ts    Modify: startGame 传 room.baseScore（N19/R186）
packages/room-service/test/match.service.test.ts    Modify: 底分 ≠ 100 的传递用例（N19）
packages/room-service/src/gateway/ws.gateway.ts     Modify: 终局视图不发 game.current_turn（R187）
packages/room-service/test/ws.gateway.test.ts       Modify: 终局不发 current_turn + 正对照

apps/client/src/components/Settlement.vue           Create: 纯展示结算组件（R188）
apps/client/src/pages/table.vue                     Modify: 接 Settlement + isEnded 分支 + 顶栏三态（R188/R189）
apps/client/src/stores/game.ts                      Modify: isEnded getter（R189）
apps/client/test/table-settlement-ui.test.ts        Create: 结算页判据（R188）
apps/client/test/table-ended-ui.test.ts             Create: 终局态判据（R189）
apps/client/test/source-boundary.test.ts            Modify: +5 行把新组件纳入「扫描器确实读到了文件」自证（执行期裁决 R197）

tools/conformance/src/lib/ddz-driver.ts             Create: slice-09/10 共用的牌局驱动（R190①）
tools/conformance/src/slices/slice-09-play-rotation.ts Modify: 改用共享驱动 + 恢复 game.settlement 断言（R190③）
tools/conformance/src/slices/slice-10-settlement.ts Create: 场景 A/B（R190②）
tools/conformance/src/run.ts                        Modify: 注册 slice-10
tools/conformance/package.json                      Modify: conformance:slice-10 脚本

tools/mock-server/src/scripted-game.ts              Modify: 结算倍数改乘法（C1 的 mock 镜像，R192）
tools/mock-server/test/settlement.test.ts           Create: bombCount=2 ⇒ multiplier=4（R192）
docs/superpowers/plans/deviation-ledger.md          Modify: 关闭 C1/C2/C3/C26/N1/N17 + 新登记 N19（协调者）
docs/superpowers/plans/agent-briefs.md              Modify: 切片 10 门禁实测 + 教训（协调者）
```

---

## Task B1: `GameSession.baseScore` 上移到 shared（C26 前半 / R186 / N19）

**Files:**
- Modify: `packages/shared/src/ddz/types.ts`
- Modify: `packages/shared/src/ddz/game.ts`
- Modify: `packages/shared/src/ddz/types.test.ts`
- Modify: `packages/game-service/src/game/game.types.ts`
- Modify: `packages/game-service/src/game/view.builder.ts`
- Modify: `packages/room-service/src/match/match.service.ts`
- Modify: `packages/room-service/test/match.service.test.ts`

**Interfaces:**
- Produces: `GameSession.baseScore: number`（必填，`createSession()` 写 `DEFAULT_BASE_SCORE`）；`DEFAULT_BASE_SCORE` 从 `@fight-the-landlord/shared` 导出；`match.service.startGame(roomCode, baseScore, seats)`。
- Consumes: `Room.baseScore`（`rooms.service.ts` 的 `RoomMeta`，已存在）。

- [ ] **Step 1: 写失败的用例（shared）**

在 `packages/shared/src/ddz/types.test.ts` 的 `createSession` describe 里加：

```ts
import { createSession, DEFAULT_BASE_SCORE } from './game';

it('createSession 写入默认底分（§8.1：默认 100，且字段在 GameSession 本体上）', () => {
  const session = createSession('ROOM1', ['u1', 'u2', 'u3']);
  expect(session.baseScore).toBe(DEFAULT_BASE_SCORE);
  expect(DEFAULT_BASE_SCORE).toBe(100);
});
```
（`DEFAULT_BASE_SCORE` 的 import 若与文件既有 import 冲突，合并到同一行。）

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/shared && pnpm vitest run src/ddz/types.test.ts`
Expected: FAIL —— `session.baseScore` 为 `undefined`（或 `DEFAULT_BASE_SCORE` 未导出）。

- [ ] **Step 3: 最小实现**

`packages/shared/src/ddz/game.ts` 顶部（`createDeck` import 之后）：

```ts
/**
 * 默认底分（§3.1 / §8.1）。
 *
 * **唯一**的 shared 侧默认值：`createSession()` 用它兜底，game-service 的
 * `view.builder.ts` 从本包 re-export，room-service 的房间创建走它自己的
 * `DEFAULT_BASE_SCORE`（同为 100，§8.1 逐字）。
 */
export const DEFAULT_BASE_SCORE = 100;
```

`createSession()` 的返回对象里（`roomCode` 之后、`state` 之前）：

```ts
    baseScore: DEFAULT_BASE_SCORE,
```

`packages/shared/src/ddz/types.ts` 的 `GameSession` 接口里，`roomCode` 之后加：

```ts
  /** 底分（§3.2）。开局时由 room-service 经 `game.start` 写入，默认 100（§8.1）。 */
  baseScore: number;
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/shared && pnpm vitest run src/ddz`
Expected: PASS（`types.test.ts` 全绿）。

- [ ] **Step 5: 删掉模块增强里的 `baseScore`**

`packages/game-service/src/game/game.types.ts`：删除 `baseScore?: number;` 那一条（含其 docblock），并把文件头注释改成「§3.2 的 `baseScore` 已由切片 10 上移到 `packages/shared`，本文件只剩 `turnDeadlineAt` / `winner` / `botIds`（**仍属其它切片**）」。**不要**顺手删掉其余三条。

`packages/game-service/src/game/view.builder.ts`：把

```ts
/** 一局对战的默认底分（§3.1），仅在房间未提供底分时兜底。 */
export const DEFAULT_BASE_SCORE = 100;
```

改为

```ts
/** 一局对战的默认底分（§3.1）。**唯一**的 shared 侧默认值，这里只 re-export。 */
export { DEFAULT_BASE_SCORE } from '@fight-the-landlord/shared';
```

> ⚠️ `import { ... } from '@fight-the-landlord/protocol'` 那一行不动；re-export 与 import 是两个语句。若 `noUnusedLocals` 报错，说明 `game.service.ts` 没有用到它 —— 它用得到（`:113`）。

- [ ] **Step 6: 运行确认 game-service 仍然绿**

Run: `cd packages/game-service && pnpm vitest run && pnpm lint`
Expected: PASS（`game.service.ts:113` 的 `session.baseScore = dto.baseScore > 0 ? … : DEFAULT_BASE_SCORE` 原样可用）。

- [ ] **Step 7: 把房间底分真的传下去（N19）+ 用例**

`packages/room-service/src/match/match.service.ts`：`private async startGame(roomCode: string, seats: Seat[])` 改为 `private async startGame(roomCode: string, baseScore: number, seats: Seat[])`，请求体 `{ roomCode, baseScore: 100, players }` 改为 `{ roomCode, baseScore, players }`，调用点 `await this.startGame(room.code, seats);` 改为 `await this.startGame(room.code, room.baseScore, seats);`。docblock 补一句：

```ts
   * ⚠️ `baseScore` **必须**来自房间元数据（§3.1 `Room.baseScore` → §4.2 `game.start`）：
   * 此前这里硬编码 `100`，于是「房间底分」这条链路在最后一跳断掉（N19 / 切片 10）。
```

在 `packages/room-service/test/match.service.test.ts` 里，紧跟现有那条 `expect(gameCalls[0]![1]).toEqual({...})` 之后加一条**判别性**用例：

```ts
it('game.start 的 baseScore 来自房间元数据，不是硬编码 100（N19）', async () => {
  // 复用同一套 harness，但把房间元数据的底分换成 200
  roomsService.setBaseScore?.('ABC123', 200); // ← 若没有这个钩子，改成直接 stub roomsService.get（见下）
  // …驱动到 scanOnce，断言：
  const body = callsTo(httpService, '/api/games')[0]![1] as { baseScore: number };
  expect(body.baseScore).toBe(200);
});
```

> 该文件已有一处 `expect(gameCalls[0]![1]).toEqual({ roomCode: 'ABC123', baseScore: 100, … })` —— 把它**保留**（它钉住默认 100 的那条路）。新用例需要用**测试替身**把房间底分换成 200：优先 `vi.spyOn(roomsService, 'createGameRoom').mockResolvedValue({ ...room, baseScore: 200 })`（跑之前先读该文件的 harness，按它已有的 stub 手法写；**不要**改生产代码加测试专用钩子）。

- [ ] **Step 8: 运行确认通过 + 提交**

Run: `cd packages/room-service && pnpm vitest run test/match.service.test.ts && pnpm lint`
Expected: PASS。

```bash
git add packages/shared/src/ddz/types.ts packages/shared/src/ddz/game.ts packages/shared/src/ddz/types.test.ts \
        packages/game-service/src/game/game.types.ts packages/game-service/src/game/view.builder.ts \
        packages/room-service/src/match/match.service.ts packages/room-service/test/match.service.test.ts
git commit -m "refactor(shared,room): baseScore 上移到 GameSession 本体，房间底分真的传到 game.start（C26 前半/N19, R186)"
```

---

## Task B2: `settleGame()` 契约化 + C1/C2/C3/C26（N1 根因 / R182–R186）

**Files:**
- Modify: `packages/shared/src/ddz/types.ts`
- Modify: `packages/shared/src/ddz/settle.ts`
- Modify: `packages/shared/src/ddz/settle.test.ts`
- Modify: `packages/shared/src/ddz/types.test.ts`
- Modify: `packages/game-service/src/game/game.service.ts`（`publishEnded` 去掉多余的 `roomCode`）

**Interfaces:**
- Produces: `settleGame(session: GameSession): SettlementResult` —— 返回类型**就是** `@fight-the-landlord/protocol` 的契约 `SettlementResult`（9 字段）。
- Consumes: `session.baseScore`（Task B1）、`session.playPhase.{bombCount, landlordPlays, farmerPlays}`、`session.bidPhase.bidMultiplier`。

- [ ] **Step 1: 写失败的用例（`settle.test.ts` 全面重写）**

把 `packages/shared/src/ddz/settle.test.ts` 换成下面这份（**保留**「未结束抛错」与 C16 的「只有一名农民为空」两条的语义，其余按 C1/C2/C3/C26/N1 重写）：

```ts
import { describe, it, expect } from 'vitest';
import { validateOutbound } from '@fight-the-landlord/protocol';
import { settleGame } from './settle';
import { GameState, type GameSession } from './types';
import { createSession, dealCards } from './game';

/**
 * 夹具：**显式**给出 `playPhase`，否则 C3 落地后 `farmerPlays: 0` 会自动变成春天，
 * 把 C1 的乘法判据污染成 C3 的（R183）。
 */
function finishedSession(
  over: {
    landlordSeat?: number;
    winner: 'landlord' | 'farmer';
    bidMultiplier?: number;
    bombCount?: number;
    landlordPlays?: number;
    farmerPlays?: number;
    baseScore?: number;
    /** 打乱 players 顺序，用来暴露「下标 ≠ 座位」的 C2 缺陷。 */
    playerOrder?: number[];
  },
): GameSession {
  const landlordSeat = over.landlordSeat ?? 0;
  const base = dealCards(createSession('ROOM1', ['u0', 'u1', 'u2']));
  const order = over.playerOrder ?? [0, 1, 2];
  const players = order.map((seat) => {
    const isLandlord = seat === landlordSeat;
    const hand = isLandlord
      ? over.winner === 'landlord'
        ? []
        : [3, 4, 5]
      : over.winner === 'farmer' && seat === (landlordSeat + 1) % 3
        ? []
        : [3, 4, 5];
    return { ...base.players[seat]!, seat, isLandlord, hand };
  });
  return {
    ...base,
    state: GameState.Playing,
    baseScore: over.baseScore ?? 100,
    players,
    playPhase: {
      bombCount: over.bombCount ?? 0,
      landlordPlays: over.landlordPlays ?? 0,
      farmerPlays: over.farmerPlays ?? 1,
      consecutivePasses: 0,
    },
    bidPhase: { ...base.bidPhase, bidMultiplier: over.bidMultiplier ?? 1 },
  };
}

describe('settleGame', () => {
  it('throws when game not finished', () => {
    const dealt = dealCards(createSession('ROOM1', ['user-1', 'user-2', 'user-3']));
    expect(() => settleGame(dealt)).toThrow('Game not finished');
  });

  it('C1：倍数 = bidMultiplier × 2^bombCount（**乘法**，不是加法）', () => {
    const result = settleGame(finishedSession({ winner: 'landlord', bidMultiplier: 2, bombCount: 1, farmerPlays: 2 }));
    expect(result.multiplier).toBe(4); // 旧加法实现给 3
  });

  it('C2：landlordSeat 取**座位号**，与 players 数组下标无关', () => {
    const result = settleGame(
      finishedSession({ winner: 'landlord', landlordSeat: 1, playerOrder: [2, 0, 1] }),
    );
    expect(result.landlordSeat).toBe(1); // 下标是 2 ⇒ 旧实现给 2
    expect([...result.farmerSeats].sort()).toEqual([0, 2]);
  });

  it('C3 春天：地主胜且两农民一手未出 ⇒ spring，倍数 ×2', () => {
    const result = settleGame(finishedSession({ winner: 'landlord', bidMultiplier: 2, farmerPlays: 0 }));
    expect(result.spring).toBe('spring');
    expect(result.multiplier).toBe(4);
  });

  it('C3 反春：农民胜且地主只出过一手 ⇒ anti-spring，倍数 ×2', () => {
    const result = settleGame(finishedSession({ winner: 'farmer', bidMultiplier: 2, landlordPlays: 1 }));
    expect(result.spring).toBe('anti-spring');
    expect(result.multiplier).toBe(4);
  });

  it('C3 非春天：农民胜且地主出过两手 ⇒ none', () => {
    const result = settleGame(finishedSession({ winner: 'farmer', bidMultiplier: 2, landlordPlays: 2 }));
    expect(result.spring).toBe('none');
    expect(result.multiplier).toBe(2);
  });

  it('C26：底分来自 session.baseScore（不是硬编码 100）', () => {
    const result = settleGame(finishedSession({ winner: 'landlord', baseScore: 200, bidMultiplier: 2, farmerPlays: 2 }));
    expect(result.baseScore).toBe(200);
    expect(result.landlordScoreChange).toBe(200 * 2 * 2); // baseScore × 倍数 × 2
    expect(result.farmerScoreChange).toBe(-200 * 2);
  });

  it('§8.4：四种（胜方 × 春天）组合下分数都守恒', () => {
    const cases = [
      { winner: 'landlord' as const, landlordPlays: 3, farmerPlays: 0 },
      { winner: 'landlord' as const, landlordPlays: 3, farmerPlays: 2 },
      { winner: 'farmer' as const, landlordPlays: 1, farmerPlays: 2 },
      { winner: 'farmer' as const, landlordPlays: 4, farmerPlays: 2 },
    ];
    for (const c of cases) {
      const r = settleGame(finishedSession({ ...c, bidMultiplier: 2, bombCount: 2 }));
      expect(r.landlordScoreChange + r.farmerScoreChange * r.farmerSeats.length).toBe(0);
    }
  });

  it('N1：返回值逐字段等于契约 SettlementResult（**过得了网关的出站校验**）', () => {
    const result = settleGame(finishedSession({ winner: 'landlord', bidMultiplier: 2, farmerPlays: 2 }));
    expect(Object.keys(result).sort()).toEqual(
      [
        'baseScore', 'farmerScoreChange', 'farmerSeats', 'landlordScoreChange',
        'landlordSeat', 'multiplier', 'roomCode', 'spring', 'winner',
      ].sort(),
    );
    // 旧实现的返回值在这一行抛 `$.payload.baseScore must be a finite number, got undefined`
    expect(() => validateOutbound({ type: 'game.settlement', version: 1, payload: result })).not.toThrow();
  });

  /** C16 的判别形态（切片 9 改写，本片保留）：**只有一名**农民手牌为空。 */
  it('settles a farmer win when a single farmer has emptied their hand (C16)', () => {
    const r = settleGame(finishedSession({ winner: 'farmer', landlordPlays: 3 }));
    expect(r.winner).toBe('farmer');
    expect(r.farmerSeats).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/shared && pnpm vitest run src/ddz/settle.test.ts`
Expected: FAIL —— 至少 `C1`（期望 4、实际 3）与 `N1`（`roomCode`/`baseScore`/`spring` 缺失、`landlordSeats` 多出）红；`validateOutbound` 那条抛 `$.payload.baseScore … undefined`。

- [ ] **Step 3: 删掉第二个形状**

`packages/shared/src/ddz/types.ts`：删除内部 `export interface SettlementResult { … }` 整段，改为在 `LastPlayedHand` 的 re-export 旁边加：

```ts
/**
 * 结算结果的**唯一**形状来自契约包（玩法 §8.5 / 主规格 §6.3）。
 *
 * 切片 10（N1）之前这里有一份**同名不同形**的内部接口（`landlordSeats` 有、`baseScore`
 * 与 `spring` 无），于是 `settle.ts` 产出的载荷过不了网关的 `validateOutbound`，
 * `game.settlement` **整条**被拦掉 —— 不是字段是 `undefined`，而是事件根本不存在。
 * 与 `LastPlayedHand` 同一手法（R157）：**不允许有第二个形状**。
 */
export type { SettlementResult } from '@fight-the-landlord/protocol';
```

- [ ] **Step 4: 重写 `settle.ts`**

```ts
import type { SettlementResult } from '@fight-the-landlord/protocol';
import { GameSession } from './types';
// R161：胜负判定只有一份实现（`play.ts`）。此前本文件有一份**重复**的
// `checkWinCondition`（同样是 `farmers.every(...)`），所以 C16 必须被修两次。
import { checkWinCondition } from './play';

/**
 * 结算（玩法 §8.1–§8.5）。
 *
 * 返回**契约类型**（N1/R182）：`roomCode` / `baseScore` / `landlordSeat` / `spring`
 * 都在里面，因此调用方**不得**再拼字段（`game-service` 旧实现的 `{...result, roomCode}`
 * 就是第二个真源的入口）。
 *
 * 判定顺序是规格（R185）：`winner` → `spring` → `springMultiplier` → `multiplier` → `unitScore`。
 */
export function settleGame(session: GameSession): SettlementResult {
  const winner = checkWinCondition(session);
  if (!winner) {
    throw new Error('Game not finished');
  }

  const landlord = session.players.find(p => p.isLandlord);
  if (!landlord) {
    throw new Error('No landlord in session');
  }

  const spring = resolveSpring(session, winner);
  const springMultiplier = spring === 'none' ? 1 : 2;

  // §8.2：**乘法**合成（C1）。旧实现是 `bombCount + bidMultiplier`。
  const multiplier = session.bidPhase.bidMultiplier * 2 ** session.playPhase.bombCount * springMultiplier;

  // §8.4：区分「底分」（baseScore）与「单家得失」（unitScore）—— 旧实现的局部变量名
  // `baseScore = 100 * multiplier` 与「底分」冲突，是本条偏差的语言层根源。
  const unitScore = session.baseScore * multiplier;
  const landlordScoreChange = winner === 'landlord' ? unitScore * 2 : -unitScore * 2;
  const farmerScoreChange = winner === 'landlord' ? -unitScore : unitScore;

  return {
    roomCode: session.roomCode,
    baseScore: session.baseScore,
    winner,
    // §8.5 末注：**座位号**，不是 `players` 数组下标（C2）。3 人局下两者常相等，
    // 因此唯一能抓住它的判据是「座位与下标不一致」的夹具（settle.test.ts）。
    landlordSeat: landlord.seat,
    farmerSeats: session.players.filter(p => !p.isLandlord).map(p => p.seat),
    multiplier,
    spring,
    landlordScoreChange,
    farmerScoreChange,
  };
}

/**
 * 春天 / 反春（玩法 §8.3，逐字两条）：
 *  - 春天：**地主胜** 且两农民一手未出（`farmerPlays === 0`）
 *  - 反春：**农民胜** 且地主**恰好**出过一手（`landlordPlays === 1`）
 */
function resolveSpring(
  session: GameSession,
  winner: 'landlord' | 'farmer',
): 'none' | 'spring' | 'anti-spring' {
  if (winner === 'landlord' && session.playPhase.farmerPlays === 0) return 'spring';
  if (winner === 'farmer' && session.playPhase.landlordPlays === 1) return 'anti-spring';
  return 'none';
}
```

- [ ] **Step 5: 运行确认通过（shared）**

Run: `cd packages/shared && pnpm vitest run src/ddz && pnpm lint`
Expected: PASS。⚠️ 若 `types.test.ts` 的 `describe('SettlementResult')` 报错，按 Step 6 改。

- [ ] **Step 6: 改 `types.test.ts` 的 SettlementResult 段**

```ts
describe('SettlementResult', () => {
  /** R182：shared 的 `SettlementResult` **就是** protocol 的那一个（没有第二个形状）。 */
  it('has the contract structure (roomCode/baseScore/landlordSeat/spring)', () => {
    const result: SettlementResult = {
      roomCode: 'ROOM1',
      baseScore: 100,
      winner: 'landlord',
      landlordSeat: 0,
      farmerSeats: [1, 2],
      multiplier: 2,
      spring: 'none',
      landlordScoreChange: 400,
      farmerScoreChange: -200,
    };
    expect(result.landlordSeat).toBe(0);
    expect(result.farmerSeats).toHaveLength(2);
    expect(Object.keys(result)).toHaveLength(9);
  });
});
```

- [ ] **Step 7: 去掉 game-service 的第二次拼装**

`packages/game-service/src/game/game.service.ts` 的 `publishEnded`：

```ts
  private async publishEnded(roomCode: string, session: GameSession): Promise<void> {
    // `settleGame()` 返回的就是契约 `SettlementResult`（含 `roomCode`）⇒ **不得**再拼一次（R187）。
    const result = settleGame(session);
    await this.redis.publish(
      GAME_EVENTS_CHANNEL,
      JSON.stringify({ event: 'game.ended', roomCode, version: session.version, result }),
    );
  }
```

- [ ] **Step 8: 运行确认通过（两个包）+ 提交**

Run: `cd packages/shared && pnpm vitest run && pnpm lint && cd ../game-service && pnpm vitest run && pnpm lint`
Expected: PASS。

```bash
git add packages/shared/src/ddz/types.ts packages/shared/src/ddz/settle.ts packages/shared/src/ddz/settle.test.ts \
        packages/shared/src/ddz/types.test.ts packages/game-service/src/game/game.service.ts
git commit -m "fix(shared): 结算复用契约 SettlementResult —— C1 乘法 / C2 座位号 / C3 春天 / C26 底分（N1 根因, R182-R186)"
```

---

## Task B3: N17 局终视图（R187）

**Files:**
- Modify: `packages/game-service/src/game/game.service.ts`
- Modify: `packages/game-service/test/game.service.test.ts`
- Modify: `packages/room-service/src/gateway/ws.gateway.ts`
- Modify: `packages/room-service/test/ws.gateway.test.ts`

**Interfaces:**
- Produces: 对局结束时 `game:events` 上先出现一条 `{ event: 'game.state_updated', seatViews: [三家 state==='ended' 的 PlayerView] }`，随后一条 `{ event: 'game.ended', result: SettlementResult }`；room-service 对 `state==='ended'` 的座位只发 `game.state_update`，不发 `game.current_turn`。
- Consumes: `settleGame()`（Task B2）、`buildAllSeatViews()`（已存在）。

- [ ] **Step 1: 写失败的用例（game-service）**

先读 `packages/game-service/test/game.service.test.ts` 与 `full-game.test.ts`，找到已有的 redis 替身/发布断言手法（`packages/game-service/test/helpers/`）。在其中加：

```ts
it('N17：局终先发 state==="ended" 的裁剪视图，再发 game.ended（§6.7 顺序）', async () => {
  // …用该文件已有的手法把一个会话推到「最后一张打出即获胜」（可参考 full-game.test.ts 的驱动）
  // 断言：
  // 1) 第一条 game.state_updated：三家 seatViews 的 state === 'ended'、version === 最终版、胜者 cardCounts[seat] === 0
  // 2) 第二条 game.ended：result 逐字段等于契约（含 roomCode/baseScore/spring/landlordSeat）
  // 3) published 数组里 state_updated 的下标 < game.ended 的下标
  const published = /* 该文件已有的 redis.publish 收集器 */;
  const endedViewIdx = published.findIndex((p) => JSON.parse(p[1]).event === 'game.state_updated');
  const endedIdx = published.findIndex((p) => JSON.parse(p[1]).event === 'game.ended');
  expect(endedViewIdx).toBeGreaterThanOrEqual(0);
  expect(endedViewIdx).toBeLessThan(endedIdx);
  const views = JSON.parse(published[endedViewIdx]![1]).seatViews as Array<{ state: string }>;
  expect(views.map((v) => v.state)).toEqual(['ended', 'ended', 'ended']);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/game-service && pnpm vitest run test/game.service.test.ts test/full-game.test.ts`
Expected: FAIL —— `endedViewIdx === -1`（当前终局**不发** `game.state_updated`）。

- [ ] **Step 3: 最小实现（game-service）**

`finishTransition()` 的 winner 分支：

```ts
    if (winner) {
      session.winner = winner;
      session.state = GameState.Ended;
      session.finishedAt = new Date();
      this.clearTimer(roomCode);
      await this.saveSession(roomCode, session);
      // N17/R187：局终也要下发 `state==='ended'` 的裁剪视图 —— 它就是此前**整体缺失**的
      // 「最后一手」视图（切片 9 实测：逐手在线可观测 19/20、15/16）。
      // 顺序不可反：§6.7 要求同一次转移内 `game.state_update` 先到并被客户端应用，
      // 否则结算渲染时看不到最终手牌张数（`game.settlement` 与 `game.current_turn` 都不带 `cardCounts`）。
      await this.publishSeatViews('game.state_updated', session);
      await this.publishEnded(roomCode, session);
      this.logger.log(`Game ${roomCode} ended. Winner: ${winner}`);
      return;
    }
```

- [ ] **Step 4: 运行确认通过（game-service）**

Run: `cd packages/game-service && pnpm vitest run && pnpm lint`
Expected: PASS。

- [ ] **Step 5: 写失败的用例（room-service）**

`packages/room-service/test/ws.gateway.test.ts`（紧跟现有 `translates game.state_updated into game.state_update + game.current_turn` 之后）：

```ts
it('N17：终局视图（state=ended）只发 game.state_update，不发 game.current_turn', () => {
  // 用该文件已有的 socket 替身与 seatOwners 装配手法，投递：
  //   { event: 'game.state_updated', roomCode, version: 7, seatViews: [endedView(seat 0), …] }
  // 正对照（必须先证明探针能观测到「发生」，R115）：同一份用例先投一条 state==='playing' 的同形状事件，
  // 断言它**确实**发了 game.current_turn（version 为那条的版本）。
  const ended = /* endedViewFixture */;
  gateway.onGameEvent({ event: 'game.state_updated', roomCode: 'ABC123', version: 7, seatViews: [ended] });
  const types07 = socket.emitted.filter(([t, m]) => m.version === 7).map(([t]) => t);
  expect(types07).toEqual(['game.state_update']);

  gateway.onGameEvent({ event: 'game.state_updated', roomCode: 'ABC123', version: 8, seatViews: [{ ...ended, state: 'playing' }] });
  const types08 = socket.emitted.filter(([t, m]) => m.version === 8).map(([t]) => t);
  expect(types08).toEqual(['game.state_update', 'game.current_turn']);
});
```

- [ ] **Step 6: 运行确认失败**

Run: `cd packages/room-service && pnpm vitest run test/ws.gateway.test.ts`
Expected: FAIL —— version 7 实际是 `['game.state_update', 'game.current_turn']`。

- [ ] **Step 7: 最小实现（room-service）**

`onGameEvent()` 的通用分支：

```ts
    const type = event.event === 'game.started' ? 'game.deal' : 'game.state_update';
    for (const view of event.seatViews ?? []) {
      const owner = this.seatOwners.get(`${view.roomCode}:${view.seat}`);
      const socket = owner ? this.activeConnections.get(owner) : undefined;
      if (!socket) continue;
      this.emitToSeat(socket, type, envelope(event.version, view));
      // N17/R187：终局**没有**「下一回合」⇒ 不发 `game.current_turn`。
      // 否则客户端会在 `state==='ended'` 之后收到一条 `currentTurnPayload()` 算出来的
      // 假 `timeoutMs`（它读的是已经不再推进的 `turnDeadlineAt`）。
      if (view.state === 'ended') continue;
      this.emitToSeat(socket, 'game.current_turn', envelope(event.version, currentTurnPayload(view)));
    }
```

- [ ] **Step 8: 运行确认通过（两个包）+ 提交**

Run: `cd packages/room-service && pnpm vitest run && pnpm lint`
Expected: PASS。

```bash
git add packages/game-service/src/game/game.service.ts packages/game-service/test/game.service.test.ts \
        packages/room-service/src/gateway/ws.gateway.ts packages/room-service/test/ws.gateway.test.ts
git commit -m "fix(game,room): 局终下发 state=ended 的裁剪视图，终局不再发 game.current_turn（N17, R187)"
```

**后端 DoD**：`cd .worktrees/backend && pnpm exec turbo run test lint --force` 全绿（任务数随 `lint` 的 `^build` 会略多于 29，**不是**回归）；`pnpm exec turbo run build --force` 10/10。汇报必须附 `settle.test.ts` 的实际输出与 `validateOutbound` 那条的**修前 RED 原文**。

---

## Task F1: 前端结算页（R188）

**Files:**
- Create: `apps/client/src/components/Settlement.vue`
- Modify: `apps/client/src/pages/table.vue`
- Create: `apps/client/test/table-settlement-ui.test.ts`

**Interfaces:**
- Consumes: `SettlementResult`（`@fight-the-landlord/protocol`）、`store.settlement`（`stores/game.ts` 已存在，由 `game.settlement` 事件写入）。
- Produces: `Settlement.vue`，props `{ settlement: SettlementResult }`，根节点 class `.table__settlement`。

- [ ] **Step 1: 写失败的用例**

先读 `apps/client/test/table-play-ui.test.ts`（mount 手法、`fake-socket`、`playerViewFixture`）与 `stores/game.ts` 的 `applyEvent`。新建 `apps/client/test/table-settlement-ui.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
// …沿用 table-play-ui.test.ts 的装配：createTestingPinia? 该仓库用真 pinia + fake socket（照抄它）
import Settlement from '../src/components/Settlement.vue';
import type { SettlementResult } from '@fight-the-landlord/protocol';

/**
 * 夹具刻意用「算不出来」的数：`multiplier` 与分数变动**不自洽**
 * （777 ≠ 100 × 4 × 2）。若前端偷偷"修正"或自行计算，这条用例立刻红（R188/F02）。
 */
const FIXTURE: SettlementResult = {
  roomCode: 'ROOM01',
  baseScore: 100,
  winner: 'landlord',
  landlordSeat: 2,
  farmerSeats: [0, 1],
  multiplier: 4,
  spring: 'spring',
  landlordScoreChange: 777,
  farmerScoreChange: -388.5,
};

describe('结算页（§12.1 F02：只展示服务端下发的值）', () => {
  it('六个数字/文本字段逐字渲染服务端载荷', () => {
    const w = mount(Settlement, { props: { settlement: FIXTURE } });
    expect(w.get('.settlement__winner').text()).toContain('landlord');
    expect(w.get('.settlement__multiplier').text()).toContain('4');
    expect(w.get('.settlement__base-score').text()).toContain('100');
    expect(w.get('.settlement__landlord-seat').text()).toContain('2');
    expect(w.get('.settlement__farmer-seats').text()).toContain('0');
    expect(w.get('.settlement__landlord-delta').text()).toContain('777');
    expect(w.get('.settlement__farmer-delta').text()).toContain('-388.5');
  });

  it.each([
    ['none', '无'],
    ['spring', '春天'],
    ['anti-spring', '反春天'],
  ] as const)('spring=%s 显示「%s」（展示文案映射，不是规则判断）', (spring, label) => {
    const w = mount(Settlement, { props: { settlement: { ...FIXTURE, spring } } });
    expect(w.get('.settlement__spring').text()).toContain(label);
  });

  it('table.vue 只在 store.settlement 非 null 时渲染（M07：不预判胜负）', async () => {
    // 用 table-play-ui.test.ts 的装配手法 mount(Table)：
    // ① 未喂 game.settlement ⇒ 不存在 .table__settlement
    // ② 推一条 game.settlement（真实信封 { type, version, payload }）⇒ 存在，且文本含夹具里的 777
    // ③ 正对照：证明 ② 的探针确实能观测到「出现」（即 ① 的「不存在」不是坏探针）
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/client && pnpm vitest run test/table-settlement-ui.test.ts`
Expected: FAIL —— `Cannot find module '../src/components/Settlement.vue'`。

- [ ] **Step 3: 写组件**

`apps/client/src/components/Settlement.vue`：

```vue
<script setup lang="ts">
/**
 * 结算面板（玩法 §8.5 / 主规格 §6.3 的 `game.settlement` 载荷）。
 *
 * ⚠️ 本组件**一个数都不算**（§12.1 F01/F02/F10、M09）：
 *  - 倍数、底分、分差全部**原样**渲染服务端下发的字段；
 *  - 唯一的本地映射是 `spring` 的**展示文案**（`none|spring|anti-spring` → 中文），
 *    这是枚举到文案的翻译，**不是**规则判断（谁赢、赢了怎么算都在服务端）；
 *  - 不得出现任何牌型/倍数/胜负推导，也不得出现底分字面量
 *    （`test/source-boundary.test.ts` 会机械扫描 `src/**`）。
 */
import type { SettlementResult } from '@fight-the-landlord/protocol';

defineProps<{ settlement: SettlementResult }>();

/** 春天三态的展示文案。键集**必须**与契约的联合类型逐字对齐（少一个键就渲染出 undefined）。 */
const SPRING_LABEL: Record<SettlementResult['spring'], string> = {
  none: '无',
  spring: '春天',
  'anti-spring': '反春天',
};
</script>

<template>
  <div class="table__settlement">
    <h3>结算</h3>
    <p class="settlement__winner">胜方：{{ settlement.winner }}</p>
    <p class="settlement__spring">春天：{{ SPRING_LABEL[settlement.spring] }}</p>
    <p class="settlement__multiplier">倍数：{{ settlement.multiplier }}</p>
    <p class="settlement__base-score">底分：{{ settlement.baseScore }}</p>
    <p class="settlement__landlord-seat">地主座位：{{ settlement.landlordSeat }}</p>
    <p class="settlement__farmer-seats">农民座位：{{ settlement.farmerSeats.join('、') }}</p>
    <p class="settlement__landlord-delta">地主变动：{{ settlement.landlordScoreChange }}</p>
    <p class="settlement__farmer-delta">农民变动：{{ settlement.farmerScoreChange }}</p>
  </div>
</template>
```

`apps/client/src/pages/table.vue`：把现有那段内联的 `.table__settlement` 整块**删除**，改为

```vue
      <Settlement v-if="store.settlement" :settlement="store.settlement" />
```

并在 `<script setup>` 的 import 区加 `import Settlement from '../components/Settlement.vue';`。`<style scoped>` 里的 `.table__settlement` 样式**保留**（子组件根节点也吃 scoped 属性，规则仍生效）——若发现样式失效，把 `:deep()` 或把样式块搬进 `Settlement.vue` 的 `<style scoped>`（**二选一**，不要两处都留）。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/client && pnpm vitest run test/table-settlement-ui.test.ts && pnpm lint`
Expected: PASS。

- [ ] **Step 5: 跑全量前端测试确认无回归（尤其 `source-boundary`）**

Run: `cd apps/client && pnpm test`
Expected: PASS，`source-boundary.test.ts` 全绿（新组件的类名与文案不触发任何禁用标识符/字面量）。

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/components/Settlement.vue apps/client/src/pages/table.vue apps/client/test/table-settlement-ui.test.ts
git commit -m "feat(client): 结算页组件（只渲染服务端 SettlementResult，零计算, R188)"
```

---

## Task F2: N17 终局态 UI（R189）

**Files:**
- Modify: `apps/client/src/stores/game.ts`
- Modify: `apps/client/src/pages/table.vue`
- Create: `apps/client/test/table-ended-ui.test.ts`

**Interfaces:**
- Consumes: `store.view.state === 'ended'`（切片 10 后端 N17 之后**才会**出现）。
- Produces: getter `isEnded: boolean`；终局 DOM 锚点 `.table__ended`；顶栏终局文案 `已结束`。

- [ ] **Step 1: 写失败的用例**

`apps/client/test/table-ended-ui.test.ts`（装配照抄 `table-play-ui.test.ts`，`playerViewFixture` 来自 `test/helpers/fake-socket.ts`）：

```ts
describe('终局态 UI（N17）', () => {
  it('state=ended ⇒ 只显示「本局结束」，四个动作 class 一个都不存在', () => {
    // 推一条 game.state_update，payload 用：
    //   playerViewFixture({ state: 'ended', hand: [], cardCounts: [0, 17, 17], winner: 'landlord',
    //                       landlordSeat: 0, currentPlayer: 0 })
    const w = /* mount(Table) */;
    expect(w.find('.table__ended').exists()).toBe(true);
    for (const sel of ['.table__play', '.table__pass', '.table__bid-grab', '.table__bid-pass']) {
      expect(w.find(sel).exists(), `${sel} 在终局不得存在`).toBe(false);
    }
    expect(w.find('.table__bar').text()).toContain('已结束');
    expect(w.find('.table__bar').text()).not.toContain('出牌中');
    expect(w.find('.table__bar').text()).not.toContain('叫抢中');
  });

  it('正对照：state=playing ⇒ .table__play/.table__pass 存在（证明选择器与夹具能观测到「存在」）', () => {
    // 同一套装配，payload 用 playerViewFixture({ state: 'playing', currentPlayer: mySeat })
    expect(w.find('.table__play').exists()).toBe(true);
    expect(w.find('.table__pass').exists()).toBe(true);
    expect(w.find('.table__ended').exists()).toBe(false);
  });

  it('终局不渲染倒计时（actorSeat 在 ended 下为 null）', () => {
    // state='ended' 时 .seat__timer 不存在
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/client && pnpm vitest run test/table-ended-ui.test.ts`
Expected: FAIL —— `.table__ended` 不存在（当前终局落进 `<span v-else-if="!store.isMyTurn">等待其他玩家…</span>` 或什么都不渲染）。

- [ ] **Step 3: 最小实现**

`apps/client/src/stores/game.ts` 的 getters 里（`isPlaying` 之后）：

```ts
    /** 局终（N17）：服务端下发了 `state='ended'` 的视图 ⇒ 没有下一步动作，UI 必须停止显示动作按钮。 */
    isEnded: (s): boolean => s.view?.state === 'ended',
```

`apps/client/src/pages/table.vue` 顶栏：

```vue
      <span v-if="store.isBidding">叫抢中</span>
      <span v-else-if="store.isPlaying">出牌中</span>
      <span v-else-if="store.isEnded">已结束</span>
      <span v-else>{{ store.view?.state ?? '等待发牌' }}</span>
```

动作区（在 `v-else-if="store.isPlaying"` 那一支**之后**、`<span v-else-if="!store.isMyTurn">` **之前**）：

```vue
        <!-- N17：终局没有下一步动作。**不得**在这里读 winner 拼结果文案（M07：结果只由
             game.finished / game.settlement 渲染）——这里只说明「没有动作可做了」。 -->
        <span v-else-if="store.isEnded" class="table__ended">本局结束</span>
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/client && pnpm vitest run test/table-ended-ui.test.ts test/table-play-ui.test.ts test/table-bid-ui.test.ts`
Expected: PASS（三条都绿）。

- [ ] **Step 5: 全量 + 构建 + 提交**

Run: `cd apps/client && pnpm test && pnpm lint && pnpm build`
Expected: PASS（`vue-tsc` 干净、`build` OK）。

```bash
git add apps/client/src/stores/game.ts apps/client/src/pages/table.vue apps/client/test/table-ended-ui.test.ts
git commit -m "feat(client): 终局态 UI（.table__ended + isEnded + 顶栏三态, N17/R189)"
```

**前端 DoD**：`cd .worktrees/frontend && cd apps/client && pnpm test && pnpm lint && pnpm build` 全绿；`pnpm exec turbo run test lint --force` 全绿。汇报附新增用例数与 `source-boundary.test.ts` 的实际输出。

---

## Task C1: 抽取共享牌局驱动（R190①）

**Files:**
- Create: `tools/conformance/src/lib/ddz-driver.ts`
- Modify: `tools/conformance/src/slices/slice-09-play-rotation.ts`

**Interfaces:**
- Produces（`lib/ddz-driver.ts` 的具名导出）：`STEP_TIMEOUT_MS`、`MATCH_TIMEOUT_MS`、`MAX_TRICKS`、`MSG_INTERVAL_MS`、`FreshRoom`、`PlayViewWire`、`startFreshRoom`、`sendThrottled`、`currentView`、`firstView`、`waitForNewerVersion`、`waitForVersion`、`syncAll`、`extremeByRank`、`smallestBeatingSingle`、`checkSingleCaliber`、`deckValues`、`handsInfo`、`playAndSync`、`passAndSync`、`playFinalHand`、`passCurrent`、`playBiddingToPlaying`。
- Consumes: `tools/conformance/src/lib/{assert,http,client}.ts`（不动）。

- [ ] **Step 1: 机械搬迁，不改一个字符的语义**

把 `slice-09-play-rotation.ts` 里上列函数（含 `PlayViewWire` / `LastPlayedHandWire` / `FreshRoom` / `lastSentAt` / `sendThrottled` 的节流 map）**整段**搬进 `lib/ddz-driver.ts`，导出它们；文件头写清「本文件是 slice-09/10 共用的**唯一**牌局驱动 —— 两个切片各抄一份必然漂移」。`slice-09` 改为：

```ts
import {
  MATCH_TIMEOUT_MS, MAX_TRICKS, STEP_TIMEOUT_MS,
  currentView, deckValues, extremeByRank, firstView, handsInfo, passCurrent, playAndSync,
  playBiddingToPlaying, playFinalHand, sendThrottled, sleep, startFreshRoom, syncAll,
  waitForNewerVersion, type FreshRoom, type PlayViewWire,
} from '../lib/ddz-driver';
```

⚠️ `sleep` 来自 `lib/assert`（驱动内部也用它）—— 在驱动里 re-export 一次，切片只需一个 import 源。
⚠️ `selectedSteps()` / `ALL_STEPS` / `StepId` 与三个场景主体**留在 `slice-09`**。

- [ ] **Step 2: 跑切片确认行为未变**

```bash
cd /home/howe/pokergame && pnpm --filter @fight-the-landlord/conformance build
timeout 300 node tools/conformance/dist/run.js slice-09
```
Expected: ✅ **155 项**（与切片 9 门禁记录的项数逐字相同）。项数变了就说明搬迁改了语义 —— **不要**改断言去迁就，回头找差异。

- [ ] **Step 3: 提交**

```bash
git add tools/conformance/src/lib/ddz-driver.ts tools/conformance/src/slices/slice-09-play-rotation.ts
git commit -m "refactor(conformance): 抽出 slice-09/10 共用的牌局驱动 lib/ddz-driver.ts（R190①）"
```

---

## Task C2: `slice-10` + 恢复 `slice-09` 的结算断言（R190②③）

**Files:**
- Create: `tools/conformance/src/slices/slice-10-settlement.ts`
- Modify: `tools/conformance/src/slices/slice-09-play-rotation.ts`
- Modify: `tools/conformance/src/run.ts`
- Modify: `tools/conformance/package.json`

**Interfaces:**
- Produces: `runSlice10(): Promise<Checks>`；步骤 id `'a'`（地主胜 + 春天）、`'b'`（农民胜 + 反春）；`pnpm --filter @fight-the-landlord/conformance conformance:slice-10`。
- Consumes: `lib/ddz-driver.ts`（Task C1）。

- [ ] **Step 1: 写 `slice-10-settlement.ts`**

结构照抄 `slice-09`（`Checks` / `step` / `info` / `ConformanceError` / `CONFORMANCE_STEPS` 的未知 id 必须在任何网络动作**之前**抛错 / `R155` 换房前 `close()` + `sleep(400)`）。两个场景各起一个房间，驱动方式与 slice-09 的场景 A/B 相同（先 `playBiddingToPlaying`，再逐墩首出单张、两家过牌）。核心断言（**每条都要有 RED 可读性**：把实际值拼进消息）：

```ts
/**
 * 结算载荷的**唯一**合法字段集（玩法 §8.5 / 主规格 §6.3）。
 * 「多一个字段」与「少一个字段」都必须红 —— 这是 N1 的机械判据。
 */
const SETTLEMENT_KEYS = [
  'roomCode', 'baseScore', 'winner', 'landlordSeat', 'farmerSeats',
  'multiplier', 'spring', 'landlordScoreChange', 'farmerScoreChange',
];

interface SettlementWire {
  roomCode: string; baseScore: number; winner: 'landlord' | 'farmer';
  landlordSeat: number; farmerSeats: number[]; multiplier: number;
  spring: 'none' | 'spring' | 'anti-spring';
  landlordScoreChange: number; farmerScoreChange: number;
}

function checkSettlement(
  raw: unknown,
  room: FreshRoom,
  finalView: PlayViewWire,
  expectedWinner: 'landlord' | 'farmer',
  expectedSpring: 'spring' | 'anti-spring',
  checks: Checks,
): SettlementWire {
  const s = raw as SettlementWire;
  const keys = Object.keys(s).sort();
  checks.that(
    JSON.stringify(keys) === JSON.stringify([...SETTLEMENT_KEYS].sort()),
    `结算载荷字段集必须逐字等于契约（多一个/少一个都红）：实际 ${JSON.stringify(keys)}`,
  );
  checks.eq(s.roomCode, room.roomCode, 'roomCode 与房间一致');
  checks.eq(s.baseScore, 100, '默认底分 100（§8.1；房间未指定底分）');
  checks.eq(s.winner, expectedWinner, 'winner 与 game.finished 一致');
  checks.eq(s.landlordSeat, finalView.landlordSeat, 'landlordSeat = 视图里的地主座位（C2）');
  checks.that(
    JSON.stringify([...s.farmerSeats].sort()) === JSON.stringify([0, 1, 2].filter((x) => x !== finalView.landlordSeat)),
    `farmerSeats 恰好是另外两家：实际 ${JSON.stringify(s.farmerSeats)}`,
  );
  checks.eq(s.spring, expectedSpring, `春天：地主胜且农民一手未出 ≠ 该值 / 农民胜且地主恰好一手 ⇒ ${expectedSpring}（C3）`);

  // C1：倍数 = bidMultiplier × 2^bombCount × 春天倍数（本场景全是单张 ⇒ bombCount 0、春天倍数为 2）
  const expectedMultiplier = finalView.bidPhase.bidMultiplier * 2 ** finalView.playPhase.bombCount * 2;
  checks.eq(s.multiplier, expectedMultiplier, `倍数按 §8.2 乘法合成（旧加法实现给 ${finalView.bidPhase.bidMultiplier}）`);
  // C26：底分必须是**载荷里的** baseScore，不是写死的 100
  checks.eq(s.landlordScoreChange, expectedWinner === 'landlord' ? s.baseScore * s.multiplier * 2 : -s.baseScore * s.multiplier * 2, '地主变动（§8.4）');
  checks.eq(s.farmerScoreChange, expectedWinner === 'landlord' ? -s.baseScore * s.multiplier : s.baseScore * s.multiplier, '每名农民变动（§8.4）');
  checks.eq(s.landlordScoreChange + s.farmerScoreChange * s.farmerSeats.length, 0, '分数守恒：地主 + 两农民 = 0（§8.4）');
  return s;
}
```

`checkSettlement` 之上，场景 A/B 各自还要断言：

```ts
      // ── N1：三家**都**收到结算（旧实现整条被网关出站校验拦掉）────────────
      const settlements = await Promise.all(
        room.clients.map((c) => c.waitFor('game.settlement', STEP_TIMEOUT_MS)),
      );
      checks.eq(settlements.length, 3, '三家都收到 game.settlement（N1：旧实现 0 家）');
      assertNoLeak(settlements[0]!.payload, 'game.settlement'); // §6.4 规则 4：actionLog/isRobot/botId/… 一个都不许有

      // ── N17：局终视图（state='ended'）──────────────────────────────────
      const endedVersion = finalView.version;
      for (const c of room.clients) {
        const ended = await c.waitFor(
          'game.state_update',
          STEP_TIMEOUT_MS,
          (m: any) => (m.payload as PlayViewWire).state === 'ended',
        );
        checks.eq(ended.payload.version, endedVersion, '终局视图与最后一手同版本（§6.7）');
        checks.eq(ended.payload.cardCounts[expectedWinner === 'landlord' ? ended.payload.landlordSeat : /* 农民胜者 */ winnerSeat], 0, '终局视图里胜者张数为 0');
      }
      // 顺序（结构性判据，不依赖时间）：ended 快照必须**先于** game.settlement 到达
      const idxOf = (c: HarnessClient, type: string, pred: (m: any) => boolean) =>
        c.received.findIndex((r) => r.type === type && pred(r.message));
      const first = room.clients[0]!;
      const endedIdx = idxOf(first, 'game.state_update', (m) => m.payload.state === 'ended');
      const settleIdx = idxOf(first, 'game.settlement', () => true);
      checks.that(endedIdx >= 0 && settleIdx >= 0 && endedIdx < settleIdx, `ended 视图必须先于结算到达（ended@${endedIdx}, settlement@${settleIdx}）`);

      // 终局**不发** current_turn + **正对照**（非终局的最后一版确实有）
      const turnsAtEnd = first.received.filter((r) => r.type === 'game.current_turn' && r.message.version === endedVersion).length;
      checks.eq(turnsAtEnd, 0, '终局版不发 game.current_turn（R187）');
      const turnsBefore = first.received.filter((r) => r.type === 'game.current_turn' && r.message.version === endedVersion - 1).length;
      checks.that(turnsBefore > 0, `正对照：上一版 v${endedVersion - 1} 确实有 game.current_turn（实际 ${turnsBefore} 条）`);
```

外加**逐手覆盖度**的两条硬断言（N17 的量化形态，切片 9 时是 `info` 里的 19/20、15/16）：

```ts
      checks.eq(observedA, 20, '终局视图补齐后，地主 20 墩**逐手**都在线可观测（旧实现 19/20）');
      checks.eq(observedB, 16, '终局视图补齐后，农民 16 墩逐手可观测（旧实现 15/16）');
```
（`observedA/B` 的计数方式：非终局手仍按 slice-09 的写法在 `playAndSync` 之后 +1；**终局手**在 `playFinalHand` 之后必须再 `await actor.waitFor('game.state_update', STEP_TIMEOUT_MS, m => m.payload.state === 'ended')` 拿到**终局那一版视图**，对它跑一次 `checkSingleCaliber(ended.payload, card, violations)` 并 +1 —— 这就是 N17 的量化判据：旧实现永远等不到这一版，`observedA` 停在 19、`observedB` 停在 15，两条硬断言必红。两条 `info` 必须放在断言**之前**，带上本房牌值与实际打出的单张 —— R171②/R181。）

- [ ] **Step 2: 注册切片并跑（在当前 master 上，**预期 RED**）**

`run.ts`：`import { runSlice10 } from './slices/slice-10-settlement';` + 表里加 `'slice-10': { title: '结算（N1/守恒/N17）', run: runSlice10 },`。
`package.json`：加 `"conformance:slice-10": "node dist/run.js slice-10"`。

```bash
cd /home/howe/pokergame
pnpm --filter @fight-the-landlord/conformance build
timeout 300 node tools/conformance/dist/run.js slice-10; echo "exit=$?"
```
Expected（**负对照，必须逐字记进汇报**）：RED，且第一条就落在结算上 —— 在当前未修栈上 `game.settlement` **根本不到达**，因此原文应是 `等 game.settlement 超时（8000ms）`（而不是「字段不对」）。把原文抄进汇报。
⚠️ 这一跑在**未修**栈上是**预期红**，不是你的实现有问题。**不要**为了变绿去放宽断言。

- [ ] **Step 3: 恢复 `slice-09` 的结算断言（R190③）**

场景 A：把那段「本片不断言 `game.settlement` 到达」的长注释 + `info(...)` **整段替换**为：

```ts
      // N1 已由切片 10 关闭（`settleGame()` 复用契约类型 ⇒ 过得了网关的 `validateOutbound`）。
      // 判据恢复的正是切片 9 注释里预留的写法 —— 在那之前「结算推送能到达客户端」没有任何在线判据。
      const settlementA = await landlord.waitFor('game.settlement', STEP_TIMEOUT_MS);
      checks.eq(settlementA.payload.winner, 'landlord', 'game.settlement.winner = landlord（N1 恢复）');
      checks.eq(settlementA.payload.spring, 'spring', '两农民全程过牌 ⇒ 春天（C3 的在线判据）');
      checks.eq(settlementA.payload.multiplier, currentView(landlord).bidPhase.bidMultiplier * 2, '倍数 = 叫抢倍数 × 春天 2（C1 的在线判据）');
```

场景 B 同位置替换为：

```ts
      // N1（切片 9 预留、切片 10 恢复）：场景 B 的农民胜结算必须到达。
      const settlementB = await farmerB.waitFor('game.settlement', STEP_TIMEOUT_MS);
      checks.eq(settlementB.payload.winner, 'farmer', 'game.settlement.winner = farmer（N1 恢复）');
      checks.eq(settlementB.payload.spring, 'anti-spring', '地主只出过一手 ⇒ 反春（C3 的在线判据）');
```
（`farmerB` 用该场景里**已经存在的**那个「压过地主并连打」的农民客户端变量名 —— 写之前先在文件里核对它的实际名字，**不要**新起一个。）

- [ ] **Step 4: 提交（此时切片 10 在未修栈上是红，属预期）**

```bash
git add tools/conformance/src/slices/slice-10-settlement.ts tools/conformance/src/slices/slice-09-play-rotation.ts \
        tools/conformance/src/run.ts tools/conformance/package.json
git commit -m "test(conformance): 新增 slice-10（结算载荷/守恒/N17）+ 恢复 slice-09 的 game.settlement 断言（R190)"
```

---

## Task C3: 负对照取证（R193③）

- [ ] **在未修栈上逐条取 RED 原文**（`CONFORMANCE_STEPS` 逐步，fail-fast 会挡住后面的断言）：

```bash
cd /home/howe/pokergame
for s in a b; do
  echo "== step $s =="
  CONFORMANCE_STEPS=$s timeout 300 node tools/conformance/dist/run.js slice-10 2>&1 | tail -20
done
timeout 300 node tools/conformance/dist/run.js slice-09 2>&1 | tail -20
```

Expected（逐字抄进汇报）：`slice-10` 的场景 A 在 `等 game.settlement 超时（8000ms）` 处红（N1 的活体形态）；`slice-09` 恢复的两条断言同样红（这证明「恢复断言」这件事本身是**有判别力**的，不是装饰）。
⚠️ 若容器不是当前 master 的镜像，先按门禁章节重建（`--force` build + `DOCKER_BUILDKIT=0 docker compose build && docker compose up -d`）。

---

## 门禁（协调者，合并后执行）

> 三条环境事实（`agent-briefs.md`「已知环境事实」）：① 跑 conformance **前**必须先在主检出 `pnpm exec turbo run build --force`（`docker-compose.yml:154` 把宿主 `packages/robot-service/dist` bind-mount 进容器）；② 开发/联调命令**不带** `-f`（Compose 自动合并 override），重建镜像必须 `DOCKER_BUILDKIT=0`；③ 门禁必须 `--force`，每条 conformance 套 `timeout` 且**不带** `CONFORMANCE_STEPS`。

```bash
cd /home/howe/pokergame
# 1) 合并（顺序：后端 → 前端）
git merge feat/backend --no-edit
git merge feat/frontend --no-edit

# 2) 工作区 DoD（必须 --force：不 force 看到的是 .turbo 回放的日志）
pnpm exec turbo run test lint --force      # ✅ 期望全绿（任务数随 lint 的 ^build 略多于 29，不是回归）
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..

# 3) conformance（先 build 再重建镜像；不带 -f = 开发形态）
pnpm exec turbo run build --force          # ⚠️ robot-service 是 bind-mount，必须先 build
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
sleep 5 && docker compose ps               # 8 容器 healthy

timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 新增（结算/守恒/N17）
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 155+（恢复了两条结算断言）
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 53
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 249（房间数参与计数；只要尾行 ✅）
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29
```

**另加一条「N1 的回头验收」（机械判据，证明事件真的过网关）**：

```bash
docker compose logs api-gateway --since 10m | grep -c 'Blocked outbound game.settlement'   # 期望 0
```

---

## Self-Review

**Spec coverage**
| 规格 | 落在哪个 Task |
|---|---|
| §8.1 底分（不得硬编码） | B1（字段与默认值）+ B2（`settleGame` 读它）+ B2 用例「baseScore 来自 session」+ C2 的 `baseScore === 100` |
| §8.2 倍数乘法 | B2（`multiplier` 表达式 + `C1` 用例 `4 ≠ 3`）+ C2 在线判据 |
| §8.3 春天/反春 | B2（`resolveSpring` + 两条用例 + 非春天对照）+ C2 两个场景各覆盖一条 |
| §8.4 分数变动与守恒 | B2（`unitScore` + 四种组合守恒用例）+ C2（逐字段与守恒） |
| §8.5 唯一形状 / `landlordSeat` 用座位号 | B2（删内部类型 + re-export；`landlord.seat`）+ B2 的 `C2` 用例（座位≠下标）+ C2 的字段集断言 |
| §3.2 `GameSession.baseScore` | B1 |
| §4.2 `game.start` 的 `baseScore` 链路 | B1（N19：`match.service` 传 `room.baseScore`） |
| §6.3 `game.settlement` 载荷 | B2 + C2（9 字段） |
| §6.7 推送顺序 | B3（ended 视图先于 `game.ended`）+ C2（下标顺序） |
| §4.2 `PlayerView.winner` / §6.4 裁剪 | B3（ended 视图走 `buildPlayerView`，天然带 `winner` 且过校验） |
| N17 局终视图 | B3（后端）+ F2（前端终局态）+ C2（在线判据） |
| §12 F01/F02/F10/M09（前端零计算） | F1（组件只渲染字段）+ `source-boundary.test.ts` 回归 |
| §12 M07（不预判结果） | F1（`v-if="store.settlement"`）+ F2（`ended` 分支不读 `winner`） |

**Placeholder scan**：无 TBD/TODO；每个 Task 都给了可直接落盘的代码或**指名必读的既有文件**（`match.service.test.ts` 的 stub 手法、`game.service.test.ts` 的 redis 收集器、`table-play-ui.test.ts` 的 mount 手法）——这三处刻意不抄死，因为抄死就是 R179/切片 7.2 教训里的「手搭脚手架自己拼形状」。
**Type consistency**：`settleGame(session): SettlementResult`（契约类型）在 B2 定义、B3 消费；`isEnded` 在 F2 定义并由 F2 的模板消费；`DEFAULT_BASE_SCORE` 唯一来源是 `packages/shared`（`view.builder.ts` 只 re-export）；`SETTLEMENT_KEYS` 9 项与 B2 的用例、契约 `views.ts:82` 三处逐字一致。

---

## 执行期裁决（已回填，**不要删**）

> 编号接 R193。以下都是执行期**实测**出来的，其中 R198 是**计划自身的缺陷/口径问题**（不改写历史，只记录）。

- **R194（B2，`rule-error.mapping.ts` 被 N2 的覆盖闸拦下）**：计划在 `settle.ts` 新增的 `throw new Error('No landlord in session')`
  让切片 9 建的**覆盖闸**当场红：`ddz/settle.ts 的 throw「No landlord in session」没有任何映射（新增 throw 必须同步加映射）`。
  **处置**：在 `packages/game-service/src/game/rule-error.mapping.ts` 补一行 `/no landlord in session/i → ErrCode.ILLEGAL_ACTION`，
  `basis` = 「内部前置：结算前必须有地主（不可达）」，与既有 `game not finished` 同族；**未新增任何错误码**（Global Constraint 7 不破）。
  ⇒ 计划 Task B2 的文件清单**补上** `packages/game-service/src/game/rule-error.mapping.ts`。备选（删掉该 guard 退回 `find(...)!`）**不采纳**：
  那会把手牌/地主缺失变成 `undefined` 解引用崩溃。**这是那张闸按设计工作，不是缺陷。**
- **R195（C2 的判别力，协调者变异探针实测）**：计划 R184 的原话「旧实现给 `0`/`2`」**不准确** —— 旧实现**根本没有** `landlordSeat` 字段
  （只有 `landlordSeats`），所以修前 RED 是 `expected undefined to be 1`。但「误用 `players.indexOf`」这个错误**确实**被判据抓住：
  协调者把新实现的 `landlordSeat: landlord.seat` 临时改成 `session.players.indexOf(landlord)` ⇒
  `AssertionError: expected 2 to be 1`（夹具 `playerOrder: [2,0,1]` 让座位与下标不一致）。**判据成立，无需再加源码级闸。**
- **R196（`observedA`/`observedB` 的口径）**：`observedA = 20`（地主 20 个首出墩，含终局的 ended 视图）；
  `observedB = 16`（B4 的 16 个**首出**墩，**不含**「压过那一手」跟牌 —— 那一手单独做 `checkSingleCaliber` 但不计数），
  与 `slice-09` 的 `farmerTricks = 16` 同口径。旧实现分别停在 19 / 15（= N17 的量化形态）。
- **R197（前端两处计划外改动，批准）**：① `apps/client/test/source-boundary.test.ts` **+5 行** —— 把新组件
  `src/components/Settlement.vue` 纳入「扫描器确实读到了文件」的自证（R179/R193③）；该 agent 另用**变异探针**自证判别力
  （临时塞 `computeMultiplier` ⇒ 闸红），**批准并保留**。② 结算容器样式仍留在 `table.vue` 的 `<style scoped>`（实测子组件根节点
  带父作用域 id `data-v-…`，规则生效）⇒ **不搬移、不加 `:deep()`、不两处重写**。
- **R198（计划自身的缺陷/口径，四条）**：
  ① **`validateOutbound` 那条 RED 原文的精确含义**：单测里**直接**把旧返回值喂给 `validateOutbound` 会**先撞** `$.payload.roomCode must be a string, got undefined`
  （旧返回值连 `roomCode` 都没有）；把旧 `publishEnded` 的 `{...result, roomCode}` **拼回去**之后，才逐字得到网关日志那条
  `$.payload.baseScore must be a finite number, got undefined`。计划把这两步混写成一句，执行期补齐了取证步骤。
  ② **门禁任务数实测恰为 `29/29`**（计划写「会略多于 29」）—— 与历史一致，**不是回归**。
  ③ **B1 Step 6 的「期望 PASS」缺一步前提**：删掉模块增强的 `baseScore` 后，`lint` 会读**过期**的 `packages/shared/dist`
  ⇒ `TS2339: Property 'baseScore' does not exist` / `TS2305: no exported member 'DEFAULT_BASE_SCORE'`；先
  `pnpm --filter @fight-the-landlord/shared build` 才转绿（已写进 `agent-briefs.md` 的「已知环境事实」）。
  ④ **`PlayerView.playPhase` 只有 `{ bombCount }`**（契约如此，不是缺陷）⇒ conformance **无法在线独立复算春天**，
  只能「构造条件 + 断言服务端 `spring` 字段」。这也解释了为什么 C3 的在线判据必须靠场景 A/B 的驱动形态。
- **R199（前端发现的协议层约束）**：`validateInbound` 的 `assertSettlement`（`packages/protocol/src/validate.ts:121`）
  **不止校验字段，还强制分数守恒**（`landlordScoreChange + farmerScoreChange × farmerSeats.length === 0`）⇒
  「夹具刻意用算不出来的数」**必须同时守恒**，否则会在协议层先抛、把 RED 的归因错位成 UI 问题。
  计划 R188 给的 `777 / -388.5` 恰好守恒（`777 = 388.5 × 2`），已在用例注释里写明。**后续写结算夹具的人必须知道这条。**

## 门禁实测（已通过，master `d32a6cc` 合并两条分支后，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached（分项见下）
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d     # 8 容器 healthy
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项，21.0s（新增）
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项，26.1s（155 → +5）
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项，8.9s
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 53 项，15.6s
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22 项，9.6s
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项，5.0s
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项，4.8s
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项，2.1s
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项，39.0s
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 374 项，0.4s
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项，55.6s
docker compose logs api-gateway | grep -c 'Blocked outbound game.settlement'   # ✅ 0（修前每结束一局 3 条）
```

单测分项（`--force`、0 cached）：`protocol` 39 · `shared` **135**（127→+8）· `game-service` **74**（73→+1）·
`robot-service` 15 · `room-service` **159**（157→+2）· `api-gateway` 106 · `user-service` 29 ·
`client` **163**(+2 skipped)（154→+9）· `mock-server` **2**（0→+2）。
⇒ **关闭 C1/C2/C3/C26/N1/N17**；**新增 N19 并同片关闭**。

## 下一步

切片 11（§9 机器人系统）：C7 残留 / C8 / C9+E4 / E9 / §9.4 + C5 的最优跟牌半边 + C6 的 `HandType.Invalid` 半边 + A7 的两个半边；
可并行 **独立小片 P3**（E2 / E6 / E7 / N9 / N12 / N14 / N15 后端半边）。

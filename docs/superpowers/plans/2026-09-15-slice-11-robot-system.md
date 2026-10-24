# 切片 11 实施计划：机器人系统（§9）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「机器人」从「只会入座、回合靠 30s 超时兜底、AI 特征靠伪造、DouZero 一失败就白送 pass、ID 明文 `bot-` 前缀」修成完整闭环：**规则引擎能跟全部 14 种牌型**（E4，并让 C5 的超时决策与 C6 的 `HandType.Invalid` 变成活代码）、**game-service 服务端驱动机器人回合**（§9.4，思考延迟计入 30s 而不顺延）、**真实公开特征**（C8：`actionLog` 投影；C7：牌值只走 `codec`）、**DouZero 失败/非法动作必回退规则引擎**（C9）、**`displayId` 与内部 `botId` 分离 + `bot:pool` 池闭环**（E9/§9.6）、以及 `game.client` 统一到 `HttpService` 与「失败重试 1 次」（A7④⑤，以幂等 `acquire` 为前提）。

**Architecture:** 分层不变：**强弱顺序** `shared`（规则与状态机）→ `game-service`（状态机所有者、回合驱动）→ `robot-service`（AI 决策与机器人池，**只拿裁剪视图 + 公开特征**）→ `room-service`（入座/补位/释放）。本片新增三条边界：① **§9.5 可见信息边界**——`robot.decide` 的入参是 `PlayerView` + 由 `actionLog` 投影出的**公开** `features`（已出的牌），`GameSession` **永不**跨服务；② **§9.4 回合驱动**归 `game-service`（避免 game↔robot 双向依赖），机器人动作走**与人类完全相同**的校验链，失败/非法 ⇒ 回退规则引擎，再失败才 pass；③ **§9.6 池闭环**归 `robot-service`，`acquire` **幂等**（同一 `roomCode+seat` 重复调用返回同一个 bot）——这正是 A7⑤ 重试的前提。

**Tech Stack:** TypeScript / NestJS 10 / ioredis / Vitest / pnpm workspace + Turborepo / socket.io 4

**Spec:**
- `docs/design.md` v4.2 —— **§3.2（`GameSession.actionLog`）· §3.4（`BotInstance`）· §4.2（`robot.acquire`/`robot.decide` 契约 + `StartGameRequest`）· §4.3（超时/重试/降级表）· §6.4（裁剪与永不出站字段）· §9.1–§9.8（机器人系统，逐字）· §12（F01/F05/F07）**
- `docs/games/doudizhu.md` v1.2 —— **§4（14 种牌型与 `length` 单位）· §5（比较规则）· §9.1（超时四步）· §11.1（错误码）**
- `docs/superpowers/plans/deviation-ledger.md` §2「切片 11 / Task 11」+ §1.1/§1.2/§1.3 的 **C5/C6 剩余半边、C7、C8、C9、E4、E9、A7④⑤**
- `docs/superpowers/plans/agent-briefs.md` —— 「已知环境事实」（robot-service 的 bind-mount、`DOCKER_BUILDKIT=0`、门禁 `--force`、conformance 必须**独占**跑）
- 本片**范围裁决（用户 2026-09-15 当面确认）**：TCP RPC 迁移**不在**本片（→ 新登记 **N20** → 独立小片 P4）；**§9.6 池闭环在本片**。

---

## Global Constraints

逐字照抄 `2026-09-13-parallel-dev.md`，每个任务都隐含本节（端口 / Vitest / TCP+RPC pattern / 对外 REST 与内部 RPC 不共用 / socket.io ack / `baseVersion` CAS + `13004` / 5 位错误码 / 身份只从网关注入 / 裁剪 / 牌值 DouZero 进出判定还原内部 Rank / 前端哑终端 / `packages/protocol` 协调者独占）。

### 本切片的绑定数值（逐字，来自 design.md §9 与玩法 §4/§9.1）

| 项 | 值 |
|---|---|
| 不可区分性（§9.1-1） | 任何下发消息中**不得**出现 `isRobot`、`botId`、`skillLevel`、`bot` 前缀 id；对外 id 与人类同构 `p_<8位>` |
| 服务端驱动（§9.1-2） | 机器人回合由 **game-service** 推进，**客户端不参与** |
| 双轨（§9.3） | `beginner`：规则引擎，`errorRate 0.15`，`thinkingSpeed 800–1500ms`；`intermediate`：规则引擎，`0.05`，`500–1000ms`；`advanced`：DouZero，`300–800ms` |
| 难度分布 | MVP 硬编码 `{ beginner: 0.5, intermediate: 0.35, advanced: 0.15 }` |
| 降级链（§9.3/§9.4） | DouZero 超时/失败 ⇒ **规则引擎**；规则引擎也无解 ⇒ pass。**动作被规则拒绝 ⇒ 必须回退规则引擎重决策，不得直接 pass** |
| RPC 超时/重试（§4.3） | `robot.acquire` 3s / 重试 1 次 / 失败 ⇒ 以较少人数开局；`robot.decide` **5s / 不重试** / 失败 ⇒ 回退规则引擎；`game.start` 3s / 重试 1 次；`game.snapshot` 2s / 重试 1 次 |
| 思考延迟（§9.4） | 计入 30s 回合时限，`turnDeadlineAt` **不顺延**；最坏 ≈ 6.5s ≪ 30000ms |
| 回合行动者 | 叫抢阶段 = `bidPhase.currentBidder`；出牌阶段 = `currentPlayer`（玩法 §9.1） |
| `actionLog`（§3.2） | `{ version: number; seat: number; cards: number[]; kind: 'play' \| 'pass' }[]`；**永不出站**；公开投影（已出的牌）**可以**出站 |
| 池（§9.6） | `bot:pool:{gameType}`；空闲机器人带 `idleSince`；`release` 丢失时回收 `idleSince` > **10 分钟**且 `roomCode` 房间不存在的；对局中的机器人**不得**回收 |
| 本片相关错误码 | `10002` 内部 token 缺失/错误、`10007` 下游不可达（沿用）、`13006` 出牌非法、`13001` 操作非法；**不新增任何错误码** |

### 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接切片 10 的 **R199**，从 **R200** 起。执行期若发现与代码事实不符，**就地记「执行期裁决」并写进计划文件**。

- **R200（范围裁决，用户确认）`§4.2` 的 TCP RPC 迁移不在本片。**
  `robot.decide` 沿用**内部 HTTP 过渡形态**（`POST /api/robots/decide`，`X-Internal-Token`），与 `game.start` / `robot.acquire` 的现状一致；**登记新偏差 N20**（「`connectMicroservice`/`3103`/`3105` 未落地，§4.2 的 RPC 契约无 TCP 监听方」）归**独立小片 P4**。裁决理由：本片已有 8 个交付面；迁移会动 5 个服务启动方式 + compose 端口 + 全部调用点 + 现有 conformance 的直连形态，属于独立基础设施改造。**不得**在本片顺手把某个调用点单独改成 TCP（半迁移比不迁移更糟）。
- **R201（范围裁决，用户确认）`§9.6` 的池闭环在本片。**（⚠️ **R201 修正**：初稿把池写成 **Set**，与 `design.md` **§10.1 的键表**冲突 —— 键表逐字规定 `bot:pool:{gameType}` 是 **ZSET**，`member = botId`、`score = idleSince`。**以 §10.1 为准**，见下。）
  终局回收 **不靠** `room-service` 单独发一条消息就完事：`acquire` 必须**幂等**（同一 `{roomCode, seat}` 重复调用返回**同一个** `BotInstance`），否则 A7⑤ 的重试会重复创建、把前一个变成孤儿。池的存储形状**逐字照 §10.1**：
  - `bot:pool:{gameType}` —— **ZSET**（`member = botId`，`score = idleSince` 毫秒时间戳）；空闲机器人**在池内**，绑定中的机器人 `ZREM` 出池 ⇒ 「池里的一定空闲」是结构性的；
  - `bot:{botId}` —— **String(JSON)** `BotInstance`（含 `roomCode` / `seat` / `idleSince` / `skillLevel` / `personality` / `displayId` / `gamesPlayed`）；
  - `gameType` 取 **`ddz`**（本仓唯一玩法；常量 `GAME_TYPE = 'ddz'` 放 `robot.pool.ts` 并加注释指向 §10.1）；
  - 兜底回收用 `ZRANGEBYSCORE bot:pool:ddz -inf <now-10min>` 取候选 + 逐个查 `room:{roomCode}` 是否存在（§9.6）。
- **R202 E4 的完整口径（`packages/shared/src/rule/autoplay.ts`）。**
  `findSmallestBeatingCards(hand: Card[], target: ParsedHand): Card[] | null` 必须：
  1. **覆盖全部 14 种牌型**：`Single` / `Pair` / `Trio` / `TrioWithSingle` / `TrioWithPair` / `Straight`（同长度）/ `PairStraight`（同组数）/ `Plane` / `PlaneWithSingles` / `PlaneWithPairs` / `Bomb` / `FourWithTwo` / `FourWithTwoPairs` / `Rocket`；
  2. **最小性**：同型跟牌取**能压过的最小 keyRank**，且 kicker / 带牌取**最小**的合法组合（不得把炸弹拆成三张去当 kicker）；
  3. `target.type === HandType.Invalid`（首出 / 一墩回到自己）⇒ 返回**手牌中点数最小的单张**（旧实现返回**最大**单张，与玩法 §9.1 相反）；
  4. **面对 `Rocket` 不得返回任何牌**（`null`）；**面对 `Bomb` 只能返回更大的 `Bomb` 或 `Rocket`**（不得返回「四带二」等四张的其它牌型）；**炸弹不得被拆**（四条永远优先作为炸弹使用）;
  5. 返回 `null` 表示**无解**（调用方据此 pass 或打最小单张）。
  判据（判别力唯一形态）：**14 种牌型逐型一条「同型最小可压」用例** + 三条边界用例（王炸 ⇒ `null`、炸弹 ⇒ 只被更大炸弹/王炸跟、`Invalid` ⇒ 最小单张）。**旧实现下**：顺子/连对/飞机/飞机带单/飞机带对/四带二/四带两对 **7 型全部返回 `null`**（`expected [ … ] to not be null`），`Invalid` 返回最大单张，面对王炸返回炸弹。
- **R203 C6 的启用方式：`parseHand` 返回类型化 `Invalid`，**不再** throw；拒绝动作的责任上移到 `handlePlayCards`。**
  - `parseHand(cards)` 对无法识别的组合返回 `{ type: HandType.Invalid, keyRank: 0, length: 0, cards }`；
  - `packages/shared/src/ddz/play.ts` 的 `handlePlayCards` 在 `parseHand` 之后**显式**检查 `playedHand.type === HandType.Invalid` 并 `throw new Error('不支持的牌型: …')`（**文案逐字不变**——N2 的覆盖闸与 `SPEC_ROWS` 规格闸都靠它，改了会让两张闸红）；
  - `rule/beat.ts` 的 `opponentHand.type === Invalid ⇒ return true` 与 `autoplay.ts` 的 `Invalid` 分支**由此变成活代码**（这正是 C6 剩余半边的要求）；
  - `parseHand` 的 `不能出空牌`（空数组）**仍然 throw**（它是参数错误，不是牌型非法）。
  > ⚠️ 若实现时发现 `parseHand` 的其它调用点依赖「抛错」来兜底，**就地记执行期裁决**，不要在无人知晓的情况下改判据。
- **R204（⚠️ 已修正）C5 的收口 = 逐字实现玩法 §9.1 的四步（「规则引擎优先」，**不是**「能过牌就过牌」）。**
  > **修正说明（协调者自查，2026-09-15）**：本裁决初稿写成「可过牌 ⇒ 过牌（保持切片 9 的行为）」，把 §9.1 的 ①②③ 推给了 robot-service —— 那是**错的**：`docs/games/doudizhu.md` §9.1 讲的就是**出牌超时**的自动行为，逐字是：
  > ```
  > 若 lastPlayedHand !== null（跟牌）:
  >     ① 尝试同牌型、同 length 的【最小】可压牌（带牌取手中点数最小的合法组合）
  >     ② 若 last 不是王炸：再尝试【最小】炸弹
  >     ③ 若 last 不是王炸：再尝试王炸
  >     ④ 均无 → 过牌
  > 否则（首出）: 打出【手牌中点数最小的单张】
  > ```
  > 「能过牌就过牌」正是切片 9 之前/之后的**旧行为**（白送回合），按初稿实现会让 C5 **永远关不掉**。
  - **跟牌**（`lastPlayedHand !== null && lastPlayerIdx !== 当前行动者`）：① 同型同 `length` 最小可压 → ② last 非王炸时试**最小炸弹** → ③ last 非王炸时试**王炸** → ④ 全无解 ⇒ **过牌**。①②③ 的**唯一实现**是 `findSmallestBeatingCards`（Task 1）⇒ Task 2 **必须**调它，**不得**自己写第二份「最小可压」。
  - **首出**（`lastPlayedHand === null`）：打**手牌中点数最小的单张**（永远合法 ⇒ 保证可执行；这一半切片 9 已落地，**保持**）。
  - `findSmallestBeatingCards` 的**入参类型放宽**为 `ParsedHand | BeatTarget`：超时路径只有 `session.lastPlayedHand`（`BeatTarget`，没有 `cards`），而实现只用到 `type`/`keyRank`/`length`。
  - 牌值换算：手牌是 DouZero 编码 ⇒ 先用既有的 `douzeroIntToCard()` 适配成 `Card[]`，取回结果再用 `cardToInt()`（`shared/ddz/game.ts`，其映射唯一实现在 `protocol/codec.ts`）转回 DouZero。
  - 判据（`play.test.ts` + `game.timer.test.ts`）：① **跟单张超时 ⇒ 打出最小可压单张，而不是 pass**（旧行为 RED：`expected 'pass' …`/`expected [5] to equal [6]` 之类）；② **跟顺子超时且有同长顺子 ⇒ 打出它**（旧实现 7 型无解 ⇒ 只能 pass 或甩炸弹）；③ **无任何可压 ⇒ pass**（**正对照**：可压时必须 play，否则「无解 ⇒ pass」那条是空测）；④ 首出超时 ⇒ 最小单张（保持切片 9 的判据）；⑤ 面对王炸 ⇒ 不得出炸弹（§5 第 1 条，Task 1 已保证 ⇒ 这里只断言超时路径不吃到非法动作）。
  ⇒ C5 **关闭**（不再写「部分关闭」）。
- **R205 C7 + C8：特征真实化，且**唯一**实现放在 `shared`。**
  - `GameSession.actionLog` 新增（形状逐字见绑定数值表）；`handlePlayCards`（`kind:'play'`，`cards` 为打出的牌）与 `handlePass`（`kind:'pass'`，`cards: []`）在**每次**状态转移里按 `version` 追加；`bid.ts` 的 `finalizeBidding`/`resetBidding` **清空** `actionLog`（新一局重新开始）；
  - **公开特征投影**放 `shared`（新文件 `packages/shared/src/ddz/features.ts`，导出 `buildPublicFeatures(session, seat): RobotFeatures`）——**只有 game-service 调用它**，且它是 `actionLog` 的**唯一**投影实现；
  - `packages/robot-service/src/robot/bot.player.ts` **删除** `computePlayedCards()` / `computeActionSeq()` / `getAllCards()`（伪造与硬编码 17/20/30），改为**直接用请求里的 `features`**；`bot.player.ts` 不再接收 `GameSession`（C7/C8/§9.5 三条一起关闭）；
  - `RobotFeatures` 的**唯一形状**来自 `@fight-the-landlord/protocol`（与 `RobotDecideRequest.features` 同一类型；切片 9/10 的教训：不允许同名不同形的第二份）。
- **R206 C9：DouZero 失败/非法 ⇒ 规则引擎 ⇒ 再失败才 pass。**
  `RobotService.decide()` 的流程固定：
  ```
  advanced && DouZero 可用 → douzero.decide(view, features)
       ├─ 返回合法动作 → { kind, cards, source: 'douzero' }
       └─ 超时/HTTP 错/返回空且非 pass/动作明显非法 → 落到规则引擎
  beginner/intermediate（或已落到规则引擎）→ autoplay.findSmallestBeatingCards(...)
       ├─ 有解 → { kind: 'play', cards, source: 'rule' }
       └─ 无解 → { kind: 'pass', source: 'rule' }
  ```
  「合法」的**最终裁判是 game-service**（R208）：`robot-service` 不做规则校验（它只拿裁剪视图），game-service 拒绝后**必须**回退规则引擎重决策（§9.4 逐字）。`RobotDecideResponse.source` 如实标注。
- **R207 E9：`displayId` 与 `botId` 分离，并补上 §9.6 第 4 条。**
  - `robot-service` 生成 `botId = bot-<uuid8>`（内部，**永不出站**）与 `displayId = p_<8位>`（对外；字符集与人类 id 无区别，**不得**以 `bot` 开头）；
  - `room:{code}:seats` 的 `Seat.userId` = **`displayId`**（§9.6 第 3 条）；`Room.players[].id` 随之是 `displayId`；
  - `StartGameRequest.players[]` 为该座位带 `isRobot: true` + `botId` + `skillLevel`（§9.6 第 4 条）——**今天 `match.service` 只传了 `isRobot`**，`botId` 从未带上，这正是 §9.4 无法启动的原因之一；
  - `room-service` 在 acquire 后把 `seat → botId` 写入 `room:{code}:bots`（**Hash**，TTL 与 `room:{code}:seats` 一致 = 3600s），供 `release` 使用；局终收到 `game.ended` 时读它、调 `robot.release({ botIds })`、删键；
    > ⚠️ **`room:{code}:bots` 是本片新引入的 Redis 键，`design.md` §10.1 的键表里没有它。** 键表是本仓键名的**唯一真源**（**N9** 的教训：`room:{code}` 该是 Hash 这条只写在 design.md 的 `[偏差]` 段、键表无编号）⇒ 本片把它登记进对账表 **§3 的「文档待更新」**（收口时由协调者给 §10.1 补一行：`room:{code}:bots` | Hash | room-service | 3600s | `field = 座位号`，`value = botId`，供 §9.6 归池）。**不得**只在代码里悄悄加一个键。
  - `message.router.ts:409` 的 `seat-${seat}` 掩码**保留**为纵深防御（正常路径不再触发，因为 id 已是 `p_…`），但**新增**一条机械判据：掩码函数对 `p_…` 必须原样返回（不得把正常 id 也掩掉）。
- **R208 §9.4 回合驱动（`game-service` 所有者）。**
  - **触发点**：`finishTransition` 成功路径（`saveSession` + `publishSeatViews` + `startTurnTimer` 之后）与 `startGame` 之后——即**每一次**状态转移之后检查「当前行动者是否机器人」；是则**异步**驱动（`void this.driveRobotTurn(roomCode)`，不阻塞调用方）。
  - **行动者判定**：`bidding` ⇒ `bidPhase.currentBidder`；`playing` ⇒ `currentPlayer`；`ended`/`init` ⇒ 不驱动。
  - **思考延迟**：按 `personality.thinkingSpeed` 取范围内的**确定性可注入**延迟（`randomDelay(min,max)` 已存在，但**测试必须能注入 0 延迟**）——实现为 `private robotDelay?: (ms) => Promise<void>`（默认 `randomDelay`，测试注入 `async () => {}`）；延迟**不修改** `turnDeadlineAt`（§9.4：不顺延）。
  - **动作应用**：与人类**完全相同**的链路 —— `handleBid` / `handlePlayCards` / `handlePass` → `finishTransition`。叫抢用 `grab` 语义（`handleBid(session, botDisplayId, grab)`，`grab` 由决策给出）。
  - **失败/非法回退**：`robot.decide` 超时（5s）/HTTP 错 ⇒ 规则引擎；**动作被规则拒绝**（`handlePlayCards` 抛错）⇒ **回退规则引擎重决策一次**，仍失败才 `pass`（§9.4 逐字：「不得直接 pass」）。
  - **串行**：同一房间同一时刻至多一个在飞的 `driveRobotTurn`（`private readonly robotDriving = new Set<string>()`），避免「三名机器人并发抢占同一次转移」。
  - **与计时器的关系**：驱动**不**清除 30s 计时器；机器人动作成功 ⇒ `finishTransition` 会重挂（既有行为）。
  - 判据（`game.robot.test.ts`，fake timers + `fetchImpl` 替身 + 0 延迟）：① 轮到机器人 ⇒ 在**不推进 30s** 的情况下产生一次状态转移（旧实现：`version` 卡住直到 30s 超时）；② DouZero 返回非法牌 ⇒ 同一次转移里改用规则引擎结果且**不是** pass（正对照：DouZero 返回合法牌 ⇒ `source: 'douzero'`）；③ 机器人动作走 `handlePlayCards` 的校验（用「不在手中的牌」断言它被拒并回退）；④ 三个机器人**串行**（按分派序号断言，不用墙钟）。
- **R209 A7④：`room-service/src/gateway/game.client.ts` 统一到注入的 `HttpService`。**
  语义（超时 2s/3s 分流、错误码、`X-Internal-Token`、`/api` 前缀）**逐字保留**；删除手写 `AbortController`（由 `HttpService` 的 `timeout` 承担）。判据：既有 `game.client.test.ts` 全绿 + `outbound-timeout.gate.test.ts`（源码级闸）仍绿。
- **R210 A7⑤：失败重试 1 次（`game.start` / `game.snapshot` / `robot.acquire`）。**
  以 **R201 的幂等 `acquire`** 与既有的幂等 `game.start`（同 `roomCode` 重复调用复用会话）为前提：首次失败 ⇒ 同参数**重试恰好 1 次**（`maxAttempts = 2`），仍失败才走 §4.3 的降级（`game.start` ⇒ 房间 `cancelled`；`acquire` ⇒ 以较少人数开局）。判据：`match.service.test.ts` 用 `HttpService` 替身断言「第一次 401/超时 ⇒ 第二次仍发同一 URL/载荷」+「两次都失败 ⇒ 不抛、走降级」，**并**断言幂等性（同 `roomCode` 调两次 `game.start`，服务端只发一次 `game.deal`——这条在 game-service 侧已有「复用会话」用例，本片补一条端到端）。
- **R211 §9.8 的落地形态：不引入 ESLint 插件（本仓 `lint` 是 `tsc --noEmit`）。**
  §9.8 的两条手段落为：① **单测/机械断言**——出站消息（含 `game.deal`/`game.state_update`/`game.settlement`/`room.state_update`/`room.join` ack/REST 响应）不得含 `isRobot`/`botId`/`skillLevel`/`bot` 前缀 id（`slice-07.2-hardening` 第 4 步已有，本片**扩展**到机器人**主动行动**后的消息流）；② **源码级闸**——`robot-service` 的出站路径不得引用内部 id 字段（沿用切片 7.2 的机械闸写法，带正/负对照）。ESLint 形态**不在本片**（记录在计划里，避免下一个人再找）。
- **R212 判据纪律（切片 7/8/9/10 的教训，逐条照做）。**
  ① 源码级机械闸**必须自带探针判别力**（正/负对照）且路径解析在两个环境各验一次（R179）；
  ② 断言「**没有**发生」之前先证明探针能观测到「发生」（R115/R152）；
  ③ 涉及墙钟的判据优先**结构性**（注入 0 延迟 + 假计时器 + 按分派序号断言）；**不得**用「sleep 1s 后看状态」这种墙钟判据；
  ④ 假 Redis 替身必须按**真实语义**（`ZADD`/`ZREM`/`ZCARD`/`ZRANGEBYSCORE`/`HSET`/`EXISTS` 的类型宽容度）实现（切片 7.1 的教训：「替身的宽容度就是对缺陷的容忍度」）；
  ⑤ 门禁必须 `--force`；conformance 必须**独占**跑（单 IP WS 上限 5 + 共享 Redis 房间）。
- **R213 测试连带清单（不改测试 = 保留缺陷）。**
  | 文件 | 为什么要改 |
  |---|---|
  | `packages/shared/src/rule/rule.test.ts` | `parseHand` 不再 throw ⇒ 旧的「非法牌型断言抛错」改为断言 `type === HandType.Invalid`（**必须有这一条**，否则 C6 的启用没有判据） |
  | `packages/shared/src/ddz/play.test.ts` | `handlePlayCards` 对 `Invalid` 的拒绝**文案逐字不变**（`不支持的牌型`）；新增 `actionLog` 追加断言 |
  | `packages/game-service/test/game.timer.test.ts` | R204 的「规则引擎优先」判据（spy `findSmallestBeatingCards`） |
  | `packages/game-service/test/view.builder.test.ts` | `actionLog` **不得**出现在任何出站视图（`validateOutbound` + `assertNoLeak` 双层） |
  | `packages/robot-service/test/bot.player.test.ts` | 夹具从 `GameSession` 改为 `RobotDecideRequest`（含 `features`）；删除对伪造函数的断言 |
  | `packages/room-service/test/match.service.test.ts` | `acquireBot` 的 payload 从 `{roomCode, seat}` 改为 `{roomCode, seats:[seat]}`；新增幂等与重试用例 |
  | `tools/conformance/src/slices/slice-07-match-join.ts` | 该文件「机器人不会行动（`Turn timeout …` 正是预期证据）」的注释**已过期** ⇒ 改成事实（本片之后机器人会在 thinkingSpeed 量级内行动）；**不得**在那里新加「机器人会行动」的断言（那是 `slice-11` 的判据） |

---

## 执行模型（与切片 5–10 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | Task 8（conformance）、评审、合并、门禁、`docs/**` 收口、**前置依赖**（`ioredis` 已加，`52673b1`） |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | Task 1–7（**顺序执行**，Task 4–7 依赖 Task 1–3 的产物） |
| 前端 | —— | **本片无前端改动**（§9.1-1 的不可区分性意味着客户端**感知不到**机器人；`displayId` 是服务端生成的对外 id） |

**开工前固定动作**（后端 agent，逐字执行）：

```bash
cd /home/howe/pokergame/.worktrees/backend
pwd && git branch --show-current
git merge master --no-edit        # master 已含切片 10 收口 + 本片裁决 R200–R213 + ioredis 依赖（52673b1）
CI=true pnpm install --store-dir .pnpm-store   # ⚠️ robot-service 新增 ioredis；裸 pnpm install 会写工作区外的 ~/.pnpm-store 而被沙箱拒绝
pnpm exec turbo run build --force # dist/ 是 gitignore 的
```

**汇报格式**（统一，逐条对应 DoD 并附**实际命令与输出**）：完成情况 / 改动清单（文件 + 一句话 + commit sha）/ 阻塞未完成 / 需要协调者裁决的事项 / 我发现的文档未记录的问题。

---

## File Structure

```
packages/shared/src/rule/autoplay.ts               Modify: 覆盖 14 型 + 最小性 + 王炸守则 + Invalid⇒最小单张（E4/R202）
packages/shared/src/rule/autoplay.test.ts          Create: 14 型逐型 + 三条边界（R202 的判据）
packages/shared/src/rule/rule.ts                   Modify: parseHand 返回类型化 Invalid（C6/R203）
packages/shared/src/rule/rule.test.ts              Modify: Invalid 断言（R213）
packages/shared/src/ddz/play.ts                    Modify: 显式拒绝 Invalid + actionLog 写入 + 超时用规则引擎（R203/R204/R205）
packages/shared/src/ddz/play.test.ts               Modify: Invalid 文案 + actionLog（R213）
packages/shared/src/ddz/types.ts                   Modify: GameSession.actionLog（§3.2）
packages/shared/src/ddz/features.ts                Create: buildPublicFeatures()（actionLog 的唯一投影，R205）
packages/shared/src/ddz/features.test.ts           Create: 特征只含已出牌 / 不泄漏未出手牌（C8 判据）
packages/shared/src/ddz/bid.ts                     Modify: finalizeBidding/resetBidding 清空 actionLog
packages/protocol/src/views.ts                     Modify: RobotFeatures / RobotDecideRequest / RobotDecideResponse / BotInstance（协调者/契约）
packages/game-service/src/game/robot.client.ts     Create: robot.decide 的内部 HTTP 客户端（注入 fetchImpl + 5s + 内部头，R208）
packages/game-service/src/game/game.service.ts     Modify: §9.4 回合驱动 + 失败/非法回退（R208）
packages/game-service/test/game.robot.test.ts      Create: 驱动/回退/串行判据（R208）
packages/game-service/test/game.timer.test.ts      Modify: R204 的规则引擎优先（R213）
packages/game-service/test/view.builder.test.ts    Modify: actionLog 不出站（R213）
packages/robot-service/src/robot/robot.service.ts  Modify: acquire/release/decide + 池闭环（R201/R206/R207）
packages/robot-service/src/robot/robot.pool.ts     Create: bot:pool + bot:{botId} 的 Redis 读写与 idle 回收（R201）
packages/robot-service/src/robot/bot.player.ts     Modify: 只吃 view+features；删伪造函数与硬编码牌堆（C7/C8/R205）
packages/robot-service/src/robot/robot.controller.ts Modify: /acquire /release /decide 三个内部端点（R200）
packages/robot-service/src/robot/robot.module.ts   Modify: Redis 连接与池的 provider
packages/robot-service/test/{robot.pool,robot.decide,bot.player}.test.ts Create/Modify: 池/决策/特征判据
packages/robot-service/test/helpers/fake-redis.ts  Create: 按真实语义的假 Redis（R212④）
packages/room-service/src/match/match.service.ts   Modify: acquire({roomCode,seats}) + 幂等 + 重试 1 次 + botId 透传（R207/R210）
packages/room-service/src/rooms/rooms.bots.ts      Create: room:{code}:bots（seat→botId）读写（R207）
packages/room-service/src/gateway/game.client.ts   Modify: 统一到注入 HttpService（A7④/R209）
packages/room-service/src/gateway/ws.gateway.ts    Modify: game.ended ⇒ robot.release（R207）
packages/room-service/test/{match.service,ws.gateway,game.client}.test.ts Modify: 上述判据

tools/conformance/src/slices/slice-11-robot-system.ts  Create: 机器人局/服务端驱动/池闭环/§9.8（Task 8）
tools/conformance/src/slices/slice-07-match-join.ts    Modify: 过期注释改成事实（R213）
tools/conformance/src/run.ts / package.json            Modify: 注册 slice-11
docs/**                                                Modify: 协调者收口（N20 登记 + 门禁实测）
```

> ⚠️ **契约文件归协调者**：`packages/protocol/src/views.ts` 的新增类型（`RobotFeatures` / `RobotDecideRequest` / `RobotDecideResponse` / `BotInstance`）由**协调者在派工前**落盘（见 Task 0），后端 agent **只读**。

---

## Task 0（协调者，**派工前**）：契约落盘

**Files:** Modify `packages/protocol/src/views.ts`（+ 若有 outbound 校验需要，同步 `validate.ts`）

- [ ] **Step 1: 按 design.md §4.2/§3.4 落 `RobotFeatures` / `RobotDecideRequest` / `RobotDecideResponse` / `BotInstance` 四个类型**（字段逐字，注释标明「服务间内部类型，永不出站」）。
- [ ] **Step 2: 加一条判据**：`packages/protocol/src/messages.test.ts` 断言这四个类型**不在** `SERVER_MESSAGE_TYPES` 里、且 `assertNoLeak` 对含 `botId` 的对象仍然抛（契约层继续拦住泄漏）。
- [ ] **Step 3: 跑 `pnpm --filter @fight-the-landlord/protocol test` + `build`**，提交。

---

## Task 1: E4 —— `autoplay` 覆盖 14 型（R202）+ C6 的 `Invalid` 启用（R203）

**Files:**
- Modify: `packages/shared/src/rule/autoplay.ts`
- Modify: `packages/shared/src/rule/rule.ts`
- Modify: `packages/shared/src/rule/rule.test.ts`
- Create: `packages/shared/src/rule/autoplay.test.ts`

**Interfaces:**
- Produces: `findSmallestBeatingCards(hand: Card[], target: ParsedHand | BeatTarget): Card[] | null`（14 型 + `null` = 无解）；`parseHand(cards): ParsedHand`（**不再对非法牌型 throw**，返回 `type: HandType.Invalid`）。
- Consumes: `analyzeCards` / `isContinuous` / `HandType` / `canBeat`（既有）。

- [ ] **Step 1: 写失败的用例**（`autoplay.test.ts`，14 型逐型 + 边界）

```ts
import { describe, it, expect } from 'vitest';
import { HandType, parseHand } from './rule';
import { findSmallestBeatingCards } from './autoplay';
import { Rank, Suit, CardColor, type Card } from '../card/card';

const c = (rank: Rank): Card => ({ suit: Suit.Club, rank, color: CardColor.Black });
const hand = (...ranks: Rank[]): Card[] => ranks.map(c);

describe('findSmallestBeatingCards：14 种牌型的同型最小可压（E4）', () => {
  const cases: [string, Card[], Card[], Rank[]][] = [
    ['单张', hand(Rank.Rank5), hand(Rank.Rank6, Rank.Rank9), [Rank.Rank6]],
    ['对子', hand(Rank.Rank5, Rank.Rank5), hand(Rank.Rank6, Rank.Rank6, Rank.Rank9, Rank.Rank9), [Rank.Rank6, Rank.Rank6]],
    ['三张', hand(Rank.Rank5, Rank.Rank5, Rank.Rank5), hand(Rank.Rank7, Rank.Rank7, Rank.Rank7), [Rank.Rank7, Rank.Rank7, Rank.Rank7]],
    // 三带一/三带二/顺子/连对/飞机/飞机带单/飞机带对/炸弹/四带二/四带两对 …… 逐型补全
  ];

  it.each(cases)('%s：返回能压过的**最小**组合', (_name, target, myHand, expected) => {
    const got = findSmallestBeatingCards(myHand, parseHand(target));
    expect(got?.map(x => x.rank).sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
  });

  it('顺子：只接受**同长度**且更大的顺子', () => {
    const target = parseHand(hand(Rank.Rank3, Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7));
    expect(findSmallestBeatingCards(hand(Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7, Rank.Rank8), target)).not.toBeNull();
    // 长度不同（6 张）⇒ 不得用顺子跟
    const six = hand(Rank.Rank4, Rank.Rank5, Rank.Rank6, Rank.Rank7, Rank.Rank8, Rank.Rank9);
    const got = findSmallestBeatingCards(six, target);
    expect(got === null || parseHand(got).type !== HandType.Straight).toBe(true);
  });

  it('面对**王炸**不得返回任何牌（旧实现返回炸弹，是非法动作）', () => {
    const rocket = parseHand(hand(Rank.RankBlackJoker, Rank.RankRedJoker));
    expect(findSmallestBeatingCards(hand(Rank.Rank2, Rank.Rank2, Rank.Rank2, Rank.Rank2), rocket)).toBeNull();
  });

  it('面对炸弹只能返回更大的炸弹或王炸（不得拆成四带二）', () => {
    const bomb5 = parseHand(hand(Rank.Rank5, Rank.Rank5, Rank.Rank5, Rank.Rank5));
    const got = findSmallestBeatingCards(hand(Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank6, Rank.Rank3), bomb5);
    expect(parseHand(got!).type).toBe(HandType.Bomb);
  });

  it('首出（Invalid）⇒ **最小**单张（旧实现返回最大）', () => {
    const got = findSmallestBeatingCards(hand(Rank.Rank9, Rank.Rank3, Rank.Rank7), parseHand([c(Rank.Rank3)]) /* 或直接构造 Invalid */);
    // 见 Step 3：Invalid 由 parseHand 返回，不再 throw
  });
});
```

- [ ] **Step 2: 运行确认失败** → `cd packages/shared && pnpm vitest run src/rule/autoplay.test.ts`；Expected：7 型 `null`、`Invalid` 分支拿不到（旧实现 throw）。

- [ ] **Step 3: 实现**（`autoplay.ts` 按 R202 逐型；`rule.ts` 的 `parseHand` 末行 `throw` 改为 `return { type: HandType.Invalid, keyRank: 0, length: 0, cards }`）。
- [ ] **Step 4: 运行确认通过**（`pnpm vitest run src/rule`）。
- [ ] **Step 5: 改 `rule.test.ts` 的非法牌型断言**为 `expect(parseHand(...).type).toBe(HandType.Invalid)`。
- [ ] **Step 6: `play.ts` 显式拒绝 Invalid**（文案逐字 `不支持的牌型: …`）+ 跑 `pnpm vitest run`（shared 全绿）+ `pnpm lint`。
- [ ] **Step 7: 提交**（`feat(shared): 规则引擎覆盖 14 种牌型 + HandType.Invalid 启用（E4/C6, R202/R203)`）。

---

## Task 2: C5 收口 —— 超时决策走规则引擎（R204 修正版）

**Files:** Modify `packages/shared/src/ddz/play.ts`、`packages/shared/src/ddz/play.test.ts`、`packages/game-service/test/game.timer.test.ts`

- [ ] **Step 1（TDD，写失败用例）**：按 R204 的判据 ①–⑤ 写：
  ```ts
  // ① 跟单张超时 ⇒ 打最小可压单张（**不是** pass）—— 旧行为的 RED
  const s = playingSession({ hand: [5, 6, 9], lastPlayedHand: single(7), lastPlayerIdx: 1, currentPlayer: 0 });
  const next = handlePlayTimeout(s, actorId);
  expect(next.lastPlayedHand!.cards).toEqual([9]);   // 旧实现：handlePass ⇒ lastPlayedHand 仍是 7、consecutivePasses +1
  // ③ 无解 ⇒ pass（正对照：上面那条必须先证明「可压时会 play」）
  // ② 跟顺子 ⇒ 同长顺子；⑤ 面对王炸 ⇒ 只能 pass（不得甩炸弹）
  // ④ 首出 ⇒ 最小单张（保持切片 9 判据）
  ```
- [ ] **Step 2: 跑红**（`cd packages/shared && pnpm vitest run src/ddz/play.test.ts`）。
- [ ] **Step 3: 实现**：跟牌分支 = 把 `session.players[playerIdx].hand` 经 `douzeroIntToCard()` 适配 → `findSmallestBeatingCards(cards, session.lastPlayedHand)` → 有解则 `handlePlayCards(session, playerId, result.map(cardToInt))`；无解则 `handlePass`；首出分支保持「最小单张」。同时把 `findSmallestBeatingCards` 的入参放宽为 `ParsedHand | BeatTarget`。
- [ ] **Step 4: 跑绿**（`pnpm vitest run src/ddz src/rule`）+ `pnpm lint`。
- [ ] **Step 5: 提交**（`feat(shared): 出牌超时逐字实现 §9.1 四步（最小可压→炸弹→王炸→过牌，C5 收口, R204）`）。

---

## Task 3: C7 + C8 —— `actionLog` 与公开特征（R205）

**Files:** Modify `packages/shared/src/ddz/{types,play,bid}.ts`；Create `packages/shared/src/ddz/features.ts` + `features.test.ts`；Modify `packages/game-service/test/view.builder.test.ts`

**Interfaces:** Produces `buildPublicFeatures(session: GameSession, seat: number): RobotFeatures`（形状 = 契约）。

- [ ] **Step 1–2（TDD）**：`features.test.ts`：① 空 `actionLog` ⇒ `playedCards` 全空、`actionSeq` 空；② 人类打出一手 + 一次 pass ⇒ `playedCards` 只含**打出的**牌（pass 不产生牌）、`actionSeq` 顺序正确；③ **反例**：地主手牌里的牌**不得**出现在任何 `playedCards` 里（C8 的核心判据——旧实现在这里把未出的牌也「估」出来）；④ `actionLog` 不出现在任何出站视图（`view.builder.test.ts`）。
- [ ] **Step 3: 实现**（types 加字段；play/bid 写入与清空；features.ts 投影）。
- [ ] **Step 4–5: 跑绿 + 提交**（`feat(shared): GameSession.actionLog + 公开特征投影（C8, R205)`）。

---

## Task 4: C9 + `robot.decide`（R206/R200）

**Files:** Modify `packages/robot-service/src/robot/{robot.service,bot.player,robot.controller,robot.module}.ts`；Create `packages/robot-service/test/robot.decide.test.ts`；Modify `.../test/bot.player.test.ts`

- [ ] **Step 1–2（TDD）**：`robot.decide.test.ts`（`DouZeroClient` 替身 + 0 延迟）：① DouZero 返回合法牌 ⇒ `source:'douzero'`；② DouZero 抛错 ⇒ 走规则引擎（`source:'rule'`，**不是** pass —— 旧实现直接 pass，RED 原文 `expected 'pass' to be 'play'`）；③ DouZero 返回空数组 ⇒ `kind:'pass'`；④ 规则引擎无解 ⇒ pass；⑤ `/api/robots/decide` 无 `X-Internal-Token` ⇒ 401 + `10002`。
- [ ] **Step 3: 实现**（`BotPlayer.decide(req: RobotDecideRequest): RobotDecideResponse`；`RobotService.decide()`；controller 新增 `@Post('decide')`）。
- [ ] **Step 4–5: 跑绿 + 提交**（`feat(robot): robot.decide + DouZero 失败回退规则引擎（C9, R206)`）。

---

## Task 5: E9 + §9.6 池闭环（R201/R207）

**Files:** Create `packages/robot-service/src/robot/robot.pool.ts`、`packages/robot-service/test/{helpers/fake-redis.ts,robot.pool.test.ts}`；Modify `robot.service.ts`、`robot.module.ts`、`robot.controller.ts`、`packages/room-service/src/rooms/rooms.bots.ts`（Create）、`match/match.service.ts`、`gateway/ws.gateway.ts`

- [ ] **Step 1–2（TDD）**：`robot.pool.test.ts`（假 Redis，**按真实语义**）：① 池空 ⇒ `acquire({roomCode:'R1', seats:[1,2]})` 创建 2 个 bot（`botId` 内部 + `displayId === /^p_[0-9A-Za-z]{8}$/`、`roomCode`/`seat` 由 robot-service 写入）；② **幂等**：同 `{roomCode:'R1', seats:[1]}` 再调 ⇒ 返回**同一个** `botId`/`displayId`，`ZCARD bot:pool:ddz` 不变；③ `release({botIds})` ⇒ 两个 bot 回池（`ZADD`，`score = idleSince`）、`bot:{botId}` 的 `roomCode`/`seat` 清空；④ 回收：`ZRANGEBYSCORE` 取到 `idleSince` 超过 10 分钟且 `roomCode` 指向的房间不存在 ⇒ `ZREM`；⑤ **对局中不回收**（`roomCode` 房间存在 ⇒ 留着）。
- [ ] **Step 3: 实现**池 + `acquire`/`release` 端点 + `create` 改为委托 `acquire`（单一实现）。
- [ ] **Step 4: room-service 侧**：`match.service.acquireBot` 改调 `POST /api/robots/acquire`（`{roomCode, seats:[seat]}`）、把 `botId` 写进 `room:{code}:bots` 并**透传**到 `game.start` 的 `players[]`（`botId` + `skillLevel`）；`ws.gateway.onGameEvent` 的 `game.ended` 分支调 `robot.release` + 删 `room:{code}:bots`。
- [ ] **Step 5–6: 跑绿 + 提交**（`feat(robot,room): displayId 分离 + bot:pool 闭环 + botId 透传（E9/§9.6, R201/R207)`）。

---

## Task 6: §9.4 回合驱动（R208）

**Files:** Create `packages/game-service/src/game/robot.client.ts`、`packages/game-service/test/game.robot.test.ts`；Modify `game.service.ts`

- [ ] **Step 1–2（TDD）**：`game.robot.test.ts`（`vi.useFakeTimers()` + `fetchImpl` 替身 + `robotDelay: async () => {}`）：按 R208 的四条判据写（**每条都在下断言前先证明探针能观测到「发生」**）。
- [ ] **Step 3: 实现**（`RobotClient` + `driveRobotTurn` + 回退链 + 串行闸）。
- [ ] **Step 4–5: 跑绿 + `pnpm lint` + 提交**（`feat(game): 服务端驱动机器人回合 + 失败/非法回退规则引擎（§9.4, R208)`）。

---

## Task 7: A7④⑤（R209/R210）

**Files:** Modify `packages/room-service/src/gateway/game.client.ts`、`gateway/ws.gateway.ts`（若注入点在此）、`match/match.service.ts`、`test/{game.client,match.service}.test.ts`

- [ ] **Step 1–2（TDD）**：① `game.client.test.ts` 仍全绿（语义不变）；② `match.service.test.ts`：`HttpService` 替身首次 401 ⇒ **同参数再发一次**（断言 `callsTo(..., '/api/games')` 长度 2 且两次载荷逐字相同）；两次都失败 ⇒ 不抛 + 房间 `cancelled`（`game.start`）/ 以较少人数开局（`acquire`）。
- [ ] **Step 3: 实现**重试 1 次（`maxAttempts = 2`）。
- [ ] **Step 4: 跑 `outbound-timeout.gate.test.ts` 与 `no-raw-console.test.ts` 确认机械闸仍绿**。
- [ ] **Step 5: 提交**（`refactor(room): game.client 统一 HttpService + RPC 失败重试 1 次（A7④⑤, R209/R210)`）。

**后端 DoD**：`cd .worktrees/backend && pnpm exec turbo run test lint --force` 全绿（0 cached）+ `pnpm exec turbo run build --force` 10/10；汇报附**每条判据的修前 RED 原文**（尤其 E4 的 7 型、C9 的 `expected 'pass' to be 'play'`、§9.4 的「不推进 30s 就产生转移」）。

---

## Task 8（协调者）: conformance `slice-11` + `slice-07` 注释修正

**Files:** Create `tools/conformance/src/slices/slice-11-robot-system.ts`；Modify `run.ts`、`package.json`、`slice-07-match-join.ts`

**判据集（六组，全部结构性）：**
1. **§9.4 服务端驱动**：单人匹配 → 30s 补位 2 机器人 → `game.deal` → **人类不动作**，断言叫抢在 ≤5s 内被推进（`version` 前进 / `state_update` 到达）——旧实现要等 30s 超时。**两段式判据**：先证明「30s 未到」（`Date.now() - dealAt < 5_000`），再断言已推进。
2. **机器人出牌 + 合法性**：人类出牌后，机器人在 ≤5s 内产生状态转移；`lastPlayedHand` 形状合法（`cards` 非空、`type !== 0`、`keyRank` 是内部 Rank）；**不得**出现 `system.error`。
3. **一局能被机器人推进到结束**：人类全程 pass，断言对局在有限时间内以 `game.finished` 收束（旧实现：每次都要等 30s 超时，几乎不可能在门禁时间内完成）。
4. **§9.8 泄漏扫描（扩展）**：整局的**每一条** S→C 消息 + `GET /api/rooms` + `room.join` ack 都不得含 `bot-`/`isRobot`/`botId`/`skillLevel`；**正对照**：`displayId` 形如 `p_<8位>`（与人类 id 同构）。
5. **池闭环**：局终后 `docker compose exec -T redis redis-cli ZCARD bot:pool:ddz` 比开局前**增加 2**（`spawnSync` 用法照抄 `slice-07.2-deploy.ts`；键名/形状逐字照 `design.md` §10.1：**ZSET**、`member=botId`、`score=idleSince`）；且对应 `bot:{botId}` 记录中 `roomCode` 已清空/键不存在。
6. **幂等 acquire（R201/R210 的前提）**：直连 3005 带内部 token，对同一 `{roomCode:'S11IDEM', seats:[1]}` 调两次 ⇒ 两次 `botId`/`displayId` **相同**；池计数不因此净增第二次。

```bash
cd /home/howe/pokergame
pnpm --filter @fight-the-landlord/conformance build
timeout 300 node tools/conformance/dist/run.js slice-11
```

---

## 门禁（协调者，合并后执行）

```bash
cd /home/howe/pokergame
git merge feat/backend --no-edit

pnpm exec turbo run test lint --force      # ✅ 期望 29/29、0 cached
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 前端无改动，回归

pnpm exec turbo run build --force          # ⚠️ robot-service 是 bind-mount，必须先 build
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 新增
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项（补位回归，机器人现在会行动）
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项（结算回归：机器人局也要守恒）
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 53 项（§9.8 扫描）
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 374 项
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项
docker compose logs api-gateway | grep -c 'Blocked outbound'          # ✅ 0
```

---

## Self-Review

**Spec coverage**
| 规格 | 落在哪个 Task |
|---|---|
| §9.1-1 不可区分性 | R207（`displayId`）+ Task 5 + Task 8 第 4 组 |
| §9.1-2 服务端驱动 | Task 6 + Task 8 第 1/3 组 |
| §9.2 机器人实例（`botId`/`displayId` 分离） | Task 5/R207 |
| §9.3 双轨 + 降级链 | Task 4/R206（`source` 如实标注） |
| §9.4 回合驱动 + 思考延迟 | Task 6/R208 + Task 8 第 1/2/3 组 |
| §9.5 可见信息边界（`view` + 公开特征） | Task 3（投影）+ Task 4（`view`+`features` 入参）+ Task 6（不传 session） |
| §9.6 填充/归池 | Task 5/R201 + Task 8 第 5/6 组 |
| §9.8 验证手段 | R211 + Task 8 第 4 组 |
| §3.2 `actionLog` | Task 3 |
| §4.2 `RobotDecideRequest/Response` | Task 0（契约）+ Task 4 |
| §4.3 超时/重试 | Task 7/R210（`robot.decide` 5s 不重试见 Task 6） |
| 玩法 §9.1 ①②③ | Task 1（`autoplay`）+ Task 2 |
| C7/C8/C9/E4/E9 | Task 3 / 3 / 4 / 1 / 5 |
| A7④⑤ | Task 7 |
| N20（TCP RPC 未迁移） | **不在本片**，写进对账表 → P4 |

**Placeholder scan**：无 TBD；Task 1 的用例表里标注「逐型补全」是**表格行的枚举**（14 型在 R202 里已逐字列出），不是「随便写点」。
**Type consistency**：`RobotFeatures` 的唯一形状来自 `packages/protocol`（Task 0 落盘、Task 3/4/6 消费）；`RobotDecideRequest.view` 是 `PlayerView`（Task 0）；`buildPublicFeatures(session, seat)` 在 Task 3 定义、Task 6 消费；`botId`/`displayId` 的语义在 R207 定义、Task 5/6/8 共用。

---

## 执行期裁决（回填区，**不要删**）

- **R214（conformance 方发现，协调者确认）：Task 8 的第 1/3 组判据必须按**真实座位与规则**收窄，否则它们在任何实现上都不可满足。**
  - 事实：单人补位房里**人类必坐 seat 0**（`rooms.service.createGameRoom` 用 `claimSeat` 取**最小空位**），而 `bidPhase.currentBidder` 初值就是 **0** ⇒ 「人类**完全不动作**、叫抢仍被推进」**在修好后也不成立** —— 人类自己那一次叫抢本来就该由客户端参与（§9.4 只管**机器人**回合）。
    ⇒ 第 1 组改为：「人类只在自己的**首个**叫抢回合决策一次，此后**再不动作**」⇒ 断言**机器人在 ≤5s 内**完成它的叫抢（`version` 前进 / `state_update` 到达），且**距 `game.deal` 远未到 30s**（两段式：先证 `elapsed < 5000`，再证已推进）。旧栈在本判据下仍 **RED**（5s 内无任何转移，只能等 30s 超时）⇒ **判别力不变**。
  - 事实：玩法 §6.2-2 禁止首出过牌（C18）⇒ 第 3 组「人类全程 pass」必须改成「人类**首出打最小单张**，此后全程 pass」。
  - 这两条**不是放宽断言**，而是把「不存在的规格」换成「存在的规格」；原判据的字面在任何实现上都会假红。

- **R215（叫抢阶段的 `kind` 约定，写进契约）**：`RobotDecideResponse` 只有 `'play' | 'pass'`（§4.2 的形状如此），而 DouZero 没有叫抢模型
  ⇒ 约定**按阶段解释**：出牌阶段 = 出牌/过牌；**叫抢阶段 = 抢/不抢**（`play` = 抢），叫抢一律走规则引擎（`source:'rule'`）。
  **本裁决已落进契约注释**（`packages/protocol/src/robot.ts`，`f1ae35f`），而不是靠口口相传 —— 同一个二进制响应在两阶段各有唯一含义，
  不需要第二个真源（例如再加 `grab?: boolean`）。
- **R216（门禁期实测：`useClass` + 带默认值的构造参数 ⇒ 容器 crash-loop）**：`ws.module.ts` 的 `{ provide: GAME_CLIENT, useClass: GameClient }`
  让 Nest 去解析 `GameClient` 的**第二个构造参数**（`options: GameClientOptions = {}`）—— Nest **看不见默认值**，只看见一个没有 provider 的依赖 ⇒
  room-service 启动即崩：`Nest can't resolve dependencies of the GameClient (HttpService, ?)`（**单测 173/173 全绿**，因为它们直接 `new` 或提供替身）。
  修法：改 `useFactory: (http) => new GameClient(http)`（`inject: [HttpService]`）。
- **R217（门禁期实测：provider 缺 `@Injectable()` ⇒ 依赖静默变 `undefined`）**：`RobotPool` 没有 `@Injectable()`，Nest 便用 `new RobotPool()`
  **无参构造** ⇒ `this.redis === undefined` ⇒ `/api/robots/acquire` **500**（`Cannot read properties of undefined (reading 'hget')`）；
  同时它的 `redis` 参数原来是 `import type Redis` ⇒ `emitDecoratorMetadata` 只能发出 `Object`，token 也对不上 `RedisProviderModule` 的 `Redis`。
  修法：补 `@Injectable()` + **值导入** `import { Redis } from 'ioredis'` + `clock` 标 `@Optional()`（带默认值的参数在 Nest 眼里同样是待注入依赖）。
  **教训**：`new XxxService(fake)` 式单测**覆盖不到 Nest 装配层**，只有容器门禁能抓。
- **R218（门禁期实测：判据钉住实现形态 —— R150 同族第三次发作）**：A7④ 把 `room-service/src/gateway/game.client.ts` 从「注入 `fetchImpl`」
  改成「注入 `HttpService` + `timeout:`」之后，**两张源码级闸的指名正对照必然失效**：
  `api-gateway/test/outbound-timeout.gate.test.ts` 判据 B 与 conformance `slice-07.2-hardening` 第 9 步都硬要求它出现在 `callsFetch` 的命中集合里。
  修法（两处一致）：**正对照只列仍走 fetch 的文件**（`proxy.gateway.ts`/`douzero.client.ts`），并**新增判据 A′**「注入式 HTTP 客户端也必须带超时标记 `timeout:`」。
  **规则**：判据要钉**性质**（「有超时」），不是钉**形态**（「是 fetch」）；且新增判据必须自带正/负对照（本片给 `hasTimeoutMarker` 补了两条）。
- **R219（HTTP 状态语义）**：`robot.controller` 的 `acquire`/`release`/`decide` 显式 `@HttpCode(200)` —— POST 的默认 201 是「创建资源」的语义，
  而这三者都是**动作**（申领 / 归池 / 求一个动作），且 `create`（兼容壳，确实创建资源）保持 201 不动。conformance `slice-11` 的 `idem` 组按 200 断言。

## 门禁实测（已通过，master `8380e6d`，全部 `--force`、0 cached）

```bash
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached
pnpm exec turbo run build --force          # ✅ 10/10
cd apps/client && pnpm test && pnpm lint && pnpm build   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d          # 8 容器 healthy
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 44 项，93.4s（新增）
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项，35.8s
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项，20.7s
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项，25.4s
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项，8.9s
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅ 54 项，14.9s（+1）
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅ 22 项，9.7s
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 70 项，5.0s
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项，4.9s
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项，2.0s
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 299 项，0.4s
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项，53.4s
docker compose logs api-gateway | grep -c 'Blocked outbound'         # ✅ 0
```

单测分项（`--force`、0 cached）：`shared` **171**（135→+36）· `room-service` **173**（159→+14）· `game-service` **83**（75→+8）·
`robot-service` **37**（15→+22）· `api-gateway` **107**（+1）· `protocol` 43 · `user-service` 29 · `client` 163(+2 skipped) · `mock-server` 2。
⇒ **关闭：C7/C8/C9/E4/E9/A7④⑤ + C5、C6 的剩余半边 + §9.4**；**新增 N20（TCP RPC → P4）与 N21（§9.6 回收扫不到丢失 `release` 的绑定机器人）**。

**负对照（未修栈 = 切片 10 镜像；conformance 方逐组取原文）**：
```
drive  ❌ §9.4 服务端驱动：人类不再动作后，机器人在 5881ms 内被推进（窗口 5000ms；距 game.deal 仅 6003ms…）：（窗口内没有任何 game.state_update）
play   ❌ §9.4：人类出牌产生 v5（currentPlayer=1）之后，机器人在 5000ms 内自行推进…：（窗口内没有任何 game.state_update）
finish ❌ 第 3 组：对局在 150s 内没有收束（…已观测 5 个机器人回合 + 3 次人类动作）
leak   ❌ 机器人的对外 id 形如 p_<8位>（§9.2/E9）：实际 ["seat-1","seat-2"]
pool   ❌ 本局 2 个机器人都在「池的前后成员」里能被 bot:{botId}.displayId 对上 —— 实际命中 []（候选 []）；ZCARD 0 → 0
idem   ❌ 第 1 次 acquire 的 HTTP 状态…：期望 200，实际 404（Cannot POST /api/robots/acquire）
单测   E4 7 型逐型红 / 面对王炸 `expected [ …(4) ] to be null` / 飞机带单 `expected [5,5,5,5,6,6,6,7] to deeply equal [5,5,5,6,6,6,7,8]` /
       C5 `expected [ 7 ] to deeply equal [ 9 ]` / C9 `expected 'pass' to be 'play'` /
       幂等 `expected 'bot-f06d200d' to be 'bot-d08a9225'` / §9.4 `expected 1 to be greater than 1` / A7⑤ `expected "spy" to be called 2 times, but got 1`
```
⚠️ 旧栈上 `slice-07` 仍 39 ✅（机器人不行动只影响新切片）；且**旧栈上 §9.8 四标记扫描也全绿**（对外 id 是 `seat-1/seat-2` 掩码）
⇒ 不可区分性的判别力只能来自 `p_<8位>` 的**正向**断言（已做成硬断言，见交接说明第 7 条教训）。

## 下一步

**切片 9/10/11 全部收口** ⇒ `docs/design.md` 附录 A.2 的偏差与新增 N 系列**只剩两个独立小片**：
- **P3（工程）**：E2 `user-service` 读 `PORT` · E6 `Room.timeoutAt` · E7 关 `synchronize` + 显式迁移 · N9 房间元数据 Hash 化 ·
  N12 未知路由信封 · N14 非 `/api` 前缀机械闸 · N15 后端半边（限额挪到 `allowRequest`）· **N21**（§9.6 回收扫不到「`release` 丢失」的绑定机器人，低优先级）；
- **P4（基础设施）**：**N20** —— §4.2 的 TCP RPC 迁移（`connectMicroservice` + 3103/3105 + compose 端口 + 全部调用点，**必须一次全切**，半迁移比不迁移更糟）。

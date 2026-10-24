# 片① 「叫抢规则」设计规格（**草稿 v4 · 三轮审查后 · 已达「可进实施计划」**）

> **状态**：草稿。**审查③ 的结论：「v3 可以进实施计划」** —— 其 3 项「进计划前先落」的修复已全部落到本版（v4）。
> **待用户过目**后即可进实施计划。
> **范围**：只做叫抢规则 + 机器人叫抢行为。AI 全量化（100% DouZero / 兜底开关 / 三档模型 / Python 服务多线程）属于**片②**。
> **来源**：用户 2026-09-30 的四条裁决 + **四轮**审查（自查 5 洞 · 审查① 4 个硬缺口 · 审查② 7 项缺口 + 10 处事实错误 · 审查③ 验证 + 3 项新缺口）。
>
> 🔵 **审查②的核心结论**：v1 的四个硬缺口**确实修好了** —— §3 真值表的 8 组合 + 反抢帧两个出口
> **逐条代入** §4.2 伪码验过终止性与结果一致性，且伪码里每个字段读写都与 `bid.ts` 现有实现逐一对齐。
>
> 🔴 **审查③ 的核心结论**：机制层（§2/§3/§4）**未找出反例**；但抓到 3 个会让 CI 或运行时咬人的洞
> —— 其中 **1 个会静默失效**（`applyDecisionToSession` 拿不到注入的随机源）。见 §0.3。

---

## 0. 修订对账

### 0.1 v2 相对 v1 修了什么

| v1 的缺口 | v2 的处置 | 审查② 复核 |
|---|---|---|
| 「本轮结束」判据**不终止** | §4.2 对**决策计数单调** + `antiRobGranted` 一次性标志 | ✅ **验证通过**（8 组合 + 两出口全覆盖） |
| 推进公式 `(p+1)%3` **静默指错人** | §4.2 反抢帧**显式** `= firstCaller` | ✅ 验证通过 |
| 「首次叫者」**未定义** | §2 定义 + §2 的**等价性证明**（首次声称 ≡ 首次叫） | ✅ 证明成立 |
| 全不叫可走到 `finalizeBidding(-1)` ⇒ **无地主死锁** | §4.1：`landlordCandidate !== firstCaller` 一个比较即机械表达 | ✅ 验证通过（真值表 #1） |
| R3 说「成为死代码」是**定级错误** | §5.5：是 **`pnpm build` 失败** ⇒ 必须删除 | ✅ 并指出**处方本身仍会失败**（见 0.2-3） |
| 行号引错（`currentBidder` 写成 `game.ts:43`） | §5.1：实为 **`:39`** | ✅ 已核 |

### 0.2 v3 相对 v2 修了什么（审查② 的 7 项）

| # | v2 的问题 | v3 的处置 |
|---|---|---|
| 1 | 🔴 **§7.1 的 `?? -1` 兜底"必然误触发反抢"**（不是防止）：`landlordCandidate >= 0` 时 `0 !== -1` 恒真 ⇒ `currentBidder = -1` ⇒ 每 30s 空转、房间永久停摆。且迁移的**唯一正确源**（`decisions`）被 §2 禁止 | §7.1 改为 **`loadSession` 一次性迁移**（读 `decisions` 反查第一条 `grab=true`）+ §2 加**唯一例外**条 |
| 2 | §7.1 层 2「本仓有房间回收机制」**不覆盖在途房间**（`rooms.reaper.ts:14-23` 明文 `playing` 不得回收） | §7.1 改为**写死清键命令**，不引用回收机制 |
| 3 | 🔴 **§5.5 的处方会让 `pnpm build` 失败**：`noUnusedParameters` ⇒ `decideBid(req)` 恒返回后 `req` 未读 ⇒ TS6133 | §5.5：**删掉 `decideBid`**，在 `decide` 的 `:53` 直接返回常量 |
| 4 | **§11 与 §5.1 自相矛盾**（3 次 vs 4 次声称）；且**反抢那一抢对倍数无贡献** | §11 统一为「最多 **4** 次声称；第 4 次因 cap 不再加分；上限仍 8」；§4.2 补写这条。<br>🔴 **2026-09-30 修复轮订正（本行「处置」列的机制表述）**：「第 4 次因 cap 不再加分」**有误**（只对「前 3 拍已 3 次声称」成立；前 3 拍 2 次声称时反抢那一抢把 4 升到 8）—— 正确表述见 §4.3；「上限仍 8」的**结论不变**。 |
| 5 | **§5.2「消费 0/1/2 个随机数」是错的**（恒为 0 或 1）；且注入 random **不会让发牌确定** | §5.2 订正 + 补「单局最多约 10 次消费」+ 补「发牌仍不确定」 |
| 6 | **§5.2/§5.6 冲突 ⇒ §6.2 对 5 个服务级测试不可执行**（没有可传 `() => 0` 的入口） | §5.6 **定死**：给 `GameService` 加可注入 `random` 字段（照 `BotPlayer.random` 的范式） |
| 7 | **§6.1/§6.2 名单错漏**（漏 2 处确定性红 + 2 处编译错；`full-game.test.ts` 形态标错；误列 3 条） | §6 整节按审查② 订正（**⚠️ v3 自己的 §0.2 计数与正文对不上账 —— 审查③ 指出；v4 起计数以正文为准**） |
| 8 | §5.4「现状是零保障」**不准确**（顶层键集已被钉住，零保障的只是 `bidPhase` 子层） | §5.4 订正 |
| 9 | §9 措辞偏差（反抢者两次决策**不连续**，中间夹第 3 拍）+ **第 4 处**过期前提 | §9 订正 + 补第 4 处 |
| 10 | 10 处**事实性错误**（行号 / 断言与代码不符） | §5 / §6 / §9 / §10 逐处订正 |

### 0.3 v4 相对 v3 修了什么（审查③ 的 3 项 + 其新事实）

| # | v3 的问题 | v4 的处置 |
|---|---|---|
| 1 | 🔴🔴 **§5.6 漏了第 4 个随机源调用点**：`applyDecisionToSession`（`game.service.ts:725-736`）是**模块级自由函数**（无 `this`），机器人驱动链的 `handleBid` 在 `:731` ⇒ 拿不到 `this.random`。而签名有默认值 ⇒ **漏传不报错、静默退化** ⇒ 含机器人的房仍不确定 | §5.6 逐个列出**全部 4 个调用点**（`:175` / `:281` / `:668` / **`:731`**），并写明 `applyDecisionToSession` 要**加形参**、由 `commitRobotDecision`（`:598`）传 `this.random` |
| 2 | **§6.1 漏了一个编译错**、§6.2 把它**误分类**成 R1-flaky 并给了**不适用的处方** | `view.builder.test.ts:32-33, 52-61` 移入 §6.1（⚠️ 它只在 **CI 阶段 2/6 `turbo run lint`** 红，`pnpm build` 抓不到） |
| 3 | **§7.1 的迁移在「`decisions` 整个缺失」的老会话上精确复现停摆** | 迁移加固：`firstGrab?.seat ?? (landlordCandidate >= 0 ? landlordCandidate : -1)` + `session.bidPhase?.` 守卫；**「清键 or 迁移」定死为两条都做**（清键主、迁移兜底） |
| 4 | §7.2 只说了「客户端先行」，**漏了服务端混部** | 新增 **§7.3**：`proxy.gateway.ts:372-376` 对校验失败**静默丢弃** ⇒ 「7 个镜像同版本上线；网关与 game-service 不得跨版本混跑」 |
| 5 | §9 的**新证据链自己引错行号**（该节正是「订正行号」的那一节） | `BidPanel.vue:17`（非 `:20`）· `stores/game.ts:154-156`（非 `:150`）· `table.vue:228-229`（非 `:224-229`） |
| 6 | §9 的「四处副本」漏第 5 处 | 补 `handoff.md:140`（「钟只在 `decisions` 为空那一拍出现」在反抢下不再成立） |
| 7 | §6.2 引的 `game.timer.test.ts:89-101` 起点早 6 行；`full-game.test.ts` 只列了 `:61-81` | 订正为 `:95-103`；补 `:84-88`（INTEG3 同样要注入 ⇒ **文件级统一注入**） |
| 8 | §7.1 的清键命令**没写前置** | 补三处：compose 工程目录 · redis 在跑 · `xargs -r` 是 GNU 扩展（BSD/macOS 会 `illegal option`） |
| 9 | §7.1 的迁移副作用**未核** | 已核并写入：每进程每房至多跑一次 · 幂等 · 改的是新对象 · **不改 `version`**（否则破坏 CAS）· 下一次状态转移自然落盘 |

---

## 1. 用户已裁决的四条

1. **起始座位随机**（不再固定座位 0），新局与每次流局重发都重摇
2. **反抢**：走满 3 次决策后，若「最后声称者 ≠ 首次声称者」，**首次声称者**可再决策一次（抢/不抢），决策完本轮立刻结束 ⇒ 决策数上界 **4**
3. **机器人既不叫也不抢**（恒 pass），无论难度
4. **不接叫抢 AI 模型**（上游 `kwai/DouZero` 仓库树里含 `bid` 的路径为 **0** 条、`baselines/` 只有占位文件；README 指向的是一个在线服务而非可下载权重）⇒ 叫抢保持规则

---

## 2. 两个标量的定义（🔴 必须逐字写死）

| 字段 | 定义 |
|---|---|
| `firstCaller` | 本轮**第一条** `grab=true` 的座位；本轮无人声称则 `-1` |
| `landlordCandidate` | 本轮**最后一条** `grab=true` 的座位（现有语义不变） |

⚠️ **必须用这两个字段判定，不得读 `decisions`。**
依据：`docs/games/doudizhu.md:107`（审查② 已核，v2 误引为 `:104-105`）明令「它**只用于展示**，任何判定都不得读它」。

🔴 **唯一例外（老会话迁移）**：`loadSession` 对**在途老会话**做一次性迁移时，**允许且必须**读 `decisions`
反查第一条 `grab=true` 的座位（那是老数据里**唯一**的真源）。除此之外任何位置都不得读。
⇒ 理由见 §7.1 —— 不这么做，「兜底」会**必然误触发反抢**。

🔵 **与用户原话的对齐（消除 v1 的歧义）**：用户说的是「首次**叫地主**的玩家」，
本规格定义的是「首次**声称**者」—— 两者**恒等**，因为**第一条声称必然是 `kind='call'`**：
`bidKindOf`（`bid.ts:22-26`）由 `landlordCandidate === -1` 派生，而第一声称发生时该字段还是 `-1`
（每轮起点该字段必为 `-1`：`createSession` `game.ts:41` / `resetBidding` `bid.ts:143`）。
⇒ 「首次声称者」不会是一个「从没叫过的人」。（审查② 复核：**证明成立**。）
⚠️ v1 把这两种读法并列而没有定死，它们在 8 组合里有 3 种结果不同（见 §3 表）—— 本版按**首次声称**定死，并证明它与用户原话等价。

---

## 3. 规则真值表（八组合，逐条给确定结果）

始点 s0（**R1 之后始点是随机的**，本表以「决策顺序」s0→s1→s2 表示，与座位号无关）。

| # | 决策序列 (grab?) | 声称者集合 | `firstCaller` | `landlordCandidate` | 反抢 | 结果 |
|---|---|---|---|---|---|---|
| 1 | F,F,F | ∅ | `-1` | `-1` | — | **流局**（candidate 与 firstCaller 相等 ⇒ 不进入反抢）|
| 2 | T,F,F | {s0} | s0 | s0 | — | 地主 s0 · 倍数 2 |
| 3 | F,T,F | {s1} | s1 | s1 | — | 地主 s1 · 倍数 2 |
| 4 | F,T,T | {s1,s2} | **s1** | s2 | **s1** | 第 4 拍 |
| 5 | T,T,F | {s0,s1} | **s0** | s1 | **s0** | 第 4 拍 |
| 6 | T,F,T | {s0,s2} | **s0** | s2 | **s0** | 第 4 拍 |
| 7 | T,T,T | {s0,s1,s2} | **s0** | s2 | **s0** | 第 4 拍 |
| 8 | F,F,T | {s2} | s2 | s2 | — | 地主 s2 · 倍数 2 |

**反抢帧（第 4 拍）的两个出口**：

| 反抢者 | `landlordCandidate` | 地主 |
|---|---|---|
| **抢** | 变成他（= `firstCaller`） | 反抢者 |
| **不抢** | 保持（末位声称者） | 末位声称者 |

⇒ **反抢者恒 = `firstCaller`，且只在「≥2 人声称」时存在。**

---

## 4. 形式化判据与行动者赋值（🔴 本片最容易写错的两处）

### 4.1 反抢权（本轮一次性）

```
hasAntiRob = (landlordCandidate !== firstCaller)
```

**这一个比较就够**，不需要额外的 `-1` 判断：

- 全不叫 ⇒ `-1 !== -1` 为假 ⇒ 无反抢 ✓（**这正是「全不叫不进反抢」的机械表达**）
- 单人声称 ⇒ `candidate === firstCaller` ⇒ 假 ⇒ 无反抢 ✓
- ≥2 人声称 ⇒ 不等 ⇒ 真 ⇒ 反抢 ✓

> ⚠️ 它**看起来**像一个通用比较，最省事的实现是去扫 `decisions` —— **禁止**（见 §2）。用 §2 的两个字段判。

### 4.2 `handleBid` 的算法（改写后的骨架）

```
handleBid(session, playerId, bid, random = Math.random):
  校验：state === Bidding、playerIdx === currentBidder
  decisionKind = bidKindOf(bidPhase)            // 现有实现，反抢帧给 'rob' ✓
  grabActions++

  if bid:
    landlordCaller = playerIdx                  // 现有语义：末位声称者（§10 死重量）
    landlordCandidate = playerIdx
    if firstCaller === -1: firstCaller = playerIdx      // 🔴 只记第一次
    bidMultiplier = min(bidMultiplier * 2, 8)           // 反抢同样 ×2
  else:
    bidPasses++
  记 decisions

  // ① 派发反抢（一次性）
  if !antiRobGranted && grabActions === 3 && landlordCandidate !== firstCaller:
    antiRobGranted = true
    currentBidder = firstCaller                 // 🔴 显式赋值，**不得**用 (p+1)%3
    return 推进版本号

  // ② 收口（对**决策计数单调** ⇒ 必然终止）
  if grabActions >= (antiRobGranted ? 4 : 3):
    if landlordCandidate !== -1: return finalizeBidding(session, landlordCandidate)
    redealCount++
    if redealCount >= 3: return finalizeBidding(session, 摇座位(random))
    return resetBidding(session, random)

  // ③ 常规推进（**只在非反抢帧**）
  currentBidder = (playerIdx + 1) % 3
  return 推进版本号
```

**两个必须写进注释的理由**：

- **①（反抢派发）为什么不能用 `(p+1)%3`**：3 次决策恰好走完一个座位循环 ⇒ `(末位决策者 + 1) % 3` **恒等于「首个决策者」**，而它**不是**「首个声称者」（#4/#5 即反例）。而 `handleBid` 只校验 `playerIdx === currentBidder` ⇒ 指错人时**规则违规静默通过、连错误码都没有**。
- **②（收口判据）为什么必须对计数单调**：若按 v1 的字面 `grabActions >= 3 && candidate !== firstCaller`，反抢者一「不抢」该条件仍为真 ⇒ 行动者被反复指回同一人 ⇒ **叫抢永不结束**（客户端看到同一人一直持钟，配 30s 超时每半分钟空转一次）。`antiRobGranted` 保证反抢**一次性**。

### 4.3 倍数：反抢那一抢**同样 ×2**，但任何路径都不越过 8（必须写死，否则会被"顺手改 16"）

实现（`bid.ts:70`）是**每次声称无条件** `Math.min(m × 2, 8)` ⇒ 第 4 次声称（反抢那一抢）的
效果**取决于前 3 拍声称了几次**：

| 前 3 拍 | 派发反抢时 m | 反抢者「抢」后 | 结论 |
|---|---|---|---|
| **3 次声称**（真值表 #7：抢/抢/抢） | **8** | `min(8×2, 8)` = **8** | **不变**（原句只覆盖了这一支） |
| **2 次声称**（#4/#5/#6，如 抢/不抢/抢） | **4** | `min(4×2, 8)` = **8** | **升到 8** ← 反抢那一抢**会**加分 |

⇒ **任何路径都不越过 8** ⇒ **`BID_MULTIPLIER_CAP = 8` 仍然成立**，`{1,2,4,8}` 值域不变
（与 §4.2 伪码的 `// 反抢同样 ×2` 一致 —— 两者曾自相矛盾，已消除）。
⇒ ⚠️ 实现者看到「决策数上界从 3 变 4」很容易**顺手把上限改成 16** —— **不许**：
`docs/games/doudizhu.md:104-105` 与结算真源（`settle.ts`）都依赖这个值域。

> 🔴 **2026-09-30 修复轮订正（本节的原文）**：本节此前写「反抢那一抢**对倍数无贡献**」与
> 「4 次（反抢抢）→ `min(8×2, 8)` = 8 ← 不变」—— **错**：那只覆盖「前 3 拍已 3 次声称」（#7）这一支；
> 其余三支（#4/#5/#6，前 3 拍 2 次声称）反抢那一抢**会**把 4 升到 8（判据 = `bid.test.ts` 的
> 「反抢那一抢**会**加分」用例）。**结论（上限 8、值域、「不许改 16」）全部不变。**

### 4.4 反抢帧的超时

反抢帧是一次**普通 30s 回合**（`game.service.ts:651-652` 按 `bidPhase.currentBidder` 取人）⇒ 超时 = 不抢 ⇒ **必须走同一个收口**。正确性完全押在 4.2 的判据上（判据写错，超时也会跟着空转）。

---

## 5. 改动清单（行号已逐条复核）

### 5.1 `packages/shared/src/ddz/`

| 文件:行 | 改什么 |
|---|---|
| `types.ts:80-93` | 🔴 **类型定义本体**：`bidPhase` 接口新增 `firstCaller: number`、`antiRobGranted: boolean`（**必填** —— 漏了这行，下面两处的字面量改动无从谈起；审查② 指出 v2 漏了它） |
| `game.ts:39` | `currentBidder: 0` → **摇座位(random)**（⚠️ v1 误引为 `:43`，`:43` 是 `grabActions`） |
| `game.ts:38-47` | `bidPhase` 字面量新增 `firstCaller: -1`、`antiRobGranted: false` |
| `bid.ts:141` | `resetBidding` **重新摇座位** + 重置 `firstCaller`/`antiRobGranted` |
| `bid.ts:48 / 50-57 / 59-84` | 按 §4.2 重写 |
| `bid.ts:6-11` | `BID_MULTIPLIER_CAP` 的注释：「一轮制」的表述已失效（**数值仍为 8，不变** —— 4 次声称 ⇒ `min(1×2⁴,8)=8`） |
| `bid.ts:20` | 「本仓一轮制（每名玩家**恰好**决策一次）」→ 失真，改 |
| `bid.ts:59 / 132-133` | **R104 注释宣布作废** |
| `bid.ts:78` | 随机指定地主 → 收进注入参数 `random` |

### 5.2 随机源的注入（设计要点 A）

```ts
createSession(roomCode: string, playerIds: string[], random: () => number = Math.random)   // ⚠️ 第二参是 playerIds（game.ts:17），v2 误写成 players
handleBid(session, playerId, bid, random: () => number = Math.random)
```

**理由**：现有夹具大量靠「第一个人一定是 user-1」**隐含**构造。改成显式参数后，这条假设从**隐式**变成**显式**，并可加新判据「传不同的 random ⇒ 起始座位不同」。

⚠️ **消费次数（审查② 订正 v2 的错误）**：`handleBid` 一次调用**恒消费 0 或 1 个**随机数
（§4.2 ② 的两个分支互斥且都 `return`，各消费 1 个：摇座位 或 摇地主；其余路径 0 个）。
v2 写的「0、1 或 2 个」是**错的**。

⚠️ **但风险在调用之间**：单局最多约 **10 次**消费（机器人驱动环 + 两轮流局 + 摇地主）。
⇒ 测试**要么传常量函数**（`() => 0`），**要么给足长度**的序列。

🔴 **注入 random 不会让发牌确定**：`dealCards` 仍走 `Math.random`（`packages/shared/src/card/card.ts:75-80` 的 `shuffleDeck`）。
⇒ 需要**确定手牌**的用例仍必须像 `view.builder.test.ts:312` 那样**钉死手牌**。

### 5.3 `packages/protocol/src/`

| 文件:行 | 改什么 |
|---|---|
| `validate.ts:172-174` | `decisions.length > 3` ⇒ `> 4`（文案里的「一轮制」也要改） |
| `views.ts:121-122` | 🔴 **会过期的注释「（0..3）」**（审查② 指出 v2 漏了它） |
| `views.ts:129` | 注释「最多 3 条（一轮制天然有界）」 |
| `messages.test.ts:199-202` | 上界正/负例（现钉着 `/at most 3 items/`）⇒ **必红** |

### 5.4 🔴 `firstCaller` / `antiRobGranted` **永不出站** —— 缺的是**子层**的机械保障

**现状（审查② 订正 v2 的「零保障」说法）**：

- ✅ **视图顶层键集已被穷尽钉住** —— `game.controller.test.ts:138` 的 `Object.keys(view).sort()`
- ❌ **`bidPhase` 子层没有任何穷尽检查** —— `FORBIDDEN_OUTBOUND_KEYS`（`validate.ts:37-42`）不含这两个字段，
  `validateOutbound` 也不做子层键集穷尽，`assertNoLeak` 抓不到它们
- ❌ 目前唯一保障是 `view.builder.ts:77-107` **手写字面量**

⇒ **处置**：`view.builder.test.ts` 增一条 —— 「`PlayerView.bidPhase` 的键集**恰为**预期集合（穷尽）」。

🔵 **这条判据的价值比 v2 写的高**（审查② 指出）：若有人把 `bidPhase: { ...session.bidPhase }` **整块**塞进视图，
`assertNoLeak` 与顶层键集判据**都抓不到**（是子键）—— **只有这条新判据能抓**。

⚠️ 它的覆盖范围只到 `view.builder`；`tools/mock-server/src/scripted-game.ts:220-238` 与
`apps/client/test/helpers/*` **各自手抄键集，不在闸内**（另记）。

（推论：`landlordCaller` **现在也不进视图**，全仓只写不读 —— 见 §10-2。）

### 5.5 `packages/robot-service/src/robot/bot.player.ts`

| 行 | 改什么 |
|---|---|
| `:52-55`（`decide` 的 bidding 分支） | 🔴 **改成直接 `return { kind: 'pass', source: 'rule' }`** |
| `:139-146` | 🔴 **整块删除 `decideBid`**（**不是**「改成恒返回」） |
| `:12-13` | **删除** `BID_GRAB_THRESHOLD` |
| `:189-194` | **删除** `errorRateOf` |
| `:196-214` | **删除** `handStrength` |
| `:144` | 失误翻转**随之消失** |
| `:4` | `DOUZERO_2` import **随之删除**（⚠️ 在 **:4**，v2 误引为 `:5-8`） |

⚠️ **为什么必须「整块删除」而不是「改成恒返回」**（审查② 抓出的 v2 处方错误）：
`tsconfig.base.json:7` 的 **`noUnusedParameters`** 开着 —— 把 `decideBid(req)` 改成恒返回后 `req` 不再被读
⇒ **TS6133：「req」已声明但从未读取** ⇒ `pnpm build`（`nest build`）**直接失败**。
⇒ 这正是 v2 自己拿来当理由的那条约束，却被 v2 的处方违反了。

⚠️ **不是「留着无害」**：`noUnusedLocals` + `noUnusedParameters` + `noEmitOnError`（已核 `tsconfig.base.json:5-9`）
⇒ 留着同样是 **`pnpm build` 直接失败**。

✅ 已核：`BID_GRAB_THRESHOLD`(:12-13)、`errorRateOf`(:189-194)、`handStrength`(:196-214) 都是**未导出的模块内符号** ⇒ 删除不波及外部引用；`random`(:34) 是 public 字段，不再用也不触发未使用告警。

### 5.6 `packages/game-service/`

| 位置 | 结论 |
|---|---|
| `game.service.ts:446`（按 `state` 选计时器） | **不用改**（已核） |
| `game.service.ts:517`（按 `bidPhase.currentBidder` 派发机器人） | **不用改**（已核） |
| `game.service.ts:651-653, 668`（`onTurnTimeout`） | ✅ **已核，不用改**：bidding 时它就是 `handleBid(session, playerId, false)`，取人走 `bidPhase.currentBidder` ⇒ 反抢帧超时 = 不抢，自然正确。⚠️ 但正确性**押在 §4.2 的收口判据上**（判据不终止 ⇒ 超时也跟着空转） |
| `game.service.ts:676-677` | 失败时**不落盘、不改 version、重挂计时器** ⇒ §7.1 的「老会话 `currentBidder = undefined`」会表现为**每 30s 空转一次**，房间永久停摆 ✓ 与审查一致 |
| `game.service.ts:138-147`（`loadSession`） | 老会话兼容 ⇒ §7.1（**含一次性迁移**） |
| 🔴 **随机源进 `GameService`**（审查② 指出 v2 的 §5.2/§5.6 冲突 ⇒ §6.2 无法执行） | **本版定死**：给 `GameService` 加一个**可注入的公开字段** `random: () => number = Math.random`（照 `BotPlayer.random` 的既有范式），传给 `createSession` / `handleBid`。测试 `service.random = () => 0` 即可。**不采用** `vi.spyOn(Math,'random')`（全局打桩会污染并发用例） |
| 🔴🔴 **`game.service.ts` 的 `applyDecisionToSession`（自由函数）**（审查③ 抓出 —— **本片最阴的洞**） | 它是个**模块级自由函数**（**没有 `this`**），而里面调 `handleBid(session, playerId, …)` —— 也就是说**机器人驱动链的 `handleBid` 在这里**。⇒ 必须给它加 `random` 形参，并在调用方 `commitRobotDecision` 传 `this.random`。<br>⚠️ **v4 原文（已被实施回填订正）**：「漏了不会编译失败：§5.2 的签名有默认值 `= Math.random` ⇒ **静默退化** ⇒ 含机器人的房（`game.robot.test.ts` / `full-game.test.ts` 的 INTEG1/INTEG2）**仍然不确定**，§6.2 的夹具迁移会以「看起来好了」的形态留下 flaky」。<br>🔴 **实施回填（2026-09-30，计划自检点名「实施后请回填进规格」）**：实施定案 = `applyDecisionToSession(session, playerId, decision, random)` —— **4 个形参、`random` 无默认值** ⇒ 漏传是 **TS2554 编译错**（**结构性防线**）；「静默退化」只对 `createSession`/`handleBid` 各自的默认值成立（那两处必须有默认值，否则全仓每个测试调用点都要改）。依据：`game.service.ts` 该函数签名 + 其 docstring 逐字「`random` 不给默认值 —— 这是**结构性防线**」；`commitRobotDecision` 传 `this.random`。<br>**全仓 `createSession`/`handleBid` 调用点只有这 4 处**（⚠️ 原按行号 `:175/:281/:668/:731` 引 —— **均已漂**，现按**名字**描述）：`createSession`（`startGame`，类方法 ✓）· `handleBid`（`bid()` 闭包，类方法 ✓）· `handleBid`（`onTurnTimeout`，类方法 ✓）· **`handleBid`（`applyDecisionToSession`，自由函数 ✗ 需加形参）** |
| `game.service.ts:531-586`（机器人驱动链） | 🔵 **本版决定：保留**（叫抢期照常走 `robot.decide` RPC，机器人恒返回 pass）。理由：§9.4 是既有裁决，**短路是一种偏离**；且保留能继续覆盖「叫抢期 RPC 链路」这条缝（既有判据在跑）。短路省的那一次往返不值一条新偏离 |

### 5.7 `tools/conformance/src/`

| 位置 | 处置 |
|---|---|
| `lib/ddz-driver.ts:487-523`、`slices/slice-08-bidding.ts:196-235` | `grabs=[true,false,false]` ⇒ **保留**（1 声称，反抢不触发，恰好不会红） |
| 同上 | 但**必须新增**「2 声称 ⇒ 第 4 拍」场景 ⇒ §8 |
| `slices/slice-11-robot-system.ts:450, 475` | 「12 次决策内进 playing」上界 ⇒ **不改**（见 §8 的算式） |
| 🔴 `slices/slice-11-robot-system.ts:63`、`:403-404` | **R1 会让它失效**（审查② 指出 v2 漏了）：这两处**逐字依赖**「人类坐 seat 0 且 `currentBidder` 初值 0」⇒ R1 后 `:403` 的 `if` 变 **1/3 概率成立**，第 1 组判据的前提（人类在自己的**首个**回合决策一次）**不再必然建立** ⇒ 需改为「等 `currentBidder === humanSeat`」的轮询 |

### 5.8 `tools/mock-server/`

- **契约面无需改**：mock 的 `decisions` 恒为 1 条、客户端在 mock 里恒为座位 0（`scripted-game.ts:234-237` / `index.ts:167`）
- 若 §9 的量具需要「非首位行动者 / 反抢」形态 ⇒ 要改的是 `tools/mock-server/src/index.ts:206-210`
- ⚠️ **既有缺陷（另记，不在本片）**：`index.ts:206-210` 缺 `game.play`/`game.pass` 同款的 `NOT_YOUR_TURN` 检查

### 5.9 `apps/client/`

- 协议形状不变 ⇒ 按钮 / 回显 / 音效 **无需改**（`bidKindOf` 对反抢帧给 `'rob'` ⇒ 文案自动是「抢地主/不抢」，**不新增 `kind`**）
- 4 条决策的客户端表现**可接受**：`bidEchoOf` 取「该座位最后一条」⇒ 语义正确；音效会为第 4 条再播一次同座位音
- §9 的布局论证文字要改

### 5.10 文档（**规则的唯一来源与真源**）

| 文件:行 | 改什么 |
|---|---|
| `docs/games/doudizhu.md:86` | 「一律由座位 0 起」⇒ **R1 直接推翻** |
| `docs/games/doudizhu.md:104-105` | 「一轮最多 3 次抢 ⇒ 上限 8」+ 它自带的「若改为允许反抢，上限需重新定义」⇒ 按 §4.3 更新（**结论：上限仍 8**） |
| `docs/games/doudizhu.md:111-130` | §3.2 伪码（自 **:111** 起）+ 「轮次结束的**唯一**判据是 `grabActions >= 3`」+ 「四种情形，无遗漏分支」（在 **:130**）⇒ **必改**（现在是四类情形、两个判据）<br>⚠️ v2 引的 `:113-127` 范围**少 3 行、起点早 2 行**，审查② 已核 |
| `docs/design.md:288, 290, 508, 511` | 四处「一轮制 ⇒ 最多 3 条」「`grabActions`（0..3）」 |
| `docs/design.md:1866` | C24 偏差条目 |
| `docs/superpowers/plans/deviation-ledger.md:182, 310` | C24 已关闭的记录 ⇒ 需**重新开启/改判** |
| ~~`docs/client-protocol.md:184-187`~~ | 🔵 **幽灵改动项，删掉**（审查② 指出 v2 列了它）：已核 `client-protocol.md:185` 只写 `grabActions: number;` **不写值域**，全文对「一轮制/最多 3/0..3/上界」**grep 0 命中** ⇒ **无需改** |

🔴 **必须显式宣布作废的两条**（否则下一个读台账的人会把随机座位当 bug「修」回去）：
- **R104**（`resetBidding` 无条件置 0）
- **C24**（双重推进偏差的修正记录）

---

## 6. 测试与夹具迁移

### 6.1 必红（语义变了，要改断言）—— 审查② 订正后的名单

| 用例 | 为什么必红 |
|---|---|
| `game-service/test/full-game.test.ts:61-81` | 夹具是「2 人称抢」⇒ 第 3 次决策后触发反抢 ⇒ `bid3` 停在 `bidding`。<br>⚠️ v2 把形态标成 T,T,F —— **实为 T,F,T**（`:61` true · `:66` false · `:69` true = 真值表 #6）；结论不变 |
| `shared/src/ddz/bid.test.ts:188-198` | T,T,T ⇒ 第 3 拍触发反抢 ⇒ `state` 不再 `Playing`、`players[2].isLandlord` 假 ⇒ **确定性红**（其注释「一轮制下三个抢 ⇒ 座位 2 是地主」同时作废）。**v2 漏列** |
| `game-service/test/game.service.test.ts:172-174` | T,F,T ⇒ 反抢 ⇒ `expect(session.state).toBe(GameState.Playing)` **确定性红**。**v2 漏列**（v2 只按 R1-flaky 列，而 `() => 0` 修不好它） |
| `protocol/src/messages.test.ts:199-202` | 钉着 `/at most 3 items/` |
| `robot-service/test/robot.decide.test.ts:179-193` | **正向断言**机器人会抢（`kind === 'play'`）⇒ 改反号 |
| `shared/src/ddz/features.test.ts:45`、`shared/src/ddz/types.test.ts:49` | 🔴 **编译错**（审查② 指出 v2 漏列）：两字段变**必填**后，这两处**手写 `bidPhase` 字面量**缺字段 ⇒ `tsc` 失败 |
| 🔴 `game-service/test/view.builder.test.ts:32-33, 52-61` | 🔴 **编译错**（审查③ 抓出，v3 漏列且**误分类**）：`:33` 有**显式类型标注** `const base: GameSession = {…}`，`:52-61` 是不带 spread 的**手写全量 8 字段** ⇒ 缺两字段是 **TS2739**。<br>⚠️ **它在 `pnpm build` 里抓不到**（包的 `tsconfig.json` 只 include `src/**`），但 `package.json:9` 的 `lint` 走 `tsconfig.test.json`（include 含 `test/**`）⇒ **CI 阶段 2/6 `turbo run lint` 的红** —— 很容易被误判成「不是我的改动引起的」 |
| ~~`robot-service/test/bot.player.test.ts:52`~~ | 🔵 **v2 误列，删掉**：`:52` 是 `grabActions: 3`，该文件**无任何叫抢行为断言**、视图键集也不变 ⇒ **不会红** |

### 6.2 🔴 夹具迁移（**R1 会让它们从「恒过」变「1/3 概率过」= flaky，比红更糟**）

`bid.test.ts` 全篇 · `game.timer.test.ts:62-76/96-99/218/314` · `game.service.test.ts:98/109/117/156/172-174` · `game.controller.test.ts:281-295` · `game.robot.test.ts:90-93/169-194` · **`full-game.test.ts:61-81` 与 `:84-88`**（INTEG3 也用 `user-1` 抢 ⇒ **文件级统一注入**才兜得住）

**迁移方式**（依赖 §5.6 定死的注入点）：夹具设 `service.random = () => 0`（座位 0 先动），用例本身大多不动。
⚠️ `game.timer.test.ts:95-103` 的 `startPlayingGame`（审查③ 订正 v3 误引的 `:89-101`；两次 `bid` 在 `:97-99`）是 T,F,F ⇒ **语义安全**（真值表 #2），只需 R1 注入。

🔵 **从名单里删掉的（审查③ 指出 v3 误分类 + 处方不适用）**：
`game-service/test/view.builder.test.ts:52-54` —— 它**不是 R1 项，是编译错项**（已移入 §6.1）。
理由：该文件只 import `handlePlayCards` + `view.builder` 的导出，**从不调用 `createSession`/`dealCards`/`service.bid`**，
`buildPlayerView` 是纯函数 ⇒ R1 **传不到它**，注 `random` 也修不好它。

🔵 **从名单里删掉的两处**（审查② 指出 v2 误列，会让人去找不存在的失败）：
`apps/client/test/helpers/bid-phase.ts:45-50`、`apps/client/test/helpers/fake-socket.ts:142-148`
—— 客户端受 `source-boundary.test.ts:22` 约束**不得 import `shared`**，视图全来自夹具/mock ⇒
R1 与反抢**传不到它们**（只有 `PlayerView.bidPhase` 加键才红，而 §5.4 明令不加）。

⚠️ 特例：`game.robot.test.ts:190` 的 `order.slice(0,3) === ['bot-0','bot-1','bot-2']` —— 字面没有「座位 0」，却**同时**钉住「首个决策者是座位 0」「按座位递增」「恰好 3 条决策」三件事 ⇒ 应改成**不依赖顺序**的断言。

### 6.3 新增判据（片① 的交付物）

1. **起始座位**：`random = () => 0.9` ⇒ 始点 = 座位 2；`() => 0` ⇒ 座位 0
2. **反抢**：§3 的 8 组合**逐条**
3. **反抢不终止检查**：反抢者「不抢」⇒ 本轮**必须**结束（这条直接抓 §4.2 的 Bug 1）
4. **决策数上界 4** + 出站闸正/负例
5. **全不叫**：三轮全不叫 ⇒ 第 3 次随机指定地主，且 `players.filter(isLandlord).length === 1`
6. **老会话迁移**：§7.1 —— 三条判据：
   - 老会话（无 `firstCaller`、**有** `decisions`）载入后，`firstCaller` 必须等于 `decisions` 里第一条 `grab=true` 的座位
   - 已走满 3 拍的房 `antiRobGranted` 必须为 `true`
   - 🔴 **负例（审查③ 补）：`decisions` 整个缺失 + 中途房（`grabActions ∈ {1,2}`）⇒ 载入后 `firstCaller` 必须等于 `landlordCandidate`（**不得**是 `-1`），且**任何情况下载入后 `currentBidder` 都不可能是 `-1`** —— 这一条抓的是「迁移在最老形态上精确复现停摆」那个洞
7. **视图键集穷尽**：§5.4
8. **conformance**：§8

---

## 7. 两个兼容面

### 7.1 🔴 Redis 老会话（**会让房间永久停摆**）

**现状**：`game.service.ts:139-142` 的 `loadSession` **直接 `JSON.parse`**（键 `game:session:{roomCode}`，TTL `SESSION_TTL_SECONDS = 3600`，`:50`）。
旧会话没有 `firstCaller` / `antiRobGranted` ⇒ `undefined`。

🔴 **v2 的「代码兜底 `?? -1`」是错的 —— 它把「怕误触发」变成「必然误触发」**（审查②）：

```
firstCaller = -1（兜底出来的）
⇒ landlordCandidate >= 0 时（任何中途有人叫过、被部署打断的房）
⇒ 0 !== -1 恒真 ⇒ hasAntiRob 恒真 ⇒ ① 触发反抢
⇒ currentBidder = firstCaller = -1
⇒ 每次 game.bid 抛 Not your turn；onTurnTimeout（:651-663）取 players[-1] 得 undefined
⇒ 记 error + 重挂计时器 ⇒ 每 30s 空转一次、房间永久停摆
```

⇒ 正是 §7.1 原本想消灭的两个坏结局，**兜底把它们变成了必然**。

🔴 **处置一：`loadSession` 做一次性迁移**（不是兜底）

```ts
// 迁移：老会话補上新字段。⚠️ 这是 §2 禁止读 decisions 的【唯一例外】——
// 老数据里 decisions 是 firstCaller 的唯一真源。
// ⚠️ session.bidPhase?. —— 缺 bidPhase 的会话会让 loadSession 抛 TypeError
//    （现有 try/catch 只包 JSON.parse，而 view.builder 全程用 bidPhase?. 兜底）。
if (session.bidPhase && session.bidPhase.firstCaller === undefined) {
  const bp = session.bidPhase;
  const firstGrab = (bp.decisions ?? []).find((d) => d.grab);
  // 🔴 审查③ 加固：decisions 整个缺失时（协议⑦ 之前写出的会话）不能用 -1 ——
  //    否则 grabActions∈{1,2} 的中途房仍会「必然误触发反抢」（currentBidder = -1 ⇒ 永久停摆）。
  //    退化到 landlordCandidate 是安全的：它 >= 0 时「不派发反抢」= 旧行为，正是兼容所需。
  bp.firstCaller = firstGrab?.seat ?? (bp.landlordCandidate >= 0 ? bp.landlordCandidate : -1);
  bp.antiRobGranted = bp.grabActions >= 3;
}
```

🔴 **加固的理由**（审查③ 抓出，v3 的迁移**在一种老会话上精确复现了它要消灭的停摆**）：
`decisions` **整个缺失**时（协议⑦ 之前写出的会话 —— 本仓有「常驻容器是旧镜像」的前科），
`(decisions ?? [])` 给出 `firstCaller = -1`，而中途房 `grabActions ∈ {1,2}` ⇒ `antiRobGranted = false`
⇒ 第 3 次决策时 `landlordCandidate(>=0) !== firstCaller(-1)` **恒真** ⇒ 派发反抢 ⇒ `currentBidder = -1`
⇒ **每 30s 空转、房间永久停摆**。
⇒ 退化到 `landlordCandidate` 后：`firstCaller === landlordCandidate` ⇒ `hasAntiRob` 为**假** ⇒ **不派发反抢** = 旧行为 ✓。

**副作用核查（审查③ 已验，结论安全）**：`loadSession`（`:138-147`）全仓只有 `getSession`（`:156`）一个调用者，
且只在**缓存未命中**时调用 ⇒ 迁移每进程每房至多跑一次，且**幂等**；
它改的是 `JSON.parse` 出来的**新对象**（无别名问题）；**不改 `version`**（改了会破坏在途客户端的 CAS）；
不落盘也**不是**问题 —— 本仓本来就把缓存对象就地改（`finishTransition` `:371-373` 直接改 `session.winner/state/finishedAt` 再 `saveSession`）
⇒ 下一次状态转移自然把两个新字段写回 Redis。

🔴 **「清键 or 迁移」二选一 —— 本版选：两条都做，但清键是主路径**（v3 留了「二选一」没定死，审查③ 指出这会把处置一的通用性架空）：
- **主路径**：发布步骤执行清键命令（下）⇒ 老会话归零，迁移是纯兜底
- **兜底**：上面这段迁移仍然保留（防漏清的房 + 未来任何形态的老数据）

🔴 **处置二：发布步骤写死清键命令**（⚠️ v2 写的「本仓有房间回收机制」**不成立**）

审查② 已核 `packages/room-service/src/rooms/rooms.reaper.ts:23-24` 逐字写着
「**`playing` 的房间即使 `timeoutAt` 已过也不得回收**」—— 而部署时要清的**正是**在途的 `playing` 房。
⇒ 该步骤**无机制可依**，必须写死命令：

```bash
# 部署前（在目标机上）：清掉在途对局会话。⚠️ 这会中断正在进行的对局。
# ⚠️ 前置（审查③ 点名的三处，缺一不可）：
#   ① 必须在 compose 工程目录下跑（片段里没有 cd）
#   ② redis 服务必须在跑（compose 服务名就是 `redis`）
#   ③ `xargs -r` 是 **GNU 扩展** —— BSD/macOS 的 xargs 会 `illegal option` ⇒ 目标机须为 Linux；
#      否则改用 `| while read -r k; do docker compose exec -T redis redis-cli del "$k"; done`
docker compose exec -T redis redis-cli --scan --pattern 'game:session:*' \
  | xargs -r docker compose exec -T redis redis-cli del
```

（审查③ 如实声明：这条管道**未实跑**（只读要求，未起容器）；键名 `game:session:{roomCode}`（`game.service.ts:130`）、
compose 服务名 `redis`（`docker-compose.yml:53`）、仓库既有的 `docker compose exec -T redis redis-cli` 先例 —— 这三项已核；
`--scan` 管道给 `xargs` 是 redis 官方惯用法，但**结论属「推理成立、未执行」**。）

⇒ 或者**接受** TTL 自过期（3600s）内的少量在途房走上面的迁移兜底。
**本版决定：两条都做**（清键为主路径、迁移为兜底），见下。

### 7.2 旧客户端（**卡死，不是报错**）

`validateInbound` 失败 ⇒ 该快照**不被应用**（`apps/client/src/net/socket.ts:621-630`）⇒ 旧版本客户端在反抢局里**卡死在上一版视图**，连 `game.resync` 也一并被拒。

⇒ **发布顺序：客户端先行**（或明确接受窗口期）。**必须写进规格**。

### 7.3 🔴 服务端**混部**（审查③ 补 —— v3 完全没提，且症状与 §7.2 **同形**）

`packages/api-gateway/src/gateway/proxy.gateway.ts:372-376`：网关对**每一条** S→C 消息跑 `validateOutbound`，
失败时**只记 error 然后 `return`（不 emit）= 静默丢弃**。

⇒ 「**新 game-service + 旧 api-gateway**」的窗口期里，`decisions` 长出第 4 条的所有视图会被网关**丢掉**
⇒ 房间表现与 §7.2 的客户端卡死**一模一样**，但**只在服务端日志留痕**（`Blocked outbound …`），客户端侧毫无线索。

⇒ **规格必须写死**：**7 个镜像同版本上线；网关与 game-service 不得跨版本混跑。**
⚠️ 这不是假想风险 —— 本仓有「常驻容器是旧镜像」的前科（见 `bot.player.ts:37-40` 的一次性告警闸注释）。

---

## 8. conformance 补场景

**现状：新规则的唯一新增分支在线判据为零** —— `ddz-driver.ts` 与 `slice-08` 的场景都是「1 声称」，反抢**永不触发**。

**必须新增**（2 声称 ⇒ 第 4 拍）：
- 反抢者**抢** ⇒ 他为地主
- 反抢者**不抢** ⇒ 末位声称者为地主
- 反抢者不抢后**本轮必须结束**（抓 §4.2 的 Bug 1）

**slice-11 的 12 次决策上界不用改**，算式（写进规格作依据）：

```
4 次决策的轮次只在「有人声称」时出现 ⇒ 那一轮直接结束
流局轮恒 3 次（全不叫 ⇒ 无声称 ⇒ 无反抢）
最坏 = 两轮流局 (3+3) + 一轮 4 次 = 10  <  12   ✓
```

---

## 9. R6 订正：客户端布局论证作废（**不是「要不要加护栏」**）

- **护栏早就在**：`.table__clock { flex-shrink: 0 }` —— 位置是 `apps/client/src/pages/table/table.vue` **:953**（`:936` 是解释性注释，**`:944` 是注释的 `*/`**；审查② 指出 v2 引错）
- 🔵 **真实新可达态（审查② 订正 v2 的表述）**：反抢者的两次决策**不连续**（中间夹第 3 拍）。
  真正新可达的是「**同一轮内同一玩家决策两次 ⇒ 我的（中央）回显与我的钟同场**」。
  客户端确实会渲染该态（`table.vue:223-235` · `BidPanel.vue:**17**` 的 `disabled = busy || !store.isMyTurn` · `stores/game.ts:**154-156**` 的 `isMyTurn()`）
  ⇒ 结论不变：量具当时量的「真实可达态」**不含中央回显**（读数：中央内容 325.0 / 可用 324.7，余量已被动作区吃满），
  而新可达态**多了一行回显** = 当时被当作「注入态」量的那棵更高的树
- ⇒ 本片要做的是：**重新量纵向预算**（真浏览器量具，新可达态），再据此决定「调中段高度」还是「给中央加裁切/滚动」
- ✅ **已量 · 已决（2026-09-30 · Task 9 · 两次独立运行逐位复现）**（量具：`.tmp_shots/table-fix/measure-bid2.mjs`）：
  `centerOverflowPx`（`.table__center` 底 − `.table__mid` 底）= **0**（不溢出）· `clockSize` = **88×92**（护栏有效）·
  `midH` = 324.7 · `echoPresent` = true（注入自检先过）。**内容**读数：363.0 / 可用 309.0 ⇒ 回显行（48+6=54px）
  令内容在盒外**对称外溢 ±19.1px**（总量 38.2px）。⚠️ `centerOverflowPx` **看不见这一半** —— 修复轮② 报告 §五-5
  已声明该盲区，故两套读数都记。
  ⇒ **决定：不加任何新样式**（分支条件「若 `centerOverflowPx <= 0` ⇒ 不加护栏」**不在本节** —— 指路**订正**：
  原写「走上文」，但 §9 里没有那句话；其实际出处 = 片① 计划 `docs/superpowers/plans/2026-09-30-bidding-rules.md:1017`。
  ⚠️ 且该闸是**盒口径、结构上恒 0**、**不作裁决依据**（口径 = **内容**，见下「编排者裁决」条））：①「给中央加裁切」会切**可见文字**
  （内容居中 ⇒ 切场景名顶部；改锚顶 ⇒ 改切钟底/占位）；②「调中段高度」需 **+54px** 而合法来源为零
  （手牌区 = 红线禁；常驻会话提示那一行 ~48px 属**另一处**已知缺陷，不在本片范围）。视觉实况（截图取证）：
  顶部 = 场景名**块顶**（`.table__scene` 顶 111.7）与常驻会话提示条下缘（126.8）交叠 **15.1px**
  （字形**墨迹**自 y≈116 起 ⇒ 可见叠压 ~11px；两者可读）；底部 = 「（无）」占位下缘由 `.table__me`
  不透明底盖住 —— **实测占位墨迹被切掉约一半（12/25 行可见）**。⚠️ **订正**：原括注「仅 4px 间隙露细条」
  把两个量混为一谈 —— 那个 4px 是 `.table__mid` 底（455.6）→ `.table__me` 顶（459.6）的**间隙**，
  与「占位被切量」不是同一回事（同义句见 `table.vue:956-957`，不带此括注）。同类先例：两提示行的 ±26px 外溢已按「已知预算债 · 不阻塞 · 交人眼走查」
  处置 ⇒ 本次同类且更小、仅存在于反抢帧（短暂）。原始读数：`.tmp_shots/table-fix/bid2-measure-bid2.json` 与
  `bid2-run2-measure-bid2.json`（`.tmp_shots/` 为 gitignored，量具不进提交）。
- 🔴 **编排者裁决（2026-09-30 · 独立复核后写回控制平面；口径以此为准）**：
  1. **不加护栏、不调中段**。**口径取「内容」，不是盒子** —— 盒口径的闸**结构上是死闸**：
     `.table__mid { align-items: stretch }`（`table.vue:838-846`）+ `.table__center` 无 `align-self`（`table.vue:922-931`）
     ⇒ 两者底边恒等 ⇒ `centerOverflowPx` **不可能 >0** ⇒ **不作为裁决依据**。
  2. 记为「**已知预算债（可达但罕见且短暂 · 不遮任何文字）**」，**不阻塞**：
     - 可达 = 生产上真会发生（`packages/room-service/src/match/match.service.ts:370` ≥3 人**直接成局**、
       `:427-429` `humans = alive.slice(0,3)` 再补机器人 ⇒ **2 真人 + 1 机器人**的匹配房可为反抢局；
       需同桶 ≥2 名真人声称、时长 ≤30s ⇒ **罕见**）；短暂 = 仅存在于反抢帧。
     - 不遮任何文字（复核判定）：提示条自己的字在别处；场景名列靠 2px 描边仍可读；底部被切的是低对比度的**占位墨迹**约一半。
  3. 两条替代方案都更差：**加裁切**会切掉正在骑缝的那 **~11px 场景名字形**（**字形墨迹**口径；块顶交叠为 **15.1px**，见上「视觉实况」）；**调中段**需 **+54px** 而无合法来源
     （手牌区是红线；常驻提示条属**另一处**缺陷）。
  4. **第三条路（登记备查 —— 免得后人以为这条路不存在）**：中央**自身**的间距是合法来源 ——
     `gap: 6px`×4 + `padding: 8px`×2 = **40px 纯间距**（R2 实测树 `kids` = 5 个子节点 ⇒ gap **4** 条；
     自洽：`76+6+48+6+88+6+92+6+35 = 363 = contentH`），如 `gap→4` / `padding→4` 可回收约 **16px**；
     **但不足以单独解决**（需要 54px），且属**设计改动** ⇒ 将来若要真解决，这是**唯一不碰红线**的方向。
     ⚠️ **改准溯源（2026-09-30 · Task 10）**：本行正文**曾**把 `gap×5 = 46px` / 可回收 `18px` 当正面事实写
     —— 那组数**是错的**（多算一条 gap），纠正原先只埋在注里。以 `40px` / `~16px` 为准，
     **结论不变**（两种口径都 ≪ 54px）。
- 「不可达」论证文字有**五处副本**，一并作废：
  1. `table.vue:940-941`
  2. 🔴 `table.vue:228-229`（审查③ 订正 v3 误引的 `:224-229`：注释块起点是 `:228`，`:224-227` 是 `bidEchoOf`/`bidWord` 的代码）
  3. `apps/client/test/table-center.test.ts:255-256`
  4. `docs/superpowers/plans/2026-09-29-table-rework-handoff.md:135-139`
  5. 🔴 `docs/superpowers/plans/2026-09-29-table-rework-handoff.md:140`（审查③ 补：这一行写着「钟只在 `decisions` 为空那一拍出现」——
     反抢规则下**不再成立**，人类可能在同一轮内决策两次；v3 引的 `:135-139` 正好差这一行）
  ⇒ 五处已按「**标注作废、不删除**」落地（2026-09-30 · Task 9）：原句保面、⚠️ 说明失效原因（同一轮同一玩家可决策两次）与读数出处。
  ➕ **grep 补漏两处**（上表没列到、同源同句的「第 3 条决策当场结束叫抢」）：
  `apps/client/test/table-bid-stage.test.ts:16`（活文件 · 测试头 ⑤ 的取舍说明）·
  `docs/superpowers/plans/2026-09-28-table-rework.md:2635`（片③ 计划的 `showBidEcho` 代码块）——
  两处一并标注作废（判据本身不依赖该前提，不变）。

---

## 10. 明知的取舍（写进规格，不留给后人猜）

1. **`grabActions` 名实不符**：它数的是**决策次数**（反抢后可为 4），却叫 grabActions。⇒ **不改名**（改名要动出站视图字段与客户端），但规格逐字声明其真语义。
2. **`landlordCaller` 是纯死重量**：全仓**只写不读**、**不进视图**。
   ⚠️ **v2 写的「恒等于 `landlordCandidate`」有反例**（审查②）：第 3 次流局**随机指定地主**时，
   `finalizeBidding` 覆盖 `landlordCandidate`（`bid.ts:76-79` + `:112-117`），而 `landlordCaller` 的**唯一写入点**是 grab 分支（`:52`）
   ⇒ 该路径下 `landlordCaller = -1 ≠ candidate`。
   ⇒ 本片不动它，规格逐字声明「**勿使用**」，避免与 `firstCaller` 撞名误导。
3. 🔴 **R3 让难度体系在叫抢上名存实亡**。
   ⚠️ **v2 的表述错了**（审查②）：`bot.player.ts:144` 调的是**同文件硬编码的** `errorRateOf(skillLevel)`（`:190-194`），
   **不读** `RobotPersonality.errorRate`。那个字段的生产者是 `robot.pool.ts:438`，删除后**消费者只剩测试**
   （`robot.pool.test.ts:67/388/395`、`protocol/src/robot.test.ts:58`）。
   ✅ 结论仍成立：删掉 `decideBid` 后，beginner / intermediate / advanced 在**任何决策**上都同构
   （都走确定性规则引擎、都恒 pass），**只剩 `thinkingSpeed` 的人为延迟差**。
   ⇒ 这是**片② 要重建难度体系的直接原因**（片② 的「按档换模型」正是补这个）。
   ⇒ 片① 规格必须写明「**难度体系在片② 重建**」，否则片① 会被读成「难度被删掉了」。
   ⇒ **本片要同时决定**：`ERROR_RATE` 常量（`robot.pool.ts:47-52`）、`RobotPersonality.errorRate` 契约字段、
   以及上面那几条测试，**本片是否在场**（建议：常量与字段**留到片②**一起处置，本片只登记）。
4. **单人房反抢恒不触发**：机器人恒 pass ⇒ 人类是唯一可能的声称者 ⇒ 单人房永不出现反抢；人类若也不叫 ⇒ **必然**走满 3 次流局到随机地主。⇒ 反抢**只在 ≥2 名人类都声称时**出现（好友房）。

---

## 11. 明确不做（YAGNI）

- 不改 `BID_MULTIPLIER_CAP` 的**数值**（反抢后仍 **最多 4 次声称**；反抢那一抢**同样 ×2**、只是**任何路径都不越过 8** ⇒ 上限 8 仍成立 —— 见 §4.3。⚠️ 2026-09-30 修复轮订正：本行原写「第 4 次因 cap 不再加分」，机制表述有误、结论不变）
- 不做「多轮抢」（只做**一次**反抢）
- 不给叫抢接 AI 模型（§1-4）
- 不在本片做难度体系重建（属片②）
- 不修 mock 的 `NOT_YOUR_TURN` 缺失（既有缺陷，另记）

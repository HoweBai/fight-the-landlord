# 牌桌重做 · 设计规格（阶段 A 纯后端 / 阶段 B 界面）

> **日期**：2026-09-28 · **状态**：待用户复核
> **上位依据**：`docs/superpowers/specs/2026-09-26-app-ui-rework-design.md` ——
> **§3.3**（片③ 分解，两阶段）· **§4.3 / §4.4 / §4.6**（协议③④⑥）· **§5.2.1**（视觉语言定稿，本片照抄）·
> **§6.4**（牌桌形态表）· **§7.1**（判据记账）· **§5.4**（底纹悬案）
> **上游交接**：`docs/superpowers/plans/2026-09-27-app-ui-rework-handoff.md` **§8**
> **参考图**（gitignored，只读）：`.tmp_ref/app-ui-rework/03-table-before-bid.png` · `04-table-play.png` ·
> `05-bid-prompt.jpg` · `06-bid-result.jpg`
> ⚠️ **本文件只补上位规格没定的、以及订正它与本片冲突的** —— 不重复它，避免第二真源。
> ⚠️ **本仓最大的缺陷来源是控制者自己的文本**（交接 §5 记着 34 处）。本文件里**每一处「现状」都实测过**
> （行号、条数、清单长度），凡是没实测的一律写成「计划里核」，不留悬空断言。

---

## 0. 一句话

把牌桌按参考图 3/4/5/6 重做：**顶栏瘦身 · 动作区进中央 · 叫抢有阶段感 · 桌面留最近两手 · 底分与场次名上桌**。
分两段做、**验收也分两次**：阶段 A 只动协议与服务端（**做出来什么都看不见**），阶段 B 才动界面。

---

## 1. 范围与两阶段

| 阶段 | 交付 | 做到什么程度 | 验收 |
|---|---|---|---|
| **A（纯后端）** | 协议 **③④⑥⑦** + `RobotFeatures` 连带面 + `view.builder` + 出站校验器 + mock 对局 + 文档 | **零界面改动**；前端一行不碰 | 机械（`ci`）+ **conformance 09/10/11 重写** + 真栈 |
| **B（界面）** | 牌桌重做（顶栏 / 中央 / 出牌区 / 叫抢 / 结算）· 二级弹层 · 素材槽 · art brief 重校准 · 每页底纹机制 | 照 §5.2.1 的语言 | 机械 + **真浏览器探针** + 真机 + **人眼并排** |

⚠️ **A 不独立成片**（上位 §3.3 逐字）：它做出来看不见，所以与 B 同一个片，但**必须能独立验收** ——
判据落在 conformance 上（那是本仓唯一能看见协议行为的层）。

⚠️ **两段的提交顺序不可换，但理由要说准**：B 里**依赖 A 的只有四处**（出牌区窗口 · 中央场次名/底分 ·
`kind` 文案 · 叫抢回显）—— 顶栏瘦身 / 二级弹层 / 结算换视觉 / 素材槽 / 底纹机制**都不依赖** A。
**A 仍必须先落地**，因为 B 会同时大改 `table.vue`，而它现在读的正是 A 要退役的那两个字段。

---

## 2. 阶段 A：协议与服务端

### 2.1 协议记账订正表（🔴 **本表替换**上位 §4 那张表）

上位 §4 逐字写着「以下是**全部**破口」。实测后有**两处不一致**：总数从 6 变 **7**（本片新增 ⑦），
且漏了 ④ 的一条**连带面**。订正如下：

| # | 方向 | 改动 | 性质 |
|---|---|---|---|
| ③ | 出站 | `PlayerView.bidPhase.kind: 'call' \| 'rob'` | 加法 |
| **④** | 出站 | `PlayerView.lastPlayedHand` + `PlayerView.lastPlayerIdx` **退役** → `recentActions: { seat: number; cards: Card[] \| null }[]`（窗口 2、旧→新、**「不出」也占一手**） | 🔴 **破坏性** |
| **④′** | **协议包内的内部契约**（`protocol/src/robot.ts`；**不走 S→C、不过网关**） | `RobotFeatures.lastMoveMeta: { type: number; keyRank: number; length: number } \| null` | 加法（**上位漏记**） |
| ⑥ | 出站 | `PlayerView.baseScore: number` | 加法 |
| **⑦** | 出站 | `PlayerView.bidPhase.decisions: { seat: number; kind: 'call' \| 'rob'; grab: boolean }[]` | 加法（**用户 2026-09-28 裁决**） |

**④′ 为什么必须存在**（这是本次最容易漏的一条）：`recentActions` 的每项只有原始 `cards`，
而**跟牌判定需要 `{type, keyRank, length}`** —— `canBeat`（[play.ts:69-73](../../../packages/shared/src/ddz/play.ts#L69-L73)）、
超时自动跟牌（[play.ts:253-254](../../../packages/shared/src/ddz/play.ts#L253-L254)）、机器人 target
（[bot.player.ts:94](../../../packages/robot-service/src/robot/bot.player.ts#L94)、
[game.service.ts:621](../../../packages/game-service/src/game/game.service.ts#L621)）。
而本仓**明令禁止重新解析 `cards` 反推**（[play.ts:68](../../../packages/shared/src/ddz/play.ts#L68) / 玩法 §5 要点）。
⇒ 退役 `PlayerView.lastPlayedHand` 后**两个读点失去输入**：

| 读点 | 处置 |
|---|---|
| `game.service.ruleDecision(view)`（[:621](../../../packages/game-service/src/game/game.service.ts#L621)） | 改签名：跟牌目标从 `session.lastPlayedHand` 取 —— **调用方本就有 `session`**（[:565](../../../packages/game-service/src/game/game.service.ts#L565)/[:574](../../../packages/game-service/src/game/game.service.ts#L574)）⇒ **零协议影响** |
| `bot.player.ts:94`（robot-service，**按设计没有 session**，见 `no-session-boundary.gate`） | **只能在 `RobotFeatures` 上补一个字段** |

🔵 **④′ 顺手修好了一层错位**：机器人今天是从一个**显示字段**（`view.lastPlayedHand`）里偷**规则输入**的。
补 `lastMoveMeta` 之后，它的规则输入回到「由 session 投影出的公开信息」这条正路上
（`features.ts` 是 `actionLog` 的**唯一**投影实现，R205/C8）。
**这句话必须写进文档** —— 否则下一个人会把它当成回归来「修」。

### 2.2 协议 ③：`kind` 的派生（**一处派生、两处使用**）

```
kindOf(bidPhase) = bidPhase.landlordCandidate === -1 ? 'call' : 'rob'
```

| 用在 | 语义 |
|---|---|
| `bidPhase.kind`（当前行动者） | 决定**现在**该显示「叫地主/不叫」还是「抢地主/不抢」 |
| `decisions[i].kind`（写历史项时就地算） | 决定**那一次**的措辞（回显用） |

- 🔴 **不得用 `grabActions === 0` 派生**：那样「第一家不叫、第二家叫」会**错报成「抢」**。
  依据是**本轮是否已有人声称**（`landlordCandidate`），不是「第几个发言」。
- 流局重发后 `landlordCandidate` 归 `-1` ⇒ 下一轮从「叫」重新开始（[bid.ts:113-122](../../../packages/shared/src/ddz/bid.ts#L113-L122)）。
- ⚠️ 这是**本仓一轮制**下的语义映射（真实斗地主的「叫」= 第一个声称者）。措辞不得写成普适规则。

### 2.3 协议 ④：`recentActions` 的落地方式 —— **派生，不新增状态**

```
view.builder:  recentActions = session.actionLog.slice(-2)
                 .map(e => ({ seat: e.seat, cards: e.kind === 'pass' ? null : e.cards }))
```

**为什么派生**（我一度改成「写进 `GameSession`」，审掉了）：

1. `design.md` §4.2 的**例外说明逐字准许**「由 `actionLog` 派生的**公开信息**出站」，
   且 `features.ts` 已经在做同一件事（R205/C8 把它写成**唯一投影实现**）⇒ 「耦合最高敏字段」的担忧不成立。
2. 写进 `GameSession` = 新增**一处状态 + 三个清理点**（`createSession` / `finalizeBidding` / `resetBidding`），
   而它记的与 `actionLog` 是**同一段历史** ⇒ 正是本仓反复清掉的**第二真源**。
3. 派生让 `play.ts` 与 `GameSession` **一个字节不动** ⇒
   `play.test.ts`（49 处引用，且 [:127](../../../packages/shared/src/ddz/play.test.ts#L127)/[:403](../../../packages/shared/src/ddz/play.test.ts#L403)
   对**整个对象** `toEqual`）**完全不动**。
4. 派生天然兼容 Redis 里的老会话（老状态没有新字段，投影照样成立）—— 写进 session 要面对持久化形状迁移。

⚠️ **投影函数只能有一处实现**（放 `view.builder` 还是 `shared/ddz/`，计划里定）。mock 对局必须复用它或同形实现。

**两条不变式**（🔴 订正：我初稿写的「窗口内最多一条 `cards !== null`」是**假的** —— `A出3 → B出4` 两条都非 null）：

| # | 不变式 |
|---|---|
| ① | 窗口满 2 项且**两项都是 `null`** ⟺ 上一次动作是「**使一墩结束的那次过牌**」（此后 `lastPlayedHand=null`、`consecutivePasses` 归零） |
| ② | **「窗口里有非 `null`」⟺ `lastPlayedHand !== null`** |

🔴 **②的消费者是探针的 autoPlay 分支**（**订正 2026-09-28 评审**）：原文写「②是 `canPass` 的依赖项」
—— **失真**。实测 `canPass` 在整仓**没有任何消费点**（只剩下定义处），而真正依赖②的是
`browser-e2e.mjs:799-803` 的 **autoPlay 分支**（它据此决定「打一张」还是「过牌」），
而那个分支**只在 `--scenario full` 下执行**（`gate` 只求值、不分支）。
⇒ **②必须有判据钉住**（见 §2.7），**且阶段 A 收口前必须真跑一次 `full`**（见 §2.9）。

**用户逐字确认的语义**（`A出3 → [3]` · `B出4 → [3,4]` · `C不出 → [4, 不出]`）——**必须逐字变成用例**。

### 2.4 协议 ⑥：`baseScore`

- `GameSession.baseScore` **早就在**（[types.ts:55](../../../packages/shared/src/ddz/types.ts#L55)）⇒ `view.builder` 原样透传。
- ✅ **不需要兜底逻辑**：`game.service.ts:174` 是 `dto.baseScore > 0 ? dto.baseScore : DEFAULT_BASE_SCORE`，
  且 `createSession` 也给初值 ⇒ 该字段在会话里**恒为正数**。
- ⚠️ `types.ts:55` 的注释还写着「默认 100」，而 `DEFAULT_BASE_SCORE` 已是 **15** ⇒ 顺手订正。
- ⚠️ **订正（2026-09-28 执行期）**：原文写「`types.ts:62` 有『与 `PlayerView.lastPlayerIdx` 同名同义』这句」——
  **实测该句不在 `types.ts`**，它在 **`docs/design.md:487`**（「与 `GameSession.lastPlayerIdx` 同名同义」，
  是 §4.2 的 `PlayerView` 那段）。⇒ 退役后要改的是 **design.md 那句**（属 §2.8 的文档面）。

### 2.5 协议 ⑦：`bidPhase.decisions`

- 形状：`{ seat: number; kind: 'call' | 'rob'; grab: boolean }[]`，**按发生顺序**。
- **一轮制天然有界**（最多 3 条），不需要窗口。
  > 🔴 **2026-09-30 订正（片①）**：上界已改为 **4 条**（3 次声称 + 1 次反抢）—— 现行闸在
  > `protocol/src/validate.ts` 的 `decisions.length > 4`。**「天然有界、不需要窗口」的结论不变**，
  > 只是数字从 3 变 4。
- 清空点：`resetBidding`（流局重发 ⇒ 新的一轮）。
- `finalizeBidding` **不动它** —— 理由如实写：它**不含任何敏感信息**，而「**少一个清理点**」本身就是收益
  （清理点越多越容易漏）。⚠️ **不得**写成「回显要用」：§3.4 定的回显只在 `state === 'bidding'` 期间显示
  ⇒ 进入 `playing` 之后它是**无人读的数据**。
- 写入点：`bid.ts` 的 `handleBid`（**唯一**的叫抢状态转移点）。

### 2.6 出站校验器（`packages/protocol/src/validate.ts`）

🔴 初稿完全没写这一节，而它是**出站最后一道闸**（`view.builder.ts:108` 组装后立刻校验，失败**当场抛**）。
新字段的校验强度必须自己设计 —— 现有校验器有三处已知缺口：

| 现状 | 缺口 |
|---|---|
| `assertNum`（[:48](../../../packages/protocol/src/validate.ts#L48)） | 只保证**有限数**：`lastPlayerIdx` 允许 `-1`/`99`/`1.5` |
| `assertCardArray`（[:66-83](../../../packages/protocol/src/validate.ts#L66-L83)） | **不接受 `null`**，且**允许空数组**（「不出」无法表达） |
| 全篇 | **从不检查键存在性** ⇒ `cards` 缺失与 `cards: null` 窄化后都合法 |

**新字段的校验要求**：

- `recentActions`：是**数组**、长度 **≤ 2**（现有校验器**无数组长度上界先例**）
- 每项：是对象，且**必须显式判 `'seat' in item && 'cards' in item`**
- `seat`：**整数且在 0..2**（新写 `assertInt(v, path, min, max)`，或复用 `view.builder` 的 `assertSeat` 口径）
- `cards`：`=== null` **或** 非空 `Card[]`。🔴 **不得**把 `null` 塞进 `assertCardArray`
  （它被 `hand` / `bottomCards` 共用，会因 null 变红）
- `bidPhase.kind`：是两个枚举值之一（现有校验器对 `bidPhase` **只校验 `currentBidder` 与 `grabActions`**，
  见 [:132-134](../../../packages/protocol/src/validate.ts#L132-L134)）
- `bidPhase.decisions`：数组、长度 ≤ 3、每项 `{seat, kind, grab}` 形状合法
- `baseScore`：有限数且 **> 0**
- 顺手记录：`lastPlayedHand.type` **从来没有被校验过**（[:127-130](../../../packages/protocol/src/validate.ts#L127-L130) 只校验了 `cards`/`keyRank`/`length`）

✅ 已核实**不受影响**：`validateOutbound` 的签名分支自动覆盖；`FORBIDDEN_OUTBOUND_KEYS` 不动
（它拦的是 `actionLog`/`isRobot`/`botId`/`skillLevel`）；校验器**不拒绝未知键** ⇒ 退役字段不会因残留键报错。

### 2.7 阶段 A 的判据要点

- **窗口语义**：用户逐字确认的三行**逐字变成用例**（`A出3 → [3]` · `B出4 → [3,4]` · `C不出 → [4, 不出]`）
- **两条不变式**（§2.3）—— 尤其 ②（探针依赖它）
- **`kind` 派生**：正例（首条 = `call`）+ **反例（第一家不叫后第二家仍是 `call`）** + 流局后回到 `call`
- **`decisions`**：顺序 · 流局清空 · `kind` 与 `grab` 的四组合都能推出唯一措辞
- **`baseScore`** 透传
- **④′**：`lastMoveMeta` 与 `session.lastPlayedHand` 一致；机器人拿到的 target 与规则引擎一致
- **校验器**：六个新字段的**正/负对照**（每条都要有「不合规会被拒」的用例 —— 只测正例等于没测）

**单测影响面（实测计数，计划里逐个核）**：改字段形状会连带打红一批**编译期**夹具（`tsc` 会逐个指出来）：

| 文件 | 引用数 | 性质 |
|---|---|---|
| `apps/client/test/helpers/fake-socket.ts` | 1 处（夹具源头 `:137-138`） | 改这一处带动大半个客户端测试 |
| `packages/game-service/test/view.builder.test.ts` | 11 | 视图形状断言 |
| `packages/game-service/test/game.timer.test.ts` | 10 | 超时路径的会话夹具 |
| `packages/conformance/src/slices/slice-11-robot-system.ts` | ~9 | 归属判定与归属注释 |
| `packages/robot-service/test/robot.decide.test.ts` | 6 | RPC 载荷夹具 |
| `packages/game-service/test/game.robot.test.ts` | 6 | 机器人补位夹具 |
| `tools/mock-server/src/scripted-game.ts` | 10 | 🔴 用了 `PlayerView['lastPlayedHand']` **索引类型** ⇒ **编译即红**（属**阶段 A** 的面，不是界面） |
| `tools/conformance/src/lib/ddz-driver.ts` | ~6 | `checkSingleCaliber`（09/10 逐手调用） |
| `packages/game-service/test/game.module.wiring.test.ts` | 3 | 会话夹具 |
| `packages/protocol/src/{messages,rpc,robot}.test.ts` | 各 2 | 视图夹具（`lastPlayedHand: null, lastPlayerIdx: -1`） |
| `packages/robot-service/test/bot.player.test.ts` · `packages/room-service/test/ws.gateway.test.ts` | 各 2 | 夹具 |

⚠️ **`packages/shared/src/ddz/play.test.ts`（49 处）不在上表** —— 派生法让 `GameSession` 一字节不动，
它**完全不受影响**。这正是选派生法的收益之一（见 §2.3）。

### 2.8 文档面（🔴 初稿漏了整节）

契约改了就**必须**同步文档 —— 上位 §7.1 的记账纪律与片② 的教训（「`docs/design.md` 那句假话把我自己骗过一次」）都指着这条。

| 文件 | 改什么 |
|---|---|
| `docs/design.md` **§4.2**（`PlayerView` 定义，[:474-498](../../../docs/design.md#L474-L498)） | 🔴 删两字段、加 `recentActions` / `baseScore` / `bidPhase.kind` / `bidPhase.decisions` |
| `docs/design.md` **§6.4** 裁剪表（[:860](../../../docs/design.md#L860)） | 「上一手牌 `lastPlayedHand` ｜ 明文」→ 改成 `recentActions` 的口径（**只有已经打出的牌**，不含未出的手牌） |
| `docs/design.md` **§3.2**（`GameSession` 表，[:280-281](../../../docs/design.md#L280-L281)） | ✅ 两个**内部**字段不变，但要**加一句**：它们**不再出站**（出站的是派生的 `recentActions`）—— 否则下一个读的人会以为 `PlayerView` 还带着它们 |
| `docs/design.md` §4.2 例外说明（[:505](../../../docs/design.md#L505)） | 已有「由 `actionLog` 派生的公开信息可以出站」⇒ 把 `recentActions` 列为**第二个实例**（第一个是 `RobotFeatures`） |
| `docs/client-protocol.md` **§5**（[:180-181](../../../docs/client-protocol.md#L180-L181)） | 🔴 同上：视图形状 + 新增的三项 |
| `docs/games/doudizhu.md` | 🔵 **派生法让它改动很小**（这是选派生法的第二个收益）：§6.1-5 / §6.2 / §9.1 的**规则态一个字不动**。只加一节说明「桌面历史牌是**出站投影**，规则态仍是 `lastPlayedHand`/`lastPlayerIdx`」，并补 ⑦ `decisions` 的写入定义（§3.1 的计数器表旁） |
| `packages/shared/src/ddz/types.ts` | 注释订正：`baseScore` 的「默认 100」→ 15（[:55](../../../packages/shared/src/ddz/types.ts#L55)）；删掉「与 `PlayerView.lastPlayerIdx` 同名同义」这句**已失真**的话（[:62](../../../packages/shared/src/ddz/types.ts#L62)） |
| `packages/protocol/src/robot.ts` | `RobotFeatures` 加 `lastMoveMeta` + **写明它为什么存在**（④′：机器人的规则输入不该从一个显示字段里偷） |
| `docs/superpowers/specs/2026-09-21-ui-art-brief.md` | 七槽尺寸表**重新实测校准**（属阶段 B） |

### 2.9 阶段 A 的验收

| 层 | 判据 |
|---|---|
| 机械 | `pnpm run ci` 六阶段全绿 |
| **conformance** | **09 / 10 / 11 三条切片重写**（它们逐手读这两个字段的口径与归属） |
| 🔴 **真浏览器探针 `--scenario full`**（**订正 2026-09-28 评审**：原文只写了 conformance，漏了它） | 本片改的第三处探针代码（`:799-803` 的 autoPlay 分支）**只有 `full` 会执行**；`gate` 的 22/22 **不覆盖那一处** |
| 真栈 | 跑一遍 conformance；本机跑全套后必须 `docker compose up -d --force-recreate`（片② 的既有教训：全套会把栈改坏 ⇒ `fetch failed`） |

🔴 **基线纪律**（上位 §7.1 + 片② 惯例）：判据**只增不减** ⇒ 改写后 count **不得低于**现基线；
`baselines.json` 的回填**只能在首次 CI 绿跑之后**，且 `render`/`full` **两列**都要看。
⚠️ **若某条切片改写后确实覆盖不到原来的条数**：**必须补等价的新判据把 count 补回**，
**不得下调 floor**，并在提交信息里写明「为什么旧的判据不再成立、新补的那条守的是什么」。
（§2.1 的 ④′ 就是一个现成的补法：归属判定从 `lastPlayerIdx` 换成 `recentActions[].seat` 之后，
`RobotFeatures.lastMoveMeta` 这条新性质正好补上。）
⚠️ [slice-11:856-857](../../../tools/conformance/src/slices/slice-11-robot-system.ts#L856-L857) 的注释逐字写着
「`lastPlayerIdx` 是**唯一在线来源**」⇒ 那条注释与它的归属判定都要重写。

---

## 3. 阶段 B：界面

### 3.0 目标形态

```
┌ 顶栏 ─────────────────────────────────────────────────────────────┐
│ 返回大厅 · 阶段状态        底牌 ▧▧▧ · 倍数徽章              更多 ▸ │
└───────────────────────────────────────────────────────────────────┘
│  ┌左座位┐ ┌左出牌位┐    ┌── 中央 ───────────┐  ┌右出牌位┐ ┌右座位┐ │
│  │      │ │ 叫地主 │    │  欢乐经典新手场   │  │   8♠   │ │      │ │
│  │      │ │        │    │     底分 15       │  │        │ │ ⏰19 │ │
│  │      │ │        │    │ [抢地主] ⏰ [不抢]│  │        │ │      │ │
│  └──────┘ └────────┘    └───────────────────┘  └────────┘ └──────┘ │
│                        ┌ 我的出牌位 ┐                              │
│  ┌ 底栏：头像 昵称 — ····· 倍数 炸弹 房间 ····· 点数升序/降序 ┐    │
│  └ 手牌行（17~20 张，恒单行）──────────────────────────────┘      │
└────────────────────────────────────────────────────────────────────┘
```

**与今天的差别**：中央从「只有一个气泡的透明容器」变成**有内容的场地**；动作区从手牌上方的绝对定位浮层
**搬进中央**；顶栏瘦身。

### 3.1 顶栏（D16）

| 区 | 留什么 | 依据 |
|---|---|---|
| 左 | **返回大厅**（文案**逐字**） + 阶段状态 | `.table__bar .btn` 是**探针锚点**（按文本精确匹配）；R730 要求阶段状态留在 `.table__bar` 内 |
| 中 | 底牌位 + 倍数徽章 | R729 / R719 既有形态 |
| 右 | **「更多 ▸」**（打开二级弹层，**活按钮**） | 四个恒灰按钮的入口 |

- 四个恒灰按钮（记牌器 / 背包 / 托管 / 设置）**收进二级弹层**（D16），**仍是 `disabled` 占位**
  —— D16 只说「收进弹层」，**没说接功能**。功能落地时只翻 `disabled` 这一个属性。
- ✅ **已核实：`.table__art-btn` 与「记牌器/背包/托管」在判据、探针、`tools/` 里零引用**
  ⇒ 移进弹层不会让任何既有判据静默失配。（这是「改锚点前先 grep 依赖者」那条纪律的实例。）

### 3.2 中央（`.table__center`）

中央现在是**多用途区**，从上到下：**场次名 + 底分** → **叫抢回显（我的）** → **动作区** → **中央倒计时**。

| 件 | 定 |
|---|---|
| **场次名 + 底分** | `store.view.baseScore`（协议⑥）去**档位表**（计划 B 已在 store 里）查名字 ⇒ 显示「XX场 底分 N」。🔴 **查不到名字就只显示「底分 N」，绝不编名字**（既有纪律：查不到返回 `null`） |
| ⚠️ **缺字段必须容忍**（R661 同族） | 探针的 `seedFinishedGame`（[browser-e2e.mjs:558](../../../scripts/browser-e2e.mjs#L558)）往 store 里**直接注入**一个只有部分键的假视图（它**不过** `validateOutbound`）⇒ 该场景下 `view.baseScore`、`view.recentActions`（连 `playPhase`）**全是 `undefined`**。中央、出牌区、HUD 的读取一律 `?.` + 缺值**不崩**，缺值块**整块不显示** |
| 🔴 **查询入口必须进 store** | 「拿 `view.baseScore` 去档位表查名字」**不得在页面里就地 `find()`** —— 那会变成第二个查询实现。要**新增一个 store getter**（与既有 `selectedLevelName` 同族，但键是 `view.baseScore`） |
| **动作区** | `.table__actions` **搬进 `.table__center`**，去掉绝对定位（R735 退役）。⚠️ **四个按钮 class 与文案一个字不改**（它们是探针与 4 个测试文件的锚点） |
| **中央倒计时** | **只在叫抢期且轮到我**时出现（用户卡点③就是叫抢期）。复用页面**唯一**的 `useCountdown`（`seconds`），**不得**在组件里新造时钟（§9.6 / R675） |
| **叫抢回显（我的）** | 参考图 06 的中央大字位 |

⚠️ `.table__center` 必须**常驻**（既有判据：`v-if` 只加在里面的元素上，否则两侧座位会挤到中间）。

### 3.3 出牌区（窗口 2）

- `PlayArea` 改成渲染**一个 action**（`{seat, cards}`），宿主按 `seat` 决定落在哪个槽
  （左家 / 右家 / 我上方）⇒ **最多两处并存**（窗口 = 2）。
- **没有任何 action 时**，中央仍渲染一个「（无）」占位（`.table__play-area .table__muted` 的既有语义）。
- 🔴 **`cards: null` 的 action 渲染成「不出」**（该座位刚过了牌）—— 这就是被删掉的本地回声气泡的
  **替代物**，也是 §4 判据迁移的落点：从「ack 之后本地造」变成「**服务端给了才出现**」。
- 🔴 **「我出的那一手」必须留在 `.table__me` 之外**（它今天就是 `.table__me` 的**兄弟槽**）——
  放进去会让 `.table__me .card` 数到 **18**（17 手牌 + 1 张已出的牌），
  而 R660 与 `table-play-ui` 都断言它**恰好是手牌**（[table.vue:463-470](../../../apps/client/src/pages/table/table.vue#L463-L470) 的既有注释）。
- 🔴 **两个 `PlayArea` 实例会让后代选择器跨实例命中**：`action-feedback` 用的是
  `.table__play-area .table__played .card` / `.table__play-area .table__muted` 这类**文档级后代选择器**，
  两个实例下它们会数到**两处之和**（本仓对这件事有明文先例：table.vue:161-164 的注释）。
  ⇒ 那几条判据**必须按槽位限定**（或在宿主层收敛成「单一容器 + 内部渲染两项」）。
  **这一条在计划里要单独列成一个任务**，别混在样式改动里。
- 🔴 **删掉本地回声**：`bubble` prop、`bubble` ref、以及它的 `watch(() => store.currentVersion)`
  全部退役 —— 「谁刚过了牌」现在是**服务端的原话**（`cards: null`）。

### 3.4 叫抢

| 件 | 定 |
|---|---|
| **文案随 `kind`** | `BidPanel` 加 `kind` prop：「叫地主/不叫」↔「抢地主/不抢」。🔴 判据从「**字面固定**」改成「**只能从 `kind` 派生**」（上位 §4.3 明文要求） |
| **`.table__bid-multiplier`（「当前倍数 N」）** | **保留**（R657/R647 的既有锚点，且有「原样展示服务端数」的判据） |
| **回显** | 对手的贴**各自座位**旁；**我的贴中央**（参考图 06 的中央大字位）。只在 `state === 'bidding'` 期间显示 |
| **音效** | 改走**视图 diff**（`bidPhase.decisions` 到手后，像「王单张」那样）⇒ **删掉最后一处本地回声** |

🔴 **显式取舍**：**第 3 条决策的回显看不见** —— 它当场结束叫抢、状态翻到 `playing`。
那一拍由「**地主徽章 + 翻底牌**」接管。**不引本地计时器**去延长它（§9.6）。

### 3.5 结算

- `jujsidai.png` 红绶带做**标题带**（叠在面板顶部），沿用 `$ftl-panel-slice` 那套 9-slice 面板。
- 🔴 **`.settlement__*` 的 20 个 class 与逐字文案一个不改** —— 它们是 `table-settlement-ui` 的锚点。
  换的是**视觉**，不是结构。
- 🔴 **主按钮按 §5.2.1 换成金色 —— 且必须删掉贴图两行**。上位 §5.2.1 逐字：
  「`background: $ftl-color-gold` + 描边 `$ftl-color-gold-deep` + 白字；**不带贴图** ——
  原处的 `background-image: url($ftl-btn-plate-primary)` / `background-size` **必须一并删掉**
  （留着会盖住金色）」。
  - ⚠️ **本片之前它一直是旧的蓝 + 贴图**（实测三处）：[table.vue:933-935](../../../apps/client/src/pages/table/table.vue#L933-L935) ·
    [BidPanel.vue:102-104](../../../apps/client/src/components/BidPanel.vue#L102-L104) ·
    [Settlement.vue:369-371](../../../apps/client/src/components/Settlement.vue#L369-L371) ——
    而 `$ftl-btn-primary-bg` = `$ftl-color-primary`（**旧 Material 蓝**）。
    片② 已重做的 [game.vue:752](../../../apps/client/src/pages/game/game.vue#L752) /
    [login.vue:440](../../../apps/client/src/pages/login/login.vue#L440) 是对的形态（`$ftl-color-gold`、无贴图）
    ⇒ **牌桌的三个主按钮今天与其余三页不一致**，本片修掉。
  - ⚠️ 闸只要求「组件自己有一个 `background:` 声明」（[table-bid-bottom:469-473](../../../apps/client/test/table-bid-bottom.test.ts#L469-L473)）⇒
    **值可以换**，但那一行必须**是 `background:` 简写**（写成 `background-image:` 匹配不上）。
- 🔴 **新增第 8 个素材槽** `$ftl-art-settlement-ribbon`（`jujsidai.png` 在库里但**今天没有任何槽**；
  `Settlement` 走槽位才能满足「换素材只改一行」）。
  - 🔴 **这个槽必须挂在 `Settlement.vue` 上，不得挂到 `Panel.vue`** —— `art-slots` 的规则是**按文件**生效
    （「一旦某 `.vue` 用了 `$ftl-art-*`，它自己就不得再写 `/static/ui/` 字面路径」），
    而 `Panel.vue` 里有 `panel-blue.png` / `panel-orange.png`（[panel.test.ts:31-32](../../../apps/client/test/panel.test.ts#L31-L32) 钉着）
    ⇒ **挂过去当场红**。`Settlement.vue` 今天零字面路径（已核）⇒ 安全。
  - ⚠️ 槽名的**用词**必须**避开 M09 保留词**（`baseScore` / `multiplier` / `底分` / `倍数`
    —— 片② 给倍数徽章取名时踩过一次）。

### 3.6 二级弹层

- 形态照 `game.vue` 的**好友房弹层**（全屏遮罩 + 居中面板 + `close_btn.png` 关闭）—— 本就是本仓的既有范式。
- 关着时四个占位按钮**不在 DOM**（这正是「收进弹层」的语义）。
- 🔴 **本片只新增这一个组件** ⇒ `TABLE_AREA` 清单 **9 → 10**（R659 的长度断言同步改）。
  其余三件**不新增组件**，各有归属：

| 件 | 落在哪 | 为什么不新增 |
|---|---|---|
| 叫抢回显（对手） | `Seat.vue` 加一个可选 prop | 它本就是「贴在该座位旁」的东西 |
| 叫抢回显（我）+ 场次名/底分 + 中央倒计时 | `table.vue` 的 `.table__center` 内联 | 只有一处消费者，抽组件是空抽象 |

### 3.7 素材槽与 art brief

| 槽 | 本片动作 |
|---|---|
| ③ `$ftl-art-coin` | 接通 → `url('/static/ui/dou.png')` ✅（阶段 B 已落地） |
| ⑥ `$ftl-art-countdown` | 🔴 **订正（2026-09-29 · 用户裁决）**：原文写「接通 → `url('/static/ui/jishianniudi.png')`」—— **实测那张素材与容器形状不匹配**（它是**宽胶囊**：左侧一个深棕不透明钟面 + 右侧金胶囊；而容器是按参考图做的**圆钟** 88×92）⇒ **裁决：不接，等一张合形的素材**。槽值保持 `none`，art brief 对该槽的要求**不变**（**钟形底 + 透明钟面**，秒数由 DOM 画在正中）。⚠️ 变体 ④（`auto 100%` + 左对齐、秒数亮字+描边）已被**整条退回** —— 亮字在正确素材的浅底上**不可读** |
| ⑧ `$ftl-art-settlement-ribbon` | **新增**（`jujsidai.png`）✅ 已落地；🔴 **必须 9-slice**（整图拉伸会把两端卷曲翼拉歪）⇒ 切片 `36 225 27 221` 量自**源图像素**的结构边界（那条绶带顶部是拱、两侧是垂翼，**不是**圆角矩形），渲染 `16px 98px 12px`（令牌 `$ftl-ribbon-slice-x`） |
| ① ② ④ ⑤ ⑦ | **继续 `none`** —— 无图，且本仓**不许塞占位图**（那会让「哪些还没接」失去可见性） |

🔴 **art brief 的槽位尺寸表要重新实测校准** ⇒ 用仓里现成的量具
[`measure-table.mjs`](../../../scripts/measure-table.mjs) 出数，回填进 `2026-09-21-ui-art-brief.md`。
✅ **已完成（阶段 B · B6）**：八槽逐格真浏览器实测（**是八槽，不是七槽** —— 本片新增了结算绶带那一槽），
逐格标「实测于 B6 提交」。

### 3.8 每页可选底纹（§5.4 悬案）

- `LandscapeStage` 加一个 **`backdrop` prop**（页面显式声明用哪张；缺省 `bg.png`）——
  不用「按 `auth.page` 查表」，舞台不必知道页面身份。
- 🔴 **图先不动**（继续 `bg.png`）。在阶段 B 的走查里把 `Common_BG4_2x.png`（木桌底板）与 `bg.png`
  **截两张并排给用户裁** —— 上位 §5.4 明说这个问题的答案是「要等真浏览器截图并排才定」。
  ✅ **已裁（2026-09-29）**：看过并排图后**维持 `bg.png`**；`table` 键与 `Common_BG4_2x.png` **已登记在映射表里**
  （1024² 在 1334×750 上 `cover` 会纵向裁近一半）⇒ 将来有合形素材时**换一行**即可启用。
  登记位置：`2026-09-21-ui-art-brief.md` **§2.1 页面底纹**（名称 / 目标分辨率 / 怎么换）。
  ⚠️ **订正（2026-09-29）**：原文写「在走查里截两张并排给用户裁」——**该问题已由 B7 单独出图裁决完毕**，
  §3.6 的走查清单里**不必再列它**。

---

## 4. 判据改动记账（🔴 上位 §7.1 要求的纪律）

**反例纪律**：不接受「把断言改绿」。每条都要写清「**为什么改 + 改完还测不测得到那个性质**」。

| 受影响的判据 | 为什么 | 改完还测不测得到原性质 |
|---|---|---|
| 🔴 **`table-bid-ui` 的 R659 `LOCAL_SCORING_TRACES`** | **初稿漏了这条**。它逐字禁 `/底分/` 与 `/\bbaseScore\b/` 出现在**牌桌区 9 个文件**里 —— 而协议⑥**要求**牌桌显示底分 ⇒ **必红** | **只有两条要改，另三条一个字不动**：<br>· `/×\s*\d/`（本地拼「×N」）**保留**<br>· `/底分/` → 改成**禁「底分数值字面量」**（`/底分\s*[=:：]?\s*\d/` 之类）<br>· `/\bbaseScore\b/` → 允许**引用服务端字段**（`view.baseScore` / `store.view.baseScore`），改为禁**赋值/运算**（`/(?:const\|let\|var)\s+\w*baseScore/`、`/baseScore\s*[*+/%-]/`）<br>· `/\b(?:bidMultiplier\|multiplier)\s*[*+/%-]/` **保留**<br>· `/Math\.pow\s*\(\s*2/` **保留**<br>**原性质**（「牌桌不得**凭空**多出底分 / 不得本地算」）**完全保留**，只是把「字段名本身」与「本地推导」分开：前者现在合法，后者仍然非法。另加**正对照**（服务端给了底分 ⇒ 页面上必须真的出现那个数字，否则「显示了」这件事没有闸） |
| 🔴 **`table-hud` 的 R654** | 「HUD 文本不得含『底分』」——协议⑥之后底分**合法地**出现在牌桌上 | **改形态**：→「显示的底分**只能**来自 `PlayerView.baseScore`」+ **正负对照**（服务端不给 ⇒ 不得出现任何底分数字）。⚠️ 底分显示在**中央**，HUD 三项（倍数/炸弹/房间）**不变** |
| 🔴 **`table-bid-bottom` 的 R657 组** | 「文案**不随**叫/抢变化」——现在**随 `kind` 变化**（上位 §4.3 明文要求） | **改形态**：→「文案**只能**从 `kind` 派生」。⚠️ 反例要保留：**同一 `kind` 下文案恒定**（防止退化成「什么都能变」） |
| 🔴 **`action-feedback` 的两条气泡用例** | 本地回声**删除**（「不出」「不抢」现在都是服务端的原话） | **成对迁移**：从「ack 后出现气泡」→「**服务端给了才出现**（且文案由 `cards: null` / `decisions` 推出）」+「被拒不出现」。⚠️ 源码级锚点 `watch(() => store.currentVersion` 会**消失** ⇒ 那条判据要换锚点，不能直接删 |
| 🔴 **`TABLE_AREA` 清单（R659，长度钉死 9）** | 新增二级弹层组件 | 清单 **+1**、长度断言 **9 → 10**。⚠️ 少登记会红、多登记也会红 |
| 🟠 **`art-slots` 第一条**（七槽缺省**全 `none`**） | 接通 `coin`/`countdown` + 新增 `ribbon` | **改形态**：→「每个槽**显式登记**状态（`none` 或 `url(...)`）」+ 每条必须**真被引用**（既有第 4 条的射程扩到 8 槽）。「不得硬编码 `/static/ui/`」那条**一条不动** |
| 🟠 **`landscape-canvas` 的 R713** | 「每页可选底纹」会打破「`bg.png` 只出现一次」 | **改形态**：→「**舞台只有一层底纹**：底纹图只允许出现在 `LandscapeStage.vue`」+「映射表里的每张图都在盘上」。⚠️ 片① 的 Minor 已预警旧正则太宽（`/bg\.png/` 会误命中 `table-bg.png` 之类），这次锚到 `/\/static\/ui\//` |
| 🟠 **`table-hud` 的单根 `SINGLE_ROOT_CASES`** | `PlayArea` 的 props 形状要变（`cards+ownerSeat+ownerLabel+bubble` → 一个 action） | **prop 名即契约** ⇒ 用例与组件同步改；「单根」这条性质**完全保留**（8 个组件 + 3 个页面） |
| 🟡 **源码级文本锚点群（4 条，🔴 初稿漏了）** | 它们不用 DOM、读的是 `table.vue` 的**源码文本**：`card-hand-interaction:492,501`（`:deep(.hand){column-gap:0}` / `.card + .card{margin-left:…}`）· `action-feedback:212`（`watch(() => store.currentVersion`）· `page-stack:224`（`usePageAlignment('table')`）· `landscape-canvas:113`（必须包 `<LandscapeStage>`） | **逐条核在不在** —— 这正是「**整体替换块要逐块核『现文件有、替换块没有』**」那条教训的落点（片② 因此丢过三处仍然成立的理由）。⚠️ `watch(() => store.currentVersion` 那条**会真的消失**（气泡退役）⇒ 要**换锚点**，不是删 |
| 🟡 **`audio.test.ts`** | 「事件→cue」4 条（`Rob1/Rob3` · `NoOrder` · `buyao1/2` · 越界回落）+ 3 条要 mount 起 `TablePage` | 音效改走视图 diff 后，入口从 `table.vue` 的本地回声变成 `useTableSound` 的 watch ⇒ 用例**换入口、不换性质**（「该响时用正确的 src 播放」） |
| 🟡 **`hand-layout` 的 `W=155/BASE=89/ROW=1294`** | 与 `uni.scss` 是**第二真源**（片② 遗留） | 本片若动 `.table`/`.table__me` 内边距就必须**先消掉这个第二真源**（改成从 `uni.scss` 现读），否则两个真源会互相打脸 |
| 🟡 **探针 `browser-e2e.mjs`** | `canPass`（[:319](../../../scripts/browser-e2e.mjs#L319)）读 `store.lastPlayedHand`；`autoPlayUntilEnded`（[:793](../../../scripts/browser-e2e.mjs#L793)）用它选分支 | 改读 `recentActions`，**依赖 §2.3 的不变式②**（那边有判据）。⚠️ `.table__bar .btn` + 逐字「返回大厅」**必须留** |
### 已核**不受影响**（记账两个方向都要准 —— 片② 正因「多算了一条」被审）

| 判据 | 为什么不影响 |
|---|---|
| `table-ended-ui` | 四个动作 class 的**存在性矩阵** + `.table__bar` 文本含「已结束」—— 本片保留 4 个 class、阶段状态仍留在 `.table__bar` 内 |
| `table-play-ui` | `.table__me .card` 17 张 · `.table__me-head .seat__timer` · `.table__play`/`.table__pass` 的 disabled —— 全部保留（含「首出时过牌不禁用」） |
| `table-seat-geometry` | `.seat__*` 九个 class、张数字号 > 昵称号、报单报双预警 —— `Seat` 的 class 与档位关系一个字不改 |
| `card-hand-interaction`（**除**源码锚点那两条） | 牌面/牌背/排序/选中语义全部不动 |
| `source-boundary` | 只要新模板里不写规则标识符、不写底分**字面量**、不自制点数映射（三者的边界见 §4 的 R659 行） |
| `ui-tokens`（M09 等） | 新增的是**样式**，令牌只引用不改定义；⚠️ 新槽名避开保留词 |
| `animations` | 牌桌区禁 `setTimeout`/`setInterval` —— 本片不引入任何计时器（中央倒计时复用页面唯一的 `useCountdown`） |
| `panel` | `Panel.vue` 本片**不改**（绶带槽挂 `Settlement.vue`，见 §3.5） |
| `ui-flow` / `asset-budget` / `mock-e2e` | 与牌桌 DOM 无直接关系（`ui-flow` 按组件 `name:'Card'` 找，`Card.vue` 不改名） |
| `settlement-rematch` / `page-stack` / `landscape-canvas` 的「四页」与路由断言 | 本片不动 `auth.page` / `pages.json` / 路由。⚠️ 与上表那三条**源码文本**锚点是两回事 |

---

## 5. 验收（**两次**）

### 5.1 阶段 A

| 层 | 判据 |
|---|---|
| 机械 | `pnpm run ci` 六阶段全绿 |
| conformance | 09/10/11 重写后跑过；**基线不得下调** |
| 真栈 | 全套跑一遍；本机跑完必须 `--force-recreate` |

### 5.2 阶段 B

| 层 | 判据 |
|---|---|
| 机械 | `pnpm run ci` 六阶段全绿 |
| 真浏览器探针 | gate + full **真跑**（`canPass` 改完后必须真跑，它是真浏览器判据不是单测） |
| 真机 | HBuilderX 跑一遍：布局不炸 / 素材加载 / 工作流可用 |
| **人眼** | 与参考图 **3/4/5/6 并排**：牌桌前 · 出牌中 · 叫抢三个按钮 · 叫抢回显；**另加底纹二选一** |

⚠️ **观感没有机械判据，只能人眼**（本仓既有结论）—— 它**不是主判据**，也不替代机械闸。

---

## 6. 对上位规格的订正表

| # | 上位规格写的 | 实测 | 处置 |
|---|---|---|---|
| 1 | §3.3「**六个**素材槽」 | **七个**（片② 执行期从六个拆出 `bottom-bar`，`uni.scss:197` 逐字记着）；本片新增第 8 个（绶带） | 本文件用**八个** |
| 2 | §4 表「以下是**全部**破口」6 条 | **7 条**（+⑦）+ **1 条连带面**（④′） | §2.1 的订正表**替换**它 |
| 3 | §4.4 只写「退役面要逐个列出」 | 真正的硬约束是**跟牌目标失去输入**（§2.1 ④′），上位没写 | 记进 §2.1 |
| 4 | — | **`LOCAL_SCORING_TRACES`（R659）也禁「底分」**，上位 §7.1 的受影响面**漏了它** | §4 记账表 |
| 5 | — | `test-full-game.ts` / `.js` 是**死脚本**（全仓零引用、字段早已漂移，仍用 `lastPlayedHand.rank` 这种 C20 之前的名字） | **本片删除**（或明确标注为死脚本） |
| 6 | — | `types.ts:55` 的注释写着「默认 100」，实际 `DEFAULT_BASE_SCORE` = **15**；`types.ts:62` 写着「与 `PlayerView.lastPlayerIdx` 同名同义」 | 顺手订正 |

---

## 7. 已知取舍与未来项

- 🔴 **叫抢回显第 3 条看不见**（§3.4 的取舍）—— 那一拍由地主徽章 + 翻底牌接管，不引本地计时器。
- 🔴 **五个素材槽仍为 `none`**（① ② ④ ⑤ ⑦ 无图）—— 继续 CSS 兜底，**不塞占位图**。
- ⚠️ **底纹未定**：机制做、图不动，等并排截图（§3.8）。
- ⚠️ **`ui-tokens` 的 M09 保留词闸**（`baseScore|multiplier|底分|倍数`）适用于 **`uni.scss`**：
  新增槽名（如 `$ftl-art-settlement-ribbon`）**必须避开**；注释里可以照常写中文（注释被剥离）。
- **后台设置页面**（写接口 + 权限）另立一片（计划 B 的既有结论，本片不动）。
- **音效**：**叫抢**改走**视图 diff**（协议⑦ 的 `bidPhase.decisions`，见 §3.4）；**过牌仍走 ack 本地回声**
  （`table.vue` 的 `cueForPass`）—— 若发现「别人的叫抢也会响」不合预期，
  那是**新裁决**，另立小片，不在本片偷改。

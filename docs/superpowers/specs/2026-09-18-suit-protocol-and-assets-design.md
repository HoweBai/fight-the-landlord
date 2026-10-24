# 斗地主平台 · 花色协议与素材接入（设计规格 / spec）

> **日期**：2026-09-18 · **状态**：设计规格 v4（**已定稿**）· 实施完成于 2026-09-21（8 个 Task 全部收口；见 `docs/superpowers/plans/2026-09-20-suit-protocol-side.md` 与改动面清单）
> **上游**：
> - `docs/superpowers/plans/2026-09-18-slice-ui-assets-and-suit-protocol.md`（交接骨架，6 个 Task 与 R688–R694）
> - `docs/superpowers/specs/2026-09-18-reference-ui-teardown.md`（素材清单与拆解）
> - `docs/superpowers/specs/2026-09-17-game-ui-redesign-design.md`（上一片 UI 规格；其 §12 执行期订正仍有效）
> **归属**：本片（花色协议 + 素材接入）的**设计真源**。实施计划另出，**拆两份、串行**（R700）。
> **前置状态**：上一片「对局 UI 重设计」已完成，收口 commit `5343ea2`。
>
> **v4 说明（2026-09-20，四路独立复核的订正）**：v3 经四路独立复核（① 编码与规则面 ② **改动面完备性** ③ 素材数字 ④ 门禁计数与内部一致性），逐条核实全部 file:line 与实测值。结论：
>
> - **事实层扎实** —— 引用几乎无错；§9.2-1 的 63/2/65、9 个探针锚点、`shared` 143 条、13 个 conformance 切片、10 个机械闸文件**全部精确复现**；R688–R705 无跳号/无重号/无悬空，交叉引用全部有效；§1/§10/§11 三表无实质矛盾。
> - **改动面清单仍系统性不全** —— v2 审查已指出过同一问题，**v3 未修好**：23 处遗漏，另有 3 条运行期静默点完全未提。
>
> 据此的修订：
>
> | # | 修订 |
> |---|---|
> | ① | §3.4 **重写为方法**：改动面**由 `tsc` 反推**（**R706**），不再人工列文件名 |
> | ② | 新增 **§3.5「`tsc` 看不见的清单」**：只收三类 —— 类型断言绕过 / 运行期静默退化 / 注释与文档过期 |
> | ③ | 订正 **10 处数字与引用**（**R707** 逐条列出） |
> | ④ | 订正 **5 处判断**：`cardToInt`/`intToCard`/`douzeroIntToCard` 应**删除**而非「简化」（C4/C5）；§2.4「`data-value` 不变」不成立（C6）；§4 ① 回填与既有判重逻辑的交互必须表态（C8）；`Rank` 枚举生死必须表态（C9） |
> | ⑤ | §4 补**「人类出牌」**路径（唯一由客户端提供花色的路径，原表漏）；§5 补 3 个客户端组件与 **`Hand.vue:49` 的排序静默退化** |
>
> **v3 说明的两处数字在 v4 订正**：v3 写的「只有 **161** 个可用」应为 **160**（161 是漏掉 `Fonts/ice.ttf` 后凑出来的）；「**83** 文件 / **2.5MB**」应为 **82 文件 / 2.27MB**。
>
> **v3 说明（2026-09-20，用户复核意见的落地）**：素材已从 `reference/CardGame/Assets/Resources/` **移到仓库根的 `resources/`**（`reference/` 已不存在）。据此修订四处：
> **①** §6.1 来源路径与文件构成（实测：385 文件里只有 160 个可用，225 个非媒体文件）；
> **②** §6.2 映射表形态定为 **`static/cards/manifest.json`**（R702）并补体积预算实测值；
> **③** §6.2 新增「素材来源不入库、只入精选子集」的版本库边界（R703）；
> **④** §6.4 牌桌底纹**裁定为 `new_BJ.png`**（R704，原 v2 把 `bg.png` 与 `new_BJ.png` 并列，与 §6.2 的 `ui/` 预算自相矛盾）。
> **⑤** §6.2 字体 `ice.ttf` 的处置由「须注明字魂商业字体」改为**本轮不采用**（R705）。
>
> **v2 说明**：v1（`b878bc8`）经两个独立审查者逐条核实事实与完备性。事实层基本站得住（所有 file:line 引用无一错误），但**改动面清单系统性不全**、且与 §3.1 自相矛盾。v2 重写了 §3.4 / §4 / §9，补了 §1.1（偏离记录）、§2.5（`createDeck` 地雷）、§6.4 / §6.5，修正了音效清单、体积预算与若干处读数口径。

---

## 0. 为什么做

牌桌当前是**纯 CSS 画牌，没有花色**：`PlayerView.hand` 是 DouZero 编码的整数数组，`Card.vue` 用 `toDisplay()` 渲点数文字，牌背是 CSS 纹样。上一片规格 §7-① 把这定为「简约纸牌风 / 零素材」，是当时**没有素材**的权宜。

现在两个条件都变了：

1. **素材已取得授权**（R688），仓库根 `resources/` 的 54 张牌面 + 牌背 + UI + 音效可用；
2. **用户裁决加花色**（R691）——没有花色就接不上面向真牌面的素材。

本片把这两件事一起做掉：**先让协议认识花色，再让牌桌用上真素材**。

---

## 1. 本片裁决（R695 起）

| # | 裁决 | 性质 |
|---|---|---|
| **R695** | **全系统统一使用 DouZero 编码，删除内部 Rank**。`2` 在**所有**层都是 `17`；`toInternalRank()` / `toDouZero()` 两个转换函数**删除** | **规格变更**（改 `doudizhu.md` 多节，见 §9.4） |
| **R696** | 一张牌的传输/存储/内存形状 = **`{ r, s }`**：`r` 沿用 DouZero 编码，`s` ∈ `0`♠ `1`♥ `2`♣ `3`♦ `4`王 | 契约变更 |
| **R697** | `game.play` 载荷改为 `{ cards: {r,s}[] }`；服务端**按身份精确摘除**，送了自己没有的牌即拒 | 契约变更（破坏性） |
| **R698** | **修正 R692 的音效范围**：只做素材里**真实存在**的那批（见 §7 的完整表） | 修正 R692 |
| **R699** | **修正交接文档的素材尺寸假设**：牌面实为 **80×104 px**（非 ≥120×168）。本轮**用它**；**「牌面重制到 ≥160×208」另立一片** | 修正 R693 的落地形态 |
| **R700** | 本片**拆两份计划、串行**：①**协议侧**（R695–R697）②**素材/观感侧** | 范围与顺序 |
| **R701** | **小程序端排除在一切设计、开发、测试之外**；`mp-transport.ts` 等代码**保留但冻结，不删** | 范围（**强化 R690**） |
| **R702** | 牌面映射表落地形态 = **`static/cards/manifest.json`**（键 `{s}-{r}` → 文件名），**不是 `.ts` 常量模块** | 落地形态（§6.2） |
| **R703** | **`resources/` 是源素材库，不进版本库**；只有 `apps/client/src/static/` 的精选子集入库（**82 文件 / 2.27MB**，v4 订正） | 版本库边界（§6.2.1） |
| **R704** | 牌桌底纹**只用 `new_BJ.png`**，`bg.png` 不采用 —— 原 v2 §6.4 两者并列，与 §6.2 的 `ui/` 预算自相矛盾（219+328=547KB > 400KB） | 修正 v2 §6.4（§6.2.4） |
| **R705** | 字体 **`ice.ttf` 本轮不采用**（1,958KB，且上游为字魂商业字体）。本轮用系统字体；要用须先确认授权覆盖字体，另立一片 | 范围（§6.2.2） |
| **R706** | **改动面清单由 `tsc` 反推，不得人工列举** —— 先只改类型定义、跑 `pnpm lint`（后端含 `tsconfig.test.json`）与 `vue-tsc --noEmit`，把报错逐条落成任务。**判据**：清单里每一条都必须能追到一次真实的 `tsc` 报错 | **方法**（§3.4；依据：v2/v3 连续栽在「清单系统性不全」） |
| **R707** | **数字与引用订正 10 处**（逐条见 §1.2） | 订正（v3 的复核报告） |

> **R701 的来由**：用户 2026-09-18 曾考虑「连同代码一起删」，**权衡后决定不删**。R690 只说了「开发/测试不涉及小程序」，R701 把**设计**也排除，并显式关闭删除选项——`net/mp-transport.ts`、`net/http.ts` 的平台分支、`scripts/build-mp-weixin.mjs`、mp 契约测试**一律保留原样**，不维护、不为其写用例、不入任何门禁。**代价要知悉**：这些代码自此没有维护者，且 `design.md` §1.4 记的「微信小程序 = ✅ 已验证」这条能力**不再被任何门禁覆盖**。

### 1.1 本规格相对交接文档的偏离（**用户 2026-09-18 会话内裁决**）

交接文档 §2 把「(甲) 只在下发路径补花色（**推荐**）／(乙) 内部也改成 `{r,s}`（原文：「面大、风险高，**建议作为后续独立片**」）」设为**开工前必须与用户确认的门**。本规格的选择如下，逐条记录以免后人误以为仍是 (甲)：

| 项 | 交接文档 | 本规格 | 谁定的 |
|---|---|---|---|
| 内部形状 | 推荐 (甲)（规则面零改动） | **(乙)**：内部也改 `{r,s}` | 用户会话内裁决 |
| 内部 Rank 编码 | 未涉及（(甲)(乙) 都保留双编码） | **删除**，全系统统一 DouZero（R695） | 用户会话内裁决 |
| 王的哨兵值 | 交接 §1 建议 `-1` | **`4`**（沿用 `shared` 现有 `Suit.Joker`） | 本规格 |

> **为什么可以选被交接文档建议推迟的 (乙)**：(乙) 的最大成本在「动规则引擎」。实测该成本**远低于交接文档的估计**——`rule.ts` / `autoplay.ts` 的**逻辑零改动**，只有 **6 处**字段名从 `.rank` 改成 `.r`（§3.1；v4 订正：v2/v3 写的「7 处」是 v1 旧口径残留）。加上 R695 消除双编码后，C19 那一类缺陷**结构上不可能**（原文误作「不再可能」，v4 订正）。

### 1.2 R707 —— 数字与引用订正清单（v3 四路复核的实测）

> 全部为**实测值**，非转述。逐条给出「v3 写的」与「实测」。

| # | 位置 | v3 写的 | 实测 |
|---|---|---|---|
| 1 | §6.1 表「可用媒体」 | 161 | **160**（png 79 + ogg 78 + json 3）。第 385 个文件是 `Fonts/ice.ttf`，**v3 漏归类**——表里既无 `.ttf` 行也没算进媒体（v4 已补） |
| 2 | §6.2.1 / §6.2.2 | 83 文件 / 2.5MB / 占比 15% | **82 文件 / 2.27MB**；占比按字节 **13.6%**、按个数 **51%**（v3 的 83 疑似把 `manifest.json` 也数进去） |
| 3 | §6.1「引擎专有 224 个」 | 224 / 58% | 算术成立，但**措辞偏松**：xlsx/txt/jpg 不是「引擎专有」，且 `.ttf` 不在任一桶 ⇒ 照目录拷实际多搬 **225** 个非媒体文件 |
| 4 | §6.2.2 + §7 | 48 条出牌播报 | **50**（`64 − 14`；14 = Order/NoOrder/Rob1–3/buyao1–4/baojing1–2/jiabei/bujiabei/Share） |
| 5 | §3.4 + §6.3 | `card-hand-interaction.test.ts:127-166` 有 **8 条 `it()`** 受影响 | **2 条**。该文件全文件确为 8 条，但分布在 `:124 :157 :173 :194 :239 :259 :290 :323`；`:127-166` 只是前后两条的断言行区间。**真正受判据迁移影响的只有 `:124`（文本断言）与 `:157`（`.card--wide` 类命中）** —— v3 把「文件总数」当成「受影响数」，**夸大了 4 倍** |
| 6 | §11-6 / §3.4 | `sameHand`/`Number(c)` 运行期退化只在 `slice-07.2-security` | **4 个切片**：`boundary:113-123`、`hardening:317-323`、`rpc:211-221` 有一字不差的同一副本。另 §3.4 只点名 8 个切片，**漏 `slice-07.2-rpc`**（§11-6 的「≥9」成立） |
| 7 | §2.5 / §2.2 | `card.ts:97-99`；`autoplay.ts:241` 的 `length` | 行号实为 **`:98-99`**（`:97` 是 `const deck: Card[] = []`）；`autoplay.ts:241` 的变量名是 **`planeLen`** 不是 `length`（引文不逐字） |
| 8 | §2.5 + §11-2 | 「`tsc` 抓不到 ⇒ `[人盯]`」 | **单测能抓**：`packages/shared/src/card/card.test.ts:37-40` 有 `expect(deck).toHaveLength(54)`，`Rank2` 一改 17 立即变红。对**编译期**不可见成立，对**单测门禁**可见 —— v4 改标为「**单测可抓，勿按人盯处理**」 |
| 9 | §9.4 | `grep "内部 Rank" doudizhu.md` = 0 可收口；列 3 处 | 当前实测 **5**（`:54 :228 :246 :418 :420`）。规格列的 3 处里 **`:436` 是「内部编码」不是「内部 Rank」，根本不会出现在该 grep 里** ⇒ 判据只能抓 3 处中的 2 处；§1.3/§1.4/§10 只能靠整节重写收口。「`design.md` 一并收口」**已过期**——design.md 该字样 **0 命中**，其待改点是 §3.6(`:343`) 与 `:1762` |
| 10 | §11-3 | `source-boundary` 两条死条目 | `toInternalRank` 在该文件出现 **2 次**：`:96` 与 **`:281`**（另有一条清单）。收口别漏 `:281` |
| 11 | §1.1 / §3.4 | 「7 处 `.rank → .r`」 | **6 处**（rule.ts 1 + autoplay.ts 5）；§3.4 那条未随 §3.1 同步 |

**两处漏登（v4 补入 §6.2.2 / §7）**：

- **`Woman_100` / `Woman_200`** —— §7 与 §6.2.2 全篇零提及。`resources/Config/AudioConfig.json` 里它们是 `singleLK` / `singleBK`，即**大小王单张的出牌播报**。§7 说「出牌播报要做得先加一条裁决」，但这两条是**单张出牌**、本来就有裁决可用 ⇒ **漏登有代价**；
- **`resources/UI/public_bg.jpg`**（21,162 B）—— 采用清单与未采用清单**都没有它**。它是 `UI/` 里唯一的非 PNG 图片（`UI/` 非 `.meta` 文件 23 个 = 22 png + 1 jpg）。

**一处计数口径提醒**：§11-7 的「`shared` 测试 143 条」是**整包口径**（含 `shared/test/`）；若只算 `packages/shared/src/**` 则是 **138**。v4 已在该处写明口径。

---

## 2. 编码统一（R695）

### 2.1 现状与目标

| 点数 | 内部 Rank（**删除**） | DouZero 编码（**保留，全系统唯一**） |
|---|---|---|
| 3–10 / J / Q / K / A | 3–14 | 3–14 |
| **2** | ~~15~~ | **17** |
| 小王 / 大王 | 20 / 30 | 20 / 30 |

统一后只剩右列一套。`17` 在**所有**层都表示 `2`。

### 2.2 为什么可行（已核实，非推断）

- **大小序完整保持**：`3 < 4 < … < 14 < 17 < 20 < 30`，与玩法 §1.2 同构；
- **`rule.ts` / `autoplay.ts` 无逻辑改动**：实测这两个文件**没有任何写死的 15 或 17**（**口径**：按整数字 `\b15\b` 匹配，唯二命中是注释里的日期 `2026-09-15`；若按裸子串 `15` 匹配则是 4 处 —— 另有 `rule.ts:161` 与 `autoplay.ts:10` 的 `R157`。**v4 补口径**），全是 `Rank.Rank2` 一类符号引用。三处关键写法在 17 这套下语义不变：
  - `canBeat`：`newHand.keyRank > lastHand.keyRank`（`packages/shared/src/rule/rule.ts:177`）——序数比较；
  - `isContinuous`：`ranks[i-1] + 1 !== ranks[i]`（`rule.ts:58`）——顺子判定只发生在 3–14 区间，该区间两套编码**完全相同**；
  - `isContinuous` 的排除项：`ranks[i] >= Rank.Rank2`（`rule.ts:57`）——把 2 与大小王一并发挡住，换成 17 后仍是 17/20/30 全中。
- **两处未被规格 v1 提及、但审查中查过确认无害的数值依赖**：`autoplay.ts:214`（`takeRun`）与 **`:241`（`takePlaneWithWings`）**的 `for (let start = Rank.Rank3; start + **<len>** - 1 < Rank.Rank2; start++)` —— **两处的长度变量名不同**：`:214` 是 `length`、`:241` 是 `planeLen`（v4 订正：v2/v3 把两处都写成 `length`，引文不逐字）。改成 17 后两个循环上界各上移**恰好 2**（任意 length 都只多 2 次空转，多出的起点其区间必然含 15 或 16），而 `counts.get(r) ?? 0`（`:220` / `:245` 确有 `?? 0` 兜底）恒为 0 ⇒ 跳过，**对合法手牌无行为变化**。规格举的「start = 11, 12」正是 length=5 时的两个多出起点，逐位吻合。

### 2.3 连带收益

- `LastPlayedHand` 的 `keyRank` 与 `cards[].r` **同域**（当前一个是内部 Rank、一个是 DouZero，两个域挤在同一个结构里）。同域的证实：`protocol/src/views.ts:32-38` 注释逐字写「`keyRank` 为**内部 Rank**（`2` = 15）」、`shared/src/ddz/types.ts:12-13` 写「`cards` 是 **DouZero** 编码；`keyRank` 是内部 Rank」，写入点 `shared/src/ddz/play.ts:105-110`（`keyRank` 来自对**内部 Rank 卡**的 `parseHand`，`cards` 是原始 DouZero int 数组）；
- **跨域换算比对的落点比 v2/v3 写的更广**（v4 订正）：真正共用的断言是 `tools/conformance/src/lib/ddz-driver.ts:217-236` 的 **`checkSingleCaliber()`**（跨域比对在 `:231`），被 `slice-09`（`:157/:259/:305/:365`）、`slice-10`（`:305`）调用，`slice-11`（`:267-281`）另有一份内联副本。规格原文只点了 `slice-09:370` 与 `slice-11:276` **两处**，**口径偏窄**；
- 另有一处写死 17 的常量：`tools/conformance/src/slices/slice-11-robot-system.ts:108` 的 `const DOUZERO_2_CODE = 17;`（`:267` 使用）。v3 的 §3.4 只按切片名笼统列了 slice-11，收口时别漏它；
- **C19 那一类缺陷结构上消失**：C19 的成因是「待出牌直接把 DouZero 当 `Rank`、待跟牌却还原成 `Rank2`」⇒ 同点数的 2 互相压过（`docs/design.md:1762`）。只有一个域之后，**没有「还原」这一步可以忘**。

### 2.4 线格式的牌值一个都不变

传输与存储**本来就用 DouZero 编码**（`docs/games/doudizhu.md:59` §1.4 规则 1 逐字规定）。代码侧的对应（v4 订正了引用精度）：

| 文件 | 位置 | 备注 |
|---|---|---|
| `shared/src/ddz/types.ts` | `:33` | `hand: number[];  // DouZero card ints` |
| `protocol/src/views.ts` | **`:54`（不是 `:55`）** | DouZero 声明在 `:54` 的 doc 注释；`:55` 是字段行 `hand: number[]` |
| `game-service/src/game/view.builder.ts` | `:70` | `const hand = players[seat]?.hand ?? [];` —— 该行**本身不带编码声明**（透传到 `:82`），是**间接**证据 |

变的只是内部那套 15。因此：

- 所有「断言线上牌值」的 conformance 断言不变；`toDisplay()` 的**渲染结果**不变；
- ⚠️ **但「`data-value` 不变」不成立**（v4 订正）：`apps/client/src/components/Card.vue:75` 的 `:data-value="value"` 绑的是 `value: number`。`store.hand` 变 `Card[]` 后，这个绑定**必须改**（改为传 `.r`，或让 `Card.vue` 接受 `Card`）。`data-value` 全仓 **38 行 / 8 个文件**引用，是探针与既有断言的重要锚点 ⇒ **这个绑定点必须在本规格写死**，见 §5；
- 只有断言「内部口径」的地方要改（见 §3.5）。

### 2.5 ⚠️ 一处必须显式改的地雷：`createDeck()`

```ts
// packages/shared/src/card/card.ts:98-99（现状；v4 订正行号 —— :97 是 const deck: Card[] = []）
for (let s = Suit.Spade; s <= Suit.Diamond; s++) {
  for (let r = Rank.Rank3; r <= Rank.Rank2; r++) {   // ← Rank2 一改 17，这里变成 3..17
```

`Rank2` 由 15 改成 17 之后，这个循环会产出 **15 个点数 × 4 花色 + 2 王 = 62 张**，其中 `15` / `16` **不是合法 DouZero 牌值**（`codec.ts` 的 `isValidDouZeroCard` 只认 3–14 / 17 / 20 / 30）。

⚠️ **v4 订正措辞**：v2/v3 写「洗牌后**必然**进手牌」——**过头**。`shared/src/ddz/game.ts:78-91` 只发 54 张（三手 17 + 底牌 3），余 8 张不发；而非法牌恰好 8 张（15/16 × 4 花色）⇒ 理论上可**全部**落在未发的 8 张里（概率 ≈ 1/C(62,8)）。**仍是严重地雷，但「必然」不成立。**

**硬要求（v4 执行期订正 —— 原表述只对了一半）**：

`Rank2` 改成 17 之后，**2 与 `RankA(14)` 不再连续**，所以 `createDeck()` 的内层循环**不能用单一上界覆盖全部点数**。两个方向都会错：

| 上界写法 | 产出 | 后果 |
|---|---|---|
| `<= Rank.Rank2`（原样沿用） | 3..17 = 15 点 × 4 + 2 王 = **62 张** | 含 `15`/`16`，**不是合法 DouZero 牌值** |
| `<= Rank.RankA`（**v1–v4 原文的规定**） | 3..14 = 12 点 × 4 + 2 王 = **50 张** | **四张 2 全丢** |

⇒ **正确形态：循环跑 3..`RankA`，四张 2 与两张王各自单独 push。** 见 `packages/shared/src/card/card.ts` 的 `createDeck()`。

> ⚠️ **这一条是执行期实测抓出来的**：v1–v4 一直写着「上界改 `RankA`」，而它只挡住了 62 张那半边、**同时造出 50 张那半边**。四路独立复核（含逐张解析素材、逐个复算计数的那些）**都没抓到**——因为它不是引用错误或计数错误，是**规定的解法本身不对**。
>
> 抓住它的是 `card.test.ts` 的 `creates 54 cards`：改 `Rank2` 不动上界 ⇒ 红（62）；改为 `RankA` ⇒ **仍然红（50）**。**两次红**才逼出正确形态。
>
> ⇒ 这也**订正了 §11-2 的可抓性判定**：这个地雷对**编译期**不可见成立，但对**单测门禁可见**（v3 把它归为 `[人盯]` 是错的）。见 §11-2 的 v4 订正。

---

## 3. 花色契约（R696 / R697）

### 3.1 牌的形状

```ts
/** 一张牌。全系统唯一的牌形状（协议 / Redis / 内存手牌 / 客户端）。 */
export interface Card {
  /** DouZero 编码（R695：全系统唯一编码）：3–14 / 17(=2) / 20(小王) / 30(大王)。 */
  r: number;
  /** 花色：0♠ 1♥ 2♣ 3♦ 4王（两张王都是 4，沿用 shared 现有的 Suit.Joker）。 */
  s: number;
}
```

**全系统只有这一个牌类型**（与 R695 同一精神：不留第二套）。`shared/src/card/card.ts` 现有的 `Card { suit, rank, color }` **退役**：

- `Suit` 常量（`0–4`）保留在该文件，与 `protocol` 的 `s` 同值，**加一条契约测试钉住两者一致**（实测 `Suit` 为 `Spade=0, Heart=1, Club=2, Diamond=3, Joker=4`，与 `s` 值域**逐位一致**）；
- **展示向助手（`suitSymbol(s)`、`colorOf(s)`）放 `protocol`**，不放 `shared`——理由是**客户端只能 import `protocol`**（`apps/client/test/source-boundary.test.ts` 有机械闸），而协议侧就要验收「Card.vue 能渲花色」。放 `shared` 客户端够不到，会逼出第三份自制表。`protocol` 已有 `toDisplay()` 这一展示向先例，`colorOf` 是**新增**。

> ⚠️ **v4 补：`shared` 侧已有一份 `suitSymbol()`**（`packages/shared/src/card/card.ts:92`，经 barrel `index.ts:1` 导出，消费者仅 `card.test.ts:65-72`）。规格只说「放 protocol」，**未点明 shared 那份必须删**。若不表态，收口后系统里会有**两份 `suitSymbol`**——正是 R695 要消灭的「两套口径」。**硬要求：shared 版删除**。另注意 shared 版对 `Suit.Joker` 返回 `''`，protocol 版**需自行定王的符号**。

**连带**：`rule.ts` / `autoplay.ts` 里读 `.rank` 的地方改为读 `.r`。实测产品代码**共 11 行**（口径：`packages/shared/src` 全目录，非测试）：

| 文件 | 行 |
|---|---|
| `rule/rule.ts` | 66 |
| `rule/autoplay.ts` | 33, 92, 100, 311, 312 |
| `ddz/game.ts` | 66（`toDouZero(card.rank)`，**整行删除**——不再需要换算。⚠️ 同文件的 `cardToInt`/`intToCard` **一并删除**，见 §3.5-**D**） |
| `card/hand.ts` | 16, 29 |
| `card/hand-impl.ts` | 4, 5 |

> `card/hand.ts` 与 `card/hand-impl.ts` 的 `findCardsInHand` / `RemoveCards` **除自身测试外全仓零消费者**（实测）。实施时二选一：**删除这两个文件与其测试**，或**一并改形状**。**必须表态，不得留成「编译才发现」**。
>
> ⚠️ **v4 补：若选删除，必须同时删 `packages/shared/src/index.ts:2` 的 `export * from './card/hand'`** —— 否则 barrel 指向不存在的模块，**立即编译报错**。同理 `index.ts:1` 的 `export * from './card/card'` 也要随 `Card` 退役表态（`Rank` 符号的归属见 §3.5-**D** 的 C9 行）。

> ⚠️ **口径提醒（v4 补）**：这 11 行只是**属性读取**口径。**对象字面量构造**不在其中——`card.ts:101/104/105`、`ddz/play.ts:16/19/22/24`、`ddz/game.ts:74/75` 都在构造 `{suit, rank, color}` 或 `{r, s}`。**不得把「11」读成 shared 侧的全部改动面**（这正是 §3.4 要求用 `tsc` 反推的理由）。

> ⚠️ 本小节**修正了本规格 v1「rule.ts 一个字不改」以及「产品代码总共 7 行」两处说法**：规则面的**逻辑**零改动，但字段名要改；行数是 **11** 而非 7（v1 只算了 `rule/` + `ddz/` 两个目录）。

### 3.2 三处契约同时改

| 契约字段 | 现在 | 改为 |
|---|---|---|
| `PlayerView.hand` | `number[]` | `Card[]` |
| `PlayerView.bottomCards` | `number[] \| null` | `Card[] \| null` |
| `LastPlayedHand.cards` | `number[]` | `Card[]` |

**`Card[]` 的校验**（`protocol/src/validate.ts`）：`r` 必须过 `isValidDouZeroCard`；`s` 必须是整数且在 `0–4`。**不做同 `r` 去重**——两张王的 `r` 本就不同（20 / 30），去重规则无处生效；四条同点数不同花色的牌是合法的。

### 3.3 出牌请求（R697）

```ts
| { type: 'game.play'; meta: RequestMeta; payload: { cards: Card[] } }
```

服务端**按身份精确摘除**：逐个在行动者手里找 `(r, s)` **完全相等**的牌并移除；任一找不到即拒（错误码沿用既有的「牌不在手里」映射，走 `rule-error.mapping.ts`；**映射表与文案需同步核对**，N2 的覆盖闸会抓）。

> 这是**破坏性契约变更**。按 `protocol/src/messages.ts` 的既有纪律：两端必须同一个 PR。

### 3.4 改动面：由 `tsc` 反推（R706）

**本规格不再提供「按包、文件级」的改动面清单。** 这不是省略，是**方法变更**——v1 / v2 / v3 连续三版都试图人工列举，**v2 与 v3 的独立复核都判定「系统性不全」**（v3 复核实测 **23 处遗漏**，覆盖全部 7 个包）。

**为什么人工列举必然不全**：漏掉的那几类有共同特征——**测试文件、别的包里的夹具、隔了几层传下来的 prop**。人写清单时脑子里想的是「业务代码」，这三类天然在视线外。而人工列举的完备性**不可证**：你无法证明「我列全了」。`tsc` 的报错列表**是完备的**（在类型系统覆盖的范围内）。

#### 方法（四步）

1. **只改类型定义，不动实现** —— `protocol/src/views.ts` 新增 `Card` 接口 + §3.2 的三处字段；`shared/src/card/card.ts` 的 `Card {suit, rank, color}` 退役。
2. **跑类型检查**（本仓已有现成命令，注意后端是**两条**）：

   | 范围 | 命令 | 覆盖 |
   |---|---|---|
   | 后端 7 包 | `pnpm lint` → `tsc --noEmit && tsc --noEmit -p tsconfig.test.json` | **第二条专查测试文件** |
   | `apps/client` | `vue-tsc --noEmit` | 含 `.vue` 单文件组件 |

3. **每条报错 = 一个真实改动点。** 编译器穷举类型图，不遗漏。
4. 报错列表**逐条**落成实施计划里的任务项。

#### 硬判据

**计划里的改动面清单，每一条都必须能追到一次真实的 `tsc` 报错。** 追不到的，必须说明它属于 §3.5 的三类之一；两者都不是 ⇒ 该条为清单错误。

⚠️ **这条判据本身必须自证判别力**（**探针判别力自证**，`R115`/`R150`；`design.md` §12.4/§13 与台账 `R291`/`R377` 记的「恒绿」形态正是它防的东西）。做法：计划的**第一个 Task** 里，**故意先不修某一处**、跑 `tsc` 确认它确实报错，再修——即证明「清单来自 tsc」这件事为真，而不是事后补的说明。

> **已知的三类高发区**（不是清单，是提醒 `tsc` 跑完后重点核对这几处**在不在**结果里）：
> ① `packages/game-service/src/game/game.controller.ts:102` 的 `@Body() dto: { cards: number[] }` —— **人类出牌的唯一入口**，R697 的核心契约；
> ② `packages/room-service/test/ws.gateway.test.ts:595-600` 的 `playerView()` 夹具 —— `room-service` 在 v3 的清单里**连一行都没有**，但这一包有夹具要改（源码侧确为纯透传）；
> ③ `apps/client` 的 **18 个**测试文件里 v3 只点名了 2 个。

### 3.5 `tsc` 看不见的清单

**只有三类。** 编译器已经把长的部分做完了，所以这份清单**短**，但每一条都必须带定点判据或走查步骤。

#### A. 类型断言绕过（`as` / `any`）—— 编译器被明确告知「别管」

| 位置 | 形态 |
|---|---|
| `packages/game-service/src/rpc/game.rpc.controller.ts:84` | `as { grab?: boolean; cards?: number[] }` |
| `packages/game-service/src/game/game.service.ts:138` | `JSON.parse(data) as GameSession`（见 §11-10） |
| 各 conformance 切片的 `PlayerViewWire` 自制类型 | 如 `slice-08-bidding.ts:28-44` 自带一份 |

#### B. 运行期静默退化 —— 这些写法在 TS 里**合法**

| 位置 | 形态 | 后果 |
|---|---|---|
| `apps/client/src/pages/table/table.vue:81-86` | `watch(() => store.hand.join(','), …)` | 变 `"[object Object]"` ⇒ **指纹只剩长度**，同长度换牌不清空选中 ⇒ 用户可能把**没选的牌**发出去。**硬要求**：改为 `` cards.map(c => `${c.r}-${c.s}`).join(',') `` 或等价形状 |
| **`apps/client/src/components/Hand.vue:49`** | `indexes.sort((a,b) => (props.cards[a] - props.cards[b]) * direction)` | `Card - Card` = `NaN` ⇒ **排序静默变成「不排序」**（**v4 新增，v3 完全未提**）。**硬要求**：换成显式函数式比较器，并把花色维度写进去 |
| `tools/conformance/src/slices/slice-07.2-{security,boundary,hardening,rpc}.ts` | `sameHand` / `sorted` 用 `Number(c)` | `Number({r,s})` = `NaN` ⇒ 同长度手牌**永远「相等」**：`!sameHand(a,b)` 断言变**红**、`sameHand(...)` 正断言**假绿**。**4 个切片各有一份逐字副本**（`security:75-85`、`boundary:113-123`、`hardening:317-323`、`rpc:211-221`）—— v3 只点了 `security` 一个 |
| `packages/game-service/src/game/game.service.ts:559` | `JSON.stringify(fallback) !== JSON.stringify(first)` | 见 §4 的 C8：回填后两边类型不同 ⇒ **判重恒不等**，兜底重试必然多跑一次 |
| `apps/client/test/helpers/comment-stripping.test.ts:88-89` | 逐字拷贝源闸的 21 条禁用标识符 | 源闸删掉 `toInternalRank` / `toDouZero` 后，这份**下游拷贝**里的同名条目变**死条目**（R377 的老毛病：死条目让零命中变成假绿） |
| `apps/client/test/card-hand-interaction.test.ts:298,305` | 正则 `/toInternalRank\|toDouZero/` | 同上 |
| `tools/conformance/src/slices/slice-09-play-rotation.ts:26` | 注释描述 `createDeck` 为「`4 花色 × (3..2) + 2 王`」 | §2.5 改上界后**静默过期** |

#### C. 注释与文档过期

- **`doudizhu.md` 的「内部 Rank」收口**：`grep -rn "内部 Rank" docs/games/doudizhu.md` 当前实测 **5**（`:54 :228 :246 :418 :420`）。⚠️ v3 列的 `:436` 是「**内部编码**」**不会**被该 grep 命中 —— **判据只覆盖 5 处中的 3 处**；§1.3(`:46` 的「`2` = **15**」)、§1.4、§10 只能靠**整节重写**收口；
- **`docs/design.md`**：v3 的「一并收口」**已过期**（该文件「内部 Rank」**0 命中**）。实际待改点是 §3.6（`:343`，点名 `toInternalRank()`/`toDouZero()` 为唯一真源）与 `:1762`（C19 行）；
- 各包测试文件里的夹具注释。

#### D. v4 订正：三处该**删**而不是该改（C4 / C5 / C9）

| 位置 | v3 写的 | v4 订正 |
|---|---|---|
| `shared/src/ddz/game.ts` 的 `cardToInt` / `intToCard` | 「**简化**」 | **删除** —— 改造后生产消费者全部消失（`game.ts:83`、`play.ts:256/273`、`game.service.ts:615` 附近），测试零引用 ⇒ 留下就是**零调用的换算壳**，正是 R695 要消灭的第二套口径 |
| `shared/src/ddz/play.ts:10-25` 的 `douzeroIntToCard` | 「改为 `{r,s}` → `Card` 的**真实映射**」 | **删除** —— 与 §4 冲突：改造后 `play.ts:248` 超时分支的输入**本就是 `Card[]`**，保留一个吃 DouZero int 的适配器只能**编造花色**，会被 §3.3 的身份精确摘除拒掉 |
| `shared/src/card/card.ts` | 「文件收缩为 `Suit` 常量」 | 与同表「`rule.ts`/`autoplay.ts` 只改 `.rank → .r`」**不一致**：两文件还大量引用 `Rank.*`（`rule.ts:1,41,47-51,57,87`、`autoplay.ts:214,241,311,312`），`Rank` 一删就断。**硬要求：`Rank` 枚举保留、`Rank2` 改 17** —— 删的是「15 这套编码」，**不是 `Rank` 符号** |

#### E. v4 订正：`robot-service` 的行区间（C7）

`bot.player.ts` 实测受影响区间是 **`:139-148`**（`isPlausible(cards: number[], view)`）与 **`:150-151`**（`toCards` 用 `intToCard` 造 `Card`）；v3 写 `:137-145` **且漏了后半段**。

**文档**（见 §9.4）

---

## 4. 产出牌的路径（**v4 起补第四条**）

v1 把三条路径笼统说成「只产出点数」，**不准确**；v2 按路径分开但**漏了人类出牌**（见 ④）。v4 补全后共四条：

| 路径 | 产出 | 处理 |
|---|---|---|
| **① 机器人决策**（跨服务） | `RobotDecideResponse.cards: number[]`，**真正 rank-only** | 服务端在行动者手里为每个点数挑一张同点数的牌补花色。**挑法必须确定性**（取 `s` 最小的那张），以便断言可复现 |
| **② 超时自动出牌** | 引擎（`autoplay.ts` / `play.ts` 的超时分支）直接在**真手牌**上选牌 ⇒ **天然带真花色** | **直接用，不转换、不回填** |
| **③ game-service 本地兜底**（`ruleDecision`） | 同上，吃的是 `view.hand` | **同上** |
| **④ 人类出牌**（**v4 新增，v3 漏**） | 客户端**原样回传 `Card[]`** —— 这是**唯一由客户端提供花色**的路径 | 双入口：HTTP `game.controller.ts:102` 与 RPC `game.rpc.controller.ts:84`。两者都进 `handlePlayCards` |

**路径 ④ 为什么必须单列**：它是**唯一**客户端能指定花色的入口，也是 R697「按身份精确摘除」唯一的适用面。v3 只在 §3.3 提了它，**不在 §4 表里** —— 若按 §4 逐点核对转换点，会**整条漏掉**这条双入口校验。

**DouZero 上游结构上没有花色**（实测）：`EnvCard2RealCard` 只有 15 项、观测是 4×13 的「每个点数有几张」矩阵（`douzero/src/env.py:240`）、它自己也按值删牌（`douzero/src/game.py:170-175`）。

**`handlePlayCards(session, playerId, cards: Card[])` 只接受 `Card[]`** —— 单一入口，不设双签名。

⚠️ **C8（v4 新增，v3 未表态）：① 的回填必须落在既有的「被拒动作 == 规则引擎动作」判重**之前**，且两条路径共用同一个挑法函数。**

原委：`game.service.ts:559` 附近用 `JSON.stringify(fallback) !== JSON.stringify(first)` 判断「被拒动作是否等于规则引擎动作」。① 回填后若**回填发生在比较之后**，`first` 是 `number[]`、`fallback` 是 `Card[]` ⇒ **恒不等**；即使回填在前，若①的 `s` 由回填器决定、③由引擎从 `view.hand` 挑（同点数花色可能不同），**判重也会从「条件触发」变成「总是不等」**，兜底重试**必然多跑一次**。

**硬要求**：①与③必须走**同一个**「按 `s` 最小确定性挑牌」的函数，且回填在判重比较**之前**完成。计划里必须有一条判据证明「两者产出相同 ⇒ 判重命中」（即该重试路径**仍可被跳过**）。

---

## 5. 客户端（协议侧）

> **这份清单同样不是完备清单**——完备性由 §3.4 的方法（`tsc` 反推）保证。下面只是**已知落点 + 用来交叉核对 `tsc` 结果的对照表**。v3 的这份清单**漏了 3 个组件、2 处死条目、16 个测试文件**，v4 补齐。

**源码**

| 位置 | 改什么 |
|---|---|
| `stores/game.ts` | `view` 的三处字段变 `Card[]`；getter 纯透传 |
| `components/Card.vue` | 花色渲染（数据源 `protocol.suitSymbol` / `colorOf`）。⚠️ **`:75` 的 `:data-value="value"` 是必须写死的绑定点**——`value: number` 在 `Card[]` 下要改（传 `.r`，或让组件直接接受 `Card`）。`data-value` 全仓 **38 行 / 8 个文件**引用，是探针与既有断言的重要锚点，**不得随手改语义** |
| `components/Hand.vue` | 排序比较器加花色维度。⚠️ **并必须换成显式函数式比较器**：`:49` 的 `props.cards[a] - props.cards[b]` 在两个 `Card` 相减时是 `NaN` ⇒ **排序静默变成「不排序」**（§3.5-B）。**只按协议给的 `r`/`s` 数值**，不得调任何换算函数 |
| **`components/PlayArea.vue:22`** | **v3 漏**：prop `cards: readonly number[] \| null` 要变 `Card[]` |
| **`components/BottomCards.vue:18`** | **v3 漏**：prop `cards: number[] \| null` 要变 `Card[]`（另 `:36` 的 `<Card :value="0">`） |
| **`components/Seat.vue:92`** | **v3 漏**：`<Card :value="0" size="small" face-down />` —— 全仓 `<Card>` 调用点**仅 3 处**（`Hand.vue:57`、`BottomCards.vue:36`、`Seat.vue:92`），`Card.vue` 的 prop 一改三处都要动 |
| `pages/table/table.vue` | 出牌原样回传 `Card`；**修 `join(',')` 指纹**（§3.5-B） |

**测试**

| 位置 | 改什么 |
|---|---|
| `test/helpers/fake-socket.ts` | `playerViewFixture`（`:94-102`，默认 `hand=[3..17,20,30,3,4]`） |
| `test/source-boundary.test.ts` | 两条死条目 `:96` / `:97`。⚠️ **v4 订正**：`toInternalRank` 在该文件出现 **2 次**——另在 **`:281`** 还有一条清单，**别漏** |
| **`test/helpers/comment-stripping.test.ts:88-89`** | **v3 漏**：逐字拷贝源闸 21 条禁用标识符 ⇒ 源闸删符号后，这份**下游拷贝**变成死条目（R377 假绿） |
| **`test/card-hand-interaction.test.ts:298,305`** | **v3 漏**：正则 `/toInternalRank\|toDouZero/` 死条目 |
| `test/card-hand-interaction.test.ts:124` | 受判据迁移影响的**文本断言**（见 §6.3）。⚠️ **v4 订正**：v3 写「8 条 `it()`」，实为 **2 条**（`:124` 文本 + `:157` 的 `.card--wide` 类命中），详见 §1.2 #5 |
| **其余 16 个测试文件** | **v3 只点名 2 个**。实测**共 18 个**客户端测试文件命中手牌 / `bottomCards` / `data-value` 断言（`.length` 计数类与形状无关，不必全改）。已知会命中的：`table-hud` · `action-feedback` · `settlement-rematch` · `table-bid-bottom` · `table-settlement-ui` · `table-bid-ui` · `table-seat-geometry` · `game-store-session-reset` · `error-disposition` · `table-ended-ui` · `table-play-ui` · `serial-queue` · `snapshot-version` · `room-matched-join` · `ui-flow` · `mock-e2e` · `reconnect-flow` · `card-hand-interaction`。**以 §3.4 的 `tsc` 结果为准** |

**红线不变**：牌型 / 能否压过 / 倍数一律**不在前端算**；花色只是展示数据，**不得引入任何规则判定**。`validateOutbound` 不得因此放宽（他人手牌 / `isRobot` 的泄漏面照旧）。

> 字号提示：`Card.vue` 根节点在**源码**里是 `<button class="card">`，H5 实际渲染为 `<uni-button class="card">`（R449，`scripts/browser-e2e.mjs:330-334` 有记录）。探针按 class 锚定，结论不受影响。

---

## 6. 素材接入

### 6.1 素材实况（已实测，非转述）

> **v3 来源变更**：素材现位于**仓库根 `resources/`**（v2 写的 `reference/CardGame/Assets/Resources/` 已不存在）。
> 身份已复核：牌面 **80×104 px**、牌背 **66×88**，与 v2 实测**逐位一致** —— 是同一份素材换了位置，**无需重新核实内容**。

**全量构成实测（385 个文件 / 16.70 MB ≈ 17 MB）**：

| 类别 | 数量 | 处置 |
|---|---|---|
| `.meta`（Unity 边车） | 201 | ❌ 不拷 |
| `.prefab` / `.anim` / `.controller` / `.asset`（引擎专有） | 20 | ❌ 不拷 |
| 杂项（`.xlsx` / `.txt` / `.jpg`） | 3 | ❌ 不拷 |
| **字体**（`.ttf`） | **1** | ❌ 不拷（R705） |
| **可用媒体**（`.png` 79 / `.ogg` 78 / `.json` 3） | **160** | 从中再精选（§6.2.2） |

> **v4 订正**：v3 这张表写「可用媒体 161」且**没有 `.ttf` 行** —— 161 是把 `Fonts/ice.ttf` 偷偷算进媒体凑出来的。实测媒体 = 79+78+3 = **160**；`.ttf` 单列一行后，五个桶相加 = 201+20+3+1+160 = **385** ✅。

⚠️ **照目录拷贝会搬进 225 个非媒体文件**（占全量 58.4%）。v2 只提醒了 `.meta` 边车，**漏了 `.prefab` / `.anim` / `.controller` / `.asset`** —— v3 补齐前两类但把 `.ttf` 漏在桶外。**逐个白名单挑，不递归拷目录。**

**牌面**（`resources/Poker/`，**55 个 PNG = 54 张面 + `CardBack`**）：

- 命名两坑：**`Square` = ♦**、**`One` = A**（v4 复核：**把图片渲染出来看过** —— `SquareOne.png` 是红色方块、角标字母就是 `A`；旁证：全部 Square 数字牌**纯红 0 黑**、中心花色 180° 旋转自相似度 Square=0.931 vs Heart=0.440）。
- 命名规则：`{Suit}{Rank}.png` —— `Suit` ∈ `Spade` `Heart` `Club` `Square`，`Rank` ∈ `One`…`Ten` `Jack` `Queen` `King`。v4 复核：四个花色**各恰好 13 个点数**，无缺、无重、无多（52 张）+ 3 张非规则文件 = 55 ✅。
- 两张王与牌背：`BigJoker.png` / `LittleJoker.png` / `CardBack.png`；
- 尺寸（**v4 逐张解析 IHDR，非抽样**）：**54 张面全部 80×104**、**恰 1 张（`CardBack`）= 66×88**，无例外。面/背比例 1.30 vs 1.33，**不一致**。

**其余实测体积**（只算 png/ogg；口径 = KiB 向下取整）：`Poker` 437KB · `Identity` 98KB · `UI` 2,065KB · `Sound` 836KB · `MusicEx` 1,248KB（实测 1,249）。

> ⚠️ **`UI/` 里还有一个非 PNG 文件**：`public_bg.jpg`（21,162 B）。它在 v3 的采用清单与未采用清单里**都没有**（被 §6.1 的「杂项 `.jpg`」桶隐式包含）。v4 已在 §6.2.2 显式登记。另：v3 写的「`(2).png`」真名是 **`quxiao_loding (2).png`**。

### 6.2 落地形态

- 目录 `apps/client/src/static/{cards,av,ui,audio}/`；
- **映射表 = `static/cards/manifest.json`（R702）** —— 键 = `{s}-{r}`（承 R696 的 `{r,s}`），值 = 文件名。**必须是 `.json` 而不是 `.ts`**：用户 2026-09-20 的既定目标是「引入美术资源时直接替换图片」；表放 `.json` ⇒ **改名换图只动数据、不碰代码**，放 `.ts` ⇒ 改名即改代码。两者成本相同（Vite 编译期 `import` 该 JSON，**无运行期开销**）。
  - ⚠️ 文档必须写清：这是**资源名 ↔ 展示图片**的映射，**不是**点数 → 牌面文字的自制映射（后者由 `protocol.toDisplay()` 唯一提供，`source-boundary` 有闸）；
  - **覆盖性判据**：54 面 + 1 背**逐项存在**（§6.3）。
- **命名约定写进 `static/ASSETS.md` 作契约**：`{Suit}{Rank}.png`（§6.1）。⇒ 沿用同名交付的新图**直接覆盖文件即可，`manifest.json` 都不用改**；换名交付则**只改 `manifest.json`**。
- `static/ASSETS.md`：每类素材的来源项目、原始路径、许可/授权方与日期、覆盖范围、**命名约定**；
- **兜底**（R693）：素材缺失时回落文本牌面，避免白屏；**兜底不是第二套视觉**。

#### 6.2.1 版本库边界（R703）

**`resources/` 是源素材库，不进版本库。** 只有精选子集进库：

| 路径 | 入库 | 理由 |
|---|---|---|
| `resources/`（385 文件 / 16.70 MB） | ❌ **不进** | 源素材库。加进 `.gitignore`，并在 `ASSETS.md` 记录来源与获取方式 —— 与既有 `reference/` 同一条纪律（R694） |
| `apps/client/src/static/`（**82 文件 / 2.27 MB**） | ✅ **进** | 实际使用的子集（§6.2.2） |

⚠️ **本片开工前 `resources/` 处于「既未入库、也未忽略」的裸状态**（`git status` 显示 `?? resources/`）—— **先落 `.gitignore`**，否则每次 `git status` 都被它污染。

#### 6.2.2 精选清单（R704 裁定后的定稿）

全量 **160** 个可用媒体里，**只取 82 个 / 2.27 MB**（字节占比 **13.6%**，个数占比 51% —— ⚠️ 按**个数**说「取了一小部分」是错的，媒体里过半都要用；真正省下来的是那 225 个非媒体文件）：

| 类别 | 内容 | 数量 | 实测量 |
|---|---|---|---|
| `cards/` | 54 面 + `CardBack` | 55 | **437 KB** |
| `av/` | `Identity/{Landlord,Farmer}.png` | 2 | **98 KB** |
| `ui/` | **`new_BJ.png`（牌桌底纹）** + `btn{1,2,3}.png` + `panel-{blue,orange}.png` + `logo.png` | 7 | **219 KB** |
| `audio/` | 见 §7 的 R698 表 | 18 | **1,460 KB**（ogg 原形） |
| | | **82** | **2,267,685 B = 2.27 MB** |

> **v4 订正**：v3 写「83 个 / 2.5MB / 15%」三处都错 —— 55+2+7+18 = **82**（83 疑似把 `manifest.json` 也数了进去）；字节合计 2,267,685 B = **2.27 MB**（不是 2.5）；占比按字节 13.6%、**按个数 51%**。

**未采用**（逐类理由）：

- `UI/` 里别的玩法 / 商城 / 设置界面素材共 **16 个**（= `UI/` 非 `.meta` 文件 23 个 − 采用 7 个）—— `kuaisu_choose.png`(625KB)、`hlddz.00045.png`(381KB)、`bg.png`(328KB)、`Common_BG4_2x.png`(236KB)、`setting.png`(146KB)、`jujsidai.png`(39KB)、`jishianniudi.png`(25KB)、`nongmin2.png`(19KB)、`huanledou.png`(16KB)、`goods_BG2.png`、`dou.png`、`default.png`、`buy_btn_06.png`、`close_btn.png`、`quxiao_loding (2).png`、**`public_bg.jpg`(21KB)** —— **MVP 界面用不到**。
  > **v4 订正**：v3 写「15 个」且把 `public_bg.jpg` **整条漏了**（它在采用与未采用清单里都没有）。它是 `UI/` 里**唯一的非 PNG 图片**；v3 写的「`(2).png`」真名是 `quxiao_loding (2).png`；`nongmin2.png` 实测 19KB（v3 写 20KB）。
- **50 条**出牌播报音效（`Woman_3`…`Woman_tuple15`、含 `Woman_100`/`Woman_200` 大小王单张）—— 见 §7「不做牌型播报」；
- `Woman_jiabei` / `Woman_bujiabei` / `Woman_Share` / `Sound/Chat/Chat_1–7` —— 见 §7「存在但不用」。

**字体 `ice.ttf` 本轮不采用（R705）**：实测 **1,958 KB**（比全部 55 张牌面加起来还大 4 倍），且 v2 已标注其上游为**字魂商业字体**。**本轮用系统字体**；要用它须先确认授权范围覆盖字体，**届时另立一片**。

#### 6.2.3 前置实测（交接 P2 要求）

**⚠️** `<image src="/static/...">` 与**运行时拼接路径**在 H5 / App 两端各解析一次。uni-app 的静态资源路径解析是本片最容易白干一天的坑，**放在素材侧第一个 Task 的前置步骤**。

#### 6.2.4 体积预算

| 类别 | 预算 | 实测 | 余量 |
|---|---|---|---|
| `cards/` | ≤ 500KB | 437 KB | +63 KB |
| `av/` | ≤ 100KB | 98 KB | +2 KB |
| `ui/` | ≤ 400KB | 219 KB | +181 KB |
| `audio/` | ≤ 800KB（转 mp3 后） | 1,460 KB（ogg 原形） | ⚠️ **靠转码达标，必须实测** |

> **R704 的来由**：v2 §6.4 把 `bg.png`（328KB）**与** `new_BJ.png`（177KB）并列作牌桌底纹，而 §6.2 的 `ui/` 预算只有 400KB。
> ⚠️ **v4 订正表述**：v3 写「两个都拿必然超（547KB）」——字面像 `328+177=505`。**547 只有按 `bg` 加进整个 `ui/` 清单才成立**（其余 6 个文件 219KB + bg 328KB = 547KB）。数字对、句子易误读。
> 用户 2026-09-20 裁定用 **`new_BJ.png`**，`ui/` 落到 **219KB**。

⚠️ **`audio/` 是唯一需要转码才达标的类别**：ogg 原形 1,460 KB，约为预算的 1.8 倍。**转 mp3 的压缩率必须实测并记入计划**；若转码后仍超 800KB，按 §7 的表**从低优先级项往上砍**（`MusicEx_Exciting` / `openinganimation` 是 BGM 里最可能让位的两条）。

**断言的分母要写清**：是 `dist/build/h5/static/` 的**整目录**，不是「首屏依赖图」。App 端的阈值由素材侧计划在首次构建后按实测定。

### 6.3 牌面接入与**判据迁移**

`Card.vue` 换 `<image>`：**根节点仍是 `<button class="card">`**、`data-value` 保留（**探针锚点零改动**）、`toDisplay()` 退居 `aria-label`。

**判据迁移（v1 漏了）**：`apps/client/test/card-hand-interaction.test.ts` 里断言 `.card__corner` / `.card__center` **文本**与 `.card--wide` 命中的用例，换 `<image>` 后**断言对象消失**。这组断言的实质是 **F10「牌面文字只能来自 `toDisplay`」的机械保障**，删掉不补 = 该保障在客户端只剩关键字扫描。

> ⚠️ **v4 订正（详见 §1.2 #5）**：v2/v3 写「`:127-166` 有 **8 条 `it()`**」——**错**。该文件全文件确为 8 条，但分布在 `:124 :157 :173 :194 :239 :259 :290 :323`；`:127-166` 只是前后两条的断言行区间。**真正受判据迁移影响的只有 2 条**：`:124`（文本断言）与 `:157`（`.card--wide` **类命中**，不是文本，且 v3 自己说 `.card--wide` 去留待定）。**v3 把「文件总 `it()` 数」当成「受影响数」，把工作量夸大了 4 倍。**

**替代判据**：`aria-label === toDisplay(r)` + 映射表**覆盖性**（54 面 + 1 背逐项存在）。`.card--wide` 的去留在素材侧计划里表态。

### 6.4 桌面 / 座位 / 面板 / 头像（**v1 只有一行事实描述，此处补齐**）

| 界面 | 素材 | 组件归属 | 验收 |
|---|---|---|---|
| 牌桌底纹 | **`UI/new_BJ.png`**（R704：**只用这一张**；`bg.png` 不采用，理由见 §6.2.4） | `table.vue` 的容器背景 | 探针锚点不变 |
| 按钮 / 面板 | `UI/btn{1,2,3}.png`、`UI/panel-{orange,blue}.png`（126×126 9-slice） | 抽出共用组件（**必须自持样式**，见 §9.2-4） | 令牌先加后用 |
| 座位头像 | `Identity/{Landlord,Farmer}.png` | `Seat.vue` | 探针锚点不变 |

**9-slice 的实现形态**（`border-image` 还是 `<image>` + 绝对定位）在**素材侧计划**里定——本规格只要求「选定一种并写进计划」，不留悬空。

### 6.5 顺带修两条（拆解报告点名，零协议改动）

1. **座位卡字段权重**：张数应**重于**名字——现在是反的（`Seat.vue:179` 名字 `$ftl-font-md` 28rpx > `:188` 张数 `$ftl-font-sm` 26rpx）；
2. **报单 / 报双预警**：`cardCounts ≤ 2` 时的视觉预警。数据现成（`PlayerView.cardCounts`）。

---

## 7. 音效（R698）

**只做素材里真实存在的那批**。v1 的清单**不完整**，v2 按实测补齐并逐条表态：

| 事件 | 用 | 备注 |
|---|---|---|
| 叫 / 不叫 | `Woman_Order` / `Woman_NoOrder` | **参考实现自己的接线就是这两个**（`resources/Config/AudioConfig.json` 的 `callLandlord` / `notCallLandlord`；⚠️ v4 订正：v2/v3 引的 `reference/CardGame/Assets/Script/DataType/Config/AudioConfigSO.cs:67-68` **该路径已不存在**）。比 v1 写的 `Woman_Rob1–3` 更贴 |
| 抢 | `Woman_Rob1–3` | 存在；参考实现未接线 |
| 过牌 | `Woman_buyao1–4` | 存在（在 `Sound/Fight/`，**不在** `Sound/Chat/`） |
| 报单 / 报双 | `Woman_baojing1` / `Woman_baojing2` | 存在 |
| 胜负 | `MusicEx_Win` / `MusicEx_Lose` | 存在（在 `Sound/Fight/`） |
| BGM | `MusicEx_Normal` / `Normal2` / `Welcome` / **`MusicEx_Exciting`** / **`openinganimation`** | v1 漏了后两条 |
| **存在但本片不用** | `Woman_jiabei`（加倍）· **`Woman_bujiabei`（不加倍）** · `Woman_Share` · `Sound/Chat/Chat_1–7` | 我方规则**没有加倍 / 超级加倍**；`Chat_*` 是聊天音，本片无聊天功能。**登记为「存在但不用」，不是漏掉**。⚠️ **v4 订正**：`Woman_bujiabei` 原只出现在 §6.2.2 的未采用清单里、**§7 表漏了它**（两处不一致），v4 并入本行 |

**不做**（素材里确实没有）：发牌、结算、春天、倒计时紧迫。

**不做牌型播报**：`Sound/Fight/` 共 **66** 个 ogg，其中 **2** 个是 `MusicEx_Win/Lose`，**64** 个 `Woman_*` 里只有 **50 条**是出牌播报。

> ⚠️ **v4 订正两处**：
> ① v2/v3 写「**48 条**」—— 实测应为 **50**（`64 − 14`；14 = `Order` `NoOrder` `Rob1–3` `buyao1–4` `baojing1–2` `jiabei` `bujiabei` `Share`）。口径：50 = 单牌 15 + 对子 13 + 三张 13 + 具名牌型 9。
> ② **`Woman_100` / `Woman_200` 在 v2/v3 全篇零提及** —— `AudioConfig.json` 里它们是 `singleLK` / `singleBK`，即**大小王单张的出牌播报**，**属于「出牌播报」这一类，不是垃圾文件**。
>
> ⚠️ **漏登是有代价的**：下面说「48/50 条出牌播报要做得先加一条裁决」，但 `Woman_100`/`Woman_200` 是**单张**出牌——`LastPlayedHand.type` 对单张的判定本来就有、**不需要新裁决**。将来若要做出牌音效，**这两条可以先行**，不必等裁决。

它是**出牌音效**的唯一素材来源，但触发需要知道牌型——`LastPlayedHand.type` 虽已在协议里，客户端拿它查「编号 → 音效」的本地表会撞上 M09（前端不得含牌型字面量）与 `source-boundary` 的禁词表（`HandType` 在列）。**要做得先加一条裁决。**

**实现**：`uni.createInnerAudioContext()` + 开关与音量持久化 + OGG→mp3（**用系统 `ffmpeg` 的脚本，不进依赖**）。

**实现**：`uni.createInnerAudioContext()` + 开关与音量持久化 + OGG→mp3（**用系统 `ffmpeg` 的脚本，不进依赖**）。

---

## 8. 动效

参考 `dsh-doudizhu` 的清单（`reference-ui-teardown.md` §1「动效清单」逐条可搬）：发牌错峰、翻底牌、出牌入场、结算弹窗，统一 `cubic-bezier(.22,1,.36,1)`。

**必须**：`prefers-reduced-motion` 降级（参考实现有现成形态）。

---

## 9. 验证与门禁

### 9.1 范围与每 Task 门禁（R689 / R701）

**范围 = H5 + App**。小程序端排除在**一切设计、开发、测试**之外：不删代码、不做任何适配、不入任何门禁、不为它写用例（R701）。

**每 Task 门禁 = H5 build + 真浏览器探针 gate + `build:app` 绿**。

### 9.2 不许破——**照抄交接文档 §4 的 10 条**（v1 只搬了 6 条半，此处补全）

1. **锚点零改动**：9 个探针 class + `scripts/browser-e2e.mjs` 不改；**判据只增不减**（8 个契约测试的字面 `it(`/`it.each(` 计数基线 **65**——注意口径：**只数 `it(` 是 63**，65 含 2 条 `it.each(`）。
2. **样式只用令牌**（`$ftl-*`）：改素材/尺寸**先加令牌再用**；`ui-tokens` 闸禁组件里的 hex/px（图片路径不受影响，但尺寸仍须令牌/rpx）。
3. **H5 + App 能力**（⚠️ v4 订正：v2/v3 照抄交接文档写的「**三端**能力」**已过期**，与 §9.1 + R701 + §10 三处的「小程序排除」矛盾；条文内容本身在 H5+App 下仍成立）：`uni.xxx()` 直接成员调用（闸：`uni-api-access`）；不得 `document`/`window`/`fetch`；不得 `typeof import.meta`（闸：`import-meta-guard`）。
4. **scoped 样式只到子组件根节点**：把按钮/元素抽进子组件后**必须自持样式**（上一片 ➏ 的 Important 回归）；已上机械闸（渲染 `class="btn` 的组件必须自持 mixin + 主色）。
5. **模板注释只能放单根元素内部**（放根前 ⇒ 组件变多根、`classes()` 返回 `[]`）；已上单根闸（含 `lobby`/`login`/`table`/`Settlement`）。
6. **牌桌区源码与注释里禁止 `×` 紧跟数字**（`table-bid-ui` 有一条遗留 raw 判据）；**不得逐字写注释定界符**（`comment-stripping` 的 C1 守卫会红）。
7. **`mount()` 把 SFC 样式完整注入 jsdom 且不做 scope 过滤** ⇒ 行为判据**看不见**「样式丢失/观感」类问题 ⇒ 观感类改动只能用**产物 CSS / 真浏览器 / App 走查**，**不要造假判据**。
8. **门禁口径**：`turbo run build --force` 对 client **只出 h5** ⇒ App 必须 `pnpm --filter @fight-the-landlord/client build:app` 单独跑；探针**独占**跑（8 容器 healthy + `DEL ratelimit:ws-conn:::ffff:172.19.0.1` + 清残留 vite；`kill -TERM -<pgid>`，**禁止** `pkill -f vite`）。
9. **证据卫生**：门禁日志的 mtime 必须**晚于**最后一次改动/commit（R682）。
10. **提交**：每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`；**禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

### 9.3 新增判据（R697 的新行为，v1 漏了）

R697 是本片**唯一的新服务端行为**，必须带判据 + **探针判别力自证**（R115/R150）。新增正负对照：

- 送一张 `(r, s)` **不在手里**的牌（同点数不同花色）⇒ 拒（13001）；
- 送两张**完全相同**的 `(r, s)`（手里只有一张）⇒ 拒；
- 合法的「两张同点数不同花色」⇒ 接受，且手牌**精确减少两张**。

### 9.4 文档收口（R695 的规格变更）

`doudizhu.md` 里规定「双编码」的**不只 §1.3 / §1.4 / §10**。v2 补列了两处规范条款，**v4 复核后订正了口径**：

| 位置 | 现状 | grep 命中？ |
|---|---|---|
| `docs/games/doudizhu.md:228`（§5） | 「**比较一律使用内部 Rank**（§1.4），不得使用 DouZero 编码。」 | ✅ 逐字命中 |
| `docs/games/doudizhu.md:246`（§6.1 第 5 步） | 「`keyRank` 取**内部 Rank**（`2` = 15，§1.4）」 | ✅ 逐字命中 |
| `docs/games/doudizhu.md:436`（§11 表） | 「点数大小与**内部编码**」——措辞级 | ❌ **不命中**（是「内部编码」不是「内部 Rank」） |

**当前实测**：`grep -rn "内部 Rank" docs/games/doudizhu.md` = **5**（`:54`（§1.4）· `:228` · `:246` · `:418` · `:420`（§10））。

> ⚠️ **v4 订正三处**：
> ① **判据覆盖不全** —— 上表 3 行里 `:436` **不会**被这条 grep 命中；`§1.3`（`:46` 的「`2` = **15**」）也**不含该字样**。⇒ 判据只能抓 5 处中的 3 处，**§1.3 / §1.4 / §10 必须靠「整节重写」收口，不能只靠 grep**。判据可保留（它仍抓得住 `:228`/`:246`/`:54`/`:418`/`:420`），但**不得**把它当作收口完成的条件。
> ② 「`docs/design.md` 涉及「内部 Rank」的表述一并收口」**已过期** —— 实测 design.md 该字样 **0 命中**。它真正的待改点是 **§3.6（`:343`，点名 `toInternalRank()` / `toDouZero()` 为唯一真源）** 与 **`:1762`（C19 行）**。

**收口判据（v4 修正后）**：`grep -rn "内部 Rank" docs/games/doudizhu.md` = **0**，**且** `doudizhu.md:46` 与 `:436` 经人工确认已改写（这两处不含该字样，grep 抓不到）。文档没有机械闸，漏改是静默且永久的。

**交接 P6 的其余三项**（v1 没给落点，此处补）：

| 项 | 落点 |
|---|---|
| `2026-09-17-game-ui-redesign-design.md` §7-①（简约纸牌风/零素材）改为素材版 | 素材侧计划的收口 Task |
| 该 spec §1 硬边界加「素材只能来自 `static/` + 必须 `ASSETS.md` 溯源 + 体积预算闸」 | 同上 |
| `agent-briefs.md` 的三端纪律改为 **H5 + App**、小程序状态改写 | 同上（`agent-briefs.md:224-225` 现仍写着「待确认 (甲)/(乙)」，也已过期） |

### 9.5 总门禁

`pnpm run ci` 六阶段 + conformance **13 条切片全绿**（形状改、强度不降）。

---

## 10. 明确不做 / 另立一片

| 项 | 处置 |
|---|---|
| **牌面素材重制到 ≥160×208** | **另立一片**（R699） |
| 牌型播报（50 条出牌播报） | 不做。需服务端下发牌型标识，或一条新裁决。⚠️ **例外**：`Woman_100`/`Woman_200`（大小王**单张**）不在此列 —— 单张的牌型判定现成，**将来可先行** |
| **字体 `ice.ttf`** | **本轮不采用**（R705）：1,958KB + 字魂商业字体授权存疑。用系统字体；要用另立一片 |
| `Woman_jiabei` / `Woman_Share` / `Chat_1–7` | 存在但不用（规则里无加倍；本片无聊天） |
| 小程序端的**一切**（适配 / 测试 / 门禁 / 设计） | **排除**（R690 + R701）；代码**保留冻结，不删** |
| App 端运行期验证（N39） | 不在本片 |
| 跨包注释剥离实现收敛（N46） | 不在本片 |
| 真牌堆 / 记牌器等花色衍生玩法 | 不在本片（花色先只做**展示**） |

---

## 11. 风险与已知代价

> **v4 说明**：本节 10 条经独立复核**全部仍成立**，但 **7 条的措辞或数字需订正**（逐条标出）。另**新增第 11 条**。

1. **R695 是规格变更**，牵连 `doudizhu.md` + `design.md`。**代码与文档必须同一个 PR**。
   ⚠️ **v4 订正**：`doudizhu.md` 的「内部 Rank」实测 **5 处**（`:54 :228 :246 :418 :420`），另 `:46` 与 `:436` **不含该字样、须人工改写**。`design.md` 的「一并收口」**已过期**——该文件该字样 **0 命中**，真正的待改点是 **§3.6（`:343`）** 与 **`:1762`**。
2. **`createDeck()` 的循环上界**（§2.5）—— 本片唯一的数值地雷。
   ⚠️ **v4 订正两处**：① v3 写「`tsc` 抓不到」并归为 `[人盯]`——`tsc` 抓不到成立，但**单测立刻能抓**（`card.test.ts:37-40` 的 `expect(deck).toHaveLength(54)`）⇒ **不得按「靠人盯」处理**；② v1–v4 原文规定的解法（「上界改 `RankA`」）**是错的**，它会丢四张 2（50 张）。**执行期实测抓出**，正确形态是「3..`RankA` 循环 + 2 与王各自单 push」，详见 §2.5 的订正表。
3. **`source-boundary` 的死条目** —— 删函数后禁词表变假绿（R377 的教训）。
   ⚠️ **v4 订正**：不是「**两条**」。`toInternalRank` 在该文件出现 **2 次**（`:96`、**`:281`**）；另有 **2 处下游拷贝**同样会变死条目 —— `test/helpers/comment-stripping.test.ts:88-89`、`test/card-hand-interaction.test.ts:298,305`。**共 4 处要处理。**
4. **`table.vue` 的 `join(',')` 指纹退化**（`tsc` 与闸都抓不到）⇒ 会导致「把没选的牌发出去」。修法见 §3.5-B。
5. **【v4 新增】`Hand.vue:49` 的排序静默失效** —— `indexes.sort((a,b) => (props.cards[a] - props.cards[b]) * direction)`，两个 `Card` 相减是 `NaN` ⇒ **排序变成「不排序」**。`tsc` **与**现有闸都不报（§3.5-B）。
6. **`features.ts` 的投影边界** —— `RobotFeatures` 必须保持 rank-only。
   ⚠️ **v4 订正措辞**：这是**前瞻风险**，**不是既有代码事实**。实测 `buildPublicFeatures()` 今天**没有任何投影**（`:62/:66/:75` 直接透传，因为今天 `cards` 本就是 DouZero int）。风险是「改形状后**必须新增** `.map(c => c.r)`，而**漏 map 时 `tsc` 不报**」。
7. **`tools/conformance` 的影响面** —— 碰卡牌形状的切片实测**恰好 9 个**。
   ⚠️ **v4 订正两处**：① §3.4 原只点了 **8 个名字**，**漏 `slice-07.2-rpc`**（`:211-221` 定义 + `:671,678,718-719,727-732` 使用）；② `sameHand`/`Number(c)` 的**运行期退化是 4 个切片**（`boundary:113-123`、`hardening:317-323`、`rpc:211-221`、`security:75-85`），**不是 1 个**。
8. **测试适配量** —— 性质是**改形状不降强度**。
   ⚠️ **v4 补口径**：`shared` = **143**（**整包**口径，含 `shared/test/`；只算 `src/**` 则是 **138**）。⚠️ **再订正一处**：§3.4/§6.3 原写客户端 `card-hand-interaction.test.ts` 有「8 条受影响」，实为 **2 条**；客户端共 **18 个**测试文件会命中（不只是点名的 2 个）。
9. **同名类型**：`protocol.Card` 与 `shared.card.Card` 撞名 —— v2 已定：后者**退役**，全系统用 `protocol.Card`。（v4 复核：`protocol/src/**` 今天**不存在**名为 `Card` 的类型 ⇒ 撞名是本次改动**新增** `protocol.Card` 后才发生，符合预期。）
10. **出牌观感的残余**：人类玩家的出牌是精确的（R697）；**机器人**的出牌花色由服务端确定性挑出 —— 机器人无意图，无人可察觉。
    ⚠️ **v4 订正措辞**：**今天没有**「按 `s` 最小挑」的代码，那是本片要新增的。**落点已存在且自洽**：`game.service.ts:520` `driveOneRobotTurn` → `:559/:568` `ruleDecision` → `:576` `commitRobotDecision` → `:670` `applyDecisionToSession`；今天的 int→Card 换算只在 `ruleDecision:613`。⚠️ 挑法**必须与 §4 的 ③ 共用同一个函数**（见 §4 的 C8）。
11. **Redis 兼容**：`loadSession()` 是裸 `JSON.parse(data) as GameSession`（实测 `game.service.ts:134-143`，`:138` 即该行，**无形状校验**）⇒ 读到旧形状**不报错**，而是在视图构建 / `validateOutbound` 处抛错 ⇒ 该房所有动作 **500**。**处置**：部署时 `DEL game:session:*`（或等 3600s TTL）。

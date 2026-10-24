# 片③「牌桌」实施计划（阶段 A 纯后端 / 阶段 B 界面）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把牌桌按参考图 3/4/5/6 重做（顶栏瘦身 · 动作区进中央 · 叫抢有阶段感 · 桌面留最近两手 · 场次名与底分上桌），分两段交付：**阶段 A 只动协议与服务端**（做出来什么都看不见，但可独立验收），**阶段 B 才动界面**。

**Architecture:** 前端仍是**哑终端**（`docs/design.md` §12）。阶段 A 的核心是一条**破坏性的出站裁剪改动**：`PlayerView` 的 `lastPlayedHand` / `lastPlayerIdx` 退役，换成窗口为 2 的 `recentActions`（「不出」也占一手）。它**只在出站面上破坏** —— 规则态（`GameSession.lastPlayedHand` / `lastPlayerIdx`）**一个字不动**，`recentActions` 由 `view.builder` 从既有的 `actionLog` **派生**。阶段 B 是牌桌页的结构重排，把动作区从中段下方的手牌浮层搬进中央。

**Tech Stack:** NestJS（game / robot / room 服务）· TypeORM · Redis · TCP RPC · Vue 3 `<script setup>` + SCSS（uni-app CLI）· Pinia · vitest + @vue/test-utils（jsdom）· 零依赖 CDP 真浏览器探针（`scripts/browser-e2e.mjs`）· conformance 真栈切片（`tools/conformance`）。

---

## Global Constraints

以下每条都是**逐字**从规格/上位规格抄来的硬约束，每个任务的实现都必须满足：

- 🔴 **前端是哑终端**（`docs/design.md` §12）：只依赖 `@fight-the-landlord/protocol`；**绝不** `import @fight-the-landlord/shared`；**不含任何规则常量**（底分/倍数/牌型 —— M09）。`apps/client/test/source-boundary.test.ts` 必须一直绿。
- 🔴 **`lastPlayedHand` / `lastPlayerIdx` 退役的只是 `PlayerView` 上的两个字段**，`GameSession` 的同名字段与 `LastPlayedHand` **类型**都留着（规则态、`shared/ddz/types.ts:1` 仍在 import 它）。**不得**顺手把它们从 shared 删掉。
- 🔴 **`recentActions` 只能有一处实现**（`view.builder` 的投影）。**不得**再写第二份（mock 对局也必须复用或同形实现）。
- 🔴 **跟牌目标不得重新解析 `cards` 反推**（`play.ts:68` / 玩法 §5 要点）：`type`/`keyRank`/`length` 只能来自持久化字段。
- 🔴 **视觉语言照抄上位 §5.2.1**：半透明面板 `rgba($ftl-color-night, .62)` · 面板描边 `$ftl-hairline` 实线 `$ftl-color-night-deep` · 面板圆角 `$ftl-radius-lg` · 主按钮 = `background: $ftl-color-gold` + 描边 `$ftl-color-gold-deep` + 白字（**不带贴图** —— `background-image: url($ftl-btn-plate-primary)` 与 `background-size` **必须一并删掉**）· 次按钮 = 透明底 + `$ftl-hairline` 实线 `$ftl-color-night-soft` + 白字 · 幽灵按钮 = 透明底 + `$ftl-hairline` 虚线 `rgba($ftl-color-on-primary, .45)` · 面板内标签字 `rgba($ftl-color-on-primary, .75)` · 深色底上的错误文字 `$ftl-color-danger-on-dark` · 大标题白字 + 多层 `text-shadow` · 分段/选中控件 = 槽底 `rgba($ftl-color-night-deep, .55)` + 项透明底/hairline 实线 `$ftl-color-night-soft`/字 `rgba($ftl-color-on-primary, .75)`、选中 = 描边 `$ftl-color-gold` + 底 `rgba($ftl-color-gold, .18)` + 字 `$ftl-color-gold-light` + 700。
- 🔴 **机械闸（`apps/client/test/ui-tokens.test.ts` 一直绿）**：尺寸一律 `px`（**禁 `rpx`/`em`/`rem`/`vw`/`vh`/`pt`**）· 描边一律 `$ftl-hairline`（**禁手写 `1px`**）· 除 `src/uni.scss` 外**禁裸十六进制色值** · `line-height` 用**无单位**数值 · 每个 `.vue` 必须有一个 `<style lang="scss">` 块（**空块也要留着**）。
- 🔴 **`uni.scss` 里不得出现 `baseScore` / `multiplier` / `底分` / `倍数`**（M09 保留词闸，`ui-tokens.test.ts:174`）。新增槽名与令牌名必须避开。注释里可以照常写中文（注释被剥离）。
- 🔴 **组件样式里不能用 SCSS `@use`** —— uni-app 把含 `@mixin` 的 `uni.scss` 前置到每个 scss 块 ⇒ 只能 `@import`。
- 🔴 **模板注释必须在根元素「内部」**：写在根元素**之前**会让 SFC 变成 fragment root，`@vue/test-utils` 的 `classes()` **静默**返回 `[]`（`table-hud.test.ts` 的单根闸盯着）。
- 🔴 **`uni.xxx(...)` 必须是直接的成员调用**（不要 `const api = uni`）。机械闸 `test/uni-api-access.test.ts`。
- 🔴 **不得在 UI 层新造时钟**：牌桌区（`TABLE_AREA` 的 10 个文件，含 `table.vue`）**禁 `setTimeout` / `setInterval`**（R675）。页面唯一允许的时钟是 `composables/useCountdown`。中央倒计时**必须复用**它。
- 🔴 **`docs/design.md` v4.3 是唯一依据**；`newdocs/` 是未实施的岔路（用户视为误导）。小程序不在范围内（H5 + App）。
- **提交纪律**：每个任务结束提交一次；提交信息结尾逐字加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **Windows 本机**：改服务端源码要 `docker compose build <svc>` + `up -d`（**宿主 dist 挂载已删**，不再有「先宿主 build」那一步）；`docker compose exec mysql` 改中文必须带 `--default-character-set=utf8mb4`；Windows Git Bash 碰容器内路径要 `export MSYS_NO_PATHCONV=1`。
- 🔴 **改任何锚点前先 grep 谁依赖它**（本片最重的一条纪律，见 §0）。

---

## §0. 🔴 全片最重的三条

### 0.1 协议 ④ 是**破坏性**改动 —— 排期不能「先 A 全做完，再 A 验收」

一改 `PlayerView` 的字段，全仓 `tsc` 立刻红（夹具、索引类型、conformance 的手写线格式全都指向那两个字段）。**所以 A 段内部必须按「先加法、后替换」排**：

| 顺序 | 任务 | 为什么这么排 |
|---|---|---|
| ① | **Task A1**：加法三项（`baseScore` · `bidPhase.kind` · `bidPhase.decisions`） | 纯加法 ⇒ **不破坏任何既有夹具** ⇒ 每个任务结束 `ci` 仍绿 |
| ② | **Task A2**：破坏性替换（退役两字段 → `recentActions`）+ 全仓编译面 | 这一步**必然**大范围打红，集中在一个任务里做完 |
| ③ | **Task A3**：`RobotFeatures.lastMoveMeta` + 两个读点 | 它是 ④ 的连带面；A2 之后机器人**拿不到跟牌目标** ⇒ 必须紧跟 |
| ④ | **Task A4**：conformance 09/10/11 · **Task A5**：文档面 + 死脚本 · **Task A6**：阶段 A 验收 | 收口（⚠️ 2026-09-29 订正：原文写「A4 mock · A5 conformance · A6 文档面 · A7 验收」—— **A7 不存在**；mock 对局实际是 **A2 的 Step 9**） |

🔴 **执行期订正（2026-09-28 · A2 落地时）**：上面 ②③ 的分工**建立在一个错误前提上**。
原文写「中间态是机器人拿到 `undefined` 去决策，**不报错、只乱出牌**」—— **不成立**：
`bot.player.ts:94` 与 `game.service.ts:621` 是从 `view.lastPlayedHand` 取**跟牌目标**的，
删掉那个字段它们是 **`tsc` 硬错**，A2 的 lint/build 阶段当场红。

⇒ **「删掉跟牌目标」与「给机器人新输入」本来就是同一件事**，我错误地把它拆成了两个任务。
**用户裁决（2026-09-28）：A2 与 A3 的工作合成一个原子提交**（A3 做完后 squash），
理由是一个原子提交才是这件事真实的形状；两个任务的实现与报告各自保留。

⚠️ 由此得到一条**可复用的判断法**：拆任务时，「删掉 X」与「给 X 的消费者新来源」要问一句
**「中间那一刻它能编译吗」**——不能编译的拆分不是拆分，是制造一个红提交。

## §0.5 真浏览器探针在**本机（Windows）**的咒语（照抄即可）

探针有三处已知可移植性问题（**都有绕法**，2026-09-21 实测）：

```bash
# 1) 自己起 dev server（后台）——探针自起 server 的 spawn('pnpm') 缺 .cmd 后缀会 ENOENT
cd apps/client && pnpm dev &
# 2) 等它就绪
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/   # 期望 200
# 3) 带 CHROME_BIN + 非保留端口（9333 落在 Windows 保留区间 9272–9371 ⇒ WSAEACCES）
cd /d/Code/pokergame
CHROME_BIN="C:\\Users\\Yobee\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe" \
  node scripts/browser-e2e.mjs --no-server --cdp-port 18800
```

⚠️ **不要用 `| head` 截它的输出**（SIGPIPE 会把探针腰斩）—— 要留证据就 `tee` 到文件。
⚠️ 首跑可能红在 `[01 探针自身未抛异常]`（`webSocketDebuggerUrl`）—— **已知启动竞态**；复跑一次，
但必须**如实记成「首跑红 / 复跑绿 ⇒ 未复现」**，不得写成「通过」。
⚠️ 改过服务端源码 ⇒ **先 `docker compose build <svc>` + `up -d`**，并**自证新代码在镜像里**
（`docker compose exec -T <svc> sh -c "grep -c <新符号> <dist 路径>"`）—— 常驻容器可能是旧镜像，
会让真后端判据变成**空测**。

⚠️ **A2 与 A3 之间不得插入别的任务** —— 那段中途机器的 `bot.player.ts` 会拿到 `undefined` 的 target（表现为机器人乱出而不是编译错，**最危险的一类**）。

### 0.2 真浏览器探针与四张牌桌测试是**锚点集合**

`scripts/browser-e2e.mjs` 硬编码这些锚点：`.table__bar .btn`（**逐字「返回大厅」**）· `.table__me .card` · `.table__notice` · `.table__bid-grab` · `.table__play` · `.table__pass`。它们是**探针与 4 个测试文件共用的稳定 class**（R107/R647/R660）。

🔴 **本片允许改锚点，但每一个都要先 grep、再逐条写明改法与理由**（片② 的教训：规格「只列了 2 处依赖，实际 4 处」）。**允许改的只有一处**：`canPass` 的读数字段（Task A2 改、Task B8 复核真跑）。**其余锚点一个不改** —— 位置变、可点性不变（探针走 DOM `.click()`，不受视觉遮挡影响）。

### 0.3 「我出的那一手」与两个 `PlayArea` 实例

- 🔴 `.table__me .card` **必须只数得到手牌**（R660，探针数它 ≥ 17）。我出的那一手是 `.table__me` 的**兄弟槽**（`table.vue:463-470` 的既有注释），**不得**放回 `.table__me` 内。
- 🔴 窗口 2 ⇒ **最多两个 `PlayArea` 实例**。`action-feedback` 用的是文档级后代选择器（`.table__play-area .table__played .card` / `.table__play-area .table__muted`）⇒ 两个实例下会数到**两处之和**。**这一条在 Task B2 里单独成一个步骤**，别混进样式改动。

---

## §0.4 执行期订正（2026-09-28 · Task A1 落地时抓出来的，**回填进本计划**）

> 本仓纪律：**控制者自己的文本是最大缺陷来源**。这四条都是本计划原文的错误，如实回填，
> 免得后面 15 个任务照着错文本做。

| # | 原文（错） | 实测 | 处置 |
|---|---|---|---|
| 1 | 「跑 `pnpm run typecheck`」（5 处） | 本仓**没有** `typecheck` script（`ERR_PNPM_NO_SCRIPT`） | 已全文改为 `pnpm run lint`（turbo run lint = 各包 `tsc --noEmit` / client `vue-tsc`，**含 `tsconfig.test.json` 的测试面**） |
| 2 | A1 Step 9 的测试代码把信封写成 `version: 1` | `view()` 夹具的载荷是 `version: 3` ⇒ `validateOutbound` 的「载荷 version 必须等于信封 version」**先抛** ⇒ 那三条用例的**正例恒红**（不是「先红后绿」，是**永远不可能通过**） | 已修（3 处 `1 → 3`，语义零改变）。**教训：判据代码也要实测跑红一次** —— 「恒红」与「正确的红」长得像，但前者会把实施者逼去改实现 |
| 3 | A1 Step 8「`view.builder.test.ts` **不在** tsc 的 include 内」 | 那是**它自己 `:22-24` 的陈旧注释**；`tsconfig.test.json` 会编译 `test/**` ⇒ 该文件的缺键是**编译期**报出来的 | 已订正原文。⚠️ 顺带记一条**真教训**：外层对象字面量带 `...over` / `...base` **展开**时，TS **不报**缺失的必填键 ⇒ **补夹具不能只认 tsc，必须跑全套判据**（本轮有 20 个夹具/判据文件，tsc 只抓到一部分） |
| 4 | 规格 §2.4/A1 Step 4 说 `types.ts:62` 有「与 `PlayerView.lastPlayerIdx` 同名同义」 | 那句**不在** `types.ts`，实际在 **`docs/design.md:487`** | 已订正原文；design.md 那句属 **Task A5** 的文档面 |

🔴 **给 Task A2 的一个已知接口**（A1 落地时新增）：`packages/game-service/test/game.controller.test.ts` 有一条
**「出站视图的精确键集」**断言，A1 给它加了 `'baseScore'` ⇒ **A2 删两字段、加 `recentActions` 时
必须再改它一次**（预期内，不是回归）。

### §0.4.1 Task A2 落地时又抓出的六处（**其中一条是 flaky，很重**）

| # | 原文（错） | 实测 | 处置 |
|---|---|---|---|
| 5 | A2 Step 1 的 `import { dealCards, createSession, GameState } from './game'` | `game.ts` **不 re-export** `GameState`（它在 `./types`）⇒ 运行期 `undefined`、`tsc` 硬错 | 改从 `./types` 导入 |
| 6 | A2 Step 1 的 `function playingSession() { … }`（**无返回类型注解**） | 对象字面量把 `lastPlayedHand` 窄化成 `null`、`actionLog` 窄化成 `never[]` ⇒ `GameSession` 不可赋值 ⇒ **20 处 `TS2322`** | 加 `: GameSession` 注解 |
| 7 | A2 Step 1 未使用的 `import { bidKindOf }` | `noUnusedLocals` 硬错 | 删掉 |
| 🔴 8 | A2 Step 1 的夹具用 **`dealCards()`（随机洗牌）** 却按**具体牌值**出牌（`c(3)`/`c(4)`/`c(5)`） | **用例只有约 31% 通过率**（只有 u0 恰好拿到那张牌时）；单跑碰巧绿、连跑随机红 ⇒ **假绿与假红两个方向都会发生** | 夹具**钉死三家手牌**（不用随机发牌）。**教训：判据里的随机源必须被钉死，否则它是骰子不是判据** |
| 9 | A2 Step 4 说「照该文件里 `handleBid`/`bidKindOf` 那几行的形态写 `export { … } from`」 | 那两个文件的实际形态是 **`export * from './ddz/xxx'`**（全文件无一处 `export { … } from`） | 按实际风格写 `export * from` |
| 10 | A2 Step 10 说 `checkSingleCaliber` 的入参「从 `LastPlayedHandWire` 换成…」 | 实际入参是 **`PlayViewWire`**（旧实现从 view 里读 `lastPlayedHand`） | 入参仍是 `view`，内部改经窗口读 |

⚠️ **共同点**：这六处**全都在「我凭记忆写的代码块与伪代码」里**，而不在散文里。
⇒ **可复用的纪律**：计划里凡是给出**可执行代码**的地方，写完后至少要**在脑子里当一次编译器/解释器**跑一遍——
本片两轮下来，散文性描述零错，代码块有 10 处硬错。

### §0.4.2 Task A3 落地时又抓出的八处（**全部是「代码块 vs 真实文件」的偏差**）

| # | 原文（错） | 实测 | 处置 |
|---|---|---|---|
| 11 | A3 Step 1 用 `features.test.ts` 的 `makeSession()` | 实际就叫 `playingSession()` | 按实际名 |
| 12 | A3 Step 6 的 import 里要 `Rank` | 用不到（`noUnusedLocals` 会红） | 删 |
| 13 | A3 正文说 `ruleDecision` 有「三个调用点」，Step 6 又说两处 | 实际 **2 处**（`:565`/`:574`） | 按实际 |
| 14 | A3 Step 6 说调用点在 `playRobotTurn` | 实际方法叫 `driveOneRobotTurn` | 按实际 |
| 15 | A3 Step 7 给的 `rpc.test.ts` 行号 | 与实际不符 | 按实际（grep 定位） |
| 16 | A3 Step 7 说要改 `game.service.test.ts` | 实际**不需要** | 不改 |
| 17 | A3 的夹具清单**漏了** `packages/protocol/src/robot.test.ts` | 它也有 `RobotFeatures` 夹具 ⇒ 必填键缺了会红 | 补上 |
| 18 | 其余代码块 | 经核对**无误** | —— |

🔴 **三轮累计：14 处控制者文本错误，全部落在「可执行代码块」里，散文性描述零错。**
⇒ **给后面 13 个任务的执行纪律**（已写进每一份派工单）：
**把计划里的每一段代码当「待核实的伪代码」，照抄前先在真实文件里核一遍**；
发现偏差**照事实做 + 在报告里如实记**，不许照抄错文本。

⚠️ **另记 A3 的一处判断**（评审者在核）：它为了让 `robot.decide` ④ 的红**真的是由缺口引起的**
（而不是「两错抵消」的假绿），把该用例的 features 与 view **对齐**成 A2 前的语义（单张 2）。
⇒ 这是**夹具层面**的调整，不是改断言；但它是本片最接近「把断言改绿」的形态，必须有独立评审判定。
✅ **评审结论（opus）：判定为合法的成对迁移** —— 被改的只有 `features` 夹具、`expect` 一行未动，
对齐后的目标与 A2 前逐字同局面。

### §0.4.3 A2+A3 评审（opus）打脸的**我的两处文本**

| # | 我写的 | 实测 | 处置 |
|---|---|---|---|
| 19 | 规格 §2.3 与本文 A2 Step 11 写「**不变式② 是探针 `canPass` 的依赖项**」「不成立时 canPass 会静默走错分支」 | 🔴 **失真**：`canPass` 在整仓**没有任何消费点**（grep 只有定义处）。真正依赖窗口语义的是 `browser-e2e.mjs:799-803` 的 **autoPlay 分支**，而它**只在 `--scenario full` 下执行** | 已订正两处文本；并把「跑一次 `full`」写进 **A6**（见下） |
| 20 | A2 Step 13 只要求跑 `gate` | `gate` 只**求值** `READ_STATE`、**不分支** ⇒ 第三处探针改动（autoPlay）至今**从未被执行** | **A6 补一步：跑 `--scenario full`** |

🔵 **这条的教训值得单列**：`gate` 与 `full` 是**两个不同的射程**。判据改了却只跑 `gate`，
等于**改了的那一条从没跑过** —— 而探针会给出「22/22 全绿」这种**看起来完整**的信号。
⇒ **凡改动探针的某个分支，必须确认那个分支在哪个场景下被执行**。

### §0.4.4 Task A4 落地时抓出的（**含两条假命令**）

| # | 原文（错） | 实测 | 处置 |
|---|---|---|---|
| 21 | `pnpm run conformance` | 根 `package.json` **没有**这个 script。真命令：`pnpm --filter @fight-the-landlord/conformance conformance`（= `node dist/run.js`，**改完 src 必须先 `build`**），单片用 `conformance:slice-09` 等 | 已订正 |
| 22 | `node tools/conformance/src/check-baselines.mjs full` | 真实路径是 **`scripts/check-baselines.mjs`**，且**要一个日志文件参数**：`node scripts/check-baselines.mjs <render\|full> <日志>`。⚠️ 它会**要求基线列出的每一片都在日志里**（缺席即违规）⇒ **只跑三片时不能用它** | 已订正 |
| 23 | A6 的「新鲜度自证」只列了 game-service / api-gateway | A4 实测 **`robot-service` 的常驻镜像也是旧的**（`grep lastMoveMeta` = 0）⇒ 真栈判据会变空测 | **已写进 A6：三个服务都要自证** |
| 24 | A4 Step 3 让 `observeRobotHand` 比较 `JSON.stringify(window)` 当「这版没变」的闸 | 🔴 **照抄会造 RED**：人类**过牌**的转移会让窗口变了 ⇒ 同一手机器人出牌被**记两次**，且配套的形状判据会对「最新一条是不出」的视图误报 | 已订正为「按『窗口最新一条 = 这次转移的动作』归属」，删掉 `prev` |
| 25 | A4 Step 4 的夹具照抄必红（base `actionLog` 是对子 + 过牌，未覆盖真源） | —— | 已订正 |

⚠️ **累计 25 处**。仍然全部落在**可执行代码块与命令**里 —— 这条规律已经稳定到可以作为
**下一片计划的编写纪律**：写完任何代码块/命令，**先在真实仓库里核一遍**。

### §0.4.6 A6 验收时抓出的（第 27 处 + 一条环境事实）

| # | 原文（错） | 实测 | 处置 |
|---|---|---|---|
| 27 | §0.4.4 订正后的 `pnpm --filter @fight-the-landlord/conformance conformance` | 🔴 **裸跑不成立**：它只**打印用法并 exit 2**（那一步要的是「按 `--list` 的顺序逐片跑」，CI 正是那么做的） | 已订正：**照 `.github/workflows/conformance.yml` 的 `--list` 循环**。⚠️ 这是**对上一次订正的再订正** —— 我改错了一次，说明「改命令」这件事本身也要**真跑一遍**才算核过 |

🔵 **一条环境事实（与既有记忆相反，值得单列）**：`DOCKER_BUILDKIT=0 docker compose build` 在本机
**可能卡死**（实测：`game-service` 的 `pnpm install` 卡 20+ 分钟、TCP 无响应）⇒ 杀掉后**用默认 BuildKit 重试成功**。
既有记忆里的「`DOCKER_BUILDKIT=0`」是老经验，**不再是无条件正确的**：卡住就换默认 BuildKit 重试。

✅ **A6 的验收结果（如实记录）**：
- `ci`：**首跑 stage 6/6 红**（`api-gateway/no-route-outside-api.gate` 3 × `fetch failed`）
  ⇒ **复跑六阶段全过 · 0 cached**。铁证：**同一次 run 内**该文件在 stage 4 是绿的、stage 6 是红的
  ⇒ 环境性假红（`listen(0)` ∩ Node fetch 封禁端口族），**记成「首跑红 / 复跑绿 ⇒ 未复现」**。
- conformance：**17/17 片全过**；09/10/11 = **163 / 186 / 51**（floor 160/185/50）。
  基线闸 16/17 —— 唯一例外 `slice-07.5-backup` 182 < 196 是**结构性**的（本机 14 条显式跳过：无 flock×11 + 无 script(1)×3，
  182+14=196 恰好对上，且与 09-27 本机读数逐字相同）⇒ **不回填**（不得用本机读数放宽判据）。
- **探针 `--scenario full`：39/39 · 0 ❌** —— 🔴 本片改的第三处探针代码（autoPlay 分支）
  **首次被执行**（`[19] … v62 自动动作 20 次`）⇒ §0.4.3 那条待办**关闭**。
- 另做了 Step 4 的真栈人眼观测（原始帧）：`recentActions` 窗口 2 · 过牌后 `{"seat":1,"cards":null}` ·
  `baseScore`=15 · `bidPhase.kind="rob"` + 3 条 `decisions`，共 17 项 ✅

### §0.4.7 B 段暴露的**新一类**计划缺陷：**我设计的判据太弱**

前 27 处是「代码块/命令与真实文件不符」（照抄会报错、撞墙即知）；第 26 处是「恒真断言」（能跑绿、什么也没测）。
**B 段又添一类**：判据**能失败、也真的失败过**，但**失败的覆盖面不够** —— 它拦不住**最像正确答案的那个错**。

| # | 形态 | 实例 |
|---|---|---|
| **28** | 🔴 **判据对「最像服务端规则的那类错实现」没有判别力** | B3 的 R657 改形态要求「文案只能从 `kind` 派生」。我设计的正例+反例都在**`(kind, landlordCandidate)` 自洽**的夹具上 ⇒ 把 `table.vue` 的 `bidKind` 改成**原样复刻服务端 `bidKindOf`**（`candidate === -1 ? 'call' : 'rob'`）—— **正是这条红线要禁的那件事** —— 全套判据**仍然全绿**。⇒ 修法：正例必须**刻意让 `candidate` 与 `kind` 不一致**（`kind:'rob'` + `candidate:-1`），这样「按 candidate 反推」的实现才会红。**评审者的归因是准的：计划文本层的洞**（我只写了「正例+反例」，没写「夹具必须不自洽」） |
| **29** | 🔴 **判据的样本量不足以区分「两处」与「一处」** | B2 的「两个 action 各在自己的槽」用例**每格各 1 张牌** ⇒ 「两处并成一格」的变异下**仍然绿**。⇒ 修法：用**张数不同**的两个 action（2 张 vs 3 张）+ 唯一归属文案 |
| **30** | **判据只覆盖了守卫的一半** | B3 的中央钟只有「叫抢期 + 轮到我 ⇒ 有钟」「叫抢期 + 别人 ⇒ 无钟」两条 ⇒ 把守卫改成 `v-if="store.isMyTurn"`（**丢掉 `isBidding`**，会在出牌期把大钟摆到中央）**全套仍绿**。⇒ 修法：补「playing + `currentPlayer: mySeat` ⇒ **无钟**」 |

🔴 **⇒ 复核纪律再加第三个问题**（前两个见 §0.4.5）：

> **③ 它拦得住「最像正确答案的那个错」吗？**
> 把**红线的反面**（R657 要禁的反推、B2 要禁的合并、B3 要禁的丢守卫）**当成一个候选实现**，
> 问「如果我这么写，哪条判据会红？」—— **答不上来 ⇒ 这条判据的覆盖面不够**。
> ⚠️ 这类缺陷**全部一路绿灯**（第 26 处是「不测」，这三处是「测了但没测到点上」），
> 所以同样只能靠**主动反推**发现，不能等红灯。

🔵 **一个正面信号**：B3 的实施者这次**在交付前**就用反推抓出了一条恒真判据
（M5 首跑全绿 ⇒ 定位到夹具抹掉了 `decisions`）—— 纪律从「评审事后补救」变成了「实施者事前拦截」。

### §0.4.8 B4 抓出的三处（**第 31–33 处**）

| # | 原文（错） | 实测 | 处置 |
|---|---|---|---|
| **31** | B4 Step 3 把**模板注释写在根元素之前** | 🔴 **与它自己的注释文字自相矛盾**：同一段注释正讲着「写在根元素之前会让 SFC 变多根」⇒ **照抄会把本任务新加的那条单根闸打红** | 已订正（注释移进根元素内部）。⚠️ **这一类最讽刺**：我把「为什么不能这么做」写在了「我正在这么做」的注释里 |
| **32** | 「`game.vue` 的好友房弹层用 `close_btn.png` 关闭」 | **不成立**：那个弹层的关闭是**文字按钮**，`close_btn.png` 全仓**零引用**（实测 `git grep -ln close_btn -- apps/client/src/` 只命中新写的 `MoreMenu.vue` 与 `ASSETS.md`） | 已订正。⇒ `MoreMenu.vue` 是它**第一个**消费者（顺带证明「素材入库了但没人用」可以持续很久） |
| **33** | 漏写一条硬约束：**按钮样式必须自持** | `scoped` 只到子组件**根节点** ⇒ 父组件的 `.btn` 规则进不去（本仓反复记账的 F1 教训） | 已补进 brief。**注：实施者自己知道这条并做对了** —— 它是在报告里指出「brief 漏了」 |

🔵 **三处又都是「计划文本 vs 事实」**，与前 30 处同族。**这条规律已经稳到可以在下一片直接写成编写规范**：
**凡在计划里给出代码/命令/素材路径/结构性约束，落笔前先在真实仓库里核一遍；
凡给出判据，落笔后反问「最像正确答案的那个错会不会被我拦住」。**

### §0.4.5 A4 评审抓出的**新一类**错误（第 26 处）

| # | 原文（错） | 实测 | 处置 |
|---|---|---|---|
| 🔴 26 | A4 Step 4 那条「等价迁移」的用例：`makeSession()` 写进 `lastPlayedHand` 字面量，然后**断言那个字面量的字段** | 🔴 **恒真断言**：`makeSession` 的实现是 `return { ...base, ...over }` ⇒ `session.lastPlayedHand` **就是用例自己塞进去的那个对象**。断言的 `type`/`keyRank`/`length` 测的是**对象展开**，不是任何被测实现；唯一能让它红的场景是 `buildPlayerView` 反过来去改会话的规则字段（一个极窄的变异）。而注释与 `slice-11:643` 的收口文案都宣称「那四条口径已**等价迁移**到本文件」——**那句宣称是假的** | 已订正为**走生产代码**（真 `handlePlayCards` 跑一次转移，再同时断言「规则字段留在服务端」与「线格式只剩牌面」） |

🔴 **这是一类与前三轮不同的错**：前 25 处是「**代码块与真实文件不符**」（照抄会报错、编译不过、跑不起来）；
这一处**能编译、能跑绿、却什么也没测** —— 本仓自己把它写死在
`tools/conformance/src/lib/assert.ts` 的 `skip()` 文档里：
「**一条不可能失败的断言比没有断言更坏，它制造的是虚假的信心**」。

⇒ **复核纪律升级（两个问题，缺一不可）**：
1. **它跑得起来吗**？（与真实文件核：模块、签名、函数名、行号）
2. **它有可能失败吗**？（把断言**反着推**一遍：什么样的实现/数据会让它红？推不出来 ⇒ 它是恒真的，删掉或改成走生产代码）

⚠️ **并记一条观察**：这一处**实施者没抓到**（它抓了我另外五处）—— 因为前五处是「照抄会报错」，
会当场撞墙；而恒真断言**一路绿灯**。⇒ **越是「顺利通过」的步骤，越要回头问第 2 个问题。**

---

## §1. 判据改动记账（规格 §4 的执行版 —— **反例纪律：不接受「把断言改绿」**）

| 受影响的判据 | 为什么改 | 改完还测不测得到原性质 |
|---|---|---|
| **`packages/protocol/src/{messages,rpc,robot}.test.ts`** 等夹具 | 视图形状变了 | ✅ 夹具补新键；「永不出站字段被拦」那组**一条不动**（`actionLog`/`isRobot`/`botId`/`skillLevel`） |
| **`packages/game-service/test/view.builder.test.ts`**（11 处） | 视图形状 + 新投影 | ✅ 增：`recentActions` 的窗口语义与两条不变式、`baseScore` 透传、`kind` 派生、`decisions` 顺序。减：两条字段的存在性断言（成对迁移） |
| **`tools/conformance/...` 09/10/11 + `ddz-driver.ts`** | 在线口径与归属判定都读那两个字段 | ✅ **只增不减**：改写后 count **不得低于现基线**；若确实覆盖不到，**补等价判据把 count 补回**（见 Task A5 的细则），**不得下调 `baselines.json` 的 floor** |
| **`apps/client/test/table-bid-ui.test.ts`：`LOCAL_SCORING_TRACES`** | 它禁 `/底分/` 与 `/\bbaseScore\b/`，而协议⑥**要求**牌桌显示底分 | ✅ **三条不动、两条改形态**（Task B1）：`/×\s*\d/` 与 `/\b(?:bidMultiplier\|multiplier)\s*[*+/%-]/` 与 `/Math\.pow\s*\(\s*2/` **保留**；`/底分/` → 禁**数值字面量**；`/\bbaseScore\b/` → 允许引用服务端字段、禁赋值与运算。**另加正对照**（服务端给了底分 ⇒ 页面上必须真的出现那个数字） |
| **`apps/client/test/table-hud.test.ts:139`（R654）** | 同上 | ✅ 改形态：「HUD 文本不得含『底分』」→「**显示的底分只能来自 `PlayerView.baseScore`**」+ 正负对照 |
| **`apps/client/test/table-bid-bottom.test.ts:115-154`（R657）** | 文案**随 `kind` 变化**（上位 §4.3 明文要求） | ✅ 改形态：「字面固定」→「**只能从 `kind` 派生**」。**反例保留**：同一 `kind` 下文案恒定 |
| **`apps/client/test/action-feedback.test.ts:127-140 / :152-174`（气泡两条）** | 本地回声**删除**（「不出」「不抢」现在是服务端的原话） | ✅ 成对迁移：ack 后出现 → **服务端给了才出现**；被拒不出气泡**保留**。⚠️ 源码级锚点 `watch(() => store.currentVersion`（`:212`）会**消失** ⇒ **换锚点**（改成断言 `recentActions` 驱动），**不得直接删** |
| **`apps/client/test/table-hud.test.ts` 的 `SINGLE_ROOT_CASES`** | ⚠️ **经核：不用改** —— `PlayArea` 只删可选 prop `bubble`，用例传的 `{cards:null, ownerSeat:-1, ownerLabel:''}` 仍然合法 | ✅ 单根闸性质完全保留 |
| 🔴 **`table-bid-ui.test.ts` 的 `TABLE_AREA`（R659）** | 新增 `MoreMenu.vue` | ✅ 清单 **9 → 10**（长度断言 `:301`/`:323` 同步改） |
| **`apps/client/test/art-slots.test.ts:38`** | 接通 `coin`/`countdown` + 新增 `ribbon` 后「七槽缺省全 `none`」**必红** | ✅ 改形态：「每个槽**显式登记**状态（`none` 或 `url(...)`）」；第 4 条「七槽都真被引用」的射程扩到 8 槽；**「不得硬编码 `/static/ui/`」那条一条不动** |
| **`apps/client/test/landscape-canvas.test.ts:153`（R713）** | 「每页可选底纹」会打破「`bg.png` 只出现一次」 | ✅ 改形态：→「**舞台只有一层底纹**（底纹图只允许出现在 `LandscapeStage.vue`）」+「映射表里每张图都在盘上」。⚠️ 锚到 `/\/static\/ui\//`（旧正则 `/bg\.png/` 太宽，片① 的 Minor 已预警） |
| **`apps/client/test/hand-layout.test.ts:14-16`** | 与 `uni.scss` 是第二真源（片② 遗留） | ✅ 本片**消掉**它：改成从 `uni.scss` 现读（与 `card-hand-interaction.test.ts:536` 同一手法） |
| **`scripts/browser-e2e.mjs:319`（`canPass`）** | 读 `store.lastPlayedHand` | ✅ 改读 `recentActions`（依赖规格 §2.3 的不变式②：**「窗口里有非 `null」⟺ `lastPlayedHand !== null`**）。⚠️ 该等价性由 Task A1 的判据钉住 |
| ⚪ **已核不受影响** | —— | `table-ended-ui` · `table-play-ui` · `table-seat-geometry` · `source-boundary` · `ui-tokens` · `animations` · `panel` · `card-hand-interaction`（除源码锚点两条）· `ui-flow` · `asset-budget` · `mock-e2e` · `settlement-rematch` · `page-stack` |

**源码级文本锚点（🔴 重写 `table.vue` 时逐条核在不在）**：

| 锚点 | 出处 | 本片怎么办 |
|---|---|---|
| `:deep(.hand) { … column-gap: 0;` | `card-hand-interaction.test.ts:492` | **保留**（手牌布局不动） |
| `.card + .card) { … margin-left: -$ftl-card-overlap;` | `card-hand-interaction.test.ts:501` | **保留** |
| `watch(() => store.currentVersion` | `action-feedback.test.ts:212` | 🔴 **会消失**（气泡退役）⇒ **换锚点**（Task B2） |
| `usePageAlignment('table')` | `page-stack.test.ts:224` | **保留** |

---

## §2. 文件结构（先锁边界，再拆任务）

### 阶段 A

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/protocol/src/views.ts` | 改 | 加 `RecentAction` 类型；`PlayerView` 加 `recentActions` / `baseScore` / `bidPhase.kind` / `bidPhase.decisions`；**删** `lastPlayedHand` / `lastPlayerIdx`（Task A2） |
| `packages/protocol/src/validate.ts` | 改 | 新增五项校验；**删**旧两条字段的校验（Task A2） |
| `packages/protocol/src/robot.ts` | 改 | `RobotFeatures` 加 `lastMoveMeta` |
| `packages/shared/src/ddz/types.ts` | 改 | `bidPhase` 加 `decisions`；注释订正（`baseScore` 默认 100→15、「与 `PlayerView.lastPlayerIdx` 同名同义」删掉） |
| `packages/shared/src/ddz/bid.ts` | 改 | `handleBid` 写 `decisions`（含就地算好的 `kind`）；`kindOf()` 派生函数；`resetBidding` 清空 |
| `packages/shared/src/ddz/features.ts` | 改 | 投影 `lastMoveMeta` |
| `packages/game-service/src/game/view.builder.ts` | 改 | 四个投影：`recentActions`（从 `actionLog` 取后两条）· `baseScore` · `kind` · `decisions` |
| `packages/game-service/src/game/game.service.ts` | 改 | `ruleDecision` 改签名（跟牌目标从 `session` 取） |
| `packages/robot-service/src/robot/bot.player.ts` | 改 | 跟牌目标改读 `features.lastMoveMeta` |
| `tools/mock-server/src/scripted-game.ts` | 改 | 私有状态从两字段换成 `recentActions` 窗口，`viewFor()` 透传 |
| `tools/conformance/src/lib/ddz-driver.ts` | 改 | 线格式接口 + `checkSingleCaliber` 重写 |
| `tools/conformance/src/slices/slice-09-play-rotation.ts` | 改 | 口径 info + 三处断言 |
| `tools/conformance/src/slices/slice-10-settlement.ts` | 改 | 同上（两处） |
| `tools/conformance/src/slices/slice-11-robot-system.ts` | 改 | `checkRobotHand` / `pickHumanAction` / `observeRobotHand`（归属判定） |
| `scripts/browser-e2e.mjs` | 改 | `canPass`（:319）+ `seedFinishedGame` 的假视图（:558）+ 自动出牌分支（:793） |
| `docs/design.md` · `docs/client-protocol.md` · `docs/games/doudizhu.md` | 改 | 契约同步 |
| `test-full-game.ts` / `.js` | **删** | 死脚本（全仓零引用、字段早已漂移）—— ⚠️ 需用户确认（规格 §6 订正表第 5 条） |

### 阶段 B

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/client/src/stores/game.ts` | 改 | 新增 `recentActions` 与 `viewLevelName` 两个 getter |
| `apps/client/src/pages/table/table.vue` | 改 | 重排：顶栏瘦身 · 中央（场次名/底分 · 动作区 · 回显 · 钟）· 出牌区两实例 · 弹层 |
| `apps/client/src/components/PlayArea.vue` | 改 | 删 `bubble` prop；`cards === null && ownerSeat >= 0` ⇒ 渲染「不出」 |
| `apps/client/src/components/BidPanel.vue` | 改 | 加 `kind` prop（文案派生）+ 主按钮金色化 |
| `apps/client/src/components/Seat.vue` | 改 | 加可选 `bidEcho` prop（对手的叫抢回显） |
| `apps/client/src/components/Settlement.vue` | 改 | 绶带标题带 + 主按钮金色化 |
| `apps/client/src/components/MoreMenu.vue` | **建** | 二级弹层（四个恒灰占位按钮收进来） |
| `apps/client/src/components/LandscapeStage.vue` | 改 | `backdrop` prop + 底纹映射表 |
| `apps/client/src/composables/useTableSound.ts` | 改 | 叫抢音效改走 `decisions` 的**视图 diff** |
| `apps/client/src/uni.scss` | 改 | 接通 `$ftl-art-coin` / `$ftl-art-countdown`；新增 `$ftl-art-settlement-ribbon` |
| `apps/client/test/table-bid-ui.test.ts` | 改 | R659 的两条正则 + `TABLE_AREA` 9→10 |
| `apps/client/test/table-hud.test.ts` | 改 | R654 改形态 |
| `apps/client/test/table-bid-bottom.test.ts` | 改 | R657 改形态 |
| `apps/client/test/action-feedback.test.ts` | 改 | 气泡两条成对迁移 + 源码锚点换 |
| `apps/client/test/art-slots.test.ts` | 改 | 八槽显式登记 |
| `apps/client/test/landscape-canvas.test.ts` | 改 | R713 改形态 |
| `apps/client/test/hand-layout.test.ts` | 改 | 消第二真源 |
| `apps/client/test/table-center.test.ts` | **建** | 中央三项（场次名/底分 · 钟 · 回显）的判据 |
| `apps/client/test/table-play-area-window.test.ts` | **建** | 出牌区窗口 2 的判据 |
| `apps/client/test/more-menu.test.ts` | **建** | 弹层开合 + 四个占位的 disabled |
| `apps/client/test/backdrop.test.ts` | **建** | 每页可选底纹 |
| `docs/superpowers/specs/2026-09-21-ui-art-brief.md` | 改 | 七槽尺寸表重新实测校准 |

**明确不做**（越界项，写下来免得下一个人以为是漏了）：
- ❌ **不接另外五个素材槽**（`landlord-badge` / `count-tile` / `avatar-ring` / `bid-badge` / `bottom-bar`）—— 无图，且本仓不许塞占位图。
- ❌ **不做「聊天」**（既有裁决：本片无聊天）。
- ❌ **不给四个恒灰按钮接功能**（D16 只裁决「收进弹层」）。
- ❌ **不改画布比例**（1334×750 不动 —— 改它会作废一大批几何判据）。
- ❌ **不新增页面/路由**（二级弹层是弹层，页面栈的唯一真源仍是 `auth.page`）。

---

## 分支与前置

```bash
# 从当前 master（421f772 + 两个 docs 提交）切特性分支
git checkout -b feat/table-rework
```

⚠️ 本片**不推 origin**（与片② 同：`origin/master` 落后很多，推不推等用户裁决）。

---

# 阶段 A：协议与服务端

## Task A1: 加法三项（协议 ③⑥⑦）—— 纯加法，不动任何既有字段

**Files:**
- Modify: `packages/protocol/src/views.ts`（加 `RecentAction` / `BidDecision` 两个类型 + `PlayerView` 三个新键）
- Modify: `packages/protocol/src/validate.ts`（新增校验 + 一个 `assertInt` helper）
- Modify: `packages/protocol/src/messages.test.ts`（校验器判据）
- Modify: `packages/shared/src/ddz/types.ts`（`GameSession.bidPhase` 加 `decisions`）
- Modify: `packages/shared/src/ddz/bid.ts`（`bidKindOf()` + 写 `decisions` + 流局清空）
- Modify: `packages/shared/src/ddz/bid.test.ts`
- Modify: `packages/game-service/src/game/view.builder.ts`（三个投影）
- Modify: `packages/game-service/test/view.builder.test.ts`

**Interfaces:**
- Consumes: 无（本任务是阶段 A 的第一块）
- Produces:
  - `protocol`: `interface RecentAction { seat: number; cards: Card[] | null }` · `interface BidDecision { seat: number; kind: 'call' | 'rob'; grab: boolean }`
  - `protocol`: `PlayerView.baseScore: number` · `PlayerView.bidPhase.kind: 'call' | 'rob'` · `PlayerView.bidPhase.decisions: BidDecision[]`
  - `shared`: `bidKindOf(phase: Pick<GameSession['bidPhase'], 'landlordCandidate'>): 'call' | 'rob'`
  - `shared`: `GameSession.bidPhase.decisions: BidDecision[]`
  - ⚠️ **Task A1 不产出 `recentActions`**（那是 A2 的破坏性替换）。`RecentAction` 类型本任务先定义好，A2 才用。

---

- [ ] **Step 1: 写失败判据 —— `packages/shared/src/ddz/bid.test.ts`**

在 `describe('handleBid', ...)` 内部追加（**放在文件末尾**，`beforeEach` 里的 `session` 是现成的）：

```ts
  /**
   * 协议 ⑦：每次决策都追加一条 `decisions`，且 `kind` 是**决策发生那一刻**算好的。
   *
   * ⚠️ 用 `landlordCandidate === -1` 判「叫」而不是 `grabActions === 0`：
   * 「第一家不叫、第二家叫」时，第二家仍然是**叫地主**（本轮还没有人声称）。
   */
  it('协议⑦：每次决策追加一条 decisions（kind 就地算好）', () => {
    const s1 = handleBid(session, 'user-1', false); // 第一家「不叫」
    expect(s1.bidPhase.decisions).toHaveLength(1);
    expect(s1.bidPhase.decisions[0]).toEqual({ seat: 0, kind: 'call', grab: false });

    const s2 = handleBid(s1, 'user-2', true); // 第二家「叫地主」
    expect(s2.bidPhase.decisions).toHaveLength(2);
    expect(s2.bidPhase.decisions[1]).toEqual({ seat: 1, kind: 'call', grab: true });

    const s3 = handleBid(s2, 'user-3', true); // 第三家「抢地主」
    expect(s3.bidPhase.decisions).toHaveLength(3);
    expect(s3.bidPhase.decisions[2]).toEqual({ seat: 2, kind: 'rob', grab: true });
  });

  /** 🔴 反例：第一家**不叫**之后，第二家仍然是「叫」—— 这是 `grabActions === 0` 派生法会错的地方。 */
  it('协议⑦反例：第一家不叫 ⇒ 第二家的 kind 仍是 call', () => {
    const s1 = handleBid(session, 'user-1', false);
    expect(s1.bidPhase.landlordCandidate).toBe(-1);
    const s2 = handleBid(s1, 'user-2', true);
    expect(s2.bidPhase.decisions[1]!.kind).toBe('call');
  });

  /** 流局重发 ⇒ 新的一轮，`decisions` 必须清空。 */
  it('协议⑦：流局重发后 decisions 清空', () => {
    let s = handleBid(session, 'user-1', false);
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false); // 三家全不抢 ⇒ 流局
    expect(s.bidPhase.redealCount).toBe(1);
    expect(s.bidPhase.decisions).toEqual([]);
  });

  /** 地主确定 ⇒ 进入 playing；`decisions` 保留（它是**无人读的数据**，但也不清 —— 少一个清理点）。 */
  it('协议⑦：地主确定后 decisions 仍在（本轮结果可读）', () => {
    let s = handleBid(session, 'user-1', true);
    s = handleBid(s, 'user-2', false);
    s = handleBid(s, 'user-3', false);
    expect(s.state).toBe(GameState.Playing);
    expect(s.bidPhase.decisions).toHaveLength(3);
  });

  /** `bidKindOf` 是**唯一**的派生实现（`view.builder` 直接用它，不得各自实现）。 */
  it('bidKindOf：landlordCandidate === -1 ⇒ call，否则 rob', () => {
    expect(bidKindOf({ landlordCandidate: -1 })).toBe('call');
    expect(bidKindOf({ landlordCandidate: 0 })).toBe('rob');
    expect(bidKindOf({ landlordCandidate: 2 })).toBe('rob');
  });
```

并在文件顶部的 import 里加上 `bidKindOf`：

```ts
import { handleBid, BID_MULTIPLIER_CAP, bidKindOf } from './bid';
```

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/shared exec vitest run src/ddz/bid.test.ts
```

Expected: FAIL —— `bidKindOf` 不存在 / `s1.bidPhase.decisions` 是 `undefined`。

- [ ] **Step 3: 实现 —— `packages/protocol/src/views.ts`**

在 `LastPlayedHand` 接口（`:46-51`）**之后**加两个类型：

```ts
/**
 * 一条**桌面历史动作**（协议 ④ / 上位 §4.4）。
 *
 * ⚠️ `cards: null` **不是**「缺省值」，而是一条**显式事实**：该座位**「不出」**。
 * 窗口 = 2、按发生顺序（旧 → 新）、**「不出」也占一手**。
 *
 * 🔵 它顺手消灭了一个 hack：旧契约里没有任何字段能表达「谁刚过了牌」，
 * 于是「不出」气泡是**客户端自己编的**（`table.vue` 的 `bubble` / R656）。新规则下
 * `cards: null` 就是**服务端的原话** ⇒ 那个机制整条退役。
 */
export interface RecentAction {
  seat: number;
  cards: Card[] | null;
}

/**
 * 一条**叫抢决策**（协议 ⑦ / 用户 2026-09-28 裁决）。
 *
 * `kind` 是**服务端算好的措辞依据**：`'call'` ⇒ 叫地主/不叫，`'rob'` ⇒ 抢地主/不抢。
 * 前端**只能从它派生文案**，不得由 `grabActions`/`landlordCandidate` 反推（上位 §4.3）。
 */
export interface BidDecision {
  seat: number;
  kind: 'call' | 'rob';
  grab: boolean;
}
```

`PlayerView`（`:60` 起）里加三项：

```ts
export interface PlayerView {
  roomCode: string;
  /** 版本号。 */
  version: number;
  state: 'init' | 'bidding' | 'playing' | 'ended';
  /** 本局的**底分**（协议 ⑥）。牌桌据此显示「XX场 底分 N」。 */
  baseScore: number;
  /** 接收者自己的座位 */
  seat: number;
  // …（其余字段不动）
```

以及 `bidPhase` 里加两键（放在 `redealCount` 之后）：

```ts
  bidPhase: {
    /** 叫抢阶段的**行动者**在这里，不在 `currentPlayer`（玩法 §9.1） */
    currentBidder: number;
    bidMultiplier: number;
    /** `-1` 表示本轮尚无 */
    landlordCandidate: number;
    /** 本轮已完成的决策次数（0..3） */
    grabActions: number;
    redealCount: number;
    /**
     * 当前行动者该用哪套措辞（协议 ③）。
     * 派生依据是「本轮**是否已有人声称**」（`landlordCandidate`），**不是** `grabActions`。
     */
    kind: 'call' | 'rob';
    /** 本轮**已发生**的叫抢决策，按发生顺序；最多 3 条（一轮制天然有界）。 */
    decisions: BidDecision[];
  };
```

> ⚠️ **2026-09-30 订正（片①）**：上面 `PlayerView.bidPhase` 草案里的「（0..3）」「最多 3 条（一轮制天然有界）」
> 已随片① 的叫抢规则变更（**起始座位随机 + 一次反抢**）过期 —— 现行上界是 **4 条**（3 次声称 + 1 次反抢）、
> `grabActions` 为 **0..4**（`protocol/src/validate.ts` 的闸已是 `> 4`）。**本文件其余同源的
> 「最多 3 条 / at most 3 items / 0..3」表述一并以此为准**；实际落地代码以当前源码为准，本块其余内容不变。

- [ ] **Step 4: `packages/shared/src/ddz/types.ts`**

`import type { Card, LastPlayedHand } from '@fight-the-landlord/protocol';` 改成：

```ts
import type { Card, LastPlayedHand, BidDecision } from '@fight-the-landlord/protocol';
```

`GameSession.bidPhase` 里加一键（放在 `redealCount` 之后）：

```ts
  bidPhase: {
    currentBidder: number;
    landlordCaller: number;  // -1 表示尚无
    landlordCandidate: number;  // -1 表示尚无
    bidPasses: number;  // 连续不叫次数
    grabActions: number;  // 抢地主决策次数
    bidMultiplier: number;
    redealCount: number;  // 流局次数
    /**
     * 本轮已发生的叫抢决策（协议 ⑦ 的**内部形状** —— R157：内部形状**就是**契约形状）。
     * 按发生顺序；流局重发时清空（新的一轮）；地主确定后**保留**（它不含敏感信息，少一个清理点）。
     */
    decisions: BidDecision[];
  };
```

同文件顺手订正一处**已失真**的注释（规格 §2.8 要求）：
- `:55` 的「默认 100（§8.1）」→ 「默认 `DEFAULT_BASE_SCORE`（15 / §8.1）」
- ⚠️ **订正（2026-09-28 执行期）**：规格与本文原写「`:62` 有『与 `PlayerView.lastPlayerIdx` 同名同义』那句」——
  实测**该句不在 `types.ts`**（`:62` 是一个干净的字段声明），它实际在 **`docs/design.md:487`**
  ⇒ 那句属 **Task A5 的文档面**，本步**不动**。（「同名同义」全仓 grep 只命中 design.md 与规格/计划自身。）

- [ ] **Step 5: `packages/shared/src/ddz/bid.ts`**

在 `BID_MULTIPLIER_CAP`（`:11`）之后加派生函数：

```ts
/**
 * 协议 ③ 的**唯一**派生实现（`view.builder` 直接用它，**不得**各自实现一份）。
 *
 * 依据是「本轮**是否已有人声称**」（`landlordCandidate`），**不是** `grabActions`：
 * 第一家「不叫」之后第二家仍然是**叫地主**（本轮还没有人声称），而
 * `grabActions === 0` 会让第二家被错报成「抢」。
 *
 * ⚠️ 这是**本仓一轮制**（每名玩家恰好决策一次）下的语义映射，不是普适规则。
 */
export function bidKindOf(
  phase: Pick<GameSession['bidPhase'], 'landlordCandidate'>,
): 'call' | 'rob' {
  return phase.landlordCandidate === -1 ? 'call' : 'rob';
}
```

`handleBid` 里，在 `const newPhase = { ...session.bidPhase };`（`:25`）**之后**、
`newPhase.grabActions++;` **之前**插入：

```ts
  /**
   * 协议 ⑦：**就地**算出这次决策的措辞依据（`kind` 按**决策那一刻**的
   * `landlordCandidate` 算，而不是事后回推）—— 回推会让「第一家不叫、第二家叫」
   * 错报成「抢」。
   */
  const decisionKind = bidKindOf(session.bidPhase);
```

并在 `if (newPhase.grabActions >= 3) {` （`:43`）**之前**插入：

```ts
  newPhase.decisions = [...(session.bidPhase.decisions ?? []), {
    seat: playerIdx,
    kind: decisionKind,
    grab: bid,
  }];
```

`resetBidding`（`:107`）的 `bidPhase` 字面量里加一行：

```ts
    bidPhase: {
      currentBidder: 0,
      landlordCaller: -1,
      landlordCandidate: -1,
      bidPasses: 0,
      grabActions: 0,
      bidMultiplier: 1,
      // redealCount 跨轮累计（玩法 §3.2 要点 3）
      redealCount: session.bidPhase.redealCount,
      // §3.3：流局重发是**新的一轮** ⇒ 上一轮的决策记录必须清空
      decisions: [],
    },
```

⚠️ `finalizeBidding` **不动 `decisions`**（它 spread 了 `...session.bidPhase`，天然保留）。

- [ ] **Step 6: `packages/game-service/src/game/view.builder.ts`**

顶部 import 里加 `bidKindOf`（`@fight-the-landlord/shared` 已经导入了）：

```ts
import { GameState, bidKindOf, type GameSession } from '@fight-the-landlord/shared';
```

⚠️ 若 `shared` 没在 `index.ts` 导出 `bidKindOf`，**在 `packages/shared/src/index.ts` 加上**
（照 `handleBid` 的既有导出行）—— 不加的话 `tsc` 会红。

`view` 字面量里加 `baseScore`（放在 `state` 之后）：

```ts
    state: session.state,
    baseScore: session.baseScore,
```

`bidPhase` 里加两键：

```ts
    bidPhase: {
      currentBidder: session.bidPhase?.currentBidder ?? 0,
      bidMultiplier: session.bidPhase?.bidMultiplier ?? 1,
      landlordCandidate: session.bidPhase?.landlordCandidate ?? -1,
      grabActions: session.bidPhase?.grabActions ?? 0,
      redealCount: session.bidPhase?.redealCount ?? 0,
      // 协议 ③：kind 是**派生**出来的（一处实现：shared 的 bidKindOf）
      kind: bidKindOf(session.bidPhase ?? { landlordCandidate: -1 }),
      // 协议 ⑦：原样透传（内部形状就是契约形状）
      decisions: session.bidPhase?.decisions ?? [],
    },
```

- [ ] **Step 7: `packages/protocol/src/validate.ts`**

在 `assertStr`（`:58`）之后加一个整数 helper：

```ts
/** 整数 + 闭区间校验（`assertNum` 只保证有限数 —— 它允许 `-1`/`99`/`1.5`）。 */
function assertInt(v: unknown, path: string, min: number, max: number): asserts v is number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ProtocolError(
      `${path} must be an integer in ${min}..${max}, got ${JSON.stringify(v)}`,
    );
  }
}
```

`assertPlayerView` 里，在 `assertCardArray(v.hand, ...)`（`:110`）**之前**插入 `baseScore` 校验：

```ts
  assertNum(v.baseScore, `${path}.baseScore`);
  if ((v.baseScore as number) <= 0) {
    throw new ProtocolError(`${path}.baseScore must be positive, got ${JSON.stringify(v.baseScore)}`);
  }
```

`bidPhase` 的两条既有校验（`:133-134`）**之后**追加：

```ts
  const bp = v.bidPhase as Record<string, unknown>;
  if (bp.kind !== 'call' && bp.kind !== 'rob') {
    throw new ProtocolError(`${path}.bidPhase.kind must be 'call' or 'rob', got ${JSON.stringify(bp.kind)}`);
  }
  if (!Array.isArray(bp.decisions)) {
    throw new ProtocolError(`${path}.bidPhase.decisions must be an array`);
  }
  if (bp.decisions.length > 3) {
    throw new ProtocolError(`${path}.bidPhase.decisions must have at most 3 items (一轮制), got ${bp.decisions.length}`);
  }
  bp.decisions.forEach((d, i) => {
    const p = `${path}.bidPhase.decisions[${i}]`;
    if (!isObj(d)) throw new ProtocolError(`${p} must be an object`);
    // ⚠️ 现全校验器**从不检查键存在性** ⇒ 这里必须显式判，否则「缺 seat」会被当成合法
    if (!('seat' in d)) throw new ProtocolError(`${p} must have a "seat" key`);
    if (!('kind' in d)) throw new ProtocolError(`${p} must have a "kind" key`);
    if (!('grab' in d)) throw new ProtocolError(`${p} must have a "grab" key`);
    assertInt(d.seat, `${p}.seat`, 0, 2);
    if (d.kind !== 'call' && d.kind !== 'rob') {
      throw new ProtocolError(`${p}.kind must be 'call' or 'rob', got ${JSON.stringify(d.kind)}`);
    }
    if (typeof d.grab !== 'boolean') {
      throw new ProtocolError(`${p}.grab must be a boolean, got ${JSON.stringify(d.grab)}`);
    }
  });
```

- [ ] **Step 8: 补夹具（`tsc` 会逐个指出来）**

按报错逐个补 `bidPhase.decisions` / `baseScore`。已知的两处起点：

- `apps/client/test/table-bid-ui.test.ts` 的 `bidPhase()` helper（`:59-68`）——**整体替换型**夹具，
  加两键即可（这一处带大半个客户端测试）。
  ⚠️ **该 helper 现在缺 `decisions` 与 `kind` ⇒ 本步必须补**，否则所有牌桌用例拿到的 `bidPhase`
  都是缺键的。
- `apps/client/test/helpers/fake-socket.ts` 的 `playerViewFixture()`（`:124-162`）—— 加 `baseScore: 15`
  与 `bidPhase: { …, kind: 'call', decisions: [] }`。
- `packages/game-service/test/view.builder.test.ts` 的 `makeSession()`（`:46-54`）—— 加 `decisions: []`。
  ⚠️ **订正（2026-09-28 执行期）**：本文原写「该文件不在 `tsc` 的 `include` 内」——
  那是**它自己 `:22-24` 的注释**，已**过时**：`tsconfig.test.json`（R481/P16 加的测试面类型闸）
  **会**编译 `test/**`，本文件缺 `decisions` 是**编译期**报出来的。
  ⇒ 那两句陈旧注释**本步顺手订正**。

```bash
# 让类型闸把所有该补的地方指出来。⚠️ 本仓**没有** `typecheck` script（实测
# ERR_PNPM_NO_SCRIPT）⇒ 等价口是 `pnpm run lint`（turbo run lint = 各包 tsc --noEmit /
# client 的 vue-tsc，含 tsconfig.test.json 的测试面）。
pnpm run lint
```

- [ ] **Step 9: 写校验器判据 —— `packages/protocol/src/messages.test.ts`**

在 `describe('validateOutbound', ...)` 内追加（`view()` 是该文件既有的夹具）：

```ts
  it('协议⑥：baseScore 必填且必须为正数', () => {
    const ok = { type: 'game.state_update' as const, version: 1, payload: { ...view(), baseScore: 15 } };
    expect(() => validateOutbound(ok)).not.toThrow();

    expect(() => validateOutbound({ ...ok, payload: { ...view(), baseScore: 0 } })).toThrow(
      /baseScore must be positive/,
    );
    expect(() => validateOutbound({ ...ok, payload: { ...view(), baseScore: undefined } })).toThrow(
      /baseScore must be a finite number/,
    );
  });

  it('协议③：bidPhase.kind 只接受 call / rob', () => {
    const payload = (kind: unknown) => ({
      ...view(),
      bidPhase: { ...view().bidPhase, kind },
    });
    const msg = (kind: unknown) => ({ type: 'game.state_update' as const, version: 1, payload: payload(kind) });
    expect(() => validateOutbound(msg('call'))).not.toThrow();
    expect(() => validateOutbound(msg('rob'))).not.toThrow();
    expect(() => validateOutbound(msg('grab'))).toThrow(/bidPhase\.kind must be 'call' or 'rob'/);
    expect(() => validateOutbound(msg(undefined))).toThrow(/bidPhase\.kind/);
  });

  it('协议⑦：decisions 的形状、键存在性与长度上界', () => {
    const withDecisions = (decisions: unknown) => ({
      type: 'game.state_update' as const,
      version: 1,
      payload: { ...view(), bidPhase: { ...view().bidPhase, decisions } },
    });
    const okOne = { seat: 0, kind: 'call', grab: true };
    expect(() => validateOutbound(withDecisions([okOne]))).not.toThrow();
    expect(() => validateOutbound(withDecisions([]))).not.toThrow();

    // 长度上界：一轮制最多 3 条
    expect(() =>
      validateOutbound(withDecisions([okOne, { seat: 1, kind: 'rob', grab: false }, { seat: 2, kind: 'rob', grab: true }, okOne])),
    ).toThrow(/at most 3 items/);

    // 键存在性：缺 seat 必须被拒（现全校验器从不检查键存在性）
    expect(() => validateOutbound(withDecisions([{ kind: 'call', grab: true }]))).toThrow(/must have a "seat" key/);
    // 座位必须是 0..2 的**整数**（`assertNum` 会放过 -1/99/1.5）
    expect(() => validateOutbound(withDecisions([{ seat: 9, kind: 'call', grab: true }]))).toThrow(/integer in 0\.\.2/);
    expect(() => validateOutbound(withDecisions([{ seat: 1.5, kind: 'call', grab: true }]))).toThrow(/integer in 0\.\.2/);
    // grab 必须是布尔
    expect(() => validateOutbound(withDecisions([{ seat: 0, kind: 'call', grab: 1 }]))).toThrow(/grab must be a boolean/);
  });
```

并在该文件的 `view()` 夹具里加 `baseScore: 15` 与 `bidPhase` 的两个新键。

- [ ] **Step 10: 跑全部判据 + 门禁**

```bash
pnpm run lint && pnpm run ci 2>&1 | tee .superpowers/sdd/table-a1-ci.log
```

Expected: 六阶段全过（**0 cached** —— 若看到 cached 要附 `--force` 重跑，本仓不接受缓存读数）。

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "feat(protocol): 协议③⑥⑦ 加法三项（叫抢措辞 kind / 叫抢决策 decisions / 牌桌底分）

纯加法，不动任何既有字段 —— 阶段 A 的第一步刻意排在破坏性的协议④ 之前，
这样每个任务结束 ci 仍能绿。

· PlayerView.baseScore（⑥）：GameSession 里早就有，view.builder 原样透传
· PlayerView.bidPhase.kind（③）：由 shared 的 bidKindOf 派生，view.builder 直接调
· PlayerView.bidPhase.decisions（⑦）：handleBid 每次决策追加一条，kind 按
  **决策那一刻**的 landlordCandidate 算（不是事后回推 —— 回推会让
  「第一家不叫、第二家叫」错报成「抢」）
· 出站校验器补齐：baseScore>0 · kind 枚举 · decisions 的形状/键存在性/整数座位/长度≤3
· 顺手订正两条失真注释（baseScore 默认 100→15；lastPlayerIdx 的「同名同义」）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A2: 🔴 协议 ④ —— 退役两字段 → `recentActions`（本片唯一的破坏性改动）

> ⚠️ **这个任务必然大范围打红 `tsc`**（夹具、索引类型、conformance 的手写线格式全都指向那两个字段）。
> 这是**预期的**，不是做错了。**把编译面集中在这一个任务里收干净** —— 下游任务不得再受它牵连。
> ⚠️ **本任务结束后必须立刻做 Task A3**（机器人的跟牌目标），中间不得插入别的任务。

**Files:**
- Create: `packages/shared/src/ddz/recent.ts`（投影的**唯一**实现）
- Create: `packages/shared/src/ddz/recent.test.ts`（窗口语义 + 两条不变式 + 等价性）
- Modify: `packages/protocol/src/views.ts`（删两字段、加 `recentActions`）
- Modify: `packages/protocol/src/validate.ts`（删 5 条旧校验、加 `recentActions` 校验）
- Modify: `packages/shared/src/index.ts`（导出新文件）
- Modify: `packages/game-service/src/game/view.builder.ts`（投影）
- Modify: `apps/client/src/stores/game.ts` · `apps/client/src/pages/table/table.vue` · `apps/client/src/composables/useTableSound.ts`
- Modify: `tools/mock-server/src/scripted-game.ts`
- Modify: `tools/conformance/src/lib/ddz-driver.ts` + `slices/slice-{09,10,11}-*.ts`（**类型与读点**；断言的重写是 Task A5）
- Modify: `scripts/browser-e2e.mjs`（`canPass` + `seedFinishedGame`）
- Modify: 全仓夹具（`tsc` 驱动）

**Interfaces:**
- Consumes: Task A1 的 `RecentAction` 类型
- Produces:
  - `shared`: `projectRecentActions(session): RecentAction[]`（窗口 2、旧→新、`kind === 'pass'` ⇒ `cards: null`）
  - `shared`: `RECENT_ACTIONS_WINDOW = 2`
  - `protocol`: `PlayerView.recentActions: RecentAction[]`
  - `client`: `store.recentActions` getter（缺字段 ⇒ `[]`）
  - ⚠️ **Task A2 不改出牌区的显示语义**：仍然只显示**最近一手**（窗口 2 的渲染是 Task B2）。

---

- [ ] **Step 1: 写失败判据 —— 新建 `packages/shared/src/ddz/recent.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { handlePlayCards, handlePass } from './play';
import { dealCards, createSession, GameState } from './game';
import { bidKindOf } from './bid';
import type { Card } from '@fight-the-landlord/protocol';
import { projectRecentActions, RECENT_ACTIONS_WINDOW } from './recent';

const c = (r: number): Card => ({ r, s: 0 });

/** 让三家进入出牌阶段（座位 0 当地主）：直接构造一个 playing 会话。 */
function playingSession() {
  const s = dealCards(createSession('ROOM1', ['u0', 'u1', 'u2']));
  return {
    ...s,
    state: GameState.Playing,
    currentPlayer: 0,
    lastPlayedHand: null,
    lastPlayerIdx: -1,
    actionLog: [],
  };
}

describe('projectRecentActions（协议 ④ / 上位 §4.4）', () => {
  /**
   * 🔴 **用户逐字确认的那三行**（上位 §4.4）—— 逐字变成用例：
   *   `A出3 → [3]` · `B出4 → [3,4]` · `C不出 → [4, 不出]`
   */
  it('用户逐字确认的语义：A出3 → [3] · B出4 → [3,4] · C不出 → [4, 不出]', () => {
    let s = playingSession();

    s = handlePlayCards(s, 'u0', [c(3)]);
    expect(projectRecentActions(s)).toEqual([{ seat: 0, cards: [c(3)] }]);

    s = handlePlayCards(s, 'u1', [c(4)]);
    expect(projectRecentActions(s)).toEqual([
      { seat: 0, cards: [c(3)] },
      { seat: 1, cards: [c(4)] },
    ]);

    s = handlePass(s, 'u2');
    expect(projectRecentActions(s)).toEqual([
      { seat: 1, cards: [c(4)] },
      { seat: 2, cards: null }, // 「不出」也占一手，且是显式的 null
    ]);
  });

  it('窗口恒 ≤ 2，且是**最后两条**动作（旧的被挤掉）', () => {
    let s = playingSession();
    s = handlePlayCards(s, 'u0', [c(3)]);
    s = handlePlayCards(s, 'u1', [c(4)]);
    s = handlePlayCards(s, 'u2', [c(5)]);
    const w = projectRecentActions(s);
    expect(w).toHaveLength(RECENT_ACTIONS_WINDOW);
    expect(w.map((a) => a.seat)).toEqual([1, 2]);
  });

  /** 不变式①：窗口两项**都是 null** ⟺ 上一次动作是使一墩结束的那次过牌。 */
  it('不变式①：两家连续过牌后窗口全是 null（一墩结束）', () => {
    let s = playingSession();
    s = handlePlayCards(s, 'u0', [c(3)]);
    s = handlePass(s, 'u1');
    s = handlePass(s, 'u2'); // 第二家过牌 ⇒ 一墩结束
    expect(projectRecentActions(s)).toEqual([
      { seat: 1, cards: null },
      { seat: 2, cards: null },
    ]);
    expect(s.lastPlayedHand).toBeNull();
  });

  /**
   * 🔴 不变式②（**真浏览器探针的依赖项**）：
   *   「窗口里有非 null」 ⟺ `lastPlayedHand !== null`
   *
   * 它是一条**导出性质**、不是规格条文 ⇒ 一旦不成立，探针的 `canPass` 会**静默走错分支**
   * （表现为 30 秒超时，而不是红）。所以必须在这里钉死。
   */
  it('不变式②：窗口里有非 null ⟺ lastPlayedHand !== null（穷举一局的每个中间态）', () => {
    const steps: Array<(s: ReturnType<typeof playingSession>) => ReturnType<typeof playingSession>> = [
      (s) => handlePlayCards(s, 'u0', [c(3)]),
      (s) => handlePlayCards(s, 'u1', [c(4)]),
      (s) => handlePass(s, 'u2'),
      (s) => handlePass(s, 'u0'), // 两家连续过牌 ⇒ 一墩结束
      (s) => handlePlayCards(s, 'u1', [c(5)]), // 墩首（lastPlayerIdx === 1）
      (s) => handlePass(s, 'u2'),
    ];
    let s = playingSession();
    const check1 = () => {
      const hasNonNull = projectRecentActions(s).some((a) => a.cards !== null);
      expect(hasNonNull, `v${s.version}：窗口非空 ⟺ lastPlayedHand 非空`).toBe(s.lastPlayedHand !== null);
    };
    check1(); // 开局：两边都「空」
    for (const step of steps) {
      s = step(s);
      check1();
    }
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/shared exec vitest run src/ddz/recent.test.ts
```

Expected: FAIL —— `Failed to resolve import "./recent"`。

- [ ] **Step 3: 建 `packages/shared/src/ddz/recent.ts`**

```ts
import type { RecentAction } from '@fight-the-landlord/protocol';
import type { GameSession } from './types';

/**
 * 桌面历史牌的**窗口大小**（协议 ④ / 上位 §4.4：「窗口 = 2 手」）。
 *
 * ⚠️ 窗口长度只在这里写一次 —— 别处（组件、判据、mock）一律引用它。
 */
export const RECENT_ACTIONS_WINDOW = 2;

/**
 * 把内部 `actionLog` 投影成出站的 `recentActions`（协议 ④）。
 *
 * **这是本投影的唯一实现。** 真源是 `actionLog`（`handlePlayCards` / `handlePass`
 * 在**每次**状态转移里各追加一条），`design.md` §4.2 的**例外说明**逐字准许
 * 「由 `actionLog` 派生的**公开信息**出站」—— `features.ts` 是同一个手法的第一个实例。
 *
 * 为什么**不**新增 `GameSession.recentActions` 状态：那会与 `actionLog` 记同一段历史
 * ⇒ 第二真源；而且要多三个清理点（`createSession` / `finalizeBidding` / `resetBidding`）。
 * 派生法让 `play.ts` 与 `GameSession` **一个字节不动**，且老会话（Redis 里没有新字段）照样成立。
 *
 * ⚠️ **`cards: null` 是「不出」的显式事实**，不是缺省值。
 * ⚠️ 出站安全性：它只含**已经打出过的牌**（公开信息），**不含任何未出的手牌**。
 */
export function projectRecentActions(session: Pick<GameSession, 'actionLog'>): RecentAction[] {
  return (session.actionLog ?? []).slice(-RECENT_ACTIONS_WINDOW).map((entry) => ({
    seat: entry.seat,
    // `kind === 'pass'` 的 `cards` 恒为 `[]`（§3.2）⇒ 出站时归一成 `null`
    cards: entry.kind === 'pass' ? null : entry.cards,
  }));
}
```

- [ ] **Step 4: `packages/shared/src/index.ts`** 加上导出

```ts
export { projectRecentActions, RECENT_ACTIONS_WINDOW } from './ddz/recent';
```

（照该文件里 `handleBid` / `bidKindOf` 那几行的形态写。）

- [ ] **Step 5: `packages/protocol/src/views.ts` —— 替换两字段**

`PlayerView` 里删掉这两行：

```ts
  lastPlayedHand: LastPlayedHand | null;
  lastPlayerIdx: number;
```

换成：

```ts
  /**
   * 桌面历史牌（协议 ④）：**窗口 2、旧 → 新、「不出」也占一手**。
   *
   * ⚠️ 它**取代**了旧的 `lastPlayedHand` + `lastPlayerIdx` 两个字段（`D10`：替换，不并存）。
   * ⚠️ **规则态仍在服务端**：跟牌目标（`type` / `keyRank` / `length`）**不在**这里 ——
   * 它是**显示**用的窗口，不是判定输入（判定输入见 `GameSession.lastPlayedHand`）。
   */
  recentActions: RecentAction[];
```

⚠️ **`LastPlayedHand` 那个 interface 留着**（`shared/ddz/types.ts:1` 仍在 import 它作为规则态的形状）。

- [ ] **Step 6: `packages/protocol/src/validate.ts` —— 换掉那 5 条**

删掉 `assertNum(v.lastPlayerIdx, ...)`（`:124`）与整段 `if (v.lastPlayedHand !== null) { ... }`（`:126-131`），换成：

```ts
  // 协议 ④：窗口 = 2、「不出」用 null 表示
  if (!Array.isArray(v.recentActions)) {
    throw new ProtocolError(`${path}.recentActions must be an array`);
  }
  if (v.recentActions.length > 2) {
    throw new ProtocolError(
      `${path}.recentActions must have at most 2 items (窗口 2), got ${v.recentActions.length}`,
    );
  }
  v.recentActions.forEach((a, i) => {
    const p = `${path}.recentActions[${i}]`;
    if (!isObj(a)) throw new ProtocolError(`${p} must be an object`);
    // ⚠️ 现全校验器**从不检查键存在性** ⇒ 必须显式判，否则「cards 缺失」与
    //    「cards: null」在窄化后无法区分（而后者是合法的「不出」）
    if (!('seat' in a)) throw new ProtocolError(`${p} must have a "seat" key`);
    if (!('cards' in a)) throw new ProtocolError(`${p} must have a "cards" key`);
    assertInt(a.seat, `${p}.seat`, 0, 2);
    if (a.cards === null) return; // 「不出」—— 合法且**必须**是这个字面值
    // 🔴 不得把 null 塞进 assertCardArray（它与 hand/bottomCards 共用、会因 null 变红）
    assertCardArray(a.cards, `${p}.cards`);
    if ((a.cards as Card[]).length === 0) {
      throw new ProtocolError(`${p}.cards must not be empty (空手出牌不存在；「不出」用 null 表示)`);
    }
  });
```

⚠️ 若该文件的 import 里没有 `Card` 类型，补上（`assertCardArray` 已经用它）。

- [ ] **Step 7: `packages/game-service/src/game/view.builder.ts` —— 投影**

import 里加 `projectRecentActions`，并把 `view` 字面量里的两行：

```ts
    lastPlayedHand: session.lastPlayedHand,
    lastPlayerIdx: session.lastPlayerIdx,
```

换成：

```ts
    // 协议 ④：窗口由 shared 的**唯一**投影实现给出（本处不得自己再写一份 slice）
    recentActions: projectRecentActions(session),
```

⚠️ 同文件 `:87-89` 那段「内部形状**就是**契约形状……原样透传」的注释**已经不再成立**（`recentActions` 是派生出来的，不是透传的）⇒ **改掉它**，否则下一个人会照着它去「修」投影。改成：

```ts
    // ⚠️ **这里不再是原样透传**（协议 ④ 起）：`recentActions` 是 `actionLog` 的**投影**
    // （`shared/ddz/recent.ts` 是唯一实现）。规则的跟牌目标仍由服务端内部的
    // `session.lastPlayedHand` 持有，**不出站**。
```

- [ ] **Step 8: 客户端最小适配**（显示语义**不变**，仍然只显示最近一手）

`apps/client/src/stores/game.ts` —— getter 替换：

```ts
    /**
     * 桌面历史牌（协议 ④）：窗口 2、旧 → 新、「不出」是显式的 `cards: null`。
     * ⚠️ 缺字段（真浏览器探针的 `seedFinishedGame` 注入的残缺视图）⇒ `[]`，**不抛错**（R661）。
     */
    recentActions: (s): RecentAction[] => s.view?.recentActions ?? [],
    /**
     * **最近一次出牌**（不是最近一次动作 —— 过牌不是出牌）。
     *
     * ⚠️ 它取代了旧的 `lastPlayedHand` getter。`cards === null` 的项（「不出」）在这里被跳过。
     * ⚠️ 本 getter 是**过渡形态**：Task B2 的窗口渲染直接读 `recentActions`，那时它会被删掉。
     */
    lastPlay: (s): RecentAction | null => {
      const w = s.view?.recentActions ?? [];
      for (let i = w.length - 1; i >= 0; i -= 1) {
        if (w[i]!.cards !== null) return w[i]!;
      }
      return null;
    },
```

（import 里把 `type Card` 换成/加上 `type RecentAction`；`lastPlayedHand` getter 删掉。）

`apps/client/src/pages/table/table.vue` —— 三处替换：

```ts
const lastPlayerIdx = computed(() => store.view?.lastPlayerIdx ?? -1);
const playedCards = computed<readonly Card[] | null>(() => store.lastPlayedHand?.cards ?? null);
```
换成
```ts
/**
 * 最近一次出牌（协议 ④）：**过渡形态** —— 窗口里最后一条 `cards !== null` 的项。
 * ⚠️ 与旧的 `lastPlayedHand` + `lastPlayerIdx` **显示语义逐字相同**（Task B2 才改成两个实例）。
 * ⚠️ 等价性由 `shared/ddz/recent.test.ts` 的不变式②钉住：窗口里有非 null ⟺ 有活着的上一手。
 */
const lastPlayerIdx = computed(() => store.lastPlay?.seat ?? -1);
const playedCards = computed<readonly Card[] | null>(() => store.lastPlay?.cards ?? null);
```

同文件 `:14-15` / `:143-148` / `:163-164` 的 R656 注释同步订正（「服务端没有字段能表达『谁刚过了牌』」**已经不成立** —— 现在 `cards: null` 就是原话）。⚠️ 但**先不要删 `bubble`**（那是 Task B2 的事，本任务只换数据源）。

`apps/client/src/composables/useTableSound.ts` —— 王单张音效改读**窗口的最新一条**：

```ts
  // ── 大小王**单张**出牌（spec §10 的例外）：最新一条动作恰好是一张王 ────────
  watch(
    () => store.recentActions.map((a) => `${a.seat}:${a.cards === null ? 'pass' : a.cards.map((c) => c.r).join('.')}`).join(','),
    () => {
      const newest = store.recentActions[store.recentActions.length - 1];
      // ⚠️ 过牌（cards === null）**不出声** —— 旧实现读的是「上一手牌」，
      //    它在过牌时**不变**，于是「A 出小王、B 过、C 过」会让音效**响两次**（顺手修掉）。
      if (!newest || newest.cards === null) return;
      if (newest.cards.length !== 1) return;
      const r = newest.cards[0]!.r;
      if (r === DOUZERO_LITTLE_JOKER) playCue('SingleLittleJoker');
      else if (r === DOUZERO_BIG_JOKER) playCue('SingleBigJoker');
    },
  );
```

同文件 `:11` 的分类注释同步订正（「谁刚过了牌」现在是服务端事实）。

- [ ] **Step 9: mock 对局 `tools/mock-server/src/scripted-game.ts`**

把两处私有状态（`:58-59`）：

```ts
  private lastPlayedHand: PlayerView['lastPlayedHand'] = null;
  private lastPlayerIdx = -1;
```
换成：
```ts
  /**
   * 协议 ④ 的窗口（**与 `shared/ddz/recent.ts` 同形实现** —— mock 只依赖 protocol，
   * 不为这三行加一个 shared 依赖；形状与窗口长度**逐字对齐**那一份）。
   */
  private recentActions: PlayerView['recentActions'] = [];
```

`deal()`（`:84-85`）里两行 → `this.recentActions = [];`
`play()`（`:119-125`）里写 `lastPlayedHand` + `lastPlayerIdx` 的两行 → 换成 push `{ seat, cards }` 并 `slice(-2)`。
`pass()`（`:141-154`）—— **两条返回路径都要 push `{ seat, cards: null }`**（`slice(-2)`），
并把「两家过牌时 `lastPlayedHand = null`」的那半句换掉（窗口不需要被清，它天然表达）。
`viewFor()`（`:199-200`）→ `recentActions: this.recentActions`。

- [ ] **Step 10: conformance 的**类型与读点**（`tools/conformance/src/`）**

`lib/ddz-driver.ts`：
- `PlayViewWire`（`:51-52`）两行 → `recentActions: { seat: number; cards: Card[] | null }[];`
- `LastPlayedHandWire`（`:32-38`）**删掉**（`checkSingleCaliber` 的重写见 Task A5；
  本步先让它编译过：把 `checkSingleCaliber` 的入参从 `LastPlayedHandWire` 换成
  「窗口里最后一条 `cards !== null` 的项」的窄类型，**断言语义暂不加强**）

`slice-09-play-rotation.ts` / `slice-10-settlement.ts` / `slice-11-robot-system.ts`：
把所有 `view.lastPlayedHand` / `view.lastPlayerIdx` 的读点换成
「`view.recentActions` 里最后一条 `cards !== null` 的项」的读法（**语义不变**）。
⚠️ `slice-11:856-857` 那段「`lastPlayerIdx` 是**唯一在线来源**」的注释**现在就改掉**
（改成「窗口里最后一条**出牌**项的 `seat`」）—— 留着它会误导 Task A5 的实施者。

- [ ] **Step 11: 真浏览器探针 `scripts/browser-e2e.mjs`**

三处（**逐条改，每处写清理由**）：

```js
// :319 —— READ_STATE 里的 canPass
// 旧：store.lastPlayedHand !== null && !== undefined
// 新：窗口里有非 null ⇒ 有人出过牌 ⇒ 可以过牌（等价性见 shared/ddz/recent.test.ts 的不变式②）
canPass: (store.recentActions ?? []).some((a) => a.cards !== null),
```

```js
// :558 —— seedFinishedGame 注入的假视图
// 旧：lastPlayedHand: null, currentPlayer: 0, turnDeadlineAt: null
// 新：删掉 lastPlayedHand / lastPlayerIdx 两个退役键。
// ⚠️ **刻意不补 recentActions / baseScore / playPhase** —— 这个残缺视图正是
//    R661 容忍判据的载体（客户端必须用 `?.` + 缺值兜底）。
//    补全它就等于把那条判据的载体拆了。
currentPlayer: 0, turnDeadlineAt: null,
```

```js
// :793 —— autoPlayUntilEnded 的分支
// 旧：if (store.lastPlayedHand == null) { 打一张 } else { 过牌 }
// 新：同上判据（走 recentActions）
if (!(store.recentActions ?? []).some((a) => a.cards !== null)) { /* 首出：打一张 */ }
```

- [ ] **Step 12: 全仓夹具（`tsc` 驱动，**逐个补，不许批量替换**）**

```bash
pnpm run lint
```

已知起点（不完整，以 `tsc` 的输出为准）：

| 文件 | 改法 |
|---|---|
| `apps/client/test/helpers/fake-socket.ts:137-138` | 两行 → `recentActions: []` |
| `apps/client/test/action-feedback.test.ts:94-95 / :145 / :183 / :198` | 四处 `lastPlayedHand/lastPlayerIdx` → `recentActions: [{ seat, cards }]`（**逐处看语义再改**：`:145`/`:198` 是「没有出牌」⇒ `[]`；`:183` 是「座位 1 出的那一手」⇒ `[{ seat: 1, cards: makeCards(20) }]`） |
| `apps/client/test/table-play-ui.test.ts:59-60 / :228` | 同上（`:59` 是「有人出过」⇒ 带项；`:228` 是首出 ⇒ `[]`） |
| `apps/client/test/table-ended-ui.test.ts:74-75` | → `recentActions: []` |
| `apps/client/test/card-hand-interaction.test.ts:88-89` | → `recentActions: []` |
| 🔴 `apps/client/test/table-bid-bottom.test.ts:285-286` | **裸 `PlayerView` 字面量**（不走 fixture）⇒ 单独改 |
| `packages/protocol/src/{messages,rpc,robot}.test.ts` | 各一处视图夹具 |
| `packages/game-service/test/*.test.ts`（11 + 10 + 6 + 3 + …） | 会话夹具是 `GameSession`（**内部字段不动**）⇒ 多数**不受影响**；只有**视图侧**的夹具要改 |
| `packages/robot-service/test/*` | 同上 |

⚠️ **不许用 `sed` 批量替换** —— 每一处的语义不同（「没有出牌」vs「有人出了这一手」）。
一旦批量替换，`[]` 与 `[{…}]` 会互相污染，而**判据可能仍然绿**（那是假绿）。

- [ ] **Step 13: 跑全部判据 + 门禁 + 探针（gate）**

```bash
pnpm run lint
pnpm run ci 2>&1 | tee .superpowers/sdd/table-a2-ci.log

# 探针必须真跑（它读 store，改了 canPass 就要真跑一遍）
pnpm run e2e:browser 2>&1 | tee .superpowers/sdd/table-a2-probe-gate.log
```

Expected: `ci` 六阶段全过；探针 **gate 22/22 · 0 ❌**。
⚠️ 探针若首跑红在 `[01] 探针自身未抛异常`（`webSocketDebuggerUrl`）—— 那是**已知的启动竞态**
（交接 §3），复跑一次；**记成「首跑红 / 复跑绿 ⇒ 未复现」，不得写成「通过」**。

- [ ] **Step 14: 提交**

```bash
git add -A
git commit -m "feat(protocol)!: 协议④ 退役 lastPlayedHand/lastPlayerIdx → recentActions（窗口 2）

本片唯一的破坏性改动。**只在出站面上破坏** —— 规则态
（GameSession.lastPlayedHand / lastPlayerIdx）与 LastPlayedHand **类型**一个字不动。

· recentActions 由 shared/ddz/recent.ts 的 projectRecentActions 从 actionLog **派生**
  （design.md §4.2 的例外说明逐字准许；features.ts 是同手法的第一个实例）。
  不新增 GameSession 状态：那会与 actionLog 记同一段历史 ⇒ 第二真源 + 三个清理点。
  派生法让 play.ts 与 play.test.ts（49 处）完全不动，且兼容 Redis 里的老会话。
· 出站校验器：删 5 条旧校验，新增「数组 ≤ 2 · 键存在性 · seat 是 0..2 整数 ·
  cards 是 null 或**非空** Card[]」（不得把 null 塞进 assertCardArray —— 它与
  hand/bottomCards 共用）
· 客户端**显示语义不变**（仍只显示最近一手），窗口渲染是阶段 B 的事
· 顺手修掉一处潜在缺陷：王单张音效原先读「上一手牌」，而过牌不改变它 ⇒
  「A 出小王、B 过、C 过」会响两次；改读窗口最新一条后过牌不再出声
· 探针 canPass 改读 recentActions（等价性由 recent.test.ts 的不变式②钉住）
· seedFinishedGame 的假视图**刻意不补**新键 —— 它是 R661 容忍判据的载体

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A3: 🔴 协议 ④ 的连带面 —— `RobotFeatures.lastMoveMeta` + 两个读点

> ⚠️ **必须紧跟 Task A2**：A2 之后机器人**拿不到跟牌目标**了（它原先从 `view.lastPlayedHand`
> 这个**显示字段**里偷规则输入）⇒ 不修的话它会拿 `undefined` 去决策，**表现为乱出牌而不是编译错**
> —— 这是最危险的一类缺陷。

**Files:**
- Modify: `packages/protocol/src/robot.ts`（`RobotFeatures` 加一键 + 写明它为什么存在）
- Modify: `packages/shared/src/ddz/features.ts`（投影）
- Modify: `packages/shared/src/ddz/features.test.ts`
- Modify: `packages/robot-service/src/robot/bot.player.ts`（改读 `features.lastMoveMeta`）
- Modify: `packages/robot-service/test/bot.player.test.ts` · `test/robot.decide.test.ts`
- Modify: `packages/game-service/src/game/game.service.ts`（`ruleDecision` 换输入源）
- Modify: `packages/game-service/test/game.service.test.ts` · `test/game.robot.test.ts`
- Modify: `packages/protocol/src/rpc.test.ts` 的 `features()` 夹具（`:50`）

**Interfaces:**
- Consumes: `GameSession.lastPlayedHand`（内部规则态，未变）
- Produces:
  - `protocol`: `RobotFeatures.lastMoveMeta: { type: number; keyRank: number; length: number } | null`
  - `game-service`: `private ruleDecision(hand: Card[], target: BeatTarget | null, state: GameState): RobotDecideResponse`

---

- [ ] **Step 1: 写失败判据 —— `packages/shared/src/ddz/features.test.ts`**

```ts
  it('协议④的连带面：lastMoveMeta 与 session.lastPlayedHand 的规则字段一致', () => {
    const s = makeSession(); // 该文件既有夹具，:42 附近
    s.lastPlayedHand = { cards: [{ r: 5, s: 0 }], type: 1, keyRank: 5, length: 0 };
    s.lastPlayerIdx = 1;
    const f = buildPublicFeatures(s, 0);
    expect(f.lastMoveMeta).toEqual({ type: 1, keyRank: 5, length: 0 });
    expect(f.lastMove).toEqual([5]); // 既有字段不变
    expect(f.lastMovePosition).toBe(botPositionOf(s, 1));
  });

  it('没有上一手牌 ⇒ lastMoveMeta 为 null（而不是一个「空手」对象）', () => {
    const s = makeSession();
    s.lastPlayedHand = null;
    expect(buildPublicFeatures(s, 0).lastMoveMeta).toBeNull();
  });
```

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/shared exec vitest run src/ddz/features.test.ts
```

Expected: FAIL —— `lastMoveMeta` 是 `undefined`。

- [ ] **Step 3: `packages/protocol/src/robot.ts` —— 加字段并写明**它为什么存在**

`RobotFeatures` 里，在 `lastMove` 之后加：

```ts
  /**
   * 上一手牌的**规则字段**（`type` / `keyRank` / `length`）—— 跟牌判定要用它。
   *
   * 🔴 **它为什么存在**（协议 ④ 的连带面，**不是**一个可有可无的冗余字段）：
   * 协议 ④ 之前，机器人是从 `PlayerView.lastPlayedHand` 里拿这个目标的 ——
   * 那是一个**显示字段**。退役它之后，机器人（**按设计没有 `session`**，
   * 见 `no-session-boundary.gate`）就失去了唯一的规则输入来源。
   * 而本仓**明令禁止重新解析 `cards` 反推** `type`/`length`（玩法 §5 要点 / `play.ts:68`）⇒
   * 必须由服务端把**已经算好的**规则字段投影过来。
   *
   * 🔵 这一补**修好了一层错位**：规则输入现在回到正路（由 session 投影出的公开信息，
   * 与 `playedCards` / `actionSeq` 同一来源），**不是**从显示层偷。**别把它当回归来「修」掉**。
   *
   * `null` = 尚无上一手牌（首出）。
   */
  lastMoveMeta: { type: number; keyRank: number; length: number } | null;
```

- [ ] **Step 4: `packages/shared/src/ddz/features.ts` —— 投影**

`return { ... }` 里，在 `lastMove` 之后加：

```ts
    // 协议④的连带面：跟牌目标只带**规则字段**（牌面已在 `lastMove` 里，不重复）
    lastMoveMeta: session.lastPlayedHand
      ? {
          type: session.lastPlayedHand.type,
          keyRank: session.lastPlayedHand.keyRank,
          length: session.lastPlayedHand.length,
        }
      : null,
```

- [ ] **Step 5: `packages/robot-service/src/robot/bot.player.ts` —— 改读**

```ts
    const target = req.features.lastMoveMeta ?? { type: HandType.Invalid, keyRank: 0, length: 0 };
```

（原先那行读的是 `req.view.lastPlayedHand` —— 那个字段已经不存在了。**其余一个字不改**。）

- [ ] **Step 6: `packages/game-service/src/game/game.service.ts` —— `ruleDecision` 换输入源**

把 `ruleDecision(view: PlayerView)`（`:616`）改成显式吃「手牌 + 跟牌目标 + 阶段」：

```ts
  /**
   * **本地规则引擎**的兜底决策（§9.4 的「失败/非法 ⇒ 规则引擎」）。
   *
   * ⚠️ **入参从 `PlayerView` 改成「手牌 + 跟牌目标 + 阶段」**（协议 ④ 的连带面）：
   * `view.lastPlayedHand` 已经退役，而跟牌目标是**规则输入**、本来就不该从显示层取。
   * 调用方（`playRobotTurn`）手里有 `session`，目标直接来自 `session.lastPlayedHand` ——
   * **不需要**任何投影或再解析（R157：不得重新解析 `cards` 反推）。
   */
  private ruleDecision(
    hand: Card[],
    target: BeatTarget | null,
    state: GameState,
  ): RobotDecideResponse {
    if (state === GameState.Bidding) return { kind: 'pass', source: 'rule' };

    const beat = target ?? { type: HandType.Invalid, keyRank: 0 as Rank, length: 0 };
    const beating = findSmallestBeatingCards(hand, beat);
    if (beating && beating.length > 0) {
      return { kind: 'play', cards: beating.map((card) => card.r), source: 'rule' };
    }
    return { kind: 'pass', source: 'rule' };
  }
```

⚠️ 三个调用点（`:565` 与 `:574`，共两处 `this.ruleDecision(view)`）改成：

```ts
    const ruleArgs = [view.hand, session.lastPlayedHand, session.state] as const;
    // :565
    const first = decided ?? this.ruleDecision(...ruleArgs);
    // :574
    const fallback = this.ruleDecision(...ruleArgs);
```

（import 里补 `BeatTarget` / `Rank` —— 照 `shared` 既有导出。）

⚠️ `:634` 的 `view.lastPlayedHand` 若还有别的读点，同法处理（`grep -n "lastPlayedHand" packages/game-service/src/` 必须**只剩注释**）。

- [ ] **Step 7: 补 `RobotFeatures` 的夹具**

```bash
pnpm run lint
```

`packages/protocol/src/rpc.test.ts:50` 的 `features()` 夹具加 `lastMoveMeta: null`；
其余以 `tsc` 输出为准。

- [ ] **Step 8: 跑判据 + 门禁**

```bash
pnpm run ci 2>&1 | tee .superpowers/sdd/table-a3-ci.log
```

Expected: 六阶段全过。⚠️ 特别看 `packages/robot-service/test/*`（**它是唯一会发现「机器人拿到 undefined」的地方**）。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "fix(protocol): 协议④的连带面 —— RobotFeatures.lastMoveMeta（机器人的跟牌目标）

协议④ 退役 PlayerView.lastPlayedHand 之后，机器人与本地规则兜底**失去了跟牌目标**。
它们原先从一个**显示字段**里取规则输入 —— 这一补把它挪回正路。

· RobotFeatures 加 lastMoveMeta（type/keyRank/length；牌面已在 lastMove 里，不重复）
  由 features.ts 从 session.lastPlayedHand 投影（与 playedCards/actionSeq 同一来源）
· bot.player.ts 改读 features.lastMoveMeta
· game.service.ruleDecision 换签名：入参改成「手牌 + 跟牌目标 + 阶段」，
  目标直接来自 session（调用方本就有），**不投影、不再解析**（R157）
· 为什么不能重新解析 cards 反推 type/length：玩法 §5 要点 / play.ts:68 明令禁止

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A4: conformance 09/10/11 的断言重写 + 基线纪律

> 🔴 **本任务会出现一个必须正面处理的冲突**：C19 的在线判据
> （`checkSingleCaliber` 断言 `type` / `keyRank` / `length`）**在新契约下没有输入了** ——
> 那三个字段是**规则字段**，协议 ④ 之后**不再出站**（它们只活在 `RobotFeatures.lastMoveMeta`
> 这个**内部 RPC** 上，而 conformance 走的是客户端 WS 面）。
> ⇒ 按规格 §2.9 的纪律：**补等价判据把 count 补回，不得下调 `baselines.json` 的 floor**。

**Files:**
- Modify: `tools/conformance/src/lib/ddz-driver.ts`（`checkSingleCaliber` 重写 + 新增 `checkRecentWindow`）
- Modify: `tools/conformance/src/slices/slice-09-play-rotation.ts` · `slice-10-settlement.ts` · `slice-11-robot-system.ts`
- Modify: `packages/game-service/test/view.builder.test.ts`（**接收** C19 的口径判据）
- Modify: `tools/conformance/baselines.json`（**只在首次 CI 绿跑之后**回填）

**Interfaces:**
- Consumes: `PlayViewWire.recentActions`
- Produces: `checkRecentWindow(view, expect, violations)` · `lastPlay(view): { seat, cards } | null`

---

- [ ] **Step 1: `ddz-driver.ts` —— 换掉 C19 的在线判据**

删掉 `checkSingleCaliber`（`:237-257`），换成两个函数：

```ts
/** 窗口里**最后一条出牌**（跳过「不出」的项）。`null` = 还没有人出过牌。 */
export function lastPlay(
  view: PlayViewWire,
): { seat: number; cards: Card[] } | null {
  for (let i = view.recentActions.length - 1; i >= 0; i -= 1) {
    const a = view.recentActions[i]!;
    if (a.cards !== null) return { seat: a.seat, cards: a.cards };
  }
  return null;
}

/**
 * 协议 ④ 的**在线判据**（取代原 `checkSingleCaliber` 的线格式部分）。
 *
 * 刚打完一手牌之后，窗口的最新一条必须**就是**那一手：`seat` 是行动者、
 * `cards` 逐张等于所出的牌、且窗口长度 ≤ 2。
 *
 * ⚠️ **`type` / `keyRank` / `length` 不再在线可观测** —— 协议 ④ 之后它们是**规则字段**、
 * 不出站。那条口径（C19：单张的 `keyRank` 直接等于所出牌点数）**搬到了单测**
 * （`packages/game-service/test/view.builder.test.ts`，见 Step 4）—— 本步是**等价迁移**，
 * 不是删除。
 */
export function checkRecentWindow(
  view: PlayViewWire,
  played: Card[],
  actorSeat: number,
  violations: string[],
): void {
  const where = `v${view.version}`;
  const w = view.recentActions;
  if (!Array.isArray(w)) {
    violations.push(`${where}: recentActions 不是数组（${JSON.stringify(w)}）`);
    return;
  }
  if (w.length > 2) violations.push(`${where}: 窗口长度 ${w.length} > 2`);
  const newest = w[w.length - 1];
  if (!newest) {
    violations.push(`${where}: 刚打出 ${JSON.stringify(played)}，但窗口是空的`);
    return;
  }
  if (newest.cards === null) {
    violations.push(`${where}: 刚打出 ${JSON.stringify(played)}，但窗口最新一条是「不出」`);
    return;
  }
  if (newest.seat !== actorSeat) {
    violations.push(`${where}: 窗口最新一条的 seat=${newest.seat}，行动者却是 ${actorSeat}`);
  }
  if (JSON.stringify(newest.cards) !== JSON.stringify(played)) {
    violations.push(
      `${where}: 窗口最新一条的 cards=${JSON.stringify(newest.cards)}，所出=${JSON.stringify(played)}`,
    );
  }
}

/**
 * 「**「不出」也占一手**」的在线判据（上位 §4.4 的用户逐字裁决）。
 *
 * 旧契约**根本表达不出**这件事（没有任何字段能说「谁刚过了牌」）⇒ 这是一条**新增**的判据，
 * 也是把上面那条口径搬走后把 count 补回来的主要来源。
 */
export function checkPassOccupiesSlot(
  view: PlayViewWire,
  passerSeat: number,
  violations: string[],
): void {
  const where = `v${view.version}`;
  const newest = view.recentActions[view.recentActions.length - 1];
  if (!newest) {
    violations.push(`${where}: 有人过牌，但窗口是空的`);
    return;
  }
  if (newest.cards !== null) {
    violations.push(`${where}: 有人过牌，但窗口最新一条是出牌（${JSON.stringify(newest.cards)}）`);
    return;
  }
  if (newest.seat !== passerSeat) {
    violations.push(`${where}: 窗口最新一条的 seat=${newest.seat}，过牌者却是 ${passerSeat}`);
  }
}
```

- [ ] **Step 2: `slice-09-play-rotation.ts` —— 逐手改调用点**

| 位置 | 现状 | 改成 |
|---|---|---|
| `:175` | info：「每一手 `lastPlayedHand` 的口径（keyRank=内部 Rank / length=0 / type=1）」 | 改成「每一手 `recentActions` 的窗口口径（最新一条 = 所出牌、seat = 行动者、长度 ≤ 2）」 |
| 逐手调用处 | `checkSingleCaliber(view, played, violations)` | `checkRecentWindow(view, [played], actorSeat, violations)`；**过牌那一步再加** `checkPassOccupiesSlot(view, actorSeat, violations)` |
| `:283` | `checks.eq(firstView(roomB).lastPlayedHand, null, '两家过牌后 lastPlayedHand 归 null（§6.2-5）')` | 改成「两家过牌后窗口两项**都是 null**」：<br>`const w = firstView(roomB).recentActions; checks.ok(w.length === 2 && w.every((a) => a.cards === null), '两家过牌后窗口全是「不出」（§6.2-5）')` |
| `:355-376`（场景 C，C18 反例） | 起点 `lastPlayedHand === null`；被拒的过牌不写出 `lastPlayedHand`；恢复后 `keyRank === smallest.r` | 起点改成「窗口里没有非 null 项」；被拒的过牌**不得改变窗口**（长度与内容逐字不变）；恢复后「窗口最新一条的 `cards` 等于那一手」 |

- [ ] **Step 3: `slice-10-settlement.ts` / `slice-11-robot-system.ts`**

- `slice-10`：`:352` / `:505` 的 info 口径改写；`:443` 同 slice-09 的「两家过牌」那条。
- `slice-11`：
  - `checkRobotHand`（`:252-284`）：`lastPlayerIdx` → 「窗口里最后一条**出牌**项的 `seat`」；
    `lastPlayedHand.cards` 非空 → 同前；`type !== Invalid` / `length >= 0` / `keyRank ∈ cards 的点数集合`
    / 单张时 `keyRank === cards[0].r` **这四条在线判据没有输入了** ⇒ **删掉**（它们的等价判据在
    `view.builder.test.ts`，见 Step 4）⇒ ⚠️ **这里就是 count 会掉的地方，必须在 Step 5 补回来**。
  - `pickHumanAction`（`:300-312`）：`lph.cards.length === 1 && view.lastPlayerIdx !== humanSeat`
    → 用 `lastPlay(window)` 的两个读法。
  - `observeRobotHand`（`:854-876`）：归属判定改成「窗口里最后一条出牌项的 `seat`」；
    「这一版没变」的判据改成比较 `JSON.stringify(window)`。
    ⚠️ **注释也改**（`:856-857` 的「`lastPlayerIdx` 是唯一在线来源」现在是错的）。
  - `:106` 的 `HandType.Invalid` 若只用于 `lastPlayedHand.type` ⇒ 随之删掉（免得变成死条目，R377）。

- [ ] **Step 4: 把搬走的口径落到单测 —— `packages/game-service/test/view.builder.test.ts`**

```ts
  it('协议④ 的等价迁移：单张的规则字段（type/keyRank/length）仍然正确（原 C19 的在线口径）', () => {
    // ⚠️ 这三个字段**不再出站**（协议 ④）⇒ 在线判据（conformance）没有输入了。
    //    等价判据落在这里：**直接断言 session 的三个规则字段**，
    //    它是 `RobotFeatures.lastMoveMeta` 的真源（Task A3）。
    const session = makeSession({
      lastPlayedHand: { cards: h(5), type: 1, keyRank: 5, length: 0 },
      lastPlayerIdx: 0,
    });
    const view = buildPlayerView(session, 1);
    expect(view.recentActions[0]).toEqual({ seat: 0, cards: h(5) }); // 线格式只剩牌面
    // 口径仍在服务端：
    expect(session.lastPlayedHand!.keyRank).toBe(5);
    expect(session.lastPlayedHand!.length).toBe(0);
    expect(session.lastPlayedHand!.type).toBe(1);
  });
```

- [ ] **Step 5: 基线纪律（**三步都要做**）**

1. **先跑一遍看真实条数**（真栈在跑）：

```bash
docker compose up -d --force-recreate   # 片② 的教训：本机跑全套会把栈改坏，先重建
node tools/conformance/src/run.ts --list | head -40   # 看切片清单与顺序
pnpm run conformance 2>&1 | tee .superpowers/sdd/table-a4-conformance.log
```

2. **对照 `tools/conformance/baselines.json` 的 `full` 列**：
   - **09 / 10 / 11 三片的实测条数不得低于现基线**（160 / 185 / 50）。
   - 若某片**真的**变少（Step 3 删掉那四条口径是**唯一**的正当理由）⇒ **必须在同一片里补上等价的新判据**
     把 count 补回。可用的新判据（协议 ④ 才让它成立的）：
     - 窗口长度 ≤ 2（每一手都查）
     - 「不出」占一手（`checkPassOccupiesSlot`，每一手过牌都查）
     - 窗口里最后一条非 null 项 ⟺ 有人出过牌（不变式②的在线形态，每个中间态都查）
     - 窗口里非 null 项的 `seat` 与实际出牌者一致
   - **不得下调 floor。** 若确实补不回来，**停下来问用户**（这是一条需要裁决的记账）。
3. `render` / `full` **两列都看**（09/10/11 只在 `full` 列 ⇒ 若新增了任何 render 侧的东西也要跟）。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "test(conformance): 09/10/11 跟上协议④（窗口口径 + 「不出」占一手）

· ddz-driver：删 checkSingleCaliber、新增 lastPlay / checkRecentWindow /
  checkPassOccupiesSlot
· C19 的在线口径（type/keyRank/length）在协议④ 之后**没有输入**了 —— 那三个是
  规则字段、不再出站（只活在 RobotFeatures.lastMoveMeta 这个内部 RPC 上）
  ⇒ **等价迁移**到 view.builder.test.ts 的单测，不是删除
· 补回的判据：窗口长度 ≤2 · 「不出」占一手 · 「窗口有非 null ⟺ 有人出过牌」（不变式②）
  · 非 null 项的 seat = 实际出牌者 —— 后两条是**旧契约根本表达不出**的性质
· 基线：09/10/11 的条数**不得低于**现基线；本片不得下调 floor
· 如实记：本机跑全套会把栈改坏 ⇒ 跑完 force-recreate（片② 的既有教训）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A5: 文档面 + 死脚本

**Files:**
- Modify: `docs/design.md`（§3.2 · §4.2 · §6.4 裁剪表 · §4.2 例外说明）
- Modify: `docs/client-protocol.md`（§5）
- Modify: `docs/games/doudizhu.md`（§3.1 计数器表旁补 `decisions`；§6.1-5 旁补一句「桌面历史牌是出站投影」）
- Delete: `test-full-game.ts` · `test-full-game.js`

⚠️ **删死脚本需要用户确认**（规格 §6 订正表第 5 条）—— **没确认就跳过这一步并如实记**，不要自己决定删。

---

- [ ] **Step 1: `docs/design.md` §4.2 的 `PlayerView`（`:474-499`）**

按 Task A1/A2 的终态改：删 `lastPlayedHand` / `lastPlayerIdx` 两行，加

```ts
  baseScore: number;                        // 本局底分（协议⑥）
  recentActions: { seat: number; cards: number[] | null }[];  // 协议④：窗口 2、旧→新、「不出」是显式的 null
```

`bidPhase` 里加

```ts
    kind: 'call' | 'rob';                   // 协议③：本行动者该用哪套措辞
    decisions: { seat: number; kind: 'call' | 'rob'; grab: boolean }[];  // 协议⑦：本轮已发生的决策
```

- [ ] **Step 2: 同文件 §6.4 的裁剪表（`:860`）**

```diff
- | 上一手牌 `lastPlayedHand` | 明文（公开信息） | 明文 |
+ | 桌面历史牌 `recentActions`（协议④，窗口 2） | 明文（**只有已经打出的牌**；不含任何未出的手牌） | 明文 |
```

- [ ] **Step 3: 同文件 §3.2 的 `GameSession` 表（`:280-281`）**

两个内部字段**不变**，但**必须加一句**：

> ⚠️ **它们不再出站**（协议 ④ 起）：出站的是由 `actionLog` 投影出的 `recentActions`（窗口 2）。
> 它们是**规则态**（跟牌目标 / 过牌合法性 / 不变式 1、3），永不下发。

- [ ] **Step 4: 同文件 §4.2 的例外说明（`:505`）**

那句「由 `actionLog` 派生的公开信息可以出站」后面补一个实例：

> 该路径现已有**两个**实例：`RobotFeatures`（§4.2）与 `PlayerView.recentActions`（协议 ④）。

- [ ] **Step 5: `docs/client-protocol.md` §5（`:180-181`）**

两行 → 新形状（与 Step 1 的 TS 逐字一致），并补 `baseScore` / `bidPhase.kind` / `bidPhase.decisions`。

- [ ] **Step 6: `docs/games/doudizhu.md`**

- §3.1 的计数器表（`:78-84`）**之后**加一段：

> **另有一个不参与判定的观测字段** `bidPhase.decisions`：每次决策按发生顺序追加
> `{ seat, kind, grab }`，`kind` 是**决策发生那一刻**由 `landlordCandidate === -1 ? 'call' : 'rob'`
> 算出的措辞依据（协议 ⑦）。流局重发时清空。它**只用于展示**，任何判定都不得读它。

- §6.1-5（`:251`）那句「记录 `lastPlayedHand = {...}`，`lastPlayerIdx = playerIdx`」**之后**加：

> ⚠️ **出站面另有一个派生投影**：`PlayerView.recentActions`（窗口 2、旧→新、「不出」占一手），
> 由 `actionLog` 投影而来（协议 ④），**只用于展示**。上面的两个字段仍是**规则态**、永不出站。

- [ ] **Step 7: 死脚本（**先问用户**）**

```bash
# 先自证它确实是死的（这是删除的依据，必须留证据）
grep -rn "test-full-game" --include="*.ts" --include="*.js" --include="*.json" --include="*.md" . \
  | grep -v node_modules | grep -v "^./test-full-game"
# Expected: 零命中（只命中它自己）

# 用户确认后再删
git rm test-full-game.ts test-full-game.js
```

⚠️ 若用户未确认 ⇒ **保留**，并在交接文档的「已知缺口」里记一句「死脚本仍在」。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "docs: 契约同步（协议③④⑥⑦ + 连带面）+ 删死脚本

· design.md §4.2 PlayerView / §6.4 裁剪表 / §3.2 加「不再出站」的说明 /
  §4.2 例外说明补第二个实例（recentActions）
· client-protocol.md §5 视图形状
· doudizhu.md：decisions 是**不参与判定**的观测字段；出站面另有派生投影
· test-full-game.{ts,js}：全仓零引用的死脚本（字段早已漂移到 C20 之前），用户确认后删除

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task A6: 阶段 A 验收（**独立于阶段 B**）

> ⚠️ 阶段 A「做出来什么都看不见」⇒ 它的验收**只能落在机械层与真栈**上。
> **不得**把它写成「已验收」除非下面三条都有证据。

**Files:** 无（只跑验收 + 写账）

- [ ] **Step 1: 机械门禁（提交后的树）**

```bash
pnpm run ci 2>&1 | tee .superpowers/sdd/table-a6-ci.log
```

Expected: 六阶段全过，**0 cached / N total**（看到 cached 就 `--force` 重跑；本仓不接受缓存读数）。

- [ ] **Step 2: 真栈 conformance 全套 + 条数闸**（🔴 **命令已订正**，见 §0.4.4 的 21/22）

```bash
# ① 新鲜度自证：**三个**服务都必须证（robot-service 也应声 —— A4 实测它曾是旧镜像）
DOCKER_BUILDKIT=0 docker compose build game-service api-gateway robot-service
docker compose up -d game-service api-gateway robot-service
docker compose exec -T game-service   sh -c "grep -c recentActions packages/game-service/dist/game/view.builder.js"
docker compose exec -T api-gateway    sh -c "grep -c recentActions packages/protocol/dist/validate.js"
docker compose exec -T robot-service  sh -c "grep -c lastMoveMeta packages/robot-service/dist/robot/bot.player.js"
# 三者都必须 > 0；任一为 0 ⇒ 镜像是旧的，真栈判据会变空测

# ② conformance 是**宿主侧**工具（node dist/run.js）⇒ 先 build，再跑全套
pnpm --filter @fight-the-landlord/conformance build
docker compose up -d --force-recreate     # 本机跑全套会把栈改坏，先重建
pnpm --filter @fight-the-landlord/conformance conformance 2>&1 | tee .superpowers/sdd/table-a6-conformance.log

# ③ 条数闸（对**整份**日志；先自证它自己不是空测）
node scripts/check-baselines.mjs --self-test
node scripts/check-baselines.mjs full .superpowers/sdd/table-a6-conformance.log
```

Expected: 17 片全过；09/10/11 ≥ 现基线（**160 / 185 / 50**）。
⚠️ 本机读数会比 CI 少（无 `flock` / 无 `script(1)` 的若干条显式跳过）—— **不得用本机读数回填基线**。
⚠️ 若见 `fetch failed`：**先** `docker compose up -d --force-recreate` 再单跑那几片，**别急着往代码上归因**。

- [ ] **Step 3: 🔴 真浏览器探针 `--scenario full`（**本片新增的第三处探针改动只有它会执行**）**

⚠️ **订正（2026-09-28 评审）**：A2 Step 13 只跑了 `gate`，而 `gate` 对 `READ_STATE` **只求值、不分支**
⇒ `browser-e2e.mjs:799-803` 的 autoPlay 分支（本片改的第三处）**至今从未被执行过**。
`gate` 的 22/22 会给出「看起来完整」的信号，但它**没有覆盖那一处**。

```bash
cd apps/client && pnpm dev &                       # 或复用常驻的那个
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/    # 期望 200
cd /d/Code/pokergame
CHROME_BIN="C:\\Users\\Yobee\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe" \
  node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario full \
  2>&1 | tee .superpowers/sdd/table-a6-probe-full.log    # ⚠️ 别用 | head（SIGPIPE 会腰斩）
```

Expected: **full 39/39 · 0 ❌**（基线见交接 §3）。
⚠️ 改过服务端源码 ⇒ 先 `docker compose build <svc>` + `up -d` 并**自证新代码在镜像里**（§0.5）。

- [ ] **Step 4: 人眼可观测的那一条（阶段 A 唯一能看的）**

阶段 A 没有界面，但**协议在网上是看得见的**。做一次最小的人工观测并留证据：

```bash
# 起一个练习房 → 打两手 → 用 ws 抓一帧 PlayerView，确认四件事
#   ① 有 recentActions，且窗口 ≤ 2
#   ② 过牌之后最新一条是 {"seat":N,"cards":null}
#   ③ 有 baseScore，且等于撮合时发的档位
#   ④ bidPhase 有 kind 与 decisions
node tools/conformance/src/run.ts --render slice-09   # 或直接用 HarnessClient 打一局
```

⚠️ 若这一步做起来成本过高，**允许跳过**，但必须**如实记**「阶段 A 无肉眼验收，只有机械层 + conformance」。

- [ ] **Step 5: 更新执行账本 `.superpowers/sdd/progress.md`**

按本仓格式写：每个任务的提交号 · 评审结论 · 全部 Minor 与缺陷记录 · 以及**如实标注**哪些判据在哪个提交上跑过（⚠️ 片② 的教训：探针在 `e8e3218` 跑的，而 master 是 `421f772` ⇒ **不得**写成「在 421f772 上跑过」）。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "chore: 阶段 A 验收（ci 六阶段 + conformance 全套 + 探针 full）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# 阶段 B：界面

## §B0. 🔴 开工闸

**阶段 A 的 Task A6 未完成前，不得开工阶段 B 的任何任务。** 理由：B 会大改 `table.vue`，
而它现在读的正是 A 要退役的那两个字段 —— 先做 B 会同时踩两条线。

⚠️ 开工前先确认这四个字段在真栈上真的到位了（它们是 B 的全部输入）：

```bash
grep -n "baseScore\|recentActions\|kind:\|decisions" packages/protocol/src/views.ts
# Expected: 四者都在 PlayerView（且 lastPlayedHand / lastPlayerIdx **不在**）
```

---

## Task B1: `store` 的场次名查询 + 中央（场次名 / 底分）+ R659 闸改形态

**Files:**
- Modify: `apps/client/src/stores/game.ts`（新增 `viewLevelName` getter）
- Modify: `apps/client/src/pages/table/table.vue`（`.table__center` 加「场次名 + 底分」）
- Modify: `apps/client/test/table-bid-ui.test.ts`（`LOCAL_SCORING_TRACES` 两条改形态 + 正对照）
- Create: `apps/client/test/table-center.test.ts`

**Interfaces:**
- Consumes: `PlayerView.baseScore`（Task A1）· `store.baseScoreLevels`（片② 已有）
- Produces: `store.viewLevelName: string | null`（按 `view.baseScore` 查档位表的名字；查不到 ⇒ `null`）

---

- [ ] **Step 1: 写失败判据 —— 新建 `apps/client/test/table-center.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { FakeSocket, playerViewFixture } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
});

function mountTable(view: Record<string, unknown> = {}) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  store.setBaseScoreLevels([
    { name: '休闲场', baseScore: 15 },
    { name: '标准场', baseScore: 80 },
  ]);
  store.applySnapshot(playerViewFixture({ baseScore: 15, ...view }));
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, store };
}

describe('中央：场次名 + 底分（协议⑥）', () => {
  it('底分来自服务端字段，名字按底分查档位表', () => {
    const { wrapper } = mountTable();
    expect(wrapper.find('.table__scene-name').text()).toBe('休闲场');
    expect(wrapper.find('.table__scene-base').text()).toContain('15');
  });

  /**
   * 🔴 **查不到名字就不编** —— 这是既有纪律（片② §4：查不到返回 null，不编名字）。
   * 底分 999 不在档位表里 ⇒ 只显示底分，**不得**出现任何场次名。
   */
  it('档位表里查不到 ⇒ 只显示底分，不编名字', () => {
    const { wrapper } = mountTable({ baseScore: 999 });
    expect(wrapper.find('.table__scene-name').exists()).toBe(false);
    expect(wrapper.find('.table__scene-base').text()).toContain('999');
  });

  /**
   * 🔴 **缺字段必须容忍**（R661 同族）：真浏览器探针的 `seedFinishedGame` 往 store 里
   * 直接注入一个**不过校验器**的残缺视图（它没有 `baseScore`）⇒ 本块必须整块不显示、**不抛错**。
   */
  it('缺 baseScore ⇒ 中央整块不显示，且不抛错', () => {
    const { wrapper, store } = mountTable();
    const v = { ...store.view! } as Record<string, unknown>;
    delete v.baseScore;
    store.view = v as never;
    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.find('.table__scene-name').exists()).toBe(false);
      expect(wrapper.find('.table__scene-base').exists()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/table-center.test.ts
```

Expected: FAIL —— `.table__scene-name` 找不到。

- [ ] **Step 3: `apps/client/src/stores/game.ts` —— 加 getter**

放在既有 `selectedLevelName` getter **之后**：

```ts
    /**
     * **本局**的场次名：拿服务端的 `view.baseScore` 去档位表查（协议⑥）。
     *
     * ⚠️ 与 `selectedLevelName` 的区别：那个查的是「用户**选中**的底分」（进房前），
     * 这个查的是「**服务端说这局是**多少底分」（进房后）。**两个都要有** ——
     * 用选中值去显示牌桌会让「服务端给的底分与用户选的不一致」这种真实情况被掩盖。
     * ⚠️ 查不到 ⇒ `null`，**不编名字**（既有纪律）。
     */
    viewLevelName: (s): string | null => {
      const bs = s.view?.baseScore;
      if (typeof bs !== 'number') return null;
      return s.baseScoreLevels.find((l) => l.baseScore === bs)?.name ?? null;
    },
```

- [ ] **Step 4: `table.vue` —— 中央加「场次名 + 底分」**

在 `.table__center` 内部**最前面**（既有 `PlayArea` 占位之前）插入：

```html
          <view class="table__center">
            <!--
              场次名 + 底分（协议⑥）。参考图 3/4/5/6 里这一块就在中央偏上。
              🔴 **查不到名字就不编**（`viewLevelName` 返回 null ⇒ 只显示底分）；
              🔴 `view.baseScore` 缺失时（探针注入的残缺视图）**整块不显示**，不得抛错（R661）。
              数字**原样来自服务端**，本处一个字节都不换算（R659 的另一半见 Step 5）。
            -->
            <view v-if="sceneBase !== null" class="table__scene">
              <text v-if="sceneName" class="table__scene-name">{{ sceneName }}</text>
              <text class="table__scene-base">底分 {{ sceneBase }}</text>
            </view>
            <!-- …既有内容不动… -->
```

`<script setup>` 里加：

```ts
/** 本局底分（协议⑥）：**原样**取服务端字段；缺失 ⇒ `null` ⇒ 整块不显示。 */
const sceneBase = computed<number | null>(() => store.view?.baseScore ?? null);
/** 场次名：按底分查档位表；查不到 ⇒ `null`（**不编名字**）。 */
const sceneName = computed<string | null>(() => store.viewLevelName);
```

样式（照 §5.2.1 与 `game.vue` 的 `.game__scene*` 同形）：

```scss
/**
 * 中央的「场次名 + 底分」（协议⑥）。形态与 `game.vue` 的 `.game__scene*` **同形** ——
 * 两屏说的是同一件事，不该长两样。
 * ⚠️ 它是**透明**的（不铺面板）：参考图的中央是底纹直接露出来的，
 *    而 `.table__center` 从片② 起就是「无形容器」（那张大白块的教训）。
 */
.table__scene {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-2;
}
.table__scene-name {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
  /* 大标题白字 + 多层 text-shadow 深色描边（§5.2.1 定稿的排版手法） */
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
.table__scene-base {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-md;
  line-height: 1.2;
}
```

- [ ] **Step 5: 🔴 R659 的两条正则改形态 —— `apps/client/test/table-bid-ui.test.ts`**

`LOCAL_SCORING_TRACES`（`:61-68`）改成：

```ts
/**
 * §12.4 的 MVP 形态（机械源码扫描）：找出「本地算分数/倍数」的痕迹。
 *
 * ⚠️ **协议⑥ 之后「底分」与 `baseScore` 本身不再是违规词** —— 牌桌**必须**显示
 * 服务端下发的底分（上位 §4.6）。违规的是**凭空造数字**与**本地运算**，
 * 不是「引用了服务端字段」。⚠️ 这条与 `lobby.vue` 的既有豁免是**同一条理由**
 * （M09 禁的是常量与本地计算，不是展示服务端值）。
 *
 * 🔴 **三条一个字不动**（它们才是判别力所在）：
 *   `/×\s*\d/` · `/\b(?:bidMultiplier|multiplier)\s*[*+/%-]/` · `/Math\.pow\s*\(\s*2/`
 * 🔴 **两条改形态**（原形态在协议⑥ 之后会误报）：
 *   `/底分/` → 只禁**紧邻的数字字面量**（`底分 15` 这种硬编码）
 *   `/\bbaseScore\b/` → 只禁**赋值与运算**，允许 `view.baseScore` 这样的**读取**
 */
const LOCAL_SCORING_TRACES: Array<{ re: RegExp; what: string }> = [
  { re: /×\s*\d/, what: '本地拼出的「×N」倍数' },
  { re: /底分\s*[=:：]\s*\d/, what: '底分的**数值字面量**（服务端字段以外的数字）' },
  { re: /\b(?:const|let|var)\s+\w*baseScore\b/, what: '本地声明底分变量' },
  { re: /\bbaseScore\s*[*+/%-]/, what: '对底分做本地运算' },
  { re: /\b(?:bidMultiplier|multiplier)\s*[*+/%-]/, what: '对倍数做本地运算' },
  { re: /Math\.pow\s*\(\s*2/, what: '本地按 2 的幂算倍数' },
];
```

**正对照必须跟着改**（`:282-287` 那组合成样本）—— 原样本里「有 `底分` 字样 ⇒ 命中」这一条**现在是反例**。改成：

```ts
    // 正对照：**凭空造数字/本地运算**必须被报出
    expect(localScoringTraces('.x { content: "底分 15"; }')).toContain('底分的**数值字面量**（服务端字段以外的数字）');
    expect(localScoringTraces('const baseScore = 15;')).toContain('本地声明底分变量');
    expect(localScoringTraces('const n = baseScore * 3;')).toContain('对底分做本地运算');
    expect(localScoringTraces('const x = 倍;')).toEqual([]);
    // 🔵 **反向对照（本步新增）**：合法形态**一条都不许报** —— 否则「改了形态」会变成「闸变松」
    const legal = `
      <text class="table__scene-base">底分 {{ sceneBase }}</text>
      const sceneBase = computed(() => store.view?.baseScore ?? null);
    `;
    expect(localScoringTraces(legal), '引用服务端底分字段是**合法**的').toEqual([]);
```

- [ ] **Step 6: 跑判据 + 门禁**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/table-center.test.ts test/table-bid-ui.test.ts
pnpm run ci 2>&1 | tee .superpowers/sdd/table-b1-ci.log
```

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(table): 中央显示场次名 + 底分（协议⑥）+ R659 闸改形态

· store.viewLevelName：拿服务端 view.baseScore 查档位表（查不到 ⇒ null，**不编名字**）
  它与 selectedLevelName 是两件事（后者查「用户选中的」，前者查「服务端说这局是的」）
· 缺 baseScore ⇒ 中央整块不显示（探针 seedFinishedGame 注入的残缺视图，R661 同族）
· R659 的两条正则改形态：协议⑥ 之后「底分」与 baseScore 本身不再是违规词
  （牌桌**必须**显示服务端下发的底分）。改禁「数值字面量」与「赋值/运算」，
  三条运算类正则一个字不动，并**新增反向对照**（合法形态一条都不许报）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B2: 🔴 出牌区窗口 2（本片界面最重的一处）

> ⚠️ 三件事必须一起做，缺一个就会**静默数错**：
> ① 两个实例 + 后代选择器；② 「我出的那一手」不得进 `.table__me`；③ `cards: null` 要渲染成「不出」。

**Files:**
- Modify: `apps/client/src/components/PlayArea.vue`（删 `bubble` prop；`cards === null && ownerSeat >= 0` ⇒ 「不出」）
- Modify: `apps/client/src/pages/table/table.vue`（两实例 · 落槽 · 删 `bubble`/watch · 删 `store.lastPlay`）
- Modify: `apps/client/src/stores/game.ts`（删过渡 getter `lastPlay`）
- Modify: `apps/client/test/action-feedback.test.ts`（两条气泡用例成对迁移 + 源码锚点换）
- Modify: `apps/client/test/{table-play-ui,table-seat-geometry}.test.ts`（若它们按文档级选择器数 `.table__play-area`）
- Create: `apps/client/test/table-play-area-window.test.ts`

**Interfaces:**
- Consumes: `store.recentActions`（Task A2）
- Produces: `PlayArea` 的语义契约 —— `{ cards: readonly Card[] | null; ownerSeat: number; ownerLabel: string }`：
  - `cards !== null` ⇒ 渲染那几张牌 + `ownerLabel 出`
  - `cards === null && ownerSeat >= 0` ⇒ 渲染**「不出」**
  - `cards === null && ownerSeat < 0` ⇒ 渲染**「（无）」**（沿用既有语义，**不变**）

---

- [ ] **Step 1: 写失败判据 —— 新建 `apps/client/test/table-play-area-window.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { FakeSocket, playerViewFixture, makeCards } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
});

function mountTable(recentActions: unknown[]) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  store.applySnapshot(playerViewFixture({ recentActions } as never));
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, store };
}

describe('出牌区：窗口 2（协议④ / 上位 §4.4）', () => {
  it('窗口为空 ⇒ 中央一个「（无）」占位', () => {
    const { wrapper } = mountTable([]);
    expect(wrapper.findAll('.table__play-area')).toHaveLength(1);
    expect(wrapper.find('.table__play-area .table__muted').text()).toBe('（无）');
  });

  it('两家各出一手 ⇒ **两个**实例，各在自己的槽位', () => {
    const { wrapper } = mountTable([
      { seat: 1, cards: makeCards(3) },
      { seat: 2, cards: makeCards(4) },
    ]);
    expect(wrapper.findAll('.table__play-area')).toHaveLength(2);
    // 左家的那一手在左槽、右家的在右槽（`.table__played-slot` 是它们的宿主）
    expect(wrapper.findAll('.table__played-slot')).toHaveLength(2);
    // 中央**不再**有占位
    expect(wrapper.find('.table__center .table__muted').exists()).toBe(false);
  });

  /** 🔴 「不出」占一手 —— 它是被删掉的本地回声气泡的**服务端替代物**。 */
  it('cards 为 null 且 seat 有效 ⇒ 渲染「不出」（不是空白、不是「（无）」）', () => {
    const { wrapper } = mountTable([
      { seat: 1, cards: makeCards(4) },
      { seat: 2, cards: null },
    ]);
    const pass = wrapper.findAll('.table__play-area').find((w) => w.text().includes('不出'));
    expect(pass, '必须有一处渲染「不出」').toBeTruthy();
    expect(pass!.text()).toContain('不出');
  });

  /**
   * 🔴 **我出的那一手不得进 `.table__me`** —— 放进去会让 R660 的数法变了
   * （17 手牌 + 1 张已出的牌 = 18），而探针与 `table-play-ui` 都断言它**恰好是手牌**。
   */
  it('我出的那一手在 .table__me **之外**，且 .table__me .card 恰好 17 张', () => {
    const { wrapper } = mountTable([{ seat: 0, cards: makeCards(9) }]);
    expect(wrapper.find('.table__my-play').exists()).toBe(true);
    expect(wrapper.findAll('.table__me .card')).toHaveLength(17);
    expect(wrapper.findAll('.table__my-play .card')).toHaveLength(1);
  });

  /** 🔴 窗口满 2 项时，后代选择器**不得**跨实例数错（这是本任务单独成步的理由）。 */
  it('窗口满 2 项时，槽位限定的选择器各数到 1 张', () => {
    const { wrapper } = mountTable([
      { seat: 1, cards: makeCards(3) },
      { seat: 2, cards: makeCards(4) },
    ]);
    const slots = wrapper.findAll('.table__played-slot');
    expect(slots).toHaveLength(2);
    expect(slots[0]!.findAll('.card')).toHaveLength(1);
    expect(slots[1]!.findAll('.card')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/table-play-area-window.test.ts
```

Expected: FAIL —— 只有一个 `PlayArea` 实例。

- [ ] **Step 3: `PlayArea.vue` —— 删 `bubble`，加「不出」**

props 里删掉 `bubble` 那一项（`?: { seat: number; text: string } | null` 与它的默认值），
并在 `<script setup>` 里把 `playedCards` 与新增的 `isPass` 写清：

```ts
/** 非空视图：`null` 与空数组在这里归一（两者都渲染「（无）」，除非 `ownerSeat` 有效 ⇒ 「不出」）。 */
const playedCards = computed<readonly Card[]>(() => props.cards ?? []);

/**
 * 这一格是不是「**不出**」（协议 ④）。
 *
 * 🔴 判据是**两个字段合起来**，缺一不可：
 *   · `cards === null` —— 服务端说「这一手没有牌」；
 *   · `ownerSeat >= 0`  —— 有一个**归属座位**（说明这是某人的动作，不是空场）。
 * 只有 `cards === null` 而 `ownerSeat < 0` 时才是既有的「（无）」占位语义（**它不能变**：
 * `action-feedback` 的既有断言锚在 `.table__play-area .table__muted` 的「（无）」上）。
 *
 * ⚠️ 本组件**不判断**「谁该不该不出」—— 那是服务端的事实，这里只做展示分派。
 */
const isPass = computed(() => props.cards === null && props.ownerSeat >= 0);
```

模板里，在既有的 `v-else` 分支**之前**插入：

```html
      <text v-if="isPass" class="table__pass-note">不出</text>
      <Hand v-else-if="playedCards.length > 0" :cards="playedCards" enter="played" />
      <text v-else class="table__muted">（无）</text>
```

模板里**删掉**气泡那一段（`<text v-if="bubble" class="table__bubble …">`）。

样式：删 `.table__bubble` / `.table__bubble--seat-0` 两条规则，加：

```scss
/** 「不出」（协议④）：服务端说这个人这一手没出牌。与气泡同形（胶囊），但**它是服务端事实**。 */
.table__pass-note {
  display: block;
  padding: $ftl-space-2 $ftl-space-6;
  border-radius: $ftl-radius-pill;
  background: $ftl-color-text;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
```

- [ ] **Step 4: `table.vue` —— 两个实例 + 落槽 + 删本地回声**

**删掉**（`<script setup>` 里）：
- `const bubble = ref<{ seat: number; text: string } | null>(null);` 与它的两段注释
- `watch(() => store.currentVersion, () => { bubble.value = null; });` 整段
- `send()` 的 `localEcho` 形参与 `if (localEcho !== null) bubble.value = …` 那一行
  （⚠️ `cue` 形参**留着** —— 音效仍走本地回声，直到 Task B3 才改）
- `bid()` / `pass()` 里传的 `'不抢'` / `'不出'` 两个字面量实参
- `store.recentActions` 的窗口计算：

```ts
/**
 * 桌面历史（协议④）：按座位分派到三个槽。
 *
 * ⚠️ 每一槽**至多一项**（窗口 2 ⇒ 最多两处并存），按**发生顺序**取**该座位的最后一项**。
 * ⚠️ 顺序：`recentActions` 是旧→新 ⇒ 同一座位有两项时取**后出现的那个**。
 */
function actionOf(seat: number) {
  const w = store.recentActions;
  for (let i = w.length - 1; i >= 0; i -= 1) if (w[i]!.seat === seat) return w[i]!;
  return null;
}
const leftAction = computed(() => actionOf(seats.value[0]!));
const rightAction = computed(() => actionOf(seats.value[1]!));
const myAction = computed(() => (store.mySeat === null ? null : actionOf(store.mySeat)));
/** 窗口为空 ⇒ 中央保留既有的「（无）」占位（它有自己的判据）。 */
const windowEmpty = computed(() => store.recentActions.length === 0);
```

**模板**：三个槽全部改成「有 action 就渲染」：

```html
        <view class="table__mid">
          <Seat v-bind="seatProps(seats[0]!)" class="table__seat" />
          <!--
            出牌位（协议④）：**每一侧各一个实例**，由 `actionOf(seat)` 决定是否有内容。
            ⚠️ 本页**最多两个** `PlayArea` 实例（窗口 2）—— `action-feedback` 的后代选择器
            在文档级 find 下会跨实例数错 ⇒ 那些判据**必须按槽位限定**（见本任务 Step 6）。
            ⚠️ 中央占位只在**窗口为空**时渲染（`windowEmpty`），且它不参与任何座位归属。
          -->
          <PlayArea
            v-if="leftAction"
            class="table__played-slot"
            :cards="leftAction.cards"
            :owner-seat="leftAction.seat"
            :owner-label="nameOf(leftAction.seat)"
          />
          <view class="table__center">
            <view v-if="sceneBase !== null" class="table__scene">…</view>
            <PlayArea v-if="windowEmpty" :cards="null" :owner-seat="-1" owner-label="" />
          </view>
          <PlayArea
            v-if="rightAction"
            class="table__played-slot"
            :cards="rightAction.cards"
            :owner-seat="rightAction.seat"
            :owner-label="nameOf(rightAction.seat)"
          />
          <Seat v-bind="seatProps(seats[1]!)" class="table__seat" />
        </view>
```

我的那一手（**`.table__me` 的兄弟槽，位置不变**）：

```html
        <PlayArea
          v-if="myAction"
          class="table__my-play"
          :cards="myAction.cards"
          :owner-seat="myAction.seat"
          :owner-label="nameOf(myAction.seat)"
        />
```

**删掉** `playedAt` / `playedCards` / `playOwnerLabel` / `lastPlayerIdx` 四个 computed 及其注释（被 `actionOf` 体系取代）。

- [ ] **Step 5: `stores/game.ts` —— 删过渡 getter**

删掉 Task A2 加的 `lastPlay` getter（它的最后两个消费者在 Step 4 被移除了）。**先在 `src/**` 里 grep 确认零引用**：

```bash
grep -rn "lastPlay\b" apps/client/src apps/client/test scripts/ | grep -v node_modules
# Expected: 只剩本 getter 自己（删完为零）
```

- [ ] **Step 6: 判据成对迁移 —— `apps/client/test/action-feedback.test.ts`**

| 用例 | 现状 | 改成 |
|---|---|---|
| `:127` 「ack 成功 ⇒ 出气泡」 | 点 `.table__pass` ⇒ `.table__bubble` 文本「不出」 | **迁移**：喂一个 `recentActions: [{seat:0,cards:null}]` 的视图 ⇒ 「不出」出现在**我这一侧的槽**（`.table__my-play .table__pass-note`）。⚠️ **不再依赖 ack** —— 它现在是服务端事实 |
| `:152` 「不抢 ack ⇒ 出气泡」 | 点 `.table__bid-pass` ⇒ `.table__bubble`「不抢」 | **删除并迁移**：叫抢回显由 Task B3 的 `decisions` 驱动（**本步先删**，B3 补上新形态的判据）。⚠️ **删的时候要在提交信息里写明「判据去哪了」** —— 不许静默少一条 |
| `:112` 「被拒 ⇒ 不出气泡」 | 断言 `.table__bubble` 不存在 | **保留**（性质不变：被拒时不产生任何「我做了某动作」的展示） |
| `:208` 源码级 `watch(() => store.currentVersion` | 断言 `table.vue` 含这个 watch | 🔴 **换锚点**：改成断言 `table.vue` **按窗口渲染**（例如 `toMatch(/actionOf\(/` 或 `.table__pass-note` 在模板里）—— 原锚点守的是「气泡的清除时机」，那个机制**已经不存在**了，锚点必须跟着性质走，**不得留着一条恒红的锚**、也不得直接删 |

同文件所有 `.table__play-area .table__played .card` 这类**文档级后代选择器**改成**按槽位限定**：

```ts
// ❌ 两个实例下会数到两处之和
wrapper.findAll('.table__play-area .table__played .card')
// ✅ 按槽位限定（左槽 / 右槽 / 我上方）
wrapper.findAll('.table__played-slot').at(0)!.findAll('.card')
wrapper.find('.table__my-play').findAll('.card')
```

⚠️ **`table-play-ui.test.ts` 与 `table-seat-geometry.test.ts` 要逐条核一遍**有没有同类写法
（`grep -n "table__play-area" apps/client/test/*.ts`），有就一起限定。

- [ ] **Step 7: 跑判据 + 门禁 + 探针**

```bash
grep -n "table__play-area" apps/client/test/*.ts     # 逐条核：还有没有文档级用法
pnpm run ci 2>&1 | tee .superpowers/sdd/table-b2-ci.log
pnpm run e2e:browser 2>&1 | tee .superpowers/sdd/table-b2-probe-gate.log
```

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat(table)!: 出牌区改成窗口 2（协议④）+ 删掉本地回声 hack

· 每侧各一个 PlayArea 实例，按 actionOf(seat) 派发；窗口 2 ⇒ 最多两处并存
· 「不出」（cards:null + seat 有效）**是服务端的原话** —— 本地回声气泡整条退役
  （bubble ref、清除 watch、send() 的 localEcho 形参全部删除）
· 我出的那一手仍在 .table__me **之外**（放进去会让 .table__me .card 数到 18，
  而 R660 与探针都断言它恰好是手牌）
· 判据按**槽位限定**：本页现在最多两个 PlayArea 实例，文档级后代选择器会跨实例数错
· action-feedback 的两条气泡用例：一条**成对迁移**（改由服务端字段驱动）、
  一条**删除并交给 Task B3 的 decisions 重写**（写在提交信息里，不许静默少）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B3: 叫抢（`kind` 文案 + 回显 + 中央倒计时 + 音效改视图 diff）

**Files:**
- Modify: `apps/client/src/components/BidPanel.vue`（加 `kind` prop）
- Modify: `apps/client/src/components/Seat.vue`（加可选 `bidEcho` prop）
- Modify: `apps/client/src/pages/table/table.vue`（中央钟 + 我的回显 + 传 `bidEcho`）
- Modify: `apps/client/src/composables/useTableSound.ts`（叫抢音效改走 `decisions` 的视图 diff）
- Modify: `apps/client/test/table-bid-bottom.test.ts`（R657 改形态）
- Modify: `apps/client/test/audio.test.ts`（叫抢音效的入口换）
- Create: `apps/client/test/table-bid-stage.test.ts`

**Interfaces:**
- Consumes: `PlayerView.bidPhase.kind` · `PlayerView.bidPhase.decisions`（Task A1）
- Produces: `BidPanel` 的 `kind: 'call' | 'rob'` prop · `Seat` 的 `bidEcho?: string | null` prop

---

- [ ] **Step 1: 写失败判据 —— 新建 `apps/client/test/table-bid-stage.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { FakeSocket, playerViewFixture } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
});

function mountBidding(phase: Record<string, unknown>, mySeat = 0) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', mySeat);
  store.applySnapshot(
    playerViewFixture({
      state: 'bidding',
      bidPhase: {
        currentBidder: mySeat,
        bidMultiplier: 1,
        landlordCandidate: -1,
        grabActions: 0,
        redealCount: 0,
        kind: 'call',
        decisions: [],
        ...phase,
      },
    } as never),
  );
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, store };
}

describe('叫抢阶段感（用户卡点③）', () => {
  it('kind=call ⇒ 「叫地主 / 不叫」；kind=rob ⇒ 「抢地主 / 不抢」', () => {
    const call = mountBidding({ kind: 'call' });
    expect(call.wrapper.find('.table__bid-grab').text()).toBe('叫地主');
    expect(call.wrapper.find('.table__bid-pass').text()).toBe('不叫');

    const rob = mountBidding({ kind: 'rob', landlordCandidate: 1 });
    expect(rob.wrapper.find('.table__bid-grab').text()).toBe('抢地主');
    expect(rob.wrapper.find('.table__bid-pass').text()).toBe('不抢');
  });

  /** 🔴 反例（判据改形态后的**判别力**所在）：同一 `kind` 下文案**恒定**，不随任何计数变化。 */
  it('同一 kind 下文案恒定（grabActions / bidMultiplier 怎么变都不动）', () => {
    for (const g of [0, 1, 2]) {
      const { wrapper } = mountBidding({ kind: 'call', grabActions: g, bidMultiplier: 2 ** g });
      expect(wrapper.find('.table__bid-grab').text()).toBe('叫地主');
      expect(wrapper.find('.table__bid-pass').text()).toBe('不叫');
    }
  });

  /** 中央倒计时：**只在叫抢期且轮到我**时出现（复用页面唯一的 useCountdown）。 */
  it('中央倒计时只在我行动时出现', () => {
    const mine = mountBidding({ currentBidder: 0 }, 0);
    expect(mine.wrapper.find('.table__clock').exists()).toBe(true);

    const theirs = mountBidding({ currentBidder: 1 }, 0);
    expect(theirs.wrapper.find('.table__clock').exists()).toBe(false);
  });

  /** 回显：对手的贴**各自座位**（`.seat__echo`），我的贴**中央**（`.table__center-echo`）。 */
  it('回显按座位分派：对手的贴座位、我的贴中央', () => {
    const { wrapper } = mountBidding({
      currentBidder: 0,
      decisions: [
        { seat: 1, kind: 'call', grab: false }, // 玩家1 不叫
        { seat: 0, kind: 'call', grab: true },  // 我 叫地主
      ],
    });
    expect(wrapper.find('.table__center-echo').text()).toBe('叫地主');
    const seatEcho = wrapper.find('.seat__echo');
    expect(seatEcho.exists()).toBe(true);
    expect(seatEcho.text()).toBe('不叫');
  });

  /** 措辞由 `kind` + `grab` **两个字段**推出（四种组合唯一确定一句）。 */
  it('四种组合 ⇒ 四句唯一措辞', () => {
    const cases: Array<[string, boolean, string]> = [
      ['call', true, '叫地主'],
      ['call', false, '不叫'],
      ['rob', true, '抢地主'],
      ['rob', false, '不抢'],
    ];
    for (const [kind, grab, label] of cases) {
      const { wrapper } = mountBidding({ decisions: [{ seat: 0, kind, grab }] });
      expect(wrapper.find('.table__center-echo').text(), `${kind}/${grab}`).toBe(label);
    }
  });

  /** 进 `playing` ⇒ 回显让位（这是**显式取舍**：第 3 条决策看不见，由地主徽章接管）。 */
  it('state=playing ⇒ 回显不显示', () => {
    const { wrapper } = mountBidding({ decisions: [{ seat: 1, kind: 'rob', grab: true }] });
    expect(wrapper.find('.seat__echo').exists()).toBe(true);
    const store = useGameStore();
    store.applySnapshot(playerViewFixture({ state: 'playing' } as never));
    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.find('.seat__echo').exists()).toBe(false);
      expect(wrapper.find('.table__center-echo').exists()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/table-bid-stage.test.ts
```

- [ ] **Step 3: `BidPanel.vue` —— 加 `kind` prop**

```ts
withDefaults(
  defineProps<{
    disabled: boolean;
    multiplier: number | null | undefined;
    /**
     * 协议③：当前行动者该用哪套措辞。**唯一来源是服务端**（`bidPhase.kind`）——
     * 本组件**不得**由 `grabActions` / `landlordCandidate` 反推（R657 改形态后的红线）。
     */
    kind: 'call' | 'rob';
  }>(),
  { multiplier: null },
);

/**
 * 措辞表（枚举 → 文案，**不是**规则判断）。
 * ⚠️ 键集必须与契约的联合类型逐字对齐（少一个键就渲染出 undefined）。
 */
const GRAB_LABEL: Record<'call' | 'rob', string> = { call: '叫地主', rob: '抢地主' };
const PASS_LABEL: Record<'call' | 'rob', string> = { call: '不叫', rob: '不抢' };
```

模板里两个按钮的文本换成 `{{ GRAB_LABEL[kind] }}` / `{{ PASS_LABEL[kind] }}`。
⚠️ **`.table__bid-grab` / `.table__bid-pass` 两个 class 与「原生 `<button>`」一个不改**（R647 保锚）。
⚠️ 头注释里那段「文案**不随**叫/抢变化（R657）」**必须重写**（它现在是反的）。

- [ ] **Step 4: `Seat.vue` —— 加可选 `bidEcho`**

```ts
    /** 叫抢回显（协议⑦）：该座位本轮最近一次决策的措辞；`null`/缺省 ⇒ 不显示。 */
    bidEcho?: string | null;
```
（`withDefaults` 里给 `bidEcho: null`。）

模板里，在 `.seat__name` 之后插入：

```html
    <view v-if="bidEcho" class="seat__echo">{{ bidEcho }}</view>
```

样式：

```scss
/**
 * 叫抢回显（协议⑦）：参考图 06 里贴在决策者身旁的那句大字。
 * ⚠️ 颜色走**强调色**（它是这一拍的焦点）；形态是胶囊，与出牌区的「不出」同族。
 * ⚠️ 字号取 `$ftl-font-md` —— **不得**大于 `.seat__count-tile-num` 的档位关系所依赖的那些
 * （`table-seat-geometry` 的 §6.5-1 只约束 `.seat__count` / `.seat__name` 两块的相对大小）。
 */
.seat__echo {
  align-self: flex-start;
  padding: 0 $ftl-space-3;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night, 0.62);
  border: $ftl-hairline solid $ftl-color-gold;
  color: $ftl-color-gold-light;
  font-size: $ftl-font-md;
  line-height: 1.6;
}
```

- [ ] **Step 5: `table.vue` —— 中央钟 + 两侧回显 + 传 prop**

`<script setup>` 加：

```ts
/**
 * 叫抢措辞（协议③）：**原样**取服务端字段，前端零反推。
 * ⚠️ 缺字段（探针注入的残缺视图）⇒ 回落 `'call'` —— 那是**展示缺省**，不是规则判断
 * （真正的判定全在服务端；按钮能不能点由 `disabled` 决定）。
 */
const bidKind = computed<'call' | 'rob'>(() => store.view?.bidPhase?.kind ?? 'call');

/** 叫抢决策（协议⑦）：本轮已发生的，按发生顺序。缺字段 ⇒ `[]`（R661）。 */
const bidDecisions = computed(() => store.view?.bidPhase?.decisions ?? []);

/**
 * 措辞表（枚举 → 文案）。**唯一实现**：`decisions` 的每项与「我的回显」都用它 ——
 * 两处各写一遍会各自过期（`Settlement.vue` 的 `SPRING_LABEL` 是同一条纪律）。
 */
const BID_LABEL: Record<'call' | 'rob', { grab: string; pass: string }> = {
  call: { grab: '叫地主', pass: '不叫' },
  rob: { grab: '抢地主', pass: '不抢' },
};
function bidWord(d: { kind: 'call' | 'rob'; grab: boolean }): string {
  return d.grab ? BID_LABEL[d.kind].grab : BID_LABEL[d.kind].pass;
}

/** 某座位本轮**最近一次**叫抢的措辞；没有 ⇒ `null`。 */
function bidEchoOf(seat: number): string | null {
  const list = bidDecisions.value;
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]!.seat === seat) return bidWord(list[i]!);
  return null;
}
/** 叫抢期才显示（**显式取舍**：第 3 条决策当场结束叫抢 ⇒ 它由地主徽章 + 翻底牌接管）。 */
const showBidEcho = computed(() => store.isBidding);
const myBidEcho = computed(() => (showBidEcho.value && store.mySeat !== null ? bidEchoOf(store.mySeat) : null));
```

> ⚠️ **2026-09-30 订正（片① Task 9）**：上面 `showBidEcho` 注释里的「**第 3 条决策当场结束叫抢**」
> 已随片① R2 的反抢作废（同一轮内同一玩家可决策两次 ⇒ 本轮以 **3 或 4 条**决策收口）。
> 实际落地的代码注释已带 ⚠️ 作废说明（`table.vue:229-239`）；本块其余内容不变。

`seatProps()` 里加一行：

```ts
    bidEcho: showBidEcho.value ? bidEchoOf(seat) : null,
```

中央（在 `.table__scene` 之后）插入：

```html
            <!--
              中央倒计时（用户卡点③：叫抢期没有阶段感）。
              ⚠️ **只在叫抢期且轮到我**时出现 —— 出牌期沿用座位上的钟（参考图 5 就是叫抢期）。
              ⚠️ 复用页面**唯一**的 `useCountdown`（`seconds`）；**不得**在组件里新造时钟（§9.6 / R675）。
            -->
            <view v-if="store.isBidding && store.isMyTurn" class="table__clock">
              <text class="table__clock-value">{{ seconds }}s</text>
            </view>
            <!-- 我的叫抢回显（参考图 06 的中央大字位） -->
            <text v-if="myBidEcho" class="table__center-echo">{{ myBidEcho }}</text>
```

样式：

```scss
/** 中央倒计时（叫抢期）：形态照 `Seat.vue` 的钟（同一素材槽、同一形状），尺寸取大档。 */
.table__clock {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: $ftl-size-clock-w;
  height: $ftl-size-clock-h;
  border: $ftl-hairline solid $ftl-color-gold;
  border-radius: $ftl-radius-pill;
  background-color: rgba($ftl-color-night, 0.62);
  background-image: $ftl-art-countdown;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  overflow: hidden;
}
.table__clock-value {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-xl;
  font-weight: 700;
  line-height: 1;
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
/** 我的叫抢回显（中央大字，参考图 06 的形态）。 */
.table__center-echo {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-xl;
  font-weight: 700;
  line-height: 1.2;
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
```

- [ ] **Step 6: `useTableSound.ts` —— 叫抢音效改走视图 diff**

```ts
  // ── 叫抢（协议⑦）：`decisions` 增长时，为新出现的那几条播对应音效 ──────────
  /**
   * ⚠️ **与 `table.vue` 的本地回声的分工变了**：协议⑦ 之前，叫抢的声音只能在
   * ack `code=0` 之后由本地播（服务端没有 per-seat 的决策记录）；现在 `decisions`
   * 就是服务端的原话 ⇒ 改走**视图 diff**，与「王单张」同一手法。
   *
   * 🔵 副产品：**别人的叫抢也会响**（参考实现就是这样：按座位播 `Woman_Rob1/2/3`）。
   * 若用户认为不合预期，那是**新裁决**，另立小片。
   *
   * ⚠️ **变体选择仍走 `audio/index.ts` 的 `cueForBid`**（已有的唯一实现，签名
   * `(grab: boolean, seat: number)`，内部按座位取 `Rob1/2/3`、不抢取 `NoOrder`）——
   * 本文件只负责**时机**，不得重写一份变体选择。
   */
  let playedDecisions = 0;
  watch(
    () => store.view?.bidPhase?.decisions?.length ?? 0,
    (n) => {
      // 流局重发 ⇒ decisions 清空（长度回落到 0）⇒ 游标必须跟着归零，否则新的一轮会被静默跳过
      if (n < playedDecisions) playedDecisions = 0;
      const list = store.view?.bidPhase?.decisions ?? [];
      for (let i = playedDecisions; i < n; i += 1) {
        const d = list[i];
        if (!d) continue;
        cueForBid(d.grab, d.seat);
      }
      playedDecisions = Math.max(playedDecisions, n);
    },
  );
```

（import 里加 `cueForBid`。⚠️ `playedDecisions` **必须放在 `useTableSound()` 内部**，
不是模块级 —— 模块级会在牌桌重挂载时带着上一局的游标（该文件里 `lastCounts` 的既存注释记着同一件事）。）

`table.vue` 里 `bid()` 那一次 `send(...)` 的 `cue` 实参**删掉**（叫抢的声音现在由本文件的 watch 播）；

- [ ] **Step 7: 判据成对迁移 —— `table-bid-bottom.test.ts` 与 `audio.test.ts`**

`table-bid-bottom.test.ts`：

| 用例 | 现状 | 改成 |
|---|---|---|
| `:84` 「按钮文案逐字『抢』/『不抢』」 | 断言文本 = `'抢'` / `'不抢'` | **成对迁移**：断言「文案**由 `kind` 决定**」—— 同一 `kind` 下恒定的那一句（`call` ⇒ 叫地主/不叫） |
| `:115` 「R657：文案不随叫/抢形态变化（grabActions 0→3）」 | 断言前后都是 `['抢','不抢']` | 🔴 **改形态**（规格 §4 的硬要求）：标题与断言都改成「**文案只能从 `kind` 派生**」——`grabActions`/`bidMultiplier` 怎么变都不动（**反例**），而 `kind` 一变文案就变（**正例**）。⚠️ 正例是**新增**的 —— 只有反例的话，把它写成恒定常量也能过 |
| `:314` 直接 mount `BidPanel` | props `{disabled:false, multiplier:null}` | 补 `kind: 'call'`（**prop 名即契约**） |
| 其余（底牌、倍数、阶段互斥、缺字段、样式自持） | —— | **一条不动** |

`audio.test.ts`：`:97-118` 的四条「事件 → cue」里，叫抢那两条的**入口**从「点按钮的 ack 回声」
换成「喂一个带 `decisions` 的视图」——⚠️ **性质不变**（「该响时用正确的 src 播放」），
只换入口。`playCue` / 静音 / 音量那几条**一条不动**。

- [ ] **Step 8: 跑判据 + 门禁 + 探针**

```bash
pnpm run ci 2>&1 | tee .superpowers/sdd/table-b3-ci.log
pnpm run e2e:browser 2>&1 | tee .superpowers/sdd/table-b3-probe-gate.log
```

⚠️ 探针的自动出牌走 `.table__bid-grab`（class 锚点）⇒ **文案改了不影响它**（这正是「按 class 锚点、不按文本」的理由）。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat(table): 叫抢阶段感（kind 文案 + 回显 + 中央倒计时 + 音效）

用户卡点③「叫抢期没有阶段感」的四面：
· BidPanel 加 kind prop：文案从服务端字段派生（R657 从「字面固定」改形态为
  「只能从 kind 派生」——**正反例都要有**，只有反例的话写个常量也能过）
· 对手的回显贴座位（Seat.bidEcho）、我的贴中央（参考图 06 的中央大字位）
· 中央倒计时只在叫抢期且轮到我（复用页面唯一的 useCountdown，不新造时钟）
· 叫抢音效改走 decisions 的**视图 diff** ⇒ **删掉最后一处本地回声**
  （副产品：别人的叫抢也会响，与参考实现一致；若不合预期是新裁决、另立小片）
· 显式取舍：第 3 条决策的回显看不见（它当场结束叫抢），由地主徽章 + 翻底牌接管

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B4: 顶栏瘦身 + 二级弹层（D16）

**Files:**
- Create: `apps/client/src/components/MoreMenu.vue`
- Modify: `apps/client/src/pages/table/table.vue`（顶栏三段 + 弹层挂载）
- Modify: `apps/client/test/table-bid-ui.test.ts`（`TABLE_AREA` 9 → 10）
- Create: `apps/client/test/more-menu.test.ts`

**Interfaces:**
- Consumes: 无（纯结构）
- Produces: `MoreMenu` 的 `v-model:open`（或 `open` prop + `close` 事件）—— 形态照 `game.vue` 的好友房弹层

---

- [ ] **Step 1: 写失败判据 —— 新建 `apps/client/test/more-menu.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { FakeSocket, playerViewFixture } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
});

function mountTable() {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  store.applySnapshot(playerViewFixture());
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, store };
}

describe('顶栏瘦身 + 二级弹层（D16）', () => {
  /** 🔴 「收进弹层」的语义：**关着的时候它们不在 DOM 里**（否则这件事无法证伪）。 */
  it('弹层关着 ⇒ 四个占位按钮不在 DOM；顶栏只剩「返回大厅 · 阶段状态 · 底牌 · 倍数 · 更多」', () => {
    const { wrapper } = mountTable();
    expect(wrapper.findAll('.table__art-btn')).toHaveLength(0);
    // 探针锚点必须仍在，且文案逐字
    expect(wrapper.find('.table__bar .btn').text()).toBe('返回大厅');
    expect(wrapper.find('.table__bar-center').exists()).toBe(true);
    expect(wrapper.find('.table__more').exists()).toBe(true);
  });

  it('点「更多」⇒ 弹层打开，四个占位按钮出现**且全部 disabled**', () => {
    const { wrapper } = mountTable();
    return wrapper.find('.table__more').trigger('click').then(() => {
      const btns = wrapper.findAll('.table__art-btn');
      expect(btns).toHaveLength(4);
      expect(btns.map((b) => b.text())).toEqual(['记牌器', '背包', '托管', '设置']);
      for (const b of btns) expect(b.attributes('disabled')).toBeDefined();
    });
  });

  it('点关闭 ⇒ 弹层收起、四个按钮重新不在 DOM', () => {
    const { wrapper } = mountTable();
    return wrapper
      .find('.table__more')
      .trigger('click')
      .then(() => wrapper.find('.table__more-close').trigger('click'))
      .then(() => {
        expect(wrapper.findAll('.table__art-btn')).toHaveLength(0);
      });
  });
});
```

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/more-menu.test.ts
```

- [ ] **Step 3: 建 `apps/client/src/components/MoreMenu.vue`**

形态**逐条照 `game.vue` 的好友房弹层**（那里是全屏遮罩 + 居中面板 + `close_btn.png` 的既有范式）：

```vue
<script setup lang="ts">
/**
 * 二级弹层（D16）：四个恒灰按钮**收在这里**。
 *
 * ⚠️ **D16 只裁决了「收进弹层」，没说接功能** ⇒ 四个按钮**仍然是 `disabled` 占位**。
 * 本仓明文忌讳「造一排点了没反应的活按钮」（`table.vue` 的既有注释逐字）；
 * 功能落地时**只翻 `disabled` 这一个属性**。
 *
 * ⚠️ 本组件是**哑的**：不读 store、不发请求、不知道牌局状态 —— 开合由宿主控制。
 * ⚠️ `close_btn.png` 走 `<image src="/static/ui/close_btn.png">`（与登录页样板同形：
 * 图标类素材**不走** `$ftl-art-*` 槽位，那是装饰件槽）。
 */
defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <!--
    ⚠️ **本注释必须在根元素内部**：模板注释写在根元素**之前**会让 SFC 变成多根，
    `@vue/test-utils` 的 `classes()` 会**静默**返回 `[]`（`table-hud.test.ts` 的单根闸盯着）。
  -->
  <view class="table__more-mask" @click.self="emit('close')">
    <view class="table__more-panel">
      <view class="table__more-head">
        <text class="table__more-title">更多</text>
        <image class="table__more-close" src="/static/ui/close_btn.png" mode="aspectFit" @click="emit('close')" />
      </view>
      <view class="table__more-grid">
        <button type="button" class="btn btn--small table__art-btn" disabled>记牌器</button>
        <button type="button" class="btn btn--small table__art-btn" disabled>背包</button>
        <button type="button" class="btn btn--small table__art-btn" disabled>托管</button>
        <button type="button" class="btn btn--small table__art-btn" disabled>设置</button>
      </view>
    </view>
  </view>
</template>
```

样式照 `game.vue` 的 `.game__friends*` 那一段（全屏遮罩 `z-index: 10` + 居中面板 + §5.2.1 的面板语言），
并把 `table.vue` 里既有的 `.table__art-btn { opacity: .5 }` 一并搬来。

- [ ] **Step 4: `table.vue` —— 顶栏三段 + 挂弹层**

顶栏改成三段：

```html
      <view class="table__bar">
        <!-- 左：探针锚点（文案**逐字**「返回大厅」）+ 阶段状态（R730：必须留在 .table__bar 内） -->
        <view class="table__bar-left">
          <button type="button" class="btn btn--small" @click="auth.navigate('lobby')">返回大厅</button>
          <text v-if="store.isBidding" class="table__phase">叫抢中</text>
          <text v-else-if="store.isPlaying" class="table__phase">出牌中</text>
          <text v-else-if="store.isEnded" class="table__phase">已结束</text>
          <text v-else class="table__phase">{{ store.view?.state ?? '等待发牌' }}</text>
        </view>

        <!-- 中：底牌 + 倍数徽章（R719/R729 既有形态，一个字节不改） -->
        <view class="table__bar-center">
          <BottomCards :cards="store.bottomCards ?? null" />
          <view class="table__badge">
            <text class="table__badge-value">{{ bidMultiplier ?? '—' }}</text>
            <text class="table__badge-unit">倍</text>
          </view>
        </view>

        <!-- 右：「更多」—— 四个恒灰按钮的入口（D16）。它是**活按钮**（它真的有反应）。 -->
        <view class="table__bar-right">
          <button type="button" class="btn btn--small table__more" @click="moreOpen = true">更多</button>
        </view>
      </view>
```

`<script setup>` 加 `const moreOpen = ref(false);`，
模板末尾（`</view>` 根元素**之内**）加：

```html
        <MoreMenu v-if="moreOpen" :open="moreOpen" @close="moreOpen = false" />
```

- [ ] **Step 5: `TABLE_AREA` 9 → 10 —— `apps/client/test/table-bid-ui.test.ts`**

清单里加一行（放在 `Panel.vue` 之后）：

```ts
  // D16：二级弹层。按本条注释自己的规矩「牌桌区每新增一个组件必须 +1」登记。
  'src/components/MoreMenu.vue',
```

并把两处长度断言（`:301` 与 `:323` 的 `toHaveLength(9)`）改成 `toHaveLength(10)`，
`:301` 那条的注释里那句「（8）」也一并订正。⚠️ **三处必须同时改**（漏一处就红）。

**顺手把 `MoreMenu` 登记进单根闸**（`table-hud.test.ts` 的 `SINGLE_ROOT_CASES`，`:248-281`）——
它是新组件，而「模板注释写在根元素之前 ⇒ `classes()` 静默返回 `[]`」这个坑
**真的咬过 `Settlement.vue` 一次**（那段注释逐字记着）：

```ts
    { name: 'MoreMenu', props: { open: true }, root: 'table__more-mask' },
```

⚠️ 该数组的注释里若写了「8 个组件」之类的计数，一并订正。

- [ ] **Step 6: 跑判据 + 门禁**

```bash
pnpm run ci 2>&1 | tee .superpowers/sdd/table-b4-ci.log
```

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(table): 顶栏瘦身 + 二级弹层（D16）

· 顶栏从 8 项收到 3 段：左「返回大厅 · 阶段状态」· 中「底牌 · 倍数徽章」· 右「更多」
· 四个恒灰按钮（记牌器/背包/托管/设置）收进 MoreMenu；**仍是 disabled 占位**
  （D16 只裁决「收进弹层」，没裁决接功能 —— 本仓明文忌讳点了没反应的活按钮）
· TABLE_AREA 9 → 10（新增组件必须登记，否则 R659 的扫描面静默漏扫）
· 已核实：.table__art-btn 与「记牌器/背包/托管」在判据、探针、tools/ 里**零引用**
  ⇒ 收进弹层不会让任何既有判据静默失配（改锚点前先 grep 依赖者）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B5: 结算换视觉 + 第 8 个素材槽 + 三个主按钮金色化

**Files:**
- Modify: `apps/client/src/uni.scss`（新增 `$ftl-art-settlement-ribbon`）
- Modify: `apps/client/src/components/Settlement.vue`（绶带标题带 + 主按钮）
- Modify: `apps/client/src/components/BidPanel.vue` · `apps/client/src/pages/table/table.vue`（主按钮）
- Modify: `apps/client/test/art-slots.test.ts`（八槽显式登记）
- Modify: `apps/client/test/table-settlement-ui.test.ts`（只在必要时补一条绶带判据）

**Interfaces:**
- Produces: `$ftl-art-settlement-ribbon: url('/static/ui/jujsidai.png')`

---

- [ ] **Step 1: 🔴 先改 `art-slots.test.ts` 的形态（它会先红，这是预期的）**

`:21-29` 的 `SLOTS` 加第 8 个 `'ftl-art-settlement-ribbon'`；
`:38` 那条「全 `none`」改成**显式登记**：

```ts
  /**
   * ⚠️ **判据形态的变迁**（片③ 阶段 B）：原形态是「七槽缺省值全是 `none`」，
   * 它的射程是「素材还没到位这件事是**显式**的，不是忘了」。片③ 接通了其中几个槽
   * （`coin` / `countdown` / 新增的 `ribbon`）⇒ 原形态必然红。
   *
   * 新形态守住**同一个性质**：**每个槽都必须被显式登记**（`EXPECTED_SLOT_VALUES`
   * 逐槽写死 `none` 或 `url(...)`）—— 加一个槽不登记、或把已有的槽悄悄改成 `none`
   * 都会当场红。这比原形态**更强**：原形态只要求「全是 none」，新形态要求
   * 「每一个都等于**我们说好的那个值**」。
   */
  const EXPECTED_SLOT_VALUES: Record<(typeof SLOTS)[number], string> = {
    'ftl-art-landlord-badge': 'none', // 无图
    'ftl-art-count-tile': 'none', // 无图
    'ftl-art-coin': "url('/static/ui/dou.png')", // 阶段 B 接通
    'ftl-art-avatar-ring': 'none', // 无图
    'ftl-art-bid-badge': 'none', // 无图
    'ftl-art-countdown': "url('/static/ui/jishianniudi.png')", // 阶段 B 接通
    'ftl-art-bottom-bar': 'none', // 无图
    'ftl-art-settlement-ribbon': "url('/static/ui/jujsidai.png')", // 片③ 新增
  };

  it('八个槽都被**显式登记**，且值逐槽等于约定值（`none` 或 `url(...)`）', () => {
    for (const slot of SLOTS) {
      const v = tokenValue(slot);
      expect(v, `未找到素材槽令牌 $${slot}`).not.toBeNull();
      expect(v, `$${slot} 与约定值不一致`).toBe(EXPECTED_SLOT_VALUES[slot]);
    }
  });
```

⚠️ `coin`/`countdown` 的值在 Task B6 才有图 ⇒ **本步先把这两个写成 `none`，B6 再改成 `url(...)`**
（一次只改一处，红在哪里看得见）。上面那张表是**终态**，B6 会把两行改成 `url(...)`。

⚠️ `:88` 的「七槽都真被引用」射程扩到 8 —— 它已经是 `SLOTS.filter(...)` 写的 ⇒ **自动跟随** ✅。

- [ ] **Step 2: `uni.scss` —— 新增第 8 个槽**

在 `$ftl-art-bottom-bar`（`:239`）之后加：

```scss
/// 结算面板的标题绶带（参考图：红绶带、金边、两端卷曲）—— `jujsidai.png` 早已入库，
/// 但**此前没有任何槽**（片③ 阶段 B 为它新开一个）。
///
/// ⚠️ **它挂在 `Settlement.vue` 上，不是 `Panel.vue`** —— `art-slots.test.ts` 的规则是
/// **按文件**生效的（「一旦某 `.vue` 用了 `$ftl-art-*`，它自己就不得再写 `/static/ui/`
/// 字面路径」），而 `Panel.vue` 里有 `panel-blue.png` / `panel-orange.png`
/// （`panel.test.ts:31-32` 钉着）⇒ 挂过去**当场红**。
///
/// ⚠️ 槽名的**用词避开 M09 保留词**（`baseScore` / `multiplier` / `底分` / `倍数`）。
$ftl-art-settlement-ribbon: url('/static/ui/jujsidai.png');
```

- [ ] **Step 3: `Settlement.vue` —— 绶带 + 主按钮**

标题带：把 `.settlement__title` 那一行包进一条带子（**class 名一个不改**）：

```html
    <view class="settlement__head">
      <!--
        绶带标题带（片③ 阶段 B）：`$ftl-art-settlement-ribbon` 是**装饰槽**，
        文字仍由 DOM 渲染（素材不画字 —— art brief §0 的总则）。
      -->
      <view class="settlement__ribbon">
        <text class="settlement__title">结算</text>
      </view>
      <view class="settlement__tags">…既有…</view>
    </view>
```

```scss
/**
 * 绶带标题带：素材**只做底**，文字（「结算」）仍由 DOM 画在它上面。
 * ⚠️ `background-image` 用槽位令牌（**不包 `url()`** —— 那个约定见 `uni.scss` 本段开头的说明）。
 * ⚠️ 素材缺省是 `url(...)`（本槽有图），但**文字必须仍然可读**：底色/描边也一起给，
 *    万一图裂了不至于白字白底（R693：素材缺失不许白屏）。
 */
.settlement__ribbon {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $ftl-space-2 $ftl-space-9;
  border-radius: $ftl-radius-sm;
  background-color: $ftl-color-accent;
  background-image: $ftl-art-settlement-ribbon;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
```

主按钮（`.settlement__actions` 那一段的 `.btn--primary`）按 §5.2.1 换金色：

```scss
.btn--primary {
  border-color: $ftl-color-gold-deep;
  /* ⚠️ 这一行必须是 `background:` **简写** —— `table-bid-bottom.test.ts` 的
     「主按钮必须自持主色」闸按**字面**匹配（写成 `background-image:` 匹配不上）。 */
  background: $ftl-color-gold;
  /* 🔴 **贴图两行已删**（§5.2.1 逐字：留着会盖住金色）。
     本片之前这里一直是 `background-image: url($ftl-btn-plate-primary)` + `background-size`。 */
  color: $ftl-color-on-primary;
}
```

- [ ] **Step 4: `table.vue` 与 `BidPanel.vue` 的 `.btn--primary` 同样处理**

两处**完全同形**地改（`table.vue:929-938`、`BidPanel.vue:98-107`）：`background: $ftl-color-gold;` +
`border-color: $ftl-color-gold-deep;`，**删掉** `background-image: url($ftl-btn-plate-primary)` 与
`background-size: 100% 100%` 两行。

⚠️ 改完自证（这是本步的验收）：

```bash
grep -rn "ftl-btn-plate-primary" apps/client/src/
# Expected: 只剩 uni.scss 的定义与 game.vue/login.vue 里**已经没有**它
#           ⇒ 牌桌区的三个文件都清理干净（若还有别的消费者，看它是不是另一页的活）
```

- [ ] **Step 5: 跑判据 + 门禁**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/art-slots.test.ts test/table-settlement-ui.test.ts test/table-bid-bottom.test.ts
pnpm run ci 2>&1 | tee .superpowers/sdd/table-b5-ci.log
```

⚠️ `table-settlement-ui` 的 20 个 class 与逐字文案**应当一条都不动**（本步只换视觉）——
若它红了，说明动到了不该动的地方。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(settlement): 绶带标题带 + 第 8 个素材槽 + 牌桌三个主按钮金色化

· uni.scss 新增 \$ftl-art-settlement-ribbon（jujsidai.png 早已入库但**此前没有槽**）；
  槽挂在 Settlement.vue 上，**不能**挂 Panel.vue（那条「用了槽位就不得硬编码
  /static/ui/」的规则按**文件**生效，而 Panel.vue 有 panel-*.png）
· art-slots 的判据改形态：「七槽缺省全 none」→「八槽**逐槽显式登记**约定值」——
  新形态更强（加槽不登记、或把已有的槽悄悄改成 none 都会红）
· 三个主按钮按 §5.2.1 换金色并**删掉贴图两行**（本片之前它们一直是旧的
  Material 蓝 + 贴图，与片② 已重做的 login/game 两页不一致）
· 保留 `background:` **简写**形态（table-bid-bottom 的闸按字面匹配）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B6: 素材槽接通（coin / countdown）+ art brief 重校准

**Files:**
- Modify: `apps/client/src/uni.scss`（两槽接图）
- Modify: `apps/client/test/art-slots.test.ts`（两行约定值改 `url(...)`）
- Modify: `docs/superpowers/specs/2026-09-21-ui-art-brief.md`（七槽尺寸表重新实测）

---

- [ ] **Step 1: 接通两槽 —— `uni.scss`**

```scss
/// 货币图标（参考图：金色圆币）—— 片③ 阶段 B 接通（`dou.png` 早在库里）。
$ftl-art-coin: url('/static/ui/dou.png');
```
```scss
/// 倒计时钟（参考图：金色闹钟）—— 片③ 阶段 B 接通（`jishianniudi.png` 早在库里）。
/// ⚠️ **钟面是不透明深棕**（art brief 第 ⑥ 项的实测）：秒数如果画在钟面正中会被吃掉。
/// 本片的处置见 Task B6 Step 3 的走查结论。
$ftl-art-countdown: url('/static/ui/jishianniudi.png');
```

同一步把 `art-slots.test.ts` 的 `EXPECTED_SLOT_VALUES` 里那两行值改成 `url(...)`。

- [ ] **Step 2: 真浏览器量具 —— 七槽尺寸重新实测**

```bash
# 起 dev server + 真浏览器（照 scripts/measure-table.mjs 的用法）
pnpm --filter @fight-the-landlord/client dev &
node scripts/measure-table.mjs --cdp-port 18800 --dump > .superpowers/sdd/table-b6-measure.txt
```

逐个量七个装饰件的**容器**（画布 px）：`.seat__badge` · `.seat__count-tile` · `.seat__coin-icon` ·
`.seat__avatar-ring` · `.table__badge` · `.seat__countdown` + `.table__clock` · `.table__hud`
（外加新的 `.settlement__ribbon`），把实测值写进 `ui-art-brief.md` 的 §2 表 ——
**逐格标明「实测于 <提交>，容器 X×Y」**。

⚠️ **不要推算**（art brief 的总则：尺寸全部**真浏览器实测**）。⚠️ 若某格与旧值相同，也照写实测值（值同、证据不同）。

- [ ] **Step 3: 钟面那个悬案的走查（**需要人眼**）**

`jishianniudi.png` 的钟面是不透明深棕 ⇒ 秒数（`.seat__timer` / `.table__clock-value`）画在正中会**被底色吃掉**。
两条路：① 把秒数挪到钟的**右侧**（改样式）；② 处理图（抠掉钟面）。**先截图看实际效果再定**：

```bash
node scripts/measure-table.mjs --cdp-port 18800 --selector .seat__countdown   # 出几何
# 再截一张牌桌图（叫抢期，轮到我 ⇒ 中央钟与座位钟同屏）
```

把截图给用户看，**按他的裁决**选 ① 或 ②，并把结论写进本任务的提交信息与 `ui-art-brief.md`。
⚠️ 若不裁决就交付，如实记「钟面遮挡未解决」。

- [ ] **Step 4: 跑判据 + 门禁 + 提交**

```bash
pnpm run ci 2>&1 | tee .superpowers/sdd/table-b6-ci.log
git add -A
git commit -m "feat(assets): 接通货币图标与倒计时钟两槽 + art brief 七槽尺寸重新实测

· \$ftl-art-coin → dou.png · \$ftl-art-countdown → jishianniudi.png（两张早在库里）
· art-slots 的约定值表跟着改两行
· ui-art-brief 的七槽尺寸表**重新实测校准**（原表按旧布局量的，
  不校准会让将来交付的素材尺寸对不上）
· 钟面遮挡（不透明深棕）的处置：<按用户裁决填 ①/②；未裁决就如实写未解决>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B7: 每页可选底纹机制（§5.4 悬案）

**Files:**
- Modify: `apps/client/src/components/LandscapeStage.vue`（`backdrop` prop + 映射表）
- Modify: `apps/client/test/landscape-canvas.test.ts`（R713 改形态）
- Create: `apps/client/test/backdrop.test.ts`

**Interfaces:**
- Produces: `LandscapeStage` 的 `backdrop?: 'default' | 'table'` prop（缺省 `'default'`）

---

- [ ] **Step 1: 写失败判据 —— 新建 `apps/client/test/backdrop.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import LandscapeStage from '../src/components/LandscapeStage.vue';

describe('每页可选底纹（§5.4）', () => {
  it('缺省用 default 底纹', () => {
    const w = mount(LandscapeStage);
    expect(w.find('.stage').attributes('style')).toContain('bg.png');
  });

  it('backdrop="table" ⇒ 换成牌桌底纹', () => {
    const w = mount(LandscapeStage, { props: { backdrop: 'table' } });
    expect(w.find('.stage').attributes('style')).toContain('Common_BG4_2x.png');
  });
});
```

⚠️ **本文件只做 prop 行为**；「舞台只有一层底纹」那条**源码扫描**判据在 `landscape-canvas.test.ts`
（Step 3 改形态）。**不要**在这里再写一条 —— 两条守同一性质会各自过期。

- [ ] **Step 2: `LandscapeStage.vue` —— prop + 映射表**

```ts
/**
 * 每页可选底纹（§5.4 的机制部分）。
 *
 * ⚠️ **底纹只在最外层铺一次**这条性质**不变**（R713）—— 变的只是「哪张图」：
 * 由**页面显式声明**（prop），而不是舞台自己去查页面身份（舞台不该知道 `auth.page`）。
 * ⚠️ 映射表是**唯一**的底纹图清单 ⇒ 判据锚在它上面（片① 的 Minor 预警过旧正则太宽）。
 */
const BACKDROPS = {
  default: '/static/ui/bg.png',
  table: '/static/ui/Common_BG4_2x.png',
} as const;

const props = withDefaults(defineProps<{ backdrop?: keyof typeof BACKDROPS }>(), {
  backdrop: 'default',
});

const stageStyle = computed(() => {
  const { insets } = viewport.value;
  return {
    paddingTop: `${insets.top}px`,
    paddingRight: `${insets.right}px`,
    paddingBottom: `${insets.bottom}px`,
    paddingLeft: `${insets.left}px`,
    // 内联 background-image ⇒ 模板里不再写死任何图路径（判据只看这一处映射表）
    backgroundImage: `url('${BACKDROPS[props.backdrop]}')`,
  };
});
```

`.stage` 的样式里**删掉** `background-image: url('/static/ui/bg.png');`（保留 `background-size` /
`background-position` / `background-repeat` / `background-color`）。

⚠️ **本步不改任何页面**（`table.vue` 仍不传 prop ⇒ 仍用 `bg.png`）——
**图先不动**，等 Step 4 的并排截图给用户裁。

- [ ] **Step 3: `landscape-canvas.test.ts:148-153` —— R713 改形态**

旧断言（「`bg.png` 在 `src/**` 只出现一次且命中 `LandscapeStage.vue`」）换成：

```ts
  /**
   * R713 的**新形态**（片③ 阶段 B）：「每页可选底纹」引入第二张图之后，
   * 旧形态（「`bg.png` 只出现一次」）必然红。
   *
   * 新形态守**同一个性质** —— **舞台只有一层底纹**（两层会因缩放比不同而错位）：
   *   · 底纹图路径**只允许出现在 `LandscapeStage.vue`**（页面自己铺底纹 = 错位的根源）；
   *   · 映射表里的**每张图都在盘上**（防「改了名字但没拷图」这类静默失效）。
   * ⚠️ 锚到 `/\/static\/ui\//` 而不是 `/bg\.png/` —— 后者会误命中 `table-bg.png` 之类
   *    （片① 的 Minor T2-M3 早已预警过这一点）。
   */
  it('R713：底纹图只允许出现在 LandscapeStage.vue，且映射表里的每张图都在盘上', () => {
    const hits = collectSourceFiles()
      .filter((f) => /\/static\/ui\/[A-Za-z0-9_]+\.(png|jpg)/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(hits, '底纹图只允许出现在舞台组件里（页面自己铺 = 两层底纹 = 错位）').toEqual([
      'src/components/LandscapeStage.vue',
    ]);

    // 映射表里的每张图都必须在盘上
    const stage = collectSourceFiles().find((f) => f.path === 'src/components/LandscapeStage.vue')!;
    const refs = [...stripComments(stage.content).matchAll(/\/static\/ui\/([A-Za-z0-9_.]+)/g)].map((m) => m[1]!);
    expect(refs.length, '映射表至少要有一项').toBeGreaterThan(0);
    for (const name of refs) {
      expect(existsSync(join(SRC_ROOT, 'static/ui', name)), `${name} 不在盘上`).toBe(true);
    }
  });
```

⚠️ **注意**：`close_btn.png` 走的是 `<image src="/static/ui/…">`（Task B4），
它**也在** `src/**` 里出现 `/static/ui/` ⇒ 上面那条「只允许出现在 LandscapeStage」**会误报**。
⇒ 改成**只扫背景图形态**（`background-image` / `背景图` 那两个入口）：

```ts
    const hits = collectSourceFiles()
      .filter((f) => {
        const src = stripComments(f.content);
        // 只认「铺底纹」的写法：background-image 或 stage 的内联 backgroundImage
        return /background-image:\s*url\(\s*['"]?\/static\/ui\//.test(src)
          || /backgroundImage:\s*`url\(/.test(src);
      })
      .map((f) => f.path);
```

🔴 **这一条要实测确认**（本步的验收之一）：改完跑 `landscape-canvas.test.ts`，
把 `hits` 的真实值打出来看 —— **预期恰好是 `['src/components/LandscapeStage.vue']`**。

⚠️ 本步需要三个 import：`node:fs` 的 `existsSync`、`node:path` 的 `join`、
以及 `./helpers/source-scan` 的 `SRC_ROOT`（`card-hand-interaction.test.ts:31` 是现成的用法样本）。
`collectSourceFiles` / `stripComments` 该文件已经在了。

- [ ] **Step 4: 并排截图给用户裁（§5.4 的答案）**

```bash
# 用 backdrop="table" 临时跑一次（改一行）→ 截牌桌图 → 还原
node scripts/measure-table.mjs --cdp-port 18800 --dump   # 或直接截图
```

按用户的裁决**要么**让 `table.vue` 传 `backdrop="table"`，**要么**保持缺省；
结论写进 `docs/superpowers/specs/2026-09-26-app-ui-rework-design.md` §5.4
（那句「一个我现在答不了的观感问题」应替换为结论）。

- [ ] **Step 5: 跑判据 + 门禁 + 提交**

```bash
pnpm run ci 2>&1 | tee .superpowers/sdd/table-b7-ci.log
git add -A
git commit -m "feat(stage): 每页可选底纹机制（§5.4）+ R713 判据改形态

· LandscapeStage 加 backdrop prop（页面**显式声明**，舞台不查 auth.page）
· 底纹图路径从 .stage 样式移进组件的 BACKDROPS 映射表 ⇒ 判据锚在表上
· R713 改形态：「bg.png 只出现一次」→「铺底纹的写法只允许出现在
  LandscapeStage.vue」+「映射表里每张图都在盘上」。⚠️ 新形态只认
  background-image/backgroundImage 两种**铺底纹**写法 —— 否则 close_btn.png
  这类 <image src> 会误报（实测确认过 hits 恰为一处）
· 牌桌底纹用哪张：<按用户裁决填>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B8: 真浏览器探针复核 + 真跑

**Files:**
- Modify: `scripts/browser-e2e.mjs`（**只在必要时**；A2 已经改过 `canPass`）

- [ ] **Step 1: 逐条核探针里与本片相关的锚点，确认它们仍然成立**

```bash
grep -n "table__bar .btn\|table__me .card\|table__notice\|table__bid-grab\|table__play\|table__pass\|recentActions" scripts/browser-e2e.mjs
```

逐条对照本计划改动过的东西：

| 探针处 | 本片之后 | 结论 |
|---|---|---|
| `.table__bar .btn` + 逐字「返回大厅」 | 顶栏瘦身**保留了**它（B4） | ✅ 不动 |
| `.table__me .card` ≥ 17 | 我的那一手在 `.table__me` **之外**（B2） | ✅ 不动（这正是 B2 那条约束的意义） |
| `.table__notice` | 未动 | ✅ 不动 |
| `.table__bid-grab` / `.table__play` / `.table__pass` | class 名未动、位置变了 | ✅ **不动**（探针走 DOM `.click()`，不受视觉遮挡影响） |
| `store.recentActions`（A2 改的 `canPass` 与分支） | —— | ✅ 已改 |

⚠️ **只有当上表出现「结论 = 需要改」时才动探针**；**不许顺手重构**（片② 的全局约束曾是「探针零改动」，
本片改动它的每一处都要在提交信息里写明理由）。

- [ ] **Step 2: 真跑（两个场景都要）**

```bash
pnpm run e2e:browser 2>&1 | tee .superpowers/sdd/table-b8-probe-gate.log
# ~90s；gate 场景
pnpm run e2e:browser -- --scenario full 2>&1 | tee .superpowers/sdd/table-b8-probe-full.log
# ~4min；它是本片唯一覆盖「开局 → 真打完一局 → 跨局」的路径
```

Expected: gate **22/22**、full **39/39**、**0 ❌**。

⚠️ **已知启动竞态**：首跑可能红在 `[01] 探针自身未抛异常`
（`TypeError: Cannot read properties of undefined (reading 'webSocketDebuggerUrl')`）。
复跑即可；**记成「首跑红 / 复跑绿 ⇒ 未复现」，不得写成「通过」**（本仓纪律）。

- [ ] **Step 3: 提交（若探针有改动）**

```bash
git add -A
git commit -m "test(probe): 探针复核（本片改动了 canPass 的读数字段）

<逐条写明改了哪一处、为什么>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task B9: 全量验收 + 交接

- [ ] **Step 1: 机械门禁（在**终态**的树上）**

```bash
pnpm run ci 2>&1 | tee .superpowers/sdd/table-b9-ci.log
```

- [ ] **Step 2: 真机（HBuilderX）**

跑一遍：**布局不炸**（安全区 / 横竖屏）· **素材加载**（App 产物里 `/static` 路径）· **工作流可用**。
⚠️ HBuilderX 版本必须 ≥ 5.26（偏低时**真机白屏且无任何报错**）。

- [ ] **Step 3: 人眼并排（**观感唯一的判据**）**

把四张截图与参考图并排给用户：
1. 牌桌前（未叫抢）↔ 参考图 3
2. 出牌中（两家各出一手，含「不出」）↔ 参考图 4
3. 叫抢三个按钮 + 中央钟 ↔ 参考图 5
4. 叫抢回显（对手的贴座位 + 我的贴中央）↔ 参考图 6
5. 底纹二选一（§5.4）

⚠️ 这是**用户口述的结论**，要在账本里如实标注「用户口述」——
片② 的教训：那一栏曾写成「已过目」但没有逐项书面记录。

- [ ] **Step 4: 更新执行账本 + 交接文档**

`.superpowers/sdd/progress.md`：每任务的提交号 · 评审结论 · **全部** Minor 与缺陷记录 ·
以及如实标注哪些判据在哪个提交上跑过。

`docs/superpowers/plans/2026-09-2X-...-handoff.md`（新写一份）：下一步是什么、哪些是已知缺口。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore: 片③ 全量验收 + 交接

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 自检（写完计划后跑一遍）

### 1. 规格覆盖（逐条对照 `2026-09-28-table-rework-design.md`）

| 规格条目 | 落在哪个任务 |
|---|---|
| §2.1 ③④⑥⑦ + ④′ 记账 | A1（③⑥⑦）· A2（④）· A3（④′） |
| §2.2 `kind` 派生 | A1（`bidKindOf`）· B3（文案） |
| §2.3 `recentActions` 派生 + 两条不变式 | A2（`recent.ts` + `recent.test.ts`） |
| §2.4 `baseScore` | A1 |
| §2.5 `decisions` | A1 |
| §2.6 出站校验器 | A1（三项）· A2（`recentActions`） |
| §2.7 判据要点 + 单测影响面 | A1/A2/A3 各自的 Step |
| §2.8 文档面 | A5 |
| §2.9 阶段 A 验收 | A6 |
| §3.1 顶栏 | B4 |
| §3.2 中央 | B1（场次名/底分）· B3（钟/回显）（⚠️ **2026-09-29 订正（修复轮②）**：§3.2 的**动作区搬进中央 / R735 退役**一项**当初被节级映射吞掉**（全支评审抓到）—— 它**不在** B1/B3 的任何一条里，实际落在**修复轮提交** `87388da`（全支评审 C 项）） |
| §3.3 出牌区窗口 2 | B2 |
| §3.4 叫抢 | B3 |
| §3.5 结算 + 第 8 槽 + 主按钮 | B5 |
| §3.6 二级弹层 | B4 |
| §3.7 素材槽 + art brief | B5（槽）· B6（接通 + 重校准） |
| §3.8 每页可选底纹 | B7 |
| §4 判据改动记账 | A1–A5 与 B1–B7 各自的 Step；汇总见本文 §1 |
| §5 验收（两次） | A6 · B9 |
| §6 订正表（死脚本 / 注释） | A5（死脚本，**需用户确认**）· A1（两处注释） |
| §7 取舍与未来项 | B3（第 3 条回显）· B6（钟面）· B7（底纹） |

**无缺口。**

### 2. 占位符扫描

已逐条扫过：无 `TBD` / `TODO` / 「类似 Task N」/「加上适当的错误处理」。
两处**故意的**人工闸（需要用户在场）已显式标注：
- A5 Step 7（删死脚本**需用户确认**，未确认就跳过并如实记）
- B6 Step 3 / B7 Step 4（钟面遮挡与底纹二选一 —— **观感只能人眼**）

### 3. 类型一致性（跨任务的名字与签名）

| 名字 | 定义在 | 被谁用 |
|---|---|---|
| `RecentAction` | A1（protocol） | A2（projection / view / store / 组件） |
| `BidDecision` | A1（protocol） | A1（shared 的 `GameSession`）· B3 |
| `bidKindOf` | A1（shared） | A1（`bid.ts` 与 `view.builder`） |
| `projectRecentActions` / `RECENT_ACTIONS_WINDOW` | A2（shared/ddz/recent.ts） | A2（`view.builder`） |
| `RobotFeatures.lastMoveMeta` | A3（protocol） | A3（`features.ts` / `bot.player.ts`） |
| `store.viewLevelName` | B1 | B1（`table.vue`） |
| `PlayArea` 的三条语义 | B2 | B2 · B3（不动） |
| `BidPanel.kind` / `Seat.bidEcho` | B3 | B3（`table.vue`） |
| `$ftl-art-settlement-ribbon` | B5 | B5（`Settlement.vue`） |
| `LandscapeStage.backdrop` | B7 | B7（本节内） |

⚠️ **A2 删 `store.lastPlay`、B2 删 `store.recentActions` 的过渡用法** —— 顺序不能颠倒（B2 依赖 B1 之后的状态）。

---

## 已知缺口（**如实记，别写成「通过」**）

1. **叫抢回显第 3 条看不见**（B3 的显式取舍）—— 那一拍由地主徽章 + 翻底牌接管。
2. **五个素材槽仍为 `none`**（① 地主徽章 · ② 张数徽章底 · ④ 头像环 · ⑤ 倍数徽章 · ⑦ 底栏底纹）——
   无图，继续 CSS 兜底，**不塞占位图**。
3. **钟面遮挡**与**底纹二选一**由用户裁决（B6 / B7）；未裁决就如实记为未解决。
4. **音效现在别人的叫抢也会响**（B3 的副产品）—— 若不合预期，是新裁决、另立小片。
5. **`test-full-game.{ts,js}` 是否删除需用户确认**（A5 Step 7）。






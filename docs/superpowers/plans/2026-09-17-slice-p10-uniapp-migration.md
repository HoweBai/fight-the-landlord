# 切片 P10 实施计划：`apps/client` 迁移到 uni-app（多端打包）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把唯一前端 `apps/client` 从 **Vite 6 + Vue 3.5 SPA** 迁到 **uni-app（Vue 3 线）**，
使其能打包**多端**；迁移后**现有门禁（29/29 单测 · 六阶段 CI · 13 条 conformance · 真浏览器探针）仍然全绿**。

**为什么现在做**：`deviation-ledger.md` **N33** —— 计划 `2026-09-13-parallel-dev.md` 的 Task 3 要求「新建 uni-app 工程」，
`design.md` §1.4「目标态：uni-app」，但实现是 Vite+Vue SPA、且偏离**从未登记**（唯一出处是一句代码注释）。
**2026-09-17 用户裁决 R428：要做多端打包** ⇒ N33 确认为**真欠账**。

**Architecture:** 迁移在 `apps/client` **内部**完成（**不新建第二个前端目录**，R438）。
分四段，**每段结束时门禁必须是绿的**（R430）；模板标签改写（`div/span/p/button/input/…` → uni-app 组件）
是**唯一不可绕开**的部分（R432），改写时**保留全部现有 class 名**，把测试与探针的改动压到「选择器换标签」这一层。

**Spec:**
- `docs/design.md` —— §1.4（前端形态）· **§12.1–§12.5（哑终端原则 + FORBIDDEN + MANDATORY）** · §13.1–§13.4（测试与 CI）
- `docs/superpowers/plans/deviation-ledger.md` —— **N33**（含 R428 裁决与两条硬约束）· §5（维护约定）
- `docs/superpowers/plans/agent-briefs.md` —— 「已知环境事实（新 session 必读）」（尤其：`pnpm install` 要 `--store-dir`、
  **`packages/protocol` 的 `dist` 会咬人**、`pnpm-lock.yaml` 归协调者）
- `docs/2026-08-31-game-platform-architecture-design.md` —— §「客户端」行（多端目标的**历史**出处）

---

## ⚠️ 开工前必须确认的两件事

1. ✅ **目标端清单 —— 已确认（R429 补，2026-09-17 用户裁决）：`H5` + `微信小程序` + `App`**（**微信小游戏不包含** —— 那是 canvas 引擎的另一条轨道，R436）。
   ⚠️ **App 端的打包链路已实测**（见下「App 端产物与工具链实测」）。历史原文是
   「H5 + 微信小游戏 + APP（uni-app 为主，Cocos3D 为备选）」，但它**在仓库里不是规格**（`platform-roadmap.md` 无多端章节）。
   ⚠️ **实测的边界**：**uni-app 出「小程序」，不出「微信小游戏」** —— 小游戏是 canvas 运行时（Cocos/Laya），
   **是另一条独立轨道**（R436）。所以「多端」到底含哪几个，必须先钉死。
2. ✅ **是否接受 Vite 降级 —— 已确认：接受**（**R431**，2026-09-17）⇒ **方案取「单栈 A」**：
   `apps/client` 整体迁 uni-app，不另立第二份构建配置（R438）。

> **2026-09-17 追加的用户要求（已纳入本片范围）**：**uni-app 的界面设计需要优化**。
> 见下面的「UI 优化」一节与 **R441–R443**：它**不是**"顺手美化"，而是三件有硬约束的工程事，
> 且**必须与 Task 2 的标签改写同批做**（否则 92 个标签要改两遍）。

---

## 绑定数值（全部为本次实测，不得口头漂移）

| 项 | 数值 | 来源 |
|---|---|---|
| uni-app **Vue 3 线**版本 | `3.0.0-alpha-5020620260914001`（dist-tag **`vue3`**；`@dcloudio/uni-app`/`vite-plugin-uni`/`uni-h5`/`uni-mp-weixin`/`uni-app-plus`/`uni-components` **同版本**） | `npm view <pkg> dist-tags.vue3` |
| ⚠️ `latest` 是哪条线 | `@dcloudio/uni-app` ⇒ `2.0.2-5020420260813001` —— **Vue 2 线**；`@dcloudio/vite-plugin-uni` 的 `latest` 更旧（`3.0.0-alpha-3000020210521001`，2021） | `npm view <pkg> version` |
| **Vite peer 约束** | `@dcloudio/vite-plugin-uni@…` 的 `peerDependencies` = **`{"vite": "5.2.8"}`（精确）** | `npm view … peerDependencies` |
| 插件自带的关键依赖 | `@vitejs/plugin-vue 5.2.4` · `@vue/compiler-sfc 3.4.21`（运行时 vue 为 **3.5.13**） | 同上 `dependencies` |
| client 现状 | Vite **6.0.3** · vue 3.5.13 · pinia 2.2.6 · socket.io-client 4.8.1 · vue-tsc 2.1.10 · vitest 2.1.8 | `apps/client/package.json` |
| **爆炸半径（代码）** | **7** 个 `.vue`、约 **92** 个 HTML 标签：`span 23 · div 20 · p 14 · button 14 · section 3 · input 3 · label 2 · header 2 · h1 2 · h2 1 · ul 1 · li 1 · h3 1 · form 1 · main 1` | `grep -rhoE "<(div\|span\|…)" apps/client/src --include=*.vue \| sort \| uniq -c` |
| **爆炸半径（测试）** | **21** 个测试文件 / **169 passed + 2 skipped**；其中 **6** 个用 `@vue/test-utils` 的 `mount()`：`table-ended-ui` / `ui-flow` / `table-settlement-ui` / `auth-ui-wiring` / `table-play-ui` / `table-bid-ui` | `grep -rl "mount(" apps/client/test` |
| **爆炸半径（探针）** | `scripts/browser-e2e.mjs` 的 **12** 个选择器，其中 **5** 个依赖标签名：`.login__field input` · `querySelectorAll('.login__actions button')` · `.lobby__match button` · `.table__bar button` · `.table__me .card`（今天 `Card.vue` 渲染的是 `<button class="card">`） | `grep -oE "querySelector…"` |
| 迁移前门禁基线（HEAD `d202bde`） | `turbo run test lint --force` **29/29 · 0 cached** · `pnpm run ci` **六阶段全绿**（阶段 6：8/8/5/6/3/21）· conformance **13/13**（1184 项）· 探针 **gate 16/16 / full 20/20** · 台账 **86 条：82/1/3** | 本 session 实测 |
| 已用最大裁决号 | **R427** | `grep -rhno "R[0-9]\{3\}" docs/ --include=*.md \| sed 's/.*://' \| sort -u \| tail` |

### App 端产物与工具链实测（2026-09-17）

| 项 | 实测 |
|---|---|
| HBuilderX **Linux 版** | ✅ **官方有 Linux x64 完整包**：`HBuilderX.5.24.2026081301.linux_x64.full.tar.gz`，**1.76 GB**（HTTP HEAD `200`，`content-length: 1847644759`）|
| 本机显示环境 | ✅ **可用**：`xdpyinfo -display :0` 正常（`X.Org` / X11.0）⇒ GUI 与 `cli open` **有条件**跑起来 |
| **云打包**（`cli pack`） | ⚠️ 官方 CLI 文档逐字要求「**首先，需要启动 HBuilderX**（`cli open`）」⇒ CLI **不能脱离 HBuilderX 主程序**；且需要 **DCloud 账号登录** + Android 包名/证书（iOS 还要 `profile` + `p12`）|
| **离线打包** | ❌ 本机缺：`java`/`javac`/`gradle`/`adb`/`sdkmanager` **全部未安装**，`ANDROID_HOME`/`JAVA_HOME` 未设；**iOS 需 macOS + Xcode ⇒ 本机不可能** |
| 磁盘 | ✅ 929 GB 可用（够放 HBuilderX） |

### 用户可用的验证机器（2026-09-17 确认）—— **验收口径随之升级**

**用户手上有 Windows + macOS 机器，且已安装微信开发者工具** ⇒ 原先「本机无工具 ⇒ 只能登记未验证」的**三端里有两端可被真正验证**：

| 端 | 谁验 | 怎么验 | 要回填什么 |
|---|---|---|---|
| **H5** | 协调者（本机 Linux） | `node scripts/browser-e2e.mjs`（探针 gate/full）+ CI | 判据读数（已有形态） |
| **微信小程序** | **用户**（Windows/macOS + 微信开发者工具） | 打开 CLI 工程的 **`dist/dev/mp-weixin`**（官方逐字：dev 产物在此目录，`h5` 不落盘而在缓存里），走**最小路径**（注册 → 随机匹配 → 到牌桌 17 张牌） | ① 能否编译通过 ② 最小路径是否走通 ③ 控制台/网络面板的报错原文 ④ **socket.io 在小程序端是否连得上**（硬约束 (e) 的唯一答案） |
| **App** | **用户**（macOS 可覆盖 iOS） | HBuilderX（拖入 **CLI 工程**）运行调试 + 云打包；**iOS 走 macOS**（Xcode/云打包） | ① 云打包是否成功 ② 真机最小路径 ③ **`wx.*`→`uni.*` 适配层**（若有）在真机上的表现 |

⚠️ **这条升级不改变 R440 的精神，而是把它变得更可执行**：仍然**不写「已支持」**，
只在**用户回填实测结论之后**才把对应端从「未验证」改成「已验证（用户实测，附原文）」。

⇒ **结论**：HBuilderX **可以下载并（在 `:0` 下）尝试启动**；但**产出真实 APK/IPA 需要你的 DCloud 凭据**
（且 Android 还需 JDK+Android SDK，iOS 本机不可行）。因此 App 端在本片的目标是：
**`manifest.json` 配置就绪 + `build:app` 产出 App 资源 + 打包步骤脚本化**，真正的云打包作为
**需要你提供凭据**的显式步骤（R440：未验证的一律写明，不得写成「已支持」）。

### UI 现状实测（「界面设计需要优化」的基线）

| 检查项 | 实测 |
|---|---|
| 组件库依赖 | **0**（uView Plus / uni-ui / wot-design-uni / nutui / tmui **都没有**）；`design.md` 也**没有**界面/视觉/交互设计章节 |
| 样式单位 | **`px` 120 处 · `vh` 2 处 · `rpx` 0 处** ⇒ **完全没做多端/移动端适配**（uni-app 多端靠 `rpx`） |
| design token | **0**（无 `:root`、无变量文件、无 `uni.scss`）—— 色值与间距全部硬编码在各 `.vue` 的 `<style scoped>` 里（如 `#1565c0` 反复出现） |
| 关键尺寸 | `table.vue` 用 `max-width: 720px`、`components/Card.vue` 用固定 `px` 尺寸 ⇒ **桌面优先**，不是移动端优先 |
| 已有的唯一"设计规范" | `design.md` §12 的**交互禁令**（F01/F02/F07/F10/M06/M07）；**没有任何视觉规范** |
| 历史选型 | 老文档（v3.2）`:512` 选过 **`uView Plus`**（「uni-app 生态最全的 UI 库」）——**需按 `vue3` 线兼容性重新核实** |

⇒ 「优化界面」在本片的正确落法 = **组件库选型 + 移动端优先布局 + `rpx`/token 体系 + 牌桌交互重设计**，
且**与 92 处标签改写同批做**（R441）；交互能力的边界受 §12 约束（R443）。

### 多玩法（第二个游戏）扩展点现状（只记录，本片不新增抽象，R444）

| 维度 | 现状 | 出处 |
|---|---|---|
| **已按玩法分维度** | `bot:pool:{gameType}` —— 机器人池键**唯一一个**带玩法维度的键（`robot.pool.ts:17` `GAME_TYPE = 'ddz'`） | `design.md` §10.1 |
| 未按玩法分维度 | `game:session:{roomCode}`、`Room`/`RoomInfo`（`mode: 'random' \| 'practice'` 是**对局模式**不是玩法）、消息清单、`PlayerView` | §3.1 / §6.3 / §10.1 |
| 目录分层 | `packages/shared/src/{card,rule,ddz,logging}`：`ddz/` 是玩法专用；`card/`（DouZero 编码）也是斗地主专用；`rule/`、`logging/` 相对通用 | `packages/shared/src/index.ts` |
| 契约层**斗地主专用** | `PlayerView` 含 `bidPhase{currentBidder,bidMultiplier,landlordCandidate,grabActions,redealCount}` / `landlordSeat` / `bottomCards` / `hand: number[]`（DouZero 编码）/ `cardCounts: [3]`（**写死三家**）/ `state: 'init'\|'bidding'\|'playing'\|'ended'` | `packages/protocol/src/views.ts` |
| 服务层耦合 | `game-service` 直接 import `@fight-the-landlord/shared` 的 ddz 符号（`createBidTimer`/`createPlayTimer`/`GameSession`），**无策略接口** | `game.service.ts:15` / `view.builder.ts:7` |
| 规格的裁决 | §1.3「多玩法……**MVP 不做，也不提前抽象**」；roadmap §2.2 给了**路径 A（推荐，泛化 `GameSession`→`GameState`，专有字段下移策略）**/**路径 B（按 `gameType` 分表）**，并逐字：「选择 A 还是 B，应在**第二个玩法开工前**决定，而不是现在」 | `design.md` §1.3 · `platform-roadmap.md` §2.2 |
| 前端 | **哑终端**（§12）：不含规则 ⇒ 多玩法时前端改动面**相对小**（但 `PlayerView` 的裁剪渲染仍按玩法形状） | `design.md` §12 |

⇒ **结论**：当前架构**没有**为多玩法泛化（这是**有出处、有裁决**的刻意不做），
但**也没有堵死**——真正的障碍是三个 DDZ 专用形状：**`PlayerView`（契约层）· `GameSession`（状态层）·
`Room`/`game:session:*`（缺玩法维度）**。第二个玩法开工前按 roadmap §2.2 裁决 A/B 路径。

**硬约束（开工前实测，写进 N33 行）**
- **(c) 必须按 `vue3` dist-tag 的显式版本装**。用 `pnpm add @dcloudio/uni-app`（默认 `latest`）会装上 **Vue 2 线**，
  症状是「装完 Vue 3 项目直接崩」，且**看起来像代码问题**。
- **(d) 迁移必然伴随 Vite 6 → 5.2.8 的降级**（peer 是**精确**版本）。P9 刚建立的**真浏览器探针**、
  dev server 与 `/api`·`/socket.io` 代理**都长在这份 Vite 配置上** ⇒ 降级会连带改它们。
- **(e) 小程序端的传输层是**未验证**的高风险**：`socket.io-client` 的 engine.io 依赖 XHR/浏览器 WebSocket，
  而小程序只有 `wx.request` / `wx.connectSocket` ⇒ 通常需要一个**适配层**（社区方案如 `weapp.socket.io`）。
  ⚠️ **本机没有微信开发者工具**，**这一条在本片无法端到端验证** —— 只能落到「有适配层 + 单测/结构判据」，
  并**如实登记为「未验证」**（§4 的口径），不要写成「已支持小程序」。

---

## 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接 P9 的 **R427**，本片协调者区间 **R428–R450**。

- **R428**（用户裁决，2026-09-17）**要做多端打包** ⇒ uni-app 仍是目标态 ⇒ **N33 = 真欠账**，保持「仍开放」。
- **R429** **依赖只能按 `vue3` dist-tag 的显式版本装**（硬约束 (c)），且 `pnpm-lock.yaml` **归协调者独占**：
  前端 agent 只改 `apps/client/**` 源码，由协调者执行安装并提交 lockfile。
- **R430** **迁移必须分段、每段自身是绿的**：不得出现「迁移中，门禁红」的交付状态。
  分界线是**可独立验收的切片**（Task 0 → 1 → 2 → 3 → 4），每段结束都跑一遍完整门禁。
- **R431** **接受 Vite 降级到 5.2.8**（待你在开工前确认）—— 这是 uni-app Vue3 线的**硬 peer**，
  不是可协商项；若不可接受，本片作废并改为「只出评估报告」。
- **R432** **模板标签改写时保留全部现有 class 名**。理由：测试与探针的**语义锚点**是 class
  （`table-bid-ui.test.ts` 的注释逐字：「四个动作按钮带**稳定 class**…它们是给测试用的锚点，**改名会让用例静默失配**」）
  ⇒ 少改一处锚点，就少一处静默失配。标签本身不是锚点，可以换。
- **R433** **测试策略的降级授权（仅在前置实验证伪时启用）**：若 `@vue/test-utils` 无法 mount uni-app 组件，
  允许把 UI 断言改为 ① store/net 纯逻辑单测 + ② 真浏览器探针（两者本来已是主力），
  **但每一条被移走的断言都必须写明「搬去哪」**，不得静默删除。⚠️ 与 §5 第 5 条同族。
- **R434** **探针的 5 个标签依赖选择器由协调者同步改**（探针与 CI 都归协调者）；探针的 ``.class`` 选择器不动。
- **R435** **§12（哑终端）必须在迁移后仍然机械可验**：`client/source-boundary` 闸（8 条）与 `§12.4` 第 6 阶段
  **一条都不能少**；迁移不得以「框架换了」为理由放宽任何一条 FORBIDDEN。
- **R436** **「微信小游戏」不在 uni-app 能力范围内**（uni-app 出小程序/App/H5，不出小游戏）
  ⇒ 若目标端含小游戏，它是一条**独立轨道**（canvas 引擎），必须单列并单独裁决；**本片不覆盖**。
- **R437** 门禁 = 标准门禁（改 `apps/**`）＋ 探针 gate/full ＋ conformance 13/13（**独占跑**）。
- **R438** **仍是「单一前端」**：全部改动落在 `apps/client` 内，**不得**新建第二个前端目录或第二份构建配置
  （本仓为「第二真源」付过多次代价）。
- **R439** 每完成一段就**回填本文件**的「执行期裁决」与「门禁实测」，并把结论同步进 `agent-briefs.md`
  （新 session 的接班成本全靠这两处）。
- **R440** **无法在本机验证的端**（小程序/App）必须写明**缺什么工具**，登记为「未验证」，
  **不得**在 `design.md` 或台账里写成「已支持」。

### UI 优化与「多玩法扩展」相关裁决（2026-09-17 追加）

- **R431 补**（用户确认）**方案取单栈 A**：`apps/client` 整体迁 uni-app；接受 Vite 6 → 5.2.8。
  ⚠️ 连带影响：P9 的真浏览器探针 / dev server / `/api`·`/socket.io` 代理都在这份 Vite 配置上，
  由协调者同步改造并**重跑 gate 16/16 + full 20/20**（这是本片最后一道安全网）。
- **R441 UI 组件库与模板改写必须同批做**：现状 **0** 个组件库依赖、**120** 处 `px`、**0** 处 `rpx`、
  **0** 个共享样式/design token（全部是各 `.vue` 的 `<style scoped>` 硬编码）。
  ⇒ 若先按 R432 改一遍标签、再引组件库替换一遍，模板要动**两次**。
  **裁决**：Task 2 直接以「uni-app 组件 + 选定组件库」为目标形态**一次改到位**；
  `design.md` 旧文档（v3.2）已选过 **`uView Plus`**（`:512`「uni-app 生态最全的 UI 库」），
  但**必须按 uni-app `vue3` 线的兼容性重新核实**后再定（候选：uView Plus / wot-design-uni / uni-ui / nutui-uniapp）。
- **R442 移动端优先 + 单位体系换 `rpx` + 抽 design token（唯一真源）**：
  **120 处 `px`** 在多端（尤其小程序）下不会自适应 ⇒ 统一换 `rpx`（或 `uni.scss` 的变量）；
  色值/间距/圆角抽成**单一** token 来源（`uni.scss` + 一个 token 模块）。
  ⚠️ 与 F02/§12 一致：**token 里不得出现任何游戏规则常量**（如底分 100）—— 那是 M09 的 FORBIDDEN。
- **R443 「可出牌提示 / 高亮 / 自动理牌」这类交互优化撞 §12 哑终端原则**：
  `design.md` §12 逐字禁止客户端预判（F01/F02/F07/F10）；当前 `PlayerView`
  **不含任何"可出的牌"信息**（字段见 `packages/protocol/src/views.ts`：`hand`/`cardCounts`/`bottomCards`/
  `landlordSeat`/`currentPlayer`/`lastPlayedHand`/`bidPhase`/`playPhase`）。
  ⇒ **裁决**：任何需要"本地算合法性"的 UI 优化**一律不做**；如确需提示能力，
  只能**扩契约**（`PlayerView` 增字段，`packages/protocol` 归协调者）并**另立契约片**，
  **不在本片首段做**。⚠️ 这条要在 UI 评审时先讲清楚，否则最容易"顺手在客户端算一下"。
- **R445 项目形态 = `Vite` 版 CLI 项目**（**不是** vue-cli、**不是** HBuilderX 可视化/免 node 项目结构）。
  **依据（官方文档逐字）**：Vue 3 的 CLI 路径是 `npx degit dcloudio/uni-preset-vue#**vite**`（文档标题里的「vue-cli」
  只适用于 **Vue 2**，那条要 `npm i -g @vue/cli` + `vue create -p dcloudio/uni-preset-vue`）；
  且「**如想用其他 ide 开发 uni-app，只能使用 cli 模式**」——
  我们要在 Ubuntu + 命令行 + CI 上开发，CLI 是唯一可行形态。
  **HBuilderX 只作为「运行/打包器」**（官方明说 `cli` 创建的项目**可以拖入 HBuilderX 编辑**），**不得**因此改变工程结构。
  ⚠️ **已知代价（官方逐字，我们明知故犯）**：CLI 项目的**编译器装在项目下、不随 HBuilderX 升级**
  （要用 `npx @dcloudio/uvm` 手动升级）、`less/scss/ts` 预编译器要自己装、
  每个项目一套编译器「有**数万个文件**」⇒ **`pnpm-lock.yaml` 与 install 耗时都会显著变大**。
  **必须在 Task 1 实测并记录**（可能影响 `pnpm run ci` 的 `1/6 install` 阶段，那是 §13.4 的规格阶段）。
- **R446 工具分工矩阵与**验收边界**（官方依据 + 本仓现实）**：

  | 任务 | Ubuntu（本机） | 说明 |
  |---|---|---|
  | `build:h5` / `build:mp-weixin` / **`build:app-plus`** | ✅ | 官文逐字：`app-plus` 生成**打包资源**、「**可用于持续集成**」 |
  | 微信小程序**调试/预览** | ⚠️ 官方**无 Linux 版**（只有第三方移植） ⇒ **交给用户的 Windows/macOS** | 打开 `dist/dev/mp-weixin` |
  | App 运行调试 | ✅ HBuilderX Linux（已实测可下载 + `:0` 可用） | 官文逐字：`app-plus` **不支持 `run`**，「运行调试仍需在 HBuilderX 中操作」 |
  | App **云打包** APK/IPA | ✅ 但需 **DCloud 账号**（用户提供） | 官文逐字：「**发布 App 时，仍然需要使用 HBuilderX**」 |
  | App **离线打包** IPA / iOS 真机 | ❌ | 需 **macOS + Xcode** ⇒ 用户的 macOS |

  ⇒ **本片在 Linux 侧的验收只承诺**：`dist/build/{h5,mp-weixin,app-plus}` **三种产物存在 + 结构判据 + H5 端的真浏览器探针**；
  小程序与 App 的**运行期**结论由用户回填（见上表）。
- **R447 真浏览器探针的边界要随平台**收窄**并写明**：P9 的 CDP 探针跑的是 **H5**（浏览器 DOM）。
  迁 uni-app 后 ① H5 dev server 由 `@dcloudio/vite-plugin-uni` 提供（端口/代理要按它配，Task 0 问题 1/3 实测）；
  ② **小程序/App 端探针覆盖不到** ⇒ 这两端的判据是「产物 + 结构 + **用户手工回填**」，
  **不得**在 briefs/台账里写成「探针已覆盖」。
- **R444 多玩法（第二个游戏）本片不碰，也不提前抽象**：
  规格 `design.md` §1.3 逐字「多玩法（麻将、扑克）—— **MVP 不做，也不提前抽象**；
  是否引入策略模式应在**第二个玩法开工前**决定」；`platform-roadmap.md` §2.2 给了 **路径 A（推荐，把
  `GameSession` 泛化为 `GameState`，斗地主专有字段下移策略内）** / **路径 B（按 `gameType` 分表）**，
  并逐字写明「选择 A 还是 B，应在**第二个玩法开工前**决定，而不是现在」。
  ⇒ 本片**不动任何为多玩法准备的抽象**；只在收口时把「扩展点现状」如实写进 `design.md`/roadmap
  （哪些已按玩法分维度、哪些是斗地主专用），**不新增代码**。

---

## 执行模型

| 角色 | 工作区 | 负责 |
|------|--------|------|
| **协调者** | `/home/howe/pokergame`（master） | 依赖安装与 `pnpm-lock.yaml` · `apps/client/vite.config.ts` 与工程骨架 · `scripts/**`（探针）· `docs/**` · 门禁 |
| **前端 agent**（建议，Task 2 起） | `.worktrees/frontend`（`feat/frontend`，先 `git merge master --no-edit`） | 模板标签改写 + 组件/页面适配 + 受影响的 `apps/client/test/**` |

⚠️ **派工前必做**：`git -C .worktrees/frontend merge master --no-edit`（该 worktree 停在 `1baf3a2`，**很旧**）；
worktree 里 `pnpm install --store-dir .pnpm-store` + `pnpm build`（`dist/` 是 gitignore 的）。
⚠️ **`tools/conformance` 与探针都必须独占跑**（网关按 IP 计并发 WS 连接，上限 5）。

---

## File Structure

```
apps/client/package.json            Modify: 按 vue3 线显式版本加 @dcloudio/*（协调者，连带 pnpm-lock.yaml）
apps/client/vite.config.ts          Modify: 换成 uni() 插件；保留 /api 与 /socket.io 代理（探针依赖）
apps/client/src/pages.json          Create: uni-app 的页面栈声明（替代 src/router.ts）
apps/client/src/manifest.json       Create: 各端配置（appid 等；小程序/App 的标识待定）
apps/client/src/main.ts             Modify: createSSRApp + uni-app 的入口约定
apps/client/src/App.vue             Modify: uni-app 生命周期（onLaunch 等）+ 全局容器
apps/client/src/pages/*.vue         Modify: 14 处标签改写（span/div/p/button/input/form/label/header/h1/h2/ul/li/section/main）
apps/client/src/components/*.vue    Modify: 3 个组件同上（Card.vue 的 <button class="card"> 是探针锚点）
apps/client/src/router.ts           Modify/Delete: 换成 uni.reLaunch / uni.navigateTo（或保留为薄封装）
apps/client/src/net/storage.ts      Modify: localStorage → uni.getStorageSync / setStorageSync
apps/client/src/net/transport.ts    Modify: socket.io 的小程序适配层（**风险最高**，见硬约束 (e)）
apps/client/test/**                 Modify: 受影响的 6 个 mount 测试 + 任何断言标签的地方
scripts/browser-e2e.mjs             Modify: 5 个标签依赖选择器（协调者）
docs/superpowers/plans/*.md         Modify: 本文件 + 台账 N33 + agent-briefs（收口）
```

---

## Task 0（协调者）：**前置实验（time-boxed，产物是结论不是代码）**

**DoD**：三个问题的**实测结论**，写进本文件；**不落生产代码**（实验放一次性目录，做完删除）。

- [x] **问题 1：uni-app H5 能起来吗？** ✅ **能**。见下方「Task 0 实测结论」。
- [x] **问题 2：`@vue/test-utils` 能 mount uni-app 组件吗？** ✅ **能**（**R433 不启用**）。
- [x] **问题 3：现有模板在 uni-app H5 下的 DOM 形态？** ⚠️ **12 个探针选择器里 3 个失效**（全部是 `button` 类），9 个照旧。
- [x] **问题 4：`socket.io-client` 在 uni-app H5 下** ✅ **照常工作**（有网关侧日志为证）；
      小程序端**只拿到静态证据**（产物里打进了 XHR/WebSocket 传输实现）⇒ 仍登记「未验证」。

---

## Task 1（协调者）：工程骨架 + 依赖（判据：H5 能跑 + 探针仍绿）

- [x] 按 R429 的**显式版本**安装 `@dcloudio/*`（`--store-dir .pnpm-store`，`CI=true`），提交 `pnpm-lock.yaml`
- [x] `vite.config.ts` 换 `uni()` 插件，**保留** `/api` 与 `/socket.io` 代理（探针与开发路径都依赖）
- [x] `pages.json` / `manifest.json` / `main.ts` / `App.vue` 按 uni-app 约定落地（**模板本段不改**，见 R430 的分段）
- [x] 判据：`pnpm --filter @fight-the-landlord/client dev` 能起 H5 页面；`node scripts/browser-e2e.mjs --scenario minimal` **仍绿**
      （若选择器需要先改，按 R434 同步改探针 —— 但**只改选择器，不放宽判据**）

### Task 1 实测（2026-09-17，协调者）—— **本段门禁全绿**

```bash
CI=true pnpm add --config.frozen-lockfile=false --store-dir .pnpm-store --filter @fight-the-landlord/client \
  @dcloudio/uni-app@3.0.0-alpha-5020620260914001 @dcloudio/uni-app-plus@… @dcloudio/uni-components@… \
  @dcloudio/uni-h5@… @dcloudio/uni-mp-weixin@…
pnpm add -D --config.frozen-lockfile=false --store-dir .pnpm-store --filter @fight-the-landlord/client \
  @dcloudio/vite-plugin-uni@3.0.0-alpha-5020620260914001 @dcloudio/types@^3.4.8 vite@5.2.8
# ✅ 关键纪律：**用 `pnpm add` 而不是全量 `pnpm install`** —— 后者会把全工作区的解析重来一遍
#    （第一次试：+6450/-2945 行 lockfile，含无关包漂移）；`pnpm add` 后只剩 +2491 行 **纯新增**。
# ✅ 逐包核对（head vs 现在）：`@nestjs/*` / `ioredis` / `socket.io*` / `mysql2` / `typeorm` /
#    `vitest` / `jsdom` / `pinia` / `vue` 全部**同版本**；只有 `vite 6.4.3 → 5.2.8`（R431 裁决）与
#    随之而来的 `esbuild 0.25.12 → 0.20.2` 变了。

cd apps/client && pnpm test    # ✅ 20 passed | 2 skipped（Tests 185 passed | 2 skipped）—— 与迁移前基线**逐字一致**
pnpm lint                      # ✅ vue-tsc 干净
pnpm build                     # ✅ vue-tsc 干净 + `uni build` DONE → dist/build/h5/{index.html,assets/*}

node scripts/browser-e2e.mjs --scenario minimal   # ✅ **8/8**
node scripts/browser-e2e.mjs                      # ✅ **16/16**（含 N32 受控复现）
pnpm exec turbo run test lint --force             # ✅ 29/29、0 cached
```

**本段落地的文件**：`apps/client/package.json`（deps + `dev/build/build:h5/build:mp-weixin/build:app/preview` 脚本）·
`vite.config.ts`（`uni()` + preserveSymlinks 覆盖 + 代理 + protocol 别名）· `src/pages.json` · `src/manifest.json` ·
`src/main.ts`（`createSSRApp` + `createApp()` 导出；**先 hydrate 再建连**顺序不变）· `src/App.vue`（收窄为应用外壳）·
**`src/pages/index/index.vue`（新：承载页壳）** · `index.html`（官方入口形态）· `scripts/browser-e2e.mjs`（3 个选择器锚 class）。

⚠️ **本段新增的三条实测事实**（都已写进上面的裁决/坑清单）：

1. **必须新增一个「页壳」页面** —— uni-app 里 `App.vue` 的模板不渲染（Task 0 Q3），
   原「`App.vue` 里 `<component :is>` 切页」的形态**必须搬进 `pages.json` 声明的页面**
   （本段落在 `src/pages/index/index.vue`）。**连带**：`test/ui-flow.test.ts` 由 `mount(App)` 改为
   `mount(ShellPage)`（该用例默认 skip，但留着「mount 一个不渲染模板的组件」会静默失效）。
2. **`index.html` 的 `<!--app-html-->` 占位必须删掉**（官方模板有它）：uni-app 用 `createSSRApp`，
   Vue 会对**占位注释节点**做 hydration ⇒ 实测 `console.error` 两条
   `Hydration completed but contains mismatches.`（Vue warn 逐字：`Hydration node mismatch: rendered on server:[object Comment] / expected on client:uni-app`），
   而 P9 探针的判据 08 是「全程 error 级 console 为 0」⇒ **当场红**。
   改成 `<div id="app"></div>`（空容器）后：Vue 走 full mount（仅剩一条 dev-only 的 **warn**
   `Attempting to hydrate existing markup but container is empty. Performing full mount instead.`，
   **不是 error**），探针 8/8 / 16/16。
3. **`pnpm dev` 的进程要是新的**：本机残留过一个**迁移前**启动的 `sh -c vite`（内存里是 Vite 6），
   它对 `vite.config.ts` 的改动会「热重启」，于是**看起来是 uni-app 在跑、其实混着一份 Vite 6**。
   ⇒ 跑探针前先确认 5173 上的进程是本次启动的（`ss -ltnp | grep 5173` + `pgrep -af vite`），
   杀掉旧进程组（`kill -TERM -<pgid>`；**不要** `pkill -f "vite"`，那是本仓记过的自杀式命令）。

## Task 2（前端 agent）：模板标签改写 **＋ UI 组件库/视觉落地（一次改到位，R441）**

- [x] 逐文件改写为 uni-app 组件（`div/section/main/header → view`、`span/p/h1/h2/h3 → text`、
      `button → button`、`input → input`、`form/label/ul/li → view`），**class 名一个不改**（R432）
- [x] **同批**引入选定组件库（R441）并把 `px` 换 `rpx` + 抽 design token（R442）：
      页面/组件重构为移动端优先（牌桌的座位区/手牌区/操作区在窄屏下的布局要重新设计）
- [x] **UI 评审前置**：任何「提示/高亮/自动理牌」类交互**先过 R443**（哑终端原则），
      需要服务端信息的走**扩契约**、另立片，不在本片做
- [x] 同步受影响的测试与探针选择器；**每改一处断言都要在 commit message 里写明「改了什么、为什么语义不变」**
- [x] 判据：`apps/client` 单测全绿（或按 R433 迁移并逐条写明搬去哪）+ 探针 `gate` 16/16

### Task 2 实测（2026-09-17，实现者交付 + 协调者独立复核）—— **本段门禁全绿**

**交付**（`65a5ea4` Task 2① · `07483ca` Task 2② · `f5e0526` Task 2③，前置依赖 `1cac186`）：

| 项 | 实测读数 |
|---|---|
| 标签改写 | 7 个 `.vue` 全改；`src/**` 里 HTML 标签只剩 `button` / `input`（core 组件，按 R441 补② 刻意保留） |
| **class 名零改动** | 逐文件 diff `class` 字面量集合：`table.vue` / `index.vue` **集合一致**；`login.vue` / `lobby.vue` **只有新增**（`login__field--phone/password`、`lobby__title/count/status/rooms-title`），**无删除、无改名** |
| bare hex 色值 | **61 → 0**（全部走 `src/uni.scss` 的 `$ftl-*`） |
| `px` | **125 → 6**（全是发丝线 `1px`，白名单逐条带理由写死在 `test/ui-tokens.test.ts` 里） |
| 组件库使用 | `wot-design-uni@1.14.0`，**easycom 零 import**：`wd-card`/`wd-cell`/`wd-cell-group`/`wd-tag`/`wd-divider`/`wd-loadmore` 共 13 处 |
| client 单测 | **195 passed + 2 skipped**（185+2 基线 **只增不减**；新增 `ui-tokens` 10 条） |
| `vue-tsc` | 干净（退出 0） |
| 三端构建 | `build:h5` **DONE**（392K）· `build:mp-weixin` **DONE**（556K）· `build:app` **DONE**（1.1M，产物目录是 `dist/build/app`） |
| mp 产物完整性（协调者独立复算） | `usingComponents` 引用 **15/15 解析成功**；`wd-*` 组件 `.js/.wxml/.json` **四件套 0 缺失** |
| 真浏览器探针 | `gate` **16/16**（**连续 3 次冷启动**：每次先 `rm -rf node_modules/.vite`）· `full` **20/20**（**真打完一局**再开第二局） |
| 仓库门禁 | `turbo run test lint --force` **29/29、0 cached** |

**协调者独立复核抓到的四件事**（都不是「跑绿已有测试」能发现的）：

1. **⚠️ Task 1 的交付有缺口（本片自己抓到的）**：Task 1 版 `src/pages/index/index.vue` 的
   `<component :is="current">` **在微信小程序端根本编不过** —— 在 `fde341e` 上实测
   `pnpm build:mp-weixin` → `[vite:vue] <component is=""/> is not supported` / `Build failed with errors.`。
   **根因是 Task 1 的门禁口径**：我只跑了 `client test/lint/build`（当时 `build` = H5）与 H5 探针，
   **没跑三端 profile 构建** ⇒ 「每段绿」（R430）在**端维度**上是漏的。已改为静态
   `v-if/v-else-if/v-else` 三分支（语义与 `pages[auth.page]` 逐字一致；Task 3 换页面栈后整段消失）。
   ⇒ **教训写进 R441 补③**：本片每一段的门禁都必须**逐端**跑 `build:h5` / `build:mp-weixin` / `build:app`。
2. **⚠️ mp-weixin 的相对路径坑（pnpm monorepo 专属）**：`preserveSymlinks:false`（坑 2 的必需修法）让
   Rollup 拿到 `wot-design-uni` 的**真实路径** `<repo>/node_modules/.pnpm/wot-design-uni@…/…`；
   而 uni 的 `normalizeNodeModules()` **每个 `node_modules` 只吃掉一层 `../`** ⇒ 在 monorepo 下（比独立工程多一层）
   剩下两段 `../`，违反 Rollup「chunk/asset 名不得是相对路径」⇒ 构建失败。Task 0 的 POC（独立工程）**没暴露**它。
   现修法：`vite.config.ts` 的 `configResolved` 里给 uni 的 `normalizeMiniProgramFilename` 包一层 clamp
   （**只**把逃出项目根的形态折回 `node-modules/…`，uni 自己的前缀判断原样保留）。
   **判据**：三端 DONE + `usingComponents` 15/15 解析（上表）。**被否掉的替代方案**：根 `.npmrc` 加
   `node-linker=hoisted`（会把整个仓库的 node_modules 布局与镜像构建一起改，爆炸半径远大于收益）。
3. **⚠️ 真浏览器探针原来是「假红」体质**（协调者加固，`ed76361`）：Task 2 门禁期出现一次
   `gate` **13/16**（03/04/05 红），同一份代码再跑两次 **16/16**。根因**不是产品缺陷**而是探针的竞态：
   `waitFor(… s.ready …)` 只保证 **pinia store 就绪**，而**页面 DOM 随后才渲染**；冷启动时
   `registerFresh` 的 `inputs.length < 2` **静默返回 `'no-inputs'`**、`clickByText` 的 `'not-found'` **从未被断言**
   ⇒ 表现为「注册」这条红、后面几条跟着红，**看不出是没点着还是真缺陷**。
   处置：新增 `waitForSelector()`，三处动手前先等 DOM，并把 `click`/`formInputs` 读数写进既有 check 的 detail
   —— **判据与条数一字未改**（判据不放宽）。验证：连续 3 次「清 `.vite` 缓存 + 冷启动」`gate` **16/16**。
4. **单测里 `wd-*` 需要一层结构替身**（`test/setup/uni-easycom.ts`）：easycom 是**编译期**行为，vitest 只有
   `@vitejs/plugin-vue` ⇒ 不加替身，`wd-*` 会渲染成「吞掉子节点的裸自定义元素」，锚在 class/文案的断言会**静默失配**。
   替身只透传 class + 渲染插槽、**不复制组件库逻辑**；真实观感与可点性由 H5 探针压（`full` 20/20 含结算页 `wd-card`）。

## Task 3（前端 agent）：端能力替换（router / storage / transport）

- [x] `router.ts` → uni-app 的页面栈（`uni.reLaunch` / `uni.navigateTo`），**保持 `auth.page` 这一唯一状态源**
- [x] `net/storage.ts` → `uni.getStorageSync` / `uni.setStorageSync`（**保持 §5.1 的 hydrate 早于建连顺序**）
- [x] `net/transport.ts` 的 socket.io 适配：H5 走原路径；小程序侧**只落适配层 + 结构判据**，
      并**登记为「未验证」**（硬约束 (e) / R440）
- [x] 判据：探针 `gate` + `full` 全绿；`transport-config.test.ts` 等契约测试全绿

### Task 3 实测（2026-09-17，实现者交付 + 协调者独立复核）—— **本段门禁全绿**

**交付**（`302ffca` 存储 · `e9f9d68` 页面栈 · `4acf0db` 补（直接调用）· `335cbce` 小程序传输）：

| 项 | 实测读数 |
|---|---|
| 页面布局 | 页壳 `src/pages/index/index.vue` **删除**；`src/pages/{login,lobby,table}/<name>.vue` 三个真实页面 + `pages.json` 声明（`login` 是入口） |
| 状态源 | `pageUrl()` 唯一映射 + `navigate()` **先写 `auth.page` 再 `uni.reLaunch`**；冷启动对齐 `usePageAlignment`（登录页挂载时自检） |
| 存储 | `uni.getStorageSync/setStorageSync/removeStorageSync`，未命中归一为 `''`（与真实 uni 一致）；`main.ts` 的「先 hydrate 再建连」顺序未变 |
| 小程序传输 | `src/net/mp-transport.ts`（479 行）：engine.io v4 包编解码 + `wx.connectSocket` 传输 + 平台判定；**H5/App 走原路径**（同一份 `io()` 实现不分叉） |
| client 单测 | **251 passed + 2 skipped**（195+2 **只增不减**；新增 `page-stack` 240 行 / `mp-transport` 348 行 / `uni-api-access` 90 行 / `storage` 扩写） |
| `vue-tsc` | 干净（退出 0） |
| 三端构建（逐端，R441 补③） | `build:h5` **DONE** · `build:mp-weixin` **DONE** · `build:app` **DONE**；mp 产物 `app.json#pages` = 三个页面路径 |
| 真浏览器探针（dev） | `gate` **16/16**（连续 3 次「清 `.vite` 缓存 + 冷启动」）· `full` **20/20** |
| **真浏览器探针（发行产物，新增）** | `build:h5` + `preview`（4173）+ 探针 → `minimal` **8/8** · `gate` **16/16** |

**协调者独立复核抓到的两件事**：

1. **⚠️ 「dev 正常、H5 发行版静默失效」的坑（Task 3 实现者自查 + 修复，`4acf0db`；本片最贵的一条）**：
   H5 **发行构建默认摇树**时，uni 只注入**空的占位对象** `window.uni = {}`
   （`uni-h5-vite/dist/plugins/pagesJson.js`），真正让 `uni.*` 可用的是 `uni:h5-inject` 把
   **`uni.xxx(...)` 的直接成员调用**改写成 `@dcloudio/uni-h5` 的 import。
   一旦写成 `const api = uni; api.getStorageSync(...)`（或 `api.reLaunch(...)`），改写扫不到 ⇒
   **发行版存储不落地、`reLaunch` 不跳页**，而 **dev（探针默认跑的形态）一切正常**。
   **处置**：`src/**` 一律直接调用 + 新增机械闸 `test/uni-api-access.test.ts`（正/反样本自证判别力）
   **＋ 协调者把门禁升级为「发行产物级」**：`build:h5` + `pnpm preview` + `--base-url http://localhost:4173/ --no-server`
   （`vite.config.ts` 新增 `preview.proxy`，与 dev 同源代理）⇒ 实测 `minimal` 8/8 · `gate` **16/16**。
2. **⚠️ 探针的第二类竞态（页面栈带来的）**：真实页面栈下 `auth.page` 是 `navigate()` **先写 store、再 `reLaunch`**
   ⇒ `READ_STATE` 读到 `page=table / hand=17` 时**牌桌页面可能还没渲染**，「数 DOM 牌数」会数到 0 张。
   处置：`waitForSelectorCount(..., '.table__me .card', 17, 12s)`（**阈值与判据一字未改**，只是给渲染一个有界窗口）。
   验证：连续 3 次冷启动 `gate` **16/16**。

⚠️ **硬约束 (e) 的现状（R440：不得写成「已支持」）**：小程序传输适配层**只在单测里用假 `wx` 验过结构**
（31 条：URL/协议头/包格式/收到 `2` 回 `3`/收 `4` 透传/`close()` 调 `SocketTask.close`/H5 负对照/平台逐分支），
**本机没有微信开发者工具** ⇒ 端到端结论**仍为「未验证」**，需用户回填（Task 4 登记）。
另记两条已知差异（实现者报告 §⑦）：pong 去重、同步 `drain`；且 mp 产物 `common/vendor.js` 里**仍留有**
socket.io 的浏览器传输代码（mp 实例化时不会走到，但摇不掉）。

## Task 4（协调者）：多端产物与文档收口

- [x] `pnpm --filter client build:h5`（+ 能力允许时的 `build:mp-weixin`）产物存在性判据；
      **小程序/App 的端到端验收需要微信开发者工具 / HBuilderX —— 本机没有** ⇒ 如实登记「未验证」
- [x] `design.md` §1.4 更新为迁移后的**事实**；台账 **N33 → 已关闭**（或写明剩余哪一端）· §0 重算
- [x] `agent-briefs.md`：环境事实（`vue3` dist-tag 陷阱、Vite 降级、探针选择器）+ 门禁实测 + 教训

### Task 4 实测（2026-09-17，协调者）—— **收口**

**产物判据**（三端都存在**且**结构自洽，不只是「文件在」）：

```bash
cd apps/client
pnpm build:h5 && pnpm build:mp-weixin && pnpm build:app      # 三端 DONE
du -sh dist/build/h5 dist/build/mp-weixin dist/build/app      # 392K / 556K / 1.1M
```

**mp 产物的结构自洽（协调者独立复算）**：遍历产物里所有 `.json` 的 `usingComponents`，
按各自的相对路径解析 ⇒ **引用总数 15、解析失败 0**；`node-modules/**/wd-*/wd-*.json` 的
`.js/.wxml/.json` **四件套缺失 0**。（⚠️ 第一次复算时我的检查脚本用 `lstrip('./')` 把 `../` 也剥掉了，
得到「14 处缺失」的**假红** ⇒ 判据自身要先自证，见 P10 教训第 3 条的同族。）

**台账**：**N33 → 已关闭**；**新登记 N39**（微信小程序 / App 的**运行期未验证** —— 缺微信开发者工具与
HBuilderX/DCloud 凭据，附待用户回填的四项）；`node scripts/ledger-counts.mjs` ✅ **92：90/0/2**。
**`design.md` §1.4** 已改写为迁移后的**事实**，并显式写出「H5 已验证 / 小程序与 App 仅产物与结构已验证」。
**`agent-briefs.md`**：新增「P10 环境事实九条」+「P10 门禁实测」行 +「P10 教训六条」。

---

## 门禁（R437）

### 切片 P10 最终门禁实测（2026-09-17，master）

```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force            # ✅ 10/10（0 cached）
pnpm exec turbo run test lint --force        # ✅ 29/29、0 cached
                                             #    单测 1064 passed + 2 skipped
                                             #    （client 251+2 · room 219 · shared 187 · gateway 149
                                             #     · game 107 · user 58 · robot 47 · protocol 44 · mock 2）
pnpm run ci                                  # ✅ 六阶段全绿（阶段 6：8/8/5/6/3/21，一条未放宽）
cd apps/client && pnpm test && pnpm lint && pnpm build:h5 && pnpm build:mp-weixin && pnpm build:app
                                             # ✅ 251+2 · vue-tsc 干净 · 三端 DONE
node scripts/browser-e2e.mjs                 # ✅ gate 16/16（连续 3 次「清 .vite + 冷启动」）
node scripts/browser-e2e.mjs --scenario full # ✅ 20/20（真打完一局再开第二局）
# 发行产物级（R449 补④）
pnpm --filter @fight-the-landlord/client preview &      # 4173
node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server --scenario minimal  # ✅ 8/8
node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server                    # ✅ 16/16
# conformance 13/13（独占跑、每条 timeout 300）
node scripts/ledger-counts.mjs               # ✅ §0 与 §1.x 逐区一致（92：90/0/2）
```

**conformance 逐条**：`slice-11` **50** · `slice-07.2-rpc` **65** · `slice-07.2-deploy` **104** ·
`slice-07.2-hardening` **103** · `slice-07.2-boundary` **82** · `slice-07.2-security` **43** ·
`slice-07.1` **28** · `slice-07` **39** · `slice-10` **185** · `slice-09` **160** · `slice-08` **55** ·
`slice-06` 通过 · `slice-05` **29** ⇒ **13/13**。

⚠️ **门禁配方的一处修正（本片实测）**：`slice-07.2-rpc` 的判据依赖**机器人池的基线**。
按历史配方的顺序（先 `DEL bot:pool:ddz`，再依次跑到 `slice-11` 之后再跑 rpc）**本次实测红**：
`探针清理后池成员数回到基线（ZCARD 1 → 3）—— 判据不得自己污染被观测状态：期望 1，实际 3`；
单独 `DEL bot:pool:ddz` 后再跑该条 ⇒ **65 项通过**。
⇒ **正确做法**：`DEL bot:pool:ddz` 之后**要么把 `slice-07.2-rpc` 排在 `slice-11` 之前**，
**要么在跑 rpc 之前再 `DEL` 一次**（P10 未改后端任何一行；这是门禁状态耦合，不是代码回归）。

```bash
cd /home/howe/pokergame
git diff --stat                                  # 必须只落在 apps/client/**、scripts/**、docs/**、package.json、pnpm-lock.yaml
pnpm exec turbo run test lint --force            # ✅ 期望 29/29、0 cached
pnpm exec turbo run build --force                # ✅ 期望 10/10（conformance 前必跑：robot-service 是 bind-mount）
pnpm run ci                                      # ✅ 六阶段；**阶段 6 的 6 条闸一条都不能少**（R435）
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..
node scripts/browser-e2e.mjs                     # ✅ gate 16/16
node scripts/browser-e2e.mjs --scenario full     # ✅ 20/20（真打完一局再开第二局）
# conformance 13/13（独占跑、每条 timeout 300、不传 CONFORMANCE_STEPS）
node scripts/ledger-counts.mjs                   # ✅ §0 与 §1.x 逐区一致
```

---

## Self-Review

**Spec coverage**

| 项 | 落在哪个 Task |
|---|---|
| 依赖与 lockfile（R429） | Task 1（协调者） |
| 模板标签（92 处 / 7 文件） | Task 2 |
| 页面栈 / 存储 / 传输 | Task 3 |
| §12 哑终端仍然可验（R435） | 门禁阶段 6 + Task 2 的测试同步 |
| 探针选择器（R434） | Task 1/2（协调者） |
| 「未验证」的端（R440） | Task 4 |
| 台账 §0 与 briefs | Task 4 |

**Placeholder scan**：目标端清单与 Vite 降级是**两个前置**，已在文件头显式列为「未确认前不得动代码」；
其余步骤都点名了文件与判据。

**⚠️ 本片的五个高风险点**
1. **装错线（Vue 2 vs Vue 3）** —— 硬约束 (c)，`latest` 就是错的。
2. **Vite 降级连带改探针/dev server** —— 硬约束 (d)，而探针是 P9 刚建立的最有价值判据。
3. **小程序传输层未验证** —— 硬约束 (e)，本机无微信开发者工具 ⇒ **只能登记，不能宣称**。
4. **测试框架可能不可用** —— Task 0 的问题 2 决定 R433 是否启用；**不许静默删断言**。
5. **「迁移中门禁红」的诱惑** —— R430 明确禁止；任何一段没绿就不进下一段。

---

## 执行期裁决（回填区，**不要删**）

（执行期发现与代码事实不符时，在此追加一条并编号：本片**协调者区间 R428–R450**。）

---

## ✅ Task 0 前置 POC 实测结论（2026-09-17，协调者；**零生产代码**）

实验全部在**一次性目录 `/tmp/p10-poc`**（POC 工程 + 依赖 + 三个探针脚本）里做，**未触碰仓库任何文件**，
做完即删。**结论：三个风险全部证伪（POC 通过）⇒ 按原计划进入 Task 1，分段（R430）不变，R433 不启用。**

| 问题 | 结论 | 关键证据（原文） |
|---|---|---|
| **Q1 · H5 能否起** | ✅ **能** | `npx uni build -p h5` → `DONE Build complete.`（**5.1s**）· 产物 `dist/build/h5/{index.html,assets/*}`（208K）· dev server `vite v5.2.8 dev server running at http://localhost:5199/`，**`ready in 736ms.`**（HMR 正常） |
| **Q2 · vitest 能否 mount** | ✅ **能**（**R433 不需要启用**） | 只挂 `@vitejs/plugin-vue`（与现有 `apps/client/vitest.config.ts` 逐字同形）：`Test Files 2 passed (2) / Tests 5 passed (5)`；含 `<view>/<text>/<button>` 的组件 mount 出的 HTML 里就是 `<view class="probe">…<button …class="card…" data-value="3">` ⇒ **无未知组件警告**，`.card`/`.card__face`/`class`/`data-value` 断言全部照旧 |
| **Q3 · 改写后探针选择器** | ⚠️ **12 个里 3 个失效**（全是 `button`），其余 9 个照旧 | 真 chromium + CDP 读 H5 DOM：`{"nativeButton":0,"uniButton":5,"cardInMe":2}`；`.poc-bar button` → **`[]`**，`.poc-bar uni-button` → **2 个命中** |
| **Q4 · socket.io-client** | ✅ H5 **照常工作**（严格取证，不是「浏览器应该可以」） | 页面内 `POST /api/auth/register`（经 dev proxy）→ 真 token → `io('/ws/ddz',{path:'/socket.io',transports:['websocket'],auth:{token}})` ⇒ 网关日志 `[ProxyGateway] Client connected: 6eeatt37ZdZG0QP0AADP (user: caa2d828-1b3c-480c-8bb3-5b6c6126a7a7)` + `room-service connected for client 6eeatt37ZdZG0QP0AADP` |

### Q3 逐条（决定探针与测试怎么改）

H5 真实 DOM 形态（`R427` 之后的**唯一真源**）：

```
<view class="X">      → <uni-view class="X">
<text class="X">      → <uni-text class="X"><span>文本</span></uni-text>      ← 内层原生 <span> 保留
<button class="X">    → <uni-button id="" class="X" …>                        ← 页面里 <button> 数量 = 0
<input class="X">     → <uni-input class="X"><div class="uni-input-wrapper">
                          <div class="uni-input-placeholder input-placeholder">ph</div>
                          <input class="uni-input-input" …></div></uni-input>     ← 内层原生 <input> 保留
<div id="app" data-v-app=""><uni-app …><uni-page data-page="pages/index/index">…</uni-page></uni-app></div>
```

| 探针里的选择器 | 位置 | 改写后 | 依据 |
|---|---|---|---|
| `#app` → `.__vue_app__` | 3 处（`READ_STATE` / `seedFinishedGame` / store 取用） | ✅ **不用改** | `appElVueApp: true`（Vue 把 app 挂在 `#app` 上）；`piniaOnAppEl: true`；`uni-app` 元素上**没有** `__vue_app__` |
| `.table__me .card` | 手牌计数（2 处） | ✅ **不用改** | 元素变成 `uni-button`，但 **class 与祖先 class 都在** ⇒ class 选择器命中 |
| `.table__notice` | 告警条 | ✅ **不用改** | class 命中 |
| `.login__field input` | 注册表单填值 | ✅ **不用改** | 命中内层 `<input class="uni-input-input">`；**实测** `el.value=… + dispatchEvent(new Event('input'))` 能驱动 `v-model`（页面文本 `2\|3\|` → `2\|3\|13800000000`） |
| `.login__actions button` | 点「注册」 | ❌ **改成 `.login__actions uni-button`** | `nativeButton: 0` ⇒ 原选择器**恒 0 命中**（`clickByText` 会返回 `not-found`） |
| `.lobby__match button` | 点「随机匹配」 | ❌ **同上改法** | 同上 |
| `.table__bar button` | 点「出牌/过牌/叫抢」 | ❌ **同上改法** | 同上 |
| `body.innerText` | 失败详情 | ✅ 不用改 | — |

**交互语义三条（实测，探针依赖它们，不得靠猜）**：
1. `el.click()` **对 `uni-button` 有效**（点两次 ⇒ 计数 0 → 2）；点**内层 `<span class="card__face">` 也会冒泡**触发父 `uni-button` 的 handler。
2. `:disabled` 的 `uni-button` **吞掉 click**（实测那张点不动）⇒ 与原生 `button` 语义一致，探针**不会**误点被禁用的按钮。
3. `:aria-pressed` / `:data-value` / `:disabled` / `type` 都**原样落到** `uni-button` 上。

### ⚠️ Q3 附带的结构性发现：**`App.vue` 的 template 在 uni-app 里不再渲染**

页面 DOM 只有 `pages.json` 声明的页面（`uni-page` → `uni-page-body` → 页面组件）——
第一轮 POC 把夹具写在 `App.vue` 里，**`document.querySelectorAll('.card')` = 0**；
移到 `src/pages/index/index.vue` 后立刻有值。`App.vue` 的 `onMounted` **会执行**（`__POC_APP_MOUNTED__ = true`），
但它的模板**一个元素都不产生**。⇒ **Task 2/3 的连带**：今天靠 `App.vue` 的 `<component :is="pages[auth.page]">`
做页切换的结构**必须挪进一个真实页面**（Task 1 落一个「壳页」，Task 3 换成 uni 页面栈），
`auth.page` 作为唯一状态源的约定（Task 3）由 `router.navigate()` 与页面 `onShow` 共同维持。

### 新增的 5 个「必须先解」的坑（**全部已实测有效**）

1. **`import uni from '@dcloudio/vite-plugin-uni'` 拿到的不是函数**（pnpm + ESM 的 CJS 双 default 互操作）：
   `uni build` 直接报 `failed to load config from …/vite.config.ts` / **`uni is not a function`**。
   实测该模块导出的是 `{ __esModule, default: fn, runBuild, runDev, shouldMoveSourceMapFromCache }`。
   **修法**：`const uni = (uniModule.default ?? uniModule)` 显式解包（`vitest.uni.config.ts` 同病同治）。
2. **uni-app 把 `resolve.preserveSymlinks` 设成 `true`**（`@dcloudio/uni-cli-shared/dist/resolve.js:24`
   与 `@dcloudio/vite-plugin-uni/dist/config/resolve.js:64`）⇒ 在 **pnpm 的符号链接布局**下深层裸 import 解析失败：
   H5 构建报 `[vite]: Rollup failed to resolve import "socket.io-parser" from …/socket.io-client/build/esm/index.js`。
   **修法（POC 实测有效）**：在 `uni()` **之后**追加一个插件
   `{ name: '…', config: () => ({ resolve: { preserveSymlinks: false } }) }`
   —— Vite 的 plugin `config` 是**后合并者胜**，所以必须排在 `uni()` 后面。
3. **三端产物目录名不是对称的**：`dist/build/h5` · `dist/build/mp-weixin` · **`dist/build/app`**（**不是 `app-plus`**）。
4. **动态 `import()` 会让 App 端构建失败**：`x Build failed` /
   `Invalid value "iife" for option "output.format" - UMD and IIFE output formats are not supported for code-splitting builds`。
   改成**静态** `import { io } from 'socket.io-client'`（= 现 `main.ts` 的形态）后 **h5 / mp-weixin / app 三端全绿**。
   ⇒ **App 端不得用动态 import 造 chunk。**
5. **vue 的 peer 版本不齐**（pnpm 警告）：`@vue/server-renderer 3.4.21` 的 peer 是 **精确 `vue@3.4.21`**，
   而项目装 `3.5.13`；`@dcloudio/types` 的 peer 是 `3.4.31`、装到 `3.4.32`。⇒ Task 1 装依赖后**必须记录**这一对警告，
   判断是否需要把 `vue` 钉到 `3.4.21`（**不得**靠「构建过了」就说没事）。

### 小程序端：从「猜测」升级为**静态证据**（硬约束 (e) 的实锤）

`npx uni build -p mp-weixin` **能编译通过**（`DONE Build complete.` → `dist/build/mp-weixin`），
但 `common/vendor.js` 里**确实打进了 socket.io-client + engine.io-client 的浏览器传输实现**：
`grep -c` 读数 `XMLHttpRequest=1 · WebSocket=2 · Blob=1 · engine.io=1`（引擎里还有 `fetch(this.uri()…)` / `Headers` / `FileReader`）。
微信小程序运行时**没有** `XMLHttpRequest`/`WebSocket`/`Blob`（只有 `wx.request`/`wx.connectSocket`）
⇒ **必须有传输适配层**；本机**没有微信开发者工具** ⇒ 端到端结论仍**登记为「未验证」**（R440/R447）。

### 环境坑（复现了 briefs 的 R141，**本片门禁必踩**）

`docker compose exec -T redis redis-cli ZCARD 'ratelimit:ws-conn:::ffff:172.19.0.1'` 实测 **5**（POC 期间被残留连接占满）
⇒ 之后任何 WS 握手都被 `[ProxyGateway] Rejecting WS handshake …: 10006 too many connections from this IP` 挡掉，
客户端表现为 **`connect_error: websocket error`**（极像「后端挂了」）。
`redis-cli DEL` 该键后立刻恢复。⇒ **跑探针/conformance 前后都先看这个键**。

### 执行期裁决（Task 0）

- **R448**（协调者）**Task 0 通过，按原计划进入 Task 1；R433 不启用**。依据：Q1/Q2/Q4 全绿、Q3 的失效面已量化到 3 个选择器。
  **R433（把 UI 断言降级为 store/探针）不启用** —— `@vue/test-utils` 对新标签照旧可用，**没有一条断言需要搬家**（也就没有「搬去哪」要写）。
- **R449**（协调者）**探针的 3 个 `button` 选择器改成 `uni-button`**（`.login__actions uni-button` / `.lobby__match uni-button` /
  `.table__bar uni-button`），其余 9 个**不动**（class 锚点全部保留，R432/R434 不变）。依据：Q3 的逐条实测表。
  代价若判错：`clickByText` 返回 `not-found`，探针当场红（**不会静默**）。
- **R449 补**（协调者，Task 1 执行期修正）**上一条的改法改为「锚 class」而不是「锚 `uni-button`」**：
  三处选择器实际改成 `.login__actions .btn` / `.lobby__match .btn` / `.table__bar .btn`。
  **理由**：Task 2 允许引入 UI 组件库（R441），届时按钮可能不再是 `uni-button`（如 `<u-button>`）；
  写死 `uni-button` 会在 Task 2 再断一次，而 class 锚点（R432 已保证 class 名不改）**两段都活**。
  代价若判错：同样是 `not-found` 当场红（判据不退化为空测）。
- **R450**（协调者，执行位置）**Task 1–4 在主检出 `/home/howe/pokergame`（master）上做，不新建/不切换 worktree**。
  依据：① 计划里那棵 `feat/frontend` worktree 停在 `1baf3a2`（落后很多），合并它带来的风险大于收益；
  ② R438 已禁止第二个前端目录，而 Task 2 要动**全部 7 个 `.vue`** ⇒ 本来就无法并行；③ 本仓历次切片的协调者都在 master 上提交。
  代价若判错：master 上出现中间态提交（用「每段一个 commit + 每段门禁绿」缓解，R430 不变）。
- **R441 补**（协调者，Task 2 开工前的**组件库选型实测**）**选定 `wot-design-uni@1.14.0`（+ `sass@1.79.6` 作 devDependency）**，
  且**只准 easycom 使用、零 import**。依据（一次性 POC 实测，`/tmp/p10-poc`）：
  ① `peerDependencies: { vue: ">=3.2.47" }`（本项目 3.5.42 ✓）、自身零 dependencies；
  ② `easycom` 规则 `"^wd-(.*)": "wot-design-uni/components/wd-$1/wd-$1.vue"` 下 **h5 / mp-weixin / app 三端构建全绿**；
  ③ H5 运行期真实 DOM：`<uni-button class="wd-button is-primary is-medium is-round poc-wd">`（**自定义 class 保留在根元素**），
  **0 条 console error/warn**。
  ④ **零 import 是硬要求**：`test/source-boundary.test.ts` 断言 `src/**` 的裸依赖**恰好**是
  `['pinia','socket.io-client','vue']`（§12.4 的闸，R435 不许放宽）⇒ 组件库一旦被 `import` 就会打红这道闸。
  **代价若判错**：组件库若在某个端运行期出问题，本机只能验 H5（小程序/App 的用户回填会带回结论）；
  回滚面很小（删 easycom 规则 + 逐个换回 core 组件）。
- **R441 补②**（协调者）**交互控件不换库**：`button` / `input` 保持 **uni-app core 组件**，
  库只用于展示型/反馈型元素（`wd-cell`/`wd-cell-group`/`wd-card`/`wd-tag`/`wd-divider`/`wd-loadmore`），
  反馈用 uni 核心 API（`uni.showToast`/`uni.showModal`，无需 import）。
  依据：P9 的真浏览器探针与 21 个测试文件的交互路径**只在本机的 H5 上可验证**；
  小程序/App 本机跑不起来（R440/R447）⇒ 不拿唯一的已验证路径做实验。
  代价若判错：UI 观感少一点「组件库味」，但换回成本为零（core 组件本就是合法 uni-app 组件）。
- **R441 补③**（协调者，Task 2 门禁期实测）**本片每一段的门禁改为「逐端」跑三端构建**
  （`build:h5` + `build:mp-weixin` + `build:app`），这是对 **Task 1 门禁口径**的修正。
  依据：Task 1 交付的 `<component :is="current">` 在 `build:h5` 下绿、在 `build:mp-weixin` 下**编不过**
  （实测 `[vite:vue] <component is=""/> is not supported`）——**端维度的漏检**是本片自己抓到的第一个缺口。
  代价若判错：每段多花 ~40s 构建；换来的是「每段绿」在三个端上都成立。
- **R449 补②**（协调者）**真浏览器探针补上「动手前等 DOM」**（`waitForSelector`）并把点击结果写进 detail。
  依据：Task 2 门禁期实测到一次 `gate` **13/16** 与两次 **16/16** 的不确定结果，
  根因是探针自身在**冷启动**下先点后等（`inputs.length < 2` 静默、`clickByText` 的 `not-found` 未被断言）。
  **判据与条数一字未改**（只加了前置等待与诊断读数）—— 这是「判据自身不确定」的第三类假红（P14 教训 2 的同族）。
  代价若判错：探针多等最多 20s/处。
- **R449 补③**（协调者）**探针的第二类竞态：页面栈让 store 再次早于 DOM**。
  Task 3 换成真实页面栈后，`auth.page` 是 `navigate()` **先写 store、再 `reLaunch`** ⇒
  判据 `page=table && hand>=17` 命中时牌桌**可能还没渲染**，「DOM 数出 17 张牌」会数到 0。
  处置：`waitForSelectorCount('.table__me .card', 17, 12s)`；**阈值与判据不变**（给渲染一个有界窗口）。
  验证：3 次冷启动 `gate` 16/16。
- **R449 补④**（协调者）**门禁新增「发行产物级」探针**（这是本片对 R437 门禁清单的**扩充**，不是放宽）：
  ```bash
  pnpm --filter @fight-the-landlord/client build:h5
  pnpm --filter @fight-the-landlord/client preview          # 4173，vite.config.ts 的 preview.proxy
  node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server --scenario minimal
  node scripts/browser-e2e.mjs --base-url http://localhost:4173/ --no-server
  ```
  依据：Task 3 实测到「**dev 正常、发行版静默失效**」这一类缺陷（H5 摇树只注入空的 `window.uni`），
  而**探针默认跑 dev，结构上抓不到它**。实测：`minimal` **8/8** · `gate` **16/16**（发行产物）。
  代价若判错：每条多 ~10s（build 一次）；换来的是「用户真正拿到的产物」被端到端压过一遍。
- **R441 补④**（协调者，Task 3 执行期裁决）**冷启动对齐用 `onMounted` 代替页面生命周期 `onShow`**。
  依据：`onShow` 来自 `@dcloudio/uni-app`，而 §12.4 的裸依赖闸把 `src/**` 的依赖钉死为
  `['pinia','socket.io-client','vue']`（R435：不得以「框架换了」为由放宽任何一条）；
  Vue 未导出 `injectHook`，`<script setup>` 页面在 H5 也不走 Options API 的页面钩子通道
  （`$applyOptions` 只有赋值点、没有调用点，产物已证实）。
  **等价性不变量**：本项目**只允许 `reLaunch` 导航**（一步一页）⇒ 页面实例不会被重新显示
  ⇒ 对每个实例 `onShow` 恰好发生一次 = 挂载那一次。正/负对照测试在 `test/page-stack.test.ts`。
  ⚠️ **代价与失效条件**：一旦引入 `navigateTo`（带返回栈、页面会被重新显示），
  这条等价性立刻失效 ⇒ 那时必须改用真正的 show 钩子，并重新裁决裸依赖白名单。

# 计划 B「客户端」：玩法大厅页 + 开始游戏页 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已定稿的视觉语言（总规格 §5.2.1）重做 App 的**玩法大厅页**与**开始游戏页**，并把「点玩法=选中 / 点底分=进入」这条新流转端到端打通（含真浏览器探针）。

**Architecture:** 前端仍是**哑终端**（`docs/design.md` §12）：底分与场次名**全部来自服务端档位表**（`GET /api/base-score-levels`），前端零规则常量（M09）。大厅挂载时取一次档位表 + 一次用户资料，写进 Pinia store；两页之间**不用路由传值**（`auth.navigate` 只切页），用 store 的三个字段当接口：`activeMode`（已有）· `selectedBaseScore`（新增）· `baseScoreLevels`（新增）。

**Tech Stack:** uni-app CLI（Vue 3 `<script setup>` + SCSS）· Pinia · vitest + @vue/test-utils（jsdom）· 零依赖 CDP 真浏览器探针（`scripts/browser-e2e.mjs`）· 纯 `node:http` 的 mock REST 面。

## Global Constraints

以下每条都是**逐字**从规格/上位规格抄来的硬约束，每个任务的实现都必须满足：

- 🔴 **前端是哑终端**：只依赖 `@fight-the-landlord/protocol`；**绝不** `import @fight-the-landlord/shared`；**不含任何规则常量**（底分/倍数/牌型 —— M09）。`apps/client/test/source-boundary.test.ts` 必须一直绿。**这就是「底分只能来自服务端档位表」而不是写死 15 的原因。**
- 🔴 **视觉语言照抄总规格 §5.2.1**，不各自发挥：半透明面板 `rgba($ftl-color-night, .62)` · 面板描边 `$ftl-hairline` 实线 `$ftl-color-night-deep` · 面板圆角 `$ftl-radius-lg` · 主按钮 = `background: $ftl-color-gold` + 描边 `$ftl-color-gold-deep` + 白字（**不带贴图** —— `background-image: url($ftl-btn-plate-primary)` 与 `background-size` 必须一并删掉）· 次按钮 = 透明底 + `$ftl-hairline` 实线 `$ftl-color-night-soft` + 白字 · 幽灵按钮 = 透明底 + `$ftl-hairline` 虚线 `rgba($ftl-color-on-primary, .45)` · 面板内标签字 `rgba($ftl-color-on-primary, .75)` · 深色底上的错误文字 `$ftl-color-danger-on-dark` · 大标题白字 + 多层 `text-shadow` · 输入框保持白底深字 · 分段/选中控件 = 槽底 `rgba($ftl-color-night-deep, .55)` + 项透明底/hairline 实线 `$ftl-color-night-soft`/字 `rgba($ftl-color-on-primary, .75)`、选中 = 描边 `$ftl-color-gold` + 底 `rgba($ftl-color-gold, .18)` + 字 `$ftl-color-gold-light` + 700。
- 🔴 **机械闸（`apps/client/test/ui-tokens.test.ts` 一直绿）**：尺寸一律 `px`（**禁 `rpx`/`em`/`rem`/`vw`/`vh`/`pt`**）· 描边一律 `$ftl-hairline`（**禁手写 `1px`**）· 除 `src/uni.scss` 外**禁裸十六进制色值** · `line-height` 用**无单位**数值 · 每个 `.vue` 必须有一个 `<style lang="scss">` 块（**空块也要留着**）。
- 🔴 **组件样式里不能用 SCSS `@use`** —— uni-app 把含 `@mixin` 的 `uni.scss` 前置到每个 scss 块 ⇒ 只能 `@import`。本计划里一处都不需要 `@use`。
- 🔴 **模板注释必须在根元素「内部」**：写在根元素**之前**会让整页变成 fragment root，`@vue/test-utils` 的 `classes()` **静默**返回 `[]`（`table-hud.test.ts` 的单根闸盯着）。
- 🔴 **`uni.xxx(...)` 必须是直接的成员调用**（不要 `const api = uni`）：H5 发行构建靠编译器改写这种直接调用（`net/storage.ts#hasUni` 的注释）。机械闸 `test/uni-api-access.test.ts`。
- 🔴 **`docs/design.md` v4.3 是唯一依据**；`newdocs/` 是未实施的岔路（用户视为误导）。
- 🔴 **小程序不在范围内**（H5 + App；mp 代码冻结不删）。
- **提交纪律**：每个任务结束提交一次；提交信息结尾逐字加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **Windows 本机**：改服务端源码要 `docker compose build <svc>` + `up -d`（**宿主 dist 挂载已删**）；`docker compose exec mysql` 改中文必须带 `--default-character-set=utf8mb4`；Windows Git Bash 碰容器内路径要 `export MSYS_NO_PATHCONV=1`。

---

## 0. 🔴 全片最重的一条：真浏览器探针必须改，而且必须**真跑**

`scripts/browser-e2e.mjs` 是**唯一**覆盖「前端 ↔ 真后端」这条接缝的判据（13 条 conformance 全是协议级、客户端单测跑在 mock 上）。本片的流转变更会让它**当场断**：

| 位置 | 现状 | 为什么必断 |
|---|---|---|
| `:447` | 等 `.lobby__mode, .game__match .btn` 任一出现 | 仍在，但 `.lobby__mode` 不再是「进入」 |
| `:451` | 点 `.lobby__mode` 然后等 `.game__match .btn` | **点完不再跳页** ⇒ 干等 20 秒超时 |
| `:550-552` | 同上（`ensureGamePage` 里） | 同上 |
| `:464` | `clickByText('.game__match .btn', '随机匹配')` | 文案按规格 §4 改成「**开始游戏**」⇒ `not-found` |
| `:554` | 等 `.game__create-room` | 建房按钮**移进「好友房」弹层** ⇒ 弹层关着时**不在 DOM 里** ⇒ 等 20 秒超时 |

⚠️ **探针本片不是零改动** —— 这与片② 那条「探针本片零改动」的全局约束**方向相反**，必须显式记账（见 §1）。改法在 **Task 6**，每个调用点逐条说明。**改完必须真跑**（`pnpm run e2e:browser`，以及 `--scenario full`），不是「改完就算」。

---

## 1. 判据改动记账（上位规格 §7.1 的硬要求）

**反例纪律**：不接受「把断言改绿」。每条都写清 **为什么改 + 改完还测不测得到那个性质**。

⚠️ **一处「删了但没有判据」的改动，一并记账**（复核订正：把**全部**被删的 class 列全）：
新大厅顶栏的左位让给了「头像 + 昵称 + 货币占位」，页面里那句 `<text class="lobby__title">大厅</text>`
**随之去掉**（参考图 1 的顶栏也没有页名，而左栏自己的 `.lobby__modes-title`「选择玩法」已经说清这屏是什么）。
复盘时把三个**一并删掉且零判据锚着的** class 也查了出来 —— 它们都是被新结构取代的旧骨架：

| 被删 | 取代者 | 判据 |
|---|---|---|
| `.lobby__title` | （顶栏让位给信息条） | 全仓 **0** 条锚着 |
| `.lobby__header` / `.lobby__me` | `.lobby__bar`（顶栏）+ `PlayerChip`（`.lobby__player`） | 全仓 **0** 条锚着 |
| `.game__start`（模板容器 + CSS） | `.game__stage`（中央区） | 全仓 **0** 条锚着 |

已核：这些 class 全仓 grep 只出现在**历史** plan/spec 文档里（2026-09-17 / 2026-09-22 那几片），
**不是活判据**。`pages.json` 的 `navigationBarTitleText`「大厅」是**另一处**
（`landscape-canvas.test.ts:140` 断言的是 `pages.json`，**本步不动它**）。

| 受影响的判据 | 为什么改 | 改完还测不测得到原性质 |
|---|---|---|
| **`scripts/browser-e2e.mjs`（4 处）** | §0 的表 | ✅ 逐条在 Task 6 说明；改完**真跑**（这是本片唯一的端到端证据） |
| **`lobby-modes.test.ts`「点玩法卡 ⇒ 进玩法页」** | `.lobby__mode` 的语义从「进入」变「**选中**」（规格 §3 裁决一） | ✅ **更强**：新断言是「写 `activeMode` **且 `auth.page` 仍是 `lobby`**」——旧断言在「点完跳页」和「点完没反应」之间分不出来，新断言把「**必须不跳页**」这半边也钉住了 |
| **`lobby-modes.test.ts`「只有一个玩法卡…」** | 卡内多了一个选中态 class；`.lobby__modes-title` 从「选择玩法」不变 | ✅ 原样保留（结构/文案/`<button>`/图标兜底四条一个没少） |
| **新增 `base-score-selection.test.ts`** | 本片新增的判据（档位表 + 选中底分的跨页接口） | ✅ 见 Task 1/Task 4 |
| **`auth-ui-wiring.test.ts`「档位表加载失败」3 条** | 档位表的 fetch **从开始游戏页搬到了大厅**（规格 §2 遗留项 1 的处理） | ✅ 性质**不降反升**：新断言 = 「大厅拿不到档位表 ⇒ **零** `.lobby__level` 卡」⇒ 用户**无从选** ⇒「不猜一个底分」（M09）在**用户能看见的那一步**上成立。旧断言只是「报错文案在 + 没发 room.match」，而「没发」在新结构里是**恒真**的（大厅根本没有 `room.match`）⇒ 必须换成有判别力的那一条。**另加一条 10004 ⇒ 回登录页**（这正是交接文档记的缺口：旧的档位表失败路径**没走** `dispatchRestFailure`） |
| **`auth-ui-wiring.test.ts` 匹配组若干条** | 匹配按钮文案「随机匹配」→「开始游戏」；`match()` 不再自己 fetch ⇒ 需要预置 `store.selectedBaseScore` | ✅ 判据本身一条没少（发 `room.match` 时 `baseScore` 取自**选中的**底分、12009 幂等、12007 复位、取消匹配），只是前置状态由「stub 一个档位表响应」换成「写 store」—— **更直白**：它现在断言的是「用的是选中的那个值」而不是「用的是表里的第一个」 |
| **`lobby-ux.test.ts` 建房/房号/列表组** | 这三个入口移进「好友房」弹层 ⇒ 动手前要先开弹层 | ✅ 判据没变（REST 占座先于 WS `room.join`、失败不发 join、房号归一化）。**新增一条**：弹层关闭时 `.game__create-room` **不在 DOM 里**（否则「收进弹层」这件事无法证伪） |
| 🔴 **`lobby-ux.test.ts` 的 R658/R760 组（两条）** | `match()` 改成用 `store.selectedBaseScore`（用户选的那一档）后，**没预置就早退** ⇒ 两条都会以「0 条 `room.match`」变红 | ✅ **判据一条没少**（无意向 ⇒ 不发、有意向 ⇒ 恰好一条、读后即清、幂等）。变的只是「那个值从哪来」。⚠️ 预置值取 **80** 而不是 15 —— 15 区分不出「取第一档」与「用选中的」，判别力**变强** |
| **`lobby-ux.test.ts` 源码级 `send('room.join'` 计数** | 无改动 | ✅ 不动 |
| **`settlement-rematch.test.ts` ⑤ `send('room.match'` 计数** | 无改动 | ✅ **仍须恰好 1 处**（`game.vue`） |
| **`page-stack.test.ts`** | 无改动（四页不变、`usePageAlignment` 不变） | ✅ 不动 |
| **`table-hud.test.ts` 单根闸** | 无改动（`.lobby` 仍是页面根 class） | ✅ 不动 |
| **`source-boundary.test.ts` / `ui-tokens.test.ts` / `art-slots.test.ts` / `asset-budget.test.ts`** | 无改动（**不许为了过闸而放宽闸**） | ✅ 不动 |
| ~~**`docs/client-protocol.md` §2**~~ | 🔴 **执行期撤销（用户裁决 2026-09-27）**：Task 2R 撤掉了 `GET /api/users/me` 这条客户端调用 ⇒ **§2 保持「REST：八条」不变**，**Task 8 因此取消** | ✅ 文档与实际调用仍然一致（这正是它存在的意义）；**取消一项计划内容也是记账的一部分** |
| **`tools/conformance`** | **本片不新增切片** | ⚠️ **如实记**：§2.5 的「改了即生效」目前只有计划 A 的**一次性人工验证**（§6.1 ②），**没有永久闸**。本片不补（那是 Plan A 的遗留、且是服务端性质），**列为已知缺口**（见文末） |
| 🔴 **`packages/api-gateway/test/gateway.controller.test.ts`（**新增**一条）** | pre-flight 实跑发现 `GET /api/users/me` 在网关上是 **404** ⇒ 用户裁决**补网关路由**。网关因此要有自己的判据 | 🔴 **执行期再撤销（Task 2R）**：那条路由**与这条判据一起**被撤（经网关恒 401，见交接文档 §4）⇒ 判据随实现删除；真栈侧的收尾改由 Task 9 的 curl 钉「**404** —— 路由不再暴露」 |
| 🔴 **`tools/mock-server/test/rest.test.ts`（**新增**）+ `apps/client/.env.mock`** | 原计划只补 mock 侧 ⇒ **浏览器里一条都到不了**（`.env.mock` 的 `VITE_API_BASE` 指 `/api`，vite 代理写死到真网关） | ✅ 新增 6 条判据 + Task 7 Step 7 的**真浏览器**验证（**curl 通 ≠ 浏览器通**，CORS/预检只在浏览器里存在） |
| **`docs/design.md`** | **改**（复核订正 → 终态**再订正**）：§7.1 那句「`/api/users/*` 代理到下游」**不成立** —— 网关从来没有那条前缀路由。中途曾按实况改成「暴露 `GET /api/users/me` 一条」，而 **Task 2R 又把那一条也撤销了** ⇒ **终态 = 网关不暴露 `/api/users/*`**（user-service 自己有 `@Get('me')`，只是网关不代理） | ⚠️ 这不是「顺手改文档」，是 **pre-flight 实跑抓到的「文档说谎」**：那句话在一整个 slice 里都在把人往错的方向指。终态订正的依据是 **Task 6 的真栈实测**（那条路由经网关恒 401，见交接文档 §4） |

---

## 2. 文件结构（先锁边界，再拆任务）

| 文件 | 动作 | 职责 |
|---|---|---|
| 🔴 `packages/api-gateway/src/gateway/gateway.controller.ts` | 改 | **新增 `@Get('users/me')`** → user-service（pre-flight 实跑：这条路由**此前不存在**） |
| 🔴 `packages/api-gateway/test/gateway.controller.test.ts` | 改 | 新路由的转发判据（照 `base-score-levels` 那条的形态） |
| 🔴 `docs/design.md` | 改 | §7.1 订正那句不成立的「`/api/users/*` 代理到下游」 |
| `apps/client/src/net/rest.ts` | 改 | 新增 `BaseScoreLevel` 类型（档位表的形状，**唯一真源**）· 新增 `me()`（`GET /api/users/me`） |
| `apps/client/src/stores/game.ts` | 改 | 新增 `baseScoreLevels` / `selectedBaseScore` 两个**跨页**字段 + `selectedLevelName` getter（场次名按底分查） |
| `apps/client/src/stores/auth.ts` | 改 | 新增 `nickname` / `phone` + `displayName` getter（三级回落）+ `loadProfile()` 动作 |
| `apps/client/src/components/PlayerChip.vue` | **建** | 头像 + 昵称 + 货币占位（**两页共用一份**；哑组件，只吃 `name` prop） |
| `apps/client/src/pages/lobby/lobby.vue` | 改 | 重做：顶栏（头像+昵称+货币占位 / 退出）+ 左玩法竖滚（**点=选中**）+ 右底分横滚（**点=进开始游戏页**） |
| `apps/client/src/pages/game/game.vue` | 改 | 重做：中央「开始游戏」+ 场次名/底分；「好友房」收成**弹层**；左下头像+昵称+货币占位 |
| `apps/client/test/base-score-selection.test.ts` | **建** | store 两字段 + 大厅档位表/选中流转 |
| `apps/client/test/user-profile.test.ts` | **建** | `rest.me()` + `auth` 的昵称/`displayName`/`loadProfile` |
| `apps/client/test/player-chip.test.ts` | **建** | 共用件的渲染与「只吃 prop」性质 |
| `apps/client/test/lobby-modes.test.ts` | 改 | 「选中而不跳页」 |
| `apps/client/test/auth-ui-wiring.test.ts` | 改 | 档位表 4 条搬到大厅；匹配组换前置 |
| `apps/client/test/lobby-ux.test.ts` | 改 | 开局三入口移进弹层 |
| `apps/client/test/ui-flow.test.ts` | 改 | （默认 `describe.skipIf`）走查脚本跟着新流转 |
| `tools/mock-server/src/rest.ts` | **建** | mock 的 REST 面：**两条只读 GET** + CORS/预检 |
| `tools/mock-server/src/index.ts` | 改 | 装上 REST 面；`GameEntry` 记住 `room.match` 带来的底分 |
| 🔴 `apps/client/.env.mock` | 改 | `VITE_API_BASE` 指到 mock 自己（**不补这条，mock 的 REST 面在浏览器里一条都到不了**） |
| `tools/mock-server/test/rest.test.ts` | **建** | 两条 GET 的形状 + CORS/预检 |
| `scripts/browser-e2e.mjs` | 改 | 4 处（§0 的表） |
| `docs/client-protocol.md` | 改 | §2「REST：八条」→「九条」+ 第 9 行 |

**明确不做**（越界项，写下来免得下一个人以为是漏了）：
- ❌ **不接 `$ftl-art-*` 素材槽**。上位规格 §5 的判据记账表**没有** `art-slots` 这一行，而接通任意一个槽会让 `art-slots.test.ts` 的「七个槽缺省值全是 `none`」当场红——那是**片③ 六个槽一起接时**该做的事。登录页样板已经立了先例：**图片走 `<image src="/static/ui/…">`**（`login.vue` 的 `logo.png` 就是这么写的），本片沿用。
- ❌ **不做「每页可选底纹」**（YAGNI，规格 §5.3）。
- ❌ **不加设置齿轮**（规格 §6.2 订正：顶栏右**只放退出**；本仓明文忌讳「点了没反应的活按钮」）。
- ❌ **不新增路由/页面**（好友房是**弹层** —— 页面栈的唯一真源仍是 `auth.page`）。
- ❌ **不新增 conformance 切片**（见 §1 的如实记账）。

---

## Task 1: `game` store 的两个跨页字段

**Files:**
- Modify: `apps/client/src/net/rest.ts`（只加一个类型）
- Modify: `apps/client/src/stores/game.ts`
- Test: `apps/client/test/base-score-selection.test.ts`（新建）

**Interfaces:**
- Produces:
  - `export interface BaseScoreLevel { name: string; baseScore: number }`（`net/rest.ts`）
  - `useGameStore().baseScoreLevels: BaseScoreLevel[]`（缺省 `[]`）
  - `useGameStore().selectedBaseScore: number | null`（缺省 `null`）
  - `useGameStore().setBaseScoreLevels(levels: BaseScoreLevel[]): void`
  - `useGameStore().setSelectedBaseScore(baseScore: number): void`
  - `useGameStore().selectedLevelName: string | null`（getter）

- [ ] **Step 1: 写失败的测试**

新建 `apps/client/test/base-score-selection.test.ts`：

```ts
/**
 * 底分档位 + 选中底分（片规格 §3 的「两页之间的接口」）。
 *
 * 判别力说明（三条各打一个面）：
 *  ① 两个字段真的被写进 store，且 `selectedLevelName` 是**按选中的底分查**的
 *     （用一个「第一条不是它」的夹具把「取第一条」这种实现当场打红）；
 *  ② 查不到的底分 ⇒ `null` —— **不编一个场次名**（M09 的同一精神）；
 *  ③ `reset()` **不动**它们（与 `activeMode` 同族：这是**页面的选择**，不是对局状态），
 *     并配一条正对照（对局状态确实被清了）—— 否则这条与「reset 什么也没做」不可区分。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../src/stores/game';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('① 底分档位 + 选中底分是**跨页载体**（片规格 §3）', () => {
  it('两个 setter 写进 store；selectedLevelName 按**选中的**底分查场次名', () => {
    const store = useGameStore();
    expect(store.baseScoreLevels, '起始态必须是空数组（不是 undefined）').toEqual([]);
    expect(store.selectedBaseScore, '起始态必须是 null —— **不预置一个缺省底分**（那是前端规则常量）').toBeNull();
    expect(store.selectedLevelName, '没选之前查不到场次名').toBeNull();

    store.setBaseScoreLevels([
      { name: '休闲场', baseScore: 15 },
      { name: '标准场', baseScore: 80 },
    ]);
    store.setSelectedBaseScore(80);

    expect(store.selectedLevelName, '必须按**选中的**底分查，不是取第一条').toBe('标准场');
  });

  it('查不到的底分 ⇒ selectedLevelName 为 null（**不编名字**）', () => {
    const store = useGameStore();
    store.setBaseScoreLevels([{ name: '休闲场', baseScore: 15 }]);
    store.setSelectedBaseScore(999);
    expect(store.selectedLevelName).toBeNull();
  });

  it('③ reset() 不动这两个字段（页面的选择 vs 对局状态）', () => {
    const store = useGameStore();
    store.setBaseScoreLevels([{ name: '休闲场', baseScore: 15 }]);
    store.setSelectedBaseScore(15);
    store.setMatching(true);

    store.reset();

    expect(store.baseScoreLevels, 'reset 是**对局**边界，不清页面的选择').toHaveLength(1);
    expect(store.selectedBaseScore).toBe(15);
    /**
     * 正对照：对局状态确实被清了 —— 否则这条与「reset 什么也没做」不可区分。
     * ⚠️ 用 `matching`（本用例**显式置脏**过）而**不是** `view`：`view` 从 `state()` 的初值起
     * 一直是 `null`，断言它恒真、零判别力（复核发现）。
     */
    expect(store.matching).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/base-score-selection.test.ts`

Expected: **FAIL** —— `store.baseScoreLevels` 是 `undefined`（`toEqual([])` 红）、`setSelectedBaseScore is not a function`。

- [ ] **Step 3: 在 `net/rest.ts` 里加类型**

在 `apps/client/src/net/rest.ts` 的 `baseScoreLevels()` **上方**插入：

```ts
/**
 * 档位表的一档（片规格 §2.3 的响应形状）。
 *
 * ⚠️ 定义在这里（而不是 store 里）的原因：**形状属于接口**，`rest.baseScoreLevels()`
 * 与消费它的 store 必须共用**同一个**类型 —— 各写一份就是第二真源。
 */
export interface BaseScoreLevel {
  name: string;
  baseScore: number;
}
```

并把既有的 `baseScoreLevels()` 的返回类型改成用它（**只换类型写法，行为一字不改**）：

```ts
export function baseScoreLevels(): Promise<RestResponse<{ levels: BaseScoreLevel[] }>> {
  return authedGet<{ levels: BaseScoreLevel[] }>('/base-score-levels');
}
```

> 注意：这条函数**本片之后由大厅调用**（不是开始游戏页）—— 函数体不动。

- [ ] **Step 4: 在 `stores/game.ts` 里加两个字段 + getter + 两个 action**

在 `stores/game.ts` 顶部的 import 里加：

```ts
import type { BaseScoreLevel } from '../net/rest';
```

在 `state` 的 `activeMode: DEFAULT_MODE_ID as string,` **之后**插入：

```ts
    /**
     * 底分档位表（服务端下发：`GET /api/base-score-levels`）。
     *
     * ⚠️ **跨页载体**（与 `activeMode` 同族）：**大厅**挂载时取一次并写这里，
     * **开始游戏页**复用它查场次名（**不重复调接口** —— 片规格 §3 的第二个接口）。
     * ⚠️ 空数组是**如实的**「还没取到 / 取失败」，**不是**「服务端说没有档位」——
     *    页面据此不渲染任何卡（**不猜一个底分**，M09）。
     */
    baseScoreLevels: [] as BaseScoreLevel[],
    /**
     * 大厅**选中的底分**（片规格 §3 裁决一：点底分卡 = 写它 + 进开始游戏页）。
     *
     * ⚠️ **不预置缺省值**：任何缺省值都是前端规则常量（M09 禁止）。计划 A 的 Task 3f
     * 曾让开始游戏页「取档位表第一档」——那是过渡实现，本片换成「用户选的那个」之后，
     * **「选中的底分」才有可观测的含义**（否则「选了没用」与「没选也能进」不可区分）。
     * `null` = 还没选过 ⇒ 开始游戏页的按钮禁用并给出提示。
     */
    selectedBaseScore: null as number | null,
```

在 `getters` 的 `waitingForDeal` **之后**插入：

```ts
    /** 选中底分对应的**场次名**；查不到返回 `null` —— **不编名字**（片规格 §4）。 */
    selectedLevelName: (s): string | null =>
      s.baseScoreLevels.find((l) => l.baseScore === s.selectedBaseScore)?.name ?? null,
```

在 `actions` 的 `setActiveMode` **之后**插入：

```ts
    /** 写底分档位表（大厅取到后写；取失败写 `[]` —— 空数组的含义见 state 的注释）。 */
    setBaseScoreLevels(levels: BaseScoreLevel[]) {
      this.baseScoreLevels = levels;
    },

    /**
     * 写选中的底分（大厅点底分卡时写、开始游戏页读）。
     * ⚠️ 与 `setActiveMode` 同族：**不是**对局状态，`reset()` 不动它。
     */
    setSelectedBaseScore(baseScore: number) {
      this.selectedBaseScore = baseScore;
    },
```

并在 `reset()` 的**函数体内最后**加一行注释（**不改行为**，只是把「故意不清」写下来）：

```ts
      // ⚠️ 刻意**不**清 `activeMode` / `selectedBaseScore` / `baseScoreLevels`：
      //    它们是**页面的选择**，不是对局状态（spec §3「跨页状态归 store」）。
      //    `reset()` 的三个调用点全是**生命周期边界**（换房间 / 销毁会话 /
      //    服务端要求回大厅），没有一个是「用户想重选底分」。
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/base-score-selection.test.ts`

Expected: **PASS** —— 3 passed。

- [ ] **Step 6: 确认没有打坏既有判据**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/source-boundary.test.ts test/ui-tokens.test.ts`

Expected: **PASS**（`import type` 是纯类型导入，依赖边界闸看到的仍是 `../net/rest` 这个相对路径）。

- [ ] **Step 7: 提交**

```bash
git add apps/client/src/net/rest.ts apps/client/src/stores/game.ts apps/client/test/base-score-selection.test.ts
git commit -m "feat(client): game store 新增底分档位与选中底分（跨页接口）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 用户资料（`GET /api/users/me`）+ `displayName`

**Files:**
- Modify: `packages/api-gateway/src/gateway/gateway.controller.ts`（**新增一条路由**）
- Modify: `packages/api-gateway/test/gateway.controller.test.ts`
- Modify: `docs/design.md`（§7.1 那句不成立的话）
- Modify: `apps/client/src/net/rest.ts`
- Modify: `apps/client/src/stores/auth.ts`
- Test: `apps/client/test/user-profile.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `GET /api/users/me`（**对外可达**，需鉴权）→ `{ code: 0, data: { id, phone, nickname, status? } }`
  - `rest.me(): Promise<RestResponse<UserProfile>>`，`UserProfile = { id: string; phone: string; nickname: string | null; status?: string }`
  - `useAuthStore().nickname: string` · `useAuthStore().phone: string`
  - `useAuthStore().displayName: string`（getter：`nickname || phone || userId`）
  - `useAuthStore().loadProfile(): Promise<boolean>`

> ## 🔴 前提订正（2026-09-27 pre-flight 实测 —— **这条不容跳过**）
>
> 我此前写的「端点是**既有**的、网关已代理 ⇒ **零服务端改动**」**是错的**。实跑真网关：
>
> ```
> GET /api/rooms    + Bearer → 200 {"code":0,"data":[…]}      ← 对照：网关活着、token 有效
> GET /api/users/me + Bearer → 404 {"code":10001,"message":"Cannot GET /api/users/me"}
> ```
>
> 路由表逐条核过：`packages/api-gateway/src/gateway/gateway.controller.ts` 只有
> `auth/{login,register,refresh,logout}` · `base-score-levels` · `rooms`（GET/POST）·
> `rooms/:code/join` · `games/:code`（+ bid/play/pass）；`app.module.ts:23` 只挂
> `GatewayController, HealthController`。我当时的「已核」是把
> `packages/api-gateway/test/proxy.gateway.test.ts:818`（对 **`forwardToUserSvc` 方法本身**的单测）
> 误读成了「路由存在」——**「引用未核」的教科书形态**。顺带：`docs/design.md:976` 那句
> 「HTTP 路由：`/api/auth/*`、`/api/users/*` 代理到 downstream」**本身也不成立**（文档说谎）。
>
> **用户裁决（2026-09-27）**：**给网关补一条路由**（不是退回持久化方案）。
> ⇒ 本任务**第一次**真的动了 `packages/**`，计划 §2 的文件表与 §1 的记账都已按此更新。

- [ ] **Step 1: 网关补上 `GET /api/users/me`（服务端前提，必须先落地）**

> **为什么放在第一步**：客户端那半边（`rest.me()`）整条链都押在「这条路由存在」上。
> 先把服务端这一层做实、有自己的判据，客户端才有真东西可依 —— 否则就是本次 pre-flight 抓到的那个坑：
> **计划押在一个没被核过的前提上**。

先写**失败的测试**。在 `packages/api-gateway/test/gateway.controller.test.ts` 的
`describe('GatewayController（片规格 §2.3：底分档位表路由）')`（`:121` 起）**之后**追加，
**装配逐字复用那个 describe 现成的那一套**：

```ts
/**
 * `GET /api/users/me`（片② 客户端 · 复核订正 2026-09-27）。
 *
 * ⚠️ **为什么这条路由是本片新增的**：它此前**不存在** —— 2026-09-27 的 pre-flight 实跑真网关拿到
 * `404 {"code":10001,"message":"Cannot GET /api/users/me"}`，而客户端要拿它显示顶栏昵称。
 * 用户裁决：补网关路由，不退回「客户端存昵称」。
 *
 * ⚠️ **与底分档位表同形**：转发到 **user-service**（资料在那边），且**不进公开白名单**
 * （没令牌就该 401 —— 它不是登录前要用的东西）。
 */
describe('GatewayController（片② 客户端：用户资料路由）', () => {
  it('GET /api/users/me 转发到 **user-service** 的同名路径', async () => {
    // 装配沿用本文件既有惯例：每个 describe 自己装配一份（上面两组同形）。
    // ⚠️ 它们在各自的 `it()` / `beforeAll()` 作用域里 ⇒ 兄弟 describe **取不到**，
    // 「复用一个工厂」在这里做不到，不要为此去重构那两个与本任务无关的 describe。
    const res = {} as never;
    const proxy = {
      forwardToUserSvc: vi.fn(async () => undefined),
      forwardToRoomSvc: vi.fn(async () => undefined),
    };
    const controller = new GatewayController(proxy as unknown as ProxyGateway);

    await controller.getMe(res, { originalUrl: '/api/users/me', headers: {} });

    expect(proxy.forwardToUserSvc).toHaveBeenCalledWith(
      'GET',
      '/api/users/me',
      null,
      res,
      expect.anything(),
    );
    // 兄弟用例（`:139`）有这条负断言 —— 少了它，「把这条路由也转发给 room-service」的实现能骗过本用例。
    expect(proxy.forwardToRoomSvc).not.toHaveBeenCalled();
  });
});
```

> 🔴 **复核订正（2026-09-27 · 执行期）—— 初稿这条指令是自相矛盾的，记下来**：
> 初稿写「装配**照抄**上面那个 describe … **不要重写一遍脚手架**（同一个装配抄两份是本仓反复清掉的形态）」。
> **这两半不可能同时成立**：那个装配写在 `it()` 的作用域里，兄弟 describe **取不到**。
> 实施者只能内联抄一份，然后写下「逐字一致 —— 本仓不抄第二份脚手架」这句**自相矛盾且与实况不符**的注释
> —— 评审据此给了 Important（本仓「注释是被维护的资产」，一句假注释就是缺陷本体）。
> **实况**：`packages/api-gateway/test/gateway.controller.test.ts` 里 `const proxy = {` 出现 **3 次**，
> 其中 **2 次在本片之前就存在** ⇒「各 describe 自己装配」**就是这个文件的既有惯例**，
> 本片**不该**去改它、也**不该**声称改了它。
> ⇒ 教训同上：**「照抄」与「别抄两份」写在一起时，先核实被抄的东西在不在可复用的作用域里。**

Run: `pnpm --filter @fight-the-landlord/api-gateway exec vitest run test/gateway.controller.test.ts`

Expected: **FAIL** —— `controller.getMe is not a function`。

再实现。在 `gateway.controller.ts` 的 `getBaseScoreLevels` **之后**插入：

```ts
  /**
   * 当前用户资料（片② 客户端）。
   *
   * ⚠️ 它转发到 **user-service**（`users.controller.ts` 的 `@Get('me')` 一直在，只是网关此前
   * **没有把这条路径暴露出去**）—— 与 `base-score-levels` 同一条理由：资料不在网关手里。
   * ⚠️ **不进公开白名单**：没令牌就该 401（`jwt.middleware.ts` 的是**精确**匹配表，没有它）。
   * ⚠️ **与 `rooms` 不存在顺序冲突**：`/api/users/me` 与 `/api/rooms` 是两条不相干的路径
   * （理由同 `getBaseScoreLevels` 上方那条复核订正 —— 本仓不再依赖「静态先于根」）。
   */
  @Get('users/me')
  async getMe(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc('GET', '/api/users/me', null, res, headersOf(req));
  }
```

Run: `pnpm --filter @fight-the-landlord/api-gateway exec vitest run test/gateway.controller.test.ts`

Expected: **PASS**。

再跑网关的**全部**门禁（新路由会被「非 /api 路径 404」「每一跳注入 internalToken」几条射到）：

Run: `pnpm --filter @fight-the-landlord/api-gateway run test`

Expected: **PASS**。

最后**修 `docs/design.md` 那句不成立的话**。§7.1 里的
`- HTTP 路由：\`/api/auth/*\`、\`/api/users/*\` 代理到下游；\`/api/health\` 本地`
逐字改成：

```markdown
- HTTP 路由：`/api/auth/*` 代理到下游；`/api/users/me` 代理到 **user-service**（⚠️ **复核订正 2026-09-27**：
  此前写的是通配 `/api/users/*` —— 那是**不成立的**，网关从来没有那条前缀路由；实际暴露的**只有
  `GET /api/users/me` 一条**，由片② 客户端新增）；`/api/health` 本地
```

- [ ] **Step 2: 写失败的测试（客户端）**

新建 `apps/client/test/user-profile.test.ts`：

```ts
/**
 * 用户资料（`GET /api/users/me`）—— 顶栏与开始游戏页的「昵称」的唯一来源。
 *
 * 判别力说明：
 *  ① `rest.me()` 走**既有**的 `authedGet`（带 Bearer、统一信封、10004 轮换重放）——
 *     断言 URL 与 Authorization，防「另造一份请求封装」；
 *  ② `displayName` 三级回落**每一级都测到**（昵称 → 手机号 → userId）：
 *     只测一级的话，「回落」这个词就没有判别力；
 *  ③ `clearLocalSession()` 必须清掉资料 —— 否则「登出 → 换个人登录」的瞬间，
 *     顶栏会显示**上一个人**的名字（与 `net/storage.ts` 的会话三项同一纪律）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import * as rest from '../src/net/rest';
import { useAuthStore } from '../src/stores/auth';
import { clientConfig } from '../src/config';
import { clearSession, saveSession } from '../src/net/storage';
import { installUniStub } from './helpers/uni-stub';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  installUniStub();
  clearSession();
  clientConfig.token = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSession();
});

/** `fetch` 替身（`rest.ts` 只用到 `status` 与 `text()`）。 */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: status < 400, status, text: async () => JSON.stringify(body) };
    }),
  );
  return { calls };
}

describe('① rest.me()：走既有的 authedGet（不另造请求封装）', () => {
  it('URL 形状 + GET + 带 Authorization（§5.1）', async () => {
    clientConfig.token = 'a1';
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1' });
    const { calls } = stubFetch({ code: 0, data: { id: 'u1', phone: '13800000000', nickname: null } });

    const res = await rest.me();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/users/me');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });
    expect(res.code).toBe(0);
    expect(res.data?.phone).toBe('13800000000');
  });
});

describe('② displayName：三级回落，每一级都测到', () => {
  it('有昵称 ⇒ 用昵称（手机号也在，但昵称优先）', async () => {
    const auth = useAuthStore();
    stubFetch({ code: 0, data: { id: 'u1', phone: '13800000000', nickname: '阿豆' } });
    const ok = await auth.loadProfile();
    expect(ok).toBe(true);
    expect(auth.displayName).toBe('阿豆');
  });

  it('昵称是 null ⇒ 回落到手机号', async () => {
    const auth = useAuthStore();
    stubFetch({ code: 0, data: { id: 'u1', phone: '13800000000', nickname: null } });
    await auth.loadProfile();
    expect(auth.displayName).toBe('13800000000');
  });

  it('两级都没有（开发身份 / 资料取不到）⇒ 回落到 userId（**不是空白、也不是编的名字**）', () => {
    const auth = useAuthStore();
    expect(auth.displayName, '开发身份下显示的就是 devUserId').toBe(clientConfig.devUserId);
  });
});

describe('③ loadProfile：失败如实返回 false，**不改写**已有资料', () => {
  it('拿不到资料 ⇒ false，不抛（调用方按返回值决定提示）', async () => {
    const auth = useAuthStore();
    stubFetch({ code: 0, data: { id: 'u1', phone: '13800000000', nickname: '阿豆' } });
    await auth.loadProfile();

    stubFetch({ code: 10007, message: '下游不可用', data: null });
    const ok = await auth.loadProfile();

    expect(ok).toBe(false);
    expect(auth.displayName, '失败不得把已有资料擦成空').toBe('阿豆');
  });

  it('clearLocalSession 清掉资料（否则换个人登录会看到上一个人的名字）', async () => {
    const auth = useAuthStore();
    stubFetch({ code: 0, data: { id: 'u1', phone: '13800000000', nickname: '阿豆' } });
    await auth.loadProfile();
    expect(auth.displayName).toBe('阿豆');

    auth.clearLocalSession();

    expect(auth.nickname).toBe('');
    expect(auth.phone).toBe('');
    /**
     * ⚠️ 断言是 `''` 而**不是** `userId`：`clearLocalSession()` 把 `userId` 也清空了（既有行为）
     * ⇒ 三级回落全空。这条守的是「**不得留下上一个人的名字**」，不是「回落到 userId」
     *（后者由上面那条开发身份的用例守）。
     */
    expect(auth.displayName, '清干净 —— 不是上一个人的名字').toBe('');
  });
});
```

> ⚠️ 最后一条的 `displayName` 期待值是 `''`：`clearLocalSession()` 把 `userId` 也清空了（既有行为），所以三级回落全部为空。**这是既有的、刻意的行为**（未登录时没有名字可显示）。

- [ ] **Step 3: 跑测试确认它失败**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/user-profile.test.ts`

Expected: **FAIL** —— `rest.me is not a function` / `auth.loadProfile is not a function` / `auth.displayName` 为 `undefined`。

- [ ] **Step 4: 在 `net/rest.ts` 里加 `UserProfile` + `me()`**

在 `joinRoom()` **之后**追加：

```ts
/**
 * `GET /api/users/me` 的载荷（照 `UsersService.getMe` 逐字段抄）。
 *
 * ⚠️ `nickname` **可以是 `null`**（`auth.service.ts` 里 `dto.nickname ?? null`）——
 * 这不是「没字段」，是服务端明确说的「这个人没有昵称」⇒ 消费点必须回落（见 `auth.displayName`）。
 * ⚠️ 它与 `net/rest.ts` 里既有的 `AuthUser`（登录响应的 `user`）**不是**同一个形状：
 * 那里 `phone`/`nickname` 都可选，这里 `id`/`phone` 必在、`nickname` 可空。**不合并** ——
 * 它们是两份不同的服务端契约，合并出来的类型会对两边都撒谎。
 */
export interface UserProfile {
  id: string;
  phone: string;
  nickname: string | null;
  status?: string;
}

/**
 * 当前用户资料（`GET /api/users/me`）。
 *
 * ⚠️ **为什么要它**：顶栏与开始游戏页要显示「昵称」，而登录响应里的 `user.nickname`
 * 只在**登录那一刻**到手、刷新页面就没了（`net/storage.ts` 的契约是「只存令牌三项」，
 * 那是刻意的）。端点是**既有**的 —— 本函数只补客户端这一侧的调用。
 *
 * ⚠️ **只读 GET** ⇒ `authedGet` 的「10004 轮换一次后重放一次」是安全的（无副作用）。
 */
export function me(): Promise<RestResponse<UserProfile>> {
  return authedGet<UserProfile>('/users/me');
}
```

- [ ] **Step 5: 在 `stores/auth.ts` 里加字段、getter、动作**

`state` 里 `loggedIn` **之前**插入：

```ts
    /** 用户资料（`GET /api/users/me`）——**只用于展示**（顶栏 / 开始游戏页的信息条）。 */
    nickname: '' as string,
    phone: '' as string,
```

在 `actions` 之前**新增一个 `getters` 段**（本 store 此前没有）：

```ts
  getters: {
    /**
     * 界面上显示的**用户名**。
     *
     * ⚠️ 三级回落，**每一级都是服务端给过的真值**：昵称 → 手机号 → `userId`。
     * `userId` 这一级是**必需**的：开发身份（`enterAsDevUser()`）与资料请求失败时
     * 没有前两级，而「显示一串内部 id」比「显示空白」或「编一个名字」都诚实。
     *
     * ⚠️ **不得**在这里编造任何文案（如「游客1234」）—— 那是前端造数据（M09 的同一精神）。
     */
    displayName: (s): string => s.nickname || s.phone || s.userId,
  },
```

在 `applySession` **之后**插入动作：

```ts
    /**
     * 取当前用户资料（**只用于展示**）。
     *
     * ⚠️ **不 catch**：H5 上 `fetch` 的拒绝会**抛出**（`net/rest.ts` 记着这条传播行为），
     * 原样交给调用方 —— 只有调用方知道该把提示写进哪一行（与 `rest.rooms()` / `loadRooms` 同形）。
     * 返回 `false` = 服务端明确回了非 0 或缺 `data`，**不是**「加载中」。
     *
     * ⚠️ 失败时**不改写**已有资料：一次网络抖动不得把已经显示对的名字擦成空。
     */
    async loadProfile(): Promise<boolean> {
      const res = await rest.me();
      if (res.code !== 0 || !res.data) return false;
      this.nickname = res.data.nickname ?? '';
      this.phone = res.data.phone ?? '';
      return true;
    },
```

在 `clearLocalSession()` 里 `this.userId = '';` **之后**插入：

```ts
      // 资料同样要清：否则「登出 → 换个人登录」的瞬间顶栏会显示**上一个人**的名字。
      this.nickname = '';
      this.phone = '';
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/user-profile.test.ts`

Expected: **PASS** —— 6 passed。

- [ ] **Step 7: 确认没有打坏既有判据（`page-stack` 那条「除 auth.ts 外不得直接写 page」）**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/page-stack.test.ts test/auth-flow.test.ts test/storage.test.ts`

Expected: **PASS**。

> ⚠️ `page-stack.test.ts` 有一条数 `auth.ts` 里 `this.page =` **恰好 2 处**的判据。本步**不动** `page`，所以仍是 2 处。

- [ ] **Step 8: 提交**

```bash
git add packages/api-gateway/src/gateway/gateway.controller.ts packages/api-gateway/test/gateway.controller.test.ts docs/design.md apps/client/src/net/rest.ts apps/client/src/stores/auth.ts apps/client/test/user-profile.test.ts
git commit -m "feat(gateway+client): GET /api/users/me 落地，顶栏昵称有了真来源

网关此前**没有**这条路由（pre-flight 实跑 404）⇒ 用户裁决补上，
并订正 design.md §7.1 那句不成立的「/api/users/* 代理到下游」。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2R: 撤销「资料路由」，昵称改回登录响应（**用户裁决 2026-09-27 · 执行期**）

> # 🔴 为什么有这一片：Task 2 的方案在真栈上**不成立**
>
> Task 6 的真浏览器实跑顺带核了 Task 2 的收尾判据，结果是 **`GET /api/users/me` 经网关恒 401**：
>
> - `packages/api-gateway/src/gateway/proxy.gateway.ts` 的 `forward()` 逐字只组装**四个**头
>   （`X-User-Id` / `X-Trace-Id` / `X-Token-Jti` / `X-Internal-Token`）—— **从不转发 `Authorization`**；
> - 而 `packages/user-service/src/users/users.controller.ts` 挂的是 `@UseGuards(JwtAuthGuard)`
>   （`jwt.guard.ts` = 裸 `AuthGuard('jwt')`，passport-jwt，**必须** Bearer 头）。
> - 同一把 token：直打 user-service = 200，经网关 = 401（实测）。
>
> **后果**：顶栏会**永久**显示一行「昵称加载失败：…」，名字回落到 `userId`；
> 而它走 `parse()` 折成 `10007`、**不产生 `console.error`** ⇒ **探针与单测都看不见**。
>
> ⚠️ **这是我的两次连续判断失误**：④ 我曾说「端点是既有的、零服务端改动」（错，网关没这条路由）；
> ⑤ 补了路由之后我又说「网关已代理 user-service」（错，鉴权链走不通）。
> **两次都是引用未核。**
>
> **用户裁决（2026-09-27）**：**不要这条路由** —— 客户端改用**登录响应**里的 `phone` / `nickname`，
> 把它们**持久化**进本地会话。理由：零服务端风险，且不必为一格展示文案去改两条服务之间的鉴权契约。

**Files:**
- Modify: `packages/api-gateway/src/gateway/gateway.controller.ts`（**删** `@Get('users/me')` 与其注释）
- Modify: `packages/api-gateway/test/gateway.controller.test.ts`（**删**「片② 客户端：用户资料路由」那个 describe）
- Modify: `docs/design.md`（§7.1 那句话按**实况**改：网关**不暴露** `/api/users/*`）
- Modify: `apps/client/src/net/rest.ts`（**删** `UserProfile` 与 `me()`）
- Modify: `apps/client/src/net/storage.ts`（`StoredSession` 加 `phone` / `nickname`）
- Modify: `apps/client/src/stores/auth.ts`（加两个 state 字段 + `applySession`/`hydrate` 读写；**删** `loadProfile()`）
- Modify: `apps/client/src/pages/lobby/lobby.vue`（**删** `loadProfile()` 与 `profileError` 及其模板/样式）
- Test: `apps/client/test/user-profile.test.ts`（**重写**：不再打接口，改为断言持久化往返）
- Test: `apps/client/test/storage.test.ts`（往返断言要带上两个新字段）
- Test: `apps/client/test/base-score-selection.test.ts`（⑥ 组：删掉「资料取不到 ⇒ 一行提示」那半，保留「取到 ⇒ 昵称进信息条」——但它现在不再来自 fetch）

### 设计（照做）

| 件 | 定 |
|---|---|
| `StoredSession` | 加 `phone: string` + `nickname: string`（**两项都是字符串、缺省 `''`** —— 不要写成可选，那会让每个消费点多一个 `undefined` 分支） |
| `net/storage.ts` | 两个新键 `ftl.phone` / `ftl.nickname`；`saveSession`/`loadSession`/`clearSession` 三处都要带上（**漏一处就是「登出后名字还在」**） |
| `auth.applySession()` | 写 `this.phone = result.user.phone ?? ''` / `this.nickname = result.user.nickname ?? ''`，并**一起持久化** |
| `auth.hydrate()` | 从 `loadSession()` 恢复这两项 |
| `auth.displayName` | getter **不变**：`nickname \|\| phone \|\| userId` |
| `rest.me()` / `UserProfile` / `auth.loadProfile()` | **删除**（不留空壳、不留注释指向它们） |
| `lobby.vue` | 删 `loadProfile()`、`profileError`、`.lobby__profile-error` 的模板与样式；`onMounted` 只剩 `void loadLevels();` |
| `accessToken` 顺序 | ⚠️ `StoredSession` 的字段顺序无所谓，但 `loadSession()` 的**空值判定**仍是「`accessToken` 与 `userId` 缺一不可」——**新两项不参与**（老会话没有它们，不该因此被判成未登录） |

### 判据（TDD：先改测试，看它红，再改实现）

- `user-profile.test.ts` 重写后必须覆盖**四个面**：
  ① `applySession` 后 `displayName` 是昵称；② 昵称 `null` ⇒ 回落手机号；③ 两级都空 ⇒ 回落 `userId`；
  ④ **持久化往返**：`applySession` → `loadSession()` 拿得到 `phone`/`nickname` → 新建 store `hydrate()` 后
  `displayName` 仍是昵称（**这一条是「刷新页面名字不丢」的唯一证据**）。
- `storage.test.ts` 的往返断言要带上两项（**别放宽成 `toMatchObject`** —— 那会让「漏存一项」恒绿）。
- 🔴 **反例纪律**：`user-profile.test.ts` 里那条「网关 401 也会静默」的教训要**留下判据**：
  新设计里**根本不该有**网络调用 ⇒ 加一条**源码级**断言：`auth.ts` 与 `lobby.vue` 都**不得**出现 `rest.me` / `loadProfile`。

- [ ] **Step 1: 改测试（RED）→ 跑确认失败 → 改实现（GREEN）→ 跑确认通过**
- [ ] **Step 2: 网关与 design.md 的撤销** + 跑 `pnpm --filter @fight-the-landlord/api-gateway run test`
- [ ] **Step 3: 客户端全量** `pnpm --filter @fight-the-landlord/client exec vitest run`（全绿）+ `vue-tsc` 干净
- [ ] **Step 4: 提交**（消息写清「撤销路由」与用户裁决）

---

## Task 3: `PlayerChip.vue` 共用件

**Files:**
- Create: `apps/client/src/components/PlayerChip.vue`
- Test: `apps/client/test/player-chip.test.ts`（新建）

**Interfaces:**
- Consumes: 无（哑组件）
- Produces: `<PlayerChip :name="string" class="宿主 class" />` —— 渲染 `.chip` 根，内含 `.chip__avatar` / `.chip__name` / `.chip__coin` / `.chip__currency`

> **为什么不各写一遍**：大厅顶栏与开始游戏页左下是**同一件事**（头像 + 昵称 + 货币占位），
> 而「同一个渲染写两遍会各自过期」正是 `SessionNotice.vue` 抽出来的理由（R751）。
> **为什么不接 `$ftl-art-coin` 槽**：见 §2 的「明确不做」。

- [ ] **Step 1: 写失败的测试**

新建 `apps/client/test/player-chip.test.ts`：

```ts
/**
 * 玩家信息条共用件（大厅顶栏 + 开始游戏页左下）。
 *
 * 判别力说明（三条）：
 *  ① 三个部分**都在**（头像 / 昵称 / 货币占位）—— 少一个就是「重做时丢了一件」；
 *  ② 货币**恒为占位符 `—`**（D12）—— 这条防的是「顺手编个 0 / 3418」（那是造数据）；
 *  ③ **哑**：它**只**渲染 `name` 这个 prop —— 换一个 prop 值就换一个显示，
 *     组件里**没有** store / 网络调用（源码级断言）。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PlayerChip from '../src/components/PlayerChip.vue';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

describe('PlayerChip：头像 + 昵称 + 货币占位（D12）', () => {
  it('① 三个部分都在，且昵称就是传进来的那个值', () => {
    const w = mount(PlayerChip, { props: { name: '阿豆' } });
    expect(w.find('.chip__avatar').exists(), '头像位必须在（R693：不白屏）').toBe(true);
    expect(w.find('.chip__name').text()).toBe('阿豆');
    expect(w.find('.chip__coin').exists(), '货币位必须在').toBe(true);
  });

  it('② 货币恒为占位符 —— 不编数字（D12）', () => {
    const w = mount(PlayerChip, { props: { name: '阿豆' } });
    expect(w.find('.chip__currency').text()).toBe('—');
    expect(w.text(), '不得出现任何数字（「—」是唯一的合法内容）').not.toMatch(/\d/);
  });

  it('③ 哑：换个 prop 就换个显示；组件里没有 store / 网络调用', () => {
    const a = mount(PlayerChip, { props: { name: '甲' } });
    const b = mount(PlayerChip, { props: { name: '乙' } });
    expect(a.find('.chip__name').text()).toBe('甲');
    expect(b.find('.chip__name').text()).toBe('乙');

    const src = collectSourceFiles().find((f) => f.path === 'src/components/PlayerChip.vue');
    expect(src, 'PlayerChip.vue 必须在源码扫描集合里').toBeDefined();
    const code = stripComments(src!.content);
    expect(code, '共用件不得自己取数（那是调用方的事）').not.toMatch(/useAuthStore|useGameStore/);
    expect(code, '共用件不得自己发请求').not.toMatch(/\brest\.|fetch\(/);
    /**
     * ⚠️ 上面那条正则**只抓 `rest.` 这个成员表达式**（复核订正）：写成
     * `import { me } from '../net/rest'` 再直接 `me()` —— 源码里既没有 `rest.` 也没有 `fetch(`，
     * 会溜过去。所以补一条**按导入源**拦的：共用件根本**不该**引 net / stores 这两层。
     * （`uni.request` 同理：本组件也不该直接碰宿主。）
     */
    expect(code, '共用件不得 import net / stores / 直接碰宿主').not.toMatch(
      /from\s+'\.\.\/(net|stores)\/|uni\.request/,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/player-chip.test.ts`

Expected: **FAIL** —— `Failed to resolve import "../src/components/PlayerChip.vue"`。

- [ ] **Step 3: 写组件**

新建 `apps/client/src/components/PlayerChip.vue`：

```vue
<script setup lang="ts">
/**
 * 玩家信息条（**共用件**）：头像 + 昵称 + 货币占位。
 *
 * ⚠️ **为什么抽出来**：大厅顶栏与开始游戏页左下是**同一件事**，而「同一个渲染写两遍会
 * 各自过期」——这是 `SessionNotice.vue`（R751）抽出来的同一条理由。
 *
 * ⚠️ **它必须是哑的**：只渲染 `name` 这个 prop，**不自己取数**、不判断登录态。
 * 这样宿主要不要请求资料、失败了怎么提示，都留在页面那一层（单一职责）。
 *
 * ⚠️ **`class` 由宿主传**（`.lobby__player` / `.game__player`）：本组件不持有布局
 * ——与 `SessionNotice.vue` 同一条约定。默认观感（头像圆环、字色）在下面自持。
 *
 * ⚠️ **货币恒为 `—`**（D12 用户裁决：占位空槽，**不编数字**）。
 * 这里**不打接口、也没有第二个数据源** —— 货币系统不存在。
 *
 * ⚠️ 头像是**静态兜底图** `default.png`（D13 的 `resources/UI/` 授权范围内，片① 已入库）：
 * 服务端今天**不下发**头像 URL，所以没有「按用户取头像」这回事（不造数据源）。
 * 走 `<image src="/static/ui/…">` 而不是 `$ftl-art-*` 槽 —— 与登录页样板的
 * `logo.png` 同形；槽的接通留给片③（见计划的「明确不做」）。
 */
defineProps<{ name: string }>();
</script>

<template>
  <view class="chip">
    <!--
      ⚠️ **本注释必须在根元素内部**（放在根元素之前会让本组件变多根：
      宿主的 class / `@vue/test-utils` 的 `classes()` 都会静默失效）。
    -->
    <image class="chip__avatar" src="/static/ui/default.png" mode="aspectFit" />
    <text class="chip__name">{{ name }}</text>
    <view class="chip__coin">
      <image class="chip__coin-icon" src="/static/ui/dou.png" mode="aspectFit" />
      <text class="chip__currency">—</text>
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（**只引用，不改定义**）——
 * 令牌是全局的，改一个值会同时改掉四个页面。
 */
.chip {
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
  min-width: 0;
}
/**
 * 头像：圆形。参考图里头像外面有一圈白环（`$ftl-art-avatar-ring` 那个槽还没素材）
 * ⇒ 这里用 `$ftl-hairline` 实线描边当兜底，**不是**第二套头像设计（R693：不白屏）。
 *
 * ⚠️ **尺寸用 `$ftl-control-h-sm`（56px）而不是 `$ftl-size-avatar`（98px）**：后者是
 * **牌桌座位**的头像位（参考图实测 φ98）；顶栏只有 `$ftl-bar-h`（64px）高，
 * 塞 98px 会把整条顶栏撑变形。56px 与顶栏的按钮同高，视觉上是一条线。
 * ⚠️ 这个数是**观感类取值** ⇒ 最终由真浏览器截图并排定（本仓对观感的既有纪律：
 * 不写机械判据），要改就改这一个数。
 */
.chip__avatar {
  flex: 0 0 auto;
  width: $ftl-control-h-sm;
  height: $ftl-control-h-sm;
  border: $ftl-hairline solid $ftl-color-on-primary;
  border-radius: $ftl-radius-pill;
  background: $ftl-color-surface;
}
.chip__name {
  overflow: hidden;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip__coin {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-2;
}
.chip__coin-icon {
  width: $ftl-font-lg;
  height: $ftl-font-lg;
}
/** 货币占位（D12）：弱化到「看得出是个空槽」。 */
.chip__currency {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-md;
  line-height: 1.2;
}
</style>
```

> ⚠️ 头像用 `$ftl-control-h-sm`（56px），与顶栏同高 —— 98px 的 `$ftl-size-avatar` 是**牌桌座位**
> 的尺寸，用在这里会把顶栏撑变形。真浏览器截图并排后若明显不合适，改的是 `.chip__avatar`
> 里那两个数，**不改令牌**（令牌是全局的，改一个值会同时改掉牌桌）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/player-chip.test.ts`

Expected: **PASS** —— 3 passed。

- [ ] **Step 5: 跑机械闸（新 `.vue` 会被三处扫描面吃到）**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/ui-tokens.test.ts test/art-slots.test.ts test/source-boundary.test.ts`

Expected: **PASS**。特别注意 `ui-tokens` 的「每个 `.vue` 的 `<style>` 都声明 `lang="scss"`」与「禁裸十六进制」两条 —— 新文件必须自己满足。

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/components/PlayerChip.vue apps/client/test/player-chip.test.ts
git commit -m "feat(client): PlayerChip 共用件（头像 + 昵称 + 货币占位）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 大厅页重做（顶栏 + 左玩法竖滚「点=选中」+ 右底分横滚「点=进入」）

**Files:**
- Modify: `apps/client/src/pages/lobby/lobby.vue`（整体重做模板与样式；`<script setup>` 增补）
- Modify: `apps/client/test/lobby-modes.test.ts`
- Test: `apps/client/test/base-score-selection.test.ts`（追加）

**Interfaces:**
- Consumes: `useGameStore().setBaseScoreLevels` / `.baseScoreLevels` / `.setSelectedBaseScore` / `.selectedBaseScore` / `.activeMode` / `.setActiveMode`（Task 1）· `useAuthStore().displayName` / `.loadProfile()`（Task 2）· `PlayerChip`（Task 3）· `rest.baseScoreLevels()`（既有）
- Produces: DOM 锚点 `.lobby__bar` · `.lobby__player` · `.lobby__exit` · `.lobby__modes` / `.lobby__mode` / `.lobby__mode--active` · `.lobby__levels` / `.lobby__level-list` / `.lobby__level` / `.lobby__level-name` / `.lobby__level-base` / `.lobby__level--active` · `.lobby__levels-error` · `.lobby__profile-error`（`.lobby` / `.lobby__notice` / `.lobby__modes-title` / `.lobby__mode-list` / `.lobby__mode-name` / `.lobby__mode-tagline` / `.lobby__mode-icon` / `.lobby__mode-icon-char` **保持不变**）

- [ ] **Step 1: 写失败的测试（追加到大厅组的既有文件 + 新文件）**

**1a.** 改 `apps/client/test/lobby-modes.test.ts` 的 `describe('➋ 大厅的玩法入口区（玩法卡）')` 里的这一条（**整体替换**）：

```ts
  it('点玩法卡 ⇒ 只写 store 的 activeMode、**不跳页**（片规格 §3 裁决一 · 行为变更）', async () => {
    const { wrapper, store } = mountLobby();
    await flushPromises();

    // 正对照：点之前仍在大厅
    expect(useAuthStore().page, '未点之前仍在大厅').toBe('lobby');

    /**
     * T2-R1 的判别力保留：**断言「这次点击调了 setActiveMode」**，不是只看值 ——
     * `activeMode` 的默认值恰好就是唯一那张卡的 id（`DEFAULT_MODE_ID === 'doudizhu'`）
     * ⇒ 只断言 `store.activeMode` 今天**不可能失败**。
     */
    const setActiveMode = vi.spyOn(store, 'setActiveMode');
    await wrapper.find('.lobby__mode').trigger('click');

    expect(setActiveMode, '点了哪张卡就写哪个玩法 id').toHaveBeenCalledWith('doudizhu');
    expect(store.activeMode, '写入落到 store 上').toBe('doudizhu');
    /**
     * 🔴 **本片的行为变更**：片③ 起这里是「一步进入」（`enterMode` → 直接 `navigate('game')`）。
     * 现在点玩法卡**只切换选中**，进页要靠**点底分卡**（`enterLevel`）。
     * 这条断言是**新的性质**（旧断言在「点完跳页」与「点完没反应」之间分不出来）。
     */
    expect(useAuthStore().page, '点玩法卡**不得**跳页（片规格 §3 裁决一）').toBe('lobby');
  });
```

**1b.** 同文件里那条「玩法卡不再有「进入」按钮…」保持不变；在同文件 `mountLobby` 里**不动**（`stubFetch(() => ({ code: 0, data: list }))` 对档位表接口同样返回 `{code:0,data:[]}` ⇒ `baseScoreLevels` 为空数组，符合「取失败」的形态，不影响本组任何断言）。

**1c.** 在 `apps/client/test/base-score-selection.test.ts` 里**改 import 与 `beforeEach`**，并在**末尾追加**两个 `describe`。

**先把文件顶部改成**（Task 1 写的那版要扩）：

```ts
/**
 * 底分档位 + 选中底分（片规格 §3 的「两页之间的接口」）。
 *
 * ① ② ③ 组是 **store 单元**（Task 1）；④ ⑤ ⑥ 组是**大厅页**（Task 4）。
 *
 * ⚠️ 大厅那三组的挂载姿势逐字照抄 `lobby-modes.test.ts`：`beforeEach` 建**一个** pinia
 * 并 `setActivePinia`，页面经 `global.plugins` 拿到的**必须**是同一个实例 ——
 * 否则用例里 `useGameStore()` 拿到的是另一个 store，断言会静默失配。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import { useGameStore } from '../src/stores/game';
import { useAuthStore } from '../src/stores/auth';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { clearSession, saveSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { installUniStub } from './helpers/uni-stub';
import { FakeSocket } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  installUniStub(); // 大厅要读本地会话（`clearSession` / `saveSession` 走 uni 存储 API）
  localStorage.clear();
  clientConfig.token = '';
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
});
```

（Task 1 那三个 `it` 用的 `useGameStore()` / `describe` / `it` 都在上面这份 import 里，**不用改它们**。）

**再在文件末尾追加**：

```ts
/** `fetch` 替身：按 URL 分流（档位表 / 用户资料 / 其它）。 */
function stubRoutes(routes: Record<string, unknown>, fallback: unknown = { code: 0, data: [] }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => url.includes(k));
      return { ok: true, status: 200, text: async () => JSON.stringify(key ? routes[key] : fallback) };
    }),
  );
  return calls;
}

const LEVELS_OK = {
  code: 0,
  data: { levels: [{ name: '休闲场', baseScore: 15 }, { name: '标准场', baseScore: 80 }] },
};

function mountLobby(): VueWrapper {
  startGameSession(() => new FakeSocket());
  useAuthStore().navigate('lobby');
  return mount(LobbyPage, { global: { plugins: [pinia] } });
}

describe('④ 大厅取档位表：成功渲染卡，失败**一张卡都不渲染**（不猜底分）', () => {
  it('成功 ⇒ 每档一张卡，名字与底分都来自服务端', async () => {
    stubRoutes({ '/base-score-levels': LEVELS_OK });
    const wrapper = mountLobby();
    await flushPromises();

    const cards = wrapper.findAll('.lobby__level');
    expect(cards, '两档 ⇒ 两张卡').toHaveLength(2);
    expect(wrapper.findAll('.lobby__level-name').map((n) => n.text())).toEqual(['休闲场', '标准场']);
    expect(wrapper.find('.lobby__level-base').text(), '底分来自服务端（不是写死的）').toContain('15');
    expect(wrapper.find('.lobby__levels-error').exists(), '成功时不该有错误行').toBe(false);
  });

  it('🔴 信封非 0 ⇒ 报错文案 + **零张卡**（用户无从选 ⇒ 不会猜一个底分）', async () => {
    stubRoutes({ '/base-score-levels': { code: 10007, message: '下游不可用', data: null } });
    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.findAll('.lobby__level'), '拿不到档位表就不得渲染任何一档').toHaveLength(0);
    expect(wrapper.find('.lobby__levels-error').text()).toContain('档位表加载失败');
  });

  it('code 0 但空表 ⇒ 同样零张卡 + 如实报错', async () => {
    stubRoutes({ '/base-score-levels': { code: 0, data: { levels: [] } } });
    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.findAll('.lobby__level')).toHaveLength(0);
    expect(wrapper.find('.lobby__levels-error').text()).toContain('档位表');
  });

  it('🔴 fetch 被拒（H5 上会抛出）⇒ 如实报错、零张卡、不炸出 unhandled rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.findAll('.lobby__level')).toHaveLength(0);
    expect(wrapper.find('.lobby__levels-error').text()).toContain('档位表加载失败');
  });

  it('🔴 10004（BACK_TO_LOBBY）⇒ 走 dispatchRestFailure：清本地会话回登录页（R34/R36）', async () => {
    /**
     * 前置：**先真的登录过**（否则「回登录页」这条断言在「本来就在登录页」上恒真）。
     *
     * ⚠️ **`/auth/refresh` 必须显式 stub 成也失败**（复核订正）：本用例存了 `refreshToken: 'r1'`
     * ⇒ `rest.rotateOnce()` 的 `if (!stored?.refreshToken) return false` **不会**早退，
     * 它会**真的发一次** `POST /auth/refresh`。若不 stub，这次请求会落到 `stubRoutes` 的
     * fallback `{ code: 0, data: [] }` ⇒ `!res.data?.accessToken` ⇒ 轮换仍然失败
     * ⇒ 断言**照样绿，但绿的理由与注释写的不是一回事**（那是「引用未核」的隐身版）。
     * ⇒ 把「轮换也失败」**明写出来**，让这条用例断言的机制与它声称的一致。
     */
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1' });
    const auth = useAuthStore();
    expect(auth.hydrate(), '前置：必须真的拿到会话').toBe(true);
    expect(auth.loggedIn).toBe(true);
    stubRoutes({
      '/base-score-levels': { code: 10004, message: '令牌已过期', data: null },
      '/auth/refresh': { code: 10004, message: 'refresh 令牌也已失效', data: null },
    });

    const wrapper = mountLobby();
    await flushPromises();

    expect(auth.loggedIn, '10004 轮换不成就按 CLIENT_ACTION 表处置').toBe(false);
    expect(auth.page, '必须回登录页（旧的档位表失败路径会停在原地显示「加载失败」）').toBe('login');
    expect(wrapper.findAll('.lobby__level')).toHaveLength(0);
  });
});

describe('⑤ 点底分卡 = 写选中底分 + 进开始游戏页（片规格 §3 裁决一）', () => {
  it('写 store 并跳页；顺序不可反（页面挂载时就要读得到）', async () => {
    stubRoutes({ '/base-score-levels': LEVELS_OK });
    const wrapper = mountLobby();
    await flushPromises();

    const store = useGameStore();
    expect(store.selectedBaseScore, '点之前没有选中值').toBeNull();

    const setSelected = vi.spyOn(store, 'setSelectedBaseScore');
    await wrapper.findAll('.lobby__level')[1]!.trigger('click'); // 第二张 = 标准场 80

    expect(setSelected, '必须真的调了 setSelectedBaseScore（不是靠缺省值）').toHaveBeenCalledWith(80);
    expect(store.selectedBaseScore).toBe(80);
    expect(store.selectedLevelName, '场次名跟着选中值走').toBe('标准场');
    expect(useAuthStore().page, '点底分卡才进开始游戏页').toBe('game');
  });
});

describe('⑥ 顶栏资料：取到就显示，取不到如实提示但**不阻塞**大厅', () => {
  it('取到 ⇒ 昵称进信息条', async () => {
    stubRoutes({
      '/base-score-levels': LEVELS_OK,
      '/users/me': { code: 0, data: { id: 'u1', phone: '13800000000', nickname: '阿豆' } },
    });
    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.find('.lobby__player .chip__name').text()).toBe('阿豆');
    expect(wrapper.find('.lobby__profile-error').exists()).toBe(false);
  });

  it('取不到 ⇒ 一行提示（不静默）+ 回落到 userId + **不影响档位区**', async () => {
    stubRoutes({
      '/base-score-levels': LEVELS_OK,
      '/users/me': { code: 10007, message: '下游不可用', data: null },
    });
    const wrapper = mountLobby();
    await flushPromises();

    expect(wrapper.find('.lobby__profile-error').exists(), '失败不得静默').toBe(true);
    expect(wrapper.find('.lobby__player .chip__name').text(), '回落到 userId').toBe(clientConfig.devUserId);
    expect(wrapper.findAll('.lobby__level'), '资料失败**不得**影响档位区').toHaveLength(2);
  });
});
```

> ⚠️ `mountLobby()` 里 `useAuthStore()` 必须在**挂载之前**调用（`usePageAlignment('lobby')` 会读 `auth.page`；
> 生产里由 `hydrate()` / `login.vue` 写成 `'lobby'`）。
> ⚠️ **不要**在 `mountLobby()` 里 `createPinia()` —— 页面经 `global.plugins` 拿到的必须是
> `beforeEach` 那个实例，否则用例里的 `useGameStore()` 与页面里的不是同一个 store，断言会**静默**失配。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/base-score-selection.test.ts test/lobby-modes.test.ts`

Expected: **FAIL** —— `.lobby__level` 一个都找不到；`点玩法卡不得跳页` 红（现在仍会跳页）。

- [ ] **Step 3: 重写大厅页**

整体替换 `apps/client/src/pages/lobby/lobby.vue`：

```vue
<script setup lang="ts">
/**
 * 大厅（片② 客户端 · 片规格 §3）：**顶栏 + 左玩法竖滚 + 右底分横滚**。
 *
 * 🔴 **本页只有两件事会离开大厅**：
 *   ① 点**底分卡** ⇒ 写选中底分 + `navigate('game')`（`enterLevel`）；
 *   ② 点「退出」⇒ 登出（`onSignOut`）。
 *   而**点玩法卡只切换选中**（`selectMode`），**不跳页** —— 这是片规格 §3 裁决一。
 *
 * ⚠️ **这是行为变更**：片③ 起 `.lobby__mode` 的语义是「进入」（`enterMode` 直接跳页），
 * 现在改成「选中」。class 名一个不改（探针与用例的锚点），但**判据与探针都跟着改了**
 * —— 见计划的「判据改动记账」表。
 *
 * ⚠️ **开局区仍然不在本页**（片③ R749）：匹配 / 建房 / 房号加入 / 房间列表都在开始游戏页
 * ⇒ 本页**没有** `room.match` / `room.join` / `loadRooms`，「匹配只有一处实现」那条纪律
 * （R454/R658）继续由开始游戏页守；本页也**不消费**「再来一局」的意向（R760）。
 *
 * 🔴 **前端是哑终端**（`docs/design.md` §12）：底分**只能**来自服务端下发的档位表
 * （`GET /api/base-score-levels`）—— 本页**没有任何底分字面量**（M09）。
 * 拿不到档位表就**一张卡都不渲染**（用户无从选），绝不猜一个值。
 *
 * ⚠️ **两个共用件**：`SessionNotice.vue`（R751，会话提示）与 `PlayerChip.vue`（本片新增，
 * 玩家信息条）。两页都要显示的东西**不写两遍**。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { useAuthStore } from '../../stores/auth';
import { useGameStore } from '../../stores/game';
import { usePageAlignment } from '../../composables/usePageAlignment';
import { stopGameSession } from '../../composables/useGameSession';
import * as rest from '../../net/rest';
import { dispatchRestFailure } from '../../net/errors';
import { loadAudioPrefs, playBgm, stopBgm } from '../../audio';
import { CUES } from '../../audio/cues';
/** 片①：横屏画布（R710）。 */
import LandscapeStage from '../../components/LandscapeStage.vue';
/** 会话提示共用件（片③ R751）：两页都要有，而渲染只写一份。 */
import SessionNotice from '../../components/SessionNotice.vue';
/** 玩家信息条共用件（本片新增）：大厅顶栏与开始游戏页左下是同一件事。 */
import PlayerChip from '../../components/PlayerChip.vue';
/** 玩法列表（片③ 单一真源）：大厅列出全部、开始游戏页查选中的那个 —— 两页读**同一个**数组。 */
import { GAME_MODES } from '../../gameModes';

const auth = useAuthStore();
/** 页面栈（Task 3）：挂载时对齐一次（`auth.page` 才是唯一真源）。 */
usePageAlignment('lobby');
const store = useGameStore();

/**
 * 错误行分**两条通道**，各管各的：
 *  · `levelsError` —— 档位表取不到：**阻塞**（右侧一张卡都没有 ⇒ 用户无从选）；
 *  · `profileError` —— 用户资料取不到：**不阻塞**（`PlayerChip` 有真兜底：显示 userId）。
 *
 * ⚠️ 不共用一个 ref：共用时两个 loader 会互相清掉对方的提示，而它们**不是**同一件事
 * （一个挡住主路径、一个只是名字退化了）。
 */
const levelsError = ref('');
const profileError = ref('');

/**
 * 点玩法卡 = **只切换选中**（片规格 §3 裁决一）。**不跳页**。
 *
 * ⚠️ 片③ 的 R652 已作废（它的理由是测试脆弱性、不是产品决定）；
 * 本片又把它往回推了一步：**选中与进入是两件事**，前者归玩法卡、后者归底分卡。
 */
function selectMode(id: string) {
  store.setActiveMode(id);
}

/**
 * 点底分卡 = 写选中底分 + 进开始游戏页。
 *
 * ⚠️ **顺序不可反**：`navigate` 会同步 `uni.reLaunch`，开始游戏页挂载时就要能读到
 * 选中值（与 `requestRematch()` / `setActiveMode` 同一纪律）。
 */
function enterLevel(baseScore: number) {
  store.setSelectedBaseScore(baseScore);
  auth.navigate('game');
}

/**
 * 取底分档位表（片规格 §2.3 的接口；**每次挂载取一次**，服务端侧不缓存）。
 *
 * R34：非 0 的码一律经 `dispatchRestFailure` 查 `CLIENT_ACTION` 表后执行 ——
 * `BACK_TO_LOBBY`（`10002`/`10005`/`10004`）**先销毁本地 WS 会话**（R36）再清本地会话
 * 回登录页；`TOAST` 提示；`REFRESH_SNAPSHOT`/`RECONNECT` 在 REST 语境下退化为「重放一次」。
 * `replayed` 保证重放**最多一次**，不循环。
 *
 * ⚠️ **失败一律写空表**：空数组的含义是「没取到」，页面据此不渲染任何卡 ——
 * 这是「**不猜一个底分**」（M09）在用户能看见的那一步上的形态。
 */
async function loadLevels(replayed = false) {
  try {
    const res = await rest.baseScoreLevels();
    if (res.code === 0) {
      const levels = res.data?.levels ?? [];
      store.setBaseScoreLevels(levels);
      levelsError.value = levels.length > 0 ? '' : '底分档位表加载失败：服务端返回了空表';
      return;
    }
    store.setBaseScoreLevels([]);
    await dispatchRestFailure(res, {
      toast: (report) => {
        levelsError.value = `底分档位表加载失败：${report.message ?? `code=${report.code}`}`;
      },
      // R34/R36：BACK_TO_LOBBY → 先销毁本地 WS 会话，再清本地认证状态回登录页。
      // 令牌已不可用，**不**调服务端登出（它也会返回同样的码）。
      signOutLocally: () => {
        stopGameSession();
        auth.clearLocalSession();
      },
      replay: () => (replayed ? Promise.resolve() : loadLevels(true)),
    });
  } catch (e) {
    /**
     * ⚠️ **H5 上 `fetch` 的拒绝会抛出**（`src/net/rest.ts:76-78` 记着这条传播行为）⇒
     * 少了这一支，网络故障（离线 / DNS / 连接被拒）会在挂载那一刻静默收场，只剩一个
     * unhandled rejection（单测里表现为**整包退出码 1**，见 `login-layout.test.ts` 的头注释）。
     */
    store.setBaseScoreLevels([]);
    levelsError.value = `底分档位表加载失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 取用户资料（**只为了显示昵称**）。
 *
 * ⚠️ **不阻塞大厅**：失败的后果只是名字退化成 `userId`（`auth.displayName` 的真兜底），
 * 所以这里**不**清空档位区、也不改 `auth.page`。但仍**必须**把它显示出来 ——
 * 「失败就如实报错，不静默吞掉」是本仓的既有纪律（R651 同族）。
 */
async function loadProfile() {
  try {
    const ok = await auth.loadProfile();
    profileError.value = ok ? '' : '昵称加载失败：服务端未返回用户资料';
  } catch (e) {
    profileError.value = `昵称加载失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * §5.1 登出：服务端吊销令牌 + 清本地会话。
 *
 * ⚠️ 这里**不**再自己调 `stopGameSession()`：`auth.signOut()` → `clearLocalSession()`
 * 已经通过 R36 的绑定钩子销毁了本地 WS 会话。会话销毁只有一个真相点。
 */
async function onSignOut() {
  await auth.signOut();
}

onMounted(() => {
  void loadLevels();
  void loadProfile();
});

/**
 * 大厅 BGM（U4）。
 *
 * ⚠️ 每个页面只管**自己**那一首、自己卸载时停掉 —— 切曲**不跨页面做**
 * （页面栈的唯一真源是 `auth.page`，音频跟着挂载/卸载走）。
 * `playBgm` 自身会先停掉当前曲 ⇒ 大厅 → 牌桌的切换不会叠放两首。
 */
loadAudioPrefs();
playBgm(CUES.BgmLobby);
onUnmounted(() => stopBgm());
</script>

<template>
  <LandscapeStage>
    <view class="lobby">
      <!--
        标签映射（派工单 A）：`section/header/div/ul/li → view`、`span/p/h1/h2 → text`；
        `button`/`input` 保持 uni-app core 组件。class 名一个不改（探针与测试的锚点）。
        ⚠️ 本注释**必须**在根元素**内部**（R685）：写在根元素之前会让页面变成 fragment root，
        `classes()` 静默返回 `[]`。
      -->
      <!-- 顶栏（片规格 §3）：左 = 头像 + 昵称 + 货币占位（D12）；右 = **只放退出**。
           ⚠️ 不设置齿轮等占位按钮 —— 本仓明文忌讳「点了没反应的活按钮」（规格 §6.2 订正）。 -->
      <view class="lobby__bar">
        <PlayerChip class="lobby__player" :name="auth.displayName" />
        <button type="button" class="btn btn--small lobby__exit" @click="onSignOut">退出</button>
      </view>

      <text v-if="profileError" class="lobby__profile-error">{{ profileError }}</text>

      <!-- N30①/R455：连接状态条（**共用件** · R751）。页面只读 notice，不自己判断连接状态。 -->
      <SessionNotice class="lobby__notice" />

      <view class="lobby__body">
        <!--
          左：玩法列表（规格 §3）。现在只有斗地主一个条目，但结构上是**列表容器**（`v-for`）
          —— 加第二个玩法时只加数据、不改结构。
          🔴 **点卡 = 只切换选中**（不再跳页）：进开始游戏页靠右栏的底分卡。
          ⚠️ 玩法卡只显示名称与一句话说明：后端 `RoomInfo` 里**没有**的字段一律不造。
        -->
        <view class="lobby__modes">
          <text class="lobby__modes-title">选择玩法</text>
          <view class="lobby__mode-list">
            <button
              v-for="m in GAME_MODES"
              :key="m.id"
              type="button"
              class="lobby__mode"
              :class="{ 'lobby__mode--active': m.id === store.activeMode }"
              @click="selectMode(m.id)"
            >
              <!-- 图标位（R747）：给了文件名就渲染图，没给就走下面的 CSS 兜底 -->
              <image v-if="m.icon" class="lobby__mode-icon" :src="`/static/ui/${m.icon}`" mode="aspectFit" />
              <view v-else class="lobby__mode-icon lobby__mode-icon--fallback">
                <text class="lobby__mode-icon-char">{{ m.name.slice(0, 1) }}</text>
              </view>
              <view class="lobby__mode-text">
                <text class="lobby__mode-name">{{ m.name }}</text>
                <text class="lobby__mode-tagline">{{ m.tagline }}</text>
              </view>
            </button>
          </view>
        </view>

        <!--
          右：底分档位横滚（规格 §3）。数据全部来自服务端（协议①）。
          🔴 点卡 = **进开始游戏页**（裁决一）。拿不到档位表 ⇒ 一张卡都不渲染（不猜底分）。
        -->
        <view class="lobby__levels">
          <text class="lobby__levels-title">选择底分</text>
          <!--
            ⚠️ **三段互斥**（`v-if` / `v-else-if` / `v-else`），不是「把加载中文案塞进 error 行」：
            一个叫 `error` 的元素装非错误内容，下一个人读代码时无从判断它到底是不是错误。
          -->
          <view v-if="store.baseScoreLevels.length > 0" class="lobby__level-list">
            <button
              v-for="lv in store.baseScoreLevels"
              :key="lv.baseScore"
              type="button"
              class="lobby__level"
              :class="{ 'lobby__level--active': lv.baseScore === store.selectedBaseScore }"
              @click="enterLevel(lv.baseScore)"
            >
              <text class="lobby__level-name">{{ lv.name }}</text>
              <text class="lobby__level-base">底分 {{ lv.baseScore }}</text>
            </button>
          </view>
          <text v-else-if="levelsError" class="lobby__levels-error">{{ levelsError }}</text>
          <text v-else class="lobby__levels-empty">底分档位加载中…</text>
        </view>
      </view>
    </view>
  </LandscapeStage>
</template>

<style scoped lang="scss">
/**
 * 片② 客户端：**顶栏 + 左右两栏**（规格 §3 的形态）。
 *
 * ⚠️ **用 flex 列而不是 grid 行**：`.lobby__profile-error` 与 `SessionNotice` 都是**条件渲染**
 * （失败时才有 / 有提示时才有）⇒ 若写成 `grid-template-rows: auto auto auto 1fr`，
 * 「两个条件元素都不在」时 `.lobby__body` 会落到**第 2 条轨道（`auto`）**而不是
 * 最后那条 `1fr` —— 两栏不再撑满高度（隐式行放置按**实际存在**的子项算）。
 * flex 的 `flex: 1 1 auto` 不依赖声明了几条轨道，条件渲染增减子项都不受影响。
 * ⚠️ 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（**只引用，不改定义** ——
 *    令牌是全局的，改一个值会同时改掉四个页面）。
 * ⚠️ 视觉语言**照抄总规格 §5.2.1**（半透明深蓝面板 / 金主按钮 / 分段·选中控件…）。
 *    **别各自发挥。**
 */
.lobby {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-6;
  width: 100%;
  height: 100%;
  padding: $ftl-space-6;
}
/** 顶栏（片规格 §3）：左信息条、右退出。 */
.lobby__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-6;
  min-height: $ftl-bar-h;
}
/**
 * 退出按钮：**次按钮语言**（§5.2.1 —— 透明底 + `$ftl-hairline` 实线 `$ftl-color-night-soft` + 白字）。
 * ⚠️ `margin: 0` 不是装饰：`uni-button` 基样式带 `margin-left/right: auto`
 * （`login.vue` / `game.vue` 都记过这个坑），在**有富余宽度**的 flex 行里会把按钮顶到中间。
 * ⚠️ `background-image: none` 必须写：`ftl-btn` mixin 带白色贴图，留着会在深底上糊成一块白板。
 */
.lobby__exit {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
/** 深色底上的错误文字（§5.2.1 的专用令牌 —— **不**借用 `$ftl-color-danger-bg`）。 */
.lobby__levels-error,
.lobby__profile-error {
  color: $ftl-color-danger-on-dark;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 「加载中」是**中性**信息，不是错误 ⇒ 用面板内标签字（§5.2.1），与错误行分开两条规则。 */
.lobby__levels-empty {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 两栏：左玩法（固定宽，够放下图标 + 名称 + 一句话说明）、右底分（横滚）。 */
.lobby__body {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: 420px 1fr;
  gap: $ftl-space-6;
  min-height: 0;
}
/**
 * 两栏各自的**半透明深蓝面板**（§5.2.1 的第一条定格值）。
 * ⚠️ 画布底纹是一张风景插画，文字直接浮在上面读不清 —— 面板首先是**为可读性**。
 */
.lobby__modes,
.lobby__levels {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  min-height: 0;
  padding: $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
.lobby__modes-title,
.lobby__levels-title {
  flex: 0 0 auto;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1.2;
}
/** 玩法列表：**竖滚**（规格 §3）。 */
.lobby__mode-list {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  min-height: 0;
  overflow-y: auto;
}
/** 底分档位：**横滚**（规格 §3）。 */
.lobby__level-list {
  display: flex;
  gap: $ftl-space-4;
  min-height: 0;
  overflow-x: auto;
}
/**
 * 两种卡共用的**未选中**语言（§5.2.1 的「分段/选中控件」）：
 * 透明底 + `$ftl-hairline` 实线 `$ftl-color-night-soft` + 字 `rgba($ftl-color-on-primary, .75)`。
 *
 * ⚠️ 它们**是卡不是按钮控件** ⇒ 不 `@include ftl-btn`、不挂 `class="btn"`（那会触发
 * 「渲染 class="btn" 的组件必须自带 mixin」那条闸）。`<button>` 自带的宿主默认样式逐项重置回
 * 卡片所需：默认的 `margin-left/right: auto` 会把 flex 子项从拉伸变成内容宽居中，
 * `text-align: center` / `color: #000` / 不继承字体则会改掉卡内文字的排版。
 */
.lobby__mode,
.lobby__level {
  box-sizing: border-box;
  display: flex;
  margin: 0;
  padding: $ftl-space-5 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.75);
  font: inherit;
  cursor: pointer;
}
.lobby__mode {
  align-items: center;
  justify-content: flex-start;
  gap: $ftl-space-5;
  text-align: left;
}
/** 底分卡：竖排（场次名在上、底分在下），与参考图 1 的卡片同形。 */
.lobby__level {
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: $ftl-space-3;
  min-width: 240px;
}
/** **选中**语言（§5.2.1）：描边金 + 底 `rgba(gold,.18)` + 字 `$ftl-color-gold-light` + 700。 */
.lobby__mode--active,
.lobby__level--active {
  border-color: $ftl-color-gold;
  background: rgba($ftl-color-gold, 0.18);
  color: $ftl-color-gold-light;
  font-weight: 700;
}
/** 图标位（R747）：有素材时是 `<image>`，缺素材时走 CSS 兜底（令牌底 + 玩法名首字，不白屏）。 */
.lobby__mode-icon {
  flex: 0 0 auto;
  width: $ftl-control-h-sm;
  height: $ftl-control-h-sm;
}
.lobby__mode-icon--fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: $ftl-radius-md;
  background: $ftl-color-primary;
}
.lobby__mode-icon-char {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 600;
}
.lobby__mode-text {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
}
.lobby__mode-name,
.lobby__level-name {
  color: inherit;
  font-size: $ftl-font-lg;
  font-weight: inherit;
  line-height: 1.2;
  white-space: nowrap;
}
/** 一句话说明：改浅色（面板内标签字，§5.2.1）—— 原来的 `$ftl-color-text-secondary`
    是深底上的灰字，压在深蓝面板上读不清。 */
.lobby__mode-tagline {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 「底分 N」：与场次名同一族，弱一档（面板内标签字）。 */
.lobby__level-base {
  color: inherit;
  font-size: $ftl-font-md;
  line-height: 1.2;
  white-space: nowrap;
}
/**
 * 会话提示的**宿主样式**（R751：渲染在共用件里，布局/配色归宿主）。
 *
 * ⚠️ 级别 class 是组件发的 `notice--{level}`（**不带宿主前缀**）⇒
 * 级别配色必须同时选中两者（`.lobby__notice.notice--error`）。
 * ⚠️ `.lobby__notice` 这个 class 本身有断言锚着（`lobby-ux` 的连接提示用例）⇒ 一个字不改。
 */
.lobby__notice {
  display: block;
  box-sizing: border-box;
  padding: $ftl-space-3 $ftl-space-7;
  border-radius: $ftl-radius-md;
  background: $ftl-color-info-bg;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
.lobby__notice.notice--warn {
  background: $ftl-color-warn-bg;
}
.lobby__notice.notice--error {
  background: $ftl-color-danger-bg;
  color: $ftl-color-danger;
}
.lobby__notice.notice--info {
  background: $ftl-color-success-bg;
}
.btn {
  @include ftl-btn;
}
.btn--small {
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  font-size: $ftl-font-sm;
}
/* 本页已没有可被禁用的 `.btn` —— 禁用态规则跟着被禁用的按钮留在开始游戏页（评审修复轮 1 的既有结论）。 */
</style>
```

> 🔴 **执行期复核订正（2026-09-27，控制者文本缺陷 C-24/C-25）**：
> 1. **C-25（真矛盾，会被实施者撞上）**：本步骤初稿的实现文案写「**底分档位**加载失败：…」，
>    而 Step 1c 的三条断言 pin 的是 `toContain('档位表加载失败')` / `toContain('档位表')`
>    —— 初稿文案**两个子串都不含**（「档位」与「表」不相邻）⇒ **三条断言恒红**。
>    实施者按 TDD（判据即规格）把实现改成「**底分档位表**加载失败：…」，三条全过。
>    **上面三处文案已按实际落地的写法订正**（而不是改断言 —— 那三条 pin 的措辞
>    与仓库既有真源一致，是判据侧的正解）。
> 2. **C-24**：本步骤的注释说「追加**两个** `describe`」，实际是**三个**（④⑤⑥）。以代码为准。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/base-score-selection.test.ts test/lobby-modes.test.ts test/player-chip.test.ts`

Expected: **PASS**。

- [ ] **Step 5: 跑与大厅有关的所有既有判据**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/lobby-ux.test.ts test/page-stack.test.ts test/table-hud.test.ts test/ui-tokens.test.ts`

Expected: **PASS**。

> ⚠️ `table-hud.test.ts` **裸挂载** `LobbyPage` 且**没有 stub `fetch`** ⇒ 真实 `fetch('/api/…')` 在 jsdom 里会拒绝。本步的 `loadLevels` / `loadProfile` **都带 catch**，所以只是「报错行渲染出来了」，**不会**产生 unhandled rejection 把整包打红。若这一条红了，先查是不是漏了 catch —— **不要**去给那个用例加 stub（那是把测试改成迎合实现）。

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/pages/lobby/lobby.vue apps/client/test/lobby-modes.test.ts apps/client/test/base-score-selection.test.ts
git commit -m "feat(client): 大厅重做 —— 点玩法=选中、点底分=进入开始游戏页

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 开始游戏页重做（中央「开始游戏」+「好友房」弹层 + 左下信息条）

**Files:**
- Modify: `apps/client/src/pages/game/game.vue`
- Modify: `apps/client/test/lobby-ux.test.ts`
- Modify: `apps/client/test/auth-ui-wiring.test.ts`

**Interfaces:**
- Consumes: `useGameStore().selectedBaseScore` / `.selectedLevelName` / `.matching`（Task 1）· `PlayerChip`（Task 3）· `useAuthStore().displayName`（Task 2）
- Produces: DOM 锚点 `.game__scene` / `.game__scene-name` / `.game__scene-base` · `.game__friends-open`（文本**逐字**「好友房」）· `.game__friends` / `.game__friends-panel` / `.game__friends-head` / `.game__friends-title` / `.game__friends-close` · `.game__player` · `.game__hint`（`.game__match` 的按钮文案改为「开始游戏」；`.game__create-room` / `.game__join` / `.game__rooms*` / `.game__item` / `.game__empty` / `.game__error` **移进弹层**）

- [ ] **Step 1: 写失败的测试**

**1a.** 在 `apps/client/test/lobby-ux.test.ts` 的 `mountGame` 助手**下方**加一个打开弹层的助手：

```ts
/**
 * 打开「好友房」弹层（片规格 §4 裁决二：建房 / 房号加入 / 房间列表**整体**收进弹层）。
 *
 * ⚠️ 这三条入口的既有用例**判据一条没少**，只是动手前多一步「用户真的点开了它」——
 * 而这正是弹层形态的语义：**关着的时候它们不在 DOM 里**。
 */
async function openFriends(wrapper: ReturnType<typeof mount>) {
  const open = wrapper.findAll('button').find((b) => flat(b.text()) === '好友房');
  expect(open, '开始游戏页必须有「好友房」入口').toBeDefined();
  await open!.trigger('click');
  await flushPromises();
}
```

> ⚠️ 参数类型用 `ReturnType<typeof mount>` 而**不是** `VueWrapper<any>`：`auth-ui-wiring.test.ts`
> 的 `@vue/test-utils` import 里**没有** `VueWrapper`（只导了 `flushPromises` / `mount`），
> 照抄时补一个 import 是没必要的改动。

并在 `describe('N30③ / R454：玩法页建房入口与房间列表可点（复用唯一的 room.join）')` 里的**每条**用例的 `mountGame(...)` + `await flushPromises()` 之后插入 `await openFriends(wrapper);`：

- 「点「创建房间」→ POST /api/rooms，然后用**同一条** room.join 进房（R61）」
- 「创建失败（非 0）→ 只提示，**不发** room.join、不进牌桌」
- 「点房间列表项 → 走同一条 room.join（房号取自该项）」
- 「两种入口共用同一个房号归一化（列表项同样大写、去空白）」

🔴 **同一个文件里还有第二组也必须改**（复核才发现 —— 它走的是**另一份** `clickCreate`，不在上面这张清单里）：

`describe('手动进房：REST 入座必须先于 WS room.join（F6 / R802 / R808）')` 的**两条**（`:311` 起）。
它们用 `lobby-ux.test.ts:385-388` 的那个助手：

```ts
  const clickCreate = async (wrapper: VueWrapper<any>) => {
    const create = wrapper.findAll('button').find((b) => flat(b.text()) === '创建房间');
    expect(create, '玩法页必须有「创建房间」按钮').toBeDefined();   // ← 弹层关着时这里直接红
    await create!.trigger('click');
    await flushPromises();
  };
```

⇒ 在该助手的**第一行之前**插入 `await openFriends(wrapper);`：

```ts
  const clickCreate = async (wrapper: VueWrapper<any>) => {
    // ⚠️ 建房按钮在「好友房」弹层里（片规格 §4 裁决二）⇒ 弹层关着时它**不在 DOM 里**。
    await openFriends(wrapper);
    const create = wrapper.findAll('button').find((b) => flat(b.text()) === '创建房间');
    expect(create, '玩法页必须有「创建房间」按钮').toBeDefined();
    await create!.trigger('click');
    await flushPromises();
  };
```

⚠️ **为什么这一条特别容易漏**：`openFriends` 定义在**同一个文件**里、上面那组用了它，于是「这组也要用」看起来像重复劳动 ——
但 Task 5 Step 4 期望 `lobby-ux.test.ts` **整文件 PASS**，漏掉它这两条会以「找不到创建房间按钮」红。

并在同 `describe` 里**追加一条**（这是「收进弹层」这件事的**唯一**可证伪判据）：

```ts
  it('🔴 弹层关着时，建房/房号/列表三个入口**都不在 DOM 里**（否则「收进弹层」无法证伪）', async () => {
    const { wrapper } = mountGame();
    await flushPromises();

    expect(wrapper.find('.game__create-room').exists(), '关着时不得渲染建房按钮').toBe(false);
    expect(wrapper.find('.game__join input').exists(), '关着时不得渲染房号输入框').toBe(false);
    expect(wrapper.find('.game__rooms').exists(), '关着时不得渲染房间列表').toBe(false);

    await openFriends(wrapper);

    expect(wrapper.find('.game__create-room').exists(), '开了就得都在').toBe(true);
    expect(wrapper.find('.game__join input').exists()).toBe(true);
    expect(wrapper.find('.game__rooms').exists()).toBe(true);
  });
```

**1b.** 在 `apps/client/test/auth-ui-wiring.test.ts` 里：

① 在 `describe('房间列表（§3.1 / R22）与大厅登出')` 的文件级加一个同样的 `openFriends` 助手（照抄 1a 的实现），并在**读弹层内 DOM** 的用例的 `await flushPromises()` 之后插入 `await openFriends(wrapper);` —— ⚠️ **是 5 条不是 4 条**（复核订正 C-26）：信封解析 / 裸数组 / 10001 / 13004 **＋「玩法页的匹配按钮」那组里的「手动「加入」也消费 ack 的 players 并校正座位」**（它也读 `.game__join input`，而**不在**上面那个 `describe` 里 ⇒ 按 describe 找会漏掉它）。
⚠️ **两条豁免，别乱加**：
- 「退出」那条挂 `LobbyPage`，**不动**；
- **10002 / 10005 那两条不读 DOM**（只断言 `auth.*` / `clientConfig` / `localStorage` / `sockets[0].disconnected` / `fetchMock.mock.calls`），而且它们的挂载是**不接收返回值**的写法 —— `auth-ui-wiring.test.ts:176` 逐字是 `mount(GamePage, { global: { plugins: [pinia] } });`，**该用例体内没有 `wrapper` 这个变量** ⇒ 照抄「插入 `await openFriends(wrapper)`」会写出 `Cannot find name 'wrapper'`（TS2304 ⇒ 门禁第 2 阶段红）。
  它们**本来也不需要开弹层**（`fetchMock.mock.calls` 是 1 条 —— 弹层开合不发请求），**保持原样**。
- 「F7：空态文案走 finished-text」那条是**源码级**（不挂载），也**不动**。

② **删除** `describe('玩法页的匹配按钮（§6.3 / R51）')` 里的 `LEVELS_BODY`，把 `stubLevelsFetch` 换成只顶掉房间列表的替身（开始游戏页**只剩这一条** REST 了），并把 `mountGameWithSocket` 改成**先预置选中的底分**：

```ts
  /**
   * ⚠️ 片② 客户端起，开始游戏页**不再自己取档位表**（那是大厅的事，片规格 §3）——
   * 本页唯一会发的 REST 就是 `GET /api/rooms`（房间列表）。原 `stubLevelsFetch`
   * 因此改名并简化（它此前还要按 URL 给档位表分流）。
   */
  function stubRoomsFetch() {
    return stubFetch({ code: 0, data: [] });
  }

  /**
   * `room.match` 的 `baseScore` 现在来自**用户选中的那一档**（`store.selectedBaseScore`）
   * ⇒ 本助手把它预置成 **80**（**不是**第一档 15）：这样「用的是**选中的**那个值」
   * 才有判别力 —— 「取档位表第一档」的实现会在 `baseScore: 80` 上当场红。
   */
  function mountGameWithSocket() {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    useGameStore().setSelectedBaseScore(80);
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    return { wrapper, socket: sockets[0]! };
  }
```

把该 `describe` 里**剩下的 5 条用例**开头的 `stubLevelsFetch();` 逐字改成 `stubRoomsFetch();`，并做下面这些**逐字**改动（其余部分一个字符不动）：

| 用例 | 改法 |
|---|---|
| 「点「随机匹配」发 room.match；ack 0 → 切换到「正在匹配…/取消匹配」」 | 标题与断言里的「随机匹配」→「**开始游戏**」；**把 `baseScore: 15` 改成 `baseScore: 80`**，并把旁边那句注释改成「协议②：`baseScore` 必须是**用户选中的那一档**（M09：前端不得写死规则常量）」 |
| 「ack 12009（已在队列中）是**幂等成功**」 | 只改 `stubLevelsFetch();` → `stubRoomsFetch();` |
| 「取消匹配发 room.unmatch；ack 0 → 回到「随机匹配」」 | 标题与最后那条断言里的「随机匹配」→「**开始游戏**」 |
| 「12007 经 system.error 推送到达 → 按钮从「取消匹配」回到可再次点击的「随机匹配」」 | 同上改文案 |
| 「手动「加入」也消费 ack 的 players 并校正座位」 | 它自带 `stubFetch(...)`，把 `stubLevelsFetch()`（若有）去掉即可 |

> ⚠️ **`baseScore: 15` → `80` 不是「把断言改绿」**：15 是第一档，「取第一档」的旧实现符合它；
> 本片改成「用选中的那一档」之后，15 这个值**不再能区分**两种实现（预置的就是 15 的话，
> 取第一档的实现照样绿）。改成 80 之后判别力**变强**：只有真的读了 `store.selectedBaseScore`
> 才可能绿。

③ 该文件顶部 `stubFetch` 的 JSDoc 里有一句**逐字引用了 `stubLevelsFetch`**：

```ts
 * （协议② 之后 `match()` 会先读 `/base-score-levels` —— 见「玩法页的匹配按钮」组的
 * `stubLevelsFetch`；形态与 `lobby-ux.test.ts` 的同名助手一致）。
```

本步删掉了那个助手 ⇒ 这句**必须一起改**（否则文档指向一个不存在的符号，正是「引用了还不存在的判据」那类缺陷）：

```ts
 * （片② 客户端起，开始游戏页只剩 `GET /api/rooms` 一条 REST —— 档位表归**大厅**取；
 * 形态与 `lobby-ux.test.ts` 的 `stubFetch` 一致）。
```

**再加一条新判据**（「没选底分就不发匹配」—— 这是「不猜」在开始游戏页的那半边）：

```ts
  it('🔴 没选底分（selectedBaseScore 为 null）⇒ 按钮**真的禁用** + 一行说明 + **不发** room.match', async () => {
    stubRoomsFetch();
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    // 刻意**不**预置选中底分
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();

    /**
     * 🔴 **先断言 `disabled` 属性本身**，再谈「不发匹配」：
     * `trigger('click')` 走的是 `dispatchEvent` —— 它**绕过** `disabled`（只有用户驱动的
     * 激活才会被浏览器抑制）⇒ 若只断言「没发 room.match」，在「点击根本没生效」的世界里
     * 也是绿的（**恒真**）。属性那条与点击是否生效**无关**，判别力有保障。
     */
    expect(
      wrapper.find('.game__match button').attributes('disabled'),
      '未选底分时「开始游戏」必须禁用（不是点得动但发不出去）',
    ).toBeDefined();
    expect(wrapper.find('.game__hint').text(), '要说清为什么不能点（忌讳「点了没反应的活按钮」）').toContain(
      '选择底分',
    );

    // 第二半：即便处理函数真的跑了，也**不得**猜一个底分发出去
    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    expect(sockets[0]!.emittedOf('room.match'), '没选底分就不得猜一个发出去').toHaveLength(0);
  });
```

④ 把该 `describe` 里 **3 条档位表失败用例**整体**删除**（「档位表加载失败（非 0）」「档位表是空表（code 0 但 levels: []）」「🔴 档位表请求被拒（H5 上 fetch 抛出）」各一条 + 相关注释），因为**它们守的性质已经搬家** —— 等价且更强的判据在 `base-score-selection.test.ts` 的 ④ 组（Task 4 已写）。
⚠️ **是 3 条不是 4 条**（复核订正）：该 `describe` 共 8 条 `it`，减掉这 3 条正好剩 5 条 —— 与上一条表格里的「剩下的 5 条用例」自洽。写成 4 条会与计划自己的算术矛盾。
⚠️ **删的时候把理由写进文件头的注释**（见下一条），不要无声删除。

⑤ 把 `auth-ui-wiring.test.ts` 的文件头注释里加一段：

```ts
 * ⚠️ **片② 客户端（本片）的两处迁移**：
 *  ① **档位表失败用例搬走了**：`match()` 此前自己 fetch `GET /api/base-score-levels`，
 *     本片把这个 fetch 搬到了**大厅**（`lobby.vue`，片规格 §3）⇒ 三条「档位表加载失败 /
 *     空表 / fetch 被拒 ⇒ 不猜底分」的判据**跟着实现走**，现在在
 *     `base-score-selection.test.ts` 的 ④ 组。性质**不降反升**：那边断言的是
 *     「**一张档位卡都不渲染**」（用户无从选），而这里的旧断言「没发 room.match」
 *     在新结构里是恒真的（开始游戏页不再关心档位表）。
 *  ② **开局三入口移进「好友房」弹层**（片规格 §4 裁决二）⇒ 读 DOM 前先 `openFriends()`。
 *     判据本身一条没少，还多了一条「关着时三个入口都不在 DOM 里」。
```

⑥ 改 `apps/client/test/ui-flow.test.ts`（它默认 `describe.skipIf(!ENABLED)`，CI 里不跑 —— 但**放着不管就是烂掉**）。本步的三处改动：

- 文件头注释里「先在大厅点玩法卡进入」那段：改成「先在大厅点玩法卡（**只切换选中**）、再点底分卡进入」；
- 测试体里：

```ts
        expect(wrapper.find('.lobby__mode').exists(), '大厅必须有玩法卡（R762）').toBe(true);
        await wrapper.find('.lobby__mode').trigger('click');
        expect(auth.page, '点玩法卡**只切换选中**、不跳页（片规格 §3 裁决一）').toBe('lobby');

        /**
         * 底分卡的数据来自 REST（走查跑在**真后端**上 ⇒ 真 I/O，一个微任务等不到）
         * ⇒ **先有界地等它出现，再无条件点它**。
         *
         * 🔴 **不得写成 `if (wrapper.find('.lobby__level').exists()) { … } else { auth.navigate('game') }`**
         * （初稿就是这么写的，复核时判为**恒真**）：那种写法下「点底分卡」这一步
         * **一次都没点过**，而且照样绿 —— 换成「点底分卡什么也不做」的实现也绿。
         * 本用例的判别力**全在**「点了它、页面才变成 game」这一条上。
         * ⚠️ 用文件里既有的 `sleep`（`ui-flow.test.ts:38`）而不是 `vi.waitFor`：本文件没 import `vi`。
         */
        for (let i = 0; i < 40 && !wrapper.find('.lobby__level').exists(); i += 1) {
          await sleep(250);
          await wrapper.vm.$nextTick();
        }
        expect(wrapper.find('.lobby__level').exists(), '大厅必须渲染出底分卡（真后端下 REST 应当已回）').toBe(true);
        await wrapper.find('.lobby__level').trigger('click');
        expect(auth.page, '点底分卡才进开始游戏页（片规格 §3 裁决一）').toBe('game');
```

- 后面那句 `expect(wrapper.html()).toContain('随机匹配')` 逐字改成：

```ts
        expect(wrapper.html(), '主按钮文案按规格 §4 是「开始游戏」').toContain('开始游戏');
```

⑦ 🔴 **`lobby-ux.test.ts` 的 R658/R760 组（`:596-661`，两条）必须一起改** —— 复核时才发现的漏判：

> **为什么它非改不可**：那两条挂 `GamePage` + `store.requestRematch()`，断言「挂载后**恰好一条** `room.match`，
> payload `{ mode: 'random', baseScore: 15 }`」。而本片的 `match()` 在 `selectedBaseScore === null` 时
> **早退**（那正是「不猜」的落点）⇒ 两条都会以「**0 条** `room.match`」变红。
> ⚠️ 这是本片**第二次**踩「漏判爆炸半径」（第一次是探针 2 处 → 实际 4 处）——
> 记下来：**改任何东西之前先 grep「谁还依赖它」**。

改法（三条）：

```ts
  /**
   * ⚠️ 片② 客户端起：`match()` 用的是 **`store.selectedBaseScore`**（用户在大厅选的那一档），
   * 而本组直接挂页面（没有走大厅）⇒ 必须**先预置**它。
   *
   * 预置 **80** 挡的是**另一类**错误实现：`baseScore` 写死 15（M09 违例）或「从档位表数组取第一档」
   * —— 那两种在 `toEqual({ mode: 'random', baseScore: 80 })` 上当场红。
   * ⚠️ **但本组的 fixture 下「取第一档」的旧实现会先以「0 条」红**（下面的替身不喂档位表 ⇒
   * 旧实现拿不到 levels 就早退）⇒ 这条用例的**第一道**判别力是条数，不是 80 这个值。
   */
  function mountGameForRematch() {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    useGameStore().setSelectedBaseScore(80);
    stubRoomsFetch();
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    return { wrapper, socket: sockets[0]! };
  }

  /**
   * 本页唯一会发的 REST 是 `GET /api/rooms`（档位表归大厅取，见 `match()` 的头注释）。
   *
   * 🔴 **必须写成函数形态**：`lobby-ux.test.ts` 自己的 `stubFetch` 签名是
   * `(route: (call: FetchCall) => unknown, status = 200)` —— **只吃函数**，传对象会
   * TS2345 且该次 fetch 的 `text()` 抛错。（能收对象的是 `auth-ui-wiring.test.ts` 的
   * 同名助手，签名不同。同名不同签名是本仓既有事实，照抄时按**本文件**的来。）
   */
  function stubRoomsFetch() {
    return stubFetch(() => ({ code: 0, data: [] }));
  }
```

- 删掉 `stubRematchFetch`（连同它的 JSDoc —— 那段「第一档 15」的说明已随实现搬走）；
- 第一条用例里 `expect(matches[0]!.env.payload).toEqual({ mode: 'random', baseScore: 15 })` 的 **15 改 80**，注释同步改成「用**选中的**那一档」；
- 第二条（幂等）**不用改**（它只数条数）。

> ⚠️ **本组的判据一条没少**：仍是无意向 ⇒ 不发匹配、有意向 ⇒ 恰好一条、读后即清、第二次挂载幂等。
> 变的只有「那个值从哪来」——从「页面自己 fetch 第一档」变成「store 里选中的那一档」，
> 而那是**本片要改的那件事本身**。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/lobby-ux.test.ts test/auth-ui-wiring.test.ts`

Expected: **FAIL** —— 找不到「好友房」按钮 / `.game__create-room` 仍在 DOM 里（弹层还不存在）/ 匹配按钮文案仍是「随机匹配」/ `lobby-ux` 的 R658/R760 组以「0 条 `room.match`」红（`match()` 早退，见 ⑦）。

- [ ] **Step 3: 重写开始游戏页**

整体替换 `apps/client/src/pages/game/game.vue`：

```vue
<script setup lang="ts">
/**
 * 开始游戏页（片② 客户端 · 片规格 §4）：**选完底分进来的那一屏**。
 *
 * 形态：左上「返回大厅」· 左下玩家信息条 · 中央「场次名 + 底分 N」+「**开始游戏**」大按钮
 * （= 随机匹配，带上**选中的**底分，协议②）· 「**好友房**」二级入口。
 *
 * 🔴 **「好友房」是弹层、不是子页**（片规格 §4 裁决二）：页面栈的唯一真源是 `auth.page`，
 * 加一页要动 `pages.json` + `auth.page` 联合类型 + `page-stack` 判据 —— 而它本来就只是次要入口。
 *
 * ⚠️ **本页不再自己取档位表**（片② 客户端起）：档位表由**大厅**取一次写进 store，
 * 本页复用它查**场次名**（片规格 §3 的第二个接口）。`baseScore` 也不再取「第一档」——
 * 用的是**用户选中的那一档**（`store.selectedBaseScore`）。
 *
 * ⚠️ **锚点纪律**：`.game` 是页面根 class（`table-hud` 的单根闸 + `landscape-canvas` 的
 * 「每个页面都套 `<LandscapeStage>`」都按它判）· `.game__match .btn` 是探针锚点 ·
 * `.table__bar .btn` 那条同族。**「返回大厅」的文案逐字保留**（探针按文本匹配）。
 *
 * ⚠️ **跨页状态**：玩法 id 与选中底分都从 `game` store 读 —— **不得**在本页写死
 * 「斗地主」或任何底分字面量（R752 / M09 的判据）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ErrCode, type RoomInfo } from '@fight-the-landlord/protocol';
import { getGameSession, stopGameSession } from '../../composables/useGameSession';
import type { RoomPlayerLike } from '../../net/session';
import * as rest from '../../net/rest';
import { dispatchRestFailure } from '../../net/errors';
import { useAuthStore } from '../../stores/auth';
import { useGameStore } from '../../stores/game';
import { usePageAlignment } from '../../composables/usePageAlignment';
import { DEFAULT_MODE_ID, findMode } from '../../gameModes';
import { loadAudioPrefs, playBgm, stopBgm } from '../../audio';
import { CUES } from '../../audio/cues';
/** 片①：横屏画布（R710）。 */
import LandscapeStage from '../../components/LandscapeStage.vue';
/** 会话提示共用件（片③ R751）：两页都要有、但只写一份。 */
import SessionNotice from '../../components/SessionNotice.vue';
/** 玩家信息条共用件（本片新增）：与大厅顶栏是同一件事。 */
import PlayerChip from '../../components/PlayerChip.vue';

const auth = useAuthStore();
/** 页面栈（Task 3）：挂载时对齐一次（`auth.page` 才是唯一真源）。 */
usePageAlignment('game');
const store = useGameStore();

/**
 * 玩法名从 **store** 读（R752）—— 本页**不得**写死「斗地主」字面量。
 * 查不到就回落缺省（`DEFAULT_MODE_ID`）—— 那只会发生在「store 里的 id 与 GAME_MODES 不同步」
 * 这种异常上，回落比渲染空白好。
 */
const mode = computed(() => findMode(store.activeMode) ?? findMode(DEFAULT_MODE_ID)!);

/** 中央：场次名（**按选中的底分查档位表**；查不到就是 `null` —— 不编名字）。 */
const levelName = computed(() => store.selectedLevelName);
/** 中央：选中的底分。`null` = 用户还没在大厅选过。 */
const selectedBaseScore = computed(() => store.selectedBaseScore);

/** 好友房弹层是否展开（**不是**路由 —— 页面栈的唯一真源仍是 `auth.page`）。 */
const friendsOpen = ref(false);

const rooms = ref<RoomInfo[]>([]);
const joinCode = ref('');
/** R49：匹配中状态归 store —— 页面局部 ref 收不到 12007 的复位信号。 */
const matching = computed(() => store.matching);
const busy = ref(false);
const error = ref('');
/**
 * `RoomInfo['status']`（**服务端字段**）→ `wd-tag` 的**配色档位**。
 *
 * ⚠️ 这只是「枚举 → 颜色」的展示翻译，**不是**规则判断：准入/胜负/能否进房全部在服务端，
 * 前端不改写也不推理 `status`（哑终端）。
 */
const STATUS_TAG_TYPE: Record<RoomInfo['status'], 'primary' | 'success' | 'warning' | 'danger'> = {
  waiting: 'success',
  playing: 'primary',
  finished: 'warning',
  cancelled: 'danger',
};

/**
 * R22：只按统一信封读，`data` 就是 `RoomInfo[]`。
 *
 * R34：非 0 的码一律经 `dispatchRestFailure` 查 `CLIENT_ACTION` 表后执行——
 * `BACK_TO_LOBBY`（`10002`/`10005`）**先销毁本地 WS 会话**（R36）再清本地会话回登录页
 * （**不**再调服务端登出）；`TOAST` 提示；`REFRESH_SNAPSHOT`/`RECONNECT` 在 REST 语境下
 * 退化为「重放一次」。`replayed` 保证重放**最多一次**，不循环。
 */
async function loadRooms(replayed = false) {
  error.value = '';
  try {
    const res = await rest.rooms();
    if (res.code === 0) {
      rooms.value = res.data ?? [];
      return;
    }
    rooms.value = [];
    await dispatchRestFailure(res, {
      toast: (report) => {
        error.value = `房间列表加载失败：${report.message ?? `code=${report.code}`}`;
      },
      // R34/R36：BACK_TO_LOBBY（10002/10005）→ 先销毁本地 WS 会话，再清本地认证状态回登录页。
      // 令牌已不可用，**不**调服务端登出（它也会返回同样的码）。
      signOutLocally: () => {
        stopGameSession();
        auth.clearLocalSession();
      },
      replay: () => (replayed ? Promise.resolve() : loadRooms(true)),
    });
  } catch (e) {
    // 房间列表失败不该阻塞主路径（匹配按钮仍然可用）
    error.value = `房间列表加载失败：${e instanceof Error ? e.message : String(e)}`;
    rooms.value = [];
  }
}

/**
 * 随机匹配（协议②）：带上**大厅选中的底分**。
 *
 * ⚠️ **不得写死一个数字**（M09：前端不得含规则常量）—— 这里用的是 store 里那个
 * **服务端下发的**档位值，本页一个底分字面量都没有。
 * ⚠️ 没选过（`null`）就**不发**：如实报错，**不猜**（猜出来的值就是前端规则常量）。
 * 这在 UI 上是**双重**的：按钮本身禁用 + 一行 `.game__hint` 说明原因
 * （本仓明文忌讳「点了没反应的活按钮」）。
 */
async function match() {
  if (busy.value) return;
  const baseScore = store.selectedBaseScore;
  if (baseScore === null) {
    error.value = '请先在大厅选择底分';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const outcome = await getGameSession().client.send('room.match', { mode: 'random', baseScore });
    if (outcome.status === 'blocked') {
      error.value = '上一个操作还在进行中，请稍候';
      return;
    }
    // R51：12009 = 已在队列中，`CLIENT_ACTION` 表把它归为 IGNORE ⇒ 处置层什么也没做，
    // 页面必须自己把它当成**幂等成功**（用户点了两次，结果一样）。
    if (outcome.code === ErrCode.ALREADY_IN_QUEUE) {
      store.setMatching(true);
      return;
    }
    if (outcome.code !== 0) {
      error.value = `匹配失败（code=${outcome.code}）`;
      return;
    }
    store.setMatching(true);
  } catch (e) {
    error.value = `匹配失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
  }
}

async function unmatch() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const outcome = await getGameSession().client.send('room.unmatch', {});
    if (outcome.status === 'blocked') {
      error.value = '上一个操作还在进行中，请稍候';
      return;
    }
    if (outcome.code !== 0) {
      error.value = `取消失败（code=${outcome.code}）`;
      return;
    }
    store.setMatching(false);
  } finally {
    busy.value = false;
  }
}

/**
 * 进房：**同一条 `room.join` 的唯一实现**（R61/R454）。
 *
 * 三条入口全部走这里，**不得**复制第二份 `room.join` 逻辑：
 *   - 手动输入房号（`join()` 默认取输入框）
 *   - 点击房间列表项（`join(room.code)`）
 *   - 创建房间成功之后（`createAndJoin()` 把房号写进输入框再调用它）
 *
 * `code` 省略时取输入框；两处都做同样的归一化（去空白 + 大写）——房号由服务端生成，
 * 前端只做大写化，不做任何格式判断（哑终端）。
 *
 * ⚠️ **两步，顺序不可反**（spec §3.2 / R802）：
 *   ① **REST 占座**（`POST /api/rooms/:code/join`）：服务端 `claimSeat`，真服务端里
 *      **唯一**的占座方式（`rooms.service.ts:136`）；
 *   ② **WS 挂载**（`room.join`）：把已占的座位挂到本连接上，ack 才带 `seat`/`players`。
 *
 * 建房 REST **不入座**（`players: []`）⇒ 少了 ① 就是 F6：`room.join` 拿 `12004`
 * ⇒ `CLIENT_ACTION` 判 BACK_TO_LOBBY ⇒ 人被踢回大厅而房间还挂着。
 *
 * ⚠️ **不能反过来「先发 WS、遇 12004 再补 REST」**：`client.send()` 在 ack 回调里
 * **同步**派发 `CLIENT_ACTION`（`net/socket.ts` 的 `dispatchAck`）⇒ 12004 到手时
 * 用户**已经在去大厅的路上**了，没有补救的余地（spec §1.2 H1）。
 *
 * ⚠️ 归一化后的局部变量**叫 `code`**：`game-store-session-reset.test.ts` 的源码级断言
 * （R418：两条进房路径共用 `setRoom`）钉的就是 `store.setRoom(code,` 这个字面量。
 */
async function join(entered?: string) {
  const code = (entered ?? joinCode.value).trim().toUpperCase();
  if (!code || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    // ① REST 占座（spec §3.2 的 ①）：失败就**不**发 WS、**不**进牌桌（R807）
    const seated = await rest.joinRoom(code);
    if (seated.code !== 0) {
      error.value = `加入房间失败（code=${seated.code}）`;
      return;
    }
    // R804：以服务端回包的房号为准（输入框里那串只是候选）
    joinCode.value = (seated.data?.code ?? code).trim().toUpperCase();

    // ② WS 挂载（既有实现，逐字保留）
    const outcome = await getGameSession().client.send('room.join', { roomCode: code });
    if (outcome.status === 'blocked') {
      error.value = '上一个操作还在进行中，请稍候';
      return;
    }
    if (outcome.code !== 0) {
      error.value = `加入房间失败（code=${outcome.code}）`;
      return;
    }
    /**
     * R61：**同一条 `room.join` 只能有一种状态写入方式**。
     *
     * 自动进房（`useGameSession.joinMatchedRoom`）已经消费 ack 里的 `players`，
     * 手动加入这里是同一条消息、同一个 ack 载荷 `{ roomCode, seat, players }`，
     * 因此也必须消费 `players`——否则「进房后立刻渲染座位」在两条路径上表现不一致。
     * 座位取 ack 的 `seat`；**不写 `status`**（ack 里没有这个字段，由服务端推送决定）。
     */
    const data = outcome.data as { seat?: number; players?: RoomPlayerLike[] } | undefined;
    store.setRoom(code, typeof data?.seat === 'number' ? data.seat : -1);
    store.applyRoomState({ players: data?.players ?? [] });
    auth.navigate('table');
  } finally {
    busy.value = false;
  }
}

/**
 * 创建房间（§7.1 的 `POST /api/rooms`，N30③/R454）：建房成功后**复用 `join()`** 进房。
 *
 * ⚠️ 顺序是刻意的：REST 建房阶段持 `busy` 锁，成功后在 `finally` 里**先释放**再调 `join()` ——
 * `join()` 自己也要拿同一把锁（`busy.value` 时早退）。若在锁内直接调用，进房会被静默吞掉
 * （房间建好了、人没进去）。释放与调用之间没有 `await`，因此不存在被别的点击插队的窗口。
 */
async function createAndJoin() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  let roomCode = '';
  try {
    /**
     * 🔴 **建房的底分必须跟用户选的那一档走**（终审 I-3 的落地形态）：
     * 本页中央显示的是「选中的底分」，而**建房**若不带上它，服务端会走
     * `dto.baseScore ?? DEFAULT_BASE_SCORE`（=15）⇒ 用户选了豪侠场 1200，
     * 好友房列表里那行却写着「底分 15」——**同一屏可见的矛盾**。
     * ⚠️ `null`（没选过）时**省略这个键**，不要传 `null`（服务端要的是「没给」）。
     * ⚠️ 这个形状与 `docs/client-protocol.md` §2 第 6 行**本来就写着**的
     * `POST /api/rooms` 载荷一致（`{ mode, baseScore? }`）—— 是客户端此前漏发，不是新设计。
     */
    const res = await rest.createRoom(
      store.selectedBaseScore === null
        ? { mode: 'practice' }
        : { mode: 'practice', baseScore: store.selectedBaseScore },
    );
    if (res.code !== 0) {
      error.value = `创建房间失败（code=${res.code}）`;
      return;
    }
    roomCode = (res.data?.code ?? '').trim().toUpperCase();
    if (!roomCode) {
      // 服务端没给房号就没法进房：如实报错，**不**编一个房号
      error.value = '创建房间失败：服务端未返回房号';
      return;
    }
    joinCode.value = roomCode;
  } catch (e) {
    error.value = `创建房间失败：${e instanceof Error ? e.message : String(e)}`;
    return;
  } finally {
    busy.value = false;
  }
  await join(roomCode);
}

onMounted(() => {
  loadRooms();
  /**
   * R658「再来一局」：牌桌回**本页**前写了**一次性意向**（`store.rematchPending`）——
   * 本页挂载时**消费一次**并复用本页唯一的 `match()`。
   *
   * ⚠️ 意向兑现用的是**当时选中的底分**（`selectedBaseScore` 跨页存活，`reset()` 不动它）
   * ⇒ 「再来一局」不需要用户重选。
   */
  if (store.consumeRematch()) void match();
});

/**
 * 本页是**非牌桌**那一屏 ⇒ 与大厅同一首 `CUES.BgmLobby`。
 *
 * ⚠️ 不接这一手的话「大厅 → 本页」会**静默**：大厅卸载时 `onUnmounted` 停了它那一首，
 * 而本页此前什么都不播。
 * ⚠️ 与 `lobby.vue` **逐字同形**：每个页面只管**自己**那一首、自己卸载时停掉 ——
 * 切曲**不跨页面做**（页面栈的唯一真源是 `auth.page`，音频跟着挂载/卸载走）。
 */
loadAudioPrefs();
playBgm(CUES.BgmLobby);
onUnmounted(() => stopBgm());
</script>

<template>
  <LandscapeStage>
    <view class="game">
      <!--
        ⚠️ **本注释必须在根元素内部**：模板注释放在根元素**之前**会让整页变成**多根**页面，
        `@vue/test-utils` 的 `wrapper.classes()` 于是静默返回 `[]`（`table-hud` 的单根闸盯着）。
      -->
      <view class="game__bar">
        <!-- ⚠️ 文案**逐字保留**：真浏览器探针按 `textContent.trim() === '返回大厅'` 匹配 -->
        <button type="button" class="btn btn--small" @click="auth.navigate('lobby')">返回大厅</button>
        <!-- R752：玩法名**从 store 读**（本页不得写死「斗地主」字面量） -->
        <text class="game__title">{{ mode.name }}</text>
      </view>

      <!-- N30①/R455：连接状态条（class 与 table.vue 的 `.table__notice` 同形）。页面只读 notice。 -->
      <SessionNotice class="game__notice" />

      <!-- 中央：场次名 + 底分 + 开始游戏 + 好友房 -->
      <view class="game__stage">
        <view class="game__scene">
          <!-- 场次名**从档位表按选中的底分查**（片规格 §4；查不到就不渲染 —— 不编名字） -->
          <text v-if="levelName" class="game__scene-name">{{ levelName }}</text>
          <text v-if="selectedBaseScore !== null" class="game__scene-base">底分 {{ selectedBaseScore }}</text>
        </view>

        <view class="game__match">
          <button
            v-if="!matching"
            type="button"
            class="btn btn--primary"
            :disabled="busy || selectedBaseScore === null"
            @click="match"
          >
            开始游戏
          </button>
          <template v-else>
            <text class="game__matching">正在匹配…（由服务端撮合）</text>
            <button type="button" class="btn" :disabled="busy" @click="unmatch">取消匹配</button>
          </template>
        </view>
        <text v-if="selectedBaseScore === null" class="game__hint">请先在大厅选择底分</text>

        <!-- 错误行：**一处来源**（`error`），两个落点 —— 弹层打开时它必须盖在弹层里，
             否则用户看不见（弹层是全屏遮罩）。两个 `v-if` 互斥 ⇒ DOM 里同时只有一个。 -->
        <text v-if="error && !friendsOpen" class="game__error">{{ error }}</text>

        <!-- 「好友房」二级入口（规格 §4）：**弹层**，不新增路由 -->
        <button
          type="button"
          class="btn game__friends-open"
          :disabled="busy || matching"
          @click="friendsOpen = true"
        >
          好友房
        </button>
      </view>

      <!-- 左下：玩家信息条（与大厅顶栏同一个共用件） -->
      <PlayerChip class="game__player" :name="auth.displayName" />

      <!--
        「好友房」弹层（片规格 §4 裁决二）：创建房间 / 输房号 / 房间列表三件**整体**收进来。
        class 前缀 `game__` 与文案**逐字保留**（探针与用例指着它们）。
        房间列表用 `wot-design-uni`（easycom，**零 import**）：`wd-cell-group` / `wd-cell` / `wd-loadmore`。
      -->
      <view v-if="friendsOpen" class="game__friends">
        <view class="game__friends-panel">
          <view class="game__friends-head">
            <text class="game__friends-title">好友房</text>
            <button type="button" class="btn btn--small game__friends-close" @click="friendsOpen = false">
              关闭
            </button>
          </view>

          <!-- N30③/R454：§7.1 的 POST /api/rooms 前端入口（与「开始游戏」并列，不走匹配队列）。 -->
          <view class="game__create">
            <button type="button" class="btn game__create-room" :disabled="busy" @click="createAndJoin">
              创建房间
            </button>
          </view>

          <text v-if="error && friendsOpen" class="game__error">{{ error }}</text>

          <view class="game__join">
            <input v-model="joinCode" type="text" placeholder="输入 6 位房间号" maxlength="6" />
            <!-- ⚠️ 必须写成 `join()`：`join(code?: string)` 之下 `@click="join"` 会把 MouseEvent 当房号传进去 -->
            <button type="button" class="btn" :disabled="busy || !joinCode" @click="join()">加入</button>
          </view>

          <view class="game__rooms">
            <view class="game__rooms-head">
              <text class="game__rooms-title">房间列表</text>
              <!-- ⚠️ 必须写成 `loadRooms()`：`@click="loadRooms"` 会把 MouseEvent 当成 `replayed` 参数 -->
              <button type="button" class="btn btn--small" @click="loadRooms()">刷新</button>
            </view>

            <wd-cell-group v-if="rooms.length > 0" class="game__list" border>
              <!-- N30③/R454：列表项可点 → **复用**同一条 `room.join`（见 `join(code?)` 的注释）。
                   `clickable` 才会 emit click（`wd-cell` 只在 clickable/is-link 时 emit）。 -->
              <wd-cell
                v-for="room in rooms"
                :key="room.code"
                class="game__item game__item--clickable"
                clickable
                center
                @click="join(room.code)"
              >
                <template #title>
                  <text class="game__code">{{ room.code }}</text>
                </template>
                <view class="game__meta">
                  <wd-tag class="game__status" :type="STATUS_TAG_TYPE[room.status]" plain>{{ room.status }}</wd-tag>
                  <!-- 逐字保留改造前的整句文案（`status · n/m · 底分 x`）：测试对它的断言是文本级的 -->
                  <text class="game__count">
                    {{ room.status }} · {{ room.playerCount }}/{{ room.maxPlayers }} · 底分 {{ room.baseScore }}
                  </text>
                </view>
              </wd-cell>
            </wd-cell-group>

            <!-- 空态：`wd-loadmore` 的 `finished` 态自带一条分割线 + 文案。
                 ⚠️ **文案必须走 `finished-text` prop，不能写在标签之间**（片③ F7 的订正）：
                 该组件的 `finished` 分支是 `<wd-divider>{{ finishedText || translate('finished') }}</wd-divider>`
                 —— 模板里**根本没有 `<slot/>`** ⇒ 写在标签之间的内容**被丢弃**。 -->
            <wd-loadmore v-else class="game__empty" state="finished" finished-text="暂无房间" />
          </view>
        </view>
      </view>
    </view>
  </LandscapeStage>
</template>

<style scoped lang="scss">
/**
 * 开始游戏页（片② 客户端）：顶栏 + 中央 + 左下信息条 + 好友房弹层。
 *
 * ⚠️ 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（**只引用，不改定义**）。
 * ⚠️ 视觉语言**照抄总规格 §5.2.1**（半透明深蓝面板 / 金主按钮 / 分段·选中控件…）。
 * ⚠️ **锚点一个不改**：`.game__match .btn`（探针的锚点）· `.game__create-room` ·
 *    `.game__join input` · `.game__item` · `.game__rooms-head .btn`。
 */
.game {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
  width: 100%;
  height: 100%;
  padding: $ftl-space-2 $ftl-space-5;
}
.game__bar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-5;
  min-height: $ftl-bar-h;
}
/**
 * ⚠️ **走查修复（片③ Task 6）**：`uni-button` 基样式带 `margin-left/right: auto`
 * （与 `login.vue` 是**同一个坑**：H5 上 `<button>` 编译成 `uni-button`）——
 * 在**有富余宽度**的 flex 行里这两个 auto 会把按钮**顶到中间**。
 * 实测（真浏览器，布局 px）：`.game__bar .btn` 的 `margin = 531px 531px` ⇒ 顶栏渲染成
 * 「返回大厅**居中** · 玩法名贴右」，而**本页的意图**是「返回大厅在左、玩法名跟着」
 * （`.game__bar` 是普通 flex 行，没有 `justify-content`）。
 * 本仓的既有形态是「按钮放进**内容宽**的组里」让 auto 自然失效（`table.vue` 的 `.table__bar-left`）；
 * 本页顶栏只有两个元素 ⇒ 直接压掉 auto 边距，回到左对齐。
 * ⚠️ 这是**观感类**修复（`mount()` 看不见样式）⇒ 证明方式是**产物 CSS + 真浏览器截图**，
 * **不写机械判据**（全局约束 8）。
 */
.game__bar .btn {
  margin: 0;
}
/** 玩法名（R752）：从 store 读，**不写死字面量**。 */
.game__title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 600;
  line-height: 1.2;
}
/** 中央区：场次名 + 底分 + 开始游戏 + 好友房，整块居中。 */
.game__stage {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-6;
  min-height: 0;
}
/** 场次名 + 底分：**半透明深蓝面板**托住（§5.2.1 的第一条定格值；也是可读性需要）。 */
.game__scene {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-3;
  padding: $ftl-space-6 $ftl-space-9;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
/**
 * 中央大标题：白字 + **多层 `text-shadow`** 深色描边（§5.2.1 定稿的排版手法）。
 * ⚠️ 不用 `-webkit-text-stroke`（多端表现不一致，样板实测后未采用）。
 */
.game__scene-name {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-xxl;
  font-weight: 700;
  line-height: 1.2;
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
.game__scene-base {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-lg;
  line-height: 1.2;
}
.game__match {
  display: flex;
  gap: $ftl-space-4;
  align-items: center;
}
.game__match .btn {
  flex: 1;
  margin: 0;
}
.game__matching {
  flex: 1;
  color: $ftl-color-gold-light;
  font-size: $ftl-font-md;
}
/** 未选底分时的说明（按钮禁用 + 这里说**为什么** —— 本仓忌讳「点了没反应的活按钮」）。 */
.game__hint {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 深色底上的错误文字（§5.2.1 的专用令牌）。 */
.game__error {
  color: $ftl-color-danger-on-dark;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
/** 左下：玩家信息条（与大厅顶栏同一个共用件）。 */
.game__player {
  align-self: flex-start;
}
/**
 * 好友房弹层：**全屏遮罩 + 居中面板**（规格 §4 裁决二）。
 * ⚠️ `z-index` 只在这里用一次 —— 弹层必须盖住页面其余部分（尤其错误行）。
 */
.game__friends {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba($ftl-color-night-deep, 0.62);
}
.game__friends-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  width: 640px;
  max-height: 100%;
  padding: $ftl-space-6;
  overflow-y: auto;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.62);
}
.game__friends-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
}
.game__friends-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
}
/** 弹层里的按钮：**次按钮语言**（§5.2.1）。 */
.game__friends-close {
  flex: 0 0 auto;
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.game__friends .btn:not(.btn--primary) {
  margin: 0;
  border-color: $ftl-color-night-soft;
  background: transparent;
  background-image: none;
  color: $ftl-color-on-primary;
}
.game__create,
.game__join {
  display: flex;
  gap: $ftl-space-4;
  align-items: center;
}
.game__create .btn {
  flex: 1;
}
.game__join input {
  box-sizing: border-box;
  flex: 1;
  height: $ftl-control-h;
  padding: 0 $ftl-space-7;
  border: $ftl-hairline solid $ftl-color-border-control;
  border-radius: $ftl-radius-md;
  /* 输入框保持白底深字（§5.2.1：参考图 1 的浅色卡片语言） */
  background: $ftl-color-surface;
  color: $ftl-color-text;
  font-size: $ftl-font-lg;
  text-transform: uppercase;
}
.game__join .btn {
  flex: 0 0 auto;
}
.game__rooms-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $ftl-space-3;
}
.game__rooms-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 600;
  line-height: 1.2;
}
.game__list {
  display: block;
}
.game__item {
  font-size: $ftl-font-md;
}
.game__code {
  color: $ftl-color-text;
  font-weight: 600;
  letter-spacing: 2px;
}
.game__meta {
  display: flex;
  align-items: center;
  gap: $ftl-space-3;
}
.game__count {
  color: $ftl-color-text-muted;
}
/**
 * 空态（`wd-loadmore` 的 `finished` 态）。
 *
 * 🔴 **颜色必须穿透给内部的 `wd-divider`**（复核发现）：该组件在 `finished` 时渲染的是
 * `<wd-divider>{{ finishedText }}</wd-divider>`，而 `wd-divider` **自持**颜色
 * （`color: rgba(0, 0, 0, .45)`）⇒ 文字**不在** `.game__empty` 的继承链上。
 * 本页这行「暂无房间」压在**.game__friends-panel 的半透明深蓝面板**上 ⇒ 近黑字读不出来。
 * ⚠️ 诚实记账：同一行字今天也压在同色系的 `.stage` 底纹上（**不是本片引入的退化**），
 * 但 §5.2.1 要求面板内文字走 `on-primary` 系 —— 这是目前唯一一处没兑现的。
 * ⚠️ `:deep()` 在本仓已有先例（`table.vue` / `Card.vue`）。
 */
.game__empty {
  display: block;
  font-size: $ftl-font-sm;
}
.game__empty :deep(.wd-divider) {
  color: rgba($ftl-color-on-primary, 0.75);
}
/**
 * 会话提示（R751：**共用件** `SessionNotice.vue` 的宿主样式）。
 *
 * ⚠️ 级别 class 是组件发的 `notice--{level}`（**不带宿主前缀**）⇒
 * 级别配色必须同时选中两者（`.game__notice.notice--error`）。
 * 本页只管**自己**这条的观感 —— 组件不持有布局、不设颜色。
 */
.game__notice {
  display: block;
  box-sizing: border-box;
  padding: $ftl-space-3 $ftl-space-7;
  border-radius: $ftl-radius-md;
  background: $ftl-color-info-bg;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
.game__notice.notice--warn {
  background: $ftl-color-warn-bg;
}
.game__notice.notice--error {
  background: $ftl-color-danger-bg;
  color: $ftl-color-danger;
}
.game__notice.notice--info {
  background: $ftl-color-success-bg;
}
.btn {
  @include ftl-btn;
}
.btn--small {
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  font-size: $ftl-font-sm;
}
/**
 * 主按钮：**金色 + 深金描边 + 白字**（总规格 §5.2.1 的定稿值）。
 *
 * ⚠️ **必须有一行 `background:`** —— 真实理由就是上面那条视觉语言本身：§5.2.1 逐字要求
 * 主按钮 = `background: $ftl-color-gold` + 描边 `$ftl-color-gold-deep` + 白字。
 * ⚠️ **如实记账**：本页的主按钮**没有机械闸盯着** —— `table-bid-bottom.test.ts` 的「主按钮自持」
 * 闸的扫描面逐字是 `f.path.startsWith('src/components/')`，`game.vue` **不在射程内**
 * ⇒ 删掉这一行**没有任何单测会红**（早前把「少了它会被该闸报出」当理由，是**错的归因**）。
 * ⚠️ **`background-image` 与 `background-size` 必须删掉**（§5.2.1 逐字）：原处的
 * `url($ftl-btn-plate-primary)` 贴图会**盖住金色**。
 */
.btn--primary {
  margin: 0;
  border-color: $ftl-color-gold-deep;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
}
/** 好友房入口：**幽灵/弱化按钮**语言（§5.2.1）—— 透明底 + 虚线描边 + 浅白字。 */
.game__friends-open {
  flex: 0 0 auto;
  width: auto;
  margin: 0;
  border-style: dashed;
  border-color: rgba($ftl-color-on-primary, 0.45);
  background: transparent;
  background-image: none;
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
```

> 🔴 **执行期复核订正（2026-09-27，控制者文本缺陷 C-26 ~ C-29）**：
> 1. **C-26（漏判爆炸半径，第三次）**：Step 1 初稿说「挂 `GamePage` 且读 DOM 的 **4** 条用例」并列出四条 ——
>    **漏了第 5 条**：「玩法页的匹配按钮」组里的「**手动「加入」也消费 ack 的 players 并校正座位**」
>    也读 `.game__join input`，而它**不在**被点名的那个 `describe` 里。初稿还写着「其余部分一个字符不动」
>    ⇒ **照初稿逐字做必红**。已改成 5 条（见上）。
>    ⚠️ 评审**逐个文件**核过 `apps/client/test/**` 里所有弹层内 DOM 的引用，确认**没有第 6 条**。
> 2. **C-27（替换块漏抄·注释）**：`game.vue` 的替换块删掉了既有注释里承载**行为理由**的句子 ——
>    F7 空态注释最后两句（片③ §9 F7 的实测出处 + 「初稿那句…是**错的**」）与 BGM 注释块的
>    「`playBgm` 自身会先停掉当前曲 ⇒ …」。「与 `lobby.vue` **逐字同形**」那句话因此**字面上不再成立**
>    （`lobby.vue:160` 保留着它）。两处都已回补，回补后 `game.vue:301` 与 `lobby.vue:160` **逐字相同**。
>    ⇒ **教训**：整体替换块里，凡**仍然成立的行为理由**都必须原样搬过去；规划时逐块核一遍。
> 3. **C-28（计划自相矛盾）**：Step 6 的 `git add` 清单**漏了它自己 Step ⑥ 要求改的** `ui-flow.test.ts`。
>    已补进清单（否则实施者会在工作区留下未提交改动）。
> 4. **C-29（对闸射程的错误陈述）**：Step 3 的 `.btn--primary` 注释说「留着贴图会被 `table-bid-bottom.test.ts`
>    的主按钮闸报出」—— **实测该闸只扫 `src/components/**`**，`src/pages/game/game.vue` **不在射程内**
>    （`table-bid-bottom.test.ts:444` 逐字是 `f.path.startsWith('src/components/')`）。
>    ⇒ 「必须保留一行 `background:`」这个保守做法**没有代价**（那行本身就是 §5.2.1 要求的金色填充），
>    但**不该把理由归给一条不覆盖本文件的闸**。已按实况改。
> 5. **额外发现（跨文件陈旧引用，留最终评审分诊）**：`.game__match` 的主按钮文案从「随机匹配」改成「开始游戏」
>    之后，**四处旧文案引用**失真：`stores/game.ts:367` · `useGameSession.ts:64`（「没有「随机匹配」可点」）·
>    `game-store-session-reset.test.ts:48/109`（用例名/注释）· `lobby-modes.test.ts:12-14`
>    （明文引用 auth-ui-wiring「用例名逐字带「随机匹配」」）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/lobby-ux.test.ts test/auth-ui-wiring.test.ts test/settlement-rematch.test.ts test/room-matched-join.test.ts test/game-store-session-reset.test.ts`

Expected: **PASS**。

> ⚠️ `settlement-rematch.test.ts` ⑤ 那条数的是 `game.vue` 里 `send('room.match'` **恰好 1 处** —— 本步只保留 `match()` 里那一处，**不要**在任何别处再发匹配。

- [ ] **Step 5: 跑机械闸与单根闸**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/ui-tokens.test.ts test/table-hud.test.ts test/source-boundary.test.ts test/art-slots.test.ts test/landscape-canvas.test.ts`

Expected: **PASS**。

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/pages/game/game.vue apps/client/test/lobby-ux.test.ts apps/client/test/auth-ui-wiring.test.ts apps/client/test/ui-flow.test.ts
git commit -m "feat(client): 开始游戏页重做 —— 中央开始游戏 + 好友房弹层

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 真浏览器探针（**本片最重的一处**）

**Files:**
- Modify: `scripts/browser-e2e.mjs`

> 🔴 **为什么必须改、改哪几处、每处的理由**：见 §0 的表。**改完必须真跑**（`Step 3`）。

- [ ] **Step 1: 改 `matchAndWaitDeal` 的大厅分支（`:447`–`:463`）**

> 🔴 **别把范围读成 `:442`–`:446`**（复核订正）：那五行是**仍然有效**的 JSDoc ——
> 「一次等『任一页面就绪』…不用两段式」那段推理（它记着「分两段等会把冷启动编译 chunk 的耗时夹在中间」
> 这个实测坑）。要替换的**只有**从 `await waitForSelector(cdp, '.lobby__mode, .game__match .btn', 20000);`
> 到下面第二个 `await waitForSelector(cdp, '.game__match .btn', 20000);` 之间的那段代码。

把该函数里从 `await waitForSelector(cdp, '.lobby__mode, .game__match .btn', 20000);` 到 `await waitForSelector(cdp, '.game__match .btn', 20000);`（第二次）**整段**替换为：

```js
  /**
   * ⚠️ **片② 客户端（第二次改动）**：大厅的流转变了 ——
   * **点玩法卡 = 只切换选中**、**点底分卡 = 进开始游戏页**（片规格 §3 裁决一）。
   * ⇒ 原来「点 `.lobby__mode` 然后等 `.game__match .btn`」这一步**当场断**（干等 20s 超时）。
   * 现在按**两步**走，并各留一条判据：这正是本片要守的那条行为变更。
   */
  await waitForSelector(cdp, '.lobby__mode, .game__match .btn', 20000);
  const onLobby = await cdp.eval(`document.querySelectorAll('.lobby__mode').length`);
  if (onLobby > 0) {
    // ① 点玩法卡：**只切换选中、不得跳页**
    const clickedMode = await cdp.eval(`(() => {
      const el = document.querySelector('.lobby__mode');
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()`);
    const afterModeClick = await cdp.eval(READ_STATE);
    check(
      `${label}：点玩法卡**只切换选中、不跳页**（片规格 §3 裁决一 · 行为变更）`,
      clickedMode === 'clicked' && afterModeClick.page === 'lobby',
      `click=${clickedMode} page=${afterModeClick.page}（期望仍是 lobby）`,
    );

    // ② 点底分卡：**这才进开始游戏页**。底分卡要等 REST（GET /api/base-score-levels）回来
    const levelsReady = await waitForSelector(cdp, '.lobby__level', 20000);
    const levelName = await cdp.eval(`(() => {
      const el = document.querySelector('.lobby__level-name');
      return el ? el.textContent.trim() : null;
    })()`);
    const clickedLevel = await cdp.eval(`(() => {
      const el = document.querySelector('.lobby__level');
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()`);
    const intoGame = await waitForSelector(cdp, '.game__match .btn', 20000);
    check(
      `${label}：点底分卡进入开始游戏页（片规格 §3 裁决一）`,
      intoGame > 0,
      `click=${clickedLevel} .lobby__level=${levelsReady} 档位名=${levelName ?? '(无)'} .game__match .btn=${intoGame}`,
    );

    /**
     * ③ **两页之间的接口**（片规格 §3 的第二个接口）：开始游戏页的场次名**复用**大厅取到的
     * 档位表（不是重调接口、更不是编一个名字）⇒ 它必须**逐字等于**刚才那张卡上的名字。
     * 这是「store 当跨页载体」这条设计在**真栈上**的唯一证据。
     */
    const sceneText = await cdp.eval(`(() => {
      const el = document.querySelector('.game__scene');
      return el ? el.textContent.trim() : null;
    })()`);
    check(
      `${label}：开始游戏页的场次名来自档位表（两页接口的端到端证据）`,
      !!levelName && (sceneText ?? '').includes(levelName),
      `档位表名=${levelName ?? '(无)'} 开始游戏页="${sceneText ?? '(无)'}"`,
    );
  }
  await waitForSelector(cdp, '.game__match .btn', 20000);
```

> ⚠️ **这条判据的射程（诚实版，别读成更强的承诺）**：
> 它能红——但红的对象是**旧行为**（点完跳页 ⇒ `page === 'game'`）。它**不能**证明
> 「选中真的生效了」：`activeMode` 的默认值恰好就是唯一那张卡的 id
> （`DEFAULT_MODE_ID === 'doudizhu'`）⇒ 断言「卡上有选中态」会是**恒真**的。
> 「真的调了 `setActiveMode`」那半边由 `lobby-modes.test.ts` 的 **spy** 守（单测里能做，
> 探针里做不了）。本片加这条探针判据的全部目的，是**守住行为变更本身**
> —— 谁把「点玩法卡 = 跳页」改回来，这里当场红。

- [ ] **Step 2: 改另外三处**

**(a)** `matchAndWaitDeal` 里点匹配按钮的那一行（原 `:464`）：

```js
  // ⚠️ 文案按片规格 §4 改成「开始游戏」（原「随机匹配」）—— 它是 `.game__match` 里唯一的主按钮
  const clickedMatch = await cdp.eval(clickByText('.game__match .btn', '开始游戏'));
```

并把该函数里那条 check 的标签里的「随机匹配」逐字改成「开始游戏」：

```js
  check(
    `${label}：开始游戏 → game.deal 被客户端接受（进入牌桌）`,
```

**(b)** `ensureGamePage`（原 `:542`–`:556`）**整体**替换：

```js
async function ensureGamePage(cdp, label) {
  let st = await cdp.eval(READ_STATE);
  if (st.page === 'table') {
    await waitForSelector(cdp, '.table__bar .btn', 20000);
    await cdp.eval(clickByText('.table__bar .btn', '返回大厅'));
    st = await waitFor(cdp, `${label}：离开牌桌`, (s) => s.page !== 'table', 15000);
  }
  if (st.page === 'lobby') {
    // ⚠️ 片② 客户端：点玩法卡**只切换选中**，进页要点**底分卡**（片规格 §3 裁决一）。
    await waitForSelector(cdp, '.lobby__mode', 20000);
    await cdp.eval(`(() => { const el = document.querySelector('.lobby__mode'); if (!el) return 'not-found'; el.click(); return 'clicked'; })()`);
    await waitForSelector(cdp, '.lobby__level', 20000);
    await cdp.eval(`(() => { const el = document.querySelector('.lobby__level'); if (!el) return 'not-found'; el.click(); return 'clicked'; })()`);
    st = await waitFor(cdp, `${label}：进入开始游戏页`, (s) => s.page === 'game', 15000);
  }
  /**
   * 🔴 **建房 / 房号加入 / 房间列表三个锚点现在在「好友房」弹层里**（片规格 §4 裁决二）
   * ⇒ 关着的时候它们**不在 DOM 里**（这正是「收进弹层」的语义），动手前必须先打开它。
   * ⚠️ 这一步是**幂等**的：入口按钮把 `friendsOpen` 置 `true`（不是 toggle），
   * 所以「已经是开的」时再点一次不会把它关掉（`createRoomAndJoin` 的回程会再调本函数）。
   */
  await cdp.eval(clickByText('.game__friends-open', '好友房'));
  const ready = await waitForSelector(cdp, '.game__create-room', 20000);
  return { page: st.page, ready };
}
```

**(c)** `createRoomAndJoin` 的注释块里**那一句**引用旧锚点的说明（原 **`:571`** —— ⚠️ 复核订正：
**只改这一句**，`:565`–`:570` 那两条理由（「不能放 `matchAndWaitDeal` 内部」/「这一刻是干净的」）
**必须原样保留**，它们记的是两个实测坑）改成：

```js
 *  - **回程原语**：`.table__bar .btn`（返回大厅）→ `.lobby__mode`（选玩法）→ `.lobby__level`
 *    （选底分并进入）→ `.game__friends-open`（开好友房）四段就回得来 —— 见 `ensureGamePage`。
```

- [ ] **Step 3: 🔴 真跑（这一步不是可选的）**

前置：8 个容器在跑（`docker compose ps` 见 8 个 healthy）。

```bash
# 先跑门禁场景（~90s）
node scripts/browser-e2e.mjs
```

Expected:
- 全部 ✅，**0 个 ❌**
- 三条**新**判据出现且为绿：
  - `…：点玩法卡**只切换选中、不跳页**（片规格 §3 裁决一 · 行为变更）`
  - `…：点底分卡进入开始游戏页（片规格 §3 裁决一）`
  - `…：开始游戏页的场次名来自档位表（两页接口的端到端证据）`
- 总条数**比改前多**（`matchAndWaitDeal` 每次调用 +2），**以实跑输出为准**，并把实测条数记进交接文档。
- 最后两条（`Runtime.exceptionThrown 为 0` / `error 级 console 为 0`）为绿。

```bash
# 再跑完整场景（~4min；它是本片唯一覆盖「创建房间 → 进房 → 机器人补位 → 真跨局」的路径）
node scripts/browser-e2e.mjs --scenario full
```

Expected: 全绿。

**若红**：先看 `❌` 那条的 detail 里的 `page=` 与 `click=`。
- `click=not-found` 且 `page=lobby` ⇒ `.lobby__level` 没渲染 ⇒ 查大厅的档位表请求（`docker compose logs user-service` / 浏览器 Network）。
- `click=clicked` 但 `page` 停在 `lobby` ⇒ `enterLevel` 没被调（或 `navigate` 没生效）。
- `.game__create-room=0` 且 `page=game` ⇒ 「好友房」入口没被点到（`clickByText` 是**精确**匹配
  ⇒ 十有八九是按钮文案不是**逐字**「好友房」），或弹层没真的渲染出建房按钮。
  ⚠️ 复核订正：**没有**任何一条 check 会同时产出 `click=` 与 `page=game` ——
  按 `click=not-found` 去找这一条会白找；要看的是 `ensureGamePage` 那条 check 的
  `page=… .game__create-room=0`。

- [ ] **Step 4: 提交**

```bash
git add scripts/browser-e2e.mjs
git commit -m "test(e2e): 真浏览器探针跟上大厅流转变更（点玩法=选中 / 点底分=进入）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: mock-server 的 REST 面（两条只读 GET）

**Files:**
- Create: `tools/mock-server/src/rest.ts`
- Modify: `tools/mock-server/src/index.ts`
- Modify: `apps/client/.env.mock`（**复核订正：不补这个，Task 7 的交付物在浏览器里一条都到不了**）
- Test: `tools/mock-server/test/rest.test.ts`（新建）

**Interfaces:**
- Produces:
  - `export const MOCK_BASE_SCORE_LEVELS: ReadonlyArray<{ name: string; baseScore: number }>`
  - `export function installRest(server: { on(event: 'request', cb: (req, res) => void): unknown }, rooms: () => RoomInfoLike[]): void`
  - `export interface RoomInfoLike { code: string; mode: 'random'; status: string; playerCount: number; maxPlayers: number; baseScore: number }`

> **用户裁决（2026-09-27）**：补 `levels` + `rooms` 两条，让「对着 mock 跑通」成立。
> ⚠️ **如实记账**：`POST /api/rooms`（创建房间）与 `POST /api/rooms/:code/join`（占座）
> **本片不补** ⇒ 对着**纯 mock** 走「好友房」的两条动作仍然跑不通（`GET /api/rooms` 能出列表、
> 点进去会 404）。这是**已知缺口**，见文末；要闭合它得再加两条写接口 + 一套内存房间表。

- [ ] **Step 1: 写失败的测试**

新建 `tools/mock-server/test/rest.test.ts`：

```ts
/**
 * mock 的 REST 面（片② 客户端新增）：**两条只读 GET**。
 *
 * 判别力说明：直接对 `installRest` 装在一台**真 `node:http` 服务器**上打真请求 ——
 * 「路由表写对了没有」只有真发一次请求才测得出来（自己 mock 一层 http 等于测替身）。
 */
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installRest, MOCK_BASE_SCORE_LEVELS, type RoomInfoLike } from '../src/rest';

let server: Server;
let base: string;
let rooms: RoomInfoLike[];

beforeEach(async () => {
  rooms = [];
  server = createServer();
  installRest(server, () => rooms);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('拿不到端口');
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('mock REST：与真服务端同一套信封（§11.1）', () => {
  it('GET /api/base-score-levels ⇒ { code: 0, data: { levels } }，四档且底分唯一', async () => {
    const res = await fetch(`${base}/api/base-score-levels`);
    const body = (await res.json()) as { code: number; data: { levels: { name: string; baseScore: number }[] } };

    expect(res.status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.levels).toHaveLength(4);
    expect(new Set(body.data.levels.map((l) => l.baseScore)).size, '底分必须唯一（真表的 base_score 有 UNIQUE KEY）').toBe(
      4,
    );
    /**
     * ⚠️ **钉字面量 4，不要写 `MOCK_BASE_SCORE_LEVELS.length`**（复核订正）：写成常量本身 = **自指**
     * （把常量改成 2 档或 6 档，这两条断言跟着一起绿，零判别力）—— 而这条用例的名字声称的就是「**四档**」。
     * ⚠️ 再加一条具体值：`name` 与 `baseScore` 是**两个**字段，只数长度的话写错字段名也发现不了。
     */
    expect(body.data.levels).toContainEqual({ name: '休闲场', baseScore: 15 });
  });

  it('GET /api/rooms ⇒ { code: 0, data: RoomInfo[] }；空的时候就是空数组', async () => {
    const res = await fetch(`${base}/api/rooms`);
    const body = (await res.json()) as { code: number; data: RoomInfoLike[] };
    expect(body.code).toBe(0);
    expect(body.data).toEqual([]);
  });

  it('GET /api/rooms 把**传进来的**房间原样交回（mock 不编数据）', async () => {
    rooms = [{ code: 'MOCK01', mode: 'random', status: 'playing', playerCount: 1, maxPlayers: 3, baseScore: 80 }];
    const body = (await (await fetch(`${base}/api/rooms`)).json()) as { data: RoomInfoLike[] };
    expect(body.data).toEqual(rooms);
  });

  it('未知路径 ⇒ 404 且**不是**平台信封（不假装成功）', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.text(), '不得回一个成功的平台信封').not.toMatch(/"code"\s*:\s*0/);
  });

  it('🔴 OPTIONS 预检 ⇒ 204 + 放开 authorization 头（少了它浏览器里一条都到不了）', async () => {
    const res = await fetch(`${base}/api/base-score-levels`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.status, '预检必须成功（否则浏览器根本不会发那条 GET）').toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('真响应也带 CORS 头（不只是预检那一下）', async () => {
    const res = await fetch(`${base}/api/rooms`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
```

> ⚠️ **为什么用正则不用 `not.toContain('"code":0')`**（复核订正）：裸子串匹配会被 `{"code": 0}`
> （冒号后带空格）绕过去，而它在 `net/rest.ts` 的 `parse()` 眼里与 `"code":0` 是**同一种事实**
> —— 带数字 `code` 的信封 ⇒ 会被读成成功。
>
> ⚠️ **`server.listen(0, '127.0.0.1')` 是刻意的**（不撞固定端口），但它正是记忆 `ci-flake-known`
> 第 ② 条记的 Windows 假红形态：动态端口落在 **1024–15000** 时会撞上 Node `fetch` 的**封禁端口表**
> （`TypeError: bad port`）。本仓纪律：**先单跑确认 → 如实记「首跑红/单跑绿」→ 记成「未复现」，
> 不许写成「通过」**。若真撞上，把 `listen(0, …)` 换成「在 20000–30000 里随机挑一个」即可
> （**不要**改成固定端口 —— 那会在 CI 上撞车）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @fight-the-landlord/mock-server exec vitest run test/rest.test.ts`

Expected: **FAIL** —— `Failed to resolve import "../src/rest"`。

- [ ] **Step 3: 写 `tools/mock-server/src/rest.ts`**

```ts
/**
 * mock 的 **REST 面**（片② 客户端新增）。
 *
 * ## 为什么现在才加
 *
 * mock 一直是**纯 socket.io** 的（连 express 都没有）—— 因为「没有 REST 也能开发」。
 * 片② 客户端起，**大厅挂载就要读 `GET /api/base-score-levels`**（底分只能来自服务端，
 * M09）⇒ 对着一个没有 REST 的 mock 跑，大厅的档位区永远是空的、**没有卡可点**。
 *
 * ## 设计原则（与 `index.ts` 同源）
 *
 *  - **与契约同源**：响应一律是平台信封 `{ code, data }`（§11.1），`code: 0` 才是成功；
 *  - **不编数据**：`rooms` 由调用方以**闭包**注入（mock 的真实房间表在 `index.ts` 里），
 *    本模块只负责「把 HTTP 说成信封」这一件事；
 *  - **只读**：本片只补两条 GET。**写接口（建房 / 占座）不在范围内** ——
 *    对着纯 mock 走「好友房」的两条动作仍然跑不通（见计划的已知缺口）。
 *
 * ⚠️ 用**裸 `node:http`**、不引 express：mock 的 `package.json` 只有 `socket.io` 一个运行时依赖，
 * 为两条 GET 引一整个框架会让它与真服务端的依赖差距变大（而 mock 的价值恰恰是「轻」）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 档位表的 mock 值 —— **与 `user-service` 迁移脚本里的缺省数据同值**（休闲场 15 / 标准场 80 / 竞技场 480 / 豪侠场 1200）。 */
export const MOCK_BASE_SCORE_LEVELS: ReadonlyArray<{ name: string; baseScore: number }> = [
  { name: '休闲场', baseScore: 15 },
  { name: '标准场', baseScore: 80 },
  { name: '竞技场', baseScore: 480 },
  { name: '豪侠场', baseScore: 1200 },
];

/** `RoomInfo` 里 mock 真正知道的字段（**不多给** —— 与客户端的「不造字段」同一条纪律）。 */
export interface RoomInfoLike {
  code: string;
  mode: 'random';
  status: string;
  playerCount: number;
  maxPlayers: number;
  baseScore: number;
}

/** 只要求「能挂一个 request 监听」——不把整台 `Server` 引进来，便于单测直接 `createServer()`。 */
export interface RequestHost {
  on(event: 'request', listener: (req: IncomingMessage, res: ServerResponse) => void): unknown;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * 装上 REST 面。`rooms()` 每次请求**现取**（返回当前真实房间），不是一个快照。
 *
 * ⚠️ 只处理**本模块认识的**两条路径，其余一律 `404` + 一句人话 ——
 * **不假装成功**（回 `{code:0}` 会让「对着 mock 跑不通」变成更难查的形态）。
 *
 * 🔴 **必须自带 CORS**（复核订正 2026-09-27）：mock 模式的客户端是**直连** `http://localhost:3400`
 * 的（`apps/client/.env.mock` 的 `VITE_API_BASE`），与页面 origin（5173）**跨源**；而
 * `rest.ts` 的每个请求都带 `Authorization` ⇒ 浏览器会**先发 OPTIONS 预检**。
 * ⇒ 少了这段，两条 GET 在真浏览器里**一条都到不了**（curl 能通、页面全红 —— 最难查的那种形态）。
 * ⚠️ socket.io 的 `cors: { origin: '*' }` **不覆盖**裸 `host.on('request')` 这条链路，别指望它。
 *
 * 🔴🔴 **执行期订正（2026-09-27）—— 本段原文的结论是错的，且照做会把进程搞崩**
 *
 * 原文写：「与 socket.io/engine.io 共用同一台 `http.Server` 是安全的（已核源码）」，并给了
 * `attachServe()` / engine.io `attach()` 两处行号。**那两处行号是真的、行为描述也是真的 ——
 * 但它证明的是「请求投递」（谁被调用），而共用一条处理链的安全性取决于「响应归属」（谁先写）。**
 * 实测（实施者复现两次）：
 *   ① `new Server(PORT)` 的**端口分支**会 `http.createServer((req,res)=>{res.writeHead(404);res.end();})`
 *      （socket.io@4.8.3 `dist/index.js:219-227`）⇒ 它对一切非 `/socket.io/` 路径**先写掉响应**，
 *      我们追加的监听者再 `writeHead` 就抛 `ERR_HTTP_HEADERS_SENT`、进程退出。
 *      ⚠️ **我漏读的正是这个分支** —— 我只读了 `attachServe()`。
 *   ② engine.io `attach()` 只回放它 attach **之前**登记的监听者（`build/server.js:674-675` 的
 *      `slice(0)` + `removeAllListeners`），而 Node 对每个请求调用**当下登记的全部**监听者
 *      ⇒ 我们追加的那个**也会收到 `/socket.io/…`**（此时 engine.io 已写/正握着响应）⇒ 二次写头。
 *      「不会互相吞」为真 = **人人都会跑** —— 这正是危险所在。
 *
 * ⇒ **正确形态（已落地，以代码为准）**：
 *   · `tools/mock-server/src/index.ts`：**裸 `http.createServer()`** + `new Server(httpServer, { cors })`
 *     + 手动 `listen(PORT)`（**不要**用 `new Server(PORT)` 的端口形态）；
 *   · `tools/mock-server/src/rest.ts`：监听者**入口先按路径跳过** `/socket.io` 与 `/socket.io/`
 *     （在读方法**之前**跳），再处理 OPTIONS 与两条 GET。
 *   · 判据：`tools/mock-server/test/rest.test.ts` 的第 7 条用**真 socket.io + 真 http server + 真 fetch**
 *     复刻这条接缝（删掉那个跳过就会红/崩）。
 *
 * ⚠️ **教训（值得写下来）**：我为「共用 server 安全」辩护时核的是**调用图**，
 * 而真正的判据是**谁拥有响应**。核错了层，就会得出既自信又相反的结论。
 */
export function installRest(host: RequestHost, rooms: () => RoomInfoLike[]): void {
  host.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // 预检：浏览器对「跨源 + 带 Authorization」的请求会先问一句能不能发
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/api/base-score-levels') {
      json(res, 200, { code: 0, data: { levels: MOCK_BASE_SCORE_LEVELS } });
      return;
    }
    if (req.method === 'GET' && path === '/api/rooms') {
      json(res, 200, { code: 0, data: rooms() });
      return;
    }
    json(res, 404, { error: `mock 没有这条路由：${req.method} ${path}` });
  });
}
```

并把上面的 `json()` 换成带 CORS 头的版本（**两者共用同一份头**，免得 OPRIONS 与真响应说法不一致）：

```ts
/**
 * CORS 响应头（mock 只服务本机开发，放开 origin 是**刻意的**）。
 * ⚠️ `allow-headers` 必须含 `authorization`：客户端的每个 REST 请求都带 Bearer。
 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
} as const;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
```

- [ ] **Step 4: 把 REST 面接到 `index.ts`，并让房间表说真话**

**(a)** `tools/mock-server/src/index.ts` 的 import 段加：

```ts
import { installRest, type RoomInfoLike } from './rest';
```

**(b)** `GameEntry` 接口加一个字段（记住 `room.match` 带来的底分）：

```ts
interface GameEntry {
  game: ScriptedGame;
  seats: Map<string, number>;   // userId → seat
  /** 这次匹配带来的底分（协议② 的 `room.match.payload.baseScore`）—— `GET /api/rooms` 报真值要用它。 */
  baseScore: number;
}
```

**(c)** `room.match` 分支改成读 payload 并记下底分：

```ts
      case 'room.match': {
        const game = new ScriptedGame([userId, ...FILLER_IDS]);
        const seats = new Map<string, number>([[userId, 0]]);
        // 协议②（片规格 §2.4）：`room.match` 的 `baseScore` **必填**，且由客户端从服务端
        // 下发的档位表里选。mock **不校验**它的合法性（规则权威在 room-service），
        // 只**记住**它 —— `GET /api/rooms` 要如实把它报回去。
        games.set(MOCK_ROOM_CODE, { game, seats, baseScore: msg.payload.baseScore });
        ackOk(ack, { queued: true });
        send(socket, { type: 'room.matched', version: 0, payload: { roomCode: MOCK_ROOM_CODE, seat: 0 } });
        return;
      }
```

**(d)** 在 `const io = new Server(PORT, { cors: { origin: '*' } });` **之后**装上 REST：

```ts
/**
 * mock 的 **REST 面**（片② 客户端新增）：`GET /api/base-score-levels` 与 `GET /api/rooms`。
 *
 * ⚠️ **必须与 socket.io 共用同一台 `http.Server`**（不是另起一台、也不是两个端口）：客户端把 REST 与
 * socket.io 当作**同一个 origin**（`config.ts` 的 `apiBase` 与 `wsEndpoint`）—— 分开两台就与真形态不符。
 * ⚠️ 但**造法**要用裸 `http.createServer()` + `new Server(httpServer, …)`，**不是** `new Server(PORT)`
 * —— 理由见 `rest.ts` 头注释里那段执行期订正（端口形态自带一个恒 404 监听者，会先写掉响应）。
 * ⚠️ 房间表**现取**（`rooms()` 是闭包，不是快照）⇒ 房间里的人变了，`GET /api/rooms` 立刻跟着变。
 */
function liveRooms(): RoomInfoLike[] {
  return [...games.entries()].map(([code, entry]) => ({
    code,
    mode: 'random',
    status: 'playing',
    playerCount: entry.seats.size,
    maxPlayers: 3,
    baseScore: entry.baseScore,
  }));
}
installRest(io.httpServer, liveRooms);
```

> ⚠️ **类型**：`io.httpServer` 的静态类型是 `engine.io` 的 `TServerInstance`
> （`http.Server | HTTPSServer | Http2SecureServer | Http2Server` 联合），而**运行时**由
> `new Server(PORT, …)` 走的是 `http.createServer()` ⇒ 恒为 `http.Server`。
> 直接传**应当**通过（`on` 是方法，参数按双变处理）。**若 `tsc` 仍报不兼容**：
> 在**这一处**写 `installRest(io.httpServer as unknown as RequestHost, liveRooms)`，
> 并把上面那句「运行时恒为 http.Server」原样写成行内注释。
> 🔴 **不要**为了类型顺手把 `RequestHost` 放宽成 `any` —— 那会让「只挂一个 request 监听」
> 这个唯一的约束消失。

**(e)** 把文件顶部的「用法」注释里加一行：

```ts
 * 现在它还带**两条只读 REST**（`GET /api/base-score-levels` · `GET /api/rooms`），
 * 与 WS 共用同一个端口 —— 客户端不需要为 mock 配第二套端点。
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/mock-server exec vitest run`

Expected: **PASS** —— 新增 **6 条** + 既有的 `settlement.test.ts` 全绿。

- [ ] **Step 6: 跑 mock 的类型闸与构建（它在 `pnpm run ci` 的 lint/build 两个阶段里）**

Run: `pnpm --filter @fight-the-landlord/mock-server run lint && pnpm --filter @fight-the-landlord/mock-server run build`

Expected: 两条都**零输出退出 0**（`tsc --noEmit` ×2 + `tsc` 构建）。

- [ ] **Step 7: 让客户端**真的**够得着它 —— 补 `.env.mock`，然后实跑验证**

> 🔴 **这一步是本任务存在的理由**。没有它，Task 7 交付的 REST 面在浏览器里**一条都到不了**：
> `.env.mock` 把 `VITE_API_BASE` 设成 `/api`（相对 ⇒ 同源 ⇒ 走 Vite 代理），而
> `apps/client/vite.config.ts:124`/`:143` **写死** `/api → http://localhost:3000`（真网关），
> **没有任何 mock 分支** ⇒ mock 模式下大厅的档位区照旧是空的。

**(a)** 把 `apps/client/.env.mock` 里的 `VITE_API_BASE=/api` 逐字改成：

```
VITE_API_BASE=http://localhost:3400/api
```

并在该文件的注释里补一句「mock 自带 REST 面 ⇒ 指到它自己，别走 Vite 代理到真网关」
（该文件现有的注释按原样保留）。

**(b)** 先确认三条请求从 mock 自己的端口出得来：

```bash
pnpm --filter @fight-the-landlord/mock-server run build
PORT=3400 node tools/mock-server/dist/index.js &
sleep 1
curl -s http://127.0.0.1:3400/api/base-score-levels
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3400/api/nope
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS http://127.0.0.1:3400/api/rooms
kill %1
```

Expected: 第一条打印 `{"code":0,"data":{"levels":[{"name":"休闲场","baseScore":15}, …]}}`；第二条 `404`；第三条 `204`。

**(c)** 🔴 **再在真浏览器里验一次** —— 这是「对着 mock 跑通」的**唯一**证据；
**curl 通 ≠ 浏览器通**（CORS / 预检这类东西**只在浏览器里才存在**）：

```bash
# 🔴🔴 **不要 `rm -f`**（初稿就是这么写的，执行期差点毁掉用户的 App LAN 配置）：
# `apps/client/.env.development.local` 可能**本来就有**（本仓当前就有一份 App 真机调试用的
# 局域网地址覆盖，`git check-ignore` 说它被忽略 ⇒ **删了就没了**）。必须先备份、逐字节还原：
cp -n apps/client/.env.development.local /tmp/env.development.local.bak 2>/dev/null || true
if [ -f apps/client/.env.development.local ]; then
  cp apps/client/.env.development.local /tmp/env.development.local.bak
fi
cp apps/client/.env.mock apps/client/.env.development.local
# 只起 mock，**不要**起那 8 个容器：
PORT=3400 node tools/mock-server/dist/index.js &
node scripts/browser-e2e.mjs --keep-open
```

⚠️ **预期探针会在最早的一处 REST 写接口上红** —— 复核订正（2026-09-27）：**实测红在 `[03]`（注册）**，
不是初稿预测的「匹配」那一步（注册/登录同样是 mock 没有的写接口）。mock 只有两条只读 GET，
本步**不看探针全绿**，只留证据。

要看的只有一件事：**大厅的底分档位区渲染出了 4 张卡**。`--keep-open` 会把截图落到
系统临时目录（脚本退出时打印路径），**人眼看那 4 张卡**；或另开一个终端量：

```bash
node scripts/measure-table.mjs --cdp-port 9333 --selector .lobby__level   # 名字带 table 但通用
```

拿不到就说明 `.env.mock` 那步没生效、或 CORS/预检没通 —— **别去改探针**，那正是本步要暴露的东西。

验完**务必还原**：

```bash
# 有备份就逐字节还原并自证；**没有**备份（本来就不存在）才删
if [ -f /tmp/env.development.local.bak ]; then
  cp /tmp/env.development.local.bak apps/client/.env.development.local
  cmp /tmp/env.development.local.bak apps/client/.env.development.local && echo "还原逐字节一致 ✓"
else
  rm -f apps/client/.env.development.local
fi
```

⚠️ **vite 只在启动时读 `.env.*`** ⇒ 换了 env 之后**必须重启 dev server**，
否则你会在「客户端仍指向真网关」的世界里得出结论 —— **这是本步最容易假绿的地方**。

- [ ] **Step 8: 提交**

```bash
git add tools/mock-server/src/rest.ts tools/mock-server/src/index.ts tools/mock-server/test/rest.test.ts apps/client/.env.mock
git commit -m "feat(mock): 补 REST 面（档位表 + 房间列表 + CORS），对着 mock 也能进大厅

复核订正：只补 mock 侧不够 —— .env.mock 的 VITE_API_BASE 原先指 /api，
而 vite 代理写死到真网关 ⇒ 浏览器里一条都到不了。补 CORS/预检 + 指到 3400。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 文档对账（客户端接入清单）

**Files:**
- Modify: `docs/client-protocol.md`

> ⚠️ `docs/client-protocol.md` 是**给人读的**接入清单（独立开发客户端的人照着它写）。
> `protocol-doc-sync.test.ts` 只对账**WS 消息名与错误码**，**不含** REST 表 ⇒ 这张表**靠人守**
> —— 而「人读的文档一旦与代码脱节，就变成会撒谎的第二真源」正是那份测试头注释的原话。

- [ ] **Step 1: 改 §2 的标题与表格**

把 `## 2. REST：八条` 逐字改成 `## 2. REST：九条`，并在表格**末尾**（第 8 行 `base-score-levels` 之后）追加一行：

```markdown
| 9 | `GET /api/users/me` | ✅ Bearer | — | `{ id, phone, nickname, status? }`（`nickname` **可为 `null`**） |
```

- [ ] **Step 2: 在 §2 的表格下方补一句用途说明**

在紧跟表格的那段说明里追加：

```markdown
🔴 **第 9 条的用途只有展示**：顶栏 / 开始游戏页要显示「昵称」，而登录响应里的
`user.nickname` 只在登录那一刻到手、刷新就没了（令牌存储只存三项）。
`nickname` 可以是 `null`（服务端明确说的「这人没有昵称」）⇒ 消费点必须回落，
**不要**据此判空或重试。
```

- [ ] **Step 3: 跑对账闸确认没打坏它**

Run: `pnpm --filter @fight-the-landlord/client exec vitest run test/protocol-doc-sync.test.ts`

Expected: **PASS**（该闸只解析 WS 消息表与错误码表；本步动的是 §2 的 REST 表）。

- [ ] **Step 4: 提交**

```bash
git add docs/client-protocol.md
git commit -m "docs(protocol): 客户端接入清单补第 9 条 REST（GET /api/users/me）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 全量门禁 + 真栈验收 + 交接

**Files:**
- Modify: `docs/superpowers/plans/2026-09-27-app-ui-rework-handoff.md`（或另起一份新的交接）

- [ ] **Step 1: 全量门禁（六阶段）**

Run: `pnpm run ci`

Expected: 六阶段全过，最后打印 `=== [ci] 六阶段全部通过 ===`。

⚠️ **已知假红**（见记忆 `ci-flake-known`，**先单跑确认，别「重跑直到绿」**）：
- `game-service` 的 `game.controller`（同包两测试绑真端口撞车）；
- `user-service` 的 `internal-token`（Windows 动态端口 ∩ Node fetch 封禁端口表）；
- `packages/shared` 的覆盖率/构建类判据在**连跑**里红、**单跑**绿 ⇒ 记成「**未复现**」，**不许写成「通过」**。

- [ ] **Step 2: 真栈验收（人眼 + 真数据）**

前置：`docker compose up -d --build`（本片**改了网关源码 + 客户端源码**，必须重建 —— 宿主 dist 挂载已删）。
⚠️ 若跑过全套 conformance，先 `docker compose up -d --force-recreate` 再继续（本机跑全套会把栈改坏）。

**先跑一条命令把「网关**不**再暴露这条路由」钉在真栈上**（这是 pre-flight 那个坑的**收尾判据** ——
路由的去留必须由**真栈**说话，不能靠读源码）。
⚠️ **订正（2026-09-27 终态）**：初稿这里钉的是「**有**这条路由」（Task 2 补的 `GET /api/users/me`），
而 **Task 2R 已把它撤销**（经网关恒 401，理由见交接文档 §4）⇒ 预期**翻转为 404**：

```bash
# ⚠️ 复核订正（2026-09-27 执行期）：初稿的 `1$(date +%s | tail -c 10)` 只有 **10 位**，
# 而服务端要求手机号 ≥ 11 位 ⇒ 会拿到 `400 {"message":["phone must be longer than or equal to 11 characters"]}`。
# `date +%s` 本身就是 10 位，直接拼 `1` 即 11 位。
# 拿一把真 token（注册一个新号）
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/register \
  -H 'content-type: application/json' \
  -d "{\"phone\":\"1$(date +%s)\",\"password\":\"verify-pass\"}" \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
# ① 有令牌 ⇒ 404（**这条路由在 Task 2R 被撤销**，见交接文档 §4 —— 拿到 200/401 说明它又回来了）
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/users/me
# ② 匿名 ⇒ 404（路由不存在，鉴权中间件也轮不到它）
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/users/me
```

Expected: ① `404` + `{"code":10001,"message":"Cannot GET /api/users/me","data":null}`（网关的
`NotFoundEnvelopeFilter` 把「路由不存在」渲染成 §11.1 信封）；② `404`。

用真浏览器打开 `http://localhost:5173/`（或线上域名），注册一个新号，逐项截图：

1. **大厅**：与 `.tmp_ref/app-ui-rework/01-lobby.png` **并排**看 —— 顶栏（头像+昵称+货币占位 `—`+退出）· 左玩法竖滚（1 项，**选中态**）· 右底分横滚（4 档，来自服务端）。
   - 点玩法卡 ⇒ **不跳页**（这一条人眼也要看一遍）。
   - 点一张底分卡 ⇒ 进开始游戏页。
2. **开始游戏页**：与 `02-start-game.png` 并排 —— 左上「返回大厅」· 左下头像+昵称+货币占位 · 中央「场次名 + 底分 N」+「开始游戏」· 「好友房」。
   - ⚠️ 场次名必须**逐字等于**大厅那张卡上的名字（那是档位表来的，不是编的）。
3. **好友房弹层**：点开后创建房间 / 输房号 / 房间列表三件都在，关掉后**都不在**。

⚠️ **`docker compose exec mysql` 改中文必须带 `--default-character-set=utf8mb4`**（否则写进去是乱码，接口回 `ä¼‘é—²åœº`）；改完用 `HEX(name)` 自证。

- [ ] **Step 3: 更新交接文档**

把 `docs/superpowers/plans/2026-09-27-app-ui-rework-handoff.md` 改成「四片已完成」的形态：
- 新增一行：**片② 客户端**（提交号 · 交付：大厅页 + 开始游戏页 + 探针 4 处 + mock REST 两条）；
- 🔴 **把探针的实测条数写进去**（Task 6 Step 3 的真实输出）—— 别沿用旧文档那个数字；
- 把「下一步」改成 **片③ 牌桌**（视觉语言照抄 §5.2.1；D16 的四个恒灰按钮收进弹层；
  素材槽的接通 +「每页可选底纹」机制在那一并评估）；
- **如实保留**文末的已知缺口（见下）。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-09-27-app-ui-rework-handoff.md
git commit -m "docs(plan): Plan B 收口 —— 交接文档改成四片已完成

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 自检（写完计划后跑一遍）

**① 规格覆盖**：逐条对照 `2026-09-27-lobby-start-game-design.md`

| 规格条目 | 落在哪个任务 |
|---|---|
| §3 大厅形态（顶栏左/右 · 左玩法竖滚 · 右底分横滚） | Task 4 |
| §3 裁决一（点玩法=选中、点底分=进入） | Task 4（实现）+ Task 6（探针） |
| §3 两页接口（`activeMode` / `selectedBaseScore` / `baseScoreLevels`） | Task 1 + Task 4 + Task 5 |
| §4 开始游戏页（返回大厅逐字 · 左下信息条 · 中央场次名+底分 · 开始游戏 · 好友房） | Task 5 |
| §4 裁决二（好友房=弹层） | Task 5 |
| §5 判据记账（7 行 + 反例纪律） | 计划 §1 全表 + Task 4/5/6 的逐条说明 |
| §6 验收（机械 / 真浏览器 / 真栈 / 人眼 / 视觉） | Task 6 Step 3 + Task 9 |
| 交接文档三件遗留：① `dispatchRestFailure` 缺口 → **Task 4**（`loadLevels` 的 `dispatchRestFailure` 分支 + 一条 10004 判据）；② mock 缺 REST → **Task 7**；③ `client-protocol.md` 已补 → **本片又因 `users/me` 变成九条 → Task 8** | 全覆盖 |

**② 占位符扫描**：本计划没有 TBD / TODO / 「类似 Task N」/「加上适当的错误处理」。每个改代码的步骤都给了完整代码。

**③ 命名一致性**（跨任务核对过）：

| 名字 | 定义处 | 使用处 |
|---|---|---|
| `BaseScoreLevel` | Task 1 Step 3（`net/rest.ts`） | Task 1 Step 4（store 的 state/getter） |
| `baseScoreLevels` / `setBaseScoreLevels` | Task 1 Step 4 | Task 4（大厅）、Task 5（开始游戏页读到的是 `selectedLevelName`） |
| `selectedBaseScore` / `setSelectedBaseScore` | Task 1 Step 4 | Task 4（写）· Task 5（读） |
| `selectedLevelName` | Task 1 Step 4（getter） | Task 5（`.game__scene-name`） |
| `UserProfile` / `me()` | Task 2 Step 3 | Task 2 Step 4（`loadProfile`） |
| `nickname` / `phone` / `displayName` / `loadProfile()` | Task 2 Step 4 | Task 3（`PlayerChip` 吃 `name` prop）· Task 4/5（传 `auth.displayName`） |
| `.lobby__level` / `.lobby__level-name` / `.game__friends-open` / `.game__scene` | Task 4 / Task 5 | Task 6（探针）· Task 4/5 的用例 |
| `openFriends(wrapper)` | Task 5 ①（`lobby-ux.test.ts`） | Task 5 ① 的 `auth-ui-wiring.test.ts`（照抄同一实现） |
| `stubRoomsFetch()` | Task 5 ②（`auth-ui-wiring.test.ts`） | Task 5 ⑦（`lobby-ux.test.ts` 的 R658/R760 组用同名的那个） |
| `installRest(host, rooms)` / `MOCK_BASE_SCORE_LEVELS` / `RoomInfoLike` / `CORS_HEADERS` | Task 7 Step 3 | Task 7 Step 4（`index.ts`）· Task 7 Step 1 的 6 条用例 |
| `GET /api/users/me` → `GatewayController.getMe` | Task 2 Step 1（网关） | Task 2 Step 4（`rest.me()` 打的就是它）· Task 9 Step 2 的真栈 curl（有令牌 200 / 匿名 401） |

---

## 已知缺口（**如实记，别写成「通过」**）

1. 🔴 **探针**：本片改了它 **4 处**（§0），**必须真跑**。若 Task 6 Step 3 只跑了 `gate`、没跑 `--scenario full`，交接文档里要写「`full` 未跑」，不能写「探针全绿」。
2. **mock 的写接口没补**：`GET /api/base-score-levels` 与 `GET /api/rooms` **可达且已实跑验过**
   （Task 7 Step 7 —— 含 CORS/预检与 `.env.mock`），但 `POST /api/rooms`（建房）与
   `POST /api/rooms/:code/join`（占座）**仍然不存在** ⇒ 对着**纯 mock** 时「好友房」的两条动作
   跑不通（列表能出来、点进去 404）。用户裁决的范围就是「levels + rooms」两条只读 GET。
3. **「改了即生效」没有永久闸**：规格 §2.5 要求「改 DB 一行 → 不重启 → 接口拿到新值」，计划 A 只做过**一次性人工验证**（§6.1 ②），**没有 conformance 切片**。本片照旧不动 conformance（那是服务端性质、且属 Plan A 的遗留）⇒ 这条性质**目前只靠人记着**。
4. **`$ftl-art-*` 素材槽仍全是 `none`**：顶栏货币图标与头像走 `<image src="/static/ui/…">`（与登录页样板同形），**不是**槽位。接通七个槽是片③ 的事（见 §2 的「明确不做」）。
5. **`ui/` 预算未变**：本片没有新增素材文件（`dou.png` / `default.png` 片① 已入库），`asset-budget.test.ts` 的 1536 KiB 不动。
6. **`docs/design.md` 改了 8 行（7 增 1 删）**，**不是**「零改动」（初稿那句「零改动 / `/api/users/*` 已在 §7.1 的代理路由里」是**计划前提被推翻前**的旧结论）——§7.1 的代理路由那句按**终态**订正为「网关**不暴露** `/api/users/*`」（同一句话先后订正两次：通配 `/api/users/*` → 「暴露 `GET /api/users/me` 一条」→ **撤销**，见交接文档 §4）；§12 的前端约束不变。

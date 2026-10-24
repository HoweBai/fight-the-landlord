# 门户重做（片③）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把大厅拆成两屏 —— **大厅只选玩法**、**玩法页展示房间列表与开局按钮**；登录页只修按钮排布。

**Architecture:** 新增第 4 个 uni 页面 `pages/game/game.vue`（RouteName `game`），把 `lobby.vue` 的开局区**整体搬过去并改名 `game__*`**；跨页的「当前玩法」放进 `game` store（照 `rematchPending` 的成例：**先写状态、再 navigate**）。**纯客户端**，不动协议。

**Tech Stack:** TypeScript 5.7 · Vue 3 + uni-app（H5 + App）· vitest + jsdom · pnpm + turbo

**Spec:** `docs/superpowers/specs/2026-09-22-portal-rework-design.md`（v1，R744–R762，已过两轮审查）

---

## Global Constraints

> 逐字取自 spec §1.1（R756）。适用于**每一个** task。

1. **范围 = H5 + App**（R701）。小程序端排除在**一切设计/开发/测试**之外。
2. **探针**：本片是它的**首次改动**（spec §6.1）。改动**必须成对**，且**插入点在 `matchAndWaitDeal` 内部**（R750）。
3. **判据只增不减**：片② 收口的 8 文件表合计 **67**，逐文件核对：

   | 文件 | `it(` | `it.each(` | 小计 |
   |---|---|---|---|
   | `auth-flow` | 10 | 0 | 10 |
   | `auth-ui-wiring` | 13 | 0 | 13 |
   | `lobby-ux` | 18 | 0 | 18 |
   | `ui-flow` | 1 | 0 | 1 |
   | `table-bid-ui` | 6 | 1 | 7 |
   | `table-play-ui` | 8 | 0 | 8 |
   | `table-ended-ui` | 3 | 0 | 3 |
   | `table-settlement-ui` | 6 | 1 | 7 |
   | **合计** | **65** | **2** | **67** |

4. **样式只用令牌**（`src/uni.scss` 的 `$ftl-*`）；单位 `px`（R711）；发丝线 `$ftl-hairline`（R714）。
5. **`uni.xxx()` 必须是直接成员调用**；**不得用 `document` / `window` / `fetch`**；不得 `typeof import.meta`。
6. **scoped 样式只到子组件根节点**：抽进子组件的元素**必须自持样式**。
7. **模板注释只能放单根元素内部**（放根前 ⇒ 组件变多根、`classes()` 静默返回 `[]`）。
8. **`mount()` 看不见样式** ⇒ 观感类改动只能用**产物 CSS / 真浏览器走查**证明，**不要造假判据**。
9. **门禁口径**：`turbo run build --force` 对 client **只出 h5** ⇒ App 必须单独跑 `build:app`（R669）；探针**独占**跑。
10. **证据卫生（R682）**：门禁日志的 mtime 必须**晚于**最后一次改动/commit。
11. **提交**：每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。**禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

### 不许破坏的锚点

**探针 9 个**（实测）：`.login__actions .btn` · `.login__field input` · **`.lobby__match .btn`（本片改名 ⇒ 探针成对改）** · `.table__bar .btn` · `.table__bid-grab` · `.table__pass` · `.table__play` · `.table__me .card` · `.table__notice`

**测试锚点（本片会搬走并改名）**：`.lobby__start` / `__match` / `__matching` / `__create` / `__create-room` / `__join` / `__code` / `__error` / `__rooms*` / `__list` / `__item(--clickable)` / `__meta` / `__status` / `__count` / `__empty` → 全部 `game__*`

**留下不动的**：`.lobby__header` / `__title` / `__me` / `__modes` / `__modes-title` / `__mode-list` / `__mode` / `__mode-name` / `__mode-tagline` / `__mode-text` / `__notice` · `.login__*` · `.table__*`

### 共享验证命令

```bash
pnpm --filter @fight-the-landlord/client test          # 单测
pnpm --filter @fight-the-landlord/client test -- lobby-ux
pnpm --filter @fight-the-landlord/client lint          # = vue-tsc --noEmit
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario full
pnpm run ci
```

> ⚠️ **本机探针的三条绕法**：自己起 `pnpm dev:h5` + `--no-server`；
> `CHROME_BIN='C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'`；
> `--cdp-port 18800`（默认 9333 与 9443 落在 Windows 保留区间）。
> ⚠️ **收尾按 PID 杀整棵树**（`taskkill //F //PID <5173 的 PID> //T`），**不要**杀 pnpm 包装（片① F5）。
> ⚠️ **走查完再杀** —— 片② 有过「先杀服务再告诉用户打开地址」的事故。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `apps/client/src/router.ts` | `RouteName` / `routes` / `PAGE_URLS` 加 `game` | Task 1 |
| `apps/client/src/pages.json` | `pages` 加第 4 页 | Task 1 |
| `apps/client/src/pages/game/game.vue` | **新增**：玩法页（先骨架、Task 3 填内容） | Task 1 / 3 |
| `apps/client/test/page-stack.test.ts` | 页面栈字面数组 → 四页 | Task 1 |
| `apps/client/test/table-hud.test.ts` | `SINGLE_ROOT_PAGES` 加人 | Task 1 |
| `apps/client/test/landscape-canvas.test.ts` | 「三页」数组加人 | Task 1 |
| `apps/client/test/ui-tokens.test.ts` | 扫描器自证 required 清单 + 注释 | Task 1 |
| `apps/client/src/components/SessionNotice.vue` | **新增**：会话提示的共用件（R751，大厅与玩法页共用） | Task 3 |
| `apps/client/src/gameModes.ts` | **新增**：`GAME_MODES` 的单一真源（两页共用） | Task 2 |
| `apps/client/src/stores/game.ts` | 加 `activeMode`（跨页载体） | Task 2 |
| `apps/client/src/pages/lobby/lobby.vue` | 点卡即进 · 删 R652 残留 · 删 UUID · **移除开局区** | Task 2 / 3 |
| `apps/client/src/pages/table/table.vue` | `onAgain` → `navigate('game')`（R760） | Task 3 |
| `apps/client/test/{lobby-ux,auth-ui-wiring,lobby-modes,settlement-rematch}.test.ts` | 断言迁移 | Task 4 |
| `scripts/browser-e2e.mjs` | **首次改动**：`matchAndWaitDeal` 插一步 + 选择器 | Task 4 |
| `apps/client/src/pages/login/login.vue` | 按钮排布 | Task 5 |

---

## Task 1: 页面栈四页（**先跑特征搜，再动 7 处**）

**Files:**
- Modify: `apps/client/src/router.ts` · `apps/client/src/pages.json`
- Create: `apps/client/src/pages/game/game.vue`
- Modify: `apps/client/test/page-stack.test.ts` · `table-hud.test.ts` · `landscape-canvas.test.ts` · `ui-tokens.test.ts`

**Interfaces:**
- Produces: `RouteName` 含 `'game'`；`pageUrl('game') === '/pages/game/game'`；`GamePage` 组件（根 class `.game`）

---

- [ ] **Step 1: 先跑特征搜（R759 —— 不要靠记忆列）**

```bash
cd /d/Code/pokergame/apps/client
# ① 页面路径字面量出现的所有地方（清单藏在这里）
grep -rln "src/pages/\|pages/[a-z]*/[a-z]*\.vue'" test/*.ts
# ② **按 RouteName 索引的表** —— 这一类加页面时会让 vue-tsc 直接失败（TS7053）。
#    ⚠️ 起草时**漏了这条**，是实施时抓出来的（Task 1 实测 7 处 → 8 处）。
grep -rn "Record<RouteName\|PAGES = {" test/*.ts src/
```

**把输出抄进本 Task 的 commit 信息**。预期命中：`page-stack`（**四处**）· `table-hud`（`SINGLE_ROOT_PAGES`）·
`landscape-canvas`（「三页」数组）· `ui-tokens`（扫描器自证）· **`ui-flow`（`PAGES` 表，按 `RouteName` 索引）**。

⚠️ **若多出别的地方** —— 那说明 §6.3 那张表又漏了。**照做**（把新页加进去是对的），
并在报告里记下来（**不要**停下来等我）。

- [ ] **Step 2: 确认基线是绿的**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Test Files|Tests "
pnpm --filter @fight-the-landlord/client lint
```

Expected: `493 passed + 2 skipped`、lint 干净。**若这里就是红的，先停下来修基线。**

- [ ] **Step 3: `router.ts` 加 `game`**

```ts
export type RouteName = 'login' | 'lobby' | 'game' | 'table';

export const routes: readonly RouteName[] = ['login', 'lobby', 'game', 'table'] as const;

export const PAGE_URLS: Readonly<Record<RouteName, string>> = {
  login: '/pages/login/login',
  lobby: '/pages/lobby/lobby',
  game: '/pages/game/game',
  table: '/pages/table/table',
};
```

⚠️ **顺序是判据的一部分**（`page-stack` 断言 `routes` 与 `pages.json` 逐条一致）。

- [ ] **Step 4: `pages.json` 加第 4 页**

在 `pages` 数组的 `pages/lobby/lobby` 之后、`pages/table/table` 之前插入：

```json
    {
      "path": "pages/game/game",
      "style": {
        "navigationBarTitleText": "玩法"
      }
    },
```

⚠️ **`globalStyle.navigationStyle: 'custom'` 不动**（R720）—— 新页自动继承。

- [ ] **Step 5: 新页骨架（够本 Task 的判据用，内容在 Task 3 填）**

创建 `apps/client/src/pages/game/game.vue`：

```vue
<script setup lang="ts">
/**
 * 玩法页（片③ / spec §4）：**选完玩法之后进来的那一屏**。
 *
 * 职责：房间列表 + 开局相关的按钮（随机匹配 / 创建房间 / 房号加入）。
 * 它**不是**大厅 —— 大厅只负责呈现与选择玩法（spec §3）。
 *
 * ⚠️ **本页的根 class 是 `.game`**：`table-hud` 的单根闸与 `landscape-canvas` 的
 * 「每个页面都套 `<LandscapeStage>`」都按它判 ⇒ 改名会同时断两条判据。
 *
 * ⚠️ **跨页状态**：玩法 id 从 `game` store 读（`store.activeMode`），**不得**在本页写死
 * 「斗地主」字面量 —— 那是 R752 的判据。
 */
import { usePageAlignment } from '../../composables/usePageAlignment';
import { useAuthStore } from '../../stores/auth';
import LandscapeStage from '../../components/LandscapeStage.vue';

const auth = useAuthStore();
/** 页面栈（Task 3）：挂载时对齐一次（`auth.page` 才是唯一真源）。 */
usePageAlignment('game');
</script>

<template>
  <LandscapeStage>
    <view class="game">
      <!--
        ⚠️ **本注释必须在根元素内部**：模板注释放在根元素**之前**会让整页变成**多根**页面，
        `@vue/test-utils` 的 `wrapper.classes()` 于是静默返回 `[]`（`table-hud` 的单根闸盯着）。
      -->
      <view class="game__bar">
        <button type="button" class="btn btn--small" @click="auth.navigate('lobby')">返回大厅</button>
      </view>
    </view>
  </LandscapeStage>
</template>

<style scoped lang="scss">
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
.btn {
  @include ftl-btn;
}
.btn--small {
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  font-size: $ftl-font-sm;
}
.btn--primary {
  border-color: $ftl-btn-primary-bg;
  /* ⚠️ 这一行**必须逐字保留** —— `table-bid-bottom.test.ts` 的主按钮闸按字面的 `background:` 匹配。 */
  background: $ftl-btn-primary-bg;
  background-image: url($ftl-btn-plate-primary);
  background-size: 100% 100%;
  color: $ftl-color-on-primary;
}
</style>
```

⚠️ **本步刻意不引入 `useGameStore`** —— 骨架里还没有读它的地方，而 `noUnusedLocals` 会把
未使用的 import 判成编译错误。**不要**为了「以后要用」先 import 进来，也不要为消警告写假用途；
Task 3 Step 6 真的读 `store.activeMode` 时再加。

- [ ] **Step 6: `page-stack.test.ts` 的页面栈数组 → 四页（R755：该红，成对改）**

```ts
  it('pages.json 的页面栈顺序 = 登录 → 大厅 → 玩法 → 牌桌（首个 = 冷启动入口）', () => {
    expect(pagesJson.pages.map((p) => p.path)).toEqual([
      'pages/login/login',
      'pages/lobby/lobby',
      'pages/game/game',
      'pages/table/table',
    ]);
    expect(pagesJson.pages[0]!.style?.navigationBarTitleText).toBe('登录');
  });
```

同文件另外两处也要跟着改：

```ts
// ① import 段
import GamePage from '../src/pages/game/game.vue';
// ② mountPage 的表
function mountPage(page: 'login' | 'lobby' | 'game' | 'table') {
  const pages = { login: LoginPage, lobby: LobbyPage, game: GamePage, table: TablePage } as const;
  // …
}
```

⚠️ **`page-stack` 里其余 13 条断言一条都不能减** —— 迁移时逐条读，只改「涉及第 4 页」的部分。

- [ ] **Step 7: `table-hud.test.ts` 的 `SINGLE_ROOT_PAGES` 加人（R754）**

```ts
  const SINGLE_ROOT_PAGES: Array<{ name: string; comp: Component; ownRoot: string }> = [
    { name: 'lobby.vue', comp: LobbyPage, ownRoot: 'lobby' },
    { name: 'login.vue', comp: LoginPage, ownRoot: 'login' },
    { name: 'game.vue', comp: GamePage, ownRoot: 'game' },
    // ⚠️ `table.vue` **不在这里** —— 它裸挂载会抛「会话尚未建立：请先调用 startGameSession()」
  ];
```

```ts
import GamePage from '../src/pages/game/game.vue';
```

- [ ] **Step 8: `landscape-canvas.test.ts` 的「三页」数组加人（R757）**

```ts
  it('四页都用 <LandscapeStage> 包住根内容', () => {
    for (const p of [
      'src/pages/login/login.vue',
      'src/pages/lobby/lobby.vue',
      'src/pages/game/game.vue',
      'src/pages/table/table.vue',
    ]) {
      // …（循环体一字不改）
    }
  });
```

⚠️ **标题里的「三页」也要改成「四页」** —— 不然标题在说谎（这是注释类过期，不是判据）。

- [ ] **Step 9: `ui-tokens.test.ts` 的扫描器自证加人（R758）**

```ts
    for (const required of [
      'src/App.vue',
      'src/components/Card.vue',
      'src/components/Hand.vue',
      'src/components/Settlement.vue',
      'src/pages/login/login.vue',
      'src/pages/lobby/lobby.vue',
      'src/pages/game/game.vue',
      'src/pages/table/table.vue',
    ]) {
```

⚠️ **同一段上面那句注释**「7 个业务 .vue = 3 个页面」要改成「8 个业务 .vue = 4 个页面」。`toBeGreaterThanOrEqual(7)` **不改**（它是下限，本就该容得下新页）。

- [ ] **Step 10: 跑测试，确认绿**

```bash
pnpm --filter @fight-the-landlord/client test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Test Files|Tests |FAIL"
pnpm --filter @fight-the-landlord/client lint
```

Expected: `passed ≥ 493`（新增的 `it.each` 展开会让条数上涨）、lint 干净。
⚠️ 若 `page-stack` 报「`usePageAlignment('game')` 不在 `game.vue` 里」—— 回去看 Step 5。

- [ ] **Step 11: 8 文件基线核对（不得减少）**

```bash
cd /d/Code/pokergame/apps/client/test
for f in auth-flow auth-ui-wiring lobby-ux ui-flow table-bid-ui table-play-ui table-ended-ui table-settlement-ui; do
  printf "  %-22s %s\n" "$f" "$(( $(grep -oE '\bit\(' "$f.test.ts" | wc -l) + $(grep -oE '\bit\.each\(' "$f.test.ts" | wc -l) ))"
done
```

Expected: 与 §Global Constraints 的表**逐文件一致**（合计 67）。

- [ ] **Step 12: 构建**

```bash
pnpm --filter @fight-the-landlord/client build:h5 2>&1 | grep -E "DONE|error"
pnpm --filter @fight-the-landlord/client build:app 2>&1 | grep -E "DONE|error"
```

Expected: 两个 `DONE`。

- [ ] **Step 13: Commit**

```bash
git add apps/client/src/router.ts apps/client/src/pages.json apps/client/src/pages/game/game.vue \
        apps/client/test/page-stack.test.ts apps/client/test/table-hud.test.ts \
        apps/client/test/landscape-canvas.test.ts apps/client/test/ui-tokens.test.ts
git commit -F - <<'MSG'
feat(client): 页面栈四页 —— 新增玩法页骨架（片③ Task 1 / R748 R754 R755 R757 R758）

新增 pages/game/game.vue（RouteName `game`，根 class `.game`）。

⚠️ 新增一个 uni 页面实测要动 **7 处**（跑 §6.3 的特征搜数出来的，不靠记忆）：
  router.ts / pages.json / 新页本身 / page-stack 的字面数组 / table-hud 的 SINGLE_ROOT_PAGES /
  landscape-canvas 的「三页都用 LandscapeStage」数组 / ui-tokens 的扫描器自证清单
其中两份「页面清单」藏在互不相干的测试文件里（table-hud 与 landscape-canvas）——
第一轮设计自审只抓到一个，第二轮回核才补齐。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 2: 跨页玩法状态 + 大厅「点卡即进」

**Files:**
- Create: `apps/client/src/gameModes.ts`
- Modify: `apps/client/src/stores/game.ts` · `apps/client/src/pages/lobby/lobby.vue`

**Interfaces:**
- Consumes: `RouteName` 含 `'game'`（Task 1）
- Produces: `GAME_MODES` / `GameModeId`（模块级单一真源）· `store.activeMode` / `store.setActiveMode(id)` · `enterMode(id)` 写状态后 `navigate('game')`

---

- [ ] **Step 1: 写失败的测试**

在 `apps/client/test/lobby-modes.test.ts` 里**改写**那两条 R652 用例（**R746：作废，不是删除**）：

```ts
  it('点玩法卡 ⇒ 写 store 的 activeMode 并进玩法页（R745 一步进入）', async () => {
    const { wrapper, store } = mountLobby();
    await flushPromises();

    // 正对照：点之前没有任何跳转，也不该有 activeMode 之外的副作用
    expect(useAuthStore().page, '未点之前仍在大厅').toBe('lobby');

    await wrapper.find('.lobby__mode').trigger('click');

    expect(store.activeMode, '点了哪张卡就写哪个玩法 id').toBe('doudizhu');
    expect(useAuthStore().page, '一步进入：点卡即到玩法页').toBe('game');
  });

  it('玩法卡不再有「进入」按钮，也没有 R652 的提示文案（R745/R746）', async () => {
    const { wrapper } = mountLobby();
    await flushPromises();
    expect(wrapper.find('.lobby__mode-enter').exists(), 'R745：一步进入 ⇒ 按钮没了').toBe(false);
    expect(wrapper.find('.lobby__hint').exists(), 'R746：R652 的提示随规则作废').toBe(false);
  });
```

⚠️ `mountLobby()` 需要**返回 store** —— 若它现在不返回，加上（`return { wrapper, socket, calls, store }`）。

- [ ] **Step 2: 跑它，确认红**

```bash
pnpm --filter @fight-the-landlord/client test -- lobby-modes 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|→|Tests "
```

Expected: FAIL —— `.lobby__mode` 点下去没有 `navigate`；`.lobby__mode-enter` 仍然存在。

- [ ] **Step 3: 建 `src/gameModes.ts`（两页共用的单一真源）**

```ts
/**
 * 玩法的**单一真源**（片③ spec §3/§4）。
 *
 * ⚠️ 为什么独立成模块：拆页之后**两个页面都要读它**（大厅列出全部、玩法页查选中的那个），
 * 而「同一个数组抄两份」正是本仓反复清掉的形态 —— 加第二个玩法时会只改一处、另一处悄悄过期。
 *
 * ⚠️ 现在**只有**斗地主一个条目，且**不得**为第二个玩法写任何实现/规则：
 * 「第二个玩法开工前才决定路径 A/B」是 roadmap §2.2 的逐字要求。
 * 结构上它是**列表容器**，加第二个玩法时只加数据、不改结构。
 *
 * ⚠️ **图标位是「按玩法查表」而不是一个 `$ftl-art-*` 令牌**（R747）：令牌是**单值**，
 * 装不下第二个玩法。`icon` 给了文件名就渲染 `<image>`、没给就走 CSS 兜底
 * —— 与 `Card.vue` 的 `manifest.json` 同一形态（查得到用图，查不到不白屏）。
 */
export interface GameMode {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  /** `static/ui/` 下的文件名；缺省 ⇒ 走 CSS 兜底（片③ 没有图标素材）。 */
  readonly icon?: string;
}

export const GAME_MODES: readonly GameMode[] = [
  { id: 'doudizhu', name: '斗地主', tagline: '三人一局，比谁先出完手牌' },
] as const;

export type GameModeId = (typeof GAME_MODES)[number]['id'];

/** 缺省玩法（`GAME_MODES` 的第一条）—— 冷启动/换页后没写过 store 时用它。 */
export const DEFAULT_MODE_ID: GameModeId = GAME_MODES[0]!.id;

/** 按 id 查玩法；查不到返回 `undefined`（**不**编一个默认对象）。 */
export function findMode(id: string): GameMode | undefined {
  return GAME_MODES.find((m) => m.id === id);
}
```

- [ ] **Step 4: `stores/game.ts` 加跨页字段（R752）**

在 `rematchPending` 附近加（**照它的成例**）：

```ts
    /**
     * 当前玩法（片③ R752）：**跨页载体** —— 大厅选完写它、玩法页读它。
     *
     * ⚠️ 为什么必须进 store：`pageUrl()` 是**固定映射**、不能带 query（带了会破
     * `page-stack` 的「pageUrl 与 pages.json 逐条一致」判据）⇒ 页面之间只能靠 store 传值。
     * ⚠️ 顺序是**先写它、再 `navigate('game')`**（与 `requestRematch()` 同一纪律）。
     */
    activeMode: DEFAULT_MODE_ID as string,
    setActiveMode(id: string) {
      this.activeMode = id;
    },
```

（`import { DEFAULT_MODE_ID } from '../gameModes';`）

- [ ] **Step 5: 改 `lobby.vue`（点卡即进 + 删 R652 残留 + 删 UUID）**

**script**：删掉 `activeMode` / `modeHint` / `enterMode`，换成：

```ts
/**
 * 进玩法页（片③ R745/R746）：**一步** —— 点卡就写玩法、就跳转。
 *
 * ⚠️ **R652 已作废**（spec §1）：它的理由是「不得把开局区做成『选完玩法才出现』——
 * 那会让 6 条既有路径失效」，那是**测试脆弱性**、不是产品决定。开局区现在**搬到玩法页**了，
 * 前提消失 ⇒ 那条规则与它的提示文案（`modeHint`）一并去掉。
 * ⚠️ **顺序**：先写 store、再 navigate（R752）—— `navigate` 会同步 `uni.reLaunch`，
 * 玩法页挂载时就要能读到玩法 id。
 */
function enterMode(id: string) {
  store.setActiveMode(id);
  auth.navigate('game');
}
```

**template**：玩法卡换成**整体可点**的 `<button>`（R762），删掉 `.lobby__mode-enter` 与 `.lobby__hint`：

```vue
          <button
            v-for="m in GAME_MODES"
            :key="m.id"
            type="button"
            class="lobby__mode"
            @click="enterMode(m.id)"
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
```

**header**：删掉 `{{ auth.userId }}`（R753）：

```vue
        <view class="lobby__me">
          <button type="button" class="btn btn--small" @click="onSignOut">退出</button>
        </view>
```

**import**：`GAME_MODES` 改成从 `../../gameModes` 引入（**删掉本页内的那份字面量**）。

- [ ] **Step 6: 跑 `lobby-modes`，确认绿**

```bash
pnpm --filter @fight-the-landlord/client test -- lobby-modes 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|→|Tests "
```

Expected: PASS。

⚠️ **`.lobby__mode` 从 `<view>` 改成 `<button>` 会连带**：`lobby-modes:114` 断言 `.lobby__mode` 有 1 个 ✓ 不变；但**样式**要跟着改（`button` 有浏览器默认样式）—— 在 style 块里给 `.lobby__mode` 加 `padding: 0; border: none; background: transparent; text-align: left;` 之类的重置。

- [ ] **Step 7: 跑 `lobby-ux` / `auth-ui-wiring`（**这一步**先看它们是否仍然全绿）**

```bash
pnpm --filter @fight-the-landlord/client test -- lobby-ux auth-ui-wiring 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Tests |FAIL"
```

Expected: **仍然全绿** —— 开局区这一步**还没搬**（Task 3 才搬）⇒ 它们的锚点都还在。

- [ ] **Step 8: Commit**

```bash
git add apps/client/src/gameModes.ts apps/client/src/stores/game.ts apps/client/src/pages/lobby/lobby.vue \
        apps/client/test/lobby-modes.test.ts
git commit -F - <<'MSG'
feat(client): 跨页玩法状态 + 大厅「点卡即进」（片③ Task 2 / R745 R746 R752 R762）

- 新增 src/gameModes.ts：GAME_MODES 的**单一真源**（拆页后两页都要读它）
- game store 加 activeMode：跨页载体（pageUrl 不能带 query，只能靠 store）
  顺序是**先写 store、再 navigate**（与 requestRematch 同一纪律）
- 大厅：玩法卡改成整体可点（R762：<button>，Card.vue 已是「button 包富内容」的先例）
  删掉「进入」按钮与 modeHint —— **R652 作废**（它的理由是测试脆弱性，不是产品决定）
- 玩法卡加图标位（R747：按玩法查表 + CSS 兜底，不是一个 $ftl-art-* 令牌）
- 删掉大厅渲染的 auth.userId（R753 —— 那串 UUID 不该给玩家看，且无判据断言它）

lobby-modes 的 3 条 R652 用例**成对迁移**（不是删除）：改成「点卡 ⇒ 到玩法页」的正反两面。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 3: 开局区搬家 + 改名 + 跨页路径 + 断言迁移（**原 Task 3+4 合并**；含功能修复 R760）

**Files:**
- Modify: `apps/client/src/pages/game/game.vue`（填内容）· `apps/client/src/pages/lobby/lobby.vue`（移除开局区）· `apps/client/src/pages/table/table.vue`（`onAgain`）

**Interfaces:**
- Consumes: `store.activeMode`（Task 2）· `store.consumeRematch()`（既有）
- Produces: `.game__*` 全套锚点 · `game.vue` 里 `send('room.match'` **恰好 1 处**

---

- [ ] **Step 1: 把 `lobby.vue` 的整个 `.lobby__start` 块 + 它的 script 搬进 `game.vue`**

**逐字搬，只改 class 前缀**（`lobby__` → `game__`）：`start` `match` `matching` `create` `create-room` `error` `join` `code` `rooms` `rooms-head` `rooms-title` `list` `item` `item--clickable` `meta` `status` `count` `empty`。

script 侧搬：`rooms` · `joinCode` · `matching` · `busy` · `error` · `STATUS_TAG_TYPE` · `loadRooms` · `match` · `unmatch` · `join` · `createAndJoin`。

⚠️ **`notice` 不搬，改成抽共用件 `SessionNotice.vue`**（R751）：notice 是**会话级**的
（连接/系统提示）⇒ 两页都要有，但**不能两页各写一份**（同一段逻辑两处会各自过期，
而且评委按「重复逻辑块」报 Critical）。⇒ 新建 `components/SessionNotice.vue`：

```vue
<script setup lang="ts">
/**
 * 会话提示（片③ R751）：**连接/系统级的提示**，大厅与玩法页**共用一份**。
 *
 * ⚠️ 为什么要抽：notice 是**会话级**的（`room.matched` / `server_rejected` / `connect_error`
 * 都写这条通道）⇒ 拆页之后**两页都要有**，而「同一个渲染写两遍」会各自过期。
 * ⚠️ 本组件**不判断连接状态**（R455 逐字禁止）——它只把会话层给的提示原样渲染出来。
 * ⚠️ `class` 由**宿主**传（`.lobby__notice` / `.game__notice`）：两页各自的 scoped 样式
 * 都能命中外层元素，本组件**不持有任何布局**（不 `@include ftl-btn`、不设颜色）。
 */
import { computed } from 'vue';
import { getGameSession, isGameSessionReady } from '../composables/useGameSession';

/**
 * ⚠️ 会话可能尚未建立（登录前也会渲染）⇒ 用既有的 `isGameSessionReady()` 兜底，
 * 免得 `getGameSession()` 抛错把整页打掉。
 */
const notice = computed(() => (isGameSessionReady() ? getGameSession().notice.value : null));
</script>

<template>
  <!--
    ⚠️ **本注释必须在根元素内部**（多根会让宿主的 `class` 落空、`classes()` 静默返回 `[]`）。
  -->
  <text v-if="notice" class="notice" :class="`notice--${notice.level}`">{{ notice.text }}</text>
</template>
```

⚠️ **注意**：外层 class 由宿主通过 `class="lobby__notice"` 传进来（落到组件根上 ✓ scoped 规则能命中）。
⚠️ 两页的**既有 class**（`.lobby__notice` / 新增 `.game__notice`）都要保留 ——
`lobby-ux` 有断言锚在 `.lobby__notice` 上。

- [ ] **Step 2: `game.vue` 的 `onMounted` 消费「再来一局」意向（R760 —— 功能修复）**

```ts
onMounted(() => {
  loadRooms();
  /**
   * R658「再来一局」：牌桌回**玩法页**前写了**一次性意向**（`store.rematchPending`）——
   * 本页挂载时**消费一次**并复用本页唯一的 `match()`。
   *
   * ⚠️ **片③ R760 改道**：这个消费点原本在**大厅**，而开局区（`match()`）在片③ 搬到了本页。
   * 大厅拆完之后**大厅没有 `match()` 了** ⇒ 不搬家就是「点再来一局回到大厅、什么都不会发生」
   * —— 那是**功能坏掉**，不是判据问题（spec §1.3 H9）。
   */
  if (store.consumeRematch()) void match();
});
```

- [ ] **Step 3: `table.vue` 的 `onAgain` 改去玩法页**

```ts
/**
 * 「再来一局」（➑ / R658 + 片③ R760）：本页只做**两件事** ——
 *  ① 写下**一次性意向**（`store.requestRematch()`）；
 *  ② **回玩法页**（`auth.navigate('game')`）。
 *
 * ⚠️ **为什么不是回大厅**（片③ 改）：`room.match` 随开局区搬去了**玩法页**，
 * 而消费意向的 `match()` 就在那里 ⇒ 回大厅会让意向**永远没人消费**
 * （用户点了再次匹配、什么都不会发生）。
 * 用户从玩法页回来能**立刻**看到房间列表并再匹配一次 —— 这也更符合「再来一局」的语义。
 *
 * ⚠️ **不得**在这里发 `room.match`：匹配的唯一实现仍在玩法页一处（R454/R658，
 * `settlement-rematch.test.ts` ⑤ 数着 `game.vue` 里 `send('room.match'` 的调用点）。
 */
function onAgain() {
  store.requestRematch();
  auth.navigate('game');
}
```

- [ ] **Step 4: `lobby.vue` 删掉开局区（script + template + style）**

删干净：`rooms` / `joinCode` / `matching` / `busy` / `error` / `STATUS_TAG_TYPE` / `loadRooms` / `match` / `unmatch` / `join` / `createAndJoin` / `.lobby__start` 整块 / 对应的 style 规则。
⚠️ **`onMounted` 里只剩**（大厅不再有 `match()`）：

```ts
onMounted(() => {
  /** ⚠️ 大厅**不再**消费「再来一局」意向 —— 那个消费点随 `match()` 搬去了玩法页（R760）。 */
});
```

⇒ 空 `onMounted` 直接**删掉**，不要留个空壳。

⚠️ **`stopGameSession` / `isGameSessionReady` 等 import 若不再用就删**（`noUnusedLocals` 会报）。

- [ ] **Step 5: `game.vue` 的 template（完整的开局区）**

```vue
      <view class="game__start">
        <view class="game__match">
          <button v-if="!matching" type="button" class="btn btn--primary" :disabled="busy" @click="match">
            随机匹配
          </button>
          <template v-else>
            <text class="game__matching">正在匹配…（由服务端撮合）</text>
            <button type="button" class="btn" :disabled="busy" @click="unmatch">取消匹配</button>
          </template>
        </view>

        <view class="game__create">
          <button type="button" class="btn game__create-room" :disabled="busy" @click="createAndJoin">
            创建房间
          </button>
        </view>

        <text v-if="error" class="game__error">{{ error }}</text>

        <view class="game__join">
          <input v-model="joinCode" type="text" placeholder="输入 6 位房间号" maxlength="6" />
          <button type="button" class="btn" :disabled="busy || !joinCode" @click="join()">加入</button>
        </view>

        <view class="game__rooms">
          <view class="game__rooms-head">
            <text class="game__rooms-title">房间列表</text>
            <button type="button" class="btn btn--small" @click="loadRooms()">刷新</button>
          </view>

          <wd-cell-group v-if="rooms.length > 0" class="game__list" border>
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
                <text class="game__count">
                  {{ room.status }} · {{ room.playerCount }}/{{ room.maxPlayers }} · 底分 {{ room.baseScore }}
                </text>
              </view>
            </wd-cell>
          </wd-cell-group>

          <wd-loadmore v-else class="game__empty" state="finished">暂无房间</wd-loadmore>
        </view>
      </view>
```

⚠️ **`@click="join()"` 与 `@click="loadRooms()"` 的括号必须保留**（原来的注释解释了为什么：不加会把 MouseEvent 当参数传进去）。

- [ ] **Step 6: 玩法页顶栏显示玩法名（从 store 读，R752）**

```vue
      <view class="game__bar">
        <button type="button" class="btn btn--small" @click="auth.navigate('lobby')">返回大厅</button>
        <text class="game__title">{{ mode.name }}</text>
      </view>
```

```ts
import { DEFAULT_MODE_ID, findMode } from '../../gameModes';
/**
 * 玩法名从 **store** 读（R752）—— 本页**不得**写死「斗地主」字面量。
 * 查不到就回落缺省（`DEFAULT_MODE_ID`）—— 那只会发生在「store 里的 id 与 GAME_MODES 不同步」
 * 这种异常上，回落比渲染空白好。
 */
const mode = computed(() => findMode(store.activeMode) ?? findMode(DEFAULT_MODE_ID)!);
```

- [ ] **Step 7: **此刻先不要跑全量测试****

锚点刚搬走，`lobby-ux` / `auth-ui-wiring` / `settlement-rematch` 此刻**必然是红的** ——
迁移在 **§3.10**（同一 Task 的后半段）。**跑完 §3.10 再验**。

⚠️ **不要**在这一步去改那三个测试 —— §3.10 要求**逐条读着迁**（防止顺手把断言改弱）。

- [ ] **Step 8: lint + 双构建**

```bash
pnpm --filter @fight-the-landlord/client lint
pnpm --filter @fight-the-landlord/client build:h5 2>&1 | grep -E "DONE|error"
pnpm --filter @fight-the-landlord/client build:app 2>&1 | grep -E "DONE|error"
```

Expected: lint 干净（**`noUnusedLocals` 会把 `lobby.vue` 里搬剩的 import 抓出来**）、两个 DONE。

- [ ] **Step 9: Commit（搬家这一半）**

```bash
git add apps/client/src/pages/game/game.vue apps/client/src/pages/lobby/lobby.vue \
        apps/client/src/pages/table/table.vue apps/client/src/components/SessionNotice.vue
git commit -F - <<'MSG'
feat(client): 开局区搬到玩法页 + 「再来一局」改道（片③ Task 3 / R749 R751 R760）

- 开局区（匹配/建房/房号加入/房间列表）整体搬进 game.vue 并改名 game__*（R749 诚实命名）
- **R760 功能修复**：「再来一局」原本是 navigate('lobby') + 大厅消费意向去 match()，
  而 match() 随开局区搬走了 ⇒ 不改就是「点再来一局回大厅、什么都不会发生」。
  改成 navigate('game')，由玩法页的 onMounted 消费意向（spec §1.3 H9）
- **R751**：会话提示抽成 SessionNotice.vue 共用件（两页都要有、但不能写两遍）
- 玩法页的顶栏显示玩法名，**从 store 读**、不写死字面量（R752 的判据）

⚠️ 本 commit 之后 lobby-ux / auth-ui-wiring / settlement-rematch 是红的 —— 同一个 Task 的
§3.10 立刻迁移断言（**合并 Task 是为了不让任何一个 Task 以红收场**）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### 3.10 断言迁移（**逐文件核，一条不减**）

> ⚠️ **与 3.1–3.9 是同一个 Task**（原计划把它拆成 Task 4，但那样 Task 3 结束时
> `lobby-ux` / `auth-ui-wiring` / `settlement-rematch` **是红的**，而任务评审按「测试全绿」判
> ⇒ 会报 Critical。**搬完就迁完、全程绿**，所以合并。）

**Files:**
- Modify: `apps/client/test/lobby-ux.test.ts` · `auth-ui-wiring.test.ts` · `settlement-rematch.test.ts`

---

- [ ] **Step 10: 先记录迁移前的逐文件基线**

```bash
cd /d/Code/pokergame/apps/client/test
for f in lobby-ux auth-ui-wiring settlement-rematch lobby-modes; do
  printf "  %-20s %s\n" "$f" "$(( $(grep -oE '\bit\(' "$f.test.ts" | wc -l) + $(grep -oE '\bit\.each\(' "$f.test.ts" | wc -l) ))"
done
```

Expected: `lobby-ux 18 · auth-ui-wiring 13 · settlement-rematch 5 · lobby-modes 6`。**抄进 commit 信息。**

- [ ] **Step 11: `lobby-ux` —— 加 `mountGame` helper，把开局区用例指过去**

在既有 `mountLobby` **旁边**加：

```ts
  /**
   * 片③：开局区搬到玩法页之后，**涉及开局区的用例挂这一页**。
   *
   * ⚠️ 与 `mountLobby` 的差别只有挂载的组件（`GamePage` 而非 `LobbyPage`）——
   * `stubFetch` / `capturingFactory` / `startGameSession` 全部照旧：
   * 玩法页与大厅读的是**同一套** net 层。
   */
  function mountGame(list: RoomInfo[] = []) {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    const { calls } = stubFetch((call) =>
      call.init?.method === 'POST'
        ? { code: 0, data: roomFixture('NEW123', { mode: 'practice' }) }
        : { code: 0, data: list },
    );
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    return { wrapper, socket: sockets[0]!, calls };
  }
```

然后**逐条读**每个用例：断言里出现 `.lobby__start/match/create/join/rooms/list/item/error/empty` 的 ⇒ 把 `mountLobby(` 换成 `mountGame(`、把锚点前缀换成 `game__`。**其余一个字符都不改。**

⚠️ **`mountLobbyForRematch`（`:389`）整块要重写**（R760 改了链路）：

```ts
  function mountGameForRematch() {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    stubFetch(() => ({ code: 0, data: [] }));
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    return { wrapper, socket: sockets[0]! };
  }
```

它对应的用例改成：**预置 `store.requestRematch()` ⇒ 挂载玩法页 ⇒ `room.match` 被发了一次**（这就是 R760 的**反面判据**：意向**确实被消费**）。

- [ ] **Step 12: `auth-ui-wiring` —— 同样处理**

它的 `mountLobbyWithSocket()` **保留**（还有大厅的用例在用），**另加** `mountGameWithSocket()`；把点「随机匹配」那类用例指过去。

```ts
    await wrapper.find('.game__match button').trigger('click');
```

- [ ] **Step 13: `settlement-rematch` —— 改指向（R761）**

```ts
// ④ 页面级：table.vue 收到 again ⇒ auth.page 是 **game**（不是 lobby），且 rematchPending=true
expect(auth.page, '牌桌把用户送回**玩法页**（房间列表与开局按钮在那里，R760）').toBe('game');

// ⑤ 源码级：send('room.match' 的唯一实现现在在**玩法页**
const game = collectSourceFiles().find((f) => f.path === 'src/pages/game/game.vue');
expect(game, 'game.vue 必须在扫描集合里').toBeDefined();
expect(
  [...game!.content.matchAll(/send\('room\.match'/g)],
  'room.match 仍恰好 1 处（R454/R658：匹配只有一处实现）',
).toHaveLength(1);
```

⚠️ **`settlement-rematch` 不在 65 基线内**，但⑤这条的**判别力不得降** —— 它防的是「复制第二份匹配实现」。

- [ ] **Step 14: 跑这三个文件，确认绿**

```bash
pnpm --filter @fight-the-landlord/client test -- lobby-ux auth-ui-wiring settlement-rematch lobby-modes 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|→|Tests "
```

Expected: 全绿。

- [ ] **Step 15: 逐文件核对（**不得减少**）**

```bash
cd /d/Code/pokergame/apps/client/test
for f in lobby-ux auth-ui-wiring settlement-rematch lobby-modes; do
  printf "  %-20s %s\n" "$f" "$(( $(grep -oE '\bit\(' "$f.test.ts" | wc -l) + $(grep -oE '\bit\.each\(' "$f.test.ts" | wc -l) ))"
done
```

Expected: `lobby-ux 18 · auth-ui-wiring 13 · settlement-rematch 5 · lobby-modes 6` —— **与 Step 1 逐文件相同**（`lobby-modes` 的 R652 用例是**迁移**：2 条改成 2 条）。

- [ ] **Step 16: 全量 + lint**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Test Files|Tests |FAIL"
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿、lint 干净。

- [ ] **Step 17: Commit**

```bash
git add apps/client/test/
git commit -F - <<'MSG'
test(client): 拆页后的断言迁移（片③ Task 3 §3.10 / R761）

迁移前逐文件基线：lobby-ux 18 · auth-ui-wiring 13 · settlement-rematch 5 · lobby-modes 6
迁移后：**逐文件相同**（一条没减）。

- lobby-ux / auth-ui-wiring：加 mountGame / mountGameWithSocket，把**涉及开局区的**用例
  挂到玩法页；锚点前缀 lobby__ → game__。其余一个字符都没改
- lobby-ux 的 mountLobbyForRematch 整块重写 —— R760 改了链路（意向现在由**玩法页**消费），
  对应的用例改成「预置 requestRematch ⇒ 挂载玩法页 ⇒ room.match 被发了一次」= **反面判据**
- settlement-rematch（R761）：④ 的 auth.page 'lobby' → 'game'；
  ⑤ 的源码级判据「lobby.vue 里 send('room.match' 恰好 1 处」改指 **game.vue**，判别力不降

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 4: 探针成对改（**首次改动**）+ gate + full

**Files:**
- Modify: `scripts/browser-e2e.mjs`

---

- [ ] **Step 1: 改 `matchAndWaitDeal`（**插入点在它内部** —— R750）**

**现状**（`:433`）：

```js
async function matchAndWaitDeal(cdp, label) {
  const rollbackBefore = run.rollbackEvents;
  await waitForSelector(cdp, '.lobby__match .btn', 20000);
  const clickedMatch = await cdp.eval(clickByText('.lobby__match .btn', '随机匹配'));
```

**改为**：

```js
async function matchAndWaitDeal(cdp, label) {
  const rollbackBefore = run.rollbackEvents;
  /**
   * ⚠️ **片③（首次改动）**：大厅拆成了「大厅（选玩法）」+「玩法页（房间列表+开局按钮）」。
   * 本函数的**三种调用时机**都可能落在**大厅**上：
   *   ① 刚注册完（`registerFresh` 之后）② 受控复现注入之后（`seedFinishedGame` 之后，
   *   此时人还在大厅）③ `backToLobby` 之后（真打完一局再开第二局）。
   * ⇒ **必须在这里**保证「先到玩法页」，放在 `registerFresh` 里会漏掉后两次。
   *
   * ⚠️ **一次等「任一页面就绪」**（`'.lobby__mode, .game__match .btn'`，20s），再按**落在哪个页面**分支：
   * 不用「先探大厅 2.5s、再等玩法页 20s」那种两段式 —— 它把「冷启动编译大厅 chunk 的耗时」
   * 夹在两段之间（探成 0 ⇒ 跳过点卡 ⇒ 后面等玩法页也在等一个还没到的页面 ⇒ 红得与本次改动无关）。
   * 现在只等**一次**：等到哪个页面就是哪个页面，时序假设清零。
   */
  await waitForSelector(cdp, '.lobby__mode, .game__match .btn', 20000);
  const onLobby = await cdp.eval(`document.querySelectorAll('.lobby__mode').length`);
  if (onLobby > 0) {
    const clickedMode = await cdp.eval(`(() => {
      const el = document.querySelector('.lobby__mode');
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()`);
    const intoGame = await waitForSelector(cdp, '.game__match .btn', 20000);
    check(
      `${label}：点玩法卡进入玩法页（片③ 拆页后新增的一步）`,
      intoGame > 0,
      `click=${clickedMode} .game__match .btn=${intoGame}`,
    );
  }
  await waitForSelector(cdp, '.game__match .btn', 20000);
  const clickedMatch = await cdp.eval(clickByText('.game__match .btn', '随机匹配'));
```

⚠️ **修复轮订正**：「先探大厅 2.5s、再等玩法页 20s」的两段式是**初稿** —— 冷启动时大厅 chunk 编译常超过
2.5s，探成 0 就跳过点卡、随后在还没到的玩法页上超时红掉（与本次改动无关）。**实施时已订正为上面这段
「一次等任一页面就绪」**（spec §9 F9 有真·冷启动实测：dev server 重启后 4 秒内开跑，18/18）。

⚠️ **`.lobby__match .btn` 全文件搜一遍**，其余出现处（若有）也要一起改成 `.game__match .btn`：

```bash
grep -n "lobby__match\|lobby__start\|lobby__rooms" scripts/browser-e2e.mjs
```

- [ ] **Step 2: 检查 `backToLobby` 是否需要改**

`backToLobby` 点的是 `.table__bar .btn`（文本「返回大厅」）⇒ 回**大厅**（**不是**玩法页）—— 这与 `matchAndWaitDeal` 的 Step 1 配合：它会在下一次调用时自己点玩法卡 ✓ **`backToLobby` 不用改**。

- [ ] **Step 3: 起服务 + 跑 gate**

```bash
cd /d/Code/pokergame
docker compose ps --format '{{.Names}}' | wc -l      # 期望 8
cd apps/client && nohup pnpm dev:h5 > /tmp/ftl-dev.log 2>&1 &
sleep 18
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:5173/
cd /d/Code/pokergame
export CHROME_BIN='C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✅|❌|判据 [0-9]+/"
```

Expected: **18/18**。⚠️ **条数不是「16 + 1」** —— 计划的初稿预测 17，但那与计划**自己的代码**矛盾：
`check()` 在 `if (onLobby > 0)` 里，而 `matchAndWaitDeal` 在 gate 里被调用 **2 次**（判据 1 / 判据 2），
且每次开场都在大厅 ⇒ **各发一条**。实施时**回退文件量了基线**（gate 16 条 / 11 过）验证过。

- [ ] **Step 4: 跑 full（**它是唯一覆盖结算+卸载路径的场景** —— 片② F17 的建议）**

```bash
timeout 560 node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario full 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✅|❌|判据 [0-9]+/"
```

Expected: **23/23**（20 + **3**：`full` 里 `matchAndWaitDeal` 调 3 次 —— 判据 1 / 判据 2′ 第一局 / 判据 2′ 真跨局）。
⚠️ 若红在**判据2′**（`backToLobby` 之后）—— 那说明 Step 1 的插入点又放错了，回去看它。

- [ ] **Step 5: Commit**

```bash
git add scripts/browser-e2e.mjs
git commit -F - <<'MSG'
test(probe): 探针首次成对改动 —— 拆页后加「点玩法卡」一步（片③ Task 4 / R750）

片① 起就一直保持零改动的探针，本片首次改动（spec 早已记实）。

- matchAndWaitDeal 内部插入「若在大厅则点玩法卡」—— ⚠️ **必须在它内部**：
  它被调用三次（判据1 / 判据2 受控 / 判据2′），而判据2′ 是在 backToLobby 之后，
  那时用户在大厅。放在 registerFresh 里会漏掉后两次（spec §1.2 H1）
- `.lobby__match .btn` → `.game__match .btn`（开局区随拆页改名）
- backToLobby 不用改：它回的是**大厅**，而匹配那一步会自己点玩法卡

gate 16 → **18** 条，full 20 → **23** 条（每次在大厅开场各发一条 check，实测）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 5: 登录页排布修复（R744：**只修排布**）

**Files:**
- Modify: `apps/client/src/pages/login/login.vue`

---

- [ ] **Step 1: 先看现状（截图）**

```bash
cd /d/Code/pokergame
export CHROME_BIN='C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'
"$CHROME_BIN" --headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage \
  --remote-debugging-port=18800 --user-data-dir=/tmp/ftl-login about:blank &
sleep 6
node --input-type=module - <<'PY'
import { writeFileSync } from 'node:fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:18800/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params={}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Page.navigate', { url: 'http://localhost:5173/' });
await sleep(6000);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('.tmp_ref/s3-login-before.png', Buffer.from(shot.result.data, 'base64'));
console.log('截图 → .tmp_ref/s3-login-before.png');
ws.close(); process.exit(0);
PY
```

**看那张图**，量出三颗按钮与勾选框的实际位置（`getBoundingClientRect`，用 `k = canvas 宽 / 1334` 换算成画布 px）。

- [ ] **Step 2: 改排布**

`.login__actions` 的两颗提交按钮**并排一行**；「以开发身份进入」**另起一行占满**；「显示」勾选框与它的标签**成组**（同一行、`align-items: center`、间距用令牌）。

⚠️ **`.login__actions .btn` 是探针锚点**（按文本「注册」匹配）⇒ **文本与 class 一个字不改**。

- [ ] **Step 3: 跑 `login-screen` / `auth-ui-wiring`，确认仍然绿**

```bash
pnpm --filter @fight-the-landlord/client test -- login-screen auth-ui-wiring 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Tests |FAIL"
```

Expected: 全绿 —— **排布改动不该动断言**（若红了，说明改到了结构 ⇒ 读那条断言再决定）。

- [ ] **Step 4: 再截一张图，**与前一张并排看****

```bash
# 同 Step 1 的脚本，输出名改成 .tmp_ref/s3-login-after.png
```

⚠️ **这一步没有机械判据** —— 只能人眼。**不要**为了「有判据」去写一条假的。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/pages/login/login.vue
git commit -F - <<'MSG'
fix(client): 登录页按钮排布（片③ Task 5 / R744）

只修排布、不重做视觉（用户 2026-09-22 裁决）：
- 两颗提交按钮并排一行（原来与开发身份按钮挤在一列）
- 「以开发身份进入（连 mock 用）」另起一行占满
- 「显示」勾选框与标签成组对齐

锚点未动：`.login__actions .btn` 的 class 与文本（探针按文本「注册」匹配）一个字没改。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Task 6: 三屏走查 + 收口

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-portal-rework-design.md`（§9 执行期发现 + §10 完成状态）
- Create: `docs/superpowers/plans/2026-09-22-portal-rework-side.md` 的收口注记（本文件）

---

- [ ] **Step 1: 三屏截图（**逐屏看** —— 片② F18 的教训：排版塌陷只有看图能发现）**

按真人路径驱动：登录 → 大厅（**应只剩玩法卡**）→ 点卡片 → 玩法页（**房间列表 + 开局按钮**）→ 随机匹配 → 牌桌 → 打完一局 → 结算 → 再来一局（**应回到玩法页并自动匹配**）。
每屏 `Page.captureScreenshot` 存到 `.tmp_ref/s3-*.png`，**然后逐张看**。

**逐条走查清单**（任一不通过 ⇒ 记进「已知未覆盖」，**不要**写进判据）：
1. 大厅那一屏**确实只有玩法卡**（没有匹配/建房/房号/列表的残留）
2. 玩法卡**整体可点**（不是只有边角）
3. 玩法页的**房间列表与开局按钮齐全**，且顶栏能返回大厅
4. 「**再来一局**」回的是**玩法页**，且**自动开始匹配**（R760 的肉眼证据）
5. 大厅的**用户区**没有那串 UUID
6. 两页的 notice（会话提示）都能出现
7. 登录页三颗按钮与勾选框排开了
8. `k≈0.52` 下两页的文字是否发虚到不可读

- [ ] **Step 2: `pnpm run ci` 六阶段 + 双构建**

```bash
cd /d/Code/pokergame
pnpm run ci 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^\[ci\]|六阶段|FAIL"
pnpm --filter @fight-the-landlord/client build:h5 2>&1 | grep -E "DONE|error"
pnpm --filter @fight-the-landlord/client build:app 2>&1 | grep -E "DONE|error"
```

Expected: 六阶段全过、两个 DONE。

- [ ] **Step 3: 8 文件基线核对 + 探针改动范围核对**

```bash
cd /d/Code/pokergame/apps/client/test
total=0
for f in auth-flow auth-ui-wiring lobby-ux ui-flow table-bid-ui table-play-ui table-ended-ui table-settlement-ui; do
  n=$(( $(grep -oE '\bit\(' "$f.test.ts" | wc -l) + $(grep -oE '\bit\.each\(' "$f.test.ts" | wc -l) )); total=$((total+n))
  printf "  %-22s %s\n" "$f" "$n"
done
echo "  ---- 合计 $total（基线 67，只增不减）----"
cd /d/Code/pokergame && git diff --stat master -- scripts/browser-e2e.mjs
```

Expected: 合计 **≥ 67**；探针的 diff **只有 `matchAndWaitDeal` 那一段**（若改了别处，说明改多了）。

- [ ] **Step 4: 写 spec 的 §9 执行期发现与 §10 完成状态**

按实际结果填。**至少包含**：R760 的功能修复在真浏览器里的证据（点「再来一局」⇒ 到玩法页且自动匹配）· 三屏走查的逐条结论 · 任何偏离本设计的地方与理由 · 8 文件基线与探针条数的实测值。

- [ ] **Step 5: 收尾（**先确认再杀** —— 片② 有过「先杀服务再告诉用户打开地址」的事故）**

若用户还要体验，**留着 dev server**；只杀探针留下的 chromium：

```bash
cd /d/Code/pokergame
PID=$(netstat -ano | grep ':18800 ' | grep LISTENING | awk '{print $5}' | head -1)
[ -n "$PID" ] && taskkill //F //PID "$PID" //T
```

- [ ] **Step 6: Commit**

```bash
cd /d/Code/pokergame
git add docs/superpowers/specs/2026-09-22-portal-rework-design.md docs/superpowers/plans/2026-09-22-portal-rework-side.md
git commit -F - <<'MSG'
docs(spec): 片③ 走查收口 —— §9 执行期发现 + §10 完成状态

（按实际结果填写）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

## Self-Review（写计划后自查）

**1. Spec 覆盖**：R744（范围）→ Task 2/6 · R745（一步进入）→ Task 2 · R746（R652 作废）→ Task 2 ·
R747（图标位）→ Task 2 · R748（RouteName）→ Task 1 · R749（改名）→ Task 3 ·
R750（探针插入点）→ Task 4 · R751（notice 抽共用件）→ Task 3 · R752（跨页状态）→ Task 2 ·
R753（删 UUID）→ Task 2 · R754/R755/R757/R758（页面清单）→ Task 1 · R756（全局约束）→ 每 Task ·
R759（特征搜）→ Task 1 Step 1 · R760（再来一局）→ Task 3 · R761（settlement-rematch）→ Task 4 ·
R762（`<button>`）→ Task 2。**无缺口。**

**2. 占位符扫描**：无 TBD / TODO；每个改代码的 Step 都带了实际代码。

**3. 类型一致性**：
- `RouteName` 含 `'game'` 在 Task 1 定义，Task 2 的 `auth.navigate('game')` 与 Task 3 的
  `navigate('game')` **同字面量** ✓
- `GAME_MODES` / `GameModeId` / `DEFAULT_MODE_ID` / `findMode` 在 Task 2 Step 3 定义，
  Task 2 Step 5（大厅）与 Task 3 Step 6（玩法页）**同签名**调用 ✓
- `store.activeMode` / `store.setActiveMode(id)` 在 Task 2 Step 4 定义，
  Task 2 Step 5 写、Task 3 Step 6 读 ✓
- `mountGame` / `mountGameWithSocket` 在 Task 4 定义并使用 ✓
- ⚠️ **Task 1 Step 5 的新页骨架里 `store` 可能未被使用** —— 已在 Step 5 的注里写明处置（留到 Task 3），
  **不得**为消警告写假用途

**4. 一处顺序风险 —— 已在 Pre-Flight 评审中消除**：初稿把「搬家」与「迁断言」拆成 Task 3 / Task 4，
那样 **Task 3 会以红收场**（锚点搬走了，三个测试文件必红），而**任务评审按「测试全绿」判**
⇒ 会报 Critical。**已合并成一个 Task 3**（§3.10 是它的后半段），全程绿。

---

## 收口注记（Task 6 实测，2026-09-22）

> 执行结果与证据在 **spec §9（执行期发现）/ §10（完成状态）**，这里只记**与本计划的偏差**与**实测数字**。

**1. 实测数字（逐条核过）**

| 项 | 计划写的 | **实测** |
|---|---|---|
| 探针 gate | 17（初稿预测） | ✅ **18/18**（+2：`matchAndWaitDeal` 在 gate 被调 2 次，每次都从大厅起步） |
| 探针 full | 21（初稿预测） | ✅ **23/23**（+3，同上） |
| 8 文件 `it(` | ≥ 67 | ✅ **67**（逐文件与基线逐项相同） |
| lobby-modes / settlement-rematch / game-store-session-reset | 6 / 5 / 5 | ✅ **6 / 5 / 5** |
| client 单测 | 493+2（片② 收口） | ✅ **494 passed + 2 skipped**（+1 = `table-hud` 的 `it.each` 随新页展开，一条没减） |
| `pnpm run ci` 六阶段 | 全过 | ✅ **六阶段全部通过** |
| `build:h5` / `build:app` | 两个 DONE | ✅ 两个 **DONE** |
| 探针 diff vs `master` | 只有 `matchAndWaitDeal` | ✅ **1 个 hunk**（30 insertions / 2 deletions） |

**2. 走查（Task 6 Step 1）**：三步路径全程真浏览器跑通（登录 → 大厅 → 点卡 → 玩法页 → 随机匹配 → 牌桌 →
打完一局 → 结算 → **再来一局 ⇒ 玩法页 + 自动匹配 ⇒ 第二局真的开起来**，新房间 `7WXX9G`）。
八条逐条结论与 **18 张**截图见 spec §10；**两条裁决（T5-M1 / T2-R4）见 §10.2**。

**3. 与本计划的偏差（三处，都不是计划写错、而是计划没写）**

- **新增一步修复**：玩法页顶栏被 `uni-button` 的 auto 边距顶到中间（`margin: 531px 531px`）⇒
  `.game__bar .btn { margin: 0 }`（spec §9 F5）。**计划里没有这条** —— 它只有**逐屏看图**才能发现。
- **走查查出一条既有功能缺陷**：「创建房间」（连带「房号加入」「点列表项」）在真后端上是坏的
  （`12004 You are not in this room`，spec §9 F6）。**不在本计划范围内**（跨服务契约），
  已登记为已知未覆盖并建议**单列一片**。
- **§3 的初稿残留**：R762 修正的是裁决表，§3 正文那句「用 `view` + `@click`」没人回头改 ⇒ 收口时按 R762 改写。

**4. Step 0 的四条收口清理（全部落地）**：T1-R1（三处「三页」注释 → 四页）· T2-R1（`lobby-modes:142`
加 `setActiveMode` 的 spy —— **已用「删掉 `setActiveMode(id)` 后该条必须红」的反向实验证明有判别力**）·
T2-R2（开局区覆盖的归属订正为两家）· T3-R-fix1（正对照换**合成样本**，不再绑注释措辞）·
T5-M3（登录页注释的数字按实测订正：面板 **410**、幽灵按钮文案单行 **362.8**、折行阈值在面板 **395~400** 之间）。

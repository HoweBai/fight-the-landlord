# 登录页样板（视觉语言验证）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把登录页改成**单列居中 + 内容浮在底纹上**（去掉不透明白卡，表单由半透明深蓝面板托住），作为整个界面重做的**视觉语言样板** —— 拍死后其余三页照它做。

**Architecture:** 纯客户端、纯视觉改动 —— 只动 `apps/client/src/pages/login/login.vue` 的模板结构与 `<style>`，**逻辑一行不改**。现有 21 个测试文件里的**锚点断言**是这次的回归网（jsdom 没有布局引擎，观感只能靠真浏览器截图 + 测量）。

**Tech Stack:** uni-app CLI + Vue 3 + SCSS（`src/uni.scss` 令牌）+ vitest（jsdom）+ headless Chrome（CDP 测量/截图）。

**规格**：`docs/superpowers/specs/2026-09-27-login-page-pilot-design.md`（上位：总规格 §6.1 + D15）

---

## Global Constraints

- 🔴 **只改 `apps/client/src/pages/login/login.vue`**。不改协议、不动后端、不改其他三页。
- 🔴 **逻辑一行不改**：`submit()` / `submitOther()` / `validate()` / `auth.signIn` / `auth.signUp` / `setMode` 全部保持原样。
- 🔴 **禁止改 `src/uni.scss` 里任何令牌的「值」** —— 令牌是**全局**的，改一个值会同时改掉其他三页。**引用**令牌当然可以（`$ftl-color-gold` 等），禁止的是**改定义**。
- 🔴 **不许碰的锚点**（规格 §5.1，每条都 grep 核过，改了 `pnpm run ci` 会红）：
  - `.login__field input` 的**数量 ≥2 与顺序**（手机号第 0 个，`inputmode="tel"`）
  - `.login__actions .btn--primary` 的**文本**（「登录」/「注册」）
  - `.login__actions .btn:not(.btn--primary)` 的**文本**（另一颗）
  - `.login__seg-item`
  - `.login__field--phone` / `--password` / `--confirm`
  - `.login__field-error` / `.login__error` / `.login__toggle-visibility`
  - **文本「斗地主」**（5 处断言）
- 🔵 **可自由重排的**（规格 §5.2，测试里零命中）：`.login__brand` / `.login__panel` / `.login__logo` / `.login__title` / `.login__hint` 的 **class**；说明文字 `.login__hint` 的**文案**；幽灵按钮的 **class/文案/位置**。
- **机械闸**（`pnpm run ci` 六阶段）：尺寸一律 `px`（**禁 `rpx`/`em`/`vw`/`vh`**）· 描边一律 `$ftl-hairline`（2px，**禁手写 `1px`**）· **除 `uni.scss` 外禁裸十六进制色值** · `line-height` 用**无单位**数值 · ⚠️ 组件样式里**不能用 SCSS `@use`**（只能用 `@import`）。
- **每次改动一个 commit**（CLAUDE.md，便于回滚）。
- ⚠️ **本机没有 `flock` 与 `script(1)`** ⇒ 相关判据在本机**显式跳过**，别把「本机绿」当成「全绿」。

## 范围外（**本片不做**）

| 项 | 为什么 |
|---|---|
| 删第二颗提交按钮 | 动它要改探针（R649）+ 3 处断言 —— 会把变量混进这次**纯视觉**验证。**先量高度，不够再回来砍**（规格 §3.1） |
| 改 `$ftl-art-*` 七个槽 | 总规格 §3.1：槽位接线在片②③ |
| 改通道协议 / 后端 | 登录页只走 REST，本来就不需要 |
| 其他三页 | 本片的产出是**给它们照做的样板** |

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/client/src/pages/login/login.vue` | 修改（模板 + `<style>`） | 唯一被改的产品文件 |
| `apps/client/test/login-layout.test.ts` | **新建** | 本片新增的**结构断言**（3 条）。独立成文件是为了让「样板的结构要求」有一个找得到的地方，而不是散进 `login-screen.test.ts` |
| `docs/superpowers/specs/2026-09-27-login-page-pilot-design.md` | 修改 | §6 验收记录：填真实高度 + 拍板结论 |

---

## Task 1: 结构单列化 + 文案精简

**Files:**
- Create: `apps/client/test/login-layout.test.ts`
- Modify: `apps/client/src/pages/login/login.vue:159-163`（`.login__brand`）、`:166-229`（`.login__panel`）

**Interfaces:**
- Consumes: 无
- Produces: 模板结构 —— `.login` 下依次是 `.login__brand` → `.login__panel` → 幽灵按钮（**移出 `.login__panel`**）。

- [ ] **Step 1: 写三条会红的断言**

新建 `apps/client/test/login-layout.test.ts`：

```ts
/**
 * 登录页样板的**结构要求**（规格 `2026-09-27-login-page-pilot-design.md`）。
 *
 * ⚠️ **射程诚实版**：jsdom **没有布局引擎** —— 这里**不**能证明「它是单列的」、「高度压进了 750」。
 * 那两件事只能靠真浏览器截图 + 测量（规格 §6）。本文件只钉三件**可以机械判定**的事：
 *   ① 说明文字 `.login__hint` 已删（规格 §3 的压缩项，已核无锚点）；
 *   ② 幽灵按钮**已移出** `.login__panel`（挪出主流程，规格 §3）；
 *   ③ 被锚定的东西**一个没少**（锚点表 §5.1 的**存在性**部分 —— 数值/顺序由 `login-screen.test.ts` 管）。
 *
 * ③ 是**判别力自证**：它防的是「为了单列把某个锚点元素顺手删了」。
 *
 * ⚠️ **mount 姿势逐字照抄 `login-screen.test.ts:19-46`** —— 尤其
 *    `startGameSession(() => new FakeSocket())` 那一句：少了它，`restartGameSession()`
 *    未初始化时**同步抛**，而抛出发生在测试 window **之外**（floating rejection）
 *    ⇒ vitest 记 unhandled error ⇒ **整包退出码 1**（该文件头逐字记着这个坑）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LoginPage from '../src/pages/login/login.vue';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { FakeSocket } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

function mountLogin() {
  const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  startGameSession(() => new FakeSocket());
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
});

describe('登录页样板 · 结构要求', () => {
  it('① 说明文字 `.login__hint` 已删（规格 §3 的压缩项）', () => {
    expect(mountLogin().find('.login__hint').exists()).toBe(false);
  });

  it('② 幽灵按钮已移出 `.login__panel`（挪出主流程）', () => {
    const w = mountLogin();
    expect(w.findAll('.btn--ghost'), '幽灵按钮必须还在（只是挪位置）').toHaveLength(1);
    expect(w.find('.login__panel .btn--ghost').exists(), '幽灵按钮不得留在面板内').toBe(false);
    expect(w.find('.login > .btn--ghost').exists(), '幽灵按钮必须挂到面板外').toBe(true);
  });

  it('③ 判别力自证：被锚定的元素一个都没少', () => {
    const w = mountLogin();
    for (const sel of [
      '.login__seg-item',
      '.login__field--phone',
      '.login__field--password',
      '.login__actions .btn--primary',
      '.login__actions .btn:not(.btn--primary)',
      '.login__toggle-visibility',
    ]) {
      expect(w.find(sel).exists(), `${sel} 不见了 —— 它是被断言锚定的`).toBe(true);
    }
    expect(w.findAll('.login__field input'), '登录态恰好 2 个输入框').toHaveLength(2);
    expect(w.text(), '「斗地主」有 5 处断言钉着').toContain('斗地主');
  });
});
```

- [ ] **Step 2: 跑它 —— 确认 ①② 真的红**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- login-layout
```
预期：**① 与 ② 红**（`login__hint` 还在、幽灵按钮还在面板内），**③ 绿**（什么都没删）。

⚠️ **必须看到这个分布**。若 ③ 也红，说明我的锚点表有错 —— **停下来核**，别改测试去迁就。

- [ ] **Step 3: 改模板**

`apps/client/src/pages/login/login.vue`，把**整个** `<template>…</template>` 换成下面这份
（**逐字**，`@click` / `v-model` / `v-if` / `:class` / `:disabled` / `:type` **一个字不改**）：

```vue
<template>
  <LandscapeStage>
    <view class="login">
      <!--
        标签映射（派工单 A）：`section/header/div/ul/li → view`、`span/p/h1/h2 → text`；
        `button`/`input` 保持 uni-app core 组件。class 名一个不改（探针与测试的锚点）。
        ⚠️ 本注释**必须**在根元素**内部**（R685）：写在根元素之前会让页面变成 fragment root，
        `classes()` 静默返回 `[]`。
      -->
      <!--
        片① 样板（2026-09-27）：**单列居中** —— 品牌在最上（logo 居中），
        表单由一层半透明面板托住，开发入口移出面板。
        ⚠️ 结构变了、**锚点没变**：`.login__field input` 的**顺序**、
        `.login__actions` 两颗按钮的**文本**、`.login__seg-item` 全部原样。
      -->
      <view class="login__brand">
        <image class="login__logo" src="/static/ui/logo.png" mode="aspectFit" />
        <text class="login__title">斗地主</text>
      </view>

      <view class="login__panel">
        <view class="login__seg">
          <button
            type="button"
            class="login__seg-item"
            :class="{ 'login__seg-item--active': !isRegister }"
            @click="setMode('login')"
          >
            登录
          </button>
          <button
            type="button"
            class="login__seg-item"
            :class="{ 'login__seg-item--active': isRegister }"
            @click="setMode('register')"
          >
            注册
          </button>
        </view>

        <view class="login__form">
          <view class="login__field login__field--phone">
            <text>手机号</text>
            <input v-model="phone" type="text" inputmode="tel" autocomplete="username" placeholder="13800000000" />
          </view>
          <view class="login__field login__field--password">
            <text>密码</text>
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="••••••"
            />
            <button
              type="button"
              class="login__toggle-visibility"
              @click="showPassword = !showPassword"
            >
              {{ showPassword ? '隐藏' : '显示' }}
            </button>
          </view>
          <view v-if="isRegister" class="login__field login__field--confirm">
            <text>确认密码</text>
            <input v-model="confirm" type="password" autocomplete="new-password" placeholder="再次输入密码" />
          </view>

          <text v-if="fieldError" class="login__field-error">{{ fieldError }}</text>

          <text v-if="auth.error" class="login__error">{{ auth.error }}</text>

          <view class="login__actions">
            <button type="button" class="btn btn--primary" :disabled="busy" @click="submit">
              {{ primaryLabel }}
            </button>
            <button type="button" class="btn" :disabled="busy" @click="submitOther">
              {{ secondaryLabel }}
            </button>
          </view>
        </view>
      </view>

      <!-- 开发入口：移出面板（不再占主流程的高度）—— 无 DOM 锚点，位置自由（规格 §5.2） -->
      <button type="button" class="btn btn--ghost" @click="auth.enterAsDevUser()">
        以开发身份进入（连 mock 用）
      </button>
    </view>
  </LandscapeStage>
</template>
```

**相对现状的三处结构变化（只有这三处）**：
1. **删掉** `<text class="login__hint">登录后进入大厅，在大厅选择玩法</text>` 整行
2. **删掉** `<view class="login__panel">` 内外那几条「左列/右列」注释（文案已过期）
3. **把** `<button class="btn btn--ghost">` 从 `.login__panel` **内部挪到它的后面**（成为 `.login` 的直接子节点）

⚠️ 缩进会整块变化（面板不再嵌在 `.login` 的第二个 flex 子项上）—— 以**上面这份为准**。

- [ ] **Step 4: 跑它 —— 确认转绿**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- login-layout
```
预期：**3/3 通过**。

- [ ] **Step 5: 跑登录页的全部相关套件（锚点回归）**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test
```
预期：全绿（46 文件 / 501 用例量级）。**若有红** ⇒ 我碰到锚点了，**停下来核规格 §5.1**，不要为迁就实现改断言。

- [ ] **Step 6: Commit**

```bash
cd d:/Code/pokergame
git add apps/client/src/pages/login/login.vue apps/client/test/login-layout.test.ts
git commit -m "feat(client): 登录页样板 —— 单列化 + 删说明文字 + 开发入口移出面板"
```

---

## Task 2: 视觉（乙）与压缩

**Files:**
- Modify: `apps/client/src/pages/login/login.vue`（**只动 `<style scoped lang="scss">`**）

**Interfaces:**
- Consumes: Task 1 产出的结构（`.login > .login__brand + .login__panel + .btn--ghost`）
- Produces: 一套**可被其余三页照抄**的视觉语言（面板/主按钮/次按钮的取值）

- [ ] **Step 1: 建立基线（改之前先跑一遍）**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test -- login-screen
pnpm --filter @fight-the-landlord/client test -- table-bid-bottom
```
预期：**都绿**。

⚠️ `table-bid-bottom` 那一步是**有意的**：`login.vue` 的 `.btn--primary` 上挂着一条注释说「这一行必须逐字保留 —— `table-bid-bottom.test.ts` 的主按钮闸按字面的 `background:` 匹配」。本步先记录**它现在绿**，改完再跑一次 —— 用来验证那条注释对**页面文件**到底成不成立（本仓既有记录说那道闸**只扫 `src/components/**`**）。

- [ ] **Step 2: 改样式**

把 `login.vue` 的 `<style scoped lang="scss">` 里下面这些块**替换**掉（其余保持不动）：

```scss
/**
 * 单列居中（D15）+ 视觉「乙」：**去掉不透明白卡**，内容直接浮在底纹上，
 * 表单由一层**半透明深蓝面板**托住。
 *
 * ⚠️ 全部取值来自 `src/uni.scss` 的 `$ftl-*` 令牌（**只引用，不改定义** ——
 *    令牌是全局的，改一个值会同时改掉其他三页）。
 * ⚠️ 这是**起始值**，会被真浏览器截图迭代掉（规格 §2.1）。
 */
.login {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-5;
  width: 100%;
  height: 100%;
  padding: $ftl-space-6;
}
.login__brand {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-3;
}
/** 品牌 logo（U3）。源图 237×147（比例 1.612）⇒ 192/120 保持比例，`aspectFit` 不裁切。 */
.login__logo {
  width: 192px;
  height: 120px;
}
/**
 * 标题：白字 + 深色描边。
 * ⚠️ 这是总规格把「文字描边」推迟到片② 的**落地点** —— 它必须真浏览器实测
 *    （多端对 `-webkit-text-stroke` 的支持不一致）。这里先用**多层 `text-shadow`**，
 *    它在三端都稳；截图若发虚再换 `-webkit-text-stroke`。
 */
.login__title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-xl;
  font-weight: 700;
  line-height: 1.2;
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
/** 半透明深蓝面板：托住表单（可读性），并是压缩的兜底容器。 */
.login__panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  width: 480px;
  max-height: 100%;
  overflow-y: auto;
  padding: $ftl-space-8;
  border: $ftl-hairline solid $ftl-color-night-deep;
  border-radius: $ftl-radius-lg;
  background: rgba($ftl-color-night, 0.55);
}
/** 面板内文字改浅色（原来在白色卡片上是深灰，压在深蓝面板上会看不清）。 */
.login__field {
  color: rgba($ftl-color-on-primary, 0.75);
}
.login__seg {
  background: rgba($ftl-color-night-deep, 0.55);
}
.login__seg-item {
  border-color: $ftl-color-night-soft;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.75);
}
.login__seg-item--active {
  border-color: $ftl-color-gold;
  background: rgba($ftl-color-gold, 0.18);
  color: $ftl-color-gold-light;
}
/** 主按钮：金色 + 深金描边（参考图的按钮语言）。 */
.btn--primary {
  border-color: $ftl-color-gold-deep;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
}
/** 次按钮：弱化 —— 透明底 + 细描边 + 浅字，与主按钮形成主次。 */
.login__actions .btn:not(.btn--primary) {
  border-color: $ftl-color-night-soft;
  background: transparent;
  color: $ftl-color-on-primary;
}
```

**同时删掉** `.login__panel` 的旧值里这几行（它们属于被替掉的白卡）：
`border: $ftl-hairline solid $ftl-color-border;` · `background: $ftl-color-surface;` · `flex: 1 1 0;` · `min-width: 0;`

⚠️ **`.btn--primary` 里原来那两行要处理掉**：
- `background-image: url($ftl-btn-plate-primary);`（245×82 的金色贴图，面板里会被拉伸变形）⇒ **删**
- `background-size: 100% 100%;` ⇒ **删**（跟着上一条）
- `background: $ftl-btn-primary-bg;`（= 蓝色主色）⇒ **改成 `background: $ftl-color-gold;`**

⚠️ **`.login` 上原来那些白卡的行也要处理掉**：`width: 900px;` · `max-height: 100%;` · `overflow-y: auto;` · `border: $ftl-hairline solid $ftl-color-border;` · `border-radius: $ftl-radius-lg;` · `background: $ftl-color-surface;` ⇒ **全部删除**（骨架由上面的 `.login__panel` 接管）。

⚠️ **`flex-direction: row` 必须改成 `column`**（这就是「单列」本身）。

**上面那一段**不是全部 —— Task 1 的评审逐条比对后指出**四处遗漏**，本步必须一并做掉：

```scss
/* ① 删掉整条规则（元素已在 Task 1 删除）：.login__hint { … } */

/* ② `.login__toggle-visibility`：原来在白色卡片上是 text-muted（深灰），
      压在深蓝面板上读不清 ⇒ 改浅色。注意它**不是** `.btn`，是字段内的次级动作。 */
.login__toggle-visibility {
  align-self: center;
  margin: 0;
  padding: 0;
  border: 0px;
  background: transparent;
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
  line-height: 1.4;
  cursor: pointer;
}

/* ③ 两条错误文案同理。⚠️ 取值用 `$ftl-color-danger-bg`（#ffebee）——
      它是危险色族里**唯一偏亮**的成员，压在深蓝面板上才读得出来。
      本片**禁止新增或修改令牌**（全局影响），所以只能这样复用；
      截图若观感不对，改的是这里，不是令牌。 */
.login__field-error,
.login__error {
  color: $ftl-color-danger-bg;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}

/* ④ `.btn--ghost` 现在**在面板外**、直接浮在蓝紫底纹上（Task 1 把它挪出来了）
      ⇒ 原来的 `text-secondary`（深灰）在渐变上读不清，改浅色 + 半透明白描边。 */
.btn--ghost {
  border-style: dashed;
  border-color: rgba($ftl-color-on-primary, 0.5);
  color: rgba($ftl-color-on-primary, 0.75);
}
```

🔴 **⑤ 还要重写 `<style>` 块顶部那段注释** —— 它现在**自相矛盾**：仍写着「画布 1334×750 里居中一张卡片，卡片内**左右两列**」并保留 R716「**必须两列**」的理由（那是实测约束的产物），而模板已经是单列。
新注释要写明：单列化是 D15 的用户决定；R716 那条「单列高 1222 > 750」的实测约束**仍然成立**，本片的应对是**压缩 + 面板内滚动兜底**（§3/§3.1），不是推翻它。

- [ ] **Step 3: 跑测试**

```bash
cd d:/Code/pokergame
pnpm --filter @fight-the-landlord/client test
```
预期：全绿。⚠️ **特别看 `table-bid-bottom`** —— 若它因 `.btn--primary` 改动而红，说明那条注释对页面文件**成立**（与既有记录冲突）⇒ 停下来上报，**不要**为它回退金色。

- [ ] **Step 4: 跑全门禁**

```bash
cd d:/Code/pokergame
pnpm run ci
```
预期：**六阶段全部通过**。⚠️ 本步会拦「裸十六进制色值」「手写 `1px`」「`rpx`」等 —— 上面给的 SCSS 全部走令牌，应当干净。

- [ ] **Step 5: 真浏览器测量（**规格 §6 的硬要求**）**

```bash
cd d:/Code/pokergame
# ① 起 dev server（若已在跑则跳过）
pnpm --filter @fight-the-landlord/client dev:h5
# ② 另开一个终端：无头 Chrome + CDP（本仓 measure-table.mjs 就是这个用法）
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --no-sandbox \
  --hide-scrollbars --window-size=1600,720 --remote-debugging-port=18800 \
  --user-data-dir="d:/Code/pokergame/.tmp_shots/profile" "http://localhost:5173/" &
# ③ 量（⚠️ `measure-table.mjs` 名字带 table，但它接受**任意** `--selector`）
node scripts/measure-table.mjs --cdp-port 18800 --selector .login__panel
node scripts/measure-table.mjs --cdp-port 18800 --selector .canvas
```

**读数怎么解释**：看输出里的 **`canvas`** 那一列 —— 那就是**画布坐标**（画布 1334×750）。
把 `.login__panel` 的 `canvas.h` 与 **750** 比：

- `≤ 750` ⇒ 装得下 ✅
- `> 750` ⇒ **按规格 §3.1 的杠杆表处理**（删第二颗按钮 ~108 / 确认密码挪并排 ~148 / 接受滚动），
  **并把决定与理由记下来**

🔴 **把实测数字写进规格 §6**：

```markdown
## 6. 验收记录（2026-09-27 实测）

| 项 | 登录态 | 注册态 |
|---|---|---|
| `.login__panel` canvas 高 | ___ | ___ |
| 画布可用高 | 750 | 750 |
| 是否装得下 | ✅/❌ | ✅/❌ |
| 杠杆决定 | ___ | |
```

- [ ] **Step 6: 截图（**观感的唯一判据**）**

复用同一套 CDP（或已有的 `.tmp_shots/shoot.mjs` 的做法）截两张：
- **登录态**（默认）→ 存 `.tmp_shots/pilot-login.png`
- **注册态**（点 `.login__seg-item` 的第二颗）→ 存 `.tmp_shots/pilot-register.png`

⚠️ 截图是给**用户**看的，不是给我看的 —— 交付时要说明**图在哪**。

- [ ] **Step 7: Commit**

```bash
cd d:/Code/pokergame
git add apps/client/src/pages/login/login.vue docs/superpowers/specs/2026-09-27-login-page-pilot-design.md
git commit -m "feat(client): 登录页样板 —— 视觉乙（半透明深蓝面板 + 金主按钮）+ 压缩 + 实测记录"
```

---

## Task 3: 验收（**需用户在场**）

**Files:** 无（可能回填规格 §6/§7）

- [ ] **Step 1: 把两张截图交给用户**，说明路径
- [ ] **Step 2: 问一句**：这套视觉语言**定不定**？
  - **定了** ⇒ 把定稿取值（哪一档金 / 哪一档深蓝 / 面板透明度 / 圆角 / 描边）**写回总规格 §5.2**，
    供其余三页照做（规格 §7）
  - **没定** ⇒ 记下差在哪（颜色？透明度？圆角？），改完再来一轮 —— **只亏一页**
- [ ] **Step 3: 把结论写进规格 §7** 并 commit

```bash
cd d:/Code/pokergame
git add docs/superpowers/specs/2026-09-27-login-page-pilot-design.md docs/superpowers/specs/2026-09-26-app-ui-rework-design.md
git commit -m "docs(spec): 登录页样板验收结论 —— 视觉语言定稿/回炉"
```

---

## Self-Review（写完计划后的自查）

**1. 规格覆盖**

| 规格节 | 落在哪个任务 |
|---|---|
| §1 范围（只改 login.vue） | Global Constraints |
| §2 已定（单列 + 视觉乙 + 主/次按钮） | Task 1（结构）+ Task 2（视觉） |
| §2.1 起始值 | Task 2 Step 2 的 SCSS **逐项落实** |
| §3 压缩（删 hint / logo 120 / gap 收紧 / 幽灵按钮挪位） | Task 1（hint、幽灵按钮）+ Task 2（logo、gap） |
| §3.1 杠杆（先量再砍） | Task 2 Step 5 |
| §4 不做（不删按钮 / 不改逻辑 / 不改令牌定义 / 不接槽） | Global Constraints + 范围外表 |
| §5.1 锚点 | Global Constraints（列出全部 7 类）+ Task 1 Step 1 的断言 ③ |
| §5.2 无锚点可自由重排 | Task 1 的自由度来源 |
| §6 验收（ci / **量高度** / 截图 / 用户判） | Task 2 Step 3–6 + Task 3 |
| §7 拍死后写回总规格 | Task 3 Step 2–3 |

**2. 占位符扫描**：无 TBD/TODO。两处 `___` 是**验收时要填的实测数字**（不是缺失内容 —— 它必须由测量产生）。
唯一「待定」是 Task 2 Step 5 的杠杆选择，**但它由读数决定且有明确判据**，不是猜。

**3. 类型一致性**：本片不引入任何 TS 类型。class 名在四处出现且逐字一致 ——
`.login__hint`（断言/删除/规格）· `.login__panel`（断言/SCSS/测量选择器）· `.btn--ghost`（断言/模板）· `.btn--primary`（断言/SCSS）。

**4. 一处我**故意没做**的**：Task 2 没有「写一个会红的测试」 —— 因为**这是纯视觉，jsdom 没有布局引擎**，
写出来的只能是「断言 CSS 文本里有没有某一行」那种**假判据**（本仓明令禁止）。
它的测试周期是：**既有 21 个锚点套件必须仍绿** + **真浏览器测量与截图**。这一点在 Task 2 的步骤里写明了。

**5. 一处**有意的顺序**：Task 1 先于 Task 2 —— 结构是可断言的（有真红），视觉不是。
先把可断言的部分锁死，再去改不可断言的部分，出问题时**归因清楚**。

**6. 一处**写计划时就抓到的错**（留痕，因为它是本仓反复出现的那一类）**：
Task 1 Step 1 的测试代码初稿是我**凭印象**写的 mount 姿势（`setActivePinia` + `mount(Login)`）。
核 `login-screen.test.ts:19-46` 后发现漏了三样，其中最要命的是
**`startGameSession(() => new FakeSocket())`** —— 缺它时 `restartGameSession()` 会抛成
**floating rejection**，vitest 记 unhandled error ⇒ **整包退出码 1**（那个文件的头注释逐字记着这个坑）。
⇒ 已改成**逐字照抄既有文件的 `beforeEach`/`afterEach`**。
**教训同族**：引用任何东西（代码姿势、判据、探针锚点）之前，**先去读它**。

---

## Task 2b: 布局修复（**由 Task 2 的实测暴露 —— 计划缺陷所致**）

**为什么有这一段**：Task 2 的 Step 5 让我的人比「`.login__panel` 的高度 ≤ 750」。
🔴 **那条判据是错的** —— **一个被 flex 挤压的滚动容器永远 ≤ 750** ⇒ 恒真、零判别力。
实测报 `455.4 ≤ 750 ✅`，而**真相是**：面板被挤压 ⇒ 内部滚动 ⇒
**登录态提交按钮卡在下沿、注册态提交按钮完全看不见**。

**真判据**（本段起用）：
- `.login__panel` 的 **`scrollHeight > clientHeight`** 就是「有内部滚动」⇒ **不得为真**；
- `.login` 的 **`scrollHeight`** 才是**内容总高** —— 拿它跟 **750** 比。

**Files:** Modify `apps/client/src/pages/login/login.vue`（**只动 `<style>`**）

- [ ] **Step 1: 拆掉「挤压」这个结构性问题**

```scss
.login {
  /* ⚠️ 整列可滚（内容真的超高时，用户能滚到按钮）——
     而不是让**面板**内部滚（那会把自己的按钮裁在看不见的地方）。 */
  overflow-y: auto;
}
.login__brand,
.login .btn--ghost {
  flex: 0 0 auto;          /* 不被压缩 */
}
.login__panel {
  /* ⚠️ 删掉 `max-height: 100%` 与 `overflow-y: auto` ——
     它们是「面板自己滚」的来源，而面板不该滚。 */
  flex: 0 0 auto;
}
```

- [ ] **Step 2: 修那条横跨画布的大胶囊**

```scss
/* Task 1 把幽灵按钮挪到了面板外、直接浮在渐变上，
   而 `width: 100%` 让它变成一条横跨 1294px 的蓝色大胶囊（截图可见）。
   ⇒ 改成**内容宽**、贴右下角 —— 它本来就是「不占主流程」的开发入口。 */
.login .btn--ghost {
  width: auto;
  margin: 0;
  align-self: flex-end;
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  font-size: $ftl-font-sm;
}
```

- [ ] **Step 3: 小项压缩（让登录态真的装下）**

| 项 | 由 | 改 |
|---|---|---|
| logo 高 | 120 | **96** |
| `.login__title` 字号 | `$ftl-font-xl`(40) | **`$ftl-font-lg`(32)** |
| `.login__panel` 内边距 | `$ftl-space-8`(24) | **`$ftl-space-6`(16)** |
| `.login__panel` gap | `$ftl-space-5`(12) | **`$ftl-space-4`(8)** |
| `.login` gap | `$ftl-space-5`(12) | **`$ftl-space-4`(8)** |

- [ ] **Step 4: 重测（**用真判据**）**

```bash
node scripts/measure-table.mjs --cdp-port 18800 --selector .login__panel
node scripts/measure-table.mjs --cdp-port 18800 --selector .login
```
并把**滚动的有无**单独量出来（两条 `Runtime.evaluate`，任选 CDP 工具）：

```js
document.querySelector('.login__panel').scrollHeight - document.querySelector('.login__panel').clientHeight   // 必须 = 0
document.querySelector('.login').scrollHeight                                                                 // 这才是内容总高
```

- [ ] **Step 5: 把结论记进规格 §6**，包括：
  - `scrollHeight`（登录/注册）vs 750
  - 是否还有内部滚动
  - **若注册态仍超 750** ⇒ 从 §3.1 的三个杠杆里选一个并记下理由
    （注：**「确认密码挪并排」约省 148** 是现成的、`login.vue` 自己的注释就认可它是表单设计）

- [ ] **Step 6: 重截图**（同 Task 2 Step 6 的两张，覆盖同名文件）

- [ ] **Step 7: Commit**

---

## Task 2c: 视觉语言定稿（用户已把这一项授权给控制者）

**用户 2026-09-27 的三条裁决**：
① **视觉语言由控制者定**（「统一风格就行」）② **修**幽灵按钮的涂装 ③ **注册态超 122 不动**（不用杠杆②）

**Files:**
- Modify `apps/client/src/pages/login/login.vue`（`<style>`）
- Modify `apps/client/src/uni.scss`（**只新增一个令牌**，不改任何现有值 —— 同片① 的「只加不改」）
- Modify `docs/superpowers/specs/2026-09-26-app-ui-rework-design.md` §5.2（**写回定稿语言**）
- Modify `docs/superpowers/specs/2026-09-27-login-page-pilot-design.md` §6/§7（验收结论）

- [ ] **Step 1: 新增一个令牌（**唯一的 `uni.scss` 改动**）**

在 `uni.scss` 的**颜色段**、`$ftl-color-danger-bg` **之后**插入：

```scss
/// 深色底上的危险文字色（片② 登录页样板引入）。
///
/// ⚠️ **为什么需要它**：`$ftl-color-danger`(#c62828) 在白色卡片上没问题，
/// 但样板把表单搬进了**半透明深蓝面板** ⇒ 深红压深蓝读不出来。
/// 样板初期只能借用 `$ftl-color-danger-bg`(#ffebee) 当文字色 —— 那**功能对、语义错**
/// （`-bg` 是「淡色底」的意思）。本令牌把那个借用**扶正**，
/// 使这套视觉语言可以被其余三页**照抄而不传播坏习惯**。
/// ⚠️ **只加不改**：本步不动任何现有令牌的值（同片① 的纪律）。
$ftl-color-danger-on-dark: #ff8a80;
```

- [ ] **Step 2: 改用新令牌**

`login.vue` 里那条把错误文案染色的合并规则改成：

```scss
/* ⚠️ 用专用令牌，**不再借用 `$ftl-color-danger-bg`** ——
   那是「淡色底」，当文字色用是语义滥用（评审 T2-M5）。 */
.login__field-error,
.login__error {
  color: $ftl-color-danger-on-dark;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
```

- [ ] **Step 3: 修幽灵按钮的涂装（评审 T2-M3，截图里肉眼可见）**

`login.vue` 的 `.login .btn--ghost` 块**补上覆盖**（`ftl-btn` mixin 给了它白底 + 蓝贴图，
几何上一轮改了、涂装没改 ⇒ 现在渲染成「蓝色胶囊外套一圈白色板子」）：

```scss
/* ⚠️ 必须**覆盖 mixin 的白底与贴图** —— 它现在不在白色卡片里，而是**直接浮在渐变上**，
   白底贴图会渲染成一圈白板子（截图可见）。 */
.login .btn--ghost {
  flex: 0 0 auto;
  width: auto;
  margin: 0;
  align-self: flex-end;
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  border-style: dashed;
  border-color: rgba($ftl-color-on-primary, 0.45);
  background: transparent;
  background-image: none;
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-sm;
}
```

⚠️ **`flex: 0 0 auto;` 那一行是 Task 2b 加的（防它在 flex 列里被压扁），本步的替换块必须带上它** ——
初稿漏抄了它，执行时造成一次**静默回归**（计划缺陷，已订正）。

- [ ] **Step 4: 面板再立住一点（控制者的观感判断）**

`.login__panel` 的底色由 `rgba($ftl-color-night, 0.55)` 改成 **`0.62`** ——
截图显示面板**下半截**压在渐变的浅色区上时边界感偏弱。

- [ ] **Step 5: 跑测试 + 门禁**

```bash
pnpm --filter @fight-the-landlord/client test     # 登录页锚点套件必须仍绿
pnpm run ci                                       # 六阶段
```
⚠️ Step 1 动了 `uni.scss` —— 必须确认 `ui-tokens` 的 M09 扫描、px 计数自证、以及
`asset-budget` 等**全部仍绿**（加一个颜色令牌不加 px 字面量，px 计数只涨不跌）。

- [ ] **Step 6: 重测 + 重截图**（同 Task 2b Step 4/6 的判据与文件名）

- [ ] **Step 7: 把定稿的视觉语言写回总规格 §5.2**

在 `2026-09-26-app-ui-rework-design.md` 的 §5.2「令牌重做」之后**追加一节 §5.2.1「视觉语言定稿」**，
内容 = 下面这张表（**其余三页照它做**）：

```markdown
### 5.2.1 视觉语言定稿（登录页样板拍板，2026-09-27）

| 元素 | 定稿值 | 出处 |
|---|---|---|
| 半透明面板底 | `rgba($ftl-color-night, 0.62)` | 样板实测（0.55 在浅色渐变区立不住） |
| 面板描边 | `$ftl-hairline` 实线 `$ftl-color-night-deep` | 令牌 |
| 面板圆角 | `$ftl-radius-lg`（16px） | 令牌 |
| 主按钮 | `background: $ftl-color-gold` + 描边 `$ftl-color-gold-deep` + 白字 | 令牌 |
| 次按钮 | 透明底 + `$ftl-hairline` 实线 `$ftl-color-night-soft` + 白字 | 令牌 |
| 幽灵/弱化按钮 | 透明底 + `$ftl-hairline` **虚线** `rgba(on-primary,.45)` + 浅白字；**必须覆盖 `ftl-btn` 的白底与贴图** | 样板实测 |
| 面板内标签文字 | `rgba($ftl-color-on-primary, 0.75)` | 样板实测 |
| 深色底上的错误文字 | `$ftl-color-danger-on-dark`（**新令牌**） | 本片新增 |
| 大标题 | 白字 + 多层 `text-shadow` 深色描边 | 样板实测（`-webkit-text-stroke` 多端不一致，未采用） |
| 输入框 | 保持 `$ftl-color-surface` 白底 + `$ftl-color-text` 深字 | 参考图 1 的浅色卡片语言 |
```

- [ ] **Step 8: 把验收结论写进样板规格 §7**，含**用户的三条裁决原文**与
  「注册态 872 > 750，**用户裁决不动杠杆②**，接受整列滚动」这条。

- [ ] **Step 9: Commit**

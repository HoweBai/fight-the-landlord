# 横屏底座与单位体系（片①）实施计划

> ## ✅ 本计划已执行完毕（2026-09-21）
>
> **结果**：7 个 Task 全部收口。`pnpm run ci` **六阶段全绿** · client **482 passed + 2 skipped** ·
> 8 个契约测试的字面 `it(`/`it.each(` **恰好 65**（与基线一致，**一条没减**）·
> `build:h5` + `build:app` 均 DONE · 真浏览器探针 **16/16** · `browser-e2e.mjs` **零改动**。
>
> ⚠️ **下面 Step 的复选框有意保持未勾选**：本计划是**按方法执行**的，执行期有**重大偏离**。
> **真实记录不在这里**：
>
> | 想知道什么 | 去哪看 |
> |---|---|
> | **9 条执行期发现**（含一条**改变设计本身**的：基准缩放 S=2 → S=1） | **spec §8**：`docs/superpowers/specs/2026-09-21-landscape-foundation-design.md` |
> | 片① 的完成状态表（逐项实测值） | 同文件 **§9** |
> | 每个决策的理由 | `git log b3cd128..HEAD`（8 个实施提交 + 3 个订正提交） |
>
> **⚠️ 最重要的一条偏离**（spec §8 F1）：Task 2 定的**基准缩放 ×2 是错的** ——
> 由 Task 4 的**真浏览器测量**抓出（登录卡片 2444 > 画布 750），改成 **S=1**。
> 原因是「画布高 750 ≈ 旧坐标系 375 的 2 倍」**把宽和高搞混了**：
> 登录页要装进 750 需 S ≤ 1.07，而手牌铺满画布宽需 S ≈ 1.67 —— **相差 2.7 倍，单一均匀缩放无解**，
> 基准取最紧的那个、牌面留给片②。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让客户端在**横屏**下有一套可算术验证的尺寸模型（固定画布 1334×750 + 等比缩放），并把它内部的单位体系从 `rpx` 换成 `px` —— 三页先横过来能玩，**不精修**。

**Architecture:** 新增 `LandscapeStage.vue` 承担「全视口底纹 + 居中画布 + 等比缩放 + 竖屏提示」；缩放比 `k` 由**同步纯函数**算出（`setup()` 里算，无 FOUC、无定时器）。单位体系整体从 `rpx` 翻到 `px`，并**翻转 `ui-tokens` 闸的规则、自证与正反对照**（三件一起改）。

**Tech Stack:** TypeScript 5.7 · Vue 3 + uni-app（H5 + App）· vitest + jsdom · pnpm + turbo

**Spec:** `docs/superpowers/specs/2026-09-21-landscape-foundation-design.md`（v1，497 行，已过三轮独立回核）

**上游（已合入 `master`，勿重读计划）：**
- `docs/superpowers/plans/2026-09-21-suit-assets-side.md`（素材/观感侧；其「执行期发现」的方法论本片照用）
- `docs/superpowers/specs/2026-09-21-landscape-foundation-design.md` §1.4（**全局约束的真源**）

---

## Global Constraints

> 逐字取自 spec §1.4（**R723**），适用于**每一个** task。与单位体系有关的那条已按 **R711** 改写。

1. **范围 = H5 + App**（R701）。小程序端排除在**一切设计/开发/测试**之外：不删代码、不做适配、不入任何门禁、不为它写用例。
   ⚠️ 本片**会连带改变 mp 构建的输入**（同一份源码、单位换 px）⇒ mp 可能跟着坏，**而它不被任何门禁覆盖** —— R701 已接受的代价，不在本片修复。
2. **锚点零改动**：9 个探针 class 一个不改；**`scripts/browser-e2e.mjs` 本片零改动**（首次改动在片③）。
3. **判据只增不减**：8 个契约测试的字面 `it(`/`it.each(` 计数基线 **65**（63 + 2），逐文件核对。
4. **样式只用令牌**（`src/uni.scss` 的 `$ftl-*`）。⚠️ **本片起单位是 `px`（R711）**；发丝线一律 `$ftl-hairline`（R714）。
5. **`uni.xxx()` 必须是直接成员调用**（闸：`uni-api-access`）；**不得用 `document` / `window` / `fetch`**；不得 `typeof import.meta`。
6. **scoped 样式只到子组件根节点**：抽进子组件的元素**必须自持样式**。
7. **模板注释只能放单根元素内部**（放根前 ⇒ 组件变多根、`classes()` 静默返回 `[]`）。⚠️ 本片给三页套 `<LandscapeStage>` 时是高发点。
8. **`mount()` 看不见样式** ⇒ 观感类改动只能用**产物 CSS / 真浏览器走查**证明，**不要造假判据**。
9. **门禁口径**：`turbo run build --force` 对 client **只出 h5** ⇒ App 必须单独跑 `build:app`（R669）；探针**独占**跑（`kill -TERM -<pgid>`，**禁止** `pkill -f vite`）。
10. **证据卫生（R682）**：门禁日志的 mtime 必须**晚于**最后一次改动/commit。
11. **提交**：每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。**禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

### 共享验证命令

```bash
# 客户端类型检查（含 .vue）
pnpm --filter @fight-the-landlord/client lint          # = vue-tsc --noEmit
# 客户端单测
pnpm --filter @fight-the-landlord/client test
# 单文件
pnpm --filter @fight-the-landlord/client test -- ui-tokens
# 逐端构建（turbo build 只出 h5）
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
# 真浏览器探针（独占；本机可跑 —— 见下方⚠️）
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
# 全仓收口
pnpm run ci
```

> ⚠️ **本机探针的三条绕法**（缺一条就跑不起来）：自己起 `pnpm dev:h5` + `--no-server`；
> 设 `CHROME_BIN='C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe'`；
> **`--cdp-port 18800`**（探针默认的 `9333` 与文档建议的 `9444` **都落在 Windows 保留区间**，会 `WSAEACCES`）。
> ⚠️ **Windows**：`pnpm lint` 找不到 `tsc` 说明装漏了，先 `pnpm install`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `apps/client/src/composables/useLandscapeCanvas.ts` | **新增**。画布常量 + `landscapeScale` / `isPortrait` 纯函数 + 取 insets 的薄适配（含 `try/catch` 失败模式） |
| `apps/client/src/components/LandscapeStage.vue` | **新增**。`.stage`（全视口 + 底纹 + 安全区 padding + `overflow:hidden`）+ `.canvas`（1344？否 —— 1334×750，居中，`scale(k)`）+ 竖屏提示层。**唯一持有底纹的地方** |
| `apps/client/src/uni.scss` | **改**。33 个尺寸令牌 `rpx` → `px`（×2）；新增 `$ftl-hairline: 2px`；`ftl-btn` mixin 的 `1px` 改 `$ftl-hairline` |
| `apps/client/src/pages.json` | **改**。`globalStyle.navigationStyle: 'custom'` |
| `apps/client/src/pages/{login,lobby,table}/*.vue` | **改**。套 `<LandscapeStage>`；各自横屏骨架重排 |
| `apps/client/src/manifest.json` | **改**。`app-plus.screenOrientation` |
| `apps/client/test/landscape-canvas.test.ts` | **新增**。缩放纯函数单测 + 极端宽高比 + 竖屏识别 |
| `apps/client/test/ui-tokens.test.ts` | **改**。闸的**规则 + 自证 + 正反对照**三件一起反转 |
| `apps/client/test/card-hand-interaction.test.ts` | **改**。F1 算账的阈值 `710` → `1254`（**数字变，断言结构不变**） |

---

## Task 1: 画布底座（纯函数 + 组件 + 单测）

**Files:**
- Create: `apps/client/src/composables/useLandscapeCanvas.ts`
- Create: `apps/client/src/components/LandscapeStage.vue`
- Create: `apps/client/test/landscape-canvas.test.ts`

**Interfaces:**
- Produces:
  - `CANVAS_W = 1334` · `CANVAS_H = 750`（`number`）
  - `interface Insets { top: number; right: number; bottom: number; left: number }`
  - `landscapeScale(w: number, h: number, insets?: Partial<Insets>): number`
  - `isPortrait(w: number, h: number): boolean`
  - `readViewport(): { w: number; h: number; insets: Insets }`（薄适配，含 `try/catch`）
  - `LandscapeStage` 组件：默认插槽渲染在画布内

---

- [ ] **Step 1: 先确认基线是绿的**

```bash
cd /d/Code/pokergame
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿（约 462 passed + 2 skipped）。**若这里就是红的，先停下来修基线。**

- [ ] **Step 2: 写失败的测试**

创建 `apps/client/test/landscape-canvas.test.ts`：

```ts
/**
 * 横屏画布的**缩放模型**（spec §2 / R709–R712）。
 *
 * ⚠️ **判据射程**：这是**纯函数**的判据 —— 它证明「给定视口，算出的 k 是对的」，
 * **不证明**「按这个 k 缩放后页面好看」。后者只能由真浏览器走查证明（spec §1.4-8）。
 *
 * ⚠️ **不要写「k×1334 ≤ 视口宽」这类断言**：`k ≡ min(w/W, h/H)` ⇒ 它**按定义恒真**，
 * 零判别力、会伪装成「已验证」（spec 自审 #1）。要断言的是**极端宽高比下的可用性**。
 */
import { describe, expect, it } from 'vitest';
import { CANVAS_W, CANVAS_H, landscapeScale, isPortrait } from '../src/composables/useLandscapeCanvas';

describe('① landscapeScale：典型设备上的缩放比', () => {
  it.each([
    // [视口宽, 视口高, 期望 k, 说明]
    [866, 390, 0.52, '手机 19.5:9 —— 高度受限'],
    [812, 375, 0.5, '手机 16:9（812×375）—— k 恰好 0.5'],
    [1024, 768, 0.768, '平板 4:3 —— 宽度受限'],
    [1440, 800, 1.067, '桌面 —— 缩放 > 1'],
  ])('%i×%i ⇒ k ≈ %f（%s）', (w, h, expected) => {
    expect(landscapeScale(w, h)).toBeCloseTo(expected, 3);
  });

  it('恒定性质：画布**等比**且**不溢出安全区**（用具体数值验，不用恒真式）', () => {
    const w = 866, h = 390;
    const k = landscapeScale(w, h);
    // 比例严格保持（这是 k 的定义要保证的观感属性）
    expect(k * CANVAS_W / (k * CANVAS_H)).toBeCloseTo(CANVAS_W / CANVAS_H, 6);
    // 与手算的比较（0.52 = 390/750，高度受限）
    expect(k).toBeCloseTo(390 / CANVAS_H, 6);
  });
});

describe('② 极端宽高比下的可用性（**有判别力**的那条）', () => {
  /**
   * 这条防的是「画布缩成中间一小条、两边全是底纹」。
   * 超宽视口（如带鱼屏 / 浏览器拉得很宽）时 k 由**高度**决定，
   * 画布实占宽度可能远小于视口宽 —— 这是甲方案的已知代价（spec §7-4），
   * 但不能低到不可用。阈值是**人的取舍**，定在这里当契约。
   */
  it('超宽视口 3000×400：画布仍占视口宽的 ≥ 20%', () => {
    const w = 3000, h = 400;
    const k = landscapeScale(w, h);
    expect(k * CANVAS_W / w, '画布实占宽比').toBeGreaterThanOrEqual(0.2);
  });

  it('极端窄高视口 400×900（竖屏）：k 仍 > 0（不产生 0 或负数）', () => {
    expect(landscapeScale(400, 900)).toBeGreaterThan(0);
  });

  it('判别力自证：把 k 的定义改错（不取 min 而取 max）⇒ 上面那条会红', () => {
    // 合成一个错误实现，证明「可用性」这条判据真的能抓错
    const wrong = (w: number, h: number) => Math.max(w / CANVAS_W, h / CANVAS_H);
    const w = 3000, h = 400;
    expect(wrong(w, h) * CANVAS_W / w, '错误实现应当越界').toBeGreaterThan(1);
  });
});

describe('③ 安全区参与计算', () => {
  it('左侧有刘海（left=44）⇒ 可用宽减少，k 变小', () => {
    const noInset = landscapeScale(866, 390);
    const withInset = landscapeScale(866, 390, { left: 44 });
    expect(withInset).toBeLessThan(noInset);
    expect(withInset).toBeCloseTo((866 - 44) / CANVAS_W, 6);
  });

  it('安全区大到超过视口 ⇒ 不产生 0 / 负数 / NaN（用 max(1, …) 兜住）', () => {
    const k = landscapeScale(100, 100, { left: 200, right: 200, top: 200, bottom: 200 });
    expect(Number.isFinite(k)).toBe(true);
    expect(k).toBeGreaterThan(0);
  });
});

describe('④ isPortrait：竖屏识别（正反两面）', () => {
  it.each([
    [375, 812, true, '手机竖屏'],
    [812, 375, false, '手机横屏'],
    [768, 1024, true, '平板竖屏'],
    [1024, 768, false, '平板横屏'],
    [812, 812, false, '正方形 ⇒ 不算竖屏'],
  ])('%i×%i ⇒ %s（%s）', (w, h, expected) => {
    expect(isPortrait(w, h)).toBe(expected);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm --filter @fight-the-landlord/client test -- landscape-canvas
```

Expected: FAIL —— `Failed to resolve import "../src/composables/useLandscapeCanvas"`。

- [ ] **Step 4: 实现 `useLandscapeCanvas.ts`**

```ts
/**
 * 横屏画布的尺寸模型（spec §2 / R709–R712）。
 *
 * ## 为什么要 JS 算而不是 CSS `min()` + `vw/vh`
 *
 * · **`ui-tokens` 闸禁用 `vw`/`vh`** ⇒ 用 CSS 方案要再开一次白名单；JS 方案**一个字都不用改闸**；
 * · App 端不依赖 CSS 单位的支持程度；
 * · **纯函数可单测** —— 本片没有设备实验室，「适配」这件事唯一的机械验证手段就是这个。
 *
 * ## 为什么是**同步**算（不是异步回调里赋值）
 *
 * `uni.getSystemInfoSync()` 是**同步**的 ⇒ `k` 在 `setup()` 里就算得出来 ⇒ **首帧就是对的**。
 * 这消除了三个问题：FOUC、初始隐藏、以及「隐藏期间 JS 一失败就永久白屏」。
 * （候选修法「超时兜底」**不可用**：`animations.test.ts` 扫 `src/components/**` 的 `setTimeout`。）
 */

/** 设计画布尺寸（16:9，与参考图 1936×1087 同比例 ⇒ 可 1:1 誊写）。 */
export const CANVAS_W = 1334;
export const CANVAS_H = 750;

/** 安全区（刘海 / 挖孔）。 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** 视口信息（视口尺寸 + 安全区）。 */
export interface Viewport {
  w: number;
  h: number;
  insets: Insets;
}

/**
 * 画布缩放比 = min(可用宽/画布宽, 可用高/画布高)。
 *
 * ⚠️ `Math.max(1, …)` 兜住「安全区比视口还大」的病态输入 ⇒ **不产生 0 / 负数**。
 */
export function landscapeScale(w: number, h: number, insets: Partial<Insets> = {}): number {
  const i = { ...ZERO_INSETS, ...insets };
  const usableW = Math.max(1, w - i.left - i.right);
  const usableH = Math.max(1, h - i.top - i.bottom);
  return Math.min(usableW / CANVAS_W, usableH / CANVAS_H);
}

/** 是否竖屏。⚠️ 正方形（h === w）**不算**竖屏。 */
export function isPortrait(w: number, h: number): boolean {
  return h > w;
}

/**
 * 从宿主读取视口与安全区。
 *
 * ⚠️ **失败模式必须有，且不依赖成功路径**：`getSystemInfoSync()` 一旦抛错或返回异常值，
 * 用保守值兜住 —— **内容可能被裁，但不会白屏**（spec §2.3 / 全局约束的 R693 同族纪律）。
 */
export function readViewport(): Viewport {
  try {
    const info = uni.getSystemInfoSync();
    const insets = (info.safeArea ?? null) as
      | { top: number; left: number; right: number; bottom: number }
      | null;
    return {
      w: Number(info.windowWidth) || 0,
      h: Number(info.windowHeight) || 0,
      insets: insets
        ? {
            top: insets.top ?? 0,
            left: insets.left ?? 0,
            right: Math.max(0, (Number(info.windowWidth) || 0) - (insets.right ?? 0)),
            bottom: Math.max(0, (Number(info.windowHeight) || 0) - (insets.bottom ?? 0)),
          }
        : { ...ZERO_INSETS },
    };
  } catch {
    // 宿主能力缺失 ⇒ 交给调用方的保守兜底（见 LandscapeStage）
    return { w: 0, h: 0, insets: { ...ZERO_INSETS } };
  }
}
```

> ⚠️ **`safeArea` 的语义**：uni 返回的 `safeArea` 是**安全框矩形**（`{left, top, right, bottom}` 为**坐标**，不是 inset 宽度）。
> 所以右/下要转成「视口 − 坐标」。上面已经这么算了。
> **实施时必须用真浏览器确认一次**（spec §2.3 已登记此为「未验事项」）；若字段不可用，
> 回落方案是 CSS `env(safe-area-inset-*)`（`env()` 不含被禁单位，闸能过）。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @fight-the-landlord/client test -- landscape-canvas
pnpm --filter @fight-the-landlord/client lint
```

Expected: PASS（≥10 条）。

- [ ] **Step 6: 实现 `LandscapeStage.vue`**

```vue
<script setup lang="ts">
/**
 * 横屏舞台（spec §2.2 / R710–R713）。
 *
 * 结构（**底纹只在最外层铺一次** —— 铺两层会因缩放比不同而错位，R713）：
 *
 *   .stage   position:fixed; inset:0; padding:安全区; overflow:hidden
 *            background = new_BJ.png / cover      ← 留边区域也显示底纹（不是黑边）
 *     ├─ 竖屏 ⇒ 旋转提示层
 *     └─ .canvas  1334×750，在安全框内居中，transform: scale(k)
 *
 * ⚠️ **`position: fixed` 在这里成立的两个实测前提**（spec 回核 #22）：
 *   ① 被 transform 捕获的是 fixed 的**祖先链** —— `.stage` 自身无 transform，
 *      而 `.canvas` 的后代经实测全仓**零 fixed**；
 *   ② 页面壳 `uni-page-wrapper` 是 `position: relative` —— **relative 不捕获 fixed**。
 *
 * ⚠️ **`k` 是同步算的**：`setup()` 里就算出来 ⇒ 首帧即正确，无 FOUC、无初始隐藏、无定时器。
 *    「初始隐藏」那版修法**已被推翻**（它让 JS 一失败就永久白屏）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { CANVAS_H, CANVAS_W, isPortrait, landscapeScale, readViewport } from '../composables/useLandscapeCanvas';

defineOptions({ name: 'LandscapeStage' });

/** 宿主读取失败时的保守兜底：手机上一定放得下（内容可能被裁，但不白屏）。 */
const FALLBACK_K = 0.5;

const viewport = ref(readViewport());

const k = computed(() => {
  const { w, h, insets } = viewport.value;
  if (!(w > 0 && h > 0)) return FALLBACK_K; // 宿主能力缺失 ⇒ 保守兜底
  const scaled = landscapeScale(w, h, insets);
  return scaled > 0 ? scaled : FALLBACK_K;
});

/** 竖屏 ⇒ 只显示旋转提示（App 锁横屏后基本不会为真，H5 会）。 */
const portrait = computed(() => {
  const { w, h } = viewport.value;
  return w > 0 && h > 0 ? isPortrait(w, h) : false;
});

/**
 * 窗口变化时重算（spec §2.3 / R721）。
 *
 * ⚠️ **只能用 `uni.onWindowResize`** —— 本仓禁 `document` / `window`（全局约束 5），
 * `window.addEventListener` 走不通。offWindowResize 必须**成对**调用，否则泄漏 + 卸载后仍回调。
 */
function refresh() {
  viewport.value = readViewport();
}
onMounted(() => {
  uni.onWindowResize(refresh);
});
onUnmounted(() => {
  uni.offWindowResize(refresh);
});

const canvasStyle = computed(() => ({
  width: `${CANVAS_W}px`,
  height: `${CANVAS_H}px`,
  transform: `scale(${k.value})`,
}));
</script>

<template>
  <view class="stage">
    <view v-if="portrait" class="stage__rotate">
      <text class="stage__rotate-title">请旋转设备</text>
      <text class="stage__rotate-hint">本游戏以横屏游玩</text>
    </view>
    <view v-else class="canvas" :style="canvasStyle">
      <slot />
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * 全视口舞台。⚠️ `overflow: hidden` **常驻**（不只在失败路径）—— 整页不滚动（spec §2.2）。
 */
.stage {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* ⚠️ 全仓**唯一**一处底纹（判据：new_BJ.png 在 src/** 只出现一次，R713） */
  background-color: $ftl-color-table-center;
  background-image: url('/static/ui/new_BJ.png');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
/** 画布：固定坐标系，缩放由 transform 承担；**flex 居中**让页面的根内容在画布中央。 */
.canvas {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  transform-origin: center center;
}
/** 竖屏提示层。 */
.stage__rotate {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-6;
  align-items: center;
  justify-content: center;
}
.stage__rotate-title {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-xl;
  font-weight: 700;
}
.stage__rotate-hint {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
}
</style>
```

> ⚠️ **安全区 padding**：`.stage` 上の `padding` 用 insets 由 `:style` 绑（因为 insets 是运行期的）。
> 在 `<script setup>` 里加一个 `stageStyle` computed：
> ```ts
> const stageStyle = computed(() => {
>   const { insets } = viewport.value;
>   return {
>     paddingTop: `${insets.top}px`,
>     paddingRight: `${insets.right}px`,
>     paddingBottom: `${insets.bottom}px`,
>     paddingLeft: `${insets.left}px`,
>   };
> });
> ```
> 并把它绑到 `.stage` 上（`<view class="stage" :style="stageStyle">`）。
> 这样 `.canvas` 是在**安全框内**居中 —— 不做的话，不对称的安全区（横屏刘海常在一侧）
> 会让画布压进刘海（spec 回核 #12）。

- [ ] **Step 7: 跑测试 + 类型检查**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
```

Expected: 全绿。`LandscapeStage.vue` 此时**还没有被任何页面使用**，但它的 `<style>` 会被 `ui-tokens` 扫描 —— 里面的 `$ftl-*` 令牌此刻还是 `rpx`，**仍然合法**（Task 2 才翻转闸）。

- [ ] **Step 8: 提交**

```bash
git add apps/client/src/composables/useLandscapeCanvas.ts \
        apps/client/src/components/LandscapeStage.vue \
        apps/client/test/landscape-canvas.test.ts
git commit -m "$(cat <<'EOF'
feat(client): 横屏画布底座 —— 缩放纯函数 + LandscapeStage（R710/R712）

片① Task 1：
- useLandscapeCanvas：CANVAS 1334×750 + landscapeScale/isPortrait 纯函数 + readViewport
  （含 try/catch 失败模式 ⇒ 内容可能被裁但不白屏）
- LandscapeStage.vue：.stage（全视口+底纹+安全区+overflow:hidden）+ .canvas（scale(k)）
  + 竖屏旋转提示；uni.onWindowResize/offWindowResize 成对
- ⚠️ k 是**同步**算的（getSystemInfoSync 同步）⇒ 无 FOUC、无初始隐藏、无定时器。
  「初始 visibility:hidden + 兜底」那版修法已被推翻（JS 一失败就永久白屏）；
  候选的「超时兜底」也不可用 —— animations.test.ts 扫 src/components/** 的 setTimeout。
- 判据：缩放比逐设备断言 + 极端宽高比可用性（**有判别力**，非恒真式）
  + 安全区参与 + 竖屏识别正反两面 + 判别力自证

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 单位体系 `rpx` → `px`（含闸的翻转）

**这是本片唯一一次翻闸，也是**视觉 no-op**的一个安全任务** —— 理由见下。

**Files:**
- Modify: `apps/client/src/uni.scss`
- Modify: `apps/client/test/ui-tokens.test.ts`
- Modify: `apps/client/test/card-hand-interaction.test.ts`（F1 阈值）

**Interfaces:**
- Consumes: 无（纯内部换算）
- Produces: 33 个 `$ftl-*` 尺寸令牌的新 px 值；新令牌 `$ftl-hairline`

### ⚠️ 为什么「×2」是视觉 no-op（先读懂再动手）

旧设计的坐标系是 **375 逻辑宽**，`1rpx = 0.5px` ⇒ `72rpx = 36px`。
画布高 **750** ≈ 375 的 **2 倍** ⇒ 令牌值 **×2** 之后，在**同样的屏**上物理尺寸不变。

**实测**（spec §2.1 / 回核）：手机横屏 812×375 ⇒ `k = 0.5` ⇒ `144 设计 px × 0.5 = 72 物理 px`，
而旧的 `72rpx` 在竖屏是 36 物理 px。横向空间约 2.2 倍 ⇒ 牌放大 2 倍是**合理的横屏尺度**。
参考图实测「手牌行高 = 屏高的 27.9%」；本方案 `188/750 = 25.1%` ✅ 同量级。

---

- [ ] **Step 1: 跑一遍既有闸，记下基线**

```bash
pnpm --filter @fight-the-landlord/client test -- ui-tokens
```

Expected: PASS（10 条）。**记下这个数** —— Task 收尾时要核对「只增不减」。

- [ ] **Step 2: 改 `uni.scss` 的 33 个尺寸令牌（×2）+ 新增 `$ftl-hairline`**

❗ **逐条替换**，不要「搜 rpx 全替换」—— `uni.scss` 里还有 `$ftl-*` 的**非尺寸**令牌（颜色/URL），
以及注释里出现的 `rpx` 字样（注释不被闸扫，但改它们会污染 diff）。

| 令牌 | 旧（rpx） | 新（px） |
|---|---|---|
| `$ftl-space-2` … `-10` | 4, 6, 8, 12, 16, 20, 24, 32, 40 | **8, 12, 16, 24, 32, 40, 48, 64, 80** |
| `$ftl-font-xs/sm/md/lg/xl/xxl` | 22, 26, 28, 32, 40, 56 | **44, 52, 56, 64, 80, 112** |
| `$ftl-font-card` / `-card-small` / `-card-corner` | 40, 28, 24 | **80, 56, 48** |
| `$ftl-card-w` / `-h` / `-w-small` / `-h-small` | 72, 94, 48, 62 | **144, 188, 96, 124** |
| `$ftl-card-overlap` / `-lift` | 40, 24 | **88, 48** |
| `$ftl-radius-sm/md/lg/pill` | 8, 12, 16, 999 | **16, 24, 32, 1998** |
| `$ftl-control-h` / `-h-sm` | 88, 56 | **176, 112** |
| `$ftl-size-avatar` / `$ftl-size-countdown` | 72, 8 | **144, 16** |
| `$ftl-panel-slice` | 24 | **48** |

**新增令牌**（紧挨 `$ftl-card-lift` 之后）：

```scss
/// 发丝线（描边）宽度。
///
/// ⚠️ **为什么是 2px 而不是 1px**：画布会被 `transform: scale(k)` 缩放，手机横屏上 `k ≈ 0.52`
/// ⇒ `1px` 实际渲染 **0.52px**，而 `ui-tokens` 白名单原本那条理由逐字写着
/// 「多端在 1px 以下会渲染不出来」⇒ **会直接消失**。
/// 2px 缩后 ≈ 1.04px ⇒ 看得见。
$ftl-hairline: 2px;
```

**改 `ftl-btn` mixin 的描边**（它是**所有按钮**的边框来源）：

```scss
// 旧：border: 1px solid $ftl-color-border-control;
border: $ftl-hairline solid $ftl-color-border-control;
```

- [ ] **Step 3: 跑 lint + 找剩下的 `rpx`**

```bash
pnpm --filter @fight-the-landlord/client lint
grep -rn "rpx" apps/client/src --include=*.vue --include=*.scss --include=*.ts | grep -v "^\s*//" | grep -v "\*"
```

Expected: lint 过；grep **只剩注释里的 rpx 字样**（注释里出现 rpx 是解释历史，允许保留）。
⚠️ 若有**代码里的 rpx**（如 `uni.scss` 的 `repeating-linear-gradient` 里那几处 `6rpx`/`8rpx`/`4rpx`），
**一并 ×2 改掉** —— 它们也是尺寸。

- [ ] **Step 4: 翻转 `ui-tokens` 闸 —— 规则 + 自证 + 正反对照，三件一起改**

❗ **这一步是 R722 的落点**：只改规则不改判据 ⇒ 判据失效。

**① 撤掉 px 白名单里的发丝线条目**（`PX_WHITELIST` 只留 `0px`）：

```ts
const PX_WHITELIST: ReadonlyArray<{ re: RegExp; why: string }> = [
  {
    re: /(?:^|[;{])\s*[a-z-]+:\s*0px;/,
    why: '零值显式写单位（等价于 0，保留是为了让「0 也带单位」的写法不必改写）。',
  },
  // ⚠️ R714：原「border: 1px solid …」那条**已撤** —— 发丝线改用 $ftl-hairline（2px），
  //    因为画布缩放（k ≈ 0.52）会把 1px 缩到 0.52px 而渲染不出来。
];
```

**② 把「禁 px」整段改成「禁 rpx」**（新增一个 offender 函数，与 `pxOffenders` 对称）：

```ts
/**
 * rpx 违规（R711）：本片起尺寸一律用 px（设计像素）。
 *
 * ⚠️ **扫描面** = `src/**` 的 `.vue` `<style>` 块 **+ 全部 `.scss` 文件**
 *（含 `uni.scss` —— 它是令牌真源，它里面也不该再有 rpx）。
 */
function rpxOffenders(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\d+rpx\b/.test(l));
}
```

并把 describe ② 的第 1 条改成：

```ts
  it('样式里没有 rpx（尺寸一律 px，R711）', () => {
    const offenders = rpxOffenders(allStyleText()); // ← 见下：扫描面要含 .scss
    expect(offenders, `未转换的 rpx：\n${offenders.join('\n')}`).toEqual([]);
  });
```

⚠️ 需要把扫描面从「只有 .vue」扩到「.vue + .scss」——现行 `styleText()` 只拼 `vueFiles`。
新增：

```ts
/** 全部可扫描的样式文本（.vue 的 style 块 + 所有 .scss 文件）。 */
function allStyleText(): string {
  const scss = sources.filter((f) => f.path.endsWith('.scss')).map((f) => stripScssComments(f.content));
  return [styleText(), ...scss].join('\n');
}
```

**③ 保留一条「px 字面量只许出现在令牌文件」的检查**（❗**这是自审补上的，别漏**）

⚠️ **为什么必须有**：闸改成「禁 rpx」之后，原来的 `pxOffenders` 就**没有调用点了** ——
于是 **R714 的「全仓不得出现裸 `1px`」变成没有任何东西在拦**。
而「尺寸一律 px」**不等于**「可以在组件里写 px」：尺寸仍只能来自 `$ftl-*` 令牌。

```ts
/**
 * px 字面量违规（R711 / R714）：**px 只允许出现在令牌文件 `src/uni.scss`**。
 *
 * 这条同时兜住 R714 的发丝线约束（发丝线一律 `$ftl-hairline`，不得手写 `1px`）；
 * 没有它，闸翻转后**裸 1px 无人拦**。
 */
function pxLiteralOffenders(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\dpx\b/.test(l))
    .filter((l) => !/(?:^|[;{])\s*[a-z-]+:\s*0px;/.test(l)); // `0px` 白名单保留
}
```

对应两条断言（**扫描面是 `styleText()` = 只有 `.vue` 的 style 块**，uni.scss 天然被排除）：

```ts
  it('组件样式里没有 px 字面量（px 只许出现在 uni.scss 令牌文件）', () => {
    expect(pxLiteralOffenders(styleText()), '组件里不得手写 px —— 必须走 $ftl-* 令牌').toEqual([]);
  });

  it('判别力正对照：手写 px 必须报出，0px 放行', () => {
    expect(pxLiteralOffenders('.card { border: 1px solid red; }')).toHaveLength(1);
    expect(pxLiteralOffenders('.card { width: 144px; }')).toHaveLength(1);
    expect(pxLiteralOffenders('.card { margin: 0px; }')).toEqual([]);
  });
```

Hmm — 但 `LandscapeStage.vue` 里有 `width: ${CANVAS_W}px` 是**绑在 `:style` 上的字符串**（不在 `<style>` 块里）✅ 不冲突。
**若某处确实需要字面量 px**（如画布尺寸），它应当在 `useLandscapeCanvas.ts` 的常量里，不在样式块里。

**④ 反转自证与正反对照**（这三条**现在会红**，反转是**对的**）：

```ts
  it('判别力正对照：rpx 闸对「合成的违规样本」报错，对 px 样本放行', () => {
    expect(rpxOffenders('.card { width: 144rpx; }')).toHaveLength(1);
    expect(rpxOffenders('.card { height: 96rpx; }')).toHaveLength(1);
    // 合法样本：px 一律放行
    expect(rpxOffenders('.card { width: 144px; }')).toEqual([]);
    expect(rpxOffenders('.card { border: 2px solid red; }')).toEqual([]);
    expect(rpxOffenders('.card { margin: 0px; }')).toEqual([]);
  });

  it('判别力自证：**px 才是主体**，且 rpx 零命中（不是「空集合恒绿」）', () => {
    const text = allStyleText();
    expect(text, '扫描器没读到样式内容').not.toBe('');
    // ⚠️ 正向自证必须落在 **uni.scss**：组件里用的是 $ftl-* 令牌，字面量 px 只在令牌文件里。
    //    只断言「rpx 零命中」的话，闸会因为「什么都没扫到」而恒绿。
    const tokenText = stripScssComments(
      sources.find((f) => f.path === TOKEN_FILE)!.content,
    );
    expect((tokenText.match(/\d+px\b/g) ?? []).length, 'uni.scss 里的 px 字面量').toBeGreaterThanOrEqual(30);
    expect((text.match(/\d+rpx\b/g) ?? []).length, '全仓 rpx 命中数').toBe(0);
  });
```

- [ ] **Step 5: 跑闸，确认绿**

```bash
pnpm --filter @fight-the-landlord/client test -- ui-tokens
```

Expected: PASS。**条数必须 ≥ Step 1 的基线**（只增不减）。
若红：**先读报错** —— 多半是某处还剩 rpx（Step 3 的 grep 应能列全）。

- [ ] **Step 6: 迁移 F1 算账的阈值（数字变，断言结构不变）**

`card-hand-interaction.test.ts` 的「U1 算账」用例里，把可用宽从 `710` 改成 **`1254`**：

```ts
    // ② 地主拿满 20 张必须**单行**放得下。
    // ⚠️ 可用宽 710 → **1254**（U1 之后画布改成 1334 宽，减去两侧内边距）：
    //    1334 − .table 左右各 $ftl-space-5(24) − .table__me 左右各 $ftl-space-4(16) = 1254。
    //    ⚠️ 这两个内边距的值与 §table.vue 的实际写法必须一致 —— 改内边距就要重算这里。
    const AVAILABLE = 1254;
```

并把同一用例里那条「牌框比例」的容差与「净露率」区间**保持不变**（它们读的是令牌**真值**，令牌 ×2 后比例不变）：

```ts
    // 净露 = (144 − 88) / 144 = 38.9% ⇒ 仍在 dsh 的档位区间内？**不在**（dsh 是 45–57%）
    // ⇒ 区间要按新档重定：本片取 0.35–0.60（横屏牌更大、重叠更重是参考图的形态）
    expect(exposure).toBeGreaterThanOrEqual(0.35);
    expect(exposure).toBeLessThanOrEqual(0.6);
```

- [ ] **Step 7: 全量跑 + 逐端构建**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
pnpm --filter @fight-the-landlord/client build:h5
node scripts/verify-asset-paths.mjs
```

Expected: 全绿。`verify-asset-paths` 应仍通过（底纹 URL 从 `table.vue` 移到 `LandscapeStage.vue` 是 Task 3 的事，此刻还没移）。

⚠️ **产物级核对**（观感类改动的可机械部分）：h5 产物 CSS 里 `.card` 的宽高应变成
`9rem × 11.75rem`（**144px / 188px ÷ 16**）：

```bash
grep -oE "\.card\[data-v-[a-z0-9]+\]\{[^}]*\}" apps/client/dist/build/h5/assets/table-*.css | head -1
```

- [ ] **Step 8: 提交**

```bash
git add apps/client/src/uni.scss apps/client/test/ui-tokens.test.ts \
        apps/client/test/card-hand-interaction.test.ts
git commit -m "$(cat <<'EOF'
refactor(client): 单位体系 rpx → px（33 令牌 ×2）+ 翻转 ui-tokens 闸（R711/R714/R722）

片① Task 2：
- 33 个尺寸令牌 rpx → px，值 ×2。⚠️ 这不是「换算」而是**保物理尺寸**：
  旧坐标系 375 逻辑宽（1rpx=0.5px），画布高 750 ≈ 它的 2 倍 ⇒ ×2 后在同样的屏上不变。
- 新增 $ftl-hairline: 2px —— 画布 k≈0.52 会把 1px 缩到 0.52px 而**渲染不出来**
  （ui-tokens 白名单原本那条理由逐字这么写）；ftl-btn mixin 一并改（它是所有按钮的边框来源）
- 闸的**规则 + 自证 + 正反对照三件一起反转**（R722）：
  · 撤掉 PX_WHITELIST 的 1px 条目（留 0px）
  · 禁 px → 禁 rpx，扫描面扩到 .vue + .scss（含 uni.scss）
  · 自证从「必须扫到 px≥3」改成「uni.scss 里 px 字面量 ≥30 且全仓 rpx === 0」
    —— ⚠️ 正向自证必须落在 uni.scss（组件用的是令牌，字面量 px 只在令牌文件里），
    否则新闸会因为「什么都没扫到」而恒绿
- F1 算账阈值 710 → 1254（画布 1334 − 两侧内边距），净露率区间按新档重定为 0.35–0.60

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 三页接入画布 + 关原生导航栏

**Files:**
- Modify: `apps/client/src/pages.json`
- Modify: `apps/client/src/manifest.json`
- Modify: `apps/client/src/pages/login/login.vue` / `lobby/lobby.vue` / `table/table.vue`
- Modify: `apps/client/src/pages/table/table.vue`（**移除**它自己的底纹规则 —— R713 只留一处）

**Interfaces:**
- Consumes: `LandscapeStage`（Task 1）
- Produces: 三页的根内容包在 `<LandscapeStage>` 的默认插槽里

---

- [ ] **Step 1: 写失败的测试（判据先行）**

在 `apps/client/test/landscape-canvas.test.ts` 追加：

```ts
describe('⑤ 三页接入与全局配置（源码级）', () => {
  const sources = collectSourceFiles();

  it('三页都用 <LandscapeStage> 包住根内容', () => {
    for (const p of ['src/pages/login/login.vue', 'src/pages/lobby/lobby.vue', 'src/pages/table/table.vue']) {
      const f = sources.find((s) => s.path === p);
      expect(f, `${p} 必须在扫描集合里`).toBeDefined();
      const code = stripComments(f!.content);
      expect(code, `${p} 必须 import LandscapeStage`).toMatch(/LandscapeStage/);
      expect(code, `${p} 必须把内容放进 <LandscapeStage>`).toMatch(/<LandscapeStage/);
    }
  });

  it('pages.json：globalStyle.navigationStyle === "custom"，且三页标题仍在', () => {
    const pages = JSON.parse(sources.find((f) => f.path === 'src/pages.json')!.content) as {
      globalStyle?: { navigationStyle?: string };
      pages: { path: string; style?: { navigationBarTitleText?: string } }[];
    };
    expect(pages.globalStyle?.navigationStyle, 'R720：关掉原生导航栏').toBe('custom');
    // ⚠️ page-stack.test.ts:190 断言第一个页面的标题 —— 别顺手删
    expect(pages.pages[0]!.style?.navigationBarTitleText).toBe('登录');
  });

  it('manifest.json：App 锁横屏（R709）', () => {
    const m = JSON.parse(sources.find((f) => f.path === 'src/manifest.json')!.content) as {
      'app-plus'?: { screenOrientation?: string[] };
    };
    expect(m['app-plus']?.screenOrientation, 'App 锁横屏').toEqual(['landscape-primary', 'landscape-secondary']);
  });

  it('底纹只有一处（R713）：new_BJ.png 在 src/** 只出现一次，且在 LandscapeStage.vue', () => {
    const hits = sources.filter((f) => /new_BJ\.png/.test(f.content)).map((f) => f.path);
    expect(hits, `底纹出现在：${hits.join(', ')}`).toEqual(['src/components/LandscapeStage.vue']);
  });
});
```

> ⚠️ 文件顶部要有 `import { collectSourceFiles, stripComments } from './helpers/source-scan';`。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @fight-the-landlord/client test -- landscape-canvas
```

Expected: FAIL（三页没接、pages.json 没 custom、manifest 没 orientation、底纹还在 table.vue）。

- [ ] **Step 3: 改 `pages.json` 与 `manifest.json`**

`pages.json` 的 `globalStyle` 加一行（**不要删 `navigationBarTitleText`**）：

```json
  "globalStyle": {
    "navigationStyle": "custom",
    "navigationBarTextStyle": "black",
    "navigationBarTitleText": "斗地主",
    "navigationBarBackgroundColor": "#1565c0",
    "backgroundColor": "#f5f5f5"
  }
```

`manifest.json` 的 `app-plus` 加一行：

```json
  "app-plus": {
    "screenOrientation": ["landscape-primary", "landscape-secondary"],
    "usingComponents": true,
    ...
  }
```

- [ ] **Step 4: 三页接入 `<LandscapeStage>`**

以 `table.vue` 为例（另两页同形）。**模板**：

```vue
<template>
  <LandscapeStage>
    <view class="table">
      <!-- …原内容一字不动… -->
    </view>
  </LandscapeStage>
</template>
```

⚠️ **三条硬约束**：
1. **模板注释仍必须在根元素内部**（这里的根是 `<LandscapeStage>`）；
2. `<script setup>` 加 `import LandscapeStage from '../../components/LandscapeStage.vue';`；
3. **`.table` 上移除底纹那三行**（`background-image/size/position/repeat` 与 `new_BJ.png`）——
   底纹现在只在 `LandscapeStage` 铺一次（R713）。保留 `background-color` 无害，但 `new_BJ` 必须走。

- [ ] **Step 5: 跑测试 + 构建**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client lint
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
```

Expected: 全绿 + 两端 DONE。

⚠️ **本机探针此时应仍 16/16**（锚点一个没动；`navigationStyle: custom` 只影响原生栏）：

```bash
# 自己起 dev server，再带 --no-server + CHROME_BIN + --cdp-port 18800
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
```

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/pages.json apps/client/src/manifest.json \
        apps/client/src/pages/login/login.vue apps/client/src/pages/lobby/lobby.vue \
        apps/client/src/pages/table/table.vue apps/client/test/landscape-canvas.test.ts
git commit -m "$(cat <<'EOF'
feat(client): 三页接入横屏画布 + 关原生导航栏 + App 锁横屏（R709/R713/R720）

片① Task 3：
- pages.json globalStyle.navigationStyle='custom'（设在 globalStyle，一处生效三页）
  ⚠️ navigationBarTitleText 保留 —— page-stack.test.ts:190 断言它
- manifest.json app-plus.screenOrientation = landscape-primary/secondary
- 三页根内容包进 <LandscapeStage> 的默认插槽
- table.vue 移除自己的底纹规则：底纹只在 LandscapeStage 铺一次（R713，铺两层会错位）

判据（源码级）：三页都 import 且使用 LandscapeStage；globalStyle.custom；
标题仍在；screenOrientation；new_BJ.png 在 src/** 只出现一次

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 登录页横屏骨架

**Files:**
- Modify: `apps/client/src/pages/login/login.vue`

**Interfaces:**
- Consumes: `LandscapeStage`（Task 3 已接入）
- Produces: 登录页在画布内居中卡片；**`.login__field input` / `.login__actions .btn` 锚点不变**

---

- [ ] **Step 1: 先确认现在的锚点与文案一字不动**

```bash
grep -n "login__actions\|login__field\|login__title\|login__hint\|login__seg" apps/client/src/pages/login/login.vue | head
pnpm --filter @fight-the-landlord/client test -- login-screen auth-flow auth-ui-wiring
```

Expected: 全绿。**记下条数**（Task 收尾核对不减）。

- [ ] **Step 2: 横屏重排（只改样式，不改结构、不改文案）**

`login.vue` 的 `<style>` 把根容器的竖排居中改成「画布内的居中卡片」：

```scss
/**
 * 横屏骨架（R716）：画布 1334×750 里**居中一张卡片**，
 * 卡片内仍是**竖排**（字段从上到下）—— 表单竖排是可用性，不是竖屏遗留。
 *
 * ⚠️ **锚点一个不改**：`.login__field input` / `.login__actions .btn`（探针与 10 个用例依赖）。
 * ⚠️ 本 Task **不加任何新元素、不改任何文案**（品牌视觉重做属片③）。
 */
.login {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-6;
  /* 卡片：固定宽 + 画布内居中（.canvas 已经是 flex 容器？否 —— 用 margin:auto 居中） */
  width: 560px;
  margin: auto;
  padding: $ftl-space-10 $ftl-space-9;
  border: $ftl-hairline solid $ftl-color-border;
  border-radius: $ftl-radius-lg;
  background: $ftl-color-surface;
}
```

⚠️ **居中已定死**：`LandscapeStage` 的 `.canvas` 是 `display: flex; align-items: center; justify-content: center`
（Task 1 已写死，一处生效三页）⇒ 页面根**不需要**自己写 `margin: auto`，只要给它一个宽度即可。
⚠️ **`.login` 的 `height` 不要写 `100%`** —— 让 flex 居中生效，卡片按内容高度居中即可。

- [ ] **Step 3: 跑测试 + 真浏览器走查**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client build:h5
# 探针（注册路径要过 —— 它点 .login__actions .btn 的「注册」）
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
```

Expected: 16/16。

**人工走查**（spec §1.4-8：观感只能这么验）：把 dev server 开起来，浏览器缩到 866×390，
确认 ① 登录卡片居中且不溢出；② 缩到 375×812（竖屏）出现「请旋转设备」；③ 拖窗口大小，画布**跟着重算**（不残留旧尺寸）。

- [ ] **Step 4: 提交**

```bash
git add apps/client/src/pages/login/login.vue apps/client/src/components/LandscapeStage.vue
git commit -m "$(cat <<'EOF'
feat(client): 登录页横屏骨架（R716）

片① Task 4：画布内居中卡片；卡片内部仍竖排（表单竖排是可用性，不是竖屏遗留）。
锚点一个不改（.login__field input / .login__actions .btn）；不加新元素、不改文案。
LandscapeStage 的 .canvas 定为 flex 居中（一处生效三页）。
跑通：单测全绿 + 探针 16/16 + 人工走查（866×390 / 375×812 竖屏提示 / 拖窗口重算）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 大厅横屏骨架（左右分栏）

**Files:**
- Modify: `apps/client/src/pages/lobby/lobby.vue`

**Interfaces:**
- Produces: 大厅横屏下**左玩法卡列 / 右开局区**；**不拆页**（拆两屏是片③）；`.lobby__match .btn` 锚点不变

---

- [ ] **Step 1: 记基线**

```bash
pnpm --filter @fight-the-landlord/client test -- lobby-ux lobby-modes
```

Expected: 全绿（18 + 6 条）。**记下**。

- [ ] **Step 2: 横屏左右分栏（只改样式与排布，不改结构、不改文案、不加功能）**

把大厅的上下堆叠改成两列：

```scss
/**
 * 横屏骨架（R716）：左 = 玩法卡列；右 = 开局区（匹配 / 创建 / 加入 / 房间列表）。
 *
 * ⚠️ **本片不拆页**（拆两屏是片③）。玩法卡默认已选中、开局区始终可见（R652 的语义不变）。
 * ⚠️ **锚点一个不改**：`.lobby__match .btn`（探针在注册成功后**立刻等它**）。
 */
.lobby {
  box-sizing: border-box;
  display: flex;
  flex-direction: row;      /* ← 从 column 改 row */
  gap: $ftl-space-8;
  width: 100%;
  height: 100%;
  padding: $ftl-space-6;
}
.lobby__modes {
  flex: 0 0 420px;          /* 左列固定宽 */
  min-width: 0;
}
.lobby__start {
  flex: 1 1 0;              /* 右列吃掉剩余 */
  min-width: 0;
}
```

⚠️ 实测现有 class 名（`lobby__modes` / `lobby__start` / `lobby__rooms` / `lobby__match` …）——
**以文件里的实际结构为准**，若外层容器不是这两个 class，按实际改（**只改 flex 方向与两列的 flex 值**）。
⚠️ **房间列表在横屏下要能滚**（`.lobby__rooms { overflow-y: auto }`）—— 但注意
`.stage` 是 `overflow: hidden`，所以滚动只能发生在这个内层容器上。

- [ ] **Step 3: 跑测试 + 走查**

```bash
pnpm --filter @fight-the-landlord/client test
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
```

Expected: 全绿 + 16/16。

**人工走查**：866×390 下确认 ① 左玩法卡、右开局区；② 点「随机匹配」仍能进牌桌；③ 房间列表超长时可滚。

- [ ] **Step 4: 提交**

```bash
git add apps/client/src/pages/lobby/lobby.vue
git commit -m "$(cat <<'EOF'
feat(client): 大厅横屏骨架 —— 左右分栏（R716）

片① Task 5：左 = 玩法卡列，右 = 开局区。本片**不拆页**（拆两屏是片③）。
.lobby__match .btn 锚点不变（探针注册成功后立刻等它）。房间列表在内层容器里滚
（.stage 是 overflow:hidden，滚动只能在子容器）。
跑通：单测全绿 + 探针 16/16 + 人工走查

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 牌桌横屏骨架（三区）

**这是片① 的主体。** 只把元素位置横过来，**不加新元素**（货币/底分/倍数条/座位精修属片②）。

**Files:**
- Modify: `apps/client/src/pages/table/table.vue`
- Modify: `apps/client/src/components/{Seat,Hand,PlayArea,BottomCards,TableHud,BidPanel}.vue`（只在**必要**时改尺寸/排布）

**Interfaces:**
- Consumes: 全部现有组件
- Produces: 牌桌在画布内的三区布局；**`.table__me .card` / `.table__bar .btn` / `.table__bid-grab` / `.table__pass` / `.table__play` / `.table__notice` 锚点不变**

---

- [ ] **Step 1: 记基线**

```bash
pnpm --filter @fight-the-landlord/client test -- table-play-ui table-bid-ui table-ended-ui table-settlement-ui table-seat-geometry card-hand-interaction
```

Expected: 全绿。**记下每个文件的 `it(` 数** —— 收口要逐文件核对（8 个契约测试的合计是 65）。

- [ ] **Step 2: 三区横屏重排**

目标布局（画布 1334×750）：

```
┌──────────────────────────────────────────────────┐  ← 顶栏（横贯）：房间/版本/状态/返回大厅
│ 顶栏                                              │
├──────────┬──────────────────────┬────────────────┤
│ 对手 A    │   中央：上一手牌      │   对手 B        │  ← 对手分左右，中央是出牌区 + 底牌
│ (Seat)   │   + 底牌（BottomCards）│   (Seat)       │
├──────────┴──────────────────────┴────────────────┤
│ 我的区域：座位行（头像/昵称/张数/倒计时）+ 手牌 + 动作条 │
└──────────────────────────────────────────────────┘
```

```scss
/**
 * 横屏三区（R716）：顶栏横贯 / 对手分左右 / 中央出牌区+底牌 / 我底部。
 *
 * ⚠️ **锚点一个不改**（探针 6 个 + 4 张牌桌测试）：
 *   `.table__me .card` · `.table__bar .btn` · `.table__bid-grab` · `.table__bid-pass`
 *   · `.table__play` · `.table__pass` · `.table__notice` · `.table__bottom` …
 * ⚠️ 本 Task **不加新元素**（图1 的货币/底分/倍数条/座位精修 = 片②）。
 * ⚠️ **手牌算账**：20 张 = 144 + 19×(144−88) = **1208** ≤ 可用宽 **1254**（余量 46）。
 *    ⇒ `.table__me :deep(.hand .card + .card) { margin-left: -$ftl-card-overlap; }` 与
 *       `column-gap: 0` **一条都不能少**（F1 判据会验）。
 */
.table {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-5;
  width: 100%;
  height: 100%;
  padding: $ftl-space-5;
}
.table__center {
  flex: 1 1 0;              /* 中央吃掉剩余高度 */
  display: flex;
  flex-direction: row;      /* ← 出牌区与底牌横排 */
  gap: $ftl-space-6;
  min-height: 0;
}
.table__opponents {
  display: flex;
  flex-direction: row;      /* 两家左右 */
  gap: $ftl-space-6;
}
.table__me {
  flex: 0 0 auto;           /* 我的区域固定在底部 */
}
```

⚠️ **`max-width: 1120rpx` 那类旧的竖屏约束要删掉**（画布是固定坐标系，`max-width` 不再有意义）。
⚠️ **不要动** `.table__me :deep(.hand)` 的 `column-gap: 0` 与 `.card + .card` 的负 `margin-left` —— F1 判据盯着它们。

- [ ] **Step 3: 跑测试 + 产物 CSS 核对 + 走查**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client build:h5
grep -oE "margin-left:-[0-9.]+rem" apps/client/dist/build/h5/assets/table-*.css | sort -u   # 应见 -5.5rem（=88px）
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
```

Expected: 全绿 + 16/16 + 产物里 hand 重叠 = **88px = 5.5rem**。

**人工走查**（这一条最重要）：完整打一局，确认 ① 17 张手牌单行、互相压住；② 点两张同点数的牌都能选中（下标语义）；③ 「理牌」真的重排；④ 对家/我的座位信息都在位；⑤ 倒计时在走；⑥ 出牌后出牌区更新。

- [ ] **Step 4: 提交**

```bash
git add apps/client/src/pages/table/table.vue apps/client/src/components/
git commit -m "$(cat <<'EOF'
feat(client): 牌桌横屏三区骨架（R716）

片① Task 6：顶栏横贯 / 两个对手分左右 / 中央出牌区+底牌 / 我的区域在底部。
删除竖屏遗留的 max-width 约束（画布是固定坐标系）。
⚠️ 本 Task 不加新元素 —— 图1 的货币/底分/倍数条/座位精修属片②。

手牌算账（画布 1334）：20 张 = 144 + 19×(144−88) = 1208 ≤ 可用宽 1254（余量 46）。
column-gap:0 与 .card+.card 的负 margin-left 一条都不能少（F1 判据验）。
产物 CSS 实测 hand 重叠 = 5.5rem = 88px。
跑通：单测全绿 + 探针 16/16 + 完整一局人工走查

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 收口（门禁 + 复核 + 文档）

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-landscape-foundation-design.md`（回填执行期发现）
- Create: `docs/superpowers/plans/2026-09-21-landscape-foundation-side.md`（本文件，入库）

**Interfaces:**
- Consumes: Task 1–6 的全部产出
- Produces: 本片的**收口记录**（全门禁实测值 + 执行期发现 + 与 spec 的偏离）

---

- [ ] **Step 1: 全门禁（逐条记实测值）**

```bash
cd /d/Code/pokergame
pnpm run ci                       # 六阶段
pnpm --filter @fight-the-landlord/client build:h5
pnpm --filter @fight-the-landlord/client build:app
node scripts/verify-asset-paths.mjs
# 探针（独占）
node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate
```

Expected: 全绿 + 探针 16/16。

- [ ] **Step 2: 逐文件核对「判据只增不减」**

```bash
cd apps/client/test
for f in auth-flow auth-ui-wiring lobby-ux ui-flow table-bid-ui table-play-ui table-ended-ui table-settlement-ui; do
  printf "%-28s it(=%s  it.each(=%s\n" "$f" \
    "$(grep -oE '\bit\(' $f.test.ts | wc -l)" "$(grep -oE '\bit\.each\(' $f.test.ts | wc -l)"
done
```

Expected: 合计 **≥ 65**（63 + 2），**逐文件不低于** Task 各步记下的基线。

- [ ] **Step 3: 复核清单（逐条回答，落盘到 spec 的「执行期发现」段）**

- [ ] ① 探针 **16/16**，且 `scripts/browser-e2e.mjs` **零改动**（`git diff` 为空）？
- [ ] ② 9 个探针 class **一个没改**？
- [ ] ③ `new_BJ.png` 在 `src/**` **只出现一次**（`LandscapeStage.vue`）？
- [ ] ④ 全仓**零 `rpx`**（`.vue` style 块 + `.scss`）？
- [ ] ⑤ `getSystemInfoSync()` 的调用点被 `try/catch` 包住？`onWindowResize`/`offWindowResize` **成对**？
- [ ] ⑥ 观感类改动**都有真浏览器走查记录**（**没有造假判据**）？
- [ ] ⑦ `build:app` **DONE**（不是「目录存在」）？
- [ ] ⑧ 门禁日志的 mtime **晚于**最后一次改动（R682）？

- [ ] **Step 4: 把执行期发现写进 spec**

在 spec 末尾加「## 8. 执行期发现」段，格式照素材片：
**现象 → 根因 → 被什么抓住 → 修法**。
⚠️ 特别留意本片**已知**的三类高风险（前两片都栽过）：
① **改规则没改判据**（R722 —— 本片最大的那个）；
② **观感类改动被当成「单测绿了就行」**（spec §1.4-8）；
③ **「×2 是视觉 no-op」这个前提被证伪**（若走查发现比例明显不对，那是本片的头号发现）。

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/specs/2026-09-21-landscape-foundation-design.md \
        docs/superpowers/plans/2026-09-21-landscape-foundation-side.md
git commit -m "$(cat <<'EOF'
docs(landscape): 片① 收口 —— 全门禁实测 + 执行期发现

配图见 commit body 各条实测值。⚠️ 待执行者回填实际数字后再提交本 commit。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 执行期发现

> 执行者逐 task 追加。格式：**现象 → 根因 → 被什么抓住 → 修法**。

（待填）

---

## 与 spec 的偏离记录

> 凡与 spec 正文不一致的，逐条记在这里并说明依据。

| # | spec 写的 | 本计划 | 依据 |
|---|---|---|---|
| （待填） | | | |

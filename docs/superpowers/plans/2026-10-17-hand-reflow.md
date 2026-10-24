# 手牌出牌后刷新优化 · 实施计划 v1.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 消除出牌后整手牌重播发牌动画，并让 H5 上的剩余牌平滑滑到新位置。

**架构：** `Hand.vue` 用稳定 key（`(r,s)` + 原始顺序出现序号）复用 DOM；仅在 `reflow` + H5 运行时下，用 FLIP（`onBeforeUpdate` 测旧 rect、`onUpdated` 测新 rect、独立 `translate` 属性 + WAAPI）做平滑重排，位移按画布 scale 换算。小程序/App 自动降级为瞬时重排。

**技术栈：** Vue 3.5 · uni-app（H5 / mp-weixin / App）· vitest · vue-tsc · Web Animations API。

## Global Constraints

- 上游唯一：`docs/superpowers/specs/2026-10-17-hand-reflow-design.md`（v1.1，已吸收对抗审查）。
- 每次改动一个提交；提交信息结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 每个改动必须同时有测试；交付前跑通受影响包的测试与 lint。
- **不新增依赖**。
- **不碰** flex 布局、负 margin 重叠、牌宽/牌高几何、规则、协议、服务端。
- FLIP 只在 `reflow === true` 且 H5 运行时启用；小程序/App 不得触碰 DOM API。
- FLIP 位移必须用**独立 `translate` 属性**，不得用 `transform`（避免与选中抬升/CSS 发牌动画冲突）。
- FLIP 位移必须除以画布 scale（`rootRect.width / root.offsetWidth`）。
- 生命周期顺序：`onBeforeUpdate` 先守卫再测旧 DOM；`onUpdated` 先取消旧 FLIP、再测新 rect。
- 旧 key 顺序必须从 DOM 的 `data-hand-key` 读取，**不得**从 props 反推。

---

## 文件结构总览

```
新增
  apps/client/src/components/hand-keys.ts
  apps/client/test/hand-keys.test.ts
  apps/client/test/hand-reflow.test.ts

修改
  apps/client/src/components/Hand.vue
  apps/client/src/pages/table/table.vue
  apps/client/test/card-hand-interaction.test.ts   # 追加源码级闸
```

---

### Task 1: 稳定 key 纯函数

**Files:**
- Create: `apps/client/src/components/hand-keys.ts`
- Test: `apps/client/test/hand-keys.test.ts`

**Interfaces:**
- Produces: `keyedHandOrder(cards, order): KeyedHandCard[]`，其中 `KeyedHandCard = { index: number; key: string }`。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/hand-keys.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { keyedHandOrder } from '../src/components/hand-keys';

const card = (r: number, s: number) => ({ r, s });

describe('keyedHandOrder', () => {
  it('唯一牌面：key 按 order 返回，index 保持原始下标', () => {
    const cards = [card(3, 0), card(5, 1), card(4, 2)];
    expect(keyedHandOrder(cards, [1, 2, 0])).toEqual([
      { index: 1, key: '5-1' },
      { index: 2, key: '4-2' },
      { index: 0, key: '3-0' },
    ]);
  });

  it('删掉第一张后，剩余牌的 key 逐一不变', () => {
    const before = keyedHandOrder([card(3, 0), card(5, 1), card(4, 2)], [2, 1, 0]);
    const after = keyedHandOrder([card(5, 1), card(4, 2)], [1, 0]);
    const survivingKeys = before.filter((e) => e.index !== 0).map((e) => e.key);
    expect(after.map((e) => e.key)).toEqual(survivingKeys);
  });

  it('重复牌面：key 唯一且带出现序号；删除其中一张时允许另一张序号变化', () => {
    const before = keyedHandOrder([card(20, 4), card(20, 4), card(30, 4)], [0, 1, 2]);
    expect(before.map((e) => e.key)).toEqual(['20-4', '20-4#1', '30-4']);
    expect(new Set(before.map((e) => e.key)).size).toBe(3);

    const after = keyedHandOrder([card(20, 4), card(30, 4)], [0, 1]);
    expect(after.map((e) => e.key)).toEqual(['20-4', '30-4']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/hand-keys.test.ts
```

预期：FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `apps/client/src/components/hand-keys.ts`：

```ts
import type { Card as ProtocolCard } from '@fight-the-landlord/protocol';

export interface KeyedHandCard {
  /** cards 里的原始下标（选中/toggle 语义不变）。 */
  index: number;
  /** 稳定 key。 */
  key: string;
}

/**
 * 为展示顺序的每张牌生成稳定 key。
 *
 * - 正常单副牌：(r,s) 唯一 ⇒ key = `${r}-${s}`
 * - 重复牌面（仅测试/探针）：追加按**原始顺序**分配的出现序号 `#1`、`#2`…
 *
 * 出现序号按 `cards` 原始顺序分配，再按 `order` 映射到展示顺序 ——
 * 这样排序变化不会让重复牌的序号互换。
 */
export function keyedHandOrder(
  cards: readonly ProtocolCard[],
  order: readonly number[],
): KeyedHandCard[] {
  const seen = new Map<string, number>();
  const keys = cards.map((c) => {
    const base = `${c.r}-${c.s}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
  return order.map((index) => ({ index, key: keys[index]! }));
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/hand-keys.test.ts
pnpm --filter @fight-the-landlord/client run lint
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/components/hand-keys.ts apps/client/test/hand-keys.test.ts
git commit -m "feat(client): 手牌稳定 key 纯函数

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Hand.vue 稳定 key + FLIP

**Files:**
- Modify: `apps/client/src/components/Hand.vue`
- Test: `apps/client/test/hand-reflow.test.ts`（新建）
- Test: `apps/client/test/card-hand-interaction.test.ts`（追加源码级闸）

**Interfaces:**
- Consumes: Task 1 的 `keyedHandOrder`。
- Produces: `Hand.vue` 的新 prop `reflow?: boolean`（默认 `false`）；`reflow` 为真时卡片带 `data-hand-key`。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/hand-reflow.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import Hand from '../src/components/Hand.vue';
import type { Card } from '@fight-the-landlord/protocol';

type Rect = { left: number; top: number; width: number };

const originalAnimate = Element.prototype.animate;
const originalMatchMedia = window.matchMedia;
const originalCSS = (globalThis as { CSS?: unknown }).CSS;

let animations: Array<{ el: Element; keyframes: Keyframe[]; cancel: ReturnType<typeof vi.fn> }>;
const mounted: VueWrapper[] = [];

function mountHand(props: Record<string, unknown>): VueWrapper {
  const wrapper = mount(Hand, { props: props as never });
  mounted.push(wrapper);
  return wrapper;
}

function installCapabilities() {
  animations = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false }),
  });
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { supports: () => true },
  });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: function (this: Element, keyframes: Keyframe[]) {
      const record = { el: this, keyframes, cancel: vi.fn() };
      animations.push(record);
      return record;
    },
  });
}

function restoreCapabilities() {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: originalAnimate,
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  Object.defineProperty(globalThis, 'CSS', { configurable: true, value: originalCSS });
}

const c = (r: number, s: number): Card => ({ r, s });

/** 给根元素与卡片按「调用次数」返回旧/新 rect；scale = rootRect.width / offsetWidth = 2。 */
function stubRects(wrapper: VueWrapper, before: Rect[], after: Rect[]) {
  const root = wrapper.find('.hand').element as HTMLElement;
  Object.defineProperty(root, 'offsetWidth', { configurable: true, value: 1000 });
  Object.defineProperty(root, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({ left: 0, top: 0, width: 2000, height: 100 }) as DOMRect,
  });
  wrapper.findAll('[data-hand-key]').forEach((node, index) => {
    const el = node.element as HTMLElement;
    let calls = 0;
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const rect = calls === 0 ? before[index]! : after[index]!;
        calls += 1;
        return ({ ...rect, height: 202 }) as DOMRect;
      },
    });
  });
}

beforeEach(() => {
  installCapabilities();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  restoreCapabilities();
});

describe('Hand.vue 的稳定 key + FLIP', () => {
  it('手牌变短：每张幸存牌各调用一次 animate，位移按画布 scale 换算', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0), c(3, 0)],
      reflow: true,
      sort: 'desc',
    });
    // 展示顺序 [5,4,3]；删掉 5 后 [4,3]
    stubRects(
      wrapper,
      [
        { left: 200, top: 0, width: 155 },
        { left: 140, top: 0, width: 155 },
        { left: 80, top: 0, width: 155 },
      ],
      [
        { left: 170, top: 0, width: 155 },
        { left: 170, top: 0, width: 155 },
        { left: 110, top: 0, width: 155 },
      ],
    );

    await wrapper.setProps({ cards: [c(4, 0), c(3, 0)] });

    expect(wrapper.findAll('[data-hand-key]').map((n) => n.attributes('data-hand-key'))).toEqual([
      '4-0',
      '3-0',
    ]);
    expect(animations).toHaveLength(2);
    expect(animations.map((a) => a.el.getAttribute('data-hand-key'))).toEqual(['4-0', '3-0']);
    // 4: (140-170)/2 = -15；3: (80-110)/2 = -15
    for (const animation of animations) {
      expect(animation.keyframes[0]!.translate).toBe('-15px 0px');
      expect(animation.keyframes[1]!.translate).toBe('0px 0px');
    }
  });

  it('selected 变化但 key 顺序不变 ⇒ 不触发 FLIP（新旧 rect 不同，只有早退能挡住）', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 100, top: -24, width: 155 },
        { left: 50, top: -24, width: 155 },
      ],
    );

    animations = [];
    await wrapper.setProps({ selected: [0] });

    expect(animations).toHaveLength(0);
  });

  it('连续两次手牌更新：先 cancel、再测新 rect', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0), c(3, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 200, top: 0, width: 155 },
        { left: 140, top: 0, width: 155 },
        { left: 80, top: 0, width: 155 },
      ],
      [
        { left: 170, top: 0, width: 155 },
        { left: 170, top: 0, width: 155 },
        { left: 110, top: 0, width: 155 },
      ],
    );
    await wrapper.setProps({ cards: [c(4, 0), c(3, 0)] });
    expect(animations).toHaveLength(2);
    // 第二次更新只留 3 ⇒ 被取消的是 3 的上一轮动画（animations[1]）
    const survivorAnimation = animations[1]!;
    let cancelled = false;
    survivorAnimation.cancel.mockImplementation(() => {
      cancelled = true;
    });

    // 第二次更新：4 被删、3 保留。3 的新 rect 只有在 cancel 之后才返回布局位置。
    wrapper.findAll('[data-hand-key]').forEach((node, index) => {
      const el = node.element as HTMLElement;
      let calls = 0;
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const before = [170, 110][index]!;
          const during = [150, 130][index]!;
          const after = [130, 90][index]!;
          const left = calls === 0 ? before : cancelled ? after : during;
          calls += 1;
          return ({ left, top: 0, width: 155, height: 202 }) as DOMRect;
        },
      });
    });

    await wrapper.setProps({ cards: [c(3, 0)] });

    expect(survivorAnimation.cancel).toHaveBeenCalled();
    // 3: before=110、cancel 后 after=90 ⇒ (110-90)/2 = 10px
    expect(animations.at(-1)!.keyframes[0]!.translate).toBe('10px 0px');
  });

  it('无 Element.animate ⇒ 不抛错、不调用 animate', async () => {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: undefined,
    });
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    await expect(wrapper.setProps({ cards: [c(4, 0)] })).resolves.toBeUndefined();
    expect(animations).toHaveLength(0);
  });

  it('reflow=false ⇒ 不挂 data-hand-key、不调用 animate', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      sort: 'desc',
    });
    expect(wrapper.findAll('[data-hand-key]')).toHaveLength(0);
    animations = [];
    await wrapper.setProps({ cards: [c(4, 0)] });
    expect(animations).toHaveLength(0);
  });

  it('零位移 ⇒ 不启动动画', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
    );
    animations = [];
    await wrapper.setProps({ cards: [c(4, 0)] });
    expect(animations).toHaveLength(0);
  });

  it('prefers-reduced-motion ⇒ 跳过 FLIP', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 80, top: 0, width: 155 },
        { left: 30, top: 0, width: 155 },
      ],
    );
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    animations = [];
    await wrapper.setProps({ cards: [c(4, 0)] });
    expect(animations).toHaveLength(0);
  });

  it('CSS.supports("translate") 为假 ⇒ 跳过 FLIP', async () => {
    const wrapper = mountHand({
      cards: [c(5, 0), c(4, 0)],
      reflow: true,
      sort: 'desc',
    });
    stubRects(
      wrapper,
      [
        { left: 100, top: 0, width: 155 },
        { left: 50, top: 0, width: 155 },
      ],
      [
        { left: 80, top: 0, width: 155 },
        { left: 30, top: 0, width: 155 },
      ],
    );
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { supports: () => false },
    });
    animations = [];
    await wrapper.setProps({ cards: [c(4, 0)] });
    expect(animations).toHaveLength(0);
  });
});
```

在 `apps/client/test/card-hand-interaction.test.ts` 末尾追加源码级闸：

```ts
  it('源码级：Hand 的 FLIP 必须做 $el 兜底、H5 门控与画布 scale 换算', () => {
    const hand = collectSourceFiles().find((f) => f.path === 'src/components/Hand.vue');
    expect(hand, '源码扫描器必须真的读到 Hand.vue').toBeDefined();
    const code = stripComments(hand!.content);
    expect(code, 'H5 的 <view> ref 是组件实例，必须取 $el').toMatch(/\$el/);
    expect(code, '必须有 H5 运行时门控').toMatch(/isH5Runtime|typeof window/);
    expect(code, 'FLIP 位移必须除以画布 scale（root offsetWidth）').toMatch(/offsetWidth/);
    expect(code, 'FLIP 必须使用独立 translate 属性').toMatch(/translate:\s*`?\$\{dx\}px/);
  });

  it('源码级：手牌必须传 reflow，出牌区/底牌不得传', () => {
    const files = collectSourceFiles();
    const table = files.find((f) => f.path === 'src/pages/table/table.vue');
    expect(table, '源码扫描器必须真的读到 table.vue').toBeDefined();
    const handBlock = /<Hand[\s\S]*?\/>/.exec(stripComments(table!.content));
    expect(handBlock, 'table.vue 必须存在手牌 <Hand>').not.toBeNull();
    expect(handBlock![0], '手牌必须启用 reflow').toMatch(/\breflow\b/);

    for (const path of ['src/components/PlayArea.vue', 'src/components/BottomCards.vue']) {
      const file = files.find((f) => f.path === path);
      expect(file, `源码扫描器必须真的读到 ${path}`).toBeDefined();
      expect(stripComments(file!.content), `${path} 不得启用 reflow`).not.toMatch(/\breflow\b/);
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/hand-reflow.test.ts test/card-hand-interaction.test.ts
```

预期：FAIL —— `reflow` prop / `data-hand-key` / FLIP 都不存在。

- [ ] **Step 3: 实现**

`apps/client/src/components/Hand.vue`：

1. import 与 props：

```ts
import { computed, onBeforeUpdate, onUpdated, ref } from 'vue';
import { keyedHandOrder } from './hand-keys';
```

```ts
    sort?: 'none' | 'asc' | 'desc';
    /**
     * 出牌后是否做 FLIP 平移重排（仅 H5）。默认 false；
     * PlayArea / BottomCards 不得传 true。
     */
    reflow?: boolean;
  }>(),
  { interactive: false, selected: () => [], size: 'mid', emptyText: '', enter: 'deal', sort: 'none', reflow: false },
);
```

2. 在 `order` 之后加：

```ts
const keyedOrder = computed(() => keyedHandOrder(props.cards, order.value));

const handEl = ref<unknown>(null);

const isH5Runtime = typeof window !== 'undefined' && typeof document !== 'undefined';

/** 当前手牌的根 DOM（H5 的 <view> ref 是组件实例，必须取 $el）。 */
function handRoot(): Element | null {
  if (typeof Element === 'undefined') return null;
  const raw = handEl.value as { $el?: unknown } | Element | null;
  const root = (raw as { $el?: unknown } | null)?.$el ?? raw;
  return root instanceof Element && typeof root.querySelectorAll === 'function' ? root : null;
}

function canFlip(): boolean {
  if (!props.reflow || !isH5Runtime) return false;
  if (typeof window.matchMedia !== 'function') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || !CSS.supports('translate', '0px')) return false;
  if (typeof Element === 'undefined') return false;
  return typeof (Element.prototype as { animate?: unknown }).animate === 'function';
}

interface HandSnapshot {
  order: string[];
  rects: Map<string, DOMRect>;
  scale: number;
}

function snapshot(): HandSnapshot | null {
  const root = handRoot();
  if (!root) return null;
  const layoutWidth = (root as HTMLElement).offsetWidth;
  const scale = layoutWidth > 0 ? root.getBoundingClientRect().width / layoutWidth : 0;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const rects = new Map<string, DOMRect>();
  const oldKeyOrder: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-hand-key]')) {
    const key = el.getAttribute('data-hand-key');
    if (key === null) continue;
    oldKeyOrder.push(key);
    rects.set(key, el.getBoundingClientRect());
  }
  return { order: oldKeyOrder, rects, scale };
}

let beforeUpdate: HandSnapshot | null = null;
const activeFlips = new WeakMap<Element, Animation>();

onBeforeUpdate(() => {
  beforeUpdate = canFlip() ? snapshot() : null;
});

onUpdated(() => {
  const old = beforeUpdate;
  beforeUpdate = null;
  if (!old || !canFlip()) return;
  const root = handRoot();
  if (!root) return;
  const elements = [...root.querySelectorAll<HTMLElement>('[data-hand-key]')];
  const currentOrder = elements.map((el) => el.getAttribute('data-hand-key') ?? '');
  if (
    currentOrder.length === old.order.length &&
    currentOrder.every((key, i) => key === old.order[i])
  ) {
    return;
  }
  const layoutWidth = (root as HTMLElement).offsetWidth;
  const scale = layoutWidth > 0 ? root.getBoundingClientRect().width / layoutWidth : old.scale;
  if (!Number.isFinite(scale) || scale <= 0) return;

  for (const el of elements) {
    const key = el.getAttribute('data-hand-key');
    if (key === null) continue;
    const oldRect = old.rects.get(key);
    if (!oldRect) continue;
    const previous = activeFlips.get(el);
    previous?.cancel();
    activeFlips.delete(el);
    const newRect = el.getBoundingClientRect();
    const dx = (oldRect.left - newRect.left) / scale;
    const dy = (oldRect.top - newRect.top) / scale;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    if (typeof (el as Element & { animate?: unknown }).animate !== 'function') continue;
    const animation = (el as Element & {
      animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;
    }).animate(
      [{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }],
      { duration: 200, easing: 'ease-out' },
    );
    activeFlips.set(el, animation);
  }
});
```

3. 模板：

```html
  <view ref="handEl" class="hand">
    <template v-if="cards.length > 0">
      <Card
        v-for="(entry, i) in keyedOrder"
        :key="entry.key"
        :data-hand-key="reflow ? entry.key : undefined"
        :class="enterClass"
        :style="enter === 'none' ? undefined : { '--ftl-delay': `${Math.min(i, 12) * 35}ms` }"
        :value="cards[entry.index]!.r"
        :suit="cards[entry.index]!.s"
        :size="size"
        :selected="selected.includes(entry.index)"
        :disabled="!interactive"
        @toggle="emit('toggle', entry.index)"
      />
    </template>
    <text v-else class="hand__empty">{{ emptyText }}</text>
  </view>
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/hand-keys.test.ts test/hand-reflow.test.ts test/card-hand-interaction.test.ts
pnpm --filter @fight-the-landlord/client run lint
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/components/Hand.vue apps/client/test/hand-reflow.test.ts apps/client/test/card-hand-interaction.test.ts
git commit -m "feat(client): 手牌稳定 key + H5 FLIP 重排

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 手牌启用 reflow + 全量验证

**Files:**
- Modify: `apps/client/src/pages/table/table.vue:1195-1203`

**Interfaces:**
- Consumes: Task 2 的 `reflow` prop。

- [ ] **Step 1: 传 prop**

`table.vue` 的手牌：

```html
          <Hand
            :cards="store.hand"
            interactive
            :selected="selected"
            sort="desc"
            size="normal"
            reflow
            empty-text="手牌为空"
            @toggle="toggleCard"
          />
```

- [ ] **Step 2: 跑相关测试**

```bash
pnpm --filter @fight-the-landlord/client exec vitest run test/card-hand-interaction.test.ts test/table-play-ui.test.ts test/table-seat-geometry.test.ts
pnpm --filter @fight-the-landlord/client run lint
```

预期：PASS。

- [ ] **Step 3: 全量回归**

```bash
pnpm --filter @fight-the-landlord/client test
pnpm --filter @fight-the-landlord/client run lint
```

预期：全部 PASS（2 skipped 允许）。

- [ ] **Step 4: 提交**

```bash
git add apps/client/src/pages/table/table.vue
git commit -m "feat(client): 手牌启用出牌后 FLIP 重排

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 最终验证

- [ ] `apps/client` 全量测试 + `vue-tsc` 通过。
- [ ] `git status` 干净，`git log --oneline` 每个任务一条提交。
- [ ] 真浏览器验收（手机横屏 k≈0.52 + 桌面 k≈1.4）：剩余牌滑到新位置、无整手重播发牌动画、出牌后立刻点牌手感正常。
- [ ] 真浏览器验收：出牌区（`PlayArea`）与底牌（`BottomCards`）不被误加位移动画。
- [ ] 真浏览器验收：`prefers-reduced-motion` 开启时无滑动。

<script setup lang="ts">
/** 展示一「手」牌（我方选牌区 / 上一手牌 / 底牌）。渲染纯数据，不含规则。 */
import { computed, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, ref } from 'vue';
import type { Card as ProtocolCard } from '@fight-the-landlord/protocol';
import Card from './Card.vue';
import { canvasScale, resolveHandRoot } from './hand-flip';
import { keyedHandOrder, type KeyedHandCard } from './hand-keys';
import {
  endSwipe,
  hitTest,
  isSwipeGesture,
  startSwipe,
  stepSwipe,
  type CardRect,
  type SwipeState,
} from '../composables/useSwipeSelect';

/** R696：牌是 `{r, s}`。本组件把 `r` 交给 `Card.value`（点数）、`s` 交给 `Card.suit`（花色）。 */
type Card = ProtocolCard;

const props = withDefaults(
  defineProps<{
    cards: readonly Card[];
    /** 可交互（仅自己选牌时） */
    interactive?: boolean;
    /**
     * 已选中的**下标**（`cards` 里的位置），**不是牌值**（R173/N18）。
     *
     * 为什么会这样：一手牌里同点数的牌有 2–4 张，按牌值标记会把它们**整组高亮**，
     * 而上游按值增删选中项又会让「同一个点数最多只能选一张」⇒ 对子/炸弹送不出去。
     * 因此「选中」必须钉在**牌实例**上，而 `v-for` 的下标就是实例的唯一标识。
     *
     * `Card.vue` 仍然只 emit 牌值（它的 API 不变）；**由本组件**把下标对应起来。
     */
    selected?: readonly number[];
    /**
     * 牌面档位。`normal` = 手牌（155×202）· `mid` = 出牌区（90×117）· `small` = 底牌（40×52）。
     *
     * ⚠️ **默认是 `mid`**（片② / R731 起）：出牌区（`PlayArea`）**不传** `size`，走的就是这个默认值，
     * 而它的档位正是 `mid`。三个消费方：手牌 = `normal`（显式传）· 出牌区 = `mid`（走默认）·
     * 底牌 = `small`（`BottomCards` 显式传）。**不要把默认值改回 `small`。**
     */
    size?: 'normal' | 'mid' | 'small';
    emptyText?: string;
    /**
     * §8 入场动效档。**由本组件统一持有**（它是渲染牌的那个组件），消费方只挑档：
     *  · `'deal'`（默认）—— 发牌落入，按 `min(i,12)*35ms` **错峰**（自己手牌区）；
     *  · `'played'` —— 出牌入场（出牌区）；
     *  · `'none'` —— 不动（底牌位走容器级的翻牌动画，见 `BottomCards.vue`）；
     *  · `'redeal'` —— 流局重发的整手重放（比首发位移更大；只作用于**挂载时的首批牌**，
     *    之后在同一实例里新增的牌降回 `'deal'`，见 `mountKeys`）。
     *
     * ⚠️ 起始态**只做位移/缩放、不做 `opacity: 0`** —— 动画不执行时元素不能永久隐形。
     * ⚠️ 错峰用内联 `--ftl-delay`，**零 JS 定时器**（牌桌区「不新造时钟」纪律）。
     */
    enter?: 'deal' | 'played' | 'none' | 'redeal';
    /**
     * 理牌（➍）：`'none'`（默认，= `cards` 顺序）· `'asc'` · `'desc'`。
     *
     * ⚠️ **R662：排序只改「展示顺序」**，不改牌、不改下标 —— `order` 返回的是 `cards` 的
     * **原始下标**数组，`toggle` 一律 emit 原始下标（否则排序后点第 k 张会选中另一张牌）。
     * 比较器**只按协议牌值数值**（R655：DouZero 编码是 rank-only ⇒ 只能按点数理牌）；
     * **不得**调 `toInternalRank` / `toDouZero`（那是规则面映射，`source-boundary` 有闸）。
     */
    sort?: 'none' | 'asc' | 'desc';
    /**
     * 出牌后是否做 FLIP 平移重排（仅 H5）。默认 false；
     * PlayArea / BottomCards 不得传 true。
     */
    reflow?: boolean;
  }>(),
  { interactive: false, selected: () => [], size: 'mid', emptyText: '', enter: 'deal', sort: 'none', reflow: false },
);

/**
 * 手牌相邻重叠量是**恒等令牌**（`$ftl-card-overlap`，2026-10-10 用户裁决：间距不随
 * 张数变化，参考欢乐斗地主）。本组件不再算任何按张数变化的值 —— 宿主 `table.vue`
 * 的 `.card + .card` 负 `margin-left` 直接消费令牌；出牌区/底牌不接负 margin。
 */
const emit = defineEmits<{
  /** 单张切换（点击 / 滑动起点未触发滑动阈值时的 tap）。 */
  (e: 'toggle', index: number): void;
  /** 滑动批量追加选中（展示序下标数组，调用方映射回原始下标）。 */
  (e: 'swipe-select', indices: number[]): void;
  /** 滑动批量取消选中。 */
  (e: 'swipe-deselect', indices: number[]): void;
}>();

/**
 * §8 入场动效类（见 `enter` prop 的注释）。
 * ⚠️ 空串是**合法值**（`enter === 'none'`）—— `Card` 的 `class` 绑定接受它。
 */
/**
 * 普通发牌档的类名（**唯一字面量**）：`enterClass` 与 D12 的降档回退共用，
 * 避免改名时两处漂移。
 */
const DEAL_CLASS = 'anim-deal-in';

const enterClass = computed(
  () =>
    ({
      deal: DEAL_CLASS,
      played: 'anim-played-in',
      none: '',
      redeal: 'anim-redeal-in',
    })[props.enter],
);

/**
 * 展示顺序 = **原始下标**数组（R662）。
 *
 * `'none'` 时恒等（`store.hand` 顺序 ⇒ 既有用例的「第 12 张」语义不变）；
 * 升/降序只重排下标，`cards` 本身**不动**。`Array.prototype.sort` 是稳定的 ⇒ 同点数的牌
 * 在每种排序下都保持它们原本的相对次序（不会「点哪张跳哪张」）。
 */
const order = computed(() => {
  const indexes = props.cards.map((_, index) => index);
  if (props.sort === 'none') return indexes;
  const direction = props.sort === 'asc' ? 1 : -1;
  // ⚠️ **R696：必须换成显式比较器。** 旧写法 `props.cards[a] - props.cards[b]` 对两个
  // `Card` 相减得到 `NaN` ⇒ `Array.sort` 收到 `NaN` 后**静默退化成「不排序」**
  // —— 用户点「理牌」什么也不会发生，而 `tsc` 与既有闸**都不报**（spec §3.5-B）。
  // 先点数、再花色，与 `shared` 的 `compareCards` 同口径。
  return indexes.sort((a, b) => {
    const ca = props.cards[a]!;
    const cb = props.cards[b]!;
    return (ca.r - cb.r || ca.s - cb.s) * direction;
  });
});

/** 展示顺序 + 稳定 key（出牌后剩余牌不重建）。 */
const keyedOrder = computed(() => keyedHandOrder(props.cards, order.value));

/**
 * 重发档（`enter='redeal'`）只属于**本实例挂载时的首批牌**。
 *
 * 重发时宿主以 `:key` 重建整手 ⇒ 这里捕获的就是重发后的那一手。之后在同一实例里
 * 新出现的牌（地主摸的 3 张底牌 / 断线补齐）必须降回普通发牌档 —— 否则“定地主”
 * 会被画成“重新发牌”，与底牌位自己的翻牌语汇撞车（2026-10-22 设计审查 H3）。
 *
 * 🔴 **必须声明在 `keyedOrder` 之后**（TDZ）。
 * 🔴 不得改成 computed/ref：那样新牌会被算进首批，D12 失效。
 */
const mountKeys = new Set(keyedOrder.value.map((entry) => entry.key));

/** 单张牌的入场类：重发档下，首批之后的新牌降回 `deal`。 */
function cardEnterClass(entry: KeyedHandCard): string {
  if (props.enter === 'redeal' && !mountKeys.has(entry.key)) return DEAL_CLASS;
  return enterClass.value;
}

const handEl = ref<unknown>(null);

/* ─── 滑动选牌状态机 ─────────────────────────────────────── */

const swipeState = ref<SwipeState>({ mode: 'idle', startInSelected: false, lastHit: null, processed: new Set() });
const isSwiping = ref(false);
const swipeRects: CardRect[] = [];
let touchStartX = 0;
let touchStartY = 0;

/** 把 props.selected（原始下标）映射为展示序下标集合（给 startSwipe 用）。 */
function selectedAsDisplaySet(): Set<number> {
  const map = new Map<number, number>(); // 原始下标 → 展示序下标
  keyedOrder.value.forEach((entry, displayIdx) => map.set(entry.index, displayIdx));
  const result = new Set<number>();
  for (const orig of props.selected) {
    const d = map.get(orig);
    if (d !== undefined) result.add(d);
  }
  return result;
}

/** 展示序下标 → 原始下标（emit 回 table.vue 用）。 */
function displayToOriginal(displayIndices: readonly number[]): number[] {
  return displayIndices.map((d) => keyedOrder.value[d]!.index);
}

/**
 * 从 hand 容器缓存所有卡片矩形。
 *
 * 三端自适应（按 API 可用性探测，不硬编码平台分支）：
 *  - H5：`root.querySelectorAll + getBoundingClientRect`（同步）
 *  - App / MP：`uni.createSelectorQuery().selectAll().boundingClientRect()`（异步回调，Promise 包装）
 *  - jdom / 未知：两边都失败 → swipeRects 保持空 → 滑动选牌静默降级
 *
 * selectorQuery 的回调在下一帧，touchstart 必须 await 等它完。
 * 实际上 App / MP 的回调非常快（通常 <1ms），不会让玩家感觉到延迟。
 */
/** 从 event.target 往上找 .hand 祖先（H5 端 DOM 正确路径）。 */
function findHandAncestor(target: EventTarget | null): HTMLElement | null {
  let el = target as HTMLElement | null;
  while (el) {
    if (el.classList && el.classList.contains('hand')) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * 从 hand 容器缓存所有卡片矩形。
 *
 * 三端自适应（按 API 可用性探测，不硬编码平台分支）：
 *  - H5：从 event.target 找 hand 祖先 → querySelectorAll('.card') + getBoundingClientRect（同步）
 *  - App / MP：传进来的 root 参数（由 uni.createSelectorQuery 的 select 结果）→ selectAll + boundingClientRect（异步）
 *
 * 🔴 uni-app H5 端 `<view ref="x">` 的 ref 是 undefined！
 *    所以不能靠 handEl ref，必须从事件 target 反推。
 */
async function cacheRects(rootHint?: HTMLElement | null): Promise<void> {
  swipeRects.length = 0;

  // 路径 1：H5 DOM API（同步）—— 优先用调用方传来的 hand 祖先
  const root = rootHint ?? (handEl.value as HTMLElement | null);
  if (root && typeof root.querySelectorAll === 'function') {
    try {
      const cards = root.querySelectorAll<HTMLElement>('.card');
      cards.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          swipeRects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        }
      });
      if (swipeRects.length > 0) return;
    } catch {
      // 某些端 querySelectorAll 不工作 → 继续走路径 2
    }
  }

  // 路径 2：uni selectorQuery（App / MP，异步回调包装成 Promise）
  // 用全局选择器，但只保留 enabled 的（对手背面都是 disabled）+ 结果数量必须匹配 keyedOrder
  const uniGlobal = globalThis as { uni?: unknown };
  const uni = uniGlobal.uni as {
    createSelectorQuery?: () => {
      selectAll: (selector: string) => {
        boundingClientRect: (cb: (list: Array<{ left: number; top: number; width: number; height: number } | null>) => void) => {
          exec: () => void;
        };
      };
      exec: () => void;
    };
  } | undefined;
  if (uni && typeof uni.createSelectorQuery === 'function') {
    const csq = uni.createSelectorQuery.bind(uni); // TS 收窄
    await new Promise<void>((resolve) => {
      try {
        csq()
          .selectAll('.hand .card:not(.card--disabled)')
          .boundingClientRect((list) => {
            if (Array.isArray(list)) {
              list.forEach((item) => {
                if (item && item.width > 0 && item.height > 0) {
                  swipeRects.push({
                    left: item.left,
                    right: item.left + item.width,
                    top: item.top,
                    bottom: item.top + item.height,
                  });
                }
              });
            }
            resolve();
          })
          .exec();
      } catch {
        resolve(); // selectorQuery 抛错也不挂 touch 事件
      }
    });
  }
}

/** 从 TouchEvent 或 MouseEvent 取坐标（H5 用 mouse、App/MP 用 touch）。 */
function getPoint(e: TouchEvent | MouseEvent | Event): { clientX: number; clientY: number } | null {
  const te = e as TouchEvent;
  if (te.touches && te.touches.length > 0) return te.touches[0]!;
  const me = e as MouseEvent;
  if (typeof me.clientX === 'number') return { clientX: me.clientX, clientY: me.clientY };
  return null;
}

async function onPointerStart(e: TouchEvent | MouseEvent) {
  if (!props.interactive) return;
  const p = getPoint(e);
  if (!p) return;

  // 从事件 target 反推当前 hand 容器（uni-app H5 端 ref 是 undefined）
  const handRoot = findHandAncestor(e.target);
  await cacheRects(handRoot);
  if (swipeRects.length === 0) return;

  const hit = hitTest(p.clientX, p.clientY, swipeRects);
  // hit 可能为 -1（没命中任何牌）或超出 keyedOrder 范围（swipeRects 含对手 card 时）
  const safeHit = (hit >= 0 && hit < keyedOrder.value.length) ? hit : -1;
  swipeState.value = startSwipe(safeHit, selectedAsDisplaySet());
  isSwiping.value = false;
  touchStartX = p.clientX;
  touchStartY = p.clientY;
}

function onPointerMove(e: TouchEvent | MouseEvent) {
  if (!props.interactive) return;
  if (swipeState.value.mode === 'idle') return;
  const p = getPoint(e);
  if (!p) return;

  // 首次越过滑动阈值 → 进入滑动模式（Card 不再响应原生 click）
  if (!isSwiping.value) {
    const dx = p.clientX - touchStartX;
    const dy = p.clientY - touchStartY;
    if (isSwipeGesture(dx, dy)) {
      isSwiping.value = true;
      // 起始点不会被 stepSwipe emit（startSwipe 把它同时塞进了 lastHit 和 processed），
      // 但 Card 的原生 click 因 pointer-events: none 被挡住了 → 必须在这里补 emit
      const startIdx = swipeState.value.lastHit;
      if (startIdx !== null && startIdx >= 0 && startIdx < keyedOrder.value.length) {
        if (swipeState.value.mode === 'selecting') {
          emit('swipe-select', displayToOriginal([startIdx]));
        } else {
          emit('swipe-deselect', displayToOriginal([startIdx]));
        }
      }
    }
  }

  let hit = hitTest(p.clientX, p.clientY, swipeRects);
  // 守卫：swipeRects 可能含对手 card（全局选择器降级时），过滤越界 hit
  if (hit >= keyedOrder.value.length) hit = -1;

  const { added, removed } = stepSwipe(swipeState.value, hit);
  if (added.length > 0) emit('swipe-select', displayToOriginal(added));
  if (removed.length > 0) emit('swipe-deselect', displayToOriginal(removed));
}

function onPointerEnd() {
  if (!props.interactive) return;
  if (swipeState.value.mode === 'idle') return;
  swipeState.value = endSwipe();
  isSwiping.value = false;
  swipeRects.length = 0;
}

function onPointerCancel() {
  swipeState.value = endSwipe();
  isSwiping.value = false;
  swipeRects.length = 0;
}

onBeforeUnmount(onPointerCancel);

/* ─── FLIP 动画 ──────────────────────────────────────── */

function canFlip(): boolean {
  if (!props.reflow) return false;
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (
    typeof CSS === 'undefined' ||
    typeof CSS.supports !== 'function' ||
    !CSS.supports('translate', '0px')
  ) {
    return false;
  }
  if (typeof Element === 'undefined') return false;
  return typeof (Element.prototype as { animate?: unknown }).animate === 'function';
}

interface HandSnapshot {
  order: string[];
  rects: Map<string, DOMRect>;
  scale: number;
}

/** 画布祖先的 scale(k)：rect 是视口坐标，卡片 translate 是局部坐标，位移必须除以它。 */
function snapshot(): HandSnapshot | null {
  const root = resolveHandRoot(handEl.value);
  if (!root) return null;
  const scale = canvasScale(root);
  if (scale <= 0) return null;
  const rects = new Map<string, DOMRect>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-hand-key]')) {
    const key = el.getAttribute('data-hand-key');
    if (key === null) continue;
    rects.set(key, el.getBoundingClientRect());
  }
  return { order: [...rects.keys()], rects, scale };
}

function handSignature(): string {
  return keyedOrder.value.map((entry) => entry.key).join('|');
}

let beforeUpdate: HandSnapshot | null = null;
let lastSignature = '';
let armed = false;
/** 只记录本组件启动的 FLIP；不得取消 `.anim-deal-in` 等 CSS 动画。 */
const activeFlips = new WeakMap<Element, Animation>();

onMounted(() => {
  lastSignature = handSignature();
});

onBeforeUpdate(() => {
  const next = handSignature();
  // 仅手牌变化才测旧 DOM：选牌等高频交互不强制同步布局。
  armed = next !== lastSignature && canFlip();
  beforeUpdate = armed ? snapshot() : null;
});

onUpdated(() => {
  const old = beforeUpdate;
  beforeUpdate = null;
  const shouldFlip = armed;
  armed = false;
  lastSignature = handSignature();
  if (!old || !shouldFlip) return;

  const root = resolveHandRoot(handEl.value);
  if (!root) return;
  const elements = [...root.querySelectorAll<HTMLElement>('[data-hand-key]')];
  const entries: Array<{ el: HTMLElement; key: string }> = [];
  for (const el of elements) {
    const key = el.getAttribute('data-hand-key');
    if (key === null) return; // 异常态：不跑 FLIP，避免把不完整的顺序当真
    entries.push({ el, key });
  }

  const currentOrder = entries.map((entry) => entry.key);
  if (
    currentOrder.length === old.order.length &&
    currentOrder.every((key, i) => key === old.order[i])
  ) {
    return; // selected 等非手牌变化：顺序不变，不跑 FLIP
  }

  const scale = canvasScale(root) || old.scale;
  if (scale <= 0) return;

  // 先统一 cancel + 测新 rect（减少 layout 抖动），再统一启动动画。
  const measured: Array<{ el: HTMLElement; oldRect: DOMRect; newRect: DOMRect }> = [];
  for (const { el, key } of entries) {
    const oldRect = old.rects.get(key);
    if (!oldRect) continue; // 新手牌（地主底牌 17→20）没有旧位置
    activeFlips.get(el)?.cancel();
    activeFlips.delete(el);
    measured.push({ el, oldRect, newRect: el.getBoundingClientRect() });
  }

  for (const { el, oldRect, newRect } of measured) {
    const dx = (oldRect.left - newRect.left) / scale;
    const dy = (oldRect.top - newRect.top) / scale;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    if (typeof (el as Element & { animate?: unknown }).animate !== 'function') continue;

    const animation = (
      el as Element & {
        animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;
      }
    ).animate(
      // 独立 translate 属性：与 transform（选中抬升 / anim-deal-in）互不覆盖。
      [{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }],
      { duration: 200, easing: 'ease-out' },
    );
    activeFlips.set(el, animation);
  }
});
</script>

<template>
  <view
    ref="handEl"
    class="hand"
    :class="{ 'hand--swiping': isSwiping }"
    @touchstart="onPointerStart"
    @touchmove="onPointerMove"
    @touchend="onPointerEnd"
    @touchcancel="onPointerCancel"
    @mousedown="onPointerStart"
    @mousemove="onPointerMove"
    @mouseup="onPointerEnd"
    @mouseleave="onPointerCancel"
  >
    <template v-if="cards.length > 0">
      <!--
        `index` 是 `cards` 的**原始下标**（`order` 的成员），不是展示位置（R662）。
        ⚠️ 第二个变量 `i` 只用于**错峰延迟**（§8）—— 不参与下标语义。
        上限 12（参考实现同款 `min(i,12)*35ms`）：不封顶时 20 张牌要等 700ms。
        🔴 `entry.key` 稳定（(r,s) + 出现序号）⇒ 出牌后剩余牌不重建、不重播发牌动画。
      -->
      <Card
        v-for="(entry, i) in keyedOrder"
        :key="entry.key"
        :data-hand-key="reflow ? entry.key : undefined"
        :class="[cardEnterClass(entry), { 'card--swipe-blocked': isSwiping }]"
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
</template>

<style scoped lang="scss">
/*
 * §8 动效。
 * ⚠️ 必须用 `@import` 而**不能**用 `@use`：uni-app 会把 `src/uni.scss` 的**全部内容**
 * 前置到每一个 scss 块（见 uni.scss 顶部注释），而它里面有一个 `@mixin` ——
 * Sass 要求 `@use` 出现在**任何规则之前** ⇒ 组件里写 `@use` 会**构建失败**：
 *   `[sass] @use rules must be written before any other rules.`（实测）
 * `@import` 没有这个位置约束。（Dart Sass 会提示 @import 已弃用，但它仍是本仓唯一可用的形态。）
 */
@import '../styles/animations.scss';

/**
 * 容器的间距/尺寸档位。牌面尺寸本身在 `Card.vue`（`.card` / `.card--small`）；
 * 这里只负责**排布**。默认 `wrap` + 8px gap 服务出牌区/底牌（并排不重叠）；
 * 手牌宿主（`table.vue` 的 `.table__me :deep(.hand)`）覆盖成 `nowrap` + 固定负 margin 扇形。
 */
.hand {
  display: flex;
  flex-wrap: wrap;
  gap: $ftl-space-2;
  align-items: center;
}
.hand__empty {
  color: $ftl-color-text-disabled;
  font-size: $ftl-font-sm;
}
/**
 * 滑动选牌期间：
 *  - 容器关闭 touch-action（避免浏览器手势干扰）；
 *  - 单张牌禁用点击（Card 的 @click 与滑动手势双重触发，pointer-events: none 一刀切）。
 */
.hand--swiping {
  touch-action: none;
}
.card--swipe-blocked {
  pointer-events: none;
}
</style>

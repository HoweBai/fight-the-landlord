<script setup lang="ts">
/**
 * 统一提示浮层：本地项（Task 3）+ session notice / 连接死态内置项（Task 4）。
 *
 * 契约（页面接线，Tasks 5–10）：
 *  - props `{ items: NoticeItem[]; surface: NoticeSurface }` —— `items` 来自该页的
 *    `usePageNotices()`；`surface` 落成 `data-surface` 锚点，并决定**连接所有权**：
 *    牌桌的连接提示归 `ConnectionOverlay`（transport 提示在非 connected 时被本层抑制），
 *    大厅/玩法页的连接死态由本层内置 `connection-dead` 项承担（横条退役前并存）；
 *  - emits `dismiss(id)` —— 页面接回 `notices.dismiss`（内置死态项除外，本层自行吞下）。
 *
 * 渲染顺序（`visible`）：死态内置项 → 带动作的本地项 → session notice → 普通本地项。
 * 同文去重：session notice 与**无动作**本地项 `level + text` 相同只留一条；带动作的本地项
 * 是玩家的处置出口，绝不被同文吞掉（与 `usePageNotices` 的去重口径一致）。
 *
 * ⚠️ **根容器必须常驻**（空 `items` 也渲染）：G3 浮层挂载闸以 `.notice-stack` 的存在为判据；
 *    而且外壳是 `pointer-events: none`、只有条目 `auto` —— 常驻的空壳**不挡点击**。
 * ⚠️ **零定时器**：TTL 全在 `usePageNotices` / `sessionNotice`（§9.6「UI 层不新造时钟」；
 *    `animations.test.ts` 扫 `src/components/**`）。本组件只渲染 + 转发关闭事件；
 *    `sessionItem` / `deadItem` 的 `durationMs: 0` 只表达「不参与本地计时」，本组件不排程。
 * ⚠️ 状态读取走**响应式**的 `currentSession`（同 `SessionNotice.vue` 的纪律）：在 `computed`
 *    里直接 `getGameSession()` 会把旧会话的 ref 记成唯一依赖，换会话后旧死态永久滞留。
 */
import { computed, ref, watch } from 'vue';
import type { NoticeAction, NoticeItem, NoticeSurface } from '../composables/usePageNotices';
import { useAuthStore } from '../stores/auth';
import { currentSession } from '../composables/useGameSession';
import type { SessionNotice } from '../net/session';
import { connectionDeadCopy } from '../net/connection-copy';

const props = defineProps<{ items: NoticeItem[]; surface: NoticeSurface }>();
const emit = defineEmits<{ (e: 'dismiss', id: string): void }>();

/** 被玩家点「×」关掉的内置项（相位/死因/码变化时重置，死态重新可提示）。 */
const dismissedBuiltins = ref<Set<string>>(new Set());

const session = computed(() => currentSession.value);
const state = computed(() => session.value?.connectionState.value ?? null);

/**
 * 顶部偏移：牌桌非 connected 时让位给 `ConnectionOverlay` 的重连提示条/遮罩；
 * 其余情况保持既有 12px。
 */
const topOffset = computed(() =>
  props.surface === 'table' && state.value?.phase !== 'connected' ? 48 : 12,
);

watch(
  () => [state.value?.phase, state.value?.deadReason, state.value?.deadCode],
  () => {
    dismissedBuiltins.value = new Set();
  },
);

/**
 * session notice 的连接所有权抑制（Task 4）：
 *  - 牌桌非 connected：transport 提示交给 `ConnectionOverlay`（不两处叠）；
 *  - 大厅/玩法页 dead：transport 提示交给内置死态项（完整文案 + 动作出口）。
 * 非 transport（action/system）不受抑制 —— 它们与连接相位无关。
 */
const sessionNotice = computed<SessionNotice | null>(() => {
  if (props.surface !== 'lobby' && props.surface !== 'game' && props.surface !== 'table') return null;
  const notice = session.value?.notice.value ?? null;
  if (notice === null) return null;
  const transport = notice.source === 'transport' || notice.source === undefined;
  if (transport) {
    if (props.surface === 'table' && state.value?.phase !== 'connected') return null;
    if (props.surface !== 'table' && state.value?.phase === 'dead') return null;
  }
  return notice;
});

const sessionItem = computed<NoticeItem | null>(() => {
  const notice = sessionNotice.value;
  if (notice === null) return null;
  return { id: 'session-notice', level: notice.level, text: notice.text, durationMs: 0, dismissible: false };
});

/**
 * 内置死态项：大厅 + 玩法页统一走这里。
 * 与 `connection-copy.ts` 同一份文案与动作策略（单一真源）。
 * 牌桌的同类呈现是 `ConnectionOverlay` 遮罩，本层不重复。
 */
const deadItem = computed<NoticeItem | null>(() => {
  if (props.surface !== 'lobby' && props.surface !== 'game') return null;
  const current = state.value;
  if (current?.phase !== 'dead') return null;
  if (dismissedBuiltins.value.has('connection-dead')) return null;
  const copy = connectionDeadCopy(current);
  const actions: NoticeAction[] = [];
  if (copy.canRetry) {
    actions.push({ label: '重新连接', kind: 'primary', onClick: () => session.value?.client.retryConnect() });
  }
  if (copy.canRelogin) {
    actions.push({ label: '重新登录', kind: 'primary', onClick: () => useAuthStore().clearLocalSession() });
  }
  return {
    id: 'connection-dead',
    level: 'error',
    text: copy.message,
    durationMs: 0,
    priority: 'critical',
    dismissible: actions.length === 0,
    actions,
  };
});

const actionItems = computed(() => props.items.filter((item) => (item.actions?.length ?? 0) > 0));
const normalItems = computed(() =>
  props.items.filter((item) => (item.actions?.length ?? 0) === 0),
);

const visible = computed<NoticeItem[]>(() => {
  const items: NoticeItem[] = [];
  if (deadItem.value !== null) items.push(deadItem.value);
  items.push(...actionItems.value);
  if (sessionItem.value !== null) items.push(sessionItem.value);
  for (const item of normalItems.value) {
    const dup = sessionItem.value;
    if (dup !== null && dup.level === item.level && dup.text === item.text) continue;
    items.push(item);
  }
  return items;
});

/**
 * 单次呈现（与页面控制器的去重互补）：session notice 与本地无动作项同文时，
 * 让页面把**本地**那条收掉（渲染层已不重复展示，这里只负责清理计时器/状态位，
 * 避免同文提示在 session 值清空后「复活」）。
 */
watch(
  [sessionItem, () => props.items],
  () => {
    const dup = sessionItem.value;
    if (dup === null) return;
    for (const item of props.items) {
      if ((item.actions?.length ?? 0) === 0 && item.level === dup.level && item.text === dup.text) {
        emit('dismiss', item.id);
      }
    }
  },
  { immediate: true, deep: true },
);

function dismissItem(item: NoticeItem): void {
  if (item.id === 'connection-dead') {
    const next = new Set(dismissedBuiltins.value);
    next.add('connection-dead');
    dismissedBuiltins.value = next;
    return;
  }
  emit('dismiss', item.id);
}

function isDisabled(action: NoticeAction): boolean {
  return typeof action.disabled === 'function' ? action.disabled() : action.disabled === true;
}
/** error/warn 走 `alert`（打断读屏），其余 `status`（礼貌播报）。 */
function roleOf(item: NoticeItem): 'alert' | 'status' {
  return item.level === 'error' || item.level === 'warn' ? 'alert' : 'status';
}
function liveOf(item: NoticeItem): 'assertive' | 'polite' {
  return item.level === 'error' || item.level === 'warn' ? 'assertive' : 'polite';
}
/**
 * 缺省：无动作项的「×」可关；**有动作项不可关** —— 动作是玩家的处置出口，
 * 关掉一条「重试」提示等于把出口藏起来（显式 `dismissible` 仍可覆盖）。
 */
function dismissible(item: NoticeItem): boolean {
  return item.dismissible ?? ((item.actions?.length ?? 0) === 0);
}
</script>

<template>
  <view class="notice-stack" :data-surface="props.surface" :style="{ top: topOffset + 'px' }">
    <view
      v-for="item in visible"
      :key="item.id"
      class="notice anim-toast-in"
      :class="`notice--${item.level}`"
      :data-notice-id="item.id"
      :role="roleOf(item)"
      :aria-live="liveOf(item)"
    >
      <text class="notice__text">{{ item.text }}</text>
      <view v-if="item.actions?.length" class="notice__actions">
        <button
          v-for="action in item.actions"
          :key="action.label"
          type="button"
          class="notice__action"
          :class="`notice__action--${action.kind ?? 'secondary'}`"
          :disabled="isDisabled(action)"
          @click="action.onClick()"
        >
          {{ action.label }}
        </button>
      </view>
      <button
        v-if="dismissible(item)"
        type="button"
        class="notice__close"
        aria-label="关闭提示"
        @click="dismissItem(item)"
      >
        <text class="notice__close-line notice__close-line--a" />
        <text class="notice__close-line notice__close-line--b" />
      </button>
    </view>
  </view>
</template>

<style scoped lang="scss">
/**
 * ⚠️ `@import`（不是 `@use`）：uni-app 会把 `uni.scss`（含 `@mixin`）前置进每个 scss 块，
 *    `@use` 必须排在一切规则之前 ⇒ 组件里写 `@use` 会构建失败（理由全文见 animations.scss 头注释）。
 *
 * 层级：本浮层挂在 `LandscapeStage` 的 `.stage__overlay`（z-index 15）内；
 * 外壳 `pointer-events: none`，只有 `.notice` 条目 `auto` —— 空白区不吞页面点击。
 * `top` 的缺省值被根元素行内样式（`topOffset`：牌桌非 connected = 48px）覆盖。
 */
@import "../styles/animations.scss";

.notice-stack {
  position: absolute;
  top: 12px;
  left: 50%;
  z-index: 15;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-3;
  width: min(720px, calc(100% - #{$ftl-space-8}));
  transform: translateX(-50%);
  pointer-events: none;
}
.notice {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-3;
  box-sizing: border-box;
  padding: $ftl-space-3 $ftl-space-6;
  border: $ftl-hairline solid $ftl-color-night-soft;
  border-radius: $ftl-radius-md;
  background: rgb(0 0 0 / 62%);
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
  line-height: 1.4;
  pointer-events: auto;
}
.notice__text {
  flex: 0 1 auto;
  min-width: 0;
  text-align: center;
  overflow-wrap: anywhere;
}
.notice--info {
  border-color: rgba($ftl-color-on-primary, 0.35);
}
.notice--success {
  border-color: $ftl-color-gold;
  color: $ftl-color-gold-light;
}
.notice--warn {
  border-color: $ftl-color-gold;
  color: $ftl-color-gold-light;
}
.notice--error {
  border-color: $ftl-color-danger;
  color: $ftl-color-danger-on-dark;
}
.notice__actions {
  flex: 0 0 auto;
  display: flex;
  gap: $ftl-space-3;
}
.notice__action {
  margin: 0;
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-5;
  border: $ftl-hairline solid rgba($ftl-color-on-primary, 0.45);
  border-radius: $ftl-radius-sm;
  background: transparent;
  color: $ftl-color-on-primary;
  font-size: $ftl-font-sm;
}
.notice__action--primary {
  border-color: $ftl-color-gold;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
}
.notice__action[disabled] {
  opacity: 0.5;
}
.notice__close {
  /**
   * 绝对定位到 notice 条右侧 —— 不占 flex 空间，notice 正文可以真正居中。
   * 容器是 `.notice`（position: relative 已存在），锚在右边距 + 垂直居中。
   *
   * ⚠️ icon 用**子元素**而非 ::before/::after —— uni-app 把 <button> 编译成
   *    <uni-button> 自定义元素后，伪元素在宿主内部层上渲染位置会跑飞，
   *    真机上 × 会变成倾斜的 < 形状（截图已复现）。
   */
  position: absolute;
  right: $ftl-space-2;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
  border: $ftl-hairline solid rgba($ftl-color-on-primary, 0.25);
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-on-primary, 0.08);
  color: rgba($ftl-color-on-primary, 0.8);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;

  &:hover {
    background: rgba($ftl-color-on-primary, 0.2);
    border-color: rgba($ftl-color-on-primary, 0.45);
  }
  &:active {
    transform: translateY(-50%) scale(0.92);
  }
}
/** 两条 14×2 斜线交叉 = 关闭 icon。用 <text> 空元素 + 纯 CSS 画线。 */
.notice__close-line {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 14px;
  height: 2px;
  background: currentColor;
  border-radius: $ftl-hairline;
  display: block;
}
.notice__close-line--a { transform: translate(-50%, -50%) rotate(45deg); }
.notice__close-line--b { transform: translate(-50%, -50%) rotate(-45deg); }
</style>

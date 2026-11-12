<script lang="ts">
/**
 * 动作区对外契约（Task 7）。类型放普通 `<script>` 里才能 `export`。
 */
import type { MahjongClaimOption, MahjongSuit } from '@fight-the-landlord/protocol';

export type ActionBarMode = 'play' | 'claim' | 'exchange' | 'lack';

export type ActionBarAction =
  | { kind: 'claim'; option: MahjongClaimOption }
  | { kind: 'pass' }
  | { kind: 'discard' }
  | { kind: 'exchange' }
  | { kind: 'lack'; suit: MahjongSuit };
</script>

<script setup lang="ts">
/**
 * 麻将动作区（哑组件）：v17 单行动作带。
 *
 * - play：胡 / 杠 / 过 / 出牌（出牌最右）；多杠合并为「杠」+ 副字数字 + 上方选择面板。
 * - claim：选项顺序（碰/杠/胡）+ 过最右；胡按钮把 20×30 待响应牌放在「胡」上方（仅 claim）。
 * - exchange：单按钮「换三张」+ 副字「已选 x/3」。
 * - lack：万/筒/条。
 * - 尺寸：高 64、gap 6；宽度按模式+数量（最大根宽 218）；全部 calc(px * var(--mj-u, 1))。
 * - 主字 24px（皮肤固定），副字 $ftl-font-xs；按钮 line-height: 1（牌面 + 文本的 64 高预算）。
 * - 只渲染 props、只 emit action；不判规则/不取数/不造计时器。
 */
import { computed, ref, watch } from 'vue';
import { MAHJONG_SUIT_NAMES } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

const props = withDefaults(defineProps<{
  mode: ActionBarMode;
  options?: MahjongClaimOption[];
  showPass?: boolean;
  busy?: boolean;
  selectedCount?: number;
  recommendedSuit?: MahjongSuit | null;
}>(), {
  options: () => [],
  showPass: false,
  busy: false,
  selectedCount: 0,
  recommendedSuit: null,
});

const emit = defineEmits<{
  (e: 'action', action: ActionBarAction): void;
}>();

const claimOptions = computed(() => props.options.filter((o) => o.claim !== 'pass'));
const huOption = computed(() => claimOptions.value.find((o) => o.claim === 'hu') ?? null);
const gangOptions = computed(() => claimOptions.value.filter((o) => o.claim === 'gang'));
const SUITS: readonly MahjongSuit[] = [0, 1, 2];

const gangOpen = ref(false);
watch(() => props.options, () => {
  gangOpen.value = false;
});

/** 当前行渲染的按钮数（决定宽度）。 */
const buttonCount = computed(() => {
  if (props.mode === 'claim') return claimOptions.value.length + (props.showPass ? 1 : 0);
  if (props.mode === 'play') {
    return (
      1 +
      (huOption.value ? 1 : 0) +
      (gangOptions.value.length > 0 ? 1 : 0) +
      (props.showPass ? 1 : 0)
    );
  }
  if (props.mode === 'lack') return 3;
  return 1;
});

/** D3：按模式+数量给单键宽度（px，未乘 u）。 */
function widthFor(mode: ActionBarMode, count: number): number {
  if (mode === 'exchange') return 140;
  if (mode === 'lack') return 66;
  if (mode === 'claim') {
    if (count <= 2) return 102;
    if (count === 3) return 66;
    return 50;
  }
  if (count <= 1) return 176;
  if (count === 2) return 102;
  if (count === 3) return 66;
  return 50;
}

const n = computed(() => Math.max(1, Math.min(4, buttonCount.value)));
// n>4 只保护宽度表（钳到 4），不防按钮溢出；服务端可达上限 4（play 3）。
const btnW = computed(() => widthFor(props.mode, n.value));
const rowW = computed(() => n.value * btnW.value + (n.value - 1) * 6);

const px = (v: number) => `calc(${v}px * var(--mj-u, 1))`;
const btnStyle = computed(() => ({ width: px(btnW.value), height: px(64) }));
const barStyle = computed(() => ({ width: px(rowW.value) }));
const selectorStyle = {
  position: 'absolute',
  right: '0',
  bottom: 'calc(100% + 8px * var(--mj-u, 1))',
  width: 'calc(218px * var(--mj-u, 1))',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'calc(6px * var(--mj-u, 1))',
} as const;
const selectorItemStyle = {
  flex: '0 0 calc(50% - 3px * var(--mj-u, 1))',
  height: 'calc(48px * var(--mj-u, 1))',
} as const;

function emitAction(action: ActionBarAction): void {
  emit('action', action);
}

function emitClaim(option: MahjongClaimOption): void {
  emit('action', { kind: 'claim', option });
}

/** claim 文案：胡/杠/碰；胡的牌面由 20×30 图片表达，不再写「胡 5万」。 */
function claimLabel(opt: MahjongClaimOption): string {
  if (opt.claim === 'hu') return '胡';
  if (opt.claim === 'gang') return '杠';
  return '碰';
}

/** 多杠选择器行文案：牌型（如 `5万`）。 */
function gangLabel(opt: MahjongClaimOption): string {
  return opt.tile ? `${opt.tile.r}${MAHJONG_SUIT_NAMES[opt.tile.s]}` : '杠';
}

function pickHu(): void {
  if (huOption.value) emitClaim(huOption.value);
}

function pickSoleGang(): void {
  const only = gangOptions.value[0];
  if (only) emitClaim(only);
}

function toggleGang(): void {
  gangOpen.value = !gangOpen.value;
}

function pickGang(opt: MahjongClaimOption): void {
  gangOpen.value = false;
  emitClaim(opt);
}
</script>

<template>
  <view class="mj-action-bar anim-action-slide-in" :style="barStyle">
    <template v-if="mode === 'play'">
      <button
        v-if="huOption"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--hu"
        :style="btnStyle"
        :disabled="busy"
        @click="pickHu"
      >胡</button>
      <button
        v-if="gangOptions.length === 1"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--gang"
        :style="btnStyle"
        :disabled="busy"
        @click="pickSoleGang"
      >杠</button>
      <button
        v-else-if="gangOptions.length > 1"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--gang"
        :style="btnStyle"
        :disabled="busy"
        @click="toggleGang"
      >
        杠
        <text class="mj-action-bar__sub">{{ gangOptions.length }}</text>
      </button>
      <button
        v-if="showPass"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--pass"
        :style="btnStyle"
        :disabled="busy"
        @click="emitAction({ kind: 'pass' })"
      >过</button>
      <button
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--discard"
        :style="btnStyle"
        :disabled="busy || selectedCount !== 1"
        @click="emitAction({ kind: 'discard' })"
      >出牌</button>
    </template>

    <template v-else-if="mode === 'claim'">
      <button
        v-for="(opt, i) in claimOptions"
        :key="i"
        type="button"
        class="mj-action-bar__btn anim-claim-pulse"
        :class="{
          'mj-action-bar__btn--primary': opt.claim === 'hu',
          'mj-action-bar__btn--gang': opt.claim === 'gang',
        }"
        :style="btnStyle"
        :disabled="busy"
        @click="emitClaim(opt)"
      >
        <MahjongTile
          v-if="opt.claim === 'hu' && opt.tile"
          :tile="opt.tile"
          direction="my"
          :w="20"
          :h="30"
        />
        {{ claimLabel(opt) }}
      </button>
      <button
        v-if="showPass"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--pass anim-claim-pulse"
        :style="btnStyle"
        :disabled="busy"
        @click="emitAction({ kind: 'pass' })"
      >过</button>
    </template>

    <template v-else-if="mode === 'exchange'">
      <button
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--exchange"
        :style="btnStyle"
        :disabled="busy"
        @click="emitAction({ kind: 'exchange' })"
      >
        换三张
        <text class="mj-action-bar__sub">已选 {{ selectedCount }}/3</text>
      </button>
    </template>

    <template v-else>
      <button
        v-for="suit in SUITS"
        :key="suit"
        type="button"
        class="mj-action-bar__btn mj-action-bar__btn--lack"
        :class="{ 'mj-action-bar__btn--recommended': recommendedSuit === suit }"
        :style="btnStyle"
        :disabled="busy"
        @click="emitAction({ kind: 'lack', suit })"
      >
        {{ MAHJONG_SUIT_NAMES[suit] }}
        <text v-if="recommendedSuit === suit" class="mj-action-bar__rec">推荐</text>
      </button>
    </template>

    <view
      v-if="mode === 'play' && gangOpen && gangOptions.length > 1"
      class="mj-action-bar__gang-selector"
      :style="selectorStyle"
    >
      <button
        v-for="(opt, i) in gangOptions"
        :key="i"
        type="button"
        class="mj-action-bar__gang-item"
        :style="selectorItemStyle"
        :disabled="busy"
        @click="pickGang(opt)"
      >
        {{ gangLabel(opt) }}
      </button>
    </view>
  </view>
</template>

<style scoped lang="scss">
// claim 呼吸 / 滑入动画的类与 keyframes 都在 animations.scss（scoped 会重命名 @keyframes ⇒ 必须导入）。
@import '../../../styles/animations.scss';

.mj-action-bar {
  display: flex;
  align-items: stretch;
  gap: calc(6px * var(--mj-u, 1));
  height: calc(64px * var(--mj-u, 1));
}

// 红金皮肤（v4 §4.6）：漆底 / 金棕发丝边 / 12px 圆角 / 24px cream / 3D 阴影。
.mj-action-bar__btn {
  @include ftl-btn;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 0;
  padding: 0;
  border: $ftl-hairline solid $ftl-color-mj-border;
  border-radius: 12px;
  background: rgba($ftl-color-mj-lacquer, .92);
  color: $ftl-color-mj-cream;
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  box-shadow: 0 4px 0 $ftl-color-mj-border;
}

.mj-action-bar__btn--primary {
  border-color: $ftl-color-mj-edge;
  background: linear-gradient($ftl-color-mj-status, $ftl-color-mj-gold);
  color: $ftl-color-mj-ink;
}

.mj-action-bar__btn--gang {
  border-color: rgba($ftl-color-mj-gold, .75);
  color: $ftl-color-mj-gold-light;
}

.mj-action-bar__btn--pass {
  border-color: rgba($ftl-color-mj-muted, .5);
  background: rgba($ftl-color-mj-lacquer, .6);
  color: $ftl-color-mj-muted;
}

.mj-action-bar__btn--recommended {
  border-color: $ftl-color-mj-gold;
  box-shadow: 0 0 0 $ftl-hairline rgba($ftl-color-mj-gold, .5), 0 4px 0 $ftl-color-mj-border;
}

.mj-action-bar__rec {
  display: block;
  font-size: $ftl-font-xs;
  font-weight: 400;
  line-height: 1;
  color: $ftl-color-mj-gold-light;
}

.mj-action-bar__sub {
  display: block;
  font-size: $ftl-font-xs;
  font-weight: 400;
  line-height: 1;
  color: inherit;
  opacity: .85;
}

.mj-action-bar__gang-selector {
  z-index: 1;
}

// 多杠选择器项（红金皮肤）：漆底金边。
.mj-action-bar__gang-item {
  @include ftl-btn;
  min-height: 0;
  padding: 0 $ftl-space-4;
  border: $ftl-hairline solid rgba($ftl-color-mj-gold, .7);
  border-radius: 12px;
  background: rgba($ftl-color-mj-lacquer, .92);
  color: $ftl-color-mj-cream;
  font-size: $ftl-font-md;
  font-weight: 700;
  line-height: 1;
}

.mj-action-bar__btn[disabled],
.mj-action-bar__gang-item[disabled] {
  opacity: 0.5;
}
</style>

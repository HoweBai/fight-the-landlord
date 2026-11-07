<script lang="ts">
/**
 * 动作区对外契约（Task 7）。类型放普通 `<script>` 里才能 `export`。
 *
 * - `ActionBarMode`：四个窗口形态。
 * - `ActionBarAction`：唯一出口 `action` 的载荷；claim 直接带原 option，
 *   由 Board（Task 8）翻译成协议动作。
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
 * 麻将动作区（哑组件）：只渲染 props、只 emit `action`，不判规则、不取数。
 *
 * 设计：docs/superpowers/specs/2026-11-05-mahjong-table-redgold-design-v4.md §4.6
 *   - play：出牌（宽 176）+ 胡 + 杠；多杠合并为「杠 N」选择器。
 *   - claim：碰/杠/胡/过；options 过滤 pass，`showPass` 只认 claimsForMe 里的 pass
 *     （强制胡无“过”，v12 §2）。
 *   - exchange：换三张（宽 176）+ 已选 x/3。
 *   - lack：万/筒/条三个 84 + 推荐标记。
 *   - rob 的胡按钮显示待响应牌「胡 5万」（v13 §10.2）。
 *
 * 尺寸：2 列 × 84 按钮、gap 8（内联样式由测试钉死）；主按钮金实心、次按钮描金。
 * 无动画（本组件不引入 @keyframes），呼吸动效留在 Board 的 claim 闸里。
 */
import { computed, ref, watch } from 'vue';
import { MAHJONG_SUIT_NAMES } from '@fight-the-landlord/protocol';

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

/** 渲染面永远排除 pass：过只由 `showPass` 单独渲染，保证恰好一个。 */
const claimOptions = computed(() => props.options.filter((o) => o.claim !== 'pass'));
const huOption = computed(() => claimOptions.value.find((o) => o.claim === 'hu') ?? null);
const gangOptions = computed(() => claimOptions.value.filter((o) => o.claim === 'gang'));

const SUITS: readonly MahjongSuit[] = [0, 1, 2];

/** 换窗口（options 引用变化）时收起多杠选择器。 */
const gangOpen = ref(false);
watch(() => props.options, () => {
  gangOpen.value = false;
});

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 84px)',
  gap: '8px',
  justifyContent: 'end',
} as const;

const btnStyle = { width: '84px', height: '84px' } as const;
const wideBtnStyle = { width: '176px', height: '84px', gridColumn: 'span 2' } as const;
const wideRowStyle = { gridColumn: 'span 2' } as const;
const gangSelectorStyle = { gridColumn: 'span 2' } as const;

function emitAction(action: ActionBarAction): void {
  emit('action', action);
}

function emitClaim(option: MahjongClaimOption): void {
  emit('action', { kind: 'claim', option });
}

/** 牌面文案：点数 + 花色名（如 `5万`；契约按这个顺序，见 task-7-brief）。 */
function tileLabel(tile: { s: MahjongSuit; r: number }): string {
  return `${tile.r}${MAHJONG_SUIT_NAMES[tile.s]}`;
}

/** claim 模式的按钮文案；胡带待响应牌（rob 窗口）。 */
function claimLabel(opt: MahjongClaimOption): string {
  if (opt.claim === 'hu') return opt.tile ? `胡 ${tileLabel(opt.tile)}` : '胡';
  if (opt.claim === 'gang') return '杠';
  return '碰';
}

/** 多杠选择器行文案：牌型（如 `5万`）。 */
function gangLabel(opt: MahjongClaimOption): string {
  return opt.tile ? tileLabel(opt.tile) : '杠';
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
  <view class="mj-action-bar">
    <view class="mj-action-bar__grid" :style="gridStyle">
      <template v-if="mode === 'play'">
        <button
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--discard"
          :style="wideBtnStyle"
          :disabled="busy"
          @click="emitAction({ kind: 'discard' })"
        >
          出牌
        </button>

        <button
          v-if="huOption"
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--hu"
          :style="btnStyle"
          :disabled="busy"
          @click="pickHu"
        >
          胡
        </button>

        <button
          v-if="gangOptions.length === 1"
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--gang"
          :style="btnStyle"
          :disabled="busy"
          @click="pickSoleGang"
        >
          杠
        </button>
        <button
          v-else-if="gangOptions.length > 1"
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--gang"
          :style="btnStyle"
          :disabled="busy"
          @click="toggleGang"
        >
          杠 {{ gangOptions.length }}
        </button>

        <button
          v-if="showPass"
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--pass"
          :style="btnStyle"
          :disabled="busy"
          @click="emitAction({ kind: 'pass' })"
        >
          过
        </button>

        <view
          v-if="gangOpen && gangOptions.length > 1"
          class="mj-action-bar__gang-selector"
          :style="gangSelectorStyle"
        >
          <button
            v-for="(opt, i) in gangOptions"
            :key="i"
            type="button"
            class="mj-action-bar__gang-item"
            :disabled="busy"
            @click="pickGang(opt)"
          >
            {{ gangLabel(opt) }}
          </button>
        </view>
      </template>

      <template v-else-if="mode === 'claim'">
        <button
          v-for="(opt, i) in claimOptions"
          :key="i"
          type="button"
          class="mj-action-bar__btn"
          :class="{
            'mj-action-bar__btn--primary': opt.claim === 'hu',
            'mj-action-bar__btn--gang': opt.claim === 'gang',
          }"
          :style="btnStyle"
          :disabled="busy"
          @click="emitClaim(opt)"
        >
          {{ claimLabel(opt) }}
        </button>
        <button
          v-if="showPass"
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--pass"
          :style="btnStyle"
          :disabled="busy"
          @click="emitAction({ kind: 'pass' })"
        >
          过
        </button>
      </template>

      <template v-else-if="mode === 'exchange'">
        <button
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--exchange"
          :style="wideBtnStyle"
          :disabled="busy"
          @click="emitAction({ kind: 'exchange' })"
        >
          换三张
        </button>
        <text class="mj-action-bar__hint" :style="wideRowStyle">已选 {{ selectedCount }}/3</text>
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
    </view>
  </view>
</template>

<style scoped lang="scss">
.mj-action-bar {
  display: flex;
  justify-content: flex-end;
}

.mj-action-bar__btn {
  @include ftl-btn;
  min-height: 0;
  padding: 0;
  border: $ftl-hairline solid rgba($ftl-color-gold, 0.55);
  border-radius: $ftl-radius-md;
  background: linear-gradient(180deg, rgba(40, 76, 51, 0.9), rgba(23, 50, 33, 0.94));
  color: rgba($ftl-color-on-primary, 0.94);
  font-size: $ftl-font-md;
  font-weight: 700;
}

// 主按钮：金实心（出牌 / 胡 / 换三张）
.mj-action-bar__btn--primary {
  border-color: $ftl-color-gold-deep;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
}

// 杠：描金加强
.mj-action-bar__btn--gang {
  border-color: rgba($ftl-color-gold, 0.75);
  color: $ftl-color-gold-light;
}

// 过：弱化处理
.mj-action-bar__btn--pass {
  border-color: rgba($ftl-color-border, 0.5);
  background: rgba($ftl-color-surface, 0.45);
  color: rgba($ftl-color-text, 0.7);
}

// 推荐缺：金色描边 + 小标记
.mj-action-bar__btn--recommended {
  border-color: $ftl-color-gold;
  box-shadow: 0 0 0 $ftl-hairline rgba($ftl-color-gold, 0.5);
}

.mj-action-bar__rec {
  display: block;
  font-size: $ftl-font-xs;
  font-weight: 400;
  color: $ftl-color-gold-light;
}

.mj-action-bar__hint {
  font-size: $ftl-font-sm;
  color: $ftl-color-gold-light;
  text-align: center;
}

.mj-action-bar__gang-selector {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mj-action-bar__gang-item {
  @include ftl-btn;
  min-height: 0;
  height: 56px;
  padding: 0 $ftl-space-4;
  border: $ftl-hairline solid rgba($ftl-color-gold, 0.7);
  border-radius: $ftl-radius-md;
  background: linear-gradient(180deg, rgba(60, 110, 75, 0.92), rgba(35, 75, 50, 0.95));
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 700;
}

.mj-action-bar__btn[disabled],
.mj-action-bar__gang-item[disabled] {
  opacity: 0.5;
}
</style>

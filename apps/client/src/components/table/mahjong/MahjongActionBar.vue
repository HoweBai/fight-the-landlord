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
 *   - play：严格 2×2 网格（84px 格）：胡 (1,1) / 杠 (2,1) / 过 (1,2) / 出牌 (2,2)；
 *     多杠合并为「杠 N」选择器。
 *   - claim：碰/杠/胡/过；options 过滤 pass，`showPass` 只认 claimsForMe 里的 pass
 *     （强制胡无“过”，v12 §2）。
 *   - exchange：换三张（宽 176）+ 已选 x/3。
 *   - lack：万/筒/条三个 84 + 推荐标记。
 *   - rob 的胡按钮显示待响应牌「胡 5万」（v13 §10.2）。
 *
 * 尺寸：2 列 × 2 行、每格 84、gap 8（内联样式由测试钉死；行也必须显式固定 ——
 * 否则 play 只出牌一格时隐式行会在 `align-content: normal` 下被拉伸、出牌离右下角 42px）。
 * 主按钮 `status→gold` 渐变实心、次按钮描金。
 * 动效（Task 10）：claim 窗口给按钮挂 `anim-claim-pulse` —— 它是**麻将唯一允许的
 * infinite 类**（定义在 animations.scss；本组件不写 @keyframes）。
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
  // 行也必须显式：动作区矩形是 176×176，2×84+8 正好铺满。
  // 只给隐式行时 play 单格（出牌）会让空行 1 在 align-content: normal 下被拉伸 ≈42px，
  // 出牌被顶到右上一格 —— 固定行轨道才能把它钉死在右下角。
  gridTemplateRows: 'repeat(2, 84px)',
  gap: '8px',
  justifyContent: 'end',
} as const;

const btnStyle = { width: '84px', height: '84px' } as const;
/**
 * 严格 2×2 布局（2026-11-08 红金皮肤 Task 3，mockup `.actions`）：
 * play 窗口四格固定 —— 胡 (1,1) / 杠 (2,1) / 过 (1,2) / 出牌 (2,2)。
 * 出牌不再是 176px 宽按钮（mockup 里 2×2 的右下格才是主按钮）。
 */
const discardBtnStyle = { width: '84px', height: '84px', gridColumn: '2', gridRow: '2' } as const;
const huBtnStyle = { width: '84px', height: '84px', gridColumn: '1', gridRow: '1' } as const;
const gangBtnStyle = { width: '84px', height: '84px', gridColumn: '2', gridRow: '1' } as const;
const playPassBtnStyle = { width: '84px', height: '84px', gridColumn: '1', gridRow: '2' } as const;
/** claim 窗口：非过选项自动排布，过固定在右下格。 */
const claimPassBtnStyle = { width: '84px', height: '84px', gridColumn: '2', gridRow: '2' } as const;
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
  <view class="mj-action-bar anim-action-slide-in">
    <view class="mj-action-bar__grid" :style="gridStyle">
      <template v-if="mode === 'play'">
        <button
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--discard"
          :style="discardBtnStyle"
          :disabled="busy || (mode === 'play' && selectedCount !== 1)"
          @click="emitAction({ kind: 'discard' })"
        >
          出牌
        </button>

        <button
          v-if="huOption"
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--primary mj-action-bar__btn--hu"
          :style="huBtnStyle"
          :disabled="busy"
          @click="pickHu"
        >
          胡
        </button>

        <button
          v-if="gangOptions.length === 1"
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--gang"
          :style="gangBtnStyle"
          :disabled="busy"
          @click="pickSoleGang"
        >
          杠
        </button>
        <button
          v-else-if="gangOptions.length > 1"
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--gang"
          :style="gangBtnStyle"
          :disabled="busy"
          @click="toggleGang"
        >
          杠 {{ gangOptions.length }}
        </button>

        <button
          v-if="showPass"
          type="button"
          class="mj-action-bar__btn mj-action-bar__btn--pass"
          :style="playPassBtnStyle"
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
          class="mj-action-bar__btn anim-claim-pulse"
          :class="{
            'mj-action-bar__btn--primary': opt.claim === 'hu',
            'mj-action-bar__btn--gang': opt.claim === 'gang',
          }"
          :style="btnStyle"
          :disabled="busy"
          @click="emitClaim(opt)"
        >
          <!-- rob 胡待响应牌（v13 §10.2 / 红金皮肤 Task 3）：20×30 小牌浮在「胡」文本上方。 -->
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
          :style="claimPassBtnStyle"
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
// Task 10：claim 呼吸（`.anim-claim-pulse`）。scoped CSS 按组件重命名 @keyframes
// ⇒ 必须导入动画类文件（同 MahjongMeld / MahjongHandBacks 的纪律）。
@import '../../../styles/animations.scss';

.mj-action-bar {
  display: flex;
  justify-content: flex-end;
}

// 红金皮肤（Task 3，mockup `.act`）：漆底 / 金棕发丝边 / 12px 圆角 / 24px cream / 3D 阴影。
.mj-action-bar__btn {
  @include ftl-btn;
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
  box-shadow: 0 4px 0 $ftl-color-mj-border;
}

// 主按钮：status→gold 渐变 + 深字（出牌 / 胡 / 换三张）
.mj-action-bar__btn--primary {
  border-color: $ftl-color-mj-edge;
  background: linear-gradient($ftl-color-mj-status, $ftl-color-mj-gold);
  color: $ftl-color-mj-ink;
}

// 杠：描金加强
.mj-action-bar__btn--gang {
  border-color: rgba($ftl-color-mj-gold, .75);
  color: $ftl-color-mj-gold-light;
}

// 过：弱化处理（幽灵按钮）
.mj-action-bar__btn--pass {
  border-color: rgba($ftl-color-mj-muted, .5);
  background: rgba($ftl-color-mj-lacquer, .6);
  color: $ftl-color-mj-muted;
}

// 推荐缺：金色描边 + 小标记（必须**合并** 3D 底边，单写 ring 会丢掉 `0 4px 0` 的立体感）
.mj-action-bar__btn--recommended {
  border-color: $ftl-color-mj-gold;
  box-shadow: 0 0 0 $ftl-hairline rgba($ftl-color-mj-gold, .5), 0 4px 0 $ftl-color-mj-border;
}

.mj-action-bar__rec {
  display: block;
  font-size: $ftl-font-xs;
  font-weight: 400;
  color: $ftl-color-mj-gold-light;
}

.mj-action-bar__hint {
  font-size: $ftl-font-sm;
  color: $ftl-color-mj-gold-light;
  text-align: center;
}

.mj-action-bar__gang-selector {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

// 多杠选择器项（红金皮肤）：漆底金边（旧绿渐变已删）。
.mj-action-bar__gang-item {
  @include ftl-btn;
  min-height: 0;
  height: 56px;
  padding: 0 $ftl-space-4;
  border: $ftl-hairline solid rgba($ftl-color-mj-gold, .7);
  border-radius: 12px;
  background: rgba($ftl-color-mj-lacquer, .92);
  color: $ftl-color-mj-cream;
  font-size: $ftl-font-md;
  font-weight: 700;
}

.mj-action-bar__btn[disabled],
.mj-action-bar__gang-item[disabled] {
  opacity: 0.5;
}
</style>

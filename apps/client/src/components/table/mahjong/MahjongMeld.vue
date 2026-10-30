<script setup lang="ts">
/**
 * 副露（碰 / 杠 / 暗杠）独立组件。
 * 按 MahjongMeldView.kind 渲染不同堆叠样式：
 *   peng   → 3 张横排叠加（碰源 z-index 在上）
 *   gang   → 3 张横排 + 第 4 张叠在中间上方（直杠/补杠统一）
 *   angang → 4 张牌背同 gang 堆叠
 *
 * Batch 2 增量 pop 动画：
 *   新增 pop?: boolean prop — Board.vue 通过 seenMeldKeys 增量判定后传 true
 *   仅新增副露播 pop（初始 mount / 中途进入房的已有副露不播 — 防视觉爆炸 B3 阻断修法）
 *   动画播完 emit('pop-done') 让父组件清理临时标记
 */
import { computed } from 'vue';
import type { MahjongMeldView } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

type Direction = 'my' | 'top' | 'left' | 'right';
/** 与 MahjongTile.Rotate 对齐。 */
type Rotate = 'left' | 'right';

const props = withDefaults(
  defineProps<{
    meld: MahjongMeldView;
    /** 牌面方向，透传给 MahjongTile。 */
    direction?: Direction;
    size?: 'sm' | 'md' | 'lg';
    /** true 时播放进场 pop 动画（增量新增时由 Board 传 true）。Batch 2 新增。 */
    pop?: boolean;
    /** 显式牌张尺寸（设计 px）；不传则用 size 档位。 */
    tileW?: number;
    tileH?: number;
    /** 组内叠压 px（正数）；不传则用 size 档位的默认负 margin。 */
    overlap?: number;
  }>(),
  { size: 'sm', pop: false, vertical: false },
);

const emit = defineEmits<{
  /** pop 动画播完，Board.vue 清理 newMeldKeySet 临时标记。 */
  (e: 'pop-done'): void;
}>();

const styleClass = computed(() => {
  switch (props.meld.kind) {
    case 'peng': return 'mj-meld--peng';
    case 'angang': return 'mj-meld--angang';
    default: return 'mj-meld--gang';
  }
});

/** pop 动画类：按 kind 选不同 modifier。 */
const popAnimClass = computed(() => {
  if (!props.pop) return '';
  switch (props.meld.kind) {
    case 'peng': return 'anim-meld-pop';
    case 'angang': return 'anim-meld-pop anim-meld-pop--angang';
    default: return 'anim-meld-pop anim-meld-pop--gang';
  }
});

function tileStyle(index: number): { marginLeft?: string } | undefined {
  return index > 0 && props.overlap !== undefined
    ? { marginLeft: `-${props.overlap}px` }
    : undefined;
}

function onAnimEnd(e: AnimationEvent): void {
  // 只处理 pop 动画结束（ftl-peng-pop / ftl-gang-pop / ftl-angang-pop）
  if (
    e.animationName === 'ftl-peng-pop' ||
    e.animationName === 'ftl-gang-pop' ||
    e.animationName === 'ftl-angang-pop'
  ) {
    emit('pop-done');
  }
}
</script>

<template>
  <view
    class="mj-meld"
    :class="[styleClass, `mj-meld--${size}`, popAnimClass, { 'mj-meld--vertical': vertical }]"
    @animationend="onAnimEnd"
  >
    <!-- 碰 3 张；杠/暗杠 4 张同行（第 4 张不再绝对定位叠高） -->
    <MahjongTile
      v-for="(tile, i) in meld.tiles"
      :key="`t-${i}`"
      :tile="tile"
      :back="meld.kind === 'angang'"
      :direction="direction"
      :size="size"
      :w="tileW"
      :h="tileH"
      :style="tileStyle(i)"
    />
  </view>
</template>

<style scoped lang="scss">
// Batch 2 闸纪律：必须 @import 进组件，不能 @use（animations.scss 顶部注释）
@import '../../../styles/animations.scss';

.mj-meld {
  display: inline-flex;
  align-items: flex-end;
  position: relative;
  line-height: 0; // 消除 image inline 间隙
}

/** 3 张横向叠加：后两张往左负 margin。放大后所有档位等比增加。 */
.mj-meld :deep(.mj-tile) {
  margin-left: -16px; // sm 宽 34px，overlap -16px ≈ 47%
  position: relative;
}
.mj-meld :deep(.mj-tile:first-child) {
  margin-left: 0;
}

/** 大尺寸时负 margin 跟着调 */
.mj-meld--md :deep(.mj-tile),
.mj-meld--lg :deep(.mj-tile) {
  margin-left: -22px;
}
</style>

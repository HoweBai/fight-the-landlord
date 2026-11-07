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
 *
 * 侧家方向（vertical）：
 *   left/right 方向没有任何旋转——继续用 left/right 目录的 49×40 横置素材，
 *   只把组内牌张上下竖叠（flex-direction: column + 非首张 marginTop）。
 *   暗杠 4 张牌背 aspectFill 填满方框。
 */
import { computed } from 'vue';
import type { MahjongMeldView } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

type Direction = 'my' | 'top' | 'left' | 'right';

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
    /**
     * 竖向堆叠（侧家副露）。true 时组内牌张从上到下叠，非首张用 marginTop: -overlap。
     * 不旋转——方向靠 left/right 横置素材本身。
     */
    vertical?: boolean;
    /**
     * rob 来源副露高亮（v12 §2 / v13 §10.2）：由 River 对匹配 `claimSourceMeldKey` 的组传 true。
     * 只加 `outline`（不占布局），不打断 pop 动画。
     */
    highlight?: boolean;
  }>(),
  { size: 'sm', pop: false, vertical: false, highlight: false },
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

function tileStyle(index: number): { marginLeft?: string; marginTop?: string } | undefined {
  if (index === 0 || props.overlap === undefined) return undefined;
  return props.vertical
    ? { marginTop: `-${props.overlap}px` }
    : { marginLeft: `-${props.overlap}px` };
}

function onAnimEnd(e: AnimationEvent): void {
  // 只处理 pop 动画结束（ftl-peng-pop / ftl-gang-pop / ftl-angang-pop）。
  // 用 `startsWith`：scoped CSS 会把 @keyframes 重命名成 `ftl-peng-pop-<hash>`，
  // 精确比较在构建产物里永远不命中（HuBanner 同款修法）。
  if (
    e.animationName.startsWith('ftl-peng-pop') ||
    e.animationName.startsWith('ftl-gang-pop') ||
    e.animationName.startsWith('ftl-angang-pop')
  ) {
    emit('pop-done');
  }
}
</script>

<template>
  <view
    class="mj-meld"
    :class="[styleClass, `mj-meld--${size}`, popAnimClass, { 'mj-meld--vertical': vertical, 'mj-meld--highlight': highlight }]"
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
      :mode="meld.kind === 'angang' ? 'aspectFill' : 'aspectFit'"
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

/** 侧家：上下竖叠（不旋转），叠压量仍由 overlap prop 通过 marginTop 控制 */
.mj-meld--vertical {
  flex-direction: column;
  align-items: flex-start;
}

/** 组内 tile 默认无负 margin；叠压量由父组件 overlap prop 精确控制 */
.mj-meld :deep(.mj-tile) {
  margin-left: 0;
  position: relative;
}
.mj-meld :deep(.mj-tile:first-child) {
  margin-left: 0;
}

/** md/lg 档位也不再硬编码负 margin */
.mj-meld--md :deep(.mj-tile),
.mj-meld--lg :deep(.mj-tile) {
  margin-left: 0;
}

/**
 * 暗杠金边（v11 §3）：`outline` 画在内容之上、**不占布局**（宽高不变）；
 * 不用 `border`（会改盒模型）、不用 `box-shadow: inset`（会被牌面图盖住）。
 */
.mj-meld--angang :deep(.mj-tile) {
  outline: $ftl-hairline solid $ftl-color-mj-gold;
  outline-offset: -$ftl-hairline;
}

/**
 * rob 来源副露高亮（v12 §2 / v13 §10.2）：整组金边向外 1px。
 * `outline` 不参与布局（不挤动牌河/副露条）；1px 写发丝线的一半 ——
 * 本仓 `ui-tokens` 闸禁止裸 `1px`（R714）。
 */
.mj-meld--highlight {
  outline: $ftl-hairline solid $ftl-color-mj-gold;
  outline-offset: calc($ftl-hairline / 2);
  border-radius: 4px;
}
</style>

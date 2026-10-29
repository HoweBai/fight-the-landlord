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
import type { MahjongMeldView, Tile } from '@fight-the-landlord/protocol';
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
    /**
     * 左/右家竖排旋转模式 — 透传给内部 MahjongTile。
     * 强制用 my/ 竖置正立素材 + DOM 宽高交换 + transform rotate。
     */
    rotate?: Rotate;
    /**
     * vertical 模式：面板窄条时，Meld 内部 3 张也改成纵向堆叠。
     * 杠盖 cap 定位跟着 vertical 调整。
     */
    vertical?: boolean;
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

/** 杠的第 4 张（叠在上方）。peng 没有。 */
const capTile = computed<Tile | undefined>(() =>
  props.meld.kind === 'peng' ? undefined : props.meld.tiles[3],
);

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
    <!-- 前 3 张（碰/杠都是 3 张并排） -->
    <MahjongTile
      v-for="(tile, i) in meld.tiles.slice(0, 3)"
      :key="`t-${i}`"
      :tile="tile"
      :direction="direction"
      :size="size"
      :rotate="rotate"
    />
    <!-- 杠的第 4 张：叠在中间那张的正上方 -->
    <MahjongTile
      v-if="capTile"
      class="mj-meld__cap"
      :tile="capTile"
      :back="meld.kind === 'angang'"
      :direction="direction"
      :size="size"
      :rotate="rotate"
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

/** 杠的第 4 张：叠在中间那张（index 1）的正上方 */
.mj-meld__cap {
  position: absolute;
  left: calc(50% - 17px); // sm tile 宽 34px 的一半
  bottom: 100%;
  z-index: 3;
  margin-left: 0 !important;
}

/** 暗杠：4 张全是牌背（视觉上叠牌效果就出来了） */
.mj-meld--angang {
  // 和 gang 共用 cap 样式，只是 capTile.back=true
}

/** 大尺寸时负 margin 跟着调 */
.mj-meld--md :deep(.mj-tile),
.mj-meld--lg :deep(.mj-tile) {
  margin-left: -22px;
}
.mj-meld--md .mj-meld__cap,
.mj-meld--lg .mj-meld__cap {
  left: calc(50% - 23px); // md tile 宽 46px 的一半（lg=60 也够用，略偏左 7px 视觉不明显）
}

/**
 * ── vertical 模式（左/右家窄条面板）───────────────────────────
 * 3 张 tile 纵向堆叠，杠盖 cap 居中叠在 Meld 上方。
 * 杠盖 cap 叠在 tile[0]（顶部第一张）上方 — 窄面板里 cap 只要"在 Meld 上面"即可。
 * ────────────────────────────────────────────────────────────────
 */
.mj-meld--vertical {
  flex-direction: column;
  align-items: center;
  gap: 0;
}
.mj-meld--vertical :deep(.mj-tile) {
  margin-left: 0;          // 清水平方向 overlap
  // 同 SeatPanel 精确公式：rotate(-90°) 视觉比 DOM 多 17px，设计 overlap 16px
  margin-top: 1px;
}
.mj-meld--vertical :deep(.mj-tile:first-child) {
  margin-top: 0;
}
.mj-meld--vertical .mj-meld__cap {
  // cap 叠在 Meld 顶部（column 里 tile[0] 在顶部）
  left: 50%;
  transform: translateX(-50%);
  top: 0; // column 从 top→bottom，cap 贴顶部 = tile[0] 上方
}
</style>

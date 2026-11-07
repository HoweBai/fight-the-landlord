<script setup lang="ts">
/**
 * 胡牌 banner（浮动 view，position: absolute; z-index: 10）。
 * 动画结束后 emit('done') 让父组件 FIFO 队列下一条。
 *
 * v13 §10.3：定位改用布局输出的画布锚点 `{ x, y }`（px），不再用画布百分比。
 *
 * Batch 2 闸纪律：
 *   - 起始态全可见（动画起始 opacity:1，闸纪律要求）
 *   - 0.8s 内 transform 缩放 → 停留 → 淡出（100% 才 opacity:0）
 *   - 零 JS 定时器（退场靠 CSS forwards + animationend 事件，不是 JS 定时器）
 */
import { computed } from 'vue';

interface HuBannerAnchor {
  x: number;
  y: number;
}

const props = withDefaults(defineProps<{
  seat: number;
  fan: number;
  /** 自摸还是点炮胡（protocol 字段名 selfDraw，不是 isZimo）。 */
  selfDraw: boolean;
  /** 画布锚点（px）；由 Board 从 `layout.bannerAnchors[slot]` 传入。 */
  anchor: HuBannerAnchor;
}>(), { fan: 0, selfDraw: false, anchor: () => ({ x: 0, y: 0 }) });

const emit = defineEmits<{ (e: 'done'): void }>();

const bannerStyle = computed(() => ({
  left: `${props.anchor.x}px`,
  top: `${props.anchor.y}px`,
}));

function onAnimEnd(e: AnimationEvent): void {
  // `startsWith`：未来若加 reduced-motion 变体（ftl-hu-banner-*）也能出队。
  if (e.animationName.startsWith('ftl-hu-banner')) emit('done');
}
</script>

<template>
  <view class="mj-hu-banner anim-hu-banner" :style="bannerStyle" @animationend="onAnimEnd">
    <text class="mj-hu-banner__text">{{ selfDraw ? '自摸' : '胡牌' }}</text>
    <text v-if="fan > 0" class="mj-hu-banner__fan">{{ fan }} 番</text>
  </view>
</template>

<style scoped lang="scss">
@import '../../../styles/animations.scss';

.mj-hu-banner {
  position: absolute;
  z-index: 10;
  transform: translate(-50%, -100%); /* 居中对齐座位上方 */
  pointer-events: none;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 12px;
  border-radius: 8px;
  /* 红金皮肤（Task 3）：金渐变 + 深字 + 金棕描边 / 阴影。 */
  background: linear-gradient(180deg, $ftl-color-mj-status, $ftl-color-mj-gold);
  box-shadow: 0 4px 16px rgba($ftl-color-mj-gold, .45);
  border: $ftl-hairline solid $ftl-color-mj-edge;
  white-space: nowrap;
}
.mj-hu-banner__text {
  color: $ftl-color-mj-ink;
  font-size: $ftl-font-md;
  font-weight: 700;
  text-shadow: 0 $ftl-hairline 2px rgba(0, 0, 0, 0.4);
}
.mj-hu-banner__fan {
  color: $ftl-color-mj-ink;
  font-size: $ftl-font-lg;
  font-weight: 800;
}
</style>

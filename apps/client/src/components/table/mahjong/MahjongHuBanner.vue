<script setup lang="ts">
/**
 * 胡牌 banner（浮动 view，position: absolute; z-index: 10）。
 * 动画结束后 emit('done') 让父组件 FIFO 队列下一条。
 *
 * Batch 2 闸纪律：
 *   - 起始态全可见（动画起始 opacity:1，闸纪律要求）
 *   - 0.8s 内 transform 缩放 → 停留 → 淡出（100% 才 opacity:0）
 *   - 零 JS 定时器（退场靠 CSS forwards + animationend 事件，不是 JS 定时器）
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  seat: number;
  fan: number;
  /** 自摸还是点炮胡（protocol 字段名 selfDraw，不是 isZimo）。 */
  selfDraw: boolean;
  /** 座位位置（百分比），由 Board.vue directionOf 算出。 */
  leftPct: number;
  topPct: number;
}>(), { fan: 0, selfDraw: false, leftPct: 50, topPct: 50 });

const emit = defineEmits<{ (e: 'done'): void }>();

const bannerStyle = computed(() => ({
  left: `${props.leftPct}%`,
  top: `${props.topPct}%`,
}));

function onAnimEnd(e: AnimationEvent): void {
  if (e.animationName === 'ftl-hu-banner') emit('done');
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
  background: linear-gradient(180deg, rgba(255, 180, 60, 0.95), rgba(220, 100, 30, 0.9));
  box-shadow: 0 4px 16px rgba(255, 120, 0, 0.5);
  border: $ftl-hairline solid rgba(255, 220, 100, 0.6);
  white-space: nowrap;
}
.mj-hu-banner__text {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  font-weight: 700;
  text-shadow: 0 $ftl-hairline 2px rgba(0, 0, 0, 0.4);
}
.mj-hu-banner__fan {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 800;
}
</style>

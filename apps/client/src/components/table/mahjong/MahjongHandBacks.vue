<script setup lang="ts">
/**
 * 对手手牌区（哑组件）：牌背横排/竖排；已胡者用亮牌替换牌背。
 * 只渲染 props，不判规则、不取数。
 */
import { computed } from 'vue';
import type { Tile } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

type Direction = 'top' | 'left' | 'right';

const props = withDefaults(
  defineProps<{
    count: number;
    direction: Direction;
    tileW: number;
    tileH: number;
    /** 横排间距（top）。 */
    gap?: number;
    /** 竖排间距（left/right，小于 tileH 时叠压）。 */
    pitch?: number;
    /** 已胡者亮牌；非空时完全替换牌背。 */
    revealed?: { tiles: Tile[]; huTile: Tile } | null;
  }>(),
  { gap: 0, pitch: 0, revealed: null },
);

const shown = computed(() => Math.max(0, Math.min(14, Math.floor(props.count))));
const vertical = computed(() => props.direction === 'left' || props.direction === 'right');
const overlapTop = computed(() =>
  vertical.value && props.pitch > 0 ? props.pitch - props.tileH : 0,
);
</script>

<template>
  <view
    class="mj-backs"
    :class="[`mj-backs--${direction}`, { 'mj-backs--vertical': vertical }]"
    :style="{ gap: vertical ? '0px' : `${gap}px` }"
  >
    <template v-if="revealed">
      <MahjongTile
        v-for="(t, i) in revealed.tiles"
        :key="`revealed-${i}`"
        :tile="t"
        :direction="direction"
        :w="tileW"
        :h="tileH"
        :style="i > 0 && overlapTop !== 0 ? { marginTop: `${overlapTop}px` } : undefined"
        dim
      />
    </template>
    <template v-else>
      <MahjongTile
        v-for="i in shown"
        :key="`back-${i}`"
        back
        :direction="direction"
        :w="tileW"
        :h="tileH"
        :style="i > 1 && overlapTop !== 0 ? { marginTop: `${overlapTop}px` } : undefined"
      />
    </template>
  </view>
</template>

<style scoped lang="scss">
.mj-backs {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
}
.mj-backs--top {
  flex-direction: row;
  flex-wrap: nowrap;
}
.mj-backs--vertical {
  flex-direction: column;
  flex-wrap: nowrap;
  /* 列顶与同侧牌河顶对齐；14 张预算的剩余高度放在脚下 */
  justify-content: flex-start;
}
</style>

<script setup lang="ts">
/**
 * 单座牌河（哑组件）：弃牌网格 + 最新牌高亮 + 弃牌点击 + 已胡亮牌。
 * 只渲染 props；是否响应点击由父组件决定（这里只 emit）。
 *
 * 2026-10-30 第二片：副露迁出到 `MahjongMeldStrip`；网格改为左上起点对齐
 *（原来居中，行数 1→2 时整块会上移半行，旧牌「漂移」）。
 */
import { computed } from 'vue';
import { tileType, type Tile } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

type Direction = 'my' | 'top' | 'left' | 'right';

const props = withDefaults(
  defineProps<{
    discards: Tile[];
    direction: Direction;
    tileW: number;
    tileH: number;
    gap: number;
    cols: number;
    /** 行数：布局契约/测试用；实际网格由 gridAutoRows 撑开。 */
    rows: number;
    filterTileType?: number | null;
    interactive?: boolean;
    /** claim 窗口的本次待响应来源座（只做视觉高亮，不改点击）。 */
    source?: boolean;
    /** 左右家已胡：亮牌网格替换 discards。 */
    revealed?: { tiles: Tile[]; huTile: Tile } | null;
  }>(),
  { filterTileType: null, interactive: false, source: false, revealed: null },
);

const emit = defineEmits<{ (e: 'discard-click', tile: Tile): void }>();

const gridStyle = computed<Record<string, string>>(() => ({
  display: 'grid',
  gridTemplateColumns: `repeat(${props.cols}, ${props.tileW}px)`,
  gridAutoRows: `${props.tileH}px`,
  gap: `${props.gap}px`,
}));

function isFiltered(t: Tile): boolean {
  return props.filterTileType !== null && tileType(t) === props.filterTileType;
}

function onDiscardClick(t: Tile): void {
  if (!props.interactive) return;
  emit('discard-click', t);
}
</script>

<template>
  <view
    class="mj-river"
    :class="[`mj-river--${direction}`, { 'mj-river--source': source }]"
  >
    <text v-if="revealed" class="mj-river__revealed-label">已胡</text>
    <view v-if="revealed" class="mj-river__grid mj-river__revealed" :style="gridStyle">
      <MahjongTile
        v-for="(t, i) in revealed.tiles"
        :key="`revealed-${i}`"
        :tile="t"
        :direction="direction"
        :w="tileW"
        :h="tileH"
        dim
      />
    </view>
    <view v-else-if="discards.length > 0" class="mj-river__grid" :style="gridStyle">
      <MahjongTile
        v-for="(t, i) in discards"
        :key="`discard-${i}`"
        :tile="t"
        :direction="direction"
        :w="tileW"
        :h="tileH"
        :class="{
          'mj-river__tile--latest': i === discards.length - 1,
          'mj-river__tile--filtered': isFiltered(t),
          'mj-river__tile--clickable': interactive,
        }"
        @click="onDiscardClick(t)"
      />
    </view>
  </view>
</template>

<style scoped lang="scss">
.mj-river {
  box-sizing: border-box;
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  overflow: visible;
}
.mj-river--source {
  outline: $ftl-hairline solid rgba($ftl-color-gold, 0.55);
  outline-offset: -$ftl-hairline;
  border-radius: $ftl-radius-sm;
}
.mj-river__grid {
  align-content: start;
  justify-content: start;
}
.mj-river__tile--latest {
  box-shadow: 0 0 6px rgba($ftl-color-gold, 0.55);
}
.mj-river__tile--filtered {
  outline: 2px solid $ftl-color-primary;
  outline-offset: -2px;
}
.mj-river__tile--clickable {
  cursor: pointer;
}
.mj-river__revealed-label {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  padding: 0 3px;
  border-radius: 999px;
  background: rgba($ftl-color-gold, 0.85);
  color: $ftl-color-on-primary;
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
}
</style>

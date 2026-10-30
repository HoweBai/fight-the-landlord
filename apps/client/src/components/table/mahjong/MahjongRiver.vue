<script setup lang="ts">
/**
 * 单座牌河（哑组件）：弃牌网格 + 副露条 + 最新牌高亮 + 弃牌点击。
 * 只渲染 props；是否响应点击由父组件决定（这里只 emit）。
 */
import { computed } from 'vue';
import {
  tileType,
  type MahjongMeldView,
  type Tile,
} from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';
import MahjongMeld from './MahjongMeld.vue';

type Direction = 'my' | 'top' | 'left' | 'right';

const props = withDefaults(
  defineProps<{
    discards: Tile[];
    melds: Array<{ key: string; meld: MahjongMeldView; pop: boolean }>;
    direction: Direction;
    tileW: number;
    tileH: number;
    gap: number;
    cols: number;
    /** 行数：布局契约/测试用；实际网格由 gridAutoRows 撑开。 */
    rows: number;
    meldTileW: number;
    meldTileH: number;
    meldOverlap: number;
    meldPlacement: 'above' | 'below';
    meldGap: number;
    /** 副露组之间的间距；左右家 4s，对家/自己 8s。 */
    meldGroupGap?: number;
    meldHeight: number;
    filterTileType?: number | null;
    interactive?: boolean;
    /** 左右家已胡：亮牌网格替换 discards。 */
    revealed?: { tiles: Tile[]; huTile: Tile } | null;
  }>(),
  { filterTileType: null, interactive: false, revealed: null, meldGroupGap: 8 },
);

const emit = defineEmits<{
  (e: 'discard-click', tile: Tile): void;
  (e: 'meld-pop-done', key: string): void;
}>();

const MELD_LABEL: Record<MahjongMeldView['kind'], string> = {
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
};

const vertical = computed(() => props.direction === 'left' || props.direction === 'right');

const gridStyle = computed<Record<string, string>>(() => ({
  display: 'grid',
  gridTemplateColumns: `repeat(${props.cols}, ${props.tileW}px)`,
  gridAutoRows: `${props.tileH}px`,
  gap: `${props.gap}px`,
}));

const meldStripStyle = computed<Record<string, string>>(() => ({
  position: 'absolute',
  left: '0',
  width: '100%',
  height: `${props.meldHeight}px`,
  display: 'flex',
  flexDirection: vertical.value ? 'column' : 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: `${props.meldGroupGap}px`,
  [props.meldPlacement === 'above' ? 'bottom' : 'top']: `calc(100% + ${props.meldGap}px)`,
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
  <view class="mj-river" :class="`mj-river--${direction}`">
    <view v-if="melds.length > 0" class="mj-river__melds" :style="meldStripStyle">
      <view v-for="m in melds" :key="m.key" class="mj-river__meld">
        <text class="mj-river__meld-label">{{ MELD_LABEL[m.meld.kind] }}</text>
        <MahjongMeld
          :meld="m.meld"
          :direction="direction"
          :tile-w="meldTileW"
          :tile-h="meldTileH"
          :overlap="meldOverlap"
          :pop="m.pop"
          @pop-done="emit('meld-pop-done', m.key)"
        />
      </view>
    </view>
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
  align-items: center;
  justify-content: center;
  overflow: visible;
  // P1: 共享背景框 — 淡色圆角矩形框住"这一排都是 XX 家的副露 + 弃牌"
  &::before {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 8px;
    border: $ftl-hairline solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    pointer-events: none;
    z-index: -1;
  }
}
// ownRiver（自己的弃牌区）不加共享框
.mj-river--my::before { display: none; }
.mj-river__grid {
  align-content: center;
  justify-content: center;
}
.mj-river__melds {
  z-index: 1;
}
.mj-river__meld {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mj-river__meld-label {
  position: absolute;
  top: 0;
  left: 0;
  padding: 0 3px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba($ftl-color-on-primary, 0.85);
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
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
  top: -13px;
  left: 0;
  padding: 0 3px;
  border-radius: 999px;
  background: rgba($ftl-color-gold, 0.85);
  color: $ftl-color-on-primary;
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
}
</style>

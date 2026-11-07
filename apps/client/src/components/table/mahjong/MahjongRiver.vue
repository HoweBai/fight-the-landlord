<script setup lang="ts">
/**
 * 单座牌河（哑组件）：弃牌窗口网格 + `+N` 徽标 + 副露条 + claimed 来源描边 + 亮牌 + 弃牌点击。
 * 只渲染 props；是否响应点击由父组件决定（这里只 emit）。
 *
 * 坐标契约（v9/v10/v11）：布局输出的是**画布坐标**，Board 负责减去本河 `rect.left/top`；
 * 因此这里收到的 `badgeRect` / `meldRect` 一律是**河内局部坐标**，本组件不再做任何减法。
 */
import { computed } from 'vue';
import {
  tileType,
  type MahjongMeldView,
  type Tile,
} from '@fight-the-landlord/protocol';
import type { Rect } from '../../../game/mahjong-layout-v2';
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
    /**
     * @deprecated Task 8 删除。仅当 `claimSourceIndex == null` 时作为同型过滤回退，
     * 用于旧 Board（只传同型、不知道具体来源下标）。
     */
    filterTileType?: number | null;
    interactive?: boolean;
    /** 左右家已胡：亮牌网格替换 discards。 */
    revealed?: { tiles: Tile[]; huTile: Tile } | null;
    /** 窗口起点（`discards` 的绝对下标）。 */
    windowStart?: number;
    /** 窗口张数；缺省 = `discards.length`（legacy 全量）。 */
    windowCount?: number;
    /** 最新一张的窗口相对下标；缺省 = `windowCount - 1`；负数/null ⇒ 不高亮。 */
    latestIndex?: number | null;
    /** 徽标隐藏张数（>0 才渲染 `+N`）。 */
    badgeCount?: number;
    /** 徽标矩形（河内局部坐标）。 */
    badgeRect?: Rect | null;
    /** 内侧副露条矩形（河内局部坐标）；缺省走 legacy `meldPlacement/meldGap/meldHeight` 定位。 */
    meldRect?: Rect | null;
    /** 内侧 lane 宽度（`meldRect.width` 为 0 时兜底）。 */
    laneWidth?: number;
    /** claimed 来源的窗口相对下标；非空时只描边该张、且只允许点该张。 */
    claimSourceIndex?: number | null;
  }>(),
  {
    filterTileType: null,
    interactive: false,
    revealed: null,
    meldGroupGap: 8,
    windowStart: 0,
    badgeCount: 0,
    badgeRect: null,
    meldRect: null,
    laneWidth: 0,
    claimSourceIndex: null,
  },
);

const emit = defineEmits<{
  (e: 'discard-click', payload: { tile: Tile; index: number }): void;
  (e: 'meld-pop-done', key: string): void;
}>();

const MELD_LABEL: Record<MahjongMeldView['kind'], string> = {
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
};

const vertical = computed(() => props.direction === 'left' || props.direction === 'right');

const windowStart = computed(() => Math.max(0, props.windowStart));
const windowCount = computed(() => Math.max(0, props.windowCount ?? props.discards.length));

/** 只渲染窗口内的弃牌，绝不越界。 */
const windowDiscards = computed(() =>
  props.discards.slice(windowStart.value, windowStart.value + windowCount.value),
);

/** 缺省 = 窗口最后一张；显式负数/null ⇒ 不高亮。 */
const latestIndex = computed(() =>
  props.latestIndex === undefined ? windowCount.value - 1 : props.latestIndex,
);

const gridStyle = computed<Record<string, string>>(() => ({
  display: 'grid',
  gridTemplateColumns: `repeat(${props.cols}, ${props.tileW}px)`,
  gridAutoRows: `${props.tileH}px`,
  gap: `${props.gap}px`,
}));

const badgeStyle = computed<Record<string, string> | undefined>(() =>
  props.badgeRect
    ? {
        left: `${props.badgeRect.left}px`,
        top: `${props.badgeRect.top}px`,
        width: `${props.badgeRect.width}px`,
        height: `${props.badgeRect.height}px`,
      }
    : undefined,
);

const meldStripStyle = computed<Record<string, string>>(() => {
  if (props.meldRect) {
    return {
      position: 'absolute',
      left: `${props.meldRect.left}px`,
      top: `${props.meldRect.top}px`,
      width: `${props.meldRect.width || props.laneWidth}px`,
      height: `${props.meldRect.height}px`,
      display: 'flex',
      flexDirection: vertical.value ? 'column' : 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: `${props.meldGroupGap}px`,
      overflow: 'visible',
    };
  }
  return {
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
  };
});

function isLatest(i: number): boolean {
  const latest = latestIndex.value;
  return latest !== null && latest >= 0 && i === latest;
}

/**
 * claimed 来源描边：`claimSourceIndex` 非空时**只**描边该窗口下标（同型其他张不描边）；
 * 否则回退到 legacy `filterTileType` 同型过滤。
 */
function isFiltered(i: number, t: Tile): boolean {
  if (props.claimSourceIndex != null) return i === props.claimSourceIndex;
  return props.filterTileType !== null && tileType(t) === props.filterTileType;
}

function onDiscardClick(t: Tile, index: number): void {
  if (!props.interactive) return;
  if (props.claimSourceIndex != null && index !== props.claimSourceIndex) return;
  emit('discard-click', { tile: t, index });
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
          :vertical="vertical"
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
    <template v-else>
      <view v-if="windowDiscards.length > 0" class="mj-river__grid" :style="gridStyle">
        <MahjongTile
          v-for="(t, i) in windowDiscards"
          :key="`discard-${windowStart + i}`"
          :tile="t"
          :direction="direction"
          :w="tileW"
          :h="tileH"
          :class="{
            'mj-river__tile--latest': isLatest(i),
            'mj-river__tile--filtered': isFiltered(i, t),
            'mj-river__tile--clickable': interactive,
          }"
          @click="onDiscardClick(t, i)"
        />
      </view>
      <text
        v-if="badgeCount > 0 && badgeRect"
        class="mj-river__badge"
        :style="badgeStyle"
      >+{{ badgeCount }}</text>
    </template>
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
}
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
.mj-river__badge {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba($ftl-color-gold, 0.95);
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
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

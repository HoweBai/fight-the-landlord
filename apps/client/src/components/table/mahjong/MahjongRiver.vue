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
    /**
     * 亮牌翻转帧序号（2026-11-08 红金皮肤 Task 3）：Board 在**新 reveal**（新座位亮牌）时自增。
     * 0 / 缺省 ⇒ 该次亮牌是挂载 seed（重连/中途进房），不播翻转。
     */
    revealNonce?: number;
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
    revealNonce: 0,
    claimSourceIndex: null,
  },
);

const emit = defineEmits<{
  (e: 'discard-click', payload: { tile: Tile; index: number }): void;
  (e: 'meld-pop-done', key: string): void;
}>();

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

/**
 * `+N` 徽标（2026-11-08 红金皮肤）：内容尺寸药丸，钉在 `badgeRect` **中心**。
 * 不再把 width/height 设成整格 —— mockup 的 `+N` 是浮在格子中心的小金块，
 * 铺满整格会让它看起来像一张牌。
 */
const badgeStyle = computed<Record<string, string> | undefined>(() =>
  props.badgeRect
    ? {
        left: `${props.badgeRect.left + props.badgeRect.width / 2}px`,
        top: `${props.badgeRect.top + props.badgeRect.height / 2}px`,
        transform: 'translate(-50%, -50%)',
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
        :key="`revealed-${revealNonce}-${i}`"
        :tile="t"
        :direction="direction"
        :w="tileW"
        :h="tileH"
        :class="{ 'anim-reveal-in': revealNonce > 0 }"
        :style="{ '--ftl-delay': `${i * 40}ms` }"
        dim
      />
    </view>
    <template v-else>
      <view
        v-if="windowDiscards.length > 0"
        class="mj-river__grid"
        :class="{ 'mj-river__grid--badged': badgeCount > 0 }"
        :style="gridStyle"
      >
        <MahjongTile
          v-for="(t, i) in windowDiscards"
          :key="`discard-${windowStart + i}`"
          :tile="t"
          :direction="direction"
          :w="tileW"
          :h="tileH"
          :class="{
            'mj-river__tile--latest': isLatest(i),
            'anim-discard-land': isLatest(i),
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
// Task 10：最新弃牌落桌动画。scoped CSS 按组件重命名 @keyframes ⇒ 必须导入动画类文件
//（同 MahjongMeld / MahjongHandBacks 的纪律；不能 @use，见 animations.scss 顶部注释）。
@import '../../../styles/animations.scss';

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
// v13 §10.4：徽标与网格不得一顶一居中混用。布局的 `badgeRect` 按**容量行数顶对齐**推算，
// 而有徽标时网格只铺已用行（少于容量）—— 居中会把网格整体下移，+N 就压到最后一行牌上。
// 因此有徽标时网格改为顶对齐，与徽标的顶对齐数学同口径。
.mj-river__grid--badged {
  align-self: flex-start;
  align-content: start;
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
/* 最新弃牌（红金皮肤）：发丝线高亮描边 + 金色光晕（旧 box-shadow 会被牌图遮住一半）。 */
.mj-river__tile--latest {
  outline: $ftl-hairline solid $ftl-color-mj-highlight;
  outline-offset: 0;
  filter: drop-shadow(0 0 6px rgba($ftl-color-mj-highlight, .8));
}
/* claimed 来源描边（红金皮肤）：不再用主色蓝，改红金着色。 */
.mj-river__tile--filtered {
  outline: $ftl-hairline solid $ftl-color-mj-gold;
  outline-offset: 0;
}
.mj-river__tile--clickable {
  cursor: pointer;
}
/* `+N` 徽标（红金皮肤）：内容尺寸金底药丸，中心由内联 left/top + translate 定位。 */
.mj-river__badge {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 4px;
  border-radius: 6px;
  background: $ftl-color-mj-gold;
  color: $ftl-color-mj-ink;
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  pointer-events: none;
}
/* 已胡标签（红金皮肤）：移到河内底部，金底深字。 */
.mj-river__revealed-label {
  position: absolute;
  bottom: 0;
  top: auto;
  left: 0;
  padding: 0 3px;
  border-radius: 6px;
  background: $ftl-color-mj-gold;
  color: $ftl-color-mj-ink;
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
}
</style>

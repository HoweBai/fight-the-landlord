<script setup lang="ts">
/**
 * 中央井（哑组件）：天月风蓝金圆盘。
 *
 * 圆盘中心：`ended` → 终；`active && seconds > 0` → 秒数；否则牌墙数。
 * 右侧列：可响应牌 / 听牌（最多 12 张，超出 +N）/ endedText 次要行。
 * 紧凑模式（布局给 `compact`）：90 圆盘 + 单行文字，不出牌面。
 */
import { computed } from 'vue';
import { MAHJONG_SUIT_NAMES, type Tile } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

/** 右列最多展示的听牌张数；超出的用 +N 收敛。 */
const MAX_TING_TILES = 12;
/** 有可响应牌时听牌只出一行（9 张），给 claim 牌面留高度。 */
const MAX_TING_TILES_WITH_CLAIM = 9;

const props = withDefaults(
  defineProps<{
    wallCount: number;
    phaseText: string;
    claimTile?: Tile | null;
    claimW?: number;
    claimH?: number;
    tingTiles?: readonly Tile[];
    tingW?: number;
    tingH?: number;
    maxFan?: number | null;
    seconds: number;
    active?: boolean;
    compact?: boolean;
    ended?: boolean;
    endedText?: string;
  }>(),
  {
    claimTile: null,
    claimW: 34,
    claimH: 45,
    tingTiles: () => [],
    tingW: 20,
    tingH: 27,
    maxFan: null,
    active: false,
    compact: false,
    ended: false,
    endedText: '',
  },
);

const urgent = computed(
  () => props.active && props.seconds > 0 && props.seconds <= 5,
);
const dialValue = computed(() => {
  if (props.ended) return '终';
  if (props.active && props.seconds > 0) return String(props.seconds);
  return String(props.wallCount);
});
const dialUnit = computed(() => {
  if (props.ended) return '';
  return props.active && props.seconds > 0 ? 's' : '张';
});
const claimLabel = computed(() =>
  props.claimTile
    ? `${MAHJONG_SUIT_NAMES[props.claimTile.s]}${props.claimTile.r}`
    : '',
);
const tingCap = computed(() => (props.claimTile ? MAX_TING_TILES_WITH_CLAIM : MAX_TING_TILES));
const visibleTing = computed(() => props.tingTiles.slice(0, tingCap.value));
const extraTing = computed(() => Math.max(0, props.tingTiles.length - tingCap.value));
/** 右列没有内容时隐藏，圆盘在卡片内居中（天月式中心盘）。 */
const hasSide = computed(
  () => Boolean(props.claimTile) || visibleTing.value.length > 0 || Boolean(props.endedText),
);
</script>

<template>
  <view class="mj-center" :class="{ 'mj-center--compact': compact }">
    <view class="mj-center__strip">
      <text class="mj-center__wall">牌墙 {{ wallCount }}</text>
      <text class="mj-center__sep">·</text>
      <text class="mj-center__phase">{{ phaseText }}</text>
      <template v-if="compact && active && seconds > 0">
        <text class="mj-center__sep">·</text>
        <text class="mj-center__compact-clock">{{ seconds }}s</text>
      </template>
    </view>

    <view class="mj-center__body">
      <view
        class="mj-center__dial"
        :class="{ 'mj-center__dial--urgent': urgent, 'anim-urgent-pulse': urgent }"
      >
        <text class="mj-center__value">{{ dialValue }}</text>
        <text v-if="dialUnit" class="mj-center__unit">{{ dialUnit }}</text>
      </view>

      <view v-if="hasSide" class="mj-center__side">
        <template v-if="!compact">
          <view v-if="claimTile" class="mj-center__claim">
            <text class="mj-center__label">可响应</text>
            <MahjongTile :tile="claimTile" :w="claimW" :h="claimH" direction="my" />
          </view>
          <view v-if="visibleTing.length > 0" class="mj-center__ting">
            <text class="mj-center__label">
              听<template v-if="maxFan !== null">（{{ maxFan }} 番）</template>
            </text>
            <MahjongTile
              v-for="(t, i) in visibleTing"
              :key="`ting-${i}`"
              :tile="t"
              :w="tingW"
              :h="tingH"
              direction="my"
            />
            <text v-if="extraTing > 0" class="mj-center__extra">+{{ extraTing }}</text>
          </view>
        </template>
        <text v-else-if="claimTile" class="mj-center__compact-claim">
          可响应 {{ claimLabel }}
        </text>
        <text v-if="endedText" class="mj-center__ended">{{ endedText }}</text>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
@import '../../../styles/animations.scss';

.mj-center {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 4px 8px;
  overflow: hidden;
  border: $ftl-hairline solid rgba($ftl-color-mj-gold, 0.55);
  border-radius: $ftl-radius-lg;
  background:
    linear-gradient(180deg, rgba($ftl-color-mj-navy-light, 0.92), rgba($ftl-color-mj-navy, 0.94));
  box-shadow:
    inset 0 0 0 $ftl-hairline rgba($ftl-color-mj-gold, 0.22),
    0 6px 18px rgba($ftl-color-mj-navy, 0.45);
  color: $ftl-color-mj-muted;
  text-align: center;
}

.mj-center__strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  min-width: 0;
  white-space: nowrap;
}
.mj-center__wall {
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-xs;
  font-weight: 700;
}
.mj-center__sep {
  color: rgba($ftl-color-mj-muted, 0.6);
  font-size: $ftl-font-xs;
}
.mj-center__phase {
  overflow: hidden;
  min-width: 0;
  color: $ftl-color-mj-muted;
  font-size: $ftl-font-xs;
  text-overflow: ellipsis;
}

.mj-center__body {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 0;
}

/* 110 圆盘：内圈实底 + 12 刻度（repeating-conic）+ 外圈渐变 */
.mj-center__dial {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 110px;
  height: 110px;
  border: $ftl-hairline solid $ftl-color-mj-gold;
  border-radius: 50%;
  background:
    radial-gradient(circle, $ftl-color-mj-navy 0 52%, transparent 52%),
    repeating-conic-gradient(
      from 0deg,
      rgba($ftl-color-mj-gold, 0.5) 0deg 1.5deg,
      transparent 1.5deg 30deg
    ),
    radial-gradient(circle, $ftl-color-mj-navy-light 0%, $ftl-color-mj-navy 100%);
  box-shadow:
    inset 0 0 12px rgba($ftl-color-mj-gold, 0.2),
    0 0 10px rgba($ftl-color-mj-navy, 0.5);
}
.mj-center__dial--urgent {
  border-color: $ftl-color-mj-urgent;
  box-shadow:
    inset 0 0 12px rgba($ftl-color-mj-urgent, 0.35),
    0 0 14px rgba($ftl-color-mj-urgent, 0.45);
}
.mj-center__dial--urgent .mj-center__value,
.mj-center__dial--urgent .mj-center__unit {
  color: $ftl-color-mj-urgent;
}
.mj-center__value {
  color: $ftl-color-mj-gold;
  font-size: 40px;
  font-weight: 800;
  line-height: 1;
  text-shadow: 0 2px 6px rgba($ftl-color-mj-navy, 0.8);
}
.mj-center__unit {
  margin-top: 2px;
  color: $ftl-color-mj-muted;
  font-size: $ftl-font-xs;
  line-height: 1;
}

.mj-center__side {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  max-width: 210px;
  overflow: hidden;
}
.mj-center__claim,
.mj-center__ting {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 3px;
  max-width: 100%;
}
.mj-center__label {
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-xs;
  white-space: nowrap;
}
.mj-center__extra {
  color: $ftl-color-mj-cyan;
  font-size: $ftl-font-xs;
  font-weight: 700;
}
.mj-center__ended {
  overflow: hidden;
  max-width: 100%;
  color: $ftl-color-mj-muted;
  font-size: $ftl-font-xs;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-center__compact-claim {
  overflow: hidden;
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-xs;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* —— 紧凑：竖排，90 圆盘 + 单行文字（设计最小画布下一般不会触发） —— */
.mj-center--compact {
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  padding: 0 6px;
  white-space: nowrap;
}
.mj-center--compact .mj-center__strip {
  height: 28px;
  flex: 0 0 auto;
  gap: 4px;
}
.mj-center--compact .mj-center__strip,
.mj-center--compact .mj-center__phase,
.mj-center--compact .mj-center__wall,
.mj-center--compact .mj-center__compact-clock {
  font-size: $ftl-font-xs;
  line-height: 1.2;
}
.mj-center--compact .mj-center__body {
  flex: 1 1 auto;
  gap: 6px;
}
.mj-center--compact .mj-center__dial {
  width: 90px;
  height: 90px;
}
.mj-center--compact .mj-center__value {
  font-size: $ftl-font-lg;
}
.mj-center--compact .mj-center__side {
  flex: 0 0 auto;
  max-width: none;
}
</style>

<script setup lang="ts">
/**
 * 中央井（哑组件）：天月风炭黑盘。
 *
 * 上缘牌墙/阶段；中央 80 圆盘倒计时；左右两列四家**杠分/临时分投影**
 * （不是完整局分/钱包余额）；下缘听牌（最多 8 张 + 总数）。
 * 可响应牌在 ClaimTile 面板，不在这里。
 */
import { computed } from 'vue';
import type { Tile } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

const MAX_TING_TILES = 8;

const props = withDefaults(
  defineProps<{
    wallCount: number;
    phaseText: string;
    seats?: Array<{ label: string; score: number; dealer: boolean; badge: string }>;
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
    seats: () => [],
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
const hasSeats = computed(() => props.seats.length > 0);
const visibleTing = computed(() => props.tingTiles.slice(0, MAX_TING_TILES));

function scoreText(n: number): string {
  if (Math.abs(n) >= 100_000) return `${(n / 10000).toFixed(1)}万`;
  return n > 0 ? `+${n}` : String(n);
}

function badgeClass(badge: string): string {
  if (badge === '胡') return 'mj-center__badge--hu';
  if (badge === '听') return 'mj-center__badge--ting';
  return 'mj-center__badge--muted';
}
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
      <view v-if="hasSeats && !compact" class="mj-center__col">
        <view v-for="s in seats.slice(0, 2)" :key="`l-${s.label}`" class="mj-center__cell">
          <view class="mj-center__line">
            <text class="mj-center__prefix">{{ s.label }}</text>
            <text class="mj-center__score">{{ scoreText(s.score) }}</text>
          </view>
          <view class="mj-center__badge-line">
            <text v-if="s.dealer" class="mj-center__dealer">庄</text>
            <text v-if="s.dealer && s.badge" class="mj-center__dot">·</text>
            <text v-if="s.badge" class="mj-center__badge" :class="badgeClass(s.badge)">{{ s.badge }}</text>
          </view>
        </view>
      </view>

      <view
        class="mj-center__dial"
        :class="{ 'mj-center__dial--urgent': urgent, 'anim-urgent-pulse': urgent }"
      >
        <text class="mj-center__value">{{ dialValue }}</text>
        <text v-if="dialUnit" class="mj-center__unit">{{ dialUnit }}</text>
      </view>

      <view v-if="hasSeats && !compact" class="mj-center__col">
        <view v-for="s in seats.slice(2, 4)" :key="`r-${s.label}`" class="mj-center__cell">
          <view class="mj-center__line">
            <text class="mj-center__prefix">{{ s.label }}</text>
            <text class="mj-center__score">{{ scoreText(s.score) }}</text>
          </view>
          <view class="mj-center__badge-line">
            <text v-if="s.dealer" class="mj-center__dealer">庄</text>
            <text v-if="s.dealer && s.badge" class="mj-center__dot">·</text>
            <text v-if="s.badge" class="mj-center__badge" :class="badgeClass(s.badge)">{{ s.badge }}</text>
          </view>
        </view>
      </view>
    </view>

    <view v-if="!compact && !ended && tingTiles.length > 0" class="mj-center__ting">
      <text class="mj-center__ting-label">听 {{ tingTiles.length }} 张</text>
      <MahjongTile
        v-for="(t, i) in visibleTing"
        :key="`ting-${i}`"
        :tile="t"
        :w="tingW"
        :h="tingH"
        direction="my"
      />
      <text v-if="maxFan !== null" class="mj-center__fan">{{ maxFan }}番</text>
    </view>
    <view v-else-if="!compact && ended && endedText" class="mj-center__ended">
      {{ endedText }}
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
  width: 100%;
  height: 100%;
  padding: 4px 8px;
  overflow: hidden;
  border-radius: $ftl-radius-lg;
  background: linear-gradient(180deg, $ftl-color-mj-panel-light, $ftl-color-mj-panel);
  box-shadow:
    inset 0 0 0 $ftl-hairline $ftl-color-mj-gold,
    0 6px 18px rgba($ftl-color-mj-panel, 0.45);
  color: $ftl-color-mj-muted;
  text-align: center;
}

.mj-center__strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  min-width: 0;
  white-space: nowrap;
}
.mj-center__wall {
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-xs;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}
.mj-center__sep {
  color: rgba($ftl-color-mj-muted, 0.6);
  font-size: $ftl-font-xs;
  line-height: 1;
}
.mj-center__phase {
  overflow: hidden;
  min-width: 0;
  color: $ftl-color-mj-muted;
  font-size: $ftl-font-xs;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mj-center__body {
  display: flex;
  flex: 0 0 80px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 80px;
  min-height: 0;
}
.mj-center__col {
  display: flex;
  flex: 0 0 100px;
  flex-direction: column;
  justify-content: center;
  width: 100px;
  height: 80px;
  gap: 0;
  min-width: 0;
}
.mj-center__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 40px;
  padding: 0;
  gap: 0;
  line-height: 1;
  min-width: 0;
}
.mj-center__line {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 3px;
  height: 22px;
}
.mj-center__prefix {
  color: $ftl-color-mj-muted;
  font-size: $ftl-font-mj-mini;
  line-height: 1;
}
.mj-center__score {
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-xs;
  font-weight: 700;
  line-height: 1;
}
.mj-center__badge-line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 18px;
}
.mj-center__dealer {
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-mj-badge;
  font-weight: 700;
  line-height: 1;
}
.mj-center__dot {
  color: $ftl-color-mj-muted;
  font-size: $ftl-font-mj-badge;
  line-height: 1;
}
.mj-center__badge {
  padding: 0 3px;
  border-radius: 999px;
  font-size: $ftl-font-mj-badge;
  line-height: 1;
  white-space: nowrap;
}
.mj-center__badge--hu {
  background: $ftl-color-mj-gold;
  color: $ftl-color-mj-on-gold;
}
.mj-center__badge--ting {
  background: $ftl-color-mj-cyan;
  color: $ftl-color-mj-on-gold;
}
.mj-center__badge--muted {
  background: rgba($ftl-color-mj-navy, 0.85);
  color: $ftl-color-mj-muted;
}

.mj-center__dial {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 80px;
  height: 80px;
  border: $ftl-hairline solid $ftl-color-mj-gold;
  border-radius: 50%;
  background:
    radial-gradient(circle, $ftl-color-mj-panel 0 52%, transparent 52%),
    repeating-conic-gradient(
      from 0deg,
      rgba($ftl-color-mj-gold, 0.5) 0deg 1.5deg,
      transparent 1.5deg 30deg
    ),
    radial-gradient(circle, $ftl-color-mj-panel-light 0%, $ftl-color-mj-panel 100%);
  box-shadow:
    inset 0 0 10px rgba($ftl-color-mj-gold, 0.2),
    0 0 8px rgba($ftl-color-mj-panel, 0.5);
}
.mj-center__dial--urgent {
  border-color: $ftl-color-mj-urgent;
  box-shadow:
    inset 0 0 10px rgba($ftl-color-mj-urgent, 0.35),
    0 0 12px rgba($ftl-color-mj-urgent, 0.45);
}
.mj-center__dial--urgent .mj-center__value,
.mj-center__dial--urgent .mj-center__unit {
  color: $ftl-color-mj-urgent;
}
.mj-center__value {
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-xl;
  font-weight: 800;
  line-height: 1;
  text-shadow: 0 2px 6px rgba($ftl-color-mj-panel, 0.8);
}
.mj-center__unit {
  color: $ftl-color-mj-muted;
  font-size: $ftl-font-mj-mini;
  line-height: 1;
}

.mj-center__ting {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 27px;
  overflow: hidden;
  white-space: nowrap;
}
.mj-center__ting-label {
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-xs;
  line-height: 1;
  white-space: nowrap;
}
.mj-center__fan {
  padding: 0 3px;
  border-radius: 999px;
  background: rgba($ftl-color-mj-gold, 0.2);
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-mj-mini;
  line-height: 1;
}
.mj-center__ended {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  height: 27px;
  color: $ftl-color-mj-muted;
  font-size: $ftl-font-xs;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* —— 紧凑：小画布防御，隐藏四家/听牌 —— */
.mj-center--compact {
  gap: 2px;
  padding: 0 6px;
  white-space: nowrap;
}
.mj-center--compact .mj-center__strip {
  height: 28px;
  flex: 0 0 28px;
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
  flex: 0 0 90px;
  height: 90px;
}
.mj-center--compact .mj-center__dial {
  width: 90px;
  height: 90px;
}
.mj-center--compact .mj-center__value {
  font-size: $ftl-font-lg;
}
</style>

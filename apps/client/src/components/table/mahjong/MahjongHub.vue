<script setup lang="ts">
/**
 * 血战盘（哑组件）：牌墙 / 倒计时 / 听 N / 状态行 / 四向方位点 / 四家徽标。
 *
 * 只渲染 props，不判规则、不取数、不造计时器：
 *  - 不含分数；没有中央 claim 牌（rob 的待响应牌由 ActionBar 显示）。
 *  - 方位点亮规则：play/claim/rob 亮 currentPlayer；exchange/lack 亮 activeSeats；
 *    其余（draw/ended）不亮；没有映射座位的方向永不点亮。
 *  - 徽标每座最多一个，由 Board 按 胡 > 听 > 缺 > 托管 求好紧急度后传入。
 *  - 金环 / 方位点 / 徽标都只是盘缘装饰。
 * 动效（紧迫脉冲）不在此处，由 Task 10 的动画层负责。
 */
import { computed } from 'vue';
import type { MahjongPhase } from '@fight-the-landlord/protocol';

type HubDir = 'top' | 'left' | 'right' | 'self';
type HubBadge = 'hu' | 'ting' | 'lack' | 'trustee';

interface HubRect {
  left: number;
  top: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
  r: number;
  compact?: boolean;
}

interface HubSeat {
  seat: number;
  dir: HubDir;
  badge?: HubBadge | null;
  badgeText?: string;
}

const props = withDefaults(
  defineProps<{
    hub: HubRect;
    wallCount: number;
    seconds: number;
    phase: MahjongPhase;
    currentPlayer: number;
    activeSeats: number[];
    seats: HubSeat[];
    tingCount?: number;
    compact?: boolean;
    statusText?: string;
    endedText?: string;
  }>(),
  {
    tingCount: 0,
    statusText: '',
    endedText: '',
  },
);

const DIRS: readonly HubDir[] = ['top', 'left', 'right', 'self'];

const compact = computed(() => props.compact ?? props.hub.compact ?? false);
const urgent = computed(() => props.seconds > 0 && props.seconds <= 5);

/** 字号按 normal/compact 两档；内联写进模板，jsdom 也能读到。 */
const fonts = computed(() =>
  compact.value
    ? { wall: 32, wallLabel: 16, clock: 18, status: 12, ting: 12, badge: 14, dot: 8 }
    : { wall: 40, wallLabel: 16, clock: 22, status: 14, ting: 14, badge: 16, dot: 10 },
);

const statusShown = computed(() => {
  const chars = Array.from(props.endedText || props.statusText || '');
  const max = compact.value ? 8 : 10;
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
});

function seatOf(dir: HubDir): number | undefined {
  return props.seats.find((s) => s.dir === dir)?.seat;
}

const dots = computed(() =>
  DIRS.map((dir) => {
    const seat = seatOf(dir);
    let lit = false;
    if (seat !== undefined) {
      if (props.phase === 'play' || props.phase === 'claim' || props.phase === 'rob') {
        lit = seat === props.currentPlayer;
      } else if (props.phase === 'exchange' || props.phase === 'lack') {
        lit = props.activeSeats.includes(seat);
      }
    }
    return { dir, lit };
  }),
);

const badges = computed(() =>
  props.seats.filter(
    (s): s is HubSeat & { badge: HubBadge; badgeText: string } =>
      Boolean(s.badge && s.badgeText),
  ),
);

const ringStyle = {
  position: 'absolute',
  top: '3px',
  right: '3px',
  bottom: '3px',
  left: '3px',
  border: '2px solid #D4A24C',
  borderRadius: '50%',
  pointerEvents: 'none',
} as const;
</script>

<template>
  <view class="mj-hub" :class="{ 'mj-hub--compact': compact }">
    <view class="mj-hub__ring" :style="ringStyle" />
    <view class="mj-hub__body">
      <view class="mj-hub__wall" :style="{ fontSize: `${fonts.wall}px` }">
        <text
          v-if="!compact"
          class="mj-hub__wall-label"
          :style="{ fontSize: `${fonts.wallLabel}px` }"
        >牌墙</text>
        <text class="mj-hub__wall-count" :style="{ fontSize: `${fonts.wall}px` }">
          {{ wallCount }}
        </text>
      </view>
      <text
        class="mj-hub__clock"
        :class="{ 'mj-hub__clock--urgent': urgent }"
        :style="{ fontSize: `${fonts.clock}px` }"
      >{{ seconds }}s</text>
      <text
        v-if="tingCount > 0"
        class="mj-hub__ting"
        :style="{ fontSize: `${fonts.ting}px` }"
      >听 {{ tingCount }} 张</text>
    </view>
    <text
      v-if="statusShown"
      class="mj-hub__status"
      :style="{ fontSize: `${fonts.status}px` }"
    >{{ statusShown }}</text>
    <view
      v-for="dot in dots"
      :key="dot.dir"
      class="mj-hub__dot"
      :class="[`mj-hub__dot--${dot.dir}`, { 'mj-hub__dot--lit': dot.lit }]"
      :style="{ fontSize: `${fonts.dot}px` }"
    />
    <text
      v-for="badge in badges"
      :key="badge.dir"
      class="mj-hub__badge"
      :class="[`mj-hub__badge--${badge.dir}`, `mj-hub__badge--${badge.badge}`]"
      :style="{ fontSize: `${fonts.badge}px` }"
    >{{ badge.badgeText }}</text>
  </view>
</template>

<style scoped lang="scss">
/* 川麻红金调色（设计 v4 §8）：金 #D4A24C / 漆 #1C0808 / cream #F5E6C8 / urgent #FF6B5A。 */
.mj-hub {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 50%;
  background: rgba(28, 8, 8, 0.55);
  color: rgb(245, 230, 200);
  text-align: center;
}
.mj-hub__ring {
  /* 关键几何已内联；此处保持同样的兜底值。 */
  position: absolute;
  top: 3px;
  right: 3px;
  bottom: 3px;
  left: 3px;
  border: $ftl-hairline solid rgb(212, 162, 76);
  border-radius: 50%;
  pointer-events: none;
}
.mj-hub__body {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 84%;
  transform: translate(-50%, -58%);
  white-space: nowrap;
}
.mj-hub__wall {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.05;
}
.mj-hub__wall-label {
  color: rgb(201, 169, 160);
  line-height: 1.1;
}
.mj-hub__wall-count {
  color: rgb(212, 162, 76);
  font-weight: 700;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
}
.mj-hub__clock {
  color: rgb(245, 230, 200);
  font-weight: 600;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.mj-hub__clock--urgent {
  color: rgb(255, 107, 90);
}
.mj-hub__ting {
  color: rgb(212, 162, 76);
  line-height: 1.1;
  white-space: nowrap;
}
.mj-hub__status {
  position: absolute;
  top: 50%;
  left: 50%;
  overflow: hidden;
  max-width: 88%;
  color: rgb(201, 169, 160);
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translate(-50%, 55px);
}
.mj-hub--compact .mj-hub__status {
  transform: translate(-50%, 50px);
}
.mj-hub__dot {
  position: absolute;
  box-sizing: border-box;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(245, 230, 200, 0.22);
}
.mj-hub--compact .mj-hub__dot {
  width: 8px;
  height: 8px;
}
.mj-hub__dot--top {
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
}
.mj-hub__dot--left {
  top: 50%;
  left: 6px;
  transform: translateY(-50%);
}
.mj-hub__dot--right {
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
}
.mj-hub__dot--self {
  bottom: 6px;
  left: 50%;
  transform: translateX(-50%);
}
.mj-hub__dot--lit {
  background: rgb(212, 162, 76);
  box-shadow: 0 0 6px rgba(212, 162, 76, 0.9);
}
.mj-hub__badge {
  position: absolute;
  padding: 0 4px;
  border: $ftl-hairline solid rgba(212, 162, 76, 0.55);
  border-radius: 999px;
  background: rgba(28, 8, 8, 0.86);
  color: rgb(245, 230, 200);
  line-height: 1.15;
  white-space: nowrap;
}
.mj-hub__badge--top {
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
}
.mj-hub__badge--left {
  top: 50%;
  left: 16px;
  transform: translateY(-50%);
}
.mj-hub__badge--right {
  top: 50%;
  right: 16px;
  transform: translateY(-50%);
}
.mj-hub__badge--self {
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
}
.mj-hub--compact .mj-hub__badge--top {
  top: 12px;
}
.mj-hub--compact .mj-hub__badge--left {
  left: 12px;
}
.mj-hub--compact .mj-hub__badge--right {
  right: 12px;
}
.mj-hub--compact .mj-hub__badge--self {
  bottom: 12px;
}
.mj-hub__badge--hu {
  border-color: rgb(212, 162, 76);
  background: rgba(212, 162, 76, 0.9);
  color: rgb(43, 22, 8);
}
.mj-hub__badge--ting {
  border-color: rgba(74, 222, 128, 0.8);
  background: rgba(74, 222, 128, 0.85);
  color: rgb(43, 22, 8);
}
.mj-hub__badge--lack {
  border-color: rgba(120, 170, 255, 0.8);
  background: rgba(120, 170, 255, 0.85);
  color: rgb(28, 8, 8);
}
.mj-hub__badge--trustee {
  border-color: rgba(201, 169, 160, 0.6);
  background: rgba(43, 12, 12, 0.9);
  color: rgb(201, 169, 160);
}
</style>

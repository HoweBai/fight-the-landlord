<script setup lang="ts">
/**
 * 血战盘（哑组件）：牌墙 / 倒计时 / 状态行 / 四向方位点 / 四家徽标 / 胡牌金光。
 *
 * 只渲染 props，不判规则、不取数、不造计时器：
 *  - 不含分数；没有中央 claim 牌（rob 的待响应牌由 ActionBar 显示）。
 *  - 方位点亮规则：play/claim/rob 亮 currentPlayer；exchange/lack 亮 activeSeats；
 *    其余（draw/ended）不亮；没有映射座位的方向永不点亮。
 *  - 徽标每座最多一个，由 Board 按 胡 > 听 > 缺 > 托管 求好紧急度后传入。
 *  - 方位点 / 徽标都只是盘缘装饰。
 *  - 紧迫动效：仅在**我方出牌**且末 5 秒给钟挂 `anim-mj-urgent`（有限 3 次，定义在 animations.scss）。
 *  - 胡牌金光（Task 2）：`flashKey > 0` 时挂一次性覆盖层；animationend 后 emit `flash-done`。
 *  - 听 N 已移出盘（Task 2 起由牌桌在听牌行上方渲染行标签）。
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
    compact?: boolean;
    statusText?: string;
    endedText?: string;
    flashKey?: number;
  }>(),
  {
    statusText: '',
    endedText: '',
    flashKey: 0,
  },
);

const emit = defineEmits<{
  (e: 'flash-done'): void;
}>();

const DIRS: readonly HubDir[] = ['top', 'left', 'right', 'self'];

const compact = computed(() => props.compact ?? props.hub.compact ?? false);

function seatOf(dir: HubDir): number | undefined {
  return props.seats.find((s) => s.dir === dir)?.seat;
}

/** 紧迫：只有我方出牌回合的末 5 秒（没有 self 座位 ⇒ 永 false）。 */
const urgent = computed(() => {
  const selfSeat = seatOf('self');
  return (
    props.phase === 'play' &&
    selfSeat !== undefined &&
    props.currentPlayer === selfSeat &&
    props.seconds > 0 &&
    props.seconds <= 5
  );
});

/** 字号按 normal/compact 两档；内联写进模板，jsdom 也能读到。 */
const fonts = computed(() =>
  compact.value
    ? { wall: 40, wallLabel: 14, clock: 18, status: 12, badge: 12, dot: 8 }
    : { wall: 48, wallLabel: 14, clock: 22, status: 14, badge: 12, dot: 10 },
);

const statusShown = computed(() => {
  const chars = Array.from(props.endedText || props.statusText || '');
  const max = compact.value ? 8 : 10;
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
});

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

/**
 * 金光播完才清键。scoped 构建会把 @keyframes 重命名（`ftl-mj-hub-flash-<hash>`）
 * ⇒ 只判前缀，不判全等。
 */
function onFlashEnd(e: AnimationEvent): void {
  if (e.animationName.startsWith('ftl-mj-hub-flash')) emit('flash-done');
}
</script>

<template>
  <view class="mj-hub" :class="{ 'mj-hub--compact': compact }">
    <text class="mj-hub__wall-count" :style="{ fontSize: `${fonts.wall}px` }">
      {{ wallCount }}
    </text>
    <text class="mj-hub__wall-label" :style="{ fontSize: `${fonts.wallLabel}px` }">牌墙</text>
    <text
      class="mj-hub__clock"
      :class="{ 'mj-hub__clock--urgent': urgent, 'anim-mj-urgent': urgent }"
      :style="{ fontSize: `${fonts.clock}px` }"
    >{{ seconds }}s</text>
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
    <view
      v-if="flashKey > 0"
      :key="flashKey"
      class="mj-hub__flash anim-mj-hub-flash"
      @animationend="onFlashEnd"
    />
  </view>
</template>

<style scoped lang="scss">
// `anim-mj-urgent` / `anim-mj-hub-flash` 的类与 keyframes 都在 animations.scss（scoped 会重命名 @keyframes ⇒ 必须导入）。
@import '../../../styles/animations.scss';

/* 川麻红金调色（设计 v4 §8）：token 定义在 src/uni.scss 的 $ftl-color-mj-* 一档。 */
.mj-hub {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: 6px solid $ftl-color-mj-gold;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 42%, $ftl-color-mj-hub-core 0%, $ftl-color-mj-lacquer 70%);
  box-shadow: 0 0 0 $ftl-hairline $ftl-color-mj-border, 0 0 28px rgba($ftl-color-mj-gold, .25), inset 0 0 24px rgba(0, 0, 0, .6);
  color: $ftl-color-mj-cream;
  text-align: center;
}
.mj-hub__wall-count {
  position: absolute;
  top: 14%;
  right: 0;
  left: 0;
  color: $ftl-color-mj-sheen;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.mj-hub--compact .mj-hub__wall-count {
  top: 12%;
}
.mj-hub__wall-label {
  position: absolute;
  top: 38%;
  right: 0;
  left: 0;
  color: $ftl-color-mj-muted;
  line-height: 1.1;
}
.mj-hub__clock {
  position: absolute;
  top: 48%;
  right: 0;
  left: 0;
  color: $ftl-color-mj-cream;
  font-weight: 600;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.mj-hub__clock--urgent {
  color: $ftl-color-mj-urgent;
}
.mj-hub__status {
  position: absolute;
  top: 64%;
  left: 8%;
  right: 8%;
  overflow: hidden;
  max-width: 84%;
  color: $ftl-color-mj-status;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-hub--compact .mj-hub__status {
  top: 66%;
}
.mj-hub__dot {
  position: absolute;
  box-sizing: border-box;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: $ftl-color-mj-dot;
  transition: background .3s, box-shadow .3s;
}
.mj-hub--compact .mj-hub__dot {
  width: 8px;
  height: 8px;
}
/* 四个方位点钉在盘缘 2%/50%/98%：translate 的符号按锚边取，保证圆心落在百分比上。 */
.mj-hub__dot--top {
  top: 2%;
  left: 50%;
  transform: translate(-50%, -50%);
}
.mj-hub__dot--right {
  top: 50%;
  right: 2%;
  transform: translate(50%, -50%);
}
.mj-hub__dot--self {
  bottom: 2%;
  left: 50%;
  transform: translate(-50%, 50%);
}
.mj-hub__dot--left {
  top: 50%;
  left: 2%;
  transform: translate(-50%, -50%);
}
.mj-hub__dot--lit {
  background: $ftl-color-mj-highlight;
  box-shadow: 0 0 8px $ftl-color-mj-highlight;
}
.mj-hub__badge {
  position: absolute;
  padding: 2px 5px;
  border: $ftl-hairline solid $ftl-color-mj-border;
  border-radius: 8px;
  background: $ftl-color-mj-lacquer;
  color: $ftl-color-mj-cream;
  line-height: 1.15;
  white-space: nowrap;
  transform: translate(-50%, -50%);
}
/* 四角映射（mockup）：left→左上、top→右上、right→右下、self→左下。 */
.mj-hub__badge--left {
  top: 14%;
  left: 14%;
}
.mj-hub__badge--top {
  top: 14%;
  left: 86%;
}
.mj-hub__badge--right {
  top: 86%;
  left: 86%;
}
.mj-hub__badge--self {
  top: 86%;
  left: 14%;
}
/* 胡牌金光覆盖层：只画金色内晕，pointer-events 穿透。 */
.mj-hub__flash {
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 50%, rgba($ftl-color-mj-gold, .35) 0%, rgba($ftl-color-mj-gold, 0) 70%);
}
</style>

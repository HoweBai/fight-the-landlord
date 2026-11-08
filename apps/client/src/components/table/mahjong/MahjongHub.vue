<script setup lang="ts">
/**
 * 血战盘（哑组件）：铜钱信息井 —— 中央方孔（牌墙 + 操作提示）+ 四扇形（倒计时/徽标）。
 *
 * 只渲染 props，不判规则、不取数、不造计时器：
 *  - 不含分数；没有中央 claim 牌（rob 的待响应牌由 ActionBar 显示）。
 *  - 扇形亮规则：play/claim/rob 亮 currentPlayer；exchange/lack 亮 activeSeats；
 *    其余（draw/ended）不亮；没有映射座位的方向永不点亮。
 *  - 亮块显示倒计时；未亮块显示该家的单字徽标（胡/听/缺/托，由 Board 按 胡>听>缺>托 求好）。
 *  - 紧迫动效：仅在我方出牌末 5 秒给「自家」槽挂 `anim-mj-urgent`（下槽无静态 transform）。
 *  - 胡牌金光：`flashKey > 0` 时挂一次性覆盖层；animationend 后 emit `flash-done`。
 *  - 视觉恒为紧凑档（160×160 设计 px，由 Board 定位/缩放）。
 */
import { computed } from 'vue';
import type { MahjongPhase } from '@fight-the-landlord/protocol';

type HubDir = 'top' | 'left' | 'right' | 'self';
type HubBadge = 'hu' | 'ting' | 'lack' | 'trustee';

interface HubSeat {
  seat: number;
  dir: HubDir;
  badge?: HubBadge | null;
  badgeText?: string;
}

const props = withDefaults(
  defineProps<{
    wallCount: number;
    seconds: number;
    phase: MahjongPhase;
    currentPlayer: number;
    activeSeats: number[];
    seats: HubSeat[];
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

function seatOf(dir: HubDir): number | undefined {
  return props.seats.find((s) => s.dir === dir)?.seat;
}

/** 方孔提示：最多 5 字 + 省略号（62px 内容宽）；endedText 优先。 */
const statusShown = computed(() => {
  const chars = Array.from(props.endedText || props.statusText || '');
  return chars.length > 5 ? `${chars.slice(0, 5).join('')}…` : chars.join('');
});

const wallShown = computed(() => Math.max(0, Math.floor(Number(props.wallCount) || 0)));

interface HubSector {
  dir: HubDir;
  lit: boolean;
  urgent: boolean;
  text: string;
  kind: 'clock' | 'badge' | 'none';
}

const sectors = computed<HubSector[]>(() =>
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
    if (lit) {
      const urgent =
        dir === 'self' && props.phase === 'play' && props.seconds > 0 && props.seconds <= 5;
      const seconds = Math.max(0, Math.floor(Number(props.seconds) || 0));
      return { dir, lit, urgent, text: `${seconds}s`, kind: 'clock' };
    }
    const seatInfo = props.seats.find((s) => s.dir === dir);
    const badgeText = seatInfo?.badge && seatInfo.badgeText ? seatInfo.badgeText : '';
    return { dir, lit, urgent: false, text: badgeText, kind: badgeText ? 'badge' : 'none' };
  }),
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
  <view class="mj-hub">
    <view
      v-for="s in sectors"
      :key="`sector-${s.dir}`"
      class="mj-hub__sector"
      :class="[`mj-hub__sector--${s.dir}`, { 'mj-hub__sector--lit': s.lit }]"
    />
    <view class="mj-hub__diag mj-hub__diag--a" />
    <view class="mj-hub__diag mj-hub__diag--b" />
    <view class="mj-hub__hole">
      <text class="mj-hub__wall-count">{{ wallShown }}</text>
      <text v-if="statusShown" class="mj-hub__hint">{{ statusShown }}</text>
    </view>
    <template v-for="s in sectors" :key="`slot-${s.dir}`">
      <text
        v-if="s.text"
        class="mj-hub__slot"
        :class="[
          `mj-hub__slot--${s.dir}`,
          { 'mj-hub__slot--badge': s.kind === 'badge' },
          { 'mj-hub__slot--urgent': s.urgent, 'anim-mj-urgent': s.urgent },
        ]"
      >{{ s.text }}</text>
    </template>
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
/* 四扇形：45°/135° 对角线切分（上/右/下/左）。待机 .4，亮块 1。 */
.mj-hub__sector {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  opacity: .4;
  transition: opacity .3s;
}
.mj-hub__sector--top {
  background: conic-gradient(from -45deg, rgba($ftl-color-mj-gold, .28) 0deg, rgba($ftl-color-mj-gold, .28) 90deg, transparent 90deg, transparent 360deg);
}
.mj-hub__sector--right {
  background: conic-gradient(from 45deg, rgba($ftl-color-mj-gold, .28) 0deg, rgba($ftl-color-mj-gold, .28) 90deg, transparent 90deg, transparent 360deg);
}
.mj-hub__sector--self {
  background: conic-gradient(from 135deg, rgba($ftl-color-mj-gold, .28) 0deg, rgba($ftl-color-mj-gold, .28) 90deg, transparent 90deg, transparent 360deg);
}
.mj-hub__sector--left {
  background: conic-gradient(from 225deg, rgba($ftl-color-mj-gold, .28) 0deg, rgba($ftl-color-mj-gold, .28) 90deg, transparent 90deg, transparent 360deg);
}
.mj-hub__sector--lit {
  opacity: 1;
}
/* 对角线发丝层：不随扇形 dim；45°/135°。 */
.mj-hub__diag {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 148px;
  height: $ftl-hairline;
  background: rgba($ftl-color-mj-gold, .16);
  transform-origin: center;
  pointer-events: none;
}
.mj-hub__diag--a {
  transform: translate(-50%, -50%) rotate(45deg);
}
.mj-hub__diag--b {
  transform: translate(-50%, -50%) rotate(-45deg);
}
/* 中央方孔：66×66 border-box（内容宽 62）。 */
.mj-hub__hole {
  position: absolute;
  left: 50%;
  top: 50%;
  box-sizing: border-box;
  width: 66px;
  height: 66px;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: $ftl-hairline solid $ftl-color-mj-border;
  border-radius: 4px;
  background: rgba($ftl-color-mj-lacquer, .84);
  z-index: 2;
}
.mj-hub__wall-count {
  color: $ftl-color-mj-sheen;
  font-size: 30px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.mj-hub__hint {
  max-width: 100%;
  overflow: hidden;
  color: $ftl-color-mj-status;
  font-size: 10px;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 扇形文本槽：lit=倒计时，未 lit=徽标胶囊。 */
.mj-hub__slot {
  position: absolute;
  z-index: 2;
  color: $ftl-color-mj-cream;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.mj-hub__slot--top {
  top: 12%;
  left: 0;
  right: 0;
  text-align: center;
}
.mj-hub__slot--self {
  bottom: 6%;
  left: 0;
  right: 0;
  text-align: center;
}
.mj-hub__slot--left {
  top: 50%;
  left: 11%;
  transform: translate(-50%, -50%);
}
.mj-hub__slot--right {
  top: 50%;
  right: 11%;
  transform: translate(50%, -50%);
}
.mj-hub__slot--urgent {
  color: $ftl-color-mj-urgent;
}
.mj-hub__slot--badge {
  padding: 0 5px;
  border: $ftl-hairline solid $ftl-color-mj-border;
  border-radius: 8px;
  background: rgba($ftl-color-mj-lacquer, .85);
  color: $ftl-color-mj-cream;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.25;
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

<script setup lang="ts">
/**
 * 麻将单座信息面板（哑组件）：昵称 / 张数 / 定缺 / 副露 / 弃牌 / 已胡亮牌 / 状态徽标。
 *
 * 只渲染 props 里服务端已经算好的字段；不判规则、不算分。暗杠按牌背展示
 *（副露结构里的 `angang` 仍是服务端公开的「有暗杠」事实，具体牌面不必亮出）。
 */
import { computed } from 'vue';
import {
  MAHJONG_SUIT_NAMES,
  type MahjongHuInfo,
  type MahjongMeldView,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';
import MahjongMeld from './MahjongMeld.vue';

type Direction = 'my' | 'top' | 'left' | 'right';

const props = withDefaults(
  defineProps<{
    seat: number;
    name: string;
    cardCount: number;
    lackSuit: MahjongSuit | null;
    melds: MahjongMeldView[];
    discards: Tile[];
    hu: MahjongHuInfo | null;
    revealed: { seat: number; tiles: Tile[]; huTile: Tile } | null;
    isOut: boolean;
    trustee: boolean;
    /** Batch 4 D 组：发光强度分级。null = 不发光。替换旧 active: boolean。 */
    activeLevel?: 'strong' | 'weak' | null;
    /** Batch 5 B 组：对手是否听牌（服务端 tingSeats 广播）。 */
    ting?: boolean;
    isMe: boolean;
    isDealer: boolean;
    balance: number | null;
    pendingDelta: number;
    /** 横向布局（左右两侧）时收窄弃牌区。 */
    compact?: boolean;
    /** 牌面方向，透传给 MahjongTile/MahjongMeld。 */
    direction?: Direction;
  }>(),
  { compact: false, direction: 'my', activeLevel: null, ting: false },
);

const emit = defineEmits<{
  /** Batch 4 A 组：用户点击弃牌，让 Board.vue 统一处理过滤逻辑。 */
  (e: 'discard-click', tile: Tile): void;
}>();

const MELD_LABEL: Record<MahjongMeldView['kind'], string> = {
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
};

// Batch 4 C 组：番型 emoji 映射（纯数据常量，和 Settlement.vue 保持一致）
const FAN_EMOJI: Record<string, string> = {
  清一色: '🎴', 七对: '👯', 大对: '🔶', 根: '🌳', 杠上开花: '💥',
  海底捞月: '🌙', 十三幺: '👻', 对对胡: '🃏', 平胡: '✨', 抢杠胡: '⚡',
  龙七对: '🐉', 清对: '🎯', 将对: '⚔️',
};
function fanEmoji(name: string): string { return FAN_EMOJI[name] ?? '🏆'; }

const lackLabel = computed(() =>
  props.lackSuit === null ? '' : `缺${MAHJONG_SUIT_NAMES[props.lackSuit]}`,
);
const hasMeta = computed(
  () => props.trustee || props.hu !== null || props.isOut || lackLabel.value !== '',
);
</script>

<template>
  <view
    class="mj-seat"
    :class="{
      'mj-seat--me': isMe,
      'mj-seat--out': isOut,
      'mj-seat--compact': compact,
      'mj-seat--active-strong': activeLevel === 'strong',
      'mj-seat--active-weak': activeLevel === 'weak',
    }"
  >
    <view class="mj-seat__head">
      <text class="mj-seat__name">{{ name }}</text>
      <text v-if="isDealer" class="mj-seat__badge mj-seat__badge--dealer">庄</text>
      <text v-if="cardCount > 0" class="mj-seat__count">{{ cardCount }} 张</text>
      <text v-if="balance !== null" class="mj-seat__balance">金币 {{ balance }}</text>
    </view>

    <view v-if="hasMeta" class="mj-seat__meta">
      <text v-if="lackLabel" class="mj-seat__badge mj-seat__badge--lack">{{ lackLabel }}</text>
      <text v-if="trustee" class="mj-seat__badge">托管</text>
      <template v-if="hu">
        <text class="mj-seat__badge mj-seat__badge--hu">
          {{ hu.selfDraw ? '自摸' : '胡' }}{{ hu.fan > 0 ? ` ${hu.fan}番` : '' }}
        </text>
        <text
          v-if="hu.items.length > 0"
          class="mj-seat__badge mj-seat__badge--fan"
        >
          {{ fanEmoji(hu.items[0]) }}{{ hu.items[0] }}
          <text v-if="hu.items.length > 1" class="mj-seat__badge--fan-more">等{{ hu.items.length }}种</text>
        </text>
      </template>
      <text v-else-if="isOut" class="mj-seat__badge mj-seat__badge--out">已出局</text>
      <text v-if="ting && !isOut && !hu" class="mj-seat__badge mj-seat__badge--ting">听</text>
      <text
        v-if="pendingDelta !== 0"
        class="mj-seat__badge"
        :class="pendingDelta > 0 ? 'mj-seat__badge--pos' : 'mj-seat__badge--neg'"
      >
        {{ pendingDelta > 0 ? `+${pendingDelta}` : pendingDelta }}
      </text>
    </view>

    <!-- T5 Batch 1: 副露用 MahjongMeld 独立组件 -->
    <view v-if="melds.length > 0" class="mj-seat__row">
      <view v-for="(meld, i) in melds" :key="`meld-${i}`" class="mj-seat__meld">
        <text class="mj-seat__meld-label">{{ MELD_LABEL[meld.kind] }}</text>
        <MahjongMeld :meld="meld" :direction="direction" size="sm" />
      </view>
    </view>

    <view v-if="discards.length > 0" class="mj-seat__row mj-seat__row--river mj-river">
      <MahjongTile
        v-for="(tile, i) in discards"
        :key="`discard-${i}`"
        :tile="tile"
        size="sm"
        :direction="direction"
        :class="{ 'mj__discard--latest': i === discards.length - 1 && discards.length > 0 }"
        @click="emit('discard-click', tile)"
      />
      <view v-if="discards.length > 6" class="mj-river__mask" />
    </view>

    <view v-if="revealed" class="mj-seat__row mj-seat__row--revealed">
      <MahjongTile
        v-for="(tile, i) in revealed.tiles"
        :key="`revealed-${i}`"
        :tile="tile"
        size="sm"
        :direction="direction"
        dim
      />
    </view>
  </view>
</template>

<style scoped lang="scss">
// Batch 2 闸纪律：必须 @import 进组件（animations.scss 顶部注释）
@import '../../../styles/animations.scss';

.mj-seat {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  padding: 6px 8px;
  border-radius: $ftl-radius-sm;
  background: rgba(0, 0, 0, 0.28);
  border: $ftl-hairline solid transparent;
  color: $ftl-color-text;
  transition: border-color 0.15s, background 0.15s;
}
// Batch 4 D 组：activeLevel 替换旧 active: boolean
// 复用 ftl-active-glow keyframe（只调 animation-duration + box-shadow），零新增 keyframe
.mj-seat--active-strong {
  border-color: $ftl-color-gold;
  background: rgba($ftl-color-gold, 0.12);
  animation: ftl-active-glow 1.2s ease-in-out infinite;
  box-shadow: 0 0 14px rgba($ftl-color-gold, 0.5);
}
.mj-seat--active-weak {
  border-color: rgba($ftl-color-gold, 0.6);
  background: rgba($ftl-color-gold, 0.06);
  animation: ftl-active-glow 2.2s ease-in-out infinite;
  box-shadow: 0 0 6px rgba($ftl-color-gold, 0.25);
}
// 高项 H2 修法：组件 scoped 动画在组件内加 reduced-motion 规则
// animations.scss 的 media query 管不到组件内直接写的 animation 属性
@media (prefers-reduced-motion: reduce) {
  .mj-seat--active-strong,
  .mj-seat--active-weak {
    animation: none !important;
    box-shadow: 0 0 8px rgba($ftl-color-gold, 0.2);
  }
}
.mj-seat--out {
  opacity: 0.6;
}
.mj-seat--me {
  border-color: rgba(255, 255, 255, 0.18);
}
.mj-seat__head {
  display: flex;
  align-items: center;
  gap: $ftl-space-2;
  min-width: 0;
}
.mj-seat__name {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: $ftl-font-sm;
  font-weight: 600;
}
.mj-seat__count,
.mj-seat__balance {
  flex: 0 0 auto;
  font-size: 10px;
  color: $ftl-color-text-muted;
}
.mj-seat__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.mj-seat__badge {
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.4;
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.85);
}
.mj-seat__badge--dealer {
  background: $ftl-color-accent;
  color: $ftl-color-on-primary;
}
.mj-seat__badge--lack {
  background: rgba(120, 170, 255, 0.3);
}
.mj-seat__badge--hu,
.mj-seat__badge--pos {
  background: rgba($ftl-color-gold, 0.35);
  color: $ftl-color-gold-light;
}
// Batch 4 C 组：番型 emoji badge
.mj-seat__badge--fan {
  background: rgba($ftl-color-accent, 0.25);
  color: $ftl-color-hint-warn;
}
.mj-seat__badge--fan-more {
  font-size: 9px;
  opacity: 0.8;
}
.mj-seat__badge--ting {
  background: rgba(74, 222, 128, 0.25);
  color: $ftl-color-hint-safe;
}
.mj-seat__badge--out,
.mj-seat__badge--neg {
  background: rgba($ftl-color-danger, 0.3);
}
.mj-seat__row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 2px;
  max-height: 84px;
  overflow: hidden;
}
.mj-seat__row--river {
  padding-top: 3px;
  border-top: $ftl-hairline dashed rgba(255, 255, 255, 0.12);
  // 高项 H1 修法：overflow:hidden 会裁 box-shadow；弃牌河不受 compact max-height 约束
  overflow: visible;
  max-height: none;
  position: relative; // 渐隐遮罩 absolute 定位需要
}
.mj-river__mask {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 16px;
  background: linear-gradient(to bottom, transparent, rgba(0, 0, 0, 0.5));
  pointer-events: none;
  // 让它只在有牌时才可见（无牌时不占空间）
  display: block;
}
.mj-seat__row--revealed {
  opacity: 0.85;
}
.mj-seat__meld {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-right: 6px;
}
.mj-seat__meld-label {
  font-size: 10px;
  color: $ftl-color-text-muted;
}
.mj-seat__tiles {
  display: flex;
  gap: 2px;
}
.mj-seat--compact .mj-seat__row:not(.mj-seat__row--river):not(.mj-seat__row--revealed) {
  max-height: 60px;
}
</style>

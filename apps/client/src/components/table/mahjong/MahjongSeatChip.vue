<script setup lang="ts">
/**
 * 麻将座位小卡（哑组件）：只渲染 props，不判规则、不取数、不造计时器。
 * 三个变体：self（左下角头像+分数）、side（左右家头像+名字/分/徽标）、bar（顶栏对家 40 头像）。
 */
import { computed } from 'vue';
import {
  MAHJONG_SUIT_NAMES,
  type MahjongHuInfo,
  type MahjongSuit,
} from '@fight-the-landlord/protocol';

const props = withDefaults(defineProps<{
  name: string;
  isMe?: boolean;
  isDealer?: boolean;
  cardCount?: number;
  lackSuit?: MahjongSuit | null;
  hu?: MahjongHuInfo | null;
  isOut?: boolean;
  trustee?: boolean;
  ting?: boolean;
  activeLevel?: 'strong' | 'weak' | null;
  balance?: number | null;
  pendingDelta?: number;
  /** 头像边长（设计 px），由布局函数给。 */
  avatar?: number;
  variant?: 'self' | 'side' | 'bar';
}>(), {
  isMe: false,
  isDealer: false,
  cardCount: 0,
  lackSuit: null,
  hu: null,
  isOut: false,
  trustee: false,
  ting: false,
  activeLevel: null,
  balance: null,
  pendingDelta: 0,
  avatar: 56,
  variant: 'side',
});

const FAN_EMOJI: Record<string, string> = {
  清一色: '🎴', 七对: '👯', 大对: '🔶', 根: '🌳', 杠上开花: '💥',
  海底捞月: '🌙', 十三幺: '👻', 对对胡: '🃏', 平胡: '✨', 抢杠胡: '⚡',
  龙七对: '🐉', 清对: '🎯', 将对: '⚔️',
};
const lackLabel = computed(() =>
  props.lackSuit === null ? '' : `缺${MAHJONG_SUIT_NAMES[props.lackSuit]}`,
);
const deltaLabel = computed(() => {
  if (props.pendingDelta === 0) return '';
  return props.pendingDelta > 0 ? `+${props.pendingDelta}` : `${props.pendingDelta}`;
});
const fanLabel = computed(() => {
  const first = props.hu?.items[0];
  if (!first) return '';
  const more = (props.hu?.items.length ?? 0) > 1 ? `等${props.hu!.items.length}种` : '';
  return `${FAN_EMOJI[first] ?? '🏆'}${first}${more}`;
});
const metaText = computed(() => {
  const parts: string[] = [];
  if (!props.isMe && props.variant !== 'bar' && props.cardCount > 0) {
    parts.push(`${props.cardCount} 张`);
  }
  if (props.balance !== null) parts.push(`${props.balance}`);
  return parts.join(' · ');
});
</script>

<template>
  <view
    class="mj-chip"
    :class="[
      `mj-chip--${variant}`,
      {
        'mj-chip--me': isMe,
        'mj-chip--out': isOut,
        'mj-chip--active-strong': activeLevel === 'strong',
        'mj-chip--active-weak': activeLevel === 'weak',
      },
    ]"
  >
    <view class="mj-chip__avatar-box" :style="{ width: `${avatar}px`, height: `${avatar}px` }">
      <image class="mj-chip__avatar" src="/static/ui/default.png" mode="aspectFit" />
      <text v-if="isDealer" class="mj-chip__corner mj-chip__corner--dealer">庄</text>
      <text v-if="lackLabel" class="mj-chip__corner mj-chip__corner--lack">{{ lackLabel }}</text>
      <text v-if="hu" class="mj-chip__corner mj-chip__corner--hu">
        胡{{ hu.fan > 0 ? ` ${hu.fan}` : '' }}
      </text>
      <text v-else-if="ting && !isOut" class="mj-chip__corner mj-chip__corner--ting">听</text>
    </view>

    <view v-if="variant !== 'self'" class="mj-chip__info">
      <text class="mj-chip__name">{{ name }}</text>
      <text class="mj-chip__meta">{{ metaText }}</text>
      <view v-if="trustee || isOut || hu || deltaLabel || fanLabel" class="mj-chip__badges">
        <text v-if="trustee" class="mj-chip__badge">托管</text>
        <text v-if="isOut && !hu" class="mj-chip__badge mj-chip__badge--neg">已出局</text>
        <text v-if="hu" class="mj-chip__badge mj-chip__badge--pos">
          {{ hu.fan > 0 ? `${hu.fan} 番` : '胡' }}
        </text>
        <text v-if="fanLabel" class="mj-chip__badge mj-chip__badge--fan">{{ fanLabel }}</text>
        <text
          v-if="deltaLabel"
          class="mj-chip__badge"
          :class="pendingDelta > 0 ? 'mj-chip__badge--pos' : 'mj-chip__badge--neg'"
        >
          {{ deltaLabel }}
        </text>
      </view>
    </view>

    <view v-else class="mj-chip__self-info">
      <text class="mj-chip__self-name">{{ name }}</text>
      <text class="mj-chip__meta">{{ balance ?? '—' }}</text>
      <text
        v-if="deltaLabel"
        class="mj-chip__delta"
        :class="pendingDelta > 0 ? 'mj-chip__badge--pos' : 'mj-chip__badge--neg'"
      >
        {{ deltaLabel }}
      </text>
    </view>
  </view>
</template>

<style scoped lang="scss">
@import "../../../styles/animations.scss";

.mj-chip {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  color: $ftl-color-text;
}
.mj-chip--side {
  width: 100%;
  height: 100%;
  padding: 0 2px;
}
.mj-chip--bar {
  height: 100%;
}
.mj-chip--self {
  width: 100%;
  height: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.mj-chip__avatar-box {
  position: relative;
  flex: 0 0 auto;
}
.mj-chip__avatar {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: $ftl-hairline solid rgba($ftl-color-on-primary, 0.8);
  border-radius: $ftl-radius-pill;
  background: $ftl-color-surface;
}
.mj-chip__corner {
  position: absolute;
  padding: 0 3px;
  border-radius: 999px;
  font-size: 9px;
  line-height: 1.3;
  background: rgba(0, 0, 0, 0.65);
  color: $ftl-color-on-primary;
  white-space: nowrap;
}
.mj-chip__corner--dealer {
  top: -2px;
  right: -2px;
  background: $ftl-color-accent;
}
.mj-chip__corner--lack {
  bottom: -2px;
  left: -2px;
  background: rgba(120, 170, 255, 0.85);
}
.mj-chip__corner--hu {
  top: -2px;
  left: -2px;
  background: rgba($ftl-color-gold, 0.9);
}
.mj-chip__corner--ting {
  top: -2px;
  left: -2px;
  background: rgba(74, 222, 128, 0.9);
  color: $ftl-color-night-deep;
}
.mj-chip__info {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.mj-chip__name {
  overflow: hidden;
  font-size: $ftl-font-sm;
  font-weight: 600;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-chip__meta {
  overflow: hidden;
  color: rgba($ftl-color-on-primary, 0.8);
  font-size: 10px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-chip__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.mj-chip__badge {
  padding: 0 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
}
.mj-chip__badge--pos {
  background: rgba($ftl-color-gold, 0.35);
  color: $ftl-color-gold-light;
}
.mj-chip__badge--neg {
  background: rgba($ftl-color-danger, 0.3);
}
.mj-chip__badge--fan {
  background: rgba($ftl-color-accent, 0.3);
  color: $ftl-color-hint-warn;
}
.mj-chip__self-info {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  // self 变体下：头像在 chip 上方，self-info 在下方需要 column 排列
  .mj-chip--self & {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding-top: 2px;
  }
}
.mj-chip__self-name {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 56px;
}
.mj-chip__delta {
  font-size: 9px;
}
.mj-chip--out {
  opacity: 0.6;
}
.mj-chip--active-strong {
  border-radius: $ftl-radius-md;
  animation: ftl-active-glow 1.2s ease-in-out infinite;
  box-shadow: 0 0 14px rgba($ftl-color-gold, 0.5);
}
.mj-chip--active-weak {
  border-radius: $ftl-radius-md;
  animation: ftl-active-glow 2.2s ease-in-out infinite;
  box-shadow: 0 0 6px rgba($ftl-color-gold, 0.25);
}
@media (prefers-reduced-motion: reduce) {
  .mj-chip--active-strong,
  .mj-chip--active-weak {
    animation: none !important;
    box-shadow: 0 0 8px rgba($ftl-color-gold, 0.2);
  }
}
</style>

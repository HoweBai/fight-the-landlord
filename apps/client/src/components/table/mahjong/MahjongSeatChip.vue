<script setup lang="ts">
/**
 * 麻将座位小卡（哑组件）：只渲染 props，不判规则、不取数、不造计时器。
 *
 * 四变体：corner-tl / corner-tr / corner-top（对手与对家，名字+分数+delta 一行）、
 * self（自己，头像+分数+delta 竖排）。
 * `side` / `bar` 是旧 Board 的兼容别名，Task 8 重接 Board 时删除。
 *
 * 角标最多 2 个（2026-11-08 红金皮肤起相对牌面）：左上 1 字（胡 > 听 > 托 > 庄）；左下 2 字（缺X）。
 * 无张数、无番行/徽标行；金边状态（strong/line/winner）全部为静态样式。
 * 设计：docs/superpowers/specs/2026-11-05-mahjong-table-redgold-design-v6.md §3.4、§4；
 * 皮肤：`.superpowers/mahjong-redgold/mockup/index.html`。
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
  /** 仅为 Board 传参兼容保留，不渲染任何张数文案。 */
  cardCount?: number;
  lackSuit?: MahjongSuit | null;
  hu?: MahjongHuInfo | null;
  isOut?: boolean;
  trustee?: boolean;
  ting?: boolean;
  /** `weak` 是 `line` 的兼容别名（同静态样式）。 */
  activeLevel?: 'strong' | 'line' | 'weak' | null;
  winner?: boolean;
  balance?: number | null;
  pendingDelta?: number;
  /** 头像边长（设计 px），由布局函数给。 */
  avatar?: number;
  /** `side` / `bar` 为旧 Board 兼容别名，Task 8 重接后删除。 */
  variant?: 'corner-tl' | 'corner-tr' | 'corner-top' | 'self' | 'side' | 'bar';
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
  winner: false,
  balance: null,
  pendingDelta: 0,
  avatar: 56,
  variant: 'corner-tr',
});

type CornerKind = 'hu' | 'ting' | 'trustee' | 'dealer';
/** 右上槽：胡 > 听 > 托 > 庄，最多一个。 */
const corner = computed<{ kind: CornerKind; char: string } | null>(() => {
  if (props.hu) return { kind: 'hu', char: '胡' };
  if (props.ting) return { kind: 'ting', char: '听' };
  if (props.trustee) return { kind: 'trustee', char: '托' };
  if (props.isDealer) return { kind: 'dealer', char: '庄' };
  return null;
});
/** 左下槽：缺X（2 字），与右上槽互不影响。 */
const lackLabel = computed(() =>
  props.lackSuit === null ? '' : `缺${MAHJONG_SUIT_NAMES[props.lackSuit]}`,
);
const deltaLabel = computed(() => {
  if (props.pendingDelta === 0) return '';
  return props.pendingDelta > 0 ? `+${props.pendingDelta}` : `${props.pendingDelta}`;
});
/** 分数千分位（显式 en-US，避免宿主 locale 漂移）；6 位数必须完整格式化。 */
const scoreLabel = computed(() =>
  props.balance === null ? '—' : props.balance.toLocaleString('en-US'),
);
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
        'mj-chip--active-line': activeLevel === 'line' || activeLevel === 'weak',
        'mj-chip--winner': winner,
      },
    ]"
  >
    <view class="mj-chip__avatar-box" :style="{ width: `${avatar}px`, height: `${avatar}px` }">
      <image class="mj-chip__avatar" src="/static/ui/default.png" mode="aspectFit" />
    </view>

    <!-- 角标相对牌面（mockup）：左上一字槽 / 左下缺槽；不再挂在头像框上。 -->
    <text
      v-if="corner"
      class="mj-chip__corner mj-chip__corner--tl"
      :class="`mj-chip__corner--${corner.kind}`"
    >
      {{ corner.char }}
    </text>
    <text v-if="lackLabel" class="mj-chip__corner mj-chip__corner--bl mj-chip__corner--lack">
      {{ lackLabel }}
    </text>

    <view v-if="variant !== 'self'" class="mj-chip__info">
      <text class="mj-chip__name" style="font-size: 18px">{{ name }}</text>
      <view class="mj-chip__sub">
        <text class="mj-chip__score" style="font-size: 18px">{{ scoreLabel }}</text>
        <text
          v-if="deltaLabel"
          class="mj-chip__delta"
          :class="pendingDelta > 0 ? 'mj-chip__delta--pos' : 'mj-chip__delta--neg'"
          style="font-size: 12px"
        >
          {{ deltaLabel }}
        </text>
      </view>
    </view>

    <view v-else class="mj-chip__self-info">
      <text class="mj-chip__score" style="font-size: 16px">{{ scoreLabel }}</text>
      <text
        v-if="deltaLabel"
        class="mj-chip__delta"
        :class="pendingDelta > 0 ? 'mj-chip__delta--pos' : 'mj-chip__delta--neg'"
        style="font-size: 12px"
      >
        {{ deltaLabel }}
      </text>
    </view>
  </view>
</template>

<style scoped lang="scss">
/* —— 牌面（2026-11-08 红金皮肤）：漆底 88% + 金棕发丝边 + 12px 圆角 —— */
.mj-chip {
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 0 4px;
  overflow: hidden;
  background: rgba($ftl-color-mj-lacquer, 0.88);
  border: $ftl-hairline solid $ftl-color-mj-border;
  border-radius: 12px;
  color: $ftl-color-mj-cream;
}
/* 四个新变体的静态锚点；--side / --bar 是旧 Board 兼容别名（Task 8 删除）。 */
.mj-chip--corner-tl,
.mj-chip--corner-tr,
.mj-chip--corner-top,
.mj-chip--side,
.mj-chip--bar {
  width: 100%;
  height: 100%;
}
.mj-chip--corner-tl {
  justify-content: flex-start;
}
.mj-chip--corner-tr {
  justify-content: flex-end;
}
.mj-chip--corner-top {
  justify-content: center;
}
.mj-chip--self {
  width: 100%;
  height: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  padding: 2px;
}
/* 头像：56（self 44），10px 圆角 + 内金环（内联尺寸由 avatar prop 给） */
.mj-chip__avatar-box {
  position: relative;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: 10px;
  background: rgba($ftl-color-mj-hub-core, 0.6);
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 10px;
    box-shadow: inset 0 0 0 $ftl-hairline rgba($ftl-color-mj-gold, 0.5);
    pointer-events: none;
  }
}
.mj-chip__avatar {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border-radius: 10px;
}
/* 角标：相对牌面（mockup：左上一字 / 左下缺）；漆底金棕边、统一 10px */
.mj-chip__corner {
  position: absolute;
  padding: 0 2px;
  border: $ftl-hairline solid $ftl-color-mj-border;
  border-radius: 6px;
  background: $ftl-color-mj-lacquer;
  color: $ftl-color-mj-cream;
  font-size: 10px;
  line-height: 1.3;
  white-space: nowrap;
}
.mj-chip__corner--tl {
  top: 0;
  left: 30px;
}
.mj-chip__corner--bl {
  bottom: 0;
  left: 0;
}
/* 信息列：两行（名字 / 分数+delta）；名字与分数一律 normal weight */
.mj-chip__info {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}
.mj-chip__sub {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}
.mj-chip__name {
  overflow: hidden;
  max-width: 100%;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-chip__score {
  overflow: hidden;
  min-width: 0;
  color: $ftl-color-mj-sheen;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-chip__self-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
  min-width: 0;
  max-width: 100%;
}
.mj-chip__delta {
  line-height: 1.1;
  white-space: nowrap;
}
.mj-chip__delta--pos {
  color: $ftl-color-mj-positive;
}
.mj-chip__delta--neg {
  color: $ftl-color-mj-urgent;
}
.mj-chip--out {
  opacity: 0.6;
}
/* 金边三态：全部静态（无任何动效）。 */
.mj-chip--active-strong {
  border-color: $ftl-color-mj-gold;
  box-shadow: 0 0 12px rgba($ftl-color-mj-gold, 0.55);
}
.mj-chip--winner {
  border-color: $ftl-color-mj-gold;
  box-shadow: 0 0 12px rgba($ftl-color-mj-gold, 0.55);
}
.mj-chip--active-line {
  border-color: $ftl-color-mj-gold;
}
</style>

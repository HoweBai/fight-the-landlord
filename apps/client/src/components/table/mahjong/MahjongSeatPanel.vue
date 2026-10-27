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
    active: boolean;
    isMe: boolean;
    isDealer: boolean;
    balance: number | null;
    pendingDelta: number;
    /** 横向布局（左右两侧）时收窄弃牌区。 */
    compact?: boolean;
  }>(),
  { compact: false },
);

const MELD_LABEL: Record<MahjongMeldView['kind'], string> = {
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
};

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
      'mj-seat--active': active,
      'mj-seat--out': isOut,
      'mj-seat--compact': compact,
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
      <text v-if="hu" class="mj-seat__badge mj-seat__badge--hu">
        胡{{ hu.fan > 0 ? ` ${hu.fan}番` : '' }}
      </text>
      <text v-else-if="isOut" class="mj-seat__badge mj-seat__badge--out">已出局</text>
      <text
        v-if="pendingDelta !== 0"
        class="mj-seat__badge"
        :class="pendingDelta > 0 ? 'mj-seat__badge--pos' : 'mj-seat__badge--neg'"
      >
        {{ pendingDelta > 0 ? `+${pendingDelta}` : pendingDelta }}
      </text>
    </view>

    <view v-if="melds.length > 0" class="mj-seat__row">
      <view v-for="(meld, i) in melds" :key="`meld-${i}`" class="mj-seat__meld">
        <text class="mj-seat__meld-label">{{ MELD_LABEL[meld.kind] }}</text>
        <view class="mj-seat__tiles">
          <MahjongTile
            v-for="(tile, j) in meld.tiles"
            :key="`meld-${i}-${j}`"
            :tile="tile"
            :back="meld.kind === 'angang'"
            size="sm"
          />
        </view>
      </view>
    </view>

    <view v-if="discards.length > 0" class="mj-seat__row mj-seat__row--river">
      <MahjongTile v-for="(tile, i) in discards" :key="`discard-${i}`" :tile="tile" size="sm" />
    </view>

    <view v-if="revealed" class="mj-seat__row mj-seat__row--revealed">
      <MahjongTile
        v-for="(tile, i) in revealed.tiles"
        :key="`revealed-${i}`"
        :tile="tile"
        size="sm"
        dim
      />
    </view>
  </view>
</template>

<style scoped lang="scss">
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
.mj-seat--active {
  border-color: $ftl-color-gold;
  background: rgba($ftl-color-gold, 0.12);
  box-shadow: 0 0 12px rgba($ftl-color-gold, 0.25);
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
.mj-seat--compact .mj-seat__row {
  max-height: 60px;
}
</style>

<script setup lang="ts">
/**
 * 中央井（哑组件）：牌墙/阶段/待响应牌/听牌/倒计时。
 * 井高不足时切单行紧凑模式（只出文字，不出牌面）。
 */
import { computed } from 'vue';
import { MAHJONG_SUIT_NAMES, type Tile } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

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
    endedText?: string;
  }>(),
  {
    claimTile: null,
    claimW: 34,
    claimH: 51,
    tingTiles: () => [],
    tingW: 20,
    tingH: 30,
    maxFan: null,
    active: false,
    compact: false,
    endedText: '',
  },
);

const urgent = computed(() => props.active && props.seconds > 0 && props.seconds <= 5);
const claimLabel = computed(() =>
  props.claimTile
    ? `${MAHJONG_SUIT_NAMES[props.claimTile.s]}${props.claimTile.r}`
    : '',
);
</script>

<template>
  <view class="mj-center" :class="{ 'mj-center--compact': compact }">
    <view class="mj-center__head">
      <text class="mj-center__wall">牌墙 {{ wallCount }}</text>
      <text class="mj-center__phase">{{ phaseText }}</text>
      <text
        v-if="active"
        class="mj-center__clock"
        :class="{ 'mj-center__clock--urgent': urgent }"
      >{{ seconds }}s</text>
    </view>
    <template v-if="!compact">
      <view v-if="claimTile" class="mj-center__claim">
        <MahjongTile :tile="claimTile" :w="claimW" :h="claimH" direction="my" />
        <text class="mj-center__label">可响应</text>
      </view>
      <view v-if="tingTiles.length > 0" class="mj-center__ting">
        <text class="mj-center__label">
          听<template v-if="maxFan !== null">（{{ maxFan }} 番）</template>
        </text>
        <MahjongTile
          v-for="(t, i) in tingTiles"
          :key="`ting-${i}`"
          :tile="t"
          :w="tingW"
          :h="tingH"
          direction="my"
        />
      </view>
      <text v-if="endedText" class="mj-center__ended">{{ endedText }}</text>
    </template>
    <text v-else-if="claimTile" class="mj-center__compact-claim">
      可响应 {{ claimLabel }}
    </text>
  </view>
</template>

<style scoped lang="scss">
.mj-center {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 6px 8px;
  overflow: hidden;
  border: $ftl-hairline solid rgba($ftl-color-gold, 0.35);
  border-radius: $ftl-radius-md;
  background: rgba(0, 0, 0, 0.38);
  color: $ftl-color-text;
  text-align: center;
}
.mj-center--compact {
  flex-direction: row;
  gap: 6px;
  padding: 0 8px;
  white-space: nowrap;
}
.mj-center__head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
}
.mj-center__wall {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-sm;
  font-weight: 700;
  white-space: nowrap;
}
.mj-center__phase {
  overflow: hidden;
  color: $ftl-color-gold;
  font-size: $ftl-font-md;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-center__clock {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-sm;
  font-weight: 700;
  white-space: nowrap;
}
.mj-center__clock--urgent {
  color: $ftl-color-danger;
}
.mj-center__claim,
.mj-center__ting {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 3px;
}
.mj-center__label {
  color: $ftl-color-text-muted;
  font-size: 10px;
  white-space: nowrap;
}
.mj-center__ended {
  color: $ftl-color-text-muted;
  font-size: 10px;
}
.mj-center--compact .mj-center__head {
  flex: 0 0 auto;
}
.mj-center__compact-claim {
  overflow: hidden;
  color: $ftl-color-gold-light;
  font-size: 11px;
  text-overflow: ellipsis;
}
</style>

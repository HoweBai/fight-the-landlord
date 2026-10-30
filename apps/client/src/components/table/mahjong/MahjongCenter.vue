<script setup lang="ts">
/**
 * 中央信息格（哑组件）：三档内容，宽度 = 中间列宽（由布局给）。
 *
 *  - full：牌墙大数字 + 阶段 + 倒计时 + 待响应牌（带来源座）+ 听牌列表；
 *  - dense：同上报头降一档，不显示听牌列表（副露多、格矮时仍可读）；
 *  - compact：单行「牌墙 N · 阶段 · 12s」，claim 只出文字。
 *
 * 「已胡 N 家」不在中央显示（座位卡「胡」徽标 + 亮牌承担）。
 * 无计时器：倒计时只渲染 props.seconds。
 */
import { computed } from 'vue';
import { MAHJONG_SUIT_NAMES, type Tile } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

const props = withDefaults(
  defineProps<{
    wallCount: number;
    phaseText: string;
    level?: 'full' | 'dense' | 'compact';
    claimTile?: Tile | null;
    claimW?: number;
    claimH?: number;
    claimLabel?: string;
    claimFrom?: string;
    tingTiles?: readonly Tile[];
    tingW?: number;
    tingH?: number;
    maxFan?: number | null;
    seconds: number;
    active?: boolean;
  }>(),
  {
    level: 'full',
    claimTile: null,
    claimW: 34,
    claimH: 51,
    claimLabel: '可响应',
    claimFrom: '',
    tingTiles: () => [],
    tingW: 20,
    tingH: 30,
    maxFan: null,
    active: false,
  },
);

const urgent = computed(() => props.active && props.seconds > 0 && props.seconds <= 5);
/** 牌名文字（如「万5」）；与 prop `claimLabel`（「可响应/可自摸胡」）区分，勿同名遮蔽。 */
const claimTileLabel = computed(() =>
  props.claimTile
    ? `${MAHJONG_SUIT_NAMES[props.claimTile.s]}${props.claimTile.r}`
    : '',
);
</script>

<template>
  <view
    class="mj-center"
    :class="{ 'mj-center--compact': level === 'compact', 'mj-center--dense': level === 'dense' }"
  >
    <view class="mj-center__head">
      <text class="mj-center__wall">牌墙 {{ wallCount }}</text>
      <text class="mj-center__phase">{{ phaseText }}</text>
      <template v-if="active">
        <text
          class="mj-center__clock"
          :class="{ 'mj-center__clock--urgent': urgent }"
        >{{ seconds }}s</text>
      </template>
    </view>
    <template v-if="level !== 'compact'">
      <view v-if="claimTile" class="mj-center__claim">
        <MahjongTile :tile="claimTile" :w="claimW" :h="claimH" direction="my" />
        <text class="mj-center__label">
          {{ claimLabel }}<template v-if="claimFrom"> · {{ claimFrom }}</template>
        </text>
      </view>
      <view v-if="level === 'full' && tingTiles.length > 0" class="mj-center__ting">
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
    </template>
    <text v-else-if="claimTile" class="mj-center__compact-claim">
      {{ claimLabel }} {{ claimTileLabel }}
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
  gap: 6px;
  width: 100%;
  height: 100%;
  padding: 6px 12px;
  overflow: hidden;
  border: $ftl-hairline solid rgba($ftl-color-gold, 0.35);
  border-radius: $ftl-radius-md;
  background: rgba(0, 0, 0, 0.38);
  color: $ftl-color-text;
  text-align: center;
}
.mj-center__head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-width: 0;
  max-width: 100%;
}
.mj-center__wall {
  flex: 0 0 auto;
  color: $ftl-color-gold-light;
  font-size: $ftl-font-xl;
  font-weight: 800;
  line-height: 1.1;
  white-space: nowrap;
}
.mj-center--dense .mj-center__wall {
  font-size: $ftl-font-lg;
}
.mj-center__phase {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: $ftl-color-gold;
  font-size: $ftl-font-md;
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-center--dense .mj-center__phase {
  font-size: $ftl-font-sm;
}
.mj-center__clock {
  flex: 0 0 auto;
  color: $ftl-color-gold-light;
  font-size: $ftl-font-sm;
  font-weight: 700;
  line-height: 1.2;
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
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}
.mj-center__label {
  color: $ftl-color-text-muted;
  font-size: $ftl-font-sm;
  white-space: nowrap;
}
.mj-center--compact {
  flex-direction: row;
  gap: 6px;
  padding: 0 8px;
  white-space: nowrap;
}
.mj-center--compact .mj-center__wall,
.mj-center--compact .mj-center__phase,
.mj-center--compact .mj-center__clock {
  font-size: 11px;
  line-height: 1.2;
}
.mj-center--compact .mj-center__head {
  flex: 0 0 auto;
  gap: 6px;
}
.mj-center__compact-claim {
  overflow: hidden;
  color: $ftl-color-gold-light;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

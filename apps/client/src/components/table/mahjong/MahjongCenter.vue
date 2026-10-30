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
const wallDanger = computed(() => {
  const c = props.wallCount;
  if (c <= 5) return 'critical';
  if (c <= 15) return 'warn';
  return 'safe';
});
const claimLabel = computed(() =>
  props.claimTile
    ? `${MAHJONG_SUIT_NAMES[props.claimTile.s]}${props.claimTile.r}`
    : '',
);
/** 顶部药丸显示的倒计时文本：active 时显示秒数，非 active 不渲染（Phase 3.3 再加全局最小）。 */
const clockText = computed(() => {
  if (!props.active || props.seconds <= 0) return '';
  return `${props.seconds}s`;
});
</script>

<template>
  <view class="mj-center" :class="{ 'mj-center--compact': compact, [`mj-center--wall-${wallDanger}`]: true }">
    <!-- 顶部条：牌墙药丸 + 倒计时秒数 -->
    <view class="mj-center__top-row">
      <text class="mj-center__wall-pill" :class="`mj-center__wall-pill--${wallDanger}`">
        🀄 {{ wallCount }}
      </text>
      <text
        v-if="clockText"
        class="mj-center__clock"
        :class="{
          'mj-center__clock--active': active,
          'mj-center__clock--urgent': urgent,
        }"
      >{{ clockText }}</text>
    </view>

    <!-- 中部大字：phaseText -->
    <text class="mj-center__phase">{{ phaseText }}</text>

    <!-- 底部小字：待响应牌 + 听牌提示（compact 模式也显示，只是文字） -->
    <view v-if="!compact" class="mj-center__foot">
      <view v-if="claimTile" class="mj-center__claim">
        <MahjongTile :tile="claimTile" :w="claimW" :h="claimH" direction="my" />
        <text class="mj-center__label">可响应 {{ claimLabel }}</text>
      </view>
      <view v-if="tingTiles.length > 0" class="mj-center__ting">
        <text class="mj-center__label">
          听 {{ tingTiles.length }} 张<template v-if="maxFan !== null">（{{ maxFan }} 番）</template>
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
    </view>
    <!-- compact 模式也保留听牌/可响应文字提示（之前完全消失了） -->
    <text v-else-if="claimTile || tingTiles.length > 0" class="mj-center__compact-foot">
      <template v-if="claimTile">可响应 {{ claimLabel }}</template>
      <template v-if="claimTile && tingTiles.length > 0"> · </template>
      <template v-if="tingTiles.length > 0">听 {{ tingTiles.length }} 张</template>
    </text>
  </view>
</template>

<style scoped lang="scss">
.mj-center {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 3px;
  width: 100%;
  height: 100%;
  padding: 6px 10px;
  overflow: hidden;
  border: $ftl-hairline solid rgba(255, 215, 100, 0.35);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(4px);
  color: $ftl-color-text;
  text-align: center;
}
.mj-center--compact {
  // compact 模式保持非 flex-column 结构：药丸 + phase + 小字，单行横向
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  white-space: nowrap;
}

// —— 顶部药丸行 ——
.mj-center__top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-direction: row;
  gap: 6px;
  // compact 模式：药丸 + 倒计时跟 phase 同排
  .mj-center--compact & {
    flex: 0 0 auto;
    gap: 6px;
  }
}
.mj-center__wall-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.4;
  border-radius: 10px;
  background: rgba($ftl-color-gold, 0.18);
  border: $ftl-hairline solid rgba($ftl-color-gold, 0.45);
  color: $ftl-color-gold;
  white-space: nowrap;
}
.mj-center__wall-pill--safe {
  background: rgba($ftl-color-gold, 0.18);
  border-color: rgba($ftl-color-gold, 0.45);
  color: $ftl-color-gold;
}
.mj-center__wall-pill--warn {
  background: rgba(255, 150, 50, 0.25);
  border-color: rgba(255, 180, 80, 0.6);
  color: rgba(255, 190, 120, 1);
}
.mj-center__wall-pill--critical {
  background: rgba($ftl-color-danger, 0.28);
  border-color: rgba($ftl-color-danger, 0.7);
  color: rgba(255, 140, 140, 1);
  animation: ftl-urgent-pulse 1.2s infinite ease-in-out;
}

// —— 倒计时 ——
.mj-center__clock {
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
  white-space: nowrap;
  color: $ftl-color-text-muted;
  opacity: 0.7;
  // active 才会有金色强调
  &--active {
    color: $ftl-color-gold;
    opacity: 1;
  }
  &--urgent {
    color: $ftl-color-danger;
    animation: ftl-urgent-pulse 0.9s infinite ease-in-out;
  }
}

// —— phase 大字 ——
.mj-center__phase {
  color: $ftl-color-gold;
  font-size: $ftl-font-md;
  font-weight: 700;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
  line-height: 1.3;
  // compact 缩字号
  .mj-center--compact & {
    font-size: 12px;
    flex: 1 1 auto;
    min-width: 0;
  }
}

// —— 底部小字 ——
.mj-center__foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: 1 1 auto;
  min-height: 0;
  justify-content: center;
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
.mj-center__compact-foot {
  overflow: hidden;
  color: $ftl-color-gold-light;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 0 auto;
}

// 旧类名保留（避免测试查 DOM 失败）
.mj-center__sep { display: none; }
.mj-center__wall { display: none; }
.mj-center__head { display: none; }
.mj-center__compact-claim { display: none; }
</style>

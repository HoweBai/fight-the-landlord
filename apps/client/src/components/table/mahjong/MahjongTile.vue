<script setup lang="ts">
/**
 * 单张麻将牌（哑组件）。只把 `Tile` 翻译成牌面素材路径。
 *
 * 素材：幼麟棋牌 4 方向 Atlas 提取——
 *   my (75×113 正), top (55×84 倒置), left/right (49×40 横置)，
 *   每个方向目录自带牌背。
 * 不传 `direction` → 默认 `my/`（根目录平铺旧资源已于 2026-10-29 清理）。
 * 牌面路径是**纯展示映射**，不含任何规则判定。
 * 见 `THIRD-PARTY-NOTICES.md`。
 */
import { computed } from 'vue';
import { MAHJONG_SUIT_NAMES, type Tile } from '@fight-the-landlord/protocol';

type Direction = 'my' | 'top' | 'left' | 'right';

const props = withDefaults(
  defineProps<{
    tile?: Tile;
    /** 牌背（对手暗牌/暗杠）。 */
    back?: boolean;
    size?: 'sm' | 'md' | 'lg';
    selected?: boolean;
    disabled?: boolean;
    /** 置灰（已出局/已胡座位）。 */
    dim?: boolean;
    /** 方向：my=自己 / top=对家 / left=左家 / right=右家。不传则用平铺旧资源。 */
    direction?: Direction;
  }>(),
  { size: 'md', selected: false, disabled: false, dim: false },
);

const emit = defineEmits<{ (e: 'click'): void }>();

const SUIT_FILES = ['wan', 'tong', 'tiao'] as const;

const src = computed(() => {
  const base = '/pages/table/static/mahjong/';
  const dir = `${props.direction ?? 'my'}/`;
  if (props.back || !props.tile) return `${base}${dir}back.png`;
  const suit = SUIT_FILES[props.tile.s];
  return `${base}${dir}${suit}-${props.tile.r}.png`;
});

const label = computed(() => {
  if (props.back || !props.tile) return '牌背';
  return `${MAHJONG_SUIT_NAMES[props.tile.s]}${props.tile.r}`;
});
</script>

<template>
  <image
    class="mj-tile"
    :class="[
      `mj-tile--${size}`,
      direction ? `mj-tile--dir-${direction}` : null,
      {
        'mj-tile--back': back || !tile,
        'mj-tile--selected': selected,
        'mj-tile--disabled': disabled,
        'mj-tile--dim': dim,
      },
    ]"
    :src="src"
    mode="aspectFit"
    :aria-label="label"
    @click="emit('click')"
  />
</template>

<style scoped lang="scss">
/** 牌面比例 75:113 ≈ 0.664；宽度按档位，高度由比例推出。 */
.mj-tile {
  display: block;
  flex: 0 0 auto;
  border-radius: 3px;
  background: transparent;
  transition: transform 0.08s, box-shadow 0.08s;
}
.mj-tile--sm {
  width: 26px;
  height: 39px;
}
.mj-tile--md {
  width: 34px;
  height: 51px;
}
.mj-tile--lg {
  width: 46px;
  height: 69px;
}
.mj-tile--selected {
  transform: translateY(-10px);
  box-shadow: 0 0 0 2px $ftl-color-gold, 0 6px 12px rgba(0, 0, 0, 0.4);
}
.mj-tile--disabled {
  opacity: 0.45;
}
.mj-tile--dim {
  opacity: 0.5;
  filter: grayscale(0.6);
}
/**
 * left/right 方向的牌面素材是横置（49×40，宽>高），容器需按横牌比例调整。
 * 但牌背（.mj-tile--back）图是竖的（83×125），四个方向都是同一张，
 * 所以保持默认竖牌容器尺寸，不走这个 override。
 */
.mj-tile--dir-left:not(.mj-tile--back),
.mj-tile--dir-right:not(.mj-tile--back) {
  &.mj-tile--sm { width: 39px; height: 32px; }
  &.mj-tile--md { width: 51px; height: 42px; }
  &.mj-tile--lg { width: 68px; height: 55px; }
}
</style>

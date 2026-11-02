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
    /** 显式尺寸（设计 px）；w/h 同时提供时覆盖 size 档位。 */
    w?: number;
    h?: number;
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

const tileStyle = computed(() =>
  props.w !== undefined && props.h !== undefined
    ? { width: `${props.w}px`, height: `${props.h}px` }
    : undefined,
);
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
    :style="tileStyle"
    mode="aspectFit"
    :aria-label="label"
    @click="emit('click')"
  />
</template>

<style scoped lang="scss">
/** 牌面比例 3:4；圆角跟随素材（约 12%），drop-shadow 跟随 alpha。 */
.mj-tile {
  display: block;
  flex: 0 0 auto;
  border-radius: 12%;
  background: transparent;
  filter: drop-shadow(0 2px 3px $ftl-color-mj-shadow);
  transition: transform 0.08s, box-shadow 0.08s, filter 0.08s;
}
.mj-tile--sm {
  width: 34px;
  height: 45px;
}
.mj-tile--md {
  width: 46px;
  height: 61px;
}
.mj-tile--lg {
  width: 60px;
  height: 80px;
}
.mj-tile--selected {
  transform: translateY(calc(-1 * var(--mj-tile-lift, 10px)));
  box-shadow: 0 0 0 $ftl-hairline $ftl-color-mj-gold;
  filter: drop-shadow(0 0 4px rgba($ftl-color-mj-gold, 0.65));
}
.mj-tile--disabled {
  /* 不可点击但仍要看清手牌（天月风亮桌面下 0.45 会洗白） */
  opacity: 0.85;
  cursor: default;
}
.mj-tile--dim {
  opacity: 0.5;
  filter: grayscale(0.6) drop-shadow(0 2px 3px $ftl-color-mj-shadow);
}
</style>

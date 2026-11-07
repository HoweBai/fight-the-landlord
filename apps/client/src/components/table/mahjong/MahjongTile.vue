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
    /**
     * `<image>` 裁切模式。
     * 默认 aspectFit 保持牌面比例；暗杠牌背传 aspectFill 填满方框。
     */
    mode?: 'aspectFit' | 'aspectFill';
  }>(),
  { size: 'md', selected: false, disabled: false, dim: false, mode: 'aspectFit' },
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
    :mode="mode"
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
/**
 * 所有档位等比例放大 1.3×（方案：2026-10-29 牌面尺寸升级）。
 * 原始素材 my=75×113 (0.664), top=55×84 (0.655), l/r=49×40 (1.225)。
 * 放大后容器撑满素材利用率 ~80%，改善当前手牌/弃牌/对手牌都偏小的问题。
 * 所有档位保持素材原始比例，仅缩放倍率不同档。
 */
.mj-tile--sm {
  width: 34px;
  height: 51px;
}
.mj-tile--md {
  width: 46px;
  height: 69px;
}
.mj-tile--lg {
  width: 60px;
  height: 90px;
}
/**
 * 牌面投影（2026-11-08 红金皮肤）：face-up 牌统一落影。
 * 牌背不挂 filter —— 对手整排牌背数量大，逐张投影在低端机上是持续合成开销。
 */
.mj-tile:not(.mj-tile--back) {
  filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.45));
}
.mj-tile--selected {
  transform: translateY(calc(-1 * var(--mj-tile-lift, 10px)));
  box-shadow: 0 0 0 2px $ftl-color-mj-gold, 0 6px 12px rgba(0, 0, 0, 0.4);
}
.mj-tile--disabled {
  opacity: 0.45;
}
.mj-tile--dim {
  opacity: 0.5;
}
/**
 * 置灰必须**合并**投影：单独写 `filter: grayscale(.6)` 会把 face-up 的 drop-shadow
 * 整个覆盖掉（filter 不是叠加属性）⇒ 置灰牌反而比正常牌更“浮”。
 * 选择器重复 `.mj-tile:not(.mj-tile--back)` 提高权重以压过上面的 face-up 规则；
 * 牌背 + 置灰仍不挂 filter（性能）。
 */
.mj-tile:not(.mj-tile--back).mj-tile--dim {
  filter: grayscale(.6) drop-shadow(0 2px 2px rgba(0, 0, 0, 0.45));
}
/**
 * top 方向素材 55×84 (0.655) 与 my 方向 75×113 (0.664) 比例有差，
 * 竖置牌（非横置）需要独立容器尺寸避免 aspectFit letterbox。
 * 牌背同样跳过（四个方向同一张 83×125 图）。
 * 放大后保持各自素材原始比例。
 */
.mj-tile--dir-top:not(.mj-tile--back) {
  &.mj-tile--sm { width: 33px; height: 50px; }
  &.mj-tile--md { width: 45px; height: 69px; }
  &.mj-tile--lg { width: 59px; height: 90px; }
}
/**
 * left/right 方向的牌面素材是横置（49×40，宽>高），容器需按横牌比例调整。
 * 牌背（.mj-tile--back）图是竖的，四个方向都是同一张，所以保持默认竖牌容器尺寸。
 */
.mj-tile--dir-left:not(.mj-tile--back),
.mj-tile--dir-right:not(.mj-tile--back) {
  &.mj-tile--sm { width: 51px; height: 42px; }
  &.mj-tile--md { width: 66px; height: 54px; }
  &.mj-tile--lg { width: 88px; height: 72px; }
}
</style>

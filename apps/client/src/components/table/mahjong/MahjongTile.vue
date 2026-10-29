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
/** 旋转方向：给 SeatPanel 内的 Tile 用。left=rotate(-90°) 朝右 / right=rotate(90°) 朝左。 */
type Rotate = 'left' | 'right';

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
    /**
     * 左/右家竖排旋转模式：
     * - 强制用 my/ 竖置正立素材（left/right 目录 49×40 横置素材在旋转后字会倒）
     * - DOM 宽高先交换（竖→横），再 transform rotate → flex 横排 → 视觉竖排
     * - margin-left 在 rotate 后自然变成纵向重叠，overlap 数值不用额外调
     */
    rotate?: Rotate;
  }>(),
  { size: 'md', selected: false, disabled: false, dim: false },
);

const emit = defineEmits<{ (e: 'click'): void }>();

const SUIT_FILES = ['wan', 'tong', 'tiao'] as const;

const src = computed(() => {
  const base = '/pages/table/static/mahjong/';
  // rotate 模式强制用 my/ 竖置正立素材（left/right 横置素材 rotate 后字会倒）
  const dir = props.rotate ? 'my/' : `${props.direction ?? 'my'}/`;
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
      rotate ? `mj-tile--rotate-${rotate}` : null,
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
 * 但牌背（.mj-tile--back）图是竖的（83×125），四个方向都是同一张，
 * 所以保持默认竖牌容器尺寸，不走这个 override。
 *
 * ⚠️ rotate 模式优先于 dir-left/right override：
 * 当同时传 direction='left'/'right' 且 rotate 也有值时，rotate override
 * 在 CSS 里排在后面（更具体的复合选择器），会覆盖这里的横牌尺寸。
 */
.mj-tile--dir-left:not(.mj-tile--back),
.mj-tile--dir-right:not(.mj-tile--back) {
  &.mj-tile--sm { width: 51px; height: 42px; }
  &.mj-tile--md { width: 66px; height: 54px; }
  &.mj-tile--lg { width: 88px; height: 72px; }
}

/**
 * ── 左/右家竖排旋转模式 ──────────────────────────────────────────
 * 核心原理：
 *   DOM 先从竖牌 (w<h) 交换成横牌 (w>h) → flex 横排时横向堆叠，
 *   再用 transform rotate(±90°) 视觉上变成竖牌纵向堆叠。
 *   margin-left overlap 在 rotate 后自然变成纵向重叠，overlap 数值不用额外调。
 *
 *   left → rotate(-90°) 朝右（朝中心）
 *   right → rotate(90°) 朝左（朝中心）
 *
 * 为什么要用 my/ 目录竖置正立素材？
 *   因为 left/right 目录 49×40 横置素材牌面字也是正立的，rotate 90° 后字会倒。
 *   用 my/ 竖置正立素材 + rotate，牌面字跟着自然旋转到正确方位。
 * ────────────────────────────────────────────────────────────────
 */
.mj-tile--rotate-left,
.mj-tile--rotate-right {
  transform-origin: center center;
  // 牌背也跟着转（背图 83×125 竖置，交换后 DOM 横牌）
}
// DOM 宽高交换：竖牌 (w<h) → 横牌 (w>h)，交换后宽度=原高度、高度=原宽度
.mj-tile--rotate-left.mj-tile--sm, .mj-tile--rotate-right.mj-tile--sm { width: 51px; height: 34px; }
.mj-tile--rotate-left.mj-tile--md, .mj-tile--rotate-right.mj-tile--md { width: 69px; height: 46px; }
.mj-tile--rotate-left.mj-tile--lg, .mj-tile--rotate-right.mj-tile--lg { width: 90px; height: 60px; }

// 旋转方向：left 朝右 / right 朝左
.mj-tile--rotate-left  { transform: rotate(-90deg); }
.mj-tile--rotate-right { transform: rotate(90deg);  }
</style>

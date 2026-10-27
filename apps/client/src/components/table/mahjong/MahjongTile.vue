<script setup lang="ts">
/**
 * 单张麻将牌（哑组件）。只把 `Tile` 翻译成牌面素材路径。
 *
 * 素材：幼麟棋牌 `Z_my`/`Z_bottom` 图集提取（75×113，万/筒/条 1–9 共 27 张 + 牌背），
 * 见 `THIRD-PARTY-NOTICES.md`。牌面路径是**纯展示映射**，不含任何规则判定。
 */
import { computed } from 'vue';
import { MAHJONG_SUIT_NAMES, type Tile } from '@fight-the-landlord/protocol';

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
  }>(),
  { size: 'md', selected: false, disabled: false, dim: false },
);

const emit = defineEmits<{ (e: 'click'): void }>();

const SUIT_FILES = ['wan', 'tong', 'tiao'] as const;

const src = computed(() => {
  if (props.back || !props.tile) return '/pages/table/static/mahjong/back.png';
  const suit = SUIT_FILES[props.tile.s];
  return `/pages/table/static/mahjong/${suit}-${props.tile.r}.png`;
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
      {
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
  background: rgba(255, 255, 255, 0.9);
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
</style>

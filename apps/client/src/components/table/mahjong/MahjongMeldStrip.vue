<script setup lang="ts">
/**
 * 副露条（哑组件）：一组或多组碰/杠/暗杠，横排或竖排。
 * 只渲染 props；pop 动画由父组件增量判定后传入，播完上抛 key。
 * 空副露不渲染根（避免空绝对定位元素吃点击）。
 */
import { computed } from 'vue';
import type { MahjongMeldView } from '@fight-the-landlord/protocol';
import MahjongMeld from './MahjongMeld.vue';

type Direction = 'my' | 'top' | 'left' | 'right';

const props = defineProps<{
  melds: Array<{ key: string; meld: MahjongMeldView; pop: boolean }>;
  direction: Direction;
  tileW: number;
  tileH: number;
  overlap: number;
  groupGap: number;
  layout: 'row' | 'column';
  /** 组在条带内的贴靠方向：对家两翼贴住牌背（左翼 end / 右翼 start），其余居中。 */
  justify?: 'start' | 'center' | 'end';
}>();

const emit = defineEmits<{ (e: 'pop-done', key: string): void }>();

const MELD_LABEL: Record<MahjongMeldView['kind'], string> = {
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
};

const stripStyle = computed<Record<string, string>>(() => ({
  display: 'flex',
  flexDirection: props.layout === 'column' ? 'column' : 'row',
  alignItems: 'center',
  justifyContent:
    props.justify === 'start'
      ? 'flex-start'
      : props.justify === 'end'
        ? 'flex-end'
        : 'center',
  gap: `${props.groupGap}px`,
}));
</script>

<template>
  <view
    v-if="melds.length > 0"
    class="mj-strip"
    :class="`mj-strip--${layout}`"
    :style="stripStyle"
  >
    <view v-for="m in melds" :key="m.key" class="mj-strip__group">
      <text class="mj-strip__label">{{ MELD_LABEL[m.meld.kind] }}</text>
      <MahjongMeld
        :meld="m.meld"
        :direction="direction"
        :tile-w="tileW"
        :tile-h="tileH"
        :overlap="overlap"
        :pop="m.pop"
        @pop-done="emit('pop-done', m.key)"
      />
    </view>
  </view>
</template>

<style scoped lang="scss">
.mj-strip {
  box-sizing: border-box;
}
.mj-strip__group {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mj-strip__label {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  padding: 0 3px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba($ftl-color-on-primary, 0.85);
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
}
</style>

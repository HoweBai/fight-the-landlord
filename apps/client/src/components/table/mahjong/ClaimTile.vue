<script setup lang="ts">
/**
 * Claim 窗口独立组件。展示 claimsForMe 选项，胡候选按番数降序。
 * 只替换 Board.vue phase==='claim' 的按钮块，不动 play 窗口自摸胡/杠。
 *
 * Batch 3 闸纪律：
 *   - 胡候选用 opt.claim === 'hu'（不是 opt.kind），阻断 B1 修法
 *   - 多番防御式拷贝 sort（不 mutate service 原数组），高项 H5 处置
 *   - claim 响应**不造独立倒计时**（阻断 B4 砍掉，Board.vue 无 turnDeadline）
 */
import { computed } from 'vue';
import type { MahjongClaimOption } from '@fight-the-landlord/protocol';

const props = withDefaults(defineProps<{
  options: MahjongClaimOption[];
  busy?: boolean;
  showPass?: boolean;
  /** Batch 4 A 组：弃牌点击后 Board.vue 传入的过滤结果。传入则优先使用。 */
  filteredOptions?: MahjongClaimOption[];
}>(), { busy: false, showPass: true });

const emit = defineEmits<{
  (e: 'claim', opt: MahjongClaimOption): void;
  (e: 'pass'): void;
}>();

/** 多胡候选按番数降序（防御式拷贝 sort，不 mutate service 原数组）。
 *  Batch 4 A 组：优先用 filteredOptions（弃牌点击过滤结果）。 */
const sortedOptions = computed(() => {
  const source = props.filteredOptions ?? props.options;
  return [...source].sort((a, b) => (b.fan ?? 0) - (a.fan ?? 0));
});

/** claim 候选 label：用 opt.claim 四值（hu/gang/peng/pass），不是 opt.kind（阻断 B1 修法）。 */
function claimLabel(opt: MahjongClaimOption): string {
  switch (opt.claim) {
    case 'peng': return '碰';
    case 'gang': return '杠'; // 暗杠/补杠区分逻辑留在 Board.vue（现有 L192-196）
    case 'hu':   return opt.fan ? `${opt.fan} 番胡` : '胡';
    case 'pass': return '过';
  }
}

function optClass(opt: MahjongClaimOption): string {
  if (opt.claim === 'hu') return 'mj-claim-tile__opt--hu';
  if (opt.claim === 'gang') return 'mj-claim-tile__opt--gang';
  return '';
}
</script>

<template>
  <view class="mj-claim-tile anim-claim-pulse">
    <text class="mj-claim-tile__prompt">可响应</text>
    <view class="mj-claim-tile__opts">
      <button
        v-for="(opt, i) in sortedOptions"
        :key="i"
        class="btn mj-claim-tile__opt"
        :class="optClass(opt)"
        :disabled="busy"
        @click="emit('claim', opt)"
      >
        {{ claimLabel(opt) }}
      </button>
      <button
        v-if="showPass"
        class="btn mj-claim-tile__pass"
        :disabled="busy"
        @click="emit('pass')"
      >过</button>
    </view>
  </view>
</template>

<style scoped lang="scss">
@import '../../../styles/animations.scss'; // 三层 ..，闸纪律

.mj-claim-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  border: 2px solid rgba($ftl-color-gold, 0.6);
  background: rgba($ftl-color-gold, 0.15);
}
.mj-claim-tile__prompt {
  font-size: $ftl-font-sm;
  color: $ftl-color-gold;
  font-weight: 600;
  text-align: center;
}
.mj-claim-tile__opts {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
}
.mj-claim-tile__opt--hu {
  background: rgba($ftl-color-gold, 0.4) !important;
  border-color: $ftl-color-gold-deep !important;
}
.mj-claim-tile__opt--gang {
  background: rgba($ftl-color-gold, 0.25) !important;
}
.mj-claim-tile__pass {
  opacity: 0.6;
}
</style>

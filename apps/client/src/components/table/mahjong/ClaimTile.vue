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

.ftl-btn-base { @include ftl-btn; }
.mj-claim-tile {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border-radius: $ftl-radius-md;
  border: 2px solid rgba($ftl-color-gold, 0.7);
  background: linear-gradient(180deg, rgba(30, 60, 40, 0.82), rgba(20, 45, 30, 0.88));
  backdrop-filter: blur(12px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45), inset 0 $ftl-hairline 0 rgba(255, 200, 100, 0.15);
}
.mj-claim-tile__prompt {
  font-size: $ftl-font-sm;
  color: $ftl-color-gold;
  font-weight: 700;
  text-align: center;
  letter-spacing: 2px;
}
.mj-claim-tile__opts {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
}

// —— 按钮（参考斗地主 btn / btn--primary 风格）——
.btn {
  @include ftl-btn;
  // 次按钮（碰/杠）：暖色金边 + 金色投影，比默认灰按钮更有存在感
  min-width: 72px;
  min-height: 52px;
  padding: 0 $ftl-space-4;
  font-size: $ftl-font-md;
  border-color: rgba($ftl-color-gold, 0.55);
  border-radius: $ftl-radius-md;
  background: linear-gradient(180deg, rgba(60, 110, 75, 0.85), rgba(35, 75, 50, 0.9));
  color: rgba($ftl-color-on-primary, 0.92);
  box-shadow:
    0 4px 0 rgba(0, 0, 0, 0.35),
    0 6px 14px rgba(0, 0, 0, 0.35),
    inset 0 2px 0 rgba(255, 220, 120, 0.25);
  transition: transform 0.08s, box-shadow 0.08s;
  &:hover {
    border-color: $ftl-color-gold;
    color: $ftl-color-on-primary;
  }
  &:active {
    transform: translateY(2px);
    box-shadow: 0 2px 0 rgba(0, 0, 0, 0.3), inset 0 2px 4px rgba(0, 0, 0, 0.35);
  }
}

// 胡（主按钮）：完全继承斗地主 btn--primary 金色立体
.mj-claim-tile__opt--hu {
  border-color: $ftl-color-gold-deep !important;
  background: $ftl-color-gold !important;
  color: $ftl-color-on-primary !important;
  box-shadow:
    0 6px 0 $ftl-color-gold-deep,
    0 10px 22px rgb(255 152 0 / 0.5),
    inset 0 2px 0 rgb(255 255 255 / 0.65),
    inset 0 -2px 0 rgb(0 0 0 / 0.1) !important;
}
.mj-claim-tile__opt--hu:active {
  transform: translateY(4px);
  box-shadow:
    0 2px 0 $ftl-color-gold-deep,
    0 4px 10px rgb(255 152 0 / 0.35),
    inset 0 3px 8px rgb(0 0 0 / 0.2) !important;
}

// 杠（次按钮加强）：在基础上叠金色渐变
.mj-claim-tile__opt--gang {
  background: linear-gradient(180deg, rgba(120, 100, 50, 0.9), rgba(75, 60, 30, 0.95)) !important;
  border-color: rgba($ftl-color-gold, 0.75) !important;
  color: $ftl-color-gold-light !important;
}

// 过：弱化处理，透明度降低 + 边框变淡 + 浅灰底
.mj-claim-tile__pass {
  opacity: 0.55;
  border-color: rgba(140, 150, 170, 0.35) !important;
  background: linear-gradient(180deg, rgba(70, 80, 95, 0.5), rgba(45, 55, 70, 0.6)) !important;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.25), inset 0 $ftl-hairline 0 rgba(255, 255, 255, 0.05) !important;
  color: rgba($ftl-color-on-primary, 0.6) !important;
}

.btn[disabled] {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none !important;
  filter: grayscale(0.4);
}
</style>

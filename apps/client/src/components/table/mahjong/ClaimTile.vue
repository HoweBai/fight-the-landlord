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
import MahjongTile from './MahjongTile.vue';

const props = withDefaults(defineProps<{
  options: MahjongClaimOption[];
  busy?: boolean;
  showPass?: boolean;
  /** Batch 4 A 组：弃牌点击后 Board.vue 传入的过滤结果。传入则优先使用。 */
  filteredOptions?: MahjongClaimOption[];
  /** 顶部牌面预览尺寸（真源 layout.centerTiles.claim）。 */
  previewW?: number;
  previewH?: number;
}>(), { busy: false, showPass: true, previewW: 34, previewH: 45 });

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

/** 预览优先过滤结果（非空）；过滤为空时回退全量，避免丢“响应哪张”的锚点。 */
const previewTile = computed(() => {
  const source = props.filteredOptions?.length ? props.filteredOptions : props.options;
  return source.find((o) => o.tile !== undefined)?.tile ?? null;
});

/** claim 候选 label：用 opt.claim 四值（hu/gang/peng/pass），不是 opt.kind（阻断 B1 修法）。 */
function claimLabel(opt: MahjongClaimOption): string {
  switch (opt.claim) {
    case 'peng': return '碰';
    case 'gang': return '杠'; // 暗杠/补杠区分逻辑留在 Board.vue（现有 L192-196）
    case 'hu':   return '胡';
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
  <view class="mj-claim-tile mj-claim-tile--panel anim-claim-pulse">
    <view v-if="previewTile" class="mj-claim-tile__preview">
      <text class="mj-claim-tile__prompt">可响应</text>
      <MahjongTile :tile="previewTile" :w="previewW" :h="previewH" direction="my" />
    </view>
    <text v-else class="mj-claim-tile__prompt">可响应</text>
    <view class="mj-claim-tile__opts">
      <button
        v-for="(opt, i) in sortedOptions"
        :key="i"
        class="btn mj-claim-tile__opt"
        :class="optClass(opt)"
        :disabled="busy"
        @click="emit('claim', opt)"
      >
        <text class="mj-claim-tile__opt-label">{{ claimLabel(opt) }}</text>
        <text v-if="opt.claim === 'hu' && opt.fan" class="mj-claim-tile__fan">{{ opt.fan }}番</text>
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
  padding: 10px;
  border-radius: $ftl-radius-md;
  border: $ftl-hairline solid rgba($ftl-color-mj-gold, 0.6);
  background: linear-gradient(180deg, $ftl-color-mj-panel-light, $ftl-color-mj-panel);
  backdrop-filter: blur(12px);
  box-shadow: 0 6px 20px rgba($ftl-color-mj-panel, 0.45), inset 0 $ftl-hairline 0 rgba($ftl-color-mj-gold, 0.2);
}
.mj-claim-tile__prompt {
  font-size: $ftl-font-sm;
  color: $ftl-color-mj-gold;
  font-weight: 700;
  text-align: center;
  letter-spacing: 2px;
}
.mj-claim-tile__preview {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 45px;
}
.mj-claim-tile__opts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  justify-items: stretch;
}
.mj-claim-tile__opt {
  flex-direction: column;
  min-width: 0;
  width: 100%;
}
.mj-claim-tile__opt-label {
  font-size: $ftl-font-md;
  line-height: 1;
}
.mj-claim-tile__fan {
  margin-top: 2px;
  font-size: $ftl-font-mj-mini;
  line-height: 1;
  color: $ftl-color-mj-on-gold;
}

// —— 按钮（参考斗地主 btn / btn--primary 风格）——
.btn {
  @include ftl-btn;
  // 次按钮（碰/杠）：暖色金边 + 金色投影，比默认灰按钮更有存在感
  min-width: 68px;
  min-height: $ftl-control-h;
  padding: 0 $ftl-space-4;
  font-size: $ftl-font-md;
  border-color: rgba($ftl-color-mj-gold, 0.55);
  border-radius: $ftl-radius-md;
  background: linear-gradient(
    180deg,
    rgba($ftl-color-mj-navy-light, 0.9),
    rgba($ftl-color-mj-navy, 0.95)
  );
  color: rgba($ftl-color-on-primary, 0.92);
  box-shadow:
    0 4px 0 rgba($ftl-color-mj-navy, 0.55),
    0 6px 14px rgba($ftl-color-mj-navy, 0.35),
    inset 0 $ftl-hairline 0 rgba($ftl-color-mj-gold, 0.22);
  transition: transform 0.08s, box-shadow 0.08s;
  &:hover {
    border-color: $ftl-color-mj-gold;
    color: $ftl-color-on-primary;
  }
  &:active {
    transform: translateY(2px);
    box-shadow: 0 2px 0 rgba($ftl-color-mj-navy, 0.5), inset 0 2px 4px rgba(0, 0, 0, 0.35);
  }
}

// 胡（主按钮）：金底 + 海军蓝文字（对比度 8.5:1）
.mj-claim-tile__opt--hu {
  border-color: $ftl-color-mj-gold-deep !important;
  background: $ftl-color-mj-gold !important;
  color: $ftl-color-mj-on-gold !important;
  box-shadow:
    0 6px 0 $ftl-color-mj-gold-deep,
    0 10px 22px rgba($ftl-color-mj-gold, 0.5),
    inset 0 $ftl-hairline 0 rgba(255, 255, 255, 0.65),
    inset 0 -2px 0 rgba(0, 0, 0, 0.1) !important;
}
.mj-claim-tile__opt--hu:active {
  transform: translateY(4px);
  box-shadow:
    0 2px 0 $ftl-color-mj-gold-deep,
    0 4px 10px rgba($ftl-color-mj-gold-deep, 0.35),
    inset 0 3px 8px rgba(0, 0, 0, 0.2) !important;
}

// 杠（次按钮加强）：金色渐变 + 海军蓝字（金底用深色字，对比度 ≥4.5）
.mj-claim-tile__opt--gang {
  background: linear-gradient(
    180deg,
    rgba($ftl-color-mj-gold, 0.35),
    rgba($ftl-color-mj-gold-deep, 0.55)
  ) !important;
  border-color: rgba($ftl-color-mj-gold, 0.75) !important;
  color: $ftl-color-mj-on-gold !important;
}

// 过：弱化处理
.mj-claim-tile__pass {
  opacity: 0.55;
  border-color: rgba($ftl-color-mj-muted, 0.35) !important;
  background: linear-gradient(
    180deg,
    rgba($ftl-color-mj-navy, 0.55),
    rgba($ftl-color-mj-navy, 0.7)
  ) !important;
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

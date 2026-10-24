<script setup lang="ts">
/**
 * 跑得快结算面板（S6.2 / spec §4.10.2）。
 *
 * 只渲染服务端 `PdkSettlementResult` 的字段：名次（winnerSeats）、剩余张数、倍数、
 * 炸弹数、关牌/春天/保本标记、分差与金币。**一个数都不算**。
 */
import { computed } from 'vue';
import type { PdkSettlementResult } from '@fight-the-landlord/protocol';
import { useGameStore } from '../stores/game';
import { GOLD_FREEZE_MS, useGoldColumnFreeze } from '../composables/useGoldColumnFreeze';
import Panel from './Panel.vue';

const props = defineProps<{
  settlement: PdkSettlementResult;
  settlementReceivedAt?: number;
}>();

const emit = defineEmits<{ (e: 'again'): void; (e: 'back'): void }>();
const store = useGameStore();

const showGold = computed(
  () => store.settlementBalances !== null || Object.keys(store.seatBalances).length > 0,
);
const goldFreezeDelayMs =
  props.settlementReceivedAt === undefined
    ? GOLD_FREEZE_MS
    : Math.min(
        GOLD_FREEZE_MS,
        Math.max(0, GOLD_FREEZE_MS - (Date.now() - props.settlementReceivedAt)),
      );
const goldFrozen = useGoldColumnFreeze({
  active: showGold,
  arrived: computed(() => store.settlementBalances !== null),
  delayMs: goldFreezeDelayMs,
});
function goldCell(seat: number): string {
  const balances = store.settlementBalances;
  if (balances !== null) {
    const value = balances[seat];
    return value === undefined ? '—' : String(value);
  }
  return goldFrozen.value ? '—' : '结算中…';
}

const rows = computed(() =>
  [...props.settlement.scoreChanges].sort((a, b) => a.seat - b.seat),
);
const winners = computed(() => new Set(props.settlement.winnerSeats));

function nameOf(seat: number): string {
  if (seat === store.mySeat) return '我';
  return store.seatNickname(seat) || `玩家${seat}`;
}
function isMe(seat: number): boolean {
  return seat === store.mySeat;
}
</script>

<template>
  <Panel class="pdk-settlement anim-settlement-in" variant="blue">
    <view class="pdk-settlement__head">
      <text class="pdk-settlement__title">本局结算</text>
      <text class="pdk-settlement__sub">
        底分 {{ settlement.baseScore }} · 倍数 {{ settlement.multiplier }} · 炸弹
        {{ settlement.bombCount }}
      </text>
      <view class="pdk-settlement__tags">
        <text v-if="settlement.guan" class="pdk-settlement__tag">关牌</text>
        <text v-if="settlement.spring" class="pdk-settlement__tag">春天</text>
        <text v-if="settlement.baobenSeats.length > 0" class="pdk-settlement__tag">保本</text>
      </view>
    </view>

    <table class="pdk-settlement__table">
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.seat"
          class="pdk-settlement__row"
          :class="{
            'pdk-settlement__row--me': isMe(row.seat),
            'pdk-settlement__row--winner': winners.has(row.seat),
          }"
        >
          <td class="pdk-settlement__row-name" width="140">{{ nameOf(row.seat) }}</td>
          <td class="pdk-settlement__row-rank" width="100">{{
            winners.has(row.seat) ? "第 1 名" : ""
          }}</td>
          <td class="pdk-settlement__row-remaining" width="140">剩余 {{ settlement.remaining[row.seat] ?? 0 }} 张</td>
          <td class="pdk-settlement__delta" width="80">{{
            row.delta > 0 ? `+${row.delta}` : String(row.delta)
          }}</td>
          <td v-if="showGold" class="pdk-settlement__gold" width="100">{{ goldCell(row.seat) }}</td>
        </tr>
      </tbody>
    </table>

    <view class="pdk-settlement__actions">
      <button type="button" class="btn btn--primary pdk-settlement__again" @click="emit('again')">
        再来一局
      </button>
      <button type="button" class="btn pdk-settlement__lobby" @click="emit('back')">
        返回大厅
      </button>
    </view>
  </Panel>
</template>

<style scoped lang="scss">
@import "../styles/animations.scss";

/**
 * 结算面板居中浮层（仿 Settlement.vue 的正确写法）。
 *
 * ⚠️ 不能用 `top:50% + left:50% + transform:translate(-50%,-50%)` ——
 * `anim-settlement-in` 带 `animation-fill-mode: both`，动画会**一直持有最终的 transform**，
 * 覆盖掉 translate(-50%,-50%)，面板就跑到右下角去了。
 * ⇒ 用**不依赖 transform** 的居中法：`inset:0` + `margin:auto` + 确定宽度。
 */
.pdk-settlement {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 2;
  width: $ftl-settlement-w;
  max-width: calc(100% - #{$ftl-space-6});
  height: fit-content;
  max-height: calc(100% - #{$ftl-space-6});
  margin: auto;
  padding: $ftl-space-6;
  overflow-y: auto;
}
.pdk-settlement__head {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
  align-items: center;
}
.pdk-settlement__title {
  font-size: $ftl-font-xl;
  color: $ftl-color-gold-light;
  font-weight: 700;
}
.pdk-settlement__sub,
.pdk-settlement__tags {
  font-size: $ftl-font-md;
  color: $ftl-color-text-secondary;
}
.pdk-settlement__tags {
  display: flex;
  gap: $ftl-space-3;
}
.pdk-settlement__table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0 $ftl-space-2;
}
/**
 * 结算行：原生 HTML <table> + <td width> 绝对可靠。
 *
 * uni-app H5 的 <uni-view>/<uni-text> custom element 对 flex-basis、
 * grid-template-columns、inline style width 全部不可靠（computed 正确
 * 但布局引擎忽略）。HTML 原生 <table> 布局是浏览器级别的，任何框架无法过滤。
 */
.pdk-settlement__row {
  font-size: $ftl-font-md;
}
.pdk-settlement__row td {
  padding: $ftl-space-3 $ftl-space-2;
  border-radius: $ftl-radius-sm;
  white-space: nowrap;
}
.pdk-settlement__row--me td {
  background: rgb(255 255 255 / 8%);
}
.pdk-settlement__row--winner .pdk-settlement__row-name {
  color: $ftl-color-gold-light;
}
.pdk-settlement__row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdk-settlement__row-rank {
  color: $ftl-color-gold-light;
  font-weight: 700;
}
.pdk-settlement__row-remaining {
  text-align: center;
  font-size: $ftl-font-sm;
  color: $ftl-color-text-secondary;
}
.pdk-settlement__delta {
  text-align: right;
  font-weight: 700;
}
.pdk-settlement__gold {
  text-align: right;
}
.pdk-settlement__actions {
  display: flex;
  justify-content: center;
  gap: $ftl-space-4;
}
.btn {
  @include ftl-btn;
  /* 次按钮：冷灰玻璃底 + 弱化白字（同 Settlement.vue）。
     ⚠️ ftl-btn 默认 color: $ftl-color-text（深黑）在深蓝面板上对比度为 0 ——
        必须覆盖成弱化白字 + 冷灰玻璃底，才能在深色面板上看清。 */
  border-color: rgba(160, 170, 190, 0.5);
  border-radius: $ftl-radius-md;
  background: linear-gradient(180deg, rgba(120, 130, 150, 0.35), rgba(80, 90, 110, 0.5));
  color: rgba($ftl-color-on-primary, 0.7);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25), inset 0 2px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
  transition: transform 0.1s, box-shadow 0.1s, border-color 0.15s;
  background-image: none;
  &:hover {
    border-color: rgba(180, 190, 210, 0.7);
    color: rgba($ftl-color-on-primary, 0.85);
  }
  &:active {
    transform: translateY(2px);
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.3);
  }
}
.btn--primary {
  border-color: $ftl-color-gold-deep;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
  border-radius: $ftl-radius-md;
  box-shadow:
    0 6px 0 $ftl-color-gold-deep,
    0 8px 20px rgb(255 152 0 / 0.45),
    inset 0 2px 0 rgb(255 255 255 / 0.6),
    inset 0 -2px 0 rgb(0 0 0 / 0.1);
  transition: transform 0.1s, box-shadow 0.1s;
  background-image: none;
  &:hover {
    transform: translateY(-2px);
  }
  &:active {
    transform: translateY(4px);
    box-shadow:
      0 2px 0 $ftl-color-gold-deep,
      0 4px 8px rgb(255 152 0 / 0.35),
      inset 0 2px 4px rgba(0, 0, 0, 0.2);
  }
}
</style>

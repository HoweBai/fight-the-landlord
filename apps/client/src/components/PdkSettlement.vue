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
const baoben = computed(() => new Set(props.settlement.baobenSeats));

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

    <view class="pdk-settlement__table">
      <view
        v-for="row in rows"
        :key="row.seat"
        class="pdk-settlement__row"
        :class="{
          'pdk-settlement__row--me': isMe(row.seat),
          'pdk-settlement__row--winner': winners.has(row.seat),
        }"
      >
        <text class="pdk-settlement__row-name">{{ nameOf(row.seat) }}</text>
        <text class="pdk-settlement__row-rank">{{
          winners.has(row.seat) ? "第 1 名" : ""
        }}</text>
        <text class="pdk-settlement__row-remaining">
          剩余 {{ settlement.remaining[row.seat] ?? 0 }} 张
        </text>
        <text v-if="baoben.has(row.seat)" class="pdk-settlement__row-baoben">保本</text>
        <text class="pdk-settlement__delta">{{
          row.delta > 0 ? `+${row.delta}` : String(row.delta)
        }}</text>
        <text v-if="showGold" class="pdk-settlement__gold">{{ goldCell(row.seat) }}</text>
      </view>
    </view>

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

.pdk-settlement {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-4;
  min-width: 520px;
  padding: $ftl-space-6;
  transform: translate(-50%, -50%);
}
.pdk-settlement__head {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
  align-items: center;
}
.pdk-settlement__title {
  font-size: $ftl-font-lg;
  color: $ftl-color-gold-light;
}
.pdk-settlement__sub,
.pdk-settlement__tags {
  font-size: $ftl-font-sm;
  color: $ftl-color-text-secondary;
}
.pdk-settlement__tags {
  display: flex;
  gap: $ftl-space-3;
}
.pdk-settlement__table {
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
}
.pdk-settlement__row {
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
  padding: $ftl-space-2 $ftl-space-3;
  border-radius: $ftl-radius-md;
}
.pdk-settlement__row--me {
  background: rgb(255 255 255 / 8%);
}
.pdk-settlement__row--winner .pdk-settlement__row-name {
  color: $ftl-color-gold-light;
}
.pdk-settlement__row-name {
  min-width: 96px;
}
.pdk-settlement__row-rank {
  min-width: 64px;
  color: $ftl-color-gold-light;
}
.pdk-settlement__row-remaining,
.pdk-settlement__row-baoben {
  font-size: $ftl-font-sm;
  color: $ftl-color-text-secondary;
}
.pdk-settlement__delta {
  margin-left: auto;
  font-weight: 700;
}
.pdk-settlement__gold {
  min-width: 96px;
  text-align: right;
}
.pdk-settlement__actions {
  display: flex;
  justify-content: center;
  gap: $ftl-space-4;
}
.btn {
  @include ftl-btn;
}
.btn--primary {
  border-color: $ftl-color-gold-deep;
  background: $ftl-color-gold;
  color: $ftl-color-on-primary;
}
</style>

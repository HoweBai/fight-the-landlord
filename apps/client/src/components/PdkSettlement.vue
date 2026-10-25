<script setup lang="ts">
/**
 * 跑得快结算面板（S6.2 / spec §4.10.2）。
 *
 * 只渲染服务端 `PdkSettlementResult` 的字段：名次（winnerSeats）、剩余张数、倍数、
 * 炸弹数、关牌/春天标记、分差与金币。**一个数都不算**。
 *
 * 2026-10-25 视觉对齐 Settlement.vue：绶带 + headline + 公式行 + flex:1 按钮 + 表头行。
 * 2026-10-25 修复：Grid→Flex（gap 额外占位导致分差截断），补全所有行名次，表头内容对齐。
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

/**
 * 名次映射：按剩余张数升序（剩 0 张 = 第 1 名）。
 * **纯展示映射**——跑得快无平局，服务端给了 remaining，这里只是把它翻译成"第 N 名"的展示串。
 */
const ranks = computed(() => {
  const sorted = [...props.settlement.scoreChanges]
    .map((r) => r.seat)
    .sort(
      (a, b) => (props.settlement.remaining[a] ?? 0) - (props.settlement.remaining[b] ?? 0),
    );
  const map = new Map<number, number>();
  sorted.forEach((seat, i) => map.set(seat, i + 1));
  return map;
});

function nameOf(seat: number): string {
  if (seat === store.mySeat) return '我';
  return store.seatNickname(seat) || `玩家${seat}`;
}
function isMe(seat: number): boolean {
  return seat === store.mySeat;
}

/**
 * headline 内容：身份映射，不是规则判断（与 Settlement.vue 的 mySeatResult 同款）。
 * won = 我在不在 winnerSeats 里（服务端给的胜负集合）
 * delta = 服务端给的 scoreChanges 里找我的那一行
 */
const myHeadline = computed<{ won: boolean; delta: number } | null>(() => {
  const mine = store.mySeat;
  if (mine === null) return null;
  const row = props.settlement.scoreChanges.find((r) => r.seat === mine);
  if (!row) return null;
  return { won: winners.value.has(mine), delta: row.delta };
});
</script>

<template>
  <Panel class="pdk-settlement anim-settlement-in" variant="blue">
    <!-- 绶带标题带 -->
    <view class="pdk-settlement__head">
      <view class="pdk-settlement__ribbon">
        <text class="pdk-settlement__title">结算</text>
      </view>
    </view>

    <!-- headline：你赢/输 + 分差 -->
    <text class="pdk-settlement__headline">
      <template v-if="myHeadline !== null">
        {{ myHeadline.won ? '你赢了' : '你输了' }} {{
          myHeadline.delta > 0 ? `+${myHeadline.delta}` : myHeadline.delta
        }}
      </template>
      <template v-else>{{ winners.size > 0 ? '赢家已产生' : '本局结束' }}</template>
    </text>

    <wd-divider />

    <!-- 表格：Flex + flex:1 等分列（与 Settlement.vue 同款） -->
    <view class="pdk-settlement__table">
      <!-- 表头行 -->
      <view class="pdk-settlement__tr pdk-settlement__tr--head">
        <text class="pdk-settlement__th pdk-settlement__th--name">昵称</text>
        <text class="pdk-settlement__th pdk-settlement__th--rank">名次</text>
        <text class="pdk-settlement__th pdk-settlement__th--remaining">剩余</text>
        <text class="pdk-settlement__th pdk-settlement__th--delta">分差</text>
        <text v-if="showGold" class="pdk-settlement__th pdk-settlement__th--gold">金币</text>
      </view>

      <!-- 数据行 -->
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
        <text class="pdk-settlement__row-rank">第 {{ ranks.get(row.seat) }} 名</text>
        <text class="pdk-settlement__row-remaining">{{ settlement.remaining[row.seat] ?? 0 }} 张</text>
        <text class="pdk-settlement__delta">{{
          row.delta > 0 ? `+${row.delta}` : String(row.delta)
        }}</text>
        <text v-if="showGold" class="pdk-settlement__gold">{{ goldCell(row.seat) }}</text>
      </view>
    </view>

    <!-- 公式行 -->
    <text class="pdk-settlement__formula">
      底分 {{ settlement.baseScore }} · 倍数 {{ settlement.multiplier }} · 炸弹 {{ settlement.bombCount }}
      <template v-if="settlement.guan"> · 关牌</template>
      <template v-if="settlement.spring"> · 春天</template>
    </text>

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
  display: flex;
  flex-direction: column;
  gap: $ftl-space-3;
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
  align-items: center;
  justify-content: center;
}
/** 绶带 9-slice（同 Settlement.vue 的 .settlement__ribbon 结构） */
.pdk-settlement__ribbon {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $ftl-space-2 $ftl-space-9;
  border-radius: $ftl-radius-sm;
  background-color: $ftl-color-accent;
  background-clip: padding-box;
  border-style: solid;
  border-color: transparent;
  border-width: 16px $ftl-ribbon-slice-x 12px $ftl-ribbon-slice-x;
  border-image: $ftl-art-settlement-ribbon 36 225 27 221 fill stretch;
  color: $ftl-color-on-primary;
}
.pdk-settlement__title {
  font-size: $ftl-font-lg;
  font-weight: 600;
  /* 9-slice 拱形素材的红色视觉中心高于 border-box 几何中心 ⇒ 上移 8px 补偿 */
  position: relative;
  top: -8px;
}
/** headline：橙色强调大字（同 Settlement.vue 的 .settlement__headline） */
.pdk-settlement__headline {
  display: block;
  margin: $ftl-space-3 0;
  color: $ftl-color-accent;
  font-size: $ftl-font-xxl;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
}

/* 表格：Flex 行 + flex:1 等分列（与 Settlement.vue 同款） */
.pdk-settlement__table {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: $ftl-space-4 auto;
}
.pdk-settlement__tr {
  display: flex;
  gap: $ftl-space-4;
  align-items: center;
}
.pdk-settlement__tr--head {
  padding: $ftl-space-3 $ftl-space-5;
}
/* 表头：全部 flex:1 等分，按列与内容共享 text-align */
.pdk-settlement__th {
  flex: 1 1 0;
  color: $ftl-color-text;
  font-size: $ftl-font-sm;
  font-weight: 600;
}
.pdk-settlement__th--name,
.pdk-settlement__row-name {
  text-align: left;
}
.pdk-settlement__th--rank,
.pdk-settlement__row-rank {
  text-align: left;
}
.pdk-settlement__th--remaining,
.pdk-settlement__row-remaining {
  text-align: center;
}
.pdk-settlement__th--delta,
.pdk-settlement__delta {
  text-align: right;
}
.pdk-settlement__th--gold,
.pdk-settlement__gold {
  text-align: right;
}

/* 数据行：Flex + gap + flex:1 等分（与表头共享列宽基线） */
.pdk-settlement__row {
  box-sizing: border-box;
  display: flex;
  gap: $ftl-space-4;
  align-items: center;
  padding: $ftl-space-4 $ftl-space-5;
  border-radius: $ftl-radius-sm;
  background: $ftl-color-surface-muted;
  font-size: $ftl-font-md;
}
/* 各列 flex:1 等分 */
.pdk-settlement__row-name,
.pdk-settlement__row-rank,
.pdk-settlement__row-remaining,
.pdk-settlement__delta,
.pdk-settlement__gold {
  flex: 1 1 0;
}
/** 我的行：警示底 + 强调色描边（同 Settlement.vue 的 --me） */
.pdk-settlement__row--me {
  background: $ftl-color-warn-bg;
  box-shadow: inset 0 0 0 $ftl-hairline $ftl-color-accent;
}
.pdk-settlement__row--winner .pdk-settlement__row-name {
  color: $ftl-color-gold-light;
}
.pdk-settlement__row-name {
  color: $ftl-color-text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdk-settlement__row-rank {
  color: $ftl-color-gold-light;
  font-weight: 700;
}
.pdk-settlement__row-remaining {
  font-size: $ftl-font-sm;
  color: $ftl-color-text-secondary;
}
.pdk-settlement__delta {
  color: $ftl-color-primary;
  font-weight: 600;
}
.pdk-settlement__gold {
  color: $ftl-color-primary;
  font-weight: 600;
}

/** 公式行：蓝底条（同 Settlement.vue 的 .settlement__formula） */
.pdk-settlement__formula {
  display: block;
  box-sizing: border-box;
  padding: $ftl-space-3 $ftl-space-5;
  border-radius: $ftl-radius-sm;
  background: $ftl-color-info-bg;
  color: $ftl-color-text-secondary;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}

/** 按钮：flex:1 均分宽度（同 Settlement.vue） */
.pdk-settlement__actions {
  display: flex;
  gap: $ftl-space-4;
  margin-top: $ftl-space-3;
}
.pdk-settlement__actions .btn {
  flex: 1 1 0;
}

.btn {
  @include ftl-btn;
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

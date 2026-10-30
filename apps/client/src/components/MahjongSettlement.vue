<script setup lang="ts">
/**
 * 四川麻将结算面板（完整版）。
 *
 * 只渲染服务端 `MahjongSettlementResult` 的字段。**一个数都不算**。
 */
import { computed } from 'vue';
import type { MahjongMeldView, MahjongScoreEvent, MahjongSettlementResult, Tile } from '@fight-the-landlord/protocol';
import { useGameStore } from '../stores/game';
import { GOLD_FREEZE_MS, useGoldColumnFreeze } from '../composables/useGoldColumnFreeze';
import Panel from './Panel.vue';
import MahjongTile from './table/mahjong/MahjongTile.vue';

const props = defineProps<{
  settlement: MahjongSettlementResult;
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
  if (goldFrozen.value) return '🔒 结算中…';
  return '结算中…';
}

/** 番型 emoji 映射表（纯展示）。 */
const FAN_EMOJI: Record<string, string> = {
  清一色: '🎴', 七对: '👯', 根: '🌳', 杠上开花: '💥',
  海底捞月: '🌙', 十三幺: '👻', 对对胡: '🃏', 平胡: '✨', 抢杠胡: '⚡',
};
function fanEmoji(name: string): string {
  return FAN_EMOJI[name] ?? '';
}

const rows = computed(() =>
  [...props.settlement.scoreChanges].sort((a, b) => a.seat - b.seat),
);
const winners = computed(() => new Set(props.settlement.winnerSeats));
const huazhu = computed(() => new Set(props.settlement.huazhuSeats));

/** 番型文本（从 hu 事件 fanDetails 构造）。 */
const fanBySeat = computed(() => {
  const map = new Map<number, string>();
  for (const d of props.settlement.fanDetails) {
    map.set(
      d.seat,
      d.items.length > 0
        ? d.items.map((item) => fanEmoji(item) + item).join('+')
        : `${d.fan} 番`,
    );
  }
  return map;
});

/** 胡牌类型小标：自摸 / 点炮 / 抢杠。抢杠用 items 里含"抢杠胡"关键字推导。 */
const huTypeBySeat = computed(() => {
  const map = new Map<number, { label: string; icon: string }>();
  for (const e of props.settlement.events) {
    if (e.kind !== 'hu') continue;
    const rob = e.items.some((item) => item.includes('抢杠胡'));
    if (rob) {
      map.set(e.seat, { label: '抢杠胡', icon: '⚡' });
    } else if (e.fromSeat === null) {
      map.set(e.seat, { label: '自摸', icon: '🌀' });
    } else {
      map.set(e.seat, { label: '点炮', icon: '💥' });
    }
  }
  return map;
});

/** 亮牌数据：胡牌者 + 花猪（若有 lackSuit），其他未胡者省略。 */
const revealedHandBySeat = computed(() => {
  const map = new Map<number, { tiles: Tile[]; huTile: Tile }>();
  for (const h of props.settlement.revealedHands ?? []) {
    map.set(h.seat, { tiles: h.tiles, huTile: h.huTile });
  }
  return map;
});

/** 副露按座位索引。 */
const meldsBySeatMap = computed(() => {
  const map = new Map<number, MahjongMeldView[]>();
  for (const m of props.settlement.meldsBySeat ?? []) {
    map.set(m.seat, m.melds);
  }
  return map;
});

/** 定缺花色按座位索引。 */
const lackSuitBySeat = computed(() => {
  const arr = props.settlement.lackSuits ?? [];
  return (seat: number): number | null => arr[seat] ?? null;
});

function nameOf(seat: number): string {
  if (seat === store.mySeat) return '我';
  return store.seatNickname(seat) || `玩家${seat}`;
}
function isMe(seat: number): boolean {
  return seat === store.mySeat;
}

const myHeadline = computed<{ won: boolean; delta: number; huazhu: boolean } | null>(() => {
  const mine = store.mySeat;
  if (mine === null) return null;
  const row = props.settlement.scoreChanges.find((r) => r.seat === mine);
  if (!row) return null;
  return {
    won: row.delta > 0,
    delta: row.delta,
    huazhu: huazhu.value.has(mine),
  };
});

/** 事件摘要（纯展示映射；不重算金额）。 */
const eventLines = computed<string[]>(() => {
  const lines: string[] = [];
  const evs: MahjongScoreEvent[] = props.settlement.events;
  for (const e of evs) {
    switch (e.kind) {
      case 'gang':
        lines.push(
          `杠：${nameOf(e.seat)} ${e.gang === 'concealed' ? '暗杠' : e.gang === 'added' ? '补杠' : '直杠'} +${e.payers.reduce((a, p) => a + p.amount, 0)}`,
        );
        break;
      case 'hu': {
        const rob = e.items.some((item) => item.includes('抢杠胡'));
        lines.push(
          `胡：${nameOf(e.seat)} ${e.items.length > 0 ? e.items.map(item => fanEmoji(item) + item).join('+') : `${e.fan} 番`}${rob ? '（抢杠胡）' : e.fromSeat === null ? '（自摸）' : `（点炮 ${nameOf(e.fromSeat)}）`}`,
        );
        break;
      }
      case 'chajiao':
        lines.push(`查叫：${nameOf(e.fromSeat)} → ${nameOf(e.toSeat)} ${e.amount}`);
        break;
      case 'transfer':
        lines.push(`呼叫转移：${nameOf(e.fromSeat)} → ${nameOf(e.toSeat)} ${e.amount}`);
        break;
      case 'refund':
        lines.push(
          `退税：${nameOf(e.fromSeat)} 退回 ${e.toSeats.map((t) => `${nameOf(t.seat)} ${t.amount}`).join('、')}`,
        );
        break;
      case 'huazhu':
        lines.push(`花猪：${nameOf(e.seat)} ${e.mode === 'burn48' ? '罚 48 归系统' : `付 ${e.payees.length} 家 各 ${e.amount}`}`);
        break;
      default:
        break;
    }
  }
  return lines;
});

/** 结束原因精确文本。 */
const endText = computed(() => {
  const r = props.settlement.endReason;
  if (r === 'threeWinners') return '三家胡牌';
  if (r === 'wallEmptyWithHu') return '摸最后一张自摸';
  return props.settlement.liuju ? '荒庄（牌墙摸空）' : '牌墙摸空';
});

/** 规则摘要：底分 / 封顶 / 自摸模式 / 花猪模式。 */
const rulesSummary = computed(() => {
  const r = props.settlement;
  const parts: string[] = [];
  parts.push(`底分 ${r.baseScore}`);
  if (r.rulesPreset) parts.push(r.rulesPreset === 'chengdu' ? '成都预设' : r.rulesPreset);
  return parts.join(' · ');
});
</script>

<template>
  <Panel class="mj-settlement anim-mj-settlement-in" variant="blue">
    <view class="mj-settlement__head">
      <view class="mj-settlement__ribbon">
        <text class="mj-settlement__title">结算</text>
      </view>
    </view>

    <text class="mj-settlement__headline">
      <template v-if="myHeadline !== null">
        <template v-if="myHeadline.huazhu">花猪 </template>
        <template v-else>{{ myHeadline.won ? '你赢了' : '你输了' }} </template>
        {{ myHeadline.delta > 0 ? `+${myHeadline.delta}` : myHeadline.delta }}
      </template>
      <template v-else>本局结束</template>
    </text>

    <wd-divider />

    <view class="mj-settlement__table">
      <view class="mj-settlement__tr mj-settlement__tr--head">
        <text class="mj-settlement__th mj-settlement__th--name">昵称</text>
        <text class="mj-settlement__th mj-settlement__th--fan">番型</text>
        <text class="mj-settlement__th mj-settlement__th--delta">分差</text>
        <text v-if="showGold" class="mj-settlement__th mj-settlement__th--gold">金币</text>
      </view>

      <template v-for="row in rows" :key="row.seat">
        <view
          class="mj-settlement__row"
          :class="{
            'mj-settlement__row--me': isMe(row.seat),
            'mj-settlement__row--winner': winners.has(row.seat),
          }"
        >
          <view class="mj-settlement__row-name-wrap">
            <text class="mj-settlement__row-name">{{ nameOf(row.seat) }}<template v-if="huazhu.has(row.seat)">（花猪）</template></text>
          </view>
          <view v-if="fanBySeat.get(row.seat) || huTypeBySeat.get(row.seat)" class="mj-settlement__row-fan-wrap">
            <text v-if="fanBySeat.get(row.seat)" class="mj-settlement__row-fan">{{ fanBySeat.get(row.seat) }}</text>
            <text v-if="huTypeBySeat.get(row.seat)" class="mj-settlement__hu-type">
              {{ huTypeBySeat.get(row.seat)!.icon }} {{ huTypeBySeat.get(row.seat)!.label }}
            </text>
          </view>
          <text
            class="mj-settlement__delta"
            :class="row.delta >= 0 ? 'mj-settlement__delta--pos' : 'mj-settlement__delta--neg'"
            >{{ row.delta > 0 ? `+${row.delta}` : String(row.delta) }}</text
          >
          <text v-if="showGold" class="mj-settlement__gold">{{ goldCell(row.seat) }}</text>
        </view>

        <!-- 亮牌区：胡牌者 + 花猪。默认都显示（内容空时不占空间）。 -->
        <view v-if="revealedHandBySeat.get(row.seat) || meldsBySeatMap.get(row.seat)?.length || huazhu.has(row.seat)" class="mj-settlement__hand">
          <!-- 胡牌者手牌（含胡牌张高亮） -->
          <template v-if="revealedHandBySeat.get(row.seat)">
            <text class="mj-settlement__hand-label">
              {{ nameOf(row.seat) }} 的手牌 <text class="mj-settlement__hand-hint">（{{ revealedHandBySeat.get(row.seat)!.tiles.length }} 张）</text>
            </text>
            <view class="mj-settlement__hand-row">
              <MahjongTile
                v-for="(t, idx) in revealedHandBySeat.get(row.seat)!.tiles"
                :key="`t-${idx}`"
                :tile="t"
                size="sm"
                direction="my"
                :class="{ 'mj-tile--hu': t.s === revealedHandBySeat.get(row.seat)!.huTile.s && t.r === revealedHandBySeat.get(row.seat)!.huTile.r }"
              />
            </view>
          </template>
          <!-- 花猪缺门牌定位提示 -->
          <text v-if="huazhu.has(row.seat)" class="mj-settlement__huazhu-hint">
            定缺花色：{{ lackSuitBySeat(row.seat) === 0 ? '万' : lackSuitBySeat(row.seat) === 1 ? '筒' : '条' }}
          </text>
          <!-- 副露（所有有副露的玩家都显示） -->
          <template v-if="meldsBySeatMap.get(row.seat)?.length">
            <text class="mj-settlement__hand-label">副露</text>
            <view class="mj-settlement__melds">
              <template v-for="(meld, mi) in meldsBySeatMap.get(row.seat)" :key="`m-${mi}`">
                <MahjongTile v-for="(t, ti) in meld.tiles" :key="`mt-${mi}-${ti}`" :tile="t" size="sm" direction="my" />
                <text v-if="mi < meldsBySeatMap.get(row.seat)!.length - 1" class="mj-settlement__meld-sep">+</text>
              </template>
            </view>
          </template>
        </view>
      </template>
    </view>

    <text class="mj-settlement__formula">
      {{ rulesSummary }} · {{ endText }}
      <template v-if="settlement.rakeTotal > 0"> · 抽水 {{ settlement.rakeTotal }}</template>
    </text>

    <view v-if="eventLines.length > 0" class="mj-settlement__events">
      <text v-for="(line, i) in eventLines" :key="`ev-${i}`" class="mj-settlement__event">
        {{ line }}
      </text>
    </view>

    <view v-if="settlement.writtenOff.length > 0" class="mj-settlement__events">
      <text v-for="(w, i) in settlement.writtenOff" :key="`wo-${i}`" class="mj-settlement__event">
        未收：{{ nameOf(w.seat) }} {{ w.amount }}（{{ w.reason }}）
      </text>
    </view>

    <view class="mj-settlement__actions">
      <button type="button" class="btn btn--primary mj-settlement__again" @click="emit('again')">
        再来一局
      </button>
      <button type="button" class="btn mj-settlement__lobby" @click="emit('back')">
        返回大厅
      </button>
    </view>
  </Panel>
</template>

<style scoped lang="scss">
@import "../styles/animations.scss";

.mj-settlement {
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
.mj-settlement__head {
  display: flex;
  align-items: center;
  justify-content: center;
}
.mj-settlement__ribbon {
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
.mj-settlement__title {
  font-size: $ftl-font-lg;
  font-weight: 600;
  position: relative;
  top: -8px;
}
.mj-settlement__headline {
  display: block;
  margin: $ftl-space-3 0;
  color: $ftl-color-accent;
  font-size: $ftl-font-xxl;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
}

.mj-settlement__table {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: $ftl-space-4 auto;
}
.mj-settlement__tr {
  display: flex;
  gap: $ftl-space-4;
  align-items: center;
}
.mj-settlement__tr--head {
  padding: $ftl-space-3 $ftl-space-5;
  border-radius: $ftl-radius-sm $ftl-radius-sm 0 0;
  background: rgba(255, 255, 255, 0.15);
  border-bottom: $ftl-hairline solid rgba(255, 255, 255, 0.15);
}
.mj-settlement__th {
  flex: 1 1 0;
  color: rgba($ftl-color-on-primary, 0.85);
  font-size: $ftl-font-sm;
  font-weight: 600;
}
.mj-settlement__th--name,
.mj-settlement__row-name {
  text-align: left;
}
.mj-settlement__th--fan,
.mj-settlement__row-fan,
.mj-settlement__th--delta,
.mj-settlement__delta {
  text-align: center;
}
.mj-settlement__th--gold,
.mj-settlement__gold {
  text-align: right;
}
.mj-settlement__row {
  box-sizing: border-box;
  display: flex;
  gap: $ftl-space-4;
  align-items: center;
  padding: $ftl-space-4 $ftl-space-5;
  background: rgba(255, 255, 255, 0.12);
  font-size: $ftl-font-md;
  border-bottom: $ftl-hairline solid rgba(255, 255, 255, 0.08);
}
.mj-settlement__row:last-child {
  border-bottom: none;
  border-radius: 0 0 $ftl-radius-sm $ftl-radius-sm;
}
.mj-settlement__row-name-wrap,
.mj-settlement__row-fan,
.mj-settlement__delta,
.mj-settlement__gold {
  flex: 1 1 0;
}
.mj-settlement__row-name-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  min-width: 0;
}
.mj-settlement__row--me {
  background: rgba($ftl-color-gold, 0.12);
  box-shadow: inset 0 0 0 $ftl-hairline $ftl-color-gold-deep;
}
.mj-settlement__row--winner .mj-settlement__row-name {
  color: $ftl-color-gold-light;
}
.mj-settlement__row-name {
  color: $ftl-color-on-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-settlement__row-fan {
  font-size: $ftl-font-sm;
  color: rgba($ftl-color-on-primary, 0.75);
}
.mj-settlement__row-fan-wrap {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.mj-settlement__hu-type {
  font-size: 11px;
  color: rgba($ftl-color-gold, 0.85);
  letter-spacing: 0.5px;
}
.mj-settlement__hand {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: $ftl-space-3 $ftl-space-5;
  margin: 0 $ftl-space-4;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 0 0 $ftl-radius-sm $ftl-radius-sm;
  border-bottom: $ftl-hairline solid rgba(255, 255, 255, 0.06);
}
.mj-settlement__hand-label {
  font-size: 12px;
  color: rgba($ftl-color-on-primary, 0.65);
  font-weight: 500;
}
.mj-settlement__hand-hint {
  font-size: 11px;
  color: rgba($ftl-color-on-primary, 0.4);
}
.mj-settlement__hand-row {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
}
.mj-settlement__hand-row .mj-tile--hu {
  box-shadow: 0 0 0 2px $ftl-color-gold, 0 0 8px rgba($ftl-color-gold, 0.6);
  transform: translateY(-2px);
}
.mj-settlement__huazhu-hint {
  font-size: 12px;
  color: rgba($ftl-color-danger, 0.85);
  font-weight: 500;
}
.mj-settlement__melds {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
}
.mj-settlement__meld-sep {
  font-size: 12px;
  color: rgba($ftl-color-on-primary, 0.4);
  margin: 0 2px;
}
.mj-settlement__delta {
  font-weight: 600;
}
.mj-settlement__delta--pos {
  color: $ftl-color-gold;
}
.mj-settlement__delta--neg {
  color: $ftl-color-danger;
}
.mj-settlement__gold {
  color: $ftl-color-on-primary;
  font-weight: 600;
}

.mj-settlement__formula {
  display: block;
  box-sizing: border-box;
  padding: $ftl-space-3 $ftl-space-5;
  border-radius: $ftl-radius-sm;
  background: $ftl-color-info-bg;
  color: $ftl-color-text-secondary;
  font-size: $ftl-font-sm;
  line-height: 1.4;
}
.mj-settlement__events {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: $ftl-space-2 $ftl-space-4;
  border-radius: $ftl-radius-sm;
  background: rgba(0, 0, 0, 0.18);
}
.mj-settlement__event {
  font-size: $ftl-font-sm;
  color: rgba($ftl-color-on-primary, 0.8);
  line-height: 1.4;
}

.mj-settlement__actions {
  display: flex;
  gap: $ftl-space-4;
  margin-top: $ftl-space-3;
}
.mj-settlement__actions .btn {
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

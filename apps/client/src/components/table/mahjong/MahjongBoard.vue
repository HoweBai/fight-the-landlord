<script setup lang="ts">
/**
 * 四川麻将·血战到底牌桌（T11）。
 *
 * 与 DdzBoard/PdkBoard 同一套边界：只收 props、只 emit（不读 store）；
 * 所有合法性/番数/可响应动作都来自 `MahjongPlayerView`（`claimsForMe`/`activeSeats`/
 * `tingTiles` 等），客户端只做**展示性**选择与按钮禁用。
 *
 * 多行动者窗口：`activeSeats` 含我 ⇒ 本窗口轮到我；动作原样回传 `view.windowId`
 *（服务端用它接受窗口内的过期 baseVersion）。
 */
import { computed, ref, watch } from 'vue';
import {
  MAHJONG_SUIT_NAMES,
  sortTiles,
  tileType,
  type MahjongAction,
  type MahjongClaimOption,
  type MahjongMeldView,
  type MahjongPlayerView,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';
import MahjongSeatPanel from './MahjongSeatPanel.vue';
import MahjongTile from './MahjongTile.vue';
import TurnTimer from '../../TurnTimer.vue';
import { haptic } from '../../../feedback/haptics';

const props = defineProps<{
  view: MahjongPlayerView | null;
  mySeat: number | null;
  seconds: number;
  busy: boolean;
  interactive: boolean;
  settlementArrived: boolean;
  settlementRevealed: boolean;
  waitingForDeal: boolean;
  roomCode: string | null;
  seatNames: Record<number, string>;
  balances: Array<number | null>;
  levelName: string | null;
}>();

const emit = defineEmits<{
  (e: 'mahjong', action: MahjongAction, windowId?: string): void;
  (e: 'trustee', on: boolean): void;
  (e: 'more'): void;
  (e: 'leave'): void;
}>();

const me = computed(() => props.mySeat ?? 0);
const leftSeat = computed(() => (me.value + 3) % 4);
const rightSeat = computed(() => (me.value + 1) % 4);
const topSeat = computed(() => (me.value + 2) % 4);

const view = computed(() => props.view);
const phase = computed(() => props.view?.state ?? null);
const hand = computed<readonly Tile[]>(() => sortTiles(props.view?.hand ?? []));
const myMelds = computed<readonly MahjongMeldView[]>(() => props.view?.melds[me.value] ?? []);
const myDiscards = computed<readonly Tile[]>(() => props.view?.discards[me.value] ?? []);
const myRevealed = computed(
  () => props.view?.revealedHands.find((r) => r.seat === me.value) ?? null,
);
const wallCount = computed(() => props.view?.wallCount ?? 0);
const dealerSeat = computed(() => props.view?.dealerSeat ?? 0);
const activeSeats = computed<readonly number[]>(() => props.view?.activeSeats ?? []);
const amActive = computed(() => activeSeats.value.includes(me.value));
const myClaims = computed<readonly MahjongClaimOption[]>(() => props.view?.claimsForMe ?? []);
const myTrustee = computed(() => props.view?.trustees[me.value] ?? false);
const sceneBase = computed<number | null>(() => props.view?.baseScore ?? null);
const tingTiles = computed<readonly Tile[]>(() => props.view?.tingTiles ?? []);
const myLack = computed(() => props.view?.lackSuits[me.value] ?? null);
const myPendingDelta = computed(() => pendingDelta(me.value));
const myHu = computed(() => props.view?.huInfos.find((h) => h.seat === me.value) ?? null);

/** 手牌可选的条件：交互开启 + 未结算 + （换三张窗口 | 出牌窗口）。 */
const handSelectable = computed(() => {
  if (!props.interactive || props.settlementArrived) return false;
  if (phase.value === 'exchange') return amActive.value;
  if (phase.value === 'play') return amActive.value;
  return false;
});

const selected = ref<number[]>([]);
// 只在**手牌内容**变化时清空选择：换三张阶段别人提交也会 bump version，
// 若把 version 纳入 watch 源，我正在选的第 2/3 张会被别人的动作清掉。
watch(
  () => hand.value.map(tileType).join(','),
  () => {
    selected.value = [];
  },
);

function onTileClick(index: number): void {
  if (!handSelectable.value) return;
  if (phase.value === 'exchange') {
    const at = selected.value.indexOf(index);
    if (at >= 0) selected.value.splice(at, 1);
    else if (selected.value.length < 3) selected.value.push(index);
  } else {
    selected.value =
      selected.value.length === 1 && selected.value[0] === index ? [] : [index];
  }
  haptic('light');
}

const selectedTiles = computed<Tile[]>(() =>
  selected.value.map((i) => hand.value[i]).filter((t): t is Tile => t !== undefined),
);
const exchangeReady = computed(
  () =>
    phase.value === 'exchange' &&
    selectedTiles.value.length === 3 &&
    selectedTiles.value.every((t) => t.s === selectedTiles.value[0]!.s),
);

function submit(action: MahjongAction): void {
  emit('mahjong', action, props.view?.windowId);
}
function onExchange(): void {
  if (!exchangeReady.value || props.busy) return;
  submit({ type: 'exchange', tiles: selectedTiles.value });
}
function onLack(suit: MahjongSuit): void {
  if (props.busy) return;
  submit({ type: 'lack', suit });
}
function onDiscard(): void {
  const tile = selectedTiles.value[0];
  if (!tile || props.busy) return;
  submit({ type: 'discard', tile });
}
function onTrustee(on: boolean): void {
  emit('trustee', on);
}

/** 自摸窗口里的杠：手上 4 张 = 暗杠，否则是对已碰牌的补杠。 */
function selfGangAction(tile: Tile): MahjongAction {
  const count = hand.value.filter((t) => t.s === tile.s && t.r === tile.r).length;
  return count >= 4
    ? { type: 'concealedGang', tile }
    : { type: 'addedGang', tile };
}
function claimLabel(opt: MahjongClaimOption): string {
  if (opt.claim === 'hu') return phase.value === 'play' ? '自摸胡' : '胡';
  if (opt.claim === 'gang') {
    if (phase.value === 'play' && opt.tile) {
      return selfGangAction(opt.tile).type === 'concealedGang' ? '暗杠' : '补杠';
    }
    return '杠';
  }
  if (opt.claim === 'peng') return '碰';
  return '过';
}
function onClaimOption(opt: MahjongClaimOption): void {
  if (props.busy) return;
  if (phase.value === 'play') {
    if (opt.claim === 'hu') submit({ type: 'selfDrawHu' });
    else if (opt.claim === 'gang' && opt.tile) submit(selfGangAction(opt.tile));
    return;
  }
  submit({ type: 'claim', claim: opt.claim });
}
function claimKey(opt: MahjongClaimOption, index: number): string {
  return `${opt.claim}:${opt.tile ? tileType(opt.tile) : 'x'}:${index}`;
}

/** 当前窗口里第一个可响应的牌（用于中央提示）。 */
const claimTile = computed<Tile | null>(
  () => myClaims.value.find((o) => o.tile !== undefined)?.tile ?? null,
);

function nameOf(seat: number): string {
  if (seat === me.value) return '我';
  return props.seatNames[seat] || `玩家${seat}`;
}
function seatBalance(seat: number): number | null {
  return props.balances[seat] ?? null;
}
function pendingDelta(seat: number): number {
  return props.view?.pendingScoreChanges?.find((p) => p.seat === seat)?.delta ?? 0;
}
function seatPanelProps(seat: number) {
  const v = props.view;
  return {
    seat,
    name: nameOf(seat),
    cardCount: v ? (v.cardCounts[seat] ?? 0) : 0,
    lackSuit: v?.lackSuits[seat] ?? null,
    melds: v?.melds[seat] ?? [],
    discards: v?.discards[seat] ?? [],
    hu: v?.huInfos.find((h) => h.seat === seat) ?? null,
    revealed: v?.revealedHands.find((r) => r.seat === seat) ?? null,
    isOut: v?.isOut[seat] ?? false,
    trustee: v?.trustees[seat] ?? false,
    active: activeSeats.value.includes(seat),
    isMe: seat === me.value,
    isDealer: seat === dealerSeat.value,
    balance: seatBalance(seat),
    pendingDelta: pendingDelta(seat),
  };
}

/** 中央提示文案（纯展示映射，不判规则）。 */
const phaseText = computed(() => {
  switch (phase.value) {
    case 'exchange':
      return amActive.value ? '换三张：选 3 张同花色' : '等待其他玩家换三张…';
    case 'lack':
      return amActive.value ? '定缺：选择要打空的花色' : '等待其他玩家定缺…';
    case 'claim':
      return amActive.value ? '请响应' : '等待其他玩家响应…';
    case 'play':
      return amActive.value ? '请出牌' : `等待 ${nameOf(activeSeats.value[0] ?? 0)} 出牌…`;
    case 'ended':
      return '本局结束';
    default:
      return '等待发牌…';
  }
});
const endReason = computed(() => props.view?.isOut.filter(Boolean).length ?? 0);
</script>

<template>
  <view class="mj">
    <view class="mj__bar">
      <view class="mj__bar-left">
        <button
          type="button"
          class="btn btn--small mj__back"
          aria-label="返回大厅"
          @click="emit('leave')"
        >
          <image class="mj__back-icon" src="/static/ui/back_arrow.png" mode="aspectFit" />
        </button>
      </view>
      <view class="mj__bar-center">
        <text v-if="levelName" class="mj__bar-text">{{ levelName }}</text>
        <text v-if="sceneBase !== null" class="mj__bar-text">底分 {{ sceneBase }}</text>
        <text class="mj__bar-text">牌墙 {{ wallCount }}</text>
      </view>
      <view class="mj__bar-right">
        <button
          v-if="!settlementRevealed && phase !== 'ended'"
          type="button"
          class="btn btn--small mj__trustee"
          :class="{ 'mj__trustee--on': myTrustee }"
          :aria-pressed="myTrustee"
          @click="onTrustee(!myTrustee)"
        >
          托管
        </button>
        <button
          v-if="!settlementRevealed"
          type="button"
          class="btn btn--small mj__more"
          @click="emit('more')"
        >
          更多
        </button>
      </view>
    </view>

    <view v-if="waitingForDeal" class="mj__waiting">已进房，等待服务端发牌…</view>
    <template v-else>
      <view class="mj__top">
        <MahjongSeatPanel v-bind="seatPanelProps(topSeat)" compact />
      </view>

      <view class="mj__mid">
        <view class="mj__side">
          <MahjongSeatPanel v-bind="seatPanelProps(leftSeat)" compact />
        </view>
        <view class="mj__center">
          <text class="mj__phase">{{ phaseText }}</text>
          <view v-if="claimTile" class="mj__claim-tile">
            <MahjongTile :tile="claimTile" size="md" />
          </view>
          <text v-if="endReason > 0 && phase !== 'ended'" class="mj__muted">
            已胡 {{ endReason }} 家
          </text>
          <view v-if="tingTiles.length > 0" class="mj__ting">
            <text class="mj__ting-label">
              听<template v-if="view?.maxFanForMe !== undefined">（{{ view.maxFanForMe }} 番）</template>
            </text>
            <MahjongTile v-for="(tile, i) in tingTiles" :key="`ting-${i}`" :tile="tile" size="sm" />
          </view>
        </view>
        <view class="mj__side">
          <MahjongSeatPanel v-bind="seatPanelProps(rightSeat)" compact />
        </view>
      </view>

      <view class="mj__mine">
        <view class="mj__me-meta">
          <text v-if="me === dealerSeat" class="mj__me-badge mj__me-badge--dealer">庄</text>
          <text v-if="myLack !== null" class="mj__me-badge">
            缺{{ MAHJONG_SUIT_NAMES[myLack] }}
          </text>
          <text v-if="myHu" class="mj__me-badge mj__me-badge--pos">
            胡{{ myHu.fan > 0 ? ` ${myHu.fan}番` : '' }}
          </text>
          <text
            v-if="myPendingDelta !== 0"
            class="mj__me-badge"
            :class="myPendingDelta > 0 ? 'mj__me-badge--pos' : 'mj__me-badge--neg'"
          >
            {{ myPendingDelta > 0 ? `+${myPendingDelta}` : myPendingDelta }}
          </text>
        </view>
        <view v-for="(meld, i) in myMelds" :key="`my-meld-${i}`" class="mj__my-meld">
          <text class="mj__my-meld-label">
            {{ meld.kind === 'peng' ? '碰' : meld.kind === 'gang' ? '杠' : '暗杠' }}
          </text>
          <MahjongTile
            v-for="(tile, j) in meld.tiles"
            :key="`my-meld-${i}-${j}`"
            :tile="tile"
            :back="meld.kind === 'angang'"
            size="sm"
          />
        </view>
        <view v-if="myDiscards.length > 0" class="mj__my-river">
          <MahjongTile v-for="(tile, i) in myDiscards" :key="`my-discard-${i}`" :tile="tile" size="sm" />
        </view>
        <view v-if="myRevealed" class="mj__my-revealed">
          <text class="mj__my-meld-label">已胡</text>
          <MahjongTile
            v-for="(tile, i) in myRevealed.tiles"
            :key="`my-revealed-${i}`"
            :tile="tile"
            size="sm"
            dim
          />
        </view>
      </view>

      <view class="mj__action">
        <TurnTimer :active="amActive && !settlementRevealed" :seconds="seconds" />

        <template v-if="!settlementArrived && phase === 'exchange' && amActive">
          <text class="mj__hint">已选 {{ selected.length }}/3</text>
          <button
            type="button"
            class="btn btn--primary mj__confirm"
            :disabled="busy || !exchangeReady"
            @click="onExchange"
          >
            换三张
          </button>
          <text v-if="selected.length === 3 && !exchangeReady" class="mj__warn">
            必须同花色
          </text>
        </template>

        <template v-else-if="!settlementArrived && phase === 'lack' && amActive">
          <button
            v-for="suit in ([0, 1, 2] as const)"
            :key="`lack-${suit}`"
            type="button"
            class="btn mj__lack"
            :disabled="busy"
            @click="onLack(suit)"
          >
            缺{{ MAHJONG_SUIT_NAMES[suit] }}
          </button>
        </template>

        <template v-else-if="!settlementArrived && phase === 'play' && amActive">
          <button
            v-for="(opt, i) in myClaims"
            :key="claimKey(opt, i)"
            type="button"
            class="btn mj__claim"
            :class="{ 'btn--primary': opt.claim === 'hu' }"
            :disabled="busy"
            @click="onClaimOption(opt)"
          >
            {{ claimLabel(opt) }}
          </button>
          <button
            type="button"
            class="btn btn--primary mj__discard"
            :disabled="busy || selectedTiles.length !== 1"
            @click="onDiscard"
          >
            出牌
          </button>
        </template>

        <template v-else-if="!settlementArrived && phase === 'claim' && amActive">
          <button
            v-for="(opt, i) in myClaims"
            :key="claimKey(opt, i)"
            type="button"
            class="btn mj__claim"
            :class="{ 'btn--primary': opt.claim === 'hu' }"
            :disabled="busy"
            @click="onClaimOption(opt)"
          >
            {{ claimLabel(opt) }}
          </button>
        </template>

        <text v-else-if="settlementArrived || phase === 'ended'" class="mj__ended">本局结束</text>
        <text v-else class="mj__muted">{{ phaseText }}</text>
      </view>

      <view v-if="myTrustee && !settlementRevealed && phase !== 'ended'" class="mj__trustee-mask" @click.stop>
        <text class="mj__trustee-title">托管中</text>
        <text class="mj__trustee-desc">轮到你时将自动出牌</text>
        <button type="button" class="btn btn--primary mj__trustee-cancel" :disabled="busy" @click="onTrustee(false)">
          取消托管
        </button>
      </view>

      <view class="mj__hand" :class="{ 'mj__hand--selectable': handSelectable }">
        <MahjongTile
          v-for="(tile, i) in hand"
          :key="`hand-${i}`"
          :tile="tile"
          size="lg"
          :selected="selected.includes(i)"
          :disabled="!handSelectable"
          @click="onTileClick(i)"
        />
      </view>
    </template>

    <slot name="overlays" />
  </view>
</template>

<style scoped lang="scss">
@import "../../../styles/animations.scss";

.mj {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
  width: 100%;
  height: 100%;
  padding: $ftl-space-2 $ftl-space-5;
  position: relative;
  color: $ftl-color-text;
}

/* —— 顶栏 —— */
.mj__bar {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
  min-height: $ftl-bar-h;
}
.mj__bar-left,
.mj__bar-right {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-3;
}
.mj__bar-center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
  z-index: 1;
}
.mj__bar-text {
  font-size: $ftl-font-sm;
  color: rgba($ftl-color-on-primary, 0.9);
  line-height: 1.2;
  white-space: nowrap;
}
.mj__trustee--on {
  border-color: $ftl-color-gold-deep;
  color: $ftl-color-gold-light;
}
.mj__back-icon {
  width: 22px;
  height: 22px;
}

/* —— 等待 / 静音 —— */
.mj__waiting {
  padding: $ftl-space-9;
  text-align: center;
  color: $ftl-color-text-muted;
  font-size: $ftl-font-md;
}
.mj__muted {
  color: $ftl-color-text-muted;
  font-size: $ftl-font-sm;
}
.mj__ended {
  font-size: $ftl-font-md;
  color: $ftl-color-text-secondary;
}

/* —— 座位区 —— */
.mj__top {
  display: flex;
  flex: 0 0 auto;
  justify-content: center;
  min-height: 0;
}
.mj__top :deep(.mj-seat) {
  max-width: 46%;
}
.mj__mid {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: $ftl-space-3;
  min-height: 0;
}
.mj__side {
  flex: 0 1 24%;
  min-width: 0;
  max-height: 100%;
  overflow: hidden;
}
.mj__center {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-2;
  min-width: 0;
  text-align: center;
}
.mj__phase {
  color: $ftl-color-gold;
  font-size: $ftl-font-lg;
  font-weight: 700;
  text-shadow: 0 2px 8px rgba($ftl-color-night-deep, 0.6);
  white-space: nowrap;
}
.mj__claim-tile {
  display: flex;
  justify-content: center;
}
.mj__ting {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 2px;
}
.mj__ting-label {
  font-size: 10px;
  color: $ftl-color-text-muted;
}

/* —— 我的副露 / 弃牌 —— */
.mj__mine {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: $ftl-space-3;
  min-height: 0;
}
.mj__my-meld,
.mj__my-river,
.mj__my-revealed {
  display: flex;
  align-items: center;
  gap: 2px;
}
.mj__me-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: $ftl-space-2;
}
.mj__me-badge {
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.85);
  font-size: 10px;
  line-height: 1.5;
}
.mj__me-badge--dealer {
  background: $ftl-color-accent;
  color: $ftl-color-on-primary;
}
.mj__me-badge--pos {
  background: rgba($ftl-color-gold, 0.35);
  color: $ftl-color-gold-light;
}
.mj__me-badge--neg {
  background: rgba($ftl-color-danger, 0.3);
}
.mj__my-meld-label {
  margin-right: 2px;
  font-size: 10px;
  color: $ftl-color-text-muted;
}

/* —— 动作栏 —— */
.mj__action {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-3;
  min-height: $ftl-space-9;
}
.mj__hint,
.mj__warn {
  font-size: $ftl-font-sm;
  color: $ftl-color-text-muted;
}
.mj__warn {
  color: $ftl-color-danger;
}
.mj__lack,
.mj__claim,
.mj__confirm,
.mj__discard {
  min-width: 72px;
}

/* —— 手牌 —— */
.mj__hand {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-end;
  justify-content: center;
  gap: 0;
  min-height: 79px;
  padding: $ftl-space-2 0 0;
  overflow-x: auto;
}
.mj__hand :deep(.mj-tile) {
  margin-left: -18px;
}
.mj__hand :deep(.mj-tile:first-child) {
  margin-left: 0;
}
.mj__hand :deep(.mj-tile--selected) {
  z-index: 1;
}
.mj__hand--selectable :deep(.mj-tile) {
  cursor: pointer;
}

/* —— 托管遮罩 —— */
.mj__trustee-mask {
  position: absolute;
  right: 50%;
  bottom: 96px;
  transform: translateX(50%);
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-2;
  padding: $ftl-space-4 $ftl-space-7;
  border-radius: $ftl-radius-md;
  background: rgba(0, 0, 0, 0.72);
  border: $ftl-hairline solid rgba($ftl-color-gold, 0.4);
}
.mj__trustee-title {
  color: $ftl-color-gold;
  font-size: $ftl-font-md;
  font-weight: 700;
}
.mj__trustee-desc {
  color: $ftl-color-text-muted;
  font-size: $ftl-font-sm;
}
.mj__trustee-cancel {
  margin-top: $ftl-space-2;
}

/* —— 按钮（自持样式：父组件 scoped 规则进不来）—— */
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
.btn--small {
  min-height: $ftl-control-h-sm;
  padding: 0 $ftl-space-6;
  font-size: $ftl-font-sm;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 2px 0 rgba(255, 255, 255, 0.06);
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
    box-shadow:
      0 8px 0 $ftl-color-gold-deep,
      0 12px 28px rgb(255 152 0 / 0.55),
      inset 0 2px 0 rgb(255 255 255 / 0.6);
  }
  &:active {
    transform: translateY(4px);
    box-shadow:
      0 2px 0 $ftl-color-gold-deep,
      0 4px 10px rgb(255 152 0 / 0.3),
      inset 0 3px 8px rgb(0 0 0 / 0.2);
  }
}
.btn[disabled] {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none !important;
  filter: grayscale(0.4);
}

/* —— 返回大厅按钮：PNG 图标 —— */
.mj__back {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  width: 40px;
  padding: 0;
}
</style>

<script setup lang="ts">
/**
 * 跑得快牌桌（S6.1 / spec §4.10.2）。
 *
 * 与 `DdzBoard` 同一套边界：只收 props、只 emit（不读 store）；服务端权威 ——
 * `canPass`/`bombCount`/`cardCounts` 全部来自 `PdkPlayerView`，客户端不判规则。
 * 首版只做 **3 人**（`playerCount !== 3` 由壳提示并回大厅）。
 *
 * 无叫抢 / 无底牌 / 无地主徽标 / 无记牌器；动作栏 = 出牌 / 不出（服务端 `canPass`）/ 提示。
 * 提示用本局 `view.pdkRules` + `protocol/pdk/rule` 枚举（S6.2）。
 */
import { computed, ref, watch, watchEffect } from "vue";
import {
  PdkHandType,
  canBeatPdk,
  parsePdkHand,
  type Card,
  type PdkParsedHand,
  type PdkPlayerView,
} from "@fight-the-landlord/protocol";
import Hand from "../../Hand.vue";
import PlayArea from "../../PlayArea.vue";
import Seat from "../../Seat.vue";
import TurnTimer from "../../TurnTimer.vue";
import { cardKey } from "../../../game/card-key";
import { suggestPdkPlays } from "../../../game/pdk-hint";
import { haptic } from "../../../feedback/haptics";

const props = defineProps<{
  view: PdkPlayerView | null;
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
  (e: "play", cards: Card[]): void;
  (e: "pass"): void;
  (e: "trustee", on: boolean): void;
  (e: "more"): void;
  (e: "leave"): void;
}>();

const view = computed(() => props.view);
const hand = computed<readonly Card[]>(() => props.view?.hand ?? []);
const cardCounts = computed<readonly number[]>(() => props.view?.cardCounts ?? [0, 0, 0]);
const recentActions = computed(() => props.view?.recentActions ?? []);
const trustees = computed<readonly boolean[]>(() => props.view?.trustees ?? [false, false, false]);
const isPlaying = computed(() => props.view?.state === "playing");
const isEnded = computed(() => props.view?.state === "ended");
const actorSeat = computed<number | null>(() => props.view?.currentPlayer ?? null);
const isMyTurn = computed(
  () => actorSeat.value !== null && actorSeat.value === props.mySeat,
);
const pdkRules = computed(() => props.view?.pdkRules ?? null);
const canPass = computed(() => props.view?.canPass === true);
const bombCount = computed(() => props.view?.bombCount ?? 0);
const sceneBase = computed<number | null>(() => props.view?.baseScore ?? null);
const myTrustee = computed<boolean>(() => {
  const seat = props.mySeat;
  return seat === null ? false : (trustees.value[seat] ?? false);
});

/** 两个对手方位（逆时针；与 ddz 同款：下家在右、上家在左）。 */
const seats = computed<[number, number]>(() => {
  const me = props.mySeat;
  if (me === null) return [0, 1];
  return [(me + 2) % 3, (me + 1) % 3];
});

function actionOf(seat: number) {
  const w = recentActions.value;
  for (let i = w.length - 1; i >= 0; i -= 1) if (w[i]!.seat === seat) return w[i]!;
  return null;
}
const leftAction = computed(() => actionOf(seats.value[0]!));
const rightAction = computed(() => actionOf(seats.value[1]!));
const myAction = computed(() =>
  props.mySeat === null ? null : actionOf(props.mySeat),
);
function passEchoOf(seat: number): string | null {
  const a = actionOf(seat);
  return a !== null && a.cards === null ? "不出" : null;
}
const myPassEcho = computed(() =>
  props.mySeat === null ? null : passEchoOf(props.mySeat),
);

function nameOf(seat: number): string {
  if (seat === props.mySeat) return "我";
  return props.seatNames[seat] || `玩家${seat}`;
}
function seatBalance(seat: number): number | null {
  return props.balances[seat] ?? null;
}
function seatProps(seat: number) {
  return {
    seat,
    name: nameOf(seat),
    cardCount: cardCounts.value[seat] ?? 0,
    // 跑得快没有地主：徽标恒 false（Seat 不渲染角色）。
    isLandlord: false,
    isActive: actorSeat.value === seat,
    balance: seatBalance(seat),
    baseScore: props.view?.baseScore ?? 0,
    trustee: trustees.value[seat] ?? false,
    showBacks: true,
    size: "opponent" as const,
  };
}
function timerProps(seat: number) {
  return { active: actorSeat.value === seat, seconds: props.seconds };
}

/**
 * 跟牌目标（服务端窗口最后一手是**对手**所出 ⇒ 解析结果；否则 null）。
 * 解析失败 ⇒ null（首出语义；真正的合法性仍由服务端判定）。
 */
const target = computed<PdkParsedHand | null>(() => {
  const rules = pdkRules.value;
  const me = props.mySeat;
  if (!rules || me === null) return null;
  for (let i = recentActions.value.length - 1; i >= 0; i -= 1) {
    const a = recentActions.value[i]!;
    // 过牌不改变跟牌目标（反向扫描要继续往前找真正的上一手）
    if (!a.cards) continue;
    if (a.seat === me) return null; // 最后真牌是我自己出的 ⇒ 重新首出
    const parsed = parsePdkHand([...a.cards], rules);
    return parsed.type === PdkHandType.Invalid ? null : parsed;
  }
  return null;
});

const selected = ref<number[]>([]);
watch(
  () => hand.value.map(cardKey).join(","),
  () => {
    selected.value = [];
  },
);
function toggleCard(index: number) {
  const at = selected.value.indexOf(index);
  if (at >= 0) selected.value.splice(at, 1);
  else selected.value.push(index);
  haptic("light");
}
function onSwipeSelect(indices: readonly number[]) {
  const set = new Set(selected.value);
  for (const i of indices) set.add(i);
  selected.value = [...set];
  haptic("light");
}
function onSwipeDeselect(indices: readonly number[]) {
  const set = new Set(selected.value);
  for (const i of indices) set.delete(i);
  selected.value = [...set];
  haptic("light");
}

const selectedCards = computed<Card[]>(() =>
  selected.value.map((i) => hand.value[i]!).filter(Boolean),
);
const isLegalLocal = computed<boolean>(() => {
  const rules = pdkRules.value;
  const cards = selectedCards.value;
  if (!rules || cards.length === 0) return false;
  const parsed = parsePdkHand(cards, rules);
  if (parsed.type === PdkHandType.Invalid) return false;
  const t = target.value;
  return t === null ? true : canBeatPdk(parsed, t, rules);
});

const hintIndex = ref(0);
watchEffect(() => {
  void props.view?.version;
  hintIndex.value = 0;
});
const hintCandidates = computed<Card[][]>(() => {
  if (!isMyTurn.value || !isPlaying.value) return [];
  const rules = pdkRules.value;
  if (!rules || hand.value.length === 0) return [];
  return suggestPdkPlays(hand.value, target.value, rules);
});
function onHint(): void {
  const rules = pdkRules.value;
  const candidates = hintCandidates.value;
  if (!rules || candidates.length === 0) return;
  const picked = candidates[hintIndex.value % candidates.length]!;
  hintIndex.value = (hintIndex.value + 1) % candidates.length;
  const need = new Map<string, number>();
  for (const c of picked) need.set(cardKey(c), (need.get(cardKey(c)) ?? 0) + 1);
  const indices: number[] = [];
  for (let i = 0; i < hand.value.length; i += 1) {
    const key = cardKey(hand.value[i]!);
    const n = need.get(key);
    if (n && n > 0) {
      indices.push(i);
      need.set(key, n - 1);
    }
  }
  selected.value = indices;
}

function play(): void {
  if (selectedCards.value.length === 0 || !isLegalLocal.value) return;
  emit("play", selectedCards.value);
}
function pass(): void {
  emit("pass");
}
function onTrustee(on: boolean): void {
  emit("trustee", on);
}
</script>

<template>
  <view class="pdk">
    <view class="pdk__bar">
      <view class="pdk__bar-left">
        <button
          type="button"
          class="btn btn--small pdk__back"
          aria-label="返回大厅"
          @click="emit('leave')"
        >
          <image class="pdk__back-icon" src="/static/ui/back_arrow.png" mode="aspectFit" />
        </button>
      </view>
      <view class="pdk__bar-center">
        <text v-if="sceneBase !== null" class="pdk__base">底分 {{ sceneBase }}</text>
        <text class="pdk__bombs">炸弹 {{ bombCount }}</text>
      </view>
      <view class="pdk__bar-right">
        <button
          v-if="!settlementRevealed && isPlaying"
          type="button"
          class="btn btn--small pdk__trustee"
          :class="{ 'pdk__trustee--on': myTrustee }"
          :aria-pressed="myTrustee"
          @click="onTrustee(!myTrustee)"
        >
          托管
        </button>
        <button
          v-if="!settlementRevealed"
          type="button"
          class="btn btn--small pdk__more"
          @click="emit('more')"
        >
          更多
        </button>
      </view>
    </view>

    <view v-if="!settlementRevealed" class="pdk__phase">
      <text v-if="isPlaying" class="pdk__phase-text">出牌中</text>
      <text v-else-if="isEnded" class="pdk__phase-text">已结束</text>
      <text v-else class="pdk__phase-text">{{ view?.state ?? "等待发牌" }}</text>
    </view>

    <view v-if="waitingForDeal" class="pdk__waiting">已进房，等待服务端发牌…</view>
    <template v-else>
      <view class="pdk__mid">
        <Seat v-bind="seatProps(seats[0]!)" class="pdk__seat" />
        <view class="pdk__play-col">
          <TurnTimer v-bind="timerProps(seats[0]!)" />
          <PlayArea v-if="leftAction && leftAction.cards" class="pdk__played" :cards="leftAction.cards" />
          <text v-else-if="leftAction && leftAction.cards === null" class="pdk__play-pass anim-toast-in">不出</text>
        </view>
        <view class="pdk__center">
          <text v-if="levelName" class="pdk__scene-name">{{ levelName }}</text>
          <text v-if="sceneBase !== null" class="pdk__scene-base">底分 {{ sceneBase }}</text>
          <text class="pdk__remaining">
            剩余 {{ cardCounts[seats[0]!] ?? 0 }} · {{ cardCounts[seats[1]!] ?? 0 }}
          </text>
        </view>
        <view class="pdk__play-col pdk__play-col--right">
          <TurnTimer v-bind="timerProps(seats[1]!)" />
          <PlayArea
            v-if="rightAction && rightAction.cards"
            class="pdk__played"
            :cards="rightAction.cards"
            :mirror="true"
          />
          <text v-else-if="rightAction && rightAction.cards === null" class="pdk__play-pass anim-toast-in">不出</text>
        </view>
        <Seat v-bind="seatProps(seats[1]!)" class="pdk__seat pdk__seat--right" :mirror="true" />
      </view>

      <view class="pdk__action-bar">
        <view v-if="isPlaying && isMyTurn && !settlementArrived" class="pdk__actions">
          <button
            v-if="canPass"
            type="button"
            class="btn pdk__pass"
            :disabled="busy"
            @click="pass"
          >
            不出
          </button>
          <view class="pdk__clock">
            <text class="pdk__clock-value">{{ seconds }}s</text>
          </view>
          <button
            v-if="hintCandidates.length > 0"
            type="button"
            class="btn pdk__hint"
            :disabled="busy"
            @click="onHint"
          >
            提示
          </button>
          <button
            type="button"
            class="btn btn--primary pdk__play"
            :disabled="busy || selected.length === 0 || !isLegalLocal"
            @click="play"
          >
            出牌（{{ selected.length }}）
          </button>
        </view>
        <template v-else-if="isEnded">
          <PlayArea v-if="myAction && myAction.cards" class="pdk__my-play" :cards="myAction.cards" />
          <text v-else class="pdk__ended">本局结束</text>
        </template>
        <text v-else-if="settlementArrived" class="pdk__ended">本局结束</text>
        <PlayArea
          v-else-if="isPlaying && myAction && myAction.cards"
          class="pdk__my-play"
          :cards="myAction.cards"
        />
        <text v-else-if="isPlaying && myPassEcho" class="pdk__my-pass anim-toast-in">{{ myPassEcho }}</text>
        <text v-else-if="isPlaying" class="pdk__muted">等待其他玩家…</text>
      </view>

      <view class="pdk__me">
        <Hand
          :cards="hand"
          :interactive="interactive"
          :selected="selected"
          sort="desc"
          size="normal"
          reflow
          empty-text="手牌为空"
          @toggle="toggleCard"
          @swipe-select="onSwipeSelect"
          @swipe-deselect="onSwipeDeselect"
        />
        <view v-if="myTrustee && !settlementRevealed && isPlaying" class="pdk__trustee-mask" @click.stop>
          <text class="pdk__trustee-title">托管中</text>
          <button type="button" class="btn btn--primary pdk__trustee-cancel" :disabled="busy" @click="onTrustee(false)">
            取消托管
          </button>
        </view>
        <view class="pdk__me-foot">
          <Seat
            :seat="mySeat ?? 0"
            :name="nameOf(mySeat ?? 0)"
            :card-count="hand.length"
            :is-landlord="false"
            :is-active="actorSeat === mySeat"
            :balance="seatBalance(mySeat ?? 0)"
            :base-score="view?.baseScore ?? 0"
            :trustee="myTrustee"
            size="me"
            part="avatar"
          />
          <view class="pdk__me-info">
            <Seat
              :seat="mySeat ?? 0"
              :name="nameOf(mySeat ?? 0)"
              :card-count="hand.length"
              :is-landlord="false"
              :is-active="actorSeat === mySeat"
              :balance="seatBalance(mySeat ?? 0)"
              :base-score="view?.baseScore ?? 0"
              :trustee="myTrustee"
              size="me"
              part="meta"
            />
            <text class="pdk__room">房间 {{ roomCode ?? "—" }}</text>
          </view>
        </view>
      </view>
    </template>

    <slot name="overlays" />
  </view>
</template>

<style scoped lang="scss">
@import "../../../styles/animations.scss";

.pdk {
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
.pdk__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: $ftl-bar-h;
}
.pdk__bar-left,
.pdk__bar-right,
.pdk__bar-center {
  display: flex;
  align-items: center;
  gap: $ftl-space-3;
}
.pdk__back-icon {
  width: 40px;
  height: 40px;
}
.pdk__base,
.pdk__bombs {
  font-size: $ftl-font-md;
  color: $ftl-color-text-secondary;
}
.pdk__phase {
  text-align: center;
}
.pdk__phase-text {
  font-size: $ftl-font-sm;
  color: $ftl-color-text-secondary;
}
.pdk__waiting,
.pdk__muted,
.pdk__ended {
  text-align: center;
  font-size: $ftl-font-md;
  color: $ftl-color-text-secondary;
}
.pdk__mid {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-4;
  min-height: 0;
}
.pdk__play-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-2;
  flex: 0 0 auto;
}
.pdk__play-col--right {
  align-items: center;
}
.pdk__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-2;
  flex: 1 1 auto;
}
.pdk__scene-name {
  font-size: $ftl-font-lg;
  color: $ftl-color-gold-light;
}
.pdk__scene-base,
.pdk__remaining {
  font-size: $ftl-font-sm;
  color: $ftl-color-text-secondary;
}
.pdk__play-pass {
  font-size: $ftl-font-md;
  color: $ftl-color-text-secondary;
}
.pdk__action-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  height: $ftl-size-action-bar-h;
}
.pdk__actions {
  display: flex;
  align-items: center;
  gap: $ftl-space-4;
}
.pdk__clock {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: $ftl-size-clock-w;
  height: $ftl-size-clock-h;
  background-image: $ftl-art-countdown;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
.pdk__clock-value {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-xl;
  font-weight: 700;
}
.pdk__me {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: $ftl-space-2;
}
.pdk__me :deep(.hand) {
  display: flex;
  flex-wrap: nowrap;
  column-gap: 0;
  align-items: flex-end;
  justify-content: center;
}
.pdk__me-foot {
  display: flex;
  align-items: flex-end;
  gap: $ftl-space-4;
}
.pdk__me-info {
  display: flex;
  flex: 1 1 0;
  align-items: flex-end;
  justify-content: space-between;
}
.pdk__room {
  font-size: $ftl-font-sm;
  color: $ftl-color-text-secondary;
}
.pdk__trustee-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-3;
  background: rgb(0 0 0 / 45%);
  z-index: 2;
}
.pdk__trustee-title {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-lg;
}
.pdk__trustee--on {
  border-color: $ftl-color-gold-deep;
  color: $ftl-color-gold-light;
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

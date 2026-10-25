<script setup lang="ts">
/**
 * 跑得快牌桌（S6.1 / spec §4.10.2）。
 *
 * 与 `DdzBoard` 同一套边界：只收 props、只 emit（不读 store）；服务端权威 ——
 * `canPass`/`bombCount`/`cardCounts` 全部来自 `PdkPlayerView`，客户端不判规则。
 * 已实现 **2/3/4 人**（4 人 = 顶部对家 + 左右对手；>4 由壳提示并回大厅）。
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
/** 末 5 秒紧迫态（A 档；与 DdzBoard 同款）。 */
const clockUrgent = computed(() => props.seconds > 0 && props.seconds <= 5);

/** 本局人数（牌桌**只信视图**；旧服务端缺省 3）。 */
const playerCount = computed(() => props.view?.playerCount ?? 3);

/** 对手方位（逆时针；3 人：下家右、上家左；2 人：唯一对手在左；4 人：左/右 + 顶部对家）。 */
const seats = computed<readonly number[]>(() => {
  const me = props.mySeat;
  if (me === null) {
    if (playerCount.value === 2) return [1];
    if (playerCount.value === 4) return [3, 1];
    return [0, 1];
  }
  if (playerCount.value === 2) return [(me + 1) % 2];
  if (playerCount.value === 4) return [(me + 3) % 4, (me + 1) % 4];
  return [(me + 2) % 3, (me + 1) % 3];
});

/** 顶部对家（仅 4 人）。 */
const topSeat = computed<number | null>(() => {
  if (playerCount.value !== 4) return null;
  const me = props.mySeat;
  return me === null ? 2 : (me + 2) % 4;
});

function actionOf(seat: number) {
  const w = recentActions.value;
  for (let i = w.length - 1; i >= 0; i -= 1) if (w[i]!.seat === seat) return w[i]!;
  return null;
}
const leftAction = computed(() => actionOf(seats.value[0]!));
const rightAction = computed(() =>
  seats.value.length > 1 ? actionOf(seats.value[1]!) : null,
);
const topAction = computed(() =>
  topSeat.value !== null ? actionOf(topSeat.value) : null,
);
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

/** 打不过：有跟牌目标且提示候选为空（无任何一手能压过目标）。 */
const cannotBeat = computed(
  () => target.value !== null && hintCandidates.value.length === 0,
);
/** 只能过牌：跟牌但穷尽判定无解 ⇒ 只显示「不出」按钮。 */
const passOnly = computed(
  () => target.value !== null && cannotBeat.value,
);

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
  <view class="pdk" :class="{ 'pdk--four': playerCount === 4 }">
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

    <!--
      阶段状态遮罩层：绝对定位到牌桌中央（参考 DdzBoard 的 `.table__phase-overlay`）。
      定位基准 = `.pdk`（position: relative），z-index 低于顶栏、高于牌桌内容。
      top: 28% 与 DdzBoard 一致，落在中段上半段，与动作行垂直错开。
    -->
    <view v-if="!settlementRevealed" class="pdk__phase-overlay">
      <text v-if="isPlaying" class="pdk__phase">出牌中</text>
      <text v-else-if="isEnded" class="pdk__phase">已结束</text>
      <text v-else class="pdk__phase">{{ view?.state ?? "等待发牌" }}</text>
    </view>

    <view v-if="waitingForDeal" class="pdk__waiting">已进房，等待服务端发牌…</view>
    <template v-else>
      <view v-if="topSeat !== null" class="pdk__top">
        <Seat v-bind="seatProps(topSeat ?? 0)" class="pdk__seat pdk__seat--top" />
        <view class="pdk__play-col pdk__play-col--top">
          <TurnTimer v-bind="timerProps(topSeat ?? 0)" />
          <PlayArea
            v-if="topAction && topAction.cards"
            class="pdk__played-slot"
            :cards="topAction.cards"
          />
          <text v-else-if="topAction && topAction.cards === null" class="pdk__play-pass anim-toast-in">不出</text>
        </view>
      </view>

      <view
        class="pdk__mid"
        :class="{ 'pdk__mid--two': seats.length === 1, 'pdk__mid--four': playerCount === 4 }"
      >
        <Seat v-bind="seatProps(seats[0]!)" class="pdk__seat" />
        <view class="pdk__play-col">
          <TurnTimer v-bind="timerProps(seats[0]!)" />
          <PlayArea v-if="leftAction && leftAction.cards" class="pdk__played-slot" :cards="leftAction.cards" />
          <text v-else-if="leftAction && leftAction.cards === null" class="pdk__play-pass anim-toast-in">不出</text>
        </view>
        <view class="pdk__center">
          <text v-if="levelName && !isPlaying" class="pdk__scene-name">{{ levelName }}</text>
          <text v-if="sceneBase !== null" class="pdk__scene-base">底分 {{ sceneBase }}</text>
        </view>
        <view v-if="seats.length > 1" class="pdk__play-col pdk__play-col--right">
          <TurnTimer v-bind="timerProps(seats[1]!)" />
          <PlayArea
            v-if="rightAction && rightAction.cards"
            class="pdk__played-slot pdk__played-slot--right"
            :cards="rightAction.cards"
            :mirror="true"
          />
          <text v-else-if="rightAction && rightAction.cards === null" class="pdk__play-pass anim-toast-in">不出</text>
        </view>
        <Seat
          v-if="seats.length > 1"
          v-bind="seatProps(seats[1]!)"
          class="pdk__seat pdk__seat--right"
          :mirror="true"
        />
      </view>

      <view class="pdk__action-bar">
        <view
          v-if="isPlaying && isMyTurn && !settlementArrived"
          class="pdk__actions pdk__actions--playing"
          :class="{ 'pdk__actions--pass-only': passOnly }"
        >
          <view class="pdk__actions-side pdk__actions-side--left">
            <!-- 跟牌期正常：过牌在左 -->
            <button
              v-if="canPass && !passOnly"
              type="button"
              class="btn pdk__pass"
              :disabled="busy"
              @click="pass"
            >
              不出
            </button>
            <!-- 首出：提示移到钟左边 → 对称（左提示 右出牌） -->
            <button
              v-else-if="!canPass && !passOnly"
              type="button"
              class="btn pdk__hint"
              :disabled="busy || hintCandidates.length === 0"
              @click="onHint"
            >
              提示
            </button>
          </view>
          <view
            class="pdk__clock"
            :class="{
              'pdk__clock--urgent': clockUrgent,
              'anim-urgent-pulse': clockUrgent,
            }"
          >
            <text
              class="pdk__clock-value"
              :class="{
                'pdk__clock-value--urgent': clockUrgent,
                'pdk__clock-value--digits-2': seconds >= 10 && seconds <= 99,
                'pdk__clock-value--digits-3': seconds >= 100,
              }"
            >
              {{ seconds }}s
            </text>
          </view>
          <view class="pdk__actions-side pdk__actions-side--right">
            <!-- passOnly（要不起）：不出移到钟右边 -->
            <button
              v-if="passOnly"
              type="button"
              class="btn pdk__pass"
              :disabled="busy"
              @click="pass"
            >
              不出
            </button>
            <!-- 跟牌期正常：提示在右（首出时提示已移到左边） -->
            <button
              v-if="!passOnly && canPass"
              type="button"
              class="btn pdk__hint"
              :disabled="busy || hintCandidates.length === 0"
              @click="onHint"
            >
              提示
            </button>
            <!-- 出牌按钮：正常跟牌/首出都显示；passOnly 不显示 -->
            <button
              v-if="!passOnly"
              type="button"
              class="btn btn--primary pdk__play"
              :disabled="busy || selected.length === 0 || !isLegalLocal"
              @click="play"
            >
              出牌（{{ selected.length }}）
            </button>
          </view>
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
          <text class="pdk__trustee-desc">轮到你时将自动出牌</text>
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

/**
 * 跑得快牌桌样式（参考 DdzBoard 验证过的布局/视觉）。
 *
 * 跑得快特有差异保留：无叫抢/无底牌/无地主徽标/无记牌器；
 * 以下样式全部与 DdzBoard 同形同量（token 逐字一致）。
 */
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

/* —— 顶栏 —— */
.pdk__bar {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
  min-height: $ftl-bar-h;
}
.pdk__bar-left,
.pdk__bar-right {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-3;
}
/**
 * 顶栏中央段（底分 + 炸弹）：绝对定位到 bar 的几何中心。
 * 🔴 不能用 flex 子项 —— bar-left 宽度会变，center 会被挤偏。
 */
.pdk__bar-center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: $ftl-space-3;
  z-index: 1;
}
.pdk__base,
.pdk__bombs {
  font-size: $ftl-font-sm;
  color: rgba($ftl-color-on-primary, 0.75);
  line-height: 1.2;
}
.pdk__trustee--on {
  border-color: $ftl-color-gold-deep;
  color: $ftl-color-gold-light;
}

/* —— 阶段状态遮罩 —— */
.pdk__phase-overlay {
  position: absolute;
  top: 28%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-2;
  pointer-events: none;
}
.pdk__phase {
  color: $ftl-color-gold;
  font-size: $ftl-font-lg;
  font-weight: 700;
  text-shadow: 0 2px 8px rgba($ftl-color-night-deep, 0.6);
  white-space: nowrap;
}
/** 4 人：顶部对家占了下半屏上方，阶段遮罩下移避让。 */
.pdk--four .pdk__phase-overlay {
  top: 40%;
}

/* —— 等待 / 静音 / 终局文字 —— */
.pdk__waiting {
  padding: $ftl-space-9;
  text-align: center;
  color: $ftl-color-text-muted;
  font-size: $ftl-font-md;
}
.pdk__muted {
  color: $ftl-color-text-disabled;
  font-size: $ftl-font-sm;
}
.pdk__ended {
  font-size: $ftl-font-md;
  color: $ftl-color-text-secondary;
}

/* —— 中段 —— */
/** 4 人：顶部对家一行（.pdk 的直接子项，不塞进 row flex 的 .pdk__mid）。 */
.pdk__top {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-end;
  justify-content: center;
  gap: $ftl-space-4;
  min-height: 0;
}
.pdk__seat--top {
  align-self: flex-end;
  margin-bottom: 0;
}
.pdk__play-col--top {
  flex: 0 1 auto;
  max-width: 60%;
  justify-content: center;
  padding-top: 0;
}
.pdk__mid--four {
  gap: $ftl-space-4;
}
.pdk__mid {
  display: flex;
  flex-direction: row;
  gap: $ftl-space-5;
  align-items: stretch;
  flex: 1 1 0;
  min-height: 0;
}
/** 2 人：唯一对手在左；右列不渲染，出牌列与中央区均衡占宽。 */
.pdk__mid--two .pdk__play-col,
.pdk__mid--two .pdk__center {
  flex: 1 1 0;
}
/** 对手座位：无白底板浮动组，沉到中段带底。 */
.pdk__seat {
  flex: 0 1 auto;
  min-width: 0;
  align-self: flex-end;
  margin-bottom: $ftl-mid-seat-bottom-gap;
}
/**
 * 对手出牌/状态列：水平排列，钟在牌的头像一侧。
 * 与 DdzBoard 同款：钟和出牌同一行，两家的牌永远在同一水平线上。
 */
.pdk__play-col {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: $ftl-space-4;
  padding-top: $ftl-mid-play-pad-top;
}
.pdk__play-col--right {
  flex-direction: row-reverse;
}
/** 出牌槽：钟让出宽，牌没钟时吃满整列。 */
.pdk__play-col .pdk__played-slot {
  flex: 0 1 100%;
  max-width: 100%;
  min-width: 0;
}
/** 牌多换行：把 PlayArea 内部改成 wrap。 */
.pdk__play-col .pdk__played-slot :deep(.table__played) {
  width: 100%;
  max-width: 100%;
}
.pdk__play-col .pdk__played-slot :deep(.hand) {
  box-sizing: border-box;
  width: 100%;
  flex-wrap: wrap;
  column-gap: 0;
  row-gap: $ftl-space-3;
  padding-left: $ftl-card-overlap-mid;
}
.pdk__play-col .pdk__played-slot :deep(.hand .card) {
  margin-left: -$ftl-card-overlap-mid;
}
.pdk__play-col--right .pdk__played-slot :deep(.hand) {
  justify-content: flex-end;
}
/**
 * 「不出」胶囊：深玻璃底白字。
 */
.pdk__play-pass {
  flex: 0 0 auto;
  padding: 0 $ftl-space-7;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night, 0.62);
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  line-height: 1.8;
  white-space: nowrap;
}

/* —— 中央区域（场次名/底分/剩余牌数）—— */
.pdk__center {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: $ftl-space-3;
  padding: $ftl-space-4;
  padding-bottom: $ftl-mid-center-bottom-pad;
}
.pdk__scene-name {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
.pdk__scene-base {
  color: rgba($ftl-color-on-primary, 0.75);
  font-size: $ftl-font-md;
  line-height: 1.2;
}

/* —— 我的出牌（在动作行里）—— */
.pdk__my-play {
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  min-height: 0;
}
.pdk__my-pass {
  flex: 0 0 auto;
  padding: 0 $ftl-space-7;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night, 0.62);
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  line-height: 1.8;
  white-space: nowrap;
}

/* —— 动作行 —— */
.pdk__action-bar {
  box-sizing: border-box;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: $ftl-size-action-bar-h;
  overflow: visible;
}
/**
 * 出牌期动作行 grid 三列：两侧 flex 轨道等宽配平 ⇒ 钟恒居中。
 */
.pdk__actions {
  display: flex;
  gap: $ftl-space-3;
  align-items: center;
}
.pdk__actions--playing {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: $ftl-space-3;
}
.pdk__actions-side {
  display: flex;
  align-items: center;
  gap: $ftl-space-3;
}
.pdk__actions-side--left {
  justify-content: flex-end;
}
.pdk__actions-side--right {
  justify-content: flex-start;
}

/* —— 倒计时钟 —— */
.pdk__clock {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: $ftl-size-clock-w;
  height: $ftl-size-clock-h;
  flex-shrink: 0;
  background-image: $ftl-art-countdown;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
.pdk__clock-value {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-xl;
  font-weight: 700;
  line-height: 1;
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
.pdk__clock-value--digits-2 {
  font-size: $ftl-font-md;
}
.pdk__clock-value--digits-3 {
  font-size: $ftl-font-clock-compact;
}
.pdk__clock--urgent {
  filter: drop-shadow(0 0 6px $ftl-color-danger-on-dark);
}
.pdk__clock-value--urgent {
  color: $ftl-color-danger-on-dark;
}

/* —— 按钮 3D 立体样式（与 DdzBoard 同款）—— */
.pdk__action-bar :deep(.btn) {
  min-width: 136px;
  min-height: 60px;
  font-size: $ftl-font-md;
  padding: 0 $ftl-space-5;
}

/* —— 我的区域 —— */
.pdk__me {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  gap: $ftl-space-3;
  padding: $ftl-space-2 $ftl-space-4;
}
.pdk__me :deep(.hand) {
  display: flex;
  flex-wrap: nowrap;
  column-gap: 0;
  align-items: flex-end;
  justify-content: center;
  min-height: $ftl-card-h;
  margin-bottom: -$ftl-hand-tuck;
}
.pdk__me :deep(.hand .card + .card) {
  margin-left: -$ftl-card-overlap;
}

/* —— 底部信息条 —— */
.pdk__me-foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: $ftl-space-5;
  min-width: 0;
}
.pdk__me-info {
  display: flex;
  flex: 1 1 0;
  align-items: flex-end;
  justify-content: space-between;
  gap: $ftl-space-5;
  min-width: 0;
}
.pdk__room {
  font-size: $ftl-font-sm;
  color: $ftl-color-text-secondary;
}

/* —— 托管遮罩 —— */
.pdk__trustee-mask {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: $ftl-space-3;
  background: rgb(0 0 0 / 45%);
  border-radius: $ftl-radius-md;
}
.pdk__trustee-title {
  color: $ftl-color-gold;
  font-size: $ftl-font-lg;
  font-weight: 700;
}
.pdk__trustee-desc {
  color: $ftl-color-text-secondary;
  font-size: $ftl-font-sm;
}
.pdk__trustee-cancel {
  min-width: 180px;
}

/* —— 按钮 —— */
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

/* —— 返回大厅按钮：PNG 图标 ——
   ⚠️ 必须放在 .btn / .btn--small 之后，否则会被它们的 padding/min-height 覆盖。 */
.pdk__back {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  width: 40px;
  padding: 0;
}
.pdk__back-icon {
  width: 22px;
  height: 22px;
}
</style>

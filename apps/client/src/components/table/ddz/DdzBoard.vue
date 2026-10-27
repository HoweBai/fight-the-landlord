<script setup lang="ts">
/**
 * 斗地主牌桌（S5.2：从 `pages/table/table.vue` 迁出的**玩法专属 board**）。
 *
 * 边界（plan Task 5.2a / spec §4.10.2）：
 *  - **board 不读 store**：对局事实只来自 `view` 与 props；动作只 emit，由壳统一发送、
 *    管 busy、写通知、处理返回/重开；
 *  - 叫抢 / 底牌 / 记牌器 / 斗地主提示 / 牌型播报 / 滑动选牌留在本组件；
 *  - 会话接线、房间状态、通知、连接、结算揭示、倒计时、通用音效、返回/重开在壳
 *    （`pages/table/table.vue`）。
 *
 * 渲染的全部内容仍来自服务端裁剪视图（`PlayerView`）——前端不知道也不判断规则：
 *  - 谁是地主：唯一来源 `view.landlordSeat`
 *  - 叫抢阶段的行动者：`bidPhase.currentBidder`，**不是** `currentPlayer`（玩法 §9.1）
 *  - 出什么牌：用户选牌 → 原始牌值交壳发送 → 服务端校验（F01）
 *  - 历史牌/「不出」：窗口 2 的服务端原话（`recentActions`，`cards: null` = 不出）
 */
import { computed, nextTick, onMounted, ref, watch, watchEffect } from "vue";
import {
  HandType,
  canBeat,
  parseHand,
  type BeatTarget,
  type Card,
  type PlayerView,
} from "@fight-the-landlord/protocol";
import BidPanel from "../../BidPanel.vue";
import BottomCards from "../../BottomCards.vue";
import CardCounter from "../../CardCounter.vue";
import Hand from "../../Hand.vue";
import { cardKey } from "../../../game/card-key";
import PlayArea from "../../PlayArea.vue";
import Seat from "../../Seat.vue";
import TurnTimer from "../../TurnTimer.vue";
import TableHud from "../../TableHud.vue";
import { REDEAL_BANNER_MS } from "../../../composables/useRedealNotice";
import { buildBeatTarget, hasBeatablePlay, suggestPlays } from "../../../game/hint";
import { haptic } from "../../../feedback/haptics";
import { layoutMetrics } from "../../../composables/useLandscapeCanvas";
import { useLandscapeViewport } from "../../../composables/useLandscapeViewport";

/** 壳传入的会话事实与门控件（board 不从 store 取任何东西）。 */
const props = defineProps<{
  /** 裁剪视图；`null` = 等待发牌（顶栏仍渲染） */
  view: PlayerView | null;
  mySeat: number | null;
  /** 页面唯一的倒计时读数（壳的 `useCountdown`） */
  seconds: number;
  /** 壳的动作忙锁（禁用动作按钮，不在本组件翻转） */
  busy: boolean;
  /** 结算未到 ⇒ 手牌可交互（`interactive`） */
  interactive: boolean;
  /** 结算已到（可能仍在 2s 揭示延迟窗口内） */
  settlementArrived: boolean;
  /** 结算揭示（壳的 `useSettlementReveal`） */
  settlementRevealed: boolean;
  /** `view === null` 的等待态 */
  waitingForDeal: boolean;
  roomCode: string | null;
  /** 按座位的昵称（壳从 store 投影；缺省回落「玩家N」） */
  seatNames: Record<number, string>;
  /** 按座位的余额（null = 不显示金币位） */
  balances: Array<number | null>;
  /** 场次名（壳从档位表查；null = 只显示底分） */
  levelName: string | null;
  /** 记牌器权益门（壳的统一判定表结果） */
  cardCounterGate: boolean;
  /** 重新发牌横幅（壳的 `useRedealNotice`） */
  redealVisible: boolean;
  redealEpoch: number;
  dealEnterMode: "deal" | "redeal";
}>();

const emit = defineEmits<{
  (e: "bid", grab: boolean): void;
  (e: "play", cards: Card[]): void;
  (e: "pass"): void;
  (e: "trustee", on: boolean): void;
  /** 「更多」弹层入口（状态在壳：`moreOpen`） */
  (e: "more"): void;
  /** 顶栏「返回大厅」；等待房/结算/进行中的不同处置由壳判定 */
  (e: "leave"): void;
}>();

const viewport = useLandscapeViewport();

const view = computed(() => props.view);
const mySeat = computed(() => props.mySeat);
const hand = computed<readonly Card[]>(() => props.view?.hand ?? []);
const cardCounts = computed<readonly number[]>(() => props.view?.cardCounts ?? [0, 0, 0]);
const bottomCards = computed(() => props.view?.bottomCards ?? null);
const recentActions = computed(() => props.view?.recentActions ?? []);
const trustees = computed<readonly boolean[]>(() => props.view?.trustees ?? [false, false, false]);
const landlordSeat = computed<number | null>(() => props.view?.landlordSeat ?? null);
const isBidding = computed(() => props.view?.state === "bidding");
const isPlaying = computed(() => props.view?.state === "playing");
const isEnded = computed(() => props.view?.state === "ended");
/** 行动者：叫抢看 `bidPhase.currentBidder`，出牌看 `currentPlayer`（玩法 §9.1）。 */
const actorSeat = computed<number | null>(() => {
  const v = props.view;
  if (!v) return null;
  return v.state === "bidding" ? (v.bidPhase?.currentBidder ?? null) : v.currentPlayer;
});
const isMyTurn = computed(
  () => actorSeat.value !== null && actorSeat.value === props.mySeat,
);
/** 缺字段兜底（R661：探针注入的残缺视图没有这些段）。 */
const bidKind = computed<"call" | "rob">(() => props.view?.bidPhase?.kind ?? "call");
const bidDecisions = computed(() => props.view?.bidPhase?.decisions ?? []);
const hudMultiplier = computed<number | null>(
  () => props.view?.bidPhase?.bidMultiplier ?? null,
);
const hudBombCount = computed<number | null>(() => props.view?.playPhase?.bombCount ?? null);
const sceneBase = computed<number | null>(() => props.view?.baseScore ?? null);
const sceneName = computed<string | null>(() => props.levelName);
const clockUrgent = computed(() => props.seconds > 0 && props.seconds <= 5);

/**
 * 记牌器布局宽 / 等比缩小因子（原 `table.vue` 的实现原样迁移）。
 * 从 DOM 实时读 `offsetWidth`，几何推导基于画布设计宽与 back 按钮宽度。
 */
const counterLayoutW = ref(0);
function measureCounter(): void {
  const el = document.querySelector(".counter.table__bar-counter") as HTMLElement | null;
  if (el) counterLayoutW.value = el.offsetWidth;
}
onMounted(async () => {
  await nextTick();
  measureCounter();
});
watch(
  () => props.cardCounterGate,
  async (on) => {
    if (!on) return;
    await nextTick();
    measureCounter();
  },
);
const counterScale = computed(() => {
  const layoutW = counterLayoutW.value;
  if (layoutW <= 0) return 1;
  const { w, h, insets } = viewport.value;
  if (!(w > 0 && h > 0)) return 1;
  const m = layoutMetrics(w, h, insets);
  const halfBackCards = 56;
  const leftPad = 46;
  const safetyGap = 10;
  const available = m.width / 2 - halfBackCards - leftPad - safetyGap;
  const scale = available / layoutW;
  return Math.min(1, Math.max(0.65, scale));
});
const counterCompensate = computed(() => {
  const layoutW = counterLayoutW.value;
  if (layoutW <= 0) return "0px";
  return `${Math.round(layoutW * (1 - counterScale.value))}px`;
});

/**
 * 已选中的牌：`hand` 的**下标**（牌实例），不是牌值（R173/N18）。
 */
const selected = ref<number[]>([]);

/** 手牌内容/顺序变化 ⇒ 清空选中（R696：按 `(r,s)` 建指纹，不用 `join(',')`）。 */
watch(
  () => hand.value.map(cardKey).join(","),
  () => {
    selected.value = [];
  },
);

/** 我的托管态：唯一来源 `view.trustees[mySeat]`（机器人座位恒 false）。 */
const myTrustee = computed<boolean>(() => {
  const seat = props.mySeat;
  return seat === null ? false : (trustees.value[seat] ?? false);
});

/**
 * 两个对手按**牌桌方位**排列：`[左列座位, 右列座位]`（逆时针：下家在右、上家在左）。
 */
const seats = computed<[number, number]>(() => {
  const me = props.mySeat;
  if (me === null) return [0, 1];
  return [(me + 2) % 3, (me + 1) % 3];
});

/**
 * 桌面历史（协议 ④）：每槽至多一项，按发生顺序取该座位最后一项。
 */
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

/**
 * 叫抢措辞（协议③/⑦）：原样取服务端字段，前端零反推。
 */
const BID_LABEL: Record<"call" | "rob", { grab: string; pass: string }> = {
  call: { grab: "叫地主", pass: "不叫" },
  rob: { grab: "抢地主", pass: "不抢" },
};
function bidWord(d: { kind: "call" | "rob"; grab: boolean }): string {
  return d.grab ? BID_LABEL[d.kind].grab : BID_LABEL[d.kind].pass;
}
function bidEchoOf(seat: number): string | null {
  const list = bidDecisions.value;
  for (let i = list.length - 1; i >= 0; i -= 1)
    if (list[i]!.seat === seat) return bidWord(list[i]!);
  return null;
}
const showBidEcho = computed(() => isBidding.value);
const myBidEcho = computed(() =>
  showBidEcho.value && props.mySeat !== null ? bidEchoOf(props.mySeat) : null,
);
const leftBidEcho = computed(() =>
  showBidEcho.value && seats.value[0] !== undefined ? bidEchoOf(seats.value[0]) : null,
);
const rightBidEcho = computed(() =>
  showBidEcho.value && seats.value[1] !== undefined ? bidEchoOf(seats.value[1]) : null,
);

function nameOf(seat: number): string {
  if (seat === props.mySeat) return "我";
  return props.seatNames[seat] || `玩家${seat}`;
}

/** 座位余额（壳从 store 投影；null = 不显示金币位）。 */
function seatBalance(seat: number): number | null {
  return props.balances[seat] ?? null;
}

/** 一个对手座位的全部 props（片① 横屏三区；语义与原页面逐字相同）。 */
function seatProps(seat: number) {
  return {
    seat,
    name: nameOf(seat),
    cardCount: cardCounts.value[seat] ?? 0,
    isLandlord: landlordSeat.value === seat,
    isActive: actorSeat.value === seat,
    balance: props.balances[seat] ?? null,
    baseScore: props.view?.baseScore ?? 0,
    trustee: trustees.value[seat] ?? false,
    showBacks: true,
    size: "opponent" as const,
  };
}

/** 对手出牌/状态列里倒计时钟的 props（秒数来自壳的唯一 `useCountdown`）。 */
function timerProps(seat: number) {
  return {
    active: actorSeat.value === seat,
    seconds: props.seconds,
  };
}

/** 收 `hand` 的**下标**。 */
function toggleCard(index: number) {
  const at = selected.value.indexOf(index);
  if (at >= 0) selected.value.splice(at, 1);
  else selected.value.push(index);
  haptic("light");
}

/** 滑动选牌（批量追加/移除选中下标；同 `toggleCard` 语义）。 */
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

function bid(grab: boolean): void {
  emit("bid", grab);
}

function play(): void {
  if (selected.value.length === 0) return;
  if (!isLegalLocal.value) return;
  const cards = selected.value
    .map((index) => hand.value[index])
    .filter((value): value is Card => value !== undefined);
  if (cards.length === 0) return;
  emit("play", cards);
}

function pass(): void {
  emit("pass");
}

/**
 * 项 ⑤：出牌提示（规则委托 `protocol.parseHand`/`canBeat`；只选牌，不代替出牌）。
 */
const hintIndex = ref(0);
watchEffect(() => {
  void props.view?.version;
  hintIndex.value = 0;
});
const beatTarget = computed(() => {
  const me = props.mySeat;
  if (me === null || me === undefined) return null;
  return buildBeatTarget(recentActions.value, me);
});
const hintCandidates = computed(() => {
  if (!isMyTurn.value || !isPlaying.value) return [];
  const me = props.mySeat;
  if (me === null || me === undefined) return [];
  if (!hand.value || hand.value.length === 0) return [];
  return suggestPlays(hand.value, beatTarget.value);
});
const cannotBeat = computed(
  () => beatTarget.value !== null && !hasBeatablePlay(hand.value, beatTarget.value),
);
const isLegalLocal = computed<boolean>(() => {
  const cards = selected.value.map((i) => hand.value[i]!).filter(Boolean);
  if (cards.length === 0) return false;
  let parsed: BeatTarget;
  try {
    parsed = parseHand(cards as Card[]);
  } catch {
    return false;
  }
  if (parsed.type === HandType.Invalid) return false;
  const target = beatTarget.value;
  if (target === null) return true;
  return canBeat(parsed, target);
});
const isLandlord = computed(() => landlordSeat.value === props.mySeat);
const passOnly = computed(() => beatTarget.value !== null && cannotBeat.value);
const canPass = computed(() => beatTarget.value !== null || !isLandlord.value);
const firstPlayDual = computed(
  () => !canPass.value && !passOnly.value && !cannotBeat.value,
);
function onHint(): void {
  const candidates = hintCandidates.value;
  if (!hand.value || hand.value.length === 0 || candidates.length === 0) return;
  const picked = candidates[hintIndex.value % candidates.length]!;
  hintIndex.value = (hintIndex.value + 1) % candidates.length;
  const pickedSet = new Map<number, number>();
  for (const c of picked.cards) pickedSet.set(c.r, (pickedSet.get(c.r) ?? 0) + 1);
  const indices: number[] = [];
  for (let i = 0; i < hand.value.length && pickedSet.size > 0; i++) {
    const r = hand.value[i]!.r;
    const need = pickedSet.get(r);
    if (need && need > 0) {
      indices.push(i);
      const left = need - 1;
      if (left === 0) pickedSet.delete(r);
      else pickedSet.set(r, left);
    }
  }
  selected.value = indices;
}

function onTrustee(on: boolean): void {
  emit("trustee", on);
}
</script>
<template>
  <view
      class="table"
      :style="{
        '--ftl-counter-scale': counterScale,
        '--ftl-counter-compensate': counterCompensate,
      }"
    >
      <!--
        ⚠️ **本注释必须在根元素内部**：**模板注释**放在根元素**之前**会让整页变成**多根**页面
        （编译产物 `_createElementBlock(_Fragment, …)`），`@vue/test-utils` 的 `wrapper.classes()`
        于是静默返回 `[]`。由 `table-hud.test.ts` 的「单根闸」钉住。

        标签映射（派工单 A）：`section/header/div → view`、`span/p → text`；`button` 保持。

        片② 四区（spec §2.2 / R729 / R735 / R736）+ 片③ D16 的顶栏瘦身：
          ① `.table__bar`      顶栏三段：左（返回大厅·阶段状态）/ 中（底牌·倍数徽章）/ 右（**更多**）
          ② `.table__mid`      中段：两家对手分列左右 · **每一侧各一格出牌位**（协议④ 窗口 2）·
                               **中央**（场次名+底分 → 回显 → **动作区** → 中央钟，§3.2 的顺序）
          ③ `.table__me`       我的区域：**手牌在前** → 座位行 → HUD（R736）
          ④ `.table__actions`  **中央动作区**（片③ R735 退役：从「绝对定位浮层」**搬进** `.table__center`）

        🔴 **D16（片③ spec §3.1 / 用户裁决）**：背包 / 设置两个入口从顶栏**收进二级弹层**
        （`MoreMenu.vue`，由右段的「更多」打开）。记牌器入口（记牌器片）已移到本栏左侧的
        `.table__counter`（服务端开关 `cardCounterEnabled` 门控）；**托管按钮（挂机治理 C27）
        2026-10-18 用户裁决移到本栏右侧的 `.table__trustee`（「更多」左边）**，都不属于弹层。
        收进弹层时它们全是 `disabled` 占位（D16 只裁决「收进弹层」）；此后逐片翻活：设置（A 档第①片）
        —— 弹层内现只剩**背包**是占位。

        ⚠️ **锚点一个不改**：`.table__bar .btn`（逐字「返回大厅」，探针按**文本**匹配）· `.table__me .card`
        （只数得到手牌，R660）· `.table__me-foot`（底部信息条：头像件 + 昵称/金币/HUD 信息簇）·
        `.table__play` /
        `.table__pass` / `.table__bid-grab` / `.table__bid-pass` —— 都是真浏览器探针与 4 张牌桌测试的锚点。
        ⚠️ 提示锚点已从 `.table__notice` 迁到 `NoticeStack` 的 `[data-notice-id]` /
        `.notice__text`（Task 10；`scripts/browser-e2e.mjs` 的同步在 Task 11）。
        ⚠️ `.table__bar` 必须仍含**阶段状态文字**（`table-ended-ui:103-105` 读的是它的文本）⇒ R730。
        ⚠️ `.table__more`（更多）是**活按钮** —— 它真的有反应（打开弹层），不是占位那一类。
        ⚠️ 弹层内两个 `table__art-btn` 与它们的 `.table__art-btn` 样式都在 `MoreMenu.vue`
        （`scoped` 样式不跨组件）；顶栏的托管按钮样式在**本文件**（`.table__trustee--on`）。
      -->
      <view class="table__bar">
        <view class="table__bar-left">
          <!--
            返回大厅（纯 ← 图标按钮，行为按相位分流：等待房/结算 = 只导航；
            进行中 = 确认退出 + room.leave）——见 `emit("leave")`。
          -->
          <button
            type="button"
            class="btn btn--small table__lobby-back"
            aria-label="返回大厅"
            @click="emit('leave')"
          >
            <image class="table__lobby-back-icon" src="/static/ui/back_arrow.png" mode="aspectFit" />
          </button>
          <!--
            记牌器横条：紧挨返回按钮。用户裁决：不挤底牌（底牌在 center 保持居中）。
          -->
          <CardCounter
            v-if="cardCounterGate && !settlementRevealed"
            class="table__bar-counter"
          />
        </view>

        <!--
          中：底牌居中 + 倍数徽章浮动在底牌右下角（不挤底牌）。
        -->
        <view class="table__bar-center">
          <BottomCards :cards="bottomCards ?? null" />
          <view class="table__badge">
            <text class="table__badge-value">{{ hudMultiplier ?? "—" }}</text>
            <text class="table__badge-unit">倍</text>
          </view>
        </view>

        <!--
          右：**托管（挂机治理 C27）+ 更多**。2026-10-18 用户裁决：托管从「更多」弹层搬到
          **顶栏右侧、更多左边**（一键可达，不藏在二级弹层里）。
          - 托管是**受控 toggle**：状态唯一来源 `PlayerView.trustees[自己的座位]`，点击只发
            `game.trustee{on:!当前}`；只在对局进行中（叫抢/出牌）渲染 —— 等待房未开局
            （服务端 GAME_NOT_STARTED 拒）、结算揭示时让位。
          - 「更多」—— 弹层入口（D16）。**它是活按钮**（它真的有反应：打开弹层）。
        -->
        <view class="table__bar-right">
          <button
            v-if="!settlementRevealed && (isBidding || isPlaying)"
            type="button"
            class="btn btn--small table__trustee"
            :class="{ 'table__trustee--on': myTrustee }"
            :aria-pressed="myTrustee"
            @click="onTrustee(!myTrustee)"
          >
            托管
          </button>
          <button
            v-if="!settlementRevealed"
            type="button"
            class="btn btn--small table__more"
            @click="emit('more')"
          >
            更多
          </button>
        </view>
      </view>

      <!--
        阶段状态（叫抢中/出牌中/已结束/...）：**牌桌中央绝对定位**（参考欢乐斗地主），
        不再嵌在顶栏里。由 `.table__bar` 之外的独立层承载。
        ⚠️ 探针 `table-ended-ui:103-105` 断言 **`.table__bar` 文本**含状态文字 ——
        那个断言需同步改为读 `.table__phase` 所在层的文本。
      -->
      <view
        v-if="!settlementRevealed"
        class="table__phase-overlay"
      >
        <!--
          重新发牌横幅（2026-10-22 片）：D8 的文案、D11 的「只在叫抢期」由 composable 保证。
          `:key="redealEpoch"`：2 秒内第二次重发时重建元素 ⇒ CSS 生命周期动画重播。
          `--ftl-redeal-ms` 与 `REDEAL_BANNER_MS` 同源（animations.test.ts 有跨文件闸）。
        -->
        <view
          v-if="redealVisible"
          :key="redealEpoch"
          class="table__redeal-banner anim-redeal-banner"
          :style="{ '--ftl-redeal-ms': `${REDEAL_BANNER_MS}ms` }"
        >
          <text class="table__redeal-text">都不叫，重新发牌</text>
        </view>
        <text v-else-if="isBidding" class="table__phase">叫抢中</text>
        <text v-else-if="isPlaying" class="table__phase">出牌中</text>
        <text v-else-if="isEnded" class="table__phase">已结束</text>
        <text v-else class="table__phase">{{
          view?.state ?? "等待发牌"
        }}</text>
      </view>

      <!--
        就地提示（`table-local` / `table-12003`）与会话提示（连接/系统/action）已迁入
        `NoticeStack` 浮层（Task 10，挂 `LandscapeStage` 的 `overlay` 槽）：浮层不参与
        文档流，出现/消失不会把牌桌中段挤走位；同一条拒绝只出现一次（本地项仅覆盖
        「忙锁」与 12003，其余服务端错误由 session notice 独占）。
      -->

      <view v-if="waitingForDeal" class="table__waiting"
        >已进房，等待服务端发牌…</view
      >

      <template v-else>
        <!--
          ② 中段（R726 + 2026-10-11 第三轮布局调整）：
          左座位 → 左出牌/状态列 → 中央 → 右出牌/状态列 → 右座位。

          🔴 **对手的出牌/状态列是同一条固定带**（用户裁决，参考欢乐斗地主）：
          左右两列同属 `.table__mid` 这一行、同高拉伸、垂直居中 ⇒ 两家的牌永远在同一
          水平线上，不再一上一下；列内牌多允许**换行**（不挤按钮、不挤手牌）。
          列内共用这一格：倒计时钟（`TurnTimer`，88×92 与我的中央钟同档，靠头像一侧）·真有牌的一手（`PlayArea`）
          ·「不出」（`cards: null`，`.table__play-pass`）·叫抢回显（`.table__play-bid-echo`，
          只在叫抢期）。
          ⚠️ 只有真有牌的一手才挂 PlayArea；空窗口下列里可能只有钟（轮到他）或什么都没有。
          ⚠️ `.table__center` 必须**常驻**，否则两侧座位会挤到中间去。
        -->
        <view class="table__mid">
          <Seat v-bind="seatProps(seats[0]!)" class="table__seat" />
          <view class="table__play-col table__play-col--left">
            <TurnTimer v-bind="timerProps(seats[0]!)" />
            <PlayArea
              v-if="leftAction && leftAction.cards"
              class="table__played-slot"
              :cards="leftAction.cards"
            />
            <!-- 对手的「不出」（协议④：cards 为 null）：与牌、钟同处出牌/状态带。 -->
            <text
              v-else-if="leftAction && leftAction.cards === null"
              class="table__play-pass anim-toast-in"
              >不出</text
            >
            <!-- 对手的叫抢回显（协议⑦）：挂出牌/状态列，不再挂座位（2026-10-11 第五轮裁决）。 -->
            <text
              v-if="leftBidEcho"
              class="table__play-bid-echo anim-toast-in"
              >{{ leftBidEcho }}</text
            >
          </view>
          <view class="table__center">
            <!--
              场次名 + 底分（协议⑥ / §3.2）。参考图 3/4/5/6 里这一块就在中央偏上。
              🔴 **查不到名字就不编**（`viewLevelName` 返回 null ⇒ 只显示底分）；
              🔴 `view.baseScore` 缺失时（探针注入的残缺视图）**整块不显示**，不得抛错（R661）。
              数字**原样来自服务端**，本处一个字节都不换算（R659 的另一半见 `table-bid-ui.test.ts`）。
              🔴 **出牌期只退场「场名」**（走查修复 P0-4）：大字场名在出牌期与中央出牌区争
              纵向空间；但**底分一行保留** —— §3.2 要求出牌期页面仍能读到服务端底分
              （`table-bid-ui` 在 playing 态有「底分 15」正对照），HUD 刻意不放底分（R654）。
              叫抢期两行都在。
            -->
            <view v-if="sceneBase !== null" class="table__scene">
              <text
                v-if="sceneName !== null && !isPlaying"
                class="table__scene-name"
                >{{ sceneName }}</text
              >
              <text class="table__scene-base">底分 {{ sceneBase }}</text>
            </view>
          </view>
          <view class="table__play-col table__play-col--right">
            <TurnTimer v-bind="timerProps(seats[1]!)" />
            <PlayArea
              v-if="rightAction && rightAction.cards"
              class="table__played-slot table__played-slot--right"
              :cards="rightAction.cards"
              :mirror="true"
            />
            <text
              v-else-if="rightAction && rightAction.cards === null"
              class="table__play-pass anim-toast-in"
              >不出</text
            >
            <!-- 对手的叫抢回显（协议⑦）：挂出牌/状态列，不再挂座位（2026-10-11 第五轮裁决）。 -->
            <text
              v-if="rightBidEcho"
              class="table__play-bid-echo anim-toast-in"
              >{{ rightBidEcho }}</text
            >
          </view>
          <Seat
            v-bind="seatProps(seats[1]!)"
            class="table__seat table__seat--right"
            :mirror="true"
          />
        </view>

        <!--
          ③/④ 我的出牌 + 动作**共用同一条固定行**（2026-10-11 第三轮布局调整，用户裁决）：
          「我出牌的位置就是按钮的位置；出牌后按钮消失」—— 行恒渲染、高度锁死
          （`$ftl-size-action-bar-h`，容得下 mid 牌 117），各态切换时手牌不跳：
            · 叫抢期（轮到我）：BidPanel 两颗按钮 + 中间中央钟；
            · 出牌期轮到我：出牌 / 过牌按钮 + 中央钟（窗口里残留我上一手也**先显按钮** ——
              新轮次由我重新出牌，服务端窗口推进后旧手不留在位）；
            · 出牌期**不是我的回合**：我刚出的牌显示在原按钮位（按钮必须**不存在**，
              不是 disabled）；我刚「不出」则原位显示「不出」；
            · 等待 / 终局：占位文字。
          ⚠️ 我出的牌在 `.table__me` **之外**（放进去 `.table__me .card` 会数到 18，R660）。
          ⚠️ `.table__play` / `.table__pass` / `.table__bid-grab` / `.table__bid-pass` 仍是
          探针与测试锚点，class 与逐字文案一个字不改（探针走 DOM `.click()`，不受视觉遮挡影响）。
        -->
        <view class="table__action-bar">
          <!--
            叫抢（➏）：**只在轮到我时**渲染按钮行（2026-10-13 真机走查：非我轮次按钮整个
            不渲染，不是 disabled —— 与出牌相位「不是我的回合 ⇒ 出牌/过牌按钮消失」同款纪律）。
            行动者由服务端的 bidPhase.currentBidder 决定（actorSeat），前端不做规则判断，
            这里只做**展示门控**；`disabled` 只剩 `busy`（本行只在轮到我时存在）。
            措辞（`kind`）同样**只**来自服务端 `bidPhase.kind`（协议③）——
            页面**不**由 grabActions/landlordCandidate 反推（R657 改形态后的红线）。
          -->
          <template v-if="isBidding && isMyTurn && !settlementArrived">
            <view class="table__actions">
              <BidPanel
                :disabled="busy"
                :kind="bidKind"
                @grab="bid(true)"
                @pass="bid(false)"
              >
                <view
                  class="table__clock"
                  :class="{
                    'table__clock--urgent': clockUrgent,
                    'anim-urgent-pulse': clockUrgent,
                  }"
                >
                  <text
                    class="table__clock-value"
                    :class="{
                      'table__clock-value--urgent': clockUrgent,
                      'table__clock-value--digits-2':
                        seconds >= 10 && seconds <= 99,
                      'table__clock-value--digits-3': seconds >= 100,
                    }"
                  >
                    {{ seconds }}s
                  </text>
                </view>
              </BidPanel>
            </view>
          </template>
          <!--
            叫抢期不是我的回合：我刚做的决策显示在**出牌区域**（动作行，2026-10-17 用户裁决：
            不再占中央）；没有决策则显示等待语。
            结算延迟片：settlement 已到（ended 视图可能缺失）时两支都让位给「本局结束」。
          -->
          <text
            v-else-if="isBidding && !settlementArrived && myBidEcho"
            class="table__my-bid-echo anim-toast-in"
            >{{ myBidEcho }}</text
          >
          <text v-else-if="isBidding && !settlementArrived" class="table__muted"
            >等待其他玩家…</text
          >
          <!-- N17：终局没有下一步动作。**不得**在这里读 winner 拼结果文案（M07：结果只由
               game.finished / game.settlement 渲染）——这里只说明「没有动作可做了」。
               结算延迟片：ended 下若窗口里有我的最后一手，先渲染它（不读 winner）；
               没有时保持「本局结束」。 -->
          <template v-else-if="isEnded">
            <PlayArea
              v-if="myAction && myAction.cards"
              class="table__my-play"
              :cards="myAction.cards"
            />
            <text v-else class="table__ended">本局结束</text>
          </template>
          <!-- 结算已到但 ended 视图缺失/迟到（fail-safe）：不给任何动作入口。 -->
          <text v-else-if="settlementArrived" class="table__ended">本局结束</text>
          <!--
            出牌期轮到我：按钮行（**过牌 / 提示 / 出牌** + 中央钟）。
            🔴 **按钮顺序（2026-10-18 用户裁决）**：左「过牌」→ 中央「倒计时」→ 右「提示」「出牌」；
            钟必须保持在**正中央**（`.table__actions--playing` 的 `1fr auto 1fr` 网格把两侧配平，
            与按钮宽度无关）。
            🔴 **按钮行优先于我上一手的回显**：新一轮又轮到我时按钮必须在位
            （测试夹具与真实「两家pass后我重新出牌」同形）。
            🔴 **「要不起」保守隐藏**：跟牌且穷尽判定无任何一手能压过目标（`cannotBeat`）时，
            只留钟 + 过牌，出牌/提示两按钮整个不在 DOM（不是 disabled）；首出恒全在。
            钟与过牌任何情况下都不加 v-if。
          -->
          <view
            v-else-if="isPlaying && isMyTurn && !settlementArrived"
            class="table__actions table__actions--playing"
            :class="{ 'table__actions--pass-only': passOnly }"
          >
            <view class="table__actions-side table__actions-side--left">
              <!-- 正常四件 / 非地主首出：过牌在左 -->
              <button
                v-if="canPass && !passOnly"
                type="button"
                class="btn table__pass"
                :disabled="busy"
                @click="pass"
              >
                过牌
              </button>
              <!-- 地主首出：提示移到钟左边 → 对称（左提示 右出牌） -->
              <button
                v-else-if="firstPlayDual"
                type="button"
                class="btn table__hint"
                :disabled="busy || hintCandidates.length === 0"
                @click="onHint"
              >
                提示
              </button>
            </view>
            <view
              class="table__clock"
              :class="{
                'table__clock--urgent': clockUrgent,
                'anim-urgent-pulse': clockUrgent,
              }"
            >
              <text
                class="table__clock-value"
                :class="{
                  'table__clock-value--urgent': clockUrgent,
                  'table__clock-value--digits-2':
                    seconds >= 10 && seconds <= 99,
                  'table__clock-value--digits-3': seconds >= 100,
                }"
              >
                {{ seconds }}s
              </text>
            </view>
            <view class="table__actions-side table__actions-side--right">
              <!-- pass-only（要不起）：过牌移到钟**右边**（用户裁决 2026-10-19） -->
              <button
                v-if="passOnly"
                type="button"
                class="btn table__pass"
                :disabled="busy"
                @click="pass"
              >
                过牌
              </button>
              <!-- 正常四件 / 非地主首出：提示在右（地主首出时提示已移到左边） -->
              <button
                v-if="!cannotBeat && !firstPlayDual"
                type="button"
                class="btn table__hint"
                :disabled="busy || hintCandidates.length === 0"
                @click="onHint"
              >
                提示
              </button>
              <button
                v-if="!cannotBeat"
                type="button"
                class="btn btn--primary table__play"
                :disabled="busy || selected.length === 0 || !isLegalLocal"
                @click="play"
              >
                出牌（{{ selected.length }}）
              </button>
            </view>
          </view>
          <!-- 出牌期不是我的回合：我刚出的牌占原按钮位（按钮整个不存在）。 -->
          <PlayArea
            v-else-if="isPlaying && !settlementArrived && myAction && myAction.cards"
            class="table__my-play"
            :cards="myAction.cards"
          />
          <!-- 我刚「不出」：原按钮位只显示「不出」（协议④ 服务端窗口原话）。 -->
          <text
            v-else-if="isPlaying && !settlementArrived && myPassEcho"
            class="table__my-pass anim-toast-in"
            >{{ myPassEcho }}</text
          >
          <!-- 其余出牌期等待态（窗口里还没有我的这一手）。 -->
          <text v-else-if="isPlaying" class="table__muted"
            >等待其他玩家…</text
          >
        </view>

        <view class="table__me">
          <!--
            手牌：2026-10-10 起（用户裁决）**恒按点数降序**展示 —— 旧的三颗理牌按钮
            （默认/点数升序/点数降序）整组删除，欢乐斗地主底栏不放它们。
            ⚠️ 排序仍只改**展示顺序**（Hand 的 R662：order 是原始下标数组，toggle 恒发原始下标）。
          -->
          <Hand
            :key="redealEpoch"
            :cards="hand"
            :interactive="interactive"
            :selected="selected"
            :enter="dealEnterMode"
            sort="desc"
            size="normal"
            reflow
            empty-text="手牌为空"
            @toggle="toggleCard"
            @swipe-select="onSwipeSelect"
            @swipe-deselect="onSwipeDeselect"
          />
          <!--
            挂机治理 C4′（本片）：托管中遮罩。
            - 只在**自己**托管且对局进行中显示；状态唯一来源 `PlayerView.trustees[mySeat]`。
            - 只盖 `.table__me`（手牌 + 底部信息条），不挡牌桌中段与动作行（观战/预选牌仍可用）。
            - 点击「取消托管」走既有 `game.trustee{on:false}`；**不做本地翻转**，消失只认服务端视图。
            - `@click.stop`：防误触手牌/外层点击。
          -->
          <view
            v-if="myTrustee && !settlementRevealed && (isBidding || isPlaying)"
            class="table__trustee-mask"
            @click.stop
          >
            <text class="table__trustee-title">托管中</text>
            <text class="table__trustee-desc">轮到你时将自动出牌</text>
            <button
              type="button"
              class="btn btn--primary table__trustee-cancel"
              :disabled="busy"
              @click="onTrustee(false)"
            >
              取消托管
            </button>
          </view>
          <!--
            底部信息条（第七轮用户裁决）：**头像 + 昵称/金币在左下角成一组**（meta 件紧贴头像
            右侧、与头像下缘对齐）；倍数/炸弹/房间（HUD）无底色浮在右下角。
            同一座位挂两个 Seat 实例各取一件（part 约定见 Seat），摆放靠 .table__me-foot/info 的 CSS。
          -->
          <view class="table__me-foot">
            <Seat
              :seat="mySeat ?? 0"
              :name="nameOf(mySeat ?? 0)"
              :card-count="hand.length"
              :is-landlord="landlordSeat === mySeat"
              :is-active="actorSeat === mySeat"
              :balance="seatBalance(mySeat ?? 0)"
              :base-score="sceneBase ?? 0"
              :trustee="myTrustee"
              size="me"
              part="avatar"
            />
            <view class="table__me-info">
              <Seat
                :seat="mySeat ?? 0"
                :name="nameOf(mySeat ?? 0)"
                :card-count="hand.length"
                :is-landlord="landlordSeat === mySeat"
                :is-active="actorSeat === mySeat"
                :balance="seatBalance(mySeat ?? 0)"
                :base-score="sceneBase ?? 0"
                :trustee="myTrustee"
                size="me"
                part="meta"
              />
              <!--
                HUD（R654 / R661）：倍数 / 炸弹**个数** / 房间（弱化），三项一律**原样**展示。
                ⚠️ 模板在 `TableHud.vue` 里，**一个字都不改** —— `.hud__item--room` 的文本被
                `table-hud.test.ts:211` 断言为 `房间 R1`，且标签与数值之间的**那个空格是判据的一部分**。
              -->
              <TableHud
                :multiplier="hudMultiplier"
                :bomb-count="hudBombCount"
                :room-code="roomCode"
              />
            </view>
          </view>

          <!--
            ④ 动作区：**已搬到 `.table__action-bar`**（手牌正上方的独立整行，见上方）。
            历史：片③ 之前它是挂在 `.table__me` 内、以本块上缘为基准的绝对定位浮层；
            片③ 搬进 `.table__center`；2026-10-11 因「对手出牌推动按钮」落到独立行。
            ⚠️ 本块里剩下的三件仍受上方 ③ 的「都留在 `.table__me` 内」约束（别顺手往外挪）。
          -->
        </view>

        </template>

        <!--
          ⑤ 结算 / 二级弹层 / 连接浮层由**壳**持有并通过 `#overlays` 槽渲染：
          结算遮罩（`.table__scrim`）、Settlement、MoreMenu、ConnectionOverlay。
          ⚠️ 槽内容留在 `.table` 根元素之内（弹层/遮罩的定位基准正是它）。
        -->
        <slot name="overlays" />
      </view>
</template>

<style scoped lang="scss">
@import "../../../styles/animations.scss";
/**
 * 移动端优先的牌桌布局（375px 逻辑宽 / 1500px）。
 *
 * 与桌面优先版的差别：
 *  - 容器不再按 720px 设计：卡片宽度收到 `$ftl-card-w`，并在**手牌区**用重叠（`.card + .card`
 *    的负 `margin-left`，R671：负 `gap` 非法、会被三端直接丢弃）保证 17~20 张牌在单行内可读
 *    （见 `.table__me :deep(.hand)`）——所以容器给了 `row-gap`。
 *  - 操作区按钮高度提到 `$ftl-control-h`（176px ≈ 44px），拇指可点。
 *  - 座位区三列仍在一行，但内边距/字号收紧。
 */
.table {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  /**
   * 片②（spec §2.2）：参考图的分区是**全出血**的（间隙极小）⇒ 用最小阶，
   * 把省下的高度留给中段。原来的 `$ftl-space-5`(12) 会在四个分区之间吃掉 36px。
   */
  gap: $ftl-space-2;
  /* 铺满画布：2026-10-11 起画布是**全出血自适应**设计区（设计宽 ≥1334、高 ≥750，
     尺寸随视口宽高比变化，见 useLandscapeCanvas.layoutMetrics）；本块 100% 吃满，
     非 16:9 多出来的空间由本页 flex 布局自然吸收。旧竖屏稿的 max-width/margin 已删。 */
  width: 100%;
  height: 100%;
  padding: $ftl-space-2 $ftl-space-5;
  /* 🔴 **还留着的消费者**（片③-B 修复轮核过，别顺手删）：`MoreMenu` 弹层（它的
     `position: absolute` 以本块为定位基准）与结算遮罩 `.table__scrim`（absolute 铺满本块）。
     ⚠️ 片③ 起本块**不再**为动作区服务 —— 那条「动作条浮层的定位上下文（R735）」已退役。 */
  position: relative;
  /**
   * ⚠️ **底纹不在这里**（R713）：它只在 `LandscapeStage` 铺**一层**。
   *
   * 本页原先自己铺过一份（R704 的落地）—— 画布接管之后**必须删掉它**：
   * `transform: scale(k)` 让画布内外的缩放比不同，两层底纹会**错位**。
   * ⇒ 判据（R713 **改形态后** · Task B7/B89）：**铺底纹的写法**与**映射表里的图名**
   * （含 `/static/ui/` 前缀）都只允许出现在 `LandscapeStage.vue`，且表里每张图都在盘上
   * （`landscape-canvas.test.ts` ⑤，三条断言）。
   *
   * `.table__center` / `.table__me` / `.seat` 各自的**实色底仍然保留** ——
   * 牌面与文字永远在实色块上，不被底纹干扰（R704 时期加的可读性护栏，继续有效）。
   */
}
/**
 * 顶栏（R729 / D16）：**三段**。左（返回大厅·阶段状态）/ 中（底牌·倍数徽章）/ 右（「更多」→ 二级弹层）。
 * ⚠️ `min-height` 取参考图实测的 64（那是**内容范围**，不是硬性容器高）。
 * ⚠️ 左/右两段的容器样式仍然共用一条规则（两段都是「内容宽的横排组」）——
 * 右段从三个占位按钮收成一个「更多」之后它依然成立，**不得**因为「只剩一个元素」就删掉。
 */
.table__bar {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
  min-height: $ftl-bar-h;
}
.table__bar-left,
.table__bar-right {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $ftl-space-3;
}
/**
 * 托管中（C27；2026-10-18 顶栏化）：金色描边 + 暖字，与「未托管」的普通按钮形成可辨差异。
 * ⚠️ 只动 `border-color` / `color`（不碰 `background*`）—— `.btn` 的贴图来自
 * `background-image`，用 `background` 简写会把它整条重置掉。
 */
.table__trustee--on {
  border-color: $ftl-color-gold-deep;
  color: $ftl-color-gold-light;
}
/**
 * 顶栏中央段：绝对定位到 bar 的几何中心。
 * 🔴 不能用 flex 子项 —— bar-left（含记牌器）宽度会变，center 会被挤偏。
 */
.table__bar-center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  z-index: 1;
}
/** 覆盖 BottomCards 组件自带的 margin-left —— center 段紧凑模式不需要额外间距 */
.table__bar-center :deep(.bottom-cards) {
  margin-left: 0;
}
/** 倍数徽章浮动在底牌右下角，不挤底牌位置。 */
.table__bar-center .table__badge {
  position: absolute;
  right: -10px;
  bottom: -6px;
  z-index: 2;
}
/**
 * 记牌器等比缩小（2026-10-23 修复短机型与底牌重叠 · 按比例自适应）。
 *
 * JS 层已按画布设计宽 W 和 counter 自身布局宽算出两个 CSS 变量：
 *   --ftl-counter-scale      等比缩放因子（0.65 ~ 1.0）
 *   --ftl-counter-compensate 补偿宽度（像素），抵消 transform 不占布局位的副作用
 *
 * 本 CSS 块**零硬编码**：所有数值来自 JS 计算 + DOM 测量，CardCounter.vue 内部
 * 改列数/列宽/间距、或 table.vue 顶栏其他元素尺寸变动时，这里自动适配。
 *
 * transform-origin: left center 保证缩放从左边缘展开（向右缩），
 * 左边贴返回按钮，右边向底牌方向收窄。
 */
.table__bar-counter {
  transform: scale(var(--ftl-counter-scale, 1));
  transform-origin: left center;
  /* 负 margin 把 bar-left 的实际占位收窄到视觉宽度，避免撑满全宽 */
  margin-right: calc(-1 * var(--ftl-counter-compensate, 0px));
}
/**
 * 阶段状态遮罩层：绝对定位到牌桌中央（参考欢乐斗地主）。
 * 定位基准 = `.table`（position: relative），z-index 低于顶栏，高于牌桌内容。
 * 🔴 top: 28% 而非 50%：50% 正好砸在 action-bar（叫抢/出牌按钮行）上叠 UI。
 *    28% 落在 mid 上半段（座位头像之间），与 action-bar 垂直完全错开。
 */
.table__phase-overlay {
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
/**
 * 阶段状态文字：牌桌中央大字，加粗高可读。
 */
.table__phase {
  color: $ftl-color-gold;
  font-size: $ftl-font-lg;
  font-weight: 700;
  text-shadow: 0 2px 8px rgba($ftl-color-night-deep, 0.6);
  white-space: nowrap;
}
/**
 * 重新发牌横幅（2026-10-22 片）：金边深底牌匾，替代「叫抢中」显示约 2 秒。
 * ⚠️ **自身不写居中 transform** —— 居中是祖先 `.table__phase-overlay` 的
 *    `translate(-50%, -50%)`；本元素再写 transform 会与 `ftl-redeal-banner-life`
 *    的 `scale()` 互相覆盖。
 * ⚠️ `pointer-events: none`：横幅只是提示，不得拦截牌桌操作。
 */
.table__redeal-banner {
  display: flex;
  align-items: center;
  padding: $ftl-space-4 $ftl-space-7;
  border: $ftl-hairline solid $ftl-color-gold;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night-deep, 0.86);
  box-shadow:
    0 6px 24px rgba($ftl-color-night-deep, 0.5),
    0 0 16px rgba($ftl-color-gold, 0.35);
  pointer-events: none;
  white-space: nowrap;
}
.table__redeal-text {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-lg;
  font-weight: 700;
  letter-spacing: 2px;
  text-shadow: 0 2px 6px rgba($ftl-color-night-deep, 0.7);
}
/**
 * 倍数徽章（R719 / spec §3.5 素材槽；A′ 档接通）：只显示 `bidPhase.bidMultiplier` **原值**。
 * 参考图里它是一枚白底橙边、**略微倾斜**的牌 ⇒ 这里用 `rotate` 复刻那个形态。
 *
 * A′ 档：素材 `bid-badge.png` 200×110 自带白瓷底 + 橙金双线内框（圆角之外透明）⇒
 * 自造的橙边/白底保留为**图裂兜底**（图不透明，正常时把它们整圈盖在下面）；
 * padding 8/16 让 DOM 数字与「倍」字落在源图内框里（内框距外缘源图约 30px）。
 * 橙字配白瓷底可读；素材是正的，`rotate(-8deg)` 的斜是程序态、继续保留。
 * ⚠️ 倾斜只是观感，**不影响任何判据**（jsdom 不布局）。
 */
.table__badge {
  display: flex;
  align-items: baseline;
  gap: $ftl-space-2;
  padding: $ftl-space-2 $ftl-space-4;
  border: $ftl-hairline solid $ftl-color-accent;
  border-radius: $ftl-radius-sm;
  background-color: $ftl-color-surface;
  background-image: $ftl-art-bid-badge;
  background-size: 100% 100%;
  background-repeat: no-repeat;
  transform: rotate(-8deg);
}
.table__badge-value {
  color: $ftl-color-accent;
  font-size: $ftl-font-md;
  font-weight: 700;
}
.table__badge-unit {
  color: $ftl-color-accent;
  font-size: $ftl-font-xs;
}
/**
 * ⚠️ `.table__art-btn` 的占位样式（`opacity: .5` + 恒 `disabled`）**已随四个按钮搬进
 * `MoreMenu.vue`** —— `scoped` 样式只作用于本组件模板，把规则留在这里等于**没有样式**
 * （判据也搬走了：`test/more-menu.test.ts`）。
 */
/**
 * 牌桌提示的悬浮容器（Task 10 起）：`.table__notices` / `.table__notice` 宿主规则
 * 整块退役 —— 呈现统一由 `NoticeStack` 浮层承担（挂 `LandscapeStage` 的 `overlay` 槽，
 * 绝对定位、不参与文档流）。观感（浮在哪、遮不遮关键件）由真机截图复核。
 */
.table__waiting {
  padding: $ftl-space-9;
  text-align: center;
  color: $ftl-color-text-muted;
  font-size: $ftl-font-md;
}
/**
 * 中段（片② R726 + 协议④）：**左座位 → 左出牌位 → 中央 → 右出牌位 → 右座位**。
 *
 * ⚠️ 片① 的「中央夹在两座之间」保留，但**中央里不再放「上一手牌」行** ——
 * 每一侧的出牌位改由 `actionOf(seat)` 决定**是否有内容**（窗口 2 ⇒ 两处并存）。
 * `.table__center` / `.table__row` / `.table__label` 三个 class 中，后两个**零断言**（回核实测）
 * ⇒ 退役它们是安全的；`.table__center` 保留（它现在是「场次名 + 占位」的居中容器）。
 * ⚠️ `.table__center` 必须**常驻**（`v-if` 只加在里面的 PlayArea 上），否则两侧座位会挤到中间去。
 */
.table__mid {
  display: flex;
  flex-direction: row;
  gap: $ftl-space-5;
  align-items: stretch;
  /* 吃掉顶栏与我的区域之间的剩余高度（`.table` 是列 flex，这一层是它唯一可伸缩的行） */
  flex: 1 1 0;
  min-height: 0;
}
/**
 * 对手座位（2026-10-10 仿欢乐斗地主；2026-10-11 第八轮**下沉重锚**）：**无白底板的浮动组**，
 * 宽度由内容决定（头像 110 宽；昵称行 = 昵称 + 48 数字牌），不再占固定 227 卡位。
 * 纵向 `flex-end` 沉到中段带底（`.table__mid` 是 `align-items: stretch`，必须显式写）+
 * 底隙 `$ftl-mid-seat-bottom-gap` ⇒ 头像中心落到屏高 ≈32%（线稿/欢乐斗地主一致，改前 25% 太高）。
 */
.table__seat {
  flex: 0 1 auto;
  min-width: 0;
  align-self: flex-end;
  margin-bottom: $ftl-mid-seat-bottom-gap;
}
/**
 * 对手的出牌/状态列（2026-10-11 第三轮，用户裁决「固定一块区域」，参考欢乐斗地主）：
 * 左右两列同属 `.table__mid` 这条横排、随行拉伸、内容垂直居中 ⇒ 两家的牌**永远在同一
 * 水平线**上，不再一上一下。列内横排三件（同 y 锚头像一侧）：迷你钟 · 一手牌 ·「不出」。
 * 左列锚左缘、右列 `row-reverse` 锚右缘（钟在牌的头像侧）。
 */
.table__play-col {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: $ftl-space-4;
  /*
   * 衬顶 60 让居中内容的中心下移 30（=半衬顶），与沉底的对手头像中心
   * 齐平（屏高 ≈32%）。用衬顶而非 flex-end：牌（117 高）和倒计时钟（92 高）须共用同一
   * 中心；牌多换行时新行仍向上方长出。账目见 `$ftl-mid-play-pad-top`。
   */
  padding-top: $ftl-mid-play-pad-top;
}
.table__play-col--right {
  /* row-reverse 后 main-start 在右 ⇒ 组锚右缘（贴右座），无需另写 justify-content。 */
  flex-direction: row-reverse;
}
/**
 * 出牌槽（PlayArea 的宿主；class 透传到 PlayArea 根）：与钟共享一行，basis 给满 ⇒
 * 有钟时让出钟宽、没钟时吃满整列；自身仍受 `max-width: 100%` 封顶。
 * ⚠️ 本页**最多两个对手 `PlayArea` 实例** —— 文档级后代选择器会跨实例数和，
 * 判据一律按槽位限定（`.table__play-col` / `.table__played-slot` / `.table__my-play`）。
 */
.table__play-col .table__played-slot {
  flex: 0 1 100%;
  max-width: 100%;
  min-width: 0;
}
/**
 * 牌多**换行**（用户裁决）：把 PlayArea 内部恒单行的 `.hand` 在对手列里改成 wrap，
 * 宽度链锁死（槽 → `.table__played` → `.hand` 都是 100%），换行在列宽内发生。
 * 🔴 换行对齐手法：每张牌（含每行首张）都带同一负 margin，再给 `.hand` 补同值
 * `padding-left` —— 否则折行后的首牌会比上一行多吃一个负边距、整组左移。
 * 右列牌锚右缘（`justify-content: flex-end`），各行右缘对齐，补距只影响换行阈值。
 */
.table__play-col .table__played-slot :deep(.table__played) {
  width: 100%;
  max-width: 100%;
}
.table__play-col .table__played-slot :deep(.hand) {
  box-sizing: border-box;
  width: 100%;
  flex-wrap: wrap;
  column-gap: 0;
  row-gap: $ftl-space-3;
  padding-left: $ftl-card-overlap-mid;
}
.table__play-col .table__played-slot :deep(.hand .card) {
  margin-left: -$ftl-card-overlap-mid;
}
.table__play-col--right .table__played-slot :deep(.hand) {
  justify-content: flex-end;
}
/**
 * 「不出」胶囊（对手列 / 我的动作行同族）：服务端原话（窗口里的 `cards: null`），
 * 深玻璃底白字，浮在牌桌上可读。在对手列里锚头像一侧（左列靠左、右列因 row-reverse 靠右）。
 */
.table__play-pass,
.table__my-pass {
  flex: 0 0 auto;
  padding: 0 $ftl-space-7;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night, 0.85);
  color: $ftl-color-on-primary;
  font-size: $ftl-font-md;
  line-height: 1.8;
  white-space: nowrap;
}
/**
 * 叫抢回显（对手的出牌列 / 我的动作行同族）：
 * 金色描边胶囊，与「不出」同处一条固定带。
 * 列是 row flex（右列 row-reverse），无需自管左右对齐。
 */
.table__play-bid-echo,
.table__my-bid-echo {
  flex: 0 0 auto;
  padding: 0 $ftl-space-7;
  border-radius: $ftl-radius-pill;
  background: rgba($ftl-color-night, 0.85);
  border: $ftl-hairline solid $ftl-color-gold;
  color: $ftl-color-gold-light;
  font-size: $ftl-font-md;
  line-height: 1.8;
  white-space: nowrap;
}
/**
 * 我出的那一手：2026-10-11 起宿主是 `.table__action-bar`（**原按钮位**）——
 * 「我出牌的位置就是按钮的位置；出牌后按钮消失」。
 * ⚠️ **不得**放进 `.table__me` 内 —— 那会让 `.table__me .card` 多出已出的牌（R660 / `table-play-ui`）。
 * ⚠️ 我这一手保持 PlayArea 默认的**恒单行紧凑扇形**（换行覆盖只挂在 `.table__play-col`）。
 * 本 class 透传到 PlayArea 根（自带 column flex）⇒ `align-items: center` 让牌扇居中。
 */
.table__my-play {
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  min-height: 0;
}
/**
 * 中央的「场次名 + 底分」（协议⑥ / §3.2）。与 `game.vue` 的 `.game__scene*` **同族**、
 * 但**不同形**（B1 评审 Minor 订正措辞 —— 别让后来人按「同形」去对齐）：
 * 手法同源 —— 大标题白字 + 多层 `text-shadow` 描边（§5.2.1 的定稿手法）；
 * **字号档位与面板不同** —— `game.vue` 是 `$ftl-font-xxl`/`$ftl-font-lg` + 半透明面板，
 * 本处是 `$ftl-font-lg`/`$ftl-font-md` + **透明**。
 *
 * ⚠️ 它是**透明**的（不铺面板）：参考图的中央是底纹直接露出来的，
 *    而 `.table__center` 从片② 起就是「无形容器」（那张大白块的教训）。
 */
.table__scene {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $ftl-space-2;
}
.table__scene-name {
  color: $ftl-color-on-primary;
  font-size: $ftl-font-lg;
  font-weight: 700;
  line-height: 1.2;
  /* 大标题白字 + 多层 `text-shadow` 深色描边（§5.2.1 定稿的排版手法；不用 `-webkit-text-stroke`） */
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
.table__scene-base {
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: $ftl-font-md;
  line-height: 1.2;
}
/**
 * 中央：场地、场次名 + 底分，与**窗口为空时的「（无）」占位**（协议④：占位只在空窗口时出现）。
 *
 * ⚠️ **它必须是无形的**（片② 走查实测）：初稿保留了 `.table__center` 的描边与实色底，
 * 横屏下那变成一个**横贯中段的大白块**，而参考图的中央是**透明的**（只有底纹与水印）
 * ⇒ 去掉 `border` 与 `background`，它现在只是一个「把场次块与占位摆在正中」的容器。
 */
.table__center {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  /*
   * 第八轮下沉重锚：中央块沉到带底上 `$ftl-mid-center-bottom-pad`（底分中心 ≈屏高 38–39%，
   * 线稿/欢乐斗地主在 39.5%；改前居中在 28% 偏高）。flex-end 让两行场名/叫抢回显并存时
   * 内容向上长，不裁切、不压动作行。
   */
  justify-content: flex-end;
  gap: $ftl-space-3;
  padding: $ftl-space-4;
  padding-bottom: $ftl-mid-center-bottom-pad;
}
/**
 * 中央倒计时钟（2026-10-10 仿欢乐斗地主）：夹在动作区**两颗按钮之间**
 *（叫地主 [8s] 不叫 / 出牌 [8s] 过牌），叫分与出牌两态一致 —— 轮到我才挂。
 * 素材 `countdown.png`（200×200 金色闹钟）：铃铛/脚伸出圆外、四角透明 ⇒ 不裁切；
 * 钟面是灰玻璃 ⇒ 秒数用亮金字 + 深描边（`.table__clock-value`）。
 * ⚠️ 它**不是**新时钟 —— 秒数来自页面唯一的 `useCountdown`（§9.6 / R675）。
 * 🔴 **`flex-shrink: 0`**：钟是动作行里唯一的固定尺寸项，不设防会被当横向/纵向缓冲
 * 压扁（修复轮② 的量具结论）。源码闸在 `table-center.test.ts`，不许删。
 */
.table__clock {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: $ftl-size-clock-w;
  height: $ftl-size-clock-h;
  /* 不许拿钟当缓冲压扁它（源码闸：table-center.test.ts） */
  flex-shrink: 0;
  background-image: $ftl-art-countdown;
  background-size: 100% 100%;
  background-repeat: no-repeat;
}
/** 秒数写在**钟面上**（与 `Seat.vue` 的 `.seat__timer` 同一形态，尺寸大一档）。 */
.table__clock-value {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-xl;
  font-weight: 700;
  line-height: 1;
  /* 大标题白/金字 + 多层 `text-shadow` 深色描边（§5.2.1 定稿手法；与 `.table__scene-name` 同族） */
  text-shadow:
    0 2px 0 $ftl-color-night-deep,
    2px 0 0 $ftl-color-night-deep,
    -2px 0 0 $ftl-color-night-deep,
    0 -2px 0 $ftl-color-night-deep;
}
/**
 * 多位秒数压缩档（2026-10，用户卡点：两位秒溢出中央闹钟金边）。
 * 88×92 钟灰玻璃内径 ~45.8 画布 px：两位秒在 xl(40) 下实宽 ~63.6 ⇒ 降到 md(28)（实测 44.5 贴入）；
 * 三位（服务端 timeoutMs 理论可给 >99s）再降到 `$ftl-font-clock-compact`(18，~38 宽留余量)。
 * 贴合关系 jsdom 量不了 ⇒ 源码闸 + 真浏览器量具双钉。
 */
.table__clock-value--digits-2 {
  font-size: $ftl-font-md;
}
.table__clock-value--digits-3 {
  font-size: $ftl-font-clock-compact;
}
/**
 * 末 5 秒紧迫态（A 档）：整钟危险色光晕 + 脉动（`.anim-urgent-pulse` 随类一起挂上，
 * `prefers-reduced-motion` 下自动停）。与 `Seat.vue` 的座位钟同款（A′ 档金边已删 ⇒
 * 旧 `border-color` 紧迫态换成 `drop-shadow`；钟大一圈，光晕也放到 6px）。
 */
.table__clock--urgent {
  filter: drop-shadow(0 0 6px $ftl-color-danger-on-dark);
}
.table__clock-value--urgent {
  color: $ftl-color-danger-on-dark;
}
/**
 * 我的叫抢回显已移到动作行（2026-10-17 用户裁决）——原 `.table__center-echo`（中央大字）
 * 整块删除；中央只留场次名/底分。
 */
.table__muted {
  color: $ftl-color-text-disabled;
  font-size: $ftl-font-sm;
}
/**
 * 我的区域（R736 / 2026-10-11 仿欢乐斗地主）：**手牌在前** → 座位行 → HUD（头像/昵称/金币
 * 在左，倍数/房间在右）。
 *
 * 2026-10-11 用户裁决：**白色底板整段删除**（旧 `$ftl-color-surface-muted` + 圆角）——
 * 欢乐斗地主的手牌与底栏直接浮在牌桌底纹上，没有横贯底部的白卡。内边距保留（它还是
 * U1「可用宽 1294」账目的一项，见 `card-hand-interaction` 的源码闸）。
 *
 * ⚠️ 手牌与信息条都留在本块内：`.table__me .card` 必须只数得到手牌（探针数它 ≥17）。
 * ⚠️ **左右内边距必须是 `$ftl-space-4`(8)** —— 它是 U1 算账那个「16:9 最紧档可用宽 1294」
 * 的一项（最小设计宽 1334 − `.table` 两侧 12 − 本块两侧 8）。改它就必须**一起重算**
 * `card-hand-interaction` 的 U1 判据；非 16:9 设计宽更大，1294 是最坏值而非常态值。
 * ⚠️ 竖向内边距给小：手牌已经 202 高，再多就把中段挤没了（纵向预算见 spec §2.2）。
 */
.table__me {
  display: flex;
  flex-direction: column;
  /* 固定在底部，不参与伸缩 */
  flex: 0 0 auto;
  gap: $ftl-space-3;
  padding: $ftl-space-2 $ftl-space-4;
  /**
   * 定位基准：托管中遮罩（C4′）的 `position:absolute; inset:0` 就挂在本块内。
   * ⚠️ 删它之前先 grep 本块内新增的 `position: absolute`。
   */
  position: relative;
}
/**
 * 托管中遮罩（C4′）：只盖自己的手牌区，不挡牌桌中段与动作行。
 * 层叠：`.table__scrim`(1) < Settlement(2) < 阶段遮罩(3) < **本层(4)** < MoreMenu(10)
 * < NoticeStack(15) < ConnectionOverlay(20)；结算揭示时模板 `v-if` 直接不渲染。
 */
.table__trustee-mask {
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
.table__trustee-title {
  color: $ftl-color-gold;
  font-size: $ftl-font-lg;
  font-weight: 700;
}
.table__trustee-desc {
  color: $ftl-color-text-secondary;
  font-size: $ftl-font-sm;
}
.table__trustee-cancel {
  min-width: 180px;
}
/**
 * 底部信息条（2026-10-11 第七轮用户裁决）：**头像 + 昵称/金币在左下角成一组**
 *（昵称与头像左右排列、沉到头像下缘，像坐在头像左下角），HUD 独自在右下角。
 * 本行在手牌**下方**；手牌整体向下叠进本行的量由 `.hand` 的负 margin-bottom
 *（`$ftl-hand-tuck`）统一控制 —— 本行自己**不再给 margin-top**（两处分开调会算不清）。
 * ⚠️ `align-items: flex-end` 是「靠下」语义：昵称行 / HUD 都与头像**下缘**对齐，
 * 不要改回 center（那会让昵称挂在头像垂直中段）。
 */
.table__me-foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: $ftl-space-5;
  min-width: 0;
}
/**
 * 右侧弹性行：`flex:1` 吃满头像与 HUD 之间的全部空宽，内部再 `space-between`
 * ⇒ meta 件紧贴头像右边（头像与昵称左右相邻），HUD 被推到行末（右下角）。
 */
.table__me-info {
  display: flex;
  flex: 1 1 0;
  align-items: flex-end;
  justify-content: space-between;
  gap: $ftl-space-5;
  min-width: 0;
}
.table__me-info .table__hud {
  flex: 0 0 auto;
}
/**
 * 手牌区（片② R732 / 2026-10-10 用户裁决）：牌**互相压住**，**恒单行**，
 * 相邻牌重叠量是**恒等令牌**（不随张数变化，参考欢乐斗地主）。
 *
 * 算账（**16:9 最紧档**：最小设计宽 1334，可用宽 **1294** = 1334 − `.table` 两侧 12 −
 * `.table__me` 两侧 8；宽于 16:9 的视口设计宽更大，手牌两侧只多居中余量，账目更宽松）：
 *   pitch = 155 − 96 = 59
 *   13 张 = 155 + 12 × 59 = 863；17 张 = 1099
 *   20 张 = 155 + 19 × 59 = **1276** ≤ 1294 ✅ 最密极端也单行，余量 18
 * 牌行短时 `justify-content: center` 居中留白 —— **不拉伸**（牌本身 flex: 0 0 固定宽）。
 * 牌高 `$ftl-card-h`(202)，比例 0.767，贴住源图 80×104 的 0.769（差 0.3%）。
 *
 * ⚠️ **`flex-wrap: nowrap`**：恒单行，张数多少都不换行（换行会让整行高度翻倍）。
 *
 * ⚠️ **R671**：重叠必须用 `margin-left` 负值（`.card + .card`），**不能**用 `column-gap: -80px` ——
 * 负 `gap` 不是合法 CSS/WXSS，浏览器与小程序**都会直接丢弃该声明**。
 */
.table__me :deep(.hand) {
  display: flex;
  flex-wrap: nowrap;
  /* F1：把 `Hand.vue` 的 `gap: 8px` 归零，否则净重叠会被吃掉 8px（20 张时重新溢出换行） */
  column-gap: 0;
  align-items: flex-end;
  justify-content: center;
  /* 🔴 **终局锁高（2026-10-12 走查修复）**：赢家把牌出完后服务端终局视图的 `hand` 为 `[]`，
     空手牌只剩一行 26px 提示字（`.hand__empty`），本槽若随之塌缩，`.table__me` 会矮
     `$ftl-card-h`（202）− 一行字（约 31）≈ 170px；`.table__mid` 是唯一伸缩行会吃掉这 170px，
     而对手座位 `align-self: flex-end` 沉在中段带底 ⇒ 两家头像被整体带下去（结算时最明显）。
     锁成有牌时的牌高后，净占位仍是 `$ftl-card-h − $ftl-hand-tuck`，终局/对局各态切换不跳，
     手法同 `.table__action-bar` 的固定高度。 */
  min-height: $ftl-card-h;
  /* 2026-10-11 第七轮用户裁决：手牌扇整体下沉，叠进底部信息条（牌底落在昵称上方约一档）。
     负 margin 同时把信息行上提、把 `.table__me` 总高压短（本块钉在底部）⇒ 视觉就是
     手牌整体下移，上方动作行跟随下移、与手牌的相对间距不变。账目见 `$ftl-hand-tuck`。 */
  margin-bottom: -$ftl-hand-tuck;
}
.table__me :deep(.hand .card + .card) {
  margin-left: -$ftl-card-overlap;
}
/**
 * 动作行宿主（2026-10-11 第三轮，仿欢乐斗地主）：`.table` 列里的**独立整行**，位于
 * 中段与手牌之间，恒居中。**不随左右出牌槽变化**（它不在 `.table__mid` 横排里）：
 * 对手出不出牌、出几张，按钮的水平/垂直位置都纹丝不动。
 *
 * 🔴 **固定高度** `$ftl-size-action-bar-h`（140，不是 min-height）：叫分按钮 / 出牌按钮 /
 * 我出的牌（mid 牌 117）/「不出」/等待 / 终局各态切换时手牌**不上下跳**；
 * 个别态内容略高时居中、允许视觉溢出，不撑高本行。
 * 72 高按钮在 140 行内居中 ⇒ 按钮底缘距行底 34，手牌选中抬起 24（`$ftl-card-lift`）后
 * 仍留 10 净距（用户裁决：按钮小一点、和手牌拉开距离，选牌抬起不被遮）。
 */
.table__action-bar {
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
 * 动作区：**动作行宿主里的按钮行**（2026-10-11 起宿主是 `.table__action-bar`，不再是中央）。
 * 历史：片③ 之前是 `.table__me` 内 `position: absolute` 浮层 → 片③ 搬进 `.table__center`
 * → 2026-10-11 因「对手出牌推动按钮」搬到手牌正上方的独立行。
 *
 * ⚠️ **「有没有盖住别的元素」只能由真浏览器走查证明**（`mount()` 看不见样式，spec §1.1-8）。
 * 探针点这些按钮走的是 DOM `.click()`，**不受视觉遮挡影响** ⇒ 盖住了探针也不会红。
 * 因此那是**人**的判据，**不得**伪造成机械断言 —— 走查清单在 spec §3.6 / 本片 Task 7。
 */
.table__actions {
  display: flex;
  gap: $ftl-space-3;
  align-items: center;
}
/**
 * 出牌期动作行（2026-10-19 用户裁决修订）：
 *  正常：左「过牌」· 中「倒计时」· 右「提示 · 出牌」，两侧 flex 轨道等宽配平 ⇒ 钟恒居中。
 *  首出（beatTarget=null）：左列空 → 钟仍居中，右列提示+出牌紧贴钟。
 *  pass-only（cannotBeat）：flex 紧凑布局，钟 + 过牌紧贴居中（过牌在钟**右边**）。
 *
 * gap 统一收紧到 $ftl-space-3（6px）让按钮挨近钟（原 space-4=8px 视觉偏松）。
 */
.table__actions--playing {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: $ftl-space-3;
}
.table__actions--playing.table__actions--pass-only {
  display: flex;
  justify-content: center;
  gap: $ftl-space-3;
}
.table__actions-side {
  display: flex;
  align-items: center;
  gap: $ftl-space-3;
}
.table__actions-side--left {
  justify-content: flex-end;
}
.table__actions-side--right {
  justify-content: flex-start;
}
/**
 * 动作行里的**全部**按钮（2026-10-19 用户裁决缩小一档）：
 * 高从 72→60、最小宽从 176→136（参考欢乐斗地主按钮比例）。
 * ⚠️ 只在 table 页面局部 override，不改 uni.scss 令牌（闸钉死）。
 */
.table__action-bar :deep(.btn) {
  min-width: 136px;
  min-height: 60px;
  font-size: $ftl-font-md;
  padding: 0 $ftl-space-5;
}
.table__ended {
  font-size: $ftl-font-md;
  color: $ftl-color-text-secondary;
}
.table__settlement {
  display: block;
}
.btn {
  @include ftl-btn;
  /* 2026-10 UI 重设计：次按钮（默认态）改成冷灰弱化风格 */
  border-color: rgba(160, 170, 190, 0.5);
  border-radius: $ftl-radius-md;
  background: linear-gradient(180deg, rgba(120, 130, 150, 0.35), rgba(80, 90, 110, 0.5));
  color: rgba($ftl-color-on-primary, 0.7);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25), inset 0 2px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(10px);
  transition: transform 0.1s, box-shadow 0.1s, border-color 0.15s;
  /* 覆盖 ftl-btn 里的 btn2.png 贴图 —— 我们有自己的渐变兜底 */
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
  /* 小按钮稍微减弱阴影 */
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 2px 0 rgba(255, 255, 255, 0.06);
}
.btn--primary {
  border-color: $ftl-color-gold-deep;
  /* ⚠️ 这一行必须是 `background: **简写**` —— `table-bid-bottom.test.ts` 的
     「主按钮必须自持主色」闸按**字面**匹配（写成 `background-image:` 匹配不上）。 */
  background: $ftl-color-gold;
  /* 🔴 **贴图两行已删**（片③ 阶段 B / §5.2.1 逐字：「**不带贴图** —— 原处的
     `background-image: url($ftl-btn-plate-primary)` / `background-size` **必须一并删掉**
     （留着会盖住金色）」）。 */
  color: $ftl-color-on-primary;
  /* 2026-10 UI 重设计：拟物化立体阴影 */
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
.table__lobby-back {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  width: 40px;
  padding: 0;
}
.table__lobby-back-icon {
  width: 22px;
  height: 22px;
}
</style>

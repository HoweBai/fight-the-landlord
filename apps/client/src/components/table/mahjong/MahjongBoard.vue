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
import { computed, ref, watch, onMounted } from 'vue';
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
import MahjongMeld from './MahjongMeld.vue';
import MahjongHuBanner from './MahjongHuBanner.vue';
import ClaimTile from './ClaimTile.vue';
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
const myClaims = computed<MahjongClaimOption[]>(() => [...(props.view?.claimsForMe ?? [])]);
const myTrustee = computed(() => props.view?.trustees[me.value] ?? false);
const sceneBase = computed<number | null>(() => props.view?.baseScore ?? null);
const tingTiles = computed<readonly Tile[]>(() => props.view?.tingTiles ?? []);
const myLack = computed(() => props.view?.lackSuits[me.value] ?? null);

// —— P1 中央增强：最近出牌 + 牌墙堆 ——
const lastDiscard = computed(() => props.view?.lastDiscard ?? null);
/** 牌墙尾堆可视化：最多 7 张牌背横排 + 数字提示剩余张数。 */
const wallPileCount = computed(() => Math.min(wallCount.value, 7));
const wallPileIndices = computed(() =>
  Array.from({ length: wallPileCount.value }, (_, i) => i),
);
/** 最近出牌的方向标签（谁出的）。 */
function discardSeatLabel(seat: number): string {
  if (seat === me.value) return '我出';
  if (seat === topSeat.value) return '对家';
  if (seat === leftSeat.value) return '左家';
  if (seat === rightSeat.value) return '右家';
  return '';
}

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
// 双击出牌需要的追踪状态（T4 Batch 1）
const lastClickIndex = ref<number>(-1);
const lastClickTime = ref<number>(0);
// T6 Batch 2：出牌 fly-out 追踪（B2 阻断修法：watch hand 变化时 reset）
const flyingOutIndex = ref(-1);
// T4 Batch 2：胡牌 banner 增量判定 + FIFO queue（H3 修法 + B2 跨局 reset）
const seenHuSeats = new Set<number>();
const bannerQueue = ref<Array<{ seat: number; fan: number; selfDraw: boolean }>>([]);
const currentBanner = ref<typeof bannerQueue.value[0] | null>(null);
// T7 Batch 2：副露 pop 增量判定防中途进入爆炸（B3 阻断修法）
const initialBootDone = ref(false);
const seenMeldKeys = new Set<string>();
const newMeldKeySet = ref<Set<string>>(new Set());

function meldKey(m: MahjongMeldView): string {
  return `${m.kind}:${m.tiles.map(tileType).join('_')}`;
}
// 只在**手牌内容**变化时清空选择：换三张阶段别人提交也会 bump version，
// 若把 version 纳入 watch 源，我正在选的第 2/3 张会被别人的动作清掉。
watch(
  () => hand.value.map(tileType).join(','),
  () => {
    selected.value = [];
    lastClickIndex.value = -1;
    // T6 Batch 2：fly-out 追踪在手牌变化时 reset（B2 阻断修法）
    flyingOutIndex.value = -1;
  },
);

function onTileClick(index: number): void {
  if (!handSelectable.value) return;
  haptic('light');

  if (phase.value === 'exchange') {
    // 换三张：保持原多选逻辑，不触发双击出牌
    const at = selected.value.indexOf(index);
    if (at >= 0) selected.value.splice(at, 1);
    else if (selected.value.length < 3) selected.value.push(index);
    lastClickIndex.value = -1;
    return;
  }

  // 出牌窗口内：单击 = 选中高亮；双击（400ms 内同一张）= 直接出牌
  const now = Date.now();
  const isDoubleClick =
    lastClickIndex.value === index && now - lastClickTime.value < 400;

  if (isDoubleClick) {
    const tile = hand.value[index];
    if (tile && !props.busy) {
      // T6 Batch 2：fly-out 追踪在 submit 前赋值（B2+H4 修法）
      flyingOutIndex.value = index;
      submit({ type: 'discard', tile });
      selected.value = [];
      lastClickIndex.value = -1;
    }
    return;
  }

  // 单击：切换选中
  selected.value =
    selected.value.length === 1 && selected.value[0] === index ? [] : [index];
  lastClickIndex.value = index;
  lastClickTime.value = now;
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
  if (opt.claim === 'hu') {
    const fanPart = opt.fan ? `${opt.fan} 番` : '';
    return `${fanPart}${phase.value === 'play' ? '自摸胡' : '胡'}`;
  }
  if (opt.claim === 'gang') {
    if (phase.value === 'play' && opt.tile) {
      return selfGangAction(opt.tile).type === 'concealedGang' ? '暗杠' : '补杠';
    }
    return '杠';
  }
  if (opt.claim === 'peng') return '碰';
  return '过';
}

// —— Batch 3 新增：ClaimTile 组件用的 submit 函数（阻断 B1 修法）——
function submitClaim(opt: MahjongClaimOption) {
  submit({ type: 'claim', claim: opt.claim });
}
function submitPass() {
  // pass 是 MahjongClaim 四值之一（不是 MahjongAction type）
  submit({ type: 'claim', claim: 'pass' });
}
const canPass = computed(() =>
  (phase.value === 'claim' || phase.value === 'play') && myClaims.value.length > 0,
);
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

/** 座位 → MahjongTile.direction 映射（T5 Batch 1）。
 *  Atlas 4 方向牌面已预旋转，直接按视觉方位选对应目录。 */
const SEAT_DIRECTIONS = ['my', 'top', 'left', 'right'] as const;
type Direction = (typeof SEAT_DIRECTIONS)[number];
function directionOf(seat: number): Direction {
  if (seat === me.value) return 'my';
  if (seat === topSeat.value) return 'top';
  if (seat === leftSeat.value) return 'left';
  if (seat === rightSeat.value) return 'right';
  return 'my'; // 兜底
}

// —— Batch 4 D 组：claim 窗口多家 active 差异化发光 ——
/** claim 窗口最早 active = strong，其余 weak；其他窗口统一 strong。 */
function seatActiveLevel(seat: number): 'strong' | 'weak' | null {
  const idx = activeSeats.value.indexOf(seat);
  if (idx === -1) return null;
  if (phase.value === 'claim') {
    return idx === 0 ? 'strong' : 'weak';
  }
  return 'strong';
}

// —— Batch 4 A 组：弃牌点击过滤 ——
const discardClickTarget = ref<Tile | null>(null);

/** SeatPanel 弃牌点击 handler：只在 claim 窗口 + 我 active 时响应。 */
function onSeatDiscardClick(_seat: number, tile: Tile) {
  if (phase.value !== 'claim' || !amActive.value) return;
  if (props.settlementArrived) return;
  // 再次点击同一张 → 取消过滤
  if (discardClickTarget.value && tileType(discardClickTarget.value) === tileType(tile)) {
    discardClickTarget.value = null;
    return;
  }
  discardClickTarget.value = tile;
}

/** 过滤 claimsForMe：只保留 tileType 匹配的选项。
 *  阻断 B2 修法：game-service 任何 hu 都填 tile（自摸胡=lastDraw，点炮胡=弃牌），
 *  所以不写 opt.tile === undefined —— claim 窗口的 hu 就是点炮胡（tile=弃牌）。 */
const filteredClaimsForDiscard = computed<MahjongClaimOption[]>(() => {
  if (!discardClickTarget.value) return myClaims.value; // 未选中 → 全量
  const tt = tileType(discardClickTarget.value);
  return myClaims.value.filter(opt => !!opt.tile && tileType(opt.tile) === tt);
});

// 高项 H1：discardClickTarget reset 时机
watch(phase, (to) => { if (to !== 'claim') discardClickTarget.value = null; });
watch(myClaims, () => { discardClickTarget.value = null; }, { deep: true });

// —— Batch 4 B 组：长按手牌看牌型 ——
const handHintIndex = ref<number | null>(null);

function onTileLongPress(index: number) {
  if (!handSelectable.value || phase.value !== 'play') return;
  if (props.settlementArrived) return;
  handHintIndex.value = index;
}
function closeHandHint() { handHintIndex.value = null; }

// handHintIndex reset
watch(phase, () => { handHintIndex.value = null; });
watch(() => hand.value.length, () => { handHintIndex.value = null; });

/** 高项 H4：纯布尔判断（不做牌库搜索）。
 *  手牌打完这张就没了 → ting 不变 → stillSafe=true
 *  手牌还有同款 → ting 可能变 → stillSafe=false */
const handHintAffected = computed(() => {
  if (handHintIndex.value === null) return null;
  const hintTile = hand.value[handHintIndex.value];
  if (!hintTile) return null;
  const handWithout = hand.value.filter((_, i) => i !== handHintIndex.value!);
  const stillHas = handWithout.some(t => tileType(t) === tileType(hintTile));
  return { tile: hintTile, stillSafe: !stillHas };
});

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
    activeLevel: seatActiveLevel(seat), // Batch 4 D 组：替换旧 active: boolean
    ting: (v?.tingSeats ?? []).includes(seat), // Batch 5 B 组：对手听牌徽标
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

// —— Batch 2 新增逻辑 ——

/**
 * T5 Batch 2：定缺推荐。
 * 找出手牌里唯一最少花色，给对应按钮加呼吸高亮。
 * hand.length < 10（加载中）、counts 全相等（没有最少）、某花色=0（绝张）都不推荐。
 */
const lackRecommendation = computed<MahjongSuit | null>(() => {
  if (phase.value !== 'lack' || !amActive.value) return null;
  if (hand.value.length < 10) return null;
  const counts = [0, 0, 0];
  for (const t of hand.value) counts[t.s]++;
  let minIdx = 0, minCount = counts[0];
  let hasUniqueMin = true;
  for (let i = 1; i < 3; i++) {
    if (counts[i] < minCount) { minCount = counts[i]; minIdx = i; hasUniqueMin = true; }
    else if (counts[i] === minCount) { hasUniqueMin = false; }
  }
  if (!hasUniqueMin) return null;
  if (minCount === 0) return null;
  return minIdx as MahjongSuit;
});

/** T4 Batch 2：座位位置百分比（Hu banner 定位用）。 */
function bannerPosition(seat: number): { leftPct: number; topPct: number } {
  if (seat === me.value) return { leftPct: 50, topPct: 90 };
  if (seat === topSeat.value) return { leftPct: 50, topPct: 10 };
  if (seat === leftSeat.value) return { leftPct: 8, topPct: 50 };
  return { leftPct: 92, topPct: 50 };
}

/** T4 Batch 2 + T7 Batch 2：新局开始时 reset 所有跨局 Set（B2 阻断修法）。 */
watch(
  () => props.view?.state,
  (to, from) => {
    const newRound =
      (from === 'ended' && to === 'exchange') ||
      (from === null && to === 'exchange') ||
      (!!from && from !== 'exchange' && to === 'exchange');
    if (newRound) {
      seenHuSeats.clear();
      bannerQueue.value = [];
      currentBanner.value = null;
      seenMeldKeys.clear();
      newMeldKeySet.value.clear();
      initialBootDone.value = false;
      // onMounted 已跑过，手动标记初始为 true（已由上面 clear 重置）
      // 新局第一次服务端推 melds 时会触发 watch，从空数组开始算增量
      initialBootDone.value = true;
    }
  },
);

/** T4 Batch 2：胡牌 banner FIFO —— diff Set 找新增 seat（H3 修法）。 */
watch(
  () => props.view?.huInfos ?? [],
  (infos) => {
    const newlyAdded: typeof bannerQueue.value = [];
    for (const info of infos) {
      if (!seenHuSeats.has(info.seat)) {
        seenHuSeats.add(info.seat);
        newlyAdded.push({ seat: info.seat, fan: info.fan, selfDraw: info.selfDraw });
      }
    }
    if (newlyAdded.length > 0) {
      bannerQueue.value.push(...newlyAdded);
      if (!currentBanner.value) showNextBanner();
    }
  },
  { deep: true },
);

function showNextBanner() {
  currentBanner.value = bannerQueue.value.shift() ?? null;
}

/** T7 Batch 2：防中途进入 mount 爆炸（B3 阻断修法）。 */
onMounted(() => {
  // 记录所有玩家的所有已有副露 key —— 中途进入房/重连时已有副露不播 pop
  for (const seatMelds of props.view?.melds ?? []) {
    for (const m of seatMelds) {
      seenMeldKeys.add(meldKey(m));
    }
  }
  initialBootDone.value = true;
});

/** T7 Batch 2：watch melds 变化，标记增量（新局 started 时已由 cross-round reset 清空）。 */
watch(
  () => props.view?.melds ?? [],
  (allMelds) => {
    if (!initialBootDone.value) return;
    for (const seatMelds of allMelds) {
      for (const m of seatMelds) {
        const k = meldKey(m);
        if (!seenMeldKeys.has(k)) {
          seenMeldKeys.add(k);
          newMeldKeySet.value.add(k);
        }
      }
    }
  },
  { deep: true },
);

/** T7 Batch 2：MahjongMeld animationend 清理临时标记。 */
function onMeldPopDone(key: string) {
  newMeldKeySet.value.delete(key);
}
</script>

<template>
  <view class="mj">
    <!-- 麻将桌底部两个角落装饰（T3 Batch 1） -->
    <view class="mj__corner-bot mj__corner-bot--l" aria-hidden="true" />
    <view class="mj__corner-bot mj__corner-bot--r" aria-hidden="true" />
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
        <MahjongSeatPanel
          v-bind="seatPanelProps(topSeat)"
          :direction="directionOf(topSeat)"
          compact
          @discard-click="onSeatDiscardClick(topSeat, $event)"
        />
      </view>

      <view class="mj__mid">
        <view class="mj__side">
          <MahjongSeatPanel
            v-bind="seatPanelProps(leftSeat)"
            :direction="directionOf(leftSeat)"
            compact
            @discard-click="onSeatDiscardClick(leftSeat, $event)"
          />
        </view>
        <view class="mj__center">
          <text class="mj__phase">{{ phaseText }}</text>
          <view v-if="claimTile" class="mj__claim-tile">
            <MahjongTile :tile="claimTile" size="md" direction="my" />
          </view>
          <text v-if="endReason > 0 && phase !== 'ended'" class="mj__muted">
            已胡 {{ endReason }} 家
          </text>
          <view v-if="tingTiles.length > 0" class="mj__ting">
            <text class="mj__ting-label">
              听<template v-if="view?.maxFanForMe !== undefined">（{{ view.maxFanForMe }} 番）</template>
            </text>
            <MahjongTile
              v-for="(tile, i) in tingTiles"
              :key="`ting-${i}`"
              :tile="tile"
              size="sm"
              direction="my"
            />
          </view>

          <!-- P1 中央增强：最近出牌 tile + 方向标签 + 牌墙尾堆 -->
          <view v-if="lastDiscard && phase === 'play'" class="mj__last">
            <text class="mj__last-label">{{ discardSeatLabel(lastDiscard.seat) }}弃</text>
            <MahjongTile
              :tile="lastDiscard.tile"
              size="md"
              direction="my"
              class="mj__last-tile"
            />
          </view>

          <!-- 牌墙尾堆：最多 7 张牌背横排 + 数字提示剩余。
               P2-1: margin-top:auto 推到 .mj__center 底部锚点，
               避免被上方 phase/claimTile 埋没。牌墙耗尽(wallCount=0) 时隐藏。 -->
          <view v-if="wallCount > 0" class="mj__wall-pile">
            <MahjongTile
              v-for="i in wallPileIndices"
              :key="`wall-${i}`"
              back
              size="sm"
              direction="my"
            />
            <text class="mj__wall-count">{{ wallCount }}</text>
          </view>
        </view>
        <view class="mj__side">
          <MahjongSeatPanel
            v-bind="seatPanelProps(rightSeat)"
            :direction="directionOf(rightSeat)"
            compact
            @discard-click="onSeatDiscardClick(rightSeat, $event)"
          />
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
        <!-- T5 Batch 1: 用 MahjongMeld 独立组件渲染副露；T7 Batch 2: :key 改稳定标识 + :pop 增量动画 -->
        <MahjongMeld
          v-for="meld in myMelds"
          :key="meldKey(meld)"
          :meld="meld"
          direction="my"
          size="sm"
          :pop="newMeldKeySet.has(meldKey(meld))"
          @pop-done="onMeldPopDone(meldKey(meld))"
        />
        <view v-if="myDiscards.length > 0" class="mj__my-river mj-river">
          <MahjongTile
            v-for="(tile, i) in myDiscards"
            :key="`my-discard-${i}`"
            :tile="tile"
            size="sm"
            direction="my"
            :class="{
              'mj__discard--latest': i === myDiscards.length - 1 && myDiscards.length > 0,
              'mj__discard--selected': discardClickTarget && i === myDiscards.length - 1
            }"
            @click="onSeatDiscardClick(me, tile)"
          />
        </view>
        <!-- 自己胡了时，在 .mj__mine 区域展示完整手牌（替代下方 .mj__hand） -->
        <view v-if="myRevealed" class="mj__my-revealed">
          <text class="mj__my-meld-label">已胡</text>
          <MahjongTile
            v-for="(tile, i) in myRevealed.tiles"
            :key="`my-revealed-${i}`"
            :tile="tile"
            size="lg"
            direction="my"
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
            :class="{
              'anim-lack-pulse': lackRecommendation === suit,
              'mj__lack--recommend': lackRecommendation === suit,
            }"
            :disabled="busy"
            @click="onLack(suit)"
          >
            缺{{ MAHJONG_SUIT_NAMES[suit] }}
            <text v-if="lackRecommendation === suit" class="mj__lack--hint">推荐</text>
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

        <ClaimTile
          v-else-if="!settlementArrived && phase === 'claim' && amActive"
          :options="myClaims"
          :filtered-options="discardClickTarget ? filteredClaimsForDiscard : undefined"
          :busy="busy"
          :show-pass="canPass"
          @claim="submitClaim"
          @pass="submitPass"
        />

        <text v-else-if="settlementArrived || phase === 'ended'" class="mj__ended">本局结束</text>
        <!-- 自己不 active 时不再底部重复显示 phaseText：中央 .mj__phase 已展示 -->
      </view>

      <view v-if="myTrustee && !settlementRevealed && phase !== 'ended'" class="mj__trustee-mask" @click.stop>
        <text class="mj__trustee-title">托管中</text>
        <text class="mj__trustee-desc">轮到你时将自动出牌</text>
        <button type="button" class="btn btn--primary mj__trustee-cancel" :disabled="busy" @click="onTrustee(false)">
          取消托管
        </button>
      </view>

      <!-- 自己胡了（myRevealed 不为空）时，手牌已在 .mj__my-revealed 展示，
           隐藏 .mj__hand 避免重复渲染。settlementRevealed 同理。 -->
      <view
        v-if="!myRevealed && !settlementRevealed"
        class="mj__hand mj__hand--relative"
        :class="{
          'mj__hand--selectable': handSelectable,
          'mj__hand--ting': tingTiles.length > 0,
        }"
      >
        <MahjongTile
          v-for="(tile, i) in hand"
          :key="`hand-${phase}-${i}`"
          :tile="tile"
          size="lg"
          direction="my"
          :selected="selected.includes(i)"
          :disabled="!handSelectable"
          :class="{
            'anim-fly-out': flyingOutIndex === i,
            'anim-deal-in': phase === 'play',
          }"
          :style="{ '--ftl-delay': `${i * 30}ms` }"
          @click="onTileClick(i)"
          @longpress="onTileLongPress(i)"
        />
        <!-- T3c Batch 3：play 窗口双击等待提示（阻断 B3：已加 position: relative） -->
        <view
          v-if="phase === 'play' && handSelectable && selected.length === 1"
          class="mj__hand-hint"
        >
          <text>再点一次出牌（或点"出牌"按钮）</text>
        </view>
      </view>
    </template>

    <!-- T4 Batch 2：胡牌 banner 浮动 view（position: absolute 相对于 .mj 根元素） -->
    <MahjongHuBanner
      v-if="currentBanner"
      :seat="currentBanner.seat"
      :fan="currentBanner.fan"
      :self-draw="currentBanner.selfDraw"
      :left-pct="bannerPosition(currentBanner.seat).leftPct"
      :top-pct="bannerPosition(currentBanner.seat).topPct"
      @done="showNextBanner"
    />

    <!-- Batch 4 B 组：长按手牌弹层 -->
    <view
      v-if="handHintIndex !== null && handHintAffected"
      class="mj__hand-hint-popup"
      @click="closeHandHint"
    >
      <view class="mj__hand-hint-popup__card" @click.stop>
        <text class="mj__hand-hint-popup__title">
          打出 {{ MAHJONG_SUIT_NAMES[handHintAffected.tile.s] }}{{ handHintAffected.tile.r }}
        </text>
        <text class="mj__hand-hint-popup__result" :class="{
          'mj__hand-hint-popup__result--safe': handHintAffected.stillSafe,
          'mj__hand-hint-popup__result--warn': !handHintAffected.stillSafe,
        }">
          {{ handHintAffected.stillSafe ? '✓ 仍能听牌' : '⚠ 可能影响听牌' }}
        </text>
        <text v-if="tingTiles.length > 0" class="mj__hand-hint-popup__ting">
          听 {{ tingTiles.length }} 张
        </text>
      </view>
    </view>

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
  // P3: 牌桌背景增强 — 多层叠底：深→浅渐变 + 中心光斑 + 边缘暗角 + 微纹理
  background:
    // 最顶：极细的对角微纹（让纯色不那么塑料感）
    repeating-linear-gradient(
      45deg,
      transparent,
      transparent 3px,
      rgba(0, 0, 0, 0.012) 3px,
      rgba(0, 0, 0, 0.012) 4px
    ),
    // 中层：中心光斑（桌面打光效果）
    radial-gradient(ellipse at center 45%, rgba(255, 240, 180, 0.07) 0%, transparent 60%),
    // 底层：深→浅→深三段渐变
    linear-gradient(
      180deg,
      $ftl-color-mahjong-table-deep 0%,
      $ftl-color-mahjong-table 40%,
      $ftl-color-mahjong-table 60%,
      $ftl-color-mahjong-table-deep 100%
    );
  background-size: auto, auto, auto;
  // P3: 外框 + 深层叠影模拟木框 + 暗角绒面
  border: 3px solid rgba(20, 50, 30, 0.85);
  box-shadow:
    // 外框高光（模拟木框上边反光）
    inset 0 2px 0 rgba(255, 200, 100, 0.08),
    // 外框底边阴影
    inset 0 -2px 0 rgba(0, 0, 0, 0.3),
    // 内部暗角（大半径柔化）
    inset 0 0 160px rgba(0, 25, 12, 0.55),
    inset 0 0 40px rgba(0, 0, 0, 0.35),
    // 中心极弱高光（呼应 radial gradient）
    inset 0 0 80px rgba(255, 220, 100, 0.04);
  border-radius: 16px;
  overflow: hidden;
}

// —— 麻将桌角落装饰（T3 Batch 1）——
.mj::before,
.mj::after {
  content: '';
  position: absolute;
  width: 72px;
  height: 72px;
  pointer-events: none;
  z-index: 0;
  background-size: contain;
  background-position: center;
  opacity: 0.85;
}
.mj::before {
  top: 2px;
  left: 2px;
  background: url('/pages/table/static/ui/mahjong-table/Z_corner_ltop.png') no-repeat;
}
.mj::after {
  top: 2px;
  right: 2px;
  transform: scaleX(-1);
  background: url('/pages/table/static/ui/mahjong-table/Z_corner_rtop.png') no-repeat;
}
.mj__corner-bot {
  position: absolute;
  bottom: 2px;
  width: 72px;
  height: 72px;
  pointer-events: none;
  z-index: 0;
  background-size: contain;
  background-position: center;
  opacity: 0.85;
}
.mj__corner-bot--l { left: 2px; transform: scaleY(-1);
  background: url('/pages/table/static/ui/mahjong-table/Z_corner_lbottom.png') no-repeat; }
.mj__corner-bot--r { right: 2px; transform: scale(-1, -1);
  background: url('/pages/table/static/ui/mahjong-table/Z_corner_rbottom.png') no-repeat; }

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
  font-size: 18px;
  font-weight: 700;
  text-shadow: 0 2px 8px rgba($ftl-color-night-deep, 0.6);
  white-space: nowrap;
  letter-spacing: 2px;
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

// —— P1 中央增强：最近出牌 + 牌墙堆 ——
.mj__last {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: $ftl-radius-sm;
  background: rgba(255, 255, 255, 0.08);
  border: $ftl-hairline solid rgba($ftl-color-gold, 0.25);
}
.mj__last-label {
  font-size: 9px;
  color: $ftl-color-gold;
  letter-spacing: 1px;
}
.mj__last-tile {
  filter: drop-shadow(0 2px 6px rgba($ftl-color-gold, 0.4));
}
.mj__wall-pile {
  display: flex;
  align-items: flex-end;
  gap: 0;
  // P2-1: margin-top:auto 推到 .mj__center 底部锚点，始终在中间区域底部可见
  margin-top: auto;
  padding: 4px 10px;
  border-radius: $ftl-radius-sm;
  background: rgba(0, 0, 0, 0.3);
  border: $ftl-hairline solid rgba($ftl-color-gold, 0.2);
  backdrop-filter: blur(2px);
}
.mj__wall-pile :deep(.mj-tile) {
  // 放大后 sm tile 宽 34px，overlap -16px ≈ 47% （和手牌保持一致重叠率）
  margin-left: -16px;
}
.mj__wall-pile :deep(.mj-tile:first-child) {
  margin-left: 0;
}
.mj__wall-count {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 700;
  color: $ftl-color-text-muted;
  letter-spacing: 0;
  white-space: nowrap;
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
  // P2-2: 加左右 40px 内边距，让手牌收在桌面视觉中心，
  // 避免两侧延伸到 action bar 倒计时徽章和桌面边缘
  padding: $ftl-space-2 $ftl-space-10 0;
  gap: 0; // P1-1: gap 改 0，完全由负 margin 控制 overlap，避免 flex gap 在 margin 之外多撑开 2px
  min-height: 95px; // lg 牌从 69px 放大到 90px + padding 适配
  overflow-x: auto;
  position: relative; // 阻断 B3 修法：hand hint / ting 徽标用 absolute 定位
}
.mj__hand :deep(.mj-tile) {
  // lg 宽 60px，overlap -20px ≈ 33% （13 张手牌紧凑不散，总宽 = 60 + 12×40 = 540px）
  margin-left: -20px;
}
.mj__hand :deep(.mj-tile:first-child) {
  margin-left: 0;
}
.mj__hand :deep(.mj-tile--selected) {
  z-index: 10; // P1d 选中时浮到最上层，不被后面的牌盖住
}
.mj__hand--selectable :deep(.mj-tile) {
  cursor: pointer;
}

/* —— Batch 3：手牌 ting 高亮 + hand hint + 弃牌最新标记 —— */
.mj__hand--ting::after {
  content: '听牌中';
  position: absolute;
  top: -18px;
  right: 0;
  font-size: 10px;
  color: $ftl-color-gold;
  font-weight: 700;
  background: rgba($ftl-color-gold, 0.2);
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1.4;
}

.mj__hand-hint {
  position: absolute;
  bottom: -16px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: $ftl-color-gold-light;
  opacity: 0.8;
  pointer-events: none;
  white-space: nowrap;
}
.mj__discard--latest {
  box-shadow: 0 0 6px rgba($ftl-color-gold, 0.5);
}
// Batch 4 A 组：弃牌点击选中态 — 用 outline 避免和 .mj__discard--latest 金色 box-shadow 叠加
.mj__discard--selected {
  outline: 2px solid $ftl-color-primary;
  outline-offset: -2px;
}

// Batch 4 B 组：长按手牌弹层
.mj__hand-hint-popup {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.mj__hand-hint-popup__card {
  padding: 16px 24px;
  border-radius: 12px;
  background: rgba(20, 50, 30, 0.92);
  border: 2px solid rgba($ftl-color-gold, 0.6);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mj__hand-hint-popup__title { color: rgba(255,255,255,0.9); font-size: 16px; }
.mj__hand-hint-popup__result--safe { color: $ftl-color-hint-safe; font-size: 18px; font-weight: 700; }
.mj__hand-hint-popup__result--warn { color: $ftl-color-hint-warn; font-size: 18px; font-weight: 700; }
.mj__hand-hint-popup__ting { color: $ftl-color-text-muted; font-size: 12px; }

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

/* —— Batch 2：定缺推荐高亮 —— */
.mj__lack--recommend {
  border-color: $ftl-color-gold-deep !important;
  background: linear-gradient(180deg, rgba(255, 200, 80, 0.45), rgba(200, 130, 30, 0.5)) !important;
  color: $ftl-color-on-primary !important;
  box-shadow: 0 4px 12px rgba(255, 152, 0, 0.5) !important;
}
.mj__lack--hint {
  margin-left: 4px;
  font-size: 10px;
  color: $ftl-color-gold-light;
  font-weight: 700;
}
</style>

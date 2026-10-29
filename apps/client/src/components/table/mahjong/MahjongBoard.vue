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
import { computed, inject, ref, watch, onMounted } from 'vue';
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
import { CANVAS_METRICS_KEY } from '../../../composables/useLandscapeCanvas';
import { mahjongTableLayout, type Rect } from '../../../game/mahjong-layout';
import MahjongSeatChip from './MahjongSeatChip.vue';
import MahjongHandBacks from './MahjongHandBacks.vue';
import MahjongRiver from './MahjongRiver.vue';
import MahjongCenter from './MahjongCenter.vue';
import MahjongTile from './MahjongTile.vue';
import MahjongHuBanner from './MahjongHuBanner.vue';
import ClaimTile from './ClaimTile.vue';
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

// —— 比例布局（Task 8）：画布尺寸由 LandscapeStage provide；独立挂载回退 1334×750 ——
const stageMetrics = inject(CANVAS_METRICS_KEY, null);
const canvas = computed(() => stageMetrics?.value ?? { width: 1334, height: 750, scale: 1 });
const canvasH = computed(() =>
  Number.isFinite(canvas.value.height) && canvas.value.height > 0 ? canvas.value.height : 750,
);

function seatLoad(seat: number) {
  return {
    discards: (props.view?.discards[seat] ?? []).length,
    melds: (props.view?.melds[seat] ?? []).length,
  };
}
const loads = computed(() => ({
  top: seatLoad(topSeat.value),
  left: seatLoad(leftSeat.value),
  right: seatLoad(rightSeat.value),
  self: seatLoad(me.value),
}));
const layout = computed(() =>
  mahjongTableLayout(canvas.value.width, canvas.value.height, loads.value),
);
function rectStyle(r: Rect) {
  return {
    position: 'absolute' as const,
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
}
const handStyle = computed(() => ({
  ...rectStyle(layout.value.hand.rect),
  gap: `${layout.value.hand.gap}px`,
  '--mj-tile-lift': `${10 * layout.value.s}px`,
}));
const actionsStyle = computed(() => ({
  position: 'absolute' as const,
  right: `${layout.value.actions.rightOffset}px`,
  bottom: `${layout.value.actions.bottomOffset}px`,
  maxWidth: `${layout.value.actions.maxWidth}px`,
  minHeight: `${layout.value.actions.minHeight}px`,
  zIndex: 3,
}));
const trusteeMaskStyle = computed(() => ({
  bottom: `${canvasH.value - (layout.value.hand.rect.top - 8 * layout.value.s)}px`,
}));

const view = computed(() => props.view);
const phase = computed(() => props.view?.state ?? null);
const hand = computed<readonly Tile[]>(() => sortTiles(props.view?.hand ?? []));
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

/** 手牌可选的条件：交互开启 + 未结算 + （换三张窗口 | 出牌窗口）。 */
const handSelectable = computed(() => {
  if (myRevealed.value) return false;
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

function meldKey(seat: number, m: MahjongMeldView): string {
  return `${seat}:${m.kind}:${m.tiles.map(tileType).join('_')}`;
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

// —— Task 9：摸牌分离（immediate 先记录初始手牌，避免首手丢 prev） ——
const drawnType = ref<number | null>(null);
const prevHandTypes = ref<number[]>([]);

function findAdded(prev: number[], next: number[]): number | null {
  const counts = new Map<number, number>();
  for (const t of prev) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const t of next) {
    const c = counts.get(t) ?? 0;
    if (c > 0) counts.set(t, c - 1);
    else return t;
  }
  return null;
}

/** 同一手牌（multiset 相同）的新 version 包（别人托管/resync）不清摸牌标记。 */
function sameTypes(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<number, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const t of b) {
    const c = counts.get(t) ?? 0;
    if (c <= 0) return false;
    counts.set(t, c - 1);
  }
  return true;
}

watch(
  () => (props.view?.hand ?? []).map((t) => tileType(t)),
  (next) => {
    const prev = prevHandTypes.value;
    if (sameTypes(prev, next)) return;
    drawnType.value = next.length === prev.length + 1 ? findAdded(prev, next) : null;
    prevHandTypes.value = next;
  },
  { immediate: true },
);

watch(
  () => props.view?.state,
  (to) => {
    if (to === 'exchange' || to === 'ended' || to === undefined) drawnType.value = null;
  },
);

/** display 顺序：sorted 13 + 摸牌单独移到行尾；找不到幽灵牌就退回原文。 */
const displayTiles = computed<Array<{ tile: Tile; drawn: boolean }>>(() => {
  const entries = hand.value.map((tile) => ({ tile, drawn: false }));
  if (drawnType.value === null) return entries;
  const idx = entries.findIndex((e) => tileType(e.tile) === drawnType.value);
  if (idx < 0) return entries;
  const [entry] = entries.splice(idx, 1);
  return [...entries, { tile: entry!.tile, drawn: true }];
});

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
    const entry = displayTiles.value[index];
    if (entry && !props.busy) {
      // T6 Batch 2：fly-out 追踪在 submit 前赋值（B2+H4 修法）
      flyingOutIndex.value = index;
      submit({ type: 'discard', tile: entry.tile });
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
  selected.value
    .map((i) => displayTiles.value[i]?.tile)
    .filter((t): t is Tile => t !== undefined),
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

/** 弃牌点击 handler：只在 claim 窗口 + 我 active + 该座是本次 claim 来源座时响应。 */
function onSeatDiscardClick(seat: number, tile: Tile) {
  if (phase.value !== 'claim' || !amActive.value) return;
  if (props.settlementArrived) return;
  // claim 窗口的 currentPlayer 就是弃牌/杠牌者（本次待响应来源）
  if (seat !== (props.view?.currentPlayer ?? -1)) return;
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
  const hintEntry = displayTiles.value[handHintIndex.value];
  if (!hintEntry) return null;
  const handWithout = displayTiles.value.filter((_, i) => i !== handHintIndex.value!);
  const stillHas = handWithout.some((e) => tileType(e.tile) === tileType(hintEntry.tile));
  return { tile: hintEntry.tile, stillSafe: !stillHas };
});

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

// —— Task 8：四家分区的组件 props 组装 ——
function seatView(seat: number) {
  return {
    cardCount: props.view?.cardCounts[seat] ?? 0,
    lackSuit: props.view?.lackSuits[seat] ?? null,
    hu: props.view?.huInfos.find((h) => h.seat === seat) ?? null,
    isOut: props.view?.isOut[seat] ?? false,
    trustee: props.view?.trustees[seat] ?? false,
    ting: (props.view?.tingSeats ?? []).includes(seat),
    revealed: props.view?.revealedHands.find((r) => r.seat === seat) ?? null,
  };
}
function chipProps(seat: number, variant: 'self' | 'side' | 'bar') {
  const v = seatView(seat);
  return {
    name: nameOf(seat),
    isMe: seat === me.value,
    isDealer: seat === dealerSeat.value,
    cardCount: v.cardCount,
    lackSuit: v.lackSuit,
    hu: v.hu,
    isOut: v.isOut,
    trustee: v.trustee,
    ting: v.ting,
    activeLevel: seatActiveLevel(seat),
    balance: seatBalance(seat),
    pendingDelta: pendingDelta(seat),
    avatar: variant === 'bar' ? layout.value.barChip.w : layout.value.selfChip.width,
    variant,
  };
}
function backsProps(seat: number) {
  const v = seatView(seat);
  const isTop = seat === topSeat.value;
  const backs = isTop
    ? layout.value.topBacks
    : seat === leftSeat.value
      ? layout.value.leftBacks
      : layout.value.rightBacks;
  const revealed = isTop ? v.revealed : null;
  const sideRevealed = !isTop && v.revealed !== null;
  return {
    count: revealed || sideRevealed ? 0 : v.cardCount,
    direction: (isTop ? 'top' : seat === leftSeat.value ? 'left' : 'right') as
      | 'top'
      | 'left'
      | 'right',
    tileW: backs.tile.w,
    tileH: backs.tile.h,
    gap: isTop ? layout.value.topBacks.gap : 0,
    pitch: isTop ? 0 : layout.value.leftBacks.pitch,
    revealed,
  };
}
function riverMelds(seat: number) {
  return (props.view?.melds[seat] ?? []).map((m) => {
    const key = meldKey(seat, m);
    return { key, meld: m, pop: newMeldKeySet.value.has(key) };
  });
}
function riverProps(seat: number) {
  const l = layout.value;
  const isTop = seat === topSeat.value;
  const isLeft = seat === leftSeat.value;
  const river = isTop
    ? l.topRiver
    : isLeft
      ? l.leftRiver
      : seat === rightSeat.value
        ? l.rightRiver
        : l.ownRiver;
  const v = seatView(seat);
  return {
    discards: props.view?.discards[seat] ?? [],
    melds: riverMelds(seat),
    direction: directionOf(seat),
    tileW: river.tile.w,
    tileH: river.tile.h,
    gap: river.gap,
    cols: river.cols,
    rows: river.rows,
    meldTileW: river.meld.tile.w,
    meldTileH: river.meld.tile.h,
    meldOverlap: river.meld.overlap,
    meldPlacement: river.meld.placement,
    meldGap: river.meld.gap,
    meldGroupGap: river.meld.groupGap,
    meldHeight: river.meld.height,
    filterTileType: discardClickTarget.value ? tileType(discardClickTarget.value) : null,
    interactive:
      phase.value === 'claim' &&
      amActive.value &&
      seat === (props.view?.currentPlayer ?? -1),
    revealed: isLeft || seat === rightSeat.value ? v.revealed : null,
  };
}
const hasActions = computed(() => {
  if (props.settlementArrived || props.settlementRevealed) return false;
  if (!props.interactive || !amActive.value) return false;
  return (
    phase.value === 'exchange' ||
    phase.value === 'lack' ||
    phase.value === 'play' ||
    phase.value === 'claim'
  );
});
const centerProps = computed(() => ({
  wallCount: wallCount.value,
  phaseText: phaseText.value,
  claimTile: claimTile.value,
  claimW: layout.value.centerTiles.claim.w,
  claimH: layout.value.centerTiles.claim.h,
  tingTiles: tingTiles.value,
  tingW: layout.value.centerTiles.ting.w,
  tingH: layout.value.centerTiles.ting.h,
  maxFan: props.view?.maxFanForMe ?? null,
  seconds: props.seconds,
  active: amActive.value && !props.settlementRevealed,
  compact: layout.value.centerCompact,
  endedText:
    phase.value === 'ended'
      ? ''
      : endReason.value > 0
        ? `已胡 ${endReason.value} 家`
        : '',
}));

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
  if (seat === me.value) return { leftPct: 50, topPct: 82 };
  if (seat === topSeat.value) return { leftPct: 50, topPct: 20 };
  if (seat === leftSeat.value) return { leftPct: 14, topPct: 48 };
  return { leftPct: 86, topPct: 48 };
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
  (props.view?.melds ?? []).forEach((seatMelds, seat) => {
    for (const m of seatMelds) seenMeldKeys.add(meldKey(seat, m));
  });
  initialBootDone.value = true;
});

/** T7 Batch 2：watch melds 变化，标记增量（新局 started 时已由 cross-round reset 清空）。 */
watch(
  () => props.view?.melds ?? [],
  (allMelds) => {
    if (!initialBootDone.value) return;
    allMelds.forEach((seatMelds, seat) => {
      for (const m of seatMelds) {
        const k = meldKey(seat, m);
        if (!seenMeldKeys.has(k)) {
          seenMeldKeys.add(k);
          newMeldKeySet.value.add(k);
        }
      }
    });
  },
  { deep: true },
);

/** T7 Batch 2：MahjongMeld animationend 清理临时标记。 */
function onMeldPopDone(key: string) {
  newMeldKeySet.value.delete(key);
}
</script>

<template>
  <view class="mj" :style="{ '--mj-s': `${layout.s}` }">
    <!-- 麻将桌底部两个角落装饰（T3 Batch 1） -->
    <view class="mj__corner-bot mj__corner-bot--l" aria-hidden="true" />
    <view class="mj__corner-bot mj__corner-bot--r" aria-hidden="true" />
    <view class="mj__bar" :style="rectStyle(layout.bar)">
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
      </view>
      <view class="mj__bar-right">
        <MahjongSeatChip
          v-if="view"
          v-bind="chipProps(topSeat, 'bar')"
          :style="{ height: `${layout.barChip.h}px` }"
        />
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
      <MahjongHandBacks
        class="mj-backs-slot mj-backs-slot--top"
        v-bind="backsProps(topSeat)"
        :style="rectStyle(layout.topBacks.rect)"
      />
      <MahjongHandBacks
        class="mj-backs-slot mj-backs-slot--left"
        v-bind="backsProps(leftSeat)"
        :style="rectStyle(layout.leftBacks.rect)"
      />
      <MahjongHandBacks
        class="mj-backs-slot mj-backs-slot--right"
        v-bind="backsProps(rightSeat)"
        :style="rectStyle(layout.rightBacks.rect)"
      />

      <MahjongSeatChip v-bind="chipProps(leftSeat, 'side')" :style="rectStyle(layout.leftChip)" />
      <MahjongSeatChip v-bind="chipProps(rightSeat, 'side')" :style="rectStyle(layout.rightChip)" />
      <MahjongSeatChip v-bind="chipProps(me, 'self')" :style="rectStyle(layout.selfChip)" />

      <MahjongRiver
        class="mj-river-slot mj-river-slot--top"
        v-bind="riverProps(topSeat)"
        :style="rectStyle(layout.topRiver.rect)"
        @discard-click="onSeatDiscardClick(topSeat, $event)"
        @meld-pop-done="onMeldPopDone"
      />
      <MahjongRiver
        class="mj-river-slot mj-river-slot--left"
        v-bind="riverProps(leftSeat)"
        :style="rectStyle(layout.leftRiver.rect)"
        @discard-click="onSeatDiscardClick(leftSeat, $event)"
        @meld-pop-done="onMeldPopDone"
      />
      <MahjongRiver
        class="mj-river-slot mj-river-slot--right"
        v-bind="riverProps(rightSeat)"
        :style="rectStyle(layout.rightRiver.rect)"
        @discard-click="onSeatDiscardClick(rightSeat, $event)"
        @meld-pop-done="onMeldPopDone"
      />
      <MahjongRiver
        class="mj-river-slot mj-river-slot--self"
        v-bind="riverProps(me)"
        :style="rectStyle(layout.ownRiver.rect)"
        @discard-click="onSeatDiscardClick(me, $event)"
        @meld-pop-done="onMeldPopDone"
      />

      <MahjongCenter v-bind="centerProps" :style="rectStyle(layout.centerCard)" />

      <view class="mj__hand" :class="{ 'mj__hand--selectable': handSelectable }" :style="handStyle">
        <template v-if="myRevealed">
          <MahjongTile
            v-for="(t, i) in myRevealed.tiles"
            :key="`my-revealed-${i}`"
            :tile="t"
            direction="my"
            :w="layout.hand.tile.w"
            :h="layout.hand.tile.h"
            dim
          />
        </template>
        <template v-else>
          <MahjongTile
            v-for="(entry, i) in displayTiles"
            :key="`hand-${phase}-${i}`"
            :tile="entry.tile"
            direction="my"
            :w="layout.hand.tile.w"
            :h="layout.hand.tile.h"
            :selected="selected.includes(i)"
            :disabled="!handSelectable"
            :class="{
              'anim-fly-out': flyingOutIndex === i,
              'anim-deal-in': phase === 'play',
              'mj__hand-tile--drawn': entry.drawn,
            }"
            :style="{
              '--ftl-delay': `${i * 30}ms`,
              marginLeft: entry.drawn
                ? `${layout.hand.drawnGap - layout.hand.gap}px`
                : undefined,
            }"
            @click="onTileClick(i)"
            @longpress="onTileLongPress(i)"
          />
        </template>
        <view
          v-if="phase === 'play' && handSelectable && selected.length === 1"
          class="mj__hand-hint"
        >
          <text>再点一次出牌（或点"出牌"按钮）</text>
        </view>
      </view>

      <view v-if="hasActions" class="mj__actions" :style="actionsStyle">
        <template v-if="phase === 'exchange'">
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

        <template v-else-if="phase === 'lack'">
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

        <template v-else-if="phase === 'play'">
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
          v-else-if="phase === 'claim'"
          :options="myClaims"
          :filtered-options="discardClickTarget ? filteredClaimsForDiscard : undefined"
          :busy="busy"
          :show-pass="canPass"
          @claim="submitClaim"
          @pass="submitPass"
        />
      </view>

      <view
        v-if="myTrustee && !settlementRevealed && phase !== 'ended'"
        class="mj__trustee-mask"
        :style="trusteeMaskStyle"
        @click.stop
      >
        <text class="mj__trustee-title">托管中</text>
        <text class="mj__trustee-desc">轮到你时将自动出牌</text>
        <button
          type="button"
          class="btn btn--primary mj__trustee-cancel"
          :disabled="busy"
          @click="onTrustee(false)"
        >
          取消托管
        </button>
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
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  position: relative;
  color: $ftl-color-text;
  // 麻将桌背景（T3 Batch 1）
  background: linear-gradient(180deg, $ftl-color-mahjong-table-deep 0%, $ftl-color-mahjong-table 50%, $ftl-color-mahjong-table-deep 100%);
  box-shadow:
    inset 0 0 120px rgba(0, 30, 15, 0.5),
    inset 0 0 30px rgba(255, 220, 100, 0.08);
  border-radius: 16px;
  overflow: hidden;
}

// —— 麻将桌角落装饰（T3 Batch 1）——
.mj::before,
.mj::after {
  content: '';
  position: absolute;
  width: calc(var(--mj-s, 1) * 72px);
  height: calc(var(--mj-s, 1) * 72px);
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
  width: calc(var(--mj-s, 1) * 72px);
  height: calc(var(--mj-s, 1) * 72px);
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
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
  padding: 0 20px;
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

/* —— 动作栏 —— */
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
  position: absolute;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: visible;
}
.mj__hand :deep(.mj-tile--selected) {
  z-index: 1;
}
.mj__hand--selectable :deep(.mj-tile) {
  cursor: pointer;
}

.mj__hand-hint {
  position: absolute;
  top: -20px;
  bottom: auto;
  left: 50%;
  transform: translateX(-50%);
  padding: 0 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  font-size: 11px;
  color: $ftl-color-gold-light;
  opacity: 0.9;
  pointer-events: none;
  white-space: nowrap;
}

/* —— 动作浮层 —— */
.mj__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: flex-end;
  gap: $ftl-space-3;
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

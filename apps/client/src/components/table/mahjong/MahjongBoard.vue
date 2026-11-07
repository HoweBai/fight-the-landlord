<script setup lang="ts">
/**
 * 四川麻将·血战到底牌桌（红金牌桌 v2 装配）。
 *
 * 与 DdzBoard/PdkBoard 同一套边界：只收 props、只 emit（不读 store）；
 * 所有合法性/番数/可响应动作都来自 `MahjongPlayerView`（`claimsForMe`/`activeSeats`/
 * `tingTiles` 等），客户端只做**展示性**选择与按钮禁用。
 *
 * 装配契约：
 *  - 布局：`mahjongTableLayoutV2`（固定 1334×750 base，u/offset 缩放居中）；
 *  - 牌河：claimed 过滤（`visibleDiscards`）后的可见数组 + 布局窗口字段；
 *  - claim：来源座最后一枚弃牌由 `claimSourceIndex` 描边/可点，rob 无弃牌点击；
 *  - last-discard：`lastDiscardAbs` 记 serverDiscards 绝对下标，再映射到可见窗口；
 *  - 发牌：`dealEpoch`/`dealNonce`（挂载即 v1 exchange/lack 播，v>1 seed）。
 */
import { computed, inject, ref, watch } from 'vue';
import {
  MAHJONG_SUIT_NAMES,
  sortTiles,
  tileType,
  type MahjongAction,
  type MahjongClaimOption,
  type MahjongMeldView,
  type MahjongPhase,
  type MahjongPlayerView,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';
import { CANVAS_METRICS_KEY } from '../../../composables/useLandscapeCanvas';
import {
  mahjongTableLayoutV2,
  type Rect,
  type RiverLayoutV2,
  type SeatLoadV2,
  type TableInputV2,
} from '../../../game/mahjong-layout-v2';
import {
  claimSource,
  visibleDiscards,
  visibleIndexMap,
  type ClaimSourceInfo,
  type VisibleDiscardsOpts,
} from '../../../game/mahjong-claims';
import { meldKey } from '../../../game/mahjong-keys';
import MahjongSeatChip from './MahjongSeatChip.vue';
import MahjongHandBacks from './MahjongHandBacks.vue';
import MahjongRiver from './MahjongRiver.vue';
import MahjongHub from './MahjongHub.vue';
import MahjongTile from './MahjongTile.vue';
import MahjongHuBanner from './MahjongHuBanner.vue';
import MahjongActionBar, { type ActionBarAction } from './MahjongActionBar.vue';
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
  /** 手牌被点选（换三张多选 / 出牌选中；选牌音效由页面接线，Board 不碰音频）。 */
  (e: 'select'): void;
  (e: 'trustee', on: boolean): void;
  (e: 'more'): void;
  (e: 'leave'): void;
}>();

const me = computed(() => props.mySeat ?? 0);
const leftSeat = computed(() => (me.value + 3) % 4);
const rightSeat = computed(() => (me.value + 1) % 4);
const topSeat = computed(() => (me.value + 2) % 4);

/** revealedHands 防御性排序：服务端返回可能是原始未排序的手牌顺序。 */
const sortedRevealedHands = computed(() =>
  props.view?.revealedHands.map((r) => ({ ...r, tiles: sortTiles(r.tiles) })) ?? [],
);

// —— 布局（v2）：画布尺寸由 LandscapeStage provide；独立挂载回退 1334×750 ——
const stageMetrics = inject(CANVAS_METRICS_KEY, null);
const canvas = computed(() => stageMetrics?.value ?? { width: 1334, height: 750, scale: 1 });
const canvasH = computed(() =>
  Number.isFinite(canvas.value.height) && canvas.value.height > 0 ? canvas.value.height : 750,
);

const view = computed(() => props.view);
const phase = computed(() => props.view?.state ?? null);
const hubPhase = computed<MahjongPhase>(() => phase.value ?? 'draw');
const currentPlayer = computed(() => props.view?.currentPlayer ?? 0);
const hand = computed<readonly Tile[]>(() => sortTiles(props.view?.hand ?? []));
const myRevealed = computed(
  () => sortedRevealedHands.value.find((r) => r.seat === me.value) ?? null,
);
const wallCount = computed(() => props.view?.wallCount ?? 0);
const dealerSeat = computed(() => props.view?.dealerSeat ?? 0);
const activeSeats = computed<number[]>(() => [...(props.view?.activeSeats ?? [])]);
const amActive = computed(() => activeSeats.value.includes(me.value));
const myClaims = computed<MahjongClaimOption[]>(() => [...(props.view?.claimsForMe ?? [])]);
const myTrustee = computed(() => props.view?.trustees[me.value] ?? false);
const sceneBase = computed<number | null>(() => props.view?.baseScore ?? null);
const tingTiles = computed<readonly Tile[]>(() => props.view?.tingTiles ?? []);

/** claim/rob 窗口的「来源」：来源座最后一枚弃牌 / rob 的碰来源 key。 */
const claimSrc = computed<ClaimSourceInfo>(() =>
  props.view
    ? claimSource(props.view, me.value)
    : { tile: null, sourceSeat: null, canClick: false, claimSourceMeldKey: null },
);

// —— v12 §2「保留 toggle」：点 claim 来源牌 → 以牌型过滤响应选项；再点同型清除 ——
const discardClickTarget = ref<Tile | null>(null);

const filteredClaims = computed<MahjongClaimOption[]>(() => {
  const target = discardClickTarget.value;
  if (!target) return myClaims.value;
  const type = tileType(target);
  return myClaims.value.filter((o) => o.tile != null && tileType(o.tile) === type);
});

/** 该座河流当前可点的来源下标（与 riverProps 同一口径）。 */
function claimSourceIndexFor(seat: number): number | null {
  if (!claimSrc.value.canClick || claimSrc.value.sourceSeat !== seat) return null;
  const latest = riverOf(seat).latestIndex;
  return latest >= 0 ? latest : null;
}

/** River 只在来源牌上 emit；这里再按「来源座 + 来源下标」核对一次并做同型 toggle。 */
function onDiscardClick(seat: number, payload: { tile: Tile; index: number }): void {
  if (!claimSrc.value.canClick || claimSrc.value.sourceSeat !== seat) return;
  const sourceIndex = claimSourceIndexFor(seat);
  if (sourceIndex === null || payload.index !== sourceIndex) return;
  discardClickTarget.value =
    discardClickTarget.value && tileType(discardClickTarget.value) === tileType(payload.tile)
      ? null
      : payload.tile;
}

/** 旧目标不得跨窗口残留：phase 离开 claim / 选项变化 / 来源变化都清。 */
const claimsSignature = computed(() =>
  myClaims.value.map((o) => `${o.claim}:${o.tile ? tileType(o.tile) : '-'}`).join(','),
);
const claimSourceSignature = computed(() => {
  const src = claimSrc.value;
  return `${src.canClick}:${src.sourceSeat ?? '-'}:${src.tile ? tileType(src.tile) : '-'}`;
});
watch(phase, (to) => {
  if (to !== 'claim') discardClickTarget.value = null;
});
watch(claimsSignature, () => {
  discardClickTarget.value = null;
});
watch(claimSourceSignature, () => {
  discardClickTarget.value = null;
});

const meldsBySeat = computed<MahjongMeldView[][]>(() => props.view?.melds ?? [[], [], [], []]);
const serverDiscards = computed<Tile[][]>(() => props.view?.discards ?? [[], [], [], []]);

/** 每座 claimed 过滤后的可见弃牌（渲染/窗口/计数的唯一口径）。 */
function visibleOptsFor(seat: number): VisibleDiscardsOpts {
  return {
    phase: phase.value ?? 'play',
    windowId: props.view?.windowId ?? null,
    seat,
    sourceSeat: claimSrc.value.sourceSeat === seat ? seat : null,
  };
}
const visibleBySeat = computed<Tile[][]>(() => {
  if (!props.view) return [[], [], [], []];
  return [0, 1, 2, 3].map((seat) =>
    visibleDiscards(serverDiscards.value[seat] ?? [], meldsBySeat.value, visibleOptsFor(seat)),
  );
});

const loads = computed<TableInputV2>(() => {
  const seatLoad = (seat: number): SeatLoadV2 => ({
    discards: visibleBySeat.value[seat]?.length ?? 0,
    melds: (props.view?.melds[seat] ?? []).map((m) => m.tiles.length),
    revealedCount: sortedRevealedHands.value.find((r) => r.seat === seat)?.tiles.length ?? 0,
  });
  return {
    bySlot: {
      self: seatLoad(me.value),
      top: seatLoad(topSeat.value),
      left: seatLoad(leftSeat.value),
      right: seatLoad(rightSeat.value),
    },
    phase: phase.value ?? 'play',
    tingCount: tingTiles.value.length,
  };
});
const layout = computed(() =>
  mahjongTableLayoutV2(canvas.value.width, canvas.value.height, loads.value),
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
  '--mj-tile-lift': `${10 * layout.value.u}px`,
}));
const tingStyle = computed(() => ({
  ...rectStyle(layout.value.ting),
  gap: `${2 * layout.value.u}px`,
}));
/** 动作区在河/副露之上（河内副露条带 z-index: 1）。 */
const actionsStyle = computed(() => ({ ...rectStyle(layout.value.actions), zIndex: 3 }));
const trusteeMaskStyle = computed(() => ({
  bottom: `${canvasH.value - (layout.value.hand.rect.top - 8 * layout.value.u)}px`,
}));

/**
 * 牌桌绒面（2026-11-08 红金皮肤）：**只覆盖 1334×750 构图**（offset 居中），
 * 不铺满整个画布 —— 留边交给 `.mj` 的 stage 底色。框线/金线用 `--mj-u` 随构图缩放。
 * ⚠️ 颜色字面量与 `uni.scss` 的 `$ftl-color-mj-felt-1/2/3`、`-frame`、`-border` **同值**
 * （内联样式读不到 SCSS 变量；改令牌时两处一起改）。
 */
const feltStyle = computed(() => ({
  position: 'absolute' as const,
  left: `${layout.value.offsetX}px`,
  top: `${layout.value.offsetY}px`,
  width: `${1334 * layout.value.u}px`,
  height: `${750 * layout.value.u}px`,
  pointerEvents: 'none' as const,
  background:
    'radial-gradient(ellipse at 50% 46%, rgb(106 36 32) 0%, rgb(74 21 21) 46%, rgb(43 12 12) 100%)',
  boxShadow:
    'inset 0 0 0 calc(12px * var(--mj-u)) rgb(43 12 12), inset 0 0 0 calc(14px * var(--mj-u)) rgb(140 98 36)',
}));

/** 顶栏标题：场次 + 底分合成一行（mockup「休闲场 · 底分 1」）。 */
const barTitle = computed(() => {
  const parts: string[] = [];
  if (props.levelName) parts.push(props.levelName);
  if (sceneBase.value !== null) parts.push(`底分 ${sceneBase.value}`);
  return parts.join(' · ');
});

// —— last-discard：serverDiscards 绝对下标 → 可见窗口 latest ——
const initialDiscards = props.view?.discards ?? [];
function seededLastAbs(seat: number): number | null {
  const len = initialDiscards[seat]?.length ?? 0;
  return len > 0 ? len - 1 : null;
}
const lastDiscardAbs = ref<Array<number | null>>([0, 1, 2, 3].map(seededLastAbs));
const prevDiscardLens = ref<number[]>([0, 1, 2, 3].map((seat) => initialDiscards[seat]?.length ?? 0));

watch(
  () => (props.view?.discards ?? []).map((d) => d.length),
  (lens) => {
    for (let seat = 0; seat < 4; seat += 1) {
      const len = lens[seat] ?? 0;
      const prev = prevDiscardLens.value[seat] ?? 0;
      if (len > prev) lastDiscardAbs.value[seat] = len - 1;
      else if (len < prev) lastDiscardAbs.value[seat] = null;
      prevDiscardLens.value[seat] = len;
    }
  },
);

/** 该座最后一张弃牌在当前窗口里的下标；被 claimed 隐藏/不在窗口 ⇒ null（不亮旧牌）。 */
function latestIndexFor(seat: number, river: RiverLayoutV2): number | null {
  const abs = lastDiscardAbs.value[seat];
  if (abs == null) return null;
  const map = visibleIndexMap(
    serverDiscards.value[seat] ?? [],
    meldsBySeat.value,
    visibleOptsFor(seat),
  );
  const vis = map[abs];
  if (vis == null || vis < 0) return null;
  if (vis < river.windowStart || vis >= river.windowStart + river.windowCount) return null;
  return vis - river.windowStart;
}

// —— 发牌：dealEpoch / dealNonce（挂载即 v1 exchange/lack 播；v>1 / 中途进房 seed） ——
const dealEpoch = ref<number | null>(
  props.view &&
    props.view.version === 1 &&
    (props.view.state === 'exchange' || props.view.state === 'lack')
    ? 1
    : null,
);
watch(
  () => props.view?.state,
  (to, from) => {
    // 与挂载谓词（dealEpoch 初值）同口径：新局只可能是 v1（服务端每局重置 version）；
    // v>1 进入 exchange 只可能是中途挂载/重连，不重播发牌。当前不可达（同局 v>1 不会回 exchange），
    // 但缺这道闸时重连/回放类变化会误播整手发牌动画。
    if (to === 'exchange' && from !== 'exchange' && props.view?.version === 1) {
      dealEpoch.value = props.view?.version ?? null;
    }
  },
);

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
// T4 Batch 2：胡牌 banner 增量判定 + FIFO queue（H3 修法 + B2 跨局 reset）
const seenHuSeats = new Set<number>();
const bannerQueue = ref<Array<{ seat: number; fan: number; selfDraw: boolean }>>([]);
const currentBanner = ref<typeof bannerQueue.value[0] | null>(null);
const bannerSeq = ref(0);
/** 当前 banner 是在哪一版 view 上展示的（reduced-motion 只认**之后**的版本变化）。 */
const bannerAtVersion = ref<number | null>(null);
// T7 Batch 2：副露 pop 增量判定防中途进入爆炸（B3 阻断修法）
const initialBootDone = ref(false);
const seenMeldKeys = new Set<string>();
const newMeldKeySet = ref<Set<string>>(new Set());

// 只在**手牌内容**变化时清空选择：换三张阶段别人提交也会 bump version，
// 若把 version 纳入 watch 源，我正在选的第 2/3 张会被别人的动作清掉。
watch(
  () => hand.value.map(tileType).join(','),
  () => {
    selected.value = [];
    lastClickIndex.value = -1;
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

/** display 顺序：sorted 13 + 摸牌单独移到行尾；找不到幽灵牌就退回原文。
 *  每张 entry 带 `dealNonce` 哨兵：非摸牌 = dealEpoch，摸牌 = null（不重播发牌）。 */
const displayTiles = computed<
  Array<{ tile: Tile; drawn: boolean; dealNonce: number | null }>
>(() => {
  const entries = hand.value.map((tile) => ({ tile, drawn: false, dealNonce: dealEpoch.value }));
  if (drawnType.value === null) return entries;
  const idx = entries.findIndex((e) => tileType(e.tile) === drawnType.value);
  if (idx < 0) return entries;
  const [entry] = entries.splice(idx, 1);
  return [...entries, { tile: entry!.tile, drawn: true, dealNonce: null }];
});

/** Task 10：发牌径向起点 —— 每张牌的起手横向偏移 = 手牌行中心到本张的距离。
 *  只服务 `.anim-deal-in-radial`（`--mj-deal-x`）；摸牌位不挂发牌类，值无副作用。 */
function dealOffsetX(index: number): string {
  const count = displayTiles.value.filter((e) => !e.drawn).length;
  const center = (count - 1) / 2;
  const pitch = layout.value.hand.tile.w + layout.value.hand.gap;
  return `${Math.round((center - index) * pitch)}px`;
}

function onTileClick(index: number): void {
  if (!handSelectable.value) return;
  emit('select');
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

function submitPass(): void {
  // pass 是 MahjongClaim 四值之一（不是 MahjongAction type）
  submit({ type: 'claim', claim: 'pass' });
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

/** ActionBar 唯一出口：翻译成协议动作。 */
function onActionBarAction(action: ActionBarAction): void {
  switch (action.kind) {
    case 'discard':
      onDiscard();
      break;
    case 'exchange':
      onExchange();
      break;
    case 'lack':
      onLack(action.suit);
      break;
    case 'pass':
      submitPass();
      break;
    case 'claim':
      onClaimOption(action.option);
      break;
  }
}

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

/** 座位 → banner 锚点槽位（v13 §10.3：布局输出画布 px）。 */
function slotOf(seat: number): 'top' | 'left' | 'right' | 'self' {
  if (seat === me.value) return 'self';
  if (seat === topSeat.value) return 'top';
  if (seat === leftSeat.value) return 'left';
  return 'right';
}

// —— v5 §2.7：四相位静态金边 ——
/** claim/rob：我可响应 strong、来源/杠家 line；play：currentPlayer strong；
 *  exchange/lack：只看我；ended：无（赢家由 winner 单独标记）。 */
function seatActiveLevel(seat: number): 'strong' | 'line' | null {
  switch (phase.value) {
    case 'claim':
    case 'rob':
      if (seat === me.value && amActive.value) return 'strong';
      if (seat === props.view?.currentPlayer) return 'line';
      return null;
    case 'play':
      return seat === props.view?.currentPlayer ? 'strong' : null;
    case 'exchange':
    case 'lack':
      return seat === me.value && amActive.value ? 'strong' : null;
    case 'ended':
      return null;
    default:
      return null;
  }
}

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

const endReason = computed(() => props.view?.isOut.filter(Boolean).length ?? 0);

/** 血战盘状态行（v6 §3.4）：全部以我是否 pending 分「请… / 等待…」两态。 */
const statusText = computed(() => {
  if (phase.value === 'ended') {
    return endReason.value > 0 ? `已胡 ${endReason.value} 家` : '本局结束';
  }
  switch (phase.value) {
    case 'exchange':
      return amActive.value ? '选同花色3张' : '等待换三张';
    case 'lack':
      return amActive.value ? '请定缺' : '等待定缺';
    case 'play':
      return amActive.value ? '请出牌' : '等待出牌';
    case 'claim':
    case 'rob':
      return amActive.value ? '请响应' : '等待响应';
    default:
      return '';
  }
});

/** 血战盘四家徽标：每座最多一个，优先级 胡 > 听 > 缺 > 托管。 */
interface HubSeatEntry {
  seat: number;
  dir: 'top' | 'left' | 'right' | 'self';
  badge: 'hu' | 'ting' | 'lack' | 'trustee' | null;
  badgeText: string;
}
const hubSeats = computed<HubSeatEntry[]>(() => {
  const v = props.view;
  if (!v) return [];
  const entries: Array<{ seat: number; dir: HubSeatEntry['dir'] }> = [
    { seat: topSeat.value, dir: 'top' },
    { seat: leftSeat.value, dir: 'left' },
    { seat: rightSeat.value, dir: 'right' },
    { seat: me.value, dir: 'self' },
  ];
  return entries.map(({ seat, dir }) => {
    const hu = v.huInfos.find((h) => h.seat === seat);
    if (hu) {
      return { seat, dir, badge: 'hu', badgeText: hu.fan > 0 ? `胡 ${hu.fan}` : '胡' };
    }
    if (v.tingSeats.includes(seat)) return { seat, dir, badge: 'ting', badgeText: '听' };
    const lack = v.lackSuits[seat] ?? null;
    if (lack !== null) {
      return { seat, dir, badge: 'lack', badgeText: `缺${MAHJONG_SUIT_NAMES[lack]}` };
    }
    if (v.trustees[seat]) return { seat, dir, badge: 'trustee', badgeText: '托管' };
    return { seat, dir, badge: null, badgeText: '' };
  });
});

// —— 四家分区的组件 props 组装 ——
function seatView(seat: number) {
  return {
    cardCount: props.view?.cardCounts[seat] ?? 0,
    lackSuit: props.view?.lackSuits[seat] ?? null,
    hu: props.view?.huInfos.find((h) => h.seat === seat) ?? null,
    isOut: props.view?.isOut[seat] ?? false,
    trustee: props.view?.trustees[seat] ?? false,
    ting: (props.view?.tingSeats ?? []).includes(seat),
    revealed: sortedRevealedHands.value.find((r) => r.seat === seat) ?? null,
  };
}
function chipProps(seat: number, variant: 'corner-tl' | 'corner-tr' | 'corner-top' | 'self') {
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
    winner: phase.value === 'ended' && v.isOut,
    balance: seatBalance(seat),
    pendingDelta: pendingDelta(seat),
    avatar: variant === 'self' ? 44 : 56,
    variant,
  };
}
function backsProps(seat: number) {
  const v = seatView(seat);
  const isTop = seat === topSeat.value;
  const isLeft = seat === leftSeat.value;
  const backs = isTop
    ? layout.value.backs.top
    : isLeft
      ? layout.value.backs.left
      : layout.value.backs.right;
  const revealed = isTop ? v.revealed : null;
  const sideRevealed = !isTop && v.revealed !== null;
  return {
    count: revealed || sideRevealed ? 0 : v.cardCount,
    direction: (isTop ? 'top' : isLeft ? 'left' : 'right') as 'top' | 'left' | 'right',
    tileW: backs.tile.w,
    tileH: backs.tile.h,
    gap: isTop ? layout.value.backs.top.gap : 0,
    pitch: isTop ? 0 : isLeft ? layout.value.backs.left.pitch : layout.value.backs.right.pitch,
    revealed,
    dealNonce: dealEpoch.value,
    tail: v.cardCount >= 14,
  };
}
function riverMelds(seat: number) {
  return (props.view?.melds[seat] ?? []).map((m) => {
    const key = meldKey(seat, m);
    return { key, meld: m, pop: newMeldKeySet.value.has(key) };
  });
}
function riverOf(seat: number): RiverLayoutV2 {
  if (seat === topSeat.value) return layout.value.rivers.top;
  if (seat === leftSeat.value) return layout.value.rivers.left;
  if (seat === rightSeat.value) return layout.value.rivers.right;
  return layout.value.rivers.self;
}
/** 布局输出的是画布坐标；River 内收到的 badge/meld 矩形必须是**河内局部坐标**（v11 §2）。 */
function localRect(r: Rect | null, origin: Rect): Rect | null {
  return r
    ? { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height }
    : null;
}
function riverProps(seat: number) {
  const river = riverOf(seat);
  const isLeft = seat === leftSeat.value;
  const isRight = seat === rightSeat.value;
  const isSource = claimSrc.value.canClick && claimSrc.value.sourceSeat === seat;
  return {
    discards: visibleBySeat.value[seat] ?? [],
    melds: riverMelds(seat),
    direction: directionOf(seat),
    tileW: river.tile.w,
    tileH: river.tile.h,
    gap: river.gap,
    cols: river.cols,
    rows: river.rows,
    meldTileW: river.meld.tileW,
    meldTileH: river.meld.tileH,
    meldOverlap: river.meld.overlap,
    meldGroupGap: river.meld.groupGap,
    // River 的 legacy 必填 prop（meldRect 恒传，走局部坐标分支，不再使用它们）。
    meldPlacement: 'above' as const,
    meldGap: 0,
    meldHeight: 0,
    interactive: isSource,
    claimSourceIndex: claimSourceIndexFor(seat),
    revealed: isLeft || isRight
      ? (sortedRevealedHands.value.find((r) => r.seat === seat) ?? null)
      : null,
    windowStart: river.windowStart,
    windowCount: river.windowCount,
    latestIndex: latestIndexFor(seat, river),
    badgeCount: river.badgeCount,
    badgeRect: localRect(river.badgeRect, river.rect),
    meldRect: localRect(river.meldRect, river.rect),
    laneWidth: river.laneWidth,
  };
}

const actionMode = computed<'play' | 'claim' | 'exchange' | 'lack'>(() => {
  if (phase.value === 'rob') return 'claim';
  if (
    phase.value === 'play' ||
    phase.value === 'claim' ||
    phase.value === 'exchange' ||
    phase.value === 'lack'
  ) {
    return phase.value;
  }
  return 'play';
});
const showPass = computed(() => myClaims.value.some((o) => o.claim === 'pass'));
const hasActions = computed(() => {
  if (props.settlementArrived || props.settlementRevealed) return false;
  if (!props.interactive || !amActive.value) return false;
  switch (phase.value) {
    case 'exchange':
    case 'lack':
    case 'play':
      return true;
    case 'claim':
    case 'rob':
      return myClaims.value.length > 0;
    default:
      return false;
  }
});

// —— Batch 2 新增逻辑 ——

/**
 * T5 Batch 2：定缺推荐。
 * 找出手牌里唯一最少花色，给对应按钮加静态金边高亮。
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

// —— 胡牌 banner：bannerSeq key + FIFO；reduced-motion 由下一版/揭示出队 ——

/** 复用 Hand.vue 的判据：系统开启「减少动态效果」时 animationend 不触发。 */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function showNextBanner(): void {
  bannerSeq.value += 1;
  currentBanner.value = bannerQueue.value.shift() ?? null;
  bannerAtVersion.value = props.view?.version ?? null;
}

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

/** reduced-motion：无 animationend ⇒ 下一版 view 变化时出队当前 banner。 */
watch(
  () => props.view?.version,
  (v) => {
    if (!currentBanner.value) return;
    if (!prefersReducedMotion()) return;
    if (bannerAtVersion.value === (v ?? null)) return;
    showNextBanner();
  },
);

/** 结算揭示：清空整队（不只弹一条）。settlementArrived 不截断正常动画。 */
watch(
  () => props.settlementRevealed,
  (on) => {
    if (on) {
      bannerQueue.value = [];
      currentBanner.value = null;
    }
  },
);

/** T7 Batch 2 + 胡 banner：挂载时 seed 已有副露/胡牌，重连/中途进房不重播。 */
function bootstrapSeen(): void {
  for (const info of props.view?.huInfos ?? []) seenHuSeats.add(info.seat);
  (props.view?.melds ?? []).forEach((seatMelds, seat) => {
    for (const m of seatMelds) seenMeldKeys.add(meldKey(seat, m));
  });
  initialBootDone.value = true;
}
bootstrapSeen();

/** T7 Batch 2：watch melds 变化，标记增量。 */
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
  <view class="mj" :style="{ '--mj-u': `${layout.u}` }">
    <!-- 牌桌绒面：1334×750 构图（offset 居中），必须排在所有内容之前 -->
    <view class="mj__felt" :style="feltStyle">
      <view class="mj__felt-line" />
    </view>
    <view class="mj__bar" :style="rectStyle(layout.rects.bar)">
      <view class="mj__bar-left">
        <button
          type="button"
          class="mj__back"
          aria-label="返回大厅"
          @click="emit('leave')"
        >
          <text class="mj__back-glyph">‹</text>
        </button>
        <text v-if="barTitle" class="mj__bar-title">{{ barTitle }}</text>
        <text v-if="roomCode" class="mj__bar-sub">房间 {{ roomCode }}</text>
      </view>
      <view class="mj__bar-right">
        <button
          v-if="!settlementRevealed && phase !== 'ended'"
          type="button"
          class="mj__bar-action mj__trustee"
          :class="{ 'mj__bar-action--on': myTrustee }"
          :aria-pressed="myTrustee"
          @click="onTrustee(!myTrustee)"
        >
          托管
        </button>
        <button
          v-if="!settlementRevealed"
          type="button"
          class="mj__bar-action mj__more"
          @click="emit('more')"
        >
          更多
        </button>
      </view>
    </view>

    <view v-if="waitingForDeal" class="mj__waiting">已进房，等待服务端发牌…</view>
    <template v-else>
      <MahjongSeatChip
        v-if="view"
        v-bind="chipProps(topSeat, 'corner-top')"
        :style="rectStyle(layout.seatPlates.top)"
      />

      <MahjongHandBacks
        class="mj-backs-slot mj-backs-slot--top"
        v-bind="backsProps(topSeat)"
        :style="rectStyle(layout.backs.top.rect)"
      />
      <MahjongHandBacks
        class="mj-backs-slot mj-backs-slot--left"
        v-bind="backsProps(leftSeat)"
        :style="rectStyle(layout.backs.left.rect)"
      />
      <MahjongHandBacks
        class="mj-backs-slot mj-backs-slot--right"
        v-bind="backsProps(rightSeat)"
        :style="rectStyle(layout.backs.right.rect)"
      />

      <MahjongSeatChip
        v-bind="chipProps(leftSeat, 'corner-tl')"
        :style="rectStyle(layout.seatPlates.left)"
      />
      <MahjongSeatChip
        v-bind="chipProps(rightSeat, 'corner-tr')"
        :style="rectStyle(layout.seatPlates.right)"
      />
      <MahjongSeatChip
        v-bind="chipProps(me, 'self')"
        :style="rectStyle(layout.seatPlates.self)"
      />

      <MahjongRiver
        class="mj-river-slot mj-river-slot--top"
        v-bind="riverProps(topSeat)"
        :style="rectStyle(layout.rivers.top.rect)"
        @meld-pop-done="onMeldPopDone"
        @discard-click="onDiscardClick(topSeat, $event)"
      />
      <MahjongRiver
        class="mj-river-slot mj-river-slot--left"
        v-bind="riverProps(leftSeat)"
        :style="rectStyle(layout.rivers.left.rect)"
        @meld-pop-done="onMeldPopDone"
        @discard-click="onDiscardClick(leftSeat, $event)"
      />
      <MahjongRiver
        class="mj-river-slot mj-river-slot--right"
        v-bind="riverProps(rightSeat)"
        :style="rectStyle(layout.rivers.right.rect)"
        @meld-pop-done="onMeldPopDone"
        @discard-click="onDiscardClick(rightSeat, $event)"
      />
      <MahjongRiver
        class="mj-river-slot mj-river-slot--self"
        v-bind="riverProps(me)"
        :style="rectStyle(layout.rivers.self.rect)"
        @meld-pop-done="onMeldPopDone"
        @discard-click="onDiscardClick(me, $event)"
      />

      <MahjongHub
        v-if="view"
        :hub="layout.hub"
        :wall-count="wallCount"
        :seconds="seconds"
        :phase="hubPhase"
        :current-player="currentPlayer"
        :active-seats="activeSeats"
        :seats="hubSeats"
        :ting-count="tingTiles.length"
        :compact="layout.hub.compact"
        :status-text="statusText"
        ended-text=""
        :style="rectStyle(layout.hub.rect)"
      />

      <view v-if="tingTiles.length > 0" class="mj__ting" :style="tingStyle">
        <MahjongTile
          v-for="(t, i) in tingTiles.slice(0, 9)"
          :key="`ting-${i}`"
          :tile="t"
          direction="my"
          :w="20 * layout.u"
          :h="30 * layout.u"
        />
      </view>

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
            :key="`hand-${entry.dealNonce ?? 'seed'}-${i}`"
            :tile="entry.tile"
            direction="my"
            :w="layout.hand.tile.w"
            :h="layout.hand.tile.h"
            :selected="selected.includes(i)"
            :disabled="!handSelectable"
            :class="{
              'anim-deal-in-radial': entry.dealNonce != null && entry.dealNonce === dealEpoch && !entry.drawn,
              'mj__hand-tile--drawn': entry.drawn,
            }"
            :style="{
              '--ftl-delay': `${i * 30}ms`,
              '--mj-deal-x': dealOffsetX(i),
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

      <MahjongActionBar
        v-if="hasActions"
        :mode="actionMode"
        :options="filteredClaims"
        :show-pass="showPass"
        :busy="busy || (phase === 'exchange' && !exchangeReady)"
        :selected-count="selected.length"
        :recommended-suit="lackRecommendation"
        :style="actionsStyle"
        @action="onActionBarAction"
      />

      <!-- 自己胡了（myRevealed 不为空）时，手牌已在 .mj__hand 展示亮牌。 -->
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

    <!-- 胡牌 banner 浮动 view（position: absolute 相对于 .mj 根元素） -->
    <MahjongHuBanner
      v-if="currentBanner"
      :key="bannerSeq"
      :seat="currentBanner.seat"
      :fan="currentBanner.fan"
      :self-draw="currentBanner.selfDraw"
      :anchor="layout.bannerAnchors[slotOf(currentBanner.seat)]"
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
  /* 画布留边 = stage 底色（近黑）；1334×750 构图由 .mj__felt 单独铺（offset 居中）。 */
  background: $ftl-color-mj-stage;
  overflow: hidden;
}

/* —— 牌桌绒面（2026-11-08 红金皮肤）：位置/渐变为内联样式，这里只放内圈金线 —— */
.mj__felt-line {
  position: absolute;
  inset: calc(12px * var(--mj-u));
  box-sizing: border-box;
  border: $ftl-hairline solid $ftl-color-mj-gold-line;
  pointer-events: none;
}

/* —— 顶栏 —— */
.mj__bar {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 14px;
  background: linear-gradient($ftl-color-mj-bar-top, $ftl-color-mj-lacquer);
  border-bottom: $ftl-hairline solid $ftl-color-mj-gold;
}
.mj__bar-left,
.mj__bar-right {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.mj__bar-title {
  overflow: hidden;
  max-width: 100%;
  color: $ftl-color-mj-cream;
  font-size: 22px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mj__bar-sub {
  color: $ftl-color-mj-muted;
  font-size: 16px;
  white-space: nowrap;
}
/* 托管 / 更多：纯文字按钮（透明底、无边框，保留 40px 点击热区） */
.mj__bar-action {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 0 6px;
  border: none;
  background: transparent;
  color: $ftl-color-mj-muted;
  font-size: 16px;
  line-height: 1.2;
  &::after {
    border: none;
  }
}
.mj__bar-action--on {
  color: $ftl-color-mj-status;
}

/* —— 返回按钮：40×40 金框 + flex 居中 `‹`（2026-11-08 起不再用 PNG 箭头） —— */
.mj__back {
  box-sizing: border-box;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  min-width: 40px;
  min-height: 40px;
  padding: 0;
  border: $ftl-hairline solid $ftl-color-mj-gold;
  border-radius: 10px;
  background: transparent;
  color: $ftl-color-mj-gold;
  font-size: 28px;
  line-height: 1;
  &::after {
    border: none;
  }
}
.mj__back-glyph {
  line-height: 1;
}

/* —— 等待 / 静音 —— */
.mj__waiting {
  padding: $ftl-space-9;
  text-align: center;
  color: $ftl-color-text-muted;
  font-size: $ftl-font-md;
}

/* —— 听牌行（自己听牌时的 20×30 小牌） —— */
.mj__ting {
  position: absolute;
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  justify-content: center;
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
  z-index: 10; // P1d 选中时浮到最上层，不被后面的牌盖住
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
  background: rgba($ftl-color-mj-lacquer, 0.92);
  border: 2px solid rgba($ftl-color-mj-gold, 0.6);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mj__hand-hint-popup__title { color: rgba(255,255,255,0.9); font-size: 16px; }
.mj__hand-hint-popup__result--safe { color: $ftl-color-hint-safe; font-size: 18px; font-weight: 700; }
.mj__hand-hint-popup__result--warn { color: $ftl-color-hint-warn; font-size: 18px; font-weight: 700; }
.mj__hand-hint-popup__ting { color: $ftl-color-text-muted; font-size: 12px; }

/* —— 托管遮罩（红金皮肤） —— */
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
  background: rgba($ftl-color-mj-lacquer, 0.85);
  border: $ftl-hairline solid rgba($ftl-color-mj-gold, 0.4);
}
.mj__trustee-title {
  color: $ftl-color-mj-gold;
  font-size: $ftl-font-md;
  font-weight: 700;
}
.mj__trustee-desc {
  color: $ftl-color-mj-muted;
  font-size: $ftl-font-sm;
}
.mj__trustee-cancel {
  margin-top: $ftl-space-2;
}

/* —— 托管取消按钮（本组件唯一 .btn 消费者）：漆底金边 / 主态金渐变深字 —— */
.btn {
  @include ftl-btn;
  border-color: $ftl-color-mj-border;
  border-radius: $ftl-radius-md;
  background: rgba($ftl-color-mj-lacquer, 0.92);
  color: $ftl-color-mj-cream;
  background-image: none;
}
.btn--primary {
  border-color: $ftl-color-mj-edge;
  /* background 简写自带重置 background-image（§5.2.1 主按钮不带贴图,闸见 table-bid-bottom） */
  background: linear-gradient($ftl-color-mj-status, $ftl-color-mj-gold);
  color: $ftl-color-mj-ink;
}
.btn[disabled] {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>

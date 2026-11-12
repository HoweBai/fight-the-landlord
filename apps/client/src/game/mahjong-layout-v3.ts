/**
 * 川麻红金牌桌布局 v3（纯函数，零依赖）。
 *
 * 固定 1334×750 base 构图：所有几何先在 base 坐标系里算好，运行时只按
 * `u = min(W/1334, H/750)` 统一缩放，再用 offsetX/offsetY 居中（多余空间留边）。
 *
 * v15 相对 v2 的变更：
 *  - 侧河固定 2 列、最多 10 行（20 格 = 19 张 + N 徽标），河块移到信息井左右两侧；
 *  - 侧背 / 侧副露 lane 留在外缘，`sideTop = 座位牌底 + gap`（亮牌再 +16）；
 *  - 听牌 30×45、2 行 × 5 列，放在侧副露 lane 右侧、自家河左侧；
 *  - `zoneW` 取左右两侧最大值（hub 恒居中）；输出带 `checks`（越界 + 原型 pairs）。
 *
 * 几何逐行移植自
 * docs/superpowers/specs/2026-11-08-mahjong-table-v15-geometry.mjs 的 layoutBase；
 * 输出层统一把矩形/长度四舍五入到 2 位小数，u / offset 保持精确值。
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface TileSizeV3 {
  w: number;
  h: number;
}

/** 一个座位的负载。melds 直接是每组副露的张数（3 = 顺/刻，4 = 杠），最多取 4 组。 */
export interface SeatLoadV3 {
  discards: number;
  melds: number[];
  /** 亮倒后亮出的张数；>0 时侧河显示亮出的牌而不是弃牌。 */
  revealedCount?: number;
}

export interface TableInputV3 {
  bySlot: {
    self: SeatLoadV3;
    top: SeatLoadV3;
    left: SeatLoadV3;
    right: SeatLoadV3;
  };
  /** 仅作接口稳定；固定 base 构图不依赖阶段。 */
  phase?: string;
  tingCount?: number;
}

/** 副露条带/侧巷的渲染度量。tileW/tileH 已含副露缩放（对家另由 scale 横向压缩）。 */
export interface RiverMeldV3 {
  tileW: number;
  tileH: number;
  overlap: number;
  groupGap: number;
  /** 对家 = 顶副露横向压缩系数 k；自己 = 1；侧家 = sideMeldFit 的拟合比例。 */
  scale: number;
  /** 整条内容的未压缩长度（对家/自己为横向宽度；侧家为纵向长度）。 */
  contentW: number;
}

/**
 * 一条河（v2 的严格超集，字段同形）。
 *  - 上/下河：8/12 列 × 2 行，窗口 23 + N；
 *  - 侧河：固定 2 列块，窗口 19 + N（20 格封顶）。
 * `badgeRect` / `meldRect` 均为画布坐标（tr 缩放后）。
 */
export interface RiverLayoutV3 {
  rect: Rect;
  tile: TileSizeV3;
  cols: number;
  rows: number;
  gap: number;
  /** 上/下河为压缩比（≤1）；侧河为 1（尺寸已算入 tile）。 */
  fit: number;
  raw: number;
  visible: number;
  /** 数值契约：`raw - visible`（亮牌态恒 0）；窗口/徽标另由 `raw > 20` 决定。 */
  overflow: number;
  revealed: boolean;
  windowStart: number;
  windowCount: number;
  latestIndex: number;
  badgeCount: number;
  /** 0-based 徽标格号（= windowCount）。 */
  badgeCell: number;
  badgeRect: Rect | null;
  meldRect: Rect;
  /** 侧家内巷宽度；上/下河为 0。 */
  laneWidth: number;
  meld: RiverMeldV3;
}

export interface TingLayoutV3 {
  rect: Rect;
  tile: TileSizeV3;
  cols: number;
  rows: number;
}

export interface MahjongTableLayoutV3 {
  u: number;
  offsetX: number;
  offsetY: number;
  rects: Record<string, Rect>;
  hub: {
    rect: Rect;
    left: number;
    top: number;
    width: number;
    height: number;
    cx: number;
    cy: number;
    r: number;
    compact: boolean;
  };
  rivers: {
    top: RiverLayoutV3;
    self: RiverLayoutV3;
    left: RiverLayoutV3;
    right: RiverLayoutV3;
  };
  seatPlates: { top: Rect; left: Rect; right: Rect; self: Rect };
  hand: { rect: Rect; tile: TileSizeV3; gap: number; drawnGap: number };
  backs: {
    top: { rect: Rect; tile: TileSizeV3; gap: number };
    left: { rect: Rect; tile: TileSizeV3; pitch: number };
    right: { rect: Rect; tile: TileSizeV3; pitch: number };
  };
  actions: Rect;
  ting: TingLayoutV3;
  topMeld: {
    rect: Rect;
    contentW: number;
    scale: number;
    tile: TileSizeV3;
    overlap: number;
    groupGap: number;
  };
  bannerAnchors: { top: Point; left: Point; right: Point; self: Point };
  /** 空数组 = 布局合法（原型 pairs + 画布越界检查）。 */
  checks: string[];
}

/** base 1334×750 构图 token（设计 px）。 */
export const MAHJONG_TABLE_TOKENS_V3 = {
  bar: 64,
  outer: 12,
  gap: 4,
  handH: 108,
  handCount: 14,
  tileRatio: 75 / 113,
  tileGap: 2,
  drawnGap: 12,
  handClearance: 16,
  topBackH: 46,
  riverH: 56,
  sideTileW: 56,
  sideTileH: (56 * 40) / 49,
  sideRiverTileW: 56,
  sideRiverTileH: (56 * 75) / 113,
  meldScale: 0.8,
  meldOverlap: 4,
  meldGroupGap: 8,
  sideMeldScale: 0.65,
  sideMeldVisualH: 45.714,
  sideMeldVisualW: 56,
  sideMeldOverlap: 4,
  seatPlateW: 160,
  seatPlateH: 56,
  topPlateW: 164,
  selfPlateW: 64,
  selfPlateH: 76,
  actionBtn: 84,
  actionGap: 8,
  actionW: 176,
  actionH: 176,
  tingW: 30,
  tingH: 45,
  tingGap: 2,
  tingMax: 9,
  tingPerRow: 5,
  hubMin: 160,
  hubMax: 200,
  displayCap: 24,
  sideCols: 2,
  sideRowsMax: 10,
  sideVisibleCap: 20,
} as const;

// v17：动作区可视条最大宽 218（4×50 + 3×6），由 MahjongActionBar 使用；
// 该条向左超出 actions 矩形（176）42px，布局 checks 不覆盖 ⇒ 改几何时必须重算
// mahjong-layout-v3.test.ts 的「v17 动作带几何守护」。

const T = MAHJONG_TABLE_TOKENS_V3;

/** 手牌整行宽（14 张 + 13 个缝 + 摸牌缝），base px。 */
const HAND_ROW_W =
  T.handCount * T.handH * T.tileRatio + (T.handCount - 1) * T.tileGap + T.drawnGap;

const BASE_W = 1334;
const BASE_H = 750;

interface NormalizedSeat {
  discards: number;
  meldSizes: number[];
  revealed: number;
}

interface NormalizedInput {
  bySlot: {
    self: NormalizedSeat;
    top: NormalizedSeat;
    left: NormalizedSeat;
    right: NormalizedSeat;
  };
  tingCount: number;
}

interface RiverCore {
  rect: Rect;
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
  gap: number;
  fit: number;
  raw: number;
  visible: number;
  overflow: number;
  revealed: boolean;
  windowStart: number;
  windowCount: number;
  latestIndex: number;
  badgeCount: number;
  badgeCell: number;
  badgeRect: Rect | null;
}

interface BaseRiver extends RiverCore {
  meldRect: Rect;
  laneWidth: number;
  meld: {
    tileW: number;
    tileH: number;
    overlap: number;
    groupGap: number;
    scale: number;
    contentW: number;
  };
}

interface SideFit {
  w: number;
  h: number;
  scale: number;
  tileW: number;
  tileH: number;
  contentW: number;
}

/** 侧区（外缘）只留背 + 副露 lane 的度量。 */
interface SideBase {
  sideTop: number;
  sideBottom: number;
  avail: number;
  backW: number;
  pitch: number;
  backH: number;
  meld: SideFit;
  raw: number;
  visible: number;
  revealed: number;
}

/** 侧河块（内侧，hub 左右）的 2 列窗口度量。 */
interface SideRiverBlock {
  rect: Rect;
  cols: number;
  rows: number;
  raw: number;
  visible: number;
  overflow: number;
  revealed: boolean;
  windowStart: number;
  windowCount: number;
  latestIndex: number;
  badgeCount: number;
  badgeCell: number;
  badgeRect: Rect | null;
}

interface BaseTing {
  rect: Rect;
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
}

interface BaseLayout {
  rects: Record<string, Rect>;
  hub: { rect: Rect; cx: number; cy: number; r: number; compact: boolean };
  rivers: { top: BaseRiver; self: BaseRiver; left: BaseRiver; right: BaseRiver };
  seatPlates: { top: Rect; left: Rect; right: Rect; self: Rect };
  hand: { rect: Rect; tileW: number; tileH: number; gap: number; drawnGap: number };
  backs: {
    top: { rect: Rect; tileW: number; tileH: number; gap: number };
    left: { rect: Rect; tileW: number; tileH: number; pitch: number };
    right: { rect: Rect; tileW: number; tileH: number; pitch: number };
  };
  actions: Rect;
  ting: BaseTing;
  topMeld: {
    rect: Rect;
    contentW: number;
    scale: number;
    tileW: number;
    tileH: number;
    overlap: number;
    groupGap: number;
  };
  bannerAnchors: { top: Point; left: Point; right: Point; self: Point };
  checks: string[];
}

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height };
}

function bottom(r: Rect): number {
  return r.top + r.height;
}

function right(r: Rect): number {
  return r.left + r.width;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 输出层统一四舍五入到 2 位小数；吞掉 -0。 */
function r2(v: number): number {
  const n = Math.round(v * 100) / 100;
  return Object.is(n, -0) ? 0 : n;
}

/** 画布越界判定（±0.01 容差，同 v15 原型）。 */
function inside(r: Rect, W: number, H: number): boolean {
  return (
    r.left >= -0.01 && r.top >= -0.01 && right(r) <= W + 0.01 && bottom(r) <= H + 0.01
  );
}

/** 相交判定（−0.01 容差；允许贴边）。 */
function hit(a: Rect, b: Rect): boolean {
  return (
    a.left < right(b) - 0.01 &&
    b.left < right(a) - 0.01 &&
    a.top < bottom(b) - 0.01 &&
    b.top < bottom(a) - 0.01
  );
}

function normalizeSeat(raw: SeatLoadV3 | undefined): NormalizedSeat {
  const discards = Math.max(0, Math.floor(Number(raw?.discards) || 0));
  const meldsRaw = raw?.melds;
  const groups = Array.isArray(meldsRaw) ? meldsRaw : [];
  const meldSizes = groups.slice(0, 4).map((n) => {
    const v = Math.floor(Number(n) || 0);
    return v <= 3 ? 3 : 4;
  });
  const revealed = Math.max(0, Math.floor(Number(raw?.revealedCount) || 0));
  return { discards, meldSizes, revealed };
}

function normalizeInput(input?: TableInputV3): NormalizedInput {
  const bySlot = input?.bySlot;
  return {
    bySlot: {
      self: normalizeSeat(bySlot?.self),
      top: normalizeSeat(bySlot?.top),
      left: normalizeSeat(bySlot?.left),
      right: normalizeSeat(bySlot?.right),
    },
    tingCount: Math.max(0, Math.floor(Number(input?.tingCount) || 0)),
  };
}

/** 固定 base 构图（1334×750）；逐行移植 v15 原型 layoutBase。 */
function layoutBase(W: number, H: number, input: NormalizedInput): BaseLayout {
  const s = 1; // 固定 base：不再有 per-canvas s/0.86W
  const sc = (v: number) => v * s;
  const gap = sc(T.gap);
  const gapT = sc(T.tileGap);
  const outer = sc(T.outer);
  const bar = sc(T.bar);
  const handH = sc(T.handH);
  const handW = HAND_ROW_W * s;
  const handLeft = (W - handW) / 2;
  const handTop = H - outer - handH;
  const hand = rect(handLeft, handTop, handW, handH);
  const meldTileW = sc(T.riverH * T.meldScale * T.tileRatio);
  const meldTileH = sc(T.riverH * T.meldScale);
  const meldOverlap = sc(T.meldOverlap);
  const meldGroupGap = sc(T.meldGroupGap);

  const meldGroupW = (n: number) => n * meldTileW - (n - 1) * meldOverlap;
  const meldContentW = (sizes: number[]) =>
    sizes.length === 0
      ? 0
      : sizes.reduce((sum, n) => sum + meldGroupW(n), 0) + (sizes.length - 1) * meldGroupGap;

  // —— 底部栈 ——
  const selfSizes = input.bySlot.self.meldSizes;
  const selfMeldH = selfSizes.length > 0 ? meldTileH : 0;
  const selfMeldContentW = selfSizes.length > 0 ? meldContentW(selfSizes) : 0;
  const selfMeldW = selfSizes.length > 0 ? Math.min(handW, selfMeldContentW) : 0;
  const selfMeld = selfMeldH
    ? rect(0, handTop - sc(T.handClearance) - selfMeldH, selfMeldW, selfMeldH)
    : rect(0, 0, 0, 0);
  const ownRiverBottom = selfMeldH ? selfMeld.top - gap : handTop - sc(T.handClearance);
  const ownRiverH = sc(T.riverH * 2 + T.tileGap);

  // —— 顶部栈 ——
  const topBackH = sc(T.topBackH);
  const topBackW = topBackH * T.tileRatio;
  const topBacksW = T.handCount * topBackW + (T.handCount - 1) * gapT;
  const topBacksTop = bar + gap;
  const topSizes = input.bySlot.top.meldSizes;
  const topMeldH = topSizes.length > 0 ? meldTileH : 0;
  const topMeldContentW = topSizes.length > 0 ? meldContentW(topSizes) : 0;
  const topMeldTop = topBacksTop + topBackH + gap;
  const topRiverTop = topMeldTop + (topMeldH ? topMeldH + gap : 0);

  // —— 座位牌 ——
  const leftPlate = rect(outer, bar + gap, sc(T.seatPlateW), sc(T.seatPlateH));
  const rightPlate = rect(W - outer - sc(T.seatPlateW), bar + gap, sc(T.seatPlateW), sc(T.seatPlateH));
  const topPlate = rect((W - sc(T.topPlateW)) / 2, sc(4), sc(T.topPlateW), sc(T.seatPlateH));
  const selfPlate = rect(
    outer,
    handTop + (handH - sc(T.selfPlateH)) / 2,
    sc(T.selfPlateW),
    sc(T.selfPlateH),
  );

  // —— 侧区（只留背 + 副露 lane；河在 hub 两侧）——
  function sideMeldFit(sizes: number[], avail: number): SideFit {
    if (sizes.length === 0) return { w: 0, h: 0, scale: 0, tileW: 0, tileH: 0, contentW: 0 };
    let scale = T.sideMeldScale;
    // 不旋转：left/right 49×40 素材 + vertical 竖排；盒 36.4×29.7@0.65，aspectFit 正好填满
    const tileH = () => sc(T.sideMeldVisualH * scale);
    const tileW = () => sc(T.sideMeldVisualW * scale);
    const overlap = sc(T.sideMeldOverlap);
    const groupH = (n: number) => n * tileH() - (n - 1) * overlap;
    const total = () =>
      sizes.reduce((sum, n) => sum + groupH(n), 0) + (sizes.length - 1) * meldGroupGap;
    while (total() > avail && scale > 0.4) scale -= 0.01;
    const contentW = total();
    return { w: tileW() + sc(4), h: contentW, scale, tileW: tileW(), tileH: tileH(), contentW };
  }

  function sideBase(side: 'left' | 'right', plate: Rect): SideBase {
    const seat = input.bySlot[side];
    const revealed = seat.revealed;
    const raw = revealed > 0 ? revealed : seat.discards;
    const visible = Math.min(raw, T.displayCap);
    const sizes = seat.meldSizes;
    // v15：侧区顶不再取上河底，只看座位牌（亮牌再下移 16）
    const sideTop = bottom(plate) + gap + (revealed > 0 ? sc(16) : 0);
    const sideBottom = handTop - sc(T.handClearance);
    const avail = sideBottom - sideTop;
    const backW = sc(T.sideTileH * T.tileRatio); // 30.34×45.714 侧背
    const pitch = clamp((avail - sc(T.sideTileH)) / 13, sc(8), sc(22));
    const backH = 13 * pitch + sc(T.sideTileH);
    const mf = sideMeldFit(sizes, avail);
    return { sideTop, sideBottom, avail, backW, pitch, backH, meld: mf, raw, visible, revealed };
  }

  const leftZ = sideBase('left', leftPlate);
  const rightZ = sideBase('right', rightPlate);
  // 侧区宽按左右最大值（对称居中）
  const zoneW =
    Math.max(leftZ.backW, rightZ.backW) + gap + Math.max(leftZ.meld.w, rightZ.meld.w);
  const centerLeft = outer + zoneW + gap;
  const centerRight = W - outer - zoneW - gap;
  const centerW = centerRight - centerLeft;
  const centerCx = (centerLeft + centerRight) / 2;
  selfMeld.left = centerCx - selfMeld.width / 2;

  // —— 上/下河（24 格；溢出 23+徽标）——
  function riverTopSelf(side: 'top' | 'self', top: number): RiverCore {
    const discards = input.bySlot[side].discards;
    const raw = discards;
    const visible = Math.min(raw, T.displayCap);
    const overflow = raw - visible;
    const cols = visible <= 16 ? 8 : 12;
    const fit = Math.min(1, centerW / (cols * sc(T.riverH * T.tileRatio) + (cols - 1) * gapT));
    const tileW = sc(T.riverH * T.tileRatio) * fit;
    const tileH = sc(T.riverH) * fit;
    const width = cols * tileW + (cols - 1) * gapT;
    const height = 2 * tileH + gapT;
    const windowCount = overflow > 0 ? 23 : visible;
    const badgeCount = raw - windowCount;
    const windowStart = raw - windowCount;
    const latestIndex = windowCount - 1;
    const badgeCell = windowCount;
    const badgeCol = badgeCell % cols;
    const badgeRow = Math.floor(badgeCell / cols);
    const rx = centerCx - width / 2;
    const badgeRect =
      overflow > 0
        ? rect(
            rx + badgeCol * (tileW + gapT),
            top + badgeRow * (tileH + gapT),
            tileW,
            tileH,
          )
        : null;
    return {
      rect: rect(rx, top, width, height),
      tileW,
      tileH,
      cols,
      rows: 2,
      gap: gapT,
      fit,
      raw,
      visible,
      overflow,
      revealed: input.bySlot[side].revealed > 0,
      windowStart,
      windowCount,
      latestIndex,
      badgeCount,
      badgeCell,
      badgeRect,
    };
  }

  const topRiverBox = riverTopSelf('top', topRiverTop);
  const ownRiverBox = riverTopSelf('self', ownRiverBottom - ownRiverH);

  const topBacks = rect(centerCx - topBacksW / 2, topBacksTop, topBacksW, topBackH);
  const topMeldScale = topMeldContentW > 0 ? Math.min(1, (topBacksW - sc(4)) / topMeldContentW) : 1;
  const topMeldW = Math.min(Math.max(topRiverBox.rect.width, topMeldContentW * topMeldScale), topBacksW);
  const topMeldRect = topMeldH
    ? rect(centerCx - topMeldW / 2, topMeldTop, topMeldW, topMeldH)
    : rect(0, 0, 0, 0);

  // —— hub ——
  const centerTop = bottom(topRiverBox.rect) + gap;
  const centerBottom = ownRiverBox.rect.top - gap;
  const available = Math.max(0, centerBottom - centerTop);
  const hubD = Math.min(clamp(available, sc(T.hubMin), sc(T.hubMax)), Math.max(0, centerW - 2 * gap));
  const hubRect = rect(centerCx - hubD / 2, centerTop + (available - hubD) / 2, hubD, hubD);
  const hub = {
    rect: hubRect,
    cx: centerCx,
    cy: hubRect.top + hubD / 2,
    r: hubD / 2,
    compact: hubD / s < 180,
  };

  // —— 动作区 ——
  const actions = rect(
    Math.max(outer, W - outer - zoneW - gap - sc(T.actionW)),
    handTop - sc(T.handClearance) - sc(T.actionH),
    sc(T.actionW),
    sc(T.actionH),
  );
  // 自己副露优先居中；与动作区冲突时整体左移，右缘贴动作区左缘
  if (selfMeld.width > 0) {
    selfMeld.left = Math.max(
      outer,
      Math.min(centerCx - selfMeld.width / 2, actions.left - gap - selfMeld.width),
    );
  }

  // —— 侧河块（hub 左右，固定 2 列）——
  function sideRiverBlock(
    side: 'left' | 'right',
    z: SideBase,
    topRiver: Rect,
    ownRiver: Rect,
  ): SideRiverBlock {
    const revealed = z.revealed > 0;
    const cols = z.visible > 0 ? T.sideCols : 0;
    const rows =
      z.visible > 0 ? Math.min(T.sideRowsMax, Math.ceil(z.visible / T.sideCols)) : 0;
    // raw > 20 才开窗口（19 + N）；亮牌不产生窗口/徽标（v2 契约）
    const windowed = !revealed && z.raw > T.sideVisibleCap;
    const windowCount = windowed ? T.sideVisibleCap - 1 : z.visible;
    const badgeCount = windowed ? z.raw - windowCount : 0;
    const windowStart = z.raw - windowCount;
    const latestIndex = windowCount - 1;
    const badgeCell = windowCount;
    const blockRows = windowed ? T.sideRowsMax : rows;
    const blockW = cols > 0 ? cols * sc(T.sideRiverTileW) + (cols - 1) * gapT : 0;
    // 刻意留 0.02px 差：blockH 用未舍入的 37.168…，导出 tile.h 舍入为 37.17（计划 I9 接受；按 tile.h 排 10 行得 389.70 vs rect 389.68）
    const blockH =
      blockRows > 0 ? blockRows * sc(T.sideRiverTileH) + (blockRows - 1) * gapT : 0;
    const x =
      side === 'left'
        ? Math.min(topRiver.left, ownRiver.left) - gap - blockW
        : Math.max(right(topRiver), right(ownRiver)) + gap;
    const y = z.sideTop + Math.max(0, (z.avail - blockH) / 2);
    const badgeRect =
      badgeCount > 0
        ? rect(
            x + (badgeCell % T.sideCols) * (sc(T.sideRiverTileW) + gapT),
            y + Math.floor(badgeCell / T.sideCols) * (sc(T.sideRiverTileH) + gapT),
            sc(T.sideRiverTileW),
            sc(T.sideRiverTileH),
          )
        : null;
    return {
      rect: rect(x, y, blockW, blockH),
      cols,
      rows: blockRows,
      raw: z.raw,
      visible: z.visible,
      // 数值契约 = raw − visible；亮牌态恒 0（窗口/徽标另由 raw > 20 决定）
      overflow: revealed ? 0 : z.raw - z.visible,
      revealed,
      windowStart,
      windowCount,
      latestIndex,
      badgeCount,
      badgeCell,
      badgeRect,
    };
  }

  const leftBlock = sideRiverBlock('left', leftZ, topRiverBox.rect, ownRiverBox.rect);
  const rightBlock = sideRiverBlock('right', rightZ, topRiverBox.rect, ownRiverBox.rect);

  // —— 侧背 / 侧副露 lane（外缘）——
  const leftBacks = rect(outer, leftZ.sideTop, leftZ.backW, leftZ.backH);
  const rightBacks = rect(W - outer - rightZ.backW, rightZ.sideTop, rightZ.backW, rightZ.backH);
  const leftMelds = leftZ.meld.w
    ? rect(
        outer + leftZ.backW + gap,
        leftZ.sideTop + Math.max(0, (leftZ.avail - leftZ.meld.h) / 2),
        leftZ.meld.w,
        leftZ.meld.h,
      )
    : rect(0, 0, 0, 0);
  const rightMelds = rightZ.meld.w
    ? rect(
        W - outer - rightZ.backW - gap - rightZ.meld.w,
        rightZ.sideTop + Math.max(0, (rightZ.avail - rightZ.meld.h) / 2),
        rightZ.meld.w,
        rightZ.meld.h,
      )
    : rect(0, 0, 0, 0);

  // —— 听牌（左下空区：侧副露 lane 右侧、自家河左侧）——
  const tingCount = Math.min(input.tingCount, T.tingMax);
  const tingCols = Math.min(tingCount, T.tingPerRow);
  const tingRows = tingCount ? Math.ceil(tingCount / T.tingPerRow) : 0;
  const tingW = tingCols * sc(T.tingW) + Math.max(0, tingCols - 1) * gapT;
  const tingH = tingRows * sc(T.tingH) + Math.max(0, tingRows - 1) * gapT;
  const tingX = outer + leftZ.backW + gap + leftZ.meld.w + gap;
  const tingY = ownRiverBox.rect.top + Math.max(0, (ownRiverBox.rect.height - tingH) / 2);
  const tingRect = tingCount ? rect(tingX, tingY, tingW, tingH) : rect(0, 0, 0, 0);
  const ting: BaseTing = {
    rect: tingRect,
    tileW: sc(T.tingW),
    tileH: sc(T.tingH),
    cols: tingCols,
    rows: tingRows,
  };

  function sideRiver(block: SideRiverBlock, lane: Rect, z: SideBase): BaseRiver {
    return {
      rect: block.rect,
      tileW: sc(T.sideRiverTileW),
      tileH: sc(T.sideRiverTileH),
      cols: block.cols,
      rows: block.rows,
      gap: gapT,
      fit: 1,
      raw: block.raw,
      visible: block.visible,
      overflow: block.overflow,
      revealed: block.revealed,
      windowStart: block.windowStart,
      windowCount: block.windowCount,
      latestIndex: block.latestIndex,
      badgeCount: block.badgeCount,
      badgeCell: block.badgeCell,
      badgeRect: block.badgeRect,
      meldRect: lane,
      laneWidth: z.meld.w,
      meld: {
        tileW: z.meld.tileW,
        tileH: z.meld.tileH,
        overlap: meldOverlap,
        groupGap: meldGroupGap,
        scale: z.meld.scale,
        contentW: z.meld.contentW,
      },
    };
  }

  const leftRiver = sideRiver(leftBlock, leftMelds, leftZ);
  const rightRiver = sideRiver(rightBlock, rightMelds, rightZ);

  const rivers = {
    top: {
      ...topRiverBox,
      meldRect: topMeldRect,
      laneWidth: 0,
      meld: {
        tileW: meldTileW,
        tileH: meldTileH,
        overlap: meldOverlap,
        groupGap: meldGroupGap,
        scale: topMeldScale,
        contentW: topMeldContentW,
      },
    },
    self: {
      ...ownRiverBox,
      meldRect: selfMeld,
      laneWidth: 0,
      meld: {
        tileW: meldTileW,
        tileH: meldTileH,
        overlap: meldOverlap,
        groupGap: meldGroupGap,
        scale: 1,
        contentW: selfMeldContentW,
      },
    },
    left: leftRiver,
    right: rightRiver,
  };

  const rects: Record<string, Rect> = {
    bar: rect(0, 0, BASE_W, sc(T.bar)),
    hand,
    actions,
    hub: hubRect,
    topPlate,
    leftPlate,
    rightPlate,
    selfPlate,
    topBacks,
    topRiver: topRiverBox.rect,
    ownRiver: ownRiverBox.rect,
    leftBacks,
    leftRiver: leftBlock.rect,
    leftMelds,
    rightBacks,
    rightRiver: rightBlock.rect,
    rightMelds,
    selfMeld,
    topMeld: topMeldRect,
    ting: tingRect,
    ...(topRiverBox.badgeRect ? { topBadge: topRiverBox.badgeRect } : {}),
    ...(ownRiverBox.badgeRect ? { ownBadge: ownRiverBox.badgeRect } : {}),
    ...(leftBlock.badgeRect ? { leftBadge: leftBlock.badgeRect } : {}),
    ...(rightBlock.badgeRect ? { rightBadge: rightBlock.badgeRect } : {}),
  };

  // —— checks（画布越界 + v15 原型的 pairs）——
  const checks: string[] = [];
  for (const [name, r] of Object.entries(rects)) {
    if (r.width <= 0 || r.height <= 0) continue;
    if (!inside(r, W, H)) checks.push(`${name} 越界`);
  }
  const pairs: Array<[string, string]> = [
    ['hub', 'topRiver'],
    ['hub', 'ownRiver'],
    ['hub', 'leftRiver'],
    ['hub', 'rightRiver'],
    ['hub', 'leftMelds'],
    ['hub', 'rightMelds'],
    ['hub', 'leftBacks'],
    ['hub', 'rightBacks'],
    ['hub', 'topBacks'],
    ['hub', 'topMeld'],
    ['hub', 'hand'],
    ['hub', 'actions'],
    ['hub', 'topPlate'],
    ['hub', 'leftPlate'],
    ['hub', 'rightPlate'],
    ['actions', 'hand'],
    ['actions', 'selfMeld'],
    ['actions', 'rightRiver'],
    ['actions', 'rightMelds'],
    ['actions', 'rightBacks'],
    ['leftPlate', 'leftBacks'],
    ['leftPlate', 'leftRiver'],
    ['leftPlate', 'topBacks'],
    ['leftPlate', 'topMeld'],
    ['leftPlate', 'leftMelds'],
    ['leftPlate', 'ting'],
    ['rightPlate', 'rightBacks'],
    ['rightPlate', 'rightRiver'],
    ['rightPlate', 'topBacks'],
    ['rightPlate', 'topMeld'],
    ['rightPlate', 'rightMelds'],
    ['rightPlate', 'ting'],
    ['leftMelds', 'leftRiver'],
    ['leftMelds', 'leftBacks'],
    ['leftMelds', 'ting'],
    ['leftMelds', 'ownRiver'],
    ['leftMelds', 'hand'],
    ['rightMelds', 'rightRiver'],
    ['rightMelds', 'rightBacks'],
    ['rightMelds', 'ownRiver'],
    ['rightMelds', 'hand'],
    ['selfPlate', 'hand'],
    ['selfPlate', 'ownRiver'],
    ['selfPlate', 'selfMeld'],
    ['selfPlate', 'ting'],
    ['selfMeld', 'hand'],
    ['topMeld', 'topRiver'],
    ['topMeld', 'topBacks'],
    ['ting', 'ownRiver'],
    ['ting', 'hand'],
    ['ting', 'actions'],
    ['ting', 'selfMeld'],
    ['ting', 'leftRiver'],
    ['ting', 'leftBacks'],
    ['ting', 'rightRiver'],
    ['ting', 'rightMelds'],
    ['leftRiver', 'ownRiver'],
    ['rightRiver', 'ownRiver'],
    ['leftRiver', 'topRiver'],
    ['rightRiver', 'topRiver'],
    ['leftRiver', 'leftBacks'],
    ['rightRiver', 'rightBacks'],
    ['leftRiver', 'rightRiver'],
    ['leftRiver', 'actions'],
    ['leftRiver', 'hand'],
    ['rightRiver', 'hand'],
  ];
  for (const [a, b] of pairs) {
    const ra = rects[a];
    const rb = rects[b];
    if (ra.width > 0 && rb.width > 0 && hit(ra, rb)) {
      const x = Math.min(right(ra), right(rb)) - Math.max(ra.left, rb.left);
      const y = Math.min(bottom(ra), bottom(rb)) - Math.max(ra.top, rb.top);
      checks.push(`${a}×${b} 相交 ${x.toFixed(1)}×${y.toFixed(1)}`);
    }
  }
  // 窗口 + 徽标必须放得下（亮牌无窗口/徽标，不适用）
  if (
    !leftRiver.revealed &&
    leftRiver.cols > 0 &&
    leftRiver.windowCount + (leftRiver.badgeCount > 0 ? 1 : 0) >
      leftRiver.rows * leftRiver.cols
  ) {
    checks.push('左河容量不足');
  }
  if (
    !rightRiver.revealed &&
    rightRiver.cols > 0 &&
    rightRiver.windowCount + (rightRiver.badgeCount > 0 ? 1 : 0) >
      rightRiver.rows * rightRiver.cols
  ) {
    checks.push('右河容量不足');
  }

  return {
    rects,
    hub,
    rivers,
    seatPlates: { top: topPlate, left: leftPlate, right: rightPlate, self: selfPlate },
    hand: {
      rect: hand,
      tileW: handH * T.tileRatio,
      tileH: handH,
      gap: gapT,
      drawnGap: sc(T.drawnGap),
    },
    backs: {
      top: { rect: topBacks, tileW: topBackW, tileH: topBackH, gap: gapT },
      left: { rect: leftBacks, tileW: leftZ.backW, tileH: sc(T.sideTileH), pitch: leftZ.pitch },
      right: { rect: rightBacks, tileW: rightZ.backW, tileH: sc(T.sideTileH), pitch: rightZ.pitch },
    },
    actions,
    ting,
    topMeld: {
      rect: topMeldRect,
      contentW: topMeldContentW,
      scale: topMeldScale,
      tileW: meldTileW,
      tileH: meldTileH,
      overlap: meldOverlap,
      groupGap: meldGroupGap,
    },
    bannerAnchors: {
      top: { x: topPlate.left + topPlate.width / 2, y: topPlate.top + topPlate.height },
      left: { x: leftPlate.left + leftPlate.width / 2, y: leftPlate.top + leftPlate.height / 2 },
      right: { x: rightPlate.left + rightPlate.width / 2, y: rightPlate.top + rightPlate.height / 2 },
      self: { x: hand.left + hand.width / 2, y: hand.top },
    },
    checks,
  };
}

/**
 * 固定 base 布局 + 运行时等比缩放居中。
 * 输出层所有矩形/长度四舍五入到 2 位小数；u/offset 保持精确。
 * `checks`：base 坐标系算一遍（越界 + pairs），再用缩放后 rects 对实际 W/H 做一次越界检查。
 */
export function mahjongTableLayoutV3(
  W: number,
  H: number,
  input?: TableInputV3,
): MahjongTableLayoutV3 {
  const w = Number.isFinite(W) && W > 0 ? W : BASE_W;
  const h = Number.isFinite(H) && H > 0 ? H : BASE_H;
  const u = Math.min(w / BASE_W, h / BASE_H);
  const offsetX = (w - BASE_W * u) / 2;
  const offsetY = (h - BASE_H * u) / 2;
  const base = layoutBase(BASE_W, BASE_H, normalizeInput(input));

  const tr = (r: Rect): Rect => ({
    left: r2(offsetX + r.left * u),
    top: r2(offsetY + r.top * u),
    width: r2(r.width * u),
    height: r2(r.height * u),
  });
  const len = (v: number) => r2(v * u);
  const px = (x: number) => r2(offsetX + x * u);
  const py = (y: number) => r2(offsetY + y * u);
  const point = (p: Point): Point => ({ x: px(p.x), y: py(p.y) });

  const trRiver = (r: BaseRiver): RiverLayoutV3 => {
    const meldRect = tr(r.meldRect);
    return {
      rect: tr(r.rect),
      tile: { w: len(r.tileW), h: len(r.tileH) },
      cols: r.cols,
      rows: r.rows,
      gap: len(r.gap),
      fit: r.fit,
      raw: r.raw,
      visible: r.visible,
      overflow: r.overflow,
      revealed: r.revealed,
      windowStart: r.windowStart,
      windowCount: r.windowCount,
      latestIndex: r.latestIndex,
      badgeCount: r.badgeCount,
      badgeCell: r.badgeCell,
      badgeRect: r.badgeRect ? tr(r.badgeRect) : null,
      meldRect,
      laneWidth: r.laneWidth > 0 ? meldRect.width : 0,
      meld: {
        tileW: len(r.meld.tileW),
        tileH: len(r.meld.tileH),
        overlap: len(r.meld.overlap),
        groupGap: len(r.meld.groupGap),
        scale: r.meld.scale,
        contentW: len(r.meld.contentW),
      },
    };
  };

  const rivers = {
    top: trRiver(base.rivers.top),
    self: trRiver(base.rivers.self),
    left: trRiver(base.rivers.left),
    right: trRiver(base.rivers.right),
  };

  const tingRect = tr(base.ting.rect);
  const rects: Record<string, Rect> = {};
  for (const [key, r] of Object.entries(base.rects)) rects[key] = tr(r);
  rects.ting = tingRect;

  const hubRect = tr(base.hub.rect);
  const hub = {
    rect: hubRect,
    left: hubRect.left,
    top: hubRect.top,
    width: hubRect.width,
    height: hubRect.height,
    cx: px(base.hub.cx),
    cy: py(base.hub.cy),
    r: len(base.hub.r),
    compact: base.hub.compact,
  };

  // 缩放后再对实际 W/H 做一次越界检查（与原型 layout() 同语义）
  const checks = [...base.checks];
  for (const [name, r] of Object.entries(rects)) {
    if (r.width > 0 && r.height > 0 && !inside(r, w, h)) checks.push(`${name} 画布越界`);
  }

  return {
    u,
    offsetX,
    offsetY,
    rects,
    hub,
    rivers,
    seatPlates: {
      top: tr(base.seatPlates.top),
      left: tr(base.seatPlates.left),
      right: tr(base.seatPlates.right),
      self: tr(base.seatPlates.self),
    },
    hand: {
      rect: tr(base.hand.rect),
      tile: { w: len(base.hand.tileW), h: len(base.hand.tileH) },
      gap: len(base.hand.gap),
      drawnGap: len(base.hand.drawnGap),
    },
    backs: {
      top: {
        rect: tr(base.backs.top.rect),
        tile: { w: len(base.backs.top.tileW), h: len(base.backs.top.tileH) },
        gap: len(base.backs.top.gap),
      },
      left: {
        rect: tr(base.backs.left.rect),
        tile: { w: len(base.backs.left.tileW), h: len(base.backs.left.tileH) },
        pitch: len(base.backs.left.pitch),
      },
      right: {
        rect: tr(base.backs.right.rect),
        tile: { w: len(base.backs.right.tileW), h: len(base.backs.right.tileH) },
        pitch: len(base.backs.right.pitch),
      },
    },
    actions: tr(base.actions),
    ting: {
      rect: tingRect,
      tile: { w: len(base.ting.tileW), h: len(base.ting.tileH) },
      cols: base.ting.cols,
      rows: base.ting.rows,
    },
    topMeld: {
      rect: tr(base.topMeld.rect),
      contentW: len(base.topMeld.contentW),
      scale: base.topMeld.scale,
      tile: { w: len(base.topMeld.tileW), h: len(base.topMeld.tileH) },
      overlap: len(base.topMeld.overlap),
      groupGap: len(base.topMeld.groupGap),
    },
    bannerAnchors: {
      top: point(base.bannerAnchors.top),
      left: point(base.bannerAnchors.left),
      right: point(base.bannerAnchors.right),
      self: point(base.bannerAnchors.self),
    },
    checks,
  };
}

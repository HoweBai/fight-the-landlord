/**
 * 川麻红金牌桌布局 v2（纯函数，零依赖）。
 *
 * 固定 1334×750 base 构图：所有几何先在 base 坐标系里算好，运行时只按
 * `u = min(W/1334, H/750)` 统一缩放，再用 offsetX/offsetY 居中（多余空间留边）。
 * 不再有 per-canvas 的 s / 0.86W。
 *
 * 几何逐行移植自
 * docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs 的 layoutBase；
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

export interface TileSizeV2 {
  w: number;
  h: number;
}

/** 一个座位的负载。melds 直接是每组副露的张数（3 = 顺/刻，4 = 杠），最多取 4 组。 */
export interface SeatLoadV2 {
  discards: number;
  melds: number[];
  /** 亮倒后亮出的张数；>0 时侧河显示亮出的牌而不是弃牌。 */
  revealedCount?: number;
}

export interface TableInputV2 {
  bySlot: {
    self: SeatLoadV2;
    top: SeatLoadV2;
    left: SeatLoadV2;
    right: SeatLoadV2;
  };
  /** 仅作接口稳定；固定 base 构图不依赖阶段。 */
  phase?: string;
  tingCount?: number;
}

/** 副露条带/侧巷的渲染度量。tileW/tileH 已含副露缩放（对家另由 scale 横向压缩）。 */
export interface RiverMeldV2 {
  tileW: number;
  tileH: number;
  overlap: number;
  groupGap: number;
  /** 对家 = 顶副露横向压缩系数 k；自己 = 1；侧家 = sideMeldFit 的拟合比例。 */
  scale: number;
  /** 整条内容的未压缩长度（对家/自己为横向宽度；侧家为纵向长度）。 */
  contentW: number;
}

export interface RiverLayoutV2 {
  rect: Rect;
  tile: TileSizeV2;
  cols: number;
  rows: number;
  gap: number;
  /** 上/下河为压缩比（≤1）；侧河为 1（尺寸已算入 tile）。 */
  fit: number;
  raw: number;
  visible: number;
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
  meld: RiverMeldV2;
}

export interface MahjongTableLayoutV2 {
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
    top: RiverLayoutV2;
    self: RiverLayoutV2;
    left: RiverLayoutV2;
    right: RiverLayoutV2;
  };
  seatPlates: { top: Rect; left: Rect; right: Rect; self: Rect };
  hand: { rect: Rect; tile: TileSizeV2; gap: number; drawnGap: number };
  backs: {
    top: { rect: Rect; tile: TileSizeV2; gap: number };
    left: { rect: Rect; tile: TileSizeV2; pitch: number };
    right: { rect: Rect; tile: TileSizeV2; pitch: number };
  };
  actions: Rect;
  ting: Rect;
  topMeld: {
    rect: Rect;
    contentW: number;
    scale: number;
    tile: TileSizeV2;
    overlap: number;
    groupGap: number;
  };
  bannerAnchors: { top: Point; left: Point; right: Point; self: Point };
}

/** base 1334×750 构图 token（设计 px）。 */
export const MAHJONG_TABLE_TOKENS_V2 = {
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
  tingW: 20,
  tingH: 30,
  tingGap: 2,
  tingMax: 9,
  tingPerRow: 4,
  hubMin: 160,
  hubMax: 200,
  displayCap: 24,
} as const;

const T = MAHJONG_TABLE_TOKENS_V2;

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

interface SideZone {
  sideTop: number;
  sideBottom: number;
  avail: number;
  rows: number;
  cols: number;
  riverW: number;
  riverH: number;
  backW: number;
  pitch: number;
  backH: number;
  meld: SideFit;
  zoneW: number;
  visible: number;
  overflow: number;
  raw: number;
  revealed: number;
  windowCount: number;
  badgeCount: number;
  windowStart: number;
  latestIndex: number;
  badgeCell: number;
  tileW: number;
  tileH: number;
}

interface SideRects {
  backs: Rect;
  river: Rect;
  melds: Rect;
  badge: Rect | null;
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
  ting: Rect;
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
}

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height };
}

function bottom(r: Rect): number {
  return r.top + r.height;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 输出层统一四舍五入到 2 位小数；吞掉 -0。 */
function r2(v: number): number {
  const n = Math.round(v * 100) / 100;
  return Object.is(n, -0) ? 0 : n;
}

function normalizeSeat(raw: SeatLoadV2 | undefined): NormalizedSeat {
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

function normalizeInput(input?: TableInputV2): NormalizedInput {
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

/** 固定 base 构图（1334×750）；逐行移植原型 layoutBase。 */
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

  // —— 侧区 ——
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

  function sideZone(side: 'left' | 'right', plate: Rect): SideZone {
    const seat = input.bySlot[side];
    const revealed = seat.revealed;
    const raw = revealed > 0 ? revealed : seat.discards;
    const visible = Math.min(raw, T.displayCap);
    const overflow = revealed > 0 ? 0 : raw - visible;
    const sizes = seat.meldSizes;
    const sideTop = Math.max(topRiverTop, bottom(plate) + gap) + (revealed > 0 ? sc(16) : 0);
    const sideBottom = handTop - sc(T.handClearance);
    const avail = sideBottom - sideTop;
    const baseTileW = sc(T.sideTileW);
    const baseTileH = sc(T.sideTileH);
    let rows: number;
    let cols: number;
    let tileW: number;
    let tileH: number;
    if (visible <= 12) {
      rows = Math.max(1, visible);
      cols = 1;
      tileH = Math.min(baseTileH, (avail - (rows - 1) * gapT) / rows);
      tileW = (tileH * 49) / 40;
    } else {
      rows = clamp(Math.floor((avail + gapT) / (baseTileH + gapT)), 3, 10);
      cols = clamp(Math.ceil(visible / rows), 2, 6);
      tileH = baseTileH;
      tileW = baseTileW;
    }
    const riverW = cols * tileW + (cols - 1) * gapT;
    const riverH = rows * tileH + (rows - 1) * gapT;
    const backW = sc(T.sideTileH * T.tileRatio); // 83×125
    const pitch = clamp((avail - sc(T.sideTileH)) / 13, sc(8), sc(22));
    const backH = 13 * pitch + sc(T.sideTileH);
    const mf = sideMeldFit(sizes, avail);
    const zoneW = backW + gap + riverW + (mf.w ? gap + mf.w : 0);
    const capacity = rows * cols;
    const windowCount = overflow > 0 ? (capacity >= 25 ? 24 : 23) : visible;
    const badgeCount = raw - windowCount;
    const windowStart = raw - windowCount;
    const latestIndex = windowCount - 1;
    const badgeCell = windowCount;
    return {
      sideTop,
      sideBottom,
      avail,
      rows,
      cols,
      riverW,
      riverH,
      backW,
      pitch,
      backH,
      meld: mf,
      zoneW,
      visible,
      overflow,
      raw,
      revealed,
      windowCount,
      badgeCount,
      windowStart,
      latestIndex,
      badgeCell,
      tileW,
      tileH,
    };
  }

  const leftZ = sideZone('left', leftPlate);
  const rightZ = sideZone('right', rightPlate);
  const centerLeft = outer + leftZ.zoneW + gap;
  const centerRight = W - outer - rightZ.zoneW - gap;
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
    const gridW = cols * tileW + (cols - 1) * gapT;
    const gridH = 2 * tileH + gapT;
    const badgeCell = windowCount;
    const badgeCol = badgeCell % cols;
    const badgeRow = Math.floor(badgeCell / cols);
    const rx = centerCx - width / 2;
    const badgeRect =
      overflow > 0
        ? rect(
            rx + (width - gridW) / 2 + badgeCol * (tileW + gapT),
            top + (height - gridH) / 2 + badgeRow * (tileH + gapT),
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
    Math.max(outer, W - outer - rightZ.zoneW - gap - sc(T.actionW)),
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

  // —— 侧区矩形 ——
  function sideRects(side: 'left' | 'right', z: SideZone): SideRects {
    const isLeft = side === 'left';
    const backX = isLeft ? outer : W - outer - z.backW;
    const riverX = isLeft ? outer + z.backW + gap : W - outer - z.backW - gap - z.riverW;
    const meldX = isLeft ? riverX + z.riverW + gap : riverX - gap - z.meld.w;
    const badge =
      z.overflow > 0
        ? (() => {
            const gridW = z.cols * z.tileW + (z.cols - 1) * gapT;
            const gridH = z.rows * z.tileH + (z.rows - 1) * gapT;
            const row = Math.floor(z.badgeCell / z.cols);
            const col = z.badgeCell % z.cols;
            return rect(
              riverX + (z.riverW - gridW) / 2 + col * (z.tileW + gapT),
              z.sideTop + (z.riverH - gridH) / 2 + row * (z.tileH + gapT),
              z.tileW,
              z.tileH,
            );
          })()
        : null;
    return {
      backs: rect(backX, z.sideTop, z.backW, z.backH),
      river: rect(riverX, z.sideTop, z.riverW, z.riverH),
      melds: z.meld.w
        ? rect(meldX, z.sideTop + Math.max(0, (z.avail - z.meld.h) / 2), z.meld.w, z.meld.h)
        : rect(0, 0, 0, 0),
      badge,
    };
  }
  const leftR = sideRects('left', leftZ);
  const rightR = sideRects('right', rightZ);

  // —— 听牌 ——
  const tingCount = Math.min(input.tingCount, T.tingMax);
  const tingCols = Math.min(tingCount, T.tingPerRow);
  const tingRows = Math.ceil(tingCount / T.tingPerRow) || 1;
  const tingW = tingCols * sc(T.tingW) + Math.max(0, tingCols - 1) * gapT;
  const tingH = tingRows * sc(T.tingH) + Math.max(0, tingRows - 1) * gapT;
  const tingX = Math.max(handLeft + sc(8), ownRiverBox.rect.left - gap - tingW);
  const ting = tingCount
    ? rect(tingX, ownRiverBox.rect.top + (ownRiverBox.rect.height - tingH) / 2, tingW, tingH)
    : rect(0, 0, 0, 0);

  function sideRiver(z: SideZone, sr: SideRects): BaseRiver {
    return {
      rect: sr.river,
      tileW: z.tileW,
      tileH: z.tileH,
      cols: z.cols,
      rows: z.rows,
      gap: gapT,
      fit: 1,
      raw: z.raw,
      visible: z.visible,
      overflow: z.overflow,
      revealed: z.revealed > 0,
      windowStart: z.windowStart,
      windowCount: z.windowCount,
      latestIndex: z.latestIndex,
      badgeCount: z.badgeCount,
      badgeCell: z.badgeCell,
      badgeRect: sr.badge,
      meldRect: sr.melds,
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
    left: sideRiver(leftZ, leftR),
    right: sideRiver(rightZ, rightR),
  };

  const rects: Record<string, Rect> = {
    bar: rect(0, 0, 1334, 64),
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
    leftBacks: leftR.backs,
    leftRiver: leftR.river,
    leftMelds: leftR.melds,
    rightBacks: rightR.backs,
    rightRiver: rightR.river,
    rightMelds: rightR.melds,
    selfMeld,
    topMeld: topMeldRect,
    ting,
    ...(topRiverBox.badgeRect ? { topBadge: topRiverBox.badgeRect } : {}),
    ...(ownRiverBox.badgeRect ? { ownBadge: ownRiverBox.badgeRect } : {}),
    ...(leftR.badge ? { leftBadge: leftR.badge } : {}),
    ...(rightR.badge ? { rightBadge: rightR.badge } : {}),
  };

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
      left: { rect: leftR.backs, tileW: leftZ.backW, tileH: sc(T.sideTileH), pitch: leftZ.pitch },
      right: { rect: rightR.backs, tileW: rightZ.backW, tileH: sc(T.sideTileH), pitch: rightZ.pitch },
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
  };
}

/**
 * 固定 base 布局 + 运行时等比缩放居中。
 * 输出层所有矩形/长度四舍五入到 2 位小数；u/offset 保持精确。
 */
export function mahjongTableLayoutV2(
  W: number,
  H: number,
  input?: TableInputV2,
): MahjongTableLayoutV2 {
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

  const trRiver = (r: BaseRiver): RiverLayoutV2 => {
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

  const rects: Record<string, Rect> = {};
  for (const [key, r] of Object.entries(base.rects)) rects[key] = tr(r);

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
    ting: tr(base.ting),
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
  };
}

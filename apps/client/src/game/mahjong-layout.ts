/**
 * 麻将牌桌比例布局（纯函数，零依赖）。
 *
 * 坐标模型：画布设计尺寸 W×H（恒 ≥1334×750，至少一条边正好在最小值）。
 * 统一比例单位 s = min(H/750, 0.88W/handRowW)，且 s ≥ 1：
 *  - 高度是竖向节奏基准；
 *  - 宽度兜底保证 14 张手牌永远 ≤88% 宽，左侧留出自家人像卡。
 *
 * 所有输出均为**设计 px**（画布坐标），由 LandscapeStage 的 transform: scale(k) 统一缩放。
 * 本文件不读窗口、不读 store、不造计时器。
 */

export interface MahjongSeatLoad {
  discards: number;
  melds: number;
}

export interface MahjongTableInput {
  top?: Partial<MahjongSeatLoad>;
  left?: Partial<MahjongSeatLoad>;
  right?: Partial<MahjongSeatLoad>;
  self?: Partial<MahjongSeatLoad>;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TileSize {
  w: number;
  h: number;
}

export type MeldPlacement = 'above' | 'below';

export interface RiverLayout {
  rect: Rect;
  tile: TileSize;
  cols: number;
  rows: number;
  gap: number;
  /** 1 = 原始尺寸；<1 = 弃牌超过 24 张后的压缩比。 */
  fit: number;
  meld: {
    /** 条带自身高度（px）；0 = 该座无副露。 */
    height: number;
    /** 条带的屏幕矩形（相对画布）；height=0 时为零矩形。 */
    rect: Rect;
    placement: MeldPlacement;
    tile: TileSize;
    overlap: number;
    /** 条带与牌河/手牌之间的固定间距（px）。 */
    gap: number;
    /** 副露组之间的间距（px）；左右家用 4s，对家/自己用 8s。 */
    groupGap: number;
  };
}

export interface MahjongTableLayout {
  s: number;
  bar: Rect;
  topZone: Rect;
  leftZone: Rect;
  rightZone: Rect;
  centerZone: Rect;
  centerCard: Rect;
  centerCompact: boolean;
  centerTiles: { claim: TileSize; ting: TileSize };
  hand: { rect: Rect; tile: TileSize; gap: number; drawnGap: number };
  ownRiver: RiverLayout;
  topRiver: RiverLayout;
  leftRiver: RiverLayout;
  rightRiver: RiverLayout;
  topBacks: { rect: Rect; tile: TileSize; gap: number };
  leftBacks: { rect: Rect; tile: TileSize; pitch: number };
  rightBacks: { rect: Rect; tile: TileSize; pitch: number };
  selfChip: Rect;
  leftChip: Rect;
  rightChip: Rect;
  barChip: TileSize;
  actions: {
    /** 浮层右缘 x 坐标（屏幕/画布坐标）。 */
    rightX: number;
    /** 浮层底缘 y 坐标（屏幕/画布坐标）。 */
    bottomY: number;
    /** CSS `right` 偏移 = W − rightX。 */
    rightOffset: number;
    /** CSS `bottom` 偏移 = H − bottomY。 */
    bottomOffset: number;
    maxWidth: number;
    /** 按钮区最小高度（px）；内容可向上长。 */
    minHeight: number;
  };
}

/** s=1 的设计 token；测试与组件测试引用，业务布局一律用输出值。 */
export const MAHJONG_TABLE_TOKENS = {
  barH: 64,
  outer: 12,
  inner: 8,
  gap: 2,
  handH: 108,
  handCount: 14, // 手牌 13+1；backCount 必须同值
  drawnGap: 12,
  riverH: 50,
  riverCols: 12,
  riverRows: 2,
  topBackH: 48,
  topBackGap: 2,
  sideBackH: 49, // 槽高（pitch 叠压用）；与 sideRiver tile 高（40）对齐更顺
  sidePitch: 27,
  backCount: 12, // topBacks 宽度 ≈ riverW ≈ 420px 只能放 12 张 48×75/113 tile；左右家保持上限 14
  sideRiverW: 49,
  sideRiverH: 40,
  sideRiverCols: 3,
  sideRiverRows: 8,
  meldScale: 0.8,
  sideMeldScale: 0.65,
  meldOverlap: 4,
  sideMeldGap: 4,
  chip: 60,
  sideChipW: 200, // 头像 56 + 名字/分/徽标列 144（多出 20px 给底部徽标条带）
  selfChipW: 56,
  selfChipH: 76,
  barChipW: 56,
  barChipH: 56,
  centerClaimW: 34,
  centerClaimH: 51,
  centerTingW: 20,
  centerTingH: 30,
  actionsMaxW: 400,
} as const;

/** 本文件内的短名（测试仍用 `MAHJONG_TABLE_TOKENS`）。 */
const T = MAHJONG_TABLE_TOKENS;

/** 麻将牌面宽高比（my/top 素材 75×113）。 */
const TILE_RATIO = 75 / 113;

const DEFAULT_W = 1334;
const DEFAULT_H = 750;

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeLoad(raw: Partial<MahjongSeatLoad> | undefined): MahjongSeatLoad {
  return {
    discards: Math.max(0, Math.floor(Number(raw?.discards) || 0)),
    melds: Math.max(0, Math.min(4, Math.floor(Number(raw?.melds) || 0))),
  };
}

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height };
}

function buildRiver(args: {
  rect: Rect;
  side: boolean;
  discards: number;
  melds: number;
  s: number;
  placement: MeldPlacement;
}): RiverLayout {
  const { rect: box, side, discards, melds, s, placement } = args;
  const cols = side ? (discards > 24 ? 4 : 3) : T.riverCols;
  const rows = side ? T.sideRiverRows : discards > 24 ? 3 : T.riverRows;
  const baseW = (side ? T.sideRiverW : T.riverH * TILE_RATIO) * s;
  const baseH = (side ? T.sideRiverH : T.riverH) * s;
  const baseGap = T.gap * s;
  const fit = Math.min(
    1,
    box.width / (cols * baseW + (cols - 1) * baseGap),
    box.height / (rows * baseH + (rows - 1) * baseGap),
  );
  const meldTile: TileSize = side
    ? {
        w: T.sideRiverW * T.sideMeldScale * s,
        h: T.sideRiverH * T.sideMeldScale * s,
      }
    : {
        w: T.riverH * TILE_RATIO * T.meldScale * s,
        h: T.riverH * T.meldScale * s,
      };
  const meldHeight =
    melds <= 0
      ? 0
      : side
        ? melds * meldTile.h + (melds - 1) * T.sideMeldGap * s
        : meldTile.h;
  const meldGap = T.inner * s;
  const groupGap = side ? T.sideMeldGap * s : T.inner * s;
  const meldRect =
    meldHeight <= 0
      ? { left: 0, top: 0, width: 0, height: 0 }
      : placement === 'above'
        ? { left: box.left, top: box.top - meldGap - meldHeight, width: box.width, height: meldHeight }
        : { left: box.left, top: box.top + box.height + meldGap, width: box.width, height: meldHeight };

  return {
    rect: box,
    cols,
    rows,
    fit,
    tile: { w: baseW * fit, h: baseH * fit },
    gap: baseGap * fit,
    meld: {
      height: meldHeight,
      rect: meldRect,
      placement,
      tile: meldTile,
      overlap: T.meldOverlap * s,
      gap: meldGap,
      groupGap,
    },
  };
}

export function mahjongTableLayout(
  width: number,
  height: number,
  input: Partial<MahjongTableInput> = {},
): MahjongTableLayout {
  const w = finitePositive(width, DEFAULT_W);
  const h = finitePositive(height, DEFAULT_H);

  const top = normalizeLoad(input.top);
  const left = normalizeLoad(input.left);
  const right = normalizeLoad(input.right);
  const self = normalizeLoad(input.self);

  const handRowW = (T.handCount * T.handH * TILE_RATIO + (T.handCount - 1) * T.gap + T.drawnGap);
  const s = Math.max(1, Math.min(h / DEFAULT_H, (0.88 * w) / handRowW));

  // —— 竖向尺寸 ——
  const barH = T.barH * s;
  const inner = T.inner * s;
  const outer = T.outer * s;
  const handH = T.handH * s;
  const riverH = (T.riverRows * T.riverH + (T.riverRows - 1) * T.gap) * s;
  const topBackH = T.topBackH * s;
  const topMeldH = T.riverH * T.meldScale * s;
  const sideMeldH = T.sideRiverH * T.sideMeldScale * s;
  const sideMeldStrip = (n: number): number =>
    n > 0 ? n * sideMeldH + (n - 1) * T.sideMeldGap * s + inner : 0;

  const topZoneH =
    inner + topBackH + inner + (top.melds > 0 ? topMeldH + inner : 0) + riverH;
  const bottomZoneH =
    riverH + inner + (self.melds > 0 ? topMeldH + inner : 0) + handH + outer;
  const sideHandH = (T.backCount * T.sidePitch + T.sideBackH) * s;
  const sideRiverH = (T.sideRiverRows * T.sideRiverH + (T.sideRiverRows - 1) * T.gap) * s;
  const sideZoneH =
    T.chip * s + inner + Math.max(sideHandH, sideRiverH + sideMeldStrip(Math.max(left.melds, right.melds)));

  // —— 横向尺寸 ——
  const riverW = T.riverCols * T.riverH * TILE_RATIO * s + (T.riverCols - 1) * T.gap * s;
  const handW = handRowW * s;
  const sideBackW = T.sideBackH * TILE_RATIO * s;
  const sideRiverW = (T.sideRiverCols * T.sideRiverW + (T.sideRiverCols - 1) * T.gap) * s;
  const sideZoneW = outer + Math.max(T.sideChipW * s, sideBackW + inner + sideRiverW);

  // —— 主要锚点 ——
  const handLeft = (w - handW) / 2;
  const handTop = h - outer - handH;
  const ownRiverLeft = (w - riverW) / 2;
  const ownRiverTop =
    handTop - inner - (self.melds > 0 ? topMeldH + inner : 0) - riverH;

  const topZone = rect(ownRiverLeft, barH, riverW, topZoneH);
  const topBackTop = barH + inner;
  const topRiverTop =
    topBackTop + topBackH + inner + (top.melds > 0 ? topMeldH + inner : 0);

  const sideTop =
    barH + inner + Math.max(0, (handTop - (barH + inner) - sideZoneH) / 2);
  const sideRowTop = sideTop + T.chip * s + inner;
  const leftZone = rect(0, sideTop, sideZoneW, sideZoneH);
  const rightZone = rect(w - sideZoneW, sideTop, sideZoneW, sideZoneH);

  const centerLeft = sideZoneW + inner;
  const centerRight = w - sideZoneW - inner;
  const centerTop = Math.min(barH + topZoneH, h - bottomZoneH);
  const centerBottom = Math.max(centerTop, h - bottomZoneH);
  const centerZone = rect(centerLeft, centerTop, centerRight - centerLeft, centerBottom - centerTop);

  const centerCompact = centerZone.height < 176 * s;
  // 紧凑模式单行内容有限，上限 360*s；非紧凑模式有 claim/ting 牌面展示，上限 480*s
  const centerCardW = Math.max(
    0,
    Math.min(
      (centerCompact ? 360 : 480) * s,
      centerZone.width - (centerCompact ? 8 : 16) * s,
    ),
  );
  const centerCardH = Math.max(
    0,
    Math.min(160 * s, centerZone.height - (centerCompact ? 8 : 16) * s),
  );
  const centerCard = rect(
    centerZone.left + (centerZone.width - centerCardW) / 2,
    centerZone.top + (centerZone.height - centerCardH) / 2,
    centerCardW,
    centerCardH,
  );

  const hand = {
    rect: rect(handLeft, handTop, handW, handH),
    tile: { w: T.handH * TILE_RATIO * s, h: handH },
    gap: T.gap * s,
    drawnGap: T.drawnGap * s,
  };

  const ownRiver = buildRiver({
    rect: rect(ownRiverLeft, ownRiverTop, riverW, riverH),
    side: false,
    discards: self.discards,
    melds: self.melds,
    s,
    placement: 'below',
  });
  const topRiver = buildRiver({
    rect: rect(ownRiverLeft, topRiverTop, riverW, riverH),
    side: false,
    discards: top.discards,
    melds: top.melds,
    s,
    placement: 'above',
  });
  const leftRiver = buildRiver({
    rect: rect(outer + sideBackW + inner, sideRowTop, sideRiverW, sideRiverH),
    side: true,
    discards: left.discards,
    melds: left.melds,
    s,
    placement: 'below',
  });
  const rightRiver = buildRiver({
    rect: rect(
      w - outer - sideBackW - inner - sideRiverW,
      sideRowTop,
      sideRiverW,
      sideRiverH,
    ),
    side: true,
    discards: right.discards,
    melds: right.melds,
    s,
    placement: 'below',
  });

  const topBacks = {
    rect: rect(ownRiverLeft, topBackTop, riverW, topBackH),
    tile: { w: topBackH * TILE_RATIO, h: topBackH },
    gap: T.topBackGap * s,
  };
  const sideBackTile = { w: sideBackW, h: T.sideBackH * s };
  const leftBacks = {
    rect: rect(outer, sideRowTop, sideBackW, sideHandH),
    tile: sideBackTile,
    pitch: T.sidePitch * s,
  };
  const rightBacks = {
    rect: rect(w - outer - sideBackW, sideRowTop, sideBackW, sideHandH),
    tile: sideBackTile,
    pitch: T.sidePitch * s,
  };

  const selfChip = rect(
    outer,
    handTop + ((T.handH - T.selfChipH) / 2) * s,
    T.selfChipW * s,
    T.selfChipH * s,
  );
  const leftChip = rect(outer, sideTop, T.sideChipW * s, T.chip * s);
  const rightChip = rect(w - outer - T.sideChipW * s, sideTop, T.sideChipW * s, T.chip * s);

  const rightX = w - sideZoneW - inner;
  const bottomY = handTop - inner;
  const actions = {
    rightX,
    bottomY,
    rightOffset: w - rightX,
    bottomOffset: h - bottomY,
    maxWidth: Math.min(T.actionsMaxW * s, w - 2 * outer),
    minHeight: 80 * s,
  };

  return {
    s,
    bar: rect(0, 0, w, barH),
    topZone,
    leftZone,
    rightZone,
    centerZone,
    centerCard,
    centerCompact,
    centerTiles: {
      claim: { w: T.centerClaimW * s, h: T.centerClaimH * s },
      ting: { w: T.centerTingW * s, h: T.centerTingH * s },
    },
    hand,
    ownRiver,
    topRiver,
    leftRiver,
    rightRiver,
    topBacks,
    leftBacks,
    rightBacks,
    selfChip,
    leftChip,
    rightChip,
    barChip: { w: T.barChipW * s, h: T.barChipH * s },
    actions,
  };
}

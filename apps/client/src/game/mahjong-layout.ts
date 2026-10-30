/**
 * 麻将牌桌比例布局（纯函数，零依赖）。
 *
 * 坐标模型：画布设计尺寸 W×H（恒 ≥1334×750，至少一条边正好在最小值）。
 * 统一比例单位 s = min(H/750, 0.88W/handRowW)，且 s ≥ 1：
 *  - 高度是竖向节奏基准；
 *  - 宽度兜底保证 14 张手牌永远 ≤88% 宽，左侧留出自家人像卡。
 *
 * 2026-10-30 第二片：中央牌板（方案 B）——
 *  牌板 = 左道 + 中间列 + 右道；左右道贯穿牌板全高（吃掉四角）；
 *  中间列自上而下 = 对家牌河 / 信息格 / 自己牌河；信息格宽 = 中间列宽。
 *  副露移出竖向预算：对家走牌背两翼（放不下整条下移）、自己走手牌上方、左右走外侧栏竖排。
 *
 * 所有输出均为**设计 px**（画布坐标），由 LandscapeStage 的 transform: scale(k) 统一缩放。
 * 本文件不读窗口、不读 store、不造计时器。
 */

export interface MahjongSeatLoad {
  discards: number;
  melds: number;
  /** 4 张副露（gang/angang）组数；用于按实际组型算两翼宽度。 */
  gangMelds?: number;
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

export type LaneOrigin = 'top-left';

export interface LaneLayout {
  rect: Rect;
  tile: TileSize;
  gap: number;
  cols: number;
  /** 容量行数（= floor((道高+gap)/(tileH+gap))）；渲染不依赖它，仅供契约/测试。 */
  rows: number;
  /** 1 = 不压缩；<1 = 按实际所需行数压缩。 */
  fit: number;
  origin: LaneOrigin;
}

export interface MeldStripLayout {
  /** 条带矩形；groups=0 时为零矩形。 */
  rect: Rect;
  tile: TileSize;
  overlap: number;
  groupGap: number;
  /** 本条带承载的组数；0 = 空条（不渲染）。 */
  groups: number;
  /** 'row' = 横排（对家翼/自己条），'column' = 竖排（左右外侧栏）。 */
  direction: 'row' | 'column';
}

export type InfoLevel = 'full' | 'dense' | 'compact';

export interface MahjongTableLayout {
  s: number;
  bar: Rect;
  /** 中央牌板外接矩形（四道 + 信息格）。 */
  board: Rect;
  topLane: LaneLayout;
  bottomLane: LaneLayout;
  leftLane: LaneLayout;
  rightLane: LaneLayout;
  /** 信息格：宽 = 中间列宽，上下被牌河包住、左右被侧道包住。 */
  info: Rect;
  infoLevel: InfoLevel;
  infoTiles: { claim: TileSize; ting: TileSize };
  hand: { rect: Rect; tile: TileSize; gap: number; drawnGap: number };
  topBacks: { rect: Rect; tile: TileSize; gap: number };
  leftBacks: { rect: Rect; tile: TileSize; pitch: number };
  rightBacks: { rect: Rect; tile: TileSize; pitch: number };
  topMelds: { left: MeldStripLayout; right: MeldStripLayout; below: MeldStripLayout };
  leftMelds: MeldStripLayout;
  rightMelds: MeldStripLayout;
  selfMelds: MeldStripLayout;
  selfChip: Rect;
  leftChip: Rect;
  rightChip: Rect;
  barChip: TileSize;
  actions: {
    /** 浮层右缘 x 坐标（屏幕/画布坐标）= 右道左缘。 */
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
  riverH: 75,
  riverCols: 12, // 中间列最大列数（候选表首项）
  topBackH: 54,
  topBackGap: 2,
  sideBackH: 45, // 槽高（pitch 叠压用）；left/right 牌背素材是 49×40 横图
  sidePitch: 24,
  backCount: 14, // = handCount，牌背预算
  sideRiverW: 49, // 侧牌（left/right 素材）宽
  sideRiverH: 40,
  meldTopScale: 0.55, // 对家副露（两翼）
  meldScale: 0.65, // 自己副露
  sideMeldScale: 0.65, // 左右副露（作用在 49×40 侧牌上）
  meldOverlap: 8,
  meldTopGroupGap: 4,
  meldGroupGap: 8,
  sideMeldGap: 4,
  chip: 56,
  sideChipW: 180, // 头像 56 + 名字/分/徽标列 124
  selfChipW: 56,
  selfChipH: 76,
  barChipW: 40,
  barChipH: 56,
  centerClaimW: 34,
  centerClaimH: 51,
  centerTingW: 20,
  centerTingH: 30,
  infoMaxH: 240,
  infoMinW: 160,
  infoMinH: 120,
  infoFullH: 176,
  actionsMaxW: 400,
} as const;

/** 本文件内的短名（测试仍用 `MAHJONG_TABLE_TOKENS`）。 */
const T = MAHJONG_TABLE_TOKENS;

/** 麻将牌面宽高比（my/top 素材 75×113）。 */
const TILE_RATIO = 75 / 113;

const DEFAULT_W = 1334;
const DEFAULT_H = 750;

/** 画布模型保证 ≥1334×750；更小的输入一律回落到最小值，避免负矩形。 */
function canvasDim(value: number, min: number): number {
  return Math.max(min, Number.isFinite(value) && value > 0 ? value : min);
}

interface NormalizedSeat {
  discards: number;
  melds: number;
  gangMelds: number;
}

function normalizeLoad(raw: Partial<MahjongSeatLoad> | undefined): NormalizedSeat {
  const melds = Math.max(0, Math.min(4, Math.floor(Number(raw?.melds) || 0)));
  const gangMelds = Math.max(0, Math.min(melds, Math.floor(Number(raw?.gangMelds) || 0)));
  return {
    discards: Math.max(0, Math.floor(Number(raw?.discards) || 0)),
    melds,
    gangMelds,
  };
}

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height };
}

function buildLane(
  box: Rect,
  cols: number,
  tw: number,
  th: number,
  gapPx: number,
  n: number,
): LaneLayout {
  const capacityRows = Math.max(1, Math.floor((box.height + gapPx) / (th + gapPx)));
  const needed = Math.max(1, Math.ceil(n / cols));
  const fit = Math.min(
    1,
    box.width / (cols * tw + (cols - 1) * gapPx),
    box.height / (needed * th + (needed - 1) * gapPx),
  );
  return {
    rect: box,
    tile: { w: tw * fit, h: th * fit },
    gap: gapPx * fit,
    cols,
    rows: capacityRows,
    fit,
    origin: 'top-left',
  };
}

function meldStrip(
  box: Rect,
  tile: TileSize,
  overlap: number,
  groupGap: number,
  groups: number,
  direction: 'row' | 'column',
): MeldStripLayout {
  return { rect: box, tile, overlap, groupGap, groups, direction };
}

export function mahjongTableLayout(
  width: number,
  height: number,
  input: Partial<MahjongTableInput> = {},
): MahjongTableLayout {
  const w = canvasDim(width, DEFAULT_W);
  const h = canvasDim(height, DEFAULT_H);

  const top = normalizeLoad(input.top);
  const left = normalizeLoad(input.left);
  const right = normalizeLoad(input.right);
  const self = normalizeLoad(input.self);

  const handRowW =
    T.handCount * T.handH * TILE_RATIO + (T.handCount - 1) * T.gap + T.drawnGap;
  const s = Math.max(1, Math.min(h / DEFAULT_H, (0.88 * w) / handRowW));
  const u = (v: number) => v * s;
  const gap = u(T.gap);

  const tileW = u(T.riverH * TILE_RATIO);
  const tileH = u(T.riverH);
  const sideTW = u(T.sideRiverW);
  const sideTH = u(T.sideRiverH);
  const chipRight = u(T.outer + T.sideChipW);
  const availBoardW = w - 2 * (chipRight + u(T.inner));

  // —— 候选：中间列 / 侧道列数 ——
  const CANDIDATES: ReadonlyArray<readonly [number, number]> = [
    [12, 3],
    [12, 2],
    [11, 2],
    [10, 2],
    [9, 2],
    [8, 2],
  ];
  let middleCols = 8;
  let sideCols = 2;
  let middleW = 0;
  let sideLaneW = 0;
  for (const [mc, sc] of CANDIDATES) {
    const mw = mc * tileW + (mc - 1) * gap;
    const sw = sc * sideTW + (sc - 1) * gap;
    // infoMinW 在当前候选表下恒真（8 列 ≈ 398s ≥ 160s）；保留只为防候选表将来扩展。
    if (mw + 2 * sw <= availBoardW + 1e-6 && mw >= u(T.infoMinW)) {
      middleCols = mc;
      sideCols = sc;
      middleW = mw;
      sideLaneW = sw;
      break;
    }
  }
  if (middleW === 0) {
    middleW = 8 * tileW + 7 * gap;
    sideLaneW = 2 * sideTW + gap;
  }

  const boardW = middleW + 2 * sideLaneW;
  const boardLeft = (w - boardW) / 2;

  const handW = handRowW * s;
  const handH = u(T.handH);
  const handTop = h - u(T.outer) - handH;
  const handLeft = (w - handW) / 2;

  // —— 对家牌背与副露两翼 ——
  const topBackTile = { w: u(T.topBackH * TILE_RATIO), h: u(T.topBackH) };
  const backW = T.handCount * topBackTile.w + (T.handCount - 1) * u(T.topBackGap);
  const backLeft = (w - backW) / 2;
  const backRight = backLeft + backW;
  const backTop = u(T.barH) + u(T.inner);

  const meldTopTile = {
    w: u(T.riverH * TILE_RATIO) * T.meldTopScale,
    h: u(T.riverH) * T.meldTopScale,
  };
  const meldTile = { w: u(T.riverH * TILE_RATIO) * T.meldScale, h: u(T.riverH) * T.meldScale };
  const sideMeldTile = {
    w: u(T.sideRiverW) * T.sideMeldScale,
    h: u(T.sideRiverH) * T.sideMeldScale,
  };
  const meldOverlap = u(T.meldOverlap);
  const flapGap = u(T.meldTopGroupGap);
  const pengW = 3 * meldTopTile.w - 2 * meldOverlap;
  const gangW = 4 * meldTopTile.w - 3 * meldOverlap;

  // 右翼先拿 ceil(n/2)；杠优先落在右翼（悲观假设，保证不裁切）。
  const topRightN = Math.ceil(top.melds / 2);
  const topLeftN = top.melds - topRightN;
  const topRightG = Math.min(topRightN, top.gangMelds);
  const topLeftG = Math.min(topLeftN, Math.max(0, top.gangMelds - topRightN));
  const widthOfSide = (n: number, g: number) =>
    n <= 0 ? 0 : g * gangW + (n - g) * pengW + (n - 1) * flapGap;
  const needRight = widthOfSide(topRightN, topRightG);
  const needLeft = widthOfSide(topLeftN, topLeftG);
  const flankLeftSpace = backLeft - u(T.inner) - chipRight - u(T.inner);
  const flankRightSpace = w - chipRight - u(T.inner) - backRight - u(T.inner);
  const topFlanksFit =
    top.melds <= 0 || (needRight <= flankRightSpace + 1e-6 && needLeft <= flankLeftSpace + 1e-6);

  const topBelowH = top.melds > 0 && !topFlanksFit ? meldTile.h : 0;
  const boardTopBase = backTop + topBackTile.h + u(T.inner);
  const boardTop = boardTopBase + (topBelowH > 0 ? topBelowH + u(T.inner) : 0);
  const selfMeldH = self.melds > 0 ? meldTile.h : 0;
  const boardBottom = handTop - u(T.inner) - (self.melds > 0 ? selfMeldH + u(T.inner) : 0);
  const availH = Math.max(0, boardBottom - boardTop);

  // —— 上下道行数：最大且 infoH ≥ 240s → 最大且 ≥ 120s → 2 ——
  const rowH = tileH + gap;
  const infoAt = (r: number) => availH - 2 * (r * rowH - gap);
  let rows = 2;
  for (let r = 4; r >= 2; r--) {
    if (infoAt(r) >= u(T.infoMaxH)) {
      rows = r;
      break;
    }
  }
  if (infoAt(rows) < u(T.infoMaxH)) {
    rows = 2;
    for (let r = 4; r >= 2; r--) {
      if (infoAt(r) >= u(T.infoMinH)) {
        rows = r;
        break;
      }
    }
  }
  let laneH = rows * rowH - gap;
  if (availH - 2 * laneH < 0) laneH = Math.max(0, availH / 2);
  const infoH = Math.max(0, Math.min(u(T.infoMaxH), availH - 2 * laneH));
  const boardH = 2 * laneH + infoH;
  const boardTopY = boardTop + Math.max(0, (availH - boardH) / 2);

  const topLaneRect = rect(boardLeft + sideLaneW, boardTopY, middleW, laneH);
  const bottomLaneRect = rect(boardLeft + sideLaneW, boardTopY + laneH + infoH, middleW, laneH);
  const leftLaneRect = rect(boardLeft, boardTopY, sideLaneW, boardH);
  const rightLaneRect = rect(boardLeft + boardW - sideLaneW, boardTopY, sideLaneW, boardH);
  const infoRect = rect(boardLeft + sideLaneW, boardTopY + laneH, middleW, infoH);

  const topLane = buildLane(topLaneRect, middleCols, tileW, tileH, gap, top.discards);
  const bottomLane = buildLane(bottomLaneRect, middleCols, tileW, tileH, gap, self.discards);
  const leftLane = buildLane(leftLaneRect, sideCols, sideTW, sideTH, gap, left.discards);
  const rightLane = buildLane(rightLaneRect, sideCols, sideTW, sideTH, gap, right.discards);

  // —— 牌背 / 座位卡 ——
  const sideBackW = u(T.sideBackH * TILE_RATIO);
  const sideBackH = (T.backCount * T.sidePitch + T.sideBackH) * s;
  const sideContentTop = boardTopY + u(T.chip) + u(T.inner);
  const topBacks = {
    rect: rect(backLeft, backTop, backW, topBackTile.h),
    tile: topBackTile,
    gap: u(T.topBackGap),
  };
  const sideBackTile = { w: sideBackW, h: u(T.sideBackH) };
  const leftBacks = {
    rect: rect(boardLeft - u(T.inner) - sideBackW, sideContentTop, sideBackW, sideBackH),
    tile: sideBackTile,
    pitch: u(T.sidePitch),
  };
  const rightBacks = {
    rect: rect(boardLeft + boardW + u(T.inner), sideContentTop, sideBackW, sideBackH),
    tile: sideBackTile,
    pitch: u(T.sidePitch),
  };

  const selfChip = rect(
    u(T.outer),
    handTop + ((T.handH - T.selfChipH) / 2) * s,
    u(T.selfChipW),
    u(T.selfChipH),
  );
  // 座位卡优先贴桌边；牌板在宽屏上居中后，余量过大就把卡夹到牌背外侧 8s 处，避免「卡在桌边、牌背在中间」。
  const leftChipLeft = Math.max(
    u(T.outer),
    leftBacks.rect.left - u(T.sideChipW) - u(T.inner),
  );
  const rightChipLeft = Math.min(
    w - u(T.outer) - u(T.sideChipW),
    rightBacks.rect.left + rightBacks.rect.width + u(T.inner),
  );
  const leftChip = rect(leftChipLeft, boardTopY, u(T.sideChipW), u(T.chip));
  const rightChip = rect(rightChipLeft, boardTopY, u(T.sideChipW), u(T.chip));

  // —— 副露条 ——
  const zero = rect(0, 0, 0, 0);
  const stripTop = backTop + (topBackTile.h - meldTopTile.h) / 2;
  const topMeldsRight =
    topBelowH > 0
      ? meldStrip(zero, meldTopTile, meldOverlap, flapGap, 0, 'row')
      : meldStrip(
          rect(backRight + u(T.inner), stripTop, Math.max(0, flankRightSpace), meldTopTile.h),
          meldTopTile,
          meldOverlap,
          flapGap,
          topRightN,
          'row',
        );
  const topMeldsLeft =
    topBelowH > 0
      ? meldStrip(zero, meldTopTile, meldOverlap, flapGap, 0, 'row')
      : meldStrip(
          rect(chipRight + u(T.inner), stripTop, Math.max(0, flankLeftSpace), meldTopTile.h),
          meldTopTile,
          meldOverlap,
          flapGap,
          topLeftN,
          'row',
        );
  const topMeldsBelow =
    topBelowH > 0
      ? meldStrip(
          rect(boardLeft + sideLaneW, boardTopBase, middleW, topBelowH),
          meldTile,
          meldOverlap,
          u(T.meldGroupGap),
          top.melds,
          'row',
        )
      : meldStrip(zero, meldTile, meldOverlap, u(T.meldGroupGap), 0, 'row');

  const sideMeldW = 4 * sideMeldTile.w - 3 * meldOverlap;
  const sideStripH = (n: number) => (n > 0 ? n * sideMeldTile.h + (n - 1) * u(T.sideMeldGap) : 0);
  const leftMelds =
    left.melds > 0
      ? meldStrip(
          rect(u(T.outer), sideContentTop, sideMeldW, sideStripH(left.melds)),
          sideMeldTile,
          meldOverlap,
          u(T.sideMeldGap),
          left.melds,
          'column',
        )
      : meldStrip(zero, sideMeldTile, meldOverlap, u(T.sideMeldGap), 0, 'column');
  const rightMelds =
    right.melds > 0
      ? meldStrip(
          rect(w - u(T.outer) - sideMeldW, sideContentTop, sideMeldW, sideStripH(right.melds)),
          sideMeldTile,
          meldOverlap,
          u(T.sideMeldGap),
          right.melds,
          'column',
        )
      : meldStrip(zero, sideMeldTile, meldOverlap, u(T.sideMeldGap), 0, 'column');
  const selfMelds =
    self.melds > 0
      ? meldStrip(
          rect(boardLeft + sideLaneW, handTop - u(T.inner) - meldTile.h, middleW, meldTile.h),
          meldTile,
          meldOverlap,
          u(T.meldGroupGap),
          self.melds,
          'row',
        )
      : meldStrip(zero, meldTile, meldOverlap, u(T.meldGroupGap), 0, 'row');

  const infoLevel: InfoLevel =
    infoH >= u(T.infoFullH) ? 'full' : infoH >= u(T.infoMinH) ? 'dense' : 'compact';

  const rightX = rightLaneRect.left;
  const bottomY = handTop - u(T.inner);

  return {
    s,
    bar: rect(0, 0, w, u(T.barH)),
    board: rect(boardLeft, boardTopY, boardW, boardH),
    topLane,
    bottomLane,
    leftLane,
    rightLane,
    info: infoRect,
    infoLevel,
    infoTiles: {
      claim: { w: u(T.centerClaimW), h: u(T.centerClaimH) },
      ting: { w: u(T.centerTingW), h: u(T.centerTingH) },
    },
    hand: {
      rect: rect(handLeft, handTop, handW, handH),
      tile: { w: u(T.handH * TILE_RATIO), h: handH },
      gap: u(T.gap),
      drawnGap: u(T.drawnGap),
    },
    topBacks,
    leftBacks,
    rightBacks,
    topMelds: { left: topMeldsLeft, right: topMeldsRight, below: topMeldsBelow },
    leftMelds,
    rightMelds,
    selfMelds,
    selfChip,
    leftChip,
    rightChip,
    barChip: { w: u(T.barChipW), h: u(T.barChipH) },
    actions: {
      rightX,
      bottomY,
      rightOffset: w - rightX,
      bottomOffset: h - bottomY,
      maxWidth: Math.min(u(T.actionsMaxW), w - 2 * u(T.outer)),
      minHeight: u(80),
    },
  };
}

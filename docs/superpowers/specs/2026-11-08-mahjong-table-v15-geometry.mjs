#!/usr/bin/env node
/**
 * 川麻红金 v15 设计原型（2026-11-08）：左右河靠近信息井 + 听牌放大/外移。
 * 仅设计期；生产不引用。运行：node docs/superpowers/specs/2026-11-08-mahjong-table-v15-geometry.mjs
 *
 * 与 v13 的差异：
 *  - 左右河边不再贴外侧：侧背/侧副露留在外缘，侧河块移到 hub 左右两侧（4px 间隙），
 *    固定 2 列、最多 10 行（cap 20 = 19 张 + N 徽标），垂直居中于侧区带。
 *  - 听牌小牌 30×45（v13 20×30），2 行 × 5 列；放在左侧空出的区域（侧副露 lane 右侧、
 *    自己河左侧），与自家出牌区拉开 ≥180px / 不相交。
 *  - 顶/下河宽度随中心区扩大（侧区只剩背+副露 lane）。
 */
const T = {
  bar: 64, outer: 12, gap: 4,
  handH: 108, handCount: 14, tileRatio: 75 / 113, tileGap: 2, drawnGap: 12, handClearance: 16,
  topBackH: 46, riverH: 56, sideTileW: 56, sideTileH: (56 * 40) / 49,
  sideRiverTileW: 56, sideRiverTileH: (56 * 75) / 113,
  meldScale: 0.8, meldOverlap: 4, meldGroupGap: 8,
  sideMeldScale: 0.65, sideMeldVisualH: 45.714, sideMeldVisualW: 56, sideMeldOverlap: 4,
  seatPlateW: 160, seatPlateH: 56, topPlateW: 164, selfPlateW: 64, selfPlateH: 76,
  actionBtn: 84, actionGap: 8, actionW: 176, actionH: 176,
  tingW: 30, tingH: 45, tingGap: 2, tingMax: 9, tingPerRow: 5,
  hubMin: 160, hubMax: 200, displayCap: 24,
  sideCols: 2, sideRowsMax: 10, sideVisibleCap: 20,
};
const HAND_ROW_W = T.handCount * T.handH * T.tileRatio + (T.handCount - 1) * T.tileGap + T.drawnGap;
const CANVASES = [[1334, 750], [1500, 750], [1623, 750], [1778, 750], [1334, 833], [1334, 1000], [1334, 1334], [2668, 1500]];

const rect = (left, top, width, height) => ({ left, top, width, height });
const right = (r) => r.left + r.width;
const bottom = (r) => r.top + r.height;
const inside = (r, W, H) => r.left >= -0.01 && r.top >= -0.01 && right(r) <= W + 0.01 && bottom(r) <= H + 0.01;
const hit = (a, b) => a.left < right(b) - 0.01 && b.left < right(a) - 0.01 && a.top < bottom(b) - 0.01 && b.top < bottom(a) - 0.01;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function layoutBase(W, H, state) {
  const gap = T.gap, gapT = T.tileGap, outer = T.outer, bar = T.bar;
  const handH = T.handH, handW = HAND_ROW_W, handLeft = (W - handW) / 2;
  const handTop = H - outer - handH;
  const hand = rect(handLeft, handTop, handW, handH);
  const meldTileW = T.riverH * T.meldScale * T.tileRatio;
  const meldOverlap = T.meldOverlap;
  const meldGroupGap = T.meldGroupGap;
  const meldGroupW = (n) => n * meldTileW - (n - 1) * meldOverlap;
  const meldSizes = (obj) => obj.meldSizes ?? Array.from({ length: obj.melds || 0 }, () => 3);
  const meldContentW = (sizes) => sizes.length === 0 ? 0 : sizes.reduce((sum, n) => sum + meldGroupW(n), 0) + (sizes.length - 1) * meldGroupGap;

  // —— 底部栈 ——
  const selfSizes = meldSizes(state.self);
  const selfMeldH = selfSizes.length > 0 ? T.riverH * T.meldScale : 0;
  const selfMeldW = selfSizes.length > 0 ? Math.min(handW, meldContentW(selfSizes)) : 0;
  const selfMeld = selfMeldH ? rect(0, handTop - T.handClearance - selfMeldH, selfMeldW, selfMeldH) : rect(0, 0, 0, 0);
  const ownRiverBottom = selfMeldH ? selfMeld.top - gap : handTop - T.handClearance;
  const ownRiverH = T.riverH * 2 + T.tileGap;
  const ownRiverTop = ownRiverBottom - ownRiverH;

  // —— 顶部栈 ——
  const topBackH = T.topBackH, topBackW = topBackH * T.tileRatio;
  const topBacksW = T.handCount * topBackW + (T.handCount - 1) * gapT;
  const topBacksTop = bar + gap;
  const topSizes = meldSizes(state.top);
  const topMeldH = topSizes.length > 0 ? T.riverH * T.meldScale : 0;
  const topMeldContentW = topSizes.length > 0 ? meldContentW(topSizes) : 0;
  const topMeldTop = topBacksTop + topBackH + gap;
  const topRiverTop = topMeldTop + (topMeldH ? topMeldH + gap : 0);
  const topRiverBottom = topRiverTop + ownRiverH;

  // —— 座位牌 ——
  const leftPlate = rect(outer, bar + gap, T.seatPlateW, T.seatPlateH);
  const rightPlate = rect(W - outer - T.seatPlateW, bar + gap, T.seatPlateW, T.seatPlateH);
  const topPlate = rect((W - T.topPlateW) / 2, 4, T.topPlateW, T.seatPlateH);
  const selfPlate = rect(outer, handTop + (handH - T.selfPlateH) / 2, T.selfPlateW, T.selfPlateH);

  // —— 侧区（只剩背 + 副露 lane；河移到 hub 两侧）——
  function sideMeldFit(sizes, avail) {
    if (sizes.length === 0) return { w: 0, h: 0, scale: 0, tileW: 0, tileH: 0, contentW: 0 };
    let scale = T.sideMeldScale;
    const tileH = () => T.sideMeldVisualH * scale;
    const tileW = () => T.sideMeldVisualW * scale;
    const overlap = T.sideMeldOverlap;
    const groupH = (n) => n * tileH() - (n - 1) * overlap;
    const total = () => sizes.reduce((sum, n) => sum + groupH(n), 0) + (sizes.length - 1) * meldGroupGap;
    while (total() > avail && scale > 0.4) scale -= 0.01;
    const contentW = total();
    return { w: tileW() + 4, h: contentW, scale, tileW: tileW(), tileH: tileH(), contentW };
  }
  function sideBase(side, plate) {
    const revealed = state[side].revealed ?? 0;
    const raw = revealed > 0 ? revealed : state[side].discards;
    const visible = Math.min(raw, T.displayCap);
    const sizes = meldSizes(state[side]);
    const sideTop = bottom(plate) + gap + (revealed > 0 ? 16 : 0);
    const sideBottom = handTop - T.handClearance;
    const avail = sideBottom - sideTop;
    const backW = T.sideTileH * T.tileRatio;
    const pitch = clamp((avail - T.sideTileH) / 13, 8, 22);
    const backH = 13 * pitch + T.sideTileH;
    const mf = sideMeldFit(sizes, avail);
    return { sideTop, sideBottom, avail, backW, pitch, backH, meld: mf, raw, visible, revealed };
  }
  const leftZ = sideBase('left', leftPlate);
  const rightZ = sideBase('right', rightPlate);
  const zoneW = Math.max(leftZ.backW, rightZ.backW) + gap + Math.max(leftZ.meld.w, rightZ.meld.w);
  const centerLeft = outer + zoneW + gap;
  const centerRight = W - outer - zoneW - gap;
  const centerW = centerRight - centerLeft;
  const centerCx = (centerLeft + centerRight) / 2;
  selfMeld.left = centerCx - selfMeld.width / 2;

  // —— 上/下河 ——
  function riverTopSelf(side, top) {
    const raw = state[side].discards;
    const visible = Math.min(raw, T.displayCap);
    const overflow = raw - visible;
    const cols = visible <= 16 ? 8 : 12;
    const fit = Math.min(1, centerW / (cols * T.riverH * T.tileRatio + (cols - 1) * gapT));
    const tileW = T.riverH * T.tileRatio * fit, tileH = T.riverH * fit;
    const width = cols * tileW + (cols - 1) * gapT, height = 2 * tileH + gapT;
    const windowCount = overflow > 0 ? 23 : visible;
    const badgeCount = raw - windowCount;
    const windowStart = raw - windowCount;
    const latestIndex = windowCount - 1;
    const badgeCell = windowCount;
    const badgeCol = badgeCell % cols;
    const badgeRow = Math.floor(badgeCell / cols);
    const rx = centerCx - width / 2;
    const badgeRect = overflow > 0 ? rect(
      rx + badgeCol * (tileW + gapT),
      top + badgeRow * (tileH + gapT),
      tileW, tileH,
    ) : null;
    return { rect: rect(rx, top, width, height), cols, rows: 2, tile: { w: tileW, h: tileH }, fit, raw, visible, overflow, windowCount, windowStart, badgeCount, latestIndex, badgeCell, badgeRect };
  }
  const topRiverBox = riverTopSelf('top', topRiverTop);
  const ownRiverBox = riverTopSelf('self', ownRiverTop);

  const topBacks = rect(centerCx - topBacksW / 2, topBacksTop, topBacksW, topBackH);
  const topMeldScale = topMeldContentW > 0 ? Math.min(1, (topBacksW - gap) / topMeldContentW) : 1;
  const topMeldW = Math.min(Math.max(topRiverBox.rect.width, topMeldContentW * topMeldScale), topBacksW);
  const topMeld = topMeldH ? rect(centerCx - topMeldW / 2, topMeldTop, topMeldW, topMeldH) : rect(0, 0, 0, 0);

  // —— hub ——
  const centerTop = bottom(topRiverBox.rect) + gap;
  const centerBottom = ownRiverBox.rect.top - gap;
  const available = Math.max(0, centerBottom - centerTop);
  const hubD = Math.min(clamp(available, T.hubMin, T.hubMax), Math.max(0, centerW - 2 * gap));
  const hubRect = rect(centerCx - hubD / 2, centerTop + (available - hubD) / 2, hubD, hubD);
  const hub = { rect: hubRect, ...hubRect, cx: centerCx, cy: hubRect.top + hubD / 2, r: hubD / 2, compact: hubD < 180 };

  // —— 动作区 ——
  const actions = rect(
    Math.max(outer, W - outer - zoneW - gap - T.actionW),
    handTop - T.handClearance - T.actionH,
    T.actionW, T.actionH,
  );
  if (selfMeld.width > 0) {
    selfMeld.left = Math.max(outer, Math.min(centerCx - selfMeld.width / 2, actions.left - gap - selfMeld.width));
  }

  // —— 侧河块（hub 左右两侧，4 行）——
  const sideBandTop = topRiverBottom + gap;
  const sideBandBottom = actions.top - gap;
  const sideBandH = Math.max(0, sideBandBottom - sideBandTop);
  const sideRows = clamp(Math.floor((sideBandH + gapT) / (T.sideTileH + gapT)), 1, T.sideRows);
  const sideRiverH = sideRows * T.sideTileH + (sideRows - 1) * gapT;
  const sideRiverY = sideBandTop + Math.max(0, (sideBandH - sideRiverH) / 2);
  function sideRiver(side, z) {
    const visible = z.visible;
    const cols = visible > 0 ? T.sideCols : 0;
    const rows = visible > 0 ? Math.min(T.sideRowsMax, Math.ceil(visible / T.sideCols)) : 0;
    const overflow = z.raw > T.sideVisibleCap;
    const windowCount = overflow ? T.sideVisibleCap - 1 : visible;
    const badgeCount = z.raw - windowCount;
    const windowStart = z.raw - windowCount;
    const latestIndex = windowCount - 1;
    const badgeCell = windowCount;
    const blockRows = overflow ? T.sideRowsMax : rows;
    const blockW = cols > 0 ? cols * T.sideRiverTileW + (cols - 1) * gapT : 0;
    const blockH = blockRows > 0 ? blockRows * T.sideRiverTileH + (blockRows - 1) * gapT : 0;
    const x = side === 'left'
      ? Math.min(topRiverBox.rect.left, ownRiverBox.rect.left) - gap - blockW
      : Math.max(right(topRiverBox.rect), right(ownRiverBox.rect)) + gap;
    const y = z.sideTop + Math.max(0, (z.avail - blockH) / 2);
    const badgeRect = badgeCount > 0 ? rect(
      x + (badgeCell % T.sideCols) * (T.sideRiverTileW + gapT),
      y + Math.floor(badgeCell / T.sideCols) * (T.sideRiverTileH + gapT),
      T.sideRiverTileW, T.sideRiverTileH,
    ) : null;
    return {
      rect: rect(x, y, blockW, blockH), cols, rows: blockRows,
      tile: { w: T.sideRiverTileW, h: T.sideRiverTileH }, raw: z.raw, visible, overflow: z.raw - visible,
      windowCount, windowStart, badgeCount, latestIndex, badgeCell, badgeRect,
    };
  }
  const leftRiver = sideRiver('left', leftZ);
  const rightRiver = sideRiver('right', rightZ);

  // —— 侧背 / 侧副露 lane ——
  const leftBacks = rect(outer, leftZ.sideTop, leftZ.backW, leftZ.backH);
  const rightBacks = rect(W - outer - rightZ.backW, rightZ.sideTop, rightZ.backW, rightZ.backH);
  const leftMelds = leftZ.meld.w ? rect(outer + leftZ.backW + gap, leftZ.sideTop + Math.max(0, (leftZ.avail - leftZ.meld.h) / 2), leftZ.meld.w, leftZ.meld.h) : rect(0, 0, 0, 0);
  const rightMelds = rightZ.meld.w ? rect(W - outer - rightZ.backW - gap - rightZ.meld.w, rightZ.sideTop + Math.max(0, (rightZ.avail - rightZ.meld.h) / 2), rightZ.meld.w, rightZ.meld.h) : rect(0, 0, 0, 0);

  // —— 听牌（左下空区：侧副露 lane 右侧、自家河左侧）——
  const tingCount = Math.min(state.ting ?? 0, T.tingMax);
  const tingCols = Math.min(tingCount, T.tingPerRow);
  const tingRows = Math.ceil(tingCount / T.tingPerRow) || 1;
  const tingW = tingCols * T.tingW + Math.max(0, tingCols - 1) * T.tingGap;
  const tingH = tingRows * T.tingH + Math.max(0, tingRows - 1) * T.tingGap;
  // v19（2026-11-13）起生产 tingX = hand.left（贴手牌行左缘）；本原型保留 v15 旧值作对照。
  const tingX = outer + leftZ.backW + gap + leftZ.meld.w + gap;
  const tingY = ownRiverTop + Math.max(0, (ownRiverH - tingH) / 2);
  const ting = tingCount ? rect(tingX, tingY, tingW, tingH) : rect(0, 0, 0, 0);

  const rects = {
    bar: rect(0, 0, 1334, 64), hand, actions, hub: hubRect, topPlate, leftPlate, rightPlate, selfPlate,
    topBacks, topRiver: topRiverBox.rect, ownRiver: ownRiverBox.rect,
    leftBacks, leftRiver: leftRiver.rect, leftMelds, rightBacks, rightRiver: rightRiver.rect, rightMelds,
    selfMeld, topMeld, ting,
    ...(topRiverBox.badgeRect ? { topBadge: topRiverBox.badgeRect } : {}),
    ...(ownRiverBox.badgeRect ? { ownBadge: ownRiverBox.badgeRect } : {}),
    ...(leftRiver.badgeRect ? { leftBadge: leftRiver.badgeRect } : {}),
    ...(rightRiver.badgeRect ? { rightBadge: rightRiver.badgeRect } : {}),
  };
  const checks = [];
  for (const [name, r] of Object.entries(rects)) {
    if (r.width <= 0 || r.height <= 0) continue;
    if (!inside(r, W, H)) checks.push(`${name} 越界`);
  }
  const pairs = [
    ['hub', 'topRiver'], ['hub', 'ownRiver'], ['hub', 'leftRiver'], ['hub', 'rightRiver'],
    ['hub', 'leftMelds'], ['hub', 'rightMelds'], ['hub', 'leftBacks'], ['hub', 'rightBacks'],
    ['hub', 'topBacks'], ['hub', 'topMeld'], ['hub', 'hand'], ['hub', 'actions'],
    ['hub', 'topPlate'], ['hub', 'leftPlate'], ['hub', 'rightPlate'],
    ['actions', 'hand'], ['actions', 'selfMeld'], ['actions', 'rightRiver'], ['actions', 'rightMelds'], ['actions', 'rightBacks'],
    ['leftPlate', 'leftBacks'], ['leftPlate', 'leftRiver'], ['leftPlate', 'topBacks'], ['leftPlate', 'topMeld'], ['leftPlate', 'leftMelds'], ['leftPlate', 'ting'],
    ['rightPlate', 'rightBacks'], ['rightPlate', 'rightRiver'], ['rightPlate', 'topBacks'], ['rightPlate', 'topMeld'], ['rightPlate', 'rightMelds'], ['rightPlate', 'ting'],
    ['leftMelds', 'leftRiver'], ['leftMelds', 'leftBacks'], ['leftMelds', 'ting'], ['leftMelds', 'ownRiver'], ['leftMelds', 'hand'],
    ['rightMelds', 'rightRiver'], ['rightMelds', 'rightBacks'], ['rightMelds', 'ownRiver'], ['rightMelds', 'hand'],
    ['selfPlate', 'hand'], ['selfPlate', 'ownRiver'], ['selfPlate', 'selfMeld'], ['selfPlate', 'ting'],
    ['selfMeld', 'hand'], ['topMeld', 'topRiver'], ['topMeld', 'topBacks'],
    ['ting', 'ownRiver'], ['ting', 'hand'], ['ting', 'actions'], ['ting', 'selfMeld'], ['ting', 'leftRiver'],
    ['ting', 'leftBacks'], ['ting', 'rightRiver'], ['ting', 'rightMelds'],
    ['leftRiver', 'ownRiver'], ['rightRiver', 'ownRiver'], ['leftRiver', 'topRiver'], ['rightRiver', 'topRiver'],
    ['leftRiver', 'leftBacks'], ['rightRiver', 'rightBacks'], ['leftRiver', 'rightRiver'],
    ['leftRiver', 'actions'], ['leftRiver', 'hand'], ['rightRiver', 'hand'],
  ];
  for (const [a, b] of pairs) {
    if (rects[a].width > 0 && rects[b].width > 0 && hit(rects[a], rects[b])) {
      const x = Math.min(right(rects[a]), right(rects[b])) - Math.max(rects[a].left, rects[b].left);
      const y = Math.min(bottom(rects[a]), bottom(rects[b])) - Math.max(rects[a].top, rects[b].top);
      checks.push(`${a}×${b} 相交 ${x.toFixed(1)}×${y.toFixed(1)}`);
    }
  }
  const overlays = [];
  if (leftRiver.rect.width + rightRiver.rect.width > 0) {
    // 侧河与动作区只允许贴边，不允许覆盖
    if (hit(actions, rightRiver.rect)) overlays.push('actions×rightRiver 覆盖');
  }
  if (leftRiver.cols > 0 && leftRiver.windowCount + (leftRiver.badgeCount > 0 ? 1 : 0) > leftRiver.rows * leftRiver.cols) checks.push('左河容量不足');
  if (rightRiver.cols > 0 && rightRiver.windowCount + (rightRiver.badgeCount > 0 ? 1 : 0) > rightRiver.rows * rightRiver.cols) checks.push('右河容量不足');

  return {
    s: 1, hubD, hub, checks, overlays,
    key: {
      hub: `${hubD.toFixed(1)}${hub.compact ? 'c' : ''}`,
      side: `${leftRiver.rows}/${rightRiver.rows}r ${leftRiver.cols}/${rightRiver.cols}c cap=${leftRiver.rows * leftRiver.cols}/${rightRiver.rows * rightRiver.cols}`,
      over: `${leftRiver.overflow}/${rightRiver.overflow}`,
      sideWin: `${leftRiver.windowStart}+${leftRiver.windowCount}/${leftRiver.badgeCount} | ${rightRiver.windowStart}+${rightRiver.windowCount}/${rightRiver.badgeCount}`,
      sideMeld: `${leftZ.meld.scale.toFixed(2)}/${leftZ.meld.h.toFixed(1)}`,
      top: `${topRiverBox.cols}c+${topRiverBox.overflow}/${topRiverBox.badgeCount} win=${topRiverBox.windowStart}+${topRiverBox.windowCount} k=${topMeldScale.toFixed(3)}`,
      hand: `${hand.left.toFixed(1)}..${right(hand).toFixed(1)}`,
      actions: `${actions.left.toFixed(1)},${actions.top.toFixed(1)}`,
      centerW: centerW.toFixed(1),
      ting: `${ting.left.toFixed(1)},${ting.top.toFixed(1)} ${tingW.toFixed(1)}x${tingH.toFixed(1)}`,
    },
    rects,
  };
}

/** B 方案：固定 1334×750 构图，居中放置；多余空间留边。 */
function layout(W, H, state) {
  const BW = 1334, BH = 750;
  const u = Math.min(W / BW, H / BH);
  const ox = (W - BW * u) / 2;
  const oy = (H - BH * u) / 2;
  const base = layoutBase(BW, BH, state);
  const tr = (r) => ({ ...r, left: ox + r.left * u, top: oy + r.top * u, width: r.width * u, height: r.height * u });
  const rects = Object.fromEntries(Object.entries(base.rects).map(([k, v]) => [k, tr(v)]));
  const hub = { ...base.hub, ...tr(base.hub), rect: tr(base.hub.rect), cx: ox + base.hub.cx * u, cy: oy + base.hub.cy * u, r: base.hub.r * u };
  const checks = [...base.checks];
  for (const [name, r] of Object.entries(rects)) {
    if (r.width > 0 && r.height > 0 && !inside(r, W, H)) checks.push(`${name} 画布越界`);
  }
  return { ...base, rects, hub, s: u, offsetX: ox, offsetY: oy, checks };
}

const base = () => ({ discards: 0, melds: 0, revealed: 0 });
const states = {
  normal: { top: base(), left: base(), right: base(), self: base(), ting: 0 },
  mid: { top: { discards: 12, melds: 1, revealed: 0 }, left: { discards: 8, melds: 1, revealed: 0 }, right: { discards: 10, melds: 1, revealed: 0 }, self: { discards: 9, melds: 1, revealed: 0 }, ting: 9 },
  top29: { top: { discards: 29, melds: 1, revealed: 0 }, left: { discards: 27, melds: 0, revealed: 0 }, right: { discards: 0, melds: 0, revealed: 0 }, self: { discards: 0, melds: 0, revealed: 0 }, ting: 9 },
  twoSurvivors: { top: { discards: 6, melds: 1, revealed: 8 }, left: { discards: 29, melds: 1, revealed: 0 }, right: { discards: 25, melds: 0, revealed: 0 }, self: { discards: 0, melds: 0, revealed: 8 }, ting: 9 },
  revealed: { top: { discards: 10, melds: 0, revealed: 0 }, left: { discards: 5, melds: 0, revealed: 14 }, right: { discards: 5, melds: 0, revealed: 14 }, self: { discards: 8, melds: 1, revealed: 0 }, ting: 8 },
  heavy: { top: { discards: 12, melds: 4, revealed: 0 }, left: { discards: 8, melds: 1, revealed: 0 }, right: { discards: 8, melds: 0, revealed: 0 }, self: { discards: 8, melds: 0, revealed: 0 }, ting: 9 },
  fourMelds: { top: { discards: 8, melds: 4, revealed: 0 }, left: { discards: 8, melds: 4, revealed: 0 }, right: { discards: 8, melds: 0, revealed: 0 }, self: { discards: 8, melds: 0, revealed: 0 }, ting: 8 },
  selfFourGang: { top: { discards: 8, melds: 0, revealed: 0 }, left: { discards: 8, melds: 0, revealed: 0 }, right: { discards: 25, melds: 1, revealed: 0 }, self: { discards: 8, melds: 4, meldSizes: [4, 4, 4, 4], revealed: 0 }, ting: 9 },
  gangHeavy: { top: { discards: 8, melds: 4, meldSizes: [4, 4, 4, 4], revealed: 0 }, left: { discards: 8, melds: 4, meldSizes: [4, 4, 4, 4], revealed: 0 }, right: { discards: 8, melds: 4, meldSizes: [4, 4, 4, 4], revealed: 0 }, self: { discards: 8, melds: 4, meldSizes: [4, 4, 4, 4], revealed: 0 }, ting: 9 },
  overlay: { top: { discards: 0, melds: 0, revealed: 0 }, left: { discards: 16, melds: 1, revealed: 0 }, right: { discards: 25, melds: 1, revealed: 0 }, self: { discards: 17, melds: 0, revealed: 0 }, ting: 9 },
  overlayWorst: { top: { discards: 0, melds: 0, revealed: 0 }, left: { discards: 29, melds: 4, meldSizes: [3, 3, 3, 3], revealed: 0 }, right: { discards: 29, melds: 4, meldSizes: [4, 4, 4, 4], revealed: 0 }, self: { discards: 29, melds: 0, revealed: 0 }, ting: 9 },
  revealed29: { top: { discards: 0, melds: 0, revealed: 0 }, left: { discards: 29, melds: 0, revealed: 14 }, right: { discards: 5, melds: 0, revealed: 14 }, self: { discards: 8, melds: 1, revealed: 0 }, ting: 9 },
  oneSideRevealed: { top: base(), left: { discards: 5, melds: 0, revealed: 14 }, right: base(), self: base(), ting: 8 },
  threeRevealed: { top: { discards: 0, melds: 0, revealed: 14 }, left: { discards: 5, melds: 0, revealed: 14 }, right: { discards: 5, melds: 0, revealed: 14 }, self: base(), ting: 9 },
  revealedGang: { top: base(), left: { discards: 5, melds: 4, meldSizes: [4, 4, 4, 4], revealed: 2 }, right: base(), self: base(), ting: 9 },
};

export { layout, layoutBase, states };

if (typeof process !== 'undefined' && !process.env.V15_QUIET && typeof window === 'undefined') {
  let failures = 0;
  for (const [W, H] of CANVASES) {
    for (const [name, state] of Object.entries(states)) {
      const r = layout(W, H, state);
      const ok = r.checks.length === 0;
      if (!ok) failures += 1;
      console.log(`${ok ? '✅' : '❌'} ${W}x${H} ${name.padEnd(13)} hub=${r.key.hub} side=${r.key.side} over=${r.key.over} win=${r.key.sideWin} meld=${r.key.sideMeld} top=${r.key.top} act=${r.key.actions} cw=${r.key.centerW} ting=${r.key.ting}${r.overlays.length ? ` [${r.overlays.join(',')}]` : ''}`);
      for (const c of r.checks) console.log(`    - ${c}`);
    }
  }
  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURES'}`);
  process.exit(failures === 0 ? 0 : 1);
}

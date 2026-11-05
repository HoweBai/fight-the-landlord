#!/usr/bin/env node
/**
 * 川麻红金牌桌 —— 设计期几何原型 v7（路线 A：动作浮层 + 牌河 24+N）。
 * 随 spec 入库；生产代码不引用。
 * 运行：node docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs
 *
 * v7 修正：
 * - 左右副露用旧 53b5da01 视觉尺寸（34×51@0.65），组高 78.6/101.4
 * - 自己/对家副露按真实 3/4 张组宽 + 组距 8
 * - 侧背按 back.png 83×125（30.5×45.7），不是 49:40
 * - 上/下河 24 格：溢出时显示最新 23 + 第 24 格 +N；侧河 24+徽标
 * - hub 内容 fit（compact 32/18/12、normal 40/22/14）与金环内缩
 * - actions×ownRiver 只记录不报错；其余 pair 全查
 */

const T = {
  bar: 64, outer: 12, gap: 4,
  handH: 108, handCount: 14, tileRatio: 75 / 113, tileGap: 2, drawnGap: 12, handClearance: 16,
  topBackH: 46, riverH: 56, sideTileW: 56, sideTileH: (56 * 40) / 49,
  meldScale: 0.8, meldOverlap: 4, meldGroupGap: 8,
  sideMeldScale: 0.65, sideMeldVisualH: 51, sideMeldVisualW: 34, sideMeldOverlap: 16,
  seatPlateW: 160, seatPlateH: 56, topPlateW: 164, selfPlateW: 64, selfPlateH: 76,
  actionBtn: 84, actionGap: 8, actionW: 176, actionH: 176,
  tingW: 20, tingH: 30, tingGap: 2, tingMax: 9, tingPerRow: 5,
  hubMin: 160, hubMax: 200, displayCap: 24,
};
const HAND_ROW_W = T.handCount * T.handH * T.tileRatio + (T.handCount - 1) * T.tileGap + T.drawnGap;
const CANVASES = [[1334, 750], [1500, 750], [1623, 750], [1778, 750], [1334, 833], [1334, 1000], [1334, 1334]];

const rect = (left, top, width, height) => ({ left, top, width, height });
const right = (r) => r.left + r.width;
const bottom = (r) => r.top + r.height;
const inside = (r, W, H) => r.left >= -0.01 && r.top >= -0.01 && right(r) <= W + 0.01 && bottom(r) <= H + 0.01;
const hit = (a, b) => a.left < right(b) - 0.01 && b.left < right(a) - 0.01 && a.top < bottom(b) - 0.01 && b.top < bottom(a) - 0.01;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function layout(W, H, state) {
  const s = Math.max(1, Math.min(H / 750, (0.86 * W) / HAND_ROW_W));
  const sc = (v) => v * s;
  const gap = sc(T.gap), gapT = sc(T.tileGap), outer = sc(T.outer), bar = sc(T.bar);
  const handH = sc(T.handH), handW = HAND_ROW_W * s, handLeft = (W - handW) / 2;
  const handTop = H - outer - handH;
  const hand = rect(handLeft, handTop, handW, handH);
  const meldTileW = sc(T.riverH * T.meldScale * T.tileRatio);
  const meldOverlap = sc(T.meldOverlap);
  const meldGroupGap = sc(T.meldGroupGap);

  const meldGroupW = (n) => n * meldTileW - (n - 1) * meldOverlap;
  const meldSizes = (obj) => obj.meldSizes ?? Array.from({ length: obj.melds }, () => 3);
  const meldContentW = (sizes) =>
    sizes.length === 0 ? 0 : sizes.reduce((sum, n) => sum + meldGroupW(n), 0) + (sizes.length - 1) * meldGroupGap;

  // —— 底部栈 ——
  const selfSizes = meldSizes(state.self);
  const selfMeldH = selfSizes.length > 0 ? sc(T.riverH * T.meldScale) : 0;
  const selfMeldW = selfSizes.length > 0 ? Math.min(handW, meldContentW(selfSizes)) : 0;
  const selfMeld = selfMeldH ? rect(0, handTop - sc(T.handClearance) - selfMeldH, selfMeldW, selfMeldH) : rect(0, 0, 0, 0);
  const ownRiverBottom = selfMeldH ? selfMeld.top - gap : handTop - sc(T.handClearance);
  const ownRiverH = sc(T.riverH * 2 + T.tileGap);

  // —— 顶部栈 ——
  const topBackH = sc(T.topBackH), topBackW = topBackH * T.tileRatio;
  const topBacksW = T.handCount * topBackW + (T.handCount - 1) * gapT;
  const topBacksTop = bar + gap;
  const topSizes = meldSizes(state.top);
  const topMeldH = topSizes.length > 0 ? sc(T.riverH * T.meldScale) : 0;
  const topMeldContentW = topSizes.length > 0 ? meldContentW(topSizes) : 0;
  const topMeldTop = topBacksTop + topBackH + gap;
  const topRiverTop = topMeldTop + (topMeldH ? topMeldH + gap : 0);

  // —— 座位牌 ——
  const leftPlate = rect(outer, bar + gap, sc(T.seatPlateW), sc(T.seatPlateH));
  const rightPlate = rect(W - outer - sc(T.seatPlateW), bar + gap, sc(T.seatPlateW), sc(T.seatPlateH));
  const topPlate = rect((W - sc(T.topPlateW)) / 2, sc(4), sc(T.topPlateW), sc(T.seatPlateH));
  const selfPlate = rect(outer, handTop + (handH - sc(T.selfPlateH)) / 2, sc(T.selfPlateW), sc(T.selfPlateH));

  // —— 侧区 ——
  function sideMeldFit(sizes, avail) {
    if (sizes.length === 0) return { w: 0, h: 0, scale: 0 };
    let scale = T.sideMeldScale;
    // 旧实现 53b5da01：rotate 模式 sm DOM 51×34，视觉 34×51；vertical margin-top 1px 补偿
    const tileH = () => sc(T.sideMeldVisualH * scale);
    const overlap = () => sc(T.sideMeldOverlap * scale);
    const groupH = (n) => n * tileH() - (n - 1) * overlap();
    const total = () => sizes.reduce((sum, n) => sum + groupH(n), 0) + (sizes.length - 1) * meldGroupGap;
    while (total() > avail && scale > 0.4) scale -= 0.01;
    return { w: sc(T.sideMeldVisualW * scale) + 4, h: total(), scale };
  }
  function sideZone(side, plate) {
    const revealed = state[side].revealed ?? 0;
    const raw = revealed > 0 ? revealed : state[side].discards;
    const visible = Math.min(raw, T.displayCap);
    const overflow = revealed > 0 ? 0 : raw - visible;
    const sizes = meldSizes(state[side]);
    const sideTop = Math.max(topRiverTop, bottom(plate) + gap) + (revealed > 0 ? sc(16) : 0);
    const sideBottom = handTop - sc(T.handClearance);
    const avail = sideBottom - sideTop;
    const rows = clamp(Math.floor((avail + gapT) / (sc(T.sideTileH) + gapT)), 3, 10);
    const cols = clamp(Math.ceil(visible / rows), 2, 6);
    const riverW = cols * sc(T.sideTileW) + (cols - 1) * gapT;
    const riverH = rows * sc(T.sideTileH) + (rows - 1) * gapT;
    const backW = sc(T.sideTileH * T.tileRatio); // 83×125
    const pitch = clamp((avail - sc(T.sideTileH)) / 13, sc(8), sc(22));
    const backH = 13 * pitch + sc(T.sideTileH);
    const mf = sideMeldFit(sizes, avail);
    const zoneW = backW + gap + riverW + (mf.w ? gap + mf.w : 0);
    return { sideTop, sideBottom, avail, rows, cols, riverW, riverH, backW, pitch, backH, meld: mf, zoneW, visible, overflow, raw, revealed };
  }
  const leftZ = sideZone('left', leftPlate);
  const rightZ = sideZone('right', rightPlate);
  const centerLeft = outer + leftZ.zoneW + gap;
  const centerRight = W - outer - rightZ.zoneW - gap;
  const centerW = centerRight - centerLeft;
  const centerCx = (centerLeft + centerRight) / 2;
  selfMeld.left = centerCx - selfMeld.width / 2;

  // —— 上/下河（24 格；溢出 23+徽标）——
  function riverTopSelf(side, top) {
    const raw = state[side].discards;
    const visible = Math.min(raw, T.displayCap);
    const overflow = raw - visible;
    const cols = visible <= 16 ? 8 : 12;
    const fit = Math.min(1, centerW / (cols * sc(T.riverH * T.tileRatio) + (cols - 1) * gapT));
    const tileW = sc(T.riverH * T.tileRatio) * fit, tileH = sc(T.riverH) * fit;
    const width = cols * tileW + (cols - 1) * gapT, height = 2 * tileH + gapT;
    const windowCount = overflow > 0 ? 23 : visible;
    const badgeCount = raw - windowCount;
    const latestIndex = windowCount - 1;
    return { rect: rect(centerCx - width / 2, top, width, height), cols, rows: 2, tile: { w: tileW, h: tileH }, fit, visible, overflow, windowCount, badge: overflow > 0, badgeCount, latestIndex };
  }
  const topRiverBox = riverTopSelf('top', topRiverTop);
  const ownRiverBox = riverTopSelf('self', ownRiverBottom - ownRiverH);

  const topBacks = rect(centerCx - topBacksW / 2, topBacksTop, topBacksW, topBackH);
  const topMeldW = Math.min(Math.max(topRiverBox.rect.width, topMeldContentW), topBacksW);
  const topMeld = topMeldH ? rect(centerCx - topMeldW / 2, topMeldTop, topMeldW, topMeldH) : rect(0, 0, 0, 0);

  // —— hub ——
  const centerTop = bottom(topRiverBox.rect) + gap;
  const centerBottom = ownRiverBox.rect.top - gap;
  const available = Math.max(0, centerBottom - centerTop);
  const hubD = Math.min(clamp(available, sc(T.hubMin), sc(T.hubMax)), Math.max(0, centerW - 2 * gap));
  const hubRect = rect(centerCx - hubD / 2, centerTop + (available - hubD) / 2, hubD, hubD);
  const hub = { ...hubRect, cx: centerCx, cy: hubRect.top + hubD / 2, r: hubD / 2, compact: hubD / s < 180 };

  // —— 动作区 ——
  const actions = rect(
    Math.max(outer, W - outer - rightZ.zoneW - gap - sc(T.actionW)),
    handTop - sc(T.handClearance) - sc(T.actionH),
    sc(T.actionW),
    sc(T.actionH),
  );
  // 自己副露优先居中；与动作区冲突时整体左移，右缘贴动作区左缘
  if (selfMeld.width > 0) {
    selfMeld.left = Math.max(outer, Math.min(centerCx - selfMeld.width / 2, actions.left - gap - selfMeld.width));
  }

  // —— 侧区矩形 ——
  function sideRects(side, z) {
    const isLeft = side === 'left';
    const backX = isLeft ? outer : W - outer - z.backW;
    const riverX = isLeft ? outer + z.backW + gap : W - outer - z.backW - gap - z.riverW;
    const meldX = isLeft ? riverX + z.riverW + gap : riverX - gap - z.meld.w;
    return {
      backs: rect(backX, z.sideTop, z.backW, z.backH),
      river: rect(riverX, z.sideTop, z.riverW, z.riverH),
      melds: z.meld.w ? rect(meldX, z.sideTop + Math.max(0, (z.avail - z.meld.h) / 2), z.meld.w, z.meld.h) : rect(0, 0, 0, 0),
    };
  }
  const leftR = sideRects('left', leftZ), rightR = sideRects('right', rightZ);

  // —— 听牌 ——
  const tingCount = Math.min(state.ting ?? 0, T.tingMax);
  const tingCols = Math.min(tingCount, T.tingPerRow);
  const tingRows = Math.ceil(tingCount / T.tingPerRow) || 1;
  const tingW = tingCols * sc(T.tingW) + Math.max(0, tingCols - 1) * gapT;
  const tingH = tingRows * sc(T.tingH) + Math.max(0, tingRows - 1) * gapT;
  const tingX = Math.max(handLeft + sc(8), ownRiverBox.rect.left - gap - tingW);
  const ting = tingCount ? rect(tingX, ownRiverBox.rect.top + (ownRiverBox.rect.height - tingH) / 2, tingW, tingH) : rect(0, 0, 0, 0);

  // —— hub 内容 fit ——
  function hubContentOk(d, compact) {
    const r = d / 2;
    const wall = compact ? 32 : 40, sec = compact ? 18 : 22, status = compact ? 12 : 14;
    const maxChars = compact ? 8 : 10;
    const statusW = maxChars * status + status; // 省略号按 1em
    const dy = compact ? 50 : 55;
    const chord = 2 * Math.sqrt(Math.max(0, r * r - dy * dy));
    const label = compact ? 0 : 14;
    const ting = compact ? 12 : 14;
    const vertical = wall + 4 + label + (label ? 4 : 0) + sec + 4 + status + 4 + ting;
    const badge = compact ? 14 : 16;
    const badgeOk = r - badge * 0.75 >= badge * 1.5;
    return statusW <= chord - 8 && vertical <= 2 * (r - 12) && badgeOk;
  }

  const rects = {
    hand, actions, hub, topPlate, leftPlate, rightPlate, selfPlate,
    topBacks, topRiver: topRiverBox.rect, ownRiver: ownRiverBox.rect,
    leftBacks: leftR.backs, leftRiver: leftR.river, leftMelds: leftR.melds,
    rightBacks: rightR.backs, rightRiver: rightR.river, rightMelds: rightR.melds,
    selfMeld, topMeld, ting,
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
    ['leftPlate', 'leftBacks'], ['leftPlate', 'leftRiver'], ['leftPlate', 'topBacks'], ['leftPlate', 'topMeld'],
    ['rightPlate', 'rightBacks'], ['rightPlate', 'rightRiver'], ['rightPlate', 'topBacks'], ['rightPlate', 'topMeld'],
    ['leftMelds', 'leftRiver'], ['leftMelds', 'leftBacks'], ['rightMelds', 'rightRiver'], ['rightMelds', 'rightBacks'],
    ['selfPlate', 'hand'], ['selfPlate', 'ownRiver'], ['selfPlate', 'selfMeld'],
    ['selfMeld', 'hand'], ['topMeld', 'topRiver'], ['topMeld', 'topBacks'],
    ['ting', 'ownRiver'], ['ting', 'hand'], ['ting', 'actions'], ['ting', 'selfMeld'],
    ['ting', 'leftRiver'], ['ting', 'leftMelds'], ['ting', 'rightRiver'], ['ting', 'rightMelds'],
    ['leftRiver', 'ownRiver'], ['rightRiver', 'ownRiver'], ['leftRiver', 'topRiver'], ['rightRiver', 'topRiver'],
  ];
  for (const [a, b] of pairs) {
    if (rects[a].width > 0 && rects[b].width > 0 && hit(rects[a], rects[b])) {
      const x = Math.min(right(rects[a]), right(rects[b])) - Math.max(rects[a].left, rects[b].left);
      const y = Math.min(bottom(rects[a]), bottom(rects[b])) - Math.max(rects[a].top, rects[b].top);
      checks.push(`${a}×${b} 相交 ${x.toFixed(1)}×${y.toFixed(1)}`);
    }
  }
  const overlays = [];
  if (hit(actions, ownRiverBox.rect)) {
    const x = Math.min(right(actions), right(ownRiverBox.rect)) - Math.max(actions.left, ownRiverBox.rect.left);
    const y = Math.min(bottom(actions), bottom(ownRiverBox.rect)) - Math.max(actions.top, ownRiverBox.rect.top);
    overlays.push(`actions×ownRiver 覆盖 ${x.toFixed(1)}×${y.toFixed(1)}`);
  }
  const lift = rect(hand.left, hand.top - sc(10), hand.width, 10);
  for (const n of ['actions', 'ownRiver', 'selfMeld', 'ting']) {
    if (rects[n].width > 0 && hit(lift, rects[n])) checks.push(`选中抬起×${n}`);
  }
  if (!hubContentOk(hubD, hub.compact)) checks.push('hub 内容放不下');
  if (leftZ.visible > leftZ.rows * leftZ.cols) checks.push(`左河容量 ${leftZ.rows * leftZ.cols}<${leftZ.visible}`);
  if (rightZ.visible > rightZ.rows * rightZ.cols) checks.push(`右河容量 ${rightZ.rows * rightZ.cols}<${rightZ.visible}`);
  if (topRiverBox.visible > topRiverBox.cols * 2) checks.push(`上河容量 ${topRiverBox.cols * 2}<${topRiverBox.visible}`);
  if (ownRiverBox.visible > ownRiverBox.cols * 2) checks.push(`自河容量 ${ownRiverBox.cols * 2}<${ownRiverBox.visible}`);
  if (topMeldW > centerW) checks.push(`对家副露条宽 ${topMeldW.toFixed(1)}>${centerW.toFixed(1)}`);
  if (topMeldContentW > topBacksW) checks.push(`对家副露内容 ${topMeldContentW.toFixed(1)}>顶背 ${topBacksW.toFixed(1)}`);

  return {
    s, hubD, checks, overlays,
    key: {
      hub: `${hubD.toFixed(1)}${hub.compact ? 'c' : ''}`,
      side: `${leftZ.rows}/${rightZ.rows}r ${leftZ.cols}/${rightZ.cols}c cap=${leftZ.rows * leftZ.cols}/${rightZ.rows * rightZ.cols}`,
      over: `${leftZ.overflow}/${rightZ.overflow}`,
      sideMeld: `${leftZ.meld.scale.toFixed(2)}/${leftZ.meld.h.toFixed(1)}`,
      top: `${topRiverBox.cols}c+${topRiverBox.overflow}/${topRiverBox.badgeCount}`,
      hand: `${hand.left.toFixed(1)}..${right(hand).toFixed(1)}`,
      actions: `${actions.left.toFixed(1)},${actions.top.toFixed(1)}`,
      centerW: centerW.toFixed(1),
    },
    rects,
  };
}

const base = () => ({ discards: 0, melds: 0, revealed: 0 });
const states = {
  normal: { top: base(), left: base(), right: base(), self: base(), ting: 0 },
  mid: { top: { discards: 12, melds: 1, revealed: 0 }, left: { discards: 8, melds: 1, revealed: 0 }, right: { discards: 10, melds: 1, revealed: 0 }, self: { discards: 9, melds: 1, revealed: 0 }, ting: 8 },
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
};

let failures = 0;
for (const [W, H] of CANVASES) {
  for (const [name, state] of Object.entries(states)) {
    const r = layout(W, H, state);
    const ok = r.checks.length === 0;
    if (!ok) failures += 1;
    console.log(`${ok ? '✅' : '❌'} ${W}x${H} ${name.padEnd(13)} s=${r.s.toFixed(3)} hub=${r.key.hub} side=${r.key.side} over=${r.key.over} meld=${r.key.sideMeld} top=${r.key.top} act=${r.key.actions} cw=${r.key.centerW}${r.overlays.length ? ` [${r.overlays.join(',')}]` : ''}`);
    for (const c of r.checks) console.log(`    - ${c}`);
  }
}
console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

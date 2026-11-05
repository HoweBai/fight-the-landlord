#!/usr/bin/env node
/**
 * 川麻红金牌桌 —— 设计期几何原型 v4（路线 A：动作浮层 + 牌河显示 24+N）。
 * 随 spec 入库；生产代码不引用。
 * 运行：node docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs
 *
 * 口径：设计 px；s = max(1, min(H/750, 0.86W / 手牌行宽))。
 * 108 张川麻：两家早胡后两家交替，单家弃牌可达 ~29；显示上限 24，超额 +N。
 */

const T = {
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
  sideMeldScale: 0.65,
  seatPlateW: 140,
  seatPlateH: 56,
  topPlateW: 144,
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
  tingPerRow: 5,
  hubMin: 160,
  hubMax: 200,
  displayCap: 24,
};
const HAND_ROW_W = T.handCount * T.handH * T.tileRatio + (T.handCount - 1) * T.tileGap + T.drawnGap;

const CANVASES = [
  [1334, 750],
  [1500, 750],
  [1623, 750],
  [1778, 750],
  [1334, 833],
  [1334, 1000],
  [1334, 1334],
];

const rect = (left, top, width, height) => ({ left, top, width, height });
const right = (r) => r.left + r.width;
const bottom = (r) => r.top + r.height;
const inside = (r, W, H) => r.left >= -0.01 && r.top >= -0.01 && right(r) <= W + 0.01 && bottom(r) <= H + 0.01;
const hit = (a, b) =>
  a.left < right(b) - 0.01 && b.left < right(a) - 0.01 && a.top < bottom(b) - 0.01 && b.top < bottom(a) - 0.01;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function layout(W, H, state) {
  const s = Math.max(1, Math.min(H / 750, (0.86 * W) / HAND_ROW_W));
  const sc = (v) => v * s;
  const gap = sc(T.gap);
  const gapT = sc(T.tileGap);
  const outer = sc(T.outer);
  const bar = sc(T.bar);
  const handH = sc(T.handH);
  const handW = HAND_ROW_W * s;
  const handLeft = (W - handW) / 2;
  const handTop = H - outer - handH;
  const hand = rect(handLeft, handTop, handW, handH);

  // —— 底部栈 ——
  const selfMeldH = state.self.melds > 0 ? sc(T.riverH * T.meldScale) : 0;
  const meldTileW = sc(T.riverH * T.meldScale * T.tileRatio);
  const selfMeldContentW = state.self.melds > 0 ? Math.min(handW, state.self.melds * 3 * meldTileW + (state.self.melds - 1) * gap) : 0;
  const selfMeld = selfMeldH
    ? rect(handLeft + (handW - selfMeldContentW) / 2, handTop - sc(T.handClearance) - selfMeldH, selfMeldContentW, selfMeldH)
    : rect(0, 0, 0, 0);
  const ownRiverBottom = selfMeldH ? selfMeld.top - gap : handTop - sc(T.handClearance);
  const ownRiverH = sc(T.riverH * 2 + T.tileGap);

  // —— 顶部栈 ——
  const topBackH = sc(T.topBackH);
  const topBackW = topBackH * T.tileRatio;
  const topBacksW = T.handCount * topBackW + (T.handCount - 1) * gapT;
  const topBacksTop = bar + gap;
  const topMeldH = state.top.melds > 0 ? sc(T.riverH * T.meldScale) : 0;
  const topMeldTop = topBacksTop + topBackH + gap;
  const topRiverTop = topMeldTop + (topMeldH ? topMeldH + gap : 0);

  // —— 座位牌 ——
  const leftPlate = rect(outer, bar + gap, sc(T.seatPlateW), sc(T.seatPlateH));
  const rightPlate = rect(W - outer - sc(T.seatPlateW), bar + gap, sc(T.seatPlateW), sc(T.seatPlateH));
  const topPlate = rect((W - sc(T.topPlateW)) / 2, sc(4), sc(T.topPlateW), sc(T.seatPlateH));
  const selfPlate = rect(outer, handTop + (handH - sc(T.selfPlateH)) / 2, sc(T.selfPlateW), sc(T.selfPlateH));

  // —— 侧区（先算，决定 center）——
  function sideZone(side, plate) {
    const discards = state[side].discards;
    const revealed = state[side].revealed ?? 0;
    const raw = Math.max(discards, revealed);
    const visible = Math.min(raw, T.displayCap);
    const overflow = raw - visible;
    const melds = state[side].melds;
    const sideTop = Math.max(topRiverTop, bottom(plate) + gap);
    const sideBottom = handTop - sc(T.handClearance);
    const avail = sideBottom - sideTop;
    const rows = clamp(Math.floor((avail + gapT) / (sc(T.sideTileH) + gapT)), 3, 10);
    const cols = clamp(Math.ceil(visible / rows), 2, 6);
    const riverW = cols * sc(T.sideTileW) + (cols - 1) * gapT;
    const riverH = rows * sc(T.sideTileH) + (rows - 1) * gapT;
    const backW = sc(T.sideTileW);
    const pitch = clamp((avail - sc(T.sideTileH)) / 13, sc(8), sc(22));
    const backH = 13 * pitch + sc(T.sideTileH);
    const meldW = melds > 0 ? sc(T.sideTileW * T.sideMeldScale) : 0;
    const meldH = melds > 0 ? melds * sc(T.sideTileH * T.sideMeldScale) + (melds - 1) * gap : 0;
    const zoneW = backW + gap + riverW + (meldW ? gap + meldW : 0);
    return { sideTop, sideBottom, avail, rows, cols, riverW, riverH, backW, pitch, backH, meldW, meldH, zoneW, visible, overflow, raw };
  }
  const leftZ = sideZone('left', leftPlate);
  const rightZ = sideZone('right', rightPlate);

  const centerLeft = outer + leftZ.zoneW + gap;
  const centerRight = W - outer - rightZ.zoneW - gap;
  const centerW = centerRight - centerLeft;
  const centerCx = (centerLeft + centerRight) / 2;

  // —— 上/下河（8/12 列 ×2，显示上限 24）——
  function riverTopSelf(side, top) {
    const raw = state[side].discards;
    const visible = Math.min(raw, T.displayCap);
    const wantedCols = visible <= 16 ? 8 : 12;
    const fit = Math.min(1, centerW / (wantedCols * sc(T.riverH * T.tileRatio) + (wantedCols - 1) * gapT));
    const tileW = sc(T.riverH * T.tileRatio) * fit;
    const tileH = sc(T.riverH) * fit;
    const width = wantedCols * tileW + (wantedCols - 1) * gapT;
    const height = 2 * tileH + gapT;
    return {
      rect: rect(centerCx - width / 2, top, width, height),
      cols: wantedCols, rows: 2, tile: { w: tileW, h: tileH }, fit, visible, overflow: raw - visible,
    };
  }
  const topRiverBox = riverTopSelf('top', topRiverTop);
  const ownRiverBox = riverTopSelf('self', ownRiverBottom - ownRiverH);

  // —— 顶背/顶副露：按上河中心居中 ——
  const topBacks = rect(centerCx - topBacksW / 2, topBacksTop, topBacksW, topBackH);
  const topMeld = topMeldH
    ? rect(centerCx - topRiverBox.rect.width / 2, topMeldTop, topRiverBox.rect.width, topMeldH)
    : rect(0, 0, 0, 0);

  // —— 血战盘：center 区居中 + 宽度夹取 ——
  const centerTop = bottom(topRiverBox.rect) + gap;
  const centerBottom = ownRiverBox.rect.top - gap;
  const available = Math.max(0, centerBottom - centerTop);
  const hubD = Math.min(clamp(available, sc(T.hubMin), sc(T.hubMax)), Math.max(0, centerW - 2 * gap));
  const hubRect = rect(centerCx - hubD / 2, centerTop + (available - hubD) / 2, hubD, hubD);
  const hub = { ...hubRect, cx: hubRect.left + hubD / 2, cy: hubRect.top + hubD / 2, r: hubD / 2, compact: hubD / s < 180 };

  // —— 动作区：手牌右上、右侧区左缘内、覆盖自家河右缘（路线 A） ——
  const actions = rect(
    Math.max(outer, W - outer - rightZ.zoneW - gap - sc(T.actionW)),
    handTop - sc(T.handClearance) - sc(T.actionH),
    sc(T.actionW),
    sc(T.actionH),
  );

  // —— 侧区矩形 ——
  function sideRects(side, z) {
    const isLeft = side === 'left';
    const backX = isLeft ? outer : W - outer - z.backW;
    const riverX = isLeft ? outer + z.backW + gap : W - outer - z.backW - gap - z.riverW;
    const meldX = isLeft ? riverX + z.riverW + gap : riverX - gap - z.meldW;
    return {
      backs: rect(backX, z.sideTop, z.backW, z.backH),
      river: rect(riverX, z.sideTop, z.riverW, z.riverH),
      melds: z.meldW ? rect(meldX, z.sideTop, z.meldW, z.meldH) : rect(0, 0, 0, 0),
    };
  }
  const leftR = sideRects('left', leftZ);
  const rightR = sideRects('right', rightZ);

  // —— 听牌行：自家河左侧 2×5 ——
  const tingCount = Math.min(state.ting ?? 0, T.tingMax);
  const tingCols = Math.min(tingCount, T.tingPerRow);
  const tingRows = Math.ceil(tingCount / T.tingPerRow) || 1;
  const tingW = tingCols * sc(T.tingW) + Math.max(0, tingCols - 1) * gapT;
  const tingH = tingRows * sc(T.tingH) + Math.max(0, tingRows - 1) * gapT;
  const tingX = Math.max(handLeft + sc(8), ownRiverBox.rect.left - gap - tingW);
  const ting = tingCount
    ? rect(tingX, ownRiverBox.rect.top + (ownRiverBox.rect.height - tingH) / 2, tingW, tingH)
    : rect(0, 0, 0, 0);

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
    ['hub', 'hand'], ['hub', 'actions'], ['hub', 'topPlate'], ['hub', 'leftPlate'], ['hub', 'rightPlate'],
    ['actions', 'hand'], ['actions', 'ownRiver'], ['actions', 'selfMeld'], ['actions', 'rightRiver'], ['actions', 'rightMelds'], ['actions', 'rightBacks'],
    ['leftPlate', 'leftBacks'], ['leftPlate', 'leftRiver'], ['rightPlate', 'rightBacks'], ['rightPlate', 'rightRiver'],
    ['leftPlate', 'topBacks'], ['rightPlate', 'topBacks'], ['leftPlate', 'topMeld'], ['rightPlate', 'topMeld'],
    ['selfPlate', 'hand'], ['selfPlate', 'ownRiver'], ['selfPlate', 'selfMeld'],
    ['selfMeld', 'hand'], ['topMeld', 'topRiver'], ['topMeld', 'topBacks'],
    ['ting', 'ownRiver'], ['ting', 'hand'], ['ting', 'actions'], ['ting', 'selfMeld'],
    ['leftRiver', 'ownRiver'], ['rightRiver', 'ownRiver'], ['leftRiver', 'topRiver'], ['rightRiver', 'topRiver'],
  ];
  for (const [a, b] of pairs) {
    if (rects[a].width > 0 && rects[b].width > 0 && hit(rects[a], rects[b])) {
      const x = Math.min(right(rects[a]), right(rects[b])) - Math.max(rects[a].left, rects[b].left);
      const y = Math.min(bottom(rects[a]), bottom(rects[b])) - Math.max(rects[a].top, rects[b].top);
      checks.push(`${a}×${b} 相交 ${x.toFixed(1)}×${y.toFixed(1)}`);
    }
  }
  // 路线 A 允许动作区覆盖自家河右缘；只记录不报错
  const overlays = [];
  if (hit(actions, ownRiverBox.rect)) overlays.push('actions×ownRiver(允许)');

  const lift = rect(hand.left, hand.top - sc(10), hand.width, 10);
  for (const n of ['actions', 'ownRiver', 'selfMeld', 'ting']) {
    if (rects[n].width > 0 && hit(lift, rects[n])) checks.push(`选中抬起×${n}`);
  }

  if (leftZ.visible > leftZ.rows * leftZ.cols) checks.push(`左河容量 ${leftZ.rows * leftZ.cols}<${leftZ.visible}`);
  if (rightZ.visible > rightZ.rows * rightZ.cols) checks.push(`右河容量 ${rightZ.rows * rightZ.cols}<${rightZ.visible}`);
  if (topRiverBox.visible > topRiverBox.cols * 2) checks.push(`上河容量 ${topRiverBox.cols * 2}<${topRiverBox.visible}`);
  if (ownRiverBox.visible > ownRiverBox.cols * 2) checks.push(`自河容量 ${ownRiverBox.cols * 2}<${ownRiverBox.visible}`);

  return {
    s, hubD, checks, overlays,
    key: {
      hub: `${hubD.toFixed(1)}${hub.compact ? 'c' : ''}`,
      sideRows: `${leftZ.rows}/${rightZ.rows}`,
      sideCols: `${leftZ.cols}/${rightZ.cols}`,
      sideCap: `${leftZ.rows * leftZ.cols}/${rightZ.rows * rightZ.cols}`,
      sideOverflow: `${leftZ.overflow}/${rightZ.overflow}`,
      topCols: topRiverBox.cols,
      topOverflow: topRiverBox.overflow,
      hand: `${hand.left.toFixed(1)}..${right(hand).toFixed(1)}`,
      actions: `${actions.left.toFixed(1)},${actions.top.toFixed(1)}`,
      centerW: centerW.toFixed(1),
    },
    rects,
  };
}

const base = () => ({ discards: 0, melds: 0, revealed: 0 });
// 可达态：两家早胡后只剩两家交替；56 墙约 27–28 轮/家，碰再加轮。
const states = {
  normal: { top: base(), left: base(), right: base(), self: base(), ting: 0 },
  mid: {
    top: { discards: 12, melds: 1, revealed: 0 },
    left: { discards: 8, melds: 1, revealed: 0 },
    right: { discards: 10, melds: 1, revealed: 0 },
    self: { discards: 9, melds: 1, revealed: 0 },
    ting: 8,
  },
  top29: {
    top: { discards: 29, melds: 1, revealed: 0 },
    left: { discards: 27, melds: 0, revealed: 0 },
    right: { discards: 0, melds: 0, revealed: 0 },
    self: { discards: 0, melds: 0, revealed: 0 },
    ting: 9,
  },
  twoSurvivors: {
    top: { discards: 6, melds: 1, revealed: 8 },
    left: { discards: 29, melds: 1, revealed: 0 },
    right: { discards: 25, melds: 0, revealed: 0 },
    self: { discards: 0, melds: 0, revealed: 8 },
    ting: 9,
  },
  revealed: {
    top: { discards: 10, melds: 0, revealed: 0 },
    left: { discards: 5, melds: 0, revealed: 14 },
    right: { discards: 5, melds: 0, revealed: 14 },
    self: { discards: 8, melds: 1, revealed: 0 },
    ting: 8,
  },
  heavy: {
    top: { discards: 12, melds: 4, revealed: 0 },
    left: { discards: 8, melds: 1, revealed: 0 },
    right: { discards: 8, melds: 0, revealed: 0 },
    self: { discards: 8, melds: 0, revealed: 0 },
    ting: 9,
  },
  fourMelds: {
    top: { discards: 8, melds: 4, revealed: 0 },
    left: { discards: 8, melds: 4, revealed: 0 },
    right: { discards: 8, melds: 0, revealed: 0 },
    self: { discards: 8, melds: 0, revealed: 0 },
    ting: 8,
  },
};

let failures = 0;
for (const [W, H] of CANVASES) {
  for (const [name, state] of Object.entries(states)) {
    const r = layout(W, H, state);
    const ok = r.checks.length === 0;
    if (!ok) failures += 1;
    console.log(
      `${ok ? '✅' : '❌'} ${W}x${H} ${name.padEnd(12)} s=${r.s.toFixed(3)} hub=${r.key.hub} ` +
        `side=${r.key.sideRows}r/${r.key.sideCols}c cap=${r.key.sideCap} over=${r.key.sideOverflow} ` +
        `top=${r.key.topCols}c+${r.key.topOverflow} hand=${r.key.hand} act=${r.key.actions} center=${r.key.centerW}` +
        (r.overlays.length ? ` [${r.overlays.join(',')}]` : ''),
    );
    for (const c of r.checks) console.log(`    - ${c}`);
  }
}
console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

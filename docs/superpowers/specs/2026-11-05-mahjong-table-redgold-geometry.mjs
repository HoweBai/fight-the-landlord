#!/usr/bin/env node
/**
 * 川麻红金牌桌 —— 设计期几何原型（随 spec 入库；生产代码不引用）。
 * 目的：在写 v3 spec / mockup 前，用代码把六档画布 + 可达最坏态的矩形账算实，
 * 并机械检查不相交/越界。不是生产实现，不接 UI。
 * 运行：node docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs
 *
 * 口径：设计 px；s = max(1, min(H/750, 0.86W / 手牌行宽))。
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
  handClearance: 16, // 选中抬起 10 + 6 净空
  topBackH: 46,
  riverH: 56,
  sideTileW: 56,
  sideTileH: (56 * 40) / 49, // 49:40 素材比例
  meldScale: 0.8,
  sideMeldScale: 0.65,
  seatPlateW: 140,
  seatPlateH: 56,
  topPlateW: 144,
  selfPlateW: 56,
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
};
const HAND_ROW_W = T.handCount * T.handH * T.tileRatio + (T.handCount - 1) * T.tileGap + T.drawnGap;

const CANVASES = [
  [1334, 750],
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

function riverCols(count, perRow) {
  return Math.max(1, Math.ceil(count / perRow));
}

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
  const selfMeld = selfMeldH
    ? rect(handLeft, handTop - sc(T.handClearance) - selfMeldH, handW, selfMeldH)
    : rect(0, 0, 0, 0);
  const ownRiverBottom = selfMeldH ? selfMeld.top - gap : handTop - sc(T.handClearance);
  const ownRiverH = sc(T.riverH * 2 + T.tileGap);

  // —— 顶部栈 ——
  const topBackH = sc(T.topBackH);
  const topBackW = topBackH * T.tileRatio;
  const topBacksW = T.handCount * topBackW + (T.handCount - 1) * gapT;
  const topBacks = rect(handLeft, bar + gap, topBacksW, topBackH);
  const topMeldH = state.top.melds > 0 ? sc(T.riverH * T.meldScale) : 0;
  const topMeldTop = bottom(topBacks) + gap;
  const topRiverTop = topMeldTop + (topMeldH ? topMeldH + gap : 0);
  const topRiver = rect(handLeft, topRiverTop, handW, ownRiverH);

  // —— 血战盘 ——
  const centerTop = bottom(topRiver) + gap;
  const centerBottom = ownRiverBottom - ownRiverH - gap;
  const available = Math.max(0, centerBottom - centerTop);
  const hubD = clamp(available, sc(T.hubMin), sc(T.hubMax));
  const hubRect = rect(W / 2 - hubD / 2, centerTop + (available - hubD) / 2, hubD, hubD);
  const hub = { ...hubRect, cx: hubRect.left + hubD / 2, cy: hubRect.top + hubD / 2, r: hubD / 2 };

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

  // —— 动作区（先定，侧区底缘依赖它）——
  const actions = rect(
    W - outer - sc(T.actionW),
    handTop - sc(T.handClearance) - sc(T.actionH),
    sc(T.actionW),
    sc(T.actionH),
  );

  // —— 侧区 ——
  function sideZone(side, plate) {
    const discards = state[side].discards;
    const revealed = state[side].revealed ?? 0;
    const visible = Math.max(discards, revealed);
    const melds = state[side].melds;
    const sideTop = Math.max(bottom(topRiver), bottom(plate) + gap);
    const sideBottom = actions.top - gap;
    const avail = sideBottom - sideTop;
    const rows = clamp(Math.floor((avail + gapT) / (sc(T.sideTileH) + gapT)), 3, 8);
    const cols = clamp(riverCols(visible, rows), 2, 8);
    const riverW = cols * sc(T.sideTileW) + (cols - 1) * gapT;
    const riverH = rows * sc(T.sideTileH) + (rows - 1) * gapT;
    const backW = sc(T.sideTileW);
    const pitch = clamp((avail - sc(T.sideTileH)) / 13, sc(8), sc(22));
    const backH = 13 * pitch + sc(T.sideTileH);
    const meldW = melds > 0 ? sc(T.sideTileW * T.sideMeldScale) : 0;
    const meldH = melds > 0 ? melds * sc(T.sideTileH * T.sideMeldScale) + (melds - 1) * gap : 0;
    const zoneW = backW + gap + riverW + (meldW ? gap + meldW : 0);
    const zoneH = Math.max(backH, riverH, meldH);
    return {
      sideTop, sideBottom, avail, rows, cols, riverW, riverH, backW, pitch, backH, meldW, meldH, zoneW, zoneH,
      visible,
    };
  }
  const leftZ = sideZone('left', leftPlate);
  const rightZ = sideZone('right', rightPlate);

  const centerLeft = outer + leftZ.zoneW + gap;
  const centerRight = W - outer - rightZ.zoneW - gap;
  const centerW = centerRight - centerLeft;

  function river(side, z, top, bottomY) {
    const visible = z.visible;
    const discards = state[side].discards;
    const perRow = 2;
    const cols = clamp(riverCols(Math.max(visible, discards), perRow), 8, 18);
    // 上/下河按列扩展：8 → 12（24 张，108 张川麻的可达上限；36 张不可达）
    const wantedCols = visible <= 16 ? 8 : 12;
    const fit = Math.min(1, centerW / (wantedCols * sc(T.riverH * T.tileRatio) + (wantedCols - 1) * gapT));
    const tileW = sc(T.riverH * T.tileRatio) * fit;
    const tileH = sc(T.riverH) * fit;
    const width = wantedCols * tileW + (wantedCols - 1) * gapT;
    const height = 2 * tileH + gapT;
    const heightFit = Math.min(1, (bottomY - top) / height);
    return {
      rect: rect(centerLeft + (centerW - width) / 2, top, width, height * heightFit),
      cols: wantedCols,
      rows: 2,
      tile: { w: tileW, h: tileH * heightFit },
      fit: Math.min(fit, heightFit),
      visible,
    };
  }

  const topRiverBox = river('top', { visible: state.top.discards }, topRiverTop, ownRiverBottom);
  const ownRiverBox = river('self', { visible: state.self.discards }, ownRiverBottom - ownRiverH, ownRiverBottom);

  // 侧区矩形（背面 + 河 + 副露）
  function sideRects(side, z, plate) {
    const isLeft = side === 'left';
    const backX = isLeft ? outer : W - outer - z.backW;
    const riverX = isLeft ? outer + z.backW + gap : W - outer - z.backW - gap - z.riverW;
    const meldX = isLeft ? riverX + z.riverW + gap : riverX - gap - z.meldW;
    return {
      backs: rect(backX, z.sideTop, z.backW, z.backH),
      river: rect(riverX, z.sideTop, z.riverW, z.riverH),
      melds: z.meldW ? rect(meldX, z.sideTop, z.meldW, z.meldH) : rect(0, 0, 0, 0),
      plate,
    };
  }
  const leftR = sideRects('left', leftZ, leftPlate);
  const rightR = sideRects('right', rightZ, rightPlate);

  // —— 听牌行：手牌左上方、自家牌河左侧；2 行 × 5 ——
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
    hand,
    actions,
    hub,
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
    topMeld: topMeldH ? rect(handLeft, topMeldTop, handW, topMeldH) : rect(0, 0, 0, 0),
    ting,
  };

  const checks = [];
  for (const [name, r] of Object.entries(rects)) {
    if (r.width <= 0 || r.height <= 0) continue;
    if (!inside(r, W, H)) checks.push(`${name} 越界`);
  }
  const pairs = [
    ['hub', 'topRiver'], ['hub', 'ownRiver'], ['hub', 'leftRiver'], ['hub', 'rightRiver'],
    ['hub', 'hand'], ['hub', 'actions'], ['hub', 'topPlate'], ['hub', 'leftPlate'], ['hub', 'rightPlate'],
    ['actions', 'hand'], ['actions', 'ownRiver'], ['actions', 'rightRiver'], ['actions', 'rightMelds'], ['actions', 'rightBacks'],
    ['leftPlate', 'leftBacks'], ['leftPlate', 'leftRiver'], ['rightPlate', 'rightBacks'], ['rightPlate', 'rightRiver'],
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
  // 选中抬起 10：抬升后的手牌顶不能碰动作区/自家河/副露/听牌行
  const lift = rect(hand.left, hand.top - sc(10), hand.width, 10);
  for (const n of ['actions', 'ownRiver', 'selfMeld', 'ting']) {
    if (rects[n].width > 0 && hit(lift, rects[n])) checks.push(`选中抬起×${n}`);
  }

  // 容量
  const sideCapLeft = leftZ.rows * leftZ.cols;
  const sideCapRight = rightZ.rows * rightZ.cols;
  if (leftZ.visible > sideCapLeft) checks.push(`左河容量 ${sideCapLeft}<${leftZ.visible}`);
  if (rightZ.visible > sideCapRight) checks.push(`右河容量 ${sideCapRight}<${rightZ.visible}`);
  if (topRiverBox.visible > topRiverBox.cols * 2) checks.push(`上河容量 ${topRiverBox.cols * 2}<${topRiverBox.visible}`);
  if (ownRiverBox.visible > ownRiverBox.cols * 2) checks.push(`自河容量 ${ownRiverBox.cols * 2}<${ownRiverBox.visible}`);

  return {
    s, hubD, checks,
    key: {
      hand: hand.left.toFixed(1) + '..' + right(hand).toFixed(1),
      actions: actions.left.toFixed(1) + ',' + actions.top.toFixed(1),
      hub: hubD.toFixed(1),
      sideRows: leftZ.rows + '/' + rightZ.rows,
      sideCols: leftZ.cols + '/' + rightZ.cols,
      sideCap: sideCapLeft + '/' + sideCapRight,
      topCols: topRiverBox.cols,
      topFit: topRiverBox.fit.toFixed(2),
      selfPlateRight: right(selfPlate).toFixed(1),
      handLeft: hand.left.toFixed(1),
      centerW: centerW.toFixed(1),
    },
    rects,
  };
}

const base = () => ({ discards: 0, melds: 0, revealed: 0 });
// 108 张川麻：四家手牌 52 张 + 牌墙 56 张；36 张/家弃牌不可达。
// 可达最坏态按“弃牌 + 副露（4 张/组上限）”控制总量，覆盖边家 17/24、上家 4 副露、已胡亮牌 14 张。
const states = {
  normal: { top: base(), left: base(), right: base(), self: base(), ting: 0 },
  mid: {
    top: { discards: 12, melds: 1, revealed: 0 },
    left: { discards: 8, melds: 1, revealed: 0 },
    right: { discards: 10, melds: 1, revealed: 0 },
    self: { discards: 9, melds: 1, revealed: 0 },
    ting: 8,
  },
  top24: {
    top: { discards: 24, melds: 0, revealed: 0 },
    left: { discards: 8, melds: 0, revealed: 0 },
    right: { discards: 8, melds: 0, revealed: 0 },
    self: { discards: 8, melds: 0, revealed: 0 },
    ting: 0,
  },
  side17: {
    top: { discards: 10, melds: 0, revealed: 0 },
    left: { discards: 17, melds: 1, revealed: 0 },
    right: { discards: 8, melds: 0, revealed: 0 },
    self: { discards: 8, melds: 0, revealed: 0 },
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
  maxDiscards: {
    top: { discards: 24, melds: 0, revealed: 0 },
    left: { discards: 14, melds: 0, revealed: 0 },
    right: { discards: 9, melds: 0, revealed: 0 },
    self: { discards: 9, melds: 0, revealed: 0 },
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
      `${ok ? '✅' : '❌'} ${W}x${H} ${name.padEnd(11)} s=${r.s.toFixed(3)} hub=${r.key.hub} ` +
        `sideRows=${r.key.sideRows} sideCols=${r.key.sideCols} cap=${r.key.sideCap} ` +
        `topCols=${r.key.topCols} fit=${r.key.topFit} hand=${r.key.hand} actions=${r.key.actions} ` +
        `selfPlateR=${r.key.selfPlateRight} handL=${r.key.handLeft} centerW=${r.key.centerW}`,
    );
    for (const c of r.checks) console.log(`    - ${c}`);
  }
}
console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

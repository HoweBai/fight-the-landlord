import { describe, it, expect } from 'vitest';
import { mahjongTableLayoutV3, MAHJONG_TABLE_TOKENS_V3 } from '../src/game/mahjong-layout-v3';

/** 3 张一组的副露（顺/刻）；杠用显式 4。 */
const groups = (n: number) => Array.from({ length: n }, () => 3);

interface SeatIn {
  discards: number;
  melds: number[];
  revealedCount?: number;
}

const seat = (discards = 0, melds: number[] = [], revealedCount = 0): SeatIn =>
  revealedCount > 0 ? { discards, melds, revealedCount } : { discards, melds };

const input = (o: { top?: SeatIn; left?: SeatIn; right?: SeatIn; self?: SeatIn; ting?: number }) => ({
  bySlot: {
    top: o.top ?? seat(),
    left: o.left ?? seat(),
    right: o.right ?? seat(),
    self: o.self ?? seat(),
  },
  phase: 'play' as const,
  tingCount: o.ting ?? 0,
});

const EMPTY = input({});

/** v15 几何原型的十五态（melds 计数 → 3 张组；meldSizes 显式展开）。 */
const STATES: Record<string, ReturnType<typeof input>> = {
  normal: input({}),
  mid: input({
    top: seat(12, groups(1)),
    left: seat(8, groups(1)),
    right: seat(10, groups(1)),
    self: seat(9, groups(1)),
    ting: 9,
  }),
  top29: input({ top: seat(29, groups(1)), left: seat(27), ting: 9 }),
  twoSurvivors: input({
    top: seat(6, groups(1), 8),
    left: seat(29, groups(1)),
    right: seat(25),
    self: seat(0, [], 8),
    ting: 9,
  }),
  revealed: input({
    top: seat(10),
    left: seat(5, [], 14),
    right: seat(5, [], 14),
    self: seat(8, groups(1)),
    ting: 8,
  }),
  heavy: input({
    top: seat(12, groups(4)),
    left: seat(8, groups(1)),
    right: seat(8),
    self: seat(8),
    ting: 9,
  }),
  fourMelds: input({
    top: seat(8, groups(4)),
    left: seat(8, groups(4)),
    right: seat(8),
    self: seat(8),
    ting: 8,
  }),
  selfFourGang: input({
    top: seat(8),
    left: seat(8),
    right: seat(25, groups(1)),
    self: seat(8, [4, 4, 4, 4]),
    ting: 9,
  }),
  gangHeavy: input({
    top: seat(8, [4, 4, 4, 4]),
    left: seat(8, [4, 4, 4, 4]),
    right: seat(8, [4, 4, 4, 4]),
    self: seat(8, [4, 4, 4, 4]),
    ting: 9,
  }),
  overlay: input({
    top: seat(0),
    left: seat(16, groups(1)),
    right: seat(25, groups(1)),
    self: seat(17),
    ting: 9,
  }),
  overlayWorst: input({
    left: seat(29, [3, 3, 3, 3]),
    right: seat(29, [4, 4, 4, 4]),
    self: seat(29),
    ting: 9,
  }),
  revealed29: input({
    left: seat(29, [], 14),
    right: seat(5, [], 14),
    self: seat(8, groups(1)),
    ting: 9,
  }),
  oneSideRevealed: input({ left: seat(5, [], 14), ting: 8 }),
  threeRevealed: input({
    top: seat(0, [], 14),
    left: seat(5, [], 14),
    right: seat(5, [], 14),
    ting: 9,
  }),
  revealedGang: input({ left: seat(5, [4, 4, 4, 4], 2), ting: 9 }),
};

const CANVASES_7: Array<[number, number]> = [
  [1334, 750],
  [1500, 750],
  [1623, 750],
  [1778, 750],
  [1334, 833],
  [1334, 1000],
  [1334, 1334],
];

describe('mahjongTableLayoutV3：七档 × 十五态 checks 全绿', () => {
  it('七档 + 2668×1500(u=2)：checks 为空数组', () => {
    for (const [W, H] of [...CANVASES_7, [2668, 1500] as [number, number]]) {
      for (const [name, st] of Object.entries(STATES)) {
        const l = mahjongTableLayoutV3(W, H, st);
        expect(Array.isArray(l.checks), `${W}x${H} ${name} checks 存在`).toBe(true);
        expect(l.checks, `${W}x${H} ${name}`).toEqual([]);
      }
    }
  });
});

describe('mahjongTableLayoutV3：base 1334×750 锚点', () => {
  it('normal：手牌/上下河/侧背/动作区/hub', () => {
    const l = mahjongTableLayoutV3(1334, 750, EMPTY);
    expect(l.u).toBe(1);
    expect(l.offsetX).toBe(0);
    expect(l.offsetY).toBe(0);
    expect(l.rects.bar).toEqual({ left: 0, top: 0, width: 1334, height: 64 });
    expect(l.rects.hand).toEqual({ left: 146.23, top: 630, width: 1041.54, height: 108 });
    expect(l.rects.topRiver).toEqual({ left: 511.33, top: 118, width: 311.35, height: 114 });
    expect(l.rects.ownRiver).toEqual({ left: 511.33, top: 500, width: 311.35, height: 114 });
    expect(l.rects.leftBacks).toEqual({ left: 12, top: 128, width: 30.34, height: 331.71 });
    expect(l.rects.rightBacks).toEqual({ left: 1291.66, top: 128, width: 30.34, height: 331.71 });
    expect(l.actions).toEqual({ left: 1107.66, top: 438, width: 176, height: 176 });
    expect(l.hub.rect).toEqual({ left: 567, top: 266, width: 200, height: 200 });
    expect(l.hub.cx).toBe(667);
    expect(l.hub.compact).toBe(false);
  });

  it('normal：座位牌 / banner 锚点 / 侧背 pitch', () => {
    const l = mahjongTableLayoutV3(1334, 750, EMPTY);
    expect(l.seatPlates.left).toEqual({ left: 12, top: 68, width: 160, height: 56 });
    expect(l.seatPlates.right).toEqual({ left: 1162, top: 68, width: 160, height: 56 });
    expect(l.seatPlates.top).toEqual({ left: 585, top: 4, width: 164, height: 56 });
    expect(l.seatPlates.self).toEqual({ left: 12, top: 646, width: 64, height: 76 });
    expect(l.bannerAnchors.top).toEqual({ x: 667, y: 60 });
    expect(l.bannerAnchors.self).toEqual({ x: 667, y: 630 });
    expect(l.bannerAnchors.left).toEqual({ x: 92, y: 96 });
    expect(l.bannerAnchors.right).toEqual({ x: 1242, y: 96 });
    expect(l.backs.left.tile).toEqual({ w: 30.34, h: 45.71 });
    expect(l.backs.left.pitch).toBe(22);
    expect(l.backs.right.tile).toEqual({ w: 30.34, h: 45.71 });
    expect(l.backs.top.tile).toEqual({ w: 30.53, h: 46 });
    expect(l.backs.top.gap).toBe(2);
  });

  it('mid：有副露时动作区右移到 1067.26，hub 仍居中', () => {
    const l = mahjongTableLayoutV3(1334, 750, STATES.mid);
    expect(l.actions.left).toBeCloseTo(1067.26, 2);
    expect(l.hub.cx).toBe(667);
    expect(l.actions.left).toBeCloseTo(1334 - 12 - (30.34 + 4 + 40.4) - 4 - 176, 1);
    // hub 因 zoneW 取左右最大值恒居中（I5）
    const heavy = mahjongTableLayoutV3(1334, 750, STATES.heavy);
    expect(heavy.hub.cx).toBe(667);
    expect(heavy.actions.left).toBeCloseTo(1067.26, 2);
    // mid 的 hub 被上下河挤压为 162.4 → compact
    expect(l.hub.r).toBeCloseTo(81.2, 2);
    expect(l.hub.compact).toBe(true);
  });

  it('七档只改 offset；u=1', () => {
    const base = mahjongTableLayoutV3(1334, 750, EMPTY);
    for (const [w, h] of CANVASES_7.slice(1)) {
      const l = mahjongTableLayoutV3(w, h, EMPTY);
      expect(l.u).toBe(1);
      expect(l.offsetX).toBeCloseTo((w - 1334) / 2, 6);
      expect(l.offsetY).toBeCloseTo((h - 750) / 2, 6);
      expect(l.rects.hand.left).toBeCloseTo(base.rects.hand.left + (w - 1334) / 2, 2);
      expect(l.rects.hand.top).toBeCloseTo(base.rects.hand.top + (h - 750) / 2, 2);
      expect(l.checks).toEqual([]);
    }
  });

  it('2668×1500：u=2，rect 等比', () => {
    const l = mahjongTableLayoutV3(2668, 1500, EMPTY);
    expect(l.u).toBe(2);
    expect(l.offsetX).toBe(0);
    expect(l.offsetY).toBe(0);
    expect(l.rects.hand).toEqual({ left: 292.46, top: 1260, width: 2083.08, height: 216 });
    expect(l.rects.leftBacks).toEqual({ left: 24, top: 256, width: 60.68, height: 663.43 });
    expect(l.checks).toEqual([]);
  });
});

describe('mahjongTableLayoutV3：侧河 2 列块', () => {
  const sideInput = (n: number) => input({ left: seat(n), right: seat(n) });

  it('0 张 → cols=0 rows=0 rect 0×0（不是 2 列）', () => {
    const l = mahjongTableLayoutV3(1334, 750, sideInput(0));
    for (const side of ['left', 'right'] as const) {
      const r = l.rivers[side];
      expect(r.cols).toBe(0);
      expect(r.rows).toBe(0);
      expect(r.visible).toBe(0);
      expect(r.rect.width).toBe(0);
      expect(r.rect.height).toBe(0);
      expect(r.badgeRect).toBeNull();
      expect(l.rects[`${side}River`]).toEqual(r.rect);
    }
  });

  it('1/8/12/16/17/20 张 → 2 列、rows、无徽标', () => {
    const cases = [
      { n: 1, rows: 1, h: 37.17, top: 352.42 },
      { n: 8, rows: 4, h: 154.67, top: 293.66 },
      { n: 12, rows: 6, h: 233.01, top: 254.5 },
      { n: 16, rows: 8, h: 311.35, top: 215.33 },
      { n: 17, rows: 9, h: 350.51, top: 195.74 },
      { n: 20, rows: 10, h: 389.68, top: 176.16 },
    ] as const;
    for (const c of cases) {
      const l = mahjongTableLayoutV3(1334, 750, sideInput(c.n));
      for (const side of ['left', 'right'] as const) {
        const r = l.rivers[side];
        expect(r.cols).toBe(2);
        expect(r.rows).toBe(c.rows);
        expect(r.visible).toBe(c.n);
        expect(r.overflow).toBe(0);
        expect(r.windowCount).toBe(c.n);
        expect(r.windowStart).toBe(0);
        expect(r.latestIndex).toBe(c.n - 1);
        expect(r.badgeCount).toBe(0);
        expect(r.badgeCell).toBe(c.n);
        expect(r.badgeRect).toBeNull();
        expect(r.rect.width).toBe(114);
        expect(r.rect.height).toBeCloseTo(c.h, 2);
        expect(r.rect.top).toBeCloseTo(c.top, 2);
        expect(r.tile).toEqual({ w: 56, h: 37.17 });
        expect(r.fit).toBe(1);
        expect(r.gap).toBe(2);
      }
      const left = l.rivers.left.rect;
      const right = l.rivers.right.rect;
      expect(left.left).toBeCloseTo(393.33, 2);
      expect(right.left).toBeCloseTo(826.67, 2);
    }
  });

  it('21/24/29 张 → 19 + N 窗口与徽标（overflow 数值 = raw−visible）', () => {
    const cases = [
      { n: 21, visible: 21, overflow: 0, windowStart: 2, badgeCount: 2 },
      { n: 24, visible: 24, overflow: 0, windowStart: 5, badgeCount: 5 },
      { n: 29, visible: 24, overflow: 5, windowStart: 10, badgeCount: 10 },
    ] as const;
    for (const c of cases) {
      const l = mahjongTableLayoutV3(1334, 750, sideInput(c.n));
      for (const side of ['left', 'right'] as const) {
        const r = l.rivers[side];
        expect(r.cols).toBe(2);
        expect(r.rows).toBe(10);
        expect(r.visible).toBe(c.visible);
        expect(r.overflow).toBe(c.overflow);
        expect(r.windowCount).toBe(19);
        expect(r.windowStart).toBe(c.windowStart);
        expect(r.latestIndex).toBe(18);
        expect(r.badgeCount).toBe(c.badgeCount);
        expect(r.badgeCell).toBe(19);
        expect(r.badgeRect).not.toBeNull();
        expect(l.rects[`${side}Badge`]).toEqual(r.badgeRect);
      }
      // 徽标落在 2 列网格第 19 格（col=1,row=9），画布坐标
      expect(l.rivers.left.badgeRect).toEqual({ left: 451.33, top: 528.67, width: 56, height: 37.17 });
      expect(l.rivers.right.badgeRect).toEqual({ left: 884.67, top: 528.67, width: 56, height: 37.17 });
    }
  });

  it('16→17 张：上/下河换成 12 列，侧河块 x 一次性跳变（I10）', () => {
    const mk = (topN: number, selfN: number) =>
      input({ top: seat(topN), left: seat(8), right: seat(8), self: seat(selfN) });
    const at16 = mahjongTableLayoutV3(1334, 750, mk(16, 16));
    const at17 = mahjongTableLayoutV3(1334, 750, mk(17, 17));
    expect(at16.rects.topRiver.width).toBeCloseTo(311.35, 2);
    expect(at17.rects.topRiver.width).toBeCloseTo(468.02, 2);
    expect(at16.rects.leftRiver.left).toBeCloseTo(393.33, 2);
    expect(at17.rects.leftRiver.left).toBeCloseTo(314.99, 2);
    expect(at16.rects.rightRiver.left).toBeCloseTo(826.67, 2);
    expect(at17.rects.rightRiver.left).toBeCloseTo(905.01, 2);
    expect(at16.rects.leftRiver.left - at17.rects.leftRiver.left).toBeCloseTo(78.34, 2);
    expect(at17.rects.rightRiver.left - at16.rects.rightRiver.left).toBeCloseTo(78.34, 2);
    // 只需上家或自家任一 ≥17 即触发（块 x 取 min/max）
    for (const [tn, sn] of [
      [17, 0],
      [0, 17],
      [17, 16],
      [16, 17],
    ] as const) {
      const l = mahjongTableLayoutV3(1334, 750, mk(tn, sn));
      expect(l.rects.leftRiver.left).toBeCloseTo(314.99, 2);
      expect(l.rects.rightRiver.left).toBeCloseTo(905.01, 2);
    }
  });

  it('侧河亮牌：revealedCount 直通，无窗口/徽标，sideTop 下移 16（I2）', () => {
    const l = mahjongTableLayoutV3(1334, 750, STATES.revealed);
    for (const side of ['left', 'right'] as const) {
      const r = l.rivers[side];
      expect(r.raw).toBe(14);
      expect(r.visible).toBe(14);
      expect(r.overflow).toBe(0);
      expect(r.revealed).toBe(true);
      expect(r.cols).toBe(2);
      expect(r.rows).toBe(7);
      expect(r.windowCount).toBe(14);
      expect(r.badgeCount).toBe(0);
      expect(r.badgeRect).toBeNull();
      expect(r.rect.height).toBeCloseTo(272.18, 2);
      expect(r.rect.top).toBeCloseTo(242.91, 2);
    }
    expect(l.rects.leftBacks.top).toBe(144);
    expect(l.rects.leftBacks.height).toBeCloseTo(331.71, 2);
    const plain = mahjongTableLayoutV3(1334, 750, EMPTY);
    expect(plain.rects.leftBacks.top).toBe(128);
  });

  it('revealedCount>20 仍不产生窗口/徽标（控制器决定 2）', () => {
    const l = mahjongTableLayoutV3(1334, 750, input({ left: seat(0, [], 24) }));
    const r = l.rivers.left;
    expect(r.raw).toBe(24);
    expect(r.visible).toBe(24);
    expect(r.overflow).toBe(0);
    expect(r.windowCount).toBe(24);
    expect(r.badgeCount).toBe(0);
    expect(r.badgeRect).toBeNull();
    expect(r.rows).toBe(10);
    expect(l.checks).toEqual([]);
  });
});

describe('mahjongTableLayoutV3：听牌 30×45 / 2×5', () => {
  it('0 张 → rect 0×0、cols=0、rows=0', () => {
    const l = mahjongTableLayoutV3(1334, 750, input({ ting: 0 }));
    expect(l.ting.rect).toEqual({ left: 0, top: 0, width: 0, height: 0 });
    expect(l.ting.cols).toBe(0);
    expect(l.ting.rows).toBe(0);
    expect(l.ting.tile).toEqual({ w: 30, h: 45 });
    expect(l.rects.ting).toEqual(l.ting.rect);
  });

  it('1/5 张 → 1 行；6/9 张 → 2 行（C1/C2）', () => {
    const t1 = mahjongTableLayoutV3(1334, 750, input({ ting: 1 }));
    expect(t1.ting.rect).toEqual({ left: 146.23, top: 534.5, width: 30, height: 45 });
    expect(t1.ting.cols).toBe(1);
    expect(t1.ting.rows).toBe(1);

    const t5 = mahjongTableLayoutV3(1334, 750, input({ ting: 5 }));
    expect(t5.ting.rect).toEqual({ left: 146.23, top: 534.5, width: 158, height: 45 });
    expect(t5.ting.cols).toBe(5);
    expect(t5.ting.rows).toBe(1);

    const t6 = mahjongTableLayoutV3(1334, 750, input({ ting: 6 }));
    expect(t6.ting.rect).toEqual({ left: 146.23, top: 511, width: 158, height: 92 });
    expect(t6.ting.cols).toBe(5);
    expect(t6.ting.rows).toBe(2);

    const t9 = mahjongTableLayoutV3(1334, 750, input({ ting: 9 }));
    expect(t9.ting.rect).toEqual({ left: 146.23, top: 511, width: 158, height: 92 });
    expect(t9.ting.cols).toBe(5);
    expect(t9.ting.rows).toBe(2);
  });

  it('normal + ting:9 → (146.23, 511, 158, 92)；heavy/mid x=146.23', () => {
    const normal9 = mahjongTableLayoutV3(1334, 750, input({ ting: 9 }));
    expect(normal9.ting.rect).toEqual({ left: 146.23, top: 511, width: 158, height: 92 });

    const heavy = mahjongTableLayoutV3(1334, 750, STATES.heavy);
    expect(heavy.ting.rect.left).toBeCloseTo(146.23, 2);
    expect(heavy.ting.rect.top).toBeCloseTo(511, 2);

    const mid = mahjongTableLayoutV3(1334, 750, STATES.mid);
    expect(mid.ting.rect.left).toBeCloseTo(146.23, 2);
    expect(mid.ting.rect.top).toBeCloseTo(462.2, 2);
    expect(mid.ting.rect.width).toBe(158);
    expect(mid.ting.rect.height).toBe(92);
  });

  it('左侧副露不再影响听牌 x；与自家河/左侧河间隙', () => {
    const l = mahjongTableLayoutV3(
      1334,
      750,
      input({ top: seat(17), left: seat(8, groups(1)), right: seat(8), self: seat(8), ting: 9 }),
    );
    expect(l.rects.leftMelds.width).toBeCloseTo(40.4, 2);
    expect(l.ting.rect.left).toBeCloseTo(146.23, 2);
    const gap = l.rects.ownRiver.left - (l.ting.rect.left + l.ting.rect.width);
    // 8 列 fixture（实际 207.10）；v19 基线见下方 12 列 ≥120 用例
    expect(gap).toBeGreaterThanOrEqual(180);
    // 与侧河块不相交
    expect(l.ting.rect.left + l.ting.rect.width).toBeLessThan(l.rects.leftRiver.left);
  });

  it('听牌贴手牌行左缘；12 列自家河间隙 ≥120；左侧河最坏 10.76', () => {
    const normal = mahjongTableLayoutV3(1334, 750, input({ ting: 9 }));
    expect(normal.ting.rect.left).toBe(normal.rects.hand.left);

    const wide = mahjongTableLayoutV3(
      1334,
      750,
      input({ top: seat(8), left: seat(8), self: seat(17), ting: 9 }),
    );
    const gap12 = wide.rects.ownRiver.left - (wide.ting.rect.left + wide.ting.rect.width);
    expect(gap12).toBeCloseTo(128.76, 1);
    expect(gap12).toBeGreaterThanOrEqual(120);
    expect(wide.ting.rect.left + wide.ting.rect.width).toBeLessThan(wide.rects.leftRiver.left);

    const worst = mahjongTableLayoutV3(1334, 750, STATES.overlayWorst);
    const gapLeft = worst.rects.leftRiver.left - (worst.ting.rect.left + worst.ting.rect.width);
    expect(gapLeft).toBeCloseTo(10.76, 1);

    const mid = mahjongTableLayoutV3(1334, 750, STATES.mid);
    expect(mid.ting.rect.left).toBe(mid.rects.hand.left);

    const heavy = mahjongTableLayoutV3(1334, 750, STATES.heavy);
    expect(heavy.ting.rect.left).toBe(heavy.rects.hand.left);
  });

  it('听牌 rect 与 rects.ting 一致；无副露时 x 不随上家弃牌变化', () => {
    const a = mahjongTableLayoutV3(1334, 750, input({ ting: 9 }));
    const b = mahjongTableLayoutV3(1334, 750, input({ top: seat(29, groups(4)), right: seat(29), ting: 9 }));
    expect(a.rects.ting).toEqual(a.ting.rect);
    expect(b.ting.rect.left).toBeCloseTo(146.23, 2);
    expect(b.ting.rect.top).toBeCloseTo(511, 2);
  });
});

describe('mahjongTableLayoutV3：副露 / 坐标帧 / 窗口字段', () => {
  it('侧副露：lane 在外缘、已缩放尺寸 ≈36.4×29.71、meldRect 为画布坐标', () => {
    const l = mahjongTableLayoutV3(1334, 750, STATES.mid);
    const r = l.rivers.left;
    expect(r.meld.tileW).toBe(36.4);
    expect(r.meld.tileH).toBeCloseTo(29.71, 2);
    expect(r.meld.scale).toBe(0.65);
    expect(r.meld.overlap).toBe(4);
    expect(r.meld.groupGap).toBe(8);
    expect(r.meld.contentW).toBeCloseTo(81.14, 2);
    expect(r.laneWidth).toBeCloseTo(40.4, 2);
    expect(r.meldRect).toEqual(l.rects.leftMelds);
    expect(l.rects.leftMelds).toEqual({ left: 46.34, top: 330.43, width: 40.4, height: 81.14 });
    // meldRect 是画布坐标：相对河块局部 x 为负（I14）
    expect(r.meldRect.left - r.rect.left).toBeLessThan(0);
  });

  it('侧副露 0 弃牌：河块 0×0，meld 仍渲染（I14）', () => {
    const l = mahjongTableLayoutV3(1334, 750, input({ left: seat(0, groups(1)) }));
    expect(l.rivers.left.rect.width).toBe(0);
    expect(l.rivers.left.rect.height).toBe(0);
    expect(l.rivers.left.cols).toBe(0);
    expect(l.rivers.left.laneWidth).toBeCloseTo(40.4, 2);
    expect(l.rects.leftMelds.width).toBeCloseTo(40.4, 2);
    expect(l.rects.leftMelds.height).toBeCloseTo(81.14, 2);
    expect(l.rivers.left.meldRect).toEqual(l.rects.leftMelds);
  });

  it('2668×1500：badgeRect / meldRect 与河块同帧等比放大', () => {
    const l = mahjongTableLayoutV3(2668, 1500, {
      bySlot: {
        top: seat(12, groups(1)),
        left: seat(29, groups(1)),
        right: seat(29, groups(1)),
        self: seat(9, groups(1)),
      },
      tingCount: 9,
    });
    expect(l.u).toBe(2);
    expect(l.rivers.left.rect).toEqual({ left: 786.65, top: 352.32, width: 228, height: 779.36 });
    expect(l.rivers.right.rect).toEqual({ left: 1653.35, top: 352.32, width: 228, height: 779.36 });
    expect(l.rivers.left.badgeRect).toEqual({ left: 902.65, top: 1057.35, width: 112, height: 74.34 });
    expect(l.rects.leftMelds).toEqual({ left: 92.68, top: 660.86, width: 80.8, height: 162.28 });
    expect(l.rivers.left.meldRect).toEqual(l.rects.leftMelds);
    expect(l.ting.rect).toEqual({ left: 292.46, top: 924.4, width: 316, height: 184 });
    // 徽标/副露 rect 与河块同帧等比：x 关系保持
    expect(l.rivers.left.badgeRect!.left - l.rivers.left.rect.left).toBeCloseTo(58 * 2, 1);
    expect(l.checks).toEqual([]);
  });

  it('上/下河 16→17 列切换与 29 张 23+6 徽标（同 v2）', () => {
    const l = mahjongTableLayoutV3(1334, 750, input({ top: seat(29), self: seat(17) }));
    expect(l.rivers.top.cols).toBe(12);
    expect(l.rivers.top.rows).toBe(2);
    expect(l.rivers.top.windowCount).toBe(23);
    expect(l.rivers.top.windowStart).toBe(6);
    expect(l.rivers.top.badgeCount).toBe(6);
    expect(l.rivers.top.latestIndex).toBe(22);
    expect(l.rivers.top.badgeCell).toBe(23);
    expect(l.rects.topBadge).toBeDefined();
    expect(l.rivers.self.cols).toBe(12);
    expect(l.rivers.self.windowCount).toBe(17);
    expect(l.rivers.self.badgeCount).toBe(0);
    const t16 = mahjongTableLayoutV3(1334, 750, input({ top: seat(16) }));
    expect(t16.rivers.top.cols).toBe(8);
  });

  it('rivers / rects / hub / seatPlates / hand / back 对应一致', () => {
    const l = mahjongTableLayoutV3(1334, 750, STATES.mid);
    expect(l.rivers.top.rect).toEqual(l.rects.topRiver);
    expect(l.rivers.self.rect).toEqual(l.rects.ownRiver);
    expect(l.rivers.left.rect).toEqual(l.rects.leftRiver);
    expect(l.rivers.right.rect).toEqual(l.rects.rightRiver);
    expect(l.rivers.left.meldRect).toEqual(l.rects.leftMelds);
    expect(l.rivers.right.meldRect).toEqual(l.rects.rightMelds);
    expect(l.hub.rect).toEqual(l.rects.hub);
    expect(l.hub.left).toBe(l.hub.rect.left);
    expect(l.hub.top).toBe(l.hub.rect.top);
    expect(l.hub.width).toBe(l.hub.rect.width);
    expect(l.hub.height).toBe(l.hub.rect.height);
    expect(l.hub.cx).toBeCloseTo(l.hub.rect.left + l.hub.rect.width / 2, 6);
    expect(l.seatPlates.top).toEqual(l.rects.topPlate);
    expect(l.seatPlates.left).toEqual(l.rects.leftPlate);
    expect(l.seatPlates.right).toEqual(l.rects.rightPlate);
    expect(l.seatPlates.self).toEqual(l.rects.selfPlate);
    expect(l.hand.rect).toEqual(l.rects.hand);
    expect(l.actions).toEqual(l.rects.actions);
    expect(l.ting.rect).toEqual(l.rects.ting);
    expect(l.backs.top.rect).toEqual(l.rects.topBacks);
    expect(l.backs.left.rect).toEqual(l.rects.leftBacks);
    expect(l.backs.right.rect).toEqual(l.rects.rightBacks);
  });

  it('上副露 / 自己副露形状：4 组 348.81、杠组 451.75', () => {
    const top4 = mahjongTableLayoutV3(1334, 750, input({ top: seat(0, groups(4)) }));
    expect(top4.topMeld.contentW).toBeCloseTo(348.81, 2);
    expect(top4.topMeld.scale).toBe(1);
    expect(top4.topMeld.tile).toEqual({ w: 29.73, h: 44.8 });
    expect(top4.rivers.top.meld.scale).toBe(top4.topMeld.scale);
    expect(top4.rivers.top.meld.contentW).toBeCloseTo(top4.topMeld.contentW, 6);
    expect(top4.rects.topMeld).toEqual({ left: 492.59, top: 118, width: 348.81, height: 44.8 });

    const sg = mahjongTableLayoutV3(1334, 750, STATES.selfFourGang);
    expect(sg.rivers.self.meld.contentW).toBeCloseTo(451.75, 2);
    expect(sg.rects.selfMeld.width).toBeCloseTo(451.75, 2);
    expect(sg.rects.selfMeld.top).toBe(569.2);
  });

  it('最紧间隙：右侧河底 565.84 vs 自己副露顶 569.2 → 3.36px 正间隙（I11）', () => {
    const l = mahjongTableLayoutV3(1334, 750, STATES.selfFourGang);
    const leftBottom = l.rects.leftRiver.top + l.rects.leftRiver.height;
    const rightBottom = l.rects.rightRiver.top + l.rects.rightRiver.height;
    expect(leftBottom).toBeCloseTo(448.33, 2);
    expect(rightBottom).toBeCloseTo(565.84, 2);
    expect(l.rects.selfMeld.top).toBe(569.2);
    expect(l.rects.selfMeld.top - leftBottom).toBeCloseTo(120.87, 2);
    expect(l.rects.selfMeld.top - rightBottom).toBeCloseTo(3.36, 2);
  });

  it('上副露 × 侧河 / 侧区：正间隙（I11）', () => {
    const heavy = mahjongTableLayoutV3(1334, 750, STATES.heavy);
    const topMeldBottom = heavy.rects.topMeld.top + heavy.rects.topMeld.height;
    expect(heavy.rects.leftRiver.top).toBeGreaterThan(topMeldBottom);
    expect(heavy.rects.rightRiver.top).toBeGreaterThan(topMeldBottom);
    const wide = mahjongTableLayoutV3(
      1334,
      750,
      input({ top: seat(29, [4, 4, 4, 4]), left: seat(29, groups(1)), right: seat(29), ting: 9 }),
    );
    const wideBottom = wide.rects.topMeld.top + wide.rects.topMeld.height;
    expect(wide.rects.leftRiver.top).toBeGreaterThan(wideBottom);
    expect(wide.rects.rightRiver.top).toBeGreaterThan(wideBottom);
    expect(wide.checks).toEqual([]);
  });
});

describe('mahjongTableLayoutV3：防御与输入不变', () => {
  it('非法 W/H 逐项回落基座、负弃牌归零', () => {
    const cases: Array<{ w: number; h: number; u: number }> = [
      { w: 0, h: 0, u: 1 },
      { w: -1, h: 100, u: 100 / 750 },
      { w: Number.NaN, h: 750, u: 1 },
      { w: 1334, h: Number.POSITIVE_INFINITY, u: 1 },
    ];
    for (const c of cases) {
      const l = mahjongTableLayoutV3(c.w, c.h, input({ self: seat(-3, [Number.NaN]), ting: -2 }));
      expect(Number.isFinite(l.u)).toBe(true);
      expect(l.u).toBeCloseTo(c.u, 10);
      expect(l.rivers.self.raw).toBe(0);
      expect(l.ting.cols).toBe(0);
      expect(l.ting.rows).toBe(0);
    }
  });

  it('不修改输入对象', () => {
    const inp = input({
      self: seat(3, [3, 4]),
      top: seat(1),
      left: seat(2),
      right: seat(0),
      ting: 5,
    });
    const before = JSON.stringify(inp);
    mahjongTableLayoutV3(1334, 750, inp);
    expect(JSON.stringify(inp)).toBe(before);
  });

  it('副露按组尺寸直传并 3/4 夹取、最多 4 组（[5,2,3,3,4] → 4 组 3,4,3,3）', () => {
    const l = mahjongTableLayoutV3(1334, 750, input({ self: { discards: 0, melds: [5, 2, 3, 3, 4] } }));
    // 5→4、2→3、3→3、3→3；第 5 组被丢弃
    expect(l.rivers.self.meld.contentW).toBeCloseTo(374.55, 2);
    expect(l.rivers.self.meldRect.width).toBeCloseTo(374.55, 2);
  });
});

describe('MAHJONG_TABLE_TOKENS_V3', () => {
  it('v15 关键几何 token', () => {
    expect(MAHJONG_TABLE_TOKENS_V3.tingW).toBe(30);
    expect(MAHJONG_TABLE_TOKENS_V3.tingH).toBe(45);
    expect(MAHJONG_TABLE_TOKENS_V3.tingPerRow).toBe(5);
    expect(MAHJONG_TABLE_TOKENS_V3.tingMax).toBe(9);
    expect(MAHJONG_TABLE_TOKENS_V3.sideCols).toBe(2);
    expect(MAHJONG_TABLE_TOKENS_V3.sideRowsMax).toBe(10);
    expect(MAHJONG_TABLE_TOKENS_V3.sideVisibleCap).toBe(20);
    expect(MAHJONG_TABLE_TOKENS_V3.sideRiverTileW).toBe(56);
    expect(MAHJONG_TABLE_TOKENS_V3.sideRiverTileH).toBeCloseTo(37.168, 3);
    expect(MAHJONG_TABLE_TOKENS_V3.displayCap).toBe(24);
  });
});

describe('v17 动作带几何守护（218 宽）', () => {
  it('最坏态：动作带左缘比右侧河右缘至少多 6px', () => {
    const l = mahjongTableLayoutV3(1334, 750, {
      bySlot: {
        top: { discards: 17, melds: [] },
        left: { discards: 0, melds: [] },
        right: { discards: 29, melds: [3, 3, 3, 3] },
        self: { discards: 17, melds: [] },
      },
      tingCount: 0,
    });
    const actionRight = l.actions.left + l.actions.width;
    const barLeft = actionRight - 218;
    const sideRiverRight = l.rivers.right.rect.left + l.rivers.right.rect.width;
    // fixture 自证是最坏态：动作区左缘、右河 2 列宽、19+N 窗口
    expect(l.actions.left).toBeCloseTo(1067.26, 2);
    expect(l.rivers.right.rect.width).toBe(114);
    expect(l.rivers.right.windowCount).toBe(19);
    expect(barLeft - sideRiverRight).toBeCloseTo(6.25, 1);
    expect(barLeft - sideRiverRight).toBeGreaterThanOrEqual(6);
    expect(l.actions.width).toBe(176);
  });
});

import { describe, it, expect } from 'vitest';
import { mahjongTableLayoutV2 } from '../src/game/mahjong-layout-v2';

const EMPTY = { bySlot: { self: { discards: 0, melds: [] }, top: { discards: 0, melds: [] }, left: { discards: 0, melds: [] }, right: { discards: 0, melds: [] } }, phase: 'play' as const, tingCount: 0 };
const rects = (l: any) =>
  Object.values(l.rects as Record<string, { left: number; top: number; width: number; height: number }>).filter(
    (r) => r.width > 0 && r.height > 0,
  );

describe('mahjongTableLayoutV2', () => {
  it('base 1334×750 的关键锚点', () => {
    const l = mahjongTableLayoutV2(1334, 750, EMPTY);
    expect(l.rects.hand).toEqual({ left: 146.23, top: 630, width: 1041.54, height: 108 });
    expect(l.rects.bar).toEqual({ left: 0, top: 0, width: 1334, height: 64 });
    expect(l.rects.topRiver.left).toBeCloseTo(511.33, 1);
    expect(l.hub.r).toBeCloseTo(100, 1);
  });

  it('七档只改 offset；u=1', () => {
    const base = mahjongTableLayoutV2(1334, 750, EMPTY);
    for (const [w,h] of [[1500,750],[1623,750],[1778,750],[1334,833],[1334,1000],[1334,1334]]) {
      const l = mahjongTableLayoutV2(w,h,EMPTY);
      expect(l.u).toBe(1);
      expect(l.rects.hand.left).toBeCloseTo(base.rects.hand.left + (w-1334)/2, 1);
      expect(l.rects.hand.top).toBeCloseTo(base.rects.hand.top + (h-750)/2, 1);
    }
  });

  it('2668×1500 u=2', () => {
    const l = mahjongTableLayoutV2(2668, 1500, EMPTY);
    expect(l.u).toBe(2);
    expect(l.rects.hand.width).toBeCloseTo(2083.08, 1);
    expect(l.rects.hand.left).toBeCloseTo(146.23*2, 1);
  });

  it('侧河 ≤12 张 1 列，>12 张多列', () => {
    const one = mahjongTableLayoutV2(1334, 750, { ...EMPTY, bySlot: { ...EMPTY.bySlot, left: { discards: 8, melds: [] } } });
    expect(one.rivers.left.cols).toBe(1);
    const two = mahjongTableLayoutV2(1334, 750, { ...EMPTY, bySlot: { ...EMPTY.bySlot, left: { discards: 13, melds: [] } } });
    expect(two.rivers.left.cols).toBe(2);
    const many = mahjongTableLayoutV2(1334, 750, { ...EMPTY, bySlot: { ...EMPTY.bySlot, left: { discards: 24, melds: [] } } });
    expect(many.rivers.left.cols).toBe(3);
  });

  it('所有 rect 在画布内且互不相交（base 最坏态）', () => {
    const worst = { bySlot: { self: { discards: 24, melds: [] }, top: { discards: 24, melds: [] }, left: { discards: 24, melds: [3,3,3,3] }, right: { discards: 24, melds: [4,4,4,4] } }, phase: 'claim' as const, tingCount: 9 };
    const l = mahjongTableLayoutV2(1334, 750, worst);
    const rs = rects(l);
    for (const r of rs) { expect(r.left).toBeGreaterThanOrEqual(0); expect(r.top).toBeGreaterThanOrEqual(0); expect(r.left + r.width).toBeLessThanOrEqual(1334.01); expect(r.top + r.height).toBeLessThanOrEqual(750.01); }
  });
});

describe('mahjongTableLayoutV2：扩展形状与窗口字段', () => {
  it('bannerAnchors 基座位置（1334×750）', () => {
    const l = mahjongTableLayoutV2(1334, 750, EMPTY);
    expect(l.bannerAnchors.top).toEqual({ x: 667, y: 60 });
    expect(l.bannerAnchors.self).toEqual({ x: 667, y: 630 });
    expect(l.bannerAnchors.left).toEqual({ x: 92, y: 96 });
    expect(l.bannerAnchors.right).toEqual({ x: 1242, y: 96 });
  });

  it('backs / topMeld 形状', () => {
    const four = { ...EMPTY, bySlot: { ...EMPTY.bySlot, top: { discards: 0, melds: [3,3,3,3] } } };
    const l = mahjongTableLayoutV2(1334, 750, four);
    expect(l.backs.top.tile).toEqual({ w: 30.53, h: 46 });
    expect(l.backs.top.gap).toBe(2);
    expect(l.backs.left.pitch).toBe(22);
    expect(l.backs.left.tile).toEqual({ w: 30.34, h: 45.71 });
    expect(l.topMeld.contentW).toBeCloseTo(348.81, 1);
    expect(l.topMeld.scale).toBe(1);
    expect(l.topMeld.tile).toEqual({ w: 29.73, h: 44.8 });
    expect(l.rivers.top.meld.scale).toBe(l.topMeld.scale);
    expect(l.rivers.top.meld.contentW).toBeCloseTo(l.topMeld.contentW, 6);
  });

  it('侧河窗口字段：25 张 → 24 窗口 + 1 徽标', () => {
    const l = mahjongTableLayoutV2(1334, 750, { ...EMPTY, bySlot: { ...EMPTY.bySlot, left: { discards: 25, melds: [] } } });
    const r = l.rivers.left;
    expect(r.cols).toBe(3);
    expect(r.rows).toBe(10);
    expect(r.visible).toBe(24);
    expect(r.overflow).toBe(1);
    expect(r.windowCount).toBe(24);
    expect(r.windowStart).toBe(1);
    expect(r.badgeCount).toBe(1);
    expect(r.latestIndex).toBe(23);
    expect(r.badgeCell).toBe(24);
    expect(r.badgeRect).not.toBeNull();
    expect(l.rects.leftBadge).toBeDefined();
  });

  it('上下河窗口字段：29 张 → 23 窗口 + 6 徽标', () => {
    const l = mahjongTableLayoutV2(1334, 750, { ...EMPTY, bySlot: { ...EMPTY.bySlot, top: { discards: 29, melds: [] } } });
    const r = l.rivers.top;
    expect(r.cols).toBe(12);
    expect(r.rows).toBe(2);
    expect(r.windowCount).toBe(23);
    expect(r.windowStart).toBe(6);
    expect(r.badgeCount).toBe(6);
    expect(r.latestIndex).toBe(22);
    expect(r.badgeCell).toBe(23);
    expect(l.rects.topBadge).toBeDefined();
  });

  it('副露按组尺寸直传并按 3/4 夹取、最多 4 组', () => {
    const l = mahjongTableLayoutV2(1334, 750, { ...EMPTY, bySlot: { ...EMPTY.bySlot, self: { discards: 0, melds: [5, 2, 3, 3, 4] } } });
    // 5→4、2→3、3→3、3→3；第 5 组被丢弃
    expect(l.rivers.self.meld.contentW).toBeCloseTo(374.55, 1);
    expect(l.rivers.self.meldRect.width).toBeCloseTo(374.55, 1);
  });

  it('revealedCount 直通侧河且不产生溢出', () => {
    const l = mahjongTableLayoutV2(1334, 750, { ...EMPTY, bySlot: { ...EMPTY.bySlot, left: { discards: 5, melds: [], revealedCount: 14 } } });
    const r = l.rivers.left;
    expect(r.raw).toBe(14);
    expect(r.visible).toBe(14);
    expect(r.overflow).toBe(0);
    expect(r.revealed).toBe(true);
    expect(r.windowCount).toBe(14);
  });

  it('rivers/rects/hub/seatPlates 对应一致', () => {
    const l = mahjongTableLayoutV2(1334, 750, EMPTY);
    expect(l.rivers.top.rect).toEqual(l.rects.topRiver);
    expect(l.rivers.self.rect).toEqual(l.rects.ownRiver);
    expect(l.rivers.left.rect).toEqual(l.rects.leftRiver);
    expect(l.rivers.right.rect).toEqual(l.rects.rightRiver);
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
    expect(l.ting).toEqual(l.rects.ting);
  });

  it('非法输入防御：W/H 逐项回落基座、负弃牌归零', () => {
    const cases: Array<{ w: number; h: number; u: number }> = [
      { w: 0, h: 0, u: 1 },
      { w: -1, h: 100, u: 100 / 750 },
      { w: Number.NaN, h: 750, u: 1 },
      { w: 1334, h: Number.POSITIVE_INFINITY, u: 1 },
    ];
    for (const c of cases) {
      const l = mahjongTableLayoutV2(c.w, c.h, { ...EMPTY, bySlot: { ...EMPTY.bySlot, self: { discards: -3, melds: [Number.NaN] } } });
      expect(Number.isFinite(l.u)).toBe(true);
      expect(l.u).toBeCloseTo(c.u, 10);
      expect(l.rivers.self.raw).toBe(0);
    }
  });

  it('不修改输入对象', () => {
    const input = { bySlot: { self: { discards: 3, melds: [3, 4] }, top: { discards: 1, melds: [] }, left: { discards: 2, melds: [] }, right: { discards: 0, melds: [] } }, phase: 'claim' as const, tingCount: 5 };
    const before = JSON.stringify(input);
    mahjongTableLayoutV2(1334, 750, input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

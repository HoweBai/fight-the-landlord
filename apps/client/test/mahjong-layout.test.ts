import { describe, expect, it } from 'vitest';
import {
  mahjongTableLayout,
  MAHJONG_TABLE_TOKENS as T,
  type MahjongTableInput,
  type MahjongTableLayout,
  type Rect,
  type RiverLayout,
  type TileSize,
} from '../src/game/mahjong-layout';

const VIEWPORTS = [
  { name: '16:9', w: 1334, h: 750 },
  { name: '19.5:9', w: 1623, h: 750 },
  { name: '21:9', w: 1778, h: 750 },
  { name: '16:10', w: 1334, h: 833 },
  { name: '4:3', w: 1334, h: 1000 },
  { name: 'square', w: 1334, h: 1334 },
  { name: '1500x750', w: 1500, h: 750 },
] as const;

const EMPTY: MahjongTableInput = {
  top: { discards: 0, melds: 0 },
  left: { discards: 0, melds: 0 },
  right: { discards: 0, melds: 0 },
  self: { discards: 0, melds: 0 },
};

const WORST: MahjongTableInput = {
  top: { discards: 30, melds: 1 },
  left: { discards: 30, melds: 4 },
  right: { discards: 30, melds: 4 },
  self: { discards: 30, melds: 1 },
};

function everyRect(l: MahjongTableLayout): Rect[] {
  return [
    l.bar,
    l.topZone,
    l.leftZone,
    l.rightZone,
    l.centerZone,
    l.centerCard,
    l.hand.rect,
    l.ownRiver.rect,
    l.topRiver.rect,
    l.leftRiver.rect,
    l.rightRiver.rect,
    l.topBacks.rect,
    l.leftBacks.rect,
    l.rightBacks.rect,
    l.selfChip,
    l.leftChip,
    l.rightChip,
  ];
}

function expectInCanvas(r: Rect, w: number, h: number): void {
  for (const v of [r.left, r.top, r.width, r.height]) {
    expect(Number.isFinite(v), `rect field must be finite: ${JSON.stringify(r)}`).toBe(true);
  }
  expect(r.width, 'rect width').toBeGreaterThanOrEqual(0);
  expect(r.height, 'rect height').toBeGreaterThanOrEqual(0);
  expect(r.left, 'rect left').toBeGreaterThanOrEqual(-0.01);
  expect(r.top, 'rect top').toBeGreaterThanOrEqual(-0.01);
  expect(r.left + r.width, 'rect right').toBeLessThanOrEqual(w + 0.01);
  expect(r.top + r.height, 'rect bottom').toBeLessThanOrEqual(h + 0.01);
}

function expectInside(inner: Rect, outer: Rect): void {
  expect(inner.left).toBeGreaterThanOrEqual(outer.left - 0.01);
  expect(inner.top).toBeGreaterThanOrEqual(outer.top - 0.01);
  expect(inner.left + inner.width).toBeLessThanOrEqual(outer.left + outer.width + 0.01);
  expect(inner.top + inner.height).toBeLessThanOrEqual(outer.top + outer.height + 0.01);
}

function expectGridFits(r: RiverLayout): void {
  const gridW = r.cols * r.tile.w + (r.cols - 1) * r.gap;
  const gridH = r.rows * r.tile.h + (r.rows - 1) * r.gap;
  expect(gridW).toBeLessThanOrEqual(r.rect.width + 0.01);
  expect(gridH).toBeLessThanOrEqual(r.rect.height + 0.01);
}

function expectAspect(t: TileSize, ratio: number): void {
  expect(t.w / t.h).toBeCloseTo(ratio, 6);
}

function expectNoOverlap(a: Rect, b: Rect): void {
  const separated =
    a.left + a.width <= b.left + 0.01 ||
    b.left + b.width <= a.left + 0.01 ||
    a.top + a.height <= b.top + 0.01 ||
    b.top + b.height <= a.top + 0.01;
  expect(separated, `${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`).toBe(true);
}

describe('mahjongTableLayout：跨设备矩阵', () => {
  for (const v of VIEWPORTS) {
    describe(v.name, () => {
      const l = mahjongTableLayout(v.w, v.h, WORST);
      const expectedS = Math.min(v.h / 750, (0.88 * v.w) / 1041.5398230088495);

      it('s 公式钉死', () => {
        expect(l.s).toBeGreaterThanOrEqual(1);
        expect(l.s).toBeCloseTo(expectedS, 6);
      });

      it('手牌比例/贴底钉死', () => {
        expect(l.hand.rect.width / v.w).toBeCloseTo(
          Math.min(0.88, (1041.5398230088495 * (v.h / 750)) / v.w),
          3,
        );
        expect(l.hand.rect.top).toBeCloseTo(v.h - (12 + 108) * l.s, 3);
        expect(l.hand.rect.width).toBeLessThanOrEqual(v.w * 0.88 + 0.01);
      });

      it('中央井高钉死（全副露：top 290s / bottom 348s）', () => {
        expect(l.centerZone.height).toBeCloseTo(v.h - (64 + 290 + 348) * l.s, 3);
      });

      it('所有矩形在画布内', () => {
        for (const r of everyRect(l)) expectInCanvas(r, v.w, v.h);
      });

      it('左右家区不压自家牌河/手牌', () => {
        expect(l.leftZone.left + l.leftZone.width).toBeLessThanOrEqual(
          l.ownRiver.rect.left + 0.01,
        );
        expect(l.ownRiver.rect.left + l.ownRiver.rect.width).toBeLessThanOrEqual(
          l.rightZone.left + 0.01,
        );
        expect(l.leftZone.top + l.leftZone.height).toBeLessThanOrEqual(l.hand.rect.top + 0.01);
        expect(l.rightZone.top + l.rightZone.height).toBeLessThanOrEqual(l.hand.rect.top + 0.01);
        expectNoOverlap(l.leftZone, l.ownRiver.rect);
        expectNoOverlap(l.rightZone, l.ownRiver.rect);
        expectNoOverlap(l.selfChip, l.hand.rect);
      });

      it('自己卡不压手牌，动作浮层不压右家区', () => {
        expect(l.selfChip.left + l.selfChip.width).toBeLessThanOrEqual(l.hand.rect.left + 0.01);
        expect(l.actions.rightX).toBeLessThanOrEqual(l.rightZone.left + 0.01);
        expect(l.actions.rightOffset).toBeCloseTo(v.w - l.actions.rightX, 6);
        expect(l.actions.bottomY).toBeLessThanOrEqual(l.hand.rect.top + 0.01);
        expect(l.actions.bottomOffset).toBeCloseTo(v.h - l.actions.bottomY, 6);
      });

      it('中央卡在中央井内', () => {
        expect(l.centerZone.width).toBeGreaterThan(0);
        expect(l.centerZone.height).toBeGreaterThan(0);
        expectInside(l.centerCard, l.centerZone);
      });

      it('中央紧凑条件与井高一致', () => {
        expect(l.centerCompact).toBe(l.centerZone.height < 176 * l.s);
        if (v.h === 750 || v.name === '16:10') expect(l.centerCompact).toBe(true);
        if (v.name === '4:3' || v.name === 'square') expect(l.centerCompact).toBe(false);
        expect(l.centerZone.height).toBeGreaterThanOrEqual(40);
      });

      it('牌张比例正确', () => {
        expectAspect(l.hand.tile, 75 / 113);
        expectAspect(l.ownRiver.tile, 75 / 113);
        expectAspect(l.topRiver.tile, 75 / 113);
        expectAspect(l.leftRiver.tile, 49 / 40);
        expectAspect(l.topBacks.tile, 75 / 113);
        expectAspect(l.leftBacks.tile, 75 / 113);
      });

      it('牌河网格放得下', () => {
        for (const r of [l.ownRiver, l.topRiver, l.leftRiver, l.rightRiver]) expectGridFits(r);
      });

      it('副露条带在牌河的指定一侧', () => {
        expect(l.topRiver.meld.placement).toBe('above');
        expect(l.ownRiver.meld.placement).toBe('below');
        expect(l.leftRiver.meld.placement).toBe('below');
        expect(l.topRiver.meld.rect.top + l.topRiver.meld.height + l.topRiver.meld.gap).toBeCloseTo(
          l.topRiver.rect.top,
          3,
        );
        expect(l.ownRiver.meld.rect.top).toBeCloseTo(
          l.ownRiver.rect.top + l.ownRiver.rect.height + l.ownRiver.meld.gap,
          3,
        );
        expect(l.leftRiver.meld.rect.top).toBeCloseTo(
          l.leftRiver.rect.top + l.leftRiver.rect.height + l.leftRiver.meld.gap,
          3,
        );
      });

      it('侧区在可用竖向带居中', () => {
        expect(
          Math.abs(
            l.leftZone.top +
              l.leftZone.height / 2 -
              (l.centerZone.top + l.centerZone.height / 2),
          ),
        ).toBeLessThan(100 * l.s);
      });

      it('4 个杠组不超牌河宽', () => {
        const groupW = 4 * l.topRiver.meld.tile.w - 3 * l.topRiver.meld.overlap;
        expect(4 * groupW + 3 * l.topRiver.meld.gap).toBeLessThanOrEqual(
          l.topRiver.rect.width + 0.01,
        );
      });
    });
  }

  it('纯函数：同输入两次结果逐值相等', () => {
    expect(mahjongTableLayout(1623, 750, WORST)).toEqual(mahjongTableLayout(1623, 750, WORST));
  });

  it('1334×750 精确值（布局锚点）', () => {
    const l = mahjongTableLayout(1334, 750, EMPTY);

    expect(l.s).toBeCloseTo(1, 6);
    expect(l.bar).toEqual({ left: 0, top: 0, width: 1334, height: 64 });

    expect(l.topZone.left).toBeCloseTo(357.3274, 3);
    expect(l.topZone.top).toBeCloseTo(64, 3);
    expect(l.topZone.width).toBeCloseTo(619.3451, 3);
    expect(l.topZone.height).toBeCloseTo(222, 3);

    expect(l.topBacks.rect.top).toBeCloseTo(72, 3);
    expect(l.topBacks.rect.height).toBeCloseTo(54, 3);
    expect(l.topRiver.rect.top).toBeCloseTo(134, 3);
    expect(l.topRiver.rect.height).toBeCloseTo(152, 3);

    expect(l.centerZone.left).toBeCloseTo(208.8673, 3);
    expect(l.centerZone.top).toBeCloseTo(286, 3);
    expect(l.centerZone.width).toBeCloseTo(916.2654, 3);
    expect(l.centerZone.height).toBeCloseTo(184, 3);
    expect(l.centerCompact).toBe(false);
    expect(l.centerCard.width).toBeCloseTo(220, 3);
    expect(l.centerCard.height).toBeCloseTo(160, 3);

    expect(l.hand.rect.left).toBeCloseTo(146.2301, 3);
    expect(l.hand.rect.top).toBeCloseTo(630, 3);
    expect(l.hand.rect.width).toBeCloseTo(1041.5398, 3);
    expect(l.hand.rect.height).toBeCloseTo(108, 3);
    expect(l.hand.tile.w).toBeCloseTo(71.6814, 3);
    expect(l.hand.tile.h).toBeCloseTo(108, 3);
    expect(l.hand.gap).toBeCloseTo(2, 3);
    expect(l.hand.drawnGap).toBeCloseTo(12, 3);

    expect(l.ownRiver.rect.left).toBeCloseTo(357.3274, 3);
    expect(l.ownRiver.rect.top).toBeCloseTo(470, 3);
    expect(l.ownRiver.rect.width).toBeCloseTo(619.3451, 3);
    expect(l.ownRiver.rect.height).toBeCloseTo(152, 3);

    expect(l.leftZone.left).toBeCloseTo(0, 3);
    expect(l.leftZone.top).toBeCloseTo(128.5, 3);
    expect(l.leftZone.width).toBeCloseTo(200.8673, 3);
    expect(l.leftZone.height).toBeCloseTo(445, 3);
    expect(l.leftChip.left).toBeCloseTo(12, 3);
    expect(l.leftChip.top).toBeCloseTo(128.5, 3);
    expect(l.leftChip.width).toBeCloseTo(140, 3);
    expect(l.leftChip.height).toBeCloseTo(56, 3);
    expect(l.leftBacks.rect.left).toBeCloseTo(12, 3);
    expect(l.leftBacks.rect.top).toBeCloseTo(192.5, 3);
    expect(l.leftBacks.rect.width).toBeCloseTo(29.8673, 3);
    expect(l.leftBacks.rect.height).toBeCloseTo(381, 3);
    expect(l.leftRiver.rect.left).toBeCloseTo(49.8673, 3);
    expect(l.leftRiver.rect.top).toBeCloseTo(192.5, 3);
    expect(l.leftRiver.rect.width).toBeCloseTo(151, 3);
    expect(l.leftRiver.rect.height).toBeCloseTo(334, 3);

    expect(l.rightZone.left).toBeCloseTo(1133.1327, 3);
    expect(l.rightChip.left).toBeCloseTo(1182, 3);
    expect(l.rightBacks.rect.left).toBeCloseTo(1292.1327, 3);
    expect(l.rightRiver.rect.left).toBeCloseTo(1133.1327, 3);

    expect(l.selfChip.left).toBeCloseTo(12, 3);
    expect(l.selfChip.top).toBeCloseTo(646, 3);
    expect(l.selfChip.width).toBeCloseTo(56, 3);
    expect(l.selfChip.height).toBeCloseTo(76, 3);

    expect(l.actions.rightX).toBeCloseTo(1125.1327, 3);
    expect(l.actions.bottomY).toBeCloseTo(622, 3);
    expect(l.actions.rightOffset).toBeCloseTo(208.8673, 3);
    expect(l.actions.bottomOffset).toBeCloseTo(128, 3);
    expect(l.actions.maxWidth).toBeCloseTo(400, 3);
    expect(l.actions.minHeight).toBeCloseTo(80, 3);
    expect(l.barChip.w).toBeCloseTo(40, 3);
    expect(l.barChip.h).toBeCloseTo(56, 3);

    expect(l.centerTiles.claim.w).toBeCloseTo(34, 3);
    expect(l.centerTiles.claim.h).toBeCloseTo(51, 3);
    expect(l.centerTiles.ting.w).toBeCloseTo(20, 3);
    expect(l.centerTiles.ting.h).toBeCloseTo(30, 3);
  });

  it('全副露：中央井 48、牌河上移、侧区 522、副露条位置正确', () => {
    const l = mahjongTableLayout(1334, 750, WORST);
    expect(l.s).toBeCloseTo(1, 6);
    expect(l.topZone.height).toBeCloseTo(290, 3);
    expect(l.topRiver.rect.top).toBeCloseTo(202, 3);
    expect(l.ownRiver.rect.top).toBeCloseTo(402, 3);
    expect(l.centerZone.top).toBeCloseTo(354, 3);
    expect(l.centerZone.height).toBeCloseTo(48, 3);
    expect(l.centerCompact).toBe(true);
    expect(l.centerCard.height).toBeCloseTo(40, 3);
    expect(l.centerCard.width).toBeCloseTo(908.2655, 3);
    expect(l.leftZone.top).toBeCloseTo(90, 3);
    expect(l.leftZone.height).toBeCloseTo(522, 3);
    expect(l.leftRiver.rect.top).toBeCloseTo(154, 3);
    expect(l.leftRiver.meld.height).toBeCloseTo(116, 3);
    expect(l.leftRiver.meld.rect.top).toBeCloseTo(496, 3);
    expect(l.leftRiver.meld.rect.height).toBeCloseTo(116, 3);
    expect(l.topRiver.meld.height).toBeCloseTo(60, 3);
    expect(l.topRiver.meld.rect.top).toBeCloseTo(134, 3);
    expect(l.ownRiver.meld.rect.top).toBeCloseTo(562, 3);
    expect(l.topRiver.meld.placement).toBe('above');
    expect(l.ownRiver.meld.placement).toBe('below');
    expect(l.leftRiver.meld.placement).toBe('below');
    expect(l.topRiver.meld.rect.top + l.topRiver.meld.height + l.topRiver.meld.gap).toBeCloseTo(
      l.topRiver.rect.top,
      3,
    );
  });

  it('不传 input 不抛错，等价全 0；输入对象不被改写', () => {
    const bare = mahjongTableLayout(1334, 750);
    const empty = mahjongTableLayout(1334, 750, EMPTY);
    expect(bare).toEqual(empty);
    const frozen = Object.freeze({
      top: Object.freeze({ discards: 3, melds: 1 }),
      left: Object.freeze({ discards: 2, melds: 0 }),
      right: Object.freeze({ discards: 1, melds: 0 }),
      self: Object.freeze({ discards: 4, melds: 0 }),
    });
    expect(() => mahjongTableLayout(1334, 750, frozen)).not.toThrow();
  });

  it('30 张弃牌：压缩且网格放得下', () => {
    const l = mahjongTableLayout(1334, 750, WORST);
    expect(l.topRiver.fit).toBeLessThan(1);
    expect(l.ownRiver.fit).toBeLessThan(1);
    expect(l.leftRiver.fit).toBeLessThan(1);
    expect(l.topRiver.fit).toBeCloseTo(152 / 229, 3);
    expect(l.leftRiver.fit).toBeCloseTo(151 / 202, 3);
    expect(l.topRiver.cols).toBe(12);
    expect(l.topRiver.rows).toBe(3);
    expect(l.leftRiver.cols).toBe(4);
    expect(l.leftRiver.rows).toBe(8);
    for (const r of [l.topRiver, l.ownRiver, l.leftRiver, l.rightRiver]) expectGridFits(r);
  });

  it('24 张弃牌以内不压缩', () => {
    const l = mahjongTableLayout(1334, 750, {
      top: { discards: 24, melds: 0 },
      left: { discards: 24, melds: 0 },
      right: { discards: 24, melds: 0 },
      self: { discards: 24, melds: 0 },
    });
    expect(l.topRiver.fit).toBe(1);
    expect(l.ownRiver.fit).toBe(1);
    expect(l.leftRiver.fit).toBe(1);
    expect(l.topRiver.rows).toBe(2);
    expect(l.leftRiver.cols).toBe(3);
  });

  it('宽度兜底：4:3 手牌 ≤88% 且 s>1', () => {
    const l = mahjongTableLayout(1334, 1000, EMPTY);
    expect(l.s).toBeGreaterThan(1);
    expect(l.hand.rect.width).toBeLessThanOrEqual(1334 * 0.88 + 0.01);
    expect(l.selfChip.left + l.selfChip.width).toBeLessThanOrEqual(l.hand.rect.left + 0.01);
  });

  it('非法输入回落 16:9 尺寸，不产生 NaN', () => {
    for (const [w, h] of [
      [0, 0],
      [-1, 100],
      [Number.NaN, 750],
      [1334, Number.POSITIVE_INFINITY],
    ]) {
      const l = mahjongTableLayout(w, h, EMPTY);
      expect(Number.isFinite(l.s)).toBe(true);
      for (const r of everyRect(l)) {
        for (const v of [r.left, r.top, r.width, r.height]) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('token 表无多余扫描面（s=1 基准）', () => {
    expect(T.barH).toBe(64);
    expect(T.outer).toBe(12);
    expect(T.inner).toBe(8);
    expect(T.gap).toBe(2);
    expect(T.handH).toBe(108);
    expect(T.riverH).toBe(75);
    expect(T.topBackH).toBe(54);
    expect(T.sideBackH).toBe(45);
    expect(T.sideRiverW).toBe(49);
    expect(T.sideRiverH).toBe(40);
    expect(T.backCount).toBe(14);
    expect(T.chip).toBe(56);
  });
});

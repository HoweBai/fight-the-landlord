import { describe, expect, it } from 'vitest';
import {
  mahjongTableLayout,
  type LaneLayout,
  type MahjongTableInput,
  type MahjongTableLayout,
  type MeldStripLayout,
} from '../src/game/mahjong-layout';

/**
 * 中央牌板布局矩阵（2026-10-30 第二片）。
 *
 * 契约：牌板 = 左道 + 中间列 + 右道；中间列自上而下 = 对家牌河 / 信息格 / 自己牌河；
 * 信息格宽 = 中间列宽；左右道贯穿牌板全高（吃掉四角）。
 *
 * 数字来源：spec §4.2（算法跑出来的七档值），**逐视口字面量**，不用实现自身输出反推。
 */
const VIEWPORTS = [
  { name: '16:9', w: 1334, h: 750, mid: 12, side: 3, bandH: 488, infoH: 184, laneH: 152, topCap: 24, sideCap: 33 },
  { name: '19.5:9', w: 1623, h: 750, mid: 12, side: 3, bandH: 488, infoH: 184, laneH: 152, topCap: 24, sideCap: 33 },
  { name: '21:9', w: 1778, h: 750, mid: 12, side: 3, bandH: 488, infoH: 184, laneH: 152, topCap: 24, sideCap: 33 },
  { name: '1334x800', w: 1334, h: 800, mid: 12, side: 2, bandH: 520.5, infoH: 196.3, laneH: 162.1, topCap: 24, sideCap: 22 },
  { name: '16:10', w: 1334, h: 833, mid: 11, side: 2, bandH: 542, infoH: 204.4, laneH: 168.8, topCap: 22, sideCap: 22 },
  { name: '4:3', w: 1334, h: 1000, mid: 11, side: 2, bandH: 613.1, infoH: 270.5, laneH: 171.3, topCap: 22, sideCap: 26 },
  { name: 'square', w: 1334, h: 1334, mid: 11, side: 2, bandH: 960.3, infoH: 270.5, laneH: 344.9, topCap: 44, sideCap: 40 },
] as const;

const EMPTY: MahjongTableInput = {
  top: { discards: 0, melds: 0 },
  left: { discards: 0, melds: 0 },
  right: { discards: 0, melds: 0 },
  self: { discards: 0, melds: 0 },
};
const ONE: MahjongTableInput = {
  top: { discards: 14, melds: 1, gangMelds: 0 },
  left: { discards: 18, melds: 0, gangMelds: 0 },
  right: { discards: 16, melds: 0, gangMelds: 0 },
  self: { discards: 16, melds: 1, gangMelds: 0 },
};
const WORST: MahjongTableInput = {
  top: { discards: 30, melds: 4, gangMelds: 4 },
  left: { discards: 30, melds: 4, gangMelds: 4 },
  right: { discards: 30, melds: 4, gangMelds: 4 },
  self: { discards: 30, melds: 4, gangMelds: 4 },
};

function lanesOf(l: MahjongTableLayout): LaneLayout[] {
  return [l.topLane, l.bottomLane, l.leftLane, l.rightLane];
}
function stripsOf(l: MahjongTableLayout): MeldStripLayout[] {
  return [l.topMelds.left, l.topMelds.right, l.topMelds.below, l.leftMelds, l.rightMelds, l.selfMelds];
}

describe('中央牌板：跨设备矩阵', () => {
  for (const v of VIEWPORTS) {
    describe(v.name, () => {
      const l = mahjongTableLayout(v.w, v.h, EMPTY);
      const s = l.s;

      it('候选与列宽（用 token 独立重算）', () => {
        const tw = 75 * (75 / 113) * s;
        const stw = 49 * s;
        const g = 2 * s;
        const middleW = v.mid * tw + (v.mid - 1) * g;
        const sideLaneW = v.side * stw + (v.side - 1) * g;
        expect(l.topLane.rect.width).toBeCloseTo(middleW, 3);
        expect(l.leftLane.rect.width).toBeCloseTo(sideLaneW, 3);
        expect(l.board.width).toBeCloseTo(middleW + 2 * sideLaneW, 3);
        expect(l.board.left).toBeCloseTo((v.w - l.board.width) / 2, 3);
        expect(l.topLane.cols).toBe(v.mid);
        expect(l.leftLane.cols).toBe(v.side);
      });

      it('中间列中心 = 画面中心', () => {
        expect(l.topLane.rect.left + l.topLane.rect.width / 2).toBeCloseTo(v.w / 2, 3);
        expect(l.bottomLane.rect.left + l.bottomLane.rect.width / 2).toBeCloseTo(v.w / 2, 3);
      });

      it('信息格贴四边、宽度 = 中间列宽', () => {
        expect(l.info.top).toBeCloseTo(l.topLane.rect.top + l.topLane.rect.height, 3);
        expect(l.info.top + l.info.height).toBeCloseTo(l.bottomLane.rect.top, 3);
        expect(l.info.left).toBeCloseTo(l.leftLane.rect.left + l.leftLane.rect.width, 3);
        expect(l.info.left + l.info.width).toBeCloseTo(l.rightLane.rect.left, 3);
        expect(l.info.width).toBeCloseTo(l.topLane.rect.width, 3);
      });

      it('左右道贯穿牌板全高', () => {
        for (const lane of [l.leftLane, l.rightLane]) {
          expect(lane.rect.top).toBeCloseTo(l.board.top, 3);
          expect(lane.rect.height).toBeCloseTo(l.board.height, 3);
        }
      });

      it('容量逐视口字面量', () => {
        expect(l.topLane.cols * l.topLane.rows).toBe(v.topCap);
        expect(l.leftLane.cols * l.leftLane.rows).toBe(v.sideCap);
      });

      it('高度与档位', () => {
        expect(l.board.height).toBeCloseTo(v.bandH, 1);
        expect(l.info.height).toBeCloseTo(v.infoH, 1);
        expect(l.topLane.rect.height).toBeCloseTo(v.laneH, 1);
        expect(l.infoLevel).toBe('full');
      });

      it('待响应/听牌牌张尺寸随 s', () => {
        expect(l.infoTiles.claim.w).toBeCloseTo(34 * s, 4);
        expect(l.infoTiles.claim.h).toBeCloseTo(51 * s, 4);
        expect(l.infoTiles.ting.w).toBeCloseTo(20 * s, 4);
        expect(l.infoTiles.ting.h).toBeCloseTo(30 * s, 4);
      });

      it('fit 任何张数不溢出（0/12/24/30/48）', () => {
        for (const n of [0, 12, 24, 30, 48]) {
          const x = mahjongTableLayout(v.w, v.h, { top: { discards: n, melds: 0, gangMelds: 0 } });
          expect(x.topLane.fit).toBeGreaterThan(0);
          expect(x.topLane.fit).toBeLessThanOrEqual(1);
          if (n === 0) expect(x.topLane.fit).toBeCloseTo(1, 6);
          const neededRows = Math.max(1, Math.ceil(n / x.topLane.cols));
          const gridH = neededRows * x.topLane.tile.h + (neededRows - 1) * x.topLane.gap;
          expect(gridH, `n=${n} 高度`).toBeLessThanOrEqual(x.topLane.rect.height + 0.01);
          const gridW = x.topLane.cols * x.topLane.tile.w + (x.topLane.cols - 1) * x.topLane.gap;
          expect(gridW, `n=${n} 宽度`).toBeLessThanOrEqual(x.topLane.rect.width + 0.01);
        }
      });

      it('牌张比例', () => {
        expect(l.topLane.tile.w / l.topLane.tile.h).toBeCloseTo(75 / 113, 6);
        expect(l.leftLane.tile.w / l.leftLane.tile.h).toBeCloseTo(49 / 40, 6);
      });

      it('两侧牌背镜像紧邻侧道', () => {
        expect(l.leftBacks.rect.left + l.leftBacks.rect.width).toBeCloseTo(
          l.leftLane.rect.left - 8 * s,
          3,
        );
        expect(l.rightBacks.rect.left).toBeCloseTo(
          l.rightLane.rect.left + l.rightLane.rect.width + 8 * s,
          3,
        );
      });

      it('座位卡贴桌边或夹到牌背外侧、不压侧道、顶 = 牌板顶', () => {
        expect(l.leftChip.left).toBeGreaterThanOrEqual(12 * s - 0.01);
        expect(l.rightChip.left + 180 * s).toBeLessThanOrEqual(v.w - 12 * s + 0.01);
        expect(l.leftChip.left + 180 * s).toBeLessThanOrEqual(l.leftLane.rect.left + 0.01);
        expect(l.rightChip.left).toBeGreaterThanOrEqual(
          l.rightLane.rect.left + l.rightLane.rect.width - 0.01,
        );
        expect(l.leftChip.top).toBeCloseTo(l.board.top, 3);
        expect(l.rightChip.top).toBeCloseTo(l.board.top, 3);
      });

      it('所有矩形合法（EMPTY + WORST）', () => {
        for (const input of [EMPTY, WORST]) {
          const x = mahjongTableLayout(v.w, v.h, input);
          const rects = [
            x.bar, x.board, x.info,
            ...lanesOf(x).map((r) => r.rect),
            x.topBacks.rect, x.leftBacks.rect, x.rightBacks.rect,
            x.selfChip, x.leftChip, x.rightChip, x.hand.rect,
            ...stripsOf(x).map((r) => r.rect),
          ];
          for (const r of rects) {
            for (const val of [r.left, r.top, r.width, r.height]) {
              expect(Number.isFinite(val), JSON.stringify(r)).toBe(true);
            }
            expect(r.width).toBeGreaterThanOrEqual(0);
            expect(r.height).toBeGreaterThanOrEqual(0);
            expect(r.left).toBeGreaterThanOrEqual(-0.01);
            expect(r.top).toBeGreaterThanOrEqual(-0.01);
            expect(r.left + r.width).toBeLessThanOrEqual(v.w + 0.01);
            expect(r.top + r.height).toBeLessThanOrEqual(v.h + 0.01);
          }
        }
      });

      it('动作浮层不压右道', () => {
        expect(l.actions.rightX).toBeCloseTo(l.rightLane.rect.left, 3);
        expect(l.actions.bottomY).toBeCloseTo(l.hand.rect.top - 8 * s, 3);
        expect(l.actions.rightOffset).toBeCloseTo(v.w - l.rightLane.rect.left, 6);
        expect(l.actions.bottomOffset).toBeCloseTo(v.h - (l.hand.rect.top - 8 * s), 6);
      });
    });
  }

  it('对家+我各 1 碰：档位逐视口字面量', () => {
    const expected = ['dense', 'dense', 'dense', 'dense', 'dense', 'full', 'full'] as const;
    VIEWPORTS.forEach((v, i) => {
      expect(mahjongTableLayout(v.w, v.h, ONE).infoLevel, v.name).toBe(expected[i]);
    });
  });

  it('对家+我各 4 杠：档位与下移逐视口字面量', () => {
    const expected = ['dense', 'dense', 'dense', 'compact', 'compact', 'full', 'full'] as const;
    VIEWPORTS.forEach((v, i) => {
      expect(mahjongTableLayout(v.w, v.h, WORST).infoLevel, v.name).toBe(expected[i]);
    });
    expect(mahjongTableLayout(1334, 750, WORST).topMelds.below.groups).toBe(0);
    expect(mahjongTableLayout(1334, 833, WORST).topMelds.below.groups).toBe(4);
    expect(mahjongTableLayout(1334, 833, WORST).topMelds.below.rect.height).toBeCloseTo(
      48.75 * (833 / 750),
      3,
    );
    expect(mahjongTableLayout(1334, 833, WORST).board.top).toBeCloseTo(211.9, 1);
    expect(mahjongTableLayout(1334, 833, ONE).topMelds.below.groups).toBe(0);
  });

  it('16:9 精确锚点', () => {
    const l = mahjongTableLayout(1334, 750, EMPTY);
    expect(l.s).toBeCloseTo(1, 6);
    expect(l.board.left).toBeCloseTo(206.327, 3);
    expect(l.board.top).toBeCloseTo(134, 3);
    expect(l.board.width).toBeCloseTo(921.345, 3);
    expect(l.board.height).toBeCloseTo(488, 3);
    expect(l.info.left).toBeCloseTo(357.327, 3);
    expect(l.info.width).toBeCloseTo(619.345, 3);
    expect(l.info.height).toBeCloseTo(184, 3);
    expect(l.topLane.rect.left).toBeCloseTo(357.327, 3);
    expect(l.topLane.rect.width).toBeCloseTo(619.345, 3);
    expect(l.topLane.rect.height).toBeCloseTo(152, 3);
    expect(l.bottomLane.rect.top).toBeCloseTo(470, 3);
    expect(l.leftLane.rect.left).toBeCloseTo(206.327, 3);
    expect(l.leftLane.rect.width).toBeCloseTo(151, 3);
    expect(l.leftLane.rect.height).toBeCloseTo(488, 3);
    expect(l.actions.rightX).toBeCloseTo(976.673, 3);
    expect(l.topMelds.below.groups).toBe(0);
  });

  it('16:9 座位卡贴桌边；21:9 被夹到牌背外侧', () => {
    const wide = mahjongTableLayout(1334, 750, EMPTY);
    expect(wide.leftChip.left).toBeCloseTo(12, 3);
    expect(wide.rightChip.left).toBeCloseTo(1334 - 12 - 180, 3);
    const ultra = mahjongTableLayout(1778, 750, EMPTY);
    expect(ultra.leftChip.left).toBeCloseTo(ultra.leftBacks.rect.left - 180 - 8, 3);
    expect(ultra.rightChip.left).toBeCloseTo(
      ultra.rightBacks.rect.left + ultra.rightBacks.rect.width + 8,
      3,
    );
  });

  it('16:9 各 1 碰：信息格 127.25、牌板 431.25、对家副露在牌背两翼', () => {
    const l = mahjongTableLayout(1334, 750, ONE);
    expect(l.board.height).toBeCloseTo(431.25, 3);
    expect(l.info.height).toBeCloseTo(127.25, 3);
    expect(l.topMelds.below.groups).toBe(0);
    expect(l.topMelds.right.rect.left).toBeCloseTo(
      l.topBacks.rect.left + l.topBacks.rect.width + 8,
      3,
    );
    expect(l.topMelds.left.rect.left + l.topMelds.left.rect.width).toBeCloseTo(
      l.topBacks.rect.left - 8,
      3,
    );
    expect(l.selfMelds.rect.top).toBeCloseTo(750 - 120 - 8 - 48.75, 3);
  });

  it('左右副露用 49×40 资产：4 组高 116s、组宽 103.4s', () => {
    const l = mahjongTableLayout(1334, 750, WORST);
    expect(l.leftMelds.rect.height).toBeCloseTo(4 * 26 + 3 * 4, 3);
    expect(l.leftMelds.rect.width).toBeCloseTo(4 * (49 * 0.65) - 3 * 8, 3);
    expect(l.leftMelds.tile.h).toBeCloseTo(26, 3);
  });

  it('副露条不压牌河/信息格', () => {
    const l = mahjongTableLayout(1334, 750, WORST);
    expect(l.topMelds.left.rect.left + l.topMelds.left.rect.width).toBeLessThanOrEqual(
      l.topBacks.rect.left + 0.01,
    );
    expect(l.topMelds.right.rect.left).toBeGreaterThanOrEqual(
      l.topBacks.rect.left + l.topBacks.rect.width - 0.01,
    );
    expect(l.selfMelds.rect.top + l.selfMelds.rect.height).toBeLessThanOrEqual(
      l.hand.rect.top + 0.01,
    );
    expect(l.leftMelds.rect.left + l.leftMelds.rect.width).toBeLessThanOrEqual(
      l.leftLane.rect.left + 0.01,
    );
    expect(l.rightMelds.rect.left).toBeGreaterThanOrEqual(
      l.rightLane.rect.left + l.rightLane.rect.width - 0.01,
    );
  });

  it('纯函数性：不传 input 不抛、freeze 可算、两次相等', () => {
    expect(() => mahjongTableLayout(1334, 750)).not.toThrow();
    const frozen = Object.freeze({
      top: Object.freeze({ discards: 3, melds: 1, gangMelds: 1 }),
      left: Object.freeze({ discards: 2, melds: 0 }),
      right: Object.freeze({ discards: 1, melds: 0 }),
      self: Object.freeze({ discards: 4, melds: 0 }),
    });
    expect(() => mahjongTableLayout(1334, 750, frozen)).not.toThrow();
    expect(mahjongTableLayout(1334, 750, WORST)).toEqual(
      mahjongTableLayout(1334, 750, WORST),
    );
  });

  it('非法输入回落 1334×750，无 NaN、无负矩形', () => {
    for (const [w, h] of [
      [0, 0],
      [-1, 100],
      [Number.NaN, 750],
      [1334, Number.POSITIVE_INFINITY],
      [100, 100],
    ]) {
      const l = mahjongTableLayout(w, h, EMPTY);
      expect(Number.isFinite(l.s)).toBe(true);
      for (const r of [l.board, l.info, ...lanesOf(l).map((x) => x.rect)]) {
        for (const val of [r.left, r.top, r.width, r.height]) {
          expect(Number.isFinite(val)).toBe(true);
        }
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.width).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

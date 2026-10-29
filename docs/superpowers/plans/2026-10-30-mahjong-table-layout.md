# 麻将牌桌比例布局实现计划（2026-10-30）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把四川麻将牌桌从「纵向堆叠面板」改成主流麻将的四家围桌比例布局：手牌贴边、
对手牌背、牌河围中央井、副露贴牌河、动作浮层；跨设备按高度基准 + 宽度兜底。

**Architecture:** 纯函数 `mahjongTableLayout(W,H,input)` 输出所有分区矩形与牌张尺寸；
`LandscapeStage` 通过 `provide` 注入画布尺寸；`MahjongBoard` 只做分区、手牌交互和事件上抛；
座位卡/对手牌背/牌河/中央井拆成哑组件。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript + SCSS + Vitest/jsdom；uni-app H5/App。

## Global Constraints

- **纯客户端**：只改 `apps/client/src/**`、`apps/client/test/**`、本 spec/plan 文档；
  不动 `packages/**`、`tools/**`、配置中心、admin、数据库、结算、规则、协议。
- 前端只允许依赖 `@fight-the-landlord/protocol`；**不得** import `@fight-the-landlord/shared`。
- 样式单位只用 `px`；**禁用** `rpx` / `em` / `rem` / `vw` / `vh` / `pt`。
- **不得手写 `1px`**（发丝线一律 `$ftl-hairline` = 2px）；`line-height` 必须是 unitless。
- 组件内**零 `setTimeout` / `setInterval`**（牌桌区「不新造时钟」纪律）。
- 每个组件**单根**；`animations.scss` 只能用 `@import`（不能 `@use`）。
- 现有 6 条 `mahjong-board.test.ts` 的断言与选择器不改（只加新用例）。
- 每个任务红 → 绿 → 提交；提交信息末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 验证命令：
  - `pnpm -C apps/client test`
  - `pnpm -C apps/client run lint`
  - 基线（2026-10-30）：119 个测试文件 / 1553 tests 通过、2 skipped。

---

### Task 1: 布局纯函数 `mahjongTableLayout`

**Files:**
- Create: `apps/client/src/game/mahjong-layout.ts`
- Create: `apps/client/test/mahjong-layout.test.ts`

**Interfaces:**
- Consumes: 无（零依赖纯函数）。
- Produces（后续任务依赖的精确签名）：
  - `mahjongTableLayout(width: number, height: number, input?: Partial<MahjongTableInput>): MahjongTableLayout`
  - `MAHJONG_TABLE_TOKENS`（s=1 的设计 token，测试与组件测试用）
  - 类型：`MahjongSeatLoad` / `MahjongTableInput` / `Rect` / `TileSize` / `RiverLayout` /
    `MahjongTableLayout` / `MeldPlacement`。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/mahjong-layout.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test mahjong-layout`
Expected: FAIL —— `Cannot find module '../src/game/mahjong-layout'`（或 0 tests）。

- [ ] **Step 3: 写实现**

新建 `apps/client/src/game/mahjong-layout.ts`：

```ts
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
  handCount: 14,
  drawnGap: 12,
  riverH: 75,
  riverCols: 12,
  riverRows: 2,
  topBackH: 54,
  topBackGap: 2,
  sideBackH: 45,
  sidePitch: 24,
  backCount: 14,
  sideRiverW: 49,
  sideRiverH: 40,
  sideRiverCols: 3,
  sideRiverRows: 8,
  meldScale: 0.8,
  sideMeldScale: 0.65,
  meldOverlap: 8,
  sideMeldGap: 4,
  chip: 56,
  sideChipW: 140,
  selfChipW: 56,
  selfChipH: 76,
  barChipW: 40,
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
  const centerCardW = centerCompact
    ? Math.max(0, centerZone.width - 8 * s)
    : Math.max(0, Math.min(220 * s, centerZone.width - 16 * s));
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
```

- [ ] **Step 4: 跑绿**

Run: `pnpm -C apps/client test mahjong-layout`
Expected: PASS（测试文件全绿；若精确值有 0.001 级偏差，按实现输出的真实值修正测试，**不得放宽比例/不重叠判据**）。

- [ ] **Step 5: 类型检查**

Run: `pnpm -C apps/client run lint`
Expected: PASS（`vue-tsc --noEmit` 无错误）。

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/game/mahjong-layout.ts apps/client/test/mahjong-layout.test.ts
git commit -m "feat(mahjong): 牌桌比例布局纯函数（高度基准+宽度兜底）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `MahjongTile` 显式尺寸 + `MahjongMeld` 杠 4 张同行 / 暗杠全牌背

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongTile.vue`
- Modify: `apps/client/src/components/table/mahjong/MahjongMeld.vue`
- Create: `apps/client/test/mahjong-tile-meld.test.ts`

**Interfaces:**
- Consumes: `Tile` / `MahjongMeldView`（protocol）。
- Produces:
  - `MahjongTile` 新 props `w?: number` / `h?: number`：两者都给时用内联 style 覆盖 `size` 档位。
  - `MahjongMeld` 新 props `tileW?: number` / `tileH?: number` / `overlap?: number`：
    透传给每张 `MahjongTile`；`overlap` 给定时第 2 张起 `margin-left: -overlap px`。
  - `MahjongMeld` 渲染 `meld.tiles` 的**全部**张数（碰 3、杠/暗杠 4），不再有绝对定位 cap；
    `kind === 'angang'` 时 4 张全部 `back`。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/mahjong-tile-meld.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongMeldView, Tile } from '@fight-the-landlord/protocol';
import MahjongTile from '../src/components/table/mahjong/MahjongTile.vue';
import MahjongMeld from '../src/components/table/mahjong/MahjongMeld.vue';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };

function meld(kind: MahjongMeldView['kind'], tiles: Tile[]): MahjongMeldView {
  return { kind, tiles };
}

describe('MahjongTile 显式尺寸', () => {
  it('w/h 同时给出时内联 style 覆盖 size 档位', () => {
    const w = mount(MahjongTile, { props: { tile: wan1, w: 72, h: 108 } });
    expect(w.attributes('style')).toContain('width: 72px');
    expect(w.attributes('style')).toContain('height: 108px');
  });

  it('不给 w/h 时仍走 size 类，无内联尺寸', () => {
    const w = mount(MahjongTile, { props: { tile: wan1, size: 'lg' } });
    expect(w.classes()).toContain('mj-tile--lg');
    expect(w.attributes('style')).toBeUndefined();
  });
});

describe('MahjongMeld 可变尺寸与杠/暗杠', () => {
  it('碰 3 张、杠 4 张同行，无绝对定位 cap', () => {
    const peng = mount(MahjongMeld, { props: { meld: meld('peng', [wan1, wan1, wan1]) } });
    expect(peng.findAll('.mj-tile')).toHaveLength(3);
    expect(peng.find('.mj-meld__cap').exists()).toBe(false);

    const gang = mount(MahjongMeld, {
      props: { meld: meld('gang', [wan1, wan1, wan1, wan2]) },
    });
    expect(gang.findAll('.mj-tile')).toHaveLength(4);
    expect(gang.find('.mj-meld__cap').exists()).toBe(false);
  });

  it('暗杠 4 张全部是牌背', () => {
    const w = mount(MahjongMeld, {
      props: { meld: meld('angang', [wan1, wan1, wan1, wan1]) },
    });
    const srcs = w.findAll('image').map((i) => i.attributes('src') ?? '');
    expect(srcs).toHaveLength(4);
    expect(srcs.every((s) => s.endsWith('/back.png'))).toBe(true);
  });

  it('tileW/tileH/overlap 透传到每张牌', () => {
    const w = mount(MahjongMeld, {
      props: {
        meld: meld('gang', [wan1, wan1, wan1, wan2]),
        tileW: 40,
        tileH: 60,
        overlap: 8,
      },
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.attributes('style')).toContain('width: 40px');
      expect(t.attributes('style')).toContain('height: 60px');
    }
    expect(tiles[0]!.attributes('style') ?? '').not.toContain('margin-left');
    for (const t of tiles.slice(1)) {
      expect(t.attributes('style')).toContain('margin-left: -8px');
    }
  });

  it('pop 类按 kind 保留', () => {
    const w = mount(MahjongMeld, {
      props: { meld: meld('gang', [wan1, wan1, wan1, wan2]), pop: true },
    });
    expect(w.classes()).toContain('anim-meld-pop');
    expect(w.classes()).toContain('anim-meld-pop--gang');
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test mahjong-tile-meld`
Expected: FAIL —— `MahjongTile` 无 `w/h` 尺寸断言 / `MahjongMeld` 仍渲染 cap。

- [ ] **Step 3: 改 `MahjongTile.vue`**

在 props 里加：

```ts
    /** 显式尺寸（设计 px）；提供时覆盖 size 档位。 */
    w?: number;
    h?: number;
```

在 `script setup` 里加：

```ts
const tileStyle = computed(() =>
  props.w !== undefined && props.h !== undefined
    ? { width: `${props.w}px`, height: `${props.h}px` }
    : undefined,
);
```

模板根元素加：

```vue
    :style="tileStyle"
```

`<script setup>` 顶部 import 改为 `import { computed } from 'vue';`。

样式里把选中位移改为按比例：

```scss
.mj-tile--selected {
  transform: translateY(calc(-1 * var(--mj-tile-lift, 10px)));
  box-shadow: 0 0 0 2px $ftl-color-gold, 0 6px 12px rgba(0, 0, 0, 0.4);
}
```

（手牌区的 `handStyle` 会设置 `--mj-tile-lift: 10s px`。）

- [ ] **Step 4: 改 `MahjongMeld.vue`**

props 加：

```ts
    /** 显式牌张尺寸（设计 px）；不传则用 size 档位。 */
    tileW?: number;
    tileH?: number;
    /** 组内叠压 px（正数）；不传则用 size 档位的默认负 margin。 */
    overlap?: number;
```

删除 `capTile` computed 与模板里的 cap `<MahjongTile>`；把前 3 张的循环改为全部：

```vue
    <MahjongTile
      v-for="(tile, i) in meld.tiles"
      :key="`t-${i}`"
      :tile="tile"
      :back="meld.kind === 'angang'"
      :direction="direction"
      :size="size"
      :w="tileW"
      :h="tileH"
      :style="i > 0 && overlap !== undefined ? { marginLeft: `-${overlap}px` } : undefined"
    />
```

样式里删除 `.mj-meld__cap` / `.mj-meld__cap` 相关规则；保留默认 `.mj-meld :deep(.mj-tile) { margin-left: -14px }`
（inline `marginLeft` 会覆盖它）。

- [ ] **Step 5: 跑绿 + 类型检查**

Run: `pnpm -C apps/client test mahjong-tile-meld`
Expected: PASS

Run: `pnpm -C apps/client run lint`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongTile.vue \
        apps/client/src/components/table/mahjong/MahjongMeld.vue \
        apps/client/test/mahjong-tile-meld.test.ts
git commit -m "feat(mahjong): 牌张/副露可变尺寸，杠 4 张同行、暗杠全牌背
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 画布尺寸 `provide` / `inject`

**Files:**
- Modify: `apps/client/src/composables/useLandscapeCanvas.ts`
- Modify: `apps/client/src/components/LandscapeStage.vue`
- Create: `apps/client/test/landscape-metrics-provide.test.ts`

**Interfaces:**
- Consumes: `LayoutMetrics`（既有）。
- Produces:
  - `CANVAS_METRICS_KEY: InjectionKey<ComputedRef<LayoutMetrics>>`
  - `LandscapeStage` 在 setup 里 `provide(CANVAS_METRICS_KEY, metrics)`；
    插槽内容可通过 `inject(CANVAS_METRICS_KEY, null)` 拿到同一份响应式 metrics。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/landscape-metrics-provide.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { defineComponent, h, inject } from 'vue';
import { mount } from '@vue/test-utils';
import LandscapeStage from '../src/components/LandscapeStage.vue';
import {
  CANVAS_METRICS_KEY,
  layoutMetrics,
} from '../src/composables/useLandscapeCanvas';
import { setWindowSize } from './helpers/uni-stub';

const Probe = defineComponent({
  setup() {
    const metrics = inject(CANVAS_METRICS_KEY, null);
    return () =>
      h('div', { class: 'probe' }, metrics ? `${metrics.value.width}x${metrics.value.height}` : 'none');
  },
});

function probeText(w: number, height: number): string {
  setWindowSize(w, height);
  const wrapper = mount(LandscapeStage, {
    slots: { default: () => h(Probe) },
  });
  return wrapper.find('.probe').text();
}

describe('LandscapeStage 画布尺寸 provide', () => {
  it('插槽内容能 inject 到与舞台同一份画布尺寸（16:9）', () => {
    const expected = layoutMetrics(1280, 720);
    expect(probeText(1280, 720)).toBe(`${expected.width}x${expected.height}`);
  });

  it('19.5:9 手机上不是兜底值（宽度 > 1334）', () => {
    const [wText] = probeText(844, 390).split('x');
    expect(Number(wText)).toBeGreaterThan(1334);
  });

  it('4:3 平板上高度 > 750', () => {
    const [, hText] = probeText(1024, 768).split('x');
    expect(Number(hText)).toBeGreaterThan(750);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test landscape-metrics-provide`
Expected: FAIL —— `CANVAS_METRICS_KEY` 未导出 / probe 文本为 `none`。

- [ ] **Step 3: 加 key + provide**

`useLandscapeCanvas.ts` 顶部加：

```ts
import type { ComputedRef, InjectionKey } from 'vue';
```

在 `LayoutMetrics` 定义之后加：

```ts
/**
 * 画布尺寸的注入键：`LandscapeStage` provide，牌桌类组件 inject。
 * 纯类型 + Symbol，无运行时依赖；独立挂载时调用方可用缺省 1334×750 兜底。
 */
export const CANVAS_METRICS_KEY: InjectionKey<ComputedRef<LayoutMetrics>> =
  Symbol('ftl-canvas-metrics');
```

`LandscapeStage.vue`：
- import 改为 `import { computed, provide } from "vue";`
- 从 `../composables/useLandscapeCanvas` 的 import 里加 `CANVAS_METRICS_KEY`。
- 在 `const metrics = computed(...)` 之后（setup 顶层）加：

```ts
provide(CANVAS_METRICS_KEY, metrics);
```

- [ ] **Step 4: 跑绿 + 类型检查**

Run: `pnpm -C apps/client test landscape-metrics-provide`
Expected: PASS

Run: `pnpm -C apps/client run lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/composables/useLandscapeCanvas.ts \
        apps/client/src/components/LandscapeStage.vue \
        apps/client/test/landscape-metrics-provide.test.ts
git commit -m "feat(mahjong): 画布尺寸 provide/inject，牌桌可拿真实设计尺寸
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `MahjongSeatChip` 座位小卡

**Files:**
- Create: `apps/client/src/components/table/mahjong/MahjongSeatChip.vue`
- Create: `apps/client/test/mahjong-seat-chip.test.ts`

**Interfaces:**
- Consumes: `MahjongHuInfo` / `MahjongSuit` / `MAHJONG_SUIT_NAMES`（protocol）。
- Produces: props
  `name, isMe?, isDealer?, cardCount?, lackSuit?, hu?, isOut?, trustee?, ting?, activeLevel?, balance?, pendingDelta?, avatar?, variant?`
  （`variant: 'self' | 'side' | 'bar'`，`avatar` 为头像边长 px）。
  根元素 class `mj-chip`，变体类 `mj-chip--self/side/bar`，发光类
  `mj-chip--active-strong/weak`。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/mahjong-seat-chip.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MahjongSeatChip from '../src/components/table/mahjong/MahjongSeatChip.vue';

const base = {
  name: '北家乙',
  cardCount: 13,
  balance: 15500,
  avatar: 56,
  variant: 'side' as const,
};

describe('MahjongSeatChip', () => {
  it('side 变体：头像/名字/张数/分数', () => {
    const w = mount(MahjongSeatChip, { props: base });
    expect(w.find('.mj-chip').classes()).toContain('mj-chip--side');
    expect(w.find('image').attributes('src')).toBe('/static/ui/default.png');
    expect(w.text()).toContain('北家乙');
    expect(w.text()).toContain('13 张');
    expect(w.text()).toContain('15500');
  });

  it('庄/缺/听/托管/出局/胡/番/临时分徽标各自出现', () => {
    const w = mount(MahjongSeatChip, {
      props: {
        ...base,
        isDealer: true,
        lackSuit: 0,
        ting: true,
        trustee: true,
        pendingDelta: 12,
      },
    });
    expect(w.text()).toContain('庄');
    expect(w.text()).toContain('缺万');
    expect(w.text()).toContain('听');
    expect(w.text()).toContain('托管');
    expect(w.text()).toContain('+12');

    const hu = mount(MahjongSeatChip, {
      props: {
        ...base,
        hu: { seat: 2, fromSeat: 0, tile: { s: 0, r: 1 }, fan: 3, selfDraw: false, items: ['清一色', '根'] },
        isOut: true,
      },
    });
    expect(hu.text()).toContain('胡');
    expect(hu.text()).toContain('3 番');
    expect(hu.text()).toContain('清一色');
    expect(hu.text()).toContain('等2种');
    expect(hu.text()).not.toContain('已出局');
  });

  it('self 变体：不渲染名字，显示分数', () => {
    const w = mount(MahjongSeatChip, { props: { ...base, isMe: true, variant: 'self' } });
    expect(w.find('.mj-chip__name').exists()).toBe(false);
    expect(w.text()).toContain('15500');
  });

  it('activeLevel 发光类', () => {
    expect(
      mount(MahjongSeatChip, { props: { ...base, activeLevel: 'strong' } })
        .find('.mj-chip')
        .classes(),
    ).toContain('mj-chip--active-strong');
    expect(
      mount(MahjongSeatChip, { props: { ...base, activeLevel: 'weak' } })
        .find('.mj-chip')
        .classes(),
    ).toContain('mj-chip--active-weak');
  });

  it('头像尺寸跟随 avatar prop', () => {
    const w = mount(MahjongSeatChip, { props: { ...base, avatar: 40 } });
    expect(w.find('.mj-chip__avatar-box').attributes('style')).toContain('width: 40px');
    expect(w.find('.mj-chip__avatar-box').attributes('style')).toContain('height: 40px');
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test mahjong-seat-chip`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 写组件**

新建 `apps/client/src/components/table/mahjong/MahjongSeatChip.vue`：

```vue
<script setup lang="ts">
/**
 * 麻将座位小卡（哑组件）：只渲染 props，不判规则、不取数、不造计时器。
 * 三个变体：self（左下角头像+分数）、side（左右家头像+名字/分/徽标）、bar（顶栏对家 40 头像）。
 */
import { computed } from 'vue';
import {
  MAHJONG_SUIT_NAMES,
  type MahjongHuInfo,
  type MahjongSuit,
} from '@fight-the-landlord/protocol';

const props = withDefaults(defineProps<{
  name: string;
  isMe?: boolean;
  isDealer?: boolean;
  cardCount?: number;
  lackSuit?: MahjongSuit | null;
  hu?: MahjongHuInfo | null;
  isOut?: boolean;
  trustee?: boolean;
  ting?: boolean;
  activeLevel?: 'strong' | 'weak' | null;
  balance?: number | null;
  pendingDelta?: number;
  /** 头像边长（设计 px），由布局函数给。 */
  avatar?: number;
  variant?: 'self' | 'side' | 'bar';
}>(), {
  isMe: false,
  isDealer: false,
  cardCount: 0,
  lackSuit: null,
  hu: null,
  isOut: false,
  trustee: false,
  ting: false,
  activeLevel: null,
  balance: null,
  pendingDelta: 0,
  avatar: 56,
  variant: 'side',
});

const FAN_EMOJI: Record<string, string> = {
  清一色: '🎴', 七对: '👯', 大对: '🔶', 根: '🌳', 杠上开花: '💥',
  海底捞月: '🌙', 十三幺: '👻', 对对胡: '🃏', 平胡: '✨', 抢杠胡: '⚡',
  龙七对: '🐉', 清对: '🎯', 将对: '⚔️',
};
const lackLabel = computed(() =>
  props.lackSuit === null ? '' : `缺${MAHJONG_SUIT_NAMES[props.lackSuit]}`,
);
const deltaLabel = computed(() => {
  if (props.pendingDelta === 0) return '';
  return props.pendingDelta > 0 ? `+${props.pendingDelta}` : `${props.pendingDelta}`;
});
const fanLabel = computed(() => {
  const first = props.hu?.items[0];
  if (!first) return '';
  const more = (props.hu?.items.length ?? 0) > 1 ? `等${props.hu!.items.length}种` : '';
  return `${FAN_EMOJI[first] ?? '🏆'}${first}${more}`;
});
</script>

<template>
  <view
    class="mj-chip"
    :class="[
      `mj-chip--${variant}`,
      {
        'mj-chip--me': isMe,
        'mj-chip--out': isOut,
        'mj-chip--active-strong': activeLevel === 'strong',
        'mj-chip--active-weak': activeLevel === 'weak',
      },
    ]"
  >
    <view class="mj-chip__avatar-box" :style="{ width: `${avatar}px`, height: `${avatar}px` }">
      <image class="mj-chip__avatar" src="/static/ui/default.png" mode="aspectFit" />
      <text v-if="isDealer" class="mj-chip__corner mj-chip__corner--dealer">庄</text>
      <text v-if="lackLabel" class="mj-chip__corner mj-chip__corner--lack">{{ lackLabel }}</text>
      <text v-if="hu" class="mj-chip__corner mj-chip__corner--hu">胡</text>
      <text v-else-if="ting && !isOut" class="mj-chip__corner mj-chip__corner--ting">听</text>
    </view>

    <view v-if="variant !== 'self'" class="mj-chip__info">
      <text class="mj-chip__name">{{ name }}</text>
      <text class="mj-chip__meta">
        <template v-if="!isMe && variant !== 'bar'">{{ cardCount }} 张</template>
        <template v-if="balance !== null"> · {{ balance }}</template>
      </text>
      <view v-if="trustee || isOut || hu || deltaLabel || fanLabel" class="mj-chip__badges">
        <text v-if="trustee" class="mj-chip__badge">托管</text>
        <text v-if="isOut && !hu" class="mj-chip__badge mj-chip__badge--neg">已出局</text>
        <text v-if="hu" class="mj-chip__badge mj-chip__badge--pos">
          {{ hu.fan > 0 ? `${hu.fan} 番` : '胡' }}
        </text>
        <text v-if="fanLabel" class="mj-chip__badge mj-chip__badge--fan">{{ fanLabel }}</text>
        <text
          v-if="deltaLabel"
          class="mj-chip__badge"
          :class="pendingDelta > 0 ? 'mj-chip__badge--pos' : 'mj-chip__badge--neg'"
        >
          {{ deltaLabel }}
        </text>
      </view>
    </view>

    <view v-else class="mj-chip__self-info">
      <text class="mj-chip__meta">{{ balance ?? '—' }}</text>
      <text
        v-if="deltaLabel"
        class="mj-chip__delta"
        :class="pendingDelta > 0 ? 'mj-chip__badge--pos' : 'mj-chip__badge--neg'"
      >
        {{ deltaLabel }}
      </text>
    </view>
  </view>
</template>

<style scoped lang="scss">
@import "../../../styles/animations.scss";

.mj-chip {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  color: $ftl-color-text;
}
.mj-chip--side {
  width: 100%;
  height: 100%;
  padding: 0 2px;
}
.mj-chip--bar {
  height: 100%;
}
.mj-chip--self {
  width: 100%;
  height: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.mj-chip__avatar-box {
  position: relative;
  flex: 0 0 auto;
}
.mj-chip__avatar {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: $ftl-hairline solid rgba($ftl-color-on-primary, 0.8);
  border-radius: $ftl-radius-pill;
  background: $ftl-color-surface;
}
.mj-chip__corner {
  position: absolute;
  padding: 0 3px;
  border-radius: 999px;
  font-size: 9px;
  line-height: 1.3;
  background: rgba(0, 0, 0, 0.65);
  color: $ftl-color-on-primary;
  white-space: nowrap;
}
.mj-chip__corner--dealer {
  top: -2px;
  right: -2px;
  background: $ftl-color-accent;
}
.mj-chip__corner--lack {
  bottom: -2px;
  left: -2px;
  background: rgba(120, 170, 255, 0.85);
}
.mj-chip__corner--hu {
  top: -2px;
  left: -2px;
  background: rgba($ftl-color-gold, 0.9);
}
.mj-chip__corner--ting {
  top: -2px;
  left: -2px;
  background: rgba(74, 222, 128, 0.9);
  color: $ftl-color-night-deep;
}
.mj-chip__info {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.mj-chip__name {
  overflow: hidden;
  font-size: $ftl-font-sm;
  font-weight: 600;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-chip__meta {
  overflow: hidden;
  color: rgba($ftl-color-on-primary, 0.8);
  font-size: 10px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-chip__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.mj-chip__badge {
  padding: 0 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  color: rgba($ftl-color-on-primary, 0.9);
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
}
.mj-chip__badge--pos {
  background: rgba($ftl-color-gold, 0.35);
  color: $ftl-color-gold-light;
}
.mj-chip__badge--neg {
  background: rgba($ftl-color-danger, 0.3);
}
.mj-chip__badge--fan {
  background: rgba($ftl-color-accent, 0.3);
  color: $ftl-color-hint-warn;
}
.mj-chip__self-info {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.mj-chip__delta {
  font-size: 9px;
}
.mj-chip--out {
  opacity: 0.6;
}
.mj-chip--active-strong {
  border-radius: $ftl-radius-md;
  animation: ftl-active-glow 1.2s ease-in-out infinite;
  box-shadow: 0 0 14px rgba($ftl-color-gold, 0.5);
}
.mj-chip--active-weak {
  border-radius: $ftl-radius-md;
  animation: ftl-active-glow 2.2s ease-in-out infinite;
  box-shadow: 0 0 6px rgba($ftl-color-gold, 0.25);
}
@media (prefers-reduced-motion: reduce) {
  .mj-chip--active-strong,
  .mj-chip--active-weak {
    animation: none !important;
    box-shadow: 0 0 8px rgba($ftl-color-gold, 0.2);
  }
}
</style>
```

- [ ] **Step 4: 跑绿 + 类型检查**

Run: `pnpm -C apps/client test mahjong-seat-chip`
Expected: PASS

Run: `pnpm -C apps/client run lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongSeatChip.vue \
        apps/client/test/mahjong-seat-chip.test.ts
git commit -m "feat(mahjong): 座位小卡（对家/左右家/自己三变体）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `MahjongHandBacks` 对手牌背 / 已胡亮牌

**Files:**
- Create: `apps/client/src/components/table/mahjong/MahjongHandBacks.vue`
- Create: `apps/client/test/mahjong-hand-backs.test.ts`

**Interfaces:**
- Consumes: `Tile`（protocol）、`MahjongTile`（Task 2 的 `w/h`）。
- Produces: props
  `count: number, direction: 'top'|'left'|'right', tileW: number, tileH: number, gap?: number, pitch?: number, revealed?: { tiles: Tile[]; huTile: Tile } | null`。
  根 class `mj-backs`；`direction=left/right` 加 `mj-backs--vertical`。
  `revealed` 非空时渲染 `revealed.tiles` 牌面（`dim`），否则渲染 `min(max(count,0),14)` 张牌背。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/mahjong-hand-backs.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MahjongHandBacks from '../src/components/table/mahjong/MahjongHandBacks.vue';

describe('MahjongHandBacks', () => {
  it('top：13 张牌背横排，gap 生效', () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 13, direction: 'top', tileW: 36, tileH: 54, gap: 2 },
    });
    expect(w.findAll('.mj-tile')).toHaveLength(13);
    expect(w.classes()).toContain('mj-backs--top');
    expect(w.attributes('style')).toContain('gap: 2px');
    expect(w.findAll('image').every((i) => (i.attributes('src') ?? '').endsWith('/back.png'))).toBe(
      true,
    );
  });

  it('left：竖排，pitch 24 / tileH 45 → 第 2 张起 margin-top -21px', () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 13, direction: 'left', tileW: 30, tileH: 45, pitch: 24 },
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(13);
    expect(w.classes()).toContain('mj-backs--vertical');
    expect(tiles[0]!.attributes('style') ?? '').not.toContain('margin-top');
    expect(tiles[1]!.attributes('style')).toContain('margin-top: -21px');
  });

  it('count 0 不渲染；count > 14 截到 14', () => {
    expect(
      mount(MahjongHandBacks, {
        props: { count: 0, direction: 'top', tileW: 36, tileH: 54 },
      }).findAll('.mj-tile'),
    ).toHaveLength(0);
    expect(
      mount(MahjongHandBacks, {
        props: { count: 99, direction: 'top', tileW: 36, tileH: 54 },
      }).findAll('.mj-tile'),
    ).toHaveLength(14);
  });

  it('revealed：渲染牌面而不是牌背', () => {
    const w = mount(MahjongHandBacks, {
      props: {
        count: 13,
        direction: 'top',
        tileW: 36,
        tileH: 54,
        revealed: { tiles: [{ s: 0, r: 1 }, { s: 1, r: 2 }], huTile: { s: 1, r: 2 } },
      },
    });
    const srcs = w.findAll('image').map((i) => i.attributes('src') ?? '');
    expect(srcs).toHaveLength(2);
    expect(srcs[0]).toContain('/top/wan-1.png');
    expect(srcs[1]).toContain('/top/tong-2.png');
    expect(srcs.some((s) => s.endsWith('/back.png'))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test mahjong-hand-backs`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 写组件**

新建 `apps/client/src/components/table/mahjong/MahjongHandBacks.vue`：

```vue
<script setup lang="ts">
/**
 * 对手手牌区（哑组件）：牌背横排/竖排；已胡者用亮牌替换牌背。
 * 只渲染 props，不判规则、不取数。
 */
import { computed } from 'vue';
import type { Tile } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

type Direction = 'top' | 'left' | 'right';

const props = withDefaults(
  defineProps<{
    count: number;
    direction: Direction;
    tileW: number;
    tileH: number;
    /** 横排间距（top）。 */
    gap?: number;
    /** 竖排间距（left/right，小于 tileH 时叠压）。 */
    pitch?: number;
    /** 已胡者亮牌；非空时完全替换牌背。 */
    revealed?: { tiles: Tile[]; huTile: Tile } | null;
  }>(),
  { gap: 0, pitch: 0, revealed: null },
);

const shown = computed(() => Math.max(0, Math.min(14, Math.floor(props.count))));
const vertical = computed(() => props.direction === 'left' || props.direction === 'right');
const overlapTop = computed(() =>
  vertical.value && props.pitch > 0 ? props.pitch - props.tileH : 0,
);
</script>

<template>
  <view
    class="mj-backs"
    :class="[`mj-backs--${direction}`, { 'mj-backs--vertical': vertical }]"
    :style="{ gap: vertical ? '0px' : `${gap}px` }"
  >
    <template v-if="revealed">
      <MahjongTile
        v-for="(t, i) in revealed.tiles"
        :key="`revealed-${i}`"
        :tile="t"
        :direction="direction"
        :w="tileW"
        :h="tileH"
        :style="i > 0 && overlapTop !== 0 ? { marginTop: `${overlapTop}px` } : undefined"
        dim
      />
    </template>
    <template v-else>
      <MahjongTile
        v-for="i in shown"
        :key="`back-${i}`"
        back
        :direction="direction"
        :w="tileW"
        :h="tileH"
        :style="i > 1 && overlapTop !== 0 ? { marginTop: `${overlapTop}px` } : undefined"
      />
    </template>
  </view>
</template>

<style scoped lang="scss">
.mj-backs {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
}
.mj-backs--top {
  flex-direction: row;
  flex-wrap: nowrap;
}
.mj-backs--vertical {
  flex-direction: column;
  flex-wrap: nowrap;
}
</style>
```

- [ ] **Step 4: 跑绿 + 类型检查**

Run: `pnpm -C apps/client test mahjong-hand-backs`
Expected: PASS

Run: `pnpm -C apps/client run lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongHandBacks.vue \
        apps/client/test/mahjong-hand-backs.test.ts
git commit -m "feat(mahjong): 对手牌背组件（横排/竖排/已胡亮牌替换）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `MahjongRiver` 牌河 + 副露条

**Files:**
- Create: `apps/client/src/components/table/mahjong/MahjongRiver.vue`
- Create: `apps/client/test/mahjong-river.test.ts`

**Interfaces:**
- Consumes: `Tile` / `MahjongMeldView` / `tileType`（protocol）；`MahjongTile`（Task 2）；`MahjongMeld`（Task 2）。
- Produces: props
  `discards: Tile[], melds: Array<{ key: string; meld: MahjongMeldView; pop: boolean }>, direction: 'my'|'top'|'left'|'right', tileW, tileH, gap, cols, rows, meldTileW, meldTileH, meldOverlap, meldPlacement: 'above'|'below', meldGap, meldHeight, filterTileType?: number|null, interactive?: boolean, revealed?: { tiles: Tile[]; huTile: Tile } | null`。
  emits：`discard-click(tile)`、`meld-pop-done(key)`。
  根 class `mj-river`；弃牌网格 `.mj-river__grid`；副露条 `.mj-river__melds`。
  `revealed` 非空时（左右家已胡）用 3 列亮牌网格替换 discards，不响应点击。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/mahjong-river.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { tileType, type MahjongMeldView, type Tile } from '@fight-the-landlord/protocol';
import MahjongRiver from '../src/components/table/mahjong/MahjongRiver.vue';
import MahjongMeld from '../src/components/table/mahjong/MahjongMeld.vue';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };
const tong1: Tile = { s: 1, r: 1 };

function props(over: Record<string, unknown> = {}) {
  return {
    discards: [wan1, wan2, tong1],
    melds: [] as Array<{ key: string; meld: MahjongMeldView; pop: boolean }>,
    direction: 'my' as const,
    tileW: 50,
    tileH: 75,
    gap: 2,
    cols: 12,
    rows: 2,
    meldTileW: 40,
    meldTileH: 60,
    meldOverlap: 8,
    meldPlacement: 'above' as const,
    meldGap: 8,
    meldHeight: 0,
    filterTileType: null,
    interactive: false,
    revealed: null,
    ...over,
  };
}

describe('MahjongRiver', () => {
  it('弃牌按顺序渲染，最后一张高亮', () => {
    const w = mount(MahjongRiver, { props: props() });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(3);
    expect(tiles[2]!.classes()).toContain('mj-river__tile--latest');
    const grid = w.find('.mj-river__grid');
    expect(grid.attributes('style')).toContain('grid-template-columns: repeat(12, 50px)');
    expect(grid.attributes('style')).toContain('gap: 2px');
  });

  it('点击弃牌 emit discard-click', async () => {
    const w = mount(MahjongRiver, { props: props() });
    await w.findAll('.mj-tile')[0]!.trigger('click');
    expect(w.emitted('discard-click')?.[0]).toEqual([wan1]);
  });

  it('filterTileType 命中加 outline 类', () => {
    const w = mount(MahjongRiver, { props: props({ filterTileType: tileType(wan1) }) });
    const tiles = w.findAll('.mj-tile');
    expect(tiles[0]!.classes()).toContain('mj-river__tile--filtered');
    expect(tiles[1]!.classes()).not.toContain('mj-river__tile--filtered');
  });

  it('副露条：碰 3 张 + 杠 4 张，标签/位置正确', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [
          { key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false },
          { key: 'gang:0_0_0_1', meld: { kind: 'gang', tiles: [wan1, wan1, wan1, wan2] }, pop: true },
        ],
        meldHeight: 60,
      }),
    });
    expect(w.findAll('.mj-river__meld')).toHaveLength(2);
    expect(w.findAll('.mj-tile')).toHaveLength(7);
    expect(w.text()).toContain('碰');
    expect(w.text()).toContain('杠');
    const strip = w.find('.mj-river__melds');
    expect(strip.attributes('style')).toContain('bottom: calc(100% + 8px)');
    expect(strip.attributes('style')).toContain('height: 60px');
    expect(w.findComponent(MahjongMeld).classes()).toContain('anim-meld-pop');
  });

  it('meldPlacement=below 时条带在下方', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [{ key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false }],
        meldPlacement: 'below',
        meldHeight: 60,
      }),
    });
    expect(w.find('.mj-river__melds').attributes('style')).toContain('top: calc(100% + 8px)');
  });

  it('副露 pop-done 原样上抛 key', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [{ key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: true }],
        meldHeight: 60,
      }),
    });
    w.findComponent(MahjongMeld).vm.$emit('pop-done');
    expect(w.emitted('meld-pop-done')?.[0]).toEqual(['peng:0_0_0']);
  });

  it('direction 类名正确', () => {
    for (const direction of ['my', 'top', 'left', 'right'] as const) {
      expect(mount(MahjongRiver, { props: props({ direction }) }).classes()).toContain(
        `mj-river--${direction}`,
      );
    }
  });

  it('revealed：亮牌网格替换 discards，不响应点击', async () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [wan2],
        revealed: { tiles: [wan1, tong1], huTile: tong1 },
      }),
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(2);
    expect(w.find('.mj-river__revealed').exists()).toBe(true);
    expect(w.text()).toContain('已胡');
    await tiles[0]!.trigger('click');
    expect(w.emitted('discard-click')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test mahjong-river`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 写组件**

新建 `apps/client/src/components/table/mahjong/MahjongRiver.vue`：

```vue
<script setup lang="ts">
/**
 * 单座牌河（哑组件）：弃牌网格 + 副露条 + 最新牌高亮 + 弃牌点击。
 * 只渲染 props；是否响应点击由父组件决定（这里只 emit）。
 */
import { computed } from 'vue';
import {
  tileType,
  type MahjongMeldView,
  type Tile,
} from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';
import MahjongMeld from './MahjongMeld.vue';

type Direction = 'my' | 'top' | 'left' | 'right';

const props = withDefaults(
  defineProps<{
    discards: Tile[];
    melds: Array<{ key: string; meld: MahjongMeldView; pop: boolean }>;
    direction: Direction;
    tileW: number;
    tileH: number;
    gap: number;
    cols: number;
    rows: number;
    meldTileW: number;
    meldTileH: number;
    meldOverlap: number;
    meldPlacement: 'above' | 'below';
    meldGap: number;
    meldHeight: number;
    filterTileType?: number | null;
    interactive?: boolean;
    /** 左右家已胡：亮牌网格替换 discards。 */
    revealed?: { tiles: Tile[]; huTile: Tile } | null;
  }>(),
  { filterTileType: null, interactive: false, revealed: null },
);

const emit = defineEmits<{
  (e: 'discard-click', tile: Tile): void;
  (e: 'meld-pop-done', key: string): void;
}>();

const MELD_LABEL: Record<MahjongMeldView['kind'], string> = {
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
};

const vertical = computed(() => props.direction === 'left' || props.direction === 'right');

const gridStyle = computed<Record<string, string>>(() => ({
  display: 'grid',
  gridTemplateColumns: `repeat(${props.cols}, ${props.tileW}px)`,
  gridAutoRows: `${props.tileH}px`,
  gap: `${props.gap}px`,
}));

const meldStripStyle = computed<Record<string, string>>(() => ({
  position: 'absolute',
  left: '0',
  width: '100%',
  height: `${props.meldHeight}px`,
  display: 'flex',
  flexDirection: vertical.value ? 'column' : 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: `${props.meldGap}px`,
  [props.meldPlacement === 'above' ? 'bottom' : 'top']: `calc(100% + ${props.meldGap}px)`,
}));

function isFiltered(t: Tile): boolean {
  return props.filterTileType !== null && tileType(t) === props.filterTileType;
}
</script>

<template>
  <view class="mj-river" :class="`mj-river--${direction}`">
    <view v-if="melds.length > 0" class="mj-river__melds" :style="meldStripStyle">
      <view v-for="m in melds" :key="m.key" class="mj-river__meld">
        <text class="mj-river__meld-label">{{ MELD_LABEL[m.meld.kind] }}</text>
        <MahjongMeld
          :meld="m.meld"
          :direction="direction"
          :tile-w="meldTileW"
          :tile-h="meldTileH"
          :overlap="meldOverlap"
          :pop="m.pop"
          @pop-done="emit('meld-pop-done', m.key)"
        />
      </view>
    </view>
    <text v-if="revealed" class="mj-river__revealed-label">已胡</text>
    <view v-if="revealed" class="mj-river__grid mj-river__revealed" :style="gridStyle">
      <MahjongTile
        v-for="(t, i) in revealed.tiles"
        :key="`revealed-${i}`"
        :tile="t"
        :direction="direction"
        :w="tileW"
        :h="tileH"
      />
    </view>
    <view v-else-if="discards.length > 0" class="mj-river__grid" :style="gridStyle">
      <MahjongTile
        v-for="(t, i) in discards"
        :key="`discard-${i}`"
        :tile="t"
        :direction="direction"
        :w="tileW"
        :h="tileH"
        :class="{
          'mj-river__tile--latest': i === discards.length - 1,
          'mj-river__tile--filtered': isFiltered(t),
          'mj-river__tile--clickable': interactive,
        }"
        @click="emit('discard-click', t)"
      />
    </view>
  </view>
</template>

<style scoped lang="scss">
.mj-river {
  box-sizing: border-box;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
}
.mj-river__grid {
  align-content: center;
  justify-content: center;
}
.mj-river__melds {
  z-index: 1;
}
.mj-river__meld {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mj-river__meld-label {
  position: absolute;
  top: -13px;
  left: 0;
  padding: 0 3px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba($ftl-color-on-primary, 0.85);
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
}
.mj-river__tile--latest {
  box-shadow: 0 0 6px rgba($ftl-color-gold, 0.55);
}
.mj-river__tile--filtered {
  outline: 2px solid $ftl-color-primary;
  outline-offset: -2px;
}
.mj-river__tile--clickable {
  cursor: pointer;
}
.mj-river__revealed-label {
  position: absolute;
  top: -13px;
  left: 0;
  padding: 0 3px;
  border-radius: 999px;
  background: rgba($ftl-color-gold, 0.85);
  color: $ftl-color-on-primary;
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
}
.mj-river__revealed {
  opacity: 0.92;
}
</style>
```

- [ ] **Step 4: 跑绿 + 类型检查**

Run: `pnpm -C apps/client test mahjong-river`
Expected: PASS

Run: `pnpm -C apps/client run lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongRiver.vue \
        apps/client/test/mahjong-river.test.ts
git commit -m "feat(mahjong): 牌河组件（网格/副露条/过滤高亮）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `MahjongCenter` 中央井

**Files:**
- Create: `apps/client/src/components/table/mahjong/MahjongCenter.vue`
- Create: `apps/client/test/mahjong-center.test.ts`

**Interfaces:**
- Consumes: `Tile` / `MAHJONG_SUIT_NAMES`（protocol）；`MahjongTile`（Task 2）。
- Produces: props
  `wallCount, phaseText, claimTile?, claimW?, claimH?, tingTiles?, tingW?, tingH?, maxFan?, seconds, active?, compact?, endedText?`。
  根 class `mj-center`；紧凑类 `mj-center--compact`；倒计时紧急类 `mj-center__clock--urgent`。

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/mahjong-center.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MahjongCenter from '../src/components/table/mahjong/MahjongCenter.vue';

const base = {
  wallCount: 42,
  phaseText: '请出牌',
  seconds: 12,
  active: true,
  claimW: 34,
  claimH: 51,
  tingW: 20,
  tingH: 30,
};

describe('MahjongCenter', () => {
  it('牌墙/阶段/倒计时', () => {
    const w = mount(MahjongCenter, { props: base });
    expect(w.text()).toContain('牌墙 42');
    expect(w.text()).toContain('请出牌');
    expect(w.find('.mj-center__clock').text()).toContain('12');
  });

  it('末 5 秒紧迫类', () => {
    const w = mount(MahjongCenter, { props: { ...base, seconds: 4 } });
    expect(w.find('.mj-center__clock').classes()).toContain('mj-center__clock--urgent');
    const calm = mount(MahjongCenter, { props: { ...base, seconds: 6 } });
    expect(calm.find('.mj-center__clock').classes()).not.toContain('mj-center__clock--urgent');
  });

  it('待响应牌 + 听牌', () => {
    const w = mount(MahjongCenter, {
      props: {
        ...base,
        claimTile: { s: 0, r: 5 },
        tingTiles: [{ s: 0, r: 5 }, { s: 0, r: 8 }],
        maxFan: 5,
      },
    });
    expect(w.findAll('image')).toHaveLength(3);
    expect(w.text()).toContain('可响应');
    expect(w.text()).toContain('听');
    expect(w.text()).toContain('5 番');
    expect(w.findAll('.mj-tile')[0]!.attributes('style')).toContain('width: 34px');
    expect(w.findAll('.mj-tile')[1]!.attributes('style')).toContain('width: 20px');
  });

  it('紧凑模式：单行、不出牌面、只出文字', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, compact: true, claimTile: { s: 0, r: 5 } },
    });
    expect(w.classes()).toContain('mj-center--compact');
    expect(w.findAll('image')).toHaveLength(0);
    expect(w.text()).toContain('可响应');
    expect(w.text()).toContain('万5');
  });

  it('已胡家数文案', () => {
    const w = mount(MahjongCenter, { props: { ...base, endedText: '已胡 2 家' } });
    expect(w.text()).toContain('已胡 2 家');
  });

  it('active=false 不渲染倒计时', () => {
    const w = mount(MahjongCenter, { props: { ...base, active: false } });
    expect(w.find('.mj-center__clock').exists()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test mahjong-center`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 写组件**

新建 `apps/client/src/components/table/mahjong/MahjongCenter.vue`：

```vue
<script setup lang="ts">
/**
 * 中央井（哑组件）：牌墙/阶段/待响应牌/听牌/倒计时。
 * 井高不足时切单行紧凑模式（只出文字，不出牌面）。
 */
import { computed } from 'vue';
import { MAHJONG_SUIT_NAMES, type Tile } from '@fight-the-landlord/protocol';
import MahjongTile from './MahjongTile.vue';

const props = withDefaults(
  defineProps<{
    wallCount: number;
    phaseText: string;
    claimTile?: Tile | null;
    claimW?: number;
    claimH?: number;
    tingTiles?: readonly Tile[];
    tingW?: number;
    tingH?: number;
    maxFan?: number | null;
    seconds: number;
    active?: boolean;
    compact?: boolean;
    endedText?: string;
  }>(),
  {
    claimTile: null,
    claimW: 34,
    claimH: 51,
    tingTiles: () => [],
    tingW: 20,
    tingH: 30,
    maxFan: null,
    active: false,
    compact: false,
    endedText: '',
  },
);

const urgent = computed(() => props.active && props.seconds > 0 && props.seconds <= 5);
const claimLabel = computed(() =>
  props.claimTile
    ? `${MAHJONG_SUIT_NAMES[props.claimTile.s]}${props.claimTile.r}`
    : '',
);
</script>

<template>
  <view class="mj-center" :class="{ 'mj-center--compact': compact }">
    <view class="mj-center__head">
      <text class="mj-center__wall">牌墙 {{ wallCount }}</text>
      <text class="mj-center__phase">{{ phaseText }}</text>
      <text
        v-if="active"
        class="mj-center__clock"
        :class="{ 'mj-center__clock--urgent': urgent }"
      >{{ seconds }}s</text>
    </view>
    <template v-if="!compact">
      <view v-if="claimTile" class="mj-center__claim">
        <MahjongTile :tile="claimTile" :w="claimW" :h="claimH" direction="my" />
        <text class="mj-center__label">可响应</text>
      </view>
      <view v-if="tingTiles.length > 0" class="mj-center__ting">
        <text class="mj-center__label">
          听<template v-if="maxFan !== null">（{{ maxFan }} 番）</template>
        </text>
        <MahjongTile
          v-for="(t, i) in tingTiles"
          :key="`ting-${i}`"
          :tile="t"
          :w="tingW"
          :h="tingH"
          direction="my"
        />
      </view>
      <text v-if="endedText" class="mj-center__ended">{{ endedText }}</text>
    </template>
    <text v-else-if="claimTile" class="mj-center__compact-claim">
      可响应 {{ claimLabel }}
    </text>
  </view>
</template>

<style scoped lang="scss">
.mj-center {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 6px 8px;
  overflow: hidden;
  border: $ftl-hairline solid rgba($ftl-color-gold, 0.35);
  border-radius: $ftl-radius-md;
  background: rgba(0, 0, 0, 0.38);
  color: $ftl-color-text;
  text-align: center;
}
.mj-center--compact {
  flex-direction: row;
  gap: 6px;
  padding: 0 8px;
  white-space: nowrap;
}
.mj-center__head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
}
.mj-center__wall {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-sm;
  font-weight: 700;
  white-space: nowrap;
}
.mj-center__phase {
  overflow: hidden;
  color: $ftl-color-gold;
  font-size: $ftl-font-md;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mj-center__clock {
  color: $ftl-color-gold-light;
  font-size: $ftl-font-sm;
  font-weight: 700;
  white-space: nowrap;
}
.mj-center__clock--urgent {
  color: $ftl-color-danger;
}
.mj-center__claim,
.mj-center__ting {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 3px;
}
.mj-center__label {
  color: $ftl-color-text-muted;
  font-size: 10px;
  white-space: nowrap;
}
.mj-center__ended {
  color: $ftl-color-text-muted;
  font-size: 10px;
}
.mj-center--compact .mj-center__head {
  flex: 0 0 auto;
}
.mj-center__compact-claim {
  overflow: hidden;
  color: $ftl-color-gold-light;
  font-size: 11px;
  text-overflow: ellipsis;
}
</style>
```

- [ ] **Step 4: 跑绿 + 类型检查**

Run: `pnpm -C apps/client test mahjong-center`
Expected: PASS

Run: `pnpm -C apps/client run lint`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongCenter.vue \
        apps/client/test/mahjong-center.test.ts
git commit -m "feat(mahjong): 中央井组件（牌墙/阶段/待响应/听牌/倒计时/紧凑）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `MahjongBoard` 四家分区重排

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- Modify: `apps/client/test/mahjong-board.test.ts`（只加用例）

**Interfaces:**
- Consumes: `mahjongTableLayout`（Task 1）、`CANVAS_METRICS_KEY`（Task 3）、
  `MahjongSeatChip` / `MahjongHandBacks` / `MahjongRiver` / `MahjongCenter`（Task 4–7）、
  `MahjongTile` 的 `w/h`（Task 2）。
- Produces（Board 根 class 约定，测试依赖）：
  - 四个座位卡 `.mj-chip`；左右/自己卡有 `.mj-chip--side/--self`，对家卡在 `.mj__bar` 内。
  - 三个牌背槽 `.mj-backs-slot--top/left/right`。
  - 四个牌河槽 `.mj-river-slot--top/left/right/self`，内部根 `.mj-river--...`。
  - 中央 `.mj-center`；手牌 `.mj__hand`；动作浮层 `.mj__actions`。

- [ ] **Step 1: 写失败测试**

在 `apps/client/test/mahjong-board.test.ts` 末尾追加：

```ts
import { computed } from 'vue';
import { CANVAS_METRICS_KEY } from '../src/composables/useLandscapeCanvas';
import { mahjongTableLayout } from '../src/game/mahjong-layout';

describe('T12：四家分区重排', () => {
  it('四个座位卡、四个牌河、中央井', () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ cardCounts: [14, 10, 7, 0] }) }),
    });
    expect(wrapper.findAll('.mj-chip')).toHaveLength(4);
    expect(wrapper.findAll('.mj-river')).toHaveLength(4);
    expect(wrapper.find('.mj-center').text()).toContain('牌墙 40');
  });

  it('对手牌背数量与 src 逐座对位（不是只数个数）', () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ cardCounts: [14, 10, 7, 0] }) }),
    });
    // me=0：right=1 → 10，top=2 → 7，left=3 → 0
    expect(wrapper.findAll('.mj-backs-slot--right .mj-tile')).toHaveLength(10);
    expect(wrapper.findAll('.mj-backs-slot--top .mj-tile')).toHaveLength(7);
    expect(wrapper.findAll('.mj-backs-slot--left .mj-tile')).toHaveLength(0);
    for (const img of wrapper.findAll('.mj-backs-slot image')) {
      expect(img.attributes('src') ?? '').toMatch(/back\.png$/);
    }
  });

  it('提供画布尺寸时手牌尺寸与纯函数逐值一致', () => {
    const metrics = computed(() => ({ width: 1623, height: 750, scale: 1 }));
    const wrapper = mount(MahjongBoard, {
      props: props(),
      global: { provide: { [CANVAS_METRICS_KEY]: metrics } },
    });
    const layout = mahjongTableLayout(1623, 750);
    const first = wrapper.find('.mj__hand .mj-tile');
    expect(first.attributes('style')).toContain(`width: ${layout.hand.tile.w}px`);
    expect(first.attributes('style')).toContain(`height: ${layout.hand.tile.h}px`);
  });

  it('左右家已胡：牌河区亮牌；对家已胡：牌背位亮牌', () => {
    const leftHu = mount(MahjongBoard, {
      props: props({
        view: view({
          isOut: [false, false, false, true],
          revealedHands: [
            { seat: 3, tiles: [{ s: 0, r: 1 }, { s: 1, r: 2 }], huTile: { s: 1, r: 2 } },
          ],
        }),
      }),
    });
    expect(leftHu.find('.mj-river--left .mj-river__revealed').exists()).toBe(true);
    expect(leftHu.findAll('.mj-backs-slot--left .mj-tile')).toHaveLength(0);

    const topHu = mount(MahjongBoard, {
      props: props({
        view: view({
          isOut: [false, false, true, false],
          revealedHands: [
            { seat: 2, tiles: [{ s: 0, r: 1 }, { s: 1, r: 2 }], huTile: { s: 1, r: 2 } },
          ],
        }),
      }),
    });
    const topTiles = topHu.findAll('.mj-backs-slot--top .mj-tile');
    expect(topTiles).toHaveLength(2);
    expect(topTiles[0]!.attributes('src') ?? '').not.toMatch(/back\.png$/);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test mahjong-board`
Expected: FAIL —— 没有 `.mj-chip` / `.mj-river` / `.mj-center` / `.mj-backs-slot--*`。

- [ ] **Step 3: 脚本区改动**

在 `MahjongBoard.vue` 的 `<script setup>` 中：

1. import 区：
   把现有 `import { computed, ref, watch, onMounted } from 'vue';` 改为
   `import { computed, inject, ref, watch, onMounted } from 'vue';`，并加：

```ts
import { CANVAS_METRICS_KEY } from '../../../composables/useLandscapeCanvas';
import { mahjongTableLayout, type Rect } from '../../../game/mahjong-layout';
import MahjongSeatChip from './MahjongSeatChip.vue';
import MahjongHandBacks from './MahjongHandBacks.vue';
import MahjongRiver from './MahjongRiver.vue';
import MahjongCenter from './MahjongCenter.vue';
import MahjongTile from './MahjongTile.vue';
```

  **删除** `import MahjongSeatPanel` / `import MahjongMeld` / `import TurnTimer`。

2. 在 `const me/leftSeat/rightSeat/topSeat` 之后加：

```ts
const stageMetrics = inject(CANVAS_METRICS_KEY, null);
const canvas = computed(() => stageMetrics?.value ?? { width: 1334, height: 750, scale: 1 });

function seatLoad(seat: number) {
  return {
    discards: (props.view?.discards[seat] ?? []).length,
    melds: (props.view?.melds[seat] ?? []).length,
  };
}
const loads = computed(() => ({
  top: seatLoad(topSeat.value),
  left: seatLoad(leftSeat.value),
  right: seatLoad(rightSeat.value),
  self: seatLoad(me.value),
}));
const layout = computed(() =>
  mahjongTableLayout(canvas.value.width, canvas.value.height, loads.value),
);
function rectStyle(r: Rect) {
  return {
    position: 'absolute' as const,
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
}
const handStyle = computed(() => ({
  ...rectStyle(layout.value.hand.rect),
  gap: `${layout.value.hand.gap}px`,
  '--mj-tile-lift': `${10 * layout.value.s}px`,
}));
const actionsStyle = computed(() => ({
  position: 'absolute' as const,
  right: `${layout.value.actions.rightOffset}px`,
  bottom: `${layout.value.actions.bottomOffset}px`,
  maxWidth: `${layout.value.actions.maxWidth}px`,
  minHeight: `${layout.value.actions.minHeight}px`,
  zIndex: 3,
}));
const trusteeMaskStyle = computed(() => ({
  bottom: `${canvas.value.height - (layout.value.hand.rect.top - 8 * layout.value.s)}px`,
}));
```

3. 在 `nameOf/seatBalance/pendingDelta` 之后加：

```ts
function seatView(seat: number) {
  return {
    cardCount: props.view?.cardCounts[seat] ?? 0,
    lackSuit: props.view?.lackSuits[seat] ?? null,
    hu: props.view?.huInfos.find((h) => h.seat === seat) ?? null,
    isOut: props.view?.isOut[seat] ?? false,
    trustee: props.view?.trustees[seat] ?? false,
    ting: (props.view?.tingSeats ?? []).includes(seat),
    revealed: props.view?.revealedHands.find((r) => r.seat === seat) ?? null,
  };
}
function chipProps(seat: number, variant: 'self' | 'side' | 'bar') {
  const v = seatView(seat);
  return {
    name: nameOf(seat),
    isMe: seat === me.value,
    isDealer: seat === dealerSeat.value,
    cardCount: v.cardCount,
    lackSuit: v.lackSuit,
    hu: v.hu,
    isOut: v.isOut,
    trustee: v.trustee,
    ting: v.ting,
    activeLevel: seatActiveLevel(seat),
    balance: seatBalance(seat),
    pendingDelta: pendingDelta(seat),
    avatar: variant === 'bar' ? layout.value.barChip.w : layout.value.selfChip.width,
    variant,
  };
}
function backsProps(seat: number) {
  const v = seatView(seat);
  const isTop = seat === topSeat.value;
  const backs = isTop
    ? layout.value.topBacks
    : seat === leftSeat.value
      ? layout.value.leftBacks
      : layout.value.rightBacks;
  const revealed = isTop ? v.revealed : null;
  const sideRevealed = !isTop && v.revealed !== null;
  return {
    count: revealed || sideRevealed ? 0 : v.cardCount,
    direction: (isTop ? 'top' : seat === leftSeat.value ? 'left' : 'right') as
      | 'top'
      | 'left'
      | 'right',
    tileW: backs.tile.w,
    tileH: backs.tile.h,
    gap: isTop ? layout.value.topBacks.gap : 0,
    pitch: isTop ? 0 : layout.value.leftBacks.pitch,
    revealed,
  };
}
function riverMelds(seat: number) {
  return (props.view?.melds[seat] ?? []).map((m) => {
    const key = meldKey(m);
    return { key, meld: m, pop: newMeldKeySet.value.has(key) };
  });
}
function riverProps(seat: number) {
  const l = layout.value;
  const isTop = seat === topSeat.value;
  const isLeft = seat === leftSeat.value;
  const river = isTop ? l.topRiver : isLeft ? l.leftRiver : seat === rightSeat.value ? l.rightRiver : l.ownRiver;
  const v = seatView(seat);
  return {
    discards: props.view?.discards[seat] ?? [],
    melds: riverMelds(seat),
    direction: directionOf(seat),
    tileW: river.tile.w,
    tileH: river.tile.h,
    gap: river.gap,
    cols: river.cols,
    rows: river.rows,
    meldTileW: river.meld.tile.w,
    meldTileH: river.meld.tile.h,
    meldOverlap: river.meld.overlap,
    meldPlacement: river.meld.placement,
    meldGap: river.meld.gap,
    meldHeight: river.meld.height,
    filterTileType: discardClickTarget.value ? tileType(discardClickTarget.value) : null,
    interactive: phase.value === 'claim' && amActive.value,
    revealed: isLeft || seat === rightSeat.value ? v.revealed : null,
  };
}
const hasActions = computed(() => {
  if (props.settlementArrived || props.settlementRevealed) return false;
  if (!props.interactive || !amActive.value) return false;
  return (
    phase.value === 'exchange' ||
    phase.value === 'lack' ||
    phase.value === 'play' ||
    phase.value === 'claim'
  );
});
const centerProps = computed(() => ({
  wallCount: wallCount.value,
  phaseText: phaseText.value,
  claimTile: claimTile.value,
  claimW: layout.value.centerTiles.claim.w,
  claimH: layout.value.centerTiles.claim.h,
  tingTiles: tingTiles.value,
  tingW: layout.value.centerTiles.ting.w,
  tingH: layout.value.centerTiles.ting.h,
  maxFan: props.view?.maxFanForMe ?? null,
  seconds: props.seconds,
  active: amActive.value && !props.settlementRevealed,
  compact: layout.value.centerCompact,
  endedText:
    phase.value === 'ended'
      ? '本局结束'
      : endReason.value > 0
        ? `已胡 ${endReason.value} 家`
        : '',
}));
```

4. 删除旧的 `seatPanelProps` 函数（不再使用）；保留 `nameOf/seatBalance/pendingDelta/seatActiveLevel/directionOf/meldKey/onMeldPopDone` 及所有 claim/banner/提示逻辑。
   同时删除点：`myDiscards` / `myMelds` / `myHu` / `myLack` / `myPendingDelta`（新分区已不再引用），
   并在 `handSelectable` 开头加 `if (myRevealed.value) return false;`（已胡者不可选牌）。

5. `bannerPosition` 改为：

```ts
function bannerPosition(seat: number): { leftPct: number; topPct: number } {
  if (seat === me.value) return { leftPct: 50, topPct: 82 };
  if (seat === topSeat.value) return { leftPct: 50, topPct: 20 };
  if (seat === leftSeat.value) return { leftPct: 14, topPct: 48 };
  return { leftPct: 86, topPct: 48 };
}
```

- [ ] **Step 4: 模板区改动**

把 `MahjongBoard.vue` 模板中 **`<view v-if="waitingForDeal">` 之后到 `<view v-if="myTrustee...">` 之前** 的
分区/手牌/动作块整体替换为：

```vue
    <view v-if="waitingForDeal" class="mj__waiting">已进房，等待服务端发牌…</view>
    <template v-else>
      <MahjongHandBacks
        class="mj-backs-slot mj-backs-slot--top"
        v-bind="backsProps(topSeat)"
        :style="rectStyle(layout.topBacks.rect)"
      />
      <MahjongHandBacks
        class="mj-backs-slot mj-backs-slot--left"
        v-bind="backsProps(leftSeat)"
        :style="rectStyle(layout.leftBacks.rect)"
      />
      <MahjongHandBacks
        class="mj-backs-slot mj-backs-slot--right"
        v-bind="backsProps(rightSeat)"
        :style="rectStyle(layout.rightBacks.rect)"
      />

      <MahjongSeatChip v-bind="chipProps(leftSeat, 'side')" :style="rectStyle(layout.leftChip)" />
      <MahjongSeatChip v-bind="chipProps(rightSeat, 'side')" :style="rectStyle(layout.rightChip)" />
      <MahjongSeatChip v-bind="chipProps(me, 'self')" :style="rectStyle(layout.selfChip)" />

      <MahjongRiver
        class="mj-river-slot mj-river-slot--top"
        v-bind="riverProps(topSeat)"
        :style="rectStyle(layout.topRiver.rect)"
        @discard-click="onSeatDiscardClick(topSeat, $event)"
        @meld-pop-done="onMeldPopDone"
      />
      <MahjongRiver
        class="mj-river-slot mj-river-slot--left"
        v-bind="riverProps(leftSeat)"
        :style="rectStyle(layout.leftRiver.rect)"
        @discard-click="onSeatDiscardClick(leftSeat, $event)"
        @meld-pop-done="onMeldPopDone"
      />
      <MahjongRiver
        class="mj-river-slot mj-river-slot--right"
        v-bind="riverProps(rightSeat)"
        :style="rectStyle(layout.rightRiver.rect)"
        @discard-click="onSeatDiscardClick(rightSeat, $event)"
        @meld-pop-done="onMeldPopDone"
      />
      <MahjongRiver
        class="mj-river-slot mj-river-slot--self"
        v-bind="riverProps(me)"
        :style="rectStyle(layout.ownRiver.rect)"
        @discard-click="onSeatDiscardClick(me, $event)"
        @meld-pop-done="onMeldPopDone"
      />

      <MahjongCenter v-bind="centerProps" :style="rectStyle(layout.centerCard)" />

      <view class="mj__hand" :style="handStyle">
        <template v-if="myRevealed">
          <MahjongTile
            v-for="(t, i) in myRevealed.tiles"
            :key="`my-revealed-${i}`"
            :tile="t"
            direction="my"
            :w="layout.hand.tile.w"
            :h="layout.hand.tile.h"
            dim
          />
        </template>
        <template v-else>
          <MahjongTile
            v-for="(tile, i) in hand"
            :key="`hand-${phase}-${i}`"
            :tile="tile"
            direction="my"
            :w="layout.hand.tile.w"
            :h="layout.hand.tile.h"
            :selected="selected.includes(i)"
            :disabled="!handSelectable"
            :class="{
              'anim-fly-out': flyingOutIndex === i,
              'anim-deal-in': phase === 'play',
            }"
            :style="{ '--ftl-delay': `${i * 30}ms` }"
            @click="onTileClick(i)"
            @longpress="onTileLongPress(i)"
          />
        </template>
        <view
          v-if="phase === 'play' && handSelectable && selected.length === 1"
          class="mj__hand-hint"
        >
          <text>再点一次出牌（或点"出牌"按钮）</text>
        </view>
      </view>

      <view v-if="hasActions" class="mj__actions" :style="actionsStyle">
        <template v-if="phase === 'exchange'">
          <text class="mj__hint">已选 {{ selected.length }}/3</text>
          <button
            type="button"
            class="btn btn--primary mj__confirm"
            :disabled="busy || !exchangeReady"
            @click="onExchange"
          >
            换三张
          </button>
          <text v-if="selected.length === 3 && !exchangeReady" class="mj__warn">
            必须同花色
          </text>
        </template>

        <template v-else-if="phase === 'lack'">
          <button
            v-for="suit in ([0, 1, 2] as const)"
            :key="`lack-${suit}`"
            type="button"
            class="btn mj__lack"
            :class="{
              'anim-lack-pulse': lackRecommendation === suit,
              'mj__lack--recommend': lackRecommendation === suit,
            }"
            :disabled="busy"
            @click="onLack(suit)"
          >
            缺{{ MAHJONG_SUIT_NAMES[suit] }}
            <text v-if="lackRecommendation === suit" class="mj__lack--hint">推荐</text>
          </button>
        </template>

        <template v-else-if="phase === 'play'">
          <button
            v-for="(opt, i) in myClaims"
            :key="claimKey(opt, i)"
            type="button"
            class="btn mj__claim"
            :class="{ 'btn--primary': opt.claim === 'hu' }"
            :disabled="busy"
            @click="onClaimOption(opt)"
          >
            {{ claimLabel(opt) }}
          </button>
          <button
            type="button"
            class="btn btn--primary mj__discard"
            :disabled="busy || selectedTiles.length !== 1"
            @click="onDiscard"
          >
            出牌
          </button>
        </template>

        <ClaimTile
          v-else-if="phase === 'claim'"
          :options="myClaims"
          :filtered-options="discardClickTarget ? filteredClaimsForDiscard : undefined"
          :busy="busy"
          :show-pass="canPass"
          @claim="submitClaim"
          @pass="submitPass"
        />
      </view>

      <view
        v-if="myTrustee && !settlementRevealed && phase !== 'ended'"
        class="mj__trustee-mask"
        :style="trusteeMaskStyle"
        @click.stop
      >
        <text class="mj__trustee-title">托管中</text>
        <text class="mj__trustee-desc">轮到你时将自动出牌</text>
        <button
          type="button"
          class="btn btn--primary mj__trustee-cancel"
          :disabled="busy"
          @click="onTrustee(false)"
        >
          取消托管
        </button>
      </view>
    </template>
```

顶栏：把 `.mj__bar` 根加 `:style="rectStyle(layout.bar)"`，从 `mj__bar-center` 删除「牌墙」文本，
在 `mj__bar-right` 最前面加：

```vue
        <MahjongSeatChip
          v-if="view"
          v-bind="chipProps(topSeat, 'bar')"
          :style="{ height: `${layout.barChip.h}px` }"
        />
```

- [ ] **Step 5: 样式区改动（只做不破坏新布局的部分）**

- `.mj` 的 `padding` 改为 `0`（绝对分区自己留 12s）。
- `.mj__hand` 删除 `overflow-x: auto` / `min-height: 79px` / `:deep(.mj-tile) margin-left:-18px`；
  改为：

```scss
.mj__hand {
  position: absolute;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: visible;
}
```

- `.mj__hand-hint` 改到上方（新底距只有 12s）：

```scss
.mj__hand-hint {
  position: absolute;
  top: -20px;
  bottom: auto;
  left: 50%;
  transform: translateX(-50%);
  padding: 0 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  font-size: 11px;
  color: $ftl-color-gold-light;
  pointer-events: none;
  white-space: nowrap;
}
```

- 删除 `.mj__hand--ting::after`（听牌交给座位卡/中央井）。
- `.mj__actions` 新增：

```scss
.mj__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: flex-end;
  gap: $ftl-space-3;
}
```

- `.mj__bar` 改为绝对顶栏：

```scss
.mj__bar {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $ftl-space-5;
  padding: 0 20px;
}
```

- 装饰图尺寸乘 s：

```scss
.mj::before,
.mj::after,
.mj__corner-bot {
  width: calc(var(--mj-s, 1) * 72px);
  height: calc(var(--mj-s, 1) * 72px);
}
```

- 保留 `.btn` / `.mj__lack--recommend` / `.mj__trustee-mask` / `.mj__hand-hint-popup` /
  `.mj__waiting` 等现有规则；Task 10 再删旧分区样式。

- [ ] **Step 6: 跑绿**

Run: `pnpm -C apps/client test mahjong-board`
Expected: PASS（现有 6 条 + 新增 4 条）。

Run: `pnpm -C apps/client run lint`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongBoard.vue \
        apps/client/test/mahjong-board.test.ts
git commit -m "refactor(mahjong): 牌桌改为四家分区比例布局
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 摸牌分离 + 选择下标映射

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- Modify: `apps/client/test/mahjong-board.test.ts`（只加用例）

**Interfaces:**
- Consumes: `tileType` / `sortTiles`（protocol）、`layout.hand.gap/drawnGap`（Task 1）。
- Produces: 手牌 display 模型 `displayTiles: Array<{ tile: Tile; drawn: boolean }>`；
  所有选择/点击/出牌/提示/交换一律用 display 下标；根类 `mj__hand-tile--drawn`。

- [ ] **Step 1: 写失败测试**

追加到 `mahjong-board.test.ts`：

```ts
import { nextTick } from 'vue';

describe('T13：摸牌分离与 display 下标', () => {
  const baseHand = view().hand;

  it('13→14：新增牌移到行尾并标 drawn', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.setProps({
      view: view({ hand: [...baseHand, { s: 1, r: 9 }] }),
    });
    await nextTick();
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    expect(tiles).toHaveLength(14);
    const last = tiles[tiles.length - 1]!;
    expect(last.classes()).toContain('mj__hand-tile--drawn');
    expect(last.attributes('aria-label')).toBe('筒9');
  });

  it('14→13 / 13→13 不标 drawn', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ hand: [...baseHand, { s: 1, r: 9 }] }) }),
    });
    await wrapper.setProps({ view: view({ hand: baseHand }) });
    await nextTick();
    expect(wrapper.findAll('.mj__hand-tile--drawn')).toHaveLength(0);
  });

  it('点行尾摸牌再出牌，emit 的是那张摸牌（不是下标错位）', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.setProps({ view: view({ hand: [...baseHand, { s: 1, r: 9 }] }) });
    await nextTick();
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    await tiles[tiles.length - 1]!.trigger('click');
    await wrapper.find('.mj__discard').trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({
      type: 'discard',
      tile: { s: 1, r: 9 },
    });
  });

  it('换三张仍按 display 下标选牌', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ state: 'exchange', activeSeats: [0], windowId: 'exchange' }) }),
    });
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    await tiles[0]!.trigger('click');
    await tiles[1]!.trigger('click');
    await tiles[2]!.trigger('click');
    await wrapper.find('.mj__confirm').trigger('click');
    const emitted = wrapper.emitted('mahjong')?.[0]?.[0] as { tiles: unknown[] };
    expect(emitted.tiles).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm -C apps/client test mahjong-board`
Expected: FAIL —— 无 `drawn` 类；点行尾出牌 emit 错牌。

- [ ] **Step 3: 改脚本**

在 `const hand = computed(...)` 之后加：

```ts
const drawnType = ref<number | null>(null);
const prevHandTypes = ref<number[]>([]);

function findAdded(prev: number[], next: number[]): number | null {
  const counts = new Map<number, number>();
  for (const t of prev) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const t of next) {
    const c = counts.get(t) ?? 0;
    if (c > 0) counts.set(t, c - 1);
    else return t;
  }
  return null;
}

watch(
  () => (props.view?.hand ?? []).map((t) => tileType(t)),
  (next) => {
    const prev = prevHandTypes.value;
    drawnType.value = next.length === prev.length + 1 ? findAdded(prev, next) : null;
    prevHandTypes.value = next;
  },
  { immediate: true },
);

watch(
  () => props.view?.state,
  (to) => {
    if (to === 'exchange' || to === 'ended' || to === undefined) drawnType.value = null;
  },
);

const displayTiles = computed<Array<{ tile: Tile; drawn: boolean }>>(() => {
  const entries = hand.value.map((tile) => ({ tile, drawn: false }));
  if (drawnType.value === null) return entries;
  const idx = entries.findIndex((e) => tileType(e.tile) === drawnType.value);
  if (idx < 0) return entries;
  const [entry] = entries.splice(idx, 1);
  return [...entries, { tile: entry!.tile, drawn: true }];
});
```

把以下 computed/函数从 `hand` 下标改为 `displayTiles`：

```ts
const selectedTiles = computed<Tile[]>(() =>
  selected.value
    .map((i) => displayTiles.value[i]?.tile)
    .filter((t): t is Tile => t !== undefined),
);

// onTileClick：两处取牌都改成 displayTiles
const tile = displayTiles.value[index]?.tile;
// 双击分支里：
const entry = displayTiles.value[index];
if (entry && !props.busy) {
  flyingOutIndex.value = index;
  submit({ type: 'discard', tile: entry.tile });
  selected.value = [];
  lastClickIndex.value = -1;
}

// handHintAffected（完整替换现有 computed）：
const handHintAffected = computed(() => {
  if (handHintIndex.value === null) return null;
  const hintEntry = displayTiles.value[handHintIndex.value];
  if (!hintEntry) return null;
  const without = displayTiles.value.filter((_, i) => i !== handHintIndex.value);
  const stillHas = without.some((e) => tileType(e.tile) === tileType(hintEntry.tile));
  return { tile: hintEntry.tile, stillSafe: !stillHas };
});
```

- `onDiscard` / `onExchange` / `exchangeReady` 继续用 `selectedTiles`（无需改）。
- `watch(() => hand.value.map(tileType).join(','))` 继续清 `selected` / `lastClickIndex` / `flyingOutIndex`。
- 所有 `hand[i]` 取牌改为 `displayTiles[i]?.tile`（全局搜 `hand.value[` / `hand[`）。

- [ ] **Step 4: 改模板手牌循环**

把 Task 8 的 `<MahjongTile v-for="(tile, i) in hand" ...>` 改为：

```vue
          <MahjongTile
            v-for="(entry, i) in displayTiles"
            :key="`hand-${phase}-${i}`"
            :tile="entry.tile"
            direction="my"
            :w="layout.hand.tile.w"
            :h="layout.hand.tile.h"
            :selected="selected.includes(i)"
            :disabled="!handSelectable"
            :class="{
              'anim-fly-out': flyingOutIndex === i,
              'anim-deal-in': phase === 'play',
              'mj__hand-tile--drawn': entry.drawn,
            }"
            :style="{
              '--ftl-delay': `${i * 30}ms`,
              marginLeft: entry.drawn
                ? `${layout.hand.drawnGap - layout.hand.gap}px`
                : undefined,
            }"
            @click="onTileClick(i)"
            @longpress="onTileLongPress(i)"
          />
```

- [ ] **Step 5: 跑绿 + 类型检查**

Run: `pnpm -C apps/client test mahjong-board`
Expected: PASS（Task 8 的 4 条 + 本次 4 条 + 现有 6 条）。

Run: `pnpm -C apps/client run lint`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/components/table/mahjong/MahjongBoard.vue \
        apps/client/test/mahjong-board.test.ts
git commit -m "feat(mahjong): 摸牌行尾分离 + display 下标映射
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 删除旧 `MahjongSeatPanel` / 旧分区样式清理

**Files:**
- Delete: `apps/client/src/components/table/mahjong/MahjongSeatPanel.vue`
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`

**Interfaces:**
- Consumes: Task 8/9 的新分区。
- Produces: 无旧座位面板引用；无死 CSS；无未使用 computed/import。

- [ ] **Step 1: 删除文件**

```bash
git rm apps/client/src/components/table/mahjong/MahjongSeatPanel.vue
```

- [ ] **Step 2: 删旧脚本/case**

- 删 `myDiscards` / `myMelds` / `myHu` / `myLack` / `myPendingDelta`（若已无引用）。
- 删 `import MahjongSeatPanel` / `import MahjongMeld` / `import TurnTimer`。
- 全局 grep：`myDiscards|myMelds|myHu|myLack|myPendingDelta|MahjongSeatPanel|TurnTimer`，只允许
  注释/历史文档命中。

- [ ] **Step 3: 删旧样式**

删除 `MahjongBoard.vue` 的 `<style>` 中这些块（新组件已各自持有）：

- `.mj__top` / `.mj__mid` / `.mj__side` / `.mj__center` / `.mj__phase` / `.mj__claim-tile` /
  `.mj__ting` / `.mj__ting-label`
- `.mj__mine` / `.mj__me-meta` / `.mj__me-badge*` / `.mj__my-meld*` / `.mj__my-river` /
  `.mj__my-revealed*`
- `.mj__action` / `.mj__hint`（动作行） / `.mj__warn` / `.mj__ended`
- `.mj__hand--ting::after` / `.mj-river__mask` / `.mj__discard--latest` / `.mj__discard--selected`
- `.mj__hand :deep(.mj-tile)` 相关负 margin / `overflow-x`
- `.mj-seat*`（随组件删除）

保留：`.mj` 底色/装饰、`.mj__bar*`、`.mj__hand`、`.mj__hand-hint`、`.mj__actions`、
`.mj__trustee*`、`.mj__hand-hint-popup*`、`.btn*`、`.mj__lack--*`、`.mj__back*`、`.mj__waiting`、
`.mj__muted`（若仍用）。

- [ ] **Step 4: 跑闸**

Run: `pnpm -C apps/client test`
Expected: PASS（119 文件 + 新文件；无红）。

Run: `pnpm -C apps/client run lint`
Expected: PASS（无未使用变量/导入）。

Run: `git grep -n "MahjongSeatPanel\|TurnTimer" -- apps/client/src/components/table/mahjong`
Expected: 空（或仅注释）。

- [ ] **Step 5: 提交**

```bash
git add -A apps/client/src/components/table/mahjong
git commit -m "refactor(mahjong): 删除旧座位面板与死样式
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: 三档真浏览器截图 + 全量验证

**Files:**
- 本机临时夹具：`apps/client/.tmp-mjpreview/**`（**不是** gitignored；Task 11 Step 5 必须删除，不入库）
- 证据目录：`.superpowers/mahjong-layout-research/**`（gitignored，不入库）

- [ ] **Step 1: 夹具支持注入画布尺寸**

把 `.tmp-mjpreview/preview.ts` 改成：

```ts
import { createApp, h, computed } from 'vue';
import { CANVAS_METRICS_KEY } from '../src/composables/useLandscapeCanvas';
import MahjongBoard from '../src/components/table/mahjong/MahjongBoard.vue';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') ?? 1334);
const H = Number(q.get('h') ?? 750);
// ...现有 view/props 夹具...

const app = createApp({ render: () => h(MahjongBoard, props) });
app.provide(CANVAS_METRICS_KEY, computed(() => ({ width: W, height: H, scale: 1 })));
app.mount('#app');
```

`index.html` 的 `#app` 改为 `width: ${W}px; height: ${H}px`（可在 main.ts 里设置 inline style）。

- [ ] **Step 2: 三档截图**

Run（Vite dev server + Chrome headless，脚本同上一轮）：

```bash
node apps/client/node_modules/vite/bin/vite.js --config apps/client/.tmp-mjpreview/vite.config.mjs
# 另开：
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new \
  --window-size=1334,750 --screenshot=.superpowers/mahjong-layout-research/new-16x9.png \
  "http://localhost:5199/?w=1334&h=750&mode=late"
# 1623×750、1334×1000 同理
```

Expected：截图里能看到四家牌背、四块牌河、中央井、手牌无裁切、左右家不再消失。

- [ ] **Step 3: 视觉核对清单**

- 手牌 14 张完整、行尾摸牌有间隔；
- 对家/左右家牌背数量与方向正确；
- 左右家牌河竖排、副露条在牌河下方；
- 对家牌河上方有副露条（有副露时）；
- 中央井/牌墙文案不被牌河覆盖；
- 动作浮层不盖右家区；托管遮罩不压手牌；
- 4:3 上侧区在竖向居中，不是只挤在上半段。

- [ ] **Step 4: 全量验证**

Run:

```bash
pnpm -C apps/client test
pnpm -C apps/client run lint
pnpm -C apps/client run build:h5
```

Expected：全绿；`build:h5` 成功（验证 SCSS/uni 编译）。

- [ ] **Step 5: 清理临时夹具**

```bash
rm -rf apps/client/.tmp-mjpreview
git status --short   # 必须干净
```

- [ ] **Step 6: 提交（如有视觉修复）**

```bash
git add apps/client/src apps/client/test
git commit -m "fix(mahjong): 牌桌截图走查修复
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: 独立代码审查 + 修复 + 推送 dev

- [ ] **Step 1: 记录审查范围**

```bash
BASE=$(git rev-parse HEAD)   # 开始 Task 1 之前的提交（spec/plan 之后的第一个代码提交的父）
```

- [ ] **Step 2: 派独立 reviewer（子代理）**

审查 `BASE..HEAD` 的代码 diff，对照 spec/plan 逐条核对。重点：
- 布局数学/分区不重叠/跨设备；
- 手牌 display 下标是否所有消费者都改了；
- 摸牌 diff 的幽灵牌/重连/杠边界；
- 牌河/副露/亮牌方向；
- 事件/点击/claim 过滤/换三张/定缺/托管/结算回归；
- z-index/层叠；
- 测试假绿（断言恒真、只数个数、只验证 mock）；
- 仓库闸（ui-tokens/animations/source-boundary）；
- 是否有死代码/未使用 import。
- 分级 Critical / Important / Minor；Critical/Important 必须修。

- [ ] **Step 3: 修复 + 补测试**

按审查结论修复；每个修复补/改测试；重跑受影响测试与全量验证。

- [ ] **Step 4: 最终全量验证**

```bash
pnpm -C apps/client test
pnpm -C apps/client run lint
pnpm -C apps/client run build:h5
git status --short   # 必须干净
```

- [ ] **Step 5: 提交 + 推送 dev**

```bash
git add -A apps/client
git commit -m "fix(mahjong): 代码审查修复
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin dev
```

- [ ] **Step 6: 交付报告**

报告：变更、验证证据（测试数/类型检查/build）、提交 SHA、是否已推 dev、未部署、
已知边界（暗杠协议泄漏另立片、左右家已胡弃牌隐藏、动作浮层盖自己牌河右半）。

---

## 计划审查记录

（待独立 reviewer 审查后填写）

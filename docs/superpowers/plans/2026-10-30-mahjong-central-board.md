# 麻将中央牌板实现计划（2026-10-30，第二片）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 把四川麻将中央区从「四块牌河围井 + 浮动中央卡」改成**中央牌板**：左右侧道拉满牌板全高，
中间列自上而下 = 对家牌河 / 信息格 / 自己牌河；副露移出竖向预算；信息格三档内容。

**Architecture:** 纯函数 `mahjongTableLayout` 输出牌板/四道/信息格/副露条矩形；`MahjongBoard` 只摆槽；
`MahjongRiver` 只画弃牌；副露拆到 `MahjongMeldStrip`；`MahjongCenter` 按 `infoLevel` 渲染三档。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript + SCSS + Vitest/jsdom；uni-app H5/App。

## Global Constraints

- **纯客户端**：只改 `apps/client/src/**`、`apps/client/test/**`、本 spec/plan；
  不动 `packages/**`、`tools/**`、配置中心、admin、数据库、结算、规则、协议、`table.vue`。
- 前端只依赖 `@fight-the-landlord/protocol`；**不得** import `@fight-the-landlord/shared`。
- 样式单位只用 `px`；**禁用** `rpx`/`em`/`rem`/`vw`/`vh`/`pt`；**不得手写 `1px`**（发丝线 `$ftl-hairline`）；
  `line-height` unitless；组件**零 `setTimeout`/`setInterval`**；每个 `.vue` 必须有 `<style lang="scss">`；
  `animations.scss` 只能 `@import`；组件**单根**。
- **不重议**：`s = min(H/750, 0.88W/1041.54)`、四家围桌语法、牌张比例、字号不随 s 放大。
- 每个任务红 → 绿 → 提交；提交信息末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 验证：`pnpm -C apps/client test`、`pnpm -C apps/client run lint`、`pnpm -C apps/client run build:h5`。
  `lint` = `vue-tsc --noEmit`，**tsconfig include `test/**`** ⇒ 测试文件里的未用 import 也会红。
- 基线（2026-10-30 开工前）：**126 files passed + 2 skipped（128）/ 1703 tests passed + 2 skipped（1705）**。

---

### Task 1: `MahjongMeldStrip`（副露条从牌河拆出）

**Files:**
- Create: `apps/client/src/components/table/mahjong/MahjongMeldStrip.vue`
- Create: `apps/client/test/mahjong-meld-strip.test.ts`

**Interfaces:**
- Consumes: `MahjongMeldView`（protocol）、`MahjongMeld`。
- Produces: props
  `melds: Array<{ key: string; meld: MahjongMeldView; pop: boolean }>, direction: 'my'|'top'|'left'|'right',
   tileW: number, tileH: number, overlap: number, groupGap: number, layout: 'row'|'column'`
  emit `pop-done(key: string)`。根 class `mj-strip`、类 `mj-strip--row|--column`、
  组 `.mj-strip__group`、标签 `.mj-strip__label`。`melds` 为空时不渲染根。

- [x] **Step 1: 写失败测试**

新建 `apps/client/test/mahjong-meld-strip.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongMeldView, Tile } from '@fight-the-landlord/protocol';
import MahjongMeldStrip from '../src/components/table/mahjong/MahjongMeldStrip.vue';
import MahjongMeld from '../src/components/table/mahjong/MahjongMeld.vue';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };
type Group = { key: string; meld: MahjongMeldView; pop: boolean };
function group(key: string, meld: MahjongMeldView, pop = false): Group {
  return { key, meld, pop };
}
function props(over: Record<string, unknown> = {}) {
  return {
    melds: [] as Group[],
    direction: 'my' as const,
    tileW: 40,
    tileH: 60,
    overlap: 8,
    groupGap: 8,
    layout: 'row' as const,
    ...over,
  };
}

describe('MahjongMeldStrip', () => {
  it('空副露不渲染根', () => {
    const w = mount(MahjongMeldStrip, { props: props() });
    expect(w.find('.mj-strip').exists()).toBe(false);
  });

  it('碰 3 张 + 杠 4 张同行，标签与组数正确', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({
        melds: [
          group('peng:0_0_0', { kind: 'peng', tiles: [wan1, wan1, wan1] }),
          group('gang:0_0_0_1', { kind: 'gang', tiles: [wan1, wan1, wan1, wan2] }),
        ],
      }),
    });
    expect(w.findAll('.mj-strip__group')).toHaveLength(2);
    expect(w.findAll('.mj-tile')).toHaveLength(7);
    expect(w.text()).toContain('碰');
    expect(w.text()).toContain('杠');
    expect(w.classes()).toContain('mj-strip--row');
  });

  it('暗杠 4 张全牌背', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({ melds: [group('angang', { kind: 'angang', tiles: [wan1, wan1, wan1, wan1] })] }),
    });
    const srcs = w.findAll('image').map((i) => i.attributes('src') ?? '');
    expect(srcs).toHaveLength(4);
    expect(srcs.every((s) => s.endsWith('/back.png'))).toBe(true);
  });

  it('layout=column 加竖排类；组间距落到 style', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({
        layout: 'column',
        groupGap: 4,
        melds: [group('peng:0_0_0', { kind: 'peng', tiles: [wan1, wan1, wan1] })],
      }),
    });
    expect(w.classes()).toContain('mj-strip--column');
    expect(w.attributes('style')).toContain('gap: 4px');
  });

  it('pop 透传 + pop-done 原样上抛 key', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({ melds: [group('peng:0_0_0', { kind: 'peng', tiles: [wan1, wan1, wan1] }, true)] }),
    });
    expect(w.findComponent(MahjongMeld).classes()).toContain('anim-meld-pop');
    w.findComponent(MahjongMeld).vm.$emit('pop-done');
    expect(w.emitted('pop-done')?.[0]).toEqual(['peng:0_0_0']);
  });

  it('tileW/tileH/overlap 透传到每张牌', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({ melds: [group('gang', { kind: 'gang', tiles: [wan1, wan1, wan1, wan2] })] }),
    });
    const tiles = w.findAll('.mj-tile');
    for (const t of tiles) {
      expect(t.attributes('style')).toContain('width: 40px');
      expect(t.attributes('style')).toContain('height: 60px');
    }
    expect(tiles[1]!.attributes('style')).toContain('margin-left: -8px');
  });
});
```

- [x] **Step 2: 跑红** → FAIL（组件不存在）

- [x] **Step 3: 写组件**

新建 `apps/client/src/components/table/mahjong/MahjongMeldStrip.vue`：

```vue
<script setup lang="ts">
/**
 * 副露条（哑组件）：一组或多组碰/杠/暗杠，横排或竖排。
 * 只渲染 props；pop 动画由父组件增量判定后传入，播完上抛 key。
 */
import { computed } from 'vue';
import type { MahjongMeldView } from '@fight-the-landlord/protocol';
import MahjongMeld from './MahjongMeld.vue';

type Direction = 'my' | 'top' | 'left' | 'right';

const props = defineProps<{
  melds: Array<{ key: string; meld: MahjongMeldView; pop: boolean }>;
  direction: Direction;
  tileW: number;
  tileH: number;
  overlap: number;
  groupGap: number;
  layout: 'row' | 'column';
}>();

const emit = defineEmits<{ (e: 'pop-done', key: string): void }>();

const MELD_LABEL: Record<MahjongMeldView['kind'], string> = {
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
};

const stripStyle = computed<Record<string, string>>(() => ({
  display: 'flex',
  flexDirection: props.layout === 'column' ? 'column' : 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: `${props.groupGap}px`,
}));
</script>

<template>
  <view
    v-if="melds.length > 0"
    class="mj-strip"
    :class="`mj-strip--${layout}`"
    :style="stripStyle"
  >
    <view v-for="m in melds" :key="m.key" class="mj-strip__group">
      <text class="mj-strip__label">{{ MELD_LABEL[m.meld.kind] }}</text>
      <MahjongMeld
        :meld="m.meld"
        :direction="direction"
        :tile-w="tileW"
        :tile-h="tileH"
        :overlap="overlap"
        :pop="m.pop"
        @pop-done="emit('pop-done', m.key)"
      />
    </view>
  </view>
</template>

<style scoped lang="scss">
.mj-strip {
  box-sizing: border-box;
}
.mj-strip__group {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mj-strip__label {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  padding: 0 3px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba($ftl-color-on-primary, 0.85);
  font-size: 9px;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
}
</style>
```

- [x] **Step 4: 跑绿 + 类型检查 + 提交**

```bash
pnpm -C apps/client test mahjong-meld-strip && pnpm -C apps/client run lint
git add apps/client/src/components/table/mahjong/MahjongMeldStrip.vue apps/client/test/mahjong-meld-strip.test.ts
git commit -m "feat(mahjong): 副露条拆成独立哑组件 MahjongMeldStrip
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 中央牌板（布局重写 + Board/River 接线）

> ⚠️ **本任务必须一次到位**：新 layout 契约删掉旧字段，Board 是唯一消费者；
> 分两次提交会出现「中间提交编译红」。所以布局、Board、River 与三个测试文件同一提交。

**Files:**
- Modify: `apps/client/src/game/mahjong-layout.ts`（**整体重写中央区**；删 `topZone/leftZone/rightZone/
  centerZone/centerCard/centerCompact/centerTiles/ownRiver/topRiver/leftRiver/rightRiver` 与 `buildRiver`）
- Modify: `apps/client/src/components/table/mahjong/MahjongRiver.vue`
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- Modify: `apps/client/test/mahjong-layout.test.ts`（**整体重写**；旧 helpers `everyRect/expectInCanvas/
  expectInside/expectNoOverlap/expectGridFits/expectAspect/VIEWPORTS/WORST` 一并删除）
- Modify: `apps/client/test/mahjong-river.test.ts`
- Modify: `apps/client/test/mahjong-board.test.ts`

**Interfaces（本任务产出）:**
- `MahjongSeatLoad { discards; melds; gangMelds? }`；`LaneLayout / MeldStripLayout / InfoLevel / LaneOrigin`；
  字段 `board/topLane/bottomLane/leftLane/rightLane/info/infoLevel/infoTiles/topMelds{left,right,below}
  /leftMelds/rightMelds/selfMelds`（完整签名见 spec §5.1）。
- `MahjongRiver`：删副露 props/渲染/`meld-pop-done`；保留
  `discards/direction/tileW/tileH/gap/cols/rows/filterTileType/interactive/revealed`；新增 `source?: boolean`。
  根元素改 `align-items: flex-start; justify-content: flex-start`。
- Board 槽类：`.mj-river-slot--{top,left,right,self}`、`.mj-melds-slot--{top-left,top-right,top-below,left,right,self}`、
  信息格 `mj-info-slot`。

- [x] **Step 1: 改测试（红）**

**(a) `mahjong-layout.test.ts` 整体重写为：**

```ts
import { describe, expect, it } from 'vitest';
import {
  mahjongTableLayout,
  type LaneLayout,
  type MahjongTableInput,
  type MahjongTableLayout,
  type MeldStripLayout,
} from '../src/game/mahjong-layout';

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

      it('牌墙/待响应/听牌三档尺寸', () => {
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
          expect(gridH, `n=${n}`).toBeLessThanOrEqual(x.topLane.rect.height + 0.01);
          const gridW = x.topLane.cols * x.topLane.tile.w + (x.topLane.cols - 1) * x.topLane.gap;
          expect(gridW, `n=${n}`).toBeLessThanOrEqual(x.topLane.rect.width + 0.01);
        }
      });

      it('牌张比例', () => {
        expect(l.topLane.tile.w / l.topLane.tile.h).toBeCloseTo(75 / 113, 6);
        expect(l.leftLane.tile.w / l.leftLane.tile.h).toBeCloseTo(49 / 40, 6);
      });

      it('两侧牌背镜像紧邻侧道', () => {
        expect(l.leftBacks.rect.left + l.leftBacks.rect.width).toBeCloseTo(
          l.leftLane.rect.left - 8 * s, 3,
        );
        expect(l.rightBacks.rect.left).toBeCloseTo(
          l.rightLane.rect.left + l.rightLane.rect.width + 8 * s, 3,
        );
      });

      it('座位卡在桌边、顶 = 牌板顶', () => {
        expect(l.leftChip.left).toBeCloseTo(12 * s, 3);
        expect(l.rightChip.left).toBeCloseTo(v.w - 12 * s - 180 * s, 3);
        expect(l.leftChip.top).toBeCloseTo(l.board.top, 3);
        expect(l.rightChip.top).toBeCloseTo(l.board.top, 3);
      });

      it('所有矩形合法（EMPTY + WORST）', () => {
        for (const input of [EMPTY, WORST]) {
          const x = mahjongTableLayout(v.w, v.h, input);
          const rects = [x.bar, x.board, x.info, ...lanesOf(x).map((r) => r.rect),
            x.topBacks.rect, x.leftBacks.rect, x.rightBacks.rect,
            x.selfChip, x.leftChip, x.rightChip, x.hand.rect, ...stripsOf(x).map((r) => r.rect)];
          for (const r of rects) {
            for (const val of [r.left, r.top, r.width, r.height]) expect(Number.isFinite(val)).toBe(true);
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
    expect(mahjongTableLayout(1334, 833, WORST).topMelds.below.height).toBeCloseTo(48.75 * (833 / 750), 3);
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

  it('16:9 各 1 碰：信息格 127.25、牌板 431.25、对家副露在牌背两翼', () => {
    const l = mahjongTableLayout(1334, 750, ONE);
    expect(l.board.height).toBeCloseTo(431.25, 3);
    expect(l.info.height).toBeCloseTo(127.25, 3);
    expect(l.topMelds.below.groups).toBe(0);
    expect(l.topMelds.right.rect.left).toBeCloseTo(l.topBacks.rect.left + l.topBacks.rect.width + 8, 3);
    expect(l.topMelds.left.rect.left + l.topMelds.left.rect.width).toBeCloseTo(l.topBacks.rect.left - 8, 3);
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
    expect(l.selfMelds.rect.top + l.selfMelds.rect.height).toBeLessThanOrEqual(l.hand.rect.top + 0.01);
    expect(l.leftMelds.rect.left + l.leftMelds.rect.width).toBeLessThanOrEqual(l.leftLane.rect.left + 0.01);
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
    expect(mahjongTableLayout(1334, 750, WORST)).toEqual(mahjongTableLayout(1334, 750, WORST));
  });

  it('非法输入回落 1334×750，无 NaN、无负矩形', () => {
    for (const [w, h] of [[0, 0], [-1, 100], [Number.NaN, 750], [1334, Number.POSITIVE_INFINITY], [100, 100]]) {
      const l = mahjongTableLayout(w, h, EMPTY);
      expect(Number.isFinite(l.s)).toBe(true);
      for (const r of [l.board, l.info, ...lanesOf(l).map((x) => x.rect)]) {
        for (const val of [r.left, r.top, r.width, r.height]) expect(Number.isFinite(val)).toBe(true);
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.width).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
```

**(b) `mahjong-river.test.ts`：** 顶部加 `import { readFileSync } from 'node:fs';`；
删 `MahjongMeld` 与 `MahjongMeldView` 的 import 与 4 条副露用例；`props()` 删
`melds/meldTileW/meldTileH/meldOverlap/meldPlacement/meldGap/meldGroupGap/meldHeight`；新增：

```ts
it('source=true 加来源道类', () => {
  expect(mount(MahjongRiver, { props: props({ source: true }) }).classes()).toContain('mj-river--source');
  expect(mount(MahjongRiver, { props: props() }).classes()).not.toContain('mj-river--source');
});
it('网格从左上起排（源码闸，防行数增长时整块漂移）', () => {
  const src = readFileSync('src/components/table/mahjong/MahjongRiver.vue', 'utf8');
  expect(src).toMatch(/\.mj-river\s*\{[^}]*align-items:\s*flex-start/);
  expect(src).toMatch(/\.mj-river\s*\{[^}]*justify-content:\s*flex-start/);
});
```

**(c) `mahjong-board.test.ts`：** 副露 pop 选择器改 `.mj-melds-slot--left` / `.mj-melds-slot--top-right`；新增：

```ts
it('四道与信息格 rect 与纯函数逐值一致（1334×1000）', () => {
  const metrics = computed(() => ({ width: 1334, height: 1000, scale: 1 }));
  const wrapper = mount(MahjongBoard, {
    props: props(), global: { provide: { [CANVAS_METRICS_KEY]: metrics } },
  });
  const l = mahjongTableLayout(1334, 1000);
  const expectRect = (sel: string, r: { left: number; top: number; width: number; height: number }) => {
    const el = wrapper.find(sel);
    expect(el.exists(), sel).toBe(true);
    expect(el.attributes('style')).toContain(`left: ${r.left}px`);
    expect(el.attributes('style')).toContain(`top: ${r.top}px`);
    expect(el.attributes('style')).toContain(`width: ${r.width}px`);
    expect(el.attributes('style')).toContain(`height: ${r.height}px`);
  };
  expectRect('.mj-river-slot--top', l.topLane.rect);
  expectRect('.mj-river-slot--left', l.leftLane.rect);
  expectRect('.mj-river-slot--right', l.rightLane.rect);
  expectRect('.mj-river-slot--self', l.bottomLane.rect);
  expectRect('.mj-info-slot', l.info);
  expect(wrapper.find('.mj-info-slot').text()).toContain('牌墙 40');
});

it('claim 窗口只有来源道带 source 类', () => {
  const wrapper = mount(MahjongBoard, {
    props: props({
      view: view({ state: 'claim', currentPlayer: 2, activeSeats: [0], claimsForMe: [{ claim: 'peng', tile: { s: 0, r: 1 } }] }),
    }),
  });
  expect(wrapper.find('.mj-river--top').classes()).toContain('mj-river--source');
  expect(wrapper.find('.mj-river--left').classes()).not.toContain('mj-river--source');
  expect(wrapper.find('.mj-river--my').classes()).not.toContain('mj-river--source');
});

it('1334×833 对家 4 杠：下移条存在、两翼不渲染（互斥）', () => {
  const metrics = computed(() => ({ width: 1334, height: 833, scale: 1 }));
  const gang = { kind: 'gang' as const, tiles: [tile(0, 1), tile(0, 1), tile(0, 1), tile(0, 2)] };
  const wrapper = mount(MahjongBoard, {
    props: props({ view: view({ melds: [[], [], [gang, gang, gang, gang], []] }) }),
    global: { provide: { [CANVAS_METRICS_KEY]: metrics } },
  });
  expect(wrapper.find('.mj-melds-slot--top-below').exists()).toBe(true);
  expect(wrapper.find('.mj-melds-slot--top-right').exists()).toBe(false);
  expect(wrapper.find('.mj-melds-slot--top-left').exists()).toBe(false);
});
```

- [x] **Step 2: 跑红**

```bash
pnpm -C apps/client test mahjong-layout mahjong-river mahjong-board
```

- [x] **Step 3: 重写 `mahjong-layout.ts`**

删旧中央区与 `buildRiver`；按 §附录 A 实现新函数。**保留** `s` 公式、`hand`、`topBacks/leftBacks/
rightBacks`、`selfChip/leftChip/rightChip`、`barChip`、`actions`（公式更新）、`MAHJONG_TABLE_TOKENS`
（新增 6 个 token；`meldScale` 由 0.8 改 0.65）。

- [x] **Step 4: 改 `MahjongRiver.vue`**

删 `MahjongMeld` import、`MELD_LABEL`、`vertical`、副露 props/模板/样式、`meld-pop-done`；
加 `source?: boolean`；根类加 `mj-river--source`；`.mj-river` 的 `align-items/justify-content` 改
`flex-start`；`.mj-river__grid` 的 `align-content/justify-content` 改 `start`；
`.mj-river--source` 用 `outline`（不占布局）。

- [x] **Step 5: 改 `MahjongBoard.vue`**

1. 删 `MahjongMeld` 相关与旧 `riverProps` 的副露字段；`loads` 加 `gangMelds`
   （`melds.filter((m) => m.tiles.length === 4).length`）。
2. `isSource(seat)` 一处计算，`interactive` 与 `source` 共用。
3. `meldGroups(seat)`、`topStripProps(which)`（`below.groups > 0` 时两翼强制空）、
   `sideStripProps(seat, strip)`、`selfStripProps()`。
4. 模板：四道 `MahjongRiver`（`rectStyle(lane.rect)`）+ 六处 `MahjongMeldStrip`
   （`v-if` 由组数决定；类名见 Interfaces）+ `MahjongCenter class="mj-info-slot"`
   （`:style="rectStyle(layout.info)"`）。
5. `centerProps` 暂时保持旧 Center 形状：`compact: layout.infoLevel === 'compact'`、
   `claimW/H: layout.infoTiles.claim.*`、`tingW/H: layout.infoTiles.ting.*`、`endedText` 维持旧计算。
6. `actionsStyle` 用 `layout.actions.rightOffset/bottomOffset`。

- [x] **Step 6: 跑绿 + 类型检查**

```bash
pnpm -C apps/client test mahjong-layout mahjong-river mahjong-board && pnpm -C apps/client run lint
```

- [x] **Step 7: 提交**

```bash
git add apps/client/src/game/mahjong-layout.ts \
        apps/client/src/components/table/mahjong/MahjongBoard.vue \
        apps/client/src/components/table/mahjong/MahjongRiver.vue \
        apps/client/test/mahjong-board.test.ts apps/client/test/mahjong-river.test.ts \
        apps/client/test/mahjong-layout.test.ts
git commit -m "feat(mahjong): 中央牌板（四道全高/信息格嵌中/副露条移位/牌河起点对齐）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 信息格三档重写

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongCenter.vue`
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- Modify: `apps/client/test/mahjong-center.test.ts`
- Modify: `apps/client/test/mahjong-board.test.ts`（若文案变化）

**Interfaces:**
- `MahjongCenter` props：`wallCount, phaseText, level: 'full'|'dense'|'compact', claimTile?, claimW?, claimH?,
  claimLabel?, claimFrom?, tingTiles?, tingW?, tingH?, maxFan?, seconds, active?`。删 `compact`/`endedText`。
- 组件内**不得**再用 `claimLabel` 作局部 computed（会遮蔽 prop）；局部牌名 computed 改名
  `claimTileLabel`（`MAHJONG_SUIT_NAMES[s] + r`）。

- [x] **Step 1: 改测试（红）**

`mahjong-center.test.ts`：`base` 改为
`{ wallCount: 42, phaseText: '请出牌', level: 'full' as const, seconds: 12, active: true, claimW: 34, claimH: 51, tingW: 20, tingH: 30 }`
（删 `compact`/`endedText` 相关），并重写用例：

```ts
it('full：牌墙/阶段/倒计时/待响应/来源座/听牌/番', () => {
  const w = mount(MahjongCenter, { props: { ...base, claimTile: { s: 0, r: 5 },
    claimFrom: '东家甲打出', tingTiles: [{ s: 0, r: 5 }, { s: 0, r: 8 }], maxFan: 5 } });
  expect(w.text()).toContain('牌墙 42');
  expect(w.text()).toContain('请出牌');
  expect(w.text()).toContain('东家甲打出');
  expect(w.text()).toContain('听');
  expect(w.text()).toContain('5 番');
  expect(w.findAll('.mj-tile')).toHaveLength(3);
});
it('dense：有听牌也不渲染听牌列表', () => {
  const w = mount(MahjongCenter, { props: { ...base, level: 'dense', tingTiles: [{ s: 0, r: 5 }] } });
  expect(w.find('.mj-center__ting').exists()).toBe(false);
  expect(w.text()).toContain('牌墙 42');
});
it('compact：单行、无牌面、claim 只出文字', () => {
  const w = mount(MahjongCenter, { props: { ...base, level: 'compact', claimTile: { s: 0, r: 5 } } });
  expect(w.classes()).toContain('mj-center--compact');
  expect(w.findAll('image')).toHaveLength(0);
  expect(w.text()).toContain('可响应');
  expect(w.text()).toContain('万5');
});
it('可自摸胡文案', () => {
  const w = mount(MahjongCenter, { props: { ...base, claimTile: { s: 0, r: 5 }, claimLabel: '可自摸胡' } });
  expect(w.text()).toContain('可自摸胡');
});
it('末 5 秒紧迫类；active=false 不出倒计时', () => {
  expect(mount(MahjongCenter, { props: { ...base, seconds: 4 } })
    .find('.mj-center__clock').classes()).toContain('mj-center__clock--urgent');
  expect(mount(MahjongCenter, { props: { ...base, seconds: 6 } })
    .find('.mj-center__clock').classes()).not.toContain('mj-center__clock--urgent');
  expect(mount(MahjongCenter, { props: { ...base, active: false } })
    .find('.mj-center__clock').exists()).toBe(false);
});
it('紧凑模式字号仍 11px（源码闸）', () => {
  const src = readFileSync('src/components/table/mahjong/MahjongCenter.vue', 'utf8');
  expect(src).toMatch(/\.mj-center--compact \.mj-center__wall,[\s\S]*?font-size: 11px/);
});
it('不再渲染「已胡 N 家」', () => {
  const w = mount(MahjongCenter, { props: base });
  expect(w.text()).toContain('牌墙 42');
  expect(w.text()).not.toContain('已胡');
});
```

- [x] **Step 2: 跑红** → FAIL（`level` 未定义）

- [x] **Step 3: 写组件**（模板骨架见 spec §5.4；字号 full/dense 两档；compact 保留 11px 规则；
  phase 保留 `min-width:0 + ellipsis`，clock `flex-shrink:0`）

- [x] **Step 4: Board 换 centerProps 并删 `endReason`/`endedText`**

```ts
const claimTileForCenter = computed(() => {
  if (phase.value === 'claim') return claimTile.value;
  if (phase.value === 'play' && myClaims.value.some((o) => o.claim === 'hu')) return claimTile.value;
  return null;
});
const centerProps = computed(() => ({
  wallCount: wallCount.value, phaseText: phaseText.value,
  level: layout.value.infoLevel,
  claimTile: claimTileForCenter.value,
  claimW: layout.value.infoTiles.claim.w, claimH: layout.value.infoTiles.claim.h,
  claimLabel: phase.value === 'play' ? '可自摸胡' : '可响应',
  claimFrom: phase.value === 'claim' ? `${nameOf(props.view?.currentPlayer ?? 0)}打出` : '',
  tingTiles: tingTiles.value,
  tingW: layout.value.infoTiles.ting.w, tingH: layout.value.infoTiles.ting.h,
  maxFan: props.view?.maxFanForMe ?? null,
  seconds: props.seconds, active: amActive.value && !props.settlementRevealed,
}));
```

删 `endReason`（唯一消费者是旧 `endedText`）。

- [x] **Step 5: 跑绿 + 类型检查 + 提交**

```bash
pnpm -C apps/client test mahjong-center mahjong-board && pnpm -C apps/client run lint
git add apps/client/src/components/table/mahjong/MahjongCenter.vue \
        apps/client/src/components/table/mahjong/MahjongBoard.vue \
        apps/client/test/mahjong-center.test.ts apps/client/test/mahjong-board.test.ts
git commit -m "feat(mahjong): 信息格三档（牌墙主数字/待响应带来源座/听牌分级）
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 收尾与文档

- [x] 全量验证：`pnpm -C apps/client test`、`pnpm -C apps/client run lint`、`pnpm -C apps/client run build:h5`。
- [x] ~~更新 `mockup.html` 的 `drawB()`~~ **改为不重生成**：示意图是设计期产物，交付证据改用真组件截图
  （`real-1334x750.png` / `real-1334x750-full.png` / `real-1334x1000.png` / `real-1623x750.png`）。
  原渲染命令留档：
  ```bash
  CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1400,880 --screenshot=raw-b.png \
    "file:///D:/Code/pokergame/.superpowers/mahjong-layout-research/v2-mockups/mockup.html?v=b"
  ffmpeg -y -loglevel error -i raw-b.png -vf "crop=1334:750:0:0" b-1334x750.png
  # 同理 --window-size=1400,1140 渲染 v=b&h=1000 并 crop 1334:1000
  ```
- [x] 更新 spec「审查记录」与 plan 勾选；写交接 `docs/superpowers/plans/2026-10-30-mahjong-central-board-handoff.md`。
- [x] 真浏览器截图三档（1334×750 / 1334×1000 / 1623×750），与 mockup 对照。
- [x] 提交 + 推 dev。

## §附录 A：`mahjongTableLayout` 精确实现

```ts
export interface MahjongSeatLoad {
  discards: number;
  melds: number;
  /** 4 张副露（gang/angang）组数；用于按实际组型算两翼宽度。 */
  gangMelds?: number;
}

interface NormalizedSeat {
  discards: number;
  melds: number;
  gangMelds: number;
}

function normalizeLoad(raw: Partial<MahjongSeatLoad> | undefined): NormalizedSeat {
  const melds = Math.max(0, Math.min(4, Math.floor(Number(raw?.melds) || 0)));
  const gangMelds = Math.max(0, Math.min(melds, Math.floor(Number(raw?.gangMelds) || 0)));
  return { discards: Math.max(0, Math.floor(Number(raw?.discards) || 0)), melds, gangMelds };
}

export type LaneOrigin = 'top-left';
export interface LaneLayout {
  rect: Rect; tile: TileSize; gap: number; cols: number; rows: number; fit: number; origin: LaneOrigin;
}
export interface MeldStripLayout {
  rect: Rect; tile: TileSize; overlap: number; groupGap: number; groups: number;
  direction: 'row' | 'column';
}
export type InfoLevel = 'full' | 'dense' | 'compact';

// token 新增/变更
//   meldTopScale: 0.55, meldTopGroupGap: 4, meldGroupGap: 8,
//   infoMaxH: 240, infoMinW: 160, infoMinH: 120, infoFullH: 176
//   meldScale: 0.8 → 0.65

// —— 主函数内 ——
const w = Math.max(1334, finitePositive(width, 1334));
const h = Math.max(750, finitePositive(height, 750));
const top = normalizeLoad(input.top);
const left = normalizeLoad(input.left);
const right = normalizeLoad(input.right);
const self = normalizeLoad(input.self);

const handRowW = T.handCount * T.handH * TILE_RATIO + (T.handCount - 1) * T.gap + T.drawnGap;
const s = Math.max(1, Math.min(h / 750, (0.88 * w) / handRowW));
const u = (v: number) => v * s;

const tileW = u(T.riverH * TILE_RATIO);
const tileH = u(T.riverH);
const gap = u(T.gap);
const sideTW = u(T.sideRiverW);
const sideTH = u(T.sideRiverH);
const chipRight = u(T.outer + T.sideChipW);
const availBoardW = w - 2 * (chipRight + u(T.inner));

const CANDIDATES: ReadonlyArray<readonly [number, number]> = [
  [12, 3], [12, 2], [11, 2], [10, 2], [9, 2], [8, 2],
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

const topBackTile = { w: u(T.topBackH * TILE_RATIO), h: u(T.topBackH) };
const backW = T.handCount * topBackTile.w + (T.handCount - 1) * u(T.topBackGap);
const backLeft = (w - backW) / 2;
const backRight = backLeft + backW;
const backTop = u(T.barH) + u(T.inner);

const meldTopTile = { w: u(T.riverH * TILE_RATIO) * T.meldTopScale, h: u(T.riverH) * T.meldTopScale };
const meldTile = { w: u(T.riverH * TILE_RATIO) * T.meldScale, h: u(T.riverH) * T.meldScale };
const sideMeldTile = { w: u(T.sideRiverW) * T.sideMeldScale, h: u(T.sideRiverH) * T.sideMeldScale };
const meldOverlap = u(T.meldOverlap);
const flapGap = u(T.meldTopGroupGap);
const pengW = 3 * meldTopTile.w - 2 * meldOverlap;
const gangW = 4 * meldTopTile.w - 3 * meldOverlap;

// 右翼先拿 ceil(n/2)；杠优先落在右翼（悲观假设，保证不裁切）
const topRightN = Math.ceil(top.melds / 2);
const topLeftN = top.melds - topRightN;
const topRightG = Math.min(topRightN, top.gangMelds);
const topLeftG = Math.min(topLeftN, Math.max(0, top.gangMelds - topRightN));
const widthOfSide = (n: number, g: number) =>
  n <= 0 ? 0 : g * gangW + (n - g) * pengW + (n - 1) * flapGap;
const needRight = widthOfSide(topRightN, topRightG);
const needLeft = widthOfSide(topLeftN, topLeftG);
const flankLeftSpace = backLeft - u(T.inner) - chipRight - u(T.inner);
const flankRightSpace = (w - chipRight) - u(T.inner) - backRight - u(T.inner);
const topFlanksFit =
  top.melds <= 0 || (needRight <= flankRightSpace + 1e-6 && needLeft <= flankLeftSpace + 1e-6);

const topBelowH = top.melds > 0 && !topFlanksFit ? meldTile.h : 0;
const boardTopBase = backTop + topBackTile.h + u(T.inner);
const boardTop = boardTopBase + (topBelowH > 0 ? topBelowH + u(T.inner) : 0);
const selfMeldH = self.melds > 0 ? meldTile.h : 0;
const boardBottom = handTop - u(T.inner) - (self.melds > 0 ? selfMeldH + u(T.inner) : 0);
const availH = Math.max(0, boardBottom - boardTop);

const rowH = tileH + gap;
const infoAt = (r: number) => availH - 2 * (r * rowH - gap);
let rows = 2;
for (let r = 4; r >= 2; r--) {
  if (infoAt(r) >= u(T.infoMaxH)) { rows = r; break; }
}
if (infoAt(rows) < u(T.infoMaxH)) {
  rows = 2;
  for (let r = 4; r >= 2; r--) {
    if (infoAt(r) >= u(T.infoMinH)) { rows = r; break; }
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

function buildLane(box: Rect, cols: number, tw: number, th: number, n: number): LaneLayout {
  const capacityRows = Math.max(1, Math.floor((box.height + gap) / (th + gap)));
  const needed = Math.max(1, Math.ceil(n / cols));
  const fit = Math.min(
    1,
    box.width / (cols * tw + (cols - 1) * gap),
    box.height / (needed * th + (needed - 1) * gap),   // 与 D7 同源，不加 gap
  );
  return {
    rect: box, tile: { w: tw * fit, h: th * fit }, gap: gap * fit,
    cols, rows: capacityRows, fit, origin: 'top-left',
  };
}

const topLane = buildLane(topLaneRect, middleCols, tileW, tileH, top.discards);
const bottomLane = buildLane(bottomLaneRect, middleCols, tileW, tileH, self.discards);
const leftLane = buildLane(leftLaneRect, sideCols, sideTW, sideTH, left.discards);
const rightLane = buildLane(rightLaneRect, sideCols, sideTW, sideTH, right.discards);

const sideBackW = u(T.sideBackH * TILE_RATIO);
const sideBackH = (T.backCount * T.sidePitch + T.sideBackH) * s;
const sideContentTop = boardTopY + u(T.chip) + u(T.inner);
const topBacks = { rect: rect(backLeft, backTop, backW, topBackTile.h), tile: topBackTile, gap: u(T.topBackGap) };
const sideBackTile = { w: sideBackW, h: u(T.sideBackH) };
const leftBacks = {
  rect: rect(boardLeft - u(T.inner) - sideBackW, sideContentTop, sideBackW, sideBackH),
  tile: sideBackTile, pitch: u(T.sidePitch),
};
const rightBacks = {
  rect: rect(boardLeft + boardW + u(T.inner), sideContentTop, sideBackW, sideBackH),
  tile: sideBackTile, pitch: u(T.sidePitch),
};

const zero = rect(0, 0, 0, 0);
function meldStrip(
  box: Rect, tile: TileSize, overlap: number, groupGap: number, groups: number, dir: 'row' | 'column',
): MeldStripLayout {
  return { rect: box, tile, overlap, groupGap, groups, direction: dir };
}
const stripTop = backTop + (topBackTile.h - meldTopTile.h) / 2;
const topMeldsRight = topBelowH > 0
  ? meldStrip(zero, meldTopTile, meldOverlap, flapGap, 0, 'row')
  : meldStrip(rect(backRight + u(T.inner), stripTop, Math.max(0, flankRightSpace), meldTopTile.h),
      meldTopTile, meldOverlap, flapGap, topRightN, 'row');
const topMeldsLeft = topBelowH > 0
  ? meldStrip(zero, meldTopTile, meldOverlap, flapGap, 0, 'row')
  : meldStrip(rect(chipRight + u(T.inner), stripTop, Math.max(0, flankLeftSpace), meldTopTile.h),
      meldTopTile, meldOverlap, flapGap, topLeftN, 'row');
const topMeldsBelow = topBelowH > 0
  ? meldStrip(rect(boardLeft + sideLaneW, boardTopBase, middleW, topBelowH),
      meldTile, meldOverlap, u(T.meldGroupGap), top.melds, 'row')
  : meldStrip(zero, meldTile, meldOverlap, u(T.meldGroupGap), 0, 'row');

const sideMeldW = 4 * sideMeldTile.w - 3 * meldOverlap;
const sideStripH = (n: number) => (n > 0 ? n * sideMeldTile.h + (n - 1) * u(T.sideMeldGap) : 0);
const leftMelds = left.melds > 0
  ? meldStrip(rect(u(T.outer), sideContentTop, sideMeldW, sideStripH(left.melds)),
      sideMeldTile, meldOverlap, u(T.sideMeldGap), left.melds, 'column')
  : meldStrip(zero, sideMeldTile, meldOverlap, u(T.sideMeldGap), 0, 'column');
const rightMelds = right.melds > 0
  ? meldStrip(rect(w - u(T.outer) - sideMeldW, sideContentTop, sideMeldW, sideStripH(right.melds)),
      sideMeldTile, meldOverlap, u(T.sideMeldGap), right.melds, 'column')
  : meldStrip(zero, sideMeldTile, meldOverlap, u(T.sideMeldGap), 0, 'column');
const selfMelds = self.melds > 0
  ? meldStrip(rect(boardLeft + sideLaneW, handTop - u(T.inner) - meldTile.h, middleW, meldTile.h),
      meldTile, meldOverlap, u(T.meldGroupGap), self.melds, 'row')
  : meldStrip(zero, meldTile, meldOverlap, u(T.meldGroupGap), 0, 'row');

const infoLevel: InfoLevel =
  infoH >= u(T.infoFullH) ? 'full' : infoH >= u(T.infoMinH) ? 'dense' : 'compact';
const rightX = rightLaneRect.left;
const bottomY = handTop - u(T.inner);

const selfChip = rect(u(T.outer), handTop + ((T.handH - T.selfChipH) / 2) * s, u(T.selfChipW), u(T.selfChipH));
const leftChip = rect(u(T.outer), boardTopY, u(T.sideChipW), u(T.chip));
const rightChip = rect(w - u(T.outer) - u(T.sideChipW), boardTopY, u(T.sideChipW), u(T.chip));
```

返回对象：

```ts
return {
  s,
  bar: rect(0, 0, w, u(T.barH)),
  board: rect(boardLeft, boardTopY, boardW, boardH),
  topLane, bottomLane, leftLane, rightLane,
  info: infoRect,
  infoLevel,
  infoTiles: { claim: { w: u(34), h: u(51) }, ting: { w: u(20), h: u(30) } },
  hand: { rect: rect(handLeft, handTop, handW, handH), tile: { w: u(T.handH * TILE_RATIO), h: handH }, gap: u(T.gap), drawnGap: u(T.drawnGap) },
  topBacks, leftBacks, rightBacks,
  topMelds: { left: topMeldsLeft, right: topMeldsRight, below: topMeldsBelow },
  leftMelds, rightMelds, selfMelds,
  selfChip, leftChip, rightChip,
  barChip: { w: u(T.barChipW), h: u(T.barChipH) },
  actions: {
    rightX, bottomY,
    rightOffset: w - rightX, bottomOffset: h - bottomY,
    maxWidth: Math.min(u(T.actionsMaxW), w - 2 * u(T.outer)),
    minHeight: u(80),
  },
};
```

---

## 计划审查记录

### 2026-10-30 第一轮（独立 reviewer，sonnet）

**结论：需修订后复审。** 6 阻断 / 8 高 / 9 低，处置：

| 编号 | 发现 | 处置 |
|---|---|---|
| B1 | 附录 `fit` 高度项多了 `+ gap`，与 D7 不一致且会让 n=30/48 的 gridH 超出 laneH | **已修**：改 `box.height / (needed*th + (needed−1)*gap)`，并在注释里写明与 D7 同源 |
| B2 | `gangMelds` 可选导致 `number \| undefined` 参与算术，`vue-tsc` 红 | **已修**：内部 `NormalizedSeat`（`gangMelds: number` 必填），`normalizeLoad` 返回它 |
| B3 | Task 2「只追加」与附录重声明旧作用域常量冲突，任务不可能绿；新 token 清单漏 `meldScale 0.8→0.65` | **已修**：Task 2 与 Task 3 合并为「布局重写 + Board/River 接线」同一提交；token 变更写入 Step 3 |
| B4 | Board「4 杠下移」用例用默认 1334×750，实际两翼放得下（below=0），断言必假 | **已修**：该用例注入 1334×833 画布 |
| B5 | `toBeCloseTo(431.3, 1)` 卡在 0.05 边界（实际差 0.05000000000001） | **已修**：改精确值 431.25 / 127.25（精度 3） |
| B6 | River 对齐的源码闸与 spec 互斥，且 `align-content` 在父级居中时是空操作 | **已修**：改父级 `.mj-river` 的 `align-items/justify-content: flex-start`；源码闸锚到该规则 |
| H1 | `w=max(1334,…)/h=max(750,…)` 只写在 spec | **已修**：写入附录 A 首两行 |
| H2 | 附录不产出 `leftChip/rightChip/selfChip`，旧公式依赖被删量 | **已修**：附录补齐三行精确公式；测试加 `chip.top = board.top` |
| H3 | 测试/实现侧的悬空 import 与旧符号未列 | **已修**：Task 2 明列删除项（`buildRiver`、`MELD_LABEL/vertical/MahjongMeld`、旧 helpers、`readFileSync` 新增） |
| H4 | `infoTiles` 无断言（覆盖面比旧版回退） | **已修**：每视口加 4 条 `34/51/20/30 × s` 断言 |
| H5 | `claimLabel` 在暗杠/补杠窗口误显示「可自摸胡」；Center 局部 `claimLabel` 遮蔽 prop | **已修**：Board 用 `myClaims.some(o => o.claim==='hu')` 决定文案，play 且无胡时 `claimTile=null`；Center 局部改名 `claimTileLabel` |
| H6 | Center 测试 `base` 缺 `level` | **已修**：Step 1 明写 base 增 `level:'full'`、删 `compact/endedText` |
| H7 | 两条测试是空体/纯负断言 | **已修**：完整写出（紧迫类三态；「已胡」用例配 `牌墙 42` 正向锚） |
| H8 | mockup 重生成不可执行 | **已修**：Task 4 写明改 `drawB()` 的六处并给出渲染命令 |
| L1 | 2dp 锚点余量只剩 0.00013px | **已修**：改 3dp（206.327/921.345/357.327/619.345/976.673） |
| L2 | 部分断言是实现的恒等式 | **已处置**：保留为低价值守卫；判别力由「token 独立重算列宽」与「四道 rect 与纯函数逐值一致」承担 |
| L3 | 矩形合法性只跑 EMPTY | **已修**：EMPTY + WORST 双轮 |
| L4 | 高度类断言精度 0 | **已修**：改精度 1 + 关键值精确 |
| L5 | spec 三处不一致（WORST 档位、B3 旧数字、River 清单） | **已修**：spec 同步 |
| L6 | `capacity` 语义漂移 | **已修**：改名 `groups`（承载组数，0 = 空条） |
| L7 | 下移量/四道 rect 覆盖被削弱 | **已修**：补 `below.height=48.75s`、`board.top≈211.9`、四道 + info 全 rect 断言 |
| L8/L9 | 与 H5/H3 同源 | 已并入 |

**修订后状态：可开工。**

---

## 代码审查记录

### 2026-10-30 第一轮（独立 reviewer，sonnet，`ec238a12..HEAD`）

结论：**需修复后再交付**（1 Important + 10 Minor）。全部处置：

| 编号 | 发现 | 处置 |
|---|---|---|
| I1 | Task 4 未闭环；spec §10 B3 写「已重生成 mockup」失实（`b-*.png` mtime 早于实现） | **已修**：spec B3 改为「示意图不重生成，交付证据 = 真组件截图」；plan 勾选 + 偏差说明；交接落盘 |
| M1 | `topFlanksFit` 按悲观上限（杠优先右翼），个别顺序会「本可留两翼却下移」 | **登记**（spec §8）；扫描证明不会反向下移后裁切（右翼估计是上界） |
| M2 | compact 与 spec §5.4 不一致（缺 `·` 分隔；claim 同行） | **已修**：compact 恢复 `·` 分隔；spec 改为「单行、claim 文字追加同一行」 |
| M3 | play 窗口「可自摸胡」取「第一个带 tile 的选项」，与杠的顺序耦合 | **已修**：改取 `claim === 'hu'` 的那张牌 |
| M4 | 新 prop `justify` 未进 spec/plan | **已修**：spec §5.2 补 |
| M5 | `MAHJONG_TABLE_TOKENS.riverCols` 死 token；注释「测试引用」失实 | **已修**：删 token、改注释 |
| M6 | 布局矩阵缺 4 条（s 公式、bare=EMPTY、WORST 侧道全高、below.bottom） | **已修**：全部补上 |
| M7 | river 源码闸缺网格 `align-content: start` | **已修**：补正则 |
| M8 | center 11px 闸可跨 `}` 被文件后段 11px 救活 | **已修**：`[^}]*` 收紧 + 注释 |
| M9 | Board 缺分翼归属与副露条 rect 断言 | **已修**：加「3 组副露 2+1」与「below 条 rect」两条 |
| M10 | `discards: Infinity` 未夹取 → `tile {0,0}` 违反 D7 | **已修**：`normalizeLoad` 非有限值归 0 + 测试 |

**核对无问题项**（reviewer 已查）：任一画布无 NaN/负矩形/越界；`buildLane` 的 n=0/超容量/cols 变化数学正确；
`isSource` 点击语义未变；双击/换三张/长按/托管/结算/banner 未被 DOM 重排触及；`topStripProps` 新数组只重渲染不重建；
dense 不渲染听牌；「已胡 N 家」与 `endReason` 已彻底移除；新组件满足单根/style/零计时器/无裸 1px/无 rpx。

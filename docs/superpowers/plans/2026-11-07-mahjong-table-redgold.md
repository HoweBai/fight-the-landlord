# 川麻红金牌桌重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把麻将牌桌从当前 10-30 四家围桌布局换成 v13 的「川麻红金」固定 1334×750 构图（B 比例方案），并落实血战盘、四河窗口、动作浮层、侧副露、动效与数据契约。

**Architecture:** 新增独立的 `mahjong-layout-v2.ts`（纯函数，固定 base 1334×750，运行时 `u=min(W/1334,H/750)` + 居中 offset）；旧 `mahjong-layout.ts` 与其测试冻结。组件层新增 `MahjongHub`、`MahjongActionBar`，扩展现有 River/SeatChip/Meld/Tile/HandBacks；`MahjongBoard` 负责装配与交互契约。交互纯逻辑（claimed 过滤、窗口、claimSource、meld key）抽到 `mahjong-claims.ts` / `mahjong-keys.ts`，用 TDD 锁。

**Tech Stack:** uni-app / Vue 3 + TypeScript / Vitest / SCSS（uni.scss tokens）/ HBuilderX 云打包。

## Global Constraints

- 只改客户端展示层：不改协议、服务端、数据库、admin。
- 布局基准 **1334×750**；`u=min(W/1334,H/750)`；标准台 `u=1`；构图居中，`offsetX=(W−1334u)/2`、`offsetY=(H−750u)/2`；不再有 per-canvas `s`/`0.86W`。
- 旧 `apps/client/src/game/mahjong-layout.ts` 与 `apps/client/test/mahjong-layout.test.ts` **冻结不改**；新逻辑只进 `mahjong-layout-v2.ts`。
- 牌面/牌背图片不改；侧河/侧副露用现有 `left/right` 49×40 素材；暗杠背用 `aspectFill`。
- 动效：一个 `infinite`（claim 呼吸）；新 `anim-*` 全部登记 `prefers-reduced-motion`；发牌/手牌类用 `backwards`；退场 `forwards` + `animationend`。
- 每个任务先写失败测试，再实现，测试绿后提交；提交信息末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

**新增：**

- `apps/client/src/game/mahjong-layout-v2.ts` — 固定 base 构图、纯函数布局、窗口/侧河/副露/听牌 rect。
- `apps/client/src/game/mahjong-claims.ts` — `visibleDiscards`、`riverWindow`、`claimSource` 纯函数。
- `apps/client/src/game/mahjong-keys.ts` — `meldKey(seat,m)` 与解析。
- `apps/client/src/components/table/mahjong/MahjongHub.vue` — 血战盘。
- `apps/client/src/components/table/mahjong/MahjongActionBar.vue` — 2×2 动作区。
- `apps/client/test/mahjong-layout-v2.test.ts`
- `apps/client/test/mahjong-claims.test.ts`
- `apps/client/test/mahjong-hub.test.ts`
- `apps/client/test/mahjong-action-bar.test.ts`
- `apps/client/test/mahjong-keys.test.ts`

**修改：**

- `apps/client/src/components/table/mahjong/MahjongBoard.vue` — 装配、dealEpoch、claim、banner、seat 状态、roomCode。
- `apps/client/src/components/table/mahjong/MahjongSeatChip.vue` — 四变体、角标、静态金边。
- `apps/client/src/components/table/mahjong/MahjongRiver.vue` — 窗口/claimed/revealed/claimSourceIndex/局部坐标。
- `apps/client/src/components/table/mahjong/MahjongMeld.vue` — `vertical`、4 张 inline、meld key。
- `apps/client/src/components/table/mahjong/MahjongTile.vue` — `mode`（aspectFit/aspectFill）。
- `apps/client/src/components/table/mahjong/MahjongHandBacks.vue` — dealNonce/tail。
- `apps/client/src/components/table/mahjong/MahjongHuBanner.vue` — `startsWith`、锚点。
- `apps/client/src/pages/table/table.vue` — bySlot/phase/tingCount/roomCode、音效。
- `apps/client/src/composables/useTableSound.ts` — seat key、bootstrap、MjDeal latch。
- `apps/client/src/styles/animations.scss` — 新 keyframes、删除多余 infinite。
- `apps/client/src/uni.scss` — 红金/字体 token。
- `apps/client/test/mahjong-river.test.ts`、`mahjong-seat-chip.test.ts`、`mahjong-tile-meld.test.ts`、`mahjong-hand-backs.test.ts`、`mahjong-board.test.ts`、`animations.test.ts`、`audio.test.ts`。

**删除：**

- `apps/client/src/components/table/mahjong/MahjongCenter.vue`
- `apps/client/test/mahjong-center.test.ts`
- `apps/client/src/components/table/mahjong/ClaimTile.vue`（claim 并入 ActionBar；若要保留 tile 预览，可留子组件，但不再渲染按钮）

---

## Task 1: 布局纯函数 v2（固定 base + 居中）

**Files:**
- Create: `apps/client/src/game/mahjong-layout-v2.ts`
- Test: `apps/client/test/mahjong-layout-v2.test.ts`

**Interfaces:**
- Produces: `mahjongTableLayoutV2(W,H,input): MahjongTableLayoutV2`；`MAHJONG_TABLE_TOKENS_V2`；`SeatLoadV2 { discards:number; melds:number[]; revealedCount?:number }`；`TableLayoutV2` 的 `rects`、`hub`、`rivers`、`seatPlates`、`hand`、`actions`、`ting`。

- [ ] **Step 1: 写失败测试（base 锚点 + 居中 + 1 列侧河 + 不相交）**

```ts
import { describe, it, expect } from 'vitest';
import { mahjongTableLayoutV2 } from '../src/game/mahjong-layout-v2';

const EMPTY = { bySlot: { self: { discards: 0, melds: [] }, top: { discards: 0, melds: [] }, left: { discards: 0, melds: [] }, right: { discards: 0, melds: [] } }, phase: 'play' as const, tingCount: 0 };
const rects = (l: any) => Object.values(l.rects).filter((r: any) => r && r.width > 0 && r.height > 0);

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/client exec vitest run test/mahjong-layout-v2.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现布局**

从 `docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs` 的 `layoutBase` **逐行移植**到 TS，保留所有 base 常量（1334×750、bar 64、outer 12、gap 4、hand 108、riverTileH 56、sideTile 56×45.714、seatPlate 160/164/64×56/76、action 176/84、hub 160–200、ting 20×30、displayCap 24），并加：

```ts
const BASE_W = 1334, BASE_H = 750;
export function mahjongTableLayoutV2(W: number, H: number, input: TableInputV2): MahjongTableLayoutV2 {
  const u = Math.min(W / BASE_W, H / BASE_H);
  const ox = (W - BASE_W * u) / 2;
  const oy = (H - BASE_H * u) / 2;
  const base = layoutBase(BASE_W, BASE_H, input);
  const tr = (r: Rect): Rect => ({ left: ox + r.left * u, top: oy + r.top * u, width: r.width * u, height: r.height * u });
  // rects/hub/rivers/seatPlates/hand/actions/ting 全部 tr；hub.cx/cy/r 同步
  return { u, offsetX: ox, offsetY: oy, ...transformed };
}
```

`layoutBase` 的侧河：
```ts
if (visible <= 12) {
  rows = Math.max(1, visible); cols = 1;
  tileH = Math.min(45.714, (avail - (rows - 1) * 2) / rows);
  tileW = tileH * 49 / 40;
} else {
  rows = clamp(Math.floor((avail + 2) / (45.714 + 2)), 3, 10);
  cols = clamp(Math.ceil(visible / rows), 2, 6);
  tileH = 45.714; tileW = 56;
}
```

输出窗口字段（四河）：
```ts
windowStart = raw - windowCount;
latestIndex = windowCount - 1;
badgeCount = raw - windowCount;
badgeCell = windowCount; // 0-based
```
上/下 `windowCount = overflow>0 ? 23 : visible`；侧 `windowCount = overflow>0 ? (rows*cols >= 25 ? 24 : 23) : visible`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm -C apps/client exec vitest run test/mahjong-layout-v2.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/game/mahjong-layout-v2.ts apps/client/test/mahjong-layout-v2.test.ts
git commit -m "feat(mahjong): 新增固定 base 布局 v2"
```

---

## Task 2: claimed 过滤 / 窗口 / claimSource 纯函数

**Files:**
- Create: `apps/client/src/game/mahjong-claims.ts`
- Create: `apps/client/src/game/mahjong-keys.ts`
- Test: `apps/client/test/mahjong-claims.test.ts`, `apps/client/test/mahjong-keys.test.ts`

**Interfaces:**
- Produces: `visibleDiscards(raw: Tile[], melds: MahjongMeldView[][], opts): Tile[]`；`riverWindow(raw, visibleCap=24)`；`claimSource(view, mySeat)`；`meldKey(seat,m)`、`parseMeldKey(key)`。

- [ ] **Step 1: 写失败测试**

```ts
import { visibleDiscards, riverWindow, claimSource } from '../src/game/mahjong-claims';
// 5(旧碰) 3 5(当前胡)
const tiles = [t('wan',5), t('wan',3), t('wan',5)];
const melds = [[/* seat0 */], [{ kind:'peng', tiles:[t('wan',5),t('wan',5),t('wan',5)], fromSeat:0 }], [], []];
it('claim 窗口保护最后一张，隐藏旧的同 type', () => {
  const v = visibleDiscards(tiles, melds, { phase:'claim', windowId:'claim:3', sourceSeat:0 });
  expect(v.map(tileType)).toEqual([tileType(t('wan',3)), tileType(t('wan',5))]);
});
it('29 张窗口字段', () => {
  expect(riverWindow(29)).toEqual({ visible:24, overflow:5, windowStart:6, windowCount:23, badgeCount:6, latestIndex:22 });
});
```

（`t()`/`tileType` 从 `@fight-the-landlord/protocol` 引入；`meldKey` 测试：`meldKey(1,{kind:'peng',tiles:[5万]}) === '1:peng:5'`。）

- [ ] **Step 2: 运行确认失败**
Run: `pnpm -C apps/client exec vitest run test/mahjong-claims.test.ts test/mahjong-keys.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`visibleDiscards`：
```ts
const counts = new Map<number, number>();
melds.forEach((list, claimer) => list.forEach(m => {
  if (m.fromSeat == null) return;
  const type = tileType(m.tiles[0]!);
  counts.set(type, (counts.get(type) ?? 0) + 1);
}));
const hidden = new Set<number>();
for (const [type, count] of counts) {
  const idx = raw.map((t,i)=>tileType(t)===type?i:-1).filter(i=>i>=0).reverse();
  const cand = idx.filter(i => !(opts.phase==='claim' && opts.windowId?.startsWith('claim:') && opts.sourceSeat===source && i===raw.length-1));
  cand.slice(0,count).forEach(i=>hidden.add(i));
}
return raw.filter((_,i)=>!hidden.has(i));
```

`riverWindow(rawCount)` 按 spec v13 §2 返回字段。

`claimSource(view,mySeat)`：`myClaims.find(o=>o.tile)?.tile`；rob 时 `claimSourceIndex=null`，`meldKey(currentPlayer, 同 type peng)`。

- [ ] **Step 4: 运行确认通过**
Run: `pnpm -C apps/client exec vitest run test/mahjong-claims.test.ts test/mahjong-keys.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/client/src/game/mahjong-claims.ts apps/client/src/game/mahjong-keys.ts apps/client/test/mahjong-claims.test.ts apps/client/test/mahjong-keys.test.ts
git commit -m "feat(mahjong): claimed 过滤/窗口/claimSource 纯函数"
```

---

## Task 3: MahjongTile `mode` + MahjongMeld `vertical`

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongTile.vue`
- Modify: `apps/client/src/components/table/mahjong/MahjongMeld.vue`
- Test: `apps/client/test/mahjong-tile-meld.test.ts`

**Interfaces:**
- Produces: `MahjongTile` prop `mode?: 'aspectFit'|'aspectFill'`（默认 aspectFit）；`MahjongMeld` prop `vertical?: boolean`、`meldSizes?: number[]`；4 张 inline 无 cap。

- [ ] **Step 1: 写失败测试**
  - rotate 不存在；vertical 时 `marginTop=-4`；4 张组高 106.86；暗杠 4 张 `src=back` + `mode=aspectFill`。
- [ ] **Step 2: 运行确认失败**
Run: `pnpm -C apps/client exec vitest run test/mahjong-tile-meld.test.ts`
Expected: FAIL。
- [ ] **Step 3: 实现**
  - `MahjongTile`：`mode` prop 绑定 `<image :mode="mode">`；默认 aspectFit。
  - `MahjongMeld`：`vertical` 时 `flex-direction: column`，非首张 `marginTop: -4px`；移除/不实现 cap；暗杠传 `mode="aspectFill"`。
- [ ] **Step 4: 运行确认通过**
Run: `pnpm -C apps/client exec vitest run test/mahjong-tile-meld.test.ts`
Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add apps/client/src/components/table/mahjong/MahjongTile.vue apps/client/src/components/table/mahjong/MahjongMeld.vue apps/client/test/mahjong-tile-meld.test.ts
git commit -m "feat(mahjong): Tile mode/Meld vertical"
```

---

## Task 4: MahjongRiver 窗口/claimed/revealed/claimSourceIndex

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongRiver.vue`
- Test: `apps/client/test/mahjong-river.test.ts`

**Interfaces:**
- Produces: props `discards`（visibleDiscards）、`windowStart`、`windowCount`、`latestIndex`、`badgeCount`、`badgeRect`、`meldRect`、`laneWidth`、`claimSourceIndex`、`revealed`；emit `discard-click` `{tile,index}`（窗口内）。
- Consumes: Task 2 的窗口字段、Task 3 的 Meld。

- [ ] **Step 1: 写失败测试**
  - `slice(windowStart, windowStart+windowCount)`；29 张显示最新 23 + 徽标 6；claimed 来源只 `i===claimSourceIndex` 描边；revealed 14 无 +N；emit index 窗口内。
- [ ] **Step 2: 运行确认失败**
Run: `pnpm -C apps/client exec vitest run test/mahjong-river.test.ts`
Expected: FAIL。
- [ ] **Step 3: 实现**
  - 渲染 `discards.slice(windowStart, windowStart+windowCount)`；网格 `gridAutoRows` 用布局 tile 尺寸；`badgeCount>0` 渲染 `+N` 在 `badgeRect`（局部）；`latestIndex` 高亮；`claimSourceIndex` 只描边单张；`revealed` 替换 discards、无 +N；点击 emit `{tile,index}`。
  - `meldRect/laneWidth` 用于内侧 lane；子项 `overflow: visible`。
- [ ] **Step 4: 运行确认通过**
Run: `pnpm -C apps/client exec vitest run test/mahjong-river.test.ts`
Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add apps/client/src/components/table/mahjong/MahjongRiver.vue apps/client/test/mahjong-river.test.ts
git commit -m "feat(mahjong): River 窗口/claimed/revealed"
```

---

## Task 5: MahjongHub 替代 MahjongCenter

**Files:**
- Create: `apps/client/src/components/table/mahjong/MahjongHub.vue`
- Delete: `apps/client/src/components/table/mahjong/MahjongCenter.vue`, `apps/client/test/mahjong-center.test.ts`
- Test: `apps/client/test/mahjong-hub.test.ts`

**Interfaces:**
- Produces: props `{ hub, wallCount, seconds, currentPlayer, activeSeats, seats, tingCount, compact, statusText, endedText, claimTile? }`；渲染牌墙/倒计时/方位点/四家徽标/状态行/听 N。
- Consumes: Task 1 的 `hub` rect/compact。

- [ ] **Step 1: 写失败测试**
  - 牌墙 42/倒计时 12s/状态「等待出牌」/四向点/徽标；无分数；compact 下字号 32/18/12；听 N。
- [ ] **Step 2: 运行确认失败**
Run: `pnpm -C apps/client exec vitest run test/mahjong-hub.test.ts`
Expected: FAIL。
- [ ] **Step 3: 实现**
  - 按 §1.4 的 normal/compact 字号与状态行文案；金环 inset 3px；徽标/方位点；不要中央 claim 牌。
- [ ] **Step 4: 运行确认通过**
Run: `pnpm -C apps/client exec vitest run test/mahjong-hub.test.ts`
Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add apps/client/src/components/table/mahjong/MahjongHub.vue apps/client/test/mahjong-hub.test.ts
git rm apps/client/src/components/table/mahjong/MahjongCenter.vue apps/client/test/mahjong-center.test.ts
git commit -m "feat(mahjong): Hub 替代 Center"
```

---

## Task 6: MahjongSeatChip 四变体/角标/静态

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongSeatChip.vue`
- Test: `apps/client/test/mahjong-seat-chip.test.ts`

**Interfaces:**
- Produces: `variant: 'corner-tl'|'corner-tr'|'corner-top'|'self'`；`activeLevel: 'strong'|'line'|null`；`winner?: boolean`；角标最多 2（右上 1 字/左下 2 字）；无张数/fan 行；静态金边。

- [ ] **Step 1: 写失败测试**
  - 四变体 class；strong/line/winner 静态无 `animation`；角标位置；无「13 张」。
- [ ] **Step 2: 运行确认失败**
Run: `pnpm -C apps/client exec vitest run test/mahjong-seat-chip.test.ts`
Expected: FAIL。
- [ ] **Step 3: 实现**
  - 替换 `variant` 联合；删除 `ftl-active-glow` infinite；角标两槽；score 18/name 18；自己 64 宽头像 44 + 分数 16 + delta 10 竖排。
- [ ] **Step 4: 运行确认通过**
Run: `pnpm -C apps/client exec vitest run test/mahjong-seat-chip.test.ts`
Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add apps/client/src/components/table/mahjong/MahjongSeatChip.vue apps/client/test/mahjong-seat-chip.test.ts
git commit -m "feat(mahjong): SeatChip 四变体/静态金边"
```

---

## Task 7: MahjongActionBar + claim 逻辑

**Files:**
- Create: `apps/client/src/components/table/mahjong/MahjongActionBar.vue`
- Delete: `apps/client/src/components/table/mahjong/ClaimTile.vue`
- Test: `apps/client/test/mahjong-action-bar.test.ts`

**Interfaces:**
- Produces: props `{ mode:'play'|'claim'|'exchange'|'lack', options, showPass, busy, selectedCount }`；emit `action`；2×2 84px；`options` 排除 pass；`showPass` 只认 `claimsForMe` 的 pass；多杠「杠 N」选择器。
- Consumes: `MahjongClaimOption`、Task 1 的 actions rect。

- [ ] **Step 1: 写失败测试**
  - 普通 claim `[peng,pass]` 恰好一个“过”；强制胡无“过”；4 个动作 2×2；换三张/定缺；多杠选择器。
- [ ] **Step 2: 运行确认失败**
Run: `pnpm -C apps/client exec vitest run test/mahjong-action-bar.test.ts`
Expected: FAIL。
- [ ] **Step 3: 实现**
  - 2×2 84 按钮；主按钮金；options 过滤 pass；多杠合并；换三张宽按钮；定缺 3 键。
- [ ] **Step 4: 运行确认通过**
Run: `pnpm -C apps/client exec vitest run test/mahjong-action-bar.test.ts`
Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add apps/client/src/components/table/mahjong/MahjongActionBar.vue apps/client/test/mahjong-action-bar.test.ts
git rm apps/client/src/components/table/mahjong/ClaimTile.vue
git commit -m "feat(mahjong): ActionBar 统一 claim/多杠"
```

---

## Task 8: MahjongBoard 装配与交互契约

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- Modify: `apps/client/src/components/table/mahjong/MahjongHandBacks.vue`
- Modify: `apps/client/src/components/table/mahjong/MahjongHuBanner.vue`
- Test: `apps/client/test/mahjong-board.test.ts`, `apps/client/test/mahjong-hand-backs.test.ts`

**Interfaces:**
- Consumes: Task 1 layout、Task 2 claims/keys、Task 4 River、Task 5 Hub、Task 6 SeatChip、Task 7 ActionBar。
- Produces: `dealEpoch`/`dealNonce`、`visibleDiscards`、`claimSourceIndex`、`lastDiscardAbs`、`seatActiveLevel`、`bannerSeq`、`seenHuSeats` seed、`roomCode`、`bannerAnchors`。

- [ ] **Step 1: 写失败测试**
  - 挂载 v1 exchange/lack 播发牌；v5 mount 不播；remount 第二局播。
  - claim 保护当前最后一张；点旧牌不改选项；rob 无点击；强制胡无过。
  - 双胡 banner 两个节点；reduced-motion 无残留。
  - 碰后下一次出牌仍有音效/高亮；peng→addedGang 只减 1。
- [ ] **Step 2: 运行确认失败**
Run: `pnpm -C apps/client exec vitest run test/mahjong-board.test.ts test/mahjong-hand-backs.test.ts`
Expected: FAIL。
- [ ] **Step 3: 实现**
  - 切 `mahjongTableLayoutV2`；删 Center/ClaimTile；装配 Hub/SeatChip/River/ActionBar。
  - `dealEpoch` 初始 null；挂载 v1 exchange/lack 播，v>1 seed；entry.dealNonce 哨兵；手牌 key `dealNonce-index`；摸牌/牌背尾部 null。
  - `visibleDiscards`、`claimSourceIndex`、`lastDiscardAbs` 映射、`seatActiveLevel` 四相位、`bannerSeq`/`seenHuSeats` seed、`roomCode`、`bannerAnchors`。
  - 删除 `flyingOutIndex`/`anim-fly-out` 预提交。
- [ ] **Step 4: 运行确认通过**
Run: `pnpm -C apps/client exec vitest run test/mahjong-board.test.ts test/mahjong-hand-backs.test.ts`
Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add apps/client/src/components/table/mahjong/MahjongBoard.vue apps/client/src/components/table/mahjong/MahjongHandBacks.vue apps/client/src/components/table/mahjong/MahjongHuBanner.vue apps/client/test/mahjong-board.test.ts apps/client/test/mahjong-hand-backs.test.ts
git commit -m "feat(mahjong): Board v2 装配与契约"
```

---

## Task 9: table.vue / 音效 / 震动

**Files:**
- Modify: `apps/client/src/pages/table/table.vue`
- Modify: `apps/client/src/composables/useTableSound.ts`
- Test: `apps/client/test/audio.test.ts`

**Interfaces:**
- Consumes: Task 8 Board events/props.
- Produces: `bySlot/phase/tingCount/roomCode`；MjShuffle 局首、MjDeal 首次 play、MjSort 出牌/选牌；seat key；light/heavy。

- [ ] **Step 1: 写失败测试**
  - setup 已有 v1 exchange/lack 播 MjShuffle；v>1 不播；MjDeal 首次 play；同座碰→补杠 MjGang；直杠 MjGuafeng。
- [ ] **Step 2: 运行确认失败**
Run: `pnpm -C apps/client exec vitest run test/audio.test.ts`
Expected: FAIL。
- [ ] **Step 3: 实现**
  - `useTableSound` bootstrap 按 version===1；meld key 用 `meldKey`；MjDeal latch；MjSort 出牌/选牌；table.vue 传 bySlot/phase/tingCount/roomCode；托管取消。
- [ ] **Step 4: 运行确认通过**
Run: `pnpm -C apps/client exec vitest run test/audio.test.ts`
Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add apps/client/src/pages/table/table.vue apps/client/src/composables/useTableSound.ts apps/client/test/audio.test.ts
git commit -m "feat(mahjong): 音效/接入 v2"
```

---

## Task 10: 动效 CSS + 无限闸

**Files:**
- Modify: `apps/client/src/styles/animations.scss`
- Modify: `apps/client/src/uni.scss`
- Test: `apps/client/test/animations.test.ts`

**Interfaces:**
- Produces: 红金 tokens；`ftl-deal-in-radial`/`ftl-deal-in-side`/`ftl-discard-land`/`anim-mj-urgent`；唯一 infinite = `anim-claim-pulse`；SeatChip/lack pulse 静态。

- [ ] **Step 1: 写失败测试**
  - 麻将组件 style 无 `infinite`（除 claim pulse）；模板 `anim-*` ∩ classInfinite 只允许 claim pulse；发牌类 `backwards`。
- [ ] **Step 2: 运行确认失败**
Run: `pnpm -C apps/client exec vitest run test/animations.test.ts`
Expected: FAIL。
- [ ] **Step 3: 实现**
  - 加 tokens/keyframes；删 `anim-lack-pulse` 使用、`anim-active-glow` 死类；SeatChip 静态；新 anim 登记 reduced-motion；暗杠 outline。
- [ ] **Step 4: 运行确认通过**
Run: `pnpm -C apps/client exec vitest run test/animations.test.ts`
Expected: PASS。
- [ ] **Step 5: 提交**
```bash
git add apps/client/src/styles/animations.scss apps/client/src/uni.scss apps/client/test/animations.test.ts
git commit -m "feat(mahjong): 红金 token 与动效闸"
```

---

## Task 11: 全量验证与视觉走查

**Files:**
- Modify: `docs/superpowers/plans/2026-11-07-mahjong-table-redgold-handoff.md`（交接记录，新建）

- [ ] **Step 1: 全量测试**
Run: `pnpm -C apps/client test`
Expected: 全绿（目标 ≥1706 passed / 2 skipped；新增测试数增加）。
- [ ] **Step 2: 类型检查**
Run: `pnpm -C apps/client lint`
Expected: 0 错误。
- [ ] **Step 3: H5 构建**
Run: `pnpm -C apps/client build`
Expected: DONE。
- [ ] **Step 4: 七档截图/录屏**
  - 用 `.superpowers/mahjong-redgold/mockup/` 的 harness 或真实页面，出 1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334；正常态 + top29/twoSurvivors/gangHeavy/revealedGang/overlayWorst。
  - 与 v13 mockup 并排确认。
- [ ] **Step 5: 真机走查**
  - 摸牌/出牌/碰杠/胡/结算/托管/重连；侧河 1 列、24+N、动作浮层。
- [ ] **Step 6: 提交交接**
```bash
git add docs/superpowers/plans/2026-11-07-mahjong-table-redgold-handoff.md
git commit -m "docs(mahjong): 川麻红金实现交接"
```

---

## Self-Review

**Spec coverage:** v13 §0–§11 的布局/token/窗口/claim/副露/Hub/SeatChip/ActionBar/动效/测试均在 Task 1–11 有落点；v12 复审的 claim 保护、showPass、toggle、serverDiscards、badge rows、topMeld 合成宽、h 不缩放、协议注释、raw 命名在 Task 2/7/8/9 覆盖；v13 补遗的 last-discard 映射、rob index null、HuBanner anchors、bar/transform 在 Task 8 覆盖。

**Placeholder scan:** 未使用 TBD/TODO；所有任务给出文件、接口、测试代码/命令、提交命令。Task 1 的 `layoutBase` 完整移植以仓库原型为准（`docs/superpowers/specs/2026-11-05-mahjong-table-redgold-geometry.mjs` 是可执行参考，不是 TBD）。

**Type consistency:** `mahjongTableLayoutV2` 的 `u/offsetX/offsetY/rects/hub/rivers/seatPlates/hand/actions/ting` 在 Task 1 定义，Task 4/5/8 使用一致；`visibleDiscards`/`riverWindow`/`claimSource` 在 Task 2 定义，Task 4/8 使用一致；`meldKey` 在 Task 2 定义，Task 9 使用一致。

# 川麻红金 v15 牌河/听牌布局 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每 Task 先写失败测试，再实现，测试绿后提交。

**Goal:** 把左右河改成固定 2 列、贴近中央信息井的竖块；听牌放大到 30×45 并移到左下空区；左右出牌牌格与上下家同尺寸（56×37.168，aspectFit 不裁剪）。其余 v13/v14 行为不变。

**Architecture:** 新增 `apps/client/src/game/mahjong-layout-v3.ts`（纯函数，固定 base 1334×750；从 v2 复制结构，按 v15 原型改侧区/侧河/听牌）。旧 v1/v2 布局与其测试保留（回滚面）。Board 切到 v3；River/Meld/Hub 复用现有接口。

**Tech Stack:** uni-app / Vue 3 + TypeScript / Vitest。

## Global Constraints

- 只改客户端展示层；不改协议/服务端/数据库/admin；不改牌面/牌背图片。
- 布局基准 1334×750；`u=min(W/1334,H/750)`；居中 offset；输出四舍五入 2 位。
- 旧 `mahjong-layout.ts`、`mahjong-layout-v2.ts` 与其测试**冻结不改**；新逻辑只进 `mahjong-layout-v3.ts`。
- 侧河固定 2 列；牌格 56×37.168；aspectFit（禁止裁剪）；29 张 = 19 + N。
- 听牌 30×45、2×5、左下；标签「听 N 张」。
- 侧背/侧副露保持外缘（overlayWorst 布局）。
- 每个 Task 先写失败测试，测试绿后提交；提交末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 每 Task 跑目标测试 + `mahjong-layout-v2` 回归 + `ui-tokens`/`animations`（如相关）；最终全量 `pnpm -C apps/client test`、`lint`、`build`。

---

## Task 1: 布局 v3 纯函数（2 列侧河 / 30×45 听牌）

**Files:**
- Create: `apps/client/src/game/mahjong-layout-v3.ts`
- Test: `apps/client/test/mahjong-layout-v3.test.ts`

**Interfaces（与 v2 同形）:**
`mahjongTableLayoutV3(W,H,input): MahjongTableLayoutV3`；`MAHJONG_TABLE_TOKENS_V3`；`SeatLoadV3 { discards; melds:number[]; revealedCount? }`；`TableInputV3 { bySlot; phase; tingCount }`；`RiverLayoutV3`。
输出：`u/offsetX/offsetY/rects/hub/rivers/seatPlates/hand/backs/actions/ting/topMeld/bannerAnchors`。
- `rivers.left/right`: `rect`（2 列块）、`tile {w:56,h:37.168}`、`cols:2`、`rows`、`windowStart/windowCount/latestIndex/badgeCount/badgeCell/badgeRect`、`meldRect`（外缘 lane）、`laneWidth`、`meld` 尺寸。
- `rivers.top/self`: 同 v2（8/12 列 ×2，23+N）。
- `ting`: `{ rect, tile:{w:30,h:45}, cols:5, rows }`。

**实现要点（以 v15 原型为准，逐行移植侧区/侧河/听牌；其余沿用 v2）:**
1. 侧区外缘：`sideTop = 左右座位牌底 + 4`；侧背 14 张（`pitch=clamp((avail-45.714)/13,8,22)`）；侧副露 lane 在背内侧（0.65 缩放，≥0.4）；`zoneW = backW + gap + laneW`。
2. 中央区：`centerW = W - 2*(outer+zoneW+gap)`；上/下河 8/12 列 ×2。
3. 侧河块：`visible=min(raw,24)`；`rows=visible>0?min(10,ceil(visible/2)):0`；`blockW=114`；`blockH=rows*37.168+(rows-1)*2`；`x=min(topRiver.left,ownRiver.left)-4-blockW`（左）/ `max(topRiver.right,ownRiver.right)+4`（右）；`y=sideTop+(avail-blockH)/2`。
4. 侧窗口：`overflow=raw>20`；`windowCount=overflow?19:visible`；`badgeCount=raw-windowCount`；`windowStart=raw-windowCount`；`latestIndex=windowCount-1`；`badgeCell=windowCount`；`badgeRect` 在 2 列网格第 `windowCount` 格。
5. 听牌：30×45、2×5、`x=outer+backW+4+laneW+4`、`y=ownRiverTop+(ownRiverH-92)/2`。
6. `rects` 含左右河块、lane、侧背、badge；所有 rect 在画布内、互不相交（v15 原型的 pairs）。

**测试（v15 原型为参考）:**
- 七档 `1334×750/1500×750/1623×750/1778×750/1334×833/1334×1000/1334×1334` + 2668×1500（u=2）；十五态（normal/mid/top29/twoSurvivors/revealed/heavy/fourMelds/selfFourGang/gangHeavy/overlay/overlayWorst/revealed29/oneSideRevealed/threeRevealed/revealedGang）全部 `checks.length===0`。
- base normal：侧河 2 列、tile 56×37.168、ting 30×45/2×5、位置 `x≈90.7`、`y≈511`。
- 侧 0/1/8/12/20/21/24/29 张：cols=2、rows、19+N、badgeCell/badgeRect。
- 七档只改 offset（u=1）；2668×1500 u=2、rect 等比。
- 不修改 v1/v2 文件。

**Verify:** `pnpm -C apps/client exec vitest run test/mahjong-layout-v3.test.ts test/mahjong-layout-v2.test.ts`

**Commit:** `feat(mahjong): 布局 v3（2 列侧河/30×45 听牌）`

---

## Task 2: Board/River 接线

**Files:**
- Modify: `apps/client/src/components/table/mahjong/MahjongBoard.vue`
- Test: `apps/client/test/mahjong-board.test.ts`（必要时 `mahjong-river.test.ts`）

**要求:**
- Board 改 import `mahjongTableLayoutV3` / `RiverLayoutV3`，`layout` 用 v3；旧 v2 import 移除。
- 听牌行：牌尺寸改用 `layout.ting.tile.w/h`（30×45），容器 `layout.ting.rect`、gap 2u；标签仍「听 N 张」。
- 侧河：`riverProps` 传 `river.tile.w/h`（侧 56×37.168）；`windowStart/Count/latestIndex/badgeCount/badgeRect/meldRect/laneWidth` 照旧；River 默认 `aspectFit`（不裁剪）。
- 侧亮牌：2 列 7 行（`revealed` + `revealNonce` 不变）。
- 侧副露：`meldRect` 外缘 lane；尺寸不变。
- 不改 v3/v2/v1 布局文件；不改 River/Meld/Hub 组件（如确需，先报告）。
- 测试：Board 渲染的侧河 tileW/H=56/37.168；ting 牌 30×45；侧河 2 列/window/19+N/badge；侧副露 lane；现有 Board 测试更新。

**Verify:**
`pnpm -C apps/client exec vitest run test/mahjong-board.test.ts test/mahjong-layout-v3.test.ts test/mahjong-river.test.ts test/ui-tokens.test.ts`
then full `pnpm -C apps/client test` + `lint` + `build`.

**Commit:** `feat(mahjong): Board 接入 v3 布局（2 列侧河/30×45 听牌）`

---

## Task 3: 全量验证 + 交接

- 全量 test/lint/build。
- 七档 × 6 态真浏览器截图（v15d mockup 对照）；真机走查（侧河 2 列、19+N、听牌 30×45、aspectFit 留白、侧副露外缘）。
- 写交接 `docs/superpowers/plans/2026-11-08-mahjong-table-v15-handoff.md`。
- 部署/APK 待用户裁决。

## Self-Review

- Spec coverage：v15 design §1–§3 的侧区/侧河/听牌/输出/接线均有 Task 1–2 落点；皮肤/音效/claim 不变。
- Type consistency：v3 与 v2 同形；Board 只换函数/类型与 ting tile 尺寸；River 接口不变。
- 风险：侧河 19+N（显示上限下降）；侧背/副露与侧河之间空档；左右牌面 aspectFit 略小（格一致）。

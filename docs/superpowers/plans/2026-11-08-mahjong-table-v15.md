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

---

## Review corrections（2026-11-08 独立对抗审查，绑定；先于 Task 1 执行）

### Critical
- **C1 测试数值**：`normal` 的 `ting=0`，`ting` 为 0×0；不要写 `x≈90.7,y≈511` 作为 base normal。准确值：
  - `normal + ting:9` → `ting.rect = (50.34, 511, 158, 92)`；
  - `heavy` → `(90.74, 511)`；`mid` → `(90.74, 462.2)`；
  - `ting:1` → `(50.34, 534.5, 30, 45)`；`ting:5` → `(50.34, 534.5, 158, 45)`；
  - 侧 `0` 张 → `cols=0, rows=0, rect=0×0`（不是 2 列）。
- **C2 ting y**：`tingH = rows*45 + (rows-1)*2`；`y = ownRiverTop + (ownRiverH - tingH)/2`（不能硬编码 92）。
- **C3 ting 对齐**：Board 的 `.mj__ting` 从 flex 换 **5 列 grid**（`grid-template-columns: repeat(ting.cols, ting.tile.w)`，`grid-auto-rows: ting.tile.h`；或至少 `justify-content:flex-start`），否则 6–9 张的部分行会居中，和 mockup 不一致；补 Board 对齐测试。
- **C4 `checks`**：v3 输出必须带 `checks: string[]`（或测试侧自建 pair 检查器）；否则 15 态 `checks.length===0` 无法执行。推荐 v3 暴露 `checks`。
- **C5 坐标帧**：v3 的 `badgeRect`/`meldRect` 与 v2 一样是**画布坐标**（`tr()` 缩放后）；Board 在 River 边界减一次。不要返回河块局部坐标；补 Board 测试（侧河 badge/meld 的局部值）。

### Important
- **I1** `overflow` 是**数字** `raw - visible`（v2 契约）；`raw>20` 只作为窗口/徽标条件，不叫 overflow。
- **I2** `sideTop = 左右座位牌底 + gap + (revealed>0 ? 16 : 0)`；补 revealed 的 y 断言。
- **I3** `RiverLayoutV3` 是 v2 的严格超集：`rect,tile,cols,rows,gap,fit,raw,visible,overflow,revealed,windowStart,windowCount,latestIndex,badgeCount,badgeCell,badgeRect,meldRect,laneWidth,meld{tileW,tileH,overlap,groupGap,scale,contentW}`；侧 meld 用已缩放尺寸（0.65：约 36.4×29.71）。
- **I4** 动作区/hub **不再等同 v13**：去掉侧河后 `actions.left` 右移；v15 原型 normal 1107.66、有副露 1067.26；hub 因 `zoneW=max(left,right)` 恒居中（centerCx=667）。删除 spec §1.4 的“动作区不变”并测试新 x。
- **I5** v15 的 `zoneW` 用左右两侧最大值（对称居中）；不要在 `heavy` 等非对称副露态断言 v13 的 centerCx。
- **I6** 空侧河：`visible>0 ? cols=2 : cols=0`，`rows=0`，rect 0×0；`blockW=114` 只在 visible>0 时成立。
- **I7** `ting.cols = min(count,5)`（0 张为 0）；宽度/grid 都用它，不能固定 5。
- **I8** ting 与自家河实际间隙 184–224px（自家河 12 列时）；不要写“≥250px”，改为“≥180px / 不相交”。
- **I9** 牌格 h 四舍五入 **37.17**（`56*75/113=37.16814`）；测试用 `toBeCloseTo` 或 37.17；块高用 37.168，0.02px 差可接受但注明。
- **I10** 侧河块 x 随上/下河 16→17 张从 8→12 列跳约 78.5px（左 393.33→314.99；右 826.67→**905.01**，以几何原型实测为准；原文 905.17 系笔误）。本版**接受并测试**该一次性布局跳变（用户选 2 列方案），补 16/17 张 fixture。
- **I11** 增加 pair/gap 断言：`selfMeld×leftRiver/rightRiver`、`topMeld×leftRiver/rightRiver`；最紧间隙侧河底 565.84 vs selfMeld 顶 569.2（3.36px），断言为正间隙。
- **I12** Board 测试：`mahjong-board.test.ts` 里所有 `mahjongTableLayoutV2` import 改 v3；ting label 测试（原 `layout.ting.left/top`）改 `ting.rect`；加 v3-only 锚点（如 `ting.rect.left` 或侧河 rect），确保 Board 真的用 v3。
- **I13** Task 1 不是照抄原型：**从 v2 复制**，保留 `normalizeSeat`/`r2`/顶层输出形状/`rects`/`backs`/`seatPlates`/`hand`/`actions`/`topMeld`/`bannerAnchors`；只替换侧区/侧河/ting 的数学。规范化测试 `[5,2,3,3,4]→4 组/3,4,3,3` 必须保留。
- **I14** 侧河 `meldRect` 的局部 x 为负（外缘 lane 在河块左侧）；River 的 `overflow:visible` 已支持。补 Board/River 测试：(a) 有副露 0 弃牌（河块 0×0，meld 仍渲染）；(b) 侧河 19+10 徽标。
- **I15** Board 三处 ting 触点：`tingStyle` 用 `layout.ting.rect`；`tingLabelStyle` 用 `layout.ting.rect.left/top`；tiles 用 `layout.ting.tile.w/h`；`rects.ting = ting.rect`。

### Minor（顺手）
- 原型头注释仍写 v14/引用不存在的 v14 路径 → 改 v15。
- 原型 `sideBandTop/sideRows/sideRiverH/sideRiverY`（L161-166）是死代码且 `T.sideRows` 未定义（NaN），不要移植。
- `v15d-*.png` 是约 0.87 缩放的内嵌渲染；像素对比请直接渲染 `index-v15d.html` 到 1334×750。
- 切换后更新 Board 头注释（v2→v3）、`mj__ting` 的 20×30 注释、`mahjong-claims.ts` 的“生产布局 v2”注释。
- `ting` 的 0 张：cols/rows 定为 0，rect 0×0。
- 面积说明：aspectFit 可见 45.53×37.17 vs 上下 36.67×56 → 约 17.6% 小（不是 19%）。
- 侧背/副露的 `sideTop` 改为 plate-only，`heavy` 等态相对 v13 上移约 38.8px；这是决策 #2，spec §2“侧背同 v13”需改词。
- 原型自带 runner：Node 测试 import 时设 `V15_QUIET=1`，否则会 `process.exit`。
- 命令写全：`pnpm -C apps/client lint`、`pnpm -C apps/client build`。

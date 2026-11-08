# 川麻红金 v15 牌河/听牌布局设计（2026-11-08）

状态：已确认（用户选 v15 + aspectFit 不裁剪）
取代：v13 的左右河/听牌布局部分；v13 其余（固定 base、Hub、动作区、音效、皮肤）不变。
几何原型：`docs/superpowers/specs/2026-11-08-mahjong-table-v15-geometry.mjs`（七档 × 十五态 ALL GREEN）
视觉基线：`.superpowers/mahjong-redgold/mockup/index-v15d.html`（同几何，aspectFit）

## 0. 用户决策

1. 左右河**固定 2 列**（不再 1 列→2 列切换），整体向中央信息井方向移动。
2. 侧副露/侧背保持 overlayWorst 的外缘布局（背在最外、副露 lane 紧挨其内）。
3. 听牌区 **30×45、2 行×5 列、左下**（侧副露 lane 右侧、自家河左侧），带「听 N 张」标签。
4. 左右出牌牌面尺寸与上下家一致：上/下牌格 37.17×56，左右旋转为 **56×37.17**；左右素材 49×40 用 **aspectFit**，**不裁剪**（牌面可见 45.5×37.17，左右各约 5.25px 留白）。

## 1. 布局规则（base 1334×750）

### 1.1 侧区（外缘）
- 位置：`sideTop = 左/右座位牌底 + gap`（不再取 topRiver 顶；侧区元素在中央河列之外，不会被顶河挡住）；`sideBottom = handTop − 16`。
- 侧背：`backW = 45.714×75/113 = 30.34`，14 张、`pitch = clamp((avail−45.714)/13, 8, 22)`。
- 侧副露 lane：`x = outer + backW + gap`（左）/ `W − outer − backW − gap − laneW`（右）；垂直居中于 side 带；`laneW` 按 0.65 缩放（最多 4 组，必要时缩到 ≥0.4）。
- 侧区宽按左右两侧取最大（对称居中）：`zoneW = backW + gap + max(laneW_left, laneW_right)`；中央区 `centerW = W − 2×(outer + zoneW + gap)`。
- 上/下河宽度随 centerW 变宽；上/下河仍是 8/12 列 × 2 行。

### 1.2 侧河块（内侧，hub 左右）
- **固定 2 列**；`visible = min(raw, 24)`；`rows = visible > 0 ? min(10, ceil(visible/2)) : 0`。
- 牌格 `56×37.168`（= 顶牌 37.168×56 旋转 90°）；左右素材 aspectFit。
- `blockW = 2×56 + 2 = 114`；`blockH = rows×37.168 + (rows−1)×2`（10 行 = 389.68）。
- 位置：
  - 左：`x = min(topRiver.left, ownRiver.left) − 4 − blockW`
  - 右：`x = max(topRiver.right, ownRiver.right) + 4`
  - `y = sideTop + (avail − blockH)/2`
- 窗口：`overflow` 为数值 `raw − visible`（v2 契约）；`raw > 20` 仅是窗口/徽标条件（`windowCount = raw > 20 ? 19 : visible`）；`badgeCount = raw − windowCount`；`windowStart = raw − windowCount`；`latestIndex = windowCount − 1`；`badgeCell = windowCount`。
  - 29 张 → 19 张 + `+10`；20 张 → 20 张；≤20 无徽标。
- `badgeRect`：2 列网格第 `windowCount` 格（`row=floor(windowCount/2)`，`col=windowCount%2`），**画布坐标**（Board 在 River 边界减一次河块原点）。
- 亮牌 `revealed`：`raw = revealedCount`；`visible = min(raw,24)`；无 overflow/徽标；行数同上。

### 1.3 听牌区
- 牌格 **30×45**；`2 行 × 5 列`（最多 9）；gap 2。
- 位置：`x = outer + backW + gap + laneW + gap`（= 侧副露 lane 右侧）；`y = ownRiverTop + (ownRiverH − tingH)/2`（自家河带内，但 x 远离自家河）。
- 标签「听 N 张」在 ting 上方 18px；12px、漆底金边。
- 与自家河横向间隙 ≥180px（自家河 12 列时实测约 184–224px），且与左侧河（若存在）不相交。

### 1.4 不变量
- 上/下河、手牌、座位牌、banner 锚点、tile 尺寸（顶/自/背）不变。
- hub 恒居中（`zoneW` 取左右最大值）；动作区随侧区宽度右移，**不再等同 v13**：normal 左缘 ≈1107.66、有副露（zoneW=74.74）≈1067.26。
- 所有 rect 在画布内、互不相交（v15 原型的 pairs 全绿）。
- 旧 v1 `mahjong-layout.ts` 与其测试冻结；v2 `mahjong-layout-v2.ts` 保留（回滚面），生产切到 v3。

## 2. 输出/接口（v3）

`mahjongTableLayoutV3(W,H,input)` 与 v2 同形：
`u/offsetX/offsetY/rects/hub/rivers/seatPlates/hand/backs/actions/ting/topMeld/bannerAnchors`。
- `rivers.left/right`：`rect`（2 列块）、`tile {w:56,h:37.168}`、`cols:2`、`rows`、`window*`、`badge*`、`meldRect`（外缘 lane）、`laneWidth`。
- `rivers.top/self`：同 v13（8/12 列 ×2，窗口 23+N）。
- `ting`：`{ rect, tile:{w:30,h:45}, cols:5, rows }`。
- `backs`：侧背仍在最外缘，但 `sideTop` 改为「座位牌底 + gap」（亮牌再 +16），比 v13 上移（heavy 等态约 38.8px）；`seatPlates`/`hand`/`bar` 同 v13，`actions`/`hub` 按 v15 新值。
- `rects` 包含左右河块、侧 lane、侧背、badge。

## 3. 组件接线

- `MahjongBoard.vue` 改用 `mahjongTableLayoutV3`；`riverProps` 传 `tileW/tileH`（侧 56×37.168）；`ting` 行用 `layout.ting.tile`（30×45）；其余不变。
- `MahjongRiver.vue` 无需新逻辑：现有 `windowStart/windowCount/latestIndex/badgeCount/badgeRect` + 2 列网格即可；tile `mode` 默认 `aspectFit`（不裁剪）。
- `MahjongMeld`/侧副露：位置由 `meldRect`（外缘 lane）给出；尺寸不变。
- 侧河亮牌：`revealed` + `revealNonce` 不变；2 列 7 行。
- 音效/claim/lastDiscard/banner 不变。

## 4. 测试矩阵

- 七档：1334×750、1500×750、1623×750、1778×750、1334×833、1334×1000、1334×1334；另 2668×1500（u=2）。
- 十五态（v15 原型 states）：normal/mid/top29/twoSurvivors/revealed/heavy/fourMelds/selfFourGang/gangHeavy/overlay/overlayWorst/revealed29/oneSideRevealed/threeRevealed/revealedGang。
- 侧河：0/1/8/12/20/21/24/29 张 → 2 列、rows、19+N、badgeRect。
- 听牌：0/1/5/9 张 → 30×45、2×5、位置/标签。
- 侧牌格：56×37.168；顶/自 37.168×56；aspectFit（组件默认）。
- 位置：左/右块与 top/own/hub/actions/plate/backs/lane/ting 不相交；七档居中。
- 回归：全量 client、vue-tsc、uni build。

## 5. 已知取舍

- 侧河显示上限从 24 降到 **19 + N**（2 列×10 行；20 格含徽标）。要显示 24 需 3 列或缩小牌高；用户选 19+N。
- 侧背/侧副露留在外缘，侧河在内侧 → 两者之间有空档；这是“侧河靠近信息井”的代价。
- 左右牌面 aspectFit → 可见牌面 45.53×37.17（比上下家牌面 36.67×56 小约 17.6% 面积；格尺寸相同）。
- 侧河 2 列块的位置随上/下河宽度（8/12 列）移动；距 hub 约 60–140px。
- 旧 v2 布局保留，可随时回滚。

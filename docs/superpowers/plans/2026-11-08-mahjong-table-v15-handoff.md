# 川麻红金 v15 交接（2026-11-08）

## 当前状态

- **v15 已实现**（本机 `dev`，工作树 clean），实现提交：
  - `803849c8` docs(mahjong): v15 计划 I10 修正与 spec 措辞对齐原型
  - `b74ecf1c` feat(mahjong): 布局 v3（2 列侧河/30×45 听牌）
  - `12713349` feat(mahjong): Board 接入 v3 布局（2 列侧河/30×45 听牌）
  - `b17ddbc9` fix(mahjong): v15 终审修复（Board 测试类型、v3 注释与文档措辞）
  - 本 Task 的版本提交：`chore(client): v15 实现验证、版本 0.1.12/112 与交接`（manifest `0.1.12`/`112` + 本交接重写）
- **全量验证已过**：`pnpm -C apps/client test` **1995 passed / 2 skipped**（133 passed + 2 skipped 文件）；
  `pnpm -C apps/client lint`（`vue-tsc --noEmit`）exit 0 无输出；`pnpm -C apps/client build` `DONE Build complete.`。
- **未推送、未部署、未重打 APK**：origin/dev 不含以上提交；测试服仍 `dev-362b9f9`（红金皮肤首版）+ APK **0.1.11/111**（sha256 `83f655a3fa56…`）。生产/master 未动。

## 用户已确认的 v15 设计（实现按此落地）

1. 左右河**固定 2 列**（不再 1→2 列切换），整体向中央信息井方向移动；29 张 = **19 张 + N**。
2. 侧副露/侧背保持 overlayWorst 的**外缘**布局（背最外、副露 lane 紧挨其内）。
3. 听牌 **30×45、2 行×5 列、左下**，带「听 N 张」标签；距自家河约 184–224px（12 列自家河时）。（**v19 起改为贴手牌行左缘 x=146.23，12 列间隙 128.76**）
4. 左右出牌牌格与上下家**同尺寸旋转**：上下 37.17×56 → 左右 **56×37.17**；左右素材 49×40 用 **aspectFit，禁止裁剪**（可见 45.5×37.17，两侧留白）。
5. 侧河块与 hub 约 60–140px；动作区/hub 位置因侧区变窄而右移/居中（**不是** v13 的旧值）。

## 实现落地

- **`apps/client/src/game/mahjong-layout-v3.ts`（新，纯函数零依赖，`mahjongTableLayoutV3`）**
  - 固定 1334×750 base 构图；几何逐行移植自几何原型的 `layoutBase`；输出矩形/长度统一四舍五入 2 位小数，`u`/offset 保持精确值。
  - 侧河固定 2 列、最多 10 行（20 格 = 19 张 + N 徽标），河块移到信息井左右两侧；侧河 tile **56×37.17**（`sideRiverTileW: 56`）。
  - 侧背 / 侧副露 lane 留在外缘，`sideTop = 座位牌底 + gap`（亮牌再 +16）；`sideMeldFit` 把副露缩放进 lane（约 36.4×29.71）。
  - 听牌 **30×45、2 行 × 5 列**（`ting = { rect, tile, cols, rows }`），位于侧副露 lane 右侧、自家河左侧。（**v19 起贴手牌行左缘**）
  - `zoneW` 取左右两侧最大值（hub 恒居中）；输出带 `checks: string[]`（画布越界 + 原型 pairs）。
  - `RiverLayoutV3` 是 v2 的严格超集（含 `gap/fit/meld/laneWidth/...`）；`badgeRect` / `meldRect` 为**画布坐标**。
- **`apps/client/test/mahjong-layout-v3.test.ts`（新）**：7 档 × 15 态；侧河 0/1/8/12/16/17/20/21/24/29 张；ting 0/1/5/9；计划 `## Review corrections` 的精确值；16→17 张跳变用例。
- **`apps/client/src/components/table/mahjong/MahjongBoard.vue`（接线点）**
  - import 切 `mahjongTableLayoutV3` / `RiverLayoutV3` / `SeatLoadV3` / `TableInputV3`。
  - 听牌容器 = `ting.rect`，改 **5 列 grid**（`repeat(ting.cols, ting.tile.w)`，行高 `ting.tile.h`，残行从第 1 列左对齐）；听牌牌 `:w="ting.tile.w" :h="ting.tile.h"`（30×45）；「听 N 张」标签用 `ting.rect.left/top`。
  - 侧河 tile 直接取 `river.tile`（56×37.17）；`MahjongTile` 默认 **aspectFit**（不裁剪，两侧留白）。
  - `badgeRect` / `meldRect` 经 `localRect()` 转为河内**局部坐标**；侧副露 `meldRect.left` 为负（在河块左侧），Board 测试已钉。
  - `apps/client/src/game/mahjong-claims.ts` 仅注释同步为「v3 自带侧河 19+N、20 格封顶的窗口数学」。
- **Board 测试**：`apps/client/test/mahjong-board.test.ts` 全部 import 切 v3 + v3-only 锚点（v2 数值断言退役）。
- **v1/v2 冻结**：`apps/client/src/game/mahjong-layout.ts` / `mahjong-layout-v2.ts` 及其测试**未动**（v2 仍可作回滚目标）。

## 回滚面

- **代码回滚**：`MahjongBoard.vue` 切回 `mahjongTableLayoutV2`（v2 文件与测试在位；v15 只新增 v3 + 接线）。
- **部署回滚**：测试服回 `dev-362b9f9`（红金皮肤首版）+ 旧 APK 0.1.11/111。

## 文件

- 设计 spec：`docs/superpowers/specs/2026-11-08-mahjong-table-v15-design.md`
- 实现计划：`docs/superpowers/plans/2026-11-08-mahjong-table-v15.md`（末尾 `## Review corrections` 是测试精确值的绑定依据）
- 几何原型：`docs/superpowers/specs/2026-11-08-mahjong-table-v15-geometry.mjs`（7 档 × 15 态 ALL GREEN；Node 直接跑；测试 import 时设 `V15_QUIET=1`）
- 视觉基线：`.superpowers/mahjong-redgold/mockup/index-v15d.html`；截图 `.superpowers/mahjong-redgold/v14-shots/v15d-{mid,top29,overlayWorst}.png`（截图约 0.87 缩放内嵌；像素对比请重渲染到 1334×750）

## 验证证据（2026-11-08，`b17ddbc9` + 版本提交的树）

| 命令 | 结果 |
|---|---|
| `pnpm -C apps/client test` | Test Files **133 passed \| 2 skipped (135)**；Tests **1995 passed \| 2 skipped (1997)**；21.95s |
| `pnpm -C apps/client lint` | `vue-tsc --noEmit`，无输出，exit 0 |
| `pnpm -C apps/client build` | `vue-tsc --noEmit && uni build` → `DONE Build complete.`（日志中 `/static/ui/*` 的「didn't resolve at build time」为 uni 既有运行时解析提示，非本次引入） |

- 几何原型：`node docs/superpowers/specs/2026-11-08-mahjong-table-v15-geometry.mjs | tail -1` → `ALL GREEN`。

## 下一步（需用户裁决）

1. **推送 `dev`**（origin/dev 不含 v15 实现与版本提交；dev 推送零 CI）。
2. **部署测试服**（`deploy-dev.sh`；将一并带上 `dev-362b9f9` 之后未部署的 `4d09d334` 皮肤修正等既有提交）。
3. **重打 APK 0.1.12/112**（此前 APK 为 0.1.11/111）。
4. **七档截图 / 真机走查**：侧河 2 列、19+N 徽标、听牌 30×45、aspectFit 留白、侧副露外缘、16→17 张跳变。

## 已知 Minor（终审分诊后，均不阻断）

- `sideMeldFit` 收缩路径（比例 <0.65）无 fixture 覆盖（`mahjong-layout-v3.ts` 约 :453–462），列为后续补测候选。
- v2 沿袭噪音：`s/sc` 脚手架与未用 token（`sideTileW` / `actionBtn` / `actionGap` / `SideBase.sideBottom`），后续清理。
- 建议补**分数倍 canvas**（非 1334×750 整数倍缩放）几何测试 —— 终审记为 defer。
- 终审要求顺手补的事项已全部闭合于 `b17ddbc9`：I9 的 0.02px 刻意差注释、Board 测试头注释 v2→v3、spec/plan/原型措辞漂移；**无遗留 Critical/Important**。

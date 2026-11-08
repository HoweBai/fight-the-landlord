# 川麻红金 v15 交接（2026-11-08）

## 当前状态

- **测试服**：`dev-362b9f9`（红金皮肤首版）+ APK **0.1.11/111**（sha256 `83f655a3fa56…`）。生产/master 未动。
- **本机 dev**：在 `8c565482` 之后还有本次的「v15 计划审查修订 + 交接」提交；`4d09d334`（皮肤 mockup 修正：座位牌角标槽位/血战盘单字徽标/字体栈）**也已提交但未部署**。
- **v15 未实现**：没有任何生产代码改动；旧 `mahjong-layout.ts` / `mahjong-layout-v2.ts` 与其测试未动。

## 用户已确认的 v15 设计

1. 左右河**固定 2 列**（不再 1→2 列切换），整体向中央信息井方向移动；29 张 = **19 张 + N**。
2. 侧副露/侧背保持 overlayWorst 的**外缘**布局（背最外、副露 lane 紧挨其内）。
3. 听牌 **30×45、2 行×5 列、左下**，带「听 N 张」标签；距自家河约 184–224px（12 列自家河时）。
4. 左右出牌牌格与上下家**同尺寸旋转**：上下 37.17×56 → 左右 **56×37.17**；左右素材 49×40 用 **aspectFit，禁止裁剪**（可见 45.5×37.17，两侧留白）。
5. 侧河块与 hub 约 60–140px；动作区/hub 位置因侧区变窄而右移/居中（**不是** v13 的旧值）。

## 文件

- 设计 spec：`docs/superpowers/specs/2026-11-08-mahjong-table-v15-design.md`
- 实现计划：`docs/superpowers/plans/2026-11-08-mahjong-table-v15.md`（末尾 **`## Review corrections` 是绑定修订**）
- 几何原型：`docs/superpowers/specs/2026-11-08-mahjong-table-v15-geometry.mjs`（7 档 × 15 态 ALL GREEN；Node 直接跑；测试 import 时设 `V15_QUIET=1`）
- 视觉基线：`.superpowers/mahjong-redgold/mockup/index-v15d.html`；截图 `.superpowers/mahjong-redgold/v14-shots/v15d-{mid,top29,overlayWorst}.png`（截图约 0.87 缩放内嵌；像素对比请重渲染到 1334×750）

## 对抗审查结论（必须遵守）

几何本身 120/120 全绿、无意外相交；但**原计划不可直接执行**。5 个 Critical + 15 个 Important 已写入计划的 `## Review corrections`，要点：

- **测试数值**：`normal` 的 ting 是 0×0；`normal+ting9` → `ting.rect=(50.34,511,158,92)`；`heavy` → `(90.74,511)`；`mid` → `(90.74,462.2)`；`ting:1/5` y=534.5；侧 0 张 → cols=0/rows=0/0×0。
- **ting y** 用 `rows*45+(rows-1)*2`，不能硬编码 92；ting 宽度/`cols = min(count,5)`。
- **Board ting 对齐**：`.mj__ting` 改 5 列 grid（或 flex-start），否则 6–9 张部分行居中错位。
- **v3 输出**：`checks: string[]`、`overflow` 是数字、`badgeRect/meldRect` 是画布坐标、`sideTop` 加 revealed +16、`RiverLayoutV3` 是 v2 严格超集（含 `gap/fit/meld/...`，侧 meld 已缩放约 36.4×29.71）。
- **动作区/hub 不再等同 v13**：normal actions x≈1107.66、有副露 ≈1067.26；hub 恒居中（zoneW=max(left,right)）。
- **侧河块 x 随上/下河 16→17 张跳 ~78.5px**：本版接受并加 16/17 张测试。
- **Board 测试**：所有 `mahjongTableLayoutV2` import 改 v3；ting label 改 `ting.rect`；加 v3-only 锚点。
- **Task 1 从 v2 复制结构**（保留 normalizeSeat/r2/顶层形状），只换侧区/侧河/ting 数学；不要把原型整体照抄。
- **TDD**：先按 `Review corrections` 的精确值写测试，再实现；每个 Task 绿后提交。

## 下一步（新会话）

1. 读 spec + plan（尤其末尾 Review corrections）+ 几何原型；如需，先修订 spec 的 §1.4/§1.5 假不变量。
2. **Task 1**：新增 `apps/client/src/game/mahjong-layout-v3.ts`（从 v2 复制 + v15 原型侧区/侧河/ting 数学）+ `mahjong-layout-v3.test.ts`（7 档 × 15 态、侧 0/1/8/12/16/17/20/21/24/29、ting 0/1/5/9、review corrections 的精确值）。
3. **Task 2**：Board 切 v3；ting 30×45 + 5 列 grid；侧河 tile 56×37.17（默认 aspectFit）；侧 meldRect 负局部 x；Board 测试重定向 v3。
4. 全量 `pnpm -C apps/client test` + `pnpm -C apps/client lint` + `pnpm -C apps/client build`。
5. 版本号升 **0.1.12 / 112**（当前 0.1.11）；推送 dev → 部署测试服 → 重打 APK（需用户确认；部署会同时带上 `4d09d334` 皮肤修正 + v15）。
6. 七档截图/真机走查：侧河 2 列/19+N/aspectFit 留白、听牌 30×45、侧副露外缘、16→17 张跳变。

## 回滚面

- 当前测试服：`dev-6e4d634`（旧绿桌）→ `dev-362b9f9`（红金皮肤）。v15 部署后回滚到 `dev-362b9f9`。
- 代码回滚：v15 只新增 v3 + Board 接线；v2 保留，可切回。

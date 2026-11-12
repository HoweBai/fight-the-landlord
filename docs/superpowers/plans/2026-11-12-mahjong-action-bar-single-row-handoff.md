# 川麻红金 v17 交接（2026-11-12）

## 当前状态

- **v17 已实现**（本机 `dev`，工作树 clean），实现提交：
  - `6d4f37de` feat(mahjong): 动作区单行化（按模式自适应宽度）—— Task 1
  - `1dc9c590` fix(mahjong): v17 终审测试补强（多杠选择/禁用/仅过）—— 终审
  - `ab10e538` docs(mahjong): v17 复审文档/注释对齐 —— 复审
  - 文档提交：`dbe45e5e` / `9a94a79a` / `84e7118f`（spec 与计划 / 计划审查）
  - 本 Task 提交：`docs(mahjong): v17 动作区单行化实现交接`（本文件）
- **全量验证已过**（见下表）：`test` **1989 passed / 2 skipped**（133 passed + 2 skipped 文件，共 135）、`lint` exit 0、`build` `DONE Build complete.`。
- **未推送、未部署、未重打 APK**：origin/dev 不含以上提交（本交接提交后本机 dev 领先 7 个提交）；部署回滚点仍 `dev-2ded548`。
- **版本保持 0.1.12/112**（`apps/client/src/manifest.json`，未 bump）。

## 改动

- **`apps/client/src/components/table/mahjong/MahjongActionBar.vue`（单行动作带）**
  - 宽度表 D3：play 1→176 / 2→102 / 3→66（4 防御 50）；claim 1/2→102、3→66、≥4→50；lack 3×66；exchange 140。根宽 = `n×w + (n−1)×6`，最大 **218**（claim-4 = 4×50+3×6）。
  - 高 64、gap 6；**主字 24px**（皮肤测试钉死）、副字 `$ftl-font-xs`（22px）、按钮 `line-height: 1`（牌面 + 文本的 64 高预算）。
  - claim 胡：**20×30 牌面在上 + 「胡」**（不再写牌名）；play 胡不渲染牌面。
  - 多杠：「杠」+ 下方小数字；选择面板绝对定位在条上方（宽 218、显式 2 列、项高 48，不占行高）。
  - exchange：单按钮「换三张」+ 副字「已选 x/3」（旧 70px 提示折行溢出方案已废弃）。
  - 布局尺寸一律 `calc(Npx * var(--mj-u, 1))`；内容细节（按钮内 gap 2 / 圆角 / 发丝边）保持 px（生产 u≡1）。皮肤/动画/禁用/emit 原样保留。
- **`apps/client/src/components/table/mahjong/MahjongBoard.vue`（`actionBarStyle` 锚点）**
  - 右缘 = `round2(canvasW − (actions.left + actions.width))`、底边 = `round2(canvasH − (actions.top + actions.height))`、`zIndex: 3`；`canvasW/canvasH` 已做 finite/>0 sanitize（回退 1334×750）——避免对已四舍五入的 layout 值做减法产生 `50.33999999999992` / `90.74000000000001` 之类的尾差。
- **`apps/client/src/game/mahjong-layout-v3.ts`（仅注释）**
  - 在 tokens 旁记录：218 条向左超出 `actions` 矩形（176）42px，布局 `checks` 不覆盖 ⇒ 改几何必须重算 `mahjong-layout-v3.test.ts` 的「v17 动作带几何守护」。
- **测试**
  - `apps/client/test/mahjong-action-bar.test.ts` 重写 v17 用例（宽度表/单行/无 grid/claim 牌面/exchange 副字/lack 推荐/多杠面板/禁用/源码闸）；**「红金皮肤（Task 3）」describe 原样保留**（计划审查高项）。
  - `apps/client/test/mahjong-board.test.ts` 迁移：`胡 5万` → `胡`、`buttonByText('换三张')` → 前缀查找、旧 left/top/width 锚点 → right/bottom/z-index。
  - `apps/client/test/mahjong-layout-v3.test.ts` 新增「v17 动作带几何守护（218 宽）」：最坏态 fixture 自证（actions.left 1067.26 / 右河宽 114 / windowCount 19）+ 余量 6.25px ≥ 6。

## 设计 / 审查 / 预览

- 设计 spec：`docs/superpowers/specs/2026-11-12-mahjong-action-bar-single-row-design.md`（用户已选 **方案 A：紧凑单行**；含 **§9 审查记录：1 阻断 + 4 高 + 10 低，均已修订**）。
- 实现计划：`docs/superpowers/plans/2026-11-12-mahjong-action-bar-single-row.md`（含 **计划审查记录：2 阻断 + 1 高 + 10 低，均已修订**；末尾 **Review corrections（终审后）** 记录 `1dc9c590` 与 `ab10e538` 之后与计划代码快照的差异，重放时以当前仓库为准）。
- 终审 `1dc9c590`：补强多杠选择 / 出牌禁用 / claim 仅过测试，并去掉 gang-item 重复 `height`。复审 `ab10e538`：文档与头注释对齐服务端 claim 顺序（胡→杠→碰→过）。

## 真浏览器对照（已执行，非单测）

- 方式：临时 Vite 入口 `apps/client/v17-preview.html` + `apps/client/src/v17-preview.ts` 挂载**真实 `MahjongBoard`**（fixture 抄 `test/mahjong-board.test.ts` 的 `view()/props()`，不依赖后端房间）；`pnpm -C apps/client exec vite --port 5179 --host 127.0.0.1`（后台）；Playwright 缓存 Chromium 1243 headless，1334×750，CDP 截图 + `getBoundingClientRect` 取证。
  - ⚠️ 复现要点：普通 Vite 页里 uni-h5 的 `<image>` 组件会在 `getRealPath` 读全局 `window.__uniConfig`（正常 uni 页面由编译器注入）⇒ 不补最小 `__uniConfig` 时牌面全部空白。本次 harness 已补；页面控制台零错误。
- 截图（`.superpowers/` 已 gitignore，未入库）：
  - `.superpowers/mahjong-redgold/v17-shots/play3.png` —— play：胡 / 杠 / 出牌 3 键单行（66px），**出牌最右**（right=1283.67），选中 1 张。
  - `.superpowers/mahjong-redgold/v17-shots/claim4.png` —— claim：碰 / 杠 / **胡（20×30 牌面 + 「胡」）** / 过 4 键单行，根宽 218。
  - `.superpowers/mahjong-redgold/v17-shots/claim4meld.png` —— claim-4 + 左侧副露 + top/self 17 张 + 右河 29 张（19 + `+10` 徽标）最坏几何态：**条左缘 1025.27 vs 右河右缘 1019.00 = 6.27px 不重叠**（设计 6.25）。
  - `.superpowers/mahjong-redgold/v17-shots/exchange.png` —— 单按钮「换三张」+ 副字「已选 2/3」（22px）。
  - `.superpowers/mahjong-redgold/v17-shots/lack.png` —— 万 / 筒（金色「推荐」）/ 条。
  - `.superpowers/mahjong-redgold/v17-shots/gang.png` —— 「杠 2」+ 出牌；**面板在条上方**（panel bottom 542 / bar top 550，间隔 8px），2 列 106×48，不遮牌河。
  - 量化旁证：`.superpowers/mahjong-redgold/v17-shots/metrics.json`（六场景 DOM 矩形/字号/行高/滚动尺寸）。
- 对照结论：六场景全部**单行**（各模式按钮 top 唯一）；主字 24px、line-height 24px、副字 22px；claim4 根宽/scrollWidth 均 218；claim4meld 右河宽 114、高 389.67；50px 键文字与牌面完整可读。claim 呼吸动画（`anim-claim-pulse`）截图瞬时缩放约 1.02（按钮 rect 约 50.8–51.3px），静止态为 50。
- 清理：Vite 进程已停（5179 无 LISTEN）；临时文件 `apps/client/v17-preview.html`、`apps/client/src/v17-preview.ts` 已删除；`git status` clean。

## 回滚

- 代码：本片只动 **6 个代码/测试文件**——`MahjongActionBar.vue`、`MahjongBoard.vue`、`mahjong-layout-v3.ts`（仅注释）、`mahjong-action-bar.test.ts`、`mahjong-board.test.ts`、`mahjong-layout-v3.test.ts`。回滚 = `git revert ab10e538 1dc9c590 6d4f37de`（按倒序逐个 revert；spec/计划文档按需另行 revert）。
- 部署：**v17 未部署**；部署回滚点仍 `dev-2ded548`。

## 验证证据（2026-11-12，`ab10e538` 的树）

| 命令 | 结果 |
|---|---|
| `pnpm -C apps/client test` | Test Files **133 passed \| 2 skipped (135)**；Tests **1989 passed \| 2 skipped (1991)**；21.96s；exit 0 |
| `pnpm -C apps/client lint` | `vue-tsc --noEmit`，无输出，exit 0 |
| `pnpm -C apps/client build` | `vue-tsc --noEmit && uni build` → `DONE Build complete.`，exit 0（`/static/ui/*` 的「didn't resolve at build time」为 uni 既有运行时解析提示，非本次引入） |

## 下一步（需用户裁决）

1. **推送 `dev`**（origin/dev 不含 v17；dev 推送零 CI）。
2. **部署测试服**（`deploy-dev.sh`）。
3. **重打 APK 0.1.12/112**。
4. **真机走查**：50px 键手感、claim-4 牌面（20×30 + 「胡」）、多杠面板位置、最坏态 6px 余量。

## 已知取舍

- **50px 键比旧 84px 小**（用户明确选方案 A 紧凑单行）；读性由 24px 主字 + 22px 副字 + `line-height: 1` 补偿。
- 主字 **24 保持**（皮肤测试钉死）；布局尺寸 calc、内容细节 px（生产 u≡1）。
- claim 胡**不再写牌名**（「胡」+ 20×30 牌面表达）；play 胡无牌面。
- **6.25px 最坏态余量是唯一护栏**：条与侧河纵向有 15.84px 重叠带（y=550–614 vs 侧河底 565.84）⇒ 条宽不得再增长。
- `n>4` 只钳宽度表、不防按钮溢出；服务端可达上限为 4（play 3 键）。

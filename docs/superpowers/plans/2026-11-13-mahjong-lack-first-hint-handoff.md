# 川麻红金 v18 交接（2026-11-13）

## 当前状态

- **v18 已实现**（本机 `dev`，工作树 clean），实现/修复提交：
  - `fb23de60` feat(protocol): 麻将视图下发 mustDiscardSuit（缺门引导）—— Task 1
  - `ebe0aee9` feat(mahjong): 视图下发 mustDiscardSuit + conformance 独立 oracle —— Task 2
  - `b7f7c190` feat(mahjong): 缺门出牌引导（先打缺门提示 + 手牌置灰拦截）—— Task 3
  - `0e797106` fix(mahjong): v18 终审测试补强（内容清零/双击复位/相位门）—— 终审
  - 文档提交：`1cba6efe` / `fdaf8091`（spec 初稿 + D11 选中防御）、`15190035` / `fb9c5d02`（spec 审查修订 + 计划 / 计划审查修订）
  - 本 Task 提交：`docs(mahjong): v18 缺门出牌引导实现交接`（本文件）
- **全量验证已过**（2026-11-13 01:13–01:15，见下表）：12 条命令全 exit 0；`client test` **2000 passed / 2 skipped**（133 passed + 2 skipped 文件，共 135）。
- **未推送、未部署、未重打 APK**：origin/dev 不含以上提交（本交接提交后本机 dev 领先 9 个提交）；部署回滚点仍 `dev-e10ed4b`。
- **版本保持 0.1.12/112**（`apps/client/src/manifest.json`，未 bump）；是否 bump 0.1.13/113 由用户裁决。

## 改动

- **协议（`fb23de60`）**
  - `packages/protocol/src/mahjong/types.ts`：`MahjongPlayerView.mustDiscardSuit?: MahjongSuit | null`（仅当自己手里仍有缺门牌时 = 缺门花色；展示提示，服务端仍权威）。
  - `packages/protocol/src/validate.ts`：`assertMahjongPlayerView` 增字段校验 —— 值域 `null|0|1|2`；非 null ⇒ **语义不变式** `=== lackSuits[seat]` 且 `hand` 含该花色（防「合法但错误花色」导致客户端软锁）。
  - `packages/protocol/src/mahjong/mahjong.test.ts`：正向 / null / 负向用例（+41 行）。
- **服务端（`ebe0aee9`）**
  - `packages/game-service/src/games/mahjong/view.ts`：`buildMahjongView` 用**查看者自己的** `player`（`session.players[seat]`）+ 复用 shared 的 `mustClearLack`（`lackSuit !== null && hasLackTiles`）计算，所有阶段都带该字段（客户端只在 `play && amActive` 使用）。
  - `packages/game-service/test/mahjong-runtime.test.ts`：跨座位用例（查看者 0 = 缺万且手里有万 ⇒ `0`；查看者 1 = 缺筒但手里无筒 ⇒ `null`），并补未定缺 / all-phases / `validateOutbound` 面。
  - `tools/conformance/src/lib/mahjong-driver.ts`：新增**独立 oracle** `assertMustDiscard`（不引 shared，按 `lackSuits[seat]` + `hand` 自行推导，抓公式级接线错误）；`playMahjongToEnd` 计数 `mustDiscardSeen`。
  - `tools/conformance/src/slices/slice-36-mahjong.ts`：必选断言 `mustDiscardSeen ≥ 1`。
  - `tools/conformance/test/mahjong-driver.test.ts`：`assertMustDiscard` 单测。
- **客户端（`b7f7c190` + `0e797106`）**（`apps/client/src/components/table/mahjong/MahjongBoard.vue`）
  - `mustDiscardSuit` computed 只在 `phase === 'play' && amActive` 暴露；**紧跟 `amActive` 声明**（防 setup 期 TDZ）。
  - 信息井文案 `先打缺门X`（5 字，`statusText` play 分支）。
  - 手牌可视化：缺门牌金边（`.mj__hand-tile--lack-first`，`outline: $ftl-hairline solid $ftl-color-mj-gold`）、非缺门牌 `opacity: .45`（`.mj__hand-tile--lack-blocked`）；摸牌位包裹层加 `mj__hand-drawn--blocked` 且金点同步压暗为 `.45`。
  - 点击守卫用 `displayTiles[index]`（摸牌位同口径）：非缺门点击 ⇒ 不选中、不发请求、显示「先打完X，才能出其它花色」；**被拦点击复位 `lastClickIndex`**（防「被拦 + 首击」拼成一次双击出牌）。
  - 提示分支**缺门优先**（自带 `phase === 'play' && handSelectable` 门控），压过「再点一次出牌」。
  - 清零（无计时器）：`handSelectable` 翻转 / 手牌内容变化 / `phase` 变化 / `mustDiscardSuit` 变化；D11 版本错配（先选非缺门牌、后收到字段）⇒ 清非缺门选中并禁用出牌。
  - 测试 +147 行（提示/金边/置灰、被拦提示与双击、13→14 摸牌位两向、清零 5 路径、D11、非我的回合与字段 null、claim/rob 相位门、A→B→A 双击复位）。

## 设计 / 审查

- 设计 spec：`docs/superpowers/specs/2026-11-13-mahjong-lack-first-hint-design.md`（**§8 审查记录：无阻断；5 高 + 9 低，均已修订**）。
- 实现计划：`docs/superpowers/plans/2026-11-13-mahjong-lack-first-hint.md`（**计划审查记录：3 阻断 + 2 高 + 9 低，均已修订**；Task 1–4 已勾选）。
- 任务审查：Task 1–3 各自完成后按 sdd 流程做任务级审查再提交（报告在 `.superpowers/sdd/task-lack-{1,2,3}-report.md`，`.superpowers/` 已 gitignore 未入库）。
- **整片终审：With fixes** ⇒ 3 条测试补强已落 `0e797106`（①「仅换手牌」内容清零独立覆盖；② A→B(被拦)→A 400ms 内不触发出牌；③ claim/rob 相位门），另补服务端注释（公式级 oracle 在 conformance）与 driver `mustDiscardSeen` 语义注释。

## 验证证据（2026-11-13，`0e797106` 的树）

| 命令 | 结果 |
|---|---|
| `pnpm -C packages/protocol test` | Test Files **24 passed**；Tests **327 passed**；1.07s；exit 0 |
| `pnpm -C packages/protocol lint` | `tsc --noEmit`，无输出，exit 0 |
| `pnpm -C packages/protocol build` | `tsc`，无输出，exit 0 |
| `pnpm -C packages/game-service test` | Test Files **34 passed**；Tests **281 passed**；4.06s；exit 0 |
| `pnpm -C packages/game-service lint` | `tsc --noEmit && tsc --noEmit -p tsconfig.test.json`，exit 0 |
| `pnpm -C tools/conformance test` | Test Files **2 passed**；Tests **10 passed**；exit 0 |
| `pnpm -C tools/conformance build` | `tsc`，exit 0 |
| `pnpm -C tools/conformance lint` | `tsc --noEmit && tsc --noEmit -p tsconfig.test.json`，exit 0 |
| `pnpm -C packages/api-gateway test` | Test Files **26 passed**；Tests **509 passed**；4.76s；exit 0 |
| `pnpm -C apps/client test` | Test Files **133 passed \| 2 skipped (135)**；Tests **2000 passed \| 2 skipped (2002)**；21.59s；exit 0 |
| `pnpm -C apps/client lint` | `vue-tsc --noEmit`，无输出，exit 0 |
| `pnpm -C apps/client build` | `vue-tsc --noEmit && uni build` → `DONE Build complete.`，exit 0（`/static/ui/*` 的「didn't resolve at build time」为 uni 既有运行时解析提示，非本次引入） |

## 真浏览器对照（已执行，非单测）

- 方式（复用 v17 临时 Vite harness 方法）：临时入口 `apps/client/v18-preview.html` + `apps/client/src/v18-preview.ts` 挂载**真实 `MahjongBoard`**（fixture 抄 `test/mahjong-board.test.ts` 的 `view()/props()`，`mustDiscardSuit: 0`，play + 我的回合 + 13/14 张手牌，不依赖后端房间）；`pnpm exec vite --port 5179 --host 127.0.0.1`（后台）；Playwright 缓存 Chromium 1243 headless，1334×750，CDP 截图 + DOM 取证。页面补最小 `window.__uniConfig.router = { base: '/', assets: 'assets' }`（否则 uni-h5 `<image>` 牌面全白）；**控制台零错误**。
- 截图与量化旁证（`.superpowers/` 已 gitignore，未入库）：
  - `.superpowers/mahjong-redgold/v18-shots/hint.png` —— 13 张、我的 play 回合：信息井 **「先打缺门万」**；7 张万**金边**（`outline rgb(212,162,76) solid 2px`）；6 张筒/条 **`opacity 0.45`**；未选牌 ⇒ 出牌键禁用。
  - `.superpowers/mahjong-redgold/v18-shots/blocked.png` —— 点「筒6」：不选中、无动作请求；手牌上方提示 **「先打完万，才能出其它花色」**（rect 594.98/610，144×15）。
  - `.superpowers/mahjong-redgold/v18-shots/selected.png` —— 点「万1」：选中 1 张、出牌键启用，提示回落到「再点一次出牌（或点"出牌"按钮）」。
  - `.superpowers/mahjong-redgold/v18-shots/drawnBlocked.png` —— 13→14 摸到条1：摸牌位包裹层 `mj__hand-drawn--blocked`，金点 `opacity 0.45`；点它同样被拦提示。
  - `.superpowers/mahjong-redgold/v18-shots/drawnLack.png` —— 13→14 摸到万9：摸牌位为缺门牌（`lack-first` 共 8 张：7 手牌 + 摸牌位），金点正常。
  - `.superpowers/mahjong-redgold/v18-shots/metrics.json` —— 五场景 DOM 矩形/文案/outline/opacity 明细。
- 清理：Vite 进程已停（5179 无 LISTEN）；临时文件 `apps/client/v18-preview.html`、`apps/client/src/v18-preview.ts` 已删除；`git status` clean。

## 真栈（未跑，登记原因）

- **slice-36 未跑**：需**重建并部署新 game-service 镜像之后**才能跑；本 Task 未部署 ⇒ 当前测试服仍是旧镜像（无 `mustDiscardSuit`），旧栈按设计会红（driver `assertMustDiscard` 与 `mustDiscardSeen ≥ 1` 都会失败）。
- 部署后跑法：`pnpm -C tools/conformance build && pnpm -C tools/conformance conformance:slice-36-mahjong`（断言 `mustDiscardSuit` 独立 oracle + `mustDiscardSeen > 0`）。

## 兼容

- **旧服务端 × 新客户端**：字段缺失 ⇒ 无提示、无置灰、不拦截（正常出牌；服务端仍权威）。
- **新服务端 × 旧客户端**：旧客户端忽略未知字段，无影响。
- **网关 validator**：语义不变式（非 null ⇒ `=== lackSuits[seat]` 且 `hand` 含该花色）；将来实现改坏 `mustClearLack`/花色时，网关会**整帧丢弃**不一致视图（客户端表现 = 该帧游戏更新不达）——这是兜底而非正常路径。
- 本片**不清洗**同族 13001（非缺门出牌被服务端拒绝）的旧文案；另立片（D13）。

## 回滚

- 代码：`git revert 0e797106 b7f7c190 ebe0aee9 fb23de60`（按倒序逐个 revert）；spec/计划文档按需另行 revert。
- 部署：**v18 未部署**；部署回滚点仍 `dev-e10ed4b`。

## 下一步（需用户裁决）

1. **推送 `dev`**（origin/dev 不含 v18；dev 推送零 CI）。
2. **部署测试服**（`deploy-dev.sh`；**必须重建 game-service 镜像**，服务端有变更）。
3. **部署后跑 slice-36**（命令见上）。
4. **重打 APK**（客户端引导有变更；H5 随部署生效，APK 必须重打）；是否 bump 0.1.13/113 由用户裁决。
5. **真机走查**：提示 5 字不截断、`.45` 置灰可读、金边、被拦提示、摸牌位金点压暗、最后一张缺门打完后提示消失、回合中重连。

## 已知取舍

- 只做**缺门出牌引导**（不做更泛的「可出牌高亮」）；同族 13001 文案另立片（D13）。
- 客户端提示依赖服务端字段（客户端零规则逻辑）；`validator` 语义不变式 + conformance 独立 oracle 兜底。
- 被拦提示**无计时器**，靠状态清零（手牌内容变化 / 可选性翻转 / 相位变化 / 字段变化）。
- 摸牌位金点压暗用包裹层类 `.mj__hand-drawn--blocked`（v16 摸牌位结构原样保留）。

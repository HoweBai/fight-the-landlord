# 交接：九项并入后的收尾（2026-10-13）

> **新会话入口文档。** 工作目录 `d:\Code\pokergame`。上一会话因上下文预算在此暂停；本文件是唯一断点说明。

## 0. 一句话现状

「返回大厅弃局出口+匹配守卫」本片全链已完成并合入本地 master；用户并行提交的「九项纯客户端优化」（`71229e5`）已与主线**并发合并完成**（`73ac021`，手工解一处注释块归属冲突，双方全保留）；专项语义审查（opus）已出报告并取得两条用户裁决；**修复 A 的实现已在工作树完成但未提交**（916/918 测试绿 + vue-tsc 0）；推送/重打 tag/上线未做。

## 1. 硬事实（先跑这几条核对）

- `git log --oneline -1` ⇒ `73ac021 merge: 九项纯客户端优化（71229e5）并入本片主线…`
- `git status --short` ⇒ **7 改 + 2 未跟踪**（= 修复 A 半成品，见 §3 步骤 1）；**无其余脏文件**（用户 PNG 已按裁决全部丢弃、stash 已 drop）
- `git rev-parse origin/master` ⇒ `e87bd47`（**本地领先，未推**）
- tag：`v1.13.0` 已推 origin，但指向 `41c0de1`（**合并前**）⇒ 步骤 4 需重打
- Actions 额度**仍未恢复**（run 秒败）⇒ 上线走手动等价流程（先例 v1.8–v1.12）

## 2. 本段历史与用户裁决（已定，不要重开）

- 本片（返回大厅弃局出口+匹配守卫）：设计 v1.3/规格 v1.1.2/计划 v1.2 全冻结（`docs/superpowers/specs/2026-10-12-leave-and-match-guard-{design,spec}.md`、plans 同名）；5 任务门 + opus 终审（With fixes）+ 终审批修全部落地；conformance slice-05=68、全序 25/29+4 全分类、探针 full 41/41 + N32 受控 13/13（**该过程顺带修好了探针自 10-11 起的两段式注册缺陷**）。
- 九项 × 主线专项审查报告（**未落盘成文件，要点见 §附录 C**）结论：7 项互补无冲突；2 项重要（B2 give-up 与上片「>30s 仍自动回」承诺冲突；D2 打坏 `verify-asset-paths.mjs` 等工具）；若干登记级。
- **用户裁决 ①**：断线重连以「**超过 30 秒仍自动回**」为准 ⇒ 保留有限重试 UX，但自动窗口修到不撞承诺 + 非牌桌页补恢复入口 + 断网期间请求不悬挂（= 修复 A 规格）。
- **用户裁决 ②**：三张未提交 PNG **全部丢弃**（以九项入库版为准）——已执行（stash drop）；**不要再找回**。

## 3. 未完成清单（按序执行）

### 步骤 1：修复 A 收尾（工作树已有实现，未提交）

- 工作树 diff 面（7 改 + 2 新）：`net/transport.ts`、`net/socket.ts`、`components/ConnectionOverlay.vue`、`pages/game/game.vue`、`pages/lobby/lobby.vue`、`test/connection-overlay.test.ts`、`test/serial-queue.test.ts`；新增 `components/ConnectionDeadBar.vue`、`test/connection-dead.test.ts`。
- 已验：`pnpm --filter @fight-the-landlord/client test` = **916 passed / 2 skipped**；`pnpm --filter @fight-the-landlord/client lint`（vue-tsc）exit 0。
- **你要做的**：① 复核 diff 是否满足 §附录 A 规格（逐条核）；② 轻量任务审（可派 sonnet 审查者）或按纪律补正式任务门；③ `git add` 逐文件（**无 PNG 问题了，但仍不用 `-A`**）+ 按 convention 提交（message 结尾逐字 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`）；④ 报告写 `.superpowers/sdd/fixA-report.md`（若半成品已有报告则补全）。

### 步骤 2：修复 B（D2 工具同步 + 登记批）

- **B1（必改）** `scripts/verify-asset-paths.mjs`：判据 0 与清单腿的 `dist/static/cards/manifest.json` → 新路径 `dist/pages/table/static/cards/manifest.json`；判据 3 前缀 `/static/cards/` → `/pages/table/static/cards/`（同时断言旧前缀不再出现）；文件头描述更新。修后**实跑一次**（对本地构建产物或既有基准目录）。
- **B2** `scripts/gen-card-manifest.mjs`：输出路径改 `src/pages/table/static/cards/`（防重跑造幽灵目录 `src/static/cards/`）；`ASSETS.md` 相应指示更新。
- **B3 登记批**：`apps/client/.env.development` 的 `VITE_ERROR_REPORT_URL` 示例注释改成「自建 collector 完整 URL」（现例 `/api/client-errors` 服务端不存在）；C3「规则迁入 protocol」职责变化补登记（design.md §12 或 client-protocol.md 一行）；ASSETS.md 补 mp 跨包引用边界一行（`game.vue` 主包页 `backdrop="table"` 引分包资源）；`table.vue` 的「提示」按钮在非自己回合/无候选时**点了没反应**——加禁用条件或提示（本仓忌讳死按钮）；`hintOptions` 死状态清理；`uni.scss` 注释「21 个文件」陈旧句顺手订正。
- 提交拆分自定（工具修一个 commit、登记批一个 commit 为宜）。

### 步骤 3：合并态全量验证

- `pnpm --filter @fight-the-landlord/protocol build`（**dist 新鲜是 lint 前提**——上次就是它造成 hint.ts 假红）
- `bash scripts/ci.sh`（六阶段）；`node tools/conformance/dist/run.js`（全序；先 `pnpm -C tools/conformance build`）。红项按台账口径分类（同 run 跨阶段绿/红=环境假红；真红单跑复现）。**预期已知红**：slice-18/24 广告 T0-2 相位红（baselines 预登记）、slice-19 本机脏卷、slice-07.5 本机跳过差。
- 门禁：`pnpm -r --no-bail test`、`pnpm lint`。

### 步骤 4：推送 + 重打 tag

- `git push origin master`（先 `git fetch` 防再分叉）。
- **重打 tag**（v1.13.0 未被任何流水线消费，安全）：`git push origin :refs/tags/v1.13.0 && git tag -d v1.13.0 && git tag -a v1.13.0 -m "…" <最终tip> && git push origin v1.13.0`。message 按 v1.13.0 原稿（本片 + 随带的九项）改写。

### 步骤 5：上线（手动等价流程；用户已裁决上线）

- 前置：Docker Desktop 在跑；GHCR 凭据走本机 credsStore（已验证 write:packages）；`.env.deploy.local` 在位（含 SSH_*/SITE_URL/GHCR_*）。
- `IMAGE_PREFIX=ghcr.io/howebai/fight-the-landlord bash scripts/deploy/build-images.sh "sha-<最终tip短>" v1.13.0`（14 镜像；PNG 问题已消失，无需 stash）
- `bash scripts/deploy/deploy.sh v1.13.0`（服务器拉取+起栈+冒烟）→ `bash scripts/deploy/deploy.sh --assert-clean`
- 上线验证：容器全 `:v1.13.0`；**镜像溯源四环同 digest**（本地=GHCR=服务器镜像=运行容器，room-service 与 edge 各一）；客户端 bundle 一致性（本地 edge 镜像内 `index-*.js` == 线上 `/`）；`curl --noproxy '*' --resolve <DEV_HOST>:443:<DEV_HOST_IP> https://<DEV_HOST>/api/health` = 200；**行为面**：新客户端在局中「返回大厅」弹确认、确认后落大厅（可观察；或用探针）。
- 上线后更新：`.superpowers/sdd/progress.md` 收尾节、记忆文件。

## 4. 遗留登记（不阻塞上线，交付时如实带出）

- A1/A3 用户端到端验收（真人一局）；CI 权威轮（额度恢复后，核 slice-05=68、slice-12=90、slice-07.5=196 三数）。
- 九项审查的登记级项（附录 C）：B1 失败被 T6 守卫静默按设计；音频/close_btn 绕过版本 query；`socket.ts` 一处注释勘误（修复 A 已含？核对）；`table.vue` 死状态。
- 本片遗留候选：发送层安全时钟（room.leave 纳入，需连带测试）；raceTimeout 专属单测；单闸裸 hget 的 WRONGTYPE 对称化（与 handleJoin 一并）。

## 附录 A：修复 A 规格（核验工作树用）

1. `transport.ts`：`reconnectionDelayMax` 10s→20s（delay 1s 不变）。
2. `socket.ts`：`RECONNECT_GIVE_UP_ATTEMPTS` 8→22；注释如实写窗口 ≈3–6 分钟（socket.io 退避 1s 倍增、封顶 20s、jitter 0.5）与依据（用户裁决 + 上片设计承诺 `2026-10-12-reconnect-until-game-end-design.md` §1/§7 判据 1）；:906-912 一带 give-up 的 disconnect 注释勘误（socket.io 4.8.4 未连接时不派发 disconnect，实际靠 Manager `_close()`）。
3. dead 态 fail-fast：give-up 且未连接时 `send()` 不得入 socket.io 缓冲——立即返回 blocked + 新错误类（message 如「连接已断开：请点击重新连接」）；`RequestOutcome` blocked.reason 类型放宽；give-up 转换点 `releasePendingAndWakeWaiters()`。
4. `ConnectionDeadBar.vue`：`phase==='dead'` 且 `deadCode!==11003` 给「重新连接」按钮（→ `client.retryConnect()`，方法名以 socket.ts 现状为准）；11003 只文案；挂 `lobby.vue` + `game.vue`（**不挂 table.vue**，牌桌已有 scrim）；样式随两页既有横条风格。
5. 测试：give-up 行为 + 「窗口下界 ≥180s」计算型断言；fail-fast（不入缓冲/有界收敛）；dead-bar 组件（lobby/game 可见性、按钮、11003、connected 隐藏）。

## 附录 B：修复 B 规格

见 §3 步骤 2 的 B1/B2/B3 逐条。

## 附录 C：九项 × 主线审查要点（完整报告未落盘；处理结论如下）

- **互补无冲突（可原样）**：A2 错误上报（此前无全局处理器，无重叠）；C1 音效预热；C2 记牌器；A1×D1（同一 `__FTL_APP_VERSION__`→version.json 单源）；B1 前台补拉（三路快照幂等收敛 + `connected` 守卫）；D2 代码本体（H5 路径逐字不变、删除素材核实无误删）；C3 实现（真重导出非双实现，零依赖红线未破——**类型放宽需服务端面复跑，见步骤 3**）。
- **已裁决处置**：B2 give-up → 修复 A。
- **步骤 2 覆盖**：D2 工具、A2 注释、C3 登记、mp 边界、提示按钮。
- **登记级（可留）**：B1 失败静默（T6 守卫按设计吞）；音频/`close_btn` 绕过版本 query；`table.vue:604-612` hintOptions 死状态；socket.ts 注释勘误（归修复 A）；`uni.scss:309` 注释陈旧。
- 合并质量：socket.ts/game.vue/uni-stub 自动合并为全量并集（两套机制不打架）；table.vue 手工拆注释块归属冲突（双方全保留）——已提交于 `73ac021`。

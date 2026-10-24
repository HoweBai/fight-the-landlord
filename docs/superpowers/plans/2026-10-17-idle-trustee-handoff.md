# 交接：挂机治理（超时加速 + 自动托管 + 手动托管）—— 新会话续跑入口（2026-10-17）

> 上一会话上下文用尽。本文件是**完整状态快照 + 精确续跑步骤**。配套账本：
> `.superpowers/sdd/2026-10-17-idle-trustee/progress.md`（T1–T8 完成记录 + 全部 Minor 台账 + 派单增强纪律）。
> 依据文档：设计 `docs/superpowers/specs/2026-10-17-idle-trustee-design.md` **v1.6** ·
> 规格 `docs/superpowers/specs/2026-10-17-idle-trustee-spec.md` **定稿**（C1–C39）·
> 计划 `docs/superpowers/plans/2026-10-17-idle-trustee.md` **v1.3 定稿**。

## 一句话现状

T1–T9 **全部完成并终审 Approved**；**2026-10-18 已合并 origin/dev 的 66 提交**（记牌器/手牌 FLIP/结算延迟/昵称/机器人思考等），
合并态全序重跑后 **32 片全绿**（4 片红均修复/重跑：slice-05/07 昵称契约判据、slice-13 douzero 旧容器、slice-23 单跑未复现）。
**APK 已出**：`0.1.0-2eed0fd`（https 端点/包名/托管均验），已放入 `deploy/download/优比棋牌.apk`。
**2026-10-18 已部署测试服**：tag `dev-955e37f`（19 容器健康、钉 IP 复核全中、新 APK 已上线、回滚面 `dev-a757191`）。
剩余 = 三人真人对局人工验收。

## ✅ 2026-10-18 部署完成（dev@955e37f → 测试服）

- **tag `dev-955e37f`** 已推 origin/GHCR；测试服 **19 容器**全部健康且镜像 = `dev-955e37f`（唯一非本仓镜像 = mysql/redis/cadvisor/node-exporter）。
- **钉 IP 复核**：`/api/health` = 200 · `/admin/app.js` 与 tag **逐字节一致**（sha256 `1e1a2a95…`）·
  `/download/优比棋牌.apk` = 200 / 18,091,383 B，sha256 `477ac33e…` **与本地新 APK 一致**（新包已上线）。
- **服务器容器实读**：gateway `protocol/dist/messages.js` 含 `game.trustee`（1）· room-service dist 3 文件 · game-service dist 4 文件 ·
  edge H5 含「托管」· `platform_config` = **50 键**。
- **回滚面**：`bash scripts/deploy/rollback.sh dev-a757191`（上一版；GHCR 在案）。同 `dev-8f59573` 亦在 GHCR。
- **过程记录**：GHCR 并行推 14 镜像经代理反复超时 ⇒ 改**逐镜像单推**（13/14 一次过，room-service 重试 1 次）后
  `deploy.sh dev-955e37f` 一次绿（冒烟第 2 次尝试通过）。APK = `0.1.0-2eed0fd`（客户端源码自此未变；其后提交仅 conformance/文档）。
- **剩余人工**：三人真人对局验收（1 人自然 30s、1 人连续超时 10s、托管 1.5s 自动打、按钮开关、回桌拿回）。

## 分支与纪律

- **本片直接在 `dev` 上开发**（用户工作流）；⛔ 不碰 master；⛔ 不用 `v*` tag；部署走 `scripts/deploy/deploy-dev.sh`（用户发话后）。
- 提交尾注：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 纪律（本片强化）：每跑独立日志文件名；`NO_COLOR=1`；**报告摘句必须能在日志 grep 到**（前两任务曾出现引用不存在输出的教训，T9 起已根治）。

## 已完成（T1–T8，全部评审 Approved）

| 任务 | Commit | 内容 |
|---|---|---|
| T1 | `da97a2c` | shared 治理纯函数（`turnDurationFor`/`onTimeoutOccurred`/`onTurnConsumed`/`onTrusteeOff`/`isLegalTrusteeCombo`）+ `GamePlayer` 两字段（含 createSession 初始化） |
| T2 | `81ced18` | `PlayerView.trustees[3]` + `game.trustee` 消息/校验 + client-protocol 同批 |
| T3 | `4b9fef1` + fix `fbbdfe6` | 治理核心（下一行动者档/计数/复位 updated/R106 normal/迁移）+ view 生产 trustees；修复= C2b① 负对照补判别力（401/1099 边界 + 突变自证） |
| T4 | `3baa69b` | `game.trustee` 边（pattern+handler+`:56` 同提交 J21）+ R8 三分支 + R6 例外 |
| T5 | `a8f785d` | R10 同房写串行（四写者 awaited 队列）+ 机器人互锁重驱/rebase + timer 回合身份复核（回调不入队）；6 组变异自证 |
| T6 | `c98490d` | room 通道（四处 via 映射/弃局五步序/回桌先清后 ack/接线两腿闸）；5 组变异 |
| T7 | `3618e80` | 客户端（托管按钮 toggle/座位「托管中」徽标/发送面扩型/夹具） |
| T8 | `9021fe1` | slice-27（3 真人驱动 + 注入 1500/1000/400/3 + finally 还原）；**两跑 112/112**；baselines **仅 full=112** |

**T8 关键教训（部署已天然覆盖）**：任何新增 C→S 消息 ⇒ **api-gateway 必须同批重建**（旧镜像只订阅旧
`CLIENT_MESSAGE_TYPES`，会**静默丢弃** `game.trustee`——attempt1 实证：ack 超时 -1）。`deploy-dev.sh`/release
全量重建 14 镜像，天然满足。

## T9 进度（部分完成，需续跑）

已提交：
- `7bbbfaf` docs：`docs/design.md` 8 面 + `docs/games/doudizhu.md` 7 处 + 新增「§9.3 挂机治理」小节（C30/C31 全落，逐点表见任务报告 §1）。
- `edc7073` 门禁小修：robot-service 三处夹具补 `trustees`（**七包门禁抓到的真错**——T2 起 PlayerView 必填字段，robot-service lint 此前无人跑到）+ shared 两处期限注释订正。

已完成的门禁读数（本会话实跑，日志在账本目录）：
- **七包 lint 全 exit 0**；七包测试：shared 281 · protocol 204 · game-service 194 · room-service 709 · client 1077+2skip · robot-service 118 · mock-server 10。
- **静态闸 221 passed**（⚠️ 任务书写「应仍 213」是 device-binding 合并前旧值；dev 现基线 221，**非回归、未下调**）。
- **slice-27 两跑 112/112**（31.7s / 42.1s）· **slice-05 68/68** · **slice-11 64/64**（其证据句证明 T8 的 env 还原生效：机器人 767ms 被推进、非超时兜底）。
- `--fresh`（C11 起跑）：attempt1 红于长驻本机栈 `friendRoomEnabled=true`（历史遗留）→ 管理面 PUT 归 false 后 attempt2 绿（版本 851）。

**剩余（T9 未完成部分）**：
1. **既有全序一次**（C39「既有全序不回归」的执行载体）。日志名 `t9-full-attempt1.log` 已存在但报告状态仍是
   「草稿——待 conformance 全序结果」——**先看该日志尾部**判断全序是跑完/跑挂/没跑完。
   ⚠️ 全序预计 ≈15 分钟；**相位红预登记**：slice-18 / slice-24 G 组 = **T0-2 相位红**（不得据此下调 baselines）；
   slice-19 本机脏卷风险历史登记（`admin_accounts` 行数超列表上限 ⇒ 新超管不可见，属环境）；其余红按形态判别
   （假红先单跑，一次未复现如实记「未复现」）。
2. 报告收尾：`task-9-report.md` 状态行改终态、§4 疑虑补齐（全序读数 + 分类）。
3. 提交（docs/收口批或单批），末尾加 Co-Authored-By。

## 2026-10-18 暂停点（恢复从这里继续）

- **合并**：`2eed0fd`（origin/dev 66 提交并入；8 冲突全解；七包 lint 0 / 测试 293/208/203/721/1129+2skip/119/10 / 静态闸 222）。
  `7de8aa4`：合并后全序抓出的昵称契约判据修复（slice-05/07 放行裁剪后的 `nickname`/`players`）。
- **合并态全序**（`merge-full-attempt1.log`）：首跑 28 绿；4 红重跑后全绿 —— slice-05/07（判据修复）、slice-13（douzero `--force-recreate`）、
  slice-23（单跑未复现，按纪律记「未复现」）。`check-baselines` 仅两条环境面：`slice-07.5 184<196`（Windows 跳过 14 条，已知）与
  `slice-13 31<35`（douzero 容器连 HuggingFace 失败 ⇒ 跳过 1 项；构建期关代理所致，代理已恢复仍 `SSL: UNEXPECTED_EOF` ⇒ 环境面，
  网络好时或 CI 权威轮复核）。
- **APK**：`0.1.0-2eed0fd`（https 端点 1 命中 / 包名 `com.yobeeo.pokergame` utf-16-le 1 命中 / 「托管」在包），
  已放 `deploy/download/优比棋牌.apk`（sha256 `477ac33e238be8dc…`，18,091,383 B）；`deploy-apk-swap.log` 有证。
- **恢复步骤**：①（可选）复核 slice-13 条数或按环境登记 → ②`git push origin dev`（推 dev 零 CI）→
  ③`bash scripts/deploy/deploy-dev.sh`（tag `dev-7de8aa4`；14 镜像 → 部署 → 钉 IP 复核；edge 镜像将含新 APK）→
  ④部署后：容器实读 + `platform_config` 50 键面 + `/download/优比棋牌.apk` 探针 + 三人真人对局人肉验。
- **环境**：构建期曾关系统代理（ProxyEnable=0）——**现已恢复为 1**；整栈（20 容器）在跑。

## 续跑步骤（2026-10-18 状态：1–4 已完成；恢复点 = 部署）

1. **✅ 已完成** —— T9 后台已收口（全序 + 报告终态）。
2. **✅ 已完成** —— 全序 attempt2（`t9-full-attempt2.log`）走 CI 同款 `conformance-stack.sh up` → `--fresh` → 32 片循环 → `check-baselines full`。
3. **✅ 已完成** —— T9 评审（sonnet）：3 Important / 8 Minor，已修复（`9112221` / `c41f6c5`）并复跑。
4. **opus 全支终审（待做）**：`review-package 8dffa52 HEAD`（8dffa52 = 计划定稿提交，实现起点）→ 派 opus 终审
   （给 Minor 台账全文——在 `progress.md`——要求逐条 triage「合并前必修/可留」）。
5. **部署（用户发话后）**：`bash scripts/deploy/deploy-dev.sh`（tag `dev-<sha>` → 14 镜像 → 部署 → 钉 IP 复核）。
   部署后追加：`docker exec ftl-api-gateway grep client-gate dist` 式容器实读（quirk 9）+ 测试服 `platform_config`
   无 44/49 键外残行 + **两跑一次人肉验**（三人真人对局：一个 30s、10s、托管自动打、按钮开关、回桌拿回）。
6. **推 dev 时机**：按仓规「日常攒批不推」——本片批次（33 提交）何时推由用户定（推 dev 零 CI）。
7. 收尾时更新本文件与 `progress.md`、写/更新记忆（本会话已预写 `idle-trustee-handoff-2026-10-17` 记忆 + MEMORY.md 行）。

## 环境坑（本片新增/复验）

- **stale dist**：改 shared/protocol 后，跨包单测/真栈前先 `pnpm --filter @fight-the-landlord/shared build` 与
  `...protocol build`（dist gitignored；不重建会假绿/假红）。
- **gateway 同批重建**（见上，T8 教训）。
- **pnpm 误导文案**：vitest 非零退出时尾部 `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL … vitest not found` 是误导——
  判红/绿认 vitest 的 `Test Files/Tests` 行。
- **已知假红族**：`internal-token.test.ts` 等 `listen(0)`+fetch 封禁端口族（单跑绿 + 全绿复跑即按未复现记）；
  slice-27 ⓪ 注态重建在冷缓存下可能超片内 300s（先片外预重建预热即绿——部署/CI 不受此限）。
- **静态闸现值 221**（不是 213）。

## 关键文件索引

- 账本（Minor 台账 + 派单纪律）：`.superpowers/sdd/2026-10-17-idle-trustee/progress.md`
- T9 报告（草稿）：`.superpowers/sdd/2026-10-17-idle-trustee/task-9-report.md`
- 任务书：`.superpowers/sdd/2026-10-17-idle-trustee/task-N-brief.md`（1–9）
- 各任务报告：`task-N-report.md`；全序/切片日志：`t9-*.log`
- 设计 v1.6 / 规格定稿 / 计划 v1.3：见文件头

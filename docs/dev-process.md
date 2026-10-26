# 开发流程（新功能 / 较大修复）

> **权威入口**：本仓库所有新功能与较大修复都按本文执行。
> 新会话、新工作目录、新分支开工前先读本文；详细产物落在 `docs/superpowers/specs/` 与
> `docs/superpowers/plans/`。
>
> 本文固化的是 **2026-10-15 之后演进的版本**（dev 分支政策 + spec/plan + 对抗审查 + TDD +
> 代码审查）。更早的三角色并行/垂直切片流程见文末「历史版本」。

## 0. 分支、提交与推送政策

- **日常开发在 `dev` 分支**（或 `feature/*` 合回 `dev`）。`dev` 推送**零 CI**。
- **合入 `master` = 吃权威轮**：CI + conformance + 镜像构建（约 49 分钟额度）。
- **打 `v*` tag = 出包/部署**（约 41 分钟）。日常攒批不推 `master`；纯文档批可用 `[skip ci]`。
- **每次改动都提交**；提交信息末尾：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- PR 描述末尾：`🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- 小步提交：一个任务一个 commit，便于回滚。

## 1. 需求与范围

- 明确目标、用户裁决、**不做清单**（YAGNI）。
- 多子系统需求先拆片；一次只做一个可独立交付的片。
- 确认边界：纯客户端 / 是否动协议 / 是否动服务端 / 是否动配置中心 / 是否动数据库 / 是否动 admin。
- 有产品取舍时先问用户；技术实现细节由开发方决定。

## 2. 设计（spec）

- 先读现有代码、协议、配置链路、测试锚点，再给 2–3 个方案对比 + 推荐。
- 写决策表 `D1…Dn`，落盘：
  `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- spec 至少包含：背景/问题、范围（做/不做）、决策表、实现设计、测试判据、错误处理与边界、
  风险、涉及文件。

## 3. 设计对抗审查（必须）

- 由**独立 reviewer**（子代理）从反方向攻击设计，不把审查工作推给用户。
- 重点检查：时序/竞态、生命周期、边界与 fail-safe、死按钮、z-index/层叠、协议或文档契约冲突、
  测试假绿、与仓库既有纪律冲突、是否破坏 M07/反作弊/哑终端等红线。
- 分级：阻断 / 高 / 低；阻断项必须修，高优先级项必须处置或登记。
- 审查结论写进 spec 的「审查记录」；修订 spec 后再进入计划。
- 用户只在产品裁决/方向选择上拍板；技术审查由开发方对抗完成。

## 4. 实现计划（plan）

- 落盘：`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`
- 内容：
  - 任务拆解（每个任务独立可测、可独立提交）；
  - 每个任务的 Files / Interfaces / 精确代码或步骤；
  - **TDD 步骤**：写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交；
  - 回归命令与预期结果；
  - Global Constraints（协议边界、纯客户端、计时器落点、attribution、验证命令等）。

## 5. 计划对抗审查（必须）

- 独立 reviewer 审查计划的可执行性与判别力，重点：
  - 缺失 import / 未定义标识符 / `noUnusedLocals`；
  - 假时钟顺序、flush 时机、session/pinia 初始化顺序；
  - 测试假绿（断言恒真、选择器过宽、只验证 mock）；
  - 与既有测试/夹具冲突；
  - 源码闸自匹配或可被绕过；
  - 回归面遗漏。
- 修订计划后再开工；审查结论写进计划的「计划审查记录」。

## 6. 实现（TDD + 小步提交）

每个任务：

1. 写失败测试；
2. 运行确认红；
3. 写最小实现；
4. 运行确认绿；
5. 提交（带 attribution）。

- 不夹带无关重构；只改本任务需要的文件。
- 跨包改动同步机械闸：
  - 配置键计数（protocol / config-service / admin / `verify:admin`）；
  - `source-boundary`、`animations`（牌桌区不新造时钟）、单根闸等源码闸；
  - 精确键清单、conformance 断言。
- 每完成一个任务更新计划勾选/状态。

## 7. 代码审查（必须）

- 独立 reviewer 审 `BASE..HEAD` diff，对照 spec/plan 逐条核对。
- 分级：Critical / Important / Minor。
- **Critical 与 Important 必须修**；Minor 可登记或顺手修。
- 修完补测试，再跑受影响测试与全量验证。
- 审查发现的问题与处置写进 spec/plan 或提交信息。

## 8. 全量验证

按改动面选择：

| 改动面 | 验证 |
|---|---|
| 客户端 | `pnpm -C apps/client test`、`pnpm -C apps/client run lint`（vue-tsc） |
| protocol | `pnpm -C packages/protocol test`（必要时先 `build`） |
| config-service | `pnpm -C packages/config-service test` |
| shared / 规则 | `pnpm -C packages/shared test` |
| 管理后台 | `pnpm verify:admin` |
| 全仓 | `pnpm test` / `pnpm lint`；权威轮用 `pnpm exec turbo run test lint --force`（`Cached` 不算真跑） |
| 真浏览器 | `node scripts/browser-e2e.mjs`（需要时） |
| 协议/规则/联调 | `tools/conformance` 对应 slice（合 master 时权威跑；需重建镜像） |

- 最后确认工作区干净、无未提交改动。
- 不得用「测试通过」代替真实行为验证：能跑真栈/真浏览器的，优先真栈。

## 9. 合并、推送、部署

- 推 `dev`（零 CI）；需要发版时合 `master`（权威轮），打 `v*` tag 出包。
- 测试服部署：`bash scripts/deploy/deploy-dev.sh`
  （tag → **GitHub Actions 构建** → deploy → 钉 IP 复核；本机不需要 Docker，需 `gh` 已登录）。
- 合并远端新提交后必须**重新跑验证**再推送。
- 合并完成后清理已合入的本地/远端分支（远端删除需用户明确授权）。
- 更新交接文档/台账；`.superpowers/sdd/` 仅供本机过程记录（gitignored，不入库）。

## 10. 交付报告

向用户报告：

- 变更内容与最终行为；
- 验证证据（测试数量/结果、类型检查、真栈/e2e）；
- 提交范围（SHA）；
- 是否已推送/部署；
- 已知边界与另立片事项（例如需要改协议的反作弊能力）。

## 11. 产物与持久化

| 产物 | 位置 | 是否入库 | 用途 |
|---|---|---|---|
| 设计 spec | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` | ✅ | 决策与审查记录 |
| 实现计划 | `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` | ✅ | 任务/步骤/验证 |
| 交接文档 | `docs/superpowers/plans/*-handoff.md` | ✅ | 跨会话状态 |
| 偏差台账 | `docs/superpowers/plans/deviation-ledger.md` | ✅ | 切片级偏差对账 |
| 过程明细 | `.superpowers/sdd/**` | ❌ gitignored | 本机进度，不跨 clone/分支 |

**跨会话/跨工作目录**：本文与 spec/plan 都在仓库内，提交并推送后随分支走。
**换分支**：新分支从 `dev` 开出即继承；`master` 要等 dev→master 合并后才可见。
**新会话**：`CLAUDE.md` / `AGENTS.md` 已指向本文，新会话会先读到入口。

## 12. 快速清单

```text
[ ] 需求/范围/不做清单确认
[ ] 设计 spec 落盘 + 对抗审查 + 修订
[ ] 实现计划落盘 + 对抗审查 + 修订
[ ] 按任务 TDD：红 → 绿 → 提交
[ ] 代码审查：Critical/Important 修复
[ ] 定向测试 + 全量测试 + 类型检查
[ ] 工作区干净
[ ] 推 dev / 合 master / tag / 部署（按需）
[ ] 交付报告 + 清理分支 + 更新交接
```

## 13. 历史版本（2026-09-13 起）

早期采用「协调者 + 后端 agent + 前端 agent」三角色、三工作区/分支、垂直切片流程：

- 契约包 `packages/protocol` 由协调者冻结；前端只依赖 protocol、不依赖 shared；
- 每个切片必须「后端 DoD + 前端 DoD + conformance」三者同时通过，未过不得开下一片；
- 协调者每切片评审关键 diff，重复错误则重新派生 agent 并写进 `agent-briefs.md`；
- 详见 `docs/superpowers/plans/2026-09-13-parallel-dev.md` 与 `agent-briefs.md`。

该版本的**契约先行、垂直切片、端到端门禁、偏差台账**仍然有效；分支政策后来被
2026-10-15 的 `dev` 工作流取代，审查方式演进为本文的 spec/plan/代码三段对抗审查。

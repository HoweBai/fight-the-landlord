# 工程债清理（Dockerfile 可复现构建 + patches 残留）· 设计

> **日期**：2026-10-28
> **分支**：`chore/eng-debt`（自 `dev@13ac394f`；`dev` 与 `master@d064da15` 树差异为 0）
> **范围**：两条已登记工程债（A：Dockerfile `--frozen-lockfile`；B：`patches/` 与 10 个
> `COPY patches ./patches` 清理）+ 已批准的 P0 前置 + 死物清理。
> **不做**：Node 20 EOL 升级、基础镜像 digest 钉死、`qs` override 升级、镜像瘦身/多阶段、
> `verify-*` 三件套脚本的归档、业务/协议/配置语义改动。

## 1. 背景与问题

### 1.1 Debt A：Dockerfile 依赖安装不可复现

10 个 node 镜像 Dockerfile（alert-relay / api-gateway / config-service / currency-service /
edge / game-service / payment-service / robot-service / room-service / user-service）均为：

```dockerfile
RUN npm install -g pnpm@9.15.0 && pnpm install --no-frozen-lockfile --ignore-scripts
```

旧注释的理由是「Dockerfile 只 COPY 部分 workspace，而 lockfile 引用全 workspace」。
2026-10-28 用「复刻 Dockerfile COPY 清单」的临时目录实验（Windows + pnpm 9.15.0，
`--offline` 暖 store）得到：

| 用例 | 上下文 | 结果 |
|---|---|---|
| V0 | 现行 COPY 子集 + `--no-frozen-lockfile` | exit 0，lockfile **被改写** |
| V1 | 现行 COPY 子集 + `--frozen-lockfile` | **exit 0，lockfile 逐字节不变** |
| V2 | V1 + `--filter room-service...` | exit 0 |
| V3 | 裁剪 `pnpm-workspace.yaml` 到 4 包 + frozen | exit 0 |
| V4 | 全 15 个 workspace manifest + filter + frozen | exit 0 |
| V5 | 全 15 个 manifest + frozen 不过滤 | exit 0 |
| V6 | frozen + 人为 lockfile 漂移 | **exit 1 `ERR_PNPM_OUTDATED_LOCKFILE`** |
| V7 | no-frozen + 同一漂移 | **exit 0 且 lockfile 被改写** |
| V8/V9 | V0/V1 干净复跑 | 确定性复现 `.pnpm` 差异：`follow-redirects@1.16.1` vs `follow-redirects@1.16.1_debug@4.4.3` |

⇒ 旧注释已不成立；**V1 是最小、且唯一保持 lockfile 逐字节不变的方案**。V2–V5 可行但
增加维护面或安装全量依赖，不采用。

### 1.2 Debt B：`patches/` 与 `COPY patches` 残留

- 根 `package.json` 自 2026-10-27 起无 `pnpm.patchedDependencies`；
- `pnpm-lock.yaml` 零 `patches/` 引用；
- `patches/` 唯一文件 = `vitest@2.1.9.patch`（vitest 4 已不需要）；
- 10 个 Dockerfile 仍 `COPY patches ./patches`，且注释明写「暂留待清理片」；
- 现有闸 `packages/shared/test/dockerfile-patches-copy.gate.test.ts` 文档判据 ④ 说
  「`patchedDependencies` 为空时不施加 COPY 要求」，实现却**无条件要求** COPY ——
  文档与实现不一致，且正好让死 COPY 一直通过。

### 1.3 P0 前置：master `ci` 红

`gh run list`：`40645213102`（d064da15）、`40645152297`、`40626019509` 全 failure；
失败步骤 `2/6 lint`，逐字报 `packages/room-service/test/ws.gateway.test.ts(2916,28):
error TS2345`。`feature/pdk-trust-c3@0e69dea8` 已修（把 listener 显式收窄为 `never`，
**运行期零变化**），但未合入 `dev/master`。本分支需先 cherry-pick 该提交，才能满足
「交付前全绿」。

## 2. 范围

**做：**

1. Task 0：cherry-pick `0e69dea8` 到 `chore/eng-debt`（独立 commit，保留原作者与说明）。
2. Debt B：删 `patches/`、删 10 个 Dockerfile 的 COPY/注释、改造 patches 闸为双向闸、
   回填 2026-10-27 Dependabot 计划。
3. Debt A：10 个 Dockerfile 改 `--frozen-lockfile`、新增 frozen 机械闸、回填 M7 订正。
4. 死物清理（已批准）：`test-game.ts`、`test-results/.last-run.json` + `.gitignore`、
   `scripts/dev-local.sh`、`scripts/integration-test.sh`。
5. 全量本地验证 + 临时 `dev-<sha>` 镜像构建 + 测试服部署冒烟。

**不做：**

- 不改任何业务代码、协议、配置键；**源码/配置零改动**。唯一可见差异是镜像依赖树与已提交
  lockfile 对齐（见 §1.1 V8/V9 的 peer 布局差异），由 images workflow + 部署冒烟验证；
- 不放宽任何既有断言；
- 不处理 Node 20 EOL、基础镜像 digest、`qs`/`deepmerge` 审计告警、镜像瘦身；
- 不删除 `verify-dod.sh` / `verify-e2e.mjs` / `verify-authz.mjs`（建议另立归档片）；
- 不删除 `measure-table.mjs` / `perf-waterfall.mjs` / `verify-asset-paths.mjs` /
  `ledger-counts.mjs` / probes（有文档引用或仍可复用）。

## 3. 决策表

| # | 决策 | 结论与理由 |
|---|---|---|
| D1 | A 的实现路径 | **采用 V1**：保留现有 COPY 子集，只把 flag 改为 `--frozen-lockfile`。实验证明通过；V2–V5 无额外收益、增加维护面。 |
| D2 | A 的防回归 | 新增 `packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts`：参与 Dockerfile 的**每一条** `pnpm install` 逻辑行必须含 `--frozen-lockfile`、不得含 `--no-frozen-lockfile`；含哨兵与纯函数判别力自证。 |
| D3 | B 的门禁语义 | 改为**双向闸**：`patchedDependencies` 非空 ⇒ 必须 install 前 COPY patches（原断言保留）；为空 ⇒ **禁止**任何 Dockerfile 仍 COPY patches（新增、更严）。不是放宽。 |
| D4 | Task 0 的取舍 | cherry-pick `0e69dea8`（test-only，3 行）；比等 C3 合并更快，且不触碰 C3 工作区。C3 后续合入时该 hunk 相同，冲突可忽略/自动消解。 |
| D5 | 提交粒度 | Task 0 / B / A / 死物清理各自独立 commit，每个 commit 自带测试并通过受影响验证。 |
| D6 | 文档回填 | 更新 2026-10-27 Dependabot 计划（B 关闭）与 2026-09-24 edge 设计 M7（A 关闭 frozen 部分，Node20 仍开）；历史 spec/plan 不改写叙事。 |
| D7 | 验证链 | 本地全量 + 安装上下文实验复跑 + 负对照 + 临时 tag 的 images workflow（14 镜像）+ `deploy.sh` 测试服冒烟。 |

## 4. 实现设计

### 4.1 Task 0：P0 前置

`git cherry-pick 0e69dea8`。该提交只改
`packages/room-service/test/ws.gateway.test.ts`：在调用点把实参断言为 `never`
（`listener as never`；参数类型本已是 `(...a: never[]) => void`），运行期零变化。
落地后 `turbo run lint build --force` 应 30/30。

### 4.2 Debt B：删 `patches/` + 双向闸

**删除：**

- `patches/vitest@2.1.9.patch`（及其目录）；
- 10 个 Dockerfile 中：
  ```dockerfile
  # ⚠️ 2026-10-27 起 pnpm.patchedDependencies 为空（vitest 4 已不需要补丁）；
  # COPY patches 暂留（目录仍有历史补丁文件；删除需同步改全部 Dockerfile，另立清理片）
  COPY patches ./patches
  ```
- `Dockerfile.alert-relay` 头部注释里的 `+ \`patches/\``。

**门禁改造**（`dockerfile-patches-copy.gate.test.ts` + 共享助手
`packages/shared/test/helpers/dockerfile-scan.ts`）：

- 新建共享助手：`logicalLines`（剥整行注释 + 拼接 `\` 续行）、`copySources`
  （剥 `--flag`；`--from=` 返回 null，不把跨 stage 复制误判为构建上下文）、
  `normalizeCopyPath`、`copiesPatches`、`copiesPackageJson`；两个 Dockerfile 闸共用，
  消除解析不对称；
- `copiesPatches` 覆盖 `patches`、`./patches`、`patches/`、`./patches/`、JSON 数组、
  多源 COPY；`checkDockerfile` 的命中判定也改用它（识别面变宽 = 更严，不是放宽）；
- 保留 `checkDockerfile(src)`：有 `COPY package.json` + `pnpm install` 的 Dockerfile，
  必须在 install 前 COPY patches（仅在 `patchedDependencies` 非空时施加）；
- 新增纯函数 `stalePatchesCopy(src)`：同样参与条件下，若仍出现任何形式的 patches COPY
  则违规；仅在 `patchedDependencies` 为空时施加；
- **续行参与**：install/COPY 判定都在 `logicalLines` 拼接后的逻辑行上做，避免
  「`pnpm install` 写在续行 ⇒ 两侧静默跳过」；
- 测试 ② 按 `patched.length` 二选一执行；自证覆盖路径变体、JSON 数组、多源 COPY、
  续行式 install（非空/空两侧各一条）。
- 文档头更新：明确「有 patch ⇒ 必须 COPY；无 patch ⇒ 禁止 COPY」的 iff 语义与 2026-10-28
  清理背景。

### 4.3 Debt A：frozen lockfile + 新闸

**Dockerfile 改动（10 个）：**

```dockerfile
# Install dependencies（skip optional native modules / 保留既有说明）。
# `--frozen-lockfile`：容器只 COPY 所需 workspace 子集，pnpm 按盘上实际存在的包对账；
# 同一 commit 的依赖解析必须与已提交 pnpm-lock.yaml 完全一致（no-frozen 会静默改写
# lockfile，实测会装出不同的 peer 布局）。2026-10-28 实测通过。
RUN npm install -g pnpm@9.15.0 && pnpm install --frozen-lockfile --ignore-scripts
```

user-service 保留 bcrypt 的 `--build-from-source` 段，只改 flag 与注释。

**新闸**（`packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts`）：

- 共享助手 `logicalLines` / `copiesPackageJson`（见 §4.2）；
- 纯函数 `frozenViolations(src)`：
  - **每一个**逻辑 RUN 行中含 `pnpm ... install`（正则 `\bpnpm\b[^\n]*\binstall\b`，
    覆盖 `pnpm --filter <pkg> install` 变体）都要检查（不是只看第一条）；
  - `RUN` 大小写不敏感；`COPY package.json` 由共享 `copiesPackageJson` 识别
    （覆盖 `--chown`、`./package.json`、JSON 数组）；
  - 任一 install 行含 `--no-frozen-lockfile` / `--(config.)?frozen-lockfile=(false|0)`
    ⇒ `forbidden`；任一 install 行不含 `--frozen-lockfile` ⇒ `missing`。
- 测试：
  - 哨兵：Dockerfile 集合非空；**参与集合恰好等于已知 10 个 node 镜像**（加新镜像需显式
    更新闸——有意的强制确认）；
  - 消费端：所有参与 Dockerfile 无违规；
  - 自证：no-frozen 红 / 无 flag 红 / **第二条 install 违规必红** /
    `pnpm --filter ... install` 变体红 / `--config.frozen-lockfile=false` 红 /
    注释里的 flag 不算数 / 多行续行绿 / 不参与者绿。

### 4.4 死物清理（已批准）

- `git rm test-game.ts`（无引用、playwright 非依赖、硬编码 Linux 路径、已被 browser-e2e 取代）；
- `git rm test-results/.last-run.json`；`.gitignore` 增加 `test-results/`（附理由注释）；
- `git rm scripts/dev-local.sh`、`scripts/integration-test.sh`（零引用、被 dev.sh/conformance 取代）。

### 4.5 文档回填

- `docs/superpowers/plans/2026-10-27-dependabot-fixes.md`：§「范围与决策」的 patches 注与
  风险表第 70 行改为「2026-10-28 已清理 + commit」。
- `docs/superpowers/specs/2026-09-24-edge-and-prod-shape-design.md`：M7 订正注
  「`--frozen-lockfile` 已落地；`node:20-slim` EOL 仍未处理」。
- `docs/superpowers/specs/2026-10-02-security-scan-design.md`：vitest 补丁钉版一句加
  「2026-10-27 起已移除；2026-10-28 补丁文件亦删除」的订正注（随 B commit）。
- 另加一行 2026-10-28 订正注到以下仍声称「Dockerfile 必须 COPY patches/」或「补丁文件不动」
  的历史文档：`2026-10-03-monitoring-design.md`、`2026-10-03-monitoring-spec.md`、
  `2026-10-03-currency-spec.md`、`2026-10-02-security-scan-spec.md`——现行语义以
  `dockerfile-patches-copy.gate.test.ts` 为准。

## 5. 测试判据

| 判据 | 命令 | 预期 |
|---|---|---|
| B 闸红 | `pnpm --filter @fight-the-landlord/shared test -- dockerfile-patches`（删 COPY 前） | 10 条 stale COPY 违规 |
| B 闸绿 | 同上（删后） | 0 违规 + 自证全过 |
| A 闸红 | `pnpm --filter @fight-the-landlord/shared test -- dockerfile-frozen`（改 flag 前） | 10 条 missing/forbidden |
| A 闸绿 | 同上（改后） | 0 违规 + 自证全过 |
| workspace 闸不回归 | `pnpm --filter @fight-the-landlord/shared test -- dockerfile-workspace` | 0 违规 |
| 全量 | `pnpm exec turbo run lint build --force` / `turbo run test --force` | 30/30，0 cached |
| 覆盖 | `pnpm --filter @fight-the-landlord/shared test:coverage` | 行覆盖 ≥80%（当前 96.71%） |
| 安装上下文 | 复刻 Dockerfile COPY 清单 + `--frozen-lockfile --ignore-scripts` | exit 0，lockfile 逐字节不变 |
| 负对照 | frozen + 人为漂移 | exit 1 `ERR_PNPM_OUTDATED_LOCKFILE` |
| 镜像 | 推 `dev-<sha>` → images workflow | 14/14 构建成功 |
| 部署 | `deploy.sh dev-<sha>` + 冒烟 | 健康 200 / APK sha / 订阅 / NUMSUB 1/1 / 3 人探针 |

## 6. 错误处理与边界

- `--frozen-lockfile` 期间若 manifest 与 lockfile 漂移 ⇒ 镜像构建**响亮失败**，这是目标；
  开发者须先本地 `pnpm install` 并提交 lockfile。
- `COPY patches` 删除与目录删除必须同一 commit，否则中间态构建 ENOENT。
- 部署来自 `chore/eng-debt` 的 tag：`deploy-dev.sh` 要求 `dev` 分支 ⇒ 走其头部所述
  「手动三步」（`git tag dev-<sha>` → 等 images → `deploy.sh <tag>`）。
- 测试服开启 `risk.predicate.sameIp/sameDevice=true` ⇒ 实时探针等待 ≥75s。
- 回滚目标：当前测试服 `dev-d064da1`。

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Linux 容器内 frozen 行为与 Windows 实验不同（平台可选依赖） | 镜像构建红 | images workflow 是权威判据；失败则回退该 Dockerfile 并上报 |
| 门禁改造被误读为「放宽」 | 审查争议 | 双向闸：空集侧新增禁令，非空侧断言原样保留；自证覆盖两向 |
| cherry-pick 与 C3 后续合并重复 | 冲突 | 同一 hunk，git 可自动消解；若冲突，保留一份即可 |
| 死物清理误删仍被外部使用 | 构建/运维断链 | 删除前 `rg --hidden` 精确路径复核；全量测试 + 静态闸 |
| 临时 tag 构建消耗 CI 额度 | 成本 | 合并 A/B 为一次 images 构建；只推 `dev-*`（不触发 ci/conformance/release） |

## 8. 涉及文件

- `Dockerfile.{alert-relay,api-gateway,config-service,currency-service,edge,game-service,payment-service,robot-service,room-service,user-service}`
- `packages/shared/test/dockerfile-patches-copy.gate.test.ts`（改）
- `packages/shared/test/helpers/dockerfile-scan.ts`（新建；两闸共享）
- `packages/shared/test/dockerfile-frozen-lockfile.gate.test.ts`（新建）
- `packages/room-service/test/ws.gateway.test.ts`（Task 0 cherry-pick）
- `patches/vitest@2.1.9.patch`（删）
- `test-game.ts`、`test-results/.last-run.json`（删）；`.gitignore`（改）
- `scripts/dev-local.sh`、`scripts/integration-test.sh`（删）
- `docs/superpowers/plans/2026-10-27-dependabot-fixes.md`、
  `docs/superpowers/specs/2026-09-24-edge-and-prod-shape-design.md`、
  `docs/superpowers/specs/2026-10-02-security-scan-design.md`（回填）
- 本 spec 与 `docs/superpowers/plans/2026-10-28-engineering-debt-cleanup.md`

## 9. 审查记录

### 2026-10-28 设计对抗审查（独立 reviewer）

结论：**无阻断；1 高 + 7 低**，全部处置。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| H1 | 高 | frozen 闸只检查第一条 `pnpm install` 行；第二条可绕过（假绿） | 改为遍历**所有** install 逻辑行；自证加「第一条 frozen、第二条 no-frozen / 无 flag」样本 |
| L1 | 低 | stale patches 只匹配一种 COPY 拼写，变体可逃 | 新增 `copiesPatches` 路径识别（`./`、尾 `/`、JSON 数组、多源 COPY）；自证加变体 |
| L2 | 低 | 参与判定大小写敏感、数组形式 COPY 会漏；哨兵弱于 spec | `RUN`/`COPY` 大小写不敏感；参与集合**恰好等于已知 10 个**；注明数组形式边界 |
| L3 | 低 | 「不改运行期行为」措辞过强（V8/V9 已证明 peer 布局差异） | 改为「源码/配置零改动；镜像依赖树对齐 lockfile，唯一差异 = peer 布局，由 images + 冒烟验证」 |
| L4 | 低 | 另有 4 份历史文档仍声称必须 COPY patches / 补丁不动 | 各加一行 2026-10-28 订正注（随 B commit） |
| L5 | 低 | 验证链漏了 `scripts/ci.sh` 单一真源 | Task 4 增加 `bash scripts/ci.sh` |
| L6 | 低 | P0 措辞「listener 收窄」不准确 | 改为「调用点实参断言 `listener as never`」 |
| L7 | 低 | 复跑实验只覆盖 room-service 子集 | 增加 edge 子集（apps/client）frozen 校验 |

reviewer 另独立复刻 room-service/edge 子集的 frozen 校验（均 exit 0）与漂移负对照
（exit 1 `ERR_PNPM_OUTDATED_LOCKFILE`），并确认 cherry-pick 可干净应用。

### 2026-10-28 计划对抗审查（独立 reviewer）

结论：**无阻断；2 高 + 10 低**，全部处置。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 高-1 | 高 | frozen 闸只认字面 `pnpm install`，`pnpm --filter x install` 变体可绕过 | install 判定改为 `\bpnpm\b[^\n]*\binstall\b`；自证加变体样本 |
| 高-2 | 高 | patches 闸参与判定只认同一物理行；续行式 install 两侧静默跳过 | 抽共享 `logicalLines`（拼续行），两闸共用；自证加续行样本 |
| 低-1 | 低 | `git apply --check` 成功措辞不固定 | 判据改为退出码 0 |
| 低-2 | 低 | 实验父目录可能不存在 | 先 `mkdir -p D:/Code/ftl-exp`；注明依赖暖 store |
| 低-3 | 低 | worktree 无 `.pnpm-store`，`ci.sh` 可能 EACCES | 失败时用 `--store-dir` 指向主 worktree store；本机实测默认 store 可用 |
| 低-4 | 低 | 死物 `rg` 允许清单漏被删脚本自头注释 | 加入允许集 |
| 低-5 | 低 | `ci.sh` 阶段数说法 | 改为「六阶段 + 7/8 静态段」 |
| 低-6 | 低 | B 提交信息「5 份」与 6 份文档不符 | 改为 6 份 |
| 低-7 | 低 | 计划审查记录未填 | 本节即回填 |
| 低-8 | 低 | `--config.frozen-lockfile=false`、`--chown` 样本缺失 | 补自证样本；共享解析覆盖 `--chown` |
| 低-9 | 低 | 两闸解析器不对称 | 共享 `dockerfile-scan.ts`；`--from` 返回 null |
| 低-10 | 低 | `gh run list --limit 100` 可能截断 | 改 `--limit 200` 并按 headSha 匹配 |

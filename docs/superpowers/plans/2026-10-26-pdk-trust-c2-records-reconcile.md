# C2 实施计划 v2：RecordsReconcileService（资金↔记录对账）

> 日期：2026-10-26 · 依据：`docs/superpowers/specs/2026-10-26-pdk-trust-c2-records-reconcile-design.md`（v4）
> 分支/worktree：`feature/pdk-trust-c` @ `D:/Code/ftl-trust-c`（C1 已同分支；C1 未合 dev）
> 纪律：每任务 TDD（红→绿）→ 提交；只读、不自动改钱；不碰 slice-29/PdkSettlement.vue。

## Global Constraints

- currency-service 只读；零 INSERT/UPDATE/DELETE（单测库零写钉死）。
- 告警 35 → **38 条 / 35 类**；`labels.severity` + `annotations.summary/runbook`。
- 指标 13 个（10 个按玩法 + truncated/runs/last_success）；HELP 写明口径。
- 无 DB 迁移/配置键/协议/客户端；admin 只 GET 加性；POST 不变；旧 admin/旧服务可选链。
- 真栈本机 Docker 不可用 ⇒ slice-35 只做 tsc；报告登记「待权威轮」；slice-35 未过权威轮不得称完成。
- 命令（分开写）：
  - `pnpm -C packages/currency-service test`
  - `pnpm -C packages/currency-service lint`
  - `node scripts/verify-monitoring.mjs`
  - `pnpm verify:admin`
  - `pnpm -C tools/conformance lint`
  - 全量：`pnpm exec turbo run test lint --force --concurrency=1`（或分包证据 + 环境 flake 登记；0 cached）

## Task 1：指标 + 档位 getter + SQL 常量

**Files**：`src/metrics/currency.metrics.ts`、`src/config/config-cache.service.ts`、
`src/reconcile/records-reconcile.sql.ts`（新）、`test/config-cache.test.ts`、
`test/records-reconcile.test.ts`（新，先放 SQL/指标名断言）。

**Step 1（红）**：
- `config-cache.test.ts`：`entryFeePercents('doudizhu')` 新键→旧 `game.baseScoreLevels`；
  `paodekuai` 新键；合法空 ⇒ `[]`；**合法全 0 档位 ⇒ 非空全 0 数组**（不丢档位）；
  缺失/非法 ⇒ `null`；既有 getter 不变。
- `records-reconcile.test.ts`：13 指标名/标签；5 条 SQL 全文（测试侧独立誊写 `toBe`）：
  records+players 按 `p.id AS player_id` 分页（ORDER BY p.id）；SKIPS 带 `s.game_type`；
  PDK 带 `r.game_type`；占位次序 `[from,to,lastId,pageSize]`。
- 跑红。

**Step 2（绿）**：
- 指标：spec §5.4 逐字（10 按玩法 + truncated/runs/last_success）。
- `entryFeePercents(gameType): readonly EntryFeePercent[] | null`：
  ddz 新键→旧 `game.baseScoreLevels`；pdk 新键；`Array.isArray` + 每项合法；非法/缺失 ⇒ null；
  合法空/全 0 均经 `entryFeePercentsFromLevels` 派生（空 ⇒ []，全 0 ⇒ 非空全 0）。
- SQL 常量（ops/flows/ddz/pdk/skips；分页键 o.id/f.id/p.id/s.id）。
- 跑绿 + lint。提交 `feat(currency): records reconcile 指标/档位 getter/SQL 常量`。

## Task 2：Fake DB 扩展 + RecordsReconcileService 核心

**Files**：`test/helpers/fake-currency-db.ts`、`src/reconcile/records-reconcile.service.ts`（新）、
`src/app.module.ts`、`test/records-reconcile.test.ts`。

**Step 1（红）**：先扩 fake DB（测试基础设施），再写服务用例：
- `FakeOpRow.createdAt` / `FakeSkipRow.createdAt`（seed 参数；默认固定时间）；records/pdk/players/
  skips 表 + seed；`transaction(a,b?)` 支持 `('REPEATABLE READ', cb)`（记录 isolation）与
  manager.query；`run` 识别 5 条 SQL：窗口过滤、`id > lastId`、`ORDER BY id`、`LIMIT`（分页），
  records+players 按 `player_id`；`SET SESSION` 记录/忽略；未知 SQL reject。
- 用例：一致局全 0；op 24h59m/25h01m；record 1h59m/2h01m 非零/任一 NULL 无非零/全 0；
  NULL 1h59m/2h01m；flow/玩家/符号/幅度/守恒；台费 op/skip/suspect/unknown/configUnavailable/25h/
  owner 非真人/mode 非 gold；跨界；ddz/pdk 同 key；旧 PDK op ddz；skip 带 game_type；
  分页（3 人局 pageSize=2 跨页聚合；5,001 ops 两页）；maxTotalRows 注入小值 ⇒ TruncatedError；
  事务 isolation/SET/finally 复位（同 manager）；零写；超时（注入小 timeout + fake timers）⇒ abort、
  不写 gauge、inFlight 在事务 settle 后清；轮次/失败后下轮。

**Step 2（绿）**：
- 服务：`RecordsReconcileService`（DataSource + ConfigCacheService；无 Redis）：
  - `onModuleInit` last_success 0 + 首排 10s；自调度/关停/`inFlight`；
    `runOnce({pageSize=5000,maxTotalRows=200000,timeoutMs=60000})`；
  - `dataSource.transaction('REPEATABLE READ', manager => { SET 3; try 分页5条 finally SET DEFAULT })`；
  - 分页 keyset；每查询总行 >maxTotalRows ⇒ TruncatedError + truncated gauge；
  - 判定 spec §5.3；gauge/last_success/日志聚合；轮级 timeout + abort（同 spec §5.1）。
- `app.module.ts` provider。
- 跑绿 + lint。提交 `feat(currency): RecordsReconcileService（RR/分页/判定/指标）`。

## Task 3：管理端（只 GET 加性）

**Files**：`src/admin/admin-finance.controller.ts`、`admin/app.js`、
`test/reconcile-admin.test.ts`、`test/admin-finance.test.ts`、`test/admin-reverse.test.ts`。

**Step 1（红）**：
- GET `data.records` 状态（running/last*/lastResult）；POST 响应**不变**；
- 三处 Nest 测试模块加 `RecordsReconcileService` provider（无生命周期委托壳）；
- 旧 admin/旧服务可选链；`formatReconcileResult` 含 records 字段。

**Step 2（绿）**：
- 控制器注入 `RecordsReconcileService`（值导入）；仅 GET 加性；POST 完全不变；
- `admin/app.js` `formatReconcileResult` 追加 records 可选链；状态区显示 records last*（可选链）；
- 跑三处测试 + `pnpm verify:admin`。
- 提交 `feat(admin): 财务对账面板加性展示记录对账状态`。

## Task 4：告警 + 静态闸 + conformance 计数 + 文档

**Files**：`ftl-alerts.yml`、`scripts/verify-monitoring.mjs`、`Dockerfile.prometheus`、
`slice-16/18/24`、`docs/ops/first-deploy.md`。

**Step 1（红）**：改 verify-monitoring EXPECTED/谓词/头注释（38/35）+ 新规则结构断言
（`/^\s*labels:\s*\n\s+severity:/m`、`/^\s*annotations:\s*\n\s+summary:/m`），跑红。

**Step 2（绿）**：
- 3 条告警（spec §5.5 逐字；labels.severity + annotations.summary/runbook）；
- 头部 38/35；Dockerfile 38；slice-16 EXPECTED +3；slice-18/24 35→38 且 name 数组加三条 C2 名；
- verify 结构断言 + 手工自证（severity 移出 labels ⇒ 红）；
- ops 告警清单 +3；`pnpm -C tools/conformance lint` 绿。
- 提交 `feat(monitoring): records reconcile 三条告警 + 38/35 同步`。

## Task 5：conformance slice-35 + baselines

**Files**：`tools/conformance/src/slices/slice-35-records-reconcile.ts`（新）、`run.ts`、
`baselines.json`、`lib/mysql.ts`（批量造数 helper）。

- 注入 RUN_TAG 唯一行：一致 ddz/pdk、孤儿 op（25h+）、gold 记录无 op（2h+ 非零）、任一 NULL 无非零、
  金额不一致、台费 suspect（先 PUT `entryFeePercent>0` 档位并等快照，finally 还原）、
  台费 unknown（fee=0/档位缺失）、台费孤儿 op（25h+）、跨界、0 行玩法；
  **分页 sentinel**：5,001 ops + 5,001 players（含唯一可识别 sentinel）。
- 触发：`docker restart ftl-currency-service` → 健康 → 轮询 `GET reconcile.records`：
  `running=false` 且 `lastResult` 非 null/新鲜（≤90s）；断言 `data.records` 与 9004 gauges；
  跨界不计、`truncated=0`、`config_unavailable=0`；GET 与 gauges 一致。
- 零写：注入前后本片 room/action 行数不变；收尾 DELETE 注入行。
- baselines 只进 full（静态计数分解）；本机 Docker 不可用 ⇒ 待权威轮。
- 提交 `test(conformance): C2 记录对账真栈切片（slice-35）`。

## Task 6：全量验证 + 代码审查

1. `pnpm -C packages/currency-service test` / `lint`；
2. `node scripts/verify-monitoring.mjs`；`pnpm verify:admin`；`pnpm -C tools/conformance lint`；
3. 全量 turbo（或分包证据 + 环境 flake 登记；0 cached）；
4. 10k/20k 基准读数入报告（pageSize/上限注入；记录耗时；>5s 触发优化登记）；
5. 独立 code review（C2 面）；Critical/Important 修复并复跑；
6. 工作区干净；交付报告（含 slice-35 待权威轮硬闸）。

## 回滚

- 每任务独立提交；无 DB 迁移；revert 即可；只读服务无残留数据。

## 计划审查记录（v1 → v2）

独立 reviewer（2026-10-26）：4 阻断 / 10 高 / 5 低。处置：

| # | 级别 | 发现 | v2 处置 |
|---|---|---|---|
| P1 | 阻断 | 分页键 r.id 切多玩家记录丢行 | Task 1/2：records+players 按 `p.id AS player_id` 分页；3 人 pageSize=2 跨页测试 |
| P2 | 阻断 | 会话复位不同连接/60s 不取消 | Task 2：同一 manager finally 复位；abort + inFlight 待 settle |
| P3 | 阻断 | `admin-reverse.test.ts` DI | Task 3：三处测试模块加 provider（无生命周期壳） |
| P4 | 阻断 | slice-35 台费 suspect 种子费率 0 | Task 5：先 PUT percent>0 档位并等快照；unknown 另注入 |
| P5 | 高 | 全 0 ⇒ [] 矛盾 | Task 1：合法空 []；全 0 非空全 0 数组 |
| P6 | 高 | Date vs number | Task 1/2：DATETIME 绑 Date、PDK BIGINT 绑 number；测试断言 |
| P7 | 高 | fake 缺 createdAt | Task 2：FakeOpRow/FakeSkipRow.createdAt + window 过滤 |
| P8 | 高 | 告警缩进 | Task 4：多行正则 `\s+severity` |
| P9 | 高 | admin 手动 records 竞态/60s | Task 3：取消手动 records；只 GET；POST 不变 |
| P10 | 高 | slice-35 时序/分页 sentinel | Task 5：重启后轮询 + sentinel |
| P11 | 高 | 真栈覆盖 | Task 5/6：硬闸 + fake 补 skip/unknown/旧 PDK/1146/truncated |
| P12 | 高 | 200k 口径 | Task 2：每查询上限，可注入 maxTotalRows |
| P13 | 高 | skip/PDK game_type | Task 1/2：SQL/集合带玩法 |
| P14 | 高 | 全 NULL vs 任一 NULL | Task 2：任一 NULL 无非零 ⇒ nullNoOp；混合用例 |
| 低 | | 命令/文件/基准/告警名/timeout | 已并入 Global/Task 4/5/6 |

## 执行记录（2026-10-26）

- 分支/worktree：`feature/pdk-trust-c` @ `D:/Code/ftl-trust-c`（C1 同分支）。
- 提交（按序）：Task 1 `e2845aa5`（指标/档位/SQL）→ Task 2 `7d784fac`（服务/RR/分页/判定 + fake DB）→
  Task 3 `2579d68c`（admin GET 加性）→ Task 4 `2c174265`（告警 38/35 + 静态闸）→
  Task 5 `1e039b39`（slice-35 + baselines）→ 基准 `b333f835` → 代码审查修复 `20f1518b`。
- 本机验证（最终树）：
  - currency-service：52 文件 / **586 tests** 全绿；lint（tsc 双配置）通过。
  - `node scripts/verify-monitoring.mjs`：**267 checks**；判别力自证「severity 移出 labels ⇒ 1 FAILED」已执行并恢复。
  - `pnpm verify:admin`：**520 checks**。
  - `tools/conformance`：`tsc --noEmit` 通过；`check-baselines.mjs --self-test` 4/4；slice-35 基线 full=89。
  - 全量 lint：`turbo run lint --force --concurrency=4` = **18/18，0 cached**。
  - 全量 test：`turbo run test --force --concurrency=1 --filter=!@fight-the-landlord/config-service
    --filter=!@fight-the-landlord/mock-server` = **25/25，0 cached**；config-service 单独 **489/489**；
    mock-server 单独 **10/10**。首跑各遇 1 例既有环境 flake（config 迁移/RSA 边长、mock 随机端口），
    重跑均全绿（与 C1 登记同类）。
  - 基准（假库按 recordId 建索引后）：10k ops/10k players **52.6ms**；20k/20k **128.6ms**
    （修复前假库 O(记录×玩家)：507ms / 3248ms；>5s 项已消除，无优化登记）。
  - **审查修复后的最终树复跑**：turbo lint 18/18；turbo test 25/25（首跑 robot-service 1 例
    环境 flake，单跑 145/145 绿后全序复跑 25/25）；config-service 489/489；mock-server 10/10。
  - 定向：currency-service 586/586；verify-monitoring 267；verify:admin 520；conformance tsc。
- 真栈：本机 Docker 不可用；slice-35 只做 tsc，**待权威轮**。slice-35 未过权威轮不得称 C2 完成/不得合 dev。

## 代码审查记录（2026-10-26，独立 reviewer 审 `a374409d..HEAD`）

**1 Critical / 3 Important / 11 Minor / 2 PLAUSIBLE**。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| C1 | 阻断 | PDK `ended_at` 是 BIGINT：TypeORM/mysql2 默认 `bigNumberStrings=true` ⇒ 读回数字字符串，`Date.parse('1793…')` = NaN；pdk 记录侧/台费侧判定永久失明，假库与 slice-35 均掩盖 | 已修：`toEpochMs` 先按 epoch 数字串解析再回退 `Date.parse`；fake 忠实返回 BIGINT 字符串；新增 pdk 字符串回归用例；slice-35 增 pdk 记录侧 missing sentinel（Q room）。判别力自证：临时回退 ⇒ pdk 回归 + byGame 两例当场红 |
| I1 | 高 | 10k/20k 基准测的是假库 O(记录×玩家) 关联（20k 并行负载 6.2s），非服务开销 | 已修：fake 按 recordId 建玩家索引；读数 52.6ms/128.6ms（<5s，无优化登记） |
| I2 | 高 | spec §5.1 要求异常类别聚合（样例 room/version）未实现，告警 runbook 无落点 | 已修：`logSamples()` 每桶最多 3 条样例/玩法一行；补日志聚合用例（第 4 条不入样例） |
| I3 | 高 | slice-35 档位还原等待用全局 MAX 版本 + 旧日志可假通过 | 已修：`putLevels` 在 PUT 前取该版本日志行基线，`waitSnapshotApplied` 要求**新增**一行（安全网重拉也读新值）；超时 70s |
| M1 | 低 | verify-monitoring 的 Mismatch 谓词只钉 6 桶中 2 个 metric 名 | 已修：六名全列（267 checks） |
| M2 | 低 | 超时错误文案用默认 60s 而非注入值 | 已修：`runSnapshot(..., timeoutMs)` 透传 |
| M3 | 低 | `settleByRoomVersion` 只写不读（死代码） | 已修：删除 |
| M4 | 低 | `onModuleInit` 不等首快照 ⇒ 冷启动首轮 configUnavailable=1 且停 1h | 已修：照 `ReconcileService` 的有界等待首快照（`SNAPSHOT_BOOT_WAIT_MS`），补「快照晚到」用例 |
| M5 | 低 | 缺表 1146 无部署顺序提示；fake 无 1146 用例 | 已修：`runOnce` catch 识别 1146/ER_NO_SUCH_TABLE 并打部署顺序 error；fake `failNextTxQueryError` + 用例 |
| M6 | 低 | 同 room+owner 多条 fee op 时 `entryFeeByKey` last-wins | 登记：真实 `uk_action_id` 下不可达（action_id 唯一且编码 room+owner）；防御性歧义检测另立 |
| M7 | 低 | slice-35 两条基线断言恒真 | 已修：改为 lastAttemptAt/两玩法分桶在场（仍 4 条基线断言，基线 full=89 不变） |
| M8 | 低 | fake 注释「全文相等」与实际「导入常量 ===」不一致 | 已修：注释改为「常量 ===；文本由测试独立誊写钉住」 |
| M9 | 低 | `main.ts` 未 `enableShutdownHooks()` ⇒ 关停闸生产不执行（既有 ReconcileService/ConfigCacheService 同病） | 登记：非 C2 新引入；若团队统一开启，C2 自动获得保护 |
| M10 | 低 | 一轮 >1h 时跳过路径与迟到 finally 可能各排一条链（inFlight 不重叠） | 登记：极低概率，双链均受 inFlight 串行 |
| M11 | 低 | `entryFeePercents` 对空表返回 `[]`，room-service `readLevels` 对空表返回 null | 登记：spec P5 明确要求 `[]`；仅直改库造空表时有差异 |
| P1 | PLAUSIBLE | 365 天量级真库上 keyset 查询计划可能走 p 主键序扫描/超 30s | 登记：权威轮 slice-35 用真库 EXPLAIN 两条 records SQL；若命中另立优化 |
| P2 | PLAUSIBLE | entry_fee 只按 room 配对；房号无库内唯一性，72h 内复用可能误配 | 登记：线上房号复用率待证据；长期由 room-service 房号唯一性解决 |

复审结论：Critical/Important 全部修复并复跑；M6/M9/M10/M11 与 P1/P2 登记。**slice-35 真栈仍为硬闸**。


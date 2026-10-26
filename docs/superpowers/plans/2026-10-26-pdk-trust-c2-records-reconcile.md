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

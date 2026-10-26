# C2 实施计划：RecordsReconcileService（资金↔记录对账）

> 日期：2026-10-26 · 依据：`docs/superpowers/specs/2026-10-26-pdk-trust-c2-records-reconcile-design.md`（v3）
> 分支/worktree：`feature/pdk-trust-c` @ `D:/Code/ftl-trust-c`（C1 已在同分支；C1 未合 dev，C2 紧随其后）
> 纪律：每任务 TDD（红→绿）→ 提交；只读、不自动改钱；不碰 slice-29/PdkSettlement.vue。

## Global Constraints

- currency-service 只读；**零 INSERT/UPDATE/DELETE**（单测以库零写钉死）。
- 告警 35 → **38 条 / 35 类**；`labels.severity` + `annotations.summary/runbook` 严格层级。
- 指标 13 个（10 个按玩法 + truncated/runs/last_success）；HELP 写明口径。
- 无 DB 迁移/配置键/协议/客户端；admin 响应加性；旧 admin/旧服务可选链兼容。
- 真栈本机 Docker 不可用 ⇒ slice-35 只做 tsc；报告登记「待权威轮」。
- 验证命令：`pnpm -C packages/currency-service test/lint`、`node scripts/verify-monitoring.mjs`、
  `pnpm verify:admin`、`pnpm -C tools/conformance lint`、全量 turbo（或分包证据）。

## Task 1：指标 + 档位 getter + SQL 常量

**Files**：`src/metrics/currency.metrics.ts`、`src/config/config-cache.service.ts`、
`src/reconcile/records-reconcile.sql.ts`（新）、`test/config-cache.test.ts`、
`test/records-reconcile.test.ts`（新，先放 SQL/指标名断言）。

**Step 1（红）**：
- `config-cache.test.ts`：`entryFeePercents('doudizhu')` 新键→旧 `game.baseScoreLevels`；
  `paodekuai` 新键；合法空/全 0 ⇒ `[]`；缺失/非法 ⇒ `null`；不改既有 getter。
- `records-reconcile.test.ts`：13 个指标名/标签；5 条 SQL 全文（测试侧独立誊写 `toBe`），
  含 `p.id AS player_id`/`AND id > ? ORDER BY id ASC LIMIT ?`/窗口参数次序。
- 跑红。

**Step 2（绿）**：
- 指标：`currency_records_reconcile_*`（spec §5.4 逐字；10 个按玩法 + truncated/runs/last_success）。
- `entryFeePercents(gameType): readonly EntryFeePercent[] | null`：
  - ddz 读 `game.levels.doudizhu`，缺失回退 `game.baseScoreLevels`；pdk 读 `game.levels.paodekuai`；
  - `Array.isArray` + 每项 `name:string/baseScore:正整数/entryFeePercent?:0..100`；非法/缺失 ⇒ null；
  - 合法空/全 0 ⇒ []；经 `entryFeePercentsFromLevels` 派生。
- SQL 常量文件（ops/flows/ddz/pdk/skips；分页键 `o.id/f.id/p.id/s.id`）。
- 跑绿 + lint。

**Step 3**：提交 `feat(currency): records reconcile 指标/档位 getter/SQL 常量`。

## Task 2：Fake DB 扩展 + RecordsReconcileService 核心

**Files**：`test/helpers/fake-currency-db.ts`、`src/reconcile/records-reconcile.service.ts`（新）、
`src/app.module.ts`、`test/records-reconcile.test.ts`、`test/wiring`（如需要）。

**Step 1（红）**：先扩 fake DB 的种子/识别面（测试基础设施），再写服务用例：
- Fake DB 新表：`records(ddz/pdk)/players/skips` + seed 方法；`transaction(a,b?)` 支持
  `('REPEATABLE READ', cb)`（记录 isolation）与 manager.query；`run` 识别 5 条 SQL：
  - 按窗口过滤、`id > lastId`、`ORDER BY id`、`LIMIT`（分页）；JOIN 记录/玩家/skips/ops；
  - `SET SESSION ...` 记录并忽略，`... = DEFAULT` 记录；
  - 未知 SQL 继续 reject。
- 用例：一致局全 0；op 24h59m/25h01m；record 1h59m/2h01m 非零/全 NULL/全 0；NULL 1h59m/2h01m；
  flow/玩家/符号/幅度/守恒；台费 op/skip/suspect/unknown/configUnavailable/25h；跨界；
  ddz/pdk 同 key；旧 PDK op ddz；分页（pageSize=2，多页）；200k 上限（fake 计数/注入）；
  事务 isolation/SET/finally 复位；零写；60s 超时（fake 挂起）清 inFlight；轮次/失败后下轮。

**Step 2（绿）**：
- 服务：`RecordsReconcileService`（DataSource + ConfigCacheService；无 Redis）：
  - `onModuleInit` last_success 0 + 首排 10s；自调度/关停/`inFlight`；`runOnce(pageSize=5000)`；
  - `dataSource.transaction('REPEATABLE READ', ...)`；SET 三变量；finally 复位；
  - 5 条 SQL keyset 分页；总行 200k ⇒ TruncatedError + truncated gauge；
  - 判定按 spec §5.3；gauge/last_success/日志聚合；`withTimeout` 60s。
- `app.module.ts` provider。
- 跑绿 + lint。

**Step 3**：提交 `feat(currency): RecordsReconcileService（RR 事务/分页/判定/指标）`。

## Task 3：管理端

**Files**：`src/admin/admin-finance.controller.ts`、`src/admin/finance-query...`（如类型）、
`admin/app.js`、`test/reconcile-admin.test.ts`、`test/admin-finance.test.ts`。

**Step 1（红）**：
- GET `data.records` 状态；POST 成功 `data.records`；records running ⇒ `{skipped:'running'}`；
  records 抛 ⇒ `{error}`；既有 inFlight 仍 409；既有失败原样；旧 admin 可选链。
- 更新既有精确形状断言（加 `records`）；构造壳加 records 依赖。

**Step 2（绿）**：
- 控制器注入 `RecordsReconcileService`；GET/POST 按 spec §5.6；
- `admin/app.js` `formatReconcileResult` 追加 records 可选链；状态区可选链；
- 跑测试 + `pnpm verify:admin`（计数不变；若静态断言格式再调）。

**Step 3**：提交 `feat(admin): 财务对账面板加性展示记录对账`。

## Task 4：告警 + 静态闸 + conformance 计数 + 文档

**Files**：`ftl-alerts.yml`、`scripts/verify-monitoring.mjs`、`Dockerfile.prometheus`、
`slice-16/18/24`、`docs/ops/first-deploy.md`。

**Step 1（红）**：先改 verify-monitoring EXPECTED/谓词/头注释/结构断言（38/35 + severity 在 labels），
跑红。

**Step 2（绿）**：
- 3 条告警（spec §5.5 逐字；labels.severity + annotations）；
- 头部 38/35；Dockerfile 38；slice-16 EXPECTED +3、slice-18/24 35→38；
- verify-monitoring 结构断言：三条新规则块含 `labels:\n    severity:` 与 `annotations:\n    summary:`；
- 手工自证：删一条/把 severity 移出 labels ⇒ 红；
- ops 告警清单 +3；`pnpm -C tools/conformance lint` 绿。

**Step 3**：提交 `feat(monitoring): records reconcile 三条告警 + 38/35 同步`。

## Task 5：conformance slice-35 + baselines

**Files**：`tools/conformance/src/slices/slice-35-records-reconcile.ts`（新）、`run.ts`、
`baselines.json`、`lib/mysql.ts`（如需批量造数 helper）、`lib/prom-text.ts`。

- 注入 RUN_TAG 唯一行：一致 ddz/pdk、孤儿 op（25h+）、gold 记录无 op（2h+ 非零）、全 NULL 无 op、
  金额不一致、台费疑似、台费孤儿 op（25h+）、跨界、0 行玩法、5,001 ops 两页（批量 INSERT ... SELECT）。
- `POST /api/admin/wallet/reconcile/run`（admin token）；断言 `data.records` 与 9004 gauges；
  跨界不计；`truncated=0`；`GET reconcile.records` 一致；零写（本片 room/action 前后行数）。
- 收尾 DELETE 注入行；baselines 只进 full（静态计数分解）；本机 Docker 不可用 ⇒ 待权威轮。
- 提交 `test(conformance): C2 记录对账真栈切片（slice-35）`。

## Task 6：全量验证 + 代码审查

1. `pnpm -C packages/currency-service test` / `lint`；
2. `node scripts/verify-monitoring.mjs`；`pnpm verify:admin`；`pnpm -C tools/conformance lint`；
3. 全量 turbo（或按 C1 的分包证据 + 环境 flake 登记；0 cached）；
4. 10k/20k 基准读数入报告（pageSize 分页；阈值/耗时）；
5. 独立 code review（`origin/dev..HEAD` 的 C2 面）；Critical/Important 修复并复跑；
6. 工作区干净；交付报告。

## 回滚

- 每任务独立提交；无 DB 迁移；revert 即可；无残留数据（只读服务）。

## 计划审查记录

（待独立 reviewer 对抗审查后回填）

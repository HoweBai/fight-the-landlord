# C2 资金 ↔ 记录对账设计（RecordsReconcileService）

> 日期：2026-10-26 · 状态：待对抗审查 · 流程：`docs/dev-process.md`
> 上级：`docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`
> 用户裁决：U4 逐笔结算 op + 48h 滚动窗、每 1h 一轮；U5 只告警/报告，不自动改钱；U10 保留期沿用 365 天。
> 依赖：C1（记录 outbox 24h 重投；`recordmoney:outbox` 仍 1h）。

## 1. 背景与问题

`currency_ops`（`source=game_settle` / `entry_fee`）与 `game_records(_pdk)`、
`game_record_players(_pdk)` 之间没有对账。现有 `ReconcileService` 只做余额↔流水、缓存、
孤儿赠送、机器人池；它**不读对局记录**（`reconcile.service.ts`）。后果：

- 钱已结算但记录不存在（C1 之前会永久丢；C1 之后仍可能在 settle→enqueue 窗口/形状不符时发生）；
- 记录存在但结算 op 不存在（settle 派发前崩溃 / 结算失败终态）；
- 同一局的 `money_delta` 与 `currency_flows` 不一致（截断/抽水/规则之外的人为或 bug 写入）；
- `money_delta` 永久 NULL（`recordmoney:outbox` 1h 放弃）无法与真实写失败区分；
- 台费 op / 免单行缺失，资金面少收无法被看见。

**同库事实**：所有服务共库 `fight_the_landlord`（`currency-service/src/database.config.ts`），
currency-service 可以只读 JOIN 记录表；不需要跨服务 RPC。

## 2. 范围

### 2.1 做

1. 新增 `RecordsReconcileService`（currency-service）：
   - 复用 `currency.reconcileIntervalMs`（不新增配置键），启动 10s 后首跑，1h 一轮，自调度＋关停闸＋`inFlight`；
   - 只读 48h 窗口：`game_settle`/`entry_fee` ops（`created_at`）、记录与玩家行（`ended_at`）、
     台费免单行（`created_at`）、op 的 `currency_flows`；
   - 判定：孤儿 op / 缺失 op / 金额不一致 / 待定 / 疑似 NULL / 台费缺失 / 配置不可用；
   - 只报不改（零 INSERT/UPDATE/DELETE；单测以「库零写」钉死）。
2. 新指标（全部带 `game_type`；另 2 个无标签的轮次/水位）：
   - `currency_records_reconcile_orphan_ops`
   - `currency_records_reconcile_missing_ops`
   - `currency_records_reconcile_amount_mismatch`
   - `currency_records_reconcile_pending`
   - `currency_records_reconcile_null_money_delta`
   - `currency_records_reconcile_entry_fee_missing`
   - `currency_records_reconcile_config_unavailable{game_type}`（0/1）
   - `currency_records_reconcile_runs_total`（counter）
   - `currency_records_reconcile_last_success_timestamp_seconds`（gauge；启动置 0）
3. 新告警 3 条（35 → 38 条，32 → 35 类）：
   - `RecordsReconcileMismatch`（warning；金额/缺失/台费/疑似 NULL 合计 >0，15m）
   - `RecordsReconcileOrphanOps`（critical；孤儿 op >0，10m）
   - `RecordsReconcileStalled`（warning；`last_success` > 2h）
4. 管理端：现有 `GET /api/admin/wallet/reconcile` 与 `POST .../reconcile/run` **加性**扩展
   `records` 子对象；财务面板结果行追加记录对账计数；不新增端点/不新增配置键。
5. 测试：新服务单测（SQL 全文钉死、假 DB 真语义）、admin 控制器/面板、告警计数同步、
   conformance 真栈片（本机 Docker 不可用 ⇒ 待权威轮）。

### 2.2 不做

- 不自动修复/不改钱/不重发结算/不补记录。
- 不新增表/列/迁移；不新增配置键；不改协议；不改客户端。
- 不重做既有 `ReconcileService` 的三检查与指标；只加性扩展管理端响应。
- 不读 `room:outbox`（currency-service 读不到 room Redis）；C1 的 pending 用时间宽限表达。
- 不做每日聚合报表（用户裁决逐笔；日报后续另立）。
- 不改 `recordmoney:outbox` TTL（1h）；NULL 的「原因未知」用独立桶，不当作已知终态。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 新增 `RecordsReconcileService`（独立循环/状态），复用同库只读与既有 admin 端点 | 不侵入既有 ReconcileService 的「恰 N 条直读」测试面；记录对账可独立失败/独立状态；职责清晰 | 多一个 1h 循环/关停闸；管理端响应加性变化 |
| B | 扩展现有 `ReconcileService` 内 | 少一个循环 | 既有大量「直读条数」断言全改；两种对账的失败语义/窗口耦合；回归面大 |
| C | 每日离线 SQL 报表 | 简单 | 用户裁决逐笔 + 48h；无法定位到 room/version；告警延迟到天级 |

**推荐 A**：记录对账与账户/缓存对账是不同数据源、不同失败语义；独立服务让既有
`currency_reconcile_*` 指标与测试完全不动。

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 新服务 `RecordsReconcileService`（currency-service，只读 DataSource） | 同库只读；隔离既有对账测试面 |
| D2 | 复用 `currency.reconcileIntervalMs`；首跑 10s；自调度链 + 关停闸 + `inFlight` | 不新增配置键；与既有节奏一致 |
| D3 | 窗口 = `[now-48h, now)`；每轮独立快照（不跨轮水位） | 用户裁决；48h 覆盖 24h 记录迟到的全部可能 |
| D4 | op→record：op 年龄 <24h 无记录 ⇒ `pending`；≥24h ⇒ `orphanOps` | C1 `record:outbox` TTL 24h；窗口内不把在途当孤儿 |
| D5 | record→op：仅 **gold** 记录、且存在非零 `money_delta`、记录 `ended_at` 年龄 >1h、无 settle op ⇒ `missingOps` | 1h = settle outbox TTL；全零/全 NULL 无法判定，不报 |
| D6 | `money_delta` NULL：op 年龄 ≤1h ⇒ `pending`；>1h ⇒ `nullMoneyDelta`（原因未知，不判金额不一致） | recordmoney 1h TTL；不把年龄当证据 |
| D7 | 每座 `flows.delta` 必须 **精确等于** `player.money_delta`；owner 映射 user_id/robot_id；找不到玩家行 ⇒ `amountMismatch` | 流水是钱的唯一事实；机器人用 robot_id（displayId 绝不出现） |
| D8 | 符号/幅度：`money_delta>0 ⇒ score_change ≥ money_delta`；`money_delta<0 ⇒ score_change ≤ money_delta`；符号相反 ⇒ `amountMismatch` | 输家截断、赢家抽水/余数；不能用等值 |
| D9 | 守恒：全部玩家 `money_delta` 非 NULL 且 op 的 `burned_residue`/`burned_rake` 非 NULL ⇒ `Σmoney_delta + burned_residue + burned_rake === 0`；否则跳过 | 历史 op burn 列 NULL 不可判 |
| D10 | 台费：gold 记录每个真人座必须有 `entryfee:<room>:<owner>` op 或 `currency_entry_fee_skips` 行；fee 由档位配置 `entryFeeOf(baseScore, percents)` 计算，fee=0 跳过；费额必须等于流水绝对值 | 用户要求覆盖 entry_fee；配置不可用 ⇒ `config_unavailable=1` + 跳过台费检查 |
| D11 | 指标：6 个按玩法 + config_unavailable + runs/last_success；gauge 每轮 set（含 0），last_success 启动 0 | 与既有对账指标纪律一致 |
| D12 | 告警 3 条：Mismatch warning / OrphanOps critical / Stalled warning；阈值绝对数 | 用户裁决只告警；孤儿最严重 |
| D13 | 管理端加性扩展：`GET reconcile` 返回 `{...existing, records: status}`；`POST run` 返回 `{...existing, records: result}`；不新增端点 | 复用既有门禁/权限/按钮；旧 admin 可选链兼容 |
| D14 | 记录对账失败（查询抛）⇒ 本轮失败：`last_success` 不推进、`lastError` 留痕、下一轮照排；**不影响既有 ReconcileService** | 两循环独立；部署事故可见 |
| D15 | 无 DB 迁移/配置键/协议/admin 配置计数变化；回滚 = revert | 只读指标/响应扩展 |
| D16 | 真栈：新增 `slice-35-records-reconcile`（注入合成 op/flow/record 后跑 admin run，断言 gauges/结果/零库写），baselines 只进 full 列 | 本机 Docker 不可用 ⇒ 待权威轮 |
| D17 | 保留期/隐私：只读 48h；不新增保留期；不落任何新表 | 用户裁决 U10 |
| D18 | 数据量：48h 窗口 + 索引（`currency_ops(source,created_at)` / `currency_flows(op_id)` / `records(ended_at)`）；plan 里做 10k 行基准 | 防轮次超时 |

## 5. 实现设计

### 5.1 服务骨架

文件：

- `packages/currency-service/src/reconcile/records-reconcile.service.ts`（新）
- `packages/currency-service/src/reconcile/records-reconcile.sql.ts`（SQL 常量；便于全文钉死）
- `packages/currency-service/src/metrics/currency.metrics.ts`（新指标）
- `packages/currency-service/src/app.module.ts`（provider）
- `packages/currency-service/src/admin/admin-finance.controller.ts`（注入/响应）
- `packages/currency-service/src/config/config-cache.service.ts`（`entryFeePercents(gameType)`）
- `admin/app.js`（结果行加性展示）
- `deploy/monitoring/prometheus/rules/ftl-alerts.yml`、`scripts/verify-monitoring.mjs`、
  `Dockerfile.prometheus`、conformance slice 计数

形态逐字照 `ReconcileService` 的循环（`onModuleInit` 置 last_success=0、首跑 10s、
自重排现读间隔、关停闸、`inFlight`、`runWithTrace` 一层/轮）。

```ts
export interface RecordsReconcileCounts {
  orphanOps: number;
  missingOps: number;
  amountMismatch: number;
  pending: number;
  nullMoneyDelta: number;
  entryFeeMissing: number;
}
export interface RecordsReconcileRoundResult extends RecordsReconcileCounts {
  configUnavailable: boolean;
  byGame: { doudizhu: RecordsReconcileCounts; paodekuai: RecordsReconcileCounts };
}
export interface RecordsReconcileStatus {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastResult: RecordsReconcileRoundResult | null;
  lastError: string | null;
  running: boolean;
}
```

`runOnce()`：查询 → 判定 → set gauges → 结果；查询抛 ⇒ 本轮失败（不 set last_success）。
轮末一条摘要日志；各异常类别一条聚合 ERROR/WARN（样例 room/version），不逐条刷屏。

### 5.2 SQL（原文在 `records-reconcile.sql.ts`，测试侧独立誊写并 `toBe`）

窗口参数：`from = now-48h`、`to = now`（`Date` 绑 datetime；pdk 用 epoch ms number）。

```sql
-- OPS（game_settle + entry_fee）
SELECT o.id, o.action_id, o.ref_id, o.source, o.game_type, o.created_at, o.burned_residue, o.burned_rake
FROM currency_ops o
WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ?;

-- FLOWS（两种 source；按 op 分组）
SELECT f.op_id, f.owner_id, f.owner_type, f.delta
FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id
WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ?;

-- 记录 + 玩家（ddz）
SELECT r.id AS record_id, r.room_code, r.game_version, r.mode, r.base_score, r.ended_at,
       p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change
FROM game_records r JOIN game_record_players p ON p.record_id = r.id
WHERE r.ended_at >= ? AND r.ended_at < ?;

-- 记录 + 玩家（pdk）
SELECT r.id AS record_id, r.room_code, r.game_version, r.mode, r.base_score, r.ended_at,
       p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change
FROM game_records_pdk r JOIN game_record_players_pdk p ON p.record_id = r.id
WHERE r.ended_at >= ? AND r.ended_at < ?;

-- 台费免单行
SELECT s.room_code, s.owner_id
FROM currency_entry_fee_skips s
WHERE s.created_at >= ? AND s.created_at < ?;
```

- `created_at`/ddz `ended_at` 由驱动回 `Date`/字符串 ⇒ `toEpochMs()` 归一；pdk `ended_at` BIGINT ⇒ `Number()`。
- `currency_ops.game_type` 为 NULL 的旧行：有记录时按记录玩法，无记录时按 ddz（仅指标）。
- 单条 SQL 失败 ⇒ 整轮失败（fail-fast，与既有 reconcile 同姿态）；不做静默部分结果。

### 5.3 判定细节

构建：

- `recordsByKey: Map<"room:version", RecordAgg>`（ddz+pdk；记录行含 gameType、mode、baseScore、endedAt、players[]）；
- `ops: OpRow[]`；`flowsByOp: Map<opId, FlowRow[]>`；
- `entryFeeOpsByAction: Map<actionId, OpRow>`；`skips: Set<"room:owner">`。

**A. op→record（game_settle）**：

1. `ref_id` 解析 `<room>:<version>`（最后冒号；version 正整数）；失败 ⇒ `amountMismatch`（malformed）。
2. 无记录：`age = now - createdAt`；`<24h` ⇒ `pending`；否则 `orphanOps`。
3. 有记录：
   - `op.gameType` 与记录玩法不符 ⇒ `amountMismatch`；
   - flows 逐条：owner 映射（user→`user_id`，robot→`robot_id`）；无玩家行 ⇒ `amountMismatch`；
   - `money_delta` NULL：op 年龄 ≤1h ⇒ `pending`；否则 `nullMoneyDelta`；
   - `flow.delta !== money_delta` ⇒ `amountMismatch`；
   - 符号/幅度（D8）⇒ `amountMismatch`；
   - 记录里 `money_delta` 非 0 但无对应 flow ⇒ `amountMismatch`；
   - 守恒（D9）⇒ `amountMismatch`。

**B. record→op（gold）**：

- 记录 `mode==='gold'`、`endedAt` 年龄 >1h、存在任一玩家 `money_delta` 非 NULL 且非 0、且无
  `settle:<room>:<ver>`（或 `:r2`）op ⇒ `missingOps`。
- 全 NULL/全 0 ⇒ 不报（零 delta 局合法无 op）。

**C. entry_fee（gold）**：

- `percents = configCache.entryFeePercents(gameType)`；null ⇒ `configUnavailable=true`，跳过本玩法；
- 每个真人座：`fee = entryFeeOf(baseScore, percents)`；`fee===0` 跳过；
- `actionId=entryfee:<room>:<owner>`；有 op ⇒ 其 flow 合计必须 `=== -fee`（否则 `amountMismatch`）；
- 无 op 但有 skip 行 ⇒ 通过；两者都无 ⇒ `entryFeeMissing`。

**D. 计数与指标**：

- 每个判定计数按记录/op 的玩法累加；`byGame` 与 6 个 gauge 按玩法 set（含 0）；
- `pending` 是「op 无记录 <24h」+「money_delta NULL ≤1h」+「record 无 op ≤1h」的合计（诊断用，
  不作为告警主指标）；
- `configUnavailable` 按玩法 0/1；
- 轮末 `last_success`（gauge/counter）与摘要日志。

### 5.4 指标（`currency.metrics.ts`）

全部经 `createGauge/createCounter`；按 `game_type` 的 6+1 个 gauge + 2 个无标签。
命名逐字：

```
currency_records_reconcile_orphan_ops{game_type}
currency_records_reconcile_missing_ops{game_type}
currency_records_reconcile_amount_mismatch{game_type}
currency_records_reconcile_pending{game_type}
currency_records_reconcile_null_money_delta{game_type}
currency_records_reconcile_entry_fee_missing{game_type}
currency_records_reconcile_config_unavailable{game_type}
currency_records_reconcile_runs_total
currency_records_reconcile_last_success_timestamp_seconds
```

HELP 写明口径；`currency_records_reconcile_last_success_timestamp_seconds` 启动置 0。

### 5.5 告警（38 条 / 35 类）

```yaml
- alert: RecordsReconcileMismatch
  expr: 'sum by (game_type) (currency_records_reconcile_amount_mismatch + currency_records_reconcile_missing_ops + currency_records_reconcile_entry_fee_missing + currency_records_reconcile_null_money_delta) > 0'
  for: 15m
  labels: { severity: warning }
  annotations:
    summary: '{{ $labels.game_type }} 资金↔记录对账不一致（金额/缺失/台费/疑似 NULL）'
    runbook: '看 currency-service `records reconcile` 日志与 /api/admin/wallet/reconcile；只报不改，按 room/version 人工核对。'
- alert: RecordsReconcileOrphanOps
  expr: 'sum by (game_type) (currency_records_reconcile_orphan_ops) > 0'
  for: 10m
  labels: { severity: critical }
  annotations:
    summary: '{{ $labels.game_type }} 结算 op 无记录（≥24h）'
    runbook: '钱已动但记录不存在：查 C1 record:outbox / RecordLost；按 op ref_id 核 currency_flows 与记录表；不自动补记录。'
- alert: RecordsReconcileStalled
  expr: 'time() - currency_records_reconcile_last_success_timestamp_seconds > 7200'
  for: 10m
  labels: { severity: warning }
  annotations:
    summary: '记录对账 >2h 未成功（含从未成功）'
    runbook: '查 currency-service 日志与 MySQL 连通；看 records reconcile 查询错误；下一轮自愈。'
```

- 头部 38 条 / 35 类；`verify-monitoring.mjs` EXPECTED +3、谓词、头注释；
  `slice-16/18/24` 35→38；`Dockerfile.prometheus` 38；ops 告警清单 +3。
- 指标是 gauge 当前值；`for` 保证不是瞬时抖动；Mismatch 不含 orphan（孤儿单独 critical）。

### 5.6 管理端

- `AdminFinanceController` 注入 `RecordsReconcileService`（值导入）。
- `GET /api/admin/wallet/reconcile`：
  `{ ...reconcile.getStatus(), records: recordsReconcile.getStatus() }`。
- `POST /api/admin/wallet/reconcile/run`：
  先跑既有 `runReconcileOnce()`，再跑 `recordsReconcile.runOnce()`；返回
  `{ ...existingResult, records: recordsResult }`。任一 `inFlight` ⇒ 既有 409 借 10001 语义
  （先检查两个服务的 running，避免部分执行；先检查再跑）。
- `admin/app.js` `formatReconcileResult` 追加：
  `· 记录孤儿 ${r.records?.orphanOps ?? 0} · 记录缺失 ${r.records?.missingOps ?? 0} · 金额不一致 ${r.records?.amountMismatch ?? 0}`
  以及台费缺失/疑似 NULL；全部可选链 + `?? 0`（新 admin + 旧服务部署窗口）。
- 面板状态区显示 `d.records` 的 lastAttempt/lastSuccess/lastError（新增三行或合并到结果行；
  不新增配置控件，verifier 计数不变）。
- 现有 admin 财务测试：响应 `toEqual` 形状补 `records`；权限/409 用例补两服务 running 面。

### 5.7 测试

新 `packages/currency-service/test/records-reconcile.test.ts`：

- SQL 常量逐字（测试侧独立誊写 `toBe`）；查询顺序/窗口参数（from/to）钉死；
- 一致局 ⇒ 全 0；
- op 无记录：23h ⇒ pending；25h ⇒ orphan；`ref_id` 畸形 ⇒ amountMismatch；
- record 无 op：gold + 非零 delta + 2h ⇒ missingOps；30min ⇒ 不报；全 0/NULL ⇒ 不报；
- flow vs money_delta：不等/缺玩家行/记录有非零 delta 无 flow ⇒ amountMismatch；
- money_delta NULL：op 30min ⇒ pending；2h ⇒ nullMoneyDelta；不重复计 amountMismatch；
- 符号/幅度：赢家 delta > scoreChange、输家 delta < scoreChange、符号相反 ⇒ amountMismatch；
- 守恒：Σ + residue + rake ≠ 0 ⇒ mismatch；burn 列 NULL ⇒ 跳过；
- 台费：op 正路；skip 行正路；fee>0 两者都无 ⇒ entryFeeMissing；费额不等 ⇒ amountMismatch；
  fee=0 ⇒ 跳过；levels 缺失/非法 ⇒ configUnavailable + 跳过；
- pdk/ddz 分桶；ops game_type NULL 的旧行回退；
- 窗口边界（from 含、to 不含）；
- 轮次：runs_total +1、last_success 启动 0/成功 set/失败不 set、inFlight 互斥、关停闸；
- 失败姿态：任一 SQL 抛 ⇒ 整轮失败、下一轮照排；**库零写**（fake 记录所有 query，断言无写语句）；
- 日志聚合：一轮一条摘要 + 类别聚合，不逐条；
- 10k 行基准（plan 执行，记录耗时）。

`admin-finance.controller.test.ts`：GET/POST 响应含 `records`；两服务 running 409；旧服务形状兼容；
`formatReconcileResult` 的 admin 静态断言（如 verifier 覆盖）。

`config-cache.test.ts`：`entryFeePercents` ddz/pdk/legacy/缺失/非法。

`app.module`/wiring：`RecordsReconcileService` provider 可解析。

### 5.8 conformance `slice-35-records-reconcile`

- 用 `mysqlExec` 注入合成：一条 `game_settle` op + flows + 一条匹配记录/玩家（一致）；
  一条孤儿 op（25h 前）；一条 gold 记录无 op（2h 前、非零 money_delta）；一条金额不一致；
  一条台费缺失；RUN_TAG per-run room codes。
- `POST /api/admin/wallet/reconcile/run`（admin token）；轮询 gauges/结果：
  - `orphan_ops{game_type=doudizhu} >= 1`、`missing_ops >= 1`、`amount_mismatch >= 1`、
    `entry_fee_missing >= 1`；
  - `GET reconcile` 的 `records` 字段与 gauges 一致；
  - 零库写：注入前后 `currency_accounts`/`currency_flows`/`observations` 行数不变（按本片
    room 过滤）。
- 收尾：删除注入行（`mysqlExec` DELETE 本片 room/action_id 前缀）；还原无配置。
- baselines 只进 full 列；本机 Docker 不可用 ⇒ 待权威轮。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| op 无记录 <24h | pending（C1 outbox 可能仍在投） |
| op 无记录 ≥24h | orphanOps + critical |
| gold 记录无 op >1h 且非零 delta | missingOps |
| gold 记录无 op ≤1h | pending |
| money_delta NULL ≤1h | pending |
| money_delta NULL >1h | nullMoneyDelta（原因未知，不判金额） |
| flow 无玩家行 / 金额不等 / 符号幅度 / 守恒 | amountMismatch |
| burn 列 NULL | 跳过守恒（历史行） |
| 台费 op/skip 都无（fee>0） | entryFeeMissing |
| 台费 op 金额不等 | amountMismatch |
| levels 配置缺失/非法 | configUnavailable=1 + 跳过台费 |
| ref_id 畸形 | amountMismatch |
| 查询抛错 | 整轮失败（last_success 不推进、lastError、下轮照排） |
| `inFlight` | 手动 ⇒ 409；定时 ⇒ 跳过本轮 |
| 旧 admin + 新服务 | 加性字段，旧 UI 忽略；新 admin + 旧服务 ⇒ 可选链 `?? 0` |
| 数据量 | 48h 窗口 + 索引；plan 10k 基准；超时则轮次失败可见 |

## 7. 迁移与回滚

- 无 DB 迁移/配置键/协议/表结构变更。
- 回滚 = revert 提交；新指标/告警/响应字段消失；无残留数据。
- 管理端部署窗口：new admin + old currency-service ⇒ `records` 缺失，UI `?? 0` 不崩。

## 8. 测试判据（完成定义）

1. 新服务/配置缓存/admin/指标单测全绿；currency-service 全量测试 + lint。
2. `pnpm exec turbo run test lint --force` 全绿（或按 C1 的分包证据 + 环境 flake 登记）。
3. `verify-monitoring.mjs` 38/35；判别力自证。
4. conformance 静态：slice-16/18/24 35→38；`tools/conformance` tsc/lint；slice-35 已注册/基线。
5. `pnpm verify:admin` 通过（面板加性展示；无配置键计数变化）。
6. 真栈 slice-35 待权威轮（本机无 Docker）。
7. 工作区干净；diff 不含协议/DB 迁移/slice-29/PdkSettlement.vue。

## 9. 涉及文件

**生产**：`reconcile/records-reconcile.service.ts`（新）、`reconcile/records-reconcile.sql.ts`（新）、
`app.module.ts`、`admin/admin-finance.controller.ts`、`config/config-cache.service.ts`、
`metrics/currency.metrics.ts`、`admin/app.js`。

**监控/文档**：`ftl-alerts.yml`、`verify-monitoring.mjs`、`Dockerfile.prometheus`、
`docs/ops/first-deploy.md`、总 spec/C2 spec/plan。

**测试/conformance**：`test/records-reconcile.test.ts`（新）、`test/admin-finance.controller.test.ts`、
`test/config-cache.test.ts`、`test/helpers/fake-currency-db.ts`、
`tools/conformance/src/slices/slice-35-records-reconcile.ts`（新）、`run.ts`、`baselines.json`、
`slice-16/18/24` 计数。

## 10. 审查记录

（待独立对抗审查后回填）

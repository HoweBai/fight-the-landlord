# C2 资金 ↔ 记录对账设计（v4，RecordsReconcileService）

> 日期：2026-10-26 · 状态：已按三轮对抗审查修订（进入 plan v2） · 流程：`docs/dev-process.md`
> 上级：`docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`
> 用户裁决：U4 逐笔 + 48h 滚动窗、每 1h 一轮；U5 只告警/报告，不自动改钱；U10 保留期 365 天。
> 依赖：C1（record outbox 24h；`recordmoney:outbox` 1h）。
> 审查记录见 §10（首轮 3 阻断/6 高/5 低；v2 delta 6 高；v3 plan 4 阻断/10 高/5 低）。

## 1. 背景与问题

`currency_ops`（`source=game_settle`/`entry_fee`）与 `game_records(_pdk)` /
`game_record_players(_pdk)` 之间没有对账。现有 `ReconcileService` 只做余额↔流水、缓存、
孤儿赠送、机器人池。后果：钱已结算但记录不存在 / 记录存在但 op 不存在 / `money_delta` 与流水
不一致 / `money_delta` 永久 NULL / 台费缺失，均不可见。所有服务共库，currency-service 可只读
JOIN 记录表。

## 2. 范围

### 2.1 做

1. 新增 `RecordsReconcileService`：
   - 复用 `currency.reconcileIntervalMs`；启动 10s 首跑、1h 一轮、自调度/关停闸/`inFlight`；
   - **只读事务显式 REPEATABLE READ**（`DataSource.transaction('REPEATABLE READ', manager => ...)`）；
     会话变量 `max_execution_time=30000` / `lock_wait_timeout=30` / `innodb_lock_wait_timeout=30`
     在**同一 manager 的 finally** 复位 DEFAULT；轮级超时（可注入，默认 60s）+ abort 标志；
   - keyset 分页：ops/flows/skips 按 `o.id/f.id/s.id`；records+players 按 **`p.id`（player_id）**；
     每页 5000，单查询总行 ≤200k；超限 ⇒ TruncatedError + `truncated=1` gauge + 整轮失败；
   - 目标窗 `[to-48h,to)` + 查询两侧 24h 余量；只统计自身时间在目标窗的条目；
   - 判定：孤儿 op / 缺失 op / 全 NULL 无 op / 金额不一致 / 待定 / 疑似 NULL / 台费疑似 /
     台费未知 / 台费孤儿 op / 配置不可用；
   - 只报不改（零写；单测钉死）。
2. 指标（按玩法 10 个 gauge + truncated/runs/last_success）：
   `orphan_ops` / `missing_ops` / `null_no_op` / `amount_mismatch` / `pending` /
   `null_money_delta` / `entry_fee_suspect` / `entry_fee_unknown` / `entry_fee_orphan_ops` /
   `config_unavailable` + `truncated` + `runs_total` + `last_success_timestamp_seconds`。
3. 告警 3 条（35 → 38 条，32 → 35 类）：`RecordsReconcileMismatch`(warning)、
   `RecordsReconcileOrphanOps`(critical)、`RecordsReconcileStalled`(warning)；
   **YAML 一律 `labels.severity` + `annotations.summary/runbook`**；verify-monitoring 加结构断言
   （多行正则，容 8/10 空格缩进）；slice-16 的 promtool 继续做语法闸。
4. 管理端：**只加 GET 状态** —— `GET /api/admin/wallet/reconcile` 加性返回 `records` 状态；
   `POST .../reconcile/run` **完全不变**（不跑 records、不改响应）。records 由 1h 循环/启动 10s
   首跑产出；财务面板加性展示 records 状态/最近结果。**不新增手动 records 路由。**
5. 测试/conformance：新服务/配置/指标单测；`slice-35`（重启 currency-service 触发首跑；
   分页 sentinel、0 行、跨界、台费 suspect/unknown、旧 PDK 标签、零写；本机无 Docker ⇒ 待权威轮）。

### 2.2 不做

- 不自动修复/不改钱/不重发结算/不补记录。
- 不新增表/列/迁移/配置键；不改协议/客户端。
- 不重做既有 ReconcileService；不改其循环/指标/POST 响应。
- 不读 room Redis；用时间余量表达 pending。
- 不做每日聚合报表；不新增手动 records 触发。
- 不改 `recordmoney:outbox` TTL。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 新 `RecordsReconcileService`；只加 GET 状态；1h/首跑 10s | 隔离既有测试/POST；无 HTTP 长请求/竞态；职责清晰 | 手动只能重启/等 1h（运维可接受） |
| B | 扩展现有 ReconcileService | 少一个循环 | 既有断言全改；耦合 |
| C | 每日离线 SQL | 简单 | 无法逐笔定位 |

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 新服务（currency-service，只读 DataSource） | 同库只读；隔离既有对账 |
| D2 | 复用 `currency.reconcileIntervalMs`；首跑 10s；自调度/关停/`inFlight` | 不新增键 |
| D3 | 目标窗 `[to-48h,to)`；`to=now`；查询 `[from-24h,to+24h)`，只统计自身时间在目标窗的条目 | 防跨表边缘假孤儿/假缺失 |
| D4 | op→record：op 年龄 **<25h** ⇒ pending；≥25h ⇒ orphanOps | C1 outbox 24h + 1h |
| D5 | record→op：仅 gold、记录年龄 >**2h**：非零 money_delta ⇒ missingOps；**任一 NULL 且无非零 ⇒ nullNoOp**；全 0（无 NULL）⇒ 跳过 | settle 1h + 1h；混合 NULL/0 不静默 |
| D6 | money_delta NULL：op 年龄 ≤**2h** ⇒ pending；>2h ⇒ nullMoneyDelta | recordmoney 1h + 1h |
| D7 | flow.delta 精确等于 money_delta；owner 映射 user_id/robot_id；无玩家行/非零 delta 无 flow ⇒ amountMismatch | 流水是唯一事实 |
| D8 | 符号/幅度：`>0 ⇒ score_change ≥ delta`；`<0 ⇒ score_change ≤ delta`；符号相反 ⇒ mismatch | 截断/抽水 |
| D9 | 守恒：全部非 NULL 且 burn 两列非 NULL ⇒ `Σ + residue + rake === 0`；否则跳过 | 历史 burn NULL |
| D10 | 台费：有 op ⇒ 以流水为历史事实（恰一条、owner 匹配、delta<0），不比较当前费额；有 skip ⇒ 通过；都无：`percents=null` ⇒ configUnavailable；fee>0 ⇒ entryFeeSuspect；fee=0/档位缺失 ⇒ entryFeeUnknown（盲区，独立 gauge，不进 Mismatch） | 当前配置不能反推历史；fee=0 不静默 |
| D11 | 台费 op 无记录：op 年龄 >**25h** ⇒ entryFeeOrphanOps；≤25h ⇒ pending；有记录但 owner 非真人座/记录非 gold ⇒ amountMismatch | 与 D4 对齐 |
| D12 | 有记录以记录表玩法为准（A2 旧 PDK op 标 ddz 不误报）；无记录用 op.game_type；比较 op/record 时按 room:version 查找，唯一时兼容旧标签 | 旧 backfill 兼容 |
| D13 | `recordsByKey` 用 `gameType:room:version`；skip 集合用 `gameType:room:owner`（skip.game_type 缺失 ⇒ ddz）；PDK 记录 SQL 带 `r.game_type` | ddz/pdk 不互串 |
| D14 | 只读事务显式 REPEATABLE READ；同一 `manager.query` 在 finally 复位三条会话变量；轮级超时（可注入，默认 60s）+ abort 标志：超时后底层事务的 gauge/结果写入被 abort 抑制，`inFlight` 在事务 settle 后清 | 会话复位在同一连接；不重叠 |
| D15 | keyset 分页：ops/flows/skips 按各自 id；records+players 按 **p.id AS player_id**；每页 5000；**每个查询**总行 ≤200k（可注入 maxTotalRows）；超限 ⇒ TruncatedError + gauge + 整轮失败 | 多玩家记录不漏行；20k 不永久失明 |
| D16 | 管理端只加 GET `records` 状态；POST 完全不变；不新增手动 records 路由 | 不拖垮既有工具；无 60s HTTP/竞态 |
| D17 | 无 DB 迁移/配置键/协议；回滚 = revert | 最小面 |
| D18 | 部署顺序 user-service 迁移先于 currency-service；缺表 1146 ⇒ 整轮失败 + Stalled + 明确日志 | 部署事故可见 |
| D19 | 保留期只读 48h；20k/10k 基准在 plan + unit；slice-35 含分页 sentinel/0 行/跨界 | 用户裁决；性能可验 |
| D20 | 真栈 slice-35：注入行 → `docker restart ftl-currency-service` → 轮询 GET records.lastResult；断言 gauges/结果/零写；baselines 只进 full；本机 Docker 不可用 ⇒ 待权威轮（未跑不得称完成） | 无手动触发，用启动首跑 |

## 5. 实现设计

### 5.1 服务骨架

文件：`src/reconcile/records-reconcile.service.ts`（新）、`records-reconcile.sql.ts`（新）、
`app.module.ts`、`admin/admin-finance.controller.ts`（仅 GET）、`config/config-cache.service.ts`、
`metrics/currency.metrics.ts`、`admin/app.js`。

```ts
export interface RecordsReconcileCounts {
  orphanOps: number; missingOps: number; nullNoOp: number; amountMismatch: number;
  pending: number; nullMoneyDelta: number; entryFeeSuspect: number; entryFeeUnknown: number;
  entryFeeOrphanOps: number; configUnavailable: 0 | 1;
}
export interface RecordsReconcileRoundResult extends RecordsReconcileCounts {
  truncated: boolean;
  byGame: { doudizhu: RecordsReconcileCounts; paodekuai: RecordsReconcileCounts };
}
export interface RecordsReconcileStatus {
  lastAttemptAt: number | null; lastSuccessAt: number | null;
  lastResult: RecordsReconcileRoundResult | null; lastError: string | null; running: boolean;
}
```

常量：`TARGET_WINDOW_MS=48h`、`PAIR_MARGIN_MS=24h`、`ORPHAN_GRACE_MS=25h`、
`OP_GRACE_MS=2h`、`NULL_GRACE_MS=2h`、`ENTRY_FEE_ORPHAN_GRACE_MS=25h`、
`PAGE_SIZE=5000`、`MAX_TOTAL_ROWS=200_000`、`ROUND_TIMEOUT_MS=60_000`、
`QUERY_MAX_EXECUTION_MS=30_000`。

循环照 `ReconcileService`（`onModuleInit` 置 last_success=0、首跑 10s、自重排现读、关停闸、
`inFlight`、`runWithTrace` 一层/轮）；`runOnce(opts?: {pageSize?, maxTotalRows?, timeoutMs?})`
（测试注入小值）。轮末一条摘要日志；异常类别聚合（样例 room/version），不逐条。

**超时/abort**：`const attempt = ++this.attemptSeq; this.aborted = null;`
`withTimeout(transactionPromise, timeoutMs)`；超时 ⇒ `this.aborted = attempt`、抛
`RecordsReconcileTimeoutError`；事务 callback 在写 gauge/结果前检查 `this.aborted !== attempt`；
`inFlight` 在事务 settle 的 finally 清（超时后下一轮看到 inFlight 仍 true ⇒ 跳过，不重叠）。

### 5.2 SQL、事务与分页

`records-reconcile.sql.ts` 导出 5 条 SQL；测试侧独立誊写并 `toBe`。参数类型：
- ops/flows/skips `created_at`、ddz `ended_at` = **DATETIME(3) ⇒ 绑 `new Date(ms)`**；
- pdk `ended_at` = **BIGINT ⇒ 绑 number ms**；
- 分页参数 `lastId` number、`pageSize` number。

```sql
-- OPS（orders/limit by o.id）
SELECT o.id, o.action_id, o.ref_id, o.source, o.game_type, o.created_at, o.burned_residue, o.burned_rake
FROM currency_ops o
WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ? AND o.id > ?
ORDER BY o.id ASC LIMIT ?;
-- FLOWS（by f.id）
SELECT f.id, f.op_id, f.owner_id, f.owner_type, f.delta
FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id
WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ? AND f.id > ?
ORDER BY f.id ASC LIMIT ?;
-- DDZ records+players（by p.id）
SELECT p.id AS player_id, r.id AS record_id, r.room_code, r.game_version, r.mode, r.base_score, r.ended_at,
       p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change
FROM game_records r JOIN game_record_players p ON p.record_id = r.id
WHERE r.ended_at >= ? AND r.ended_at < ? AND p.id > ?
ORDER BY p.id ASC LIMIT ?;
-- PDK records+players（by p.id；带 r.game_type）
SELECT p.id AS player_id, r.id AS record_id, r.room_code, r.game_version, r.game_type, r.mode, r.base_score, r.ended_at,
       p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change
FROM game_records_pdk r JOIN game_record_players_pdk p ON p.record_id = r.id
WHERE r.ended_at >= ? AND r.ended_at < ? AND p.id > ?
ORDER BY p.id ASC LIMIT ?;
-- SKIPS（by s.id；带 game_type）
SELECT s.id, s.room_code, s.owner_id, s.game_type
FROM currency_entry_fee_skips s
WHERE s.created_at >= ? AND s.created_at < ? AND s.id > ?
ORDER BY s.id ASC LIMIT ?;
```

- 事务：`dataSource.transaction('REPEATABLE READ', async (manager) => { SET 3; try { 分页5条 } finally { SET ...=DEFAULT } })`；
  同一 manager/reset；`SET` 先于首读；fake 记录 isolation/语句。
- 分页 helper：每查询 `lastId=0`；页满取最后 id；总行 > maxTotalRows ⇒ TruncatedError
  （设置 `truncated=1` gauge、ERROR），整轮失败。
- 多玩家记录：按 `player_id` 分页，跨页按 `record_id` 聚合（不丢行）；单测 pageSize=2 的 3 人局。
- 轮级 timeout/abort（见 5.1）；MySQL max_execution/lock_wait 兜住卡查询。
- ddz Date/string ⇒ `toEpochMs`；pdk BIGINT ⇒ `Number()`；非有限 ⇒ mismatch + ERROR。
- 缺表 1146 ⇒ 整轮失败，日志指部署顺序。

### 5.3 判定

构建：`settleOpsByRoomVersion: Map<"room:version", OpRow[]>`、`entryFeeOpsByAction`、
`flowsByOp`、`recordsByKey: Map<"gameType:room:version", RecordAgg>`、`skips: Set<"gameType:room:owner">`。

**A. record→op（gold）**：目标窗内每条记录：
- 找 settle op：优先 `gameType:room:version`；否则 room:version 唯一 op（兼容旧标签）。
- 无 op：`age = now - endedAt`；≤2h ⇒ pending；非零 money_delta ⇒ missingOps；
  任一 NULL 且无非零 ⇒ nullNoOp；全 0（无 NULL）⇒ 跳过。
- 有 op：进入 B（按 op id 去重）。

**B. game_settle op**：目标窗内每个 op：
- ref 解析失败 ⇒ mismatch；无记录 <25h pending / ≥25h orphan；
- 有记录：mode 非 gold ⇒ mismatch；flow/玩家/符号/幅度/守恒（D7–D9）；每个异常按 record/op 去重；
  money_delta NULL ≤2h pending / >2h nullMoneyDelta。

**C. entry_fee**：
- 记录真人座：op ⇒ 恰一条 flow、owner 匹配、delta<0（否则 mismatch），不比当前费额；skip ⇒ 通过；
  都无 ⇒ percents=null ⇒ configUnavailable；fee>0 ⇒ suspect；fee=0 ⇒ unknown；
- op：action 畸形 ⇒ mismatch；无记录 ≤25h pending / >25h entryFeeOrphanOps；
  有记录但 owner 非真人座 ⇒ mismatch。

**D. 计数/指标**：按 item 去重；byGame 含 configUnavailable；轮末 set 所有 gauge（含 0）、
truncated（成功轮 0）、last_success；abort 后不写。

### 5.4 指标（`currency.metrics.ts`）

```
currency_records_reconcile_orphan_ops{game_type}
currency_records_reconcile_missing_ops{game_type}
currency_records_reconcile_null_no_op{game_type}
currency_records_reconcile_amount_mismatch{game_type}
currency_records_reconcile_pending{game_type}
currency_records_reconcile_null_money_delta{game_type}
currency_records_reconcile_entry_fee_suspect{game_type}
currency_records_reconcile_entry_fee_unknown{game_type}
currency_records_reconcile_entry_fee_orphan_ops{game_type}
currency_records_reconcile_config_unavailable{game_type}
currency_records_reconcile_truncated
currency_records_reconcile_runs_total
currency_records_reconcile_last_success_timestamp_seconds
```

HELP 写明只报不改/pending/entry_fee_suspect/unknown/truncated；last_success 启动 0；
gauge 每轮 set（含 0；truncated 成功轮 0）。

### 5.5 告警（38 条 / 35 类；YAML 结构严格）

```yaml
- alert: RecordsReconcileMismatch
  expr: 'sum by (game_type) (currency_records_reconcile_amount_mismatch + currency_records_reconcile_missing_ops + currency_records_reconcile_null_no_op + currency_records_reconcile_null_money_delta + currency_records_reconcile_entry_fee_suspect + currency_records_reconcile_entry_fee_orphan_ops) > 0'
  for: 15m
  labels:
    severity: warning
  annotations:
    summary: '{{ $labels.game_type }} 资金↔记录对账不一致'
    runbook: '看 currency-service records reconcile 日志与 /api/admin/wallet/reconcile；只报不改，按 room/version 人工核对。'
- alert: RecordsReconcileOrphanOps
  expr: 'sum by (game_type) (currency_records_reconcile_orphan_ops) > 0'
  for: 10m
  labels:
    severity: critical
  annotations:
    summary: '{{ $labels.game_type }} 结算 op 无记录（≥25h）'
    runbook: '钱已动但记录不存在：查 C1 record:outbox / RecordLost；按 op ref_id 核 currency_flows 与记录表；不自动补记录。'
- alert: RecordsReconcileStalled
  expr: 'time() - currency_records_reconcile_last_success_timestamp_seconds > 7200'
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: '记录对账 >2h 未成功（含从未成功）'
    runbook: '查 currency-service 日志/MySQL 连通/缺表 1146/truncated=1；下一轮自愈。'
```

- 头部 38/35；verify-monitoring EXPECTED +3、谓词、头注释，并新增结构断言：
  `/^\s*labels:\s*\n\s+severity:/m` 与 `/^\s*annotations:\s*\n\s+summary:/m` 对三条新规则块；
  判别力自证（severity 移出 labels ⇒ 红）。
- slice-16/18/24 35→38；slice-18/24 的 name 数组加三条 C2 名；Dockerfile 38；ops 清单 +3。

### 5.6 管理端

- 控制器注入 `RecordsReconcileService`（值导入）；**仅 GET 加性**：
  `{ ...reconcile.getStatus(), records: records.getStatus() }`。
- **POST 完全不变**（不调用 records、不改响应）。
- admin `formatReconcileResult` 追加 records 可选链字段（孤儿/缺失/全NULL/金额/待定/疑似NULL/
  台费疑似/台费未知/台费孤儿/truncated），`?? 0`；状态区显示 records lastAttempt/lastSuccess/
  lastError（可选链）；旧服务无 `records` 不崩。
- 测试：`reconcile-admin.test.ts`、`admin-finance.test.ts`、**`admin-reverse.test.ts`** 三处
  Nest 模块都加 `RecordsReconcileService` provider（用无生命周期委托壳，避免 10s 定时器）；
  GET 精确形状加 `records`；POST 形状不变。
- `app.module` provider 注册；wiring/装配断言。

### 5.7 测试

`test/records-reconcile.test.ts`（新）：
- SQL 全文/参数类型（Date vs number）/占位次序/分页键 `player_id`；5 条查询同一事务、
  isolation='REPEATABLE READ'、SET 三条先于首读、finally 复位（同 manager）；
- 分页：3 人局 pageSize=2 跨页后仍 3 行聚合；5,001 ops 两页；每个查询 maxTotalRows 超限
  （注入小值）⇒ TruncatedError + gauge + last_success 不推进；
- 一致局全 0；op 24h59m/25h01m；record 1h59m/2h01m 非零/任一 NULL 无非零/全 0；
  NULL 1h59m/2h01m；flow/玩家/符号/幅度/守恒（burn NULL 跳过）；
- 台费 op/skip/suspect/unknown/configUnavailable/25h/owner 非真人/mode 非 gold；
- 跨界；ddz/pdk 同 key；旧 PDK op ddz；skip 带 game_type 分桶；
- 事务/零写；轮次/关停/失败后下轮；会话复位；超时（注入小 timeout + fake timers）⇒ abort、
  不写 gauge、inFlight 在事务 settle 后清、下轮不重叠；
- 日志聚合；10k/20k 基准（plan 执行，记录耗时）。

`config-cache.test.ts`：`entryFeePercents` 合法空 ⇒ `[]`；合法全 0 ⇒ 非空全 0 数组（不丢档位）；
缺失/非法 ⇒ `null`；ddz 新键→旧 `game.baseScoreLevels`；pdk；不改既有 getter。

`reconcile-admin.test.ts` / `admin-finance.test.ts` / `admin-reverse.test.ts`：GET `records`；
POST 不变；旧 admin 可选链；三处 DI provider。

### 5.8 conformance `slice-35-records-reconcile`

- 注入 RUN_TAG 唯一行：一致 ddz/pdk；孤儿 op（25h+）；gold 记录无 op（2h+ 非零）；任一 NULL 无
  非零；金额不一致；台费 suspect（先 PUT 一个 `entryFeePercent>0` 的档位并等快照，finally 还原）；
  台费 unknown（fee=0/档位缺失）；台费孤儿 op（25h+）；跨界；0 行玩法；
  **分页 sentinel**：5,001 ops + 5,001 players（含一条唯一可识别 sentinel）确保两页都消费。
- 触发：`docker restart ftl-currency-service` → 健康 → 轮询 `GET reconcile.records`：
  `running=false` 且 `lastResult` 非 null/新鲜（≤90s）；再断言 gauges（9004）与 `data.records`；
  跨界不计；`truncated=0`；`config_unavailable=0`；`GET` 与 gauges 一致。
- 零写：注入前后 DB 行数（本片 room/action 前缀）不变；收尾 DELETE 注入行。
- baselines 只进 full；本机 Docker 不可用 ⇒ 待权威轮；**slice-35 未过权威轮不得称 C2 完成/不得合 dev**。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| op 无记录 <25h | pending |
| op 无记录 ≥25h | orphanOps critical |
| gold 记录无 op ≤2h | pending |
| 记录无 op >2h + 非零 | missingOps |
| 记录无 op >2h + 任一 NULL 无非零 | nullNoOp |
| 记录无 op + 全 0（无 NULL） | 合法跳过 |
| money_delta NULL ≤2h | pending |
| NULL >2h | nullMoneyDelta |
| flow/玩家/符号/幅度/守恒 | amountMismatch |
| burn NULL | 跳过守恒 |
| 台费 op/skip | 通过（op 以流水为历史事实） |
| 都无 + fee>0 | entryFeeSuspect |
| 都无 + fee=0/档位缺失 | entryFeeUnknown（盲区，独立 gauge） |
| levels 缺失/非法 | configUnavailable=1，跳过台费 |
| 台费 op 无记录 ≤25h / >25h | pending / entryFeeOrphanOps |
| ref/action 畸形 | amountMismatch |
| 查询抛/超时/超 200k/缺表 | 整轮失败；truncated/lastError；last_success 不推进；下轮照排 |
| 超时后旧事务 | abort 标志抑制 gauge/结果；inFlight 待 settle 后清；下轮跳过 |
| 旧 admin/旧服务 | 可选链，不崩 |
| 数据量 | 48h+24h、分页 5000/每查询 200k、30s/60s、索引；10k/20k 基准 |

## 7. 迁移与回滚

- 无 DB 迁移/配置键/协议/表结构；回滚 = revert；无残留。
- 部署顺序：user-service（记录表）→ currency-service；缺表 1146 整轮失败 + Stalled。

## 8. 测试判据

1. 新服务/config/admin/指标单测全绿；currency-service 全量 + lint。
2. 全量 turbo（或分包证据 + 环境 flake 登记）；0 cached。
3. `verify-monitoring.mjs` 38/35 + 结构断言/判别力自证。
4. conformance 静态：slice-16/18/24 35→38 + C2 名集；tsc/lint；slice-35 注册/基线（full 列）。
5. `pnpm verify:admin` 通过。
6. 真栈 slice-35 **必须**在权威轮通过（本机无 Docker ⇒ 待权威轮；未过不得称完成）。
7. 工作区干净；diff 不含协议/DB 迁移/slice-29/PdkSettlement.vue。

## 9. 涉及文件

生产：`reconcile/records-reconcile.service.ts`（新）、`records-reconcile.sql.ts`（新）、
`app.module.ts`、`admin/admin-finance.controller.ts`、`config/config-cache.service.ts`、
`metrics/currency.metrics.ts`、`admin/app.js`。
监控/文档：`ftl-alerts.yml`、`verify-monitoring.mjs`、`Dockerfile.prometheus`、
`docs/ops/first-deploy.md`、C2 spec/plan。
测试/conformance：`test/records-reconcile.test.ts`（新）、`test/reconcile-admin.test.ts`、
`test/admin-finance.test.ts`、`test/admin-reverse.test.ts`、`test/config-cache.test.ts`、
`test/helpers/fake-currency-db.ts`、`slice-35-records-reconcile.ts`（新）、`run.ts`、
`baselines.json`、`slice-16/18/24`。

## 10. 审查记录

### 10.1 首轮（2026-10-26）：3 阻断 / 6 高 / 5 低

处置见 v2 §10（全 NULL、窗口配对、台费历史、25h/2h、entry_fee 分支、admin、事务、超时/行数、
真栈、gameType key、A2 backfill、config gauge、缺表）。

### 10.2 v2 delta（2026-10-26）：6 高

处置见 v3 §10（25h、fee=0 unknown、分页/上限、RR/复位/超时、records 不阻塞、YAML severity）。

### 10.3 v3 plan 审查（2026-10-26）：4 阻断 / 10 高 / 5 低 → v4

| # | 级别 | 发现 | v4 处置 |
|---|---|---|---|
| P1 | 阻断 | 分页键 r.id 会切多玩家记录丢行 | §5.2：records+players 按 `p.id AS player_id` 分页，跨页按 record_id 聚合；单测 3 人 pageSize=2 |
| P2 | 阻断 | 会话复位不在同一连接；60s 不取消事务 | D14/§5.1：同一 manager finally 复位；abort 标志 + inFlight 待 settle；manager 事务 |
| P3 | 阻断 | `admin-reverse.test.ts` 未列 DI 同步 | §5.6/§5.7：三处测试模块加 provider；无生命周期委托壳 |
| P4 | 阻断 | slice-35 台费 suspect 在种子费率 0 下构造不出 | §5.8：先 PUT entryFeePercent>0 档位并等快照；再注入 unknown 行 |
| P5 | 高 | 全 0 ⇒ [] 与 helper 矛盾 | §5.7：合法空 ⇒ []；全 0 档位 ⇒ 非空全 0 数组 |
| P6 | 高 | 时间参数 Date vs number 未定 | §5.2：DATETIME 绑 Date；PDK BIGINT 绑 number；测试断言 |
| P7 | 高 | fake DB 缺 createdAt | Task 2：FakeOpRow/FakeSkipRow.createdAt + seed/window 过滤 |
| P8 | 高 | 告警结构缩进写错 | §5.5：多行正则 `\s+severity`；三条规则块 |
| P9 | 高 | admin records 触发竞态/60s | D16/§5.6：**取消手动 records 触发**；只 GET 状态；POST 不变 |
| P10 | 高 | slice-35 inFlight/配置就绪/分页 sentinel | §5.8：重启后轮询 running/lastResult；分页 sentinel |
| P11 | 高 | 真栈覆盖不足 | §5.8/§8：slice-35 硬闸；补 skip/unknown/旧 PDK/1146/truncated fake 用例 |
| P12 | 高 | 200k 口径 | D15：**每个查询**上限 200k，可注入 maxTotalRows |
| P13 | 高 | skip/PDK game_type | D13/§5.2：SKIPS 带 game_type；PDK SELECT `r.game_type`；skip key 带玩法 |
| P14 | 高 | 全 NULL vs 任一 NULL | D5：任一 NULL 且无非零 ⇒ nullNoOp；混合 NULL/0 用例 |
| 低 | | 命令/文件/基准口径/告警名集/timeout 测试 | §5.7/§5.8：分开命令、去掉 `test/wiring`、给阈值、name 集加 C2、注入 timeout+fake timers |

### 10.4 进入 plan v2

v4 已闭合三轮发现；plan v2 直接按本 spec 的 Task 边界执行。

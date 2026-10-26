# C2 资金 ↔ 记录对账设计（v3，RecordsReconcileService）

> 日期：2026-10-26 · 状态：已按两轮对抗审查修订（进入 plan） · 流程：`docs/dev-process.md`
> 上级：`docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`
> 用户裁决：U4 逐笔 + 48h 滚动窗、每 1h 一轮；U5 只告警/报告，不自动改钱；U10 保留期 365 天。
> 依赖：C1（record outbox 24h；`recordmoney:outbox` 1h）。审查记录见 §10（首轮 3 阻断/6 高/5 低；v2 delta 6 高）。

## 1. 背景与问题

`currency_ops`（`source=game_settle`/`entry_fee`）与 `game_records(_pdk)`、
`game_record_players(_pdk)` 之间没有对账。现有 `ReconcileService` 只做余额↔流水、缓存、
孤儿赠送、机器人池。后果：钱已结算但记录不存在 / 记录存在但 op 不存在 / `money_delta` 与流水
不一致 / `money_delta` 永久 NULL / 台费缺失，均不可见。所有服务共库，currency-service 可只读
JOIN 记录表。

## 2. 范围

### 2.1 做

1. 新增 `RecordsReconcileService`：
   - 复用 `currency.reconcileIntervalMs`；启动 10s 首跑、1h 一轮、自调度/关停闸/`inFlight`；
   - 只读事务**显式 REPEATABLE READ**（`dataSource.transaction('REPEATABLE READ', ...)`），
     会话变量 `max_execution_time=30000` / `lock_wait_timeout=30` / `innodb_lock_wait_timeout=30`
     在 finally **复位为 DEFAULT**；轮级 60s 超时；
   - **keyset 分页**（每页 5000 行，单查询总行上限 200k；超限 ⇒ `TruncatedError` + 独立 gauge +
     整轮失败）；目标窗 `[to-48h,to)` + 查询两侧 24h 余量；
   - 判定：孤儿 op / 缺失 op / 全 NULL 无 op / 金额不一致 / 待定 / 疑似 NULL / 台费疑似 /
     台费未知 / 台费孤儿 op / 配置不可用；
   - 只报不改（零写；单测钉死）。
2. 指标（按玩法 10 个 gauge + truncated/runs/last_success）：
   `orphan_ops` / `missing_ops` / `null_no_op` / `amount_mismatch` / `pending` /
   `null_money_delta` / `entry_fee_suspect` / `entry_fee_unknown` / `entry_fee_orphan_ops` /
   `config_unavailable` + `truncated` + `runs_total` + `last_success_timestamp_seconds`
   （前缀 `currency_records_reconcile_`）。
3. 告警 3 条（35 → 38 条，32 → 35 类）：`RecordsReconcileMismatch`(warning)、
   `RecordsReconcileOrphanOps`(critical)、`RecordsReconcileStalled`(warning)；
   **YAML 一律 `labels.severity` + `annotations.summary/runbook`**，`verify-monitoring.mjs` 加
   结构断言（severity 必须在 labels 下），slice-16 的 promtool 继续做语法闸。
4. 管理端：GET 加性 `records` 状态；POST 在既有对账成功后独立跑 records，records 失败/在跑
   以 `records:{error|skipped}` 返回 200，**不阻塞既有手动对账**；财务面板加性展示。
5. 测试/conformance：新服务/配置/admin/指标单测；`slice-35`（真栈含分页/0 行/跨界/台费；
   20k 行在 unit 基准 + 权威轮按时间预算补跑）。

### 2.2 不做

- 不自动修复/不改钱/不重发结算/不补记录。
- 不新增表/列/迁移/配置键；不改协议/客户端。
- 不重做既有 ReconcileService；不改其循环/指标。
- 不读 room Redis；用时间余量表达 pending。
- 不做每日聚合报表；不新增手动 records 路由（复用现有 run）。
- 不改 `recordmoney:outbox` TTL。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 新 `RecordsReconcileService`，事务 RR + keyset 分页 + 复用 admin run | 隔离既有测试面；一致快照；可控内存；独立失败 | 多一个 1h 循环；admin 响应加性 |
| B | 扩展现有 ReconcileService | 少一个循环 | 既有「恰 N 条直读」断言全改；耦合 |
| C | 每日离线 SQL | 简单 | 无法逐笔定位；告警天级 |

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 新服务（currency-service，只读 DataSource） | 同库只读；隔离既有对账 |
| D2 | 复用 `currency.reconcileIntervalMs`；首跑 10s；自调度/关停闸/`inFlight` | 不新增键 |
| D3 | 目标窗 `[to-48h,to)`；`to=now`；查询 `[from-24h,to+24h)`，只统计自身时间在目标窗的条目 | 防跨表边缘假孤儿/假缺失 |
| D4 | op→record：op 年龄 **<25h** ⇒ pending；≥25h ⇒ orphanOps | C1 outbox 24h + 1h 余量 |
| D5 | record→op：仅 gold、记录年龄 >**2h**：非零 money_delta ⇒ missingOps；**全 NULL ⇒ nullNoOp**；全 0 ⇒ 跳过 | settle 1h + 1h；全 NULL 不静默 |
| D6 | money_delta NULL：op 年龄 ≤**2h** ⇒ pending；>2h ⇒ nullMoneyDelta | recordmoney 1h + 1h |
| D7 | flow.delta 精确等于 money_delta；owner 映射 user_id/robot_id；无玩家行/非零 delta 无 flow ⇒ amountMismatch | 流水是唯一事实 |
| D8 | 符号/幅度：`>0 ⇒ score_change ≥ delta`；`<0 ⇒ score_change ≤ delta`；符号相反 ⇒ mismatch | 截断/抽水 |
| D9 | 守恒：全部非 NULL 且 burn 两列非 NULL ⇒ `Σ + residue + rake === 0`；否则跳过 | 历史 burn NULL |
| D10 | 台费：有 op ⇒ 以流水为历史事实（恰一条、owner 匹配、delta<0），**不按当前费率反推金额**；有 skip ⇒ 通过；都无：`percents=null` ⇒ configUnavailable；fee>0 ⇒ entryFeeSuspect；fee=0/档位缺失 ⇒ **entryFeeUnknown**（盲区可见，不进 Mismatch 告警） | 当前配置不能反推历史；fee=0 不静默 |
| D11 | 台费 op 无记录：op 年龄 >**25h** ⇒ entryFeeOrphanOps；≤25h ⇒ pending；有记录但 owner 非真人座/记录非 gold ⇒ amountMismatch | 与 D4 对齐（entry_fee 开局、record outbox 局终） |
| D12 | 有记录时以记录表玩法为准（A2 旧 PDK op 标 ddz 不误报）；无记录用 op.game_type | 旧 backfill 兼容 |
| D13 | `recordsByKey` 用 `gameType:room:version`；settle op 按 room:version 查找（优先同玩法，唯一时兼容旧标签） | ddz/pdk 同 key 不覆盖 |
| D14 | 只读事务显式 **REPEATABLE READ**；会话 `max_execution_time=30000`/`lock_wait_timeout=30`/`innodb_lock_wait_timeout=30`，finally 复位 DEFAULT；轮级 60s 超时 | 一致快照 + 会话复位 + 卡查询可收敛 |
| D15 | keyset 分页：ops/flows/records/skips 各按 id 升序、每页 5000、单查询总行 ≤200k；超限 ⇒ TruncatedError + `truncated=1` + 整轮失败（last_success 不推进、下轮照排） | 20k 硬失败会永久失明；分页 + 明确上限 |
| D16 | 管理端：GET 加性 `records`；POST 只对**既有** `inFlight` 409；既有成功后：records 在跑 ⇒ `records:{skipped:'running'}`（200），失败 ⇒ `records:{error}`（200），成功 ⇒ result | records 不阻塞既有工具 |
| D17 | 无 DB 迁移/配置键/协议；回滚 = revert | 最小面 |
| D18 | 部署顺序 user-service 迁移先于 currency-service；缺表 1146 ⇒ 整轮失败 + Stalled + 明确日志 | 部署事故可见 |
| D19 | 保留期只读 48h；20k 行/10k 基准在 plan + unit；slice-35 真栈含分页/0 行/跨界 | 用户裁决；性能可验 |
| D20 | 真栈 `slice-35` 注入 ddz/pdk/0 行/跨界/孤儿/缺失/全 NULL/金额/台费/分页（5,001 ops 两页）；baselines 只进 full；本机 Docker 不可用 ⇒ 待权威轮 | 真 SQL 必须有真栈证据 |

## 5. 实现设计

### 5.1 服务骨架

文件：`src/reconcile/records-reconcile.service.ts`（新）、`records-reconcile.sql.ts`（新）、
`app.module.ts`、`admin/admin-finance.controller.ts`、`config/config-cache.service.ts`、
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
`inFlight`、`runWithTrace` 一层/轮）；`runOnce(pageSize = PAGE_SIZE)`（测试可传小页）。
轮末一条摘要日志；异常类别聚合（样例 room/version），不逐条。

### 5.2 SQL、事务与分页

`records-reconcile.sql.ts` 导出 5 条 SQL（含 keyset 分页）；测试侧独立誊写并 `toBe`。
参数次序：`[from,to,lastId,pageSize]`（skips 同形）。每条 SQL 末 `ORDER BY id ASC LIMIT ?`。

```sql
-- OPS
SELECT o.id, o.action_id, o.ref_id, o.source, o.game_type, o.created_at, o.burned_residue, o.burned_rake
FROM currency_ops o
WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ? AND o.id > ?
ORDER BY o.id ASC LIMIT ?;
-- FLOWS
SELECT f.id, f.op_id, f.owner_id, f.owner_type, f.delta
FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id
WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ? AND f.id > ?
ORDER BY f.id ASC LIMIT ?;
-- DDZ
SELECT r.id AS record_id, r.room_code, r.game_version, r.mode, r.base_score, r.ended_at,
       p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change
FROM game_records r JOIN game_record_players p ON p.record_id = r.id
WHERE r.ended_at >= ? AND r.ended_at < ? AND r.id > ?
ORDER BY r.id ASC LIMIT ?;
-- PDK（同形）
-- SKIPS（加 s.id）
SELECT s.id, s.room_code, s.owner_id
FROM currency_entry_fee_skips s
WHERE s.created_at >= ? AND s.created_at < ? AND s.id > ?
ORDER BY s.id ASC LIMIT ?;
```

- 事务：`dataSource.transaction('REPEATABLE READ', async manager => { SET 三个会话变量; 分页循环5条; })`；
  finally 逐条 `SET SESSION ... = DEFAULT`（连接回池不继承）。
- 分页：每查询 loop `lastId=0`；每页满则取最后 id；总行 >200k ⇒ `TruncatedError`（设置
  `truncated=1` gauge + ERROR），整轮失败。
- 轮级 60s：`withTimeout(transaction, 60s)`；超时 ⇒ `RecordsReconcileTimeoutError`、inFlight
  清、下轮照排；MySQL 的 max_execution/lock_wait 兜住卡查询。
- 行时间归一：ddz Date/字符串 ⇒ `toEpochMs`；pdk BIGINT ⇒ `Number()`；非有限 ⇒ 该行 mismatch + ERROR。
- 缺表 1146 ⇒ 整轮失败，日志指部署顺序。

### 5.3 判定

同 v2，但：

**A. record→op**：目标窗内 gold 记录；无 op 时 `age = now - endedAt`：
- ≤2h ⇒ pending；
- 非零 money_delta ⇒ missingOps；
- 任一 NULL 且无非零 ⇒ nullNoOp；
- 全 0 ⇒ 跳过。

**B. game_settle op**：目标窗内；无记录 <25h pending / ≥25h orphan；有记录做 flow/符号/守恒检查；
记录非 gold ⇒ mismatch；每个异常按 record/op 去重。

**C. entry_fee**：
- 记录真人座：op ⇒ 恰一条 flow、owner 匹配、delta<0（否则 mismatch），不比较当前费额；skip ⇒ 通过；
  都无 ⇒ `percents = configCache.entryFeePercents(gameType)`：
  - `null` ⇒ configUnavailable=1，跳过；
  - `fee = entryFeeOf(baseScore, percents)`；fee>0 ⇒ entryFeeSuspect；fee=0（含档位缺失）⇒ entryFeeUnknown；
- entry_fee op：actionId 畸形 ⇒ mismatch；无记录 >25h ⇒ entryFeeOrphanOps；≤25h ⇒ pending；
  有记录但 owner 非该房真人座 ⇒ mismatch。

**D. 计数/指标**：按 item 去重；byGame 含 configUnavailable；轮末 set 所有 gauge（含 0）、
`truncated`（成功轮 0）、last_success。

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

HELP：只报不改；pending 诊断；entry_fee_suspect 按当前费率推断、unknown 是「当前费率为 0/档位
缺失、无法判断历史」的盲区；truncated=1 表示单查询超 20 万行、本轮失败。
last_success 启动 0；gauge 每轮 set（含 0，truncated 成功轮 0）。

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
  三条新规则块必须含 `labels:\n    severity:` 与 `annotations:\n    summary:`（防 severity 放错层）。
- slice-16/18/24 35→38；Dockerfile 38；ops 告警清单 +3；判别力自证。

### 5.6 管理端

- 注入 `RecordsReconcileService`（值导入）。
- GET：`{ ...reconcile.getStatus(), records: records.getStatus() }`。
- POST：若既有 `inFlight` ⇒ 409（既有行为）；跑既有；成功后：
  - records `running` ⇒ `{ ...existingResult, records: { skipped: 'running' } }`；
  - 跑 records 抛错 ⇒ `{ ...existingResult, records: { error: String(err) } }`；
  - 成功 ⇒ `{ ...existingResult, records: recordsResult }`。
  - 全程 200（除既有 409/既有失败）；**records 不阻塞既有手动对账**。
- admin `formatReconcileResult` 追加 records 可选链字段（孤儿/缺失/全NULL/金额/待定/疑似NULL/
  台费疑似/台费未知/台费孤儿/truncated），`?? 0`；`skipped/error` 显示文案；旧服务无 `records` 不崩。
- 状态区显示 records lastAttempt/lastSuccess/lastError（可选链）。
- `reconcile-admin.test.ts` / `admin-finance.test.ts` 更新 GET/POST 形状、records running/error、
  既有 409 不受 records 影响。

### 5.7 测试

`test/records-reconcile.test.ts`（新）：
- SQL 全文（含 id/ORDER/LIMIT/占位次序）；5 条查询同一事务、显式 RR、SET 三条先于首读、
  finally 复位；分页两页（pageSize=2）；总行 >200k（用 pageSize/常量注入或 fake 计数）⇒
  TruncatedError + truncated gauge + last_success 不推进；
- 一致局全 0；op 无记录 24h59m pending / 25h01m orphan；ref 畸形 mismatch；
- record 无 op：1h59m pending / 2h01m 非零 missing / 全 NULL nullNoOp / 全 0 跳过；
- NULL：1h59m pending / 2h01m nullMoneyDelta；
- flow/玩家/符号/幅度/守恒（burn NULL 跳过）；
- 台费：op 正路（不比当前费额）/skip/都无 fee>0 suspect/都无 fee=0 unknown/档位缺失 unknown/
  levels null ⇒ configUnavailable/op 无记录 24h59m pending、25h01m orphan/owner 非真人/mode 非 gold；
- 跨界：op 在 from、记录 from-1min ⇒ 不 orphan；记录 from、fee op from-1h ⇒ 不 missing；
- ddz/pdk 同 room:version 不覆盖；旧 PDK op 标 ddz、记录 pdk ⇒ 以记录为准；
- 事务/零写；轮次/关停/失败后下轮；会话复位；60s 超时（fake 挂起）⇒ inFlight 清、下轮可跑；
- 日志聚合；10k/20k 基准（plan 执行，记录耗时）。

`config-cache.test.ts`：`entryFeePercents` 返回 `[]`（合法空/全 0）vs `null`（缺失/非法）；
ddz 新键→旧 `game.baseScoreLevels`；pdk 新键；不改斗地主既有 getter。

`reconcile-admin.test.ts` / `admin-finance.test.ts`：GET `records`；POST records 成功/error/skipped；
既有 409 不被 records 阻塞；旧 admin 可选链。

### 5.8 conformance `slice-35-records-reconcile`

- 注入 RUN_TAG 唯一行：一致 ddz/pdk；孤儿 op（25h+）；gold 记录无 op（2h+，非零）；全 NULL 无 op；
  金额不一致；台费疑似；台费孤儿 op（25h+）；跨界（op 在窗起、记录 1min 前）；0 行玩法；
  **分页**：5,001 条一致 ops（两条页；用批量 INSERT ... SELECT 生成）确保不 truncated。
- `POST /api/admin/wallet/reconcile/run`；断言 `data.records` 与 9004 gauges：
  orphan/missing/nullNoOp/amountMismatch/entryFeeSuspect/entryFeeOrphanOps ≥1；跨界不计；
  `truncated=0`；`GET reconcile.records` 与 gauges 一致；`config_unavailable=0`。
- promtool 语法闸由 slice-16 负责；本片不重复。
- 零写：注入前后 DB 行数（本片 room/action 前缀）不变；收尾 DELETE 注入行。
- baselines 只进 full；本机 Docker 不可用 ⇒ 待权威轮；20k 行 unit 基准 + 权威轮按时间预算补跑。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| op 无记录 <25h | pending |
| op 无记录 ≥25h | orphanOps critical |
| gold 记录无 op ≤2h | pending |
| 记录无 op >2h + 非零 | missingOps |
| 记录无 op >2h + 全 NULL | nullNoOp |
| 记录无 op + 全 0 | 合法跳过 |
| money_delta NULL ≤2h | pending |
| NULL >2h | nullMoneyDelta |
| flow/玩家/符号/幅度/守恒 | amountMismatch |
| burn NULL | 跳过守恒 |
| 台费 op/skip | 通过（op 以流水为历史事实） |
| 都无 + fee>0 | entryFeeSuspect |
| 都无 + fee=0/档位缺失 | entryFeeUnknown（盲区，单独 gauge） |
| levels 缺失/非法 | configUnavailable=1，跳过台费 |
| 台费 op 无记录 ≤25h / >25h | pending / entryFeeOrphanOps |
| ref/action 畸形 | amountMismatch |
| 查询抛/超时/超 20 万行/缺表 | 整轮失败；truncated=1 或 lastError；last_success 不推进；下轮照排 |
| 既有 inFlight | POST 409（既有语义） |
| records inFlight | POST 200 + `records:{skipped:'running'}` |
| records 失败 | POST 200 + `records:{error}` |
| 旧 admin/旧服务 | 可选链，不崩 |
| 数据量 | 48h+24h、分页 5000/上限 200k、30s/60s、索引；10k/20k 基准 |

## 7. 迁移与回滚

- 无 DB 迁移/配置键/协议/表结构；回滚 = revert；无残留。
- 部署顺序：user-service（记录表）→ currency-service；缺表 1146 整轮失败 + Stalled。

## 8. 测试判据

1. 新服务/config/admin/指标单测全绿；currency-service 全量 + lint。
2. 全量 turbo（或分包证据 + 环境 flake 登记）；0 cached。
3. `verify-monitoring.mjs` 38/35 + 新规则结构断言；判别力自证。
4. conformance 静态：slice-16/18/24 35→38；tsc/lint；slice-35 注册/基线（full 列）。
5. `pnpm verify:admin` 通过。
6. 真栈 slice-35 待权威轮；20k unit 基准读数入报告。
7. 工作区干净；diff 不含协议/DB 迁移/slice-29/PdkSettlement.vue。

## 9. 涉及文件

生产：`reconcile/records-reconcile.service.ts`（新）、`records-reconcile.sql.ts`（新）、
`app.module.ts`、`admin/admin-finance.controller.ts`、`config/config-cache.service.ts`、
`metrics/currency.metrics.ts`、`admin/app.js`。
监控/文档：`ftl-alerts.yml`、`verify-monitoring.mjs`、`Dockerfile.prometheus`、
`docs/ops/first-deploy.md`、C2 spec/plan。
测试/conformance：`test/records-reconcile.test.ts`（新）、`test/reconcile-admin.test.ts`、
`test/admin-finance.test.ts`、`test/config-cache.test.ts`、`test/helpers/fake-currency-db.ts`、
`slice-35-records-reconcile.ts`（新）、`run.ts`、`baselines.json`、`slice-16/18/24`。

## 10. 审查记录

### 10.1 首轮（2026-10-26）

3 阻断 / 6 高 / 5 低；处置见 v2 §10（全 NULL、窗口配对、台费历史、25h/2h、entry_fee 分支、
admin 解耦、事务快照、超时/行数、真栈、gameType key、A2 backfill、config gauge、缺表）。

### 10.2 v2 delta（2026-10-26）→ v3

| # | 级别 | 发现 | v3 处置 |
|---|---|---|---|
| 新-1 | 高 | entry_fee orphan 24h 与 D4/outbox 25h 矛盾 | D11/常量改为 25h；补 24h59m/25h01m 用例 |
| 新-2 | 高 | 当前 fee=0 盲区；`null/[]` 契约矛盾 | D10：fee>0 ⇒ suspect；fee=0/档位缺失 ⇒ **entryFeeUnknown**（独立 gauge）；`null`=缺失/非法、`[]`=合法空；补用例 |
| 新-3 | 高 | 20k 硬失败会永久失明 | D15/§5.2：keyset 分页 5000/页、总上限 200k、TruncatedError+gauge；20k/10k 基准入 plan/验收；slice-35 5,001 ops 两页 |
| 新-4 | 高 | 会话变量残留/无 RR 显式/无轮级超时 | D14/§5.2：显式 REPEATABLE READ、三条 SET + finally 复位、60s 轮级超时 |
| 新-5 | 高 | records running 阻塞既有手动对账 | D16/§5.6：只对既有 inFlight 409；records running ⇒ 200 `{skipped}` |
| 新-6 | 高 | 告警 YAML severity 层级错 | §5.5：`labels.severity` + `annotations`；verify-monitoring 加结构断言 |
| 低 3 | 低 | §5.7 `null/[]` 表述矛盾 | 已钉死；补 config-cache 测试 |
| 低 8 | 低 | config_unavailable 展示 | byGame/config gauge + admin 字段 |
| 低 9 | 低 | 真栈 20k 缺口 | unit 20k + slice-35 5,001 分页；权威轮按预算补 20k |

### 10.3 进入 plan

v3 已闭合两轮发现；plan 对抗审查再核对实现可执行性/测试判别力。

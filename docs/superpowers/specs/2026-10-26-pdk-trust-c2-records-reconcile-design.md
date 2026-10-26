# C2 资金 ↔ 记录对账设计（v2，RecordsReconcileService）

> 日期：2026-10-26 · 状态：已按首轮对抗审查修订（待 delta 复审） · 流程：`docs/dev-process.md`
> 上级：`docs/superpowers/specs/2026-10-26-pdk-trust-c-overview-design.md`
> 用户裁决：U4 逐笔结算 op + 48h 滚动窗、每 1h 一轮；U5 只告警/报告，不自动改钱；U10 保留期沿用 365 天。
> 依赖：C1（record outbox 24h；`recordmoney:outbox` 1h）。审查记录见 §10（3 阻断 / 6 高 / 5 低）。

## 1. 背景与问题

`currency_ops`（`source=game_settle` / `entry_fee`）与 `game_records(_pdk)`、
`game_record_players(_pdk)` 之间没有对账。现有 `ReconcileService` 只做余额↔流水、缓存、
孤儿赠送、机器人池；不读对局记录。后果：钱已结算但记录不存在 / 记录存在但 op 不存在 /
`money_delta` 与流水不一致 / `money_delta` 永久 NULL / 台费缺失，均不可见。

所有服务共库 `fight_the_landlord`，currency-service 可只读 JOIN 记录表，无需跨服务 RPC。

## 2. 范围

### 2.1 做

1. 新增 `RecordsReconcileService`：
   - 复用 `currency.reconcileIntervalMs`（不新增键）；启动 10s 首跑、1h 一轮、自调度＋关停闸＋`inFlight`；
   - **只读事务一致快照**（InnoDB 默认 REPEATABLE READ；事务内 `SET SESSION max_execution_time=30000`）；
   - 目标窗口 `[to-48h, to)`；查询两侧各加 **24h 配对余量**，只统计自身时间落在目标窗口内的条目；
   - 判定：孤儿 op / 缺失 op / 全 NULL 无 op / 金额不一致 / 待定 / 疑似 NULL / 台费疑似缺失 /
     台费孤儿 op / 配置不可用；
   - 只报不改（零写；单测以「库零写」钉死）；任一查询失败/超 20k 行/超时 ⇒ 整轮失败、下轮照排。
2. 新指标（按玩法 9 个 gauge + 2 个无标签）：
   `orphan_ops` / `missing_ops` / `null_no_op` / `amount_mismatch` / `pending` /
   `null_money_delta` / `entry_fee_suspect` / `entry_fee_orphan_ops` / `config_unavailable`
   + `runs_total` + `last_success_timestamp_seconds`（前缀 `currency_records_reconcile_`）。
3. 告警 3 条（35 → 38 条，32 → 35 类）：`RecordsReconcileMismatch`(warning)、
   `RecordsReconcileOrphanOps`(critical)、`RecordsReconcileStalled`(warning)。
4. 管理端：`GET /api/admin/wallet/reconcile` **加性**返回 `records` 状态；
   `POST .../reconcile/run` 在既有对账成功后**独立**跑记录对账，records 失败以
   `records: { error }` 返回（不把既有工具拖成 500）；财务面板加性展示。
5. 测试：新服务单测（SQL 全文、假 DB 真语义、跨表跨界、全 NULL、台费、事务/零写、行数上限）、
   admin/config-cache 单测、告警计数同步、conformance `slice-35`（真栈待权威轮）。

### 2.2 不做

- 不自动修复/不改钱/不重发结算/不补记录。
- 不新增表/列/迁移/配置键；不改协议/客户端。
- 不重做既有 `ReconcileService` 三检查；不改其循环/指标。
- 不读 room Redis（C1 outbox 不可见）；用时间余量表达 pending。
- 不做每日聚合报表；不新增手动 records 端点（复用现有 run）。
- 不改 `recordmoney:outbox` TTL。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 新 `RecordsReconcileService`，复用间隔/admim 端点，事务一致快照 | 隔离既有测试面；独立失败/状态；职责清晰 | 多一个 1h 循环；admin 响应加性 |
| B | 扩展现有 `ReconcileService` | 少一个循环 | 既有「恰 N 条直读」断言全改；窗口/失败语义耦合 |
| C | 每日离线 SQL | 简单 | 无法逐笔定位；告警延迟天级 |

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 新服务 `RecordsReconcileService`（currency-service，只读 DataSource） | 同库只读；隔离既有对账 |
| D2 | 复用 `currency.reconcileIntervalMs`；首跑 10s；自调度/关停闸/`inFlight` | 不新增键 |
| D3 | 目标窗 `[to-48h,to)`；`to=now` 固定；查询两侧各加 24h 余量，只统计自身时间在目标窗的条目 | 防 op/record/fee 跨表在窗口边缘假孤儿/假缺失（阻断 2） |
| D4 | op→record：op 年龄 **<25h** 无记录 ⇒ pending；≥25h ⇒ orphanOps | C1 outbox 24h + 1h 余量（高 4） |
| D5 | record→op：仅 gold、记录年龄 >**2h**：有非零 money_delta ⇒ missingOps；**全 NULL ⇒ nullNoOp**；全 0 ⇒ 跳过 | settle outbox 1h + 1h 余量；全 NULL 不能静默（阻断 1） |
| D6 | money_delta NULL：op 年龄 ≤**2h** ⇒ pending；>2h ⇒ nullMoneyDelta | recordmoney 1h + 1h 余量（高 4） |
| D7 | 每座 `flows.delta` 精确等于 `money_delta`；owner 映射 user_id/robot_id；无玩家行/有非零 delta 无 flow ⇒ amountMismatch | 流水是钱的唯一事实 |
| D8 | 符号/幅度：`money_delta>0 ⇒ score_change ≥ money_delta`；`<0 ⇒ score_change ≤ money_delta`；符号相反 ⇒ amountMismatch | 截断/抽水，不做等值 |
| D9 | 守恒：全部 money_delta 非 NULL 且 op 的 burn 两列非 NULL ⇒ `Σmoney_delta + residue + rake === 0`；否则跳过 | 历史 op burn NULL 不可判 |
| D10 | 台费：有 `entryfee:<room>:<owner>` op ⇒ 以流水为历史事实（恰一条、owner 匹配、delta<0），**不按当前费率反推金额**；有 skip 行 ⇒ 通过；两者都无且当前费率>0 ⇒ `entryFeeSuspect`（配置依赖）；levels 缺失/非法 ⇒ `configUnavailable=1` 跳过 | 阻断 3：当前配置不能反推历史费用 |
| D11 | 台费 op 无记录：op 年龄 >24h ⇒ `entryFeeOrphanOps`；≤24h ⇒ pending；记录存在但 owner 不是该房真人座/记录非 gold ⇒ amountMismatch | 高 5：覆盖 entry_fee op 分支 |
| D12 | op.game_type 与记录不符：**以记录表为准**（A2 回填把旧 PDK op 标成 doudizhu）；仅无记录时用 op.game_type | 低 12：旧 PDK op 不误报 |
| D13 | `recordsByKey` 以 `gameType:room:version` 分桶；settle op 按 room:version 查找（优先同玩法，唯一时兼容旧标签） | 低 11：ddz/pdk 同 key 不互相覆盖 |
| D14 | 只读事务一致快照：`dataSource.transaction` 内跑 5 条 SQL（InnoDB 默认 RR）；`SET SESSION max_execution_time=30000`；任一查询 >20k 行 ⇒ `TruncatedError` 整轮失败 | 高 7/8：跨表非原子与慢查询 |
| D15 | 查询失败/超时/超行 ⇒ 整轮失败（last_success 不推进、lastError、`inFlight` finally 清、下轮照排） | 失败可见，不静默部分结果 |
| D16 | 管理端：GET 加性 `records`；POST 先跑既有（行为不变），成功后独立跑 records；records 抛错 ⇒ 200 + `records:{error}` | 高 6：不拖垮既有工具 |
| D17 | 无 DB 迁移/配置键/协议；回滚 = revert；CSV/ops/summary 读口不变 | 最小面 |
| D18 | 部署顺序：user-service 迁移（记录表）先于 currency-service；缺表（1146）⇒ 整轮失败 + Stalled + 明确日志 | 低 14 |
| D19 | 保留期只读 48h；不新增保留期；10k/20k 行基准在 plan；行数上限 20k | 用户裁决 U10；防慢查询 |
| D20 | 真栈 `slice-35-records-reconcile`：注入 ddz/pdk/0 行/跨界/孤儿/缺失/金额/台费，跑 admin run 断言；baselines 只进 full；本机 Docker 不可用 ⇒ 待权威轮 | 高 9 |

## 5. 实现设计

### 5.1 服务与状态

文件：`src/reconcile/records-reconcile.service.ts`（新）、`records-reconcile.sql.ts`（新）、
`app.module.ts`（provider）、`admin/admin-finance.controller.ts`、`config/config-cache.service.ts`、
`metrics/currency.metrics.ts`、`admin/app.js`。

```ts
export interface RecordsReconcileCounts {
  orphanOps: number; missingOps: number; nullNoOp: number; amountMismatch: number;
  pending: number; nullMoneyDelta: number; entryFeeSuspect: number; entryFeeOrphanOps: number;
  configUnavailable: 0 | 1;
}
export interface RecordsReconcileRoundResult extends RecordsReconcileCounts {
  byGame: { doudizhu: RecordsReconcileCounts; paodekuai: RecordsReconcileCounts };
}
export interface RecordsReconcileStatus {
  lastAttemptAt: number | null; lastSuccessAt: number | null;
  lastResult: RecordsReconcileRoundResult | null; lastError: string | null; running: boolean;
}
```

阈值常量：
`TARGET_WINDOW_MS=48h`、`PAIR_MARGIN_MS=24h`、`ORPHAN_GRACE_MS=25h`、
`OP_GRACE_MS=2h`、`NULL_GRACE_MS=2h`、`ENTRY_FEE_ORPHAN_GRACE_MS=24h`、
`ROW_CAP=20000`、`QUERY_TIMEOUT_MS=30_000`。

循环形态逐字照 `ReconcileService`（`onModuleInit` 置 last_success=0、首跑 10s、自重排现读、
关停闸、`inFlight`、`runWithTrace` 一层/轮）；轮末一条摘要日志，异常类别各一条聚合日志
（样例 room/version），不逐条刷屏。

### 5.2 SQL 与事务

`records-reconcile.sql.ts` 导出 5 条 SQL；测试侧独立誊写并 `toBe`。窗口参数：
`from = to-48h`、`marginFrom = from-24h`、`marginTo = to+24h`；查询用 `marginFrom/marginTo`，
统计时过滤自身时间在 `[from,to)`。每条 SQL 末尾 `LIMIT 20001`（超 20000 行 ⇒ 整轮失败）。

```sql
-- OPS
SELECT o.id, o.action_id, o.ref_id, o.source, o.game_type, o.created_at, o.burned_residue, o.burned_rake
FROM currency_ops o
WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ?
LIMIT 20001;

-- FLOWS
SELECT f.op_id, f.owner_id, f.owner_type, f.delta
FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id
WHERE o.source IN ('game_settle','entry_fee') AND o.created_at >= ? AND o.created_at < ?
LIMIT 20001;

-- DDZ records+players
SELECT r.id AS record_id, r.room_code, r.game_version, r.mode, r.base_score, r.ended_at,
       p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change
FROM game_records r JOIN game_record_players p ON p.record_id = r.id
WHERE r.ended_at >= ? AND r.ended_at < ?
LIMIT 20001;

-- PDK records+players
SELECT r.id AS record_id, r.room_code, r.game_version, r.mode, r.base_score, r.ended_at,
       p.user_id, p.is_robot, p.robot_id, p.money_delta, p.score_change
FROM game_records_pdk r JOIN game_record_players_pdk p ON p.record_id = r.id
WHERE r.ended_at >= ? AND r.ended_at < ?
LIMIT 20001;

-- entry fee skips
SELECT s.room_code, s.owner_id
FROM currency_entry_fee_skips s
WHERE s.created_at >= ? AND s.created_at < ?
LIMIT 20001;
```

- 事务：`this.dataSource.transaction(async (manager) => { await manager.query('SET SESSION max_execution_time = 30000'); ...5 queries... })`。
  InnoDB 默认 REPEATABLE READ ⇒ 事务内一致快照；`SET` 在首读前执行。
- 每条结果 >20000 行 ⇒ 抛 `RecordsReconcileTruncatedError`；查询/`SET` 抛 ⇒ 整轮失败。
- ddz `ended_at`/`created_at` 由驱动回 Date/字符串 ⇒ `toEpochMs`；pdk `ended_at` BIGINT ⇒ `Number()`；
  非有限 ⇒ 该行计入 `amountMismatch` 并 ERROR。
- 缺表 1146 ⇒ 整轮失败，日志明确「user-service 迁移未上」；runbook 部署顺序。

### 5.3 判定

构建：`settleOpsByRoomVersion: Map<"room:version", OpRow[]>`、
`entryFeeOpsByAction: Map<actionId, OpRow>`、`flowsByOp`、`recordsByKey: Map<"gameType:room:version", RecordAgg>`、
`skips: Set<"room:owner">`。

**A. record→op（gold）**：对目标窗内每条记录：
- 找 settle op：优先 `gameType:room:version`；否则 room:version 唯一 op（兼容旧 backfill 标签）。
- 无 op：`age = now - endedAt`；
  - ≤2h ⇒ pending；
  - 有任一 `money_delta` 非 NULL 非 0 ⇒ missingOps；
  - **有任一 NULL 且无任何非零** ⇒ nullNoOp；
  - 全 0 ⇒ 跳过。
- 有 op：进入 B（按 op id 去重）。

**B. game_settle op**：对目标窗内每个 op：
- ref_id 解析 room/version；失败 ⇒ amountMismatch。
- 无记录：age = now - createdAt；<25h ⇒ pending；≥25h ⇒ orphanOps。
- 有记录：
  - 记录 mode 非 gold ⇒ amountMismatch；
  - flows 逐条：owner 映射 user_id/robot_id；无玩家行 ⇒ amountMismatch；
  - `money_delta` NULL：op age ≤2h ⇒ pending；>2h ⇒ nullMoneyDelta；
  - flow.delta !== money_delta、符号/幅度、非零 delta 无 flow、flow owner 不在玩家行 ⇒ amountMismatch；
  - 守恒（D9）⇒ amountMismatch；
  - 每个异常类别按 record/op 去重计数；样例日志含 room/version/seat。

**C. entry_fee**：
- 对每条 gold 记录、每个真人座：
  - op = `entryfee:<room>:<owner>`；skip = `(room,owner)`；
  - op：flows 必须恰一条、owner 匹配、delta<0（否则 amountMismatch）；记录非 gold 另计 amountMismatch；
  - skip：通过；
  - 都无：`percents = configCache.entryFeePercents(gameType)`；
    - null ⇒ configUnavailable=1（该玩法），跳过；
    - `fee = entryFeeOf(baseScore, percents)`；fee>0 ⇒ entryFeeSuspect；fee=0 跳过；
  - **不拿当前 fee 与历史 op 金额比较**；op 金额以流水为历史事实。
- 对每个 entry_fee op：解析 actionId；畸形 ⇒ amountMismatch；
  - 无对应记录：op age >24h ⇒ entryFeeOrphanOps；≤24h ⇒ pending；
  - 有记录但 owner 不是该房真人座 ⇒ amountMismatch。

**D. 计数/指标**：每个异常按 item 去重；`byGame` 与 gauge 按记录表/无记录时 op.game_type 分桶；
`configUnavailable` 每玩法 0/1；轮末 set 全部 gauge（含 0）与 `last_success`。

### 5.4 指标（`currency.metrics.ts`）

```
currency_records_reconcile_orphan_ops{game_type}
currency_records_reconcile_missing_ops{game_type}
currency_records_reconcile_null_no_op{game_type}
currency_records_reconcile_amount_mismatch{game_type}
currency_records_reconcile_pending{game_type}
currency_records_reconcile_null_money_delta{game_type}
currency_records_reconcile_entry_fee_suspect{game_type}
currency_records_reconcile_entry_fee_orphan_ops{game_type}
currency_records_reconcile_config_unavailable{game_type}
currency_records_reconcile_runs_total
currency_records_reconcile_last_success_timestamp_seconds
```

HELP 写明「只报不改」「pending 是诊断桶」「entry_fee_suspect 按当前档位费率推断、非历史证据」；
last_success 启动置 0；gauge 每轮 set（含 0）。

### 5.5 告警（38 条 / 35 类）

```yaml
- alert: RecordsReconcileMismatch
  expr: 'sum by (game_type) (currency_records_reconcile_amount_mismatch + currency_records_reconcile_missing_ops + currency_records_reconcile_null_no_op + currency_records_reconcile_null_money_delta + currency_records_reconcile_entry_fee_suspect + currency_records_reconcile_entry_fee_orphan_ops) > 0'
  for: 15m
  severity: warning
- alert: RecordsReconcileOrphanOps
  expr: 'sum by (game_type) (currency_records_reconcile_orphan_ops) > 0'
  for: 10m
  severity: critical
- alert: RecordsReconcileStalled
  expr: 'time() - currency_records_reconcile_last_success_timestamp_seconds > 7200'
  for: 10m
  severity: warning
```

- `config_unavailable` 不进 Mismatch（配置缺失是诊断面，单独 gauge；可在 runbook 看）。
- 头部 38/35；verify-monitoring EXPECTED +3、谓词、头注释；slice-16/18/24 35→38；
  Dockerfile 38；ops 告警清单 +3；判别力自证。

### 5.6 管理端

- `AdminFinanceController` 注入 `RecordsReconcileService`（值导入）。
- `GET /api/admin/wallet/reconcile`：`{ ...reconcile.getStatus(), records: records.getStatus() }`。
- `POST /api/admin/wallet/reconcile/run`：
  1. 两个服务任一 `running` ⇒ 409 借 10001（预检，避免半执行）；
  2. 跑既有 `runReconcileOnce()`（行为不变；其 inFlight/错误照旧）；
  3. 成功后跑 records `runOnce()`；records 抛错 ⇒ catch，返回
     `{ ...existingResult, records: { error: String(err) } }`（200；不把既有工具拖成 500）；
  4. records 成功 ⇒ `{ ...existingResult, records: recordsResult }`。
- `admin/app.js` `formatReconcileResult` 追加 `records` 可选链字段（孤儿/缺失/全NULL/金额/待定/
  疑似NULL/台费疑似/台费孤儿），`?? 0`；状态区显示 `d.records` 的 lastAttempt/lastSuccess/lastError
  （旧服务无 `records` ⇒ 不渲染，不崩）。
- 现有 `reconcile-admin.test.ts` 的 GET/POST 精确形状补 `records`；inFlight 用例覆盖两服务预检。

### 5.7 测试

`test/records-reconcile.test.ts`（新）：
- SQL 全文（含 LIMIT/占位次序）；5 条查询在同一 `transaction` 内、`SET max_execution_time` 先于首读；
- 一致局全 0；op 无记录 24h59m ⇒ pending、25h01m ⇒ orphan；ref 畸形 ⇒ mismatch；
- record 无 op：1h59m ⇒ pending、2h01m + 非零 ⇒ missingOps、全 NULL ⇒ nullNoOp、全 0 ⇒ 全 0；
- money_delta NULL：1h59m ⇒ pending、2h01m ⇒ nullMoneyDelta；不重复计 mismatch；
- flow 不等/无玩家行/非零 delta 无 flow/owner 不在玩家 ⇒ mismatch；
- 符号/幅度/守恒（含 burn NULL 跳过）⇒ mismatch；
- 台费：op 正路（不按当前费率比较）、skip 正路、都无 + fee>0 ⇒ suspect、fee=0 跳过、
  levels null/非法 ⇒ configUnavailable 且不 suspect、op 无记录 24h+ ⇒ entryFeeOrphanOps、
  op owner 非真人座/记录非 gold ⇒ mismatch；
- **跨表跨界**：op 在 `from`、记录在 `from-1min` ⇒ 不 orphan；记录在 `from`、fee op 在
  `from-1h` ⇒ 不 missing；目标窗外条目不计；
- ddz/pdk 同 `room:version` 不互覆盖；旧 PDK op 标 doudizhu、记录 pdk ⇒ 以记录为准不误报；
- 事务/零写：`txLog` 无写语句；`directQueries` 不被使用（全部经 manager）；库行数不变；
- 轮次：runs+1、last_success 0/set/失败不 set、inFlight、关停闸、失败后下轮照排；
- 行数上限：20,001 行 ⇒ 整轮失败 + Truncated 日志；10k 基准记录耗时（plan 执行）；
- 日志聚合：一轮摘要 + 类别聚合，不逐条。

`test/config-cache.test.ts`：`entryFeePercents` ddz（新键→旧 `game.baseScoreLevels`）/pdk/缺失/
非法 ⇒ null/[]；不改斗地主既有 getter。

`test/reconcile-admin.test.ts` / `admin-finance.test.ts`：GET 加性 `records`；POST 成功/records
失败 `{error}`/双 running 409/既有失败原样；旧 admin 可选链。

`test/app.module`/wiring：provider 可解析；`RecordsReconcileService` 注入 controller。

### 5.8 conformance `slice-35-records-reconcile`

- 注入（RUN_TAG 唯一 room/action_id）：
  1. 一致：`game_settle` op + flow + ddz 记录/玩家（money_delta 匹配、burn 匹配）；
  2. 孤儿：op 25h 前、无记录；
  3. 缺失：gold 记录 2h 前、非零 money_delta、无 op；
  4. 全 NULL 无 op：gold 记录 2h 前、money_delta NULL；
  5. 金额不一致：flow ≠ money_delta；
  6. 台费疑似：gold 记录 + 真人座、无 fee op/skip、档位 fee>0；
  7. 台费孤儿：entry_fee op 25h 前、无记录；
  8. 跨界：op 在窗口起点、记录 1min 前 ⇒ 不计孤儿；
  9. pdk 一致行 + 0 行玩法（空表）不误报。
- `POST /api/admin/wallet/reconcile/run`；断言 `data.records` 与 gauges（`/metrics` 9004）：
  orphan≥1、missing≥1、nullNoOp≥1、amountMismatch≥1、entryFeeSuspect≥1、entryFeeOrphanOps≥1；
  跨界不计；`GET reconcile` 的 `records` 与 gauges 一致；
- 零写：注入前后 `currency_accounts`/`currency_flows` 行数与本片 room 过滤不变；
- 收尾 DELETE 本片注入行；baselines 只进 full；本机 Docker 不可用 ⇒ 待权威轮。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| op 无记录 <25h | pending |
| op 无记录 ≥25h | orphanOps critical |
| gold 记录无 op ≤2h | pending |
| 记录无 op >2h + 非零 delta | missingOps |
| 记录无 op >2h + 全 NULL | nullNoOp（不静默） |
| 记录无 op + 全 0 | 合法，跳过 |
| money_delta NULL ≤2h | pending |
| NULL >2h | nullMoneyDelta |
| flow/玩家/符号/幅度/守恒 | amountMismatch |
| burn NULL | 跳过守恒 |
| 台费 op/skip | 通过（op 以流水为历史事实） |
| 台费都无 + 当前 fee>0 | entryFeeSuspect（配置依赖） |
| 台费 op 无记录 >24h | entryFeeOrphanOps |
| levels 缺失/非法 | configUnavailable=1 + 跳过台费 |
| ref/action 畸形 | amountMismatch |
| 查询抛/超时/超 20k 行/缺表 | 整轮失败；last_success 不推进、next 轮照排；缺表日志指部署顺序 |
| 两服务任一 inFlight | 手动 POST 409；records 定时跳过 |
| 旧 admin + 新服务 | `records` 缺失，UI 可选链 |
| 新 admin + 旧服务 | POST 无 `records` 返回（旧形状），UI 可选链 |
| 数据量 | 48h+24h 余量、行数上限、30s、索引；10k 基准 |

## 7. 迁移与回滚

- 无 DB 迁移/配置键/协议/表结构。
- 回滚 = revert；指标/告警/响应字段消失；无残留。
- 部署顺序：user-service（记录表迁移）→ currency-service；旧 currency-service 不读记录表，安全。

## 8. 测试判据

1. 新服务/config/admin/指标单测全绿；currency-service 全量 + lint。
2. 全量 turbo（或按包证据 + 环境 flake 登记）；0 cached。
3. `verify-monitoring.mjs` 38/35；判别力自证。
4. conformance 静态：slice-16/18/24 35→38；tsc/lint；slice-35 注册/基线（full 列）。
5. `pnpm verify:admin` 通过。
6. 真栈 slice-35 待权威轮（本机无 Docker）。
7. 工作区干净；diff 不含协议/DB 迁移/slice-29/PdkSettlement.vue。

## 9. 涉及文件

生产：`reconcile/records-reconcile.service.ts`（新）、`reconcile/records-reconcile.sql.ts`（新）、
`app.module.ts`、`admin/admin-finance.controller.ts`、`config/config-cache.service.ts`、
`metrics/currency.metrics.ts`、`admin/app.js`。
监控/文档：`ftl-alerts.yml`、`verify-monitoring.mjs`、`Dockerfile.prometheus`、
`docs/ops/first-deploy.md`、C2 spec/plan。
测试/conformance：`test/records-reconcile.test.ts`（新）、`test/reconcile-admin.test.ts`、
`test/admin-finance.test.ts`、`test/config-cache.test.ts`、`test/helpers/fake-currency-db.ts`、
`slice-35-records-reconcile.ts`（新）、`run.ts`、`baselines.json`、`slice-16/18/24`。

## 10. 审查记录

首轮独立审查（2026-10-26）：3 阻断 / 6 高 / 5 低。处置：

| # | 级别 | 发现 | v2 处置 |
|---|---|---|---|
| 1 | 阻断 | 全 NULL 无 op 被静默（settle 未执行） | D5：>2h 全 NULL 无 op ⇒ `nullNoOp` 独立桶 + 告警；补用例 |
| 2 | 阻断 | 48h 三窗无配对余量 ⇒ 边缘假孤儿/假缺失 | D3：目标窗 48h + 查询余量 24h，只统计目标窗；补跨界用例 |
| 3 | 阻断 | 台费按当前费率反推金额/当前费率为 0 漏报 | D10：有 op 以流水为历史事实；skip 通过；都无且 fee>0 ⇒ suspect；`[]|null` 契约；不比较当前费额 |
| 4 | 高 | 24h/1h 从 op/record 起算 ≠ outbox createdAt | D4/D5/D6：25h/2h/2h 安全余量 |
| 5 | 高 | entry_fee op 无记录/owner/免费房分支缺失 | D11：entryFeeOrphanOps/owner 非真人座/记录非 gold 分支 |
| 6 | 高 | 手动 run 耦合 records 失败/新 inFlight | D16：POST 先跑既有，records 独立；失败 200 + `records.error`；预检双 running |
| 7 | 高 | 五条查询非一致快照 | D14：事务内一致快照（InnoDB RR）+ 补交错测试 |
| 8 | 高 | 无查询超时/行数上限/分页 | D14/D15：`max_execution_time=30s`、20k 行上限、失败整轮 + 下轮 |
| 9 | 高 | 真 SQL 未在真 MySQL 跑 | D20：slice-35 真栈（ddz/pdk/0行/跨界/20k 基准）待权威轮 |
| 10 | 低 | admin 测试文件名/状态区可选链 | §5.6/§5.7 修正文件名；`d.records` 可选链 |
| 11 | 低 | recordsByKey 无 gameType | D13：`gameType:room:version` |
| 12 | 低 | A2 backfill 旧 PDK op 标 ddz | D12：有记录以记录玩法为准 |
| 13 | 低 | config_unavailable 只有 gauge/不可区分玩法 | §5.4/5.3：按玩法 gauge + byGame.configUnavailable |
| 14 | 低 | pdk 表缺失整轮 fail-fast | D18/§6：部署顺序 + 1146 明确日志/Stalled |

### 复审

（待 delta 复审后回填）

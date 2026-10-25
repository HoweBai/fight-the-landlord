# 跑得快（PDK）可观测性补齐设计（A1 片）

> 日期：2026-10-25 · 状态：待审查 · 流程：`docs/dev-process.md`
> 前置审计：本会话对 PDK 的监控 / 流水 / 风控三面审计（结论见 §1）。
> 本片只做 **A1 异常监控**；账本维度（A2）、管理端统计（A3）、金币场 conformance（A 组后续片）不在本片。

## 1. 背景与问题

PDK 已具备完整的对局、结算、记录、风控主链路，但可观测性存在系统性缺口：

1. **全仓唯一带玩法维度的指标是 `match_queue_length`**（`packages/room-service/src/metrics/room.metrics.ts:73-77`）。其余核心指标全部把 PDK 与斗地主混在一个桶里，无法回答“PDK 开局多少、结算失败多少、机器人补位失败多少”。
2. **27 条告警规则里 0 条涉及玩法**（`deploy/monitoring/prometheus/rules/ftl-alerts.yml`），8 块 Grafana 看板同样无 `game_type`；`scripts/verify-monitoring.mjs` 甚至不校验告警规则。
3. **PDK 专有失败路径没有指标**：开局失败（`failPdkStart`）、规则快照非法、牌堆校验失败、补位失败、`settlePdk` 抛错、记录写失败、PDK 规则 bot 决策异常、会话损坏。设计 spec 曾承诺“补位/开局链失败则告警”（`docs/superpowers/specs/2026-10-23-multi-game-platform-paodekuai-design.md:731`），实现只有 warn 日志。
4. **日志有但不可聚合**：PDK 关键链路有日志，均为自由文本，无 `event=`、无 `gameType` 字段。
5. 2/4 人玩法正在另一会话实现；本片**不碰 `player_count` 全维度**，避免冲突。`player_count` 只保留在既有 `match_queue_length`。

本片目标是让运维能回答三类问题：

- PDK 与斗地主各自的**业务量**（开局/结束/活跃/房间）；
- PDK 与斗地主各自的**失败面**（开局失败、结算失败、结算 dropped、记录写失败、机器人规则决策失败）；
- 失败能在 **Prometheus 告警**里被主动发现，而不是靠翻日志。

## 2. 范围

### 2.1 做

- 给现有核心指标加 `game_type` 标签（斗地主/跑得快），保持指标族单一。
- 新增 4 个失败计数器（开局/结算/记录写/机器人规则决策）。
- 新增 4 条按玩法的 Prometheus 告警规则（27 → 31）。
- 更新 4 块现有看板（业务/记录/货币/风控），不新建看板。
- 扩展 `scripts/verify-monitoring.mjs`：解析告警规则、校验新规则与看板分组。
- conformance：slice-16 规则名集 27 → 31；slice-29 在现有 PDK 局后断言开局/结束指标按玩法增长。
- 相应单测与既有测试标签断言同步。

### 2.2 不做（YAGNI / 边界）

- 不做 `player_count` 全维度（留 2/4 落地后的 B 组）；`match_queue_length` 已有该维度，保持。
- 不新建 PDK 专属看板、不做监控 runbook 文档（告警 `runbook` 注解内联说明）。
- 不改 Alertmanager / alert-relay 路由与接收器。
- 不做 PDK 金币场资金面 conformance（A 组后续片）。
- 不动 `risk_reviews` / `currency_ops` 等账本与管理端结构（A2/A3）。
- 不重构现有日志格式；只在新计数点补 `gameType` / `reason` / `phase` 字段。
- 不改任何对局规则、结算算法、协议出站形状。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | **统一标签方案**：给现有指标族加 `game_type`，不新增平行 `pdk_*` 指标族 | 单一指标族、查询不带标签仍聚合（向后兼容）、后续新玩法零复制；`match_queue_length` 已是此范式 |
| D2 | `game_type` 值域 = `GameType`（`doudizhu｜paodekuai`）；旧数据/缺字段一律按 `doudizhu`（与仓库既有缺省纪律一致） | 有界标签、无基数风险；outbox 历史条目无需回填 |
| D3 | 本片**不扩展** `player_count` 维度（仅保留已有 `match_queue_length`） | 2/4 会话正在进行，避免同文件冲突；B 组再统一加 |
| D4 | 新增 4 个失败计数器，`reason/phase/kind` 全部有界 | 告警与看板需要稳定的标签值域；防止基数爆炸 |
| D5 | 告警用**绝对次数**而非比例；`for` 窗口 5–10m | PDK 初期量小，比例告警永不触发；绝对次数对小流量更敏感 |
| D6 | 只改现有 4 块看板，不新建 PDK 看板 | 本片目标是“分玩法可见”，不是“专属运营大屏”；避免监控资产分叉 |
| D7 | `verify-monitoring.mjs` 增加**告警规则解析**与看板分组校验 | 现有静态闸不读告警规则，规则缺失不会红 |
| D8 | conformance 用 slice-16 静态名集 + slice-29 真栈指标增量 | slice-16 已钉规则名集；slice-29 已有 PDK 真局，增量断言成本最低 |
| D9 | `publishEnded` 失败计数后**原样抛出**，不吞错 | 计数只增加观测，不改变既有错误语义与房间状态机 |
| D10 | PDK 规则 bot 失败计数后**原样抛出**；同时在日志里不再打印误导性的 DouZero `model=` | 保持错误路径不变；修掉审计发现的“PDK 决策日志写 ddz 模型名”误导 |
| D11 | 无数据库变更；回滚 = revert 本片提交 | 指标标签是 Prometheus 序列形状变化，历史数据保留；无 schema 风险 |
| D12 | 本片不新增测试包/框架；沿用各服务既有 vitest 与 conformance 结构 | 最小侵入 |

## 4. 实现设计

### 4.1 现有指标补 `game_type`

| 指标 | 服务/文件 | 标签 | 写点 |
|---|---|---|---|
| `games_started_total` | room / `rooms.start.ts` | `game_type` | 成功点 `inc({game_type})` |
| `games_ended_total` | room / `ws.gateway.ts` | `game_type` | `event.gameType ?? 'doudizhu'` |
| `rooms_active` | room / `room-metrics.service.ts` | `game_type` | SCAN 后按房 `HGET gameType`（pipeline），缺省 ddz；每轮显式置两种玩法为 0 再写计数 |
| `games_active` | game / `game-metrics.service.ts` | `game_type` | `GameService.activeSessionCountByGameType()`（遍历 cache，缺省 ddz） |
| `currency_settle_result_total` | room / `settle.service.ts` | `result, game_type` | 所有 `inc` 带 `result` + `game_type`（房间元数据/outbox 条目） |
| `currency_settle_residue_total` | room / `settle.service.ts` | `game_type` | `inc({game_type}, residue)`（零残差也 inc 0，保持既有判据） |
| `currency_settle_outbox_size` | room / `settle.sweeper.ts` | `game_type` | 两箱条目按 `entry.gameType ?? 'doudizhu'` 分组计数；每轮先置零 |
| `currency_settle_outbox_oldest_seconds` | room / `settle.sweeper.ts` | `game_type` | 同上分组取最老年龄；空组 0 |
| `entry_fee_skipped_total` | room / `rooms.start.ts` | `reason, game_type` | `recordEntryFeeSkip` 已有 gameType 参数 |
| `entry_fee_conflict_total` | room / `rooms.start.ts` | `game_type` | `chargeOne` 已有 gameType 参数 |
| `currency_robot_topup_total` | room / `robot-funding.ts` | `action, game_type` | 补款/回收均带玩法 |
| `currency_robot_ensure_failed_total` | room / `robot-funding.ts` | `game_type` | ensure 失败带玩法 |
| `match_predicate_rejections_total` | room / `match.service.ts` | `predicate, game_type` | `randomGreedyPick` / `accountRejection` 透传 `queue.gameType` |
| `match_selection_rounds_total` | room / `match.service.ts` | `game_type` | 同上（拒绝率分母可按玩法拆） |
| `match_no_legal_group_total` | room / `match.service.ts` | `game_type` | 同上 |
| `records_rows_deleted_total` | user / `records-cleanup.service.ts` | `game_type` | 按 ddz/pdk 两对表分别累计后 `inc({game_type}, n)`；返回值仍为合计 |
| `records_table_bytes` | user / `records-cleanup.service.ts` | 不加标签 | 四表聚合体积，保持现状（口径注释同步） |
| `risk_scan_hits_total`（新增） | user / `scan.service.ts` | `game_type` | **仅胜率命中**：每用户每玩法命中 +1；设备命中保持平台级 |

补充口径：

- `GameEvent` 接口补可选 `gameType`（game-service 的 `game.ended` 载荷**已经**发布该字段，room 侧类型此前未声明）——缺省按 ddz。
- `games_active` 仍为 **per-instance** 语义，只是多一个 `game_type` 维度。
- `rooms_active` 仍为全栈口径；旧房缺 `gameType` 字段 ⇒ ddz。
- outbox 坏条目：sweeper 会在本轮解析时删除；刷新读数时仍无法解析的极少见条目按 ddz 归类（保持 `sum by (game_type)` 与总数一致）。
- `risk_scan_hits_total` 不计 `risk_reviews` 的处置结果，只表示“本轮检测到胜率命中”。

### 4.2 新增失败计数器

| 指标 | 服务/文件 | 标签值域 | 写点与语义 |
|---|---|---|---|
| `game_start_failures_total{game_type, reason}` | room / `rooms.start.ts` | `start_rpc` / `pending_write` / `bot_fill` / `cancelled` | `failPdkStart` 每次失败按映射 reason +1；终局取消额外 `cancelled` +1；ddz 的 `Failed to start game` catch 计 `start_rpc` |
| `game_settle_failures_total{game_type, phase}` | game / `game.service.ts` | `settle` / `record` / `publish` | `publishEnded` 内分三段 try/catch：计数 + error 日志（含 roomCode/gameType/phase）后 rethrow |
| `record_write_failures_total{game_type, kind}` | room / `ws.gateway.ts` + `settle.service.ts` | `record` / `money_delta` | `kind=record`：记录投递 catch；`kind=money_delta`：`record.moneyDelta` 失败/部分匹配/入 outbox 失败三处 |
| `robot_rule_errors_total{game_type, reason}` | robot / `bot.player.ts` | `decision_error` | PDK 分支 try/catch：计数 + error 日志后 rethrow；`reason` 先只保留一值，后续可扩展 |

约束：

- 所有新指标 `labelNames` 有界；不得把 `roomCode`、`botId`、异常文本放进标签。
- 计数与错误日志必须同点发生，避免“有日志无计数”或反之。
- `game_start_failures_total` 的 `start_rpc` **只在 `game.start` 的 catch 计一次**（ddz/pdk 共用）；`failPdkStart` 只计 `pending_write` / `bot_fill`，不再为 `game.start failed` 重复计数。`cancelled` 是**额外**事件（与本次 attempt 的 reason 并存），便于告警区分“重试中”与“放弃”。

### 4.3 告警规则（27 → 31）

追加到 `deploy/monitoring/prometheus/rules/ftl-alerts.yml`（`ftl-alerts` group）：

| 告警 | 表达式 | for | severity | 说明 |
|---|---|---|---|---|
| `GameStartFailuresHigh` | `sum by (game_type) (increase(game_start_failures_total[15m])) >= 5` | 5m | warning | PDK 重试预算 5 次；单房打满即触发；ddz 同样适用 |
| `GameSettleFailures` | `sum by (game_type, phase) (increase(game_settle_failures_total[10m])) > 0` | 5m | critical | 结算/记录组装/发布失败 ⇒ 钱或局终链路异常 |
| `SettleDroppedByGame` | `sum by (game_type) (increase(currency_settle_result_total{result="dropped"}[10m])) > 0` | 10m | warning | 结算被守卫丢弃（gameType/playerCount 不匹配、余额读失败、outbox 超龄等） |
| `RecordWriteFailuresHigh` | `sum by (game_type, kind) (increase(record_write_failures_total[15m])) >= 3` | 5m | warning | 记录/金额回写失败 |

- 复用现有 severity 路由；不新增接收器、不改 Alertmanager 配置。
- 每条规则的 `annotations.runbook` 指向：先看对应服务的 error 日志（新日志带 `gameType` / `reason` / `phase`），再按 roomCode 追查。
- 文件头注释与 conformance 的规则数量同步：27 → 31。

### 4.4 看板（4 块）

| 看板 | 面板 | 改法 |
|---|---|---|
| `02-business.json` | 匹配队列深度 | `sum by (game_type, mode, base_score) (match_queue_length)`，图例含 `game_type` |
| `02-business.json` | 活跃房间 / 对局 | 两条 target 改为 `sum by (game_type)` + 图例 `{{game_type}}`；保留一条合计线 |
| `02-business.json` | 开局 / 结算速率 | `sum by (game_type) (rate(...[5m]))` + 图例 |
| `05-currency.json` | 结算结果 / 残差 / outbox / 台费 / 机器人 | 全部 `sum by (game_type)` 或 `sum by (game_type, result/action/reason)` + 图例 |
| `04-records-backup.json` | 记录删除速率 | `sum by (game_type) (rate(records_rows_deleted_total[1h]))` |
| `06-risk.json` | 谓词拒绝速率 + 抽选轮/不成组 | 按 `game_type` 分组；拒绝率保留平台级合计（既有告警口径不变），另加按玩法线 |

不新增面板；不改变任何仪表盘的 uid/title（`verify-monitoring` 的 uid/title 唯一性判据保持）。

### 4.5 静态闸与 conformance

**`scripts/verify-monitoring.mjs`**

- 新增：读取 `deploy/monitoring/prometheus/rules/ftl-alerts.yml`，用文本解析（不引入 YAML 依赖）：
  - 提取全部 `- alert:` 名称集合，断言恰 31 条且包含 4 条新规则；
  - 断言 4 条新规则的表达式包含 `game_type`（防“加了规则但没按玩法”）；
  - 断言文件头注释“27 条”已更新为“31 条”（防注释漂移）。
- 新增：对 02/04/05/06 看板中受影响面板断言表达式包含 `game_type`（按面板标题或表达式内容匹配；避免宽泛正则）。
- 保持现有 08-players 允许清单与 prometheus job 校验不变。

**conformance**

- `slice-16-monitoring.ts`：`EXPECTED_RULES` 27 → 31，追加 4 个名字；注释与基线同步。
- `slice-29-paodekuai.ts`：在现有 PDK 局结束处（已有 `records/mine` 断言附近）增加：
  - `games_started_total{game_type="paodekuai"}` 增量 ≥ 1；
  - `games_ended_total{game_type="paodekuai"}` 增量 ≥ 1；
  - 通过 `readNestMetrics` + `sumMetric` 的标签感知助手（新增 `sumMetricByLabel` 或等价）读取；不得用“总量增量”代替（那会在 ddz 同时跑时假绿）。
- 若断言数变化，更新 `tools/conformance/baselines.json` 对应切片计数。

### 4.6 单测（TDD 主战场）

按服务：

- room-service：`rooms.start`（started + 失败 reason 映射）、`ws.gateway`（ended 标签 + record 失败计数）、`settle.service`（result/residue 标签）、`settle.sweeper`（outbox 分玩法）、`robot-funding`（topup/ensure 标签）、`match.service`（谓词/轮次/不成组标签）、`room-metrics.service`（rooms_active 分玩法采样）。
- game-service：`publishEnded` 三段失败计数与 rethrow、`games_active` 分玩法采样。
- robot-service：PDK 决策异常计数 + rethrow；ddz 路径指标不变。
- user-service：`records_rows_deleted_total` 分玩法、`risk_scan_hits_total` 命中计数。
- 测试断言方式沿用各包既有 `register.metrics()` 文本或指标对象 `get()`；不得只断言 mock 调用（要断言最终暴露的标签值）。

## 5. 边界与错误处理

- **不吞错**：新增计数全部在 catch 内计数后 rethrow（D9/D10）；不得改变房间/会话状态机。
- **采样失败**：`rooms_active` 的 HGET pipeline 失败 ⇒ 本轮指标保持旧值并记一次 WARN（不擦成 0）；下一轮自愈。
- **标签缺省**：旧事件/旧条目缺 `gameType` ⇒ ddz；禁止 `undefined` 作为标签值。
- **零值序列**：`rooms_active` / `games_active` / outbox 每轮显式写两种玩法（0 也写），避免旧序列残留造成“PDK 还有活跃房”的假象。
- **基数**：`game_type` 2 值；`reason/phase/kind` 总共 ≤ 9 值；不新增自由文本标签。
- **看板兼容**：所有现有 PromQL 不带标签时仍聚合；更新图例不改变面板 uid/title。

## 6. 风险与回滚

| 风险 | 影响 | 处置 |
|---|---|---|
| 现有单测按无标签断言 `get()` | 测试红 | 本片同步更新受影响用例；逐包跑测试 |
| 看板图例/分组改动 | 人工阅读口径变化 | 保留合计线；只改 4 块看板 |
| `rooms_active` 采样增加 HGET | Redis 负载小幅上升 | pipeline 批量；房间量级小；如实测异常，退化为聚合值（登记） |
| 告警阈值初期噪声 | 误报 | 绝对次数 + `for` 窗口；上线后按实际量调参（阈值变更走发版） |
| `publishEnded` 包装改变错误路径 | 卡局/重复结算 | 仅加 try/catch 计数后 rethrow，行为逐字保持；单测钉住“计数后仍抛出” |

回滚：revert 本片提交即可；无数据库迁移、无协议出站变更。Prometheus 中带 `game_type` 的历史序列会停止增长，旧查询不受影响。

## 7. 涉及文件

**生产代码**

- `packages/room-service/src/metrics/room.metrics.ts`
- `packages/room-service/src/metrics/room-metrics.service.ts`
- `packages/room-service/src/rooms/rooms.start.ts`
- `packages/room-service/src/gateway/ws.gateway.ts`
- `packages/room-service/src/currency/settle.service.ts`
- `packages/room-service/src/currency/settle.sweeper.ts`
- `packages/room-service/src/currency/robot-funding.ts`
- `packages/room-service/src/match/match.service.ts`
- `packages/game-service/src/metrics/game.metrics.ts`
- `packages/game-service/src/metrics/game-metrics.service.ts`
- `packages/game-service/src/game/game.service.ts`
- `packages/robot-service/src/robot/robot.metrics.ts`
- `packages/robot-service/src/robot/bot.player.ts`
- `packages/robot-service/src/robot/robot.service.ts`
- `packages/user-service/src/records/records.metrics.ts`
- `packages/user-service/src/records/records-cleanup.service.ts`
- `packages/user-service/src/risk/risk.metrics.ts`
- `packages/user-service/src/risk/scan.service.ts`

**监控资产**

- `deploy/monitoring/prometheus/rules/ftl-alerts.yml`
- `deploy/monitoring/grafana/dashboards/02-business.json`
- `deploy/monitoring/grafana/dashboards/04-records-backup.json`
- `deploy/monitoring/grafana/dashboards/05-currency.json`
- `deploy/monitoring/grafana/dashboards/06-risk.json`
- `scripts/verify-monitoring.mjs`
- `docs/ops/first-deploy.md`（告警类别清单补 4 条，若该清单存在）

**测试 / conformance**

- `packages/room-service/test/*`（受影响指标用例）
- `packages/game-service/test/*`
- `packages/robot-service/test/*`
- `packages/user-service/test/*`
- `tools/conformance/src/slices/slice-16-monitoring.ts`
- `tools/conformance/src/slices/slice-29-paodekuai.ts`
- `tools/conformance/baselines.json`

## 8. 测试判据（完成定义）

1. 每个新增/改标签的指标都有单测断言最终暴露的标签值（不是只断言过渡变量）。
2. `pnpm -C packages/room-service test`、`game-service`、`robot-service`、`user-service` 全绿。
3. `pnpm -C packages/room-service run lint`（及对应包 lint）通过。
4. `node scripts/verify-monitoring.mjs` 通过，且能对“删掉一条新告警”变红（静态闸判别力自证）。
5. `pnpm verify:admin` 不受影响（本片不改 admin）。
6. conformance slice-16 / slice-29 的改动在真栈环境可跑（本机无 Docker 时记录为“待权威轮”，不得声称已跑）。
7. 工作区干净（除用户已有的未提交文件）。
8. 全量验证：`pnpm exec turbo run test lint --force`（按可执行范围；Cached 不算真跑）。

## 9. 审查记录

（待设计对抗审查后填写）

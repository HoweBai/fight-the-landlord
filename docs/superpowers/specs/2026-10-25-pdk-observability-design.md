# 跑得快（PDK）可观测性补齐设计（A1 片）

> 日期：2026-10-25 · 状态：已按设计对抗审查修订（待复审） · 流程：`docs/dev-process.md`
> 前置审计：本会话对 PDK 的监控 / 流水 / 风控三面审计（结论见 §1）。
> 本片只做 **A1 异常监控**；账本维度（A2）、管理端统计（A3）、金币场 conformance（A 组后续片）不在本片。

## 1. 背景与问题

PDK 已具备完整的对局、结算、记录、风控主链路，但可观测性存在系统性缺口：

1. **全仓唯一带玩法维度的指标是 `match_queue_length`**（`packages/room-service/src/metrics/room.metrics.ts:73-77`）。其余核心指标全部把 PDK 与斗地主混在一个桶里，无法回答“PDK 开局多少、结算失败多少、机器人补位失败多少”。
2. **27 条告警规则里 0 条涉及玩法**（`deploy/monitoring/prometheus/rules/ftl-alerts.yml`），8 块 Grafana 看板同样无 `game_type`；`scripts/verify-monitoring.mjs` 甚至不校验告警规则。
3. **PDK 专有失败路径没有指标**：开局失败（`failPdkStart`）、规则快照非法、牌堆校验失败、补位失败、`settlePdk` 抛错、记录写失败/丢失、PDK 规则 bot 决策异常、会话损坏。设计 spec 曾承诺“补位/开局链失败则告警”（`docs/superpowers/specs/2026-10-23-multi-game-platform-paodekuai-design.md:731`），实现只有 warn 日志。
4. **日志有但不可聚合**：PDK 关键链路有日志，均为自由文本，无 `event=`、无 `gameType` 字段。
5. 2/4 人玩法正在另一会话实现；本片**不新增 `player_count` 维度**（`match_queue_length` 已有），并通过独立 worktree/分支实施，降低同文件并行冲突。

本片目标是让运维能回答三类问题：

- PDK 与斗地主各自的**业务量**（开局/结束/活跃/房间）；
- PDK 与斗地主各自的**失败面**（开局失败、结算失败、结算 dropped、记录写失败/丢失、机器人规则决策失败）；
- 失败能在 **Prometheus 告警**里被主动发现，而不是靠翻日志。

## 2. 范围

### 2.1 做

- 给现有核心指标加 `game_type` 标签（斗地主/跑得快），保持指标族单一。
- 新增 4 个失败计数器（开局/结算/记录写/机器人规则决策），并给机器人决策分母补 `game_type`。
- 新增 4 条按玩法的 Prometheus 告警规则（27 → 31）。
- 更新 4 块现有看板（业务/记录/货币/风控），不新建看板。
- 扩展 `scripts/verify-monitoring.mjs`：解析告警规则、校验新规则与看板分组。
- conformance：修正 slice-16 / slice-18 的规则数硬编码与规则名集；slice-16 C11 增加 `game_type` 标签增量断言。
- 相应单测与既有测试标签断言同步；新增 registry 级“所有改造指标必须带 `game_type`”不变量测试。
- 同步 HELP 文本、告警文件头、`Dockerfile.prometheus` 注释与 ops 文档中的规则数/查询口径。

### 2.2 不做（YAGNI / 边界）

- 不新增 `player_count` 维度（留 2/4 落地后的 B 组）；`match_queue_length` 既有维度保持。
- 不新建 PDK 专属看板、不做监控 runbook 文档（告警 `runbook` 注解内联说明）。
- 不改 Alertmanager / alert-relay 路由与接收器。
- 不做 PDK 金币场资金面 conformance（A 组后续片）。
- **不改 slice-29**（2/4 会话正在改它）；PDK 指标真栈断言另立片（暂记 slice-30）。
- 不动 `risk_reviews` / `currency_ops` 等账本与管理端结构（A2/A3）。
- 不重构现有日志格式；只在新计数点补 `gameType` / `reason` / `phase` 字段。
- 不改任何对局规则、结算算法、协议出站形状。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | **统一标签方案**：给现有指标族加 `game_type`，不新增平行 `pdk_*` 指标族 | 单一指标族、查询不带标签仍聚合（向后兼容）、后续新玩法零复制；`match_queue_length` 已是此范式 |
| D2 | `game_type` 值域 = `GameType`（`doudizhu｜paodekuai`）；缺字段/空串/未知一律归一为 `doudizhu`，入口处 WARN | 有界标签、无基数风险；与仓库既有缺省纪律一致；`??` 不兜空串，必须显式校验 |
| D3 | 本片**不新增** `player_count` 维度（仅保留已有 `match_queue_length`） | 2/4 会话正在进行；B 组统一加 |
| D4 | 新增失败计数器的 `reason/phase/kind` 全部为**枚举**，不以错误文本做标签；`failPdkStart` 签名改为枚举 + 独立 detail 文本 | 防基数爆炸；调用点映射可测试，禁止字符串匹配 |
| D5 | 所有带 `game_type` 的写点统一经 shared 的 `incGame/setGame` 助手，助手内部校验/归一 | prom-client **少传标签不抛错**，会生成缺标签序列；只有助手 + registry 不变量测试能防住 |
| D6 | 采样类 gauge **先读后写**：全部读取/解析成功后才写两种玩法；读取失败保留旧值并 WARN | 防止一次 Redis 抖动把 `CurrencySettleOutboxStuck` / `rooms_active` 假解除 |
| D7 | 告警用**绝对次数**而非比例；`for` 窗口 5–10m | PDK 初期量小，比例告警永不触发；绝对次数对小流量更敏感 |
| D8 | 只改现有 4 块看板，不新建面板/看板；按 `(面板, 指标)` 白名单校验，不按 raw substring | 避免对平台级指标（currency-service 的池余额/救助）错误分组而静态闸假绿 |
| D9 | `verify-monitoring.mjs` 增加**告警规则解析**；YAML 语法由 slice-16 的 promtool 负责 | 现有静态闸不读告警规则，规则缺失不会红；职责不重叠 |
| D10 | `publishEnded` 失败计数后**原样抛出**，不吞错；`buildRecord` 不包（其内部已吞编码错误，`phase=record` 是死相位） | 计数只增加观测，不改变既有错误语义 |
| D11 | PDK 规则 bot 失败计数覆盖整个 PDK 分支（含 feature-shape guard）；同时修掉 PDK 决策日志打印 ddz 模型名的误导 | 保持错误路径不变；让错误率有分母（`robot_decisions_total` 补 `game_type`） |
| D12 | 无数据库变更；回滚 = revert 本片提交 | 指标标签是 Prometheus 序列形状变化，历史数据保留；无 schema 风险 |
| D13 | PDK 指标真栈断言**不进 slice-29**，另立片 | 2/4 会话正在改 slice-29 与 baselines；避免双改冲突 |
| D14 | 本片在独立 worktree/分支 `feature/pdk-observability-a1` 实施，合入 `dev` 由用户/玩法侧完成后再合 | 本片与 2/4 的高概率改动面重叠（rooms.start/match/settle/ws.gateway/game.service/metrics/看板） |

## 4. 实现设计

### 4.1 指标标签与公共助手

新增 `packages/shared/src/metrics/game-label.ts`（从 shared 导出）：

- `normalizeGameType(value: unknown): GameType`：`isGameType` 命中则原值，否则 `doudizhu`。
- `gameLabel(value: unknown): { game_type: GameType }`。
- `incGame(counter, value: unknown, labels?: Record<string, string>): void`：强制合并 `game_type` 后 `counter.inc(...)`。
- `setGame(gauge, value: unknown, n: number): void`。

所有本片改造的写点**必须**经这两个助手；禁止直接 `.inc({...})/.set(...)` 带标签（源码闸/测试审查项）。

现有指标补 `game_type`：

| 指标 | 服务/文件 | 标签 | 写点与说明 |
|---|---|---|---|
| `games_started_total` | room / `rooms.start.ts` | `game_type` | 成功点 `incGame(...)` |
| `games_ended_total` | room / `ws.gateway.ts` | `game_type` | `event.gameType ?? event.record?.gameType`；都没有 ⇒ ddz（`notifyRoomEnded` 路径不带 gameType） |
| `rooms_active` | room / `room-metrics.service.ts` | `game_type` | SCAN 后用 pipeline `HGET room:{code} gameType`；旧房缺字段 ⇒ ddz；**先读后写** |
| `games_active` | game / `game-metrics.service.ts` | `game_type` | `GameService.activeSessionCountByGameType()`（遍历 cache，缺省 ddz）；**先读后写** |
| `currency_settle_result_total` | room / `settle.service.ts` | `result, game_type` | 所有 `inc` 带 `result` + 房间/条目 gameType；`applyGraded`/`readBalances`/`dropWarn`/`dropError` 需补 gameType 参数 |
| `currency_settle_residue_total` | room / `settle.service.ts` | `game_type` | `incGame(..., residue)`（零残差也 inc 0，保持既有判据） |
| `currency_settle_outbox_size` | room / `settle.sweeper.ts` | `game_type` | 两箱条目按 `entry.gameType` 分组计数；**先读后写**；坏/缺字段条目按 ddz |
| `currency_settle_outbox_oldest_seconds` | room / `settle.sweeper.ts` | `game_type` | 同上分组取最老年龄；空组 0 |
| `entry_fee_skipped_total` | room / `rooms.start.ts` | `reason, game_type` | `recordEntryFeeSkip` 已有 gameType 参数 |
| `entry_fee_conflict_total` | room / `rooms.start.ts` | `game_type` | `chargeOne` 已有 gameType 参数 |
| `currency_robot_topup_total` | room / `robot-funding.ts` | `action, game_type` | 补款/回收均带玩法（`applyFunding` 需补参数） |
| `currency_robot_ensure_failed_total` | room / `robot-funding.ts` | `game_type` | ensure 失败带玩法 |
| `match_predicate_rejections_total` | room / `match.service.ts` | `predicate, game_type` | `randomGreedyPick`/`accountRejection` 透传 `queue.gameType` |
| `match_selection_rounds_total` | room / `match.service.ts` | `game_type` | 同上 |
| `match_no_legal_group_total` | room / `match.service.ts` | `game_type` | 同上 |
| `records_rows_deleted_total` | user / `records-cleanup.service.ts` | `game_type` | 按 ddz/pdk 两对表分别累计后 `incGame`；返回值仍为合计 |
| `records_table_bytes` | user / `records-cleanup.service.ts` | 不加标签 | 四表聚合体积，保持现状（HELP 同步为“四表”） |
| `robot_decisions_total` | robot / `robot.service.ts` | `result, skill, game_type` | `req.view.gameType`；为机器人错误率提供分母 |
| `risk_scan_hits_total`（新增） | user / `scan.service.ts` | `game_type` | **仅胜率命中**：每用户每玩法命中 +1；设备命中不纳入本指标（reasons/score 仍可见） |

补充口径：

- `GameEvent` 接口补可选 `gameType`（`publishEnded` 已发布该字段；`notifyRoomEnded` 不发布，因此取 `event.gameType ?? event.record?.gameType` 后归一）。
- `games_active` 仍为 **per-instance** 语义，只是多一个 `game_type` 维度。
- `rooms_active` 仍为全栈口径；pipeline 整条失败 ⇒ 不写、保留旧值；单键命令失败 ⇒ 该房计 ddz + 本轮一条 WARN（汇总条数）。
- outbox 坏条目：sweeper 本轮解析时会删除；刷新读数时仍无法解析的条目按 ddz 归类（保持 `sum by (game_type)` 与总数一致）。
- 所有 HELP 文本同步标签口径（`room.metrics.ts`、`game.metrics.ts`、`records.metrics.ts`、`robot.metrics.ts`、`risk.metrics.ts`）。

### 4.2 新增失败计数器

| 指标 | 服务/文件 | 标签值域 | 写点与语义 |
|---|---|---|---|
| `game_start_failures_total{game_type, reason}` | room / `rooms.start.ts` | `start_rpc` / `pending_write` / `bot_fill` / `rules` / `on_seats` / `cancelled` | `game.start` catch ⇒ `start_rpc`（ddz/pdk 共用，恰一次）；`failPdkStart` 改为接收枚举 `bot_fill｜pending_write｜rules｜null`（`null` = start_rpc 已计）+ detail 文本；终局取消额外 `cancelled`；ddz 的补位失败 ⇒ `bot_fill`、`pending.write` 失败 ⇒ `pending_write`、`onSeats` 失败 ⇒ `on_seats` |
| `game_settle_failures_total{game_type, phase}` | game / `game.service.ts` | `settle` / `publish` | `publishEnded` 分别包 `runtime.settle` 与 `redis.publish`：计数 + error 日志（roomCode/gameType/phase）后 rethrow；`buildRecord` 不包（内部已吞错） |
| `record_write_failures_total{game_type, kind}` | room / `ws.gateway.ts` + `settle.service.ts` | `record` / `money_delta` / `record_lost` | `record`：`writeGameRecord` 抛错；`money_delta`：`pushMoneyDelta` 失败/部分匹配/入 outbox 失败 + `resendRecordMoneyOutboxEntry` 失败/超龄放弃；`record_lost`：房间 TTL 过期/形状不符导致记录丢弃。**旧会话窗口（缺 record/version）不计**（部署期正常路径） |
| `robot_rule_errors_total{game_type, reason}` | robot / `bot.player.ts` | `decision_error` | 整个 PDK 分支（含 feature-shape guard）try/catch：计数 + error 日志后 rethrow |

约束：

- 所有新指标 `labelNames` 有界；不得把 `roomCode`、`botId`、异常文本放进标签。
- 计数与错误日志必须同点发生，避免“有日志无计数”或反之。
- `game_start_failures_total` 的 `cancelled` 是**额外**事件（与本次 attempt 的 reason 并存），便于告警区分“重试中”与“放弃”。
- 标签基数总计：`game_type` 2 + start reasons 6 + settle phases 2 + record kinds 3 + robot reasons 1 = 有界且固定。

### 4.3 告警规则（27 → 31）

追加到 `deploy/monitoring/prometheus/rules/ftl-alerts.yml`（`ftl-alerts` group）：

| 告警 | 表达式 | for | severity | 说明 |
|---|---|---|---|---|
| `GameStartFailuresHigh` | `(sum by (game_type) (increase(game_start_failures_total[15m])) >= 5) or (sum by (game_type) (increase(game_start_failures_total{reason="cancelled"}[15m])) > 0)` | 5m | warning | 覆盖“重试打满”与“waiting 超时首次失败即取消”两种形态 |
| `GameSettleFailures` | `sum by (game_type, phase) (increase(game_settle_failures_total[10m])) > 0` | 5m | critical | 结算/发布失败 ⇒ 钱或局终链路异常 |
| `SettleDroppedByGame` | `sum by (game_type) (increase(currency_settle_result_total{result="dropped"}[10m])) > 0` | 5m | warning | 结算被守卫丢弃（gameType/playerCount 不匹配、余额读失败、outbox 超龄等）；与 `CurrencySettleOutboxStuck` 在“outbox 超龄放弃”上可能先后响，属有意双保险 |
| `RecordWriteFailuresHigh` | `(sum by (game_type, kind) (increase(record_write_failures_total[15m])) >= 3) or (sum by (game_type) (increase(record_write_failures_total{kind="record_lost"}[15m])) > 0)` | 5m | warning | 连续失败或任一记录丢失 |

- 复用现有 severity 路由；不新增接收器、不改 Alertmanager 配置。
- 每条规则的 `annotations.runbook` 指向：先看对应服务的 error 日志（新日志带 `gameType` / `reason` / `phase`），再按 roomCode 追查。
- `ftl-alerts.yml` 头部注释、`Dockerfile.prometheus` 注释、conformance 规则数量同步：27 → 31（24 类 → 28 类）。
- 既有 `CurrencySettleOutboxStuck` 因 gauge 增加玩法维度会按玩法各生成一条告警实例；表达式不变（仍以 300s 为阈值），文档注明。

### 4.4 看板（4 块，按面板白名单）

| 看板 | 面板 | 改法 |
|---|---|---|
| `02-business.json` | 匹配队列深度 | `sum by (game_type, mode, player_count, base_score) (match_queue_length)`，图例含 `game_type` |
| `02-business.json` | 活跃房间 / 对局 | `sum by (game_type)` + 图例 `{{game_type}}`；保留一条合计线 |
| `02-business.json` | 开局 / 结算速率 | `sum by (game_type) (rate(...[5m]))` + 图例 |
| `02-business.json` | 机器人决策速率与失败 | 决策 `sum by (game_type, result, skill)`；失败 `sum by (game_type, reason)` |
| `05-currency.json` | 结算补偿队列最老滞留 | `max by (game_type) (currency_settle_outbox_oldest_seconds)` + 图例 |
| `05-currency.json` | 结算结果速率 | `sum by (game_type, result)` |
| `05-currency.json` | 残差销毁增速 | `sum by (game_type) (rate(...))` |
| `05-currency.json` | 机器人补给/回收速率 | `sum by (game_type, action)` |
| `05-currency.json` | 机器人 ensure 失败累计 | `sum by (game_type)` |
| `05-currency.json` | 台费收/漏 | `sum by (game_type, reason)` / `sum by (game_type)` |
| `04-records-backup.json` | 记录删除速率 | `sum by (game_type) (rate(records_rows_deleted_total[1h]))` |
| `06-risk.json` | 谓词拒绝速率 | `sum by (game_type, predicate)` |
| `06-risk.json` | 抽选轮与不成组 | 各查询 `sum by (game_type)`；拒绝率保留平台级合计（既有告警口径不变），另加按玩法线 |
| `06-risk.json` | 风险扫描 | 追加一条 `sum by (game_type) (rate(risk_scan_hits_total[5m]))`（胜率命中） |

**不改**：`currency_robot_pool_balance`、`currency_robot_accounts_balance_sum`、`currency_relief_total`（currency-service 平台级指标，无 `game_type`）、`records_table_bytes`、`risk_scan_runs_total`、`risk_reviews_open`、`risk_actions_total`。静态闸按 `(看板, 面板, 指标)` 白名单校验，不按 raw substring。

不新增面板；不改变任何仪表盘的 uid/title。

### 4.5 静态闸与 conformance

**`scripts/verify-monitoring.mjs`**

- 读取 `ftl-alerts.yml`，先剥注释行，再按行首 `^\s*-\s+alert:` 切块；每个块只从 `expr:` 行提取表达式（不得在 summary/runbook 里搜 `game_type`，否则假绿）。
- 断言规则名集合**等于** 31 条 EXPECTED 集合（数量 + 集合双钉）；断言 4 条新规则存在且 `expr` 含 `game_type`。
- 断言头部注释为 31 条 / 28 类（防注释漂移）。
- 对 02/04/05/06 的受影响面板按 `(文件, 面板 title, 指标名)` 白名单断言表达式含 `game_type`；对“不改”清单断言**不含** `game_type`（防误改平台级指标）。
- 现有 08-players 允许清单与 prometheus job 校验不变。
- 判别力自证：临时删掉一条新告警/把某面板改回聚合，脚本必须变红（在计划中作为手工验证步骤记录）。

**conformance**

- `slice-16-monitoring.ts`：
  - `EXPECTED_RULES` 追加 4 个名字；
  - 三处硬编码 27 全部改为 `EXPECTED_RULES.length` / 31：`:704-705`（promtool `rules found`）、`:767`（`/api/v1/rules`）；
  - C11 增加 `games_started_total{game_type="doudizhu"}` 与 `games_ended_total{game_type="doudizhu"}` 的精确标签增量断言（复用同文件私有 `seriesValue`，无需抽公共库）。
- `slice-18-gold-room.ts:1575` 的 `ruleNames.length === 27` 同步改 31。
- `Dockerfile.prometheus` 头部注释 27 同步。
- **不改 slice-29 / baselines 的指标断言**；PDK 指标真栈断言另立片（D13）。若 slice-16 断言数变化，更新 `tools/conformance/baselines.json` 对应切片计数。

### 4.6 单测（TDD 主战场）

按服务：

- shared：`normalizeGameType/incGame/setGame` 单测（含空串/未知/undefined）；registry 不变量助手。
- room-service：`rooms.start`（started + 6 种 failure reason + 不重复计 start_rpc）、`ws.gateway`（ended 标签 + record/record_lost 计数 + money_delta 失败）、`settle.service`（result/residue 标签 + dropped 路径）、`settle.sweeper`（outbox 分玩法 + hgetall 失败保持旧值）、`robot-funding`（topup/ensure 标签）、`match.service`（谓词/轮次/不成组标签）、`room-metrics.service`（rooms_active 分玩法 + pipeline 失败保持旧值）。
- game-service：`publishEnded` 两段失败计数与 rethrow、`games_active` 分玩法采样（fake 补 `activeSessionCountByGameType`）。
- robot-service：PDK 分支异常（含 feature-shape guard）计数 + rethrow；`robot_decisions_total` 带 game_type；ddz 路径指标不变。
- user-service：`records_rows_deleted_total` 分玩法、`risk_scan_hits_total` 命中计数。
- 测试助手：新增“精确标签集”读数器（缺/多序列直接失败）；替换 `metricValue`/`gaugeValue` 的 `values[0]` 用法于本片相关用例；新增 registry 不变量测试（所有改造指标每条序列必须有 `game_type` 且值域 ⊆ {doudizhu,paodekuai}）。
- 断言方式沿用各包既有 `register.metrics()` 文本或指标对象 `get()`；不得只断言 mock 调用。

## 5. 边界与错误处理

- **不吞错**：新增计数全部在 catch 内计数后 rethrow（D10/D11）；不得改变房间/会话状态机。
- **采样先读后写**：`rooms_active`、`games_active`、两个 outbox gauge 只有全部读取/解析成功后才写两种玩法（缺失组写 0）；读取失败保留旧值并 WARN（D6）。
- **标签归一**：`game_type` 只经 `normalizeGameType` 产生；空串/未知在入口 WARN 后归 ddz，禁止 `undefined`/`""` 进入标签。
- **零值序列**：成功采样时显式写两种玩法（0 也写），避免旧序列残留造成“PDK 还有活跃房”的假象。
- **基数**：`game_type` 2 值；`reason/phase/kind` 合计固定 ≤ 12；不新增自由文本标签。
- **看板兼容**：所有现有 PromQL 不带标签时仍聚合；更新图例不改变面板 uid/title；平台级指标不强行分组。

## 6. 风险与回滚

| 风险 | 影响 | 处置 |
|---|---|---|
| 与 2/4 会话同文件并行 | 合并冲突 | D14：独立 worktree/分支；合入顺序由用户/玩法侧决定；不在本片改 slice-29 |
| 现有单测按无标签断言 | 测试红 | 本片同步更新受影响用例；逐包跑测试 |
| prom-client 少传标签不抛错 | 静默缺标签序列 | D5 助手 + registry 不变量测试 |
| 采样读取失败写 0 | 钱面告警假解除 | D6 先读后写 + 失败保持旧值单测 |
| 告警阈值初期噪声 | 误报 | 绝对次数 + `for` 窗口；上线后按实际量调参（阈值变更走发版） |
| `publishEnded` 包装改变错误路径 | 卡局/重复结算 | 仅计数后 rethrow，行为逐字保持；单测钉住“计数后仍抛出” |
| outbox gauge 由 1 条变多条 | 既有按单序列读的脚本/文档口径变化 | 文档注明消费者改用 `sum by (game_type)` 或 `sum()`；`CurrencySettleOutboxStuck` 阈值不变 |

回滚：revert 本片提交即可；无数据库迁移、无协议出站变更。Prometheus 中带 `game_type` 的历史序列会停止增长，旧查询不受影响。

## 7. 涉及文件

**生产代码**

- `packages/shared/src/metrics/game-label.ts`（新增）+ `packages/shared/src/index.ts`（导出）
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

**监控资产与文档**

- `deploy/monitoring/prometheus/rules/ftl-alerts.yml`
- `deploy/monitoring/grafana/dashboards/02-business.json`
- `deploy/monitoring/grafana/dashboards/04-records-backup.json`
- `deploy/monitoring/grafana/dashboards/05-currency.json`
- `deploy/monitoring/grafana/dashboards/06-risk.json`
- `scripts/verify-monitoring.mjs`
- `Dockerfile.prometheus`（注释 27 → 31）
- `docs/ops/first-deploy.md`（告警类别清单若存在；并注明 outbox 查询按玩法分组）
- `docs/ops/entry-fee-reconcile.md`（若查询受影响，注明多玩法序列口径）

**测试 / conformance**

- `packages/shared/test/*`（新增助手）
- `packages/room-service/test/*`（受影响指标用例）
- `packages/game-service/test/*`
- `packages/robot-service/test/*`
- `packages/user-service/test/*`
- `tools/conformance/src/slices/slice-16-monitoring.ts`
- `tools/conformance/src/slices/slice-18-gold-room.ts`
- `tools/conformance/baselines.json`（仅 slice-16 断言数变化时）

## 8. 测试判据（完成定义）

1. 每个新增/改标签的指标都有单测断言**最终暴露的标签值**（不是只断言过渡变量）；registry 不变量测试通过。
2. `pnpm -C packages/shared test`、`room-service`、`game-service`、`robot-service`、`user-service` 全绿。
3. 对应包 `lint`（`tsc --noEmit` / 包脚本）通过。
4. `node scripts/verify-monitoring.mjs` 通过，且判别力自证：删一条新告警/改回聚合面板 ⇒ 脚本必须红。
5. `pnpm verify:admin` 不受影响（本片不改 admin）。
6. conformance slice-16 / slice-18 的改动在真栈环境可跑；本机无 Docker 时记录为“待权威轮”，不得声称已跑。
7. 工作区干净（除用户已有的未提交文件）。
8. 全量验证：`pnpm exec turbo run test lint --force`（按可执行范围；Cached 不算真跑）。

## 9. 审查记录

### 设计对抗审查（2026-10-25，独立 reviewer）

结论：**需修订后再审**。共 4 阻断 / 12 高 / 若干低。处置如下：

| 编号 | 审查发现 | 处置 |
|---|---|---|
| B1 | conformance 规则数在 slice-16 三处 + slice-18 一处硬编码，spec 漏改 | 已补 §4.5：三处改 31/EXPECTED_RULES.length，slice-18 同步，Dockerfile/注释同步 |
| B2 | `readNestMetrics/sumMetric` 是 slice-16 私有，slice-29 不可用 | 已改：**本片不改 slice-29**（D13），PDK 指标真栈断言另立片；slice-16 复用自身私有 `seriesValue` |
| B3 | 开局失败 reason 缺 `rules`，且原设计用自由文本 | 已改 D4/§4.2：枚举化 `failPdkStart`，补 `rules`，禁止字符串匹配 |
| B4 | “每轮先置零”与“失败保持旧值”矛盾，会假解除钱面告警 | 已改 D6/§5：先读后写；失败保留旧值；补失败单测 |
| H1 | ddz 三条失败路径未计数 | 已补：`bot_fill` / `pending_write` / `on_seats` |
| H2 | `>=5` 漏掉 waiting 超时首次取消 | 已改告警表达式：`cancelled > 0` 分支 |
| H3 | robot 错误指标无分母/无消费 | 已补：`robot_decisions_total` 加 `game_type`，02 面板分组；错误指标覆盖整个 PDK 分支 |
| H4 | 记录 skip/丢记录/sweeper 未计数 | 已补 `record_lost` kind 与 `money_delta` 的 sweeper 写点；旧会话窗口明确不计 |
| H5/H6 | 测试助手 `values[0]`/子集首条会假绿；prom-client 缺标签不抛 | 已改 D5 + §4.6：精确标签读数器、registry 不变量、统一 incGame/setGame |
| H7 | 空串/未知 gameType 可能进标签 | 已改 D2/§5：统一归一 + 入口 WARN |
| H8 | 05-currency 平台级指标无 game_type，静态闸会假绿 | 已改 D8/§4.4：按 `(面板, 指标)` 白名单，明确“不改”清单 |
| H9 | slice-29 无基线、setup 会造房 | 已改 D13：不改 slice-29 |
| H10 | 与 2/4 会话冲突面大 | 已改 D14：独立 worktree/分支；不改 slice-29；player_count 留 B 组 |
| H11 | `phase=record` 是死相位 | 已改：去掉 `record` phase |
| H12 | `risk_scan_hits_total` 无消费者 | 已补：06-risk 扫描面板追加按玩法命中线；设备命中明确不纳入 |
| 低 | 基数算术、注释漂移、notifyRoomEnded、告警重叠、文本解析、pipeline 单键失败、plumbing 参数、02 丢 player_count、HELP 文本、outbox 语义 | 已逐条并入 §4.1–§4.5、§7 |

### 复审

（待独立 reviewer 复审后填写）

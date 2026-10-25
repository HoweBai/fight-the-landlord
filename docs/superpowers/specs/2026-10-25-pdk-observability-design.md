# 跑得快（PDK）可观测性补齐设计（A1 片）

> 日期：2026-10-25 · 状态：已按两轮设计对抗审查修订（待第三轮复审） · 流程：`docs/dev-process.md`
> 前置审计：本会话对 PDK 的监控 / 流水 / 风控三面审计（结论见 §1）。
> 本片只做 **A1 异常监控**；账本维度（A2）、管理端统计（A3）、金币场资金面 conformance 不在本片。

## 1. 背景与问题

PDK 已具备完整的对局、结算、记录、风控主链路，但可观测性存在系统性缺口：

1. **全仓唯一带玩法维度的指标是 `match_queue_length`**（`packages/room-service/src/metrics/room.metrics.ts:73-77`）。其余核心指标全部把 PDK 与斗地主混在一个桶里。
2. **27 条告警规则里 0 条涉及玩法**，8 块 Grafana 看板同样无 `game_type`；`scripts/verify-monitoring.mjs` 不校验告警规则。
3. **PDK 专有失败路径没有指标**：开局失败、规则快照非法、补位失败、`settlePdk` 抛错、记录写失败/丢失、PDK 规则 bot 决策异常、会话损坏。设计 spec 承诺“补位/开局链失败则告警”（`...paodekuai-design.md:731`），实现只有 warn 日志。
4. **日志不可聚合**：PDK 关键链路有日志，但无 `event=`、无 `gameType`。
5. 2/4 人玩法正在另一会话实现；本片不新增 `player_count` 维度，并独立 worktree/分支实施。

目标：让运维能回答“两种玩法各自的业务量、失败面、以及失败能否被主动告警”。

## 2. 范围

### 2.1 做

- 现有核心指标加 `game_type` 标签；新增 4 个失败计数器 + 1 个跳过诊断计数器。
- 机器人决策/失败指标补 `game_type`，让错误率有可计算口径。
- 新增 4 条按玩法的 Prometheus 告警（27 → 31）。
- 更新 4 块现有看板（业务/记录/货币/风控），不新建看板。
- `scripts/verify-monitoring.mjs` 增加告警规则解析与 per-target 看板校验。
- conformance：修正 slice-16/18 的规则数硬编码与文案；C11 增加 `games_started_total` 精确标签增量；slice-18 增加 `games_ended_total` 与 outbox 合计断言；**新增 `slice-30-pdk-metrics`** 做 PDK 指标真栈验证。
- 单测 + 源码闸（禁止直接 .inc/.set）+ 标签声明测试；HELP 文本、告警头注释、`Dockerfile.prometheus`、ops 文档同步。

### 2.2 不做（YAGNI / 边界）

- 不新增 `player_count` 维度（留 B 组）；`match_queue_length` 既有维度保持。
- 不新建 PDK 专属看板/面板、不做监控 runbook 文档。
- 不改 Alertmanager / alert-relay 路由与接收器。
- 不把 `slice-30` 扩成完整 PDK 全链路（只验证指标标签；对局流程复用 `lib/pdk-driver`）。
- 不改 slice-29（2/4 会话正在改它）。
- 不动 `risk_reviews` / `currency_ops` 等账本与管理端结构。
- 不改对局规则、结算算法、协议出站形状。

## 3. 决策表

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 统一标签：现有指标族加 `game_type`，不新增平行 `pdk_*` 指标族 | 单一指标族、旧查询不带标签仍聚合、后续新玩法零复制 |
| D2 | `game_type` 值域 = `GameType`；缺字段/空串/未知在**指标边界**归一为 `doudizhu`，入口 WARN；不宣称与 `parseGameType` 的抛错纪律一致 | 有界标签；`??` 不兜空串，必须显式 `isGameType` |
| D3 | 本片不新增 `player_count` 维度 | 2/4 会话并行；B 组统一加 |
| D4 | 失败计数器的 `reason/phase/kind` 全部枚举；`failPdkStart` 接收枚举 + detail 文本 | 防基数爆炸；调用点映射可测，禁止字符串匹配 |
| D5 | 所有**本片改造**的指标写点经 shared `incGame/setGame`（带 amount 参数）；助手最后写入 `game_type`，调用方不可覆盖。`match_queue_length` 例外（多标签、非本片改造，继续直接 `.set`） | prom-client 少传标签不抛错；只有助手 + 源码闸 + 标签声明测试能防静默缺标签 |
| D6 | 采样类 gauge **先读后写**；整条快照读取失败保留旧值；单键/单条目错误按 ddz 继续并汇总 WARN | 防 Redis 抖动把 `CurrencySettleOutboxStuck` 假解除 |
| D7 | 告警用绝对次数；`for` 5–10m | PDK 初期量小，比例告警不触发 |
| D8 | 看板静态校验按 `(文件, 面板 title, refId, 指标, expectGameType)` 白名单 | 同一面板同时存在“按玩法 target”和“合计/平台 target”，metric 名不足以区分 |
| D9 | `verify-monitoring` 解析告警规则；YAML 语法由 slice-16 promtool 负责 | 职责不重叠 |
| D10 | `publishEnded` 失败计数后 rethrow；`buildRecord` 不包（内部吞错） | 不改错误语义；`phase=record` 是死相位 |
| D11 | PDK bot 失败覆盖整个 PDK 分支（含 feature guard）；错误率公式**分开写**：DouZero `errors / decisions`（失败后仍回落完成决策，errors 是 decisions 子集），PDK 规则 bot `errors / (decisions + errors)`（抛错不进 decisions） | 抛错不进 decisions；单一公式会算错 DouZero 口径 |
| D12 | 无数据库变更；回滚 = revert 提交 | 无 schema 风险 |
| D13 | PDK 指标真栈验证**新建 slice-30**，不改 slice-29 | 避免与 2/4 会话双改；保留端到端证据 |
| D14 | 独立 worktree/分支 `feature/pdk-observability-a1` 实施；**这不消除同文件冲突**，合入顺序由用户/玩法侧决定 | 2/4 与本片高概率改动同一批文件 |

## 4. 实现设计

### 4.1 公共助手与现有指标标签

新增 `packages/shared/src/metrics/game-label.ts`（从 shared 导出）：

```ts
export function normalizeGameType(value: unknown): GameType; // isGameType ? value : 'doudizhu'
export function gameLabel(value: unknown): { game_type: GameType };
export function incGame(
  counter: Counter,
  gameType: unknown,
  amount = 1,
  labels: Record<string, string> = {},
): void; // counter.inc({ ...labels, game_type: normalized }, amount)
export function setGame(gauge: Gauge, gameType: unknown, value: number): void;
```

- `game_type` 由助手**最后**写入，调用方传入同名 label 会被覆盖；测试钉住。
- 助手本身不记日志（shared 无 Nest logger）；入口处（`ws.gateway`、`settle.sweeper`）发现非法非空值时各自 WARN。

现有指标补 `game_type`：

| 指标 | 服务/文件 | 标签 | 写点与说明 |
|---|---|---|---|
| `games_started_total` | room / `rooms.start.ts` | `game_type` | `incGame(...)` |
| `games_ended_total` | room / `ws.gateway.ts` | `game_type` | `isGameType(event.gameType) ? ... : isGameType(event.record?.gameType) ? ... : 'doudizhu'` |
| `rooms_active` | room / `room-metrics.service.ts` | `game_type` | SCAN + pipeline HGET；先读后写 |
| `games_active` | game / `game-metrics.service.ts` | `game_type` | `activeSessionCountByGameType()`；先读后写 |
| `currency_settle_result_total` | room / `settle.service.ts` | `result, game_type` | 所有 inc；`applyGraded/readBalances/dropWarn/dropError` 补 gameType 参数 |
| `currency_settle_residue_total` | room / `settle.service.ts` | `game_type` | `incGame(..., residue)`（0 也 inc 0） |
| `currency_settle_outbox_size` | room / `settle.sweeper.ts` | `game_type` | 两箱按条目分玩法计数；先读后写 |
| `currency_settle_outbox_oldest_seconds` | room / `settle.sweeper.ts` | `game_type` | 分玩法最老年龄；空组 0 |
| `entry_fee_skipped_total` | room / `rooms.start.ts` | `reason, game_type` | 已有 gameType 参数 |
| `entry_fee_conflict_total` | room / `rooms.start.ts` | `game_type` | 已有 gameType 参数 |
| `currency_robot_topup_total` | room / `robot-funding.ts` | `action, game_type` | `applyFunding` 补参数 |
| `currency_robot_ensure_failed_total` | room / `robot-funding.ts` | `game_type` | ensure 失败 |
| `match_predicate_rejections_total` | room / `match.service.ts` | `predicate, game_type` | `randomGreedyPick/accountRejection` 透传 `queue.gameType` |
| `match_selection_rounds_total` | room / `match.service.ts` | `game_type` | 同上 |
| `match_no_legal_group_total` | room / `match.service.ts` | `game_type` | 同上 |
| `records_rows_deleted_total` | user / `records-cleanup.service.ts` | `game_type` | 按 ddz/pdk 两对表分别累计 |
| `records_table_bytes` | user / `records-cleanup.service.ts` | 不加标签 | 四表聚合；HELP 同步 |
| `robot_decisions_total` | robot / `robot.service.ts` | `result, skill, game_type` | 仅**完成**的决策；`req.view.gameType` |
| `robot_decision_errors_total` | robot / `bot.player.ts` | `reason, game_type` | DouZero 失败两处；`req.view.gameType` |
| `risk_scan_hits_total`（新增） | user / `scan.service.ts` | `game_type` | 仅胜率命中；每用户每玩法 +1 |

口径补充：

- `GameEvent` 接口补可选 `gameType`；解析时按 D2 显式归一，不依赖 `??`。
- `games_active` 仍 per-instance；`rooms_active` 仍全栈。
- `rooms_active`：pipeline 整条失败 ⇒ 不写；单键命令错误 ⇒ 该房计 ddz + 本轮汇总 WARN；写两种玩法（缺失 0）只在快照成功时。
- outbox：整条 `hgetall` 失败 ⇒ 不写；单条目 JSON 坏 ⇒ 计 ddz + 汇总 WARN；其余照常分组。
- `risk_scan_hits_total` 只看胜率命中；设备命中不纳入（reasons/score 仍可见）。
- 所有 HELP 同步标签口径。
- `match_queue_length` 不在本片改造范围（已带多标签），源码闸显式豁免。

### 4.2 新增失败/跳过计数器

| 指标 | 服务/文件 | 标签值域 | 写点 |
|---|---|---|---|
| `game_start_failures_total{game_type, reason}` | room / `rooms.start.ts` | `start_rpc` / `pending_write` / `bot_fill` / `rules` / `on_seats` / `cancelled` | `game.start` catch ⇒ `start_rpc`（恰一次）；`failPdkStart` 枚举 `bot_fill｜pending_write｜rules｜null` + detail；取消额外 `cancelled`；ddz 三路径 `bot_fill/pending_write/on_seats` |
| `game_settle_failures_total{game_type, phase}` | game / `game.service.ts` | `settle` / `publish` | 分别包 `runtime.settle` 与 `redis.publish`，计数 + error 日志后 rethrow |
| `record_write_failures_total{game_type, kind}` | room / `ws.gateway.ts` + `settle.service.ts` | `record` / `money_delta` / `record_lost` | `record`：写记录抛错；`money_delta`：`pushMoneyDelta` 失败/部分/入箱失败 + sweeper 重发失败/超龄；`record_lost`：房间存在但形状/玩法不匹配导致丢弃 |
| `record_write_skips_total{game_type, reason}` | room / `ws.gateway.ts` | `room_ttl` | 房间 TTL 过期等**预期窗口**；不告警、仅诊断；旧会话窗口（缺 record/version）完全不计 |
| `robot_rule_errors_total{game_type, reason}` | robot / `bot.player.ts` | `decision_error` | 整个 PDK 分支（含 feature guard）计数后 rethrow |

约束：标签有界；计数与日志同点；`failPdkStart` 不再接收自由文本 reason。

### 4.3 告警规则（27 → 31）

| 告警 | 表达式 | for | severity |
|---|---|---|---|
| `GameStartFailuresHigh` | `(sum by (game_type) (increase(game_start_failures_total[15m])) >= 5) or (sum by (game_type) (increase(game_start_failures_total{reason="cancelled"}[15m])) > 0)` | 5m | warning |
| `GameSettleFailures` | `sum by (game_type, phase) (increase(game_settle_failures_total[10m])) > 0` | 5m | critical |
| `SettleDroppedByGame` | `sum by (game_type) (increase(currency_settle_result_total{result="dropped"}[10m])) > 0` | 5m | warning |
| `RecordWriteFailuresHigh` | `(sum by (game_type, kind) (increase(record_write_failures_total[15m])) >= 3) or (sum by (game_type, kind) (increase(record_write_failures_total{kind="record_lost"}[15m])) > 0)` | 5m | warning |

- 两个 `or` 规则的左右分支标签集**同形**（`{game_type}` / `{game_type,kind}`），不会重复实例。
- `record_write_skips_total` 不告警。
- 复用 severity 路由；不新增接收器。
- 头部注释、`Dockerfile.prometheus`、conformance 规则数同步 27→31（24→28 类）。
- `CurrencySettleOutboxStuck` 表达式不变，但会按玩法各生成实例；文档注明。

### 4.4 看板（4 块，per-target 白名单）

| 看板 | 面板 | 改法 |
|---|---|---|
| 02-business | 匹配队列深度 | `sum by (game_type, mode, player_count, base_score)` |
| 02-business | 活跃房间 / 对局 | `rooms_active` 按玩法 target（refId A）+ **一条合计 target**（`sum(rooms_active)`，refId C，`expectGameType=false`）；`games_active` 按玩法（refId B）+ 合计（refId D，`expectGameType=false`） |
| 02-business | 开局 / 结算速率 | 按玩法 |
| 02-business | 机器人决策速率与失败 | 决策 `sum by (game_type, result, skill)`；DouZero 失败 `sum by (game_type, reason)`；新增 PDK 规则错误 target `sum by (game_type) (rate(robot_rule_errors_total[5m]))` |
| 05-currency | 结算补偿队列最老滞留 | `max by (game_type)` |
| 05-currency | 结算结果速率 | `sum by (game_type, result)` |
| 05-currency | 残差销毁增速 | `sum by (game_type)` |
| 05-currency | 机器人补给/回收速率 | `sum by (game_type, action)` |
| 05-currency | 机器人 ensure 失败累计 | `sum by (game_type)` |
| 05-currency | 台费收/漏 | `sum by (game_type, reason)` / `sum by (game_type)` |
| 04-records | 记录删除速率 | `sum by (game_type)` |
| 06-risk | 谓词拒绝速率 | `sum by (game_type, predicate)` |
| 06-risk | 抽选轮与不成组 | 按玩法 target + 保留平台级拒绝率（`expectGameType=false`） |
| 06-risk | 风险扫描 | 追加 `sum by (game_type) (increase(risk_scan_hits_total[2h]))` |

**不改**：`currency_robot_pool_balance`、`currency_robot_accounts_balance_sum`、`currency_relief_total`、`records_table_bytes`、`risk_scan_runs_total`、`risk_reviews_open`、`risk_actions_total`。

静态闸按 `(文件, 面板 title, refId, 指标, expectGameType)` 白名单校验；合计/平台级 target 显式登记 `expectGameType=false`。

### 4.5 静态闸与 conformance

**`scripts/verify-monitoring.mjs`**

- 剥注释行，按行首 `^\s*-\s+alert:` 切块；只从 `expr:` 行提取表达式。
- 规则名集合**等于** 31 条 EXPECTED 集合；4 条新规则 `expr` 含 `game_type`，并断言关键谓词（`cancelled` / `phase` / `dropped` / `record_lost` / 阈值）与规则名唯一。
- 头部注释断言 31 条 / 28 类。
- 看板按 per-target 白名单断言；对合计/平台 target 断言**不含** `game_type`。
- 判别力自证：删一条告警或把按玩法 target 改回聚合 ⇒ 必须红（计划中记录手工验证）。
- `EXPECTED_RULES` 与 slice-16 的名单：两处独立维护，但都指向同一 yml；任一处漂移会各自红（在计划中注明同步点）。

**conformance**

- `slice-16-monitoring.ts`：
  - 4 个 27 字面量全部改 31/`EXPECTED_RULES.length`：`:93`（注释）、`:704-705`（条件+消息）、`:767-768`（条件+消息）；
  - `EXPECTED_RULES` 追加 4 名；
  - C11：在 `room.match` **之前**取 `gamesStartedBefore`（精确标签 `{game_type:"doudizhu"}`），局内用**标签感知的有界轮询**（新增 `pollSeriesValue`，不能用现有 `pollRead` 的 `sumMetric`）断言增量 ≥1；**不**断言 `games_ended_total`（C11 不打完）。
- `slice-18-gold-room.ts`：
  - `:1575` 条件+消息 27→31；
  - 在 E 组 `runGoldGame` **之前**取 `gamesEndedBefore = seriesValue(roomMetrics, 'games_ended_total', {game_type:'doudizhu'}) ?? 0`；F 组金币局结束（`game.settlement`）后有界轮询断言 `>= gamesEndedBefore + 1`；
  - outbox 读数从 `seriesValue(...,{})` 改为 `sumMetric(roomMetrics, ...)`（跨玩法合计）；`oldest` 当前只断言 0，sum 可用（未来断言非零时改 max）；
  - `terminalSettles`（ok|replayed）改为按 `result` 对多序列求和（`sumMetricWhere`），不得用 `seriesValue` 首条；
  - `baselines.json` slice-18 `150 → 151`。
- **新增 `slice-30-pdk-metrics.ts`**：
  - 复用 slice-29 的 `enablePdk()` 形态：同时开 `game.paodekuai.enabled` 与 `game.paodekuai.friendRoomEnabled`（`POST /api/rooms` 探测会被好友房闸拦 12006），用**探测建房**轮询至生效；finally 两键都还原 false；探针账号用不同序号（避免复用 slice-29 的等待房撞 12011）；
  - 自带/复用 `tools/conformance/src/lib/prom-text.ts`（新增：`parseProm/seriesValueExact/sumMetric/execCurl`），不复制第三份解析器，也不改 slice-16/18 现有私有实现；
  - 取 room-service `games_started_total{game_type="paodekuai"}` 基线 → `startPdkRoom` → 局中断言 started 增量；
  - `playPdkToEnd` 后断言 `games_ended_total{game_type="paodekuai"}` 增量；
  - 指标读取：`execCurl('ftl-room-service', 9002, INTERNAL_TOKEN)`；
  - 加入 `run.ts` 的 `CASES` 与 `--list` 顺序；`baselines.json` 新增 `slice-30-pdk-metrics`（源内静态计数，CI 权威轮校正）。
- `Dockerfile.prometheus` 注释 27→31。
- 若 slice-16/18 断言数变化，更新 `baselines.json` 对应切片。

### 4.6 单测

- shared：`game-label.test.ts`（`normalizeGameType` 空串/未知/undefined；`incGame` amount=0/2；labels 不能覆盖 game_type）。
- room-service：`rooms.start`（started + 6 reason + 不重复计 start_rpc）、`ws.gateway`（ended 标签 + record/record_lost/skips）、`settle.service`（result/residue + money_delta 三处）、`settle.sweeper`（outbox 分玩法 + hgetall 失败保持旧值）、`robot-funding`、`match.service`（三指标标签）、`room-metrics.service`（分玩法 + pipeline 失败保持旧值）。
- game-service：`publishEnded` settle/publish 失败计数 + rethrow；`games_active` 分玩法（fake 补新方法）。
- robot-service：PDK 分支异常含 feature guard；`robot_decisions_total` 标签；DouZero errors 标签；PDK 日志不打印 ddz 模型名；HELP/注释写明两条错误率公式（DouZero `errors/decisions`、PDK `errors/(decisions+errors)`）。
- user-service：`records_rows_deleted_total` 分玩法（0/2 行）；`risk_scan_hits_total`。
- 测试助手：新增精确标签读数器；替换 `values[0]` 用法于本片用例；新增源码闸（src 下禁止对目标指标直接 .inc/.set）与各包标签声明测试（incGame 写入不抛错且序列带合法 game_type）。
- `packages/room-service/test/client-message-wiring.gate.test.ts` 的 metrics mock 补新导出。
- `packages/user-service/test/records-cleanup.test.ts` 的 `simpleMetric` 改为标签感知。

## 5. 边界与错误处理

- **不吞错**：新增计数在 catch 内计数后 rethrow；不改状态机。
- **采样失败语义（D6 的唯一解释）**：
  1. 整条快照读取失败（SCAN/pipeline/hgetall 抛错）⇒ 不写任何序列，保留旧值，WARN；
  2. 快照成功但单键/单条目坏 ⇒ 该项归 ddz，本轮汇总一条 WARN，其他项照常写；
  3. 每次成功快照后显式写两种玩法（缺失组 0）。
- **标签归一**：只经 `normalizeGameType`；空串/未知在入口 WARN；禁止 `undefined`/`""` 进标签。
- **基数**：`game_type` 2；`reason/phase/kind` 合计固定 ≤ 13；无自由文本标签。
- **看板兼容**：旧 PromQL 不带标签仍聚合；不改 uid/title；平台级指标不强行分组。

## 6. 风险与回滚

| 风险 | 影响 | 处置 |
|---|---|---|
| 与 2/4 同文件并行 | 合并冲突 | D14 独立 worktree/分支；合入顺序由用户/玩法侧定；本片不改 slice-29 |
| 现有单测按无标签断言 | 测试红 | 同步更新；逐包跑 |
| prom-client 少传标签不抛错 | 静默缺标签 | D5 助手 + 源码闸 + 标签声明测试 |
| 采样读取失败写 0 | 告警假解除 | D6 三分支语义 + 失败单测 |
| `rooms_active` 新增 HGET | Redis 负载小幅上升 | pipeline 批量；房间量级小；单轮失败保留旧值 |
| 告警阈值初期噪声 | 误报 | 绝对次数 + for；上线后调参（发版） |
| `publishEnded` 包装 | 卡局/重复结算 | 仅计数后 rethrow；单测钉住 |
| outbox gauge 变多序列 | 旧单序列读取口径变化 | slice-18 改 `sumMetric`；文档注明 |
| slice-30 增加真栈时长 | CI 时间 | 只打一局 PDK；复用 pdk-driver |

回滚：revert 本片提交；无 DB/协议变更。

## 7. 涉及文件

**生产代码**

- `packages/shared/src/metrics/game-label.ts`（新增）+ `packages/shared/src/index.ts`
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
- `deploy/monitoring/grafana/dashboards/{02-business,04-records-backup,05-currency,06-risk}.json`
- `scripts/verify-monitoring.mjs`
- `Dockerfile.prometheus`
- `docs/ops/first-deploy.md`（告警类别清单若存在 + outbox 查询按玩法分组说明）
- `docs/ops/entry-fee-reconcile.md`（若查询受影响）

**测试 / conformance**

- `packages/shared/src/metrics/game-label.test.ts`（新增；shared 无独立 test/ 目录）
- `packages/room-service/test/*`、`packages/game-service/test/*`、`packages/robot-service/test/*`、`packages/user-service/test/*`
- `tools/conformance/src/slices/slice-16-monitoring.ts`
- `tools/conformance/src/slices/slice-18-gold-room.ts`
- `tools/conformance/src/slices/slice-30-pdk-metrics.ts`（新增）
- `tools/conformance/src/run.ts`
- `tools/conformance/baselines.json`

## 8. 测试判据（完成定义）

1. 每个改造指标都有单测断言最终标签值；源码闸与标签声明测试通过。
2. `packages/shared` / `room-service` / `game-service` / `robot-service` / `user-service` 测试全绿，对应 `lint` 通过。
3. `node scripts/verify-monitoring.mjs` 通过；判别力自证（删告警/改聚合 ⇒ 红）。
4. `pnpm verify:admin` 不受影响。
5. slice-16/18/30 在真栈可跑；本机无 Docker 时记录“待权威轮”，不得声称已跑；`baselines.json` 按静态计数/实测回填。
6. 工作区干净（除用户已有未提交文件）。
7. 全量验证：`pnpm exec turbo run test lint --force`（可执行范围；Cached 不算真跑）。

## 9. 审查记录

### 第一轮设计对抗审查（2026-10-25）

结论：需修订后再审（4 阻断 / 12 高）。处置见提交 `b02d03ef`。

### 第二轮设计对抗审查（2026-10-25）

结论：仍需修订（2 新阻断 / 6 新高 / 若干低）。逐条处置：

| 编号 | 发现 | 处置 |
|---|---|---|
| N1 | `incGame` 无增量参数，residue/records 无法实现 | 已改 §4.1：`incGame(counter, gameType, amount=1, labels?)`；补 0/2 用例 |
| N2 | C11 不可能有 `games_ended_total` 增量 | 已改 §4.5：C11 只断言 started；ended 移到 slice-18 |
| N3 | 看板白名单无法表达合计/平台 target | 已改 D8/§4.4/§4.5：per-target + `expectGameType` |
| N4 | 机器人失败面板指标无 `game_type` | 已改 §4.1/§4.4：`robot_decision_errors_total` 补 `game_type`，面板同时展示 DouZero 与 PDK 规则错误 |
| N5 | `robot_decisions_total` 不是抛错分母 | 已改 D11/§4.4：明确“仅完成决策”，错误率 = errors/(decisions+errors) |
| N6 | `RecordWriteFailuresHigh` 右分支标签集不同 | 已改 §4.3：右分支补 `kind`，两分支同形 |
| N7 | 去掉 slice-29 后无 PDK 真栈验证 | 已改 D13/§4.5/§7：新增 `slice-30-pdk-metrics` 作为交付物 |
| N8 | C11 缺基线/轮询；`seriesValue` 非精确 | 已改 §4.5：`room.match` 前取基线、有界轮询、精确标签 |
| N9 | §5 读取失败语义冲突 | 已改 §5：三分支写死 |
| N10 | `record_lost` 对 room TTL 噪声 | 已拆 `record_write_skips_total{reason=room_ttl}`，不告警 |
| N11 | slice-18 outbox 读数只读第一条 | 已改 §4.5：改 `sumMetric` |
| 低 | shared 测试路径、注释漂移、D2 措辞、`??` 空串、助手 WARN、risk hits 窗口、labels 覆盖顺序、两份规则名单、D14 措辞、HGET 负载 | 已逐条并入 §4–§7 |

### 第三轮复审（2026-10-25）

结论：**可进入实现计划（无新阻断）**。N1–N4、N6–N11 已按源码闭合；进入计划必须落进验收的 3 项：

| 编号 | 发现 | 处置 |
|---|---|---|
| N5 | robot 错误率公式对 DouZero 不成立（失败后仍完成决策，errors 是 decisions 子集） | 已改 D11：DouZero `errors/decisions`、PDK 规则 `errors/(decisions+errors)` 分开写明 |
| N2 补充 | slice-18 的 `games_ended_total` 断言缺基线位置 | 已改 §4.5：E 组前取 `gamesEndedBefore`，F 后轮询 `>= before+1`；baseline 150→151 |
| N7 补充 | slice-30 必须等待 PDK 开关生效，且需自带指标解析助手 | 已改 §4.5：复用 enable+探测建房；新增 `lib/prom-text.ts` |
| 低 | 02 合计线应为两条、C11 轮询需标签感知、outbox oldest 跨玩法用 sum 的语义 | 已并入 §4.4/§4.5 |

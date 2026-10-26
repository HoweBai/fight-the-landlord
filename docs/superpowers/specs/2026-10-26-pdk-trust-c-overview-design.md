# C 组（记录可靠性 + 资金对账 + 资金异常检测）总设计

> 日期：2026-10-26 · 状态：待设计对抗审查 · 流程：`docs/dev-process.md`
> 前置：A1（监控）、A2（账本玩法维度）、A3（管理端统计）、B（风控 / 2–4 人）均已合入 `dev`（`origin/dev@7460a3ce`）。
> 本文件只定 **C 组分片边界、依赖、顺序与跨片口径**；每片开工时另立详细 spec（C1 已立）。

## 1. 背景与审计结论

C 组处理「钱与记录的可信度」三件事：记录不能丢（C1）、钱和记录必须对得上（C2）、异常资金行为要看得见（C3）。

2026-10-26 对 `origin/dev@7460a3ce` 的审计结论：

| 面 | 现状 | 证据 |
|---|---|---|
| 记录写入 | `record.write` **单次尝试、3s 超时、不重试**；失败即永久丢该局记录（只记 error + `record_write_failures_total{kind=record}`） | `packages/room-service/src/gateway/record.client.ts:28-33`；`ws.gateway.ts:1053-1142`（`finalizeRoomEnd`）、`:1176-1270`（`writeGameRecord`） |
| 记录幂等 | 接收侧以 `(room_code, game_version)` 唯一键幂等（ddz `uk_room_version`、pdk `uk_pdk_room_version`）⇒ 重投安全 | `packages/user-service/src/migrations/1789400000000-GameRecords.ts`、`1796300000000-PdkRecords.ts` |
| 现有 outbox | 只有 `settle:outbox` / `recordmoney:outbox` 两个**结算后**货币补偿箱；`SettleSweeper` 每 10s 扫一轮 | `packages/room-service/src/currency/settle.service.ts:66-75`、`settle.sweeper.ts` |
| 资金对账 | 现有 `ReconcileService` 只做「账户余额↔流水」「缓存一致性」「孤儿赠送」「机器人池」四类；**不碰对局记录** | `packages/currency-service/src/reconcile/reconcile.service.ts` |
| 记录↔资金关联键 | `currency_ops.source='game_settle'` 的 `ref_id=<room>:<version>`、`action_id=settle:<room>:<ver>[:r2]`；`entry_fee` 的 `action_id=entryfee:<room>:<owner>`、`ref_id=<room>` | `settle.service.ts:238-240, 538-540`；`rooms.start.ts:785-794` |
| 金额口径 | `money_delta` **不等于** `score_change`：输家按余额截断、赢家扣抽水并可能产生 residue/rake 销毁 | `settle.service.ts` 的 `computeSettlement`（§4 伪码） |
| 数据库 | 所有服务**共库** `fight_the_landlord` ⇒ currency-service 可在同库只读 JOIN `game_records(_pdk)` | `packages/currency-service/src/database.config.ts:28,36-39` |
| 异常检测 | 全仓无 AML/对刷实现；现有扫描只有胜率 + 设备数；`risk:hit:{userId}:sameIp` 只是匹配期拒绝计数 | `packages/user-service/src/risk/scan.service.ts`、`reviews.service.ts` |
| IP 历史 | **没有落库**：IP 只在匹配队列元数据里瞬时可见；`user_devices` 只存 `device_id` | `packages/room-service/src/match/predicates.ts`、`packages/user-service/src/migrations/1790000000000-RiskControl.ts` |

## 2. 分片

| 片 | 目标 | 交付物 | 依赖 |
|---|---|---|---|
| **C1 记录链可靠性** | `record.write` 失败不再永久丢记录：durable outbox + 幂等重投 + sweeper + 指标/告警；旧记录/旧条目缺省 `doudizhu` | 独立 `record:outbox` Hash、sweeper 扩展、2 条新告警、单测、conformance 真栈片 | 无（C 组第一片） |
| **C2 资金↔记录对账** | 周期性核对 `game_settle`/`entry_fee` op ↔ 对局记录 ↔ `money_delta`/`score_change`；输出孤儿/缺失/金额不一致指标与告警，管理端可查；**只告警/报告，不自动改钱** | 扩展 `ReconcileService` 新检查 + 新指标/告警 + 管理端对账面板字段 + 单测/真栈片 | C1（记录可靠后对账噪声才可控） |
| **C3 资金异常检测** | 首版可解释信号：同设备同桌、对子胜率集中、24h 高频对子、高抽水/高流水；接入现有 `risk_reviews`/告警；不自动封禁 | 扫描扩展 + 新指标 + 审核队列 reason + 告警 + 单测/真栈片 | C2（金额口径与记录字段口径已钉） |

### 2.1 不做（全组）

- 不重做 A1 指标/告警/看板；不改 A2 账本结构；不改 B 风控阈值。
- 不改对局规则 / 结算公式 / 协议出站形状。
- 不做跨玩法统一历史/排行榜（C4，另立项）。
- 不打开任何玩法/场次开关、不部署、不碰 `master`。
- 不自动封禁；C3 允许参与现有自动限流（用户裁决，见 §3），但封禁恒为人工动作。
- 不新增历史 IP 采集（C3 首版登记为缺口）。

## 3. 用户裁决（2026-10-26）

| # | 决策 | 结论 |
|---|---|---|
| U1 | 开工顺序 | **C1 → C2 → C3**，一次只做一片 |
| U2 | C1 outbox 形态 | **独立 `record:outbox` Hash + 复用现有 `SettleSweeper` 10s 循环**（不与 settle/recordmoney 混箱） |
| U3 | C1 重试策略 | **24h TTL、每 10s 重投、单轮最老优先最多 100 条**；`oldest > 10m` 告警、`abandoned/corrupt > 0` 升级 critical |
| U4 | C2 粒度 | **逐笔结算 op + 最近 48h 滚动窗，每 1h 一轮** |
| U5 | C2 不一致处置 | **只告警/报告，不改钱**；管理端可查明细 |
| U6 | C3 范围 | **两玩法通用信号 + PDK 2 人专属信号** |
| U7 | C3 信号 | 四个全做：同设备同桌（7d≥3 局）、对子胜率集中（7d≥5 局且同方胜率≥80%、净赢≥1000 金币）、24h 同对子≥10 局、高抽水/高流水（24h 抽水上界≥5000 金币且≥20 局） |
| U8 | C3 同 IP | **首版不做**，登记「历史 IP 无存储」为已知缺口 |
| U9 | C3 命中动作 | **参与现有自动限流**（score +25；与胜率/设备叠加到线可自动限流）；**不自动封禁** |
| U10 | 保留期 | **沿用现有 365 天**；C2/C3 只读短窗口（48h / 24h / 7d），不新增保留期配置键 |

## 4. 跨片口径

### 4.1 玩法归一

- 所有新指标/日志/条目一律经 `normalizeGameType`（shared `game-label.ts`）：合法值原样，缺省/空串/未知 ⇒ `doudizhu`。
- 旧记录、旧 outbox 条目、旧 `risk_reviews.reasons` 缺 `gameType` ⇒ 按 `doudizhu` 解释；新写入恒带显式玩法。

### 4.2 指标与告警

- 新指标全部带 `game_type` 标签；写点经 `incGame`/`setGame`（源码闸 `metrics-game-type-invariant` 的目标清单**按片**累加：C1 +3，C2/C3 各自另计）。
- 新告警进 `deploy/monitoring/prometheus/rules/ftl-alerts.yml` 唯一真源；头部计数、`scripts/verify-monitoring.mjs` 的 `EXPECTED_ALERTS`/谓词、`Dockerfile.prometheus` 注释同步。
- 告警阈值改动 = 发版（规则进镜像）；首版按用户裁决的绝对阈值，上线后按观测调参。

### 4.3 数据面纪律

- **只读跨域查询**：C2 在 currency-service 内同库只读 JOIN `game_records(_pdk)` / `game_record_players(_pdk)`；不写记录表、不改钱。
- **金额判定不做等值**：`money_delta` 与 `score_change` 的关系是「符号一致 + 幅度约束 + 逐座流水精确相等 + 守恒（Σmoney_delta + burned_residue + burned_rake = 0）」；具体 SQL/判定在 C2 spec 钉死。
- **记录保留期不变**：现有 `record.retentionDays`（种子 365）与风控设备保留期不动。

### 4.4 机械闸

- 每片若新增表/列/配置键：同步 migration up/down、旧数据缺省、protocol/config-service/admin/静态闸/键计数/conformance —— 本组当前预期 **C1 零 DB/零配置键/零协议**，C2/C3 的增量在各自 spec 中列明。
- 每片结束跑：`pnpm exec turbo run test lint --force`、`node scripts/verify-admin-static.mjs`、`tools/conformance` tsc；能起真栈再补对应 slice。

## 5. 顺序、依赖与合并策略

1. **C1**：从 `origin/dev` 开 `feature/pdk-trust-c`（worktree `D:\Code\ftl-trust-c`）；完成后合 `dev`、推送；C2 从更新后的 `dev` 开新分支（或同分支连续提交，但每片独立审查/验证）。
2. **C2**：依赖 C1 的 outbox 指标/告警口径与「记录可重投」语义。必须吸收 C1 的三条边界：
   - **缺失记录的宽限 ≥ 24h**（C1 `record:outbox` TTL）：op 年龄 <24h 且无记录 ⇒ 归「待定/在途」桶，
     不报孤儿；≥24h 仍无记录 ⇒ 孤儿（op 存在、记录不存在）。
   - **`money_delta` 永久 NULL**：`recordmoney:outbox` TTL 仍是 1h（C1 不改）；金币局记录晚到 >1h 时
     该列永久 NULL。C2 对「结算 op 存在 + op 年龄 >1h + money_delta NULL」判**已知终态**，
     单独计数/报告，不算金额不一致；不得自动补写。
   - currency-service 读不到 room-service 的 `record:outbox`；C2 只能靠年龄宽限与 C1 指标/告警
     做间接判定，C2 spec 必须把「待定/孤儿/已知终态」三态写死。
3. **C3**：依赖 C2 的金额口径（`money_delta`/`score_change`/`burned_rake` 的可解释关系）；扫描与
   对账共用 `game_type` 归一与保留期。记录可能晚到最多 24h（C1）：C3 必须按 `ended_at`（对局结束
   时刻）而非入库时刻扫窗；晚到记录在下一轮扫描进入窗口，但若晚到时间超过扫描窗口长度，
   可能永远漏计——在 C3 spec 登记该边界。
4. **不合 master、不部署**；是否合 master / 发版由用户在本组交付报告后决定。

## 6. 风险与回滚

| 风险 | 片 | 处置 |
|---|---|---|
| Redis 仅 RDB 持久化（镜像默认），进程/主机崩溃可能丢最近一段 outbox | C1 | C1 spec 登记为已知限制；建议运维评估 AOF（`appendonly yes`）作为部署侧后续项，不纳入 C1 代码范围 |
| 下游长时间不可用 ⇒ outbox 积压/单轮耗时 | C1 | 单轮 ≤100 条 + **2s 墙钟预算**、TTL 24h、`oldest` 告警；积压超限人工介入；实测仍拖慢结算补偿则升级为独立 sweeper |
| 记录晚到（≤24h）与 C2 孤儿判定/C3 窗口冲突 | C1→C2/C3 | C2 缺失记录宽限 ≥24h + 三态；C3 按 `ended_at` 扫窗并登记窗口边界（见 §5.2） |
| 多实例 sweeper 重复投递/全局 gauge 被 sum 放大 | C1 | 重复投递由接收侧幂等吸收；`record_outbox_size` 用 `max by (game_type)`；当前单实例部署，加锁另立项 |
| 对账查询量随记录量增长 | C2 | 48h 滚动窗 + 索引（`idx_ended_at`/`idx_pdk_ended_at`/`action_id` 唯一键）；轮末限时 |
| 对账误报（截断/抽水/全零局） | C2 | 判定分「不一致 / 待定（在途）/ 已知终态（dropped）」三态；只报不改 |
| AML 误报/噪声 | C3 | 阈值保守、可解释 reason、人工审核队列；允许现有自动限流但不封禁 |
| 与并行工作同文件冲突 | 全组 | 独立 worktree/分支；每片从最新 `dev` 开；不改 slice-29 与用户未提交的 `PdkSettlement.vue` |

**回滚**：每片无 DB 迁移（C2/C3 若需迁移会在各自 spec 单列 up/down）；C1 回滚 = revert + `DEL record:outbox`（仅在全箱已清空/已导出时；否则会丢待投记录），其余片同理按各自 spec。

## 7. 验证策略与环境

- 当前本机 Docker 不可用（`docker info` 连接失败）⇒ 真栈片先实现、`tsc`/lint 通过，**如实登记「待权威轮」**；不在报告中声称已跑真栈。
- 单测/静态闸必须在本机全绿（`turbo run test lint --force`，Cached 不算真跑）。
- 合 `master` 的权威轮：CI + conformance + 迁移 up/down（若 C2/C3 有迁移）+ 镜像构建；具体在交付报告列出。

## 8. 交付物

- 本总 spec + 每片 spec/plan + 每片代码审查记录。
- 代码提交（每任务一提交，带 attribution）。
- 每片验证证据（测试数量/结果、静态闸、真栈待跑项）。
- 最终 C 组交付报告：分支/SHA、分片完成情况、migration/回滚、最终行为、未跑真栈项、合 dev/master 建议。

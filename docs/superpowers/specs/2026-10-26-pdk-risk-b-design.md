# 跑得快风控 / 金币门槛 / 2–4 人收口（B 组）· 设计 v1.0

> 日期：2026-10-26 · 状态：待设计对抗审查 · 流程：`docs/dev-process.md`
> 分支：`feature/pdk-risk-b`（worktree `D:\Code\ftl-pdk-risk-b`），基线 `origin/dev@e1663df8`
> （已含 A1 `93ca8394`、A2/A3 `22660498`、2/4 人并行工作 `e1663df8`）。
> 前置阅读：`docs/dev-process.md`、`2026-10-25-pdk-observability-design.md`、
> `2026-10-25-pdk-risk-scan-design.md`、`2026-10-25-pdk-two-player-design.md`、
> `2026-10-25-pdk-four-player-design.md`、`docs/games/paodekuai.md`。

## 0. 用户裁决（2026-10-26）

| # | 问题 | 裁决 |
|---|---|---|
| U1 | 2/3/4 人胜率阈值怎么拆 | **三套显式键**（2/3/4 各一对）；现有两键保留为读取回退 |
| U2 | 含机器人座的整局是否剔除 | **仅 PDK 整局剔除**；DDZ 行为不变 |
| U3 | PDK 单玩法命中是否单独自动限流 | **PDK 独立阈值键**（默认 50，可调 25） |
| U4 | 14003 门槛是否按人数/手牌/倍数调整 | **保持现状 + 输光截断兜底** |
| U5 | `risk_reviews` 玩法维度 | **加 `game_type` 列**（旧行缺省 ddz） |
| U6 | 风控 SQL 失败处理 | **按玩法隔离 + 冻结保护 + 新失败指标/告警** |
| U7 | slice-29 与新口径冲突 | **允许最小改 slice-29 的风控造数**（仅测试夹具；见 D31） |

## 1. 背景与问题

B 组要收口 2/4 人落地后暴露的风控与金币场缺口。逐条对应审计锚点：

1. **按人数混算胜率**：PDK 扫描 SQL 只按 `user_id` 分组，2/3/4 人样本混在一起
   （`packages/user-service/src/risk/scan.service.ts:63-64,334-338`），三类人数共用一个
   `game.paodekuai.risk.winRateThreshold`（`1796700000000-PdkRiskConfigSeed.ts`）。
   2/3/4 人基准胜率约 50%/33%/25%，同一 0.8 对 4 人极严、对 2 人极松。
2. **机器人陪玩局污染人类样本**：PDK 扫描只过滤机器人**玩家行**（`p.is_robot = 0`），
   不排除“含机器人座的整局”。PDK 免费场/金币场默认补 bot
   （`1796600000000-SplitGameConfig.ts:58-66` 的 `freeBotFillEnabled`/`goldBotFillEnabled`
   默认 `true`；`rooms.start.ts` 的 `fillBots`），人类与 bot 同桌的胜率会被抬高。
3. **PDK-only 永不自动限流**：单个胜率命中项 25 分，自动限流线 50 分
   （`reviews.service.ts:115-117,230-255`）；PDK-only 命中只有 25 分 ⇒ 只能人工处置。
4. **审核队列没有玩法维度**：`risk_reviews` 无 `game_type` 列
   （`packages/user-service/src/migrations/1790000000000-RiskControl.ts:46-60`），列表只能按
   `status` 过滤；PDK 命中与 DDZ 命中在队列里不可区分。
5. **PDK SQL 失败拖垮整轮**：扫描按 ddz SQL → pdk SQL → device SQL 顺序执行
   （`scan.service.ts:304-317`）；任一抛错 ⇒ `runs{fail}`、整轮不写、DDZ 检测同轮停摆。
6. **金币门槛与 PDK 最大损失不匹配**：14003 只按 `底分 × entryMultiplier`
   （`message.router.ts:605-611`，默认 10×）；PDK 单局名义最大损失 =
   剩余张数 × 底分 × 倍数上限（2/3 人 16×64、4 人 12×64；`pdk/settle.ts:60-84`、
   `pdk/rules.ts:26`）。实际支付由输光截断兜底（`settle.service.ts:173,208-220`）。
   机器人水位 `top = max(baseScoreLevels) × entryMultiplier`
   （`robot-funding.ts:217-228`），与房间档位无关；需核对 2/4 人路径与截断后行为。
7. **2/4 人金币/风控真栈覆盖缺口**：slice-18/25 是 DDZ，slice-29 是 PDK random 3 人
   （2/4 组是 random），slice-31 是 PDK gold 3 人（A2/A3）。缺 PDK 金币 2/4、14003 2/4、
   rake>0、截断、2/4 匹配谓词、2/4 结算/机器人资金的真栈或单测覆盖。

## 2. 范围

### 2.1 做

- **B1 风控口径**
  - 新增 6 个按人数阈值键 + 1 个 PDK 自动限流阈值键；PDK 扫描样本按 `player_count` 拆开。
  - PDK 扫描与管理详情整局剔除含机器人座的记录；DDZ 不变。
  - `risk_reviews.game_type` 列 + 写入推导 + 列表筛选/展示；旧行缺省 `doudizhu`。
  - 扫描 SQL 按玩法隔离：单玩法失败只跳过该玩法，冻结该玩法已有审核行；新增
    `risk_scan_sql_failures_total{scope}` 指标与 `RiskScanSqlFailures` 告警。
  - PDK 自动限流阈值键：`game.paodekuai.risk.autoThrottleScore`（25–50，默认 50）。
- **B2 金币门槛与最大损失**
  - 14003 公式保持 `baseScore × entryMultiplier`；补 PDK 2/3/4 金币门槛单测与真栈切片。
  - 核对机器人资金水位在 PDK 2/4 结算/截断/补给路径的行为，补单测；不改水位公式。
  - 新增 conformance `slice-32-pdk-risk-gold`：PDK gold 2/4、14003、rake>0、截断后余额、
    2/4 匹配谓词、结算/记录、风险扫描按人数/玩法维度、机器人局剔除、PDK 自动限流。
- 配置机械闸：protocol/config-service 种子/admin IA/静态闸/键计数/conformance 同步。
- 文档：`docs/design.md`、`docs/games/paodekuai.md`、`docs/client-protocol.md`、
  `docs/ops/first-deploy.md`、回滚 runbook、偏差台账。

### 2.2 不做（YAGNI / 边界）

- 不做 A2/A3（账本维度、玩家管理统计、财务页）——已由 A2/A3 落地，本片只读其口径。
- 不做 C 组（record.write outbox/对账、反洗钱）。
- 不重做 A1 的指标/告警/看板；仅新增 B 必需的 `risk_scan_sql_failures_total` 与一条告警。
- 不改对局规则、结算公式、协议出站形状。
- 不打开生产 2/4 开关（`game.paodekuai.nonThreePlayerEnabled`/`twoPlayerEnabled` 保持现状）。
- 不改 `apps/client/src/components/PdkSettlement.vue`（用户未提交 WIP）。
- 不改 slice-29 的 2/4 对局流；仅按 U7/D31 最小改 ⑥ 风控造数（键名 + 3 真人），
  B 的新增真栈覆盖仍新建 slice-32。
- 不改 DDZ 扫描 SQL / DDZ 管理详情统计 / 玩家管理列表口径。
- 不把设备命中（`risk.deviceLimit`）玩法化；设备仍是平台级。
- 不做按玩法归一化胜率（用户选显式键）。
- 不改 `risk_reviews` 之外的表结构；`risk_actions` 不变。
- 不做机器人水位公式改造（核对后保持现状，见 D29；经济面风险登记）。

## 3. 方案对比与推荐

### 3.1 人数阈值（U1）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（选用）** | 2/3/4 各一对显式键；现有两键作 fallback | 运营可分别调；键名直白；回退兼容 | 6 个新键 + 机械闸 |
| B | 只加 2/4 覆盖键，3 人沿用旧键 | 4 个新键 | “三套”不对称；运营易误解旧键 |
| C | 归一化胜率（winRate ÷ 1/N） | 键少 | 运营不直观；历史口径变化大；用户未选 |

**选用 A**。种子全部 0.8/100（保持当前行为，运营按实际人口调）；旧 PDK 两键**保留可写**，
但只作为 `playerN` 键缺失时的回退（新键优先）。slice-29 ⑥ 已按 U7/D31 改用 `player3.*` 键，
不再依赖旧键可写。

### 3.2 机器人局（U2）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（选用）** | PDK 整局剔除含 `is_robot=1` 座的记录 | 人类 vs 人类样本干净；DDZ 零改动 | PDK 样本变小 |
| B | DDZ/PDK 都整局剔除 | 口径一致 | 改变既有 DDZ 检测；样本显著缩小 |
| C | 保持行级过滤 | 零改动 | 胜率被 bot 抬高 |
| D | 仅剔除全 bot 局 | 保留混合局样本 | 人机混合局仍污染 |

**选用 A**：B 组只对 PDK 负责；DDZ 行为不变是 A1/风控片的既有纪律。管理详情 PDK 统计
同口径（否则运营看到的胜率与扫描判定不一致）；DDZ 详情不变；玩家管理列表（A3）不变。

### 3.3 自动限流（U3）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A | 保持账号级 50 | 零改动 | PDK-only 永不自动限流 |
| **B（选用）** | 新增 PDK 独立阈值键（默认 50） | DDZ 不变；PDK 可按 25 开 | 1 个新键 + 状态机取线逻辑 |
| C | 全局降到 25 | 简单 | DDZ 单命中误伤面大 |
| D | PDK 命中计 50 | 不改阈值 | 破坏“命中项×25”与 dismissed/revive 语义 |

**选用 B**。有效线 = `PDK 命中 ? min(50, pdkAutoThrottleScore) : 50`；只影响 PDK 胜率注入的
审核行；设备/platform 行仍走 50。`dismissed` 同分不复活语义不变（人工 dismiss 是显式豁免）。

### 3.4 14003 门槛（U4）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（选用）** | 保持 10× 底分 + 输光截断 | 零行为变化；入场体验不变 | 极端局可一次输光 |
| B | 至少覆盖一手最大手牌（16×/16×/12×） | 略降 all-in 观感 | 仍远低于倍数上限 |
| C | 新增可调损失倍数键 | 运营可调 | 多一个键 + 机械闸 |
| D | 覆盖最大名义损失（1024×/768×） | 覆盖极端局 | 把绝大多数玩家挡在门外 |

**选用 A**。14003 是“最低入场余额”，不是“覆盖最大损失”；输光截断（`pay = min(应付, 余额)`）
已是既有安全网。补 2/4 真栈证明不出现负余额、截断按余额支付、赢家按截断池分摊。

### 3.5 `risk_reviews` 玩法维度（U5）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（选用）** | 加 `game_type varchar(16)` + 索引 | 筛选稳定、可索引、旧行默认 ddz | 一次迁移 |
| B | 只解析 `reasons` JSON | 无迁移 | 旧行无 gameType；筛选脆；JSON 函数 |
| C | 加 JSON 数组列 | 可精确表达 mixed | 多值索引/查询复杂，超当前规模 |

**选用 A**。值域 `doudizhu | paodekuai | mixed | platform`；写入时由 `reasons` 推导；
旧行迁移默认 `doudizhu`；`platform` = 仅设备命中。

### 3.6 SQL 失败隔离（U6）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（选用）** | 单玩法失败跳过该玩法 + 冻结该玩法审核行 + 指标/告警 | 可用性 + 不误解放 | 实现最复杂 |
| B | 保持 fail-fast | 最简单、无误释放 | PDK 表问题拖住 DDZ |
| C | 隔离但不冻结 | 简单 | 失败玩法用户可能被误判 0 分而自动解限 |
| D | 仅 PDK 失败隔离 | 比 A 简单 | 非对称；DDZ 失败仍拖住 PDK |

**选用 A**。冻结保护依赖 U5 的 `game_type` 列 + `reasons` 兜底；两玩法都失败才整轮失败；
设备 SQL 失败仍 fail-fast（平台级依赖）。

## 4. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 新增 6 键：`game.paodekuai.risk.player2/3/4.winRateThreshold` 与 `.minGames`；再新增 `game.paodekuai.risk.autoThrottleScore` | U1/U3 用户裁决；2/3/4 可分别调 |
| D2 | 读取顺序（按人数 N）：`playerN.*` 存在 ⇒ 校验后使用（非法 ⇒ 代码默认，不回退）；缺失 ⇒ 现有 `game.paodekuai.risk.*` getter（旧 PDK → DDZ 新键 → DDZ 旧键 → 默认） | 与既有 PDK 回退纪律一致；新键优先，旧键只在对应人数键缺失时生效 |
| D3 | 现有 `game.paodekuai.risk.winRateThreshold`/`minGames` 仍为 active、仍在 admin IA、仍可写；备注改称“回退键”。**新键存在时旧键不生效**；旧键保留可写是给回滚/旧部署的兼容读取 | 用户 U7 已允许 slice-29 改用 `player3.*`；不再声称旧键能维持 slice-29。admin 备注必须写明“回退键：对应人数键缺失时生效” |
| D4 | 种子：6 个新键 0.8/100；`autoThrottleScore=50`；旧 PDK 两键种子不变 | 旧 PDK 键未部署生产（2026-10-25 起仅在 dev）；新键种子与旧种子同值，升级后行为不变；运营按人口调 |
| D5 | PDK 扫描 SQL 改为 `GROUP BY p.user_id, r.player_count`，行含 `player_count`；DDZ SQL 逐字不变 | 样本必须按人数拆；DDZ 恒 3 人 |
| D6 | 判定按人数：`pdkHitN = gamesN > minGamesN && winsN/gamesN > thresholdN`；`pdkHit = 任一 N`；胜率命中项仍只 25 分（玩法/人数都不叠分） | 与“命中项数×25”语义一致；防分数被玩法/人数放大 |
| D7 | `reasons`：每个 PDK 命中人数一条 `{check:'winRate',detail:{gameType:'paodekuai',playerCount:N,games,wins,winRate}}`；DDZ 保持 `{gameType:'doudizhu',games,wins,winRate}`（无 playerCount）；**PDK reasons 必须按 playerCount 升序**（SQL 不保证分组顺序） | 管理面可区分人数；DDZ 兼容旧形状；排序由代码显式做，防 flake |
| D8 | `risk_scan_hits_total{game_type}` 每用户每玩法最多 +1（PDK 多人数命中仍 +1） | 指标语义是“用户命中”，不是“人数命中” |
| D9 | PDK 扫描 SQL 加 `AND NOT EXISTS (SELECT 1 FROM game_record_players_pdk x WHERE x.record_id = p.record_id AND x.is_robot = 1)`；DDZ 不变 | U2；整局剔除；子查询走 `uk_pdk_record_seat (record_id, seat)` |
| D10 | 管理详情 `RISK_STATS_PDK_SQL` 改为按 `player_count` 分组，并同样整局剔除机器人局；DDZ 详情不变；A3 玩家列表不变。**“同口径”指 mode/is_robot/整局剔除；`users.status` 仍刻意不滤**（管理面诊断视图，与扫描的 `u.status='active'` 保持既有差异） | 详情与扫描的检测口径一致，但诊断视图保留封禁用户战绩；测试固定这个差异 |
| D11 | `RiskUserDetail.stats.byGame.paodekuai` 增加 `byPlayerCount: {'2'|'3'|'4': {games,wins,winRate}}`，恒含三项；顶层 paodekuai = 三项合计 | 固定形状便于 admin；旧 user-service 窗口用可选链 |
| D12 | 新键 `game.paodekuai.risk.autoThrottleScore`：int `25 ≤ n ≤ 50`，默认 50；缺失/非法 ⇒ 50。语义：**25 = PDK-only 25 分即自动限流；26–49 = PDK-only 25 分不自动限流、PDK+设备 50 分仍限流（与 50 等效）；50 = 关闭 PDK 单命中自动限流** | 分数只有 25/50；26–49 为未来命中项扩展留档位；admin 备注必须写三档语义 |
| D13 | 有效自动限流线：`pdkWinRateHit ? min(50, pdkAutoThrottleScore) : 50`；open 武装与 throttled(auto) 续期/解除都用同一函数 | 只影响 PDK 胜率注入；设备/platform 仍 50；PDK 命中消失 ⇒ 回 50 线可自动解除；26–49 与 50 同效 |
| D14 | `dismissed` 复活条件保持 `score > latest.score`，不因 PDK 独立阈值放宽 | 人工 dismiss 是显式豁免；同分反复重开会刷队列。登记为已知限制 |
| D15 | 新迁移 `1797000000005-RiskReviewGameType.ts`：`ALTER TABLE risk_reviews ADD COLUMN game_type varchar(16) NOT NULL DEFAULT 'doudizhu' AFTER status, ADD KEY idx_game_status_id (game_type,status,id)`；down 删索引+列 | U5；旧行默认 ddz；列表按 (game_type,status,id) 走索引 |
| D16 | `game_type` 推导：`winRate` reasons 的 `gameType` 集合（缺省/未知 ⇒ doudizhu）；两玩法 ⇒ `mixed`；无 winRate 但有 devices ⇒ `platform`；无 reasons（score=0 更新）⇒ 保留最新行值。新插入若推导为 null ⇒ `platform` | 写入面唯一真源；旧 reasons 兼容；语义是“当前涉及玩法”，不是历史 |
| D17 | 锁读 SQL 增加 `game_type, reasons`；`applyScanResult` 用最新行 + 本次 reasons 计算 `nextGameType`，所有 insert/update 都写 game_type | 推导与冻结都要读最新行；列不漂移 |
| D18 | 列表 `REVIEWS_SELECT_BASE` 增加 `game_type`；API `RiskReviewItem.gameType`；筛选 `doudizhu`/`paodekuai` 用 `IN (…,'mixed')`，`mixed`/`platform` 用等值；controller 白名单 `gameType`，非法值 400。**部署顺序：gateway + user-service 先、admin 后**；新 admin 遇 400 显示“服务端尚未支持玩法筛选，请先升级 user-service”，不静默回退 | 语义 = “包含该玩法”；mixed 在两玩法筛选里都出现；旧服务窗口不崩但明确提示 |
| D19 | gateway `RISK_REVIEWS_QUERY_KEYS` 加 `gameType`；admin UI 增加玩法筛选下拉 + 表格“玩法”列 + `gameType` 标签；**表头、行、详情 `colSpan` 三处同步 10 列** | 端到端可用；静态闸断言表头/colSpan，防 UI 假绿 |
| D20 | 新指标 `risk_scan_sql_failures_total{scope}`（scope=doudizhu|paodekuai|device）；单玩法失败 catch 计数+ERROR 日志；设备失败计数后 rethrow；两玩法都失败 throw | U6；有界标签；失败可见 |
| D21 | 冻结保护（两条正交规则）：① 锁定读后，若最新行的 `game_type ∪ reasons` 涉及任一失败玩法 ⇒ **零 DB 写、零审计**；② **只要有任一玩法 SQL 失败**，最新行为 `throttled(auto)` 时 **不得走解除分支**：跳过 DB 写/审计，但**仅续期 Redis `risk:limit` 旗（EX 7d）**；续期失败按单用户失败隔离（warn）。`platform`/无最新行不因涉及玩法冻结，但 ② 仍适用 | ① 防样本缺失导致误判 0 分/误 dismiss；② 防 7d TTL 到期静默解限，也防“latest 只写 ddz+device、隐藏 PDK 新命中”被误释放 |
| D22 | 单玩法失败轮仍记 `runs{ok}` 并刷 `last_success`；由新告警 `RiskScanSqlFailures` 覆盖；`degradedGames` 仅作局部变量 + ERROR 日志，**不改变 `RiskScanRoundResult` 形状**（避免无关断言漂移） | 轮次确实完成（部分降级）；不改变 `runs` 值域与看板；失败由指标/日志/告警可见 |
| D23 | 告警 `RiskScanSqlFailures`：`sum by (scope) (increase(risk_scan_sql_failures_total[10m])) > 0`，for 5m，warning；告警总数 31→32、类 28→29；带 runbook：先看 `scope` 对应的表/权限，再看扫描 ERROR 日志与 `risk_scan_last_success_timestamp_seconds`。**同步 slice-16/18/24 的 31→32 硬编码** | B 必需的可观测面；不改 A1 看板；slice-18/24 也有规则数断言 |
| D24 | 14003 保持 `baseScore × entryMultiplier`；不改 `message.router` 生产代码；补 PDK 2/3/4 单测与真栈断言 | U4；输光截断是既有安全网 |
| D25 | 机器人水位公式不改：`top = max(baseScoreLevels(gameType)) × entryMultiplier(gameType)`；补 PDK 2/4 结算/截断/afterSettle 单测；真栈 slice-32 至少覆盖一局“输家余额 < 应付”的截断（见 D26），并断言赢家池=实际池、residue/rake 正确、无负余额 | 改水位会影响 DDZ 经济，需另立产品裁决；本片只核对 |
| D26 | 新 conformance `slice-32-pdk-risk-gold`，不改 slice-29 的 2/4 流（仅按 D31 改 ⑥ 风控造数）；覆盖 PDK gold 2/4、14003、rake>0、**真实截断**（开局后把输家余额降到 1，再终局）、记录、风险扫描玩法/人数维度（每个 2/3/4 桶至少 2 条纯人类胜局 + 1 条机器人局证明剔除）、PDK 自动限流；Docker 不可用则只跑 tsc 并登记“待权威轮” | U4/U6 的关键断言必须真正触发分支；slice-32 baseline 初值固定为源内静态计数，只有带证据的权威轮实测才能改 |
| D27 | 配置计数：protocol 93→100；active/IA 77→84；简单控件 72→79；数字键 35→42；CONFIG_NOTES 77→84；种子行 93→100；`CLIENT_CONFIG_KEYS` 21、`LEGACY_CONFIG_KEYS` 16 不变。**admin 表头/行/详情 colSpan 10；slice-18/24 规则数 31→32；源码/测试注释的 93/77/72/35/71 逐项销账** | 单一真源 `CONFIG_KEYS.length`；机械闸逐处同步；防 UI/注释假绿 |
| D28 | `risk_reviews.game_type` 回滚顺序：先回滚代码（旧代码不 select 新列，兼容），再 down 迁移；配置新键回滚保留（旧镜像不读） | 无 2PC；避免新代码撞旧 schema |
| D29 | 机器人水位风险登记：bot 在低档房按全局最高档 top 充值（如 15 底分房 bot 仍有 ~1.38 万），高倍数局人类可从 bot 提取其全部余额；与 DDZ 同构，本片不改 | 经济面/反洗钱另立片；本片只保证截断与不为负 |
| D30 | 扫描对未知 `player_count`（非 2/3/4）行：跳过，**每轮汇总一条 WARN（带条数与样例 user_id）**，不计入任何人数桶；COUNT/SUM 仍 `Number()` 归一 | 防御脏数据；避免每轮每行刷日志 |
| D31 | slice-29 ⑥ 最小测试夹具改动（U7）：① `PDK_RISK_MIN_GAMES`/`PDK_RISK_WIN_RATE` 改用 `game.paodekuai.risk.player3.minGames`/`player3.winRateThreshold`；② `craftPdkWinningRecord` 的第二条胜局由 `1 真人 + 2 机器人` 改为 `3 真人`（复用同房另外两个 `userId`）；不动 2/4 对局流、不动生产代码。baseline 117 预计不变（断言数不变） | 否则旧键 PUT 被 player3 种子遮蔽、机器人局被整局剔除，`games=2` 必红；最小改动保留 A1 风控真栈证据 |
| D32 | 跨版本 admin 契约：部署顺序 gateway + user-service → admin；新 admin 遇 `gameType` 筛选 400 时显示明确升级提示，不静默回退；旧 admin + 新 service 忽略新字段。测试覆盖 gateway 白名单与 controller 白名单 | 滚动窗口不能出现“筛选必 400 且无解释” |
| D33 | `reasons` 的 PDK 人数顺序由代码显式 `sort((a,b)=>a.playerCount-b.playerCount)`；SQL 不加 `ORDER BY`（避免与 GROUP BY/索引耦合） | 测试与 admin 展示稳定 |
| D34 | A3 玩家列表口径差异登记：`admin-players.service.ts` 注释改为“行级 is_robot=0；风控详情为整局剔除机器人局”，并在 §6 写明 | 防运营把两处数字当同一口径 |
| D35 | 旧 `risk_reviews` 行的 `game_type` 迁移默认 `doudizhu`；其 `platform`/`mixed`/`paodekuai` 筛选都可能漏旧行（不仅 PDK）；`game_type` 是“当前涉及玩法”，update 会改写。全部写入 §6 已知限制 | 旧行缺省是 U5 的显式选择；避免运营误读 |

## 5. 实现设计

### 5.1 protocol（`packages/protocol/src/config.ts`）

在现有 `game.paodekuai.risk.minGames` 之后插入 7 键（保持玩法键分组）：

```ts
/** 跑得快风控按人数阈值（2026-10-26）：2/3/4 各一对；旧两键为缺失时的回退。 */
'game.paodekuai.risk.player2.winRateThreshold',
'game.paodekuai.risk.player2.minGames',
'game.paodekuai.risk.player3.winRateThreshold',
'game.paodekuai.risk.player3.minGames',
'game.paodekuai.risk.player4.winRateThreshold',
'game.paodekuai.risk.player4.minGames',
/** PDK 单玩法自动限流阈值（2026-10-26）：25 = 单命中即限流；50 = 关闭 PDK 单命中自动限流。 */
'game.paodekuai.risk.autoThrottleScore',
```

- `GAME_RISK_WIN_RATE_KEYS` 与 `GAME_RISK_MIN_GAMES_KEYS` 各追加三个 playerN 键。
- 新 parser 分派：`if (key === 'game.paodekuai.risk.autoThrottleScore') return parseAutoThrottleScore(value);`
- `parseAutoThrottleScore`：int、`25 ≤ n ≤ 50`；错误文案带键名。
- `CONFIG_KEYS` 总数 100；`CLIENT_CONFIG_KEYS` 21；`LEGACY_CONFIG_KEYS` 16 不变。
- 文件头/注释计数同步（九十三 → 一百；跑得快风控 9 键）。

### 5.2 config-service

新迁移 `1796900000000-PdkRiskPlayerCountSeed.ts`：

```ts
const KEYS = [
  ['game.paodekuai.risk.player2.winRateThreshold', 0.8],
  ['game.paodekuai.risk.player2.minGames', 100],
  ['game.paodekuai.risk.player3.winRateThreshold', 0.8],
  ['game.paodekuai.risk.player3.minGames', 100],
  ['game.paodekuai.risk.player4.winRateThreshold', 0.8],
  ['game.paodekuai.risk.player4.minGames', 100],
  ['game.paodekuai.risk.autoThrottleScore', 50],
] as const;
```

- `up`：`SELECT MAX(version)`（至少 1）⇒ 一条多值 `INSERT IGNORE`；`updated_by='seed'`。
- `down`：只删这 7 键。
- 重放幂等；不覆盖运营已改值；迁移号晚于 `1796800000000` 且全仓唯一。
- 测试夹具：`config-probe.ts` SEED、`platform-config.service.test.ts` SEED 各加 7 行；
  行数 93→100；标题/注释同步；`admin.controller.test.ts`、`client-config.test.ts` 标题同步。
- `migration.test.ts` 新增 7 键迁移用例（精确 SQL/键值/version/down/幂等/时间戳唯一）。

### 5.3 user-service 配置缓存（`config/config-cache.service.ts`）

新增：

```ts
riskPaodekuaiPlayerWinRateThreshold(playerCount: 2 | 3 | 4): number;
riskPaodekuaiPlayerMinGames(playerCount: 2 | 3 | 4): number;
riskPaodekuaiAutoThrottleScore(): number;
```

读取规则（D2/D12，null-safe）：

1. `hasSnapshotKey(key)` = `snapshot !== null && Object.hasOwn(snapshot, key)`。
2. `playerN.*` 存在：合法 ⇒ 原值；非法（类型/越界/三位小数/`null`）⇒ 代码默认
   （0.8 / 100），**不回退旧 PDK 键**。
3. `playerN.*` 缺失（含 `snapshot === null`）⇒ `riskPaodekuaiWinRateThreshold()` /
   `riskPaodekuaiMinGames()`（旧 PDK → DDZ 新键 → DDZ 旧键 → 默认）。
4. `riskPaodekuaiAutoThrottleScore()`：键存在且 int 25–50 ⇒ 原值；否则 50（**不回退**账号级，
   因为默认值同为 50）。
- 复用现有 `normalizeWinRate` / `normalizeMinGames`；新增 `normalizeAutoThrottleScore`。

### 5.4 扫描（`risk/scan.service.ts`）

#### SQL 常量

- `RISK_WIN_RATE_SQL`（DDZ）**逐字不变**。
- `RISK_WIN_RATE_PDK_SQL` 新文本：

```ts
export const RISK_WIN_RATE_PDK_SQL =
  "SELECT p.user_id, r.player_count AS player_count, COUNT(*) AS games, SUM(CASE WHEN p.seat = r.winner_seat THEN 1 ELSE 0 END) AS wins FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id JOIN users u ON u.id = p.user_id AND u.status = 'active' WHERE r.mode IN ('random','gold') AND p.user_id IS NOT NULL AND p.is_robot = 0 AND NOT EXISTS (SELECT 1 FROM game_record_players_pdk x WHERE x.record_id = p.record_id AND x.is_robot = 1) GROUP BY p.user_id, r.player_count";
```

#### 单轮流程

1. 读取 3 组人数阈值 + 3 组 minGames + PDK 自动限流阈值 + 设备两键（每轮现读）。
2. 依次查询 DDZ SQL → PDK SQL → 设备 SQL（顺序固定，测试逐条钉）。
   - DDZ/PDK 各自 try/catch；失败 ⇒ `riskScanSqlFailuresTotal.inc({scope})` +
     ERROR 日志 + 记录到 `degradedGames`。
   - 两者都失败 ⇒ throw（整轮失败）。
   - 设备 SQL 失败 ⇒ 计数后 rethrow（平台级依赖）。
3. 并集：

```ts
interface PdkWinStat { playerCount: 2 | 3 | 4; games: number; wins: number }
interface MergedRiskStat {
  byGame: { doudizhu?: GameWinStat; paodekuai?: PdkWinStat[] };
  devices: number;
}
```

   - DDZ 行写 `byGame.doudizhu`；
   - PDK 行按 `player_count` 写 `byGame.paodekuai`（未知人数 ⇒ 计入本轮 `unknownPlayerCountRows`，
     处理完统一 WARN 一条，带条数与样例 `user_id`；不计入任何人数桶）；
   - 设备行只补 `devices`。
   - COUNT/SUM 的驱动回值可能是字符串 ⇒ `player_count`/`games`/`wins` 全部 `Number()` 归一；
     `player_count` 非 2/3/4 ⇒ 走未知人数分支。
4. 判定：

```ts
const ddzHit = ddz !== undefined && ddz.games > ddzMinGames && ddz.wins / ddz.games > ddzThreshold;
const pdkHits = (pdk ?? [])
  .filter((s) => s.games > pdkMinGames(s.playerCount) && s.wins / s.games > pdkThreshold(s.playerCount))
  .sort((a, b) => a.playerCount - b.playerCount); // D33：显式排序，SQL 不保证顺序
const hit1 = ddzHit || pdkHits.length > 0;
const hit2 = devices > deviceLimit;
const score = (hit1 ? 25 : 0) + (hit2 ? 25 : 0);
```

   - reasons 顺序：DDZ（若命中）→ PDK 各命中人数（按 2/3/4 升序）→ 设备（若命中）。
   - 每条 PDK reason 带 `playerCount`。
   - `risk_scan_hits_total`：DDZ 命中 +1；PDK 任一命中 +1（每用户每玩法一次）。
5. `applyScanResult(userId, score, reasons, now, degradedGames)`。

#### 失败隔离与冻结

- `degradedGames: GameType[]`（空 = 全部成功）。
- 冻结保护在 `ReviewsService.applyScanResult`（见 5.5），扫描只传失败集合。

### 5.5 审核状态机（`risk/reviews.service.ts`）

#### 新列与 SQL

- 锁读：

```ts
export const RISK_UPSERT_LOCK_SQL =
  'SELECT id,status,score,handled_by,handled_at,game_type,reasons FROM risk_reviews WHERE user_id = ? ORDER BY id DESC LIMIT 1 FOR UPDATE';
```

- 插入：

```ts
const REVIEW_INSERT_OPEN_SQL =
  "INSERT INTO risk_reviews (user_id, score, reasons, status, game_type) VALUES (?, ?, ?, 'open', ?)";
```

- 更新（三条 SET 都加 `game_type = ?`）：

```ts
const REVIEW_UPDATE_SCORE_SQL = 'UPDATE risk_reviews SET score = ?, reasons = ?, game_type = ? WHERE id = ?';
const REVIEW_UPDATE_TRANSITION_SQL =
  "UPDATE risk_reviews SET score = ?, reasons = ?, game_type = ?, status = ?, handled_by = 'system', handled_at = ? WHERE id = ?";
const REVIEW_UPDATE_THROTTLE_KEEP_HANDLER_SQL =
  "UPDATE risk_reviews SET score = ?, reasons = ?, game_type = ?, status = 'throttled' WHERE id = ?";
```

#### 类型与推导

```ts
export type ReviewGameType = 'doudizhu' | 'paodekuai' | 'mixed' | 'platform';
```

- `deriveReviewGameType(reasons): ReviewGameType | null`：
  - `winRate` reasons 的 `detail.gameType`（缺省/未知 ⇒ doudizhu）集合；
  - 两玩法 ⇒ `mixed`；单玩法 ⇒ 该玩法；无 winRate 但有 devices ⇒ `platform`；否则 null。
- `reviewInvolvedGames(latest)`：`game_type` 规范化 + 解析 `reasons` 的 winRate 游戏集合；
  旧行 `game_type` 缺省 ddz，但 reasons 含 paodekuai 时仍视为涉及 PDK（防旧行误释放）。
- `autoThrottleLine(reasons, pdkAutoThrottleScore)`：
  `reasons` 含 PDK winRate ⇒ `Math.min(50, pdkAutoThrottleScore)`，否则 50。

#### `applyScanResult`

签名扩展：

```ts
async applyScanResult(
  userId: string,
  score: number,
  reasons: readonly ScanReason[],
  now: number,
  unavailableGames: readonly GameType[] = [],
): Promise<void>
```

- 锁定读后：
  1. 若 `unavailableGames` 非空且 `reviewInvolvedGames(latest)` 与任一失败玩法相交：
     - `latest.status === 'throttled' && latest.handled_by === 'system'` ⇒ **仅续期 Redis 旗**
       （`armAutoThrottle(userId, now)`，EX 7d），**零 DB 写/零审计**，返回 null；
     - 其他状态 ⇒ 直接返回 null（零写、零旗、零审计）。
  2. 若 `unavailableGames` 非空且 `latest.status === 'throttled' && latest.handled_by === 'system'`
     （即使 latest 不涉及失败玩法）：**不得走解除分支**；仅续期 Redis 旗，零 DB 写/零审计，
     返回 null。防“latest 只写 ddz+device、隐藏 PDK 新命中”被误释放，也防 7d TTL 静默到期。
  3. 计算 `nextGameType = deriveReviewGameType(reasons) ?? normalizeReviewGameType(latest.game_type) ?? 'doudizhu'`。
- 状态机分支不变，但：
  - `open` 的自动限流条件：`score >= autoThrottleLine(reasons, pdkScore)`；
  - `throttled(auto)` 的续期/解除条件同线；
  - 插入用 `deriveReviewGameType(reasons) ?? 'platform'`。
- `riskAutoThrottle()` 开关仍总闸。
- 旗续期失败 ⇒ 该用户本轮按单用户失败隔离（warn），不拖垮整轮；下一轮再试。

### 5.6 管理详情与列表（`risk/admin-risk.service.ts`）

#### 详情统计

`RISK_STATS_PDK_SQL` 新文本：

```ts
export const RISK_STATS_PDK_SQL =
  "SELECT r.player_count AS player_count, COUNT(*) AS games, COALESCE(SUM(CASE WHEN p.seat = r.winner_seat THEN 1 ELSE 0 END), 0) AS wins FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id WHERE p.user_id = ? AND r.mode IN ('random', 'gold') AND p.is_robot = 0 AND NOT EXISTS (SELECT 1 FROM game_record_players_pdk x WHERE x.record_id = p.record_id AND x.is_robot = 1) GROUP BY r.player_count";
```

- 结果按 `player_count` 建三桶（2/3/4），恒含三项；未知人数跳过并 WARN（单用户查询，
  日志量有限）。
- `byGame.paodekuai` = 三桶合计；`byPlayerCount` 为三桶明细。
- 顶层 `stats.games/wins/winRate` = DDZ + PDK 合计（DDZ SQL 不变）。
- **`users.status` 差异固定**：扫描 SQL 带 `u.status='active'`；详情 SQL 不带（诊断视图）。
  新增测试钉住详情 SQL 不含 `users.status`，防后来者“统一口径”时误加。

#### 列表

- `REVIEWS_SELECT_BASE` 加 `game_type`；`RawReviewRow`/`RiskReviewItem` 加 `gameType`。
- `RiskReviewListFilter` 加 `gameType`；`listReviews` 条件：
  - `doudizhu` ⇒ `game_type IN ('doudizhu','mixed')`；
  - `paodekuai` ⇒ `game_type IN ('paodekuai','mixed')`；
  - `mixed` ⇒ `game_type = 'mixed'`；
  - `platform` ⇒ `game_type = 'platform'`。
- controller `REVIEWS_QUERY_KEYS` 加 `gameType`；非法值 400；gateway 白名单同步。

### 5.7 admin UI（`admin/app.js` + `admin/index.html` + `scripts/verify-admin-static.mjs`）

- 配置 IA：pdk「风控检测」页签追加 7 键（共 9 键：旧两键 + 新七键）。
- `CONFIG_CONTROLS` 追加 7 个 number：
  - 3 个 `winRateThreshold`：label「2/3/4 人胜率阈值」、`step: 0.01`、无后缀；
  - 3 个 `minGames`：label「2/3/4 人扫描最少局数」、无后缀；
  - `autoThrottleScore`：label「PDK 自动限流阈值」、`suffix: '分'`。
- `CONFIG_NOTES` 追加 7 条，并把旧两键备注改为「回退键：对应人数键缺失时生效」；
  说明 2/3/4 基准胜率、整局剔除机器人、PDK 自动限流 25/50、dismissed 同分不复活。
- 计数：protocol 100、active/IA 84、简单控件 79（35 bool + 2 text + 42 number）、
  structured 5、notes 84；相关注释同步。
- 风险队列：
  - `admin/index.html`：状态筛选旁加「玩法」下拉（全部/斗地主/跑得快/混合/平台）；
    表格加「玩法」列（在状态后，**表头 10 列**）。
  - `admin/app.js`：`riskQuery` 带 `gameType`；`riskState.filter` 含 `gameType`；
    `buildRiskRow` 加 `gameType` 标签（**行 10 列**）；详情展开行 `td.colSpan = 10`；
    reset/search 同步。新 admin 遇 `gameType` 筛选 400 ⇒ 显示“服务端尚未支持玩法筛选，
    请先升级 user-service”，不静默回退。
- 详情：`renderRiskDetail` 在分玩法行后加「跑得快分人数：2 人 X 局 / Y 胜 · 胜率 Z；3 人…；4 人…」，
  用 `d.stats?.byGame?.paodekuai?.byPlayerCount?.[n]` 可选链。
- verifier：
  - 计数 100/84/84/79/35/2/42/84；注释“合计 = 71”改 79（防旧注释漂移）；
  - pdk 风控页签含 9 键；新键 step/suffix；旧键备注含“回退”；
  - `renderRiskDetail` 块内含 `byPlayerCount` 与 `分人数`；
  - `riskQuery`/`buildRiskRow` 含 `gameType`；
  - `admin/index.html` 表头恰 10 个 `<th>`；`buildRiskRow` 详情 `colSpan` 为 10；
  - notes 覆盖新 7 键。

### 5.8 监控（B 新指标/告警）

- `packages/user-service/src/risk/risk.metrics.ts` 新增：

```ts
export const riskScanSqlFailuresTotal = createCounter(
  'risk_scan_sql_failures_total',
  '风控扫描 SQL 失败次数（scope=doudizhu|paodekuai|device；单玩法失败按玩法隔离，设备 SQL 失败仍整轮失败）。',
  ['scope'],
);
```

- `deploy/monitoring/prometheus/rules/ftl-alerts.yml` 新增 `RiskScanSqlFailures`：
  `sum by (scope) (increase(risk_scan_sql_failures_total[10m])) > 0`，for 5m，warning；
  annotations 含 runbook（先看 scope 对应表/权限，再看扫描 ERROR 日志与
  `risk_scan_last_success_timestamp_seconds`）。
- 头注释 31→32 条、28→29 类；`Dockerfile.prometheus` 注释同步；
  `risk.metrics.ts` 文件头“四个指标”同步为当前指标数（含 A1 hits 与 B failures）。
- `scripts/verify-monitoring.mjs`：EXPECTED_ALERTS 加名；头注释 32/29；新增
  `RiskScanSqlFailures` 的 `scope`/`> 0`/唯一性断言。
- `tools/conformance/src/slices/slice-16-monitoring.ts`：EXPECTED_RULES 加名；
  所有 31/28 硬编码与注释同步。
- **`tools/conformance/src/slices/slice-18-gold-room.ts` / `slice-24-ads-relief.ts`：
  规则数 31→32**（两处独立硬编码；漏改必红）。
- `docs/ops/first-deploy.md` 告警类别清单（若有）同步，并加新告警一句。
- **不改** A1 看板（Grafana JSON）；本指标只告警，不加面板（A1 边界，spec 登记）。

### 5.9 conformance `slice-32-pdk-risk-gold`

新建 `tools/conformance/src/slices/slice-32-pdk-risk-gold.ts`，加入 `run.ts` 的 `CASES`
与 `baselines.json`。覆盖：

- ⓪ 配置快照/开启：pdk enabled/two/nonThree/gold；`game.levels.paodekuai` 15 档台费 10%；
  `game.paodekuai.rakePercent=10`；`player2/3/4.*` 阈值 0.5/1；`autoThrottleScore=25`。
- ① 14003（2/4 各一）：0 余额 ⇒ 14003 + 消息含 needed（15×10=150）；补足 150 ⇒ 入队。
- ② PDK gold 2 人：两真人匹配、开局、打到终局；断言 2 座结算零和、rake>0、
  `game.balances` 2 座、余额不为负；记录 `player_count=2`、`mode='gold'`。
- ③ PDK gold 4 人：四真人；4 座结算、12 张、记录 `player_count=4`；余额不为负。
- ③b **真实截断**：在 2 人 gold 局开局后、终局前，把输家余额用管理面
  `POST /api/admin/wallet/adjust` 降到 1（远低于应付）；终局后断言：
  实际扣款 = 1、赢家池 = 实际池、rake/residue 按实际池计算、余额不为负。
  4 人局同法降一个输家；机器人资金路径用单测覆盖（robot-funding + settle-pdk 2/4），
  真栈若时间允许加一局 2 人真人 + 机器人补位并断言 afterSettle 补给。
- ④ 风险扫描：用 `record.write` 注入**每个 2/3/4 桶至少 2 条纯人类胜局**（严格
  `games > minGames=1` 需要 ≥2 局），另对 2 人桶加 1 条含机器人座的整局；
  设置 per-count minGames=1、threshold=0.5；重启 user-service；
  轮询 `GET /api/admin/risk/users/:id` 与 `GET /api/admin/risk/reviews?gameType=...`：
  - reasons 含 `playerCount` 且按 2/3/4 升序；`stats.byGame.paodekuai.byPlayerCount` 正确；
  - 含机器人座的整局不计入：2 人桶 games=2（不是 3）、wins=2；
  - `gameType=paodekuai` 筛选能看到 mixed/paodekuai 行；`doudizhu` 不含纯 PDK 行；
    `mixed` 精确筛选命中“DDZ+PDK 双命中”用户；
  - `autoThrottleScore=25` 时第二轮扫描把 PDK 25 分条目自动限流（`risk:limit` 旗）。
- ⑤ 收尾：还原配置/队列/旗；对自动限流条目人工 `unthrottle`/`dismiss` 清理。
- 真栈不可用 ⇒ 只跑 `tsc`，报告中登记“待权威轮”，不得声称已跑。
- `baselines.json` 初值 = 源内静态计数（固定写在计划里）；只有带权威轮实测证据才允许更新。

### 5.10 单测（新增/更新）

- protocol：7 键位置/总数 100/CLIENT 21/LEGACY 16；三组 parser 正反例；autoThrottleScore 25/50/24/51/3.5/'50'。
- config-service：新迁移精确 SQL/值/version/down/幂等/时间戳；SEED 100；admin/client 100。
- user config cache：per-count 合法/非法/缺失回退链；autoThrottleScore；snapshot=null 安全。
- risk-scan：
  - PDK SQL 全文（player_count + NOT EXISTS 机器人整局剔除）；DDZ SQL 不变；查询顺序；
  - per-count 阈值/命中；reasons 带 playerCount **且升序**（乱序输入夹具）；多人数命中仍 25；
    DDZ+PDK 仍 25/50；COUNT/SUM 字符串归一；未知 player_count 按轮汇总 WARN；
  - 机器人局行不计入（SQL 文本钉 + 真栈）；
  - 单玩法失败隔离：ddz 失败 ⇒ pdk+device 继续；pdk 失败 ⇒ ddz+device 继续；
    两者都失败 ⇒ throw；device 失败 ⇒ throw；指标 scope；
  - 冻结：最新行 paodekuai/mixed + pdk 失败 ⇒ 零写；doudizhu + pdk 失败 ⇒ 照写；
    platform + pdk 失败 ⇒ 照写；旧行 game_type=doudizhu 但 reasons 含 pdk + pdk 失败 ⇒ 零写；
    **throttled(auto) + 任一玩法失败 ⇒ 不解除 + Redis 旗续期（DB/审计零写）**。
- reviews：
  - game_type 推导（ddz/pdk/mixed/platform/空）；insert/update 写列；
  - PDK 自动限流线（25 + pdkScore 25 ⇒ throttle；26/50 ⇒ 不；DDZ 25 ⇒ 不；mixed 25 ⇒ 是；
    device-only 25 ⇒ 不；PDK 消失 ⇒ 回 50 线解除）；
  - dismissed 同分不复活（PDK 也适用）；
  - 冻结保护全分支（含 throttled(auto) 旗续期与 7d TTL fake-timer）；锁定读/insert/update SQL 形状。
- risk-admin：详情 `byPlayerCount` 三桶；PDK SQL 全文（整局剔除 + 分组 + 不含 users.status）；
  列表 `gameType` 筛选语义（doudizhu/pdk 含 mixed）；行 `gameType` 形状。
- room-service：14003 PDK 2/3/4；`canFormTable` 2/4 人谓词；2/4 结算/机器人资金/截断。
- admin verifier + monitoring verifier + conformance lint；slice-18/24 规则数 31→32；
  slice-20 `RISK_SEED_VALUES` 加新 7 键逐值；admin 表头 10 列 / colSpan 10。
- conformance 全量：slice-16/18/20/24/29/31/32（Docker 可用时）；不可用则 tsc + 登记。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| `playerN` 键存在但非法 | 代码默认 0.8/100，不回退旧 PDK 键 |
| `playerN` 键缺失 / snapshot=null | 回退旧 PDK getter（旧 PDK → DDZ 新 → DDZ 旧 → 默认），不抛 |
| PDK 记录 `player_count` 非 2/3/4 | 跳过该行，按轮汇总一条 WARN（条数 + 样例 user_id），不计入任何人数桶 |
| PDK 局含机器人座 | 整局不计入扫描/详情人类样本 |
| DDZ 局含机器人座 | 行为不变（机器人行 user_id NULL 已被 JOIN 排除；人类行仍计） |
| 单玩法 SQL 失败 | 该玩法跳过 + 指标 + ERROR；另一玩法 + 设备继续；该玩法已有审核行冻结 |
| 两玩法 SQL 都失败 | 整轮 throw（runs fail、last_success 不推进、锁释放） |
| 设备 SQL 失败 | 计数后 throw（fail-fast） |
| 冻结用户本轮有其他命中 | 本轮不更新（下一轮收敛）；不误自动解除/误 dismiss |
| 冻结用户是 `throttled(auto)` | 仅续期 Redis `risk:limit` 旗（EX 7d），零 DB 写/零审计；续期失败按单用户失败隔离 |
| 最新行 `game_type=platform` | 不因“涉及玩法”冻结；但任一玩法失败且是 throttled(auto) 时仍不得解除 |
| 最新行旧 `game_type=doudizhu` 但 reasons 含 paodekuai | 视为涉及 PDK（reasons 兜底） |
| PDK-only 25 分 + `autoThrottleScore=25` | open 第二轮起自动限流；首轮新建行不武装（⚙️20） |
| PDK-only 25 分 + `autoThrottleScore=26..50` | 不自动限流；进队列人工处置；PDK+设备 50 分仍限流 |
| `dismissed` + 同分 PDK 再命中 | 不复活（人工豁免）；score 升高才复活 |
| 14003 余额不足 | 维持 14003；消息含 needed；不入队 |
| 输光截断 | `pay = min(应付, 余额)`；赢家按实际池分摊；不出现负余额 |
| 机器人水位不可推导 | 既有 ensure 抛 / afterSettle fail-open 语义不变 |
| 新 admin + 旧 user-service | **`gameType` 筛选会 400**：admin 显示“请先升级 user-service”，不静默回退；`byPlayerCount` 可选链；队列行 `gameType` 缺失按 ddz 显示。部署顺序 gateway+user-service → admin |
| 旧 admin + 新 user-service | 忽略新字段；`gameType` 筛选不传 |
| 旧 `risk_reviews` 行 | `game_type='doudizhu'` 默认；`paodekuai`/`mixed`/`platform` 筛选都可能漏旧行；冻结保护用 reasons 兜底 |
| `game_type` 语义 | “当前涉及玩法”，update 会改写；不是历史快照 |
| A3 玩家列表 | 行级 `is_robot=0`；风控详情为整局剔除机器人局；两处数字不应直接对比 |
| 回滚代码但保留迁移 | 旧代码不 select `game_type`，兼容；配置新键保留无害 |
| 回滚迁移 | 必须先回滚代码；down 删索引+列 |

**已知限制（预登记）**：

- 旧 `risk_reviews` 行迁移后 `game_type='doudizhu'`；若其 reasons 含 PDK，列表筛选 `paodekuai`
  不会显示（仅冻结保护用 reasons 兜底）；同理，旧行的 `mixed`/`platform` 筛选也可能漏。
  `game_type` 是“当前涉及玩法”，update 会改写，不是历史快照。生产尚未部署 PDK 风控，
  影响面仅为 dev。
- PDK 与 DDZ 的机器人局口径不同（PDK 整局剔除、DDZ 保持）；这是 U2 的显式选择。
- A3 玩家列表仍是行级 `is_robot=0`，与风控详情的整局剔除口径不同；两处数字不应直接对比。
- 机器人低档房按全局最高档 top 充值（D29），经济面风险另立片。
- `dismissed` 同分不复活对 PDK 独立阈值同样成立；人工 dismiss 是显式豁免。
- 新 admin + 旧 user-service 的 `gameType` 筛选会 400；部署顺序 gateway+user-service → admin，
  admin 显示升级提示，不静默回退。

## 7. 测试判据（完成定义）

1. protocol：`CONFIG_KEYS` 恰 100；新 7 键在 PDK 风控组；三组 parser 正反例；
   `CLIENT_CONFIG_KEYS` 21、`LEGACY_CONFIG_KEYS` 16。
2. config-service：迁移 up/down/幂等/version MAX；SEED 100；admin/client 100；
   `pnpm -C packages/config-service test` 全绿。
3. user-service：config-cache、risk-scan、reviews、risk-admin、migration 全绿；
   `pnpm -C packages/user-service test` 全绿。
4. room-service：14003 PDK 2/3/4、2/4 谓词、2/4 结算/机器人资金单测全绿。
5. admin：`node scripts/verify-admin-static.mjs` 全绿（100/84/84/79/42/84）。
6. monitoring：`node scripts/verify-monitoring.mjs` 全绿（32 条/29 类）；
   `tools/conformance` tsc 通过。
7. conformance：slice-20 键集/种子同步；slice-16/18/20/24/29/31/32 在真栈全绿
   （Docker 不可用则逐个登记“待权威轮”）；slice-18/24 规则数 31→32；
   `pnpm -C tools/conformance lint` / tsc 通过。
8. 全量：`pnpm exec turbo run test lint --force`（0 cached 才算真跑）；
   工作区干净（除用户既有未提交文件）。
9. 真栈：能起则跑 slice-32（含真实截断构造）；不能起则报告中逐项登记“待权威轮”，
   不得声称已跑；slice-29 ⑥ 必须按 D31 改后通过（或登记待权威轮）。
10. 机械闸销账：`grep` 全仓 93/77/72/35/31/28/71 等旧计数，逐项确认已改或属历史文档；
    admin 表头/行/colSpan 三处一致（10 列）。

## 8. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 旧 PDK 两键保留可写但被新键遮蔽 | 运营改旧键无效 | admin 备注明确“回退键：对应人数键缺失时生效”；新键优先；slice-29 已按 D31 改用 player3 键 |
| 整局剔除机器人后 PDK 样本变小 | 命中延迟 | 运营可下调 minGames；观察期看队列/命中指标 |
| 冻结保护让部分用户一轮不更新 | 收敛延迟 | 下一轮收敛；仅失败玩法涉及的审核行；throttled(auto) 续旗防 TTL 到期 |
| 冻结轮仅续旗不写 DB | 旗与 DB 短暂不一致 | 下一轮 SQL 恢复后状态机收敛；续旗失败按单用户隔离 |
| 单玩法失败轮记 ok | `RiskScanStalled` 不响 | 新 `RiskScanSqlFailures` 告警覆盖；文档写明 |
| 自动限流 25 误伤 | PDK 单命中即限流 | 默认 50；运营显式改 25；先观察再开；26–49 与 50 同效 |
| 旧行 game_type 默认 ddz | 列表筛选偏差（PDK/mixed/platform 都可能漏） | 生产未部署 PDK 风控；冻结保护用 reasons 兜底；§6 登记 |
| 新 admin + 旧 service 带 gameType | 400 | 部署顺序 gateway+user-service → admin；admin 显示升级提示，不静默回退 |
| 机械闸计数遗漏 | CI 红 | 单一真源 `CONFIG_KEYS.length` + verifier 显式计数 + 全量搜索旧计数；slice-18/24 单独改 |
| 迁移时间戳撞车 | 迁移失败 | 1796900000000 / 1797000000005，迁移测试全仓唯一 |
| slice-32 真栈未跑 | 行为未验 | 单测 + SQL 全文钉；报告登记“待权威轮”；截断断言必须构造余额 < 应付 |
| slice-29 夹具改动引入回归 | A1 风控真栈红 | 仅改 ⑥ 键名与造数座位；baseline 117 不变；真栈待权威轮 |
| 与 A2/A3/2-4 分支冲突 | 合并冲突 | B 从 e1663df8 开出（已含三者）；slice-29 仅 D31 最小改；交付报告写栈关系 |

## 9. 涉及文件

**protocol / config**
- `packages/protocol/src/config.ts`、`config.test.ts`
- `packages/config-service/src/migrations/1796900000000-PdkRiskPlayerCountSeed.ts`（新）
- `packages/config-service/test/migration.test.ts`、`helpers/config-probe.ts`、
  `platform-config.service.test.ts`、`admin.controller.test.ts`、`client-config.test.ts`
- `packages/config-service/src/config/{admin.controller.ts,client-config.controller.ts,platform-config.entity.ts,platform-config.service.ts}`（注释计数）

**user-service**
- `src/config/config-cache.service.ts`
- `src/migrations/1797000000005-RiskReviewGameType.ts`（新）
- `src/risk/{scan.service.ts,reviews.service.ts,admin-risk.service.ts,admin-risk.controller.ts,risk.metrics.ts}`
- `src/players/admin-players.service.ts`（仅口径注释）
- `test/{config-cache,risk-scan,risk-admin,risk-metrics,migration}.test.ts`

**room-service**（仅测试；生产 14003/水位不改）
- `test/message.router.test.ts`、`predicates.test.ts`、`match-player-count.test.ts`、
  `currency/robot-funding.test.ts`、`currency/settle-algorithm.test.ts`、
  `currency/settle-pdk.test.ts`、结算/截断相关测试

**gateway / admin / monitoring**
- `packages/api-gateway/src/gateway/gateway.controller.ts`（query 白名单）
- `packages/api-gateway/test/gateway.controller.test.ts`
- `admin/app.js`、`admin/index.html`
- `scripts/verify-admin-static.mjs`
- `deploy/monitoring/prometheus/rules/ftl-alerts.yml`
- `scripts/verify-monitoring.mjs`
- `Dockerfile.prometheus`
- `tools/conformance/src/slices/slice-16-monitoring.ts`
- `tools/conformance/src/slices/slice-18-gold-room.ts`（规则数 31→32）
- `tools/conformance/src/slices/slice-20-risk-control.ts`
- `tools/conformance/src/slices/slice-24-ads-relief.ts`（规则数 31→32）
- `tools/conformance/src/slices/slice-29-paodekuai.ts`（仅按 D31 改 ⑥ 风控造数）
- `tools/conformance/src/slices/slice-32-pdk-risk-gold.ts`（新）
- `tools/conformance/src/run.ts`、`baselines.json`

**源码/测试/文档计数注释（逐项销账）**
- `packages/api-gateway/src/gateway/gateway.controller.ts:146`、
  `packages/robot-service/src/config/config.client.ts:14`、
  `packages/room-service/src/gateway/config.client.ts:21`、
  `packages/room-service/src/gateway/rpc.options.ts:35`、
  `packages/user-service/src/config/config.client.ts:15`、
  `packages/config-service/src/config/{admin.controller,client-config.controller,platform-config.entity,platform-config.service}.ts`
- `packages/user-service/test/config-cache.test.ts:82`、`packages/robot-service/test/config*.test.ts`、
  `packages/room-service/test/config*.test.ts`、`scripts/verify-admin-static.mjs`（含 71→79 注释）
- `docs/design.md`（93/77、旧风险键、PDK active 24→31）、`docs/ops/first-deploy.md:1016`、
  `docs/games/paodekuai.md:152-153`、`docs/client-protocol.md:58`

**文档**
- `docs/design.md`、`docs/games/paodekuai.md`、`docs/client-protocol.md`、
  `docs/ops/first-deploy.md`
- `docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`
- `docs/superpowers/plans/deviation-ledger.md`
- 本 spec 的「审查记录」

## 10. 审查记录

### 10.1 第一轮独立对抗审查（2026-10-26）

审查者：独立子代理（general-purpose，只读，约 17 分钟 / 177 次工具调用）。结论：**阻断 2 / 高 7 / 低 9**。
用户对阻断项追加裁决 U7：**允许最小改 slice-29 的风控造数**（仅测试夹具）。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| B1 | 阻断 | slice-29 ⑥ 的第二条胜局是 1 真人 + 2 机器人；U2 整局剔除后只剩 1 局，严格 `games > minGames=1` 不命中，`games=2` 必红 | **U7 + D31**：允许最小改 slice-29 ⑥；第二条胜局改 3 真人，键改用 `player3.*` |
| B2 | 阻断 | 即使 B1 修掉，slice-29 仍 PUT 旧 PDK 键；player3 种子存在 ⇒ 旧键 PUT 无效 | **U7 + D31**：slice-29 ⑥ 改用 `player3.*` 键；D3 改称旧键仅回退、不再声称能维持 slice-29 |
| H1 | 高 | 第 32 条告警会打红 slice-18/slice-24 的硬编码 31；§7 未要求全量 conformance | **已修**：D23/D27/§5.8/§7/§9 加 slice-18/24 31→32；§7 加 slice-16/18/20/24/29/31/32 全量（不可用则逐项登记） |
| H2 | 高 | 新 admin + 旧 user-service 带 `gameType` 会 400；§6 只覆盖响应字段 | **已修**：D18/D32/§6：部署顺序 gateway+user-service → admin；admin 400 显示升级提示；补 gateway/controller 白名单测试 |
| H3 | 高 | 加“玩法”列后表头仍 9 列、详情 `colSpan=9`；verifier 无断言 | **已修**：D19/D27/§5.7/§7：表头/行/colSpan 三处 10 列；verifier 加表头与 colSpan 断言 |
| H4 | 高 | 冻结“零旗”会跳过 `risk:limit` 7d 续期，持续失败会静默解限 | **已修**：D21/§5.5/§6：冻结时 `throttled(auto)` **仅续旗**（Redis EX 7d，零 DB/审计）；补 fake-timer 测试 |
| H5 | 高 | 冻结只按 latest 是否涉及失败玩法；latest ddz+device、隐藏 PDK 新命中会被误释放 | **已修**：D21/§5.5/§6：任一玩法失败且 latest 为 `throttled(auto)` ⇒ 不得解除（仅续旗）；补矩阵测试 |
| H6 | 高 | slice-32 只断言“余额不为负”，未构造余额 < 应付，截断分支假绿 | **已修**：D26/§5.9/§7：开局后把输家余额降到 1，再终局；断言扣款=余额、赢家池=实际池、rake/residue 正确 |
| H7 | 高 | slice-32 每桶只注入 1 条记录，严格 `games > minGames=1` 不命中 | **已修**：D26/§5.9：每个 2/3/4 桶至少 2 条纯人类胜局 + 1 条机器人局证明剔除 |
| L1 | 低 | D10 “同口径”与详情 SQL 刻意不带 `users.status` 冲突 | **已修**：D10/§5.6/§5.10：明确“除 users.status 外同口径”，加测试钉住 |
| L2 | 低 | reasons 2/3/4 升序只写在文字，SQL 无 ORDER BY | **已修**：D7/D33/§5.4：代码显式排序 + 乱序夹具测试 |
| L3 | 低 | COUNT/SUM 归一化未列入 PDK 新行；未知人数逐行 WARN 刷屏 | **已修**：D30/§5.4：`Number()` 归一；未知人数按轮汇总一条 WARN |
| L4 | 低 | `autoThrottleScore` 26–49 语义未说明 | **已修**：D12/D13/§5.10/§6：25 / 26–49 / 50 三档语义；测试 25/26/50 |
| L5 | 低 | A3 玩家列表“与风控详情同口径”注释会变假 | **已修**：D34/§6/§9：改注释并登记两处口径差异 |
| L6 | 低 | 旧行 game_type 默认 ddz 不只影响 PDK 筛选；`game_type` 是“当前涉及”非历史 | **已修**：D35/§6：登记 platform/mixed/paodekuai 旧行偏差与 update 改写语义 |
| L7 | 低 | 93/31/71 等计数注释与文档漂移未列全 | **已修**：D27/§7/§9：逐项 grep 销账清单（含 `verify-admin-static` 71→79、`reviews.service` 50 线注释） |
| L8 | 低 | slice-20 新 7 键种子未明确；slice-32 baseline 初值可随意改 | **已修**：§5.10/§5.9：slice-20 新 7 键逐值；slice-32 baseline 初值固定、仅权威轮实测可改 |
| L9 | 低 | 新告警无 runbook；`risk.metrics.ts` 文件头“四个指标”未同步 | **已修**：D23/§5.8：告警 runbook；metrics 注释同步 |

> 修订后进入计划阶段前，需再复核上表处置是否全部落到 §4–§7 与 §9。

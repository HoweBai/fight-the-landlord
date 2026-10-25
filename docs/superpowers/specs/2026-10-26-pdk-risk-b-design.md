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
- 不改 slice-29（2/4 会话产物）；B 的真栈覆盖新建 slice-32。
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
作为 `playerN` 键缺失时的回退（见 D2 的理由：slice-29 仍 PUT 旧键，用户要求不改 slice-29）。

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
| D2 | 读取顺序（按人数 N）：`playerN.*` 存在 ⇒ 校验后使用（非法 ⇒ 代码默认，不回退）；缺失 ⇒ 现有 `game.paodekuai.risk.*` getter（旧 PDK → DDZ 新键 → DDZ 旧键 → 默认） | 与既有 PDK 回退纪律一致；旧键保留可写，避免破坏 slice-29 的 PUT |
| D3 | 现有 `game.paodekuai.risk.winRateThreshold`/`minGames` 仍为 active、仍在 admin IA、仍可写；备注改称“回退键” | 用户要求不改 slice-29；旧键在生产未部署，保留可写成本低 |
| D4 | 种子：6 个新键 0.8/100；`autoThrottleScore=50`；旧 PDK 两键种子不变 | 默认行为逐字不变；运营按人口调 |
| D5 | PDK 扫描 SQL 改为 `GROUP BY p.user_id, r.player_count`，行含 `player_count`；DDZ SQL 逐字不变 | 样本必须按人数拆；DDZ 恒 3 人 |
| D6 | 判定按人数：`pdkHitN = gamesN > minGamesN && winsN/gamesN > thresholdN`；`pdkHit = 任一 N`；胜率命中项仍只 25 分（玩法/人数都不叠分） | 与“命中项数×25”语义一致；防分数被玩法/人数放大 |
| D7 | `reasons`：每个 PDK 命中人数一条 `{check:'winRate',detail:{gameType:'paodekuai',playerCount:N,games,wins,winRate}}`；DDZ 保持 `{gameType:'doudizhu',games,wins,winRate}`（无 playerCount） | 管理面可区分人数；DDZ 兼容旧形状 |
| D8 | `risk_scan_hits_total{game_type}` 每用户每玩法最多 +1（PDK 多人数命中仍 +1） | 指标语义是“用户命中”，不是“人数命中” |
| D9 | PDK 扫描 SQL 加 `AND NOT EXISTS (SELECT 1 FROM game_record_players_pdk x WHERE x.record_id = p.record_id AND x.is_robot = 1)`；DDZ 不变 | U2；整局剔除；子查询走 `record_id` 索引 |
| D10 | 管理详情 `RISK_STATS_PDK_SQL` 改为按 `player_count` 分组，并同样整局剔除机器人局；DDZ 详情不变；A3 玩家列表不变 | 详情与扫描同口径；A3 不在本片 |
| D11 | `RiskUserDetail.stats.byGame.paodekuai` 增加 `byPlayerCount: {'2'|'3'|'4': {games,wins,winRate}}`，恒含三项；顶层 paodekuai = 三项合计 | 固定形状便于 admin；旧 user-service 窗口用可选链 |
| D12 | 新键 `game.paodekuai.risk.autoThrottleScore`：int `25 ≤ n ≤ 50`，默认 50；缺失/非法 ⇒ 50 | 分数只有 25/50，25=单命中即限流，50=关闭 PDK 单命中自动限流 |
| D13 | 有效自动限流线：`pdkWinRateHit ? min(50, pdkAutoThrottleScore) : 50`；open 武装与 throttled(auto) 续期/解除都用同一函数 | 只影响 PDK 胜率注入；设备/platform 仍 50；PDK 命中消失 ⇒ 回 50 线可自动解除 |
| D14 | `dismissed` 复活条件保持 `score > latest.score`，不因 PDK 独立阈值放宽 | 人工 dismiss 是显式豁免；同分反复重开会刷队列。登记为已知限制 |
| D15 | 新迁移 `1797000000005-RiskReviewGameType.ts`：`ALTER TABLE risk_reviews ADD COLUMN game_type varchar(16) NOT NULL DEFAULT 'doudizhu' AFTER status, ADD KEY idx_game_status_id (game_type,status,id)`；down 删索引+列 | U5；旧行默认 ddz；列表按 (game_type,status,id) 走索引 |
| D16 | `game_type` 推导：`winRate` reasons 的 `gameType` 集合（缺省/未知 ⇒ doudizhu）；两玩法 ⇒ `mixed`；无 winRate 但有 devices ⇒ `platform`；无 reasons（score=0 更新）⇒ 保留最新行值。新插入若推导为 null ⇒ `platform` | 写入面唯一真源；旧 reasons 兼容 |
| D17 | 锁读 SQL 增加 `game_type, reasons`；`applyScanResult` 用最新行 + 本次 reasons 计算 `nextGameType`，所有 insert/update 都写 game_type | 推导与冻结都要读最新行；列不漂移 |
| D18 | 列表 `REVIEWS_SELECT_BASE` 增加 `game_type`；API `RiskReviewItem.gameType`；筛选 `doudizhu`/`paodekuai` 用 `IN (…,'mixed')`，`mixed`/`platform` 用等值；controller 白名单 `gameType`，非法值 400 | 语义 = “包含该玩法”；mixed 在两玩法筛选里都出现 |
| D19 | gateway `RISK_REVIEWS_QUERY_KEYS` 加 `gameType`；admin UI 增加玩法筛选下拉 + 表格“玩法”列 + `gameType` 标签 | 端到端可用；静态闸断言 |
| D20 | 新指标 `risk_scan_sql_failures_total{scope}`（scope=doudizhu|paodekuai|device）；单玩法失败 catch 计数+ERROR 日志；设备失败计数后 rethrow；两玩法都失败 throw | U6；有界标签；失败可见 |
| D21 | 冻结保护：`applyScanResult(..., unavailableGames)` 在锁定读后、状态机前，若最新行的 `game_type ∪ reasons` 涉及任一失败玩法 ⇒ 直接返回（零写、零旗、零审计）；`platform` 永不冻结；无最新行不冻结 | 防失败玩法用户因样本缺失被误判 0 分而自动解限/误 dismiss |
| D22 | 单玩法失败轮仍记 `runs{ok}` 并刷 `last_success`；由新告警 `RiskScanSqlFailures` 覆盖；`RiskScanRoundResult` 增 `degradedGames` 供日志/测试 | 轮次确实完成（部分降级）；不改变 `runs` 值域与看板 |
| D23 | 告警 `RiskScanSqlFailures`：`sum by (scope) (increase(risk_scan_sql_failures_total[10m])) > 0`，for 5m，warning；告警总数 31→32、类 28→29 | B 必需的可观测面；不改 A1 看板 |
| D24 | 14003 保持 `baseScore × entryMultiplier`；不改 `message.router` 生产代码；补 PDK 2/3/4 单测与真栈断言 | U4；输光截断是既有安全网 |
| D25 | 机器人水位公式不改：`top = max(baseScoreLevels(gameType)) × entryMultiplier(gameType)`；补 PDK 2/4 结算/截断/afterSettle 单测；真栈断言余额不为负 | 改水位会影响 DDZ 经济，需另立产品裁决；本片只核对 |
| D26 | 新 conformance `slice-32-pdk-risk-gold`，不改 slice-29；覆盖 PDK gold 2/4、14003、rake>0、余额截断、记录、风险扫描玩法/人数维度、机器人局剔除、PDK 自动限流；Docker 不可用则只跑 tsc 并登记“待权威轮” | 用户要求不改 slice-29；B 需要独立真栈证据 |
| D27 | 配置计数：protocol 93→100；active/IA 77→84；简单控件 72→79；数字键 35→42；CONFIG_NOTES 77→84；种子行 93→100；`CLIENT_CONFIG_KEYS` 21、`LEGACY_CONFIG_KEYS` 16 不变 | 单一真源 `CONFIG_KEYS.length`；机械闸逐处同步 |
| D28 | `risk_reviews.game_type` 回滚顺序：先回滚代码（旧代码不 select 新列，兼容），再 down 迁移；配置新键回滚保留（旧镜像不读） | 无 2PC；避免新代码撞旧 schema |
| D29 | 机器人水位风险登记：bot 在低档房按全局最高档 top 充值（如 15 底分房 bot 仍有 ~1.38 万），高倍数局人类可从 bot 提取其全部余额；与 DDZ 同构，本片不改 | 经济面/反洗钱另立片；本片只保证截断与不为负 |
| D30 | 扫描对未知 `player_count`（非 2/3/4）行：跳过 + WARN，不计入任何人数桶 | 防御脏数据；不把未知人数硬塞 3 人 |

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
   - PDK 行按 `player_count` 写 `byGame.paodekuai`（未知人数 ⇒ WARN + 跳过）；
   - 设备行只补 `devices`。
4. 判定：

```ts
const ddzHit = ddz !== undefined && ddz.games > ddzMinGames && ddz.wins / ddz.games > ddzThreshold;
const pdkHits = (pdk ?? []).filter(
  (s) => s.games > pdkMinGames(s.playerCount) && s.wins / s.games > pdkThreshold(s.playerCount),
);
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
  1. 若 `unavailableGames` 非空且 `reviewInvolvedGames(latest)` 与任一失败玩法相交 ⇒
     **直接返回 null**（零写、零旗、零审计）。
  2. 计算 `nextGameType = deriveReviewGameType(reasons) ?? normalizeReviewGameType(latest.game_type) ?? 'doudizhu'`。
- 状态机分支不变，但：
  - `open` 的自动限流条件：`score >= autoThrottleLine(reasons, pdkScore)`；
  - `throttled(auto)` 的续期/解除条件同线；
  - 插入用 `deriveReviewGameType(reasons) ?? 'platform'`。
- `riskAutoThrottle()` 开关仍总闸。

### 5.6 管理详情与列表（`risk/admin-risk.service.ts`）

#### 详情统计

`RISK_STATS_PDK_SQL` 新文本：

```ts
export const RISK_STATS_PDK_SQL =
  "SELECT r.player_count AS player_count, COUNT(*) AS games, COALESCE(SUM(CASE WHEN p.seat = r.winner_seat THEN 1 ELSE 0 END), 0) AS wins FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id WHERE p.user_id = ? AND r.mode IN ('random', 'gold') AND p.is_robot = 0 AND NOT EXISTS (SELECT 1 FROM game_record_players_pdk x WHERE x.record_id = p.record_id AND x.is_robot = 1) GROUP BY r.player_count";
```

- 结果按 `player_count` 建三桶（2/3/4），恒含三项；未知人数跳过。
- `byGame.paodekuai` = 三桶合计；`byPlayerCount` 为三桶明细。
- 顶层 `stats.games/wins/winRate` = DDZ + PDK 合计（DDZ SQL 不变）。

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
    表格加「玩法」列（在状态后）。
  - `admin/app.js`：`riskQuery` 带 `gameType`；`riskState.filter` 含 `gameType`；
    `buildRiskRow` 加 `gameType` 标签；reset/search 同步。
- 详情：`renderRiskDetail` 在分玩法行后加「跑得快分人数：2 人 X 局 / Y 胜 · 胜率 Z；3 人…；4 人…」，
  用 `d.stats?.byGame?.paodekuai?.byPlayerCount?.[n]` 可选链。
- verifier：
  - 计数 100/84/84/79/35/2/42/84；
  - pdk 风控页签含 9 键；新键 step/suffix；旧键备注含“回退”；
  - `renderRiskDetail` 块内含 `byPlayerCount` 与 `分人数`；
  - `riskQuery`/`buildRiskRow` 含 `gameType`；
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
  `sum by (scope) (increase(risk_scan_sql_failures_total[10m])) > 0`，for 5m，warning。
- 头注释 31→32 条、28→29 类；`Dockerfile.prometheus` 注释同步。
- `scripts/verify-monitoring.mjs`：EXPECTED_ALERTS 加名；头注释 32/29；新增
  `RiskScanSqlFailures` 的 `scope`/`> 0`/唯一性断言。
- `tools/conformance/src/slices/slice-16-monitoring.ts`：EXPECTED_RULES 加名；
  所有 31/28 硬编码与注释同步。
- `docs/ops/first-deploy.md` 告警类别清单（若有）同步。
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
- ④ 风险扫描：用 `record.write` 注入 2/3/4 人 PDK 记录（含一条机器人座整局）+
  真实 gold 局记录；设置 per-count minGames=1、threshold=0.5；重启 user-service；
  轮询 `GET /api/admin/risk/users/:id` 与 `GET /api/admin/risk/reviews?gameType=...`：
  - reasons 含 `playerCount`；`stats.byGame.paodekuai.byPlayerCount` 正确；
  - 含机器人座的整局不计入（人类胜率不因该局升高）；
  - `gameType=paodekuai` 筛选能看到 mixed/paodekuai 行；`doudizhu` 不含纯 PDK 行；
  - `autoThrottleScore=25` 时第二轮扫描把 PDK 25 分条目自动限流（`risk:limit` 旗）。
- ⑤ 收尾：还原配置/队列/旗。
- 真栈不可用 ⇒ 只跑 `tsc`，报告中登记“待权威轮”，不得声称已跑。
- `baselines.json` 初始值按源内静态计数；CI 权威轮按实测校正。

### 5.10 单测（新增/更新）

- protocol：7 键位置/总数 100/CLIENT 21/LEGACY 16；三组 parser 正反例；autoThrottleScore 25/50/24/51/3.5/'50'。
- config-service：新迁移精确 SQL/值/version/down/幂等/时间戳；SEED 100；admin/client 100。
- user config cache：per-count 合法/非法/缺失回退链；autoThrottleScore；snapshot=null 安全。
- risk-scan：
  - PDK SQL 全文（player_count + NOT EXISTS 机器人整局剔除）；DDZ SQL 不变；查询顺序；
  - per-count 阈值/命中；reasons 带 playerCount；多人数命中仍 25；DDZ+PDK 仍 25/50；
  - 机器人局行不计入（SQL 文本钉 + 真栈）；
  - 单玩法失败隔离：ddz 失败 ⇒ pdk+device 继续；pdk 失败 ⇒ ddz+device 继续；
    两者都失败 ⇒ throw；device 失败 ⇒ throw；指标 scope；
  - 冻结：最新行 paodekuai/mixed + pdk 失败 ⇒ 零写；doudizhu + pdk 失败 ⇒ 照写；
    platform + pdk 失败 ⇒ 照写；旧行 game_type=doudizhu 但 reasons 含 pdk + pdk 失败 ⇒ 零写。
- reviews：
  - game_type 推导（ddz/pdk/mixed/platform/空）；insert/update 写列；
  - PDK 自动限流线（25 + pdkScore 25 ⇒ throttle；50 ⇒ 不；DDZ 25 ⇒ 不；mixed 25 ⇒ 是；
    device-only 25 ⇒ 不；PDK 消失 ⇒ 回 50 线解除）；
  - dismissed 同分不复活（PDK 也适用）；
  - 冻结保护全分支；锁定读/insert/update SQL 形状。
- risk-admin：详情 `byPlayerCount` 三桶；PDK SQL 全文（整局剔除 + 分组）；
  列表 `gameType` 筛选语义（doudizhu/pdk 含 mixed）；行 `gameType` 形状。
- room-service：14003 PDK 2/3/4；`canFormTable` 2/4 人谓词；2/4 结算/机器人资金/截断。
- admin verifier + monitoring verifier + conformance lint。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| `playerN` 键存在但非法 | 代码默认 0.8/100，不回退旧 PDK 键 |
| `playerN` 键缺失 / snapshot=null | 回退旧 PDK getter（旧 PDK → DDZ 新 → DDZ 旧 → 默认），不抛 |
| PDK 记录 `player_count` 非 2/3/4 | WARN + 跳过该行，不计入任何人数桶 |
| PDK 局含机器人座 | 整局不计入扫描/详情人类样本 |
| DDZ 局含机器人座 | 行为不变（机器人行 user_id NULL 已被 JOIN 排除；人类行仍计） |
| 单玩法 SQL 失败 | 该玩法跳过 + 指标 + ERROR；另一玩法 + 设备继续；该玩法已有审核行冻结 |
| 两玩法 SQL 都失败 | 整轮 throw（runs fail、last_success 不推进、锁释放） |
| 设备 SQL 失败 | 计数后 throw（fail-fast） |
| 冻结用户本轮有其他命中 | 本轮不更新（下一轮收敛）；不误自动解除/误 dismiss |
| 最新行 `game_type=platform` | 永不因玩法 SQL 失败冻结 |
| 最新行旧 `game_type=doudizhu` 但 reasons 含 paodekuai | 视为涉及 PDK（reasons 兜底） |
| PDK-only 25 分 + `autoThrottleScore=25` | open 第二轮起自动限流；首轮新建行不武装（⚙️20） |
| PDK-only 25 分 + `autoThrottleScore=50` | 不自动限流；进队列人工处置 |
| `dismissed` + 同分 PDK 再命中 | 不复活（人工豁免）；score 升高才复活 |
| 14003 余额不足 | 维持 14003；消息含 needed；不入队 |
| 输光截断 | `pay = min(应付, 余额)`；赢家按实际池分摊；不出现负余额 |
| 机器人水位不可推导 | 既有 ensure 抛 / afterSettle fail-open 语义不变 |
| 新 admin + 旧 user-service | `byPlayerCount` 可选链，缺失按 0/—；队列行 `gameType` 缺失按 ddz 显示 |
| 旧 admin + 新 user-service | 忽略新字段；`gameType` 筛选不传 |
| 回滚代码但保留迁移 | 旧代码不 select `game_type`，兼容；配置新键保留无害 |
| 回滚迁移 | 必须先回滚代码；down 删索引+列 |

**已知限制（预登记）**：

- 旧 `risk_reviews` 行迁移后 `game_type='doudizhu'`；若其 reasons 含 PDK，列表筛选 `paodekuai`
  不会显示（仅冻结保护用 reasons 兜底）。生产尚未部署 PDK 风控，影响面仅为 dev。
- PDK 与 DDZ 的机器人局口径不同（PDK 整局剔除、DDZ 保持）；这是 U2 的显式选择。
- 机器人低档房按全局最高档 top 充值（D29），经济面风险另立片。
- `dismissed` 同分不复活对 PDK 独立阈值同样成立；人工 dismiss 是显式豁免。

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
7. conformance：slice-20 键集/种子同步；slice-32 可在真栈跑（Docker 不可用则登记待权威轮）；
   `pnpm -C tools/conformance lint` / tsc 通过。
8. 全量：`pnpm exec turbo run test lint --force`（0 cached 才算真跑）；
   工作区干净（除用户既有未提交文件）。
9. 真栈：能起则跑 slice-32；不能起则报告中逐项登记“待权威轮”，不得声称已跑。

## 8. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 旧 PDK 两键保留可写但被新键遮蔽 | 运营改旧键无效 | admin 备注明确“回退键：对应人数键缺失时生效”；新键优先 |
| 整局剔除机器人后 PDK 样本变小 | 命中延迟 | 运营可下调 minGames；观察期看队列/命中指标 |
| 冻结保护让部分用户一轮不更新 | 收敛延迟 | 下一轮收敛；仅失败玩法涉及的审核行 |
| 单玩法失败轮记 ok | `RiskScanStalled` 不响 | 新 `RiskScanSqlFailures` 告警覆盖；文档写明 |
| 自动限流 25 误伤 | PDK 单命中即限流 | 默认 50；运营显式改 25；先观察再开 |
| 旧行 game_type 默认 ddz | 列表筛选偏差 | 生产未部署 PDK 风控；冻结保护用 reasons 兜底；登记 |
| 机械闸计数遗漏 | CI 红 | 单一真源 `CONFIG_KEYS.length` + verifier 显式计数 + 全量搜索旧计数 |
| 迁移时间戳撞车 | 迁移失败 | 1796900000000 / 1797000000005，迁移测试全仓唯一 |
| slice-32 真栈未跑 | 行为未验 | 单测 + SQL 全文钉；报告登记“待权威轮” |
| 与 A2/A3/2-4 分支冲突 | 合并冲突 | B 从 e1663df8 开出（已含三者）；不改 slice-29；交付报告写栈关系 |

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
- `test/{config-cache,risk-scan,risk-admin,migration}.test.ts`

**room-service**（仅测试；生产 14003/水位不改）
- `test/message.router.test.ts`、`predicates.test.ts`、`match-player-count.test.ts`、
  `currency/robot-funding.test.ts`、结算/截断相关测试

**gateway / admin / monitoring**
- `packages/api-gateway/src/gateway/gateway.controller.ts`（query 白名单）
- `packages/api-gateway/test/*`（白名单测试）
- `admin/app.js`、`admin/index.html`
- `scripts/verify-admin-static.mjs`
- `deploy/monitoring/prometheus/rules/ftl-alerts.yml`
- `scripts/verify-monitoring.mjs`
- `Dockerfile.prometheus`
- `tools/conformance/src/slices/slice-16-monitoring.ts`
- `tools/conformance/src/slices/slice-20-risk-control.ts`
- `tools/conformance/src/slices/slice-32-pdk-risk-gold.ts`（新）
- `tools/conformance/src/run.ts`、`baselines.json`

**文档**
- `docs/design.md`、`docs/games/paodekuai.md`、`docs/client-protocol.md`、
  `docs/ops/first-deploy.md`
- `docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`
- `docs/superpowers/plans/deviation-ledger.md`
- 本 spec 的「审查记录」

## 10. 审查记录

### 10.1 设计对抗审查（待填）

（第一轮独立 reviewer 结论与处置将写在此处。）

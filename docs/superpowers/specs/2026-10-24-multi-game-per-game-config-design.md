# 多玩法配置平行化（场次 / 好友房 / 金币经济 / 斗地主专属键）· 设计 v1.0

> 用户裁决（2026-10-24）：
> - 跑得快的配置与斗地主是**平行**关系，能归到玩法的配置都归到玩法下；
> - 旧平台键**只读不写**；回滚前用回填脚本把新值写回旧键；
> - 跑得快新键默认**保守灰度**：免费场开、金币场关、好友房关、补位开、抽水 0、门槛 10；
> - 每日广告救助是**平台级**安全网，不是单个玩法；用平台级绝对门槛。

## 1. 背景与问题

2026-10-23 的多玩法片把跑得快接入了平台，但配置仍是“平台级公共键 + 跑得快专属键”：

- 跑得快已经有独立的底分档位 `game.levels.paodekuai` 和台费（档位项 `entryFeePercent`）；
- 免费场 / 金币场 / 好友房 / 机器人补位 / 抽水 / 入场门槛仍只有平台级键
  `room.*` / `currency.*`；
- 斗地主的记牌器、机器人 AI、风控胜率键也在平台命名空间下。

结果：跑得快总开关一开，免费场、金币场、好友房会同时跟随斗地主的全局开关；
运营无法按玩法灰度，也无法给两个玩法设不同经济参数。

## 2. 范围

### 2.1 做

- 把下列配置迁到 `game.doudizhu.*` 与 `game.paodekuai.*` 两套平行键：
  1. 场次：免费场、金币场；
  2. 好友房；
  3. 机器人补位（免费场 / 金币场）；
  4. 金币经济：抽水、入场门槛倍率；
  5. 底分档位（斗地主新增 `game.levels.doudizhu`）；
  6. 记牌器三键（仅斗地主）；
  7. 机器人 AI 三键（仅斗地主）；
  8. 风控胜率两键（仅斗地主）。
- 新增平台级 `currency.reliefThresholdCoins`（绝对金币门槛）。
- 服务端按玩法读取、按玩法执法；客户端按当前玩法渲染场次/好友房入口。
- 旧键保留为只读回退；管理面拒写旧键。
- 迁移、回滚 runbook、测试与文档同步。

### 2.2 不做

- 不把风控扫描扩展到 `game_records_pdk`（独立缺口，另立片）。
- 不把匹配节奏 / 无机器人等待上限玩法化。
- 不为跑得快新增机器人 AI / 风控键（当前没有对应能力）。
- 不把钱包救助金额、注册赠送、支付、端准入等平台级配置玩法化。
- 不新增斗地主总开关（斗地主恒开）。

## 3. 决策表

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 采用**平行键**：`game.doudizhu.*` / `game.paodekuai.*`；旧平台键只读保留 | 用户裁决；未来第三个玩法用同一结构 |
| D2 | 键名统一 `game.<gameType>.<suffix>`；斗地主档位为 `game.levels.doudizhu` | 与既有 `game.levels.paodekuai` 对齐 |
| D3 | 读顺序：新键 → 旧键（仅斗地主）→ 代码默认；**新键存在但值非法不回退旧键** | 部署窗口零破坏；坏值仍 fail-closed，与写入口校验一致 |
| D4 | 跑得快新键种子：免费场 `true`、金币场 `false`、好友房 `false`、补位 `true`、抽水 `0`、门槛 `10` | 用户裁决：先跑免费场，不碰真钱 |
| D5 | 每日救助门槛改为平台级绝对金币 `currency.reliefThresholdCoins`（种子 `150`） | 用户裁决：救助是平台级；不再依赖任何玩法档位/倍率 |
| D6 | 旧键从管理面写入中移除；`PUT /api/admin/config/<旧键>` ⇒ 400 | 用户裁决“只读不写”；避免双真源静默无效 |
| D7 | `/api/config` 顶层旧字段继续下发，值派生自斗地主新键 | 旧客户端零破坏 |
| D8 | 大厅玩法卡可见 = `enabled && (免费场 || 金币场 || 好友房)` | 用户裁决：不可玩则隐藏；好友房单独开着仍可见 |
| D9 | 服务端按玩法执法：匹配 `12010`、好友房 `12006`、玩法/人数 `12012` | 复用既有错误码，不新增协议码 |
| D10 | 抽水、入场门槛、机器人水位按玩法计算；机器人水位 = 该玩法最高档 × 该玩法门槛倍率 | 经济参数与档位必须同源 |
| D11 | 回滚到旧镜像前跑回填脚本（新键 → 旧键），写入 runbook | 用户裁决；旧键保持只读 |
| D12 | 匹配节奏、`room.matchNoBotMaxWaitMs`、`record.*`、`risk.predicate.*`、支付、端准入、广告位保持平台级 | 与玩法无关 |
| D13 | 机器人 AI 三键、风控胜率两键迁到斗地主命名空间 | 用户裁决“只和斗地主相关的都迁” |
| D14 | 记牌器三键迁到斗地主命名空间；跑得快继续由 `GAME_META` 能力位拦截 | 跑得快无记牌器 |
| D15 | 不新增 `game.doudizhu.enabled` | 斗地主恒开；避免新的全局停服面 |
| D16 | 推翻旧 D8：`game.baseScoreLevels` 迁到 `game.levels.doudizhu`，旧键只读回退 | 用户裁决“彻底迁移到平行键” |
| D17 | `room.match` 的 `practice` 分支也按 `friendRoomEnabled(gameType)` 执法，关 ⇒ `12006` | 防改包客户端绕过好友房开关 |
| D18 | 回滚回填**以斗地主为权威源**；跑得快专有值在回滚时丢弃并公告 | 旧镜像只有一套共享键，无法同时保留两个玩法 |
| D19 | 升级窗口内**不得修改新键**（尤其记牌器价格）；全部消费者升级完成后再改 | 避免新旧服务读不同键导致价格/扣费错位 |

## 4. 键清单

### 4.1 迁移键（旧键 → 斗地主新键 / 跑得快新键）

| 旧键 | `game.doudizhu.*` | `game.paodekuai.*` |
|---|---|---|
| `room.freeRoomEnabled` | `freeRoomEnabled` | `freeRoomEnabled` |
| `room.goldRoomEnabled` | `goldRoomEnabled` | `goldRoomEnabled` |
| `room.friendRoomEnabled` | `friendRoomEnabled` | `friendRoomEnabled` |
| `room.freeBotFillEnabled` | `freeBotFillEnabled` | `freeBotFillEnabled` |
| `room.goldBotFillEnabled` | `goldBotFillEnabled` | `goldBotFillEnabled` |
| `currency.rakePercent` | `rakePercent` | `rakePercent` |
| `currency.entryMultiplier` | `entryMultiplier` | `entryMultiplier` |
| `game.baseScoreLevels` | `game.levels.doudizhu` | `game.levels.paodekuai`（已有） |
| `game.cardCounterEnabled` | `cardCounterEnabled` | — |
| `game.cardCounterPricePerGameCoins` | `cardCounterPricePerGameCoins` | — |
| `game.cardCounterPricePerHourCoins` | `cardCounterPricePerHourCoins` | — |
| `robot.skillDistribution` | `robot.skillDistribution` | — |
| `robot.ruleFallback` | `robot.ruleFallback` | — |
| `robot.modelBySkill` | `robot.modelBySkill` | — |
| `risk.winRateThreshold` | `risk.winRateThreshold` | — |
| `risk.minGames` | `risk.minGames` | — |

> 表内 `game.doudizhu.*` 省略前缀；例如 `game.doudizhu.freeRoomEnabled`。
> 跑得快规则/计分 11 键、`enabled`、`nonThreePlayerEnabled` 继续使用既有
> `game.paodekuai.*`，不重复迁移。

### 4.2 新增平台键

| 键 | 类型/范围 | 种子 |
|---|---|---|
| `currency.reliefThresholdCoins` | int `1..1,000,000` | `150` |

### 4.3 默认值

**斗地主 16 个新键**（迁移时复制旧键当前值；旧行缺失时用下表兜底，与旧种子逐字同值）：

| 新键 | 兜底默认 |
|---|---|
| `game.doudizhu.freeRoomEnabled` | `true` |
| `game.doudizhu.goldRoomEnabled` | `true` |
| `game.doudizhu.friendRoomEnabled` | `false` |
| `game.doudizhu.freeBotFillEnabled` | `true` |
| `game.doudizhu.goldBotFillEnabled` | `true` |
| `game.doudizhu.rakePercent` | `0` |
| `game.doudizhu.entryMultiplier` | `10` |
| `game.levels.doudizhu` | 四档 `休闲场 15 / 标准场 80 / 竞技场 480 / 豪侠场 1200`（无 `entryFeePercent` 字段 = 0） |
| `game.doudizhu.cardCounterEnabled` | `true` |
| `game.doudizhu.cardCounterPricePerGameCoins` | `10` |
| `game.doudizhu.cardCounterPricePerHourCoins` | `100` |
| `game.doudizhu.robot.skillDistribution` | `{"beginner":0.15,"intermediate":0.35,"advanced":0.5}` |
| `game.doudizhu.robot.ruleFallback` | `true` |
| `game.doudizhu.robot.modelBySkill` | `{"beginner":"sl","intermediate":"douzero_WP","advanced":"douzero_ADP"}` |
| `game.doudizhu.risk.winRateThreshold` | `0.8` |
| `game.doudizhu.risk.minGames` | `100` |

**跑得快 7 个新键**：免费场 `true`、金币场 `false`、好友房 `false`、免费补位 `true`、
金币补位 `true`、抽水 `0`、门槛 `10`。

**`currency.reliefThresholdCoins`**：迁移时**现算** = `MIN(斗地主档位 baseScore) × 斗地主
entryMultiplier`（正常种子 = 15 × 10 = 150；运营改过档位/倍率的库不会凭空回到 150）。

### 4.4 旧键保留

旧键继续存在于 `platform_config` 与 `config.snapshot` 中，供：

- 新代码在新键缺失（迁移未跑 / 快照不完整）时回退；
- 回滚到旧镜像时读取；
- 回滚前回填脚本写入。

## 5. 实现设计

### 5.1 protocol（`packages/protocol/src/config.ts`）

- `CONFIG_KEYS` 增加 16 个斗地主新键、7 个跑得快新键、`currency.reliefThresholdCoins`；
  旧键**保留**在清单中（快照类型与解析器仍认识）。
- 新增 `LEGACY_CONFIG_KEYS`（16 个旧键）与 `isLegacyConfigKey()`；管理面写入口据此拒绝。
- `parseConfigValue`：
  - boolean 族：新键与旧键都走 `parseStrictBoolean`；
  - `game.doudizhu.rakePercent` / `game.paodekuai.rakePercent` → `parseRakePercent`；
  - `game.doudizhu.entryMultiplier` / `game.paodekuai.entryMultiplier` → `parseEntryMultiplier`；
  - `game.levels.doudizhu` → `parseBaseScoreLevels`；
  - `game.doudizhu.cardCounterPrice*` → `parseCardCounterPrice`；
  - `game.doudizhu.robot.*` → 复用既有 `parseSkillDistribution` / `parseStrictBoolean` / `parseModelBySkill`；
  - `game.doudizhu.risk.*` → 复用 `parseWinRateThreshold` / `parseMinGames`；
  - `currency.reliefThresholdCoins` → 新 `parseReliefThresholdCoins`（int `1..1,000,000`）。
- `ClientGameConfig` 增加可选字段（旧服务端缺失 ⇒ 客户端回退顶层值）：
  `freeRoomEnabled?`、`goldRoomEnabled?`、`friendRoomEnabled?`、`entryMultiplier?`。
- `ClientConfig` 增加可选 `reliefThresholdCoins?: number`（旧服务端缺失 ⇒ 旧算法）。
- 记牌器仍是顶层裸名（派生自斗地主新键）；跑得快无此能力，不需要按玩法嵌套。
- `CLIENT_CONFIG_KEYS` 增加 `reliefThresholdCoins`；其余顶层字段不变。

### 5.2 config-service

#### `/api/config`（`client-config.controller.ts`）

- 读取辅助：`readGameKey(byKey, gameType, suffix, legacyKey, fallback)`；新键缺失才回退旧键。
- 顶层字段派生：
  - `baseScoreLevels` ← `game.levels.doudizhu`（缺失回退 `game.baseScoreLevels`）；
  - `freeRoomEnabled` / `goldRoomEnabled` / `friendRoomEnabled` ← 斗地主新键；
  - `entryMultiplier` ← `game.doudizhu.entryMultiplier`；
  - `cardCounter*` ← `game.doudizhu.cardCounter*`；
  - `reliefThresholdCoins` ← 平台新键；读侧复用 `parseReliefThresholdCoins`，
    **缺失/非法 ⇒ 不下发该字段**（客户端回退旧算法）。
- `games.doudizhu`：`enabled:true`、人数/档位 + 上述场次/好友房/门槛字段。
- `games.paodekuai`：`enabled` / 人数 / 档位 + 跑得快场次/好友房/门槛。
- 顶层 `baseScoreLevels` 与 `games.doudizhu.baseScoreLevels` 同源。

#### 管理写入（`platform-config.service.ts`）

- `set()` 第一行（身份校验之后、任何库操作之前）：
  `if (isLegacyConfigKey(key)) throw new ProtocolError('该键已废弃，请使用 game.doudizhu.* / game.paodekuai.*')`。
- `GET /api/admin/config` 仍返回旧键行（只读展示/回滚依赖）；IA 不再列出它们。

#### 迁移（`1796500000000-SplitGameConfig.ts`）

- **JS 驱动复制**（不用 `INSERT ... SELECT`，便于测试与真值计算）：
  1. `SELECT key, value, version FROM platform_config WHERE key IN (<16 个旧键>)`；
  2. 逐键 `INSERT IGNORE INTO platform_config (...) VALUES (?, ?, ?, NOW(3), 'seed')`，
     新键/旧值/旧版本参数化写入；
  3. 旧行缺失的键用 §4.3 的兜底默认值补种；
  4. `currency.reliefThresholdCoins` 现算：解析旧 `game.baseScoreLevels` 的
     `MIN(baseScore) × 旧 currency.entryMultiplier`（旧键缺失时回落 15 × 10 = 150）。
- 跑得快 7 键直接 `INSERT IGNORE` 种子（D4）。
- `down()` 删除本次新增的新键（旧键**不删**）。
- 时间戳 `1796500000000`，全仓唯一；`INSERT IGNORE` 可重跑。
- 真库冒烟：迁移后在真 MySQL 上 `SELECT COUNT(*)`（应含 89 行）并抽查 16 个新键值；
  该步骤进全量验证，不依赖假库。

### 5.3 room-service

#### 配置缓存（`config/config-cache.service.ts`）

新增统一读取：

```ts
private gameBool(gameType, suffix, legacyKey, fallback): boolean
private gameInt(gameType, suffix, legacyKey, fallback): number
private levelsKeyOf(gameType): 'game.levels.doudizhu' | 'game.levels.paodekuai'
```

改造现有 getter：

- `freeRoomEnabled(gameType = 'doudizhu')`
- `goldRoomEnabled(gameType = 'doudizhu')`
- `friendRoomEnabled(gameType = 'doudizhu')`
- `freeBotFillEnabled(gameType = 'doudizhu')`
- `goldBotFillEnabled(gameType = 'doudizhu')`
- `botFillEnabled(mode, gameType)`
- `entryMultiplier(gameType = 'doudizhu')`
- `rakePercent(gameType = 'doudizhu')`
- `baseScoreLevels(gameType)`：斗地主读 `game.levels.doudizhu`，缺失回退 `game.baseScoreLevels`；
  跑得快读 `game.levels.paodekuai`；坏值仍 fail-closed（10007）。
- `entryFeePercents(gameType)`：**必须与 `baseScoreLevels` 同一条新→旧回退**；
  滚动窗口/迁移未跑时旧键仍能收费，绝不因新键缺失静默变成 0（fail-open 收入面）。
- `cardCounterEnabled()` / `cardCounterPrices()`：只读斗地主新键（回退旧键）；
  调用方仍由 `GAME_META[gameType].capabilities.cardCounter` 闸住。
- `entryFeePercents(gameType)` 继续由档位表派生，天然按玩法。

#### 匹配与好友房

- `message.router.ts`：`modeEnabled(deps, gameType, mode)`；
  random → `freeRoomEnabled(gameType)`，gold → `goldRoomEnabled(gameType)`；
  关闭 ⇒ `12010`。
- **`practice` 分支也执法**（D17）：`room.match {mode:'practice'}` 仍需
  `friendRoomEnabled(gameType)` 为真，否则 `12006` —— 防改包客户端绕过 REST 好友房闸。
- `match.service.ts`：`botFillEnabled(mode, gameType)` 读的是 `queue.gameType`
  （队列对象已携带），跑得快的补位开关才真正生效；`practice` 仍恒补。
- `rooms.controller.ts`：
  - `GET /api/rooms?gameType=`：`friendRoomEnabled(gameType)` 关 ⇒ 返回空数组（既有语义）；
  - `POST /api/rooms`：`friendRoomEnabled(dto.gameType ?? 'doudizhu')` 关 ⇒ `12006`；
  - `POST /api/rooms/:code/join`：全局检查移除，改由 `RoomsService.join` 在读到房间后
    按房间 `gameType` 检查；关 ⇒ `12006`（占座之前）。
- `rooms.service.create()` 不做好友房开关检查（匹配路径也走它）；玩法/人数/档位校验不变。

#### 金币经济与机器人

- `rooms.start.ts`：`robotFunding.ensureBots(botIds, gameType)`。
- `settle.service.ts`：
  - `rakePercent = configCache.rakePercent(room.gameType ?? 'doudizhu')`；
  - `SettleRobotHook.afterSettle(balances, gameType)`，结算收尾把玩法传下去。
- `robot-funding.ts`：
  - `ensureBots(botIds, gameType)`；
  - `afterSettle(balances, gameType)`；
  - `computeTop(gameType)` = 该玩法档位最高档 × 该玩法 `entryMultiplier`。
- 入场门槛 `message.router.ts`：`needed = baseScore * entryMultiplier(matchGameType)`。

### 5.4 currency-service

- `config-cache.service.ts`：
  - 新增 `reliefThresholdCoins(): number | null`：平台新键；缺失/非法 ⇒ **null**；
  - **删除** `entryMultiplier()` 与 `minBaseScoreLevel()`：救助改用绝对门槛后无其他消费者
    （避免留下第二真源/误导性读取）；对应测试同步删除；
  - `cardCounterEnabled()` / `cardCounterPrices()` 改读 `game.doudizhu.cardCounter*`（回退旧键）。
- `wallet.controller.ts`：救助门槛用 `reliefThresholdCoins()`；null ⇒ 503/10007
  （与“档位表不可用”同族：钱路径 fail-closed，不按 150 猜）。
- `ads/ad-callback.service.ts`：同样改用 `reliefThresholdCoins()`；null ⇒ 瞬态（不落 done）。
- `config.client.ts` 注释与消费键同步。

### 5.5 user-service（风控）

- `config-cache.service.ts`：`riskWinRateThreshold()` / `riskMinGames()` 读
  `game.doudizhu.risk.*`，缺失回退 `risk.*`，再回退代码默认。
- 风险扫描逻辑不变（仍只覆盖斗地主记录）。

### 5.6 robot-service

- `config/config-cache.service.ts`：`skillDistribution()` / `ruleFallback()` /
  `modelBySkill()` 读 `game.doudizhu.robot.*`，缺失回退旧键，再回退默认。
- `ROBOT_CONFIG_DEFAULTS` 键名同步为新键；旧键仅用于回退。
- 跑得快规则机器人不读这些键。

### 5.7 客户端

#### 配置归一（`useClientConfig.ts` / `stores/game.ts`）

- `ClientGameConfig` 新字段缺失 ⇒ 回退顶层旧字段（兼容旧服务端）。
- 新增 store getter：
  - `gamePlayable(id) = enabled && (freeRoomEnabled || goldRoomEnabled || friendRoomEnabled)`；
  - `activeFreeRoomEnabled` / `activeGoldRoomEnabled` / `activeFriendRoomEnabled`；
  - `activeEntryMultiplier`（回退顶层 `entryMultiplier`）。
- `modeEnabled` 保留原语义（仅 `enabled`）；大厅改用 `gamePlayable` 过滤玩法卡。

#### 大厅 / 开始游戏页

- 场次页签按当前玩法过滤；当前玩法没有场次但仍可好友房 ⇒ 卡可见、场次区为空、
  开始按钮不显示，好友房入口可用。
- 好友房入口按当前玩法过滤。
- 配置刷新后：若 `activeMode` 不再可玩 ⇒ 切到第一个可玩玩法；
  若 `roomMode` 在新玩法下不可用 ⇒ 回落到该玩法第一个可用场次；
  若 `selectedBaseScore` 不在新档位表 ⇒ 回落到第一档。
- `goldThreshold` 用当前玩法的 `entryMultiplier`。
- `reliefAvailable`：`reliefThresholdCoins` 存在 ⇒ `walletBalance < reliefThresholdCoins`；
  缺失 ⇒ 保留旧公式（顶层档位最低档 × 顶层倍率）。

#### 好友房

- 建房/进房继续发送 `activeGameType`；服务端按玩法闸。
- 好友房列表请求带 `gameType`（已有）。

### 5.8 管理后台（`admin/app.js`）

- 「玩法 → 斗地主」：
  - 玩法规则：`game.levels.doudizhu`；
  - 对局辅助：`game.doudizhu.cardCounter*`；
  - 场次开关：`game.doudizhu.freeRoomEnabled` / `goldRoomEnabled` / `friendRoomEnabled` /
    `freeBotFillEnabled` / `goldBotFillEnabled`；
  - AI 机器人：`game.doudizhu.robot.*`；
  - 金币场经济：`game.doudizhu.rakePercent` / `entryMultiplier`；
  - 风控检测：`game.doudizhu.risk.*`。
- 「玩法 → 跑得快」：
  - 新增「场次开关」：`game.paodekuai.freeRoomEnabled` / `goldRoomEnabled` /
    `friendRoomEnabled` / `freeBotFillEnabled` / `goldBotFillEnabled`；
  - 新增「金币场经济」：`game.paodekuai.rakePercent` / `entryMultiplier`。
- 「通用设置 / 平台」：房间节奏、`room.matchNoBotMaxWaitMs`、`robot.reclaimIntervalMs`、
  `record.*`、`risk.predicate.*` / `device*` / `scan*`、`currency.signupGrant` /
  `reliefEnabled` / `reliefAmount` / `reliefThresholdCoins` / `reconcileIntervalMs`、
  `pay.*`、`client.*`、`ad.*`。
- 旧键不出现在任何 IA 列表中；`CONFIG_NOTES` / `KEY_META` / 结构化键清单同步：
  - 每个新键至少一条运营口吻备注（可复用旧键文案并改键名/玩法限定）；
  - “未分组域”的差集计算**排除** `LEGACY_CONFIG_KEYS`；搜索遍历也排除旧键
    （旧键不出现在任何可保存控件里；如需展示，只做只读卡片）；
  - `STRUCT_KEYS` 增加 `game.levels.doudizhu`；`buildStructCard` 的编辑器分派必须补
    `game.levels.doudizhu` 与 `game.levels.paodekuai` 两个 `buildLevelsEditor` 分支
    （现状只认旧 `game.baseScoreLevels`，漏了 pdk）；
  - `scripts/verify-admin-static.mjs` 的键集断言从“IA = CONFIG_KEYS”改为
    “IA = CONFIG_KEYS − LEGACY_CONFIG_KEYS”，并更新键总数与 pdk 页签断言
    （规则/计分/开关/场次开关/金币场经济）；补一条“结构化编辑器分派覆盖 levels 两键”的断言。

### 5.9 文档与 conformance

- `docs/games/paodekuai.md` §7.1：补充场次/好友房/补位/抽水/门槛键与默认值；
  注明旧键只读。
- `docs/client-protocol.md`：`ClientGameConfig` / `ClientConfig` 新字段。
- `docs/design.md`：§7.5 配置表相关行改为新键；消费者清单同步。
- `docs/ops/first-deploy.md`：配置表相关行改为新键，并注明旧键只读。
- `docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`：
  增加“回滚前回填”一节与逐键 SQL。
- `tools/conformance/src`：
  - 客户端键集字面量 20 → 21（新增 `reliefThresholdCoins`）：slice-14/17/18/21/24；
  - 管理面键总数改为 `CONFIG_KEYS.length`（slice-18/20/22/23），不再写字面 65；
  - 写旧键的用例全部改新键：slice-18（场次/抽水）、slice-25（档位）、slice-28（记牌器）、
    slice-13（robot.ruleFallback）、slice-20（风控胜率/最少局数）、`lib/http.ts`（好友房）；
  - slice-14 的**直接 SQL 演练**（绕过管理 API 改 `room.friendRoomEnabled`）也改
    `game.doudizhu.friendRoomEnabled`，否则新代码不读该键 ⇒ 演练假绿；
  - slice-19 的“旧键任意 400”断言改为“旧键 400 + 废弃文案”，防止“任意 400”蒙混；
  - slice-29 的跑得快开关不动（`game.paodekuai.enabled` 未迁移）。
- 本 spec 的「审查记录」。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 新键缺失（迁移未跑/回滚窗口） | 斗地主回退旧键；跑得快回退代码默认 |
| 新键值非法 | 不回退旧键；boolean/int 取代码默认，档位表 fail-closed（10007），收费表空表（不收） |
| 旧键写入 | 400 `BAD_PARAM`，消息提示使用新键 |
| 玩法关闭 | 匹配/建房/进房按既有码：`12012` |
| 场次关闭 | `room.match` ⇒ `12010` |
| 好友房关闭 | 列表返回空；建房/进房 ⇒ `12006`；`room.match {mode:'practice'}` 同样 ⇒ `12006` |
| 新键缺失时的台费 | `entryFeePercents` 回退旧档位表，**不静默变 0**；两表都不可用才空表（不收） |
| 玩法三入口全关 | 大厅隐藏玩法卡；当前选中被隐藏 ⇒ 回落第一个可玩玩法 |
| 只开好友房 | 玩法卡可见；开始按钮不显示；好友房可用 |
| 救助门槛缺失/非法 | currency-service **fail-closed**（503 / 瞬态，不按 150 猜）；`/api/config` 不下发该字段（客户端回退旧算法） |
| 机器人水位不可推导 | 沿用既有：ensure 抛、afterSettle fail-open |

## 7. 测试判据

### 7.1 protocol

- `CONFIG_KEYS` 含全部新键；`LEGACY_CONFIG_KEYS` 恰为 16 个旧键；`isLegacyConfigKey` 正确。
- 每个新键的 parser 正例/反例（boolean / rake / entry / levels / cardCounter / robot / risk / relief）。
- 旧键 parser 仍可用（快照读取/回填）。
- `ClientGameConfig` / `ClientConfig` 类型与 `CLIENT_CONFIG_KEYS` 同步。

### 7.2 config-service

- 迁移：内存假库执行 `up()` 两次（幂等）；16 个旧值逐键复制；旧行缺失走 §4.3 兜底；
  `reliefThresholdCoins = MIN(档位) × 倍率`；`down` 只删新键。另加真 MySQL 冒烟
  （迁移后 89 行 + 抽查新键值），不依赖假库。
- `/api/config`：
  - 新键优先、旧键回退（删除新行后断言回退）；
  - 顶层字段与 `games.doudizhu` 同源；
  - 跑得快保守默认值；
  - `reliefThresholdCoins` 下发；坏值 ⇒ 不下发；
  - 坏新键不回退旧键（档位表空表 / 默认值）。
- 管理面：写新键成功；写旧键 400 + 废弃文案且不落库；`GET /api/admin/config` 仍能读到旧键行。

### 7.3 room-service

- 匹配：斗地主/跑得快 × 免费场/金币场开关矩阵，关 ⇒ `12010`；`practice` 关 ⇒ `12006`。
- 好友房：列表按玩法返回空；建房/进房按房间玩法 ⇒ `12006`；占座前拒绝。
- 经济：`rakePercent(gameType)`、`entryMultiplier(gameType)`、`entryFeePercents(gameType)`；
  **新档位键缺失仍按旧键收台费**。
- 机器人补位：`botFillEnabled(mode, queue.gameType)` 两玩法矩阵；
  跑得快关补位 ⇒ 不补机器人。
- 机器人水位：两玩法不同档位/倍率 ⇒ top 不同；`afterSettle` 带玩法。
- 记牌器：跑得快不扣费/不下发（既有能力位测试保持）。

### 7.4 currency-service

- 救助端点/广告回调用 `reliefThresholdCoins`；缺失/非法 ⇒ 503/瞬态（不发放）。
- 记牌器价格读斗地主新键并回退旧键。

### 7.5 user-service / robot-service

- 风控两键、机器人三键：新键优先、旧键回退、默认兜底。

### 7.6 客户端

- 玩法卡可见性矩阵（enabled × 三入口）。
- 场次页签/好友房入口按当前玩法过滤。
- 选中玩法不可玩 ⇒ 回落；场次/底分修正。
- 旧服务端（无 `games` / 新字段缺失）⇒ 顶层回退。
- 救助门槛新旧两种形态。

### 7.7 admin / conformance

- `pnpm verify:admin`：IA = CONFIG_KEYS − LEGACY_CONFIG_KEYS；旧键不出现在未分组/搜索；
  `game.levels.doudizhu` / `game.levels.paodekuai` 均有结构化编辑器分派。
- conformance 键集/文档同步断言更新；写旧键的 slice 全改新键；
  slice-14 直接 SQL 演练改新键；slice-19 旧键 400 断言校验废弃文案。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 旧后台在新代码上线后写旧键无效 | 后台与代码同批部署；旧键写入直接 400 |
| 回滚后旧镜像读到冻结值 | runbook 回填脚本；回滚前强制执行 |
| 滚动升级中旧服务读旧键、新服务读新键 | D19：全部消费者升级完成前**不得改新键**（尤其记牌器价格）；runbook 写升级顺序 |
| 回滚时两个玩法共用旧键 | D18：斗地主为权威源；跑得快专有值回滚即丢弃并在 runbook 公告 |
| 10-23 已发多玩法客户端不认识 per-game 开关 | 跑得快金币场默认关 ⇒ 旧客户端仍显示金币场页签、点击 12010；登记为已知窗口，PDK 开放前先更新客户端 |
| 键数量增长导致清单/测试漏项 | 单一键清单（protocol）+ 迁移测试逐键断言 |
| 新键坏值静默回退造成“改了不生效” | D3：坏值 fail-closed/代码默认，不回退旧键；写入口校验 |
| 机器人水位用错玩法档位 | `computeTop(gameType)` 双玩法单测 |
| 台费在新键缺失窗口静默变 0 | `entryFeePercents` 与 `baseScoreLevels` 同走新→旧回退 + 单测 |
| 迁移时间戳撞车 | 1796500000000，全仓唯一；迁移测试断言 |

## 9. 涉及文件

- `packages/protocol/src/config.ts`、`config.test.ts`
- `packages/config-service/src/config/client-config.controller.ts`、`platform-config.service.ts`
- `packages/config-service/src/migrations/1796500000000-SplitGameConfig.ts`
- `packages/config-service/test/*`
- `packages/room-service/src/config/config-cache.service.ts`
- `packages/room-service/src/gateway/message.router.ts`、`match/match.service.ts`
- `packages/room-service/src/rooms/rooms.controller.ts`、`rooms.service.ts`、`rooms.start.ts`
- `packages/room-service/src/currency/settle.service.ts`、`robot-funding.ts`
- `packages/currency-service/src/config/config-cache.service.ts`、`wallet/wallet.controller.ts`、
  `ads/ad-callback.service.ts`
- `packages/user-service/src/config/config-cache.service.ts`
- `packages/robot-service/src/config/config-cache.service.ts`、`robot/config.ts`
- `apps/client/src/net/rest.ts`（类型）、`composables/useClientConfig.ts`、`stores/game.ts`、
  `pages/lobby/lobby.vue`、`pages/game/game.vue`
- `admin/app.js`、`scripts/verify-admin-static.mjs`
- `tools/conformance/src/lib/http.ts`、`slices/slice-13/14/17/18/19/20/21/22/23/24/25/28`
- `docs/games/paodekuai.md`、`docs/client-protocol.md`、`docs/design.md`、
  `docs/ops/first-deploy.md`、rollback runbook

## 10. 审查记录

### 10.1 第一轮独立对抗审查（2026-10-24）

审查者：独立子代理（sonnet），只报发现。共 15 条：1 阻断 / 6 高 / 5 中 / 3 低。

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | 阻断 | `match.service.ts` 的 `botFillEnabled(mode)` 不读 `gameType`，跑得快补位开关成死键 | **已修**：§5.3 明确 `botFillEnabled(mode, queue.gameType)`，§9 补 `match.service.ts`，§7.3 加补位矩阵 |
| 2 | 高 | conformance 大量写旧键；slice-14 直接 SQL 绕过 400；slice-19 断言过宽 | **已修**：§5.9 逐片列明；slice-14 改新键；slice-19 校验废弃文案 |
| 3 | 高 | `verify-admin-static` 的“IA = CONFIG_KEYS”在 89 vs 73 时必红 | **已修**：§5.8/§7.7 改为“IA = CONFIG_KEYS − LEGACY_CONFIG_KEYS”，并给计数 |
| 4 | 高 | admin 未分组/搜索仍渲染旧键可保存控件 | **已修**：§5.8 要求差集与搜索排除旧键，只读或不展示；§7.7 加断言 |
| 5 | 高 | `buildStructCard` 缺 `game.levels.doudizhu` / `game.levels.paodekuai` 分支 | **已修**：§5.8 明确补两个 `buildLevelsEditor` 分支；§7.7 加断言 |
| 6 | 高 | 回滚回填未定“两个玩法共用旧键”的取值源 | **已修**：D18 斗地主为权威源，跑得快专有值回滚即丢弃；runbook 写逐键 SQL |
| 7 | 高 | `room.match {mode:'practice'}` 绕过好友房闸 | **已修**：D17/§5.3 `practice` 也查 `friendRoomEnabled(gameType)` ⇒ 12006 |
| 8 | 高 | `entryFeePercents` 无旧键回退，窗口内静默变 0 | **已修**：§5.3/§6/§7.3 要求与 `baseScoreLevels` 同回退并加用例 |
| 9 | 中 | 滚动升级中旧 currency-service 读旧记牌器价格 | **已修**：D19/§8 升级完成前不得改新键；runbook 写顺序 |
| 10 | 中 | `/api/config` 对 `reliefThresholdCoins` 非法值未定义 | **已修**：§5.2 读侧复用 parser，缺失/非法不下发；§5.4 服务端 null ⇒ fail-closed |
| 11 | 中 | 10-23 多玩法客户端仍显示跑得快金币场页签 | **已登记**：§8 已知窗口；PDK 开放前先更新客户端 |
| 12 | 中 | 假 QueryRunner 无法验证 `INSERT ... SELECT` 幂等/真值 | **已修**：§5.2 改 JS 驱动复制 + 内存假库幂等测试 + 真 MySQL 冒烟 |
| 13 | 中 | 斗地主 16 个新键兜底默认值未列全 | **已修**：§4.3 逐键列表 |
| 14 | 低 | design.md §7.5 权威文档未在清单 | **已修**：§5.9/§9 已列 `docs/design.md`（§7.5 键表与消费者清单） |
| 15 | 低 | 救助门槛硬编码 150，运营改过档位时不符 | **已修**：§4.3/§5.2 迁移现算 `MIN(档位) × 倍率` |

> 第二轮：修复差异复核（只审上表处置是否落实），见 §10.2。

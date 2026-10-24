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

- 斗地主 16 个新键：迁移时**复制旧键当前值**，不改变玩家可见行为。
- 跑得快 7 个新键：D4 的保守灰度值。
- `currency.reliefThresholdCoins` = `150`（= 当前最低档 15 × 门槛 10）。

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
  `freeRoomEnabled?`、`goldRoomEnabled?`、`friendRoomEnabled?`、`entryMultiplier?`、
  `cardCounter?: { enabled; pricePerGameCoins; pricePerHourCoins }`。
- `ClientConfig` 增加可选 `reliefThresholdCoins?: number`（旧服务端缺失 ⇒ 旧算法）。
- `CLIENT_CONFIG_KEYS` 增加 `reliefThresholdCoins`；其余顶层字段不变。

### 5.2 config-service

#### `/api/config`（`client-config.controller.ts`）

- 读取辅助：`readGameKey(byKey, gameType, suffix, legacyKey, fallback)`；新键缺失才回退旧键。
- 顶层字段派生：
  - `baseScoreLevels` ← `game.levels.doudizhu`（缺失回退 `game.baseScoreLevels`）；
  - `freeRoomEnabled` / `goldRoomEnabled` / `friendRoomEnabled` ← 斗地主新键；
  - `entryMultiplier` ← `game.doudizhu.entryMultiplier`；
  - `cardCounter*` ← `game.doudizhu.cardCounter*`；
  - `reliefThresholdCoins` ← 平台新键（缺失 ⇒ `150`）。
- `games.doudizhu`：`enabled:true`、人数/档位 + 上述场次/好友房/门槛/记牌器字段。
- `games.paodekuai`：`enabled` / 人数 / 档位 + 跑得快场次/好友房/门槛。
- 顶层 `baseScoreLevels` 与 `games.doudizhu.baseScoreLevels` 同源。

#### 管理写入（`platform-config.service.ts`）

- `set()` 第一行（身份校验之后、任何库操作之前）：
  `if (isLegacyConfigKey(key)) throw new ProtocolError('该键已废弃，请使用 game.doudizhu.* / game.paodekuai.*')`。
- `GET /api/admin/config` 仍返回旧键行（只读展示/回滚依赖）；IA 不再列出它们。

#### 迁移（`1796500000000-SplitGameConfig.ts`）

- 对 15 个旧键（除 `game.baseScoreLevels` 映射到 `game.levels.doudizhu` 外逐字同名）：
  `INSERT IGNORE INTO platform_config (...) SELECT '<新键>', value, version, NOW(3), 'seed' FROM platform_config WHERE key='<旧键>'`。
- 对每个新键再补一条 `INSERT IGNORE ... VALUES (<默认值>)`，保证旧行缺失时也有种子。
- 跑得快 7 键直接 `INSERT IGNORE` 种子（D4）。
- `currency.reliefThresholdCoins` 种子 `150`。
- `down()` 删除本次新增的新键（旧键**不删**）；回滚到旧镜像不需要跑 down，按 runbook 回填后直接回滚。
- 时间戳 `1796500000000`，全仓唯一；`INSERT IGNORE` 可重跑。

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
- `cardCounterEnabled()` / `cardCounterPrices()`：只读斗地主新键（回退旧键）；
  调用方仍由 `GAME_META[gameType].capabilities.cardCounter` 闸住。
- `entryFeePercents(gameType)` 继续由档位表派生，天然按玩法。

#### 匹配与好友房

- `message.router.ts`：`modeEnabled(deps, gameType, mode)`；
  random → `freeRoomEnabled(gameType)`，gold → `goldRoomEnabled(gameType)`；
  关闭 ⇒ `12010`。`handleMatch` 在 `gameEnabled` / 人数校验之后调用。
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
  - 新增 `reliefThresholdCoins()`：平台新键；缺失/非法 ⇒ `150`。
  - 删除/保留 `entryMultiplier()` 与 `baseScoreLevels()`？**保留读取但在救助端点不再使用**；
    其他消费面（记牌器价格）改为斗地主新键。
  - `cardCounterEnabled()` / `cardCounterPrices()` 改读 `game.doudizhu.cardCounter*`（回退旧键）。
- `wallet.controller.ts`：救助门槛直接用 `reliefThresholdCoins()`；
  错误文案不再提“档位表最低档 × 倍率”。
- `ads/ad-callback.service.ts`：同样改用 `reliefThresholdCoins()`。
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
- 旧键不出现在任何 IA 列表中；`KEY_META` / 结构化键清单同步。

### 5.9 文档

- `docs/games/paodekuai.md` §7.1：补充场次/好友房/补位/抽水/门槛键与默认值；
  注明旧键只读。
- `docs/client-protocol.md`：`ClientGameConfig` / `ClientConfig` 新字段。
- `docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`：
  增加“回滚前回填”一节与逐键 SQL。
- 本 spec 的「审查记录」。

## 6. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 新键缺失（迁移未跑/回滚窗口） | 斗地主回退旧键；跑得快回退代码默认 |
| 新键值非法 | 不回退旧键；boolean/int 取代码默认，档位表 fail-closed（10007），收费表空表（不收） |
| 旧键写入 | 400 `BAD_PARAM`，消息提示使用新键 |
| 玩法关闭 | 匹配/建房/进房按既有码：`12012` |
| 场次关闭 | `room.match` ⇒ `12010` |
| 好友房关闭 | 列表返回空；建房/进房 ⇒ `12006` |
| 玩法三入口全关 | 大厅隐藏玩法卡；当前选中被隐藏 ⇒ 回落第一个可玩玩法 |
| 只开好友房 | 玩法卡可见；开始按钮不显示；好友房可用 |
| 救助门槛缺失/非法 | 代码默认 `150`（fail-safe 与种子一致） |
| 机器人水位不可推导 | 沿用既有：ensure 抛、afterSettle fail-open |

## 7. 测试判据

### 7.1 protocol

- `CONFIG_KEYS` 含全部新键；`LEGACY_CONFIG_KEYS` 恰为 16 个旧键；`isLegacyConfigKey` 正确。
- 每个新键的 parser 正例/反例（boolean / rake / entry / levels / cardCounter / robot / risk / relief）。
- 旧键 parser 仍可用（快照读取/回填）。
- `ClientGameConfig` / `ClientConfig` 类型与 `CLIENT_CONFIG_KEYS` 同步。

### 7.2 config-service

- 迁移：逐键复制旧值到斗地主新键；跑得快 7 键种子；`reliefThresholdCoins=150`；
  `INSERT IGNORE` 幂等；`down` 只删新键。
- `/api/config`：
  - 新键优先、旧键回退（删除新行后断言回退）；
  - 顶层字段与 `games.doudizhu` 同源；
  - 跑得快保守默认值；
  - `reliefThresholdCoins` 下发；
  - 坏新键不回退旧键（档位表空表 / 默认值）。
- 管理面：写新键成功；写旧键 400 且不落库；`GET /api/admin/config` 仍能读到旧键行。

### 7.3 room-service

- 匹配：斗地主/跑得快 × 免费场/金币场开关矩阵，关 ⇒ `12010`。
- 好友房：列表按玩法返回空；建房/进房按房间玩法 ⇒ `12006`；占座前拒绝。
- 经济：`rakePercent(gameType)`、`entryMultiplier(gameType)`、`entryFeePercents(gameType)`。
- 机器人水位：两玩法不同档位/倍率 ⇒ top 不同；`afterSettle` 带玩法。
- 记牌器：跑得快不扣费/不下发（既有能力位测试保持）。

### 7.4 currency-service

- 救助端点/广告回调用 `reliefThresholdCoins`；缺失 ⇒ 150。
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

- `pnpm verify:admin`：IA 含新键、不含旧键。
- conformance 键集/文档同步断言更新。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 旧后台在新代码上线后写旧键无效 | 后台与代码同批部署；旧键写入直接 400 |
| 回滚后旧镜像读到冻结值 | runbook 回填脚本；回滚前强制执行 |
| 键数量增长导致清单/测试漏项 | 单一键清单（protocol）+ 迁移测试逐键断言 |
| 新键坏值静默回退造成“改了不生效” | D3：坏值 fail-closed/代码默认，不回退旧键；写入口校验 |
| 机器人水位用错玩法档位 | `computeTop(gameType)` 双玩法单测 |
| 客户端旧版本读到新 `games` 字段 | 字段可选；旧客户端只读顶层旧字段 |
| 迁移时间戳撞车 | 1796500000000，全仓唯一；迁移测试断言 |

## 9. 涉及文件

- `packages/protocol/src/config.ts`、`config.test.ts`
- `packages/config-service/src/config/client-config.controller.ts`、`platform-config.service.ts`
- `packages/config-service/src/migrations/1796500000000-SplitGameConfig.ts`
- `packages/config-service/test/*`
- `packages/room-service/src/config/config-cache.service.ts`
- `packages/room-service/src/gateway/message.router.ts`
- `packages/room-service/src/rooms/rooms.controller.ts`、`rooms.service.ts`、`rooms.start.ts`
- `packages/room-service/src/currency/settle.service.ts`、`robot-funding.ts`
- `packages/currency-service/src/config/config-cache.service.ts`、`wallet/wallet.controller.ts`、
  `ads/ad-callback.service.ts`
- `packages/user-service/src/config/config-cache.service.ts`
- `packages/robot-service/src/config/config-cache.service.ts`、`robot/config.ts`
- `apps/client/src/net/rest.ts`（类型）、`composables/useClientConfig.ts`、`stores/game.ts`、
  `pages/lobby/lobby.vue`、`pages/game/game.vue`
- `admin/app.js`
- `docs/games/paodekuai.md`、`docs/client-protocol.md`、rollback runbook

## 10. 审查记录

（待对抗审查后填写）

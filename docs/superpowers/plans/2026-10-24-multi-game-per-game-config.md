# 多玩法配置平行化 · 实现计划

> 依据：`docs/superpowers/specs/2026-10-24-multi-game-per-game-config-design.md` v1.0。
> 分支：`dev`。每个任务一个 commit；TDD：失败测试 → 红 → 最小实现 → 绿 → 提交。
> attribution：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## Global Constraints

- 不新增协议错误码；复用 `12010`（场次关）、`12006`（好友房关）、`12012`（玩法/人数关）。
- 旧键只读：`PUT /api/admin/config/<旧键>` ⇒ 400；旧键行保留在库与快照中。
- 读顺序：新键 → 旧键（仅斗地主）→ 代码默认；新键存在但非法不回退旧键。
- 跑得快默认：免费场开、金币场关、好友房关、补位开、抽水 0、门槛 10。
- 救助门槛 = 平台级绝对金币 `currency.reliefThresholdCoins`（种子 150）；
  currency-service 缺失/非法 ⇒ fail-closed（503/瞬态）。
- 不改 `room.matchNoBotMaxWaitMs`、房间节奏、`record.*`、`risk.predicate.*`、`pay.*`、`client.*`、`ad.*`。
- 不把风控扫描扩展到 `game_records_pdk`。
- 配置键清单唯一真源 = `packages/protocol/src/config.ts`。
- 提交前跑受影响包的 test + lint；最后跑全仓。

## 任务

### T1 protocol：键清单、类型、解析器

**Files**：`packages/protocol/src/config.ts`、`packages/protocol/src/config.test.ts`

**Interfaces**：
- `CONFIG_KEYS` 追加 24 个新键（16 ddz + 7 pdk + `currency.reliefThresholdCoins`）；
  旧 16 键保留。
- `export const LEGACY_CONFIG_KEYS`（16 键）；`export function isLegacyConfigKey(key: string): boolean`。
- `ClientGameConfig` 增可选 `freeRoomEnabled` / `goldRoomEnabled` / `friendRoomEnabled` /
  `entryMultiplier`。
- `ClientConfig` 增可选 `reliefThresholdCoins?: number`；`CLIENT_CONFIG_KEYS` 追加
  `reliefThresholdCoins`。
- `parseConfigValue`：
  - 新 boolean 键 → `parseStrictBoolean(key, value)`；
  - `game.doudizhu.rakePercent` / `game.paodekuai.rakePercent` → `parseRakePercent(value, key)`；
  - `game.doudizhu.entryMultiplier` / `game.paodekuai.entryMultiplier` → `parseEntryMultiplier(value, key)`；
  - `game.levels.doudizhu` → `parseBaseScoreLevels(value)`；
  - `game.doudizhu.cardCounterPrice*` → `parseCardCounterPrice(key, value)`；
  - `game.doudizhu.robot.*` → 复用 `parseSkillDistribution(value, key)` /
    `parseStrictBoolean` / `parseModelBySkill(value, key)`；
  - `game.doudizhu.risk.*` → `parseWinRateThreshold(value, key)` / `parseMinGames(value, key)`；
  - `currency.reliefThresholdCoins` → 新 `parseReliefThresholdCoins(value)`（int 1..1,000,000）。
- 解析器内部错误消息使用传入的 key（默认旧 key，保持旧测试兼容）。

**TDD**：
1. 改 `config.test.ts` 的 `CONFIG_KEYS` / `CLIENT_CONFIG_KEYS` 精确断言（先红）。
2. 加新键正反例、`isLegacyConfigKey`、旧键仍可解析。
3. 实现到绿。
4. `pnpm -C packages/protocol build && pnpm -C packages/protocol test`。
5. 提交。

### T2 config-service：迁移 + 种子

**Files**：`packages/config-service/src/migrations/1796500000000-SplitGameConfig.ts`、
`packages/config-service/test/migration.test.ts`

**Migration**（JS 驱动，便于测试与真值计算）：
- `SELECT key, value, version FROM platform_config WHERE key IN (<16 个旧键>)`；
- 逐键 `INSERT IGNORE ... VALUES (?, ?, ?, NOW(3), 'seed')`（新键/旧值/旧版本）；
- 旧行缺失的键用 spec §4.3 的兜底默认值补种（16 个值逐键列在 spec，不得自拟）；
- `currency.reliefThresholdCoins` 现算：解析旧 `game.baseScoreLevels` 的
  `MIN(baseScore) × 旧 currency.entryMultiplier`；旧键缺失 ⇒ 15 × 10 = 150；
- 跑得快 7 键种子：`freeRoomEnabled=true`、`goldRoomEnabled=false`、`friendRoomEnabled=false`、
  `freeBotFillEnabled=true`、`goldBotFillEnabled=true`、`rakePercent=0`、`entryMultiplier=10`；
- `down()` 删除本迁移新增的 24 键；旧键不删。

**TDD**：
1. 内存假库：先种旧 16 键 → `up()` → 断言新键值/版本逐字复制；`up()` 再跑一次幂等；
   删一条旧行 → 断言兜底默认；断言 `reliefThresholdCoins` 现算。
2. 实现到绿；`pnpm -C packages/config-service test`。
3. 真 MySQL 冒烟：迁移后 `SELECT COUNT(*)`（89 行）+ 抽查 16 个新键值（放入 T13）。
4. 提交。

### T3 config-service：`/api/config` 与旧键写拒绝

**Files**：`packages/config-service/src/config/client-config.controller.ts`、
`packages/config-service/src/config/platform-config.service.ts`、
`packages/config-service/test/client-config.test.ts`、
`packages/config-service/test/platform-config.service.test.ts`、
`packages/config-service/test/config.validation.test.ts`、
`packages/config-service/test/admin.controller.test.ts`、
`packages/config-service/test/config.rpc.test.ts`、
`packages/config-service/test/helpers/config-probe.ts`

**Interfaces**：
- controller 内 `readKey(byKey, newKey, legacyKey, fallback)` / `readLevels(...)`。
- 顶层派生：`baseScoreLevels`、`free/gold/friendRoomEnabled`、`entryMultiplier`、
  `cardCounter*`、`reliefThresholdCoins`（读侧复用 `parseReliefThresholdCoins`；
  缺失/非法 ⇒ 不下发）。
- `games.doudizhu` 增场次/好友房/门槛/`cardCounter`；`games.paodekuai` 增场次/好友房/门槛。
- `PlatformConfigService.set()` 首行：`if (isLegacyConfigKey(key)) throw new ProtocolError(...)`。

**TDD**：
1. 新键优先/旧键回退/坏新键不回退；顶层与 `games` 同源；PDK 默认；`reliefThresholdCoins`。
2. 旧键写 400 且不落库；新键写成功。
3. 既有写旧键的测试改新键。
4. `pnpm -C packages/config-service test`；提交。

### T4 room-service：配置缓存 + 匹配/好友房闸

**Files**：`packages/room-service/src/config/config-cache.service.ts`、
`packages/room-service/src/gateway/message.router.ts`、
`packages/room-service/src/match/match.service.ts`、
`packages/room-service/src/rooms/rooms.controller.ts`、
`packages/room-service/src/rooms/rooms.service.ts`、
`packages/room-service/test/config-cache.test.ts`、
`packages/room-service/test/helpers/config-cache.stub.ts`、
相关 router/controller/match 测试

**Interfaces**：
- `gameBool(gameType, suffix, legacyKey, fallback)` / `gameInt(...)`。
- `freeRoomEnabled(gameType?)`、`goldRoomEnabled(gameType?)`、`friendRoomEnabled(gameType?)`、
  `freeBotFillEnabled(gameType?)`、`goldBotFillEnabled(gameType?)`、`botFillEnabled(mode, gameType)`。
- `levelsKeyOf(gameType)`：ddz → `game.levels.doudizhu`（回退旧键）；pdk → `game.levels.paodekuai`。
- `entryFeePercents(gameType)` 复用 `baseScoreLevels(gameType)` 的新→旧回退，**不得**直接读单一键。
- `modeEnabled(deps, gameType, mode)`；random/gold 关 ⇒ 12010；practice 关 ⇒ 12006。
- `MatchService.botFillEnabled(mode, queue.gameType)`（`queue` 已携带 gameType）。
- `RoomsService.join` 读到房间后按房间 `gameType` 查 `friendRoomEnabled` ⇒ 12006。
- controller 的 `GET /api/rooms` / `POST /api/rooms` 按 `gameType` 查好友房开关。

**TDD**：
1. 两玩法 × 两场次开关矩阵（12010）；practice 关 ⇒ 12006。
2. 好友房列表空/建房 12006/进房 12006（占座前）。
3. `baseScoreLevels` 新键/旧键回退；`entryFeePercents` 删新键仍按旧键收台费；
   跑得快档位不变。
4. `botFillEnabled(mode, gameType)` 矩阵；跑得快关补位 ⇒ 不补机器人。
5. `pnpm -C packages/room-service test`；提交。

### T5 room-service：抽水、门槛、机器人水位

**Files**：`packages/room-service/src/gateway/message.router.ts`、
`packages/room-service/src/currency/settle.service.ts`、
`packages/room-service/src/currency/robot-funding.ts`、
`packages/room-service/src/rooms/rooms.start.ts`、
`packages/room-service/test/currency/*`

**Interfaces**：
- `entryMultiplier(gameType)`：match 门槛用 `matchGameType`。
- `rakePercent(gameType)`：settle 用 `room.gameType ?? 'doudizhu'`。
- `SettleRobotHook.afterSettle(balances, gameType)`。
- `RobotFunding.ensureBots(botIds, gameType)`、`afterSettle(balances, gameType)`、
  `computeTop(gameType)`。
- `rooms.start` 把 `gameType` 传给 `ensureBots`。

**TDD**：
1. 两玩法不同 `entryMultiplier` / `rakePercent` / 档位 ⇒ 不同结果。
2. `computeTop` 两玩法不同 top；`afterSettle` 收到 gameType。
3. `pnpm -C packages/room-service test`；提交。

### T6 currency-service：救助绝对门槛 + 记牌器键

**Files**：`packages/currency-service/src/config/config-cache.service.ts`、
`packages/currency-service/src/wallet/wallet.controller.ts`、
`packages/currency-service/src/ads/ad-callback.service.ts`、
`packages/currency-service/src/config/config.client.ts`、
`packages/currency-service/test/config-cache.test.ts`、wallet/ads 测试

**Interfaces**：
- `reliefThresholdCoins(): number | null`；缺失/非法 ⇒ null。
- wallet/ads：null ⇒ 503 / 瞬态（不发放）。
- 删除 `entryMultiplier()` / `minBaseScoreLevel()` 及其常量/测试。
- `cardCounterEnabled()` / `cardCounterPrices()` 读 `game.doudizhu.cardCounter*`（回退旧键）。

**TDD**：
1. 门槛命中/不命中/缺键 fail-closed。
2. 记牌器新键优先/旧键回退。
3. `pnpm -C packages/currency-service test`；提交。

### T7 user-service / robot-service：风控与机器人键

**Files**：`packages/user-service/src/config/config-cache.service.ts`、
`packages/user-service/test/config-cache.test.ts`、
`packages/robot-service/src/config/config-cache.service.ts`、
`packages/robot-service/src/robot/config.ts`、
`packages/robot-service/test/config-cache.test.ts`、
`packages/robot-service/test/no-switch-in-decision.gate.test.ts`

**Interfaces**：
- user：`riskWinRateThreshold()` / `riskMinGames()` 读 `game.doudizhu.risk.*`，回退旧键。
- robot：`skillDistribution()` / `ruleFallback()` / `modelBySkill()` 读
  `game.doudizhu.robot.*`，回退旧键；`ROBOT_CONFIG_DEFAULTS` 键名同步；J29 闸白名单更新。

**TDD**：新键优先/旧键回退/默认；`pnpm -C packages/user-service test`、
`pnpm -C packages/robot-service test`；提交。

### T8 客户端：配置归一与 store

**Files**：`apps/client/src/composables/useClientConfig.ts`、
`apps/client/src/stores/game.ts`、`apps/client/src/net/rest.ts`、client tests

**Interfaces**：
- `ClientConfigState` 增 `reliefThresholdCoins: number | null`。
- `normalizeClientConfig` 校验新字段；缺失回退顶层。
- store getters：`activeFreeRoomEnabled` / `activeGoldRoomEnabled` /
  `activeFriendRoomEnabled` / `activeEntryMultiplier` / `activeHasSessions` / `gamePlayable(id)`。
- `repairRoomMode()` 按当前玩法；新增共享 `repairActiveMode()`。
- `reliefAvailable` 优先 `reliefThresholdCoins`；否则旧公式。
- `goldThreshold` 用 `activeEntryMultiplier`。

**TDD**：新字段归一/回退；场次修复；救助新旧两态；
`pnpm -C apps/client test`；提交。

### T9 客户端：大厅/开始游戏页

**Files**：`apps/client/src/pages/lobby/lobby.vue`、`apps/client/src/pages/game/game.vue`、client tests

**Interfaces**：
- `visibleModes` 用 `store.gamePlayable`。
- `sessionOptions` 按 `store.activeMode` 过滤。
- `repairActiveMode` 从 composable 调用；选中玩法不可玩 ⇒ 回落。
- 好友房入口用 `store.activeFriendRoomEnabled`。
- 开始按钮仅 `store.activeHasSessions` 时渲染；好友房单独可用。
- 门槛/台费显示仍用当前玩法档位。

**TDD**：玩法卡可见矩阵；场次/好友房过滤；回落；好友房单独可用；
`pnpm -C apps/client test && pnpm -C apps/client run lint`；提交。

### T10 admin：IA、备注、静态闸

**Files**：`admin/app.js`、`scripts/verify-admin-static.mjs`

**Interfaces**：
- `CONFIG_IA`：ddz 用新键；pdk 增「场次开关」「金币场经济」；平台组收纳节奏/记录/机器人回收。
- `CONFIG_CONTROLS` 68 简单键；`STRUCT_KEYS` 5；`CONFIG_NOTES` 73 条（旧 65 − 16 + 24）。
- 未分组差集**与搜索遍历**都排除 `LEGACY_CONFIG_KEYS`（旧键不进入可保存控件）。
- `buildStructCard` 的编辑器分派补 `game.levels.doudizhu` 与 `game.levels.paodekuai` 两个
  `buildLevelsEditor` 分支。
- verifier：`protoSet − legacySet = iaKeySet = 73`；控件分类 33 bool + 2 text + 33 number = 68；
  pdk 五页签；档位表 anchors 改新键；结构化编辑器分派断言。

**TDD**：先改 verifier 断言（红）→ 改 admin → `pnpm verify:admin` 绿；提交。

### T11 conformance：键集与写键

**Files**：`tools/conformance/src/lib/http.ts`、
`slices/slice-13/14/17/18/19/20/21/22/23/24/25/28`

**变更**：
- 客户端键集 20 → 21（+`reliefThresholdCoins`）。
- 管理面键数用 `CONFIG_KEYS.length`（89）。
- 旧键写入改新键：friend、场次、抽水、档位、记牌器、robot.ruleFallback、risk 两键。
- slice-14 的直接 SQL 演练改 `game.doudizhu.friendRoomEnabled`。
- slice-19 的旧键 400 断言加废弃文案校验。
- `pnpm -C tools/conformance lint`；提交。

### T12 文档 + 回滚 runbook

**Files**：`docs/games/paodekuai.md`、`docs/client-protocol.md`、`docs/design.md`、
`docs/ops/first-deploy.md`、`docs/superpowers/plans/2026-10-24-multi-game-rollback-runbook.md`

**内容**：
- 新键表/默认值/旧键只读说明；ClientConfig 新字段；design/ops 表同步；
- runbook 增加：
  1. 回填 SQL（16 个旧键，**斗地主为权威源**；跑得快专有值回滚即丢弃并公告）；
  2. 回填后核对查询；
  3. 升级顺序与“全部消费者升级完成前不得改新键”（尤其记牌器价格）。
- 提交。

### T13 全量验证 + 代码审查

1. `pnpm -C packages/protocol build`。
2. `pnpm test`（或 `pnpm exec turbo run test lint --force`）。
3. `pnpm verify:admin`。
4. `pnpm -C tools/conformance lint`。
5. 真 MySQL 迁移冒烟：起 config-service 依赖的 MySQL，跑迁移，`SELECT COUNT(*)` = 89，
   抽查 16 个新键值与 `reliefThresholdCoins`。
6. 独立 reviewer 审 `BASE..HEAD`；Critical/Important 修复并复跑。
7. 工作区干净；交付报告。

## 回归命令

```bash
pnpm -C packages/protocol build
pnpm -C packages/protocol test
pnpm -C packages/config-service test
pnpm -C packages/room-service test
pnpm -C packages/currency-service test
pnpm -C packages/user-service test
pnpm -C packages/robot-service test
pnpm -C apps/client test
pnpm -C apps/client run lint
pnpm verify:admin
pnpm -C tools/conformance lint
```

## 计划审查记录

（待对抗审查后填写）

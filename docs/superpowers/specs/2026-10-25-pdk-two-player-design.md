# 跑得快 2 人场 · 设计 spec

> 日期：2026-10-25。分支：`dev`。范围：**只做 2 人牌桌**（4 人留后续片）。
> 依据：`docs/games/paodekuai.md`（规则唯一来源）、`2026-10-23-multi-game-platform-paodekuai-design.md`（D20/D31 已定的 2 人规则）。

## 1. 背景与现状

跑得快的引擎/协议/房间/结算/记录层**已按 2/3/4 人参数化并有单测**：
48 张分 3 份×16、2 人各一份、第三份扣下不出站；首出红桃 3→…→2（全扣则随机）；
2 人局春天不适用、关牌/保本仍适用；队列键含 `playerCount`，2 人队列天然独立。

缺的是**客户端**与**验证**：

- 匹配上行人数写死 `GAME_META[gameType].defaultPlayerCount`（=3）；
- 牌桌壳收到 `playerCount !== 3` 的 pdk 视图 ⇒ 提示并回大厅；
- `PdkBoard` 只画两个对手座（3 人布局）；
- conformance/e2e 只跑 3 人。

服务端现有单一闸 `game.paodekuai.nonThreePlayerEnabled` 同时管 2 和 4，
无法在"只放 2 人"的窗口精确灰度。

## 2. 范围

**做**：跑得快 2 人牌桌（客户端）；2/3 人切换；免费场/金币场都可用；
机器人沿用现有补位开关；2/3/4 的配置闸拆成两个键；conformance/e2e 2 人覆盖。

**不做**：4 人客户端牌桌（服务端继续用独立闸关着）；2 人专属档位/底分表；
2 人专属风控阈值归一化；新协议消息；历史页新增筛选。

## 3. 决策表

| # | 决策 | 依据/后果 |
|---|---|---|
| D1 | 只做 2 人；4 人客户端留后续片 | 用户裁决；工作量与验证面减半 |
| D2 | 新增 `game.paodekuai.twoPlayerEnabled`（默认 `false`） | 2 人独立闸；admin 新开关 |
| D3 | 既有 `game.paodekuai.nonThreePlayerEnabled` **语义收窄为只关 4 人**（默认 `false`） | 键名保留历史原因，后台标签改「开放 4 人」并在备注中说明；不新增第三个键 |
| D4 | 服务端逐人数判定：2→two、3→恒真、4→nonThree；其余按 `GameMeta` 拒绝 | 拒绝码沿用 `12012`（该玩法暂不支持该人数） |
| D5 | `/api/config` 的 `games.paodekuai.supportedPlayerCounts` 按两闸派生：`[3]`/`[2,3]`/`[3,4]`/`[2,3,4]` | 与现有客户端配置形状兼容，`CLIENT_CONFIG_KEYS` 仍 21 键 |
| D6 | 客户端新增 UI 能力表：斗地主 `[3]`、跑得快 `[2,3]`；与服务端 `supportedPlayerCounts` **取交集** | 服务端开 4 人时客户端也不展示；4 人片只改能力表 |
| D7 | 入口 = 开始游戏页「人数」切换；交集长度 >1 才出现；默认 3；存 store、跨页保留 | 用户裁决；不改大厅 IA |
| D8 | `room.match` 与好友房 `room.create` 都带有效人数；斗地主恒 3 | 服务端已校验 |
| D9 | 「再来一局」用**上一局人数**（`store.playerCount`），不用当前选择 | 防好友房 2 人局后按 3 人重匹配 |
| D10 | 牌桌按 `view.playerCount` 渲染：2=单对手座；3=现布局；4=仍提示并回大厅 | **牌桌只信视图，不信选择** |
| D11 | 结算/记录层零改动（PdkSettlement 数据驱动）；历史项显示「N 人局」 | 2 行结算天然支持 |
| D12 | 机器人沿用现有 `freeBotFillEnabled`/`goldBotFillEnabled` | 缺 1 补 1；不加新键 |
| D13 | 测试服先开 `enabled` + `twoPlayerEnabled`；正式环境另行发版 | `nonThreePlayerEnabled` 保持 false |

## 4. 实现设计

### 4.1 protocol

- `CONFIG_KEYS` 在 `game.paodekuai.enabled` 之后插入 `'game.paodekuai.twoPlayerEnabled'`
  （`nonThreePlayerEnabled` 原位保留）。文件头计数 **92 → 93**。
- `PDK_BOOLEAN_KEYS` 加入新键（严格 boolean）。
- `game.ts` 注释：2/4 分别由两键闸住。
- 测试：精确键数组、boolean 解析（真/假/非 boolean 抛错）、注释计数。

### 4.2 config-service

- 新迁移 `1796800000000-PdkTwoPlayerSeed.ts`：
  - `SELECT MAX(version)`（至少 1）后 `INSERT IGNORE` 一行 `game.paodekuai.twoPlayerEnabled=false`；
  - `down()` 只删本键；不覆盖运营已改值。
- `client-config.controller.ts`：
  - 读 `twoPlayerEnabled`（默认 false）与 `nonThreePlayerEnabled`（默认 false）；
  - pdk `supportedPlayerCounts = [ ...(two ? [2] : []), 3, ...(nonThree ? [4] : []) ]`；
  - 注释同步（旧键=4 人）。
- 测试：迁移（版本起点、精确 SQL、down）、`/api/config` 四组合矩阵、种子/探针条目数 92→93。

### 4.3 room-service

`config-cache.service.ts`：

- 新增 `paodekuaiTwoPlayerEnabled()`（缺键/坏值 ⇒ false）。
- `paodekuaiNonThreePlayerEnabled()` 保留方法名，注释改为「仅 4 人」。
- `supportsRoomPlayerCount`：

```ts
if (!supportsPlayerCount(gameType, playerCount)) return false;
if (gameType !== 'paodekuai' || playerCount === 3) return true;
if (playerCount === 2) return this.paodekuaiTwoPlayerEnabled();
if (playerCount === 4) return this.paodekuaiNonThreePlayerEnabled();
return false;
```

测试：四组合 × 2/3/4 矩阵；2 人关闭时 `room.match`/`POST /api/rooms` 均 12012。

### 4.4 admin

- IA 的 pdk「开关」页签：`['game.paodekuai.twoPlayerEnabled', 'game.paodekuai.nonThreePlayerEnabled']`。
- `CONFIG_CONTROLS`：新键标签「开放 2 人」；旧键标签「开放 4 人」。
- `CONFIG_NOTES`：两键各一条（旧键说明历史命名与只影响 4 人）。
- 机械计数：protocol 92→93、active 76→77、IA 76→77、简单控件 71→72、
  BOOL 34→35、控件合计 72、`CONFIG_NOTES` 63→65、种子行 92→93。
- `verify:admin` 全部通过（脚本内计数与注释同步）。

### 4.5 客户端

**能力表**（`apps/client/src/gameModes.ts`）：

```ts
export const CLIENT_TABLE_PLAYER_COUNTS = {
  doudizhu: [3],
  paodekuai: [2, 3],
} as const;
```

注释明确：这是**客户端 UI 已实现的牌桌人数**，不是规则能力（规则能力在 `GAME_META`）。

**store**（`stores/game.ts`）：

- state `selectedPlayerCount: 3`；`reset()` 不清（与 `selectedBaseScore` 同族）。
- getter `activeServerPlayerCounts`：`games[activeMode]?.supportedPlayerCounts`；
  旧服务端缺 `games` ⇒ `[3]`。
- getter `activePlayerCounts`：客户端能力 ∩ 服务端能力，升序；空则 `[3]`。
- getter `effectivePlayerCount`：选中值在交集内则用之；否则 3 在交集内取 3；否则交集首项。
- action `setSelectedPlayerCount(n)`：仅接受交集内的值。
- 配置热更新后由上述 getter 自动收敛，无需额外监听。

**开始游戏页**（`pages/game/game.vue`）：

- 中央面板增加「人数」分段控件，`activePlayerCounts.length > 1` 时显示
  （跑得快专用；斗地主交集恒 `[3]` ⇒ 不显示）。
- `match(playerCountOverride?: number)`：`playerCount = 覆盖值 ?? effectivePlayerCount`；
  仍是**唯一**的 `send('room.match'` 点。
- `createAndJoin()`：`playerCount: store.effectivePlayerCount`。
- 挂载消费「再来一局」：`void match(store.playerCount)`。

**牌桌壳**（`pages/table/table.vue`）：

- 用 `CLIENT_TABLE_PLAYER_COUNTS[gameType].includes(playerCount)` 判定；
  不支持的人数（含 4）⇒ 原提示 + 回大厅。斗地主同理（只接受 3）。

**PdkBoard**：

- `playerCount = view.playerCount ?? 3`。
- `seats`：2 人 ⇒ 单对手 `(me + 1) % 2`；3 人 ⇒ 现 `[(me+2)%3,(me+1)%3]`。
- 模板：2 人时不渲染右侧座位/出牌列/计时器；中段加 `pdk__mid--two` 修饰类，
  CSS 让左座 + 中央区均衡占宽。手牌/动作栏/托管/结算逻辑不变。
- 3 人布局零变化（回归测试钉住）。

**历史页**：pdk 卡片显示「N 人局」。

**大厅文案**：跑得快 tagline 去掉固定「三人」。

### 4.6 conformance / e2e

- `slice-29-paodekuai` 增加 2 人组（经管理面开 `twoPlayerEnabled`，收尾还原）：
  - 负对照：关闭时 2 人匹配/建房 ⇒ 12012；4 人 ⇒ 12012；
  - 两账号以 `playerCount=2` 匹配，双方各 16 张、扣牌不出站；
  - 驱动到终局：零和结算、`winnerSeats`、记录 `playerCount=2`、旧查询不含 pdk；
  - 条数按实跑回填 `baselines.json`。
- `browser-e2e.mjs`：新增 `--scenario pdk2`（一人 + 机器人补位）：大厅切跑得快 →
  选 2 人 → 匹配 → 出牌/过牌 → 结算 → 返回大厅；经管理面开两键并还原。

### 4.7 文档

`docs/games/paodekuai.md`（§2 客户端开放人数、配置表两行）、
`docs/design.md`（键表与计数、pdk active 23→24）、
`docs/client-protocol.md`（92→93 键）、`shared/src/pdk/doc-sync.test.ts`。

## 5. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 旧服务端无 `games` | 不出现人数切换；恒 3 |
| 开局前两闸被关 | 进行中的局不受影响；新匹配 12012；客户端选择自动回落 3 |
| 断线重进 2 人局 | 按 `view.playerCount` 渲染，与本地选择无关 |
| 直连 API 造 4 人房后客户端加入 | 牌桌壳提示「暂不支持该人数」并回大厅 |
| 好友房 | 建房带当前有效人数；2 人闸关时服务端 12012，页面就地提示 |
| 再来一局 | 用上一局人数；2 人闸已关则服务端拒绝并提示 |
| 2 人队列冷清 | 机器人补位（沿用现有补位开关） |

## 6. 测试判据

- protocol：键清单恰 93、boolean 解析正/反例。
- config-service：迁移可重跑/不覆盖；`supportedPlayerCounts` 四组合矩阵。
- room-service：`supportsRoomPlayerCount` 四组合 × 2/3/4；12012 负对照。
- admin：`pnpm verify:admin` 全绿（新计数）。
- 客户端：选择器显隐/默认值/收敛、上行载荷、牌桌壳人数闸、PdkBoard 2 人渲染
  （单对手座、无右列）、3 人回归、结算 2 行、历史标签。
- 真栈：slice-29 2 人组全绿；`--scenario pdk2` 全绿。
- 全量：`turbo run test lint --force`（0 cached）+ 客户端 lint/test。

## 7. 风险

| 风险 | 处置 |
|---|---|
| 旧键语义变化让运营误判 | admin 标签/备注 + 文档；测试服显式开新键 |
| 机械计数散落多处 | 计划逐文件列出（protocol/verify/migration/probe/platform 测试/design 文档） |
| 2 人牌桌布局回归影响 3 人 | 3 人布局零改动 + 回归断言 |
| 2 人队列分流导致冷清 | 机器人补位；观察期看队列/补位指标 |
| 2 人局胜率期望不同 | 不改代码；运营按实际调 `game.paodekuai.risk.*` |
| 真栈/e2e 依赖 Docker | 环境不可用则登记偏差，不在单测绿时宣称已验收 |

## 8. 涉及文件

- `packages/protocol/src/{config.ts,config.test.ts,game.ts}`
- `packages/config-service/src/migrations/1796800000000-PdkTwoPlayerSeed.ts`
- `packages/config-service/src/config/client-config.controller.ts` + 相关测试与探针
- `packages/room-service/src/config/config-cache.service.ts` + 测试
- `admin/app.js`、`scripts/verify-admin-static.mjs`
- `apps/client/src/{gameModes.ts,stores/game.ts,pages/game/game.vue,pages/table/table.vue,pages/history/history.vue,components/table/pdk/PdkBoard.vue}` + 测试
- `tools/conformance/src/slices/slice-29-paodekuai.ts`、`tools/conformance/baselines.json`
- `scripts/browser-e2e.mjs`
- `docs/{games/paodekuai.md,design.md,client-protocol.md}`

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
机器人沿用现有补位开关；2/3/4 的配置闸拆成两个键；conformance/e2e 2 人覆盖；
在队票的关闸出口（服务端）。

**不做**：4 人客户端牌桌（服务端继续用独立闸关着）；2 人专属档位/底分表；
2 人专属风控阈值归一化；新协议消息；历史页新增筛选。

**已登记缺口**：2 人**金币场**的真栈 e2e/conformance 不在本期（服务端 2 座结算由
`settle-pdk.test.ts` / `pdk-settle-record.test.ts` 单测覆盖；真栈金币场 2 人留观察期）。

## 3. 决策表

| # | 决策 | 依据/后果 |
|---|---|---|
| D1 | 只做 2 人；4 人客户端留后续片 | 用户裁决；工作量与验证面减半 |
| D2 | 新增 `game.paodekuai.twoPlayerEnabled`（默认 `false`） | 2 人独立闸；admin 新开关 |
| D3 | 既有 `game.paodekuai.nonThreePlayerEnabled` **语义收窄为只关 4 人**（默认 `false`） | 键名保留历史原因，后台标签改「开放 4 人」并在备注中说明；不新增第三个键 |
| D4 | 服务端逐人数判定：2→two、3→恒真、4→nonThree；其余按 `GameMeta` 拒绝 | 拒绝码沿用 `12012`（该玩法暂不支持该人数） |
| D5 | `/api/config` 的 `games.paodekuai.supportedPlayerCounts` 按两闸派生：`[3]`/`[2,3]`/`[3,4]`/`[2,3,4]` | 与现有客户端配置形状兼容，`CLIENT_CONFIG_KEYS` 仍 21 键 |
| D6 | 客户端新增 UI 能力表：斗地主 `[3]`、跑得快 `[2,3]`；与服务端 `supportedPlayerCounts` **取交集** | 服务端开 4 人时客户端也不展示；4 人片只改能力表 |
| D7 | 入口 = 开始游戏页「人数」切换；交集长度 >1 才出现；默认 3；存 store、跨页保留 | 用户裁决；不改大厅 IA。页面不主动拉配置：停留期间配置变化由 getter 收敛，回大厅/重进后刷新 |
| D8 | `room.match` 与好友房 `POST /api/rooms`（`rest.createRoom`）都带有效人数；斗地主恒 3 | 服务端已校验 |
| D9 | 「再来一局」先把上一局人数（`store.playerCount`）写回选择（仅在交集内），再走唯一 `match()`，由 `effectivePlayerCount` 决定实际值 | 防好友房 2 人局后按 3 人重匹配；选择器高亮同步；闸已关时回落 3 |
| D10 | 牌桌按 `view.playerCount` 渲染：2=单对手座；3=现布局；4=提示并回大厅 | **牌桌只信视图，不信选择** |
| D11 | 结算/记录层零改动（PdkSettlement 数据驱动）；历史项显示「N 人局」 | 2 行结算天然支持 |
| D12 | 机器人沿用现有 `freeBotFillEnabled`/`goldBotFillEnabled` | 缺 1 补 1；不加新键 |
| D13 | 测试服先开 `enabled` + `twoPlayerEnabled`；正式环境另行发版 | `nonThreePlayerEnabled` 保持 false |
| D14 | 在队票遇到人数闸关闭 ⇒ 本桶全部 `failMatch`（12007），不留在队里等 TTL | 防 `create` 抛 12012 穿透扫描轮、票被静默孤儿化 |
| D15 | 12012 文案改为 **message-first**，并加入 `ROOM_LOCAL_CODES` | 玩家能看到「暂不支持该人数」而不是统一「玩法未开放」；REST 建房时就地提示（12012 的 `CLIENT_ACTION` 本就是 TOAST，不存在登出问题） |

## 4. 实现设计

### 4.1 protocol

- `CONFIG_KEYS` 在 `game.paodekuai.enabled` 之后插入 `'game.paodekuai.twoPlayerEnabled'`
  （`nonThreePlayerEnabled` 原位保留）。文件头计数 **92 → 93**。
- `PDK_BOOLEAN_KEYS` 加入新键（严格 boolean）；`config.test.ts` 的
  「12 个 boolean 键」数组与标题同步为 13。
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
- 现有编码旧语义的断言同步：`test/client-config.test.ts:89` 等。

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

`match.service.ts`（D14）：`processQueue` 在构建 `alive` 后、选择/补位前增加：

```ts
if (!this.configCache.supportsRoomPlayerCount(queue.gameType, queue.playerCount)) {
  await this.failMatch(alive.map((q) => q.playerId), queue.key, '该玩法暂不支持该人数');
  return;
}
```

（`gameEnabled=false` 的既有「暂停、票保留」语义**不动**。）

测试：四组合 × 2/3/4 矩阵；2 人关闭时 `room.match`/`POST /api/rooms` 均 12012；
在队 2 人遇闸关 ⇒ 一次 `failMatch`、票删除、无建房、扫描轮不抛。
**测试桩** `test/helpers/config-cache.stub.ts` 必须加 `paodekuaiTwoPlayerEnabled`
并同步 `supportsRoomPlayerCount`（`as unknown as` 会绕过结构校验，缺了就是假绿）。
既有夹具同步：`test/match-player-count.test.ts` 的 `enablePdk` 补开 two 闸；
`test/record-pdk.test.ts` 的 2 人建房用例显式开 two；`test/match-queue-key.test.ts`
两个 2 人用例补开 two 闸（否则语义被新闸抽空）。

### 4.4 admin

- IA 的 pdk「开关」页签：`['game.paodekuai.twoPlayerEnabled', 'game.paodekuai.nonThreePlayerEnabled']`。
- `CONFIG_CONTROLS`：新键标签「开放 2 人」；旧键标签「开放 4 人」。
- `CONFIG_NOTES`：两键各一条（旧键说明历史命名与只影响 4 人）。
- 机械计数：protocol 92→93、active 76→77、IA 76→77、简单控件 71→72、
  BOOL 34→35、控件合计 72、`CONFIG_NOTES` 63→65、种子行 92→93。
- `verify-admin-static.mjs`：计数同步；「控件分类合计」改为与 `entries.size` 比较
  （防只改计数不改 `BOOL_KEYS` 的假绿）；pdk 开关页签断言含两键。
- 注释计数同步：`admin/app.js:134,153,356`、`platform-config.entity.ts:10`、
  `client-config.controller.ts:89`、相关测试注释。

### 4.5 客户端

**能力表**（`apps/client/src/gameModes.ts`）：

```ts
export const CLIENT_TABLE_PLAYER_COUNTS: Readonly<Record<GameType, readonly number[]>> = {
  doudizhu: [3],
  paodekuai: [2, 3],
};
```

注释明确：这是**客户端 UI 已实现的牌桌人数**，不是规则能力（规则能力在 `GAME_META`）。
用 `readonly number[]` 标注，避免 `as const` 下 `includes(number)` 的 TS2345。

**store**（`stores/game.ts`）：

- state `selectedPlayerCount: 3`；`reset()` 不清（与 `selectedBaseScore` 同族）。
- getter `activeServerPlayerCounts`：`isGameType(activeMode)` 后取
  `games[activeMode]?.supportedPlayerCounts`；旧服务端缺 `games` ⇒ `[3]`。
- getter `activePlayerCounts`：客户端能力 ∩ 服务端能力，升序；空则 `[3]`。
- getter `effectivePlayerCount`：选中值在交集内则用之；否则 3 在交集内取 3；否则交集首项。
- action `setSelectedPlayerCount(n)`：仅接受交集内的值。
- 配置热更新后由上述 getter 自动收敛；开始游戏页**不主动拉配置**（避免覆盖页面现有配置夹具），
  配置变化在回大厅/重进后生效，服务端 12012 为最终兜底。

**开始游戏页**（`pages/game/game.vue`）：

- 人数分段控件放在 `.game__stage` 内、**`.game__match` 之外**
  （仓库硬纪律：`.game__match button` 恒唯一；e2e 与多处测试按它取「开始游戏」）。
  控件用非 `.btn` 样式或独立类，不进入 `.game__match`。
- 仅 `activePlayerCounts.length > 1` 时显示（斗地主恒不显示）。
- `match(playerCountOverride?: number)`：`playerCount = 覆盖值 ?? effectivePlayerCount`；
  模板改 `@click="match()"`（**不得**写 `@click="match"`，否则 MouseEvent 会被当成人数）。
  函数内对覆盖值加 `typeof === 'number'` 守卫。
- `createAndJoin()`：`playerCount: store.effectivePlayerCount`。
- 挂载消费「再来一局」：先 `setSelectedPlayerCount(store.playerCount)`（不在交集内则忽略），
  再 `match(store.playerCount)`。
- 删除不再使用的 `GAME_META` 导入（`noUnusedLocals`）。

**聊天码/错误处置**（D15）：

- `net/copy.ts`：`GAME_UNAVAILABLE` 从 `FIXED_COPY` 移到 `FALLBACK_COPY`（message-first），
  保留兜底文案；同步 `copy-coverage.test.ts` 的 FIXED/MESSAGE_FIRST 分区断言。
- `game.vue` 的 `ROOM_LOCAL_CODES` 加入 `GAME_UNAVAILABLE`（REST 建房 12012 就地提示，
  不登出、不跳转）。

**牌桌壳**（`pages/table/table.vue`）：

- 用 `CLIENT_TABLE_PLAYER_COUNTS[gameType].includes(playerCount)` 判定；
  不支持的人数（含 4）⇒ 先**尽力**退出房间，再原提示 → `reset()` + 回大厅。
  退出必须照 `doLeave` 成例：`sendQueued('room.leave', { roomCode: store.roomCode }, 5)`
  + `raceTimeout(…, 5000)` + 不阻塞导航（`room.leave` 载荷**必须带 roomCode**；
  裸 `await send('room.leave', {})` 既不释放座位也可能永久挂起）。
- 斗地主同理（只接受 3）。

**PdkBoard**：

- `playerCount = view.playerCount ?? 3`。
- `seats` 改为 `readonly number[]`（对手座位，按方位升序）：
  2 人 ⇒ `[(me + 1) % 2]`；3 人 ⇒ `[(me + 2) % 3, (me + 1) % 3]`。
- 左侧座位/出牌列恒用 `seats[0]`；右侧座位/出牌列/计时器只在 `seats.length > 1` 时渲染
  （两处 `v-if` 必须同时存在，防幽灵座位）。
- 中段加 `pdk__mid--two` 修饰类，CSS 让左座 + 中央区均衡占宽。
- 手牌/动作栏/托管/结算逻辑不变；3 人布局零变化。
- 结构断言：2 人 ⇒ `.pdk__seat` 恰 1、无 `.pdk__seat--right`、无 `.pdk__play-col--right`、
  `.turn-timer` 恰 1；3 人 ⇒ `.pdk__seat` 恰 2、`.turn-timer` 恰 2
  （`.pdk__me` 是我的座位，不计入）。

**历史页**：pdk 卡片显示「N 人局」。

**大厅文案**：跑得快 tagline 去掉固定「三人」。

### 4.6 conformance / e2e

- `slice-29-paodekuai` 增加 2 人组：
  - **负对照前显式 PUT `twoPlayerEnabled=false`**（防上一轮残留 true）；负对照放在
    `enablePdk` 之后（好友房/玩法闸在前，否则只得到 12006）；
  - **生效观测点**：经管理面 PUT `twoPlayerEnabled=true` 后用**全新账号**轮询
    `POST /api/rooms` + `playerCount=2` 得 `code 0`（`enablePdk` 探测账号已建房，复用会撞 12011）；
  - 负对照：关闭时 2 人建房/匹配 ⇒ 12012 **且 message 含「人数」**（与「玩法未开放」区分）；
  - 两账号以 `playerCount=2` 匹配：`room.matched.playerCount===2`、双方各 16 张、
    扣牌不出站；驱动到终局：零和结算、`winnerSeats`、记录 `playerCount=2`、旧查询不含 pdk；
  - 收尾还原两键。
- `tools/conformance/src/lib/pdk-driver.ts`：`startPdkRoom` 参数化
  `playerCount` 与账号数（默认 3）；`playPdkToEnd` 已人数无关。
- `browser-e2e.mjs`：新增 `--scenario pdk2`（一人 + 机器人补位），经管理面开两键并还原；
  判据必须钉死：`room.matched/state_update` 的 `playerCount===2`、`.pdk__seat` 恰 1、
  结算行恰 2、牌数 16。
- 条数按实跑回填 `baselines.json`。

### 4.7 文档

`docs/games/paodekuai.md`（§2 客户端开放人数、配置表两行）、
`docs/design.md`（键表与计数、pdk active 23→24）、
`docs/client-protocol.md`（92→93 键）、`shared/src/pdk/doc-sync.test.ts`。
低优先注释同步：`settle.service.ts` / `records.service.ts` / `ws.gateway.ts` 中
「三人/三座/恰 3 条」的历史措辞（不阻塞，但列入计划）。

## 5. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 旧服务端无 `games` | 不出现人数切换；恒 3 |
| 开局前两闸被关（无在队票） | 新匹配/建房 12012；message-first 显示「暂不支持该人数」 |
| 关闸时仍有在队票 | `processQueue` 整桶 `failMatch` ⇒ 12007，客户端文案为固定「当前无匹配的玩家」（服务端 message 只进日志） |
| 断线重进 2 人局 | 按 `view.playerCount` 渲染，与本地选择无关 |
| 直连 API 造 4 人房后客户端加入 | 牌桌壳按 `doLeave` 成例带 `roomCode` 尽力退房 → 提示「暂不支持该人数」→ 回大厅 |
| 好友房 | 建房带当前有效人数；2 人闸关时 12012 就地提示 |
| 再来一局 | 用上一局人数；2 人闸已关时选择回写被拒、按有效人数回落 3；服务端为最终权威 |
| 配置停留期间变化 | 页面不主动拉配置；选择由 getter 收敛，回大厅/重进后生效；服务端 12012 兜底 |
| 2 人队列冷清 | 机器人补位（沿用现有补位开关） |

## 6. 测试判据

- protocol：键清单恰 93、boolean 解析正/反例、13 个 boolean 数组。
- config-service：迁移可重跑/不覆盖；`supportedPlayerCounts` 四组合矩阵。
- room-service：`supportsRoomPlayerCount` 四组合 × 2/3/4；12012 负对照；
  在队票关闸 ⇒ 12007 且无建房；桩同步。
- admin：`pnpm verify:admin` 全绿（新计数；分类合计与 `entries.size` 对齐）。
- 客户端：选择器显隐/默认值/收敛、`@click="match()"` 上行数字、牌桌壳人数闸、
  PdkBoard 2 人单对手座/无右列、3 人两对手座回归、结算 2 行、历史标签、
  12012 message-first 与 `ROOM_LOCAL_CODES`。
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
| 2 人金币场真栈未验 | 已登记缺口（§2）；单测覆盖 2 座结算 |
| 真栈/e2e 依赖 Docker | 环境不可用则登记偏差，不在单测绿时宣称已验收 |

## 8. 涉及文件

- `packages/protocol/src/{config.ts,config.test.ts,game.ts}`
- `packages/config-service/src/migrations/1796800000000-PdkTwoPlayerSeed.ts`
- `packages/config-service/src/config/{client-config.controller.ts,platform-config.entity.ts}` + 相关测试与探针
- `packages/room-service/src/config/config-cache.service.ts`
- `packages/room-service/src/match/match.service.ts`
- `packages/room-service/test/helpers/config-cache.stub.ts`
- `packages/room-service/test/{config-cache,match-switch-game,match.service,match-player-count,match-queue-key,record-pdk}.test.ts`
- `admin/app.js`、`scripts/verify-admin-static.mjs`
- `apps/client/src/{gameModes.ts,net/copy.ts,stores/game.ts,pages/game/game.vue,pages/table/table.vue,pages/history/history.vue,components/table/pdk/PdkBoard.vue}` + 测试
- `tools/conformance/src/lib/pdk-driver.ts`
- `tools/conformance/src/slices/slice-29-paodekuai.ts`、`tools/conformance/baselines.json`
- `scripts/browser-e2e.mjs`
- `docs/{games/paodekuai.md,design.md,client-protocol.md}`、`packages/shared/src/pdk/doc-sync.test.ts`

## 9. 设计对抗审查记录（2026-10-25）

独立 reviewer（只读）结论：**阻断 1 / 高 7 / 低 11**，全部处置如下。

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 | `@click="match"` 会把 MouseEvent 当人数 | D7/§4.5：模板改 `@click="match()"` + 数字守卫 + 上行断言 |
| 高 | room-service 测试桩复制旧语义、`as unknown as` 绕过校验 | §4.3/§8：桩加新方法并同步组合逻辑 |
| 高 | 在队票遇闸关 ⇒ `create` 抛 12012 穿透扫描轮、票静默孤儿化 | D14：`processQueue` 入口整桶 `failMatch` + 测试 |
| 高 | 12012 走固定文案、REST 12012 不在 `ROOM_LOCAL_CODES` | D15：message-first + 加入本地码 + 测试 |
| 高 | `pdk-driver` 写死 3 人与 `playerCount:3` | §4.6/§8：参数化并列入文件 |
| 高 | e2e 未钉人数判据，可能匹配成 3 人仍假绿 | §4.6：钉 `playerCount=2`、1 个 `.pdk__seat`、2 行结算、16 张 |
| 高 | 2 人金币场无真栈覆盖 | §2：登记为已接受缺口（单测覆盖） |
| 高 | 人数控件若进 `.game__match` 会破坏唯一按钮纪律 | §4.5：放 `.game__stage`、不入 `.game__match` |
| 低 | `seats` 元组与右列 v-if 可能渲染幽灵座位 | §4.5：改 `readonly number[]`，两处 v-if，结构断言 |
| 低 | `as const` + `includes(number)` / `games[string]` 的 TS 错误 | §4.5：`readonly number[]`、`activeGameType`、删未用导入 |
| 低 | 开始游戏页不拉配置，停留期间不收敛 | §4.5：挂载 `refreshClientConfig()` |
| 低 | `store.playerCount` 与选择器语义分叉 | D9：再来一局回写选择 |
| 低 | 三处旧语义断言会红/桩测试假绿 | §4.3/§4.2/§8 点名文件 |
| 低 | 散落注释计数（admin/entity/controller/tests） | §4.4/§4.7：列入计划 |
| 低 | `verify-admin-static` 分类合计未与 `entries.size` 对齐 | §4.4：改为对齐 |
| 低 | 4 人房提示后未 `room.leave`，软锁 12011 | §4.5/§5：尽力 leave |
| 低 | D8「`room.create`」措辞错误 | D8：改为 `POST /api/rooms` |
| 低 | conformance 未规定闸生效观测点 | §4.6：`POST /api/rooms` + 2 人轮询、message 断言 |
| 低 | settle/records/ws 注释仍写三座 | §4.7：列入低优先同步 |

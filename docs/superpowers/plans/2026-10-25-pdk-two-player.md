# 跑得快 2 人场 · 实现计划

> 依据：`docs/superpowers/specs/2026-10-25-pdk-two-player-design.md`（含对抗审查记录）。
> 分支：`dev`。每个任务一个 commit；TDD：失败测试 → 红 → 最小实现 → 绿 → 提交。
> attribution：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## Global Constraints

- 不改协议消息、不加错误码；`CLIENT_CONFIG_KEYS` 仍 21 键。
- 3 人跑得快与斗地主行为**零变化**；4 人继续被服务端闸住、客户端拒绝。
- 机械计数唯一口径：protocol **93** / active **77** / IA **77** / 简单控件 **72** /
  结构化 **5** / BOOL **35** / TEXT **2** / NUMBER **35** / `CONFIG_NOTES` **65** /
  种子行 **93**。
- 键名：新键 `game.paodekuai.twoPlayerEnabled`；旧键 `game.paodekuai.nonThreePlayerEnabled`
  保留、只关 4 人。
- 客户端人数控件**不得**进入 `.game__match`；`@click="match()"`。
- 每任务只改本任务文件；不夹带无关重构；提交前跑受影响包的 test + lint。
- 不 push master、不部署；推 `dev` 前 fetch/merge `origin/dev` 并重跑全量。

## T1 protocol：新键 + 解析 + 计数

**Files**：`packages/protocol/src/config.ts`、`config.test.ts`、`game.ts`。

1. `config.test.ts` 精确键数组在 `'game.paodekuai.enabled'` 后插入
   `'game.paodekuai.twoPlayerEnabled'`；boolean 用例数组加入新键、标题「12 个」→「13 个」。
2. 跑测试 ⇒ 红。
3. `CONFIG_KEYS` 同位置插入；`PDK_BOOLEAN_KEYS` 加入；文件头「九十二键」→「九十三键」；
   `game.ts` 注释改为「2 人 = twoPlayerEnabled，4 人 = nonThreePlayerEnabled」；
   `config.test.ts` 注释「跑得快 14 键」→「15 键」。
4. 绿：`pnpm -C packages/protocol build && pnpm -C packages/protocol test && pnpm -C packages/protocol lint`。
5. Commit：`feat(protocol): 新增跑得快 2 人闸键`。

## T2 config-service：迁移 + 客户端人数派生

**Files**：新增 `src/migrations/1796800000000-PdkTwoPlayerSeed.ts`；
`src/config/client-config.controller.ts`；`src/config/platform-config.entity.ts`；
`test/{migration,client-config,platform-config.service,admin.controller}.test.ts`；
`test/helpers/config-probe.ts`。

1. 测试先行：
   - `migration.test.ts` 新增本迁移 describe：`SELECT MAX(version)` 返回 `[{maxVersion: 5}]` ⇒
     INSERT 参数 version=5；`INSERT IGNORE` 仅缺行落库；`down()` 只删本键；
   - 种子总数/探针数组 92→93，默认 `twoPlayerEnabled=false`；
   - `client-config.test.ts` 四组合矩阵：
     `{}` ⇒ `[3]`；`two=true` ⇒ `[2,3]`；`nonThree=true` ⇒ `[3,4]`；两者 ⇒ `[2,3,4]`；
     原 89 行「nonThree=true ⇒ [2,3,4]」改为两键组合。
2. 红。
3. 实现：
   ```ts
   // 1796800000000-PdkTwoPlayerSeed.ts（照 1796700000000 的版本起点纪律）
   // INSERT IGNORE ... ('game.paodekuai.twoPlayerEnabled', JSON.stringify(false), ?, 'seed')
   ```
   `client-config.controller.ts`：
   ```ts
   const pdkTwo = readBoolean(byKey, 'game.paodekuai.twoPlayerEnabled', undefined, false);
   // pdk.supportedPlayerCounts = [...(pdkTwo ? [2] : []), 3, ...(pdkNonThree ? [4] : [])]
   ```
   同步注释：protocol 93、active 77、旧键=4 人、entity「九十三键」。
4. 绿：`pnpm -C packages/config-service test && pnpm -C packages/config-service lint`。
5. Commit：`feat(config-service): 跑得快 2 人闸与人数派生`。

## T3 room-service：逐人数闸 + 在队票出口

**Files**：`src/config/config-cache.service.ts`、`src/match/match.service.ts`；
`test/helpers/config-cache.stub.ts`；`test/{config-cache,match-switch-game,match.service,match-player-count,match-queue-key,record-pdk}.test.ts`。

1. 测试先行：
   - `config-cache.test.ts`：`supportsRoomPlayerCount` 四组合 × 2/3/4；
     `two=true` ⇒ 2 放行、4 仍拒；`nonThree=true` ⇒ 4 放行、2 仍拒；
   - `match-switch-game.test.ts`：`nonThree 开 ⇒ 2/4 放行` 改为两个独立用例；
     `two=false` 时 2 人 ⇒ 12012 且 message 含「人数」；
   - `match.service.test.ts`：队列里有 2 人票、`supportsRoomPlayerCount=false` ⇒
     `failMatch` 一次、票删除、无建房、扫描轮不抛。前置：`paodekuaiEnabled=true`
     （否则 `processQueue` 在玩法级早退）；断言 `zrem` 用的是 5 段实际键（`queue.key`）。
   - 既有夹具同步：`match-player-count.test.ts` 的 `enablePdk` 补
     `paodekuaiTwoPlayerEnabled.mockReturnValue(true)`；`record-pdk.test.ts` 的
     `rooms.create({playerCount:2})` 用例显式开 two；`match-queue-key.test.ts` 两个
     2 人用例补开 two（否则测试语义被新闸抽空）。
2. 红。
3. 实现：
   - `paodekuaiTwoPlayerEnabled()`；旧方法注释「仅 4 人」；
   - `supportsRoomPlayerCount` 按 spec §4.3；
   - `processQueue` 在 `if (alive.length === 0) return;` 之后插入整桶 `failMatch`
     （`queue.key`、message `'该玩法暂不支持该人数'`）；
   - 桩加 `paodekuaiTwoPlayerEnabled` 并同步逻辑。
4. 绿：`pnpm -C packages/room-service test && pnpm -C packages/room-service lint`。
5. Commit：`feat(room-service): 跑得快 2/4 人独立闸与在队票出口`。

## T4 admin：两个开关 + 静态闸

**Files**：`admin/app.js`、`scripts/verify-admin-static.mjs`。

1. `app.js`：
   - pdk「开关」页签两键；`CONFIG_CONTROLS` 新增「开放 2 人」、旧键改「开放 4 人」；
   - `CONFIG_NOTES` 两键各一条（旧键注明历史命名/只影响 4 人）；
   - 注释计数：`:120`/`:1251` 92→93、`:871` 71→72、`:891` 22→23、
     `:134`「23 键中 13 键（22 个简单控件中 12 个）」→「24 键中 15 键（23 个简单控件中 14 个）」、
     `:153` 63→65、`:356` 63→65/76→77。
2. `verify-admin-static.mjs`：文件头注释 76→77；92→93、76→77（两处）、71→72、
   BOOL 34→35、notes 63→65、分类合计与 `entries.size` 比较；pdk 开关页签断言两键。
3. 验证：`pnpm verify:admin` 全绿。
4. Commit：`feat(admin): 跑得快 2/4 人开关拆分`。

## T5 client 核心：能力表 + store + 12012 文案

**Files**：`src/gameModes.ts`、`src/stores/game.ts`、`src/net/copy.ts`；
`test/{player-count,copy-coverage}.test.ts`（新/改）。

1. 测试先行（`player-count.test.ts`）：
   - `activePlayerCounts`：服务端 `[3]` ⇒ `[3]`；`[2,3,4]` ∩ 客户端 `[2,3]` ⇒ `[2,3]`；
     旧服务端无 `games` ⇒ `[3]`；
   - `effectivePlayerCount`：选 2 且可用 ⇒ 2；配置收回 2 ⇒ 回落 3；
   - `setSelectedPlayerCount` 拒绝交集外的值。
   `copy-coverage.test.ts`：12012 从 FIXED 移到 MESSAGE_FIRST；serverMessage 优先，
   空则用「这个玩法暂未开放，请稍后再试」。
2. 红。
3. 实现：
   - `gameModes.ts` 导出 `CLIENT_TABLE_PLAYER_COUNTS: Readonly<Record<GameType, readonly number[]>>`
     （新增 `import type { GameType }`）；tagline 去掉「三人」；
   - store 加 state + 三只 getter（`activeServerPlayerCounts`/`activePlayerCounts`/
     `effectivePlayerCount`）+ action（`isGameType` 窄化后索引 `games`）；
   - `copy.ts` 把 `GAME_UNAVAILABLE` 移入 `FALLBACK_COPY`。
4. 绿：`pnpm -C apps/client test && pnpm -C apps/client run lint`。
5. Commit：`feat(client): 跑得快人数能力表与 12012 文案`。

## T6 client 开始游戏页：人数切换 + 上行

**Files**：`src/pages/game/game.vue`；`test/lobby-ux.test.ts` 或 `test/player-count.test.ts`。

1. 测试先行：
   - 服务端 `supportedPlayerCounts=[2,3]` ⇒ 出现「2 人/3 人」控件且默认 3；
     `[3]` ⇒ 不渲染；
   - 选 2 后点「开始游戏」⇒ `room.match` 载荷 `playerCount === 2`（number）；
   - `.game__match button` 仍恰 1 个；控件不在 `.game__match` 内；
   - 「再来一局」：上一局 2 人 ⇒ 回写选择后 `match()` 载荷 2 且选择器高亮 2；
     2 人闸已关 ⇒ 回写被拒、载荷回落 3；
   - 好友房 `createRoom` 载荷 2；REST 12012 走页面错误行（`ROOM_LOCAL_CODES`）。
2. 红。
3. 实现：
   - 控件放 `.game__stage`、`.game__match` 外；`v-for="n in store.activePlayerCounts"`；
   - `match(playerCountOverride?: number)`，`@click="match()"`，数字守卫；
   - `createAndJoin` 用 `effectivePlayerCount`；
   - 消费 rematch：`setSelectedPlayerCount(store.playerCount)` 后调用 `match()`（用 effective）；
   - **不**在挂载时 `refreshClientConfig()`（会覆盖既有测试夹具并清空 games）；
   - `ROOM_LOCAL_CODES` 加 `GAME_UNAVAILABLE`；删除未用 `GAME_META` 导入
     （确认 `:603`/`:859` 两处已替换）。
4. 绿 + lint。
5. Commit：`feat(client): 开始游戏页人数切换`。

## T7 client 牌桌：2 人布局 + 壳 + 历史

**Files**：`src/pages/table/table.vue`、`src/components/table/pdk/PdkBoard.vue`、
`src/pages/history/history.vue`；`test/{pdk-board,history-pdk}.test.ts`。

1. 测试先行：
   - 壳：4 人视图 ⇒ 提示、回大厅、按 `doLeave` 成例带 `roomCode` 尽力 `room.leave`
     （FakeSocket 断言载荷；不 await、不阻塞导航）；2 人视图 ⇒ 正常渲染；
   - PdkBoard：2 人 ⇒ `.pdk__seat` 恰 1、无 `.pdk__seat--right`、
     无 `.pdk__play-col--right`、`.turn-timer` 恰 1、`.pdk__mid--two` 存在；
     3 人 ⇒ `.pdk__seat` 恰 2、`.turn-timer` 恰 2；
   - 历史：pdk 卡片含「2 人局」。
2. 红。
3. 实现：
   - 壳改用 `CLIENT_TABLE_PLAYER_COUNTS[gameType].includes(playerCount)`（先窄化 gameType，
     新增该 import），不支持时：
     `sendQueued('room.leave', { roomCode: store.roomCode }, 5)` +
     `raceTimeout(…, 5000)`，`void … .catch(() => {})`，随后原有 fail-safe 流程；
   - PdkBoard `seats: readonly number[]`，2 人单座；右座/右列/右计时器统一
     `v-if="seats.length > 1"`；`pdk__mid--two` + CSS；
   - 历史加 `{{ record.playerCount }} 人局`。
4. 绿：`pnpm -C apps/client test && lint`。
5. Commit：`feat(client): 跑得快 2 人牌桌与历史标识`。

## T8 文档与注释同步

**Files**：`docs/games/paodekuai.md`、`docs/design.md`、`docs/client-protocol.md`、
`docs/ops/first-deploy.md`、`packages/shared/src/pdk/doc-sync.test.ts`；注释：
`packages/config-service/src/config/{admin.controller.ts,platform-config.service.ts}`、
`packages/api-gateway/src/gateway/gateway.controller.ts`、
`packages/room-service/src/config/config-cache.service.ts`（`supportsRoomPlayerCount` 方法注释）、
`packages/room-service/src/currency/settle.service.ts`、
`packages/user-service/src/records/records.service.ts`、
`packages/room-service/src/gateway/ws.gateway.ts`。

1. 文档：配置表两行、§2 客户端开放人数、design 键表/计数（92→93、active 77、pdk active 24）、
   client-protocol 92→93、first-deploy 92/76→93/77。
2. `doc-sync.test.ts` 键↔文档行配对加入新键。
3. 注释同步：admin/controller/entity/gateway 的「九十二键」→「九十三键」；「三人/三座/恰 3 条」
   改人数中立表述（不改变逻辑）。
4. `platform-config.service.test.ts` 的种子数组新键**追加在跑得快段（index > 80）**，
   不得插到前部（`:397` 有按位置取 `SEED[8]` 的断言）。
5. 绿：`pnpm -C packages/shared test`。
6. Commit：`docs: 跑得快 2 人场文档与计数同步`。

## T9 conformance：2 人真栈段

**Files**：`tools/conformance/src/lib/pdk-driver.ts`、
`tools/conformance/src/slices/slice-29-paodekuai.ts`、`tools/conformance/baselines.json`。

1. `startPdkRoom` 加 `playerCount`（默认 3）与账号数参数；3 人调用零改动。
2. slice-29 新增 2 人组（spec §4.6）：
   - 先显式 PUT `twoPlayerEnabled=false`（防残留）；
   - 在 `enablePdk` 之后（好友房/玩法闸在前）做负对照：2 人建房/匹配 ⇒ 12012 且 message 含「人数」；
   - 管理面开 `twoPlayerEnabled`，用**全新账号**轮询 `POST /api/rooms` `playerCount=2`
     得 0（`enablePdk` 的探测账号已建房，复用会撞 12011）；
   - 两账号匹配/16 张/扣牌不出站 → 打到终局/零和/记录 `playerCount=2` → 收尾还原。
3. `pnpm -C tools/conformance lint && build`；真栈可跑则实测并按读数回填 baseline，
   否则按源码静态计数并登记「真栈未跑」。
4. Commit：`test(conformance): 跑得快 2 人真栈段`。

## T10 browser-e2e：pdk2 场景

**Files**：`scripts/browser-e2e.mjs`。

1. 新增 `--scenario pdk2`：开 `enabled`+`twoPlayerEnabled` → **room-service 生效观测**
   （`POST /api/rooms` + `playerCount:2` 轮询到 0，放在好友房两闸之后）→ 大厅切跑得快 →
   选 2 人 → 匹配（一人 + 机器人，30s 补位窗口）→ 出牌/过牌 → 结算 → 返回大厅；收尾还原两键。
2. 判据：`room.matched/state_update.playerCount===2`、`.pdk__seat` 恰 1、
   结算行恰 2、手牌 16、结算面板含「倍数」。
3. 能跑则跑；不能跑登记。
4. Commit：`test(e2e): 跑得快 2 人场景`。

## T11 全量与收口

1. `pnpm exec turbo run test lint --force`（0 cached）、`pnpm verify:admin`、
   `pnpm -C apps/client test && pnpm -C apps/client run lint`、
   `pnpm -C tools/conformance lint && build`。
2. 独立代码审查（sonnet，`BASE..HEAD`），Critical/Important 修复；
   Minor 登记或顺手修。
3. 修完补测，重跑全量。
4. fetch/merge `origin/dev`（如有新提交）→ 重跑验证 → push `dev`。
5. 交付报告：变更、证据、提交范围、已知边界（2 人金币场真栈缺口、Docker 限制）。

## 回归命令（按改动面）

```bash
pnpm -C packages/protocol test
pnpm -C packages/config-service test
pnpm -C packages/room-service test
pnpm -C packages/shared test
pnpm -C apps/client test
pnpm -C apps/client run lint
pnpm verify:admin
pnpm -C tools/conformance lint
node scripts/browser-e2e.mjs --scenario pdk2   # 环境可用时
```

## 计划审查记录（2026-10-25，独立 reviewer）

结论：**阻断 3 / 高 3 / 低 11**，全部处置如下。

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 | `room.leave` 载荷缺 `roomCode`，裸 await 会挂起 | T7：照 `doLeave` 用 `sendQueued` + `raceTimeout` + 不阻塞导航 |
| 阻断 | 改桩后 `record-pdk.test.ts`、`match-player-count.test.ts` 必红 | T3：列入文件并补开 two 闸 |
| 阻断 | 挂载 `refreshClientConfig()` 会清空既有测试夹具的 `games`，成片红 | 删除该刷新；T6/spec D7 改为 getter 收敛 + 回大厅重取 |
| 高 | 2 人断言漏 `.pdk__play-col--right` / 右计时器 | T7：补 `.turn-timer` 与右列断言 |
| 高 | e2e 缺 room-service 生效观测点 | T10：加 `POST /api/rooms` 2 人轮询 |
| 高 | slice-29 负对照残留 true、探测账号撞 12011、闸顺序错 | T9：显式 PUT false、全新账号、放在 enablePdk 之后 |
| 低 | `match-queue-key.test.ts` 两个 2 人用例语义被抽空 | T3：补开 two 闸 |
| 低 | 12007 是固定文案，服务端 message 只进日志 | spec §5/T3 注明，不改 12007 |
| 低 | 12012 的 `CLIENT_ACTION` 本是 TOAST，原理由不成立 | spec D15 措辞修正 |
| 低 | rematch 覆盖值绕过交集 | T6：回写选择后用 `effectivePlayerCount` |
| 低 | admin 注释漏 :120/:871/:891/:1251 | T4 点位补全 |
| 低 | 更多「九十二键」注释与 first-deploy 未列 | T8 补全 |
| 低 | 种子数组 `SEED[8]` 按位置取值 | T8：新键追加在 index > 80 |
| 低 | config-cache 方法注释仍写「收窄为 [3]」 | T8 补 |
| 低 | 「两 getter」与不存在的 `check-docs.mjs` | 已改三 getter，删除该命令 |
| 低 | match.service 用例缺玩法级前置与 zrem 键断言 | T3 补 |
| 低 | 新增 import（`GameType`、`CLIENT_TABLE_PLAYER_COUNTS`）未点出 | T5/T7 补 |

# 跑得快 4 人场 · 实现计划

> 依据：`docs/superpowers/specs/2026-10-25-pdk-four-player-design.md`。
> 分支：`dev`。每任务一 commit；TDD：失败测试 → 红 → 最小实现 → 绿 → 提交。
> attribution：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## Global Constraints

- 不改配置键、不加协议消息；`CLIENT_CONFIG_KEYS` 仍 21 键。
- 3 人/斗地主行为零变化；4 人闸仍是 `game.paodekuai.nonThreePlayerEnabled`。
- 动作窗口单一真源：protocol `pdkRecentActionsWindow(playerCount) = max(2, playerCount - 1)`；
  斗地主仍 2。
- 牌桌 `balances` 按 `view.playerCount` 生成（缺省 3）。
- 顶部对家行是 `.pdk` 的直接子项（不是 `.pdk__mid` 的子项）。
- 每任务只改本任务文件；提交前跑受影响包 test + lint。
- 不 push master、不部署；推 `dev` 前 fetch/merge `origin/dev` 并重跑全量。

## T1 protocol / shared / game-service：动作窗口

**Files**：`packages/protocol/src/views.ts`、`validate.ts`、`views.test.ts`；
`packages/shared/src/ddz/recent.ts`、`recent.test.ts`；
`packages/game-service/src/games/pdk/view.ts` + 对应测试。

1. 测试先行：
   - `views.test.ts`：`pdkRecentActionsWindow(2|3|4)` ⇒ 2/2/3；
   - validate 用例：4 人 pdk 视图 3 条 recentActions 通过、4 条拒绝（文案带窗口值）；
   - `recent.test.ts`：4 人「A 出、B/C 过」⇒ 投影长度 3、含 A 的非 null 目标；
   - game-service pdk view：4 人视图 recentActions 长度 3。
2. 红。
3. 实现：
   - `views.ts` 导出 `pdkRecentActionsWindow`；validate 的 pdk 分支用它；
   - `projectRecentActions(session, windowSize = RECENT_ACTIONS_WINDOW)`；
   - `games/pdk/view.ts` 传 `pdkRecentActionsWindow(session.playerCount)`；ddz 不传。
4. 绿：`pnpm -C packages/protocol build && test && lint`；
   `pnpm -C packages/shared test && lint`；`pnpm -C packages/game-service test && lint`。
5. Commit：`feat(protocol): 跑得快 4 人动作窗口`。

## T2 客户端：能力表 + 余额投影

**Files**：`apps/client/src/gameModes.ts`、`apps/client/src/pages/table/table.vue`；
`apps/client/test/{player-count,lobby-ux,pdk-board}.test.ts`。

1. 测试先行：
   - 能力表 `[2,3,4]`；服务端 `[2,3,4]` ⇒ `activePlayerCounts=[2,3,4]`；选 4 生效；
   - 既有翻转点逐条改：`[2,3]` 数组断言、`4 被拒` 用例；
   - TablePage 4 人视图 + `seatBalances[3]` ⇒ seat 3 显示该余额（不是「—」）。
2. 红。
3. 实现：`CLIENT_TABLE_PLAYER_COUNTS.paodekuai=[2,3,4]`；`balances` 按
   `store.view?.playerCount ?? 3` 生成；头注释同步。
4. 绿 + lint。
5. Commit：`feat(client): 跑得快 4 人能力表与余额投影`。

## T3 PdkBoard：4 人布局

**Files**：`apps/client/src/components/table/pdk/PdkBoard.vue`；
`apps/client/test/pdk-board.test.ts`。

1. 测试先行：
   - 4 人（me=0）：`.pdk__seat` 恰 3；`.pdk__seat--top` 存在；seatNames 断言
     左=丁（seat3）/右=甲（seat1）/上=乙（seat2）；12 张手牌；`.pdk__mid--four`/`pdk--four`；
   - 2 人：1 座、无 top/`--four`；3 人：2 座、左=丙（seat2）/右=甲（seat1）、无 top/`--four`；
   - 5 人合成视图（cast 直注 store）⇒ 提示 + 带 roomCode 退房 + 回大厅。
2. 红。
3. 实现：`seats` 按 2/3/4；`topSeat`（me=null 时 2）；顶部行 `.pdk__top` 放
   `.pdk__mid` 之前；`topAction`；根 `pdk--four`；CSS（`.pdk__top`、`--top`、
   `.pdk__mid--four`、遮罩 `top:40%`）。
4. 绿 + lint。
5. Commit：`feat(client): 跑得快 4 人牌桌`。

## T4 客户端：hint / 结算 / 历史 / 选择器

**Files**：`apps/client/test/{pdk-hint,pdk-settlement,history-pdk,lobby-ux}.test.ts`
（必要时 `pdk-hint.ts`/`PdkSettlement.vue` 仅小修）。

1. 测试先行：
   - 4 人 hint/target/passOnly：recentActions = [A 出 3, B 过, C 过]、我接手 ⇒ 提示出
     能压 3 的牌、非首出；
   - 结算 4 行、名次 1–4；
   - 历史 4 人夹具显示「4 人局」；
   - 开始页 `[2,3,4]` ⇒ 三个选项；选 4 ⇒ `room.match`/`createRoom` 载荷 4。
2. 红 → 最小实现 → 绿。
3. Commit：`test(client): 跑得快 4 人提示/结算/历史/入口`。

## T5 conformance：4 人真栈段

**Files**：`tools/conformance/src/slices/slice-29-paodekuai.ts`、`baselines.json`。

1. 在 2 人组后加 4 人组（spec §4.5）：负对照 WS 12012（有界轮询）→ PUT
   `nonThreePlayerEnabled=true` → 全新账号 `POST /api/rooms` 4 人轮询 → 4 个全新账号
   成局：12 张/长度 4/无扣牌 → 终局 4 座零和/记录 playerCount=4/旧查询不含 → 收尾。
   `setup.disable()` 一并复位 `nonThreePlayerEnabled=false`。
2. `pnpm -C tools/conformance lint && build`；真栈可跑则实测回填 baseline
   （89 → 静态预计 ~109），否则按源码静态计数并登记。
3. Commit：`test(conformance): 跑得快 4 人真栈段`。

## T6 browser-e2e：pdk4 场景

**Files**：`scripts/browser-e2e.mjs`。

1. 参数化 `runPdkScenario(cdp, playerCount)`：handSize = 4 人 12、其余 16；人数选项
   2/3/4；`setupPdkEnabled(playerCount)` 按人数开 `twoPlayerEnabled`/`nonThreePlayerEnabled`；
   收尾两键；`pdk4` 分支。
2. 判据：`pdkPlayerCount=4`、手牌 12、`.pdk__seat` 恰 3、`.pdk__seat--top` 存在且
   bounding-box 在左右座上方、结算 4 行。
3. `node --check`；能跑则实测，否则登记。
4. Commit：`test(e2e): 跑得快 4 人场景`。

## T7 文档与注释

**Files**：`docs/games/paodekuai.md`、`docs/design.md`、`admin/app.js`、
`apps/client/src/stores/game.ts`（applyBalances 注释）、
`scripts/browser-e2e.mjs`（READ_STATE 注释）、`packages/protocol/src/views.ts`、
`packages/shared/src/index.ts`、`PdkBoard.vue`/`table.vue`/`gameModes.ts` 头注释。

1. 客户端已支持 2/3/4；窗口说明（ddz 2 / pdk 按人数）；余额/`恰 3 条`注释同步；
   `nonThreePlayerEnabled` 备注补「客户端已支持 4 人牌桌」。
2. `pnpm verify:admin` + 受影响包 lint。
3. Commit：`docs: 跑得快 4 人场文档与注释同步`。

## T8 全量与收口

1. `pnpm exec turbo run test lint --force`（0 cached）、`pnpm verify:admin`、
   `pnpm -C apps/client run lint`、`pnpm -C tools/conformance lint && build`。
2. 独立代码审查（sonnet，`BASE..HEAD`），Critical/Important 修复后重跑。
3. fetch/merge `origin/dev` → 重跑 → push `dev`。
4. 交付报告：变更、证据、提交范围、已知边界（4 人金币场真栈、Docker 限制）。

## 回归命令

```bash
pnpm -C packages/protocol test
pnpm -C packages/shared test
pnpm -C packages/game-service test
pnpm -C apps/client test
pnpm -C apps/client run lint
pnpm verify:admin
pnpm -C tools/conformance lint
node scripts/browser-e2e.mjs --scenario pdk4   # 环境可用时
```

## 计划审查记录

（待独立 reviewer 审查后填写）

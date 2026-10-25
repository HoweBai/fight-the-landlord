# 跑得快 4 人场 · 实现计划

> 依据：`docs/superpowers/specs/2026-10-25-pdk-four-player-design.md`。
> 分支：`dev`。每任务一 commit；TDD：失败测试 → 红 → 最小实现 → 绿 → 提交。
> attribution：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

## Global Constraints

- 不改配置键、不加协议消息；`CLIENT_CONFIG_KEYS` 仍 21 键。
- 3 人/斗地主行为零变化；4 人闸仍是 `game.paodekuai.nonThreePlayerEnabled`。
- 动作窗口单一真源：**叶子模块** `packages/protocol/src/pdk/window.ts` 的
  `pdkRecentActionsWindow(playerCount) = max(2, playerCount - 1)`；斗地主仍 2。
- 牌桌 `balances` 按 `view.playerCount` 生成（缺省 3）。
- 顶部对家行是 `.pdk` 的直接子项（不是 `.pdk__mid` 的子项）；CSS 只用 token/rpx。
- 每任务只改本任务文件；提交前跑受影响包 test + lint。
- 不 push master、不部署；推 `dev` 前 fetch/merge `origin/dev` 并重跑全量。

## T1 protocol / shared / game-service：动作窗口

**Files**：新增 `packages/protocol/src/pdk/window.ts`；`packages/protocol/src/index.ts`、
`validate.ts`、`multi-game-contract.test.ts`；`packages/shared/src/ddz/recent.ts`、
`recent.test.ts`；`packages/game-service/src/games/pdk/view.ts` + pdk view 测试。

1. 测试先行：
   - `multi-game-contract.test.ts`：`pdkRecentActionsWindow(2|3|4)` ⇒ 2/2/3；
     4 人 pdk 视图 3 条通过、4 条拒绝；**3 人 pdk 视图 3 条拒绝、2 人 3 条拒绝**；
   - `recent.test.ts`：4 人「A 出、B/C 过」⇒ 投影长度 3、含 A 的非 null 目标；
     3 人仍长度 ≤2；
   - game-service pdk view：4 人视图 recentActions 长度 3、3 人最多 2。
2. 红。
3. 实现：
   - `pdk/window.ts`（无 import）+ index 导出；validate 用它（保持 `ProtocolError` 依赖方向）；
   - `projectRecentActions(session, windowSize = RECENT_ACTIONS_WINDOW)`；
   - `games/pdk/view.ts` 传 `pdkRecentActionsWindow(session.playerCount)`；ddz 不传。
4. 绿：`pnpm -C packages/protocol build && test && lint`；
   `pnpm -C packages/shared test && lint`；`pnpm -C packages/game-service test && lint`。
5. Commit：`feat(pdk): 跑得快 4 人动作窗口`。

## T2 PdkBoard：4 人布局（先于能力表）

**Files**：`apps/client/src/components/table/pdk/PdkBoard.vue`；
`apps/client/test/pdk-board.test.ts`。

1. 测试先行：
   - 4 人（me=0）：`.pdk__seat` 恰 3；`.pdk__seat--top` 存在；seatNames 断言
     左=丁（seat3）/右=甲（seat1）/上=乙（seat2）；12 张手牌；`pdk--four` 与 `pdk__mid--four`；
   - 2 人：1 座、无 top/`--four`；3 人：2 座、左=丙（seat2）/右=甲（seat1）、无 top/`--four`；
   - 4 人跟牌目标：`recentActions=[{seat:2,cards:[3]},{seat:3,cards:null},{seat:1,cards:null}]`、
     mySeat=0、手牌 `[3,8]` ⇒ 提示应跟出 8（首出会选 3，防假绿）；
     手牌全 ≤ 目标 ⇒ 只出现「不出」（passOnly）；
   - 5 人合成视图（cast 直注 store）⇒ 提示 + 带 roomCode 退房 + 回大厅。
2. 红。
3. 实现：`seats` 按 2/3/4；`topSeat`（me=null 时 2）；顶部行 `.pdk__top` 放
   `.pdk__mid` 之前、`.pdk` 直接子项；`topAction`；根 `pdk--four`；CSS：
   `.pdk__top`、`.pdk__seat--top`（覆盖 `align-self`/`margin-bottom`）、
   `.pdk__play-col--top`、`.pdk__mid--four`、`.pdk--four .pdk__phase-overlay { top: 40% }`；
   只用 token/rpx（过 `ui-tokens.test.ts` 机械闸）。
4. 绿 + lint。
5. Commit：`feat(client): 跑得快 4 人牌桌`。

## T3 客户端：能力表 + 余额投影 + 选择器

**Files**：`apps/client/src/gameModes.ts`、`apps/client/src/pages/table/table.vue`；
`apps/client/test/{player-count,lobby-ux}.test.ts`（必要时 `pdk-board.test.ts` 的 TablePage 用例）。

1. 测试先行：
   - 能力表 `[2,3,4]`；服务端 `[2,3,4]` ⇒ `activePlayerCounts=[2,3,4]`；选 4 生效；
   - **既有翻转点逐条改**：`[2,3]` 数组断言、`4 被拒`、`[3,4] ⇒ [3]`（翻为 `[3,4]`）；
   - 开始页 `[2,3,4]` ⇒ 三个选项；选 4 ⇒ `room.match`/`createRoom` 载荷 4；
   - TablePage 4 人视图 + `seatBalances[3]`（取 9999）⇒ `.seat__coin-value` 文本含该值。
2. 红。
3. 实现：`CLIENT_TABLE_PLAYER_COUNTS.paodekuai=[2,3,4]`；`balances` 按
   `store.view?.playerCount ?? 3` 生成；头注释同步。
4. 绿 + lint。
5. Commit：`feat(client): 跑得快 4 人能力表与余额投影`。

## T4 客户端：结算 / 历史 / 入口回归

**Files**：`apps/client/test/{pdk-settlement,history-pdk,lobby-ux}.test.ts`
（必要时 `PdkSettlement.vue` 仅小修）。

1. 测试先行：
   - 结算 4 行、名次 1–4；
   - 历史 4 人夹具显示「4 人局」；
   - 开始页选 4 后好友房建房载荷 4（若 T3 未覆盖）。
2. 红 → 最小实现 → 绿。
3. Commit：`test(client): 跑得快 4 人结算/历史/入口回归`。

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

1. 参数化 `runPdkScenario(cdp, playerCount)`：handSize = 4 人 12、其余 16；按文本定位
   人数选项（4 人场景只开 `nonThreePlayerEnabled` ⇒ 选项是 3/4，**不**断言三选项）；
   `setupPdkEnabled(playerCount)` 按人数开 `twoPlayerEnabled`/`nonThreePlayerEnabled`；
   收尾两键；`pdk4` 分支；`canPass` 读 `pdkCanPass`。
2. 判据：`pdkPlayerCount=4`、手牌 12、`.pdk__seat` 恰 3、`.pdk__seat--top` 存在且
   bounding-box 在左右座上方、结算 4 行。
3. `node --check`；能跑则实测，否则登记。
4. Commit：`test(e2e): 跑得快 4 人场景`。

## T7 文档与注释

**Files**：`docs/games/paodekuai.md`、`docs/design.md`、`docs/client-protocol.md`、
`admin/app.js`、`apps/client/src/stores/game.ts`（applyBalances 注释）、
`apps/client/src/composables/useTableSound.ts:36`、
`apps/client/src/composables/usePlayedCards.ts:4,8`、
`scripts/browser-e2e.mjs:27-28,59`（READ_STATE 注释）、
`packages/protocol/src/views.ts`、`packages/shared/src/index.ts`、
`PdkBoard.vue`/`table.vue`/`gameModes.ts` 头注释、`apps/client/test/pdk-board.test.ts:16,192`。

1. 客户端已支持 2/3/4；窗口说明（ddz 2 / pdk 按人数）；余额/`恰 3 条`注释同步；
   `client-protocol.md` 的「客户端只发 playerCount: 3」等过期句同步；
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

## 计划审查记录（2026-10-25，独立 reviewer）

结论：**阻断 1 / 高 4 / 低 7**，全部处置。

| 级别 | 发现 | 处置 |
|---|---|---|
| 阻断 | T2 余额测试在 PdkBoard 4 人布局前不可能绿 | 交换 T2/T3：先 PdkBoard 4 人，再能力表/余额 |
| 高 | `pdkRecentActionsWindow` 放 views.ts 会造 views↔validate 运行时环 | T1：放叶子模块 `pdk/window.ts`，index 导出 |
| 高 | 缺 2/3 人负向回归（3 条必须拒） | T1：补 3 人/2 人视图 3 条拒绝 |
| 高 | 4 人 hint 用例放错文件（pdk-hint 不吃 recentActions） | T2：落 `pdk-board.test.ts` |
| 高 | 提示用例用 [4,8] 对目标 3 会假绿 | T2：改用 `[3,8]`（跟出 8/首出 3）+ passOnly 断言 |
| 低 | 漏 `[3,4] ⇒ [3]` 翻转 | T3 补 |
| 低 | 余额断言与 Seat 实际渲染不符 | T3：锚 `.seat__coin-value`、取 <10 万 |
| 低 | 新 CSS 需过 token/rpx 机械闸；顶部 seat 覆盖对齐 | T2 写明 |
| 低 | 注释/文档漏点（store/table/useTableSound/usePlayedCards/client-protocol/e2e/pdk-board） | T7 补全 |
| 低 | T1 commit 名跨包 | 改为 `feat(pdk):` |
| 低 | validate 用例无归属文件 | T1 点名 `multi-game-contract.test.ts` |
| 低 | pdk4 只开 nonThree ⇒ 选项 3/4 | T6：按文本定位「4 人」，不断言三选项 |

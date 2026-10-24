# 设计：挂机治理（超时缩短 + 自动托管 + 手动托管）v1.6

- 日期：2026-10-17 · 分支：dev（未开工）· 状态：**可以定稿（收口复评 r6 确认）—— 待用户审阅**
- 修订史：v1.0 → r1「修后再评」（2 阻断 + 8 重要 + 6 次要）→ v1.1 处置 → **r2「修后再评」（1 阻断 + 6 重要 +
  7 次要）→ v1.2 处置** → **r3「修后再评」（1 阻断 + 3 重要 + 7 次要）→ v1.3 处置** → **r4「修后再评」
  （1 阻断 + 3 重要 + 2 次要）→ v1.4 处置** → **r5「修后再评」（1 阻断 + 4 次要）→ v1.5 处置** →
  **收口复评 r6「可以定稿」**（1 条接线措辞随版订正）→ **v1.6（规格评审 r2 联动）**：⚠️ `GameTrusteeRequest` 增判别位 **`via: 'manual' | 'reconnect' | 'abandon'`**（规格 C12 手动关不重排 vs C14 重连按 count 基线重排为同输入互斥语义，无判别位无法实现——r1 阻断 1 的设计侧回改）
- 用户裁决（前提，勿再动摇）：① 「离开」= 真离开 ∪ 超时未动作 ② 托管 = **规则引擎**（与今日超时同强度）
  ③ 30s → 超时后 10s → 3 次自动托管（1.5s 短延时）④ 手动动作复位 30s ⑤ 托管按钮可开可关。
  上述时长是**生产默认**；测试注入另有短值（见 §三 env）。

## 一、背景与现状（实读）

- 玩家离开（显式弃局/关页面）后座位**在对局中不释放**（`rooms.service.ts:283` R916），每轮到他实打实等满 30s。
- 计时器 `startTurnTimer` 硬编码 `TURN_TIMEOUT_MS = 30_000`（game.service.ts:552；shared `createBidTimer/
  createPlayTimer` 同默认）；`deadline = now + 30_000` 在转移点（`:254/:431/:722`）与 `onTurnTimeout`（`:786`）重算。
  **30s 是服务端的**：会话字段在 `packages/shared/src/ddz/types.ts:68`，客户端读点
  `apps/client/src/stores/game.ts:359`（只按快照 deadline 渲染）。
- 超时决策链现成（`onTurnTimeout`，`:763-795`）：叫抢 ⇒ `handleBid(session, playerId, false)`；出牌 ⇒
  `handlePlayTimeout`（首出最小单张 / 跟牌规则引擎最小可压 / 过牌）。
- 断线恢复「对局存活即可回」。房间一局制（`rooms.start.ts:159`）。`robot.decide` 座位无关但**本片不用**（用户裁）。

## 二、行为规格（状态机）

每**人类**座位：`timeoutCount`（连续超时，对局内）与 `trustee`。⚠️ **机器人座位豁免**（不计数、不托管、无徽标）。

`normal(30s)` ──超时──▶ `accelerated(10s)`〔1〕──超时──▶ `accelerated(10s)`〔2〕──超时──▶ **`trustee(1.5s)`**〔≥3〕
**回合消耗型动作**（bid/play/pass 成功）──▶ `normal(30s)`〔count 清零〕
**重连/回桌 / `game.trustee{on:false}`** ──▶ 解除 trustee〔**count 不清零**——封「刷 off/刷新页面续命」旁路〕
**显式弃局** ──▶ **`trustee`**（0 门槛）

| # | 规则 | 钉法 |
|---|---|---|
| R1 | 回合时长按**行动者座位**态：trustee ⇒ 1.5s；count>0 ⇒ 10s；否则 30s | 叫抢/出牌两阶段同效；`turnDeadlineAt` 同源重算 |
| R2 | 超时且自动动作**成功** ⇒ count+1；**count ≥ 3 ⇒ trustee=true** | 抛错分支不计数 |
| R3 | **仅**回合消耗型动作成功 ⇒ trustee=false + count=0 + 30s | off/重连只清 trustee |
| R4 | `game.trustee{on}` 语义（⚠️ r2 重要 3；r3 次要 5/6）：**守卫先于 no-op**（非法态先抛，如 Ended+目标=现值 ⇒ 13005 而非 0）；**目标值 = 现值 ⇒ 完全 no-op**（不落盘/不 bump/不推送）；**实际变更 ⇒ 轻量转移**：save + version+1 + `publishSeatViews`（**不经 `finishTransition` 的满额 timer 重挂**）。转移致 version+1 后，同回合他人持旧版本的在途动作照**既有 13004** 处置（REFRESH_SNAPSHOT），不为本片发明特殊保护 | 幂等 = no-op；转移只在值变化时发生 |
| R4b | 非法态错误码照实态（⚠️ r2 次要 8 收窄）：game-service 内 `Init ⇒ 13009`（仅单测可造，真栈无 Init 会话）/ `Ended ⇒ 13005`；router 面 `无会话/无房 ⇒ 12001`、`无可恢复房 ⇒ 12004`。**不新造码** | 单测钉 13009/13005；conformance 钉 12001/12004/13005 |
| R5 | 显式弃局 ⇒ trustee=true；**目标房 = `resolveRecoverableRoom(userId)` 派生**；⚠️ r3 重要 2：**先解析后清记录**；⚠️ r4 次要 7/8 + r5 次要 6 钉死顺序与姿态：**① awaited 解析 roomCode（在 `clearConnection` 之前，保住 resolver 候选源）→ ② 仅当 `resolved.status === 'playing'` 且 `consistent`（或 target == payload roomCode）才 **fire-and-forget** 转发（awaited 会把 ack 拖到 2s；waiting 房 leave 是常见路径、不得产生注定 12001 的噪音 RPC；不一致 ⇒ skip + 一行日志——错房号 leave 不得置错房）→ ③ 清记录 → ④ ok**；转发失败只 warn（fail-open） | 「只是想离开」不变量不破；错房号不误置；waiting leave 零噪音 |
| R6 | 重连 / 回桌（**两条入口**：reconnect 与在局 `room.join`）⇒ trustee=false；**先清后 ack**、**fail-open**。⚠️ r3 次要 11 + r4 重要 5 + r5 次要 5：**仅当 trustee 实际 `true→false`** 且**本人恰是当前行动者** ⇒ 按 count 基线重排一次并同批重算 `turnDeadlineAt`：`count > 0 ⇒ 10s`（防续命）；`count === 0 ⇒ 30s`。非 trustee 的行动者反复 join **不得**重置 timer（否则是另一种续命面） | 两条路径各一格；count=0/≥1 两档；非 trustee join 不动 timer 一格 |
| R7 | 托管动作 = 与超时链**同一个决策函数**；动作后按 R1 重排 timer | ⛔ 不写第二套 |
| R8 | **回合中改态的 timer/deadline 语义**（⚠️ r2 重要 4；⚠️ r4 重要 5 订正 R8②）：① 行动者回合中被置 trustee ⇒ 重排 timer 且 **`turnDeadlineAt = now + max(0, min(旧剩余, 1.5s))`**（先改 deadline 再 publish；min 可为负须 clamp）；② 行动者回合中收到 **`game.trustee{on:false}`** ⇒ **不重排不重算**（本轮仍按原短延时自动走一次——防续命）；**重连/回桌的解除不适用本条，走 R6 例外（按 count 基线重排 + 重算 deadline）**；③ 非行动者变更 ⇒ **不动 timer/deadline**（⚠️ r4 重要 6：与 design.md:348「每次状态转移后重算」冲突——文档同批改为「每次**回合**转移后重算；治理态变更不算回合转移」） | 三分支各一格 |
| R9 | 计数对局内有效（房间一局制，无跨局） | 事实陈述，不设可检验规则 |
| R10 | **同房写路径串行化**（⚠️ r3 阻断 1；r4 阻断 1 + 重要 3/4；r5 阻断 1 定案）：写者清单 = `applyAction` / `onTurnTimeout` / **trustee 轻量转移** / **机器人提交（`commitRobotDecision`——`driveRobotTurn` 先 getSession 再 await 1.5s+5s、用**旧快照**提交，窗口 ~6.5s；toggle 是第一个任意时刻合法的人类写者）**。机制：**awaited per-room 队列（⛔ 不照 `robotDriving` 的 drop-on-reentry——会静默丢 toggle/action）**；临界区 = **read→compute→save→publish→startTurnTimer 整段**；**机器人提交入锁后按「state/actor」复验**（治理变更不影响决策有效性，⛔ 不按 version 严格复验——否则频繁 toggle 下反复丢弃重驱）；「会话已变 ⇒ **丢弃本次决策并立即重驱**」——⚠️ r6 收口补钉：**重驱 = 走 `driveRobotTurn` 循环的下一轮**
（`commitRobotDecision` 返回 true 让循环重读），⛔ 不得在锁内递归调 `driveRobotTurn`——`robotDriving` 的
drop-on-reentry（`game.service.ts:615`）会让递归静默 no-op、退化成 30s 超时兜底（正是该句要防的形态）；
且**复验通过后用「入锁后重读的会话」应用已决定的动作（rebase）**，⛔ 不把旧快照原样保存。
**timer 回调复核按「回合身份」而非 session version**：入锁后仅当 `state∈{Init,Ended}` 或
`(actorSeat, turnDeadlineAt)` 与装备时不同才放弃；**纯 version 变化（治理转移）不算失效**——否则非行动者
toggle 会让回调放弃而 R8③ 又不动 timer ⇒ **AFK 回合永久停摆**（⚠️ r5 阻断 1；R106/R525 反复修的正是这个形态） | 并发用例三格：同 tick 双发（出牌+toggle）· 机器人提交 × toggle · **非行动者 toggle 后定时到点 ⇒ 照常自动动作** |

## 三、数据与协议面

- **会话**：`players[i]` 增 `timeoutCount` / `trustee`；`loadSession` 缺省迁移（`?? 0` / `?? false`，SESSION_TTL
  窗口内旧会话必缺；防 `undefined+1=NaN`）+ 单测。
- **快照**：`PlayerView` 加按座位数组 **`trustees: [boolean, boolean, boolean]`**（照 `cardCounts` 三元组先例）；
  ⚠️ r2 次要 12：`protocol/validate.ts` 的 `assertPlayerView` 同批加「恰 3 个 boolean」断言（否则坏形状静默）。
- **命令通道（⚠️ r2 阻断 1 定案——不走 `game.action` 联合）**：客户端对非 CAS 消息固定发 `baseVersion=0`
  （`net/socket.ts:291`），沿 action 落点必抛 13004 且违反 R8 ⇒ **新开独立出站边 `game.trustee`**：
  1. `protocol/rpc.ts`：`RPC_PATTERNS.gameTrustee` + `GameTrusteeRequest { roomCode, userId, on, via, meta? }`——`via: 'manual' | 'reconnect' | 'abandon'`（manual=客户端按钮；reconnect=reconnect/room.join；abandon=在局 leave；**仅三个合法组合**：manual×{on,off}、reconnect×off、abandon×on；其余 ⇒ 10001 且不落盘）；
  2. `game-service/src/rpc/game.rpc.controller.ts`（⚠️ r2 次要 13 路径订正）：新 `@MessagePattern` 方法，
     仅做守卫 + 调 service（**无 CAS、无版本前置、不进 applyAction/applyById**）；
     ⚠️ r3 重要 3：**必须走 R220 信封 `toResult(..., dto?.meta)`**（既有四条边全部如此；漏掉 ⇒
     `game.client.ts` 把一切异常折成 **10007**，R4b 的 12001/13005 全线塌缩、与 conformance 断言互斥）。
     响应类型 `RpcResult<{ version: number }>`；C→S ack 载荷 = `{ code, data: { version } }`（快照仍走
     `publishSeatViews` 推送，不在 ack 里带全量视图）；
  3. `room-service/src/gateway/game.client.ts`：新 `trustee()` 方法（2s 超时、失败抛供调用方 fail-open）；
  4. `message.router.ts`：新 `game.trustee` case + `room.leave` 在局转发 + **reconnect/`room.join` 两条回桌转发**。
  ⚠️ 客户端消息 `game.trustee {on}` 进 `CLIENT_MESSAGE_TYPES`，`@SubscribeMessage` 在 **room-service
  `ws.gateway.ts`**（daily-rescue 教训：同批接线）。
- **测试时长 env**（⚠️ r2 重要 6 空串语义）：`GAME_TURN_TIMEOUT_MS`(1500/默认 30000)、
  `GAME_TURN_TIMEOUT_ACCEL_MS`(1000/默认 10000)、`GAME_TRUSTEE_DELAY_MS`(400/默认 1500)、
  `GAME_TRUSTEE_AFTER`(3)；读取形态逐字 `Number(process.env.X) || 默认`（**`||` 非 `??`**——compose
  `${VAR:-}` 未设给空串，`??` 会让 `Number('')===0` 变成 0ms 回合；`||` 同时吃 NaN）。
  compose game-service 块加四个 `${VAR:-}` 透传（照 currency 段）；**仅测试 env 不进 design.md §2.3**
  （照 `CONFIG_SYNC_*` 先例），登记 conformance runner 注释与计划。

## 四、改动清单（文件级初判，计划层细化）

- `packages/shared/src/ddz/`：会话两字段；`onTurnTimeout` 决策抽取为可复用「自动动作」；治理纯函数。
- `packages/game-service/src/game/game.service.ts`：R1 时长策略；R2/R3；`game.trustee` 处理（R4 轻量转移 +
  R8 三分支）；**R10 per-room 写串行闸（⚠️ r5 次要 3：写者 = `applyAction` / `onTurnTimeout` / trustee 轻量
  转移 / 机器人提交——共四条，v1.4 此处误写三条）**；R106 错误重挂 **按 normal 档时长**
  （`GAME_TURN_TIMEOUT_MS`，注入态即 1500——⛔ 不用托管短延时，防日志风暴）；`loadSession` 缺省。
- `packages/game-service/src/rpc/game.rpc.controller.ts`：新 `game.trustee` 边（守卫 + 转发，无 CAS）。
- `packages/protocol`：`rpc.ts`（pattern + 请求类型）、`messages.ts`（`CLIENT_MESSAGE_TYPES`）、
  `views.ts`（`trustees`）、`validate.ts`（`assertPlayerView`）。
- `packages/room-service/src/gateway/`：`message.router.ts`（**四处**：新 `game.trustee` case / `room.leave`
  在局转发 / reconnect 转发 / 在局 `room.join` 转发——⚠️ r3 次要 10：v1.2 写「三处」与实际四项不符）、
  `game.client.ts`（`trustee()`）、`ws.gateway.ts`（`@SubscribeMessage`）。
- `docker-compose.yml`：game-service 块四个 `${VAR:-}` 透传行。
- **`docs/design.md`（⚠️ r2 重要 7 + r3 重要 4 + r4 重要 6：权威文档必须同批改）**：`:309` 的 `turnDeadlineAt =
  状态转移时刻 + 30000`、`:1517` 的「思考延迟计入 30s」、§9 的 30s 表述；**`:348`「每次状态转移后重算」⇒ 改为
  「每次**回合**转移后重算（治理态变更不算回合转移）」**（与 R8③ 的冲突，r4 重要 6）；**且非 30s 面一并补**：
  `PlayerView` 接口（:550-566 加 `trustees`）、§4.2 RPC 签名表（新边 `game.trustee`）、§4.3 超时表（新边 2s/不重试/
  fail-open）、§6.3 消息清单（`game.trustee` 行）、§6.4 可见性表（`:997-1000` 可选加 `trustees` 行）、`:633` 的
  pattern 计数叙述（**已漂移**：现文十六个 vs 实 19——新边后一并订正）。
- **`docs/games/doudizhu.md`（⚠️ r3 重要 4 + r4 重要 6：§9.2 玩法原文在这，**共 7 处**）**：`:77`「挂 30s 计时器」、
  `:167`、`:284`、`:301`「重挂 30s 计时器（§9.2）」、`:403`「各阶段回合时限均为 30 000 ms」、`:436`「每次状态转移后
  必须重挂 30s」、`:439`「turnDeadlineAt = 状态转移时刻 + 30000」——同批改，并**新增「挂机治理」小节**
  （30s/10s/1.5s 三档 + 3 次阈值 + 复位规则）。
- 客户端：`MoreMenu.vue` 托管按钮翻活（toggle）+ 座位「托管中」徽标 + `more-menu.test.ts` 同批改；
  倒计时零改动。
- **夹具/断言连带**（⚠️ r2 次要 10 + r3 次要 7 列全）：`game-service/test/game.controller.test.ts:143`
  （PlayerView 14 键穷尽）、`protocol/src/messages.test.ts:15`（`view()` 夹具）与 `:37`（消息数
  `toHaveLength(10)`→11）**与 `:55-76` 的 19 个 pattern 全对象断言**（新边必红）、
  `apps/client/test/helpers/fake-socket.ts:195`、`tools/mock-server` 视图、robot-service 夹具
  （`robot.decide.test.ts:37`、`bot.player.test.ts`、`robot.metrics.test.ts`）。
- conformance：扩片或新片（§五.3）。
- 文档：`docs/client-protocol.md`（新消息 + `trustees` 字段）。

## 五、测试策略

1. **单测（shared）**：状态机全转换矩阵（fake timers）：超时×1/×2/×3、回合消耗型复位、off/重连**不清 count**、
   弃局即托管、机器人豁免；负对照：抛错不计数、非行动者不改、非人类座无治理量。
2. **单测（game-service）**：R1 时长矩阵；**R4 no-op vs 轻量转移**（守卫先于 no-op；no-op 不 bump 不推；
   转移 version+1 + publish 且**不重挂满额 timer**）；R8 三分支（min 不延长 / `{on:false}` 不重挂 /
   重连走 R6 例外 / 非行动者不动；deadline clamp）；**R10 三格**（同 tick 双发〔出牌+toggle〕·
   **机器人提交 × toggle**（复验按 state/actor；被 toggle 打断 ⇒ 丢弃并立即重驱）· **非行动者 toggle 后
   定时到点 ⇒ 照常自动动作**（回合身份复核——纯 version 变化不失效，r5 阻断 1））；R106 错误重挂按
   normal 档；`game.trustee` 边守卫（13009 经 Init 注入 / 13005）；**loadSession 缺省**。
3. **单测（room-service）**：**新闸两条腿 + 判别力自证**（⚠️ r2 次要 11）——① 遍历 `CLIENT_MESSAGE_TYPES`
   断言每条都有 `@SubscribeMessage`（`ws.gateway.ts:538-595`）；② 遍历同清单走 `routeClientMessage`
   （stub deps）断言不命中「Unhandled client message type」（防「装饰器在、router case 不在」）；
   正/负对照各一。另：三处转发（leave/reconnect/join）的 fail-open 单测。
4. **conformance 真栈**：注入短时长（**normal=1500 / accel=1000 / trustee=400 / after=3**——⚠️ r2 次要 9：
   accel 不得 <1s，「回合消耗型复位」断言要在窗口内完成收推→发送→RPC→落盘）跑全链；断言 `trustees` 数组、
   徽标数据、R8 三格、复位/重连/弃局链、非法态实码（12001/12004/13005）；**`finally` 还原 env 并健康复验**
   （不还原 ⇒ 后片全跑短回合；新片按仓规追加在 CASES 末尾，slice-11 在其之前，还原+复验即够）；**两跑一致**。
5. **人工**：真浏览器/App 挂机体验。

## 六、边界与已知取舍

- 余额/结算不变（规则引擎 = 今日超时同强度）。房间类型统一。
- **不做**：DouZero 托管 · 断线感知专设机制 · timeoutCount 下发 · 管理端可调时长（env 仅测试） · 机器人治理。
- **显式接受的两格**：① game-service 不可达时 trustee-off 清除失败 ⇒ ack 可能带旧态（此时本就无对局推进，
  恢复后下次转移纠正）；② **交替 on/off 的合法 bump**（⚠️ r3 次要 8：no-op 只封同值）——任一玩家可高频制造
  转移 + 双推送、偶尔打断他人在途动作（13004→REFRESH_SNAPSHOT 是设计内的恢复路径）；上界 = WS 限流 20/5s，
  正常 UI 不会交替刷；**登记为已知面**，去抖留待将来（不在本片加复杂度）。
  （⚠️ r4 重要 5：原「重连在自己回合中段被代打一次」的接受格**已撤销**——由 R6 的按 count 基线重排化解。）
- 重启后 timer 重挂属既有边界，不扩面。

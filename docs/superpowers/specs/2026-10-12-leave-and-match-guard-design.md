# 「返回大厅」弃局出口 + 匹配守卫 设计 v1.3.1（冻结·勘误）

- 日期：2026-10-12
- 状态：**已冻结（v1.3.1 = v1.3 的文本勘误，无机制变更）—— 两轮对抗审闭环（一轮 2 阻断+4 重要 → v1.2；二轮无阻断、6 处文本级 → v1.3），可入规格** → **已实施（2026-10-12 收口：5 任务全过审 + T3 门审 Issue 闭环；计数回填见 `tools/conformance/baselines.json`（slice-05 64→68），验收记录见收口报告——A2/A4 机器证据在案；A1/A3 探针段经 T5-O1 闭环转绿（探针 `registerFresh` 未随 2026-10-11 登录分段去重迁移，非本片引入；修复 + 补跑 full 41/41、second-game 13/13 见收口报告），A1 另留用户端到端）**
- 主题：修「局中点返回大厅 → 在大厅挂着并可开第二局」。用户裁决：**K1=方案 A（进行中确认退出）**、**K2=加服务端匹配守卫**（方案 B 已否决）。

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-12 | 初稿：三阶段矩阵 + 12011 守卫 + 探针面登记 |
| v1.1 | 2026-10-12 | 吸收一轮对抗审：**B1** 补 `seatOwners` 清理（否则旧局推送继续直送）；**B2** 等待房范围收紧为「保持现状」（探针钉住的既有契约）；I1 守卫加 view-ended 放行步；I2 凭据清理加 roomCode 一致性；I3 客户端本地超时/12001 口径；I4 conformance 落点约束；M1-M7/O1-O7 全处置 |
| v1.2 | 2026-10-12 | 二轮自校：矩阵补 `view.state` 值域与 fail-open 边角；O4 实现次序钉死；12011 的客户端行为补 `game.vue` 分支 |
| v1.3 | 2026-10-12 | 吸收二轮复核（无阻断）：C7 三态改写（与 §3.2 清理闸一致）/ guard view 步缺失类错误口径（`isMissingGameError` ⇒ 12011）/ §5#11 登记 K3×K2 等待房交互 / N32 复现**零改动**（删除误判的改造指令）/ game.vue 分支「只导航不写 error + roomCode 守卫」/ conformance 第四条约束与探针描述改准 |
| v1.3.1 | 2026-10-12 | 终审批修（M4，文本级勘误）：§4 action-copy 例文去尾（「你还有未结束的对局或房间」，与落地文案 `action-copy.ts` 逐字一致）；§4 conformance 行「2 断言（C13）」改「4 checks（前提 1+断言 3）（C16）」（按规格 §2.10 / F11 口径） |

## §1 背景与问题（2026-10-12 用户实测）

1. **局中「返回大厅」只做导航**（`table.vue:600` `auth.navigate('lobby')`；`browser-e2e.mjs:547` 注释把它写成契约）——不发 `room.leave`、socket 不断；补推只在**新连接**时触发 ⇒ 「只有退出重登能回对局」。
2. **`room.match` 无「已在对局中」守卫** ⇒ 大厅里换玩法/底分匹配进**第二局**；旧局后台自动打完并**照常结算**（金币场双结算），且两局推送交错进同一份前端状态（上片设计 §6 #10 登记的「双坐局」被真实触发）。
3. **半堵还不够（一轮审查 B1）**：`room.leave` 只 `socket.leave(roomCode)`（退 io 房间）+ 清凭据；**per-seat 推送走内存表 `seatOwners` 直发 socket**（`ws.gateway.ts:1013-1015`），其唯一删除点在断线（`:476-478`）⇒ 即使确认退出，旧局（代打继续）的 `game.deal/state_update/current_turn` 仍持续直送同一 socket、客户端 `applySnapshot`（`stores/game.ts:547-570`）无 roomCode 校验 ⇒ 交错照旧。**本片必须一并补投递清理。**

## §2 用户裁决（2026-10-12）

- **K1**：交互=方案 A——**仅对局进行中**，「返回大厅」必须过确认；确认=发 `room.leave` 真弃局（系统代打打完；金币场按结果结算；期间不可回本局）。不确认=留在牌桌。
- **K2**：加服务端匹配守卫（拦 `room.match`；防多端/竞态/旧客户端）。
- **K3（一轮审查后的范围收紧）**：**等待房与已结算保持现状**——等待房「只导航、席位留存、开局自动拉回」是被探针钉住的既有契约（`browser-e2e.mjs` `createRoomAndJoin` ④→`waitFilledGame` 全链依赖），不在本片改动面。

## §3 核心语义

### 3.1 「返回大厅」行为矩阵（`table.vue` 顶栏按钮；实现判定次序**自下而上**，见 §3.4）

| 相位（判据） | 行为 |
|---|---|
| **已结算**：`view.state === 'ended'` | **现状**：只导航（放弃已结束的局无副作用；探针 `backToLobby`/`ensureGamePage` 在 ended 时使用该按钮，零弹窗） |
| **等待房 / fail-open 边角**：`view === null`（含 replayActiveGame fail-open 补 matched 后 view 拉不到的牌桌形态） | **现状**：只导航、席位留存（等待房契约；fail-open 边角借用同语义，登记 §5#7）。`到 table 的重新拉回` 由「开局 `room.matched` 直送已连 socket」或「刷新补推」承担 |
| **对局进行中**：`view.state ∈ {'init','bidding','playing'}`（`PlayerView.state` 完整值域四值，`views.ts:97`） | **本片新增**：确认弹窗 → 确认 ⇒ `room.leave`+投递清理（服务端，§3.2）⇒ ack 处理后进大厅；取消 ⇒ 留在牌桌 |

**确认弹窗文案（中文，逐字）**：「退出本局？本局将由系统自动打完（金币场按结果结算），期间无法回到本局。」

### 3.2 「确认退出」的服务端配套（`room.leave` 语义修订，两处）

1. **凭据清理加 roomCode 一致性（一轮审查 I2；二轮修正闸表述）**：**清理闸 = 「对应凭据不存在 **或** 凭据记录的 roomCode === 请求的 roomCode」⇒ 执行清理（`clearConnection` + `del match:pending`）**——凭据不存在时清理照常执行（幂等空操作）、不抛（既有用例 `message.router.test.ts:1092-1097` 钉住「无凭据前置 ⇒ `clearConnection` 被调」）；**凭据存在且 roomCode 不一致 ⇒ 不清凭据、仅 `socket.leave`**，仍返 `ok()`（保持「房间没了 leave 仍成功」契约，`message.router.test.ts:1212-1219`）。
2. **投递清理（一轮审查 B1，新增 `ws.gateway` 改动面）**：`handleLeave` 成功后经 RouterDeps 回调（与 `onSeatOwners` 对称的新回调 `onSeatLeft(roomCode, userId)`）令 gateway **删除该玩家在 `seatOwners` 中该房的全部登记** ⇒ 弃局者不再收到旧局 per-seat 推送（座位在 game-service 内照旧、代打继续；`finished/settlement` 走 io 房间广播，socket 已 leave ⇒ 本就不会到达）。**`onSeatLeft` 与凭据清理同闸**（一致性成立或凭据不存在时调用；不一致时不调）。等待房走同路径。

### 3.3 服务端匹配守卫（`handleMatch`）

- **位置**：封禁读点之后、一切队列探测（dup/开关/门槛）之前——拒绝信息优先于排队语义。**次序副作用登记**：在局+队列残票组合的返回码由 `12009` 变 `12011`（既有 suite 无此组合，§5#8）。
- **判据（两段）**：
  1. `resolveRecoverableRoom(userId)` 第一遍命中（`status ∈ {waiting, playing}`）——未命中 ⇒ 放行（无凭据/仓已回收/凭据指向 finished·cancelled ⇒ 「再来一局」与弃局后匹配天然畅通）；
  2. **仅当 `status === 'playing'` 再加一步**：`deps.game.view(roomCode, userId)`——**view 存在且 `state === 'ended'` ⇒ 放行**（一轮审查 I1：`updateStatus('finished')` 是 fire-and-forget，写丢失时不让玩家被守卫卡到房键 TTL 1h；也顺带覆盖「结算后立刻点再来一局」的写延迟窗）；**「缺失类错误」按 `isMissingGameError` 口径处理（二轮新3）：`ROOM_NOT_FOUND`/`NOT_IN_ROOM` ⇒ 视同 view 拿不到 ⇒ 不放行（12011）**——不得让它原样上抛成 12001（那会触发客户端 BACK_TO_LOBBY 静默踢回大厅，与 §5#9 的 fail-closed 预期相反）；**仅传输类故障 ⇒ 走通用失败面（C5）**。
- **拒绝**：`fail(12011, 'You are still in an active game')`（等待房/对局中共用；发起匹配时若 view 拉取异常沿既有失败面，见 C5）。
- **错误码**：新增 **`12011 ALREADY_IN_GAME`**（12010 已被 `ROOM_MODE_DISABLED` 占用，`errors.ts:41`）。`CLIENT_ACTION[12011] = TOAST`。
- **客户端对 12011 的行为**（一轮审查 M7；二轮新5 收紧）：`game.vue` 的 `match()` 非零分支对 12011 **只导航、不写 `error.value`**（防同句中文在 `.game__error` 与 SessionNotice **双呈现**）——文案**仅**经 TOAST 通道（`action-copy` 的 12011 条目）；导航前加 **`store.roomCode !== null` 守卫**（`canShowTable` 同族纪律：多端 B 端在补推到达前 store 尚空时，不得导航到空壳牌桌）。等待房与进行中命中者均满足该守卫、被送回牌桌；空壳不满足 ⇒ 仅 toast。
- **代价**：resolver 2–4 次 Redis 读（`reconnect.service.ts:113-129`）；playing 情形 +1 RPC（仅守卫命中时发生，非热路径）。

### 3.4 实现次序（一轮审查 O4，钉死防写反）

`handleBackToLobby()` 判定链：**先 `ended`（只导航）→ 再 `view === null`（只导航）→ 最后「进行中」（确认 + leave）**。任何重排都会把结算态/等待态拖进确认流。

### 3.5 与「对局存活即可回」的一致性

- 断线/刷新/杀进程拉回：不变（未 leave 即仍在局）。
- 确认退出 = 清凭据 ⇒ 补推不再拉回旧局（「无法回到本局」兑现）；`seatOwners` 清理 ⇒ 连推送也不再来（B1 修后）。
- 确认弹窗**出现时**刷新/杀进程：未确认即未 leave ⇒ 旧局仍「在局」⇒ 回来被拉回牌桌（一致：没确认就不算退出）。弹窗期间若去抖信号重放 `navigate('table')` 致页面重挂、弹窗消失而 leave 未发 ⇒ 等同「未确认」（O5 登记）。

## §4 改动面

| 面 | 文件 | 内容 |
|---|---|---|
| 客户端 | `pages/table/table.vue` | `onBackToLobby()`：§3.1 矩阵 + §3.4 次序；`uni.showModal` 确认；leave 经发送层（§5#4 的超时口径）；成功 ⇒ `store.reset()` + `auth.navigate('lobby')` |
| 客户端 | `pages/game/game.vue` | `match()` 非零分支：12011 ⇒ action-copy 文案 + `auth.navigate('table')`（§3.3） |
| 客户端 | `net/action-copy.ts` | 12011 中文文案（**中性款**，覆盖进行中与等待房两语境，如「你还有未结束的对局或房间」） |
| 协议 | `packages/protocol/src/errors.ts` | `ALREADY_IN_GAME = 12011` + `CLIENT_ACTION` TOAST 行 |
| 服务端 | `gateway/message.router.ts` | `handleMatch` 守卫（§3.3）；`handleLeave` 凭据一致性 + `onSeatLeft` 回调（§3.2） |
| 服务端 | `gateway/ws.gateway.ts` | 注册 `onSeatLeft`（清 `seatOwners` 中该房该人登记） |
| 文档 | `docs/client-protocol.md`（错误码表+处置行）、`docs/design.md` §11.2 错误码总表 | 12011 登记（**注意**：机械闸只覆盖 client-protocol.md + `errors.test.ts`；design.md §11.2 为人工同步——一轮审查 M1） |
| 文档 | 上片设计 `2026-10-12-reconnect-until-game-end-design.md:33/:96-101`（§1 与 §3.6 的「返回大厅只导航」登记）+ `scripts/browser-e2e.mjs:547` 同款注释 | 订正为「进行中需确认退出；等待/结算保持只导航」（**注**：`docs/design.md` 全文无「返回大厅」字样，一轮审查 M2 已核） |
| 测试 | `protocol/src/errors.test.ts`（SPEC_CODES 硬编码表 +12011）；`message.router.test.ts`（守卫顺序/两段判据/leave 一致性清理）；`ws.gateway.test.ts`（onSeatLeft 清 seatOwners）；客户端 `table-*.test.ts`（矩阵三相位 + 确认/取消/失败）；`apps/client/test/helpers/uni-stub.ts`（**需扩展 `showModal` 支持触发 success/fail 回调**——现 stub 只记账不回调，一轮审查 M6）；`action-copy` 文案断言 | 见 §6 |
| 探针 | `scripts/browser-e2e.mjs` | **`backToLobby`（:580-585）加确认弹窗处理**——真正处于 playing 相位的唯一调用点 = **`:1020`**（`waitFilledGame` 刚渲染 17 张后调用）⇒ 需确认处理 + 重看其后 `secondGameJudgment` 的前提；`ensureGamePage`（:669-675）现有调用点只到 **ended/waiting** 相位（加确认防御无妨，但描述按实况写）；**N32 受控复现（:540-578）零改动**（二轮新4 自证：该复现全程 CDP `$patch` 显式构造、处于 **ended** 相位、不点击按钮——K3 保持「ended = 只导航、不清 store」⇒ `:547` 注释所引行为仍然成立，仅措辞按 K3 微调）；`createRoomAndJoin` ④（:777，waiting 相位）**不受影响**（等待房保持现状） |
| conformance | `slice-05-reconnect.ts` | 增 4 checks（前提 1+断言 3）（C16）。**落点约束（一轮审查 I4 + 二轮新6）**：① 不得用 P0（C2 依赖其记录存活）；② 必须紧贴步骤 8（`advanceState` 全链）**之后**——否则行动者是已离场的 P1 会 12004 红；③ **断言前自证前提**：读 Redis room status=playing（或 view 非 ended），不满足即显式失败并提示环境（前段有 80s 睡眠窗，局可能在窗口内打完）；④ 「入队成功即 unmatch」的窗口口径写清（队列扫描 5s/匹配 30s 窗内可能被撮合，断言后即清理） |

## §5 边界与登记

| # | 事项 | 处置 |
|---|---|---|
| 1 | leave 失败/被拒 | 客户端**留守牌桌** + 提示「退出失败，请重试」；**不**降级为「导航即离开」（会重造「挂着」状态） |
| 2 | leave ack 丢失（一轮审查 I3） | 发送层对 leave **无安全时钟**（safetyTimer 只挂 CAS/快照类）⇒ 客户端**自备本地超时**（~5s Promise 竞速）：超时 ⇒ 留守+提示；迟到 ack 到达 ⇒ 若已在牌桌则忽略（口径写进测试）。**12001（房在读与写之间被删）⇒ 视为退出成功**（服务端凭据已清、CLIENT_ACTION 的 BACK_TO_LOBBY 会导航+reset）——不落留守分支 |
| 3 | 多端 | A 端退出后 B 端残影：B 端断线/刷新即回大厅；B 端再匹配被守卫挡并**自动导航回牌桌**（§3.3）；本片不做多端实时同步 |
| 4 | 旧客户端（不确认、直接导航） | 守卫兜底：12011 ⇒ 文案（未知码 TOAST 兜底）+ **刷新/重连补推拉回**（旧客户端没有 12011 的导航分支——措辞已按二轮新5 修正）；无静默双坐局（匹配路径） |
| 5 | 非匹配的双坐路径 | `room.leave(错房号)` 已由 §3.2-1 收窄；`handleJoin` 直入第二房（REST 占座→join）**仍无守卫** ⇒ 登记为**本片未堵死的残差**（K2 威胁面=匹配路径） |
| 6 | 金币场双结算 | 守卫堵死匹配路径后，残余来源=#3 多端与 #5 join 路径，登记 |
| 7 | fail-open 牌桌形态（playing + view null） | 走「等待房」行（只导航、席位留存）；refresh 补推可回；登记为边角 |
| 8 | 12009→12011 次序变更 | 在局+队列残票组合由 12009 变 12011（设计有意；既有 suite 无此组合，登记） |
| 9 | 守卫的残余窗口（一轮审查 I1 残余） | status 写丢失 **且** game 会话也已消失（view null）时，守卫 fail-closed 最长卡到房键 TTL（1h）；概率极低，登记；错误文案可后续加「若对局已结束请刷新」（本片不做） |
| 10 | 探针 `check ④`「房仍在列表」 | 新语义下仍绿但理由变了（空房仍在列表）——别记成不变式（一轮审查 O2） |
| 11 | **K3×K2 交互登记（二轮新1）** | 等待房在本片后**没有 in-app 退房通道**（确认退出仅进行中；K3 保持等待房只导航）：等待房玩家去大厅点开始游戏被 12011 + 回桌弹回；该房 20-30s 后自动补机器人开局（`rooms.autostart.ts:129-139`）把人拉进一局机器人局，要脱身须再走「确认退出」；房死/被回收则守卫自动解锁。时长上界=房自动开局或等待窗回收。12011 文案用中性款（见 §3.3 的 action-copy 条目）以免「对局未结束」在等待房语境下误导 |

## §6 判据

**服务端**

1. C1 凭据=playing 且 view 非 ended ⇒ `room.match` = `12011`（message 逐字）+ **未入队**（zscore 证）。
2. C2 凭据=waiting ⇒ `12011`（不调 `game.view`——以 mock 断言调用次数）。
3. C3 放行面：无凭据 / 凭据房 `finished`（或已回收）⇒ 入队成功（随后 unmatch 清理）。
4. C4 **view-ended 放行**（I1 修）：凭据=playing 但 `game.view` 返回 `ended` ⇒ 放行。
5. C5 读失败方向（三态，二轮新3）：resolver reject ⇒ 经既有通用 catch ⇒ `13001`（守卫新增的 fail-closed 点，断言之）；`game.view` **传输类** reject ⇒ 同上不伪装 12011；`game.view` 的**缺失类错误**（`ROOM_NOT_FOUND`/`NOT_IN_ROOM`，按 `isMissingGameError` 口径）⇒ 视同 view 拿不到 ⇒ **12011**（不得上抛成 12001）——三类各一条单测。
6. C6 次序：封禁 + 在局 ⇒ `11003`（封禁优先）。
7. C7 `room.leave` 一致性（三态，二轮新2 改写）：① 凭据 roomCode === 请求 ⇒ 两键清除 + `onSeatLeft` 被调（该房该人 `seatOwners` 全清）；② 凭据存在但 roomCode 不一致 ⇒ **凭据不动、`onSeatLeft` 不调**、仅 `socket.leave`、仍 `ok()`；③ **凭据不存在 ⇒ 清理照常执行（幂等空操作）、`onSeatLeft` 照常调用、不抛**（钉住既有用例 `message.router.test.ts:1092-1097`）。
8. C8 leave 清理的投递实证（B1 修）：leave 后旧局推 `game.state_update`**不得**到达该 socket（单测经 gateway 注入事件断言 emit 未发生）。

**客户端**

9. C9 进行中：点按 ⇒ 弹确认；取消 ⇒ 无 leave、无导航、仍在牌桌；确认 ⇒ 发 `room.leave {roomCode}`（信封逐字）⇒ ack 0 ⇒ `store.reset()` + `navigate('lobby')`。
10. C10 leave 非零（非 12001）⇒ 留守 + 提示；本地超时 ⇒ 留守 + 提示；**12001 ⇒ 视为成功**（离场 + store 由 CLIENT_ACTION 处置 reset）。
11. C11 等待房（view null）与 ended ⇒ **无弹窗**；ended 且**不发 leave**（只导航）；等待房按现状（只导航）——**不发 leave**（范围收紧后）。
12. C12 判决次序（§3.4）：构造 ended+view null 与进行中并存夹具，断言判定顺序（防写反）。
13. C13 `game.vue` 12011 分支（二轮新5 收紧）：**不写 `error.value`**（`.game__error` 行不出现——断言）；导航受 `store.roomCode !== null` 守卫（store 为空 ⇒ 不导航，只 toast）；文案仅经 TOAST。
14. C14 `errors.test.ts` SPEC_CODES / `protocol-doc-sync.test.ts`（client-protocol.md）对账绿；`action-copy` 有 12011 条目（中性款文案，含「未结束」语义而非仅「对局」一词，覆盖等待房语境）。

**探针/conformance**

15. C15 `browser-e2e.mjs`：`:1020` 调用点加确认处理 + 其后 `secondGameJudgment` 前提重看；`--scenario full` 与 N32 受控复现全绿（**N32 零改动**，仅 `:547` 注释按 K3 微调）；`createRoomAndJoin` 链零改动通过。
16. C16 conformance：在局中 `room.match` ⇒ `12011`；`room.leave`（正确房号）后 `room.match` ⇒ code 0 入队 ⇒ unmatch 收尾（落点按 §4 约束）。

## §7 明确不做

- 方案 B 的「返回牌局」常驻入口（已否决）。
- 匹配时「自动弃旧局」（隐式弃局涉资金，不做）。
- 等待房/结算态交互改动（K3 范围收紧）。
- `handleJoin` 的「已在局」守卫与多端实时同步（§5#3/#5 登记）。
- 守卫拒绝文案的「已结束请刷新」尾注（§5#9，留后续）。

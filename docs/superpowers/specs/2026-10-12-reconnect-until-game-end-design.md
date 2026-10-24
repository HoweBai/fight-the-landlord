# 断线恢复「对局存活即可回」设计 v1.3.3（冻结·勘误）

- 日期：2026-10-12
- 状态：**已冻结（v1.3.3 = v1.3 的文本勘误，无机制变更）—— 可入规格阶段** → **已实施（2026-10-12 收口：10 任务全过审；计数回填见 `docs/design.md` §6.6 与 `tools/conformance/baselines.json`，验收记录见收口报告）**
- 主题：优化断线重连 —— 玩家断线后，只要对局未结束，都能重连回到对局；重连时下发最新裁剪快照与其它玩家保持同步。

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-12 | 初稿。用户裁决：① 恢复门槛全面放开（含同页断网 >30s）② 结束态静默回大厅 |
| v1.1 | 2026-10-12 | 吸收一轮审查：存活谓词 resolver 取代「哈希优先」（修阻断）；客户端改动=仅自激守卫（用户裁决）；判据/负对照/文档面补强 |
| v1.2 | 2026-10-12 | 吸收二轮审查：**断点④「从未入房+票过期」真修**（`startRoom` 开局为人类座位写哈希）；resolver 写死读失败方向；调用点清点扩到 4 处（含 `forwardAction`）；守卫落点两处；判据 3/6 构造重写；机械判据精度修订 |
| v1.3 | 2026-10-12 | 吸收三轮审查（结论「冻结可入下一阶段」）：判据 6 注入时点改到 `startRoom` 之后；§6 #10 补失败方向登记；§9 补 `ReconnectModule` DI 半行 |
| v1.3.1 | 2026-10-12 | 规格审查勘误（文本级）：§3.1「解析失败」补入 **WRONGTYPE（毒键）** 归类（细化、非冲突）；§7 测试面存量块范围更正为 `:893-1071`（整块 6 条） |
| v1.3.2 | 2026-10-12 | 终审勘误：§6 #10 cancelled 失败方向细化（13009/13010 双形态） |
| v1.3.3 | 2026-10-12 | 下片（「『返回大厅』弃局出口 + 匹配守卫」）勘误：§1 陈旧哈希注与 §3.6 #1 的「返回大厅只导航」表述订正为「**进行中**=确认退出（`room.leave` 真弃局）；**等待/结算**=只导航」（文本级；本设计的机制与判据不变） |

## §1 背景与问题

用户需求：**玩家断线后，只要对局还未结束，都需要重连回到对局；重连时下发最新的状态和其它玩家保持同步。**

现状两条恢复路径的断点（均为代码事实，已逐条核对）：

| 路径 | 现状机制 | 断点 |
|---|---|---|
| 同页瞬断（socket.io 自动重连） | `game.reconnect` 五步判定（`message.router.ts:652-711`），第 ② 步按 **30 秒窗口**（`reconnect.service.ts:32`，起点=服务端观测到断线，§6.6.1） | 断网超 30 秒 → `13010` → BACK_TO_LOBBY → **清空牌桌回大厅** |
| 刷新 / 杀进程（冷启动） | 首次 `connect` 不发 `game.reconnect`（`reconnect-flow.test.ts` 钉死）；靠连接补推 `replayPendingMatch`（`ws.gateway.ts:421`）读 `match:pending`（TTL **300s，从开局算、不续期**，`rooms.start.ts:155-159`） | ① 已入房者离开超过 5 分钟（长局常态）无票；② 每次补回那次 `room.join` **兜底清票**（`message.router.ts:552-558`）⇒ 每局只有一次机会；③ waiting 房无票 ⇒ 好友房等人时刷新回不去；④ **从未入房**（匹配/占座后未 `room.join`，哈希从未写过）**且票过期** → 无任何凭据 |

补充事实（设计依据）：

- `reconnect:active` 哈希**不设 TTL**（`reconnect.service.ts:17-18`），现状只在 `room.join` 成功写入（`message.router.ts:548-550`），只在显式 `room.leave` 删除（`message.router.ts:605-613`）。席位在局中保留不动（`rooms.service.ts:283`）。
- 服务端超时代打（`game.service.ts:763`）与投递链路恢复（`restoreDelivery`，`ws.gateway.ts:546-555`）均与恢复窗口无关。
- **陈旧哈希是常态**：一局打完后哈希仍指向旧房（除非显式 leave，而「返回大厅」按钮**等待/结算**相位只导航、不发 leave，`table.vue`；**进行中**相位自 2026-10-12「『返回大厅』弃局出口」片起 = 确认退出，确认即 `room.leave` 真弃局——v1.3.3 勘误）——这决定了凭据解析不能「哈希优先」（见 §3.1）。
- `match:pending` 天然无陈旧性：每局 `startRoom` 新写、TTL 300s、`room.join`/`room.leave` 即清（`message.router.ts:558, 613`）。
- 凭据读取的**全部现有调用点**（本片收编对象）：`handleReconnect`（内联哈希+pending）、补推 `replayPendingMatch`（内联 pending）、`handleResync`（`findActiveRoom`，`:734`）、**`forwardAction`（`findActiveRoom`，`:757`——出牌/过牌/叫抢的服务端路由）**。

## §2 目标 / 非目标

**目标**

1. 恢复门槛从「记录在 30 秒窗口内」改为「**凭据存活 + 对局存活**」——两条路径统一。
2. 修掉 §1 四个断点；覆盖 waiting 房；顺带修掉存量自激循环（§5）。
3. 客户端改动限定为**一处自激守卫**（用户裁决，见 §5）；客户端其余零改动。

**非目标（明确不做）**

- 不做结算回放；冷启动对局已结束**不加任何提示**（用户裁决）。
- 不发新错误码、`CLIENT_ACTION` 表不动；`13010` 的**触发面**随窗口删除而收窄（§3.2，非语义变更）。
- 不做客户端本地持久化；不做托管 / AI 代打；不改 `match:pending` 写入与清票逻辑；不改服务端超时代打；不引入任何基于延时/时序的「稳定化」hack（§6 #2 说明）。

## §3 核心语义

### 3.1 凭据解析 resolver（一轮审查阻断项的修复）

新增**单一实现** `resolveRecoverableRoom(userId)`（落位：room-service `reconnect` 模块；**四处共用**：`handleReconnect`、补推 `replayActiveGame`、`handleResync`、`forwardAction`）：

- 候选顺序：**`[match:pending → reconnect:active 哈希]`**。
- **第一遍（存活谓词）**：依候选顺序，取第一个 `room:{code}.status ∈ {waiting, playing}` 的候选 ⇒ 命中（返回 `{roomCode, source, status}`）。
- **第二遍（存在性）**：都不存活 ⇒ 取第一个「房间键存在」（任意状态）的候选返回（`status` 为实际值）；都没有 ⇒ `null`。
- **解析失败**（JSON 损坏、字段缺失、**键类型损坏 WRONGTYPE（毒键）**）的候选**按缺席跳过**，不阻断其它候选。
- **读失败（连接级 Redis 异常）整场上抛**，保持既有失败方向：`handleReconnect` ⇒ 既有 13001/TOAST 原地（不新增行为）；补推外层 fail-open；`handleResync`/`forwardAction` 沿用各自既有错误面。**只有解析失败**（JSON 损坏、字段缺失、键类型损坏）**按缺席跳过**——两者不得混同（v1.3.1 勘误：WRONGTYPE 归「损坏」是对本条二分法的细化，与切片-12「毒键 ⇒ 降级」族同向）。

**为什么 pending 优先（而不是哈希优先）**：陈旧哈希是常态（§1），哈希优先会让「打完一局 → 再被匹配 → 在 `room.join` 前断线」的玩家被死房遮蔽、**静默丢局**（旧实现只读 pending 无此问题，属对片⑦ 修复的回退）。pending 每局新写、TTL 300s、join/leave 即清，天然无陈旧；哈希兜底「票已消费/已过期」场景。**两候选同时存活时取 pending** = 「最新一次开局结果」，为确定性口径（活 pending 只可能来自 join 之后的新匹配，因为 join 会清 pending——`message.router.ts:557-558`，故 pending 恒新于哈希）。

**为什么需要存活谓词**：仅调换顺序不够——哈希指向的旧房若仍存在（finished 未回收的 ≤60s 窗口、双坐局边角），须由谓词而非顺序排除。

**四处共用的语义**：`forwardAction` 一并收编（原 `findActiveRoom` 哈希优先）——动作路由与恢复对「玩家当前房间」给同一个答案；旧注释「玩家可能还没 room.join 就收到动作」由 pending 优先天然覆盖（比旧回退更直接）。双坐局的动作路由含义见 §6 #10。

### 3.2 判定从五步变四步（`handleReconnect`）

| 新顺序 | 判定 | 结果 |
|---|---|---|
| ① | `resolveRecoverableRoom` 返回 `null`（无任何可恢复凭据） | `13010` |
| ② | 拿到 roomCode 后取 `PlayerView`：view 存在且 `state === 'ended'` | `13005` |
| ③ | view 拿不到（null / `ROOM_NOT_FOUND`·`NOT_IN_ROOM` 翻译为 null）但**房间键存在** | `13009`（保持既有语义「可重试」；resolver 已持有 `status`，将来可细分，本片 parity 优先不细分） |
| ④ | 其余 → **当前版本全量裁剪快照 + 投递链路恢复**（原⑤，不变） | `code 0` |
| — | view 拿不到且房间键不存在（房被回收） | `13010` |

- 原第 ② 步（独立键消失或 `now - connectedAt > 30s` → `13010`）**整步删除**。
- 「**不删哈希字段**」的不变量保留；哈希记录形状不变（`socketId`/`roomCode`/`connectedAt`，后者仅诊断）。
- `13010` 触发面收窄为「没有任何可恢复凭据」，消息文案统一 "No recoverable game to reconnect to"（**玩家可见**：经 `session.ts` 的 `describeAction` 内插展示）。

### 3.3 结束态：静默（冷启动）/ 现状（同页）

- **冷启动路径**：补推发现无存活凭据、或对局 `ended`、或房态 finished/cancelled → **不推任何消息**，用户落在大厅（无提示）。
- **同页路径**：`13005`/`13010` 的既有 `CLIENT_ACTION` BACK_TO_LOBBY 处置（含既有提示）**逐字保留**（用户裁决「静默」的语境为冷启动回来；同页提示有解释价值——已向用户明示并选择保留现状）。

### 3.4 显式离开豁免（不变）

`room.leave` 仍清哈希 + pending（`message.router.ts:605-613` 不变）⇒ 主动离开者不被拉回；resolver 自然覆盖。

### 3.5 waiting 房覆盖（新增能力）

好友房 / 手动房等人中刷新或同页抖动 → resolver 命中（pending 或哈希，status=waiting）→ 补推 `room.matched` 回房（冷启动）；同页路径的 `13009` 由 §5 守卫收敛为静默（补推已拉回，不再有恢复动作）。

### 3.6 「异页拉起」行为登记（新行为的显式面）

新语义下，**任何**新连接（含大厅/历史/钱包页的 socket 抖动重连）都会被补推拉回牌桌，只要玩家在册且对局存活。三个形态一并登记为**符合「未结束就回」的预期行为**：

1. 局中点「返回大厅」后刷新/杀进程 → 被拉回牌桌（2026-10-12 勘误：自同日的「『返回大厅』弃局出口」片起，**进行中**相位 = 确认退出——**未确认**者不发 leave、刷新/杀进程仍被拉回；**确认**者 `room.leave` 真弃局、落入 §3.4 显式离开豁免，不再被拉回；**等待/结算**相位维持「只导航」）；
2. waiting 房点「返回大厅」后刷新/抖动 → 被拉回房间；
3. 在大厅/历史/钱包页浏览时 socket 重连 → 被 `room.matched` 拉起并跳转牌桌（`useGameSession.ts:183-190` 无页面守卫）。

## §4 服务端改动

### 4.1 连接补推泛化（`ws.gateway.ts`）

`replayPendingMatch` 改名 **`replayActiveGame`**：

- **凭据**：`resolveRecoverableRoom` 第一遍（**只认存活候选**）；无命中 → 静默。
- **分支**（保留既有判定 D 与顺序契约）：
  - `playing` → 先确认玩家在权威座位表（`room.players`，R128）→ 抓 view → **view.state === 'ended' ⇒ 静默（两支都不推，结束瞬间竞态）** → **先 emit `game.deal`(view)、再 `seatOwners.set`（seat = view.seat）** → emit `room.matched`（顺序不可反，v2.1 判据）；
    - view 拿不到（null / RPC 故障）但玩家在册 ⇒ **fail-open 只补 `room.matched`**（保留既有裁决 C；seat 从 `room.players` 解析，解析不出 ⇒ 跳过）；
    - 玩家不在册 ⇒ 跳过（不推）。
  - `waiting` → seat 从 `room.players` 解析（**解析不出 ⇒ 跳过**，两支统一守卫）→ `seatOwners.set` + emit `room.matched`。
  - finished/cancelled/房间不存在/无凭据 → 静默（不变）。
- **保留**：`activeConnections` 顶替校验（陈旧 socket 不推）；整体 fail-open 不得带崩连接生命周期。
- 日志行反映触发源（`record`/`ticket`）。

### 4.2 `reconnect.service.ts` 简化 + resolver 落位

- `touch()`：只写哈希（**五个写入时机**：**`startRoom` 开局（新增，§4.4）** / `room.join` 成功 / `game.reconnect` 成功 / 观测到 disconnect / 硬换手续期）；语义改为「**在线观测点刷新**」，`socketId`/`connectedAt` 仅诊断（`startRoom` 处 `socketId` 写空串）。
- `clearConnection()`：只删哈希。
- **退役**：`RECONNECT_WINDOW_MS`、`RECONNECT_TTL_SECONDS`、`reconnectKey()`、`validateReconnect()`、`RECONNECT_CLOCK` 时钟注入。
- **新增**：`resolveRecoverableRoom`（§3.1，`reconnect` 模块单一导出）；四处消费方全部改走它（含删掉 `message.router.findActiveRoom`）。

### 4.3 `handleReconnect`（`message.router.ts`）

按 §3.2 改写；其余（`isMissingGameError` 翻译、`onReconnected` 投递恢复、`lastVersion` 只写日志）逐字保留。

### 4.4 `rooms.start.ts`：开局为人类座位写哈希（断点④ 的修复）

`startRoom` 现有的 `match:pending` 写入循环（`:155-163`）**同循环内同时写 `reconnect:active` 哈希**（经 `ReconnectService`，不得手拼键/JSON）。

- **修掉断点④**：匹配/占座后从未 `room.join` 的玩家在票过期后仍可凭哈希回桌（否则 resolver 返回 null，静默丢局）。
- 副效果（正面）：每局开局刷新哈希 ⇒ 陈旧哈希在源头被覆盖，「双坐局」的凭据翻转点从自己的 join 提前到新局开局（登记 §6 #10）。
- 位置契约与 pending 相同（补位成功之后、两条 announce 与 `game.start` 之前）；写失败 ⇒ 与 pending 同款 log + `return false`。
- 机器人不写（沿用 `humanSeats` 谓词，R47）。

## §5 客户端：唯一改动 = 自激守卫（用户裁决）

**改动**：**快照类请求（`game.resync` / `game.reconnect`）自身收到 REFRESH_SNAPSHOT 类错误码（`13004`/`13007`/`13009`）时，不再触发新一轮 `game.resync` 派发**（防自激）。落点**两处**：

- `dispatchAck`（`socket.ts:1018`，匹配到在途请求的路径）——以 `isSnapshotRequest(request.type)` + 码白名单为条件；
- `handleAck`（`socket.ts:610`，**无匹配在途请求**的迟到 ack 路径）——`AckInput.type` 可知时同款门控；**type 未知时照常派发**（残余 ≤1 次，且其自身触发的 resync 拿到 13009 后会被本守卫拦下 ⇒ 自终止，不成风暴）。

- 修复对象：存量 bug —— waiting 房同页重连链路为 `game.reconnect → 13009 → resync → 13009 → resync …`（每轮 2 条 WS 消息，旧实现 30 秒窗口内同样存在；新语义下常驻），直到限流 `10006` 报错 toast。守卫拆除的是**循环起点**（首条 13009 来自 `game.reconnect` 的 ack，直接被拦下）。
- **负对照（必须钉）**：普通**动作请求**收到 `13004` → `game.resync` 的既有恢复通道**不受影响**（§6.5）；`13005`/`13010` 的 BACK_TO_LOBBY 派发也**不受影响**（导航语义，不在白名单）。
- 收敛后行为：waiting 房同页抖动 = 补推拉回房间 + `13009` 静默，无风暴、无报错。

其余客户端行为零改动（补推消费 → `room.matched` → 自动 `room.join` → 导航牌桌，`useGameSession.ts:183-189`；同页 ack 快照 + `socket_reconnect` 信号，`socket.ts:933-967`；`room.join` 幂等）。

## §6 边界与风险

| # | 事项 | 处置 |
|---|---|---|
| 1 | 双路并发（补推 + `game.reconnect` 同时触发）——**重复**（同 version） | 幂等，已证（§6.2 丢弃规则 + `room.join` 幂等） |
| 2 | 同上——**逆序**：补推抓取的快照（较旧）晚于 ack（较新）到达 ⇒ 客户端 M08 假回退（提示 + 多一次重连，自愈） | **登记为已知边界**（需两次 RPC 之间发生状态推进 + 逆序送达，概率低；自愈代价有界）。**不引入**延时/时序 hack；若日后实测频繁再议服务端硬化 |
| 3 | 硬网络中断（服务端未观测到断开，新连接先到） | 补推先于硬换手判定（现序保留）；凭据在 `room.join`/开局时即存在 ⇒ 比旧窗口方案更稳 |
| 4 | 陈旧哈希泛滥 | resolver 的**存活谓词**排除（§3.1）；§4.4 起每局开局覆盖刷新；补推/判定/resync/动作路由四处同源 |
| 5 | 两候选同时存活（真在局中又刚被匹配） | 取 pending（最新开局结果，确定性口径）；旧房席位由服务端现状（超时代打）继续，属既存行为 |
| 6 | 哈希字段无 TTL 兜底（孤儿字段） | 谓词下无读取副作用（死房被跳过）；不新增清理任务（YAGNI） |
| 7 | `match:pending` 清票（N34/R524）保留 | 原始职责不变；「二次刷新丢局」由哈希兜底接管 |
| 8 | 多端并发（≤5 连接/IP、硬换手强者胜） | 现状不动；两端各自被拉回（与「未结束就回」一致） |
| 9 | 房键 TTL 3600s 与会话 TTL 不同步（会话每步续期、房键开局后无续期） | 理论 >1h 长局出现「房没了但会话在」⇒ 谓词判死、静默。概率极低，登记 |
| 10 | 双坐局（局中 A + 被匹配进 B 且 B 已开局） | 既存前提（`room.match` 无「已在房」守卫，本片不修）：恢复与**动作路由**共用同一凭据解析 ⇒ 均以「最新开局结果」为准；§4.4 使翻转点从「B join」提前到「B 开局」。**失败方向**：§4.4 后凭据只指向最新局——若最新局死亡（cancelled/回收），玩家对仍在进行的旧局 A 的恢复与动作路由**不回退到 A**（A 不在候选中）：动作 ⇒ 12001/12004 ⇒ BACK_TO_LOBBY 从 A 的牌桌弹出；同页 `game.reconnect` ⇒ **cancelled 且房键未回收**（reaper 未跑）时实际为 `13009`（静默，用户停在死牌桌）；房键被回收才 `13010`（⇒ 回大厅）；两者皆为失败方向，触发需三重叠加（双坐局 + 最新局 cancelled + 未回收），接受；直到下次 join/leave/新开局刷新凭据 |
| 11 | waiting 房 + REST 占座但从未 WS 连接 | 无凭据（pending/哈希都未写）⇒ 不会被自动拉回；可经房号/房列表手动重进；局一旦开局由 §4.4 覆盖。登记 |

## §7 判据

**需求句 1「只要未结束都能回」**

1. 同页断网 >30s（实证跨过旧窗口，等 40s）重连 → `code 0` 快照、version = 服务端当前版本、牌桌恢复。
2. 入局后断开、**二次**冷启动连接（票已被首次补回清掉）→ 仍被补推拉回。
3. **从未入房 + 票失效**（断点④ 回归）：参与者经 REST 占座/匹配入座但**不建立 WS**（从未 `room.join`），直删其 `match:pending`（对读取方可观测差异为零 ⇒ 与 TTL 过期等价）→ 建连后必须被补推拉回（凭 §4.4 开局写的哈希；**本用例在 v1.1 前必红**）。
4. waiting 房冷启动 → 补推 `room.matched` 回房。
5. 负对照：显式 `room.leave` 后连接 → 不推、不拉回。
6. 负对照：**陈旧哈希 + 存活新局**：正常匹配成局**之后**，直 HSET 一条指向**已回收房间**的陈旧哈希（覆盖新局开局写入的记录）⇒ 建连 → 必须拉回**新局**（阻断项回归；直注入构造，不需打完一整局。⚠️ 注入必须在 `startRoom` **之后**——提前注入会被开局写入覆盖、判别力归零）。
7. 负对照：finished 未回收窗口内冷启动 → 静默（不推）。
8. 负对照（守卫）：动作请求收到 `13004` → `game.resync` **仍被发出**；快照类请求自身的 `13009` → **不再**发 resync（无风暴、无 `10006`）。

**需求句 2「下发最新状态」**

9. 恢复后快照 version === 服务端当前 version。
10. 投递链路恢复实证：恢复后用一次后续推送（超时自动动作的 `game.state_update` 到达该连接）证明 `socket.join` + `seatOwners` 已重登记。

**机械判据**

11. `RECONNECT_WINDOW_MS|RECONNECT_TTL_SECONDS|reconnectKey|validateReconnect|RECONNECT_CLOCK` 在 `packages/**/src` 0 命中。
12. **组合定位**（哈希+pending 的择优解析）只出现在 resolver；单源读取不受管辖——`handleJoin` 的座位兜底读取（`:540/:545`）与 `startRoom` 的写入循环（本片明示保留/迁移）不算第二份实现。
13. 客户端 diff **白名单** = 自激守卫（`socket.ts` 两处）+ 其测试；其余 `apps/client/src` 无 diff。

**测试面**

- 单测：`reconnect.service.test.ts`（窗口/TTL 用例 → resolver 用例：存活优先/存在性回退/损坏跳过/读失败上抛/双候选仲裁）；`ws.gateway.test.ts` 补推块扩展（record 源 × playing/waiting/ended/不在册/顶替）+ **存量块 `:893-1071`（整块 6 条，含引用 `reconnectKey`/注入时钟者）随 §4.2 改写**；`message.router.test.ts`（四步判定 + 阻断回归 + `forwardAction` 改走 resolver 的路由用例）；`rooms.start` 测试（开局写哈希：人类座位写/机器人不写/写失败 return false）；客户端守卫单测（两处落点 + 负对照）。
- conformance `slice-05`（29 项）窗口类断言改写为存活类；新增 §7 的 1/2/3/4/5/6/8/10（含一次 ≥40s 等待，预估 +1~2 分钟；3/6 用直删/直注入构造，不等 300s）。
- `slice-12`（竞态补推）全量复跑 + 新增「陈旧哈希版竞态」用例（§7-6）。

## §8 文档与一致性影响

| 文件 | 改动 |
|---|---|
| `docs/design.md` §6.6（:1011-1025） | 去「窗口 30 秒 / TTL 35 秒」；判定图/条文改存活语义；`13010` 触发面句；§6.6 头 `[已实现]`（:1012）计数随实现漂移回填 |
| §6.6.1（:1027-1057） | 五步 → 四步；「窗口起点与刷新时机」→「记录写入时机（在线观测点，五时机含 startRoom）」；:1057 已知边界段（窗口起算）整段作废重写 |
| §6.3 行（:910） | `game.reconnect` 的「无记录则 13010」→ 补「房被回收亦 13010」 |
| §6.6.1 附近（§8.2 相关行） | 若提及「匹配路径写 pending」的表述，补「开局同时写重连记录」一句 |
| §10.1（:1546 一带） | `reconnect:active`：删独立键/TTL 列述与 C12 注；写入者描述补 startRoom |
| §10.4（:1578） | 「重连记录 35s」行 → 「无 TTL（显式离开清理）」 |
| §11.2（:1642） | `13010` 描述「不存在或**已过期**」→ 「没有任何可恢复凭据（含房间已回收）」 |
| `docs/client-protocol.md` | `13010` 行描述；**「处置例外」补一行**：快照类请求自身的 13004/13007/13009 不触发 resync（自激守卫）；全仓扫「30 秒/35 秒」重连表述（含 :299 表） |
| 本设计 | 冻结后随实现回填 `[已实现]` |

注：`apps/client/test/protocol-doc-sync.test.ts` 只对码值存在性对账、不对描述文本 —— 改描述无连带。

## §9 交付物清单

| 文件 | 动作 |
|---|---|
| `packages/room-service/src/reconnect/`（`reconnect.service.ts` + resolver 落位） | 简化 + 新增 `resolveRecoverableRoom` |
| `packages/room-service/src/gateway/ws.gateway.ts` | `replayActiveGame` 泛化 |
| `packages/room-service/src/gateway/message.router.ts` | 四步判定 + 四处（含 `handleResync`/`forwardAction`）改走 resolver、`findActiveRoom` 删除 |
| `packages/room-service/src/rooms/rooms.start.ts` | 开局为人类座位写哈希（§4.4）；`rooms/start.module.ts` 的 imports 补 `ReconnectModule`（叶子依赖，无 CJS 环） |
| `apps/client/src/net/socket.ts` | 自激守卫（两处落点，唯一客户端改动） |
| 测试（§7 测试面） | 改写 + 新增（含存量块改写与 rooms.start 用例） |
| `tools/conformance/src/slices/slice-05-reconnect.ts`、`slice-12-manual-join.ts` | 改写 + 新增实证 |
| `docs/design.md`、`docs/client-protocol.md` | §8 表逐行 |

## 附：关键代码位置（审查用）

- 判定与窗口：`packages/room-service/src/reconnect/reconnect.service.ts:17-149`
- `handleReconnect`：`packages/room-service/src/gateway/message.router.ts:652-711`；`handleJoin` 清票：`552-558`；`handleLeave`：`605-613`；`handleResync`：`733-740`；**`forwardAction`：`750-762`**；`findActiveRoom`：`768-779`
- 开局写入：`packages/room-service/src/rooms/rooms.start.ts:127-163`
- 补推：`packages/room-service/src/gateway/ws.gateway.ts:393-469`；断线：`471-513`；投递恢复：`546-555`；连接入口：`300-390`
- 客户端：`socket.ts:933-967`（同页恢复）、`useGameSession.ts:183-190`（补推消费）、`socket.ts:1017-1021`（`dispatchAck` 派发——守卫落点 ①）、`socket.ts:603-612`（`handleAck`——守卫落点 ②）、`session.ts:204-250`（`CLIENT_ACTION` 执行器）
- 权威条款：`docs/design.md` §6.6 / §6.6.1 / §10.1 / §10.4 / §11.2

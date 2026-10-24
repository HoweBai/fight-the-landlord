# 斗地主平台 · 手动房间自动开局（设计规格 / spec）

> **日期**：2026-09-22 · **状态**：设计规格 **v2 → 已实施完成**（实施记录见 §9.2 / §9.3）
> **前置**：**片④（手动进房修复）已合入 `master`** —— `a0ca087`（客户端补 REST 占座 + F7）· `f5af075`（conformance slice-12）· `9e9df3f` / `a27e1a4`（探针）。
> **上游**：
> - `docs/superpowers/specs/2026-09-22-manual-join-repair-design.md` §6.1 / §8.1（**本片的直接入口** —— 上一片把「手动房间开不了局」显式登记为未覆盖，并把四个裁决点列好了）
> - `docs/design.md` §3.1（`Room`）/ §8.2–8.4（匹配与机器人补位）/ §9.6（机器人条约）/ §4.2–4.3（`game.start` 与降级）
> **归属**：本片的**设计真源**。实施计划另出。
> **触发**：片④ 修完入座之后，手动房间能进人、能拉人、列表正确，但**牌局永远不开始**（`game.start` 全仓只有匹配流程会调）。
> **裁决（2026-09-22，用户）**：
> 1. **房间满即开局**；
> 2. **人数不足 ⇒ 等 20 秒，然后在随后的 10 秒内随机一个时刻补机器人**（⇒ 补位时刻落在 **[20, 30] 秒**，见 §3.1）；
> 3. **退房腾座位**跟着本片做（否则会引入一种新的卡死，见 §1.2 H2）。

---

## 0. 现状复核（**本片起草时逐条回核**）

### 0.1 「开不了局」的确切形状

| 事实 | 位置 |
|---|---|
| `game.start` 全仓**只有一处**调用者 —— 匹配流程 | `match/match.service.ts`（`processQueue` → `startGame`） |
| 匹配流程由 **5 秒**的扫描循环驱动 | `match.service.ts:95`（`MATCH_SCAN_INTERVAL_MS ?? 5000`）+ `:180` |
| 房间回收任务由 **60 秒**循环驱动，且只处理 `finished`/`cancelled`/`waiting` 过期 | `rooms.reaper.ts`（`REAP_INTERVAL_MS ?? 60_000`）+ `rooms.timeout.ts` |
| 手动房间**没有任何扫描者**（匹配模块只读自己的 ZSet） | 片④ §1.2 H3′ 实测 |

⇒ 手动房间坐满 3 人之后，**没有任何一方会调 `game.start`**。

### 0.2 可以复用的一切（**新逻辑应当尽量少**）

| 能力 | 现成实现 | 手动房间能否直接用 |
|---|---|---|
| 机器人申请（按座位） | `MatchService.acquireBot`（`robot.acquire` RPC，幂等由机器人池保证 R201） | ✅ **随 `RoomStartService` 一起搬过去**（`acquireBot` 与 `addBot` / `writeBotBindings` 本来就必须连用，分开反而容易漏 —— 见 §2.2 与 §3.2） |
| 机器人原子占座 | `RoomsService.addBot`（`claimSeat(isRobot: true)`） | ✅ 同一入口 |
| `seat → botId` 绑定落盘 | `writeBotBindings` → `room:{code}:bots`（局终 `robot.release` 的唯一来源） | ✅ 必须一起做，否则机器人永不释放 |
| **通知玩家「开局了」** | `MatchService.announceMatch` → Redis 频道 → `WsGateway` → 客户端 `room.matched` | ✅ **关键**：客户端收到 `room.matched` 就 `joinMatchedRoom()`（`room.join` 挂载）⇒ **自动进牌桌 + 收 `game.deal`** ⇒ **本片客户端零改动**（该函数原样搬进 `RoomStartService`，见 §2.2） |
| 开局本身 | `game.start`（幂等：同 `roomCode` 复用会话，R210） | ✅ |
| 标记房间已开局 | `RoomsService.updateStatus(code, 'playing')` | ✅ 但**必须重排到「开局成功之后」**（见 §1.2 H1） |

### 0.3 一处必须点名的既有边界（**本片要碰它**）

`match.service.ts` 在 `playing` 写入点上方逐字登记过一条已知边界：

> `startGame` **自己吞掉** RPC 失败（catch 只记日志、不重抛）⇒ 调用方**分不出**「开局成功」与「两次都失败」——
> 后者也会被写成 `playing`。§4.3 原本的降级（房间 `cancelled` + 通知玩家）在 `game.start` 这条路径上**当前并不存在**。

它在匹配路径上是一个**悬着的已知问题**（已裁「本仓不实现」，见台账 N36）。但**手动房间不能沿用它**，理由在 §1.2 H1。

---

## 1. 裁决、设计期自审与全局约束

### 1.1 裁决表

| # | 裁决 | 性质 |
|---|---|---|
| **R901** | **触发方式 = 服务端扫描**（照 `match.service` 的 5s 循环 + `RoomsReaperTask` 的 `OnModuleInit` 成例），**不做**每房间定时器、**不做**「建房时挂一个 setTimeout」 | 结构性（见 §1.2 H3） |
| **R902** | **房间满 3 人 ⇒ 立即开局**：由**最后一个入座者**（`room.join` 成功路径）**同步触发一次**，且**同时**由扫描器兜底 | 用户裁决 1 + 幂等兜底 |
| **R903** | **人数不足 ⇒ 补位死线 = 占用变化 + `20s + rand[0,10s)` ⇒ 落在 [20,30] 秒**；扫到「已越死线」即补机器人到 3 人再开局。补位复用 `acquireBot` / `addBot` / `writeBotBindings`（**不新造**）；失败则本轮放弃、**下个扫描周期重试** | 用户裁决 2 |
| **R904** | ⚠️ **窗口以「占用变化」为原点**：补位死线 = **「创建时刻 或 最后一次有人入座/退座的时刻」+ `20s + rand[0,10s)`**。即**占用变化要重新抽一次**（否则房主建完房、挑了半天玩法，窗口已经跑掉一大半） | 见 §1.2 H4 |
| **R904b** | 🔴 **补位死线必须写进 Redis 的派生键**（`room:{code}:fillat`，TTL 跟房间的 3600s）—— **不是**每次扫描现抽：现抽会让「同一个房间每一轮抽到不同的死线」⇒ 不但行为非确定，判据也无法可判（本仓为「不可判的判据」付过代价）。⚠️ **哈希字段集恰好七个（§10.1）不得加字段** ⇒ 走派生键（与 `seats` / `cardcount` 同形；`deleteRoom` 已同时删这三个键，回收到时一起走） | 可判性 |
| **R905** | ⚠️ **`startGame` 必须把成败返回给调用方**（`Promise<boolean>`）。**手动路径**：失败 ⇒ **不写 `playing`**、房间留在 `waiting` ⇒ 下个周期重试 ⇒ 最坏由回收任务按 §3.1 删房（终局干净）。**匹配路径**：调用方**忽略返回值**，现状一字不变（那条已裁「本仓不实现」，见台账 N36） | 见 §1.2 H1 |
| **R906** | ⚠️ **退房必须腾座位**：新增 `leaveSeat`（对称于 `claimSeat`），`room.leave` 成功路径调用它；**并且**同样重置等待窗口（§R904 的同一处收口） | 用户裁决 4 + §1.2 H2 |
| **R907** | **通知玩家一律走 `room.matched`**（`announceMatch` 的既有 Redis 频道），**不新增消息、不碰协议**（`packages/protocol` 零改动） | 客户端零改动的**前提** |
| **R908** | **客户端零改动**。手动房间开局后，客户端收到 `room.matched` ⇒ `joinMatchedRoom()`（`room.join` 挂载，玩家已在 `room.players` 里 ⇒ 不会被 12004 拒）⇒ `game.deal`。⚠️ **不得**因此给 `joinMatchedRoom` 补 REST 占座（房间此刻已是 `playing` ⇒ REST 会回 `12008`，见片④ §1.2 H2） | 范围 |
| **R909** | **`playing` 的写入点仍只有一个**（手动与匹配共用同一个服务方法），且**必须在 `game.start` 成功之后** | 不变量的**保持** |
| **R910** | **机器人绑定的 `isRobot` 不得出站**：`RoomPlayer.id` 走既有掩码（§9.8 / R48），`room.matched` 的载荷与匹配路径**逐字同形** | 既有纪律 |
| **R911** | 本片**不碰协议**（同片④ R813）；**不新增错误码** | 批级约束 |
| **R912** | **判据只增不减**：片② 的 8 文件 67 基线逐文件核（片④ 后为 ≥ 67）；conformance `slice-12` 的第 9 步（`坐满仍 waiting`）**本片之后应当改判**（见 §6.2） | 全局约束 3 |
| **R913** | 🔴 **手动房间的回收窗口抬到 40 秒**（`WAITING_TIMEOUT_MS` 保持 30s 让**匹配路径**不受影响；手动房间改用 `MANUAL_ROOM_TIMEOUT_MS = 40_000`）。理由：补位死线上界是 30s，只留 0 秒给「补位 + `game.start`」会**贴脸**（加载一慢就补不上）。⇒ 两者之间**恒有 ≥10 秒**的安全间隔 | 见 §3.1 |
| **R914** | **随机源与时钟必须可注入**（照 `MatchService.setClock()` 的成例）—— 否则「20–30 秒之间的某个点」这条**判不了**（判据要么恒真、要么 flaky） | 可判性 |
| **R915** | 🔴 **`playing` 的写入点与「补位 + 开局」抽成独立服务**（`RoomStartService`，落在**新模块** `StartModule`）：`MatchService` 改为**注入它**。⚠️ **不得**把新扫描器放进 `RoomsModule` 又去注入 `MatchService` —— 那会与既有的 `MatchModule → RoomsModule` **成环**（`match.module.ts:2/11` 实测） | 见 §2.2（复核查出） |
| **R916** | ⚠️ **`leaveSeat` 只在 `status === 'waiting'` 时腾座位**：`playing`/`finished` 的对局里，玩家退出**不得**动座位 —— 座位的真源是对局，动它会让 `game-service` 的座位映射与 `room.players` 分叉（R124 的形态） | 见 §1.2 H7 |

### 1.2 设计期自审（**起草 6 条 + 复核 2 条，共 8 条，全是硬错**）

> 方法照片② §1.2 / 片③ §1.2 / 片④ §1.2：**不审设计意图，审「我凭什么这么说」**。
> ⚠️ **复核轮**（用户「复核」之后）又查出 **H7/H8** —— 两条都是「**我没看一眼就断言某处的行为**」：
> H7 是 `room.leave` 被两种离开语义共用（对局中腾座位会造出座位分叉），
> H8 是既有的模块依赖方向（新扫描器放错模块会成环）。
> ⇒ 与片③ H2/H7、片④ H4/H5 同族：**改动的影响面要按特征搜，不能按印象推**。

| # | 问题 | 处置 |
|---|---|---|
| **H1** | 🔴🔴 **照抄匹配路径的 `startGame` ⇒ 会造出「卡在 `playing` 且没有会话」的房间**：`startGame` 吞掉失败、`playing` 照样写入，而 **`playing` 是唯一逃离回收任务的状态**（`isWaitingExpired` 明文「`playing` 即使 `timeoutAt` 已过也不得回收」）⇒ 一次 `game.start` 失败 = **3 个玩家对着空牌桌，房间要等 1 小时 TTL**。比片④ 修掉的空房间更糟 | **R905**（返回成败 + 手动路径不写 `playing`） |
| **H2** | 🔴 **「满即开局」+「不足补机器人」会让退房变成新的卡死**：`room.leave` 现在**不动座位**（只 `socket.leave` + 清重连/票据），而 MVP **没有踢人**（`12005` 在错误码表里但没有实现）。⇒ 甲建房、乙丙进来又走了 ⇒ 房间**永远显示 3/3**：满分支不触发（人早走了）、不足分支也不触发（座位数说满了）⇒ **亲手造出一种比原来更难查的卡死** | **R906**（`leaveSeat`） |
| **H3** | **触发方式**：每房间 `setTimeout` 会在**进程重启**时静默丢失（房间卡死）且与既有两条扫描循环形成第三套调度。⇒ 扫描器（R901）是唯一与既有形态一致、且崩溃可恢复的选择（重启后下一轮就捡起来） | **R901** |
| **H4** | **窗口从哪一刻起算**：现在的 `timeoutAt` 在 `create()` 时定死。房主建完房、切个屏、想两秒，窗口已经开始跑 ⇒ 「等人」的窗口与「建房」的时刻**不是同一件事**。⇒ 占用变化时**重新抽一次死线**并重写两个时刻（R904） | **R904** |
| **H5** | 🔴 **「随机时刻」若每轮现抽 ⇒ 行为非确定、判据不可判**：扫描器每 5 秒一轮，若每轮都 `random()` 一次，同一个房间的死线会**漂移**（玩家等多久取决于它被扫到几次 —— 这与「等 20 秒后随机」是两件事）。⇒ 死线**抽一次就写进 Redis**（R904b），且随机源**可注入**（R914） | **R904b / R914** |
| **H6** | 🔴 **回收窗口没跟着改会「贴脸」**：补位死线上界 30s，而 `WAITING_TIMEOUT_MS` 也是 30s ⇒ 死线取到 30s 附近的那批房间会在**正要补位时被回收任务删掉**（实测：回收任务按 `isWaitingExpired` 无条件删，不检查「是不是正要补位」）。⇒ 手动房间的回收窗口抬到 **40s**（R913），两值同文件、硬不变量 `>` 写进注释 | **R913** |
| **H7** | 🔴 **`room.leave` 是「两种离开」共用的**：它在 `waiting` 房里是「我不等了」（该腾座位），在 `playing` 房里是「我不玩了」（**不得**动座位 —— 座位的真源是对局，动它会让 `game-service` 的座位映射与 `room.players` 分叉，正是 R124 亲口警告的那种漂移）。原稿写「`room.leave` 成功路径调用 `leaveSeat`」**没写这个条件** ⇒ 实施时会照着把对局中的座位也腾掉 | **R916** |
| **H8** | 🔴 **新扫描器会与既有模块成环**：`MatchModule → RoomsModule` 已存在（`MatchService` 注入 `RoomsService`），而新扫描器需要 `MatchService` 的 `acquireBot` ⇒ 放 `RoomsModule` 就是反向依赖、Nest 报循环。**必须在设计期定好落点**，否则实施到一半才发现要重构模块 | **R915**（`RoomStartService` + `StartModule`） |

> **★ H1 与 H2 是同一个形态**：**「新链路沿用了旧链路里一条被默许的缺陷 / 省略」**。
> 匹配路径可以容忍「开局失败也写 playing」（它有自己的重试与机器人回退兜着，且已登记为已知边界），
> 但手动房间**没有**那层兜底 ⇒ 同样一行代码搬过来，后果完全不同。
> ⇒ 教训：**复用要连前提一起审**，不能只搬调用顺序。

### 1.3 全局约束（**不许破的既有纪律**，适用于本片每一个 Task）

> 逐条沿用片① §1.4（R723）/ 片②（R743）/ 片③（R756）/ 片④（R801 起），本片无改写。

1. **范围 = H5 + App**（R701）。小程序端排除在一切设计/开发/测试之外。
2. **锚点**：9 个探针 class。本片**第三次**动探针 ⇒ 改动必须成对（§6.3）。
3. **判据只增不减**：见 **R912**。
4. **样式只用令牌**（`$ftl-*`）；单位 `px`；发丝线 `$ftl-hairline`。
5. **`uni.xxx()` 必须是直接成员调用**；不得用 `document` / `window` / `fetch`；不得 `typeof import.meta`。
6. **scoped 样式只到子组件根节点**。
7. **模板注释只能放单根元素内部**。
8. **`mount()` 看不见样式** ⇒ 观感类改动只能用产物 CSS / 真浏览器走查证明。
9. **门禁口径**：`turbo run build --force` 对 client 只出 h5 ⇒ App 必须单独跑 `build:app`；探针**独占**跑。
10. **证据卫生（R682）**：门禁日志的 mtime 必须晚于最后一次改动/commit。
11. **提交**：每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。**禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

---

## 2. 架构（新增什么、复用什么）

### 2.1 一条链，两个触发器

```
                    ┌── 触发器 A：最后一个入座者（room.join 成功路径，同步）
房间满 3 人 ────────┤                                                      ┐
                    └── 触发器 B：扫描器兜底（每 5s 扫 waiting 房间）        ├─→ startRoom()（共用）
                                                                           ┘
人数不足 + 越过补位死线（20–30s 随机）──→ 扫描器 ──→ 补机器人到 3 人 ──→ startRoom()（同一个）
```

### 2.2 新增件（**尽量薄**，且**不得造出模块环**）

🔴 **先看这条约束**（复核查出，会直接绊住实施）：

```
现状：MatchModule → RoomsModule（MatchService 注入 RoomsService，match.module.ts:2/11）
⇒ 若把「自动开局扫描器」放进 **RoomsModule** 且要 MatchService 的 acquireBot，
   就变成 RoomsModule → MatchModule —— 与上面那条**成环**（Nest 会报循环依赖）。
```

⇒ 处置：**把「补位 + 开局 + 通知」抽成一个不依赖匹配的独立服务**，两条路径都调它。落点如下（`MatchService` 的依赖面已核实：只要 `RoomsService` / `writeBotBindings` / `GameClient` / `RobotClient`，**不要** `MatchModule` 里的别的东西）：

| 件 | 落点 | 职责 |
|---|---|---|
| `RoomStartService`（新） | `rooms/rooms.start.ts`（模块：新建 `StartModule`，imports `RoomsModule` + `RpcClientsModule`） | `startRoom(code)`：补机器人（如需）→ `game.start` → **成功才** `updateStatus('playing')` → 通知 |
| `MatchNotifier`（新，可并入上者） | 同上 | `announce(roomCode, seats)`：把既有的 `announceMatch`（`match.service.ts:387`）**原样搬过来**（它只依赖 redis，是这堆里依赖最轻的） |
| `RoomsAutostartTask`（新） | 同上（`OnModuleInit` 起 5s 循环） | 扫 `waiting` 房间 → 满则开局 / 越死线则补位开局 |
| `rooms/rooms.fill.ts`（新，纯函数） | 无模块 | `shouldFill(room, now, fillAt)` / `isFull(room)` —— 判据的单一真源（与 `rooms.timeout.ts` 同形） |
| `rooms.seats.ts` 的 `leaveSeat`（新函数） | 无模块 | 腾座位（对称于 `claimSeat`） |
| `MatchService` | **改为注入 `RoomStartService`** | 匹配路径的「补位 + 开局」改为调它（`playing` 的写入点**因此只剩一处** —— 正好落成 R909）；`MatchService` **保留** `match:pending` / 队列 / 扫描器这些**匹配专属**职责 |

⚠️ **R909 因此有了具体的落点**：`playing` 的唯一写入点在 `RoomStartService.startRoom()` 里，
两条路径都从那里经过 ⇒ 「唯一写入点」从一条**注释里的约定**变成了**结构上的事实**。

### 2.3 不新增件

- **不新增消息**（复用 `room.matched`）—— R907
- **不新增错误码** —— R911
- **客户端零改动** —— R908

---

## 3. 服务端设计

### 3.1 等待窗口与补位死线（R903 / R904 / R904b / R913 / R914）

`rooms.timeout.ts` 新增（**与两个既有 30s 明写「同值不同物」**，照该文件的既有纪律）：

```ts
/**
 * §3.1 的**手动房间**等待窗口：房主建完房、等朋友进来最多等多久。
 *
 * ⚠️ **与 `WAITING_TIMEOUT_MS` / `BOT_FILL_WAIT_MS` 同值但不同物**：
 *  - `WAITING_TIMEOUT_MS`：**匹配路径**的房间在 `waiting` 最多待多久（消费者：回收任务 ⇒ **删房**）；
 *  - `BOT_FILL_WAIT_MS`：匹配**队列**等人等多久后补机器人（消费者：匹配扫描器）；
 *  - 本组常量：**手动房间**等人等多久后补机器人（消费者：**自动开局扫描器**）。
 * ⇒ 三者**不得互相 import**。
 */

/** 先等这么久（用户裁决：等 20 秒）。 */
export const MANUAL_FILL_MIN_WAIT_MS = 20_000;
/** 在这段窗口内**均匀随机**一个时刻补位（用户裁决：随后的 10 秒内）。 */
export const MANUAL_FILL_SPREAD_MS = 10_000;
/** 补位死线的上界（= 20 + 10）——**给安全间隔与判据用的**，不是「等待时长」。 */
export const MANUAL_FILL_MAX_WAIT_MS = MANUAL_FILL_MIN_WAIT_MS + MANUAL_FILL_SPREAD_MS;

/**
 * 🔴 **手动房间的回收窗口**（R913）：比补位死线上界**多 10 秒**。
 *
 * 补位死线落在 [20s, 30s]，而「补位 + `game.start`」还要花时间 ⇒ 若回收窗口也是 30s，
 * 死线取到 30s 附近的那一批房间会在**正要补位时被回收任务删掉**（贴脸）。
 * ⇒ 40s：两者之间**恒有 ≥10 秒**的安全间隔（补位 3 个 RPC + `game.start` 重试 1 次，够用）。
 */
export const MANUAL_ROOM_TIMEOUT_MS = MANUAL_FILL_MAX_WAIT_MS + 10_000;

/** 抽一次手动房间的补位死线（**可注入随机源**，R914 —— 否则这条判不了）。 */
export const manualFillDeadlineAt = (now: number, random: () => number): number =>
  now + MANUAL_FILL_MIN_WAIT_MS + Math.floor(random() * MANUAL_FILL_SPREAD_MS);
```

⚠️ **`timeoutAt` 复用同一个 Hash 字段**（**不新增字段**：§10.1 的字段集恰好七个，加字段要动元数据契约），但**只保留「回收」语义**；补位死线走**派生键** `room:{code}:fillat`（R904b）。

| 时机 | 谁写 | 写什么 |
|---|---|---|
| `create()` | `RoomsService.create` | `timeoutAt = now + 回收窗口`；**手动房间**还要写 `fillat = manualFillDeadlineAt(now, random)` |
| 有人**入座**（`room.join` 成功） | `message.router.ts` 的 `handleJoin` | **只在 `status === 'waiting'` 时**重写两者（`playing` 的 `timeoutAt` 归零是 §3.1 的既有纪律，不得复活） |
| 有人**退座**（`room.leave` 成功） | `handleLeave` | 同上 |

⚠️ **`create()` 被两条路径共用**（`POST /api/rooms` 与匹配的 `createGameRoom` 都调它）⇒
**回收窗口必须是入参**（形如 `create({ mode, timeoutMs })`，缺省 = `WAITING_TIMEOUT_MS` 保持匹配路径现状），
**不能**在 `create()` 里写死 40s。同理 **`fillat` 只有手动房间写**（匹配房间不补位 —— 它自己那条链在 `match.service` 里）。

⇒ **不变量**：`waiting` 房间的 `fillat` 与 `timeoutAt` **恒等于「最后一次占用变化 + [20,30]s / +40s」**，且 `fillat < timeoutAt` **恒成立**（≥10 秒间隔）。

**时间线（单人建房）**：

```
t=0    建房（writeMeta：timeoutAt=+40s）            占用变化 ⇒ 抽死线 fillat ∈ [20,30]s
t∈[20,30]  扫描器（每 5s 一轮）看到 now ≥ fillat ⇒ 补 2 个机器人 ⇒ game.start
            ├ 成功 ⇒ playing + room.matched ⇒ 客户端自动进房 ⇒ game.deal
            └ 失败 ⇒ 留 waiting ⇒ 下轮重试（重试窗口 ≈ 10s+，仍够）
t=40   若始终没开成 ⇒ 回收任务删房（三个键一起）
```

### 3.2 补机器人（R903）

**逐字复用匹配路径的三步**（`acquireBot` → `addBot` → `writeBotBindings` —— 这三步**整体搬进 `RoomStartService`**，见 §2.2 / R915），**座位号取服务端权威值**（`room.players` 的 `Seat.seat`，不得本地推导 —— 那是第二个真源，R124/R129 的教训）。

⚠️ **补位期间有人进来怎么办**：`claimSeat` 是原子的（`HSETNX`）⇒ 不会双占；但**要不要中断补位**？
⇒ **不中断**：已经占上的机器人座位不回滚（回滚窗口里别人可能已经坐进去）。补满 3 人即开工，**人是多不进来的**（满了 ⇒ `12002`，客户端会提示）。这是**有意**的：补位是真的在「开局」。

### 3.3 开局（R905 / R909）

```
startRoom(code):
  ① room = findOne(code)；不在 / 不是 waiting ⇒ 直接返回（幂等）
  ② 需要补位且越窗 ⇒ 补机器人（失败 ⇒ 记日志 + 本轮返回，房间仍 waiting ⇒ 下轮重试）
  ③ 若刚才没有会话、也没人开会话（本进程内 in-flight 集合）⇒ ok = game.start({roomCode, baseScore, players})
  ④ ok === true  ⇒ updateStatus(code, 'playing') + 通知玩家（announce）
     ok === false ⇒ **不写 playing**（房间留 waiting ⇒ 下轮重试；最坏由回收任务按 §3.1 删房）
```

**为什么「重试」是安全的**：`game.start` **幂等**（同 `roomCode` 复用会话，R210 —— 有单测钉住）。
**为什么不能无限重试**：`waiting` 的 `timeoutAt` 一到，回收任务就删房 ⇒ 总时长有界（≈30–90 秒）。

⚠️ **「满 3 人」这一步不等窗口**：用户裁决是「**房间满即开局**」⇒ 三个真人到齐就**当场**开，
**不**再等那 20–30 秒（那个窗口只是「人不够」时的等待）。两条触发路径合起来是一句话：
**满了就开；不满就先等 20 秒、再在随后的 10 秒内随机某刻补机器人开。**

### 3.4 通知（R907）

走 `announceMatch` 的既有形态（Redis 频道 → `WsGateway` → `room.matched {roomCode, seat}`）：

- **人**：`storePending(userId, code, seat)` + `cancelQueue(userId)` + 广播（照抄 `processQueue` 的 `:300-305`，**同一形态**）
- **机器人**：不写 `match:pending`、不发 `room.matched`（R47）

### 3.5 退房腾座位（R906 / R916）

`room.leave` 的成功路径新增：**仅当** `room.status === 'waiting'` 时 `leaveSeat(code, userId)`
（删 `room:{code}:seats` 的该字段，**座位号从 `room.players` 读，不推导**），并重写 `fillat` / `timeoutAt`。

⚠️ **`playing` 房间必须无条件跳过**（R916）：对局中离开是「我不玩了」，不是「我不等了」——
腾座位会让 `game-service` 的座位映射与 `room.players` 分叉。**对局中的离开维持现状**（座位留着、
对局继续；这正是既有设计：断线/退出都不改变对局）。

⚠️ **`leaveSeat` 必须是幂等的**（没坐过 / 已经走了 ⇒ 无声返回），且**不得**动别人的座位。
⚠️ 退座后若房间**空**了：不主动删房（交给回收任务）—— **不做**「空房立即删」这条额外逻辑
（YAGNI；它会让「房主刷新页面」变成删房）。

---

## 4. 服务端全部「等人/回收窗口」的关系（**写进注释，防将来被 merge**）

| 常量 | 值 | 语义 | 消费者 | 到点做什么 |
|---|---|---|---|---|
| `WAITING_TIMEOUT_MS` | **30s**（不变） | **匹配路径**的房间在 `waiting` 最多待多久 | 回收任务 | **删房** |
| `BOT_FILL_WAIT_MS` | **30s**（不变） | 匹配**队列**等人等多久 | 匹配扫描器 | **补机器人开局** |
| `MANUAL_FILL_MIN_WAIT_MS` | **20s** | 手动房间**先等**多久 | 自动开局扫描器 | ——（只是死线的下界） |
| `MANUAL_FILL_SPREAD_MS` | **10s** | 之后在这么长的窗口里**均匀随机**取一点 | 同上 | **补机器人开局** |
| `MANUAL_ROOM_TIMEOUT_MS` | **40s** | 手动房间的**回收**窗口 = 死线上界 + 10s | 回收任务 | **删房** |

**三条纪律**：

1. **不得互相 import**（`rooms.timeout.ts` 开头为前两者立过这条规矩，新增的三个同样适用）。
2. **`MANUAL_ROOM_TIMEOUT_MS > MANUAL_FILL_MAX_WAIT_MS` 是硬不变量** —— 它保证「回收」永远晚于「补位」⇒
   不会出现「正要补位时房间被删」。⚠️ 两个值放同一个文件里，就是为了让这条不变量**读得出来**（改一个必须回头看另一个）。
3. **`WAITING_TIMEOUT_MS` 保持 30s 不动**：它是**匹配路径**的回收窗口，本片不碰匹配（R905 明写匹配调用方忽略新返回值）。
   手动房间走**自己**的 40s —— **同一个 `timeoutAt` 字段承载两个窗口**是有意的：它由**房间是怎么被建的**决定（`POST /api/rooms` → 40s；匹配的 `createGameRoom` → 30s）。⚠️ 这不是「第二个真源」——分数值的是**语义**，而语义归属明确（谁建的谁定窗口）。

---

## 5. 客户端

**零改动**（R908）。理由：`room.matched` → `joinMatchedRoom()` 是**既有**的自动进房路径，手动房间开局时复用同一条。

⚠️ **回归风险点（必须用判据钉住）**：`joinMatchedRoom` 走的是 WS `room.join`，**不**走 REST 占座（片④ R803）——
手动房间的玩家**已经在 `room.players` 里** ⇒ `handleJoin` 放行 ✓。
如果有人「顺手」给它补一个 REST 占座，房间此刻已是 `playing` ⇒ **`12008`** ⇒ 玩家被踢回大厅（片④ §1.2 H2 的同一个坑）。

---

## 6. 验证（三层）

### 6.1 第一层：单测

> ⚠️ **本层的可判性全靠 R914**：时钟与随机源**都注入**（照 `MatchService.setClock()` 的成例）⇒
> 「死线落在 [20,30] 秒」这条才是**可判**的（否则要么恒真、要么 flaky）。

| 文件 | 新增判据 |
|---|---|
| `rooms.timeout.test.ts` | `manualFillDeadlineAt(now, () => 0)` ⇒ `+20s`；`() => 0.999` ⇒ `< +30s`；**`MANUAL_ROOM_TIMEOUT_MS > MANUAL_FILL_MAX_WAIT_MS`**（把 §4 那条硬不变量钉成判据） |
| `rooms.service.test.ts` | `leaveSeat`：腾座位 / **幂等**（没坐过、走两次）/ **不动别人的座位** / 不碰机器人的座位 / 🔴 **`status !== 'waiting'` 时一律不动**（R916 —— 「对局中离开」不得腾座位） |
| `ws.module.wiring.test.ts`（既有，或同形新闸） | 🔴 **模块不成环**：`rooms/` 下的文件**不得** import `match/match.service`（源码级；H8 的判据 —— 这条比「Nest 启动时才发现」早得多） |
| `match.service.test.ts` | **迁移后行为不变**：匹配路径仍走「补位 → `game.start` → `playing` → 通知」，只是**经由 `RoomStartService`**。⚠️ **既有用例一条都不删**（§6.4）—— 它们通过 `scanOnce()` 驱动、断言在假 RPC 上，抽服务之后**照样绿**（这正是「行为不变」的证明）。⚠️ 尤其 **`game.start` 两次失败仍写 `playing`** 那条**保留不动**（台账 N36 的现状判据，本片不碰匹配路径） |
| `rooms.service.test.ts` | 入座/退座 ⇒ `timeoutAt` **与 `fillat` 一起被重写**；`playing` 房间**不得**被重写（保持 `timeoutAt = 0`） |
| `rooms.service.test.ts` | `create()` 的**回收窗口是入参**：缺省 ⇒ `WAITING_TIMEOUT_MS`（**匹配路径的现状不变**，正对照）；传 40s ⇒ `timeoutAt` 相应变化。⚠️ `fillat` **只有手动路径写**（匹配的 `createGameRoom` 不得写它） |
| `rooms.service.test.ts` | `create()` 写 `fillat` 派生键；`deleteRoom` 把它**一起删掉**（否则回收后留孤儿键 —— N31 的形态） |
| `rooms.autostart.test.ts`（新） | ① **满 3 人 ⇒ 开局**（`game.start` 被调用 + `playing` 写入 + 通知人）；② **不足 + 未越死线 ⇒ 什么都不做**（正对照）；③ **不足 + 已越死线 ⇒ 补机器人到 3 人再开局**（`addBot` + `writeBotBindings` + **不发 `room.matched` 给机器人**）；④ 🔴 **`game.start` 失败 ⇒ 房间仍是 `waiting`**（**不得**写 `playing` —— H1 的判据）；⑤ **幂等**：连着扫两轮不得开两次局；⑥ **随机性**：同一个 `now` 下注入不同随机值 ⇒ 死线不同（证明随机源真的被用上了，不是装饰） |
| `match.service.test.ts` | `startGame` 的返回值：失败 ⇒ `false`；**匹配路径的既有行为一字不变**（既不抛、也不改 `playing` 的写入）—— 正向 + 负对照 |

### 6.2 第二层：conformance（`slice-12` 的**续写**）

⚠️ **`slice-12` 第 9 步现在判的是「坐满仍 `waiting`」**（片④ 的**交接判据**，当时写明「接上开局链路时它**该红**」）⇒ **本片必须改它**，并**新增**开局判据：

| # | 步骤 | 判据 |
|---|---|---|
| 9′ | 三人齐 | **`room.matched` 到达三个客户端**（`waitFor`，与 slice-07 同形） |
| 10′ | 各发 `room.join` | `code 0` + 座位与 REST 占座时一致 |
| 11′ | 等 `game.deal` | **拿到 `PlayerView`**、`hand.length === 17` —— **端到端：占座 → 挂载 → 真能开局** |
| 新组：单人房 | 只坐 1 人 → 等补位死线（**20–30 秒，随机**） | ① **前 ~15 秒内不得补位**（负对照：证明「先等 20 秒」不是摆设）；② 机器人补位：**经 WS ack 读到**的 `players` 里出现 **`seat-*`**（`toOutboundPlayerId` 对 `bot-` 前缀的掩码，`message.router.ts:427`）、且**任何 id 都不含 `bot-`**（§9.8/R48；⚠️ **不要**断言 `p_*` —— 那是**内部** `Seat.userId` 的形态，出站会再掩一层）；③ 收到 `room.matched`；④ `game.deal` 到手 |

⚠️ **第 11′ 步是片④ 欠下的那一条**（当时判不了，因为功能不存在）。

### 6.3 第三层：探针

**加一步**（第三次动探针）：**单人建房 → 等机器人补位 → 进牌桌发牌**。
```js
await createRoomAndJoin(cdp, '判据 2′（创建房间 → 进房）', finished.roomCode);   // 已有
// 🆕 本片：等补位死线（20–30s 随机）到期 ⇒ 机器人补位 ⇒ 真的开局
await waitFilledGame(cdp, '判据 2′（单人房 → 机器人补位 → 开局）');
```
判据（**取「用户能看见的那一步」**）：
① 补位**不是立刻发生**的（建房后 15 秒内**座位数仍为 1** —— 负对照，证明「先等 20 秒」不是摆设）；
② 随后**真的发牌**（`.table__me .card` = 17，照既有口径）；
③ 期间**没有** `game.reconnect` 风暴。

⚠️ **这一步会让 `full` 场景多花 ~30–45 秒**（等死线 + 补位 + 发牌）。`gate` **不变**（它不跑判据 2′）。
**实测**：`gate` **18/18**（不变）· `full` **28 → 33/33**（本步 +5）；
其中「等了 **30s**」落在 [20,30] 的窗口内、「补位前手牌 = 0」这条负对照也真的跑了。
⚠️ **不给「补位发生在 20–30 秒之间」写精确断言**：那是**随机**值，精确断言必然 flaky（要么写成「等 30 秒后必然发生」，要么只判「最终发生了」）。探针只判**两端**：**不会早于 20 秒**、**最终会**。区间内的随机性由 §6.1 ⑥ 的单测（注入随机源）钉住。

### 6.4 判据不变量（R912）

| 文件 | 片④ 后 | 本片后 |
|---|---|---|
| 8 文件合计 | ≥ 67 | ≥ 67（只增不减） |
| `lobby-ux`(23) / `auth-ui-wiring`(14) / `ui-flow`(1) | — | 一条不得减 |
| 客户端全量 | 500 + 2 skipped | ≥ 500 + 2 skipped |
| conformance `slice-12` | 26 项断言 | **只增**（第 9 步**改判**是「按交接约定兑现」、不是减少） |

---

## 7. 明确不做

| 项 | 为什么 |
|---|---|
| 改 `packages/protocol`（R907/R911） | 复用 `room.matched` 就够了；碰协议要重新裁决 |
| 客户端任何改动（R908） | `room.matched` → `joinMatchedRoom` 是既有路径 |
| **匹配路径**的 `startGame` 降级（台账 N36） | 已裁「本仓不实现」（`design.md` §4.3 表下）。本片**只让 `startGame` 返回成败**（R905），匹配调用方**忽略它** |
| 「房主点开始」按钮 | 用户裁决取「满即开局」，不做手动开始（那要新增 C→S 消息 ⇒ 碰协议） |
| 踢人 / 房主权限 / 观战 | MVP 无（`12005` 仍是保留码）；本片只做「自己退房腾座位」 |
| 多人同时建房 / 房间容量上限 | 不在本片（既有行为） |
| 多实例部署下的开局竞态 | 单进程假设（与 `match.service` 的扫描器**同一假设**）。多实例要引入分布式锁 —— 另立一片 |

---

## 8. 风险与已知代价

1. **窗口期内退房 + 补位**：机器人补位的 3 步不是原子的（`acquire` → `addBot` → `bind`）。中途有人退座 ⇒ 可能补多一个机器人（4 个座位里有 1 个机器人坐不下 ⇒ `addBot` 回 `12002`）。**缓解**：`addBot` 失败即中止本轮（已有 `catch` 置 `cancelled` 的成例可循），房间留 `waiting`，下轮重扫。⚠️ **这是有意接受的不完美**，写进「已知未覆盖」。
2. **房间的生命周期变长**：手动房间现在等到 `fillat`（20–30s）才补位，而**回收**窗口从 30s 抬到 **40s** ⇒ 删房间的窗口由 30–90s 变成 **40–100s**。⚠️ **不增加垃圾**（房间 TTL 仍是 3600s、总数不变），只是「一个没人管的空房间多活 10 秒」——换来的是**补位不会被回收贴脸删掉**（H6）。
3. **`room.matched` 复用**：它原本是「匹配成功」的语义。手动房间也发它就等于**扩宽一条消息的语义**。⚠️ **但这是唯一不碰协议、且客户端零改动的路径**。是否要为它新增一个更诚实的消息名（如 `room.started`）属于**协议级裁决**，本片不擅自做（R907）。
4. **单进程假设**：扫描器与 `match.service` 一样，多实例会双开。**本片不解决**（另立一片）。
5. **随机死线 ⇒ 体验上有一点点不可预期**（20–30 秒之间的某个点开机）。⚠️ 这是**用户裁决**要的形态（避免「所有人都在第 30 秒整开机」的机械感）。代价：同一个玩家两次建房的等待时长会不同 —— **不是缺陷**。

---

## 9. 完成判据（本片）

| 项 | 判据 |
|---|---|
| 功能 1 | 三人建房 ⇒ **立即开局**：三人收到 `room.matched` ⇒ 进牌桌 ⇒ **各拿到 17 张牌** |
| 功能 2 | 单人建房 ⇒ **等 20 秒，在随后的 10 秒内随机某刻**补位 ⇒ 开局 ⇒ 拿到 17 张牌（**不会早于 20 秒**，见 §6.3 ①） |
| 功能 3 | 有人退房 ⇒ 座位**真的腾出来**（`playerCount` 减 1）⇒ 房间不再卡在 3/3 |
| 失败面 | `game.start` 失败 ⇒ 房间**留在 `waiting`**（**不得**是 `playing` 配空会话）—— 单测钉住 |
| 不变量 | `playing` 的唯一写入点仍是那一处（两路径共用），且**在 `game.start` 成功之后** |
| 门禁 | `pnpm run ci` 六阶段全过；`build:app` DONE；判据只增不减（§6.4） |
| conformance | `slice-12` 改判 + 新增；`slice-07` 的 12004 反例**仍绿** |
| 探针 | `gate` **不变**、`full` 全绿（条数**实测填入**） |

### 9.2 完成状态（**实测**）

| 项 | 结果 |
|---|---|
| `pnpm run ci` 六阶段 | ✅ **六阶段全部通过** |
| `build:app` | ✅ **DONE**（R669 分开跑） |
| 客户端单测 | ✅ **500 passed + 2 skipped**（**一片未减** —— 本片客户端零改动） |
| room-service 单测 | ✅ **251 → 263 passed**（16 文件，只增不减） |
| conformance 核心 9 例 | ✅ **全绿**：slice-05 29 · slice-06 149 · slice-07 **39** · slice-07.1 28 · slice-08 55 · slice-09 160 · slice-10 185 · slice-11 50 · slice-12 **52** |
| 探针 `gate` | ✅ **18/18**（不变 —— 新步骤挂判据 2′） |
| 探针 `full` | ✅ **28 → 33/33** |
| 真浏览器补位实测 | ✅ 「等了 **30s**」（落在 [20,30] 窗口内）· 补位前 `hand=0`（负对照真的跑了） |
| 真后端端到端 | ✅ 建房 → REST 占座 → WS 挂载 → **满即开局** → 三家各 17 张牌；单人房 → 等死线 → 机器人补位（`p_*` 掩码）→ 开局 |

### 9.3 执行期发现（**4 条，其中 1 条是本片自己引入的回归**）

| # | 发现 | 处置 |
|---|---|---|
| **E1** | 🔴🔴 **「先公告、再开局」的顺序被我抽服务时调换了** —— 症状是**三家都收不到 `game.deal`**（收得到后续 `game.state_update`）。逐帧证据：`inbound game.started … owners=`（空）。**根因**：`game.deal` 的投递靠 `WsGateway.seatOwners`（内存表），而它要等**客户端收到 `room.matched` 后自己发 `room.join`** 才登记 ⇒ 顺序反了，推送在无人登记时发出 | `startRoom` 新增 `announceFirst`（匹配 true / 手动 false），把顺序**固化进签名** |
| **E2** | ⚠️ **DIAG 用掉五轮猜测才对**：「收得到 `state_update` 却收不到 `deal`」这个症状把我引向了网关/订阅/时序三个错方向。⇒ **该加诊断时就加**，不要靠读代码推演 | 已删诊断（验证后） |
| **E3** | 🔴 **DI 的类型导入陷阱（两条）**：`import type Redis` / `import type { RoomsService }` 在**运行时被擦除** ⇒ Nest 拿不到 token，容器启动即崩（`Nest can't resolve dependencies … argument Function at index [0/1]`）。⚠️ **单测与 `tsc` 都看不见**（它们直接 `new`，不做 DI 解析）—— 只有**真容器**才报 | 改成值导入；`RoomsService`/`MatchService` 本来就是值导入，只有新文件踩了 |
| **E4** | ⚠️ **`tsc -p tsconfig.test.json` 能看到主 tsconfig 看不到的测试类型错误**（未使用的 import、替身类型缺字段） | 两套 tsc 都跑（`pnpm lint` 本来就是） |

> **★ E1 的教训**：**「我以为的顺序」与「代码里的顺序」不是一回事**。片⑤ 抽服务时我逐条抄了方法体，却把两个顶层调用的**相对次序**抄反了 —— 而那条次序是**契约的一部分**（注释里写着「顺序是契约的一部分」，我读了却没守住）。
> ⇒ 处置不是补一句注释，而是**让它进签名**（`announceFirst`）——下次抽服务时编译器会逼着做选择。

### 9.1 给下一片的入口

按本片暴露出的次序：

1. **多实例部署的开局竞态**（§8.4）—— 现有一条进程内假设，两台机器就会双开。
2. **`room.matched` 的语义扩宽**（§8.3）—— 手动房间复用它之后，消息名不再诚实。要改就得动协议。
3. **匹配路径的 `startGame` 降级**（台账 N36）—— 本片已把 `startGame` 的成败**变得可判**（R905），那条降级现在**有实现基础了**。
4. **踢人 / 房主权限**（`12005` 仍是保留码）—— 「退房腾座位」只解决了自愿离开。

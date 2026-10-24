# 切片 7 实施计划：匹配 → 进房

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通「入队 → 撮合 → `room.matched` → `room.join` → 收到 `game.deal`」这条全真实链路，并把匹配队列从「超时即静默丢弃」改成 §8.4 规定的**30 秒等待窗口 → 冷启动补机器人**，同时把 §10.1 的两个匹配键（`match:meta` / `match:pending`）落实到位。

**Architecture:** `room-service` 是匹配的唯一所有者。`MatchService` 每 5 秒按 `(mode, region)` 扫描 Redis ZSet（`match:queue:{mode}:{region}`，`score = enteredAt`），读取 `match:meta:{playerId}` 判定等待时长与重试次数，人数不足且越过 30 秒窗口时经 `robot.acquire` 路径补机器人，然后建房间、写 `match:pending:{playerId}`、经 Redis pub/sub `match:events` 让 `WsGateway` 主动下发 `room.matched`。前端在收到 `room.matched` 后**自动** `room.join`（§8.2），并在 join 的 ack 为 `code 0` 时才进入牌桌。

**Tech Stack:** TypeScript / NestJS 10 / ioredis / Vitest / pnpm workspace + Turborepo / Vue 3 + Pinia + Vite（`apps/client`）/ socket.io 4

**Spec:**
- `docs/design.md` v4.2 —— 权威依据。本切片主要落在 **§8.1（队列）、§8.2（匹配流程与通知通路）、§8.4（重试与回退）、§3.5（MatchTicket）、§6.3（消息清单）、§6.4（可见性裁剪）、§6.6（重连记录刷新时机）、§9.8（不可区分性）、§10.1/§10.4（Redis 键与生命周期）、§11.2（错误码）、§12（前端约束）**
- `docs/games/doudizhu.md` v1.2 —— 本片**不碰**玩法规则（匹配不涉及牌型/倍数）
- `docs/superpowers/plans/2026-09-13-parallel-dev.md` —— 切片表第 7 行 + Global Constraints
- `docs/superpowers/plans/agent-briefs.md` —— 角色、工作区、已知环境事实
- `docs/superpowers/plans/2026-09-13-slice-06-login-and-room-list.md` —— 上一片的计划（本片沿用其结构与 R38–R41 的教训）

---

## Global Constraints

逐字照抄 `2026-09-13-parallel-dev.md`，每个任务都隐含本节：

| # | 约束 |
|---|------|
| 1 | **端口**：HTTP `3000/3001/3002/3003/3005`，内部 RPC `3103/3105`，douzero `2021`，redis `6379`，mysql `3306` |
| 2 | **测试框架 Vitest**（不是 Jest）。`packages/shared` 行覆盖率 ≥ 80% |
| 3 | **服务间通信必须用 `Transport.TCP`** + `@MessagePattern`，pattern 名与 DTO 见 §4.2 |
| 4 | **对外 REST 与内部 RPC 严禁共用同一个方法**：对外走 `game.view`（裁剪），对内走 `game.snapshot`（完整） |
| 5 | **WebSocket**：socket.io 4，namespace `/ws/ddz`，dot 命名；**ack 承载响应**；**没有 `seq` 字段** |
| 6 | **幂等**：动作请求必须带 `baseVersion`，CAS 失败返回 `13004`。`13002`/`13003` 已废弃、不得使用 |
| 7 | **错误码必须是 5 位数字**（§11.2）。禁止新增字符串错误码；旧字符串码只能出现在 §11.4 的别名表里 |
| 8 | **身份只从网关注入的 `X-User-Id`（HTTP）或 socket 握手 `auth.userId`（WS）取**。**严禁**信任请求体里的 `userId`/`playerId` |
| 9 | **裁剪**：`PlayerView` 是唯一的出站对局类型。`actionLog`、他人 `hand`、`isRobot`、`botId`、`skillLevel` **永不出站** |
| 10 | **牌值编码**：接口/存储层用 DouZero 编码（`2` = 17）；**进入牌型判定前必须还原为内部 Rank**（`2` = 15） |
| 11 | **前端哑终端**：禁止任何游戏规则、牌型判定、游戏常量、货币计算（§12 的 F01–F10） |
| 12 | **契约包 `packages/protocol` 由协调者拥有**。两端**只读**；任何改动（尤其破坏性）必须两端同一个 PR |

### 本切片的绑定数值（来自 §8.1 / §8.2 / §8.4 / §9.8 / §10.1 / §10.4 / §11.2，**逐字**）

| 项 | 值 |
|---|---|
| 队列键 | `match:queue:{mode}:{region}`，Sorted Set，`member = playerId`，`score = enteredAt`（**无 TTL**） |
| 队列元数据键 | `match:meta:{playerId}`，Hash，字段 `mode` / `region` / `enteredAt` / `latency` / `attempts`，**TTL 300s** |
| 匹配结果键 | `match:pending:{playerId}`，Hash，字段 **仅** `roomCode` / `seat`，**TTL 300s** |
| `region` | MVP **恒为 `global`**，但键形状必须带 region 维度（§8.1 偏差条款） |
| 扫描周期 | **5 秒**（`MATCH_SCAN_INTERVAL_MS`，默认 5000） |
| 等待窗口 | **30 秒**，自**队列中最早入队者的 `enteredAt`** 起算；到点仍未凑满 3 人 → **补机器人开局** |
| 重试上限 | `attempts >= 10` 或等待超过 **60 秒** → 回退（① 扩范围 ② 补机器人 ③ `12007`） |
| 回队时间戳 | **必须保留原始 `enteredAt`**（否则等待最久的玩家被降级到队尾而饥饿） |
| `match:rejected:{a}:{b}` | **MVP 不写入**（谓词集为空），只保留键形状 |
| `room.matched` 载荷 | `{ roomCode, seat }`（S→C，服务端**主动**下发，§8.2/§6.3） |
| `room.join` ack | `data: { roomCode, seat, players: RoomPlayer[] }`；`RoomPlayer = { id, seat, cardCount? }` |
| 匹配相关错误码 | `12007` MATCH_TIMEOUT（TOAST）、`12009` ALREADY_IN_QUEUE（**IGNORE**）、`12001` ROOM_NOT_FOUND（BACK_TO_LOBBY）、`12004` NOT_IN_ROOM（BACK_TO_LOBBY）、`10002` UNAUTHENTICATED |
| §9.8 机械规则 | 任何下发给客户端的消息中**不得出现 `isRobot`、`botId`，或以 `bot` 为前缀的 ID** |

### 协调者裁决（本片新增，执行时不得再自行解释）

- **R42 `match:meta:{playerId}` 与 `match:pending:{playerId}` 是两个键，职责不同。**
  meta = **排队状态**（`mode`/`region`/`enteredAt`/`latency`/`attempts`，TTL 300s）；
  pending = **匹配结果**（**仅** `roomCode`/`seat`，TTL 300s）。
  旧实现把排队信息写进 `match:pending`，既违反 §10.1 的键表，也让「客户端错过 `room.matched` 时补回」这条唯一用途含混。
  `match:pending` **只在匹配成功时写入人类玩家**。
- **R43 `region` 在 MVP 恒为 `global`，但必须作为队列键与 meta 的一部分。**
  扫描器按 `MATCH_MODES × MATCH_REGIONS` 遍历（MVP 只遍历 `global`）。
  **不得**把 region 从键里去掉了事（§8.1 明确要求现在就带上，使将来的地理扩展成为加性变更）。
- **R44 等待窗口 30 秒自「队列中最早入队者的 `enteredAt`」起算；到点即补机器人开局。**
  旧实现在这条上是**错的两副面孔**（R55 按负对照实测校正）：
  ① **N = 1**（`members` 是 WITHSCORES 原始数组，1 人长度 2）→ 第一行 `if (members.length < 3) return;`
     直接早退，**这个人从未被检查过**：既不成局也不丢弃，永久留在**无 TTL** 的 ZSet 里，
     收不到 `room.matched`、也收不到任何错误码；
  ② **N ≥ 2 且最老者 > 30s** → `stale.push` → `removeFromQueue`，**静默丢弃**。
  两条路径的修复是同一个：**不得保留任何「丢弃/忽略超时玩家」的路径**，
  超时的唯一出口是 R46 的 `12007`。
- **R45 `match:meta.latency` 写常量 `0`。**
  §8.1 的 meta 有 `latency`，但 MVP 谓词集为空、不引入 ELO，客户端也没有上报链路。
  保留字段形状（与 region 同理：为将来的地理/延迟谓词保留，属加性变更），值恒 `0`。
- **R46 匹配失败的唯一出口是 `12007`，经 S→C `system.error` 下发。**
  `room.match` 的 ack 在入队那一刻就已返回 `code 0`，§6.3 又明确**禁止任何响应型事件**
  （`room.timeout` 之类不存在）；`system.error { code, message }` 正是「**非请求触发的**系统错误」。
  触发条件（§8.4 ③）：30 秒窗口已过但**补机器人失败**，且 `attempts >= 10` 或等待超过 60 秒。
  下发后必须 `ZREM` + 删 meta（否则下一个扫描周期又把它捡起来）。
- **R47 补机器人只对人类玩家写 `match:pending`，`room.matched` 也只发人类。**
  机器人不需要断线补回；写 `match:pending:bot-*` 只会污染键空间。
  座位号仍按 **0/1/2 连续**分配：人类先占已有座位，机器人在其后补位。
- **R48 出站 `RoomPlayer.id` 不得以 `bot` 为前缀（§9.8 逐字）。**
  机器人出站 id 用**按座位派生的稳定不透明 id**：`` `seat-${seat}` ``。
  **服务端内部与投递路由仍必须用真实 id**（`Room.players` 里的 `bot-*`）：
  `buildRoomPlayers()` 返回**裁剪后的**出站列表，而 `onSeatOwners` / `game.deal` 的路由表
  必须从 `room.players` 直接登记 —— **两者不得共用同一个数组**，否则 `game.deal` 投递不到机器人座位。
  完整的「机器人不可区分」还包含行为层（§9.8 后半、§9.4 回合驱动），归 Task 11；本片只落**机械可验证**的这一条。
- **R49 匹配中状态归 store，不留在页面。**
  `useGameStore.matching: boolean`，由大厅按钮设置，并在两种终止条件下复位：
  ① `room.matched`（已成局，紧接着进房）；② `system.error` 且 `code === 12007`（匹配超时）。
  删除 `lobby.vue` 的局部 `matching` ref —— 否则 12007 到达时页面无法感知，按钮永久停在「正在匹配…」。
- **R50 收到 `room.matched` 后前端必须自动 `room.join`，且**只有 join 的 ack 为 `code 0` 时才导航到牌桌。
  §8.2 逐字：「玩家收到 `room.matched` 后即可 `room.join` 进入该房间，并开始接收 `game.*` 推送」。
  旧前端只 `setRoom` + `navigate('table')` 而**从不 join**，后果有三：
  ① 服务端不写 `reconnect:active`（重连只能走 `match:pending` 回退）；
  ② `socket.join(roomCode)` 从未发生（房间广播通路是空的）；
  ③ 契约里的 `room.join` ack 载荷（`players`）从未被消费。
  join 走串行队列，撞上在途请求时**必须等待空闲后有界重试**（与 `reconnect()` 的重试同源），不得静默丢弃。
- **R51 `12009`（已在队列中）在前端是幂等成功，不是错误。**
  `CLIENT_ACTION[12009] = IGNORE`，错误码处置层什么也不做；大厅必须自己把 `matching` 置真并给出
  「已在队列中」的中性提示，**不得**走通用失败分支清空状态。反例（必须有用例钉住）：
  `handleMatch` 的 `12009` 分支要真的能触发（重复 `room.match`）。
- **R52 本片不新增 `room.state_update` 的生产触发点。**
  MVP 的房间由匹配器**原子成局**（3 人一次性入座、随即 `game.start`），不存在「等人陆续进房」的状态转移。
  契约消息与前端分支保留；本片只为它补一条「载荷裁剪 + 机器人 id 掩码」的既有断言（Task 3）。
  若后续出现「好友房 / 练习房逐个入座」，由那一片新增触发点。
- **R53 本片不实现 §8.3 谓词框架，也不写 `match:rejected`。**
  §8.3 的 `MatchPredicate` / `canFormTable` 是**纯函数框架**；MVP 谓词集为空（恒允许），
  唯一实际约束是「3 人 + 模式一致」。没有谓词就没有「成对失败」，`match:rejected:{a}:{b}` 因此**不写入**
  （§8.4 自己也这么写：「MVP 谓词恒真，此路径不触发」）。
  现在建框架只会产生**没有调用方的死代码**（切片 5 已经吃过一次「死代码 = 没人发现它坏了」的教训）。
  同时 §8.4 ①「扩大候选范围」在 MVP 也无对象（只有一个 region）。
- **R54 `packages/protocol` 本片零改动。** 需要的消息（`room.matched` / `room.join` / `system.error`）
  与错误码（`12007` / `12009` / `12001` / `12004`）都已存在（切片 0 定义）。
  任何「顺手改契约」的冲动都必须先停下来问协调者（Global Constraint 12）。

### 裁决补充（执行期落盘，2026-09-13）

- **R55 计划缺陷两处，已就地修正（执行者不得自行改 `docs/**`，由协调者落盘）。**
  ① Task 6 Step 1 的 `import { …, sleep, step }` 含未使用的 `sleep`，与 `tsconfig.base.json` 的
  `noUnusedLocals` 冲突 → **`tsc` 会 TS6133 直接构建失败**；已从计划里删除该 import。
  （这是本计划第 4 条 Self-Review 栏「计划缺陷就地修正并编号」的第一次使用。）
  ② R44 对旧行为的描述对 **N = 1 不成立**：conformance 负对照实测证明单人是
  **`members.length < 3` 早退 → 从未被处理 → 永久留在无 TTL 的 ZSet 里**，
  而不是「30 秒后被丢弃」；「stale 丢弃」只发生在 N ≥ 2。R44 与 Task 2 前言、门禁的负对照段已按实测重写。
- **R56 `tools/conformance/package.json` 补 `conformance:slice-06` 脚本（既有缺口）。**
  `run.ts` 里早就有 `slice-06` 用例，但 scripts 只到 `slice-05`；由协调者顺手补齐
  （不影响本片判据，属工具一致性）。
- **R57 `12007` 的回退必须**逐票**判定，绝不整队淘汰（协调者评审 conformance 用例时发现的设计缺陷）。**  计划初稿里写的是「队首超时 → `failMatch(queued.map(…))`」，即**整队**下发 `12007` 并 `ZREM`。
  这是错的：ZSet 本身**没有 TTL**，只要 Redis 里残留一条旧成员（上一次运行 / 进程重启前留下的一个
  `match:queue:*` 成员就够），队首就永远是它，于是**每一次**正常匹配都会把刚入队的玩家一起判失败清出去
  —— 表现为「匹配按钮点了没反应，25 秒后 conformance 第 3 组假红」。
  正确形态：先按**每张票自己的 `enteredAt`** 分出 `timedOut` / `alive`，只对 `timedOut` 发 `12007` 并出队，
  再用 `alive` 走等待窗口与成局判断（`attempts` 同理，只对 `waited >= 30s` 的票读 meta）。
  这条自愈能力同时消灭了「历史残留成员污染下一次运行」这一类环境问题。
  回归用意见 Task 2 Step 1 的「队列里混有超时旧票」用例。
- **R58 计划缺陷（TDD 顺序自相矛盾），已就地修正。** Task 4 Step 5 已经引入
  `useGameStore.matching` / `setMatching`，而 Task 5 Step 1 的 `match-state.test.ts` 又断言它们 ——
  按顺序执行时 Task 5 只有 **2 条**会红（`12007` 复位、`12009` 幂等），
  「`reset()` 清 matching」与「其它错误码不复位」**一开始就是绿的**（它们锁的是 Task 4 的状态）。
  Task 5 Step 2 的「预期失败」已按实际重写；真正的判别点由 Step 1 新增的
  「`12007` 经 `system.error` 推送到达 → 大厅按钮回到『随机匹配』」闭环用例承担。
- **R59 既有用例 flake：`apps/client/test/reconnect-flow.test.ts` 的去抖断言。**
  `expect(reconnectAt - rollbackAt).toBeGreaterThanOrEqual(RECONNECT_DEBOUNCE_MS)` 拿两次
  `Date.now()` 的差与常量比，而 Node 的 `setTimeout(1000)` **实测可在 999ms 触发**
  （未改动的树上 5 次复现 1 次）⇒ 约 1ms 的假失败窗口，会把门禁随机打红。
  **与本片改动无关**，但本片顺手修（test-only、单独提交），并必须给出重复运行 10 次的稳定性证据。
- **R60 `sendQueued` 的「有界」取「尝试次数」语义。** 计划初稿的注释暗示 `requestSnapshot` 的
  「被抢先不消耗预算」内层循环，与代码（每被 `blocked` 一次就减 1）不一致；
  而那个内层循环自身依赖「抢占次数有限」才收敛，**不是真上界**。
  裁决：签名改为 `sendQueued(type, payload?, maxAttempts = 5)`，**每一次 `send()` 调用（含没抢到槽位）
  都消耗一次配额** ⇒ 全局有界、可断言。预算用尽的出口仍是返回 `blocked`，
  调用方只提示不丢局（服务端已写 `match:pending` + `reconnect:active`，重连路径能补回）——
  这条理由必须写进 `joinMatchedRoom` 的注释。
  ⚠️ 本条只讲**配额语义**；关于「恢复请求会不会抢先等待者」的**因果**见 **R67**（初稿写错、已按插桩实测重写），
  两处必须一起读，否则会重建出错误的因果。
- **R67 R60 的**因果**一开始写错了，已按插桩实测重写（前端执行期发现）。**
  我原来的说法是「`CLIENT_ACTION` 的恢复请求在 ack 回调里同步拿槽位，所以 `sendQueued` 的等待者
  会被它抢先，重试可能落空」。**实测不成立**，真实时序是：

  ```
  SLOT-CLEAR (finishRequest) game.bid   waiters=0     ← 先清空槽位
  >>> ACTION 13004
  SLOT-SET game.resync; EMIT game.resync              ← notifyAction 里同步 send() 立即 emit
  （flushIdleWaiters 因 pending !== null 整体早退 → 等待者继续停放）
  SLOT-CLEAR (finishRequest) game.resync waiters=1    ← resync 释放时才唤醒等待者
  SLOT-SET room.join; EMIT room.join                  ← 重试落在**已空的槽位**上，通常直接成功
  ```

  三条推论（写进了 `sendQueued` / `dispatchAck` 的注释）：
  ① `game.resync` 是**立刻 emit**的，不是「排队等下一次空闲」；
  ② 被抢先的重试落在空槽位上，**通常直接成功** ⇒ 「重试时槽位已被抢走」这个场景**构造不出来**；
  ③ `sendQueued` 返回 `blocked` 的条件是「**最后一次**尝试本身就撞上在途请求」。
  对应的可断言形态：`maxAttempts = 1` 钉 `blocked` 的确定性出口；被抢先 + 配额 2 与默认 5
  **结果必须一致**（恰好补发一次、`sent`）—— 证明「被抢先 ≠ 被丢弃」。
  ⚠️ 这条教训的普遍形态：**控制流的因果必须靠插桩确认，不能靠读代码推断**
  （切片 5 的四次「静默失效」也是同一类问题）。
- **R68 两个通用测试约定，已补进 `agent-briefs.md`（前端执行期发现）。**
  ① **`vi.waitFor` 不能证明「没发生」**：它一旦通过就返回。反向断言必须写成
  「正向 `vi.waitFor` + 一小段静默窗（如 `setTimeout(20)`）+ 计数/状态不变」；
  ② **变异测试必须自证变异生效**：一个看起来能反证 R61 的变异
  （`payload.status ?? this.roomStatus ?? null`）其实对「原值非 null」恒等，**没能打红任何用例**
  —— 弱原值（`null`）钉不住 store 的判空分支。加了强原值用例后才真正反证成功。
  即：**反证失败时，先怀疑变异是 no-op，而不是先怀疑用例不够**。
- **R69 调用点不得依赖默认值。** `sendQueued` 的 `maxAttempts = 5` 是默认值，
  而 `joinMatchedRoom` 是**自动路径**：将来改默认值会**静默**改变进房语义。
  裁决：`useGameSession.ts` 里定义具名常量 `JOIN_MAX_ATTEMPTS = 5` 并在调用处显式传入。
- **R70 计划缺陷（Critical）：`acquireBot` 的 URL 少了 `/api` 前缀 —— 门禁正对照抓到。**
  计划 Task 2 给的代码是 `${ROBOT_SERVICE_URL ?? 'http://localhost:3005'}/robots/create`，
  而 **5 个服务的 `main.ts` 全都有 `app.setGlobalPrefix('api')`**：

  ```
  packages/robot-service/src/main.ts:  app.setGlobalPrefix('api')
  实测（宿主机直连 3005）：  /robots/create → 404      /api/robots/create → 201
  ```

  后果：**30 秒冷启动补机器人这条 MVP 主路径在真实拓扑下从未成功过**。
  conformance 正对照的表现与日志：

  ```
  ▶ 单人在队列里等 30 秒 → 必须收到 room.matched（补机器人）
    ✅ 单人 room.match code = 0
  ❌ slice-07 失败：lone 等 room.matched 超时（50000ms）

  ftl-room-service 每 5 秒一次：
  [MatchService] Game room 4X2143 created with 1 players (mode: random)
  [MatchService] ERROR Bot fill failed for 4X2143: AxiosError: Request failed with status code 404
  ```

  **为什么单测抓不到**：`HttpService` 是替身，用例只断言了「`http.post` 被调用了几次」，
  **没有断言 URL**。替身对任何路径都返回成功 ⇒ 路径写错时用例照样全绿。
  约定（本片新增，写进 `agent-briefs.md`）：**env 里的是 base（不含 `/api`），路径里必须带 `/api`**；
  改动跨服务调用时先 `grep -rn "robots/" packages/*/src` 枚举**全部**调用点
  （api-gateway 的正确写法是 `'/api/robots/create'`，可作为对照）。
  已要求补一条**比对完整 URL** 的用例（RED → GREEN）。
  ✅ 附带确认：正对照失败留下的孤儿队列成员被 **R57 的逐票淘汰自动清掉**
  （实测 `match:queue:random:global` 为空、`match:meta:*` 计数 0）—— 即「历史残留污染下一次运行」这条风险在真实环境里确实被自愈了。
- **R61 不得伪造服务端没给的状态。** `room.join` 的 ack 只有 `{roomCode, seat, players}`，
  **没有** `status`（`room.state_update` 才带，且 R52 本片没有它的生产触发点）。
  计划初稿让 `joinMatchedRoom` 硬编码 `applyRoomState({ status: 'playing', ... })` 是错的：
  将来加好友房逐个入座时，这里会把「等待中」的房间显示成 `playing`。
  裁决：`applyRoomState` 的 `status` 改为**可选**，只在服务端真给了状态时才写；
  同时**统一 `lobby.vue` 手动「加入」路径**（它此前不消费 ack 的 `players`）——
  同一条 `room.join` 不允许有两条状态写入不一致的路径。
- **R62 计划缺陷一批，已就地修正（后端执行期发现，F1–F5/F8）。**
  ① **F1** Task 2 Step 1 的测试夹具名写错：`ws.gateway.test.ts` 的 match hand-off 块里**没有**
  `socks`/`ctx` 这个夹具（是另一个用例的局部变量），照抄写不出可编译的用例；
  ② **F2（重要）** 「人数不足且未到窗口」那条用例对**旧实现没有区分力**：旧代码
  `if (members.length < 3) return;` 在单人时直接早退，`createGameRoom` 从没被调用 ⇒ 断言空过。
  它只能当**防回归**用例；真正的 RED 证据由新增的「2 人 + 29s 不成局 / 31s 恰好补 1 个」承担（R64）；
  ③ **F3** `12007` 的 `message` 文案 §8.4 与前端 toast 都没规定，属实现细节；
  ④ **F4** Step 1 的调用方清点是 **6 处**不是 5 处；且把「删除 `removeFromQueue`」放在 Task 1、
  而 `processQueue` 要到 Task 2 才重写 —— **按字面在 Task 1 删会编译不过**，
  Task 1 必须同步把 `processQueue` 的两处调用改成 `cancelQueue` 作为过渡；
  ⑤ **F5** 座位改由「`room.players` 下标」或「`match:pending.seat`」决定的**真正收益**在
  「仅凭 `match:pending` 入房」这条路径上：旧实现恒回落 `seat: 0`（人类不会被掩码，所以机器人场景反而看不出来）；
  ⑥ **F8** 用例名「只给**队列里**的玩家发」不准确 —— `onMatchEvent` 只能投给**已连接**的玩家，
  离线者收不到任何东西（其出口是 meta 过期后重入队/再超时）。
- **R63 `handleMatch` 必须处理「孤儿队列成员」（后端 F6，**改代码**）。**
  R42 把排队状态的真相源定为 `match:meta`（TTL 300s），而 ZSet 成员**没有 TTL** ⇒ 两者会分叉：
  meta 已过期而 ZSet 成员仍在时，`handleMatch` 只查 `zscore` 就会把玩家**永远锁在 12009**，
  他既无法重新入队，也只能等扫描器按 R57 把他当超时票逐出并吃一次莫名的 `12007` TOAST。
  裁决：探测**两个真相源都要在**才判 12009；`meta === null` 而 `zscore` 还在 ⇒ 先 `cancelQueue` 再重新入队。
  这是 R42 拆键**引入**的不一致（探测必须查「现在承载排队状态的那个键」），不是既有缺陷的顺带修理。
- **R64 「未到窗口」用例必须有真区分力（改测试强度）。**
  保留 1 人版并**在注释里标明它是防回归**（挡「窗口检查被删 → <3 人立刻补位」这类回归），
  另补一条**对旧实现 RED** 的用例：2 人在队列、29 秒 → 不成局不补位且 `enteredAt` 不变；
  时钟推到 31 秒 → **恰好补 1 个**机器人。
  旧实现只挡 0 候选（`candidates.length < 1`），2 个候选会**立刻**成局并补位 ⇒ 29 秒那条对旧代码必然失败。
  必须给出 RED 证据（在 `abe96e3^` 上跑，或做「删掉 `waited` 判断」的变异测试）。
- **R65 §9.8 的 id 前缀约束在出站链路上**只有 `toOutboundPlayerId` 一个执行点**（后端 F7，本片不改）。**  `validateOutbound` 的黑名单是**键名**（`actionLog`/`isRobot`/`botId`/`skillLevel`），
  **不检查 id 的 `bot` 前缀** ⇒ R48 是唯一保障，不是双层保险。任何**新的**出站路径若忘了过
  `buildRoomPlayers`，契约层不会拦住它。
  加固方案（**属 `packages/protocol` 变更，本片不做**，R54）：在 `validateOutbound` 增加
  「id 类字段不得以 `bot` 为前缀」的机械断言。⚠️ **实现时不得用子串匹配** ——
  `roomCode` 由 base36 大写生成，`BOT123` 是**合法**房间号，子串检查会误伤。
- **R66 给 `MatchService` 新增「被路由调用」的方法时，两个替身必须同步（后端 F10，第二次实例）。**
  `handleMatch` 一开始调 `readMeta`，`message.router.test.ts` 与 `ws.gateway.test.ts` 的 match 替身
  就都得跟上。**漏掉不会报「方法不存在」**：读到 `undefined` → TypeError →
  被 `routeClientMessage` 的 catch 压成一个**完全无关的错误码**（本次是 `13001`「时间戳偏差过大」），
  极易误诊成时间戳/契约问题。本片所有 mock 需要同步的方法清单：
  `addToQueue` / `cancelQueue` / `readMeta`（`removeFromQueue` 删除）。
  更一般地：**新增生产依赖后，第一件事是把所有替身补齐再跑一次全量**，否则你看到的红是假红。

---

## 执行模型（与切片 5/6 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | Task 6（conformance）、评审、合并、门禁 |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | Task 1、2、3 |
| **前端 agent** | `.worktrees/frontend`（`feat/frontend`） | Task 4、5 |

**开工前固定动作**（两端都要）：

```bash
cd /home/howe/pokergame/.worktrees/<你的角色>
git merge master --no-edit        # master 已含切片 6 与全部裁决
pnpm install && pnpm build        # dist/ 是 gitignore 的；不重装会因解析不到 protocol 而假失败
docker compose up -d              # 后端角色；且镜像必须已重建（见 agent-briefs.md）
```

**本片的文件集互不相交**：后端只动 `packages/room-service/**`，前端只动 `apps/client/**`，
因此两条线可以真正并行，合并应干净。

---

## File Structure

```
packages/room-service/src/match/match.service.ts      Modify: 键助手 + meta/pending + 30s 窗口 + 补机器人 + 12007
packages/room-service/src/gateway/message.router.ts   Modify: room.unmatch → cancelQueue；出站 RoomPlayer 掩码
packages/room-service/src/gateway/ws.gateway.ts       Modify: MatchEvent 增加 match.timeout → system.error
packages/room-service/test/match.service.test.ts      Modify: 状态化 redis 替身 + 键形状/TTL/窗口/回退用例
packages/room-service/test/message.router.test.ts     Modify: cancelQueue + 掩码/路由分离用例
packages/room-service/test/ws.gateway.test.ts         Modify: match:timeout 下发用例 + mock 补 cancelQueue

apps/client/src/net/socket.ts                         Modify: 公开 sendQueued（等空闲 + 有界重试，R60）
apps/client/src/composables/useGameSession.ts         Modify: onRoomMatched → 自动 room.join → 才导航
apps/client/src/stores/game.ts                        Modify: matching 状态 + 12007 复位 + applyRoomState status 可选
apps/client/src/pages/lobby.vue                       Modify: matching 改读 store；12009 幂等；手动加入消费 players
apps/client/test/room-matched-join.test.ts            Create: 自动进房（含「在途请求时不得丢弃」）
apps/client/test/match-state.test.ts                  Create: store 层 12007 复位
apps/client/test/auth-ui-wiring.test.ts               Modify: 匹配/取消/12009 的页面接线
apps/client/test/ui-flow.test.ts                      Modify: 删掉手动 room.join（已自动）
apps/client/test/reconnect-flow.test.ts               Modify: 修既有去抖断言 flake（R59，test-only）

tools/conformance/src/slices/slice-07-match-join.ts   Create: 本片 conformance 用例
tools/conformance/src/run.ts                          Modify: 注册 slice-07
tools/conformance/package.json                        Modify: 加 conformance:slice-07 脚本
```

---

## Task 1: match-service —— 队列键与元数据（§8.1 / §10.1 / §10.4）（后端 agent）

**为什么单独成任务**：这一半是**存储契约**（键名、字段、TTL、谁在哪里写），
下一半（Task 2）是**匹配策略**（窗口、补位、回退）。两者可以被独立评审：
键形状写错是「契约违规」，窗口策略写错是「行为违规」。

**Files:**
- Modify: `packages/room-service/src/match/match.service.ts`
- Modify: `packages/room-service/src/gateway/message.router.ts`（只改 `room.unmatch` 的分派）
- Test: `packages/room-service/test/match.service.test.ts`（改）、`packages/room-service/test/message.router.test.ts`（改）、`packages/room-service/test/ws.gateway.test.ts`（mock 补一个方法）

**Interfaces:**
- Consumes: `Redis`（`room-service/src/redis.provider.module.ts` 提供的 `REDIS` provider）
- Produces（**Task 2/3 与 conformance 都依赖这些名字**）：
  - `matchQueueKey(mode: MatchMode, region = DEFAULT_REGION): string` → `match:queue:{mode}:{region}`
  - `matchMetaKey(playerId: string): string` → `match:meta:{playerId}`
  - `matchPendingKey(playerId: string): string` → `match:pending:{playerId}`
  - `MATCH_MODES: readonly MatchMode[] = ['random', 'practice']`
  - `MATCH_REGIONS: readonly string[] = ['global']`
  - `MATCH_META_TTL_SECONDS = 300`、`MATCH_PENDING_TTL_SECONDS = 300`
  - `interface MatchTicket { playerId: string; mode: MatchMode; region: string; enteredAt: number; latency: number; attempts: number }`
  - `MatchService.setClock(clock: () => number): void`（**测试用**；生产不调用）
  - `MatchService.readMeta(playerId: string): Promise<MatchTicket | null>`
  - `MatchService.addToQueue(playerId: string, mode: MatchMode, region?: string): Promise<void>`
  - `MatchService.cancelQueue(playerId: string): Promise<void>`（`room.unmatch` 与出队共用；**不碰 `match:pending`**）
  - `MatchService.storePending(playerId: string, roomCode: string, seat: number): Promise<void>`（**签名去掉 `isBot`**）
  - **删除** `MatchService.removeFromQueue(playerId, mode, region)`

- [ ] **Step 1: 先看清楚 `removeFromQueue` / `storePending` 的全部调用方**

Run:

```bash
grep -rn "removeFromQueue\|storePending" packages/room-service/src packages/room-service/test
```

Expected（这是改签名前必须清点的全部位置，**R62④ 实测为 6 处**，不是初稿写的 5 处）：

```
packages/room-service/src/match/match.service.ts      ← removeFromQueue 的**定义**本身
packages/room-service/src/match/match.service.ts:115  ← processQueue 的「stale 出队」调用
packages/room-service/src/match/match.service.ts:150  ← 匹配成功后的出队调用
packages/room-service/src/gateway/message.router.ts:135-136  ← room.unmatch 的两次调用
packages/room-service/test/match.service.test.ts:63,77
packages/room-service/test/ws.gateway.test.ts:73,81,95（mock 形状）
```

> ⚠️ **R62④：Task 1 必须保持可编译。** 「删除 `removeFromQueue`」在本任务里做，而 `processQueue`
> 要到 Task 2 才整体重写 —— 所以 Task 1 里要把 `processQueue` 的**两处调用**一并改成
> `cancelQueue(...)`（`storePending` 处同步加 `!isRobot` 守卫）作为过渡，Task 2 再连同 stale 逻辑一起删。

- [ ] **Step 2: 写失败测试**

把 `packages/room-service/test/match.service.test.ts` 开头的 `makeMockRedis` 换成**状态化**替身
（旧替身把 `hgetall` 一律返回 `{}`，无法验证「写进去的东西能按契约读回来」——
这正是切片 5 反复出问题的那类「假前提让用例通过」）：

```ts
type MockRedis = Redis & {
  _hashes: Map<string, Record<string, string>>;
  _zsets: Map<string, Map<string, number>>;
};

const makeMockRedis = (): MockRedis => {
  const hashes = new Map<string, Record<string, string>>();
  const zsets = new Map<string, Map<string, number>>();
  return {
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const z = zsets.get(key) ?? new Map<string, number>();
      z.set(member, score);
      zsets.set(key, z);
      return 1;
    }),
    zrange: vi.fn(async (key: string, _start: number, _stop: number, mode?: string) => {
      const z = zsets.get(key) ?? new Map<string, number>();
      const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]);
      return mode === 'WITHSCORES' ? sorted.flatMap(([m, s]) => [m, String(s)]) : sorted.map(([m]) => m);
    }),
    zrem: vi.fn(async (key: string, member: string) => (zsets.get(key)?.delete(member) ? 1 : 0)),
    hset: vi.fn(async (key: string, fields: Record<string, string>) => {
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...fields });
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => hashes.get(key) ?? {}),
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
    hincrby: vi.fn(async (key: string, field: string, by: number) => {
      const h = hashes.get(key) ?? {};
      const next = Number(h[field] ?? 0) + by;
      h[field] = String(next);
      hashes.set(key, h);
      return next;
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      const h = hashes.get(key);
      if (!h || !(field in h)) return 0;
      delete h[field];
      return 1;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (hashes.delete(key)) removed += 1;
        if (zsets.delete(key)) removed += 1;
      }
      return removed;
    }),
    expire: vi.fn(async () => 1),
    publish: vi.fn(async () => 1),
    quit: vi.fn(async () => undefined),
    _hashes: hashes,
    _zsets: zsets,
  } as unknown as MockRedis;
};
```

把「存储契约」的四条用例替换/新增进去（旧的两条 `removes player from queue after matching` /
`stores pending match info in Redis hash` **删掉**，它们断言的正是 R42 要废除的写错键行为）：

```ts
it('addToQueue 写 match:queue:{mode}:{region} 与 match:meta:{playerId}（§8.1/§10.1）', async () => {
  service.setClock(() => 1_700_000_000_000);
  await service.addToQueue('player-1', 'random');

  expect(redis.zadd).toHaveBeenCalledWith('match:queue:random:global', 1_700_000_000_000, 'player-1');
  expect(redis._hashes.get('match:meta:player-1')).toEqual({
    playerId: 'player-1',
    mode: 'random',
    region: 'global',
    enteredAt: '1700000000000',
    latency: '0', // R45：MVP 恒为 0，字段形状保留
    attempts: '0',
  });
  expect(redis.expire).toHaveBeenCalledWith('match:meta:player-1', 300); // §10.4
});

it('addToQueue **不再**写 match:pending（R42：那是匹配结果专用的键）', async () => {
  await service.addToQueue('player-1', 'random');
  expect([...redis._hashes.keys()]).not.toContain('match:pending:player-1');
});

it('cancelQueue 按 meta 定位队列、删 meta，且**不碰** match:pending（R42）', async () => {
  service.setClock(() => 1000);
  await service.addToQueue('player-1', 'practice');
  await service.storePending('player-1', 'ABC123', 2);

  await service.cancelQueue('player-1');

  expect(redis._zsets.get('match:queue:practice:global')?.has('player-1')).toBe(false);
  expect(redis._hashes.has('match:meta:player-1')).toBe(false);
  // 匹配结果不能被「取消排队」误删：它同时承担断线补齐（§8.2）
  expect(redis._hashes.get('match:pending:player-1')).toEqual({ roomCode: 'ABC123', seat: '2' });
});

it('cancelQueue 在 meta 丢失时按所有 (mode, region) 兜底（幂等）', async () => {
  await service.cancelQueue('ghost');
  expect(redis.zrem).toHaveBeenCalledWith('match:queue:random:global', 'ghost');
  expect(redis.zrem).toHaveBeenCalledWith('match:queue:practice:global', 'ghost');
});

it('storePending 只写 { roomCode, seat } 且带 300s TTL（§8.2/§10.4）', async () => {
  await service.storePending('player-1', 'ABC123', 2);
  expect(redis._hashes.get('match:pending:player-1')).toEqual({ roomCode: 'ABC123', seat: '2' });
  expect(redis.expire).toHaveBeenCalledWith('match:pending:player-1', 300);
});

it('readMeta 读回 MatchTicket（§3.5 形状）', async () => {
  service.setClock(() => 1_700_000_000_000);
  await service.addToQueue('player-1', 'random');
  expect(await service.readMeta('player-1')).toEqual({
    playerId: 'player-1', mode: 'random', region: 'global',
    enteredAt: 1_700_000_000_000, latency: 0, attempts: 0,
  });
  expect(await service.readMeta('nobody')).toBeNull();
});
```

同时给 `packages/room-service/test/message.router.test.ts` 的 `makeDeps` 补上新方法名
（否则 `room.unmatch` 的用例会在「mock 上调了一个不存在的方法」上静默通过）：

```ts
const match = {
  addToQueue: vi.fn().mockResolvedValue(undefined),
  cancelQueue: vi.fn().mockResolvedValue(undefined),
  // R66：`handleMatch` 现在也调它（R63）—— 漏了不会报「方法不存在」，
  // 而是读到 `undefined` → TypeError → 被路由的 catch 压成 **13001**（无关错误码）。
  readMeta: vi.fn().mockResolvedValue({
    playerId: 'alice', mode: 'random', region: 'global',
    enteredAt: Date.now(), latency: 0, attempts: 0,
  }),
};
```

并把既有用例改成：

```ts
it('room.unmatch 取消排队（不再按两个模式各删一次）', async () => {
  const { deps, match } = makeDeps();
  const ack = await route(deps, makeSocket('alice'), C('room.unmatch'));
  expect(ack.code).toBe(0);
  expect(match.cancelQueue).toHaveBeenCalledWith('alice');
});
```

`packages/room-service/test/ws.gateway.test.ts` 的 match 替身同样把 `removeFromQueue` 改成
`cancelQueue: vi.fn().mockResolvedValue(undefined)`、并补上 `readMeta`（第 73、81 行附近；**两个替身都要改** —— R66）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/room-service test -- match.service`
Expected: FAIL —— `service.setClock is not a function` / `service.cancelQueue is not a function`

- [ ] **Step 4: 改 `match.service.ts` 的键助手与存储层**

把文件头部的常量与类型改成（**保留** `MATCH_EVENTS_CHANNEL` 的导出，`ws.gateway.ts` 依赖它）：

```ts
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Redis } from 'ioredis';
import { firstValueFrom } from 'rxjs';
import { RoomsService } from '../rooms/rooms.service';

/** 匹配成功 / 匹配超时事件频道：room-service 内的 WsGateway 订阅它来下发（§8.2 / R46）。 */
export const MATCH_EVENTS_CHANNEL = 'match:events';

/** §8.1：MVP 恒为 'global'，为地理谓词预留。 */
export const DEFAULT_REGION = 'global';

/** 匹配模式。MVP 只有这两种（§3.5）。 */
export type MatchMode = 'random' | 'practice';

/** §8.1 的扫描维度。region 维度**现在就带着**，使地理扩展是加性变更（R43）。 */
export const MATCH_MODES: readonly MatchMode[] = ['random', 'practice'] as const;
export const MATCH_REGIONS: readonly string[] = [DEFAULT_REGION] as const;

/** §10.4：匹配元数据与匹配结果都保留 300s。 */
export const MATCH_META_TTL_SECONDS = 300;
export const MATCH_PENDING_TTL_SECONDS = 300;

/**
 * 匹配队列键（§8.1）。**键形状现在就带上 `region`**（MVP 恒为 `global`），
 * 参数的顺序是 `(mode, region)` —— 键里 region 在后。
 */
export function matchQueueKey(mode: MatchMode, region = DEFAULT_REGION): string {
  return `match:queue:${mode}:${region}`;
}

/** §10.1：排队元数据。**不是** `match:pending`（R42）。 */
export function matchMetaKey(playerId: string): string {
  return `match:meta:${playerId}`;
}

/** §10.1/§8.2：匹配结果，供错过 `room.matched` 的客户端补回。 */
export function matchPendingKey(playerId: string): string {
  return `match:pending:${playerId}`;
}

/** §3.5 的 MatchTicket。`latency` 在 MVP 恒为 0（R45）。 */
export interface MatchTicket {
  playerId: string;
  mode: MatchMode;
  region: string;
  enteredAt: number;
  latency: number;
  attempts: number;
}

/** §8.2：匹配成功后写入的结果（**只有**这两个字段，R42）。 */
export interface PendingMatch {
  roomCode: string;
  seat: number;
}
```

在类里加时钟与 meta 读写，并替换三个方法：

```ts
  /** 可注入时钟（**仅供测试**；生产路径永远是 `Date.now`）。 */
  private clock: () => number = () => Date.now();

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  /** §8.1：读回排队元数据。字段缺失（键过期）时返回 `null`。 */
  async readMeta(playerId: string): Promise<MatchTicket | null> {
    const raw = await this.redis.hgetall(matchMetaKey(playerId));
    if (!raw || Object.keys(raw).length === 0) return null;
    return {
      playerId,
      mode: raw.mode === 'practice' ? 'practice' : 'random',
      region: raw.region ?? DEFAULT_REGION,
      enteredAt: Number(raw.enteredAt ?? 0),
      latency: Number(raw.latency ?? 0),
      attempts: Number(raw.attempts ?? 0),
    };
  }

  /** 加入匹配队列（§8.1）：队列 ZSet + `match:meta`（R42）。 */
  async addToQueue(playerId: string, mode: MatchMode, region = DEFAULT_REGION): Promise<void> {
    const now = this.clock();
    await this.redis.zadd(matchQueueKey(mode, region), now, playerId);
    await this.redis.hset(matchMetaKey(playerId), {
      playerId,
      mode,
      region,
      enteredAt: String(now),
      latency: '0',
      attempts: '0',
    });
    await this.redis.expire(matchMetaKey(playerId), MATCH_META_TTL_SECONDS);
    this.logger.log(`Player ${playerId} added to queue: ${mode}/${region}`);
  }

  /**
   * 取消排队（`room.unmatch` 与「匹配成功后出队」共用）。
   *
   * - meta 在 → 按 meta 里的 `(mode, region)` 精确定位并 `ZREM`；
   * - meta 丢失（过期/重启）→ 按所有 `(mode, region)` 兜底，保证幂等；
   * - **绝不碰 `match:pending`**：它承载的是匹配结果，与排队状态无关（R42）。
   */
  async cancelQueue(playerId: string): Promise<void> {
    const meta = await this.readMeta(playerId);
    if (meta) {
      await this.redis.zrem(matchQueueKey(meta.mode, meta.region), playerId);
    } else {
      for (const mode of MATCH_MODES) {
        for (const region of MATCH_REGIONS) await this.redis.zrem(matchQueueKey(mode, region), playerId);
      }
    }
    await this.redis.del(matchMetaKey(playerId));
  }

  /** §8.2：匹配成功后写入 `match:pending:{playerId}` = `{ roomCode, seat }`（R42）。 */
  async storePending(playerId: string, roomCode: string, seat: number): Promise<void> {
    await this.redis.hset(matchPendingKey(playerId), { roomCode, seat: String(seat) });
    await this.redis.expire(matchPendingKey(playerId), MATCH_PENDING_TTL_SECONDS);
  }
```

**把 `PendingMatch` 的旧定义（含 `isBot`/`joinedAt`）删掉**，并把方法体内的 `Date.now()` 一律换成
`this.clock()`（Task 2 会继续用）。

- [ ] **Step 5: 改 `message.router.ts` 的 `room.unmatch` 分派**

```ts
    case 'room.unmatch':
      await deps.match.cancelQueue(userId);
      return ok();
```

**同一文件里再加 R63 的孤儿成员处理**（先写用例，见下）—— `handleMatch` 的 12009 探测必须查
**两个真相源**，否则 meta 过期后玩家被 `zscore` 锁死在 12009：

```ts
async function handleMatch(
  socket: Socket,
  deps: RouterDeps,
  mode: 'random' | 'practice',
  userId: string,
): Promise<Ack> {
  const otherMode = mode === 'random' ? 'practice' : 'random';
  const [existing, existingOther, meta] = await Promise.all([
    deps.redis.zscore(matchQueueKey(mode), userId),
    deps.redis.zscore(matchQueueKey(otherMode), userId),
    deps.match.readMeta(userId),
  ]);
  // R63：ZSet 成员**没有 TTL**，而 `match:meta` 有（300s）—— 两者会分叉。
  // 排队状态的真相源是 `match:meta`（R42）：meta 不在 ⇒ 这是**孤儿成员**，
  // 先清掉它再正常入队；否则玩家会被 12009 锁死，只能等一次莫名的 12007。
  if (meta === null) {
    if (existing !== null || existingOther !== null) {
      await deps.match.cancelQueue(userId);
    }
  } else if (existing !== null || existingOther !== null) {
    return fail(ErrCode.ALREADY_IN_QUEUE, 'Already in the match queue');
  }

  await deps.match.addToQueue(userId, mode);
  deps.logger.log(`Player ${userId} queued for ${mode} match (socket ${socket.id})`);
  return ok();
}
```

配套用例（`message.router.test.ts`；`makeDeps` 的 match 替身补 `readMeta`，默认返回一张 meta，
表示「meta 在」）：

```ts
it('meta 已过期但 ZSet 成员还在（孤儿）→ 先清理再入队，**不**返回 12009（R63）', async () => {
  const { deps, match, redis } = makeDeps();
  await redis.zadd('match:queue:random:global', Date.now(), 'alice');
  match.readMeta = vi.fn().mockResolvedValue(null);

  const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random' }));

  expect(ack.code).toBe(0);
  expect(match.cancelQueue).toHaveBeenCalledWith('alice');
  expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random');
});

it('meta 在 + ZSet 在 → 仍然是 12009（幂等判定没有被改坏）', async () => {
  const { deps, match, redis } = makeDeps();
  await redis.zadd('match:queue:random:global', Date.now(), 'alice');
  match.readMeta = vi.fn().mockResolvedValue({
    playerId: 'alice', mode: 'random', region: 'global',
    enteredAt: Date.now(), latency: 0, attempts: 0,
  });

  const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random' }));

  expect(ack.code).toBe(12009);
  expect(match.addToQueue).not.toHaveBeenCalled();
});
```

（这里**不**改 `handleMatch` 的既有 import：它已经 import 了 `matchQueueKey`；
`matchPendingKey` 由 Task 3 引入。）

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS（`room-service` 全部用例）

- [ ] **Step 7: 全量验证并提交**

```bash
pnpm --filter @fight-the-landlord/room-service test && pnpm test && pnpm lint
git add packages/room-service
git commit -m "fix(room-service): 匹配队列落实 match:meta / match:pending 两个键与 TTL（§8.1/§10.1/§10.4，R42-R45）"
```

---

## Task 2: match-service —— 30 秒等待窗口 / 冷启动补机器人 / `12007` 回退（§8.2 / §8.4）（后端 agent）

**这是本切片的核心修复点。** 旧 `processQueue()` 的 30 秒语义是**反的**，且有**两副面孔**（R55 按负对照实测校正）：

```ts
// 旧实现（packages/room-service/src/match/match.service.ts:96-117，必须删除）
if (members.length < 3) return;                                  // ← ① 单人：从未被检查，永久留在无 TTL 的 ZSet 里
...
if (now - score > this.botFillTimeoutMs) stale.push(memberId);   // ← ② ≥2 人：超时 = 丢弃
for (const id of stale) await this.removeFromQueue(id, mode);    // ← 玩家永远收不到任何消息
```

① 是 **N = 1** 的情形（`members` 是 `ZRANGE … WITHSCORES` 的原始数组，1 人 = 长度 2），
conformance 负对照实测的正是这一支：单人入队后**队列里一直留着它**，`room.matched` 永不出现。
② 只在 N ≥ 2 且最老者已超 30 秒时触发（代码审读，未单独构造实验）。

§8.4 的规定相反：等待窗口到点应当**补机器人开局**（这是「人数不足」的 MVP 真实主路径），
超时的唯一出口是 `12007`。

**Files:**
- Modify: `packages/room-service/src/match/match.service.ts`（`processQueue` / `scanAndMatch` / `announceMatch` / `startGame`）
- Modify: `packages/room-service/src/gateway/ws.gateway.ts`（`MatchEvent` 联合类型 + `onMatchEvent` 的 `match.timeout` 分支）
- Test: `packages/room-service/test/match.service.test.ts`（新增窗口/补位/回退用例）、`packages/room-service/test/ws.gateway.test.ts`（新增下发用例）

**Interfaces:**
- Consumes: Task 1 的 `matchQueueKey` / `matchMetaKey` / `matchPendingKey` / `readMeta` / `cancelQueue` / `storePending` / `setClock` / `MATCH_MODES` / `MATCH_REGIONS`
- Produces:
  - `BOT_FILL_WAIT_MS = 30_000`、`MATCH_MAX_WAIT_MS = 60_000`、`MATCH_MAX_ATTEMPTS = 10`
  - `MatchService.processQueue(mode: MatchMode, region: string): Promise<void>`
  - `ws.gateway.ts` 的 `type MatchEvent` 变为**判别联合**：
    - `{ event: 'room.matched'; roomCode: string; seats: Array<{ userId: string; seat: number }> }`
    - `{ event: 'match.timeout'; playerIds: string[]; code: number; message: string }`

- [ ] **Step 1: 写失败测试**

在 `packages/room-service/test/match.service.test.ts` 里把 `describe('bot fill on match')` 整块替换为
（**注意**：现在用 `service.setClock` + `addToQueue` 造状态，不再用 `zrange.mockResolvedValueOnce` ——
后者会绕过 `enteredAt` 的真实语义，正是这条 bug 当年没被抓到的原因）：

```ts
describe('30 秒等待窗口与冷启动补机器人（§8.4 / R44）', () => {
  const T0 = 1_700_000_000_000;

  it('人数不足且未到窗口 → 不成局、不补机器人、**人还在队列里**', async () => {
    // ⚠️ R62②/R64：这条对**旧实现没有区分力**（旧代码 `members.length < 3` 在单人时直接早退，
    // `createGameRoom` 从没被调用 ⇒ 断言空过）。它的价值是**防回归** ——
    // 挡住「窗口检查被删掉 → <3 人就立刻补位」这种退化。真正的 RED 证据在下面那条 2 人用例。
    service.setClock(() => T0);
    await service.addToQueue('u1', 'random');
    service.setClock(() => T0 + 29_000);

    await service.scanOnce();

    expect(roomsService.createGameRoom).not.toHaveBeenCalled();
    expect(httpService.post).not.toHaveBeenCalled();
    expect(redis._zsets.get('match:queue:random:global')?.has('u1')).toBe(true);
  });

  it('2 人等 29 秒 → 不成局不补位；31 秒 → 恰好补 1 个机器人（R44/R64）', async () => {
    service.setClock(() => T0);
    await service.addToQueue('u1', 'random');
    service.setClock(() => T0 + 1);
    await service.addToQueue('u2', 'random');

    service.setClock(() => T0 + 29_000);
    await service.scanOnce();
    // 旧实现在这里会**立刻**成局并补 1 个机器人（旧代码只挡 0 候选）⇒ 这条对旧代码是 RED
    expect(roomsService.createGameRoom).not.toHaveBeenCalled();
    expect(httpService.post).not.toHaveBeenCalled();
    // 回队时间戳必须原样保留（§8.4）
    expect(redis._zsets.get('match:queue:random:global')?.get('u1')).toBe(T0);
    expect(redis._zsets.get('match:queue:random:global')?.get('u2')).toBe(T0 + 1);

    service.setClock(() => T0 + 31_000);
    await service.scanOnce();
    expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2'], 'random');
    expect(httpService.post).toHaveBeenCalledTimes(1); // 只补 1 个
  });

  it('越过窗口 → 补 2 个机器人成局，且**只**给人类发 room.matched（§8.4②/R47）', async () => {
    service.setClock(() => T0);
    await service.addToQueue('u1', 'random');
    service.setClock(() => T0 + 30_001);

    await service.scanOnce();

    expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1'], 'random');
    expect(httpService.post).toHaveBeenCalledTimes(2); // robot.acquire ×2
    expect(roomsService.addBot).toHaveBeenCalledTimes(2);

    const published = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([channel]) => channel === 'match:events',
    );
    const event = JSON.parse(published![1] as string);
    expect(event).toMatchObject({ event: 'room.matched', roomCode: 'ABC123' });
    expect(event.seats).toEqual([{ userId: 'u1', seat: 0 }]); // 机器人不进 room.matched（R47）

    // R47：只给人类写 match:pending
    expect(redis._hashes.get('match:pending:u1')).toEqual({ roomCode: 'ABC123', seat: '0' });
    expect([...redis._hashes.keys()].filter((k) => k.startsWith('match:pending:bot-'))).toEqual([]);

    // 出队：人类与 meta 都清掉
    expect(redis._zsets.get('match:queue:random:global')?.has('u1')).toBe(false);
    expect(redis._hashes.has('match:meta:u1')).toBe(false);
  });

  it('3 人齐 → 立刻成局，不等窗口也不补机器人', async () => {
    // ⚠️ 三人的 score **必须不同**：真实 Redis 对相同 score 的成员按 member 字典序排，
    //    而不是按插入序。用递增毫秒才与生产语义一致（否则这条用例在真机上会偶发反过来）。
    service.setClock(() => T0);
    await service.addToQueue('u1', 'random');
    service.setClock(() => T0 + 1);
    await service.addToQueue('u2', 'random');
    service.setClock(() => T0 + 2);
    await service.addToQueue('u3', 'random');
    service.setClock(() => T0 + 1_000); // 只等了 1 秒

    await service.scanOnce();

    expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'random');
    expect(httpService.post).not.toHaveBeenCalled();
    const event = JSON.parse(
      (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
        ([c]) => c === 'match:events',
      )![1] as string,
    );
    expect(event.seats).toEqual([
      { userId: 'u1', seat: 0 },
      { userId: 'u2', seat: 1 },
      { userId: 'u3', seat: 2 },
    ]);
  });

  it('补机器人失败 → 回队且**保留原 enteredAt**、attempts 累加、孤儿房间标 cancelled', async () => {
    httpService.post.mockReturnValue(throwError(() => new Error('robot-service down')));
    service.setClock(() => T0);
    await service.addToQueue('u1', 'random');
    service.setClock(() => T0 + 31_000);

    await service.scanOnce();

    // §8.4 逐字：「必须保留原始 enteredAt」，否则等待最久的人被反复降级到队尾
    expect(redis._zsets.get('match:queue:random:global')?.get('u1')).toBe(T0);
    expect(redis._hashes.get('match:meta:u1')?.attempts).toBe('1');
    // 已建但没凑齐的房间不能留在房间列表里（§3.1 的 cancelled 是终态）
    expect(roomsService.updateStatus).toHaveBeenCalledWith('ABC123', 'cancelled');
    expect(redis._hashes.has('match:pending:u1')).toBe(false);
  });

  it('等待超过 60 秒 → 12007 经 match:events 下发并出队（§8.4③/R46）', async () => {
    service.setClock(() => T0);
    await service.addToQueue('u1', 'random');
    service.setClock(() => T0 + 60_001);

    await service.scanOnce();

    const published = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([channel]) => channel === 'match:events',
    );
    const event = JSON.parse(published![1] as string);
    expect(event).toMatchObject({ event: 'match.timeout', playerIds: ['u1'] });
    expect(event.code).toBe(12007); // ErrCode.MATCH_TIMEOUT（§11.2：5 位数字）
    expect(redis._zsets.get('match:queue:random:global')?.has('u1')).toBe(false);
    expect(redis._hashes.has('match:meta:u1')).toBe(false);
    expect(httpService.post).not.toHaveBeenCalled(); // 60s 已越过窗口上限，不再尝试补位
  });

  it('队列里混有超时旧票时**只**淘汰旧票，新入队的人照常成局（R57）', async () => {
    // 复现「上一次运行残留的无 TTL 成员」：入队时刻在 10 分钟之前
    service.setClock(() => T0 - 600_000);
    await service.addToQueue('ghost', 'random');
    service.setClock(() => T0);
    await service.addToQueue('u1', 'random');
    await service.addToQueue('u2', 'random');
    await service.addToQueue('u3', 'random');
    service.setClock(() => T0 + 1_000);

    await service.scanOnce();

    const events = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === 'match:events')
      .map(([, raw]) => JSON.parse(raw as string));
    // ① 12007 只发给超时的 ghost —— 整队淘汰会让新人也拿不到 room.matched
    expect(events.find((e) => e.event === 'match.timeout')?.playerIds).toEqual(['ghost']);
    // ② 三个新人在 1 秒内成局（不等窗口）
    expect(events.find((e) => e.event === 'room.matched')?.seats.map((s: { userId: string }) => s.userId))
      .toEqual(['u1', 'u2', 'u3']);
    expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'random');
    expect(redis._zsets.get('match:queue:random:global')?.has('ghost')).toBe(false);
  });
});
```

文件顶部把 `import { of } from 'rxjs'` 改成 `import { of, throwError } from 'rxjs'`。
`makeMockRoomsService()` 需补 `updateStatus: vi.fn().mockResolvedValue({})`（已有）与
`createGameRoom` 返回带 `players` 的结果（Task 2 的实现要读 `room.code`）：

```ts
const makeMockRoomsService = (): RoomsService => ({
  createGameRoom: vi.fn().mockResolvedValue({ code: 'ABC123', players: [] }),
  addBot: vi.fn().mockResolvedValue({ code: 'ABC123', players: ['bot-1'] }),
  updateStatus: vi.fn().mockResolvedValue({}),
  findAll: vi.fn().mockResolvedValue([]),
  findOne: vi.fn().mockResolvedValue(null),
  join: vi.fn().mockResolvedValue({}),
} as unknown as RoomsService);
```

在 `packages/room-service/test/ws.gateway.test.ts` 里新增（放在既有 `forward match:events` 用例旁边）：

```ts
it('match:timeout → 只给队列里的玩家发 system.error 12007（R46）', () => {
  ctx.gateway.onMatchEvent({
    event: 'match.timeout',
    playerIds: ['user-1', 'ghost'],
    code: 12007,
    message: 'Match timed out',
  });
  expect(socks[0]!.emitted).toEqual([
    ['system.error', { version: 0, payload: { code: 12007, message: 'Match timed out' } }],
  ]);
  // ghost 未连接 → 不产生任何 emit（也不抛错）
  expect(socks[1]!.emitted).toEqual([]);
});
```

**R62① 修正**：`ws.gateway.test.ts` 的 match hand-off 块里**没有** `socks`/`ctx` 这个夹具
（`socks` 是**另一个**用例里的局部变量）。请按该文件现有风格**新建局部** `sock`
（`handleInternalConnect(sock, 'user-1')`），不要照抄初稿里的夹具名 —— 那会写不出可编译的用例。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/room-service test -- match.service`
Expected: FAIL —— **R62② 修正**：有区分力的是这几条（初稿写的「未到窗口」用例在旧实现上会**空过**）：
- 「2 人等 29 秒」（R64）：旧实现 2 个候选也立刻成局 ⇒ `createGameRoom` 被调用，断言失败；
- 「越过窗口」：旧实现只在前两个人类之间补 1 个 ⇒ `http.post` 调用次数不符；
- 「60 秒回退」：旧实现走的是 `stale` 丢弃而不是 `12007` ⇒ 拿不到 `match.timeout` 事件；
- 「队列里混有超时旧票」（R57）：初稿的整队形态下事件根本发不出 ⇒ `playerIds` 为 `undefined`。

- [ ] **Step 3: 改 `match.service.ts` 的扫描与匹配策略**

先在文件顶部补上 Task 1 还没用到、本步骤开始需要的错误码导入
（`room-service` 的 `lint` 是 `tsc --noEmit`，而 `tsconfig.base.json` 开了 `noUnusedLocals`
—— **Task 1 不要提前导入它**，否则 lint 会在「导入未使用」上失败）：

```ts
import { ErrCode } from '@fight-the-landlord/protocol';
```

新增三个常量：

```ts
/** §8.4：人数不足时，自最早入队者的 `enteredAt` 起算的等待窗口。 */
export const BOT_FILL_WAIT_MS = 30_000;
/** §8.4：等待超过 60 秒 → 三级回退。 */
export const MATCH_MAX_WAIT_MS = 60_000;
/** §8.4：`attempts >= 10` → 三级回退。 */
export const MATCH_MAX_ATTEMPTS = 10;
```

```ts
  private async scanAndMatch(): Promise<void> {
    for (const mode of MATCH_MODES) {
      for (const region of MATCH_REGIONS) {
        // 单个队列失败不得拖垮其余队列（旧实现会让第一个异常终止整轮扫描）
        try {
          await this.processQueue(mode, region);
        } catch (err) {
          this.logger.error(`Match scan for ${mode}/${region} failed: ${String(err)}`);
        }
      }
    }
  }

  /**
   * 单个 `(mode, region)` 队列的匹配（§8.2/§8.4）。
   *
   * 顺序是契约的一部分：
   *  ① 队列为空 → 返回；
   *  ② **≥3 人** → 直接成局（MVP 谓词集为空，恒允许）；
   *  ③ **<3 人且未越 30 秒窗口** → 本周期什么都不做（**绝不丢人**，R44）；
   *  ④ **<3 人且已越窗口** → 等待超过 60 秒或 attempts 超限 → `12007` 回退（R46）；
   *     否则补机器人至 3 人（§8.4 ②，MVP 的真实主路径）。
   *
   * **出队只在成功或最终失败时发生**：候选留在 ZSet 里 `score` 不变 ⇒
   * `enteredAt` 天然被保留（§8.4「回队时间戳必须保留」），不需要任何重新入队。
   */
  private async processQueue(mode: MatchMode, region: string): Promise<void> {
    const raw = await this.redis.zrange(matchQueueKey(mode, region), 0, -1, 'WITHSCORES');
    if (raw.length === 0) return;

    const queued: Array<{ playerId: string; enteredAt: number }> = [];
    for (let i = 0; i < raw.length; i += 2) {
      queued.push({ playerId: raw[i]!, enteredAt: Number(raw[i + 1] ?? 0) });
    }

    const now = this.clock();

    /**
     * ① **逐票**淘汰确定超时的票（R57）。
     *
     * ⚠️ **不能**写成「队首超时 → `failMatch(整队)`」：那会把**刚刚入队**的玩家一起判失败并清出队列。
     * 只要 Redis 里残留一条旧的队列成员（上一次运行、进程重启之前留下的 —— ZSet 本身**没有 TTL**），
     * 之后**每一次**正常匹配都会被它带崩。判据必须**按票**：`waited` 用该票自己的 `enteredAt`。
     *
     * `attempts` 只在补机器人失败时累加，因此它要到 `BOT_FILL_WAIT_MS` 之后才可能非 0
     * —— 窗口之前不必读 meta，省掉每周期 O(n) 次 `HGETALL`。
     */
    const timedOut: string[] = [];
    const alive: Array<{ playerId: string; enteredAt: number }> = [];
    for (const q of queued) {
      const waitedMs = now - q.enteredAt;
      if (waitedMs >= MATCH_MAX_WAIT_MS) {
        timedOut.push(q.playerId);
        continue;
      }
      if (waitedMs >= BOT_FILL_WAIT_MS) {
        const ticket = await this.readMeta(q.playerId);
        if ((ticket?.attempts ?? 0) >= MATCH_MAX_ATTEMPTS) {
          timedOut.push(q.playerId);
          continue;
        }
      }
      alive.push(q);
    }
    if (timedOut.length > 0) {
      await this.failMatch(timedOut, mode, region, 'Match timed out: no table could be formed');
    }
    if (alive.length === 0) return;

    // ZRANGE 升序 ⇒ `alive[0]` 是「**仍在等待**的人里」最久的那个（§8.1 用 enteredAt 保证先到先服务）
    const oldest = alive[0]!;
    const waited = now - oldest.enteredAt;

    if (alive.length < 3 && waited < BOT_FILL_WAIT_MS) return; // ③ 还在窗口内

    const humans = alive.slice(0, 3).map((q) => q.playerId);
    const botSeats = 3 - humans.length; // ④ 越过窗口才可能 > 0

    const room = await this.roomsService.createGameRoom(humans, mode);
    const bots: string[] = [];
    try {
      for (let i = 0; i < botSeats; i += 1) {
        const bot = await this.acquireBot(room.code, humans.length + i);
        await this.roomsService.addBot(room.code, bot.id);
        bots.push(bot.id);
      }
    } catch (err) {
      // §8.4 ②失败 → 不丢人：候选仍在 ZSet 且 score 未变，下个周期重试。
      // 已建的房间进不了列表（§3.1 的 cancelled 是终态），也不会残留可玩的半成品。
      this.logger.error(`Bot fill failed for ${room.code}: ${String(err)}`);
      await this.roomsService.updateStatus(room.code, 'cancelled');
      await this.incrementAttempts(humans);
      return;
    }

    const seats = [...humans, ...bots].map((userId, seat) => ({
      userId,
      seat,
      isRobot: seat >= humans.length,
    }));

    for (const s of seats) {
      if (s.isRobot) continue; // R47：机器人不写 match:pending、不发 room.matched
      await this.storePending(s.userId, room.code, s.seat);
      await this.cancelQueue(s.userId);
    }

    await this.announceMatch(room.code, seats);
    this.logger.log(`Matched ${seats.length} seats to room ${room.code} (mode: ${mode}/${region})`);
    await this.startGame(room.code, seats);
  }

  /** §4.2：`robot.acquire` 的过渡 HTTP 形态（TCP RPC 迁移随 Task 11）。 */
  private async acquireBot(roomCode: string, seat: number): Promise<{ id: string }> {
    const resp = await firstValueFrom(
      this.http.post<{ id: string }>(
        `${process.env.ROBOT_SERVICE_URL ?? 'http://localhost:3005'}/robots/create`,
        { roomCode, seat },
      ),
    );
    return resp.data;
  }

  /** §8.1：`match:meta.attempts` 每轮 +1，供 `MATCH_MAX_ATTEMPTS` 判定。 */
  private async incrementAttempts(playerIds: string[]): Promise<void> {
    for (const playerId of playerIds) {
      await this.redis.hincrby(matchMetaKey(playerId), 'attempts', 1);
    }
  }

  /**
   * §8.4 ③：最终失败 → 下发 `12007` 并出队（R46）。
   *
   * 走 `match:events` → `WsGateway.onMatchEvent` → S→C `system.error`：
   * `room.match` 的 ack 早已返回，§6.3 又不允许响应型事件。
   */
  private async failMatch(
    playerIds: string[],
    mode: MatchMode,
    region: string,
    message: string,
  ): Promise<void> {
    try {
      await this.redis.publish(
        MATCH_EVENTS_CHANNEL,
        JSON.stringify({ event: 'match.timeout', playerIds, code: ErrCode.MATCH_TIMEOUT, message }),
      );
    } catch (err) {
      this.logger.error(`Failed to publish match.timeout: ${String(err)}`);
    }
    for (const playerId of playerIds) {
      await this.redis.zrem(matchQueueKey(mode, region), playerId);
      await this.redis.del(matchMetaKey(playerId));
    }
    this.logger.warn(`Match timed out for ${playerIds.length} player(s) in ${mode}/${region}`);
  }
```

> **`enteredAt` 的精度与 tie-break**：它是毫秒时间戳，因此**同一毫秒**入队的成员在真实 Redis 里
> 按 member 的字典序排列，而不是插入序。这不影响正确性（无论谁先，都是同一批人成局，
> 座位号只是分配结果），但**测试不得依赖插入序** —— 造 3 人队列时要给递增的 `enteredAt`
>（见 Task 2 Step 1 的「3 人齐」用例）。

`announceMatch` **保持不变**（它已经把 `isRobot` 过滤掉了），但它的入参类型里的 `isRobot` 现在来自 seats；`startGame` 的签名收敛成只接 `seats`（删掉已无人使用的 `playerIds` 与 `seats?` 可选分支）：

```ts
  private async startGame(
    roomCode: string,
    seats: Array<{ userId: string; seat: number; isRobot: boolean }>,
  ): Promise<void> {
    const players = seats.map((s) => ({ id: s.userId, seat: s.seat, isRobot: s.isRobot }));
    // …（其余保持原样：3s 超时的 fetch + X-Internal-Token）
  }
```

同时**删除**：`botFillTimeoutMs` 字段、`PendingMatch` 的旧 `isBot`/`joinedAt` 用法、
以及 `processQueue` 里所有 `stale` 相关代码。

- [ ] **Step 4: 改 `ws.gateway.ts`**

```ts
/** 匹配事件载荷（§8.2 + R46）。 */
export type MatchEvent =
  | {
      event: 'room.matched';
      roomCode: string;
      seats: Array<{ userId: string; seat: number }>;
    }
  | {
      event: 'match.timeout';
      playerIds: string[];
      code: number;
      message: string;
    };
```

```ts
  /**
   * §8.2：匹配成功后必须**主动**向每名人类玩家下发 `room.matched { roomCode, seat }`。
   * 客户端在此之前不知道 `roomCode`，所以不能用 `room.join` 的 ack 作为通知手段。
   *
   * R46：匹配超时（`12007`）经同一条通道下发为 `system.error`
   * —— 它是「非请求触发的系统错误」（§6.3），且客户端 `CLIENT_ACTION[12007] = TOAST`。
   */
  onMatchEvent(event: MatchEvent): void {
    if (event.event === 'match.timeout') {
      for (const playerId of event.playerIds) {
        this.activeConnections
          .get(playerId)
          ?.emit('system.error', envelope(0, { code: event.code, message: event.message }));
      }
      this.logger.log(`match.timeout sent to ${event.playerIds.length} player(s)`);
      return;
    }

    for (const { userId, seat } of event.seats) {
      this.seatOwners.set(`${event.roomCode}:${seat}`, userId);
      this.activeConnections
        .get(userId)
        ?.emit('room.matched', envelope(0, { roomCode: event.roomCode, seat }));
    }
    this.logger.log(`room.matched sent for ${event.roomCode} (${event.seats.length} players)`);
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS

- [ ] **Step 6: 全量验证并提交**

```bash
pnpm --filter @fight-the-landlord/room-service test && pnpm test && pnpm lint
git add packages/room-service
git commit -m "fix(room-service): 30 秒等待窗口 → 冷启动补机器人，超时回退 12007（§8.2/§8.4，R44/R46/R47）"
```

---

## Task 3: 出站裁剪 —— 机器人身份不可区分 + 投递路由分离（§6.4 规则 3 / §9.8）（后端 agent）

**为什么必须做**：Task 2 让机器人**真的**进入房间（30 秒窗口后）。而 `handleJoin` 的 ack 与
`room.state_update` 会把 `Room.players` 里的 `bot-<uuid>` 原样下发 —— §9.8 第一条是机械规则：
「任何下发给客户端的消息中不得出现 `isRobot`、`botId`，或以 `bot` 为前缀的 ID」。
本片只落这一条；行为层（机器人回合驱动、思考延迟）是 Task 11。

**Files:**
- Modify: `packages/room-service/src/gateway/message.router.ts`
- Test: `packages/room-service/test/message.router.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `matchPendingKey(playerId)`；现有 `RoomsService.findOne`
- Produces:
  - `toOutboundPlayerId(userId: string, seat: number): string` —— 导出，供 gateway/测试共用；
    仅对 `bot-` 前缀做掩码（`` `seat-${seat}` ``），人类 id 原样返回
  - `buildRoomPlayers(deps, room, callerId): Promise<RoomPlayer[]>` —— 语义不变，但**返回裁剪后的 id**

- [ ] **Step 1: 写失败测试**

在 `packages/room-service/test/message.router.test.ts` 的 `room.join / room.state_update 裁剪` 区块里新增：

```ts
it('room.join ack 中机器人 id 不以 bot 为前缀（§9.8）', async () => {
  const { deps, rooms } = makeDeps();
  rooms.findOne.mockResolvedValue({
    ...roomInfo('ROOM1'),
    players: ['alice', 'bot-abc', 'bot-def'],
  });

  const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

  expect(ack.code).toBe(0);
  const data = ack.data as { seat: number; players: Array<{ id: string; seat: number }> };
  expect(data.seat).toBe(0);
  expect(data.players.map((p) => p.seat)).toEqual([0, 1, 2]);
  expect(data.players.some((p) => p.id.startsWith('bot'))).toBe(false);
  expect(JSON.stringify(data)).not.toContain('bot');
});

it('投递路由表登记的仍是**真实** id（反向断言：掩码不得进入 seatOwners）', async () => {
  const { deps, rooms, seatEvents } = makeDeps();
  rooms.findOne.mockResolvedValue({
    ...roomInfo('ROOM1'),
    players: ['alice', 'bot-abc'],
  });

  await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

  // 若这里拿到 `seat-1`，game.deal 就会投递到一个不存在的玩家 → 机器人座位永远收不到牌
  expect(seatEvents).toHaveLength(1);
  expect(seatEvents[0]!.seats).toEqual([
    { userId: 'alice', seat: 0 },
    { userId: 'bot-abc', seat: 1 },
  ]);
});

it('toOutboundPlayerId 只掩码 bot- 前缀', () => {
  expect(toOutboundPlayerId('bot-abc', 1)).toBe('seat-1');
  expect(toOutboundPlayerId('11111111-2222-3333-4444-555555555555', 2)).toBe(
    '11111111-2222-3333-4444-555555555555',
  );
});

it('仅凭 match:pending 入房时座位取 pending.seat（R62⑤：旧实现恒回落 0）', async () => {
  const { deps, rooms, redis } = makeDeps();
  rooms.findOne.mockResolvedValue({
    ...roomInfo('ROOM9'),
    players: ['bob'], // alice 还不在成员表里，只有 pending
  });
  await redis.hset('match:pending:alice', 'roomCode', 'ROOM9');
  await redis.hset('match:pending:alice', 'seat', '2');

  const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM9' }));

  expect(ack.code).toBe(0);
  expect((ack.data as { seat: number }).seat).toBe(2);
});
```

另外补一条 `game.start` 的 id 契约反向断言（**R62⑥ / 后端 F9**）：`startGame` 发往 game-service 的
`players[].id` 必须是**真实** id —— 送 `seat-1` 会让 game-service 里根本不存在该座位
（`GameSession.players` 按 id 建）。这条在 `match.service.test.ts` 里用「补位成局后
`game.start` 的 body 含真实 `bot-*` id」来钉（让 robot 替身按 `seat` 返回**不同**的 id，
从而同时验证「哪张票去了哪个座位」）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @fight-the-landlord/room-service test -- message.router`
Expected: FAIL —— `toOutboundPlayerId is not a function`

- [ ] **Step 3: 改 `message.router.ts`**

```ts
/**
 * §9.8（机械规则）：下发给客户端的 id **不得以 `bot` 为前缀**。
 *
 * 机器人用**按座位派生的稳定不透明 id**。稳定性是必须的：前端按 `id` 给列表做 key，
 * 每次下发都变会让整张列表重排。
 *
 * ⚠️ **只用于出站载荷**。服务端内部的座位归属与 `game.deal` 投递路由
 * （`seatOwners` / `activeConnections`）**必须用 `Room.players` 里的真实 id**，
 * 否则推送到不了机器人座位。见 `handleJoin` 的注释。
 */
export function toOutboundPlayerId(userId: string, seat: number): string {
  return userId.startsWith('bot-') ? `seat-${seat}` : userId;
}
```

```ts
export async function buildRoomPlayers(
  deps: RouterDeps,
  room: Room,
  _callerId: string,
): Promise<RoomPlayer[]> {
  const players: RoomPlayer[] = [];
  for (const [seat, id] of room.players.entries()) {
    // §6.4 规则 3：只允许 { id, seat, cardCount? }，**绝不含 isRobot**；
    // §9.8：id 过一遍掩码，机器人不得以 bot- 前缀出站（R48）。
    const player: RoomPlayer = { id: toOutboundPlayerId(id, seat), seat };
    if (room.status === 'playing') {
      const count = await deps.redis.hget(`room:${room.code}:cardcount`, id);
      if (count !== null) player.cardCount = Number(count);
    }
    players.push(player);
  }
  return players;
}
```

`handleJoin` 改为「出站用掩码列表、路由用真实列表」：

```ts
async function handleJoin(
  socket: Socket,
  deps: RouterDeps,
  roomCode: string,
  userId: string,
): Promise<Ack> {
  const room = await deps.rooms.findOne(roomCode);
  if (!room) return fail(ErrCode.ROOM_NOT_FOUND, 'Room not found');

  // 座位必须从**真实**的 room.players 上取：出站 id 被掩码过，不能再拿它反查座位（R48）。
  const realSeat = room.players.indexOf(userId);
  const pendingRoom = await deps.redis.hget(matchPendingKey(userId), 'roomCode');
  if (realSeat < 0 && pendingRoom !== roomCode) {
    return fail(ErrCode.NOT_IN_ROOM, 'You are not in this room');
  }
  const seat = realSeat >= 0 ? realSeat : Number((await deps.redis.hget(matchPendingKey(userId), 'seat')) ?? 0);

  await socket.join(roomCode);
  // §6.6.1 刷新时机 1：`room.join` 成功 → 建立可恢复点。
  await deps.reconnect.touch(userId, socket.id, roomCode);

  const players = await buildRoomPlayers(deps, room, userId);
  // ⚠️ **真实 id**（`room.players`），不是 `players`（出站已掩码）——见 R48。
  deps.onSeatOwners?.(
    roomCode,
    room.players.map((id, s) => ({ userId: id, seat: s })),
  );
  return ok({ roomCode, seat, players });
}
```

`import` 行补 `matchPendingKey`：

```ts
import { matchPendingKey, matchQueueKey, type MatchService } from '../match/match.service';
```

（`room.leave` / `handleReconnect` / `findActiveRoom` 里的 `match:pending:${userId}` 字面量
顺手换成 `matchPendingKey(userId)`，保证键形状只有一个真相源。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS（含既有的 `room.join` 相关用例）

- [ ] **Step 5: 全量验证并提交**

```bash
pnpm --filter @fight-the-landlord/room-service test && pnpm test && pnpm lint
git add packages/room-service
git commit -m "fix(room-service): 机器人出站 id 掩码，投递路由仍用真实 id（§6.4/§9.8，R48）"
```

---

## Task 4: 前端 —— `room.matched` → 自动 `room.join` → 进牌桌（§8.2）（前端 agent）

**Files:**
- Modify: `apps/client/src/net/socket.ts`（新增公开 `sendQueued`）
- Modify: `apps/client/src/composables/useGameSession.ts`（`onRoomMatched` 改为「记房间 → join → ack 0 才导航」）
- Create: `apps/client/test/room-matched-join.test.ts`
- Modify: `apps/client/test/ui-flow.test.ts`（删掉手动 `room.join`，已自动）

**Interfaces:**
- Consumes: `GameClient.send` / `whenIdle`（内部）、`RequestOutcome`、`ErrCode`、`useAuthStore().navigate`、`useGameStore.applyRoomState`
- Produces:
  - `GameClient.sendQueued(type: ClientMessageType, payload?: unknown, maxAttempts?: number): Promise<RequestOutcome>`
    —— 撞上在途请求时**等空闲 + 有界重试**（每一次 `send()` 都消耗一次配额 ⇒ 全局有界，R60）；
    会话已拆除时**reject**（与 `send` 同语义）
  - `useGameSession` 行为：`room.matched` → 自动 `room.join` → ack `code 0` 才 `auth.navigate('table')`

- [ ] **Step 1: 写失败测试**

Create `apps/client/test/room-matched-join.test.ts`：

```ts
/**
 * R50 / §8.2：收到 `room.matched` 后必须自动 `room.join`，且**只有 ack code 0 才导航**。
 *
 * 这条接线此前完全不存在（前端只 setRoom + navigate），后果是服务端从不写
 * `reconnect:active`、`socket.join(roomCode)` 从不发生。因此断言必须钉住
 * 「join 真的发出去了」而不只是「页面变了」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ErrCode } from '@fight-the-landlord/protocol';
import { FakeSocket, serverMessage, playerViewFixture } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.resetModules();
  localStorage.clear();
});

afterEach(async () => {
  const { stopGameSession } = await import('../src/composables/useGameSession');
  stopGameSession();
});

async function boot() {
  const { startGameSession } = await import('../src/composables/useGameSession');
  const { useAuthStore } = await import('../src/stores/auth');
  const { useGameStore } = await import('../src/stores/game');
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const auth = useAuthStore();
  auth.enterAsDevUser(); // 登录态：page = 'lobby'
  return { socket, auth, store: useGameStore() };
}

describe('room.matched → 自动进房（§8.2 / R50）', () => {
  it('收到 room.matched 就发 room.join，ack code 0 之后才导航到牌桌', async () => {
    const { socket, auth, store } = await boot();

    socket.push(serverMessage('room.matched', { roomCode: 'ROOM1', seat: 1 }, 0));

    const joins = socket.emittedOf('room.join');
    expect(joins).toHaveLength(1);
    expect(joins[0]!.env.payload).toEqual({ roomCode: 'ROOM1' });
    // 还没拿到 ack → 不得导航（旧实现正是在这里直接 navigate）
    expect(auth.page).toBe('lobby');
    expect(store.roomCode).toBe('ROOM1'); // 但房间号必须先记住（重连/离开都要用）

    joins[0]!.ack(null, {
      code: 0,
      data: {
        roomCode: 'ROOM1',
        seat: 1,
        players: [
          { id: 'p0', seat: 0 },
          { id: 'p1', seat: 1 },
          { id: 'p2', seat: 2 },
        ],
      },
    });

    await vi.waitFor(() => expect(auth.page).toBe('table'));
    expect(store.roomPlayers.map((p) => p.seat)).toEqual([0, 1, 2]);
  });

  it('room.join 被拒（12004）→ 不导航、清空对局渲染状态', async () => {
    const { socket, auth, store } = await boot();

    socket.push(serverMessage('room.matched', { roomCode: 'ROOM1', seat: 0 }, 0));
    socket.emittedOf('room.join')[0]!.ack(null, { code: ErrCode.NOT_IN_ROOM, message: 'not a member' });

    await vi.waitFor(() => expect(store.roomCode).toBeNull());
    expect(auth.page).not.toBe('table');
  });

  it('撞上在途请求时等待空闲后重试，**不得**静默丢弃（R50）', async () => {
    const { socket, auth } = await boot();
    const { getGameSession } = await import('../src/composables/useGameSession');
    const client = getGameSession().client;

    // 先占住串行队列：一次没有 ack 的 game.resync
    const inflight = client.resync();

    socket.push(serverMessage('room.matched', { roomCode: 'ROOM1', seat: 0 }, 0));
    // 队列忙 → 不能抢槽位，也**不能**就此放弃
    expect(socket.emittedOf('room.join')).toHaveLength(0);

    socket.emittedOf('game.resync')[0]!.ack(null, {
      code: 0,
      data: playerViewFixture({ version: 3, seat: 0 }),
    });
    await inflight;

    await vi.waitFor(() => expect(socket.emittedOf('room.join')).toHaveLength(1));
    socket.emittedOf('room.join')[0]!.ack(null, {
      code: 0,
      data: { roomCode: 'ROOM1', seat: 0, players: [{ id: 'p0', seat: 0 }] },
    });
    await vi.waitFor(() => expect(auth.page).toBe('table'));
  });
});
```

`apps/client/test/ui-flow.test.ts` 里删掉这一段（join 已经自动发生，手动再发一次属于重复请求）：

```ts
        const joined = await session.client.send('room.join', { roomCode: store.roomCode! });
        expect(joined.status === 'sent' && joined.code).toBe(0);
        await sleep(400);
```

换成：

```ts
        // R50：room.matched 之后前端已自动 room.join（不必也不该再发一次）
        await sleep(400);
        expect(store.roomPlayers.length).toBe(3);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/client && pnpm test -- room-matched-join`
Expected: FAIL —— `socket.emittedOf('room.join')` 长度为 0（当前实现从不 join）

- [ ] **Step 3: 给 `GameClient` 加公开的 `sendQueued`**

放在 `send()` 之后、`reportErrorCode()` 之前（**不改 `send()` 的任何行为**）：

```ts
  /**
   * 等待串行队列空闲后发送 —— 用于**服务端主动推进之后**的自动跟进请求
   * （本片唯一的调用点是 `room.matched` → `room.join`，R50）。
   *
   * 与 `send()` 的唯一区别：撞上在途请求时**不把 `blocked` 直接甩给调用方**，
   * 而是走 `whenIdle` 的电平触发等待，直到拿到非 `blocked` 的结果或尝试次数用尽。
   *
   * **每一次 `send()` 调用都消耗一次尝试配额**（**包括**「被 `CLIENT_ACTION` 的恢复请求抢先」
   * 这种没抢到槽位的情形）⇒ 本方法**全局有界**，不存在「等待者被反复抢先而无限等待」。
   *
   * ⚠️ R67：恢复请求（`13004` → `game.resync`）**不是**「排队等下一次空闲」——
   * `finishRequest` 先清空槽位，`notifyAction` 里同步的 `send()` 会**立即 emit** 拿到它；
   * 紧接着的 `flushIdleWaiters` 因 `pending !== null` 整体早退，本方法的等待者被推迟到
   * 该请求释放槽位时才唤醒 —— 于是重试落在**已空的槽位**上，**通常直接成功**。
   * 因此「重试时槽位被抢走」构造不出来；返回 `blocked` 的条件是
   * 「**最后一次**尝试本身就撞上在途请求」。
   *
   * 会话已拆除时**reject**（与 `send()` 同语义）——调用方据此识别「用户已登出」。**不轮询**。
   */
  async sendQueued(type: ClientMessageType, payload: unknown = {}, maxAttempts = 5): Promise<RequestOutcome> {
    let attempts = 0;
    const sendOnce = (): Promise<RequestOutcome> => {
      attempts += 1;
      return this.send(type, payload);
    };

    let outcome = await sendOnce();
    while (outcome.status === 'blocked' && attempts < maxAttempts) {
      outcome = await new Promise<RequestOutcome>((resolve, reject) => {
        this.whenIdle(() => {
          void sendOnce().then(resolve, reject);
        });
      });
    }
    return outcome;
  }
```

- [ ] **Step 4: 改 `useGameSession.createSessionOptions`**

在 `createSessionOptions` 内部（`options` 定义之前）加：

```ts
  /**
   * R50 / §8.2：**收到 `room.matched` 后必须 `room.join`**，且只有 ack `code 0` 才进牌桌。
   *
   * 不 join 的后果（旧实现的真实缺陷）：服务端不写 `reconnect:active`、
   * `socket.join(roomCode)` 从不发生、`room.join` ack 里的 `players` 从不被消费。
   */
  async function joinMatchedRoom(roomCode: string): Promise<void> {
    const client = sessionRef.client;
    if (!client) return;
    let outcome: RequestOutcome;
    try {
      outcome = await client.sendQueued('room.join', { roomCode });
    } catch {
      return; // 会话已被拆除（登出/销毁）：不导航、不提示
    }
    if (outcome.status !== 'sent') {
      // R60：尝试次数用尽仍被串行队列挡住（同一刻被 CLIENT_ACTION 的恢复请求连续抢先）。
      // 这里**不**丢局：服务端此时已写 `match:pending` + `reconnect:active`（Task 2/Task 3），
      // 断线重连路径（§6.6）仍能把玩家送回这间房；因此只提示，不新加自动重试机制。
      notice.value = { level: 'warn', text: '进房失败，请重试' };
      return;
    }
    if (outcome.code !== 0) {
      // 非 0 已由 CLIENT_ACTION 表派发（12004/12001 → BACK_TO_LOBBY）。
      // 这里只保证「被拒就不导航、不留下半个房间状态」。
      store.reset();
      return;
    }
    const data = outcome.data as { players?: RoomPlayerLike[] } | undefined;
    // R61：`room.join` 的 ack **没有** `status`（`room.state_update` 才带）——
    // 只消费它真给了的 `players`，**不要**伪造一个服务端没说的房间状态。
    store.applyRoomState({ players: data?.players ?? [] });
    auth.navigate('table');
  }
```

把 `onRoomMatched` 换成：

```ts
    onRoomMatched: (payload) => {
      // 先记住房间号：重连、离开、`game.resync` 的兜底都要用它（§8.2）。
      store.setRoom(payload.roomCode, payload.seat);
      // R49：已成局 → 匹配中状态终止（大厅按钮不再是「正在匹配…」）
      store.setMatching(false);
      // R50：§8.2 —— 收到推送后**主动进房**，成功才导航。
      void joinMatchedRoom(payload.roomCode);
    },
```

`import` 顶部补：

```ts
import type { RequestOutcome } from '../net/socket';
```

（`RoomPlayerLike` 已在本文件定义；`store.setMatching` / `applyRoomState` 的可选 `status`
都在**本任务的 Step 5** 一并加到 store —— Task 5 只负责 `12007` 复位与页面接线，不再重复添加。）

- [ ] **Step 5: 让 Task 4 自洽 —— 先把 store 的 `matching` 加进去**

`apps/client/src/stores/game.ts`：

```ts
    /** R49：是否正在匹配中。页面不持有它 —— 否则 12007 到达时页面无法感知。 */
    matching: false,
```

actions 里加：

```ts
    setMatching(matching: boolean) {
      this.matching = matching;
    },
```

`reset()` 里补一行 `this.matching = false;`。

同一文件里**再改一处**（R61）：`applyRoomState` 的 `status` 改成**可选**，只在服务端真给了状态时才写：

```ts
    applyRoomState(payload: { status?: string; players: RoomPlayerView[] }) {
      // R61：`room.join` 的 ack **没有** `status`（只有 `room.state_update` 才带）。
      // 没给就不写 —— 宁可留空，也不要伪造一个服务端没说的房间状态。
      if (payload.status !== undefined) this.roomStatus = payload.status;
      this.roomPlayers = payload.players;
      const me = payload.players.find((p) => p.seat === this.mySeat);
      if (me) this.mySeat = me.seat;
    },
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd apps/client && pnpm test`
Expected: PASS（含新增 3 条）

- [ ] **Step 7: 提交**

```bash
git add apps/client/src/net/socket.ts apps/client/src/composables/useGameSession.ts \
        apps/client/src/stores/game.ts apps/client/test/room-matched-join.test.ts \
        apps/client/test/ui-flow.test.ts
git commit -m "feat(client): room.matched 后自动 room.join，ack 成功才进牌桌（§8.2/R50）"
```

---

## Task 5: 前端 —— 大厅匹配/取消的 UX 与错误码分工（§6.3 / §11.2 / R49 / R51）（前端 agent）

**Files:**
- Modify: `apps/client/src/stores/game.ts`（`applyEvent` 处理 `12007` → 复位 `matching`）
- Modify: `apps/client/src/pages/lobby.vue`（`matching` 改读 store；`12009` 幂等；`unmatch` 校验 ack；手动加入消费 `players` —— R61）
- Test: `apps/client/test/auth-ui-wiring.test.ts`（新增匹配/取消/12009/12007 的页面接线用例）
- Test: `apps/client/test/match-state.test.ts`（Create：store 层 12007 复位）
- Test: `apps/client/test/reconnect-flow.test.ts`（**R59**：修既有 flake，**test-only、单独提交**）

**Interfaces:**
- Consumes: Task 4 的 `useGameStore.matching` / `setMatching`（**状态字段由 Task 4 Step 5 添加**，本任务只加 `12007` 复位与页面接线）
- Produces: `lobby.vue` 的匹配按钮状态完全来自 `store.matching`；`12009` 不再被当成失败

- [ ] **Step 1: 写失败测试**

新建 `apps/client/test/match-state.test.ts`（**不要新建测试助手**：本仓库的 store 测试一律
`setActivePinia(createPinia())` + 直接 `useGameStore()`）：

```ts
/**
 * R49：匹配中状态归 store，并由「成局」与「12007 超时」两条路径复位。
 *
 * 这条断言钉住的是**没发生的事**：12007 到达后按钮不能再停在「正在匹配…」。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../src/stores/game';

describe('匹配中状态（R49）', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('12007（匹配超时）到达 → matching 复位，并留下一条 error 通知', () => {
    const store = useGameStore();
    store.setMatching(true);

    store.applyEvent({
      type: 'system.error',
      version: 0,
      payload: { code: 12007, message: 'Match timed out' },
    });

    expect(store.matching).toBe(false);
    expect(store.notices.at(-1)).toMatchObject({ level: 'error', code: 12007 });
  });

  it('其它 system.error 不复位 matching（只有 12007 是匹配的终止信号）', () => {
    const store = useGameStore();
    store.setMatching(true);

    store.applyEvent({
      type: 'system.error',
      version: 0,
      payload: { code: 10007, message: 'upstream down' },
    });

    expect(store.matching).toBe(true);
  });

  it('reset() 也清 matching（回大厅不留下永久「匹配中」）', () => {
    const store = useGameStore();
    store.setMatching(true);
    store.reset();
    expect(store.matching).toBe(false);
  });
});
```

在 `apps/client/test/auth-ui-wiring.test.ts` 追加：

```ts
describe('lobby.vue 的匹配按钮（§6.3 / R51）', () => {
  function mountLobbyWithSocket() {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    return { wrapper, socket: sockets[0]! };
  }

  it('点「随机匹配」发 room.match；ack 0 → 切换到「正在匹配…/取消匹配」', async () => {
    stubFetch({ code: 0, data: [] });
    const { wrapper, socket } = mountLobbyWithSocket();
    await flushPromises();

    await wrapper.find('.lobby__match button').trigger('click');
    expect(socket.emittedOf('room.match')).toHaveLength(1);

    socket.emittedOf('room.match')[0]!.ack(null, { code: 0 });
    await flushPromises();

    expect(flat(wrapper.text())).toContain('正在匹配');
    expect(flat(wrapper.text())).toContain('取消匹配');
    expect(flat(wrapper.text())).not.toContain('匹配失败');
  });

  it('ack 12009（已在队列中）是**幂等成功**：进入匹配中，不报错（R51）', async () => {
    stubFetch({ code: 0, data: [] });
    const { wrapper, socket } = mountLobbyWithSocket();
    await flushPromises();

    await wrapper.find('.lobby__match button').trigger('click');
    socket.emittedOf('room.match')[0]!.ack(null, { code: 12009, message: 'Already in the match queue' });
    await flushPromises();

    expect(flat(wrapper.text())).toContain('取消匹配');
    expect(flat(wrapper.text())).not.toContain('匹配失败');
  });

  it('取消匹配发 room.unmatch；ack 0 → 回到「随机匹配」', async () => {
    stubFetch({ code: 0, data: [] });
    const { wrapper, socket } = mountLobbyWithSocket();
    await flushPromises();

    await wrapper.find('.lobby__match button').trigger('click');
    socket.emittedOf('room.match')[0]!.ack(null, { code: 0 });
    await flushPromises();

    await wrapper.find('.lobby__match button').trigger('click'); // 现在这个按钮是「取消匹配」
    expect(socket.emittedOf('room.unmatch')).toHaveLength(1);
    socket.emittedOf('room.unmatch')[0]!.ack(null, { code: 0 });
    await flushPromises();

    expect(flat(wrapper.text())).toContain('随机匹配');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/client && pnpm test -- match-state auth-ui-wiring`
Expected: FAIL —— **只有 2 条会红**：`12007` 未复位 `matching`、`12009` 走通用失败分支显示
`匹配失败（code=12009）`。
（**R58 修正**：计划初稿把「`store.matching` 未定义」也写成预期失败，但 `matching` 是 **Task 4 Step 5**
引入的，按顺序执行时它已存在 —— 所以 `reset()` 清 matching 与「其它码不复位」两条**一开始就是绿的**，
它们锁的是 Task 4 的状态而不是 Task 5 的行为。这是**计划缺陷**，不是用例缺陷：
真正的判别点在 Step 1 里另外补的那条「`12007` 经 `system.error` 推送到达 → 大厅按钮回到『随机匹配』」，
那条才钉住「matching 必须归 store」。）

- [ ] **Step 3: 改 `stores/game.ts` 的 `applyEvent`**

`case 'system.error':` 里补一条（**放在 push notice 之前或之后都可以，但必须在同一个 case 内**）：

```ts
        case 'system.error':
        case 'system.warning':
          this.notices.push({
            level: event.type === 'system.error' ? 'error' : 'warning',
            code: event.payload.code,
            message: event.payload.message,
            version,
          });
          // R49：`12007`（MATCH_TIMEOUT）是匹配的**终止**信号 —— 必须复位匹配中状态，
          // 否则大厅按钮永久停在「正在匹配…」，用户再也点不了第二次。
          if (event.type === 'system.error' && event.payload.code === ErrCode.MATCH_TIMEOUT) {
            this.matching = false;
          }
          break;
```

`import` 顶部改成值导入（**只**是错误码常量，不含任何游戏规则，不违反 F01/F02）：

```ts
import { ErrCode, type PlayerView, type ServerMessage, type SettlementResult } from '@fight-the-landlord/protocol';
```

- [ ] **Step 4: 改 `pages/lobby.vue`**

```ts
import { computed, onMounted, ref } from 'vue';
import { ErrCode } from '@fight-the-landlord/protocol';
```

删除 `const matching = ref(false);`，改为：

```ts
/** R49：匹配中状态归 store —— 页面局部 ref 收不到 12007 的复位信号。 */
const matching = computed(() => store.matching);
```

`match()`：

```ts
async function match() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const outcome = await getGameSession().client.send('room.match', { mode: 'random' });
    if (outcome.status === 'blocked') {
      error.value = '上一个操作还在进行中，请稍候';
      return;
    }
    // R51：12009 = 已在队列中，`CLIENT_ACTION` 表把它归为 IGNORE ⇒ 处置层什么也没做，
    // 页面必须自己把它当成**幂等成功**（用户点了两次，结果一样）。
    if (outcome.code === ErrCode.ALREADY_IN_QUEUE) {
      store.setMatching(true);
      return;
    }
    if (outcome.code !== 0) {
      error.value = `匹配失败（code=${outcome.code}）`;
      return;
    }
    store.setMatching(true);
  } finally {
    busy.value = false;
  }
}
```

`unmatch()`：

```ts
async function unmatch() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const outcome = await getGameSession().client.send('room.unmatch', {});
    if (outcome.status === 'blocked') {
      error.value = '上一个操作还在进行中，请稍候';
      return;
    }
    if (outcome.code !== 0) {
      error.value = `取消失败（code=${outcome.code}）`;
      return;
    }
    store.setMatching(false);
  } finally {
    busy.value = false;
  }
}
```

模板**不改**（`v-if="!matching"` 对 computed 一样成立）。

**同一文件里再统一「手动输入房间号加入」这条路（R61）** —— 它此前只 `setRoom` + `navigate`，
**不消费** ack 里的 `players`，于是同一条 `room.join` 有两条状态写入不一致的路径：

```ts
async function join() {
  const code = joinCode.value.trim().toUpperCase();
  if (!code || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const outcome = await getGameSession().client.send('room.join', { roomCode: code });
    if (outcome.status === 'blocked') {
      error.value = '上一个操作还在进行中，请稍候';
      return;
    }
    if (outcome.code !== 0) {
      error.value = `加入房间失败（code=${outcome.code}）`;
      return;
    }
    // R61：与自动进房用**同一个**状态写入（ack 的 players 是要消费的载荷）。
    const data = outcome.data as { seat?: number; players?: { id: string; seat: number }[] } | undefined;
    store.setRoom(code, typeof data?.seat === 'number' ? data.seat : -1);
    store.applyRoomState({ players: data?.players ?? [] });
    auth.navigate('table');
  } finally {
    busy.value = false;
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/client && pnpm test && pnpm lint && pnpm build`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add apps/client/src/stores/game.ts apps/client/src/pages/lobby.vue \
        apps/client/test/match-state.test.ts apps/client/test/auth-ui-wiring.test.ts
git commit -m "feat(client): 匹配中状态归 store，12009 幂等、12007 复位（R49/R51）"
```

---

## Task 6: conformance —— 切片 7 用例（协调者）

**Files:**
- Create: `tools/conformance/src/slices/slice-07-match-join.ts`
- Modify: `tools/conformance/src/run.ts`
- Modify: `tools/conformance/package.json`
- （按需）Modify: `tools/conformance/src/lib/client.ts`（只在缺一个「按条件等待」原语时；优先不加）

**Interfaces:**
- Consumes: `HarnessClient`（切片 5 已有）、`registerUser` / `postJson` / `getJson`（`lib/http.ts`）、
  `Checks` / `step` / `info` / `assertNoLeak` / `sleep`（`lib/assert.ts`）、真实后端 3000–3003 + Redis + MySQL
- Produces: `runSlice07(): Promise<Checks>`

> ⚠️ **陷阱（必须绕开）**：`assertNoLeak()` 的黑名单含 `players`。
> `room.join` 的 ack **合法地**带 `data.players: RoomPlayer[]`（§6.3），
> **不得**对它调用 `assertNoLeak()` —— 那是给 `PlayerView` 类载荷（`game.*`）用的。
> 房间成员要**手写**断言：恰好 `{ roomCode, seat, players }`，每个元素恰好 `{ id, seat }`（或 + `cardCount`）。

- [ ] **Step 1: 写用例**

Create `tools/conformance/src/slices/slice-07-match-join.ts`：

```ts
/**
 * 切片 7 conformance：匹配 → 进房（§8.1/§8.2/§8.4/§9.8）。
 *
 * 判别力说明（为什么这些断言不是「复述实现」）：
 *  - 3 人成局这条路径切片 5 已经在跑，因此本用例的判别力来自**其余六组**：
 *    12009 重复入队、取消后可重排、席位一致性、成员裁剪与机器人 id 掩码、
 *    非成员 join 的 12004、以及**30 秒窗口后的冷启动补机器人**；
 *  - 最后一条直接判别 R44：旧实现在这里会把等待的玩家**静默丢掉**，
 *    永远不会下发 `room.matched`。
 */
import { ErrCode } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, info, step } from '../lib/assert';
import { registerUser, type HarnessUser } from '../lib/http';
import { HarnessClient } from '../lib/client';

interface RoomPlayerWire {
  id: string;
  seat: number;
  cardCount?: number;
}

export async function runSlice07(): Promise<Checks> {
  const checks = new Checks();
  const clients: HarnessClient[] = [];
  let lone: HarnessClient | undefined;

  try {
    step('准备 5 个真实账号（3 人成局 + 1 个非成员 + 1 个单人等补机器人）');
    const users: HarnessUser[] = [];
    for (let i = 0; i < 5; i += 1) users.push(await registerUser(i));
    for (let i = 0; i < 3; i += 1) clients.push(await HarnessClient.connect(`P${i}`, users[i]!));
    checks.ok('3 个客户端完成握手');

    // ── 1) 入队与幂等（§6.3：12009） ────────────────────────────────
    step('room.match ×3 → code 0；重复 room.match → 12009');
    for (const client of clients) {
      const ack = await client.send('room.match', { mode: 'random' });
      checks.eq(ack.code, ErrCode.OK, `${client.label} room.match code`);
    }
    const dup = await clients[0]!.send('room.match', { mode: 'random' });
    checks.eq(dup.code, ErrCode.ALREADY_IN_QUEUE, 'P0 重复 room.match code');

    // ── 2) 取消与重排（§6.3 room.unmatch） ──────────────────────────
    step('P2 room.unmatch → 0；再 room.match → 0（取消后可重排）');
    checks.eq((await clients[2]!.send('room.unmatch', {})).code, ErrCode.OK, 'P2 room.unmatch code');
    checks.eq((await clients[2]!.send('room.match', { mode: 'random' })).code, ErrCode.OK, 'P2 重排 code');

    // ── 3) 成局与 room.matched（§8.2） ──────────────────────────────
    step('3 人入队 → 成局 → 三方都收到 room.matched');
    const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', 25_000)));
    const roomCode = matched[0]!.payload.roomCode as string;
    checks.that(typeof roomCode === 'string' && roomCode.length > 0, `roomCode = ${roomCode}`);
    checks.eq(matched[1]!.payload.roomCode, roomCode, 'P1 的 roomCode 与 P0 一致');
    checks.eq(matched[2]!.payload.roomCode, roomCode, 'P2 的 roomCode 与 P0 一致');

    const seats = matched.map((m) => m.payload.seat as number);
    checks.eq(new Set(seats).size, 3, '三个座位号互不相同');
    checks.eq([...seats].sort().join(','), '0,1,2', '三座位恰好是 0/1/2');

    // ── 4) room.join：席位一致 + 载荷裁剪 + §9.8 掩码 ────────────────
    step('room.join ×3：ack 席位与 room.matched 一致，成员载荷恰好 3 项且无 bot 前缀 id');
    for (const [i, client] of clients.entries()) {
      const ack = await client.send('room.join', { roomCode });
      checks.eq(ack.code, ErrCode.OK, `${client.label} room.join code`);
      checks.eq(ack.data?.roomCode, roomCode, `${client.label} ack.roomCode`);
      checks.eq(ack.data?.seat, seats[i], `${client.label} ack.seat 与 room.matched 一致`);

      const players = (ack.data?.players ?? []) as RoomPlayerWire[];
      checks.eq(players.length, 3, `${client.label} ack.players 数量`);
      for (const p of players) {
        const keys = Object.keys(p).sort().join(',');
        if (keys !== 'id,seat' && keys !== 'cardCount,id,seat') {
          throw new Error(`${client.label} ack.players 元素字段非法：${keys}`);
        }
        if (p.id.startsWith('bot')) throw new Error(`${client.label} 泄漏了 bot 前缀 id：${p.id}`);
      }
      checks.ok(`${client.label} ack.players 裁剪正确（无 isRobot / 无 bot 前缀 id）`);
      if (JSON.stringify(ack.data).includes('isRobot')) {
        throw new Error(`${client.label} ack 出现 isRobot（§6.4 规则 3 / §9.8）`);
      }
    }

    // ── 5) 进房后能收到 game.deal（§8.2：「并开始接收 game.* 推送」） ──
    step('room.join 后三方都收到 game.deal（无 §6.4 泄漏）');
    const deals = await Promise.all(clients.map((c) => c.waitFor('game.deal', 25_000)));
    for (const [i, deal] of deals.entries()) {
      assertNoLeak(deal.payload, `game.deal(P${i})`);
      checks.eq(deal.payload.seat, seats[i], `P${i} game.deal.seat 与 ack.seat 一致`);
    }

    // ── 6) 反例：非成员 join（§5.3 越权防护 / 12004） ────────────────
    step('反例：第 4 个账号 room.join 同一房间 → 12004（**不是** 12001）');
    const stranger = await HarnessClient.connect('stranger', users[3]!);
    try {
      const ack = await stranger.send('room.join', { roomCode });
      checks.eq(ack.code, ErrCode.NOT_IN_ROOM, '非成员 room.join code（房间存在，故不是 12001）');
    } finally {
      stranger.close();
    }
    const ghost = await clients[0]!.send('room.join', { roomCode: 'NOPE99' });
    checks.eq(ghost.code, ErrCode.ROOM_NOT_FOUND, '不存在的房间 → 12001');

    // ── 7) 30 秒窗口 → 冷启动补机器人（§8.4②/R44）──────────────────
    step('单人在队列里等 30 秒 → 必须收到 room.matched（补机器人），而不是被静默丢弃');
    lone = await HarnessClient.connect('lone', users[4]!);
    const loneMatch = await lone.send('room.match', { mode: 'random' });
    checks.eq(loneMatch.code, ErrCode.OK, '单人 room.match code');

    const loneMatchedAt = Date.now();
    const loneMatched = await lone.waitFor('room.matched', 50_000);
    info(`单人等待 ${((Date.now() - loneMatchedAt) / 1000).toFixed(1)}s 后成局（窗口 30s + 扫描 ≤5s）`);
    const loneRoom = loneMatched.payload.roomCode as string;
    checks.that(typeof loneRoom === 'string' && loneRoom.length > 0, `补位房间 roomCode = ${loneRoom}`);

    const loneAck = await lone.send('room.join', { roomCode: loneRoom });
    checks.eq(loneAck.code, ErrCode.OK, '单人 room.join code');
    const lonePlayers = (loneAck.data?.players ?? []) as RoomPlayerWire[];
    checks.eq(lonePlayers.length, 3, '补位后房间恰好 3 席');
    if (lonePlayers.some((p) => p.id.startsWith('bot'))) {
      throw new Error(`补位房间泄漏 bot 前缀 id：${JSON.stringify(lonePlayers)}`);
    }
    checks.ok('补位房间成员 id 全部不可区分（§9.8）');

    // 30 秒窗口本身：不超过 30s 就成局说明窗口被绕过（bots 过早补），也属违规
    const waitedMs = Date.now() - loneMatchedAt;
    checks.that(waitedMs >= 25_000, `单人等满等待窗口才补位（实测 ${(waitedMs / 1000).toFixed(1)}s ≥ 25s）`);

    return checks;
  } finally {
    lone?.close();
    for (const client of clients) client.close();
  }
}
```

> **关于 `checks.eq(ack.data?.seat, seats[i], ...)`**：`seats[i]` 来自 `room.matched`，
> 顺序按 `clients` 数组；`Promise.all` 保序，所以下标对齐 —— 这正是要断言的不变量。

- [ ] **Step 2: 注册进 `run.ts`**

```ts
import { runSlice07 } from './slices/slice-07-match-join';

const CASES: Record<string, Case> = {
  'slice-05': { title: '断线重连', run: runSlice05 },
  'slice-06': { title: '登录 + 房间列表', run: runSlice06 },
  'slice-07': { title: '匹配 → 进房', run: runSlice07 },
};
```

`tools/conformance/package.json` 的 scripts 补一行：

```json
    "conformance:slice-07": "node dist/run.js slice-07"
```

- [ ] **Step 3: 构建**

Run: `pnpm --filter @fight-the-landlord/conformance build`
Expected: 无 TS 错误（`tsc`）

- [ ] **Step 4: 重建镜像并跑（顺序不能反）**

```bash
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
node tools/conformance/dist/run.js slice-07
```

Expected: `✅ slice-07 通过：N 项断言`（预计 ~55s：3 人路径 ~10s + 单人补位 ~35s）

> ✅ **正对照已实测通过（协调者门禁）**：`✅ slice-07 通过：38 项断言，用时 31.9s`，
> 关键一行：`单人等待 31.4s 后成局（窗口 30s + 扫描 ≤5s）`、`补位后房间恰好 3 席 = 3`、
> `补位房间成员 id 全部不可区分（§9.8）`、`单人等满等待窗口才补位（实测 31.4s ≥ 25s）`。
> 在此之前正对照**红过一次**，根因是 **R70**（`acquireBot` 少 `/api` 前缀 → 404），
> 修好后才转绿 —— 这正是这条用例的判别力所在。

> 本机 `registry-mirrors` 全挂时**必须**用 `DOCKER_BUILDKIT=0`（见 `agent-briefs.md` 的「已知环境事实」）。
> 跑之前不重建镜像 = 测的是旧代码。

- [ ] **Step 5: 提交**

```bash
git add tools/conformance
git commit -m "test(conformance): 切片 7 用例 —— 入队/12009/取消/room.matched/进房/席位一致/30s 补机器人"
```

---

## 切片 7 门禁（三者同时通过才算完成）

```bash
# 后端 DoD
pnpm --filter @fight-the-landlord/room-service test
pnpm test && pnpm lint                       # 期望 19/19 三项

# 前端 DoD
cd apps/client && pnpm test && pnpm lint && pnpm build

# conformance（先重建镜像；镜像源挂时用经典构建器）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
node tools/conformance/dist/run.js slice-07
node tools/conformance/dist/run.js slice-06   # 回归：登录/房间列表不得被打回
node tools/conformance/dist/run.js slice-05   # 回归：断线重连不得被打回
```

**硬性回归断言**：

- `slice-05` 必须仍然全绿。它显式调用 `room.join`（写入 `reconnect:active`），而 Task 3 改了
  `handleJoin` 的座位计算与路由登记 —— 这是本片最容易打断它的地方。同时它的匹配段
  （`room.match ×3 → room.matched → game.deal`）会走过 Task 2 重写的 `processQueue`。
- `slice-06` 必须仍然全绿（房间列表用的是 `RoomsService.findAll`，本片为「孤儿房间标 cancelled」动了 `updateStatus`，
  要确认被取消的房间确实不进列表）。
- `ui-flow.test.ts`（默认跳过，需 `CLIENT_E2E=1`）里的手动 `room.join` 已删除；具备 mock/真实后端时应能跑绿。

**负对照（证明补位用例有判别力）—— 已由执行期实测完成（commit `b380b35`）**：
在**未含** R44 修复的镜像上跑 `slice-07`，**第 1–6 组 33 项断言全部通过，恰好卡在第 7 组**
（单人等待）——旧实现 `if (members.length < 3) return;` 早退，单人**从未被处理**，
`waitFor('room.matched', 50_000)` 卡满 50.0s 超时，实测总耗时 ~55.5s。
执行者当时还 `ZREM` 掉了残留在队列里的那个 member；按 **R57** 的逐票淘汰，新实现已能自愈这类残留
（把旧票单独 `12007` 掉，不影响新入队者），因此这一步不再是必需的前置。

**已知的负对照 ~2% 偶发假红窗口（不推翻结论）**：旧实现对 **2 个**候选也会立刻成局（只挡 0 候选），
而本用例第 1→2 步之间存在「队列里恰好 2 人」的 ~100ms 窗口。若 5s 扫描恰落其中，
第 3 组会以 `P2 超时` 失败而不是第 7 组 —— 这**同样**是「旧实现」的可解释行为。
修复后的实现由 `alive.length < 3 && waited < 30s → return` 兜住，不受影响。
负对照的实测结果已记录在上面（`b380b35` 那一次：33 项通过 + 第 7 组超时）。

**正对照（修复后）实测 —— 协调者门禁，`slice-07` 共三次结果，构成完整的判别力证据链**：

| 轮次 | 被测镜像 | 结果 |
|---|---|---|
| 负对照（`b380b35`） | 修复前（master 切片 6） | 第 1–6 组 33 项通过，**第 7 组超时 50s 失败** |
| 正对照第 1 次 | 后端已合并（R42–R66） | **仍然第 7 组失败** → 根因 **R70**（`/robots/create` 404） |
| 正对照第 2 次 | 后端 + R70 | ✅ **38 项断言，31.9s**，单人 31.4s 后补位成局 |

即：这条用例先证明了它能抓住**旧缺陷**，又在修复**一半**时抓住了**另一个更隐蔽的缺陷**（URL 前缀），
最后才转绿 —— 它不是在复述实现。

---

## Self-Review

**1. Spec coverage**

| §8 / §9.8 / §10 / §6.3 要求 | 落在哪个任务 |
|---|---|
| 队列键 `match:queue:{mode}:{region}`（region 维度现在就带上） | Task 1（`matchQueueKey`/`MATCH_REGIONS`）+ Task 6 断言（3 人成局即隐含单 region 有效） |
| `match:meta:{playerId}` 五字段 + TTL 300s | Task 1（`addToQueue`/`readMeta`/`attempts`） |
| `match:pending:{playerId}` = `{roomCode, seat}` + TTL 300s | Task 1（`storePending`）+ Task 2（只给人类写） |
| 匹配成功后**主动**下发 `room.matched`（§8.2 通知通路） | Task 2（`announceMatch`）+ Task 6 第 3 组（三方都收到） |
| 客户端在此之前不知道 roomCode ⇒ 不能用 join ack 通知 | Task 6 第 2→3 步的顺序本身（先 match 后 matched 再 join） |
| 30 秒等待窗口（自**最早入队者**起算） | Task 2（`BOT_FILL_WAIT_MS`）+ Task 6 第 7 组（≥25s 才成局） |
| 人数不足 → 补机器人开局（MVP 主路径） | Task 2（`acquireBot`）+ Task 6 第 7 组 |
| 回队必须保留 `enteredAt` | Task 2（候选从不 `ZREM`，score 天然不变）+ 单测反向断言 |
| `attempts >= 10` / 等待 > 60s → 三级回退 | Task 2（`failMatch`，**逐票**判定 —— R57）+ 单测「混有超时旧票」用例 |
| 回退 ③ 返回 `12007` 告知玩家 | Task 2（`match:events` → `system.error`）+ Task 5（前端复位） |
| `room.unmatch` 取消（ack） | Task 1（`cancelQueue`）+ Task 6 第 2 组 |
| `room.join` ack `{roomCode, seat, players}` | Task 3 + Task 6 第 4 组（含席位一致性） |
| `room.state_update` 必须裁剪、绝不含 `isRobot` | Task 3（`buildRoomPlayers`）+ 既有 `ws.gateway.test` 用例 |
| §9.8 出站 id 不得以 `bot` 为前缀 | Task 3（`toOutboundPlayerId`）+ Task 6 第 4/7 组 |
| §8.2 玩家收到 `room.matched` 后 `room.join` 进房 | Task 4（自动 join）+ Task 6 第 4 组 |
| `12009` 已在队列中 | Task 1（含 **R63** 孤儿成员清理）+ Task 6 第 1 组 + Task 5（前端幂等） |
| `handleMatch` 的 meta/ZSet 分叉（R63） | Task 1 Step 5 + 两条单测（孤儿→重新入队；双源都在→12009） |
| `game.start` 的 `players[].id` 是真实 id（R62⑥） | Task 2 单测（补位成局的 body 含 `bot-*`） |
| 前端：「匹配按钮、取消、room.matched 后进房」 | Task 4、Task 5 |
| §8.3 谓词框架 / `match:rejected` | **本片不做 —— R53**（见下） |
| §8.4 ① 扩大候选范围 | **MVP 无对象 —— R53**（只有一个 region） |
| §5.4 WS 限流 | **本片不做**（不在切片表第 7 行；`WS_RATE_LIMIT` 已存在） |

**已知未覆盖并显式记录**：

- **§8.3 谓词与 `match:rejected` 键（R53）**：MVP 谓词集为空，建框架只会产生无调用方的死代码；
  §8.4 自己也写明「MVP 谓词恒真，此路径不触发」。键形状保留在文档里，写入方留待引入真实谓词的那一片。
- **`12007` 路径只有单测，没有 conformance**：它要求等待 **>60 秒**（还要先让补机器人失败），
  放进 conformance 会让用例多跑一分钟去验一条**不可达于正常环境**的分支。
  判别力由 `match.service.test.ts` 的假时钟用例提供（含「不再尝试补位」「出队 + 删 meta」两条反向断言）。
- **机器人不会行动**：Task 2 让机器人**入座**，但回合驱动（§9.4）与 AI 策略（§9.3）属 **Task 11 / §9 机器人系统**。
  因此「补机器人」之后的**对局不会推进**——这是有意为之，不是遗漏。
  Task 6 第 7 组因此只断言到 `room.join`（及可选的 `game.deal`），**不**断言对局打完。
- **`match:meta.latency` 恒为 0（R45）**、**`region` 只有 `global`（R43）**：均为「保留形状、不建机制」的有意取舍。
- **历史延后项**：`reconnect:active` 哈希永久驻留（§10.4 未覆盖）仍延后 —— 它属于切片 5 的记录窗口，
  与本片的匹配键无关，避免在同一片里混两套生命周期规则。
- **§9.8 的契约层兜底断言（R65）**：`validateOutbound` 只拦键名、不拦 id 前缀，本片不动
  `packages/protocol`（R54）。加固时必须按 **id 字段的前缀**判断，**不能**对整条载荷做子串匹配
  （`BOT123` 是合法的 base36 大写房间号）。列为切片 8 起的候选加固项。
- **R71 `GameClient.mapHttpStatus` 仍无直接用例（后端收尾时发现，本片不补）。**
  本片为 R70 补了 `game.client.test.ts`（8 条，逐条钉住四个出站路径的完整 URL —— 在此之前
  room-service→game-service 的**全部四个出站路径从无任何用例覆盖**）。但同一文件里
  「HTTP 状态码 → 契约错误码」的 `mapHttpStatus` 仍只有 `handleReconnect` 的**间接**覆盖。
  它与 R70 同族（「替身挡掉 HTTP 层 ⇒ 映射表写错也全绿」），列为切片 8 起的加固项。
  **一般教训**：`grep -rln "<被测类>" <tests>/` 为 0 的模块 = 该模块的每条出站路径都可能是 R70 型的盲区，
  值得在每个切片开工时先跑一遍这个清点。

**2. Placeholder scan**：无 TBD/TODO；每个代码步骤给了可直接粘贴的代码或精确到行的改动点；
每个测试步骤给了断言代码与预期失败原因。全文**没有**「照 Task N 做」这类跨任务引用——
Task 2 里出现的旧代码片段是为了**标明要删除什么**，不是让执行者去读别的任务。

**3. Type consistency**

- `MatchTicket`（§3.5）在 Task 1 定义、Task 2 消费（`readMeta` 的返回值），字段名与 §3.5 逐字一致；
  旧代码里的 `PendingMatch { playerId, roomCode, seat, isBot, joinedAt }` 是**另一个类型**，
  Task 1 把它收敛为 `{ roomCode, seat }`，Task 2 之后没有任何地方再读 `isBot`/`joinedAt`。
- `matchQueueKey` / `matchMetaKey` / `matchPendingKey` 三个助手在 Task 1 定义，
  Task 2（扫描/出队）、Task 3（`handleJoin` 的 pending 查询）都只通过助手访问键，**不写字面量**。
- `MatchEvent` 在 Task 2 变成判别联合；`onMatchEvent` 的两个分支与 Task 6 无关（conformance 只看 S→C 结果）。
- `toOutboundPlayerId(userId, seat)` 在 Task 3 定义并被 Task 6 的行为断言间接覆盖（无 `bot` 前缀）。
- 前端 `sendQueued(type, payload, maxAttempts)` 在 Task 4 定义；`onRoomMatched` 是唯一调用点（R60）。
  `useGameStore.matching` / `setMatching` 在 Task 4 定义、Task 5 消费；`applyRoomState({ status?, players })`
  的 `status` 可选由 Task 4 引入（R61），`onRoomState` 仍按 `room.state_update` 传 `status`。
- 任务间**没有**函数名漂移：`cancelQueue`（不是 `removeFromQueue`）、`storePending`（3 参）、
  `failMatch`（4 参）、`incrementAttempts`（1 参）全片唯一。

**4. 计划缺陷的执行期记录位**：执行中若发现本计划的错误（切片 6 出现过 R38/R39/R40 三处），
**就地修正计划文件并编号为 R55+**，不要只在汇报里提一句。

---

## 执行方式

**Subagent-Driven（推荐）** —— 协调者按 Task 派实现者 subagent，每个 Task 后派 task reviewer
（spec 合规 + 质量），后/前两条线**并行**（文件集不相交：`packages/room-service/**` vs `apps/client/**`），
conformance 由协调者自己在两端合并后写并跑（它需要的是**已合并的**镜像）。

**Inline Execution** —— 在本会话内按 Task 批量执行，带检查点。

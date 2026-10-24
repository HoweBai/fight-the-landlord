# 断线恢复「对局存活即可回」规格层 v1.1（冻结）

- 日期：2026-10-12
- 状态：**已冻结（v1.1，规格审查一轮闭环：1 重要 + 6 次要 + 3 观察全部处置，均为文本级；无机制级发现）** → **已实施（2026-10-12 收口：口径同设计文档；A1–A6 验收记录见收口报告，A2 留用户端到端）**
- 上游：设计 `2026-10-12-reconnect-until-game-end-design.md` **v1.3.1 冻结**（三轮对抗审闭环 + 规格审查勘误）
- 主题：把冻结的设计转成可实施、可验收的契约层：改动面 / 写死的形状 / 判据 C 系列 / 验收 A 系列 / 测试矩阵

## 0. 承接与订正

### 0.1 上游与版本

本文是**规格层**（与设计层分离，项目新口径）。设计冻结版为唯一语义来源；本文不引入新语义，只做：① 起草期必须定死的实现级裁定（§0.3）；② 判据与测试的可执行化（§3/§6）。设计与本文冲突时以设计为准并回改本文。

### 0.2 用户裁决承接

| # | 用户裁决（2026-10-12） | 落点 |
|---|---|---|
| K1 | 恢复门槛全面放开：同页断网超 30s 也要能回（30 秒窗口退役） | 设计 §3.1/§3.2、本文 §2.2/§2.3/§2.7 |
| K2 | 对局已结束回来 = 静默回大厅（冷启动无提示；同页保留既有 13005 处置=现状） | 设计 §3.3、本文 §2.3 |
| K3 | 客户端改动 = 仅自激守卫（曾要三方案优劣对比后选定） | 设计 §5、本文 §2.6 |

### 0.3 ⚙️ 规格级裁定（起草期就地定死）

1. **resolver 落位** = `ReconnectService` 的**公开方法** `resolveRecoverableRoom(playerId)`（不新文件）。四处消费者（`handleReconnect`/`replayActiveGame`/`handleResync`/`forwardAction`）均已持有该实例（`RouterDeps.reconnect`，`message.router.ts:87`；`WsGateway.reconnectService`）。
2. **「候选损坏」口径（写死）**：JSON 解析失败、字段缺失、**键类型损坏（WRONGTYPE，毒键）** ⇒ 该候选**按缺席跳过**（切片-12「毒键 ⇒ 降级」判据族的延续）；**连接级读失败**（非 WRONGTYPE 的 ioredis 错误：连接断开、超时等）⇒ **上抛**，沿用各调用方既有失败方向（设计 §3.1）。本条是对设计「解析失败/读失败」二分法的**细化**（键类型损坏归「候选损坏」），设计 v1.3.1 勘误已同步 ⇒ **不视为冲突**（§0.1 的「以设计为准」规则在此不触发）。
3. **`startRoom` 写哈希**：与 `match:pending` **同循环**（`rooms.start.ts:155-163` 位置契约：补位成功之后、两条 announce 与 `game.start` 之前）、**经 `ReconnectService` 写入**（键名/JSON 单一来源，不得手拼）；`socketId` 写**空串**（`readRecord` 已容忍非字符串 ⇒ `''`，该字段仅诊断）；写失败 ⇒ log + `return false`（与 pending 同款）。
4. **13009 保持 parity**：view 拿不到 + 房间键存在 ⇒ 仍返回 `13009`（resolver 已持有 `status`，将来可细分；本片不细分）。
5. **补推日志行（逐字）**：成功行 `Game resumption pushed for {userId} → {roomCode}@{seat} (status={status}, source={record|ticket})`；既有 WARN 行（视图失败 / 整体失败）文案保留「Match hand-off replay」前缀不改，避免无谓的判据连锁（命名变更只落在成功行）。
6. **热路径成本接受**：resolver 每次调用最多对候选各做 1 次 `HGET room:{code} status`；不做缓存或"无 pending 快路径"（YAGNI；将来实测再议）。
7. **不做服务端排序保证**：补推与 `game.reconnect` ack 并发（含逆序）不加 debounce/延时（设计 §6 #2 登记）。
8. **命名同步改**：`replayPendingMatch` → `replayActiveGame`（函数名/注释/日志）；`refreshReconnectWindow` → `touchReconnectRecord`（`ws.gateway.ts:521` 及两处调用）；日志「Reconnect window refreshed」→「Reconnect record refreshed」（`reconnect.service.ts:90`、`ws.gateway.ts:526`）——连带存量用例 `ws.gateway.test.ts:501-519` 一并改；`AckInput`/协议等**外部形状零变化**。

### 0.4 设计 §7 判据 → 本文 C 系列映射

设计 §7 的 13 条判据全部被 C1–C18 覆盖（本文 §3）；无新增、无删减语义。

## 1. 改动面一览

### 1.1 修改文件（按包）

**packages/room-service**

| 文件 | 改动 |
|---|---|
| `src/reconnect/reconnect.service.ts` | 新增 `resolveRecoverableRoom`；`touch()` 仅写哈希；`clearConnection()` 仅删哈希；退役 §2.7 清单 |
| `src/gateway/ws.gateway.ts` | `replayPendingMatch` → `replayActiveGame`（§2.4）；调用点随改名 |
| `src/gateway/message.router.ts` | `handleReconnect` 四步（§2.3）；`handleResync`/`forwardAction` 改走 resolver；`findActiveRoom` 删除 |
| `src/rooms/rooms.start.ts` | 开局循环内同写哈希（§2.5）；构造函数注入 `ReconnectService` |
| `src/rooms/start.module.ts` | `imports` 补 `ReconnectModule`（叶子依赖，无环） |

**apps/client**

| 文件 | 改动 |
|---|---|
| `src/net/socket.ts` | 自激守卫两落点（§2.6）——**唯一客户端源码改动** |

**测试（改动/新增）**：`test/reconnect.service.test.ts`、`test/ws.gateway.test.ts`、`test/message.router.test.ts`、`test/rooms.start.test.ts`、`test/ws.module.wiring.test.ts`（DI 复核）；`apps/client/test/reconnect-flow.test.ts`。

**conformance**：`tools/conformance/src/slices/slice-05-reconnect.ts`（改写+增补）、`slice-12-manual-join.ts`（增补）。

**文档**：`docs/design.md`（**七行**，按设计 §8 表逐行）、`docs/client-protocol.md`（`13010` 行 + 处置例外行）。

### 1.2 新增（函数级；无新文件、无新模块）

- `ReconnectService.resolveRecoverableRoom`（§2.2）。
- 客户端守卫辅助（如 `isSelfExcitedSnapshotFailure(type, code)` 形式，命名实现期定，语义见 §2.6）。

### 1.3 明确不在改动面

- `match:pending` 的写入与清票（`rooms.start.ts:155-159`、`message.router.ts:558/613`）——逐字不动。
- `room.leave`、协议包（无新消息/错误码/字段）、REST 面、管理面、监控面。
- `apps/client/src` 除 `socket.ts` 守卫外**零 diff**（机械判据 C14）。
- 服务端超时代打（`game.service.ts:763`）、`restoreDelivery` 本体。

## 2. 新契约（写死）

### 2.1 Redis 键与写入时机

- **键**：`reconnect:active`（Hash，field=playerId，**无 TTL**）——记录形状不变：`{ socketId: string, roomCode: string, connectedAt: number }`。
- **写入时机（五）**（统一经 `ReconnectService`）：
  1. `startRoom` 开局，人类座位（**新增**，socketId=`''`）；
  2. `room.join` 成功（不变）；
  3. `game.reconnect` 成功（不变）；
  4. 服务端观测到 `disconnect`（不变，语义=「在线观测点」）；
  5. 新连接建立且上一条从未被观测到断开（硬换手续期，不变）。
- **清除**：仅 `room.leave`（`clearConnection`，逐字不变）。过期概念随窗口退役——不做删除、不做 TTL。
- `match:pending:{playerId}`：写入/清票逐字不变（§1.3）。

### 2.2 resolver 契约

```ts
// ReconnectService 公开方法
async resolveRecoverableRoom(playerId: string): Promise<
  { roomCode: string; source: 'ticket' | 'record'; status: string } | null
>
```

- **候选顺序**：`[match:pending:{playerId} 的 `roomCode` 字段 → reconnect:active 哈希记录]`。
- **第一遍（存活谓词）**：依序对候选房间做 `HGET room:{code} status`；首个 `status ∈ {waiting, playing}` 者命中返回。
- **第二遍（存在性）**：都不存活 ⇒ 首个 `status !== null` 者返回（房间键存在，任意状态）；都没有 ⇒ `null`。**`status` 命中时必为非空串**（第一遍为 `waiting|playing`，第二遍为任意非空状态）；键在但 `status` 字段缺失（坏 meta）⇒ 按不存在处理（⇒ `13010`），实现不得为 `| null` 造死分支。
- **损坏**：候选读取遇到 JSON 解析失败/字段缺失/WRONGTYPE ⇒ 该候选跳过（不打日志噪声；WRONGTYPE 记 WARN 一行）；**连接级读失败上抛**（§0.3-2）。
- 返回 `status` 为命中时该房的真实值（两遍同源）。

### 2.3 `game.reconnect` 判定（四步）与文案

| 步 | 条件 | ack |
|---|---|---|
| ① | `resolveRecoverableRoom` → `null` | `13010`，message 逐字：`No recoverable game to reconnect to` |
| ② | view 存在且 `state === 'ended'` | `13005`，message 逐字：`Game is over` |
| ③ | view 拿不到（null 或 `ROOM_NOT_FOUND`/`NOT_IN_ROOM` 翻译）且房间键存在 | `13009`，message 逐字：`Game has not started yet` |
| ④ | view 存在且非 ended | `code 0`，`data` = 当前版本全量裁剪快照 + `restoreDelivery`（顺序：**先 touch + 投递恢复、再回 ack**，逐字保留现状） |
| — | view 拿不到且房间键不存在 | `13010`（同 ① 文案） |

步骤③的「房间键存在」判定**沿用现状**：`rooms.findOne(roomCode)` 非空 ⇒ `13009`、空 ⇒ `13010`（与 `message.router.ts:707-710` 逐字等价；**不**改用 resolver 已读的 `status`——避免在 resolver 读取与 view 抓取之间引入第二套竞态语义）。

保留：`isMissingGameError` 翻译、`lastVersion` 只写日志、`onReconnected` 调用。

### 2.4 补推 `replayActiveGame`（ws.gateway）

- 触发：**每次**连接建立（位置不变）。
- 凭据：`resolveRecoverableRoom` 第一遍命中；`null` ⇒ 静默返回（不产生日志噪声，维持现状口径）。
- 分支：
  - `playing`：玩家不在 `room.players` ⇒ 跳过；抓 view；`view.state === 'ended'` ⇒ 静默；否则 **emit `game.deal`(view) → `seatOwners.set(roomCode:view.seat)` → emit `room.matched`**（顺序不可反）；view 拿不到但玩家在册 ⇒ WARN + 仅 `room.matched`（seat 由 `room.players` 解析，解析不出 ⇒ 跳过）。
  - `waiting`：seat 由 `room.players` 解析（解析不出 ⇒ 跳过）⇒ `seatOwners.set` + `room.matched`。
  - 其余（finished/cancelled/房间不存在/无凭据）：静默。
- 保留：`activeConnections` 顶替校验（两处：推送前与 view 抓取后）；整体 fail-open + WARN。
- 成功日志行：§0.3-5 逐字。

### 2.5 `rooms.start.ts` 开局写哈希

按 §0.3-3 执行；**机器人不写**（沿用 `humanSeats` 谓词，R47）。写循环内**先 pending 后哈希**（同座位迭代；顺序无判据依赖，写明避免实现分叉）。

### 2.6 自激守卫（客户端唯一改动）

- **条件**：将要派发 `REFRESH_SNAPSHOT` 类处置（码白名单：`13004`/`13007`/`13009`）且**失败请求本身是快照类请求**（`isSnapshotRequest(type)`：`game.resync`/`game.reconnect`）⇒ **跳过该派发**。
- **落点两处**：`dispatchAck`（在途匹配路径）；`handleAck`（迟到 ack 路径，`AckInput.type` 可知时同款门控、**未知时照常派发**——残余 ≤1 且自终止，登记）。
- **不受影响**：动作请求的 `13004` → resync（§6.5 通道）；`13005`/`13010` 的 BACK_TO_LOBBY（不在白名单）；TOAST/IGNORE 类。
- 守卫后行为：waiting 房同页抖动 = 补推拉回 + `13009` 静默（无风暴、无 `10006`）。

### 2.7 退役清单（room-service）

`RECONNECT_WINDOW_MS`、`RECONNECT_TTL_SECONDS`、`reconnectKey()`、`validateReconnect()`、`RECONNECT_CLOCK`（及 `@Optional @Inject` 槽）、独立键读写全部删除；`reconnect:active:{playerId}` 独立键不再写入（存量孤儿键无读取方，自然过期——无迁移动作）。

### 2.8 错误码与文案总表（玩家可见性标注）

| 码 | 触发（本片后） | message 逐字 | 玩家可见 |
|---|---|---|---|
| `13005` | 命中但对局 ended | `Game is over` | 同页：见（既有提示内插）；冷启动：不出现 |
| `13009` | view 拿不到 + 房间在 | `Game has not started yet` | 同页 13009 由守卫吞掉；动作请求触发时同现状 |
| `13010` | 无任何可恢复凭据 / 房被回收 | `No recoverable game to reconnect to` | 同页：见；冷启动：不出现 |

## 3. 判据总表（C1–C18；载体=单测 / conformance / 机械闸；全部同提交）

| # | 判据 | 载体 |
|---|---|---|
| C1 | 同页断网 >40s（跨过旧窗口）重连 → `code 0`、快照 version=服务端当前、牌桌恢复 | conformance slice-05 |
| C2 | 入局后二次冷启动连接（票已被首轮补回清掉）→ 仍被补推拉回 | conformance slice-05 |
| C3 | 从未入房 + 票失效（直删 pending）→ 建连被拉回（哈希源；v1.1 前必红） | conformance slice-05/slice-12 |
| C4 | waiting 房冷启动 → 补推 `room.matched` 回房 | conformance slice-05 |
| C5 | 负对照：显式 `room.leave` → 不推、不拉回 | 单测 + conformance |
| C6 | 负对照：陈旧哈希（startRoom **之后**注入，指向已回收房）+ 存活新局 → 拉回新局 | 单测（resolver/`message.router`）+ conformance slice-12 |
| C7 | 负对照：finished 未回收窗口冷启动 → 静默 | 单测（`ws.gateway`） |
| C8 | 负对照（守卫）：动作请求 13004 → resync 仍发；快照请求自身 13009 → 不再 resync（两落点，含 type 未知残余） | 单测 `reconnect-flow.test.ts` |
| C9 | 恢复后快照 version=服务端当前 | conformance slice-05 |
| C10 | 投递链路恢复实证：恢复后一次后续推送（**由玩家动作触发**的 `game.state_update`，与既有 slice-05 构造一致）到达该连接 | conformance slice-05 |
| C11 | resolver 单测：存活优先 / 存在性回退 / 损坏跳过（含 WRONGTYPE）/ 读失败上抛 / 双候选仲裁（pending 胜）/ 双死 → null | 单测 `reconnect.service.test.ts` |
| C12 | 机械：`RECONNECT_WINDOW_MS|RECONNECT_TTL_SECONDS|reconnectKey|validateReconnect|RECONNECT_CLOCK` 在 `packages/**/src` 0 命中 | 机械闸（grep 测试） |
| C13 | 机械：组合定位单一来源（`findActiveRoom` 已删、无第二份哈希+pending 择优读取） | 机械闸 |
| C14 | 机械：`apps/client/src` diff 白名单 = `socket.ts`（**守卫含其辅助只准住 `socket.ts`**）；基线 = 本片规格冻结提交的 master SHA（开工时由计划写死）；`apps/client/test` 不在本闸管辖（C8 载体即在彼）；其余无 diff | 机械闸 |
| C15 | `handleReconnect` 四步单测（含：resolver 收编后 `forwardAction`/`handleResync` 路由同源） | 单测 `message.router.test.ts` |
| C16 | `rooms.start` 单测：人类座位写哈希 / 机器人不写 / 写失败 `return false` / 位置（announce 前） | 单测 `rooms.start.test.ts` |
| C17 | 既有块改写：`ws.gateway.test.ts:893-1071`（**整块 6 条**，含 `reconnectKey`/注入时钟者）与「窗口/TTL」语义断言 → 存活语义 | 单测 |
| C18 | 文档同步：design.md **七行**（设计 §8 表逐行，含 `:1339/:1345/:1530`）+ client-protocol 两处 + **受控现行文档**（排除本片三份文档自身与历史 `plans/`）中描述**现行机制**的「30 秒/35 秒」等表述清零 | 人工核销（`protocol-doc-sync` 不覆盖描述文本） |

## 4. 既有判据同步清单（实现第一步：全仓 grep 再动）

grep 词（至少）：`RECONNECT_WINDOW_MS`、`RECONNECT_TTL_SECONDS`、`reconnectKey`、`validateReconnect`、`RECONNECT_CLOCK`、`findActiveRoom`、`replayPendingMatch`、`refreshReconnectWindow`、`Reconnect window`、`Match hand-off replay`、`重连窗口`、`match:pending`、`30 秒`、`35 秒`、`13010`。

已点名必改：`test/ws.gateway.test.ts:893-1071`（整块 6 条）与 `:501-519`（续期用例，随 §0.3-8 改名）；`slice-05-reconnect.ts`（29 项窗口类断言）；`design.md:910/:1012/:1057/:1546/:1578/:1642` + **`design.md:1339/:1345/:1530`**（§8.2/§10.1 的「匹配路径写 pending」表述 → 补「开局同时写重连记录」）；`client-protocol.md:299` + 处置表；`ws.module.wiring.test.ts`（DI 复核：`StartModule` 新 import 的可见性）。

## 5. 验收条目（A1–A6；真栈/手工）

| # | 条目 |
|---|---|
| A1 | 同页断网 40s → 牌桌恢复且与其它端同步（需求句 1 + 2） |
| A2 | 对局中杀进程/刷新：入局后 ≤5min 与 >5min 各一次 → 均自动回桌（跨过旧 TTL；K1） |
| A3 | waiting 房刷新 → 回房等待（新增能力） |
| A4 | 三例恢复后 version 与其它玩家一致 + 后续推送到达（C9/C10 的真栈版） |
| A5 | 负对照：显式离开不回；对局已结束回来静默（K2） |
| A6 | 回滚口径：纯行为变更、无数据结构迁移；⚠️ 回滚后新代码期间写入的记录被判「过期」⇒ 受影响玩家一次重连回大厅（自愈于下次 join/断线观测，无修复动作）——见 §8 预期扰动登记 |

## 6. 测试矩阵

### 6.1 单测

- `reconnect.service.test.ts`：C11 全组；`touch` 只写哈希（恶意断言：无 EX 键写入）；`clearConnection` 只删哈希。
- `ws.gateway.test.ts`：补推块按 §2.4 改写（record 源 × playing/waiting/ended/不在册/顶替/fail-open）+ C7；`:893-1071` 整块改写（C17，含 `:501-519` 续期用例随 §0.3-8 改名）。
- `message.router.test.ts`：C15 四步 + C6 + `forwardAction`/`handleResync` 路由同源用例。
- `rooms.start.test.ts`：C16。
- `ws.module.wiring.test.ts`：DI 复核（构造可解析）。
- `apps/client/test/reconnect-flow.test.ts`：C8（两落点 + 三负对照：动作 13004 仍 resync、13005/13010 仍派发、type 未知残余）。

### 6.2 conformance

- `slice-05-reconnect.ts`：窗口类断言改写为存活类（含 C5 负对照保留）；新增 C1/C2/C3/C4/C9/C10（C1 含一次 40s 直等，预估 +1~2 分钟；C3 用直删构造）。
- `slice-12-manual-join.ts`：新增 C6「陈旧哈希版竞态」（startRoom 后注入）。

### 6.3 门禁

既有六阶段（lint / tsc / vitest / ci 相关）+ conformance 全序；`pnpm -r test` 及各包单测；客户端 `vue-tsc`。机械闸 C12/C13/C14 建议落为**仓库级 grep 测试**（照 `meta-on-every-rpc-send.gate.test.ts` 成例）。

## 7. conformance 登记与基线口径

- `slice-05` 断言总数变化（29 → 改写后数量）与 `slice-12` 增补数：实现后按实测回填基线表（`baselines`），不得沿用旧数。
- 新增等待（40s）计入该片时长；全序预估 +1~2 分钟。

## 8. 部署、回滚与明确不做

- **部署**：纯代码变更（room-service + 客户端静态资源重发）；无迁移、无新配置键、无新环境变量。
- **回滚**：记录形状未变、无迁移；⚠️ **预期扰动（登记）**：新代码期间写入的记录**没有 35s 独立键**，回滚后的旧 `validateReconnect` 会一律判「过期」⇒ 局中玩家的一次同页重连落 `13010`（回大厅）；且旧第①步「哈希字段在 ⇒ 不回落 pending」会挡住「从未入房」玩家的错票补回。**自愈**于该玩家下一次 `room.join` / 断线观测（旧 `touch` 双写独立键）；无数据修复动作。
- **明确不做**（承接设计 §2 非目标 + 设计 §6 登记）：结算回放/结束提示、客户端持久化、托管/AI 代打、`match:pending` 逻辑改动、以时序 hack 修 push/ack 逆序、双坐局的 `room.match` 守卫、超时自动代打策略调整。设计层登记项（异页拉起三形态 / 房键×会话 TTL 不同步 / 双坐局失败方向）见设计 §3.6 与 §6 #9/#10/#11，本片无实现动作，验收时按设计对照。

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-12 | 起草：承接设计 v1.3 冻结；八条规格级裁定；C1–C18 / A1–A6 |
| v1.1 | 2026-10-12 | 吸收规格审查（一轮闭环）：回滚扰动登记（A6/§8）；WRONGTYPE 细化声明（不视为冲突，设计 v1.3.1 已同步）；C14 基线/粒度写死；C18 收窄 + 文档清点对齐设计 §8 七行（含 `:1339/:1345/:1530`）；存量块范围更正 `:893-1071`（6 条）；步骤③判定机制写死（`rooms.findOne` 沿用现状）；命名漂移裁定（`touchReconnectRecord` + 日志行 + `:501-519`）；C10 构造改玩家动作快路径；resolver `status` 类型收非空 |

# 客户端接入协议清单

> **给谁看**：独立开发客户端的人（例如用 HBuilderX 从零写），需要知道**必须遵守服务端的哪些约定**。
> **本文的定位**：**派生文档，不是真源**。真源是代码 —— 冲突时以
> `packages/protocol/src/{messages,errors,validate,codec}.ts` 与 `docs/design.md` §5–§11 为准。
> **对账**：`apps/client/test/protocol-doc-sync.test.ts` 机械校验「本文列的消息名/错误码」与代码**双向一致**
> —— 少列一条、多列一条都会让它红。**改代码必须同 PR 改本文。**

---

## 0. 一句话

客户端是**哑终端**：它只管**发用户的原始操作**、**渲染服务端下发的裁剪视图**。
**一切游戏规则、合法性判定、胜负与算分都在服务端**（`docs/design.md` §12）。

---

## 1. 你要连两个端点

| 端点          | 用途                                                 | 开发期地址                                                  | 生产地址                 |
| ------------- | ---------------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| **REST**      | 注册 / 登录 / 换令牌 / 登出 / 房间列表 / 建房 / 占座 | `http://localhost:3000/api`                                 | `https://<你的域名>/api` |
| **WebSocket** | 匹配 / 进房 / 对局全流程                             | `http://localhost:3000`（socket.io 自动派生 `/socket.io/`） | `https://<你的域名>`     |

- **socket.io 4.x**，**namespace `/ws/ddz`**，**path `/socket.io/`**
- 🔴 **两个地址都必须显式写死/配置**，**不要**依赖「回退到页面 origin」。在非浏览器环境里 origin 会指向不存在的服务，
  表现为「**ack 永不到达**」——最难查的一类问题。
- REST 的路径**统一以 `/api` 开头**；`/api` 之外的路径在网关上一律不注册（有机械闸盯着）。

---

## 2. REST：八条

**统一信封**（所有 REST 响应的形状）：

```json
{ "code": 0, "message": "可选，仅供调试", "data": "可选，形状随接口" }
```

🔴 **判定成功的唯一依据是 `code === 0`**。**不得**拿 HTTP 状态码当业务码用，
**不得**根据 `message` 分支（它是给人看的，措辞会变）。

| # | 方法/路径 | 鉴权 | 请求体 | 成功时 `data` |
|---|---|---|---|---|
| 1 | `POST /api/auth/register` | ❌ 公开 | `{ phone, password, nickname }` | `{ accessToken, refreshToken, user: { id, phone?, nickname? } }` |
| 2 | `POST /api/auth/login` | ❌ 公开 | `{ phone, password }` | 同上 |
| 3 | `POST /api/auth/refresh` | ❌ 公开 | `{ refreshToken }` | `{ accessToken, refreshToken }` |
| 4 | `POST /api/auth/logout` | ✅ Bearer | `{ refreshToken? }` | `null` |
| 5 | `GET /api/rooms` | ✅ Bearer | — | `RoomInfo[]` |
| 6 | `POST /api/rooms` | ✅ Bearer | `{ mode: 'random' \| 'practice', baseScore?: number }` | `RoomInfo` |
| 7 | `POST /api/rooms/:code/join` | ✅ Bearer | `{}` | `RoomInfo` |
| 8 | `GET /api/config` | ✅ Bearer | — | `{ baseScoreLevels: { name, baseScore, entryFeePercent?: number }[]; friendRoomEnabled: boolean; freeRoomEnabled: boolean; goldRoomEnabled: boolean; reliefEnabled: boolean; entryMultiplier: number; rechargeEnabled: boolean; withdrawEnabled: boolean; coinPerYuan: number; rechargePackages: number[]; withdrawMinCoins: number; withdrawMaxCoinsPerOrder: number; withdrawDailyMaxCoins: number; withdrawReAuthEnabled: boolean; reliefAdpid: string; cardCounterEnabled: boolean; cardCounterPricePerGameCoins: number; cardCounterPricePerHourCoins: number; games?: Partial<Record<'doudizhu' | 'paodekuai', { enabled: boolean; supportedPlayerCounts: number[]; defaultPlayerCount: number; baseScoreLevels: { name: string; baseScore: number }[]; freeRoomEnabled?: boolean; goldRoomEnabled?: boolean; friendRoomEnabled?: boolean; entryMultiplier?: number }>>; reliefThresholdCoins?: number | null; version: number }`（`entryFeePercent` 是档位项的可选台费；**阶段 2 起不再下发派生字段 `entryFeePercents`**，客户端用 `entryFeeOfLevel(level)` 算入场费） |

⚠️ `nickname` **必填**（trim 后 1–20 字符，**不唯一**）；存量用户可能没有昵称（`user.nickname = null`），
牌桌展示回落「玩家N」。`room.join` ack / `room.state_update` 的 `RoomPlayer` 可带可选 `nickname`；
机器人展示昵称由 room-service 分配（2026-10-22 拟人昵称片），与人类同样下发。

⚠️ **第 8 条由网关转发到 `config-service`（配置中心）**（底分档位是它管的 92 键之一（2026-10-25 起） —— 路由名与
目标服务不一致的旧形态已随收编消失）。数组顺序 = 配置里的**展示顺序**，**不是**「取第一档」的指令
—— 底分要由**用户从这张表里选一档**：参考客户端把整张表渲染成大厅的底分卡，并把**选中的那一档**
用于 `room.match` 与 `POST /api/rooms`）。
服务端读的是**内存缓存 + 推送失效 + ≤60s 安全网**：后台改完，推送正常时**秒级**生效、最晚 **≤60s**
生效；客户端**也不要缓存**它（每次进大厅拉一次最新的）。
`room.match` 的 `baseScore` **必填**（见 §4.3 第 1 条），而客户端**不得**写死底分常量（M09）
⇒ 底分只能取自这张表，**不要猜一个值**。
`friendRoomEnabled === false` ⇒ **不要渲染好友房入口**（服务端也会把建房/占座拒成 `12006`「好友房暂未开放」、
列表返回空数组）；**拉取失败/未知一律按 `false` 处理**（fail-safe —— 本地初值就是 `false`）。

⚠️ **第 6 条的 `baseScore` 可选**：不传 ⇒ 服务端用缺省档；传了则**必须**是第 8 条
`GET /api/config` 的 `baseScoreLevels` 里的一档，否则 `10001`。

**鉴权**：`Authorization: Bearer <accessToken>`。公开路径**恰好五条**（上表 1–3 + `/api/health` + `/api/health/live`），
其余一律要令牌。

**`RoomInfo` 形状**：

```ts
{
  code: string;
  mode: "random" | "practice" | "gold";
  status: "waiting" | "playing" | "finished" | "cancelled";
  playerCount: number;
  maxPlayers: number;
  baseScore: number;
  /** 多玩法：缺失 = doudizhu（旧服务端）。 */
  gameType?: "doudizhu" | "paodekuai";
}
```

### 跑得快（多玩法，S4/S5/S6）

- `room.match` 增 `gameType?: "doudizhu" | "paodekuai"`、`playerCount?: number`（缺省斗地主/3）；
  跑得快首版客户端只发 `playerCount: 3`。
- `room.join` 增 `gameType?`（缺省斗地主）；REST `POST /api/rooms/:code/join` body 为
  `{ gameType? }`。旧客户端进跑得快房 ⇒ `12012`，且 REST 不占座。
- `room.matched` / `room.state_update` 增 `gameType?` / `playerCount?`；客户端自动 join 原样回传。
- `GET /api/rooms?gameType=`：缺省只返回斗地主房；`GET /api/records/mine?gameType=paodekuai`
  返回跑得快战绩（**单独两表**；缺省只查斗地主表）。
- `game.play` / `game.pass` 复用；跑得快**没有** `game.bid`（收到即 `13001`）。
- `PdkPlayerView`（`GameView` 联合成员）关键字段：`gameType:'paodekuai'`、`playerCount`、
  `state:'playing'|'ended'`、`canPass`（服务端算好）、`bombCount`、`pdkRules`（本局规则快照，
  **字段名不是 `rules`**）、结束时的 `winnerSeats`；**没有** `bottomCards`/`bidPhase`/`landlordSeat`。
- `game.finished` 跑得快形状：`{ gameType:'paodekuai', winnerSeats: number[] }`（斗地主仍 `{winner}`）。
- `game.settlement` 跑得快为 `SettlementVector`（`winnerSeats` + `scoreChanges` + `remaining` /
  `multiplier` / `bombCount` / `guan` / `spring` / `baobenSeats`）；斗地主仍旧 9 键。
- `pdkRules` 仅供 hint/展示：客户端**不得**本地实现规则；牌型判定只用 `protocol/pdk/rule.ts`。

🔴 **令牌过期的唯一正确处置**（`10004`）：**用 refresh token 换一对新的，然后重放原请求一次**。
**只轮换一次、只重放一次，不循环**。轮换也失败 → 把 `10004` 交给上层按第 7 节的处置表处理。
⚠️ `refreshToken` 每次轮换**都会换新**，旧的要作废 —— 必须把新的一对**存回去**。

🔴 **`POST /api/rooms` 建房不入座**。想进房必须**先** `POST /api/rooms/:code/join` 占座（REST），
**再**发 WS 的 `room.join`。顺序反了必然拿到 `12004`。

### 支付面（九条，钱包页用；全 ✅ Bearer）

错误码见第 7 节（`15001`–`15009`）。钱包页需要的**开关与限额**都在第 8 条 `GET /api/config` 的 21 键里
（`rechargeEnabled` / `withdrawEnabled` / `coinPerYuan` / `rechargePackages` / `withdrawMinCoins` /
`withdrawMaxCoinsPerOrder` / `withdrawDailyMaxCoins`）——**两开关为 `false` 时对应区块不要渲染**。

| #   | 方法/路径                                 | 请求体 / query                                  | 成功时 `data`                                                                                                |
| --- | ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| P1  | `POST /api/pay/orders`                    | `{ packageYuan }`（整数；必须是档位表里的一档） | `{ orderNo, payUrl, expiresAt }` —— `payUrl` 拿去**跳收银台**（H5 直跳 / App 唤起降级见下）                  |
| P2  | `GET /api/pay/orders/:orderNo`            | —                                               | `{ orderNo, status, coins, amountYuan, packageYuan, createdAt, paidAt, creditedAt, closedAt }`               |
| P3  | `POST /api/pay/orders/:orderNo/sync`      | —                                               | 同 P2（触发一次**主动查询**——回跳后轮询用它）                                                                |
| P4  | `GET /api/pay/orders/mine?cursor=&limit=` | keyset（默认 20 / 上限 50）                     | `{ items[], nextCursor }`                                                                                    |
| P5  | `GET /api/pay/wallet/summary`             | —                                               | `{ balance, withdrawable, dailyWithdrawRemainingCoins }`（`withdrawable` = 可离场额度；末项 = 当日剩余可申） |
| P6  | `POST /api/pay/refunds`                   | `{ orderNo, reason }`（reason ≤ 255）           | `{ refundNo, status }`                                                                                       |
| P7  | `GET /api/pay/refunds/mine`               | keyset                                          | `{ items[], nextCursor }`                                                                                    |
| P8  | `POST /api/pay/withdrawals`               | `{ coins }`（整数）                             | `{ withdrawNo, status }`                                                                                     |
| P9  | `GET /api/pay/withdrawals/mine`           | keyset                                          | `{ items[], nextCursor }`                                                                                    |

⚠️ **路由次序固定**：`/orders/mine` 是**静态段**、`/orders/:orderNo` 是参数段 —— `mine` **不是**订单号；
把二者搞混（比如自己拼 `/orders/%2Fmine` 一类）会拿到 `15002`。三族 `mine` 的 `nextCursor` 都是**不透明字符串**，
原样回传即可（同 §2 的 keyset 口径）。

⚠️ **支付回跳**：玩家在支付宝收银台完成后回到站点会带 **`?pay=<orderNo>`**（回跳地址由服务端拼）——
客户端识别该参数 ⇒ 打开钱包页 + 对该单轮询（P2 / P3 任选，P3 会主动推一把渠道查询）。**识别后把参数摘掉**，
避免刷新后重复触发。

⚠️ **App 形态**：App 版没有「同源」概念、也没有可直接导航的地址栏 —— 跳收银台走宿主能力
（`plus.runtime.openURL` 交给系统浏览器）；唤不起时**显示降级文案**（「请用浏览器打开完成支付」），不要白屏。

---

## 3. WebSocket：连接与握手

```js
const socket = io("http://localhost:3000/ws/ddz", {
  path: "/socket.io/",
  transports: ["websocket"],
  auth: { token: accessToken }, // ← 握手鉴权
});
```

- 握手鉴权走 **`auth: { token }`**；验签失败服务端以 **`connect_error` 拒绝**（不会给你连上后再踢）。
- **心跳用 socket.io 内置**（`pingInterval: 30000` / `pingTimeout: 90000`）。
  🔴 **不要发应用层的 `ping`/`pong` 消息** —— 契约里**没有**这两条（有机械闸拦）。
- 🔴 **握手完成前的 `emit` 会被静默丢弃**（不报错、不响应）。服务端侧有缓冲，但**你自己也要等
  `connect` 事件之后再发第一条请求**。

---

## 4. C→S：十一条入站请求（你发给服务端）

### 4.1 统一的请求形状（**扁平，不嵌套**）

```js
socket.timeout(5000).emit(type, { reqId, baseVersion, timestamp, payload }, (err, res) => { ... });
```

| 字段          | 说明                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `type`        | **放在 socket.io 的事件名上**，请求体里**不重复**                                          |
| `reqId`       | UUID，**仅供日志追踪**，不参与任何判定                                                     |
| `baseVersion` | 你最近一次应用的 `version`；**只有 `game.bid`/`game.play`/`game.pass` 有意义**，其余传 `0` |
| `timestamp`   | 你的毫秒时间戳。服务端校验 **\|你的时钟 − 服务端时钟\| < 5000ms**（超了报 `10001`）        |
| `payload`     | 该消息自己的载荷                                                                           |

🔴 **四个字段平铺在顶层**。写成 `{ type, meta: {...}, payload }` 会让服务端**拒绝你所有的请求**。

### 4.2 ack 回调的形状 —— **最容易踩的一个坑**

| 写法                                      | 回调签名                                    |
| ----------------------------------------- | ------------------------------------------- |
| `socket.emit(type, body, cb)`             | `cb(res)` —— **只有一个参数**，就是回执本身 |
| `socket.timeout(ms).emit(type, body, cb)` | `cb(err, res)` —— 超时错误在**第一个**参数  |

🔴 **两种不兼容**。若省略 `.timeout()` 却按 `(err, res)` 解包，`err` 会拿到回执对象、`res` 恒为 `undefined`
⇒ 表现为「**每个正常回执都被判为失败**」，而日志上看起来像「ack 永不到达」。
**建议一律用 `.timeout(5000)` 并显式处理 `err`**。

ack 的形状：`{ code: number, message?: string, data?: unknown }` —— 同样**只看 `code === 0`**。

### 4.3 十一条逐条

| #   | `type`              | `payload`                                                                          | ack 的 `data`                               | 什么时候发                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `room.match`        | `{ mode: 'random' \| 'practice' \| 'gold', baseScore: number, gameType?: 'doudizhu' \| 'paodekuai', playerCount?: number, deviceId?: string }` | —                                           | 点「开始游戏」。🔴 `baseScore` **必填**（片规格 §2.4 协议②）：它进撮合键 —— 不同底分**不会**被撮进同一个房。`code 0` = 已入队；`12009` = 你已在队列里（**当成成功**）。`deviceId`（风控片新增，**可选**）：设备标识，本客户端**总是发送**（生成一次、持久保存、**跨登录/登出保留**）；形状 `8..64` 位 `A-Za-z0-9._-`，否则服务端拒 `10001`。服务端**可见**（进匹配 meta 供同设备风控），**永不下发**（任何 S→C 载荷都不会含它）。换场次/底分再发本条时，维度相同仍回 `12009`；维度不同服务端自动取消旧队再入新队（无需先 `room.unmatch`） |
| 2   | `room.unmatch`      | `{}`                                                                               | —                                           | 取消匹配                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | `room.join`         | `{ roomCode, gameType?: 'doudizhu' \| 'paodekuai' }`                                                                     | `{ roomCode, seat, players: RoomPlayer[] }` | **REST 占座成功之后**（见 §2 末）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | `room.leave`        | `{ roomCode }`                                                                     | —                                           | 主动退房                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | `game.bid`          | `{ grab: boolean }`                                                                | —                                           | 叫抢轮到你了。`grab: true` = 抢，`false` = 不抢                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 6   | `game.play`         | `{ cards: Card[] }`                                                                | —                                           | 出牌。**发原始牌，不排序、不去重、不判定**；`cards` **不得为空**（过牌用 `game.pass`）                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7   | `game.pass`         | `{}`                                                                               | —                                           | 过牌                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8   | `game.reconnect`    | `{ lastVersion? }`                                                                 | 裁剪快照 `PlayerView`                       | 断线后 socket.io 自动重连成功时                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 9   | `game.resync`       | `{}`                                                                               | 裁剪快照 `PlayerView`                       | **只用于 `13004` 的恢复**（见 §7）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 10  | `room.match.extend` | `{}`                                                                               | —                                           | 收到 `match.wait_prompt`（见 §5 第 11 条）后，玩家点「**继续等待**」时发。语义 = **票留在原队列**，排队位置/入队时刻不变，服务端只平移后续提示窗口（再等 30 秒可再次收到提示）；总等待上限不重置，到点仍收 `12007`。不在队列中调用为 no-op（仍回 `code 0`）。玩家点「**重新匹配**」时**不发本条** —— 发 `room.unmatch` 成功后重新发 `room.match`                                                                                                                                                                                      |
| 11  | `game.trustee`      | `{ on: boolean }`                                                                  | `{ version }`                               | 托管开关（挂机治理）。`on: true` = 开启托管（服务端按规则引擎代打）；`false` = 解除。幂等：目标值与现值相同 ⇒ 服务端 no-op（仍回 `code 0`）。`on` **必须**是严格 boolean —— 字符串 `'false'` 等一律 `10001`。三家托管态从 `PlayerView.trustees` 读（见 §5），**不要本地推断** |

🔴 第 5/6/7 条**必须**带正确的 `baseVersion`（CAS）；其余八条**必须传 `0`**。

---

## 5. S→C：十二条出站消息（服务端推给你）

**推送形状**：`{ version: number, payload: unknown }`，`type` 同样在**事件名**上。

| #   | `type`              | `payload`                           | 你要做什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `room.matched`      | `{ roomCode, seat, gameType?, playerCount? }`                | 匹配成功。**立刻**发 `room.join` 挂载到这条连接上                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | `room.state_update` | `{ status, players }`               | 刷新房间成员。**不参与对局版本判定**                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3   | `game.deal`         | `PlayerView`                        | 开局。**从这里取首个 `baseVersion`**                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4   | `game.current_turn` | `{ seat, timeoutMs }`               | 回合开始。**只渲染，不推理**（它不含 `cardCounts`）                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | `game.state_update` | `PlayerView`                        | 每次状态转移后。**渲染的唯一依据**                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | `game.finished`     | `{ winner }`                        | 有人打完了。**此时不要显示结算**                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 7   | `game.settlement`   | `SettlementResult`                  | 结算。**这时才显示结果**                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | `system.error`      | `{ code, message }`                 | 非请求触发的系统错误 → 按 §7 的表处置                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 9   | `system.warning`    | `{ code, message }`                 | 提示（维护通知等）→ 原样展示                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | `game.balances`     | `{ balances: { seat, balance }[] }` | 金币场结算后三座余额（**恰 3 条、座位升序**）；**免费场/好友房不会出现**。结算页金币列以它为准；5s 未达 ⇒ 定格「—」（不要停在「结算中…」）                                                                                                                                                                                                                                                                                                                                                  |
| 11  | `match.wait_prompt` | `{ message: string }`               | **缺人友好提示**（`version` 恒 `0`）：仅当该场次（免费场/金币场）的「缺人补机器人」运营开关**关闭**、真人凑不齐 3 人时，入队约 30 秒后收到；之后每 30 秒一条，直到凑齐 3 真人开局、或到达总等待上限收到 `12007`。底部悬浮卡片原样展示 `message`，并给两个操作：「**重新匹配**」= 发 `room.unmatch`（`code 0`）后重新发 `room.match`；「**继续等待**」= 发 `room.match.extend`（见 §4.3 第 10 条），留在原队列继续等真人。开关**开**时永远不会收到本条（缺人直接补机器人开局）；好友房也不会收到 |
| 12  | `game.card_counter` | `{ roomCode, active, source? }`     | **记牌器收费片**：本局记牌器是否开通（按玩家定向；`version` 恒 `0`）。`active=true` 才渲染牌桌入口/横条；`source ∈ pass/credit/none/unknown` 仅供展示与排查。免费场/好友房同样下发（`active` 由服务端按总开关计算）；旧服务端没有本条 ⇒ 客户端按总开关回退 |

**`PlayerView` 形状**（**注意：它按接收者裁剪，不同的人收到的不是同一份**）：

```ts
{ roomCode: string;
  version: number;                       // 与信封的 version 必须相等
  state: 'init' | 'bidding' | 'playing' | 'ended';
  baseScore: number;                     // 本局底分（协议⑥）
  seat: number;                          // 你自己的座位
  hand: Card[];                          // 只有你自己的手牌
  cardCounts: [number, number, number];  // 三家张数，按座位索引
  trustees: [boolean, boolean, boolean]; // 按座位的托管态（徽标数据面；与 cardCounts 同族）
  bottomCards: Card[] | null;            // 叫抢阶段恒为 null；playing 后三家皆可见
  landlordSeat: number | null;           // 「谁是地主」的唯一来源
  currentPlayer: number;
  recentActions: { seat: number; cards: Card[] | null }[];   // 协议④：窗口 2（≤2 条）、旧 → 新；
                                                             // 「不出」是**显式的** cards: null，也占一手
  turnDeadlineAt: number;                // 本回合截止时刻（毫秒时间戳）
  bidPhase: { currentBidder: number; bidMultiplier: number;
              landlordCandidate: number; grabActions: number; redealCount: number;
              kind: 'call' | 'rob';      // 协议③：行动者该用「叫地主/不叫」还是「抢地主/不抢」
              decisions: { seat: number; kind: 'call' | 'rob'; grab: boolean }[] };  // 协议⑦：本轮已发生的决策
  playPhase: { bombCount: number };
  winner?: 'landlord' | 'farmer' }
```

⚠️ `recentActions` **只用于展示**（窗口 2、旧 → 新；`cards: null` = 该座位这一手**「不出」**）。
它**不含**跟牌目标（`type`/`keyRank`/`length` 是服务端的规则态，**永远不下发**），
也**不含**任何未出的手牌 —— 不要拿它反推别家的手牌。

🔴 **`hand.length` 必须等于 `cardCounts[seat]`**（校验器强制这条不变式）。渲染时别用它做别的推断。

**`SettlementResult` 形状**：

```ts
{ roomCode: string; baseScore: number; winner: 'landlord' | 'farmer';
  landlordSeat: number; farmerSeats: number[]; multiplier: number;
  spring: 'none' | 'spring' | 'anti-spring';
  landlordScoreChange: number; farmerScoreChange: number }
```

⚠️ 三个数**必须满足守恒**：`landlordScoreChange + farmerScoreChange × farmerSeats.length === 0`。**显示服务端给的值，不要自己算**。

---

## 6. 版本规则（**最容易做错的地方**）

`version` 是**每局**的版本号，单调递增。**不同类别的消息，丢弃规则不同**：

| 消息类别   | 哪些                                                                | 丢弃判定                                                                                                     |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **快照类** | `game.deal`、`game.state_update`、`game.reconnect` 的 ack           | `version === 当前` → **丢弃**（重复）；`version < 当前` → **回退**，主动重连（M08）；`version > 当前` → 应用 |
| **事件类** | `game.current_turn`、`game.finished`、`game.settlement`、`system.*` | **不按 version 丢弃**；重复到达时按类型幂等（同一 `version` 的 `current_turn` 只渲染一次）                   |
| **不参与** | `room.matched`、`room.state_update`、`match.wait_prompt`、`game.card_counter` | 房间/匹配级消息（`match.wait_prompt`/`game.card_counter` 的 `version` 恒 `0`），**不适用上述规则** |

🔴 **顺序是强制的**：同一次状态转移内 **`game.state_update` 必须先于 `game.current_turn` 应用**。
理由：`current_turn` 的载荷不含 `cardCounts` —— 先渲染回合再补快照，UI 会短暂显示**陈旧的他人张数**。

🔴 **跨局必须复位**：`version` 的比较集**限于同一局**。**换房间（房间号变化）时必须把已应用的
`currentVersion` 复位**，否则新局的 `v1` 会被你判成回退 → 你**永远进不去新的一局**。

🔴 **一次只有一个请求在途**（M06）：发出动作后进入 loading，收到 ack 或 `state_update` 才允许下一次操作。

---

## 7. 错误码与客户端处置（**必须照表分支**）

共 **50** 个码（含 `0`）。处置是**契约的一部分** —— 不得自行发明。

| 码 | 名称 | 含义 | 客户端处置 |
|---|---|---|---|
| `0` | OK | 成功 | `ignore` |
| `10001` | BAD_PARAM | 参数非法（含时钟偏差 >5s） | `toast` |
| `10002` | UNAUTHENTICATED | 未认证 | **回大厅/登录页** |
| `10003` | FORBIDDEN | 无权限 | `toast` |
| `10004` | TOKEN_EXPIRED | 令牌过期 | **REST：先轮换再重放一次**；WS：**回大厅/登录页** |
| `10005` | TOKEN_INVALID | 令牌无效 | **回大厅/登录页** |
| `10006` | RATE_LIMITED | 限流 | `toast` |
| `10007` | UPSTREAM_UNAVAILABLE | 下游不可用（含「拿到的不是平台信封」） | `toast` |
| `10008` | CLIENT_DISABLED | 该客户端已暂停服务（管理端按端关闸：**新**请求 / **新**连接被拒——已连接的 socket 不会被主动踢断） | `toast` |
| `11001` | PHONE_TAKEN | 手机号已注册 | `toast` |
| `11002` | BAD_CREDENTIALS | 账号或密码错 | `toast` |
| `11003` | USER_BANNED | 账号被封（登录失败文案 =「该账号已被封禁，如有异议请联系客服」；**申诉不做**——封禁解除 = 联系客服走人工复核） | **回大厅/登录页** |
| `11004` | USER_NOT_FOUND | 用户不存在 | **回大厅/登录页** |
| `11005` | DEVICE_MISMATCH | 账号已绑定其他设备（设备绑定开关开启后，REST 登录/注册/刷新与 WS 握手双闸拒绝；本机使用需管理员在后台解绑） | `toast`（文案 =「账号已绑定其他设备，如需在本机使用请联系管理员解绑」） |
| `12001` | ROOM_NOT_FOUND | 房间不存在 | **回大厅/登录页** |
| `12002` | ROOM_FULL | 房间已满 | **回大厅/登录页** |
| `12003` | NOT_YOUR_TURN | 没轮到你 | `ignore` |
| `12004` | NOT_IN_ROOM | 你不在这个房间（**多半是漏了 REST 占座**） | **回大厅/登录页** |
| `12005` | KICK_FORBIDDEN | 无权踢人 | `toast` |
| `12006` | FRIEND_ROOM_FAILED | 好友房创建/加入失败 | `toast` |
| `12007` | MATCH_TIMEOUT | 匹配超时 | `toast` |
| `12008` | ROOM_ALREADY_STARTED | 已开局，不能再入座 | **回大厅/登录页** |
| `12009` | ALREADY_IN_QUEUE | 你已在匹配队列里 | `ignore`（**当成成功**：把 UI 置为「匹配中」） |
| `12010` | ROOM_MODE_DISABLED | 该场次暂未开放（场次开关关闭时匹配被拒） | `toast` |
| `12011` | ALREADY_IN_GAME | 你还有未结束的对局或房间 | `toast` |
| `12012` | GAME_UNAVAILABLE | 玩法未开放 / 人数不支持 / 客户端与房间玩法不符 | `toast` |
| `13001` | ILLEGAL_ACTION | 这手不合法 | `toast`（**只翻译服务端的话，不要自己判定**） |
| `13004` | VERSION_CONFLICT | 版本冲突 | 🔴 **就地调 `game.resync` 重拉快照**（见下） |
| `13005` | GAME_OVER | 对局已结束 | **回大厅/登录页** |
| `13006` | INVALID_CARDS | 牌值非法 | `toast` |
| `13007` | ACTION_TIMEOUT | 超时 | **保留码，服务端不会返回** |
| `13008` | BOT_DECISION_TIMEOUT | 机器人决策超时 | **保留码，内部事件，不返回** |
| `13009` | GAME_NOT_STARTED | 对局尚未开始 | **重拉快照** |
| `13010` | RECONNECT_RECORD_MISSING | 没有任何可恢复凭据（无记录、无匹配票、或房间已回收） | **回大厅/登录页** |
| `14001` | E_INSUFFICIENT_FUNDS | 余额不足（整批回滚） | `toast`（文案走 message；**② 金币场消费**，本阶段服务端不会主动产生） |
| `14002` | E_ACTION_CONFLICT | 操作冲突（同 actionId 不同内容） | `toast`（**人祸信号**：联系客服；② 金币场消费） |
| `14003` | E_ENTRY_THRESHOLD | 金币不足入场门槛 | `toast`（文案含所需金额） |
| `14004` | E_RELIEF_UNAVAILABLE | 救助不可用（救助关闭 / 余额充足） | `toast`（**金币场消费**，文案走 message）—— **已退役**（旧 `POST /api/wallet/relief` 随广告片退役；当前由 `GET /api/wallet/relief` 的 `reason` 面承载） |
| `14008` | E_CARD_COUNTER_UNAVAILABLE | 记牌器未开放（总开关关 / 商品价 0；无配置快照走 10007） | `toast`（记牌器收费片；文案走 message） |
| `14009` | E_CARD_COUNTER_PRICE_CHANGED | 记牌器价格已更新（确认价 ≠ 服务端当前价） | `toast`（刷新价格后由玩家重新确认） |
| `14010` | E_CARD_COUNTER_REQUEST_CONFLICT | 同一请求号被不同商品/时长复用 | `toast`（换新请求号重试） |
| `15001` | PAY_CHANNEL_ERROR | 支付渠道调用失败（下单/查询不可用） | `toast`（文案走 message；可重试提示） |
| `15002` | PAY_ORDER_NOT_FOUND | 订单不存在或非本人 | `toast` |
| `15003` | PAY_WITHDRAW_UNAVAILABLE | 提现不可用（开关关/在途已有/低于门槛） | `toast`（文案区分） |
| `15004` | PAY_WITHDRAW_LIMIT | 超单笔/单日限额 | `toast` |
| `15005` | PAY_WITHDRAWABLE_INSUFFICIENT | 可离场额度不足 | `toast` |
| `15006` | PAY_REFUND_UNAVAILABLE | 该笔充值不可退（状态/在途/已退/超可退） | `toast`（文案区分） |
| `15007` | PAY_NOTIFY_VERIFY_FAILED | 回调验签失败 | **保留码，服务端不返回**（内部面：日志+指标） |
| `15008` | PAY_DISABLED | 充值暂未开放 | `toast` |
| `15009` | PAY_STATE_CONFLICT | 状态已变更（管理面源态冲突） | `toast`（409；message 含当前态与合法动作） |

### 🔴 `13004` 的处置**只有一种**，做错就等于重做

**丢弃本地未确认的乐观状态 → 调 `game.resync` 重拉当前裁剪快照 → 让用户重新发起操作。**

- **不得**用 `game.reconnect` 顶替（它是断线恢复，含连接与记录查找，语义不同）。
- **不得**为它触发「主动断开重连」—— 它是可恢复的状态冲突，重连只用于**快照类消息 version 回退**（M08）。
- 三种触发原因（重复送达 / 基于旧状态 / 服务端超时自动动作）**处置完全一致**，不要区分。
- **处置例外**：快照类请求（`game.resync`/`game.reconnect`）**自身**的 13004/13007/13009 不触发新一轮 resync（自激守卫；见设计（`docs/superpowers/specs/2026-10-12-reconnect-until-game-end-design.md`）§5）。

---

## 8. 十条强制纪律（M01–M10）

| #   | 纪律                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | 每次请求带 `timestamp`；服务端校验 **\|clientTs − serverTs\| < 5000ms**                                                                 |
| M02 | **以服务端状态为准**。快照类消息按 §6 的规则丢弃（⚠️ **不要无条件 `version <= current` 就丢** —— 同一次转移的多条推送共享同一 version） |
| M03 | 重连携带 `lastVersion`：`emit('game.reconnect', { lastVersion })`                                                                       |
| M04 | 余额只在服务端确认后更新（**MVP 无余额**）                                                                                              |
| M05 | 用户操作记本地日志（`reqId` / `version` / 动作），供审计                                                                                |
| M06 | 操作后进 loading，收到 ack 或 `state_update` 后才允许下一次操作                                                                         |
| M07 | **收到 `game.finished` 后才结束本局 UI**，禁止提前显示结果                                                                              |
| M08 | **快照类**消息出现 `version` 回退（小于已应用版本）→ **主动重连**，不本地修复。⚠️ 比较集**限于同一局**；`13004` **不属于**此类          |
| M09 | **前端禁止包含任何游戏规则常量**（如底分、倍数）—— 配置由服务端下发                                                                     |
| M10 | 前端不含任何货币计算逻辑（MVP 无货币）                                                                                                  |

---

## 9. 牌值编码（**全系统只有这一套**）

```ts
interface Card {
  r: number;
  s: number;
}
```

- **`r`（DouZero 编码）**：`3`–`14` 表示 3…A，**`17` 表示 `2`（不是 15！）**，**`20` 小王**，**`30` 大王**
- **`s`（花色）**：`0`♠ `1`♥ `2`♣ `3`♦ **`4` 王**（两张王**都是 4**，颜色差异由 `r` 区分）
- 排序：`3 < 4 < … < 14 < 17 < 20 < 30`

🔴 发牌时 `r` 必须落在这四个区间之一：`3..14` / `17` / `20` / `30`。服务端会逐个校验，错一个整条请求被拒。

---

## 10. 一条完整时序（照着写就对）

```
[登录]  POST /api/auth/login {phone,password}          → data.accessToken / refreshToken
[连 WS] io(url, { path:'/socket.io/', auth:{token} })   → 等 'connect'
[匹配]  emit('room.match',{reqId,baseVersion:0,timestamp,payload:{mode:'random',baseScore:15}})  → ack code 0
[推送]  S→C 'room.matched' {roomCode, seat}
[进房]  emit('room.join',{...,payload:{roomCode}})     → ack data:{roomCode,seat,players}
[开局]  S→C 'game.deal' (PlayerView)   ← 记住它的 version，作为首个 baseVersion
[回合]  S→C 'game.current_turn' {seat, timeoutMs}      ← 用 turnDeadlineAt 画倒计时
[叫抢]  轮到你：emit('game.bid',{...,baseVersion:<当前>,payload:{grab:true|false}})
[出牌]  emit('game.play',{...,baseVersion:<当前>,payload:{cards:[{r,s},…]}})
        或 emit('game.pass',{...,baseVersion:<当前>,payload:{}})
        ↑ 每次 ack 或 'game.state_update' 到达后，更新 baseVersion，才允许下一次
[结束]  S→C 'game.finished'  → 只标记「打完了」，**先别显示结算**
        S→C 'game.settlement' (SettlementResult) → 这时才显示
[断线]  socket 自动重连成功 → emit('game.reconnect',{...,payload:{lastVersion}})
        → ack code 0 + 快照 ⇒ 恢复；13005 = 已结束；13010 = 无任何可恢复凭据，回大厅
```

---

## 11. 明确**不存在**的东西（别去找）

- ❌ 应用层 `ping` / `pong`（用心跳内置机制）
- ❌ 任何机器人消息（`bot.move` / `robot.join` / `robot.leave`）
- ❌ 任何「响应型事件」（`room.joined` / `game.reconnected` / `game.timeout` 全部并入 **ack**）
- ❌ `seq` 字段（请求关联靠 ack，幂等靠 `baseVersion` CAS，`reqId` 只用于日志）
- ❌ 消息级游标 / 增量重放（重连一律回**全量裁剪快照**）
- ❌ 观战（MVP 不提供）
- ❌ 聊天
- ❌ 返回完整对局的接口（**任何对局出站响应的形状都必须是 `PlayerView`**）

# 注册必填昵称 + 牌桌展示对手昵称 · 设计 v1.0

> **定位**：玩家资料的最小闭环 —— 注册时收集昵称，牌桌上把它显示给同桌。**不引入资料页、不做改名、不做昵称唯一性。**
> **状态**：设计定稿，供实施计划消费。用户裁决见 §0。
> **接触面**：`packages/protocol` · `packages/user-service` · `packages/room-service` · `apps/client` · conformance/e2e 的注册调用点。

---

## §0 用户裁决（本设计不得与之冲突）

| # | 裁决 | 影响 |
|---|---|---|
| K1 | 昵称**不唯一** | 不加唯一索引、不做注册查重、不加「昵称已占用」错误码 |
| K2 | 存量用户昵称保持 `NULL`，牌桌显示「玩家N」 | 不做数据迁移、不强制补填、不提供改昵称入口 |
| K3 | 牌桌昵称走**服务间 RPC + 缓存** | room-service 向 user-service 批量读昵称，Redis 房间键缓存；不改 JWT、不改网关身份契约 |
| K4 | **补发 `room.state_update` 广播** | 好友房逐人入座时，先入房者也能拿到后入者的昵称 |

---

## §1 范围

### 1.1 本片做

1. **注册必填昵称**：服务端 DTO 强校验（1–20 字符、trim 后非空），客户端注册表单增加输入框。
2. **昵称下发**：新增 `user.nicknames.get` RPC（room → user，TCP 3101），room-service 批量取昵称并缓存于 `room:{code}:nicknames`。
3. **牌桌展示**：`RoomPlayer.nickname?` 随 `room.join` ack 与 `room.state_update` 下发；客户端按座位渲染，自己仍显示「我」。
4. **补发房间状态广播**：`room.join` / `room.leave` 成功后向房间广播 `room.state_update`（协议已声明、客户端已消费，服务端此前从未发送）。
5. **测试与文档同步**：协议校验、三个服务的单测、客户端单测、conformance/e2e 的注册调用全部补齐。

### 1.2 明确不做

- 昵称唯一性 / 敏感词过滤 / 长度以外的字符集限制。
- 改昵称入口、资料页、老用户补填流程。
- 头像（`users.avatar` 继续闲置）。
- 牌桌以外的新昵称展示位（历史页已有快照，不改）。
- 对局协议 `PlayerView` / `SettlementResult` 改动（牌桌名字来自房间成员，不来自对局视图）。

---

## §2 架构决策

**D1｜昵称的唯一真源 = `users.nickname`；注册时必填，存量保持可空。**
数据库列 `varchar(50) NULL` 不动：新注册由 DTO 保证非空，存量用户继续走「玩家N」回落。这样零迁移、零回填、可回滚。

**D2｜牌桌昵称走服务间 RPC，不走 JWT claim、不接受客户端上报。**
- room-service 已有到 user-service 的 TCP 3101 边（`record.write` / `risk.deviceReport`），新增一条同边只读 RPC 成本最低。
- JWT 方案会让昵称陈旧（改名需重登）、令牌变大、旧令牌缺字段，还要改网关身份契约。
- 客户端上报可伪造，违反「服务端权威、前端不造数据」原则。

**D3｜`RoomPlayer.nickname` 是可选字段，缺省 = 未知 ⇒ 客户端回落「玩家N」。**
沿用 `balance?` 的既有惯例：字段缺省表达「这局没有真值」，不在协议里塞 `null`，也不让失败变成入房失败。

**D4｜昵称缓存 = Redis 派生键 `room:{code}:nicknames`。**
- `field = userId`，`value = 昵称`；空串 `''` 是「已知无昵称」的哨兵（避免存量用户每次状态推送都重查）。
- TTL = `ROOM_TTL_SECONDS`（3600s）；`deleteRoom` 必须一并删除（与 `cardcount` / `balances` 同规）。
- 首次 `buildRoomPlayers` 批量回源，此后只读 Redis。

**D5｜`buildRoomPlayers` 是唯一出站组装点。**
`room.join` ack 与 `room.state_update` 共用它，昵称只在这里注入，保证两条路径字段一致。

**D6｜补发 `room.state_update` 由 WsGateway 执行。**
router 在 `room.join` / `room.leave` 成功后调用新增回调（形态照 `onSeatOwners`），由拥有 Socket.IO server 的 `WsGateway` 向房间广播。载荷 = `{status, players: buildRoomPlayers(...)}`。
理由：好友房逐人入座、且服务端从不推送成员变化 —— 不补这条消息，先入房者永远看不到后入者的昵称。

---

## §3 契约

### 3.1 注册

```ts
// packages/user-service/src/users/users.dto.ts
class RegisterDto {
  @IsString() @MinLength(11) phone!: string;
  @IsString() @MinLength(6) password!: string;
  @IsString() @MinLength(1) @MaxLength(20) nickname!: string; // 必填
}
```

- `nickname.trim()` 后为空 ⇒ `400 + 10001`（BAD_PARAM）。
- 落库值 = trim 后的字符串；不做唯一性检查。
- `POST /api/auth/register` 请求体：`{ phone, password, nickname }`。
- 响应不变：`{ accessToken, refreshToken, user: { id, phone, nickname } }`。

### 3.2 RPC `user.nicknames.get`

```ts
// packages/protocol/src/rpc.ts
userNicknamesGet: 'user.nicknames.get'

interface UserNicknamesGetRequest { userIds: string[] } // 1..50，去重由调用方负责
interface UserNicknameEntry { userId: string; nickname: string | null }
interface UserNicknamesGetData { nicknames: UserNicknameEntry[] }
// 响应 = RpcResult<UserNicknamesGetData>（与 record.write 同信封）
```

- 未找到的 userId 返回 `nickname: null`（不是漏项、不是错误）。
- 空数组 ⇒ `{ ok: true, data: { nicknames: [] } }`，不查库。
- `userIds` 元素非字符串 / 数组超长 ⇒ `{ ok: false, code: BAD_PARAM }`。
- 接收侧必须在 `user-service` `app.module.ts` 的 `controllers:` 注册（J21 三同提交）。

### 3.3 出站 `RoomPlayer`

```ts
interface RoomPlayer {
  id: string;
  seat: number;
  cardCount?: number;
  balance?: number;
  nickname?: string; // 新增；空/未知 ⇒ 省略
}
```

- `assertRoomPlayer` 增加：`nickname` 若存在必须是字符串。
- 机器人座位不查 user-service，**回源路径**上恒无 `nickname` ⇒ 客户端「玩家N」（不泄露 `isRobot`）。
  **⚠️ 2026-10-22 更新**：机器人展示昵称改由 room-service 分配并写入昵称 Hash，
  见 [机器人拟人昵称设计](2026-10-22-bot-display-nicknames-design.md)；本条仅描述人类回源路径。

### 3.4 Redis 键

```ts
// packages/room-service/src/rooms/rooms.seats.ts
export function nicknamesKey(code: string): string {
  return `room:${code}:nicknames`;
}
```

- 写：批量回源成功后 `HSET`，并 `EXPIRE ROOM_TTL_SECONDS`。
- 读：`HGETALL`；空串表示「已知无昵称」。
- `deleteRoom` 删除集加入此键。

---

## §4 处理流程

### 4.1 注册

1. 客户端注册模式校验昵称（trim、1–20）→ `POST /api/auth/register {phone,password,nickname}`。
2. 服务端 `ValidationPipe` 强校验 → `AuthService.register` trim 后写库。
3. 登录响应带回 `user.nickname`，客户端 `applySession` 持久化（既有逻辑，零改动）。

### 4.2 入房 / 状态广播

1. `room.join` 成功（`socket.join` 之后）：
   - `buildRoomPlayers` 读座位、余额、张数、昵称 → ack。
   - router 触发 `onRoomStateChanged(roomCode)`。
2. WsGateway 回调：重读房间 → `buildRoomPlayers` → `io.to(roomCode).emit('room.state_update', {status, players})`。
3. `room.leave` 成功：同样触发广播（移除离场者、刷新人数）。
4. 客户端 `session.ts` 已有 `room.state_update` 消费分支 → `applyRoomState`。

### 4.3 昵称回源（`RoomNicknamesService.ensure`）

1. 入参：`room.players`（内部 `Seat[]`）。
2. `HGETALL nicknamesKey` → 已有映射。
3. 缺失的人类 userId（`!isRobot`）批量 RPC（一次调用，最多 3 个）。
4. 成功：非空昵称 `HSET userId nickname`，null `HSET userId ''`，`EXPIRE`。
5. 失败：`warn` 日志，不写缓存，本次返回已有映射（缺失者省略字段）。
6. 返回 `Map<userId, string>`（只含非空昵称）。

### 4.4 客户端展示

- `game.ts` 新增 `seatNicknames: Record<number, string>`，`applyRoomState` 消费 `players[].nickname`。
- `table.vue` / `Settlement.vue` 的 `nameOf`：自己 → 「我」；他人 → `seatNicknames[seat] || 玩家${seat}`。
- `reset()` 清空 `seatNicknames`（换房/回大厅不残留上一个人的名字）。

---

## §5 失败矩阵

| 场景 | 行为 |
|---|---|
| 注册缺昵称 / 空串 / 超 20 字 | 400 + `10001`，不落库 |
| user-service RPC 超时/不可达 | 昵称省略 ⇒ 「玩家N」；入房、开局正常；warn 日志 |
| user-service 返回 `null` 昵称（存量用户） | 缓存哨兵 `''`，本次及后续均显示「玩家N」 |
| 昵称键过期但房间还在 | 下一次 `buildRoomPlayers` 重新回源 |
| `room.state_update` 与 join ack 重复送达 | 客户端幂等应用；room 消息不参与 version 判定 |
| 广播时房间已删除 | `findOne` miss ⇒ 跳过广播，不抛 |
| 机器人座位 | 2026-10-22 起由 room-service 分配展示昵称；未分配时回落「玩家N」 |

---

## §6 测试与验收

### 6.1 user-service

- `RegisterDto`：缺昵称 / 空串 / 空白串 / 21 字 ⇒ 400 + `10001`；1–20 字通过。
- 注册落库：昵称被 trim；响应与 `GET /users/me` 带回同一值。
- RPC：批量返回含 `null`、含不存在的 id；空数组不查库；非法载荷 `{ok:false, BAD_PARAM}`。

### 6.2 protocol

- `RoomPlayer.nickname` 可选、存在时必须是字符串。
- 新 pattern 出现在 `RPC_PATTERNS`；J21 门禁扫描通过。

### 6.3 room-service

- `ensure`：缓存命中不回源；缺失回源一次；null 写哨兵；RPC 失败不写缓存且不抛。
- `buildRoomPlayers`：人类带昵称、机器人不带、无缓存且 RPC 失败时省略字段。
- `deleteRoom` 删除昵称键。
- `room.join` / `room.leave` 后触发广播回调；广播载荷来自 `buildRoomPlayers`。
- 容器装配门禁：新 Client 的 provider / token 可解析。

### 6.4 client

- 注册表单：昵称必填；`rest.register` 发送第三参；`auth.signUp` 透传。
- `applyRoomState` 收集昵称；`nameOf` 昵称优先、回落「玩家N」；自己恒「我」。
- `reset()` 清空昵称映射。
- 既有 `user-profile.test.ts` 的三级回落判据不变（自己的展示仍走 `displayName`）。

### 6.5 conformance / e2e

- 所有注册调用补 `nickname`：`tools/conformance/src/lib/http.ts`、`scripts/verify-e2e.mjs`、`slice-06` 等。
- 新增判据（slice-06）：`room.join` ack 的 `players[].nickname` 与注册昵称一致。

---

## §7 已知边界

- 昵称在房间存续期内是首次拉取的快照（≤1h）；本次无改名入口，可接受。将来加改名需在入房时失效缓存。
- 旧版客户端注册会被服务端拒绝；客户端与服务端需同批发布。
- 存量用户永远显示「玩家N」，直到未来提供资料编辑。
- `room.state_update` 是本次新启用的既有协议消息；其 `version` 字段沿用协议既有形态（房间消息不参与对局 version 判定）。

---

## §8 改动清单（供计划消费）

**新增**
- `packages/user-service/src/rpc/user-nicknames.rpc.controller.ts`
- `packages/room-service/src/gateway/nickname.client.ts`
- `packages/room-service/src/rooms/room-nicknames.service.ts`
- 对应单测

**修改**
- `packages/protocol/src/{rpc.ts,views.ts,validate.ts}` + 测试
- `packages/user-service/src/{users/users.dto.ts,users/users.repository.ts,auth/auth.service.ts,app.module.ts}` + 测试
- `packages/room-service/src/{gateway/rpc.options.ts,gateway/rpc-clients.module.ts,gateway/message.router.ts,gateway/ws.gateway.ts,rooms/rooms.seats.ts,rooms/rooms.service.ts}` + 测试
- `apps/client/src/{pages/login/login.vue,stores/auth.ts,net/rest.ts,net/session.ts,stores/game.ts,pages/table/table.vue,components/Settlement.vue}` + 测试
- `tools/conformance/src/lib/http.ts` + `slices/slice-06-auth-rooms.ts`
- `scripts/verify-e2e.mjs`
- `docs/client-protocol.md`

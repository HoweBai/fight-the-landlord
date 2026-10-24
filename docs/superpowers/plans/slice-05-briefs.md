# 切片 5 开工说明：断线重连（提前）

> 本文件是**切片 5 的唯一需求来源**。它与 `2026-09-13-parallel-dev.md` 的 Global Constraints 12 条、
> `docs/design.md` v4.2、`docs/games/doudizhu.md` v1.2 一起构成本切片的完整约束。
> 角色差异仍以 `agent-briefs.md` 为准；**本切片新增/澄清的裁决**以本文与 `docs/design.md` §6.6.1 为准。

**门禁（与计划一致）**：该切片的 **后端 DoD + 前端 DoD + conformance 用例** 三者同时通过，才允许开始切片 6。

---

## 0. 所有角色开工前的固定动作

```bash
pwd && git branch --show-current          # 确认你在自己的 worktree
git merge master --no-edit                # master 已含两个分支的既有工作；本切片从 master 出发
pnpm install && pnpm build                # dist/ 是 gitignore 的，新 worktree 必须先 build
docker compose up -d                      # 后端角色：测试依赖容器
```

**必读**（本切片新增两处）：
1. `docs/design.md` v4.2 —— 重点：§6.2（信封与丢弃规则）、§6.3（消息清单）、§6.4（裁剪）、§6.5（幂等）、
   **§6.6 + §6.6.1（重连，v4.2 新澄清）**、§8.2（`match:pending` 回退）、§10.1（Redis 键表）、
   §11.2（错误码）、§12.3（M02/M03/M06/M08）
2. `docs/games/doudizhu.md` v1.2
3. `docs/superpowers/plans/2026-09-13-parallel-dev.md`（Global Constraints 12 条，逐字遵守）
4. `docs/superpowers/plans/agent-briefs.md`（角色边界）
5. 本文件

**每个改动都要 commit**（`CLAUDE.md`）。commit message 末尾必须带：

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## 1. 切片 5 的契约面（两端共享，逐字照做）

```
game.reconnect  { lastVersion? }   →  ack { code, data: PlayerView }
```

| 结果 | 何时 |
|------|------|
| `code 0`，`data` = **当前版本**的裁剪快照 `PlayerView` | 记录有效 |
| `13010` | 记录不存在或已过期；**任何「找不到可恢复的对局」都落这里，不得复用 `12001`** |
| `13005` | 对局已 `ended`，无法恢复 |
| `13009` | 房间存在但对局尚未开始（可重试） |

**窗口**：30 秒，**从「服务端观测到断线」起算**；`reconnect:active:{playerId}` 独立键 TTL 35 秒。
判定顺序与刷新时机见 `docs/design.md` **§6.6.1**（本切片新加，是本节争议的权威裁决）。

**重连成功 = 快照到手 + 投递链路恢复**（`socket.join(roomCode)` + 重新登记 `seatOwners`）。
只回快照不恢复投递，玩家重连后收不到任何后续推送——门禁里的「客户端状态与服务端一致」会当场失败。

**`lastVersion` 不参与 CAS**，服务端一律返回当前版本快照。

**前端硬边界（不变）**：`13004` 的**唯一**处置是就地刷新快照 → **必须走 `game.resync`**；
**不得**用 `game.reconnect` 冒充。`game.reconnect` 只用于「socket 断线恢复」（M03/M08）。

---

## 2. 后端 agent（`.worktrees/backend`，分支 `feat/backend`）

**可写**：`packages/{api-gateway,user-service,room-service,game-service,robot-service,shared}/**`、`docker-compose.yml`
**只读**：`packages/protocol/**`、`docs/**`、根配置、`apps/**`

### 2.1 现状（本切片要修的都在这里）

`feat/backend` 已有一版重连实现，**能跑通 happy path，但有四处真实缺陷**：

| # | 位置 | 缺陷 |
|---|------|------|
| B-a | `reconnect/reconnect.service.ts:27` | `expire('reconnect:active:' + playerId)` 作用于**从未被 `set` 的键** → 空操作。`recordConnection()` 是死代码，生产路径不调用它（A.2 **C12**） |
| B-b | `reconnect/reconnect.service.ts:43` | 窗口从 `connectedAt`（`room.join` 写入）起算 → **一局打超过 35 秒后断线必然 `13010`**。这就是 §6.6.1 澄清的缺陷 |
| B-c | `gateway/message.router.ts:226-241` | `handleReconnect` 不看 `lastVersion`、不区分 `ended`、**不回退 `match:pending`**；`deps.game.snapshot()` 抛 `ROOM_NOT_FOUND` 时会冒出 **`12001`**（§6.6 明令禁止） |
| B-d | `gateway/ws.gateway.ts:160-167, 206` | 重连成功后**没有**恢复投递链路：不 `socket.join(roomCode)`、不重登记 `seatOwners`，而 `handleDisconnect` 已把它们清掉 → 玩家重连后**收不到任何后续推送** |

> B-d 是最严重的一条：它让「重连成功」只对 ack 那一刻成立。

### 2.2 任务

- [ ] **B1 `ReconnectService` 重写为「touch + validate」模型**
  - `touch(playerId, socketId, roomCode?)`：同时写 `reconnect:active` 哈希字段（`roomCode` 缺省时沿用已有记录的）**和**独立键 `reconnect:active:{playerId}`（`SET … EX 35`）；`connectedAt = now`。
  - `validateReconnect(playerId)`：无哈希字段 → `null`；有字段但**独立键已消失**或 `now - connectedAt > 30s` → `null`。
  - ⚠️ **过期时不得 `hdel` 哈希字段**——否则判定顺序第 1 步会把它当成「从未入房」，回退 `match:pending`，**绕过 30 秒窗口**。
  - `clearConnection(playerId)`：显式离开时删**两个**键。
  - 删除对不存在键的 `expire()` 与死代码 `recordConnection()`（不留空壳）。
  - 常量（30s / 35s）导出，供测试；注入 `now()` 便于测试时间。
- [ ] **B2 刷新时机（§6.6.1 四条，缺一不可）**
  - `room.join` 成功 → `touch`
  - `game.reconnect` 成功 → `touch`
  - `handleDisconnect` → `touch`（**窗口起算**）；且**只在**该 socket 仍是该 `userId` 的当前连接时才处理，避免旧连接的迟到 `disconnect` 覆盖新记录的 `connectedAt`
  - `handleConnection` 时若 `activeConnections.get(userId)` **仍存在**（上一个连接从未被观测到断开）→ `touch` 续期（硬中断场景）
- [ ] **B3 `handleReconnect` 判定顺序（§6.6.1 五步）**
  - 房间查找：`reconnect:active` 记录 → 回退 `match:pending:{playerId}`（`§8.2/§10.1`）
  - `ended` → `13005`；未开始（拿不到 `PlayerView`）→ `13009`；其余「找不到」→ `13010`
  - `deps.game.*` 抛出的 `GameServiceError`（尤其 `ROOM_NOT_FOUND`）必须映射为 `13010`
  - 日志里记录 `lastVersion`
- [ ] **B4 恢复投递链路（B-d）**
  - 重连成功后 `socket.join(roomCode)`，并按 `PlayerView.seat` 重新登记 `seatOwners`（key 为 `${roomCode}:${seat}`）
  - 路由是纯函数：通过 `RouterDeps` 增加回调（例如 `onReconnected?(socket, view)`）让 gateway 完成 join/登记，不要在路由里直接碰 `socket.join` 的副作用
- [ ] **B5 测试（`CLAUDE.md`：改代码必改测试）**
  - `test/reconnect.service.test.ts`：**现有 5 个用例锁定了 C12 的错误行为（断言 `expire` 独立键）**，必须重写为断言「独立键真被 `SET … EX 35`」；补「独立键消失 → null」「超窗 → null」「`clearConnection` 删两键」
  - `test/message.router.test.ts`：补判定顺序 5 条（无记录 → 13010、`match:pending` 回退、`ended` → 13005、未开始 → 13009、下游 `ROOM_NOT_FOUND` → **13010 而不是 12001**）
  - `test/ws.gateway.test.ts`：补「`disconnect` 起算窗口（`touch` 被调用且 `connectedAt` 为新时刻）」「重连成功后 `socket.join` 被调用且 `seatOwners` 重新登记」

### 2.3 后端 DoD

```bash
pnpm --filter @fight-the-landlord/room-service test     # 期望全绿，且含上面新增用例
pnpm test                                               # 期望 18/18 任务全绿
pnpm lint
```

另外附上**手工证据**（写进汇报）：

```bash
# 记录与 TTL（把 <uid> 换成真实用户）
redis-cli HGET reconnect:active <uid>          # 期望有 {socketId, roomCode, connectedAt}
redis-cli TTL  reconnect:active:<uid>          # 断线后期望 ≈35（不是 -2）
redis-cli TTL  reconnect:active                # 期望 -1（哈希本身不设 TTL，§10.1）
```

**汇报格式**见 `agent-briefs.md` 末节。**不得修改 `packages/protocol`**；需要改契约就在「需要协调者裁决的事项」里提出。

---

## 3. 前端 agent（`.worktrees/frontend`，分支 `feat/frontend`）

**可写**：`apps/client/**`
**只读**：其它全部（**尤其 `packages/shared` 不要动、也不要 import**）

### 3.1 现状

重连状态机已有骨架（`net/socket.ts` 的 `onReconnect` / `onSnapshot` / `scheduleReconnect`、
`stores/game.ts` 的 version 丢弃规则），但有三处与契约不符：

| # | 位置 | 缺陷 |
|---|------|------|
| F-a | `net/socket.ts:458-479` `refreshSnapshot()` | 用 **`game.reconnect`** 做 `13004` 的恢复。§6.5 逐字规定：`13004` 的唯一通道是 **`game.resync`**，**不得**用 `game.reconnect` 充当 |
| F-b | `net/socket.ts` | **没有**「socket 断线 → `game.reconnect { lastVersion }` → 应用快照 → 恢复渲染」这条真正的重连路径；`socket_reconnect` 只是发了个信号给 UI |
| F-c | `net/socket.ts:142-170` `buildRequestPayload` | 额外发 `type` / `meta` 两个**契约外**字段，注释称「mock 的入站校验器读它」。**协调者已核实这是过时的说法**：`tools/mock-server/src/index.ts:105` 正确调用了 `validateClientMessage(type, body)`（§6.2 扁平线格式）。兼容字段必须删除 |

### 3.2 任务

- [ ] **F1 拆开两条语义不同的路径**
  - `resync()`：`send('game.resync', {})`。`CLIENT_ACTION` 表里 `REFRESH_SNAPSHOT` 的分支（`13004`/`13007`/`13009`）**只**走它。
  - `reconnect(lastVersion)`：`send('game.reconnect', { lastVersion })`。**只**用于 socket 断线恢复（M03/M08）。
  - 两者拿到 ack 后共用同一套「快照类」version 规则（`version === 当前` → 丢弃；`< 当前` → 回退信号 M08；`> 当前` → 应用）。
- [ ] **F2 重连状态机**：socket `disconnect` → 释放在途请求（已有）；socket `connect` 且**非首次** → `reconnect(store.currentVersion)` → 成功则应用快照、恢复渲染（`mySeat`/`roomCode`/`hand` 从快照重建）。`13010`/`13005` → 走 `CLIENT_ACTION`（两者都是 `BACK_TO_LOBBY`），回大厅并给出提示。
- [ ] **F3 删除 `buildRequestPayload` 的 `type` / `meta` 兼容字段**（F-c），并修掉那段过时注释。线格式只剩 `{ reqId, baseVersion, timestamp, payload }`（§6.2）。
- [ ] **F4 测试**（`apps/client` 现有 5 个测试文件，扩它们即可）
  - 断线重连：假 socket 触发 `disconnect` → `connect` → 断言 **emit 了 `game.reconnect`**，`payload.lastVersion === 当前 version`；ack 返回 `version` 更大的快照 → 断言 store 应用且 `isMyTurn`/`hand` 恢复
  - `13004`：断言 emit 的是 **`game.resync`**，且**全程没有** emit `game.reconnect`
  - ack 快照 `version === 当前` → 丢弃；`< 当前` → 回退信号
  - `13010` → `BACK_TO_LOBBY`
  - 信封断言：emit 的第二个参数**不含** `type` / `meta` 顶层字段
- [ ] **F5 硬性约束照旧**：不得 import `@fight-the-landlord/shared`；不得出现任何牌型判定/倍数计算/底分常量；
  每条入站先过 `validateInbound()`；每个错误码走 `CLIENT_ACTION` 表分支。

### 3.3 前端 DoD

```bash
cd apps/client
pnpm test      # 期望全绿（含上面新增用例与既有的「不依赖 shared」断言）
pnpm lint      # 含 §12.4 的三条 ESLint 规则
pnpm build
```

**汇报格式**见 `agent-briefs.md` 末节。**不得修改 `packages/protocol`**。

---

## 4. 协调者（本切片）

1. **契约裁决**：§6.6.1 已落 `docs/design.md`（v4.2）；`zod`→手写守卫不变；`game.resync` 与 `game.reconnect` 的分工不变。
2. **`tools/conformance`**（本切片新建，Task 4 的欠账）：真实后端 + 真实 socket.io 客户端，本切片的用例为
   **「断网 ≥10 秒后重连，客户端状态与服务端一致」**，并额外覆盖窗口刷新（见 §5）。
3. **评审**两个 diff（spec 合规 + 质量），跑修复循环。
4. **合并**两侧到 `master`，重建镜像，跑门禁。

---

## 5. conformance 用例（协调者拥有的门禁，写给两端看的验收标准）

用例 `slice-05-reconnect`：真实后端（3000–3003，经 api-gateway 代理）+ 3 个真实客户端。

1. 3 人匹配成局 → 收到 `game.deal`；
2. **保持连接 ≥ 40 秒**（刻意越过旧的「`room.join` 起算 35 秒」窗口，让 B-b 必然暴露），期间至少完成一次叫抢，使 `version` 前进；
3. 客户端 A `socket.disconnect()`（干净断线，服务端会立刻观测到）→ 等待 **10 秒**；
4. A 用**新连接**重连 → emit `game.reconnect { lastVersion: 断线前的 version }`；
5. 断言：
   - ack `code === 0`，`data` 是 `PlayerView`，`data.version >= 断线前 version`；
   - `data.roomCode` / `data.seat` 与断线前一致；
   - **`data.version` 与同一时刻另一路 `game.resync` 的 `data.version` 一致**（「客户端状态与服务端一致」的机械判据）；
   - **A 之后仍能收到推送**：由另一名玩家推进一步状态转移，断言 A 收到该 `game.state_update`（这条才真正验 B-d 的投递链路恢复）；
   - 出站载荷无 `actionLog` / `isRobot` / `botId` / `skillLevel` / 他人手牌（§6.4 规则 4，沿用 `scripts/verify-e2e.mjs` 的机械断言）；
6. 反例断言：另起一个**从未入房**的客户端 emit `game.reconnect` → `code === 13010`（**不是** 12001）。

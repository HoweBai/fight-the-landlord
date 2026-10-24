# 切片 P15 Implementation Plan：收口台账 §1.5 的 **5 条真缺口**（`N31①② / N34 / N35 / N36 / N37`）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `deviation-ledger.md` §1.5 里**仍开放且与代码相关**的 5 条逐条关掉：
**N31①**（终局无房间清理 ⇒ 打完的房间在列表里挂到 `EXPIRE 3600`）· **N31②**（`isWaitingExpired()` 零消费者）·
**N34**（`room.join` 不退出匹配队列 ⇒ 服务端留票）· **N35**（`room:{code}:cardcount` 无写入点 ⇒ `RoomPlayer.cardCount` 恒不出现）·
**N36**（`startGame` 吞 RPC 失败 ⇒ §4.3 的降级在实现里不存在）· **N37**（动作被规则拒绝后计时器**不重挂** ⇒ 该回合零时限）。

**Architecture:** 全部落在 **room-service**（4 条）与 **game-service**（1 条）+ **apps/client**（N35 的渲染）+ `docs/**`。
**不改 `packages/protocol`**（R526：N35 无需契约变更 —— 字段本就在契约里，缺的只是写入方）。

**Tech Stack:** NestJS / TypeScript / Vitest / ioredis / Vue 3 + pinia。

**Spec:** `docs/design.md` §3.1（`Room.timeoutAt`）· §6.4 规则 3（`players` 元素只允许 `{id,seat,cardCount}`）·
§7.3 · §9（回合时限 30 000 ms 由服务端计时）· §4.3（超时/重试/降级表）· §10.1（键表）· §A.3（处置约定）·
`docs/games/doudizhu.md` §9.2（计时器要求）。

## Global Constraints

1. **证据先于结论**：每条关闭都要有**修前 RED** 与**修后 GREEN** 的原文（本仓惯例）。
2. **一个改动一个 commit**；commit message 末尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
3. **conformance 独占**（网关按 IP 计并发 WS 连接，上限 5）；跑前必 `turbo run build --force`；
   改了 service 代码 ⇒ `DOCKER_BUILDKIT=0 docker compose build && docker compose up -d`。
4. **判据要钉性质不钉形态**（R150/R225）；**绝对性质优先于相对量**（R115/R243/R253）。
5. **不得为了凑绿灯改弱判据**；发现判据自身缺陷 ⇒ 先判「判据不完整」还是「产品错了」（R394）。

---

## 协调者裁决（本片新增）

> 编号接 P14 声明的区间（R506–R520），本片协调者区间 **R521–R540**。

- **R521（N35 的实现形态）补写入点 —— 但**不加跨服务写路径**。** 用户裁决是「补写入点，实现 §6.4 的意图」。
  ⚠️ **实测发现更干净的形态**：`room-service` 的 `ws.gateway.onGameEvent()` **本来就收到**
  `event.seatViews: PlayerView[]`（`ws.gateway.ts:58,449,474`），而 `PlayerView.cardCounts` 是**权威**的三家张数
  ⇒ **由 room-service 在收到状态事件时派生并写 `room:{code}:cardcount`**（键的属主不变、无新架构边、
  不需要 `game-service` 去写别人的键）。**结果与用户裁决的意图一致（该键真的被写入）**，实现路径更保守。
- **R522（N36）不改 `startGame` 语义 ⇒ 把 §4.3 该分支裁为「本仓不实现」并改文档。**
  用户裁决：不改语义。⇒ ① `design.md` §4.3 里 `game.start` 的「失败 ⇒ 房间 `cancelled` + 通知玩家」标注为
  **本仓不实现**（写明理由：`startGame` 的 catch 只记日志；**不得**保留一条「声称有」的用例）；
  ② `match.service.test.ts` 那条**标题声称有、实际只断言重试次数**的用例**改名**为它真正断言的东西，
  并**新增**一条「两次都失败 ⇒ `playing` 仍被写入」的**诚实**用例（把现状钉成事实，而不是把它伪装成合规）。
- **R523（N31①+②）接入回收，一次收两半。** 新增 room-service 的**周期回收任务**：
  ① 用 `isWaitingExpired()` 回收**过期的 `waiting` 房间**（它的第一个消费者）；
  ② 回收 **`finished`/`cancelled`** 房间（终局清理，N31①）。
  回收 = 删 `room:{code}` **及其派生键** `room:{code}:seats` / `room:{code}:cardcount`（+ `bot:room:{roomCode}` 视图）。
  **判据必须是绝对性质**（「回收后 `EXISTS room:{code}` = 0 且三个派生键都为 0」），**不得**用「列表长度变了」这类相对量。
- **R524（N34）服务端 `room.join` 兜底清票。** 与 R418 同族（复位点写在**唯一共同写入处**）：
  在 `room.join` 成功路径上清 `match:queue:*`（两个模式）+ `match:pending:{playerId}`
  ⇒ **不再依赖「前端先 `room.unmatch`」**（两条入口——手动加入与建房后加入——都不会漏）。
- **R525（N37）`applyAction` 的 catch 必须重挂计时器。** 与 `:636`（超时路径）**同形**：
  记 `logger.error`（房间/座位/原文）+ 用**当前会话**重挂 30s + **不落盘、不改 `version`**。
  判据：**结构性**（句柄被换掉 + 下一次超时仍会触发），不得用墙钟。
- **R526 本片范围**：`packages/room-service/**` · `packages/game-service/**` · `apps/client/**` ·
  `tools/conformance/**` · `docs/**`。**`packages/protocol` 零改动**（N35 无需契约变更）。
- **R527 每条关闭都要更新台账**：§1.5 的 5 行判定改「已关闭」+ 写明关闭者 commit 与**修前 RED 原文**；
  §0 用 `node scripts/ledger-counts.mjs` 重算。

---

## File Structure

```
packages/game-service/src/game/game.service.ts        Modify: N37 —— applyAction 的 catch 重挂计时器
packages/game-service/test/game.timer.test.ts         Modify: N37 —— 结构性判据（被拒动作后仍会超时）
packages/room-service/src/gateway/message.router.ts   Modify: N34（room.join 清票）· N35（派生并写 cardcount）
packages/room-service/src/rooms/rooms.service.ts      Modify: N31 —— deleteRoom(roomCode)（删主键 + 派生键）
packages/room-service/src/rooms/rooms.reaper.ts       New:    N31 —— 周期回收任务（waiting 过期 + 终局）
packages/room-service/test/message.router.test.ts     Modify: N34 / N35 判据
packages/room-service/test/rooms.reaper.test.ts       New:    N31 判据（绝对性质）
packages/room-service/src/match/match.service.ts      Modify: N36 —— 用例诚实化（仅在测试侧，见 R522）
packages/room-service/test/match.service.test.ts      Modify: N36 —— 改名 + 新增「失败仍写 playing」用例
apps/client/src/pages/lobby.vue                       Modify: N35 —— 房间列表渲染 cardCount（若列表用得上）
docs/design.md                                        Modify: §4.3（N36）· §6.4（N35 的写入时机）· §3.1/§10.1（N31 回收）
docs/superpowers/plans/deviation-ledger.md            Modify: §1.5 五条 + §0 重算 + §3 登记
docs/superpowers/plans/agent-briefs.md                Modify: P15 行 + 门禁实测 + 教训
```

---

### Task 1（N37，最小且危害最大）：动作被拒后重挂计时器

**Files:** `packages/game-service/src/game/game.service.ts` · `packages/game-service/test/game.timer.test.ts`

- [ ] **Step 1: 先写失败用例**（结构性：不依赖墙钟）

```ts
it('人类动作被规则拒绝后，计时器必须被重挂（N37）', async () => {
  // ① 让当前回合有一个计时器；② 投一个必然被拒的动作（如非当前回合的 play）；
  // ③ 断言：计时器句柄**被换掉**，且「再过一回合会第二次触发」（结构性判据，R119/N26 的教训：
  //    `timers.has()` 不能当「有活动计时器」用，必须看句柄是否被替换 + 是否真的再触发一次）。
});
```

- [ ] **Step 2: 跑用例确认 FAIL** → `pnpm --filter @fight-the-landlord/game-service test -- game.timer`
- [ ] **Step 3: 实现**（在 `applyAction` 的 `catch` 里，与 `:636` 同形）：
  `logger.error(...)` + `this.startTurnTimer(roomCode, session)` + **不落盘、不改 `version`**
- [ ] **Step 4: 跑用例确认 PASS**
- [ ] **Step 5: Commit**

### Task 2（N34）：`room.join` 兜底清匹配票

**Files:** `packages/room-service/src/gateway/message.router.ts` · `packages/room-service/test/message.router.test.ts`

- [ ] **Step 1: 写失败用例**：`room.join` 成功后 `match:queue:{random,practice}` 里不得还有该玩家、
  `match:pending:{playerId}` 必须被删（**旧实现两条都在**）。
- [ ] **Step 2: 跑用例确认 FAIL**
- [ ] **Step 3: 实现**：在 `handleJoin` 成功路径上 `await deps.match.cancelQueue(userId)` +
  `await deps.redis.del(matchPendingKey(userId))`（⚠️ 顺序：**先清票再写 reconnect**，且**不得**动 `ok({...})` 的载荷）
- [ ] **Step 4: 跑用例确认 PASS**（含既有 join 用例不回归）
- [ ] **Step 5: Commit**

### Task 3（N35）：`room:{code}:cardcount` 的写入方（R521）

**Files:** `packages/room-service/src/gateway/ws.gateway.ts`（写） · `message.router.ts`（读，已存在） ·
`packages/room-service/test/ws.gateway.test.ts` · `apps/client/src/pages/lobby.vue`（渲染）

- [ ] **Step 1: 写失败用例**：喂一条 `game.state_updated` 事件（带 `seatViews[].cardCounts`）⇒
  断言 `room:{code}:cardcount` 的 Hash 里**每个座位一行**（`field = userId`，`value = 张数`），
  且 `buildRoomPlayers()` 的输出**真的带上 `cardCount`**（旧实现：Hash 恒空 ⇒ 字段恒不出现）。
- [ ] **Step 2: 跑用例确认 FAIL**
- [ ] **Step 3: 实现**：在 `onGameEvent` 处理 `game.state_updated` 的路径上，把
  `view.cardCounts[seat]` 按 `seatOwners`（`${roomCode}:${seat} → userId`）落成 `HSET room:{code}:cardcount`；
  ⚠️ **终局/离开要清理**（与 N31 的 `deleteRoom` 共用路径）；⚠️ **不得**在出站载荷里新增字段（`validateOutbound` 不变）。
- [ ] **Step 4: 跑用例确认 PASS**
- [ ] **Step 5: 前端**：房间列表渲染 `cardCount`（有值时显示「N 张」，无值时不显示）—— 判据 1 条（含无值正对照）
- [ ] **Step 6: Commit**

### Task 4（N31①②）：房间回收任务（R523）

**Files:** `packages/room-service/src/rooms/rooms.service.ts` · `rooms.reaper.ts`（新） · `test/rooms.reaper.test.ts`（新）

- [ ] **Step 1: 写失败用例**（**绝对性质**，不是相对量）：
  ① `waiting` 且越过 `timeoutAt` ⇒ **回收**（三个键全为 0）；② `waiting` 未过期 ⇒ **不得**回收（正对照）；
  ③ `playing` **即使过期**也**不得**回收（§3.1：离开 waiting 时 `timeoutAt` 归零）；
  ④ `finished`/`cancelled` ⇒ 回收；⑤ 回收**幂等**（重复跑不抛）。
- [ ] **Step 2: 跑用例确认 FAIL**
- [ ] **Step 3: 实现**：`rooms.service.ts` 加 `deleteRoom(roomCode)`（删 `room:{code}` + `:seats` + `:cardcount`）；
  `rooms.reaper.ts` 加周期任务（`SCAN room:*` → 读元数据 → 判 `isWaitingExpired` 或终局 → `deleteRoom`），
  **上界**（每轮最多 N 个）与**坏数据不崩**。
- [ ] **Step 4: 跑用例确认 PASS**
- [ ] **Step 5: 接线**（`RoomsModule` 注册 + `onModuleInit` 启动；⚠️ 与 `RobotReclaimTask` 一样要能在测试里关掉）
- [ ] **Step 6: Commit**

### Task 5（N36）：文档 + 用例诚实化（R522）

**Files:** `docs/design.md` §4.3 · `packages/room-service/test/match.service.test.ts`

- [ ] **Step 1: 文档**：§4.3 的 `game.start` 失败分支标注「**本仓不实现**」+ 一句理由（`startGame` 的 catch 只记日志；
  见台账 N36）。**不得**改其它分支。
- [ ] **Step 2: 用例**：把标题声称「失败 ⇒ `cancelled` + 通知」的那条**改名为它真正断言的东西**（重试次数），
  并**新增**一条「两次都失败 ⇒ `playing` 仍被写入」的用例（把现状钉成事实）。
- [ ] **Step 5: Commit**

### Task 6：收口（协调者）

- [ ] **Step 1: 台账 §1.5 五条**改「已关闭」+ 关闭者 commit + **修前 RED 原文**；`§0` 用脚本重算
- [ ] **Step 2: `agent-briefs.md`** 补 P15 行 + 「下一步」推进 + 门禁实测 + 教训
- [ ] **Step 3: 门禁**

```bash
pnpm exec turbo run build --force
pnpm exec turbo run test lint --force          # ✅ 29/29、0 cached
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                              # ✅ 8/8 healthy
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
node scripts/browser-e2e.mjs --scenario full   # ✅ 20/20（N35 的前端渲染要在这里可见）
node scripts/ledger-counts.mjs                 # ✅ 逐区一致（期望 §0 由 90 → 85：5 条关闭）
```

- [ ] **Step 4: Commit**

---

## Self-Review

**Spec coverage**

| 缺口 | 依据 | Task |
|---|---|---|
| N37 计时器不重挂 | `doudizhu.md` §9 前言 + §9.2-2/3 | Task 1 |
| N34 `room.join` 留票 | §8.2 / §6.6.1 | Task 2 |
| N35 `cardCount` 无写入点 | §6.4 规则 3 | Task 3 |
| N31①（终局清理）· N31②（`isWaitingExpired`） | §3.1 / §10.4 | Task 4 |
| N36 `startGame` 吞失败 | §4.3 | Task 5 |

**⚠️ 本片四个高风险点**
1. **相对量判据**（N31 的回收若写成「列表短了」就是 R243/R253 的重演）⇒ 一律钉**绝对性质**。
2. **`timers.has()` 不可当「有活动计时器」**（N26/R119）⇒ N37 的判据必须看**句柄被换掉 + 真的再触发一次**。
3. **conformance/探针独占**；改 service 代码后必须**重建镜像**（robot-service 还是 bind-mount ⇒ 先 `build --force`）。
4. **N35 不得顺手改契约**（R526）：`validateOutbound` 与 `packages/protocol` 保持零改动。

---

## 执行期裁决（回填区，**不要删**）

（执行期发现与代码事实不符时，在此追加一条并编号：本片**协调者区间 R521–R540**。）

### R528 —— N37 的日志级别由 `error` 改为 `warn`（修正 R525 的措辞）

R525 原写「记 `logger.error`」（照抄超时路径 `:636` 的形态）。**执行期判定改为 `warn`**：
**动作被规则拒绝是正常的客户端行为**（点错、越权尝试），不是服务端异常 ——
用 `error` 会把正常路径刷成错误日志、淹没真正的异常。**判据不变**（重挂 + 不落盘 + 不改 version）。

### R529 —— **偏离计划的 Task 3 Step 5**：N35 **不做**前端渲染；同时登记 **N38**

计划要求「房间列表渲染 `cardCount`」。**实测后决定不做**，理由是**同一事实的第二真源**：
- `apps/client/src/pages/table.vue:157` **已经**显示对手剩余张数，走的是
  `store.cardCounts[seat] ← PlayerView.cardCounts`（快照通道，权威）；
- `store.roomPlayers` **零模板消费者**（`grep -rn "roomPlayers" apps/client/src --include=*.vue` = 0 命中）；
  为它设计的 `seatedOthers` 选择器（`stores/game.ts:128`）**同样零消费**。
⇒ 再渲染一遍只会造出第二条展示路径。**N35 的实质（契约字段恒不出现）已由「补写入方」关闭**；
「让前端用它」这一步**没有可加的独立价值**。
⇒ 顺手把这一簇死状态登记为新条目 **N38**（与 N23 的 `canBeatWithHand` 同类），**本片不修**。

### R530 —— **N31 执行期发现的设计交互**：回收**不能**建在 `findAll()` 上

我按计划先写了 `reapOnce()` 用 `roomsService.findAll()` 枚举 —— `cancelled` 那条用例**当场红**。
根因：`rooms.service.ts` 的 `findAll()` **刻意排除 `cancelled`**（原文注释「终态房间不进列表」，
这是**对外 API 的正确行为**），而 `cancelled` 房间因此**对外不可见** ⇒ 它是最**隐形**的堆积源。
**修法**：抽出一份底层实现 `scanAllRooms()`；`findAll()` 在它之上做 API 侧过滤（**行为不变**，
既有 `findAll` 用例全绿），新增 `listForReap()`（**含** `cancelled`）给维护类代码用。
⇒ **教训**：**「列出房间」在对外视图与维护视图里的语义不同** —— 复用同一个方法会让回收悄悄漏掉一类房间。

### R531 —— 假 Redis 的 `scan` 是**恒返回 `[]` 的桩**（本片必须修，否则 N31 的判据是空测）

`test/helpers/fake-redis.ts` 的 `scan` 原先固定返回 `['0', []]` ⇒ **任何真的去扫键的产品代码
在单测里都看不到任何房间** —— `RoomsReaperTask` 会以「夹具没数据」的形态静默不干活。
已按真实语义实现（`MATCH` glob 过滤三类存储；**一轮返完**是真实 Redis 的合法情形）。
既有 `findAll` 用例都显式 `mockResolvedValue` 过 `scan`，因此不受影响。
⚠️ 这正是 P3 那条老教训的又一次发作：**替身的宽容度就是对缺陷的容忍度**。

---

## 门禁实测（P15，**改了 service 代码 ⇒ 标准门禁全套**）

```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force                  # ✅ 10/10
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                                  # ✅ 8/8 healthy
docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
node scripts/browser-e2e.mjs --scenario full       # ✅ 20/20（N31 的房间回收不得影响真局）
pnpm exec turbo run test lint --force              # ✅ 29/29、0 cached
node scripts/ledger-counts.mjs                     # ✅ 逐区一致
```

**处置**：台账 **§0 由 90 → 91** —— **关闭 5 条**（N31 剩余两半 · N34 · N35 · N36 · N37）
**+ 新登记 N38**（N35 收口时发现的死状态）⇒ **89 已关闭 / 0 部分关闭 / 2 仍开放**（N33 · N38）。
单测分项：`room-service` **211 → 219**（+8）· `game-service` **106 → 107**（+1）。

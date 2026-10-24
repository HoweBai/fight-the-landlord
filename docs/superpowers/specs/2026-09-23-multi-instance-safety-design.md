# 斗地主平台 · 多实例安全：把「每进程一行」的假设变成可判的（设计规格）

> **日期**：2026-09-23 · **状态**：设计规格 v1（**待用户复核**）
> **上游**：`docs/superpowers/specs/2026-09-22-manual-room-autostart-design.md` **§9.1-1**（本片的直接入口）
> **归属**：本片的**设计真源**。实施计划另出。
> **触发**：片⑤ 交付时留下一条**从没写下来过**的假设 ——「四条定时循环每进程各跑一行」。
> **裁决（2026-09-23，用户）**：
> 1. **不做分布式锁** —— 只把假设写成**可判的**；
> 2. 顺手把「检查 + 写状态」的两步收成**真原子 CAS**（甲′），**不留尾巴**；
> 3. 真上多实例时才需要的东西，写成**清单**（不实施）。

---

## 0. 现状复核（**本片起草时逐条读代码核实**）

### 0.1 四条循环，各自的双开后果

| 循环 | 位置 | 双开时靠什么自保 | 代价 |
|---|---|---|---|
| 房间回收 | `rooms/rooms.reaper.ts:38` → `deleteRoom` | `DEL` 对不存在的键返回 0 | **零** |
| 机器人回收 | `robot-service` 的 `robot.reclaim.task.ts:27` → `reclaimIdle` | `zrem`/`del` 不存在即 0；且「房间还在 ⇒ 跳过」 | **零** |
| 自动开局扫描 | `rooms/rooms.autostart.ts:58` → `RoomStartService.startRoom` | `addBot` 的 `HSETNX` **原子**；`game.start` **幂等** | 一次多余的 `robot.acquire` RPC |
| 匹配扫描 | `match/match.service.ts:281` → 同一个 `startRoom` | 同上 | 同上 |

⇒ **四条循环都已经是「双开安全」的** —— 靠的不是锁，是**原子原语 + 幂等**。这是既有设计，只是**从没写下来、也从没被钉住**。

### 0.2 🔴 一处**真的**缺口（**复核时发现，且我最初低估了它**）

`rooms/rooms.service.ts` 的 `updateStatus()` 是 **读 → 写两步，中间有真实 await**：

```ts
const room = await this.findOne(code);   // ← 读
const next = { ...room, status, timeoutAt: … };
await this.writeMeta(next);              // ← 写（中间是 await 点）
```

而 `match.service.ts:315-319` 的降级是**两步**：

```ts
const stillWaiting = await this.roomsService.findOne(room.code);   // 读
if (stillWaiting?.status === 'waiting') {
  await this.roomsService.updateStatus(room.code, 'cancelled');    // 写（内部又读一次）
```

⇒ 在「判 `waiting`」与「写 `cancelled`」之间，**另一个定时器**可以把房间推进到 `playing`
（`RoomStartService.startRoom` 只认 `waiting` ⇒ 它**会**赢这一场）⇒ 随后 `cancelled` 覆盖上去
⇒ **房间变终态但玩家还坐在里面**（`cancelled` 进不了列表、`playing` 才不会被回收任务删）。

⚠️ **这不是「多实例专属」**（我最初是这么判的，**错了**）：两个定时器在**同一个进程**里
交错即可命中 —— 匹配扫描器与自动开局扫描器各有自己的 `setInterval`，它们之间没有互斥。

### 0.3 「恰好一个赢」**不是**目标（**纠正设计初稿**）

初稿把判据写成「两个 `startRoom` 里恰好一个返回 true」。**那是错的**：满员房**不需要补位**
⇒ 两个实例都直接走到 `startAndAnnounce` ⇒ 都会 `game.start`（幂等，不会开两次局）
⇒ **两个都返回 true**。目标是**安全**（不损坏数据），不是**互斥**（只让一个跑）。

---

## 1. 裁决

| # | 裁决 | 性质 |
|---|---|---|
| **R1001** | **不引入分布式锁**（四条循环都不加）。理由：两条零代价、两条的竞态后果已由原子原语兜住；锁换来的是「省一次多余 RPC」，而代价是新机制 + 热路径多一次往返 | 用户裁决 1 |
| **R1002** | `RoomsService` 新增 **`cancelIfStillWaiting(code): Promise<boolean>`** —— **真原子 CAS**（判 `waiting` 与写 `cancelled` 在**同一次** Redis 往返内完成）。⚠️ **不是**「收进一个方法」那种缩小窗口的写法 | 用户裁决 2（甲′） |
| **R1003** | `match.service.ts:315-319` 改调 `cancelIfStillWaiting` —— 那两行是这次 CAS 的**全部意义**所在 | R1002 的落点 |
| **R1004** | **四条循环的双开安全性**钉成判据（两个任务实例 + 同一个假 Redis，`Promise.all` **真并发**）。判据取**不变量**（不超员 / 不损坏 / 不抛），**不**取「恰好一个赢」（§0.3） | 用户裁决 1 |
| **R1005** | **真上多实例时才做的事**写成清单（第 4 节），**不实施**。⚠️ CAS 修好之后，清单里**不再有任何「已知的正确性缺口」** —— 剩下的只有「省一次多余 RPC」 | 用户裁决 3 |
| **R1006** | 本片**不碰协议、不碰客户端、不碰编排**（compose 里没有任何 `replicas`/`deploy`，现状是单实例） | 范围 |
| **R1007** | **判据只增不减**：room-service 现 **263** 条；本片只增 | 全局约束 |

---

## 2. 那个 CAS：原子性从哪来

Redis 的 `EVAL` **单线程执行、天然原子** ⇒ 判与写放进同一段脚本，中间不可能插进别的命令。

```lua
-- KEYS[1] = room:{code}
-- 值都是字符串（§10.1 的 Hash 全部以字符串落盘）
if redis.call('HGET', KEYS[1], 'status') == 'waiting' then
  redis.call('HSET', KEYS[1], 'status', 'cancelled')
  redis.call('HSET', KEYS[1], 'timeoutAt', '0')   -- E6：离开 waiting ⇒ 窗口关闭、时刻归零
  return 1
end
return 0
```

**只改 `status` 与 `timeoutAt` 两个字段** —— 与 `updateStatus()` 离开 `waiting` 时**改的是同一对**
（逐字核对过：`updateStatus` 的 `{...room, status, timeoutAt}` 在 `status !== 'waiting'` 时
只让这两格变化）。⇒ **`META_FIELDS` 恰好七个**这条不变量不受影响（不是重写整张 Hash）。

**调用侧**（`RoomsService`）：

```ts
/**
 * ⚠️ 用 `eval` 而不是 `defineCommand`：后者要加载脚本文件，单测里还得额外打桩。
 * `ioredis` 的 `eval` 是内建方法，**不需要任何新依赖**（核过）。
 */
async cancelIfStillWaiting(code: string): Promise<boolean> {
  const result = await this.redis.eval(CANCEL_IF_WAITING_LUA, 1, `room:${code}`);
  return Number(result) === 1;
}
```

**假 Redis 要支持 `eval`**（`test/helpers/fake-redis.ts`）。⚠️ 三条纪律：

1. **只认本片这一段脚本**（比对脚本文本），别的脚本**抛错** —— 绝不能返回一个「看起来成功」的假结果。
   这正是本仓反复付代价的形态：**替身的宽容度就是对缺陷的容忍度**。
2. 真按脚本语义执行（读 `hashes` 的 `status`、条件写两格），**不是**返回一个预设值 ——
   否则 `cancelIfStillWaiting` 的两条正/负对照会变成空测。
3. 在文件头的说明里补一句「`eval` 只服务于本片的 CAS，新增脚本请同步扩展」。

✅ **既有语义已核实**（本片起草时逐条 `grep`）：假 Redis 的 `del` / `hdel` / `zrem` **对不存在的键返回 0**，
`ttl` 对不存在返回 `-2` —— 与真实 Redis 一致 ⇒ **W2/W3/W4 的「幂等」前提成立**，不是纸上推理。

⚠️ **风险如实记：本仓**没有任何** Lua / `eval` 先例**（全仓 `grep` 零命中，本片是第一次）。
⇒ 假 Redis 的 `eval` 一旦写得宽容，**四组判据会一起变成空测**。这就是上面三条纪律存在的理由。

---

## 3. 要钉的四组判据

### 3.1 CAS 本身（`rooms.service.test.ts`）

| 判据 | 内容 |
|---|---|
| 正对照 | `waiting` ⇒ 返回 `true`、`status` 变 `cancelled`、`timeoutAt` **归零** |
| **负对照** | `playing` ⇒ 返回 **`false`**、`status`/`timeoutAt` **一格未动** |
| 负对照 | `finished` / `cancelled` 同形（不得把终态改回来） |
| 边界 | 房间不存在 ⇒ `false`（**不抛** —— 调用方是降级路径，不该因此崩） |
| 不变量 | 调用后 `META_FIELDS` 仍是**恰好七个**（CAS 不得引入新字段） |

### 3.2 四条循环的双开（各自包里）

| # | 文件 | 判据 |
|---|---|---|
| W1 | `rooms.autostart.test.ts` | 两个扫描器**并发**扫同一满员房 ⇒ `playerCount ≤ 3`、最终 `playing`、**不得**被置 `cancelled` |
| W2 | `robot.pool.test.ts` | 两个 **`reclaimIdle()`** 并发（⚠️ **直接调池**，不是任务类 —— 那才是「双开执行同一段逻辑」的真形态；既有用例就是这么测的，不新造助手）⇒ 同一机器人**不会**被回收两次；**房里那个不被回收** |
| W3 | `rooms.reaper.test.ts` | 两个 `reapOnce()` **并发** ⇒ 房间与三个派生键都清干净、**不抛** |
| W4 | `match.service.test.ts` | 两个 `scanOnce()` **并发** ⇒ 不超员、房间**不得**被置 `cancelled` |

⚠️ **W3 是「防御性」的**：回收当前完全幂等 ⇒ 它**今天不会红**。留着它是防将来有人往回收里加一步非幂等的动作。规格里如实这么写，**不假装它现在有判别力**。

⚠️ **W1/W4 也不断言「恰好一个赢」**（§0.3）—— 只断言不变量。两个实例都成功是**允许**的。

✅ **这些并发判据不会 flaky**（复核过两条循环的实现）：`scanOnce()` / `reapOnce()` 内部都是
**顺序 `for` + 两次 `await`**，没有任何「并发窗口」需要抢 —— 判据断言的是**终态**，
而每一步都有原子/幂等原语保底（`HSETNX` / `DEL` / `zrem`）⇒ **最终状态与交错顺序无关**。
⇒ 两次并发调用的终态**必然**是安全的；不安全的实现才会红。

### 3.3 那处降级的顺序（`match.service.test.ts`）

现有判据「补位失败 ⇒ 房间 `cancelled` + `attempts` 累加」**保留**，并补一条：
**房间已被别人开起来（`playing`）时，这条降级不得把它改回 `cancelled`**。

---

## 4. 真上多实例时才做的事（**清单，不实施**）

写在 `rooms/rooms.start.ts` 的方法头上（那里是唯一的临界区，读代码的人一定会经过）：

| # | 做什么 | 为什么 |
|---|---|---|
| 1 | 给 `rooms.start.ts` 的 `startRoom()` 里「判 `waiting` → 补位 → 开局」这一段加 `SET NX EX`（几秒） | 省掉**一次多余**的 `robot.acquire` RPC。**不是**为了正确性 —— CAS（R1002）之后已无正确性缺口 |
| 2 | 回收两条循环**明确标注「无需锁」** | 它们的每个动作本身幂等；上锁是纯开销 |
| 3 | 复核 `game-service` 的**会话表**与 **robot 池**是否也各自持有进程内状态 | 本片只核了 `room-service` 与 `robot-service` 的循环；会话表/池可能是**进程内 Map**（多实例下会分叉）—— 那超出本片范围，但**上多实例前必须核** |

⚠️ 第 3 条是**本片的已知未覆盖项**：我只核实了四条定时循环，**没有**核实两个服务的进程内状态
（`GameService` 的 sessions、`RobotPool` 的池）。如实登记，不假装已经查清。

---

## 5. 明确不做

| 项 | 为什么 |
|---|---|
| 分布式锁（四条循环） | 见 R1001：换来的只有「省一次 RPC」 |
| 改 `updateStatus()` 让它本身原子 | 它有 **6** 个调用点（实测 `grep` 计数）、语义是「无条件写」。CAS 是**新**方法（单一职责），不动既有方法 |
| 协议 / 客户端 / 编排 | R1006 |
| `game-service` / `robot-service` 的进程内状态核查 | 本片未覆盖（第 4 节第 3 条），上多实例前另立 |

---

## 6. 完成判据

| 项 | 判据 |
|---|---|
| CAS 正确 | §3.1 五条全绿（含两条**负对照**） |
| 双开安全 | §3.2 四条全绿；W3 如实标注「今天不会红」 |
| 降级不误伤 | §3.3 两条全绿 |
| 判据只增不减 | room-service **263 → ≥ 270**；其它包不减少 |
| 门禁 | `pnpm run ci` 六阶段全过 · `build:app` DONE |
| 不受影响 | conformance 与探针**应逐字不变**（本片不改线上协议与客户端行为）—— 重跑各一遍确认 |
| 声明落盘 | `rooms.start.ts` 方法头有第 4 节的清单 |
| **Lua 在真 Redis 上可执行** | ⚠️ **新增一条 conformance 判据**（见下） |

### 6.1 🔴 一条判据边界（**复核时发现**）

**假 Redis 永远证不了原子性。** 「判 `waiting` + 写 `cancelled` 在同一次往返内」这件事，
在替身上只能证明**脚本语义**（读得对、写得对、返回值对），证明不了**原子** ——
因为假 Redis 里根本没有「交错」这个可能。

⇒ **必须在真 Redis 上留一条判据**：`slice-12`（手动房那条链）的收尾加一步 ——
**让服务端真跑一次 `cancelIfStillWaiting`**（在真 Redis 上执行 `EVAL`）。

⚠️ 但 `cancelIfStillWaiting` 只有**补位失败**时才被调到（正常路径走不到）⇒ 直接触发它需要造假。
**退路**：判据退一步落在「**真后端上那条降级路径仍然工作**」——
即 conformance 里**造一次补位失败**（把房间占满到机器人申请必然失败，或用一个不存在的房间号），
断言 ① 房间被置 `cancelled`、② **不抛**、③ 服务端日志里**没有** Lua 报错。

> 若这条在实施时发现**造不出**补位失败（比如机器人池总会给一个 bot），
> 则如实登记为「未覆盖：Lua 只在单测的替身上被执行过」——
> **不**为了凑判据去写一条恒真的断言（本仓为此付过多次代价）。

---

## 7. ✅ 完成状态（**实施后回填**，2026-09-23）

| 项 | 结果 |
|---|---|
| §3.1 CAS 五条 | ✅ 全绿（含两条**负对照**）· `c24af04` |
| §3.2 W1–W4 | ✅ 四条全绿。**分层如实标注**（见 §8-②）：W1 的第 ③ 条与 W2 才有判别力；W1 的 ①②、W3 是**回归钉** |
| §3.3 降级不误伤 | ✅ 两条全绿（正对照**补了落盘断言**：真房间里 `status` 真的变 `cancelled`） |
| §3.3 难度判据（交接 §3.1） | ✅ **换思路做出来了**，且**查明了上一个会话卡住的原因**（见 §8-①） |
| 判据只增不减 | ✅ room-service **263 → 275** · robot-service **58 → 59**（零减少） |
| 声明落盘 | ✅ 三件事写在 `rooms.start.ts` 的 `startRoom` 方法头 + **源码机械闸**钉住令牌与位置 |
| Lua 在真 Redis 上可执行 | ✅ **实测**：`cmdstat_eval.calls` **0 → 1**、`attempts` = 1、房间 `44AQKU` 的 `status = cancelled`、日志无 Lua 报错（见 §8-③） |
| 不受影响 | conformance **9 例全绿**：slice-05 29 · slice-06 **54** · slice-07 39 · slice-07.1 28 · slice-08 55 · slice-09 160 · slice-10 185 · slice-11 50 · slice-12 **59**。⚠️ 两处如实说明：① `slice-06` 的条数**不是定值** —— 它逐房间断言（`for (const room of rooms)`），随 `GET /api/rooms` 的房间数浮动（片⑤ 那次记的是 149）；② `slice-12` 52 → 59 是**新增**的 §6.1 判据，不是现有判据变了 |
| 门禁 `pnpm run ci` | ✅ **六阶段全过**。⚠️ **第一次跑红在 `game-service#test`**（`game.controller.test.ts` 11 条 `fetch failed`）—— 那是**已知偶发红**（同签名），**整包单跑 110 passed 全绿** ⇒ 复跑一次全过。**不是**本片引入（本片没碰 game-service） |
| 门禁 `build:app` | ✅ **DONE** |
| 探针 `gate` | ✅ **18/18**（与片⑤ 逐字一致） |
| 探针 `full` | ✅ **33/33**（与片⑤ 一致）。⚠️ **第二次才绿**：第一次 32/33，红在「第二局进入的是**新房间**」——见 §8-⑤（`full` 场景**固有的时序竞态**，与片⑥无关） |

## 8. 执行期发现（**5 条**）

| # | 发现 | 处置 |
|---|---|---|
| **①** | 🔴 **交接文档里那条「难度判据」卡住的真因**：上一个会话把房间提前置 `playing`，而 `createGameRoom` 内部的 `create()` 走 `writeMeta` **整张 Hash 重写** ⇒ `status` 被静默改回 `waiting` ⇒ `startRoom` 一路成功 ⇒ **压根没有降级可言**，于是「CAS 没被调到」。另有一层：替身当时用**闭包变量**记状态（第二真源），那会让「`playing` 不得被取消」这条判据**永远绿** | 注入点改到 **`createGameRoom` 返回之后**；替身的 `cancelIfStillWaiting` 改成**委托真实 CAS**（`eval` 由 `test/helpers/fake-redis.ts` 抽出的 `makeFakeEval` 提供，同一份语义），删掉闭包状态。**RED 证据**：把降级临时换回修复前的两步写法 ⇒ **4 条用例当场红**，其中新那条正是「决定必须交给 CAS」 |
| **②** | ⚠️ **判别力必须如实分层**（spec 自己的要求）：W1 的 ①② 与 W3 **今天必然绿**（`HSETNX` + 幂等 `DEL` 本来就兜住了）。**实测**：把「失败 ⇒ `updateStatus('cancelled')`」注入自动开局扫描器 ⇒ 只有 W1 的第 ③ 条（同一座位拿到**不同**机器人 ⇒ 两条链双双补位失败）**当场红**成 `expected 'cancelled' to be 'playing'`，①② 仍绿 | 把「哪条有判别力、哪条只是回归钉」**逐条写进用例注释**，不假装四条一样硬 |
| **③** | 🔴🔴 **运行中的 room-service 容器是旧镜像**（`dist/rooms/rooms.service.js` 里**没有** `cancelIfStillWaiting`）⇒ 只断言 `attempts ≥ 1` 的话，§6.1 那条判据在旧镜像上是**空测**：旧实现走 `findOne` → `updateStatus('cancelled')`，`attempts` **照样**是 1，一次 `EVAL` 都不会发生 | 判据加**命门**一条：`INFO commandstats` 的 **`cmdstat_eval.calls` 增量 ≥ 1**（服务端计数器，全仓 `.eval(` 只有一处）。并已 `docker compose build room-service && up -d`（重建后核过：无 DI 错误、`dist` 里有 CAS），实测 **0 → 1** |
| **④** | ⚠️ **「房间此刻 status === cancelled」刻意没写成断言**（**偏离 §6.1 的字面措辞**）：`cancelled` 的房间会被回收任务**立即**删掉（周期 60s），它随时可能在轮询间隙消失 ⇒ 断言它必然变成**偶发假红**（R243/R253 的教训）。实测那次读到的是 `cancelled`，但仍不写死 | 只作 `info()` 输出；而 `attempts ≥ 1` **因果地**证明同一件事（脚本返回 1 ⇔ 同一次往返里已写 `cancelled`）。理由写进了判据注释 |
| **⑤** | ⚠️ **探针 `full` 有一条偶发判据**（**与片⑥无关**，如实登记）：「第二局进入的是**新房间**」第一次红（32/33，`上一局 room=3PFYLX v=1 → 第二局 room=3PFYLX v=6`），复跑绿（33/33）。**证据**（trace）：片⑤ 给 `full` 加的那步「手动房 → 等机器人补位」留下的是一局**仍在进行**的对局（3PFYLX）；第二局匹配的 30 秒窗口里，旧局的 `game.state_update`（v2…v6）把客户端留在**旧牌桌**上，而 `matchAndWaitDeal` 的等待谓词是 `page=table && hand>=17 && viewRoom===roomCode` —— 旧牌桌**本身就满足它** ⇒ 谓词可能在新房间的 `room.matched`/`deal` 之前就返回（同一轮里那两条「deal 被接受 / 渲染出 17 张」也因此**假绿**） | 本片**不动探针**（R1006：不改客户端/协议；且 §3.4 要求它逐字不变）。**红的那条正是有判别力的那条**（新房间判据），它把上游那个竞态如实报了出来。⇒ 登记；「`full` 要不要在第二局前先把旧局收掉」另立（**不是**片⑥的范围） |

### 8.1 注入手法的**真实形态**（§6.1 的「造一次补位失败」退了一步）

§6.1 设想的是「把房间占满到机器人申请必然失败，或用一个不存在的房间号」——
实施时发现**匹配路径的房号是服务端随机生成的**（`generateCode()`），conformance 事先无从
投毒；而机器人池**总会**给一个 bot（`takeIdle()` 取不到就 `createBot()`）。
⇒ 实际注入的是「**开局链返回 false 且房间仍在 `waiting`**」这一**同一等价类**的另一入口：

把**本用例自己那个新账号**的 `match:pending:{id}` 预置成错类型的键（String）
⇒ `storePending` 的 HSET 当场 `WRONGTYPE` ⇒ `onSeats` 抛错 ⇒ `startRoom` 返回 false，
而房间**仍在 `waiting`**（`onSeats` 在 `startAndAnnounce` 之前）⇒ 降级那一支被走到。

⚠️ **它是注入的故障，不是自然发生的**（如实标注）。只动这个新账号自己的键
（TTL 300s，跑完显式删），不碰机器人池、不碰任何共享状态 —— 与 `slice-07.2-rpc`
注入合成池成员是同一手法（R232）。

# 交接：多实例安全（片⑥）—— 实施中途的进度与下一步

> **日期**：2026-09-23 · **状态**：~~**实施中途换会话**，交接给下一个会话~~ ⇒ **§3 四件已全部完成**（见文末 §6）
> **设计真源**：`docs/superpowers/specs/2026-09-23-multi-instance-safety-design.md`（**先读它**）
> **已落盘的提交**：`65385f7`（规格）· `4f89c2c`（规格复核）· `c24af04`（CAS 核心）· `0d0e044`/`84537e3`/`274d36a`/`2104d03`（§3 四件）

---

## 0. 一句话

**核心（那个原子 CAS）已做完并提交**；剩四条并发判据、一条难点判据、一条真 Redis 判据、门禁。

---

## 1. 背景（为什么有这一片）

片⑤ 交付时留下一条**从没写下来过**的假设：「四条定时循环每进程各跑一行」。
本片不引入分布式锁（裁决 R1001），而是把假设**写成可判的**，并顺手关掉一处**真的**缺口。

那处缺口（规格 §0.2）：`updateStatus()` 是「读 → 写」两步、**中间有真实 `await`**
⇒ 在「判 `waiting`」与「写 `cancelled`」之间，**同进程的另一个定时器**（自动开局扫描器）
能把房间推进到 `playing`，随后 `cancelled` 覆盖上去 ⇒ **房间变终态、玩家还坐在里面**。
⚠️ **不是多实例专属** —— 我最初误判过，单实例两个 `setInterval` 交错即可命中。

---

## 2. ✅ 已完成（`c24af04`）

| 件 | 位置 |
|---|---|
| `CANCEL_IF_WAITING_LUA`（Redis `EVAL`，判+写同一次往返） | `src/rooms/rooms.service.ts` 顶部 |
| `cancelIfStillWaiting(code)` | 同文件，`updateStatus` 之前 |
| `match.service.ts` 的降级改调它（两步 → 一步） | 原 `:315-319`，见 `if (!ok)` 分支 |
| 假 Redis 的 `eval`（**只认那段脚本**，别的抛错） | `test/helpers/fake-redis.ts` 尾部 |
| CAS 五条判据（含两条**负对照**） | `test/rooms.service.test.ts` 的 `cancelIfStillWaiting` describe |
| 替身补 `cancelIfStillWaiting`（有状态）+ `resetStatus()` | `test/match.service.test.ts` 的 `makeMockRoomsService` |
| 三处断言从 `updateStatus` 改指 CAS | 同文件 |

**判据**：room-service **263 → 268**（+5，零减少）· `pnpm --filter @fight-the-landlord/room-service lint` 干净。

---

## 3. ⏳ 剩下四件（⇒ **已全部完成，见 §6**；本节保留当时的原始描述）

### 3.1 ⚠️ 一条难度判据：规格 §3.3（**上一个会话没做出来**）

**要断言的**：`startRoom` 返回 false 有两种原因 —— ①补位失败（该降级）②房间**已被别人开起来**
（不该降级）。这条要证明 CAS **把两者分辨开了**。

**上一个会话尝试过三版都失败**（已从文件撤下，**没留半成品**）。撤下前最后一次的现象：
`expect(roomsService.cancelIfStillWaiting).toHaveBeenCalledWith('ABC123')` 没被调到 ——
即那条路径根本没走到 CAS。**没有查明为什么**。

**建议**：换思路。可能更省力的两条路 ——
- 直接给 **`RoomStartService.startRoom` 写一条单测**（它才是「返回 false」的产出点），
  在那里区分「补位失败」与「房间已被别人开起来」——比在 `match.service` 里绕替身干净得多；
- 或者承认它**已被覆盖**（CAS 的负对照 + 降级的正对照 = 因果齐了），把它标成「不单独做」，
  **但要在规格里写明理由**，不要默默跳过。

### 3.2 四条循环的双开判据（规格 §3.2 的 W1–W4）

| # | 文件 | 判据 |
|---|---|---|
| W1 | `test/rooms.autostart.test.ts` | 两个扫描器并发扫同一满员房 ⇒ `playerCount ≤ 3`、最终 `playing`、**不得** `cancelled` |
| W2 | `packages/robot-service/test/robot.pool.test.ts` | 两个 `reclaimIdle()` 并发 ⇒ 同一机器人不回收两次、房里那个不回收 |
| W3 | `test/rooms.reaper.test.ts` | 两个 `reapOnce()` 并发 ⇒ 房间与三个派生键清干净、不抛（⚠️ **如实标注「今天不会红」**） |
| W4 | `test/match.service.test.ts` | 两个 `scanOnce()` 并发 ⇒ 不超员、房间不得 `cancelled` |

⚠️ **不要断言「恰好一个赢」**（规格 §0.3）：满员房不需要补位 ⇒ 两个实例都会 `game.start`（幂等）⇒ **两个都返回 true**。判据取**不变量**。

### 3.3 真 Redis 上的那条（规格 §6.1）

**假 Redis 证不了原子性**（它里面没有「交错」这个可能）⇒ 必须在真 Redis 上留一条。
做法：conformance 里**造一次补位失败**，断言房间被置 `cancelled` + 不抛 + **服务端日志无 Lua 报错**。
⚠️ **若造不出**（机器人池总会给一个 bot），**如实登记为「未覆盖」** —— 不为凑判据写恒真断言。

### 3.4 门禁与复核

`pnpm run ci` 六阶段 · `build:app` · conformance 核心 9 例 · 探针 `gate` / `full`
（后两者**应逐字不变** —— 本片不改协议与客户端）。

---

## 4. 环境提醒（都是实测过的，别重踩）

- **改了 room-service 就要重建容器**才验得了真后端（`docker compose build room-service && docker compose up -d room-service`）
  ⚠️ 裸 build 现在**不需要**代理参数（你的笔记第 8 条已订正）；失败先看 base 镜像在不在本地
- **改了 `src/` 的服务，重启容器后先看 `docker logs ftl-room-service | grep -i error`** ——
  DI 的类型导入陷阱（`import type` 引被注入的 provider）**只有真容器会报**（见记忆 `di-type-import-trap`）
- **探针**：`CHROME_BIN="C:\Users\Yobee\AppData\Local\ms-playwright\chromium-1243\chrome-win64\chrome.exe" node scripts/browser-e2e.mjs --no-server --cdp-port 18800 --scenario gate`（`full` 同形）
- **改测试文件请用 Edit 工具，不要用 python 字符串替换** —— 缩进不匹配会**静默不匹配**，
  上一个会话因此连续多轮「改了但没生效」而在错方向上加了更多改动

---

## 5. 下一个会话的开场白（可直接粘贴）

> 读 `docs/superpowers/specs/2026-09-23-multi-instance-safety-design.md` 与
> `docs/superpowers/plans/2026-09-23-multi-instance-handoff.md`（交接）。
> 片⑥ 的 CAS 已完成并提交（`c24af04`），剩下的是交接文档 §3 的四件。
> 从 §3.2 的四条并发判据开始（它们最直接），§3.1 那条难度判据请换思路重来（交接里有建议）。

---

## 6. ✅ 本会话完成（2026-09-23）—— §3 四件全部落地

> **细节与证据在规格 §7（完成状态）§8（执行期发现）** —— 这里只留「哪件、在哪、什么结论」。

| 件 | 结论 | 提交 |
|---|---|---|
| §3.2 W1–W4 | 四条全绿。**判别力分层如实标注**：W1 的第 ③ 条（同一座位拿到**不同**机器人 ⇒ 两条链双双补位失败）+ W2 才有判别力；W1 的 ①②、W3 是**回归钉**（实测：注入「失败 ⇒ `cancelled`」后只有 W1-③ 红） | `0d0e044` `84537e3` `274d36a` |
| §3.1 难度判据 | ✅ **做出来了，并查明上一个会话卡住的真因**：提前置 `playing` 会被 `createGameRoom` 的 `writeMeta` 静默改回 `waiting`（整张 Hash 重写）⇒ 路径压根没走到 CAS。注入点改到 `createGameRoom` **之后**；替身的 CAS 从闭包变量改成**委托真实 CAS**。RED 证据：换回修复前的两步降级 ⇒ 4 条用例当场红 | `274d36a` |
| §3.3 真 Redis | ✅ **实测**：`cmdstat_eval.calls` **0 → 1** · `attempts` 1 · 房间 `44AQKU` `status = cancelled` · 日志无 Lua 报错。注入手法见规格 §8.1（**不是** §6.1 设想的「补位失败」—— 匹配房号是随机生成的，无从投毒） | `2104d03` |
| §3.4 门禁 | ✅ `pnpm run ci` 六阶段全过（第一次撞上 game-service 的**已知偶发红**，整包单跑绿 ⇒ 复跑全过）· `build:app` DONE · conformance 9 例全绿（slice-12 52 → **59** 是新增判据）· 探针 `gate` **18/18**、`full` **33/33**。⚠️ `full` 有一条**偶发**判据（第一次 32/33）—— 与片⑥无关，证据在规格 §8-⑤ | — |

### 6.1 ⚠️ 三条**如实登记**（不得当成「已覆盖」）

1. **运行中的容器可能是旧镜像** —— 本会话实测：重建前的 `dist/rooms/rooms.service.js`
   里**没有** `cancelIfStillWaiting`。⇒ 跑 §6.1 那条 conformance 判据**之前**必须先
   `docker compose build room-service && docker compose up -d room-service`，
   否则它是**空测**（旧实现的 `attempts` 照样是 1）。判据里已加 `cmdstat_eval` 增量的**命门**
   来钉住这件事。
2. **「房间此刻 `status === cancelled`」刻意没写成断言**（偏离规格 §6.1 字面）：回收任务会
   **立即**删掉 `cancelled` 房间，断言它必然偶发假红。改由 `attempts ≥ 1` **因果地**证明。
3. **探针 `full` 有一条偶发判据**（32/33 那次红在「第二局进入的是新房间」，复跑 33/33）：
   根因是片⑤ 给 `full` 加的那步留下的**仍在进行的手动房** —— 它的牌桌状态本身就能满足
   `matchAndWaitDeal` 的等待谓词。**与片⑥无关**（零客户端改动），本片**不动探针**。
   证据与推理在规格 §8-⑤。

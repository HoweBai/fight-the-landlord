# 切片 P9 实施计划：把「最小真浏览器路径」接进门禁 + N32/N30② 跨局会话复位

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两件事，按价值排序：

1. **把「前端 ↔ 真后端」这条接缝接进门禁**（本仓**唯一**长期无人覆盖的一层）。
   `agent-briefs.md` 的「真浏览器验证带来的通用教训」第 2 条逐字：**「CI 里没有的东西，就等于没有验证」** ——
   B1/B2（N28/N29）能活到今天，唯一原因就是**没有浏览器在 CI 里**。本片把它变成一条**可重复执行的机械判据**。
2. **N32 + N30② 同片收掉**（同一根因族：**会话/局的生命周期边界没有复位 store**），
   并把「**新局开始时清 store 不违反 M08**」这条判断**落成裁决**。

**Architecture:** 探针是**零新依赖**的 Node ESM 脚本（`scripts/browser-e2e.mjs`）：
Playwright 缓存的 chromium + Node v24 内置 `WebSocket` 直连 **CDP**，`Runtime.evaluate` 驱动 DOM。
修复是**两处复位**（`stores/game.ts` 的 `setRoom()` + `useGameSession.ts` 的 `stopGameSession()`），
各配单测；探针给 N32 一条**真浏览器判据**（受控复现 + 真打完一局两条路径）。

**Tech Stack:** Node 24（内置 `fetch`/`WebSocket`，**零 npm 依赖**）· Vue 3 + Pinia + vitest（既有）· CDP。

**Spec:**
- `docs/design.md` —— **§0.3 术语表（`version` 是「**每局**状态版本号」）**· §6.2（快照类丢弃规则表）·
  §6.5（`baseVersion` 适用范围）· §6.6/§6.6.1（重连）· §6.7（时序）· **§12.3 M02/M08** · 附录 A.3（处置约定）
- `docs/superpowers/plans/deviation-ledger.md` —— §0（85 条基线）· §1.5 的 **N30/N32** 原文 · §3 · §5
- `docs/superpowers/plans/agent-briefs.md` —— 「真浏览器验证」两节 + 「已知环境事实（新 session 必读）」

---

## 绑定数值（本片开始前的实测基线，不得口头漂移）

| 项 | 数值 | 来源 |
|---|---|---|
| 台账 §0 | **85 条：81 已关闭 / 0 部分关闭 / 4 仍开放** | `node scripts/ledger-counts.mjs`（rc=0） |
| HEAD | `f3c1c6b`，`git status --short` 为空 | 实测 |
| PLAYWRIGHT chromium | `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`（`Chrome for Testing 153.0.8010.12`） | 实测 |
| Node | `v24.20.0`，`typeof WebSocket === 'function'` | 实测 |
| dev server | `127.0.0.1:5173` 在跑（`ss -ltn`） | 实测 |
| 容器 | 8/8（含 `ftl-douzer`/`ftl-redis`/`ftl-mysql`）`healthy` | `docker ps` |
| 已用最大裁决号 | **R403**（`R404–R414` 是 P8 计划里**声明**的协调者区间，实际未用到） | `grep -rhno "R[0-9]\{3\}" docs/ --include=*.md \| sed 's/.*://' \| sort -u \| tail` |
| 机器人补位耗时 | 随机匹配 **31.4s / 32.6s / 66.4s（两局串起来）** ⇒ 单局匹配预算取 **120s** | 探针 `--trace` 时间线 |
| 修前 RED（N32 受控复现） | `game.reconnect{lastVersion:50}` **9 连发**、回退告警条逐字命中、终态 `v50` 卡死 | 探针原文，见下 |

---

## 协调者裁决（本片新增，执行时不得再自行解释）

> **编号起点说明**：已用最大号是 **R403**；`R404–R414` 虽未用到，但已被 P8 的计划文件
> **声明**为它的协调者区间（`2026-09-16-slice-p8-docs-review.md:40`）⇒ 为避免与那份声明撞号，
> **本片从 R415 起编号**，协调者区间 **R415–R430**。

- **R415 真浏览器探针**不挂 `turbo run test`、**也不加进 `scripts/ci.sh` 的六阶段**，
  而是做**与 conformance 同级的独立显式入口**。

  **事实（实测，不是推断）**：① `tools/conformance/package.json` 的 description 逐字写着
  「**刻意不提供 test 脚本**：它需要 3000-3003 的服务在跑，挂进 `turbo run test` 会让无容器环境假红」；
  ② `scripts/ci.sh` 全文**没有任何 conformance 调用**（六阶段 = install/lint/build/test/coverage/eslint-forbidden）；
  ③ `design.md` §13.4 的六阶段是**规格逐字**（阶段名 + 顺序）。
  **裁决**：探针 = `node scripts/browser-e2e.mjs`（根 `package.json` 加 `e2e:browser` 脚本），
  **由协调者在每片门禁里显式跑**，与 13 条 conformance 同级。⚠️ **不得**把它塞进 §13.4 的六阶段
  —— 那会让 §13.4 的实现与规格不再逐字一致，也会让「无容器环境」下 `pnpm run ci` 假红。

- **R416 判据取「最小路径」= 注册 → 随机匹配 → `game.deal` 被客户端 store 接受。**

  **事实**：实测单局匹配要等机器人补位（31.4s），而「手牌 17 张 + 牌桌渲染 17 张」这一步
  已经同时守住 **N28**（推送线格式：`validateInbound` 拒收 ⇒ `view` 恒 `null`、hand 恒 0）
  与 **N29/B2**（默认端点指向真网关：连不上 ⇒ 同样 hand 恒 0）。
  **裁决**：门禁判据**不**要求机器人出完整局（那要几分钟且依赖机器人策略）。
  ⚠️ 但**必须**同时断言 **DOM 里真的渲染出 17 张牌**（`agent-briefs` 逐字：「验证要走到**用户能看见的那一步**」）
  —— 只断言 store 字段会退化成「各段证据外推」的同族错误。

- **R417 「新局开始时清 store」**不违反 M08** —— 这是本片必须落成文字的裁决。**

  **逐字规格依据**（三条，全部来自 `docs/design.md`）：
  1. **§0.3 术语表**：「对局版本（version） | **每局**状态版本号，每次状态转移 +1，用于状态新鲜度判定与乐观锁」
     ⇒ version 的**命名空间是一局**，不是「一个页面会话」也不是「一个 socket 连接」。
  2. **§6.5**：「**首个动作的 `baseVersion` 初值**：客户端从 `game.deal` 推送的 `version` 取得
     （**发牌本身即一次状态转移**）」⇒ 一局的 version 序列**自本局的发牌开始**。
  3. **§6.2 的丢弃规则表** + **§12.3 M02/M08**：说的是「**已应用的** version」——
     在「快照类消息」这一栏内做 `version < currentVersion` 判定。

  **裁决**：M08 的**比较集是「同一局内的 version 序列」**。上一局的终值（实测 `50`）与新局的 `v1`
  **不在同一个比较集里** —— 跨局比较**不是「回退」**，是**换了命名空间**。
  ⇒ 在**新局边界**复位 `currentVersion`（连同对局渲染状态），**恢复的正是 M08 的前提**
  （`currentVersion` 属于当前局），**不是**对 M08 的违反。
  ⚠️ **反过来说也成立**：不复位会让 M08 **误伤**新局的 `v1`（把它当回退丢弃）—— 这正是 N32。
  ⇒ 本条的判据形态：**新局的快照不得触发任何一次回退事件**（探针的 `rollbackEvents` 增量为 0）。

- **R418 复位点选在 `stores/game.ts` 的 `setRoom()`（单点），而不是 `useGameSession.onRoomMatched`。**

  **事实**：进入房间有**两条**独立路径 —— ① 自动：`room.matched` → `joinMatchedRoom`（`onRoomMatched` 内）；
  ② 手动：`lobby.vue` 的 `join()`（输入房号加入）。两条路径**都**写 `store.setRoom(...)`，而 N32 的机制
  （version 闸）与入口无关 —— 只在第一条路径复位会让**手动加入**复发同一缺陷。
  **裁决**：复位规则**只能写在 `setRoom` 里**，守卫是「**`roomCode` 变了才复位**」
  （重复 `room.matched` 不得清掉进行中的对局 —— 幂等性判据见单测）。

- **R419 N30② 的复位点选在 `stopGameSession()`。**

  **事实**：N30② 是「退出登录后 `game.matching` 残留」。退出登录的**唯一会话销毁点**是
  `auth.clearLocalSession()` → （R36 的绑定钩子）`stopGameSession()`；`clearLocalSession()` 自己
  **不能** import `useGameStore` 之外的净新增依赖（它已经靠 `bindAuthRuntime` 反向绑定）。
  **裁决**：在 `stopGameSession()` 里 `useGameStore().reset()` —— 一次性覆盖
  `signOut()`、REST `BACK_TO_LOBBY`（`signOutLocally`）、`restartGameSession()`（登录）三条路径。
  ⚠️ **已知边界（写进代码注释）**：`restartGameSession()` 会先 `stopGameSession()`，
  因此「登录」也会复位对局渲染状态 —— 这在语义上是正确的（刚登录的会话没有任何对局），
  并由单测钉住「登录前 store 里的残留不会带进新会话」。

- **R420 N30 本片只关 ② ⇒ 判定为「部分关闭」，并逐字写明剩下哪半。**

  **事实**：N30 是三处（① 断线无连接状态指示、② 退出后 `matching` 残留、③ 大厅无建房入口 + 房间列表不可点）。
  本片只修 ②。**裁决**：台账判定写 **「部分关闭」**，同意栏**必须**写清「①②③ 中只剩 ② 已修，
  ① 与 ③ 仍开放」—— §5 第 5 条：「部分关闭**必须**写清剩下的是哪一半」，这是本表最容易退化成
  「大概修过了」的地方。

- **R421 N31 本片只做定位取证，不改代码。**

  **事实**：N31 是 `GET /api/rooms` 的 `status`/`playerCount` 与真实对局状态不一致 + 房间堆积，
  台账逐字写着「**只观察、未深挖**……需一次独立核实再定归属」；它是**后端**问题，
  而本片派的是「浏览器门禁 + 前端会话复位」。**裁决**：本片做一次**独立核实**（只读取证：
  `GET /api/rooms` 与 Redis/服务端真值对照），把结论写进台账 N31 行；
  **不在本片修**（改了会让本片的门禁范围失控，也不符合「一片一个根因族」的分工）。

- **R422 门禁范围：本片**改代码** ⇒ 标准门禁**（不是 P8 的轻量门禁）。

  ```bash
  pnpm exec turbo run test lint --force       # ✅ 期望 29/29，0 cached
  pnpm exec turbo run build --force           # ✅ 期望 10/10（conformance 前必跑，robot-service 是 bind-mount）
  cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..
  pnpm run ci                                 # ✅ §13.4 六阶段
  node scripts/ledger-counts.mjs              # ✅ §0 与 §1.x 逐区一致
  node scripts/browser-e2e.mjs                # ✅ 本片新增的接缝判据（gate = 最小路径 + N32 受控复现）
  node scripts/browser-e2e.mjs --scenario full  # ✅ N32 的真跨局路径（慢，一次即可）
  # conformance 13/13（**独占跑**，每条套 timeout 300，不传 CONFORMANCE_STEPS）
  ```

---

## 执行模型

| 角色 | 工作区 | 负责 |
|------|--------|------|
| **协调者**（本 session） | `/home/howe/pokergame`（master） | **全部改动**：探针（`scripts/`）· 前端复位（`apps/client/src`）· 单测 · `docs/**` · 门禁 |

**为什么不起 agent**：
- 探针是本片的核心难点，且需要「先量再裁」的多轮实测（时间线诊断、RED 取法）—— 派工反而多一层转述损耗；
- 前端改动只有两处、各配一条单测，**不满足** `dispatching-parallel-agents` 的「2+ 独立任务」门槛；
- ⚠️ 本片**不动** `packages/protocol`（协调者独占那条规矩在本片无触发点），也**不动**后端。

**⚠️ 不涉及「conformance 独占」的冲突**：探针自己起一个独立 chromium（`--cdp-port 9333`），
但它**会**经 5173 → 3000 打真网关 ⇒ **同一时刻不得与 conformance 并跑**（网关按 IP 计并发 WS 连接，上限 5）。
⇒ 探针纳入「独占纪律」的适用范围（与 conformance 同级）。

---

## File Structure

```
scripts/browser-e2e.mjs                       Create: 零依赖 CDP 真浏览器探针（gate / minimal / second-game / full）
package.json                                  Modify: 加 "e2e:browser" 脚本（不新增任何依赖）
apps/client/src/stores/game.ts                Modify: setRoom() 在 roomCode 变化时复位（R418）
apps/client/src/composables/useGameSession.ts Modify: stopGameSession() 复位 game store（R419）
apps/client/test/game-store-session-reset.test.ts   Create: N32 的单测判据（跨局边界 + 幂等守卫）
apps/client/test/session-restart.test.ts      Modify: 补「登录/重启会话后 matching 不残留」（N30②）
docs/superpowers/plans/deviation-ledger.md    Modify: N30 → 部分关闭；N32 → 已关闭；N31 补定位结论；§0 重算
docs/superpowers/plans/agent-briefs.md        Modify: 门禁实测 + 新增教训 + 环境事实（真浏览器探针怎么跑）
docs/superpowers/plans/2026-09-17-...（本文件） Modify: 回填执行期裁决与门禁实测
```

---

## Task 1（协调者）：零依赖 CDP 真浏览器探针（R415/R416）

- [ ] **Step 1: 先验证三件事能不能成立**（不成立就降级，不许硬上）
```bash
node -v && node -e "console.log(typeof WebSocket)"       # ✅ v24.20.0 / function
ls ~/.cache/ms-playwright/                               # ✅ chromium-1243
ss -ltn | grep -E '5173|3000'                            # ✅ dev server + 网关都在听
```
- [ ] **Step 2: chromium 的**沙箱**启动参数**（这四条缺一条就 core dump —— 实测）
```bash
HOME=$(mktemp -d) chrome --headless=new --no-sandbox \
  --disable-dev-shm-usage --disable-crash-reporter --remote-debugging-port=9333 ...
# 不加 --disable-dev-shm-usage ⇒ /dev/shm 不可写 ⇒ Trace/breakpoint trap (core dumped)
# 不把 HOME 指向临时目录 ⇒ crashpad 写 ~/.config 被拒 ⇒ 同样 dump
```
- [ ] **Step 3: 跑通「注册 → 随机匹配 → 牌桌 17 张」**（判据见 R416）
- [ ] **Step 4: 加 N32 的**受控复现**判据**（注入 v50 已结束形态 → 匹配 → 断言新局快照被接受 + 零回退 + 零重连）
- [ ] **Step 5: 加 `--scenario full`**（真打完一局 → 返回大厅 → 第二局），作为受控复现的**对照**

**Task 1 DoD**：`node scripts/browser-e2e.mjs` 在**修前** RED（判据 2 组红）、在**修后** 全绿；
失败时打印**帧时间线**（`game.reconnect` 逐帧、`room.matched`/`game.deal`、`13010`）。

---

## Task 2（协调者）：N32 + N30② 两处复位（R417/R418/R419/R420）

- [ ] **Step 1: 写 RED 单测**（先红）
```bash
cd apps/client && pnpm test -- game-store-session-reset
# 期望：`setRoom('B')` 之后 currentVersion 必须是 -1 —— 修前实测 expected 50 to be -1
```
- [ ] **Step 2: 改 `setRoom()`**（R418：`roomCode` 变了才复位）
- [ ] **Step 3: 改 `stopGameSession()`**（R419：`useGameStore().reset()`）
- [ ] **Step 4: `pnpm test -- session-restart`** 与全量 `apps/client` 单测（`git diff` 只应出现上面四个文件）
- [ ] **Step 5: 探针两条路径都转绿**（受控 + 真跨局）

---

## Task 3（协调者）：N31 定位取证（R421，只登记不修）

- [ ] `curl -s localhost:3000/api/rooms`（带 token）× 与 Redis 的 `room:*` 真值、`game:*` 会话状态对照
- [ ] 结论写进台账 N31 行（「实测到的是 X；归属 = Y；本片未修」）

---

## Task 4（协调者）：台账与 briefs 收口

- [ ] N30 → 部分关闭（写明剩 ①③）；N32 → 已关闭（附探针原文）；§0 用脚本重算
- [ ] `agent-briefs.md`：追加「切片 P9 门禁实测」+ 教训（真浏览器探针的**环境事实**必须落盘）

---

## 门禁（协调者，R422）

见上。

---

## Self-Review

**Spec coverage**

| 项 | 落在哪个 Task |
|---|---|
| 「最小真浏览器路径」进门槛 | Task 1（R415/R416） |
| N32 | Task 1 判据 2 + Task 2 Step 1/2 |
| N30② | Task 2 Step 3 |
| M08 边界裁决 | R417（本文件 + `design.md` §6.2 旁注 + 台账） |
| N31 定位 | Task 3（R421） |
| 台账计数 | Task 4 + `node scripts/ledger-counts.mjs` |

**Placeholder scan**：无 TBD。探针的判据、RED 取法、启动参数、门禁命令全部逐条写死。

**⚠️ 本片的三个高风险点**
1. **受控复现可能把前提造歪**：`--scenario full` 是它的对照 —— 若真跨局路径的机制与受控路径不同，
   以**真路径**为准。⚠️ 实测已发现一个坑：在**仍在进行**的房间里点「随机匹配」，服务端会把**同一个
   `roomCode`** 再发一次 ⇒ 那不是跨局，判据会测错东西。受控路径的注入必须放在**匹配之前**。
2. **探针自己会「静默假绿」**：谓词写错（例如只看 store 不看 DOM）就会把「hand 恒 0」当成通过 ——
   因此**每条判据都要有失败详情**，并保留 `--trace` 帧时间线。
3. **「修前 RED」必须在修前真的跑出来**（P3 教训 1）：本片已在**未修**代码上跑出 RED 原文（见下）。

---

## 执行期裁决（回填区）

> 编号接开工前落盘的 R415–R422；本片协调者区间 R415–R430。

### R423 受控复现必须**先注入、后匹配**，且**必须**配一条真路径对照

**计划怎么写**：Task 1 Step 4「加 N32 的受控复现判据（注入 v50 已结束形态 → 匹配 → 断言）」——
**没写清注入的时机**。
**事实是什么**（第一版探针实测，**判据假绿**）：第一版写成「先匹配进牌桌 → 点返回大厅 → 注入 v50 → 再匹配」。
实测（`--scenario second-game`）服务端把**同一个 `roomCode`** 又发了一次
（`room.matched{roomCode: 8RV3BC}`，玩家仍坐在那一局里）⇒ 该判据测的是「同一局的重复匹配」，
**不是**跨局边界；终端读数 `房间 8RV3BC v5`（同房），断言组反而「通过」。
**怎么改的**：受控复现改成「**注入后立刻匹配**」（在一个**新页面会话**里：注册 → 注入 → 匹配），
并**新增** `--scenario full` 做**真路径对照**（真打完一局 → 返回大厅 → 第二局）。
两条路径的修前 RED **逐帧一致**（同一条 notice、同类连发），这才算判据有效。

### R424 探针的「页面会话」必须先清 `localStorage` 并断言停在登录页

**事实是什么**（第一版探针**自己**的假绿）：`newPageSession` 只做 `Page.navigate`，
而 `auth.hydrate()` 会把上一次会话的令牌恢复回大厅 ⇒ 第二次会话里**「注册」这一步被整个跳过**
（`.login__field input` 都不存在），断言 `authenticated && page === 'lobby'` **照样通过**。
**怎么改的**：`newPageSession` = 导航到应用源 → `localStorage.clear()` → **再次**导航，
并加两条硬断言：**加载后 `page === 'login'`** + **`localStorage` 为空**。
⇒ 与 R115「先证明探针有效」同族：**凡是「先做 X 再断言 Y」的探针，都要断言 X 真的发生过**。

### R425 N31 的 `playerCount` 那半**经实测不成立**；根因与两处连带缺陷一并登记

**计划怎么写**：R421 只写「做一次独立核实（只读取证）」。
**事实是什么**（本节全部为实测）：
1. **根因**：全仓 `updateStatus()` 只有**一处**调用 —— `match.service.ts:296` 的 `'cancelled'`；
   `'playing'`/`'finished'` **从未被写入**（`grep -rn "updateStatus(" packages/*/src apps/*/src tools/` 只回 3 行）。
2. **`playerCount` 不是缺陷**：`playerCount = readSeats().length`，而匹配成功后 3 个座位**真的**都占着
   （机器人也占座）⇒ `3/3` 是**真值**。登记时写的「`status`/`playerCount` 都与真实对局不一致」**只有 `status` 成立**。
3. **同源连带（新发现）**：`message.router.ts:426` 的 `if (room.status === 'playing')` 是
   `RoomPlayer.cardCount` 的**唯一**填充点 ⇒ 该条件恒 false ⇒ **死分支**，§6.4 规则 3 允许的 `cardCount` 从不出现。
4. **房间堆积的机制**：全仓**没有**房间删除点（只有三处 `EXPIRE 3600`），`findAll()` 只排除 `cancelled`；
   且 `rooms.timeout.ts` 的 `isWaitingExpired()` **零消费者**。
**怎么改的**：**不改代码**（R421），把 1–4 逐条写进 `deviation-ledger.md` §1.5 的 N31 行
（**同一条根因**的四个面，不新开编号），并把「`playerCount` 不成立」这条**订正**写明。

### R426 真浏览器探针纳入「独占纪律」的适用范围

**事实**：探针经 5173 → 3000 打**真网关**，而网关按 **IP** 计并发 WS 连接（上限 5，§5.4）。
**裁决**：探针与 conformance **同属**独占纪律 —— 同一时刻只跑一个；跑探针时**不重建镜像、不重启容器**
（与 conformance 的既有规矩逐字相同）。已写进 `agent-briefs.md` 的环境事实。

### R427 `design.md` 升 **v4.3**：§6.2 丢弃规则表 + §12.3 M08 补「比较集限于同一局」

**依据**：§A.3「若认为本文有误，走文档变更流程（修订本文 + 更新附录 A.1 裁决记录）」——
本次**不是**认为本文有误，而是本文对「`version < currentVersion` 的比较集」**表述不完整**
（§0.3 已逐字写「**每局**状态版本号」，但 §6.2 的表与 M08 都没说跨局怎么办）。
**处置**：按 v4.2 的成例（「**只做澄清，不改语义**」）升级版本号 + 补 `修订记录` 一行，
在 §6.2 的表后加澄清段、在 §12.3 的 M08 行加一句交叉引用。**A.1 不动**（没有与旧文档的冲突裁决）。

### 门禁实测（R422）

```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force          # ✅ 10/10，0 cached
pnpm exec turbo run test lint --force      # ✅ 29/29，0 cached（client 169 passed(+2 skipped)）
pnpm run ci                                # ✅ 六阶段全绿；第 6 阶段 8/8/5/6/3/21 passed
cd apps/client && pnpm lint && cd ../..    # ✅ vue-tsc --noEmit 干净

node scripts/browser-e2e.mjs                  # ✅ 16/16（gate：最小路径 + N32 受控复现）
node scripts/browser-e2e.mjs --scenario full  # ✅ 20/20（真打完一局再开第二局）

# conformance 13/13（独占；每条 timeout 300）
# ✅ slice-11 50 · rpc 65 · deploy 104 · hardening 103 · boundary 82 · security 40
#    · 07.1 28 · 07 39 · 10 185 · 09 160 · 08 55 · 06 244 · 05 29
node scripts/ledger-counts.mjs             # ✅ §0 与 §1.x 逐区一致（85：82/1/2/0）
```

**修前 RED 原文（N32；两条路径各一次，机制逐帧一致）**

```
# ① 受控复现（注入 v50 已结束形态 → 立即匹配）——判据 2 组 5 项全红
+32.61s S→C room.matched {"roomCode":"K63I6I"}
+32.61s S→C game.deal    {"version":1, hand:[17 张]}
+32.61s C→S game.reconnect {"lastVersion":50}
+32.97s state table|K63I6I|v50|hand0|rbtrue
        notice=「reconnect_ack 快照 version 1 回退于已应用的 50；按 M08 主动重连，不做本地修复」
        ⇒ game.reconnect ×9（含 +96s/+129s 的续发）
# ② 真打完一局（v56 ended → 返回大厅 → 随机匹配 → 新房间 HGC1JS）——判据 2′ 组 5 项全红
+115.53s state lobby|06GXT2|v56|hand17
+147.88s S→C room.matched {"roomCode":"HGC1JS"}
+147.89s C→S game.reconnect {"lastVersion":56}
+148.22s notice=「reconnect_ack 快照 version 1 回退于已应用的 56；…」  rbtrue
        ⇒ game.reconnect ×7 → +211.91s S→C {"code":13010,…} → 被踢回大厅，第二局永远进不去
```

**修后**：`rollbackEvents === 0`、`game.reconnect` 帧数 **0**、第二局 = 新房间 + `v1` + 17 张牌 + DOM 17 张。

**一并落盘的改动**：`scripts/browser-e2e.mjs`（新增）· `package.json` 的 `e2e:browser` ·
`apps/client/src/stores/game.ts`（`setRoom` 复位）· `apps/client/src/composables/useGameSession.ts`（`stopGameSession` 复位）·
`apps/client/test/game-store-session-reset.test.ts`（新增 5 条）· `design.md` v4.3 · 台账 N30/N31/N32 + §0 · 本文件与 `agent-briefs.md`。

**提交**：`01e9796`（探针）· `30bc636`（N32+N30② 修复）· 收口提交见 `git log`。

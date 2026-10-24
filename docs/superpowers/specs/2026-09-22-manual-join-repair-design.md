# 斗地主平台 · 手动进房修复（设计规格 / spec）

> **日期**：2026-09-22 · **状态**：设计规格 **v2**（v1 已复核，v2 = 复核订正：H3′/H4/H5 + 口径订正）
> **片号**：本文暂称「本片」；`2026-09-21-landscape-foundation-design.md` 的 **R708** 把那一批需求拆成三片，三片已全部合入
> ⇒ 本片是**片①/②/③ 之后的第一片**（若沿用序号即「片④」——**序号由用户定，本文不预设**）。
> **上游**：
> - `docs/superpowers/specs/2026-09-22-portal-rework-design.md`（片③ 门户重做；其 **§9 F6 / F7** 是本片的直接入口，**§12.2** 是交接提醒）
> - `docs/superpowers/specs/2026-09-21-landscape-foundation-design.md` §1.4（**全局约束**，本片逐条沿用）
> **归属**：本片（手动进房修复）的**设计真源**。实施计划另出。
> **触发**：片③ Task 6 的真浏览器走查查出「创建房间」在真后端上是坏的（**既有**缺陷）。
> **裁决（2026-09-22，用户）**：
> 1. 修法取 **方案 2 —— 客户端在 WS `room.join` 之前补上 REST 入座**（服务端零改动）；
> 2. 探针**要加**「创建房间 → 进房」一步；
> 3. 验证三层都上（忠实 mock / conformance / 真浏览器走查）；
> 4. F7（空态文案）**跟着本片做**，写法取 `finished-text`；
> 5. 🔴 **范围只到「进得去房」** —— 「手动房间开不了局」**另立一片**（**复核后新增的裁决**，见 §1.1 R815 / §6.1 / §8.1）。

---

## 0. 缺陷复核（**本片起草时在真后端上实测复现**，非转述）

### 0.1 实测记录（当前 `master` `4361425` + 运行中的 docker 栈）

一次性脚本（临时文件，已删）走真网关 + 真 WS：

```
① 注册                                          ⇒ ok
② REST 建房  POST /api/rooms                    ⇒ 201 {code:0, data:{code:"5E11XI", playerCount:0, status:"waiting"}}
③ WS 握手                                       ⇒ ok
④ WS room.join {roomCode:"5E11XI"}              ⇒ {code:12004, message:"You are not in this room"}   ← 缺陷复现
⑤ REST 入座  POST /api/rooms/5E11XI/join        ⇒ 201 {code:0, data:{code:"5E11XI", playerCount:1}}
⑥ 再 WS room.join {roomCode:"5E11XI"}           ⇒ {code:0, data:{roomCode:"5E11XI", seat:0, players:[{id:"…",seat:0}]}}
```

**⑤⑥ 是本片修法的实证**：REST 入座端点**存在、可用、幂等**，缺的只是「客户端去调它」。

### 0.2 根因（三点，缺一不可）

| # | 事实 | 位置 |
|---|---|---|
| ① | REST 建房**只写元数据**，`players: []` —— **建房者不入座** | `rooms.service.ts:111-128` |
| ② | WS `room.join` 是**挂载**操作：要求「已在 `room.players`」或「有 `match:pending`」，**它从不占座** | `message.router.ts:208-223` |
| ③ | 真正占座的唯一 REST 落点 `POST /api/rooms/:code/join` **客户端没有任何调用点** | `rooms.controller.ts:42-50`；`net/rest.ts` 只导出 `rooms()` / `createRoom()` |

⇒ **不是 `room.join` 少做了一件事，而是客户端漏掉了一整个 REST 落点。**

### 0.3 「`room.join` 是会员制」不是 bug，是被钉住的设计

这条必须在设计期就说清 —— 它决定了修法**不该**往哪走：

| 证据 | 内容 |
|---|---|
| `message.router.test.ts:450` | 「room.join answers 12004 when the caller is neither a member nor pending」 |
| conformance `slice-07-match-join.ts:96-105` | 第 6 组**反例**：「第 4 个账号 room.join 同一房间 ⇒ 12004（**不是** 12001）」 |
| `message.router.ts:217-223` + R48 注释 | 座位只能来自 `room.players` 的 `Seat.seat` 或 `match:pending.seat`；`socket.join` 是挂载 |

⇒ **`room.join` = 挂载 socket + 消费 ack**；**REST join = 占座**。两件事，谁也不该顺手做另一件。

### 0.4 影响面

四条开局路径里**三条坏**：

| 路径 | 客户端入口 | 为什么坏 |
|---|---|---|
| 随机匹配 | `match()` → 等 `room.matched` → `joinMatchedRoom()` | ✅ **好**（`match:pending` 命中 `handleJoin` 的第二个条件） |
| 创建房间 | `createAndJoin()` → REST 建房 → `join(code)` | ❌ 建房不入座 ⇒ 12004 |
| 房号加入 | `join()` | ❌ 从来就没入座过 ⇒ 12004 |
| 点房间列表项 | `join(room.code)` | ❌ 同上 ⇒ 12004 |

后三条的 12004 经 `CLIENT_ACTION` 表判 **BACK_TO_LOBBY**（`protocol/src/errors.ts`）⇒ notice + `store.reset()` + 被踢回大厅 + 一句**英文原文**（服务端 message）。**房间建好了，人没进去。**

### 0.5 为什么一直没被发现（**本片验证策略的直接依据**）

| 层 | 实际行为 | 后果 |
|---|---|---|
| 客户端单测 | WS mock 的 ack **手写恒 0**（`lobby-ux.test.ts:184` 等）；`stubFetch` 对任何 POST 都回 `{code:0}` | 这条路在单测里**永远是绿的** |
| 探针 `browser-e2e.mjs` | 只走**随机匹配**；「创建房间」「加入」按钮**从没被点过** | 浏览器层也看不见 |
| conformance | slice-07.1 真的调了 REST 入座，但只用它验**并发原子性**（20 路 burst），没验「入座之后能不能开局」 | 真后端层也看不见 |

> ⚠️ 片③ spec §9 F6 已经点出这一点（「单测两边都是 mock ⇒ 看不见」）。**本片把它变成可执行的判据**（§6）。

---

## 1. 裁决、设计期自审与全局约束

### 1.1 裁决表

| # | 裁决 | 性质 |
|---|---|---|
| **R801** | **服务端零改动**。`handleJoin` 的会员制语义、12004、`match:pending` 回退、`socket.join`、`reconnect.touch`、成功后的兜底清票**全部不动** | 用户裁决（方案 2） |
| **R802** | **REST 入座必须发生在 WS `room.join` 之前**，且顺序不可反 | **机制**（见 §1.2 H1） |
| **R803** | **只有手动路径**（创建房间 / 房号加入 / 列表项）补 REST 入座；**匹配路径**（`joinMatchedRoom`）**不得**改动 | 范围（见 §1.2 H2） |
| **R804** | REST 入座成功后的 `roomCode` **以服务端回包的 `data.code` 为准**（归一化后回写 `joinCode`，WS 用服务端给的房号） | 与既有 `createAndJoin` 逐字同形 |
| **R805** | 客户端新增的唯一 REST 落点是 `net/rest.ts` 的 `joinRoom(code)`，**复用 `authedRequest`**，**不另造请求封装**（与 `createRoom` 同形） | 既有纪律（R454 的成例） |
| **R806** | **R61/R454「三条入口共用同一条 `room.join`」不破**：三条入口仍只经 `join()` 一个函数，`send('room.join'` 仍**恰好一处**，状态仍只由那一条 ack 写 store | 纪律保持（见 §1.2 H3） |
| **R807** | REST 入座失败 ⇒ **只提示、不发 WS `room.join`、不进牌桌**（与「建房失败」的既有处置同形） | 失败原子性 |
| **R808** | **mock 必须变忠实**：WS mock 在「REST 未入座」时必须回 **12004**（模拟真服务端的会员制），否则修完仍然**没有判据** | **用户裁决 3** + §0.5 |
| **R809** | **空态文案改用 `finished-text` prop**（`wd-loadmore.vue:12` 的 `finished` 分支只吃 prop、不吃默认插槽），**不绕开组件** | 用户裁决 4（F7 修法）|
| **R810** | F7 的判据处理：**改替身、不改断言** —— `auth-ui-wiring:125` 的 `toContain('暂无房间')` **一字不改**；改的是 `test/setup/uni-easycom.ts` 的 `WdStub`（让它把 `finishedText` 渲染成文本）。F7 修好后，该断言的含义从「见证了空态分支 + 文案进了组件」升级为「**生产里真的会显示这句**」 | 判据不动、含义升级（**复核订正**：原写「替身不用改」是错的，见 H5） |
| **R811** | 探针**加一步**「创建房间 → 进房」——插点在**判据 2′ 的 `autoPlayUntilEnded` 之后、`backToLobby` 之前**（**复核订正**：原写「`matchAndWaitDeal` 内部」会在判据 1/2/2′ 上红，见 H4）；**只加步骤、不改既有判据**，`gate` / `full` 条数随之**实测**更新（不预测） | 用户裁决 2 |
| **R812** | conformance 新增 `slice-12-manual-join`（**独立用例文件** + `run.ts` 注册 + `package.json` 脚本），**不塞进 slice-06 / slice-07** | 见 §5.2 |
| **R813** | 本片**不碰协议**（`packages/protocol` 的错误码、`CLIENT_ACTION` 表、消息清单） | 批级约束（R708 同族） |
| **R814** | **判据只增不减**：片② 的 8 文件 67 基线逐文件核；`lobby-ux`(18) / `auth-ui-wiring`(13) / `ui-flow`(1) **一条不得少** | 全局约束 3 |
| **R815** | 🔴 **本片范围 = 只修「进不去房」**。手动房间「**开不了局**」（`game.start` 只由匹配流程调用）**不在本片**，另立一片 —— 用户 2026-09-22 裁决（见 §1.2 H3′ / §6 / §7） | **用户裁决（复核后新增）** |

### 1.2 设计期自审（**起草 3 条 + 复核 3 条，全是硬错**）

> 方法照片② §1.2 / 片③ §1.2：**不审设计意图，审「我凭什么这么说」**。
> ⚠️ **复核轮**（用户「复核规格」之后）又查出 H3′/H4/H5 三条 —— **其中 H3′ 改变了范围判断**。
> 教训与片③ §1.2 同族：**第一轮自审只抓到自己想得到的形态**（H4/H5 都是「我漏看了某处代码的存在」）。

| # | 问题 | 处置 |
|---|---|---|
| **H1** | 🔴 **「先发 WS，遇 12004 再补 REST」是错的**：`client.send()` 在 ack 回调里**同步**派发 `CLIENT_ACTION`（`net/socket.ts:1002` 的 `dispatchAck`）⇒ 12004 到手时用户**已经在去大厅的路上**（`store.reset()` + `navigate('lobby')`），回不去了 | **R802**（顺序不可反） |
| **H2** | 🔴 **匹配路径若也补 REST 会踩坑**：匹配成功时服务端**已经把三个人坐好了**（`createGameRoom`），此时 REST join 会命中 `room.status !== 'waiting'` ⇒ **12008**（`rooms.service.ts:139`），把好路径弄坏 | **R803**（只改手动路径） |
| **H3** | 🔴 **R454 的源码级断言会不会红**：`lobby-ux.test.ts:249` 数的是 `/send\(\s*'room\.join'/g` **恰好 1 处**。补 REST 调用**不新增** `send('room.join'` 文本 ⇒ 断言不红。但**必须在设计期确认**（不然实施时会以为要改判据而放松它） | **R806**（判据不动、理由落盘） |
| **H3′** | 🔴🔴 **手动房间根本开不了局**（复核查出，**改变范围**）：`game.start` 全仓只有**一个**调用者 —— `match/match.service.ts:437`（匹配流程）；`isWaitingExpired` 的唯一消费者是**回收任务**（只删房、不补机器人、不开局，`rooms.reaper.ts:53`）；`game.ready` 在 §6.3 映射表里明文**废除**。⇒ **F6 修好之后，手动房间能进人、房间列表会显示 2/3·3/3，但牌桌永远等不到发牌** | **R815**（另立一片）+ §5.2 第 8 步改判据 + §7 |
| **H4** | 🔴 **探针插入点写错了**：原写「`matchAndWaitDeal` 内部、只在首次调用时」。但该函数**先等 `.lobby__mode, .game__match .btn` 任一出现**（`browser-e2e.mjs:447-448`）——我的步骤跑完人停在**牌桌**（三个锚点都没有）⇒ 这次 `waitForSelector` 白等 20s ⇒ **判据 1/2/2′ 全红** | **R811**（改到判据 2′ 的 `autoPlayUntilEnded` 之后） |
| **H5** | 🔴 **F7 修完 `auth-ui-wiring:125` 会红**：`WdStub`（`test/setup/uni-easycom.ts:40-55`）**只渲染插槽、不渲染 prop** ⇒ 文案从插槽搬到 `finished-text` 后 `wrapper.text()` 里就没有它了。原写「断言不动」**不成立** | **R810**（改替身：`WdStub` 渲染 `finishedText`） |

> **★ H1 是本片最容易踩的坑**：它是「用错误码驱动恢复」这一类的典型 —— 看起来更省一次请求，实际会被**同步派发**的既有机制抢先。`CLIENT_ACTION` 表是「哑终端」的执法者，**它不给调用方留后路**。
>
> **★ H4/H5 是同一个形态**：**「我漏看了某处代码的存在」**（探针的前置等待条件、测试替身的渲染方式）。两次都发生在「我描述改动会怎样影响它」的时候 —— 与片③ H2/H7「页面清单散落在两个互不相干的文件里」同族：**改动的影响面要按特征搜，不能按印象推**。

### 1.3 全局约束（**不许破的既有纪律**，适用于本片每一个 Task）

> 逐条沿用片① §1.4（R723）/ 片②（R743）/ 片③（R756），本片无改写。

1. **范围 = H5 + App**（R701）。小程序端排除在一切设计/开发/测试之外。
2. **锚点**：9 个探针 class。本片**第二次**动探针（R811）⇒ 改动**必须成对**（详见 §5.3）。
3. **判据只增不减**：见 **R814**。
4. **样式只用令牌**（`src/uni.scss` 的 `$ftl-*`）；单位 `px`；发丝线一律 `$ftl-hairline`。
5. **`uni.xxx()` 必须是直接成员调用**；不得用 `document` / `window` / `fetch`；不得 `typeof import.meta`。
6. **scoped 样式只到子组件根节点**。
7. **模板注释只能放单根元素内部**（放根前 ⇒ 组件变多根、`classes()` 静默返回 `[]`）。
8. **`mount()` 看不见样式** ⇒ 观感类改动只能用**产物 CSS / 真浏览器走查**证明，**不要造假判据**。
9. **门禁口径**：`turbo run build --force` 对 client 只出 h5 ⇒ App 必须单独跑 `build:app`；探针**独占**跑。
10. **证据卫生（R682）**：门禁日志的 mtime 必须晚于最后一次改动/commit。
11. **提交**：每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。**禁止** `git stash` / `git reset` / `git checkout <旧 commit>`。

---

## 2. 语义声明（**本片最重要的一张表**）

| 操作 | 职责 | 谁调用 | 本片 |
|---|---|---|---|
| REST `POST /api/rooms` | 建房间**元数据**（`players: []`） | `createAndJoin()` | 不动 |
| **REST `POST /api/rooms/:code/join`** | **占座**（`claimSeat` 原子，R126 幂等） | **`join()`** | 🆕 **本片新增调用点** |
| WS `room.join` | **挂载 socket** + 写重连点 + 兜底清票 + 回 `{roomCode, seat, players}` | `join()` / `joinMatchedRoom()` | 不动 |
| WS `room.matched` → `joinMatchedRoom()` | 匹配成功后自动进房（服务端**已入座**） | 会话层 | **不动**（R803） |

**一句话**：**占座是 REST 的事，挂载是 WS 的事。** 本片只是把断了的那根线接上。

---

## 3. 客户端修复（R801–R807）

### 3.1 `net/rest.ts` 新增 `joinRoom`（R805）

照 `createRoom` 的成例逐字同形（同一个 `authedRequest` ⇒ 带鉴权、`TOKEN_EXPIRED` 轮换一次后重放一次、统一信封解析）：

```ts
/**
 * §7.1 / §10.2（R454）：`POST /api/rooms/:code/join` —— **占座**。
 *
 * ⚠️ 与 WS `room.join` 是**两件事**（见 spec §2）：这里只把座位占下来（`claimSeat`，
 * R126 幂等），socket 的挂载仍由 `room.join` 完成。
 *
 * ⚠️ 重放安全性（与 `createRoom` 同理）：`10004` 是**网关验签阶段**的拒绝，
 * 请求从未转给 room-service ⇒ 不存在「第一次其实已生效」。
 * 即便退一步重放，`claimSeat` 对同一 userId 也是**幂等**的（返回原座位）。
 */
export function joinRoom(code: string): Promise<RestResponse<RoomInfo>> {
  return authedRequest<RoomInfo>('POST', `/rooms/${encodeURIComponent(code)}/join`, {});
}
```

> ⚠️ **必须 `encodeURIComponent`**：网关侧 `requireRoomCode` 有 `/^[0-9A-Z]{6}$/` 形状闸，编码不会破坏合法房号，但能保证非法输入不越出路径段。

### 3.2 `game.vue` 的 `join()` 加一步（R802 / R804 / R807）

**只动 `join()` 一个函数**，三条手动入口自动全部修好（它们本来就只经这一个函数）。

```
async function join(entered?: string) {
  const code = (entered ?? joinCode.value).trim().toUpperCase();   // ↓ 归一化不动
  if (!code || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    // ① R802：先占座（REST）—— 必须在 WS 之前，顺序不可反（§1.2 H1）
    const seatRes = await rest.joinRoom(code);
    if (seatRes.code !== 0) {
      error.value = `加入房间失败（code=${seatRes.code}）`;
      return;                                    // ② R807：不发 WS、不进牌桌
    }
    const confirmed = (seatRes.data?.code ?? code).trim().toUpperCase();  // ③ R804
    joinCode.value = confirmed;

    // ④ 挂载（既有代码，逐字保留）
    const outcome = await getGameSession().client.send('room.join', { roomCode: confirmed });
    …（既有的 blocked / 非 0 / setRoom / applyRoomState / navigate('table') 一字不改）
  } finally { busy.value = false; }
}
```

三条硬约束：

1. **`send('room.join'` 仍恰好一处**（R806）：新增的是 `rest.joinRoom`，不是第二条 WS 路径。`lobby-ux.test.ts:249` 的源码级计数**照旧为 1**。
2. **归一化局部变量仍叫 `code`**（`game-store-session-reset.test.ts:91` 的 `toContain('store.setRoom(code,')` 钉着这个字面量）⇒ `store.setRoom(code, …)` 那一行**不得改名**。
3. **`createAndJoin()` 不动**：它把房号写进 `joinCode` 后调 `join(roomCode)`，于是 REST 入座对建房路径也生效 —— **不改它正是本片要的效果**。

### 3.3 失败面（诚实列出）

| 情形 | 处置 | 是否可接受 |
|---|---|---|
| REST 入座失败（12001 房间不存在 / 12002 满 / 12008 已开局） | 页面 `error` 文案，不发 WS，人留在玩法页 | ✅ 与「建房失败」同形 |
| REST 成功、WS 挂载失败 | `CLIENT_ACTION` 表照常处置（12004 场景已消除；12001 仍可能触发 BACK_TO_LOBBY） | ✅ 座位已在服务端，重试即可（`claimSeat` 幂等） |
| 入座成功但用户中途离开页面 | 座位上留一个「人不在」的玩家，房间留给回收任务 | ⚠️ **既有**行为（REST 入座本来就这样），本片未引入。**口径订正**：`WAITING_TIMEOUT_MS = 30_000` 只是**过期判定**（`rooms.timeout.ts:11`），实际回收在 60s 的回收周期上 ⇒ 真实窗口是 **30–90 秒**（`REAP_INTERVAL_MS = 60_000`） |

---

## 4. F7 修复（R809 / R810）

`game.vue` 的空态分支：

```diff
- <wd-loadmore v-else class="game__empty" state="finished">暂无房间</wd-loadmore>
+ <wd-loadmore v-else class="game__empty" state="finished" finished-text="暂无房间" />
```

**理由**（实测组件源码）：`wd-loadmore.vue:12` 的 `finished` 分支是
`<wd-divider v-if="state === 'finished'">{{ finishedText || translate('finished') }}</wd-divider>`
—— 它**没有默认插槽**（模板里只有 `<wd-divider>` / `<block>` 三个分支，没有 `<slot/>`），
所以写在标签之间的文案**被组件丢弃**，生产里显示的是 `translate('finished')` = **「已加载完毕」**（`locale/lang/zh-CN.ts:66`）。
`finished-text` 是它对外暴露的**唯一**文案入口，而 `wd-divider` 是吃默认插槽的 ⇒ 该 prop 会真的渲染出来。

⚠️ **注释要跟着改**：现模板注释（`game.vue:339-342`）逐字写着「文案放在**插槽**里而不是 `finished-text`」的**反向结论**，它当时是错的 ⇒ 必须改写，不得留一段与代码矛盾的解释（片③ §9 F11 的形态）。

**判据**（**R810，复核订正**）：

- `auth-ui-wiring:125` 的 `toContain('暂无房间')` **一字不改**。
- ⚠️ **但替身必须跟着改**：`test/setup/uni-easycom.ts:40-55` 的 `WdStub` **只渲染插槽、不渲染 prop** ⇒ 文案搬进 `finished-text` 之后，`wrapper.text()` 里就没有它了（**125 会红**）。修法是让 `WdStub` **把 `finishedText` 渲染成文本节点**——这恰恰是它作为结构性替身**该做**的事（真组件的 `finished` 分支**就是**渲染这句文案）。**不去「修」`WdStub` 的插槽渲染**（那正是它的职责，片③ §9 F7 附带明文要求过）。
- 改完之后 125 的含义**升级**：从「见证了空态分支被走到 + 文案确实进了组件」变成「**生产里真的会显示这句**」（片③ §9 F7 里「该断言在生产里没有对应物」这条终于被消掉）。

---

## 5. 验证（**三层，用户裁决 3**）

> 三层各管一件单测管不到的事：**① 让单测有判别力 ② 让真后端有判据 ③ 让浏览器有判据**。
> §0.5 说明过：缺任意一层，本缺陷都能再溜过去一次。

### 5.1 第一层：夹具/单测（**让 mock 忠实**，R808）

**现状**（§0.5）：WS mock 手写 `{code: 0}`；`stubFetch` 对任何 POST 都回 `{code: 0}` ⇒ 修与不修**都绿**。

**改法**：在 `lobby-ux.test.ts` / `auth-ui-wiring.test.ts` 的玩法页脚手架里，让 mock **按真服务端的语义**回答：

- REST `POST /api/rooms/:code/join` ⇒ 记一笔「该房号已入座」
- WS `room.join` ⇒ **只有**「该房号已入座」或「有 `match:pending`」时回 `{code:0, data:{roomCode, seat, players}}`；否则回 **`{code:12004, message:'You are not in this room'}`**

⇒ 这样「先 REST 后 WS」变成**可判**的因果，而不是碰巧的顺序。

**新增判据（只增不减，R814）**：

| 文件 | 新增 |
|---|---|
| `lobby-ux.test.ts` | ① 建房路径：REST 入座的调用**先于** WS `room.join`（用 `calls` 与 `emittedOf` 的时间序断言）；② 列表项路径同序；③ REST 入座失败 ⇒ **零** `room.join`、不进牌桌、有文案；④ 既有「建房失败只提示」保持 |
| `lobby-ux.test.ts` | ⑤ `rest.joinRoom` 的独立单测（信封、带 Authorization、URL 形状、`encodeURIComponent`） |
| `test/setup/uni-easycom.ts` | 🆕 **`WdStub` 渲染 `finishedText`**（R810 / H5）—— 这是**替身按设计**该做的（真组件的 `finished` 分支就是渲染这句）。**不是**改判据、**不是**放松判据 |
| `auth-ui-wiring.test.ts` | 空态文案断言**保持原文**（R810），并补一条「模板里**不再**把文案放在插槽里」的源码级断言（钉住 F7 的修法） |

⚠️ **RED 必须真红**：实施时先写「忠实 mock」，此时既有用例**应当变红**（因为 `join()` 还没补 REST）——**那正是 §0.5 的证明**。红完再修 `join()`。

**✅ 实施期实测（2026-09-22）**：按 R808 先写忠实替身，新用例**确实红了**，且红在正确的位置：

```
AssertionError: 必须先 REST 占座：POST /api/rooms/NEW123/join: expected undefined to be defined
```

⚠️ **一处实施期的判据订正**：初稿写「断言 REST 占座**发生在** `room.join` **之前**」，实现成「REST 回来时 `room.join` 还没发」——**那是错的**：`clickCreate` 里的一次 `flushPromises()` 会把 REST 与随后的 WS 两段**都**排干，中间态**本来就观测不到**（那样写会引入「替身必须配合我的等待节奏」的时序假设，正是本片要消灭的东西）。⇒ 改成**同一时间轴上的一个标记**：`room.join` 被触发的那一刻，占座**是否已经兑现**（`claimedFirst`）。判据强度不变（顺序错了就红），但不再依赖任何 sleep/flush 的粒度。

### 5.2 第二层：conformance（**独立用例文件**，R812）

新增 `tools/conformance/src/slices/slice-12-manual-join.ts`（+ `run.ts` 注册 + `package.json` 的 `conformance:slice-12` 脚本）。判据**逐条对应实测**（§0.1）：

| # | 步骤 | 判据 | 判别力 |
|---|---|---|---|
| 1 | `registerUser(0)` + WS 连接 | 握手成功 | — |
| 2 | REST `POST /api/rooms {mode:'practice'}` | `code 0`、`playerCount === 0` | 钉住「建房不入座」这个**当前事实**（不是缺陷，是契约） |
| 3 | WS `room.join` | **`12004`**（负对照） | 钉住会员制语义；**改动本片会立刻红** |
| 4 | REST `POST /api/rooms/:code/join` | `code 0`、`playerCount === 1` | 占座落点可用 |
| 5 | WS `room.join` | `code 0`、`seat === 0`、`players` 恰好 1 人 | **本片修的就是这条链** |
| 6 | 第二账号：REST 入座 + WS join | `code 0`、`seat === 1` | 房号加入路径 |
| 7 | 第三账号：同 5/6 | 三人齐 | — |
| 8 | 收尾：`GET /api/rooms` 查这个房间 | `playerCount === 3`、`status === 'waiting'` | **钉住本片的边界**：房间**坐满但仍在 `waiting`** —— 这正是「手动房间开不了局」（H3′）在协议层的样子，本片**不修**，但要用判据把它记下来 |
| 9 | 三人各发一次 `room.leave`（可选） | `code 0` | 让房间尽快进回收窗口，少留垃圾 |

> ⚠️ **第 8 步为什么不判「拿到 `PlayerView`」**（初稿就是这个错）：**做不到**。`game.start` 只由匹配流程调用（H3′），手动房间坐满也不会开局 ⇒ 判 `PlayerView` 是**判一个不存在的契约**。R815 把它移出本片之后，这里改成**能判的**事实（`3/3 · waiting`），并把这个形态**显式记进规格** —— 下一片接开局链路时，这条判据**该红**。

**为什么单列一个文件**（不塞进 slice-06 / slice-07）：

- slice-06 已 13 组、slice-07 已 6 组，两个都到了「再塞就看不清谁在验什么」的长度；
- 本用例验的是**一条完整链路**（建房 → 占座 → 挂载 → 开局），不是某一个服务的契约；
- `slice-07` 第 6 组的 12004 反例**必须继续存在且不改**（它钉住的是另一件事）。

⚠️ 第 4 步之后，**客户端修复才让第 5 步通过**：conformance 走的是**手工两步**（REST 然后 WS），它验的是**服务端契约允许这条链**；而 `slice-07` 第 6 组的 12004 反例保证这条链**不能被绕过**。两者合起来才等于「客户端接线对了」。

### 5.3 第三层：探针（**加一步**，R811）

**落点（复核订正 H4）**：`scripts/browser-e2e.mjs` 的**判据 2′**，在 `autoPlayUntilEnded` **之后**、`backToLobby` **之前**：

```js
if (SCENARIO === 'full') {
  await newPageSession(cdp, '判据 2′（真打完一局再开第二局）');
  await registerFresh(cdp);
  await matchAndWaitDeal(cdp, '第一局');
  await autoPlayUntilEnded(cdp, GAME_TIMEOUT_MS, '第一局');
  await createRoomAndJoin(cdp, '判据 2′（创建房间 → 进房）');   // 🆕 本片新增的那一步
  await backToLobby(cdp);
  await secondGameJudgment(cdp, '第二局（真跨局）');
}
```

**为什么是这里**（三条理由，缺一不可）：

1. ⚠️ **不能放 `matchAndWaitDeal` 内部**（初稿的写法，**会红**）：该函数**先等 `.lobby__mode, .game__match .btn` 任一出现**（`browser-e2e.mjs:447-448`）—— 我的步骤跑完人停在**牌桌**（三个锚点都不在）⇒ 这次 `waitForSelector` 白等 20s ⇒ 判据 1 / 2 / 2′ **全部红**，而且是红在与本片无关的时序上（片③ F9 的形态）。
2. ✅ **这一刻是干净的**：上一局已 `ended` ⇒ 服务端房间里的人已经打完，**放弃它无副作用**（对比：`waiting` 房间放弃会留一个 `1/3` 挂着）。
3. ✅ **回程原语现成**：`.table__bar .btn` 回**玩法页**（`backToLobby` 的第一步）→ `backToLobby` 回大厅 ⇒ 下一条 `secondGameJudgment` 拿到与现在**逐字相同**的前置。

**判据**（取「**用户能看见的那一步**」，`check()` 可逐条计）：

1. `.game__create-room` 存在并点击（锚点片③ R749 改名后已存在）；
2. 等到进入牌桌（进牌桌 = **REST 入座 + WS 挂载两步都成功**）；
3. 断言 store 的 `roomCode` 非空；
4. 🔴 **反向断言：页面仍停在牌桌**（`auth.page === 'table'`）—— **旧实现**会在 12004 之后 `store.reset()` + 回大厅 ⇒ 这条就是本缺陷的判据；
5. 回程：点 `.table__bar .btn` 回玩法页 → `backToLobby` 回大厅。

**已知副作用（照实记）**：这一步会在服务端留下一个 `1/3 · waiting` 的 practice 房间，进**30–90 秒**的回收窗口（§3.3 口径订正）。**对后续判据无害**：随机匹配走 `match.service` 的 `createGameRoom` **新建**房间，**不读房间列表**（实测 `match.service.ts:273`）。⇒ 探针里**不做**清理（客户端也没有删房间的入口）。

**条数**（**实测填入**，片③ F2 的教训：预测与代码矛盾过两次）：`gate` **18/18**（**不变** —— 本步骤只挂判据 2′，只有 `--scenario full` 跑）；`full` **23 → 28**（本步骤 +5）。

**✅ F7 的**生产端**证据（实测）**：本步骤在玩法页上顺手把空态文案**打出来**：

```
· 判据 2′（创建房间 → 进房）：空态记录 —— .game__item=0，空态文案="暂无房间"
```

**修之前这里打的是「已加载完毕」**（片③ §9 F7 的现场）。⚠️ 这条**只记录、不断言**：列表是否为空取决于此刻服务端有几个房间（别的用例/上一次跑留下的都算），断言它会是**环境相关**的假红 —— 它要证的那件事由 `auth-ui-wiring` 的源码级断言钉住。

**执行期实测（四次踩坑，全记在这里 —— 它们正是「探针写起来容易假绿」的实例）**：

1. **接在 `autoPlayUntilEnded` 之后时，人停在「牌桌的结算屏」** —— 那里没有 `.game__create-room` ⇒ 直接点会 `not-found`。⚠️ 更糟的是：当时后续三条断言在**上一局的牌桌上**照样全绿（`page=table`、`roomCode` 非空）⇒ **整步假绿**。修法：先把人送回玩法页；并加一条「进的是**新**房间」的断言（`roomCode !== 上一局` **且** `view === null`）把这类假绿堵死。
2. **不能假设「点一下返回大厅走到哪」** —— 首次修法等 `page === 'game'`，实测落的是 `page=lobby` ⇒ 又红。`.table__bar` 的返回大厅有**两条落点**。
   ⇒ 最终写法**不假设起点、也不假设一步走到哪**：抽出 `ensureGamePage()`，按当前页面**逐段**走（`table` → 点返回大厅 → 落定；`lobby` → 点玩法卡 → 落定），每段都等落定。
3. **「列表里的房间」不能在牌桌上查** —— 首次把列表断言放在**建房之后**，那时人已经在**牌桌**上，`.game__rooms` **根本不在 DOM 里**（实测 `DOM="(没有 .game__rooms)"`）⇒ 必红。⇒ 列表断言挪到**回玩法页之后**（那才是列表活着的地方）。
4. **列表是挂载时拉的** ⇒ 回程后要**先点「刷新」**再等行出现；且用 `waitForSelector` 轮询，**不要**一次 `sleep`（首版等 800ms 拿到 0 行 ⇒ 假红）。

### 5.4 判据不变量（R814，逐文件核）

| 文件 | 基线 | 实测（2026-09-22 实施后） |
|---|---|---|
| `auth-flow` | 10 | ≥ 10 |
| `auth-ui-wiring` | 13 | **14**（+1：F7 源码级断言；原 13 条一条未减） |
| `lobby-ux` | 18 | **23**（+5：忠实替身一组 2 条 · `rest.joinRoom` 3 条；原 18 条一条未减） |
| `ui-flow` | 1 | ≥ 1 |
| `table-bid-ui` | 7 | 7 |
| `table-play-ui` | 8 | 8 |
| `table-ended-ui` | 3 | 3 |
| `table-settlement-ui` | 7 | 7 |
| **合计（8 文件）** | **67** | **≥ 67**（只增不减） |

另三个文件的 `it(`（`lobby-modes` 6 · `settlement-rematch` 5 · `game-store-session-reset` 5）**不得减少**。

**客户端全量**：**494 passed + 2 skipped ⇒ 500 passed + 2 skipped**（44 个测试文件 + `lobby-ux` 的 +5 与 `auth-ui-wiring` 的 +1 = +6，**零减少**）。

---

## 6. 明确不做

| 项 | 为什么 |
|---|---|
| 服务端任何改动（R801） | 会员制语义是被三层判据钉住的**设计**，不是缺陷 |
| **手动房间的「开局链路」（R815）** | 🔴 **`game.start` 只由匹配流程调用**（§1.2 H3′）⇒ 本片修完**能进房但开不了局**。那是**新功能**（新增服务端触发点，且可能碰协议），**另立一片** —— 用户 2026-09-22 裁决 |
| 匹配路径补 REST（R803） | 会命中 12008 把好路径弄坏（§1.2 H2） |
| 改 `room.join` 的 12004 语义 | 同上（R801 的另一种写法） |
| 协议 / 错误码 / `CLIENT_ACTION` 表（R813） | 批级约束 |
| F8（断网恢复踢回大厅 + 英文原文） | 片③ §9 F8 已定性为**既有设计**（R16/N1 的判据明文要求该答复盖过恢复提示）；本片不碰 |
| `auth-ui-wiring:125` 断言**改写**（R810） | 改的是**替身**（`WdStub`），断言一字不动；修好后它在生产里终于有对应物 |
| 第二个玩法 / 头像货币战绩商城好友 | 不在本片（片③ §8） |

### 6.1 已知未覆盖（**不要当成已验证**）

| 项 | 状态 |
|---|---|
| 🔴 **手动房间开不了局**（R815 / H3′） | 本片修完的**确切语义**是：「能进房、房间列表正确（2/3 · 3/3 · waiting）、不再被踢回大厅、不再看到英文原文」——**牌桌永远不会发牌**。`game.start` 的唯一调用点在 `match.service.ts:437`；`game.waiting` 窗口的 `isWaitingExpired` 只被**回收任务**消费（只删房、不补机器人、不开局）；`game.ready` 已废除（§6.3 映射表） |
| 手动房间的**角色** | 仍是「建房 → 拉人进来 → 等着」的半成品。第二片要裁决的是：**房满即开局**（服务端触发）还是**房主点开始**（要新增 C→S 消息 ⇒ 碰协议） |
| `slice-12` 第 8 步 | 判的是 **`3/3 · waiting`**（能判的事实），**不是** `PlayerView`。下一片接开局链路时**这条该红** —— 那是它的用途 |

---

## 7. 风险与已知代价

1. **多一次 REST 往返**：手动进房的延迟 +1 RTT。可接受 —— 它是**唯一**能真正占座的方式（§2）。
2. **`join()` 变长**（一个函数里两条网络调用）：因此 §3.2 的三条硬约束（单调用点、局部变量名、`createAndJoin` 不动）必须逐条核 —— `join()` 是本片唯一被改的实现。
3. **`stubFetch` 的断言口径会漂**：加了 REST 入座后，`calls` 数组多一项；既有用例用 `calls.find(...)`（不是下标）⇒ **实测不会红**，但新增用例**必须按序**断言（§5.1 ①）。
4. **探针第二次改动**：条数会变。缓解：只加一步（挂**判据 2′**，只有 `--scenario full` 跑）+ 只读既有锚点，`gate` 与 `full` **都跑**（`gate` 条数**可能不变**，以实测为准）。
5. **conformance 需要 docker 栈**：它**不挂 `turbo run test`**（既有的有意设计）⇒ 本片的第二层验证只在「栈起着」时跑。实施时栈在（实测 8 容器 healthy）。
6. 🔴 **本片修完，用户体验仍不完整**（H3′）：三条手动路径**能进房**，但房间**开不了局** —— 用户会看到「进了牌桌、然后什么也不发生」。⇒ **这是本片最大的交付缺口**，必须写进交付说明与下一片的入口（§6.1）。⚠️ 不得在交付时把它说成「修好了」。

---

## 8. 完成判据（本片）

| 项 | 判据 | 实测（2026-09-22） |
|---|---|---|
| 缺陷修好 | 真浏览器：点「创建房间」⇒ **进牌桌**（不是回大厅）；房号加入 / 列表项两条同样 | ✅ 探针新步骤 5 条断言全绿（`page=table`、新房间、`view=null`、未被踢回、列表 8 行） |
| ⚠️ **不是**本片判据 | 「手动房间能开局」—— **做不到**（R815 / §6.1）。交付时**不得**说成「开局路径都修好了」 | 同上（`view=null` 正是这条的见证） |
| 单测 | 忠实 mock 下**先红后绿**（§5.1）；`pnpm run ci` 六阶段全过；判据只增不减（§5.4） | ✅ 先红（`必须先 REST 占座…expected undefined`）→ 后绿；client **494 → 500 passed + 2 skipped** |
| conformance | `slice-12` 全绿（第 8 步 = `3/3 · waiting`）；`slice-07` 的 12004 反例**仍绿**（未被本片改弱） | ✅ `slice-12` **26 项断言**（1.6–1.8s）；slice-07 未改动 |
| 探针 | `gate` / `full` 全绿，条数**实测**填入 | ✅ `gate` **18/18**（不变）· `full` **28/28** |
| F7 | 真浏览器里空态显示「暂无房间」（不再是「已加载完毕」）；`auth-ui-wiring:125` 一字不改仍绿 | ✅ 探针打出 `空态文案="暂无房间"`（生产端证据）；125 原文未动、**替身改了**（R810） |
| 门禁 | `lint`（`vue-tsc --noEmit`）exit 0；`build:h5` / `build:app` 均 DONE（R669 分开跑） | ✅ `pnpm run ci` **六阶段全部通过**；`build:app` DONE |

### 8.1 给下一片的入口（**开局链路**）

**问题**：手动房间坐满人也不会开局 —— `game.start` 的唯一调用者是 `match.service.ts:437`（匹配流程）。

**要裁决的**（下一片起草时先问用户）：

1. **触发方式**：房满即开局（服务端自动，客户端零改动）？还是**房主点「开始」**（要新增 C→S 消息 ⇒ **碰协议**，`R813` 的批级约束会在此失效，需重新裁决）？
2. **几人能开**：`maxPlayers = 3` 才开，还是允许不满 3 人（补机器人，照 `match.service` 的 `BOT_FILL_WAIT_MS` 成例）？
3. **超时**：现有 `WAITING_TIMEOUT_MS = 30_000` 只被**回收任务**消费（删房）。若改成「等满 30s 就补机器人开局」，那是把回收语义改成开局语义 —— **两者不能共用同一个判据**（`rooms.timeout.ts` 的注释明文写着这条同值不同物的纪律）。
4. **失败面**：`game.start` 两次都失败的既有降级（`match.service.ts:316-317` 注释里明说**当前不存在**：房间 `cancelled` + 通知玩家）在手动房间上要怎么补。

**入口文件**：`packages/room-service/src/match/match.service.ts`（触发链路的现成样板，含幂等重试与机器人补位）、`src/rooms/rooms.service.ts`（占座）、`src/rooms/rooms.timeout.ts`、`tools/conformance/src/slices/slice-12-manual-join.ts`（第 8 步那条判据**就是为它留的**）。

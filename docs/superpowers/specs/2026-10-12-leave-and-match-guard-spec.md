# 「返回大厅」弃局出口 + 匹配守卫 规格层 v1.1（冻结）

- 日期：2026-10-12
- 状态：**已冻结（v1.1，规格审查一轮闭环：3 硬项 F1/F2/F3 + F4-F12 全处置，均为机械文本订正；无机制级发现）** → **已实现（2026-10-12 收口：C1–C16 载体全绿（room-service 全包 629 · 客户端 823·另 1 条为工作树 PNG 的 asset-budget 环境红 · slice-05 真栈 68/68 · 探针 full 41/41 + second-game 13/13 —— 含 C15 的确认处理实证；T5-O1 探针缺陷已修复闭环，见收口报告）；基线 64→68 回填；A1–A4 记录见收口报告、A1 留用户端到端）**
- 上游：设计 `2026-10-12-leave-and-match-guard-design.md` **v1.3 冻结**（两轮对抗审闭环）
- 主题：把冻结设计转成可实施契约：改动面 / 写死形状 / 判据 C 系列 / 验收 / 测试矩阵

## 0. 承接与订正

### 0.1 上游与版本

设计 v1.3 为唯一语义来源；本文不引入新语义，只做实现级裁定（§0.3）与可执行化。冲突以设计为准并回改本文。

### 0.2 用户裁决承接

| # | 裁决 | 落点 |
|---|---|---|
| K1 | 方案 A（**仅对局进行中**确认退出；确认=`room.leave` 真弃局） | 设计 §3.1/§3.4、本文 §2.5 |
| K2 | 加服务端匹配守卫 | 设计 §3.3、本文 §2.2 |
| K3 | 等待房与结算态保持现状（探针钉住的契约，本片不改） | 设计 §2/§3.1、本文 §2.5 |

### 0.3 ⚙️ 规格级裁定（起草期就地定死）

1. **12011 message 逐字**：`You are still in an active game`（waiting/playing 共用）。`ALREADY_IN_GAME = 12011`；`CLIENT_ACTION[12011] = TOAST`。
2. **`action-copy` 12011 中文文案（逐字）**：「你还有未结束的对局或房间」（**去尾**去除「已返回牌局」——`store.roomCode` 空时导航守卫不发导航，尾句会失真，二轮 F10；判据只钉「含『未结束』且非诊断串」）。
3. **`room.leave` 清理的**单**闸**：读两凭据（`reconnect:active` 记录、`match:pending.roomCode`）——**各自满足「缺席 或 roomCode === 请求值」⇒ 清理全做**（`clearConnection` + `del match:pending` + `onSeatLeft`）；**任一「存在且不一致」⇒ 清理全不做**（仅 `socket.leave`），两种情况都返 `ok()`。
4. **`onSeatLeft` 形态**：`RouterDeps` 增设**可选**字段 `onSeatLeft?: (roomCode: string, userId: string) => void`；`ws.gateway.routerDeps()` 注册（与 `onSeatOwners` 相邻）：删除 `seatOwners` 中所有 `key.startsWith(`${roomCode}:`) && owner === userId` 的登记。
5. **守卫代码块逐字**（§2.2）：含 `isMissingGameError` 分流（缺失类 ⇒ 12011；传输类 ⇒ 上抛走 13001）。
6. **客户端失败提示通道**：走 `table.vue` **既有 `localError` 就地错误条**（与「匹配失败」同族）；不新造通道、不写会话 notice。
7. **leave 本地超时**：5s `Promise.race`；`sendQueued` 必须挂 `.catch(() => null)`（会话拆除会 reject——`ClientDestroyedError`，与 `requestSnapshot` 的既有收敛成例同形），null 并入留守分支；超时 ⇒ 留守 + localError「退出失败，请重试」；**doLeave 自身对迟到 ack 无任何 UI 动作**，但 **CLIENT_ACTION 表对非零码的既有处置照常**（迟到 12001 ⇒ BACK_TO_LOBBY ⇒ 成功离场路径；迟到 10006 ⇒ TOAST）——口径以本条为准（二轮 F6）。**⚠️ v1.1.2 勘误（执行期 O1 裁决）**：竞速的 `setTimeout` 落点必须在 `src/composables/raceTimeout.ts`（**页面文件禁含计时器**——R675 闸 `table-bid-ui.test.ts:393-410` + `animations.test.ts`；`useCountdown` 先例），`table.vue` 只消费；本规格 v1.1.1 及其上游设计/计划均漏查该闸（控制者文本缺陷，登记）。
8. **`uni.showModal` 参数逐字**：`{ title: '退出本局', content: '本局将由系统自动打完（金币场按结果结算），期间无法回到本局。', confirmText: '退出', cancelText: '取消' }`。
9. **`uni-stub.showModal` 扩展形态**：完整记录 options（含 `success` 回调引用），用例以 `uniStub.showModal[0].success?.({ confirm: true/false })` 触发（现 stub 只记 `{title,content}` 且不回调，须扩类型与实现）。
10. **探针确认处理形态（二轮 F2：类名已核定，写死）**：uni-h5 的 showModal 渲染 = confirm 钮 `class="uni-modal__btn uni-modal__btn_primary"`（文本=confirmText）、cancel 钮 `class="uni-modal__btn uni-modal__btn_default"`（`@dcloudio/uni-h5/dist/uni-h5.es.js` 实读）。探针：`waitForSelector('.uni-modal__btn_primary')` 后点击，再断落 lobby。
11. **「进行中」判定**：`store.view !== null && store.view.state !== 'ended'`（`state ∈ {'init','bidding','playing'}` 全部走确认；`view === null`（等待房/fail-open 边角）与 `'ended'` 走只导航——§3.4 次序：先 ended → 后 null → 最后进行中）。

### 0.4 设计 §6 判据 → 本文 C 系列

设计 C1–C16 原样承接为本文 §3 的 C1–C16（无增删）。

## 1. 改动面一览

### 1.1 修改文件

| 文件 | 改动 |
|---|---|
| `packages/protocol/src/errors.ts` | `ALREADY_IN_GAME = 12011` + `CLIENT_ACTION` TOAST 行 |
| `packages/protocol/src/errors.test.ts` | `SPEC_CODES` 增 `12011`（带注释；与 design.md §11.2 人工镜像） |
| `packages/room-service/src/gateway/message.router.ts` | `handleMatch` 守卫（§2.2）；`handleLeave` 清理单闸 + `onSeatLeft`（§2.3）；`RouterDeps` 增 `onSeatLeft?` |
| `packages/room-service/src/gateway/ws.gateway.ts` | `routerDeps()` 注册 `onSeatLeft`（§2.4） |
| `packages/room-service/test/message.router.test.ts` | 替身补 `getRecord`（§2.3 配套，F1）+ 守卫/leave 判据（C1-C7） |
| `packages/room-service/test/ws.gateway.test.ts` | ReconnectMock 补 `getRecord`（§2.3 配套）+ onSeatLeft 实清/投递实证（C7/C8） |
| `apps/client/src/pages/table/table.vue` | `onBackToLobby()` 判定链 + 弹窗 + leave 流程（§2.5） |
| `apps/client/src/pages/game/game.vue` | `match()` 非零分支 12011 处理（§2.6） |
| `apps/client/src/net/action-copy.ts` | 12011 条目（§2.7） |
| `apps/client/test/helpers/uni-stub.ts` | `showModal` 扩展（§2.8） |
| `apps/client/test/table-play-ui.test.ts` | C9-C12（既有夹具：真会话 + FakeSocket 挂 TablePage） |
| `apps/client/test/auth-ui-wiring.test.ts` | C13（既有夹具：GamePage + `room.match` ack 驱动，含 12009 同族先例） |
| `apps/client/test/action-feedback.test.ts` | C14 的 action-copy 条目断言（文案表处） |
| `scripts/browser-e2e.mjs` | `backToLobby` 确认处理 + `:547` 注释按 K3 微调（§2.9） |
| `tools/conformance/src/slices/slice-05-reconnect.ts` | C16 四断言（§2.10） |
| `tools/conformance/baselines.json` | `full.slice-05` 64→**68**（+4，按源码静态计数；slice-05 零 skip/零数据依赖分支/唯 C1 含 40s 真等待；调低须写理由的纪律照旧——F3/F11） |
| `docs/client-protocol.md` | 错误码表 + 处置行（12011） |
| `docs/design.md` | §11.2 总表增 12011 行（人工同步） |
| 上片设计 `2026-10-12-reconnect-until-game-end-design.md` | 勘误 v1.3.3：§1 :33 与 §3.6 :96-101 的「返回大厅只导航」表述订正为「进行中=确认退出；等待/结算=只导航」 |

### 1.2 新增（函数级）

- `handleLeave` 内的清理闸判定（可抽本地小函数 `shouldClearOnLeave(deps, userId, roomCode)`，命名实现期定）。
- `table.vue` 的 `onBackToLobby()` / `doLeave()`（命名实现期定，语义见 §2.5）。

### 1.3 明确不在改动面

- 等待房/结算态任何交互（K3）；`handleJoin` 守卫；多端同步；`room.leave` 的 `leaveSeat/resetWaitingWindow` 既有逻辑（R916 逐字不动）；`sendQueued`/会话层。

## 2. 新契约（写死）

### 2.1 错误码 12011

- `errors.ts`：`ALREADY_IN_GAME = 12011`（12010 后）+ `[ErrCode.ALREADY_IN_GAME]: ClientAction.TOAST`。
- `errors.test.ts` SPEC_CODES：`12011, // 在局/在房匹配守卫（本片）`。
- `client-protocol.md`：错误码表加 `` | `12011` | ALREADY_IN_GAME | 你还有未结束的对局或房间 | `toast` | ``（处置列小写反引号，随该表现有列风格——二轮 F8）；处置说明区不必加例外。
- `docs/design.md §11.2`：人工同步同表。

### 2.2 `handleMatch` 守卫（逐字）

插入位置：封禁读点块（`message.router.ts:409-411`）**之后**、`readMeta` 探测**之前**：

```ts
/**
 * 本片守卫：在局/在房者不得匹配（用户裁决 K2；设计 §3.3）。
 * 判据两段：resolver 第一遍命中（waiting/playing）；playing 再加 view-ended 放行
 * （updateStatus(finished) 是 fire-and-forget，写丢失不把玩家卡到房键 TTL）。
 * 缺失类错误（ROOM_NOT_FOUND/NOT_IN_ROOM）视同 view 拿不到 ⇒ 不放行（不得上抛成 12001，
 * 那会让客户端 BACK_TO_LOBBY 静默踢回大厅）；仅传输类故障原样上抛（走既有 13001 面）。
 */
const active = await deps.reconnect.resolveRecoverableRoom(userId);
if (active) {
  let blocked = active.status === 'waiting';
  if (active.status === 'playing') {
    let view: PlayerView | null = null;
    try {
      view = (await deps.game.view(active.roomCode, userId)) as PlayerView | null;
    } catch (err) {
      if (!isMissingGameError(err)) throw err;
      view = null;
    }
    blocked = !(view !== null && view.state === 'ended');
  }
  if (blocked) return fail(ErrCode.ALREADY_IN_GAME, 'You are still in an active game');
}
```

（`PlayerView`/`isMissingGameError` 均已在文件内可用。）

### 2.3 `handleLeave` 修订（逐字替换清理段）

现清理段（`socket.leave` 之后的 `clearConnection` + `del match:pending` 两行）替换为：

```ts
// 本片（设计 §3.2）：清理单闸——两凭据各自「缺席 或 roomCode 一致」才清；
// 任一「存在且不一致」⇒ 全不清（防「错房号 leave 即解锁匹配」旁路），仍返 ok。
const record = await deps.reconnect.getRecord(userId);
const pendingRoom = await deps.redis.hget(matchPendingKey(userId), 'roomCode');
const consistent =
  (record === null || record.roomCode === roomCode) &&
  (pendingRoom === null || pendingRoom === roomCode);
if (consistent) {
  await deps.reconnect.clearConnection(userId);
  await deps.redis.del(matchPendingKey(userId));
  deps.onSeatLeft?.(roomCode, userId);
}
```

配套（**含测试夹具**，F1）：
- `ReconnectService` 把 `readRecord` 公开为 `getRecord(playerId)`（薄封装即可；形状不变）。`leaveSeat/resetWaitingWindow` 及其余逐字不动。
- `message.router.test.ts` 的 makeDeps 替身增 `getRecord`：读**同一假 redis** 的 `RECONNECT_HASH_KEY` 字段、JSON.parse、缺/坏 ⇒ null（与真实语义一致，使清理闸三态可控）。
- `ws.gateway.test.ts` 的 ReconnectMock 增 `getRecord: vi.fn().mockResolvedValue(null)`（缺它 ⇒ `getRecord is not a function` ⇒ 通用 catch ⇒ **13001**，既有全部 leave 用例（`:1092-1097/:1100-1118/:1152-1159/:1212-1219/:1257-1291`）会以完全无关的错误码整族红——「替身比接口窄」形态，本仓已复发的坑）。

### 2.4 `onSeatLeft` 注册（`ws.gateway.ts` `routerDeps()`）

```ts
onSeatLeft: (roomCode, userId) => {
  for (const [key, owner] of this.seatOwners) {
    if (owner === userId && key.startsWith(`${roomCode}:`)) this.seatOwners.delete(key);
  }
},
```

### 2.5 `table.vue`（语义伪码；逐行实现）

```
onBackToLobby():
  v = store.view
  if v === null || v.state === 'ended':  auth.navigate('lobby'); return      # §3.4 次序：先这两支
  uni.showModal({ ...§0.3-8 逐字参数..., success: (res) => { if (res.confirm) void doLeave(); } })

doLeave():
  roomCode = store.roomCode; if (!roomCode) { auth.navigate('lobby'); return }
  localError.value = ''            # 该字段是 ref<string>（同文件既有清口一律 ''，F4）
  outcome = await Promise.race([
      client.sendQueued('room.leave', { roomCode }, 5).catch(() => null),   # 会话拆除会 reject，收敛成 null（F5）
      sleep(5000) 后返回 'timeout',
  ])
  if outcome === 'timeout' 或 outcome === null 或 outcome.status !== 'sent':
      localError.value = '退出失败，请重试'; return                          # 留守牌桌
  if outcome.code === 0 或 outcome.code === ErrCode.ROOM_NOT_FOUND:
      store.reset(); auth.navigate('lobby'); return                         # 12001=服务端已清凭据（设计 §5#2）
  非 0 其他：localError.value = '退出失败，请重试'                            # 留守（CLIENT_ACTION 可能已另发处置，不冲突）
```

- `localError` = 该文件既有就地错误条（§0.3-6）；结算清口已有（:131-140 一带，无需改）。
- 迟到 ack：一律忽略（§0.3-7；`sendQueued` 的 promise 结算后不再触达 UI）。

### 2.6 `game.vue` `match()` 非零分支（12011）

```
if (outcome.code === ErrCode.ALREADY_IN_GAME):
    if (store.roomCode !== null) auth.navigate('table')    # canShowTable 同族守卫；文案由 TOAST 通道发
    return                                                  # 不写 error.value（防双呈现）
```

### 2.7 `action-copy.ts`

`[ErrCode.ALREADY_IN_GAME]: '你还有未结束的对局或房间'`（逐字，**去尾**；与 §0.3-2 一致——本行 v1.0 曾误写带尾「，已返回牌局」，v1.1 勘误）。

### 2.8 `uni-stub.ts` 扩展

`showModal` 记录完整 options（类型扩为 `{ title?; content?; confirmText?; cancelText?; success?: (res: { confirm: boolean }) => void; fail?: () => void }`；实现只入数组、不自动回调——由用例触发）。

### 2.9 `browser-e2e.mjs`

- `backToLobby`（:580-585）：点击「返回大厅」后，`waitForSelector('.uni-modal__btn_primary')`（类名已核定，§0.3-10）并点它，再等落 lobby（并断「点完确实落在 lobby」）。
- `:547` 注释按 K3 措辞微调（ended 相位语义未变；进行中加了一句确认）。
- `:1020` 调用点即 playing 相位——由上面的 `backToLobby` 统一处理，无需改调用点；其后的 `secondGameJudgment` 前提**实跑核定**（设计 §4 注明）。
- N32 受控复现（:540-578）：**零改动**。

### 2.10 `slice-05-reconnect.ts`（C16）

紧贴步骤 8 之后新增（**不得用 P0**；行动者用 P1）。**口径（F11）**：设计 §4 的「2 断言」= 其两条核心断言，此处拆为 **4 条 `checks`**（前提自证 1 + 断言 3），baselines 按 **+4** 回填（64→68）：

1. 前提自证：`HGET room:{code} status` === `playing`（不满足 ⇒ 显式失败提示环境）；
2. P1 `room.match {mode:'random', baseScore:…}` ⇒ 断言 `code === 12011`；
3. P1 `room.leave {roomCode}` ⇒ 断言 `code === 0`；
4. P1 再次 `room.match` ⇒ 断言 `code === 0`（入队成功）⇒ 随即 `room.unmatch` 收尾（窗口口径：断言后即清理，不做匹配等待）。

## 3. 判据总表（C1–C16 ↔ 设计 §6 原样；载体）

| # | 判据（缩写，全文见设计 §6） | 载体 |
|---|---|---|
| C1 | playing+view 非 ended ⇒ 12011 + 未入队 | `message.router.test.ts`（zscore 证） |
| C2 | waiting ⇒ 12011 且不调 game.view | 同上（view 调用计数） |
| C3 | 无凭据 / finished / 已回收 ⇒ 放行入队 | 同上 |
| C4 | playing+view ended ⇒ 放行 | 同上 |
| C5 | 三态失败面：resolver reject⇒13001；**view 传输类⇒∈ 既有失败面（10007/13001）且 ≠12011**（`GameServiceError` 专用分支先于通用 catch，F12，测试用显式注入区分）；view 缺失类⇒12011 | 同上（三条） |
| C6 | 封禁+在局 ⇒ 11003 | 同上 |
| C7 | leave 清理三态（一致清/不一致不清/缺席清且幂等） | `message.router.test.ts` + `ws.gateway.test.ts`（onSeatLeft 实清） |
| C8 | leave 后旧局 per-seat 推送不得到达 | `ws.gateway.test.ts` |
| C9 | 进行中：取消无副作用；确认 ⇒ leave 信封 ⇒ ack0 ⇒ reset+navigate | `table-play-ui.test.ts` |
| C10 | 非零留守 / 超时留守 / 12001=成功离场 / **迟到 code 0 不导航不 reset**（超时用假定时器） | 同上 |
| C11 | waiting/ended 无弹窗；ended 不发 leave；waiting 不发 leave 只导航 | 同上 |
| C12 | 判定次序（ended/view-null 前置） | 同上 |
| C13 | game.vue：不写 error、roomCode 守卫、只导航 | `auth-ui-wiring.test.ts`（:337-356 既有 GamePage + `room.match` ack 驱动夹具，12009 同族先例） |
| C14 | SPEC_CODES / doc-sync 对账绿 + action-copy 条目 | 既有两闸 + `action-feedback.test.ts`（文案表处） |
| C15 | 探针：full 场景含确认处理全绿；N32 零改动 | `browser-e2e.mjs` 实跑 |
| C16 | 真栈：在局 match⇒12011；leave 后 match⇒0 | conformance slice-05 |

## 4. 既有判据同步清单（实现先 grep）

grep 词：`12011`、`ALREADY_IN_GAME`、`返回大厅`（.vue/.mjs/design 文档）、`SPEC_CODES`、`room.leave`、`getRecord`/`readRecord`（公开化后的全仓引用面）、`uni-modal`（探针面）。
已点名：`errors.test.ts` SPEC_CODES；`protocol-doc-sync.test.ts`（client-protocol.md 表）；`message.router.test.ts:1092-1097`（闸③兼容）与 `:1212-1219`（闸①兼容）；`browser-e2e.mjs:547`、`:580-585`、`:1020` 链；上片设计 :33/:96-101 勘误。

## 5. 验收条目（A1–A4）

| # | 条目 |
|---|---|
| A1 | 局中点「返回大厅」⇒ 弹确认；取消 ⇒ 仍在牌桌继续可操作；确认 ⇒ 回大厅、**可正常开始新匹配**、旧局后台自动打完（用户实测路径的修复实证） |
| A2 | 确认弃局后刷新/杀进程 ⇒ **不会被拉回旧局**（凭据已清）；而**未确认**时刷新 ⇒ 仍被拉回牌桌（一致语义） |
| A3 | 等待房与结算页的「返回大厅」体验与行为**与部署前一致**（K3 回归） |
| A4 | 在局中（含等待房）去大厅点开始游戏 ⇒ 被拦（文案）+ 自动回桌（不再出现双坐局/双结算） |

## 6. 测试矩阵

- room-service：`message.router.test.ts`（C1-C7）、`ws.gateway.test.ts`（C7 实清 + C8）。
- 客户端：table 既有测试文件（C9-C12，含 uni-stub 扩展与假定时器）、game 页既有测试（C13）、`errors.test.ts`/`protocol-doc-sync.test.ts`（C14）。
- 探针：`scripts/browser-e2e.mjs`（`--scenario full` 全链；本地 Chrome 纪律见 windows-dev-env-quirks）。
- conformance：slice-05（C16，+4 断言入基线）。

## 7. 文档同步表

| 文件 | 改动 |
|---|---|
| `docs/client-protocol.md` | 12011 行（§2.1） |
| `docs/design.md` §11.2 | 12011 行（人工） |
| 上片设计 v1.3.3 勘误 | §1 :33、§3.6 :96-101 订正 + 修订记录行 |
| 上片设计 §6 #10 与本片 §5#10/#11 交叉引用 | 本片设计 §5#11 即引用处，无需改上片 |
| 本片设计/规格 | 冻结后随实现回填 |

## 8. 部署、回滚与明确不做

- **部署**：需重建**两个镜像**——`room-service`（守卫/leave/协议）与 `edge`（含客户端；protocol 是编译进两者的 workspace 包，非独立镜像；其余服务不消费 12011，无需重建）⇒ 走**手动等价流程**（Actions 额度未恢复；`build-images.sh` + `deploy.sh`，PNG stash 纪律照旧）。⚠️ edge 重建纪律（windows-dev-env-quirks 第 18 条）：如涉 `deploy/Caddyfile` 必须 `build edge && up -d edge` 且显式 `EDGE_HTTPS_PORT=8443`（本片不改 Caddyfile，照常重建即可）——部署动作本身仍由用户裁决触发。
- **回滚**：`deploy.sh v1.12.0` 即回上一版；无迁移、无 env、无服务器动作。
- **明确不做**：设计 §7 全条（方案 B 入口 / 自动弃局 / 等待房与结算态交互 / handleJoin 守卫 / 多端同步 / 守卫文案尾注）。

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-12 | 起草：承接设计 v1.3；11 条规格级裁定；C1–C16 / A1–A4 / 测试矩阵 / 部署口径 |
| v1.1 | 2026-10-12 | 吸收规格审查（一轮闭环）：F1 两测试替身补 `getRecord` 配套；F2 探针类名写死 `uni-modal__btn_primary`（已实读 uni-h5 产物核定）；F3 §1.1 补 5 文件（两测试 + baselines 64→68 + 客户端三测试点名）；F4 `localError=''`；F5 `sendQueued.catch(()=>null)`；F6 迟到 ack 口径改「doLeave 无动作 + CLIENT_ACTION 既有处置照常」；F7 载体文件点名（table-play-ui / auth-ui-wiring / action-feedback）；F8 表行风格对齐；F9 镜像口径改正为两个；F12 C5 传输类断言改「∈ 既有失败面且 ≠12011」；F10 文案去尾；F11 C16 拆 4 checks 与基线口径 |
| v1.1.1 | 2026-10-12 | 计划审勘误（P2）：§2.7 文案与 §0.3-2 对齐（去尾，「，已返回牌局」为 v1.0 残留笔误） |
| v1.1.2 | 2026-10-12 | 执行期 O1 裁决勘误：§0.3-7 竞速计时器落点钉为 `src/composables/raceTimeout.ts`（R675 页面计时器闸漏查，控制者文本缺陷登记） |

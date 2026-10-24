# 「返回大厅」弃局出口 + 匹配守卫 实施计划 v1.1（审闭环，可入实现）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 局中点「返回大厅」改为确认退出（真弃局）；服务端 `room.match` 加「在局/在房」守卫（新码 12011）；配套 leave 投递清理与测试/探针/conformance。

**Architecture:** 客户端 `table.vue` 三阶段判定链（ended → view null → 进行中确认）；服务端两处：`handleMatch` 两段守卫（resolver 第一遍 + playing 时 view-ended 放行）、`handleLeave` 清理单闸 + `onSeatLeft` 投递清理（`seatOwners`）。

**Tech Stack:** NestJS + ioredis（room-service）、uni-app/Vue3（客户端）、Vitest、自建 conformance harness、CDP 探针（browser-e2e）。

## Global Constraints

- 唯一语义来源：设计 v1.3 + 规格 v1.1 冻结稿（`docs/superpowers/specs/2026-10-12-leave-and-match-guard-{design,spec}.md`）——冲突停下问协调者。
- 用户裁决 K1（仅进行中确认退出）/K2（守卫）/K3（等待房与结算态保持现状）。
- 本片**不改**：等待房与结算态交互、`handleJoin`、多端同步、`leaveSeat/resetWaitingWindow` 既有逻辑。
- 每个任务 TDD：先写失败测试 → 跑红 → 实现 → 跑绿 → commit（**T4 例外**：探针/文档任务以语法级自检 + T5 实跑替代）。commit message 结尾逐字：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 命令：room-service `pnpm --filter @fight-the-landlord/room-service test` / `lint`；client `pnpm --filter @fight-the-landlord/client test` / `lint`；protocol `pnpm --filter @fight-the-landlord/protocol test`。
- `git add` 只加本任务列出的文件（工作树有**未提交的用户 PNG**（3 张），任何任务都不得 add 它们、不得 `git add -A`）。

---

### Task 1: 协议层 12011

**Files:**
- Modify: `packages/protocol/src/errors.ts`、`packages/protocol/src/errors.test.ts`
- Modify（文档对账）: `docs/client-protocol.md`（错误码表 + 处置行）、`docs/design.md`（§11.2 总表行）

**Interfaces:**
- Produces: `ErrCode.ALREADY_IN_GAME = 12011`；`CLIENT_ACTION[12011] = ClientAction.TOAST`（后续任务消费）。

- [ ] **Step 1: 失败测试**——`errors.test.ts` 的 `SPEC_CODES` 在 `12010` 后加一行 `12011, // 在局/在房匹配守卫（本片）`。
- [ ] **Step 2: 跑红**——`pnpm --filter @fight-the-landlord/protocol test -- errors.test.ts` ⇒ FAIL（`ErrCode` 无此值，集合不相等）。
- [ ] **Step 3: 实现**——`errors.ts`：枚举区 `ROOM_MODE_DISABLED = 12010` 后加 `/** 本片：在局/在房者请求 `room.match` 的守卫拒绝（设计 §3.3）。 */ ALREADY_IN_GAME = 12011,`；`CLIENT_ACTION` 表加 `[ErrCode.ALREADY_IN_GAME]: ClientAction.TOAST,`。
- [ ] **Step 4: 跑绿 + 文档同步**——protocol 测试全绿；`docs/client-protocol.md` 错误码表加 `` | `12011` | ALREADY_IN_GAME | 你还有未结束的对局或房间 | `toast` | ``（随该表现有列风格）；`docs/design.md` §11.2 人工同步同表行。跑 `pnpm --filter @fight-the-landlord/client test -- protocol-doc-sync.test.ts` 绿。
- [ ] **Step 5: Commit**——`git add packages/protocol/src/errors.ts packages/protocol/src/errors.test.ts docs/client-protocol.md docs/design.md` + message `feat(protocol): 新增 12011 ALREADY_IN_GAME（在局/在房匹配守卫）`。

---

### Task 2: room-service 守卫 + leave 单闸 + onSeatLeft

**Files:**
- Modify: `packages/room-service/src/gateway/message.router.ts`、`packages/room-service/src/gateway/ws.gateway.ts`、`packages/room-service/src/reconnect/reconnect.service.ts`
- Test: `packages/room-service/test/message.router.test.ts`、`packages/room-service/test/ws.gateway.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ErrCode.ALREADY_IN_GAME`；既有 `resolveRecoverableRoom`/`isMissingGameError`。
- Produces: `RouterDeps.onSeatLeft?: (roomCode, userId) => void`；`ReconnectService.getRecord(playerId)`（公开读，`ReconnectRecord | null`）。

- [ ] **Step 1: 夹具与失败测试**
  1. `message.router.test.ts` 的 makeDeps 替身：加 `getRecord`（读同一假 redis 的 `RECONNECT_HASH_KEY` 字段、JSON.parse、缺/坏 ⇒ null——与真实语义一致，使清理闸三态可控）。
  2. `ws.gateway.test.ts` 的 ReconnectMock：加 `getRecord: vi.fn().mockResolvedValue(null)`。
  3. 新用例（载体/判据 C1-C8 见规格 §3）：守卫星（playing+view 非 ended ⇒ 12011 且未入队；waiting ⇒ 12011 且 `game.view` 零调用；无凭据/finished ⇒ 放行入队；playing+view ended ⇒ 放行；三态失败面 [resolver reject⇒13001 / view 传输类⇒∈{10007,13001} 且 ≠12011 / view 缺失类⇒12011]；封禁+在局⇒11003）；leave 三态（一致清/不一致不清仍 ok/缺席清且幂等——钉既有 `:1092-1097` 与 `:1212-1219` 保持绿）；ws.gateway 侧 onSeatLeft 实清 + leave 后旧局 per-seat 推送不得到达（C8：注入 game 事件断言未 emit）。
- [ ] **Step 2: 跑红**（新用例红；既有 leave 用例此时仍绿——替身已补 getRecord 但实现未换）。
- [ ] **Step 3: 实现（逐字照抄规格 §2.2/§2.3/§2.4 的代码块——**含 rationale 注释行**，本计划为省篇幅省略的注释不得漏）**

  `handleMatch` 守卫（封禁块 :409-411 之后、`readMeta` 之前）：

  ```ts
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

  `handleLeave` 清理段（`socket.leave` 之后两行替换）：

  ```ts
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

  `RouterDeps` 加可选字段 `onSeatLeft?: (roomCode: string, userId: string) => void;`；`ws.gateway.ts` 的 `routerDeps()` 注册：

  ```ts
  onSeatLeft: (roomCode, userId) => {
    for (const [key, owner] of this.seatOwners) {
      if (owner === userId && key.startsWith(`${roomCode}:`)) this.seatOwners.delete(key);
    }
  },
  ```

  `reconnect.service.ts`：`readRecord` 保留私有 + 新增公开薄封装 `getRecord(playerId)`。
- [ ] **Step 4: 跑绿**——`pnpm --filter @fight-the-landlord/room-service test` 全绿 + `lint` clean。
- [ ] **Step 5: Commit**——只加上述 5 文件，message `feat(guard): room.match 在局/在房守卫 + room.leave 清理单闸与投递清理`。

---

### Task 3: 客户端确认退出流 + 12011 分支

**Files:**
- Modify: `apps/client/src/pages/table/table.vue`、`apps/client/src/pages/game/game.vue`、`apps/client/src/net/action-copy.ts`、`apps/client/test/helpers/uni-stub.ts`
- Test: `apps/client/test/table-play-ui.test.ts`、`apps/client/test/auth-ui-wiring.test.ts`、`apps/client/test/action-feedback.test.ts`
- **新增（执行期 O1 裁决，2026-10-12）**: `apps/client/src/composables/raceTimeout.ts`——5s 竞速的**唯一 `setTimeout` 落点**（R675 闸禁止页面文件含计时器；规格 v1.1.2 勘误同此）。`table.vue` doLeave 消费它，竞速形状与语义不变。

**Interfaces:**
- Consumes: Task 1 的 `ErrCode.ALREADY_IN_GAME`。
- Produces: `table.vue` 的 `onBackToLobby()/doLeave()`（页内，无跨文件接口）；`uni-stub.showModal` 记录完整 options（含 `success`）。

- [ ] **Step 1: uni-stub 扩展 + 失败测试**
  1. `uni-stub.ts`：`showModal` 类型与实现扩为记录完整 options（`{ title?; content?; confirmText?; cancelText?; success?: (res: { confirm: boolean }) => void; fail?: () => void }`），**不自动回调**。
  2. `table-play-ui.test.ts` 新 describe（C9-C12，逐条见规格 §3）：进行中弹窗参数逐字断言；取消 ⇒ 无 leave/无导航/localError 空；确认 ⇒ `room.leave` 信封（`emittedOf('room.leave')[0].env.payload == { roomCode }`）⇒ ack 0 ⇒ `store.reset` + 导航 lobby；leave 非零（如 10006）⇒ localError「退出失败，请重试」且不动 store；本地超时（假定时器 5s）⇒ 同上留守；`sendQueued` reject（会话拆除）⇒ 留守不抛；**迟到 code 0 ack（超时后到达）⇒ 不导航不 reset**；ended ⇒ 无弹窗且 `emittedOf('room.leave')` 为空（只导航）；view null（等待房）⇒ 无弹窗、无 leave、只导航。
  3. `auth-ui-wiring.test.ts`：GamePage `match()` ack 12011 ⇒ `error` 行不出现、`navigate('table')` 被调（store.roomCode 非空前提）；store 空 ⇒ 不导航只 toast。
  4. `action-feedback.test.ts`：文案表含 12011 ⇒ 「你还有未结束的对局或房间」（逐字）。
- [ ] **Step 2: 跑红**。
- [ ] **Step 3: 实现（规格 §2.5/§2.6/§2.7 伪码逐行）**——`table.vue` 顶栏按钮 `@click` 改 `onBackToLobby()`（等待房/ended 分支保持 `auth.navigate('lobby')` 语义）；`localError.value = ''` 清口；showModal 参数逐字 `{ title: '退出本局', content: '本局将由系统自动打完（金币场按结果结算），期间无法回到本局。', confirmText: '退出', cancelText: '取消' }`；`doLeave()` 按规格 §2.5（5s 竞速 + `.catch(() => null)` + 12001=成功）。`game.vue` match 非零分支 12011 ⇒ `store.roomCode !== null` 时 `auth.navigate('table')`，**不写** `error.value`。`action-copy.ts` 加条目 `[ErrCode.ALREADY_IN_GAME]: '你还有未结束的对局或房间'`（**去尾逐字**；规格 §2.7 曾为带尾残留笔误，已 v1.1.1 勘误，以 §0.3-2 为准——P2）。**注意**：`game-store-session-reset.test.ts` 的源码闸（页面直写 `currentVersion = -1` 禁）——用 `store.reset()` 不触红。
- [ ] **Step 4: 跑绿**——client 全量 + `lint`（vue-tsc）。
- [ ] **Step 5: Commit**——`feat(client): 局中「返回大厅」确认退出（room.leave）+ 12011 分支回桌`。

---

### Task 4: 探针改动 + 文档勘误（不跑探针，T5 实跑）

**Files:**
- Modify: `scripts/browser-e2e.mjs`、上片设计 `docs/superpowers/specs/2026-10-12-reconnect-until-game-end-design.md`（勘误 v1.3.3）

- [ ] **Step 1: 探针**——`backToLobby`（:580-585）：点击后 `waitForSelector('.uni-modal__btn_primary')`（类名已核定）并点，再等落 lobby；`:547` 注释按 K3 措辞微调（ended 相位语义未变；进行中加确认）。`createRoomAndJoin` ④ 与 N32（:540-578）**零改动**。
- [ ] **Step 2: 勘误**——上片设计：§1 :33 与 §3.6 :96-101 的「返回大厅只导航」表述订正为「进行中=确认退出（本片 2026-10-12）；等待/结算=只导航」；修订记录加 v1.3.3 行。
- [ ] **Step 3: 语法级自检**——`node --check scripts/browser-e2e.mjs`；全文 grep `uni-modal__btn_primary` 命中。
- [ ] **Step 4: Commit**——`docs(guard): 探针确认处理 + 上片设计勘误 v1.3.3`。

---

### Task 5: conformance + 基线 + 全链路验证与收口

**Files:**
- Modify: `tools/conformance/src/slices/slice-05-reconnect.ts`、`tools/conformance/baselines.json`、本片设计/规格（状态回填）

**前置**：本机 docker 栈在跑；room-service 已是本片镜像：`docker compose build room-service && docker compose up -d room-service`；（探针用本机 dev 栈/或按 windows-dev-env-quirks 走既定口径）。

- [ ] **Step 1: slice-05 C16（四断言，规格 §2.10 逐条）**——紧贴步骤 8 后、用 P1：前提自证（`HGET room:{code} status`=playing）⇒ `room.match` ⇒ 12011 ⇒ `room.leave {roomCode}` ⇒ 0 ⇒ 再 `room.match` ⇒ 0 ⇒ 随即 `room.unmatch` 收尾。
- [ ] **Step 2: baselines**——`full.slice-05` 64→**68**（静态计数核对；零下调纪律）。
- [ ] **Step 3: 跑片**——`pnpm -C tools/conformance build && node tools/conformance/dist/run.js slice-05`（另跑 slice-12 与 slice-07 确认无连带）。
- [ ] **Step 4: 探针实跑（两条，P1）**——① `browser-e2e.mjs --scenario full`（确认处理 + `secondGameJudgment` 前提实跑核定）；② **`--scenario second-game`**（受控 N32 复现零改动跑绿——`full` **不含**受控段（`wantControlled` 仅 gate/second-game），只跑 full 拿不到「受控复现绿」的证据）。环境纪律：`--no-server`/`CHROME_BIN`/`--cdp-port`（windows-dev-env-quirks）。
- [ ] **Step 5: 全序 conformance（P3）**——`node tools/conformance/dist/run.js`（全片；`room.match`/`room.leave` 是全片系共用入口，收口=全序验收点）。红项分类照台账口径（同 run 跨阶段绿/红=环境假红；真红单跑复现）。
- [ ] **Step 6: 门禁 + 验收记录 + 收口**——`pnpm -r --no-bail test`（已知 PNG 环境红照记）、`pnpm lint`；A1-A4 逐条证据（**A1**=full 场景 `:1020→secondGameJudgment` 段 + 用户端到端留验收；**A2**=既有机器证据 slice-05 C5（显式 leave ⇒ 不推 + 13010）+ 本片 C16 三点；**A3**=createRoomAndJoin 链绿（K3 回归）；**A4**=C16 + 客户端 C13）；设计/规格状态回填；commit `docs(guard): 全链路验证 + 基线回填 + 验收记录（收口）`。

**部署**（不在本计划任务内，用户裁决触发）：手动等价流程重建 `room-service` + `edge` 两镜像（PNG stash 纪律照旧）。

---

## 自检（写完后的对照）

- **规格覆盖**：C1-C8→T2；C9-C13→T3；**C14→T1（SPEC_CODES/doc-sync 两闸）+ T3（action-copy 条目）**；**C15→T4（探针文件）+ T5（实跑）**；C16→T5；A1-A4→T5。无缺口。
- **占位符扫描**：无 TBD；关键代码块均逐字内嵌（守卫/单闸/onSeatLeft/伪码引用规格 §2.5）。
- **类型一致性**：`ALREADY_IN_GAME`（T1）→ T2/T3 消费一致；`getRecord`（T2）与两测试替身（T2）一致；`onSeatLeft` 可选字段（T2）。

---

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-12 | 初稿：5 任务 TDD 拆解 |
| v1.1 | 2026-10-12 | 吸收计划审查：P1 T5 探针拆两条（full + second-game，N32 受控在后者）；P2 T3 钉死去尾文案 + 规格 §2.7 v1.1.1 勘误；P3 T5 补全序步（Step 5）与门禁顺延（Step 6）；P4 自检对位表更正（C14→T1+T3；C15→T4+T5）；P5 Global TDD 加 T4 例外；P6 T2 注明注释一并照抄；P7 A1/A2 证据实化 |
| v1.2 | 2026-10-12 | 执行期 O1 裁决：T3 Files 补登第 8 文件 `src/composables/raceTimeout.ts`（R675 页面计时器闸漏查的合规落点；规格 v1.1.2 勘误同步） |

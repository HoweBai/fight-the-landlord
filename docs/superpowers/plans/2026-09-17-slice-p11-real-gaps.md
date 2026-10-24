# 切片 P11 Implementation Plan：收掉 A 类真缺口（N31 房间状态机 · N30①③ 大厅体验 · N13 IP 限流）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把台账 §1.5 里**仍开放/部分关闭**的三条真缺口收掉：`N31`（房间状态恒 `waiting`）、`N30①③`（断线无连接状态、大厅无建房入口与房间列表不可点）、`N13`（登录/注册无 IP 维度限流）。

**Architecture:** 三条**互不依赖**，可并行派工：
`N31` + `N13` 在后端（`packages/room-service` / `packages/api-gateway`），`N30①③` 在前端（`apps/client`）。
全部走既有形态：房间状态落在 `room:{code}` Hash（§10.1，字段集由 `META_FIELDS` 单一驱动）；
限流走既有的 ZSET 滑动窗口（`rate-limit.ts`）；前端新增 REST 调用走既有 `authedRequest` 封装。

**Tech Stack:** TypeScript / NestJS / ioredis / Vitest / Vue 3 + Pinia / pnpm + Turborepo。

**Spec:**
- `docs/design.md` —— §3.1（`Room.status` 四态 + `timeoutAt`）· §3.1 `RoomInfo` · **§5.4（限流四维度）** ·
  §6.4 规则 3（`RoomPlayer` 只允许 `{id, seat, cardCount?}`）· §7.1（路由表：`GET/POST /api/rooms`）· §11.2（错误码）
- `docs/superpowers/plans/deviation-ledger.md` —— **N31 / N30 / N13** 三行（含 P9 的定位取证原文）· §5
- `docs/superpowers/plans/agent-briefs.md` —— 「已知环境事实（新 session 必读）」

## Global Constraints

1. **每条改动配测试**；`pnpm exec turbo run test lint --force` 必须 **29/29、0 cached**。
2. **conformance 必须独占跑**（网关按 IP 计并发 WS 连接，上限 5）；每条套 `timeout 300`；不传 `CONFORMANCE_STEPS`。
3. **跑 conformance 前必跑** `pnpm exec turbo run build --force`（`robot-service` 是 bind-mount，容器跑宿主 `dist/`）。
4. **开发命令一律不带 `-f`**（Compose 自动合并 `docker-compose.override.yml`）；重建镜像用 `DOCKER_BUILDKIT=0 docker compose build`。
5. `packages/protocol`、根配置、`tools/**`、`docs/**` **归协调者**；agent 不碰。
6. commit message 末尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
7. **发现实现与规格不符 ⇒ 先登记**（台账 §1.5 / §3），不要顺手扩范围。

---

## 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接 P10 声明的区间（R428–R450），本片协调者区间 **R451–R470**。

- **R451 `N31` 只补状态机，`cardCount` 的打开是**同一处修改的必然连带**，一并接受。**
  **事实**：`room.status` 恒 `waiting` ⇒ `message.router.ts:426` 的 `if (room.status === 'playing')` 是死分支
  ⇒ `RoomPlayer.cardCount` 从不出现。修好状态机后该分支**自动生效**，`room.state_update` 的载荷会**多一个字段**。
  **裁决**：接受（§6.4 规则 3 本就把 `cardCount?` 列为允许字段，且 §3.1 的房间列表不涉及它）。
  ⚠️ **但必须同步核查并更新**：任何断言 `RoomPlayer` 字段集**恰好**为 `{id, seat}` 的既有断言
  （`grep -rn "cardCount" packages/room-service/test tools/conformance/src`），每处都要写明「加了什么、为什么不是放宽」。
- **R452 `room.status` 的三次转移各有唯一写入点**：`create()` 写 `waiting`（已有）·
  **开局成功后**写 `playing`（`match.service.ts:311` 之后）· **`game.ended` 事件到达时**写 `finished`
  （`ws.gateway.ts` 的 `onGameEvent` 的 `game.ended` 分支）。**不得**在别处再写（第二真源）。
- **R453 `N13` 的 IP 维度阈值取 `{ max: 120, windowMs: 60_000 }`**（不是 §5.4 的 20/5s）。
  **理由**：原登记的阻塞逐字是「凭空加一维会打伤 conformance 的造数步骤（`slice-07.1` 一次连发 20 个注册）」；
  120/min 既能挡住暴力破解的量级（20 个注册只占 1/6），又不触碰既有用例。
  ⚠️ **阈值必须写进 §5.4 的规格表**（协调者改 `docs/**`）——**否则就是「实现里的魔法数」**。
- **R454 `N30③` 不新增后端能力**：`POST /api/rooms` 在规格 §7.1 与实现（`gateway.controller.ts:97`）**都已存在**
  ⇒ 只补前端 `rest.createRoom()` + 大厅入口 + 房间列表项可点（走既有 `room.join`）。
- **R455 `N30①` 只做「把已有信号呈现出来」，不新建连接状态机**：
  `net/socket.ts` 已有 `hasConnected`（`:303`）与 `connect_error`（`:722`），会话层已有 `SessionNotice` 机制
  ⇒ 把 `connect_error` 转成一条 error 级 notice（并保证它**不被**后续 notice 覆盖），页面渲染即可。
  ⚠️ **不得**在页面里判断「socket 是否连上」（那是 net 层的状态，页面只读 notice）。

---

## File Structure

```
packages/room-service/src/match/match.service.ts            Modify: 开局成功后写 status='playing'（R452）
packages/room-service/src/gateway/ws.gateway.ts             Modify: game.ended → status='finished'（R452）
packages/room-service/test/match.service.test.ts            Modify: 两条状态转移用例
packages/room-service/test/ws.gateway.test.ts               Modify: 终局状态用例
packages/api-gateway/src/http/rate-limit.ts                 Modify: 新增 HTTP_IP_RATE_LIMIT + 判定函数（N13）
packages/api-gateway/src/http/http-rate-limit.middleware.ts Modify: 登录/注册路径上加 IP 维度（N13）
packages/api-gateway/test/http-rate-limit.test.ts           Modify: IP 维度用例（含「既有 20 连发仍放行」正对照）
apps/client/src/net/rest.ts                                 Modify: 新增 createRoom()（N30③）
apps/client/src/pages/lobby.vue                             Modify: 建房按钮 + 房间列表项可点 + 连接状态条（N30①③）
apps/client/test/lobby-ux.test.ts                           Create: 三条前端用例
docs/design.md                                              Modify: §5.4 补 IP 维度（协调者，R453）
docs/superpowers/plans/deviation-ledger.md                  Modify: N31/N30/N13 判定 + §0（协调者）
```

---

### Task 1: 房间状态机落地 `playing` / `finished`（后端）

**Files:**
- Modify: `packages/room-service/src/match/match.service.ts:311`
- Modify: `packages/room-service/src/gateway/ws.gateway.ts`（`onGameEvent` 的 `game.ended` 分支，约 `:455`）
- Test: `packages/room-service/test/match.service.test.ts`、`packages/room-service/test/ws.gateway.test.ts`

**Interfaces:**
- Consumes: `RoomsService.updateStatus(code: string, status: RoomStatus): Promise<Room>`（已存在，`:131`）
- Produces: 无新符号；`room:{code}` 的 `status` 字段此后会真实取值 `playing` / `finished`

- [ ] **Step 1: 写失败用例（开局 → playing）**

在 `packages/room-service/test/match.service.test.ts` 里，仿照既有「三人成局」用例追加：

```ts
it('开局成功后 room.status 必须是 playing（N31/R452）', async () => {
  // 前置沿用本文件既有的 fake-redis + 三人入队构造（见同文件其它用例的 beforeEach）
  await service.runMatchCycle('random', 'global'); // 名称按本文件既有入口改
  const rooms = await roomsService.findAll();
  expect(rooms).toHaveLength(1);
  expect(rooms[0]!.status).toBe('playing');
});
```

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm --filter @fight-the-landlord/room-service test -- match.service`
Expected: FAIL，实测形状 `expected 'waiting' to be 'playing'`

- [ ] **Step 3: 写失败用例（终局 → finished）**

在 `packages/room-service/test/ws.gateway.test.ts` 追加：

```ts
it('game.ended 事件后 room.status 必须是 finished（N31/R452）', async () => {
  await roomsService.create({ mode: 'random', roomCode: 'AAAAAA' });
  gateway.onGameEvent({
    event: 'game.ended',
    roomCode: 'AAAAAA',
    version: 9,
    seats: [],
    seatViews: [],
    result: undefined,
  } as never);
  await Promise.resolve(); // releaseRobots / updateStatus 是 void 异步
  const room = await roomsService.findOne('AAAAAA');
  expect(room?.status).toBe('finished');
});
```

Run: `pnpm --filter @fight-the-landlord/room-service test -- ws.gateway`
Expected: FAIL，`expected 'waiting' to be 'finished'`

- [ ] **Step 4: 实现两处写入（各一行）**

`match.service.ts`（`:311` 的 `startGame` **之后**、同一 `try` 块内）：

```ts
      await this.startGame(room.code, room.baseScore, seats, botBindings);
      // §3.1 / N31（R452）：开局成功 ⇒ 房间离开 waiting。**这是 playing 的唯一写入点**。
      // ⚠️ 不得放到 `startGame` 之前：RPC 失败时房间会停在 playing（半成品可玩），
      //    而失败路径已有 `updateStatus(room.code, 'cancelled')`。
      await this.roomsService.updateStatus(room.code, 'playing');
```

`ws.gateway.ts`（`onGameEvent` 的 `game.ended` 分支内，`releaseRobots` 之前或之后均可，但**同一次调用内**）：

```ts
      // §3.1 / N31（R452）：终局 ⇒ 房间进终态。**这是 finished 的唯一写入点**。
      // `roomsService` 已在构造函数注入（ws.gateway.ts:constructor）。
      void this.roomsService.updateStatus(event.roomCode, 'finished');
```

- [ ] **Step 5: 跑用例确认通过**

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS（用例数 = 原 202 + 2）

- [ ] **Step 6: 核查 `cardCount` 连带的既有断言（R451）**

Run:
```bash
grep -rn "cardCount" packages/room-service/test tools/conformance/src apps/client/test | grep -v node_modules
```
Expected: 逐条判断——凡断言 `RoomPlayer` **字段集恰好** `{id, seat}` 的，改为允许 `seat`+`cardCount?`
（并在 commit message 里写明「§6.4 规则 3 本就允许 `cardCount`，这是让死分支复活，不是放宽」）。
若无命中，在 commit message 里写明「实测 0 命中」。

- [ ] **Step 7: Commit**

```bash
git add packages/room-service/src packages/room-service/test
git commit -m "fix(room-service): 房间状态机落地 playing/finished（N31/R452）"
```

---

### Task 2: `N13` 登录/注册的 IP 维度限流（后端，与 Task 1 并行）

**Files:**
- Modify: `packages/api-gateway/src/http/rate-limit.ts`
- Modify: `packages/api-gateway/src/http/http-rate-limit.middleware.ts`
- Test: `packages/api-gateway/test/http-rate-limit.test.ts`

**Interfaces:**
- Consumes: 既有 `HTTP_RATE_LIMIT = { max: 20, windowMs: 5000 }`、`isRateLimited(redis, key, now)` 形态（`rate-limit.ts:37`）
- Produces: `HTTP_IP_RATE_LIMIT = { max: 120, windowMs: 60_000 }`、`isIpRateLimited(redis, ip, now): Promise<boolean>`

- [ ] **Step 1: 写失败用例**

```ts
it('同一 IP 在窗口内超过 120 次登录请求会被拒（N13/R453）', async () => {
  for (let i = 0; i < 120; i += 1) {
    expect(await isIpRateLimited(redis, '203.0.113.7', now)).toBe(false);
  }
  expect(await isIpRateLimited(redis, '203.0.113.7', now)).toBe(true);
});

it('正对照：conformance 的 20 连发注册必须全部放行（N13/R453 —— 这就是原登记的阻塞）', async () => {
  for (let i = 0; i < 20; i += 1) {
    expect(await isIpRateLimited(redis, '198.51.100.9', now)).toBe(false);
  }
});

it('不同 IP 互不影响', async () => {
  for (let i = 0; i < 120; i += 1) await isIpRateLimited(redis, 'A', now);
  expect(await isIpRateLimited(redis, 'B', now)).toBe(false);
});
```

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm --filter @fight-the-landlord/api-gateway test -- http-rate-limit`
Expected: FAIL，`isIpRateLimited is not a function`

- [ ] **Step 3: 实现**

`rate-limit.ts` 追加（与既有 `HTTP_RATE_LIMIT` **同形**，键前缀 `ratelimit:http-ip:`）：

```ts
/**
 * §5.4 的**第五个维度：单 IP HTTP**（N13/R453）。
 *
 * ⚠️ 阈值**刻意**比单用户维度（20/5s）宽：它的目标是**防暴力破解的规模**，不是防误用。
 * 原登记（N13）的阻塞逐字是「凭空加一维会打伤 conformance 的造数步骤（slice-07.1 一次连发 20 个注册）」
 * ⇒ 120/min 下那 20 个注册只占 1/6，用例不受影响（正对照见 http-rate-limit.test.ts）。
 * ⚠️ 这个数字是**规格值**：已写进 design.md §5.4（R453），不得在实现里另起一套。
 */
export const HTTP_IP_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;

export async function isIpRateLimited(redis: Redis, ip: string, now: number): Promise<boolean> {
  const key = `ratelimit:http-ip:${ip}`;
  await redis.zremrangebyscore(key, 0, now - HTTP_IP_RATE_LIMIT.windowMs);
  const count = await redis.zcard(key);
  if (count >= HTTP_IP_RATE_LIMIT.max) return true;
  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, Math.ceil(HTTP_IP_RATE_LIMIT.windowMs / 1000));
  return false;
}
```

`http-rate-limit.middleware.ts`：在既有的单用户判定**之后**、放行**之前**插入 IP 判定，
命中即 `429 + ErrCode.RATE_LIMITED + { code, message, data: null }`（**与既有 429 响应逐字同形**）：

```ts
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (await isIpRateLimited(redis, ip, Date.now())) {
    res.status(429).json({ code: ErrCode.RATE_LIMITED, message: 'Too many requests', data: null });
    return;
  }
```

- [ ] **Step 4: 跑用例确认通过**

Run: `pnpm --filter @fight-the-landlord/api-gateway test`
Expected: PASS（用例数 = 原 138 + 3）

- [ ] **Step 5: Commit**

```bash
git add packages/api-gateway/src packages/api-gateway/test
git commit -m "feat(api-gateway): 单 IP HTTP 维度限流（N13/R453，120/min）"
```

---

### Task 3: `N30③` 大厅建房入口 + 房间列表可点（前端，与 Task 1/2 并行）

**Files:**
- Modify: `apps/client/src/net/rest.ts`（新增 `createRoom()`）
- Modify: `apps/client/src/pages/lobby.vue`
- Test: `apps/client/test/lobby-ux.test.ts`（新建）

**Interfaces:**
- Consumes: `authedRequest<T>(...)`（`rest.ts:186`）、`rooms()`（`:202`）· `getGameSession().client.send('room.join', { roomCode })`（lobby 既有 `join()`）
- Produces: `rest.createRoom(payload: { mode: 'random' | 'practice' }): Promise<RestResponse<RoomInfo>>` · `createAndJoin(): Promise<void>`

- [ ] **Step 1: 写失败用例**

```ts
it('rest.createRoom 走 POST /api/rooms 并解析统一信封（N30③）', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ code: 0, data: { code: 'ABC123' } }), { status: 200 });
  }));
  const res = await rest.createRoom({ mode: 'practice' });
  expect(calls[0]!.init?.method).toBe('POST');
  expect(calls[0]!.path).toContain('/rooms');
  expect(res.code).toBe(0);
});
```

- [ ] **Step 2: 跑用例确认失败**

Run: `cd apps/client && pnpm test -- lobby-ux`
Expected: FAIL，`rest.createRoom is not a function`

- [ ] **Step 3: 实现 `createRoom`（与 `rooms()` 同形）**

```ts
/** §7.1：`POST /api/rooms` → `RoomInfo`。房间创建**是 MVP 范围内**的能力（§1.2 第 2 项）。 */
export function createRoom(payload: { mode: 'random' | 'practice' }): Promise<RestResponse<RoomInfo>> {
  return authedRequest<RoomInfo>('/rooms', { method: 'POST', body: JSON.stringify(payload) });
}
```

⚠️ `authedRequest` 的签名若不含 `init`，按它**既有**的接受方式传（先读 `rest.ts:186-196`，**不要**为它另造第二个封装）。

- [ ] **Step 4: 实现大厅入口（`lobby.vue`）**

在 `.lobby__match` 之后加一个「创建房间」按钮，复用既有 `join()` 的进房路径（**不复制** `room.join` 的调用）：

```ts
async function createAndJoin() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const res = await rest.createRoom({ mode: 'practice' });
    if (res.code !== 0) {
      error.value = `创建房间失败（code=${res.code}）`;
      return;
    }
    joinCode.value = res.data?.code ?? '';
    await join(); // 复用同一条 room.join 路径（R61：ack 的 players 由它消费）
  } finally {
    busy.value = false;
  }
}
```

房间列表项改为可点：`<li>` 里加 `@click="joinRoom(room.code)"`，`joinRoom` 同样**复用 `join()`**
（把 `join()` 重构成 `join(code?: string)`，默认取 `joinCode.value`）——**不得**写第二份 `room.join` 逻辑。

- [ ] **Step 5: 跑用例 + 全量前端单测**

Run: `cd apps/client && pnpm test && pnpm lint`
Expected: PASS（169 + 新增；`vue-tsc` 干净）

- [ ] **Step 6: Commit**

```bash
git add apps/client/src apps/client/test
git commit -m "feat(client): 大厅建房入口 + 房间列表可点（N30③/R454）"
```

---

### Task 4: `N30①` 断线/连不上时呈现连接状态（前端）

**Files:**
- Modify: `apps/client/src/net/socket.ts`（`connect_error` 分支，`:722`）
- Modify: `apps/client/src/pages/lobby.vue`（渲染 notice）
- Test: `apps/client/test/lobby-ux.test.ts`

**Interfaces:**
- Consumes: `hasConnected`（`socket.ts:303`）· `SessionNotice`（`net/session.ts`）· `getGameSession().notice`
- Produces: 无新符号；`connect_error` 时 `notice` 为 `{ level: 'error', text: '连接不可用，请检查网络后重试' }`

- [ ] **Step 1: 写失败用例**

```ts
it('connect_error 时给出 error 级 notice（N30①/R455）', async () => {
  // 用 helpers/fake-socket 的 FakeSocket：注册 connect_error 处理器并触发
  const session = createGameSession(options);           // 沿用 reconnect-flow.test.ts 的构造
  fakeSocket.handlers.get('connect_error')!(new Error('websocket error'));
  expect(notice.value).toMatchObject({ level: 'error' });
  expect(notice.value!.text).toContain('连接不可用');
});

it('正对照：正常 connect 不得留下 error 级 notice（否则是恒红）', async () => {
  fakeSocket.handlers.get('connect')!();
  expect(notice.value?.level).not.toBe('error');
});
```

- [ ] **Step 2: 跑用例确认失败** → `cd apps/client && pnpm test -- lobby-ux`（FAIL：notice 仍为 null）

- [ ] **Step 3: 实现**

`socket.ts` 的 `connect_error` 分支里，**在既有逻辑之外**补一条 notice（经既有 `onNotice` 通道，
**不要**新增第二条通知通路）：

```ts
    this.socket.on('connect_error', (err: Error) => {
      // N30①/R455：断线/连不上时**必须先告诉用户**。旧实现只把内部码塞进
      // 「匹配失败（code=-1）」，用户看到的是「匹配失败」而不是「连不上」。
      // ⚠️ 只在**首次或长时间**失败时提示，避免 socket.io 自动重连把它刷成刷屏
      //    —— 去抖口径沿用 RECONNECT_DEBOUNCE_MS。
      this.options.onNotice?.({ level: 'error', text: '连接不可用，请检查网络后重试' });
      /* …既有逻辑保持不变… */
    });
```

⚠️ 上文 `this.options.onNotice` 是**占位示意**：落地前先读 `socket.ts` 里既有的 notice 写入点
（`grep -n "onNotice" apps/client/src/net/socket.ts`），**必须复用同一个写入函数**。
若发现有去抖机制，按它的既有形态接（不得自造定时器）。

- [ ] **Step 4: 页面渲染**：`lobby.vue` 顶部渲染 `getGameSession().notice`（`level==='error'` 用红色样式），
与 `table.vue` 既有的 `.table__notice` 写法保持一致（**class 名沿用 `lobby__notice`**）。

- [ ] **Step 5: 跑测试 + Commit**

```bash
cd apps/client && pnpm test && pnpm lint && cd ../..
git add apps/client/src apps/client/test
git commit -m "feat(client): 连不上时呈现连接状态（N30①/R455）"
```

---

## 门禁（协调者）

```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force          # ✅ 10/10（conformance 前必跑）
pnpm exec turbo run test lint --force      # ✅ 29/29、0 cached
pnpm run ci                                # ✅ 六阶段
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8/8 healthy
for s in slice-11 slice-07.2-rpc slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ 13/13（slice-06/07 若因 cardCount 变化而红 ⇒ 按 R451 更新断言并写明理由）
node scripts/browser-e2e.mjs               # ✅ gate 16/16（N30 的 UI 改动必须仍能走通）
node scripts/browser-e2e.mjs --scenario full   # ✅ 20/20
node scripts/ledger-counts.mjs             # ✅ §0 与 §1.x 逐区一致
```

## Self-Review

**Spec coverage**

| 规格/台账 | 落在哪个 Task |
|---|---|
| §3.1 `Room.status` 四态真实取值（N31） | Task 1 |
| §6.4 规则 3 的 `cardCount?` 生效（R451） | Task 1 Step 6 |
| §5.4 第五维度「单 IP HTTP」（N13/R453） | Task 2 |
| §7.1 `POST /api/rooms` 的前端入口（N30③） | Task 3 |
| §7.1 白名单/notice 呈现（N30①） | Task 4 |

**Placeholder scan**：无 TBD。Task 4 Step 3 显式标注了「`this.options.onNotice` 是占位示意、落地前先读既有写入点」
—— 那不是 placeholder，而是**要求实现者先取证的指令**（因为 socket.ts 1128 行，notice 写入点必须复用）。

**Type consistency**：`RoomStatus`（`'waiting'|'playing'|'finished'|'cancelled'`）· `RoomInfo`（§3.1 六字段）·
`HTTP_IP_RATE_LIMIT` · `isIpRateLimited` · `rest.createRoom` · `joinRoom` 在各 Task 之间一致。

**⚠️ 三个高风险点**
1. **`cardCount` 打开后 conformance 可能红**（Task 1 Step 6 专治；**不许**用「把断言删掉」过关）。
2. **IP 限流可能打伤 conformance 造数**（Task 2 的 20 连发正对照就是为它写的）。
3. **N30① 的 notice 可能与既有 notice 打架**（`reconnect-flow.test.ts` 里有「notice 不得被覆盖」的既有裁决 R16/N1
   ⇒ Task 4 的正对照必须包含它）。

---

## 执行期裁决（回填区）

> 编号接开工前落盘的 R451–R455；本片协调者区间 **R451–R470**。

### R456 **追认：IP 判定必须放在「未认证早退」之前**（计划 Step 3 的措辞是错的）

**计划怎么写**：Task 2 Step 3「在既有的单用户判定**之后**、放行**之前**插入 IP 判定」。
**事实是什么**（agent 实测并顶回）：那条单用户判定**之前**有一条早退
`if (没有已认证 x-user-id) { next(); return; }`（`http-rate-limit.middleware.ts:35-38`）
⇒ 按字面插在后面，IP 维度对**登录/注册/刷新完全不可达** —— 而 N13 登记的缺口逐字就是这三条；
且 R453 的理由「20 个注册只占 1/6」**只有对未认证请求计数才成立**。
**⇒ 按字面落地 = N13 名义关闭、实质没关**（正是本仓最警惕的「判据恒绿」形态）。
**裁决**：**追认 agent 的落地** —— IP 判定放在早退**之前**，覆盖全部 HTTP 请求。连带后果一并追认：
① 两条既有用例判据收窄（「公开路径完全不计数」→「不按**用户**计数、仍按 **IP** 计数」；「空串 `x-user-id` 不计数」→「不按用户计数」），
它们真正守的东西（不碰用户桶 / R146 的投毒面）**未变**；
② 公开路径从此也 **fail-closed**（Redis 故障 ⇒ `503`），并**新增判据钉住**；
③ 既有「已认证用户 20/5s」用例换**状态化** ZSet 替身 —— 旧替身共享一个计数器，IP 记账会把用户维度顶到第 11 次就 429（**假红**）。
⚠️ 与 P3 教训 1 同族：**计划里的「因为 X 所以 Y」也可能错**，agent 有义务先实测、再按**目的**落地并汇报。

### R457 **R451 的事实断言被 `grep` 证伪 ⇒ 更正 + 登记 N35**

**R451 原话**：「修好状态机后 `message.router.ts` 的 `if (room.status === 'playing')` 自动生效，
`room.state_update` 会**多一个字段**」。
**事实是什么**（agent 实测）：`grep -rn "cardcount" packages/*/src` **只有读点**（`message.router.ts:427`）
+ `rooms.service.ts:67,77` 两条注释；`hset` 全集里**没有任何 writer** 写 `room:{code}:cardcount`。
⇒ 该分支从「**不可达**」变成「**可达但恒空**」，`cardCount` **仍然不会出现**。
**怎么改的**：① 在本文件与台账 N31 行**更正**该断言；② **新登记 N35**（谁维护这个计数 / 或删掉这个字段，待裁）；
③ **R451 要求的 grep 复核仍然做了且结论是「0 处需要改」**（`slice-07-match-join.ts:77` 本就同时接受两种字段集、
`message.router.test.ts:319-320` 是正向用例、其余命中是 `PlayerView.cardCounts`）——
⇒ **本片对 conformance 是零影响**（另核对：无断言把匹配后的房间状态钉成 `waiting`）。

### R458 **`startGame` 吞掉 RPC 失败 ⇒ R452 的理由不成立；登记 N36**

**R452 里的理由**（我写的）：「不得放到 `startGame` 之前，否则 RPC 失败时房间会停在 `playing`」。
**事实是什么**：`match.service.ts` 的 `startGame` 的 `catch` **只 `logger.error` 不重抛**
（R210 有单测钉住「两次都失败也不抛」）⇒ **放前放后都一样**：`game.start` 两次都失败时 `playing` 照样被写入。
**裁决**：R452 的**结论（两个唯一写入点）不变**，但其**理由更正**；**新登记 N36** ——
并且 agent 的旁证更硬：既有用例标题声称「§4.3：失败 ⇒ 房间 `cancelled` + 通知玩家」（`match.service.test.ts:694`）
**却只断言重试次数** ⇒ §4.3 对 `game.start` 的降级**在实现里不存在**（判据是假的）。
**收掉它要让 `startGame` 返回成败**（改语义）⇒ 不在本片。

### R459 **前端的四处落地口径（追认）**

1. **计划骨架里的 `this.options.onNotice` 在 `net/socket.ts` 不存在**（agent 实测 `grep -n "onNotice" apps/client/src/net/socket.ts` **0 命中**，exit=1）
   ⇒ 落地取「socket 发**链路事实信号** → **会话层**经既有唯一 notice 通道写出」（与 R166 的 `server_rejected` 同形）。
   **追认**：**不得**在 net 层另加第二条 notice 通路（R455 的原意就是「复用既有机制」）。
2. **info 级「连接已恢复」是计划没写但必要的一半**（否则红条恒留）。**接受**；文案单点在 `net/session.ts` 的
   `CONNECT_UNAVAILABLE_TEXT` / `CONNECT_RECOVERED_TEXT`。
3. **`connect_error` 不得复用 `emitReconnect`**（会被重连去抖窗口的 pending 补发重写，并触发 `navigate('table')`）
   ⇒ 落地为**独立的一次性电平守卫**（非定时器：**每断线周期只回调一次**）。**追认**。
4. **R455「不被后续 notice 覆盖」的最终口径**：**同周期只写一次** + **恢复即撤下** + **后到的确定答复仍可覆盖**
   （既有「后写覆盖」口径；R16/N1 的 `13010` 用例证明它不被 `snapshot_unavailable` 盖掉）。
   **不做**「链路不可用期间一律不许覆盖」的**粘性**版本：那要把 `useGameSession.ts` 的 4 处直写 `notice.value`
   收口成单一写入函数（另一处重构），而链路不可用时**不会有** inbound/ack 信号 ⇒ 该守卫**当前不可达**，
   会变成**测不到的死代码**（本仓最忌的形态）。⇒ 现在做它是负价值。

### R460 **`room.join` 不退出匹配队列 ⇒ 新登记 N34**（前端 agent 发现，本片未修）

**事实**：`message.router.ts` 的 `room.join` 既不取消队列也不清 `match:pending`（只有 `room.leave` 清，`:235`/`:244`）。
⇒ 「正在匹配…」时点新建的「创建房间」，服务端仍持有队列/票据 ⇒ 之后可能推 `room.matched {另一个房间}`。
**裁决**：**新登记 N34**（本片不修）。⚠️ **倾向的修法是服务端兜底**（`room.join` 清票），
理由与 R418 同族：进房有两条入口（自动/手动）——**复位/清票写在唯一共同写入处，才不会有漏网的入口**。

### R461 计划的两处小误与一处脆弱性（记录）

1. **`createAndJoin()` 在 `busy=true` 时调 `join()` 会被互斥静默早退**（房间建好了、人没进去）
   ⇒ 落地改为**先释放 `busy` 再 `join(roomCode)`**（两行之间无 `await`，无插队窗口）。**追认**。
2. **`authedRequest(method, path, body)` 没有 `init` 形参** ⇒ 按既有签名传对象（**不得**为它另造第二个封装）。
3. **脆弱性**：`apps/client/test/game-store-session-reset.test.ts:86` 的源码级断言钉着 `store.setRoom(code,` 这个**字面量**
   （P9 我自己写的）⇒ 改名局部变量就会红。agent 为它保留了局部变量名 `code`（**保住了既有判据**，处理正确）。
   ⚠️ 遗留：该断言**钉字面量**而不是钉语义（「lobby 必须经 `setRoom` 进房」），下次改名前应先把它改成语义断言。

### R462 **R456 的连带后果 ② 是错的 ⇒ 健康端点必须豁免 IP 维度**（协调者门禁跑出来的真回归）

**R456 我怎么写的**（追认 agent 的落地时）：「② 公开路径从此也 **fail-closed**（Redis 故障 ⇒ `503`），新增判据钉住」。
**事实是什么**（我重建镜像后跑 13 条 conformance 的**实测**）：**`slice-07.2-deploy` 红**——
它的一致性构造是「一次性容器 + `REDIS_URL=redis://127.0.0.1:6399`（无监听）」再请求 `GET /api/health/live`：

```
❌ slice-07.2-deploy 失败：一次性容器 30s 内没有在 http://localhost:3999 提供存活面（容器日志尾部：
[ioredis] Unhandled error event: Error: connect ECONNREFUSED 127.0.0.1:6399 …）
```

**根因**：维度 5 的 IP 判定被放在「没有 userId 就放行」的早退**之前**，而那条早退此前**同时**承担了
「**公开路径（含 `/api/health/live`）不进 Redis**」这件事 ⇒ 现在存活面**查依赖**了。
这**违反 `design.md` §2.4 / R267 / R285 逐字**：「`GET /api/health/live` = 存活（**不查依赖、恒 200**）」。
⚠️ 后果**不只是那条 conformance**：编排层的 **liveness 探针会在 Redis 抖动时把一个健康的进程判死并重启它**
—— 这正是存活面存在的意义被反过来用。
⇒ **R456 的 ①③ 仍然成立**（IP 判定确实要在**未认证早退之前**，否则 N13 不可达）；
**只有 ② 错**：健康端点必须从 IP 维度里**豁免**出去。
**修法（已派回原 agent）**：把 `JwtMiddleware` 的私有 `publicPaths`（`:72-78`，**恰五条**）提成可导出的模块常量，
按语义组合 `AUTH_PATHS(3) + HEALTH_PATHS(2) = PUBLIC_PATHS(5)`（**仍是 §7.1 的精确五条**，不得抄第二份字面量），
限流中间件的顺序改为 **`健康端点豁免 → 维度 5（IP）→ 维度 2（单用户）`**；
并新增**两条**判据：`/api/health/live` 在 Redis **抛错**时仍 `200`（`next()` 被调用、**没有**写 503）+
**正对照** `auth/register` 在同一抛错替身下**必须** fail-closed（否则「豁免」会被写成「中间件整体失效」）。

**⇒ 本片最贵的一条教训（写给所有 agent）**：
**「追认一个 tradeoff」不等于「验证了它」。** agent 在汇报里把 ② 明确列为「连带后果，请一并追认」，
我**基于他们的摘要**就追认了 —— 而它实际上是一条**可观测的可用性回归**（存活面查依赖）。
**是门禁（13 条 conformance）跑出来的，不是评审出来的。**
⇒ 规矩：**凡是「顺带改变某个既有性质」的落地，追认前必须由协调者自己跑一遍会覆盖该性质的门禁**；
汇报里的「请追认」是**提问**，不是**结论**。

**另一条实测结论（供门禁排期，非缺陷）**：agent 提示的「IP 桶按源 IP 计 ⇒ 13 条切片可能累计超 120/min」**未发生**：
跑完 13 条的 `ratelimit:http-ip:*` 读数只有 `::ffff:127.0.0.1 zcard=6` 与 `::ffff:172.19.0.1`（容器网桥），
日志里唯一的 `10006` 是 **WS 并发连接维度**（`[ProxyGateway] Rejecting WS handshake … too many connections from this IP`，
即 N15 的预期行为）⇒ **门禁不需要新增「清 IP 桶」步骤**。

### R462 的修复与**复核**（协调者自己跑的门禁）

```bash
pnpm exec turbo run build --force                 # ✅ 10/10，0 cached
pnpm exec turbo run test lint --force             # ✅ 29/29，0 cached
pnpm --filter @fight-the-landlord/api-gateway test   # ✅ 149 passed（145 → +4：R462①/①′/② + 装配闸 +1）
DOCKER_BUILDKIT=0 docker compose build api-gateway && docker compose up -d api-gateway   # ✅ healthy
for s in slice-07.2-deploy slice-07.2-hardening slice-07.2-boundary slice-07.2-security \
         slice-07.2-rpc slice-11 slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ **13/13 全绿**：deploy **104**（← 修前红的就是它）· hardening 103 · boundary 82 · security 40
#    · rpc 65 · slice-11 50 · 07.1 28 · 07 39 · 10 185 · 09 160 · 08 55 · 06 254 · 05 29
#    ⇒ 断言合计 **1194**
node scripts/ledger-counts.mjs                    # ✅ §0 与 §1.x 逐区一致（89：84/1/4）
```

**修前 RED（agent 在自己包里的实测原文，与我的容器级现象同源）**：
```
× R462①：`/api/health/live` 在 Redis 不可用时**仍放行**且一次 Redis 都不打
  → expected [ { status: 503, body: {…} } ] to deeply equal []
+   "body": { "code": 10007, "data": null, "message": "rate limit store unavailable" }, "status": 503
```
**修后**：健康端点在任何 Redis 访问**之前** `next()`（且 `next()` 仍在 `try` 之外）；
未认证 `auth/*` **仍**被 IP 维度覆盖（`/api/auth/register` 第 121 次 `429 + 10006` 有判据钉住）。

### 本轮额外收益（agent 顺手修掉的两个**静默假绿**）

1. `container-assembly.gate.test.ts` 原先从 `jwt.middleware.ts` 的**私有** `publicPaths` 里用正则抠字面量数组
   —— 白名单一搬家它就会**抛错**（fail-loud，没静默变绿；这点做得对）。已改为从新真源分别抠
   `AUTH_PATHS` / `HEALTH_PATHS` 再组合，两条不变式一字未改，并**新增**「源码字面量 ↔ 运行期 `PUBLIC_PATHS`」
   交叉验证 + 恰好 **5/3/2** 条。
2. ⚠️ **真发现**：`AUTH_PATHS` 是 `HEALTH_PATHS` 的**后缀**，而原正则 `IDENT\s*=\s*\[` **没有前缀边界**
   ⇒ 只要 `HEALTH_PATHS` 定义在前，解析 `AUTH_PATHS` 就会命中 HEALTH 那段、拿到**另一个数组**而**闸全绿**。
   已加 `(?:^|[^A-Za-z0-9_])` 边界 + **判别力自证**（把 HEALTH 写在前面仍各自解析正确）+
   近邻**精确匹配**负对照（`/api/healthz`・`/api/health/livex`・`/api/auth/login-as-admin`）。
   ⇒ 与本仓「同一事实的两个标识符名互为后缀」这一族**判据假绿**同源，值得写进 briefs。

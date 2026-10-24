# 断线恢复「对局存活即可回」实施计划 v1.3（三轮审闭环：设计→规格→计划；已实施收口 2026-10-12）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「断线后只要对局未结束就能重连回桌」的设计（v1.3.1 冻结）与规格（v1.1 冻结）落到 room-service + 一处客户端守卫 + 判据/文档。

**Architecture:** 凭据解析统一为 `ReconnectService.resolveRecoverableRoom`（存活谓词，`[pending → 哈希]` 择优），四处消费方（`handleReconnect`/补推 `replayActiveGame`/`handleResync`/`forwardAction`）共用；`startRoom` 开局为人类座位补写哈希；30s 窗口/35s TTL/时钟注入整体退役；客户端只加「快照类请求自身失败不再触发 resync」的自激守卫。

**Tech Stack:** NestJS + ioredis（room-service）、Vitest、uni-app/Vue3（客户端）、自建 conformance harness（真栈 docker）。

## Global Constraints

- 唯一语义来源：`docs/superpowers/specs/2026-10-12-reconnect-until-game-end-design.md`（v1.3.1 冻结）与 `…-spec.md`（v1.1 冻结）。冲突时以两者为准并停下问协调者，不得自行发明语义。
- 用户三裁（K1/K2/K3）：① 窗口全面放开；② 结束态冷启动静默（同页保留现状提示）；③ 客户端改动仅自激守卫。
- 客户端 `apps/client/src` 只准改 `net/socket.ts`（守卫含其辅助只准住该文件）；`apps/client/test` 可改。
- `match:pending` 的写入/清票逻辑逐字不动；不发新错误码、`CLIENT_ACTION` 表不动；不引入任何延时/时序 hack。
- 每个任务：先写失败测试 → 跑红 → 实现 → 跑绿 → commit。commit message 结尾必须是：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 命令（仓库根执行）：
  - room-service 测试：`pnpm --filter @fight-the-landlord/room-service test`
  - room-service 类型/lint：`pnpm --filter @fight-the-landlord/room-service lint`
  - 客户端测试：`pnpm --filter @fight-the-landlord/client test`；客户端类型：`pnpm --filter @fight-the-landlord/client lint`
  - 单文件跑：在上述 test 命令后加 ` -- test/<file>`（vitest run 参数）
- 行号引用以开工时的文件为准；行号漂移属正常，按**内容**定位。

---

### Task 1: ReconnectService —— 新增 `resolveRecoverableRoom`（存活谓词 resolver）

**Files:**
- Modify: `packages/room-service/src/reconnect/reconnect.service.ts`
- Test: `packages/room-service/test/reconnect.service.test.ts`

**Interfaces:**
- Consumes: `matchPendingKey`（`packages/room-service/src/match/match-keys.ts`，零依赖叶子）。
- Produces（后续任务全部依赖）：
  ```ts
  export interface RecoverableRoom { roomCode: string; source: 'ticket' | 'record'; status: string }
  // 方法（公开）：
  resolveRecoverableRoom(playerId: string): Promise<RecoverableRoom | null>
  ```
  语义（规格 §2.2）：候选 `[match:pending → reconnect:active]`；第一遍取首个 `room:{code}.status ∈ {waiting,playing}`；第二遍取首个 `status !== null`（房间键存在）；都没有 ⇒ `null`。损坏（JSON 解析失败/字段缺失/WRONGTYPE）⇒ 候选跳过（WRONGTYPE 记 WARN）；连接级读失败 ⇒ 上抛。

- [ ] **Step 1: 写失败测试**

在 `reconnect.service.test.ts` 文件末尾（`describe('ReconnectService')` 内部）追加新 describe（**顶部 import 区追加 `import { Logger } from '@nestjs/common'` 与非空的 `vi` 导入——不得把 import 留在 describe 旁**）：

```ts
describe('resolveRecoverableRoom（规格 v1.1 §2.2：存活谓词）', () => {
  const seedRoom = (r: FakeRedis, code: string, status: string) =>
    r.hset(`room:${code}`, 'status', status);

  it('无任何凭据 → null', async () => {
    expect(await service.resolveRecoverableRoom('alice')).toBeNull();
  });

  it('双候选同时存活 ⇒ pending 优先（最新开局结果）', async () => {
    await redis.hset('match:pending:alice', 'roomCode', 'ROOM-B');
    await service.touch('alice', 'sock-1', 'ROOM-A');
    await seedRoom(redis, 'ROOM-A', 'playing');
    await seedRoom(redis, 'ROOM-B', 'playing');

    expect(await service.resolveRecoverableRoom('alice')).toEqual({
      roomCode: 'ROOM-B', source: 'ticket', status: 'playing',
    });
  });

  it('pending 指向已死房 ⇒ 回退存活哈希（一轮审查阻断项的单测回归）', async () => {
    await redis.hset('match:pending:alice', 'roomCode', 'DEAD');
    await service.touch('alice', 'sock-1', 'ROOM-A');
    await seedRoom(redis, 'ROOM-A', 'playing');
    // 刻意不铺 DEAD 的房间键

    expect(await service.resolveRecoverableRoom('alice')).toEqual({
      roomCode: 'ROOM-A', source: 'record', status: 'playing',
    });
  });

  it('都不存活但房间键在 ⇒ 第二遍返回（供 13005/13009 映射）', async () => {
    await service.touch('alice', 'sock-1', 'ROOM-A');
    await seedRoom(redis, 'ROOM-A', 'finished');

    expect(await service.resolveRecoverableRoom('alice')).toEqual({
      roomCode: 'ROOM-A', source: 'record', status: 'finished',
    });
  });

  it('损坏记录（JSON 解析失败）按缺席跳过，不阻断其它候选', async () => {
    await redis.hset(RECONNECT_HASH_KEY, 'alice', 'not-json');
    await redis.hset('match:pending:alice', 'roomCode', 'ROOM-B');
    await seedRoom(redis, 'ROOM-B', 'waiting');

    expect((await service.resolveRecoverableRoom('alice'))!.roomCode).toBe('ROOM-B');
  });

  it('毒键（WRONGTYPE）按缺席跳过并记 WARN（不得上抛）', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // ⚠️ 播种用直 hset（不得先调 service.touch —— 它自己会读一次 hget，把 once 拒绝吃掉）
    await redis.hset(
      RECONNECT_HASH_KEY,
      'alice',
      JSON.stringify({ socketId: 's', roomCode: 'ROOM-A', connectedAt: 0 }),
    );
    await seedRoom(redis, 'ROOM-A', 'playing');
    // 下一次 hget = resolver 的 ticket 读取 ⇒ 毒键被跳过 ⇒ 走 record 候选
    (redis.hget as any).mockRejectedValueOnce(
      new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
    );

    expect(await service.resolveRecoverableRoom('alice')).toEqual({
      roomCode: 'ROOM-A', source: 'record', status: 'playing',
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('record 候选毒键（reconnect:active 键整体 WRONGTYPE）⇒ 按缺席跳过，不阻断 ticket 候选', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await redis.hset('match:pending:alice', 'roomCode', 'ROOM-B');
    await seedRoom(redis, 'ROOM-B', 'waiting');
    // 调用序：① ticket 读取（正常）⇒ ② record 读取（毒键）—— 用 once 链精确命中第 2 次
    const realHget = (redis.hget as any).getMockImplementation()!;
    (redis.hget as any)
      .mockImplementationOnce(realHget)
      .mockRejectedValueOnce(
        new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
      );

    expect(await service.resolveRecoverableRoom('alice')).toEqual({
      roomCode: 'ROOM-B', source: 'ticket', status: 'waiting',
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('双候选都指向已死房（无房间键）⇒ null（第二遍也无线索）', async () => {
    await redis.hset('match:pending:alice', 'roomCode', 'DEAD-1');
    await redis.hset(
      RECONNECT_HASH_KEY,
      'alice',
      JSON.stringify({ socketId: 's', roomCode: 'DEAD-2', connectedAt: 0 }),
    );

    expect(await service.resolveRecoverableRoom('alice')).toBeNull();
  });

  it('连接级读失败（非 WRONGTYPE）⇒ 上抛（不得静默跳过存活候选）', async () => {
    await service.touch('alice', 'sock-1', 'ROOM-A');
    await seedRoom(redis, 'ROOM-A', 'playing');
    (redis.hget as any).mockRejectedValueOnce(new Error('Connection is closed.'));

    await expect(service.resolveRecoverableRoom('alice')).rejects.toThrow('Connection is closed.');
  });

  it('房间键在但 status 字段缺失（坏 meta）⇒ 按不存在处理', async () => {
    await service.touch('alice', 'sock-1', 'ROOM-A');
    await redis.hset('room:ROOM-A', 'other', 'x'); // 键在、无 status

    expect(await service.resolveRecoverableRoom('alice')).toBeNull();
  });
});
```

（文件顶部补 `import { vi } from 'vitest'` 若缺；`RECONNECT_HASH_KEY`、`FakeRedis` 已有导入。）

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/room-service test -- test/reconnect.service.test.ts`
Expected: FAIL —— `service.resolveRecoverableRoom is not a function`。

- [ ] **Step 3: 实现**

`reconnect.service.ts`：

a) 顶部新增导入与类型/常量：

```ts
import { matchPendingKey } from '../match/match-keys';

/** 规格 §2.2：凭据解析命中结果。`status` 命中时必为非空串。 */
export interface RecoverableRoom {
  roomCode: string;
  source: 'ticket' | 'record';
  status: string;
}

/** 存活谓词（§3.1）：这两个房态下「对局未结束」。 */
const ALIVE_ROOM_STATUSES: ReadonlySet<string> = new Set(['waiting', 'playing']);

/** 毒键（WRONGTYPE）判定 —— 数据形状损坏，与「连接级读失败」必须分开（规格 §0.3-2）。 */
function isWrongTypeError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('WRONGTYPE');
}
```

b) 在类中新增（`readRecord` 上方）：

```ts
/**
 * 读一个 Hash 字段，带毒键处置：WRONGTYPE（键类型损坏）⇒ `null`（按缺席，记 WARN）；
 * **连接级读失败（其余任何 ioredis 错误）⇒ 上抛** —— 沿用各调用方既有失败方向，
 * 绝不允许「Redis 抖一下就把存活候选降级成缺席」（规格 v1.1 §0.3-2）。
 */
private async safeHget(key: string, field: string): Promise<string | null> {
  try {
    return await this.redis.hget(key, field);
  } catch (err) {
    if (isWrongTypeError(err)) {
      this.logger.warn(`Corrupt Redis key ${key} (WRONGTYPE) — candidate skipped`);
      return null;
    }
    throw err;
  }
}

/**
 * 凭据解析（规格 v1.1 §2.2 的单一实现；`handleReconnect` / 补推 / `handleResync` /
 * `forwardAction` 四处共用——全仓不得有第二份「哈希+pending 择优」读取）：
 *  候选 `[match:pending → reconnect:active]`（pending 天然无陈旧：每局新写、TTL 300s、
 *  join/leave 即清）；第一遍按**存活谓词**（`room.status ∈ {waiting, playing}`）取首个；
 *  都不存活 ⇒ 第二遍取首个「房间键存在」（`status !== null`）者；都没有 ⇒ `null`。
 */
async resolveRecoverableRoom(playerId: string): Promise<RecoverableRoom | null> {
  const candidates: Array<{ source: 'ticket' | 'record'; roomCode: string }> = [];

  const ticketRoom = await this.safeHget(matchPendingKey(playerId), 'roomCode');
  if (ticketRoom) candidates.push({ source: 'ticket', roomCode: ticketRoom });
  const record = await this.readRecord(playerId);
  if (record) candidates.push({ source: 'record', roomCode: record.roomCode });

  let firstExisting: RecoverableRoom | null = null;
  for (const cand of candidates) {
    const status = await this.safeHget(`room:${cand.roomCode}`, 'status');
    if (status === null) continue; // 键不存在 / status 缺失（坏 meta）⇒ 按不存在（规格 §2.2）
    if (ALIVE_ROOM_STATUSES.has(status)) return { ...cand, status };
    firstExisting ??= { ...cand, status };
  }
  return firstExisting;
}
```

c) `readRecord` 改经 `safeHget` 读取并静默损坏：

```ts
private async readRecord(playerId: string): Promise<ReconnectRecord | null> {
  // record 候选的 WRONGTYPE 与 ticket 同待遇（规格 §0.3-2「候选损坏按缺席」，对称）；
  // 连接级错误仍由 safeHget 上抛。
  const raw = await this.safeHget(RECONNECT_HASH_KEY, playerId);
  if (!raw) return null;
  try {
    /* …解析同现状… */
  } catch {
    return null; // 解析失败 ⇒ 按缺席（旧实现此处 error 日志删除：规格 §2.2「不打日志噪声」）
  }
}
```

注意 `touch()` 复用 `readRecord` 做 roomCode 缺省：哈希毒键 ⇒ 视作「无既有记录」（显式 roomCode 仍走 `hset`；若该键真被毒占，`hset` 自身的 WRONGTYPE 照常上抛——保持既有错误形态，不新增处置）。

- [ ] **Step 4: 跑绿（本文件 + 全包）**

Run: `pnpm --filter @fight-the-landlord/room-service test -- test/reconnect.service.test.ts`
Expected: PASS（新 describe 全绿，原 13 条用例不受影响）。

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS（无回归——本任务未改任何既有行为）。

- [ ] **Step 5: Commit**

```bash
git add packages/room-service/src/reconnect/reconnect.service.ts packages/room-service/test/reconnect.service.test.ts
git commit -m "feat(reconnect): ReconnectService.resolveRecoverableRoom 存活谓词 resolver（规格 §2.2）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `message.router` 四处收编 + `game.reconnect` 四步判定

**Files:**
- Modify: `packages/room-service/src/gateway/message.router.ts`（`handleReconnect` ~652-711、`handleResync` ~733-740、`forwardAction` ~750-762、删 `findActiveRoom` ~768-779）
- Test: `packages/room-service/test/message.router.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveRecoverableRoom`（经 `deps.reconnect`）。
- Produces: `handleReconnect` 四步（返回码 13010/13005/13009/0 的判定面变化）；`handleResync`/`forwardAction` 以 resolver 定位房间；`findActiveRoom` 从代码库消失（Task 7 机械闸钉住）。

- [ ] **Step 1: 失败测试 —— 先改夹具与既有用例，再补新用例**

`message.router.test.ts`：

a) `makeDeps()` 的 `reconnect` 替身（~166-175）：把 `validateReconnect` 换成

```ts
const reconnect = {
  resolveRecoverableRoom: vi.fn().mockResolvedValue(null),
  touch: vi.fn().mockResolvedValue(null),
  clearConnection: vi.fn(async (playerId: string) => {
    await redis.hdel(RECONNECT_HASH_KEY, playerId);
    await redis.del(reconnectKey(playerId));
  }),
};
```

b) `game.reconnect` describe（~1318-1405）整体改写为四步语义：

```ts
// ─── game.reconnect（规格 v1.1 §2.3 的四步判定）─────────────────────

// ✅ 先在 `roomInfo`（~:255）旁**加一行定义**（按此逐字落码，勿留成注释），供全文件共用：
const hit = (roomCode = 'ROOM1', source: 'ticket' | 'record' = 'record', status = 'playing') =>
  ({ roomCode, source, status });

it('① resolver 无命中 → 13010（**不是** 12001），且不取 view', async () => {
  const { deps, game } = makeDeps();
  const ack = await route(deps, makeSocket('alice'), C('game.reconnect', { lastVersion: 1 }));

  expect(ack.code).toBe(13010);
  expect(ack.code).not.toBe(12001);
  expect(game.view).not.toHaveBeenCalled();
});

it('① resolver 经 pending 命中 → 按它取快照（code 0）', async () => {
  const { deps, game, reconnect, reconnected } = makeDeps();
  reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM2', 'ticket'));
  game.view.mockResolvedValue({ roomCode: 'ROOM2', seat: 1, state: 'playing', version: 3 });

  const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

  expect(ack.code).toBe(0);
  expect(game.view).toHaveBeenCalledWith('ROOM2', 'alice');
  expect(ack.data).toMatchObject({ roomCode: 'ROOM2', seat: 1, version: 3 });
  expect(reconnected).toHaveLength(1);
});

it('C6 单测：陈旧哈希（死房）+ 存活新局（pending）⇒ 拉回**新局**（阻断项回归）', async () => {
  // 真实 resolver 必须构建在 makeDeps 内部的**同一**假 redis 上：先建 redis，再经 over 注入
  const shared = makeRedis();
  await shared.hset(
    RECONNECT_HASH_KEY,
    'alice',
    JSON.stringify({ socketId: 's', roomCode: 'DEAD', connectedAt: Date.now() }),
  );
  await shared.hset('match:pending:alice', 'roomCode', 'ROOM2');
  await shared.hset('room:ROOM2', 'status', 'playing');
  const { deps, game } = makeDeps({
    redis: shared as unknown as Redis,
    reconnect: new ReconnectService(shared as unknown as Redis) as unknown as ReconnectService,
  });
  game.view.mockResolvedValue({ roomCode: 'ROOM2', seat: 1, state: 'playing', version: 3 });

  const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

  expect(ack.code).toBe(0);
  expect(game.view).toHaveBeenCalledWith('ROOM2', 'alice');
});

it('② 命中但 view 为 ended → 13005，不恢复投递', async () => {
  const { deps, game, reconnect, reconnected } = makeDeps();
  reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
  game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, state: 'ended', version: 22 });

  const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

  expect(ack.code).toBe(13005);
  expect(reconnected).toHaveLength(0);
});

it('③ 命中 + view 拿不到 + 房间键在 → 13009（可重试）', async () => {
  const { deps, game, reconnect, rooms } = makeDeps();
  reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
  game.view.mockResolvedValue(null);
  rooms.findOne.mockResolvedValue(roomInfo('ROOM1'));

  expect((await route(deps, makeSocket('alice'), C('game.reconnect', {}))).code).toBe(13009);
});

it('④ 命中 + view 拿不到 + 房间键不存在 → 13010', async () => {
  const { deps, game, reconnect } = makeDeps();
  reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
  game.view.mockResolvedValue(null);

  expect((await route(deps, makeSocket('alice'), C('game.reconnect', {}))).code).toBe(13010);
});

it('⑤ 其余 → code 0 + 当前版本快照 + touch + 恢复投递（§6.6.1 时机 2）', async () => {
  const { deps, game, reconnect, reconnected } = makeDeps();
  reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
  game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 2, state: 'playing', version: 41 });

  const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

  expect(ack.code).toBe(0);
  expect(ack.data).toMatchObject({ roomCode: 'ROOM1', seat: 2, version: 41 });
  expect(reconnect.touch).toHaveBeenCalledWith('alice', expect.anything(), 'ROOM1');
  expect(reconnected).toHaveLength(1);
});
```

**删除**旧用例：「② 有字段但独立键消失/超窗 → 13010…」（窗口概念已废）；「① 哈希无字段但 match:pending 在 → 回退并用它取快照」（已被`① resolver 经 pending 命中`取代）；`seedRecord` 辅助函数（不再有直接播种哈希的用例，除非 Step 3-c 用）。

c) **连锁修正（替身驱动，不靠 redis 播种——resolver 已是替身，播种对路由无影响）**：以下 6 条正例在 `makeDeps()` 解构处加 `reconnect`，并在用例内加一行 `reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));`：

- `:275-283`（identity 只认 socket.data）
- `:299-308`、`:310-317`（playerId 正对照 ×2）
- `:1276-1284`（bid baseVersion 转发）
- `:1288-1300`（play 转发）
- `:1302-1310`（play 下游 13004 透传）

各用例原有的 `await redis.hset('reconnect:active', …)` 播种行**删除**（不再承载路由语义，留着会误导下一个人；删前确认该行没有别的断言依赖）。负例（`:288-297` 期待 12003、`:1312-1316` 期待 12004）**不改**。

d) **收底（grep 驱动，必须做完再跑 Step 2）**：

- `grep -n "validateReconnect\|seedRecord" packages/room-service/test/message.router.test.ts` ⇒ 改完必须 **0 命中**（`seedRecord` 辅助随旧用例删除；替身不再有 `validateReconnect`）。
- 凡经 `handleResync` / `forwardAction` 走路由的用例，一律以 `reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOMn'))`（或 over 注入真实 resolver）驱动。
- **点名 8 条**（v1.1 首版清单漏列，全部会被本任务打破）：
  - **(A) 连接 describe 内、旧⑤之后的四条**（均引用 `seedRecord`/`validateReconnect` ⇒ 不换必 TypeError；引用点 `:1423/:1433/:1445/:1455`）：`:1418-1428`（⑤ 日志留痕 lastVersion）、`:1430-1440`（下游 ROOM_NOT_FOUND → 13010）、`:1442-1450`（下游 12004 → 13010）、`:1452-1460`（真·下游故障 10007 如实上抛）——把 `seedRecord(...)` + `validateReconnect.mockResolvedValue(...)` 换成 `reconnect.resolveRecoverableRoom.mockResolvedValue(hit())`；**翻译语义逐字保留**（`isMissingGameError` 翻译是规格 §2.3 明令保留项）。
  - **(B) resync/传输家族四条**：`:1462-1472`（game.resync returns snapshot，期望 0——加 resolver 命中驱动）、`:1474-1481`（game.resync falls back to match:pending——**该语义现由 resolver 承担**：本用例本就播种了 pending，改用**真实 resolver**（复用 C6 的 shared-redis 接线）驱动，断言改为 code 0 + `roomCode === 'ROOM2'`）、`:1489-1501`（§6.5 唯一恢复通道——加 resolver 命中驱动，并**删除** `validateReconnect).not.toHaveBeenCalled()` 断言）、`:1610-1627`（传输层故障 10007——加 resolver 命中驱动，使其能走到 `game.view`）。

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/room-service test -- test/message.router.test.ts`
Expected: FAIL —— 旧实现里 `resolveRecoverableRoom` 未被调用、13010/13005/13009 分支与改写用例不符。

- [ ] **Step 3: 实现（`message.router.ts`）**

a) `handleReconnect`（~652-711）整体替换为：

```ts
/**
 * `game.reconnect`：断线恢复（规格 v1.1 §2.3 的**四步判定**）。
 *  ① `resolveRecoverableRoom` 无命中 ⇒ `13010`（无任何可恢复凭据）；
 *  ② 命中但 view 为 `ended` ⇒ `13005`；③ view 拿不到 + 房间键在 ⇒ `13009`；
 *  ④ 其余 ⇒ ack 快照 + 投递链路恢复（先 touch + 恢复、再回 ack，逐字保留）。
 * 窗口（30s / 独立键 / 时钟）已整体退役（用户裁决 K1）。
 */
async function handleReconnect(
  socket: Socket,
  deps: RouterDeps,
  userId: string,
  lastVersion: number | undefined,
): Promise<Ack> {
  const resolved = await deps.reconnect.resolveRecoverableRoom(userId);
  if (!resolved) {
    deps.logger.log(
      `Reconnect rejected for ${userId}: no recoverable credentials (lastVersion=${String(lastVersion)})`,
    );
    return fail(ErrCode.RECONNECT_RECORD_MISSING, 'No recoverable game to reconnect to');
  }
  const roomCode = resolved.roomCode;
  deps.logger.log(
    `Reconnect attempt for ${userId} in room ${roomCode} (source=${resolved.source}, status=${resolved.status}, lastVersion=${String(lastVersion)})`,
  );

  let view: PlayerView | null;
  try {
    view = (await deps.game.view(roomCode, userId)) as PlayerView | null;
  } catch (err) {
    if (!isMissingGameError(err)) throw err; // 真·下游故障（如 10007）原样上抛
    view = null;
  }

  if (view && view.state === 'ended') return fail(ErrCode.GAME_OVER, 'Game is over');
  if (view) {
    await deps.reconnect.touch(userId, socket.id, roomCode);
    await deps.onReconnected?.(socket, view);
    return ok(view);
  }

  const room = await deps.rooms.findOne(roomCode);
  if (room) return fail(ErrCode.GAME_NOT_STARTED, 'Game has not started yet');
  return fail(ErrCode.RECONNECT_RECORD_MISSING, 'No recoverable game to reconnect to');
}
```

b) `handleResync`（~733-740）与 `forwardAction`（~750-762）首行改为：

```ts
const resolved = await deps.reconnect.resolveRecoverableRoom(userId);
if (!resolved) return fail(ErrCode.NOT_IN_ROOM, 'You are not in an active game');
const roomCode = resolved.roomCode;
```

c) **删除** `findActiveRoom` 函数（~764-779）及 `message.router.ts` 顶部不再使用的 `RECONNECT_HASH_KEY` 导入（~26）。`matchPendingKey` 导入**保留**（handleJoin/handleLeave 仍用）。

> 说明（C6 用例接线）：`makeDeps(over: Partial<RouterDeps>)` 的 over 覆盖 deps 字段——C6 用「先建 `makeRedis()`、经 over 把**同一实例**注入 `redis` 与真实 `ReconnectService`」的写法；若实况里 over 的应用位置不自洽（`reconnect` 没被覆盖），改为构造后就地赋 `deps.redis`/`deps.reconnect`——目标是两者指向**同一假 redis**。测试里构造真实 service 时**不注时钟**（已退役）。

- [ ] **Step 4: 跑绿**

Run: `pnpm --filter @fight-the-landlord/room-service test -- test/message.router.test.ts`
Expected: PASS。

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS（其他文件此时仍用旧 service（validateReconnect 还在），全绿）。

- [ ] **Step 5: Commit**

```bash
git add packages/room-service/src/gateway/message.router.ts packages/room-service/test/message.router.test.ts
git commit -m "feat(reconnect): game.reconnect 四步判定 + 四处收编 resolver（规格 §2.3）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `ws.gateway` —— 连接补推泛化 `replayActiveGame` + 记录刷新改名

**Files:**
- Modify: `packages/room-service/src/gateway/ws.gateway.ts`（`replayPendingMatch` ~393-469、`refreshReconnectWindow` ~515-532 与其两处调用 ~386/~512）
- Test: `packages/room-service/test/ws.gateway.test.ts`（补推块 ~556-709、`:501-519` 用例）

**Interfaces:**
- Consumes: Task 1 resolver（经 `this.reconnectService`）、已注入的 `this.roomsService`（**已存在，无需改 DI**）、`envelope()`（文件内既有）。
- Produces: `replayActiveGame(userId, socket)`；成功日志逐字 `Game resumption pushed for {userId} → {roomCode}@{seat} (status=…, source=…)`；`refreshReconnectWindow` → `touchReconnectRecord`（日志「Reconnect record refreshed」，WARN 行 `Match hand-off replay…` 前缀**保留**）。

- [ ] **Step 1: 失败测试**

`ws.gateway.test.ts`：

a) 补推 describe（~556）：**其 reconnect 替身（文件顶 `ReconnectMock` ~:96-100 与 `makeGateway` 默认替身 ~:173-177）先接上 resolver**：加 `resolveRecoverableRoom: vi.fn()`。此后驱动在**替身**上，不再靠 redis 播种：

- 每条「命中」用例首行：`ctx.reconnect.resolveRecoverableRoom.mockResolvedValue({ roomCode: 'ROOM1', source: 'ticket', status: 'waiting' | 'playing' })`（status 取该用例原意）；
- 所有命中用例补 `ctx.rooms.findOne.mockResolvedValue(含该玩家的 roomInfo)`（在册守卫的数据源）；
- 成功路径断言/日志串改为 `Game resumption pushed for`；
- 「**无凭据 ⇒ 不推**」一条：**删除 `redis.hget` 恰好 1 次的计数断言**（resolver 替身下它既无判别力也必红——读取面次数由 T1 单测覆盖），改断「零消息 + 零 WARN」并写一句理由注释；
- 逐条更新要点：waiting ⇒ 只 matched（seat 来自 `room.players`）；playing ⇒ 先 deal 后 matched + `seatOwners` 用 `view.seat`；finished/cancelled ⇒ resolver 返回对应 status 时**必须跳过**（第二遍候选的静默面）；view null + 在册 ⇒ WARN + 只 matched（WARN 保 `Match hand-off replay` 前缀）；Redis 读失败 ⇒ WARN + 不带崩连接（此条用 resolver 替身 `mockRejectedValueOnce` 构造）；硬换手 ⇒ 补推与续期都发生；被顶替 ⇒ 跳过（顶替校验两处保留）。

b) **新增 4 条**（驱动一律走替身 `mockResolvedValue` + `rooms.findOne` + `game.view`）：

```ts
it('record 源（票不存在、哈希存活）⇒ 仍补推（长离线/二次刷新场景）', async () => {
  // resolver → { roomCode: 'ROOM1', source: 'record', status: 'playing' }
  // rooms.findOne → 含 user-1；game.view → playing view
  // 断言：先 game.deal、后 room.matched、seatOwners 重登记、成功日志含 source=record
});

it('结束瞬间竞态（房态 playing + view.state==='ended'）⇒ 两支都不推', async () => {
  // resolver → status: 'playing'；game.view → { state: 'ended', ... }
  // 断言：无 game.deal、无 room.matched
});

it('玩家不在权威座位表（rooms.findOne 不含该人）⇒ 跳过', async () => {
  // resolver 命中 + rooms.findOne → players 为空
  // 断言：两条消息都不推
});

it('日志行逐字：Game resumption pushed for …（含 status/source）', async () => {
  // resolver 命中 playing 全链
  // 断言：成功行前缀（用本文件既有的日志捕获夹具）
});
```

c) 续期用例（~501-519）：用例名与断言里的 `Reconnect window refreshed` 改为 `Reconnect record refreshed`（行为不变）。

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/room-service test -- test/ws.gateway.test.ts`
Expected: FAIL —— 新用例红（方法未泛化）、日志串用例红（未改名）。

- [ ] **Step 3: 实现**

a) `replayPendingMatch`（~393-469）整体替换为（改名 + 泛化；保留原有的两条 `activeConnections` 顶替校验与整体 fail-open）：

```ts
/**
 * **连接补推**（规格 v1.1 §2.4）：连接建立时用 resolver（**只认存活候选**）把玩家
 * 拉回仍在进行的对局/等待中的房间。playing ⇒ 先视图后 matched（顺序不可反，v2.1）；
 * waiting ⇒ 只补 matched；结束瞬间竞态与不在册 ⇒ 静默；失败方向一律 fail-open。
 */
private async replayActiveGame(userId: string, socket: Socket): Promise<void> {
  try {
    const resolved = await this.reconnectService.resolveRecoverableRoom(userId);
    if (!resolved) return; // 无凭据（绝大多数连接如此）：静默，不刷日志
    const { roomCode, status, source } = resolved;
    if (status !== 'waiting' && status !== 'playing') return; // 第二遍的已死候选：不推

    // 权威座位表守卫（两支统一，R128）：解析不出座位 ⇒ 跳过（不推 room.matched 引 12004）
    const room = await this.roomsService.findOne(roomCode);
    const roomSeat = room?.players.find((p) => p.userId === userId)?.seat ?? -1;
    if (roomSeat < 0) return;

    if (this.activeConnections.get(userId) !== socket) return; // 顶替校验（原位置）

    let pushSeat = roomSeat;
    if (status === 'playing') {
      try {
        const view = await this.game.view(roomCode, userId);
        if (view === null) {
          this.logger.warn(`Match hand-off replay: no view for ${userId} in ${roomCode} (fail-open)`);
        } else if ((view as { state?: string }).state === 'ended') {
          return; // 结束瞬间竞态：视同结束，静默（规格 §2.4）
        } else {
          socket.emit('game.deal', envelope(view.version, view));
          pushSeat = view.seat;
        }
      } catch (err) {
        this.logger.warn(
          `Match hand-off replay view failed for ${userId} in ${roomCode}: ${String(err)}`,
        );
      }
      if (this.activeConnections.get(userId) !== socket) return; // fetch 期间被顶替
    }

    this.seatOwners.set(`${roomCode}:${pushSeat}`, userId);
    socket.emit('room.matched', envelope(0, { roomCode, seat: pushSeat }));
    this.logger.log(
      `Game resumption pushed for ${userId} → ${roomCode}@${pushSeat} (status=${status}, source=${source})`,
    );
  } catch (err) {
    this.logger.warn(`Match hand-off replay failed for ${userId}: ${String(err)}`);
  }
}
```

b) 调用点（~380）改名 `replayPendingMatch(` → `replayActiveGame(`；注释头按新语义更新（`match:pending` 字样 → resolver/存活候选）。

c) `refreshReconnectWindow`（~517）改名 `touchReconnectRecord`，日志串 `Reconnect window refreshed` → `Reconnect record refreshed`（`:526`），两处调用（~386 硬换手 / ~512 断线）同步改名；函数头注释「窗口起点」改为「在线观测点」。

d) `matchPendingKey` 在 `ws.gateway.ts` 若不再被引用（补推改造后）则删除其导入。

- [ ] **Step 4: 跑绿**

Run: `pnpm --filter @fight-the-landlord/room-service test -- test/ws.gateway.test.ts`
Expected: PASS。

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS（`:893-1071` 块此时仍绿——validateReconnect 尚存在；下个任务退役它）。

- [ ] **Step 5: Commit**

```bash
git add packages/room-service/src/gateway/ws.gateway.ts packages/room-service/test/ws.gateway.test.ts
git commit -m "feat(reconnect): 连接补推泛化为 replayActiveGame（resolver 源 + 座位守卫 + 改名）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 退役（service 简化）+ 存量测试块改写

**Files:**
- Modify: `packages/room-service/src/reconnect/reconnect.service.ts`
- Test: `packages/room-service/test/reconnect.service.test.ts`、`packages/room-service/test/ws.gateway.test.ts`（`:893-1071` 块）、`packages/room-service/test/message.router.test.ts`（mock 清理）

**Interfaces:**
- Produces: 删除 `RECONNECT_WINDOW_MS`、`RECONNECT_TTL_SECONDS`、`reconnectKey`、`validateReconnect`、`RECONNECT_CLOCK`；`touch()` 只写哈希；`clearConnection()` 只删哈希。`RECONNECT_HASH_KEY` 保留导出。

- [ ] **Step 1: 改写三个测试文件（先让它们与新契约对齐）**

a) `reconnect.service.test.ts` 整体重写文件级 describe（保留 Task 1 的新 describe）。**beforeEach 改为**：`vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); redis = createFakeRedis(); service = new ReconnectService(asRedis(redis));`（**不再注时钟**）；afterEach 补 `vi.useRealTimers()`。原 `now` 变量与 `connectedAt: now` 断言全部换成 `Date.now()`（假时钟下确定）；用例**中途推进时间**用 `vi.setSystemTime(Date.now() + 30_000)`（例：「每次 touch 刷 connectedAt」与 `ws.gateway.test.ts` `:980` 硬换手块，把原来的 `now = T0 + 25_000` 翻译成这一形态）。要点：

```ts
it('touch 只写哈希字段，不再写独立键（窗口退役）', async () => {
  await service.touch('alice', 'sock-1', 'ROOM1');

  const raw = await redis.hget(RECONNECT_HASH_KEY, 'alice');
  expect(JSON.parse(raw!)).toEqual({ socketId: 'sock-1', roomCode: 'ROOM1', connectedAt: Date.now() });
  expect(redis.set).not.toHaveBeenCalled();          // 独立键写入已退役
  expect(redis.ttls.has(RECONNECT_HASH_KEY)).toBe(false); // 哈希无 TTL
  expect(redis.expire).not.toHaveBeenCalled();       // 对不存在的键 expire 的旧形态不得回归
});

it('roomCode 缺省时沿用已有记录的房间', async () => { /* 原用例保留（断言去掉独立键部分） */ });
it('每次 touch 都把 connectedAt 刷成当前时刻（在线观测点刷新）', async () => { /* 原用例保留 */ });
it('既无 roomCode 也无既有记录时不写任何键', async () => { /* 原用例保留 */ });

it('clearConnection 只删哈希（显式离开）', async () => {
  await service.touch('alice', 'sock-1', 'ROOM1');
  await service.clearConnection('alice');

  expect(await redis.hget(RECONNECT_HASH_KEY, 'alice')).toBeNull();
  expect(redis.hdel).toHaveBeenCalledWith(RECONNECT_HASH_KEY, 'alice');
  expect(redis.del).not.toHaveBeenCalled(); // 独立键已退役
});
it('clearConnection 对从未入房的玩家是幂等的', async () => { /* 原用例保留 */ });
```

**删除**原文件全部窗口/独立键/validateReconnect 用例（窗口内/边界/独立键消失/超窗/「删两个键」等，共约 9 条）。

b) `ws.gateway.test.ts` `:893-1071` 整块（6 条）改写：`realReconnect(start)` 辅助改为 `realReconnect()`（**不注时钟**：`new ReconnectService(asRedis(redis))`）；逐条：

- 「窗口从观测到 disconnect 起算」（~934）→ 重写为「`room.join` 写记录、disconnect 刷新 `connectedAt`」（窗口措辞删除；`redis.ttl(reconnectKey(...))` 断言删除）；
- 「窗口起点只由观测决定」（~960）→ 重写为「未断线期间 `connectedAt` 不推进；断线即刷新；**记录存在=可恢复**（无过期判定）」；
- 「硬中断换链路续期」（~980）→ 保留断言（`connectedAt`/`socketId`/`activeConnections`），删除 `validateReconnect` 断言；
- 「迟到 disconnect 不覆盖」（~998）→ 原样保留（不涉退役符号）；
- 「重连恢复投递 B-d」（~1017）→ 保留，`connectedAt` 时机断言保留；
- 「拿不到 view 不恢复投递」（~1050）→ 保留（13009 判据同）。
  顶部 import 清理：`reconnectKey`、`RECONNECT_WINDOW_MS` 等若删除后未用则移除。

c) `message.router.test.ts`：`clearConnection` 替身改为只删哈希（去 `reconnectKey` 行），删除 `reconnectKey` 导入。

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: FAIL —— `touch` 仍写独立键（`redis.set` 被调用）、退役符号仍存在导致导入/断言失配。

- [ ] **Step 3: 实现（`reconnect.service.ts` 收口）**

- 删除：`RECONNECT_WINDOW_MS`、`RECONNECT_TTL_SECONDS`、`reconnectKey()`、`RECONNECT_CLOCK`、`validateReconnect()`、`@Optional @Inject` 构造槽与 `clock` 字段（构造只剩 `redis`）、对 `@Optional/@Inject` 的导入（若不再用）；`this.clock()` 的调用点（`touch` 的 `connectedAt`）改为 `Date.now()`。
- `touch()`：保留签名与「roomCode 缺省沿用」逻辑；**只**执行 `hset(RECONNECT_HASH_KEY, playerId, raw)`；删除 `set(..., 'EX', …)`；日志改为 `Reconnect record refreshed for ${playerId} in room ${code} (socket ${socketId})`；类头注释的「touch + validate」模型改为「写点（在线观测点）+ resolver」。
- `clearConnection()`：只 `hdel`。
- 文件头注释：删「TTL 35 秒 / 30 秒窗口」段落，指向规格 §2.1/§2.2。
- 确认 `RecoverableRoom`、`resolveRecoverableRoom`、`safeHget`、`readRecord`、`RECONNECT_HASH_KEY` 保留。

- [ ] **Step 4: 跑绿（本包 + 客户端不受影响）**

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS。

Run: `pnpm --filter @fight-the-landlord/room-service lint`
Expected: PASS（tsc 双配置；无未用导入）。

- [ ] **Step 5: Commit**

```bash
git add packages/room-service/src/reconnect/reconnect.service.ts packages/room-service/test/reconnect.service.test.ts packages/room-service/test/ws.gateway.test.ts packages/room-service/test/message.router.test.ts
git commit -m "refactor(reconnect): 窗口/TTL/时钟注入退役，touch/clearConnection 单键化（规格 §2.7）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `rooms.start` 开局为人类座位写哈希 + DI

**Files:**
- Modify: `packages/room-service/src/rooms/rooms.start.ts`（构造 ~57-73、写循环 ~155-163）、`packages/room-service/src/rooms/start.module.ts`
- Test: `packages/room-service/test/rooms.start.test.ts`

**Interfaces:**
- Consumes: Task 1/4 的 `ReconnectService.touch(userId, socketId, roomCode)`。
- Produces: 开局时 `reconnect:active` 哈希（人类座位，`socketId: ''`）与 `match:pending` 同循环写入；写失败 ⇒ log + `return false`。

- [ ] **Step 1: 失败测试**

`rooms.start.test.ts` 新 describe：

```ts
describe('§4.4：开局为人类座位写重连记录（断点④）', () => {
  it('人类座位写哈希（socketId 空串），机器人不写；与 pending 同循环', async () => {
    // 沿用本文件既有 fixture（fake redis + new RoomStartService(...)）
    const reconnect = new ReconnectService(asRedis(redis));
    // ...构造 service 并触发一次成功开局（房间含 1 人类 + 补位机器人）
    const raw = await redis.hget(RECONNECT_HASH_KEY, humanUserId);
    expect(JSON.parse(raw!)).toMatchObject({ socketId: '', roomCode: code });
    // 机器人座位的 id 上无哈希字段
    for (const bot of botIds) expect(await redis.hget(RECONNECT_HASH_KEY, bot)).toBeNull();
  });

  it('哈希写失败 ⇒ log + return false，房间留 waiting', async () => {
    const reconnect = { touch: vi.fn().mockRejectedValue(new Error('redis down')) };
    // 触发开局 → expect(await service.startRoom(code, {strict:true})).toBe(false)
    // 且房间状态仍为 waiting（沿用本文件既有断言风格）
  });
});
```

同时更新**全仓** `new RoomStartService(` 调用点（除本文件外还有 **5 处**）：`packages/room-service/test/match.service.test.ts:411/:966/:1682/:1749`、`packages/room-service/test/rooms.autostart.test.ts:257`——各补 `{ touch: vi.fn().mockResolvedValue(undefined) } as unknown as ReconnectService`（或共享真实实例）。**漏改任一处的后果**：该测试一进 `startRoom` 写循环即 TypeError（新参数无默认值），「本包全绿」不成立。

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/room-service test -- test/rooms.start.test.ts`
Expected: FAIL —— 新用例红；或构造函数参数不匹配直接报错。

- [ ] **Step 3: 实现**

a) `rooms.start.ts`：构造末尾追加 `private readonly reconnect: ReconnectService,`（值导入 `../reconnect/reconnect.service`，DI 陷阱纪律）；写循环（~155-163）里对每个人类座位，在 `pending` 两行**之后**追加：

```ts
// §4.4（设计 v1.3.1）：开局同时写重连记录 —— 「匹配后从未 room.join」的玩家
// 在票过期后仍可凭它回桌（断点④）。经 ReconnectService 写（键名/JSON 单一来源）。
await this.reconnect.touch(userId, '', code);
```

b) `start.module.ts` `imports` 追加 `ReconnectModule`（叶子依赖，无环）。

- [ ] **Step 4: 跑绿**

Run: `pnpm --filter @fight-the-landlord/room-service test`
Expected: PASS（含 `ws.module.wiring.test.ts` 的 StartModule 装配复查）。

- [ ] **Step 5: Commit**

```bash
git add packages/room-service/src/rooms/rooms.start.ts packages/room-service/src/rooms/start.module.ts packages/room-service/test/rooms.start.test.ts
git commit -m "feat(reconnect): startRoom 开局为人类座位写重连记录（修断点④）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 客户端自激守卫（唯一客户端改动）

**Files:**
- Modify: `apps/client/src/net/socket.ts`（`dispatchAck` ~1017-1021、`handleAck` ~603-612、`isSnapshotRequest` ~254-256 邻近）
- Test: `apps/client/test/reconnect-flow.test.ts`

**Interfaces:**
- Produces: 私有方法 `isSelfExcitedRefresh(type, code)`：`type` 为快照类请求且 `CLIENT_ACTION[code] === ClientAction.REFRESH_SNAPSHOT` ⇒ 跳过该次处置派发。落点**两处**（`dispatchAck` 与 `handleAck`）；`handleAck` 的 `type` 未知时照常派发（残余 ≤1、自终止）。

- [ ] **Step 1: 失败测试**

`reconnect-flow.test.ts` 新 describe：

```ts
describe('⑥ 自激守卫：快照类请求自身的 REFRESH_SNAPSHOT 失败不再触发 resync（规格 v1.1 §2.6）', () => {
  it('game.resync 自身收到 13009 ⇒ 不再发出第二条 game.resync，且无「状态冲突」提示', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    const r = session.client.send('game.resync', {});
    socket.emittedOf('game.resync')[0]!.ack(null, { code: ErrCode.GAME_NOT_STARTED });
    await r;

    expect(socket.emittedOf('game.resync')).toHaveLength(1);
    expect(session.notice.value?.text ?? '').not.toContain('状态冲突');
  });

  it('game.reconnect 自身收到 13009（waiting 房同页抖动）⇒ 不发 resync（风暴起点被拆除）', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    socket.emitConnect(); // 非首次连接 → 自动 emit game.reconnect
    socket.emittedOf('game.reconnect')[0]!.ack(null, { code: ErrCode.GAME_NOT_STARTED });
    await vi.waitFor(() => expect(store.currentVersion).toBe(3));

    expect(socket.emittedOf('game.resync')).toHaveLength(0);
  });

  it('负对照：动作请求的 13004 仍触发 game.resync（§6.5 通道不受守卫影响）', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    const play = session.client.send('game.play', { cards: makeCards(3) });
    socket.emittedOf('game.play')[0]!.ack(null, { code: ErrCode.VERSION_CONFLICT });
    await play;

    expect(socket.emittedOf('game.resync')).toHaveLength(1);
  });

  it('负对照：resync 自身收到 13010 → BACK_TO_LOBBY 照常派发（白名单外不拦）', async () => {
    const { socket, store, session, visited } = fresh(); // fresh() 已含 trackNavigation
    seatedAtVersion3(socket, store);

    const r = session.client.send('game.resync', {});
    socket.emittedOf('game.resync')[0]!.ack(null, { code: ErrCode.RECONNECT_RECORD_MISSING });
    await r;

    expect(visited).toContain('lobby');
  });

  it('迟到 ack（无在途请求、type 未知）⇒ 照常派发一次且自终止（残余 ≤1）', async () => {
    const { socket, store, session } = fresh();
    seatedAtVersion3(socket, store);

    session.client.handleAck({ code: ErrCode.GAME_NOT_STARTED }); // type 未知 → 照常派发
    await vi.waitFor(() => expect(socket.emittedOf('game.resync')).toHaveLength(1));
    socket.emittedOf('game.resync')[0]!.ack(null, { code: ErrCode.GAME_NOT_STARTED }); // 自身 13009 → 被拦
    await new Promise((res) => setTimeout(res, 0));

    expect(socket.emittedOf('game.resync')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `pnpm --filter @fight-the-landlord/client test -- test/reconnect-flow.test.ts`
Expected: 前两条与末条 FAIL（自激仍在：第二条 resync 被发出）。

- [ ] **Step 3: 实现（`socket.ts`）**

a) 顶部导入追加 `CLIENT_ACTION`、`ClientAction`（protocol 已有导出来源）。

b) `isSnapshotRequest` 邻近新增：

```ts
/**
 * 自激守卫（规格 v1.1 §2.6）：**快照类请求自身**收到 REFRESH_SNAPSHOT 类错误码
 * （表驱动，等价 13004/13007/13009 白名单）时不得再触发新一轮 `game.resync` ——
 * 恢复动作自身的失败重试不会改变结果（waiting 房 13009 → resync → 13009 的存量风暴起点）。
 * `type` 未知（迟到 ack 无上下文）⇒ 返回 false（照常派发，残余 ≤1 且自终止）。
 */
private isSelfExcitedRefresh(type: ClientMessageType | undefined, code: number): boolean {
  return (
    type !== undefined &&
    isSnapshotRequest(type) &&
    CLIENT_ACTION[code as ErrCode] === ClientAction.REFRESH_SNAPSHOT
  );
}
```

c) `dispatchAck`（~1017-1021）：`if (result.code !== 0) this.notifyAction(...)` → `if (result.code !== 0 && !this.isSelfExcitedRefresh(request.type, result.code)) this.notifyAction(result.code, message);`（注释更新为「ordinal ① 释放 → ② 派发（自激守卫豁免）→ ③ 唤醒」）。

d) `handleAck`（~603-612）：`if (input.code !== 0) this.notifyAction(...)` → `if (input.code !== 0 && !this.isSelfExcitedRefresh(input.type, input.code)) this.notifyAction(input.code, input.message);`

- [ ] **Step 4: 跑绿**

Run: `pnpm --filter @fight-the-landlord/client test -- test/reconnect-flow.test.ts`
Expected: PASS。

Run: `pnpm --filter @fight-the-landlord/client test`
Expected: PASS（全量；`connection-rejected` 等不受影响）。

Run: `pnpm --filter @fight-the-landlord/client lint`
Expected: PASS（vue-tsc）。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/net/socket.ts apps/client/test/reconnect-flow.test.ts
git commit -m "fix(client): 快照类请求自身的 REFRESH_SNAPSHOT 失败不再触发 resync（自激守卫）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 机械闸 `reconnect-single-source.gate.test.ts`（C12/C13）

**Files:**
- Create: `packages/room-service/test/reconnect-single-source.gate.test.ts`

**Interfaces:**
- Consumes: 同包 `meta-on-every-rpc-send.gate.test.ts` 的 `findRepoRoot()` 扫描形态（照抄其结构，不 import 它们）。

- [ ] **Step 1: 写测试（本闸天然「先红后绿」：在 Task 4 完成前它会红）**

```ts
/**
 * 断线恢复单一来源闸（规格 v1.1 C12/C13）。
 *  - C12：窗口/独立键/时钟注入 → 退役符号在**各包 `src/`** 0 命中；
 *  - C13：组合定位（哈希+pending 择优）只住在 resolver（reconnect 模块）；
 *         `RECONNECT_HASH_KEY` 只允许出现在 reconnect 模块的 src 里、`findActiveRoom` 0 命中。
 * ⚠️ 扫描面**只**是各包 `src/`（排除 `dist/`、`*.test.ts`）——照 `meta-on-every-rpc-send.gate.test.ts`
 *   的「逐包 src 白名单」纪律；`dist/` 里是旧产物，扫到它本闸恒红。
 * allowlist 纪律（R150 同族）：将来出现**合法**的第二读取方 ⇒ 先在本闸显式放行并写明理由，
 *   不得直接删闸。
 * 判别力自证：纯字符串探针（正/负样本）——不落盘。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

function findRepoRoot(): string { /* 照 meta-on-every-rpc-send.gate.test.ts 逐字（锚：packages/room-service + packages/game-service） */ }

const REPO = findRepoRoot();
const RETIRED = ['RECONNECT_WINDOW_MS', 'RECONNECT_TTL_SECONDS', 'reconnectKey', 'validateReconnect', 'RECONNECT_CLOCK', 'findActiveRoom'];

/** 递归收集某目录下的 .ts，排除 *.test.ts（与 meta 闸同纪律）。 */
function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTs(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** 扫描面 = 各包 `src/`（逐包枚举；不得扫 dist）。 */
function packagesSrcFiles(): string[] {
  const packagesDir = join(REPO, 'packages');
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    if (existsSync(src) && statSync(src).isDirectory()) files.push(...collectTs(src));
  }
  return files;
}

describe('断线恢复单一来源闸', () => {
  const files = packagesSrcFiles();

  it('扫描面非空（反空测；下界按实测校准）', () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it('退役符号 0 命中（C12）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const term of RETIRED) if (text.includes(term)) offenders.push(`${file}: ${term}`);
    }
    expect(offenders).toEqual([]);
  });

  it('判别力自证：同一判定逻辑对合成样本标红/放行', () => {
    const dirty = 'const x = RECONNECT_WINDOW_MS + validateReconnect;';
    const clean = 'const x = resolveRecoverableRoom;';
    expect(RETIRED.some((t) => dirty.includes(t))).toBe(true);
    expect(RETIRED.some((t) => clean.includes(t))).toBe(false);
  });

  it('RECONNECT_HASH_KEY 只现于 reconnect 模块的 src（C13 组合定位单一来源）', () => {
    const offenders = files
      .filter((f) => !f.split(/[\\/]/).includes('reconnect'))
      .filter((f) => readFileSync(f, 'utf8').includes('RECONNECT_HASH_KEY'));
    expect(offenders).toEqual([]);
  });

  it('resolveRecoverableRoom 恰定义一次（组合定位单一实现）', () => {
    const defs = files.filter((f) => readFileSync(f, 'utf8').includes('async resolveRecoverableRoom('));
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain(join('reconnect', 'reconnect.service.ts'));
  });
});
```

- [ ] **Step 2: 跑红/绿**

Run: `pnpm --filter @fight-the-landlord/room-service test -- test/reconnect-single-source.gate.test.ts`
Expected: 若在 Task 4 之后：PASS；若提前：红（这是预期用途——它是防回归闸，不是 TDD 的对象）。若首跑即绿，用探针用例自证判别力。

- [ ] **Step 3: Commit**

```bash
git add packages/room-service/test/reconnect-single-source.gate.test.ts
git commit -m "test(reconnect): 单一来源/退役符号机械闸（C12/C13）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 文档同步（design.md 七行 + client-protocol 两处；C18）

**Files:**
- Modify: `docs/design.md`、`docs/client-protocol.md`

**说明**：按内容定位（行号会漂移）。每处替换后，用 `grep -n "30 秒\|35 秒\|已过期" docs/design.md docs/client-protocol.md` 复核；本片三份 superpowers 文档自身与历史 `plans/` 不在清零范围。

- [ ] **Step 1（§6.6 主体 ~1011-1025）**：删除「重连窗口：30 秒」「TTL 为 35 秒」「（§6.6.1）」三处窗口表述与对应 bullet；判定图改四行（`code 0` 快照 / `13005` 已结束 / `13009` 尚未开始 / `13010` 无任何可恢复凭据（含房间已回收））；重写 bullets 为：判定由 `resolveRecoverableRoom`（存活谓词，pending→哈希 择优）驱动；保留「不做增量重放（全量裁剪快照）」「`13010` 不复用 `12001`」两条逐字。`[已实现]` 括注的测试计数**本任务不动**（Task 10 回填实测数）。

- [ ] **Step 2（§6.6.1 ~1027-1057）**：标题改为「记录写入时机（在线观测点）」；「窗口从服务端观测到断线起算」段替换为：「恢复门槛 = **记录在 + 对局存活**（不再有 30 秒窗口；`reconnect:active` 无 TTL，仅 `room.leave` 清除）」；四时机表改**五时机**（+ `startRoom` 开局为人类座位写入，`socketId` 空串）；五步判定顺序改四步（对齐规格 §2.3）；「独立键消失=过期信号」段删除；:1057 已知边界段（窗口起算）整段删除（硬中断场景的说明改为「凭据在 join/开局时即存在，较旧窗口方案更稳」一句）。

- [ ] **Step 3（§6.3 表行 ~910）**：`game.reconnect` 行改为「ack `data: 裁剪快照`；已结束则 `code: 13005`；尚未开始则 `code: 13009`；无任何可恢复凭据（含房间已回收）则 `code: 13010`」。

- [ ] **Step 4（§8.2 ~1339/1345、§10.1 ~1530）**：涉及「写入 `match:pending`…供重连与补发查询」的句子补一句「**开局同时为该座位写 `reconnect:active` 重连记录**（服务端连接补推与 `game.reconnect` 的凭据；§6.6）」。

- [ ] **Step 5（§10.1 ~1546）**：`reconnect:active` 键行删除独立键/TTL 列述与 C12 注；注明「无 TTL；写入者 = join / 开局 / 断线观测 / 硬换手；仅 `room.leave` 清除」。

- [ ] **Step 6（§10.4 ~1578）**：「重连记录 | 35s」行改为「重连记录 | 无 TTL（显式离开清理）」。

- [ ] **Step 7（§11.2 ~1642）**：`13010` 行描述改为「**没有任何可恢复凭据**（无记录、无匹配票、或房间已回收）」（删「已过期」）。

- [ ] **Step 8（client-protocol.md ~299 + 处置表）**：`13010` 行同 §11.2 新描述；在 §11 处置说明附近加一行：「快照类请求（`game.resync`/`game.reconnect`）**自身**的 13004/13007/13009 不触发新一轮 resync（自激守卫；见设计 §5）」。

- [ ] **Step 9: 复核 + Commit**

Run: `grep -n "30 秒\|35 秒\|30s" docs/design.md docs/client-protocol.md`
Expected: 命中仅剩（a）「迁移/历史注记」类非现行机制表述与（b）**其他功能面**的 `30s`（如通知轮询、健康检查一类，design.md :523/:631/:1236 一带）——逐条核对后放行。⚠️ 本 grep **不得**当作「全清」的证据（旧心跳写的是 `30s/90s` 形态，且全清口径含语义改写而非仅数字）。

```bash
git add docs/design.md docs/client-protocol.md
git commit -m "docs(reconnect): design.md 七行 + client-protocol 同步「对局存活即可回」语义（C18）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: conformance 改写（slice-05 改写 / slice-12 增补）

**Files:**
- Modify: `tools/conformance/src/slices/slice-05-reconnect.ts`、`tools/conformance/src/slices/slice-12-manual-join.ts`

**前置**：本机 docker 栈在跑且 room-service 镜像含本片代码：`docker compose build room-service && docker compose up -d room-service`（等健康）。运行：`pnpm -C tools/conformance build && node tools/conformance/dist/run.js slice-05`（slice-12 同理）。Harness 的 redis 直注入/直删沿用 slice-12 既有手法（`match:pending` 毒键用例处有 `redisCli` 成例）。

- [ ] **Step 1: slice-05 改写**

按文件现有步骤与新语义对位（步骤编号随文）：

1. 常量：`OFFLINE_MS` 由 10s 改 **40s**（C1：真跨过旧 30 秒窗口）；`WINDOW_CROSSING_MS` 保持（40s 在线段）但其 step 文案改为「在线 40 秒（旧窗口时代的回归段，仍覆盖『局打久了不丢』）」。
2. 步骤 4-8 断言维持（重连 code 0 / 快照 version=服务端当前 / seat / currentPlayer / 投递恢复 C9/C10），文案去「35 秒窗口」字样。
3. **新增 C2**（步骤 8 后）：P0 再次断开当前 socket → 另开新连接（**不发 `game.reconnect`**）→ `waitFor` 补推 `room.matched`（+`game.deal`）到达且 `roomCode` 一致 ⇒ 「重复离线仍被拉回」。若当次连接同时收到显式回执不冲突（幂等），断言只认补推消息。
4. **新增 C3**：对第 4 个备用账号：REST 占座进一个新房并等其开局（照 slice-12 的「全员 REST 占座」构造）⇒ 服务端**直删**其 `match:pending:{id}` ⇒ 该账号建立 WS（**从未 room.join 过**）⇒ 断言收到 `room.matched`（凭开局写入的哈希）且 `game.deal` version 与房内一致。
5. **新增 C4**：好友房（practice）路径：REST 建房 + 该账号 WS `room.join`（房态 waiting）⇒ 断开 ⇒ 新连接 ⇒ 断言补推 `room.matched` 的 roomCode = 该房。
6. **新增 C5 负对照**：备用账号 `room.join` 成功房后发 `room.leave` ⇒ 断开 ⇒ 新连接 ⇒ **等待片刻并记录实测静默时长**（沿用本片 `waitFor` / 时间戳的既有 idiom；不写死 3s 硬判据）内无 `room.matched`，且显式 `game.reconnect` 得 `13010`。
7. 末尾泄漏扫描步骤保留。

- [ ] **Step 2: slice-12 增补（C6）**

现有「迟到者」竞态用例内，在迟到者建立 WS **之前**注入陈旧哈希：

```
HSET reconnect:active {lateUserId} '{"socketId":"","roomCode":"DEADROOM","connectedAt":0}'
```

断言不变且新增：迟到者拿到的 `game.deal.roomCode`/`room.matched.roomCode` = **竞态房**（不得被 DEADROOM 遮蔽）。

- [ ] **Step 3: 跑片（局部）**

Run: `pnpm -C tools/conformance build && node tools/conformance/dist/run.js slice-05`
Expected: 全绿（含新增 C1-C5；总时长 +~40s）。

Run: `node tools/conformance/dist/run.js slice-12`
Expected: 全绿（含新增注入）。

- [ ] **Step 4: Commit**

```bash
git add tools/conformance/src/slices/slice-05-reconnect.ts tools/conformance/src/slices/slice-12-manual-join.ts
git commit -m "test(conformance): slice-05 存活语义改写 + C1-C5 实证；slice-12 陈旧哈希竞态（C6）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 全序验证、基线回填与收口

**Files:**
- Modify: `tools/conformance/baselines.json`、`docs/design.md`（§6.6 `[已实现]` 计数行）、本片三份 superpowers 文档（冻结状态回填）

- [ ] **Step 1: 全序 conformance**

Run: `pnpm -C tools/conformance build && node tools/conformance/dist/run.js`
Expected: 全片跑完，非绿项逐条分类（环境性 vs 真红；照既有台账口径）。

- [ ] **Step 2: 全仓门禁**

Run: `pnpm -r test`（或既有六阶段 `pnpm ci`）
Expected: 全绿；把结果与耗时记录进本任务收口段。

- [ ] **Step 3: 基线回填**

`baselines.json`：`slice-05`/`slice-12` 断言数改为实测值（只增不降原则核对）。`docs/design.md` §6.6 `[已实现]` 括注：更新测试计数（`reconnect.service.test.ts` 条数、slice-05 断言数、本片新增判据引用）。

- [ ] **Step 4: C14 one-shot 验证（不落常驻闸）**

Run: `git diff --name-only 85b118b..HEAD -- apps/client/src`
Expected: 仅 `apps/client/src/net/socket.ts`。结果抄进收口段（基线 = 规格冻结提交 `85b118b`；该检查为一次性，不做常驻测试——diff 闸在切片合入后会随仓库前进失真）。

- [ ] **Step 5: 验收 A1-A6 记录**

按规格 §5 逐条给证据（conformance 输出/手工步骤/负对照结果）。**A2（已入房 >5 分钟）走手工验收**：对局中让该客户端离线 >5min 后重连（若期间对局自然结束，则该次记录「结束态静默」路径并重试一次）。**A2 与 C3 的对象不同**（A2=已入房、C3=从未入房），不得互相充抵；未跑不得写「通过」（照仓库「未执行≠通过」纪律）。A4 引用 C9/C10 输出；A6 引用 §8 回滚扰动登记。

- [ ] **Step 6: 收口 Commit**

```bash
git add tools/conformance/baselines.json docs/design.md docs/superpowers/specs/2026-10-12-reconnect-until-game-end-design.md docs/superpowers/specs/2026-10-12-reconnect-until-game-end-spec.md
git commit -m "docs(reconnect): 全序验证绿 + 基线/计数回填 + 验收记录（C18 收口）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 自检（写完后的对照）

- **规格覆盖**：C1-C5/C9/C10/C6 → Task 9；C7/C8 → Task 3/6；C11 → Task 1；C12/C13 → Task 7（C12 亦由 Task 4 实施）；C14 → Task 10；C15 → Task 2；C16 → Task 5；C17 → Task 4；C18 → Task 8/10。A1-A6 → Task 10。无缺口。
- **占位符扫描**：无 TBD/TODO；Slice-05 的编辑按「场景 + 断言内容 + 既有手法引用」给出（文件大，实现者按文内 idiom 落码）。
- **类型一致性**：`RecoverableRoom`（T1 定义）在 T2/T3 消费一致；`isSelfExcitedRefresh` 仅 T6 内使用；`touch(userId, socketId, roomCode)` 三参形态贯穿 T1/T3/T5。

---

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-12 | 初稿：10 任务 TDD 拆解（T1 resolver → T2 router → T3 gateway → T4 退役 → T5 startRoom → T6 客户端守卫 → T7 机械闸 → T8 文档 → T9 conformance → T10 收口） |
| v1.1 | 2026-10-12 | 吸收计划审查（2 重要 + 6 次要 + 4 观察）：T2/T3 改**替身驱动**（6 条路由正例接 resolver mock；补推块替身接 resolver、删 hget 计数断言）；T5 补 5 处构造调用点（match.service.test / rooms.autostart.test）；T1 `readRecord` 经 `safeHget`（record 候选毒键对称处置）+ 补「record 毒键」「双死 → null」两用例；T4 假时钟化（`vi.setSystemTime`，去 `now` 变量）；T7 闸重写（逐包 `src/` 扫描、实断言、allowlist 纪律、扫描面反空测）；T8 grep 补 `30s` 并注明非全清证据；T9 C5 改「记录实测静默时长」idiom；T10 A2 改手工验收且不充抵 C3 |
| v1.2 | 2026-10-12 | 二轮复核收底：T2 Step 1-d 新增 **grep 驱动收底**（点名 8 条会打破的用例：连接 describe 旧⑤之后四条 + resync/传输家族四条；`validateReconnect\|seedRecord` 必须 0 命中）；`hit` 定义改**显式落码**指令；T4 补「中途推进时间」用法示例（`vi.setSystemTime(Date.now()+…)`，含 ws.gateway `:980` 块翻译） |
| v1.3 | 2026-10-12 | 执行期收尾（Task 7 批次）：① 笔误订正「在弄票过期后」→「在票过期后」（本文件 T5 骨架 + `rooms.start.ts` 落码处同款）；② 登记执行期口径批修（旧「窗口 / 独立键 / `SET … EX 35`」措辞按现状改述，`Reconnect window`→record 口径）：`message.router.test.ts` 用例名/注释、`fake-redis.ts` 删除死代码 `expireNow()` 并改述头注、`reconnect.service.test.ts` 补「缺 roomCode 记录按缺席跳过」用例、`apps/client/test/reconnect-flow.test.ts` 补自激守卫「已知快照类 type 无在途请求 ⇒ 不派发」直接用例；③ T7 闸反空测下界按实测校准（319 个 `src` 文件 → 下限 300） |

import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { of, throwError } from 'rxjs';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import type { Redis } from 'ioredis';
import type { BotInstance, Seat } from '@fight-the-landlord/protocol';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { RoomStartService } from '../src/rooms/rooms.start';
import { RoomsService } from '../src/rooms/rooms.service';
import { nicknamesKey, roomBalancesKey } from '../src/rooms/rooms.seats';
import { GameClient } from '../src/gateway/game.client';
import { RobotClient } from '../src/gateway/robot.client';
import { CHANNELS } from '../src/channels';
import { botsKey, readBotBindings } from '../src/rooms/rooms.bots';
import { asRedis, createFakeRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';
import { seat } from './helpers/room-fixture';
import { exactSeriesValue } from './helpers/metric-readout';
import { gameStartFailuresTotal, gamesStartedTotal } from '../src/metrics/room.metrics';
// ② T6：真链路（真 `RobotFunding` + 假 currency）的 ensure 失败传播用例。
import { RobotFunding } from '../src/currency/robot-funding';
// 断点④修复（Task 5 · 设计 v1.3.1 §4.4）：开局写重连记录 —— `ReconnectService` 真实例
// 绑定同一个假 redis（§4.4「真写哈希」用例走的就是产品的写入链）；`RECONNECT_HASH_KEY`
// 是断言的键名来源（不在用例里写死字面量）。
import { RECONNECT_HASH_KEY, ReconnectService } from '../src/reconnect/reconnect.service';

/**
 * `RoomStartService`（本片 · spec §2.2 / §3.3 / R915）—— 手动房与匹配路径**共用**的开局链。
 *
 * 装配与 `match.service.test.ts` 同形：**真实 `RoomsService`** 接在带 TTL 的假 Redis 上
 * （`findOne` / `addBot` / `updateStatus` 都真的读写），`GameClient` / `RobotClient` 接在
 * **假 RPC proxy** 上 ⇒ 真实 pipeline（超时 / 信封解包 / 重试）都被走到。
 */
describe('RoomStartService：补位 → game.start → playing → 通知', () => {
  let redis: FakeRedis;
  let rooms: RoomsService;
  /** 本片：`RoomsService` 与 `RoomStartService` **共用同一个**配置缓存桩（断言读面与真身一致）。 */
  let configCache: ConfigCacheStub;
  let service: RoomStartService;
  let calls: Array<{ pattern: string; data: unknown }>;
  let handlers: Map<string, (data: unknown, index: number) => unknown>;
  /** 裸 `send` 替身：顺序判据要用 `mock.invocationCallOrder`（成例 match.service.test.ts:729-734）。 */
  let rpcSend: ReturnType<typeof vi.fn>;
  /** ② T5：金币边替身（金币房开局三座余额下发的 `currency.get`）。 */
  let currency: { get: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> };
  /** ② T6：机器人资金面替身（金币场补位后的 `ensureBots` 边）。 */
  let robotFunding: { ensureBots: ReturnType<typeof vi.fn>; afterSettle: ReturnType<typeof vi.fn> };

  const botOf = (seatNo: number, botId: string, displayId: string): BotInstance => ({
    botId,
    displayId,
    skillLevel: 'beginner',
    personality: { thinkingSpeed: 900 },
    roomCode: 'ROOM01',
    seat: seatNo,
    gamesPlayed: 0,
  });

  function rpcStub() {
    const send = vi.fn((pattern: string, data: unknown) => {
      const index = calls.filter((c) => c.pattern === pattern).length;
      calls.push({ pattern, data });
      const handler = handlers.get(pattern);
      if (handler) return handler(data, index);
      if (pattern === RPC_PATTERNS.robotAcquire) {
        const seats = (data as { seats?: number[] }).seats ?? [1];
        return of({
          ok: true,
          data: { bots: seats.map((s) => botOf(s, `bot-${s}`, `p_${String(s).padStart(8, '0')}`)) },
        });
      }
      return of({ ok: true, data: {} });
    });
    return { send } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createFakeRedis();
    configCache = makeConfigCache();
    rooms = new RoomsService(asRedis(redis), asConfigCache(configCache));
    calls = [];
    handlers = new Map();
    const proxy = rpcStub();
    rpcSend = (proxy as unknown as { send: ReturnType<typeof vi.fn> }).send;
    currency = { get: vi.fn(), apply: vi.fn() };
    robotFunding = { ensureBots: vi.fn(async () => undefined), afterSettle: vi.fn() };
    service = new RoomStartService(
      asRedis(redis) as Redis,
      rooms,
      new GameClient(proxy),
      new RobotClient(proxy),
      // ② T5：金币边（金币房开局三座余额下发的读边；非金币场零调用）。
      currency as never,
      // ② T6：机器人资金面（金币场补位后的 ensure 边；非金币场零调用）。
      robotFunding as never,
      // 断点④修复（Task 5 · 设计 v1.3.1 §4.4）：重连记录写边 —— **真实例**（假 redis
      // 是它的后端）⇒ 既有全部用例顺带走真写入链，「真写哈希」用例可在同一实例上断言。
      new ReconnectService(asRedis(redis)),
      // 本片（第 42 键读边）：台费费率表 —— 与 `RoomsService` **同一实例**（见上方声明）。
      asConfigCache(configCache),
    );
  });

  /** 建一个**手动房**（40s 窗口 + 已入座的人）—— 与 `POST /api/rooms` 的产物同形。 */
  async function manualRoom(code: string, humans: string[]): Promise<void> {
    await rooms.create({ mode: 'practice', roomCode: code });
    for (const id of humans) await rooms.join(code, id);
  }

  const announced = () =>
    (redis.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([channel]) => channel === CHANNELS.matchEvents)
      .map(
        ([, message]) =>
          JSON.parse(String(message)) as {
            event?: string;
            roomCode: string;
            seats: Array<{ userId: string }>;
          },
      )
      // 记牌器收费片起 match:events 还会发 `card_counter` 事件；本 helper 只关心 matched。
      .filter((event) => event.event === 'room.matched');

  it('缺人 ⇒ 补机器人到满座 ⇒ 开局；机器人**不发** room.matched（R47/§9.6）', async () => {
    await manualRoom('ROOM01', ['u1']);

    const ok = await service.startRoom('ROOM01', { strict: true });

    expect(ok).toBe(true);
    expect((await rooms.findOne('ROOM01'))!.status).toBe('playing');
    // 三个人：1 个人 + 2 个机器人
    const players = (await rooms.findOne('ROOM01'))!.players;
    expect(players).toHaveLength(3);
    expect(players.filter((p) => p.isRobot)).toHaveLength(2);
    // `game.start` 的载荷：人类不带 botId/thinkingSpeed，机器人**必须**带（§9.6 第 4 条）
    const start = calls.find((c) => c.pattern === RPC_PATTERNS.gameStart)!.data as {
      players: Array<Record<string, unknown>>;
    };
    expect(start.players).toHaveLength(3);
    const human = start.players.find((p) => p.id === 'u1');
    expect(human).toBeDefined(); // 反空转：find 失败时下面的负向断言会假绿
    expect(human).not.toHaveProperty('botId');
    expect(human).not.toHaveProperty('thinkingSpeed');
    const robots = start.players.filter((p) => p.isRobot === true);
    expect(robots).toHaveLength(2);
    for (const robot of robots) {
      expect(robot).toHaveProperty('botId');
      expect(robot).toHaveProperty('skillLevel');
      expect(robot.thinkingSpeed).toBe(900); // 来自 botOf 的 personality.thinkingSpeed
    }
    // 只有人类收到 room.matched
    expect(announced()).toHaveLength(1);
    expect(announced()[0]!.seats.map((s) => s.userId)).toEqual(['u1']);
  });

  /**
   * 兼容性判据：机器人池里的**旧记录 / 损坏记录**（缺 `personality`）不得让补位失败 ——
   * 这条链此前从不读 `personality`；`thinkingSpeed` 是本片新加的**内部**字段，
   * 缺失时用兜底值 2000ms 下发（不是抛错、不是 `undefined`）。
   */
  it('BotInstance 缺 personality ⇒ 补位照常、`game.start` 的 thinkingSpeed 兜底 2000', async () => {
    await manualRoom('ROOM16', ['u1']);
    // 覆盖 acquire 的默认产物：除 personality 外字段齐备（旧池记录 / 数据损坏形态）。
    handlers.set(RPC_PATTERNS.robotAcquire, (data) => {
      const seats = (data as { seats?: number[] }).seats ?? [1];
      return of({
        ok: true,
        data: {
          bots: seats.map((s) => ({
            botId: `bot-${s}`,
            displayId: `p_${String(s).padStart(8, '0')}`,
            skillLevel: 'beginner',
            roomCode: 'ROOM16',
            seat: s,
            gamesPlayed: 0,
            // 故意没有 personality
          })),
        },
      });
    });

    const ok = await service.startRoom('ROOM16', { strict: true });

    expect(ok, '缺 personality 不得让补位 / 开局失败').toBe(true);
    const start = calls.find((c) => c.pattern === RPC_PATTERNS.gameStart)!.data as {
      players: Array<Record<string, unknown>>;
    };
    const robots = start.players.filter((p) => p.isRobot === true);
    expect(robots, '反空测：真的补进了机器人').toHaveLength(2);
    for (const robot of robots) {
      expect(robot.thinkingSpeed, '缺 personality ⇒ 兜底 2000ms').toBe(2000);
    }
  });

  it('满员 ⇒ 不补位、直接开局（`robot.acquire` 零调用）', async () => {
    await manualRoom('ROOM02', ['u1', 'u2', 'u3']);

    const ok = await service.startRoom('ROOM02', { strict: true });

    expect(ok).toBe(true);
    expect(calls.filter((c) => c.pattern === RPC_PATTERNS.robotAcquire)).toHaveLength(0);
    expect(announced()[0]!.seats.map((s) => s.userId).sort()).toEqual(['u1', 'u2', 'u3']);
  });

  // ─── ① 写凭据（片⑦ 修复 · slice12-race-fix-design §1）─────────────────
  //
  // 竞态：第三人 REST 占座 → WS 连接之间 autostart 开火 ⇒ `room.matched` 只投已连接
  // socket ⇒ 迟到者收不到且**无凭据可补回**（好友房以前不写 `match:pending`）。
  // 修法 ①：写入点从「匹配路径的 `onSeats` 挂钩」**泛化到 `startRoom` 自身** ——
  // 一切开局（手动房 / 匹配房）都为人类座位写，单一来源。

  /**
   * 形状与 TTL 与旧 `MatchService.storePending` **逐字一致**
   *（键 `match:pending:{userId}`、`{ roomCode, seat }`、TTL 300s —— §8.2/§10.4）。
   */
  it('① 开局为每个**人类**座位写 match:pending = { roomCode, seat } 且带 300s TTL（§8.2/§10.4）', async () => {
    await manualRoom('ROOM12', ['u1', 'u2', 'u3']);

    await service.startRoom('ROOM12', { strict: true });

    expect(redis.hashes.get('match:pending:u1')).toEqual({ roomCode: 'ROOM12', seat: '0' });
    expect(redis.hashes.get('match:pending:u2')).toEqual({ roomCode: 'ROOM12', seat: '1' });
    expect(redis.hashes.get('match:pending:u3')).toEqual({ roomCode: 'ROOM12', seat: '2' });
    expect(redis.ttls.get('match:pending:u1'), 'TTL 与 §10.4 一致').toBe(300);
  });

  it('① 机器人**不写** match:pending（R47 —— 与 announce 共用同一份人类谓词）', async () => {
    await manualRoom('ROOM13', ['u1']);

    await service.startRoom('ROOM13', { strict: true });

    const players = (await rooms.findOne('ROOM13'))!.players;
    expect(players.filter((p) => p.isRobot), '反空测：真的补进了机器人').toHaveLength(2);
    const pendingKeys = [...redis.hashes.keys()].filter((k) => k.startsWith('match:pending:'));
    expect(pendingKeys).toEqual(['match:pending:u1']);
  });

  /**
   * 顺序判据（设计 §1 ①）：凭据必须**先于**两条 announce（`announceFirst` 的两个分支）
   * 与 `game.start` —— 「补位成功、开局之前」的窗口正是迟到者补回的唯一依据。
   * 用 `invocationCallOrder`（成例 `match.service.test.ts:729-734`），不是「方法被调过」——
   * 后者是结构判据，测不出顺序。
   */
  it('① 凭据的写入**先于** announce 与 game.start（顺序判据）', async () => {
    await manualRoom('ROOM14', ['u1', 'u2', 'u3']);

    await service.startRoom('ROOM14', { strict: true });

    const writeAt = redis.hset.mock.calls.findIndex(([key]) => key === 'match:pending:u1');
    expect(writeAt, '反空测：凭据真的写过了').toBeGreaterThanOrEqual(0);
    const writeOrder = redis.hset.mock.invocationCallOrder[writeAt]!;
    const publishOrder = redis.publish.mock.invocationCallOrder[0]!;
    const startAt = calls.findIndex((c) => c.pattern === RPC_PATTERNS.gameStart);
    expect(startAt, '反空测：game.start 真的发过了').toBeGreaterThanOrEqual(0);
    const startOrder = rpcSend.mock.invocationCallOrder[startAt]!;

    expect(writeOrder, '凭据写入必须先于 announce（room.matched 的发送前提）').toBeLessThan(publishOrder);
    expect(writeOrder, '凭据写入必须先于 game.start').toBeLessThan(startOrder);
  });

  /**
   * 裁决 E（设计 §5）：写凭据失败 ⇒ `log + return false`（镜像 `onSeats` 的 catch）。
   *
   * 「写失败 ⇒ 房间留 `waiting`」被两处判据依赖：slice-12 步骤 10 的毒键因果链
   *（毒键 ⇒ 写失败 ⇒ 房间留 waiting ⇒ 降级走 CAS）与 `match.service.test.ts:737-756`
   * 的语义 ⇒ 吞异常会把它们变成空测。
   *
   * ⚠️ 假 Redis 没有类型语义（String/Hash 混用不抛）⇒ 这里用 `mockRejectedValueOnce`
   * 直接让第一发 `hset` 失败（真实形态 = 毒键 WRONGTYPE）。
   */
  it('① 写凭据失败 ⇒ 返回 false、房间留 waiting、不 announce、不 game.start（裁决 E）', async () => {
    await manualRoom('ROOM15', ['u1', 'u2', 'u3']);
    redis.hset.mockRejectedValueOnce(
      new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
    );

    const ok = await service.startRoom('ROOM15', { strict: true });

    expect(ok).toBe(false);
    expect((await rooms.findOne('ROOM15'))!.status, '写凭据失败 ⇒ 绝不开局').toBe('waiting');
    expect(announced(), '开局失败不得通知玩家').toHaveLength(0);
    expect(calls.filter((c) => c.pattern === RPC_PATTERNS.gameStart), '不得调 game.start').toHaveLength(0);
  });

  /**
   * 🔴 spec §1.2 H1 的判据：`game.start` 失败 ⇒ **不得**写 `playing`。
   *
   * `playing` 是**唯一**逃离回收任务的状态（`isWaitingExpired` 明文不回收 `playing`）⇒
   * 失败还写 `playing` 就是「3 个玩家对着空牌桌等 1 小时 TTL」。
   */
  it('🔴 strict：`game.start` 失败 ⇒ 房间仍是 waiting（绝不写 playing）', async () => {
    await manualRoom('ROOM03', ['u1', 'u2', 'u3']);
    handlers.set(RPC_PATTERNS.gameStart, () => throwError(() => new Error('game-service down')));

    const ok = await service.startRoom('ROOM03', { strict: true });

    expect(ok).toBe(false);
    expect((await rooms.findOne('ROOM03'))!.status, '失败不得写 playing').toBe('waiting');
    expect(announced(), '开局失败不得通知玩家').toHaveLength(0);
  });

  /**
   * ⚠️ **`strict: false`（匹配路径）保持现状**：失败**照样**写 `playing` ——
   * 那是台账 N36 登记的已知边界（已裁「本仓不实现」），本片不动它（spec §7）。
   * 这条**不是**在赞美现状，而是把「两条路径的处置不同」钉成**显式**的。
   */
  it('strict:false（匹配路径）保持现状：失败仍写 playing（N36 的已知边界，本片不动）', async () => {
    await manualRoom('ROOM04', ['u1', 'u2', 'u3']);
    handlers.set(RPC_PATTERNS.gameStart, () => throwError(() => new Error('down')));

    const ok = await service.startRoom('ROOM04', { strict: false });

    expect(ok).toBe(false); // 返回值如实反映「没开起来」
    expect((await rooms.findOne('ROOM04'))!.status).toBe('playing'); // 但状态照旧
  });

  it('补位失败 ⇒ 不写 playing、不通知（房间留 waiting 等下轮）', async () => {
    await manualRoom('ROOM05', ['u1']);
    handlers.set(RPC_PATTERNS.robotAcquire, () => throwError(() => new Error('robot-service down')));

    const ok = await service.startRoom('ROOM05', { strict: true });

    expect(ok).toBe(false);
    expect((await rooms.findOne('ROOM05'))!.status).toBe('waiting');
    expect(calls.filter((c) => c.pattern === RPC_PATTERNS.gameStart)).toHaveLength(0);
  });

  it('幂等：已经 playing 的房间再开一次 ⇒ 不发任何 RPC、不重复通知', async () => {
    await manualRoom('ROOM06', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('ROOM06', { strict: true })).toBe(true);
    const rpcAfterFirst = calls.length;
    const announcedAfterFirst = announced().length;

    const again = await service.startRoom('ROOM06', { strict: true });

    expect(again, '第二轮扫到同一个房间时它已经是 playing 了').toBe(false);
    expect(calls.length).toBe(rpcAfterFirst);
    expect(announced().length).toBe(announcedAfterFirst);
  });

  it('房间不存在 ⇒ false（不抛）', async () => {
    await expect(service.startRoom('NONEXIST', { strict: true })).resolves.toBe(false);
  });

  it('补位落 `room:{code}:bots`（R207：局终 robot.release 的唯一来源）', async () => {
    await manualRoom('ROOM07', ['u1']);

    await service.startRoom('ROOM07', { strict: true });

    // 形状：**Hash `field = seat` → `botId`**（内部 id；座位的 `userId` 是对外 `displayId`）
    const bound = await readBotBindings(asRedis(redis) as Redis, 'ROOM07');
    expect(bound, '两个机器人的绑定都要落盘').toHaveLength(2);
    expect(bound.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(redis.ttls.get(botsKey('ROOM07')), 'TTL 与房间一致（§10.1）').toBe(3600);
  });

  it('座位不重排：已在座的人保持原座位（R128 —— 权威表是 room.players）', async () => {
    await rooms.create({ mode: 'practice', roomCode: 'ROOM08' });
    await rooms.join('ROOM08', 'u1');
    await rooms.join('ROOM08', 'u2');
    const before = (await rooms.findOne('ROOM08'))!.players.map((p: Seat) => ({ ...p }));

    await service.startRoom('ROOM08', { strict: true });

    const after = (await rooms.findOne('ROOM08'))!.players;
    for (const was of before) {
      expect(after.find((p) => p.userId === was.userId)?.seat, `${was.userId} 的座位不得被改`).toBe(was.seat);
    }
    expect(after).toHaveLength(3);
  });

  it('baseScore 来自房间元数据，不是硬编码（N19 同族）', async () => {
    await rooms.create({ mode: 'practice', roomCode: 'ROOM09' }, { timeoutMs: 1 });
    await rooms.join('ROOM09', 'u1');
    await rooms.join('ROOM09', 'u2');
    await rooms.join('ROOM09', 'u3');

    await service.startRoom('ROOM09', { strict: true });

    const start = calls.find((c) => c.pattern === RPC_PATTERNS.gameStart)!.data as { baseScore: number };
    // 2026-10-21：缺省 = 配置桩档位表的最低档（种子四档的最小值 15）。
    expect(start.baseScore).toBe(15);
  });

  it('座位表里有 robot 时 `isRobot` 原样传给 game-service（§9.6 第 4 条）', async () => {
    await rooms.create({ mode: 'practice', roomCode: 'ROOM10' });
    await rooms.join('ROOM10', 'u1');
    await rooms.addBot('ROOM10', 'p_deadbeef'); // 预置一个机器人（绕过 acquire）

    await service.startRoom('ROOM10', { strict: true });

    const start = calls.find((c) => c.pattern === RPC_PATTERNS.gameStart)!.data as {
      players: Array<Record<string, unknown>>;
    };
    const robot = start.players.find((p) => p.id === 'p_deadbeef')!;
    expect(robot.isRobot).toBe(true);
    // ⚠️ 这个机器人不是本次 `acquireBot` 拿到的 ⇒ 没有 bindings ⇒ **不带 botId**
    //（已知的窄缝：预置机器人的绑定只能靠 `writeBotBindings` 的调用方补）
    expect(robot).toHaveProperty('seat');
  });

  it('拟人昵称覆盖全量机器人座位（含预置机器人，不只本次 acquire）', async () => {
    await rooms.create({ mode: 'practice', roomCode: 'ROOM10N' });
    await rooms.join('ROOM10N', 'u1');
    await rooms.addBot('ROOM10N', 'p_deadbeef'); // 预置机器人（不走 acquire）

    await service.startRoom('ROOM10N', { strict: true });

    const names = redis.hashes.get(nicknamesKey('ROOM10N')) ?? {};
    expect(names['p_deadbeef']).toBeTruthy();
    // 本次 acquire 补的第二个机器人也要有名字。
    expect(names['p_00000002']).toBeTruthy();
  });

  it('半途 acquire 失败重试：先入座与后补的机器人都拿到昵称', async () => {
    await manualRoom('ROOM12', ['u1']);
    // 第一座（seat 1）成功；第二座（seat 2）的**两次** acquire 都失败
    //（`acquireBot` 内部 RPC_MAX_ATTEMPTS=2，只失败一次会被重试吞掉）。
    handlers.set(RPC_PATTERNS.robotAcquire, (data) => {
      const seatNo = (data as { seats: number[] }).seats[0]!;
      if (seatNo === 2) throw new Error('acquire failed');
      return of({
        ok: true,
        data: {
          bots: [botOf(seatNo, `bot-${seatNo}`, `p_${String(seatNo).padStart(8, '0')}`)],
        },
      });
    });

    expect(await service.startRoom('ROOM12', { strict: true })).toBe(false);
    const afterFail = await rooms.findOne('ROOM12');
    expect(afterFail!.players.filter((p) => p.isRobot)).toHaveLength(1);

    handlers.delete(RPC_PATTERNS.robotAcquire);
    expect(await service.startRoom('ROOM12', { strict: true })).toBe(true);

    const names = redis.hashes.get(nicknamesKey('ROOM12')) ?? {};
    const robots = (await rooms.findOne('ROOM12'))!.players.filter((p) => p.isRobot);
    expect(robots).toHaveLength(2);
    for (const robot of robots) {
      expect(names[robot.userId], `${robot.userId} 应有昵称`).toBeTruthy();
    }
  });

  it('昵称写入失败 ⇒ 开局仍成功（fail-open，不把展示问题升级成开不了局）', async () => {
    await manualRoom('ROOM13', ['u1']);
    const original = redis.hsetnx.getMockImplementation()!;
    redis.hsetnx.mockImplementation(async (key, field, value) => {
      // 只让昵称键失败；占座 `claimSeat` 的 hsetnx 必须照常工作，
      // 否则 fillBots 会先失败，测不到昵称写入路径。
      if (key === nicknamesKey('ROOM13')) throw new Error('nickname write failed');
      return original(key, field, value);
    });

    expect(await service.startRoom('ROOM13', { strict: true })).toBe(true);
    expect(calls.some((c) => c.pattern === RPC_PATTERNS.gameStart)).toBe(true);
  });

  /** 正对照：`seat` 助手与真实 `Room.players` 的形状一致（防止 fixture 漂移）。 */
  it('正对照：join 落的座位形状 = seat() 夹具', async () => {
    await rooms.create({ mode: 'practice', roomCode: 'ROOM11' });
    await rooms.join('ROOM11', 'u1');
    expect((await rooms.findOne('ROOM11'))!.players).toEqual([seat('u1', 0)]);
  });

  /**
   * **§4 清单落盘**（片⑥ · spec §4 / §6 的「声明落盘」判据）—— **机械闸**，防回归。
   *
   * 那三件事（给临界区加 `SET NX EX` / 两条回收循环标注「无需锁」/ 复核进程内状态）
   * 本片**不实施**（R1005），但必须**写在读代码的人一定会经过的地方** ——
   * 也就是 `rooms.start.ts` 的 `startRoom` 方法头。
   *
   * ⚠️ 为什么要一条**源码闸**而不是只写注释：本仓的教训是「标题声称有、判据没有」
   *（N36 那次改名），以及「说明书与实现漂移」。清单里第 3 条更是**已知未覆盖项**，
   * 它一旦被无声删掉，下一个人就会以为「多实例已经核过了」。改措辞就会红，是**故意**的。
   */
  it('§4 清单落盘：三件事写在 `rooms.start.ts` 的 startRoom 头上（spec §6）', () => {
    const source = readFileSync(join(process.cwd(), 'src/rooms/rooms.start.ts'), 'utf-8');
    const items = [
      ['SET NX EX', '清单第 1 条：给「判 waiting → 补位 → 开局」加 SET NX EX'],
      ['无需锁', '清单第 2 条：两条回收循环明确标注「无需锁」'],
      ['未覆盖', '清单第 3 条：两个服务的进程内状态是**已知未覆盖项**'],
    ] as const;
    for (const [token, what] of items) {
      expect(source, `${what}（令牌「${token}」不在源码里）`).toContain(token);
    }
    // 位置也要钉：它必须挂着**唯一临界区**（`startRoom`），而不是飘在文件尾巴上
    const startRoomAt = source.indexOf('async startRoom(');
    const listAt = source.indexOf('真上多实例时才要做的事');
    expect(listAt, '清单不见了').toBeGreaterThan(0);
    expect(listAt, '清单必须在 startRoom 的方法头里（那里才是唯一的临界区）').toBeLessThan(startRoomAt);
  });

  // ─── 监控片 T3（规格 §2.2）：games_started_total 的「确实开起来了」点 ─────────────
  //
  // 判据形态与整份文件同族：**基建级**「某方法被调过」不算数，落点取**返回点 + 状态落盘**。
  // ⚠️ 计数是模块级单例 ⇒ 一律取「动作前基线 → 动作 → 基线 ± 期望」的差值判据。

  it('监控片：开局成功（满员、game.start 成功）⇒ games_started_total +1', async () => {
    await manualRoom('MTRX01', ['u1', 'u2', 'u3']);
    const before = (await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' })) ?? 0;

    const ok = await service.startRoom('MTRX01', { strict: true });

    expect(ok).toBe(true);
    expect((await rooms.findOne('MTRX01'))!.status, '正对照：确实开起来了').toBe('playing');
    expect(await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' })).toBe(before + 1);
  });

  it('监控片：strict:false 且 game.start 失败（N36 假开局：写 playing 但无会话）⇒ **不**计入', async () => {
    await manualRoom('MTRX02', ['u1', 'u2', 'u3']);
    handlers.set(RPC_PATTERNS.gameStart, () => throwError(() => new Error('down')));
    const before = (await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' })) ?? 0;

    const ok = await service.startRoom('MTRX02', { strict: false });

    expect(ok).toBe(false);
    expect((await rooms.findOne('MTRX02'))!.status, '反空测：N36 的落盘形态仍在（照旧写 playing）').toBe(
      'playing',
    );
    expect(
      await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' }),
      '没有会话的假开局不得进计数（否则 started−ended 会把永不结算的局带上）',
    ).toBe(before);
  });

  it('监控片：重复开局（已是 playing、startRoom 早返 false）⇒ 不重复计数（幂等）', async () => {
    await manualRoom('MTRX03', ['u1', 'u2', 'u3']);
    expect(await service.startRoom('MTRX03', { strict: true })).toBe(true);
    const afterFirst = (await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' })) ?? 0;

    expect(await service.startRoom('MTRX03', { strict: true })).toBe(false);

    expect(await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' })).toBe(afterFirst);
  });

  it('A1：开局成功按 game_type=doudizhu 计数（精确标签）', async () => {
    await manualRoom('A1S01', ['u1', 'u2', 'u3']);
    const before = (await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' })) ?? 0;

    expect(await service.startRoom('A1S01', { strict: true })).toBe(true);

    expect(await exactSeriesValue(gamesStartedTotal, { game_type: 'doudizhu' })).toBe(before + 1);
  });

  it('A1：start_rpc 失败恰计一次', async () => {
    await manualRoom('A1S02', ['u1', 'u2', 'u3']);
    handlers.set(RPC_PATTERNS.gameStart, () => throwError(() => new Error('down')));
    const before = (await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'doudizhu', reason: 'start_rpc',
    })) ?? 0;

    expect(await service.startRoom('A1S02', { strict: true })).toBe(false);

    expect(await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'doudizhu', reason: 'start_rpc',
    })).toBe(before + 1);
  });

  it('A1：ddz onSeats 失败计 reason=on_seats', async () => {
    await manualRoom('A1S03', ['u1', 'u2', 'u3']);
    const before = (await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'doudizhu', reason: 'on_seats',
    })) ?? 0;

    const outcome = await service.startRoomOutcome('A1S03', {
      strict: false,
      onSeats: async () => { throw new Error('hook down'); },
    });

    expect(outcome).toBe('fatal');
    expect(await exactSeriesValue(gameStartFailuresTotal, {
      game_type: 'doudizhu', reason: 'on_seats',
    })).toBe(before + 1);
  });

/**
 * ② 金币场 T5（规格 §2.3 / 设计 D7）：**金币房开局三座余额下发**。
 *
 * 语义（写进判据）：
 *  - 仅 **gold** 房做一次 `currency.get`（免费场/好友房**零资金调用**）；
 *  - ownerId 真源：人类 `userId` / 机器人**内部** `botId`（`Seat.userId` 是出站 `displayId`，
 *    资金面绝不使用）；
 *  - 写入派生键 `room:{code}:balances`（TTL = 房间 TTL），且**先于** `room.matched` 公告
 *    （客户端收到公告立刻 `room.join` ⇒ 键必须先就位）；
 *  - 读失败 ⇒ WARN + **不写键**（= 省略 `RoomPlayer.balance` 字段）+ **不阻塞开局**。
 */
describe('② T5：金币房开局三座余额下发（room:{code}:balances）', () => {
  it('gold 房：一次 get（ownerIds=人类 userId + 机器人 botId）⇒ 按座位落盘 + TTL + 先于公告', async () => {
    await rooms.create({ mode: 'gold', roomCode: 'GOLD01' });
    await rooms.join('GOLD01', 'u1');
    currency.get.mockImplementation(async (req: { ownerIds: string[] }) => ({
      balances: req.ownerIds.map((ownerId) => ({
        ownerId,
        balance: ownerId === 'u1' ? 12345 : 6789,
        exists: true,
      })),
    }));

    const ok = await service.startRoom('GOLD01', { strict: true });

    expect(ok).toBe(true);
    expect(currency.get).toHaveBeenCalledTimes(1);
    expect(currency.get).toHaveBeenCalledWith({ ownerIds: ['u1', 'bot-1', 'bot-2'] });
    expect(await redis.hgetall(roomBalancesKey('GOLD01'))).toEqual({
      '0': '12345',
      '1': '6789',
      '2': '6789',
    });
    expect(await redis.ttl(roomBalancesKey('GOLD01'))).toBeGreaterThan(0);
    // 键必须先于 room.matched 公告就位（否则客户端首拉竞态恒「—」）
    const writeIdx = (redis.hset as ReturnType<typeof vi.fn>).mock.invocationCallOrder.find(
      (_, i) => (redis.hset as ReturnType<typeof vi.fn>).mock.calls[i]![0] === roomBalancesKey('GOLD01'),
    )!;
    const publishIdx = (redis.publish as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(writeIdx).toBeLessThan(publishIdx);
  });

  it('非金币场（practice）：**零资金调用**、无 balances 键', async () => {
    await manualRoom('FREE01', ['u1']);

    const ok = await service.startRoom('FREE01', { strict: true });

    expect(ok).toBe(true);
    expect(currency.get).not.toHaveBeenCalled();
    expect(await redis.hgetall(roomBalancesKey('FREE01'))).toEqual({});
  });

  it('读失败 ⇒ WARN + 不写键（省略字段）+ **开局照常**（读失败不同级于资金安全）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
    try {
      await rooms.create({ mode: 'gold', roomCode: 'GOLD02' });
      await rooms.join('GOLD02', 'u1');
      currency.get.mockRejectedValue(new Error('currency-service down'));

      const ok = await service.startRoom('GOLD02', { strict: true });

      expect(ok, '读失败不得阻塞开局').toBe(true);
      expect((await rooms.findOne('GOLD02'))!.status).toBe('playing');
      expect(await redis.hgetall(roomBalancesKey('GOLD02')), '省略字段 = 不写键').toEqual({});
      expect(records.some((r) => r.msg.includes('Gold balance read failed'))).toBe(true);
    } finally {
      Logger.overrideLogger(new Logger());
    }
  });
});

/**
 * ② 金币场 T6（规格 §7 上半 / C22）：**补位后、`game.start` 前的机器人注资（ensure）**。
 *
 * 接缝判据（本 describe 的四个方向）：
 *  - gold + 有补位 ⇒ `ensureBots(内部 botId 列表)`（座位序；**先于** `game.start`、
 *    **后于** 绑定表落盘 —— 归池路径要靠那张表）；
 *  - 非 gold（哪怕补了机器人）⇒ 零调用；gold 房满无补位 ⇒ 零调用（没有机器人就没有资金动作）；
 *  - ensure 抛（替身）⇒ `fillBots` null ⇒ `startRoom` false、房间留 `waiting`、不 announce、
 *    不 `game.start`（既有补位失败路径；匹配侧 cancel + attempts 由 match.service 侧承载）；
 *  - **真链路**（真 `RobotFunding` + 读边故障）⇒ 同一传播链（变异自证：ensure 若吞错 ⇒ 必红）。
 */
describe('② T6：金币场补位后的机器人 ensure（fillBots 接入）', () => {
  it('gold 房补位 ⇒ ensureBots(内部 botId, 座位序)，先于 game.start、后于绑定表落盘', async () => {
    await rooms.create({ mode: 'gold', roomCode: 'GOLD11' });
    await rooms.join('GOLD11', 'u1');

    const ok = await service.startRoom('GOLD11', { strict: true });

    expect(ok).toBe(true);
    expect(robotFunding.ensureBots).toHaveBeenCalledTimes(1);
    // 内部 botId（rpcStub 的 acquire 产物 = `bot-<seat>`），**不是**出站 displayId（p_…）
    expect(robotFunding.ensureBots).toHaveBeenCalledWith(['bot-1', 'bot-2'], 'doudizhu');
    // 顺序①：ensure 在 game.start 之前（资金到位先于开局）
    const ensureOrder = robotFunding.ensureBots.mock.invocationCallOrder[0]!;
    const startIdx = calls.findIndex((c) => c.pattern === RPC_PATTERNS.gameStart);
    expect(startIdx, '反空测：game.start 真的发过了').toBeGreaterThanOrEqual(0);
    const startOrder = rpcSend.mock.invocationCallOrder[startIdx]!;
    expect(ensureOrder, 'ensure 必须先于 game.start').toBeLessThan(startOrder);
    // 顺序②：绑定表先落盘（ensure 抛 ⇒ fillBots null 时，取消/归池路径要靠它认领机器人）
    const bindIdx = (redis.hset as ReturnType<typeof vi.fn>).mock.calls.findIndex(
      ([key]) => key === botsKey('GOLD11'),
    );
    expect(bindIdx, '反空测：绑定表真的写过了').toBeGreaterThanOrEqual(0);
    const bindOrder = (redis.hset as ReturnType<typeof vi.fn>).mock.invocationCallOrder[bindIdx]!;
    expect(bindOrder, '绑定表必须先于 ensure 落盘').toBeLessThan(ensureOrder);
  });

  it('非金币场（practice，哪怕补了机器人）⇒ ensureBots 零调用（零资金调用纪律）', async () => {
    await manualRoom('FREE11', ['u1']);

    const ok = await service.startRoom('FREE11', { strict: true });

    expect(ok).toBe(true);
    expect((await rooms.findOne('FREE11'))!.players.filter((p) => p.isRobot).length, '反空测：真的补了机器人').toBe(2);
    expect(robotFunding.ensureBots).not.toHaveBeenCalled();
  });

  it('gold 房房满（3 人类 ⇒ 无补位）⇒ ensureBots 零调用（没有机器人就没有资金动作）', async () => {
    await rooms.create({ mode: 'gold', roomCode: 'GOLD12' });
    await rooms.join('GOLD12', 'u1');
    await rooms.join('GOLD12', 'u2');
    await rooms.join('GOLD12', 'u3');

    const ok = await service.startRoom('GOLD12', { strict: true });

    expect(ok).toBe(true);
    expect(robotFunding.ensureBots).not.toHaveBeenCalled();
  });

  it('🔴 C22：ensure 抛 ⇒ fillBots null ⇒ startRoom false、房间留 waiting、不 announce、不 game.start', async () => {
    await rooms.create({ mode: 'gold', roomCode: 'GOLD13' });
    await rooms.join('GOLD13', 'u1');
    robotFunding.ensureBots.mockRejectedValue(new Error('robot pool empty'));

    const ok = await service.startRoom('GOLD13', { strict: true });

    expect(ok).toBe(false);
    expect((await rooms.findOne('GOLD13'))!.status, '资金没到位 ⇒ 绝不开局').toBe('waiting');
    expect(announced(), '开局失败不得通知玩家').toHaveLength(0);
    expect(calls.filter((c) => c.pattern === RPC_PATTERNS.gameStart), '不得调 game.start').toHaveLength(0);
  });

  it('🔴 真链路（真 RobotFunding + 读边故障）：ensure 的失败一路穿到 startRoom false（变异自证锚）', async () => {
    const currencyDown = {
      get: vi.fn().mockRejectedValue(new Error('currency-service down')),
      apply: vi.fn(),
    };
    const funding = new RobotFunding(
      currencyDown as never,
      asConfigCache(makeConfigCache()) as never,
    );
    const serviceWithRealFunding = new RoomStartService(
      asRedis(redis) as Redis,
      rooms,
      new GameClient(rpcStub()),
      new RobotClient(rpcStub()),
      currencyDown as never,
      funding,
      // 断点④修复（Task 5）：重连记录写边 —— 本用例断言与它无关 ⇒ 轻替身（零副作用）。
      { touch: vi.fn().mockResolvedValue(undefined) } as unknown as ReconnectService,
      // 本片：台费费率表读边（与 beforeEach 同一桩实例）。
      asConfigCache(configCache),
    );
    await rooms.create({ mode: 'gold', roomCode: 'GOLD14' });
    await rooms.join('GOLD14', 'u1');

    const ok = await serviceWithRealFunding.startRoom('GOLD14', { strict: true });

    expect(ok).toBe(false);
    expect((await rooms.findOne('GOLD14'))!.status).toBe('waiting');
    // 反空测：ensure 的读边真的走到了（且真源是**内部** botId）
    expect(currencyDown.get).toHaveBeenCalledWith({ ownerIds: ['bot-1', 'bot-2'] });
    expect(calls.filter((c) => c.pattern === RPC_PATTERNS.gameStart), '不得调 game.start').toHaveLength(0);
  });
});

/**
 * §4.4（设计 v1.3.1 / 断点④）：**开局为人类座位写重连记录**。
 *
 * 断点④：匹配后**从未** `room.join` 的玩家（错过 `room.matched`）在 `match:pending`
 * 票过期（300s TTL）之后就没有任何补回依据 —— 开局时同步写 `reconnect:active` 哈希后，
 * resolver（规格 §2.2）的 record 候选兜住这个窗口（哈希不设 TTL；过期概念已退役）。
 *
 * 判据落点（与 ①「写凭据」同族）：
 *  - 人类座位写哈希（`socketId: ''` —— 此刻没有本进程的 socket），机器人**不写**
 *    （沿用同一份 `humanSeats` 谓词 —— 两处各写一份过滤就迟早漂移）；
 *  - 与 `match:pending` **同循环**、**先 pending 后哈希**，且先于 announce 与 `game.start`
 *    （同一条「补位成功、开局之前」的窗口）；顺序用调用序钉，不是「方法被调过」；
 *  - 写失败 ⇒ 与 ① 同款处置：log + `return false`（房间留 `waiting` 等下轮重试；吞异常
 *    会让「毒键 ⇒ 降级」与「补位失败不丢人」一类判据变成空测）。
 */
describe('§4.4：开局为人类座位写重连记录（断点④）', () => {
  it('人类座位写哈希（socketId 空串），机器人不写；与 pending 同循环、先 pending 后哈希', async () => {
    await manualRoom('RCON01', ['u1']);

    const ok = await service.startRoom('RCON01', { strict: true });

    expect(ok).toBe(true);
    const raw = await redis.hget(RECONNECT_HASH_KEY, 'u1');
    expect(raw, '人类座位必须写重连记录').not.toBeNull();
    const parsed = JSON.parse(raw!) as { socketId: string; roomCode: string; connectedAt: number };
    expect(parsed).toMatchObject({ socketId: '', roomCode: 'RCON01' });
    expect(typeof parsed.connectedAt, '§2.1：在线观测点字段必须落盘（不是入房时刻的语义）').toBe('number');
    // 机器人**不写**（R47 同族 —— 与 pending/announce 共用一份 humanSeats 谓词）
    const bots = (await rooms.findOne('RCON01'))!.players.filter((p) => p.isRobot);
    expect(bots.length, '反空测：真的补进了机器人').toBe(2);
    for (const bot of bots) {
      expect(
        await redis.hget(RECONNECT_HASH_KEY, bot.userId),
        `机器人 ${bot.userId} 不得写重连记录`,
      ).toBeNull();
    }
    // 强断言：哈希里**只有**人类那一个字段（「循环里逐个 null」证不了「没有多余字段」）
    expect(Object.keys(redis.hashes.get(RECONNECT_HASH_KEY) ?? {})).toEqual(['u1']);
    // 位置契约①：同循环、先 pending 后哈希（沿用 ① 的调用序判据 —— findIndex 反映真实调用序）
    const pendingAt = redis.hset.mock.calls.findIndex(([key]) => key === 'match:pending:u1');
    const hashAt = redis.hset.mock.calls.findIndex(
      ([key, field]) => key === RECONNECT_HASH_KEY && field === 'u1',
    );
    expect(pendingAt, '反空测：pending 真的写过了').toBeGreaterThanOrEqual(0);
    expect(hashAt, '反空测：哈希真的写过了').toBeGreaterThanOrEqual(0);
    expect(hashAt, '先 pending 后哈希').toBeGreaterThan(pendingAt);
    // 位置契约②：哈希先于 announce 与 game.start（与 ① 凭据同一条窗口）
    const hashOrder = redis.hset.mock.invocationCallOrder[hashAt]!;
    const startAt = calls.findIndex((c) => c.pattern === RPC_PATTERNS.gameStart);
    expect(startAt, '反空测：game.start 真的发过了').toBeGreaterThanOrEqual(0);
    expect(hashOrder, '哈希写入必须先于 announce（room.matched 的发送前提）').toBeLessThan(
      redis.publish.mock.invocationCallOrder[0]!,
    );
    expect(hashOrder, '哈希写入必须先于 game.start').toBeLessThan(
      rpcSend.mock.invocationCallOrder[startAt]!,
    );
  });

  it('哈希写失败 ⇒ log + return false，房间留 waiting、不 announce、不 game.start', async () => {
    await manualRoom('RCON02', ['u1']);
    // 与 ① 裁决 E 同形：直接让写边 reject（真实形态 = 连接级 Redis 故障）。
    const reconnectDown = { touch: vi.fn().mockRejectedValue(new Error('redis down')) };
    const serviceWithBrokenReconnect = new RoomStartService(
      asRedis(redis) as Redis,
      rooms,
      new GameClient(rpcStub()),
      new RobotClient(rpcStub()),
      currency as never,
      robotFunding as never,
      reconnectDown as unknown as ReconnectService,
      // 本片：台费费率表读边（与 beforeEach 同一桩实例）。
      asConfigCache(configCache),
    );

    const ok = await serviceWithBrokenReconnect.startRoom('RCON02', { strict: true });

    expect(ok).toBe(false);
    expect((await rooms.findOne('RCON02'))!.status, '哈希写失败 ⇒ 绝不开局').toBe('waiting');
    expect(announced(), '开局失败不得通知玩家').toHaveLength(0);
    expect(calls.filter((c) => c.pattern === RPC_PATTERNS.gameStart), '不得调 game.start').toHaveLength(0);
    // 反空测：真的走到了写点 —— pending（先写的那一行）已落盘，失败的是哈希那一步
    expect(reconnectDown.touch).toHaveBeenCalledWith('u1', '', 'RCON02');
    expect(redis.hashes.get('match:pending:u1'), '先 pending 后哈希：pending 已落、哈希失败').toEqual({
      roomCode: 'RCON02',
      seat: '0',
    });
  });
});

/**
 * P0-2 回归：**开局失败后的重试不得丢机器人身份**。
 *
 * 机制：首次 `startRoom` 已把机器人补满座（`room.players.length >= maxPlayers`），
 * 若 `game.start` / `robotFunding.ensureBots` 失败 ⇒ 重试走 `fillBots` 的「房满早退」
 *（`bindings: []`），而 `buildStartPlayers` 只按**本次** bindings 装饰 ⇒ 机器人缺
 * `botId`/`skillLevel` ⇒ game-service 的 `driveRobotTurn` 起不来，机器人永久不动。
 *
 * 判据：失败一次后重试成功 ⇒ `game.start` 载荷里的机器人仍带完整身份；
 * 金币场重试还会重新执行此前失败的 `ensureBots`。
 */
describe('P0-2：开局失败后的重试仍带机器人身份', () => {
  it('game.start 首次失败 ⇒ 重试时已入座机器人仍带 botId/skillLevel/thinkingSpeed', async () => {
    await manualRoom('RETRY01', ['u1']);
    // `GameClient.start` 内部恰好重试 1 次 ⇒ 首次 `startRoom` 要连续失败 2 次才返回 false。
    let remainingFailures = 2;
    handlers.set(RPC_PATTERNS.gameStart, () => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return throwError(() => new Error('game-service down'));
      }
      return of({ ok: true, data: {} });
    });

    expect(await service.startRoom('RETRY01', { strict: true })).toBe(false);
    // 失败前补位已完成：房已满（1 人 + 2 机器人），重试必然走「房满早退」。
    expect((await rooms.findOne('RETRY01'))!.players).toHaveLength(3);

    expect(await service.startRoom('RETRY01', { strict: true })).toBe(true);

    const startCalls = calls.filter((c) => c.pattern === RPC_PATTERNS.gameStart);
    // 首次 2 次（内建重试）全失败 + 重试 1 次成功。
    expect(startCalls).toHaveLength(3);
    const retryPlayers = (startCalls.at(-1)!.data as { players: Array<Record<string, unknown>> })
      .players;
    const robots = retryPlayers.filter((p) => p.isRobot === true);
    expect(robots).toHaveLength(2);
    for (const robot of robots) {
      expect(robot.botId, `重试载荷缺 botId：${JSON.stringify(robot)}`).toMatch(/^bot-/);
      expect(robot.skillLevel).toBe('beginner');
      expect(robot.thinkingSpeed).toBe(900);
      expect(robot.id).toMatch(/^p_/);
    }
  });

  it('ensureBots 首次失败（gold）⇒ 重试时恢复机器人身份并重跑 ensure', async () => {
    await rooms.create({ mode: 'gold', roomCode: 'RETRY02' });
    await rooms.join('RETRY02', 'u1');
    robotFunding.ensureBots.mockRejectedValueOnce(new Error('robot pool empty'));

    expect(await service.startRoom('RETRY02', { strict: true })).toBe(false);
    expect((await rooms.findOne('RETRY02'))!.players).toHaveLength(3);

    expect(await service.startRoom('RETRY02', { strict: true })).toBe(true);

    // 重试必须重新为同一批内部 botId 注资（首次失败的那一步不能因「房满早退」被跳过）。
    expect(robotFunding.ensureBots).toHaveBeenCalledTimes(2);
    expect(robotFunding.ensureBots.mock.calls.at(-1)![0]).toEqual(['bot-1', 'bot-2']);

    const robots = (
      calls.filter((c) => c.pattern === RPC_PATTERNS.gameStart).at(-1)!.data as {
        players: Array<Record<string, unknown>>;
      }
    ).players.filter((p) => p.isRobot === true);
    expect(robots).toHaveLength(2);
    for (const robot of robots) {
      expect(robot.botId).toMatch(/^bot-/);
      expect(robot.skillLevel).toBe('beginner');
    }
  });
});
});

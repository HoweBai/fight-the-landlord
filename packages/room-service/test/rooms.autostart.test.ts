import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import type { Redis } from 'ioredis';
import { RPC_PATTERNS, type BotInstance } from '@fight-the-landlord/protocol';
import { RoomsAutostartTask } from '../src/rooms/rooms.autostart';
import { RoomStartService } from '../src/rooms/rooms.start';
// 断点④修复（本片 Task 5 · 设计 v1.3.1 §4.4）：`RoomStartService` 新增第 7 个构造参数
// `reconnect`（开局为人类座位写重连记录）—— 本文件断言与它无关 ⇒ 轻替身（零副作用）。
import { ReconnectService } from '../src/reconnect/reconnect.service';
import { RoomsService } from '../src/rooms/rooms.service';
import { GameClient } from '../src/gateway/game.client';
import { RobotClient } from '../src/gateway/robot.client';
import { seatsKey } from '../src/rooms/rooms.seats';
import { MANUAL_FILL_MIN_WAIT_MS, MANUAL_ROOM_TIMEOUT_MS } from '../src/rooms/rooms.timeout';
import { asRedis, createFakeRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';

/**
 * 自动开局扫描器（本片 · spec §2.1 / §3.3 / R901）。
 *
 * 它只做三件事，**判据也落在三件事上**：
 *   ① 满座 ⇒ 开局（**立即**，不等死线 —— 用户裁决「房间满即开局」）；
 *   ② 缺人且**未越死线** ⇒ 什么都不做（正对照：这条防「提前补位」）；
 *   ③ 缺人且**已越死线** ⇒ 开局（`RoomStartService` 内部会先补位）。
 *
 * ⚠️ 它**不自己补位/开局**：一律委托 `RoomStartService.startRoom` —— 那是两条路径共用的
 * 唯一开局链（`playing` 的写入点因此只有一处）。
 */
/**
 * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原的话，
 * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到自己的
 * 日志行）。还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

describe('RoomsAutostartTask：满就开、不满等死线', () => {
  let redis: FakeRedis;
  let rooms: RoomsService;
  let cache: ConfigCacheStub;
  let startRoom: ReturnType<typeof vi.fn>;
  let task: RoomsAutostartTask;
  const T0 = 1_700_000_000_000;
  /** 桩的 `cycleMs` 缺省 = `CYCLE_MS_DEFAULTS['room.autostartIntervalMs']`（5000）。 */
  const SCAN_MS = 5_000;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createFakeRedis();
    cache = makeConfigCache();
    rooms = new RoomsService(asRedis(redis), asConfigCache(cache));
    rooms.setClock(() => T0);
    rooms.setRandom(() => 0); // 死线 = T0 + 20s（注入随机源 ⇒ 判据可判，R914）
    startRoom = vi.fn().mockResolvedValue(true);
    task = new RoomsAutostartTask(rooms, { startRoom } as never, asConfigCache(cache));
  });

  /** 造一个手动房 + 若干人类座位（与 `POST /api/rooms` 的产物同形）。 */
  async function manualRoom(code: string, humans: string[]): Promise<void> {
    await rooms.create({ mode: 'practice', roomCode: code }, { timeoutMs: MANUAL_ROOM_TIMEOUT_MS });
    await rooms.resetWaitingWindow(code); // 落死线 = T0 + 20s
    for (const id of humans) await rooms.join(code, id);
  }

  it('满座 ⇒ 立刻开局（不等死线）', async () => {
    await manualRoom('FULL01', ['u1', 'u2', 'u3']);

    await task.scanOnce();

    expect(startRoom).toHaveBeenCalledWith('FULL01', { strict: true });
  });

  it('缺人 + **未越死线** ⇒ 什么都不做（正对照：不得提前补位）', async () => {
    await manualRoom('WAIT01', ['u1']);
    rooms.setClock(() => T0 + MANUAL_FILL_MIN_WAIT_MS - 1); // 差 1ms 到死线

    await task.scanOnce();

    expect(startRoom, '死线之前一个房间都不该开').not.toHaveBeenCalled();
  });

  it('缺人 + **已越死线** ⇒ 交给开局链（它内部补位）', async () => {
    await manualRoom('FILL01', ['u1']);
    rooms.setClock(() => T0 + MANUAL_FILL_MIN_WAIT_MS); // 正好到死线

    await task.scanOnce();

    expect(startRoom).toHaveBeenCalledWith('FILL01', { strict: true });
  });

  it('延迟抽查：先抽一次死线就**落盘**了 —— 后续扫描读的是同一个值（不漂移）', async () => {
    await manualRoom('DRIFT1', ['u1']);
    expect(await rooms.readFillDeadline('DRIFT1')).toBe(T0 + MANUAL_FILL_MIN_WAIT_MS);
    // 换个随机源也不会改变已经落盘的死线（这正是「不能每轮现抽」的意思）
    rooms.setRandom(() => 0.99);
    expect(await rooms.readFillDeadline('DRIFT1')).toBe(T0 + MANUAL_FILL_MIN_WAIT_MS);
  });

  it('不给**没有死线**的房间开局（匹配建的房间不该被本扫描器碰）', async () => {
    // 匹配路径的房间：`createGameRoom` 走 `create()` 的**缺省**窗口、且**不写死线**
    await rooms.create({ mode: 'random', roomCode: 'MATCH1' }, { timeoutMs: 1_000 });
    await rooms.join('MATCH1', 'u1');

    await task.scanOnce();

    expect(startRoom, '没有死线的房间不是本扫描器的事').not.toHaveBeenCalled();
  });

  it('`playing` 房间一律跳过（幂等：第二轮扫到它时它已经开着了）', async () => {
    await manualRoom('PLAYED', ['u1', 'u2', 'u3']);
    await rooms.updateStatus('PLAYED', 'playing');

    await task.scanOnce();

    expect(startRoom).not.toHaveBeenCalled();
  });

  it('空房（0 人）不开局 —— 没人在等，开了也没意义', async () => {
    await manualRoom('EMPTY1', []);

    await task.scanOnce();

    expect(startRoom).not.toHaveBeenCalled();
  });

  it('单个房间失败不拖垮整轮（后面的房间照样被扫到）', async () => {
    await manualRoom('FULL01', ['u1', 'u2', 'u3']);
    await manualRoom('FULL02', ['u4', 'u5', 'u6']);
    startRoom.mockImplementation(async (code: string) => {
      if (code === 'FULL01') throw new Error('boom');
      return true;
    });

    await expect(task.scanOnce()).resolves.toBeUndefined();

    expect(startRoom).toHaveBeenCalledWith('FULL02', { strict: true });
  });

  /**
   * ⚠️ **T7 起周期来自配置缓存**（T6 的 `cycleMs`；env 常量 `AUTOSTART_SCAN_INTERVAL_MS` 已退役）
   * —— 本文件只钉「读的是**自己那个键**」（copy-paste 写成别人的键时本组当场红）；
   * 「改值 ⇒ 下一轮生效」的口径由 `config-cache.test.ts` 的 C9 组断言。
   */
  it('扫描周期来自配置缓存，键 = room.autostartIntervalMs（env 常量已退役，T7）', () => {
    task.startScanLoop();
    expect(cache.cycleMs, '循环必须读自己那个键（读错键 = 改了不生效）').toHaveBeenCalledWith(
      'room.autostartIntervalMs',
    );
    task.onApplicationShutdown();
  });

  it('onModuleInit 起循环、shutdown 停掉（照 RoomsReaperTask 的成例）', async () => {
    // ⚠️ 先造一个**该开**的房间：否则「定时器真的在跑」这条判据会因为没有可开的房间而空测
    await manualRoom('FULL01', ['u1', 'u2', 'u3']);
    vi.useFakeTimers();
    try {
      const t = new RoomsAutostartTask(rooms, { startRoom } as never, asConfigCache(cache));
      t.onModuleInit();
      await vi.advanceTimersByTimeAsync(SCAN_MS);
      expect(startRoom, '定时器真的在跑（不是死代码）').toHaveBeenCalled();
      t.onApplicationShutdown();
      const calls = startRoom.mock.calls.length;
      await vi.advanceTimersByTimeAsync(SCAN_MS * 3);
      expect(startRoom.mock.calls.length, 'shutdown 之后不得再扫').toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 判据 11（单测半边）：扫描器链路 `source: 'timer'`（R1107）──────────────
  //
  // 与 `rooms.reaper.test.ts` 的那条**同形**（room-service 的两条扫描器是同一种入口，
  // 因此同一形状的包裹、同一形状的判据）。观测口借**失败路径**的 error 行：
  // `scanOnce` 的成功路径自己不打日志，而「一轮扫描期间有上下文」需要一个真实的日志行
  // 来承载（否则断言无从落点）。
  it('判据 11：扫描一轮里打的日志带 source=timer 且 traceId 非空', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

    await manualRoom('TIMER1', ['u1', 'u2', 'u3']);
    startRoom.mockRejectedValueOnce(new Error('boom'));

    await task.scanOnce();

    // 反空测：这一轮必须**真的**扫到了这个房间并走到了开局链（否则那条 error 行无从产生）
    expect(startRoom, '这一轮必须真的走到了开局链（否则断言的是空）').toHaveBeenCalledWith(
      'TIMER1',
      { strict: true },
    );
    const line = records.find((r) => r.msg.includes('Autostart failed for room TIMER1'));
    expect(line, '被拒那行 error 必须在（否则本判据空转）').toBeDefined();
    expect(line!.source).toBe('timer');
    expect(line!.traceId).not.toBeNull();
  });
});

/**
 * **W1（片⑥ · spec §3.2）**：两个自动开局扫描器**并发**扫同一个房间。
 *
 * 判据取**不变量**：`playerCount ≤ 3`、最终 `playing`、**不得** `cancelled`。
 * ⚠️ **不**断言「恰好一个赢」（spec §0.3）：满员房不需要补位 ⇒ 两条链都会 `game.start`
 *（幂等，不会开两次局）⇒ **两个都成功是允许的**。
 *
 * ⚠️ 与上面那组的区别：那里 `startRoom` 是**替身**（只能断言「它被调了」）；这里装配的是
 * **真实的** `RoomStartService`（`findOne` / `addBot` / `updateStatus` 都真的读写假 Redis）
 * ⇒ 「最终 `playing`」是一条**落盘**断言，而不是「某个方法被调过」。
 *
 * ⚠️ 这两条**今天就是绿的**（`HSETNX` 占座 + 幂等开局本来就兜住了）。它们的价值是**钉住**
 * 那个不变量：将来有人把 `claimSeat` 改回「读 → 改 → 写」、或让开局链自己取消房间时，
 * 这里会先红 —— 而那时距离「房间变终态、玩家还坐在里面」只差一次线上事故。
 */
describe('W1：两个自动开局扫描器并发（片⑥ · spec §3.2）', () => {
  let redis: FakeRedis;
  let rooms: RoomsService;
  let cache: ConfigCacheStub;
  let calls: Array<{ pattern: string; data: unknown }>;
  const T0 = 1_700_000_000_000;

  /**
   * 一条机器人的完整形状（§3.4）。
   *
   * ⚠️ `displayId` 的两种形态对应**两种都真实存在**的拓扑（这不是「随便造个假」）：
   *  - `seatOnly = true`（缺省）：按**座位号**派生 ⇒ 同一座位总是同一个机器人 ——
   *    单实例下 `robot.acquire` 对 `{roomCode, seat}` 是幂等的（R201），扫描器只会看见这种；
   *  - `seatOnly = false`：**每次调用**给一个新机器人 —— 多实例下（或同一座位被两次
   *    `acquire` 真并发）robot-service 的 `findBound → takeIdle` 不是原子的，
   *    两个调用方**会**拿到**不同**的机器人（`bot:room` 的座位索引被后写的覆盖）。
   *    ⇒ 后者是**更苛刻**的那一种，兜住它的只能是 `claimSeat` 的 `HSETNX`。
   */
  const botOf = (seatNo: number, seq?: number): BotInstance => ({
    botId: seq === undefined ? `bot-${seatNo}` : `bot-seq-${seq}`,
    displayId: seq === undefined ? `p_${String(seatNo).padStart(8, '0')}` : `p_seq${String(seq).padStart(5, '0')}`,
    skillLevel: 'beginner',
    personality: { thinkingSpeed: 900 },
    roomCode: 'W1ROOM',
    seat: seatNo,
    gamesPlayed: 0,
  });

  /** 每次 `robot.acquire` 自增（`seatOnly = false` 时用它给「每次一个新机器人」编号）。 */
  let botSeq = 0;

  /** 一个**独立**的扫描器：自己的 `RoomStartService`（= 另一个实例），共享同一份假 Redis。 */
  function makeScanner(seatOnly = true): RoomsAutostartTask {
    const send = vi.fn((pattern: string, data: unknown) => {
      calls.push({ pattern, data });
      if (pattern === RPC_PATTERNS.robotAcquire) {
        const seats = (data as { seats?: number[] }).seats ?? [1];
        botSeq += 1;
        const seq = botSeq;
        return of({ ok: true, data: { bots: seats.map((s) => botOf(s, seatOnly ? undefined : seq)) } });
      }
      return of({ ok: true, data: {} });
    });
    const proxy = { send } as never;
    const start = new RoomStartService(
      asRedis(redis) as Redis,
      rooms,
      new GameClient(proxy),
      new RobotClient(proxy),
      // ② T5：金币边（本文件的房全走 practice/random ⇒ 零调用）。
      { get: vi.fn(), apply: vi.fn() } as never,
      // ② T6：机器人资金面（同上 —— 非金币场零调用）。
      { ensureBots: vi.fn(), afterSettle: vi.fn() } as never,
      // 断点④修复（Task 5）：重连记录写边 —— 轻替身（本文件断言与它无关）。
      { touch: vi.fn().mockResolvedValue(undefined) } as unknown as ReconnectService,
      // 本片：台费费率表读边（本文件的房全走 practice/random + 缺省 stub 4 行 ×0 ⇒ 短路）。
      asConfigCache(cache),
    );
    return new RoomsAutostartTask(rooms, start, asConfigCache(cache));
  }

  /** 造一个手动房 + 若干人类座位 + 落补位死线（与 `POST /api/rooms` 的产物同形）。 */
  async function manualRoom(code: string, humans: string[]): Promise<void> {
    await rooms.create({ mode: 'practice', roomCode: code }, { timeoutMs: MANUAL_ROOM_TIMEOUT_MS });
    await rooms.resetWaitingWindow(code);
    for (const id of humans) await rooms.join(code, id);
  }

  /** 不变量（**落盘**断言）：状态、房间人数、座位表三处都不得越界。 */
  async function expectSafe(code: string): Promise<void> {
    const room = (await rooms.findOne(code))!;
    expect(room.status, '最终必须是 playing —— 不得被置 cancelled').toBe('playing');
    expect(room.players.length, '房间人数不得超员').toBeLessThanOrEqual(room.maxPlayers);
    expect(
      Object.keys(redis.hashes.get(seatsKey(code)) ?? {}).length,
      '座位表（唯一真源 R128）也不得超员',
    ).toBeLessThanOrEqual(room.maxPlayers);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createFakeRedis();
    cache = makeConfigCache();
    rooms = new RoomsService(asRedis(redis), asConfigCache(cache));
    rooms.setClock(() => T0);
    rooms.setRandom(() => 0); // 死线 = T0 + 20s
    calls = [];
    botSeq = 0;
  });

  it('满员房：两条链并发 ⇒ 不超员、最终 playing、不得 cancelled', async () => {
    await manualRoom('W1FULL', ['u1', 'u2', 'u3']);

    await Promise.all([makeScanner().scanOnce(), makeScanner().scanOnce()]);

    await expectSafe('W1FULL');
    expect(
      calls.filter((c) => c.pattern === RPC_PATTERNS.gameStart).length,
      '两条链都**真的**走到了开局（否则上面那条不变量是空测）',
    ).toBeGreaterThanOrEqual(1);
  });

  /**
   * ⚠️ 这条才是「`playerCount ≤ 3`」**有牙**的地方：满员房根本没得补，超员无从谈起。
   * 缺人 + 越死线时，两条链会**各自**去补位（各调一次 `robot.acquire`）——
   * 兜住它的是 `addBot` 内部的 `HSETNX`（原子）与同一 `displayId` 的**幂等占座**，
   * 而不是任何互斥。
   */
  it('缺人 + 已越死线：两条链并发补位 ⇒ 不超员、最终 playing', async () => {
    await manualRoom('W1FILL', ['u1']);
    rooms.setClock(() => T0 + MANUAL_FILL_MIN_WAIT_MS); // 正好到死线

    await Promise.all([makeScanner().scanOnce(), makeScanner().scanOnce()]);

    await expectSafe('W1FILL');
    const room = (await rooms.findOne('W1FILL'))!;
    expect(room.players.length, '补满到 3 人').toBe(3);
    expect(room.players.filter((p) => p.isRobot).length, '恰好补 2 个机器人').toBe(2);
    expect(
      calls.filter((c) => c.pattern === RPC_PATTERNS.gameStart).length,
      '真的走到了开局（反空测）',
    ).toBeGreaterThanOrEqual(1);
  });

  /**
   * 🔴 **这条才是 W1 里真正会红的那一半**（上面两条是**回归钉**，今天必然绿 —— 见本组开头）。
   *
   * 场景：两个扫描器为**同一个座位**拿到**不同**的机器人（上面 `botOf` 说明的第二种拓扑，
   * 多实例下的真实可能）。于是**两条链都可能补位失败**（座位被别人先占掉 ⇒ `12002`）
   * ⇒ 两条链都 `startRoom → false`。此时：
   *  - **允许**：没开起来的那一轮什么都不做（房间留 `waiting`，人还坐在里面）；
   *  - **禁止**：把房间置 `cancelled` —— 那正是 spec §0.2 的灾难形态
   *    （房间变终态、玩家还坐在里面），而且 `findAll()` **看不见** `cancelled`
   *    ⇒ 扫描器从此再也捡不起来它。
   *
   * 判据仍取**不变量**：**下一轮**（扫描器式设计的自愈）必须把房间开起来 ⇒
   * 最终 `playing`、人数不超员。⚠️ 本轮是否双双失败**不作断言**（那取决于交错顺序，
   * 断言它就是在测调度）—— 只断言**收敛后的终态**。
   */
  it('🔴 同一座位拿到**不同**机器人 ⇒ 两条链可能双双补位失败；不得取消，下一轮自愈', async () => {
    await manualRoom('W1RACE', ['u1']);
    rooms.setClock(() => T0 + MANUAL_FILL_MIN_WAIT_MS); // 正好到死线

    await Promise.all([makeScanner(false).scanOnce(), makeScanner(false).scanOnce()]);
    // 第一轮之后：**已经**开起来也算通过（不强行要求这一轮失败）—— 判据是终态
    await Promise.all([makeScanner(false).scanOnce(), makeScanner(false).scanOnce()]);

    await expectSafe('W1RACE');
    expect((await rooms.findOne('W1RACE'))!.players.length, '补满到 3 人').toBe(3);
  });
});

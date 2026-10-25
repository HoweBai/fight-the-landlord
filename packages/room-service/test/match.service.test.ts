import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger, runWithTrace } from '@fight-the-landlord/shared';
import {
  MatchService,
  matchQueueKey,
  matchRejectedKey,
  MATCH_WAIT_PROMPT_MESSAGE,
  parseMatchQueueKey,
  RISK_HIT_TTL_SECONDS,
  ROBOT_ACQUIRE_TIMEOUT_MS,
  RPC_MAX_ATTEMPTS,
} from '../src/match/match.service';
import {
  matchNoLegalGroupTotal,
  matchPredicateRejectionsTotal,
  matchSelectionRoundsTotal,
} from '../src/metrics/room.metrics';
import { exactSeriesValue, labeledValue } from './helpers/metric-readout';
import { GameClient } from '../src/gateway/game.client';
import { RobotClient } from '../src/gateway/robot.client';
import type { Redis } from 'ioredis';
// ⚠️ 这里**故意**用真实 `RoomsService`（下面的 N31/R452 用例）：`status` 的判据必须是
// 「Redis 里真的写进了 `playing`」，而不是「替身的某个方法被调过」——
// 替身的宽容度就是对缺陷的容忍度（切片 7.1 的教训）。
import { RoomsService } from '../src/rooms/rooms.service';
import { RoomStartService } from '../src/rooms/rooms.start';
// 断点④修复（本片 Task 5 · 设计 v1.3.1 §4.4）：`RoomStartService` 新增第 7 个构造参数
// `reconnect`（开局为人类座位写重连记录）—— 本文件各处断言与它无关 ⇒ 一律轻替身。
import { ReconnectService } from '../src/reconnect/reconnect.service';
import { makeFakeEval } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './helpers/config-cache.stub';
import { ErrCode, RPC_PATTERNS, type BotInstance } from '@fight-the-landlord/protocol';
import { NEVER, of, Subject, throwError } from 'rxjs';

/**
 * **状态化**的 Redis 替身（切片 7 引入）。
 *
 * 旧替身把 `hgetall` 一律返回 `{}`，于是「写进去的东西能否按契约读回来」这件事
 * 根本无法被验证 —— 而这正是 §8.1/§10.1 的键表要钉住的东西（R42）。
 * 现在哈希 / ZSet 都真的存起来，断言必须走契约形状而不是「某个方法被调过」。
 */
type MockRedis = Redis & {
  _hashes: Map<string, Record<string, string>>;
  _zsets: Map<string, Map<string, number>>;
  /** 风控 T2（Step 0）：String 存区（`match:rejected` 记忆 / `risk:hit` 计数）。 */
  _strings: Map<string, string>;
  /** 本片 T6：绝对到期时刻（epoch ms）——`set … EX`/`expire` 写、`get`/`exists`/pipeline 读。 */
  _ttls: Map<string, number>;
  /** 本片 T6：可注入时钟（claim TTL 过期判据；`advanceMs` 推进）。 */
  _advanceMs: (ms: number) => void;
};

const makeMockRedis = (): MockRedis => {
  const hashes = new Map<string, Record<string, string>>();
  const zsets = new Map<string, Map<string, number>>();
  const strings = new Map<string, string>();
  const ttls = new Map<string, number>();
  const clock = { now: Date.now() };
  const existsNow = (key: string): boolean => {
    const live = strings.has(key) || hashes.has(key) || zsets.has(key);
    if (!live) return false;
    const at = ttls.get(key);
    return at === undefined || at > clock.now;
  };
  return {
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const z = zsets.get(key) ?? new Map<string, number>();
      z.set(member, score);
      zsets.set(key, z);
      return 1;
    }),
    zrange: vi.fn(async (key: string, _start: number, _stop: number, mode?: string) => {
      const z = zsets.get(key) ?? new Map<string, number>();
      const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]);
      return mode === 'WITHSCORES' ? sorted.flatMap(([m, s]) => [m, String(s)]) : sorted.map(([m]) => m);
    }),
    zrem: vi.fn(async (key: string, member: string) => (zsets.get(key)?.delete(member) ? 1 : 0)),
    /**
     * 监控片 T3：匹配扫描环新增 `ZCARD` 读深（`match_queue_length`）。
     * ⚠️ 替身新增一次调用就缺一个方法（本文件第二次踩）—— 缺了它，`readQueueDepth`
     * 的 catch 会把每条队列都记一条 error 日志（含判据 11 的行捕获面）。
     */
    zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
    /**
     * `SCAN`（片规格 §2.4：`cancelQueue` 的兜底与**每轮匹配扫描**都改用它）。
     *
     * 语义等价即可：一次返回全部匹配键（游标回 `'0'` ⇒ 调用方的 do-while 只跑一轮）。
     * ⚠️ **键空间取哈希与 ZSet 的并集** —— 真实 Redis 的 `SCAN` 扫的是**整个键空间**，
     * 只扫 `zsets` 是替身比实现窄（那正是「替身的宽容度 = 对缺陷的容忍度」的形态）。
     */
    scan: vi.fn(async (cursor: string, _match: string, pattern: string) => {
      if (cursor !== '0') return ['0', []];
      const prefix = pattern.replace(/\*$/, '');
      // ⚠️ T2 补：并集也算上 strings —— 真实 Redis 的 SCAN 扫的是**整个键空间**。
      const keys = [...new Set([...zsets.keys(), ...hashes.keys(), ...strings.keys()])].filter((k) =>
        k.startsWith(prefix),
      );
      return ['0', keys];
    }),
    /**
     * ⚠️ 必须同时支持**两种真实调用形态**：`HSET key f v`（3 参）与
     * `HSET key {f: v, ...}`（ioredis 的对象形态）。旧替身只支持后者，
     * 于是 `writeBotBindings()` 的 3 参调用会被静默写坏（实测：写进 `{'0':'2'}`）。
     */
    hset: vi.fn(async (key: string, fieldOrFields: string | Record<string, string>, value?: string) => {
      const patch =
        typeof fieldOrFields === 'string' ? { [fieldOrFields]: String(value) } : fieldOrFields;
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...patch });
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => hashes.get(key) ?? {}),
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
    /**
     * §10.2 的**原子**占座（`claimSeat` 的底层命令）。
     *
     * ⚠️ 缺了它，`RoomsService` 的 `claimSeat` 会抛 `redis.hsetnx is not a function`，
     * 而症状会被上游的 `try/catch` 吞成「房间 cancelled」—— 又一条**假绿**形状的替身缺口。
     */
    hsetnx: vi.fn(async (key: string, field: string, value: string) => {
      const h = hashes.get(key) ?? {};
      if (field in h) return 0;
      h[field] = value;
      hashes.set(key, h);
      return 1;
    }),
    hincrby: vi.fn(async (key: string, field: string, by: number) => {
      const h = hashes.get(key) ?? {};
      const next = Number(h[field] ?? 0) + by;
      h[field] = String(next);
      hashes.set(key, h);
      return next;
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      const h = hashes.get(key);
      if (!h || !(field in h)) return 0;
      delete h[field];
      return 1;
    }),
    /**
     * 风控 T2（Step 0 · F11）：`match:rejected` 记忆读写用 —— `SET key value PX ms`。
     * 本片 T6：扩为 NX/TTL 判面 —— `match:claim` 声明用 `SET key value EX s NX`。
     * TTL **在替身内到期**（`_advanceMs` 推进可注入时钟；仅测试旁路 —— 服务侧时钟独立）。
     * 用例若要构造「记忆过期」仍可用 `_strings.delete(key)`（或写一个超过 5s 的旧时刻值）
     * 显式表达；TTL 参数本身由 `redis.set` 的调用参数钉住（`'PX', 5000` / `'EX', 30, 'NX'`）。
     */
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      // 本片 T6：`SET … PX ms`（match:rejected 记忆）与 `SET … EX s [NX]`（match:claim 声明）两种实现侧形态；
      // 漂移 ⇒ 当场抛。NX 命中未过期已存在键 ⇒ 回 null 不写。
      let expiresAtMs: number | undefined;
      let nx = false;
      if (args.length === 0) {
        // 无选项
      } else if (args[0] === 'PX' && typeof args[1] === 'number' && args.length === 2) {
        expiresAtMs = clock.now + args[1];
      } else if (args[0] === 'EX' && typeof args[1] === 'number' && args.length === 2) {
        expiresAtMs = clock.now + args[1] * 1000;
      } else if (args[0] === 'EX' && typeof args[1] === 'number' && args[2] === 'NX' && args.length === 3) {
        expiresAtMs = clock.now + args[1] * 1000;
        nx = true;
      } else {
        throw new Error(`makeMockRedis 未识别的 set 选项形态：${args.map(String).join(' ')}`);
      }
      if (nx && existsNow(key)) return null;
      strings.set(key, String(value));
      if (expiresAtMs !== undefined) ttls.set(key, expiresAtMs);
      else ttls.delete(key);
      return 'OK' as const;
    }),
    get: vi.fn(async (key: string) => (existsNow(key) ? (strings.get(key) ?? null) : null)),
    /**
     * 风控 T2（Step 0 · F11）：`risk:hit:{userId}:{predicate}` 计数（INCR + EXPIRE 7d）。
     * 真实语义：字符串数字 +1 并**返回新值**；键不存在按 0 起算。
     */
    incr: vi.fn(async (key: string) => {
      const next = Number(strings.get(key) ?? '0') + 1;
      strings.set(key, String(next));
      return next;
    }),
    /**
     * 波 2 F4：`pipeline()` 的最小实现 —— 只支撑「`exists` 连打 + `exec()`」（前置筛选的
     * 封禁旗**批读**）。语义照真实 ioredis：`exec()` 返回 `[err, result][]`（顺序 = 命令
     * 顺序）；`EXISTS` 不看键的类型（strings/hashes/zsets 都算存在）。
     * ⚠️ 与 `zcard` 那条同一族教训（本文件第三次）：替身缺一个被用到的方法，扫描链会在
     * **前置筛选**处崩（`redis.pipeline is not a function`）—— 每一条 scanOnce 路径都会红，
     * 别把它当被测代码的缺陷。
     */
    pipeline: vi.fn(() => {
      const ops: Array<{ op: 'exists' | 'get'; key: string }> = [];
      // ⚠️ 显式注解（不是从推断来）：`exists`/`get` 回链自身 ⇒ 无注解时 TS 报「循环推断」。
      // Task 2.4：claim 的值改成 roomCode ⇒ 扫描用 GET（不再只是 EXISTS）。
      const chain: {
        exists: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        exec: ReturnType<typeof vi.fn>;
      } = {
        exists: vi.fn((key: string) => {
          ops.push({ op: 'exists', key });
          return chain;
        }),
        get: vi.fn((key: string) => {
          ops.push({ op: 'get', key });
          return chain;
        }),
        exec: vi.fn(async () =>
          ops.map(({ op, key }): [Error | null, number | string | null] =>
            op === 'exists'
              ? [null, existsNow(key) ? 1 : 0]
              : [null, existsNow(key) ? (strings.get(key) ?? null) : null],
          ),
        ),
      };
      return chain;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (hashes.delete(key)) removed += 1;
        if (zsets.delete(key)) removed += 1;
        if (strings.delete(key)) removed += 1;
      }
      return removed;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      if (!existsNow(key)) return 0;
      ttls.set(key, clock.now + seconds * 1000);
      return 1;
    }),
    publish: vi.fn(async () => 1),
    quit: vi.fn(async () => undefined),
    /**
     * `EVAL`（本片 · spec §2 / R1002）：**与 `test/helpers/fake-redis.ts` 共用同一份实现**
     * （`makeFakeEval`）—— 替身各写一份 `eval` 就是「同一个脚本、两套语义」的第二真源。
     * ⚠️ 缺了它，`cancelIfStillWaiting` 的**真实**实现会抛 `redis.eval is not a function`，
     * 而症状会被上面的 `if (!ok)` 分支吞成一条含糊的红 —— 又一条替身缺口形状的假绿。
     */
    eval: makeFakeEval(hashes, strings),
    _hashes: hashes,
    _zsets: zsets,
    _strings: strings,
    _ttls: ttls,
    _advanceMs: (ms: number): void => {
      clock.now += ms;
    },
  } as unknown as MockRedis;
};

type MockRoomsService = {
  createGameRoom: ReturnType<typeof vi.fn>;
  addBot: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  findOne: ReturnType<typeof vi.fn>;
  /** 本片新增的调用点（CAS 取消，R1002/R1003）。 */
  cancelIfStillWaiting: ReturnType<typeof vi.fn>;
};

/**
 * 状态化的 `RoomsService` 替身：`addBot` 是**累加**的（真实实现会往 `players` 里加座位）。
 *
 * ⚠️ 这一点必须是累积的：`MatchService` 按 `room.players.find(p => p.userId === bot.displayId)`
 * 反查座位（R124/R129：座位归属的唯一真源是 seats Hash）。替身若每次都返回**同一张**
 * 座位表，第二个机器人的 `displayId` 就会和第一个撞车 —— 那不是被测代码的缺陷，
 * 而是「替身的宽容度就是对缺陷的容忍度」（切片 7.1 的教训）。
 */
/**
 * `RoomsService` 替身 —— **透明代理**（本片改造）。
 *
 * ⚠️ 为什么不再手写一套返回常量：本片之后 `MatchService` **会读房间状态**
 *（开局没起来时先看一眼 `status` 再决定要不要置 `cancelled` ⇒ 不得误杀别人的对局）。
 * 手写替身返回一张恒定的空房间 ⇒ 那条判据变成**空测**，而更早的坑是：
 * 房间根本没被建出来，`RoomStartService` 的 `findOne` 直接 `null`，
 * 于是「补位失败 → cancelled」这条链**一步都走不到**（实测：`enteredAt` 断言先红）。
 *
 * ⇒ 改成把每个方法**委托给真实 `RoomsService`**（接在同一个假 Redis 上）并加 spy：
 * 判据既能看到调用（`toHaveBeenCalledWith`），又建立在**真的读写**之上。
 * 这正是本文件开头那句「替身的宽容度就是对缺陷的容忍度」的落实。
 */
const makeMockRoomsService = (
  real: RoomsService,
  /** 房号（缺省 `ABC123`）。⚠️ W4（两个实例并发）要给第二个实例**另一个房号**，
   * 否则两条链会往**同一把键**上写，判据就分不清「两个实例各建了一间房」与「两个实例抢同一间房」。 */
  roomCode = 'ABC123',
): MockRoomsService => {
  const rooms: MockRoomsService = {
    /**
     * ⚠️ 房号**固定**：真实 `generateCode()` 是随机的，而本文件满篇断言 `roomCode: 'ABC123'`。
     * 委托给真实实现之后必须把它钉住，否则每条断言都会因为「房号不一样」而红。
     *
     * 片规格 §2.4：底分**从队列透传**（第三个参数）—— 不再有「夹具开关」，
     * 房间底分就是匹配键里那一维（路径因此只有一个真源）。
     */
    createGameRoom: vi.fn(async (ids: string[], mode: 'random' | 'practice', baseScore: number) => {
      const created = await real.create({ mode, roomCode, baseScore });
      for (const id of ids) await real.join(created.code, id);
      return (await real.findOne(created.code))!;
    }),
    addBot: vi.fn((code: string, displayId: string) => real.addBot(code, displayId)),
    updateStatus: vi.fn((code: string, status: string) => real.updateStatus(code, status as never)),
    findOne: vi.fn((code: string) => real.findOne(code)),
    /**
     * 本片新增的调用点（CAS 取消，R1002/R1003）—— **委托给真实 CAS**（本片改造）。
     *
     * ⚠️ **替身在这里必须透明**（本片实测踩过）：原先它用闭包变量 `statusOverride` 记状态，
     * 那是**第二真源** —— 真实房间写在假 Redis 上、而这个变量在内存里，两者会分叉。
     * 后果不是「断言红」，而是**更糟**：`resetStatus()` 一调它就退回「刚建好 = `waiting`」，
     * 于是「房间已被别人开起来（`playing`）⇒ **不得**取消」这条判据**永远绿**
     *（替身会愉快地报 `true` 并声称房间被取消了，而真房间里根本没有这回事）。
     * ⇒ 现在它与 `updateStatus`/`findOne` 一样落在**真的读写**之上（`eval` 由
     * `makeFakeEval` 提供，与 `test/helpers/fake-redis.ts` 共用同一份语义）。
     */
    cancelIfStillWaiting: vi.fn((code: string) => real.cancelIfStillWaiting(code)),
  };
  return rooms;
};

/** 一条 bot 的完整形状（§3.4；`roomCode`/`seat` 由 robot-service 回填）。 */
/**
 * 一条 bot 的完整形状（§3.4）。
 *
 * ⚠️ `displayId` **必须随座位不同**（`p_` + 座位号补零）：`addBot` 走的是 `HSETNX` 占座，
 * 而 `claimSeat` 对**同一个 userId 是幂等的** ⇒ 两条 bot 若共用一个 displayId，
 * 第二个只会拿回第一个的座位，房间永远只有 2 人（旧替身给每个 seat 回同一个 displayId，
 * 而那时房号/座位都由替身自己编，所以看不出这个**假** —— 委托给真实 `RoomsService` 后立刻现形）。
 */
const botOf = (seatNo: number, botId = 'bot-abc'): BotInstance => ({
  botId,
  displayId: `p_${String(seatNo).padStart(8, '0')}`,
  skillLevel: 'beginner',
  personality: { thinkingSpeed: 900 },
  roomCode: 'ABC123',
  seat: seatNo,
  gamesPlayed: 0,
});

/**
 * RPC 替身（N20/P4 Task 3）：`robot.acquire` 与 `game.start` 共用一个假 `ClientProxy`。
 *
 * ⚠️ 与旧的 `HttpService` 替身相比，**契约的形状变了、判据的强度没有变**：
 *  - 旧：完整 URL（少 `/api` ⇒ 真实拓扑 404，替身不失败 —— R70）；
 *  - 新：**pattern 名**（少个点 / 写错 ⇒ 真实拓扑永不回包，替身同样不失败）。
 * 因此 `assertRpc` 必须比对 `RPC_PATTERNS.*` 而不是「`send` 被调用过」。
 */
function makeFakeProxy() {
  const calls: Array<{ pattern: string; data: unknown }> = [];
  const handlers = new Map<string, (data: unknown, index: number) => unknown>();

  const send = vi.fn((pattern: string, data: unknown) => {
    const index = calls.filter((c) => c.pattern === pattern).length;
    calls.push({ pattern, data });
    const handler = handlers.get(pattern);
    if (handler) return handler(data, index);
    // 默认：`robot.acquire` 每个请求座位回一个 bot；`game.start` 回 `{roomCode}`
    if (pattern === RPC_PATTERNS.robotAcquire) {
      return of({ ok: true, data: { bots: ((data as { seats?: number[] }).seats ?? [1]).map((s) => botOf(s)) } });
    }
    return of({ ok: true, data: {} });
  });

  return {
    proxy: { send } as never,
    /** 裸 `send` 替身：R452 的**顺序**判据要用 `mock.invocationCallOrder`。 */
    send,
    calls,
    /** 按 pattern 覆写应答（可拿到该 pattern 的第 n 次调用序号，用于重试判据）。 */
    on(pattern: string, fn: (data: unknown, index: number) => unknown) {
      handlers.set(pattern, fn);
    },
    /** 该 pattern 的调用载荷列表。 */
    payloadsOf(pattern: string): unknown[] {
      return calls.filter((c) => c.pattern === pattern).map((c) => c.data);
    },
  };
}

/**
 * 风控 T2：恒等洗牌 RNG 与「目标序反推」助手。
 *
 * ⚠️ 为什么必须有：本片起选择算法 = **随机**贪心（规格 §2.4-3 的「随机选取」）——
 * 不钉 RNG 的话，「组序 == 入队序」类断言全部变成掷骰子。缺省恒等（`beforeEach` 里
 * `setRng(IDENTITY_RNG)`）让既有断言保持原状；需要特定洗牌序的用例用 `rngForShuffle`。
 */
/** `floor(0.9999999 × (i+1)) === i` ⇒ Fisher–Yates 的每一步都不交换 ⇒ 洗牌 == 原序。 */
const IDENTITY_RNG = (): number => 0.9999999;

/**
 * 由「原序 → 目标序」**反推** Fisher–Yates 的 rng 序列（复刻实现的交换方向：
 * `i` 从 n−1 到 1、`j ∈ [0, i]`；每步取 `r = (j + 0.5) / (i + 1)` ⇒ `floor(r × (i+1)) = j`）。
 * 目标序不可达 ⇒ **当场抛**（防「写错期望序」伪装成别的红）。用尽后兜底恒等。
 */
function rngForShuffle(original: readonly string[], desired: readonly string[]): () => number {
  const arr = [...original];
  const picks: number[] = [];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const want = desired[i]!;
    const j = arr.indexOf(want);
    if (j < 0 || j > i) {
      throw new Error(`rngForShuffle: 目标序不可达（第 ${i} 步要 "${want}"，它在位置 ${j}）`);
    }
    picks.push((j + 0.5) / (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  if (arr.join(',') !== desired.join(',')) {
    throw new Error(`rngForShuffle: 目标序构造失败（${arr.join(',')} ≠ ${desired.join(',')}）`);
  }
  let k = 0;
  return () => picks[k++] ?? IDENTITY_RNG();
}

/**
 * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原的话，
 * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到自己的
 * 日志行）。还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

describe('MatchService', () => {
  let service: MatchService;
  let redis: MockRedis;
  let roomsService: MockRoomsService;
  let globalService: RoomsService;
  let rpc: ReturnType<typeof makeFakeProxy>;
  /**
   * 配置缓存桩（片规格 §2.5；T7 起取代 `ConfigClient` 桩）。**一份用例一份桩**
   * （`makeConfigCache()` 的缺省就是真档位 15/80/480/1200）—— 用例可以
   * `baseScoreLevels.mockRejectedValue` 模拟「表读不到」，也可以换一份表构造
   * 「夹具专属档位」，或 `friendRoomEnabled.mockReturnValue(false)` 构造「开关关」。
   *
   * 同一个实例**同时**喂给 `MatchService`（匹配路径的校验）与 `RoomsService`
   *（建房路径的校验）：两条路的判定必须来自**同一张表**，否则「两边都测了」可能测的是
   * 两份不同的真源（本仓为「第二真源」付过多次代价）。
   */
  let configCache: ConfigCacheStub;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
    // ⚠️ `roomsService` 由 `beforeAll` 建、跨用例复用 ⇒ 必须**逐用例丢弃它的状态**：
    // 它是真实 `RoomsService` 的透明代理，房间/座位都真的写在 redis 上
    //（本片实测：不清的话第二个用例会 join 进上一条用例留下的 `ABC123`）。
    redis._hashes.clear();
    redis._zsets.clear();
    // 2026-10-22 机器人昵称片：短锁落在 strings 面（`SET ... EX 3 NX`）——
    // 替身的时钟不推进 ⇒ 不清会跨用例残留，后续同房号开局会自旋后放弃。
    redis._strings.clear();
    configCache = makeConfigCache();
    globalService = new RoomsService(redis as unknown as Redis, asConfigCache(configCache));
    roomsService = makeMockRoomsService(globalService);
    rpc = makeFakeProxy();
    // ⚠️ N20/P4 Task 3：`MatchService` 依赖的是**注入的 `GameClient` / `RobotClient`**
    // （各自持有容器给的 `ClientProxy`），不再是 `HttpService`。这里把两个真实客户端
    // 接到同一个假 proxy 上 —— 因此**真实 pipeline**（超时 / 信封解包 / 重试）都被走到。
    /**
     * ⚠️ 本片（spec §2.2 / R915）：`MatchService` 不再自己持有 `GameClient` / `RobotClient`
     * —— 它们与「补位 + 开局 + 通知」一起搬到了 `RoomStartService`。
     * 替身仍是**真实的**两个客户端 + **同一个**假 proxy ⇒ 真实 pipeline 照样被走到。
     */
    const game = new GameClient(rpc.proxy);
    const robot = new RobotClient(rpc.proxy);
    service = new MatchService(
      redis,
      roomsService as unknown as RoomsService,
      // ② T5：第 5 个参数 = 金币边（金币房开局的余额下发读边；本文件走 random ⇒ 零调用）。
      // ② T6：第 6 个参数 = 机器人资金面（金币场补位后的 ensure 边；同上零调用）。
      new RoomStartService(redis, roomsService as unknown as RoomsService, game, robot, {
        get: vi.fn(),
        apply: vi.fn(),
      } as never, {
        ensureBots: vi.fn(),
        afterSettle: vi.fn(),
      } as never, {
        // 断点④修复（Task 5）：重连记录写边 —— 轻替身（本文件断言与它无关）。
        touch: vi.fn().mockResolvedValue(undefined),
      } as unknown as ReconnectService,
      // 本片：台费费率表读边（与 RoomsService 同一桩实例）。
      asConfigCache(configCache)),
      // 片规格 §2.5：匹配路径入队前要校验底分是否属于档位表（与建房路径同一条规则）。
      asConfigCache(configCache),
      // 片② D5：可用性门禁的注入点（与 `RoomStartService` 共用**同一个**假 proxy ⇒
      // 真实的 `RobotClient` pipeline（超时 / fail-open）被走到）。
      robot,
    );
    // 风控 T2：选择算法含洗牌 ⇒ 缺省钉**恒等序**（既有断言的「组序 == 入队序」保持原状；
    // 需要特定洗牌序的用例自行 `setRng(rngForShuffle(...))` 覆写）。
    service.setRng(IDENTITY_RNG);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await service.onApplicationShutdown();
  });

  // ─── 存储契约（§8.1 / §10.1 / §10.4 / R42 / R45）─────────────────

  it('addToQueue 写 match:queue:{mode}:{baseScore}:{region} 与 match:meta:{playerId}（§8.1/§10.1）', async () => {
    service.setClock(() => 1_700_000_000_000);
    await service.addToQueue('player-1', 'random', 15);

    expect(redis.zadd).toHaveBeenCalledWith('match:queue:random:15:global', 1_700_000_000_000, 'player-1');
    expect(redis._hashes.get('match:meta:player-1')).toEqual({
      playerId: 'player-1',
      mode: 'random',
      baseScore: '15', // 片规格 §2.4：底分进键、也进 meta（meta 是「他排在哪个队列」的真相源）
      region: 'global',
      enteredAt: '1700000000000',
      latency: '0', // R45：MVP 恒为 0，字段形状保留
      attempts: '0',
      // 多玩法 Task 2.1：维度与**实际键**进 meta（取消/探测的唯一真源）
      gameType: 'doudizhu',
      playerCount: '3',
      queueKey: 'match:queue:random:15:global',
    });
    expect(redis.expire).toHaveBeenCalledWith('match:meta:player-1', 300); // §10.4
  });

  it('addToQueue **不再**写 match:pending（R42：那是匹配结果专用的键）', async () => {
    await service.addToQueue('player-1', 'random', 15);
    expect([...redis._hashes.keys()]).not.toContain('match:pending:player-1');
  });

  // ─── 片规格 §2.5：匹配路径的底分档位校验（与建房路径同一条规则）────────────

  /**
   * 🔴 规格 §2.5 逐字：「非法 `baseScore` 被拒：**`room.match` 与 `POST /api/rooms` 两条路都要测**」
   * —— 本条是**匹配那条**（建房那条在 `rooms.base-score.test.ts`）。
   *
   * 修前 `addToQueue` 只校验「有限数字」（`validate.ts` 的 `assertNum`）⇒ 传 999 会建出
   * `match:queue:random:999:global`：一条**只有他自己**的毒化队列（没有别人会匹配这个底分），
   * 扫描器每轮为它建一次房、每轮撞 `create()` 的档位校验，玩家等 60 秒拿 12007。
   */
  it('🔴 非档位底分被拒（规格 §2.5「两条路都要测」的匹配那条）', async () => {
    await expect(service.addToQueue('p1', 'random', 999)).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM, // 10001：与建房路径**同码**（既有码，不是新造）
    });
    // 「被拒」必须**同时**是「什么都没写下去」（照 `rooms.base-score.test.ts:47` 的成例）：
    // 抛在写队列/写 meta 之后也算「被拒」，但那时毒化队列已经建出来了 —— 那正是本节要修的形态。
    expect(redis._hashes.has('match:meta:p1'), '非法底分不得入队（meta）').toBe(false);
    expect(redis._zsets.get('match:queue:random:999:global'), '非法底分不得建出队列').toBeUndefined();
    // 正对照（15/80/480 的入队）由本文件既有用例覆盖：它们同时钉住「合法档位**没有**被误伤」。
  });

  /**
   * 🔴 **拿不到档位表 ⇒ 必须失败，绝不静默放行**（片规格 §2.4 的红线：那正是非法值的后门）。
   *
   * 判别力在两个方向（照 `rooms.base-score.test.ts` 的同族纪律）：
   *  ① 探针值是**合法档位**（15）⇒ `catch { return [] }`（把「读不到」当成「表为空」）
   *     或「拿不到就跳过校验」两种实现都会**放行**，本条当场红；
   *  ② 抛出的东西必须**分辨得出是「读不到」**（`10007`），**不是** `10001`
   *     —— 「吞掉后编一个『底分不属于档位表』」的实现同样红。
   *
   * ⚠️ **Task 3c 修复 1 改了这里的形状**：修前是「原样上抛 `ConfigServiceError`」
   * （原用例断言消息 `rpc down` 原样穿透）—— 那串内部详情会一路冒到 WS 边界、被当 toast
   * 弹给玩家。现在在**这一跳**翻成 `DomainError(UPSTREAM_UNAVAILABLE)`：与建房路径
   * `RoomsService.create()` 对同一次读的处置**同形**（那里也翻成 10007），详情只进日志。
   */
  it('🔴 拿不到档位表 ⇒ 抛错（10007，**不是** 10001），不得静默放行', async () => {
    configCache.baseScoreLevels.mockRejectedValue(new Error('rpc down'));

    const failure = await service
      .addToQueue('p1', 'random', 15)
      .then(() => null, (err: unknown) => err);

    // ① 必须抛（吞掉/放行的实现在这里就是 `null` ⇒ 当场红）
    expect(failure, '拿不到档位表必须抛错，不得放行').not.toBeNull();
    // ② 码是 **10007**（「读不到」）而不是 10001（「值非法」）——后者会告诉客户端
    //    「你传错了档位」，而事实是服务端读不到表。
    expect(failure).toMatchObject({ code: ErrCode.UPSTREAM_UNAVAILABLE });
    // ③ 🔴 **内部详情不得进入消息**（Task 3c 修复 1：WS 面会把它当 toast 弹给玩家）
    expect(String((failure as Error).message)).not.toContain('rpc down');
    // 反空测：连一个键都不许落下（「先写队列、后校验」的形态在这里现形）
    expect(redis._hashes.has('match:meta:p1'), '拿不到档位表时不得入队（meta）').toBe(false);
    expect(
      redis._zsets.get('match:queue:random:15:global'),
      '拿不到档位表时不得建出队列',
    ).toBeUndefined();
  });

  /**
   * 🔴 **C8 正对照（片⑦ T7；片规格 §C8）**：**开关关时匹配路径不受影响** —— 好友房开关的
   * 拒绝落在 **controller 入口**（`rooms.controller.ts` 的 `create()`/`join()`），
   * **不得**落进共用的 `RoomsService.create()` 服务体 —— 那会连坐匹配：
   * `createGameRoom`（匹配建房的唯一入口）内部正是调 `create()`。
   *
   * 探针形态（「拒绝被误放进服务层」的实现下必须红）：走**一轮真匹配**（三人同队列 ⇒ 成局），
   * 断言房**真的落盘** —— 本文件的 `roomsService` 是**透明代理**（`createGameRoom` 委托
   * 真实 `RoomsService.create`）⇒ 服务体里若藏了开关检查，这一轮连房都建不出来。
   * 顺带钉住：匹配路径**根本不该看开关**（`friendRoomEnabled` 零调用）。
   */
  it('🔴 C8 正对照：开关关 ⇒ 匹配路径照常成局（拒绝只在 controller 入口，不连坐共用 create()）', async () => {
    configCache.friendRoomEnabled.mockReturnValue(false); // 开关关（= 生产种子态）
    const T0 = 1_700_000_000_000;
    service.setClock(() => T0);
    await service.addToQueue('u1', 'random', 15);
    service.setClock(() => T0 + 1);
    await service.addToQueue('u2', 'random', 15);
    service.setClock(() => T0 + 2);
    await service.addToQueue('u3', 'random', 15);
    service.setClock(() => T0 + 1_000); // 三人齐、未越 30s 窗口 ⇒ 直接成局（不补机器人）

    await service.scanOnce();

    // 正面证据：真的建出了房并成局（「开关检查落进 create()」的实现下这里什么都没有）
    expect(roomsService.createGameRoom, '开关关时匹配必须照常建局').toHaveBeenCalledWith(
      ['u1', 'u2', 'u3'],
      'random',
      15,
      'doudizhu',
      3,
    );
    const room = await globalService.findOne('ABC123');
    expect(room?.status, '成局必须真的落盘（透明代理 ⇒ 服务体被真实走过）').toBe('playing');
    // 匹配路径**不看**开关（它的门在 controller，不在本服务）
    expect(configCache.friendRoomEnabled, '匹配链不得读开关').not.toHaveBeenCalled();
  });

  it('cancelQueue 按 meta 定位队列、删 meta，且**不碰** match:pending（R42）', async () => {
    service.setClock(() => 1000);
    await service.addToQueue('player-1', 'practice', 15);
    // ⚠️ 片⑦ 修复：`storePending` 已从 `MatchService` 迁到 `RoomStartService`（写点泛化为
    // 一切开局，见 `rooms.start.test.ts` 的 ① 组用例）⇒ 这里直接以契约形状预置凭据。
    await redis.hset('match:pending:player-1', { roomCode: 'ABC123', seat: '2' });

    await service.cancelQueue('player-1');

    expect(redis._zsets.get('match:queue:practice:15:global')?.has('player-1')).toBe(false);
    expect(redis._hashes.has('match:meta:player-1')).toBe(false);
    // 匹配结果不能被「取消排队」误删：它同时承担断线补齐（§8.2）
    expect(redis._hashes.get('match:pending:player-1')).toEqual({ roomCode: 'ABC123', seat: '2' });
  });

  /**
   * 片规格 §2.4（兜底改 SCAN）+ R63：`match:meta` 有 TTL（300s）而 ZSet 成员**没有**
   * ⇒ 「meta 已过期、成员还在」是必须能清的形态。
   *
   * 加了底分维度后，遍历 `(mode, region)` 的旧兜底不再完整（它需要「知道所有底分」，
   * 而 room-service 不查表）⇒ 改 `SCAN match:queue:*` 穷举。本条钉住的正是
   * 「**meta 不在时也能出队**」，而且**跨底分**的残留一并清掉（两张底分队列各留一条）。
   */
  it('cancelQueue 在 meta 丢失时用 SCAN 穷举所有队列兜底（幂等），且清干净', async () => {
    service.setClock(() => 1000);
    // 造「meta 已过期、ZSet 成员还在」的残留（R63 的分叉）：两张**不同底分**的队列上各一条
    //（玩家换过档位时的形态 —— 旧的底分那一维正好是 `(mode, region)` 兜底枚举不到的部分）。
    await service.addToQueue('ghost', 'random', 15);
    await service.addToQueue('ghost', 'random', 480);
    await service.addToQueue('other', 'random', 480);
    redis._hashes.delete('match:meta:ghost');
    // 反空测①：残留真的在（否则「清干净了」什么也证明不了）
    expect(redis._zsets.get('match:queue:random:15:global')?.has('ghost')).toBe(true);
    expect(redis._zsets.get('match:queue:random:480:global')?.has('ghost')).toBe(true);

    await service.cancelQueue('ghost');

    // 反空测②：走的是 SCAN 兜底（meta 不在 ⇒ else 分支），两张队列**都**清掉
    expect(redis._zsets.get('match:queue:random:15:global')?.has('ghost')).toBe(false);
    expect(redis._zsets.get('match:queue:random:480:global')?.has('ghost')).toBe(false);
    expect(redis._hashes.has('match:meta:ghost')).toBe(false);
    // 别人的票不得被误伤
    expect(redis._zsets.get('match:queue:random:480:global')?.has('other')).toBe(true);
  });

  // ⚠️ 片⑦ 修复：原「storePending 只写 { roomCode, seat } 且带 300s TTL」用例已**迁到
  // `rooms.start.test.ts` 的 ① 组**（写入点泛化为 `RoomStartService.startRoom` 的单一来源，
  // 原挂在 `MatchService` 上的那条已成死码 —— 设计 §1「迁移」）。

  it('readMeta 读回 MatchTicket（§3.5 形状）', async () => {
    service.setClock(() => 1_700_000_000_000);
    await service.addToQueue('player-1', 'random', 15);
    expect(await service.readMeta('player-1')).toEqual({
      playerId: 'player-1', mode: 'random', baseScore: 15, region: 'global',
      enteredAt: 1_700_000_000_000, latency: 0, attempts: 0,
      // 多玩法 Task 2.1：新票带玩法/人数与**实际键**
      gameType: 'doudizhu', playerCount: 3, queueKey: 'match:queue:random:15:global',
    });
    expect(await service.readMeta('nobody')).toBeNull();
  });

  /**
   * 风控 T2（§2.3 `match:meta` 行）：读取侧解析 `ip`/`deviceId` 两新字段 ——
   * **缺 ⇒ 不上字段**（谓词侧 fail-open 的一半；写入点 = T3 的 `addToQueue` 扩展）。
   */
  it('readMeta 解析 ip/deviceId：有则读回、缺则字段不存在（不是 undefined）', async () => {
    service.setClock(() => 1000);
    await service.addToQueue('p1', 'random', 15);
    await service.addToQueue('p2', 'random', 15);
    // T3 已落地写入点（下一条用例走真实 extras）；这里直写 meta 只为**隔离读侧**形状。
    await redis.hset('match:meta:p1', { ip: '203.0.113.7', deviceId: 'dev-abc' });

    const withFields = await service.readMeta('p1');
    expect(withFields?.ip).toBe('203.0.113.7');
    expect(withFields?.deviceId).toBe('dev-abc');

    const withoutFields = (await service.readMeta('p2'))!;
    // 「缺 ⇒ 不上字段」：`in` 判据（toEqual 会忽略 undefined 值 ⇒ 必须用 in 才钉得住）
    expect('ip' in withoutFields).toBe(false);
    expect('deviceId' in withoutFields).toBe(false);
  });

  /**
   * 风控 T3（§2.3 `match:meta` 行 / C7 的写入侧）：`addToQueue` 末位可选参 `extras`
   * —— **有则写对应 Hash 字段、缺则无键**（谓词侧 fail-open 的写入侧；读取侧由 T2 覆盖）。
   */
  it('addToQueue extras（风控 T3）：ip/deviceId 有则写进 meta、缺则**无键**（不是 undefined）', async () => {
    service.setClock(() => 1000);
    await service.addToQueue('p1', 'random', 15, undefined, {
      ip: '203.0.113.7',
      deviceId: 'dev-abc123',
    });
    await service.addToQueue('p2', 'random', 15, undefined, { ip: '198.51.100.9' });
    await service.addToQueue('p3', 'random', 15);

    const m1 = redis._hashes.get('match:meta:p1')!;
    expect(m1.ip).toBe('203.0.113.7');
    expect(m1.deviceId).toBe('dev-abc123');
    const m2 = redis._hashes.get('match:meta:p2')!;
    expect(m2.ip).toBe('198.51.100.9');
    // 「缺 ⇒ 无键」用 `in` 钉（`toEqual` 会忽略 undefined 值 —— 同 readMeta 用例的纪律）
    expect('deviceId' in m2).toBe(false);
    const m3 = redis._hashes.get('match:meta:p3')!;
    expect('ip' in m3).toBe(false);
    expect('deviceId' in m3).toBe(false);

    // 写 → 读 往返（两端口径一致）
    const t1 = await service.readMeta('p1');
    expect(t1?.ip).toBe('203.0.113.7');
    expect(t1?.deviceId).toBe('dev-abc123');
  });

  /**
   * 风控 T3 · **波 1 核验遗留 F1′**：`addToQueue` 的真实调用序 = **HSET meta 先于 ZADD**。
   *
   * 顺序是**语义**的一部分：扫描前置筛选对每张 ZSet 成员票无条件 `readMeta`
   *（风控 T2 §2.4-3：无 meta = 孤儿 ⇒ 静默 `cancelQueue` 清出）。旧序（ZADD→HSET）的
   * 窗口里，扫描恰好落在两步之间会把**正在入队**的票当孤儿清掉、随后 HSET 落地 ⇒
   * 玩家 ack 成功却不在队列（静默失联，窗口 ≈ 一次 Redis RTT/次入队）。
   *
   * 机械证据 = vitest 的 `invocationCallOrder`（与 `ws.gateway.test.ts` 的
   * 「bots 读先于归池 DEL」时序判据同款）—— 只看最终键值**抓不住**顺序缺陷。
   */
  it("F1′（波 1 核验）：addToQueue 的调用序 —— HSET meta 先于 ZADD（孤儿误清窗口的封口）", async () => {
    await service.addToQueue('player-1', 'random', 15);

    const hsetMock = redis.hset as unknown as ReturnType<typeof vi.fn>;
    const zaddMock = redis.zadd as unknown as ReturnType<typeof vi.fn>;
    const hsetIdx = hsetMock.mock.invocationCallOrder[0];
    const zaddIdx = zaddMock.mock.invocationCallOrder[0];
    // 正对照：两步都必须真的发生过（否则本条是空转）
    expect(hsetIdx, '正对照：必须真的写过 meta').toBeDefined();
    expect(zaddIdx, '正对照：必须真的写过队列').toBeDefined();
    expect(
      hsetIdx!,
      'HSET meta 必须先于 ZADD —— 反了的话扫描前置筛选会把「有票无 meta」的正在入队票当孤儿静默清出（波 1 核验 F1′）',
    ).toBeLessThan(zaddIdx!);
  });

  /**
   * **② 金币场 §2.1（三值化 · C21 的单测载体）**：`readMeta` 必须**保真三值** ——
   * 修前它把「非 practice」一律归一成 `'random'`（二值时代的形状），后果是**金币票的
   * `cancelQueue` 照着归一出错键**（`match:queue:random:…`）：ZREM 落空、meta 一删
   * ⇒ 票永远残留 `match:queue:gold:*`（C21 的「取消后 60s 内不得再被撮合」直接失效）。
   */
  describe('② 三值化：readMeta 保真 + gold 票的取消/入队/撮合（§2.1 · C21）', () => {
    const T0 = 1_700_000_000_000;

    it('readMeta 保真三值：gold 票原样读回 gold（不得归一成 random）', async () => {
      service.setClock(() => 1000);
      await service.addToQueue('p-gold', 'gold', 15);

      const ticket = await service.readMeta('p-gold');
      // 修前这里是 'random' ⇒ 下面 cancelQueue 的键就错了（本条与下一条是一对）。
      expect(ticket?.mode).toBe('gold');
      expect(redis._hashes.get('match:meta:p-gold')?.mode).toBe('gold'); // 落盘形态自证
    });

    it('readMeta 兼容旧 meta：不认识/缺省的 mode 仍落 random（不得抛）', async () => {
      await redis.hset('match:meta:p-legacy', { mode: 'ranked', baseScore: '15' });
      await redis.hset('match:meta:p-empty', { baseScore: '15' });

      expect((await service.readMeta('p-legacy'))?.mode).toBe('random');
      expect((await service.readMeta('p-empty'))?.mode).toBe('random');
    });

    it('🔴 C21：cancelQueue 对 gold 票 ZREM **正确的键**、meta 清、队列无残留', async () => {
      service.setClock(() => 1000);
      await service.addToQueue('player-1', 'gold', 15);
      // 反空测①：票真的在金币队列上（否则「清干净了」什么都不证明）。
      expect(redis._zsets.get('match:queue:gold:15:global')?.has('player-1')).toBe(true);

      await service.cancelQueue('player-1');

      // 判别力：readMeta 归一错的实现下，ZREM 打的是 `match:queue:random:…` ⇒ 本条恒红。
      expect(redis._zsets.get('match:queue:gold:15:global')?.has('player-1')).toBe(false);
      expect(redis._zsets.get('match:queue:gold:15:global')?.size).toBe(0); // 无残留
      expect(redis._hashes.has('match:meta:player-1')).toBe(false);
      // 反空测②：正确的键不是靠「把别的键也扫一遍」清掉的（这两条队列从未被写过）。
      expect(redis._zsets.get('match:queue:random:15:global')).toBeUndefined();
      expect(redis._zsets.get('match:queue:practice:15:global')).toBeUndefined();
    });

    it('三值化后扫描器处理 gold 队列：三人齐 ⇒ 以 mode gold 建房（MATCH_MODES → 解析 → 撮合全跟进）', async () => {
      service.setClock(() => T0);
      await service.addToQueue('g1', 'gold', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('g2', 'gold', 15);
      service.setClock(() => T0 + 2);
      await service.addToQueue('g3', 'gold', 15);
      service.setClock(() => T0 + 1_000); // 三人齐、未越窗口 ⇒ 直接成局

      await service.scanOnce();

      expect(roomsService.createGameRoom, 'gold 队列必须被扫到并撮合').toHaveBeenCalledWith(
        ['g1', 'g2', 'g3'],
        'gold',
        15,
        'doudizhu',
        3,
      );
      // 房间元数据真的带上了 gold（结算守卫（T5）就是从这里读 `mode === 'gold'`）
      expect((await globalService.findOne('ABC123'))?.mode).toBe('gold');
    });
  });

  /**
   * `matchQueueKey` ↔ `parseMatchQueueKey` 的**逆函数**性质（片规格 §2.4）：
   * 每轮匹配扫描就是「扫键 → 解析 → processQueue」，两者一旦漂移，
   * 扫描会**静默**跳过全部队列（解析失败 ⇒ continue）—— 那种缺陷必须在这里现形。
   */
  it('parseMatchQueueKey 是 matchQueueKey 的逆：玩法/人数/底分/region 原样拆回（含 ② gold）', () => {
    // 多玩法 Task 2.1：斗地主仍走旧 3 段键 ⇒ 解析结果带 `legacy: true` 与 ddz/3 缺省。
    expect(parseMatchQueueKey(matchQueueKey('random', 'doudizhu', 3, 15))).toEqual({
      key: 'match:queue:random:15:global',
      mode: 'random', gameType: 'doudizhu', playerCount: 3,
      baseScore: 15, region: 'global', legacy: true,
    });
    expect(parseMatchQueueKey(matchQueueKey('practice', 'doudizhu', 3, 480, 'cn-east'))).toEqual({
      key: 'match:queue:practice:480:cn-east',
      mode: 'practice', gameType: 'doudizhu', playerCount: 3,
      baseScore: 480, region: 'cn-east', legacy: true,
    });
    // ② §2.1：gold 是 MATCH_MODES 的新成员 —— 正则从它构造 ⇒ 解析自动跟进（若某处
    // 手写了第二份模式字面量，这里就是抓它的地方）。
    expect(parseMatchQueueKey(matchQueueKey('gold', 'doudizhu', 3, 1200, 'cn-east'))).toEqual({
      key: 'match:queue:gold:1200:cn-east',
      mode: 'gold', gameType: 'doudizhu', playerCount: 3,
      baseScore: 1200, region: 'cn-east', legacy: true,
    });
    // 坏键/无关键返回 null（调用方跳过，不得把整轮扫描带崩）
    expect(parseMatchQueueKey('match:queue:ranked:15:global')).toBeNull();
    expect(parseMatchQueueKey('match:queue:random:abc:global')).toBeNull();
    expect(parseMatchQueueKey('match:meta:u1')).toBeNull();
  });

  it('人数闸在扫描轮关闭：在队 2 人票整桶 failMatch（实际 5 段键），不建房、不抛', async () => {
    const T0 = 1_700_000_000_000;
    configCache.paodekuaiEnabled.mockReturnValue(true);
    configCache.paodekuaiTwoPlayerEnabled.mockReturnValue(false);
    configCache.freeBotFillEnabled.mockReturnValue(false);
    service.setClock(() => T0);
    for (const id of ['u1', 'u2']) {
      await service.addToQueue(id, 'random', 15, undefined, undefined, {
        gameType: 'paodekuai',
        playerCount: 2,
      });
    }
    service.setClock(() => T0 + 1_000);
    const publishMock = redis.publish as unknown as {
      mockClear(): void;
      mock: { calls: unknown[][] };
    };
    publishMock.mockClear();

    await expect(service.scanOnce()).resolves.toBeUndefined();

    const key = 'match:queue:random:paodekuai:2:15:global';
    expect(redis.zrem).toHaveBeenCalledWith(key, 'u1');
    expect(redis.zrem).toHaveBeenCalledWith(key, 'u2');
    expect(redis._zsets.get(key)?.size ?? 0).toBe(0);
    expect(redis._hashes.has('match:meta:u1')).toBe(false);
    expect(redis._hashes.has('match:meta:u2')).toBe(false);
    expect(roomsService.createGameRoom, '闸关不得建房').not.toHaveBeenCalled();
    const published = publishMock.mock.calls.map((c) => String(c[1]));
    expect(published.some((p) => p.includes('"code":12007') && p.includes('u1'))).toBe(true);
  });

  it('starts the scan loop exactly once, on module init (§7.3 偏差 A4)', () => {
    const spy = vi.spyOn(service, 'startMatchingLoop');
    service.onModuleInit();
    service.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(service['scanTimer']).not.toBeNull();
  });

  // ── 判据 11（单测半边）：定时器链路 `source: 'timer'`（R1107 / 复核⑭）────────
  //
  // 与 `rooms.reaper.test.ts` / `rooms.autostart.test.ts` 的两条**同形**：匹配扫描器也是
  // 定时器驱动的一轮工作（spec §3 载体表「定时器」行，复核⑭ 补上的两条循环之一）⇒
  // 一轮 `scanOnce()` 里产生的行必须带**这一轮自建**的 traceId + `source: 'timer'`
  //（ALS 里**真**没有值时才该降级 `null` + `bootstrap`）。
  //
  // 观测口同形：`Logger.overrideLogger` 装捕获 sink（Nest 的 logger 是**进程级**的，
  // 服务自己 `new Logger(...)` 打的行就全部进来 —— 不必抓 stdout）。
  it('判据 11：匹配扫描一轮的日志带 source=timer 且 traceId 非空（无来源才该是 null）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

    const T0 = 1_700_000_000_000;
    service.setClock(() => T0);
    await service.addToQueue('u1', 'random', 15);
    service.setClock(() => T0 + 1);
    await service.addToQueue('u2', 'random', 15);
    service.setClock(() => T0 + 2);
    await service.addToQueue('u3', 'random', 15);

    await service.scanOnce();

    // 反空测①：这一轮必须**真的**成局（`Matched … seats to room …` 行只在成局路径上打；
    // 只断言「日志行存在」的话，将来另一条路径恰好打出 'Matched' 也会让它假绿）
    expect(roomsService.createGameRoom, '这一轮必须真的建了房（否则断言的是空）').toHaveBeenCalledWith(
      ['u1', 'u2', 'u3'],
      'random',
      15,
      'doudizhu',
      3,
    );
    // 反空测②：那行日志真的在记录里（找不到行 ⇒ 用带消息的 toBeDefined 显式挂掉，
    // 而不是让后面两条断言以晦涩方式报错）
    const line = records.find((r) => r.msg.includes('Matched'));
    expect(line, '成局那行日志必须在（否则本判据空转）').toBeDefined();
    expect(line!.source).toBe('timer');
    expect(line!.traceId).not.toBeNull();
  });

  describe('30 秒等待窗口与冷启动补机器人（§8.4 / R44）', () => {
    const T0 = 1_700_000_000_000;

    it('人数不足且未到窗口 → 不成局、不补机器人、**人还在队列里**', async () => {
      // ⚠️ 这条对**旧实现没有区分力**（旧代码 `members.length < 3` 早退，单人同样不成局）——
      // 它的定位是**防回归**：挡住「窗口检查被删掉，<3 人就立刻补位」这种回归。
      // R44/R64 的 RED 证据在下面两条（2 人窗口期 / 越过窗口）。
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 29_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      // 反向断言：旧实现在这里把 u1 丢了 —— 这正是本切片要修的缺陷
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(true);
    });

    it('2 人在队列里等 29 秒 → 不成局不补位；到 31 秒 → 恰好补 1 个机器人（R44/R64）', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('u2', 'random', 15);

      service.setClock(() => T0 + 29_000);
      await service.scanOnce();
      // 旧实现在这里会**立刻**成局并补 1 个机器人（只挡 0 候选），所以这条对旧代码是 RED
      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      expect(redis._zsets.get('match:queue:random:15:global')?.get('u1')).toBe(T0);
      expect(redis._zsets.get('match:queue:random:15:global')?.get('u2')).toBe(T0 + 1);

      service.setClock(() => T0 + 31_000);
      await service.scanOnce();
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(1); // 只补 1 个
    });

    it('越过窗口 → 补 2 个机器人成局，且**只**给人类发 room.matched（§8.4②/R47）', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 30_001);

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(2); // robot.acquire ×2
      expect(roomsService.addBot).toHaveBeenCalledTimes(2);

      const published = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
        ([channel]) => channel === 'match:events',
      );
      const event = JSON.parse(published![1] as string);
      expect(event).toMatchObject({ event: 'room.matched', roomCode: 'ABC123' });
      expect(event.seats).toEqual([{ userId: 'u1', seat: 0 }]); // 机器人不进 room.matched（R47）

      // R47：只给人类写 match:pending
      expect(redis._hashes.get('match:pending:u1')).toEqual({ roomCode: 'ABC123', seat: '0' });
      expect([...redis._hashes.keys()].filter((k) => k.startsWith('match:pending:bot-'))).toEqual([]);

      // 出队：人类与 meta 都清掉
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(false);
      expect(redis._hashes.has('match:meta:u1')).toBe(false);
    });

    /**
     * 🔴 **片规格 §2.5 的核心判据**：不同底分**不会**被撮进同一个房。
     *
     * 判别力来自**注入次序**（mutation 自证过）：若队列键少了底分那一维，四人会落进
     * 同一条队列 ⇒ 「先到的三人」是 p1/p2/p3（含拿了 480 的 p2）—— 第一条断言当场红。
     * 这里的形态是「15 那条三人齐（立刻成局）、480 那条一人在窗口内（不成局）」，
     * 一次 `scanOnce` 就能同时看到「撮上了」与「**没**被撮进去」两面。
     */
    it('🔴 不同底分**不会**被撮进同一个房（片规格 §2.5）', async () => {
      service.setClock(() => T0);
      await service.addToQueue('p1', 'random', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('p2', 'random', 480); // ← 唯一拿了 480 的人，插在中间
      service.setClock(() => T0 + 2);
      await service.addToQueue('p3', 'random', 15);
      service.setClock(() => T0 + 3);
      await service.addToQueue('p4', 'random', 15);
      service.setClock(() => T0 + 1_000); // 只等 1 秒：15 那条齐了，480 那条还在窗口里

      await service.scanOnce();

      // ① 只建了**一个**房，里面恰好是 15 那条队列的三个人（p2 必须**不在**）
      expect(roomsService.createGameRoom).toHaveBeenCalledTimes(1);
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['p1', 'p3', 'p4'], 'random', 15, 'doudizhu', 3);
      // ② 反面对照：把「谁不在」显式钉一遍（① 的数组相等已隐含，但这条让失败信息直说 p2）
      expect(roomsService.createGameRoom.mock.calls[0]![0], '480 分的人不得进 15 分的房').not.toContain('p2');
      // ③ 房间底分**就是**那一维（选了底分真的生效：房间元数据 → game.start → 结算）
      expect(redis._hashes.get('room:ABC123')?.baseScore).toBe('15');
      // ④ p2 没有被撮进任何房：没有 pending，票还在自己那条队列里（下一个周期继续等）
      expect(redis._hashes.has('match:pending:p2')).toBe(false);
      expect(redis._zsets.get('match:queue:random:480:global')?.has('p2')).toBe(true);
    });

    it('3 人齐 → 立刻成局，不等窗口也不补机器人', async () => {
      // ⚠️ 三人的 score **必须不同**：真实 Redis 对相同 score 的成员按 member 字典序排，
      //    而不是按插入序。用递增毫秒才与生产语义一致（否则这条用例在真机上会偶发反过来）。
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('u2', 'random', 15);
      service.setClock(() => T0 + 2);
      await service.addToQueue('u3', 'random', 15);
      service.setClock(() => T0 + 1_000); // 只等了 1 秒

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'random', 15, 'doudizhu', 3);
      // ⚠️ 必须**按 pattern** 断言：`game.start` 也走同一个 `send`（旧实现同款说明）。
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      const event = JSON.parse(
        (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
          ([c]) => c === 'match:events',
        )![1] as string,
      );
      expect(event.seats).toEqual([
        { userId: 'u1', seat: 0 },
        { userId: 'u2', seat: 1 },
        { userId: 'u3', seat: 2 },
      ]);
    });

    /**
     * N31/R452：`room.status` 的**第二次转移**（`waiting` → `playing`）必须在开局成功后落地。
     *
     * 判据两条，缺一不可：
     *  ① Redis 里真的写进了 `playing`（用**真实** `RoomsService` + 状态化替身读回来，
     *     而不是断言「替身的 `updateStatus` 被调过」）；
     *  ② 这次写入发生在 `game.start` **之后** —— R452 要求「开局成功**后**」写，
     *     而顺序用 `toHaveBeenCalledWith` 一条判据是**测不出来**的。
     */
    it('开局成功后 room.status 必须是 playing，且这次写入在 game.start 之后（N31/R452）', async () => {
      // 真实 RoomsService 接在**同一个**状态化 Redis 替身上：`createGameRoom` 会真的
      // 建出 `room:{code}` / `room:{code}:seats`，因此 `findOne` 读回的就是落盘值。
      const realRooms = new RoomsService(redis as unknown as Redis, asConfigCache(configCache));
      const updateStatusSpy = vi.spyOn(realRooms, 'updateStatus');
      const svc = new MatchService(
        redis,
        realRooms,
        new RoomStartService(redis, realRooms, new GameClient(rpc.proxy), new RobotClient(rpc.proxy), {
          get: vi.fn(),
          apply: vi.fn(),
        } as never, {
          ensureBots: vi.fn(),
          afterSettle: vi.fn(),
        } as never, {
          // 断点④修复（Task 5）：重连记录写边 —— 轻替身（本文件断言与它无关）。
          touch: vi.fn().mockResolvedValue(undefined),
        } as unknown as ReconnectService,
        // 本片：台费费率表读边（与 RoomsService 同一桩实例）。
        asConfigCache(configCache)),
        asConfigCache(configCache),
        // 片② D5：可用性门禁的注入点（同一个假 proxy）。
        new RobotClient(rpc.proxy),
      );
      svc.setRng(IDENTITY_RNG); // 风控 T2：本用例的断言与组序无关，但洗牌仍须可复现
      svc.setClock(() => T0);
      await svc.addToQueue('u1', 'random', 15);
      svc.setClock(() => T0 + 1);
      await svc.addToQueue('u2', 'random', 15);
      svc.setClock(() => T0 + 2);
      await svc.addToQueue('u3', 'random', 15);
      svc.setClock(() => T0 + 1_000); // 只等了 1 秒 ⇒ 三人齐、不补机器人

      await svc.scanOnce();

      // 房间号是随机生成的 ⇒ 从落盘的键里取（`room:{6 位大写 base36}`，排除派生键）
      const roomKey = [...redis._hashes.keys()].find((k) => /^room:[0-9A-Z]{6}$/.test(k));
      expect(roomKey).toBeDefined();
      const room = await realRooms.findOne(roomKey!.slice('room:'.length));
      expect(room?.status).toBe('playing');

      // ② 顺序：`game.start` 的发送必须**早于**写 `playing`（R452：开局成功后）
      const startIndex = rpc.calls.findIndex((c) => c.pattern === RPC_PATTERNS.gameStart);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      const startOrder = rpc.send.mock.invocationCallOrder[startIndex]!;
      const updateOrder = updateStatusSpy.mock.invocationCallOrder[0]!;
      expect(updateOrder).toBeGreaterThan(startOrder);
    });

    it('补机器人失败 → 回队且**保留原 enteredAt**、attempts 累加、孤儿房间标 cancelled', async () => {
      rpc.on(RPC_PATTERNS.robotAcquire, () => throwError(() => new Error('robot-service down')));
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      // §8.4 逐字：「必须保留原始 enteredAt」，否则等待最久的人被反复降级到队尾
      expect(redis._zsets.get('match:queue:random:15:global')?.get('u1')).toBe(T0);
      expect(redis._hashes.get('match:meta:u1')?.attempts).toBe('1');
      // 已建但没凑齐的房间不能留在房间列表里（§3.1 的 cancelled 是终态）
      expect(roomsService.cancelIfStillWaiting, '降级要经 CAS（R1003）').toHaveBeenCalledWith('ABC123');
      // ⚠️ **落盘**断言（本片补）：真房间里 `status` 真的变成了 `cancelled` ——
      // 只断言「替身的某个方法被调过」是**结构**判据，而这条链要的语义是**状态真的变了**。
      expect(
        (await globalService.findOne('ABC123'))?.status,
        'CAS 必须真的写进 Redis（不是「方法被调过」）',
      ).toBe('cancelled');
      expect(redis._hashes.has('match:pending:u1')).toBe(false);
    });

    /**
     * 🔴 **Task 3c 修复 3（一行·corr）**：`listQueueKeys()` 必须去重。
     *
     * Redis 的游标式 `SCAN` **不保证不重复**（文档明写：同一个元素可能在多次迭代里
     * 被返回多次）—— 而 `scanAndMatchInner` 是「一个键 = 一轮 `processQueue`」。
     * 重复那一轮会把 `incrementAttempts` 多跑一次 ⇒ 玩家在**什么都没变**的情况下
     * 提前耗掉 `MATCH_MAX_ATTEMPTS`（10 次）的重试预算，拿不到 60 秒的完整等待窗口。
     *
     * ⚠️ **必须用行为判据**（`attempts` 的值），不能断言「`processQueue` 被调了几次」
     * —— 那是结构判据，而这条修法要的语义是「重试预算没被多扣」。替身的 `scan`
     * 照真实语义**两页各返回同一个键**（去重前：`attempts` = 2）。
     */
    it('🔴 SCAN 返回重复键 ⇒ 同一条队列只处理一次（attempts 不得被多加一次）', async () => {
      rpc.on(RPC_PATTERNS.robotAcquire, () => throwError(() => new Error('robot-service down')));
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 31_000);

      const queueKey = 'match:queue:random:15:global';
      (redis.scan as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async (cursor: string) =>
          cursor === '0' ? ['1', [queueKey]] : ['0', [queueKey]],
      );

      await service.scanOnce();

      // 去重前这里是 '2'（同一轮降级被扣了两次预算）—— 这条断言就是那个差值。
      expect(redis._hashes.get('match:meta:u1')?.attempts).toBe('1');
    });

    /**
     * 🔴 **那处降级的顺序**（spec §3.3 / §3.1 的「难度判据」，本片换思路重做）。
     *
     * `startRoom` 返回 `false` 有**两种**原因，而降级只该收拾**其中一种**：
     *  ① 补位/开局失败 ⇒ 房间还在 `waiting` ⇒ **该**降级（上一条用例，正对照）；
     *  ② 房间**已被别人开起来**（`playing`）⇒ 那是别人的对局，**不得**动它（本条）。
     *
     * **要证明的是 CAS 把两者分辨开了**，且 `MatchService` 把决定**交给** CAS。
     *
     * ⚠️ **上一个会话三版都没写出来**，现象是「`cancelIfStillWaiting` 根本没被调到 —— 路径
     * 没走到 CAS」。这次换的注入点解释了那个现象：**必须在 `createGameRoom` 之后置
     * `playing`**。
     *  - 提前置 ⇒ `createGameRoom` 内部的 `create()` 走 `writeMeta`，**整张元数据 Hash 重写**，
     *    `status` 被静默改回 `waiting` ⇒ `startRoom` 一路成功 ⇒ 压根没有降级可言；
     *  - 靠替身记状态 ⇒ 更糟：那与真房间是**两份记录**，判据测的是替身（本片已把替身改成
     *    透明代理，见 `makeMockRoomsService`）。
     */
    it('🔴 房间已被别人开起来（playing）⇒ 降级不得把它改回 cancelled（spec §3.3）', async () => {
      // 注入点：房间**刚建好、开局链还没跑**的那一刻 —— 这正是 §0.2 那个竞态的窗口
      //（匹配扫描器正在补位，另一个定时器（自动开局扫描器）把房间推到了 `playing`）。
      const original = roomsService.createGameRoom.getMockImplementation()!;
      roomsService.createGameRoom.mockImplementation(
        async (ids: string[], mode: 'random' | 'practice', baseScore: number) => {
          const room = await original(ids, mode, baseScore);
          await globalService.updateStatus('ABC123', 'playing'); // 别人赢了这一场
          return room;
        },
      );
      rpc.on(RPC_PATTERNS.robotAcquire, () => throwError(() => new Error('robot-service down')));
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      // ① 决定**经**了 CAS（R1003：降级只有这一条路，不得自己 `findOne` 一眼就下结论）
      expect(roomsService.cancelIfStillWaiting, '决定必须交给 CAS').toHaveBeenCalledWith('ABC123');
      // ② **落盘**：别人的对局一格未动（这是本条的**语义**判据，①②缺一不可）
      expect((await globalService.findOne('ABC123'))!.status, '别人的对局不得被取消').toBe('playing');
      // ③ 不得把它当成「该降级」：`attempts` 不累加（那是降级的另一半，上一条用例钉住的）
      expect(redis._hashes.get('match:meta:u1')?.attempts).toBe('0');
      // ④ 不丢人（§8.4②）：票还在队列里，下一个周期继续匹配
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(true);
    });

    /**
     * 🔴 **风控 §2.4-4 明改点（T2）**：到点者（60s）**不再直走 `failMatch`** ——
     * 「正常抽取先行；本轮未成组者 ⇒ 兜底集合（⚙️14 贪心成组 + 机器人）；门禁不能给 ⇒ 12007」。
     *
     * 本用例 = 单人版本：无人可抽 ⇒ 直接落兜底 ⇒ 「本人 + 2 机器人」成局。
     * ⚠️ 旧实现（改造前）在这里 `failMatch(u1)` ⇒ 12007 + 出队（修前的那条断言）。
     * 「门禁不能给 ⇒ 12007」的负对照在「风控 T2」describe 的兜底用例里。
     */
    it('等待超过 60 秒 → 到点者并入抽取并兜底成局（本人 + 2 机器人；不再直走 12007 —— §2.4-4）', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 60_001);

      await service.scanOnce();

      // 成局：单人 + 2 机器人（既有 ⑥ 越窗主路径的形态；到点者不再被 12007 直接淘汰）
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(2);
      // 反空测：**不得**出现任何 match.timeout（旧实现的第一步就是 failMatch）
      const events = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter(([channel]) => channel === 'match:events')
        .map(([, payload]) => JSON.parse(payload as string));
      expect(events.filter((e) => e.event === 'match.timeout')).toHaveLength(0);
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(false); // 成局即出队
    });

    /**
     * 🔴 **风控 §2.4-4 明改点（T2）+ 波 1 F1 修复 · R57 的适配**：残留旧票分两种形态 ——
     *  - **孤儿票**（meta 已过期/读不到 —— 崩溃残留的 R63 形态）：**前置静默清出**
     *    （`cancelQueue`，无 12007 —— 所有者已不存在），**不得**进任何房（否则就是
     *    「永不有人加入的座」）；
     *  - **到点者（有 meta）**：并入正常抽取（本轮是单人 ⇒ 兜底成局）。
     * 本用例钉住孤儿那一半 + 其余票按窗口语义照常成局；到点者那一半在「风控 T2」describe。
     */
    it('R57 适配（波 1 F1）：孤儿票（meta 已过期）前置清出且不进任何房；u1/u2 按窗口语义成局', async () => {
      // 复现「上一次运行残留的无 TTL 成员」：入队时刻在 10 分钟之前
      service.setClock(() => T0 - 600_000);
      await service.addToQueue('ghost', 'random', 15);
      // meta 整键过期（ZSet 成员**没有** TTL ⇒ 残留）—— 这才是「孤儿」的定义形态
      redis._hashes.delete('match:meta:ghost');
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('u2', 'random', 15);
      service.setClock(() => T0 + 31_000); // u1/u2 均越 30s 窗口

      await service.scanOnce();

      const events = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter(([channel]) => channel === 'match:events')
        .map(([, raw]) => JSON.parse(raw as string));
      // ① 幽灵被清出（不占位）、零 12007（所有者已不存在 —— 静默清理）
      expect(redis._zsets.get('match:queue:random:15:global')?.has('ghost')).toBe(false);
      expect(events.filter((e) => e.event === 'match.timeout')).toHaveLength(0);
      // ② 幽灵**不得**出现在任何建房调用里（判别「拿孤儿凑数」的错读法）
      expect(roomsService.createGameRoom).toHaveBeenCalledTimes(1);
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2'], 'random', 15, 'doudizhu', 3);
      // ③ u1/u2 按窗口语义成局（2 人 + 1 机器人）
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(1);
    });

    it('acquireBot 打的是 RPC_PATTERNS.robotAcquire，载荷 `{roomCode, seats:[seat], gameType}` 逐字（R218/R219 + Task 2.6）', async () => {
      // ⚠️ pattern 名写错时，ClientProxy 替身**不会**失败 —— 只有真实拓扑才永不回包
      // （R70 的教训换了个载体，没有消失）。所以必须比对 pattern 与载荷**逐字**。
      //
      // ⚠️ 只入队 1 人 ⇒ `botSeats = 2`（§8.4②）⇒ 2 次 `robot.acquire`，空缺座位是 1、2
      // （`requestedSeat = humans.length + i`）。**两次都断言**，才能同时钉住
      // 「打的是哪个 pattern」与「每次打的是哪个座位」。
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 30_001);

      await service.scanOnce();

      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toEqual([
        // R201/R207：载荷是 `{ roomCode, seats: [...] }`（空缺**座位号**数组）
        //
        // ⚠️ **判据 5 / R1104（本片）**：本路径由 `scanOnce()` 的 **timer ALS** 包裹
        //（`runWithTrace({traceId: randomUUID(), source:'timer'})`）⇒ 这一轮**有** traceId
        // ⇒ 载荷多出 `meta`。业务字段仍是**逐字**的；「无 ALS ⇒ 无 `meta` 键」那一半由
        // 「判据 5」describe 的**直调**用例覆盖（那里没有被扫描轮的 id 覆盖掉）。
        { roomCode: 'ABC123', seats: [1], gameType: 'doudizhu', meta: { traceId: expect.any(String) } },
        { roomCode: 'ABC123', seats: [2], gameType: 'doudizhu', meta: { traceId: expect.any(String) } },
      ]);
      // 同一轮扫描里的两跳 RPC 必须带**同一个** id（R1104：它是「**这一轮**」的 traceId）——
      // 只断言 `any(String)` 是测不出「两跳各编一个 id」这种缺陷的。
      const acquireIds = (
        rpc.payloadsOf(RPC_PATTERNS.robotAcquire) as Array<{ meta: { traceId: string } }>
      ).map((p) => p.meta.traceId);
      expect(new Set(acquireIds).size, '同一轮的两跳 RPC 必须共用一个 traceId').toBe(1);
    });

    /**
     * R151（A7 证据行点名的另一半）：`robot.acquire`（room → robot）此前**没有超时**
     * —— `docs/design.md` §4.3 给它的上限是 **3s**。下游卡住会把整个匹配周期一起挂住，
     * 而 §8.4 的「30 秒补机器人」正是靠周期重试的 ⇒ 没有超时等于补位机制整体失效。
     *
     * ⚠️ N20/P4 Task 3：超时载体从 `HttpService` 的 `timeout:` 换成 `RobotClient` 内的
     * `timeout(ROBOT_ACQUIRE_TIMEOUT_MS)` —— 判据因此**走真实 pipeline**：给一个
     * 永不回包的 `NEVER`，断言到 3s 就失败（而不是挂住）。
     */
    it('acquireBot 的超时是 3000ms（R151：§4.3 给 robot.acquire 的上限）', async () => {
      vi.useFakeTimers();
      try {
        rpc.on(RPC_PATTERNS.robotAcquire, () => NEVER);
        service.setClock(() => T0);
        await service.addToQueue('u1', 'random', 15);
        service.setClock(() => T0 + 31_000);

        const scan = service.scanOnce();
        // 还差 100ms 到超时：两次尝试（withRetry）都还没结束
        await vi.advanceTimersByTimeAsync(ROBOT_ACQUIRE_TIMEOUT_MS * RPC_MAX_ATTEMPTS - 100);
        // 越过两次超时：补位失败 ⇒ §8.4② 的降级（房间 cancelled，人不丢）
        await vi.advanceTimersByTimeAsync(200);
        await scan;

        expect(ROBOT_ACQUIRE_TIMEOUT_MS).toBe(3000);
        expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(RPC_MAX_ATTEMPTS);
        expect(roomsService.cancelIfStillWaiting, '降级要经 CAS（R1003）').toHaveBeenCalledWith('ABC123');
        expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('game.start 收到的是**对外 displayId**（并带上内部 botId + skillLevel，R48/R207）', async () => {
      // 真实 robot-service 按座位发不同 id；用 seat 派生，才能同时钉住「哪张票去了哪个座位」。
      // ⚠️ `id` 是**对外** displayId（`p_…`），`botId` 是**内部** id（永不出站）—— 两者分离是 E9。
      rpc.on(RPC_PATTERNS.robotAcquire, (data) =>
        of({
          ok: true,
          data: {
            bots: ((data as { seats?: number[] }).seats ?? []).map((seatNo) => ({
              ...botOf(seatNo, `bot-internal-${seatNo}`),
              displayId: `p_seat${seatNo}0000`.slice(0, 10),
            })),
          },
        }),
      );
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 30_001);

      await service.scanOnce();

      // game-service 按 id 建 GameSession.players、按 id 路由玩家动作：
      // 这里若送 `seat-1`，机器人座位在 game-service 里根本不存在。
      const startPayloads = rpc.payloadsOf(RPC_PATTERNS.gameStart);
      expect(startPayloads).toHaveLength(1);
      const body = startPayloads[0] as { players: unknown };
      expect(body.players).toEqual([
        { id: 'u1', seat: 0, isRobot: false },
        { id: 'p_seat1000', seat: 1, isRobot: true, botId: 'bot-internal-1', skillLevel: 'beginner', thinkingSpeed: 900 },
        { id: 'p_seat2000', seat: 2, isRobot: true, botId: 'bot-internal-2', skillLevel: 'beginner', thinkingSpeed: 900 },
      ]);
      // R207：`seat → botId` 落 `room:{code}:bots`（局终 release 的唯一来源）
      expect(redis._hashes.get('room:ABC123:bots')).toEqual({
        '1': 'bot-internal-1',
        '2': 'bot-internal-2',
      });
    });
  });

  /**
   * 机器人补位开关片（免费场/金币场各一个开关 + 无机器人等待总上限）：
   * 开关关 ⇒ 缺人**绝不补机器人**，30s 发友好提示、上限（缺省 300s）到点 12007；
   * 3 名真人齐仍正常开局；practice（好友房）路径不受开关管控。
   */
  describe('机器人补位开关片：关闭时缺人只提示不补机器人、到上限 12007', () => {
    const T0 = 1_700_000_000_000;

    /** 收集发到 match:events 的已解析事件（每轮 scanOnce 后调用）。 */
    const publishedEvents = (): Array<Record<string, unknown>> =>
      (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter(([channel]) => channel === 'match:events')
        .map(([, raw]) => JSON.parse(raw as string) as Record<string, unknown>);

    /**
     * 面向玩家的文案红线：
     *  - 友好、中性，不提「真人 / 机器人 / 玩家不足」（不能暴露机器人补位）；
     *  - 长度 ≤ 16 字：悬浮卡片按单行排版，2 行会压住「取消匹配」（设计 spec §4.3）。
     * 旧文案同时作为负样本，证明判据真的能抓住回归。
     */
    it('C10/C11：等待提示文案友好、不暴露机器人且长度受控', () => {
      expect(MATCH_WAIT_PROMPT_MESSAGE).toBe('正在为你安排牌桌，请稍等片刻。');
      expect(MATCH_WAIT_PROMPT_MESSAGE.length).toBeLessThanOrEqual(16);

      const banned = ['真人', '机器人', '玩家不足'];
      for (const word of banned) {
        expect(MATCH_WAIT_PROMPT_MESSAGE).not.toContain(word);
      }

      // 判别力自证：旧文案必须被同一组谓词命中。
      const oldCopy = '当前在线真人玩家不足，可延长匹配时间继续等待，或重新匹配';
      expect(banned.some((word) => oldCopy.includes(word))).toBe(true);
      expect(oldCopy.length).toBeGreaterThan(16);
    });

    it('关 + 1 人未到 30s 窗口 ⇒ 不提示、不建房、票留队（开关本身零行为变化）', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 29_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      expect(publishedEvents()).toEqual([]);
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(true);
    });

    it('关 + 2 人越过 30s ⇒ 发恰好一条 match.wait_prompt（不建房/不调机器人），票留队', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('u2', 'random', 15);
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      const events = publishedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        event: 'match.wait_prompt',
        playerIds: ['u1', 'u2'],
        message: MATCH_WAIT_PROMPT_MESSAGE,
      });
      // 票与 meta 原样保留（提示不是终止）；meta 里落下本窗口的占位字段。
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(true);
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u2')).toBe(true);
      // u1 锚点 = T0；31s 落在窗口 floor(31000/30000)=1（窗口 0 是到点前的静默期，永不领取）。
      expect(redis._hashes.get('match:meta:u1')![`promptWin:${T0}:1`]).toBe(String(T0 + 31_000));
    });

    it('关：同一 30s 窗口内重复扫描 ⇒ 不重发提示（HSETNX 原子占位，每窗口至多一条）', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);

      service.setClock(() => T0 + 31_000);
      await service.scanOnce();
      service.setClock(() => T0 + 45_000);
      await service.scanOnce();
      service.setClock(() => T0 + 59_999);
      await service.scanOnce();

      expect(publishedEvents()).toHaveLength(1);
    });

    it('关：进入下一个 30s 窗口（60s）⇒ 再次提示；两次窗口各一条', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);

      service.setClock(() => T0 + 31_000);
      await service.scanOnce();
      service.setClock(() => T0 + 60_000);
      await service.scanOnce();

      const events = publishedEvents();
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.event === 'match.wait_prompt')).toBe(true);
      expect(redis._hashes.get('match:meta:u1')![`promptWin:${T0}:2`]).toBe(String(T0 + 60_000));
    });

    it('关：extendWait 平移提示锚点 ⇒ 接下来一个窗口内对本人不提示（延长 = 留队继续等）', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('u2', 'random', 15);

      // 31s：两人都收到首次提示。
      service.setClock(() => T0 + 31_000);
      await service.scanOnce();

      // u1 在 32s 点了「继续等待」⇒ 锚点平移，并预置领取新锚点窗口 0。
      service.setClock(() => T0 + 32_000);
      await service.extendWait('u1');
      const u1Meta = redis._hashes.get('match:meta:u1')!;
      expect(u1Meta.promptAnchorAt).toBe(String(T0 + 32_000));
      expect(u1Meta[`promptWin:${T0 + 32_000}:0`]).toBe(String(T0 + 32_000));

      // 60.001s：u2（锚点 T0+1）进入窗口 2 再收一条；u1 相对新锚点仍在窗口 0（已预置领取）⇒ 不收。
      service.setClock(() => T0 + 60_001);
      await service.scanOnce();
      const events = publishedEvents();
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ event: 'match.wait_prompt', playerIds: ['u2'] });

      // 62.001s：u1 相对新锚点进入窗口 1 ⇒ 提示恢复（延长只推迟一个窗口，不是免打扰）；
      // u2 仍在自己的窗口 2（T0+60001..T0+90001）⇒ 同窗口不重发。
      service.setClock(() => T0 + 62_001);
      await service.scanOnce();
      const events2 = publishedEvents();
      expect(events2).toHaveLength(3);
      expect(events2[2]).toMatchObject({ event: 'match.wait_prompt', playerIds: ['u1'] });

      // 延长期间票的排队位置（enteredAt 分数）不变。
      expect(redis._zsets.get('match:queue:random:15:global')?.get('u1')).toBe(T0);
    });

    it('关：extendWait 在票已不在时幂等 no-op（无 meta ⇒ 不抛、不写）', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      await expect(service.extendWait('ghost')).resolves.toBeUndefined();
      expect(redis.hset).not.toHaveBeenCalled();
    });

    it('关：等待越过总上限（缺省 300s）⇒ 12007 终局、出队清 meta，且不再发提示', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);

      service.setClock(() => T0 + 300_000);
      await service.scanOnce();

      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      const events = publishedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'match.timeout',
        playerIds: ['u1'],
        code: ErrCode.MATCH_TIMEOUT,
      });
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(false);
      expect(redis._hashes.has('match:meta:u1')).toBe(false);
    });

    it('关：上限可配置（桩给 60s）⇒ 60s 到点即 12007（读 room.matchNoBotMaxWaitMs）', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      configCache.matchNoBotMaxWaitMs.mockReturnValue(60_000);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);

      service.setClock(() => T0 + 59_999);
      await service.scanOnce();
      expect(publishedEvents()).toHaveLength(1); // 窗口 0 的提示
      service.setClock(() => T0 + 60_000);
      await service.scanOnce();
      const events = publishedEvents();
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ event: 'match.timeout', code: ErrCode.MATCH_TIMEOUT });
    });

    it('关：上限逐票判定 —— 刚入队者不被到点者连坐（R57 同族）', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('old', 'random', 15);
      service.setClock(() => T0 + 300_000);
      await service.addToQueue('fresh', 'random', 15);
      // fresh 与 old 同一 now 扫描：fresh 仅 0s 等待（其 enteredAt = now）
      await service.scanOnce();

      const events = publishedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: 'match.timeout', playerIds: ['old'] });
      expect(redis._zsets.get('match:queue:random:15:global')?.has('fresh')).toBe(true);
    });

    it('关 + 3 名真人齐 ⇒ 立即满座开局、零机器人（开关不拦真人成局）', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('u2', 'random', 15);
      service.setClock(() => T0 + 2);
      await service.addToQueue('u3', 'random', 15);
      service.setClock(() => T0 + 1_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      expect(publishedEvents().some((e) => e.event === 'match.wait_prompt')).toBe(false);
    });

    it('关 + ≥3 人但本轮合法子集只有 2 人 ⇒ 绝不用机器人补成局，只发提示', async () => {
      // 谓词关闭（缺省）⇒ 子集恒等于全集，构造不出子集 2；改用例改由「2 人队列」面覆盖
      //（上面的越窗用例已钉「2 人不补机器人」）——本条保留占位说明该语义不另造夹具。
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('u2', 'random', 15);
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(publishedEvents()[0]).toMatchObject({ event: 'match.wait_prompt' });
    });

    it('金币场开关关（免费场仍开）⇒ gold 缺人发提示；同队列配置两场互不串', async () => {
      configCache.goldBotFillEnabled.mockReturnValue(false);
      // freeBotFillEnabled 缺省 true —— 只读 gold 那个开关
      service.setClock(() => T0);
      await service.addToQueue('g1', 'gold', 15);
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      expect(publishedEvents()[0]).toMatchObject({
        event: 'match.wait_prompt',
        playerIds: ['g1'],
      });
      // 金币场未开局 ⇒ 不写 match:claim（claim 只在 startGroup 里写）。
      expect([...redis._strings.keys()].filter((k) => k.startsWith('match:claim:'))).toEqual([]);
      expect(configCache.freeBotFillEnabled).not.toHaveBeenCalled();
      expect(configCache.goldBotFillEnabled).toHaveBeenCalled();
    });

    it('practice（好友房）不受开关管控：免费场开关关 ⇒ practice 缺人越过窗口仍补机器人', async () => {
      configCache.freeBotFillEnabled.mockReturnValue(false);
      service.setClock(() => T0);
      await service.addToQueue('u1', 'practice', 15);
      service.setClock(() => T0 + 30_001);

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1'], 'practice', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(2);
      expect(publishedEvents().some((e) => e.event === 'match.wait_prompt')).toBe(false);
    });

    it('双开关缺省开（桩缺省）⇒ 行为与改造前逐字节一致（2 人 31s 补 1 机器人）', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 1);
      await service.addToQueue('u2', 'random', 15);
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(1);
      expect(publishedEvents().some((e) => e.event === 'match.wait_prompt')).toBe(false);
    });
  });

  /**
   * 片② D5（Task 6 · 判据 J6/J7/J8/J9/J20/J27）：room-service 侧的**可用性门禁** ——
   * `<3 人且已越 30 秒窗口` 时先问一次 `robot.availability`：
   *  - `canProvide:false`（开关关 / DouZero 不可达）⇒ **不建房**，只判「窗口已到点」的人
   *    一份 12007（中文文案），其余留队；
   *  - 问不到（抛错 / 未知 pattern / 字段缺失）⇒ **fail-open**（按「能给」处理，行为与旧版
   *    一字不差 —— 既有越窗用例靠这条保持绿）；
   *  - **每轮至多问一次**（轮次持有对象跨桶传递）、≥3 人时**根本不问**。
   */
  describe('片② D5：可用性门禁（robot.availability）', () => {
    const T0 = 1_700_000_000_000;

    it('片② D5/J6：开关关 + 不可用 ⇒ 第 30s 只判窗口已到点的人，且**不建房**', async () => {
      rpc.on(RPC_PATTERNS.robotAvailability, () =>
        of({ ok: true, data: { canProvide: false, reason: 'douzero-unreachable' } }));

      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 31_000);
      await service.addToQueue('u2', 'random', 15); // u2 只等了 0 秒
      service.setClock(() => T0 + 31_500);

      await service.scanOnce();

      expect(roomsService.createGameRoom).not.toHaveBeenCalled(); // 负例：判完必须 return
      const published = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
        ([channel]) => channel === 'match:events',
      );
      const event = JSON.parse(published![1] as string);
      expect(event).toMatchObject({ event: 'match.timeout', playerIds: ['u1'] }); // **只有 u1**
      expect(event.message).toBe('当前无匹配的玩家');
      expect(event.code).toBe(12007);
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u2')).toBe(true); // u2 留队
    });

    it('片② D5/J9：人够 3 个时门禁**根本不参与**', async () => {
      const availability = vi.fn(() => of({ ok: true, data: { canProvide: false } }));
      rpc.on(RPC_PATTERNS.robotAvailability, availability);
      service.setClock(() => T0);
      for (const u of ['u1', 'u2', 'u3']) await service.addToQueue(u, 'random', 15);
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(availability).not.toHaveBeenCalled();
      expect(roomsService.createGameRoom).toHaveBeenCalled();
    });

    it('片② D5/J8：探测抛错（未知 pattern）⇒ fail-open，照常补位', async () => {
      rpc.on(RPC_PATTERNS.robotAvailability, () => throwError(() => new Error('no message handler')));
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      // ⚠️ 修 brief 字面 `toHaveLength(1)`：u1 单人成局 ⇒ 空 **2** 个座位 ⇒ 恰好 2 次补位
      // （同构既有用例 `:571` 断的就是 2）。写 1 在夹具里**算术上不可能**绿
      //（`toHaveLength(1)` 恒红 ⇒ 只会被「改弱成 >0」的修法喂绿 —— 那才是真丢判别力）。
      // 证据：修前（旧实现）实测 `expected [ { roomCode: 'ABC123', …(2) }, …(1) ] to have a length of 1 but got 2`。
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(2);
    });

    it('片② D5/J20：一轮多个桶只问一次', async () => {
      let calls = 0;
      rpc.on(RPC_PATTERNS.robotAvailability, () => {
        calls += 1;
        return of({ ok: true, data: { canProvide: true } });
      });
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      await service.addToQueue('u2', 'random', 80); // ⚠️ 80 是档位表里的一档（15/80/480/1200）；写 30 会在 setup 就被 BAD_PARAM 拒掉
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(calls).toBe(1);
    });

    it('片② D5/J7：OFF + **可用** ⇒ 照常补位（同一替身先 false 后 true ⇒ 只有第二次补位）', async () => {
      let answer = false;
      rpc.on(RPC_PATTERNS.robotAvailability, () => of({ ok: true, data: { canProvide: answer } }));
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 31_000);
      await service.scanOnce();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0); // 不可用 ⇒ 不补

      answer = true; // DouZero 回来了
      await service.addToQueue('u2', 'random', 80);
      service.setClock(() => T0 + 61_000);
      await service.scanOnce();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire).length).toBeGreaterThan(0);
    });

    it('片② D5/J27：failMatch 幂等——publish 只能是 zrem 返回 1 的子集', async () => {
      /** 读回全部 `match:events` 载荷（发了几条、每条含谁）。 */
      const timeoutEvents = (): any[] =>
        (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls
          .filter(([channel]) => channel === 'match:events')
          .map(([, payload]) => JSON.parse(payload as string));

      // ── 阶段 1：重叠轮里同一票不发第二条 12007（子集为空 ⇒ 整条不发）──
      // 🔴 构造：第一轮的问询**挂住**（用自己控制的 Subject），第二轮立即答 false ⇒ 第二轮先判失败；
      //    再放行第一轮 ⇒ 它也会试着判同一票 ⇒ 幂等过滤必须挡住第二条。
      const gate = new Subject<unknown>();
      let call = 0;
      rpc.on(RPC_PATTERNS.robotAvailability, () =>
        call++ === 0 ? gate : of({ ok: true, data: { canProvide: false } }));
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 31_000);

      const roundA = service.scanOnce(); // 挂在 gate 上
      await service.scanOnce(); // 第二轮：判 u1、发事件
      gate.next({ ok: true, data: { canProvide: false } });
      gate.complete();
      await roundA; // 第一轮恢复 ⇒ expired 里的票已被第二轮清空 ⇒ 子集为空 ⇒ 第二条不发

      expect(timeoutEvents()).toHaveLength(1); // 只发一条
      expect(timeoutEvents()[0].playerIds).toEqual(['u1']);

      // ── 阶段 2：多票 + 挂起期间独立移除一票 ⇒ 出现「部分票已被移除」的混合状态 ──
      // 🔴 阶段 1（单票 + 两轮共用同一固定时钟）里恢复的那一轮**每一票的 zrem 都返回 0**
      //   （全被第二轮清掉了）⇒ 它恒走「子集为空 ⇒ 整条不发」，对「guard 保留、但 publish
      //   发**原数组**」的错读法**恒绿**（两种读法在该状态下行为一字不差——阶段 1 拦不住它）。
      //   只有 zrem 结果 0/1 混合时两种读法才分叉：正解只发 zrem 返回 1 的子集（['u4']），
      //   错读法会把已判过的 u3 塞回事件里（['u3','u4']）—— 已判过的人会收到**第二条 12007**。
      //   构造：第一轮先扫到 [u3,u4] 快照并挂起；挂起期间把 u3 从队列直接移除（模拟「它已被
      //   另一重叠轮判掉」）；放行后 u3 的 zrem=0、u4 的 zrem=1。
      const gate2 = new Subject<unknown>();
      rpc.on(RPC_PATTERNS.robotAvailability, () => gate2);
      service.setClock(() => T0);
      await service.addToQueue('u3', 'random', 15);
      await service.addToQueue('u4', 'random', 15);
      service.setClock(() => T0 + 31_000);

      const roundC = service.scanOnce(); // 快照 [u3,u4]，随后挂在 gate2 上
      // 让 roundC 真的跑到挂起点：它到 gate2 为止的每一步都是微任务替身 ⇒ 一个宏任务足矣。
      await new Promise((resolve) => setImmediate(resolve));
      redis._zsets.get('match:queue:random:15:global')!.delete('u3'); // u3 已被别处判过

      gate2.next({ ok: true, data: { canProvide: false } });
      gate2.complete();
      await roundC; // 恢复：u3 的 zrem=0、u4 的 zrem=1

      const events = timeoutEvents();
      expect(events).toHaveLength(2);
      // 🔴 「publish 发原数组」的错读法下这里会是 ['u3','u4'] ⇒ 本用例必红
      expect(events[1].playerIds).toEqual(['u4']);
      // 前提自证：roundC 真的**尝试**判过 u3（zrem=0，但 `del match:meta` 无条件执行）——
      // 少了它，将来 roundC 若不再覆盖 u3，本用例会退化成「只判 u4」而对错读法重新失明。
      expect(redis._hashes.has('match:meta:u3')).toBe(false);
      expect(redis._zsets.get('match:queue:random:15:global')?.size).toBe(0);
    });
  });

  /**
   * N20/P4 Task 3：**内部面已无 HTTP**。
   *
   * 旧的「无条件带 `X-Internal-Token`」（R90）在 TCP RPC 下**没有载体**了 ——
   * 内部身份边界改由「RPC 端口只在 compose 内网可达」承担（R223）。
   * 但**判据没有消失，换了载体**：
   *  - 正向：两个调用点确实打的是 `RPC_PATTERNS.*`（pattern 名写错 = 当年的「少写 `/api`」）；
   *  - 反向：全局 `fetch` 零调用、源码里不残留内部 HTTP 路径
   *    （后者由 `test/no-internal-http.gate.test.ts` 的机械闸钉住）。
   */
  describe('R223/R218：内部面的身份载体已从 X-Internal-Token 换成「compose 内网不可达」', () => {
    const T0 = 1_700_000_000_000;
    /** E10 的探针：match.service **不得**再直接发网络请求（旧实现用全局裸 fetch）。 */
    let fetchGuard: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchGuard = vi.fn(() => {
        throw new Error('match.service 不得使用全局 fetch（E10 / R130）');
      });
      vi.stubGlobal('fetch', fetchGuard);
    });

    it('acquireBot 走 RPC（不是 HTTP），且全局 fetch 零调用', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 30_001);

      await service.scanOnce();

      // 1 人 ⇒ 补 2 个座位（§8.4②）：两次都走 RPC
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(2);
      expect(fetchGuard).not.toHaveBeenCalled();
    });

    it('startGame 走 RPC（不是 HTTP），且全局 fetch 零调用', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      await service.addToQueue('u2', 'random', 15);
      await service.addToQueue('u3', 'random', 15);

      await service.scanOnce();

      expect(rpc.payloadsOf(RPC_PATTERNS.gameStart)).toHaveLength(1);
      // 探针的反向断言：这条路径**不得**经全局 fetch 出网
      expect(fetchGuard).not.toHaveBeenCalled();
    });
  });

  /**
   * E10 / R130 的**同族加固**（N20/P4 Task 3）。
   *
   * 旧判据：`startGame` 必须走**注入的 `HttpService`**（裸 `fetch` 会让单测真的发网络请求，
   * 判据是假的）。现在载体换成**注入的 `GameClient`**（内部持有容器给的 `ClientProxy`），
   * 但**同一个道理**：单测注入假 proxy，绝不真发网络。
   */
  describe('E10 同族：startGame 走注入的 GameClient（不再全局 fetch）', () => {
    const T0 = 1_700_000_000_000;

    it('打的是 RPC_PATTERNS.gameStart，载荷 `{roomCode, baseScore, players}` 逐字', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 30_001);

      await service.scanOnce();

      // 1 人入队 ⇒ 补 2 个座位：`id` 是**对外** displayId（`p_<座位号>`），
      // `botId` + `skillLevel` 是内部字段、只在服务间透传（永不出站）。
      //
      // ⚠️ **夹具订正（本片）**：`displayId` 必须**随座位不同**。旧夹据让两次 acquire 回同一个
      // displayId，于是这条断言钉的是「两个玩家可以同 id」—— 而 `claimSeat` 对同一 userId 幂等，
      // 那在真实实现里**根本坐不满**（第二个机器人只会拿回第一个的座位）。
      // 旧断言能过，只是因为那时的替身自己编座位、没走真实的 `HSETNX`。
      expect(rpc.payloadsOf(RPC_PATTERNS.gameStart)).toEqual([
        {
          roomCode: 'ABC123',
          gameType: 'doudizhu', // 多玩法（Task 2.4）：game.start 带玩法/人数（缺省语义显式化）
          playerCount: 3,
          baseScore: 15, // 片规格 §2.4：队列底分那一维透传到 game.start（不再有 100 的缺省）
          players: [
            { id: 'u1', seat: 0, isRobot: false },
            { id: 'p_00000001', seat: 1, isRobot: true, botId: 'bot-abc', skillLevel: 'beginner', thinkingSpeed: 900 },
            { id: 'p_00000002', seat: 2, isRobot: true, botId: 'bot-abc', skillLevel: 'beginner', thinkingSpeed: 900 },
          ],
          // ⚠️ **判据 5 / R1104（本片）**：同族的「`scanOnce()` 里有 timer ALS ⇒ 带 meta」。
          // 业务字段逐字不变；`meta` 的 **id 一致性**在同一轮的四跳 RPC 之间断言（见下）。
          meta: { traceId: expect.any(String) },
        },
      ]);
      // 同一轮扫描里的四跳 RPC（`robot.acquire` ×2 + `game.start`）必须带**同一个** traceId
      //（R1104：它是「**这一轮**」的 id —— 跨服务的那几行日志才串得起来）。
      const roundIds = [
        ...rpc.payloadsOf(RPC_PATTERNS.robotAcquire),
        ...rpc.payloadsOf(RPC_PATTERNS.gameStart),
      ].map((p) => (p as { meta: { traceId: string } }).meta.traceId);
      expect(new Set(roundIds).size, '同一轮的四跳 RPC 必须共用一个 traceId').toBe(1);
    });

    /**
     * N19（切片 10）：底分不是常量而是**房间元数据**。
     *
     * 判据必须是「房间底分 ≠ 100 时，出站载荷里就是那个值」——若实现仍硬编码 100，
     * 旧断言（底分恰好 100）**永远绿**，所以上面那条用例没有判别力。
     */
    it('game.start 的 baseScore 来自房间元数据，不是硬编码（N19）', async () => {
      // ⚠️ **底分必须真的落进房间元数据**（本片）：开局链现在从**房间**读 `baseScore`
      //（`RoomStartService.findOne`），替身返回一个假对象是**读不到**的 —— 那会让这条
      // 判据退化成空测（实测：房间找不到 ⇒ `game.start` 一次都没发）。
      //
      // ⚠️ **形状（片规格 §2.4）**：底分现在**从队列的底分那一维**透传（`createGameRoom`
      // 的第三个参数）—— 这里入队 80（真档位、且 `≠` 缺省 15），断言出站载荷就是 80：
      // 硬编码任何常量（旧 100 / 新缺省 15）都会被这条抓住。
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 80);
      await service.addToQueue('u2', 'random', 80);
      await service.addToQueue('u3', 'random', 80);

      await service.scanOnce();

      const startPayloads = rpc.payloadsOf(RPC_PATTERNS.gameStart);
      expect(startPayloads).toHaveLength(1);
      expect((startPayloads[0] as { baseScore: number }).baseScore).toBe(80); // 旧实现恒为 100
    });

    it('match.service.ts 的源码里不再出现裸 fetch（机械闸，防回归）', () => {
      const source = readFileSync(join(process.cwd(), 'src/match/match.service.ts'), 'utf-8');
      expect(/(?<![\w.])fetch\s*\(/.test(source)).toBe(false);
    });
  });

  /**
   * A7⑤ / R210：`game.start` 与 `robot.acquire` 失败**重试恰好 1 次**（`maxAttempts = 2`）。
   *
   * 前提是接收端**幂等**（§4.3 的「幂等前提」）：`game.start` 同 `roomCode` 复用会话、
   * `robot.acquire` 同 `{roomCode, seat}` 返回同一个 `BotInstance`（R201 的池）。
   *
   * 判据两半（R212②）：① 首次失败 ⇒ **同 pattern、同载荷**再发一次；
   * ② 两次都失败 ⇒ **不抛**（匹配流程不崩，走 §4.3 的降级：房间 `cancelled`）
   * 且 `attempts` 累加（这样「30 秒窗口 + 60 秒上限」的兜底仍在）。
   */
  describe('A7⑤：失败重试 1 次（R210/R221）', () => {
    const T0 = 1_700_000_000_000;

    it('robot.acquire：首次失败 ⇒ 第二次仍发**同一 pattern 与载荷**（恰好 2 次）', async () => {
      rpc.on(RPC_PATTERNS.robotAcquire, (_data, index) =>
        index === 0
          ? throwError(() => new Error('ECONNRESET'))
          : of({ ok: true, data: { bots: [{ ...botOf(1, 'bot-retry'), displayId: 'p_retry000' }] } }),
      );
      service.setClock(() => T0);
      // ⚠️ **两个**人 ⇒ 只补 **1** 个机器人（botSeats = 1）：否则第二次 acquire 会再发一次，
      // 计数就分不清「重试」与「补第二个座位」了。
      await service.addToQueue('u1', 'random', 15);
      await service.addToQueue('u2', 'random', 15);
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      const payloads = rpc.payloadsOf(RPC_PATTERNS.robotAcquire);
      expect(payloads).toHaveLength(RPC_MAX_ATTEMPTS); // 重试恰好 1 次
      expect(payloads[0]).toEqual(payloads[1]);
      // 2 个人 ⇒ 空缺座位是 2（`humans.length + i`），重试打的是**同一个**座位
      expect((payloads[0] as { seats: number[] }).seats).toEqual([2]);
    });

    it('robot.acquire：两次都失败 ⇒ 不抛、房间置 cancelled（§4.3 的降级）', async () => {
      rpc.on(RPC_PATTERNS.robotAcquire, () => throwError(() => new Error('down')));
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      service.setClock(() => T0 + 31_000);

      await expect(service.scanOnce()).resolves.toBeUndefined();

      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(RPC_MAX_ATTEMPTS);
      expect(roomsService.cancelIfStillWaiting, '降级要经 CAS（R1003）').toHaveBeenCalledWith('ABC123');
      // 人没丢：票还在队列里（§8.4 的窗口/上限兜底继续生效）
      expect(redis._zsets.get('match:queue:random:15:global')?.has('u1')).toBe(true);
    });

    it('game.start：首次失败 ⇒ 第二次仍发**同一 pattern 与载荷**（恰好 2 次）', async () => {
      rpc.on(RPC_PATTERNS.gameStart, (_data, index) =>
        index === 0 ? throwError(() => new Error('timeout')) : of({ ok: true, data: { roomCode: 'ABC123' } }),
      );
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      await service.addToQueue('u2', 'random', 15);
      await service.addToQueue('u3', 'random', 15);

      await service.scanOnce();

      const payloads = rpc.payloadsOf(RPC_PATTERNS.gameStart);
      expect(payloads).toHaveLength(RPC_MAX_ATTEMPTS);
      expect(payloads[0]).toEqual(payloads[1]);
    });

    /**
     * ⚠️ **N36 / R522（2026-09-17 用户裁决）**：本条**标题**原先写
     * 「§4.3：失败 ⇒ 房间 `cancelled` + 通知玩家」，而它**只断言了重试次数** ——
     * 「标题声称有、判据没有」的典型假绿形态（读代码的人会以为降级存在）。
     *
     * **实测现状**：`startGame()` 的 `catch` **只记 `logger.error` 不重抛** ⇒
     * ① 两次都失败时 `playing` **照样**被写入（房间进 playing 而服务端没有会话）；
     * ② §4.3 的降级（`cancelled` + 通知玩家）在实现里**不存在**。
     *
     * **裁决**：**不改语义** ⇒ 把 `design.md` §4.3 该分支裁为「**本仓不实现**」并改文档；
     * 本条**按它真正断言的东西改名**，另加一条把**现状**钉成判据（下一条）。
     */
    it('game.start：两次都失败 ⇒ 不抛、且恰好重试 1 次（§4.3 的降级**未实现**，见 N36）', async () => {
      rpc.on(RPC_PATTERNS.gameStart, () => throwError(() => new Error('down')));
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      await service.addToQueue('u2', 'random', 15);
      await service.addToQueue('u3', 'random', 15);

      await expect(service.scanOnce()).resolves.toBeUndefined();

      expect(rpc.payloadsOf(RPC_PATTERNS.gameStart)).toHaveLength(RPC_MAX_ATTEMPTS);
    });

    /**
     * **N36 / R522**：把「失败被吞」的**现状钉成判据** —— 否则下一个人读代码时
     * 会以为 §4.3 的降级存在（它只在文档里）。
     *
     * 判据两半（缺一不可）：① 房间**进了 `playing`**（失败没拦住状态转移）；
     * ② **从未**被置 `cancelled`（降级确实没发生）。只写 ② 是空测 ——
     * 「根本没走到写状态」也能满足它。
     */
    it('N36：game.start 两次都失败 ⇒ `playing` **照样**被写入、且从不置 `cancelled`', async () => {
      rpc.on(RPC_PATTERNS.gameStart, () => throwError(() => new Error('down')));
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      await service.addToQueue('u2', 'random', 15);
      await service.addToQueue('u3', 'random', 15);

      await service.scanOnce();

      const statuses = roomsService.updateStatus.mock.calls.map(
        (call) => (call as unknown[])[1],
      );
      expect(statuses).toContain('playing'); // ① 状态转移照做 —— 但服务端**没有**会话
      expect(statuses).not.toContain('cancelled'); // ② §4.3 的降级**没有**发生
    });
  });

  /**
   * **判据 5**（本片 · spec §5 / R1104 的载体 + R1105 的省略语义）：发送侧统一附加 `meta`。
   *
   * 三个 client（`game.client.call` / room 与 game 两侧的 `robot.client`）共用
   * `shared` 的 `metaFromTrace()`：ALS 里有 traceId ⇒ 载荷**带上** `meta{traceId[,reqId][,userId]}`；
   * 没有 ⇒ **整个键不出现**（不是 `meta: undefined`）。
   *
   * ⚠️ **判据边界**（spec §5 的「判据边界」一节）：「无 ALS ⇒ 无 meta」这一分支在
   * **真栈上不可达**（入口都自建 traceId）⇒ 只有**单测**能盖它 —— 所以负对照必须在这里。
   *
   * ⚠️ 为什么触发链走 `RoomStartService.startRoom`（而不是 `scanOnce`）：`scanOnce` 自己会
   * `runWithTrace({traceId: randomUUID(), source:'timer'})` **覆盖**外层上下文，正对照就
   * 测不到假 id 有没有传下去（内层的 uuid 会赢）。这里直调 ⇒ ALS 里只剩本用例放的那个。
   */
  describe('判据 5：发送侧统一附加 meta（R1105 省略语义）', () => {
    /**
     * 建一间 **1 人房**再跑一次开局链：1 人 ⇒ 补 2 个机器人 ⇒ 这一次触发同时打
     * `robot.acquire` ×2 与 `game.start` ×1 —— 一次夹具盖住**两个**封装点
     *（`robot.client.acquire` 与 `game.client.call`），且都在同一段 ALS 里。
     */
    async function triggerStartViaRoomStart(): Promise<void> {
      await roomsService.createGameRoom(['u1'], 'random', 15);
      const roomStart = new RoomStartService(
        redis as unknown as Redis,
        roomsService as unknown as RoomsService,
        new GameClient(rpc.proxy),
        new RobotClient(rpc.proxy),
        { get: vi.fn(), apply: vi.fn() } as never,
        { ensureBots: vi.fn(), afterSettle: vi.fn() } as never,
        // 断点④修复（Task 5）：重连记录写边 —— 轻替身（本文件断言与它无关）。
        { touch: vi.fn().mockResolvedValue(undefined) } as unknown as ReconnectService,
        // 本片：台费费率表读边（与 RoomsService 同一桩实例）。
        asConfigCache(configCache),
      );
      await roomStart.startRoom('ABC123', { strict: true });
    }

    it('判据 5 正：ALS 有上下文 ⇒ 载荷带 meta{traceId,reqId,userId}', async () => {
      await runWithTrace({ traceId: 'T9', reqId: 'R9', userId: 'U9', source: 'edge' }, async () => {
        await triggerStartViaRoomStart();
      });

      // 反空测：这一次触发必须**真的**打了 game.start（否则下面断言的是空）
      expect(
        rpc.payloadsOf(RPC_PATTERNS.gameStart),
        '两次 RPC 都没打出去 —— 判据退化成空测',
      ).toHaveLength(1);

      const payload = rpc.payloadsOf(RPC_PATTERNS.gameStart)[0] as { meta?: unknown };
      expect(payload.meta).toEqual({ traceId: 'T9', reqId: 'R9', userId: 'U9' });

      // 同一次触发里的另外两跳（`robot.client.acquire`）必须带**同一份** meta：
      // 「统一附加」的含义正是**所有**封装点同一条规则，不是只改一处。
      const acquirePayloads = rpc.payloadsOf(RPC_PATTERNS.robotAcquire) as Array<{ meta?: unknown }>;
      expect(acquirePayloads).toHaveLength(2);
      for (const p of acquirePayloads) {
        expect(p.meta).toEqual({ traceId: 'T9', reqId: 'R9', userId: 'U9' });
      }
    });

    it('判据 5 负：无 ALS ⇒ 载荷里**没有** meta 键（既有逐字断言因此不受影响）', async () => {
      await triggerStartViaRoomStart();

      expect(rpc.payloadsOf(RPC_PATTERNS.gameStart), '没打成 ⇒ 判据空转').toHaveLength(1);
      const payload = rpc.payloadsOf(RPC_PATTERNS.gameStart)[0] as Record<string, unknown>;
      // ⚠️ 必须是**键的在与不在**：`meta: undefined` 会让既有 `toEqual` 逐字断言全红
      expect('meta' in payload).toBe(false);

      for (const p of rpc.payloadsOf(RPC_PATTERNS.robotAcquire)) {
        expect('meta' in (p as Record<string, unknown>)).toBe(false);
      }
    });
  });

  /**
   * **W4（片⑥ · spec §3.2）**：两个匹配扫描器**并发**扫同一队列（`Promise.all`，真并发）。
   *
   * 判据取**不变量**（spec §0.3）：不超员、房间**不得**被置 `cancelled`、不抛。
   * ⚠️ **不**断言「恰好一个赢」：两条链**都**成局是**允许**的（各自建自己的房）；
   * 断言「只有一个房间」会变成在测调度顺序，而不是在测安全。
   *
   * ⚠️ 「不超员」在这里**有牙**：两条链会**各自**去补位（同一队列、同一份机器人池），
   * 兜住它的只有 `addBot` 内部的 `HSETNX` + `claimSeat` 的幂等 —— 不是任何互斥。
   */
  describe('W4：两个匹配扫描器并发（片⑥ · spec §3.2）', () => {
    const T0 = 1_700_000_000_000;

    /** 第二个实例：**同一个**假 Redis（= 同一个后端），独立的扫描器与独立的房号。 */
    function makeSecondInstance(): { service: MatchService; rooms: MockRoomsService } {
      const rooms = makeMockRoomsService(globalService, 'XYZ789');
      const service = new MatchService(
        redis,
        rooms as unknown as RoomsService,
        new RoomStartService(
          redis,
          rooms as unknown as RoomsService,
          new GameClient(rpc.proxy),
          new RobotClient(rpc.proxy),
          { get: vi.fn(), apply: vi.fn() } as never,
          { ensureBots: vi.fn(), afterSettle: vi.fn() } as never,
          // 断点④修复（Task 5）：重连记录写边 —— 轻替身（本文件断言与它无关）。
          { touch: vi.fn().mockResolvedValue(undefined) } as unknown as ReconnectService,
          // 本片：台费费率表读边（与 RoomsService 同一桩实例）。
          asConfigCache(configCache),
        ),
        asConfigCache(configCache),
        // 片② D5：可用性门禁的注入点（同一个假 proxy）。
        new RobotClient(rpc.proxy),
      );
      service.setClock(() => T0 + 31_000);
      return { service, rooms };
    }

    it('两个 scanOnce() 并发 ⇒ 不超员、房间不得被置 cancelled', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15); // 等过 30s 窗口 ⇒ 两条链都会成局 + 补位
      service.setClock(() => T0 + 31_000);
      const second = makeSecondInstance();

      await expect(Promise.all([service.scanOnce(), second.service.scanOnce()])).resolves.toBeDefined();

      const rooms = (
        await Promise.all(['ABC123', 'XYZ789'].map((code) => globalService.findOne(code)))
      ).filter((room) => room !== null);
      // 反空测：**真的**建出房来了（否则下面那条不变量是空测）
      expect(rooms.length, '一条都没成局 —— 判据退化成空测').toBeGreaterThanOrEqual(1);
      // ⚠️ 为什么写成 `≥ 1` 而不是 `= 2`（**实测**：今天两条链都成局，就是 2 间房）：
      // 两次 `zrange` 都是各自扫描的**第一个 await** ⇒ 快照都拿到了；但「第二条链是否拿到
      // 快照」取决于调度顺序，把它写成硬断言就是在**测调度**，而不是测安全（spec §0.3）。
      for (const room of rooms) {
        expect(room!.status, `${room!.code} 不得被置 cancelled`).toBe('playing');
        expect(room!.players.length, `${room!.code} 不得超员`).toBeLessThanOrEqual(room!.maxPlayers);
        expect(
          room!.players.filter((p) => p.isRobot).length,
          `${room!.code} 恰好补 2 个机器人`,
        ).toBe(2);
      }
    });
  });

  /**
   * 风控 T2：谓词框架与随机选择形态（规格 §2.4-1..7 · C2–C6）。
   *
   * 三个前提说明：
   *  - **RNG**：本 describe 的用例多数依赖特定洗牌序 —— 缺省 `IDENTITY_RNG`（见 beforeEach）、
   *    要定制时 `setRng(rngForShuffle(原序, 目标序))`。
   *  - **ip/deviceId 的写入点在本片的 T3**（`addToQueue` 扩展）⇒ 这里直写 `match:meta` 模拟落盘。
   *  - **多间房**：拆组/兜底一轮可能开出多间房，而透明替身的房号是固定的 ⇒ 用
   *    `distinctRoomCodes` 按调用序发号（首间仍是 `ABC123`，与既有断言兼容）。
   */
  describe('风控 T2：谓词与随机选择形态（C2–C6）', () => {
    const T0 = 1_700_000_000_000;
    const Q = 'match:queue:random:15:global';

    /** 入队（模式/底分固定 random/15；时钟设到 `at` —— enteredAt 即 `at`）。 */
    async function enqueueAt(playerId: string, at: number): Promise<void> {
      service.setClock(() => at);
      await service.addToQueue(playerId, 'random', 15);
    }

    /** 给 `match:meta:{id}` 补 ip/deviceId（T3 之前没有写入点 ⇒ 用例直写模拟落盘）。 */
    async function fingerprint(
      playerId: string,
      fields: { ip?: string; deviceId?: string },
    ): Promise<void> {
      await redis.hset(`match:meta:${playerId}`, {
        ...(fields.ip !== undefined ? { ip: fields.ip } : {}),
        ...(fields.deviceId !== undefined ? { deviceId: fields.deviceId } : {}),
      });
    }

    /** 一轮可能开多间房 ⇒ 透明替身按调用序发不同房号（首间保持 `ABC123`）。 */
    function distinctRoomCodes(codes: string[]): void {
      let call = 0;
      roomsService.createGameRoom.mockImplementation(
        async (ids: string[], mode: 'random' | 'practice', baseScore: number) => {
          const code = codes[Math.min(call++, codes.length - 1)]!;
          const created = await globalService.create({ mode, roomCode: code, baseScore });
          for (const id of ids) await globalService.join(created.code, id);
          return (await globalService.findOne(created.code))!;
        },
      );
    }

    /** 读回全部 `match:events` 载荷（发了几条、每条含谁）。 */
    function matchEvents(): Array<Record<string, unknown>> {
      return (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter(([channel]) => channel === 'match:events')
        .map(([, payload]) => JSON.parse(payload as string));
    }

    it('C2：凑满 3 成组 —— 组序 = 洗牌序（钉 [u3,u1,u2]）；selection_rounds +1、no_legal 不动', async () => {
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 1);
      await enqueueAt('u3', T0 + 2);
      service.setRng(rngForShuffle(['u1', 'u2', 'u3'], ['u3', 'u1', 'u2']));
      service.setClock(() => T0 + 1_000);

      const roundsBefore = (await exactSeriesValue(matchSelectionRoundsTotal, { game_type: 'doudizhu' })) ?? 0;
      const noLegalBefore = (await exactSeriesValue(matchNoLegalGroupTotal, { game_type: 'doudizhu' })) ?? 0;
      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u3', 'u1', 'u2'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      expect((await exactSeriesValue(matchSelectionRoundsTotal, { game_type: 'doudizhu' })) ?? 0).toBe(roundsBefore + 1);
      expect((await exactSeriesValue(matchNoLegalGroupTotal, { game_type: 'doudizhu' })) ?? 0).toBe(noLegalBefore); // 成组 ⇒ 不计数
    });

    it('谓词默认关（缺省 false）⇒ 抽取零新增读：无 GET/SET/INCR（快路径，默认生产态）', async () => {
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 1);
      await enqueueAt('u3', T0 + 2);
      service.setClock(() => T0 + 1_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'random', 15, 'doudizhu', 3);
      expect(redis.get, '谓词关不得逐对查记忆').not.toHaveBeenCalled();
      // 多玩法 Task 2.1：成组时会写全模式 `match:claim:`（有意行为）⇒ 本判据只看**拒绝记忆**。
      expect(
        (redis.set as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) =>
          String(call[0]).startsWith('match:rejected:'),
        ),
        '谓词关不得写拒绝记忆',
      ).toHaveLength(0);
      expect(redis.incr).not.toHaveBeenCalled();
    });

    it('C3：谓词拒绝 ⇒ 记忆（字典序/TTL 参数）+ 两端 attempts+1 + 两端 INCR；未轮到者零记账', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      await enqueueAt('A', T0);
      await enqueueAt('B', T0 + 1);
      await enqueueAt('C', T0 + 2);
      await fingerprint('A', { deviceId: 'dev-shared' });
      await fingerprint('B', { deviceId: 'dev-shared' });
      await fingerprint('C', { deviceId: 'dev-other' });
      // 钉洗牌序 [A,C,B]：A 入选、C 通融入选、B 与 A 同设备 ⇒ 恰一对拒绝
      service.setRng(rngForShuffle(['A', 'B', 'C'], ['A', 'C', 'B']));
      const now = T0 + 1_000;
      service.setClock(() => now);

      const rejectionsBefore =
        (await labeledValue(matchPredicateRejectionsTotal, { predicate: 'sameDevice' })) ?? 0;
      await service.scanOnce();

      // 记忆：**字典序**拼键（A<B）、值 = 失败时刻 ms、TTL 参数（PX 形态的 5000）；恰写一次
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith('match:rejected:A:B', String(now), 'PX', 5000);
      // 两端 attempts+1（恰一次）；「洗牌未轮到」的 C 零记账
      expect(redis._hashes.get('match:meta:A')?.attempts).toBe('1');
      expect(redis._hashes.get('match:meta:B')?.attempts).toBe('1');
      expect(redis._hashes.get('match:meta:C')?.attempts).toBe('0');
      // 两端 risk:hit INCR + EXPIRE 7d（C 没有命中键）
      expect(redis.incr).toHaveBeenCalledTimes(2);
      expect(redis._strings.get('risk:hit:A:sameDevice')).toBe('1');
      expect(redis._strings.get('risk:hit:B:sameDevice')).toBe('1');
      expect(redis.expire).toHaveBeenCalledWith('risk:hit:A:sameDevice', RISK_HIT_TTL_SECONDS);
      expect(redis.expire).toHaveBeenCalledWith('risk:hit:B:sameDevice', RISK_HIT_TTL_SECONDS);
      expect(redis._strings.has('risk:hit:C:sameDevice')).toBe(false);
      // 指标：谓词拒绝 +1
      expect(await labeledValue(matchPredicateRejectionsTotal, { predicate: 'sameDevice' })).toBe(
        rejectionsBefore + 1,
      );
      // 窗口未到（1s）⇒ 子集路径不动：不成局、票全部原样留队（enteredAt 不变 —— C2）
      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(redis._zsets.get(Q)?.get('A')).toBe(T0);
      expect(redis._zsets.get(Q)?.get('B')).toBe(T0 + 1);
      expect(redis._zsets.get(Q)?.get('C')).toBe(T0 + 2);
      expect(redis._hashes.get('match:meta:A')?.enteredAt).toBe(String(T0));
    });

    it('C3：记忆拒绝 ⇒ 仅两端 attempts+1（不重写记忆、不 INCR、不计数）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      await enqueueAt('A', T0);
      await enqueueAt('B', T0 + 1);
      await enqueueAt('C', T0 + 2);
      await fingerprint('A', { deviceId: 'dev-shared' });
      await fingerprint('B', { deviceId: 'dev-shared' });
      await fingerprint('C', { deviceId: 'dev-other' });
      const now = T0 + 1_000;
      // 预置一条 **1s 前**（TTL 窗口内）的记忆：B 与 A 的判定先撞记忆、后撞谓词
      await redis.set('match:rejected:A:B', String(now - 1_000), 'PX', 5000);
      service.setRng(rngForShuffle(['A', 'B', 'C'], ['A', 'C', 'B']));
      service.setClock(() => now);
      const rejectionsBefore =
        (await labeledValue(matchPredicateRejectionsTotal, { predicate: 'sameDevice' })) ?? 0;

      await service.scanOnce();

      expect(redis.set, '记忆拒绝不得重写记忆（仍是手动预置的那一次）').toHaveBeenCalledTimes(1);
      expect(redis._strings.get('match:rejected:A:B')).toBe(String(now - 1_000)); // 原值未动
      expect(redis.incr, '记忆拒绝不 INCR').not.toHaveBeenCalled();
      expect(redis._hashes.get('match:meta:A')?.attempts).toBe('1');
      expect(redis._hashes.get('match:meta:B')?.attempts).toBe('1');
      expect(await labeledValue(matchPredicateRejectionsTotal, { predicate: 'sameDevice' })).toBe(
        rejectionsBefore, // 指标也不计
      );
    });

    it('C2/C3：「洗牌未轮到」零记账（贪心凑满 3 即止 —— 第 4 人未被判定）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 1);
      await enqueueAt('u3', T0 + 2);
      await enqueueAt('u4', T0 + 3);
      // u4 与 u1 同设备：**若被判定**必然拒绝 —— 但贪心在 3 人已满时收手 ⇒ 它连判定都不发生
      await fingerprint('u1', { deviceId: 'dev-a' });
      await fingerprint('u2', { deviceId: 'dev-b' });
      await fingerprint('u3', { deviceId: 'dev-c' });
      await fingerprint('u4', { deviceId: 'dev-a' });
      service.setClock(() => T0 + 1_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'random', 15, 'doudizhu', 3);
      // 多玩法 Task 2.1：成组时会写全模式 `match:claim:`（有意行为）⇒ 只看拒绝记忆。
      expect(
        (redis.set as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) =>
          String(call[0]).startsWith('match:rejected:'),
        ),
      ).toHaveLength(0); // 无记忆写入
      expect(redis.incr).not.toHaveBeenCalled(); // 无命中计数
      expect(redis._hashes.get('match:meta:u4')?.attempts).toBe('0');
      expect(redis._zsets.get(Q)?.has('u4')).toBe(true); // 留队
    });

    it('C4：到点者（60s）先并入正常抽取 —— 被选入合法三人组 ⇒ 成局、不直走 12007', async () => {
      await enqueueAt('u1', T0); // 到点者（等下扫时 waited = 60.001s）
      await enqueueAt('u2', T0 + 50_000);
      await enqueueAt('u3', T0 + 50_001);
      service.setClock(() => T0 + 60_001);

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2', 'u3'], 'random', 15, 'doudizhu', 3);
      expect(matchEvents().filter((e) => e.event === 'match.timeout')).toHaveLength(0);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0); // 满三真人 ⇒ 不问门禁不补位
    });

    it('C4：本轮未成组的到点者 ⇒ 兜底成局（三人团先成局；落单者本人 + 2 机器人）', async () => {
      distinctRoomCodes(['ABC123', 'XYZ789']);
      await enqueueAt('u1', T0); // 到点者（60s+）
      await enqueueAt('u2', T0 + 50_000);
      await enqueueAt('u3', T0 + 50_001);
      await enqueueAt('u4', T0 + 50_002);
      // 钉洗牌序 [u2,u3,u4,u1]：正常抽取先把三人团选走，u1 落兜底集合
      service.setRng(rngForShuffle(['u1', 'u2', 'u3', 'u4'], ['u2', 'u3', 'u4', 'u1']));
      service.setClock(() => T0 + 60_001);

      await service.scanOnce();

      // 正常抽取先行（不含到点者）⇒ 兜底（u1 单人 + 2 机器人）
      expect(roomsService.createGameRoom.mock.calls.map((c) => c[0])).toEqual([
        ['u2', 'u3', 'u4'],
        ['u1'],
      ]);
      expect((await globalService.findOne('ABC123'))?.status).toBe('playing');
      expect((await globalService.findOne('XYZ789'))?.status).toBe('playing');
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(2); // 只有 u1 那间补位
      expect(matchEvents().filter((e) => e.event === 'match.timeout')).toHaveLength(0);
    });

    it('C4：到点者兜底遇门禁不能给 ⇒ 该组 12007（既有语义；三人团不受门禁牵连）', async () => {
      rpc.on(RPC_PATTERNS.robotAvailability, () =>
        of({ ok: true, data: { canProvide: false } }));
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 50_000);
      await enqueueAt('u3', T0 + 50_001);
      await enqueueAt('u4', T0 + 50_002);
      service.setRng(rngForShuffle(['u1', 'u2', 'u3', 'u4'], ['u2', 'u3', 'u4', 'u1']));
      service.setClock(() => T0 + 60_001);

      await service.scanOnce();

      // 三人团不需要机器人 ⇒ 门禁不拦它（J9 同规）；u1 的兜底组要补位 ⇒ 不能给 ⇒ 12007 + 出队
      expect(roomsService.createGameRoom).toHaveBeenCalledTimes(1);
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u2', 'u3', 'u4'], 'random', 15, 'doudizhu', 3);
      const timeout = matchEvents().find((e) => e.event === 'match.timeout');
      expect(timeout).toMatchObject({ playerIds: ['u1'], code: 12007 });
      expect(timeout?.message).toBe('当前无匹配的玩家');
      expect(redis._zsets.get(Q)?.has('u1')).toBe(false);
    });

    it('C4：attempts≥10 的到点者同规（30s 起算）—— 未成组 ⇒ 兜底成局', async () => {
      distinctRoomCodes(['ABC123', 'XYZ789']);
      await enqueueAt('u1', T0); // 等人等够了重试预算（scan 时 waited=31s 且 attempts=10 ⇒ 到点）
      await redis.hset('match:meta:u1', { attempts: '10' });
      await enqueueAt('u2', T0 + 29_000);
      await enqueueAt('u3', T0 + 29_001);
      await enqueueAt('u4', T0 + 29_002);
      // 钉洗牌序 [u2,u3,u4,u1]：三人团先被正常抽取选走，u1 落兜底集合
      service.setRng(rngForShuffle(['u1', 'u2', 'u3', 'u4'], ['u2', 'u3', 'u4', 'u1']));
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom.mock.calls.map((c) => c[0])).toEqual([
        ['u2', 'u3', 'u4'],
        ['u1'],
      ]);
      expect(matchEvents().filter((e) => e.event === 'match.timeout')).toHaveLength(0);
    });

    it('C5：≥3 人凑不出合法三人组 ⇒ 最长等待者的 |S|=2 子集 + 1 机器人（30s 窗口）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      // F4 场景：A、B 互斥、C 与二者皆可 ⇒ A/C 本可 30s 合法成局（不再全体陪跑到 60s）
      await enqueueAt('A', T0);
      await enqueueAt('B', T0 + 1);
      await enqueueAt('C', T0 + 2);
      await fingerprint('A', { deviceId: 'dev-shared' });
      await fingerprint('B', { deviceId: 'dev-shared' });
      await fingerprint('C', { deviceId: 'dev-other' });
      service.setClock(() => T0 + 31_000);

      const noLegalBefore = (await exactSeriesValue(matchNoLegalGroupTotal, { game_type: 'doudizhu' })) ?? 0;
      await service.scanOnce();

      // S 从**原序最久者**（A）起算 ⇒ [A, C]（B 被拒）；2 人 + 1 机器人
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['A', 'C'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(1);
      expect((await globalService.findOne('ABC123'))?.players.length).toBe(3);
      // 贪心未成组 ⇒ no_legal +1（可观测定义）
      expect((await exactSeriesValue(matchNoLegalGroupTotal, { game_type: 'doudizhu' })) ?? 0).toBe(noLegalBefore + 1);
      // B 未被选入：留队（enteredAt 不变）、本轮记账 +1、记忆已写
      expect(redis._zsets.get(Q)?.get('B')).toBe(T0 + 1);
      expect(redis._hashes.get('match:meta:B')?.attempts).toBe('1');
      expect(redis._strings.get('match:rejected:A:B')).toBe(String(T0 + 31_000));
    });

    it('C5：|S|=1 且 ≥30s ⇒ 本人 + 2 机器人；窗口未到（29s）⇒ 本轮不动、门禁也不问', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      let availabilityCalls = 0;
      rpc.on(RPC_PATTERNS.robotAvailability, () => {
        availabilityCalls += 1;
        return of({ ok: true, data: { canProvide: true } });
      });
      // 三人互斥（同设备）⇒ S 只能取到最久者一人
      await enqueueAt('A', T0);
      await enqueueAt('B', T0 + 1);
      await enqueueAt('C', T0 + 2);
      await fingerprint('A', { deviceId: 'dev-x' });
      await fingerprint('B', { deviceId: 'dev-x' });
      await fingerprint('C', { deviceId: 'dev-x' });

      service.setClock(() => T0 + 29_000);
      await service.scanOnce();
      // 窗口未到：不成局、不补位、**门禁绝不提前问**（旧纪律：问了也是白问）
      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      expect(availabilityCalls).toBe(0);

      service.setClock(() => T0 + 31_000);
      await service.scanOnce();
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['A'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(2);
      expect(availabilityCalls).toBe(1);
    });

    it('C5：子集 |S|=3 ⇒ 直接成三人组（贪心被「外团者」挡住；无需机器人/窗口）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      configCache.riskPredicateSameIp.mockReturnValue(true);
      // A(X,1) B(Y,2) C(Z,3) 两两全异（合法团）；D(X,2) 与 A 同设备、与 B 同 IP
      await enqueueAt('A', T0);
      await enqueueAt('B', T0 + 1);
      await enqueueAt('C', T0 + 2);
      await enqueueAt('D', T0 + 3);
      await fingerprint('A', { deviceId: 'dev-X', ip: 'ip-1' });
      await fingerprint('B', { deviceId: 'dev-Y', ip: 'ip-2' });
      await fingerprint('C', { deviceId: 'dev-Z', ip: 'ip-3' });
      await fingerprint('D', { deviceId: 'dev-X', ip: 'ip-2' });
      // 钉洗牌序 [D,A,B,C]：贪心先落 D ⇒ A（同设备）、B（同 IP）全被挡 ⇒ 只凑到 [D,C] = 2
      service.setRng(rngForShuffle(['A', 'B', 'C', 'D'], ['D', 'A', 'B', 'C']));
      service.setClock(() => T0 + 1_000); // 窗口未到也**直接**成组（⚙️22-②）

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['A', 'B', 'C'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      // D 的两次拒绝各记账（记忆字典序键 A:D / B:D —— 两端命中计数分谓词各 +1）
      expect(redis._strings.get('match:rejected:A:D')).toBe(String(T0 + 1_000));
      expect(redis._strings.get('match:rejected:B:D')).toBe(String(T0 + 1_000));
      expect(redis._strings.get('risk:hit:D:sameDevice')).toBe('1');
      expect(redis._strings.get('risk:hit:A:sameDevice')).toBe('1');
      expect(redis._strings.get('risk:hit:D:sameIp')).toBe('1');
      expect(redis._strings.get('risk:hit:B:sameIp')).toBe('1');
      // ⚠️ attempts：A/B/C 成局后 meta 随 `cancelQueue` 清掉 ⇒ 它们的 +1 在落盘面**不可观测**；
      // 可观测的是 **D 的去重后 +1**（⚙️2：同一轮两对拒绝只记一次）
      expect(redis._hashes.get('match:meta:D')?.attempts).toBe('1');
      expect(redis._strings.has('risk:hit:C:sameDevice'), 'C 从未被拒 ⇒ 无命中键').toBe(false);
      expect(redis._strings.has('risk:hit:C:sameIp')).toBe(false);
      expect(redis._zsets.get(Q)?.has('D')).toBe(true); // 未被选：留队
    });

    it('C2：洗牌的是副本 —— oldest/最长等待者判定仍取原序首（子集自原序首起算）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      // u1 最早（X）、u3（X）与 u1 互斥、u2（Y）通融；钉洗牌序 [u2,u3,u1]
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 1);
      await enqueueAt('u3', T0 + 2);
      await fingerprint('u1', { deviceId: 'dev-X' });
      await fingerprint('u2', { deviceId: 'dev-Y' });
      await fingerprint('u3', { deviceId: 'dev-X' });
      service.setRng(rngForShuffle(['u1', 'u2', 'u3'], ['u2', 'u3', 'u1']));
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      // 子集从 **u1**（原序首/最久者）起算 ⇒ [u1, u2]。
      // 若实现把原序数组按洗牌序覆写（错读法），oldest 会是 u2 ⇒ 房间 [u2, u3] ⇒ 本断言红。
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(1); // 2 + 1
      // 另一半证据：未被选中的 u3 的 enteredAt（ZSET score + meta 字段）原样未动
      expect(redis._zsets.get(Q)?.get('u3')).toBe(T0 + 2);
      expect(redis._hashes.get('match:meta:u3')?.enteredAt).toBe(String(T0 + 2));
    });

    it('C6：<3 越窗 —— 互斥二人被拆组：各自「本人 + 2 机器人」（窗口自各人 enteredAt 起算）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      distinctRoomCodes(['ABC123', 'XYZ789']);
      await enqueueAt('A', T0);
      await enqueueAt('B', T0 + 1);
      await fingerprint('A', { deviceId: 'dev-shared' });
      await fingerprint('B', { deviceId: 'dev-shared' });
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      // 门禁过（默认 fail-open）⇒ 拆组：S=[A]（原序最久者）先开，拆出者 B 随后单独开
      expect(roomsService.createGameRoom.mock.calls.map((c) => c[0])).toEqual([['A'], ['B']]);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(4); // 2 + 2
      expect((await globalService.findOne('ABC123'))?.status).toBe('playing');
      expect((await globalService.findOne('XYZ789'))?.status).toBe('playing');
      expect(matchEvents().filter((e) => e.event === 'match.timeout')).toHaveLength(0);
    });

    it('C6：互斥二人 + 门禁不能给 ⇒ 12007（既有 :591-600 语义不动）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      rpc.on(RPC_PATTERNS.robotAvailability, () =>
        of({ ok: true, data: { canProvide: false } }));
      await enqueueAt('A', T0);
      await enqueueAt('B', T0 + 1);
      await fingerprint('A', { deviceId: 'dev-shared' });
      await fingerprint('B', { deviceId: 'dev-shared' });
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      const timeout = matchEvents().find((e) => e.event === 'match.timeout');
      expect(timeout).toMatchObject({ playerIds: ['A', 'B'], code: 12007 }); // 两人都 ≥30s ⇒ 都判
      expect(redis._zsets.get(Q)?.size).toBe(0); // 判完出队
    });

    it('C6：<3 越窗 —— 不互斥 ⇒ 照常同房（谓词不误伤正常配对）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      await enqueueAt('A', T0);
      await enqueueAt('B', T0 + 1);
      await fingerprint('A', { deviceId: 'dev-a' });
      await fingerprint('B', { deviceId: 'dev-b' });
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['A', 'B'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(1); // 2 + 1
    });

    it('§2.3：matchRejectedKey 是字典序逆不变的（同一对怎么拼都落同一键）', () => {
      expect(matchRejectedKey('a', 'b')).toBe('match:rejected:a:b');
      expect(matchRejectedKey('b', 'a')).toBe('match:rejected:a:b');
      expect(matchRejectedKey('u9', 'u10')).toBe('match:rejected:u10:u9'); // 字符串序（非数值序）
    });

    it('波 1 F1：孤儿票（meta 过期）在谓词开启时同样**先清出** —— 不占位、不配对、不崩桶', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 1);
      await fingerprint('u1', { deviceId: 'dev-x' });
      await fingerprint('u2', { deviceId: 'dev-x' });
      // u2 的 meta 整键过期（ZSet 成员**没有** TTL ⇒ 残留 —— R63 形态）⇒ 孤儿
      redis._hashes.delete('match:meta:u2');
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      // u2 被**清出**（而非被拉进房 / 也不进谓词判定——否则「永不有人加入的座」）；
      // u1 单独按窗口语义成局（+2 机器人）。
      // ⚠️ 修复前：u2 会带着「无指纹占位票」进谓词判定、被静默配对成 [u1,u2]（本断言红）。
      expect(redis._zsets.get(Q)?.has('u2')).toBe(false);
      expect(roomsService.createGameRoom).toHaveBeenCalledTimes(1);
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(2);
      expect(
        (redis.set as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
          (call: unknown[]) => String(call[0]).startsWith('match:rejected:'),
        ),
        '孤儿不参与判定 ⇒ 无拒绝记账',
      ).toHaveLength(0);
    });

    it('波 1 F1：单人孤儿 ≥60s ⇒ 前置清出、不建房、零事件（无 12007 —— 所有者已不存在）', async () => {
      await enqueueAt('ghost', T0);
      redis._hashes.delete('match:meta:ghost');
      service.setClock(() => T0 + 60_001);

      await service.scanOnce();

      expect(redis._zsets.get(Q)?.has('ghost')).toBe(false);
      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      expect(
        (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([channel]) => channel === 'match:events',
        ),
        '静默清理：一条 match:events 都不发（无 12007、无 room.matched）',
      ).toHaveLength(0);
    });

    it('波 1 F2：记忆过期（>5s）⇒ 不命中、谓词重判、记忆被**重写**（杀「存在即命中」变异）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      await enqueueAt('A', T0);
      await enqueueAt('B', T0 + 1);
      await enqueueAt('C', T0 + 2);
      await fingerprint('A', { deviceId: 'dev-shared' });
      await fingerprint('B', { deviceId: 'dev-shared' });
      await fingerprint('C', { deviceId: 'dev-other' });
      service.setRng(rngForShuffle(['A', 'B', 'C'], ['A', 'C', 'B']));
      const now = T0 + 1_000;
      // 预置一条 **6s 前**的记忆（超出 5s 窗；替身不推进 TTL ⇒ 键仍在 —— 恰是「存在 ≠ 命中」的判别面）
      redis._strings.set('match:rejected:A:B', String(now - 6_000));
      service.setClock(() => now);
      const rejectionsBefore =
        (await labeledValue(matchPredicateRejectionsTotal, { predicate: 'sameDevice' })) ?? 0;

      await service.scanOnce();

      // 过期 ⇒ 走**谓词拒绝**路径：记忆被重写为 now、两端 INCR、指标 +1、两端 attempts+1
      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith('match:rejected:A:B', String(now), 'PX', 5000);
      expect(redis._strings.get('match:rejected:A:B')).toBe(String(now));
      expect(redis.incr).toHaveBeenCalledTimes(2);
      expect(redis._hashes.get('match:meta:A')?.attempts).toBe('1');
      expect(redis._hashes.get('match:meta:B')?.attempts).toBe('1');
      expect(await labeledValue(matchPredicateRejectionsTotal, { predicate: 'sameDevice' })).toBe(
        rejectionsBefore + 1,
      );
    });

    it('波 1 F3：拒绝 bump 推过 10 ⇒ 下一轮到点兜底成局（联动：记账 → 到点 → 兜底）', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      distinctRoomCodes(['ABC123', 'XYZ789', 'UVW456']);
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 1);
      await enqueueAt('u3', T0 + 2);
      await enqueueAt('u4', T0 + 3);
      await fingerprint('u1', { deviceId: 'dev-x' });
      await fingerprint('u2', { deviceId: 'dev-x' }); // u2 与 u1 互斥
      await fingerprint('u3', { deviceId: 'dev-y' });
      await fingerprint('u4', { deviceId: 'dev-z' });
      await redis.hset('match:meta:u2', { attempts: '9' });

      // ── 第 1 轮（31s）：u2 与 u1 相斥 ⇒ 被拒 bump 9→10；三人团 [u1,u3,u4] 成局、u2 留队 ──
      service.setClock(() => T0 + 31_000);
      await service.scanOnce();
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u3', 'u4'], 'random', 15, 'doudizhu', 3);
      expect(redis._hashes.get('match:meta:u2')?.attempts, '预置 9 + 本轮拒绝 = 10').toBe('10');
      expect(redis._zsets.get(Q)?.has('u2')).toBe(true); // 留队（不丢人）

      // ── 第 2 轮（32s）：u2 到点（≥30s 且 attempts=10）⇒ 并入候选；三人团先被抽走 ⇒
      //    u2 落**兜底集合**成局（本人 + 2 机器人）—— 「拒绝 bump 推过 10」的终点 ──
      await enqueueAt('u5', T0 + 31_500);
      await enqueueAt('u6', T0 + 31_501);
      await enqueueAt('u7', T0 + 31_502);
      service.setRng(rngForShuffle(['u2', 'u5', 'u6', 'u7'], ['u5', 'u6', 'u7', 'u2']));
      service.setClock(() => T0 + 32_000);
      await service.scanOnce();

      expect(roomsService.createGameRoom.mock.calls.map((c) => c[0])).toEqual([
        ['u1', 'u3', 'u4'], // 第 1 轮
        ['u5', 'u6', 'u7'], // 第 2 轮：正常抽取先行
        ['u2'], // 第 2 轮：到点兜底（本人的房 + 2 机器人）
      ]);
      const fallbackRoom = await globalService.findOne('UVW456');
      expect(fallbackRoom?.status).toBe('playing');
      expect(fallbackRoom?.players.filter((p) => p.isRobot)).toHaveLength(2);
      expect(redis._zsets.get(Q)?.has('u2')).toBe(false); // 兜底成局 ⇒ 出队
    });

    it('波 2 F4①：封禁旗在 ⇒ 存量票被**前置清出**（不建房、零事件）', async () => {
      await enqueueAt('u1', T0);
      redis._strings.set('risk:banned:u1', '1'); // 旗在（§2.3：值 '1'）
      service.setClock(() => T0 + 31_000); // 无旗时该场景会「本人 + 2 机器人」成局

      await service.scanOnce();

      // 票与 meta 一并清（cancelQueue 的精确路径）—— 该位**不会**再进选择/兜底
      expect(redis._zsets.get(Q)?.has('u1')).toBe(false);
      expect(redis._hashes.has('match:meta:u1')).toBe(false);
      expect(roomsService.createGameRoom).not.toHaveBeenCalled();
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);
      expect(
        (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([channel]) => channel === 'match:events',
        ),
        '静默撤票：零事件（无 12007 —— 封禁通告没有意义）',
      ).toHaveLength(0);
    });

    it('波 2 F4②：旗在 + 谓词开 ⇒ 先清出、不配对、零记账；其余人照常成局', async () => {
      configCache.riskPredicateSameDevice.mockReturnValue(true);
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 1);
      await fingerprint('u1', { deviceId: 'dev-x' });
      await fingerprint('u2', { deviceId: 'dev-x' });
      redis._strings.set('risk:banned:u2', '1');
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      // u2 **先**被清出（而不是被拉去做「配对/拆组」—— 若未清出：同设备 ⇒ 拆组 ⇒ 两间房 ⇒ 红）
      expect(redis._zsets.get(Q)?.has('u2')).toBe(false);
      expect(roomsService.createGameRoom).toHaveBeenCalledTimes(1);
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(2); // u1 单独 ⇒ 2 个机器人
      expect(
        (redis.set as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
          (call: unknown[]) => String(call[0]).startsWith('match:rejected:'),
        ),
        '封禁者不参与判定 ⇒ 无拒绝记账',
      ).toHaveLength(0);
    });

    it('波 2 F4③（负对照）：无旗 ⇒ 前置筛选不误伤，照常同房', async () => {
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 1);
      // 不写任何 risk:banned 旗 —— pipeline 批读返回全 0
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(1);
    });

    it('波 2 F4 补：旗读失败 ⇒ 按无旗放行（R11/F8；匹配不受影响）', async () => {
      await enqueueAt('u1', T0);
      await enqueueAt('u2', T0 + 1);
      (redis.pipeline as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('redis hiccup');
      });
      service.setClock(() => T0 + 31_000);

      await service.scanOnce();

      // fail-open：照常成局（旗读的 catch 只上 error 日志，不拦匹配）
      expect(roomsService.createGameRoom).toHaveBeenCalledWith(['u1', 'u2'], 'random', 15, 'doudizhu', 3);
      expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(1);
    });
  });

  /**
   * 本片 T6：`match:claim` 防线（C29/C30）—— 重叠轮/下轮扫描不把「已在途开局的组」再选进第二间房。
   *
   * 替身纪律（r2-F10）：**先扩替身**（NX/TTL/可注入时钟 —— Step 0），**再**写判据。
   *
   * C31（登记口径，规格 §5 预置）：本片对「重叠轮真实并发」不作真栈断言（撮合扫描无防重入、
   * 重叠轮只能在真并发下构造，不可稳定复现）⇒ 判据 = 本组单测（筛选语义 + TTL 放行 + 零污染）；
   * 多玩法 Task 2.1 起 claim 是**全模式**防线（spec RH3-a），残留边界只剩「claim 到期」——
   * 到期后放行由 C30② 的 TTL 用例承接。
   */
  describe('本片：match:claim 防线（C29 写 / C30 筛 / C31 登记 = 单测口径）', () => {
    const T0 = 1_700_000_000_000;

    /** 安排一场「三人齐、可成组」的金币扫描（waited 已越窗亦可；本组用 ≥3 快路径）。 */
    async function queueThree(): Promise<void> {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'gold', 15);
      await service.addToQueue('u2', 'gold', 15);
      await service.addToQueue('u3', 'gold', 15);
    }

    it('C29：金币场组队 ⇒ 逐成员 SET match:claim:<id> = 1 EX 30 NX（组序）', async () => {
      await queueThree();

      await service.scanOnce();

      // 任务书字面修正（T6 执行期）：`.mock` 面在本文件须走成例断言转换（`Redis` 类型无 `.mock`）。
      const setMock = redis.set as unknown as ReturnType<typeof vi.fn>;
      const claimWrites = setMock.mock.calls.filter(([key]) => String(key).startsWith('match:claim:'));
      expect(claimWrites).toEqual([
        ['match:claim:u1', 'ABC123', 'EX', 30, 'NX'],
        ['match:claim:u2', 'ABC123', 'EX', 30, 'NX'],
        ['match:claim:u3', 'ABC123', 'EX', 30, 'NX'],
      ]);
      expect(rpc.payloadsOf(RPC_PATTERNS.gameStart)).toHaveLength(1); // 反空测：真的成了组
    });

    it('C29b（多玩法 Task 2.1）：免费场（random）也逐成员写 claim —— 不再是 gold-only', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'random', 15);
      await service.addToQueue('u2', 'random', 15);
      await service.addToQueue('u3', 'random', 15);

      await service.scanOnce();

      expect(rpc.payloadsOf(RPC_PATTERNS.gameStart)).toHaveLength(1); // 反空测
      const setMock = redis.set as unknown as ReturnType<typeof vi.fn>;
      expect(
        setMock.mock.calls.filter(([key]) => String(key).startsWith('match:claim:')),
      ).toEqual([
        ['match:claim:u1', 'ABC123', 'EX', 30, 'NX'],
        ['match:claim:u2', 'ABC123', 'EX', 30, 'NX'],
        ['match:claim:u3', 'ABC123', 'EX', 30, 'NX'],
      ]);
    });

    it('C30①：alive 段持有 claim 者被跳过、**不 cancelQueue**（其余三人照常成组）', async () => {
      service.setClock(() => T0);
      await service.addToQueue('u1', 'gold', 15);
      await service.addToQueue('u2', 'gold', 15);
      await service.addToQueue('u3', 'gold', 15);
      await service.addToQueue('u4', 'gold', 15);
      // 模拟「重叠轮已把 u1 带走」（在途声明的落点形态；四票在手 ⇒ 过滤后仍 ≥3 走快路径）
      await redis.set('match:claim:u1', 'ABC123', 'EX', 30, 'NX');

      await service.scanOnce();

      const starts = rpc.payloadsOf(RPC_PATTERNS.gameStart) as Array<{ players: Array<{ id: string }> }>;
      expect(starts, '反空测：u2/u3/u4 照常成组（被跳过的只有 u1）').toHaveLength(1);
      const ids = starts[0]!.players.map((p) => p.id);
      expect(ids).not.toContain('u1');
      expect(ids).toEqual(expect.arrayContaining(['u2', 'u3', 'u4']));
      // 不 cancelQueue：u1 的票仍在（meta 与 ZSet 双面）
      expect(redis._zsets.get('match:queue:gold:15:global')?.has('u1')).toBe(true);
      expect(redis._hashes.get('match:meta:u1')).toBeDefined();
    });

    it('C30②：TTL 过期后放行（可注入时钟）—— 过期前不成组、推进 31s 后被重新选进', async () => {
      await queueThree(); // 三人齐但 waited = 0 <30s：第一轮被筛成 2 人后走 <3 越窗主路径 ⇒ 本轮不动
      await redis.set('match:claim:u1', 'ABC123', 'EX', 30, 'NX');

      await service.scanOnce();

      expect(rpc.payloadsOf(RPC_PATTERNS.gameStart)).toHaveLength(0);
      expect(redis._zsets.get('match:queue:gold:15:global')?.has('u1')).toBe(true); // 票仍在

      redis._advanceMs(31_000); // claim 过期（30s + 1s）
      service.setClock(() => T0 + 31_000);
      await service.scanOnce();

      const starts = rpc.payloadsOf(RPC_PATTERNS.gameStart) as Array<{ players: Array<{ id: string }> }>;
      expect(starts, '过期后三人齐 ⇒ 成组').toHaveLength(1);
      expect(starts[0]!.players.map((p) => p.id)).toContain('u1');
    });
  });
});

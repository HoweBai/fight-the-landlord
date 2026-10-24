/**
 * 多玩法片 Task 2.1 起新增的两个匹配测试文件（`match-queue-key` / `match-claim`）共用的
 * **状态化** Redis 替身 + `MatchService` 夹具。
 *
 * ⚠️ 为什么要一套新夹具（而不是复用 `match.service.test.ts` 里那份）：那份内联替身与
 * `RoomsService` 透明代理深度耦合（真实建房/座位都落在假 Redis 上），而 Task 2.1 的判据
 * 只关心「键怎么选、claim 怎么写/怎么筛」——这里给的是**最小但同形**的一面：
 * ZSet / Hash / String / TTL / SCAN / pipeline 都真的存值，缺一格就会在扫描链上当场抛
 *（本仓反复复发的「替身比接口窄 ⇒ 以无关错误码变红」）。
 */
import { vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { GameType } from '@fight-the-landlord/protocol';
import { MatchService, type MatchMode } from '../../src/match/match.service';
import type { RoomStartService } from '../../src/rooms/rooms.start';
import type { RoomsService } from '../../src/rooms/rooms.service';
import type { RobotClient } from '../../src/gateway/robot.client';
import { asConfigCache, makeConfigCache, type ConfigCacheStub } from './config-cache.stub';

export type MatchRedisFake = Redis & {
  _hashes: Map<string, Record<string, string>>;
  _strings: Map<string, string>;
  _zsets: Map<string, Map<string, number>>;
  /** 绝对到期时刻（epoch ms）；`set … EX/PX` / `expire` 写，`get`/`exists`/pipeline 读。 */
  _ttls: Map<string, number>;
};

/** 与 `match.service.test.ts` 内的替身同语义：一次 SCAN 返回全部匹配键、游标 `'0'`。 */
export function makeMatchRedis(clock: { now: number }): MatchRedisFake {
  const hashes = new Map<string, Record<string, string>>();
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const ttls = new Map<string, number>();
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
    zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
    zscore: vi.fn(async (key: string, member: string) => {
      const score = zsets.get(key)?.get(member);
      return score === undefined ? null : String(score);
    }),
    scan: vi.fn(async (cursor: string, _match: string, pattern: string) => {
      if (cursor !== '0') return ['0', []];
      const prefix = pattern.replace(/\*$/, '');
      const keys = [...new Set([...zsets.keys(), ...hashes.keys(), ...strings.keys()])].filter((k) =>
        k.startsWith(prefix),
      );
      return ['0', keys] as [string, string[]];
    }),
    hset: vi.fn(async (key: string, fieldOrFields: string | Record<string, string>, value?: string) => {
      const patch =
        typeof fieldOrFields === 'string' ? { [fieldOrFields]: String(value) } : fieldOrFields;
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...patch });
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => hashes.get(key) ?? {}),
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
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
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      let expiresAtMs: number | undefined;
      let nx = false;
      if (args[0] === 'PX' && typeof args[1] === 'number') {
        expiresAtMs = clock.now + args[1];
      } else if (args[0] === 'EX' && typeof args[1] === 'number') {
        expiresAtMs = clock.now + args[1] * 1000;
        nx = args[2] === 'NX';
      } else if (args.length > 0) {
        throw new Error(`makeMatchRedis 未识别的 set 选项形态：${args.map(String).join(' ')}`);
      }
      if (nx && existsNow(key)) return null;
      strings.set(key, String(value));
      if (expiresAtMs !== undefined) ttls.set(key, expiresAtMs);
      else ttls.delete(key);
      return 'OK' as const;
    }),
    get: vi.fn(async (key: string) => (existsNow(key) ? (strings.get(key) ?? null) : null)),
    incr: vi.fn(async (key: string) => {
      const next = Number(strings.get(key) ?? '0') + 1;
      strings.set(key, String(next));
      return next;
    }),
    exists: vi.fn(async (key: string) => (existsNow(key) ? 1 : 0)),
    pipeline: vi.fn(() => {
      const ops: Array<{ op: 'exists' | 'get'; key: string }> = [];
      const chain: {
        exists: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        exec: ReturnType<typeof vi.fn>;
      } = {
        exists: vi.fn((key: string) => {
          ops.push({ op: 'exists', key });
          return chain;
        }),
        // Task 2.4：claim 的值 = roomCode ⇒ 扫描必须 GET（不再只是 EXISTS）。
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
        ttls.delete(key);
      }
      return removed;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      if (!existsNow(key)) return 0;
      ttls.set(key, clock.now + seconds * 1000);
      return 1;
    }),
    publish: vi.fn(async () => 1),
    _hashes: hashes,
    _strings: strings,
    _zsets: zsets,
    _ttls: ttls,
  } as unknown as MatchRedisFake;
}

export interface MatchServiceHarness {
  service: MatchService;
  redis: MatchRedisFake;
  clock: { now: number; set: (ms: number) => void; advance: (ms: number) => void };
  configCache: ConfigCacheStub;
  rooms: {
    createGameRoom: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    cancelIfStillWaiting: ReturnType<typeof vi.fn>;
  };
  roomStart: {
    startRoomOutcome: ReturnType<typeof vi.fn>;
    startRoom: ReturnType<typeof vi.fn>;
  };
  robot: { availability: ReturnType<typeof vi.fn> };
}

export interface HarnessOptions {
  /**
   * 开局成功时是否模拟 `onSeats`（= 真实开局链里**取消队列票**的那一步）。
   * 缺省 `true`（生产形态）；claim 的「票未删」判据显式传 `false`。
   */
  callOnSeats?: boolean;
}

/**
 * 建一套最小匹配夹具。
 *
 * 缺省 RNG 恒等（`floor(0.9999999 × (i+1)) === i` ⇒ Fisher–Yates 不交换）——
 * 既有断言的「组序 == 入队序」在这个文件里同样保持。
 */
export function makeMatchServiceHarness(options: HarnessOptions = {}): MatchServiceHarness {
  const clock = { now: 1_700_000_000_000 };
  const redis = makeMatchRedis(clock);
  const configCache = makeConfigCache();
  let lastRoom: {
    code: string;
    mode: MatchMode;
    gameType: GameType;
    baseScore: number;
    players: Array<{ userId: string; seat: number }>;
    maxPlayers: number;
    status: 'waiting' | 'playing' | 'cancelled';
    createdAt: number;
    timeoutAt: number;
  } | null = null;

  const rooms = {
    createGameRoom: vi.fn(
      async (
        ids: string[],
        mode: MatchMode,
        baseScore: number,
        gameType: GameType = 'doudizhu',
        playerCount = 3,
      ) => {
        lastRoom = {
          code: 'ABC123',
          mode,
          gameType,
          baseScore,
          players: ids.map((userId, seat) => ({ userId, seat })),
          maxPlayers: playerCount,
          status: 'waiting',
          createdAt: clock.now,
          timeoutAt: clock.now,
        };
        return lastRoom;
      },
    ),
    findOne: vi.fn(async (code: string) =>
      lastRoom && lastRoom.code === code ? { ...lastRoom } : null,
    ),
    cancelIfStillWaiting: vi.fn(async (code: string) => {
      if (!lastRoom || lastRoom.code !== code || lastRoom.status !== 'waiting') return false;
      lastRoom.status = 'cancelled';
      return true;
    }),
  };
  const roomStart = {
    startRoomOutcome: vi.fn(
      async (
        _code: string,
        opts?: { onSeats?: (seats: Array<{ userId: string; isRobot: boolean }>) => Promise<void> },
      ) => {
        if (lastRoom) lastRoom.status = 'playing';
        if (options.callOnSeats !== false && opts?.onSeats && lastRoom) {
          await opts.onSeats(lastRoom.players.map((p) => ({ userId: p.userId, isRobot: false })));
        }
        return 'started';
      },
    ),
    startRoom: vi.fn(async () => true),
  };
  const robot = { availability: vi.fn(async () => true) };

  const service = new MatchService(
    redis,
    rooms as unknown as RoomsService,
    roomStart as unknown as RoomStartService,
    asConfigCache(configCache),
    robot as unknown as RobotClient,
  );
  service.setClock(() => clock.now);
  service.setRng(() => 0.9999999);

  return {
    service,
    redis,
    clock: {
      now: clock.now,
      set: (ms: number) => {
        clock.now = ms;
      },
      advance: (ms: number) => {
        clock.now += ms;
      },
    },
    configCache,
    rooms,
    roomStart,
    robot,
  };
}

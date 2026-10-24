/**
 * `routeClientMessage` 的可复用测试夹具（原 `message.router.test.ts` 文件内局部函数）。
 *
 * 挂机治理片 T6（C26）：接线闸的第二条腿要**遍历 `CLIENT_MESSAGE_TYPES` 走真实路由**
 * 并断言不命中「Unhandled client message type」。闸**不得依赖私有构造**
 *（规格 C26 逐字），而把 `message.router.test.ts` 整个 import 进来会让它的
 * `describe` 块在闸文件里再注册一遍 ⇒ 抽到本 helper 单一真源。
 *
 * ⚠️ 替身纪律（本仓反复复发的坑）：**替身必须与接口同宽**。路由新增一次
 * `deps.xxx.yyy()` 调用时，这里缺一格 ⇒ 抛错被路由 catch 压成 13001，
 * 看起来像被测代码坏了，实际是替身比接口窄。
 */
import { vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import type { Redis } from 'ioredis';
import { RECONNECT_HASH_KEY } from '../../src/reconnect/reconnect.service';
import type { RouterDeps } from '../../src/gateway/message.router';
import { routeClientMessage } from '../../src/gateway/message.router';
import type { GameClient } from '../../src/gateway/game.client';
import type { MatchService } from '../../src/match/match.service';
import type { RoomsService } from '../../src/rooms/rooms.service';
import type { RoomStartService } from '../../src/rooms/rooms.start';
import type { ReconnectService } from '../../src/reconnect/reconnect.service';
import type { CurrencyClient } from '../../src/currency/currency.client';
import type { RiskClient } from '../../src/gateway/risk.client';
import type { RoomNicknamesService } from '../../src/rooms/room-nicknames.service';
import { asConfigCache, makeConfigCache } from './config-cache.stub';

export function makeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  /** 限流用的滑动窗口：member 是请求标识，用递增序号保证不覆盖。 */
  let ticket = 0;
  return {
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const z = zsets.get(key) ?? new Map<string, number>();
      // 限流窗口的 member 必须唯一（否则同一毫秒内会被去重），其余调用按原 member 存
      const stored = key.startsWith('ratelimit:') ? `${member}#${ticket++}` : member;
      z.set(stored, score);
      zsets.set(key, z);
      return 1;
    }),
    zrem: vi.fn(async (key: string, member: string) => {
      zsets.get(key)?.delete(member);
      return 1;
    }),
    zscore: vi.fn(async (key: string, member: string) => {
      const v = zsets.get(key)?.get(member);
      return v === undefined ? null : String(v);
    }),
    zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
    zremrangebyscore: vi.fn(async () => 0),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      hashes.set(key, { ...(hashes.get(key) ?? {}), [field]: value });
      return 1;
    }),
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
    /**
     * ⚠️ Task 3c 修复 1 的判据要接**真实** `MatchService`（它是 `handleMatch` 的第一跳：
     * `readMeta` → `HGETALL`）—— 手写窄替身缺这一格时，`room.match` 会在**被测代码之前**
     * 就抛 `hgetall is not a function`，症状被路由 catch 压成 13001 而与错误码映射无关
     *（本仓记过三次同形教训：替身比接口窄 ⇒ 以完全无关的错误码变红）。
     */
    hgetall: vi.fn(async (key: string) => hashes.get(key) ?? {}),
    hdel: vi.fn(async (key: string, field: string) => {
      const hash = hashes.get(key);
      if (!hash || !(field in hash)) return 0;
      delete hash[field];
      return 1;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (hashes.delete(key)) removed += 1;
        if (strings.delete(key)) removed += 1;
      }
      return removed;
    }),
    expire: vi.fn(async () => 1),
    set: vi.fn(async (key: string, value: string) => {
      strings.set(key, value);
      return 'OK';
    }),
    exists: vi.fn(async (key: string) => (hashes.has(key) || strings.has(key) ? 1 : 0)),
    _hashes: hashes,
    _strings: strings,
  } as unknown as Redis & {
    _hashes: Map<string, Record<string, string>>;
    _strings: Map<string, string>;
  };
}

/**
 * @param extraData 额外的 `socket.data` 字段。判据 6′ 用它挂 `traceId` ——
 *   那正是网关在握手 `auth.traceId` 里写入、由 `ws.gateway.handleConnection`
 *   存进 `socket.data` 的**连接级** id（生产路径见 `ws.gateway.ts:199`）。
 */
export function makeSocket(
  userId?: string,
  extraData: Record<string, unknown> = {},
): Socket & { emitted: Array<[string, unknown]> } {
  const emitted: Array<[string, unknown]> = [];
  return {
    id: 'sock-1',
    data: { ...(userId ? { userId } : {}), ...extraData },
    emit: vi.fn((type: string, payload: unknown) => {
      emitted.push([type, payload]);
      return true;
    }),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    emitted,
  } as unknown as Socket & { emitted: Array<[string, unknown]> };
}

export function makeDeps(over: Partial<RouterDeps> = {}) {
  const redis = makeRedis();
  const match = {
    addToQueue: vi.fn().mockResolvedValue(undefined),
    cancelQueue: vi.fn().mockResolvedValue(undefined),
    // 机器人补位开关片：延长匹配（票留队、平移提示窗口；替身 no-op 即可）。
    extendWait: vi.fn().mockResolvedValue(undefined),
    // R63：默认表示「meta 在」（排队状态的真相源）；覆盖成 `null` 可模拟 meta 过期
    readMeta: vi.fn().mockResolvedValue({
      playerId: 'alice',
      mode: 'random',
      // 片规格 §2.4：ticket 携带 `(mode, baseScore, region)` —— `handleMatch` 用它定位
      // 玩家**实际所在**的队列键（meta 是排队状态的真相源，R42/R63）。
      baseScore: 15,
      region: 'global',
      enteredAt: Date.now(),
      latency: 0,
      attempts: 0,
    }),
  };
  const rooms = {
    findOne: vi.fn().mockResolvedValue(null),
    // 本片：退房腾座位 + 占用变化重置等待窗口（R904 / R906 / R916）
    leaveSeat: vi.fn().mockResolvedValue(undefined),
    resetWaitingWindow: vi.fn().mockResolvedValue(undefined),
  };
  const reconnect = {
    // Task 2（规格 v1.1 §2.2/§2.3）：路由四处收编 resolver 后，替身的驱动面就是它。
    // 缺省 `null` = 无任何可恢复凭据（`handleReconnect` → 13010、resync/动作 → 12004）。
    resolveRecoverableRoom: vi.fn().mockResolvedValue(null),
    touch: vi.fn().mockResolvedValue(null),
    /**
     * 本片 T2（规格 §2.3 配套 / F1）：`room.leave` 清理单闸的凭据读面 —— 与真实
     * `readRecord` **同语义**（读同一假 redis 的 `RECONNECT_HASH_KEY` 字段、JSON.parse、
     * 缺/坏 ⇒ null），使清理闸三态（一致清 / 不一致不清 / 缺席清）在替身上可控。
     * ⚠️ 缺这一格 ⇒ `getRecord is not a function` ⇒ 通用 catch ⇒ **13001**，既有全部
     * leave 用例会以完全无关的错误码整族红（「替身比接口窄」形态）。
     */
    getRecord: vi.fn(async (playerId: string) => {
      const raw = await redis.hget(RECONNECT_HASH_KEY, playerId);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as {
          socketId?: unknown;
          roomCode?: unknown;
          connectedAt?: unknown;
        };
        if (typeof parsed.roomCode !== 'string' || parsed.roomCode.length === 0) return null;
        return {
          socketId: typeof parsed.socketId === 'string' ? parsed.socketId : '',
          roomCode: parsed.roomCode,
          connectedAt: Number(parsed.connectedAt) || 0,
        };
      } catch {
        return null; // 坏 JSON ⇒ 按缺席（与真实 readRecord 一致）
      }
    }),
    // 与真实实现同语义（窗口退役后 **只删哈希**），否则「leave → reconnect」的用例
    // 会在「哈希字段其实还在」的假前提上通过。
    clearConnection: vi.fn(async (playerId: string) => {
      await redis.hdel(RECONNECT_HASH_KEY, playerId);
    }),
  };
  const game = {
    start: vi.fn(),
    snapshot: vi.fn().mockResolvedValue({ data: null }),
    view: vi.fn().mockResolvedValue(null),
    action: vi.fn().mockResolvedValue({ state: 'bidding', version: 2 }),
    // 挂机治理 T6（C19/C21/C22）：`game.trustee` 边 —— 路由的三处转发都经它。
    // 缺省成功（`{version}` 信封解包后的 data）；要「转发失败」的用例显式覆盖成 reject。
    trustee: vi.fn().mockResolvedValue({ version: 2 }),
  };
  /**
   * 本片：`room.join` 成功后若房间已满，**同步**触发开局（R902）。
   * 替身只记调用；开局链本身由 `rooms.start.test.ts` 与 `rooms.autostart.test.ts` 覆盖。
   */
  const roomStart = { startRoom: vi.fn().mockResolvedValue(true) };
  /**
   * ② 金币场 T4：`room.match` 的两条新依赖 —— 双开关读面（C1/C2）与门槛读边（C4）。
   *
   * 缺省镜像**生产种子**（与 `helpers/config-cache.stub.ts` 同一纪律）：
   * free=true / gold=true（默认开，2026-10-04 用户裁决）/ entryMultiplier=10；
   * 余额缺省给 0（新用户口径）。
   * 要「关金币场 / 越门槛 / 读不到」的用例**显式**覆写 —— 夹具随手编值会掩盖
   * 「用的是不是真值」。
   */
  const configCache = makeConfigCache();
  const currency = {
    get: vi.fn(async (req: { ownerIds?: string[] }) => ({
      balances: (req?.ownerIds ?? []).map((ownerId) => ({ ownerId, balance: 0, exists: true })),
    })),
    apply: vi.fn(),
  };
  /**
   * 风控 T3：`room.match` 入队成功后的 `risk.deviceReport` 上报边（fire-and-forget）。
   * 替身只记调用 —— `RiskClient` 本体的传输契约由 `risk.client.test.ts` 覆盖。
   */
  const risk = { report: vi.fn() };
  /**
   * 昵称片：房间昵称缓存替身（缺省空映射 = 所有人类玩家「无昵称」，字段省略）。
   * 要「有昵称」的用例显式 `nicknames.ensure.mockResolvedValue(new Map([...]))`。
   */
  const nicknames = { ensure: vi.fn().mockResolvedValue(new Map<string, string>()) };
  const seatEvents: Array<{ roomCode: string; seats: Array<{ userId: string; seat: number }> }> = [];
  /** 昵称片 · 设计 D6：入座/离座后的 `room.state_update` 广播（路由只回调）。 */
  const roomStateEvents: Array<{
    roomCode: string;
    status: string;
    players: Array<Record<string, unknown>>;
    /** 多玩法（Task 2.2）：随回调带出的玩法/人数（WS 出站据此组装）。 */
    gameType?: string;
    playerCount?: number;
  }> = [];
  /** §6.6.1 的投递链路恢复：路由只回调，副作用由 gateway 完成。 */
  const reconnected: Array<{ socket: Socket; view: unknown }> = [];

  const deps: RouterDeps = {
    redis,
    rooms: rooms as unknown as RoomsService,
    roomStart: roomStart as unknown as RoomStartService,
    match: match as unknown as MatchService,
    reconnect: reconnect as unknown as ReconnectService,
    game: game as unknown as GameClient,
    // ② 金币场 T4：与生产同形 —— 快照缓存桩（种子值）+ 门槛读边替身。
    configCache: asConfigCache(configCache),
    currency: currency as unknown as CurrencyClient,
    // 风控 T3：deviceReport 上报边替身（缺省零调用）。
    risk: risk as unknown as RiskClient,
    // 昵称片：与生产同形（`WsGateway` 注入单例）；缺省空映射。
    nicknames: nicknames as unknown as RoomNicknamesService,
    logger: new Logger('test'),
    now: () => Date.now(),
    onSeatOwners: (roomCode, seats) => seatEvents.push({ roomCode, seats }),
    onRoomStateChanged: (roomCode, status, players, info) =>
      roomStateEvents.push({
        roomCode,
        status,
        players: players as unknown as Array<Record<string, unknown>>,
        ...(info === undefined ? {} : { gameType: info.gameType, playerCount: info.playerCount }),
      }),
    onReconnected: (socket, view) => {
      reconnected.push({ socket, view });
    },
    ...over,
  };
  return {
    deps,
    redis,
    match,
    rooms,
    roomStart,
    reconnect,
    game,
    configCache,
    currency,
    risk,
    nicknames,
    seatEvents,
    roomStateEvents,
    reconnected,
  };
}

/**
 * §6.2 的**线格式**：`type` 由事件名承载，`reqId`/`baseVersion`/`timestamp`
 * **平铺**在请求体里，请求体不重复 `type`。
 */
export const C = (type: string, payload: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  type,
  body: { reqId: 'req-1', baseVersion: 0, timestamp: Date.now(), payload, ...meta },
});

export async function route(deps: RouterDeps, socket: Socket, msg: { type: string; body: unknown }) {
  let captured: { code: number; data?: unknown; message?: string } | undefined;
  await routeClientMessage(socket, deps, msg.type, msg.body, (ack) => {
    captured = ack as typeof captured;
  });
  return captured!;
}

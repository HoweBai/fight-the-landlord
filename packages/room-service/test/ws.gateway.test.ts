import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger, type LogRecord } from '@fight-the-landlord/shared';
import type { Server, Socket } from 'socket.io';
import type { Redis } from 'ioredis';
import type { Ack, Card, PlayerView, RecordWriteRequest, SettlementResult } from '@fight-the-landlord/protocol';
import {
  GAME_EVENTS_CHANNEL,
  WsGateway,
  currentTurnPayload,
  type GameEvent,
} from '../src/gateway/ws.gateway';
import type { GameClient } from '../src/gateway/game.client';
import {
  RECONNECT_HASH_KEY,
  ReconnectService,
  type RecoverableRoom,
} from '../src/reconnect/reconnect.service';
import {
  MATCH_WAIT_PROMPT_MESSAGE,
  type MatchService,
} from '../src/match/match.service';

/** R696：`PlayerView.hand` 是 `Card[]`。本文件只关心张数与透传，故 `s` 取 0。 */
const asCards = (ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));
// ⚠️ 值导入：N31/R452 的用例要用**真实** `RoomsService` 读回 `room.status`
// （断言「替身的方法被调过」测不出状态机是否真的落地）。
import { RoomsService } from '../src/rooms/rooms.service';
import { nicknamesKey } from '../src/rooms/rooms.seats';
import { ONLINE_USERS_KEY } from '@fight-the-landlord/shared';
import { asRedis, createFakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';
import type { ConfigCacheService } from '../src/config/config-cache.service';
import { seatsOf } from './helpers/room-fixture';
import { metricValue } from './helpers/metric-readout';
import { gamesEndedTotal, wsConnections } from '../src/metrics/room.metrics';

/**
 * WsGateway 的单元测试（§6.3 / §4.4 / §6.6.1）。
 *
 * 旧用例锁定的是**已废除的旧契约**（应用层 ping/pong、`game.match.quick`、
 * `room.players_updated`、`reconnect_result`）。§6.3 的迁移映射表明确要求
 * 「不得继续下发旧名」，因此这些用例被**重写**而不是保留 —— 详见汇报。
 */

const mockRedis = {
  zadd: vi.fn().mockResolvedValue(1),
  zrem: vi.fn().mockResolvedValue(1),
  zscore: vi.fn().mockResolvedValue(null),
  zcard: vi.fn().mockResolvedValue(0),
  zremrangebyscore: vi.fn().mockResolvedValue(0),
  hset: vi.fn().mockResolvedValue(1),
  hget: vi.fn().mockResolvedValue(null),
  /**
   * 记录片 T5：`game.ended` 分支现在**顶部读一次** `room:{code}:bots`
   *（`hgetall`，供归池与记录组装共用）⇒ 窄替身必须补上这一格（缺了会被
   * `finalizeRoomEnd` 的 catch 吞成 error 日志 —— 同文件既有的教训：
   * 「路由新增一次调用，手写窄替身就缺一个方法」）。空键空间 ⇒ 无绑定。
   */
  hgetall: vi.fn().mockResolvedValue({}),
  hdel: vi.fn().mockResolvedValue(1),
  del: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
  set: vi.fn().mockResolvedValue('OK'),
  /**
   * ⚠️ 风控 T3：此前的默认是**恒 1**（当时 src 里没有消费点）。三处旗读
   * （`risk:limit` / `risk:banned` 走 `EXISTS`）落地后，恒 1 会把每条消息判成
   * 超档/封禁 ⇒ 缺省必须是「**无旗**」（真实 Redis 对不存在的键就是 0；
   * 需要「旗在」的用例显式覆写）。
   */
  exists: vi.fn().mockResolvedValue(0),
  subscribe: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  quit: vi.fn().mockResolvedValue(undefined),
} as unknown as Redis;

function makeSocket(over: { auth?: Record<string, unknown>; userId?: string } = {}): Socket & {
  emitted: Array<[string, unknown]>;
  joined: string[];
} {
  const emitted: Array<[string, unknown]> = [];
  const joined: string[] = [];
  const socket = {
    id: `sock-${Math.random().toString(36).slice(2, 8)}`,
    data: over.userId ? { userId: over.userId } : {},
    handshake: { auth: over.auth ?? {} },
    conn: { on: vi.fn() },
    emit: vi.fn((type: string, payload: unknown) => {
      emitted.push([type, payload]);
      return true;
    }),
    join: vi.fn(async (room: string) => {
      joined.push(room);
    }),
    leave: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    emitted,
    joined,
  };
  return socket as unknown as Socket & { emitted: Array<[string, unknown]>; joined: string[] };
}

type ReconnectMock = {
  /**
   * 本片（规格 v1.1 §2.2）：补推与 `game.reconnect` 等四处的**唯一**凭据读面 ——
   * 替身缺了它，连接建立时 `replayActiveGame` 会 TypeError（被 fail-open 吞成 WARN），
   * 路由侧则被 catch 压成 **13001**（看起来像被测代码坏了，实际是替身比接口窄）。
   */
  resolveRecoverableRoom: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
  clearConnection: ReturnType<typeof vi.fn>;
  /**
   * 本片 T2（规格 §2.3 配套 / F1）：`room.leave` 清理单闸的凭据读面 ——
   * ⚠️ 缺它 `getRecord is not a function` ⇒ 通用 catch ⇒ **13001**，
   * 既有全部 leave 用例会以完全无关的错误码整族红（「替身比接口窄」形态，本仓已复发的坑）。
   */
  getRecord: ReturnType<typeof vi.fn>;
};

function makeGateway(
  over: {
    game?: Partial<GameClient>;
    reconnect?: ReconnectService;
    redis?: Redis;
    /** 切片 11（R207）：归池客户端替身。 */
    robot?: { release: (botIds: string[]) => Promise<number> };
    /**
     * R452：可注入**真实** `RoomsService`（配 `createFakeRedis`），
     * 使「`game.ended` ⇒ `room.status === 'finished'`」成为一条真的落盘判据。
     */
    rooms?: RoomsService;
    /**
     * 本片（spec §3.3 / R902）：入座后房间满 ⇒ **同步**触发开局。
     * 替身只记调用；开局链本身由 `rooms.start.test.ts` 覆盖。
     */
    roomStart?: { startRoom: (...args: unknown[]) => Promise<boolean> };
    /**
     * 记录片 T5：`record.write` 客户端替身（默认 `write` 成功解析 `true`）。
     * 组装链的判据要么断言它的调用参数，要么断言 client 抛错时的解耦姿态。
     */
    record?: { write: (request: RecordWriteRequest) => Promise<boolean> };
    /**
     * ② 金币场 T4：`room.match` 的双开关读面（缺省 = `makeConfigCache()` 的**种子值**：
     * free=true / gold=true（2026-10-04 用户裁决默认开）/ entryMultiplier=10 —— 本文件的
     * 匹配用例走 random）。
     */
    configCache?: ConfigCacheService;
    /** ② 金币场 T4：门槛读边（缺省不返回值 —— 本文件不覆盖 `gold` 面）。 */
    currency?: { get: (...args: unknown[]) => Promise<unknown>; apply: (...args: unknown[]) => Promise<unknown> };
    /**
     * ② 金币场 T5：结算服务替身（缺省记录调用 + 接住 `bindBroadcast`）。
     * 结算服务本体由 `test/currency/` 覆盖；本文件只钉**挂点与入参透传**。
     */
    settle?: {
      settle: ReturnType<typeof vi.fn>;
      bindBroadcast: ReturnType<typeof vi.fn>;
    };
    /**
     * 风控 T3：`risk.deviceReport` 客户端替身（第 12 个构造参数；缺省 `report` 零调用）。
     * 传输层契约由 `test/risk.client.test.ts` 覆盖；本文件钉「routerDeps 真接线」。
     */
    risk?: { report: (userId: string, deviceId: string) => void };
    /** 昵称片：房间昵称缓存替身（第 13 个构造参数；缺省空映射）。 */
    nicknames?: { ensure: (...args: unknown[]) => Promise<Map<string, string>> };
  } = {},
): {
  gateway: WsGateway;
  match: {
    addToQueue: ReturnType<typeof vi.fn>;
    cancelQueue: ReturnType<typeof vi.fn>;
    readMeta: ReturnType<typeof vi.fn>;
  };
  reconnect: ReconnectMock;
  rooms: { findOne: ReturnType<typeof vi.fn> };
  game: Record<string, ReturnType<typeof vi.fn>>;
  serverEmit: ReturnType<typeof vi.fn>;
  settle: { settle: ReturnType<typeof vi.fn>; bindBroadcast: ReturnType<typeof vi.fn> };
} {
  const match = {
    addToQueue: vi.fn().mockResolvedValue(undefined),
    cancelQueue: vi.fn().mockResolvedValue(undefined),
    // R63：`handleMatch` 现在也要读 `match:meta` 判 12009；默认「meta 在」。
    // 注意这里**不是**「mock 上有个不存在的方法」也没关系 —— 缺了它 handleMatch 会抛，
    // 路由 catch 把它压成 13001，三条既有用例会以**完全无关的错误码**变红。
    readMeta: vi.fn().mockResolvedValue({
      playerId: 'user-1',
      mode: 'random',
      // 片规格 §2.4：ticket 带底分（`handleMatch` 用它定位玩家实际所在的队列键）
      baseScore: 15,
      region: 'global',
      enteredAt: Date.now(),
      latency: 0,
      attempts: 0,
    }),
    startMatchingLoop: vi.fn(),
  };
  const reconnect: ReconnectMock = {
    // 缺省「无凭据」= 补推静默（绝大多数连接的真实形态）—— 只有显式覆写的用例才产生补推。
    resolveRecoverableRoom: vi.fn().mockResolvedValue(null),
    touch: vi.fn().mockResolvedValue(null),
    clearConnection: vi.fn().mockResolvedValue(undefined),
    // 本片 T2（规格 §2.3 配套 / F1）：清理单闸的凭据读面 —— 缺省「无记录」（缺席清态）；
    // 要「存在且不一致」的用例显式覆写。
    getRecord: vi.fn().mockResolvedValue(null),
  };
  /**
   * `RoomsService` 替身。
   *
   * ⚠️ 本片实测的教训（**同一形态在本片出现三次**：match.service 的 `findOne`、
   * controller 的 `setFillDeadline`、这里）：路由新增一次 `rooms.xxx` 调用，
   * 手写窄替身就缺一个方法 ⇒ 抛错被 catch 压成 **13001**，既有用例以**完全无关的错误码**
   * 变红（看起来像被测代码坏了，其实是替身比接口窄）。
   * ⇒ 本片新增的两个方法（`leaveSeat` / `resetWaitingWindow`）在这里补上，默认无副作用。
   * ⚠️ **不要**改成 `new RoomsService(...)`：本文件的 `redis` 是**窄的**网关替身，
   * 不含房间哈希操作（实测：那样会让本文件所有用例一起红）。
   */
  const rooms = {
    findOne: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue({}),
    leaveSeat: vi.fn().mockResolvedValue(undefined),
    resetWaitingWindow: vi.fn().mockResolvedValue(undefined),
  };
  const game = {
    view: vi.fn().mockResolvedValue(null),
    snapshot: vi.fn().mockResolvedValue({ data: null }),
    action: vi.fn(),
    start: vi.fn(),
    // 挂机治理 T6（C22）：在局 `room.join` / `game.reconnect` 的 trustee-off 转发。
    // 替身缺这一格 ⇒ `trustee is not a function` ⇒ 路由 catch ⇒ 13001（替身比接口窄）。
    trustee: vi.fn().mockResolvedValue({ version: 6 }),
    ...(over.game ?? {}),
  };
  /**
   * ② 金币场 T5：结算服务替身。`bindBroadcast` **接住回调**（用例可以手动触发它来断言
   * `game.balances` 的 ws 层实现 —— 结算服务本体不在这里测）。
   */
  const settle: { settle: ReturnType<typeof vi.fn>; bindBroadcast: ReturnType<typeof vi.fn> } =
    over.settle ?? {
      settle: vi.fn().mockResolvedValue(undefined),
      bindBroadcast: vi.fn(),
    };
  const gateway = new WsGateway(
    over.redis ?? mockRedis,
    match as unknown as MatchService,
    (over.reconnect ?? reconnect) as unknown as ReconnectService,
    (over.rooms ?? rooms) as unknown as RoomsService,
    // 本片（spec §3.3 / R902）：第 5 个参数是开局链（入座满员时同步触发）
    (over.roomStart ?? { startRoom: vi.fn().mockResolvedValue(true) }) as never,
    game as unknown as GameClient,
    // 切片 11（R207）：第 6 个可选参数是归池客户端
    (over.robot ?? { release: vi.fn().mockResolvedValue(0) }) as never,
    // 记录片 T5：第 8 个参数是 user-service 记录客户端（缺则真容器启动即崩，
    // 由 `ws.module.wiring.test.ts` 的容器门禁钉住）
    (over.record ?? { write: vi.fn().mockResolvedValue(true) }) as never,
    // ② 金币场 T4：第 9/10 个参数 —— `room.match` 的双开关读面与门槛读边
    // （本文件的 room.match 用例走 `random` ⇒ 桩的种子值 `freeRoomEnabled=true`
    // 让它们原样绿；`gold` 面由 `message.router.test.ts` 的 router 分支钉）。
    over.configCache ?? asConfigCache(makeConfigCache()),
    (over.currency ?? { get: vi.fn(), apply: vi.fn() }) as never,
    // ② 金币场 T5：第 11 个参数 —— 结算服务（`finalizeRoomEnd` 的 :809 位调用 +
    // 构造期 `bindBroadcast`）。
    settle as never,
    // 风控 T3：第 12 个参数 —— `risk.deviceReport` 客户端（`room.match` 入队成功后
    // fire-and-forget 上报；经 `routerDeps()` 真接线，见「message routing」组的用例）。
    (over.risk ?? { report: vi.fn() }) as never,
    // 昵称片：第 13 个参数 —— 房间昵称缓存（缺省空映射 ⇒ 出站不带 nickname）。
    (over.nicknames ?? { ensure: vi.fn().mockResolvedValue(new Map()) }) as never,
  );
  const serverEmit = vi.fn();
  gateway.server = { to: vi.fn(() => ({ emit: serverEmit })) } as unknown as Server;
  return {
    gateway,
    match,
    reconnect,
    rooms,
    game: game as unknown as Record<string, ReturnType<typeof vi.fn>>,
    serverEmit,
    settle,
  };
}

/**
 * §6.2 的**线格式**：事件名承载 type，`reqId`/`baseVersion`/`timestamp` 平铺在
 * 请求体里。`handleMessage(socket, type, body)` 的两个参数分别对应这两者。
 */
const C = (type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  [type, { reqId: 'req-1', baseVersion: 1, timestamp: Date.now(), payload, ...extra }] as const;

const emit = (gw: WsGateway, sock: Socket, msg: readonly [string, unknown]): Promise<Ack> =>
  // `handleMessage` 的签名带 `| undefined`（`handle()` 在走网关 correlation
  // 回程时才可能不返回），但路由本身**总会** ack —— 测试里按 Ack 处理。
  gw.handleMessage(sock, msg[0], msg[1]) as Promise<Ack>;

describe('WsGateway authentication (§5.2)', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_TOKEN;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = ORIGINAL;
  });

  it('accepts a handshake carrying a valid internal token and writes socket.data.userId', () => {
    const { gateway } = makeGateway();
    const sock = makeSocket({ auth: { userId: 'user-1', internalToken: 'internal-secret' } });

    gateway.handleConnection(sock);

    expect(sock.data.userId).toBe('user-1');
    expect(gateway.activeConnections.get('user-1')).toBe(sock);
    expect(sock.disconnect).not.toHaveBeenCalled();
  });

  it('rejects a handshake with a wrong internal token', () => {
    const { gateway } = makeGateway();
    const sock = makeSocket({ auth: { userId: 'user-1', internalToken: 'nope' } });

    gateway.handleConnection(sock);

    expect(sock.data.userId).toBeUndefined();
    expect(sock.disconnect).toHaveBeenCalledWith(true);
  });

  it('rejects a handshake without any auth', () => {
    const { gateway } = makeGateway();
    const sock = makeSocket({});

    gateway.handleConnection(sock);

    expect(sock.disconnect).toHaveBeenCalledWith(true);
  });

  it('rejects a handshake that carries the internal token but no userId', () => {
    const { gateway } = makeGateway();
    const sock = makeSocket({ auth: { internalToken: 'internal-secret' } });

    gateway.handleConnection(sock);

    expect(sock.disconnect).toHaveBeenCalledWith(true);
  });

  /**
   * **风控 T3（规格 §2.9-1 / C12）**：握手读 `auth.clientIp`（网关下游握手注入的
   * 可信客户端 IP —— auth 由网关构造、客户端值不可达）→ `socket.data.clientIp`。
   * 形状校验：string、1..64、≠`'unknown'`；非法**丢弃**（不写该字段 = 谓词 fail-open 的读取面）。
   */
  it('风控 T3：合法 clientIp（含 64 位边界）⇒ 写 socket.data.clientIp', () => {
    const { gateway } = makeGateway();
    const sock = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', clientIp: '203.0.113.7' },
    });
    gateway.handleConnection(sock);
    expect(sock.data.clientIp).toBe('203.0.113.7');

    const boundary = makeSocket({
      auth: { userId: 'user-2', internalToken: 'internal-secret', clientIp: '1'.repeat(64) },
    });
    gateway.handleConnection(boundary);
    expect(boundary.data.clientIp).toBe('1'.repeat(64)); // 恰好 64 合法（65 拒 —— 见下）
  });

  it('风控 T3：`unknown` / 超长（65）/ 非 string / 空串 ⇒ 丢弃（不写该字段）', () => {
    for (const bad of ['unknown', 'x'.repeat(65), 42, ''] as const) {
      const { gateway } = makeGateway();
      const sock = makeSocket({
        auth: { userId: 'user-1', internalToken: 'internal-secret', clientIp: bad },
      });

      gateway.handleConnection(sock);

      expect(
        sock.data.clientIp,
        `clientIp = ${JSON.stringify(bad)} 必须被丢弃（不写 socket.data.clientIp）`,
      ).toBeUndefined();
    }
  });

  /**
   * R94：**fail-closed**，与 HTTP 侧（R89）逐字同义。
   *
   * 旧形状 `!auth.internalToken || (expected && auth.internalToken !== expected)` 在
   * `expected` 未配置时，第二个合取项恒为 `false` ⇒ **任意非空 `internalToken` 都通过**。
   * R89 让服务在未配置时根本起不来，所以线上够不着 —— 但形状自相矛盾，
   * 下一次重构就会把它变成真漏洞。
   */
  it('R94 fail-closed：未配置 INTERNAL_SERVICE_TOKEN 时，任意 internalToken 都必须被拒', () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const { gateway } = makeGateway();
    const sock = makeSocket({ auth: { userId: 'user-1', internalToken: 'anything-at-all' } });

    gateway.handleConnection(sock);

    expect(sock.data.userId).toBeUndefined();
    expect(gateway.activeConnections.has('user-1')).toBe(false);
    expect(sock.disconnect).toHaveBeenCalledWith(true);
  });

  it('forgets the connection on disconnect', () => {
    const { gateway } = makeGateway();
    const sock = makeSocket({ auth: { userId: 'user-1', internalToken: 'internal-secret' } });
    gateway.handleConnection(sock);

    gateway.handleDisconnect(sock);

    expect(gateway.activeConnections.has('user-1')).toBe(false);
  });
});

/**
 * **判据 14**（最终评审 I2）：**未插桩的载体不得伪装成「启动早期」**。
 *
 * WS 连接生命周期（连接 / 断开 / 迟到的断开 / 续期 / 拒握手）与 Redis 订阅两族
 * 原先落在**任何 `runWithTrace` 之外** ⇒ 被渲染成 `source: 'bootstrap'` ——
 * 而那个值的含义是「进程启动早期」（实际是某人连上/断了、或 Redis 来了一条消息）
 * ⇒ **假话**（R1107 明文禁止的伪装）。⚠️ 判据 11 的正则只覆盖五条定时消息 ⇒
 * 这两族此前**没有任何闸看得见**（这正是 I2 的立意）。
 *
 * 观测口与判据 6′ 同形：`Logger.overrideLogger` 装捕获 sink（Nest 的 logger 是进程级）。
 */
describe('判据 14（I2）：连接生命周期与内部事件的 source 必须如实', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_TOKEN;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = ORIGINAL;
    // M4（台账 T6-M1）：`Logger.overrideLogger` 是**进程级**的 —— 还原成默认形态，
    // 免得本块之后追加的用例静默写进这个已经死掉的 sink。
    Logger.overrideLogger(new Logger());
  });

  /** 装捕获 sink（返回记录数组）。 */
  const install = (): LogRecord[] => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
    return records;
  };

  /**
   * 本族的**共同判据**：该行必须存在（否则本条是空转），且**不得**被标成 `bootstrap`
   * —— 那是「进程启动早期」的含义，而这些行分别是「某人连上/断了」「Redis 来了消息」。
   */
  const expectHonest = (line: LogRecord | undefined, what: string): LogRecord => {
    expect(line, `${what}：这行必须在（否则判据空转）`).toBeDefined();
    expect(line!.source, `${what}：不得标成 bootstrap（含义是"启动早期"= 假话）`).not.toBe(
      'bootstrap',
    );
    return line!;
  };

  const findMessage = (records: LogRecord[], prefix: string): LogRecord | undefined =>
    records.find((r) => r.msg.startsWith(prefix));

  it('连接建立：`Client connected` 标 edge 且带**该连接**的 id（= 握手 auth.traceId）', async () => {
    const records = install();
    const { gateway } = makeGateway();
    const sock = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-1' },
    });

    await gateway.handleConnection(sock);

    const line = expectHonest(findMessage(records, 'Client connected'), 'Client connected');
    expect(line.source).toBe('edge');
    expect(line.traceId).toBe('CONN-1');
  });

  it('拒握手：标 edge + traceId null（拿不到 id 就不编造，且**不采信客户端塞的值**）', async () => {
    const records = install();
    const { gateway } = makeGateway();
    // ⚠️ 故意塞一个**手机号形状**的 `auth.traceId`：拒握手路径**不得**采信它 ——
    // `traceId` 不过脱敏器（它被假定为我们生成的 uuid）⇒ 采信等于把 I1 的洞换个字段
    // 再开一次（客户端拿它就能打红判据 8 的采样）。
    const sock = makeSocket({
      auth: { userId: 'user-1', internalToken: 'wrong-token', traceId: '13912345678' },
    });

    await gateway.handleConnection(sock);

    const line = expectHonest(
      findMessage(records, 'Rejecting unauthenticated socket'),
      'Rejecting unauthenticated socket',
    );
    expect(line.source).toBe('edge');
    expect(line.traceId).toBeNull();
  });

  it('连接断开：`Client disconnected` 标 edge 且带**同一个**连接级 id', async () => {
    const records = install();
    const { gateway } = makeGateway();
    const sock = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-2' },
    });
    await gateway.handleConnection(sock);

    await gateway.handleDisconnect(sock);

    const line = expectHonest(findMessage(records, 'Client disconnected'), 'Client disconnected');
    expect(line.source).toBe('edge');
    expect(line.traceId).toBe('CONN-2');
  });

  it('迟到的断开：`Ignoring stale disconnect` 标 edge 且带**旧连接**的 id', async () => {
    const records = install();
    const { gateway } = makeGateway();
    const first = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-A' },
    });
    await gateway.handleConnection(first);
    // 硬中断换链路（§6.6.1 时机 4）：新连接建立 ⇒ activeConnections 指向新连接
    const second = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-B' },
    });
    await gateway.handleConnection(second);

    await gateway.handleDisconnect(first);

    const line = expectHonest(
      findMessage(records, 'Ignoring stale disconnect'),
      'Ignoring stale disconnect',
    );
    expect(line.source).toBe('edge');
    expect(line.traceId).toBe('CONN-A');
  });

  it('续期：`Reconnect record refreshed` 标 edge 且带该连接的 id（从 disconnect 起算的那条）', async () => {
    const records = install();
    const { gateway } = makeGateway({
      reconnect: {
        // 本片：补推在连接建立时先读 resolver —— 替身补上它（缺省 null ⇒ 静默），
        // 免得一条无关的 fail-open WARN 混进本条的日志断言面。
        resolveRecoverableRoom: vi.fn().mockResolvedValue(null),
        touch: vi.fn().mockResolvedValue({ roomCode: 'ROOM1', connectedAt: 123 }),
        clearConnection: vi.fn().mockResolvedValue(undefined),
      } as unknown as ReconnectService,
    });
    const sock = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-3' },
    });
    await gateway.handleConnection(sock);

    await gateway.handleDisconnect(sock);

    const line = expectHonest(
      findMessage(records, 'Reconnect record refreshed'),
      'Reconnect record refreshed',
    );
    expect(line.source).toBe('edge');
    expect(line.traceId).toBe('CONN-3');
  });

  it('Redis 订阅：`Invalid game event from Redis` 标 internal + traceId null（内部事件，不编造）', async () => {
    const records = install();
    const { gateway } = makeGateway();
    // 订阅连接是构造函数里 `new Redis(...)` 建的 ⇒ 只把两个方法换成 spy，不碰网络。
    const sub = (gateway as unknown as { gameEventsRedis: Redis }).gameEventsRedis;
    const onSpy = vi.spyOn(sub, 'on');
    vi.spyOn(sub, 'subscribe').mockResolvedValue(undefined as never);

    await gateway.subscribeToGameEvents();

    const handler = onSpy.mock.calls.find(([event]) => event === 'message')?.[1] as
      | ((channel: string, raw: string) => void)
      | undefined;
    expect(handler, '订阅必须注册一条 message 处理器（否则本条空转）').toBeDefined();
    handler!(GAME_EVENTS_CHANNEL, '{ this is not json');

    const line = expectHonest(
      findMessage(records, 'Invalid game event from Redis'),
      'Invalid game event from Redis',
    );
    expect(line.source).toBe('internal');
    expect(line.traceId).toBeNull();
  });
});

/**
 * **② 连接补推**（片⑦ 修复 · slice12-race-fix-design §1；本片泛化为 resolver 存活候选，
 * 规格 v1.1 §2.4）：连接建立时把迟到者拉回**仍在进行**的对局/等待中的房间 ——
 * `waiting` ⇒ 只补 `room.matched`（seat 来自 `room.players`）；`playing` ⇒ **先补视图
 * （`game.deal`）再补 `room.matched`**（顺序不可反，见实现注释）；`finished`/`cancelled`/
 * 不在册/结束瞬间竞态 ⇒ 静默；失败方向 fail-open + WARN（连接本身不受影响）。
 *
 * 🔴 驱动全在**替身**上（`resolveRecoverableRoom` 命中值 + `rooms.findOne` 座位表）——
 * 命中判定本身（存活优先 / 存在性回退）由 `reconnect.service.test.ts`（T1）覆盖，
 * 本块只钉**消费侧**的推/不推与顺序。
 */
describe('片⑦ 修复（slice-12 竞态）：连接建立时的匹配补推', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_TOKEN;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = ORIGINAL;
    // M4：`Logger.overrideLogger` 是进程级的 —— 用后还原，防后续用例静默写进死 sink。
    Logger.overrideLogger(new Logger());
  });

  /** 「迟到者」在册的权威座位表（补推座位守卫的数据源；user-1 在 seat 0）。 */
  const roomInfo = {
    code: 'ROOM1',
    mode: 'random',
    players: seatsOf('user-1', 'user-2'),
    maxPlayers: 3,
    status: 'waiting' as const,
    baseScore: 100,
    createdAt: Date.now(),
  };

  /**
   * 造一份「迟到者」的连接语境：**先驱动替身、后连接**（连接建立时会即时消费 resolver
   * 与座位表）——`resolved` 即 resolver 的命中值（`null` = 无凭据）。
   */
  async function lateComer(
    resolved: RecoverableRoom | null,
    over: Parameters<typeof makeGateway>[0] = {},
  ) {
    const ctx = makeGateway(over);
    ctx.reconnect.resolveRecoverableRoom.mockResolvedValue(resolved);
    ctx.rooms.findOne.mockResolvedValue(roomInfo);
    const sock = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-RACE' },
    });
    await ctx.gateway.handleConnection(sock);
    return { ctx, sock };
  }

  it('命中 + 房态 waiting ⇒ **只**补 room.matched（seat 来自 room.players），不 fetch 视图', async () => {
    const { ctx, sock } = await lateComer({ roomCode: 'ROOM1', source: 'ticket', status: 'waiting' });

    expect(sock.emitted).toEqual([
      ['room.matched', { version: 0, payload: { roomCode: 'ROOM1', seat: 0 } }],
    ]);
    expect(ctx.gateway.seatOwners.get('ROOM1:0')).toBe('user-1');
    expect(ctx.game.view, 'waiting 只有一个来源：matched（视图要 playing 才有）').not.toHaveBeenCalled();
  });

  it('补推 room.matched 携带 gameType/playerCount（多玩法 Task 2.2 / spec §4.6.2）', async () => {
    const ctx = makeGateway();
    ctx.reconnect.resolveRecoverableRoom.mockResolvedValue({
      roomCode: 'ROOM1',
      source: 'ticket',
      status: 'waiting',
    });
    ctx.rooms.findOne.mockResolvedValue({ ...roomInfo, gameType: 'paodekuai' });
    const sock = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret' },
    });

    await ctx.gateway.handleConnection(sock);

    expect(sock.emitted).toEqual([
      [
        'room.matched',
        {
          version: 0,
          payload: { roomCode: 'ROOM1', seat: 0, gameType: 'paodekuai', playerCount: 3 },
        },
      ],
    ]);
  });

  it('命中 + 房态 playing ⇒ **先 game.deal（version 对）、后 room.matched**，seat 用 view.seat', async () => {
    const view = { roomCode: 'ROOM1', seat: 1, state: 'playing', version: 7 };
    const { ctx, sock } = await lateComer(
      { roomCode: 'ROOM1', source: 'ticket', status: 'playing' },
      { game: { view: vi.fn().mockResolvedValue(view) } },
    );

    expect(ctx.game.view).toHaveBeenCalledWith('ROOM1', 'user-1');
    // ⚠️ 顺序不可反（v2.1）：反了的话 fetch 窗口内的实时更新（v5）先到、旧视图（v4）后到
    // ⇒ 客户端假回退（M08）。这里同时钉住「deal 的 version 来自 view 自己」与
    // 「matched/seatOwners 的 seat 用 view.seat（1）而不是 room.players 的 0）」。
    expect(sock.emitted).toEqual([
      ['game.deal', { version: 7, payload: view }],
      ['room.matched', { version: 0, payload: { roomCode: 'ROOM1', seat: 1 } }],
    ]);
    expect(ctx.gateway.seatOwners.get('ROOM1:1')).toBe('user-1');
  });

  it('无凭据（resolver null）⇒ 不推（绝大多数连接如此：零消息 + 零日志噪声）', async () => {
    const records = installSink();
    const { ctx, sock } = await lateComer(null); // null = 该玩家没有任何存活候选

    expect(ctx.gateway.activeConnections.get('user-1'), '连接本身必须照常建立').toBe(sock);
    expect(sock.emitted).toEqual([]);
    // 读取面与命中判定的调用次数由 T1（`reconnect.service.test.ts`）覆盖 —— resolver 替身下
    // 在这里数 `hget` 次数既无判别力也必红，故删；这里只钉**该面产出 null 时的静默性**：
    // 这条路径是绝大多数连接的真实形态，一条消息、一行补推日志都不该产生。
    const noise = records.filter(
      (r) => r.msg.startsWith('Match hand-off replay') || r.msg.startsWith('Game resumption pushed'),
    );
    expect(noise, '无凭据 ⇒ 不推、不 WARN、不写成功行').toEqual([]);
  });

  it('resolver 返回 finished / cancelled ⇒ 不推（第二遍的已死候选必须静默）', async () => {
    for (const status of ['finished', 'cancelled']) {
      const { ctx, sock } = await lateComer({ roomCode: 'ROOM1', source: 'record', status });
      expect(ctx.gateway.activeConnections.get('user-1'), '连接本身必须照常建立').toBe(sock);
      expect(sock.emitted, `房态 ${status} 不得补推`).toEqual([]);
    }
  });

  it('playing 但视图拿不到（null）⇒ WARN + **只**补 matched（fail-open，seat 回落 room.players）', async () => {
    const records = installSink();
    const { sock } = await lateComer(
      { roomCode: 'ROOM1', source: 'ticket', status: 'playing' },
      { game: { view: vi.fn().mockResolvedValue(null) } },
    );

    expect(sock.emitted).toEqual([
      ['room.matched', { version: 0, payload: { roomCode: 'ROOM1', seat: 0 } }],
    ]);
    const warn = records.find((r) => r.msg.startsWith('Match hand-off replay'));
    expect(warn, '视图补发失败必须 WARN（不许静默）').toBeDefined();
  });

  it('resolver 读失败（Redis 抖动）⇒ WARN（source=edge、traceId=该连接）且**不得**把连接带崩（裁决 C）', async () => {
    const records = installSink();
    const { ctx } = await lateComer({ roomCode: 'ROOM1', source: 'ticket', status: 'waiting' });
    // 已连上之后单独构造：重连（同一 userId 的新 socket）时 resolver 这一发失败
    ctx.reconnect.resolveRecoverableRoom.mockRejectedValueOnce(new Error('redis down'));
    const second = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-RACE-2' },
    });

    await expect(ctx.gateway.handleConnection(second)).resolves.toBeUndefined();

    expect(second.emitted).toEqual([]);
    expect(second.disconnect, '读失败不得断连接（fail-open）').not.toHaveBeenCalled();
    expect(ctx.gateway.activeConnections.get('user-1')).toBe(second);
    const warn = records.find((r) => r.msg.startsWith('Match hand-off replay failed'));
    expect(warn, '读失败必须 WARN').toBeDefined();
    // 内层 ALS：traceId=**该连接**、source=edge（R1107：来源如实）
    expect(warn!.source).toBe('edge');
    expect(warn!.traceId).toBe('CONN-RACE-2');
  });

  it('硬中断换链路（上一连接从未断开）⇒ 补推与续期**都**发生（两分支共用，Important 4）', async () => {
    const { ctx, sock: first } = await lateComer({ roomCode: 'ROOM1', source: 'ticket', status: 'waiting' });
    const second = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-RACE-2' },
    });

    await ctx.gateway.handleConnection(second);

    // 补推对**新**连接发生；第一个连接只拿到它自己那次连接的补推（不被重复推）
    expect(first.emitted).toHaveLength(1);
    expect(second.emitted).toEqual([
      ['room.matched', { version: 0, payload: { roomCode: 'ROOM1', seat: 0 } }],
    ]);
    expect(ctx.reconnect.touch, '早返回之前的续期分支必须仍然走到').toHaveBeenCalled();
  });

  it('查询期间被更新的连接顶替 ⇒ 跳过，不给陈旧 socket 推', async () => {
    const ctx = makeGateway();
    ctx.rooms.findOne.mockResolvedValue(roomInfo);
    const other = makeSocket({ userId: 'user-1' });
    // resolver 读凭据「返回」时才把 activeConnections 指到别的 socket —— 模拟查询期间顶替
    ctx.reconnect.resolveRecoverableRoom.mockImplementationOnce(async () => {
      ctx.gateway.activeConnections.set('user-1', other);
      return { roomCode: 'ROOM1', source: 'ticket', status: 'waiting' };
    });
    const sock = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-STALE' },
    });

    await ctx.gateway.handleConnection(sock);

    expect(sock.emitted).toEqual([]);
  });

  it('record 源（票不存在、哈希存活）⇒ 仍补推（长离线/二次刷新场景）', async () => {
    const records = installSink();
    const view = { roomCode: 'ROOM1', seat: 1, state: 'playing', version: 9 };
    const { ctx, sock } = await lateComer(
      { roomCode: 'ROOM1', source: 'record', status: 'playing' },
      { game: { view: vi.fn().mockResolvedValue(view) } },
    );

    // 命中源不影响推送形态：先 game.deal、后 room.matched，seat 重登记在 view.seat
    expect(sock.emitted).toEqual([
      ['game.deal', { version: 9, payload: view }],
      ['room.matched', { version: 0, payload: { roomCode: 'ROOM1', seat: 1 } }],
    ]);
    expect(ctx.gateway.seatOwners.get('ROOM1:1')).toBe('user-1');
    const line = records.find((r) => r.msg.startsWith('Game resumption pushed for'));
    expect(line, '成功补推必须留一行（含来源）').toBeDefined();
    expect(line!.msg).toContain('source=record');
  });

  it("结束瞬间竞态（房态 playing + view.state==='ended'）⇒ 两支都不推", async () => {
    const view = { roomCode: 'ROOM1', seat: 1, state: 'ended', version: 12 };
    const { sock } = await lateComer(
      { roomCode: 'ROOM1', source: 'ticket', status: 'playing' },
      { game: { view: vi.fn().mockResolvedValue(view) } },
    );

    expect(sock.emitted, '视同结束 ⇒ deal 与 matched 都不推（静默，无 WARN）').toEqual([]);
  });

  it('玩家不在权威座位表（rooms.findOne 不含该人）⇒ 跳过', async () => {
    const ctx = makeGateway();
    ctx.reconnect.resolveRecoverableRoom.mockResolvedValue({
      roomCode: 'ROOM1',
      source: 'record',
      status: 'playing',
    });
    ctx.rooms.findOne.mockResolvedValue({ ...roomInfo, players: seatsOf('someone-else') });
    const sock = makeSocket({
      auth: { userId: 'user-1', internalToken: 'internal-secret', traceId: 'CONN-NOSEAT' },
    });

    await ctx.gateway.handleConnection(sock);

    // 解析不出座位 ⇒ 两支都不推（推了 room.matched 会把客户端引向 12004）
    expect(sock.emitted).toEqual([]);
    expect(ctx.game.view, '守卫在视图之前：不在册连视图都不该去取').not.toHaveBeenCalled();
  });

  it('日志行逐字：Game resumption pushed for …（含 status/source）', async () => {
    const records = installSink();
    const view = { roomCode: 'ROOM1', seat: 1, state: 'playing', version: 9 };
    await lateComer(
      { roomCode: 'ROOM1', source: 'ticket', status: 'playing' },
      { game: { view: vi.fn().mockResolvedValue(view) } },
    );

    const line = records.find((r) => r.msg.startsWith('Game resumption pushed for'));
    expect(line, '成功行必须在（否则本条空转）').toBeDefined();
    expect(line!.msg).toBe(
      'Game resumption pushed for user-1 → ROOM1@1 (status=playing, source=ticket)',
    );
    expect(line!.source, '补推在连接 ALS 内 ⇒ source=edge（来源如实）').toBe('edge');
  });
});

/** 装捕获 sink（与「判据 14」describe 同形；返回记录数组）。 */
function installSink(): LogRecord[] {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
  return records;
}

describe('WsGateway message routing (ack carries the response, §6.2)', () => {
  let ctx: ReturnType<typeof makeGateway>;

  const connected = () => {
    const sock = makeSocket({ auth: { userId: 'user-1', internalToken: 'internal-secret' } });
    ctx.gateway.handleConnection(sock);
    return sock;
  };

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    vi.clearAllMocks();
    ctx = makeGateway();
  });

  it('relays the ack back under the gateway correlation event name', async () => {
    // 经网关代理时，ack 必须以「事件名 = correlation id」的形式回发，
    // 否则 socket.io 的 ack 回调会被代理的 socket.io-client 吃掉，客户端永远等不到 ack。
    const sock = connected();
    const [type, body] = C('room.match', { mode: 'random', baseScore: 15 }, { __ackId: 'corr-42' });
    const returned = await ctx.gateway['handle'](sock, type, body);

    expect(returned).toBeUndefined();
    const relayed = sock.emitted.find(([ev]) => ev === 'corr-42');
    expect(relayed).toBeDefined();
    expect((relayed![1] as { code: number }).code).toBe(0);
    // 风控 T3：末位 = extras（本请求无 clientIp / deviceId ⇒ 空对象）
    expect(ctx.match.addToQueue).toHaveBeenCalledWith('user-1', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
  });

  it('answers room.match with code 0 and queues the player', async () => {
    const sock = connected();
    const ack = await emit(ctx.gateway, sock, C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(0);
    expect(ctx.match.addToQueue).toHaveBeenCalledWith('user-1', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
  });

  /**
   * 风控 T3（规格 §2.8 发送侧 / C8）：`routerDeps()` **真的**把注入的 `RiskClient`
   * 接进路由 —— `room.match` 带 deviceId ⇒ `report` 恰一次。
   * （缺这行接线时单测全绿而生产静默不上报 —— 同族教训：装配面必须被消费方判据钉住。）
   */
  it('风控 T3：room.match 带 deviceId ⇒ 注入的 RiskClient.report 恰一次（routerDeps 真接线）', async () => {
    const risk = { report: vi.fn() };
    const local = makeGateway({ risk });
    const sock = makeSocket({ auth: { userId: 'user-1', internalToken: 'internal-secret' } });
    await local.gateway.handleConnection(sock);

    const ack = await emit(
      local.gateway,
      sock,
      C('room.match', { mode: 'random', baseScore: 15, deviceId: 'dev-abc123' }),
    );

    expect(ack.code).toBe(0);
    expect(risk.report).toHaveBeenCalledTimes(1);
    expect(risk.report).toHaveBeenCalledWith('user-1', 'dev-abc123');
  });

  it('answers 12009 when the player is already queued', async () => {
    (mockRedis.zscore as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(123);
    const sock = connected();
    const ack = await emit(ctx.gateway, sock, C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(12009);
    expect(ctx.match.addToQueue).not.toHaveBeenCalled();
  });

  it('rejects a message from an unauthenticated socket with 10002', async () => {
    const sock = makeSocket({});
    const ack = await emit(ctx.gateway, sock, C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(10002);
    expect(ctx.match.addToQueue).not.toHaveBeenCalled();
  });

  it('rejects a message type that is not in the contract with 10001', async () => {
    const sock = connected();
    const ack = await emit(ctx.gateway, sock, C('game.match.quick', {}));

    expect(ack.code).toBe(10001);
  });

  it('rejects an obsolete application-layer ping (no ping/pong events, §6.3)', async () => {
    const sock = connected();
    const ack = await emit(ctx.gateway, sock, C('ping', {}));

    expect(ack.code).toBe(10001);
    expect(sock.emitted.some(([type]) => type === 'pong')).toBe(false);
  });

  it('rejects a missing envelope with 10001', async () => {
    const sock = connected();
    // ⚠️ 走 `emit` 而不是直接 `handleMessage`：后者的签名是 `Promise<Ack | undefined>`
    // （见 `emit` 上方注释），直接取 `.code` 会被类型闸判成 TS18048。
    const ack = await emit(ctx.gateway, sock, C('room.match', { payload: {} }));

    expect(ack.code).toBe(10001);
  });

  it('rejects a client timestamp skew beyond 5s (M01) with 13001', async () => {
    const sock = connected();
    const ack = await emit(ctx.gateway, sock, C('room.match', { mode: 'random', baseScore: 15 }, { timestamp: Date.now() - 60_000 }));

    expect(ack.code).toBe(13001);
  });

  it('uses the handshake identity, never a payload-supplied identity (§5.2)', async () => {
    const sock = makeSocket({ auth: { userId: 'user-1', internalToken: 'internal-secret' } });
    // ⚠️ 先 `await` 连接完成（片⑦ 修复起 `handleConnection` 内有一步连接补推，会先调一次
    // resolver）—— 不 await 的话它会抢在下面的一次性应答之前消费掉它。
    await ctx.gateway.handleConnection(sock);
    // 本片（规格 v1.1 §2.3）：判定顺序第 1 步由 resolver 全权承载（路由不再直读哈希）——
    // 让 resolver 对 user-1 命中，若身份被载荷里的 `userId: 'victim'` 顶替会立刻显形。
    ctx.reconnect.resolveRecoverableRoom.mockResolvedValueOnce({
      roomCode: 'ROOM1',
      source: 'record',
      status: 'waiting',
    });
    // ⚠️ R471（§5.3⑦）：载荷里的 `playerId` 现在是**一致性校验**（不符 ⇒ 12003），
    //    因此「载荷身份不被采信」这条性质改由 `userId` 表达 —— 它仍然被**完全忽略**。
    await emit(ctx.gateway, sock, C('game.reconnect', { userId: 'victim' }));

    expect(ctx.reconnect.resolveRecoverableRoom).toHaveBeenCalledWith('user-1');
    expect(ctx.reconnect.resolveRecoverableRoom).not.toHaveBeenCalledWith('victim');
  });

  it('answers room.join with the trimmed player list', async () => {
    ctx.rooms.findOne.mockResolvedValue({
      code: 'ROOM1',
      mode: 'random',
      players: seatsOf('user-1', 'user-2'),
      maxPlayers: 3,
      status: 'waiting',
      baseScore: 100,
      createdAt: Date.now(),
    });
    const sock = connected();
    const ack = await emit(ctx.gateway, sock, C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(ack.data).toMatchObject({ roomCode: 'ROOM1', seat: 0 });
    const players = (ack.data as { players: Array<Record<string, unknown>> }).players;
    expect(players).toEqual([
      { id: 'user-1', seat: 0 },
      { id: 'user-2', seat: 1 },
    ]);
    // §6.4 规则 3：room.state_update 的载荷绝不含 isRobot
    expect(JSON.stringify(players)).not.toContain('isRobot');
  });

  it('answers 12004 when joining a room the caller is not part of', async () => {
    ctx.rooms.findOne.mockResolvedValue({
      code: 'ROOM9',
      mode: 'random',
      players: seatsOf('someone-else'),
      maxPlayers: 3,
      status: 'waiting',
      baseScore: 100,
      createdAt: Date.now(),
    });
    const sock = connected();
    const ack = await emit(ctx.gateway, sock, C('room.join', { roomCode: 'ROOM9' }));

    expect(ack.code).toBe(12004);
  });

  it('answers 12001 when the room does not exist', async () => {
    ctx.rooms.findOne.mockResolvedValue(null);
    const sock = connected();
    const ack = await emit(ctx.gateway, sock, C('room.join', { roomCode: 'NOPE' }));

    expect(ack.code).toBe(12001);
  });

  it('answers 13010 when there is no reconnect record', async () => {
    const sock = connected();
    const ack = await emit(ctx.gateway, sock, C('game.reconnect', { lastVersion: 3 }));

    expect(ack.code).toBe(13010);
  });
});

/**
 * 本片（规格 §2.4 / C7-C8）：`room.leave` 清理单闸的**投递侧** ——
 * `onSeatLeft` 删除 `seatOwners` 中该玩家在**该房**（`key.startsWith(roomCode + ':')`）
 * 的登记，于是「离开后旧局 per-seat 推送」不得到达。
 *
 * 🔴 判据形态：C8 不是断言回调被调过（那是替身的行为），而是注入 `game` 事件、
 * 断言**未 emit** —— 且带 leave 前的**正对照**（同形状事件照常到达），否则「未到达」
 * 可能只是事件/夹具本身到不了（空转）。
 */
describe('本片：room.leave ⇒ onSeatLeft 实清与旧局推送断流（C7/C8）', () => {
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    vi.clearAllMocks();
  });

  /** 一条按座位裁剪的 `game.state_updated` 视图（只需要 onGameEvent 读到的字段）。 */
  const seatView = (version: number): PlayerView => ({
    roomCode: 'ROOM1',
    version,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: [],
    cardCounts: [1, 2, 3],
    // 挂机治理 T2/T6：`PlayerView` 新增按座位三元组（与 `cardCounts` 同族）。
    trustees: [false, false, false],
    bottomCards: null,
    landlordSeat: null,
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: Date.now() + 30_000,
    bidPhase: { currentBidder: 0, bidMultiplier: 1, landlordCandidate: -1, grabActions: 0, redealCount: 0, kind: 'call', decisions: [] },
    playPhase: { bombCount: 0 },
  });

  async function connectUser(ctx: ReturnType<typeof makeGateway>, userId = 'user-1') {
    const sock = makeSocket({ auth: { userId, internalToken: 'internal-secret' } });
    await ctx.gateway.handleConnection(sock);
    return sock;
  }

  it('C7 实清：leave 删掉该玩家在**该房**的座位登记；同房他人座、他房同人座不受影响', async () => {
    const ctx = makeGateway();
    const sock = await connectUser(ctx);
    // 前置：三类登记都要在册（本房本座 / 本房他人座 / 他房同人座）
    ctx.gateway.seatOwners.set('ROOM1:0', 'user-1');
    ctx.gateway.seatOwners.set('ROOM1:1', 'user-2');
    ctx.gateway.seatOwners.set('ROOM2:0', 'user-1');

    const ack = await emit(ctx.gateway, sock, C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    // 实清来自本片在 `routerDeps()` 注册的回调（getRecord 缺省 null ⇒ 单闸缺席清态 ⇒ 回调必达）
    expect(ctx.reconnect.clearConnection).toHaveBeenCalledWith('user-1');
    expect(ctx.gateway.seatOwners.has('ROOM1:0'), 'leave ⇒ 该房自己的座位登记必须删除').toBe(false);
    expect(ctx.gateway.seatOwners.get('ROOM1:1'), '同房他人的登记不得误删').toBe('user-2');
    expect(ctx.gateway.seatOwners.get('ROOM2:0'), '他房同人的登记不得误删（前缀必须含房号）').toBe('user-1');
  });

  it('C8：leave 后旧局 per-seat 推送不得到达（正对照：leave 前同形状事件照常到达）', async () => {
    const ctx = makeGateway();
    const sock = await connectUser(ctx);
    ctx.gateway.seatOwners.set('ROOM1:0', 'user-1');

    // 正对照：leave **之前**，同形状的 game.state_updated 按座位投递到达 ——
    // 证明下面的「未到达」不是因为事件/夹具本身到不了（否则那条断言是空转）。
    ctx.gateway.onGameEvent({
      event: 'game.state_updated',
      roomCode: 'ROOM1',
      version: 6,
      seatViews: [seatView(6)],
    });
    expect(sock.emitted.some(([type]) => type === 'game.state_update')).toBe(true);

    const ack = await emit(ctx.gateway, sock, C('room.leave', { roomCode: 'ROOM1' }));
    expect(ack.code).toBe(0);
    const emittedBefore = sock.emitted.length;

    // 旧局（玩家已离开）继续推 version 7 的座位视图 ⇒ 不得到达（登记已实清）
    ctx.gateway.onGameEvent({
      event: 'game.state_updated',
      roomCode: 'ROOM1',
      version: 7,
      seatViews: [seatView(7)],
    });

    expect(
      sock.emitted.length,
      'leave 后旧局 per-seat 推送必须断流（onSeatLeft 实清的作用面）',
    ).toBe(emittedBefore);
  });

  it('C7 负对照：leave 的房号与座位登记无关（不一致单闸）时登记保留 —— 由 message.router 三态钉，这里只钉随实清达成', async () => {
    // 本用例的判别对象是「实清与清理闸同生共死」：getRecord 返回**不一致**记录 ⇒
    // 清理单闸全不做 ⇒ 座位登记同样保留（leave 只是 socket.leave）。
    const ctx = makeGateway();
    ctx.reconnect.getRecord.mockResolvedValue({ socketId: 's', roomCode: 'ROOM2', connectedAt: 0 });
    const sock = await connectUser(ctx);
    ctx.gateway.seatOwners.set('ROOM1:0', 'user-1');

    const ack = await emit(ctx.gateway, sock, C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(ctx.reconnect.clearConnection).not.toHaveBeenCalled();
    expect(ctx.gateway.seatOwners.get('ROOM1:0'), '不一致 ⇒ 登记保留（实清挂在单闸内）').toBe('user-1');
  });
});

describe('WsGateway 在线观测点刷新与投递链路恢复（规格 v1.1 §2.1/§2.4）', () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let reconnect: ReconnectService;

  /**
   * 真实 `ReconnectService` + 内存 Redis（**不注时钟** —— 时钟注入已随窗口退役；
   * 时间确定性改由本 describe 的假时钟承载）：断言的是**记录本身**。
   */
  const realReconnect = () => {
    redis = createFakeRedis();
    reconnect = new ReconnectService(asRedis(redis));
    return reconnect;
  };

  const roomInfo = {
    code: 'ROOM1',
    mode: 'random',
    players: seatsOf('user-1', 'user-2'),
    maxPlayers: 3,
    status: 'waiting' as const,
    baseScore: 100,
    createdAt: Date.now(),
  };

  const stored = async (playerId: string) =>
    JSON.parse((await redis.hget(RECONNECT_HASH_KEY, playerId))!) as {
      socketId: string;
      roomCode: string;
      connectedAt: number;
    };

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connect(ctx: ReturnType<typeof makeGateway>, userId = 'user-1') {
    const sock = makeSocket({ auth: { userId, internalToken: 'internal-secret' } });
    await ctx.gateway.handleConnection(sock);
    return sock;
  }

  it('room.join 写记录、服务端观测到 disconnect 时刷新 connectedAt（观测点语义）', async () => {
    const ctx = makeGateway({ reconnect: realReconnect(), redis: asRedis(redis) });
    ctx.rooms.findOne.mockResolvedValue(roomInfo);

    const sock = await connect(ctx);
    await emit(ctx.gateway, sock, C('room.join', { roomCode: 'ROOM1' }));

    const afterJoin = await stored('user-1');
    expect(afterJoin.connectedAt).toBe(1_700_000_000_000);
    expect(afterJoin.roomCode).toBe('ROOM1');
    // §10.1：哈希本身不设 TTL（TTL 列是 `—`）；独立键已退役，不再有任何 TTL 写入。
    expect(await redis.ttl(RECONNECT_HASH_KEY)).toBe(-1);

    // 一局打了 40 秒后才断线 —— 窗口时代的「从 room.join 起算」在这里会判过期；
    // 现在的语义是：断线即刷新在线观测点，记录本身从不因时间过期。
    vi.setSystemTime(Date.now() + 40_000);
    await ctx.gateway.handleDisconnect(sock);

    const afterDisconnect = await stored('user-1');
    expect(afterDisconnect.connectedAt).toBe(Date.now()); // 观测点刷新为断线时刻
  });

  it('未断线期间 connectedAt 不推进；断线即刷新；记录存在 = 可恢复（无过期判定）', async () => {
    const ctx = makeGateway({ reconnect: realReconnect(), redis: asRedis(redis) });
    ctx.rooms.findOne.mockResolvedValue(roomInfo);

    const sock = await connect(ctx);
    await emit(ctx.gateway, sock, C('room.join', { roomCode: 'ROOM1' }));
    const joinedAt = (await stored('user-1')).connectedAt;

    // 未断线期间观测点不推进（旧实现：「窗口起点只由观测决定」——现在由
    // 「根本没有过期判定」保证「不能因为局打得久就把记录判死」）。
    vi.setSystemTime(Date.now() + 40_000);
    expect((await stored('user-1')).connectedAt).toBe(joinedAt);

    await ctx.gateway.handleDisconnect(sock); // 断线 → 观测点刷新
    expect((await stored('user-1')).connectedAt).toBe(Date.now());

    // 再等 10 分钟：记录仍在、房间仍在 ⇒ resolver 照常命中 —— 记录存在即可恢复。
    await redis.hset('room:ROOM1', { status: 'waiting' });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await reconnect.resolveRecoverableRoom('user-1')).toEqual({
      roomCode: 'ROOM1',
      source: 'record',
      status: 'waiting',
    });
    expect(await redis.hget(RECONNECT_HASH_KEY, 'user-1')).not.toBeNull();
  });

  it('硬中断换链路：新连接建立而上一连接从未被观测到断开 → 刷新在线观测点（§2.1 时机 5）', async () => {
    const ctx = makeGateway({ reconnect: realReconnect(), redis: asRedis(redis) });
    ctx.rooms.findOne.mockResolvedValue(roomInfo);

    const first = await connect(ctx);
    await emit(ctx.gateway, first, C('room.join', { roomCode: 'ROOM1' }));

    vi.setSystemTime(Date.now() + 25_000);
    const second = await connect(ctx); // 同一个 userId 的新连接，旧连接**没有** disconnect

    const renewed = await stored('user-1');
    expect(renewed.connectedAt).toBe(Date.now());
    expect(renewed.socketId).toBe(second.id);
    expect(ctx.gateway.activeConnections.get('user-1')).toBe(second);
  });

  it('旧连接的迟到 disconnect 不覆盖新记录的 connectedAt，也不清掉新连接的投递链路', async () => {
    const ctx = makeGateway({ reconnect: realReconnect(), redis: asRedis(redis) });
    ctx.rooms.findOne.mockResolvedValue(roomInfo);

    const first = await connect(ctx);
    await emit(ctx.gateway, first, C('room.join', { roomCode: 'ROOM1' }));
    vi.setSystemTime(Date.now() + 25_000);
    const second = await connect(ctx);
    const touchSpy = vi.spyOn(reconnect, 'touch');

    await ctx.gateway.handleDisconnect(first); // 迟到的旧连接断开

    expect(touchSpy).not.toHaveBeenCalled();
    expect((await stored('user-1')).connectedAt).toBe(Date.now());
    expect(ctx.gateway.activeConnections.get('user-1')).toBe(second);
    expect(ctx.gateway.seatOwners.get('ROOM1:0')).toBe('user-1'); // 投递链路未被误清
  });

  it('重连成功后 socket.join(roomCode) 并按 PlayerView.seat 重登记 seatOwners（缺陷 B-d）', async () => {
    const view = { roomCode: 'ROOM1', seat: 1, state: 'playing', trustees: [false, false, false], version: 6 };
    const ctx = makeGateway({
      reconnect: realReconnect(),
      redis: asRedis(redis),
      game: { view: vi.fn().mockResolvedValue(view) },
    });
    ctx.rooms.findOne.mockResolvedValue(roomInfo);
    // 本片（Task 2 起 `game.reconnect` 走 resolver）：房键必须真的在场，否则 resolver ②
    // 无候选可判 ⇒ 13010。房态 `playing` = 对局中（记录仍在、房间未回收）的真实形态。
    await redis.hset('room:ROOM1', { status: 'playing' });

    // 先正常入房（seat 0），再断线 —— 真实顺序：handleDisconnect 已清掉投递链路
    const old = await connect(ctx);
    await emit(ctx.gateway, old, C('room.join', { roomCode: 'ROOM1' }));
    expect(ctx.gateway.seatOwners.get('ROOM1:0')).toBe('user-1');
    vi.setSystemTime(Date.now() + 10_000);
    await ctx.gateway.handleDisconnect(old);
    // handleDisconnect 已把该玩家的座位归属清掉 → 不重登记就收不到后续推送
    expect(ctx.gateway.seatOwners.has('ROOM1:0')).toBe(false);
    expect(ctx.gateway.activeConnections.has('user-1')).toBe(false);

    // 新连接重连
    const fresh = await connect(ctx);
    /**
     * ⚠️ 连接补推（`replayActiveGame`）也会按 `view.seat` 登记 `ROOM1:1` ——
     * 先把它**显式化**（这是补推的副作用，不是被测行为），再 `clear()` 掉：
     * 下方「重连恢复了投递链路」的断言因此只能由 `restoreDelivery` 满足，不被补推兜底。
     */
    expect(ctx.gateway.seatOwners.get('ROOM1:1')).toBe('user-1');
    ctx.gateway.seatOwners.clear();

    const ack = await emit(ctx.gateway, fresh, C('game.reconnect', { lastVersion: 5 }));

    expect(ack.code).toBe(0);
    expect(ack.data).toMatchObject({ roomCode: 'ROOM1', version: 6 });
    // 这两条才是「重连成功」的定义（§6.6.1）：只回快照不恢复投递 = 收不到任何后续推送
    expect(fresh.join).toHaveBeenCalledWith('ROOM1');
    expect(ctx.gateway.seatOwners.get('ROOM1:1')).toBe('user-1');
    // §2.1 写入时机 3：重连成功 → 在线观测点再次刷新
    expect((await stored('user-1')).connectedAt).toBe(Date.now());
  });

  it('重连拿不到 PlayerView 时不恢复投递链路（避免把不存在的位置登记进去）', async () => {
    const ctx = makeGateway({
      reconnect: realReconnect(),
      redis: asRedis(redis),
      game: { view: vi.fn().mockResolvedValue(null) },
    });
    ctx.rooms.findOne.mockResolvedValue(roomInfo);
    // 本片（同上）：resolver 需要房键在场（否则 13010，到不了 13009 判据）。房态用
    // **finished** = 第二遍「已死候选」的真实形态（记录尚在、房间未回收、会话已终）：
    // 连接补推（泛化后每次连接都会读 resolver）在它面前静默 —— 不会把 `ROOM1:0` 提前
    // 登记进 seatOwners，本用例末尾「重连失败不得登记座位」的断言面因此完好。
    // （实测：换成 `playing` 必红在末行 —— 补推的 fail-open matched 会抢先登记 `ROOM1:0`。）
    await redis.hset('room:ROOM1', { status: 'finished' });

    const old = await connect(ctx);
    await emit(ctx.gateway, old, C('room.join', { roomCode: 'ROOM1' }));
    vi.setSystemTime(Date.now() + 1_000);
    await ctx.gateway.handleDisconnect(old);

    const fresh = await connect(ctx);
    const ack = await emit(ctx.gateway, fresh, C('game.reconnect', {}));

    expect(ack.code).toBe(13009);
    expect(fresh.join).not.toHaveBeenCalled();
    expect(ctx.gateway.seatOwners.has('ROOM1:0')).toBe(false);
  });
});

describe('WsGateway → client translation of game events (§4.4 table)', () => {
  let ctx: ReturnType<typeof makeGateway>;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    vi.clearAllMocks();
    ctx = makeGateway();
  });

  /**
   * `PlayerView` 夹具（§6.4）。
   *
   * ⚠️ 返回类型**必须**标注成 `PlayerView`：不标注的话 `state: 'bidding'` 被推成 `string`、
   * `cardCounts: [2, 2, 2]` 被推成 `number[]`，而协议要的是
   * `'init'|'bidding'|'playing'|'ended'` 与 `[number, number, number]`
   * ⇒ 夹具与服务端真实下发的形状**悄悄漂移**（P16 的闸就是为抓这个而装的）。
   * 从真实类型出发写夹具，`over` 也收窄成 `Partial<PlayerView>`。
   */
  const playerView = (seat: number, over: Partial<PlayerView> = {}): PlayerView => ({
    roomCode: 'ROOM1',
    version: 5,
    state: 'bidding',
    baseScore: 15,
    seat,
    hand: asCards([3, 4]),
    cardCounts: [2, 2, 2],
    // 挂机治理 T2/T6：按座位托管态（`Partial<PlayerView>` 的 over 可单独覆写）。
    trustees: [false, false, false],
    bottomCards: null,
    landlordSeat: null,
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: Date.now() + 30_000,
    bidPhase: { currentBidder: 2, bidMultiplier: 1, landlordCandidate: -1, grabActions: 0, redealCount: 0, kind: 'call', decisions: [] },
    playPhase: { bombCount: 0 },
    ...over,
  });

  function connectSeats(): Array<ReturnType<typeof makeSocket>> {
    return [0, 1, 2].map((seat) => {
      const sock = makeSocket({ auth: { userId: `user-${seat}`, internalToken: 'internal-secret' } });
      ctx.gateway.handleConnection(sock);
      ctx.gateway.seatOwners.set(`ROOM1:${seat}`, `user-${seat}`);
      return sock;
    });
  }

  /**
   * §9.6 归池（R207）：`game.ended` ⇒ 读 `room:{code}:bots` 的**内部** `botId`、
   * 调 `robot.release({ botIds })`、删绑定表。
   *
   * 判据是**结构性**的：断言 `release` 收到的就是绑定表里的内部 id（不是对外 `p_…`），
   * 并且键在归池后被删掉（否则下一局的 release 会把上一局的机器人再放一遍）。
   */
  it('game.ended ⇒ robot.release 收到内部 botId 且绑定表被删（R207）', async () => {
    const redis = asRedis(createFakeRedis());
    await (redis as unknown as { hset: (k: string, f: string, v: string) => Promise<number> })
      .hset('room:ROOM1:bots', '1', 'bot-internal-1');
    await (redis as unknown as { hset: (k: string, f: string, v: string) => Promise<number> })
      .hset('room:ROOM1:bots', '2', 'bot-internal-2');
    const robot = { release: vi.fn().mockResolvedValue(2) };
    const ctx = makeGateway({ redis, robot: robot as never });

    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 9,
      result: {
        roomCode: 'ROOM1',
        baseScore: 100,
        winner: 'landlord',
        landlordSeat: 0,
        farmerSeats: [1, 2],
        multiplier: 1,
        spring: 'none',
        landlordScoreChange: 100,
        farmerScoreChange: -50,
      },
    });
    await vi.waitFor(() => expect(robot.release).toHaveBeenCalled());

    expect(robot.release).toHaveBeenCalledWith(['bot-internal-1', 'bot-internal-2']);
    await vi.waitFor(async () =>
      expect(
        await (redis as unknown as { hgetall: (k: string) => Promise<Record<string, string>> }).hgetall(
          'room:ROOM1:bots',
        ),
      ).toEqual({}),
    );
  });

  /**
   * N31/R452：`room.status` 的**第三次转移**（`playing` → `finished`）由 `game.ended` 触发，
   * 且这里是它的**唯一**写入点。
   *
   * 判据纪律（R115）：先断言**前置状态真的是 `waiting`**（正对照 —— 证明房间确实建出来了、
   * 状态机确实在跑），再断言终局后是 `finished`。否则「房间根本没建出来」这类探针故障
   * 会让后一条以另一种方式变红，甚至被误读成「实现正确」。
   */
  it('game.ended 事件后 room.status 必须是 finished（N31/R452）', async () => {
    const redis = asRedis(createFakeRedis());
    const roomsService = new RoomsService(redis, asConfigCache(makeConfigCache()));
    const ctx = makeGateway({ redis, rooms: roomsService });
    await roomsService.create({ mode: 'random', roomCode: 'AAAAAA' });
    // 正对照：事件之前它**就是** `waiting`（N31 的原始症状：这一格永远是 waiting）
    expect((await roomsService.findOne('AAAAAA'))?.status).toBe('waiting');

    ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'AAAAAA', version: 9 });

    // `onGameEvent` 是**同步**的（Redis 消息处理器）；写盘是 fire-and-forget 的异步链
    await vi.waitFor(async () => {
      expect((await roomsService.findOne('AAAAAA'))?.status).toBe('finished');
    });
  });

  // ── N35 / R521：`room:{code}:cardcount` 的**写入方** ──────────────────
  //
  // 缺陷形态：该键**全仓没有任何写入点**（读点在 `message.router.ts` 的 `buildRoomPlayers()`；
  // 读侧的用例早就有了 —— `message.router.test.ts` 手工种键并断言 `cardCount` 出现）
  // ⇒ `RoomPlayer.cardCount`（§6.4 规则 3 **允许**的字段）恒不出现。
  // R521：room-service **本来就收到** `event.seatViews`（含权威 `cardCounts`）⇒ 由它派生写入，
  // 键的属主不变、**不需要**新增「game-service 写别人的键」这条跨服务路径。

  it('N35/R521：game.state_updated ⇒ room:ROOM1:cardcount 按**真实 userId** 落盘（且带 TTL）', async () => {
    const redis = asRedis(createFakeRedis());
    const ctx = makeGateway({ redis });
    // ⚠️ 不要用 `connectSeats()`：它绑的是 **describe 级** 的 `ctx`（`beforeEach` 造的那个，
    //    配 `mockRedis`），会把座位归属登记到**另一个网关实例**上 ⇒ 本实例的写入方找不到 owner，
    //    用例就会为**夹具**原因变红（探针自己出错，与产品无关 —— P9 教训 3 同族）。
    for (const seat of [0, 1, 2]) ctx.gateway.seatOwners.set(`ROOM1:${seat}`, `user-${seat}`);

    ctx.gateway.onGameEvent({
      event: 'game.state_updated',
      roomCode: 'ROOM1',
      version: 7,
      seatViews: [playerView(0), playerView(1), playerView(2)],
    });

    // 同 N31/R452：`onGameEvent` 同步，写键是 fire-and-forget ⇒ 用 `vi.waitFor` 等它落地
    await vi.waitFor(async () => {
      expect(await redis.hget('room:ROOM1:cardcount', 'user-1')).toBe('2');
    });
    // field **必须是真实 userId** —— 读侧 `buildRoomPlayers()` 用的就是 `room.players[].userId`；
    // 写成出站掩码（`seat-N`）会让读侧永远查不到（N35 会以另一种方式复现）。
    expect(await redis.hget('room:ROOM1:cardcount', 'user-0')).toBe('2');
    expect(await redis.hget('room:ROOM1:cardcount', 'user-2')).toBe('2');
    // Hash **不继承 TTL**（P3/N9 的教训）⇒ 必须显式 EXPIRE
    expect(await redis.ttl('room:ROOM1:cardcount')).toBeGreaterThan(0);
  });

  it('N35/R521：game.ended ⇒ 派生键必须被删掉（§6.4 规则 3 只在**对局中**下发）', async () => {
    const redis = asRedis(createFakeRedis());
    const ctx = makeGateway({ redis });
    await redis.hset('room:ROOM1:cardcount', { 'user-0': '5', 'user-1': '5', 'user-2': '5' });

    ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'ROOM1', version: 9 });

    await vi.waitFor(async () => {
      expect(await redis.exists('room:ROOM1:cardcount')).toBe(0);
    });
  });

  it('translates game.started into game.deal + game.current_turn', () => {
    const sockets = connectSeats();
    ctx.gateway.onGameEvent({
      event: 'game.started',
      roomCode: 'ROOM1',
      version: 5,
      seatViews: [playerView(0), playerView(1), playerView(2)],
    });

    for (const [seat, sock] of sockets.entries()) {
      const deal = sock.emitted.find(([type]) => type === 'game.deal');
      expect(deal).toBeDefined();
      expect(deal![1]).toMatchObject({ version: 5 });
      expect((deal![1] as { payload: { seat: number } }).payload.seat).toBe(seat);

      const turn = sock.emitted.find(([type]) => type === 'game.current_turn');
      expect(turn![1]).toMatchObject({ version: 5, payload: { seat: 2 } });
    }
  });

  it('translates game.state_updated into game.state_update + game.current_turn', () => {
    const sockets = connectSeats();
    ctx.gateway.onGameEvent({
      event: 'game.state_updated',
      roomCode: 'ROOM1',
      version: 6,
      seatViews: [playerView(0, { state: 'playing', currentPlayer: 1 }), playerView(1), playerView(2)],
    });

    expect(sockets[0]!.emitted.some(([type]) => type === 'game.state_update')).toBe(true);
    const turn = sockets[0]!.emitted.find(([type]) => type === 'game.current_turn');
    // 出牌阶段用 currentPlayer
    expect((turn![1] as { payload: { seat: number } }).payload.seat).toBe(1);
  });

  /**
   * N17 / R187：终局视图（`state === 'ended'`）**不发** `game.current_turn`。
   *
   * 终局没有「下一回合」：`currentTurnPayload()` 会读已经不再推进的 `turnDeadlineAt`，
   * 给客户端算出一个假的 30s 倒计时。
   *
   * 判据纪律（R115/R152）：先跑**正对照**（同形状的 `playing` 视图**确实**发 current_turn），
   * 再断言终局「没有」——否则「没有」可能只是探针/夹具坏了。
   */
  it('N17：终局视图（state=ended）只发 game.state_update，不发 game.current_turn', () => {
    const sockets = connectSeats();

    // 正对照：非终局（playing）必须仍然发 current_turn
    ctx.gateway.onGameEvent({
      event: 'game.state_updated',
      roomCode: 'ROOM1',
      version: 8,
      seatViews: [playerView(0, { state: 'playing', currentPlayer: 1 })],
    });
    const types08 = sockets[0]!.emitted
      .filter(([, m]) => (m as { version: number }).version === 8)
      .map(([t]) => t);
    expect(types08).toEqual(['game.state_update', 'game.current_turn']);

    // 终局：只有 state_update
    ctx.gateway.onGameEvent({
      event: 'game.state_updated',
      roomCode: 'ROOM1',
      version: 7,
      seatViews: [playerView(0, { state: 'ended', winner: 'landlord', cardCounts: [0, 2, 2] })],
    });
    const types07 = sockets[0]!.emitted
      .filter(([, m]) => (m as { version: number }).version === 7)
      .map(([t]) => t);
    expect(types07).toEqual(['game.state_update']);
  });

  it('translates game.ended into game.finished + game.settlement for the room', () => {
    connectSeats();
    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 20,
      result: {
        roomCode: 'ROOM1',
        baseScore: 100,
        winner: 'farmer',
        landlordSeat: 0,
        farmerSeats: [1, 2],
        multiplier: 2,
        spring: 'none',
        landlordScoreChange: -200,
        farmerScoreChange: 100,
      },
    });

    const types = ctx.serverEmit.mock.calls.map(([type]) => type);
    expect(types).toContain('game.finished');
    expect(types).toContain('game.settlement');
    const finished = ctx.serverEmit.mock.calls.find(([type]) => type === 'game.finished')!;
    expect(finished[1]).toEqual({ version: 20, payload: { winner: 'farmer' } });
  });

  it('skips seats with no live connection instead of throwing', () => {
    expect(() =>
      ctx.gateway.onGameEvent({
        event: 'game.started',
        roomCode: 'ROOM1',
        version: 5,
        seatViews: [playerView(0)],
      }),
    ).not.toThrow();
  });
});

describe('WsGateway match hand-off (§8.2)', () => {
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    vi.clearAllMocks();
  });

  it('forwards match:events to room.matched and registers the seat owners', () => {
    const ctx = makeGateway();
    const socks = ['alice', 'bob'].map((userId) => {
      const sock = makeSocket({ auth: { userId, internalToken: 'internal-secret' } });
      ctx.gateway.handleConnection(sock);
      return sock;
    });

    // 模拟匹配循环发布的 match:events 到达订阅回调
    ctx.gateway.onMatchEvent({
      event: 'room.matched',
      roomCode: 'ROOM1',
      seats: [
        { userId: 'alice', seat: 0 },
        { userId: 'bob', seat: 1 },
      ],
    });

    expect(socks[0]!.emitted).toEqual([['room.matched', { version: 0, payload: { roomCode: 'ROOM1', seat: 0 } }]]);
    expect(socks[1]!.emitted).toEqual([['room.matched', { version: 0, payload: { roomCode: 'ROOM1', seat: 1 } }]]);
    expect(ctx.gateway.seatOwners.get('ROOM1:0')).toBe('alice');
    expect(ctx.gateway.seatOwners.get('ROOM1:1')).toBe('bob');
  });

  it('room.matched 携带 gameType/playerCount（多玩法 Task 2.2 / spec §4.6.2）', () => {
    const ctx = makeGateway();
    const sock = makeSocket({ auth: { userId: 'alice', internalToken: 'internal-secret' } });
    ctx.gateway.handleConnection(sock);

    ctx.gateway.onMatchEvent({
      event: 'room.matched',
      roomCode: 'ROOM1',
      seats: [{ userId: 'alice', seat: 0 }],
      gameType: 'paodekuai',
      playerCount: 3,
    });

    expect(sock.emitted).toEqual([
      [
        'room.matched',
        { version: 0, payload: { roomCode: 'ROOM1', seat: 0, gameType: 'paodekuai', playerCount: 3 } },
      ],
    ]);
  });

  it('system_warning → 定向 system.warning（pdk 开局重试/取消；Task 2.4 / RH3-b）', () => {
    const ctx = makeGateway();
    const sock = makeSocket({ auth: { userId: 'alice', internalToken: 'internal-secret' } });
    ctx.gateway.handleConnection(sock);

    ctx.gateway.onMatchEvent({
      event: 'system_warning',
      playerIds: ['alice', 'ghost'],
      code: 10007,
      message: '本局正在重试开局，请稍候',
    });

    expect(sock.emitted).toEqual([
      ['system.warning', { version: 0, payload: { code: 10007, message: '本局正在重试开局，请稍候' } }],
    ]);
  });

  it('does not throw when a matched player has no live socket', () => {
    const ctx = makeGateway();
    expect(() =>
      ctx.gateway.onMatchEvent({
        event: 'room.matched',
        roomCode: 'ROOM1',
        seats: [{ userId: 'offline', seat: 2 }],
      }),
    ).not.toThrow();
  });

  it('match:timeout → 只给**已连接**的玩家发 system.error 12007（R46）', () => {
    const ctx = makeGateway();
    // user-1 在线；ghost 是同一批超时票里的玩家但**没有活跃连接**
    // （超时通知只能投给在线连接；离线的靠自己的 match:meta 过期后重排队）。
    const sock = makeSocket();
    ctx.gateway.handleInternalConnect(sock, 'user-1');

    ctx.gateway.onMatchEvent({
      event: 'match.timeout',
      playerIds: ['user-1', 'ghost'],
      code: 12007,
      message: 'Match timed out',
    });

    expect(sock.emitted).toEqual([
      ['system.error', { version: 0, payload: { code: 12007, message: 'Match timed out' } }],
    ]);
    // ghost 未连接 → 不产生任何 emit（也不抛错）
    expect(ctx.gateway.activeConnections.has('ghost')).toBe(false);
  });

  it('match.wait_prompt → 只给已连接玩家发友好提示信封（非终止；ghost 不抛、不发）', () => {
    const ctx = makeGateway();
    const socks = ['alice', 'bob'].map((userId) => {
      const sock = makeSocket({ auth: { userId, internalToken: 'internal-secret' } });
      ctx.gateway.handleConnection(sock);
      return sock;
    });

    expect(() =>
      ctx.gateway.onMatchEvent({
        event: 'match.wait_prompt',
        playerIds: ['alice', 'bob', 'ghost'],
        message: MATCH_WAIT_PROMPT_MESSAGE,
      }),
    ).not.toThrow();

    const want = [
      [
        'match.wait_prompt',
        {
          version: 0,
          payload: { message: MATCH_WAIT_PROMPT_MESSAGE },
        },
      ],
    ];
    expect(socks[0]!.emitted).toEqual(want);
    expect(socks[1]!.emitted).toEqual(want);
    // 等待提示是匹配级事件：不得登记座位、不得触发房间消息。
    expect(ctx.gateway.seatOwners.size).toBe(0);
  });

  it('card_counter → 定向发 game.card_counter 信封（version 0；ghost 不抛/不发；不落 seats 循环）', () => {
    const ctx = makeGateway();
    const sock = makeSocket({ auth: { userId: 'alice', internalToken: 'internal-secret' } });
    ctx.gateway.handleConnection(sock);

    expect(() =>
      ctx.gateway.onMatchEvent({
        event: 'card_counter',
        userId: 'alice',
        roomCode: 'ROOM1',
        active: true,
        source: 'credit',
      }),
    ).not.toThrow();

    expect(sock.emitted).toEqual([
      [
        'game.card_counter',
        { version: 0, payload: { roomCode: 'ROOM1', active: true, source: 'credit' } },
      ],
    ]);
    // 无 source 的形态（免费场/关闭态）同样合法
    expect(() =>
      ctx.gateway.onMatchEvent({
        event: 'card_counter',
        userId: 'ghost',
        roomCode: 'ROOM1',
        active: false,
      }),
    ).not.toThrow();
    // 匹配级事件不登记座位
    expect(ctx.gateway.seatOwners.size).toBe(0);
  });
});

describe('currentTurnPayload', () => {
  it('uses bidPhase.currentBidder while bidding (§9.4)', () => {
    const payload = currentTurnPayload({
      state: 'bidding',
      currentPlayer: 0,
      bidPhase: { currentBidder: 2 },
      turnDeadlineAt: Date.now() + 1000,
    } as never);
    expect(payload.seat).toBe(2);
  });

  it('uses currentPlayer while playing', () => {
    const payload = currentTurnPayload({
      state: 'playing',
      currentPlayer: 1,
      bidPhase: { currentBidder: 2 },
      turnDeadlineAt: Date.now() + 1000,
    } as never);
    expect(payload.seat).toBe(1);
  });

  it('never reports a negative timeout', () => {
    const payload = currentTurnPayload({
      state: 'playing',
      currentPlayer: 1,
      bidPhase: { currentBidder: 2 },
      turnDeadlineAt: Date.now() - 10_000,
    } as never);
    expect(payload.timeoutMs).toBe(0);
  });
});

/**
 * 记录片 T5（规格 C1 / 设计 D1·D2）：`game.ended` 的记录组装链。
 *
 * 判据形态（brief Step 1 逐条）：
 *  - **组装逐字段**：seats 按座位序、`isRobot` 真源 = room `Seat`、`robotId` 自
 *    `room:{code}:bots` Hash **按座位号对齐**、机器人 `userId=null`（信封 `playerId` /
 *    `Seat.userId` 里的对外 `displayId` **绝不进请求**）、`hand`/`bottomCards` 用信封
 *    原串（room **不重编码**）；
 *  - **跳过三态**（`!record || !version` / 房间缺失 / 形状不符）⇒ **不调 client** + WARN；
 *  - **广播与写入解耦**：client 抛 ⇒ `game.finished`/`game.settlement` 照常 + error 日志；
 *  - **读时序（r3-2）**：bots Hash 的座位对齐读**先于**归池的 DEL，且两者共用同一次读。
 */
describe('记录片 T5：game.ended 记录组装 + record.write 投递', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_TOKEN;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = ORIGINAL;
    Logger.overrideLogger(new Logger());
  });

  type Envelope = NonNullable<GameEvent['record']>;
  type DdzEnvelope = Extract<Envelope, { gameType?: 'doudizhu' }>;

  /** T1 codec 的定长 hex 形态（34 = 2×17）——room **不重编码**，组装时原样透传。 */
  const HAND = (seed: string): string => seed.repeat(17);
  const BOTTOM = '4f'.repeat(3); // 6 位

  const RESULT: SettlementResult = {
    roomCode: 'ROOM1',
    baseScore: 15,
    winner: 'landlord',
    landlordSeat: 0,
    farmerSeats: [1, 2],
    multiplier: 2,
    spring: 'none',
    landlordScoreChange: 30,
    farmerScoreChange: -15,
  };

  /**
   * `game.ended` 的 record 信封（T3 形态）。seats **刻意乱序**：组装侧必须自己按
   * 座位序输出（信封顺序不是契约；「按座位序」是规格 §2.2 对请求的明文要求）。
   */
  const envelope = (over: Partial<DdzEnvelope> = {}): DdzEnvelope => ({
    startedAt: 1_700_000_000_000,
    seats: [
      { seat: 2, playerId: 'p_bot0002', hand: HAND('22') },
      { seat: 0, playerId: 'alice', hand: HAND('11') },
      { seat: 1, playerId: 'p_bot0001', hand: HAND('33') },
    ],
    bottomCards: BOTTOM,
    ...over,
  });

  /**
   * 「三人满座、其中两个机器人」的房间（alice@0 人类 + 机器人@1,2）+ bots 绑定表。
   *
   * ⚠️ 座位 1/2 的 `Seat.userId` 是**对外 `displayId`**（`p_…`）—— 这正是
   * 「机器人座 userId 必须 NULL、绝不写 displayId」判据的被测形态。
   */
  async function makeRecordFixtures() {
    const redis = createFakeRedis();
    const rooms = new RoomsService(asRedis(redis), asConfigCache(makeConfigCache()));
    await rooms.create({ mode: 'random', roomCode: 'ROOM1' });
    await rooms.join('ROOM1', 'alice');
    await rooms.addBot('ROOM1', 'p_bot0001');
    await rooms.addBot('ROOM1', 'p_bot0002');
    await redis.hset('room:ROOM1:bots', '1', 'bot-int-1');
    await redis.hset('room:ROOM1:bots', '2', 'bot-int-2');
    // 2026-10-22 机器人昵称片：本局分配好的展示昵称（field = displayId）。
    await redis.hset(nicknamesKey('ROOM1'), {
      p_bot0001: '阿豆',
      p_bot0002: '小北',
    });
    const robot = { release: vi.fn().mockResolvedValue(2) };
    const recordClient = { write: vi.fn().mockResolvedValue(true) };
    const ctx = makeGateway({ redis: asRedis(redis), rooms, robot, record: recordClient });
    return { redis, rooms, robot, recordClient, ctx };
  }

  const SKIP_PREFIX = 'Record write skipped';
  const skipped = (records: LogRecord[]): LogRecord[] =>
    records.filter((r) => r.msg.startsWith(SKIP_PREFIX));

  it('组装逐字段：座位序 / isRobot 自 Seat / robotId 座位对齐 / 机器人 userId=null / hand 用信封串', async () => {
    const { recordClient, ctx } = await makeRecordFixtures();
    const before = Date.now();

    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 20,
      result: RESULT,
      record: envelope(),
    });

    await vi.waitFor(() => expect(recordClient.write).toHaveBeenCalledTimes(1));
    const after = Date.now();
    const request = recordClient.write.mock.calls[0]![0] as RecordWriteRequest;

    // 逐字段（`toEqual` 是**恰好**比对：meta 不在这里加 —— 它是 client 发送侧的横切职责）
    expect(request).toEqual({
      roomCode: 'ROOM1',
      gameVersion: 20,
      mode: 'random',
      baseScore: 15,
      result: RESULT,
      seats: [
        { seat: 0, userId: 'alice', isRobot: false, robotId: null, hand: HAND('11'), nickname: null },
        { seat: 1, userId: null, isRobot: true, robotId: 'bot-int-1', hand: HAND('33'), nickname: '阿豆' },
        { seat: 2, userId: null, isRobot: true, robotId: 'bot-int-2', hand: HAND('22'), nickname: '小北' },
      ],
      bottomCards: BOTTOM,
      startedAt: 1_700_000_000_000,
      endedAt: expect.any(Number),
    });
    // `endedAt` = **room 收事件时刻**（设计 D2）—— 落在调用窗口内
    expect(request.endedAt).toBeGreaterThanOrEqual(before);
    expect(request.endedAt).toBeLessThanOrEqual(after);
    // 🔴 「绝不写 displayId」：机器人对外 id（信封 playerId / Seat.userId）不得出现在请求里
    expect(JSON.stringify(request)).not.toContain('p_bot');
  });

  it('机器人昵称读取失败 ⇒ 快照 null，记录仍写入（fail-open）', async () => {
    const { redis, recordClient, ctx } = await makeRecordFixtures();
    const original = redis.hgetall.getMockImplementation()!;
    redis.hgetall.mockImplementation(async (key: string) => {
      if (key === nicknamesKey('ROOM1')) throw new Error('redis down');
      return original(key);
    });

    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 20,
      result: RESULT,
      record: envelope(),
    });

    await vi.waitFor(() => expect(recordClient.write).toHaveBeenCalledTimes(1));
    const request = recordClient.write.mock.calls[0]![0] as RecordWriteRequest;
    expect(request.seats[1]!.nickname).toBeNull();
    expect(request.seats[2]!.nickname).toBeNull();
  });

  it('昵称 Hash 在 updateStatus(finished) 之前读取（reaper 删除竞态）', async () => {
    const { redis, rooms, recordClient, ctx } = await makeRecordFixtures();
    const updateSpy = vi.spyOn(rooms, 'updateStatus');

    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 20,
      result: RESULT,
      record: envelope(),
    });

    await vi.waitFor(() => expect(recordClient.write).toHaveBeenCalledTimes(1));
    const readIdx = redis.hgetall.mock.calls.findIndex(
      ([key]) => key === nicknamesKey('ROOM1'),
    );
    expect(readIdx, '正对照：必须真的读过昵称 Hash（否则本条空转）').toBeGreaterThanOrEqual(0);
    expect(updateSpy).toHaveBeenCalled();
    expect(redis.hgetall.mock.invocationCallOrder[readIdx]!).toBeLessThan(
      updateSpy.mock.invocationCallOrder[0]!,
    );
  });

  it('跳过①：缺 record（旧会话窗口）/ 缺 version（notifyRoomEnded 形态）⇒ 不调 client + WARN', async () => {
    const records = installSink();
    const { robot, recordClient, ctx } = await makeRecordFixtures();

    // 缺 record：T3 的窗口守卫对无快照的旧会话「不带 record 发布」
    ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'ROOM1', version: 9, result: RESULT });
    // 缺 version：`notifyRoomEnded` 的真实发布形态（无 version；测试直接调 onGameEvent 模拟）
    const noVersion = { event: 'game.ended', roomCode: 'ROOM1', result: RESULT, record: envelope() };
    ctx.gateway.onGameEvent(noVersion as unknown as GameEvent);

    await vi.waitFor(() => expect(skipped(records)).toHaveLength(2));
    const skips = skipped(records);
    expect(skips[0]!.level).toBe('warn');
    expect(skips[0]!.msg).toContain('no record');
    expect(skips[1]!.level).toBe('warn');
    expect(skips[1]!.msg).toContain('no version');
    expect(recordClient.write).not.toHaveBeenCalled();
    // 跳过写入**不影响**归池（同链但独立）：机器人照常交还（判据 ① 的负向对照）
    await vi.waitFor(() => expect(robot.release).toHaveBeenCalledWith(['bot-int-1', 'bot-int-2']));
  });

  it('跳过②：房间数据缺失（房键 TTL 窗口）⇒ 不调 client + WARN', async () => {
    const records = installSink();
    // 空键空间 = `room:*` 全过期（meta/seats/bots 一并缺失）
    const redis = createFakeRedis();
    const rooms = new RoomsService(asRedis(redis), asConfigCache(makeConfigCache()));
    const recordClient = { write: vi.fn().mockResolvedValue(true) };
    const ctx = makeGateway({ redis: asRedis(redis), rooms, record: recordClient });

    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 30,
      result: RESULT,
      record: envelope(),
    });

    await vi.waitFor(() => expect(skipped(records)).toHaveLength(1));
    expect(skipped(records)[0]!.level).toBe('warn');
    expect(skipped(records)[0]!.msg).toContain('room data missing');
    expect(recordClient.write).not.toHaveBeenCalled();
  });

  it('跳过③：形状不符（座位数与信封不符）⇒ 不调 client + WARN', async () => {
    const records = installSink();
    const { recordClient, ctx } = await makeRecordFixtures();

    // 信封恰 3 条但座位号集不是 0/1/2（没有 seat 2 —— 房键 TTL 窗口的半边缺失形态）
    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 21,
      result: RESULT,
      record: envelope({
        seats: [
          { seat: 0, playerId: 'alice', hand: HAND('11') },
          { seat: 1, playerId: 'p_bot0001', hand: HAND('33') },
          { seat: 5, playerId: 'ghost', hand: HAND('55') },
        ],
      }),
    });
    await vi.waitFor(() => expect(skipped(records)).toHaveLength(1));
    // 信封只有 2 条（座位缺一个）
    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 22,
      result: RESULT,
      record: envelope({
        seats: [
          { seat: 0, playerId: 'alice', hand: HAND('11') },
          { seat: 1, playerId: 'p_bot0001', hand: HAND('33') },
        ],
      }),
    });
    await vi.waitFor(() => expect(skipped(records)).toHaveLength(2));

    const skips = skipped(records);
    expect(skips.every((r) => r.level === 'warn')).toBe(true);
    expect(skips.every((r) => r.msg.includes('shape mismatch'))).toBe(true);
    expect(recordClient.write).not.toHaveBeenCalled();
  });

  it('广播与写入解耦：record.write 抛 ⇒ 广播照常 + error 日志', async () => {
    const records = installSink();
    const { recordClient, ctx } = await makeRecordFixtures();
    recordClient.write.mockRejectedValueOnce(new Error('user-service down'));

    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 20,
      result: RESULT,
      record: envelope(),
    });

    // 广播在 `onGameEvent` 内**同步**发出 —— 不依赖写入结局（这就是解耦的定义）
    const types = ctx.serverEmit.mock.calls.map(([type]) => type);
    expect(types).toContain('game.finished');
    expect(types).toContain('game.settlement');

    await vi.waitFor(() => expect(records.some((r) => r.msg.startsWith('Record write failed'))).toBe(true));
    const line = records.find((r) => r.msg.startsWith('Record write failed'))!;
    expect(line.level).toBe('error');
    expect(line.msg).toContain('user-service down');
  });

  it('bots 读时序（r3-2）：座位对齐读**先于**归池 DEL，且归池与组装共用同一次读', async () => {
    const { redis, robot, recordClient, ctx } = await makeRecordFixtures();
    // 写入端慢一拍：若组装是「归池 DEL 之后的晚读」，robotId 会静默丢成 null
    recordClient.write.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    });

    ctx.gateway.onGameEvent({
      event: 'game.ended',
      roomCode: 'ROOM1',
      version: 20,
      result: RESULT,
      record: envelope(),
    });

    // 正对照：归池真的落地了（DEL 之后才断言，避免与写入赛跑）
    await vi.waitFor(async () => expect(await redis.exists('room:ROOM1:bots')).toBe(0));
    expect(robot.release).toHaveBeenCalledWith(['bot-int-1', 'bot-int-2']);
    // 组装用的是**同一次读**（DEL 之后绑定依然完好）⇒ 不是晚读
    await vi.waitFor(() => expect(recordClient.write).toHaveBeenCalledTimes(1));
    const request = recordClient.write.mock.calls[0]![0] as RecordWriteRequest;
    expect(request.seats.map((s) => s.robotId)).toEqual([null, 'bot-int-1', 'bot-int-2']);

    // 机械时序证据：对 bots 键的 `hgetall` 调用序 < 对它 `del` 的调用序
    const readIdx = redis.hgetall.mock.calls.findIndex(([key]) => key === 'room:ROOM1:bots');
    expect(readIdx, '正对照：必须真的读过 bots 表（否则本条空转）').toBeGreaterThanOrEqual(0);
    const delIdx = redis.del.mock.calls.findIndex((args) =>
      (args as string[]).includes('room:ROOM1:bots'),
    );
    expect(delIdx, '正对照：归池必须真的删过 bots 表').toBeGreaterThanOrEqual(0);
    expect(redis.hgetall.mock.invocationCallOrder[readIdx]!).toBeLessThan(
      redis.del.mock.invocationCallOrder[delIdx]!,
    );
  });
});

/**
 * ─── 监控片 T3（规格 §2.2 / C10）────────────────────────────────────────────
 *
 * `ws_connections` 的**恰一次升降**与 `games_ended_total` 的恰一次计数。
 *
 * ⚠️ 指标是**模块级单例**（本文件前面的用例也会碰它们）⇒ 一律取
 * 「动作前基线 → 动作 → 基线 ± 期望」的**差值**判据，不假设绝对值（用例顺序无关）。
 * 两处会让朴素计数出错的路（硬换手 :295-312 / 陈旧断线早返 :416-422）各有一条用例。
 */
describe('监控片 T3：ws_connections 恰一次升降（C10）+ games_ended_total', () => {
  const ORIGINAL = process.env.INTERNAL_SERVICE_TOKEN;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = ORIGINAL;
  });

  it('鉴权通过并注册 ⇒ +1；正常断线 ⇒ -1（回到基线）', async () => {
    const { gateway } = makeGateway();
    const before = await metricValue(wsConnections);
    const sock = makeSocket({ auth: { userId: 'mt-user-1', internalToken: 'internal-secret' } });

    await gateway.handleConnection(sock);
    await expect(metricValue(wsConnections)).resolves.toBe(before + 1);

    await gateway.handleDisconnect(sock);
    await expect(metricValue(wsConnections)).resolves.toBe(before);
  });

  it('拒握手（错 token）**不计入**', async () => {
    const { gateway } = makeGateway();
    const before = await metricValue(wsConnections);
    const sock = makeSocket({ auth: { userId: 'mt-user-2', internalToken: 'wrong-token' } });

    await gateway.handleConnection(sock);

    expect(sock.disconnect, '正对照：这一条确实走了拒握手路径').toHaveBeenCalledWith(true);
    await expect(metricValue(wsConnections)).resolves.toBe(before);
  });

  it('拒握手（**缺 userId**，token 正确）**不计入** —— C10 点名的第二条拒绝路径（T3+T4 审查 F1 补）', async () => {
    const { gateway } = makeGateway();
    const before = await metricValue(wsConnections);
    const sock = makeSocket({ auth: { internalToken: 'internal-secret' } });

    await gateway.handleConnection(sock);

    expect(sock.data.userId, '正对照：userId 确实没被写进 socket').toBeUndefined();
    expect(sock.disconnect, '正对照：这一条确实走了拒握手路径').toHaveBeenCalledWith(true);
    await expect(metricValue(wsConnections), 'inc 点在鉴权+注册之后 ⇒ 缺 userId 的拒绝不得计入').resolves.toBe(before);
  });

  it('硬换手（新连接顶掉「从未观测到断开」的旧连接）**不双计**', async () => {
    const { gateway } = makeGateway();
    const before = await metricValue(wsConnections);
    const oldSock = makeSocket({ auth: { userId: 'mt-user-3', internalToken: 'internal-secret' } });
    await gateway.handleConnection(oldSock);
    await expect(metricValue(wsConnections)).resolves.toBe(before + 1);

    const newSock = makeSocket({ auth: { userId: 'mt-user-3', internalToken: 'internal-secret' } });
    await gateway.handleConnection(newSock);

    // 正对照：顶替真的发生了（内存表已指向新连接）
    expect(gateway.activeConnections.get('mt-user-3')).toBe(newSock);
    await expect(metricValue(wsConnections), '同一用户的一条逻辑连接已在册 ⇒ 不得再加一').resolves.toBe(
      before + 1,
    );
  });

  it('陈旧断线（硬换手后旧连接才断开）**不误减**；新连接照常断开时才减', async () => {
    const { gateway } = makeGateway();
    const before = await metricValue(wsConnections);
    const oldSock = makeSocket({ auth: { userId: 'mt-user-4', internalToken: 'internal-secret' } });
    await gateway.handleConnection(oldSock);
    const newSock = makeSocket({ auth: { userId: 'mt-user-4', internalToken: 'internal-secret' } });
    await gateway.handleConnection(newSock);

    await gateway.handleDisconnect(oldSock); // 陈旧早返（"Ignoring stale disconnect"）

    await expect(metricValue(wsConnections)).resolves.toBe(before + 1);
    await gateway.handleDisconnect(newSock); // 正对照：真正的断线必须减
    await expect(metricValue(wsConnections)).resolves.toBe(before);
  });

  it('games_ended_total：收到 game.ended ⇒ +1；game.started 不计（反空测）', async () => {
    const ctx = makeGateway({ redis: asRedis(createFakeRedis()) });
    const before = await metricValue(gamesEndedTotal);

    ctx.gateway.onGameEvent({ event: 'game.started', roomCode: 'MTRM1', version: 1 });
    await expect(metricValue(gamesEndedTotal), '开局事件不得进结算计数').resolves.toBe(before);

    ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'MTRM1', version: 2 });
    await expect(metricValue(gamesEndedTotal)).resolves.toBe(before + 1);
  });
});

/**
 * ② 金币场 T5：**结算挂点**（规格 §4 的 `:809` 位）。
 *
 * 本文件钉三件（结算服务本体在 `test/currency/`）：
 *  - `finalizeRoomEnd` 真的调 `settle.settle(...)`，且**入参透传**：
 *    `botBySeat` = 顶部那次读（与记录组装共用 —— 归池 DEL 之后仍完好）、
 *    `room` = 房间元数据（`findOne`）；
 *  - 挂点**早于** `!record||!version` 早返（老会话窗口/ notifyRoomEnded 形态**不得**
 *    拦住结算调用）；
 *  - `game.balances` 广播的 ws 层实现：构造期 `bindBroadcast` 收到回调，回调触发
 *    `server.to(roomCode).emit('game.balances', {version, payload:{balances}})`。
 */
describe('② T5：结算挂点（finalizeRoomEnd）+ game.balances 广播绑定', () => {
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    vi.clearAllMocks();
  });

  const RESULT: SettlementResult = {
    roomCode: 'ROOM1',
    baseScore: 15,
    winner: 'landlord',
    landlordSeat: 0,
    farmerSeats: [1, 2],
    multiplier: 2,
    spring: 'none',
    landlordScoreChange: 30,
    farmerScoreChange: -15,
  };

  const GOLD_ROOM = {
    code: 'ROOM1',
    mode: 'gold' as const,
    players: [
      { seat: 0, userId: 'alice', isRobot: false },
      { seat: 1, userId: 'p_bot0001', isRobot: true },
      { seat: 2, userId: 'carol', isRobot: false },
    ],
    maxPlayers: 3 as const,
    status: 'playing' as const,
    baseScore: 15,
    createdAt: 0,
    timeoutAt: 0,
  };

  it('game.ended ⇒ settle 收到 房间元数据 + 座位对齐的 botBySeat（顶部那次读，DEL 后仍完好）', async () => {
    const redis = asRedis(createFakeRedis());
    await (redis as unknown as { hset: (k: string, f: string, v: string) => Promise<number> }).hset(
      'room:ROOM1:bots',
      '1',
      'bot-int-1',
    );
    const settle = { settle: vi.fn().mockResolvedValue(undefined), bindBroadcast: vi.fn() };
    const ctx = makeGateway({ redis, robot: { release: vi.fn().mockResolvedValue(1) } as never, settle });
    ctx.rooms.findOne.mockResolvedValue(GOLD_ROOM);

    ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'ROOM1', version: 20, result: RESULT });

    await vi.waitFor(() => expect(settle.settle).toHaveBeenCalledTimes(1));
    const input = settle.settle.mock.calls[0]![0] as {
      roomCode: string;
      version: number;
      result: SettlementResult;
      room: unknown;
      botBySeat: ReadonlyMap<number, string>;
    };
    expect(input.roomCode).toBe('ROOM1');
    expect(input.version).toBe(20);
    expect(input.result).toBe(RESULT);
    expect(input.room).toBe(GOLD_ROOM);
    // 座位对齐映射透传（归池末尾 DEL 了 bots 键；这里是**同一次读**的产物）
    expect([...input.botBySeat.entries()]).toEqual([[1, 'bot-int-1']]);
    await vi.waitFor(async () =>
      expect(
        await (redis as unknown as { exists: (k: string) => Promise<number> }).exists('room:ROOM1:bots'),
      ).toBe(0),
    );
  });

  it('挂点早于早返：缺 record 且缺 version（notifyRoomEnded 形态）**不拦住**结算调用', async () => {
    const settle = { settle: vi.fn().mockResolvedValue(undefined), bindBroadcast: vi.fn() };
    const ctx = makeGateway({ settle });
    ctx.rooms.findOne.mockResolvedValue(GOLD_ROOM);

    const noEnvelope = { event: 'game.ended', roomCode: 'ROOM1', result: RESULT };
    ctx.gateway.onGameEvent(noEnvelope as unknown as GameEvent);

    await vi.waitFor(() => expect(settle.settle).toHaveBeenCalledTimes(1));
    // settle 自己按版本守卫处理（`undefined` ⇒ WARN + dropped），门外不得拦
    expect((settle.settle.mock.calls[0]![0] as { version: unknown }).version).toBeUndefined();
  });

  it('房间读失败 ⇒ settle 仍被调用（room=null，由 settle 内部 WARN 跳过）+ error 日志', async () => {
    const records = installSink();
    const settle = { settle: vi.fn().mockResolvedValue(undefined), bindBroadcast: vi.fn() };
    const ctx = makeGateway({ settle });
    ctx.rooms.findOne.mockRejectedValueOnce(new Error('redis down'));

    ctx.gateway.onGameEvent({ event: 'game.ended', roomCode: 'ROOM1', version: 20, result: RESULT });

    await vi.waitFor(() => expect(settle.settle).toHaveBeenCalledTimes(1));
    expect((settle.settle.mock.calls[0]![0] as { room: unknown }).room).toBeNull();
    expect(records.some((r) => r.msg.startsWith('Failed to read room ROOM1'))).toBe(true);
  });

  it('game.balances 广播：构造期 bindBroadcast 收到回调；触发 ⇒ server.to(room).emit(信封)', () => {
    const settle = { settle: vi.fn().mockResolvedValue(undefined), bindBroadcast: vi.fn() };
    const ctx = makeGateway({ settle });

    expect(settle.bindBroadcast).toHaveBeenCalledTimes(1);
    const bound = settle.bindBroadcast.mock.calls[0]![0] as (
      roomCode: string,
      version: number,
      balances: Array<{ seat: number; balance: number }>,
    ) => void;

    bound('ROOM1', 20, [
      { seat: 0, balance: 1030 },
      { seat: 1, balance: 985 },
      { seat: 2, balance: 985 },
    ]);

    expect(ctx.gateway.server.to).toHaveBeenCalledWith('ROOM1');
    expect(ctx.serverEmit).toHaveBeenCalledWith('game.balances', {
      version: 20,
      payload: {
        balances: [
          { seat: 0, balance: 1030 },
          { seat: 1, balance: 985 },
          { seat: 2, balance: 985 },
        ],
      },
    });
  });
});


describe('玩家管理页：在线 presence（2026-10-22）', () => {
  it('连接写入、heartbeat 刷新、断线删除', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    const redis = createFakeRedis();
    const { gateway } = makeGateway({ redis: asRedis(redis) });
    const sock = makeSocket({ auth: { userId: 'user-1', internalToken: 'internal-secret' } });

    await gateway.handleConnection(sock);
    await vi.waitFor(() => expect(redis.zsets.get(ONLINE_USERS_KEY)?.get('user-1')).toBeTypeOf('number'));

    const heartbeat = (sock as unknown as { conn: { on: ReturnType<typeof vi.fn> } }).conn.on.mock.calls
      .find(([event]) => event === 'heartbeat')?.[1] as (() => void) | undefined;
    expect(heartbeat).toBeTypeOf('function');
    const zaddCalls = redis.zadd.mock.calls.length;
    await vi.waitFor(async () => {
      heartbeat?.();
      await new Promise((r) => setTimeout(r, 5));
      expect(redis.zadd.mock.calls.length).toBeGreaterThan(zaddCalls);
    });

    await gateway.handleDisconnect(sock);
    expect(redis.zsets.get(ONLINE_USERS_KEY)?.has('user-1')).toBe(false);
  });

  it('陈旧断线不清 presence（硬换手保新连接）', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    const redis = createFakeRedis();
    const { gateway } = makeGateway({ redis: asRedis(redis) });
    const first = makeSocket({ auth: { userId: 'user-3', internalToken: 'internal-secret' } });
    const second = makeSocket({ auth: { userId: 'user-3', internalToken: 'internal-secret' } });
    await gateway.handleConnection(first);
    await gateway.handleConnection(second);
    await vi.waitFor(() => expect(redis.zsets.get(ONLINE_USERS_KEY)?.has('user-3')).toBe(true));
    await gateway.handleDisconnect(first); // 陈旧断线：不得 zrem
    expect(redis.zsets.get(ONLINE_USERS_KEY)?.has('user-3')).toBe(true);
  });

  it('Redis 故障不影响连接建立与断开', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    const redis = asRedis({
      ...mockRedis,
      zadd: vi.fn().mockRejectedValue(new Error('redis down')),
      zrem: vi.fn().mockRejectedValue(new Error('redis down')),
    } as never);
    const { gateway } = makeGateway({ redis });
    const sock = makeSocket({ auth: { userId: 'user-2', internalToken: 'internal-secret' } });

    await expect(gateway.handleConnection(sock)).resolves.toBeUndefined();
    expect(gateway.activeConnections.get('user-2')).toBe(sock);
    await expect(gateway.handleDisconnect(sock)).resolves.toBeUndefined();
    expect(gateway.activeConnections.has('user-2')).toBe(false);
  });
});

import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import {
  ErrCode,
  isPdkSettlementResult,
  type Ack,
  type GameType,
  type GameView,
  type RecordWriteRequest,
  type SettlementResult,
} from '@fight-the-landlord/protocol';
// ⚠️ **值导入**（不是 `import type`）：下面用 `runWithTrace` 把这些回调包进 ALS ——
// 类型导入会被擦除、运行期只剩 undefined（本仓 DI 陷阱那条教训同族）。
import { ONLINE_USERS_KEY, runWithTrace } from '@fight-the-landlord/shared';
import { Redis } from 'ioredis';
import { MatchService } from '../match/match.service';
import { clearBotBindings, botsKey } from '../rooms/rooms.bots';
import { cardCountKey, nicknamesKey, ROOM_TTL_SECONDS } from '../rooms/rooms.seats';
// ⚠️ **值导入**（不是 `import type`）：构造函数上 `@Inject(RECORD_CLIENT) record: RecordClient`
// 的类型元数据要用到运行期类引用（wiring 门禁断言 `design:paramtypes` 该下标是函数）——
// 类型导入会被擦除，本仓 DI 陷阱同族。
import { RecordClient } from './record.client';
import { RobotClient } from './robot.client';
// ⚠️ **值导入**（同上）：风控 T3 的第 12 个构造参数是**类 token**（`RiskClient`）——
// `import type` 会让 `design:paramtypes` 该下标变 `undefined` ⇒ 容器启动即崩。
import { RiskClient } from './risk.client';
import { ReconnectService } from '../reconnect/reconnect.service';
import { RoomsService, type Room } from '../rooms/rooms.service';
import { GameClient } from './game.client';
import { routeClientMessage, type RouterDeps } from './message.router';
import { RoomStartService } from '../rooms/rooms.start';
// 昵称片：第 13 个构造依赖（值导入 —— DI 元数据要用运行期类引用）。
import { RoomNicknamesService } from '../rooms/room-nicknames.service';
// ② 金币场 T4（DI 陷阱纪律：以下两个都必须**值导入** —— 构造函数参数的类型元数据
// 要用运行期类引用；`import type` 会让元数据变成 undefined ⇒ 真容器启动即崩，
// 而单测直接 `new WsGateway(...)` 全绿看不见，由 `ws.module.wiring.test.ts` 钉住）：
//  - `ConfigCacheService`：`room.match` 双开关裁决的读面（C1/C2，与 Match/Rooms 同一单例）；
//  - `CurrencyClient`：金币场入场门槛的 `currency.get` 读边（C4）。
import { ConfigCacheService } from '../config/config-cache.service';
import { CurrencyClient } from '../currency/currency.client';
// ② 金币场 T5（DI 陷阱纪律：**值导入** —— 构造函数参数的类型元数据要用运行期类引用）：
// 结算例程的入口（`finalizeRoomEnd` 的 :809 位）与 `game.balances` 广播绑定的宿主。
import { SettleService } from '../currency/settle.service';
import { CHANNELS } from '../channels';
// 监控片（规格 §2.2 / C10）：两个模块级指标常量（本文件的写点，不走 DI —— 见该文件头注）。
import { gamesEndedTotal, wsConnections } from '../metrics/room.metrics';
// 记牌器收费片：房间状态（room:{code}:ccstate）的读/发共用件（重连补发三条路径之一）。
import { emitCardCounterStatus, readCardCounterStatus } from './card-counter-status';

/** 网关代理的 ack 关联字段（与 api-gateway 的 `CORRELATION_KEY` 必须同名）。 */
export const CORRELATION_KEY = '__ackId';

/**
 * Redis pub/sub 频道名 —— 值的**单一真源**在 `../channels`（那里解释了为什么要挪）。
 * 这里保留原名字，只为既有调用方不改。
 */
export const MATCH_EVENTS_CHANNEL = CHANNELS.matchEvents;
export const GAME_EVENTS_CHANNEL = CHANNELS.gameEvents;

/**
 * 可注入的 game-service 客户端 token（单测用替身；生产由 `RpcClientsModule` 注册，
 * 见该文件「两个 token」的说明）。
 */
export const GAME_CLIENT = 'ROOM_SERVICE_GAME_CLIENT';

/**
 * 可注入的 robot-service 客户端 token（§9.6 的归池）。
 *
 * ⚠️ **N20/P4 Task 3（R217 同族收口）**：`ws.gateway.ts` 早就用
 * `@Optional() robot?: RobotClient` 注入它，而 `ws.module.ts` **从来没有**提供它
 * ⇒ 容器里 `this.robot` 恒为 `undefined` ⇒ `game.ended` 分支的 `robot.release()`
 * 在生产路径上**一次都没执行过**（只有单测手工 `new WsGateway(...)` 时才工作）。
 * 本片把它注册进 `RpcClientsModule` 并且**去掉了 `@Optional()`**
 * —— 缺 provider 时启动即崩（fail loud），而不是整条归池路径静默消失。
 */
export const ROBOT_CLIENT = 'ROOM_SERVICE_ROBOT_CLIENT';

/**
 * 可注入的 user-service 记录写入客户端 token（记录片 T5 / 设计 D2）。
 *
 * ⚠️ 与 `GAME_CLIENT` / `ROBOT_CLIENT` 同形（字符串 token + `RpcClientsModule` 的
 * `useExisting`）——`test/ws.module.wiring.test.ts` 的容器门禁**用这里声明的 token
 * 反向点名**：`RpcClientsModule` 少提供 / 少导出它以真容器启动即崩（`Nest can't resolve
 * dependencies`），而单测直接 `new WsGateway(...)`、全绿看不见（R216/R217 同族）。
 */
export const RECORD_CLIENT = 'ROOM_SERVICE_RECORD_CLIENT';

/**
 * 记录片 T5（设计 D1 逐字 / T3 由 game-service 组装）：`game.ended` 附带的
 * **`record` 信封** —— 发牌快照（斗地主：三家各 17 张 + 底牌 3 张；跑得快：16/12 张 +
 * `playedCount`，2 人局附扣牌）。hex 串由 game-service 编码，room **不重编码**。
 *
 * ⚠️ `isBot`/`robotId` **不进信封**（真源在 room 侧，D2）；room 消费后**丢弃、不转发**
 * 客户端（客户端零变化）。
 */
export interface DdzRecordEnvelope {
  /** 会话创建时刻（epoch ms）——`startedAt` 的真源（设计 D1）。 */
  startedAt: number;
  seats: Array<{ seat: number; playerId: string; hand: string }>;
  bottomCards: string;
  /** 多玩法（S4）：缺失 = doudizhu（旧生产者）。 */
  gameType?: 'doudizhu';
  playerCount?: 3;
}

/** 跑得快记录信封（Task 4.3 / spec §4.3）：无底牌；`playedCount` 用于关牌；2 人局带扣牌。 */
export interface PdkRecordEnvelope {
  startedAt: number;
  seats: Array<{ seat: number; playerId: string; hand: string; playedCount: number }>;
  /** 2 人局扣下的 16 张（32 hex）；3/4 人局缺省。仅审计。 */
  unusedCards?: string;
  gameType: 'paodekuai';
  playerCount: 2 | 3 | 4;
}

export type RecordEnvelope = DdzRecordEnvelope | PdkRecordEnvelope;

/** 对局事件载荷（§4.4）。 */
export interface GameEvent {
  event: 'game.started' | 'game.state_updated' | 'game.ended';
  roomCode: string;
  version: number;
  seatViews?: GameView[];
  result?: SettlementResult;
  /**
   * 记录片 T5：仅 `game.ended` 可能带。**旧会话窗口**（部署期无 `initialHands` 的会话）
   * 与 `notifyRoomEnded` 路径**两者都缺** ⇒ room 侧跳过写入 + WARN（设计 D1）。
   */
  record?: RecordEnvelope;
}

/** 匹配事件载荷（§8.2 + R46）。 */
export type MatchEvent =
  | {
      event: 'room.matched';
      roomCode: string;
      seats: Array<{ userId: string; seat: number }>;
      /**
       * 多玩法（Task 2.2 / spec §4.6.2）：新生产者一律写；部署窗口里旧 producer
       * 发的事件缺这两个字段（客户端按缺省 doudizhu/3 处理）。
       */
      gameType?: GameType;
      playerCount?: number;
    }
  | {
      event: 'match.timeout';
      playerIds: string[];
      code: number;
      message: string;
    }
  | {
      /**
       * 机器人补位开关片：补机器人关闭且缺人越过等待窗口时的**友好提示**（非终止）。
       * 票仍在队列；客户端弹窗给「延长匹配时间 / 重新匹配」两个动作。
       */
      event: 'match.wait_prompt';
      playerIds: string[];
      message: string;
    }
  | {
      /**
       * 多玩法（Task 2.4 / spec RH3-b）：pdk 开局重试/取消的**定向警告**（`10007`）。
       * `message` 区分「正在重试」/「已取消」；经 `system.warning` 下发（客户端 TOAST）。
       */
      event: 'system_warning';
      playerIds: string[];
      code: number;
      message: string;
    }
  | {
      /**
       * 记牌器收费片：本局是否开通（**按玩家定向**；房间级、version 恒 0）。
       * `source` = 本次消费来源（pass/credit/none/unknown）。
       */
      event: 'card_counter';
      userId: string;
      roomCode: string;
      active: boolean;
      source?: 'pass' | 'credit' | 'none' | 'unknown';
    };

/** §6.2 的 S→C 推送信封：`{ version, payload }`，没有 `seq`。 */
function envelope(version: number, payload: unknown): { version: number; payload: unknown } {
  return { version, payload };
}

/**
 * 该连接**已写入**的连接级 id（`socket.data.traceId`，握手通过内部 token 校验后才写）。
 *
 * **最终评审 I2**：连接生命周期族的行用它进 ALS。拿不到（拒握手路径、或上游没传）
 * 就 `null` —— R1107：无来源不编造（`source` 仍如实标 `edge`，见各调用点）。
 */
function traceIdOf(socket: Socket): string | null {
  const value = (socket.data as { traceId?: unknown } | undefined)?.traceId;
  return typeof value === 'string' ? value : null;
}

/**
 * `game.current_turn` 的载荷（§6.3）。
 *
 * 行动者的判定（§9.4 / 玩法 §9.1）：叫抢阶段是 `bidPhase.currentBidder`，
 * 出牌阶段才是 `currentPlayer`。
 */
export function currentTurnPayload(view: GameView): { seat: number; timeoutMs: number } {
  return {
    seat: view.state === 'bidding' ? view.bidPhase.currentBidder : view.currentPlayer,
    timeoutMs: Math.max(0, view.turnDeadlineAt - Date.now()),
  };
}

/**
 * room-service 的 socket.io 网关 —— **唯一**允许 `emit` 到 `/ws/ddz` 的服务（§4.1）。
 *
 * 三处此前的致命缺陷在本文件被修掉（A.2 A3）：
 *  1. `private readonly io = new Server()` 是**脱离 HTTP server 的独立实例**，
 *     发出的消息到不了任何客户端 → 改用 `@WebSocketServer()` 注入的实例；
 *  2. **没有任何 `@SubscribeMessage`** → 现在每条契约消息都有处理入口；
 *  3. `handleInternalConnect()` 在生产路径上 **0 次调用**，`socket.data.userId`
 *     恒为 `undefined` → 身份改由**握手 `auth`** 在 `handleConnection` 中写入。
 */
@Injectable()
@WebSocketGateway({
  cors: true,
  namespace: '/ws/ddz',
  path: '/socket.io/',
  // §6.1：只用 socket.io 内置心跳；应用层 ping/pong 已删除
  pingInterval: 30000,
  pingTimeout: 90000,
})
export class WsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  private readonly logger = new Logger(WsGateway.name);

  /** 由 Nest 注入的、真正挂在 HTTP server 上的 socket.io 实例（不是 new Server()）。 */
  @WebSocketServer()
  server!: Server;

  /** Maps userId → Socket for active connections. */
  readonly activeConnections = new Map<string, Socket>();
  /** Maps `${roomCode}:${seat}` → userId，投递 `seatViews` 时用。 */
  readonly seatOwners = new Map<string, string>();

  /** 独立的订阅连接：subscriber 模式下连接不能执行普通命令。 */
  private readonly gameEventsRedis: Redis;
  private readonly matchEventsRedis: Redis;
  private readonly game: GameClient;
  /** §9.6 归池：局终把 `botId` 交还机器人池。**由容器注入**（见 ROBOT_CLIENT 的说明）。 */
  private readonly robot: RobotClient;
  /** 记录片 T5：局终组装 + 投递 `record.write`。**由容器注入**（见 RECORD_CLIENT 的说明）。 */
  private readonly record: RecordClient;

  constructor(
    private readonly redis: Redis,
    private readonly matchService: MatchService,
    private readonly reconnectService: ReconnectService,
    private readonly roomsService: RoomsService,
    /** 本片（spec §3.3 / R902）：入座后房间满 ⇒ 同步触发开局（与扫描器共用同一条链）。 */
    private readonly roomStartService: RoomStartService,
    @Inject(GAME_CLIENT) game: GameClient,
    @Inject(ROBOT_CLIENT) robot: RobotClient,
    /** 记录片 T5：第 8 个参数（`toHaveLength(8)` 由 wiring 门禁钉住）。 */
    @Inject(RECORD_CLIENT) record: RecordClient,
    /**
     * ② 金币场 T4：第 9 个参数 —— `room.match` 双开关（C1/C2）经 `routerDeps()` 下传，
     * 与 `MatchService` / `RoomsService` 注入的是**同一个**快照单例（模块实例去重）。
     */
    private readonly configCache: ConfigCacheService,
    /**
     * ② 金币场 T4：第 10 个参数 —— 金币场门槛（C4）的 `currency.get` 读边；
     * 由 `CurrencyModule` 提供（`WsModule` 已 import 它）。
     */
    private readonly currency: CurrencyClient,
    /**
     * ② 金币场 T5：第 11 个参数 —— 结算例程（`finalizeRoomEnd` 的 :809 位调用它；
     * 构造期还把 `game.balances` 的广播回调绑给它 —— 见下方 `bindBroadcast`）。
     * 由 `CurrencyModule` 提供（同一个单例：sweeper 晚到的收尾也用同一条回调）。
     */
    private readonly settleService: SettleService,
    /**
     * 风控 T3：第 12 个参数 —— `risk.deviceReport` 客户端（`room.match` 入队成功后
     * fire-and-forget 上报；经 `routerDeps()` 下传给 `handleMatch`）。
     * ⚠️ **类 token + 值导入**（DI 陷阱纪律：元数据要用运行期类引用 —— `import type`
     * 会让容器启动即崩而单测全绿）；`toHaveLength(12)` 与下标身份由
     * `ws.module.wiring.test.ts` 钉住。
     */
    private readonly risk: RiskClient,
    /**
     * 昵称片：第 13 个参数 —— 房间昵称缓存（`routerDeps()` 下传给 `buildRoomPlayers`）。
     * `toHaveLength(13)` 与下标身份由 `ws.module.wiring.test.ts` 钉住。
     */
    private readonly nicknames: RoomNicknamesService,
  ) {
    this.game = game;
    this.robot = robot;
    this.record = record;
    // ② T5：`game.balances` 的广播实现挂点在 ws 层（结算例程与 sweeper 共用同一条回调）。
    // 闭包在**调用时**解析 `this.server`（Nest 装配后才赋值）—— 构造期绑定是安全的。
    // 多玩法（Task 2.5）：pdk 条目带 `meta={gameType,playerCount}`（N 座广播）；ddz 旧形状不变。
    this.settleService.bindBroadcast((roomCode, version, balances, meta) =>
      this.broadcast(roomCode, 'game.balances', version, {
        balances,
        ...(meta === undefined ? {} : { gameType: meta.gameType, playerCount: meta.playerCount }),
      }),
    );
    this.gameEventsRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.matchEventsRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    for (const conn of [this.gameEventsRedis, this.matchEventsRedis]) {
      conn.on('error', (err: Error) => {
        // 最终评审 I2：订阅连接的回调是**内部事件**（没有对应的客户端请求）⇒
        // `source: 'internal'` + 不编造 id —— 原先这行落在 ALS 之外 ⇒ `bootstrap`（假话）。
        runWithTrace({ traceId: null, source: 'internal' }, () =>
          this.logger.error(`Redis subscriber error: ${err.message}`),
        );
      });
    }
  }

  /** §7.3 偏差 A4/A5：匹配循环与对局事件订阅此前从未被调用。 */
  onModuleInit(): void {
    this.matchService.startMatchingLoop();
    void this.subscribeToGameEvents();
    void this.subscribeToMatchEvents();
  }

  // ─── 连接生命周期（§5.2 身份载体）────────────────────────────────

  /**
   * 握手鉴权。
   *
   * 上游（api-gateway 的 WS 代理）在 `auth` 中携带
   * `{ userId, internalToken, traceId }`；room-service 校验内部密钥后
   * 把 `userId` 写入 `socket.data.userId`。
   *
   * **风控 T3**：`auth` 另可带 `clientIp`（网关下游握手注入的可信客户端 IP，
   * 规格 §2.9-1）—— 形状校验通过才写 `socket.data.clientIp`（见 `handleConnectionInner`）。
   *
   * **room-service 绝不从消息载荷中取身份**（§5.2）。
   *
   * ⚠️ **最终评审 I2**：本族的行（`Client connected` / 拒握手 / 断线 / 续期）原先
   * 落在**任何 ALS 之外** ⇒ 渲染成 `source: 'bootstrap'`（含义是「进程启动早期」）——
   * 那是**假话**（R1107 禁止的伪装形态）。这里**只加包裹**：判定逻辑、顺序、早返回
   * 逐字搬进 `handleConnectionInner`。
   *
   * ⚠️ 外层刻意用 `traceId: null` 而**不是** `auth.traceId`：此刻内部 token 还没校验，
   * `auth.traceId` 可能是**任意客户端**塞的 —— 而 `traceId` 不过脱敏器（它被假定为
   * 我们生成的 uuid）⇒ 采信它等于把 I1 的洞换个字段再开一次（客户端拿
   * `auth.traceId: "13912345678"` 就能打红判据 8 的采样）。拒握手路径「拿不到 id」
   * ⇒ `traceId: null`，但 `source` 如实标 `edge`（那确实是一次**边缘**连接尝试）。
   */
  handleConnection(socket: Socket): Promise<void> {
    return runWithTrace({ traceId: null, source: 'edge' }, () => this.handleConnectionInner(socket));
  }

  /** ALS 包裹外的那一层：与 `handleConnection` 同一实现，逐字搬自原方法体。 */
  private async handleConnectionInner(socket: Socket): Promise<void> {
    const auth = (socket.handshake?.auth ?? {}) as {
      userId?: string;
      internalToken?: string;
      traceId?: string;
      clientIp?: unknown;
    };
    const expected = process.env.INTERNAL_SERVICE_TOKEN;

    // R94（fail-closed，与 HTTP 侧 R89 逐字同义）：`expected` 未配置 ⇒ **一律拒**。
    // 旧形状 `!auth.internalToken || (expected && auth.internalToken !== expected)`
    // 在未配置时第二个合取项恒为 `false` ⇒ 任意非空 `internalToken` 都通过
    // （本服务未配置时 R89 会让它起不来，所以线上够不着 —— 但形状自相矛盾，
    //  下一次重构就会把它变成真漏洞，故收敛成与中间件同一句判定）。
    if (!expected || auth.internalToken !== expected) {
      this.logger.warn(`Rejecting unauthenticated socket ${socket.id}`);
      socket.disconnect(true);
      return Promise.resolve();
    }
    if (!auth.userId) {
      this.logger.warn(`Rejecting socket ${socket.id} without userId`);
      socket.disconnect(true);
      return Promise.resolve();
    }

    socket.data.userId = auth.userId;
    socket.data.traceId = auth.traceId ?? null;
    /**
     * **风控 T3（规格 §2.9-1 / C12）**：`auth.clientIp` = 网关下游握手注入的**可信**
     * 客户端 IP（取连接槽位、由网关的唯一可信解析面产出 —— `auth` 由网关构造，
     * 客户端的值不可达）。形状校验：string、长度 1..64、≠`'unknown'`（网关对
     * `'unknown'`/缺失**不注入**）；非法**丢弃**——不写该字段 = `match:meta` 的
     * `ip` 缺省（谓词侧 fail-open 的读取面）。
     */
    const clientIp = auth.clientIp;
    if (
      typeof clientIp === 'string' &&
      clientIp.length > 0 &&
      clientIp.length <= 64 &&
      clientIp !== 'unknown'
    ) {
      socket.data.clientIp = clientIp;
    }
    /**
     * ⚠️ 把**已收窄**的 `userId` 提成局部常量：TS 的**属性收窄不会延续进下面的闭包**
     * （箭头函数体里 `auth.userId` 又退回 `string | undefined` ⇒ `tsc` 报 TS2345）。
     * 这条**只在 `tsc` 下可见**（vitest 不做类型检查）—— 门禁的 lint 阶段才是那条闸。
     */
    const userId = auth.userId;

    /**
     * **内层嵌套**（最终评审 I2）：**通过内部 token 校验之后**，`auth.traceId` 才是
     * 可信的连接级 id（它来自我们的网关）⇒ 用 `socket.data.traceId` 覆盖余下处理 ——
     * `Client connected` 与 `Reconnect record refreshed` 因此带上**该连接**的 id
     * （与网关侧、与消息入口的 ALS 是**同一个**，判据 6′ 的两侧一致靠它）。
     * ⚠️ 这也是「复核⑫ 的那句话为什么过期」：复核⑫ 说的是**当时**（没有任何包裹时）
     * 断线行是 `null` + `bootstrap` —— 差别在「有没有包」，不在 ALS 的语义。
     */
    return runWithTrace({ traceId: traceIdOf(socket), source: 'edge' }, async () => {
      const previous = this.activeConnections.get(userId);
      this.activeConnections.set(userId, socket);
      // 玩家管理页（2026-10-22）：在线 presence best-effort —— 不阻塞连接生命周期。
      void this.touchPresence(userId);
      socket.conn.on('heartbeat', () => {
        void this.touchPresence(userId);
      });
      /**
       * 监控片（规格 §2.2 / C10）：`ws_connections` 的 **inc 点**。
       *
       * 位置 = **鉴权通过 + 注册完成之后**（两条拒握手路径已在上面早返、不计入）。
       * 🔴 `!previous` 的守卫是「恰一次」的另一半：`previous` 存在 = 硬换手
       *（:295-312 那种「旧连接从未被观测到断开」的顶替）——该用户的一条逻辑连接
       * **已在册**，这里再加一就会让 gauge 每次换链路抬高 1 且永远降不回去
       *（旧的断线事件随后走「陈旧断线」早返、不 dec）。成对的判据见
       * `ws.gateway.test.ts` 的「硬换手不双计 / 陈旧断线不误减」。
       */
      if (!previous) wsConnections.inc();
      this.logger.log(`Client connected: ${socket.id} (user: ${userId})`);

      /**
       * ② 连接补推（片⑦ 修复 · slice12-race-fix-design §1；本片泛化为 resolver 存活候选，
       * 规格 v1.1 §2.4）：位置在 `activeConnections.set` **之后**、hard-handover 早返回
       * **之前** —— **两个分支共用**（硬中断换链路的新连接同样可能是错过开局的那一个）。
       * 失败方向由 `replayActiveGame` 自己兜底（fail-open），这里**不需要** catch。
       */
      await this.replayActiveGame(userId, socket);

      if (previous && previous !== socket) {
        // §6.6.1 刷新时机 5：**新连接建立，而该玩家的上一个连接从未被观测到断开**
        // （硬网络中断 —— 服务端还没收到 disconnect 新连接就到了）。
        // 这不是「重连」而是同一在线会话换链路 → 刷新在线观测点（记录时刻归最新连接）。
        return this.touchReconnectRecord(userId, socket.id, 'hard handover');
      }
      return Promise.resolve();
    });
  }

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
      if (!room) return;
      const roomSeat = room.players.find((p) => p.userId === userId)?.seat ?? -1;
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
      // 多玩法（Task 2.2 / spec §4.6.2）：连接补推同样带玩法/人数（新客户端据此恢复 board）；
      // 旧房间形状（fixture/部署窗口缺 gameType）不凭空补 —— 客户端按 doudizhu/3 缺省。
      socket.emit(
        'room.matched',
        envelope(0, {
          roomCode,
          seat: pushSeat,
          ...(room.gameType === undefined
            ? {}
            : { gameType: room.gameType, playerCount: room.maxPlayers }),
        }),
      );
      // 记牌器收费片：连接补推也要带本局开通状态（fail-open：读失败只 warn）。
      try {
        const status = await readCardCounterStatus(this.redis, roomCode, pushSeat);
        if (status !== null) emitCardCounterStatus(socket, status);
      } catch (err) {
        this.logger.warn(
          `card_counter replay failed for ${userId} in ${roomCode}: ${String(err)}`,
        );
      }
      this.logger.log(
        `Game resumption pushed for ${userId} → ${roomCode}@${pushSeat} (status=${status}, source=${source})`,
      );
    } catch (err) {
      /**
       * 裁决 C：resolver 读失败等 ⇒ **fail-open + WARN**（内层 ALS 已给出该连接的
       * traceId 与 `source: 'edge'`）—— **不得**让 `handleConnection` 的 promise reject。
       */
      this.logger.warn(`Match hand-off replay failed for ${userId}: ${String(err)}`);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    /**
     * **最终评审 I2**：断线回调起于 `runWithTrace` 之外 ⇒ 本族的三行
     * （`Client disconnected` / `Ignoring stale disconnect` / 记录刷新）原先被渲染成
     * `source: 'bootstrap'`（「启动早期」= 假话）。连接级 id 就躺在 `socket.data.traceId` 里
     * （握手时写入）⇒ 包一层即可，判定逻辑与早返回逐字保留。
     */
    return runWithTrace({ traceId: traceIdOf(socket), source: 'edge' }, () =>
      this.handleDisconnectInner(socket),
    );
  }

  /** ALS 包裹外的那一层：与 `handleDisconnect` 同一实现，逐字搬自原方法体。 */
  private async handleDisconnectInner(socket: Socket): Promise<void> {
    const userId = (socket.data as { userId?: string }).userId;
    if (!userId) {
      this.logger.log(`Client disconnected: ${socket.id} (user: unknown)`);
      return;
    }

    // 迟到的旧连接断开：此时 `activeConnections` 已指向新连接。
    // 既不能覆盖新记录的 `connectedAt`（在线观测点应属于**最新**连接；迟到写入会把
    // 记录回指已死的 socket），也不能清掉新连接刚恢复的投递链路。
    if (this.activeConnections.get(userId) !== socket) {
      this.logger.log(`Ignoring stale disconnect from ${socket.id} (user: ${userId})`);
      return;
    }

    this.activeConnections.delete(userId);
    void this.clearPresence(userId);
    /**
     * 监控片（规格 §2.2 / C10）：`ws_connections` 的 **dec 点**（与 inc 成对恰一次）。
     * 位置在「陈旧断线」早返（:416-422 一带）**之后** —— 旧连接的迟到断线不得误减
     * （它的顶替连接还在册）；握手被拒的连接也从未 inc 过（更走不到这里）。
     */
    wsConnections.dec();
    for (const [key, owner] of this.seatOwners) {
      if (owner === userId) this.seatOwners.delete(key);
    }
    this.logger.log(`Client disconnected: ${socket.id} (user: ${userId})`);

    // §6.6.1 刷新时机 4：**在线观测点在此刷新** —— 服务端观测到断线的那一刻（不是 `room.join`）。
    await this.touchReconnectRecord(userId, socket.id, 'disconnect');
  }

  /** 在线 presence 写入（best-effort：Redis 失败只 warn，不影响连接主流程）。 */
  private async touchPresence(userId: string): Promise<void> {
    try {
      await this.redis.zadd(ONLINE_USERS_KEY, Date.now(), userId);
    } catch (err) {
      this.logger.warn(`presence touch failed for ${userId}: ${String(err)}`);
    }
  }

  /** 在线 presence 清除（best-effort，同上）。 */
  private async clearPresence(userId: string): Promise<void> {
    try {
      await this.redis.zrem(ONLINE_USERS_KEY, userId);
    } catch (err) {
      this.logger.warn(`presence clear failed for ${userId}: ${String(err)}`);
    }
  }

  /**
   * 刷新 `reconnect:active` 的**在线观测点**（§6.6.1；窗口退役后其含义见规格 §2.7）。
   *
   * 失败不得影响连接生命周期本身 —— 因此这里吞掉异常并记日志。
   * 玩家从未入房时 `touch()` 是 no-op（不写无用键）。
   */
  private async touchReconnectRecord(userId: string, socketId: string, reason: string): Promise<void> {
    try {
      const record = await this.reconnectService.touch(userId, socketId);
      if (record) {
        this.logger.log(
          `Reconnect record refreshed for ${userId} (${reason}) → room ${record.roomCode} @ ${record.connectedAt}`,
        );
      }
    } catch (err) {
      this.logger.error(`Failed to refresh reconnect record for ${userId} (${reason}): ${String(err)}`);
    }
  }

  // ─── 投递链路恢复（§6.6.1 / 缺陷 B-d）──────────────────────────

  /**
   * **「重连成功」的定义包含投递链路恢复**（§6.6.1）。
   *
   * `handleDisconnect` 已经把该玩家的 `seatOwners` 全部清掉、socket 也离开了房间；
   * 只回快照而不重登记，玩家在 ack 之后**收不到任何后续推送** ——
   * 「状态与服务端一致」只在 ack 那一刻成立，紧接着就失真。
   *
   * 因此：`socket.join(roomCode)` + 按 `PlayerView.seat` 重登记
   * `seatOwners[`${roomCode}:${seat}`]`。
   */
  async restoreDelivery(socket: Socket, view: GameView): Promise<void> {
    const userId = (socket.data as { userId?: string }).userId;
    if (!userId) {
      this.logger.error(`Cannot restore delivery for socket ${socket.id}: socket has no identity`);
      return;
    }
    await socket.join(view.roomCode);
    this.seatOwners.set(`${view.roomCode}:${view.seat}`, userId);
    this.logger.log(`Delivery restored: ${userId} → ${view.roomCode}:${view.seat} (socket ${socket.id})`);
  }

  // ─── C→S 消息（§6.3）：ack 承载响应 ──────────────────────────────

  @SubscribeMessage('room.match')
  onRoomMatch(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'room.match', body);
  }

  @SubscribeMessage('room.unmatch')
  onRoomUnmatch(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'room.unmatch', body);
  }

  /**
   * 机器人补位开关片：玩家在 `match.wait_prompt` 弹窗上点「延长匹配时间」（空 payload）。
   *
   * ⚠️ **合并期补上**：本文件用**逐条 `@SubscribeMessage`**（不是泛型转发），而 177 行附近的
   * 不变式要求「每条契约消息都有处理入口」。本片只加了 `message.router.ts` 的 `case` 与
   * protocol 的校验分支，**漏了这一个装饰器** ⇒ 网关根本不会订阅该事件名、router 的 case
   * 永远不可达（api-gateway 侧是泛型转发 `CLIENT_MESSAGE_TYPES`，所以那一跳没问题）。
   */
  @SubscribeMessage('room.match.extend')
  onRoomMatchExtend(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'room.match.extend', body);
  }

  @SubscribeMessage('room.join')
  onRoomJoin(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'room.join', body);
  }

  @SubscribeMessage('room.leave')
  onRoomLeave(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'room.leave', body);
  }

  @SubscribeMessage('game.bid')
  onGameBid(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'game.bid', body);
  }

  @SubscribeMessage('game.play')
  onGamePlay(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'game.play', body);
  }

  @SubscribeMessage('game.pass')
  onGamePass(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'game.pass', body);
  }

  @SubscribeMessage('game.reconnect')
  onGameReconnect(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'game.reconnect', body);
  }

  /** §6.5：`13004` 的唯一恢复通道（重新拉取裁剪快照），与 `game.reconnect` 语义不同。 */
  @SubscribeMessage('game.resync')
  onGameResync(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'game.resync', body);
  }

  /**
   * 挂机治理 T6（C19）：客户端托管按钮（`{on}`；`via` 由 router 补齐为 `'manual'`）。
   *
   * ⚠️ 这条装饰器是**接线的一半**：缺了它 socket.io 不订阅 `game.trustee` 事件，
   * router 的 case 永远不可达（机器人补位片真实咬过的形态；`client-message-wiring.gate.test.ts`
   * 的腿①逐条扫描本文件，缺一即红）。
   */
  @SubscribeMessage('game.trustee')
  onGameTrustee(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack | undefined> {
    return this.handle(socket, 'game.trustee', body);
  }

  /**
   * 统一入口：把消息交给纯函数路由，并**返回 ack**。
   *
   * Nest 的 `@SubscribeMessage` 返回值即 socket.io 的 ack 回调载荷（§6.2）。
   *
   * ⚠️ `type` 由 socket.io 的**事件名**承载，Nest 只把请求体交给处理器 ——
   * 因此事件名必须显式传给校验器（§6.2 的线格式本就是扁平的，
   * `validateClientMessage(type, body)` 的签名即为此）。
   */
  private async handle(socket: Socket, type: string, body: unknown): Promise<Ack | undefined> {
    const response = await this.handleMessage(socket, type, body);
    // 网关代理用「correlation id 作为事件名」把 ack 运回客户端
    // （socket.io 的 ack 回调对代理方不可见）。直连客户端没有这个字段，
    // 于是照常走 socket.io 的 ack 回程。
    const correlationId =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)[CORRELATION_KEY]
        : undefined;
    if (typeof correlationId === 'string' && correlationId.length > 0) {
      socket.emit(correlationId, response);
      return undefined;
    }
    return response;
  }

  /** 与 `handle()` 同一实现，供测试直接调用。 */
  async handleMessage(socket: Socket, type: string, body: unknown): Promise<Ack | undefined> {
    let captured: Ack = { code: ErrCode.OK };
    const result = await routeClientMessage(socket, this.routerDeps(), type, body, (ack) => {
      captured = ack;
    });
    return result ?? captured;
  }

  private routerDeps(): RouterDeps {
    return {
      redis: this.redis,
      rooms: this.roomsService,
      roomStart: this.roomStartService,
      match: this.matchService,
      reconnect: this.reconnectService,
      game: this.game,
      // ② 金币场 T4：`handleMatch` 的两条新依赖（开关读面 + 门槛读边）。
      configCache: this.configCache,
      currency: this.currency,
      // 风控 T3：`handleMatch` 入队成功后的 `risk.deviceReport` 上报边。
      risk: this.risk,
      // 昵称片：`buildRoomPlayers` 的唯一昵称来源。
      nicknames: this.nicknames,
      logger: this.logger,
      onSeatOwners: (roomCode, seats) => {
        for (const { userId, seat } of seats) this.seatOwners.set(`${roomCode}:${seat}`, userId);
      },
      onSeatLeft: (roomCode, userId) => {
        for (const [key, owner] of this.seatOwners) {
          if (owner === userId && key.startsWith(`${roomCode}:`)) this.seatOwners.delete(key);
        }
      },
      onRoomStateChanged: (roomCode, status, players, info) => {
        // 昵称片 · 设计 D6：房间消息不参与对局 version 判定 ⇒ version 沿用
        // `room.matched` 的 0。
        // 多玩法（Task 2.2 / spec §4.6.2）：随带 gameType/playerCount，新客户端据此选 board。
        this.server?.to(roomCode).emit(
          'room.state_update',
          envelope(0, {
            status,
            players,
            ...(info === undefined ? {} : { gameType: info.gameType, playerCount: info.playerCount }),
          }),
        );
      },
      onReconnected: (socket, view) => this.restoreDelivery(socket, view),
    };
  }

  // ─── S→C 推送（§4.4 / §6.3 / §6.7）─────────────────────────────

  /** game-service → room-service：`game:events`（唯一推送通路）。 */
  async subscribeToGameEvents(): Promise<void> {
    /**
     * **最终评审 I2**：Redis 订阅是**内部事件**（没有对应的客户端请求）⇒
     * `{traceId: null, source: 'internal'}` —— 不编造 id，但来源**如实**。
     * 原先这些行（含 `Invalid game event from Redis`）落在 ALS 之外 ⇒ `bootstrap`（假话）。
     */
    return runWithTrace({ traceId: null, source: 'internal' }, async () => {
      await this.gameEventsRedis.subscribe(GAME_EVENTS_CHANNEL);
      this.gameEventsRedis.on('message', (channel: string, raw: string) => {
        if (channel !== GAME_EVENTS_CHANNEL) return;
        // ⚠️ 回调**不在**上面那层包裹的作用域里（ioredis 的事件循环自有其异步上下文，
        // ALS 按「谁发起的」传播）⇒ 处理器内部**再包一次**，否则这几行仍旧是 bootstrap。
        runWithTrace({ traceId: null, source: 'internal' }, () => {
          let event: GameEvent;
          try {
            event = JSON.parse(raw) as GameEvent;
          } catch {
            this.logger.error('Invalid game event from Redis');
            return;
          }
          this.onGameEvent(event);
        });
      });
      this.logger.log(`Subscribed to ${GAME_EVENTS_CHANNEL}`);
    });
  }

  /** 匹配循环 → room-service：`match:events`，用于下发 `room.matched`（§8.2）。 */
  async subscribeToMatchEvents(): Promise<void> {
    // 最终评审 I2：与 `subscribeToGameEvents` 同形（内部事件 ⇒ 不编造 id、来源如实）。
    return runWithTrace({ traceId: null, source: 'internal' }, async () => {
      await this.matchEventsRedis.subscribe(MATCH_EVENTS_CHANNEL);
      this.matchEventsRedis.on('message', (channel: string, raw: string) => {
        if (channel !== MATCH_EVENTS_CHANNEL) return;
        // ⚠️ 与上面同一条理由：回调的执行不在注册时的 ALS 作用域里 ⇒ 内部再包一次。
        runWithTrace({ traceId: null, source: 'internal' }, () => {
          let event: MatchEvent;
          try {
            event = JSON.parse(raw) as MatchEvent;
          } catch {
            this.logger.error('Invalid match event from Redis');
            return;
          }
          this.onMatchEvent(event);
        });
      });
      this.logger.log(`Subscribed to ${MATCH_EVENTS_CHANNEL}`);
    });
  }

  /**
   * §8.2：匹配成功后必须**主动**向每名人类玩家下发 `room.matched { roomCode, seat }`。
   * 客户端在此之前不知道 `roomCode`，所以不能用 `room.join` 的 ack 作为通知手段。
   *
   * R46：匹配超时（`12007`）经同一条通道下发为 `system.error`
   * —— 它是「非请求触发的系统错误」（§6.3），且客户端 `CLIENT_ACTION[12007] = TOAST`。
   * 超时票由匹配器**逐票**选出（R57），因此这里只会通知真正超时的那几个人。
   */
  onMatchEvent(event: MatchEvent): void {
    if (event.event === 'match.timeout') {
      for (const playerId of event.playerIds) {
        this.activeConnections
          .get(playerId)
          ?.emit('system.error', envelope(0, { code: event.code, message: event.message }));
      }
      this.logger.log(`match.timeout sent to ${event.playerIds.length} player(s)`);
      return;
    }

    // 机器人补位开关片：等待提示（匹配级、非终止；version 恒 0，不参与对局版本判定）。
    if (event.event === 'match.wait_prompt') {
      for (const playerId of event.playerIds) {
        this.activeConnections
          .get(playerId)
          ?.emit('match.wait_prompt', envelope(0, { message: event.message }));
      }
      this.logger.log(`match.wait_prompt sent to ${event.playerIds.length} player(s)`);
      return;
    }

    // 多玩法（Task 2.4 / spec RH3-b）：pdk 开局失败的重试/取消警告 —— 定向 `system.warning`。
    if (event.event === 'system_warning') {
      for (const playerId of event.playerIds) {
        this.activeConnections
          .get(playerId)
          ?.emit('system.warning', envelope(0, { code: event.code, message: event.message }));
      }
      this.logger.log(`system.warning sent to ${event.playerIds.length} player(s)`);
      return;
    }

    // 记牌器收费片：定向发本局开通状态（房间级、version 恒 0）。
    if (event.event === 'card_counter') {
      this.activeConnections.get(event.userId)?.emit('game.card_counter', envelope(0, {
        roomCode: event.roomCode,
        active: event.active,
        ...(event.source === undefined ? {} : { source: event.source }),
      }));
      this.logger.log(
        `game.card_counter sent to ${event.userId} for ${event.roomCode} (active=${String(event.active)})`,
      );
      return;
    }

    for (const { userId, seat } of event.seats) {
      this.seatOwners.set(`${event.roomCode}:${seat}`, userId);
      this.activeConnections.get(userId)?.emit(
        'room.matched',
        envelope(0, {
          roomCode: event.roomCode,
          seat,
          // 多玩法（Task 2.2）：旧 producer 的事件缺字段 ⇒ 不凭空补（客户端有缺省）。
          ...(event.gameType === undefined ? {} : { gameType: event.gameType }),
          ...(event.playerCount === undefined ? {} : { playerCount: event.playerCount }),
        }),
      );
    }
    this.logger.log(`room.matched sent for ${event.roomCode} (${event.seats.length} players)`);
  }

  /**
   * 翻译规则（§4.4 的表，**这是开局推送的唯一生产者，不可省略**）：
   *
   * | 收到 | 发出 |
   * |------|------|
   * | `game.started`       | `game.deal` + `game.current_turn` |
   * | `game.state_updated` | `game.state_update` + `game.current_turn` |
   * | `game.ended`         | `game.finished` + `game.settlement` |
   *
   * room-service **不做任何业务判断**：seatViews 已由 game-service 按座位裁剪好。
   *
   * ⚠️ **唯一**的例外（N17/R187）：`view.state === 'ended'` 时**只发** `game.state_update`，
   * 不发 `game.current_turn` —— 终局没有「下一回合」。
   */
  onGameEvent(event: GameEvent): void {
    if (event.event === 'game.ended') {
      // 监控片（规格 §2.2）：结算计数 —— 本分支每条事件恰一次（与 ws_connections 不同，
      // 这里没有特殊路：game.ended 只会经 `game:events` 订阅进来一次）。
      gamesEndedTotal.inc();
      const result = event.result;
      const finishedPayload =
        result && isPdkSettlementResult(result)
          ? { gameType: 'paodekuai' as const, winnerSeats: result.winnerSeats }
          : { winner: result?.winner ?? ('landlord' as const) };
      this.broadcast(event.roomCode, 'game.finished', event.version, finishedPayload);
      if (result) this.broadcast(event.roomCode, 'game.settlement', event.version, result);
      // §9.6 归池（R207）+ 记录片 T5（设计 D2）：**局终内务链** —— 顶部读一次
      // `room:{code}:bots`（座位对齐）供归池与记录组装**共用** ⇒ 归池、组装、投递。
      // 整链 fire-and-forget，**不阻塞**广播（局终推送是客户端的可见路径；内务失败只记日志）。
      //
      // 🔴 2026-10-22 机器人昵称片：本调用必须**先于** `updateStatus('finished')`。
      // `finalizeRoomEnd` 的同步前缀会先发出昵称 Hash 的 `hgetall`；reaper 对 finished
      // 房间会立即 `deleteRoom`（删除集含 `nicknamesKey`）—— 谁先写 finished，谁就可能
      // 让昵称快照读成空（历史页间歇性「玩家N」）。
      void this.finalizeRoomEnd(event, result);
      // §3.1 / N31（R452）：终局 ⇒ 房间进终态。**这是 `finished` 的唯一写入点**。
      // `roomsService` 已在构造函数注入（见本文件 constructor）。
      // ⚠️ 必须挂 `.catch`：这是一条 fire-and-forget 的 Promise，而 `updateStatus` 在房间键
      //    已过期/不存在时**会 reject**（`12001`）。Node 对未处理的 rejection 默认直接终止
      //    进程（`--unhandled-rejections=throw`）⇒ 一条迟到的 `game.ended` 就能把
      //    room-service 打成 crash-loop。与下面 `releaseRobots` 的 try/catch 同一族处置。
      void this.roomsService
        .updateStatus(event.roomCode, 'finished')
        .catch((err: unknown) =>
          this.logger.error(`Failed to mark room ${event.roomCode} finished: ${String(err)}`),
        );
      // N35/R521：终局 ⇒ 派生键不再有意义（§6.4 规则 3 是「**仅对局中**下发」）⇒ 立即删掉，
      // 不留一份终局后的陈旧张数。读侧 `buildRoomPlayers()` 也已按 `status === 'playing'` 设闸，
      // 这里是**纵深防御**（也让 N31 的房间回收少一个要猜的键）。
      void this.redis
        .del(cardCountKey(event.roomCode))
        .catch((err: unknown) =>
          this.logger.error(
            `Failed to clear card counts for room ${event.roomCode}: ${String(err)}`,
          ),
        );
      return;
    }

    const type = event.event === 'game.started' ? 'game.deal' : 'game.state_update';
    for (const view of event.seatViews ?? []) {
      const owner = this.seatOwners.get(`${view.roomCode}:${view.seat}`);
      const socket = owner ? this.activeConnections.get(owner) : undefined;
      if (!socket) continue;
      this.emitToSeat(socket, type, envelope(event.version, view));
      // N17/R187：终局**没有**「下一回合」⇒ 不发 `game.current_turn`。
      // 否则客户端会在 `state==='ended'` 之后收到一条 `currentTurnPayload()` 算出来的
      // 假 `timeoutMs`（它读的是已经不再推进的 `turnDeadlineAt`）。
      if (view.state === 'ended') continue;
      this.emitToSeat(socket, 'game.current_turn', envelope(event.version, currentTurnPayload(view)));
    }

    // N35/R521：把**已收到**的 `seatViews` 投影成 `room:{code}:cardcount`（§10.1 的派生键）。
    // 放在投递循环**之后**：键是内务，不得拖慢客户端可见路径。
    // fire-and-forget + `.catch`：与上面 `updateStatus` / `releaseRobots` 同族处置 ——
    // 一条未处理的 rejection 会把 room-service 打成 crash-loop（Node 默认 `throw`）。
    void this.writeCardCounts(event).catch((err: unknown) =>
      this.logger.error(`Failed to write card counts for room ${event.roomCode}: ${String(err)}`),
    );
  }

  /**
   * **N35 / R521**：`game.started` / `game.state_updated` ⇒ 写 `room:{code}:cardcount`。
   *
   * 为什么由 room-service 写：它**本来就收到** `event.seatViews`（含权威的
   * `PlayerView.cardCounts`）⇒ 键的属主不变，**不需要**新增「game-service 写别人的键」
   * 这条跨服务路径（R521）。缺的从来只是写入方（读侧与它的用例早就存在）。
   *
   * ⚠️ field 必须是**真实 `userId`**（不是出站掩码 `seat-N`）：读侧 `buildRoomPlayers()`
   *    用的就是 `room.players[].userId`，写成掩码会让读侧永远查不到（N35 换个形态复现）。
   * ⚠️ 用**对象形态** `hset(key, {...})`：本仓假 Redis 只支持 `(key,field,value)` 与 `(key,obj)`
   *    两种 —— 可变参数形态会**静默只写一个字段**（替身的宽容度就是对缺陷的容忍度）。
   * ⚠️ Hash **不继承 TTL**（P3/N9 的教训）⇒ 必须显式 `EXPIRE`，否则这个键永不过期。
   */
  private async writeCardCounts(event: GameEvent): Promise<void> {
    const views = event.seatViews ?? [];
    if (views.length === 0) return;
    // §6.4：`cardCounts` 是**按座位索引**的三家张数，每条视图里都相同 ⇒ 取第一条即可。
    const counts = views[0]!.cardCounts;
    const fields: Record<string, string> = {};
    for (const view of views) {
      const owner = this.seatOwners.get(`${event.roomCode}:${view.seat}`);
      const count = counts[view.seat];
      if (owner !== undefined && Number.isInteger(count)) fields[owner] = String(count);
    }
    if (Object.keys(fields).length === 0) return;
    const key = cardCountKey(event.roomCode);
    await this.redis.hset(key, fields);
    await this.redis.expire(key, ROOM_TTL_SECONDS);
  }

  /**
   * 记录片 T5（设计 D1/D2）：**局终内务链** —— 一次 bots 读 → 归池 + 记录组装投递。
   *
   * 🔴 读时机写死（r3-2）：`room:{code}:bots` 在**本方法顶部读一次**、按**座位号对齐**
   *（`readBotSeatMap`），供归池与记录组装**共用** —— 归池末尾会 `DEL` 这张表
   *（fire-and-forget），晚读会静默取到空（无任何跳过/WARN，绑定关系无声丢失）。
   * ⚠️ 现有 `readBotBindings` 只回排序后的 `botId` 数组、**丢座位键** ⇒ 这里不走它。
   *
   * 失败方向：本方法是 fire-and-forget（广播已在 `onGameEvent` 里**同步**发出）⇒
   * 任何失败只记日志，绝不影响广播与连接生命周期；记录写入与归池**各自独立**
   *（一方失败不波及另一方 —— 设计 D2 的「写入与结算广播解耦」）。
   */
  private async finalizeRoomEnd(event: GameEvent, result: SettlementResult | undefined): Promise<void> {
    // `endedAt` = room **收事件时刻**（设计 D2）—— 在本方法入口取一次（同步段，与
    // `onGameEvent` 同一 tick），不随后续异步延迟漂移。
    const endedAt = Date.now();

    // ①′ 昵称快照读取（2026-10-22 机器人昵称片）：**在第一个 `await` 之前发出**，
    //    保证它先于 `updateStatus('finished')` 进入 Redis。reaper 对 finished 房间会
    //    立即 `deleteRoom`（删除集含 `nicknamesKey`）—— 晚读会静默拿到空 Hash。
    //    失败方向：WARN + 空对象 ⇒ 记录里机器人昵称写 NULL（客户端回落「玩家N」）。
    let botNicknamesPromise: Promise<Record<string, string>>;
    try {
      // 同步调用 `hgetall`（不包 microtask）：命令必须在 `updateStatus` 之前进入 Redis。
      botNicknamesPromise = this.redis
        .hgetall(nicknamesKey(event.roomCode))
        .catch((err: unknown) => {
          this.logger.warn(
            `Failed to read nicknames for room ${event.roomCode}: ${String(err)}`,
          );
          return {} as Record<string, string>;
        });
    } catch (err) {
      // 纵深防御：ioredis 正常只 reject（上面已接住）；若驱动同步抛，也不能让
      // fire-and-forget 的 `void finalizeRoomEnd` 产生未处理 rejection。
      this.logger.warn(`Failed to read nicknames for room ${event.roomCode}: ${String(err)}`);
      botNicknamesPromise = Promise.resolve({});
    }

    // ① **唯一一次**读 bots 绑定表（座位对齐）。读失败 ⇒ error 日志 + 按空表继续 ——
    //    归池与组装都优雅降级（组装侧机器人座 `robotId=null`），而不是把局终路径带崩。
    let botBySeat = new Map<number, string>();
    try {
      botBySeat = await this.readBotSeatMap(event.roomCode);
    } catch (err) {
      this.logger.error(`Failed to read bot bindings for room ${event.roomCode}: ${String(err)}`);
    }

    // ② 归池（R207 语义不变：先 release 再删键、失败只记日志）—— 只把「读」换成上面那一次。
    const botIds = [...botBySeat.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, botId]) => botId);
    void this.releaseRobots(event.roomCode, botIds);

    /**
     * ②′ **金币场结算**（② T5；规格 §4 的 `:809` 位）：位置钉死在「归池之后、
     * `!record||!version` 早返**之前**」—— 结算**独立于**记录链（那条早返不得拦住它）。
     *
     * 🔴 **入参透传**（两条都踩过/评审钉死）：
     *  - `botBySeat` = 本方法顶部那次读（座位对齐）——settle 内**不得**重读
     *    `room:{code}:bots`（归池末尾已 DEL，重读恒空 ⇒ 带机器人的主场景恒不结算）；
     *  - `room` = 房间元数据（`findOne`，同 `writeGameRecord` 口径）——mode 与座位/ownerId
     *    的唯一来源；读失败 ⇒ 传 null（settle 内 WARN 跳过，与记录链同口径）。
     *
     * fire-and-forget（`void`）：settle 内部自兜底（绝不 reject —— 否则未处理的 rejection
     * 会把进程打成 crash-loop）。
     */
    let settleRoom: Room | null = null;
    try {
      settleRoom = await this.roomsService.findOne(event.roomCode);
    } catch (err) {
      this.logger.error(
        `Failed to read room ${event.roomCode} for settlement: ${String(err)}`,
      );
    }
    void this.settleService.settle({
      roomCode: event.roomCode,
      version: event.version,
      result,
      room: settleRoom,
      botBySeat,
    });

    // ③ 记录组装 + 投递。跳过判据一（设计 D1 写死）：`!record || !version` ⇒ 跳过 + WARN
    //    —— `notifyRoomEnded` 路径两者都缺，天然覆盖；旧会话窗口由 T3 的守卫保证「不附 record」。
    if (!event.record || !event.version) {
      this.logger.warn(
        `Record write skipped for room ${event.roomCode}: game.ended carries no ${event.record ? 'version' : 'record'} (old session window / notifyRoomEnded path)`,
      );
      return;
    }
    try {
      const botNicknames = await botNicknamesPromise;
      await this.writeGameRecord(event, event.record, result, botBySeat, botNicknames, endedAt);
    } catch (err) {
      // 失败姿态（设计 D2）：单次尝试失败即丢该局记录（无重试）—— 响亮（error）不静默，
      // 后果并入台账「已接受窗口」；**广播不受影响**（它早已同步发出）。
      this.logger.error(`Record write failed for room ${event.roomCode}: ${String(err)}`);
    }
  }

  /**
   * 读 `room:{code}:bots` 的**座位对齐**形态（`field = 座位号` → 内部 `botId`）。
   *
   * 键名经 `botsKey()` 取（单一真源在 `rooms.bots.ts`）；本方法**不走**
   * `readBotBindings`（它丢座位键，见 `finalizeRoomEnd` 的说明）。
   */
  private async readBotSeatMap(roomCode: string): Promise<Map<number, string>> {
    const raw = await this.redis.hgetall(botsKey(roomCode));
    const bySeat = new Map<number, string>();
    for (const [field, botId] of Object.entries(raw ?? {})) {
      const seat = Number(field);
      if (Number.isInteger(seat)) bySeat.set(seat, botId);
    }
    return bySeat;
  }

  /**
   * 记录片 T5（规格 C1 / 设计 D2）：组装 `RecordWriteRequest` 并投递 `record.write`。
   *
   * 组装真源（逐字段，设计 D2 写死）：
   *  - `seats[]` 按**座位序**、恰 3 条：`isRobot`/`userId` 真源 = room `Seat`
   *    （**机器人座 `userId=null`，绝不写 displayId**）；`robotId` 自 bots Hash
   *    **按座位号对齐**（人类座恒 `null`）；
   *  - `hand`/`bottomCards` **原样透传**信封里的 T1 hex 串（room **不重编码**）；
   *  - `nickname`（2026-10-22 机器人昵称片）：机器人座取 `botNicknames[displayId]`
   *    （本房间昵称 Hash），人类座恒 `null`——人类快照由 user-service 查 `users`；
   *  - `mode`/`baseScore` 自房间元数据；`startedAt` 自信封（= 会话创建时刻）；
   *  - `result` 全量原样；`endedAt` = 收事件时刻（见 `finalizeRoomEnd`）。
   *
   * 跳过判据二/三（⇒ WARN、**不调 client**）：房间数据缺失（房键 TTL 窗口）；
   * 形状不符（座位数与信封不符 —— 设计 D1 逐字）。
   */
  private async writeGameRecord(
    event: GameEvent,
    record: RecordEnvelope,
    result: SettlementResult | undefined,
    botBySeat: ReadonlyMap<number, string>,
    botNicknames: Readonly<Record<string, string>>,
    endedAt: number,
  ): Promise<void> {
    // ── 跳过判据二：房间数据缺失（房键已过期 —— 已接受窗口，台账登记）────────────
    const room = await this.roomsService.findOne(event.roomCode);
    if (!room) {
      this.logger.warn(
        `Record write skipped for room ${event.roomCode}: room data missing (room keys expired — TTL window)`,
      );
      return;
    }

    // ── 跳过判据三：形状不符（座位数与信封不符；`result` 缺失同族 —— 无法组装即跳过）──
    // 多玩法（Task 4.3 / spec §4.9.2）：座位集合按 `playerCount` 参数化 ——
    // `exactlySeats(0..playerCount-1)`，pdk 2/4 人不得因「不是 3 座」被跳过。
    const gameType = record.gameType ?? 'doudizhu';
    const playerCount = record.playerCount ?? 3;
    const isPdk = record.gameType === 'paodekuai';
    const envelopeSeats = record.seats;
    const roomSeats = room.players;
    const exactlySeats = (seats: readonly number[]): boolean =>
      seats.length === playerCount &&
      Array.from({ length: playerCount }, (_, s) => s).every((s) => seats.includes(s));
    // D11：pdk 记录只写 pdk 表（反之亦然）—— 房间玩法与信封不符时不得写错表。
    const roomGameType = room.gameType ?? 'doudizhu';
    if (
      !Array.isArray(envelopeSeats) ||
      !exactlySeats(envelopeSeats.map((s) => s.seat)) ||
      !exactlySeats(roomSeats.map((s) => s.seat)) ||
      !result ||
      roomGameType !== gameType ||
      // 结算形状必须与信封玩法一致（pdk 向量 vs 旧 9 键地主结算）
      isPdk !== isPdkSettlementResult(result)
    ) {
      this.logger.warn(
        `Record write skipped for room ${event.roomCode}: game.ended shape mismatch (seats/result vs room data)`,
      );
      return;
    }

    const seatByNumber = new Map(roomSeats.map((seat) => [seat.seat, seat]));
    const request: RecordWriteRequest = {
      roomCode: event.roomCode,
      gameVersion: event.version,
      mode: room.mode,
      baseScore: room.baseScore,
      // 多玩法：pdk 显式带 gameType/playerCount；斗地主**省略**以保持旧请求形状（缺省 = ddz/3）。
      ...(isPdk ? { gameType: 'paodekuai' as const, playerCount } : {}),
      result,
      seats: [...envelopeSeats]
        .sort((a, b) => a.seat - b.seat)
        .map((envelopeSeat) => {
          const seat = seatByNumber.get(envelopeSeat.seat)!;
          const baseSeat = {
            seat: envelopeSeat.seat,
            // 设计 D2 写死：人类 = 真 `Seat.userId`；机器人座 ⇒ NULL（绝不写 displayId）
            userId: seat.isRobot ? null : seat.userId,
            isRobot: seat.isRobot,
            // robotId 真源 = bots Hash（座位对齐、与归池共用同一次读）；人类座恒 null
            robotId: seat.isRobot ? (botBySeat.get(envelopeSeat.seat) ?? null) : null,
            hand: envelopeSeat.hand,
            /**
             * 机器人展示昵称快照（2026-10-22）：`botNicknames` 的 key 是 `displayId`
             * （= `Seat.userId`），不是内部 botId。人类座恒 null —— 人类快照由
             * user-service 按 `user_id` 查 `users`。`displayId` 本身绝不落库。
             */
            nickname: seat.isRobot ? (botNicknames[seat.userId] ?? null) : null,
          };
          // pdk：playedCount（关牌判定）；斗地主省略该键（旧请求形状不变）。
          return isPdk
            ? { ...baseSeat, playedCount: (envelopeSeat as PdkRecordEnvelope['seats'][number]).playedCount }
            : baseSeat;
        }),
      // pdk 无底牌；2 人局扣牌仅审计（3/4 人局**省略该键**，不是 undefined）。
      ...(isPdk
        ? (record as PdkRecordEnvelope).unusedCards === undefined
          ? {}
          : { unusedCards: (record as PdkRecordEnvelope).unusedCards }
        : { bottomCards: (record as DdzRecordEnvelope).bottomCards }),
      startedAt: record.startedAt,
      endedAt,
    };

    const written = await this.record.write(request);
    this.logger.log(
      `Record written for room ${event.roomCode} (version ${event.version}, written=${String(written)})`,
    );
  }

  /**
   * §9.6 归池：局终把本房间的机器人交还 `bot:pool`，并删掉绑定表。
   *
   * 顺序固定：**先 release 再删键** —— 反过来的话，release 失败就再也拿不到 botId 了
   * （§9.6 的兜底回收要 10 分钟才兜得住）。
   *
   * ⚠️ 记录片 T5（r3-2）：`botIds` 由调用方传入 —— 它与记录组装**共用**局终分支顶部的
   * 同一次读（读必须先于本方法的 `DEL`，见 `finalizeRoomEnd`）。
   */
  private async releaseRobots(roomCode: string, botIds: string[]): Promise<void> {
    try {
      if (botIds.length === 0) return;
      // ⚠️ N20/P4 Task 3（R217 同族收口）：`this.robot` 由容器注入且**不再是可选**
      // （构造参数上的 `@Optional()` 已删）—— 缺 provider 时 Nest **启动即崩**，
      // 而不是让整条归池路径静默消失（它此前正是这样：`ROBOT_CLIENT` 从无 provider）。
      const released = await this.robot.release(botIds);
      await clearBotBindings(this.redis, roomCode);
      this.logger.log(`Released ${released}/${botIds.length} bot(s) for ${roomCode}`);
    } catch (err) {
      // 归池失败不得把局终路径带崩（§9.6 的兜底回收是它的保险）
      this.logger.error(`Failed to release robots for ${roomCode}: ${String(err)}`);
    }
  }

  /** 单独一层便于断言推送信封（§6.2）。 */
  protected emitToSeat(socket: Socket, type: string, message: unknown): void {
    socket.emit(type, message);
  }

  private broadcast(roomCode: string, type: string, version: number, payload: unknown): void {
    this.server?.to(roomCode).emit(type, envelope(version, payload));
  }

  /**
   * 兼容入口：`handleInternalConnect` 此前是**死代码**（生产路径 0 次调用）。
   * 身份以握手 `auth` 为准，这个方法仅供测试与网关代理使用。
   */
  handleInternalConnect(socket: Socket, userId: string, traceId?: string): void {
    socket.data.userId = userId;
    socket.data.traceId = traceId ?? null;
    this.activeConnections.set(userId, socket);
  }

  handleInternalDisconnect(socket: Socket, userId: string): Promise<void> {
    const data = socket.data as { userId?: string };
    if (!data.userId) data.userId = userId;
    return this.handleDisconnect(socket);
  }

  /** 供 `room.join` 成功后登记座位归属。 */
  rememberSeats(roomCode: string, seats: Array<{ userId: string; seat: number }>): void {
    for (const { userId, seat } of seats) this.seatOwners.set(`${roomCode}:${seat}`, userId);
  }
}

// packages/room-service/src/gateway/message.router.ts
import {
  DEFAULT_GAME_TYPE,
  ErrCode,
  GAME_META,
  validateClientMessage,
  type Ack,
  type ClientMessage,
  type GameType,
  type PlayerView,
  type RoomPlayer,
} from '@fight-the-landlord/protocol';
import type { Socket } from 'socket.io';
import type { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { runWithTrace } from '@fight-the-landlord/shared';
import {
  DEFAULT_REGION,
  MATCH_MODES,
  matchPendingKey,
  matchQueueKey,
  queueKeyOfTicket,
  type MatchMode,
  type MatchService,
} from '../match/match.service';
// ⚠️ **值导入** `CurrencyServiceError`：下面 catch 里要做运行期 `instanceof`
//（DI 陷阱那条纪律的另一面：类型导入在运行期不存在）。
import { CurrencyServiceError, type CurrencyClient } from '../currency/currency.client';
import type { ConfigCacheService } from '../config/config-cache.service';
import type { ReconnectService } from '../reconnect/reconnect.service';
import type { RoomsService, Room } from '../rooms/rooms.service';
import { RoomStartService } from '../rooms/rooms.start';
import { cardCountKey, roomBalancesKey } from '../rooms/rooms.seats';
// 记牌器收费片：重连/resync 的状态补发（房间状态读/发共用件）。
import { emitCardCounterStatus, readCardCounterStatus } from './card-counter-status';
// ⚠️ **值导入**：Task 3c 修复 1 的 `DomainError` 分支要在**运行期**做 `instanceof`
//（DI 陷阱那条纪律的另一面：类型导入在运行期不存在）。
import { DomainError } from '../http/errors';
import { GameServiceError, type GameClient } from './game.client';
// 风控 T3（规格 §2.8 发送侧）：`room.match` 入队成功后的 `risk.deviceReport` 上报边。
// ⚠️ **类型导入**即可（路由不做 `instanceof`、不构造它 —— 值由 `WsGateway.routerDeps()` 注入）。
import type { RiskClient } from './risk.client';
// 昵称片：房间昵称缓存（`buildRoomPlayers` 的唯一昵称来源；类型导入即可，值由 gateway 注入）。
import type { RoomNicknamesService } from '../rooms/room-nicknames.service';

/**
 * C→S 消息的路由（§6.3）。
 *
 * 两条硬约束在这里落地：
 *  1. **身份只来自 `socket.data.userId`**（由握手 `auth.userId` 写入，§5.2）。
 *     载荷里的 `userId` 被完全忽略；`playerId` **只作一致性校验**（§5.3⑦ / R471）——
 *     传了且与身份不符 ⇒ `12003`，不传 ⇒ 放行。
 *  2. **响应一律通过 ack 返回**（§6.2），不存在响应型事件
 *     （`room.joined` / `game.reconnected` / `game.timeout` 全部并入 ack）。
 *
 * 消息清单本身来自契约包：`validateClientMessage` 会当场拒绝契约外的 type，
 * 因此这里只需处理契约里有的分支。
 */

/** 业务消息限流：单连接 20 条 / 5 秒（§5.4）。 */
export const WS_RATE_LIMIT = { max: 20, windowMs: 5000 } as const;

/**
 * 风控 T3（规格 §2.6-1 逐字）：**限流档**阈值 —— 旗在时以 `3 条 / 1000ms`
 * 对**按 userId 聚合**的键 `ratelimit:ws-risk:{userId}` 判定（§2.6-3）。
 * ⚠️ 值 = 规格写死（与网关 HTTP 侧的常量同值、**各自定义**：两个服务不共享运行期常量）。
 */
export const THROTTLED_RATE_LIMIT = { max: 3, windowMs: 1000 } as const;

/**
 * **`reqId` 的长度上限**（最终评审 I1 / 判据 13①）。
 *
 * `reqId` 是**客户端可控**的字段（WS 消息自带），而日志上限是
 * `max-size: 10m × max-file: 5`（≈50MB/服务，R1108）—— 两者相乘就是一个**放大器**：
 * engine.io 的 `maxHttpBufferSize = 1e6`（单帧 1MB）× `WS_RATE_LIMIT` 20 条/5s
 * ⇒ 单连接 ≈4MB/s 写入 ⇒ 十几秒就能把 room-service 的历史**全部轮转掉**
 * （把本片的「日志有上限」反过来用：对方没拿到任何数据，却抹掉了排障现场）。
 *
 * 64 个字符对合法用途绰绰有余（客户端生成的是 uuid / 短随机串），
 * **且截断不拒绝** —— 拒绝会把「这条 reqId 为什么被拒」的排障线索也一起拒掉。
 */
export const REQ_ID_MAX_LENGTH = 64;

export interface RouterDeps {
  redis: Redis;
  rooms: RoomsService;
  /**
   * 本片（spec §3.3 / R902）：入座后**房间满 ⇒ 同步触发开局**。
   *
   * ⚠️ 它**不是**第二条开局实现 —— 只是把同一个 `RoomStartService.startRoom` 早叫一步；
   * 扫描器仍是兜底（两个触发器共用同一条链 ⇒ `playing` 的写入点仍只有一处，R909）。
   */
  roomStart: RoomStartService;
  match: MatchService;
  reconnect: ReconnectService;
  game: GameClient;
  /**
   * ② 金币场 T4：场次开关的读面（C1/C2 · 设计 D2）—— `room.match` 的 `gold`/`random`
   * 前置裁决读的就是它。值来自 `ConfigCacheService` 快照缓存：`WsGateway` 注入的是
   * 与 `MatchService` / `RoomsService` **同一个**进程内单例（Nest 按模块实例去重）。
   */
  configCache: ConfigCacheService;
  /**
   * ② 金币场 T4：入场门槛的资金读边（C4 · 设计 D8 —— `currency.get`）。
   * 由 `CurrencyModule` 提供（`WsGateway` 注入同一个单例；T5/T6 的结算面复用该类）。
   */
  currency: CurrencyClient;
  /**
   * 风控 T3（规格 §2.8 发送侧 / C8）：`room.match` **入队成功后**的
   * `risk.deviceReport` 上报边（fire-and-forget；`deviceId` 缺省不调）。
   * 由 `WsGateway` 注入（`RpcClientsModule` 的 `RiskClient`，见其注册块）。
   */
  risk: RiskClient;
  /** 昵称片：房间昵称缓存（`buildRoomPlayers` 的唯一昵称来源；由 `WsGateway` 注入）。 */
  nicknames: RoomNicknamesService;
  logger: Logger;
  /** 座位归属登记（`roomCode:seat` → userId），投递 `seatViews` 时需要（§4.4）。 */
  onSeatOwners?: (roomCode: string, seats: Array<{ userId: string; seat: number }>) => void;
  /**
   * 本片（规格 §2.3/§2.4）：`room.leave` 清理单闸内的**投递侧清理** ——
   * 删除 `seatOwners` 中该玩家在**该房**的登记（`ws.gateway.routerDeps()` 注册）。
   * 与 `onSeatOwners` 相邻的理由：它俩是同一张表（`seatOwners`）的加/减两个方向。
   */
  onSeatLeft?: (roomCode: string, userId: string) => void;
  /**
   * 昵称片 · 设计 D6：入座/离座成功后向房间广播 `room.state_update`。
   * 多玩法（Task 2.2）：随带 `gameType`/`playerCount`（spec §4.6.2）—— 新客户端据此渲染
   * 对应 board；旧客户端忽略新增字段。路由只回调，Socket.IO 副作用由 `WsGateway` 完成。
   */
  onRoomStateChanged?: (
    roomCode: string,
    status: string,
    players: RoomPlayer[],
    info: { gameType: GameType; playerCount: number },
  ) => void;
  /**
   * 重连成功后的**投递链路恢复**（§6.6.1）：
   * `socket.join(roomCode)` + 按 `PlayerView.seat` 重登记 `seatOwners`。
   *
   * 路由是纯函数，副作用由 gateway 完成 —— 因此这里只是一个回调。
   * 不恢复投递链路时，「重连成功」只对 ack 那一刻成立（本切片最严重的缺陷 B-d）。
   */
  onReconnected?: (socket: Socket, view: PlayerView) => void | Promise<void>;
  /** 可注入的时钟，便于测试。 */
  now?: () => number;
}

export type AckFn = (response: Ack) => void;

function ok<T>(data?: T): Ack<T> {
  return { code: ErrCode.OK, data };
}

function fail(code: ErrCode, message: string): Ack {
  return { code, message };
}

/**
 * 风控旗键（规格 §2.3 逐字；消费点 §2.6-3 与 §2.7-2 ③④）——
 * `risk:limit:{userId}`（限流档）/ `risk:banned:{userId}`（封禁）。room 只读不写
 *（写点是 user-service 的扫描/管理动作）。
 */
const riskFlagKey = {
  limit: (userId: string): string => `risk:limit:${userId}`,
  banned: (userId: string): string => `risk:banned:${userId}`,
} as const;

/**
 * 风控旗读（设计 §4.3「统一小函数」；规格 §2.6-3 / §2.7-2；R11/F8 纪律）：
 * **单独 try/catch ⇒ 按无旗（false）+ error 日志**。
 *
 * 🔴 为什么不并进任何既有 fail 语义：旗只是**附加准入信息**，它的读取故障不得改变
 * 「入队/加入」与「正常限流链」本身的错误面 —— 封禁主闸在登录 DB 面
 *（`auth.service`），这里是纵深防御；可用性优先（与网关侧握手读旗同口径）。
 */
async function readRiskFlag(deps: RouterDeps, key: string, what: string): Promise<boolean> {
  try {
    return (await deps.redis.exists(key)) === 1;
  } catch (err) {
    deps.logger.error(
      `Risk flag read failed for ${what} (${key}): ${String(err)} — fail-open (按无旗)`,
    );
    return false;
  }
}

/**
 * 处理一条 C→S 消息，通过 `ack` 应答。
 *
 * 返回值仅用于测试断言（生产路径忽略）。
 *
 * 判据 6′（spec §3 的载体表「WS 消息」）：`runWithTrace` 在**消息入口一处**包住
 * **整条消息**的处理 —— 注意**不是**只包住 `dispatch()`：
 *  - 连接级 `traceId` 取 `socket.data.traceId`（网关在握手 `auth.traceId` 里写入；
 *    复核⑦ 已把网关侧的生成点上移到 `handleConnection` 开头 ⇒ 两侧的行是**同一个 id**）；
 *  - 操作级 `reqId` 取**消息自带**的（§6.2 的扁平线格式）—— 必须在
 *    `validateClientMessage` **之前**从原始体上读走：校验失败的日志
 *    （`Rejected malformed client message`）同样属于「处理这条消息期间」，
 *    而排障第一问恰恰是「这条 reqId 为什么被拒」；
 *  - `source: 'edge'`：这条消息从**边缘**（客户端经网关）来。
 *
 * 包 ALS **不改任何判定逻辑**：原实现逐字搬进 `routeClientMessageInner`。
 */
export async function routeClientMessage(
  socket: Socket,
  deps: RouterDeps,
  type: string,
  body: unknown,
  ack: AckFn,
): Promise<Ack | undefined> {
  const rawReqId = (body as { reqId?: unknown } | null)?.reqId;
  return runWithTrace(
    {
      traceId: (socket.data?.traceId as string | null) ?? null,
      /**
       * **最终评审 I1 / 判据 13①**：`reqId` 在 **ALS 边界**（= 唯一的客户端入口）限长 ——
       * 非字符串一律 `null`（不编造），超长**截断**（不拒绝，见 `REQ_ID_MAX_LENGTH` 的理由）。
       * 这一格进了 ALS 之后还会在 `buildLogRecord` 过一次脱敏器（判据 13②）——
       * 两道合起来 =「客户端可控的值不可能原样落盘、也不可能撑爆日志上限」。
       */
      reqId: typeof rawReqId === 'string' ? rawReqId.slice(0, REQ_ID_MAX_LENGTH) : null,
      userId: (socket.data?.userId as string | null) ?? null,
      source: 'edge',
    },
    () => routeClientMessageInner(socket, deps, type, body, ack),
  );
}

/** ALS 包裹外的那一层：与 `routeClientMessage` 同一实现，逐字搬自原方法体。 */
async function routeClientMessageInner(
  socket: Socket,
  deps: RouterDeps,
  type: string,
  body: unknown,
  ack: AckFn,
): Promise<Ack | undefined> {
  const userId = userIdOf(socket);
  if (!userId) {
    ack(fail(ErrCode.UNAUTHENTICATED, 'Connection is not authenticated'));
    return;
  }

  const now = deps.now ?? Date.now;
  /**
   * 风控 T3 · WS 限流档（规格 §2.6-3/4）：判定处**先读旗** `risk:limit:{userId}` ——
   * **旗读单独 catch ⇒ 按无旗**（`readRiskFlag`；F8：不吞进既有 fail 语义，正常限流链
   * 自身的故障语义不变）；命中 ⇒ 以 `THROTTLED_RATE_LIMIT` 对 **`ratelimit:ws-risk:{userId}`**
   *（**按 userId 聚合**，替代按 socketId）判定；旗无 ⇒ 20/5s 按 socketId **原样**。
   * 阈值经 `isRateLimited` 参数化（§2.6-4：签名唯一，不复制第二套判定逻辑）。
   */
  const throttled = await readRiskFlag(deps, riskFlagKey.limit(userId), 'risk:limit');
  if (
    await isRateLimited(
      deps.redis,
      throttled ? `ratelimit:ws-risk:${userId}` : `ratelimit:ws:${socket.id}`,
      now(),
      throttled ? THROTTLED_RATE_LIMIT : WS_RATE_LIMIT,
    )
  ) {
    ack(fail(ErrCode.RATE_LIMITED, 'Too many messages'));
    return;
  }

  let message: ClientMessage;
  try {
    // §6.2 的**线格式是扁平的**：事件名承载 type，meta 三件套平铺在请求体里。
    // 校验器负责组装成逻辑格式 { type, meta, payload } 再返回。
    message = validateClientMessage(type, body);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.logger.warn(`Rejected malformed client message: ${detail}`);
    ack(fail(ErrCode.BAD_PARAM, detail));
    return;
  }

  // M01：|clientTs - serverTs| < 5000ms
  const skew = Math.abs(now() - message.meta.timestamp);
  if (!Number.isFinite(message.meta.timestamp) || skew >= 5000) {
    ack(fail(ErrCode.ILLEGAL_ACTION, `Client timestamp skew too large (${skew}ms)`));
    return;
  }

  // §5.3⑦ / R471：`playerId` **只能作为一致性校验** —— 与身份不符时**拒绝**（12003）。
  // ⚠️ 语义边界（不得扩大）：① 它**不是**身份来源（身份只来自 socket.data.userId）；
  //    ② **不传则放行**；③ 只对这一条做校验，不要顺手去校验别的载荷字段。
  const claimed = (message.payload as { playerId?: unknown }).playerId;
  if (claimed !== undefined && claimed !== userId) {
    ack(fail(ErrCode.NOT_YOUR_TURN, 'playerId does not match the authenticated identity'));
    return;
  }

  try {
    const response = await dispatch(socket, deps, message, userId);
    ack(response);
    return response;
  } catch (err) {
    if (err instanceof GameServiceError) {
      ack(fail(err.code, err.message));
      return;
    }
    /**
     * **② 金币场 T4：货币边的错误映射**（与 `GameServiceError` 同形）。
     *
     * 修前 `CurrencyServiceError` 会落到下面的未知异常分支 ⇒ **13001 'Internal error'**
     * —— 而门槛的契约是「`get` 失败 ⇒ **10007** 拒入」（设计 D8：不允许盲入），
     * 13001 会让客户端把它当「服务端内部错」而不是「稍后重试」。
     *
     * 码**原样**（传输故障 = 10007 + 固定文案，由 `CurrencyClient` 保证**消息干净**；
     * 业务错误 = 下游 5 位码 + 业务文案逐字——与 `GameServiceError` 的「照实」同一口径）。
     * 留痕（warn）：与 `DomainError` 分支同纪律（不透传 ≠ 不留痕）。
     */
    if (err instanceof CurrencyServiceError) {
      deps.logger.warn(`Message ${message.type} rejected with ${err.code}: ${err.message}`);
      ack(fail(err.code, err.message));
      return;
    }
    /**
     * **领域错误与 HTTP 面的 `toHttpException` 对称翻译**（Task 3c 修复 1，用户裁决）：
     * 码**原样**（`BAD_PARAM` → 10001、`UPSTREAM_UNAVAILABLE` → 10007、`ROOM_NOT_FOUND`
     * → 12001 …），消息**照实**。
     *
     * 🔴 **「消息照实」是一条要求，不是一条普遍性质**（Task 3g 修复 I1 订正）：
     * 凡是从这里 ack 出去的 `DomainError` 消息，**必须**是面向调用方的一句话
     * （`'底分不属于档位表'` 这类）—— 因为这一支不认识「哪些消息干净」，它**原样转发**
     *（HTTP 面的 `toHttpException` 同样原样透给客户端）。内部详情（下游异常文本、连接串…）
     * **不许**出现在消息里，只许进日志。同码下的反例就在本仓、且**真的漏出去过**：
     * `RoomsService.create` 曾把 `err.message` 内插进 `UPSTREAM_UNAVAILABLE` 的消息
     *（`'底分档位表不可用：user-service unavailable: connect ECONNREFUSED …'`），
     * 而 HTTP 面把它原样发给客户端（Task 3g 修复 I1 已去掉内插、详情改走 warn）。
     * 新增任何 WS 可达的 `DomainError` ⇒ 先核这一条。
     *
     * ⚠️ 这一支覆盖**所有** WS DomainError，不只 `room.match` 新可达的那两条。逐个核过：
     *  - `room.match`：非法底分（`BAD_PARAM`，Task 3b 新增）· 档位表不可用
     *    （`UPSTREAM_UNAVAILABLE` —— `MatchService.assertKnownBaseScore` 把
     *    `ConfigServiceError` 翻成领域错误，与建房路径的处置同形）；
     *  - `room.leave`：`leaveSeat` 撞上「房间在读与写之间被删」（`ROOM_NOT_FOUND`）
     *    —— 修前是 13001 + `'房间不存在'`，现在是 **12001**（客户端 `CLIENT_ACTION`
     *    从 TOAST 变成 BACK_TO_LOBBY，语义上更对：房间真的没了）；
     *  - 其余分支（`room.join` / `room.unmatch` / `game.*`）**逐条核过**：
     *    `findOne` / `resetWaitingWindow` / `cancelQueue` / `readMeta` / `touch` /
     *    `clearConnection` **都不抛** DomainError，`game.*` 抛的是 `GameServiceError`
     *    （本来就有自己的分支）⇒ 受影响的只有上面三条。
     *
     * 留痕（warn）：这一支**接替**了原来通用分支的 error 行 —— 不留的话，
     * 上面那些路径会从「有日志」变成静默（本仓的「静默吞掉 = 灾难」纪律）。
     */
    if (err instanceof DomainError) {
      deps.logger.warn(`Message ${message.type} rejected with ${err.code}: ${err.message}`);
      ack(fail(err.code, err.message));
      return;
    }
    /**
     * 未知异常仍是 `13001`（客户端 `CLIENT_ACTION[13001] = TOAST`，语义不变），
     * 但**不再透传 `detail`**：它可能是连接串、下游异常文本、`user-service unavailable:
     * <详情>` 这类**内部详情**，而 ack 的 message 会被客户端**当 toast 弹给玩家**
     * （Task 3c 修复 1 的另一半；修前 `user-service unavailable: <详情>` 就是这么漏出去的）。
     * 详情**只进日志** —— 不透传 ≠ 不留痕。
     */
    const detail = err instanceof Error ? err.message : String(err);
    deps.logger.error(`Message ${message.type} failed: ${detail}`);
    ack(fail(ErrCode.ILLEGAL_ACTION, 'Internal error'));
    return;
  }
}

async function dispatch(
  socket: Socket,
  deps: RouterDeps,
  message: ClientMessage,
  userId: string,
): Promise<Ack> {
  switch (message.type) {
    case 'room.match':
      // 风控 T3：`deviceId` 已在 `validateClientMessage` 校验（T1）⇒ 直接把**校验后的**值透传。
      // 多玩法（Task 2.1）：`gameType`/`playerCount` 同样已由协议校验（缺省语义在 handleMatch）。
      return handleMatch(
        socket,
        deps,
        message.payload.mode,
        message.payload.baseScore,
        userId,
        message.payload.deviceId,
        message.payload.gameType,
        message.payload.playerCount,
      );

    case 'room.unmatch':
      await deps.match.cancelQueue(userId);
      return ok();

    case 'room.match.extend':
      // 机器人补位开关片：延长匹配 = 票留队、仅平移提示窗口（票不在 ⇒ 服务端幂等 no-op）。
      await deps.match.extendWait(userId);
      return ok();

    case 'room.join':
      return handleJoin(socket, deps, message.payload.roomCode, userId, message.payload.gameType);

    case 'room.leave':
      return handleLeave(socket, deps, message.payload.roomCode, userId);

    case 'game.bid':
      return forwardAction(deps, userId, 'bid', { grab: message.payload.grab }, message.meta.baseVersion);

    case 'game.play':
      return forwardAction(deps, userId, 'play', { cards: message.payload.cards }, message.meta.baseVersion);

    case 'game.pass':
      return forwardAction(deps, userId, 'pass', {}, message.meta.baseVersion);

    case 'game.reconnect':
      return handleReconnect(socket, deps, userId, message.payload.lastVersion);

    case 'game.resync':
      return handleResync(socket, deps, userId);

    /**
     * 挂机治理（T6 / C19）：客户端托管按钮 ⇒ `via: 'manual'`（**钉死**，不做任何条件映射）。
     * 房间由 resolver 派生（与动作转发同口径）；下游错误码原样过 `GameServiceError` 分支。
     */
    case 'game.trustee':
      return handleTrustee(deps, userId, message.payload.on);

    default:
      // 契约里没有的 type 已被 `validateClientMessage` 拒绝，走到这里说明
      // 契约新增了消息但路由没跟上 —— 必须显式失败，不能静默吞掉。
      throw new Error(`Unhandled client message type: ${String((message as { type: string }).type)}`);
  }
}

// ─── room.* ───────────────────────────────────────────────────────

async function handleMatch(
  socket: Socket,
  deps: RouterDeps,
  mode: MatchMode,
  baseScore: number,
  userId: string,
  deviceId?: string,
  /** 多玩法（Task 2.1）：协议层已校验；缺省 = 斗地主（K3 兼容语义）。 */
  gameType?: GameType,
  /** 缺省 = `GameMeta[gameType].defaultPlayerCount`（斗地主/跑得快首版都是 3）。 */
  playerCount?: number,
): Promise<Ack> {
  /**
   * 维度解析（Task 2.1）：只在这里做一次，后面所有键/比较/入队都读这两个值。
   * 玩法是否开放 / 人数是否仍被运营闸住 ⇒ Task 2.2 的 `12012`；本任务只保证维度贯通。
   */
  const matchGameType = gameType ?? DEFAULT_GAME_TYPE;
  const matchPlayerCount = playerCount ?? GAME_META[matchGameType].defaultPlayerCount;
  /**
   * **风控 T3 · 封禁读点 ③**（规格 §2.7-2 ③ / C9）：**入队前**读 `risk:banned:{userId}`，
   * 命中 ⇒ ack `11003`（既有码；消息用既有登录面同款文案）。
   *
   * 位置 = 一切队列探测**之前**：封禁是**准入闸** —— **旗读先于 dup 探测**：封禁者
   * 一律 `11003`，**不给** `12009`（旧票在否）这条信息。次序由 `message.router.test.ts`
   *「旗在 + 旧票 ⇒ 11003 而非 12009」（波 2 F8）用例钉住 —— 把旗读挪到 dup 判定之后
   * 会当场红。旗读故障 ⇒ 放行 + error 日志（`readRiskFlag` —— 单独 catch，不改本函数
   * 其余错误面）。
   */
  if (await readRiskFlag(deps, riskFlagKey.banned(userId), 'risk:banned')) {
    return fail(ErrCode.USER_BANNED, '用户已被封禁');
  }

  /**
   * 本片守卫：在局/在房者不得匹配（用户裁决 K2；设计 §3.3）。
   * 判据两段：resolver 第一遍命中（waiting/playing）；playing 再加 view-ended 放行
   * （updateStatus(finished) 是 fire-and-forget，写丢失不把玩家卡到房键 TTL）。
   * 缺失类错误（ROOM_NOT_FOUND/NOT_IN_ROOM）视同 view 拿不到 ⇒ 不放行（不得上抛成 12001，
   * 那会让客户端 BACK_TO_LOBBY 静默踢回大厅）；仅传输类故障原样上抛（走既有 13001 面）。
   */
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

  // §8.1 的队列键含 region（MVP 恒为 'global'），保证将来的地理扩展是加性变更；
  // 片规格 §2.4 又加了**底分**那一维 —— 「不同底分不会同房」靠的就是它。
  //
  // R63：ZSet 成员**没有 TTL**，而 `match:meta` 有（300s）—— 两者会分叉。
  // 排队状态的真相源是 `match:meta`（R42）：meta 不在 ⇒ 这是**孤儿成员**，
  // 先清掉它再正常入队，否则玩家会被 12009 锁死、只能等一次莫名的 12007。
  //
  // ⚠️ **探测键从哪来**（片规格 §2.4 + 多玩法 Task 2.1）：meta **同时携带全部队列维度**，
  // 并且新票还冻结了**实际键**（`queueKey`）⇒ 玩家实际所在的队列由 `queueKeyOfTicket`
  // 唯一确定（旧票缺字段 ⇒ 回落旧 3 段键）。meta 不在时按本次请求的维度做一次廉价探测；
  // 其它底分上的残留（重启前的旧票）**查不到** —— 它们是
  // 无 TTL 的孤儿，由**扫描前置筛选**清出（meta 读不到 ⇒ `cancelQueue` 静默清理、
  // 无 12007 —— 风控 T2 · 波 1 F1）；**封禁旗在的存量票**同路径撤出（波 2 F4 —— 防
  // 「幽灵位」：该位 join 会被拦而房已 3/3 开局）；**到点者（有 meta）**走兜底成局，
  // 可经 `match:pending` 补回（断线者在重连后由凭据恢复 —— 有意行为）。
  const meta = await deps.match.readMeta(userId);
  const probeMode = meta?.mode ?? mode;
  const probeBaseScore = meta?.baseScore ?? baseScore;
  const probeRegion = meta?.region ?? DEFAULT_REGION;
  /**
   * 多玩法（Task 2.1）：旧票（缺 `gameType`/`playerCount`）按斗地主/3 解析；meta 不在时
   * 用本次请求的维度。⚠️ 这里的「缺省」只用于**探测**，不改写票本身。
   */
  const metaGameType = meta?.gameType ?? DEFAULT_GAME_TYPE;
  const metaPlayerCount = meta?.playerCount ?? GAME_META[metaGameType].defaultPlayerCount;
  const probeGameType = meta === null ? matchGameType : metaGameType;
  const probePlayerCount = meta === null ? matchPlayerCount : metaPlayerCount;
  const probeKey =
    meta === null
      ? matchQueueKey(probeMode, probeGameType, probePlayerCount, probeBaseScore, probeRegion)
      : queueKeyOfTicket(meta);
  /**
   * ② §2.1 三值化：探测**除 `probeMode` 之外的其余两种模式**（原实现只探「另一个」模式
   * —— 那是二值时代的形状，`gold` 队列会被它漏掉 ⇒ 换场请求探测不到旧票、同一人
   * 能同时躺在两条队列上）。集合取自 `MATCH_MODES` 单一真源，不再手写第三份字面量。
   * 多玩法：其余模式用**同一玩法/人数**探测（维度不同的请求走下面的换队分支）。
   */
  const otherModes = MATCH_MODES.filter((m) => m !== probeMode);
  const [existing, ...existingOthers] = await Promise.all([
    deps.redis.zscore(probeKey, userId),
    ...otherModes.map((m) =>
      deps.redis.zscore(
        matchQueueKey(m, probeGameType, probePlayerCount, probeBaseScore, probeRegion),
        userId,
      ),
    ),
  ]);
  const inAnyQueue = existing !== null || existingOthers.some((v) => v !== null);
  /**
   * P1-9：换场时**旧票的撤销必须晚于新场次的所有校验**（开关/入场门槛）。
   * 旧实现在这里就 `cancelQueue` ⇒ 新场次被 12010/14003 拒时，玩家既不在旧队列、
   * 也进不了新队列（凭空丢队）。这里只记「待换队」，真正撤票放在校验之后。
   */
  let pendingQueueSwitch = false;
  if (meta === null) {
    if (inAnyQueue) {
      await deps.match.cancelQueue(userId);
    }
  } else if (inAnyQueue) {
    /**
     * 机器人补位开关片（用户裁决 · 自动换队）：已在队时**按队列维度分流** ——
     *  - 旧票维度与本次请求**完全相同**（mode/gameType/playerCount/baseScore/region）⇒ 12009；
     *  - **任一维度不同**（匹配中返回大厅换场次/换底分/换玩法/换人数再匹配）⇒
     *    **先取消旧票、再按本次请求正常入新队**。逻辑只比较队列维度，不写死玩法字面量。
     */
    const sameDimensions =
      meta.mode === mode &&
      metaGameType === matchGameType &&
      metaPlayerCount === matchPlayerCount &&
      meta.baseScore === baseScore &&
      meta.region === DEFAULT_REGION;
    if (sameDimensions) {
      return fail(ErrCode.ALREADY_IN_QUEUE, 'Already in the match queue');
    }
    deps.logger.log(
      `Player ${userId} switching match queue ${meta.mode}/${metaGameType}/${metaPlayerCount}/${meta.baseScore}/${meta.region} -> ${mode}/${matchGameType}/${matchPlayerCount}/${baseScore}/${DEFAULT_REGION}`,
    );
    // P1-9：撤旧票排到「开关 + 入场门槛」校验之后（见下方 pendingQueueSwitch 的落点）。
    pendingQueueSwitch = true;
  }

  /**
   * 多玩法（Task 2.2 / spec §4.6.2 / D9）：玩法开放与人数闸 —— 由 **room-service** 判定
   *（protocol 校验器拿不到配置）⇒ `12012 GAME_UNAVAILABLE`（DomainError 同族的业务码，
   * 不走 10001）。未开放的玩法**不得**建队列票。
   */
  if (!deps.configCache.gameEnabled(matchGameType)) {
    return fail(ErrCode.GAME_UNAVAILABLE, '该玩法暂未开放');
  }
  if (!deps.configCache.supportsRoomPlayerCount(matchGameType, matchPlayerCount)) {
    return fail(ErrCode.GAME_UNAVAILABLE, '该玩法暂不支持该人数');
  }

  /**
   * ② 场次开关（C1/C2 · 设计 D2；§10 文案逐字）。顺序是契约的一部分（D8 锚点）：
   * **dup 探测 → 开关 → 门槛** —— 已在队列里的人先拿 12009（他的排队状态没变），
   * 开关只拦**新的**入队。换场（P1-9）的撤旧票排在开关+门槛**之后**：
   * 被拒的换场不得让玩家从旧队列消失。
   */
  if (!modeEnabled(deps, mode)) {
    return fail(ErrCode.ROOM_MODE_DISABLED, '该场次暂未开放');
  }

  /**
   * ② 入场门槛（C4 · 设计 D8：**仅金币场、仅匹配路径**）。
   *
   * - `currency.get` **失败 ⇒ 拒入**（`CurrencyServiceError` 被外层 catch 映射成
   *   10007，消息照实）—— 门槛是资金安全面，**不允许盲入**；
   * - `balance ≥ baseScore × entryMultiplier` 不成立 ⇒ **14003**（消息含所需金额，
   *   客户端直接展示）；`exists=false` 的账户 `balance` 契约上就是 0 ⇒ 同一条判定；
   * - 🔴 **免费场（random / practice）不查**（设计 D8 的「REST 建房不查」同族：
   *   资金面只对金币场存在）—— 少一次 RPC，也不给免费场造任何资金耦合。
   * - 已达门槛后**不再复查**（设计 D8：队列中余额被降是接受窗口，台账登记）。
   */
  if (mode === 'gold') {
    const { balances } = await deps.currency.get({ ownerIds: [userId] });
    const balance = balances.find((b) => b.ownerId === userId)?.balance ?? 0;
    const needed = baseScore * deps.configCache.entryMultiplier();
    if (balance < needed) {
      return fail(ErrCode.E_ENTRY_THRESHOLD, `金币不足：该场次需要 ≥ ${needed}`);
    }
  }

  /**
   * P1-9：新场次通过了**全部**校验（开关 + 入场门槛，上面的每个拒绝分支都在此之前
   * `return`）⇒ 现在才撤销旧票。到这一步之后只剩入队/写 meta，不再有拒绝面。
   */
  if (pendingQueueSwitch) {
    await deps.match.cancelQueue(userId);
  }

  /**
   * **风控 T3 · `match:meta` 写点**（规格 §2.3 / C7）：`socket.data.clientIp`
   *（网关下游握手注入、room 侧已在握手做形状校验）与**校验后的** `deviceId`
   *（T1 已在 protocol 落校验）经 `addToQueue` 的 extras 写 Hash；**缺省 ⇒ 不写该字段**
   *（谓词侧 fail-open 的写入侧）。extras 恒传对象（空对象与缺省等价）—— 形状稳定。
   */
  const clientIp = (socket.data as { clientIp?: unknown } | undefined)?.clientIp;
  const extras: { ip?: string; deviceId?: string } = {};
  if (typeof clientIp === 'string') extras.ip = clientIp;
  if (deviceId !== undefined) extras.deviceId = deviceId;

  await deps.match.addToQueue(userId, mode, baseScore, undefined, extras, {
    gameType: matchGameType,
    playerCount: matchPlayerCount,
  });
  /**
   * **风控 T3 · `risk.deviceReport`**（规格 §2.8 发送侧 / C8 / ⚙️21）：**恰在入队成功后**
   * 一次 fire-and-forget（`deviceId` 缺省不调 —— 旧客户端没有这个值）。`report` 自身
   * 不重试、不抛（失败只留 warn 一行）⇒ 这里不接 `.catch`。
   */
  if (deviceId !== undefined) deps.risk.report(userId, deviceId);
  deps.logger.log(
    `Player ${userId} queued for ${mode} match at base score ${baseScore} (socket ${socket.id})`,
  );
  return ok();
}

/**
 * ② D2：`room.match` 的**场次开关**（C1/C2）。映射只住这里，不散落：
 *  - `gold` → `room.goldRoomEnabled`（种子 true：默认开 —— 2026-10-04 用户裁决，原暗上线为关）；
 *  - `random` → `room.freeRoomEnabled`（种子 true：免费场保持现状）。
 *
 * ⚠️ `practice` **不在双开关范围**：好友房的开闭是 `room.friendRoomEnabled`，其拒绝
 * （12006）落在 **REST 建房入口**（`rooms.controller`）——设计 D2 明文「好友房不变」；
 * `room.match` 的 practice 分支是历史面（客户端匹配只发 random/gold）。
 */
function modeEnabled(deps: RouterDeps, mode: MatchMode): boolean {
  if (mode === 'gold') return deps.configCache.goldRoomEnabled();
  if (mode === 'random') return deps.configCache.freeRoomEnabled();
  return true;
}

async function handleJoin(
  socket: Socket,
  deps: RouterDeps,
  roomCode: string,
  userId: string,
  /** 多玩法（Task 2.2 / D16）：客户端能力声明；缺省 doudizhu（旧客户端）。 */
  gameType?: GameType,
): Promise<Ack> {
  /**
   * **风控 T3 · 封禁读点 ④**（规格 §2.7-2 ④ / C9）：join 前读 `risk:banned:{userId}`，
   * 命中 ⇒ ack `11003`；旗读故障 ⇒ 放行 + error 日志（与 ③ 同一条 `readRiskFlag`）。
   * 位置在最前：封禁者不得进入任何房间（也不该先看一眼房号是否存在）。
   */
  if (await readRiskFlag(deps, riskFlagKey.banned(userId), 'risk:banned')) {
    return fail(ErrCode.USER_BANNED, '用户已被封禁');
  }

  const room = await deps.rooms.findOne(roomCode);
  if (!room) return fail(ErrCode.ROOM_NOT_FOUND, 'Room not found');

  /**
   * 多玩法（Task 2.2 / D16）：WS `room.join` 与 REST join 语义一致 —— 旧客户端
   *（缺省 doudizhu）进跑得快房 ⇒ `12012`，且在**登记投递/清票/入座**之前拒绝
   *（不返回 pdk 视图、不占座）。
   */
  if ((room.gameType ?? DEFAULT_GAME_TYPE) !== (gameType ?? DEFAULT_GAME_TYPE)) {
    return fail(ErrCode.GAME_UNAVAILABLE, '房间玩法与客户端不符');
  }

  // 座位必须从**真实**的 `room.players` 上取，而且取的是 `Seat.seat`（R128）：
  // 出站 id 被掩码过，不能再拿它反查座位；数组下标也不等价于座位号。
  const realSeat = room.players.find((p) => p.userId === userId)?.seat ?? -1;
  const pendingRoom = await deps.redis.hget(matchPendingKey(userId), 'roomCode');
  if (realSeat < 0 && pendingRoom !== roomCode) {
    return fail(ErrCode.NOT_IN_ROOM, 'You are not in this room');
  }
  const seat =
    realSeat >= 0 ? realSeat : Number((await deps.redis.hget(matchPendingKey(userId), 'seat')) ?? 0);

  await socket.join(roomCode);
  // §6.6.1 刷新时机 2（`room.join`）：`room.join` 成功 → 建立可恢复点。
  // 只写哈希字段 —— 独立键 `SET … EX 35` 已随 30 秒窗口退役删除（touch 现在仅写哈希）。
  await deps.reconnect.touch(userId, socket.id, roomCode);

  // N34 / R524：`room.join` **成功**后必须**兜底清票**（R418 同族：复位点写在**唯一共同写入处**）。
  // 旧实现只有 `room.leave` 清票 ⇒ 用户在「正在匹配…」时点「创建房间」或「加入」（两条入口都走这里），
  // 服务端仍持有他的队列成员与 `match:pending`，之后可能给他推 `room.matched {另一个房间}`
  // —— 而他正坐在这一间里。前端**不**需要先 `room.unmatch`，否则两条入口必然漏一条。
  // ⚠️ 顺序不可反：座位号上面已经从 `match:pending.seat` 读出来了，**先清票再读**会丢掉匹配到的座位。
  await deps.match.cancelQueue(userId);
  await deps.redis.del(matchPendingKey(userId));

  /**
   * 本片（自动开局 · spec §3.1 / R904）：**入座是「占用变化」⇒ 重置等待窗口**。
   * 放在最后（清票之后）：前面任何一步抛错都不该把窗口推后。
   */
  await deps.rooms.resetWaitingWindow(roomCode);

  /**
   * 本片（spec §3.3 / R902）：**房间满 ⇒ 立刻开局**，不等扫描周期（用户裁决）。
   *
   * ⚠️ 用**刚读到的** `room.players` 判满：这一读发生在占座**之前**，所以要把
   * `realSeat >= 0` 这个新占的座位算进去 —— 更稳妥的判据是「刚查完座位后的权威表」，
   * 但那要多一次 `findOne`；⇒ 这里用「占座成功 + 原人数 + 1 ≥ maxPlayers」等价表达，
   * 且 `startRoom` 自己会重读房间（**幂等**：没满就什么都不做）。
   * 换句话说：这里判错的后果只是「多叫一次 `startRoom`」，不会开出半个房间。
   */
  const seated = room.players.length + (realSeat >= 0 ? 0 : 1);
  if (seated >= room.maxPlayers) {
    /**
     * ⚠️ **必须延到本帧消息处理完之后**（实现在 conformance 里实测踩出来的）：
     * `game.deal` 的投递靠 `WsGateway.seatOwners` 这张**内存**表，而它是在
     * `onSeatOwners` 回调里登记的 —— 那个回调在**本函数的 return 之前**才调用。
     * 若在这里 `await startRoom`，`game.started` 会在**最后一个人的座位登记之前**
     * 抵达 gateway ⇒ **那个人收不到 `game.deal`**（实测：三方 `room.matched` 都收到、
     * 三方 `room.join` 都 `code 0`，唯独第三个人等 `game.deal` 超时）。
     * ⇒ 用微任务把它排到本帧之后：ack 与座位登记都先落地。
     * ⚠️ 用户感知仍是「**立刻**开局」（微任务 = 下一轮事件循环，不是定时器）。
     */
    const trigger = () => {
      void deps.roomStart
        .startRoom(roomCode, { strict: true })
        .catch((err) => deps.logger.error(`Autostart (full room) failed for ${roomCode}: ${String(err)}`));
    };
    queueMicrotask(trigger);
  }

  const players = await buildRoomPlayers(deps, room, userId);
  // 昵称片 · 设计 D6：好友房逐人入座 ⇒ 先入房者也要拿到后入者的昵称。
  // 载荷复用同一份 `players`，保证 ack 与广播字段一致。
  deps.onRoomStateChanged?.(roomCode, room.status, players, {
    gameType: room.gameType ?? DEFAULT_GAME_TYPE,
    playerCount: room.maxPlayers,
  });
  // ⚠️ **真实 id**（`room.players`），不是 `players`（出站已掩码）——见 R48。
  // 登记成 `seat-1` 会让 `game.deal` 投递到一个不存在的玩家：机器人座位永远收不到牌。
  deps.onSeatOwners?.(
    roomCode,
    room.players.map(({ userId: id, seat }) => ({ userId: id, seat })),
  );

  /**
   * 挂机治理 T6（C22 的第二条入口）：**在局 `room.join` ⇒ trustee-off（via `'reconnect'`）**。
   *
   * - 判别门 = `room.status === 'playing'`：waiting 房入座没有治理量（转发只会得到噪音 13009）；
   * - **先清后 ack**：Awaited 放在 `onSeatOwners` **之后**（清除会触发 game-service 推送一次
   *   座位视图 —— 投递表登记晚了，玩家会错过这次推送），但在 `return ok` **之前**；
   * - **fail-open**：清除失败不阻断入座（`clearTrusteeForReturn` 内部 warn 后返回 false）。
   */
  if (room.status === 'playing') {
    await clearTrusteeForReturn(deps, roomCode, userId);
  }
  return ok({ roomCode, seat, players });
}

async function handleLeave(socket: Socket, deps: RouterDeps, roomCode: string, userId: string): Promise<Ack> {
  await socket.leave(roomCode);
  // 显式离开：删哈希字段（§6.6.1；独立键已随窗口退役 —— `clearConnection` 只 hdel）。
  // §6.6.1 判定顺序第 1 步：`room.leave` **必须同时清除** `match:pending:{playerId}`。
  // `match:pending` 的唯一用途是「客户端错过 `room.matched` 时补回」（§8.2）；
  // 玩家主动离开后该用途就消失了，留着它会让「`room.leave` → 断线 → `game.reconnect`」
  // 命中第 1 步的回退，把玩家送回**他刚刚主动离开的房间**。
  // 本片（设计 §3.2）：清理单闸——两凭据各自「缺席 或 roomCode 一致」才清；
  // 任一「存在且不一致」⇒ 全不清（防「错房号 leave 即解锁匹配」旁路），仍返 ok。
  const record = await deps.reconnect.getRecord(userId);
  const pendingRoom = await deps.redis.hget(matchPendingKey(userId), 'roomCode');
  const consistent =
    (record === null || record.roomCode === roomCode) &&
    (pendingRoom === null || pendingRoom === roomCode);

  /**
   * 挂机治理 T6（规格 C21 / 设计 R5 五步序）：**① awaited 解析 roomCode —— 必须在清记录之前**。
   * resolver 的候选源就是 record / pending；先清再解析 = 候选源消失 ⇒ 弃局托管永远不触发。
   * 调用序（resolve → trustee → clear）由 `idle-trustee.router.test.ts` 钉死。
   *
   * ⚠️ 解析失败**不**吞：与 `getRecord` 同口径（连接级 Redis 故障本来就会让 leave 走 13001）；
   * 只有**转发**失败才是 fail-open（下方 fire-and-forget 的 catch）。
   */
  const resolved = await deps.reconnect.resolveRecoverableRoom(userId);

  /**
   * **② 转发（fire-and-forget）** —— 仅「在局」且满足其一：
   *  - `consistent`（两凭据一致或不缺席 —— 正常弃局）；
   *  - `resolved.roomCode === roomCode`（r1 次要 M1：旧记录指向别房、但存活候选恰是本次房号，
   *    例如 `match:pending` 票指回本房 —— 凭据半边否决了清理，仍应置本房托管）。
   *
   * 三个排除格的理由：
   *  - `status !== 'playing'`：waiting 房 leave 是常见路径，转发只会得到注定 13009 的噪音 RPC；
   *  - 目标 ≠ 本次房号且凭据不一致：**错房号 leave 不得把别的房置成托管**（只记一行日志）；
   *  - **不得 await**：awaited 会把 ack 拖到 2s（弃局是玩家点「返回大厅」的高频动作）。
   * 目标房取 `resolved.roomCode`（R5：由 resolver 派生，不信任 payload）。
   */
  if (resolved !== null && resolved.status === 'playing') {
    const target = resolved.roomCode;
    if (consistent || target === roomCode) {
      void deps.game.trustee(target, userId, true, 'abandon').catch((err: unknown) => {
        // 失败只 warn（fail-open）：玩家「只是想离开」的不变量不因托管转移失败而破。
        deps.logger.warn(`Trustee-on (abandon) failed for ${userId} in ${target}: ${String(err)}`);
      });
    } else {
      deps.logger.log(
        `Skip abandon trustee for ${userId}: resolved ${target} != payload ${roomCode} (inconsistent)`,
      );
    }
  }

  if (consistent) {
    await deps.reconnect.clearConnection(userId);
    await deps.redis.del(matchPendingKey(userId));
    deps.onSeatLeft?.(roomCode, userId);
  }

  /**
   * 本片（自动开局 · spec §3.5 / R906 / R904）：
   * **退房要腾座位**，否则「满即开局 / 不足则补机器人」之后会留下**永远开不了局**的 `3/3` 房间
   *（满分支不触发：人早走了；不足分支也不触发：座位数说满了）。
   *
   * ⚠️ **先看一眼房间在不在**：`leaveSeat` 对不存在的房间会抛 `12001`，而**房间没了不该
   * 让玩家走不掉**（玩家只是想离开一块已经不存在的房间）。`status !== 'waiting'` 的判断
   * 在 `leaveSeat` / `resetWaitingWindow` 内部（R916：对局中不动座位、不动窗口）。
   */
  const room = await deps.rooms.findOne(roomCode);
  if (room) {
    await deps.rooms.leaveSeat(roomCode, userId);
    await deps.rooms.resetWaitingWindow(roomCode);
    // 昵称片 · 设计 D6：离座后重读房间再广播（离开者已被 socket.leave 摘除）。
    const updated = await deps.rooms.findOne(roomCode);
    if (updated) {
      const players = await buildRoomPlayers(deps, updated, userId);
      deps.onRoomStateChanged?.(roomCode, updated.status, players, {
        gameType: updated.gameType ?? DEFAULT_GAME_TYPE,
        playerCount: updated.maxPlayers,
      });
    }
  }

  deps.logger.log(`Player ${userId} left room ${roomCode}`);
  return ok();
}

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
    /**
     * 挂机治理 T6（C22）：**先清后 ack** —— 清除成功后 ack 快照不得带 `trustee=true`
     *（就地改写 `trustees[seat]=false`；失败 fail-open，见 helper 注释）。
     * `onReconnected` 也拿改写后的视图（保持单一真源）。
     */
    const ackView = await viewWithTrusteeCleared(deps, roomCode, userId, view);
    await deps.onReconnected?.(socket, ackView);
    await resendCardCounterStatus(socket, deps, roomCode, ackView.seat);
    return ok(ackView);
  }

  const room = await deps.rooms.findOne(roomCode);
  if (room) return fail(ErrCode.GAME_NOT_STARTED, 'Game has not started yet');
  return fail(ErrCode.RECONNECT_RECORD_MISSING, 'No recoverable game to reconnect to');
}

/**
 * 「找不到可恢复的对局」的下游错误码（§6.6.1：它们必须落到 `13010`）。
 *
 * 注意 `UPSTREAM_UNAVAILABLE`（10007）**不在**这里：那是真的连不上下游，
 * 应当如实返回，不得伪装成「没有任何可恢复凭据」（`13010` 语义已收窄于此）。
 */
function isMissingGameError(err: unknown): boolean {
  return (
    err instanceof GameServiceError &&
    (err.code === ErrCode.ROOM_NOT_FOUND || err.code === ErrCode.NOT_IN_ROOM)
  );
}

/**
 * C22 的共用转发：回桌解除托管（reconnect / 在局 `room.join` 两条入口，`via: 'reconnect'`）。
 *
 * **fail-open**：失败只 warn、返回 `false` —— 回桌/重连**不得**因清除失败而失败
 *（设计 §六 显式接受格①：此时 game-service 不可达、本就没有对局推进，恢复后下次转移纠正）。
 * 返回布尔供 `viewWithTrusteeCleared` 决定要不要改写 ack 快照。
 */
async function clearTrusteeForReturn(deps: RouterDeps, roomCode: string, userId: string): Promise<boolean> {
  try {
    await deps.game.trustee(roomCode, userId, false, 'reconnect');
    return true;
  } catch (err) {
    deps.logger.warn(`Trustee-off (reconnect) failed for ${userId} in ${roomCode}: ${String(err)}`);
    return false;
  }
}

/**
 * C22 + P1-11：`game.reconnect` 的 ack 快照 —— **清除成功后重新取 view**（拿权威的
 * version/deadline），并保证快照里自己座位的 `trustees=false`
 *（r1 重要 19：ack 不得带 `trustee=true`，否则客户端会把「刚解除」渲染成托管中，
 * 直到下一次推送才纠正）。**清除失败 ⇒ 原样返回旧视图**（fail-open 的显式接受格）；
 * 刷新视图失败 ⇒ 退回旧视图 + 就地改写（同样 fail-open）。
 *
 * 只在局（bidding / playing）才转发：`init` 尚未开始（game-service 守卫会以 13009 拒绝）、
 * `ended` 无治理量 —— 两格都是「注定失败」的噪音 RPC（与 C21 的 waiting-leave 同一条理由）。
 */
async function viewWithTrusteeCleared(
  deps: RouterDeps,
  roomCode: string,
  userId: string,
  view: PlayerView,
): Promise<PlayerView> {
  if (view.state !== 'bidding' && view.state !== 'playing') return view;
  if (!(await clearTrusteeForReturn(deps, roomCode, userId))) return view;
  /**
   * 清除成功 ⇒ ack 快照**不得**带自己座位的 `trustee=true`（r1 重要 19：客户端会把
   * 「刚解除」渲染成托管中）。新取回的视图也过同一条改写：game-service 若仍回显旧
   * 治理态（极端抖动），ack 仍以「刚清除」为准。
   *
   * 多玩法（Task 2.2 / RH4）：按**实际长度**改写，不截 3 元组 —— 跑得快 2/4 人重连
   * 不得把 trustees 截成 3（旧实现 `[view.trustees[0..2]]` 会丢座位/错位）。
   * ⚠️ `DdzPlayerView` 为旧客户端把 trustees 收窄成 3 元组（类型层）；本函数对 pdk 视图
   * 同样按真实长度改写（运行期正确）。Task 5.3 的客户端联合类型落地后可去掉这层断言。
   */
  const withOwnTrusteeCleared = (v: PlayerView): PlayerView => {
    const trustees = v.trustees.map((trustee, index) =>
      index === v.seat ? false : trustee,
    ) as [boolean, boolean, boolean];
    return { ...v, trustees };
  };
  try {
    const fresh = (await deps.game.view(roomCode, userId)) as PlayerView | null;
    if (fresh) return withOwnTrusteeCleared(fresh);
  } catch (err) {
    deps.logger.warn(
      `Reconnect view refresh failed for ${userId} in ${roomCode}: ${String(err)}`,
    );
  }
  return withOwnTrusteeCleared(view);
}

/**
 * `game.resync`：重新拉取当前裁剪快照（13004 的被指引处置，§6.5）。
 *
 * §6.5 规定 `13004` 的**唯一**处置是「丢弃本地未确认状态 → 重新拉取当前裁剪快照
 * → 由用户重新发起操作」，且明确**不允许**为此触发断线重连。因此它必须是一条
 * 独立的消息：与 `game.reconnect` 共用 resolver 读面（记录候选照常参与读取），
 * 但**不** touch 在线观测点、**不**恢复投递链路、**不**做 ended/连接态判定
 * —— 纯粹是「重新拉一份当前快照」。
 */
async function handleResync(socket: Socket, deps: RouterDeps, userId: string): Promise<Ack> {
  const resolved = await deps.reconnect.resolveRecoverableRoom(userId);
  if (!resolved) return fail(ErrCode.NOT_IN_ROOM, 'You are not in an active game');
  const roomCode = resolved.roomCode;

  const view = await deps.game.view(roomCode, userId);
  if (!view) return fail(ErrCode.GAME_NOT_STARTED, 'Game has not started yet');
  await resendCardCounterStatus(socket, deps, roomCode, view.seat);
  return ok(view);
}

/** 记牌器收费片：重连/resync 的状态补发（读失败只 warn —— 补发不得让重连失败）。 */
async function resendCardCounterStatus(
  socket: Socket,
  deps: RouterDeps,
  roomCode: string,
  seat: number,
): Promise<void> {
  try {
    const status = await readCardCounterStatus(deps.redis, roomCode, seat);
    if (status !== null) emitCardCounterStatus(socket, status);
  } catch (err) {
    deps.logger.warn(
      `card_counter status resend failed for room ${roomCode} seat ${seat}: ${String(err)}`,
    );
  }
}

// ─── game.* ───────────────────────────────────────────────────────

/**
 * 出牌/过牌/叫抢。
 *
 * §5.3：身份映射的唯一实现是「在 GameSession.players 中按 id 找座位」；
 * 这里只把 **userId** 交给 game-service，由它完成映射与越权判定。
 */
async function forwardAction(
  deps: RouterDeps,
  userId: string,
  action: 'bid' | 'play' | 'pass',
  payload: Record<string, unknown>,
  baseVersion: number,
): Promise<Ack> {
  const resolved = await deps.reconnect.resolveRecoverableRoom(userId);
  if (!resolved) return fail(ErrCode.NOT_IN_ROOM, 'You are not in an active game');
  const roomCode = resolved.roomCode;

  const result = await deps.game.action(roomCode, action, userId, { ...payload, baseVersion });
  return ok(result);
}

/**
 * `game.trustee`（客户端按钮）—— **via `'manual'` 钉死**（C19 四处映射之一）。
 *
 * 房间由 resolver 派生（客户端不传房号，与动作转发同口径）。
 * 下游业务码（12001/12004/13005 …）经 `GameServiceError` 分支**原样** ack ——
 * 不得塌缩成 10007（C20）；`via × on` 的合法性守卫在 game-service（C7b）。
 */
async function handleTrustee(deps: RouterDeps, userId: string, on: boolean): Promise<Ack> {
  const resolved = await deps.reconnect.resolveRecoverableRoom(userId);
  if (!resolved) return fail(ErrCode.NOT_IN_ROOM, 'You are not in an active game');
  const result = await deps.game.trustee(resolved.roomCode, userId, on, 'manual');
  return ok(result);
}

// ─── 辅助 ─────────────────────────────────────────────────────────

function userIdOf(socket: Socket): string | null {
  const data = socket.data as { userId?: string } | undefined;
  return data?.userId ?? null;
}

/**
 * §9.8（机械规则）：下发给客户端的 id **不得以 `bot` 为前缀**。
 *
 * 机器人用**按座位派生的稳定不透明 id**。稳定性是必须的：前端按 `id` 给列表做 key，
 * 每次下发都变会让整张列表重排。
 *
 * ⚠️ **只用于出站载荷**。服务端内部的座位归属与 `game.deal` 投递路由
 * （`seatOwners` / `activeConnections`）**必须用 `Room.players` 里的真实 id**，
 * 否则推送到不了机器人座位。见 `handleJoin` 的注释。
 */
export function toOutboundPlayerId(userId: string, seat: number): string {
  return userId.startsWith('bot-') ? `seat-${seat}` : userId;
}

/**
 * `room.state_update` / `room.join` 的载荷必须裁剪（§6.4 规则 3）：
 * 只允许 `{ id, seat, cardCount?, balance? }`，**绝不含 `isRobot`**，且 id 过一遍 §9.8 的掩码。
 */
export async function buildRoomPlayers(
  deps: RouterDeps,
  room: Room,
  _callerId: string,
): Promise<RoomPlayer[]> {
  /**
   * ② 金币场 T5（§2.3）：座位余额来自**派生键** `room:{code}:balances` —— 由
   * `RoomStartService.storeGoldBalances()` 在**金币场开局时**写入（一次 `currency.get`）。
   * 免费场/好友房没有这个键 ⇒ `balance` 字段**永不出现**（客户端整场统一「—」的
   * 不可区分性红线靠它成立）；金币场读失败 ⇒ 同样无键 ⇒ 省略（客户端显「—」）。
   */
  const balances = (await deps.redis.hgetall(roomBalancesKey(room.code))) ?? {};
  // 昵称片（设计 D4）：批量回源只在缓存缺失时发生；失败降级为空映射（字段省略）。
  const nicknames = await deps.nicknames.ensure(room.code, room.players);
  const players: RoomPlayer[] = [];
  for (const { userId, seat } of room.players) {
    // §6.4 规则 3：只允许 { id, seat, cardCount?, balance?, nickname? }，**绝不含 isRobot**；
    // §9.8：id 过一遍掩码，机器人不得以 bot- 前缀出站（R48）。
    const player: RoomPlayer = { id: toOutboundPlayerId(userId, seat), seat };
    const nickname = nicknames.get(userId);
    if (nickname !== undefined) player.nickname = nickname;
    const rawBalance = balances[String(seat)];
    if (rawBalance !== undefined && Number.isFinite(Number(rawBalance))) {
      player.balance = Number(rawBalance);
    }
    if (room.status === 'playing') {
      // N35/R521：键名走**单一真源**（`cardCountKey`）—— 写入方在 `ws.gateway.writeCardCounts()`。
      // 旧实现两侧各自内联拼字符串，于是「有读无写」谁也发现不了。
      const count = await deps.redis.hget(cardCountKey(room.code), userId);
      if (count !== null) player.cardCount = Number(count);
    }
    players.push(player);
  }
  return players;
}

/**
 * 滑动窗口计数（§5.4）。**键与阈值由调用方给出** —— 一处判定逻辑、两档参数
 *（规格 §2.6-4：`isRateLimited` 扩参，**不得**复制第二套判定逻辑）：
 *  - 正常档：`ratelimit:ws:{socketId}` × `WS_RATE_LIMIT`（20/5s，按连接）；
 *  - 限流档：`ratelimit:ws-risk:{userId}` × `THROTTLED_RATE_LIMIT`（3/1s，按 userId 聚合）。
 */
async function isRateLimited(
  redis: Redis,
  key: string,
  now: number,
  limit: { readonly max: number; readonly windowMs: number } = WS_RATE_LIMIT,
): Promise<boolean> {
  await redis.zremrangebyscore(key, 0, now - limit.windowMs);
  const count = await redis.zcard(key);
  if (count >= limit.max) return true;
  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, Math.ceil(limit.windowMs / 1000));
  return false;
}

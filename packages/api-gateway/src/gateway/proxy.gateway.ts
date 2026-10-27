import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import io from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import {
  CLIENT_MESSAGE_TYPES,
  ErrCode,
  SERVER_MESSAGE_TYPES,
  validateOutbound,
} from '@fight-the-landlord/protocol';
import { randomUUID } from 'crypto';
import { runWithTrace } from '@fight-the-landlord/shared';
import type { Redis } from 'ioredis';
import type { DownstreamHeaders } from '../auth/identity-headers';
import { REDIS, SessionGuard } from '../auth/session.guard';
// 客户端接入片 T6：端闸服务与分类器（与 HTTP 第 0 步**共用同一份** —— T5）。
// ⚠️ **值导入**（DI 陷阱纪律）：`ClientGateService` 是构造注入的类型，`import type` 会被
// 擦除 ⇒ 容器解析时是 undefined、启动即崩（只有真容器会报，单测与 tsc 都看不见）。
import { ClientGateService, classifyClientPlatform } from '../auth/client-gate.service';
import {
  acquireWsConnSlot,
  attachWsConnSlot,
  releaseWsConnSlot,
  touchWsConnSlot,
  wsConnSlotOf,
} from '../http/rate-limit';
import { clientIpFrom, TRUST_TABLE } from '../http/trusted-client-ip';

/** engine.io 的 `allowRequest` 回调签名：`success === false` ⇒ 在传输层拒绝握手。 */
type AllowRequestCallback = (err: string | null | undefined, success: boolean) => void;

/**
 * 设备绑定片：WS 握手闸读取的绑定键前缀 —— 必须与 user-service
 * `device-bindings.service.ts` 的 `riskBindingKey()` **逐字同形**（各表一份，
 * 同 `risk:banned:` 在网关/user 两侧各写一份的既有惯例；端到端判据钉住不漂移）。
 */
const RISK_BINDING_KEY_PREFIX = 'risk:binding:';

/**
 * 设备指纹形状（与 user-service `users.dto.ts` 的 `deviceId` 校验、客户端
 * `storage.ts` 的域规则同形：8..64 的字母数字/`._-`）。
 * 不合形（旧端不带、隐私模式清存储、有人手改 auth）⇒ **fail-open 放行**：
 * REST 侧同态（无 deviceId 不绑不拦），WS 侧单边 fail-closed 会把合法旧端锁在游戏外。
 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * `allowRequest` 必须在**装饰器求值期**（早于任何实例化）交给 socket.io，因此它只能是一个
 * **模块级闭包**；而闭包里的 `this` 在调用时**不是**网关实例（箭头函数捕获的是模块作用域）。
 * ⇒ 实例在构造时把自己登记到这个槽位，闭包只做转发。「计数 / 拒绝」的逻辑体仍然**只有一处**
 * （`ProxyGateway#checkAllowRequest`），两处各写一遍就是第二个真源。
 *
 * 未登记（网关还没实例化就来了握手）⇒ **fail closed**：放行等于把限流变成静默可选开关
 * （与 R26/R141 同一条理由）。
 */
let allowRequestDelegate: ((req: unknown, callback: AllowRequestCallback) => void) | null = null;

function delegateAllowRequest(req: unknown, callback: AllowRequestCallback): void {
  if (!allowRequestDelegate) {
    callback('rate limit store unavailable', false);
    return;
  }
  allowRequestDelegate(req, callback);
}

/**
 * ack 关联字段（**网关内部协议，不是对外契约的一部分**）。
 *
 * 客户端 emit 期望 ack 时，网关生成一个 correlation id 放进请求体。
 * 下游收到后把它作为**事件名**回发（Nest 的 `@SubscribeMessage` 返回值即
 * socket.io ack，而 socket.io 的 ack 回调对**代理方**不可见 —— 它被
 * socket.io-client 消费掉了。因此代理只能用命名事件把 ack 运回来）。
 */
export const CORRELATION_KEY = '__ackId';

/**
 * §4.3 的网关侧兜底超时（A7/R143）。
 *
 * 取值必须是 §4.3 那张表的**上界**（5s）：网关超时若比下游自己的契约超时更短，
 * 网关会先砍掉请求并回 `10007`，下游本该给出的 `10003`/`12004` 等语义错误就永远
 * 看不到 —— 超时值本身是一条**语义**约束，不只是性能参数。
 */
export const GATEWAY_UPSTREAM_TIMEOUT_MS = 5000;

/**
 * WS 代理：客户端 ↔ api-gateway ↔ room-service（§6.1）。
 *
 * 关键点：
 *  1. **每个客户端一条独立的下游连接**，`@WebSocketGateway` 装饰器补上了
 *     —— 此前 `ProxyGateway` 没有装饰器，永远不会被实例化，整条 WS 链路是死代码（A2）；
 *  2. 网关是**唯一验签点**：客户端在握手 `auth.token` 里带 access token，
 *     验签后把 `{ userId, internalToken, traceId }` 放进**下游握手的 `auth`**（§5.2 rule 4）。
 *     ⚠️ 握手只在**建连那一刻**校验（带 `typ`/白名单），**已建立**的连接不会因登出而断开
 *     —— 这是 R28 记录的已知边界；但「拿 refresh token / 已吊销 token 新开一条连接」
 *     必须在握手就被拒（R24/R26）；
 *  3. 只转发**契约内**的事件名：客户端只能发 `CLIENT_MESSAGE_TYPES`，
 *     下游只能推 `SERVER_MESSAGE_TYPES`，且出站先过 `validateOutbound`；
 *  4. ack 透传：客户端 → 下游的 ack 用随机 correlation id + `__ack` 事件关联回来。
 */
@Injectable()
@WebSocketGateway({
  cors: true,
  namespace: '/ws/ddz',
  path: '/socket.io/',
  pingInterval: 30000,
  pingTimeout: 90000,
  // N15/R246：§5.4 的单 IP 并发连接 5 挪到 **engine.io 的传输层**判 ——
  // 超限的客户端拿到 `connect_error`（而不是「连上 → system.error → 被踢」，R152）。
  allowRequest: delegateAllowRequest,
})
export class ProxyGateway implements OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown {
  private readonly logger = new Logger(ProxyGateway.name);
  /** 活跃客户端连接（SIGTERM 时逐个释放 §5.4 名额并关闭）。 */
  private readonly clients = new Set<Socket>();
  private readonly roomSvcUrl = process.env.ROOM_SERVICE_WS_URL ?? 'http://localhost:3002';
  private readonly namespace = '/ws/ddz';

  /** Maps client socket id → room-service client socket */
  private readonly peerSockets = new Map<string, ClientSocket>();
  /** Maps `${clientId}:${correlationId}` → pending ack callback from the client. */
  private readonly pendingAcks = new Map<string, (response: unknown) => void>();
  /**
   * 下游 socket 尚未连上时暂存的请求。
   *
   * socket.io **不会**缓冲客户端的 emit：握手完成前发出的请求会被静默丢弃
   * （实测：三个客户端同时连上时，第三个的 `room.match` 直接丢掉）。
   * 因此这里按顺序排队，`connect` 后一次性冲刷。
   */
  private readonly pendingOutbound = new Map<string, Array<[string, unknown]>>();
  /** 暂存请求对应的 ack 回调，键为 `${clientId}:${队列下标}`。 */
  private readonly pendingCallbacks = new Map<string, ((response: unknown) => void) | undefined>();
  /**
   * 最近一次**应用层帧**的时间戳（ms）。
   *
   * 应用帧 = C→S 请求 或 S→C 业务推送（非 engine.io ping/pong）。
   * 与 `peerSockets` 同生命周期：连接建时初始化 0，断时清理。
   *
   * 用途：heartbeat 回调里检查是否超过 `IDLE_KICK_MS`（30min），
   * 引擎层活着但业务层无活动 → 主动踢线（客户端 25min 断连的服务端兜底）。
   */
  private readonly lastAppFrameAt = new Map<string, number>();
  /**
   * 应用层空闲兜底阈值：30 分钟（客户端主动断连 25min + 服务端 5min 兜底窗口）。
   * 单位 ms。
   */
  private static readonly IDLE_KICK_MS = 30 * 60 * 1000;

  constructor(
    private readonly jwtService: JwtService,
    /** R26 的唯一白名单查询点（与 HTTP 中间件**共用同一个** guard，不另写查询逻辑）。 */
    private readonly session: SessionGuard,
    /** §5.4（R141/N15）：单 IP 并发连接名额。与 HTTP 侧共用同一个 `REDIS` provider。 */
    @Inject(REDIS) private readonly redis: Redis,
    /** 客户端接入片 T6：端闸（与 HTTP 第 0 步**共用同一服务与同一分类器** —— T5）。 */
    private readonly clientGate: ClientGateService,
  ) {
    // 装饰器里的 `allowRequest` 是模块级闭包（见 `delegateAllowRequest` 的注释），
    // 这里把自己登记进去 —— 逻辑体只有 `checkAllowRequest` 一处。
    allowRequestDelegate = (req, callback) => {
      void this.checkAllowRequest(req, callback);
    };
  }

  /**
   * §5.4（R246）：**单 IP 并发 WS 连接 5** —— 在 engine.io 的 `allowRequest` 里判，
   * 超限**在传输层**拒绝 ⇒ 客户端拿到 `connect_error`（而不是先 `connect` 再被踢）。
   *
   * ⚠️ 握手**还没完成**，所以这里**没有** `socket.id`，也无从知道 token 是否合法：
   *  - 名额成员用一次性 nonce，并把它挂到**同一个请求对象**上，`disconnect` 时取回来释放；
   *  - 因此未认证的连接**也会**短暂占一个名额 —— 它在 `handleConnection` 里被拒后
   *    `disconnect` 立刻释放。这是**传输层限流**的固有性质（限的是连接，不是用户），
   *    也是 R246 要的：对方连 TCP 都别想建起来。
   *
   * ⚠️ **必须恰好回调一次**（含异常路径）：`allowRequest` 不回调就不会有握手结果 ——
   * engine.io 既不回 403 也不放行，连接会**永久挂着**（比拒绝更糟）。
   * ⚠️ Redis 故障 ⇒ **fail closed**（R26/R141 同一条理由）。
   *
   * ⚠️ **最终评审 I2**：本族的两行（`Rejecting WS handshake` / 限额存储故障）原先落在
   * 任何 ALS 之外 ⇒ 渲染成 `source: 'bootstrap'`（含义是「进程启动早期」）—— 是**假话**。
   * 这里**只加一层包裹**（判定逻辑与「恰好一次」的保证逐字保留）：
   * 此刻**还没有 socket**（握手未完成）⇒ 拿不到连接级 id，`traceId: null`，
   * 但 `source` 如实标 `edge`（那确实是一次**边缘**连接尝试；R1107：不编造 id）。
   */
  private checkAllowRequest(req: unknown, callback: AllowRequestCallback): Promise<void> {
    return runWithTrace({ traceId: null, source: 'edge' }, () =>
      this.checkAllowRequestInner(req, callback),
    );
  }

  /** ALS 包裹外的那一层：与 `checkAllowRequest` 同一实现，逐字搬自原方法体。 */
  private async checkAllowRequestInner(req: unknown, callback: AllowRequestCallback): Promise<void> {
    let answered = false;
    const answer = (err: string | null | undefined, ok: boolean): void => {
      if (answered) return; // 「恰好一次」的机械保证（两条路径 + throw 路径共用它）
      answered = true;
      callback(err, ok);
    };

    try {
      const ip = this.requestIp(req);
      const member = randomUUID();
      const allowed = await acquireWsConnSlot(this.redis, ip, member);
      if (!allowed) {
        this.logger.warn(
          `Rejecting WS handshake from ${ip}: ${ErrCode.RATE_LIMITED} too many connections from this IP`,
        );
        answer('too many connections from this IP', false);
        return;
      }
      attachWsConnSlot(req as object, { ip, member });
      answer(null, true);
    } catch (err) {
      this.logger.warn(`WS connection limit store unavailable (fail closed): ${String(err)}`);
      answer('rate limit store unavailable', false);
    }
  }

  /**
   * 客户端 IP —— **唯一实现**是 `trusted-client-ip.ts` 的 `clientIpFrom`
   * （§3 / R1204–R1207；HTTP 中间件调同一个函数 ⇒ 两个调用点一套口径）。
   *
   * `allowRequest` 拿到的是**原始 HTTP 请求**（不是 socket.io 的 `Socket`），对端地址从
   * `req.socket.remoteAddress` 取 —— 它与 `client.handshake.address` **同源**
   * （engine.io：websocket 传输取 `req.websocket._socket.remoteAddress`，
   * polling 取 `req.connection.remoteAddress`，两者都是同一个底层 net.Socket）。
   * 头只在**对端可信**（`TRUST_TABLE` 含对端地址，即生产形态的门口）时才被采信；
   * 信任表为空（开发形态）⇒ 忽略一切头（= 现状）。取不到对端 ⇒ 单一 `'unknown'` 桶，
   * **仍然计数**（R141：取不到 IP 不等于豁免）。
   */
  private requestIp(req: unknown): string {
    const r = req as { headers?: Record<string, unknown>; socket?: { remoteAddress?: unknown } };
    const address = r?.socket?.remoteAddress;
    const peer = typeof address === 'string' && address.length > 0 ? address : 'unknown';
    return clientIpFrom(r?.headers ?? {}, peer, TRUST_TABLE);
  }

  /**
   * 复核⑦ —— traceId 的**生成点上移到本方法开头**（spec §3 载体③）。
   *
   * 原实现要等到「建下游连接」处才 `randomUUID()`，而方法体内的 `Client connected`
   * 日志比它**更早** ⇒ 那行拿不到 id，「网关 `Client connected` 行与下游 `auth.traceId`
   * 是同一个 id」（判据 6′ 的网关侧一半）无从成立。
   *
   * `runWithTrace` 包住**整条连接的处理**（只是包住，其余逻辑一字未动 —— 顺序、
   * 早返回、名额检查全部在原方法体里逐字保留）：同一个 id 既进 ALS（`Client connected`
   * / `room-service connected` 因此共用），又随下游握手 `auth.traceId` 传给
   * room-service（经 `socket.data.traceId` 成为**连接级** id）。
   *
   * ⚠️ **复核⑫ 的那句话已过期（最终评审 I2 订正，只改注释）**：复核⑫ 记的是「当时」
   * 的事实 —— `Client disconnected` 落在 `runWithTrace` **之外**（ALS 按**发出事件者**的
   * 异步上下文传播，socket 关闭链起于包裹之外）⇒ 那行是 `traceId: null` +
   * `source: 'bootstrap'`。I2 之后**断开回调自己也包了一层**（用连接级的同一个 `traceId`）
   * ⇒ 它现在**带**该连接的 id、`source: 'edge'`。差别在「有没有包」，不在 ALS 的语义。
   */
  async handleConnection(client: Socket): Promise<void> {
    const traceId = randomUUID();
    return runWithTrace({ traceId, source: 'edge' }, () => this.handleConnectionInner(client, traceId));
  }

  /**
   * 握手 → 建下游连接。
   *
   * ⚠️ **同步段必须先注册客户端的监听**，再 `await` 白名单查询（N1）：
   * `verifyClient` 会让出到 Redis 查询（~1ms）之后才继续，如果转发监听是在
   * `await` 之后才注册，那么窗口内到达的 C→S 消息**没有任何监听器** ——
   * socket.io 会把它静默丢掉（客户端既拿不到 ack 也收不到错误），而
   * `pendingOutbound` 队列根本够不着它。同一个窗口里客户端若断开，
   * `dropPeer` 也是 no-op（`peerSockets` 还没有条目），随后就会为一条已关闭的
   * socket 建出下游连接并泄漏。
   *
   * 因此这里：① 同步注册 C→S 转发监听（`roomSock` 由闭包后置赋值，未就绪就入队）；
   * ② 同步注册 `disconnect` 清理并置 `clientGone`；③ `await` 之后再确认一次
   * `client.connected`，验签失败或客户端已走都**不建**下游连接。
   */
  private async handleConnectionInner(client: Socket, traceId: string): Promise<void> {
    this.clients.add(client);
    // 初始化应用帧时间戳：0 = 会话刚创建，还没收发过业务帧。
    // heartbeat 回调跳过 0 值，避免握手刚完就触发兜底踢线。
    this.lastAppFrameAt.set(client.id, 0);
    const auth = (client.handshake?.auth ?? {}) as {
      token?: string;
      userId?: string;
      /** 客户端接入片 T6：端标识（自报值，未验真；非法/缺失 ⇒ 未识别桶）。 */
      clientPlatform?: unknown;
      /** 设备绑定片：端上报的设备标识（服务端据此校验账号与设备的绑定关系）。 */
      deviceId?: string;
    };

    /** 下游连接：在 `await` 之后才赋值；闭包里的监听据此判定「入队」还是「直接转发」。 */
    let roomSock: ClientSocket | null = null;
    /** `await` 期间客户端断开过（或断开后由 `handleDisconnect` 清理）。 */
    let clientGone = false;

    // ① 客户端 → 下游（只允许契约内的 C→S 消息名）。必须在任何 await 之前注册。
    for (const type of CLIENT_MESSAGE_TYPES) {
      client.on(type, (data: unknown, ack?: (response: unknown) => void) => {
        // C→S 应用帧：更新时间戳（会话刚创建的 0 值也在第一次业务帧时覆盖）
        this.lastAppFrameAt.set(client.id, Date.now());
        if (!roomSock || !roomSock.connected) {
          // 下游还没建好/还没连上 → 排队等 `connect` 后冲刷，
          // 而不是把请求丢掉或直接回 10007（复用既有队列，不另造缓冲）。
          const queue = this.pendingOutbound.get(client.id) ?? [];
          queue.push([type, data]);
          this.pendingOutbound.set(client.id, queue);
          this.pendingCallbacks.set(`${client.id}:${queue.length - 1}`, ack);
          return;
        }
        this.forwardToPeer(client.id, roomSock, type, data, ack);
      });
    }

    // ② 同步注册断线清理：与 `handleDisconnect` 各自独立、都幂等，
    // 不依赖两者谁先被调用。
    client.on('disconnect', () => {
      /**
       * **最终评审 I2**：断线回调起于 `handleConnection` 的 `runWithTrace` **之外**
       * ⇒ 这两行原先落成 `source: 'bootstrap'`（「启动早期」= 假话）。
       * **该连接的**连接级 id 就在本闭包里（`traceId` 由 `handleConnection` 开头生成、
       * 与下游握手 `auth.traceId` 是同一个）⇒ 包一层即得；判定逻辑逐字保留。
       */
      runWithTrace({ traceId, source: 'edge' }, () => {
        clientGone = true;
        this.logger.log(`Client disconnected: ${client.id}`);
        this.dropPeer(client.id);
        // R141/N15：释放§5.4 的连接名额。名额是 `allowRequest` 在传输层占的，挂在**请求对象**
        // 上（`wsConnSlotOf` 取回 ip + member —— 两处都从同一处取，不重新推导 IP），
        // 因此这里 K 与 member 一定配对。**幂等**：没占到名额的连接（被拒的握手、从没连上的）
        // ZREM 是 no-op。失败只记日志 —— 名额有 TTL 兜底，绝不能因为清理失败就把异常抛进
        // socket.io 的事件循环。
        const slot = wsConnSlotOf(client);
        if (!slot) return;
        void releaseWsConnSlot(this.redis, slot.ip, slot.member).catch((err) =>
          this.logger.error(`Failed to release WS conn slot for ${client.id}: ${String(err)}`),
        );
      });
    });

    // 客户端接入闸（先于验签：端关了不必验签；位次在 disconnect 注册之后——保住名额释放）。
    const platform = classifyClientPlatform(auth.clientPlatform);
    if (platform !== null && !this.clientGate.allows(platform)) {
      this.rejectHandshake(client, ErrCode.CLIENT_DISABLED, `client gate closed: ${platform}`);
      return;
    }

    const userId = await this.verifyClient(client, auth);
    if (!userId) return;

    /**
     * ⚠️ **最终评审 I3**：**验签成功之后**用**已验证的 `sub`** 嵌套 `runWithTrace`
     * 覆盖余下处理 —— 与 HTTP 载体（`jwt.middleware` 验签后嵌套重跑，复核⑩）
     * **同形**。此前网关 WS 侧从不把 `userId` 写进 ALS ⇒ 网关侧 WS 的行一律
     * `userId: null`，而 §15.3 的语义是「`userId`（**若有**）」—— 这里**有**
     * （`verifyClient` 刚返回验签后的 `sub`）。
     *
     * ⚠️ **绝不**采信 `auth.userId`（客户端可控）：它只可能来自上面的 `verifyClient`。
     * 包裹**只加一层**（`traceId` 沿用连接级 id、`source` 仍是 `edge`），余下处理
     * —— 含下方全部日志与监听注册 —— 逐字保留。
     */
    return runWithTrace({ traceId, userId, source: 'edge' }, () => {
      // ③ await 期间客户端可能已经走了：绝不为一条已关闭的连接建下游连接。
      if (clientGone || client.connected === false) {
        this.dropPeer(client.id); // 幂等（此时本就没有条目）
        return;
      }

      this.logger.log(`Client connected: ${client.id} (user: ${userId})`);

      // ③ §5.4（R246/N15）：连接名额**已经在传输层**（engine.io 的 `allowRequest`）占好/拒绝了
      //    —— 超限的连接**根本走不到这里**（客户端拿 `connect_error`，不是「连上即被踢」）。
      //    这里只做两件事：取回那次占用的名额（供续期与释放用）+ 借 engine.io 的心跳续期 TTL。
      const slot = wsConnSlotOf(client);
      if (!slot) {
        // 生产路径必然经 `allowRequest`；拿不到名额只可能是**单测直接调 handleConnection**，
        // 或者是有人绕过了限额检查。记 warn 而不是静默 —— 静默就是「限流可以不存在」。
        this.logger.warn(`WS connection ${client.id} has no rate-limit slot (allowRequest bypassed?)`);
      } else {
        // engine.io 每 30s 一个 `heartbeat`（装饰器的 `pingInterval: 30000`）⇒ 借它续期：
        // 不续期的话 TTL（60s）兜底会把**长连接**当成崩溃残留删掉，第 6 条就能挤进来。
        //
        // 同时借它做「应用层空闲兜底」检查：engine.io ping/pong 不算应用帧，
        // 所以 30min 内只有心跳没有业务活动 → 引擎层活着但业务层空闲 → 主动踢线。
        // （客户端主动 25min 断连在前，这里是服务端兜底）。
        client.conn?.on?.('heartbeat', () => {
          void touchWsConnSlot(this.redis, slot.ip).catch(() => undefined);
          const lastFrame = this.lastAppFrameAt.get(client.id);
          // 0 = 会话刚创建还没收发过业务帧，跳过
          if (lastFrame && Date.now() - lastFrame > ProxyGateway.IDLE_KICK_MS) {
            this.logger.log(
              `WS connection ${client.id} idle for ${Math.round((Date.now() - lastFrame) / 1000)}s, kicking`,
            );
            client.disconnect(true);
          }
        });
      }

      // §5.2 rule 4：为每个客户端建立一条下游连接，并在下游 auth 中携带身份
      //
      // 风控 T7（规格 §2.9-1）：auth 增 `clientIp` —— 取**连接槽位对象**的 ip
      //（`wsConnSlotOf(client.request)?.ip`；与名额释放/心跳续期**同一处取**，
      // 不在转发侧从 handshake 重新推导 —— 两处各推导一次就有漂移面）；
      // `'unknown'`（取不到对端）/ 无槽位（单测直调、绕过 allowRequest）⇒
      // **不注入该键**（缺省语义）。下游 room 侧（T3）再按 `string ≤64 且 ≠'unknown'`
      // 复检后写 `socket.data.clientIp`。
      const clientIp = slot?.ip;
      const sock = io(`${this.roomSvcUrl}${this.namespace}`, {
        path: '/socket.io/',
        transports: ['websocket'],
        auth: {
          userId,
          internalToken: process.env.INTERNAL_SERVICE_TOKEN,
          // 复核⑦：用**连接级**的同一个 id（生成点已上移到 `handleConnection` 开头）——
          // 此前这里现生成一个 ⇒ 网关自己的日志与下游的行各带各的 id，「两侧同一 id」不成立。
          traceId,
          ...(clientIp !== undefined && clientIp !== 'unknown' ? { clientIp } : {}),
        },
      });
      roomSock = sock;
      this.peerSockets.set(client.id, sock);

      sock.on('connect', () => {
        this.logger.log(`room-service connected for client ${client.id}`);
        this.flushPending(client.id, sock);
      });

      sock.on('connect_error', (err: Error) => {
        this.logger.error(`room-service connection error for client ${client.id}: ${err.message}`);
        client.emit('system.error', { version: 0, payload: { code: 10007, message: err.message } });
      });

      // 下游 ack 回程 → 客户端 ack。
      // 回程的事件名就是网关生成的 correlation id，因此任何**不在**
      // 契约 S→C 清单里的事件名都只可能是 ack 回程，不会与推送混淆。
      sock.onAny((event: string, payload: unknown) => {
        if (SERVER_MESSAGE_TYPES.includes(event as (typeof SERVER_MESSAGE_TYPES)[number])) return;
        const key = `${client.id}:${event}`;
        const pending = this.pendingAcks.get(key);
        if (!pending) return;
        this.pendingAcks.delete(key);
        pending(payload);
      });

      // 下游 → 客户端：只转契约内的 S→C 事件，且发送前过出站校验
      for (const type of SERVER_MESSAGE_TYPES) {
        sock.on(type, (message: unknown) => {
          // 推送信封是 `{ version, payload }`；出站校验需要带 `type` 的完整消息，
          // 因此这里补上 type 再校验 —— 校验器会机械拦住 actionLog / isRobot /
          // 他人手牌等永不出站字段（§6.4 规则 4）。
          try {
            validateOutbound({ type, ...(message as Record<string, unknown>) });
          } catch (err) {
            this.logger.error(`Blocked outbound ${type} for client ${client.id}: ${String(err)}`);
            return;
          }
          // S→C 应用帧：更新时间戳
          this.lastAppFrameAt.set(client.id, Date.now());
          client.emit(type, message);
        });
      }
    });
  }

  handleDisconnect(client: Socket): void {
    this.clients.delete(client);
    this.dropPeer(client.id);
  }

  /**
   * k3s 优雅停机（spec 2026-10-27 D16）：SIGTERM 时先释放本 Pod 持有的 WS 名额，
   * 再断开客户端；否则名额要靠 60s TTL 兜底，缩容/滚动更新后同 IP 用户会短暂连不上。
   */
  async onApplicationShutdown(): Promise<void> {
    const clients = [...this.clients];
    this.clients.clear();
    await Promise.allSettled(
      clients.map(async (client) => {
        const slot = wsConnSlotOf(client);
        if (slot) {
          await releaseWsConnSlot(this.redis, slot.ip, slot.member).catch((err) =>
            this.logger.error(`Failed to release WS conn slot on shutdown: ${String(err)}`),
          );
        }
        client.disconnect(true);
      }),
    );
  }

  /** 下游连上后，把握手期间暂存的请求按原顺序发出。 */
  private flushPending(clientId: string, roomSock: ClientSocket): void {
    const queue = this.pendingOutbound.get(clientId) ?? [];
    this.pendingOutbound.delete(clientId);
    queue.forEach(([type, data], index) => {
      const ack = this.pendingCallbacks.get(`${clientId}:${index}`);
      this.pendingCallbacks.delete(`${clientId}:${index}`);
      this.forwardToPeer(clientId, roomSock, type, data, ack);
    });
  }

  /**
   * 转发一条 C→S 请求到下游。
   *
   * ⚠️ 必须原样转发**整个扁平请求体**（§6.2 的 `{reqId, baseVersion, timestamp, payload}`）：
   * 只转发 payload 会让下游的 `validateClientMessage` 拒绝全部动作
   * （实测：所有 C→S 消息返回 10001）。
   *
   * 需要 ack 时附加 `__ackId`；下游把它作为**事件名**回发（socket.io 的 ack
   * 回调会被 socket.io-client 消费掉，代理只能用命名事件把 ack 运回来）。
   */
  private forwardToPeer(
    clientId: string,
    roomSock: ClientSocket,
    type: string,
    data: unknown,
    ack?: (response: unknown) => void,
  ): void {
    if (typeof ack !== 'function') {
      roomSock.emit(type, data);
      return;
    }
    const correlationId = randomUUID();
    this.pendingAcks.set(`${clientId}:${correlationId}`, ack);
    roomSock.emit(type, { ...(data as Record<string, unknown>), [CORRELATION_KEY]: correlationId });
  }

  private dropPeer(clientId: string): void {
    const roomSock = this.peerSockets.get(clientId);
    if (roomSock) {
      roomSock.disconnect();
      this.peerSockets.delete(clientId);
    }
    for (const key of [...this.pendingAcks.keys()]) {
      if (key.startsWith(`${clientId}:`)) this.pendingAcks.delete(key);
    }
    for (const key of [...this.pendingCallbacks.keys()]) {
      if (key.startsWith(`${clientId}:`)) this.pendingCallbacks.delete(key);
    }
    this.pendingOutbound.delete(clientId);
    this.lastAppFrameAt.delete(clientId);
  }

  /**
   * 风控 T7（规格 §2.7-2②）：**握手封禁读旗** —— 键 `risk:banned:{userId}`（§2.3 逐字；
   * 网关只读不写，写点 = user-service 的封禁动作/扫描自愈）。位置写死：
   * **session 校验通过后**（先证明令牌可用，再看封禁；旗读故障不改变上面的
   * 10007 fail-closed 语义 —— 单独 try/catch ⇒ 按无旗 + error 日志，R11/F8）。
   * 命中 ⇒ 走既有 `rejectHandshake` 面（`disconnect(true)` + 尽力 `system.error` `11003`；
   * 权威信号 = 断开本身，同 §6.3）。
   */
  private async isBanned(userId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(`risk:banned:${userId}`)) === 1;
    } catch (err) {
      this.logger.error(
        `Risk ban flag read failed for ${userId} (risk:banned:${userId}): ${String(err)} — fail-open (按无旗)`,
      );
      return false;
    }
  }

  /**
   * 设备绑定片：**握手绑定闸** —— 键 `risk:binding:{userId}`（user-service 绑定时写透、
   * 无 TTL；解绑时 DEL）。网关只读不写。
   *
   * 三态：
   *  - 键缺（`GET` ⇒ null：开关从未开过 / 存量玩家尚未首绑 / 已解绑）⇒ 放行；
   *    ⇒ 开关本身不需要网关感知：键只在开关开时才会被写，键缺即放行天然实现「开关关零变化」；
   *  - 键在且值 = 本机 deviceId ⇒ 放行；
   *  - 键在且值 ≠ 本机 ⇒ **拒绝**（第二台设备，REST 闸 11005 的 WS 同态）。
   *
   * fail-open 面（与 `isBanned` 的读故障姿态同族，但理由更强：绑定是业务级防共享，
   * 不是封禁安全边界；Redis 抖动锁死全部玩家在线不可接受）：
   *  - 无 deviceId / 不合形（旧端、隐私模式）⇒ 放行；
   *  - Redis 读抛 ⇒ 按无键放行 + error 日志。
   */
  private async isBoundToOtherDevice(userId: string, deviceId: unknown): Promise<boolean> {
    if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) return false;
    try {
      const bound = await this.redis.get(`${RISK_BINDING_KEY_PREFIX}${userId}`);
      return bound !== null && bound !== deviceId;
    } catch (err) {
      this.logger.error(
        `Device binding read failed for ${userId} (${RISK_BINDING_KEY_PREFIX}${userId}): ${String(err)} — fail-open (按无绑定)`,
      );
      return false;
    }
  }

  /**
   * 握手验签（§6.1 + §5.1 的 R24/R26）。
   *
   * 客户端在 `auth.token` 携带 access token。**握手是网关的第二个鉴权入口**，
   * 因此这里必须与 HTTP 中间件做同一套校验，否则：
   *  - 一张 7 天的 **refresh token** 能直接开 `/ws/ddz`（R24 失效）；
   *  - 刚登出、jti 已从白名单删除的 access token 也能新开连接（R26 失效）。
   *
   * 失败一律拒绝握手（`disconnect(true)`），并**尽力**用契约内唯一的 S→C 通道
   * `system.error` 把契约码带给客户端（§6.3）。R28 的边界只覆盖「已建立的连接
   * 不因登出而断开」，不覆盖新握手。
   */
  private async verifyClient(
    client: Socket,
    auth: { token?: string; deviceId?: string },
  ): Promise<string | null> {
    if (typeof auth.token !== 'string' || auth.token.length === 0) {
      this.rejectHandshake(client, ErrCode.UNAUTHENTICATED, 'missing auth.token');
      return null;
    }

    let payload: { sub?: string; jti?: string; typ?: string };
    try {
      payload = this.jwtService.verify(auth.token) as typeof payload;
    } catch (err) {
      const expired = (err as { name?: string })?.name === 'TokenExpiredError';
      this.rejectHandshake(
        client,
        expired ? ErrCode.TOKEN_EXPIRED : ErrCode.TOKEN_INVALID,
        'invalid or expired token',
      );
      return null;
    }
    if (!payload?.sub) {
      this.rejectHandshake(client, ErrCode.TOKEN_INVALID, 'token has no subject');
      return null;
    }

    // R24：只有 access token 能握手（refresh token 的 jti 也在白名单里，不校验 typ
    // 的话它就能开一条完整的游戏连接）。
    if (payload.typ !== 'access' || !payload.jti) {
      this.rejectHandshake(client, ErrCode.TOKEN_INVALID, 'token typ must be "access"');
      return null;
    }

    // R26：白名单查询（复用 HTTP 侧同一个 `SessionGuard`）。Redis 故障 → 10007，不放行。
    let active: boolean;
    try {
      active = await this.session.isActive(payload.jti);
    } catch {
      this.rejectHandshake(client, ErrCode.UPSTREAM_UNAVAILABLE, 'session store unavailable');
      return null;
    }
    if (!active) {
      this.rejectHandshake(client, ErrCode.TOKEN_EXPIRED, 'token has been revoked or expired');
      return null;
    }

    // 风控 T7（规格 §2.7-2②）：**session 校验通过后**读封禁旗（顺序敏感 —— 未过白名单
    // 的握手根本不读旗）；命中 ⇒ 拒绝面与其余握手失败**同一处**（`rejectHandshake`）。
    if (await this.isBanned(payload.sub)) {
      this.rejectHandshake(client, ErrCode.USER_BANNED, 'user is banned');
      return null;
    }

    // 设备绑定片（安全功能 §设备绑定）：封禁旗**之后**读绑定键。存在且≠本机 ⇒ 11005
    // 拒连，堵住好友房 `room.join` 等不经 REST 的 WS 直连绕过。键缺（开关关/存量未绑/
    // 解绑后）、Redis 故障、客户端无合形 deviceId ⇒ fail-open（与 REST 闸同态）。
    if (await this.isBoundToOtherDevice(payload.sub, auth.deviceId)) {
      this.rejectHandshake(client, ErrCode.DEVICE_MISMATCH, 'account bound to another device');
      return null;
    }

    return payload.sub;
  }

  /**
   * 拒绝握手：记日志 → 尽力回一个契约码 → 断开。
   *
   * ⚠️ `system.error` 是 **best-effort**：它与 `disconnect(true)` 在同一个 tick 里发出，
   * socket.io 可能来不及把这一帧刷出去。**权威信号是断开本身**，客户端不得把
   * 「没收到 `system.error`」当成握手成功。
   */
  private rejectHandshake(client: Socket, code: ErrCode, message: string): void {
    this.logger.warn(`Rejecting socket ${client.id}: ${code} ${message}`);
    try {
      client.emit('system.error', { version: 0, payload: { code, message } });
    } catch {
      // 尽力而为：发不出去也要断开，不能因为错误通道失败就放行。
    }
    client.disconnect(true);
  }

  /** Forward HTTP request to user-service. */
  async forwardToUserSvc(
    method: string,
    path: string,
    body: unknown,
    res: any,
    headers?: DownstreamHeaders,
  ): Promise<void> {
    await this.forward(`${process.env.USER_SERVICE_URL ?? 'http://localhost:3001'}${path}`, method, body, res, headers);
  }

  /** Forward HTTP request to room-service. */
  async forwardToRoomSvc(
    method: string,
    path: string,
    body: unknown,
    res: any,
    headers?: DownstreamHeaders,
  ): Promise<void> {
    await this.forward(`${process.env.ROOM_SERVICE_URL ?? 'http://localhost:3002'}${path}`, method, body, res, headers);
  }

  /** Forward HTTP request to game-service. */
  async forwardToGameSvc(
    method: string,
    path: string,
    body: unknown,
    res: any,
    headers?: DownstreamHeaders,
  ): Promise<void> {
    await this.forward(`${process.env.GAME_SERVICE_URL ?? 'http://localhost:3003'}${path}`, method, body, res, headers);
  }

  /**
   * Forward HTTP request to config-service（片⑦ T10 / spec §2.7）：
   * `GET /api/config`（玩家面七键子集）与 `/api/admin/*`（管理面四条中的三条）。
   *
   * ⚠️ 回落基址与其他服务**形态不同**（容器名而不是 `localhost`）：config-service 的
   * HTTP 3006 **从不发布到宿主**（spec §2.1 —— 客户端面/管理面一律经网关），因此
   * 这里没有「宿主直跑」形态；compose 已显式设 `CONFIG_SERVICE_URL=http://config-service:3006`，
   * 回落值与之逐字同形（判据：`docker-compose.yml` 的该行 + 本文件的默认值共用一个形态）。
   */
  async forwardToConfigSvc(
    method: string,
    path: string,
    body: unknown,
    res: any,
    headers?: DownstreamHeaders,
  ): Promise<void> {
    await this.forward(
      `${process.env.CONFIG_SERVICE_URL ?? 'http://config-service:3006'}${path}`,
      method,
      body,
      res,
      headers,
    );
  }

  /**
   * Forward HTTP request to currency-service（货币片 T7 / 规格 §2.13）：
   * `GET /api/wallet/balance`（玩家面）与 `/api/admin/wallet/*`（管理双端点）。
   *
   * 形状**照 `forwardToUserSvc`**（规格 §2.13 逐字：URL =
   * `process.env.CURRENCY_SERVICE_URL ?? 'http://localhost:3004'`）；
   * compose 的网关块已显式设 `CURRENCY_SERVICE_URL=http://currency-service:3004`。
   */
  async forwardToCurrencySvc(
    method: string,
    path: string,
    body: unknown,
    res: any,
    headers?: DownstreamHeaders,
  ): Promise<void> {
    await this.forward(
      `${process.env.CURRENCY_SERVICE_URL ?? 'http://localhost:3004'}${path}`,
      method,
      body,
      res,
      headers,
    );
  }

  /**
   * Forward HTTP request to payment-service（支付片 T12 / 规格 §2.7.2）：
   * `/api/admin/pay/*`（管理面八端点）与 `/api/pay/*`（**玩家面九端点**，T13 接线——
   * 同一基址、另一族路由；写面限流三档在 `HttpRateLimitMiddleware`）。
   *
   * 形状**照 `forwardToUserSvc`**（规格 §2.7.2 逐字：URL = `process.env.PAYMENT_SERVICE_URL`；
   * `design.md` §2.3 env 表已登记，回落值为宿主直跑形态 `http://localhost:3007`）；
   * compose 的网关块已显式设 `PAYMENT_SERVICE_URL=http://payment-service:3007`。
   * ⚠️ `/pay/notify/*`（渠道回调）**不经**网关 —— edge 直连（规格 §2.7.1）。
   */
  async forwardToPaymentSvc(
    method: string,
    path: string,
    body: unknown,
    res: any,
    headers?: DownstreamHeaders,
  ): Promise<void> {
    await this.forward(
      `${process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:3007'}${path}`,
      method,
      body,
      res,
      headers,
    );
  }

  /**
   * Shared HTTP forwarding.
   *
   * §5.2: the identity headers injected by `JwtMiddleware` are propagated so
   * downstream services can trust `X-User-Id` instead of any body field.
   *
   * ⚠️ `method` 是**任意 HTTP 动词**（片⑦ T10 起含 `'PUT'` —— 管理写 `/api/admin/config/:key`）：
   * `RequestInit['method']` 本身就是 `string`，产品侧不需要、也**不得**收窄成联合类型
   * （收窄会把「以后新增动词要改三处」变成无声的编译面）。
   */
  private async forward(
    url: string,
    method: string,
    body: unknown,
    res: any,
    headers?: DownstreamHeaders,
  ): Promise<void> {
    const outbound: Record<string, string> = { 'Content-Type': 'application/json' };
    if (headers?.userId) outbound['X-User-Id'] = headers.userId;
    if (headers?.traceId) outbound['X-Trace-Id'] = headers.traceId;
    // R31：只服务 `/api/auth/logout`，不下发客户端、不进 §5.2 通用身份契约。
    if (headers?.tokenJti) outbound['X-Token-Jti'] = headers.tokenJti;
    // P0-3：`Authorization` 只由 `headersOf()` 在 `/api/auth/reauth` 产出
    // （user-service 的 `JwtAuthGuard` 需要 Bearer）；⛔ 不是全局透传。
    if (headers?.authorization) outbound['Authorization'] = headers.authorization;
    // P0-3：一次性再认证票据只由 `headersOf()` 在 `POST /api/pay/withdrawals` 产出。
    if (headers?.reauthTicket) outbound['X-Reauth-Ticket'] = headers.reauthTicket;
    // §5.2 规则 3（N7）：**每一跳**都带上内部 token（四个下游服务在全部业务路由校验它）。
    if (headers?.internalToken) outbound['X-Internal-Token'] = headers.internalToken;
    // 片⑦ T10（D6）：管理标记头。`headersOf()` 只从**验真产物**（`AdminAuthMiddleware`
    // 验签后注入的 `X-Admin: 1`）转出 `admin: true`；客户端伪造值在验签**之前**就被剥掉。
    // 下游 config-service 的 `XAdminGuard` 只信「存在且恰好 `'1'`」—— 值在这里逐字写死。
    if (headers?.admin) outbound['X-Admin'] = '1';
    // ③ T5（§2.10 第 7 步）：管理身份两枚 —— 与 `admin` 同源（`AdminAuthMiddleware` 在
    // 验签 + claims 校验 + policy 通过之后注入的 `X-Admin-Actor`/`X-Admin-Roles`，
    // `headersOf()` 转出）。下游写面（config PUT、wallet adjust/reverse）**依赖 actor 头**
    // 做留痕：缺失/非法 ⇒ 401 fail-closed（绝不回退 `'admin'`）。
    if (headers?.adminActor) outbound['X-Admin-Actor'] = headers.adminActor;
    if (headers?.adminRole) outbound['X-Admin-Roles'] = headers.adminRole;
    // 代理门户（2026-10-26）：`headersOf()` 只在 `/api/agent/*`（非 login）产出；
    // 值来自 `AgentAuthMiddleware` 验签后的注入（客户端伪造头已先剥）。
    if (headers?.agentId) outbound['X-Agent-Id'] = headers.agentId;
    if (headers?.agentVer) outbound['X-Agent-Ver'] = headers.agentVer;
    // ③ T5：`clientIp` **仅登录路径**产出（`headersOf()` 的 `isAdminLoginPath` 判定）——
    // 下游登录事件落 `ip` 列用它；值由网关派生，客户端无法伪造（先剥后派生）。
    if (headers?.clientIp) outbound['X-Client-Ip'] = headers.clientIp;

    const opts: RequestInit = {
      method,
      headers: outbound,
      // A7/R143：下游不可达 / 卡住时，网关必须自己收口。没有它，一个卡死的下游
      // 会把网关的请求**无限期**挂住（Nest 既不超时也不回错误体）。
      signal: AbortSignal.timeout(GATEWAY_UPSTREAM_TIMEOUT_MS),
    };
    if (body !== null && body !== undefined) opts.body = JSON.stringify(body);

    let resp: Response;
    try {
      resp = await fetch(url, opts);
    } catch (err) {
      // A7/R143：下游不可达 / 超时**必须**映射成契约错误码（§11.2 的 10007 + 503）。
      // 旧实现把异常直接抛给 Nest ⇒ 客户端拿到 500 与非契约体，而 `mapHttpStatus`
      // 那套映射在网关这一层根本不存在（room→game 那侧早就有）。
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Upstream ${method} ${url} failed: ${reason}`);
      res
        .status(503)
        .json({ code: ErrCode.UPSTREAM_UNAVAILABLE, message: 'Upstream service unavailable', data: null });
      return;
    }

    // ③ T5 修复（规格 §2.11「网关透传」条，v1.1.4）：CSV 响应**原样透传** —— 本函数此前
    // 固定 `resp.json()`，不分支则 CSV 经网关变 `application/json` 的 `null` 体
    // （Content-Type/Content-Disposition 一并丢失 ⇒ 导出/Excel 全挂）。
    //
    // 分支依据 = **上游 `Content-Type`**（`text/csv` 前缀），不是我们的路由名：下游的错误
    // 响应（如 ops.csv 的 400 借 10001「范围过大」）是 **JSON 信封** ⇒ 自然走下面的 JSON
    // 分支，不会被「`.csv` 路由一律当 CSV」吞形。JSON 路径语义逐字不变。
    //
    // ⚠️ **③ T6 联测修复（真栈实测，2026-10-05）**：体必须**按字节**读/写 —— 旧实现的
    // `resp.text()` 走 WHATWG UTF-8 decode，而该算法**剥掉首字节 BOM**（spec 的 decode
    // 步骤含「去掉前导 U+FEFF」）⇒ 导出 CSV 经网关丢掉 `EF BB BF`（Excel 中文识别面）。
    // `arrayBuffer()` 是字节保真读取；`res.send(Buffer)` 原样出站（BOM/CRLF/编码一字不动）。
    const upstreamContentType = resp.headers.get('content-type') ?? '';
    if (upstreamContentType.toLowerCase().startsWith('text/csv')) {
      const bytes = await resp.arrayBuffer().catch(() => null);
      if (bytes === null) {
        // 失败姿态与 JSON 分支的 `.catch(() => null)` **对齐**：读不到体 ⇒ 以 `null` 体回
        // 上游状态。依据：唯一保真的信号是状态码本身，这里不伪造 503/10007 —— 那会把
        // 「下游到底回了什么」这句话改掉（与上面 fetch 层 503 的边界逐字同族）。
        res.status(resp.status).json(null);
        return;
      }
      res.status(resp.status);
      // 逐字透传：`Content-Type` 取上游原样（本分支的进入条件已保证它以 `text/csv` 起头）；
      // `Content-Disposition` 有才写（§2.11 的 `attachment; filename=…` 由下游给出）。
      res.setHeader('Content-Type', upstreamContentType);
      const disposition = resp.headers.get('content-disposition');
      if (disposition) res.setHeader('Content-Disposition', disposition);
      res.send(Buffer.from(bytes));
      return;
    }

    const data = await resp.json().catch(() => null);
    res.status(resp.status).json(data);
  }
}
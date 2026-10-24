/**
 * socket.io 客户端封装：信封、ack、baseVersion、reqId、串行队列、入站校验。
 *
 * 权威依据：docs/design.md §6.2（消息信封）、§6.5（幂等与并发）、M01/M02/M05/M06/M08。
 *
 * 关键取舍（都是文档写死、不是实现自由）：
 *  - **没有 `seq`**：请求关联由 ack 回调承担，去重由 baseVersion 的 CAS 承担；
 *  - ack 通过 socket.io 的 ack 回调返回，**不是独立事件**；
 *  - 请求**串行**：一次只有一个在途请求；CAS 请求要等到 `state_update` 推进 version 才算完成（M06）；
 *  - 每条入站消息先过 `validateInbound`（开发期立刻发现服务端漂移）；
 *  - 断线时释放在途请求，避免 UI 永久 loading；重连（`connect` 的非首次触发）由本层
 *    自动 `emit('game.reconnect', { lastVersion })`（M03/M08，§6.6）；
 *  - **`13004` 的恢复走 `game.resync`**，与 `game.reconnect` 语义不同，不得互相冒充（§6.3/§6.5）。
 */
import {
  CAS_MESSAGES,
  CLIENT_ACTION,
  ClientAction,
  ErrCode,
  SNAPSHOT_MESSAGES,
  validateInbound,
  type ClientMessageType,
  type PlayerView,
  type ServerMessage,
  type ServerMessageType,
} from '@fight-the-landlord/protocol';
import {
  ACK_TIMEOUT_MS,
  DEFAULT_NAMESPACE,
  RECONNECT_DEBOUNCE_MS,
  RECONNECT_GIVE_UP_ATTEMPTS,
  SOCKET_PATH,
  buildSocketUrl,
  type SocketLike,
  type TransportOptions,
} from './transport';
import { resolveWsEndpoint } from './http';
import {
  classifyAck,
  isKnownCode,
  reportUnknownCode,
  type ClientActionExecutor,
  type ClientActionReport,
} from './errors';
import { connectionKickMessage } from './connection-copy';
import { rotateRefreshToken, type TokenRenewResult } from './token-refresh';

/** 发出且拿到 ack 的请求结果。 */
export interface SentResult {
  status: 'sent';
  type: ClientMessageType;
  reqId: string;
  baseVersion: number;
  /** 0 = 成功；-1 = ack 超时或断线，没有拿到服务端应答。 */
  code: number;
  /** code === -1 时区分原因：ack 超时（safetyTimer 到点）而非断线/无应答。 */
  ackTimedOut?: boolean;
  data?: unknown;
  action?: ClientAction;
}

/** 被串行队列（或死态 fail-fast）拦下的请求：**没有 emit 出去**。 */
export interface BlockedResult {
  status: 'blocked';
  type: ClientMessageType;
  reqId: string;
  /**
   * 拦下这次请求的原因：
   *  - `RequestInFlightError`：串行队列被上一个在途请求占着（M06）；
   *  - `ConnectionDeadError`：链路已判死（give-up / 服务端踢线），fail-fast 不缓冲。
   */
  reason: RequestInFlightError | ConnectionDeadError;
}

export type RequestOutcome = SentResult | BlockedResult;

/** 会话已拆除（`destroy()`）后仍然尝试发请求。 */
export class ClientDestroyedError extends Error {
  constructor() {
    super('GameClient 已拆除：不得再发送请求（destroy() 之后所有 send() 都会拒绝）');
    this.name = 'ClientDestroyedError';
  }
}

export class RequestInFlightError extends Error {
  constructor(
    readonly kind: 'awaiting_ack' | 'awaiting_state_update',
    readonly pendingType: ClientMessageType,
  ) {
    super(
      kind === 'awaiting_ack'
        ? `上一个请求 ${pendingType} 尚未收到 ack，本次请求被串行队列拦下（M06）`
        : `上一个请求 ${pendingType} 已被接受，等待 game.state_update 推进 version 后才能继续（M06/§6.5）`,
    );
    this.name = 'RequestInFlightError';
  }
}

/**
 * 链路已判死（give-up / 服务端终止性踢线）时仍然尝试发请求（`send()` 的 fail-fast）。
 *
 * 死态下 socket.io 缓冲**永远不会被冲刷**（重连链已停），把请求交给缓冲只会让它悬在
 * `pending` 里把串行队列永久占死——因此 `send()` 立即结算为 `blocked`、不 emit。
 * `message` 面向用户（与 `ConnectionOverlay` 遮罩 / `NoticeStack` 顶部提示的「重新连接」入口配套）。
 *
 * ⚠️ 覆盖全部死因：`give_up` 与 `server_rejected`（11003/10006/无码）都会走到本类。
 * 是否给「重新连接」按钮是 **UI 策略**（遮罩/横条的 `canRetry`），网络层不按码分叉
 * ——保持「哑网络层只报事实」（同 `retryConnect()` 的注释纪律）。
 */
export class ConnectionDeadError extends Error {
  constructor() {
    super('连接已断开：请点击重新连接');
    this.name = 'ConnectionDeadError';
  }
}

/**
 * 需要重新同步的原因。
 *
 * - `version_rollback`：M08 的主动重连（快照类消息 version 回退 → 主动重连，不本地修复）
 * - `socket_reconnect`：socket.io 链路重建**且快照已取回**；可以安全地回牌桌（见 `handleSocketReconnect`）
 * - `snapshot_unavailable`：链路重建了但没取回快照（两次 blocked / ack 超时 / 无应答）→ 只给提示
 * - `server_rejected`：服务端**主动踢线**（`io server disconnect`，§5.4 的并发连接上限就是这条通道）
 *   ⇒ **终止性**信号：不再自动恢复，只给明确文案（N15/R166）
 * - `action_reconnect` / `back_to_lobby`：CLIENT_ACTION 表的处置分支。
 *   ⚠️ 当前表里**没有任何错误码**映射到 `RECONNECT`（§6.5 刻意如此），
 *   这两个分支只是为了让表的变更不会静默失效。
 */
export interface ReconnectReason {
  kind:
    | 'version_rollback'
    | 'socket_reconnect'
    | 'snapshot_unavailable'
    | 'server_rejected'
    | 'action_reconnect'
    | 'back_to_lobby';
  version: number;
  message: string;
  /**
   * `CLIENT_ACTION` 处置分支携带的错误码（如 `back_to_lobby` 的 13010/13005）——
   * 供会话层把处置提示标成 `source: 'action'`（可被 `clearNotice()` 清掉）。
   */
  code?: number;
}

/**
 * 项 2：面向 UI 的连接相位。
 *  - `connected`：链路通；
 *  - `reconnecting`：从未连通 / 链路断了，socket.io 自动重连进行中（含尝试次数）；
 *  - `dead`：自动重连已放弃，或被服务端终止性踢线——只能靠用户动作恢复。
 */
export type ConnectionPhase = 'connected' | 'reconnecting' | 'dead';

export type ConnectionDeadReason = 'give_up' | 'server_rejected' | 'session_expired';

export interface ConnectionState {
  phase: ConnectionPhase;
  /** `dead` 时的死因；其余相位为 `null`。 */
  deadReason: ConnectionDeadReason | null;
  /** `server_rejected` 时服务端给的码（11003 封禁 / 10006 并发上限），UI 据此决定是否给重试。 */
  deadCode: number | null;
  /** 本轮自动重连已进行的尝试次数（`connected` 时归零；UI 显示「第 N 次重连」）。 */
  attempt: number;
}

/**
 * 快照 ack 的来源。两者共用同一套 §6.2 快照类 version 规则，但**语义不同**：
 * - `resync_ack`：`game.resync` 的 ack —— §6.5 对 `13004`/`13007`/`13009` 的唯一恢复通道
 * - `reconnect_ack`：`game.reconnect` 的 ack —— 只用于 socket 断线恢复（M03/M08）
 */
export type SnapshotSource = 'resync_ack' | 'reconnect_ack';

/**
 * 快照 ack 的处置结果（与 store 的 SnapshotOutcome 同构，多两个「没拿到」的情形）。
 * `timeout` 与 `unavailable` 分开，是因为两者的用户提示与重试策略不同。
 */
export type SnapshotAckStatus =
  | 'applied'
  | 'discarded'
  | 'rollback'
  /** 没取到快照：重试用尽仍被串行队列挡住，或 ack 超时。 */
  | 'unavailable'
  /** ack 超时（与 `unavailable` 分开，便于区分「丢包」与「队列被占」）。 */
  | 'timeout'
  /**
   * 服务端给了**确定答复**（非 0 错误码），但不是快照。
   * 处置已经由 `CLIENT_ACTION` 表完成，**不得**再报 `snapshot_unavailable`。
   */
  | 'answered_with_error';

export interface SnapshotAckResult {
  status: SnapshotAckStatus;
  version: number;
}

export interface GameClientOptions extends TransportOptions {
  /** 客户端最近一次**已应用**的 version。CAS 请求的 baseVersion 初值从这里取（§6.5）。 */
  currentVersion: () => number;
  /** 注入当前时间，便于测试。 */
  now?: () => number;
  /** 入站校验失败时的回调（默认抛错，开发期立刻暴露服务端漂移）。 */
  onProtocolError?: (error: Error, raw: unknown) => void;
  /**
   * **连不上**时的链路事实信号（N30①/R455）。
   *
   * 旧实现把 `connect_error` 只折成内部码 `-1`，用户在大厅看到的是「匹配失败（code=-1）」——
   * 看不出**是连不上**。这里只把**已有的信号**（socket.io 的 `connect_error`）交出去，
   * 文案与呈现由消费方决定（会话层经它**唯一**的 notice 通道写给页面）。
   *
   * ⚠️ **每个断线周期只回调一次**（链路恢复后重置）：socket.io 自动重连会反复抛
   * `connect_error`，每次都报会把提示刷成刷屏。去重复用 `hasConnected` 的周期语义，
   * **不引入定时器**。
   */
  onConnectUnavailable?: () => void;
  /** 链路已恢复（**只在此前回调过 `onConnectUnavailable` 之后**回调一次），用于撤下上面那条提示。 */
  onConnectAvailable?: () => void;
  /**
   * 令牌静默旋转后调用（由 session.ts 的装配层注入 `auth.syncTokensFromStorage()`）。
   * net 层不 import store；回填走回调注入，与 `onConnectUnavailable` 同模式。
   */
  onTokensRenewed?: () => void;
}

export type ServerMessageHandler = (msg: ServerMessage) => void;

export interface AckInput {
  reqId?: string;
  type?: ClientMessageType;
  code: number;
  message?: string;
  data?: unknown;
}

interface PendingRequest {
  reqId: string;
  type: ClientMessageType;
  baseVersion: number;
  /** CAS 请求：ack 成功后还要等到 version 超过 baseVersion 才算完成（M06）。 */
  awaitingStateVersion: number | null;
  safetyTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  /**
   * safetyTimer 到点仍未结算。注意它有两种成因，必须区分（见 `ackReceived`）：
   *  - ack 从未到达（真丢包）；
   *  - ack 到了，但 CAS 请求一直在等 `state_update`（服务端接受了动作却没推进状态）。
   */
  ackTimedOut: boolean;
  /** ack 回调是否已经触发过（与 `ackTimedOut` 组合才能判断「ack 丢失」）。 */
  ackReceived: boolean;
  settle: (outcome: SentResult) => void;
}

/**
 * `whenIdle` 的等待者。不变量：`resolve` 恰好被调用一次——
 * 由 `flushIdleWaiters`（队列空掉）或 `clearIdleWaiters`（会话拆除）。
 */
interface IdleWaiter {
  /** 已结算（被唤醒或取消）。 */
  settled: boolean;
  resolve: () => void;
}

/** M05：本地操作日志（审计用）。只增不删，上限内滚动。 */
export interface ActionLogEntry {
  reqId: string;
  type: ClientMessageType;
  baseVersion: number;
  timestamp: number;
}

const MAX_ACTION_LOG = 200;

/**
 * 组装 C→S 请求信封（§6.2）。导出是为了能对信封本身做断言。
 * `baseVersion` 只有 CAS 消息需要真实值，其余一律 0（§6.5 适用范围表）。
 *
 * 权威形状（§6.2 逐字）——**只有这四个顶层字段**：
 * ```ts
 * socket.emit(type, { reqId, baseVersion, timestamp, payload }, ack)
 * ```
 *
 * ⚠️ **线格式里没有 `type` / `meta`**：`type` 由 socket.io 的事件名承载，
 * 请求体不重复它；§6.2 明确要求「扁平，不嵌套 `meta`」。
 * 早期实现曾额外发这两个字段来迁就 mock 的入站解包，后来核实那是**过时的说法**：
 * `tools/mock-server/src/index.ts` 正确调用了 `validateClientMessage(type, body)`
 * （扁平线格式），mock 并不需要它们。保留它们只会让客户端在真实服务端上多一份漂移风险。
 */
export interface ClientRequestEnvelope {
  reqId: string;
  baseVersion: number;
  timestamp: number;
  payload: unknown;
}

export function buildRequestPayload(
  type: ClientMessageType,
  payload: unknown,
  baseVersion: number,
): ClientRequestEnvelope {
  return {
    reqId: createReqId(),
    baseVersion: isCasMessage(type) ? baseVersion : 0,
    timestamp: Date.now(),
    payload,
  };
}

export function isCasMessage(type: ClientMessageType): boolean {
  return (CAS_MESSAGES as readonly string[]).includes(type);
}

/**
 * 快照类**请求**（注意与 `SNAPSHOT_MESSAGES` 区分：后者是 S→C 消息）。
 * 它们的 ack 携带裁剪快照，不以 version 推进为完成条件，且 ack 丢失会把队列永久占死。
 */
export function isSnapshotRequest(type: ClientMessageType): boolean {
  return type === 'game.resync' || type === 'game.reconnect';
}

function isSnapshotMessage(type: ServerMessageType): boolean {
  return (SNAPSHOT_MESSAGES as readonly string[]).includes(type);
}

/** reqId 仅用于日志追踪，**不参与任何判定**（§6.2）。 */
function createReqId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 读取 socket.io 的 ack 参数。
 *
 * ⚠️ 这里踩过一个真实的坑，写下来以免重犯：
 * socket.io 4 **不带 `.timeout()` 时，ack 回调只有 1 个参数，且它就是服务端回执本身**
 * （`(res) => ...`），**不是** node 风格的 `(err, res)`。
 * 只有 `socket.timeout(ms).emit(...)` 才会把超时错误作为第一个参数（`(err, res)`）。
 * 早期实现按 `(err, res)` 解包，于是每个正常回执都被当成「失败」，`code` 恒为 `-1`。
 *
 * 判定方式：第一个参数若是带数字 `code` 的对象 → 它就是回执；
 * 若是 Error（`.timeout()` 的超时错误）或 undefined → 视为没有拿到回执（`code: -1`）。
 */
export function readAckArgs(args: unknown[]): { code: number; message?: string; data?: unknown } {
  const [first] = args;
  if (first instanceof Error) return { code: -1 };
  if (typeof first === 'object' && first !== null && typeof (first as { code?: unknown }).code === 'number') {
    const res = first as { code: number; message?: string; data?: unknown };
    return res;
  }
  // 兼容 node 风格 (err, res) 的注入实现
  const [, second] = args;
  if (typeof second === 'object' && second !== null && typeof (second as { code?: unknown }).code === 'number') {
    return second as { code: number; message?: string; data?: unknown };
  }
  return { code: -1 };
}

export class GameClient {
  private socket: SocketLike;
  private readonly messageHandlers = new Map<ServerMessageType, ServerMessageHandler[]>();
  private readonly actionHandlers: ClientActionExecutor[] = [];
  private readonly reconnectHandlers: ((reason: ReconnectReason) => void)[] = [];
  private readonly errorHandlers: ((msg: ServerMessage & { type: 'system.error' }) => void)[] = [];
  private readonly snapshotHandlers: ((view: PlayerView, source: SnapshotSource) => void)[] = [];
  private readonly snapshotOutcomeHandlers: ((
    result: SnapshotAckResult,
    source: SnapshotSource,
  ) => void)[] = [];
  private pending: PendingRequest | null = null;
  /** 等待串行队列空闲的等待者（见 `whenIdle`）。 */
  private idleWaiters: IdleWaiter[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 去抖窗口内被抑制、待补发的重连原因（见 `emitReconnect`）。 */
  private pendingReconnectReason: ReconnectReason | null = null;
  /** 防止一次断线触发多次 `game.reconnect`（重连风暴）。 */
  private reconnectInFlight = false;
  private destroyed = false;
  /** 服务端推送过的最新 version（无论是否应用）——用于判断 CAS 是否已完成。 */
  private lastSeenVersion = -1;
  private hasConnected = false;
  /**
   * 本次断线周期是否已经提示过「连接不可用」（N30①/R455）。
   *
   * 与 `hasConnected` 同一族**电平状态**（不是定时器）：`connect` 时复位，
   * 因此「断线 → 复连 → 再断线」会重新提示一次，而同一周期内的反复 `connect_error`
   * 只提示一次。
   */
  private connectErrorNotified = false;
  /** 最近一条 `system.error` 的码；只用来决定「被踢线」的文案（R166）。 */
  private lastServerErrorCode: number | null = null;
  /**
   * 服务端**主动断开**过本连接（`io server disconnect`）⇒ 终止本会话的自动恢复。
   *
   * 这是 N15 的前端半边：socket.io 客户端本身对被服务端踢下线**不会**自动重连，
   * 但我们的 `game.reconnect` 恢复流程仍会被后续的 `connect` 事件触发 —— 那会进入
   * 「连上即被踢」的循环。置位后 `handleSocketReconnect()` 直接早退。
   * 恢复路径是**用户动作**（关闭其它窗口后重新进入 / 刷新页面），不是自动重试。
   */
  private serverRejected = false;

  /**
   * 项 2：面向 UI 的连接相位（初值 `reconnecting`——会话刚创建时链路尚未连通，
   * 首次 `connect` 事件会把它拨到 `connected`）。
   */
  private connection: ConnectionState = {
    phase: 'reconnecting',
    deadReason: null,
    deadCode: null,
    attempt: 0,
  };
  private readonly connectionHandlers: ((state: ConnectionState) => void)[] = [];
  /** Manager `reconnect_attempt` 处理器引用（destroy 时成对 off）。 */
  private managerReconnectAttemptHandler: ((...args: unknown[]) => void) | null = null;
  /**
   * 即将由本类**主动**断开以终止重连（give-up）。
   * 置位期间到达的 `disconnect('io client disconnect')` 不得把相位改回 `reconnecting`。
   */
  private giveUpRequested = false;

  /**
   * 静默续期的一次性恢复配额。
   *
   * 语义：在「rotated 成功之后仍未收到成功 connect（`!serverRejected` 分支）」之前，
   * 再次被 10004 拒绝 → 配额耗尽，进 `session_expired` 终态。
   * **unavailable 不消耗配额**（网络不可用时允许引擎退避重试，22 次 give-up 既有兜底）。
   * 在 `connect` 事件的 `!serverRejected` 分支内重置为 `false`。
   */
  private silentRenewConsumed = false;
  /** 静默续期是否正在进行中（防重入）。 */
  private silentRenewInFlight = false;

  /**
   * 最近一次 fire-and-forget 的 attemptSilentRenewal Promise（测试用，暴露 await 接缝）。
   * 生产代码完全不消费它——handleSocketDisconnect 是同步的，attemptSilentRenewal 是 async，
   * 用例需要知道它什么时候跑完才能断言 ConnectionState 已更新。
   */
  pendingSilentRenewal: Promise<void> | null = null;
  /**
   * 最近一次**应用层活动**的时间戳（ms，单调递增）。
   *
   * 活动 = 任何 C→S emit 或 S→C 应用帧（非 engine.io ping/pong）。
   * 用途：composables/useIdleWatch 在「非对局状态 + 空闲超时」时主动断开连接，
   * 节省手机侧电量与服务端连接占用。
   *
   * ⚠️ 默认值 0：GameClient 刚创建时还没收发过任何帧，composable 据此识别
   * 「会话刚创建，还没稳定」而跳过空闲判定。
   */
  private lastActivityAt = 0;

  readonly actionLog: ActionLogEntry[] = [];

  constructor(private readonly options: GameClientOptions) {
    const factory = options.socketFactory;
    if (!factory) {
      throw new Error('未注入 socketFactory：GameClient 不自己 import socket.io-client（见 transport.ts）');
    }
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    /**
     * ⚠️ 端点解析**必须**走 `http.ts#resolveWsEndpoint`（而不是直接 `transport#resolveEndpoint`）：
     * 前者含 R550 的小程序端校验（`VITE_WS_ENDPOINT` 为空 ⇒ 抛错，不回退到硬编码 localhost）。
     */
    const url = buildSocketUrl(resolveWsEndpoint(options.endpoint), namespace);
    this.socket = factory(url, {
      path: SOCKET_PATH,
      auth: options.auth,
      transports: ['websocket'],
    });
    this.attachSocket();
  }

  /** 建立连接（socket.io 会自动重连，这里只负责 lifecycle 语义）。 */
  connect(): void {
    this.socket.connect();
  }

  /**
   * 主动断开底层 socket（不销毁会话，重连链由 socket.io 接管）。
   *
   * 与 `destroy()` 的区别：`destroy()` 会清空所有事件订阅 + 销毁 socket，是彻底结束；
   * 本方法只断开连接（等同 `socket.disconnect()`），让 socket.io 走自动重连。
   *
   * 用途：`useIdleWatch` 在「非对局 + 25min 空闲」时调用——断开后引擎层链路归零，
   * socket.io 自动重连，重连成功触发 `connect` 事件（其中 `touchActivity()` 重置计时）。
   */
  disconnect(): void {
    this.socket.disconnect();
  }

  /**
   * 底层链路当前是否连通（透传 socket.io 的 `connected`）。
   * 项 1：回前台主动 resync 前先判它——断链期间 socket.io 自动重连成功后已有
   * `game.reconnect` 补快照，未连通时发请求只会进缓冲并撞重连后的串行队列。
   */
  get connected(): boolean {
    return this.socket.connected;
  }

  /**
   * 最近一次应用层活动的时间戳（ms）。零值 = 会话刚创建还没收发过任何帧。
   * 用途：composables/useIdleWatch 据此判定「非对局状态 + 空闲超时」主动断连。
   */
  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /**
   * 当前连接相位的**只读快照**（项 2）。返回浅副本，外部改不到内部状态。
   */
  get connectionState(): ConnectionState {
    return { ...this.connection };
  }

  /**
   * 订阅连接相位变化（项 2）。**不**立即推当前值——订阅者创建时可先读
   * `connectionState` 拿初值。返回注销函数。
   */
  onConnectionState(handler: (state: ConnectionState) => void): () => void {
    this.connectionHandlers.push(handler);
    return () => {
      const i = this.connectionHandlers.indexOf(handler);
      if (i >= 0) this.connectionHandlers.splice(i, 1);
    };
  }

  /**
   * 项 2：终态后的**手动**重试（用户点遮罩 / 死态横条上的「重新连接」）。
   *
   * 复位两个终止位（give-up 与 server_rejected——`10006` 并发上限允许用户关闭其它
   * 窗口/设备后手动再试），重新交给 socket.io 建链；建链成功后的快照恢复仍由既有的
   * `connect`（非首次）→ `game.reconnect` 自动承担。
   *
   * ⚠️ `11003` 封禁**不允许**重试，但那是 UI 策略（遮罩不放入口），网络层不在这里
   * 按码分叉——保持「哑网络层只报事实」。
   */
  retryConnect(): void {
    if (this.destroyed) return;
    this.serverRejected = false;
    this.giveUpRequested = false;
    this.updateConnection({ phase: 'reconnecting', deadReason: null, deadCode: null, attempt: 0 });
    this.socket.connect();
  }

  /** 幂等订阅某类 S→C 推送。 */
  on(type: ServerMessageType, handler: ServerMessageHandler): () => void {
    const list = this.messageHandlers.get(type) ?? [];
    list.push(handler);
    this.messageHandlers.set(type, list);
    return () => {
      const current = this.messageHandlers.get(type) ?? [];
      this.messageHandlers.set(
        type,
        current.filter((h) => h !== handler),
      );
    };
  }

  /** 订阅错误码处置（§11 的 CLIENT_ACTION 执行器）。 */
  onAction(executor: ClientActionExecutor): () => void {
    this.actionHandlers.push(executor);
    return () => {
      const i = this.actionHandlers.indexOf(executor);
      if (i >= 0) this.actionHandlers.splice(i, 1);
    };
  }

  /** 订阅「需要主动重连」的信号（M08：快照类 version 回退）。 */
  onReconnect(handler: (reason: ReconnectReason) => void): () => void {
    this.reconnectHandlers.push(handler);
    return () => {
      const i = this.reconnectHandlers.indexOf(handler);
      if (i >= 0) this.reconnectHandlers.splice(i, 1);
    };
  }

  /**
   * 订阅快照类 ack 携带的裁剪快照。
   *
   * 契约里 ack 的 `data` 就是快照（§6.6），它不是一条 S→C 消息，
   * 因此不能混进按 type 分发的订阅表；但仍然必须走 §6.2 的快照丢弃规则。
   * 注意：version 判定在 `applySnapshotAck` 里已经做过，订阅者拿到的必然是「更新」的快照。
   */
  onSnapshot(handler: (view: PlayerView, source: SnapshotSource) => void): () => void {
    this.snapshotHandlers.push(handler);
    return () => {
      const i = this.snapshotHandlers.indexOf(handler);
      if (i >= 0) this.snapshotHandlers.splice(i, 1);
    };
  }

  /**
   * 订阅快照类 ack 的**处置结果**（`applied` / `discarded` / `rollback`）。
   *
   * 「丢弃」也必须在 UI 侧留痕：§6.2 规定 `version === currentVersion` 时丢弃，
   * 那时订阅者拿不到快照，但仍需要一个可观测的结果（否则无法断言丢弃规则真的生效）。
   */
  onSnapshotOutcome(handler: (result: SnapshotAckResult, source: SnapshotSource) => void): () => void {
    this.snapshotOutcomeHandlers.push(handler);
    return () => {
      const i = this.snapshotOutcomeHandlers.indexOf(handler);
      if (i >= 0) this.snapshotOutcomeHandlers.splice(i, 1);
    };
  }

  onSystemError(handler: (msg: ServerMessage & { type: 'system.error' }) => void): () => void {
    this.errorHandlers.push(handler);
    return () => {
      const i = this.errorHandlers.indexOf(handler);
      if (i >= 0) this.errorHandlers.splice(i, 1);
    };
  }

  /** 当前是否有一个请求占着串行队列（M06）。 */
  get busy(): boolean {
    return this.pending !== null;
  }

  /** 是否有一次 socket 重连恢复正在进行中（用于断言它不会永久卡住）。 */
  get reconnectPending(): boolean {
    return this.reconnectInFlight;
  }

  get currentVersion(): number {
    return this.options.currentVersion();
  }

  /** 发起一个 C→S 请求。
   *
   * **不抛异常**：被串行队列拦下时返回 `{ status: 'blocked' }`，由调用方决定怎么提示。
   * 这样「点了按钮但队列在忙」永远不会变成未捕获的 Promise rejection。
   */
  send(type: ClientMessageType, payload: unknown = {}): Promise<RequestOutcome> {
    this.touchActivity();
    if (this.destroyed) {
      /**
       * 会话已拆除：**明确拒绝**，不 emit、也不伪装成「稍后重试」。
       * 返回 `blocked` 会让调用方（例如重试循环）继续等待一个永远不会到来的空档。
       */
      return Promise.reject(new ClientDestroyedError());
    }
    /**
     * 死态 fail-fast：give-up（`giveUpRequested`）或相位 `dead` 且**链路未连通**时，
     * 立即返回 `blocked`（`ConnectionDeadError`），**不**把请求交给 socket.io 缓冲。
     *
     * 为什么必须（存量缺陷）：死态下重连链已停、缓冲**永远不会被冲刷**（`socket.disconnect()`
     * → Manager `_close()` 置 `skipReconnect`），若照旧 emit + 占 `pending`，该请求既不
     * 可能收到 ack、也没有安全计时器（非 CAS/快照类），串行队列从此永久占死、
     * `sendQueued` 的等待者无界空转。
     *
     * ⚠️ `giveUpRequested` 与相位判断并列（不能只判 `phase === 'dead'`）——**防御性**：
     * `whenIdle` 的等待者是**同步回调**（`flushIdleWaiters` 直接调 `onIdle`，其中立刻
     * `send()`）。当前两条死因路径都已用「先判死、再释放」的顺序覆盖（`giveUpReconnect`
     * 与 `handleSocketDisconnect`），但一旦将来有路径能在「已决定 give-up、相位尚未翻
     * `dead`」的同步窗口里释放等待者，只有本标志拦得住（`giveUpReconnect()` 里
     * `socket.disconnect()` 在「恰好仍连着」的边角会同步派发 `disconnect`；常规路径
     * socket 未连接、不派发，见 `giveUpReconnect()` 的停链机制勘误注释）。
     * ⚠️ `reconnecting` 相位（普通自动重连进行中）**不** fail-fast——请求照旧进
     * socket.io 缓冲，重连成功即冲刷（既有语义，负对照钉在 `connection-dead.test.ts`）。
     */
    if (!this.socket.connected && (this.giveUpRequested || this.connection.phase === 'dead')) {
      return Promise.resolve({
        status: 'blocked',
        type,
        reqId: generateId(),
        reason: new ConnectionDeadError(),
      });
    }
    if (this.pending) {
      return Promise.resolve({
        status: 'blocked',
        type,
        reqId: generateId(),
        reason: new RequestInFlightError(
          this.pending.awaitingStateVersion !== null ? 'awaiting_state_update' : 'awaiting_ack',
          this.pending.type,
        ),
      });
    }

    const env = buildRequestPayload(type, payload, this.currentVersion);
    const reqId = env.reqId;
    this.actionLog.push({ reqId, type, baseVersion: env.baseVersion, timestamp: env.timestamp });
    // env 的顶层字段就是 §6.2 的线格式；`type` 只出现在 socket.io 的事件名上。
    if (this.actionLog.length > MAX_ACTION_LOG) this.actionLog.shift();

    // 只有「已经应用过某个快照」之后才存在需要等待推进的版本（§6.5 的 baseVersion 初值来自 game.deal）。
    const waitingFor =
      isCasMessage(type) && this.currentVersion > 0 ? this.currentVersion : null;

    let settle!: (outcome: SentResult) => void;
    const done = new Promise<SentResult>((resolve) => {
      settle = resolve;
    });

    const request: PendingRequest = {
      reqId,
      type,
      baseVersion: env.baseVersion,
      awaitingStateVersion: waitingFor,
      safetyTimer: null,
      settled: false,
      ackTimedOut: false,
      ackReceived: false,
      settle,
    };
    this.pending = request;

    if (waitingFor !== null || isSnapshotRequest(type)) {
      /**
       * ack 超时兜底（M06）：不能让 `pending` 被永久占用。
       *
       * - **CAS 动作**：服务端可能接受了动作却始终不发 `state_update`；
       * - **快照类请求**（`game.reconnect`/`game.resync`）：ack 一旦丢失，
       *   `pending` 会被永久占用，`reconnectInFlight` 也随之永久为真 → 自动重连彻底停摆。
       */
      request.safetyTimer = setTimeout(() => {
        if (this.pending === request) {
          request.ackTimedOut = true;
          this.releasePendingAndWakeWaiters();
        }
      }, ACK_TIMEOUT_MS);
    }

    this.socket.emit(type, env, (...ackArgs: unknown[]) => {
      const ack = readAckArgs(ackArgs);
      const code = ack.code;
      /**
       * **顺序是契约的一部分**：先结算并释放串行队列，再分派错误码处置。
       *
       * CLIENT_ACTION 的 `REFRESH_SNAPSHOT` 处置会**同步**发起 `game.resync`（§6.5）。
       * 若此时被拒的那个请求还占着串行队列（`this.pending`），恢复动作会被
       * `RequestInFlightError` 自己挡掉。`finishRequest` 内部就在这个顺序上释放。
       */
      request.ackReceived = true;
      /** 顺序见 `dispatchAck`（释放槽位 → 同步派发 `CLIENT_ACTION` → 才唤醒重试）。 */
      this.dispatchAck(
        request,
        {
          status: 'sent',
          type,
          reqId,
          baseVersion: env.baseVersion,
          code,
          data: ack.data,
          action: classifyAck({ code, message: ack.message }).action,
        },
        ack.message,
      );
    });

    return done;
  }

  /**
   * 等待串行队列空闲后发送 —— 用于**服务端主动推进之后**的自动跟进请求
   * （既有调用点 `room.matched` → `room.join`（R50）；另有 `table.vue` 的 `room.leave`——
   * 为避发送层安全时钟缺口而经本方法等待空闲）。
   *
   * 与 `send()` 的唯一区别：撞上在途请求时**不把 `blocked` 直接甩给调用方**，
   * 而是走 `whenIdle` 的电平触发等待，直到拿到一个非 `blocked` 的结果或尝试次数用尽。
   *
   * **每一次 `send()` 调用都消耗一次尝试配额**（包括「被 `CLIENT_ACTION` 的恢复请求抢先」
   * 这种没抢到槽位的情形）—— 因此本方法**全局有界**，不会出现等待者被反复抢先而无限等待。
   * `CLIENT_ACTION` 强制的恢复请求（`13004` → `game.resync`）永远优先：它在 ack 回调里
   * **同步**拿槽位，我们的等待者只在下一个真正空闲时才被唤醒。
   *
   * 会话已拆除时**reject**（与 `send()` 同语义）——调用方据此识别「用户已登出」。**不轮询**。
   */
  async sendQueued(
    type: ClientMessageType,
    payload: unknown = {},
    maxAttempts = 5,
  ): Promise<RequestOutcome> {
    let attempts = 0;
    const sendOnce = (): Promise<RequestOutcome> => {
      attempts += 1;
      return this.send(type, payload);
    };

    let outcome = await sendOnce();
    while (outcome.status === 'blocked' && attempts < maxAttempts) {
      outcome = await new Promise<RequestOutcome>((resolve, reject) => {
        this.whenIdle(() => {
          void sendOnce().then(resolve, reject);
        });
      });
    }
    return outcome;
  }

  /** 外部（例如共享 RPC 回执 / 服务端推送）直接报告一次错误码处置。 */
  reportErrorCode(
    code: number,
    message?: string,
    source: 'action' | 'system' = 'action',
  ): ClientActionReport[] {
    return this.notifyAction(code, message, source);
  }

  /**
   * 供测试/适配层直接结算一次 ack。与 `send()` 的 ack 路径**同序**（见 `dispatchAck`）：
   * 先结算/释放，再派发 `CLIENT_ACTION`（非 0 时；快照类请求自身的 REFRESH_SNAPSHOT
   * 失败被自激守卫豁免，见 `isSelfExcitedRefresh`），最后唤醒等待者。
   */
  handleAck(input: AckInput): void {
    const pending = this.pending;
    const matched = pending !== null && (!input.reqId || input.reqId === pending.reqId);
    const result = {
      status: 'sent',
      type: pending?.type ?? ('room.match' as ClientMessageType),
      reqId: pending?.reqId ?? generateId(),
      baseVersion: pending?.baseVersion ?? 0,
      code: input.code,
      data: input.data,
      action: classifyAck({ code: input.code, message: input.message }).action,
    } as const;
    if (matched) {
      this.dispatchAck(pending, result, input.message);
      return;
    }
    // 没有匹配的在途请求：错误码处置仍然必须派发（不得因「没匹配」而静默吞掉）；
    // 只有「type 已知且是快照类请求自身」才被自激守卫拦下（type 未知时照常派发，残余 ≤1 且自终止）。
    if (input.code !== 0 && !this.isSelfExcitedRefresh(input.type, input.code)) {
      this.notifyAction(input.code, input.message);
    }
    this.flushIdleWaiters();
  }

  /**
   * 处理一条 S→C 消息。
   *
   * 顺序是契约的一部分（§6.2）：
   *   1. `validateInbound`（不符即抛错/回调，不进业务逻辑）；
   *   2. 快照类：version 判定 → 先在本地记录「已见到该 version」，从而释放 CAS 队列；
   *   3. 再分发给业务订阅者（快照先应用、事件后处理）。
   */
  handleServerMessage(type: ServerMessageType, raw: unknown): ServerMessage {
    this.touchActivity();
    let msg: ServerMessage;
    try {
      msg = validateInbound(type, raw);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.options.onProtocolError) this.options.onProtocolError(err, raw);
      else throw err;
      throw err;
    }

    /**
     * R166：记下最近一条错误码 —— 它只用于解释**紧接着**的那次断开（`io server disconnect`）。
     * 终止恢复的依据始终是 disconnect 的 reason，**不是**错误码：HTTP 维度的限流
     * 同样是 `10006`（§5.4 的单用户 20 次/5 秒），那时链路是好的、必须继续自动重连。
     */
    if (msg.type === 'system.error') {
      this.lastServerErrorCode = (msg.payload as { code: number }).code;
    }

    if (typeof msg.version === 'number') {
      if (msg.version > this.lastSeenVersion) this.lastSeenVersion = msg.version;
      const pending = this.pending;
      if (
        pending &&
        pending.awaitingStateVersion !== null &&
        settled(pending) &&
        msg.version > pending.awaitingStateVersion
      ) {
        // ack 已确认且同一次状态转移把 version 推进了 → M06 的操作完成
        this.releasePendingAndWakeWaiters();
      }
    }

    for (const handler of this.messageHandlers.get(msg.type) ?? []) handler(msg);
    if (msg.type === 'system.error') {
      for (const handler of this.errorHandlers) handler(msg);
    }
    return msg;
  }

  /** M02 消息类别判定：供 store 决定是否按 version 丢弃。 */
  static classify(type: ServerMessageType): 'snapshot' | 'event' | 'room' {
    if (isSnapshotMessage(type)) return 'snapshot';
    return type.startsWith('room.') ? 'room' : 'event';
  }

  /**
   * **两条路径语义不同，不得互相冒充**（§6.3 / §6.5 / §6.6）。
   *
   * `resync()` → `game.resync {}`，**只**用于 §6.5 的就地刷新：
   *   「`13004` 的统一处置（只有一种）：丢弃本地未确认的乐观状态 → 调用 `game.resync`
   *     重新拉取当前裁剪快照 → 由用户重新发起操作。」
   *   `CLIENT_ACTION` 表里 `REFRESH_SNAPSHOT` 的分支（`13004`/`13007`/`13009`）**只**走它。
   *   §6.5 逐字禁止用 `game.reconnect` 充当这一路径。
   *
   * `reconnect(lastVersion)` → `game.reconnect { lastVersion }`（M03），
   *   **只**用于 socket 断线恢复（与 `game.resync` 不同：它含服务端的记录查找）。
   *
   * 两者拿到 ack 后共用同一套「快照类」version 规则（§6.2 表第 1 行 / M02 / M08），
   * 见 `applySnapshotAck`。
   */
  async resync(): Promise<SnapshotAckResult> {
    // §6.5 适用范围表：game.resync 不参与 CAS → baseVersion 传 0
    return this.requestSnapshot('game.resync', {});
  }

  /**
   * socket 断线恢复专用（M03/M08）。`lastVersion` **不参与 CAS**（§6.5）。
   *
   * 带**有界重试**（2 次）：它是自动路径，撞上在途请求时没有「用户再点一次」的机会。
   * `resync()` 相反——它由用户操作触发，失败后用户可以重来，不需要替用户重试。
   */
  async reconnect(lastVersion: number): Promise<SnapshotAckResult> {
    return this.requestSnapshot('game.reconnect', { lastVersion }, 2);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearReconnectTimer();
    // 先取消（并结算）挂起的重试，再释放队列——否则等待者会在释放的那一刻再发一次请求。
    // 这里直接调 `releasePending`（不 flush）是安全的：等待者刚刚已被全部结算。
    this.clearIdleWaiters();
    this.releasePending();
    this.messageHandlers.clear();
    this.actionHandlers.length = 0;
    this.reconnectHandlers.length = 0;
    this.errorHandlers.length = 0;
    this.snapshotHandlers.length = 0;
    this.snapshotOutcomeHandlers.length = 0;
    this.connectionHandlers.length = 0;
    // 项 2：Manager 监听成对注销（与 attachSocket 里的 on 对应，防泄漏）。
    if (this.managerReconnectAttemptHandler) {
      this.socket.io?.off('reconnect_attempt', this.managerReconnectAttemptHandler);
      this.managerReconnectAttemptHandler = null;
    }
    this.socket.disconnect();
  }

  // ---------------------------------------------------------------- internals

  private attachSocket(): void {
    for (const type of messageTypeList()) {
      this.socket.on(type, (payload) => {
        if (this.destroyed) return;
        try {
          this.handleServerMessage(type, payload);
        } catch (error) {
          if (!this.options.onProtocolError) throw error;
        }
      });
    }
    this.socket.on('disconnect', (...args: unknown[]) => {
      this.handleSocketDisconnect(typeof args[0] === 'string' ? args[0] : undefined);
    });
    /**
     * 重连状态机（F2，§6.6 / M03 / M08）：
     *   socket `disconnect` → 释放在途请求（上面那条）
     *   socket `connect` 且**非首次** → `reconnect(store.currentVersion)`
     *   ack 成功 → 应用快照、恢复渲染（`mySeat`/`roomCode`/`hand` 从快照重建）
     *   `13010` / `13005` → 按 `CLIENT_ACTION` 处置（两者都是 `BACK_TO_LOBBY`），并给出提示
     *
     * `13010`/`13005` 的处置**不在本方法里分支**：`send()` 已经把非 0 的 ack 交给
     * `onAction` 的 CLIENT_ACTION 执行器（见 `notifyAction`）。这里只负责回收结果。
     */
    this.socket.on('connect', () => {
      this.touchActivity();
      const isReconnect = this.hasConnected;
      this.hasConnected = true;
      /**
       * 项 2：链路连通（首次或重连成功）⇒ 相位回 `connected`、尝试次数归零。
       * 放在所有早退之前：哪怕是被踢后又收到 connect（serverRejected 仍在），
       * 底层链路事实也是「物理上连上了」——但相位保持 dead，由下面的标志挡住，
       * 避免终态遮罩闪一下消失。
       */
      if (!this.serverRejected) {
        this.giveUpRequested = false;
        // ⚠️ 静默续期配额**不**在 connect 时重置：
        // 一次性语义 = 「本会话（从首次 silentRenew 到 destroyed）最多一次 rotated」。
        // 若 rotated 之后仍被 10004 拒，说明 refresh token 自身已失效（确定性循环），
        // 必须判死 session_expired。unavailable（网络/超时）不消耗配额，引擎退避可重试。
        this.updateConnection({
          phase: 'connected',
          deadReason: null,
          deadCode: null,
          attempt: 0,
        });
      }
      /**
       * N30①/R455：链路恢复 ⇒ 撤下「连接不可用」那条提示（否则它会留置成恒红）。
       * 只有**此前确实提示过**才回调：首次连接不该冒出「连接已恢复」。
       */
      if (this.connectErrorNotified) {
        this.connectErrorNotified = false;
        this.options.onConnectAvailable?.();
      }
      // 新连接作废上一条错误码：它只用于解释**紧接着**的那次断开（R166）。
      this.lastServerErrorCode = null;
      if (!isReconnect || this.destroyed) return;
      void this.handleSocketReconnect();
    });
    this.socket.on('connect_error', () => {
      this.releasePendingAndWakeWaiters();
      /**
       * N30①/R455：**连不上必须告诉用户**。旧实现到这里就结束了，用户只能看到
       * 「匹配失败（code=-1）」——那是内部码，不是链路事实。
       *
       * 每个断线周期只报一次（见 `connectErrorNotified`）：socket.io 会自动重连并
       * 反复抛 `connect_error`，逐次上报等于刷屏。
       */
      if (this.connectErrorNotified) return;
      this.connectErrorNotified = true;
      this.options.onConnectUnavailable?.();
    });

    /**
     * 项 2：数 Manager 的 `reconnect_attempt`（⚠️ 只在 `socket.io` 上，Socket 不转发，
     * 见 `transport.ts#SocketLike.io`）。
     *  - 每次尝试 ⇒ 相位 `reconnecting` + 尝试次数（UI 显示「第 N 次重连」）；
     *  - 达 `RECONNECT_GIVE_UP_ATTEMPTS` 次仍失败 ⇒ 主动断开、相位判死。
     */
    const manager = this.socket.io;
    if (manager) {
      this.managerReconnectAttemptHandler = (...args: unknown[]) => {
        const raw = args[0];
        const attempt =
          typeof raw === 'number' && Number.isFinite(raw)
            ? raw
            : this.connection.attempt + 1;
        if (this.connection.phase === 'dead') return;
        this.updateConnection({ phase: 'reconnecting', attempt });
        if (attempt >= RECONNECT_GIVE_UP_ATTEMPTS) this.giveUpReconnect();
      };
      manager.on('reconnect_attempt', this.managerReconnectAttemptHandler);
    }
  }

  /**
   * 项 2：自动重连达上限 ⇒ 主动停掉 socket.io 的无限重连并判死。
   *
   * ⚠️ **停链机制（socket.io-client 4.8.4 实查，勘误旧注释）**：give-up 时 socket 恰好处于
   * **未连接**态，`socket.disconnect()` 里派发 socket 级 `disconnect` 事件的
   * `onclose('io client disconnect')` 被 `if (this.connected)` 门住 ⇒ **不派发**
   *（`socket.js:674-686`）。真正停链的是它**无条件**执行的
   * `destroy() → Manager._destroy() → _close()`（`manager.js:331-337`：置
   * `skipReconnect = true`、`_reconnecting = false`），无限重连到此为止。
   * `giveUpRequested` 因此**不是**这条路径的必需品（旧注释把它说成防相位回退的依据，
   * 那是错误归因）；保留它是防「恰好仍连着」的边角形态：那种情况下 `disconnect()` 会派发
   * `disconnect('io client disconnect')`，标志位让 `handleSocketDisconnect` 不把相位改回
   * `reconnecting`（死态不闪回）。先置标志再 `disconnect()` 的顺序成本为零，保留。
   *
   * ⚠️ 最后**释放悬挂的 pending 并唤醒 `whenIdle` 的等待者**（give-up 转换点）：
   * 断链期（未判死前）发出的请求照旧进过缓冲并占着 `pending`（无安全计时器），
   * 不在此收口就会把串行队列永久占死。放在 `updateConnection(dead)` **之后**是有意的——
   * 被唤醒的重试立刻命中 `send()` 的 fail-fast（`ConnectionDeadError`），
   * `sendQueued` 在既有 5 次配额内收敛、不空转。
   */
  private giveUpReconnect(): void {
    if (this.connection.phase === 'dead') return;
    this.giveUpRequested = true;
    this.socket.disconnect();
    this.updateConnection({ phase: 'dead', deadReason: 'give_up', deadCode: null });
    this.releasePendingAndWakeWaiters();
  }

  /** 更新连接相位（无实际变化时不通知，避免无谓的响应式抖动）。 */
  private updateConnection(patch: Partial<ConnectionState>): void {
    const next: ConnectionState = { ...this.connection, ...patch };
    const cur = this.connection;
    if (
      next.phase === cur.phase &&
      next.deadReason === cur.deadReason &&
      next.deadCode === cur.deadCode &&
      next.attempt === cur.attempt
    ) {
      return;
    }
    this.connection = next;
    for (const handler of this.connectionHandlers) handler(next);
  }

  /**
   * 两条路径的公共实现：发请求 → ack 的 `data` 按「快照类」规则处置（§6.2 / M02 / M08）。
   *
   * `send()` 已负责：串行队列、ack 超时、非 0 错误码 → CLIENT_ACTION 执行器
   * （所以 `13010`/`13005` 的「回大厅」不需要在这里分支）。
   *
   * ⚠️ **撞上在途请求时必须有界重试**（修复轮 1 / I1）：串行队列会把这次快照请求判为
   * `blocked`，若就此返回 `unavailable`，重连会**静默消失**——没有重试、没有用户信号。
   * 生产可达：掉线期间的点击会在 socket.io 的缓冲里造出一个在途请求，`connect` 时它还在。
   *
   * 撞上在途请求时，等队列空闲后**有界重试**（`maxRetries` 次，不做轮询、不无限重试）。
   *
   * ⚠️ 重试**必须让出优先级**：ack 回调里 `CLIENT_ACTION` 会同步派发（`13004` → `game.resync`），
   * 那条由契约强制要求的请求优先拿槽位。重试走**电平触发**的 `whenIdle`——只要队列再次
   * 空下来（例如 `game.resync` 的 ack 释放时）就会被唤醒，因此不会因此被永久丢弃，
   * 也不会去抢 `resync` 的槽位。
   *
   * **返回值的语义必须分清**（否则正常的契约处置会被说成通信失败）：
   *  - 非 0 的 ack = 服务端给了**确定答复**，处置归 `CLIENT_ACTION` 表 → 不是 `unavailable`；
   *  - `unavailable` / `timeout` 只留给「压根没取到快照」：重试用尽仍 `blocked`、ack 超时。
   *  - 死态（`send()` fail-fast 的 `ConnectionDeadError`）同样按 `blocked` 有限步收口为
   *    `unavailable`——**不**无限重试（`send()` 的 fail-fast 路径不占串行队列，
   *    「等待下一次空闲」对它永远是立即满足，继续循环就是微任务自旋，见循环内注释）。
   */
  private async requestSnapshot(
    type: 'game.resync' | 'game.reconnect',
    payload: unknown,
    maxRetries = 0,
  ): Promise<SnapshotAckResult> {
    const unavailable = (): SnapshotAckResult => ({
      status: 'unavailable',
      version: this.currentVersion,
    });
    /** 拆除后 `send()` 会 reject；快照请求把它收敛成 `unavailable`，不向外抛。 */
    const attempt = (): Promise<RequestOutcome | null> =>
      this.send(type, payload).catch(() => null);

    let outcome = await attempt();
    if (!outcome) return unavailable();

    /**
     * 撞上在途请求 → 等「队列真的空下来」再试，**最多 `maxRetries` 次**。
     *
     * 每一轮都用 `whenIdle` 注册一个等待者；若这一轮还是被别人抢先（例如 `13004` 的
     * `game.resync` 刚拿走槽位），就**重新注册**再等下一次空闲——否则等待者被消费掉之后
     * 就再也没人叫醒我们了。预算按「实际抢到槽位的轮次」计，不做轮询、不无限重试。
     */
    while (outcome.status === 'blocked' && maxRetries > 0) {
      maxRetries -= 1;
      for (;;) {
        const next = await new Promise<RequestOutcome | null>((resolve) => {
          this.whenIdle(() => {
            void attempt().then(resolve);
          });
        });
        if (!next) return unavailable();
        outcome = next;
        /**
         * ⚠️ 「被抢先」必须限定为**串行队列占用**（`RequestInFlightError`）：那意味着
         * 下一次队列空下来还会把等待者唤醒 ⇒ 重新注册是对的。
         *
         * **死态 fail-fast 的 `blocked`（`ConnectionDeadError`）不在其列**：它根本不占
         * `pending`，`whenIdle` 会**立即**回调 ⇒ 若继续 `continue` 就是微任务无限自旋
         *（既不消耗预算、也不让出事件循环，测试超时都打不出来）。这类失败让内层循环
         * 立即退出、由外层 `while` 消耗剩余预算后按 `blocked` 收口为 `unavailable`。
         */
        if (
          outcome.status === 'blocked' &&
          outcome.reason instanceof RequestInFlightError &&
          maxRetries > 0
        ) {
          // 槽位又被别人拿走了：再等一次空档（不额外消耗预算）
          continue;
        }
        break;
      }
    }
    if (!outcome) return unavailable();
    // 重试用尽仍被占 / ack 超时：这两者才是「没能取到快照」，由上层给用户提示
    if (outcome.status === 'blocked') return { status: 'unavailable', version: this.currentVersion };
    if (outcome.ackTimedOut) return { status: 'timeout', version: this.currentVersion };
    /**
     * ⚠️ 非 0 的 ack **不是**「没取回快照」：服务端明确答复了，处置已经由 `CLIENT_ACTION`
     * 表承担（`13010` 记录不存在、`13005` 对局已结束 → 回大厅）。若在这里也返回
     * `unavailable`，上层会**额外**发一次 `snapshot_unavailable`，其文案会**覆盖**掉
     * 处置刚写好的 notice（处置在 ack 回调里同步写入，`unavailable` 落在更晚的续体里）。
     */
    if (outcome.code !== 0) return { status: 'answered_with_error', version: this.currentVersion };
    const view = outcome.data as PlayerView | undefined;
    if (!view || typeof view.version !== 'number') {
      return { status: 'unavailable', version: this.currentVersion };
    }
    return this.applySnapshotAck(view, type === 'game.resync' ? 'resync_ack' : 'reconnect_ack');
  }

  /**
   * 快照类 ack 的 version 判定（§6.2 表第 1 行 / M02 / M08）——两条路径共用：
   *   `=== 当前` → 丢弃（重复送达，本地状态不变）
   *   `< 当前`    → **回退信号**：按 M08 主动重连，不做本地修复
   *   `> 当前`    → 应用（交给订阅者，由 store 重建 `mySeat`/`roomCode`/`hand`）
   *
   * 三种结果都会通过 `onSnapshotOutcome` 播报——「丢弃」也是契约规定的一种处置，
   * 静默吞掉会让 UI 无法区分「已是最新」与「什么都没发生」。
   */
  private applySnapshotAck(view: PlayerView, source: SnapshotSource): SnapshotAckResult {
    const current = this.currentVersion;
    if (view.version === current) {
      const discarded: SnapshotAckResult = { status: 'discarded', version: view.version };
      this.publishSnapshotOutcome(discarded, source);
      return discarded;
    }
    if (view.version < current) {
      this.emitReconnect({
        kind: 'version_rollback',
        version: view.version,
        message: '牌局状态有更新，正在同步…',
      });
      const rollback: SnapshotAckResult = { status: 'rollback', version: view.version };
      this.publishSnapshotOutcome(rollback, source);
      return rollback;
    }
    // 契约里 ack 的 data 就是裁剪快照，按 §6.2 快照类规则应用
    this.applyAckSnapshot(view, source);
    const applied: SnapshotAckResult = { status: 'applied', version: view.version };
    this.publishSnapshotOutcome(applied, source);
    return applied;
  }

  /**
   * socket 断开的统一入口（M06：先释放在途请求，避免 UI 永久 loading）。
   *
   * R166：`io server disconnect` = **服务端主动踢线**（§5.4 的并发连接上限就是这条通道）。
   * 此时置 `serverRejected` 并发出一条 `server_rejected` 信号：
   *  - 信号**不是**为了导航（`useGameSession` 对它只提示、不导航），而是让 UI 有明确文案；
   *  - 终止恢复的依据是 **reason**，`system.error{10006}` 只决定文案 ——
   *    HTTP 维度的限流同样是 `10006`，那时链路是好的、必须继续自动重连。
   */
  private handleSocketDisconnect(reason?: string): void {
    if (reason !== 'io server disconnect') {
      // 释放在途请求，避免 UI 永久 loading（M06）。重连由随后的 `connect` 事件驱动。
      // ⚠️ 此路径「先释放」是安全的：socket.io 会自动重连，被唤醒的 `send()` 即使
      // 此刻仍进缓冲，也会随重连成功被冲刷（相位未判死、不触发 fail-fast）。
      this.releasePendingAndWakeWaiters();
      // 项 2：普通断线 ⇒ 进入重连态；give-up 主动触发的 disconnect 不回退相位。
      if (!this.giveUpRequested) this.updateConnection({ phase: 'reconnecting' });
      return;
    }

    this.serverRejected = true;
    const code = this.lastServerErrorCode;

    /**
     * 10004 静默恢复分支：refresh token 可能仍有效（TTL 7d），
     * 网关只是 access token（TTL 2h）过期。尝试静默续期，
     * 不判死、不发 emitReconnect 信号（UI 只看 ConnectionState）。
     */
    if (code === ErrCode.TOKEN_EXPIRED) {
      this.pendingSilentRenewal = this.attemptSilentRenewal();
      void this.pendingSilentRenewal;
      return;
    }

    // 项 2：服务端终止性踢线 ⇒ 相位判死（11003 不给重试；10006 由 UI 决定给手动重试）。
    this.updateConnection({ phase: 'dead', deadReason: 'server_rejected', deadCode: code });
    /**
     * ⚠️ 释放必须在**判死之后**（2026-10-13 修复 A 补；与 `giveUpReconnect()` 同序）：
     * `whenIdle` 的等待者是**同步回调**（`flushIdleWaiters` 直接调 `onIdle`，其中立刻
     * `send()`）。若先释放、相位还停在旧值，被唤醒的 `send()` **不**命中死态 fail-fast
     * ⇒ 请求被 emit 进**永远不会被冲刷**的 socket.io 缓冲（服务端踢线不自动重连，
     * 对比上一分支），把 `pending` 永久占死，且此后连 `whenIdle` 都没有唤醒点
     * （10006 可点「重新连接」自愈；11003 只能靠拆除/刷新）。
     * 先判死后释放：唤醒的重试立刻拿到 `ConnectionDeadError`，有界收敛（同 give-up）。
     */
    this.releasePendingAndWakeWaiters();
    /**
     * 文案（Task 4）：走 `connection-copy.ts#connectionKickMessage`（单一真源）——
     * 11003/10008 用 `copy.ts` 同源全串，10006 用并发上限的完整玩家话术，无码/其它码各自中性兜底。
     * 负对照（不再有诊断串 `服务端拒绝该连接（code=N）`）钉在 `connection-rejected.test.ts`。
     */
    this.emitReconnect({
      kind: 'server_rejected',
      version: this.currentVersion,
      message: connectionKickMessage(code),
    });
  }

  /**
   * 10004 静默续期（§6.1 / 提交 1）。
   *
   * 网关拒握手（`system.error{10004}` → `disconnect('io server disconnect')`）时调用。
   * 五态（`TokenRenewResult`）的处置：
   * - `rotated`：重置 `serverRejected` + `lastServerErrorCode`，调 `onTokensRenewed`，
   *   `socket.connect()`（socket.io auth 回调会再 ensure，新令牌走正常路径）
   * - `unavailable`：不判死，保持 reconnecting 退避，`socket.connect()`（引擎退避；
   *   后续 open 的 auth 回调会再 ensure，网络恢复后一次完成）
   * - `invalid` / `no_session`：进 `session_expired` 终态
   *
   * 配额语义：`silentRenewConsumed` 仅在 rotated 后置位；unavailable 不消耗；
   * 成功 connect 时重置。
   */
  private async attemptSilentRenewal(): Promise<void> {
    if (this.silentRenewInFlight) return;
    if (this.destroyed) return;
    this.silentRenewInFlight = true;
    try {
      // 配额检查：上次 rotated 成功后仍被拒 10004 → 确定性循环，判死
      if (this.silentRenewConsumed) {
        this.enterSessionExpired();
        return;
      }

      // 先置 reconnecting 相位（清 deadReason/deadCode，attempt:0），
      // 注意此时 `serverRejected` 保持 true 阻止意外 connect 回黄。
      this.updateConnection({
        phase: 'reconnecting',
        deadReason: null,
        deadCode: null,
        attempt: 0,
      });

      // 释放在途请求（reconnecting 相位释放安全，同 transport close 路径注释）
      this.releasePendingAndWakeWaiters();

      const result: TokenRenewResult = await rotateRefreshToken().catch(
        (): TokenRenewResult => 'unavailable',
      );

      switch (result) {
        case 'rotated':
          this.silentRenewConsumed = true;
          this.serverRejected = false;
          this.lastServerErrorCode = null;
          this.options.onTokensRenewed?.();
          this.socket.connect();
          break;
        case 'unavailable':
          // 不置配额（网络不可用，允许引擎退避重试）
          this.serverRejected = false;
          this.lastServerErrorCode = null;
          this.socket.connect();
          break;
        case 'invalid':
        case 'no_session':
          this.enterSessionExpired();
          break;
        case 'fresh':
          // 理论上不应到达这里（fresh 意味着本地 exp 未过期，不会 10004）
          // 但防御性处理：重置状态，让 connect 事件正常推进
          this.serverRejected = false;
          this.lastServerErrorCode = null;
          this.socket.connect();
          break;
      }
    } finally {
      this.silentRenewInFlight = false;
    }
  }

  /**
   * 进入 `session_expired` 终态：refresh 确定性拒绝或无会话。
   *
   * **先** `updateConnection(dead)` **后** `releasePendingAndWakeWaiters()`
   * （顺序同修复 A：保证被唤醒的 send 拿到 fail-fast `ConnectionDeadError`）。
   * 保持 `serverRejected = true`（阻止意外 connect 回黄）。
   * **不发** `emitReconnect` 信号（UI 只看 `ConnectionState`，session_expired 不走 ReconnectReason）。
   */
  private enterSessionExpired(): void {
    this.updateConnection({
      phase: 'dead',
      deadReason: 'session_expired',
      deadCode: 10004,
    });
    this.releasePendingAndWakeWaiters();
  }

  /**
   * socket 重连后的恢复动作（M03：携带客户端已应用的最新 version）。
   *
   * ⚠️ 信号在**快照到手之后**才发：`kind: 'socket_reconnect'` 会让 UI 回到牌桌，
   * 而 ack 可能是 `13010`/`13005`（对局已不可恢复 → 回大厅并清空 store）。
   * 先发信号会把「已回大厅」的路径也走一遍牌桌导航，且信号还会被去抖窗口停住，
   * 之后补发时把用户拽回**已经被 reset 的空牌桌**。
   *
   * 失败（blocked 两次 / ack 超时 / 丢了应答）时发 `snapshot_unavailable`，由上层给用户提示——
   * 重连失败**不得静默**。
   */
  private async handleSocketReconnect(): Promise<void> {
    // R166：服务端踢过线就**不再**自动恢复（否则会进入 connect/kick 循环）。
    if (this.serverRejected) return;
    if (this.reconnectInFlight) return;
    const lastVersion = this.currentVersion;
    this.reconnectInFlight = true;
    try {
      const result = await this.reconnect(lastVersion);
      /**
       * 三种结果、三种处置，**不得合流**：
       *  - `answered_with_error`（`13010`/`13005` 等）：服务端给了**确定答复**，
       *    `CLIENT_ACTION` 表已处置（回大厅）并写好 notice → **不发任何信号**。
       *    既不能发 `snapshot_unavailable`（会覆盖那条 notice），也不能发
       *    `socket_reconnect`（它的语义是「快照到手、可以回牌桌」，而此刻 store 已被 reset）。
       *  - `unavailable` / `timeout`：压根没拿到答复 → 提示用户，不静默。
       *  - `applied` / `discarded` / `rollback`：快照到手（或已是最新）→ 可以回牌桌。
       */
      if (result.status === 'answered_with_error') return;
      if (result.status === 'unavailable' || result.status === 'timeout') {
        /**
         * 🔴 **面向玩家的文案**（2026-10-13 用户反馈：原「socket.io 已重连，但未能取回当前快照
         * （lastVersion=N）」是内部术语）。内部细节（lastVersion/status）不再进文案；
         * 需要排障时看本函数的调用链与 `lastSnapshotOutcome`，别把协议词汇塞回这里。
         */
        this.emitReconnect({
          kind: 'snapshot_unavailable',
          version: lastVersion,
          message: '连接已恢复，但未能同步最新状态，请重试',
        });
        return;
      }
      /**
       * `applied` / `discarded` 对玩家是同一件事（**已同步**——discarded 只是「另一条通道先到」
       * 的重复送达）；`rollback` 有一句自己的话（它的「重新同步」是玩家能感知的语义）——
       * 文案判据在 `reconnect-flow.test.ts`（逐字 `toBe`）与 `notice-presentation.test.ts`（零术语）。
       */
      this.emitReconnect({
        kind: 'socket_reconnect',
        version: lastVersion,
        message:
          result.status === 'rollback'
            ? '连接已恢复，正在重新同步最新状态…'
            : '连接已恢复',
      });
    } finally {
      this.reconnectInFlight = false;
    }
  }

  /** 快照 ack 的应用钩子：交给订阅者，由 store 按 §6.2 的 version 规则应用。 */
  private applyAckSnapshot(view: PlayerView, source: SnapshotSource): void {
    for (const handler of this.snapshotHandlers) handler(view, source);
  }

  /** 快照 ack 处置结果的播报（含「丢弃」，见 `onSnapshotOutcome`）。 */
  private publishSnapshotOutcome(result: SnapshotAckResult, source: SnapshotSource): void {
    for (const handler of this.snapshotOutcomeHandlers) handler(result, source);
  }

  private finishRequest(request: PendingRequest, result: SentResult): void {
    if (!request.settled) {
      request.settled = true;
      request.settle(result);
    }
    const pending = this.pending;
    if (!pending || pending !== request) return;
    /**
     * 快照类请求（`game.resync` / `game.reconnect`）**不以 version 推进为完成条件**：
     * ack 本身就带着快照，等到下一次状态转移才能继续操作是没有意义的（M06 针对的是动作请求）。
     */
    const awaitingVersion = pending.awaitingStateVersion;
    if (awaitingVersion !== null && result.code === 0 && !isSnapshotRequest(request.type)) {
      /**
       * ack 已到，但按 M06 要等到 state_update 推进 version 才允许下一次操作。
       *
       * ⚠️ **到达顺序不保证**：服务端的推送链路（Redis pub/sub → 网关）可能**先于**
       * ack（RPC 回程）到达客户端。先到时 `handleServerMessage` 因 `pending.settled ===
       * false` 跳过释放；ack 现在才到，若这里只认「ack 已到」就直接 return，槽位会一直
       * 占到 `ACK_TIMEOUT_MS`（5s）。典型表现：流局重发后随机又是自己首叫，客户端刚应用
       * 完新一版的 `game.state_update` 就点「不叫」⇒ `send()` 返回 `blocked`，页面弹
       * 「上一个操作尚未确认，请稍候」。
       * ⇒ 补判「已应用的版本是否已经推过 baseVersion」，已推进则立即释放。
       */
      if (this.currentVersion > awaitingVersion) this.releasePending();
      return;
    }
    this.releasePending();
  }

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

  /**
   * 释放串行队列**并把错误码处置插在「队列已空」与「唤醒等待者」之间**。
   *
   * 顺序在这里是契约的一部分：
   *  ① `releasePending` 释放槽位（但**不**唤醒 `whenIdle` 的等待者）；
   *  ② `notifyAction` **同步**派发 `CLIENT_ACTION`——`13004` → `game.resync`（§6.5 强制的
   *     唯一恢复通道）必须拿到刚空出来的槽位；**快照类请求自身的** REFRESH_SNAPSHOT 失败
   *     由自激守卫豁免（`isSelfExcitedRefresh`，规格 v1.1 §2.6）；
   *  ③ 之后才唤醒等待者（例如断线重连的有界重试）。重试因此**让出优先级**，
   *     但仍会在下一次队列空下来时被电平触发唤醒，不会被永久丢弃。
   *
   * ⚠️ 「**同步拿槽位**」的确切含义（R60 实测校正，别再按直觉理解成本条之外的东西）：
   * `finishRequest` **先**清空 `pending`，随后 `notifyAction` 里同步 `send()` 的恢复请求会
   * **立即 emit**（它不需要等下一次空闲）。因此紧接着的 `flushIdleWaiters` 会因
   * `pending !== null` **整体早退**，`sendQueued` 的等待者被推迟到该恢复请求释放槽位时
   * 才被唤醒 —— 结果是等待者让路（正确），但**不是**「重试被抢走而失败」：
   * 唤醒时槽位往往是空的，重试直接成功。`sendQueued` 返回 `blocked` 的条件是
   * 「**最后一次尝试本身**撞上在途请求」，而不是「被恢复请求抢先」。
   */
  private dispatchAck(request: PendingRequest, result: SentResult, message?: string): void {
    this.finishRequest(request, result);
    if (result.code !== 0 && !this.isSelfExcitedRefresh(request.type, result.code)) {
      this.notifyAction(result.code, message);
    }
    this.flushIdleWaiters();
  }

  /**
   * 记录一次应用层活动（C→S emit 或 S→C 应用帧）。
   * 独立方法（而不是内联赋值）是因为 attachSocket 的 `connect` 事件也会显式调它——
   * 重连成功后引擎层链路稳定但业务帧可能还没发，空闲计时器应该从这一刻起算。
   */
  private touchActivity(): void {
    const now = this.options.now?.() ?? Date.now();
    if (now > this.lastActivityAt) this.lastActivityAt = now;
  }

  /**
   * **释放串行队列的底层原语**：把 `pending` 清空并结算，但**不**唤醒 `whenIdle` 的等待者。
   *
   * ⚠️ 只有 `dispatchAck` 需要「先释放 → 同步派发 `CLIENT_ACTION` → 才唤醒」这个特例顺序，
   * 它因此显式调用本方法 + 自己 flush。**其余任何调用点都必须用
   * `releasePendingAndWakeWaiters()`**——它保证「槽位释放了，等待者一定被唤醒」。
   * 直接调用本方法而忘记 flush，会让等待者的重试 promise 永久挂起，
   * 进而把 `reconnectInFlight` 卡死（之后每次 socket 重连都静默 no-op）。
   *
   * ack 丢失（safetyTimer 到点）时结算为 `-1`，与「断线」同一语义：没有拿到服务端应答。
   */
  private releasePending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    if (pending.safetyTimer) clearTimeout(pending.safetyTimer);
    if (!pending.settled) {
      pending.settled = true;
      pending.settle({
        status: 'sent',
        type: pending.type,
        reqId: pending.reqId,
        baseVersion: pending.baseVersion,
        code: -1,
        action: undefined,
        // 「ack 丢失」= 计时器到点 **且** ack 回调从未触发（CAS 等 state_update 超时不算丢包）
        ackTimedOut: pending.ackTimedOut && !pending.ackReceived,
      });
    }
  }

  /**
   * 释放串行队列**并**唤醒等待者——除 `dispatchAck` 之外**所有**释放点的唯一入口。
   *
   * 把这两件事绑在一起，是为了让「槽位释放了却没唤醒等待者」在结构上不可能发生。
   */
  private releasePendingAndWakeWaiters(): void {
    this.releasePending();
    this.flushIdleWaiters();
  }

  /**
   * 等待串行队列空闲的**明确原语**（不轮询、电平触发）。
   *
   * 队列本来就是有序的，但「等它空」不能靠 `setTimeout` 猜——这里由释放点调用
   * `flushIdleWaiters` 唤醒。**电平触发**的含义：每次队列真的空下来都会唤醒等待者，
   * 所以调用方即使这次没抢到槽位（被 `CLIENT_ACTION` 之类抢先），下次空闲还会被叫醒。
   *
   * 不变量：**每个等待者恰好被结算一次**——
   *  - 队列空掉 → `flushIdleWaiters`；
   *  - 会话拆除 → `clearIdleWaiters`（**结算**，不是丢弃，见其注释）。
   *
   * ⚠️ 这条不变量依赖「所有释放点都走 `releasePendingAndWakeWaiters`」
   * （`dispatchAck` 是唯一特例，它显式 flush）。漏掉任一处就会让重试 promise 永久挂起，
   * 进而卡死 `reconnectInFlight`，使之后每次 socket 重连都静默 no-op。
   */
  private whenIdle(onIdle: () => void): void {
    if (this.destroyed || !this.pending) {
      onIdle();
      return;
    }
    const waiter: IdleWaiter = {
      settled: false,
      resolve: () => {
        if (waiter.settled) return;
        waiter.settled = true;
        onIdle();
      },
    };
    /**
     * **不需要兜底定时器**：所有会腾出队列的路径都会调用 `flushIdleWaiters`
     * （ack 派发、`disconnect`、`connect_error`、safetyTimer 超时兜底、`destroy`）。
     * 因此等待者不会永久挂起，也不存在「在 `pending` 仍被占用时就提前结算」
     * 从而白花一次重试、还把失败提示拖到 ~10s 之后的问题。
     */
    this.idleWaiters.push(waiter);
  }

  /** 队列空掉时唤醒所有等待者。 */
  private flushIdleWaiters(): void {
    if (this.pending || this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  /**
   * 拆除会话时**结算**（而不是丢弃）所有等待者。
   *
   * 不变量：**`whenIdle` 的回调一定会被调用恰好一次**——要么被 `flushIdleWaiters` 唤醒，
   * 要么被这里取消时结算。调用方（`requestSnapshot` 的重试循环）用 `send()` 在拆除后
   * reject 来识别取消，因此不会卡在一个永不结算的 promise 上。
   */
  private clearIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  private notifyAction(
    code: number,
    message?: string,
    source: 'action' | 'system' = 'action',
  ): ClientActionReport[] {
    // 未知码不得静默：每会话每码只报一次（与 dispatchErrorCode 的重复调用由 Set 去重）。
    if (!isKnownCode(code)) reportUnknownCode(code, 'action');
    const reports: ClientActionReport[] = [];
    for (const executor of this.actionHandlers) {
      reports.push(executor(code, message, source));
    }
    return reports;
  }

  /**
   * 重连/回退信号需要去抖：一次劣化可能同时被多条消息触发，
   * 但重连动作只允许发生一次（避免风暴）。
   *
   * ⚠️ **被抑制的信号不能就此丢失**：窗口内到达的信号会**记住**（`pendingReconnectReason`），
   * 在窗口结束时补发。否则会出现真实的活性缺陷——
   * `socket_reconnect` 刚占上窗口，紧随其后的 `version_rollback` 就被丢弃，
   * 而回退可能只有一次机会（后续快照可能是「同版本」→ 丢弃，不再产生信号），
   * 客户端就会一直停留在陈旧的视图上。
   *
   * 窗口结束后的补发是在 `setTimeout` 回调里直接分派的，`clearReconnectTimer` 仍能可靠取消。
   */
  private emitReconnect(reason: ReconnectReason): void {
    if (this.reconnectTimer) {
      // 已有窗口在跑：记住这一次，等窗口结束时补发（后到的通常更严重，覆盖即可）
      this.pendingReconnectReason = reason;
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const pending = this.pendingReconnectReason;
      this.pendingReconnectReason = null;
      if (pending) this.emitReconnect(pending);
    }, RECONNECT_DEBOUNCE_MS);
    for (const handler of this.reconnectHandlers) handler(reason);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingReconnectReason = null;
  }
}

function settled(request: PendingRequest): boolean {
  return request.settled;
}

function generateId(): string {
  return createReqId();
}

/** S→C 消息类型清单（与协议 §6.3 一致、共 12 条；用本地常量避免运行期依赖 server 常量表顺序）。
 *  ⚠️ 记牌器收费片起**导出**：`protocol-doc-sync`/集合相等断言需要读取本清单（漏列 = 静默丢消息）。 */
export function messageTypeList(): ServerMessageType[] {
  return [
    'room.matched',
    'room.state_update',
    'game.deal',
    'game.current_turn',
    'game.state_update',
    'game.finished',
    'game.settlement',
    /** ② 金币场（§2.2）：少了这一条 ⇒ 服务端照发、本端收不到（静默缺列）。 */
    'game.balances',
    /** 记牌器收费片：本局开通状态（房间级；同样少一条就静默丢列）。 */
    'game.card_counter',
    'system.error',
    'system.warning',
    /** 机器人补位开关片：缺人友好等待提示（非终止；少了它 ⇒ 开关关时服务端照发、本端收不到）。 */
    'match.wait_prompt',
  ];
}

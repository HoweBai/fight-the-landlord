/**
 * 传输层抽象：把「socket.io 客户端」缩到一个可注入的窄接口。
 *
 * 存在的理由有两个，都很实际：
 *  1. 契约测试必须在**离线、确定性**的前提下跑（测试注入 FakeSocket，不连网络）；
 *  2. endpoint 必须可注入——开发期连协调者的 mock（localhost:3400），联调期换真实网关，
 *     切换只改 URL，不改任何业务代码。
 *
 * 这里**不做**任何协议加工：信封、串行、校验都在 `socket.ts`。
 * 心跳只用 socket.io 内置机制（§6.1），所以本文件里没有任何 ping/pong。
 */

/** socket.io ack 回调：超时或失败时 `err` 非空。 */
export type AckCallback = (err: Error | null, res?: unknown) => void;

/** `GameClient` 真正用到的 socket.io Socket 子集。 */
export interface SocketLike {
  emit(event: string, payload: unknown, ack?: AckCallback): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
  /**
   * socket.io 的 **Manager**（项 2：重连终态判定）。
   *
   * ⚠️ `reconnect_attempt` 只在 Manager 上派发，Socket 实例**不转发**它
   *（socket.io 4.x 实测；`socket.on('reconnect_attempt')` 永远收不到）。
   * 生产工厂返回的真 socket 自带 `.io`；测试替身按需要注入同形接缝。
   * 可选：没有它的宿主只是放弃「重试 N 次后判死」，不影响其余链路。
   */
  readonly io?: {
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
  };
}

/**
 * 握手鉴权载荷：socket.io 的 `auth` 字段（§6.1）。
 *
 * 两种形态：
 * - `SocketAuth`（`Record<string, unknown>`）：静态对象（`{ token }` 或 `{ userId }`）
 * - `SocketAuthProvider`：函数形 `(cb) => {...; cb(authObj)}`，socket.io-client 4.8.4
 *   在每次引擎层 open（首次连接 + 自动重连 + 手动 `socket.connect()`）前调用，
 *   等待 `cb` 返回后才发 CONNECT 包（**禁止**在 `reconnect_attempt` 事件里 await 续期——
 *   事件不被 await，是竞态）。
 *
 * `ensureFreshAccessToken()` 的调用由 session.ts 的装配层注入（见 session.ts 注释），
 * transport.ts 只做透传，不 import token-refresh。
 */
export type SocketAuth = Record<string, unknown>;
export type SocketAuthProvider = (cb: (auth: SocketAuth) => void) => void;

export interface SocketFactory {
  (
    url: string,
    opts: { path: string; auth: SocketAuth | SocketAuthProvider; transports: string[] },
  ): SocketLike;
}

/**
 * 「把 socket.io 要求的传输名换成实际的传输」的选择器（切片 P10 Task 3 的接缝）。
 *
 * `GameClient` 永远请求 `transports: ['websocket']`（§6.1 只要 WebSocket，不要轮询）。
 * H5 / App 上这就是**原来的**字符串数组（engine.io 自带浏览器 WebSocket 传输）；
 * 小程序端必须换成基于 `wx.connectSocket` 的实现（engine.io 也接受**传输类构造器**，
 * 它只读 `ctor.prototype.name`，见 `engine.io-client/build/esm/socket.js`）。
 *
 * 存在这个接缝的理由：**`io(url, {...})` 只有一份实现**（下面的 `createSocketIoFactory`），
 * 平台差异只体现在一个值上，不会长出第二条连接路径。
 */
export type TransportSelection = (requested: readonly string[]) => unknown[];

/** H5 / App：原样透传（`['websocket']` ⇒ 字符串数组，走的还是 engine.io 自带的浏览器传输）。 */
export const browserTransportSelection: TransportSelection = (requested) => [...requested];

/** socket.io 的命名空间与路径（§6.1）。 */
export const DEFAULT_NAMESPACE = '/ws/ddz';
export const SOCKET_PATH = '/socket.io';
export const ACK_TIMEOUT_MS = 5000;
/**
 * 项 2：socket.io 自动重连多少次仍失败后，客户端判「连接已死」并停止自动重试。
 *
 * socket.io v4 的 `reconnect_failed` 事件在配置了有限 `reconnectionAttempts` 时才触发，
 * 本仓配置为无限重连，因此由我们自己数 Manager 的 `reconnect_attempt`。
 *
 * **22 次（退避 1s 起倍增、封顶 20s、jitter 0.5）≈ 6 分钟**。依据 = 用户裁决
 * 「断线重连**以超过 30 秒仍自动回为准**」+ 断线恢复设计
 *（`docs/superpowers/specs/2026-10-12-reconnect-until-game-end-design.md` §1 / §7 判据 1：
 * 同页断网 > 30s 必须能自动回）——旧值 8 次（退避 1s→10s 封顶）的窗口实测仅
 * ≈ 45.5–60.5s，只是勉强跨过 30s，不满足该承诺。
 *
 * ⚠️ **窗口推导**（与 socket.io-client 4.8.4 同源的退避公式，`contrib/backo2.js#duration`
 * + `manager.js`）：第 k 次尝试前的等待 = `min(RECONNECT_DELAY_MS × 2^(k-1) × jitter,
 * RECONNECT_DELAY_MAX_MS)`，jitter ∈ [0.5, 1.5]（`randomizationFactor` 缺省 0.5；先乘
 * jitter、再封顶）⇒ 22 次尝试的退避等待之和 = **351.5s–382.5s ≈ 5 分 52 秒–6 分 23 秒**
 *（下界 Σ min(500·2^(k−1), 20000)，上界 Σ min(1500·2^(k−1), 20000)；仅计退避等待本身，
 * 不含每次尝试自身的建链耗时）。计算型断言钉在 `connection-overlay.test.ts` 的 A2 组。
 */
export const RECONNECT_GIVE_UP_ATTEMPTS = 22;

/**
 * 重连退避的基准间隔与封顶值（socket.io 的 `reconnectionDelay` / `reconnectionDelayMax`）。
 *
 * ⚠️ 导出是给测试用的：A2 组的「窗口下界 ≥ 180s」计算型断言必须用**同一份真值**推导，
 * 否则常量单边改小时窗口会静默缩水、断言却恒绿（`connection-overlay.test.ts`）。
 */
export const RECONNECT_DELAY_MS = 1_000;
export const RECONNECT_DELAY_MAX_MS = 20_000;
/**
 * 重连/回退信号的去抖窗口：一次状态回退可能同时被多条消息触发，
 * 但重连动作只允许发生一次（避免风暴）。
 */
export const RECONNECT_DEBOUNCE_MS = 1000;

export interface TransportOptions {
  /** 服务端 origin 或完整 URL（可含 namespace）。空则回退到当前页面 origin。 */
  endpoint?: string;
  /** 默认 `/ws/ddz` */
  namespace?: string;
  /** 握手鉴权：`auth: { token }`（真实网关）或 `auth: { userId }`（mock）；或函数形（socket.io 每次 open 前调用）。 */
  auth: SocketAuth | SocketAuthProvider;
  /** 注入点：测试传假 socket；生产传 socket.io-client 的 io。 */
  socketFactory?: SocketFactory;
}

/**
 * 读 `VITE_WS_ENDPOINT`。
 *
 * 抽出来是为了让「环境变量名」只有**一个**真源：`resolveEndpoint`（浏览器路径的回退链）与
 * `http.ts` 的 R550 校验（小程序端必须**显式**配置）读的是同一个读取函数，不各自抄一遍变量名。
 */
export function readWsEndpointEnv(): string | undefined {
  /**
   * ⚠️ 只用**直接的属性访问**（切片 P19）：`typeof import.meta` 这类守卫会让打包器把
   * `import.meta` 实体化成 `{ url: … require(<Node url>) … }`，而微信小程序的 service 里
   * `document` 不存在 ⇒ 必走那条分支 ⇒ `module 'url.js' is not defined` ⇒ 整包挂掉。
   * 详见 `src/config.ts#readEnv` 的注释。
   */
  return import.meta.env?.VITE_WS_ENDPOINT as string | undefined;
}

/**
 * 环境变量取 endpoint，便于切 mock / 真实后端而不改代码。
 *
 * ⚠️ 本函数**只**负责浏览器语义的解析链（显式 → 环境变量 → 同源 → `localhost:3000`）。
 * 小程序端**不得**走这条回退（那里没有 `window.location`，会落到硬编码的 `localhost:3000`，
 * 真机必挂）——那条校验在 `http.ts#resolveWsEndpoint`（R550），且必须发生在**进入本函数之前**。
 */
export function resolveEndpoint(explicit?: string): string {
  const endpoint = explicit ?? readWsEndpointEnv() ?? '';
  if (endpoint) return endpoint;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return 'http://localhost:3000';
}

/** 拼出 socket.io 的连接 URL（origin + namespace），已含 namespace 则原样返回。 */
export function buildSocketUrl(endpoint: string, namespace: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (trimmed.endsWith(namespace)) return trimmed;
  return `${trimmed}${namespace}`;
}

/**
 * 生产用的 socket.io 工厂。`io` 由入口（main.ts）注入，
 * 这样 net 层任何模块都不 import socket.io-client，测试才能完全离线。
 *
 * `selectTransports` 见 `TransportSelection`：H5/App 传不传都一样（默认原样透传），
 * 小程序端由 `net/mp-transport.ts` 注入选择器把 `'websocket'` 换成 `wx.connectSocket` 实现。
 * **`io(...)` 这一份调用不许分叉**：所有平台都从这里出去。
 */
export function createSocketIoFactory(
  io: (
    url: string,
    opts: Record<string, unknown>,
  ) => unknown,
  selectTransports: TransportSelection = browserTransportSelection,
): SocketFactory {
  return (url, opts) => {
    const socket = io(url, {
      path: opts.path,
      auth: opts.auth,
      transports: selectTransports(opts.transports),
      // 心跳只用 socket.io 内置机制（§6.1）：这里只配置重连退避，不写应用层 ping/pong
      reconnection: true,
      reconnectionDelay: RECONNECT_DELAY_MS,
      // 封顶 20s 与 RECONNECT_GIVE_UP_ATTEMPTS=22 一起把自动窗口拉到 ≈ 6 分钟（推导见上）
      reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
    });
    return socket as SocketLike;
  };
}

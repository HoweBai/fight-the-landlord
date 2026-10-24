/**
 * **非浏览器传输适配层**：基于 `wx.connectSocket` / `uni.connectSocket` 的
 * engine.io v4 WebSocket 传输。覆盖 **mp-weixin** 与 **App**（连接器在调用时解析，见 `appConnector`）。
 *
 * ## 为什么必须自己写
 *
 * 实测：`uni build -p mp-weixin` 的产物里 `common/vendor.js` **确实打进了**
 * socket.io-client + engine.io-client 的浏览器传输（`XMLHttpRequest` / `WebSocket` / `Blob`），
 * 而微信小程序运行时**没有**这些全局对象（只有 `wx.request` / `wx.connectSocket`）
 * ⇒ 在真机上握手第一步就会炸。所以小程序端必须换一条传输。
 *
 * **App 端同理，而且更隐蔽**（N39 实测，2026-09-19）：App 的 **service 侧**不是 WebView，
 * 那些全局**全都存在但全是 `undefined`**（`fetch` 甚至有名字却不是函数）——
 * 于是症状不是「炸」，而是**连不上**（大厅顶部「连接不可用」）。详见 `appConnector`。
 *
 * ## 它是什么
 *
 * 一个实现 engine.io-client「传输接口」的类：`name` / `writable` / `open()` / `send()` /
 * `close()` / `onPacket` / `onError` / `onClose` / `onOpen`（外加事件订阅 `on/off/once/
 * removeAllListeners`，engine.io 的 `Socket#setTransport` 要用 `.on(...)` 链式订阅
 * `drain` / `packet` / `error` / `close`）。包格式按 engine.io v4 的
 * `PACKET_TYPES`（`0` open / `1` close / `2` ping / `3` pong / `4` message / `5` upgrade /
 * `6` noop）逐字实现；收到 `2`（ping）**立即回 `3`（pong）**。
 *
 * 注入方式是既有接缝：engine.io 的 `transports` 选项**接受传输类构造器**
 * （它只读 `ctor.prototype.name`，见 `engine.io-client/build/esm/socket.js` 的构造函数），
 * 因此 `createSocketIoFactory(io, selectTransportSelection())` 就够了 —— `io(url, {...})`
 * 仍然只有那一份实现（H5 / App 走原路径，不分叉）。
 *
 * ## ⚠️ 未验证（必读）
 *
 * **本机没有微信开发者工具，这条适配层只在单测里被验证过「结构」**（URL/协议头/包格式/
 * ping-pong/close 的形态，见 `test/mp-transport.test.ts`），**没有在真机或模拟器上跑过一次
 * 真实握手**。因此**不得**把它说成「已支持小程序」。已知的两处与 engine.io 官方传输的
 * 差异（也都是结构性的、未经真机验证的取舍）：
 *
 *  1. **pong 去重**：engine.io 的 `Socket` 收到 `2` 也会自己发一帧 `3`
 *     （`socket.js#_onPacket` 的 `case "ping"`）。本传输层已经独占应答，再让它发一帧
 *     就会**每个心跳两帧 pong**；因此 `write()` 会丢弃 engine.io 补发的**空** pong
 *     （`{type:'pong', data: undefined}`），带 data 的 pong（升级探测用的 `probe`）**不丢**。
 *     本片只用 `transports: [MpWebSocketTransport]` 单一传输，不会走升级探测。
 *  2. **drain 是同步 emit**：engine.io 官方 WebSocket 传输把 `drain` 推迟到下一 tick；
 *     这里在 `SocketTask.send` 之后立刻置 `writable = true` 并 emit（`flush()` 已经把
 *     writeBuffer 清空，重入是安全的）。真机上是否需要让出一次 tick（例如小程序
 *     `send` 的背压）**未验证**。
 *
 * 二进制帧（`ArrayBuffer`）按 engine.io-parser 的二进制分支实现（首字节 = 类型码），
 * 但本项目的线格式全是 JSON 文本（§6.2），二进制分支**同样没有真机验证**。
 */

import { browserTransportSelection, type TransportSelection } from './transport';

/** engine.io v4 包类型码（`engine.io-parser@5.2.3` 的 `PACKET_TYPES` 逐字）。 */
const PACKET_TYPES = {
  open: '0',
  close: '1',
  ping: '2',
  pong: '3',
  message: '4',
  upgrade: '5',
  noop: '6',
} as const;

export type PacketType = keyof typeof PACKET_TYPES;

const PACKET_TYPES_REVERSE: Readonly<Record<string, PacketType>> = {
  '0': 'open',
  '1': 'close',
  '2': 'ping',
  '3': 'pong',
  '4': 'message',
  '5': 'upgrade',
  '6': 'noop',
};

/** engine.io 协议版本（`engine.io-parser` 的 `protocol = 4`）。握手查询参数里的 `EIO`。 */
export const ENGINE_IO_PROTOCOL = 4;

/** 传输名：与 engine.io 的 WebSocket 传输同名，`transports` 的语义因此不变。 */
export const MP_TRANSPORT_NAME = 'websocket';

export interface EnginePacket {
  type: PacketType | 'error';
  data?: unknown;
}

/** 编码一帧：`<类型码字符><data>`（engine.io-parser 的文本分支）。 */
export function encodeEnginePacket(packet: EnginePacket): string {
  const code = PACKET_TYPES[packet.type as PacketType];
  if (!code) throw new Error(`未知的 engine.io 包类型：${String(packet.type)}`);
  return code + (packet.data === undefined || packet.data === null ? '' : String(packet.data));
}

/** 解码一帧（文本帧首字符 = 类型码；二进制帧首字节 = 类型码）。 */
export function decodeEnginePacket(data: string | ArrayBuffer): EnginePacket {
  if (typeof data === 'string') {
    const type = PACKET_TYPES_REVERSE[data.charAt(0)];
    if (!type) return { type: 'error', data: 'parser error' };
    return { type, data: data.substring(1) };
  }
  const bytes = new Uint8Array(data);
  const type = PACKET_TYPES_REVERSE[String.fromCharCode(bytes[0] ?? -1)];
  if (!type) return { type: 'error', data: 'parser error' };
  return { type, data: data.slice(1) };
}

// ---------------------------------------------------------------------------
// `wx` 的最小形状（只声明用到的部分；`wx` 是运行时全局，不能 import 类型库，
// 见 test/source-boundary.test.ts 的裸依赖闸）
// ---------------------------------------------------------------------------

export interface MpSocketTaskLike {
  send(options: { data: string | ArrayBuffer; success?: () => void; fail?: (error: unknown) => void }): void;
  close(options?: { code?: number; reason?: string }): void;
  onOpen(callback: () => void): void;
  onMessage(callback: (res: { data: string | ArrayBuffer }) => void): void;
  onClose(callback: (res?: unknown) => void): void;
  onError(callback: (error: unknown) => void): void;
}

export interface MpWxLike {
  connectSocket(options: {
    url: string;
    header?: Record<string, string>;
    protocols?: string[];
    tcpNoDelay?: boolean;
  }): MpSocketTaskLike;
}

/**
 * 全局 `wx` 的**局部**声明。
 *
 * `@dcloudio/types` 只声明了全局 `uni`（不声明 `wx`：它把 `wx` 交给
 * `miniprogram-api-typings`，那个包不在本仓的依赖里）⇒ 在模块作用域自己声明一个最窄的
 * 形状即可。`declare const` 编译后被擦除，运行期读到的仍是运行时注入的全局对象。
 */
declare const wx: MpWxLike;

/**
 * App 端的 socket 连接器：`uni.connectSocket`。
 *
 * ## 为什么 App 必须换连接器（N39 实测，2026-09-19，Android 基座）
 *
 * engine.io 的**浏览器**传输要 `XMLHttpRequest` + `WebSocket`，而 App 的 **service 侧**
 * 跑在 weexjsb 的 V8 上下文里 —— 实测那些全局**全是 `undefined`**：
 *
 * ```
 * fetch=undefined XMLHttpRequest=undefined WebSocket=undefined
 * Blob=undefined FormData=undefined document=undefined window=undefined
 * ```
 *
 * 同一次实测还抓到 REST 那条边的原文 `fetch is not a function`，落地症状是「注册不了」。
 * 两者是**同一个错误前提**的后果：「App 跑在 WebView 里 ⇒ 浏览器 API 可用」——
 * **WebView 只是渲染层，service 侧是另一个进程**，那里只有 uni 的 API。
 *
 * ## ⚠️ 写法约束（闸：`test/uni-api-access.test.ts`）
 *
 * `uni.connectSocket(...)` 必须是**直接的成员调用**，不得写成 `const x = uni` / `return uni`：
 * H5 发行构建靠改写直接调用来把 `uni.*` 接到 `@dcloudio/uni-h5`，读进变量就扫不到。
 * 所以这里返回的是**包装对象**而不是 `uni` 本体。存在性判定用 `typeof uni` 是允许的。
 *
 * ## ⚠️ App 端的事件模型与 `SocketTask` **根本不同**（N39 实测第二处）
 *
 * `uni.connectSocket` 在 **App 端不返回 `SocketTask`** —— 它回的对象没有 `onOpen` /
 * `onMessage` ⇒ 照 `SocketTask` 那条路挂监听会抛
 * `TypeError: this.task.onOpen is not a function`，而该异常发生在 uni 的引导期
 * （app 级 `onError` 尚未接上）⇒ **又是一次完全静默的白屏**。
 *
 * App 端的正确形态是**进程级全局事件**：`uni.onSocketOpen/Message/Error/Close` +
 * `uni.sendSocketMessage` + `uni.closeSocket`（实测六个都是 `function`）。
 * 而这些处理器**没有对应的 `offSocket*`**（`@dcloudio/types` 里没有）⇒ 只能注册一次，
 * 见 `installAppSocketHandlers`。
 */
function appConnector(): MpWxLike | undefined {
  if (typeof uni === 'undefined' || typeof uni.connectSocket !== 'function') return undefined;
  return {
    connectSocket: (options) => createAppSocketTask(options),
  };
}

/**
 * 当前活跃的 App socket 包装实例（见 `installAppSocketHandlers` 的「为什么是模块级」）。
 * engine.io 每次重连都会 `new` 一个传输 ⇒ 每次都会有一个新的包装实例顶上来。
 */
let activeAppSocketTask: AppSocketTask | null = null;
let appSocketHandlersInstalled = false;

/**
 * ⚠️ **只能注册一次**：`uni.onSocket*` 是**进程级**的，而且 `@dcloudio/types` 里
 * **没有 `offSocket*`** ⇒ 注册上去的处理器**无法注销**。按每次连接注册一份会让
 * 每次重连**多留一份**（泄漏 + 同一帧被处理多次）。
 *
 * ⇒ 因此模块级只注册一次，再由它把事件转发给「当前活跃」的那个包装实例。
 * 这与 `SocketTask` 那条路（每个 task 自带监听）是**根本不同的模型** —— 那是 App 端
 * `uni.connectSocket` 不返回 `SocketTask` 的直接后果。
 */
function installAppSocketHandlers(): void {
  if (appSocketHandlersInstalled) return;
  appSocketHandlersInstalled = true;
  uni.onSocketOpen(() => activeAppSocketTask?.emitOpen());
  uni.onSocketMessage((res) => activeAppSocketTask?.emitMessage(res));
  uni.onSocketError((error) => activeAppSocketTask?.emitError(error));
  uni.onSocketClose((res) => activeAppSocketTask?.emitClose(res));
}

function createAppSocketTask(options: {
  url: string;
  header?: Record<string, string>;
  protocols?: string[];
}): MpSocketTaskLike {
  const task = new AppSocketTask();
  // 先登记活跃实例、再发起连接：事件可能在 connectSocket 之后立刻到达。
  activeAppSocketTask = task;
  installAppSocketHandlers();
  uni.connectSocket({
    url: options.url,
    header: options.header,
    protocols: options.protocols,
  });
  return task;
}

/**
 * 把 uni 的**全局事件** socket API 包装成 `MpSocketTaskLike`（App 端）。
 *
 * 传输类只认 `MpSocketTaskLike` ⇒ 协议逻辑（URI/包格式/心跳/close）**一份都不用改**，
 * 平台差异全部收在这个包装里。
 */
class AppSocketTask implements MpSocketTaskLike {
  private openCallback: (() => void) | null = null;
  private messageCallback: ((res: { data: string | ArrayBuffer }) => void) | null = null;
  private closeCallback: ((res?: unknown) => void) | null = null;
  private errorCallback: ((error: unknown) => void) | null = null;

  onOpen(callback: () => void): void {
    this.openCallback = callback;
  }
  onMessage(callback: (res: { data: string | ArrayBuffer }) => void): void {
    this.messageCallback = callback;
  }
  onClose(callback: (res?: unknown) => void): void {
    this.closeCallback = callback;
  }
  onError(callback: (error: unknown) => void): void {
    this.errorCallback = callback;
  }

  send(options: { data: string | ArrayBuffer }): void {
    // 本项目的线格式全是 JSON 文本（§6.2）；`ArrayBuffer` 分支留着不实现（没有调用方）。
    uni.sendSocketMessage({ data: options.data as string });
  }

  close(_options?: { code?: number; reason?: string }): void {
    uni.closeSocket();
  }

  emitOpen(): void {
    this.openCallback?.();
  }
  emitMessage(res: { data: string | ArrayBuffer }): void {
    this.messageCallback?.(res);
  }
  emitClose(res?: unknown): void {
    this.closeCallback?.(res);
  }
  emitError(error: unknown): void {
    this.errorCallback?.(error);
  }
}

/**
 * engine.io 会把自己的选项对象原样交给传输（`createTransport` 里
 * `Object.assign({}, this.opts, {...})`）⇒ 这里能读到它算好的 `query` / `hostname` /
 * 端口与 schema；额外字段（`extraHeaders` / `protocols` / `wx`）也从同一个对象进来。
 */
export interface MpTransportOptions {
  query?: Record<string, string | number>;
  path?: string;
  hostname?: string;
  port?: string | number;
  secure?: boolean;
  /** engine.io 的 `Transport` 基类读它来算 `supportsBinary`（`!opts.forceBase64`）。 */
  forceBase64?: boolean;
  /** socket.io 的 `extraHeaders`：浏览器里 WebSocket 设不了请求头，小程序能（`header`）。 */
  extraHeaders?: Record<string, string>;
  protocols?: string[];
  /** 注入点：测试传假 `wx`；生产留空则惰性读全局 `wx`。 */
  wx?: MpWxLike;
  [key: string]: unknown;
}

export const DEFAULT_MP_PATH = '/socket.io/';

/** 传输层的结构化错误（engine.io 的 `TransportError` 同形：`type` + `description`）。 */
export interface MpTransportError extends Error {
  type: 'TransportError';
  description?: unknown;
  context?: unknown;
}

function transportError(description: unknown, context?: unknown): MpTransportError {
  const error = new Error('websocket error') as MpTransportError;
  error.type = 'TransportError';
  error.description = description;
  error.context = context;
  return error;
}

type Listener = (...args: unknown[]) => void;

/**
 * 基于 `wx.connectSocket` 的 engine.io v4 WebSocket 传输。
 *
 * 事件面（`open` / `packet` / `error` / `close` / `drain`）与 engine.io 的 `Transport`
 * 基类一致；`emitReserved` 在本仓叫 `emit`（我们不继承 `@socket.io/component-emitter`，
 * 那是被裸依赖闸禁止的）。
 */
export class MpWebSocketTransport {
  /** engine.io 读 `ctor.prototype.name` 来登记传输名 ⇒ 必须是原型上的取值器。 */
  get name(): string {
    return MP_TRANSPORT_NAME;
  }

  writable = false;
  readyState: 'closed' | 'opening' | 'open' | 'pausing' | 'paused' = 'closed';

  /**
   * ⚠️⚠️ **engine.io 的 `Transport` 基类公开这四个字段，而 `Socket` 会直接读写它们** ——
   * 我们必须按**同一契约**暴露（切片 P20 的**阻断级**缺陷就是漏了 `query`）：
   *
   * ```
   * 基类 constructor：this.opts = opts; this.query = opts.query; this.socket = opts.socket;
   *                   this.supportsBinary = !opts.forceBase64;
   * Socket 里会访问 transport：{ close, name, pause, query, removeAllListeners, send, writable }
   * engine.io-client@6.6.6  socket.js:276   this.transport.query.sid = data.sid;   ← 崩溃点
   * ```
   *
   * 用户实测原文（微信开发者工具，N39 回填第二轮）：
   * `TypeError: Cannot set properties of undefined (setting 'sid')`
   * `at fu.onHandshake (…engine.io-client 的 Socket.onHandshake…)`
   * `at <socketTask.onmessage callback function>`
   *
   * ⇒ 根因：**连接其实已经建到服务端、服务端也回了 handshake 包**，
   * 但我们的类当初没继承基类、也没自己补 `query` ⇒ 写入 `undefined.sid` 抛错 ⇒ 握手在最后一步崩掉。
   * **判据**：`test/mp-transport-engine-contract.test.ts` —— 用**真的 engine.io-client `Socket`** +
   * 假 `wx` 跑一次握手（不靠我们自己写的替身自证）。
   */
  readonly opts: MpTransportOptions;
  readonly query: Record<string, string | number>;
  readonly socket: unknown;
  readonly supportsBinary: boolean;

  private readonly listeners = new Map<string, Listener[]>();
  private task: MpSocketTaskLike | null = null;

  constructor(opts: MpTransportOptions = {}) {
    this.opts = opts;
    this.query = opts.query ?? {};
    this.socket = opts.socket;
    this.supportsBinary = opts.forceBase64 !== true;
  }

  /**
   * 与 engine.io `Transport#pause` 同形（v6 的基类是**空实现**：只有 polling 之类的子类才覆写）。
   * `Socket` 在「升级探测」路径上会调用它 ⇒ 必须存在；WebSocket 传输没有可升级项，空实现是忠实的。
   */
  pause(_onPause: () => void): void {
    // 故意为空：见上面注释（基类即空实现）。
  }

  // ------------------------------------------------------------------ 事件面

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener?: Listener): this {
    if (!listener) {
      this.listeners.delete(event);
      return this;
    }
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((item) => item !== listener),
    );
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  // ------------------------------------------------------------------ 生命周期

  open(): this {
    this.readyState = 'opening';
    this.doOpen();
    return this;
  }

  close(): this {
    if (this.readyState === 'opening' || this.readyState === 'open') {
      this.doClose();
      this.onClose({ description: 'websocket connection closed' });
    }
    return this;
  }

  /** engine.io 的 `Transport#send`：只在 open 时才写，否则安静丢弃。 */
  send(packets: EnginePacket[]): void {
    if (this.readyState === 'open') this.write(packets);
  }

  onOpen(): void {
    this.readyState = 'open';
    this.writable = true;
    this.emit('open');
  }

  onPacket(packet: EnginePacket): void {
    this.emit('packet', packet);
  }

  onError(description: unknown, context?: unknown): void {
    this.emit('error', transportError(description, context));
  }

  onClose(details?: unknown): void {
    this.readyState = 'closed';
    this.writable = false;
    this.emit('close', details);
  }

  /**
   * 收到一帧原始数据：解码 → `2` 立刻回 `3` → **仍然把包透传给 engine.io**。
   *
   * 透传是必须的（不是冗余）：engine.io 的 `Socket#_onPacket` 在 `case "ping"` 里
   * `_resetPingTimeout()`，吞掉 ping 会让客户端在 `pingInterval + pingTimeout` 之后
   * 自己判定「心跳超时」并断开。它因此还会补发一帧 pong —— 由 `write()` 里的去重丢掉。
   */
  onData(data: string | ArrayBuffer): void {
    const packet = decodeEnginePacket(data);
    /**
     * ⚠️ **不要在这里回 pong**（P21）：engine.io v4 的 pong 由 **engine 的 `Socket`** 回
     * （`Socket._onPacket` 的 `case "ping": this._sendPacket("pong")`）。
     * 传输层再回一次 ⇒ 服务端每个 ping 收到**两个** pong；
     * 而更早的版本还顺手把 engine 要发的 pong 过滤掉了（见 git 历史里的 `continue`）⇒ 服务端收不到 pong。
     * ⇒ 传输层的职责只有一件：**把解出来的包原样交上去**。
     */
    this.onPacket(packet);
  }

  // ------------------------------------------------------------------ 内部

  private doOpen(): void {
    const connector = this.resolveConnector();
    if (!connector) {
      this.onError(
        '没有可用的 socket 连接器：wx.connectSocket（mp-weixin）与 uni.connectSocket（App）都不存在',
      );
      return;
    }
    let task: MpSocketTaskLike;
    try {
      task = connector.connectSocket({
        url: this.uri(),
        header: this.opts.extraHeaders,
        protocols: this.opts.protocols,
      });
    } catch (error) {
      this.onError('connectSocket 调用失败', error);
      return;
    }
    /**
     * ⚠️ **必须校验事件面**（N39 实测，2026-09-19）：
     * `uni.connectSocket` 在 **App 端不返回 `SocketTask`** —— 它回的对象没有
     * `onOpen` / `onMessage` / … ⇒ 直接挂监听会抛
     * `TypeError: this.task.onOpen is not a function`，异常冒到 uni 的引导层
     * （那时 app 级 `onError` 还没接上）⇒ **完全静默的白屏**。
     * 这里挡住它，并把「连接器给不出事件面」变成一条**看得见的** `error`。
     */
    if (typeof task?.onOpen !== 'function' || typeof task?.onMessage !== 'function') {
      this.onError('connectSocket 返回的对象没有 SocketTask 事件面（App 端需走 uni.onSocket* 全局事件）');
      return;
    }
    this.task = task;
    this.task.onOpen(() => this.onOpen());
    this.task.onMessage((res) => this.onData(res.data));
    this.task.onClose((res) => this.onClose(res));
    this.task.onError((error) => this.onError('websocket error', error));
  }

  private doClose(): void {
    const task = this.task;
    this.task = null;
    if (!task) return;
    try {
      task.close({});
    } catch {
      // 已经关掉的 SocketTask 再 close 会抛：忽略（close 的语义已达成）
    }
  }

  /**
   * 写一批包。
   *
   * ⚠️ 丢掉 engine.io 因收到 ping 而补发的**空** pong（本传输层已独占应答，见文件头
   * 「未验证」第 1 条）；带 data 的 pong（升级探测）保留。
   */
  private write(packets: EnginePacket[]): void {
    this.writable = false;
    for (const packet of packets) {
      this.writeRaw(encodeEnginePacket(packet));
    }
    /**
     * ⚠️⚠️ `drain` **必须延到下一个 tick**，否则会**无限递归**（用户 N39 回填第三轮实测的
     * `RangeError: Maximum call stack size exceeded`，栈为
     * `Socket._onDrain ← 我们的 emit ← 我们的 write ← 我们的 send ← Socket.flush ← _onDrain ← …`）：
     *
     * engine.io 的 `Socket.flush()` 是**先 send、后记账**：
     * ```js
     * this.transport.send(packets);
     * this._prevBufferLen = packets.length;   // ← send 同步 emit drain 时它还是 0
     * ```
     * ⇒ 同步 emit `drain` 会让 `_onDrain()` 用**过期的 0** 去 `writeBuffer.splice(0, 0)`（一条都清不掉）
     * ⇒ `writeBuffer.length !== 0` ⇒ 再 `flush()` ⇒ 再 `send()` ⇒ 递归到栈溢出。
     *
     * 浏览器传输的源码注释就是答案（`transports/websocket.js`）：
     * `// fake drain` / `// defer to next tick to allow Socket to clear writeBuffer`。
     */
    setTimeout(() => {
      this.writable = true;
      this.emit('drain');
    }, 0);
  }

  /** 心跳应答：直接写 `3`（不经 engine.io 的 writeBuffer）。 */
  private writeRaw(data: string | ArrayBuffer): void {
    const task = this.task;
    if (!task) return;
    try {
      task.send({ data });
    } catch (error) {
      this.onError('SocketTask.send 调用失败', error);
    }
  }

  /**
   * 连接器解析：测试可注入（`opts.wx`）；生产**惰性**读全局（不在模块顶层读）。
   *
   * 顺序即平台顺序：
   *  1. `wx.connectSocket` —— mp-weixin；
   *  2. `uni.connectSocket` —— **App**：它的 service 侧没有任何浏览器全局（见 `appConnector`）。
   */
  private resolveConnector(): MpWxLike | undefined {
    if (this.opts.wx) return this.opts.wx;
    /**
     * ⚠️⚠️ **必须按平台判定，不能靠「`wx` 存不存在」做特性探测**（N39 实测，2026-09-19）。
     *
     * App 上 **`wx` 也是存在的对象**，而且 `wx.connectSocket` **是函数** ——
     * 实测输出：`typeof wx=object wx.connectSocket=function typeof uni=object`。
     * 但那个 `wx` 是 uni 的 base 提供的 shim，**不是微信小程序运行时**：
     * 它的 `connectSocket` 既不返回 `SocketTask`，也不会派发 `SocketTask` 事件
     * ⇒ 特性探测会**静默选中它**，事件永远不回来，socket.io 在 ~20 秒后报
     * `connect_error`（**连接根本没发出去** —— 网关侧零日志，这正是最难查的形态）。
     */
    if (detectPlatform() === 'app') return appConnector();
    if (typeof wx !== 'undefined' && typeof wx.connectSocket === 'function') {
      return wx as unknown as MpWxLike;
    }
    return appConnector();
  }

  /**
   * 建连 URL：`ws(s)://host[:port]<path>?<query>`（与 engine.io `Transport#createUri` 同形）。
   *
   * `query` 由 engine.io 填好：`EIO=4`、`transport=websocket`（以及握手后的 `sid`）。
   * `path` 已被 engine.io 规范化成以 `/` 结尾（`addTrailingSlash`）。
   */
  uri(): string {
    const schema = this.opts.secure ? 'wss' : 'ws';
    const hostname = String(this.opts.hostname ?? 'localhost');
    const host = hostname.includes(':') ? `[${hostname}]` : hostname;
    const path = this.normalizePath(this.opts.path);
    // ⚠️ 读 `this.query`（**不是** `this.opts.query`）：engine.io 的 `Socket.onHandshake` 会往
    // 同一个对象上写 `sid`（重连时要带它）⇒ 必须共享同一个引用（切片 P20）。
    const query = encodeQuery(this.query);
    return `${schema}://${host}${portSuffix(this.opts.port, this.opts.secure === true)}${path}${query}`;
  }

  private normalizePath(path: string | undefined): string {
    const value = path && path.length > 0 ? path : DEFAULT_MP_PATH;
    return value.endsWith('/') ? value : `${value}/`;
  }
}

/** engine.io `Transport#_port()` 的等价物：默认端口不写出来。 */
function portSuffix(port: string | number | undefined, secure: boolean): string {
  if (port === undefined || port === '') return '';
  const parsed = Number(port);
  if ((secure && parsed === 443) || (!secure && parsed === 80)) return '';
  return `:${port}`;
}

/** engine.io `contrib/parseqs.ts#encode` 的等价物（键值都 encodeURIComponent）。 */
function encodeQuery(query: Record<string, string | number>): string {
  const parts: string[] = [];
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// 平台判定与传输选择（都可注入，**不在模块顶层读 uni/wx**）
// ---------------------------------------------------------------------------

/** 本片覆盖的两类平台。 */
export type PlatformKind = 'browser' | 'mp-weixin' | 'app';

export interface UniSystemInfoLike {
  /** `@dcloudio/types` 的说明：`app` / `mp-weixin` / `web` 等。 */
  uniPlatform?: string;
}

export type GetSystemInfoSync = () => UniSystemInfoLike;

/**
 * 生产用的平台读取：`uni.getSystemInfoSync().uniPlatform`。
 *
 * ⚠️ `uni.getSystemInfoSync()` 必须是**直接的成员表达式**：H5 发行构建（默认摇树）里
 * `window.uni` 只是空占位对象，真正可用的是 uni 编译器把这种直接调用改写成
 * `@dcloudio/uni-h5` 的 import（`uni-h5-vite/dist/plugins/inject.js`）。详见
 * `net/storage.ts#hasUni` 的注释。
 */
export const readUniSystemInfo: GetSystemInfoSync = () => {
  if (typeof uni === 'undefined' || typeof uni.getSystemInfoSync !== 'function') return {};
  return uni.getSystemInfoSync();
};

/**
 * 平台 → 传输类别。
 *
 * ⚠️ 实测取值（不要凭直觉写）：H5 上 `uniPlatform` 是 **`'web'`**
 * （`@dcloudio/uni-h5/dist/uni-h5.es.js` 里写死 `uniPlatform: "web"`），App 是 `app*`
 * （`@dcloudio/types` 的注释：`app` / `mp-weixin` / `web`），小程序端由
 * `UNI_PLATFORM` 注入（mp-weixin 构建即 `'mp-weixin'`）。
 *
 * 判定规则：
 *  - `mp-weixin` ⇒ 小程序传输；
 *  - `app*` ⇒ **`'app'`** —— 与 `'browser'` **必须分开**：App 的 **service 侧**跑在
 *    weexjsb 的 V8 上下文里，**那不是 WebView**（WebView 只是渲染层，另起一个进程）。
 *    ⇒ 浏览器全局在 service 侧**不可假定存在**：实测 `fetch` 有这个名字却**不是函数**
 *    （调用抛 `TypeError: fetch is not a function`，N39 的「App 注册不了」根因，
 *    2026-09-19 在 Android 基座上抓到的原文）。REST 因此必须走 `uni.request`（见 `net/http.ts`）。
 *    ⚠️ **但 socket 传输仍选浏览器实现**（`selectTransportSelection`）：engine.io 在那条
 *    路径上用 `XMLHttpRequest` / `WebSocket`，而这两个 uni 在 App 端**是提供的**。
 *    两条边的可用全局不同，所以平台类别要分开、而传输选择不跟着分。
 *  - `web` / `h5` ⇒ **浏览器路径**；
 *  - 读不到平台（宿主根本没有 `uni`：纯 web / SSR / 单测）⇒ 浏览器路径 ——
 *    没有 uni 就没有小程序运行时，这条分支不可能是「小程序悄悄退化成浏览器」；
 *  - **其它任何平台（mp-alipay / mp-baidu / quickapp …）⇒ 明确报错**，
 *    绝不静默退化成浏览器路径（那些运行时里同样没有 `WebSocket`/`XMLHttpRequest`）。
 */
export function classifyPlatform(platform: string | undefined): PlatformKind {
  if (platform === 'mp-weixin') return 'mp-weixin';
  if (platform === undefined || platform === '') return 'browser';
  if (platform.startsWith('app')) return 'app';
  if (platform === 'web' || platform === 'h5') return 'browser';
  throw new Error(
    `不支持的运行平台 uniPlatform=${platform}：本片只覆盖 H5 / App / mp-weixin；` +
      '其它小程序平台需要各自的传输适配层（不得退化成浏览器传输）',
  );
}

/** 判定平台（可注入：测试传假的 `getSystemInfoSync`）。 */
export function detectPlatform(getSystemInfoSync: GetSystemInfoSync = readUniSystemInfo): PlatformKind {
  return classifyPlatform(getSystemInfoSync().uniPlatform);
}

/**
 * 非浏览器平台的传输选择：把 `'websocket'` 换成 `wx.connectSocket` / `uni.connectSocket`
 * 实现（engine.io 接受构造器）。
 *
 * ⚠️ 名字里的 `mp` 是历史（本片最初只做小程序）；现在**同时覆盖 App** ——
 * 两者的浏览器全局都不可用，用的都是 uni 一族的长连接 API（连接器由
 * `resolveConnector()` 在调用时解析）。重命名会波及测试与调用点，暂留。
 */
export const mpTransportSelection: TransportSelection = (requested) => {
  const unsupported = requested.filter((name) => name !== MP_TRANSPORT_NAME);
  if (unsupported.length > 0) {
    throw new Error(
      `非浏览器传输只实现了 ${MP_TRANSPORT_NAME}，收到无法满足的传输：${unsupported.join(', ')}`,
    );
  }
  return [MpWebSocketTransport];
};

/**
 * 传输选择器（`SocketFactory` 的接缝）：由 `main.ts` 传给 `createSocketIoFactory`。
 * 判定函数可注入，便于测试逐条覆盖平台分支。
 */
export function selectTransportSelection(
  getSystemInfoSync: GetSystemInfoSync = readUniSystemInfo,
): TransportSelection {
  const platform = detectPlatform(getSystemInfoSync);
  // mp-weixin 与 app 都走 uni 一族的长连接 API（wx.connectSocket / uni.connectSocket）——
  // 浏览器传输要 XMLHttpRequest / WebSocket，这两端都没有（见 appConnector 的实测数据）。
  return platform === 'mp-weixin' || platform === 'app'
    ? mpTransportSelection
    : browserTransportSelection;
}

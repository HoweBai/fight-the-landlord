/**
 * 测试替身：一个只实现 GameClient 真正用到的 socket.io 子集的假 socket。
 *
 * 明确**不依赖** socket.io-client 的内部实现，也不连网络——
 * 契约测试必须是确定性的、离线的。
 */
import type { SocketLike, SocketAuth, SocketAuthProvider } from '../../src/net/transport';
import type { Card, PlayerView, ServerMessage, ServerMessageType } from '@fight-the-landlord/protocol';

/**
 * 解析握手鉴权（纯函数，供测试断言使用）。
 *
 * 对象形（`{ token }` 或 `{ userId }`）直接返回；
 * 函数形（`SocketAuthProvider`）调用 `cb(authObj)` 并等待 Promise resolve。
 */
export function resolveHandshakeAuth(auth: SocketAuth | SocketAuthProvider): Promise<SocketAuth> {
  if (typeof auth === 'function') {
    return new Promise<SocketAuth>((resolve) => {
      auth((resolved) => resolve(resolved));
    });
  }
  return Promise.resolve(auth);
}

/** 解析所有 pending 的握手，等待 Promise 数组中每一个 resolve。 */
export function flushHandshakes(
  pending: Array<Promise<void>>,
): Promise<void> {
  return Promise.all(pending.splice(0)).then(() => undefined);
}

export interface EmittedRequest {
  type: string;
  env: Record<string, unknown>;
  ack: (err: Error | null, res?: unknown) => void;
}

/**
 * socket.io **Manager** 的测试替身（项 2）。
 *
 * ⚠️ 真实关系：`socket.io` 是 Manager，`reconnect_attempt` 等重连事件只在 Manager
 * 上派发；这里实现同一组 `on/off` 与一个测试触发器 `emit`。
 */
export class FakeManager {
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, handler: (...args: unknown[]) => void): void {
    const set = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  /** 测试触发：按事件名派发（`reconnect_attempt` 的首参是尝试次数，从 1 起）。 */
  emit(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
  }
}

export class FakeSocket implements SocketLike {
  readonly emitted: EmittedRequest[] = [];
  readonly handlers = new Map<string, (...args: unknown[]) => void>();
  /**
   * Manager 接缝（项 2）。真实 socket 构造即带 `.io`，替身也恒定提供，
   * 用例通过 `socket.io.emit('reconnect_attempt', n)` 模拟重连尝试。
   */
  readonly io = new FakeManager();
  disconnected = false;
  connectCalls = 0;
  /** `disconnect()` 被调次数（项 2：give-up 必须主动停掉 socket.io 的无限重连）。 */
  disconnectCalls = 0;

  emit(type: string, env: unknown, ack?: (err: Error | null, res?: unknown) => void): void {
    this.emitted.push({ type, env: env as Record<string, unknown>, ack: ack ?? (() => {}) });
  }

  /** socket.io 的 socket.on：既承载业务消息，也承载 'disconnect' 等生命周期事件。 */
  on(event: string, handler?: (...args: unknown[]) => void): void {
    if (handler) this.handlers.set(event, handler);
  }

  connect(): void {
    this.connectCalls += 1;
    this.disconnected = false;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    const wasConnected = !this.disconnected;
    this.disconnected = true;
    /**
     * 与 socket.io-client 4.8.4 的真实行为对齐（`socket.js` 的 `disconnect()`：
     * `if (this.connected) onclose('io client disconnect')`）—— 主动断开**同步**派发
     * socket 级 `disconnect` 事件。漏掉它，`GameClient` 的断连处置在测试里永远不跑，
     * 「主动断开后的连接相位」这类判据只能假绿。
     */
    if (wasConnected) this.handlers.get('disconnect')?.('io client disconnect');
  }

  get connected(): boolean {
    return !this.disconnected;
  }

  /** 服务端主动推送（走 on 注册的处理器，等价于 socket.io 的 socket.on）。 */
  push(msg: ServerMessage): void {
    const h = this.handlers.get(msg.type);
    if (!h) throw new Error(`no handler registered for push type: ${msg.type}`);
    h(msg);
  }

  emitDisconnect(reason = 'transport close'): void {
    this.disconnected = true;
    this.handlers.get('disconnect')?.(reason);
  }

  /**
   * 模拟 socket.io 已重建链路。
   *
   * 真实 socket.io 在**初次**成功连接时也会触发 `'connect'`，
   * 因此契约测试必须显式走一遍「首次 connect」，重连才有意义（见 socket.ts 的 `hasConnected`）。
   */
  emitConnect(): void {
    this.disconnected = false;
    this.handlers.get('connect')?.();
  }

  emitConnectError(err: Error): void {
    this.handlers.get('connect_error')?.(err);
  }

  /** 按事件名筛出已发出的请求（断言「全程没有 emit X」时用）。 */
  emittedOf(type: string): EmittedRequest[] {
    return this.emitted.filter((e) => e.type === type);
  }

  lastRequest(): EmittedRequest | undefined {
    return this.emitted[this.emitted.length - 1];
  }
}

/** 构造一条合法的 S→C 消息（形状固定为 `{ type, version, payload }`，没有 seq）。 */
export function serverMessage(
  type: ServerMessageType,
  payload: unknown,
  version: number,
): ServerMessage {
  return { type, version, payload } as ServerMessage;
}

/**
 * 按点数序列造牌（R696：牌是 `{r, s}`）。
 *
 * ⚠️ **同一个点数的重复出现会拿到递增的花色**（0、1、2…）——
 * 因为 `Card` 是对象，同点数同花色的两张是**无法区分**的，而真实牌堆里
 * 同点数的四张花色必不相同。用例若需要「同点数两张」，这个助手给出的才是合法形态。
 *
 * 跨调用**不累积**（每次调用从花色 0 重新开始）—— 需要跨调用一致时用同一个
 * 助手实例或自己构造。本文件的 `playerViewFixture` 每次调用独立，不受影响。
 */
export const makeCards = (...ranks: number[]): Card[] => {
  const used = new Map<number, number>();
  return ranks.map((r) => {
    /**
     * ⚠️ **R696：两张王的 `s` 恒为 4（`Suit.Joker`）** —— 真实发牌 `createDeck()`
     * 就是这么产的（`packages/shared/src/card/card.ts:69-70`）。
     *
     * 本助手此前给王也发 `s = 0`，而 `protocol/validate.ts` **只校验 `s ∈ 0..4`、
     * 不交叉校验 `(r, s)`** ⇒ 那个不真实的形态静默通过了所有闸。
     * 后果在牌面接入后显现：`{r: 30, s: 0}` 在 `manifest.json` 里**查不到**
     * （王只有 `4-20` / `4-30`）⇒ 王会走文本兜底分支 ⇒ 页面级用例里
     * 「王渲染真牌面图」这条**根本测不到**（假绿）。
     */
    if (r === 20 || r === 30) return { r, s: 4 };
    const s = used.get(r) ?? 0;
    used.set(r, s + 1);
    return { r, s };
  });
};

/**
 * 合法的 PlayerView 夹具。字段值本身**不承载任何规则含义**——
 * 它们只是「服务端说什么就是什么」的占位（§12.1 哑终端）。
 */
export function playerViewFixture(over: Partial<PlayerView> = {}): PlayerView {
  const seat = over.seat ?? 0;
  const hand =
    over.hand ?? makeCards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30, 3, 4);
  return {
    roomCode: 'MOCK01',
    version: 1,
    state: 'bidding',
    baseScore: 15,
    seat,
    hand,
    bottomCards: null,
    landlordSeat: null,
    currentPlayer: 0,
    // 协议 ④：窗口为空（底座是 bidding 态 ⇒ 还没有人出过牌）
    recentActions: [],
    turnDeadlineAt: 1_700_000_030_000,
    bidPhase: {
      currentBidder: 0,
      bidMultiplier: 1,
      landlordCandidate: -1,
      grabActions: 0,
      redealCount: 0,
      kind: 'call',
      decisions: [],
    },
    playPhase: { bombCount: 0 },
    ...over,
    /**
     * ⚠️ `cardCounts` 必须在 `...over` **之后**计算，否则传进来的数组会把这一行覆盖掉
     *（修复轮 1 发现的真实 bug：座位对应的张数从来就没生效过）。
     *
     * 并且必须**复制**：`over.cardCounts` 是调用方的数组，就地改会把它一起改掉——
     * 两个 fixture 共用同一个数组时会互相别名。
     */
    cardCounts: (() => {
      const counts = [...(over.cardCounts ?? [hand.length, 17, 17])] as [number, number, number];
      counts[seat] = hand.length;
      return counts;
    })(),
    /**
     * 挂机治理（C25 / `PlayerView.trustees`）：三个座位的托管态。
     * ⚠️ 与 `cardCounts` 同款：必须在 `...over` **之后**给默认值，并**复制**调用方的数组
     *（共用同一数组时两个夹具会互相别名）。
     */
    trustees: [...(over.trustees ?? [false, false, false])] as [
      boolean,
      boolean,
      boolean,
    ],
  };
}

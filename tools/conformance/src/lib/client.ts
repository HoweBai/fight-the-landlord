/**
 * conformance 用的真实 socket.io 客户端封装。
 *
 * 三件事：
 *  1. `emit` + ack（§6.2 的**扁平**线格式：事件名承载 type，meta 三件套平铺在请求体里）；
 *  2. 记录**全部**入站消息，供泄漏检查与事后断言；
 *  3. `waitFor` 按条件等待某类推送。
 *
 * 刻意不复用 `apps/client` 的实现：conformance 要能独立发现「客户端漂移」，
 * 与被测前端共用一份代码就失去这个能力了。
 */
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { ClientMessageType } from '@fight-the-landlord/protocol';
import { ConformanceError, sleep } from './assert';
import { GATEWAY_URL, NAMESPACE, type HarnessUser } from './http';

export interface AckResult {
  code: number;
  message?: string;
  /** 载荷；成功时是 ack 的 data。 */
  data?: any;
}

export interface Received {
  type: string;
  message: any;
  at: number;
}

const ACK_TIMEOUT_MS = 8000;

export class HarnessClient {
  private readonly socket: Socket;
  readonly received: Received[] = [];
  /** 断线后仍要保留同一逻辑身份时用它。 */
  constructor(
    readonly label: string,
    readonly user: HarnessUser,
    socket: Socket,
  ) {
    this.socket = socket;
    this.socket.onAny((type: string, message: any) => {
      this.received.push({ type, message, at: Date.now() });
    });
  }

  static async connect(label: string, user: HarnessUser): Promise<HarnessClient> {
    const socket = io(`${GATEWAY_URL}${NAMESPACE}`, {
      path: '/socket.io/',
      transports: ['websocket'],
      auth: { token: user.accessToken },
      // conformance 自己控制重连；socket.io 的自动重连会掩盖「重连失败」
      reconnection: false,
    });
    const client = new HarnessClient(label, user, socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ConformanceError(`${label} 连接超时`)), 8000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (err: Error) => {
        clearTimeout(timer);
        reject(new ConformanceError(`${label} 握手失败：${err.message}`));
      });
    });
    return client;
  }

  get socketId(): string | undefined {
    return this.socket.id;
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  /** 发一条 C→S 请求并等 ack。超时返回 `code: -1`（契约里没有 -1，只表示没拿到回执）。 */
  send(type: ClientMessageType, payload: Record<string, unknown> = {}, baseVersion = 0): Promise<AckResult> {
    const body = { reqId: randomUUID(), baseVersion, timestamp: Date.now(), payload };
    return new Promise<AckResult>((resolve) => {
      const timer = setTimeout(() => resolve({ code: -1, message: 'ack timeout' }), ACK_TIMEOUT_MS);
      this.socket.emit(type, body, (res: AckResult) => {
        clearTimeout(timer);
        resolve(res ?? { code: -1, message: 'empty ack' });
      });
    });
  }

  /** 已收到的最新一条某类消息（没有则 undefined）。 */
  last(type: string): any | undefined {
    for (let i = this.received.length - 1; i >= 0; i -= 1) {
      if (this.received[i]!.type === type) return this.received[i]!.message;
    }
    return undefined;
  }

  /** 等一条满足条件的推送；已收到过的也算。 */
  waitFor(type: string, timeoutMs = 20000, predicate?: (message: any) => boolean): Promise<any> {
    const hit = (m: any): boolean => !predicate || predicate(m);
    const existing = this.received.find((r) => r.type === type && hit(r.message));
    if (existing) return Promise.resolve(existing.message);

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.offAny(handler);
        reject(new ConformanceError(`${this.label} 等 ${type} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const handler = (t: string, message: any): void => {
        if (t !== type || !hit(message)) return;
        clearTimeout(timer);
        this.socket.offAny(handler);
        resolve(message);
      };
      this.socket.onAny(handler);
    });
  }

  /** 干净断线 —— 服务端会立刻观测到 `disconnect`（这正是切片 5 要测的窗口起点）。 */
  disconnect(): void {
    this.socket.disconnect();
  }

  close(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

export { sleep };

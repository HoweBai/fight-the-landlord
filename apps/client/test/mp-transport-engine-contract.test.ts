/**
 * **真消费者契约测试**（切片 P20）：用 **engine.io-client 自己的 `Socket`** 驱动我们的
 * `MpWebSocketTransport`，跑一次真实握手 —— 而不是用我们自己写的替身自证。
 *
 * ## 为什么必须有这条（用户 N39 回填第二轮的实测缺陷）
 *
 * 微信开发者工具里报（编译通过、连接**已经建到服务端**、服务端也回了 handshake 包）：
 *
 * ```
 * TypeError: Cannot set properties of undefined (setting 'sid')
 *     at fu.onHandshake (…engine.io-client 的 Socket.onHandshake…)
 *     at c.onData (…) at <socketTask.onmessage callback function>
 * ```
 *
 * 根因：`engine.io-client` 的 `Transport` 基类在构造时公开 `opts` / `query` / `socket` / `supportsBinary`，
 * 而 `Socket` 会**直接读写**传输实例的这些字段（`socket.js:276` 的 `this.transport.query.sid = data.sid`）。
 * 我们的类当初是**独立类**（没有继承基类），只实现了收发与事件，**漏了 `query`** ⇒ 握手最后一步崩掉。
 *
 * 旧的 31 条 mp 传输用例只测**我们自己定义的接口**（包编解码、收发、close），
 * **结构上抓不到**「真实消费方会怎么用这个对象」。⇒ 本文件把**真实消费方**拉进来当判据。
 *
 * ⚠️ 这条测试直接 `import 'engine.io-client'`（`apps/client` 的 devDependency）。
 * 它是**测试**依赖，不进 `src/**` ⇒ 不触碰 §12 的裸依赖白名单（R435：不得放宽那些闸）。
 */
import { describe, expect, it } from 'vitest';
import { Socket as EngineSocket } from 'engine.io-client';
import {
  MpWebSocketTransport,
  type MpSocketTaskLike,
  type MpWxLike,
} from '../src/net/mp-transport';

/** 假 `SocketTask`：记录 send，暴露触发回调的钩子（模拟微信运行时的回调式 API）。 */
function createFakeTask() {
  const sent: (string | ArrayBuffer)[] = [];
  let onOpen: (() => void) | undefined;
  let onMessage: ((res: { data: string | ArrayBuffer }) => void) | undefined;
  let onClose: ((res?: unknown) => void) | undefined;
  let onError: ((error: unknown) => void) | undefined;
  let closed = false;
  const task: MpSocketTaskLike & {
    sent: typeof sent;
    fireOpen: () => void;
    fireMessage: (data: string | ArrayBuffer) => void;
    fireClose: (res?: unknown) => void;
    fireError: (error: unknown) => void;
    isClosed: () => boolean;
  } = {
    sent,
    send({ data }) {
      sent.push(data);
    },
    close() {
      closed = true;
    },
    onOpen(cb) {
      onOpen = cb;
    },
    onMessage(cb) {
      onMessage = cb;
    },
    onClose(cb) {
      onClose = cb;
    },
    onError(cb) {
      onError = cb;
    },
    fireOpen: () => onOpen?.(),
    fireMessage: (data) => onMessage?.({ data }),
    fireClose: (res) => onClose?.(res),
    fireError: (error) => onError?.(error),
    isClosed: () => closed,
  };
  return task;
}

/** engine.io 的握手包：`0{"sid":…}`（engine.io v4 / protocol 4）。 */
function handshakePacket(sid: string): string {
  return `0${JSON.stringify({
    sid,
    upgrades: [],
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxPayload: 1_000_000,
  })}`;
}

describe('P20 真消费者契约：engine.io-client 的 Socket × 我们的 MpWebSocketTransport', () => {
  it('握手不抛错，且 `transport.query.sid` 被 engine.io 写进去（用户实测的崩溃点）', () => {
    const task = createFakeTask();
    const wx: MpWxLike = { connectSocket: () => task };

    const engine = new EngineSocket('http://10.0.0.5:3000', {
      // engine.io 读 `ctor.prototype.name` 登记传输 ⇒ 传类本身
      transports: [MpWebSocketTransport as never],
      path: '/socket.io/',
      query: {},
      // `wx` 从 engine 的 opts 透传到 transport 的 opts（engine 会 spread 自己的 opts）
      wx,
    } as never);

    // ⚠️ engine.io 的 `Socket` **在构造里就 `_open()`**（v6.6：构造尾部 `this._open()`）⇒ 不需要也不能调 `open()`。
    // 构造完成时传输已建好并已 `connectSocket`。
    const transport = engine.transport as unknown as MpWebSocketTransport;
    expect(transport, 'engine.io 应已用我们的类创建传输').toBeInstanceOf(MpWebSocketTransport);
    task.fireOpen();

    // ⚠️ 下面这一行就是用户日志里崩掉的那一步：engine.io 会写 `this.transport.query.sid`
    expect(transport.query, 'transport.query 必须存在（engine.io 的 Transport 基类公开它）').toBeTypeOf('object');

    expect(() => task.fireMessage(handshakePacket('SID-ABC'))).not.toThrow();

    // 握手成功的三条可观察结果
    expect(engine.id).toBe('SID-ABC');
    expect(transport.query.sid).toBe('SID-ABC');
    expect(engine.readyState).toBe('open');
  });

  it('发送不会无限递归：`drain` 记账正确（P21 的 `RangeError: Maximum call stack size exceeded`）', async () => {
    const task = createFakeTask();
    const engine = new EngineSocket('http://10.0.0.5:3000', {
      transports: [MpWebSocketTransport as never],
      path: '/socket.io/',
      query: {},
      wx: { connectSocket: () => task } as MpWxLike,
    } as never);
    task.fireOpen();
    task.fireMessage(handshakePacket('SID-RECURSE'));

    // engine.io 的 `Socket.flush()` 是「先 send、后 `_prevBufferLen = n`」；
    // 传输层若**同步** emit `drain`，`_onDrain()` 会用 0 去 splice（清不掉）⇒ flush ⇒ send ⇒ 递归到栈溢出。
    // 未修的实现会在这一行抛 `RangeError: Maximum call stack size exceeded`。
    expect(() => engine.write('40/ws/ddz,')).not.toThrow();

    // 写帧已上线，而 `writable` 仍在「等 drain」的窗口里
    const transport = engine.transport as unknown as MpWebSocketTransport;
    expect(task.sent.some((d) => String(d).includes('40/ws/ddz'))).toBe(true);
    expect(transport.writable).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 0));
    // drain 之后：writable 复位、且写缓冲**真的被清空**（记账正确 ⇒ 不会反复 flush）
    expect(transport.writable).toBe(true);
    expect(engine.writeBuffer.length).toBe(0);
  });

  it('每个 ping **恰好一帧 pong**（传输层不许代 engine 回 pong）', async () => {
    const task = createFakeTask();
    const engine = new EngineSocket('http://10.0.0.5:3000', {
      transports: [MpWebSocketTransport as never],
      path: '/socket.io/',
      query: {},
      wx: { connectSocket: () => task } as MpWxLike,
    } as never);
    task.fireOpen();
    task.fireMessage(handshakePacket('SID-PING'));
    expect(engine.id).toBe('SID-PING'); // 握手确实走完了（否则下面测的是「还没连上」的空情况）
    task.sent.length = 0; // 只看心跳这一段

    task.fireMessage('2'); // engine.io 服务端的 ping
    await new Promise((resolve) => setTimeout(resolve, 0));

    // pong 由 engine 的 `Socket._onPacket` → `_sendPacket('pong')` 发出 ⇒ 恰好一帧 `3`
    expect(task.sent.filter((d) => d === '3')).toHaveLength(1);
  });

  it('契约面完整：engine.io 的 Socket 会访问的成员一个都不缺', () => {
    const transport = new MpWebSocketTransport({ query: { EIO: '4', transport: 'websocket' } });
    // 逐条对应 engine.io-client@6.6.6 `socket.js` 对 `this.transport.*` 的访问
    // （`grep -oE "this\\.transport\\.[a-zA-Z_]+" socket.js | sort -u`）
    expect(typeof transport.close).toBe('function');
    expect(transport.name).toBe('websocket');
    expect(typeof transport.pause).toBe('function');
    expect(typeof transport.query).toBe('object');
    expect(typeof transport.removeAllListeners).toBe('function');
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.writable).toBe('boolean');
    // 基类构造出的另外三个字段（`Socket` 之外的 engine.io 内部也会读）
    expect(typeof transport.opts).toBe('object');
    expect(transport.socket).toBeUndefined(); // 未传就是 undefined，但**字段存在**
    expect('socket' in transport).toBe(true);
    expect(transport.supportsBinary).toBe(true);
  });

  it('`query` 与 engine.io 共享**同一个对象引用**（重连要带 sid）', () => {
    const query: Record<string, string | number> = { EIO: '4', transport: 'websocket' };
    const transport = new MpWebSocketTransport({ query });
    query.sid = 'WRITTEN-BY-ENGINE';
    expect(transport.query.sid).toBe('WRITTEN-BY-ENGINE');
    expect(transport.uri()).toContain('sid=WRITTEN-BY-ENGINE');
  });
});

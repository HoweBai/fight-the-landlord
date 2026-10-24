/**
 * 小程序传输适配层的**结构判据**（切片 P10 Task 3 §1C）。
 *
 * ⚠️ 这些用例证明的只是「结构对」：URL / 协议头 / engine.io 包格式 / ping-pong / close
 * 的形态，都是在**假 `wx`** 上观察到的。本机没有微信开发者工具，这条适配层
 * **没有在真机或模拟器上跑过真实握手**（报告里逐字登记为「未验证」）。
 *
 * 五条派工单判据 + 两条补充：
 *  ① 建连 URL / 协议头 / `header` 正确（含 `path=/socket.io`、`EIO=4`、`transport=websocket`）；
 *  ② 收到 `2` 会回 `3`（且仍把 ping 透传给 engine.io —— 它要据此重置心跳超时）；
 *  ③ 收 `4…`（message）会透传给上层；
 *  ④ `close()` 会调 `SocketTask.close`；
 *  ⑤ **H5 平台下不会选到这条路径**（负对照，用 H5 的真实 `uniPlatform: 'web'`）；
 *  ⑥ 传输类必须能按 engine.io 的规则登记（`ctor.prototype.name === 'websocket'`）；
 *  ⑦ 平台判定的每条分支（含「其它平台明确报错」，不得静默退化成浏览器路径）。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  MpWebSocketTransport,
  classifyPlatform,
  decodeEnginePacket,
  detectPlatform,
  encodeEnginePacket,
  mpTransportSelection,
  selectTransportSelection,
  type EnginePacket,
  type MpSocketTaskLike,
  type MpTransportOptions,
  type MpWxLike,
} from '../src/net/mp-transport';
import { installUniStub } from './helpers/uni-stub';

/** 假 `wx`：`connectSocket` 返回一个可手动驱动的假 SocketTask，并把调用记下来。 */
function createFakeWx() {
  const calls = {
    connectSocket: [] as { url: string; header?: Record<string, string>; protocols?: string[] }[],
    sent: [] as (string | ArrayBuffer)[],
    closed: 0,
  };
  let onOpen: (() => void) | null = null;
  let onMessage: ((res: { data: string | ArrayBuffer }) => void) | null = null;
  let onClose: ((res?: unknown) => void) | null = null;
  let onError: ((error: unknown) => void) | null = null;

  const task: MpSocketTaskLike = {
    send: (options) => void calls.sent.push(options.data),
    close: () => void (calls.closed += 1),
    onOpen: (callback) => void (onOpen = callback),
    onMessage: (callback) => void (onMessage = callback),
    onClose: (callback) => void (onClose = callback),
    onError: (callback) => void (onError = callback),
  };

  const wx: MpWxLike = {
    connectSocket: (options) => {
      calls.connectSocket.push(options);
      return task;
    },
  };

  return {
    wx,
    calls,
    emitOpen: () => onOpen?.(),
    emitMessage: (data: string | ArrayBuffer) => onMessage?.({ data }),
    emitClose: (res?: unknown) => onClose?.(res),
    emitError: (error: unknown) => onError?.(error),
  };
}

/** 造一个已 open 的传输 + 它的假 wx。 */
function openTransport(overrides: Partial<MpTransportOptions> = {}) {
  const fake = createFakeWx();
  const transport = new MpWebSocketTransport({
    query: { EIO: 4, transport: 'websocket' },
    path: '/socket.io/',
    hostname: 'gw.test',
    port: 3000,
    secure: false,
    wx: fake.wx,
    ...overrides,
  });
  const events: { name: string; args: unknown[] }[] = [];
  for (const name of ['open', 'packet', 'error', 'close', 'drain']) {
    transport.on(name, (...args: unknown[]) => void events.push({ name, args }));
  }
  transport.open();
  fake.emitOpen();
  return { fake, transport, events };
}

describe('① 建连 URL / 协议头 / header', () => {
  it('URL = ws://host:port/path?EIO=4&transport=websocket（engine.io createUri 同形）', () => {
    const { fake } = openTransport();
    expect(fake.calls.connectSocket).toHaveLength(1);
    expect(fake.calls.connectSocket[0]!.url).toBe(
      'ws://gw.test:3000/socket.io/?EIO=4&transport=websocket',
    );
  });

  it('https 网关（secure）用 wss，且默认端口不写进 URL', () => {
    const { fake } = openTransport({ secure: true, port: 443 });
    expect(fake.calls.connectSocket[0]!.url).toBe(
      'wss://gw.test/socket.io/?EIO=4&transport=websocket',
    );
  });

  it('HTTP 默认端口 80 同样不写进 URL', () => {
    const { fake } = openTransport({ port: 80, secure: false });
    expect(fake.calls.connectSocket[0]!.url).toBe(
      'ws://gw.test/socket.io/?EIO=4&transport=websocket',
    );
  });

  it('socket.io 的 extraHeaders → wx.connectSocket 的 header；protocols 原样传', () => {
    const { fake } = openTransport({
      extraHeaders: { authorization: 'Bearer t', 'x-trace': '1' },
      protocols: ['ddz'],
    });
    expect(fake.calls.connectSocket[0]!.header).toEqual({
      authorization: 'Bearer t',
      'x-trace': '1',
    });
    expect(fake.calls.connectSocket[0]!.protocols).toEqual(['ddz']);
  });

  it('握手查询参数来自 engine.io（`query` 里已含 EIO/transport，握手后还有 sid）', () => {
    const { fake } = openTransport({ query: { EIO: 4, transport: 'websocket', sid: 'abc 1' } });
    expect(fake.calls.connectSocket[0]!.url).toBe(
      'ws://gw.test:3000/socket.io/?EIO=4&transport=websocket&sid=abc%201',
    );
  });

  it('open() 后 readyState=open / writable=true，并 emit `open`（engine.io 靠它 flush）', () => {
    const { transport, events } = openTransport();
    expect(transport.readyState).toBe('open');
    expect(transport.writable).toBe(true);
    expect(events.map((e) => e.name)).toContain('open');
  });

  it('没有 wx（纯浏览器单测）时：emit `error`、不抛异常，也不建连', () => {
    const transport = new MpWebSocketTransport({
      path: '/socket.io/',
      hostname: 'gw.test',
      port: 3000,
      query: { EIO: 4, transport: 'websocket' },
    });
    const errors: { message: string; description?: unknown }[] = [];
    transport.on('error', (err) => void errors.push(err as { message: string }));
    expect(() => transport.open()).not.toThrow();
    expect(errors).toHaveLength(1);
    // engine.io 的约定：message 恒为 'websocket error'，原因放 description
    expect(errors[0]!.message).toBe('websocket error');
    expect(String(errors[0]!.description)).toContain('wx.connectSocket');
    expect(transport.writable).toBe(false);
  });
});

describe('② 心跳：**传输层不回 pong**，只把 `2` 透传上去（P21 修正）', () => {
  /**
   * ⚠️ 这一组判据在 **P21** 被**反转**（原判据断言「收到 `2` 立刻写一帧 `3`」——那是错的）。
   *
   * engine.io v4 的 pong 由 **engine 的 `Socket`** 回：
   * `Socket._onPacket` 的 `case "ping": this._sendPacket("pong")`。
   * 传输层再回一次 ⇒ 服务端每个 ping 收到**两个** pong；而旧实现还顺手把 engine 要发的
   * 那个**空 pong 过滤掉**了 ⇒ 服务端**收不到 pong**（`pingInterval + pingTimeout` 之后踢线）。
   * 判据改为「**传输层一帧都不写**，engine 写的那一帧**必须**上线」——由真消费者契约测试
   * （`mp-transport-engine-contract.test.ts`）证明「每个 ping 恰好一帧 `3`」。
   */
  it('收到 `2` **不得**由传输层回 `3`（pong 是 engine 的 Socket 的职责）', () => {
    const { fake, transport } = openTransport();
    fake.emitMessage('2');
    expect(fake.calls.sent).toEqual([]);
    expect(transport.readyState).toBe('open');
  });

  it('ping **仍然透传**给 engine.io（它据此 _resetPingTimeout 并回 pong，吞掉会让客户端自判定超时）', () => {
    const { fake, events } = openTransport();
    fake.emitMessage('2');
    expect(events.filter((e) => e.name === 'packet').map((e) => e.args[0])).toEqual([
      { type: 'ping', data: '' },
    ]);
  });

  it('engine.io 因收到 ping 而发的 **pong 必须上线**（旧实现把它过滤掉了 ⇒ 服务端收不到 pong）', () => {
    const { fake, transport } = openTransport();
    transport.send([{ type: 'pong' }]);
    expect(fake.calls.sent).toEqual(['3']);
  });

  it('带 data 的 pong（升级探测 `probe`）不丢（本片不会走到，但不制造静默行为）', () => {
    const { fake, transport } = openTransport();
    transport.send([{ type: 'pong', data: 'probe' }]);
    expect(fake.calls.sent).toEqual(['3probe']);
  });
});

describe('③ `4…`（message）透传给上层', () => {
  it('收 `4{"code":0}` → packet 事件拿到 {type:"message", data:"{\\"code\\":0}"}', () => {
    const { fake, events } = openTransport();
    fake.emitMessage('4{"code":0}');
    expect(events.filter((e) => e.name === 'packet').map((e) => e.args[0])).toEqual([
      { type: 'message', data: '{"code":0}' },
    ]);
  });

  it('`0`(open) / `5`(upgrade) / `6`(noop) 同样透传（本层不解释语义）', () => {
    const { fake, events } = openTransport();
    fake.emitMessage('0{"sid":"abc","pingInterval":25000}');
    fake.emitMessage('5');
    fake.emitMessage('6');
    expect(events.filter((e) => e.name === 'packet').map((e) => e.args[0])).toEqual([
      { type: 'open', data: '{"sid":"abc","pingInterval":25000}' },
      { type: 'upgrade', data: '' },
      { type: 'noop', data: '' },
    ]);
  });

  it('发一帧 message：`440`；`drain` 与 `writable` 复位**延到下一个 tick**（P21：同步 emit 会无限递归）', async () => {
    const { fake, transport, events } = openTransport();
    transport.send([{ type: 'message', data: '40' }]);
    // 写帧是同步的
    expect(fake.calls.sent).toEqual(['440']);
    // ⚠️ 但 `writable` 必须**仍为 false**、`drain` **尚未** emit：
    // engine.io 的 `Socket.flush()` 是「先 `transport.send()`、后 `_prevBufferLen = n`」，
    // 同步 emit `drain` 会让 `_onDrain()` 用过期的 0 清空缓冲 ⇒ 无限递归（用户实测的 RangeError）。
    expect(transport.writable).toBe(false);
    expect(events.map((e) => e.name)).not.toContain('drain');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.writable).toBe(true);
    expect(events.map((e) => e.name)).toContain('drain');
  });

  it('编码/解码往返（文本帧）', () => {
    const packet: EnginePacket = { type: 'message', data: '42["room.matched",{"a":1}]' };
    expect(decodeEnginePacket(encodeEnginePacket(packet))).toEqual(packet);
    expect(encodeEnginePacket({ type: 'ping' })).toBe('2');
    expect(decodeEnginePacket('3')).toEqual({ type: 'pong', data: '' });
  });

  it('不认识的类型码 → error 包（不抛）', () => {
    expect(decodeEnginePacket('9')).toEqual({ type: 'error', data: 'parser error' });
  });

  it('SocketTask.onError → 传输层 emit `error`（engine.io 的 TransportError 同形）', () => {
    const { fake, events } = openTransport();
    fake.emitError(new Error('boom'));
    const errors = events.filter((e) => e.name === 'error').map((e) => e.args[0] as { type: string });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe('TransportError');
  });
});

describe('④ close()', () => {
  it('close() 会调 SocketTask.close，并 emit `close` / 复位状态', () => {
    const { fake, transport, events } = openTransport();
    transport.close();
    expect(fake.calls.closed).toBe(1);
    expect(transport.readyState).toBe('closed');
    expect(transport.writable).toBe(false);
    expect(events.map((e) => e.name)).toContain('close');
  });

  it('已经 closed 之后再 close() 不会重复调 SocketTask.close（幂等）', () => {
    const { fake, transport } = openTransport();
    transport.close();
    transport.close();
    expect(fake.calls.closed).toBe(1);
  });

  it('close() 之后 send() 不再写（engine.io 的 Transport#send 语义）', () => {
    const { fake, transport } = openTransport();
    transport.close();
    transport.send([{ type: 'message', data: '40' }]);
    expect(fake.calls.sent).toEqual([]);
  });
});

describe('⑤ 负对照：H5 平台不会选到这条路径', () => {
  beforeEach(() => {
    installUniStub(); // H5 的真实取值：uniPlatform === 'web'
  });

  it('默认平台读取（替身报 web）⇒ 浏览器传输，`transports` 仍是字符串数组', () => {
    const selection = selectTransportSelection();
    expect(selection(['websocket'])).toEqual(['websocket']);
    expect(selection(['websocket'])[0]).not.toBe(MpWebSocketTransport);
  });

  it('明确注入 H5 平台 ⇒ 同样不会选到小程序传输', () => {
    expect(selectTransportSelection(() => ({ uniPlatform: 'web' }))(['websocket'])).toEqual([
      'websocket',
    ]);
    expect(detectPlatform(() => ({ uniPlatform: 'web' }))).toBe('browser');
  });

  it('App 端（uniPlatform=app）：类别是 app，传输也换成 uni 一族', () => {
    // ⚠️ 两类边（REST / socket）在 App 端可用全局**相同地**贫瘠：service 侧实测
    // `XMLHttpRequest` / `WebSocket` / `fetch` 全是 undefined（N39，2026-09-19）。
    // 所以 App 与 mp-weixin 一样，必须换成基于 uni 长连接 API 的传输；
    // 连接器由 resolveConnector() 在调用时解析（有 wx 用 wx，否则 uni.connectSocket）。
    for (const platform of ['app', 'app-plus', 'app-android']) {
      expect(detectPlatform(() => ({ uniPlatform: platform }))).toBe('app');
      expect(selectTransportSelection(() => ({ uniPlatform: platform }))(['websocket'])).toEqual([
        MpWebSocketTransport,
      ]);
    }
  });

  it('mp-weixin ⇒ 换成 wx.connectSocket 传输（构造器，engine.io 接受）', () => {
    const selection = selectTransportSelection(() => ({ uniPlatform: 'mp-weixin' }));
    expect(selection(['websocket'])).toEqual([MpWebSocketTransport]);
  });

  it('两个连接器都不存在 ⇒ 报错，不静默（负对照）', () => {
    vi.stubGlobal('wx', undefined);
    vi.stubGlobal('uni', undefined);

    const transport = new MpWebSocketTransport({ hostname: 'gw.test' });
    const errors: unknown[] = [];
    transport.on('error', (error) => void errors.push(error));
    transport.open();

    expect(errors).toHaveLength(1);
  });
});

describe('⑥ 传输类能被 engine.io 登记（`ctor.prototype.name`）', () => {
  it('prototype.name === "websocket"（engine.io 的 transports 登记规则）', () => {
    // engine.io-client: `opts.transports.forEach(t => { const name = t.prototype.name; … })`
    expect(MpWebSocketTransport.prototype.name).toBe('websocket');
    expect(new MpWebSocketTransport({}).name).toBe('websocket');
  });

  it('事件订阅是可链式的（engine.io 的 setTransport 用 `.on(…).on(…)`）', () => {
    const transport = new MpWebSocketTransport({});
    const chain = transport
      .on('drain', () => {})
      .on('packet', () => {})
      .on('error', () => {})
      .on('close', () => {});
    expect(chain).toBe(transport);
    expect(() => transport.removeAllListeners()).not.toThrow();
  });
});

describe('⑦ 平台判定：其它平台必须明确报错（不得静默退化成浏览器路径）', () => {
  it('其它小程序平台 → 抛错', () => {
    for (const platform of ['mp-alipay', 'mp-baidu', 'mp-toutiao', 'quickapp']) {
      expect(() => classifyPlatform(platform)).toThrow(/不支持的运行平台/);
      expect(() => selectTransportSelection(() => ({ uniPlatform: platform }))).toThrow(
        /不支持的运行平台/,
      );
    }
  });

  it('读不到平台（宿主没有 uni：纯 web / SSR / 单测）⇒ 浏览器路径，不抛', () => {
    expect(classifyPlatform(undefined)).toBe('browser');
    expect(classifyPlatform('')).toBe('browser');
    expect(detectPlatform(() => ({}))).toBe('browser');
  });

  it('小程序端只实现了 websocket：请求别的传输要明确报错（不静默改传）', () => {
    expect(mpTransportSelection(['websocket'])).toEqual([MpWebSocketTransport]);
    expect(() => mpTransportSelection(['polling'])).toThrow(/只实现了 websocket/);
  });

  it('默认判定读的是全局 uni（不在模块顶层读：判定发生在调用时）', () => {
    installUniStub({ platform: 'mp-weixin' });
    expect(detectPlatform()).toBe('mp-weixin');
    installUniStub({ platform: 'web' });
    expect(detectPlatform()).toBe('browser');
  });

  it('uni 缺失时默认判定不抛（纯 node / SSR）', () => {
    vi.stubGlobal('uni', undefined);
    expect(detectPlatform()).toBe('browser');
  });
});

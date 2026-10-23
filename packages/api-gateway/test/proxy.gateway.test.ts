import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { CSV_BOM } from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES, createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import type { Socket } from 'socket.io';
// 风控 T7：`clientIp` 取自**连接槽位对象**（allowRequest 在传输层占名额时挂到请求对象上）——
// 测试用同一个附着点布置槽位，与生产取数路径逐字同源。
import { attachWsConnSlot } from '../src/http/rate-limit';

/**
 * ProxyGateway（WS 代理，§6.1 / §5.2 rule 4）。
 *
 * 该文件此前断言的是**没有装饰器的死代码**行为（`client.on('message')`、
 * `ping`/`pong`、`error` 事件）。§6.1/§6.3 明确废除应用层 ping/pong 与
 * `error` 事件，故按新契约重写。
 */

/** 最近一次创建的下游 socket 替身与其连接参数。 */
const peerSockets: Array<Record<string, any>> = [];
const peerConnectCalls: Array<{ url: string; options: Record<string, unknown> }> = [];

vi.mock('socket.io-client', () => {
  const makePeer = (url: string, options: Record<string, unknown>) => {
    peerConnectCalls.push({ url, options });
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const anyHandlers: Array<(event: string, payload: unknown) => void> = [];
    const peer = {
      id: 'peer-1',
      connected: true,
      emitted: [] as Array<[string, unknown]>,
      handlers,
      anyHandlers,
      emit: vi.fn((event: string, data: unknown) => {
        peer.emitted.push([event, data]);
        return true;
      }),
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
        return peer;
      }),
      onAny: vi.fn((fn: (event: string, payload: unknown) => void) => {
        anyHandlers.push(fn);
        return peer;
      }),
      disconnect: vi.fn(),
      trigger: (event: string, ...args: unknown[]) => {
        for (const fn of handlers[event] ?? []) fn(...args);
        for (const fn of anyHandlers) fn(event, args[0]);
      },
    };
    peerSockets.push(peer);
    return peer;
  };
  return { default: vi.fn(makePeer), io: vi.fn(makePeer) };
});

const { ProxyGateway, GATEWAY_UPSTREAM_TIMEOUT_MS } = await import('../src/gateway/proxy.gateway');

/**
 * socket.io `Socket` 的**测试替身**类型：真实 `Socket` + 用例额外挂的三个观测口。
 *
 * ⚠️ 属性**不**在这里改写成 `Mock<…>`（`Socket['on']` 是方法，交叉 `Mock` 后
 * `as SocketDouble` 会因「`on` 缺 Mock 的 15 个成员」被 TS2352 打回）：
 * 于是 `client.on.mock.calls` / `peer.on.mock.calls` 这类**按元组解构 mock 调用**
 * 的写法（TS2769：`any[][]` 收窄不到 `[string]`）在类型闸下不可用。
 * 替代观测口是**已经挂在本类型上**的 `handlers`（就是 `on` 的监听器存放处）与 `emitted`
 * —— 它们与 mock 调用记录是同一份事实，且类型精确。
 */
type SocketDouble = Socket & {
  emitted: Array<[string, unknown]>;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  trigger: (event: string, ...args: unknown[]) => void;
};

function makeClient(
  auth: Record<string, unknown> = { token: 'valid-token' },
  /**
   * `allowRequest` 收到的那份**原始 HTTP 请求**（真实 socket.io 里
   * `socket.request === allowRequest 的 req`，engine.io 的 `Socket.request = req`）。
   * 传输层占到的连接名额就挂在它上面（N15），因此要测「续期 / 释放」必须传同一个对象。
   */
  request: Record<string, unknown> = {},
) {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const client = {
    id: 'client-1',
    data: {},
    handshake: { auth, address: '10.0.0.1' },
    request,
    /**
     * engine.io 的底层连接：`heartbeat` 事件由它发出（`pingInterval: 30000`）。
     *
     * ⚠️ `on` 的**形参类型要显式写**（不能用裸 `vi.fn()`）：裸 `vi.fn()` 是
     * `Mock<Procedure>`，`on.mock.calls` 会被推成 `any[][]`，于是下面
     * `on.mock.calls.find(([event]: [string]) => …)` 的元组解构过不了类型闸（TS2769）。
     * 写成真实签名 `(event: string, listener: (...args: unknown[]) => void) => void` 后，
     * `mock.calls` 就是 `[string, (...args: unknown[]) => void][]`，解构与 `.map` 都精确（TS2345/TS2769 一并消掉）。
     */
    conn: { on: vi.fn((_event: string, _listener: (...args: unknown[]) => void): void => {}) },
    /** socket.io 的真实字段：`handleConnection` 在 await 之后会再确认一次。 */
    connected: true,
    emitted: [] as Array<[string, unknown]>,
    emit: vi.fn((event: string, data: unknown) => {
      client.emitted.push([event, data]);
      return true;
    }),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(fn);
      return client;
    }),
    disconnect: vi.fn(),
    handlers,
    trigger: (event: string, ...args: unknown[]) => {
      for (const fn of handlers[event] ?? []) fn(...args);
    },
  };
  /**
   * ⚠️ 替身故意只实现子集（socket.io 的 `Socket` 有 70+ 个成员，这里只有用例真正用到的那些：
   * `id`/`data`/`handshake`/`request`/`conn`/`connected`/`emit`/`on`/`disconnect`），
   * 无法结构性满足 `Socket<…>` 的类形状（TS2345 原文：`is missing the following properties
   * from type 'Socket<…>': nsp, client, recovered, pid, and 62 more`）。
   * 断言转换只收在**这一处**（26 个调用点因此全部通过），与 `makeSocket` 在
   * `room-service/test/ws.gateway.test.ts` 的写法逐字同族。
   */
  return client as unknown as SocketDouble;
}

/** 手动放行的 Promise：用来把 `await session.isActive()` 这个让出点**稳定**挂住。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ProxyGateway (WS proxy)', () => {
  let gateway: InstanceType<typeof ProxyGateway>;
  let jwt: { verify: ReturnType<typeof vi.fn> };
  let session: { isActive: ReturnType<typeof vi.fn> };
  /** R141：限流存储替身（与 HTTP 侧**共用同一个** `REDIS` provider）。 */
  let redis: {
    zremrangebyscore: ReturnType<typeof vi.fn>;
    zcard: ReturnType<typeof vi.fn>;
    zadd: ReturnType<typeof vi.fn>;
    zrem: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    /** 风控 T7：封禁旗读（`EXISTS risk:banned:{userId}`）。 */
    exists: ReturnType<typeof vi.fn>;
    /** 设备绑定片：绑定键读（`GET risk:binding:{userId}`）。 */
    get: ReturnType<typeof vi.fn>;
  };

  /** §5.1 的正常 access 载荷（R24 的 typ + 白名单查询用的 jti）。 */
  const accessPayload = (over: Record<string, unknown> = {}) => ({
    sub: 'user-1',
    phone: '13800138000',
    typ: 'access',
    jti: 'jti-1',
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    peerSockets.length = 0;
    peerConnectCalls.length = 0;
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-secret';
    jwt = { verify: vi.fn().mockReturnValue(accessPayload()) };
    session = { isActive: vi.fn(async () => true) };
    redis = {
      zremrangebyscore: vi.fn(async () => 0),
      zcard: vi.fn(async () => 0),
      zadd: vi.fn(async () => 1),
      zrem: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      exists: vi.fn(async () => 0), // 默认：封禁旗不在（既有用例全数不受影响）
      // 设备绑定片：默认无绑定键（既有用例不带 deviceId ⇒ 本桩根本不会被调到）。
      get: vi.fn(async () => null),
    };
    // 客户端接入片 T6：第 4 参 = 端闸假体（本文件用例均不带 `auth.clientPlatform`
    // ⇒ 闸不会被咨询；放行桩满足构造即可，⛔ 不为其拉真 ConfigCacheService）。
    gateway = new ProxyGateway(jwt as never, session as never, redis as never, {
      allows: () => true,
    } as never);
  });

  /**
   * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原，
   * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到日志）。
   * 还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
   */
  afterEach(() => {
    Logger.overrideLogger(new Logger());
  });

  it('injects the verified identity into the downstream handshake auth (§5.2 rule 4)', async () => {
    const client = makeClient();
    await gateway.handleConnection(client);

    const call = peerConnectCalls.at(-1)!;
    expect(call.url).toContain('/ws/ddz');
    expect(call.options.auth).toMatchObject({
      userId: 'user-1',
      internalToken: 'internal-secret',
    });
    expect(typeof (call.options.auth as { traceId?: string }).traceId).toBe('string');
    expect(gateway['peerSockets'].get('client-1')).toBeDefined();
  });

  /**
   * 复核⑦（spec §3 载体③）：traceId 的**生成点在 `handleConnection` 开头**。
   *
   * 此前生成点在「建下游连接」处（比 `Client connected` 那行**更晚**）⇒ 那行拿不到 id
   * ⇒「网关 `Client connected` 行与下游 `auth.traceId` 是同一个 id」（判据 6′ 的网关侧一半）
   * 无从成立。本用例把两件事**钉成一个等式**：先证明生成点在最前（那行有 id），
   * 再证明下游拿到的是**同一个**（不是各生成各的）。
   *
   * 观测口：Nest 的全局 logger 是**进程级**的 —— `Logger.overrideLogger` 装一个捕获 sink，
   * 网关自己 `new Logger(...)` 打的行就全部进来（不需要真去抓 stdout）。
   */
  it('复核⑦：handleConnection 开头生成 traceId，且下游 auth 用的是**同一个**', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));

    const client = makeClient();
    await gateway.handleConnection(client);

    const connected = records.find((r) => r.msg.startsWith('Client connected'));
    expect(connected, '生成点必须在 `Client connected` 之前（否则这行没有 id 可带）').toBeDefined();
    expect(connected!.traceId).not.toBeNull();
    const auth = peerConnectCalls.at(-1)!.options.auth as { traceId: string };
    expect(auth.traceId).toBe(connected!.traceId);
  });

  /**
   * **判据 12③（WS 孪生，最终评审 I3）**：握手 `auth: { token, userId: 'victim' }` ⇒
   * ① 下游 `auth.userId` 与 ② 网关侧日志的 `userId` 都必须等于**令牌里的 `sub`**，
   * 不得是 `victim`。
   *
   * 为什么必须有：判据 12①② 只锁 HTTP ⇒ 不补这一条，读的人会把「身份面都锁住了」当真
   * （而 WS 侧的日志归属此前**根本没有值** —— 网关侧 WS 的行一律 `userId: null`）。
   * `auth.userId` 是**客户端可控**的载荷字段 —— 与 HTTP 侧 `X-User-Id` 同一类。
   */
  it('判据 12③：握手 auth.userId=victim ⇒ 下游 auth 与网关日志的 userId 都是令牌的 sub', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));

    const client = makeClient({ token: 'valid-token', userId: 'victim' });
    await gateway.handleConnection(client);

    // ① 下游握手 auth：身份只来自验签后的 sub（§5.2 rule 4）
    const auth = peerConnectCalls.at(-1)!.options.auth as { userId: string };
    expect(auth.userId).toBe('user-1');

    // ② 网关侧的日志归属（这正是 I3 补上的那一格：此前是 null）
    const connected = records.find((r) => r.msg.startsWith('Client connected'));
    expect(connected, '`Client connected` 必须在（否则本条空转）').toBeDefined();
    expect(connected!.userId).toBe('user-1');
    expect(connected!.userId).not.toBe('victim');
    expect(connected!.source).toBe('edge');
  });

  /**
   * **判据 14（最终评审 I2）**：网关的 `Client disconnected` 原先起于 `runWithTrace`
   * **之外** ⇒ `source: 'bootstrap'`（「启动早期」= 假话；复核⑫ 记的就是当时的这个形态）。
   * I2 把断开回调自己包了一层（连接级 id 就在闭包里）⇒ 那行现在**带**该连接的 id、
   * `source: 'edge'`。与判据 6′ 的「两侧同一个 id」共用同一份 id 来源。
   */
  it('判据 14：断线的 `Client disconnected` 标 edge 且带**该连接**的 id', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));

    const client = makeClient();
    await gateway.handleConnection(client);
    const traceId = records.find((r) => r.msg.startsWith('Client connected'))!.traceId;

    client.trigger('disconnect');

    const line = records.find((r) => r.msg.startsWith('Client disconnected'));
    expect(line, '`Client disconnected` 必须在（否则本条空转）').toBeDefined();
    expect(line!.source).not.toBe('bootstrap');
    expect(line!.source).toBe('edge');
    expect(line!.traceId).toBe(traceId);
  });

  it('rejects a handshake without a token and never connects downstream', async () => {
    const client = makeClient({});
    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(gateway['peerSockets'].size).toBe(0);
  });

  it('rejects a handshake whose token fails verification', async () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('jwt expired');
    });
    const client = makeClient();
    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(gateway['peerSockets'].size).toBe(0);
  });

  /**
   * Critical：握手是网关的**第二个鉴权入口**，必须与 HTTP 中间件做同一套
   * R24（`typ`）与 R26（`session:{jti}`）校验。R28 的边界只覆盖「已建立的连接
   * 不因登出而断开」，不覆盖新握手。
   */
  describe('握手鉴权（R24 / R26）', () => {
    const lastError = (client: ReturnType<typeof makeClient>) =>
      client.emitted.filter(([type]) => type === 'system.error').at(-1)?.[1] as
        | { version: number; payload: { code: number; message: string } }
        | undefined;

    it('接受合法 access token，并按 jti 查白名单', async () => {
      const client = makeClient();
      await gateway.handleConnection(client);

      expect(session.isActive).toHaveBeenCalledWith('jti-1');
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway['peerSockets'].get('client-1')).toBeDefined();
    });

    it('拒绝 refresh token 握手（R24）：10005，且不建下游连接', async () => {
      jwt.verify.mockReturnValue(accessPayload({ typ: 'refresh', jti: 'jti-r' }));
      const client = makeClient();
      await gateway.handleConnection(client);

      expect(lastError(client)?.payload.code).toBe(10005);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(gateway['peerSockets'].size).toBe(0);
      // typ 不对就不该查白名单（refresh 的 jti 也在白名单里）
      expect(session.isActive).not.toHaveBeenCalled();
    });

    it('拒绝已登出（jti 不在白名单）的 access token 握手（R26）：10004', async () => {
      session.isActive.mockResolvedValue(false);
      const client = makeClient();
      await gateway.handleConnection(client);

      expect(session.isActive).toHaveBeenCalledWith('jti-1');
      expect(lastError(client)?.payload.code).toBe(10004);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(gateway['peerSockets'].size).toBe(0);
    });

    it('Redis 故障时拒绝握手（10007），不得放行', async () => {
      session.isActive.mockRejectedValue(new Error('redis down'));
      const client = makeClient();
      await gateway.handleConnection(client);

      expect(lastError(client)?.payload.code).toBe(10007);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(gateway['peerSockets'].size).toBe(0);
    });

    it('没有 jti 的 access token 也拒绝（无处查白名单）', async () => {
      jwt.verify.mockReturnValue({ sub: 'user-1', phone: '13800138000', typ: 'access' });
      const client = makeClient();
      await gateway.handleConnection(client);

      expect(lastError(client)?.payload.code).toBe(10005);
      expect(gateway['peerSockets'].size).toBe(0);
    });
  });

  /**
   * 风控 T7（规格 §2.7-2② / C10）：**握手封禁读旗** —— 在 session 校验**通过后**
   * `EXISTS risk:banned:{userId}`（顺序写死：旗读在 session 之后）；命中 ⇒ 走既有
   * `rejectHandshake` 面（`disconnect(true)` + 尽力 `system.error` **11003**；
   * 权威信号 = 断开本身）；旗读**单独 try/catch ⇒ 按无旗 + error 日志**（R11/F8：
   * 旗只是附加准入信息，其读取故障不得改变上面的 10007 fail-closed 语义）。
   */
  describe('风控 T7：握手封禁读旗（§2.7-2②：旗在 ⇒ 断开 + 11003；旗读故障 ⇒ 放行）', () => {
    const lastError = (client: ReturnType<typeof makeClient>) =>
      client.emitted.filter(([type]) => type === 'system.error').at(-1)?.[1] as
        | { version: number; payload: { code: number; message: string } }
        | undefined;

    it('旗在 ⇒ rejectHandshake：system.error 11003 + disconnect(true)，不建下游连接', async () => {
      redis.exists.mockResolvedValue(1);
      const client = makeClient();
      await gateway.handleConnection(client);

      expect(redis.exists).toHaveBeenCalledWith('risk:banned:user-1');
      expect(lastError(client)?.payload.code).toBe(11003);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(gateway['peerSockets'].size).toBe(0);
      expect(peerConnectCalls).toHaveLength(0);
    });

    it('旗无 ⇒ 正常放行（负对照：同一读点返回 0 不拦）', async () => {
      const client = makeClient();
      await gateway.handleConnection(client);

      expect(redis.exists).toHaveBeenCalledWith('risk:banned:user-1');
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway['peerSockets'].get('client-1')).toBeDefined();
    });

    it('顺序敏感：session 校验**通过前**不读旗（未过白名单 ⇒ 10004，且零旗读）', async () => {
      session.isActive.mockResolvedValue(false);
      const client = makeClient();
      await gateway.handleConnection(client);

      expect(redis.exists).not.toHaveBeenCalled();
      expect(lastError(client)?.payload.code).toBe(10004);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('🔴 旗读故障（单独 catch）⇒ **按无旗放行** + error 日志，不得 10007/断连（R11/F8）', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));
      redis.exists.mockRejectedValue(new Error('redis down'));
      const client = makeClient();
      await gateway.handleConnection(client);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway['peerSockets'].get('client-1')).toBeDefined();
      const errs = records.filter((r) => r.level === 'error');
      expect(errs.some((r) => r.msg.includes('risk:banned'))).toBe(true);
    });
  });

  /**
   * 设备绑定片：**握手绑定闸** —— 封禁旗之后 `GET risk:binding:{userId}`。
   * 键在且≠本机 ⇒ 11005 拒连（REST 登录闸的 WS 同态，堵好友房直连绕过）；
   * 键缺/同设备/无 deviceId/不合形/Redis 故障 ⇒ fail-open 放行（不锁死旧端）。
   */
  describe('设备绑定片：握手绑定读键（键在且不符 ⇒ 断开 + 11005；其余形态放行）', () => {
    const DEVICE_A = 'dev-device-aaaa1111';
    const DEVICE_B = 'dev-device-bbbb2222';
    const lastError = (client: ReturnType<typeof makeClient>) =>
      client.emitted.filter(([type]) => type === 'system.error').at(-1)?.[1] as
        | { version: number; payload: { code: number; message: string } }
        | undefined;

    it('无 deviceId（旧端）⇒ 不读绑定键，直接放行', async () => {
      const client = makeClient(); // 只有 token
      await gateway.handleConnection(client);

      expect(redis.get).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway['peerSockets'].get('client-1')).toBeDefined();
    });

    it('deviceId 不合形（过短/错字符）⇒ 不读键放行（fail-open，与 REST DTO 拒收≠拦截）', async () => {
      const client = makeClient({ token: 'valid-token', deviceId: 'abc' });
      await gateway.handleConnection(client);

      expect(redis.get).not.toHaveBeenCalled();
      expect(gateway['peerSockets'].get('client-1')).toBeDefined();
    });

    it('有 deviceId + 键缺（开关关/未绑/已解绑）⇒ 读键后放行', async () => {
      const client = makeClient({ token: 'valid-token', deviceId: DEVICE_A });
      await gateway.handleConnection(client);

      expect(redis.get).toHaveBeenCalledWith('risk:binding:user-1');
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway['peerSockets'].get('client-1')).toBeDefined();
    });

    it('键在且 = 本机 ⇒ 放行（同设备重连热路径）', async () => {
      redis.get.mockResolvedValue(DEVICE_A);
      const client = makeClient({ token: 'valid-token', deviceId: DEVICE_A });
      await gateway.handleConnection(client);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway['peerSockets'].get('client-1')).toBeDefined();
    });

    it('🔴 键在且 ≠ 本机（第二台设备）⇒ 11005 拒连 + disconnect(true)，不建下游', async () => {
      redis.get.mockResolvedValue(DEVICE_B);
      const client = makeClient({ token: 'valid-token', deviceId: DEVICE_A });
      await gateway.handleConnection(client);

      expect(redis.get).toHaveBeenCalledWith('risk:binding:user-1');
      expect(lastError(client)?.payload.code).toBe(11005);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(gateway['peerSockets'].size).toBe(0);
      expect(peerConnectCalls).toHaveLength(0);
    });

    it('顺序敏感：封禁旗命中 ⇒ 11003 且不读绑定键', async () => {
      redis.exists.mockResolvedValue(1);
      const client = makeClient({ token: 'valid-token', deviceId: DEVICE_A });
      await gateway.handleConnection(client);

      expect(redis.get).not.toHaveBeenCalled();
      expect(lastError(client)?.payload.code).toBe(11003);
    });

    it('🔴 绑定键读故障 ⇒ 按无绑定放行 + error 日志（业务级防共享不做 fail-closed）', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));
      redis.get.mockRejectedValue(new Error('redis down'));
      const client = makeClient({ token: 'valid-token', deviceId: DEVICE_A });
      await gateway.handleConnection(client);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway['peerSockets'].get('client-1')).toBeDefined();
      const errs = records.filter((r) => r.level === 'error');
      expect(errs.some((r) => r.msg.includes('risk:binding:user-1'))).toBe(true);
    });
  });

  /**
   * 风控 T7（规格 §2.9-1 / C12 网关侧）：下游握手 `auth` 增 **`clientIp`** —— 取连接
   * **槽位对象**的 ip（`wsConnSlotOf(client.request)?.ip`；与名额释放/心跳续期同一处取，
   * **不在转发侧从 handshake 重新推导**）；`'unknown'`/缺失 ⇒ **不注入该键**
   *（下游 room 侧（T3）再按 `string ≤64 且 ≠'unknown'` 复检后写 `socket.data.clientIp`）。
   */
  describe('风控 T7：clientIp 注入（§2.9-1）', () => {
    it('槽位有 ip ⇒ auth.clientIp = **槽位 ip**（不是 handshake.address 的重新推导值）', async () => {
      // slot.ip 与 handshake.address（makeClient 默认 '10.0.0.1'）**刻意不同**：
      // 若实现从 handshake 重新推导，本断言必红。
      const request: Record<string, unknown> = {};
      attachWsConnSlot(request, { ip: '203.0.113.7', member: 'slot-1' });
      const client = makeClient({ token: 'valid-token' }, request);
      await gateway.handleConnection(client);

      const auth = peerConnectCalls.at(-1)!.options.auth as { clientIp?: string };
      expect(auth.clientIp).toBe('203.0.113.7');
      expect(auth.clientIp).not.toBe('10.0.0.1');
    });

    it("槽位 ip = `'unknown'` ⇒ **不注入** clientIp 键（缺省 = 不写该字段）", async () => {
      const request: Record<string, unknown> = {};
      attachWsConnSlot(request, { ip: 'unknown', member: 'slot-2' });
      const client = makeClient({ token: 'valid-token' }, request);
      await gateway.handleConnection(client);

      const auth = peerConnectCalls.at(-1)!.options.auth as Record<string, unknown>;
      expect('clientIp' in auth).toBe(false);
    });

    it('无槽位（单测直调 / allowRequest 未过）⇒ 不注入 clientIp 键', async () => {
      const client = makeClient();
      await gateway.handleConnection(client);

      const auth = peerConnectCalls.at(-1)!.options.auth as Record<string, unknown>;
      expect('clientIp' in auth).toBe(false);
      // 正对照：其余 auth 键不受影响（identity 注入仍在）
      expect(auth.userId).toBe('user-1');
    });
  });

  /**
   * N1：`handleConnection` 是 async 的（要 await 白名单查询），因此它有一个让出点。
   * 客户端的转发监听与断线清理必须在这个让出点**之前**（同步段）就注册好：
   *  - 否则窗口内到达的 C→S 消息没有任何监听器 → socket.io 静默丢弃；
   *  - 否则窗口内断开的客户端会在 `await` 之后被建出一条孤儿下游连接。
   *
   * 下面用「手动放行的 Promise」把让出点稳定挂住，不靠 sleep 抢时序。
   */
  describe('N1：async 握手的让出点（监听注册 / 断线竞态）', () => {
    it('N1(a)：验签未决时到达的 C→S 消息被排队，下游连上后冲刷（不丢、不静默）', async () => {
      const gate = deferred<boolean>();
      session.isActive.mockReturnValue(gate.promise);

      const client = makeClient();
      const connecting = gateway.handleConnection(client); // 悬挂在 await session.isActive()

      // 同步段必须已经注册好转发监听（旧实现这里什么都不认，消息被丢）
      expect(client.handlers['room.match']).toBeDefined();

      const ack = vi.fn();
      client.trigger(
        'room.match',
        { reqId: 'r-early', baseVersion: 0, timestamp: Date.now(), payload: { mode: 'random' } },
        ack,
      );

      // 没有丢：进了既有队列（复用 pendingOutbound，不是另造的缓冲）
      expect(gateway['pendingOutbound'].get('client-1')).toHaveLength(1);
      expect(gateway['pendingCallbacks'].get('client-1:0')).toBe(ack);

      gate.resolve(true);
      await connecting;

      const peer = peerSockets.at(-1)!;
      peer.trigger('connect'); // 下游连上 → flushPending
      expect(peer.emit).toHaveBeenCalledWith(
        'room.match',
        expect.objectContaining({ reqId: 'r-early', __ackId: expect.any(String) }),
      );
      expect(gateway['pendingOutbound'].has('client-1')).toBe(false);
    });

    it('N1(b)：验签未决时客户端断开 → 不创建下游连接，也不留残留', async () => {
      const gate = deferred<boolean>();
      session.isActive.mockReturnValue(gate.promise);

      const client = makeClient();
      const connecting = gateway.handleConnection(client);

      client.connected = false;
      client.trigger('disconnect');

      gate.resolve(true);
      await connecting;

      expect(peerConnectCalls).toHaveLength(0); // 没有 io()：不为已关闭的 socket 建下游连接
      expect(peerSockets).toHaveLength(0);
      expect(gateway['peerSockets'].size).toBe(0);
      expect(gateway['pendingOutbound'].has('client-1')).toBe(false);
    });

    it('N1(b 变体)：只看到 client.connected=false（清理由 handleDisconnect 兜底）也不建下游连接', async () => {
      const gate = deferred<boolean>();
      session.isActive.mockReturnValue(gate.promise);

      const client = makeClient();
      const connecting = gateway.handleConnection(client);

      // 不触发我们注册的 disconnect 监听 —— 模拟「清理从另一个钩子（handleDisconnect）来」
      client.connected = false;

      gate.resolve(true);
      await connecting;

      expect(peerConnectCalls).toHaveLength(0);
      expect(gateway['peerSockets'].size).toBe(0);
    });
  });

  /**
   * R141（S6）+ **N15/R246**：§5.4 的**单 IP 并发连接 5**。
   *
   * ⚠️ **判据形态在本片变了**（旧形态见汇报「必须改形态的既有断言」）：
   * 检查点从「握手**之后** `rejectHandshake(10006)`」挪到 **engine.io 的 `allowRequest`**
   * （传输层），因此这里的入口是 `checkAllowRequest(req, cb)` 而**不是** `handleConnection`。
   * 旧用例钉的三件事（第 6 条被拒 / 存储故障拒 / 名额按 IP 记账与释放）一条没少，
   * 只是换了入口；`system.error{10006}` 这条**必须消失**（见下面最后一条结构判据）。
   */
  describe('R141/N15：单 IP 并发 WS 连接 5（§5.4）—— 检查点在 engine.io 的 allowRequest', () => {
    /** `allowRequest` 拿到的是**原始 HTTP 请求**（不是 socket.io 的 Socket）。 */
    const httpReq = (ip: string | undefined = '10.0.0.1') => ({ socket: { remoteAddress: ip } });

    /** 驱动 `checkAllowRequest`（engine.io 真正会调的那一处），并数回调次数。 */
    const allowRequest = async (
      req: unknown,
    ): Promise<{ calls: number; err: string | null | undefined; ok: boolean | undefined }> => {
      let calls = 0;
      let err: string | null | undefined;
      let ok: boolean | undefined;
      await new Promise<void>((resolve) => {
        void gateway['checkAllowRequest'](req, (e: string | null | undefined, success: boolean) => {
          calls += 1;
          err = e;
          ok = success;
          resolve();
        });
      });
      // 静默窗（R115/切片 7 教训②）：`allowRequest` 若多回调一次，这里必须看得见
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { calls, err, ok };
    };

    it('R141: 第 6 条（ZCARD 已满）⇒ 传输层拒绝，且**不记账**、不建下游连接', async () => {
      redis.zcard.mockResolvedValueOnce(5);
      const result = await allowRequest(httpReq());

      expect(result.ok).toBe(false);
      expect(result.err).toEqual(expect.any(String));
      // 超限的连接**不得**占名额（否则被拒的人会持续抬高计数）
      expect(redis.zadd).not.toHaveBeenCalled();
      expect(peerConnectCalls).toHaveLength(0); // 传输层就拒了，根本不存在下游连接
    });

    /**
     * **判据 14（最终评审 I2）**：传输层的拒握手原先落在任何 ALS 之外 ⇒
     * `source: 'bootstrap'`（「启动早期」= 假话）。此刻**还没有 socket**（握手未完成）
     * ⇒ 拿不到连接级 id：`traceId: null` 是**如实**的降级，但 `source` 必须标 `edge`
     * （那确实是一次**边缘**连接尝试）。
     */
    it('判据 14：传输层拒握手标 edge + traceId null（不落成 bootstrap）', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));

      redis.zcard.mockResolvedValueOnce(5);
      await allowRequest(httpReq());

      const line = records.find((r) => r.msg.startsWith('Rejecting WS handshake'));
      expect(line, '`Rejecting WS handshake` 必须在（否则本条空转）').toBeDefined();
      expect(line!.source).not.toBe('bootstrap');
      expect(line!.source).toBe('edge');
      expect(line!.traceId).toBeNull();
    });

    it('R141: 限流存储故障 ⇒ 拒绝握手（fail closed），不得放行', async () => {
      redis.zcard.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const result = await allowRequest(httpReq());

      expect(result.ok).toBe(false);
      expect(result.err).toEqual(expect.any(String));
      expect(peerConnectCalls).toHaveLength(0);
    });

    it('R141/N15：`allowRequest` **恰好**回调一次（成功 / 超限 / 存储故障三条路径）', async () => {
      // 成功路径
      expect((await allowRequest(httpReq())).calls).toBe(1);
      // 超限路径
      redis.zcard.mockResolvedValueOnce(5);
      expect((await allowRequest(httpReq())).calls).toBe(1);
      // 存储故障路径（throw 之后也必须回调 —— 不回调会让连接永久挂着）
      redis.zcard.mockRejectedValueOnce(new Error('redis down'));
      expect((await allowRequest(httpReq())).calls).toBe(1);
    });

    it('R141: 名额按 **IP** 计，member 是传输层 nonce（验收：ZADD 的键/成员与 EXPIRE 60）', async () => {
      await allowRequest(httpReq());

      expect(redis.zcard).toHaveBeenCalledWith('ratelimit:ws-conn:10.0.0.1');
      expect(redis.zadd).toHaveBeenCalledWith(
        'ratelimit:ws-conn:10.0.0.1',
        expect.any(Number),
        expect.any(String),
      );
      expect(redis.expire).toHaveBeenCalledWith('ratelimit:ws-conn:10.0.0.1', 60);
      // ⚠️ member **不得**是 socket.id：`allowRequest` 时握手还没完成，根本没有 socket.id。
      // 每次握手一个 nonce 是唯一能保证「释放时 ZREM 掉的正是自己那一条」的形态。
      const member = redis.zadd.mock.calls.at(-1)![2];
      expect(member).not.toBe('client-1');
      expect(typeof member).toBe('string');
      expect(member.length).toBeGreaterThan(0);
    });

    it('R141: `req.socket.remoteAddress` 缺失时不崩（降级为单一 `unknown` 桶，仍然计数）', async () => {
      await allowRequest({});

      expect(redis.zadd).toHaveBeenCalledWith(
        'ratelimit:ws-conn:unknown',
        expect.any(Number),
        expect.any(String),
      );
    });

    it('R141/N15: disconnect 释放**同一个**名额（ZREM 的 member 就是 ZADD 那个）', async () => {
      const req = httpReq();
      await allowRequest(req);
      const member = redis.zadd.mock.calls.at(-1)![2];

      const client = makeClient({ token: 'valid-token' }, req);
      await gateway.handleConnection(client);
      client.trigger('disconnect');

      expect(redis.zrem).toHaveBeenCalledWith('ratelimit:ws-conn:10.0.0.1', member);
    });

    it('R141: engine.io 的 heartbeat 续期 TTL（长连接不被 TTL 兜底误删）', async () => {
      const req = httpReq();
      await allowRequest(req);
      const client = makeClient({ token: 'valid-token' }, req);
      await gateway.handleConnection(client);

      // `conn.on` 是**真实** socket.io 类型（engine.io 底层连接），不带 mock 类型
      // ⇒ 读它的调用记录要先收窄成 mock 形状。断言只在这个局部、只此两处，
      // 理由见 `SocketDouble` 的类型注释。
      const connOn = client.conn.on as unknown as {
        mock: { calls: Array<[string, (...args: unknown[]) => void]> };
      };
      const heartbeat = connOn.mock.calls.find(([event]) => event === 'heartbeat')?.[1];
      expect(heartbeat).toBeTypeOf('function');

      redis.expire.mockClear();
      heartbeat!();
      expect(redis.expire).toHaveBeenCalledWith('ratelimit:ws-conn:10.0.0.1', 60);
    });

    it('正对照：没有名额的连接（绕过 allowRequest）不注册续期 —— 「有名额才续期」不是恒真', async () => {
      const client = makeClient();
      await gateway.handleConnection(client);

      // `conn.on` 是**真实** socket.io 类型（engine.io 底层连接的签名），不带 mock 类型
      // ⇒ 要看调用记录得先把它收窄成 mock 的形状（断言只在这个局部、两次，理由见 `SocketDouble` 注释）。
      const onMock = client.conn.on as unknown as { mock: { calls: unknown[][] } };
      expect(onMock.mock.calls.some(([event]) => event === 'heartbeat')).toBe(false);
    });

    it('结构判据（N15）：限额判定**只有一处** —— `handleConnection` 不再做限额判定，也不再有 `system.error{10006}`', async () => {
      // 旧实现：握手之后 `rejectHandshake(RATE_LIMITED)` ⇒ 客户端先 connect 再收 system.error。
      // 现在 `handleConnection` 里**没有**限额判定（只有 `allowRequest` 有），因此即使
      // ZCARD 已满，直接调 handleConnection 也**不得**发出 10006 —— 这一条钉住「旧检查已删除」。
      redis.zcard.mockResolvedValue(5);
      const client = makeClient();
      await gateway.handleConnection(client);

      const rateLimited = client.emitted.filter(
        ([type, payload]) =>
          type === 'system.error' &&
          (payload as { payload?: { code?: number } })?.payload?.code === 10006,
      );
      expect(rateLimited).toEqual([]);
      expect(client.disconnect).not.toHaveBeenCalledWith(true);
    });
  });

  it('subscribes only to contract event names in both directions', async () => {
    const client = makeClient();
    await gateway.handleConnection(client);
    const peer = peerSockets.at(-1)!;

    // 观测口用 `handlers`（`on` 的监听器存放处），而不是 `client.on.mock.calls`：
    // 后者在 `SocketDouble` 上是真实 `Socket['on']` 的方法签名，`any[][]` 解构过不了类型闸（见类型注释）。
    // 两者是同一份事实 —— `on` 的实现就是 `(handlers[event] ??= []).push(fn)`。
    const clientEvents = Object.keys(client.handlers);
    const peerEvents = Object.keys(peer.handlers);

    expect(clientEvents).toContain('room.match');
    expect(clientEvents).toContain('game.play');
    expect(clientEvents).not.toContain('ping');
    expect(clientEvents).not.toContain('message');
    expect(clientEvents).not.toContain('game.match.quick');

    expect(peerEvents).toContain('room.matched');
    expect(peerEvents).toContain('game.deal');
    expect(peerEvents).not.toContain('pong');
    expect(peerEvents).not.toContain('game.match_found');
    expect(peerEvents).not.toContain('error');
  });

  it('forwards a client message to the downstream socket', async () => {
    const client = makeClient();
    await gateway.handleConnection(client);
    const peer = peerSockets.at(-1)!;

    client.trigger('room.match', {
      reqId: 'r',
      baseVersion: 0,
      timestamp: Date.now(),
      payload: { mode: 'random' },
    });

    expect(peer.emit).toHaveBeenCalledWith(
      'room.match',
      expect.objectContaining({ payload: { mode: 'random' } }),
    );
  });

  it('forwards the whole flat request body, not just the payload (§6.2)', async () => {
    const client = makeClient();
    await gateway.handleConnection(client);
    const peer = peerSockets.at(-1)!;

    // §6.2 的线格式：type 由事件名承载，其余字段平铺
    const body = { reqId: 'req-9', baseVersion: 3, timestamp: 1700000000000, payload: { mode: 'random' } };
    client.trigger('room.match', body, vi.fn());

    const [, forwarded] = peer.emit.mock.calls.at(-1)!;
    expect(forwarded).toMatchObject({
      reqId: 'req-9',
      baseVersion: 3,
      timestamp: 1700000000000,
      payload: { mode: 'random' },
    });
  });

  it('queues client requests until the downstream socket is connected', async () => {
    const client = makeClient();
    await gateway.handleConnection(client);
    const peer = peerSockets.at(-1)!;
    // 模拟握手尚未完成
    peer.connected = false;

    const ack = vi.fn();
    client.trigger('room.match', { reqId: 'r', baseVersion: 0, timestamp: Date.now(), payload: {} }, ack);

    // 还没有发出，但也没有丢掉
    expect(peer.emit).not.toHaveBeenCalledWith('room.match', expect.anything());
    expect(gateway['pendingOutbound'].get('client-1')).toHaveLength(1);

    // 下游连上后按顺序冲刷，并带上关联 id
    peer.connected = true;
    peer.trigger('connect');
    expect(peer.emit).toHaveBeenCalledWith('room.match', expect.objectContaining({ __ackId: expect.any(String) }));
  });

  it('relays an ack from the downstream socket back to the client', async () => {
    const client = makeClient();
    await gateway.handleConnection(client);
    const peer = peerSockets.at(-1)!;

    const ack = vi.fn();
    client.trigger('room.match', { reqId: 'r', baseVersion: 0, timestamp: Date.now(), payload: { mode: 'random' } }, ack);
    const [, forwarded] = peer.emit.mock.calls.at(-1)!;
    const correlationId = (forwarded as Record<string, unknown>).__ackId as string;
    expect(correlationId).toBeTruthy();

    // 下游把 ack 以**事件名 = correlation id** 回发（socket.io 的 ack 回调
    // 会被 socket.io-client 消费掉，代理看不见，只能用命名事件运回来）
    peer.trigger(correlationId, { code: 0, data: { ok: true } });
    expect(ack).toHaveBeenCalledWith({ code: 0, data: { ok: true } });
    expect(gateway['pendingAcks'].size).toBe(0);
  });

  it('forwards a valid downstream push to the client', async () => {
    const client = makeClient();
    await gateway.handleConnection(client);
    const peer = peerSockets.at(-1)!;

    peer.trigger('room.matched', { version: 0, payload: { roomCode: 'ROOM1', seat: 1 } });

    expect(client.emit).toHaveBeenCalledWith('room.matched', {
      version: 0,
      payload: { roomCode: 'ROOM1', seat: 1 },
    });
  });

  it('blocks a downstream push that violates the contract (S→C leak guard)', async () => {
    const client = makeClient();
    await gateway.handleConnection(client);
    const peer = peerSockets.at(-1)!;

    // 含有永不出站字段的消息不得到达客户端
    peer.trigger('game.state_update', {
      version: 3,
      payload: { roomCode: 'ROOM1', actionLog: [{ seat: 0, cards: [3] }] },
    });

    expect(client.emit).not.toHaveBeenCalledWith('game.state_update', expect.anything());
  });

  /**
   * Task 5.0（spec §4.11）：**pdk 出站放行**。旧 gateway 会把 pdk 消息当非法丢弃；
   * 新 gateway 用同一份 `validateOutbound`（S0 已支持 pdk 联合），本条钉住真实代理路径。
   */
  describe('Task 5.0：跑得快出站放行', () => {
    const pdkView = {
      roomCode: 'PDK1',
      gameType: 'paodekuai',
      playerCount: 3,
      version: 4,
      state: 'playing',
      baseScore: 15,
      seat: 1,
      hand: [{ r: 3, s: 1 }],
      cardCounts: [16, 1, 16],
      trustees: [false, false, false],
      currentPlayer: 1,
      recentActions: [],
      turnDeadlineAt: 1_700_000_000_000,
      canPass: true,
      bombCount: 0,
      pdkRules: { ...DEFAULT_PDK_RULES },
    };

    const pdkSettlement = {
      roomCode: 'PDK1',
      gameType: 'paodekuai',
      playerCount: 3,
      baseScore: 15,
      winnerSeats: [0],
      scoreChanges: [
        { seat: 0, delta: 30 },
        { seat: 1, delta: -30 },
        { seat: 2, delta: 0 },
      ],
      remaining: [0, 5, 3],
      multiplier: 1,
      bombCount: 0,
      guan: false,
      spring: false,
      baobenSeats: [],
    };

    it('game.state_update（pdk 视图）原样放行', async () => {
      const client = makeClient();
      await gateway.handleConnection(client);
      const peer = peerSockets.at(-1)!;

      peer.trigger('game.state_update', { version: 4, payload: pdkView });
      expect(client.emit).toHaveBeenCalledWith('game.state_update', {
        version: 4,
        payload: pdkView,
      });
    });

    it('game.settlement / game.finished / game.balances（pdk）原样放行', async () => {
      const client = makeClient();
      await gateway.handleConnection(client);
      const peer = peerSockets.at(-1)!;

      peer.trigger('game.settlement', { version: 5, payload: pdkSettlement });
      peer.trigger('game.finished', {
        version: 5,
        payload: { gameType: 'paodekuai', winnerSeats: [0] },
      });
      peer.trigger('game.balances', {
        version: 5,
        payload: {
          gameType: 'paodekuai',
          playerCount: 2,
          balances: [
            { seat: 0, balance: 100 },
            { seat: 1, balance: 200 },
          ],
        },
      });

      expect(client.emit).toHaveBeenCalledWith('game.settlement', {
        version: 5,
        payload: pdkSettlement,
      });
      expect(client.emit).toHaveBeenCalledWith('game.finished', {
        version: 5,
        payload: { gameType: 'paodekuai', winnerSeats: [0] },
      });
      expect(client.emit).toHaveBeenCalledWith('game.balances', expect.anything());
    });

    it('负对照：pdk 视图携带 unusedCards/他人手牌泄漏字段 ⇒ 拦截', async () => {
      const client = makeClient();
      await gateway.handleConnection(client);
      const peer = peerSockets.at(-1)!;

      peer.trigger('game.state_update', {
        version: 4,
        payload: { ...pdkView, unusedCards: [{ r: 17, s: 1 }] },
      });
      expect(client.emit).not.toHaveBeenCalledWith('game.state_update', expect.anything());
    });
  });

  it('disconnects the downstream socket and clears pending acks on client disconnect', async () => {
    const client = makeClient();
    await gateway.handleConnection(client);
    const peer = peerSockets.at(-1)!;

    const ack = vi.fn();
    client.trigger('room.match', { reqId: 'r', baseVersion: 0, timestamp: Date.now(), payload: {} }, ack);
    expect(gateway['pendingAcks'].size).toBe(1);

    gateway.handleDisconnect(client);

    expect(peer.disconnect).toHaveBeenCalled();
    expect(gateway['peerSockets'].has('client-1')).toBe(false);
    expect(gateway['pendingAcks'].size).toBe(0);
  });

  describe('HTTP forwarding (§5.2 / R31)', () => {
    const fakeRes = () => {
      const res: any = {};
      res.status = vi.fn(() => res);
      res.json = vi.fn(() => res);
      // ③ T5 修复：CSV 透传分支用 express 的 setHeader/send（JSON 分支语义不动）。
      res.setHeader = vi.fn(() => res);
      res.send = vi.fn(() => res);
      return res;
    };

    /**
     * ③ T5 修复（规格 §2.11「网关透传」条，v1.1.4）：CSV 响应经网关**原样透传** ——
     * `forward()` 按**上游 `Content-Type`**（`text/csv` 前缀）分支：透传 status +
     * `Content-Type` + `Content-Disposition` + 体；**JSON 路径语义逐字不变**。
     * 两侧断言在**同一文件里成对**（防「分支把 JSON 语义改了」）。
     *
     * 分支依据 = 上游 content-type 而不是我们的路由名：下游的错误响应（如 ops.csv 的
     * 400 借 10001「范围过大」）是 **JSON 信封** —— 必须走 JSON 分支，不能被「.csv 路由
     * 一律当 CSV」吞形。
     *
     * ⚠️ **③ T6 联测修复（2026-10-05）**：体必须**按字节**透传 —— 旧实现读 `resp.text()`
     * 走 WHATWG UTF-8 decode，而该算法**剥掉首字节 BOM** ⇒ 导出 CSV 经网关丢掉
     * `EF BB BF`（真栈实测咬中；旧替身把 `text()` 写成直返原文 ⇒ 遮蔽了它）。
     */
    describe('CSV 透传（§2.11 网关透传条，T5 修复 / T6 联测字节化）', () => {
      /** 上游真身发出的字节（含 BOM）——透传判据按**字节**断言。 */
      const CSV_BODY = CSV_BOM + 'ID,配置键\r\n1,room.x\r\n';
      const csvBytes = (s: string): ArrayBuffer => Uint8Array.from(Buffer.from(s, 'utf8')).buffer;

      /**
       * ⚠️ **字节保真替身**（T6 联测教训）：`text` 必须仿 WHATWG 语义 —— UTF-8 decode
       * **剥 BOM**（真实 `Response.text()` 正是这样丢 BOM 的）。
       */
      const csvUpstream = (over: Partial<Response> = {}) =>
        vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
          status: 200,
          headers: new Headers({
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="config-changes-20261005-060000.csv"',
          }),
          arrayBuffer: async () => csvBytes(CSV_BODY),
          text: async () => CSV_BODY.replace(CSV_BOM, ''), // 仿 WHATWG：UTF-8 decode 剥 BOM
          // 判别性：CSV 分支若仍走 json()，这一抛会把它揪出来（不能再静默吞成 null）。
          json: async () => {
            throw new Error('CSV 响应不得走 json()');
          },
          ...over,
        }));

      it('text/csv 上游 ⇒ status / 两枚头 / **字节级**体逐一透传（BOM 首字节 EF BB BF + CRLF 原样）', async () => {
        vi.stubGlobal('fetch', csvUpstream());
        const res = fakeRes();

        await gateway.forwardToConfigSvc('GET', '/api/admin/config/changes.csv', null, res, {});

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
        expect(res.setHeader).toHaveBeenCalledWith(
          'Content-Disposition',
          'attachment; filename="config-changes-20261005-060000.csv"',
        );
        expect(res.json).not.toHaveBeenCalled();
        const sent = res.send.mock.calls[0]![0] as unknown;
        const sentBytes = Buffer.isBuffer(sent) ? sent : Buffer.from(String(sent), 'utf8');
        expect(sentBytes.toString('utf8')).toBe(CSV_BODY); // 逐字（含 BOM 字符）
        expect([sentBytes[0], sentBytes[1], sentBytes[2]]).toEqual([0xef, 0xbb, 0xbf]); // BOM 首字节
      });

      it('错误响应是 JSON 信封（50k 上限的 400）⇒ 仍走 JSON 分支，不被 .csv 路由吞形', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ({
            status: 400,
            headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
            json: async () => ({ code: 10001, message: '范围过大，请收窄时间区间', data: null }),
          })),
        );
        const res = fakeRes();

        await gateway.forwardToCurrencySvc('GET', '/api/admin/wallet/ops.csv', null, res, {});

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ code: 10001, message: '范围过大，请收窄时间区间', data: null });
        expect(res.send).not.toHaveBeenCalled();
      });

      it('JSON 分支回归：application/json 上游 ⇒ status + json(data) 逐字不变（不碰 send/setHeader）', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ({
            status: 200,
            headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
            json: async () => ({ code: 0, data: { ok: true } }),
          })),
        );
        const res = fakeRes();

        await gateway.forwardToUserSvc('GET', '/api/admin/users/u-1', null, res, {});

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ code: 0, data: { ok: true } });
        expect(res.send).not.toHaveBeenCalled();
        expect(res.setHeader).not.toHaveBeenCalled();
      });

      it('CSV 读体失败 ⇒ 失败姿态与 JSON 分支的 `.catch(() => null)` 对齐（null 体 + 上游状态，不伪造 503）', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ({
            status: 200,
            headers: new Headers({ 'content-type': 'text/csv; charset=utf-8' }),
            arrayBuffer: async () => {
              throw new Error('mid-body connection reset');
            },
          })),
        );
        const res = fakeRes();

        await gateway.forwardToConfigSvc('GET', '/api/admin/login-events.csv', null, res, {});

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(null);
        expect(res.send).not.toHaveBeenCalled();
      });
    });

    it('writes X-User-Id / X-Trace-Id and, when present, X-Token-Jti', async () => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => ({
          status: 200,
          headers: new Headers(),
          json: async () => ({ code: 0 }),
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      try {
        const res = fakeRes();
        await gateway.forwardToUserSvc('POST', '/api/auth/logout', { refreshToken: 'r' }, res, {
          userId: 'u1',
          traceId: 't1',
          tokenJti: 'jti-1',
        });

        const first = fetchMock.mock.calls[0]!;
        expect(first[0]).toContain('/api/auth/logout');
        const init = first[1] ?? {};
        expect((init.headers as Record<string, string>)['X-User-Id']).toBe('u1');
        expect((init.headers as Record<string, string>)['X-Trace-Id']).toBe('t1');
        expect((init.headers as Record<string, string>)['X-Token-Jti']).toBe('jti-1');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('does not write X-Token-Jti when the caller did not set it', async () => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => ({
          status: 200,
          headers: new Headers(),
          json: async () => ({ code: 0 }),
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      try {
        await gateway.forwardToUserSvc('POST', '/api/auth/login', {}, fakeRes(), { userId: 'u1' });

        const init = fetchMock.mock.calls[0]![1] ?? {};
        expect((init.headers as Record<string, string>)['X-Token-Jti']).toBeUndefined();
        expect((init.headers as Record<string, string>)['X-User-Id']).toBe('u1');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    /**
     * N7：`headersOf()` 产出的 `internalToken` 必须真的落到**下游请求头**上。
     * 只断言「`headersOf` 的返回值里有这个字段」抓不到「注入了但没发出去」——
     * 那种情况下下游四个服务全部 401，而网关的单测照样绿。
     */
    it('writes X-Internal-Token on every hop (§5.2 rule 3 / N7)', async () => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => ({
          status: 200,
          headers: new Headers(),
          json: async () => ({ code: 0 }),
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const headers = { userId: 'u1', internalToken: 'internal-secret' };
      // R136：robot 那一跳已删除（§4.1 的调用表里没有「gateway → robot」这条边）。
      const hops = [
        () => gateway.forwardToUserSvc('GET', '/api/users/me', null, fakeRes(), headers),
        () => gateway.forwardToRoomSvc('GET', '/api/rooms', null, fakeRes(), headers),
        () => gateway.forwardToGameSvc('GET', '/api/games/ABC123', null, fakeRes(), headers),
      ];

      try {
        for (const hop of hops) {
          fetchMock.mockClear();
          await hop();
          const init = fetchMock.mock.calls[0]![1] ?? {};
          expect((init.headers as Record<string, string>)['X-Internal-Token']).toBe('internal-secret');
        }
      } finally {
        vi.unstubAllGlobals();
      }
    });

    /**
     * P0-3：再认证链的两枚**路径限定**头必须真的落到下游请求上。
     * `headersOf()` 产出了但 `forward()` 不映射 ⇒ user-service 401 / payment-service
     * 永远看不到票据 —— 与本片修复前的断点同形。
     */
    it('P0-3：forward 映射 Authorization 与 X-Reauth-Ticket（未提供则缺席）', async () => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => ({
          status: 200,
          headers: new Headers(),
          json: async () => ({ code: 0 }),
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      try {
        await gateway.forwardToUserSvc('POST', '/api/auth/reauth', { password: 'p' }, fakeRes(), {
          userId: 'u1',
          authorization: 'Bearer access-1',
        });
        let init = fetchMock.mock.calls[0]![1] ?? {};
        expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer access-1');
        expect((init.headers as Record<string, string>)['X-Reauth-Ticket']).toBeUndefined();

        fetchMock.mockClear();
        await gateway.forwardToPaymentSvc(
          'POST',
          '/api/pay/withdrawals',
          { coins: 100 },
          fakeRes(),
          { userId: 'u1', reauthTicket: 't-1' },
        );
        init = fetchMock.mock.calls[0]![1] ?? {};
        expect((init.headers as Record<string, string>)['X-Reauth-Ticket']).toBe('t-1');
        expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    /**
     * R143（A7）：**结构性判据**（与负载无关 —— 切片 7 的通用教训③）：
     * 断言排入的**超时值**，而不是等墙钟。删掉 `signal: AbortSignal.timeout(...)`
     * 这一行 ⇒ 本用例红。
     *
     * `AbortSignal.timeout` 的替身返回真 signal（保持原实现），只记录入参。
     */
    it('R143: 每一跳都排入 5000ms 的下游超时', async () => {
      const captured: Array<number | undefined> = [];
      const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms?: number) => {
        captured.push(ms);
        return new AbortController().signal;
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, headers: new Headers(), json: async () => ({ code: 0 }) })));
      try {
        await gateway.forwardToUserSvc('GET', '/api/users/me', null, fakeRes(), { userId: 'u1' });
        await gateway.forwardToRoomSvc('GET', '/api/rooms', null, fakeRes(), { userId: 'u1' });
        await gateway.forwardToGameSvc('GET', '/api/games/ABC123', null, fakeRes(), { userId: 'u1' });

        // 三跳**每一跳**都排入超时，且值逐字是 §4.3 的上界（网关不得抢下游的契约错误）。
        expect(captured).toEqual([GATEWAY_UPSTREAM_TIMEOUT_MS, GATEWAY_UPSTREAM_TIMEOUT_MS, GATEWAY_UPSTREAM_TIMEOUT_MS]);
        expect(GATEWAY_UPSTREAM_TIMEOUT_MS).toBe(5000);
      } finally {
        spy.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it('R143: 下游不可达/超时 → 503 + 10007（**不是** Nest 的 500 + 非契约体）', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        }),
      );
      const res = fakeRes();
      try {
        await gateway.forwardToGameSvc('GET', '/api/games/ABC123', null, res, { userId: 'u1' });
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith({ code: 10007, message: expect.any(String), data: null });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    /**
     * 片⑦ T10：`headersOf()` 产出的 `admin: true` 必须真的落到**下游请求头** `X-Admin: 1` 上
     * （config-service 的 `XAdminGuard` 只信「存在且**恰好** `'1'`」）。
     * 只断言「`headersOf` 的返回值里有这个字段」抓不到「转出了但没发出去」—— 那种情况下
     * 管理写全 401，而网关的单测照样绿（与下面 N7 那条 `X-Internal-Token` 判据同族）。
     * 正/负对照成对：`admin` 不设 ⇒ 该头**不得**出现（不凭空造一个空值）。
     *
     * 同时钉住 `forwardToConfigSvc` 的基址：env 有值 ⇒ 用它；env 未设 ⇒ 回落
     * compose 同形的 `http://config-service:3006`（config-service 的 HTTP 从不发布到宿主，
     * 这是它与其他服务「回落 localhost」形态不同的原因）。
     */
    it('T10: §2.7 转发 —— headers.admin 真时写出 X-Admin: 1、假时不写；基址 = CONFIG_SERVICE_URL（未设回落 config-service:3006）', async () => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => ({
          status: 200,
          headers: new Headers(),
          json: async () => ({ code: 0 }),
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const original = process.env.CONFIG_SERVICE_URL;
      try {
        process.env.CONFIG_SERVICE_URL = 'http://config-probe:3006';

        // ① 持管理标记的写：头必须出现，且 URL 用 env 基址
        await gateway.forwardToConfigSvc('PUT', '/api/admin/config/room.friendRoomEnabled', { value: true }, fakeRes(), {
          admin: true,
        });
        let [url, init] = fetchMock.mock.calls[0]!;
        expect(String(url)).toBe('http://config-probe:3006/api/admin/config/room.friendRoomEnabled');
        expect(init!.method).toBe('PUT');
        expect((init!.headers as Record<string, string>)['X-Admin']).toBe('1');

        // ② 负对照：没有 admin 字段 ⇒ 头一次都不出现（登录路径就长这样）
        fetchMock.mockClear();
        await gateway.forwardToConfigSvc('POST', '/api/admin/login', { password: 'p' }, fakeRes(), {});
        [url, init] = fetchMock.mock.calls[0]!;
        expect((init!.headers as Record<string, string>)['X-Admin']).toBeUndefined();

        // ③ 未设 env ⇒ 回落与 compose 逐字同形的基址
        delete process.env.CONFIG_SERVICE_URL;
        fetchMock.mockClear();
        await gateway.forwardToConfigSvc('GET', '/api/config', null, fakeRes(), { userId: 'u1' });
        expect(String(fetchMock.mock.calls[0]![0])).toBe('http://config-service:3006/api/config');
      } finally {
        if (original === undefined) delete process.env.CONFIG_SERVICE_URL;
        else process.env.CONFIG_SERVICE_URL = original;
        vi.unstubAllGlobals();
      }
    });

    /**
     * 货币片 T7（§2.13）：`forwardToCurrencySvc` 的基址 —— env 有值 ⇒ 用它；
     * env 未设 ⇒ 回落 `http://localhost:3004`（规格 §2.13 逐字钉的形态，
     * 与 `forwardToUserSvc` 一族同形；compose 的网关块显式设容器名 URL）。
     */
    it('T7: forwardToCurrencySvc 基址 = CURRENCY_SERVICE_URL（未设回落 http://localhost:3004）', async () => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => ({
          status: 200,
          headers: new Headers(),
          json: async () => ({ code: 0 }),
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const original = process.env.CURRENCY_SERVICE_URL;
      try {
        process.env.CURRENCY_SERVICE_URL = 'http://currency-probe:3004';
        await gateway.forwardToCurrencySvc('GET', '/api/wallet/balance', null, fakeRes(), { userId: 'u1' });
        expect(String(fetchMock.mock.calls[0]![0])).toBe('http://currency-probe:3004/api/wallet/balance');

        delete process.env.CURRENCY_SERVICE_URL;
        fetchMock.mockClear();
        await gateway.forwardToCurrencySvc('GET', '/api/wallet/balance', null, fakeRes(), { userId: 'u1' });
        expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3004/api/wallet/balance');
      } finally {
        if (original === undefined) delete process.env.CURRENCY_SERVICE_URL;
        else process.env.CURRENCY_SERVICE_URL = original;
        vi.unstubAllGlobals();
      }
    });

    it('does not invent an empty X-Internal-Token when the gateway has none configured', async () => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => ({
          status: 200,
          headers: new Headers(),
          json: async () => ({ code: 0 }),
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      try {
        await gateway.forwardToGameSvc('GET', '/api/games/ABC123', null, fakeRes(), { userId: 'u1' });

        const init = fetchMock.mock.calls[0]![1] ?? {};
        expect((init.headers as Record<string, string>)['X-Internal-Token']).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

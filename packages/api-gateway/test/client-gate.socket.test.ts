import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Socket } from 'socket.io';
import { ErrCode } from '@fight-the-landlord/protocol';
// 风控 T7 同款：连接名额挂在 **allowRequest 收到的请求对象**上（`socket.request === req`）——
// 次序判据（闸拒绝路径上名额释放监听必须在位）用同一个附着点布置。
import { attachWsConnSlot } from '../src/http/rate-limit';

/**
 * 客户端接入片 T6：socket 握手的**端闸**（`auth.clientPlatform`；判据 C17/C18）。
 *
 * 闸位 = `client.on('disconnect', …)`（名额释放）注册**之后**、`verifyClient` **之前**
 * ——**次序即正确性**：
 *  - 早于 disconnect 注册 ⇒ 闸拒绝的连接（`rejectHandshake` → `disconnect(true)`）在
 *    `disconnect` 事件上**没有监听者** ⇒ `allowRequest` 在传输层占的 WS 名额**泄漏到 TTL**
 *    （症状 =「用久了就连不上」——与 `rate-limit.ts` 的 member 配对纪律同族）；
 *  - 晚于 verifyClient ⇒ 端关了还要先验签（C18：无 token + 关闸端 ⇒ 10008 **不是** 10002）。
 *
 * 桩法照同包 `proxy.gateway.test.ts`：mock socket.io-client（下游替身）+ mock Socket
 * （`as unknown as SocketDouble`，只实现用例真正用到的成员）+ 假 gate（`vi.fn`）。
 * ⚠️ C17 的权威锚 = **断连**（`disconnect(true)`）；`system.error{10008}` 帧是 mock 面
 * 的帧级断言（`rejectHandshake` 自述 best-effort，不作线上形态承诺）。
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

const { ProxyGateway } = await import('../src/gateway/proxy.gateway');

/**
 * mock Socket（同 `proxy.gateway.test.ts` 的 `SocketDouble`：只加用例的观测口
 * ——`handlers` 就是 `on` 的监听器存放处、`emitted` 就是 `emit` 的记录；断言转换只收在 `makeClient` 一处）。
 */
type SocketDouble = Socket & {
  emitted: Array<[string, unknown]>;
  handlers: Record<string, Array<(...args: unknown[]) => void>>;
  trigger: (event: string, ...args: unknown[]) => void;
};

function makeClient(auth: Record<string, unknown>, request: Record<string, unknown> = {}) {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const client = {
    id: 'client-1',
    data: {},
    handshake: { auth, address: '10.0.0.1' },
    request,
    conn: { on: vi.fn((_event: string, _listener: (...args: unknown[]) => void): void => {}) },
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
  return client as unknown as SocketDouble;
}

/** `system.error` 帧（`rejectHandshake` 的尽力通道；权威信号仍是断开本身）。 */
const lastErrorFrame = (client: SocketDouble) =>
  client.emitted.filter(([type]) => type === 'system.error').at(-1)?.[1] as
    | { version: number; payload: { code: number; message: string } }
    | undefined;

describe('T6：socket 握手端闸（auth.clientPlatform；C17/C18）', () => {
  let gateway: InstanceType<typeof ProxyGateway>;
  let jwt: { verify: ReturnType<typeof vi.fn> };
  let session: { isActive: ReturnType<typeof vi.fn> };
  let redis: {
    zremrangebyscore: ReturnType<typeof vi.fn>;
    zcard: ReturnType<typeof vi.fn>;
    zadd: ReturnType<typeof vi.fn>;
    zrem: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
  };
  /** 假 gate：唯一成员 `allows`（与真 `ClientGateService` 的消费契约同形）。 */
  let gateAllows: ReturnType<typeof vi.fn>;

  const accessPayload = () => ({ sub: 'user-1', phone: '13800138000', typ: 'access', jti: 'jti-1' });

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
      exists: vi.fn(async () => 0),
    };
    gateAllows = vi.fn(() => true); // 缺省开闸（关闸格显式改值）
    gateway = new ProxyGateway(jwt as never, session as never, redis as never, {
      allows: gateAllows,
    } as never);
  });

  it('① C17：关闸端 `app` + 有效令牌 ⇒ system.error{10008} 帧 + disconnect(true)，零验签、零下游连接', async () => {
    gateAllows.mockReturnValue(false);
    const client = makeClient({ token: 'valid-token', clientPlatform: 'app' });
    await gateway.handleConnection(client);

    expect(gateAllows).toHaveBeenCalledTimes(1);
    expect(gateAllows).toHaveBeenCalledWith('app');
    const frame = lastErrorFrame(client);
    expect(frame?.version).toBe(0);
    expect(frame?.payload.code).toBe(ErrCode.CLIENT_DISABLED);
    expect(typeof frame?.payload.message).toBe('string');
    expect(client.disconnect).toHaveBeenCalledWith(true); // 权威信号：断连本身
    expect(jwt.verify).not.toHaveBeenCalled();
    expect(session.isActive).not.toHaveBeenCalled();
    expect(peerConnectCalls).toHaveLength(0);
    expect(gateway['peerSockets'].size).toBe(0);
  });

  it('①′ C17：关闸端 `h5` 同口径（按端取值进闸 —— 两键不塌缩）', async () => {
    gateAllows.mockImplementation((p: unknown) => p === 'app'); // 只放行 app
    const client = makeClient({ token: 'valid-token', clientPlatform: 'h5' });
    await gateway.handleConnection(client);

    expect(gateAllows).toHaveBeenCalledWith('h5');
    expect(lastErrorFrame(client)?.payload.code).toBe(ErrCode.CLIENT_DISABLED);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(peerConnectCalls).toHaveLength(0);
  });

  it('② 正对照：开闸端 + 无 token ⇒ 走到 verifyClient（10002，不是 10008）', async () => {
    const client = makeClient({ clientPlatform: 'app' }); // 无 token
    await gateway.handleConnection(client);

    expect(gateAllows).toHaveBeenCalledWith('app');
    expect(lastErrorFrame(client)?.payload.code).toBe(ErrCode.UNAUTHENTICATED);
    expect(lastErrorFrame(client)?.payload.code).not.toBe(ErrCode.CLIENT_DISABLED);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(peerConnectCalls).toHaveLength(0);
  });

  it('②′ 正对照：开闸端 + 有效令牌 ⇒ 正常建连（闸没截错人）', async () => {
    const client = makeClient({ token: 'valid-token', clientPlatform: 'h5' });
    await gateway.handleConnection(client);

    expect(gateAllows).toHaveBeenCalledWith('h5');
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(lastErrorFrame(client)).toBeUndefined();
    expect(peerConnectCalls).toHaveLength(1);
    const auth = peerConnectCalls.at(-1)!.options.auth as { userId?: string };
    expect(auth.userId).toBe('user-1');
  });

  it('③ 未识别桶：clientPlatform 缺失 ⇒ 闸零调用、放行到 verifyClient（有效令牌 ⇒ 正常建连）', async () => {
    const client = makeClient({ token: 'valid-token' }); // 不带 clientPlatform
    await gateway.handleConnection(client);

    expect(gateAllows).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(peerConnectCalls).toHaveLength(1);
  });

  it('③′ 未识别桶:非法值（大小写/空白/非串/显式 undefined）⇒ 一律放行，闸零调用', async () => {
    const invalid: unknown[] = [undefined, null, 'App', 'APP', 'android', '', ' h5', 'h5 ', 'app h5', 123, true, {}];
    for (const raw of invalid) {
      const client = makeClient({ token: 'valid-token', clientPlatform: raw });
      await gateway.handleConnection(client);
      expect(client.disconnect, `非法值 ${JSON.stringify(raw)} 不得被闸拦`).not.toHaveBeenCalled();
      expect(lastErrorFrame(client)).toBeUndefined();
    }
    expect(gateAllows).not.toHaveBeenCalled();
    expect(peerConnectCalls).toHaveLength(invalid.length); // 每个样本都真的建了连（放行到下游）
  });

  it('④ C18：关闸端 + **无 token** ⇒ 10008（不是 10002）——闸在 verifyClient 之前', async () => {
    gateAllows.mockReturnValue(false);
    const client = makeClient({ clientPlatform: 'app' }); // 无 token
    await gateway.handleConnection(client);

    expect(lastErrorFrame(client)?.payload.code).toBe(ErrCode.CLIENT_DISABLED);
    expect(lastErrorFrame(client)?.payload.code).not.toBe(ErrCode.UNAUTHENTICATED);
    expect(jwt.verify).not.toHaveBeenCalled();
    expect(session.isActive).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('⑤ 次序硬约束：闸拒绝路径上 disconnect 监听已在位 ⇒ 名额释放被走到（ZREM 同 member）', async () => {
    const request: Record<string, unknown> = {};
    attachWsConnSlot(request, { ip: '203.0.113.9', member: 'slot-gate-1' });
    gateAllows.mockReturnValue(false);
    const client = makeClient({ token: 'valid-token', clientPlatform: 'app' }, request);
    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    // 闸位若在 disconnect 注册**之前**，拒绝路径上监听不存在 ⇒ 名额泄漏到 TTL（本例红）。
    expect(client.handlers['disconnect'], 'disconnect 名额释放监听必须已注册').toBeDefined();
    client.trigger('disconnect');
    expect(redis.zrem).toHaveBeenCalledWith('ratelimit:ws-conn:203.0.113.9', 'slot-gate-1');
  });
});

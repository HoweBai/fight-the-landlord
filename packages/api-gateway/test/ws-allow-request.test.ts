import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProxyGateway } from '../src/gateway/proxy.gateway';
import { REDIS, SessionGuard } from '../src/auth/session.guard';
// 客户端接入片 T6：ProxyGateway 第 4 参（端闸）的 DI 解析 —— 见下面 providers 的放行桩。
import { ClientGateService } from '../src/auth/client-gate.service';
import { wsConnRateLimitKey } from '../src/http/rate-limit';

/**
 * N15 / **R246**（§5.4：单 IP 并发 WS 连接 **5**）—— **端到端**判据：真 socket.io 服务端
 * （真 Nest 应用 + 真 `@WebSocketGateway` 的 `allowRequest`）+ 真 socket.io 客户端。
 *
 * ─── 为什么必须是端到端 ─────────────────────────────────────────────
 * 单测（`proxy.gateway.test.ts`）只能证明「`checkAllowRequest` 的逻辑对」，
 * **证明不了**「Nest 真的把 `allowRequest` 交给了 engine.io」—— 那正是本条的关键：
 * 装饰器里的 `allowRequest` 必须在**传输层**生效，否则客户端还是会先 `connect` 再被踢
 * （R152 的旧形态）。判据①「第 6 条**从未**出现过 connect」只有真客户端能证。
 *
 * ─── 三条判据并列（缺一不可，R246）──────────────────────────────────
 *  ① 第 6 条拿到 **`connect_error`**；
 *  ② 第 6 条**从未**出现 `connect`（否则还是「连上即被踢」）；
 *  ③ 前 5 条**真的** connected（正对照 —— 否则「第 6 条被拒」可能是整个服务都没起来）。
 *  另加 ④ 名额在 `disconnect` 后释放（关掉一条 ⇒ 新连接能进来）：
 *  「只进不出」的限流同样会让正常用户用满 5 条后永远连不上。
 *
 * ⚠️ 下游 room-service 指向一个**必然拒绝**的端口（`:9`，discard）：本用例只关心
 * 网关**自身**的传输层限额，不需要（也不应该）碰运行中的 room-service。
 * 客户端因此可能收到下游不可达的 `system.error{10007}` —— 与判据无关。
 */
process.env.ROOM_SERVICE_WS_URL = 'http://127.0.0.1:9';

/** 一条连接的观测记录（**事件序列**，不只是最终状态）。 */
interface Probe {
  socket: ClientSocket;
  events: string[];
  connectError?: Error;
  connected: boolean;
}

/**
 * 假 Redis：**ZSET 的真实语义**（R212：替身的宽容度就是对缺陷的容忍度）。
 * `ratelimit:ws-conn:{ip}` 是 ZSET：member = 一次性 nonce，score = 时刻。
 */
function createRateLimitRedis() {
  const zsets = new Map<string, Map<string, number>>();
  const ttls = new Map<string, number>();

  const api = {
    zsets,
    zcard: async (key: string) => zsets.get(key)?.size ?? 0,
    zadd: async (key: string, score: number, member: string) => {
      const zset = zsets.get(key) ?? new Map<string, number>();
      const isNew = !zset.has(member);
      zset.set(member, Number(score));
      zsets.set(key, zset);
      return isNew ? 1 : 0;
    },
    zrem: async (key: string, ...members: string[]) => {
      const zset = zsets.get(key);
      if (!zset) return 0;
      let removed = 0;
      for (const member of members) if (zset.delete(member)) removed += 1;
      if (zset.size === 0) zsets.delete(key);
      return removed;
    },
    expire: async (key: string, seconds: number) => {
      if (!zsets.has(key)) return 0;
      ttls.set(key, seconds);
      return 1;
    },
    ttl: async (key: string) => (zsets.has(key) ? (ttls.get(key) ?? -1) : -2),
    zremrangebyscore: async () => 0,
    on: () => undefined,
    quit: async () => undefined,
  };
  return api;
}

/** 连一条客户端，记录**事件序列**（顺序即因果：`connect_error` 之前有没有 `connect`）。 */
function probe(baseUrl: string): Promise<Probe> {
  return new Promise((resolve) => {
    const events: string[] = [];
    const record: Probe = { socket: null as unknown as ClientSocket, events, connected: false };
    const socket = connectSocket(`${baseUrl}/ws/ddz`, {
      path: '/socket.io/',
      transports: ['websocket'],
      auth: { token: 'valid-access-token' },
      reconnection: false,
      timeout: 1500,
    });
    record.socket = socket;
    socket.on('connect', () => {
      events.push('connect');
      record.connected = true;
    });
    socket.on('connect_error', (err: Error) => {
      events.push('connect_error');
      record.connectError = err;
    });
    socket.on('disconnect', (reason: string) => events.push(`disconnect:${reason}`));
    socket.on('system.error', () => events.push('system.error'));
    setTimeout(() => resolve(record), 400);
  });
}

/** 同上，但用 polling 传输（它能拿到 engine.io 的 **403 错误体** ⇒ 可断言拒绝原因）。 */
function probePolling(baseUrl: string): Promise<Probe> {
  return new Promise((resolve) => {
    const events: string[] = [];
    const record: Probe = { socket: null as unknown as ClientSocket, events, connected: false };
    const socket = connectSocket(`${baseUrl}/ws/ddz`, {
      path: '/socket.io/',
      transports: ['polling'],
      auth: { token: 'valid-access-token' },
      reconnection: false,
      timeout: 1500,
    });
    record.socket = socket;
    socket.on('connect', () => { events.push('connect'); record.connected = true; });
    socket.on('connect_error', (err: Error) => { events.push('connect_error'); record.connectError = err; });
    socket.on('system.error', () => events.push('system.error'));
    setTimeout(() => resolve(record), 400);
  });
}

/**
 * 从 `connect_error` 里取出**握手层 HTTP 状态**：
 * engine.io-client 的 `TransportError` 把 polling 的 403 放在 `description`（数字）
 * 或 `context.status` 上；网络层失败（服务没起来 / 端口不通）则是 `undefined`/0。
 */
function handshakeStatus(err: Error | undefined): number | undefined {
  const carrier = err as unknown as { description?: unknown; context?: { status?: unknown } };
  if (typeof carrier?.description === 'number') return carrier.description;
  const status = carrier?.context?.status;
  return typeof status === 'number' ? status : undefined;
}

/** 轮询式等待（**不钉墙钟**：判据是「最终会发生」，不是「N ms 内发生」）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe('N15/R246：WS 连接限额在 engine.io allowRequest（端到端，真 socket.io 客户端）', () => {
  let app: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>> extends {
    createNestApplication: () => infer A;
  }
    ? A
    : never;
  let baseUrl = '';
  let redis: ReturnType<typeof createRateLimitRedis>;
  const open: Probe[] = [];

  const ipKey = wsConnRateLimitKey('127.0.0.1');
  const slots = () => redis.zsets.get(ipKey)?.size ?? 0;

  const closeAll = async (): Promise<void> => {
    for (const p of open.splice(0)) p.socket.close();
    await waitUntil(() => slots() === 0);
  };

  beforeAll(async () => {
    redis = createRateLimitRedis();
    // P18/N41：`design:paramtypes` 现由测试环境**真的**发出（`vitest.config.ts` 的插件 +
    // `setupFiles: ['reflect-metadata']`）⇒ 不再手写垫片。于是下面这段容器装配
    // **真的**在用产品元数据实例化 `ProxyGateway`（`@WebSocketGateway` 类 provider，
    // 必须经容器实例化，`allowRequest` 的登记才会发生）。

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProxyGateway,
        {
          provide: JwtService,
          useValue: { verify: () => ({ sub: 'user-1', typ: 'access', jti: 'jti-1' }) },
        },
        { provide: SessionGuard, useValue: { isActive: async () => true } },
        { provide: REDIS, useValue: redis },
        // 客户端接入片 T6：ProxyGateway 第 4 参（端闸）。本文件探针的 auth **不带
        // `clientPlatform`**（未识别桶）⇒ 闸不会被咨询；放行桩只为满足 DI 解析
        // ——⛔ 不为它拉真 ConfigCacheService/ConfigClient（会引入配置边与启动时序）。
        { provide: ClientGateService, useValue: { allows: () => true } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false }) as never;
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await closeAll();
    await app.close();
  });

  it('① 前 5 条真的 connected；② 第 6 条拿到 connect_error 且**从未** connect', async () => {
    const first = await Promise.all([0, 1, 2, 3, 4].map(() => probe(baseUrl)));
    first.forEach((p) => open.push(p));

    expect(
      first.filter((p) => p.connected).length,
      `前 5 条必须真的连上（正对照）。events=${JSON.stringify(first.map((p) => p.events))}`,
    ).toBe(5);
    expect(slots(), '前 5 条必须各占一个名额').toBe(5);

    const sixth = await probe(baseUrl);
    open.push(sixth);

    expect(sixth.connected, '第 6 条不得进入 connected —— 否则还是「连上即被踢」').toBe(false);
    expect(
      sixth.connectError,
      `第 6 条必须拿到 connect_error（传输层拒绝）。实际事件：${JSON.stringify(sixth.events)}`,
    ).toBeTruthy();
    expect(
      sixth.events,
      `第 6 条**不得**出现过 connect 事件（出现过就说明拒绝发生在握手之后）。实际：${JSON.stringify(sixth.events)}`,
    ).not.toContain('connect');
    // 拒绝原因必须是我们给的那句（否则可能是「服务根本没起来」之类的假绿）
    // 握手被**传输层**拒绝的形态：websocket 传输上，engine.io-client 只报一个
    // 泛化的 `TransportError('websocket error')`（`ws` 把非 101 的升级响应吞掉了，
    // 拿不到错误体）⇒ **不能**断言消息文本；能断言的是 `type`。
    expect((sixth.connectError as unknown as { type?: string })?.type).toBe('TransportError');
    expect(slots()).toBe(5);

    // 换 **polling** 传输再打一条：它的 `connect_error` 带 HTTP 状态
    // （`description === 403`），而「服务没起来」是网络层错误（status 0/undefined）——
    // 这条把「engine.io 的 FORBIDDEN」与「连不上」区分开。
    const seventh = await probePolling(baseUrl);
    open.push(seventh);
    expect(seventh.connected, 'polling 的第 7 条也不得连上').toBe(false);
    expect(seventh.events, '第 7 条不得出现 connect').not.toContain('connect');
    expect(
      handshakeStatus(seventh.connectError),
      `polling 的拒绝必须是握手层 403（engine.io FORBIDDEN）。events=${JSON.stringify(seventh.events)}`,
    ).toBe(403);
    // 超限的连接**不得**占名额
    expect(slots()).toBe(5);

    // 前 5 条不受影响（仍 connected）
    expect(first.filter((p) => p.socket.connected).length).toBe(5);
  });

  it('④ 名额在 disconnect 后**释放**（关掉一条 ⇒ 新连接能进来）', async () => {
    // 承接上一条留下的 5 条连接：关掉一条并等名额落地（异步释放）
    expect(open.length).toBeGreaterThanOrEqual(5);
    const victim = open.shift()!;
    victim.socket.close();
    expect(await waitUntil(() => slots() <= 4), `名额没释放：slots=${slots()}`).toBe(true);

    const replacement = await probe(baseUrl);
    open.push(replacement);
    expect(
      replacement.connected,
      `释放后的新连接必须能连上。events=${JSON.stringify(replacement.events)}`,
    ).toBe(true);
  });
});

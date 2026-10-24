import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AddressInfo } from 'net';
import { JwtMiddleware } from '../src/auth/jwt.middleware';
import type { SessionGuard } from '../src/auth/session.guard';

/**
 * 网关 HTTP 边界测试（§7.1 / §5.2 / §5.1）。
 *
 * 用真实 HTTP server 跑**真实的 `JwtMiddleware`**，下游被替换为打桩，
 * 因此「匿名写操作被拒」这条断言不依赖任何下游服务是否在运行。
 *
 * ⚠️ 为什么这里手搭 Express 而不是用 `@nestjs/testing`：
 * 本文件要钉的是**中间件 + 路由表**这一层，手搭路由能精确控制二者的注册顺序，
 * 并让下游打桩不依赖任何服务是否在运行。
 * （P18/N41 之前这里的理由是「Vitest/esbuild 不发 `design:paramtypes`，反射式注入
 * 在测试里拿不到依赖」—— 那条**已不再成立**：`vitest.config.ts` 的
 * `scripts/vitest-plugins/emit-decorator-metadata.ts` + `setupFiles: ['reflect-metadata']`
 * 现在真的发出该元数据，`@nestjs/testing` 在本仓可用。手搭是**选型**，不是绕坑。）
 *
 * ⚠️ `use()` 自切片 6 起是 `async`（要 `await` 白名单查询）。Express 不认识
 * Promise，**必须**显式 `.catch(next)`，否则 rejection 会变成未处理拒绝 +
 * 请求挂死。Nest 自己就是这么做的（`RouterProxy.createProxy` 内部
 * `try { await cb() } catch (e) { exceptionsHandler.next(e) }`），所以这里
 * 复刻的正是生产行为。
 */
describe('API Gateway (HTTP security boundary)', () => {
  let server: import('http').Server;
  let baseUrl: string;
  let proxy: {
    forwardToUserSvc: ReturnType<typeof vi.fn>;
    forwardToRoomSvc: ReturnType<typeof vi.fn>;
    forwardToGameSvc: ReturnType<typeof vi.fn>;
  };
  let mockJwtService: { verify: ReturnType<typeof vi.fn> };
  let session: { isActive: ReturnType<typeof vi.fn> };

  const call = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
  const postJson = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });
  const authed = (path: string) => call(path, { headers: { Authorization: 'Bearer valid-token' } });

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? 'test-internal-token';

    // 延迟引入：`express` 是被 api-gateway 直接依赖的运行时包。
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());

    mockJwtService = { verify: vi.fn() };
    session = { isActive: vi.fn(async () => true) };
    const middleware = new JwtMiddleware(mockJwtService as never, session as unknown as SessionGuard);
    proxy = {
      forwardToUserSvc: vi.fn(async (_m, _p, _b, res) => res.status(200).json({ code: 0 })),
      forwardToRoomSvc: vi.fn(async (_m, _p, _b, res) => res.status(201).json({ code: 0 })),
      forwardToGameSvc: vi.fn(async (_m, _p, _b, res) => res.status(200).json({ code: 0 })),
    };

    // 与 src/main.ts 一致：全局前缀是 `/api`，而中间件的作用域**就是带前缀的那一段**。
    //
    // R149（实测）：`consumer.apply(JwtMiddleware).forRoutes('*')` **不是**「挂在所有路径」——
    // `setGlobalPrefix('api')` 把通配符收窄成 `/api/*`（Nest 10.4.22 的
    // `RouteInfoPathExtractor.extractPathsFrom` 对 `'*'` 返回 `[prefix + '$', prefix + '/*']`）。
    // 因此这里必须写 `app.use('/api', …)` 才算复刻真实作用域；写成全局 `app.use(…)`
    // 会让 `/` 得到 401（脚手架的性质），而真实网关恒为 **404**。
    // `use()` 是 async → 复刻 Nest 的 `try { await } catch { next(err) }`。
    app.use('/api', (req: any, res: any, next: any) => {
      Promise.resolve(middleware.use(req, res, next)).catch(next);
    });

    // 与真实路由表一致（`/api/health` 由 `HealthController` 提供 —— R294 之前
    // `GatewayController` 也声明了一条同路径路由并**遮蔽**了它，本脚手架当时复刻的
    // 正是那条旧的、不含 `checks` 的响应）。
    app.get('/api/health', (_req, res) =>
      res.json({ status: 'ok', service: 'api-gateway', checks: { redis: 'up' } }),
    );
    app.post('/api/auth/login', (req, res) => proxy.forwardToUserSvc('POST', '/api/auth/login', req.body, res));
    app.post('/api/auth/register', (req, res) =>
      proxy.forwardToUserSvc('POST', '/api/auth/register', req.body, res),
    );
    app.get('/api/rooms', (_req, res) => proxy.forwardToRoomSvc('GET', '/api/rooms', null, res));
    app.post('/api/rooms', (req, res) => proxy.forwardToRoomSvc('POST', '/api/rooms', req.body, res));
    app.get('/api/games/:code', (req, res) =>
      proxy.forwardToGameSvc('GET', `/api/games/${req.params.code}`, null, res),
    );

    // 中间件抛出的 HttpException → 契约信封（§11.1）
    app.use(
      (
        err: { getStatus?: () => number; getResponse?: () => unknown; message?: string },
        _req: unknown,
        res: any,
        _next: unknown,
      ) => {
        const status = typeof err?.getStatus === 'function' ? err.getStatus() : 500;
        const raw = typeof err?.getResponse === 'function' ? err.getResponse() : null;
        const body =
          raw && typeof raw === 'object'
            ? raw
            : { code: 10002, message: err?.message ?? 'error', data: null };
        res.status(status).json(body);
      },
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    session.isActive.mockResolvedValue(true);
  });

  it('GET /api/health returns the gateway health payload without a token', async () => {
    const res = await call('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      checks: Record<string, string>;
    };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('api-gateway');
    // §2.4/R267：就绪面必须带 `checks`（本脚手架此前复刻的是不含 checks 的旧形状）
    expect(body.checks).toEqual({ redis: 'up' });
  });

  it('S1: anonymous POST /api/rooms is rejected with 401', async () => {
    const res = await postJson('/api/rooms', { mode: 'random' });
    expect(res.status).toBe(401);
    expect(proxy.forwardToRoomSvc).not.toHaveBeenCalled();
  });

  it('S1: anonymous GET /api/rooms is rejected with 401', async () => {
    const res = await call('/api/rooms');
    expect(res.status).toBe(401);
    expect(proxy.forwardToRoomSvc).not.toHaveBeenCalled();
  });

  it('S1: anonymous GET /api/games/ABC123 is rejected with 401', async () => {
    const res = await call('/api/games/ABC123');
    expect(res.status).toBe(401);
    expect(proxy.forwardToGameSvc).not.toHaveBeenCalled();
  });

  /**
   * A6（R138/R149）：`web/index.html` 删除后，`/` 与 `/index.html` 的真实拓扑行为。
   *
   * ⚠️ **R149 的实测事实**（2026-09-15，运行中的 master 镜像、容器 `ftl-api-gateway`）：
   *
   * ```
   * GET /            -> 200（HTML，待删的静态页 —— 来自 main.ts 里那个 Express 处理器）
   * GET /foo         -> 404   ← Nest 默认 404，**不是** 401
   * GET /index.html  -> 200（HTML）
   * GET /api/rooms   -> 401
   * GET /api/nope    -> 401
   * ```
   *
   * ⇒ `consumer.apply(JwtMiddleware).forRoutes('*')` 被 `setGlobalPrefix('api')`
   * **收窄成了 `/api/*`**：`/`、`/foo`、`/index.html` 这类**不带前缀**的路径
   * **根本不经过 JwtMiddleware**（Nest 10.4.22 `RouteInfoPathExtractor.extractPathsFrom`
   * 对通配符返回 `[prefix + '$', prefix + '/*']`，prefix 为 `/api`）。
   * 因此本用例期望的是 **404**，而**不是** 401 —— 写成 401 就等于在断言
   * 「中间件挂在所有路由上」，那是**脚手架的性质**、不是被测系统的性质（假绿）。
   *
   * 副作用正是 A6 要的：`/` 不再返回 `web/index.html`（静态页删了）。
   * 「中间件在 `/` 上跑也绝不放行」由 `jwt.middleware.test.ts` 的**单元**级用例钉住。
   *
   * ⚠️ 关于 `'<html'` 这个字面量：**不能**在这里断言它不出现。未命中路由时响应由
   * **Express 的默认 404 处理器**给出，那个 body 本身就长这样：
   *
   * ```
   * <!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /</pre>\n</body>\n</html>
   * ```
   *
   * 它是**框架噪声**（与 `web/index.html` 无关，生产里是 Nest 的 404 形状）。
   * 有判别力的判据是：**不得**出现那个被删页面独有的字符串
   * （`findBeatingHand` —— 浏览器端规则引擎的函数名），它同时钉住了
   * 「23KB 的规则引擎不再从网关出站」（§12.5）。
   */
  it('A6: `/` 与 `/index.html` 一律 404（Nest/Express 默认 404，R149）且不含被删页面的任何内容', async () => {
    for (const path of ['/', '/index.html']) {
      for (const init of [{}, { headers: { Authorization: 'Bearer valid-token' } }] as RequestInit[]) {
        const res = await call(path, init);
        const text = await res.text();
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
        expect(text).not.toContain('findBeatingHand');   // web/index.html 的规则引擎
        expect(text).not.toContain('斗地主');
      }
    }
  });

  it('public path /api/auth/login stays reachable anonymously (not 401)', async () => {
    const res = await postJson('/api/auth/login', {});
    expect(res.status).not.toBe(401);
    expect(proxy.forwardToUserSvc).toHaveBeenCalled();
  });

  it('rejects an external request that carries X-Internal-Token with 403 + 10003', async () => {
    const res = await postJson('/api/rooms', { mode: 'random' }, {
      'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN as string,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 10003, data: null });
    expect(proxy.forwardToRoomSvc).not.toHaveBeenCalled();
  });

  it('R26: a valid signature whose session:{jti} is gone is rejected with 401 + 10004', async () => {
    mockJwtService.verify.mockReturnValue({ sub: 'u1', typ: 'access', jti: 'revoked-jti' });
    session.isActive.mockResolvedValue(false);

    const res = await authed('/api/rooms');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 10004, data: null });
    expect(session.isActive).toHaveBeenCalledWith('revoked-jti');
    expect(proxy.forwardToRoomSvc).not.toHaveBeenCalled();
  });

  it('R24: a refresh token is rejected with 401 + 10005', async () => {
    mockJwtService.verify.mockReturnValue({ sub: 'u1', typ: 'refresh', jti: 'jti-r' });

    const res = await authed('/api/rooms');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 10005 });
    expect(session.isActive).not.toHaveBeenCalled();
  });

  it('R26: a Redis failure becomes 503 + 10007 instead of silently passing the request', async () => {
    mockJwtService.verify.mockReturnValue({ sub: 'u1', typ: 'access', jti: 'jti-1' });
    session.isActive.mockRejectedValue(new Error('redis down'));

    const res = await authed('/api/rooms');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 10007, data: null });
    expect(proxy.forwardToRoomSvc).not.toHaveBeenCalled();
  });

  it('an allowlisted access token reaches the downstream stub', async () => {
    mockJwtService.verify.mockReturnValue({ sub: 'u1', typ: 'access', jti: 'jti-1' });

    const res = await authed('/api/rooms');
    expect(res.status).toBe(201); // 下游打桩固定回 201
    expect(proxy.forwardToRoomSvc).toHaveBeenCalled();
  });
});

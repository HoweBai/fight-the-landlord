import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, Module, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  createInternalTokenMiddleware,
  type InternalTokenMiddleware,
} from '../src/http/internal-token.middleware';

/**
 * N4/N7：**服务间身份边界**的 HTTP 级断言（§5.2 规则 3，R87–R89）。
 *
 * 曾经的漏洞（N4）：user-service 的业务路由**不校验任何服务间凭证** ——
 * 任何人直连 `localhost:3001` 并伪造 `X-User-Id` 就能冒充任意玩家。
 * 本用例在**实现中间件之前**必须红：无 token 的业务路由当时能通（200）。
 *
 * ⚠️ health 那一条不是凑数：`docker-compose.yml` 的 healthcheck 是**直连**
 * `localhost:3001/api/health` 的，不豁免 ⇒ 全部容器 unhealthy ⇒ 网关依赖它们
 * ⇒ **一次「加固」把整个平台打成雪崩**（R87②）。
 */
describe('服务间身份边界（N4/N7，R87-R89）', () => {
  let onlyServer: Server;
  let onlyUrl: string;

  const TOKEN = 'test-internal-token';
  /** 任一业务路由：中间件挂在路由**之前**，因此它必须拦住这条路径。 */
  const BUSINESS = '/api/users/me';

  /**
   * 以**最小 express 形状适配器**挂载中间件（`*controller.test.ts` 的既有手法：
   * 零新增依赖地钉住中间件契约，也隔离掉 Nest 装配变量）。
   * （P18/N41 之前这里的理由是「Vitest/esbuild 不发出 `design:paramtypes`，
   * 真实 Nest DI 在这些单测里不可用」—— 那条**已不再成立**：`vitest.config.ts`
   * 的插件 + `setupFiles: ['reflect-metadata']` 现在真的发出该元数据。）
   * 装配本身由下一组「接线探针」用**真实 Nest 管线**覆盖。
   */
  const mountInternalToken = (middleware: InternalTokenMiddleware): Promise<{ server: Server; url: string }> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        const r = req as unknown as { path: string; headers: Record<string, string | string[] | undefined> };
        // Express 的 `req.path` / `req.headers[小写]` 语义（真实服务里由 Express 提供）。
        r.path = (req.url ?? '/').split('?')[0] ?? '/';

        // Express 的 `res.status(n).json(body)` 语义：中间件只用到这两样。
        const expressLike = {
          _status: 200,
          status(code: number) {
            this._status = code;
            return this;
          },
          json(body: unknown) {
            res.writeHead(this._status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
            return this;
          },
        };

        middleware(r as never, expressLike as never, () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', route: r.path }));
        });
      });
      server.listen(0, '127.0.0.1', () =>
        resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
      );
    });

  /** 中间件在构造时读取 env（与 `main.ts` 的 `app.use(createInternalTokenMiddleware())` 同时刻）。 */
  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
    const mounted = await mountInternalToken(createInternalTokenMiddleware());
    onlyServer = mounted.server;
    onlyUrl = mounted.url;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => onlyServer.close(() => resolve()));
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${onlyUrl}${path}`, { headers });

  it('缺少 X-Internal-Token 的业务路由 → 401 + 10002（N4/N7）', async () => {
    const res = await get(BUSINESS);
    // 修前（RED）：200 —— 直连 + 伪造 X-User-Id 就能冒充任意玩家。
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 10002, message: expect.any(String), data: null });
  });

  it('错误的 X-Internal-Token → 401 + 10002', async () => {
    const res = await get(BUSINESS, { 'X-Internal-Token': 'wrong' });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe(10002);
  });

  it('正确 token → 放行（且不影响正常的身份校验）', async () => {
    const res = await get(BUSINESS, { 'X-Internal-Token': TOKEN, 'X-User-Id': 'alice' });
    expect(res.status).toBe(200);
    // 放行到的是**业务路由本身**，不是被中间件改写的响应
    expect(await res.json()).toEqual({ status: 'ok', route: BUSINESS });
  });

  it('/api/health 与 /api/health/live 都豁免：无 token 也 200（R87② + R267 的存活面）', async () => {
    // R267：`/api/health` = 就绪（compose 的 healthcheck 用它）；
    // `/api/health/live` = 存活（编排层探针**不带**内部 token，也不该带）。
    for (const path of ['/api/health', '/api/health/live']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
    }
  });

  it('豁免是**精确**匹配：健康路径的近邻仍然 401（否则豁免退化成前缀，门又开了）', async () => {
    // 判别力（R115）：先证明探针能区分「豁免」与「不豁免」—— 上面那条给出 200，
    // 这三条近似写法必须**仍然** 401。若有人把 `exemptPaths.includes` 改成
    // `path.startsWith('/api/health')`，`/api/healthz` 与 `/api/health/livex` 会变 200 ⇒ 红。
    for (const path of ['/api/healthz', '/api/health/livex', '/api/healthx']) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('R89 fail-closed：未配置 INTERNAL_SERVICE_TOKEN 时**一切业务路由都拒**（不是「没配就跳过」）', async () => {
    // 启动期由 `main.ts` 直接 `exit(1)`；这里钉住中间件自身的兜底语义 ——
    // 少这层兜底，「未配置」就真的会变成一个**静默可选开关**。
    const original = process.env.INTERNAL_SERVICE_TOKEN;
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const mounted = await mountInternalToken(createInternalTokenMiddleware());
    try {
      const res = await fetch(`${mounted.url}${BUSINESS}`, { headers: { 'X-User-Id': 'victim' } });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe(10002);
    } finally {
      await new Promise<void>((resolve) => mounted.server.close(() => resolve()));
      if (original !== undefined) process.env.INTERNAL_SERVICE_TOKEN = original;
    }
  });
});

/**
 * **接线**探针（N7）：上面那组用 express 形状适配器钉住了中间件本身，这一组把它放进
 * **真实 Nest/Express 管线**，验证 `main.ts` 的注册顺序成立 ——
 * `app.use(middleware)` 写在 `setGlobalPrefix('api')` **之前**。
 *
 * 这是本片最容易「加固把平台打断」的一环，而且是**静默**的：
 *  - 顺序错了 ⇒ 中间件可能只挂在无前缀路径上 ⇒ 业务路由**没有**保护（漏洞还在，测试却绿）；
 *  - 豁免判定若误用被剥掉前缀的 `req.url` ⇒ `/api/health` 不被豁免 ⇒
 *    容器 healthcheck 全挂 ⇒ 网关依赖它们 ⇒ **全线雪崩**（R87②）。
 *
 * 用真实 Nest 而非完整 `AppModule`：后者要连 MySQL/Redis（单测不依赖容器）。
 */
@Controller('health')
class ProbeHealthController {
  @Get()
  check() {
    return { status: 'ok', service: 'user-service' };
  }
}

@Controller('users')
class ProbeUsersController {
  @Get('me')
  me() {
    return { code: 0, data: { id: 'alice' } };
  }
}

@Module({ controllers: [ProbeHealthController, ProbeUsersController] })
class ProbeModule {}

describe('接线探针：main.ts 的注册顺序（真实 Nest 管线）', () => {
  let app: INestApplication;
  let baseUrl: string;
  const TOKEN = 'probe-internal-token';

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
    app = await NestFactory.create(ProbeModule, { logger: false });
    // 与 `src/main.ts` **逐行相同**的顺序。
    app.use(createInternalTokenMiddleware());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it('带前缀的业务路由受保护：/api/users/me 无 token → 401 + 10002', async () => {
    const res = await fetch(`${baseUrl}/api/users/me`, { headers: { 'X-User-Id': 'victim' } });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe(10002);
  });

  it('带前缀的 health 仍被豁免：/api/health 无 token → 200', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'user-service' });
  });

  it('带正确 token 的内部调用仍可用：/api/users/me → 200', async () => {
    const res = await fetch(`${baseUrl}/api/users/me`, { headers: { 'X-Internal-Token': TOKEN } });
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBe(0);
  });
});

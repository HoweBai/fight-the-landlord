import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, UnauthorizedException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger, createTraceMiddleware } from '@fight-the-landlord/shared';
import { JwtMiddleware } from '../src/auth/jwt.middleware';
import type { SessionGuard } from '../src/auth/session.guard';

/**
 * 契约来自 docs/design.md §5.2 / §5.1 / §7.1：
 *  - 公开路径白名单**只有**四条，且**不含 `'/'`**（含 `'/'` 会让 `isPublicPath()` 恒真 → 鉴权完全失效，见 S1）
 *  - 验签通过后网关注入 `X-User-Id` / `X-Trace-Id`
 *  - 网关拒绝任何外部携带 `X-Internal-Token` 的请求
 *  - **R24**：网关拒绝 `typ !== 'access'` 的令牌（`10005`）
 *  - **R26**：验签后还要查 `session:{jti}` 白名单；不在白名单 → `10004`，Redis 故障 → `10007`
 *  - **R31**：`X-Token-Jti` 只在 `/api/auth/logout` 上注入
 *
 * 这些用例此前**完全不存在** —— 这正是 S1 能长期存活的原因（§13.5）。
 */
describe('JwtMiddleware', () => {
  let middleware: JwtMiddleware;
  let mockJwtService: { verify: ReturnType<typeof vi.fn> };
  let session: { isActive: ReturnType<typeof vi.fn> };

  const makeReq = (over: Record<string, unknown> = {}) => ({
    originalUrl: '/api/rooms',
    url: '/api/rooms',
    headers: {} as Record<string, unknown>,
    ...over,
  });

  const ORIGINAL_ENV = process.env.INTERNAL_SERVICE_TOKEN;
  const INTERNAL = 'test-internal-token-do-not-use-in-prod';

  /** §5.1 的正常 access 载荷（含 R24 的 `typ` 与白名单键需要的 `jti`）。 */
  const validPayload = (over: Record<string, unknown> = {}) => ({
    sub: 'user-123',
    phone: '13800138000',
    typ: 'access',
    jti: 'jti-1',
    ...over,
  });

  /** 把 `use()` 的 rejection 收成异常对象，便于断言状态码与信封体。 */
  const useAndCatch = async (req: unknown) => {
    try {
      await middleware.use(req as never, {} as never, vi.fn());
      return null;
    } catch (err) {
      return err as { getStatus: () => number; getResponse: () => unknown };
    }
  };

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = INTERNAL;
    mockJwtService = { verify: vi.fn() };
    session = { isActive: vi.fn(async () => true) };
    middleware = new JwtMiddleware(mockJwtService as never, session as unknown as SessionGuard);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = ORIGINAL_ENV;
    /**
     * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 本文件末尾
     * （判据 12 那一块）装过捕获 sink 而不还原 ⇒ **在这之后追加**的用例会静默写进
     * 一个已经死掉的 sink（既不报错、也看不到自己的日志行）。
     * 还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
     */
    Logger.overrideLogger(new Logger());
  });

  describe('public paths (exact whitelist, §7.1)', () => {
    const publicUrls = [
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/refresh',
      '/api/health',
      // R267/R293：存活面必须能被编排层无凭证探到。
      '/api/health/live',
    ];

    for (const url of publicUrls) {
      it(`allows ${url} without token`, async () => {
        const req = makeReq({ originalUrl: url, url });
        const next = vi.fn();

        await middleware.use(req as never, {} as never, next);
        expect(next).toHaveBeenCalled();
        // 公开路径不做白名单查询（refresh 的令牌已经过期/轮换掉了也照样放行到 user-service）
        expect(session.isActive).not.toHaveBeenCalled();
      });
    }

    it('allows /api/auth/login with a query string', async () => {
      const req = makeReq({ originalUrl: '/api/auth/login?next=/lobby', url: '/api/auth/login?next=/lobby' });
      const next = vi.fn();

      await middleware.use(req as never, {} as never, next);
      expect(next).toHaveBeenCalled();
    });

    it('A6: 根路径**不是**公开路径（临时验证页已删除，§1.4）', async () => {
      const req = makeReq({ originalUrl: '/', url: '/' });
      await expect(middleware.use(req as never, {} as never, vi.fn())).rejects.toThrow(
        UnauthorizedException,
      );
      // 白名单**逐条**钉住（§7.1 四条 + R267 的 `/api/health/live`）——用**行为**钉住，
      // 不碰私有字段：清单内全过、近邻全拒。
      for (const path of [
        '/api/auth/login',
        '/api/auth/register',
        '/api/auth/refresh',
        '/api/health',
        '/api/health/live',
      ]) {
        await middleware.use(makeReq({ originalUrl: path, url: path }) as never, {} as never, vi.fn());
      }
      // ⚠️ `/api/health/livex` 是**新增**的负对照：R267 之后必须证明存活面是作为
      // **精确**条目加进去的，而不是把 `/api/health` 改成了前缀（后者会让
      // `/api/healthz`・`/api/health/livex` 静默变公开）。
      for (const path of ['/', '/index.html', '/api/auth/login-as-admin', '/api/healthz', '/api/health/livex']) {
        await expect(
          middleware.use(makeReq({ originalUrl: path, url: path }) as never, {} as never, vi.fn()),
        ).rejects.toThrow(UnauthorizedException);
      }
    });

    it('R146: 公开路径上客户端自带的身份头必须被剥掉（否则 headersOf 会把它当身份转发给下游）', async () => {
      const req = makeReq({
        originalUrl: '/api/auth/login',
        url: '/api/auth/login',
        headers: { 'x-user-id': 'victim', 'x-token-jti': 'victim-jti', 'x-trace-id': 'trace-1' },
      });

      await middleware.use(req as never, {} as never, vi.fn());

      expect(req.headers['x-user-id']).toBeUndefined();
      expect(req.headers['x-token-jti']).toBeUndefined();
      // X-Trace-Id 是链路追踪、不是身份 ⇒ **不由身份层处置**（不剥、也不改）。R146 的「剥」
      // 只针对身份头；客户端自带的值更早在网关形态的 trace 中间件（R1106）就被无条件覆盖了。
      expect(req.headers['x-trace-id']).toBe('trace-1');
    });

    it('does NOT treat every path as public (S1 regression guard)', async () => {
      // 旧实现的白名单含 '/'，而任何路径都以 '/' 开头，于是全部放行。
      for (const url of ['/api/rooms', '/api/games/ABC', '/api/users/me', '/api/robots/move']) {
        const req = makeReq({ originalUrl: url, url });
        await expect(middleware.use(req as never, {} as never, vi.fn())).rejects.toThrow(
          UnauthorizedException,
        );
      }
    });

    it('does not treat a public prefix as a blanket prefix match', async () => {
      // '/api/auth/login' 的**精确**匹配不允许 '/api/auth/login-as-admin' 通过
      const req = makeReq({ originalUrl: '/api/auth/login-as-admin', url: '/api/auth/login-as-admin' });
      await expect(middleware.use(req as never, {} as never, vi.fn())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('falls back to req.url when originalUrl is absent', async () => {
      const req = { url: '/api/health', headers: {} };
      const next = vi.fn();

      await middleware.use(req as never, {} as never, next);
      expect(next).toHaveBeenCalled();
    });
  });

  /**
   * 片⑦ D6①（T9）：`/api/admin/*` 的**玩家验签整段跳过**。
   *
   * 管理面请求按定义没有玩家 Bearer（管理员不是玩家），也不该查玩家 session 白名单；
   * 管理令牌由紧随其后的 `AdminAuthMiddleware` 自证（`admin.middleware.test.ts`）。
   * ⚠️ 跳过的**只有验签段**：`X-User-Id`/`X-Token-Jti` 的剥离在它**之前**、照常执行。
   *
   * 删掉 `jwt.middleware.ts` 里的 `|| isAdminPath(path)` ⇒ 这里当场红（而且正是那个
   * 「登录 200、此后每个管理请求 401」的生产形态）。
   */
  describe('admin plane skips player verification (片⑦ D6①)', () => {
    it('admin 前缀路径（含前缀根）⇒ 直接放行：不验签、不查 session、身份头照剥', async () => {
      // ⚙️20（终审 F1）：识别**大小写不敏感** —— 混大小写变体同样整段跳过（变体若被当
      // 玩家路径，会拿着玩家令牌直通管理处理器、旁路失败桶；修复后由 AdminAuth 401 收口）。
      for (const path of ['/api/admin', '/api/admin/config', '/API/admin/config', '/Api/Admin/Config']) {
        const req = makeReq({
          originalUrl: path,
          url: path,
          headers: {
            authorization: 'Bearer garbage',
            'x-user-id': 'victim',
            'x-token-jti': 'victim-jti',
          },
        });
        const next = vi.fn();

        await middleware.use(req as never, {} as never, next);

        expect(next).toHaveBeenCalled();
        // garbage Bearer 若被验签会当场抛 ⇒ 没抛 + 一次没调 = 整段跳过
        expect(mockJwtService.verify).not.toHaveBeenCalled();
        expect(session.isActive).not.toHaveBeenCalled();
        // R146 的剥离在路径判断**之前**（身份通道纪律不因跳过验签而豁免）
        expect(req.headers['x-user-id']).toBeUndefined();
        expect(req.headers['x-token-jti']).toBeUndefined();
      }
    });

    it('带查询串的 admin 路径同样跳过（requestPath 是唯一派生口径）', async () => {
      const req = makeReq({ originalUrl: '/api/admin/config?k=x', url: '/api/admin/config?k=x' });
      const next = vi.fn();

      await middleware.use(req as never, {} as never, next);
      expect(next).toHaveBeenCalled();
    });

    it('负对照：前缀的**边界之外**（/api/adminx、/api/administrator）不得被误伤 —— 仍走玩家验签', async () => {
      for (const path of ['/api/adminx', '/api/administrator']) {
        await expect(
          middleware.use(makeReq({ originalUrl: path, url: path }) as never, {} as never, vi.fn()),
        ).rejects.toThrow(UnauthorizedException);
      }
    });
  });

  describe('protected paths (S1)', () => {
    it('rejects anonymous POST /api/rooms with 401', async () => {
      const req = makeReq({ originalUrl: '/api/rooms', url: '/api/rooms' });
      const next = vi.fn();

      const err = await useAndCatch(req);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err!.getStatus()).toBe(401);
      // §11.1：失败也走统一信封
      expect(err!.getResponse()).toMatchObject({ code: 10002, data: null });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a request with a malformed Authorization header', async () => {
      const req = makeReq({ headers: { authorization: 'Invalid token' } });
      await expect(middleware.use(req as never, {} as never, vi.fn())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an invalid or expired token', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });
      const req = makeReq({ headers: { authorization: 'Bearer expired-token' } });

      await expect(middleware.use(req as never, {} as never, vi.fn())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('verifies the token and attaches the user', async () => {
      mockJwtService.verify.mockReturnValue(validPayload());
      const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });
      const next = vi.fn();

      await middleware.use(req as never, {} as never, next);

      expect(mockJwtService.verify).toHaveBeenCalledWith('valid-token');
      expect((req as { user?: unknown }).user).toEqual({ sub: 'user-123', phone: '13800138000' });
      expect(next).toHaveBeenCalled();
    });
  });

  describe('token type (R24)', () => {
    it('rejects a refresh token used as an access token with 10005', async () => {
      mockJwtService.verify.mockReturnValue(validPayload({ typ: 'refresh' }));
      const req = makeReq({ headers: { authorization: 'Bearer refresh-token' } });

      const err = await useAndCatch(req);
      expect(err).not.toBeNull();
      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10005, data: null });
    });

    it('rejects a token with no typ at all (旧实现签发的令牌)', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 'user-123', phone: '13800138000', jti: 'jti-1' });
      const err = await useAndCatch(makeReq({ headers: { authorization: 'Bearer old-token' } }));

      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10005 });
    });

    it('rejects an access token without a jti (无处查白名单)', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 'user-123', phone: '13800138000', typ: 'access' });
      const err = await useAndCatch(makeReq({ headers: { authorization: 'Bearer no-jti' } }));

      expect(err!.getResponse()).toMatchObject({ code: 10005 });
    });
  });

  describe('session whitelist (R26)', () => {
    it('treats a valid signature as unauthenticated when session:{jti} is gone (10004)', async () => {
      mockJwtService.verify.mockReturnValue(validPayload({ jti: 'revoked-jti' }));
      session.isActive.mockResolvedValue(false);

      const err = await useAndCatch(makeReq({ headers: { authorization: 'Bearer valid-token' } }));

      expect(err!.getStatus()).toBe(401);
      expect(err!.getResponse()).toMatchObject({ code: 10004, data: null });
      expect(session.isActive).toHaveBeenCalledWith('revoked-jti');
    });

    it('stays 401 on a second request with the same revoked token (幂等)', async () => {
      mockJwtService.verify.mockReturnValue(validPayload({ jti: 'revoked-jti' }));
      session.isActive.mockResolvedValue(false);

      const first = await useAndCatch(makeReq({ headers: { authorization: 'Bearer valid-token' } }));
      const second = await useAndCatch(makeReq({ headers: { authorization: 'Bearer valid-token' } }));

      expect(first!.getResponse()).toMatchObject({ code: 10004 });
      expect(second!.getResponse()).toMatchObject({ code: 10004 });
      expect(session.isActive).toHaveBeenCalledTimes(2);
    });

    it('maps a Redis failure to 503 + 10007 instead of letting the request through', async () => {
      mockJwtService.verify.mockReturnValue(validPayload());
      session.isActive.mockRejectedValue(new Error('redis down'));
      const next = vi.fn();

      const err = await useAndCatch(makeReq({ headers: { authorization: 'Bearer valid-token' }, ...{} }));

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err!.getStatus()).toBe(503);
      expect(err!.getResponse()).toMatchObject({
        code: 10007,
        message: 'session store unavailable',
        data: null,
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('X-Token-Jti is logout-only (R31)', () => {
    it('injects the access jti on POST /api/auth/logout', async () => {
      mockJwtService.verify.mockReturnValue(validPayload({ jti: 'jti-logout' }));
      const req = makeReq({
        originalUrl: '/api/auth/logout',
        url: '/api/auth/logout',
        headers: { authorization: 'Bearer valid-token' },
      });

      await middleware.use(req as never, {} as never, vi.fn());

      expect(req.headers['x-token-jti']).toBe('jti-logout');
    });

    it('overwrites a client-supplied X-Token-Jti on logout', async () => {
      mockJwtService.verify.mockReturnValue(validPayload({ jti: 'real-jti' }));
      const req = makeReq({
        originalUrl: '/api/auth/logout',
        url: '/api/auth/logout',
        headers: { authorization: 'Bearer valid-token', 'x-token-jti': 'victim-jti' },
      });

      await middleware.use(req as never, {} as never, vi.fn());

      expect(req.headers['x-token-jti']).toBe('real-jti');
    });

    it('does not inject X-Token-Jti on any other protected path', async () => {
      mockJwtService.verify.mockReturnValue(validPayload({ jti: 'jti-1' }));
      const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });

      await middleware.use(req as never, {} as never, vi.fn());

      expect(req.headers['x-token-jti']).toBeUndefined();
    });
  });

  describe('identity injection (§5.2)', () => {
    it('injects X-User-Id after successful verification', async () => {
      mockJwtService.verify.mockReturnValue(validPayload());
      const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });

      await middleware.use(req as never, {} as never, vi.fn());

      expect(req.headers['x-user-id']).toBe('user-123');
    });

    it('injects X-Trace-Id after successful verification', async () => {
      mockJwtService.verify.mockReturnValue(validPayload());
      const req = makeReq({ headers: { authorization: 'Bearer valid-token' } });

      await middleware.use(req as never, {} as never, vi.fn());

      expect(typeof req.headers['x-trace-id']).toBe('string');
      expect((req.headers['x-trace-id'] as string).length).toBeGreaterThan(0);
    });

    it('discards a client-supplied X-User-Id (identity can only come from the token)', async () => {
      mockJwtService.verify.mockReturnValue(validPayload({ sub: 'real-user' }));
      const req = makeReq({
        headers: { authorization: 'Bearer valid-token', 'x-user-id': 'victim-user' },
      });

      await middleware.use(req as never, {} as never, vi.fn());

      expect(req.headers['x-user-id']).toBe('real-user');
    });
  });

  describe('internal service token (§5.2 rule 3)', () => {
    it('rejects an external request carrying X-Internal-Token with 403 + 10003（§11.2：10003 配 403）', async () => {
      const req = makeReq({ headers: { 'x-internal-token': INTERNAL } });

      const err = await useAndCatch(req);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err!.getStatus()).toBe(403);
      expect(err!.getResponse()).toMatchObject({ code: 10003, data: null });
    });

    it('rejects even when the internal token is valid and the bearer token is valid', async () => {
      mockJwtService.verify.mockReturnValue(validPayload({ sub: 'user-123' }));
      const req = makeReq({
        headers: { 'x-internal-token': INTERNAL, authorization: 'Bearer valid-token' },
      });

      await expect(middleware.use(req as never, {} as never, vi.fn())).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockJwtService.verify).not.toHaveBeenCalled();
    });

    it('rejects an internal-token request on a public path too', async () => {
      const req = makeReq({
        originalUrl: '/api/auth/login',
        url: '/api/auth/login',
        headers: { 'x-internal-token': INTERNAL },
      });

      await expect(middleware.use(req as never, {} as never, vi.fn())).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  /**
   * 日志身份归属不可伪造（复核⑩ / 判据 12）+ 写回一致性（判据 10 / Important-2）。
   *
   * ⚠️ 判据 12 只在**生产形态**下才有意义：`main.ts` 里网关形态的 trace 中间件是
   * **第一个** `app.use`，而 `JwtMiddleware` 是模块中间件（Nest init 期才注册、必然更晚）
   * ⇒ 归属被操纵的缺陷恰恰出在这条**组合链**上；单独直调 `JwtMiddleware` 时根本没有
   * ALS 上下文，断言会**空转**（改前改后都绿，那种「看起来完全正常」的错最危险）。
   * 因此这里先把 trace 中间件跑起来，把 `JwtMiddleware` 放进它的 `next()` 里 —— 这正是
   * Express 的同步链条语义，也是 ALS 上下文得以延续到「处理期间」的唯一方式
   * （`runWithTrace` 的作用域只覆盖它自己的 `next()`，出了回调就没有上下文了）。
   */
  describe('日志身份归属不可伪造（复核⑩ / 判据 12）', () => {
    /** `new Logger('Probe')`：用它证明「**处理期间**产生的日志」真的带上了上下文。 */
    const loggerInsideProbe = new Logger('Probe');

    /**
     * 生产链：网关形态的 trace 中间件（`main.ts` 的第一个 `app.use`）→ `JwtMiddleware` → 处理。
     *
     * ⚠️ `JwtMiddleware` 必须在 trace 中间件的 `next()` **之内**被调用：ALS 的上下文只在该
     * 作用域（及其派生的异步链）里可见 —— 先 `run` 完再单独调 `use` 是**测不出组合语义**的。
     */
    const runGatewayChain = async (req: ReturnType<typeof makeReq>): Promise<void> => {
      let handling: Promise<void> = Promise.resolve();
      createTraceMiddleware({ overwriteExisting: true })(
        req as never,
        { setHeader: vi.fn() } as never,
        () => {
          handling = middleware.use(req as never, {} as never, () => {
            loggerInsideProbe.log('in-handler');
          });
        },
      );
      await handling;
    };

    it('判据 12①：公开路径 + 客户端自带的 X-User-Id ⇒ 处理期间日志的 userId 必须是 null', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));

      const req = makeReq({
        originalUrl: '/api/auth/login',
        url: '/api/auth/login',
        headers: { 'x-user-id': 'victim' }, // 无 authorization ⇒ 公开路径
      });
      await runGatewayChain(req);

      const record = records.find((r) => r.msg === 'in-handler');
      expect(record, '处理期间必须真的产出一行日志，否则这条断言就是空转').toBeDefined();
      expect(record!.userId).toBeNull();
    });

    it('判据 12②：验签路径 ⇒ 处理期间日志的 userId 等于令牌里的 sub（不是头里的值）', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));

      mockJwtService.verify.mockReturnValue(validPayload({ sub: 'real-user' }));
      const req = makeReq({ headers: { authorization: 'Bearer valid-token', 'x-user-id': 'victim' } });
      await runGatewayChain(req);

      const record = records.find((r) => r.msg === 'in-handler');
      expect(record, '处理期间必须真的产出一行日志，否则这条断言就是空转').toBeDefined();
      expect(record!.userId).toBe('real-user');
    });

    it('判据 10 + Important-2：客户端带 X-Trace-Id ⇒ 不采信，且 `req.headers` 的写回与响应头**一致**', () => {
      const req = { headers: { 'x-trace-id': 'attacker-chosen' } };
      const res = { setHeader: vi.fn() };
      createTraceMiddleware({ overwriteExisting: true })(req as never, res as never, () => undefined);
      expect(req.headers['x-trace-id']).not.toBe('attacker-chosen');
      // ↑ 写回被钉住（Important-2）：删掉 `req.headers[…] = traceId` 那行，`headersOf()` 的转发
      //   会**静默断**（生成→转发→ALS→记录），而上面这条与下面这条会同时红。
      expect(res.setHeader).toHaveBeenCalledWith('X-Trace-Id', req.headers['x-trace-id']);
    });
  });
});

import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AuthController } from '../src/users/users.controller';
import type { AuthService } from '../src/auth/auth.service';
import { DomainError } from '../src/http/errors';

/**
 * `AuthController` 的 HTTP 边界测试（§5.1 / §11.1）。
 *
 * ⚠️ 为什么手搭 HTTP server 而不是 `@nestjs/testing`：
 * 本文件要断言「控制器产出 + 错误码→状态码映射」这两层，手搭能精确控制路由与打桩。
 * 这里也不引 `express` —— 它没有装进 `user-service` 的隔离 `node_modules`
 * （pnpm 不提升），用 node 内置 `http` 反而更少依赖。
 * （P18/N41 之前这里的理由是「Vitest 用 esbuild 转译，不发出 `design:paramtypes`，
 * 反射式构造注入在测试里拿不到依赖」—— 那条**已不再成立**：测试环境现在真的发出该元数据。）
 *
 * 服务端复刻 Nest 默认异常过滤器的行为：
 * `HttpException` → `res.status(getStatus()).json(getResponse())`，
 * 因此断言的正是「控制器产出 + 错误码→状态码映射」这两层。
 */
describe('AuthController（§5.1 / §11.1）', () => {
  let server: Server;
  let baseUrl: string;
  let auth: {
    register: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    auth = {
      register: vi.fn(),
      login: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
    };
    const controller = new AuthController(auth as unknown as AuthService);

    type Reply = { status: number; body: unknown };
    // 与 `src/main.ts` 一致：全局前缀是 /api；成功状态码与 @HttpCode 装饰器一致。
    const routes: Record<string, (body: any, headers: Record<string, string | string[] | undefined>) => Promise<Reply>> = {
      '/api/auth/register': async () => ({ status: 201, body: await controller.register({} as never) }),
      '/api/auth/login': async () => ({ status: 200, body: await controller.login({} as never) }),
      '/api/auth/refresh': async () => ({ status: 200, body: await controller.refresh({ refreshToken: 'r' }) }),
      '/api/auth/logout': async (_body, headers) => ({
        status: 200,
        body: await controller.logout(headers['x-token-jti'] as string | undefined, _body),
      }),
    };

    const readJson = async (req: IncomingMessage): Promise<any> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (chunks.length === 0) return undefined;
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        return undefined;
      }
    };

    server = createServer(async (req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      const route = routes[path];
      let reply: Reply;
      if (!route) {
        reply = { status: 404, body: { code: 10001, message: 'not found', data: null } };
      } else {
        try {
          reply = await route(await readJson(req), req.headers);
        } catch (err) {
          // 复刻 Nest 默认异常过滤器。
          reply =
            err instanceof HttpException
              ? { status: err.getStatus(), body: err.getResponse() }
              : { status: 500, body: { code: 10001, message: String(err), data: null } };
        }
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/auth/login 成功体是 { code: 0, data: { accessToken, refreshToken, user } }', async () => {
    auth.login.mockResolvedValue({
      accessToken: 'a',
      refreshToken: 'r',
      user: { id: 'u1', phone: '13800000001', nickname: null },
    });

    const resp = await post('/api/auth/login', { phone: '13800000001', password: 'passw0rd' });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      code: ErrCode.OK,
      data: { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', phone: '13800000001', nickname: null } },
    });
  });

  it('register 成功走 201 + 信封', async () => {
    auth.register.mockResolvedValue({
      accessToken: 'a2',
      refreshToken: 'r2',
      user: { id: 'u2', phone: '13800000002', nickname: 'n' },
    });

    const resp = await post('/api/auth/register', { phone: '13800000002', password: 'passw0rd' });
    expect(resp.status).toBe(201);
    expect(await resp.json()).toMatchObject({ code: ErrCode.OK, data: { accessToken: 'a2' } });
  });

  it('AuthService 抛 DomainError(PHONE_TAKEN) → 409 + { code: 11001, data: null }', async () => {
    auth.register.mockRejectedValue(new DomainError(ErrCode.PHONE_TAKEN, '手机号已注册'));

    const resp = await post('/api/auth/register', { phone: '13800000002', password: 'passw0rd' });
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.code).toBe(ErrCode.PHONE_TAKEN);
    expect(body.code).toBe(11001);
    expect(body.message).toBe('手机号已注册');
    expect(body.data).toBeNull();
  });

  it('login 凭证错误 → 401 + 11002、用户不存在 → 404 + 11004', async () => {
    auth.login.mockRejectedValueOnce(new DomainError(ErrCode.BAD_CREDENTIALS, '密码错误'));
    const bad = await post('/api/auth/login', { phone: '13800000001', password: 'x' });
    expect(bad.status).toBe(401);
    expect((await bad.json()).code).toBe(11002);

    auth.login.mockRejectedValueOnce(new DomainError(ErrCode.USER_NOT_FOUND, '用户不存在'));
    const missing = await post('/api/auth/login', { phone: '13800000009', password: 'x' });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe(11004);
  });

  it('POST /api/auth/refresh 返回轮换后的新一对', async () => {
    auth.refresh.mockResolvedValue({ accessToken: 'a3', refreshToken: 'r3' });

    const resp = await post('/api/auth/refresh', { refreshToken: 'r-old' });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ code: ErrCode.OK, data: { accessToken: 'a3', refreshToken: 'r3' } });
    expect(auth.refresh).toHaveBeenCalledWith('r', undefined); // 设备绑定片：第 2 参 = deviceId（本请求未带 ⇒ undefined）
  });

  it('refresh token 不可用 → 401 + 10004', async () => {
    auth.refresh.mockRejectedValue(new DomainError(ErrCode.TOKEN_EXPIRED, 'refresh token is not usable'));

    const resp = await post('/api/auth/refresh', { refreshToken: 'r-old' });
    expect(resp.status).toBe(401);
    expect((await resp.json()).code).toBe(10004);
  });

  it('logout 用 X-Token-Jti 作为 access jti，refresh 来自请求体', async () => {
    auth.logout.mockResolvedValue(undefined);

    const resp = await post('/api/auth/logout', { refreshToken: 'r-new' }, { 'x-token-jti': 'jti-1' });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ code: ErrCode.OK, data: null });
    expect(auth.logout).toHaveBeenCalledWith('jti-1', 'r-new');
  });

  it('logout 缺少 X-Token-Jti → 401 + 10002（R31：该头只服务这条路径）', async () => {
    const resp = await post('/api/auth/logout', { refreshToken: 'r-new' });
    expect(resp.status).toBe(401);
    expect((await resp.json()).code).toBe(10002);
    expect(auth.logout).not.toHaveBeenCalled();
  });
});

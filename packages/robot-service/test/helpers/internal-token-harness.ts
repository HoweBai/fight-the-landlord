import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { InternalTokenMiddleware } from '../../src/http/internal-token.middleware';

/**
 * 本片（N4/N7）四个服务共用的**中间件 HTTP 挂载**脚手架。
 *
 * 为什么手搭 node `http` server + 一个最小 express 形状适配器，而不是 `@nestjs/testing`
 * 或 supertest：各服务的隔离 `node_modules` 里 `supertest`/`express` 的可用性并不一致
 * （pnpm 不提升）—— 这样能**零新增依赖**地钉住中间件契约本身。
 * （P18/N41 之前这里还写了「Vitest/esbuild 不发出 `design:paramtypes`，真实 Nest DI
 * 在单测里不可用」—— 那条**已不再成立**：`vitest.config.ts` 的插件 +
 * `setupFiles: ['reflect-metadata']` 现在真的发出该元数据。）
 * 真实 Nest 装配由 user-service 的「接线探针」单独覆盖。
 */
export interface MountedMiddleware {
  server: Server;
  url: string;
}

export const mountInternalToken = (
  middleware: InternalTokenMiddleware,
): Promise<MountedMiddleware> =>
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

export const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

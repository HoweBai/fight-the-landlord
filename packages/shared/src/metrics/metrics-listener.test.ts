import { afterEach, describe, expect, it } from 'vitest';
import { createServer, get, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpMetricsMiddleware } from './http-metrics';
import { startMetricsListener } from './metrics-listener';
import { metricsRegistry } from './registry';

/**
 * C9 单测半边之「Bearer 守卫 fail-closed」：独立 `node:http` 服务器 +
 * `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`；**env 未设 ⇒ 一律 401**。
 *
 * ⚠️ 客户端用 `node:http`（**不用 fetch**）：Node fetch 有「封禁端口表」，会与
 * Windows 动态端口的假红家族撞车（已知假红⑤）；`agent: false` 避免 keep-alive
 * 连接把 `close()` 挂住。
 */

/** 先占一个 `listen(0)` 端口再释放（避开 Windows 动态端口上的已知竞态，仅此一处）。 */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
    },
  );
}

/** 非 GET 探测用（R3 补测：方法维度不留面）。 */
function httpRequest(method: string, port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startMetricsListener（C9②：守卫 fail-closed + 独立端口）', () => {
  const savedToken = process.env.INTERNAL_SERVICE_TOKEN;
  let closers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closers.map((c) => c.close()));
    closers = [];
    if (savedToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = savedToken;
  });

  async function start(): Promise<number> {
    const port = await freePort();
    closers.push(startMetricsListener({ port }));
    return port;
  }

  it('env 未设 ⇒ 一律 401：无 header 与「看起来正确」的 header 都拒（fail-closed）', async () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const port = await start();
    expect((await httpGet(port, '/metrics')).status).toBe(401);
    expect((await httpGet(port, '/metrics', { authorization: 'Bearer anything' })).status).toBe(401);
  });

  it('守卫：无 header / 错 token ⇒ 401；正确 Bearer ⇒ 200 且正文是 prom 文本（含 http_requests_total）', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'unit-test-token';
    // 监听器自身不吃中间件（见下一个用例）⇒ 手工走一遍中间件，让 http_requests_total 里有值
    const mw = createHttpMetricsMiddleware();
    const finishListeners: Array<() => void> = [];
    mw(
      { method: 'GET', route: { path: '/warmup' } },
      { statusCode: 200, on: (_e: string, l: () => void) => finishListeners.push(l) },
      () => {},
    );
    finishListeners.forEach((l) => l());

    const port = await start();
    expect((await httpGet(port, '/metrics')).status).toBe(401);
    expect((await httpGet(port, '/metrics', { authorization: 'Bearer wrong-token' })).status).toBe(401);

    const ok = await httpGet(port, '/metrics', { authorization: 'Bearer unit-test-token' });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('text/plain; version=0.0.4');
    expect(ok.body).toMatch(/^# TYPE http_requests_total counter$/m);
    expect(ok.body).toMatch(/^http_requests_total\{[^}]*route="\/warmup"[^}]*\} 1$/m);
  });

  it('其余路径 404（/metrics 之外不暴露任何东西，哪怕带了正确凭据）', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'unit-test-token';
    const port = await start();
    const other = await httpGet(port, '/debug/pprof', { authorization: 'Bearer unit-test-token' });
    expect(other.status).toBe(404);
    expect(other.body).not.toContain('http_requests_total');
  });

  it('非 GET 的 /metrics ⇒ 404（方法维度不留探测面；R3 补测——旧报告曾声称已有此用例，实际当时没有）', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'unit-test-token';
    const port = await start();
    const res = await httpRequest('POST', port, '/metrics', { authorization: 'Bearer unit-test-token' });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('http_requests_total');
  });

  it('监听器不经 HTTP 中间件：自抓取流量不增加 http_requests_total（设计「天然不吃自抓取流量」）', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'unit-test-token';
    const mw = createHttpMetricsMiddleware();
    const finishListeners: Array<() => void> = [];
    mw(
      { method: 'GET', route: { path: '/before-scrape' } },
      { statusCode: 200, on: (_e: string, l: () => void) => finishListeners.push(l) },
      () => {},
    );
    finishListeners.forEach((l) => l());

    const metric = metricsRegistry().getSingleMetric('http_requests_total');
    if (!metric) throw new Error('http_requests_total not registered');
    const sum = async () => (await metric.get()).values.reduce((n, v) => n + v.value, 0);
    const before = await sum();

    const port = await start();
    expect((await httpGet(port, '/metrics', { authorization: 'Bearer unit-test-token' })).status).toBe(200);
    expect(await sum()).toBe(before);
  });

  it('close() 之后再连 ⇒ 连接被拒（关闭语义是真的）', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'unit-test-token';
    const port = await freePort();
    const listener = startMetricsListener({ port });
    await listener.close();
    await expect(httpGet(port, '/metrics', { authorization: 'Bearer unit-test-token' })).rejects.toThrow();
  });
});

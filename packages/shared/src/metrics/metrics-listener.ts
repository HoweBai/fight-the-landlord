import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { initMetrics, metricsRegistry } from './registry';

/**
 * 指标监听：**独立** `node:http` 服务器（规格 §2.3；C9）。
 *
 * ## 为什么是独立服务器
 *
 *  1. 与主 HTTP 管线**完全平行** —— `internal-token.middleware.ts`（七份）一字不动，
 *     指标面也不受各服务的全局守卫/前缀影响；
 *  2. **不经** `createHttpMetricsMiddleware()`（设计 §「自身端口不经过它」）：
 *     否则 Prometheus 每 15s 的抓取会被计成 unmatched 流量，自抓取污染自己的读数。
 *
 * ## 守卫（fail-closed）
 *
 * `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`，与 env **全串比对**。
 * ⚠️ 两种拒付行为：
 *  - env **未设/空串** ⇒ **一律 401**（空串 = 未设，全仓口径）——「没配就放行」
 *    是 fail-open，等于把进程内存/事件循环详情裸露给任何能摸到端口的人；
 *  - token 从 `process.env` **逐请求**读取（不是在启动时快照）：env 在启动后才补齐/
 *    演练时轮换都立即生效，且单测可逐用例控制（prom-client 的 registry 是唯一的，
 *    服务器本身无状态）。
 *
 * 其余路径一律 404（含非 GET 的 `/metrics` —— 只有 `GET /metrics` 这一个端点，
 * 不给方法探测留任何面）。
 */
export function startMetricsListener(opts: { port: number }): { close(): Promise<void> } {
  // ⚠️ 默认集（process_*/nodejs_*）挂在这里注册：八个 main.ts 的接线只有两行
  //    （规格 §1.2：中间件 + 本函数），这里是「对外暴露 registry」的唯一边界 ⇒
  //    默认指标必须由它保证，否则 §2.2 的默认集一行也出不去。幂等（initMetrics 自兜）。
  initMetrics();

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  // ⚠️ 监听失败（端口被占等）必须**显式**处理（T1 审查 🟠R2 实跑证据：无 handler 时
  //    Node 在 server 上 emit 'error' 无监听者 ⇒ Unhandled 'error' ⇒ **整进程卸载**，
  //    连主业务一起死、且报错不可读）。口径 = fail-loud 但可读：结构化错误含端口号后
  //    `process.exit(1)`——指标面静默缺失比起不来更坏（对应 ServiceDown 兜底不变）。
  server.on('error', (err: Error) => {
    console.error(
      JSON.stringify({ level: 'fatal', service: 'metrics-listener', msg: 'metrics listener failed', port: opts.port, error: err.message }),
    );
    process.exit(1);
  });
  // 不传 host：监听全部接口（容器内 Prometheus 按容器 IP 抓取）；本机测试连 127.0.0.1
  server.listen(opts.port);

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // URL 可能带 query（`/metrics?x=1` 仍视作端点；Prometheus 不带 query，宽松一圈无害）
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'GET' || path !== '/metrics') {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found\n');
    return;
  }

  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  const provided = req.headers.authorization;
  if (!expected || provided !== `Bearer ${expected}`) {
    // 401 不带任何提示（不回显期望 token、不回显收到的值 —— 后者会把凭据写进日志侧）
    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized\n');
    return;
  }

  try {
    const body = await metricsRegistry().metrics();
    // 规格 §2.3 逐字：text/plain; version=0.0.4
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(body);
  } catch {
    // 采集失败也 fail-loud：500 会让 Prometheus 目标 down ⇒ ServiceDown 规则命中
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('metrics collection failed\n');
  }
}

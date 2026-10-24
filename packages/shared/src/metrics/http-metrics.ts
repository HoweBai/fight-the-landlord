import { createCounter, createHistogram } from './registry';

/**
 * 八服务的 HTTP 计数中间件（规格 §2.3；C9）。
 *
 * ## 为什么是结构类型、零 Nest/express 依赖
 *
 * 照 `logging/trace-middleware.ts` 先例：`packages/shared` 的 tsconfig 是
 * `"types": []`，参数形状就用最小结构描述，八个服务在 `main.ts` 里
 * `app.use(createHttpMetricsMiddleware())` 即可（**不** import `@nestjs/common`）。
 *
 * ## 为什么绝不用原始 URL 当标签
 *
 * URL 里的路径段/query（订单号、userId、`?token=`）会让标签基数**无界**，而它是
 * **请求方可控**的 —— 标签基数爆炸会打爆 Prometheus（内存 + 查询），是可被利用的
 * 面。因此只取 Express **路由模板**（`req.route.path`，如 `/rooms/:id`）；
 * 未匹配任何路由的请求（Express 不挂 `req.route`）合并进**唯一**串 `unmatched`
 * —— 原始 URL 在任何情况下都不进标签。
 *
 * ## 为什么在 `finish` 而不是在入口计数
 *
 * `finish` 时状态码才终局（handler 里 `setStatus`、抛错转 5xx 都发生在中途）；
 * 且中间件**插在 trace 之后、路由之前**（T2 接线），被守卫拒掉的 401/404 也会
 * 终局经过这里 —— 「拒了多少」本身就是要看的面。
 *
 * ⚠️ 两个指标**在模块级构造**：中间件可能被多次创建（每服务一次 + 测试），
 * 指标名重复注册会抛错 ⇒ 构造必须只发生一次（进程内 import 一次）。
 */

/** 9 桶（规格 §2.2）：覆盖本仓 REST 实测量级；上界 2.5s（更慢的都进 +Inf，不与业务超时赛跑）。 */
const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

const httpRequestsTotal = createCounter(
  'http_requests_total',
  'HTTP 请求数（按路由模板/方法/状态码；route="unmatched" 表示未匹配任何路由）。',
  ['method', 'route', 'status'],
);

const httpRequestDurationSeconds = createHistogram(
  'http_request_duration_seconds',
  'HTTP 请求耗时（秒，按路由模板/方法）。',
  ['method', 'route'],
  HTTP_DURATION_BUCKETS,
);

/**
 * Express 请求的**最小**结构（不 import express）：`route` 只在**匹配到路由**后存在，
 * `path` 是路由模板（不是 URL）。
 */
export interface HttpMetricsRequest {
  method: string;
  route?: { path?: string } | undefined;
}

/** Express 响应的**最小**结构：只消费 `finish`（那时状态码终局）。 */
export interface HttpMetricsResponse {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}

/**
 * 创建中间件。语义**只读**：从不写响应、从不吞 `next`（`finish` 的回调里才计数，
 * 任何响应路径都不受影响）。
 */
export function createHttpMetricsMiddleware(): (
  req: HttpMetricsRequest,
  res: HttpMetricsResponse,
  next: () => void,
) => void {
  return (req, res, next) => {
    // 单调时钟（hrtime）：墙钟被 NTP 校准/跳变时不会出现负耗时或尖刺
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ?? 'unmatched';
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
      // 状态码**不进**直方图标签（基数：状态码 × 路由 × 方法会再乘一档）
      httpRequestDurationSeconds.observe({ method: req.method, route }, seconds);
    });
    next();
  };
}

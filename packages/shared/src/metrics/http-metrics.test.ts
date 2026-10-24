import { describe, expect, it } from 'vitest';
import { createHttpMetricsMiddleware } from './http-metrics';
import { metricsRegistry } from './registry';

/**
 * C9 单测半边之「route 归一化」：中间件按 **Express 路由模板**（`req.route?.path`）
 * 打标签，绝不按原始 URL —— 原始 URL 里的 query 参数/路径段（如订单号、userId）
 * 会让标签基数无界（攻击者可控），最后把 Prometheus 打爆。
 *
 * ⚠️ 夹具是最小结构替身（不 import express）；`finish` 手动触发 —— 中间件只在
 * `res` 的 finish 事件那一刻计数（那时状态码才终局）。
 */

/** 最小 Express 形状替身。`routePath` 省略 = 请求未匹配任何路由（Express 不挂 req.route）。 */
function pair(url: string, routePath?: string, status = 200) {
  const finishListeners: Array<() => void> = [];
  const req = { method: 'GET', url, route: routePath === undefined ? undefined : { path: routePath } };
  const res = {
    statusCode: status,
    on(event: string, listener: () => void): unknown {
      if (event === 'finish') finishListeners.push(listener);
      return undefined;
    },
  };
  return { req, res, finish: () => finishListeners.forEach((l) => l()) };
}

const seriesOf = async (name: string) => {
  const metric = metricsRegistry().getSingleMetric(name);
  if (!metric) throw new Error(`metric not registered: ${name}`);
  return (await metric.get()).values;
};

/** 走一遍中间件：断言 next 被调用（不许吞链）、响应被碰过（不许改响应），然后触发 finish。 */
function runThrough(mw: ReturnType<typeof createHttpMetricsMiddleware>, url: string, routePath?: string, status = 200) {
  const { req, res, finish } = pair(url, routePath, status);
  let nexted = 0;
  mw(req, res, () => (nexted += 1));
  expect(nexted).toBe(1);
  expect(res.statusCode).toBe(status);
  finish();
}

describe('createHttpMetricsMiddleware（C9①：route 归一化）', () => {
  it('不同 query 的同 path 合并成一条：计数在**模板** route 上（原始 URL 绝不出现在标签里）', async () => {
    const mw = createHttpMetricsMiddleware();
    runThrough(mw, '/rooms/1?token=a', '/rooms/:id');
    runThrough(mw, '/rooms/2?token=b', '/rooms/:id');
    runThrough(mw, '/rooms/3?token=c', '/rooms/:id');

    const values = await seriesOf('http_requests_total');
    const hit = values.filter((v) => v.labels.route === '/rooms/:id');
    expect(hit).toHaveLength(1);
    expect(hit[0].value).toBe(3);
    expect(hit[0].labels).toMatchObject({ method: 'GET', status: '200' });

    // 负例：带 query 的原始 URL 没有以任何形式成为标签值
    const text = await metricsRegistry().metrics();
    expect(text).not.toContain('?token=');
  });

  it('无 route（未匹配）⇒ 合并进唯一的 unmatched 串，不同 URL 也不再各自成串', async () => {
    const mw = createHttpMetricsMiddleware();
    runThrough(mw, '/no-such-route/a');
    runThrough(mw, '/no-such-route/b?x=1');

    const values = await seriesOf('http_requests_total');
    const hit = values.filter((v) => v.labels.route === 'unmatched' && v.labels.status === '200');
    expect(hit).toHaveLength(1);
    expect(hit[0].value).toBe(2);
  });

  it('状态码进 counter 标签（401/404 也在数里 —— 中间件插在路由之前）', async () => {
    const mw = createHttpMetricsMiddleware();
    runThrough(mw, '/secret', undefined, 401);

    const values = await seriesOf('http_requests_total');
    const hit = values.find((v) => v.labels.route === 'unmatched' && v.labels.status === '401');
    expect(hit?.value).toBe(1);
  });

  it('只在 res finish 时刻计数：响应未结束前不落值', async () => {
    const mw = createHttpMetricsMiddleware();
    const { req, res, finish } = pair('/pending', '/pending');
    mw(req, res, () => {});

    let values = await seriesOf('http_requests_total');
    expect(values.some((v) => v.labels.route === '/pending')).toBe(false);
    finish();
    values = await seriesOf('http_requests_total');
    expect(values.find((v) => v.labels.route === '/pending')?.value).toBe(1);
  });

  it('直方图：9 个显式桶边界 + +Inf 恰 10 档，且**不**带状态码标签（防基数）', async () => {
    const mw = createHttpMetricsMiddleware();
    runThrough(mw, '/timed', '/timed');

    const text = await metricsRegistry().metrics();
    const bucketLines = text
      .split('\n')
      .filter((l) => l.startsWith('http_request_duration_seconds_bucket{') && l.includes('route="/timed"'));
    const les = bucketLines.map((l) => /le="([^"]+)"/.exec(l)![1]);
    expect(new Set(les)).toEqual(new Set(['+Inf', '0.005', '0.01', '0.025', '0.05', '0.1', '0.25', '0.5', '1', '2.5']));
    expect(bucketLines.every((l) => !l.includes('status='))).toBe(true);
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/timed"} 1');
  });

  it('registry 输出整体可被 prom 语法解析（每个样本行都合形）', async () => {
    const mw = createHttpMetricsMiddleware();
    runThrough(mw, '/syntax', '/syntax');
    const text = await metricsRegistry().metrics();
    const sampleLines = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(sampleLines.length).toBeGreaterThan(0);
    for (const line of sampleLines) {
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{.*\})? [0-9eE+.-]+$/);
    }
  });
});

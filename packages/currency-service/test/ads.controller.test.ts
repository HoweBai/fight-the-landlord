/**
 * 广告片 T11 + T14 链接 + **v1.4 T0 回填（GET/JSON 化）**：**回调入口防护链**套件
 * （真 Nest 管线 + 真 HTTP —— 状态码不是手写的）。
 *
 * 覆盖面（三块）：
 *  ① 常量/路由钉与 main.ts 三处接线（§2.4 三件套；含**勘误① 防回归负钉**——前缀豁免
 *     不得回退字面量形态）；
 *  ② 防护链（**v1.4：405（非 GET）→ 429（限流）→ ③ 业务链**）：方法闸 + 顺序判据
 *     （405 不咨询限流；429 不达链）+ 四 outcome 的 JSON 编码 + 豁免面三态
 *     （公开路径可达 / 近邻负例 / `/api/ad/*` 前缀面）；
 *  ③ 注册面（未注册 = 真容器 404）。
 *
 * ─── 🔴 勘误①（实现期；已落控制者的规格修订记录）──────────────────────────
 * Nest 的 `setGlobalPrefix('api', { exclude })` 把**整条路由模式串**
 * （`'/ad/notify/:provider'`）与 exclude 的 pathToRegexp 正则做 exec；字符串字面量
 * `'/ad/notify/uniad'` 的 regexp 匹配不到 `:provider` 模式 ⇒ 排除不生效、路由被注册到
 * `/api/ad/notify/:provider`，公开路径 `/ad/notify/uniad` 恒 **404**（本仓实测：简报
 * 原判据「不得 401」会被 404 **假通过**）。修法 = exclude 改 RouteInfo
 * `{ path: AD_NOTIFY_ROUTE, method: RequestMethod.ALL }`；中间件豁免保持单常量字面量。
 * 下面②首例把三态（200 真值 / 404 复发 / 401 豁免失效）钉死；① 有源码级负钉。
 *
 * ─── v1.4 回填后退役面（原 POST 时代）────────────────────────────────────
 * 415 内容类型闸、413 体积闸、`AD_NOTIFY_CONTENT_TYPE` / `AD_NOTIFY_MAX_BODY_BYTES`
 * 随 GET 化删除（字段走 query、无 body）；应答从 text/plain `success/failure` 改为
 * JSON `{"isValid":true|false}`（405 面向非平台流量，维持 text/plain `failure`、
 * 无 isValid 语义）。
 *
 * ─── ③ 业务位（T14 落地）────────────────────────────────────────────────
 * 方法闸/限流之后的业务链（验签 → claim → 账本先行 → 裁决 → apply → done）在
 * `AdCallbackService.processCallback`；本套件在 ③ 位注入**结果可脚本化**的替身
 * （真链行为面在 `ad-callback.test.ts`），钉「结果 → 状态码 + JSON」的 v1.4 §2.4 表
 * 映射（`AD_NOTIFY_MAP`）与 ②→③ 链序，并钉控制器把从 `req.url` 解析的 **query**
 * 原样递链。
 *
 * ⚠️ HTTP 客户端一律 `node:http`（避 `fetch` 的 Windows 封禁端口假红族⑤；照 boot 纪律）。
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequestRaw } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Module, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { createInternalTokenMiddleware, DEFAULT_EXEMPT_PATHS } from '../src/http/internal-token.middleware';
import { AdRateLimiter } from '../src/ads/ad-rate-limiter';
import { AD_NOTIFY_MAP, AD_NOTIFY_PATH, AD_NOTIFY_ROUTE, AdsController } from '../src/ads/ads.controller';
import { AdCallbackService } from '../src/ads/ad-callback.service';
import type { AdCallbackOutcome } from '../src/ads/ad-callback.service';
import type { RewardedCallbackRequest } from '../src/ads/ads-verifier';
import { reliefCallbackTotal } from '../src/metrics/currency.metrics';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const MAIN_SRC = readFileSync(join(PACKAGE_DIR, 'src/main.ts'), 'utf-8');
const CONTROLLER_SRC = readFileSync(join(PACKAGE_DIR, 'src/ads/ads.controller.ts'), 'utf-8');

/* ------------------------------ HTTP 帮助函数 ------------------------------ */

function httpCall(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = httpRequestRaw(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/* ======================================================================== *
 * ① 常量 / 路由钉 / main.ts 接线（§2.4）
 * ======================================================================== */
describe('① 常量、路由钉与 main.ts 接线（v1.4 §2.4）', () => {
  it('常量逐字：公开路径 · 路由模式（16KB/内容类型常量已随 GET 化退役）', () => {
    expect(AD_NOTIFY_PATH).toBe('/ad/notify/uniad');
    expect(AD_NOTIFY_ROUTE).toBe('ad/notify/:provider');
  });

  it("控制器源码逐字含 `@All('ad/notify/:provider')` + GET-only 自检（与 AD_NOTIFY_ROUTE 对钉——防两处漂移）", () => {
    expect(CONTROLLER_SRC).toContain("@All('ad/notify/:provider')");
    expect(CONTROLLER_SRC).toContain("req.method !== 'GET'");
  });

  it('main.ts 三处接线在场：rawBody:true · token 中间件精确豁免（单常量字面量）· 前缀豁免 RouteInfo（勘误①）', () => {
    expect(MAIN_SRC).toMatch(/rawBody:\s*true/);
    expect(MAIN_SRC).toMatch(
      /createInternalTokenMiddleware\(\s*\[\s*\.\.\.DEFAULT_EXEMPT_PATHS\s*,\s*AD_NOTIFY_PATH\s*\]\s*\)/,
    );
    expect(MAIN_SRC).toMatch(
      /setGlobalPrefix\(\s*'api'\s*,\s*\{\s*exclude:\s*\[\s*\{\s*path:\s*AD_NOTIFY_ROUTE\s*,\s*method:\s*RequestMethod\.ALL\s*\}\s*\]\s*\}\s*\)/,
    );
  });

  it('勘误① 负钉：main.ts **不得**出现字面量形态 `exclude: [AD_NOTIFY_PATH]`（实测 404——防「简化」复发）', () => {
    expect(MAIN_SRC).not.toMatch(/exclude:\s*\[\s*AD_NOTIFY_PATH\s*\]/);
  });

  it('relief_callback_total 指标在场：name 逐字 + result 五值域（写点 T14——本任务只落定义）', async () => {
    const metric = await reliefCallbackTotal.get();
    expect(metric.name).toBe('relief_callback_total');
    const allowed = ['accepted', 'claim_invalid', 'bad_sign', 'malformed', 'error'];
    for (const value of metric.values) {
      expect(allowed).toContain(String(value.labels.result));
    }
  });
});

/* ======================================================================== *
 * ② 防护链（真 HTTP，与 main.ts 同形装配）
 * ======================================================================== */

/** 路由面假限流器（真实现的行为面在 `ad-rate-limiter.test.ts`）；`calls` 用于顺序判据。 */
class FakeRateLimiter {
  exceededNow = false;
  calls = 0;
  async exceeded(): Promise<boolean> {
    this.calls += 1;
    return this.exceededNow;
  }
}

/**
 * ③ 位替身（T14）：结果可脚本化（真链行为面在 `ad-callback.test.ts`）。
 * 记录每次入参——钉控制器把从 `req.url` 解析的 **query**（URLSearchParams）递给链
 * （v1.4：GET 无 body；形状解析单一真源 = 验签器）。
 */
class FakeCallbackService {
  outcome: AdCallbackOutcome = 'success-terminal';
  calls: RewardedCallbackRequest[] = [];
  async processCallback(request: RewardedCallbackRequest): Promise<AdCallbackOutcome> {
    this.calls.push(request);
    return this.outcome;
  }
}

describe('② 防护链（真 HTTP，与 main.ts 同形装配；v1.4 GET/JSON）', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let port = 0;
  let rateLimiter: FakeRateLimiter;
  let callback: FakeCallbackService;
  const savedToken = process.env.INTERNAL_SERVICE_TOKEN;

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'ads-test-token';
    rateLimiter = new FakeRateLimiter();
    callback = new FakeCallbackService();

    @Module({
      controllers: [AdsController],
      providers: [
        { provide: AdRateLimiter, useValue: rateLimiter },
        { provide: AdCallbackService, useValue: callback },
      ],
    })
    class AdsProbeModule {}

    app = await NestFactory.create(AdsProbeModule, { logger: false, rawBody: true });
    // 与 src/main.ts 逐字同形（差异面 = trace/metrics 中间件——与防护无关）。
    app.use(createInternalTokenMiddleware([...DEFAULT_EXEMPT_PATHS, AD_NOTIFY_PATH]));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api', { exclude: [{ path: AD_NOTIFY_ROUTE, method: RequestMethod.ALL }] });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    if (savedToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = savedToken;
  });

  const TOKEN = { 'x-internal-token': 'ads-test-token' };
  /** 平台形态的 GET 回调探针（query 带 v1.4 字段样例；具体验签由真链测试覆盖）。 */
  const probePath =
    AD_NOTIFY_PATH + '?' + new URLSearchParams({ extra: 'probe-nonce-0000000000000', trans_id: 'T-1' });

  it('公开路径三态判明（**勘误① 防回归**）：无 token GET ⇒ 恰 200 + JSON isValid:true（404 = 字面量 exclude 复发；401 = token 豁免失效）', async () => {
    callback.outcome = 'success-terminal';
    const res = await httpCall(port, probePath);
    expect(res.status).toBe(200);
    expect(res.body).toBe(JSON.stringify({ isValid: true }));
    expect(String(res.headers['content-type'])).toMatch(/^application\/json/);
  });

  it('豁免面①：无 token 的 GET 回调可达控制器（edge 直连形态）⇒ ③ 全链通；控制器把 req.url 的 query 原样递链', async () => {
    const callsBefore = rateLimiter.calls;
    const callbackCallsBefore = callback.calls.length;
    callback.outcome = 'success-terminal';
    const res = await httpCall(port, probePath);
    expect(res.status).toBe(200);
    expect(res.body).toBe(JSON.stringify({ isValid: true }));
    expect(rateLimiter.calls).toBe(callsBefore + 1); // ② 被咨询 ⇒ 链序确实达 ③
    // ③ 收到的是 {query: URLSearchParams}（v1.4：无 headers/rawBody——GET 无 body）
    expect(callback.calls.length).toBe(callbackCallsBefore + 1);
    const passed = callback.calls[callback.calls.length - 1]!;
    expect(passed.query).toBeInstanceOf(URLSearchParams);
    expect(passed.query.get('extra')).toBe('probe-nonce-0000000000000');
    expect(passed.query.get('trans_id')).toBe('T-1');
  });

  it('③ 结果 → 状态码 + JSON 映射（v1.4 §2.4 表；四结果各走真 HTTP 一例）', async () => {
    const cases: Array<{ outcome: AdCallbackOutcome; status: number; body: string }> = [
      { outcome: 'success-terminal', status: 200, body: JSON.stringify({ isValid: true }) },
      { outcome: 'reject-sign', status: 200, body: JSON.stringify({ isValid: true }) }, // 坏签名归终态（有意口径）
      { outcome: 'reject-malformed', status: 200, body: JSON.stringify({ isValid: true }) }, // 畸形归终态
      { outcome: 'transient', status: 503, body: JSON.stringify({ isValid: false }) }, // 瞬态 ⇒ 平台重投
    ];
    for (const c of cases) {
      callback.outcome = c.outcome;
      const res = await httpCall(port, probePath);
      expect(res.status, c.outcome).toBe(c.status);
      expect(res.body, c.outcome).toBe(c.body);
      expect(String(res.headers['content-type']), c.outcome).toMatch(/^application\/json/);
    }
    // 映射表本体同核对（真 HTTP 未走别的路径）
    expect(AD_NOTIFY_MAP).toEqual({
      'success-terminal': { status: 200, body: JSON.stringify({ isValid: true }) },
      'reject-sign': { status: 200, body: JSON.stringify({ isValid: true }) },
      'reject-malformed': { status: 200, body: JSON.stringify({ isValid: true }) },
      transient: { status: 503, body: JSON.stringify({ isValid: false }) },
    });
  });

  it('豁免面②（精确负对照）：`/ad/notify/uniadx` 无 token ⇒ 401；带 token 的 GET ⇒ 200 JSON（:provider 预留段可达链面，非 404）', async () => {
    callback.outcome = 'success-terminal'; // 前序四 outcome 用例残留值归零
    const anon = await httpCall(port, `${AD_NOTIFY_PATH}x`);
    expect(anon.status).toBe(401); // 豁免单常量**精确**——近邻不得豁免
    const withToken = await httpCall(port, `${AD_NOTIFY_PATH}x`, { headers: TOKEN });
    expect(withToken.status).toBe(200); // 令牌面穿过 ⇒ 路由 :provider 在场且走完 ③（404 则路线不在）
    expect(withToken.body).toBe(JSON.stringify({ isValid: true }));
  });

  it('方法闸：非 GET（POST）⇒ 405 + 纯文本 failure（@All 接全动词——无 isValid 语义；面向非平台流量）', async () => {
    const res = await httpCall(port, AD_NOTIFY_PATH, { method: 'POST', body: 'a=1' });
    expect(res.status).toBe(405);
    expect(res.body).toBe('failure');
    expect(String(res.headers['content-type'])).toMatch(/^text\/plain/);
  });

  it('顺序判据：POST ⓸ 405 时限流**不被咨询**（方法闸最先）；超桶 GET ⇒ 429 JSON false 且 ③ 未达（限流先于链）', async () => {
    const callsBeforePost = rateLimiter.calls;
    const chainBeforePost = callback.calls.length;
    const post = await httpCall(port, AD_NOTIFY_PATH, { method: 'POST', body: 'a=1' });
    expect(post.status).toBe(405);
    expect(rateLimiter.calls).toBe(callsBeforePost); // ① 方法闸先于 ②
    expect(callback.calls.length).toBe(chainBeforePost);

    rateLimiter.exceededNow = true;
    try {
      const callsBefore = rateLimiter.calls;
      const chainBefore = callback.calls.length;
      const limited = await httpCall(port, probePath);
      expect(limited.status).toBe(429);
      expect(limited.body).toBe(JSON.stringify({ isValid: false }));
      expect(String(limited.headers['content-type'])).toMatch(/^application\/json/);
      expect(rateLimiter.calls).toBe(callsBefore + 1); // ② 咨询恰一次、③ 未达
      expect(callback.calls.length).toBe(chainBefore);
    } finally {
      rateLimiter.exceededNow = false;
    }
  });

  it('路由挂载点：`/api/ad/notify/uniad` —— 无 token ⇒ 401；带 token ⇒ 404（该面不在前缀豁免）', async () => {
    const noToken = await httpCall(port, `/api${AD_NOTIFY_PATH}`);
    expect(noToken.status).toBe(401);
    const withToken = await httpCall(port, `/api${AD_NOTIFY_PATH}`, { headers: TOKEN });
    expect(withToken.status).toBe(404);
  });
});

/* ======================================================================== *
 * ③ 模块注册面
 * ======================================================================== */
describe('③ 模块注册面（T11 纪律：未注册 = 真容器 404）', () => {
  it('AdsController ∈ AppModule.controllers', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(AdsController);
  });
});

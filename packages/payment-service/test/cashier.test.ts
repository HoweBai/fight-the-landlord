/**
 * 支付片：wap.pay 桥接页套件（`GET /pay/cashier/:orderNo?t=…`）。
 *
 * 三块：
 *  ① `cashier-token.ts` 纯函数：签发/校验往返 · 路径绑定 · 时效 · ttlMin 形状 ·
 *     畸形/篡改/错密钥/空 secret 一律 null（不抛、不区分）；
 *  ② `cashier-page.ts` 纯函数：表单自动提交形态 + 全插值 HTML 转义（含头与安全头素材）；
 *  ③ **真 Nest node:http 管线**（照 orders-state.test.ts ⑧ 纪律）：main.ts 同款装配
 *     （内部 token 中间件前缀豁免 + setGlobalPrefix exclude）——200 HTML / 无 t·坏 t 404 /
 *     missing 404 / gone 410 / 渠道 15001 ⇒ 502 / 公开面免内部 token 而 /api/* 401 /
 *     前缀豁免的唯一形态（/api/pay/cashier/* 不是路由）。
 *
 * HTTP 客户端一律 `node:http`（**不用 fetch**——避 Windows 封禁端口假红族⑤）。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { request as httpRequestRaw } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
// ⚠️ **值导入**：类同时是 DI token（探针模块 provide）。
import { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  CASHIER_EXEMPT_PREFIX,
  CASHIER_ROUTE,
  CashierController,
} from '../src/cashier/cashier.controller';
import {
  cashierTokenSecret,
  signCashierToken,
  verifyCashierToken,
} from '../src/cashier/cashier-token';
import { escapeHtml, renderCashierMessagePage, renderCashierPage } from '../src/cashier/cashier-page';
import { OrdersService } from '../src/orders/orders.service';
import { AlipayClient } from '../src/channel/alipay/client';
import type { PaymentChannel } from '../src/channel/payment-channel.interface';
// ⚠️ **值导入**：同时是 DI token（探针模块 provide；import type 会在运行期 undefined）。
import { ConfigCacheService } from '../src/config/config-cache.service';
// ⚠️ **值导入**：PayChannelConfigService/ScanService 同时是 DI token。
import { PayChannelConfigService } from '../src/config/pay-channel.config.service';
import { ScanService } from '../src/scan/scan.service';
import { createInternalTokenMiddleware, DEFAULT_EXEMPT_PATHS } from '../src/http/internal-token.middleware';

/* ======================================================================== *
 * ① token 纯函数
 * ======================================================================== */
describe('① cashier-token：无状态 HMAC 能力 token', () => {
  const SECRET = 'cashier-token-suite-secret';
  const NOW = 1_792_000_000_000;
  const payload = { orderNo: 'pay_abc123', expMs: NOW + 30 * 60_000, ttlMin: 30 };

  it('签发⇒校验往返：还原载荷；expMs/ttlMin 逐字', () => {
    const token = signCashierToken(payload, SECRET);
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/); // base64url.body.base64url.mac
    const got = verifyCashierToken(token, SECRET, NOW, 'pay_abc123');
    expect(got).toEqual(payload);
  });

  it('路径绑定：token 签给 A 单、拿去验 B 单 ⇒ null（capability 不串单）', () => {
    const token = signCashierToken(payload, SECRET);
    expect(verifyCashierToken(token, SECRET, NOW, 'pay_other')).toBeNull();
    // 不传 expectedOrderNo 时只校验 token 自身（控制器始终传，这层只是纯函数语义）。
    expect(verifyCashierToken(token, SECRET, NOW)?.orderNo).toBe('pay_abc123');
  });

  it('时效：nowMs ≥ expMs ⇒ null（过期链接当场死）', () => {
    const token = signCashierToken(payload, SECRET);
    expect(verifyCashierToken(token, SECRET, payload.expMs)).toBeNull(); // 边界：相等即过期
    expect(verifyCashierToken(token, SECRET, payload.expMs + 1)).toBeNull();
    expect(verifyCashierToken(token, SECRET, payload.expMs - 1)).not.toBeNull();
  });

  it('载荷形状：ttlMin≤0 / 非有限数 / orderNo 空 / 非对象 ⇒ null（签名有效也不认）', () => {
    const macOf = (body: unknown): string => {
      const signed = signCashierToken(body as Parameters<typeof signCashierToken>[0], SECRET);
      return signed.slice(signed.indexOf('.') + 1);
    };
    const wrap = (body: unknown): string => {
      const b64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
      return `${b64}.${macOf(body)}`;
    };
    expect(verifyCashierToken(wrap({ ...payload, ttlMin: 0 }), SECRET, NOW, 'pay_abc123')).toBeNull();
    expect(verifyCashierToken(wrap({ ...payload, ttlMin: -1 }), SECRET, NOW, 'pay_abc123')).toBeNull();
    expect(verifyCashierToken(wrap({ ...payload, expMs: NaN }), SECRET, NOW, 'pay_abc123')).toBeNull();
    expect(verifyCashierToken(wrap({ ...payload, orderNo: '' }), SECRET, NOW, '')).toBeNull();
    expect(verifyCashierToken(wrap([payload]), SECRET, NOW, 'pay_abc123')).toBeNull();
    expect(verifyCashierToken(wrap('x'), SECRET, NOW, 'pay_abc123')).toBeNull();
  });

  it('畸形/篡改/错密钥/空 secret ⇒ null（不抛）', () => {
    const token = signCashierToken(payload, SECRET);
    const dot = token.indexOf('.');
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);

    expect(verifyCashierToken('', SECRET, NOW)).toBeNull();
    expect(verifyCashierToken('no-dot', SECRET, NOW)).toBeNull();
    expect(verifyCashierToken('two.dots.here', SECRET, NOW)).toBeNull();
    expect(verifyCashierToken('.', SECRET, NOW)).toBeNull();
    expect(verifyCashierToken(`${body}.`, SECRET, NOW)).toBeNull();
    expect(verifyCashierToken(`.${mac}`, SECRET, NOW)).toBeNull();
    expect(verifyCashierToken(token, 'wrong-secret', NOW)).toBeNull();
    expect(verifyCashierToken(token, '', NOW)).toBeNull();
    // body 非 JSON 但 mac 合法（自造）
    const badJson = Buffer.from('not-json', 'utf8').toString('base64url');
    const badJsonMac = createHmac('sha256', SECRET).update(badJson).digest('base64url');
    expect(verifyCashierToken(`${badJson}.${badJsonMac}`, SECRET, NOW)).toBeNull();
    // mac 长度不对（timingSafeEqual 的长度闸）
    expect(verifyCashierToken(`${body}.${mac.slice(0, -1)}`, SECRET, NOW)).toBeNull();
    // 篡改 body 末位（mac 不重算）⇒ 签名不符
    const flipped = body.endsWith('A') ? `${body.slice(0, -1)}B` : `${body.slice(0, -1)}A`;
    expect(verifyCashierToken(`${flipped}.${mac}`, SECRET, NOW)).toBeNull();
  });

  it('cashierTokenSecret：读 INTERNAL_SERVICE_TOKEN（env 空串 = 未设）', () => {
    const saved = process.env.INTERNAL_SERVICE_TOKEN;
    try {
      process.env.INTERNAL_SERVICE_TOKEN = 'from-env';
      expect(cashierTokenSecret()).toBe('from-env');
      delete process.env.INTERNAL_SERVICE_TOKEN;
      expect(cashierTokenSecret()).toBe('');
    } finally {
      if (saved === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
      else process.env.INTERNAL_SERVICE_TOKEN = saved;
    }
  });
});

/* ======================================================================== *
 * ② 页面纯函数
 * ======================================================================== */
describe('② cashier-page：自动提交表单 HTML', () => {
  const model = {
    gatewayUrl: 'https://openapi-sandbox.example.test/gateway.do',
    fields: {
      method: 'alipay.trade.wap.pay',
      app_id: '2021000000000001',
      sign: 'fake-sign-abc',
      biz_content: '{"out_trade_no":"pay_abc123"}',
    },
  };

  it('form：POST 到网关、隐藏字段逐字在场、自动 submit + noscript 手动通道', () => {
    const html = renderCashierPage(model);
    expect(html).toContain('<form id="pay" method="post" action="https://openapi-sandbox.example.test/gateway.do">');
    expect(html).toContain('name="method" value="alipay.trade.wap.pay"');
    expect(html).toContain('name="sign" value="fake-sign-abc"');
    expect(html).toContain('name="biz_content" value="{&quot;out_trade_no&quot;:&quot;pay_abc123&quot;}');
    expect(html).toMatch(/<script>document\.forms\[0\]\.submit\(\);<\/script>/);
    expect(html).toContain('<noscript>');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  it('转义：网关/字段名/字段值里的 & < > " \' 全实体化（无属性逃逸）', () => {
    const evil = '" onmouseover="alert(1)"><script>x</script>&\'<';
    const html = renderCashierPage({ gatewayUrl: `https://g.test/?a=${evil}`, fields: { evil } });
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(escapeHtml(evil)).not.toContain('<');
  });

  it('消息页：title/message 同样转义（404/410/502 终态素材）', () => {
    const html = renderCashierMessagePage('订单已关闭<b>x</b>', '请重新发起<script>1</script>');
    expect(html).toContain('订单已关闭&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('请重新发起&lt;script&gt;1&lt;/script&gt;');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });
});

/* ======================================================================== *
 * ③ 真 Nest 管线
 * ======================================================================== */

const BASE = 'https://ssh.example.test';
const SECRET = 'cashier-http-suite-secret';

interface CashierRow {
  order_no: string;
  status: string;
  package_yuan: number;
  amount_fen: number;
  expires_at: Date;
}

/** 只实现桥接两条读语句的假 DB（形状镜像 orders.service.ts，漂移由 orders-state 套件钉）。 */
class CashierDb {
  rows: CashierRow[] = [];
  now = new Date('2026-10-06T04:00:00.000Z');

  get dataSource(): DataSource {
    return this as unknown as DataSource;
  }

  seed(over: Partial<CashierRow> & { order_no: string }): CashierRow {
    const row: CashierRow = {
      status: 'created',
      package_yuan: 6,
      amount_fen: 600,
      expires_at: new Date(this.now.getTime() + 30 * 60_000),
      ...over,
    };
    this.rows.push(row);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    const no = String(params[0]);
    if (sql === 'SELECT `status`, `package_yuan`, `amount_fen` FROM `payment_orders` WHERE `order_no` = ?') {
      const row = this.rows.find((r) => r.order_no === no);
      return row ? [{ status: row.status, package_yuan: row.package_yuan, amount_fen: row.amount_fen }] : [];
    }
    if (
      sql ===
      "SELECT 1 AS `ok` FROM `payment_orders` WHERE `order_no` = ? AND `status` = 'created' AND `expires_at` > NOW(3)"
    ) {
      const row = this.rows.find((r) => r.order_no === no);
      return row && row.status === 'created' && row.expires_at.getTime() > this.now.getTime() ? [{ ok: 1 }] : [];
    }
    throw new Error(`cashier 探针收到意外 SQL：${sql}`);
  }
}

const DEFAULT_CASHIER_URL =
  'https://mobileclientgw-sandbox.dl.alipaydev.com/cashier/mobilepay.htm?invoke=default&sign=x';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function makeChannel(
  over: {
    createPayUrl?: PaymentChannel['createPayUrl'];
    resolveMobileCashier?: PaymentChannel['resolveMobileCashier'];
  } = {},
) {
  const impl: PaymentChannel['createPayUrl'] =
    over.createPayUrl ??
    (async (req) => ({
      ok: true as const,
      data: {
        gatewayUrl: 'https://openapi-sandbox.example.test/gateway.do',
        fields: {
          method: 'alipay.trade.wap.pay',
          app_id: '2021000000000001',
          out_trade_no: req.outTradeNo,
          total_amount: req.totalAmount,
          subject: req.subject,
          sign: 'sandbox-fake-sign',
        },
      },
    }));
  const createPayUrl = vi.fn(impl);
  const resolveMobileCashier = vi.fn(
    over.resolveMobileCashier ??
      (async () => ({ ok: true as const, data: { cashierUrl: DEFAULT_CASHIER_URL } })),
  );
  return {
    createPayUrl,
    resolveMobileCashier,
    channel: { createPayUrl, resolveMobileCashier } as unknown as AlipayClient,
  };
}

function httpCall(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequestRaw(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {}, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface Probe {
  port: number;
  db: CashierDb;
  createPayUrl: ReturnType<typeof makeChannel>['createPayUrl'];
  resolveMobileCashier: ReturnType<typeof makeChannel>['resolveMobileCashier'];
  close: () => Promise<void>;
}

async function startProbe(
  channelOver: {
    createPayUrl?: PaymentChannel['createPayUrl'];
    resolveMobileCashier?: PaymentChannel['resolveMobileCashier'];
  } = {},
): Promise<Probe> {
  const db = new CashierDb();
  const { channel, createPayUrl, resolveMobileCashier } = makeChannel(channelOver);

  @Module({
    controllers: [CashierController],
    providers: [
      OrdersService,
      { provide: DataSource, useValue: db.dataSource },
      { provide: ConfigCacheService, useValue: {} as ConfigCacheService },
      { provide: AlipayClient, useValue: channel },
      {
        provide: PayChannelConfigService,
        useValue: { get: async () => ({ 'pay.channel.publicBaseUrl': BASE }) } as unknown as PayChannelConfigService,
      },
      { provide: ScanService, useValue: { creditOrder: async () => 'skipped' } },
    ],
  })
  class CashierProbeModule {}

  // 与 main.ts 同款装配（逐字：中间件两参 + 全局前缀 exclude）。
  const app = await NestFactory.create(CashierProbeModule, { logger: false });
  app.use(createInternalTokenMiddleware(DEFAULT_EXEMPT_PATHS, [CASHIER_EXEMPT_PREFIX]));
  app.setGlobalPrefix('api', { exclude: [CASHIER_ROUTE] });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { port, db, createPayUrl, resolveMobileCashier, close: () => app.close() };
}

const savedInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = SECRET;
});
afterAll(() => {
  if (savedInternalToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
  else process.env.INTERNAL_SERVICE_TOKEN = savedInternalToken;
});

const tokenFor = (orderNo: string, ttlMin = 30, expMs = Date.now() + ttlMin * 60_000): string =>
  signCashierToken({ orderNo, expMs, ttlMin }, SECRET);

describe('③ 桥接页真 HTTP 管线（main.ts 同款装配）', () => {
  it('有效 token + 可支付单 ⇒ 200 HTML：安全头 + 自动提交表单 + 现场重签入参', async () => {
    const probe = await startProbe();
    try {
      probe.db.seed({ order_no: 'pay_http0001' });
      const res = await httpCall(probe.port, `/pay/cashier/pay_http0001?t=${encodeURIComponent(tokenFor('pay_http0001'))}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('method="post" action="https://openapi-sandbox.example.test/gateway.do"');
      expect(res.body).toContain('name="out_trade_no" value="pay_http0001"');
      expect(res.body).toContain('name="total_amount" value="6.00"');
      expect(res.body).toMatch(/document\.forms\[0\]\.submit\(\)/);

      expect(probe.createPayUrl).toHaveBeenCalledTimes(1);
      expect(probe.createPayUrl).toHaveBeenCalledWith({
        outTradeNo: 'pay_http0001',
        subject: '金币充值 6 元',
        totalAmount: '6.00',
        timeoutExpress: '30m',
        notifyUrl: `${BASE}/pay/notify/alipay`,
        returnUrl: `${BASE}/?pay=pay_http0001`,
      });
    } finally {
      await probe.close();
    }
  });

  it('无 t / 坏 t / 签给别的单的 t ⇒ 一律 404（不区分不存在与非法；零渠道调用）', async () => {
    const probe = await startProbe();
    try {
      probe.db.seed({ order_no: 'pay_http0002' });
      const noToken = await httpCall(probe.port, '/pay/cashier/pay_http0002');
      const badToken = await httpCall(probe.port, '/pay/cashier/pay_http0002?t=not-a-token');
      const otherToken = await httpCall(
        probe.port,
        `/pay/cashier/pay_http0002?t=${encodeURIComponent(tokenFor('pay_someone_else'))}`,
      );
      const expired = await httpCall(
        probe.port,
        `/pay/cashier/pay_http0002?t=${encodeURIComponent(tokenFor('pay_http0002', 30, Date.now() - 1000))}`,
      );
      for (const res of [noToken, badToken, otherToken, expired]) {
        expect(res.status).toBe(404);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toContain('支付链接无效');
      }
      expect(probe.createPayUrl).not.toHaveBeenCalled();
    } finally {
      await probe.close();
    }
  });

  it('单号形状不符白名单 ⇒ 404（不触 DB/渠道；含大写/点/斜杠外字符）', async () => {
    const probe = await startProbe();
    try {
      const upper = await httpCall(probe.port, `/pay/cashier/PAY_HTTP?${`t=${tokenFor('PAY_HTTP')}`}`);
      const dotted = await httpCall(probe.port, `/pay/cashier/pay.x?t=${encodeURIComponent(tokenFor('pay.x'))}`);
      expect(upper.status).toBe(404);
      expect(dotted.status).toBe(404);
      expect(probe.createPayUrl).not.toHaveBeenCalled();
    } finally {
      await probe.close();
    }
  });

  it('token 有效但无此单 ⇒ 404；closed/过期 ⇒ 410', async () => {
    const probe = await startProbe();
    try {
      probe.db.seed({ order_no: 'pay_httpgone1', expires_at: new Date(probe.db.now.getTime() - 1000) });
      probe.db.seed({ order_no: 'pay_httpgone2', status: 'closed' });

      const missing = await httpCall(
        probe.port,
        `/pay/cashier/pay_missing?t=${encodeURIComponent(tokenFor('pay_missing'))}`,
      );
      const expired = await httpCall(
        probe.port,
        `/pay/cashier/pay_httpgone1?t=${encodeURIComponent(tokenFor('pay_httpgone1'))}`,
      );
      const closed = await httpCall(
        probe.port,
        `/pay/cashier/pay_httpgone2?t=${encodeURIComponent(tokenFor('pay_httpgone2'))}`,
      );
      expect(missing.status).toBe(404);
      expect(missing.body).toContain('订单不存在');
      expect(expired.status).toBe(410);
      expect(closed.status).toBe(410);
      expect(expired.body).toContain('已关闭或超过支付时限');
      expect(probe.createPayUrl).not.toHaveBeenCalled();
    } finally {
      await probe.close();
    }
  });

  it('现场重签渠道失败（15001）⇒ 502 中文提示页（不外溢成 200/500）', async () => {
    const probe = await startProbe({
      createPayUrl: async () => ({
        ok: false,
        code: ErrCode.PAY_CHANNEL_ERROR,
        lastError: '40004/ACQ.INVALID_SIGN: 签名无效',
        channelCode: '40004',
        channelSubCode: 'ACQ.INVALID_SIGN',
      }),
    });
    try {
      probe.db.seed({ order_no: 'pay_http0003' });
      const res = await httpCall(probe.port, `/pay/cashier/pay_http0003?t=${encodeURIComponent(tokenFor('pay_http0003'))}`);
      expect(res.status).toBe(502);
      expect(res.body).toContain('支付渠道暂时不可用');
    } finally {
      await probe.close();
    }
  });

  it('边界装配：公开面免内部 token；/api/* 无 token ⇒ 401；/api/pay/cashier/* 不存在（exclude 唯一形态）', async () => {
    const probe = await startProbe();
    try {
      probe.db.seed({ order_no: 'pay_http0004' });

      // 桥接面不带 x-internal-token 照样 200（豁免靠 HMAC token 自守）。
      const ok = await httpCall(probe.port, `/pay/cashier/pay_http0004?t=${encodeURIComponent(tokenFor('pay_http0004'))}`);
      expect(ok.status).toBe(200);

      // 任意 /api/* 缺内部 token ⇒ 401（中间件在路由前）。
      const apiNoToken = await httpCall(probe.port, '/api/pay/orders/mine');
      expect(apiNoToken.status).toBe(401);
      expect(JSON.parse(apiNoToken.body) as { code: number }).toMatchObject({ code: ErrCode.UNAUTHENTICATED });

      // 带了内部 token 后，/api/pay/cashier/* 仍不是路由（全局前缀 exclude：路由只在无前缀面）。
      const apiCashier = await httpCall(probe.port, '/api/pay/cashier/pay_http0004', {
        headers: { 'x-internal-token': SECRET },
      });
      expect(apiCashier.status).toBe(404);
    } finally {
      await probe.close();
    }
  });

  it('手机 UA + 代发成功 ⇒ 302 直达手机收银台签发地址（安全头齐备；入参是现场重签表单）', async () => {
    const probe = await startProbe();
    try {
      probe.db.seed({ order_no: 'pay_httpmob1' });
      const res = await httpCall(probe.port, `/pay/cashier/pay_httpmob1?t=${encodeURIComponent(tokenFor('pay_httpmob1'))}`, {
        headers: { 'User-Agent': ANDROID_UA },
      });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(DEFAULT_CASHIER_URL);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toBe('');

      expect(probe.createPayUrl).toHaveBeenCalledTimes(1); // 现场重签仍只一次
      expect(probe.resolveMobileCashier).toHaveBeenCalledTimes(1);
      const arg = probe.resolveMobileCashier.mock.calls[0]![0] as {
        gatewayUrl: string;
        fields: Record<string, string>;
      };
      expect(arg.gatewayUrl).toBe('https://openapi-sandbox.example.test/gateway.do');
      expect(arg.fields).toMatchObject({
        method: 'alipay.trade.wap.pay',
        out_trade_no: 'pay_httpmob1',
        total_amount: '6.00',
        sign: 'sandbox-fake-sign',
      });
    } finally {
      await probe.close();
    }
  });

  it('手机 UA + 代发失败（15001）⇒ 回退 200 自动提交表单页（链路不死；不回 5xx）', async () => {
    const probe = await startProbe({
      resolveMobileCashier: async () => ({
        ok: false,
        code: ErrCode.PAY_CHANNEL_ERROR,
        lastError: '网关未签发手机收银台地址（HTTP 200）',
        channelCode: null,
        channelSubCode: null,
      }),
    });
    try {
      probe.db.seed({ order_no: 'pay_httpmob2' });
      const res = await httpCall(probe.port, `/pay/cashier/pay_httpmob2?t=${encodeURIComponent(tokenFor('pay_httpmob2'))}`, {
        headers: { 'User-Agent': ANDROID_UA },
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('method="post" action="https://openapi-sandbox.example.test/gateway.do"');
      expect(res.body).toMatch(/document\.forms\[0\]\.submit\(\)/);
      expect(probe.resolveMobileCashier).toHaveBeenCalledTimes(1);
    } finally {
      await probe.close();
    }
  });

  it('桌面 UA ⇒ 不代发：仍 200 自动提交表单（代发是手机专属路径）', async () => {
    const probe = await startProbe();
    try {
      probe.db.seed({ order_no: 'pay_httpmob3' });
      const res = await httpCall(probe.port, `/pay/cashier/pay_httpmob3?t=${encodeURIComponent(tokenFor('pay_httpmob3'))}`, {
        headers: { 'User-Agent': DESKTOP_UA },
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('method="post" action="https://openapi-sandbox.example.test/gateway.do"');
      expect(probe.resolveMobileCashier).not.toHaveBeenCalled();
    } finally {
      await probe.close();
    }
  });
});

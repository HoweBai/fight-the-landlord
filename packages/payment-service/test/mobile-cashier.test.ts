/**
 * 支付片：手机端「服务端代发 → 直跳手机收银台」套件。
 *
 * 两块：
 *  ① `mobile-ua.ts` 纯函数：手机 UA 开关（Android/iPhone/鸿蒙/移动内核 ⇒ true；桌面/空 ⇒ false）；
 *  ② `AlipayClient.resolveMobileCashier`：已签名 wap 表单以手机 UA POST、不跟随 302，
 *     回收手机收银台签发地址——成功面 · 404 首跳重试 · 非重定向/外域/非 https/传输失败
 *     一律失败面（15001 + `payment_outbound_fail_total{api="wap_pay"}`）· 域白名单纯函数。
 *
 * 代发传输用替身注入（不经真网络；生产走 node:https，见 mobile-cashier-post.ts）。
 */
import { describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  ALIPAY_HTTP_TIMEOUT_MS,
  AlipayClient,
  MOBILE_CASHIER_ATTEMPTS,
  MOBILE_CASHIER_USER_AGENT,
  isSafeCashierUrl,
} from '../src/channel/alipay/client';
import type { MobileFormPost, MobileFormPostResult } from '../src/channel/alipay/mobile-cashier-post';
import type { PaymentChannel, WapPayFormData } from '../src/channel/payment-channel.interface';
import type { PayChannelConfigService } from '../src/config/pay-channel.config.service';
import { isMobileUserAgent } from '../src/cashier/mobile-ua';
import { paymentOutboundFailTotal } from '../src/metrics/payment.metrics';

/* ======================================================================== *
 * ① 手机 UA 判别
 * ======================================================================== */
describe('① isMobileUserAgent：手机端桥接开关', () => {
  it('手机端标记 ⇒ true（Android/iPhone/iPad/鸿蒙/Mobile 内核）', () => {
    for (const ua of [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'Mozilla/5.0 (Phone; OpenHarmony 4.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 HarmonyOS/4.1 Mobile Safari/537.36',
      'SomeWeirdBrowser/1.0 Mobile',
    ]) {
      expect(isMobileUserAgent(ua), ua).toBe(true);
    }
  });

  it('桌面 UA / 空值 ⇒ false（维持浏览器自发表单路径）', () => {
    for (const ua of [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '',
      undefined,
      null,
    ]) {
      expect(isMobileUserAgent(ua ?? undefined), String(ua)).toBe(false);
    }
  });
});

/* ======================================================================== *
 * ② 代发回收手机收银台签发地址
 * ======================================================================== */

const GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
const CASHIER =
  'https://mobileclientgw-sandbox.dl.alipaydev.com/cashier/mobilepay.htm?alipay_exterface_invoke_assign_target=invoke_x&alipay_exterface_invoke_assign_sign=ab%2Fcd';

const form = (over: Partial<WapPayFormData['fields']> = {}): WapPayFormData => ({
  gatewayUrl: GATEWAY,
  fields: {
    method: 'alipay.trade.wap.pay',
    app_id: '9021000165640423',
    out_trade_no: 'pay_mobile0001',
    total_amount: '6.00',
    sign: 'fake-sign',
    ...over,
  },
});

/** 组装直构 client（fetch/渠道图在代发面不用；mobilePost 替身记录调用）。 */
function makeClient(results: Array<MobileFormPostResult | Error>) {
  const calls: Array<{ gatewayUrl: string; body: string; ua: string; timeoutMs: number }> = [];
  const mobilePost: MobileFormPost = vi.fn(async (gatewayUrl, body, ua, timeoutMs) => {
    calls.push({ gatewayUrl, body, ua, timeoutMs });
    const r = results.shift();
    if (r instanceof Error) throw r;
    return r as MobileFormPostResult;
  });
  const client = new AlipayClient(
    undefined as unknown as typeof fetch,
    undefined as unknown as PayChannelConfigService,
    mobilePost,
  );
  return { client: client as PaymentChannel, calls };
}

const failCounter = async (): Promise<number> => {
  const metric = await paymentOutboundFailTotal.get();
  return metric.values.find((v) => v.labels.api === 'wap_pay')?.value ?? 0;
};

describe('② AlipayClient.resolveMobileCashier：手机收银台代发', () => {
  it('302 + 手机收银台 Location ⇒ 成功：表单逐字/手机 UA/5s 超时/只调一次', async () => {
    const { client, calls } = makeClient([{ status: 302, location: CASHIER }]);

    const res = await client.resolveMobileCashier(form());

    expect(res).toMatchObject({ ok: true, data: { cashierUrl: CASHIER } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.gatewayUrl).toBe(GATEWAY);
    expect(calls[0]!.ua).toBe(MOBILE_CASHIER_USER_AGENT);
    expect(calls[0]!.timeoutMs).toBe(ALIPAY_HTTP_TIMEOUT_MS);
    // 已签名表单逐字编码重放（含 method/out_trade_no/sign）。
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get('method')).toBe('alipay.trade.wap.pay');
    expect(body.get('out_trade_no')).toBe('pay_mobile0001');
    expect(body.get('total_amount')).toBe('6.00');
    expect(body.get('sign')).toBe('fake-sign');
  });

  it('首跳 404（沙箱抖动）⇒ 重试一次后 302 仍算成功（至多 MOBILE_CASHIER_ATTEMPTS 次）', async () => {
    const { client, calls } = makeClient([
      { status: 404, location: null },
      { status: 302, location: CASHIER },
    ]);

    const res = await client.resolveMobileCashier(form());

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(MOBILE_CASHIER_ATTEMPTS);
    expect((res as { data: { cashierUrl: string } }).data.cashierUrl).toBe(CASHIER);
  });

  it('两跳都非重定向（桌面集群 200 HTML）⇒ 失败面 15001 + wap_pay 计数 +1', async () => {
    const before = await failCounter();
    const { client, calls } = makeClient([
      { status: 200, location: null },
      { status: 200, location: null },
    ]);

    const res = await client.resolveMobileCashier(form());

    expect(res).toMatchObject({ ok: false, code: ErrCode.PAY_CHANNEL_ERROR });
    expect(calls).toHaveLength(MOBILE_CASHIER_ATTEMPTS);
    expect(await failCounter()).toBe(before + 1);
  });

  it('两跳都传输失败（超时/断连）⇒ 失败面 15001（错误被收口，不外抛）', async () => {
    const { client } = makeClient([
      new Error('alipay mobile cashier POST timeout after 5000ms'),
      new Error('socket hang up'),
    ]);

    const res = await client.resolveMobileCashier(form());

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(ErrCode.PAY_CHANNEL_ERROR);
      expect(res.lastError).toContain('hang up'); // 末跳摘要保留（不抛原始异常到控制器）
    }
  });

  it('Location 落在外域/非 https ⇒ 一律失败（防开放重定向；不被 Location 带出支付宝域）', async () => {
    const evil = [
      'https://evil.example.com/cashier/mobilepay.htm',
      'https://alipay.com.evil.com/x',
      'https://notalipay.com/?next=alipay.com',
      'http://mobileclientgw-sandbox.dl.alipaydev.com/cashier/mobilepay.htm',
    ];
    for (const location of evil) {
      const { client } = makeClient([
        { status: 302, location },
        { status: 302, location },
      ]);
      const res = await client.resolveMobileCashier(form());
      expect(res.ok, location).toBe(false);
    }
  });

  it('Location 头缺失/空白 ⇒ 失败（302 也不跳空地址）', async () => {
    const { client } = makeClient([
      { status: 302, location: null },
      { status: 302, location: '   ' },
    ]);
    const res = await client.resolveMobileCashier(form());
    expect(res.ok).toBe(false);
  });

  it('表单缺 out_trade_no ⇒ 失败摘要面不崩（订单号回落 "-"）', async () => {
    const { client } = makeClient([
      { status: 200, location: null },
      { status: 200, location: null },
    ]);
    const f = form();
    delete f.fields.out_trade_no;
    const res = await client.resolveMobileCashier(f);
    expect(res.ok).toBe(false);
  });
});

describe('② isSafeCashierUrl：签发地址域白名单（纯函数）', () => {
  it('支付宝/沙箱官方 https 域 ⇒ true', () => {
    for (const url of [
      'https://mobileclientgw-sandbox.dl.alipaydev.com/cashier/mobilepay.htm?x=1',
      'https://mclient.alipay.com/cashier/mobilepay.htm',
      'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
      'https://alipay.com/',
      'https://alipaydev.com/',
    ]) {
      expect(isSafeCashierUrl(url), url).toBe(true);
    }
  });

  it('外域/伪域/http/畸形 ⇒ false', () => {
    for (const url of [
      'https://evil.com/',
      'https://alipay.com.evil.com/',
      'https://evilalipay.com/',
      'http://mclient.alipay.com/',
      '//mclient.alipay.com/',
      'javascript:alert(1)',
      'not-a-url',
      '',
    ]) {
      expect(isSafeCashierUrl(url), url).toBe(false);
    }
  });
});

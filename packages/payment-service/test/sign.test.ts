/**
 * 支付片 T6：渠道层套件（任务卡 Test: `sign.test.ts` —— 正反 + 篡改负例）。
 *
 * 覆盖面（七块）：
 *  ① ⚙️6-①通知验签：金标回放（成功回调 / 金额不符）+ 篡改负例（金额/签名/参数集/公钥错配）；
 *  ② ⚙️6 规范化语义：排序/排除集/特殊字符值（`&`/`=`/中文/JSON 引号）/空值口径/子串判别力；
 *  ③ ⚙️6-②响应验签：`<api>_response` **原文子串**金标回放 + 篡改负例 + 形状负例；
 *  ④ ⚙️6 出站签名：确定向量回放（PKCS#1 v1.5 确定性）+ 篡改负例 + 插入序无关；
 *  ⑤ ⚙️5 金额格式化：分↔元字符串逐字（`0.01/0.10/1.00/500.00`）+ 非法串 ⇒ null；
 *  ⑥ AlipayClient 行为：密钥缺失/坏 ⇒ 15001 + `payment_outbound_fail_total{api}`（每次恰 +1）
 *     · 渠道图（`PayChannelConfigService`）**每次调用现拉** · 出站体（表单+签名）自验 · 响应一律过 verifyResponse ·
 *     传输/非 200/业务错误路径 · timeout signal · lastError ≤255 截断；
 *  ⑦ 模块注册面：`AlipayClient` 在 AppModule providers（未注册 = 单测全绿而真容器解析不到）。
 *
 * 金标材料 = `test/fixtures/alipay/*.json`（`generate-fixtures.mjs` 一次性生成、已入仓；
 * 测试**不硬编码任何 PEM/签名**，只回放 fixture —— 换密钥对 = 重跑生成脚本）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSign, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrCode } from '@fight-the-landlord/protocol';
import type { PayChannelKey } from '@fight-the-landlord/protocol';
import { AlipayClient, formatAlipayTimestamp } from '../src/channel/alipay/client';
import {
  buildNotifySignSource,
  buildRequestSignSource,
  extractResponseSignSource,
  fen2yuan,
  yuan2fen,
} from '../src/channel/alipay/params';
import { signRequest, verifyNotify, verifyResponse } from '../src/channel/alipay/sign';
import { PayChannelConfigService } from '../src/config/pay-channel.config.service';
import { paymentOutboundFailTotal } from '../src/metrics/payment.metrics';
import { AppModule } from '../src/app.module';

/* ------------------------------- fixture 装载 ------------------------------- */

const FIXTURES = fileURLToPath(new URL('./fixtures/alipay', import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

interface KeyFixture {
  appPrivatePem: string;
  appPublicPem: string;
  alipayPrivatePem: string;
  alipayPublicPem: string;
}
interface NotifyFixture {
  name: string;
  params: Record<string, string>;
  expect: { verifyNotify: boolean };
}
interface ResponseFixture {
  name: string;
  api: string;
  rawBody: string;
  expect: { verifyResponse: boolean; extractedNode: string };
}
interface RequestSignFixture {
  name: string;
  params: Record<string, string>;
  expect: { signSource: string; sign: string };
}

const keys = load<KeyFixture>('keys.json');
const notifySuccess = load<NotifyFixture>('notify-success.json');
const notifyMismatch = load<NotifyFixture>('notify-amount-mismatch.json');
const queryResponse = load<ResponseFixture>('query-response.json');
const refundResponse = load<ResponseFixture>('refund-response.json');
const requestSign = load<RequestSignFixture>('request-sign.json');

const signWithAlipay = (source: string): string =>
  createSign('RSA-SHA256').update(source, 'utf8').sign(keys.alipayPrivatePem, 'base64');

/** 测试内构造一枚渠道签名的 OpenAPI 响应体（node 原文子串 = JSON.stringify(node)）。 */
const signedResponse = (apiName: string, node: Record<string, unknown>): string => {
  const src = JSON.stringify(node);
  const key = `${apiName.replace(/\./g, '_')}_response`;
  return `{"${key}":${src},"sign":"${signWithAlipay(src)}"}`;
};

/* ======================================================================== *
 * ① ⚙️6-① 通知验签（金标回放 + 篡改负例）
 * ======================================================================== */
describe('⚙️6① 通知验签（form 解码后原文、除 sign/sign_type、ASCII 升序）', () => {
  it('金标回放：成功回调（TRADE_SUCCESS）验签通过', () => {
    expect(verifyNotify(notifySuccess.params, keys.alipayPublicPem)).toBe(true);
  });

  it('分层判据：金额不符 fixture 的**签名仍然有效**（amount_mismatch 属业务校验，归 T8）', () => {
    expect(verifyNotify(notifyMismatch.params, keys.alipayPublicPem)).toBe(true);
    // 自证：两个 fixture 的业务差异真的存在（否则本用例退化为重复）
    expect(notifyMismatch.params.total_amount).not.toBe(notifySuccess.params.total_amount);
  });

  it('参数字典的插入序无关：乱序重排后仍通过（规范化自行排序）', () => {
    const shuffled = Object.fromEntries(Object.entries(notifySuccess.params).reverse());
    expect(verifyNotify(shuffled, keys.alipayPublicPem)).toBe(true);
  });

  it('负例：篡改 total_amount（不改签名）⇒ 拒', () => {
    const tampered = { ...notifySuccess.params, total_amount: '7.00' };
    expect(verifyNotify(tampered, keys.alipayPublicPem)).toBe(false);
  });

  it('负例：篡改 out_trade_no ⇒ 拒', () => {
    const tampered = { ...notifySuccess.params, out_trade_no: 'pay_other0000000000' };
    expect(verifyNotify(tampered, keys.alipayPublicPem)).toBe(false);
  });

  it('负例：改签名 ⇒ 拒', () => {
    const bogus = Buffer.alloc(256, 7).toString('base64');
    expect(verifyNotify({ ...notifySuccess.params, sign: bogus }, keys.alipayPublicPem)).toBe(false);
  });

  it('负例：多塞一个参数（不改签名）⇒ 拒（参数集本身是签名输入）', () => {
    expect(verifyNotify({ ...notifySuccess.params, extra: 'x' }, keys.alipayPublicPem)).toBe(false);
  });

  it('负例：缺 sign ⇒ 拒（不可验 = 不可信）', () => {
    const { sign: _drop, ...unsigned } = notifySuccess.params;
    expect(verifyNotify(unsigned, keys.alipayPublicPem)).toBe(false);
  });

  it('负例：公钥错配（拿应用公钥验渠道签名）⇒ 拒', () => {
    expect(verifyNotify(notifySuccess.params, keys.appPublicPem)).toBe(false);
  });

  it('⚙️6 逐字：sign_type 被排除在规范化之外 —— 单改 sign_type 不影响验签结果', () => {
    expect(verifyNotify({ ...notifySuccess.params, sign_type: 'RSA' }, keys.alipayPublicPem)).toBe(true);
  });
});

/* ======================================================================== *
 * ② ⚙️6 规范化语义（含特殊字符与低置信登记）
 * ======================================================================== */
describe('⚙️6 规范化语义（排序/排除集/特殊字符值/原文子串）', () => {
  it('通知规范化：按参数名 ASCII 升序、`k=v` 以 `&` 连接、排除 sign/sign_type', () => {
    expect(buildNotifySignSource({ b: '2', sign_type: 'RSA2', a: '1', sign: 'zzz' })).toBe('a=1&b=2');
  });

  it('特殊字符值（`&`/`=`/中文）：值取解码后原文、**不二次编码**', () => {
    const params = { b: '中文值', a: 'x=1&y=2' };
    const source = buildNotifySignSource(params);
    expect(source).toBe('a=x=1&y=2&b=中文值'); // `&`/`=` 原样在串里（不是 %26/%3D）
    const signed = { ...params, sign: signWithAlipay(source) };
    expect(verifyNotify(signed, keys.alipayPublicPem)).toBe(true);
  });

  it('JSON 引号/花括号值（fund_bill_list 形态）原样参与 —— 金标里就有', () => {
    expect(buildNotifySignSource(notifySuccess.params)).toContain(
      'fund_bill_list=[{"amount":"6.00","fundChannel":"ALIPAYACCOUNT"}]',
    );
  });

  it('出站规范化：全参数 + sign_type=RSA2 同序（排除 sign；插入序无关）', () => {
    const params = { method: 'm', app_id: 'a', sign: 'dropped' };
    expect(buildRequestSignSource(params)).toBe('app_id=a&method=m&sign_type=RSA2');
    // 传别的 sign_type 会被覆盖为 RSA2（本项目只支持 RSA2；注释已声明该覆盖语义）
    expect(buildRequestSignSource({ ...params, sign_type: 'RSA1' })).toBe('app_id=a&method=m&sign_type=RSA2');
  });

  it('低置信登记（空值参数）：按逐字口径空值**参与**规范化（官方文档另有「空值不参与」一说 —— T16 联调批复核）', () => {
    expect(buildNotifySignSource({ b: 'x', a: '' })).toBe('a=&b=x');
    const params = { a: '', b: 'x' };
    const signed = { ...params, sign: signWithAlipay(buildNotifySignSource(params)) };
    expect(verifyNotify(signed, keys.alipayPublicPem)).toBe(true);
  });

  it('响应原文子串工具：从金标 rawBody 抽出的就是签名时所签的那段', () => {
    expect(extractResponseSignSource(queryResponse.rawBody, queryResponse.api)).toBe(
      queryResponse.expect.extractedNode,
    );
    expect(extractResponseSignSource(refundResponse.rawBody, refundResponse.api)).toBe(
      refundResponse.expect.extractedNode,
    );
  });

  it('原文子串语义判别力：带空格的节点照原文验签；**重序列化对不上**（不是重排序/重编码）', () => {
    const nodeSrc = '{ "code": "10000", "trade_status": "TRADE_SUCCESS" }'; // 原文含空格
    const rawBody = `{"alipay_trade_query_response": ${nodeSrc},"sign":"${signWithAlipay(nodeSrc)}"}`;
    expect(extractResponseSignSource(rawBody, 'alipay.trade.query')).toBe(nodeSrc);
    expect(verifyResponse('alipay.trade.query', rawBody, keys.alipayPublicPem)).toBe(true);
    // 判别力自证：若实现改成「解析后 JSON.stringify(node)」则字节不同 ⇒ 会红
    expect(JSON.stringify(JSON.parse(nodeSrc))).not.toBe(nodeSrc);
  });

  it('含转义/中文节点：原文子串逐字节成立', () => {
    const nodeSrc = JSON.stringify({ code: '10000', subject: '金币充值 6 元 "附注"' });
    const rawBody = `{"alipay_trade_query_response":${nodeSrc},"sign":"${signWithAlipay(nodeSrc)}"}`;
    expect(verifyResponse('alipay.trade.query', rawBody, keys.alipayPublicPem)).toBe(true);
    expect(extractResponseSignSource(rawBody, 'alipay.trade.query')).toBe(nodeSrc);
  });
});

/* ======================================================================== *
 * ③ ⚙️6-② 响应验签（金标回放 + 篡改负例）
 * ======================================================================== */
describe('⚙️6② OpenAPI 同步响应验签（<api>_response 原文子串）', () => {
  it('金标回放：查询响应 / 退款响应都通过', () => {
    expect(verifyResponse(queryResponse.api, queryResponse.rawBody, keys.alipayPublicPem)).toBe(true);
    expect(verifyResponse(refundResponse.api, refundResponse.rawBody, keys.alipayPublicPem)).toBe(true);
  });

  it('负例：篡改节点里的金额（不改签名）⇒ 拒', () => {
    const tampered = queryResponse.rawBody.replace('"total_amount":"6.00"', '"total_amount":"7.00"');
    expect(tampered).not.toBe(queryResponse.rawBody); // 自证替换真的发生
    expect(verifyResponse(queryResponse.api, tampered, keys.alipayPublicPem)).toBe(false);
  });

  it('负例：篡改 sign ⇒ 拒', () => {
    const at = queryResponse.rawBody.lastIndexOf('"sign":"');
    const bogus = Buffer.alloc(256, 9).toString('base64');
    const tampered = `${queryResponse.rawBody.slice(0, at)}"sign":"${bogus}"}`;
    expect(verifyResponse(queryResponse.api, tampered, keys.alipayPublicPem)).toBe(false);
  });

  it('负例：apiName 不是响应里的键（错配）⇒ 拒', () => {
    expect(verifyResponse('alipay.trade.close', queryResponse.rawBody, keys.alipayPublicPem)).toBe(false);
  });

  it('负例：非法 JSON / 缺 sign ⇒ 拒（不可验 = 不可信，不抛）', () => {
    expect(verifyResponse('alipay.trade.query', '<html>502</html>', keys.alipayPublicPem)).toBe(false);
    expect(
      verifyResponse(
        'alipay.trade.query',
        `{"alipay_trade_query_response":${queryResponse.expect.extractedNode}}`,
        keys.alipayPublicPem,
      ),
    ).toBe(false);
  });

  it('负例：公钥错配 ⇒ 拒', () => {
    expect(verifyResponse(queryResponse.api, queryResponse.rawBody, keys.appPublicPem)).toBe(false);
  });
});

/* ======================================================================== *
 * ④ ⚙️6 出站签名（确定性金标）
 * ======================================================================== */
describe('⚙️6 出站签名（RSA2；PKCS#1 v1.5 确定性 ⇒ 金标可回放）', () => {
  it('金标回放：签名源逐字 + 签名值逐字（fixture params 故意乱序）', () => {
    expect(buildRequestSignSource(requestSign.params)).toBe(requestSign.expect.signSource);
    expect(signRequest(requestSign.params, keys.appPrivatePem)).toBe(requestSign.expect.sign);
  });

  it('自验签：产物可用应用公钥对同源验过；插入序无关', () => {
    const reordered = Object.fromEntries(Object.entries(requestSign.params).reverse());
    const sign = signRequest(reordered, keys.appPrivatePem);
    expect(sign).toBe(requestSign.expect.sign);
    const ok = createVerify('RSA-SHA256')
      .update(requestSign.expect.signSource, 'utf8')
      .verify(keys.appPublicPem, Buffer.from(sign, 'base64'));
    expect(ok).toBe(true);
  });

  it('负例：任一参数被改 ⇒ 产物不再签得住原源（签名绑全参数）', () => {
    const tampered = { ...requestSign.params, timestamp: '2026-10-06 12:00:01' };
    const bogusSign = signRequest(tampered, keys.appPrivatePem);
    const verifiesOriginal = createVerify('RSA-SHA256')
      .update(requestSign.expect.signSource, 'utf8')
      .verify(keys.appPublicPem, Buffer.from(bogusSign, 'base64'));
    expect(verifiesOriginal).toBe(false);
  });
});

/* ======================================================================== *
 * ⑤ ⚙️5 金额格式化（分↔元字符串；禁浮点）
 * ======================================================================== */
describe('⚙️5 金额格式化（fen2yuan / yuan2fen 逐字）', () => {
  it('fen2yuan：整数分 ⇒ 元字符串（0.01/0.10/1.00/500.00 逐字）', () => {
    expect(fen2yuan(0)).toBe('0.00');
    expect(fen2yuan(1)).toBe('0.01');
    expect(fen2yuan(10)).toBe('0.10');
    expect(fen2yuan(100)).toBe('1.00');
    expect(fen2yuan(600)).toBe('6.00');
    expect(fen2yuan(50000)).toBe('500.00');
    expect(fen2yuan(123456)).toBe('1234.56');
  });

  it('yuan2fen：合法串 ⇒ 整数分；往返恒等', () => {
    expect(yuan2fen('6')).toBe(600);
    expect(yuan2fen('6.5')).toBe(650);
    expect(yuan2fen('6.55')).toBe(655);
    expect(yuan2fen('0.01')).toBe(1);
    expect(yuan2fen('500.00')).toBe(50000);
    expect(yuan2fen('9999999.99')).toBe(999999999);
    for (const fen of [0, 1, 10, 100, 600, 50000, 999999999]) {
      expect(yuan2fen(fen2yuan(fen))).toBe(fen);
    }
  });

  it('yuan2fen：非法形态 ⇒ null（解析失败 ⇒ 上层 amount_mismatch；整数比较消除格式歧义）', () => {
    for (const bad of ['', 'abc', '1.234', '6.', '.5', '-1', '12345678', '1,000', ' 6', '6.100']) {
      expect(yuan2fen(bad), bad).toBeNull();
    }
  });
});

/* ======================================================================== *
 * ⑥ AlipayClient 行为（密钥面/计数/出站纪律）
 * ======================================================================== */

const GATEWAY = 'http://alipay-stub.test/gateway.do';

/** 渠道凭据图（T9：mock `PayChannelConfigService.get()` 的现拉面；缺键 = 未配置语义）。 */
type ChannelCreds = Partial<Record<PayChannelKey, string>>;

/** 假渠道图服务：`get()` **逐调用读** `creds`（改图 ⇒ 同一实例下一次调用用新图 = 「每次现拉」）。 */
class FakePayChannel {
  constructor(public creds: ChannelCreds | null = null) {}

  async get(): Promise<ChannelCreds | null> {
    return this.creds;
  }
}

const asPayChannel = (fake: FakePayChannel): PayChannelConfigService => fake as unknown as PayChannelConfigService;

/** 金标图（网关 + appId + 双钥；密钥形态 = **base64(PEM)**——读侧零改，§3.3）。 */
const goodCreds = (): ChannelCreds => ({
  'pay.channel.gatewayUrl': GATEWAY,
  'pay.channel.appId': '9021000000000000',
  'pay.channel.privateKey': Buffer.from(keys.appPrivatePem, 'utf8').toString('base64'),
  'pay.channel.publicKey': Buffer.from(keys.alipayPublicPem, 'utf8').toString('base64'),
});

/** 金标图服务（每调用一份新实例——逐用例隔离）。 */
const goodChannel = (): FakePayChannel => new FakePayChannel(goodCreds());

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * 组装 AlipayClient（fetch 替身 + 渠道图替身）。`payChannel` 缺省 = **金标图**（旧「env 注好配置」面）；
 * 未配置面（旧「env 清空」）显式传 `new FakePayChannel(null)`。
 */
function makeClient(
  handler: (url: string, form: URLSearchParams, init?: RequestInit) => Promise<Partial<Response>>,
  payChannel: FakePayChannel = goodChannel(),
) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const form = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, init });
    const partial = await handler(url, form, init);
    return { ok: true, status: 200, text: async () => '', ...partial } as Response;
  }) as unknown as typeof fetch;
  return { client: new AlipayClient(fetchImpl, asPayChannel(payChannel)), calls };
}

const counterFor = async (api: string): Promise<number> => {
  const metric = await paymentOutboundFailTotal.get();
  return metric.values.find((v) => v.labels.api === api)?.value ?? 0;
};

/** 从出站表单反推：签名源（去 sign）验签自证 —— 我们发出的签名真的签住了我们发出的参数。 */
function outboundSelfVerify(form: URLSearchParams): boolean {
  const params = Object.fromEntries(form.entries());
  const sign = params.sign;
  delete params.sign;
  return createVerify('RSA-SHA256')
    .update(buildRequestSignSource(params), 'utf8')
    .verify(keys.appPublicPem, Buffer.from(sign, 'base64'));
}

describe('⑥ AlipayClient：密钥面与渠道图每次现拉', () => {
  beforeEach(() => {
    paymentOutboundFailTotal.reset();
  });

  it('密钥缺失（暗上线形态）：四方法都 ⇒ 15001 + 分 api 计数 + **零出站**', async () => {
    const { client, calls } = makeClient(async () => ({}), new FakePayChannel(null));
    const results = [
      ['wap_pay', await client.createPayUrl({ outTradeNo: 'pay_x', subject: 's', totalAmount: '6.00', timeoutExpress: '15m', notifyUrl: 'https://n', returnUrl: 'https://r' })],
      ['query', await client.query({ outTradeNo: 'pay_x' })],
      ['refund', await client.refund({ outTradeNo: 'pay_x', refundAmount: '6.00', outRequestNo: 'rf_x', reason: 'r' })],
      ['close', await client.close({ outTradeNo: 'pay_x' })],
    ] as const;
    for (const [api, r] of results) {
      expect(r.ok, api).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.code, api).toBe(ErrCode.PAY_CHANNEL_ERROR);
      expect(r.lastError.length, api).toBeGreaterThan(0);
      expect(await counterFor(api), api).toBe(1);
    }
    expect(calls).toEqual([]); // 配置不过 ⇒ 不出站
  });

  it('坏密钥（base64 解出来不是 PEM）：⇒ 15001 + 计数 + 零出站', async () => {
    const bad = goodChannel();
    bad.creds = {
      ...goodCreds(),
      'pay.channel.privateKey': Buffer.from('not a pem at all', 'utf8').toString('base64'),
    };
    const { client, calls } = makeClient(async () => ({}), bad);
    const r = await client.query({ outTradeNo: 'pay_x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrCode.PAY_CHANNEL_ERROR);
    expect(await counterFor('query')).toBe(1);
    expect(calls).toEqual([]);
  });

  it('渠道图**每次调用现拉**：同一实例先失败（无图）后成功（补上金标图 + 可达网关）', async () => {
    const payChannel = new FakePayChannel(null);
    const { client, calls } = makeClient(async () => ({ text: async () => queryResponse.rawBody }), payChannel);
    const first = await client.query({ outTradeNo: 'pay_x' });
    expect(first.ok).toBe(false);
    payChannel.creds = goodCreds();
    const second = await client.query({ outTradeNo: 'pay_x' });
    expect(second.ok).toBe(true);
    expect(calls.length).toBe(1);
  });
});

describe('⑥ AlipayClient：出站形态与响应验签', () => {
  beforeEach(() => {
    paymentOutboundFailTotal.reset();
  });

  it('query 金标回放：POST 表单（app_id/method/biz_content/sign…）+ 签名自验 + 带超时信号 + 解析结果', async () => {
    const { client, calls } = makeClient(async () => ({ text: async () => queryResponse.rawBody }));
    const r = await client.query({ outTradeNo: 'pay_m3xq8t9u7v2k1p' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.data).toEqual({
      found: true,
      tradeStatus: 'TRADE_SUCCESS',
      tradeNo: '2026100622001448060000000001',
      amountFen: 600,
    });

    const call = calls[0]!;
    expect(call.url).toBe(GATEWAY);
    expect(call.init?.method).toBe('POST');
    expect(String((call.init?.headers as Record<string, string>)['content-type'])).toContain(
      'application/x-www-form-urlencoded',
    );
    expect(call.init?.signal).toBeInstanceOf(AbortSignal); // 超时纪律（outbound 闸的单元面）

    const form = new URLSearchParams(String(call.init?.body));
    expect(form.get('app_id')).toBe('9021000000000000');
    expect(form.get('method')).toBe('alipay.trade.query');
    expect(form.get('charset')).toBe('utf-8');
    expect(form.get('sign_type')).toBe('RSA2');
    expect(form.get('version')).toBe('1.0');
    expect(form.get('timestamp')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(JSON.parse(String(form.get('biz_content')))).toEqual({ out_trade_no: 'pay_m3xq8t9u7v2k1p' });
    expect(outboundSelfVerify(form)).toBe(true);
    expect(await counterFor('query')).toBe(0);
  });

  it('query：ACQ.TRADE_NOT_EXIST 是渠道的**明确回答** ⇒ ok:true、found:false（不算失败、不计数）', async () => {
    const body = signedResponse('alipay.trade.query', {
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'ACQ.TRADE_NOT_EXIST',
      sub_msg: '交易不存在',
    });
    const { client } = makeClient(async () => ({ text: async () => body }));
    const r = await client.query({ outTradeNo: 'pay_x' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.data).toEqual({ found: false, tradeStatus: null, tradeNo: null, amountFen: null });
    expect(await counterFor('query')).toBe(0);
  });

  it('query：业务拒绝（其它 code）⇒ 15001 + 材质（channelCode/channelSubCode）+ 计数', async () => {
    const body = signedResponse('alipay.trade.query', {
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'ACQ.SYSTEM_ERROR',
      sub_msg: '系统异常，请稍后再试',
    });
    const { client } = makeClient(async () => ({ text: async () => body }));
    const r = await client.query({ outTradeNo: 'pay_x' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe(ErrCode.PAY_CHANNEL_ERROR);
    expect(r.channelCode).toBe('40004');
    expect(r.channelSubCode).toBe('ACQ.SYSTEM_ERROR');
    expect(r.lastError).toContain('ACQ.SYSTEM_ERROR');
    expect(await counterFor('query')).toBe(1);
  });

  it('query：响应验签失败 ⇒ 15001 + 计数（**一律过 verifyResponse** 的负例面）', async () => {
    const tampered = queryResponse.rawBody.replace('"total_amount":"6.00"', '"total_amount":"7.00"');
    const { client } = makeClient(async () => ({ text: async () => tampered }));
    const r = await client.query({ outTradeNo: 'pay_x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(ErrCode.PAY_CHANNEL_ERROR);
    expect(await counterFor('query')).toBe(1);
  });

  it('传输失败（fetch 抛）/ 非 200：都 ⇒ 15001 + 计数', async () => {
    const throwing = makeClient(async () => {
      throw new Error('ECONNREFUSED 10.0.0.0:80');
    });
    const r1 = await throwing.client.query({ outTradeNo: 'pay_x' });
    expect(r1.ok).toBe(false);
    expect(await counterFor('query')).toBe(1);

    const bad = makeClient(async () => ({ ok: false, status: 502 }));
    const r2 = await bad.client.query({ outTradeNo: 'pay_x' });
    expect(r2.ok).toBe(false);
    expect(await counterFor('query')).toBe(2);
  });

  it('refund：out_request_no 必填进 biz_content；成功解析 trade_no/fund_change（金标回放）', async () => {
    const { client, calls } = makeClient(async () => ({ text: async () => refundResponse.rawBody }));
    const r = await client.refund({
      outTradeNo: 'pay_m3xq8t9u7v2k1p',
      refundAmount: '6.00',
      outRequestNo: 'rf_m3xq8t9u7v2k1q',
      reason: '不想要了',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.data).toEqual({ tradeNo: '2026100622001448060000000001', fundChange: true });
    const form = new URLSearchParams(String(calls[0]!.init?.body));
    expect(form.get('method')).toBe('alipay.trade.refund');
    expect(JSON.parse(String(form.get('biz_content')))).toEqual({
      out_trade_no: 'pay_m3xq8t9u7v2k1p',
      refund_amount: '6.00',
      out_request_no: 'rf_m3xq8t9u7v2k1q',
      refund_reason: '不想要了',
    });
  });

  it('refund：业务拒绝（如超出可退）⇒ 15001 + 材质 + 计数（T11 的「停留 approved + last_error」素材）', async () => {
    const body = signedResponse('alipay.trade.refund', {
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'ACQ.TRADE_STATUS_ERROR',
      sub_msg: '交易状态不合法',
    });
    const { client } = makeClient(async () => ({ text: async () => body }));
    const r = await client.refund({ outTradeNo: 'pay_x', refundAmount: '6.00', outRequestNo: 'rf_x', reason: 'r' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.channelSubCode).toBe('ACQ.TRADE_STATUS_ERROR');
    expect(await counterFor('refund')).toBe(1);
  });

  it('close：成功 ⇒ {closed:true}；「已支付」类拒绝 ⇒ 15001 + channelSubCode（T7 转 paid 路径的判别素材）', async () => {
    const okClient = makeClient(async () =>
      ({ text: async () => signedResponse('alipay.trade.close', { code: '10000', msg: 'Success' }) }));
    const r1 = await okClient.client.close({ outTradeNo: 'pay_x' });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data).toEqual({ closed: true });

    const paidBody = signedResponse('alipay.trade.close', {
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'ACQ.TRADE_HAS_SUCCESS',
      sub_msg: '交易已被支付',
    });
    const paidClient = makeClient(async () => ({ text: async () => paidBody }));
    const r2 = await paidClient.client.close({ outTradeNo: 'pay_x' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.channelSubCode).toBe('ACQ.TRADE_HAS_SUCCESS');
      expect(r2.lastError).toContain('交易已被支付');
    }
    expect(await counterFor('close')).toBe(1);
  });

  it('createPayUrl：本地签 wap 表单 + 唯一出站=query 凭证探针（10000）⇒ 返回网关+表单字段', async () => {
    const { client, calls } = makeClient(async () => ({ text: async () => queryResponse.rawBody }));
    const r = await client.createPayUrl({
      outTradeNo: 'pay_m3xq8t9u7v2k1p',
      subject: '金币充值 6 元',
      totalAmount: '6.00',
      timeoutExpress: '15m',
      notifyUrl: 'https://ssh.example.test/pay/notify/alipay',
      returnUrl: 'https://ssh.example.test/?pay=pay_m3xq8t9u7v2k1p',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');

    // 唯一出站 = query 凭证探针（wap.pay 是页面执行型接口，服务端不 POST 它）。
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(GATEWAY);
    const probe = new URLSearchParams(String(calls[0]!.init?.body));
    expect(probe.get('method')).toBe('alipay.trade.query');
    expect(JSON.parse(String(probe.get('biz_content')))).toEqual({ out_trade_no: 'pay_m3xq8t9u7v2k1p' });

    // 返回的 wap 表单字段（桥接页据此渲染隐藏表单）。
    expect(r.data.gatewayUrl).toBe(GATEWAY);
    const fields = new URLSearchParams(Object.entries(r.data.fields));
    expect(fields.get('method')).toBe('alipay.trade.wap.pay');
    expect(JSON.parse(String(fields.get('biz_content')))).toEqual({
      out_trade_no: 'pay_m3xq8t9u7v2k1p',
      total_amount: '6.00',
      subject: '金币充值 6 元',
      product_code: 'QUICK_WAP_WAY',
      timeout_express: '15m',
    });
    expect(fields.get('notify_url')).toBe('https://ssh.example.test/pay/notify/alipay');
    expect(fields.get('return_url')).toBe('https://ssh.example.test/?pay=pay_m3xq8t9u7v2k1p');
    expect(outboundSelfVerify(fields)).toBe(true); // 桥接表单上的签名签住的就是这些参数
    expect(await counterFor('wap_pay')).toBe(0);
  });

  it('createPayUrl：探针回 TRADE_NOT_EXIST（真实支付宝对新单号的明确回答）⇒ 仍成功', async () => {
    const body = signedResponse('alipay.trade.query', {
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'ACQ.TRADE_NOT_EXIST',
      sub_msg: '交易不存在',
    });
    const { client } = makeClient(async () => ({ text: async () => body }));
    const r = await client.createPayUrl({
      outTradeNo: 'pay_brand_new',
      subject: '金币充值 6 元',
      totalAmount: '6.00',
      timeoutExpress: '15m',
      notifyUrl: 'https://n',
      returnUrl: 'https://r',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.data.gatewayUrl).toBe(GATEWAY);
    expect(new URLSearchParams(Object.entries(r.data.fields)).get('method')).toBe('alipay.trade.wap.pay');
    expect(await counterFor('wap_pay')).toBe(0);
  });

  it('createPayUrl：探针 INVALID_SIGN（密钥错配的响亮回答）⇒ 15001 + wap_pay 计数、不产表单', async () => {
    const body = signedResponse('alipay.trade.query', {
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'ACQ.INVALID_SIGN',
      sub_msg: '签名无效',
    });
    const { client } = makeClient(async () => ({ text: async () => body }));
    const r = await client.createPayUrl({
      outTradeNo: 'pay_x',
      subject: 's',
      totalAmount: '6.00',
      timeoutExpress: '15m',
      notifyUrl: 'https://n',
      returnUrl: 'https://r',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe(ErrCode.PAY_CHANNEL_ERROR);
    expect(r.channelCode).toBe('40004');
    expect(r.channelSubCode).toBe('ACQ.INVALID_SIGN');
    expect(await counterFor('wap_pay')).toBe(1);
  });

  it('createPayUrl：探针传输失败（fetch 抛）⇒ 15001 + wap_pay 计数（网关可达性当场兑现）', async () => {
    const { client } = makeClient(async () => {
      throw new Error('ECONNREFUSED 10.0.0.0:80');
    });
    const r = await client.createPayUrl({
      outTradeNo: 'pay_x',
      subject: 's',
      totalAmount: '6.00',
      timeoutExpress: '15m',
      notifyUrl: 'https://n',
      returnUrl: 'https://r',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe(ErrCode.PAY_CHANNEL_ERROR);
    expect(r.lastError).toContain('ECONNREFUSED');
    expect(await counterFor('wap_pay')).toBe(1);
  });

  it('lastError 截断 ≤255（直写 `last_error` varchar(255) 列的材质）', async () => {
    const body = signedResponse('alipay.trade.query', {
      code: '40004',
      msg: 'Business Failed',
      sub_code: 'ACQ.SYSTEM_ERROR',
      sub_msg: 'x'.repeat(400),
    });
    const { client } = makeClient(async () => ({ text: async () => body }));
    const r = await client.query({ outTradeNo: 'pay_x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lastError.length).toBe(255);
  });
});

describe('⑥ 时间戳格式（北京时间 GMT+8，yyyy-MM-dd HH:mm:ss）', () => {
  it('UTC ⇒ +08:00 换算（含跨日）', () => {
    expect(formatAlipayTimestamp(new Date('2026-10-06T04:00:00Z'))).toBe('2026-10-06 12:00:00');
    expect(formatAlipayTimestamp(new Date('2026-10-05T16:00:00Z'))).toBe('2026-10-06 00:00:00');
    expect(formatAlipayTimestamp(new Date('2026-10-06T15:59:59Z'))).toBe('2026-10-06 23:59:59');
  });
});

/* ======================================================================== *
 * ⑦ 模块注册面
 * ======================================================================== */
describe('⑦ 模块注册面：AlipayClient 在 AppModule providers（未注册 = 真容器解析不到）', () => {
  it('AppModule 的 providers 含 AlipayClient', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContain(AlipayClient);
  });
});

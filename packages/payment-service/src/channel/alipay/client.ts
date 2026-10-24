/**
 * 支付片 T6：支付宝出站客户端（`AlipayClient implements PaymentChannel`；⚙️3/⚙️6/§2.5 退避表的执行面）。
 *
 * ## 纪律面（逐条）
 *
 *  - **网关地址/密钥每次调用现拉**（T9/规格 §3.3）：经 `PayChannelConfigService.get()` 取渠道
 *    凭据图（专用拉取通道，每调用现拉 + 失败整图回落）：`pay.channel.gatewayUrl`（默认生产网关）·
 *    `pay.channel.appId`（明文）· `pay.channel.privateKey` / `pay.channel.publicKey` = **base64(PEM)**。
 *    缺图/缺键 ⇒ 与「env 空串」逐字等价（本节映射表：§3.3/§3.4）；缺失/解码失败 ⇒ **15001**
 *    （不阻塞启动——暗上线期无密钥可起）；空串 = 未设（`||` 不用 `??`，⚙️18）。
 *  - **密钥不进日志/不进响应**：本文件不打参数全量日志；失败日志只含 api 名、订单号、
 *    渠道码/传输摘要（`lastError` 材质）。密钥唯一去处 = 签名/验签入参。
 *  - **结果语义**：一切"没拿到可信成功结果" ⇒ `ChannelFailure{code:15001, lastError, channelCode?, channelSubCode?}`
 *    且**恰计一次** `payment_outbound_fail_total{api}`（单一收口 `fail()`）；
 *    **同步响应一律过 `verifyResponse`**（验签不过 ⇒ 拒，不解析不信）。
 *  - **超时**：`AbortSignal.timeout(ALIPAY_HTTP_TIMEOUT_MS)`（outbound-timeout 闸的判据
 *    对象；⚠️ 本文件含 `fetchImpl(` 字面量 ⇒ 被该闸扫入 ⇒ 超时标记必须在场）。
 *  - **不重试**（设计 §2.5 退避表：`wap_pay` 不重试、同步请求内失败即 15001；
 *    其余 API 的退避重试挂在扫描循环里——**本层不做**）。
 *
 * ## wap.pay 的形态（线上沙箱裁决，2026-06）
 *
 * `alipay.trade.wap.pay` 是**页面执行型**接口：服务端 POST 只回 HTTP 200 收银台 HTML
 * （无 JSON、无 sign——服务端验签必败；GET 404）。正确形态 = **浏览器**把已签名表单
 * POST 到网关。故 `createPayUrl`：
 *  ① **本地**组参 + RSA2 签名，产出「网关地址 + 表单字段」（交桥接页
 *    `/pay/cashier/:orderNo` 渲染隐藏表单自动提交）；
 *  ② **凭证探针**：同一套配置同步执行一发 `alipay.trade.query` —— 密钥错配/坏网关/
 *    传输与验签失败仍**当场 15001**（fail-fast、行保留语义与旧实现一致；metrics 归
 *    `wap_pay`）。真实支付宝对新单号回签名的 `40004/ACQ.TRADE_NOT_EXIST`、stub 回
 *    `10000`，均视为探针通过。
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import type { PayChannelKey } from '@fight-the-landlord/protocol';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析构造参时只见 undefined、启动即崩。
import { PayChannelConfigService } from '../../config/pay-channel.config.service';
import { paymentOutboundFailTotal } from '../../metrics/payment.metrics';
import { MOBILE_FORM_POST, postMobileForm } from './mobile-cashier-post';
import type { MobileFormPost, MobileFormPostResult } from './mobile-cashier-post';
import { apiResponseKey, yuan2fen } from './params';
import type { RawParams } from './params';
import { signRequest, verifyResponse } from './sign';
import type {
  ChannelApi,
  ChannelFailure,
  ChannelResult,
  CloseData,
  CloseRequest,
  CreatePayUrlRequest,
  MobileCashierData,
  PaymentChannel,
  WapPayFormData,
  QueryData,
  QueryRequest,
  RefundData,
  RefundRequest,
} from '../payment-channel.interface';

/** ⚙️3：网关默认值（生产）；沙箱/stub 走 `pay.channel.gatewayUrl`（管理页 → 支付渠道）同构替换。 */
export const ALIPAY_GATEWAY_URL_DEFAULT = 'https://openapi.alipay.com/gateway.do';

/**
 * 单次出站 HTTP 超时（5s，照 robot-service `douzero.client.ts` 的同类出站先例）。
 * 规格未钉渠道 HTTP 超时值（钉的是 RPC 3s 与退避序）——登记：本值 = 实施选择，
 * 语义上只需满足"远小于扫描周期、超时即失败可重试"。**不重试**由上面文件头说明承担。
 */
export const ALIPAY_HTTP_TIMEOUT_MS = 5000;

/**
 * 代发用的手机 UA（沙箱边缘据此把 wap POST 分流到手机收银台集群；线上裁决 2026-10：
 * 服务器出口带 Android UA 稳定命中 `mobileclientgw-sandbox`，桌面 UA 必落 openapi 死路）。
 */
export const MOBILE_CASHIER_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/** 代发尝试次数（沙箱首跳偶发 404/抖动；两次均败才按渠道失败收口——控制器随后回退表单页）。 */
export const MOBILE_CASHIER_ATTEMPTS = 2;

/** 302 家族（代发只认重定向形态的签发应答）。 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * 手机收银台签发地址的**域白名单**（防开放重定向：网关地址虽由管理配置供给，Location 仍
 * 只认 https + 支付宝/沙箱官方域；任何外域/相对/非 https 地址 ⇒ 失败，不做跳转）。
 */
export function isSafeCashierUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return (
    host === 'alipay.com' ||
    host.endsWith('.alipay.com') ||
    host === 'alipaydev.com' ||
    host.endsWith('.alipaydev.com')
  );
}

/** 配置缺失/坏时的固定摘要（不提任何值、**不点名 env**——⚙️16/§2.9 逐字）。 */
export const CHANNEL_CONFIG_ERROR =
  '支付渠道配置缺失或非法（管理页 → 支付渠道；密钥形态 = base64(PEM)）';

/** 验签失败时的固定摘要。 */
export const RESPONSE_VERIFY_FAILED = '渠道响应验签失败（不可信响应按失败处理）';

/** `last_error varchar(255)` 列的直接写入口径。 */
const LAST_ERROR_MAX = 255;

/**
 * 支付宝要求的请求时间戳形态：`yyyy-MM-dd HH:mm:ss`、**北京时间（GMT+8）**
 * （不是本地时区、不是 UTC——错时区会被网关按"时间戳无效"拒）。
 */
export function formatAlipayTimestamp(now: Date = new Date()): string {
  const beijing = new Date(now.getTime() + 8 * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${beijing.getUTCFullYear()}-${p(beijing.getUTCMonth() + 1)}-${p(beijing.getUTCDate())} ` +
    `${p(beijing.getUTCHours())}:${p(beijing.getUTCMinutes())}:${p(beijing.getUTCSeconds())}`
  );
}

interface ChannelConfig {
  gatewayUrl: string;
  appId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * base64(PEM) ⇒ PEM；缺失/解出来不是 PEM 形状 ⇒ `null`（⚙️3「解码失败 ⇒ 15001」）。
 *
 * ⚠️ **导出面**（T8）：回调链的验签公钥读取（`notify.service.ts`）复用本函数 ——
 * 同一形态校验只此一份（「不可验 = 不可信」的入参侧），不复制第二套 PEM 形状规则。
 */
export function decodePem(value: string | undefined, kind: 'PRIVATE' | 'PUBLIC'): string | null {
  if (!value) return null;
  const pem = Buffer.from(value, 'base64').toString('utf8');
  const shape = kind === 'PRIVATE' ? /-----BEGIN [A-Z ]*PRIVATE KEY-----/ : /-----BEGIN [A-Z ]*PUBLIC KEY-----/;
  return shape.test(pem) ? pem : null;
}

interface ResponseNode {
  code?: unknown;
  sub_code?: unknown;
  sub_msg?: unknown;
  msg?: unknown;
  trade_status?: unknown;
  trade_no?: unknown;
  total_amount?: unknown;
  fund_change?: unknown;
}

const asString = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

/** 业务节点的判别材料（code/sub_code/sub_msg ⇒ 摘要素材）。 */
function nodeMaterials(node: ResponseNode): { code: string | null; subCode: string | null; summary: string } {
  const code = asString(node.code);
  const subCode = asString(node.sub_code);
  const detail = asString(node.sub_msg) ?? asString(node.msg) ?? '';
  return { code, subCode, summary: `${code ?? '?'}${subCode ? `/${subCode}` : ''}${detail ? `: ${detail}` : ''}` };
}

/** 已验签的响应体 ⇒ `<api>_response` 节点（形状非法 ⇒ `null`；不抛）。 */
function parseResponseNode(rawBody: string, apiName: string): ResponseNode | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const node = parsed?.[apiResponseKey(apiName)];
    return node !== null && typeof node === 'object' && !Array.isArray(node) ? (node as ResponseNode) : null;
  } catch {
    return null;
  }
}

/** 出站调用成功面：已验签的响应节点。 */
interface ApiCallSuccess {
  ok: true;
  node: ResponseNode;
}

/** 本地签名面：已签名参数（fields 形态）+ 表单编码串（出站 POST 用）。 */
interface SignedRequest {
  params: RawParams;
  sign: string;
  form: string;
}

/**
 * 支付宝渠道实现（P1 裁决：本期唯一渠道）。
 *
 * ⚠️ 装配（T7 起）：`AppModule` providers 已在 T6 注册（`sign.test.ts` ⑦ 钉住）；
 * `fetchImpl` 是 `@Optional()` + 默认值的**测试替身注入口**（照 `douzero.health.ts` 先例）——
 * 生产走全局 `fetch`，测试注入替身（不经真网络）。
 */
@Injectable()
export class AlipayClient implements PaymentChannel {
  private readonly logger = new Logger(AlipayClient.name);

  /**
   * ⚠️ **值导入** `PayChannelConfigService`（DI 陷阱纪律）——渠道凭据图现拉面（T8；§3.3）。
   * `fetchImpl` 照旧是 `@Optional()` + 默认值的**测试替身注入口**（生产走全局 `fetch`）。
   * `mobilePost` 同理：手机收银台代发传输（node:https 不跟随 302；见 mobile-cashier-post.ts）。
   */
  constructor(
    @Optional() private readonly fetchImpl: typeof fetch = fetch,
    private readonly payChannel: PayChannelConfigService,
    @Optional() @Inject(MOBILE_FORM_POST) private readonly mobilePost: MobileFormPost = postMobileForm,
  ) {}

  /* ------------------------------ PaymentChannel ------------------------------ */

  /**
   * `alipay.trade.wap.pay`（`product_code=QUICK_WAP_WAY`；形态说明见文件头）：
   * ① 本地签名 wap 表单（页面执行型，服务端不 POST 它）；② query 凭证探针当场兑现
   * 密钥/签名/网关可达性；通过后返回「网关 + 表单字段」（交桥接页渲染）。
   */
  async createPayUrl(req: CreatePayUrlRequest): Promise<ChannelResult<WapPayFormData>> {
    const cfg = this.readConfig(await this.payChannel.get());
    if (!cfg) return this.fail('wap_pay', req.outTradeNo, CHANNEL_CONFIG_ERROR);

    let wap: SignedRequest;
    try {
      wap = this.buildSigned(
        cfg,
        'alipay.trade.wap.pay',
        {
          out_trade_no: req.outTradeNo,
          total_amount: req.totalAmount,
          subject: req.subject,
          product_code: 'QUICK_WAP_WAY',
          timeout_express: req.timeoutExpress,
        },
        { notify_url: req.notifyUrl, return_url: req.returnUrl },
      );
    } catch (err) {
      return this.fail('wap_pay', req.outTradeNo, err instanceof Error ? err.message : String(err));
    }

    // 凭证探针（同一套配置快照）：新单号在真实支付宝 = 签名的 TRADE_NOT_EXIST，stub = 10000。
    const probe = await this.execute(
      cfg,
      'wap_pay',
      'alipay.trade.query',
      req.outTradeNo,
      { out_trade_no: req.outTradeNo },
    );
    if (!probe.ok) return probe;
    const probeCode = asString(probe.node.code);
    const probeSubCode = asString(probe.node.sub_code);
    if (probeCode !== '10000' && !(probeCode === '40004' && probeSubCode === 'ACQ.TRADE_NOT_EXIST')) {
      const m = nodeMaterials(probe.node);
      return this.fail('wap_pay', req.outTradeNo, m.summary, m);
    }

    return { ok: true, data: { gatewayUrl: cfg.gatewayUrl, fields: { ...wap.params, sign: wap.sign } } };
  }

  /**
   * 手机端桥接代发（见文件头「wap.pay 的形态」与 payment-channel.interface 契约）：
   * 把**已签名的同一份 wap 表单**以手机 UA POST 到网关、不跟随 302，回收手机收银台
   * 签发地址。这一跳不读渠道配置（表单已签好）、不验签（302 无响应体；可信面 =
   * Location 支付宝域白名单）。沙箱首跳偶发 404/抖动 ⇒ 至多 `MOBILE_CASHIER_ATTEMPTS`
   * 次；传输失败/非重定向/地址不可信 ⇒ 失败面（metrics 归 `wap_pay`，控制器回退表单页）。
   */
  async resolveMobileCashier(form: WapPayFormData): Promise<ChannelResult<MobileCashierData>> {
    const outTradeNo = form.fields.out_trade_no || '-';
    const formBody = new URLSearchParams(form.fields).toString();

    let lastSummary = '';
    for (let attempt = 1; attempt <= MOBILE_CASHIER_ATTEMPTS; attempt += 1) {
      let r: MobileFormPostResult;
      try {
        r = await this.mobilePost(
          form.gatewayUrl,
          formBody,
          MOBILE_CASHIER_USER_AGENT,
          ALIPAY_HTTP_TIMEOUT_MS,
        );
      } catch (err) {
        lastSummary = err instanceof Error ? err.message : String(err);
        continue;
      }
      const location = typeof r.location === 'string' ? r.location.trim() : '';
      if (REDIRECT_STATUS.has(r.status) && location.length > 0 && isSafeCashierUrl(location)) {
        return { ok: true, data: { cashierUrl: location } };
      }
      // 摘要不含 Location 原文（不外泄签发参数；只记形态）。
      lastSummary =
        location.length > 0
          ? `手机收银台签发地址形态不可信（HTTP ${r.status}）`
          : `网关未签发手机收银台地址（HTTP ${r.status}）`;
    }
    return this.fail('wap_pay', outTradeNo, lastSummary || '手机收银台签发失败');
  }

  /** `alipay.trade.query`：补单扫描的读边（设计 §4.5；`TRADE_NOT_EXIST` = `found:false` 的明确回答）。 */
  async query(req: QueryRequest): Promise<ChannelResult<QueryData>> {
    const r = await this.callApi('query', 'alipay.trade.query', req.outTradeNo, {
      out_trade_no: req.outTradeNo,
    });
    if (!r.ok) return r;
    const code = asString(r.node.code);
    if (code === '10000') {
      const totalAmount = asString(r.node.total_amount);
      return {
        ok: true,
        data: {
          found: true,
          tradeStatus: asString(r.node.trade_status),
          tradeNo: asString(r.node.trade_no),
          amountFen: totalAmount === null ? null : yuan2fen(totalAmount),
        },
      };
    }
    if (code === '40004' && asString(r.node.sub_code) === 'ACQ.TRADE_NOT_EXIST') {
      return { ok: true, data: { found: false, tradeStatus: null, tradeNo: null, amountFen: null } };
    }
    const m = nodeMaterials(r.node);
    return this.fail('query', req.outTradeNo, m.summary, m);
  }

  /** `alipay.trade.refund`（`out_request_no` 必填 = 退款幂等键；设计 §6.2）。 */
  async refund(req: RefundRequest): Promise<ChannelResult<RefundData>> {
    const r = await this.callApi('refund', 'alipay.trade.refund', req.outTradeNo, {
      out_trade_no: req.outTradeNo,
      refund_amount: req.refundAmount,
      out_request_no: req.outRequestNo,
      refund_reason: req.reason,
    });
    if (!r.ok) return r;
    if (asString(r.node.code) !== '10000') {
      const m = nodeMaterials(r.node);
      return this.fail('refund', req.outTradeNo, m.summary, m);
    }
    const fundChange = asString(r.node.fund_change);
    return {
      ok: true,
      data: { tradeNo: asString(r.node.trade_no), fundChange: fundChange === null ? null : fundChange === 'Y' },
    };
  }

  /**
   * `alipay.trade.close`（过期关闭尽力而为；设计 §4.5）。
   * 「已支付」类拒绝走失败面 + `channelSubCode` ⇒ T7 转 paid 路径的判别素材。
   */
  async close(req: CloseRequest): Promise<ChannelResult<CloseData>> {
    const r = await this.callApi('close', 'alipay.trade.close', req.outTradeNo, {
      out_trade_no: req.outTradeNo,
    });
    if (!r.ok) return r;
    if (asString(r.node.code) !== '10000') {
      const m = nodeMaterials(r.node);
      return this.fail('close', req.outTradeNo, m.summary, m);
    }
    return { ok: true, data: { closed: true } };
  }

  /* -------------------------------- 内部管线 -------------------------------- */

  /**
   * 消费侧映射（T9；规格 §3.3 逐行）：缺图/缺键 = 「env 空串」逐字等价（`||` 不用 `??`，⚙️18）；
   * 缺失/坏 ⇒ `null`（调用方转 15001）。**纯函数**：图由 `callApi` 现拉传入，本方法不碰外部状态。
   */
  private readConfig(creds: Partial<Record<PayChannelKey, string>> | null): ChannelConfig | null {
    const gatewayUrl = creds?.['pay.channel.gatewayUrl'] || ALIPAY_GATEWAY_URL_DEFAULT;
    const appId = creds?.['pay.channel.appId'] || '';
    const privateKeyPem = decodePem(creds?.['pay.channel.privateKey'], 'PRIVATE');
    const publicKeyPem = decodePem(creds?.['pay.channel.publicKey'], 'PUBLIC');
    if (!appId || !privateKeyPem || !publicKeyPem) return null;
    return { gatewayUrl, appId, privateKeyPem, publicKeyPem };
  }

  /**
   * 失败**单一收口**：恰计一次 `payment_outbound_fail_total{api}`、截断 ≤255、
   * 只记 api 名/订单号/摘要（**不含任何密钥与参数全量**）。
   */
  private fail(
    api: ChannelApi,
    outTradeNo: string,
    lastError: string,
    materials?: { code: string | null; subCode: string | null },
  ): ChannelFailure {
    paymentOutboundFailTotal.labels(api).inc();
    const trimmed = lastError.length > LAST_ERROR_MAX ? lastError.slice(0, LAST_ERROR_MAX) : lastError;
    this.logger.warn(`alipay ${api} failed out_trade_no=${outTradeNo}: ${trimmed}`);
    return {
      ok: false,
      code: ErrCode.PAY_CHANNEL_ERROR,
      lastError: trimmed,
      channelCode: materials?.code ?? null,
      channelSubCode: materials?.subCode ?? null,
    };
  }

  /**
   * 公共管线：读配置 ⇒ `execute`（签名 ⇒ 表单 POST ⇒ **响应验签** ⇒ 取节点）。
   * 任何一步不过都在此收口成 `ChannelFailure`（或交给调用方按 code 判别）。
   */
  private async callApi(
    api: ChannelApi,
    method: string,
    outTradeNo: string,
    bizContent: Record<string, string>,
    extra?: Record<string, string>,
  ): Promise<ApiCallSuccess | ChannelFailure> {
    const cfg = this.readConfig(await this.payChannel.get());
    if (!cfg) return this.fail(api, outTradeNo, CHANNEL_CONFIG_ERROR);
    return this.execute(cfg, api, method, outTradeNo, bizContent, extra);
  }

  /**
   * 出站执行面（配置快照由调用方现拉传入；`createPayUrl` 的探针与 wap 表单因此共用**同一套**配置）：
   * 组公共参数（+方法参数）⇒ 签名 ⇒ 表单 POST ⇒ **响应验签** ⇒ 取节点。
   * 签名/传输/验签任一步不过都收口成 `ChannelFailure`。
   */
  private async execute(
    cfg: ChannelConfig,
    api: ChannelApi,
    method: string,
    outTradeNo: string,
    bizContent: Record<string, string>,
    extra?: Record<string, string>,
  ): Promise<ApiCallSuccess | ChannelFailure> {
    const { form } = this.buildSigned(cfg, method, bizContent, extra);

    let rawBody: string;
    try {
      rawBody = await this.postForm(cfg.gatewayUrl, form);
    } catch (err) {
      return this.fail(api, outTradeNo, err instanceof Error ? err.message : String(err));
    }
    if (!verifyResponse(method, rawBody, cfg.publicKeyPem)) {
      return this.fail(api, outTradeNo, RESPONSE_VERIFY_FAILED);
    }
    const node = parseResponseNode(rawBody, method);
    if (!node) return this.fail(api, outTradeNo, '渠道响应形状非法（无响应节点）');
    return { ok: true, node };
  }

  /** 组公共参数 + 方法参数 ⇒ RSA2 签名 ⇒ `{params, sign, form}`（纯本地；crypto 错误直接抛，调用方收口）。 */
  private buildSigned(
    cfg: ChannelConfig,
    method: string,
    bizContent: Record<string, string>,
    extra?: Record<string, string>,
  ): SignedRequest {
    const params: RawParams = {
      app_id: cfg.appId,
      method,
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: formatAlipayTimestamp(),
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
      ...(extra ?? {}),
    };
    const sign = signRequest(params, cfg.privateKeyPem);
    const form = new URLSearchParams({ ...params, sign }).toString();
    return { params, sign, form };
  }

  /** 表单 POST（`application/x-www-form-urlencoded;charset=utf-8`）+ 超时信号；非 200 即抛。 */
  private async postForm(gatewayUrl: string, form: string): Promise<string> {
    const res = await this.fetchImpl(gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: form,
      signal: AbortSignal.timeout(ALIPAY_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`alipay gateway HTTP ${res.status}`);
    return await res.text();
  }
}

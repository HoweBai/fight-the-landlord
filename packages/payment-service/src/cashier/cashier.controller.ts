/**
 * 支付片：**收银台桥接控制器**（`GET /pay/cashier/:orderNo?t=…` —— 玩家浏览器直连的公开面）。
 *
 * ─── 挂载形态（与 notify 回调同模型，两个"避开"）────────────────────────
 *  - **全局前缀豁免**：`main.ts` 的 `setGlobalPrefix('api', { exclude: [CASHIER_ROUTE] })`
 *    —— edge（Caddy `handle /pay/cashier/*`）原样转发，不经 api-gateway；
 *  - **内部 token 中间件前缀豁免**：`[CASHIER_EXEMPT_PREFIX]` —— 浏览器拿不到也不该带
 *    内部 token。该面**自身的防线**：
 *      ① URL 里的 HMAC 能力 token（`cashier-token.ts`：签名 + 订单绑定 + 时效）；
 *      ② 订单可支付判据（OrdersService 走 DB 时钟 SQL 终裁）；
 *      ③ 渲染出的表单对订单参数现场重签（不存储、不重放旧表单）。
 *
 * ─── 状态语义 ────────────────────────────────────────────────────────────
 *  token 缺失/非法/过期/不匹配、订单不存在 ⇒ **404**（capability URL：不区分不存在与非法，
 *  不提供枚举面）；订单非 created/已过期 ⇒ **410**；渠道侧失败（15001）⇒ **502**。
 */

import { Controller, Get, Headers, Inject, Logger, Param, Query, Res } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';
import { OrdersService } from '../orders/orders.service';
import { renderCashierMessagePage, renderCashierPage } from './cashier-page';
import { cashierTokenSecret, verifyCashierToken } from './cashier-token';
import { isMobileUserAgent } from './mobile-ua';

/** 路由（与 `@Get(CASHIER_ROUTE)` 及 main.ts 的全局前缀豁免对钉——单测钉字面量）。 */
export const CASHIER_ROUTE = 'pay/cashier/:orderNo';

/** 内部 token 中间件的**前缀**豁免值（带尾 `/`；只给浏览器公开面用）。 */
export const CASHIER_EXEMPT_PREFIX = '/pay/cashier/';

/** 单号白名单（⚙️4 形状的保守子集；不符 ⇒ 404，不触 DB）。 */
const ORDER_NO_PATTERN = /^pay_[0-9a-z]+$/;

/** 控制器面的响应最小结构（原生 ServerResponse 形态；**不 import express**——照 notify 先例）。 */
interface CashierHttpResponse {
  status(code: number): CashierHttpResponse;
  setHeader(name: string, value: string): CashierHttpResponse;
  send(body: string): unknown;
}

@Controller()
export class CashierController {
  private readonly logger = new Logger(CashierController.name);

  /** ⚠️ **值导入** OrdersService（DI 陷阱纪律）+ 显式 `@Inject`。 */
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get(CASHIER_ROUTE)
  async show(
    @Param('orderNo') orderNo: string,
    @Query('t') token: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Res() res: CashierHttpResponse,
  ): Promise<void> {
    if (typeof orderNo !== 'string' || !ORDER_NO_PATTERN.test(orderNo)) {
      this.replyPage(res, 404, '支付链接无效', '支付链接无效或已失效，请重新发起充值。');
      return;
    }

    const secret = cashierTokenSecret();
    const payload =
      secret.length > 0 && typeof token === 'string'
        ? verifyCashierToken(token, secret, Date.now(), orderNo)
        : null;
    if (!payload) {
      this.replyPage(res, 404, '支付链接无效', '支付链接无效或已失效，请重新发起充值。');
      return;
    }

    let context: Awaited<ReturnType<OrdersService['cashierContext']>>;
    try {
      context = await this.orders.cashierContext(orderNo, payload.ttlMin);
    } catch (err) {
      // 渠道侧失败（缺基址/探针失败等 15001）⇒ 502；其余错误不外溢成 200，交给 Nest 兜底。
      if (err instanceof DomainError && err.code === ErrCode.PAY_CHANNEL_ERROR) {
        this.replyPage(res, 502, '支付渠道暂时不可用', '支付渠道暂时不可用，请稍后重试。');
        return;
      }
      throw err;
    }

    if (context.kind === 'missing') {
      this.replyPage(res, 404, '订单不存在', '支付链接无效或已失效，请重新发起充值。');
      return;
    }
    if (context.kind === 'gone') {
      this.replyPage(res, 410, '订单已关闭或已过期', '该订单已关闭或超过支付时限，请重新发起充值。');
      return;
    }

    // 手机端：服务端代发 wap 表单（手机 UA，稳定命中手机收银台集群）⇒ 302 直达一次性签发地址。
    // 背景：沙箱边缘按 UA/出口分流，真机浏览器偶发被分到 openapi 桌面集群（登录跳生产 SSO，
    // 沙箱账号必败）；代发拿到的签发地址不绑买家 IP。任何失败 ⇒ 回退下面的自动提交表单页。
    if (isMobileUserAgent(userAgent)) {
      const warmed = await this.orders.resolveMobileCashier({
        gatewayUrl: context.gatewayUrl,
        fields: context.fields,
      });
      if (warmed.ok) {
        res.status(302);
        res.setHeader('Location', warmed.data.cashierUrl);
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        res.send('');
        return;
      }
      this.logger.warn(
        `手机收银台代发失败，回退浏览器自动提交表单 order_no=${orderNo}: ${warmed.lastError}`,
      );
    }

    const html = renderCashierPage({ gatewayUrl: context.gatewayUrl, fields: context.fields });
    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  }

  /** 终态提示页（统一安全头；语句拆开，接收者恒为裸 `res`）。 */
  private replyPage(res: CashierHttpResponse, status: number, title: string, message: string): void {
    const html = renderCashierMessagePage(title, message);
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  }
}

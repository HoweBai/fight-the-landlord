/**
 * 支付片 T7：玩家面订单 REST（§2.4.1 #1–#4）——`POST /api/pay/orders` ·
 * `GET /api/pay/orders/:orderNo` · `POST /api/pay/orders/:orderNo/sync` · `GET /api/pay/orders/mine`。
 *
 * ─── 身份面（照 `/api/wallet`、`/api/records/mine` 先例）──────────────────
 * 身份**只**取网关注入的 `X-User-Id`（jwt 中间件验签后注入；本服务要求的 `X-Internal-Token`
 * 由全局中间件在 `main.ts` 统一强制——直连 3007 + 伪造 `X-User-Id` 打不进来）。缺/空 ⇒
 * **10002/401**（fail-closed，空串视同缺失）。
 *
 * ─── 🔴 路由次序（§2.4.1 路由注册次序条）────────────────────────────────
 * 静态段 `mine` **必须先于**参数段 `:orderNo` 注册（Nest 按方法声明序注册路由）——
 * 否则 `GET /api/pay/orders/mine` 会命中 `:orderNo` 而 15002。**不得**调换下面两个方法的
 * 声明顺序（`orders-state.test.ts` 的 ⑧ 用真 HTTP 钉住：`/mine` 不得 15002）。
 *
 * ─── 错误面 ─────────────────────────────────────────────────────────────
 * service 抛 `DomainError`，本层经 `toHttpException` 翻成契约码 + 状态码
 * （10001⇒400 · 15001⇒502 · 15002⇒404 · 15008⇒409；表在 `http/errors.ts`，⚙️8）。
 */

import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import type {
  PayCreateOrderRequest,
  PayCreateOrderResponse,
  PayOrderInfo,
  PayOrdersPage,
} from '@fight-the-landlord/protocol';
import { httpException, toHttpException } from '../http/errors';
import { OrdersService } from './orders.service';

/** 网关注入的用户身份头（小写规范形；照 currency `wallet.controller.ts` 先例）。 */
export const USER_ID_HEADER = 'x-user-id';

function requireUserId(userId: string | undefined): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
  }
  return userId;
}

@Controller('pay/orders')
export class OrdersController {
  /** ⚠️ **值导入** `OrdersService`（DI 陷阱纪律）+ 显式 `@Inject`（不依赖隐式注入的既有惯例）。 */
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /** #1 下单（成功 200；15008/10001/15001 见类头错误面）。 */
  @Post()
  @HttpCode(200) // POST 的 Nest 缺省是 201；本端点成功按 200（§2.4.1 表）
  async create(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Body() body: PayCreateOrderRequest | undefined,
  ): Promise<{ code: ErrCode; data: PayCreateOrderResponse }> {
    const uid = requireUserId(userId);
    try {
      const packageYuan = (body as { packageYuan?: unknown } | undefined)?.packageYuan;
      return { code: ErrCode.OK, data: await this.orders.createOrder(uid, packageYuan) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /**
   * #4 我的订单（keyset；只本人）。
   * 🔴 **静态段先于参数段**——本方法必须声明在 `getById`（`:orderNo`）之前（见类头）。
   */
  @Get('mine')
  async mine(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ code: ErrCode; data: PayOrdersPage }> {
    const uid = requireUserId(userId);
    try {
      return { code: ErrCode.OK, data: await this.orders.mine(uid, { cursor, limit }) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /** #2 订单详情（非本人/不存在 ⇒ 15002）。 */
  @Get(':orderNo')
  async getById(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Param('orderNo') orderNo: string,
  ): Promise<{ code: ErrCode; data: PayOrderInfo }> {
    const uid = requireUserId(userId);
    try {
      return { code: ErrCode.OK, data: await this.orders.getById(uid, orderNo) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /** #3 主动查询补单（同 #2 响应形；查询失败不翻错误面——写 `last_error` 后返回现态）。 */
  @Post(':orderNo/sync')
  @HttpCode(200) // POST 的 Nest 缺省是 201；本端点成功按 200（§2.4.1 表）
  async sync(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Param('orderNo') orderNo: string,
  ): Promise<{ code: ErrCode; data: PayOrderInfo }> {
    const uid = requireUserId(userId);
    try {
      return { code: ErrCode.OK, data: await this.orders.sync(uid, orderNo) };
    } catch (err) {
      throw toHttpException(err);
    }
  }
}

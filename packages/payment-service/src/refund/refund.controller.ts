/**
 * 支付片 T11：退款**玩家面**控制器（§2.4.1 #6：`POST /api/pay/refunds`；
 * **T13 补** ⑦ `GET /api/pay/refunds/mine`——keyset）。
 *
 * ─── 身份面（照 `/api/pay/orders`、`/api/pay/withdrawals` 先例）─────────────────
 * 身份**只**取网关注入的 `X-User-Id`（jwt 中间件验签后注入；本服务要求的 `X-Internal-Token`
 * 由全局中间件在 `main.ts` 统一强制——直连 3007 + 伪造 `X-User-Id` 打不进来）。缺/空 ⇒
 * **10002/401**（fail-closed，空串视同缺失）。
 *
 * ─── 错误面 ─────────────────────────────────────────────────────────────
 * service 抛 `DomainError`，本层经 `toHttpException` 翻成契约码 + 状态码
 * （15002⇒404 · 15006⇒409 · 10001⇒400；表在 `http/errors.ts`，⚙️8）。
 */

import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import type { PayRefundApplyResponse, PayRefundsPage } from '@fight-the-landlord/protocol';
import { httpException, toHttpException } from '../http/errors';
import { USER_ID_HEADER } from '../orders/orders.controller';
import { RefundService } from './refund.service';

function requireUserId(userId: string | undefined): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
  }
  return userId;
}

@Controller('pay/refunds')
export class RefundController {
  /** ⚠️ **值导入** `RefundService`（DI 陷阱纪律）+ 显式 `@Inject`（既有惯例）。 */
  constructor(@Inject(RefundService) private readonly refunds: RefundService) {}

  /** #6 申请退款（申请即冻结；成功 200；15002/15006 见类头错误面；锁内校验与冻结在服务层）。 */
  @Post()
  @HttpCode(200) // POST 的 Nest 缺省是 201；本端点成功按 200（§2.4.1 表）
  async apply(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Body() body: { orderNo?: unknown; reason?: unknown } | undefined,
  ): Promise<{ code: ErrCode; data: PayRefundApplyResponse }> {
    const uid = requireUserId(userId);
    try {
      return { code: ErrCode.OK, data: await this.refunds.apply(uid, body) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /** #7 我的退款（keyset；只本人；T13）。 */
  @Get('mine')
  async mine(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ code: ErrCode; data: PayRefundsPage }> {
    const uid = requireUserId(userId);
    try {
      return { code: ErrCode.OK, data: await this.refunds.mine(uid, { cursor, limit }) };
    } catch (err) {
      throw toHttpException(err);
    }
  }
}

/**
 * 支付片 T10：提现**玩家面**控制器（§2.4.1 #8：`POST /api/pay/withdrawals`；
 * **T13 补** ⑨ `GET /api/pay/withdrawals/mine`——keyset；⑤ wallet/summary 归 T13 的
 * `wallet/wallet.controller.ts`）。
 *
 * ─── 身份面（照 `/api/pay/orders`、`/api/wallet` 先例）────────────────────
 * 身份**只**取网关注入的 `X-User-Id`（jwt 中间件验签后注入；本服务要求的 `X-Internal-Token`
 * 由全局中间件在 `main.ts` 统一强制——直连 3007 + 伪造 `X-User-Id` 打不进来）。缺/空 ⇒
 * **10002/401**（fail-closed，空串视同缺失）。
 *
 * ─── 错误面 ─────────────────────────────────────────────────────────────
 * service 抛 `DomainError`，本层经 `toHttpException` 翻成契约码 + 状态码
 * （15003/15004/15005 ⇒ 409——表在 `http/errors.ts`，⚙️8；不补则 4xx 静默变 500）。
 */

import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ErrCode } from '@fight-the-landlord/protocol';
import type { PayWithdrawApplyResponse, PayWithdrawalsPage } from '@fight-the-landlord/protocol';
import { httpException, toHttpException } from '../http/errors';
import { USER_ID_HEADER } from '../orders/orders.controller';
import { WithdrawService } from './withdraw.service';
import { ConfigCacheService } from '../config/config-cache.service';
import { REDIS } from '../redis/redis.module';

function requireUserId(userId: string | undefined): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
  }
  return userId;
}

/** reauth 票据的 Redis key（与 user-service auth.service.ts 里 `REAUTH_KEY_PREFIX` 同值）。 */
const REAUTH_KEY = (userId: string, ticket: string): string => `reauth:${userId}:${ticket}`;
/** 客户端票据 header 名。 */
const REAUTH_HEADER = 'x-reauth-ticket';

@Controller('pay/withdrawals')
export class WithdrawController {
  /**
   * ⚠️ **值导入**（DI 陷阱纪律）+ 显式 `@Inject`（既有惯例）。
   * WithdrawService / ConfigCacheService / REDIS 三个 provider 都必须在
   * app.module.ts 或其子模块注册——未注册 = 真容器启动崩（单测传替身看不见）。
   */
  constructor(
    @Inject(WithdrawService) private readonly withdrawals: WithdrawService,
    @Inject(ConfigCacheService) private readonly configCache: ConfigCacheService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** #8 申请提现（成功 200；15003/15004/15005 见类头错误面；锁内校验与冻结在服务层）。 */
  @Post()
  @HttpCode(200) // POST 的 Nest 缺省是 201；本端点成功按 200（§2.4.1 表）
  async apply(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Headers(REAUTH_HEADER) ticket: string | undefined,
    @Body() body: { coins?: unknown } | undefined,
  ): Promise<{ code: ErrCode; data: PayWithdrawApplyResponse }> {
    const uid = requireUserId(userId);

    // 提交 3：提现敏感操作再认证票据闸。
    // 开关关（默认 false）→ 跳过票据验证，直接放行（暗上线零影响）。
    // 开关开 → 强制要求 X-Reauth-Ticket header，Redis DEL 原子消费一次性票据。
    if (this.configCache.withdrawReAuthEnabled()) {
      if (typeof ticket !== 'string' || ticket.length === 0) {
        throw httpException(ErrCode.FORBIDDEN, 'reauth ticket required');
      }
      /**
       * P0-3：**Redis 故障与票据无效必须分开**（原先同在一个 `try` 里，catch 把故意抛出的
       * FORBIDDEN 也改写成「服务不可用」，且 FORBIDDEN 当时无 HTTP 映射 ⇒ 500）：
       *  - 票据无效/过期/已消费 ⇒ 403 + `FORBIDDEN`（客户端应重新再认证）；
       *  - Redis 不可用 ⇒ 503 + `UPSTREAM_UNAVAILABLE`（客户端稍后重试即可）。
       * 两者都是 fail-closed：绝不放行。
       */
      let claimed: number;
      try {
        claimed = await this.redis.del(REAUTH_KEY(uid, ticket));
      } catch {
        throw httpException(ErrCode.UPSTREAM_UNAVAILABLE, 'reauth service unavailable');
      }
      if (claimed !== 1) {
        // DEL 返回 0 = 键不存在（过期/已用/跨用户）。fail-closed：拦截提现。
        throw httpException(ErrCode.FORBIDDEN, 'reauth ticket invalid or expired');
      }
    }

    try {
      const coins = (body as { coins?: unknown } | undefined)?.coins;
      return { code: ErrCode.OK, data: await this.withdrawals.apply(uid, coins) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /** #9 我的提现（keyset；只本人；T13）。静态段无参数段竞争者（本控制器 `@Post()` 与 `mine` 不同方法）。 */
  @Get('mine')
  async mine(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ code: ErrCode; data: PayWithdrawalsPage }> {
    const uid = requireUserId(userId);
    try {
      return { code: ErrCode.OK, data: await this.withdrawals.mine(uid, { cursor, limit }) };
    } catch (err) {
      throw toHttpException(err);
    }
  }
}

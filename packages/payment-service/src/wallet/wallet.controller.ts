/**
 * 支付片 T13：**玩家钱包读面**（§2.4.1 #5：`GET /api/pay/wallet/summary`）——恒三字段
 * `{balance, withdrawable, dailyWithdrawRemainingCoins}`：
 *  - `balance`：经 `currency.get`（`exists=false ⇒ 0` 的读路径既有语义）；
 *  - `withdrawable`：`currency.withdrawable.get` 的 **cap**（§2.2.1；只读展示切片——资金裁决点
 *    恒在提现/退款锁内实时重取，本读**不放宽**那条纪律）；
 *  - `dailyWithdrawRemainingCoins`：`pay.withdrawDailyMaxCoins − 当日已占`（§3.2 日限口径，
 *    **共享读** `queryWithdrawDayTotal`——与 `WithdrawService.apply` 的日限闸同一实现，禁双份；
 *    下钳 0 的实现选择见 `withdraw-day-limit.ts`）。
 *
 * ─── 并行（任务卡逐字）─────────────────────────────────────────────────────
 *  前两者（get/withdrawable）与日限 DB 读**并行**（`Promise.all`）——本端点是被 T14 钱包页
 *  高频轮询的读面，串行叠加 3s RPC 超时会白拖延迟。
 *
 * ─── 身份面（照 `/api/pay/orders`、`/api/wallet` 先例）────────────────────
 *  身份**只**取网关注入的 `X-User-Id`（本服务要求的 `X-Internal-Token` 由全局中间件在
 *  `main.ts` 统一强制——直连 3007 + 伪造 `X-User-Id` 打不进来）。缺/空 ⇒ **10002/401**
 *  （fail-closed，空串视同缺失）。
 *
 * ─── 失败面（fail-closed，不伪造读数）─────────────────────────────────────
 *  任一读数失败（`CurrencyServiceError`——传输/信封面）⇒ **10007 + 503**（`user-service`
 *  register 先例：「裸错误经 `toHttpException` 会退化成 400 —— 最像正确答案的错」；
 *  `HTTP_STATUS` 的 `10007→503` 由 T13 补登，防止 `?? 500` 静默变 500）。**绝不**把
 *  余额/cap 回落成 0 —— 读面显示 0 会被玩家当成「钱没了」。
 */

import { Controller, Get, Headers, Inject, Logger } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import type { CurrencyGetData, PayWalletSummary } from '@fight-the-landlord/protocol';
import { DataSource } from 'typeorm';
import { ConfigCacheService } from '../config/config-cache.service';
import { httpException, toHttpException } from '../http/errors';
import { USER_ID_HEADER } from '../orders/orders.controller';
import { CurrencyRpcClient, CurrencyServiceError, TRANSPORT_FAILURE_MESSAGE } from '../rpc/currency.client';
import { queryWithdrawDayTotal, remainingDailyWithdrawCoins } from '../withdraw/withdraw-day-limit';

function requireUserId(userId: string | undefined): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
  }
  return userId;
}

/** `currency.get` 回执里取本人余额；**严格读**（缺条目/坏形状 ⇒ 响亮抛——回执不可信不静默成 0）。 */
function balanceOf(data: CurrencyGetData, ownerId: string): number {
  const hit = (data?.balances ?? []).find((b) => b?.ownerId === ownerId);
  const balance = hit?.balance;
  if (typeof balance !== 'number' || !Number.isSafeInteger(balance) || balance < 0) {
    throw new Error(
      `currency.get 回执 balances 中缺少 ${ownerId} 的合法 balance 条目（收到 ${JSON.stringify(data)}）—— 拒用`,
    );
  }
  return balance;
}

@Controller('pay/wallet')
export class WalletController {
  private readonly logger = new Logger(WalletController.name);

  /** ⚠️ **值导入**三个依赖（DI 陷阱纪律）+ 显式 `@Inject`（既有惯例）。 */
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigCacheService) private readonly configCache: ConfigCacheService,
    @Inject(CurrencyRpcClient) private readonly currency: CurrencyRpcClient,
  ) {}

  /** #5 钱包摘要（成功 200；三字段见类头；依赖失败 ⇒ 10007/503）。 */
  @Get('summary')
  async summary(
    @Headers(USER_ID_HEADER) userId: string | undefined,
  ): Promise<{ code: ErrCode; data: PayWalletSummary }> {
    const uid = requireUserId(userId);
    try {
      const [balancesData, capData, dayTotal] = await Promise.all([
        this.currency.get({ ownerIds: [uid] }),
        this.currency.withdrawable({ ownerId: uid }),
        queryWithdrawDayTotal(this.dataSource, uid),
      ]);
      return {
        code: ErrCode.OK,
        data: {
          balance: balanceOf(balancesData, uid),
          withdrawable: capData.cap,
          dailyWithdrawRemainingCoins: remainingDailyWithdrawCoins(
            this.configCache.withdrawDailyMaxCoins(),
            dayTotal,
          ),
        },
      };
    } catch (err) {
      if (err instanceof CurrencyServiceError) {
        // fail-closed：读数拿不到 ⇒ 10007 + 503（原因只进日志，不透传内部拓扑）；不伪造 0。
        this.logger.warn(`wallet summary 依赖读数失败（fail-closed）user_id=${uid}: code=${err.code}`);
        throw httpException(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
      }
      throw toHttpException(err);
    }
  }
}

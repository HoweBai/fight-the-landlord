import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';

/**
 * 契约错误码 → HTTP 状态码（支付片规格 ⚙️8 的**全表**）——**每服务各一份**的复制件
 * （user/config/currency 三份逐字同形；收口点在 `docs/design.md` §11.1/§11.2）。
 *
 * 🔴 **不补则该 4xx 静默变 500**（货币片 §8 学费）：下表之外的码会落到
 * `httpException()` 的 `?? 500` 兜底 —— 「409 的语义」当场丢失。映射表有单测
 * （`test/boot.test.ts` 的 ⚙️8 节）逐条盯住，含「15007 **不得**在表」的负向判据。
 *
 * ⚙️8 逐字：
 *  10001→400 ·
 *  15001→502（渠道不可用——**上游**语义，与 10007 的服务间语义区分）·
 *  15002→404 ·
 *  15003/15004/15005/15006/15008/**15009**→409 ·
 *  **15007→不出站**（`PAY_NOTIFY_VERIFY_FAILED`：回调验签失败是**服务端内部事件**
 *  —— 只日志 + 指标，`200 failure` 应答由 notify 链自行承载；入 `RESERVED_CODES`，
 *  照 `BOT_DECISION_TIMEOUT` 先例 ⇒ **本表不登记**）。
 */
export const HTTP_STATUS: Partial<Record<ErrCode, number>> = {
  [ErrCode.BAD_PARAM]: 400,
  // P0-3（提现再认证闸）：票据无效/过期/已消费的守卫码 —— 不补则 403 经 `?? 500`
  // 静默变 500，客户端无法区分「重新再认证」与「服务故障」。与 user/currency 表同值。
  [ErrCode.FORBIDDEN]: 403,
  // T7（玩家面订单控制器）：`X-User-Id` 缺失/空的守卫码——不补则 401 经 `?? 500` **静默变
  // 500**（同一「⚙️8 学费」；照 user/currency 表先例，其余服务同表）。网关恒注入 ⇒ 只影响
  // 直连形态（直连还须过 internal-token 中间件）。
  [ErrCode.UNAUTHENTICATED]: 401,
  // T13（玩家钱包读面）：上游读数不可得的 fail-closed 码——`wallet.controller` 把
  // `CurrencyServiceError` 明确翻成本码（裸错误经 toHttpException 会退化成 400，
  // 「最像正确答案的错」，照 user-service register 先例）。10007⇒503 与 user/currency
  // 两表逐字同值；不补则经 `?? 500` 静默变 500（⚙️8 九条之外第二条平台码，照 T7 的
  // 10002 登记先例）。
  [ErrCode.UPSTREAM_UNAVAILABLE]: 503,
  // 支付九码（⚙️8；15007 除外——见文件头）。
  [ErrCode.PAY_CHANNEL_ERROR]: 502,
  [ErrCode.PAY_ORDER_NOT_FOUND]: 404,
  [ErrCode.PAY_WITHDRAW_UNAVAILABLE]: 409,
  [ErrCode.PAY_WITHDRAW_LIMIT]: 409,
  [ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT]: 409,
  [ErrCode.PAY_REFUND_UNAVAILABLE]: 409,
  [ErrCode.PAY_DISABLED]: 409,
  [ErrCode.PAY_STATE_CONFLICT]: 409,
};

/** 统一响应形态（§11.1）：`{ code, message, data }`。 */
export function httpException(code: ErrCode, message: string): HttpException {
  return new HttpException({ code, message, data: null }, HTTP_STATUS[code] ?? 500);
}

/** 领域错误：service 层用它携带契约错误码，controller 层翻成 HTTP。 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** service 抛出的任何异常 → 带契约码的 HttpException（照 game.controller.ts:44-48）。 */
export function toHttpException(err: unknown): HttpException {
  if (err instanceof DomainError) return httpException(err.code, err.message);
  const message = err instanceof Error ? err.message : String(err);
  return httpException(ErrCode.BAD_PARAM, message);
}

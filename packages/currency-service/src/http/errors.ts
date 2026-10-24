import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';

/**
 * 契约错误码 → HTTP 状态码（§11.2）——**每服务各一份**的复制件
 * （user/config/currency 三份逐字同形；收口点在 `docs/design.md` §11.1/§11.2）。
 *
 * 货币片（T5，规格 §2.9）：补 **14001/14002 → 409** —— 不补则两条货币错误码
 * 经下面的 `?? 500` 兜底**静默变 500**（「409 的语义」当场丢失）。映射表有单测
 * （`test/http-errors.test.ts`）逐条盯住。
 *
 * ② 金币场（T8，规格 §9）：补 **14004 → 409**（design.md §11.2 表 —— relief 端点
 * 两条拒绝「救助暂未开放」/「余额充足，无需救助」都走它）。
 */
export const HTTP_STATUS: Partial<Record<ErrCode, number>> = {
  [ErrCode.BAD_PARAM]: 400,
  [ErrCode.UNAUTHENTICATED]: 401,
  [ErrCode.FORBIDDEN]: 403,
  [ErrCode.TOKEN_EXPIRED]: 401,
  [ErrCode.TOKEN_INVALID]: 401,
  [ErrCode.PHONE_TAKEN]: 409,
  [ErrCode.BAD_CREDENTIALS]: 401,
  [ErrCode.USER_BANNED]: 403,
  [ErrCode.USER_NOT_FOUND]: 404,
  [ErrCode.UPSTREAM_UNAVAILABLE]: 503,
  // 货币两码（规格 §2.9）：14001 余额不足 / 14002 actionId 冲突。
  [ErrCode.E_INSUFFICIENT_FUNDS]: 409,
  [ErrCode.E_ACTION_CONFLICT]: 409,
  // ② 金币场（规格 §9 / design.md §11.2）：14004 救助不可用（开关关 / 余额充足）。
  [ErrCode.E_RELIEF_UNAVAILABLE]: 409,
  // 记牌器收费片：14008 未开放 / 14009 价格已更新 / 14010 请求号冲突。
  [ErrCode.E_CARD_COUNTER_UNAVAILABLE]: 409,
  [ErrCode.E_CARD_COUNTER_PRICE_CHANGED]: 409,
  [ErrCode.E_CARD_COUNTER_REQUEST_CONFLICT]: 409,
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

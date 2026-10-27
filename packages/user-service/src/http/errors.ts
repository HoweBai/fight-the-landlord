import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';

/** 契约错误码 → HTTP 状态码（§11.2）。 */
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
  [ErrCode.DEVICE_MISMATCH]: 403,
  [ErrCode.UPSTREAM_UNAVAILABLE]: 503,
  // 代理分润（2026-10-26）：邀请码无效 400；冻结 403。
  [ErrCode.AGENT_INVITE_INVALID]: 400,
  [ErrCode.AGENT_FROZEN]: 403,
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

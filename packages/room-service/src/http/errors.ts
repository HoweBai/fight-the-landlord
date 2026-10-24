import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';

/**
 * 契约错误码 → HTTP 状态码（§11.2）。
 *
 * 照 `game-service/src/game/game.controller.ts:24-42` 的本地实现模式（R23）：
 * 信封**按服务本地实现**，不引入新抽象层、不把 Nest 代码塞进 `packages/shared`。
 * 这张表只列 room-service 真正会返回的码。
 */
export const HTTP_STATUS: Partial<Record<ErrCode, number>> = {
  [ErrCode.BAD_PARAM]: 400,
  [ErrCode.UNAUTHENTICATED]: 401,
  [ErrCode.FORBIDDEN]: 403,
  [ErrCode.ROOM_NOT_FOUND]: 404,
  [ErrCode.ROOM_FULL]: 409,
  [ErrCode.ROOM_ALREADY_STARTED]: 409,
  [ErrCode.NOT_IN_ROOM]: 403,
  [ErrCode.UPSTREAM_UNAVAILABLE]: 503,
  // 片⑦ T7：好友房开关（`RoomsController` 的 create/join 入口）。状态码取自
  // design.md §11.2 的码表（`12006 好友房创建失败 ⇒ 400`）—— 缺了它会落到 `?? 500`。
  [ErrCode.FRIEND_ROOM_FAILED]: 400,
  // 多玩法（Task 2.2 / D9）：玩法未开放 / 人数不支持 / 客户端与房间玩法不符
  // ⇒ 4xx（400，与 12006/12010 同族）；缺了它 REST 建房/join 会变 500。
  [ErrCode.GAME_UNAVAILABLE]: 400,
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

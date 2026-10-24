// packages/game-service/src/game/game.errors.ts
import { ErrCode } from '@fight-the-landlord/protocol';

/**
 * 带契约错误码的领域异常（§11）。
 *
 * 规则引擎抛的是 `Error('Not your turn')` 这类字符串（§11.4 的偏差 E5），
 * 表示层绝不能把它当作响应码。这里做**唯一**的映射，HTTP/WS/ack 三条路径
 * 共用同一张表。
 */
export class GameError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

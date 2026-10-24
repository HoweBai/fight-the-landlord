import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  Post,
} from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { CardCounterService } from './card-counter.service';
import { DomainError, httpException } from '../http/errors';

export const USER_ID_HEADER = 'x-user-id';

/**
 * 记牌器收费片：玩家 REST（`GET /api/card-counter/status` / `POST /api/card-counter/purchase`）。
 *
 * - 身份只取网关验签后注入的 `X-User-Id`（缺/空 ⇒ 10002/401）；
 * - 业务错误（DomainError）⇒ `httpException(code)`（14008/14009/14010 映射 409 见 `http/errors.ts`）；
 * - 系统级故障 ⇒ 10007/503（详情只进日志，不透传内部拓扑）。
 */
@Controller('card-counter')
export class CardCounterController {
  private readonly logger = new Logger(CardCounterController.name);

  constructor(@Inject(CardCounterService) private readonly service: CardCounterService) {}

  @Get('status')
  @HttpCode(200)
  async status(
    @Headers(USER_ID_HEADER) userId: string | undefined,
  ): Promise<{ code: ErrCode; data: unknown }> {
    const id = this.requireUserId(userId);
    try {
      return { code: ErrCode.OK, data: await this.service.status(id) };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  @Post('purchase')
  @HttpCode(200)
  async purchase(
    @Headers(USER_ID_HEADER) userId: string | undefined,
    @Body() body: unknown,
  ): Promise<{ code: ErrCode; data: unknown }> {
    const id = this.requireUserId(userId);
    try {
      return { code: ErrCode.OK, data: await this.service.buy(id, body) };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  private requireUserId(raw: string | undefined): string {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw httpException(ErrCode.UNAUTHENTICATED, 'X-User-Id header is required');
    }
    return raw;
  }

  private mapError(err: unknown): HttpException {
    if (err instanceof DomainError) return httpException(err.code, err.message);
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`card-counter 系统级失败（映射 UPSTREAM_UNAVAILABLE）：${message}`);
    return httpException(ErrCode.UPSTREAM_UNAVAILABLE, '记牌器服务暂不可用');
  }
}

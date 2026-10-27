import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError, toHttpException } from '../http/errors';
import { AgentAuthService } from './agent-auth.service';
import { AgentGuard, agentIdOf, type AgentRequest } from './agent.guard';
import { AgentPortalService } from './agent-portal.service';
import { AgentSettlementService } from './agent-settlement.service';

function pageOf(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Number(query.page ?? 0);
  const pageSize = Number(query.pageSize ?? 20);
  return {
    page: Number.isFinite(page) && page >= 0 ? Math.trunc(page) : 0,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.trunc(pageSize) : 20,
  };
}

function stringOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError(ErrCode.BAD_PARAM, `${name} 不能为空`);
  }
  return value;
}

function idOf(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new DomainError(ErrCode.BAD_PARAM, 'id 非法');
  return id;
}

/**
 * 代理门户 REST（spec §8.2）。
 *
 * - `POST /api/agent/login` 公开（网关 AgentAuthMiddleware 豁免；IP 桶 + 服务内按手机号失败计数）；
 * - 其余全部 `AgentGuard`：只认网关注入的 `x-agent-id` + `x-agent-ver`；
 * - 所有读面 `agent_id` 只来自 guard（**绝不**从 query/body 取 —— IDOR 负例）。
 */
@Controller('agent')
export class AgentPortalController {
  constructor(
    private readonly auth: AgentAuthService,
    private readonly portal: AgentPortalService,
    private readonly settlements: AgentSettlementService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { phone?: unknown; password?: unknown }) {
    try {
      const phone = stringOf(body?.phone, 'phone');
      const password = stringOf(body?.password, 'password');
      return { code: ErrCode.OK, data: await this.auth.login({ phone, password }) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  async changePassword(
    @Req() req: AgentRequest,
    @Body() body: { oldPassword?: unknown; newPassword?: unknown },
  ) {
    try {
      const oldPassword = stringOf(body?.oldPassword, 'oldPassword');
      const newPassword = stringOf(body?.newPassword, 'newPassword');
      return {
        code: ErrCode.OK,
        data: await this.auth.changePassword({
          agentId: agentIdOf(req),
          oldPassword,
          newPassword,
        }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('me')
  @UseGuards(AgentGuard)
  async me(@Req() req: AgentRequest) {
    try {
      return { code: ErrCode.OK, data: await this.portal.profile(agentIdOf(req)) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('overview')
  @UseGuards(AgentGuard)
  async overview(@Req() req: AgentRequest) {
    try {
      return { code: ErrCode.OK, data: await this.portal.overview(agentIdOf(req)) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('players')
  @UseGuards(AgentGuard)
  async players(@Req() req: AgentRequest, @Query() query: Record<string, unknown>) {
    try {
      const { page, pageSize } = pageOf(query);
      return {
        code: ErrCode.OK,
        data: await this.portal.players(agentIdOf(req), page, pageSize),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('commissions')
  @UseGuards(AgentGuard)
  async commissions(@Req() req: AgentRequest, @Query() query: Record<string, unknown>) {
    try {
      const { page, pageSize } = pageOf(query);
      return {
        code: ErrCode.OK,
        data: await this.portal.commissions(agentIdOf(req), page, pageSize),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('subtree')
  @UseGuards(AgentGuard)
  async subtree(@Req() req: AgentRequest) {
    try {
      return { code: ErrCode.OK, data: await this.portal.subtree(agentIdOf(req)) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('settlements')
  @UseGuards(AgentGuard)
  async listSettlements(@Req() req: AgentRequest, @Query() query: Record<string, unknown>) {
    try {
      const { page, pageSize } = pageOf(query);
      return {
        code: ErrCode.OK,
        data: await this.settlements.listByAgent(agentIdOf(req), page, pageSize),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('settlements')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  async createSettlement(
    @Req() req: AgentRequest,
    @Body() body: { clientRequestId?: unknown },
  ) {
    try {
      const clientRequestId = stringOf(body?.clientRequestId, 'clientRequestId');
      const agentId = agentIdOf(req);
      return {
        code: ErrCode.OK,
        data: await this.settlements.create({ agentId, clientRequestId, actor: agentId }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('settlements/:id')
  @UseGuards(AgentGuard)
  async settlementDetail(@Req() req: AgentRequest, @Param('id') id: string) {
    try {
      const detail = await this.portal.settlementDetail(agentIdOf(req), idOf(id));
      if (detail === null) throw new DomainError(ErrCode.BAD_PARAM, '结算单不存在');
      return { code: ErrCode.OK, data: detail };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('settlements/:id/cancel')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  async cancelSettlement(@Req() req: AgentRequest, @Param('id') id: string) {
    try {
      const agentId = agentIdOf(req);
      return {
        code: ErrCode.OK,
        data: await this.settlements.cancel({ id: idOf(id), agentId, actor: agentId }),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }
}

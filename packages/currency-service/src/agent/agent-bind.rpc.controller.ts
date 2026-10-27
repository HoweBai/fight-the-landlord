import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type AgentBindRequest,
  type AgentBindResponse,
} from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';
import { AgentBindingsService } from './agent-bindings.service';

/**
 * `agent.bind` 接收侧（代理分润片）：注册时绑定代理。
 *
 * 业务错误不抛（R220 信封）：邀请码无效 ⇒ `AGENT_INVITE_INVALID`；载荷非法 ⇒ `10001`；
 * 其它异常 ⇒ `UPSTREAM_UNAVAILABLE`（调用方注册失败 10007）。
 * 开关关闭 ⇒ `{ok:true,data:{status:'ignored'}}`（注册照常，不归属）。
 */
@Controller()
export class AgentBindRpcController {
  private readonly logger = new Logger(AgentBindRpcController.name);

  constructor(private readonly bindings: AgentBindingsService) {}

  @MessagePattern(RPC_PATTERNS.agentBind)
  async bind(@Payload() dto: AgentBindRequest): Promise<AgentBindResponse> {
    if (
      typeof dto !== 'object' ||
      dto === null ||
      typeof dto.ownerId !== 'string' ||
      dto.ownerId.length === 0 ||
      typeof dto.code !== 'string' ||
      typeof dto.phone !== 'string' ||
      dto.source !== 'signup'
    ) {
      return { ok: false, code: ErrCode.BAD_PARAM, message: 'agent.bind 载荷非法' };
    }
    try {
      const result = await this.bindings.bindFromSignup({
        ownerId: dto.ownerId,
        code: dto.code,
        phone: dto.phone,
      });
      return { ok: true, data: result };
    } catch (err) {
      if (err instanceof DomainError) {
        return { ok: false, code: err.code, message: err.message };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`agent.bind 失败 ownerId=${dto.ownerId}: ${message}`);
      return {
        ok: false,
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: '代理绑定暂时不可用，请稍后重试',
      };
    }
  }
}

import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type UserAgentProfileGetRequest,
  type UserAgentProfileGetResponse,
} from '@fight-the-landlord/protocol';
import { UsersRepository } from '../users/users.repository';

/**
 * `user.agentProfile.get` 接收侧（代理分润片）：单玩家昵称 + 手机号。
 *
 * - 只读、内部边（currency-service 管理补绑时算 `phone_hash`）；
 * - **PII**：只经 TCP 内网、不落日志、不进任何玩家响应；
 * - 不存在 ⇒ `{nickname:null, phone:null}`（合法事实，不是漏项）；
 * - 非法载荷 ⇒ `{ok:false, BAD_PARAM}`；DB 故障 ⇒ `{ok:false, UPSTREAM_UNAVAILABLE}`。
 *
 * ⚠️ J21 三同提交：`@MessagePattern` + `RPC_PATTERNS.userAgentProfileGet` +
 * `app.module.ts` 的 `controllers:` 注册。
 */
@Controller()
export class UserAgentProfileRpcController {
  private readonly logger = new Logger(UserAgentProfileRpcController.name);

  constructor(private readonly usersRepo: UsersRepository) {}

  @MessagePattern(RPC_PATTERNS.userAgentProfileGet)
  async get(@Payload() dto: UserAgentProfileGetRequest): Promise<UserAgentProfileGetResponse> {
    if (typeof dto !== 'object' || dto === null || typeof dto.userId !== 'string' || dto.userId.length === 0) {
      return { ok: false, code: ErrCode.BAD_PARAM, message: 'userId 必须是非空字符串' };
    }
    try {
      const user = await this.usersRepo.findById(dto.userId);
      return {
        ok: true,
        data: {
          userId: dto.userId,
          nickname: user?.nickname ?? null,
          phone: user?.phone ?? null,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`user.agentProfile.get 失败：${message}`);
      return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message };
    }
  }
}

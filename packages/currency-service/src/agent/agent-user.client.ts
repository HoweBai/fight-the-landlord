import { Injectable, Logger } from '@nestjs/common';
import { ClientProxy, Transport, type TcpClientOptions } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type RpcResult,
  type UserAgentProfileData,
  type UserAgentProfileGetResponse,
  type UserNicknameEntry,
  type UserNicknamesGetResponse,
} from '@fight-the-landlord/protocol';
import { metaFromTrace } from '@fight-the-landlord/shared';
import { lastValueFrom, timeout } from 'rxjs';

export const AGENT_USER_RPC_PROXY = 'AGENT_USER_RPC_PROXY';
export const AGENT_USER_CLIENT_TIMEOUT_MS = 3000;
export const AGENT_USER_TRANSPORT_MESSAGE = '服务暂时不可用，请稍后重试';
export const AGENT_NICKNAMES_MAX_BATCH = 50;

/** currency → user 的只读 RPC 边（昵称/单玩家 profile）。 */
export const agentUserClientOptions = (): TcpClientOptions => ({
  transport: Transport.TCP,
  options: {
    host: process.env.USER_SERVICE_RPC_HOST ?? 'user-service',
    port: Number(process.env.USER_SERVICE_RPC_PORT ?? 3101),
  },
});

export class AgentUserRpcError extends Error {
  constructor(
    readonly code: ErrCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentUserRpcError';
  }
}

/**
 * 代理域 → user-service 的读边：
 * - `nicknames`：批量昵称（≤50；失败由门户降级 `—`，不 500）；
 * - `profile`：单玩家昵称+手机号（管理补绑算 phone_hash；PII 仅内部）。
 *
 * 3s / 不重试（与 `CurrencyClient` 同族）；业务错误码原样，传输故障 10007。
 */
@Injectable()
export class AgentUserClient {
  private readonly logger = new Logger(AgentUserClient.name);

  constructor(private readonly proxy: ClientProxy) {}

  async nicknames(userIds: readonly string[]): Promise<UserNicknameEntry[]> {
    // 门户一页最多 100 人，而 RPC 单批上限 50（r3 审查 Minor #5：原实现直接 slice(0,50)
    // ⇒ 第 51 人以后昵称静默变 null）。按 50 分批顺序拉取；去重后仍保持原顺序。
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return [];
    const out: UserNicknameEntry[] = [];
    for (let i = 0; i < ids.length; i += AGENT_NICKNAMES_MAX_BATCH) {
      const batch = ids.slice(i, i + AGENT_NICKNAMES_MAX_BATCH);
      const res = await this.send<UserNicknamesGetResponse>(RPC_PATTERNS.userNicknamesGet, {
        userIds: batch,
      });
      if (!res.ok) throw new AgentUserRpcError(res.code, res.message);
      out.push(...res.data.nicknames);
    }
    return out;
  }

  async profile(userId: string): Promise<UserAgentProfileData> {
    const res = await this.send<UserAgentProfileGetResponse>(
      RPC_PATTERNS.userAgentProfileGet,
      { userId },
    );
    if (!res.ok) throw new AgentUserRpcError(res.code, res.message);
    return res.data;
  }

  private async send<T extends RpcResult<unknown>>(pattern: string, payload: object): Promise<T> {
    try {
      return await lastValueFrom(
        this.proxy
          .send<T>(pattern, { ...payload, ...metaFromTrace() })
          .pipe(timeout(AGENT_USER_CLIENT_TIMEOUT_MS)),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`user-service RPC ${pattern} failed: ${reason}`);
      throw new AgentUserRpcError(ErrCode.UPSTREAM_UNAVAILABLE, AGENT_USER_TRANSPORT_MESSAGE);
    }
  }
}

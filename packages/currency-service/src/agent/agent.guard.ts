import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrCode } from '@fight-the-landlord/protocol';
import { httpException } from '../http/errors';
import { toSafeInt } from './agent.util';

/** 网关注入的代理身份头（与 `identity-headers.ts` 各定义一次 —— 仓内既有惯例）。 */
export const AGENT_ID_HEADER = 'x-agent-id';
export const AGENT_VER_HEADER = 'x-agent-ver';

const AGENT_SELECT_SQL =
  'SELECT `id`, `status`, `must_change_password`, `token_version` FROM `agent_accounts` WHERE `id` = ?';

export interface AgentRequest {
  method?: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  agentId?: string;
}

function headerOf(req: AgentRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isAllowedWhenMustChange(method: string | undefined, path: string): boolean {
  const p = path.split('?')[0] ?? path;
  const normalized = p.startsWith('/api/') ? p.slice(4) : p;
  if (method === 'GET' && normalized === '/agent/me') return true;
  if (method === 'POST' && normalized === '/agent/password') return true;
  return false;
}

/**
 * 代理门户守卫（spec §8.1）：
 * - 只信网关注入的 `x-agent-id` + `x-agent-ver`（客户端伪造值在网关先剥）；
 * - `ver` 必须等于 `agent_accounts.token_version`（改密/重置/冻结后旧令牌立即失效）；
 * - `must_change_password=1` ⇒ 只放行 `GET /agent/me` 与 `POST /agent/password`；
 * - 冻结允许读/结算（spec D10）。
 */
@Injectable()
export class AgentGuard implements CanActivate {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AgentRequest>();
    const id = headerOf(req, AGENT_ID_HEADER);
    const verRaw = headerOf(req, AGENT_VER_HEADER);
    if (typeof id !== 'string' || id.length === 0 || verRaw === undefined) {
      throw httpException(ErrCode.UNAUTHENTICATED, '代理身份缺失');
    }
    const ver = Number(verRaw);
    if (!Number.isInteger(ver) || ver < 0) {
      throw httpException(ErrCode.UNAUTHENTICATED, '代理身份缺失');
    }
    const rows = (await this.dataSource.query(AGENT_SELECT_SQL, [id])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) throw httpException(ErrCode.UNAUTHENTICATED, '代理身份缺失');
    const row = rows[0]!;
    if (toSafeInt(row.token_version, 'agent_accounts.token_version') !== ver) {
      throw httpException(ErrCode.UNAUTHENTICATED, '登录状态已失效，请重新登录');
    }
    if (Number(row.must_change_password) === 1 && !isAllowedWhenMustChange(req.method, req.path)) {
      throw httpException(ErrCode.FORBIDDEN, '首次登录请先修改密码');
    }
    req.agentId = id;
    return true;
  }
}

export function agentIdOf(req: AgentRequest): string {
  if (typeof req.agentId !== 'string' || req.agentId.length === 0) {
    throw new Error('不变量破坏：AgentGuard 未写入 agentId');
  }
  return req.agentId;
}

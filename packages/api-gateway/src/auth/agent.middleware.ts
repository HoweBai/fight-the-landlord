import { Injectable, type NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import {
  AGENT_JWT_AUDIENCE,
  AGENT_JWT_SECRET_FALLBACK,
  AGENT_JWT_TYP,
  ErrCode,
} from '@fight-the-landlord/protocol';
import { AGENT_ID_HEADER, AGENT_VER_HEADER } from './identity-headers';
import { isAgentLoginPath, isAgentPath, requestPath } from './public-paths';
import { CodedUnauthorized } from './jwt.middleware';

// Re-export constants for consumer convenience (test imports from this barrel).
export { AGENT_JWT_AUDIENCE, AGENT_JWT_TYP };

/**
 * 代理令牌密钥链（常量从 protocol 编译时 import，保证与 currency 签发侧逐字同值）。
 */
export function agentJwtSecret(): string {
  return (
    process.env.AGENT_JWT_SECRET ||
    process.env.JWT_SECRET ||
    AGENT_JWT_SECRET_FALLBACK
  );
}

interface AgentTokenClaims {
  sub?: unknown;
  typ?: unknown;
  ver?: unknown;
  aud?: unknown;
}

/**
 * 代理门户鉴权中间件（spec §8.1）。
 *
 * 顺序（`app.module.ts`）：ClientGate → Jwt → Admin → **Agent** → RateLimit。
 * - 所有路径先剥 `x-agent-id` / `x-agent-ver`（客户端伪造值永不到下游）；
 * - 非 `/api/agent/*` ⇒ next；
 * - `POST /api/agent/login`（原值精确）⇒ next（入口本身，IP 桶在限流层）；
 * - 其余要求 Bearer，验签 `aud:'ftl-agent'`，claims：`sub` 以 `ag_` 开头、`typ='agent-access'`、
 *   `ver` 非负整数；通过后注入两枚头。
 */
@Injectable()
export class AgentAuthMiddleware implements NestMiddleware {
  private readonly jwt = new JwtService({ secret: agentJwtSecret() });

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const path = requestPath(req);
    delete req.headers[AGENT_ID_HEADER];
    delete req.headers[AGENT_VER_HEADER];

    if (!isAgentPath(path)) {
      next();
      return;
    }
    if (isAgentLoginPath(path)) {
      next();
      return;
    }

    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new CodedUnauthorized(ErrCode.UNAUTHENTICATED, 'Missing agent token');
    }
    let payload: AgentTokenClaims;
    try {
      payload = this.jwt.verify(auth.slice(7), {
        audience: AGENT_JWT_AUDIENCE,
      }) as AgentTokenClaims;
    } catch {
      throw new CodedUnauthorized(ErrCode.TOKEN_INVALID, 'Invalid or expired agent token');
    }
    const { sub, typ, ver } = payload ?? {};
    if (
      typeof sub !== 'string' ||
      !sub.startsWith('ag_') ||
      typ !== AGENT_JWT_TYP ||
      typeof ver !== 'number' ||
      !Number.isInteger(ver) ||
      ver < 0
    ) {
      throw new CodedUnauthorized(ErrCode.TOKEN_INVALID, 'Invalid or expired agent token');
    }
    req.headers[AGENT_ID_HEADER] = sub;
    req.headers[AGENT_VER_HEADER] = String(ver);
    next();
  }
}

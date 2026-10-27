import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
// ⚠️ 必须是**值导入**（不是 `import type`）：下面用 `runWithTrace` 把余下处理包进 ALS ——
// DI 陷阱的教训同样适用（类型导入会被擦除，运行期只剩 undefined）。
import { runWithTrace } from '@fight-the-landlord/shared';
import { Request, Response, NextFunction } from 'express';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import {
  INTERNAL_TOKEN_HEADER,
  TOKEN_JTI_HEADER,
  TRACE_ID_HEADER,
  USER_ID_HEADER,
  isLogoutPath,
} from './identity-headers';
// ⚠️ R462：白名单与路径派生已提到**单一真源** `public-paths.ts`（限流中间件也要消费它）。
// 本文件**不得**再抄一份字面量清单。片⑦ D6①：`isAdminPath` 同源同文件。
import { isAdminPath, isAgentPath, isPublicPath, requestPath } from './public-paths';
import { SessionGuard } from './session.guard';

/** 401 + 契约信封：`UnauthorizedException` 传对象时，响应体就是该对象（§11.1）。 */
export class CodedUnauthorized extends UnauthorizedException {
  constructor(code: ErrCode, message: string) {
    super({ code, message, data: null });
  }
}

/** 403 + 契约信封（§11.2：`10003` 必须配 403，不能配 401）。 */
export class CodedForbidden extends ForbiddenException {
  constructor(code: ErrCode, message: string) {
    super({ code, message, data: null });
  }
}

/** 验签后从令牌里取出的字段（§5.1 的载荷 + R24 的 `typ`）。 */
interface AccessPayload {
  sub?: string;
  phone?: string;
  jti?: string;
  typ?: string;
}

/**
 * JWT authentication middleware for the api-gateway (docs/design.md §5.2 / §7.1).
 *
 * The gateway is the **only** verification point of the platform:
 *  - it verifies the Bearer token;
 *  - it rejects `typ !== 'access'` (R24) so a 7-day refresh token can never be
 *    used as a 2-hour access token;
 *  - it queries the `session:{jti}` whitelist (R26) so logout/rotation really
 *    take effect;
 *  - it injects `X-User-Id` / `X-Trace-Id` for downstream services;
 *  - it rejects any **external** request that carries `X-Internal-Token`,
 *    so a client can never impersonate another service.
 *
 * ⚠️ The public-path whitelist must **never** contain `'/'`: every path starts
 * with `/`, so a `'/'` entry makes the whitelist always match and disables
 * authentication entirely (deviation S1 in docs/design.md appendix A.2).
 * The whitelist itself now lives in `./public-paths` (R462：单一真源).
 */
@Injectable()
export class JwtMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: JwtService,
    private readonly session: SessionGuard,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const path = requestPath(req);

    // 兜底（复核⑪）：正常链上 `main.ts` 的 trace 中间件（**第一个** `app.use`）已经写好
    // `x-trace-id`；这里只兜「单测**直接**调用本中间件」与「有人绕过前置中间件」两种情况 ——
    // 没有它，下面的**嵌套** `runWithTrace` 与 `headersOf()` 的转发都会拿到 `undefined`
    // （链路在这一跳**静默断掉**，且不会有任何报错）。
    if (typeof req.headers[TRACE_ID_HEADER] !== 'string' || !req.headers[TRACE_ID_HEADER]) {
      req.headers[TRACE_ID_HEADER] = randomUUID();
    }

    // §5.2 rule 3: the internal token is for service-to-service calls only.
    // Anyone reaching the gateway with it is either a misrouted internal call
    // or an impersonation attempt; both are rejected before anything else.
    if (this.hasInternalToken(req)) {
      throw new CodedForbidden(
        ErrCode.FORBIDDEN,
        'Internal service token is not accepted from external callers',
      );
    }

    // R146：**公开路径也必须剥**。`headersOf()` 只认 `req.headers['x-user-id']`，
    // 而公开路径过去直接 `next()` ⇒ 客户端自带的 `X-User-Id` 会被当身份转发给下游
    // （今天下游公开路由不读它，但这是身份通道的第二个入口），并且会**投毒** R141 的限流桶。
    // `X-Trace-Id` 不在此列：它是链路追踪、不是身份 ⇒ 本层**不剥**它（也**不采信**客户端值：
    // 网关形态的 trace 中间件是第一个 `app.use`，自带值在那里就被无条件覆盖，R1106）。
    // 本层对它的唯一动作是**缺失时兜底生成**（见 `use()` 开头）。
    delete req.headers[USER_ID_HEADER];
    delete req.headers[TOKEN_JTI_HEADER];

    // 片⑦ D6①：管理面（`/api/admin/*`）**整段跳过玩家验签** —— 管理请求按定义没有玩家
    // Bearer（管理员不是玩家），也不该查玩家 session 白名单；管理令牌由紧随其后的
    // `AdminAuthMiddleware` 自证（app.module 的顺序即契约）。
    // 代理分润（2026-10-26）：`/api/agent/*` 同族 —— 代理令牌由 `AgentAuthMiddleware` 自证。
    // ⚠️ 跳过的**只有验签段**：上面的 `X-User-Id`/`X-Token-Jti` 剥离照常执行（身份通道纪律）。
    if (isPublicPath(path) || isAdminPath(path) || isAgentPath(path)) {
      next();
      return;
    }

    const authHeader = req.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new CodedUnauthorized(ErrCode.UNAUTHENTICATED, 'Missing or invalid Authorization header');
    }

    const payload = this.verify(authHeader.slice(7));

    // R24: 只有 access token 能通过网关（refresh token 也写进了白名单，
    // 不校验 typ 的话一张 7 天的令牌就能当 access 用）。
    if (payload.typ !== 'access' || !payload.jti) {
      throw new CodedUnauthorized(ErrCode.TOKEN_INVALID, 'token typ must be "access"');
    }

    // R26: 白名单查询是吊销生效的唯一途径。Redis 故障 → 503，**不得**静默放行。
    let active: boolean;
    try {
      active = await this.session.isActive(payload.jti);
    } catch {
      throw new ServiceUnavailableException({
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: 'session store unavailable',
        data: null,
      });
    }
    if (!active) {
      throw new CodedUnauthorized(ErrCode.TOKEN_EXPIRED, 'Token has been revoked or expired');
    }

    // Attach decoded payload to request for downstream use.
    (req as unknown as { user?: unknown }).user = { sub: payload.sub, phone: payload.phone };

    // §5.2: inject the internal identity headers. Values supplied by the client
    // are always overwritten — identity can only come from the verified token.
    req.headers[USER_ID_HEADER] = payload.sub;

    // R31: `X-Token-Jti` 只服务 `/api/auth/logout` —— 不进 §5.2 的通用身份契约，
    // 也绝不下发客户端。判定与 `headersOf()` 共用同一份 `isLogoutPath`。
    if (isLogoutPath(path)) {
      req.headers[TOKEN_JTI_HEADER] = payload.jti;
    }

    // ⚠️ 复核⑩ / 判据 12：网关是**边缘**，而 `userId` 进 ALS 的**唯一**入口就是这里 ——
    // 且**只在验签成功之后**：嵌套 `runWithTrace` 用**已验证的 `sub`** 覆盖余下处理
    // （外层 trace 中间件的上下文是 `userId: null` —— 复核⑩ 的另一半：客户端自带的
    // `X-User-Id` 在那一层就被拒之门外，这里再补上唯一可信的值）。
    // 这是「日志里的 userId 只能是验证过的身份」的**唯一**保证 —— 删掉这个嵌套 run，
    // 处理期间的日志会静默退回外层的 `null`（或更糟：外层的未验证值）。
    return runWithTrace(
      { traceId: String(req.headers[TRACE_ID_HEADER]), userId: payload.sub, source: 'edge' },
      next,
    );
  }

  private verify(token: string): AccessPayload {
    let payload: AccessPayload;
    try {
      payload = this.jwtService.verify(token) as AccessPayload;
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      if (name === 'TokenExpiredError') throw new CodedUnauthorized(ErrCode.TOKEN_EXPIRED, 'Token expired');
      throw new CodedUnauthorized(ErrCode.TOKEN_INVALID, 'Invalid or expired token');
    }
    if (!payload?.sub) {
      throw new CodedUnauthorized(ErrCode.TOKEN_INVALID, 'Invalid or expired token');
    }
    return payload;
  }

  private hasInternalToken(req: Request): boolean {
    const value = req.headers?.[INTERNAL_TOKEN_HEADER];
    if (typeof value === 'string') return value.length > 0;
    return Array.isArray(value) && value.length > 0;
  }
}

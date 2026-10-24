import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ErrCode, isAdminUsername } from '@fight-the-landlord/protocol';
import { httpException } from './errors';

/**
 * 网关注入的管理标记头名（网关 `identity-headers.ts` 是它的真源；各服务各定义一次是本仓
 * 既有惯例 —— 同 `INTERNAL_TOKEN_HEADER`，由网关测试与 conformance 在真拓扑上钉住不漂移）。
 */
export const ADMIN_HEADER = 'x-admin';

/**
 * 网关注入的操作者头名（③ T5 产、T6 消费；同 `ADMIN_HEADER` 的「各消费点各定义一次」惯例）。
 * 值 = 管理员**用户名**（网关注入前已验签 + claims 校验）。
 */
export const ADMIN_ACTOR_HEADER = 'x-admin-actor';

/** 读方法集合（同网关限流中间件的 READ_METHODS 口径）：其余方法一律按**写端点**处置。 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 写面身份缺失/非法 ⇒ 401 的文案（③ 系列逐字，currency-service 同款）。 */
const ACTOR_MISSING_MESSAGE = '管理身份缺失';

/**
 * guard 关心的请求面（Express request 的最小子集 + 本 guard 写入的 `adminActor`）。
 */
export interface AdminRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  /** 本 guard 校验后写入（仅写方法）；handler 经 `adminActorOf` 消费。 */
  adminActor?: string;
}

/**
 * 管理面 fail-closed 小守卫（货币片 T6 起 = 副本之一；**风控片 T6 扩展 actor 面**）。
 *
 * 语义逐字照 `config-service/src/config/admin.controller.ts`：`X-Admin: 1`（网关
 * `AdminAuthMiddleware` 验完管理令牌后**注入**、并剥离客户端伪造的同名头）；缺失 / 任何
 * 非 `'1'` 值 ⇒ **401**，且**不进 handler**。
 *
 * ─── 风控片 T6 扩展：写端点 actor（形态源 = currency-service 写面扩展版）──────────
 *  - **写端点**（method ∉ {GET, HEAD, OPTIONS}）必须带 `x-admin-actor` 且值通过
 *    `isAdminUsername`（protocol 单一真源，**缺省/非法 ⇒ 401 + 10002「管理身份缺失」**）；
 *    校验通过后写入 `req.adminActor` 供 handler 消费（`adminActorOf`）。审计写面**绝不
 *    回退**默认值——回退就是身份伪造面。
 *  - **读端点不强求该头**（无头/非法头都放行；也无 handler 消费它）：本服务现有读写两面
 *    = `AdminUsersController`（只读）+ `AdminRiskController`（读三 + 写一）。
 *  - 判定按 **HTTP 方法**（非路由名）：新增写端点自动落进写面，无需再改本文件。
 *
 * ⚠️ 与 config-service 复制件的**唯一差异**：本服务**没有**管理登录端点、也没有任何需要
 * 豁免的 admin 路由 ⇒ 这里**不带**豁免表（config-service 的表只豁免它自己的
 * `POST /api/admin/login`；把那张表抄过来会凭空发明一条豁免面）。
 * ⚠️ 本服务只信这两个头（`X-Admin:'1'` + 合法 actor）：令牌的验签是网关的职责；
 * user-service 的 `/api/admin/*` 不直接对玩家网络暴露（compose `expose` 而非 `ports`），
 * 且每跳还叠 `X-Internal-Token`（`internal-token.middleware.ts`）。
 */
@Injectable()
export class XAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AdminRequest>();

    const provided = req.headers[ADMIN_HEADER];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (value !== '1') throw httpException(ErrCode.UNAUTHENTICATED, 'admin header required');

    // 写端点 actor fail-closed（`req.method ?? ''` ⇒ 未知方法按写面处置——fail-closed 方向）。
    if (!READ_METHODS.has(req.method ?? '')) {
      const rawActor = req.headers[ADMIN_ACTOR_HEADER];
      const actor = Array.isArray(rawActor) ? rawActor[0] : rawActor;
      if (typeof actor !== 'string' || !isAdminUsername(actor)) {
        throw httpException(ErrCode.UNAUTHENTICATED, ACTOR_MISSING_MESSAGE);
      }
      req.adminActor = actor;
    }
    return true;
  }
}

/**
 * 写端点 handler 专用：取本 guard 已校验的 actor（缺席 = 不变量破坏——未挂 guard / 组装被改，
 * **响亮抛**而不是静默编一个值）。
 */
export function adminActorOf(req: AdminRequest): string {
  if (typeof req.adminActor !== 'string') {
    throw new Error('不变量破坏：写端点的 adminActor 应由 XAdminGuard 保证（guard 未挂/被绕过）');
  }
  return req.adminActor;
}

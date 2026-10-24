import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ErrCode, isAdminUsername } from '@fight-the-landlord/protocol';
import { httpException } from './errors';

/**
 * 网关注入的管理标记头名（网关 `identity-headers.ts` 是它的真源；各服务各定义一次是本仓
 * 既有惯例 —— 同 `INTERNAL_TOKEN_HEADER`，由网关测试与 conformance 在真拓扑上钉住不漂移）。
 */
export const ADMIN_HEADER = 'x-admin';

/**
 * 网关注入的操作者头名（③ T5 产、T6 起消费；同 `ADMIN_HEADER` 的「各消费点各定义一次」惯例）。
 * 值 = 管理员**用户名**（网关注入前已验签 + claims 校验）。
 */
export const ADMIN_ACTOR_HEADER = 'x-admin-actor';

/** 读方法集合（同网关限流中间件的 READ_METHODS 口径）：其余方法一律按**写端点**处置。 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 写面身份缺失/非法 ⇒ 401 的文案（③ 规格 §2.14 逐字）。 */
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
 * 管理面 fail-closed 小守卫（支付片 T12 的复制件 —— 照 `currency-service/src/http/x-admin.guard.ts`
 * 逐句同形，后者又是 config-service 的照抄件；「各服务各一份」是本仓既有惯例）。
 *
 * 语义：`X-Admin: 1`（网关 `AdminAuthMiddleware` 验完管理令牌后**注入**、并剥离客户端伪造的
 * 同名头）；缺失 / 任何非 `'1'` 值 ⇒ **401**，且**不进 handler**。
 *
 * ─── 写端点 actor（规格 §2.4.2 末行：actor 取网关注入 `x-admin-actor`）────────────────
 *  - **写端点**（method ∉ {GET, HEAD, OPTIONS}）必须带 `x-admin-actor` 且值通过
 *    `isAdminUsername`（protocol 单一真源，**缺省/非法 ⇒ 401 + 10002「管理身份缺失」**）；
 *    校验通过后写入 `req.adminActor` 供 handler 消费（`adminActorOf`）。写面**绝不
 *    回退** `'admin'` 字面量——回退就是身份伪造面（③ 设计 §4.2）——reviewed_by/
 *    confirmed_by 的留痕必须指到一个真实存在的管理身份。
 *  - **读端点不强求该头**（无头/非法头都放行；也无 handler 消费它）。
 *  - 判定按 **HTTP 方法**（非路由名）：review/confirm 三条（均 POST）自动落进写面，
 *    无需逐路由登记。
 *
 * ⚠️ 与 config-service 复制件的**唯一差异**：本服务**没有**管理登录端点、也没有任何需要
 * 豁免的 admin 路由 ⇒ 这里**不带**豁免表（把那张表抄过来会凭空发明一条豁免面）。
 * ⚠️ 本服务只信这两个头（`X-Admin:'1'` + 合法 actor）：令牌的验签是网关的职责；
 * payment-service 的 `/api/admin/*` 不直接对玩家网络暴露，且每跳还叠 `X-Internal-Token`
 * （`internal-token.middleware.ts`）。
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

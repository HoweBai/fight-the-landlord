/**
 * 与 `packages/protocol/src/errors.ts` 的 `ErrCode.UNAUTHENTICATED` 相同（R93）。
 *
 * robot-service **没有** protocol 的直接依赖（`packages/shared` 也**不** re-export
 * `ErrCode`），加依赖会动根 `pnpm-lock.yaml`（协调者独占的根配置），故本地声明；
 * 漂移由 conformance 的 `slice-07.2-boundary` 在集成层兜住
 * （断言 401 body 的 `code === 10002`）。
 */
const UNAUTHENTICATED = 10002;

/**
 * 中间件的**最小** Express 形状（不 import `express`）。
 *
 * 各服务的隔离 `node_modules` 里并不都有 `@types/express`（pnpm 不提升），
 * 而中间件只用到 `path` / `headers` / `status().json()` 这几样。用本地结构类型
 * 描述它，既让 `tsc --noEmit` 在任何服务里都通过，也让这份实现可以在各服务里
 * **逐字相同**（R23：不新建 workspace 包、不把 Nest 代码塞进 `shared`/`protocol`）。
 */
export interface InternalTokenRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface InternalTokenResponse {
  status(code: number): InternalTokenResponse;
  json(body: unknown): unknown;
}

export type InternalTokenMiddleware = (
  req: InternalTokenRequest,
  res: InternalTokenResponse,
  next: () => void,
) => void;

/**
 * 与 `api-gateway/src/auth/identity-headers.ts` 的 `INTERNAL_TOKEN_HEADER` 同名
 * （§5.2 规则 3）。同一份名字在两侧各定义一次是本仓既有惯例
 * （`game.controller.ts` 亦如此），由 conformance 在真实拓扑上钉住它没有漂移。
 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * 容器 healthcheck 直连本路径（`docker-compose.yml`）⇒ **必须**豁免，否则全线 unhealthy（R87②）。
 *
 * ⚠️ `/api/health/live` 是 §2.4/R267 的**存活面**（不查任何依赖、恒 200）：编排层的
 * 存活探针**不带内部 token**（也不该带）⇒ 必须与就绪面一起豁免。
 * ⚠️ 匹配是**精确**的（`exemptPaths.includes(req.path)`）⇒ `/api/health/live` 必须
 * **单独列出**；`/api/health/livex`、`/api/healthz` 仍然要 401（判据里有负对照）。
 * 豁免面**仍然只有健康检查**：**不得**为业务路由开任何例外（fail-safe 而非 fail-open）。
 */
export const DEFAULT_EXEMPT_PATHS = ['/api/health', '/api/health/live'] as const;

/**
 * §5.2 规则 3：**服务间调用才携带 `X-Internal-Token`**。
 *
 * 网关在**每一跳**下游注入它（N7）；外部客户端即使自带也会被网关边缘拒掉
 * （`jwt.middleware.ts` 的 `hasInternalToken()`）。因此本中间件把
 * 「直连 3005 + 伪造 `X-User-Id` = 冒充服务创建/移动机器人」这条路直接关死（N4/N7）。
 *
 * ⚠️ 本服务同时是「30 秒补机器人」链路的下游：room-service 的 `acquireBot`
 * 一旦漏带该头（R90），这里会 401 —— 这正是 `slice-07` 第 7 组要覆盖的端到端回归。
 *
 * 语义：
 *  - 缺失 / 不匹配 → `10002 UNAUTHENTICATED`（HTTP 401，§11.1 信封）。
 *    不用 `10005`（那是**用户 JWT** 的语义），也不用 `10003`（对端不是
 *    「已认证但无权限」，而是**根本没认证**）——R88；
 *  - `/api/health` 豁免（R87②）。**不得**为业务路由开任何例外：
 *    那等于门又开了（fail-safe 而非 fail-open）；
 *  - R89（fail closed）：未配置 `INTERNAL_SERVICE_TOKEN` 时**不得放行**。
 *    启动期由 `main.ts` 直接 `process.exit(1)`；这里再兜一层 ——
 *    `expected` 为空时**一切**业务路由都拒（不是「没配就跳过校验」）。
 */
export function createInternalTokenMiddleware(
  exemptPaths: readonly string[] = DEFAULT_EXEMPT_PATHS,
): InternalTokenMiddleware {
  const expected = process.env.INTERNAL_SERVICE_TOKEN;

  return (req, res, next) => {
    if (exemptPaths.includes(req.path)) return next();

    const provided = req.headers[INTERNAL_TOKEN_HEADER];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!expected || value !== expected) {
      res.status(401).json({ code: UNAUTHENTICATED, message: 'Internal token required', data: null });
      return;
    }
    return next();
  };
}

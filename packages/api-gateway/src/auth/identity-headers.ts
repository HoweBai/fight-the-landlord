/**
 * Internal identity headers (docs/design.md §5.2).
 *
 * ⚠️ Minor（Task 6）：`USER_ID_HEADER` / `TRACE_ID_HEADER` 的**字面量真源只有一处** ——
 * `@fight-the-landlord/shared`（`logging/trace-middleware.ts`），这里**再导出**而不是各写一份：
 * 两份相同字面量改一处漏一处，没有任何闸看得见。shared **不** import 网关 ⇒ 从 shared 取它们
 * **不会**引入环（下面「防循环依赖」的理由只约束**其余**成员）。
 *
 * 其余成员留在本模块的理由不变：`JwtMiddleware`（注入侧）与
 * `ApiGatewayController`/`ProxyGateway`（转发侧）都要 import 它们，而两两直连会形成
 * import cycle —— 环会让 bundler 丢掉一侧的运行时类导入，Nest 的构造注入随之**静默**失效
 * （正是那种能藏几个月的故障）。
 */
export { TRACE_ID_HEADER, USER_ID_HEADER } from '@fight-the-landlord/shared';
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * 仅 `/api/auth/logout` 使用（R31）：网关把验签得到的 access token `jti` 传给
 * user-service，让它能删掉这张 access token 的白名单项。
 *
 * ⚠️ 它**不属于** §5.2 的通用身份契约，也**绝不下发**客户端 —— 只有
 * `/api/auth/logout` 这一条路径会注入并转发。
 */
export const TOKEN_JTI_HEADER = 'x-token-jti';

/**
 * P0-3：提现再认证链的两枚**客户端**头（不是网关注入的验真产物）。
 *
 *  - `AUTHORIZATION`：仅 `/api/auth/reauth` 转发给 user-service —— 该端点由
 *    `JwtAuthGuard`（Bearer 提取）鉴权。⛔ 不得扩散成全局透传：其它路径已经由
 *    `JwtMiddleware` 验签并注入 `X-User-Id`，Authorization 在那些跳上没有消费方。
 *  - `X-REAUTH-TICKET`：仅 `POST /api/pay/withdrawals` 转发给 payment-service ——
 *    一次性再认证票据（5 分钟，DEL 原子消费）。⛔ 不得扩散到其它支付路径。
 *
 * 判定与转发都在 `headersOf()`（唯一产出点），`forward()` 只做字段→头名的映射。
 */
export const AUTHORIZATION_HEADER = 'authorization';
export const REAUTH_TICKET_HEADER = 'x-reauth-ticket';

/** `X-Reauth-Ticket` 的唯一合法消费路径：`POST /api/pay/withdrawals`（exact match）。 */
export function isWithdrawApplyPath(path: string): boolean {
  return path === '/api/pay/withdrawals' || path === '/pay/withdrawals';
}

/** `Authorization` 的唯一合法转发路径：`POST /api/auth/reauth`（exact match）。 */
export function isReauthPath(path: string): boolean {
  return path === '/api/auth/reauth' || path === '/auth/reauth';
}

/**
 * 片⑦ D6②：管理标记头（`config-service` 的 `XAdminGuard` 逐字信任「存在且恰好 `'1'`」）。
 *
 * `AdminAuthMiddleware` 在**验完管理令牌之后**注入、并在验签**之前剥掉**客户端伪造值
 * （与 `USER_ID_HEADER` 同族纪律：身份头只可能来自验证结果）；片⑦ T10 起 `headersOf()`
 * 把它转发给下游。⚠️ 下游 `admin.controller.ts` 里有一份同名二次定义，是本仓既有惯例
 * （同 `INTERNAL_TOKEN_HEADER`），由网关测试与真拓扑判据钉住不漂移。
 */
export const ADMIN_HEADER = 'x-admin';

/**
 * ③ T5（规格 §2.10）：管理身份两枚 —— `AdminAuthMiddleware` 在**验签 + claims 校验 +
 * policy 通过之后**注入（`x-admin-actor` = claims 的 `username`、`x-admin-roles` = claims 的
 * `role`），与 `ADMIN_HEADER` 同一条纪律：客户端伪造值在验签**之前**就被剥掉，下游只可能
 * 看到注入的那份。
 *
 * ⚠️ 下游 `config-service` 里有一份 `ADMIN_ACTOR_HEADER` 二次定义（`'x-admin-actor'`，
 * 本仓既有惯例，同 `ADMIN_HEADER` 的两处同名定义）—— 由网关测试与真拓扑判据钉住不漂移。
 * `x-admin-roles` 的值是**单数角色串**（头名带 s 是规格字面）。
 */
export const ADMIN_ACTOR_HEADER = 'x-admin-actor';
export const ADMIN_ROLE_HEADER = 'x-admin-roles';

/**
 * 代理门户身份（2026-10-26）：`AgentAuthMiddleware` 验完代理令牌后注入；
 * 与 `X-Admin` 同一条纪律 —— 客户端伪造值在验签**之前**剥掉。
 * `x-agent-ver` = JWT 的 `ver`（currency-service 的 AgentGuard 与 DB token_version 比对）。
 */
export const AGENT_ID_HEADER = 'x-agent-id';
export const AGENT_VER_HEADER = 'x-agent-ver';

/**
 * ③ T5（规格 §2.10「登录路径 clientIp 注入」）：客户端 IP 头 —— **仅** `/api/admin/login`
 * 路径由 `headersOf()` 产出（值由网关从 socket/`req.ip` + 可信表**派生**，不读客户端值；
 * 登录事件落 `ip` 列用它）。R31 的 `X-Token-Jti` 纪律复刻：只服务一条路径，不得扩散成
 * 第二条身份通道。
 *
 * ⚠️ 客户端伪造值由 `AdminAuthMiddleware` 与另外三枚一起**先剥**（所有路径）——
 * 即便 `headersOf` 忘了路径判定，读到的也只能是网关自己写入/派生不了的值。
 */
export const CLIENT_IP_HEADER = 'x-client-ip';

/**
 * R31 的唯一判定：`X-Token-Jti` 只服务 `/api/auth/logout`。
 *
 * 中间件（注入侧）与 `GatewayController.headersOf()`（转发侧）必须用**同一份**
 * 判定，否则「注入但不转发」或「任意路径都转发」都会悄悄破坏 R31 —— 所以放在这里共用。
 * 全局前缀 `/api` 是否被剥掉都要认（`req.originalUrl` 与 `req.url` 不同）。
 */
export function isLogoutPath(path: string): boolean {
  return path === '/api/auth/logout' || path === '/auth/logout';
}

/** Header values the gateway forwards to downstream services. */
export interface DownstreamHeaders {
  userId?: string;
  traceId?: string;
  /** 仅 logout 路径携带（见 `TOKEN_JTI_HEADER`）。 */
  tokenJti?: string;
  /**
   * P0-3：仅 `/api/auth/reauth` 路径携带（客户端 Bearer，供 user-service
   * `JwtAuthGuard` 提取）。`forward()` 映射回 `Authorization`。
   */
  authorization?: string;
  /**
   * P0-3：仅 `POST /api/pay/withdrawals` 携带（一次性再认证票据）。
   * `forward()` 映射回 `X-Reauth-Ticket`。
   */
  reauthTicket?: string;
  /**
   * §5.2 规则 3：网关**每一跳**都注入（N7）。
   *
   * 这是「直连 3001–3005 + 伪造 `X-User-Id`」唯一的关闭手段：下游据此区分
   * 「来自网关」与「直连伪造」。客户端**无法**伪造它 —— `JwtMiddleware`
   * 在边缘就把自带该头的外部请求拒了（`hasInternalToken()`）。
   */
  internalToken?: string;
  /**
   * 片⑦ T10（D6）：管理标记 —— `headersOf()` 从**验真产物**（`AdminAuthMiddleware`
   * 验签后注入的 `X-Admin: 1`）转出的布尔，`forward()` 映射回 `X-Admin: 1` 头。
   *
   * 单独一个布尔字段而不是直接透传字符串：**只有恰好 `'1'` 才转**（与下游
   * `XAdminGuard` 的「存在且恰好 `'1'`」逐字同形 —— 两处放宽任一处就是洞）。
   */
  admin?: boolean;
  /**
   * ③ T5（§2.10 第 7 步）：管理身份两枚 —— 与 `admin` 同源（`AdminAuthMiddleware` 在
   * 验签 + claims 校验 + policy **通过之后**才注入），`forward()` 映射回
   * `X-Admin-Actor` / `X-Admin-Roles` 同名头。
   *
   * ⚠️ 写端点（config PUT、wallet adjust/reverse）依赖 actor 头做留痕：
   * 缺失/非法时下游 401 fail-closed（绝不回退 `'admin'`）。
   */
  adminActor?: string;
  adminRole?: string;
  /** 代理门户（2026-10-26）：仅 `/api/agent/*`（非 login）由 `headersOf()` 产出。 */
  agentId?: string;
  agentVer?: string;
  /**
   * ③ T5：客户端 IP —— **仅** `/api/admin/login` 路径产出（`isAdminLoginPath` 判定，
   * 见 `CLIENT_IP_HEADER` 的纪律说明）；`forward()` 映射回 `X-Client-Ip`。
   */
  clientIp?: string;
}

/**
 * §7.1 的**公开路径白名单** —— 网关侧「免鉴权」（`JwtMiddleware`）与限流侧
 * 「健康端点豁免」（`HttpRateLimitMiddleware`，R462）的**唯一真源**。
 *
 * ⚠️ **为什么单独一个模块**（与 `identity-headers.ts` 逐字同一条理由）：两份清单被两个
 * 中间件同时消费，放在任一方都会让另一方 import 一个中间件（制造 import 环，并把 Nest 的
 * 装配拖进来）。本模块**零 import** ⇒ 结构上不可能有环，也不可能因为装配顺序而变化。
 *
 * ⚠️ **不得**在任何消费方再抄一份字面量清单：两份清单漂移的症状是
 * 「某条路径免鉴权但不被限流豁免」或反之 —— 只有真实流量才看得见（R462 就是这么红的）。
 */

/**
 * §7.1 的公开**认证入口**。
 *
 * 它们未认证即可访问，且**必须**继续被 §5.4 第五维（单 IP HTTP，R453）覆盖：
 * N13 登记的缺口逐字就是「**登录/注册/刷新**无 IP 维度限流（暴力破解面）」，
 * 而这三条路径**永远没有**已认证的 `x-user-id`。
 */
export const AUTH_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
] as const;

/**
 * §2.4 的**健康端点**（R267/R285 的就绪/存活分离）。限流维度**必须豁免**它们（R462）：
 *
 *  - `/api/health/live` 是**存活**面：**不查任何依赖**、恒 **200**、响应体不含 `checks`。
 *    它一旦因为「Redis 抖动」被限流中间件改写成 `{code:10007,…}`，编排层就会把一个
 *    **完全健康的进程**判死并重启 —— 这正是 R267 要把存活面单独拆出来的理由。
 *  - `/api/health` 是**就绪**面：它**自己**按 `status` 返 `200`/`503`，响应体是
 *    `{status, service, checks}`；限流中间件抢先返回 503 会破坏这个形状
 *    （compose 的 healthcheck 读的就是它）。
 *
 * R462 的门禁实测（协调者）：一次性容器 + 无监听的 `REDIS_URL` 请求 `GET /api/health/live`
 * ⇒ 30s 内拿不到存活面，`slice-07.2-deploy` 红。
 */
export const HEALTH_PATHS = ['/api/health', '/api/health/live'] as const;

/**
 * §7.1 的白名单本身 = 上面两组**按语义组合**，**恰好五条**（R267 补第 5 条 `…/live`）。
 *
 *  - **精确匹配**，不得用前缀：前缀会让 `/api/auth/login-as-admin`、`/api/healthz`
 *    这类路径静默变公开（负对照见 `jwt.middleware.test.ts`）；
 *  - **绝不含有 `'/'`**：任何路径都以 `/` 开头 ⇒ `'/'` 会让整条鉴权恒真（A.2 的 S1）；
 *  - `design.md` §7.1 的表格原文写「仅四条」，第 5 条是 R267 的存活面（协调者收口）。
 */
export const PUBLIC_PATHS: readonly string[] = [...AUTH_PATHS, ...HEALTH_PATHS];

/**
 * 请求路径的**唯一**派生口径：`JwtMiddleware`（免鉴权）与 `HttpRateLimitMiddleware`
 * （健康端点豁免）共用。
 *
 * ⚠️ 两处各推一次就会漂移，而漂移的症状是「同一条路径在一处是公开的、在另一处不是」——
 * 只在真实流量下可见（那正是 R462 的形态）。
 *
 * `originalUrl` 优先：Nest 的全局前缀（`api`）会被从 `req.url` 剥掉，而白名单/豁免清单
 * 都是**带前缀**的完整路径；查询串必须切掉（`?` 之后不参与匹配）。
 */
export function requestPath(req: { originalUrl?: string; url?: string }): string {
  const rawUrl: string = req.originalUrl ?? req.url ?? '/';
  return rawUrl.split('?')[0] ?? '/';
}

/** §7.1：是否公开路径（⇒ 免鉴权）。 */
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.includes(path);
}

/** §2.4 / R462：是否健康端点（⇒ 限流维度豁免：存活面不查依赖）。 */
export function isHealthPath(path: string): boolean {
  // 用 `some(===)` 而不是 `HEALTH_PATHS.includes(path)`：`as const` 让 `HEALTH_PATHS` 的
  // 元素类型是**字面量联合**，`Array.includes` 的参数也随之收窄成那个联合 —— 传 `string`
  // 会 `TS2345`（`isPublicPath` 没这个问题，因为 `PUBLIC_PATHS` 显式标注成了 `readonly string[]`）。
  return HEALTH_PATHS.some((healthPath) => healthPath === path);
}

/**
 * 片⑦ D6①：管理面**前缀**（`/api/admin`）—— `JwtMiddleware` 对 `isAdminPath()` 为真的路径
 * **整段跳过玩家验签**的挂点。
 *
 * ⚠️ **与 `PUBLIC_PATHS` 分列**（语义不同，**绝不并入**）：那边是「**无需**凭据」（免鉴权面）；
 * 这里是「**不适用**玩家凭据」—— 管理面有自己的一套凭据（管理令牌 + `X-Admin`，由紧随
 * `JwtMiddleware` 之后的 `AdminAuthMiddleware` 强制）。并入 `PUBLIC_PATHS` 的后果：
 * ① `isPublicPath` 的全部消费方把 `/api/admin` 当免鉴权面（限流健康豁免语义一并污染）；
 * ② 「这里还有第二道闸」的契约在消费方不可见。
 *
 * ⚠️ 为什么这里的**前缀**语义是安全的（`PUBLIC_PATHS` 的纪律恰是「精确匹配」——所以必须写清
 * 区别）：前缀覆盖 = 管理面子树，而它**不跳过任何凭据** —— `isAdminPath` 为真只意味着
 * 「玩家验签段不适用」；`AdminAuthMiddleware` 对其中**除 login 外的每一条**都要求有效管理令牌
 * （缺 ⇒ 401、坏 ⇒ 401），login 是入口本身（豁免恰好一条，网关与 config-service 两侧**各自**
 * 强制 —— 下游是 `XAdminGuard`/`ADMIN_EXEMPT_ROUTES` 的同一份语义）。用**前缀**而不是逐条
 * 枚举的理由：管理面今后加路由（新的管理端点）**不得**因为忘了改清单而静默落回玩家验签
 * （症状 = 新端点全 401 而登录一切正常 —— 正是 D6① 要防的形态）。
 * 边界必须是 `${ADMIN_PREFIX}/` 而不是裸 `startsWith(ADMIN_PREFIX)`：否则 `/api/adminx`、
 * `/api/administrator` 会被静默吞进管理面（负对照在 `jwt.middleware.test.ts`）。
 */
export const ADMIN_PREFIX = '/api/admin';

/**
 * 是否管理面路径（**前缀**语义：前缀根本身 + 其下全部子树）。
 *
 * ⚙️20（终审 F1，Critical 真栈实证）：识别**大小写不敏感** —— Express/Nest 路由匹配
 * 大小写不敏感（`/API/admin/*` 命中同一路由），而本判定原为大小写敏感比较 ⇒ 持任意
 * **玩家令牌**打 `POST /API/admin/login`（混合大小写）：`isAdminPath` 为假 ⇒ 被当玩家路径
 * （玩家验签满足）、`AdminAuthMiddleware` 跳过、登录失败桶不命中 ⇒ 请求直通 config-service
 * 的**豁免登录路由**（下游唯一无 `XAdminGuard` 处）—— 口令比较真实执行而失败桶不计数，
 * scrypt 的唯一防爆破/内存控制被旁路。修复 = 归一上收于**本层**（消费方三处随之统一）：
 * `JwtMiddleware`（跳过玩家验签）· `AdminAuthMiddleware`（管辖范围）· `HttpRateLimitMiddleware`
 * （admin 分支）。大小写变体因此落「admin 路径但非豁免」⇒ 无有效管理令牌一律 401 fail-closed。
 *
 * ⚠️ **射程边界**：豁免判定（`isAdminLoginPath`）与尾斜杠归一（`normalizeAdminPath` 的
 * 消费点）**保持原值精确**语义不变（⚙️20 逐字；N1 不回退）—— 大小写变体的归一只影响
 * 「该请求是否归管理面管辖」，不影响「哪条路径被豁免」。
 *
 * 消费方：`JwtMiddleware`（整段跳过玩家验签；片⑦ T9）· `AdminAuthMiddleware`（管辖范围）·
 * `HttpRateLimitMiddleware`（admin 分支；片⑦ T10）。
 */
export function isAdminPath(path: string): boolean {
  // 只影响 ASCII 判定面：`ADMIN_PREFIX` 是纯小写字面量，`toLowerCase` 不引入其它归一。
  const lower = path.toLowerCase();
  return lower === ADMIN_PREFIX || lower.startsWith(`${ADMIN_PREFIX}/`);
}

/**
 * ③ T5（规格 §2.10 第 3 步 + 「登录路径 clientIp 注入」）：管理登录**入口**路径 ——
 * 豁免的**唯一**一条。
 *
 * **精确匹配、用原值**（三个"用原值"都是 N1/⚙️20 的契约面）：
 *  - `POST /api/admin/login/`（尾斜杠）**不**被豁免 ⇒ 走 Bearer 要求 ⇒ 401 fail-closed
 *    （⚙️17 的路径归一**射程只到 policy 匹配**，不得到达这里）；
 *  - **大小写变体（⚙️20）**：本判定保持**大小写敏感原值** —— 变体被 `isAdminPath` 认作
 *    admin 路径（该判定已大小写不敏感）但**不落豁免** ⇒ 无有效管理令牌 401 fail-closed /
 *    带有效管理令牌的 POST ⇒ P9 403，同样不达登录处理器；
 *  - 近邻路径（`/api/admin/loginx`、`/api/admin/login/step`）同样不认（既有判据保留）。
 *
 * 消费方（必须是**同一份**判定，否则「豁免与 clientIp 产出」会漂移）：
 * `AdminAuthMiddleware`（豁免）· `HttpRateLimitMiddleware`（登录失败桶）·
 * `GatewayController.headersOf()`（`clientIp` 仅此路径产出）。
 */
export function isAdminLoginPath(path: string): boolean {
  return path === `${ADMIN_PREFIX}/login`;
}

/**
 * 客户端接入片 T5：客户端配置拉取面（`GET /api/config`；路由在 `gateway.controller.ts`
 * 的 `@Get('config')`）—— `ClientGateMiddleware` 的**第三条豁免**（H5 被禁时页面须照常
 * 初始化，登录尝试时才给清晰文案）。与 `HEALTH_PATHS` 同族：
 *
 *  - **精确匹配**（负对照形态同 `isHealthPath`：`/api/configx`、`/api/config/xxx` 一律
 *    **不**豁免 —— 前缀匹配会让近邻路径静默豁免）；
 *  - ⛔ 消费方（`ClientGateMiddleware`）不得再抄字面量 —— 就地另抄一份正是 R462 的漂移面
 *    （「一条路径在一处豁免、在另一处不豁免」只在真实流量下可见）。
 */
export const CLIENT_CONFIG_PATHS = ['/api/config'] as const;

/** 是否客户端配置拉取面（⇒ 端闸豁免）。与 `isHealthPath` **逐字同形**（`some(===)`，见其注记）。 */
export function isClientConfigPath(path: string): boolean {
  return CLIENT_CONFIG_PATHS.some((clientConfigPath) => clientConfigPath === path);
}

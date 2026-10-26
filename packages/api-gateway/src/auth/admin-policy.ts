/**
 * ③ T5（规格 §2.10 第 6 步）+ 风控 T7（规格 §2.9-3）+ 支付 T12（规格 §0.3-⚙️10）
 * + 支付配置管理化 T7（规格 §4 / ⚙️10「E′」）
 * + 通知通道管理化 T8（规格 §4）
 * + 广告片 T8（规格 §2.3）：
 * 管理面 policy —— **显式枚举、按序首个命中**（P1–P9 + 风控五条 P-r1..P-r5 +
 * 支付七条 P-p1..P-p7 + 支付配置管理化两条 P-c1..P-c2 + 通知通道管理化两条 P-n1..P-n2
 * + 广告回调密钥两条 P-a1..P-a2）。
 *
 * 为什么单独一个模块：`AdminAuthMiddleware`（执行）与单测（钉矩阵）共用**同一份**规则表；
 * 把规则散在中间件的 if 里会让「四角色 × 每写端点」的矩阵没有单一真源。
 *
 * ⚠️ 三条纪律（N1/S1 教训）：
 *  1. **不做通配**：`/api/admin/accounts*` 这类前缀通配会把 `/api/admin/accounts/changes`
 *     （P8 读面）吞进 P1（超管限定）或反之 —— 规则逐条显式写，路径要么精确、要么是规格
 *     点名的前缀（P3/P4）；
 *  2. **输入是归一后路径**（`normalizeAdminPath`，⚙️17）：`GET /api/admin/accounts/` 若不先
 *     归一，P1 精确匹配失败 ⇒ 落 P8「任意角色」= 本片唯一越权路径（真栈实证 S1）；
 *  3. **首个命中即终局**：命中 P1–P7 但角色不足 ⇒ `false`（⇒ 403 fail-closed），
 *     **不得**继续落到 P8 —— 「先 deny 再看下一条」会让 `GET /api/admin/accounts`（P1）
 *     的拒绝路径被 P8（GET 任意角色）重新放行。
 */

/**
 * 四角色白名单（与 config-service `admin-accounts.service.ts` 的 `ADMIN_ROLES` **同形各表一份**：
 * 跨服务不共享代码是本仓既有惯例 —— 同 `aud` 字面量两侧各写一份，由端到端判据钉住不漂移）。
 *
 * claims 校验（第 5 步）与 P 表共用它：`role` 不在四值内 ⇒ 401 `10005`（先于 policy）。
 */
export const ADMIN_ROLES = ['super_admin', 'finance', 'operator', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * ⚙️17（规格 §2.10 第 0 步）：剥**全部**尾斜杠得 `normPath`。
 *
 * ⚠️ **射程 = 仅 policy 匹配**：豁免判定（第 3 步）与 `isAdminPath`（第 2 步）、限流登录桶
 * 都用**原值** —— `POST /api/admin/login/`（尾斜杠）不落豁免 ⇒ 走 Bearer 要求 ⇒
 * 401 fail-closed（N1：若归一射程含豁免，尾斜杠登录变体将直达登录处理器而失败桶不计数，
 * scrypt 的唯一防爆破控制被旁路）。
 *
 * 只剥**尾部**：中间斜杠一律不动（`/api/admin/config/room.x/` ⇒ `/api/admin/config/room.x`）。
 * `String.replace(/\/+$/, '')` 对无尾斜杠输入是恒等 ⇒ 调用点不需要判分支。
 */
export function normalizeAdminPath(path: string): string {
  return path.replace(/\/+$/, '');
}

/** P3/P4 的前缀面（注意：**带尾斜杠**——裸 `/api/admin/accounts` 不属于 `:id` 前缀面）。 */
const ACCOUNTS_SUBPATH_PREFIX = '/api/admin/accounts/';
const CONFIG_KEY_PREFIX = '/api/admin/config/';

/** P4 的排除面：`…/changes` 是审计读口，**不得**被当成"名为 changes 的配置键"得到写允许。 */
const CONFIG_CHANGES_SUFFIX = '/changes';

/** P3 的排除面：`.csv` 变体显式排除（规格逐字；排除后落 P9 ⇒ 403 fail-closed）。 */
const CSV_SUFFIX = '.csv';

/** P-r2 的前缀面（注意：**带尾斜杠**——裸 `/api/admin/risk/users` 不属于 `:userId` 前缀面）。 */
const RISK_USERS_SUBPATH_PREFIX = '/api/admin/risk/users/';

/**
 * P-r5 的固定后缀（设备绑定片：人工解绑 DELETE `/api/admin/risk/users/:userId/device-binding`）。
 * 与 P-p5..p7 的动作后缀同族：必须「前缀 + 固定后缀 + 非空单号段」三者齐才命中 ——
 * `/api/admin/risk/users/device-binding`（无 userId 段）不中 ⇒ 落 P9 ⇒ 403。
 */
const DEVICE_BINDING_SUFFIX = '/device-binding';

/** P-p 前缀面（支付片 T12；带尾斜杠——`/api/admin/pay/orders/:orderNo` 等详情面）。 */
const PAY_ORDERS_SUBPATH_PREFIX = '/api/admin/pay/orders/';
const PAY_REFUNDS_SUBPATH_PREFIX = '/api/admin/pay/refunds/';
const PAY_WITHDRAWALS_SUBPATH_PREFIX = '/api/admin/pay/withdrawals/';

/**
 * P-c 前缀面（支付配置管理化 T7；**带尾斜杠**——裸 `/api/admin/pay-channel` 不属于
 * `:key` 前缀面，同 P3/P4/P-r2/P-p 的「不做通配」纪律）。
 */
const PAY_CHANNEL_SUBPATH_PREFIX = '/api/admin/pay-channel/';

/**
 * P-n 前缀面（通知通道管理化 T8；**带尾斜杠**——裸 `/api/admin/notify-channel` 不属于
 * `:key` 前缀面，同 P3/P4/P-r2/P-p/P-c 的「不做通配」纪律）。
 */
const NOTIFY_CHANNEL_SUBPATH_PREFIX = '/api/admin/notify-channel/';

/**
 * P-a 前缀面（广告片 T8；**带尾斜杠**——裸 `/api/admin/ad-channel` 不属于 `:key` 前缀面，
 * 同 P3/P4/P-r2/P-p/P-c/P-n 的「不做通配」纪律）。
 */
const AD_CHANNEL_SUBPATH_PREFIX = '/api/admin/ad-channel/';

/**
 * P-p5..P-p7 的动作子路径面（支付片 T12）：前缀 + 固定后缀 + **单号段非空**
 * （`length > prefix + suffix` —— `/api/admin/pay/withdrawals/confirm` 这类「无单号」路径
 * **不中**；Express 的 `:param` 本就不匹配空段 ⇒ policy 与路由面对齐，不发明第二条通配面）。
 */
function isPayActionPath(p: string, prefix: string, suffix: string): boolean {
  return p.startsWith(prefix) && p.endsWith(suffix) && p.length > prefix.length + suffix.length;
}

/**
 * 授权判定（规格 §2.10 第 6 步的 P 表逐条转代码；**按序首个命中**）。
 *
 * @param opts.method  HTTP 方法（Express 的原值，大写规范形）
 * @param opts.normPath 已归一路径（`normalizeAdminPath` 的产物）——本函数**不再**归一
 * @param opts.role    已验证的 claims 角色（第 5 步保证 ∈ `ADMIN_ROLES`）
 * @returns `true` = 放行；`false` = 403 `10003`（命中但角色不足，或未登记写路径 P9）
 */
export function authorizeAdmin(opts: { method: string; normPath: string; role: string }): boolean {
  const { method, normPath, role } = opts;
  /** 角色是否在允许集内（`as` 只为让 `includes` 接受 string；判定值仍是字面量联合）。 */
  const allows = (...roles: readonly AdminRole[]): boolean =>
    (roles as readonly string[]).includes(role);

  /**
   * 波 3 F1（🔴）：**匹配用小写折叠**（`p`）—— Express/Nest 路由**大小写不敏感**
   *（`/API/admin/…` 与 `/api/admin/…` 命中同一处理器），而本表字面量全小写；不折叠 ⇒
   * 混大小写路径的精确/前缀匹配全部失败 ⇒ **落 P8「任意 GET」放行**（viewer 越权读
   * P1/P3 面与 P-r1..r3 面；下游无第二层角色守卫）。同族覆盖既存 P1–P7 —— 包括
   * **③ 片遗留洞**（`GET /API/admin/Accounts` viewer ⇒ true）。
   *
   * ⚠️ 折叠**仅匹配用**：`normalizeAdminPath` 本体不动（⚙️17 射程不变 —— 豁免/
   * `isAdminPath`/限流桶仍用原值）；也**不影响任何转发**（控制器只把 policy 的结果
   * 当放行/拒绝，`:key`/`:id` 等路径参数按 Express 解出的**原值**编码转发，不失真）。
   * 方法与其余比较逐字不变（方法面不做折叠）。
   */
  const p = normPath.toLowerCase();

  // P1：GET /api/admin/accounts（**精确**）⇒ super_admin
  if (method === 'GET' && p === '/api/admin/accounts') return allows('super_admin');

  // P2：POST /api/admin/accounts（**精确**）⇒ super_admin
  if (method === 'POST' && p === '/api/admin/accounts') return allows('super_admin');

  // P3：PATCH /api/admin/accounts/:id（**前缀** `/api/admin/accounts/`，排除 `.csv`）⇒ super_admin
  if (method === 'PATCH' && p.startsWith(ACCOUNTS_SUBPATH_PREFIX) && !p.endsWith(CSV_SUFFIX)) {
    return allows('super_admin');
  }

  // P-ag0（2026-10-26）：`PUT /api/admin/config/` 下的 **agent.* / 含 `%` 的编码变体** ⇒ super_admin。
  // 必须**先于 P4**：P4 是「任意 config 键 ⇒ super_admin|operator」的前缀匹配；
  // `agent%2EinviteEnabled` 经 P4 放行 operator，而 Express 的 `:key` 会解码成合法键 ⇒ 绕过。
  // 三路 fail-closed：原值含 `%`（编码/双重编码变体）、解码后以 `agent.` 开头、或原值就是该键。
  if (method === 'PUT' && p.startsWith(CONFIG_KEY_PREFIX) && !p.endsWith(CONFIG_CHANGES_SUFFIX)) {
    const rawKey = p.slice(CONFIG_KEY_PREFIX.length);
    let decoded = rawKey;
    try {
      decoded = decodeURIComponent(rawKey);
    } catch {
      // 畸形编码：保留原值，下面的 `%` 判定仍会 fail-closed。
    }
    if (rawKey.includes('%') || decoded.startsWith('agent.')) {
      return allows('super_admin');
    }
  }

  // P4：PUT /api/admin/config/:key（**前缀** `/api/admin/config/` 且非 `…/changes`）⇒ super_admin | operator
  if (method === 'PUT' && p.startsWith(CONFIG_KEY_PREFIX) && !p.endsWith(CONFIG_CHANGES_SUFFIX)) {
    return allows('super_admin', 'operator');
  }

  // P5：POST /api/admin/wallet/adjust（精确）⇒ super_admin | finance
  if (method === 'POST' && p === '/api/admin/wallet/adjust') {
    return allows('super_admin', 'finance');
  }

  // P6：POST /api/admin/wallet/reverse（精确）⇒ super_admin | finance
  if (method === 'POST' && p === '/api/admin/wallet/reverse') {
    return allows('super_admin', 'finance');
  }

  // P7：POST /api/admin/wallet/reconcile/run（精确）⇒ super_admin | finance
  if (method === 'POST' && p === '/api/admin/wallet/reconcile/run') {
    return allows('super_admin', 'finance');
  }

  // ─── 风控 T7（规格 §2.9-3）：P-r1..P-r4 ───────────────────────────────
  // 🔴 **读三条必须在 P8 之前 —— 顺序敏感（F9）**：P8 是「其余 GET ⇒ 任意已认证角色」
  // 的**首个命中即终局**；这三条若落在 P8 之后，viewer/finance 会经 P8 拿到风控读权限
  //（单测以「viewer/finance 四端点 403」反证未落 P8）。

  // P-r1：GET /api/admin/risk/reviews（**精确**）⇒ super_admin | operator
  if (method === 'GET' && p === '/api/admin/risk/reviews') {
    return allows('super_admin', 'operator');
  }

  // P-r2：GET /api/admin/risk/users/:userId（**前缀** `/api/admin/risk/users/`）⇒ super_admin | operator
  if (method === 'GET' && p.startsWith(RISK_USERS_SUBPATH_PREFIX)) {
    return allows('super_admin', 'operator');
  }

  // P-r3：GET /api/admin/risk/actions 与 /api/admin/risk/actions.csv（**两条精确** ——
  // 审计读口的 JSON 与 CSV 变体；与 P1/P3 同族的「不做通配」纪律）⇒ super_admin | operator
  if (
    method === 'GET' &&
    (p === '/api/admin/risk/actions' || p === '/api/admin/risk/actions.csv')
  ) {
    return allows('super_admin', 'operator');
  }

  // ─── 支付片 T12（规格 §0.3-⚙️10）：P-p1..P-p4（读四条）──────────────────
  // 🔴 **读四条必须在 P8 之前 —— 顺序敏感（同 F9 教训 / P-r1..r3）**：P8 是「其余 GET ⇒
  // 任意已认证角色」的**首个命中即终局**；四条读面按 ⚙️10 是**显式登记**（条目 `return true`，
  // **不落 P8 兜底语义**）——落 P8 之后 = 死条目：本片读面与 P8 的返回值同形，行为不可判别，
  // 故单测以**源码序结构断言**钉住位置（`admin-policy.test.ts` 的钉序用例）。

  // P-p1：GET /api/admin/pay/orders[.csv] + /:orderNo（**两条精确 + 前缀**）⇒ 任意已认证角色
  if (
    method === 'GET' &&
    (p === '/api/admin/pay/orders' || p === '/api/admin/pay/orders.csv' || p.startsWith(PAY_ORDERS_SUBPATH_PREFIX))
  ) {
    return true;
  }

  // P-p2：GET /api/admin/pay/refunds[.csv] + /:refundNo（同族三端点）⇒ 任意已认证角色
  if (
    method === 'GET' &&
    (p === '/api/admin/pay/refunds' || p === '/api/admin/pay/refunds.csv' || p.startsWith(PAY_REFUNDS_SUBPATH_PREFIX))
  ) {
    return true;
  }

  // P-p3：GET /api/admin/pay/withdrawals[.csv] + /:withdrawNo（同族三端点）⇒ 任意已认证角色
  if (
    method === 'GET' &&
    (p === '/api/admin/pay/withdrawals' ||
      p === '/api/admin/pay/withdrawals.csv' ||
      p.startsWith(PAY_WITHDRAWALS_SUBPATH_PREFIX))
  ) {
    return true;
  }

  // P-p4：GET /api/admin/pay/actions 与 /api/admin/pay/actions.csv（**两条精确** ——
  // 审计第六源的 JSON 与 CSV 变体；同 P1/P3/P-r3 的「不做通配」纪律）⇒ 任意已认证角色
  if (method === 'GET' && (p === '/api/admin/pay/actions' || p === '/api/admin/pay/actions.csv')) {
    return true;
  }

  // ─── 玩家管理页（2026-10-22）：P10/P11 读面必须在 P8 之前 ───────────────
  // P10：GET /api/admin/players（**精确**）⇒ super_admin | operator
  if (method === 'GET' && p === '/api/admin/players') {
    return allows('super_admin', 'operator');
  }

  // P11：GET /api/admin/players/:userId/games（前缀 + 固定后缀 + 非空 userId 段）
  if (
    method === 'GET' &&
    p.startsWith('/api/admin/players/') &&
    p.endsWith('/games') &&
    p.length > '/api/admin/players//games'.length
  ) {
    return allows('super_admin', 'operator');
  }

  // ─── 代理管理（2026-10-26）：读面带必须在 P8 之前；写面在 P9 之前 ──────────
  // P-ag1：代理读面 ⇒ super_admin | finance（viewer/operator 403，不得落 P8）
  if (
    method === 'GET' &&
    (p === '/api/admin/agents' ||
      p.startsWith('/api/admin/agents/') ||
      p === '/api/admin/agent-audit' ||
      p === '/api/admin/agent-reconciliation' ||
      p === '/api/admin/agent-settlements' ||
      p.startsWith('/api/admin/agent-settlements/') ||
      p === '/api/admin/agent-adjustments' ||
      p.startsWith('/api/admin/agent-adjustments/'))
  ) {
    return allows('super_admin', 'finance');
  }

  // P8：其余 **GET**（含 .csv、审计读口、`/api/admin/accounts/changes`）⇒ 已认证即放行（任意角色）
  if (method === 'GET') return true;

  // P-ag2：代理写面（POST/PATCH/DELETE `/api/admin/agents*`，含 bind/unbind/status/reset/rotate/
  // payout/bindings/bulk/adjustments）⇒ super_admin
  if (
    (method === 'POST' || method === 'PATCH' || method === 'DELETE') &&
    (p === '/api/admin/agents' || p.startsWith('/api/admin/agents/'))
  ) {
    return allows('super_admin');
  }

  // P-ag3：结算打款/驳回 ⇒ finance | super_admin
  if (
    method === 'POST' &&
    /^\/api\/admin\/agent-settlements\/[^/]+\/(pay|reject)$/.test(p)
  ) {
    return allows('finance', 'super_admin');
  }

  // P-ag4：人工调账复核/驳回 ⇒ super_admin（发起在 P-ag2）
  if (
    method === 'POST' &&
    /^\/api\/admin\/agent-adjustments\/[^/]+\/(approve|reject)$/.test(p)
  ) {
    return allows('super_admin');
  }

  // P12：POST /api/admin/wallet/accounts/batch（精确）⇒ super_admin | operator
  if (method === 'POST' && p === '/api/admin/wallet/accounts/batch') {
    return allows('super_admin', 'operator');
  }

  // P13：POST /api/admin/pay/players/summary（精确）⇒ super_admin | operator
  if (method === 'POST' && p === '/api/admin/pay/players/summary') {
    return allows('super_admin', 'operator');
  }

  // P-r4：POST /api/admin/risk/actions（**精确**；写一条插在 P9 之前）⇒ super_admin | operator
  if (method === 'POST' && p === '/api/admin/risk/actions') {
    return allows('super_admin', 'operator');
  }

  // P-r5（设备绑定片）：DELETE /api/admin/risk/users/:userId/device-binding
  // （前缀 + 固定后缀 + 非空 userId 段；插在 P9 之前）⇒ super_admin | operator
  // —— 风控写面角色口径与 P-r4 逐字同族；注意 P-r2 只认 GET，DELETE 不会被它提前吞掉。
  if (
    method === 'DELETE' &&
    isPayActionPath(p, RISK_USERS_SUBPATH_PREFIX, DEVICE_BINDING_SUFFIX)
  ) {
    return allows('super_admin', 'operator');
  }

  // ─── 支付片 T12（规格 §0.3-⚙️10）：P-p5..P-p7（写三条）──────────────────
  // 前缀 + 固定后缀面（`:refundNo`/`:withdrawNo` 是单段路径参数；后缀区分动作；
  // **不得**通配 `/api/admin/pay/refunds/` 整个前缀——那会顺带放行以后新增的未登记写端点）。
  // 角色 = super_admin | finance（照 P6 口径；§2.4.2 末行 actor 取网关注入 `x-admin-actor`）。

  // P-p5：POST /api/admin/pay/refunds/:refundNo/review ⇒ super_admin | finance
  if (method === 'POST' && isPayActionPath(p, PAY_REFUNDS_SUBPATH_PREFIX, '/review')) {
    return allows('super_admin', 'finance');
  }

  // P-p6：POST /api/admin/pay/withdrawals/:withdrawNo/review ⇒ super_admin | finance
  if (method === 'POST' && isPayActionPath(p, PAY_WITHDRAWALS_SUBPATH_PREFIX, '/review')) {
    return allows('super_admin', 'finance');
  }

  // P-p7：POST /api/admin/pay/withdrawals/:withdrawNo/confirm ⇒ super_admin | finance
  if (method === 'POST' && isPayActionPath(p, PAY_WITHDRAWALS_SUBPATH_PREFIX, '/confirm')) {
    return allows('super_admin', 'finance');
  }

  // ─── 支付配置管理化 T7（规格 §4 / ⚙️10「E′」）：P-c1..P-c2（写两条；插在 P9 前）──────
  // E′ 裁决（2026-10-06 复审修订，设计 §D4）：渠道六键**写面全部仅 super_admin** ——
  // 原「私钥仅超管、非密五项超管|operator」被否（实测支付宝公钥 = 回调验签唯一信任锚，
  // operator 可写 ⇒ 可自签伪造回调入账）；读面（GET）**不设条目** ⇒ 落 P8「其余 GET
  // 任意已认证角色」，与 ⚙️10 的「读面任意已认证角色」逐字一致。
  // 前缀面 = 带尾斜杠（同 P3/P4/P-r2/P-p 的「不做通配」纪律）：裸 `/api/admin/pay-channel`
  // 与尾斜杠形态（归一后 = 裸）**均不中**本两条 ⇒ P9 403 fail-closed（连 super_admin 也拒）。
  //
  // 🔴 B1 教训（评审阻断消解，设计 §D4 逐字）：本条目**单角色** ⇒「按键分权 + %-编码变体
  // 绕过」的攻击前提不存在 —— policy 匹配的是**未解码原值路径**（`requestPath` 原值、只剥
  // 尾斜杠、**不解码** %XX），而 Express 的 `:key` 参数**已解码**（R75 在案，
  // `gateway.controller.ts`）；键段 `%2E`/`%4B` 等编码变体在 policy 眼里只是普通字符
  //（前缀段本身未编码）⇒ 照样命中本两条，到下游才由 config-service 对**解码后**的键做
  // 注册表白名单校验（未知键 400 不落库）。
  // ⚠️ 将来若对渠道写面**再引入角色分权**（某些键仅超管）：**不得**试图在本表匹配「解码后
  // 的键名」—— 本表永远看不到解码后的键；必须改用**按键字面路由**（无参、policy 对原值
  // 全等、编码变体落 404）+ **变体负例**入判据（同族：N1 尾斜杠 / ⚙️20 大小写变体）。

  // P-c1：PUT /api/admin/pay-channel/:key（**前缀**，键段任意）⇒ 仅 super_admin
  if (method === 'PUT' && p.startsWith(PAY_CHANNEL_SUBPATH_PREFIX)) {
    return allows('super_admin');
  }

  // P-c2：DELETE /api/admin/pay-channel/:key（同前缀）⇒ 仅 super_admin
  if (method === 'DELETE' && p.startsWith(PAY_CHANNEL_SUBPATH_PREFIX)) {
    return allows('super_admin');
  }

  // ─── 通知通道管理化 T8（规格 §4）：P-n1..P-n2（写两条；插在 P9 前）────────────────
  // 与 P-c 同族（「E′」精神）：九键（SMTP 五 + IM 四）语义上是凭据 —— webhook URL 可
  // 冒充组织向群发消息、SMTP 授权码可冒名发信 ⇒ 写面（PUT/DELETE）**仅 super_admin**；
  // 读面（GET）**不设条目** ⇒ 落 P8「其余 GET 任意已认证角色」，与规格 §4 的
  // 「GET ⇒ 落 P8」逐字一致。
  // 前缀面 = 带尾斜杠（同 P3/P4/P-r2/P-p/P-c 的「不做通配」纪律）：裸
  // `/api/admin/notify-channel` 与尾斜杠形态（归一后 = 裸）**均不中**本两条 ⇒ P9 403
  // fail-closed（连 super_admin 也拒）。
  //
  // 🔴 B1 教训（同 P-c 逐字承接的评审阻断消解）：本条目**单角色** ⇒「按键分权 +
  // %-编码变体绕过」的攻击前提不存在 —— policy 匹配的是**未解码原值路径**（`requestPath`
  // 原值、只剥尾斜杠、**不解码** %XX），而 Express 的 `:key` 参数**已解码**（R75 在案，
  // `gateway.controller.ts`）；键段 `%2E`/`%4B` 等编码变体在 policy 眼里只是普通字符
  //（前缀段本身未编码）⇒ 照样命中本两条，到下游才由 config-service 对**解码后**的键做
  // 注册表白名单校验（未知键 400 不落库）。
  // ⚠️ 将来若对通知写面**再引入角色分权**（某些键仅超管）：**不得**试图在本表匹配
  //「解码后的键名」—— 本表永远看不到解码后的键；必须改用**按键字面路由**（无参、policy
  // 对原值全等、编码变体落 404）+ **变体负例**入判据（同族：N1 尾斜杠 / ⚙️20 大小写变体）。

  // P-n1：PUT /api/admin/notify-channel/:key（**前缀**，键段任意）⇒ 仅 super_admin
  if (method === 'PUT' && p.startsWith(NOTIFY_CHANNEL_SUBPATH_PREFIX)) {
    return allows('super_admin');
  }

  // P-n2：DELETE /api/admin/notify-channel/:key（同前缀）⇒ 仅 super_admin
  if (method === 'DELETE' && p.startsWith(NOTIFY_CHANNEL_SUBPATH_PREFIX)) {
    return allows('super_admin');
  }

  // ─── 广告片 T8（规格 §2.3）：P-a1..P-a2（写两条；插在 P9 前）────────────────────
  // 与 P-c/P-n 同族（「E′」精神）：唯一键 `ad.callbackSecret` 语义上是凭据 —— 广告回调
  // **验签的信任锚**（持有者可伪造第三方广告平台的回调入账）⇒ 写面（PUT/DELETE）
  // **仅 super_admin**；读面（GET）**不设条目** ⇒ 落 P8「其余 GET 任意已认证角色」
  //（本空间全密键 ⇒ 掩码读，value 恒 null，规格 §2.3）。
  // 前缀面 = 带尾斜杠（同 P3/P4/P-r2/P-p/P-c/P-n 的「不做通配」纪律）：裸
  // `/api/admin/ad-channel` 与尾斜杠形态（归一后 = 裸）**均不中**本两条 ⇒ P9 403
  // fail-closed（连 super_admin 也拒）。
  //
  // 🔴 B1 教训（同 P-c/P-n 逐字承接的评审阻断消解）：本条目**单角色** ⇒「按键分权 +
  // %-编码变体绕过」的攻击前提不存在 —— policy 匹配的是**未解码原值路径**（`requestPath`
  // 原值、只剥尾斜杠、**不解码** %XX），而 Express 的 `:key` 参数**已解码**（R75 在案，
  // `gateway.controller.ts`）；键段 `%2E`/`%72` 等编码变体在 policy 眼里只是普通字符
  //（前缀段本身未编码）⇒ 照样命中本两条，到下游才由 config-service 对**解码后**的键做
  // 注册表白名单校验（未知键 400 不落库）。
  // ⚠️ 将来若对广告写面**再引入角色分权**（某些键仅超管）：**不得**试图在本表匹配
  //「解码后的键名」—— 本表永远看不到解码后的键；必须改用**按键字面路由**（无参、policy
  // 对原值全等、编码变体落 404）+ **变体负例**入判据（同族：N1 尾斜杠 / ⚙️20 大小写变体）。

  // P-a1：PUT /api/admin/ad-channel/:key（**前缀**，键段任意）⇒ 仅 super_admin
  if (method === 'PUT' && p.startsWith(AD_CHANNEL_SUBPATH_PREFIX)) {
    return allows('super_admin');
  }

  // P-a2：DELETE /api/admin/ad-channel/:key（同前缀）⇒ 仅 super_admin
  if (method === 'DELETE' && p.startsWith(AD_CHANNEL_SUBPATH_PREFIX)) {
    return allows('super_admin');
  }

  // P9：其余**非 GET**（未登记写路径）⇒ 403 fail-closed（连 super_admin 也拒）
  return false;
}

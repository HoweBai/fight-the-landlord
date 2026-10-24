import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  ADMIN_ACTOR_HEADER,
  ADMIN_HEADER,
  ADMIN_ROLE_HEADER,
  CLIENT_IP_HEADER,
} from './identity-headers';
import { isAdminLoginPath, isAdminPath, requestPath } from './public-paths';
// ⚠️ 值导入：与玩家侧共用**同一份** 401/403 契约信封（§11.1）；同族错误形态集中在一处。
import { CodedForbidden, CodedUnauthorized } from './jwt.middleware';
import { ADMIN_ROLES, authorizeAdmin, normalizeAdminPath } from './admin-policy';

/**
 * ③ T5（规格 §2.10）：管理面鉴权中间件 —— 网关侧管理面的**单点授权**（角色矩阵只在网关执行；
 * 下游服务只认 `X-Admin` + `X-Admin-Actor`，设计 D2）。
 *
 * **处理序 0–7 逐字（顺序即契约）**：
 *
 *  0. **路径归一（⚙️17）**：`path = requestPath(req)` 后剥全部尾斜杠得 `normPath`；
 *     **只有第 6 步 policy 匹配使用 `normPath`** —— 豁免判定（第 3 步）用**原值**；
 *     `isAdminPath`（第 2 步）的尾斜杠/原值语义不变、**识别大小写不敏感（⚙️20，终审 F1）**。
 *     `POST /api/admin/login/`（尾斜杠）不落豁免 ⇒ 走 Bearer
 *     要求 ⇒ 401 fail-closed（N1：若归一射程含豁免，尾斜杠登录变体将直达登录处理器而
 *     失败桶不计数 —— scrypt 的唯一防爆破控制被旁路。真栈实证：express 非严格路由下
 *     `/api/admin/config/` 与无斜杠同处理器；policy 不归一则 `GET /api/admin/accounts/`
 *     绕过 P1 落 P8 = 越权路径 S1）。
 *  1. **剥四枚**（所有路径、任何判断与 throw 之前）：`x-admin` / `x-admin-actor` /
 *     `x-admin-roles` / `x-client-ip` —— 客户端伪造值在下游永远不可见（与 `JwtMiddleware`
 *     剥 `X-User-Id`/`X-Token-Jti` 同族纪律：身份头只可能来自验证结果）。
 *  2. 非 admin 路径 ⇒ next。（**admin 路径判定 = 大小写不敏感**（⚙️20，终审 F1 订正，
 *     归一上收于 `isAdminPath` 一层）—— 否则大小写变体（`/API/admin/login`）会被当玩家
 *     路径：玩家验签放行、本中间件跳过、登录失败桶不计数 ⇒ 直通下游**豁免登录路由**、
 *     旁路唯一防爆破控制。第 0 步归一与第 3 步豁免判定**保持原值**语义不变。）
 *  3. `POST /api/admin/login`（**原值**，恰一条）⇒ next —— 入口本身、按定义没有令牌；
 *     近邻路径（`/api/admin/loginx`、`/api/admin/login/step`、尾斜杠变体）**不得**被顺手豁免。
 *  4. 缺 Bearer ⇒ 401 `10002`；验签（`aud:'ftl-admin'`）失败 ⇒ 401 `10005`。
 *  5. **claims 校验（⚙️4）**：`sub`/`username` 非空 string、`role ∈ {super_admin, finance,
 *     operator, viewer}`；否则 401 `10005`（旧令牌无身份要素 ⇒ 升级后全员重登一次）。
 *  6. **policy**（`admin-policy.ts`，显式枚举、按序首个命中）：命中但角色不足 ⇒
 *     403 `10003`（`CodedForbidden`）且**不注入任何下游头**；P9 兜底未登记的写路径。
 *  7. 注入 `X-Admin:'1'` + `X-Admin-Actor:<username>` + `X-Admin-Roles:<role>`；
 *     `req.adminTokenFp` 照旧（sha256 前 16 位 —— 写桶限流键）。
 *
 * ⚠️ 密钥链 `ADMIN_JWT_SECRET || JWT_SECRET || dev 兜底` 必须与 `config-service` 的
 * `admin-auth.service.ts`（`adminJwtSecret()`）**逐字同形** —— C4-1：两侧不同钥的那一天，
 * 登录 200 而此后每个管理请求 401，日志里看不出为什么。
 * ⚠️ **`||` 而不是 `??`（裁决 2026-10-01，T9 修复轮）**：compose 以 `${ADMIN_JWT_SECRET:-}`
 * **空串透传**（宿主未设 ⇒ `''`，不是「未设」），而 jsonwebtoken 对空密钥**硬拒**
 * （`verify` 抛 `secret or public key must be provided`）⇒ 管理令牌全 401（签发侧更早在
 * 登录处 500）。「空串 = 未设 ⇒ 回落 `JWT_SECRET`」与 `ADMIN_PASSWORD`、`CONFIG_SYNC_*`
 * 是**同一纪律**；判据在 `admin.middleware.test.ts` 的密钥链三例（含空串端到端）。
 *
 * ⚠️ 中间件**不注入玩家身份**（`X-User-Id`/`user`/ALS 上下文）—— 管理面没有玩家身份，
 * 这一段的日志 userId 保持 `null` 是正确形态，不是遗漏。
 */
@Injectable()
export class AdminAuthMiddleware implements NestMiddleware {
  /**
   * 构造期读一次 env：中间件实例随模块初始化产生，env 在此前已定型
   * （与 config-service 签发侧「每次现读」的差异记录在此；密钥热换不在本片范围）。
   */
  private readonly jwt = new JwtService({
    secret:
      process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'dev-secret-change-in-production',
  });

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const path = requestPath(req);
    // ⓪ 归一：**射程只到第 6 步**（豁免/限流桶用原值；管辖识别大小写不敏感 —— 见类注释 0、N1 与 ⚙️20）。
    const normPath = normalizeAdminPath(path);

    // ① 先剥（所有路径、所有结果之前）：下面任何一步 throw，伪造头都不会留在 req 上。
    //    ⚠️ 四种字段名与第 7 步的注入三枚 + headersOf 的 clientIp 一一对应 ——
    //    少剥一枚 = 该身份通道可被客户端伪造。
    delete req.headers[ADMIN_HEADER];
    delete req.headers[ADMIN_ACTOR_HEADER];
    delete req.headers[ADMIN_ROLE_HEADER];
    delete req.headers[CLIENT_IP_HEADER];

    // ② 非 admin 路径 ⇒ next（⚙️20：admin 判定**大小写不敏感**；与玩家的「哪条路径被豁免」
    //    是两件事 —— 第 3 步仍是原值精确）。
    if (!isAdminPath(path)) {
      next();
      return;
    }

    // ③ 豁免恰好一条：登录入口本身（**原值**精确；尾斜杠变体不落这里 ⇒ 401，见类注释 0）。
    if (isAdminLoginPath(path)) {
      next();
      return;
    }

    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new CodedUnauthorized(ErrCode.UNAUTHENTICATED, 'Missing admin token');
    }

    // ④ bearer 验签（10002/10005 现状不动：过期与伪造对管理员是同一句话「请重新登录」——
    //    与玩家侧区分 10004/10005 不同，管理面没有「续期」语义）。
    const token = auth.slice(7);
    let payload: AdminTokenClaims;
    try {
      payload = this.jwt.verify(token, { audience: 'ftl-admin' }) as AdminTokenClaims;
    } catch {
      throw new CodedUnauthorized(ErrCode.TOKEN_INVALID, 'Invalid or expired admin token');
    }

    // ⑤ claims 校验（⚙️4）：身份要素齐全且角色在四值白名单内，否则与验签失败同一句话。
    const { sub, username, role } = payload ?? {};
    if (
      typeof sub !== 'string' ||
      sub.length === 0 ||
      typeof username !== 'string' ||
      username.length === 0 ||
      typeof role !== 'string' ||
      !(ADMIN_ROLES as readonly string[]).includes(role)
    ) {
      throw new CodedUnauthorized(ErrCode.TOKEN_INVALID, 'Invalid or expired admin token');
    }

    // ⑥ policy（**归一后路径**）：命中但角色不足 / 未登记写路径 ⇒ 403 fail-closed，
    //    且**不注入任何下游头**（本 throw 之后的所有注入语句都不可达）。
    if (!authorizeAdmin({ method: req.method, normPath, role })) {
      throw new CodedForbidden(ErrCode.FORBIDDEN, 'Insufficient role / endpoint not registered');
    }

    // ⑦ 验真+授权通过才注入 + 挂指纹（失败路径上这些都不存在）。
    req.headers[ADMIN_HEADER] = '1';
    req.headers[ADMIN_ACTOR_HEADER] = username;
    req.headers[ADMIN_ROLE_HEADER] = role;
    (req as { adminTokenFp?: string }).adminTokenFp = createHash('sha256')
      .update(token)
      .digest('hex')
      .slice(0, 16);

    next();
  }
}

/**
 * ③ T5（规格 §2.10 第 5 步）：管理令牌 claims —— **网关侧本地同形声明**（G3：不跨服务
 * import config-service 的 `AdminTokenClaims`）。
 *
 * 两侧同形由「登录响应端到端 + 网关验收」判据钉（同 `aud` 字面量两侧各写一份的既有先例）。
 * 字段全部 `unknown`：jsonwebtoken 的 `verify` 只保证载荷是 JSON 对象 —— 形状收窄是
 * **第 5 步校验**的职责（声明成 `sub?: string` 之类的「假类型」会让校验看起来多余）。
 */
interface AdminTokenClaims {
  sub?: unknown;
  username?: unknown;
  role?: unknown;
  aud?: unknown;
  iat?: unknown;
  exp?: unknown;
}

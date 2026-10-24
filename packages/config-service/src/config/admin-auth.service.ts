import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { toSafeInt } from '../admin/admin-accounts.service';
import { verifyPassword as verifyScryptPassword } from '../admin/admin-password';

/**
 * 管理令牌的 TTL（规格 §2.3：**2 小时**）。
 *
 * ⚠️ 单一真源：`signToken()` 的 `expiresIn` 与登录响应的 `expiresIn` 都取它
 * （计划文本的 `'2h'` 是等价写法；两处各写一份数字/字符串会把「2 小时」变成两处事实）。
 */
export const ADMIN_TOKEN_TTL_SECONDS = 7200;

/** 管理令牌的 `aud`（与玩家令牌**隔离**：网关 F3 按它验；玩家 JWT 不得冒充管理员）。 */
export const ADMIN_TOKEN_AUDIENCE = 'ftl-admin';

/**
 * 启用谓词（规格 §2.3 第①步逐字）：**表非空** = 管理面启用。
 * ⚠️ ⚙️16：`ADMIN_PASSWORD` **不再是开关**（它只决定首启 bootstrap 建不建引导账号）。
 */
export const ADMIN_ENABLED_SQL = 'SELECT 1 FROM admin_accounts LIMIT 1';

/** 按**归一后**用户名查行（第④步）。`password_hash` 仅在服务端内存里过手，永不出站。 */
export const ADMIN_FIND_ACCOUNT_SQL =
  'SELECT id, username, password_hash, role, status FROM admin_accounts WHERE username = ?';

/** 第⑦步逐字：成功登录后刷最近登录时间（UTC 库时钟；⚙️1）。 */
export const ADMIN_TOUCH_LOGIN_SQL = 'UPDATE admin_accounts SET last_login_at=NOW(3) WHERE id=?';

/**
 * 签发/校验密钥链（规格 §2.6）：`ADMIN_JWT_SECRET` **||** `JWT_SECRET` **||** dev 兜底。
 * ⚠️ 与网关 `AdminAuthMiddleware`（T9）**逐字同链** —— 两侧算法不同步的那一天，登录成功而
 * 每个请求 401，且日志里看不出为什么。
 *
 * ⚠️ **`||` 而不是 `??`（裁决 2026-10-01，T9 修复轮）**：compose 以
 * `${ADMIN_JWT_SECRET:-}` **空串透传**（宿主未设 ⇒ `''`，不是「未设」），而 jsonwebtoken
 * 对空密钥**硬拒**（`sign` 抛 `secretOrPrivateKey must have a value` ⇒ 登录 500）。
 * 「空串 = 未设 ⇒ 回落 `JWT_SECRET`」与 `ADMIN_PASSWORD`（`(env ?? '') || null`）、
 * 消费侧 `CONFIG_SYNC_*` 是**同一纪律**；判据在 `admin-auth.test.ts` ⑤（sign→verify 端到端）。
 */
function adminJwtSecret(): string {
  return process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'dev-secret-change-in-production';
}

/**
 * 管理令牌载荷（规格 §2.3：`{sub:String(id), username, role, aud:'ftl-admin', iat, exp}`）。
 * 网关 T5 按**本地同形声明**校验这四个身份要素（不跨服务 import——计划 G3）；
 * ⚠️ 旧令牌（无 `sub/username/role`）在新网关下 ⇒ 401 10005 ⇒ **升级后全员重新登录一次**（⚙️4）。
 */
export interface AdminTokenClaims {
  sub?: string;
  username?: string;
  role?: string;
  aud?: string;
  iat?: number;
  exp?: number;
}

/** 签发入参（登录成功时由 controller 从**查行命中**的账号行构造——`sub` 显式 `String(id)`）。 */
export interface AdminIdentityClaims {
  sub: string;
  username: string;
  role: string;
}

/** 登录查行结果（内部形态；`password_hash` 只进 `verifyPassword`，永不进响应）。 */
export interface AdminAuthAccountRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  status: string;
}

interface RawAccountRow {
  id: unknown;
  username: unknown;
  password_hash: unknown;
  role: unknown;
  status: unknown;
}

/**
 * 管理面认证（规格 §2.3；③ T3 起改版为**库内账号**）。
 *
 * 职责边界：账号行的读（启用谓词/查行/刷 last_login）与 scrypt 校验、claims 令牌的签发/校验；
 * 七步处理序的**编排**在 `src/config/admin.controller.ts`（顺序即契约，不藏进服务）。
 *
 * fail-closed 的三条纪律：
 *  - 启用谓词 = **表非空**（⚙️16；`ADMIN_PASSWORD` 只喂首启 bootstrap）；
 *  - 口令比较 = 库内 scrypt 哈希（`s1$…`；`timingSafeEqual` + 长度守卫在 `admin-password.ts`）；
 *  - 令牌用**独立密钥链 + 独立 aud**签发；玩家令牌/别的密钥签的令牌一律验不过。
 */
@Injectable()
export class AdminAuthService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /** 管理面是否启用（第①步）：`SELECT 1 FROM admin_accounts LIMIT 1` 有行 ⇒ 启用。 */
  async isEnabled(): Promise<boolean> {
    const rows = (await this.dataSource.query(ADMIN_ENABLED_SQL)) as unknown[];
    return rows.length > 0;
  }

  /** 按归一后用户名查行（第④步）；miss ⇒ `null`（调用方按「未知用户名」分流）。 */
  async findAccount(username: string): Promise<AdminAuthAccountRow | null> {
    const rows = (await this.dataSource.query(ADMIN_FIND_ACCOUNT_SQL, [username])) as RawAccountRow[];
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      id: toSafeInt(row.id, 'admin_accounts.id'),
      username: String(row.username),
      password_hash: String(row.password_hash),
      role: String(row.role),
      status: String(row.status),
    };
  }

  /**
   * 第⑤步：对**库内哈希**做 scrypt 校验（参数从存储串解析；损坏串 ⇒ false 不抛）。
   * 失败与「查无此人」在路由层翻成**同一句** 401（防枚举）。
   */
  async verifyPassword(plain: string, stored: string): Promise<boolean> {
    return verifyScryptPassword(plain, stored);
  }

  /** 第⑦步：刷 `last_login_at`（只走成功路径）。 */
  async touchLastLogin(id: number): Promise<void> {
    await this.dataSource.query(ADMIN_TOUCH_LOGIN_SQL, [id]);
  }

  /** 签发管理令牌（`aud='ftl-admin'`、2h、带身份 claims）。每次现读 env —— 便于测试与将来热换密钥。 */
  signToken(identity: AdminIdentityClaims): string {
    return new JwtService({ secret: adminJwtSecret() }).sign(
      { sub: identity.sub, username: identity.username, role: identity.role },
      { audience: ADMIN_TOKEN_AUDIENCE, expiresIn: ADMIN_TOKEN_TTL_SECONDS },
    );
  }

  /** 校验管理令牌（签名、`exp`、`aud` 三项）。失败一律**抛**（调用方按场景翻码）。 */
  verifyToken(token: string): AdminTokenClaims {
    return new JwtService({ secret: adminJwtSecret() }).verify<AdminTokenClaims>(token, {
      audience: ADMIN_TOKEN_AUDIENCE,
    });
  }
}

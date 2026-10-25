import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Injectable,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ErrCode, ProtocolError, type ConfigKey } from '@fight-the-landlord/protocol';
import { httpException } from '../http/errors';
import { CLIENT_IP_HEADER, LoginEventsService } from '../admin/login-events.service';
import { ADMIN_ACTOR_HEADER, requireActor } from '../admin/admin-accounts.service';
import { ADMIN_TOKEN_TTL_SECONDS, AdminAuthService } from './admin-auth.service';
import { configSnapshotPayload, PlatformConfigService } from './platform-config.service';

/**
 * 网关注入的管理标记头名（网关 `identity-headers.ts` 是它的真源；两处各定义一次是本仓
 * 既有惯例 —— 同 `INTERNAL_TOKEN_HEADER`，由 T9 的网关测试与 C6 在真拓扑上钉住不漂移）。
 */
export const ADMIN_HEADER = 'x-admin';

/**
 * 管理面豁免表 —— **恰好一条**（规格 §2.5 / 设计 D6②）。
 *
 * `POST /api/admin/login` 是入口本身、**按定义没有令牌**；除此之外任何 admin 路由都不豁免
 * （「顺手多豁免」就是那个洞）。写成**数据**而不是 `if (login) return true` 的散落分支，
 * 是为了让它可单测（结构 + 行为两条断言见 `admin.controller.test.ts`；网关侧同款豁免的
 * 判据在 T9）。
 */
export const ADMIN_EXEMPT_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/admin/login' },
];

/** 该请求是否命中豁免表（method + **完整路径**——含 globalPrefix `api`）。 */
export function isAdminExemptRoute(method: string, path: string): boolean {
  return ADMIN_EXEMPT_ROUTES.some((r) => r.method === method && r.path === path);
}

/**
 * 管理面未启用（**零账号**，第①步）⇒ **404**：这条「路」不存在。
 * ⚠️ ⚙️16：谓词是**表非空**（不是 `ADMIN_PASSWORD`——它只喂首启 bootstrap）。
 */
function notEnabled404(): HttpException {
  // ⛔ 不用 10007（`UPSTREAM_UNAVAILABLE`）：拿它表示常态关闭会把「没开」伪装成「故障」
  //    （设计 M-4①）。码用 `BAD_PARAM`：§11.2 的码表**封闭**、没有「资源不存在」的专用码
  //    —— 先例 = 网关 `http/not-found.filter.ts`（N12/R244，同为「404 + 10001」）；
  //    管理页按 **status** 分流（T12 的 `if (status === 404)`），不读 code。
  return new HttpException({ code: ErrCode.BAD_PARAM, message: '管理面未启用', data: null }, 404);
}

/**
 * fail-closed：`X-Admin: 1`（网关 `AdminAuthMiddleware` 验完管理令牌后**注入**的；
 * 网关同时剥离客户端伪造的同名头）。缺失 / 任何非 `'1'` 值 ⇒ **401**，且**不进 handler**。
 *
 * ⚠️ 本服务只信这个头**存在且为 '1'**：令牌的验签是网关的职责（F3），配置服务的
 * `/api/admin/*` 不直接对玩家网络暴露（`expose` 而非 `ports`，compose T4）。
 */
@Injectable()
export class XAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      method: string;
      path: string;
      headers: Record<string, string | string[] | undefined>;
    }>();
    if (isAdminExemptRoute(req.method, req.path)) return true;

    const provided = req.headers[ADMIN_HEADER];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (value !== '1') throw httpException(ErrCode.UNAUTHENTICATED, 'admin header required');
    return true;
  }
}

/** 登录响应（规格 §2.3：`{token, expiresIn: 7200, username, role}`；`username` = 归一后值）。 */
export interface AdminLoginPayload {
  token: string;
  expiresIn: number;
  username: string;
  role: string;
}

/** 失败矩阵逐字（规格 §2.14）：未知用户名与错口令**必须**同码同文案（防枚举）。 */
const LOGIN_FAILED_MESSAGE = '用户名或口令错误';
const LOGIN_SHAPE_MESSAGE = '参数非法';
const LOGIN_DISABLED_MESSAGE = '账号已停用';

/**
 * 管理面三条路由（规格 §2.3/§2.5，设计 §D6）：
 *
 *  - `POST /api/admin/login`：**七步处理序逐字**（启用 404 → 形状 400 → 归一 → 查行 401 →
 *    scrypt 401 → 停用 403 → 成功 200 带 `{token, expiresIn, username, role}`）；事件只在
 *    形状合法后的 ④–⑦ 分支落行（⚙️3）；
 *  - `GET  /api/admin/config`：全量一百键 + 每键 version + 全局 MAX；
 *  - `PUT  /api/admin/config/:key`：`X-Admin-Actor` 缺失/非法 ⇒ **401 fail-closed**（§2.6）；
 *    非法值 ⇒ **400 + 原因**且**不落库**（连锁定读都不发生）；成功 ⇒
 *    `{saved:true, announced, version}`（`announced` 如实透传 —— publish 失败不拦写，C12），
 *    `updated_by`/留痕 `actor` = 头值。
 */
@Controller('admin')
@UseGuards(XAdminGuard)
export class AdminController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly config: PlatformConfigService,
    private readonly events: LoginEventsService,
  ) {}

  @Post('login')
  @HttpCode(200) // POST 的 Nest 缺省是 201；登录按 200（C15 的「清桶后可登录」也按 200）
  async login(
    @Body() body: { username?: unknown; password?: unknown },
    @Headers(CLIENT_IP_HEADER) clientIp?: string,
  ): Promise<{ code: ErrCode; data: AdminLoginPayload }> {
    // ① 启用检查（表非空；无行 ⇒ 404 借 10001「管理面未启用」）。**先于**形状校验——顺序即契约。
    if (!(await this.auth.isEnabled())) throw notEnabled404();

    // ② 形状校验（400 借 10001「参数非法」；**不落事件**——⚙️3：形状错不是凭据尝试）。
    // ⚙️19：username 上界 = **32**（与 `admin_login_events.username varchar(32)` 列宽、
    // `isAdminUsername` 正则上界对齐）——旧的 64 会让 33–64 字符未知用户名在 ④ miss
    // 落事件时撞 ER_DATA_TOO_LONG ⇒ **未认证可打 500**（波2评审 Critical#1）。
    const rawUsername = body?.username;
    const rawPassword = body?.password;
    if (
      typeof rawUsername !== 'string' ||
      rawUsername.length === 0 ||
      rawUsername.length > 32 ||
      typeof rawPassword !== 'string' ||
      rawPassword.length === 0 ||
      rawPassword.length > 1024
    ) {
      throw httpException(ErrCode.BAD_PARAM, LOGIN_SHAPE_MESSAGE);
    }

    // ③ 归一（⚙️8：登录**不跑用户名正则**——只归一；「查无此人」由 ④ 兜）
    const username = rawUsername.toLowerCase();
    // ③′ 扩长防线：`toLowerCase()` 可**扩长**（如 `İ`(U+0130) ⇒ `i̇` 2 字符）。扩长后 >32 的值
    // 既不可能命中库内账号（账号一律 ≤32 的 isAdminUsername 形态），落事件又会撑爆 varchar(32)
    // ⇒ 按形状级 400 拒掉（不落事件——同 ⚙️3 的理由：形状错不是凭据尝试）。
    if (username.length > 32) throw httpException(ErrCode.BAD_PARAM, LOGIN_SHAPE_MESSAGE);

    // ④ 查行（miss ⇒ 事件 + 401 10002；同一句文案见下）
    const account = await this.auth.findAccount(username);
    if (!account) {
      await this.events.record({ username, accountId: null, ip: clientIp, success: false });
      throw httpException(ErrCode.UNAUTHENTICATED, LOGIN_FAILED_MESSAGE);
    }

    // ⑤ scrypt verify（fail ⇒ **同一句** 401——未知用户名与错口令在 wire 上不可区分）
    if (!(await this.auth.verifyPassword(rawPassword, account.password_hash))) {
      await this.events.record({ username, accountId: account.id, ip: clientIp, success: false });
      throw httpException(ErrCode.UNAUTHENTICATED, LOGIN_FAILED_MESSAGE);
    }

    // ⑥ disabled ⇒ 事件 + 403 10003（在 ⑤ 之后：停用账号的错口令仍是 401——顺序即契约）
    if (account.status === 'disabled') {
      await this.events.record({ username, accountId: account.id, ip: clientIp, success: false });
      throw httpException(ErrCode.FORBIDDEN, LOGIN_DISABLED_MESSAGE);
    }

    // ⑦ 成功：UPDATE last_login_at ⇒ 事件 success=1 ⇒ 签发（逐字序）
    await this.auth.touchLastLogin(account.id);
    await this.events.record({ username, accountId: account.id, ip: clientIp, success: true });
    return {
      code: ErrCode.OK,
      data: {
        token: this.auth.signToken({ sub: String(account.id), username, role: account.role }),
        expiresIn: ADMIN_TOKEN_TTL_SECONDS,
        username,
        role: account.role,
      },
    };
  }

  @Get('config')
  async getConfig() {
    return { code: ErrCode.OK, data: configSnapshotPayload(await this.config.list()) };
  }

  @Put('config/:key')
  async putConfig(
    @Param('key') key: string,
    @Body() body: { value?: unknown },
    @Headers(ADMIN_ACTOR_HEADER) actor?: string,
  ) {
    // §2.6：写面身份 fail-closed——`X-Admin-Actor` 缺失/非法 ⇒ **401 不回退**（先于一切库操作，
    // 也先于 400 校验：认证先于参数校验，同 T2 账号写面的判定形态）。
    const by = requireActor(actor);
    let result: { version: number; announced: boolean };
    try {
      // `updatedBy` = 网关注入的操作者（T5 起可达；本服务只信头值且已过用户名正则）。
      result = await this.config.set(key as ConfigKey, body?.value, by);
    } catch (err) {
      if (err instanceof ProtocolError) {
        // C5：非法/未知键 ⇒ 400 + 原因（parseConfigValue 的中文消息），且**不落库** ——
        // 校验发生在 `set()` 的第一行、任何库操作**之前**（含广播与锁定读）。
        throw httpException(ErrCode.BAD_PARAM, err.message);
      }
      throw err;
    }
    return {
      code: ErrCode.OK,
      data: { saved: true, announced: result.announced, version: result.version },
    };
  }
}

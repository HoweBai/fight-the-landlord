import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { ProxyGateway } from './proxy.gateway';
import {
  ADMIN_ACTOR_HEADER,
  ADMIN_HEADER,
  ADMIN_ROLE_HEADER,
  AUTHORIZATION_HEADER,
  REAUTH_TICKET_HEADER,
  TOKEN_JTI_HEADER,
  TRACE_ID_HEADER,
  USER_ID_HEADER,
  isLogoutPath,
  isReauthPath,
  isWithdrawApplyPath,
  type DownstreamHeaders,
} from '../auth/identity-headers';
// ③ T5（§2.10）：登录路径判定（clientIp 产出的唯一开关）—— 与中间件豁免/限流登录桶
// 共用同一份（`public-paths.ts` 单一真源）。
import { isAdminLoginPath } from '../auth/public-paths';
// ③ T5：clientIp 的**派生**实现（peer 派生 + 可信表解析；与限流共用同一份口径）。
import { requestClientIp } from '../http/trusted-client-ip';

/**
 * 房间号形状（与 `RoomsService.generateCode` 一致：**恰好** 6 位 `[0-9A-Z]`）。
 *
 * R75：**只做 `encodeURIComponent` 不够** —— `%2F`、`..`、超长串之类经 Express
 * 解码后仍会被拼进下游 URL 与 Redis 键名，属探测面。形状不合法的请求在网关就地
 * 拒掉（`10001`），**不**打到下游。
 *
 * 导出以便单测直接钉住边界，也让「房间号形状」在全仓只有一个定义处。
 */
export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Z]{6}$/.test(value);
}

/**
 * §11.2：`10001 BAD_PARAM` 配 400。
 *
 * **不得**用 404/500 代替 —— 那是把「参数非法」伪装成「房间不存在」。
 */
function badParam(message: string): BadRequestException {
  return new BadRequestException({ code: ErrCode.BAD_PARAM, message, data: null });
}

@Controller()
export class GatewayController {
  constructor(private readonly proxyGateway: ProxyGateway) {}

  // ⚠️ **`/api/health` 的处理器不在这里**（R294）：本控制器此前声明了
  // `@Get('health') health()`，而 `HealthController`（同一个 `AppModule` 里、
  // **声明在后**）也声明 `@Get()` ⇒ 两条路由**同路径重复注册**，Express 取**先注册**的
  // 那条 ⇒ 真正对外的是这里那个**不含 `checks`** 的旧形状，§2.4/R267 的就绪面
  // 在网关上**静默失效**（实测：`:3000/api/health` 返回 `{"status":"ok","service":"api-gateway"}`，
  // 没有 `checks`）。
  //
  // 单测抓不到：`health.test.ts` 直接装配 `HealthController`，看不到「谁先注册」；
  // 只有**真容器**（或 `container-assembly.gate.test.ts` 的重复路由闸）能看见。
  // 现在健康面**只有** `HealthController` 一处真源（＋`health.service.ts` 的依赖探测）。

  // Auth routes
  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc('POST', '/api/auth/login', body, res, headersOf(req));
  }

  @Post('auth/register')
  @HttpCode(201)
  async register(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc('POST', '/api/auth/register', body, res, headersOf(req));
  }

  /** §5.1：公开路径，凭 refresh token 换新的一对（轮换由 user-service 负责）。 */
  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc('POST', '/api/auth/refresh', body, res, headersOf(req));
  }

  /**
   * §5.1：登出删除两个 jti。
   *
   * 这条路径**已验签**（不在 §7.1 的公开白名单里），中间件因此把 access token 的
   * `jti` 注入到内部头 `X-Token-Jti`，由 `headersOf` 转发给 user-service（R31）。
   */
  @Post('auth/logout')
  @HttpCode(200)
  async logout(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc('POST', '/api/auth/logout', body, res, headersOf(req));
  }

  /**
   * 提现再认证片（`risk.withdrawReAuthEnabled` 开时客户端才调）：凭 access token + 登录密码
   * 换一张 5 分钟一次性票据，随后带 `X-Reauth-Ticket` 调 `POST /api/pay/withdrawals`。
   *
   * ⚠️ **合并期补上**：本文件是**逐条显式路由**（没有 `/api/auth/*` 泛型转发），分支只加了
   * user-service 的 `@Post('auth/reauth')` 与客户端调用点、**漏了网关这一跳** ⇒ 客户端会拿到
   * 网关的 404，整条再认证链路不可用。与 `auth/logout` 同形：**需鉴权**（不在 §7.1 公开白名单里，
   * 中间件因此会注入 `x-user-id` 供下游取 `req.user.sub`）。
   */
  @Post('auth/reauth')
  @HttpCode(200)
  async reauth(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc('POST', '/api/auth/reauth', body, res, headersOf(req));
  }

  // Config routes（片⑦ T10 / 设计 D5+D6）。⚠️ 旧端点 `GET /api/base-score-levels`
  // **随片⑦退役**（底分档位表并入 config-service 的 `GET /api/config` 子集 —— 它的
  // 「路由名与目标服务不一致」是上一个形态的刻意选择，本片把这个理由连同端点一起删掉）。

  /** `GET /api/config`：玩家面配置**子集**（§2.4：恰好七键），经玩家验签（不在公开白名单里）。 */
  @Get('config')
  async getConfig(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc('GET', '/api/config', null, res, headersOf(req));
  }

  /**
   * `POST /api/admin/login`：管理登录入口**本身** —— 唯一一条豁免 `X-Admin` 的 admin 路由
   * （与 config-service 的 `ADMIN_EXEMPT_ROUTES` 同一语义，两侧**各自**强制）。
   * 口令比较在 config-service（网关这一跳只有失败计次桶，见 `HttpRateLimitMiddleware` 的 admin 分支）。
   *
   * `@HttpCode(200)`：POST 的 Nest 缺省是 201，登录按 200（与 `auth/login` 同形）。
   * （转发路径上状态码由下游响应决定 —— 这个装饰器是与 `auth/login` 对齐的形态；
   * 200 同时也是失败计次桶「成功清零」的信号：finish 钩子读的就是响应的 `statusCode`。）
   */
  @Post('admin/login')
  @HttpCode(200)
  async adminLogin(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc('POST', '/api/admin/login', body, res, headersOf(req));
  }

  /** `GET /api/admin/config`：全量九十二键 + 每键 version + 全局 MAX（持管理令牌读）。 */
  @Get('admin/config')
  async getAdminConfig(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc('GET', '/api/admin/config', null, res, headersOf(req));
  }

  /**
   * `PUT /api/admin/config/:key`：管理写（持管理令牌）。
   *
   * R75 一族：`:key` 也是**路径参数** ⇒ 与房间号同规——拼进下游 URL 前先编码
   * （`PUT /api/admin/config/ABC%3Fseat=1` 经 Express 解码成 `ABC?seat=1`，
   * **只**编码不校验之外，它会被原样拼进下游 URL 的查询串 = N3 查询走私）。
   * ⚠️ 键的**合法性**（是不是已知 `ConfigKey`）**不在网关判** —— 那是 config-service
   * `parseConfigValue` 的职责（单一真源，键集住在 protocol）；非法键由下游按 400 + 原因拒。
   */
  @Put('admin/config/:key')
  async putAdminConfig(
    @Param('key') key: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToConfigSvc(
      'PUT',
      `/api/admin/config/${encodeURIComponent(key)}`,
      body,
      res,
      headersOf(req),
    );
  }

  // 支付配置管理化 T7（规格 §2.4 / §4）：渠道凭据管理三端点（下游 = **config-service**）。
  // 授权 = 网关 policy **P-c1/P-c2**（写面仅 super_admin，「E′」）+ GET 落 P8（任意已认证
  // 角色）—— 本控制器只做「路由 + 路径参数编码（R75）+ 转发形状」。命名刻意避开
  // `/api/admin/pay/*`（payment-service 命名空间）与 `/api/admin/config/*`（P4 前缀陷阱）。

  /**
   * `GET /api/admin/pay-channel`：六键状态（掩码读 —— 私钥仅指纹；policy P8 任意已认证角色）。
   */
  @Get('admin/pay-channel')
  async getAdminPayChannel(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc('GET', '/api/admin/pay-channel', null, res, headersOf(req));
  }

  /**
   * `PUT /api/admin/pay-channel/:key`：写/覆盖（policy P-c1 **仅 super_admin**）。body 逐字
   * 透传（value 校验的单一真源在 config-service）。
   *
   * R75 一族：`:key` 是**路径参数** ⇒ 与 `admin/config/:key` 同规——拼进下游 URL 前先编码
   *（Express 已解码 ⇒ 不编码会把 `?`/`#` 之类拼成查询串 = N3 查询走私）。
   * ⚠️ 键的合法性（六键注册表）**不在网关判** —— config-service 对**解码后**的键做注册表
   * 白名单校验（未知键 400 不落库；键集单一真源 = protocol 的 `PAY_CHANNEL_KEYS`）。
   */
  @Put('admin/pay-channel/:key')
  async putAdminPayChannel(
    @Param('key') key: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToConfigSvc(
      'PUT',
      `/api/admin/pay-channel/${encodeURIComponent(key)}`,
      body,
      res,
      headersOf(req),
    );
  }

  /**
   * `DELETE /api/admin/pay-channel/:key`：清空（policy P-c2 **仅 super_admin**；幂等 ——
   * 行不存在也 200，语义在下游）。无 body（契约 §2.4 第三行「—」）；`:key` 编码同 PUT。
   */
  @Delete('admin/pay-channel/:key')
  async deleteAdminPayChannel(@Param('key') key: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'DELETE',
      `/api/admin/pay-channel/${encodeURIComponent(key)}`,
      null,
      res,
      headersOf(req),
    );
  }

  // 通知通道管理化 T8（规格 §2.4 / §4）：通知通道管理三端点（下游 = **config-service**；
  // T6 已就绪）。授权 = 网关 policy **P-n1/P-n2**（写面仅 super_admin）+ GET 落 P8（任意
  // 已认证角色）—— 本控制器只做「路由 + 路径参数编码（R75）+ 转发形状」。命名刻意避开
  // `/api/admin/config/*`（P4 前缀陷阱：九键不在 CONFIG_KEYS，误落 config 面会在下游 400）。

  /**
   * `GET /api/admin/notify-channel`：九键状态（掩码读 —— 密键 value 恒 null + 指纹，
   * URL 三键附 hint；policy P8 任意已认证角色）。
   */
  @Get('admin/notify-channel')
  async getAdminNotifyChannel(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc('GET', '/api/admin/notify-channel', null, res, headersOf(req));
  }

  /**
   * `PUT /api/admin/notify-channel/:key`：写/覆盖（policy P-n1 **仅 super_admin**）。body 逐字
   * 透传（value 校验的单一真源在 config-service）。
   *
   * R75 一族：`:key` 是**路径参数** ⇒ 与 `admin/config/:key` 同规——拼进下游 URL 前先编码
   *（Express 已解码 ⇒ 不编码会把 `?`/`#` 之类拼成查询串 = N3 查询走私）。
   * ⚠️ 键的合法性（九键注册表）**不在网关判** —— config-service 对**解码后**的键做注册表
   * 白名单校验（未知键 400 不落库；键集单一真源 = protocol 的 `NOTIFY_CHANNEL_KEYS`）。
   */
  @Put('admin/notify-channel/:key')
  async putAdminNotifyChannel(
    @Param('key') key: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToConfigSvc(
      'PUT',
      `/api/admin/notify-channel/${encodeURIComponent(key)}`,
      body,
      res,
      headersOf(req),
    );
  }

  /**
   * `DELETE /api/admin/notify-channel/:key`：清空（policy P-n2 **仅 super_admin**；幂等 ——
   * 行不存在也 200，语义在下游）。无 body（契约 §2.4 第三行「—」）；`:key` 编码同 PUT。
   */
  @Delete('admin/notify-channel/:key')
  async deleteAdminNotifyChannel(@Param('key') key: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'DELETE',
      `/api/admin/notify-channel/${encodeURIComponent(key)}`,
      null,
      res,
      headersOf(req),
    );
  }

  // 广告片 T8（规格 §2.3）：广告回调密钥管理三端点（下游 = **config-service**；
  // T6/T7 已就绪）。授权 = 网关 policy **P-a1/P-a2**（写面仅 super_admin）+ GET 落 P8
  //（任意已认证角色）—— 本控制器只做「路由 + 路径参数编码（R75）+ 转发形状」。
  // 命名刻意避开 `/api/admin/config/*`（P4 前缀陷阱：唯一键 `ad.callbackSecret` 不在
  // CONFIG_KEYS（第四键空间），误落 config 面会在下游 400）。

  /**
   * `GET /api/admin/ad-channel`：唯一键状态（掩码读 —— 本空间全密键 ⇒ value 恒 null +
   * 指纹；**无 `/status` 后缀**；policy P8 任意已认证角色）。
   */
  @Get('admin/ad-channel')
  async getAdminAdChannel(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc('GET', '/api/admin/ad-channel', null, res, headersOf(req));
  }

  /**
   * `PUT /api/admin/ad-channel/:key`：写/覆盖（policy P-a1 **仅 super_admin**）。body 逐字
   * 透传（value 校验的单一真源在 config-service）。
   *
   * R75 一族：`:key` 是**路径参数** ⇒ 与 `admin/config/:key` 同规——拼进下游 URL 前先编码
   *（Express 已解码 ⇒ 不编码会把 `?`/`#` 之类拼成查询串 = N3 查询走私）。
   * ⚠️ 键的合法性（唯一键注册表）**不在网关判** —— config-service 对**解码后**的键做注册表
   * 白名单校验（未知键 400 不落库；键集单一真源 = protocol 的 `AD_CHANNEL_KEYS`）。
   */
  @Put('admin/ad-channel/:key')
  async putAdminAdChannel(
    @Param('key') key: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToConfigSvc(
      'PUT',
      `/api/admin/ad-channel/${encodeURIComponent(key)}`,
      body,
      res,
      headersOf(req),
    );
  }

  /**
   * `DELETE /api/admin/ad-channel/:key`：清空（policy P-a2 **仅 super_admin**；幂等 ——
   * 行不存在也 200，语义在下游）。无 body（T6 端点契约无该入参）；`:key` 编码同 PUT。
   */
  @Delete('admin/ad-channel/:key')
  async deleteAdminAdChannel(@Param('key') key: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'DELETE',
      `/api/admin/ad-channel/${encodeURIComponent(key)}`,
      null,
      res,
      headersOf(req),
    );
  }

  // Records routes（记录片 T6 / I1；设计 D4）

  /**
   * `GET /api/records/mine`：「我的历史战绩」（**只本人**——`X-User-Id` 由本网关验签后
   * 注入、下游等值写死）。**不进公开白名单 = 默认验签**（I1 行）。
   *
   * ⚠️ **首次 GET query 透传**（本仓此前无一条 GET query 先例）：按 R75 查询走私纪律走
   * `recordsQueryOf()` —— 白名单 `cursor`/`limit` + `mode`/`from`/`to`（P1-6 筛选）+
   * 每值 `encodeURIComponent` 后再拼下游 URL。`cursor` 是下游（user-service）的
   * **不透明串**，这里只做编码、不解析。
   */
  @Get('records/mine')
  async getMyRecords(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'GET',
      `/api/records/mine${recordsQueryOf(req)}`,
      null,
      res,
      headersOf(req),
    );
  }

  // Currency routes（货币片 T7 / 规格 §2.13；设计 §4.5；广告片 T15 改写 wallet/relief：旧 POST 退役 → GET 查询）

  /**
   * `GET /api/wallet/balance`：玩家余额（**只本人**——`X-User-Id` 由本网关验签后注入、
   * 下游等值取用）。**不进公开白名单 = 默认验签**（§2.13 表逐字）；`X-Internal-Token`
   * 由 `headersOf()` 随每一跳注入（N7 纪律）。
   */
  @Get('wallet/balance')
  async getWalletBalance(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      '/api/wallet/balance',
      null,
      res,
      headersOf(req),
    );
  }

  /**
   * `GET /api/wallet/relief[?claim=]`：救助查询（广告片 T15 / 规格 §2.5 逐字）——
   * 形态照上一条 `GET /api/wallet/balance`（同族）：**只本人**（`X-User-Id` 由本网关
   * 验签后注入、下游等值取用）；**不进公开白名单 = 默认验签**；`X-Internal-Token` 由
   * `headersOf()` 随每一跳注入（N7 纪律）。
   *
   * ⚠️ **旧 `POST /api/wallet/relief`（② 金币场 T9）已随广告片退役**：本路由不再注册
   * （POST 打到同路径 ⇒ 404）；**发放唯一入口 = 广告回调**（`/ad/notify/*`）。本 GET
   * 不发放——无 claim = 裁决 + eligible 时签发/复用凭证；携 claim = 轮询只读。
   *
   * query 透传照 R75 纪律（`records/mine` 先例）：白名单恰好 `claim` 一键（其余键一律
   * 丢弃——查询走私纪律）；判定次序/五态/reason 文案的单一真源在 currency-service
   * （`wallet.controller.ts`），状态码随下游响应经 `@Res()` 透传。
   */
  @Get('wallet/relief')
  async getWalletRelief(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      `/api/wallet/relief${whitelistedQueryOf(req, RELIEF_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /**
   * 记牌器收费片：`GET /api/card-counter/status`（本人权益只读）与
   * `POST /api/card-counter/purchase`（单局卡/包时卡购买）。
   * 两条都**默认验签**（不进公开白名单）；`X-User-Id`/`X-Internal-Token` 由 `headersOf()` 注入。
   */
  @Get('card-counter/status')
  async getCardCounterStatus(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      '/api/card-counter/status',
      null,
      res,
      headersOf(req),
    );
  }

  @Post('card-counter/purchase')
  @HttpCode(200)
  async purchaseCardCounter(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'POST',
      '/api/card-counter/purchase',
      body,
      res,
      headersOf(req),
    );
  }

  /**
   * `POST /api/admin/wallet/adjust`：管理调整（body 透传照 `PUT /api/admin/config/:key`
   * 先例）。本网关**不**解析/校验 body —— 契约的单一真源在 currency-service
   * （`actionId` 缺省、delta 域、reason 1..200 全在下游判）。
   *
   * `@HttpCode(200)`：POST 的 Nest 缺省是 201；下游成功/重放都按 200（与 `admin/login` 同形注释）。
   */
  @Post('admin/wallet/adjust')
  @HttpCode(200)
  async adminAdjustWallet(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'POST',
      '/api/admin/wallet/adjust',
      body,
      res,
      headersOf(req),
    );
  }

  /**
   * `GET /api/admin/wallet/accounts/:userId`：管理查账（读源 = 下游的 MySQL 直读）。
   *
   * R75 一族：`:userId` 是**路径参数** ⇒ 拼进下游 URL 前先编码（照 `:key` 先例）。
   * ⚠️ 字符集**不在网关判**：§2.6 明确 path userId 不做预检——任何字符串都只是
   * 「查这个 ownerId」，未开户即空态 200（单一真源在下游控制器）。
   */
  @Get('admin/wallet/accounts/:userId')
  async adminWalletAccounts(@Param('userId') userId: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      `/api/admin/wallet/accounts/${encodeURIComponent(userId)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /**
   * `GET /api/admin/users/lookup?phone=`：管理手机号查询 —— 下游在 **user-service**
   * （§2.13 表第四行：这是本组四条里唯一一条打到 user-service 的）。
   * query 透传照 R75 纪律（`records/mine` 先例）：白名单恰好 `phone` 一键 + 编码后拼装。
   */
  @Get('admin/users/lookup')
  async adminUsersLookup(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'GET',
      `/api/admin/users/lookup${lookupQueryOf(req)}`,
      null,
      res,
      headersOf(req),
    );
  }

  // ③ T5：管理面新路由（规格 §2.10「路由登记」）—— 账号管理 / 审计读口 / 财务读口 /
  // 冲正 / 对账 / 用户详情。授权矩阵在 `AdminAuthMiddleware`（policy 单点）；本控制器只做
  // 「路由 + query 白名单 + 转发形状」。⚠️ 下游 handler 在 T6/T9 之前未落地（转发 404 属预期）。
  //
  // ⚠️ 声明顺序：`admin/users/lookup`（上一段）**必须先于** `admin/users/:userId` 注册 ——
  // Express 按注册顺序匹配，`lookup` 被 `:userId` 抢先会得到同形路径但**丢掉 phone query**
  // （单一真源：本文件 —— `gateway.controller.test.ts` 的真 app 用例钉住顺序）。

  /**
   * `GET /api/admin/accounts`：账号列表（**super_admin**，policy P1）。不分页（⚙️10），
   * query 白名单为**空**（⚙️9 修订版：任何键 ⇒ 400 —— 静默丢弃会把「筛过的」与
   * 「全量」混同）。
   */
  @Get('admin/accounts')
  async adminListAccounts(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'GET',
      `/api/admin/accounts${strictQueryOf(req, EMPTY_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /**
   * `POST /api/admin/accounts`：建号（**super_admin**，policy P2）。body 逐字透传
   * （形状/唯一键/口令策略的单一真源在 config-service）；`@HttpCode(200)` 与 `admin/login`
   * 同形（管理面统一 200）。
   */
  @Post('admin/accounts')
  @HttpCode(200)
  async adminCreateAccount(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc('POST', '/api/admin/accounts', body, res, headersOf(req));
  }

  /**
   * `PATCH /api/admin/accounts/:id`：改角色/状态/口令（**super_admin**，policy P3）。
   * R75 一族：`:id` 是路径参数 ⇒ 拼进下游 URL 前先编码（照 `:key` 先例）；形状（十进制
   * 整数等）不在网关判（单一真源在下游控制器）。
   */
  @Patch('admin/accounts/:id')
  async adminPatchAccount(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToConfigSvc(
      'PATCH',
      `/api/admin/accounts/${encodeURIComponent(id)}`,
      body,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/accounts/changes[.csv]`：账号变更留痕（读面全角色，policy P8）。 */
  @Get('admin/accounts/changes')
  async adminAccountChanges(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'GET',
      `/api/admin/accounts/changes${strictQueryOf(req, ACCOUNT_CHANGES_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/accounts/changes.csv')
  async adminAccountChangesCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'GET',
      `/api/admin/accounts/changes.csv${strictQueryOf(req, ACCOUNT_CHANGES_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/config/changes[.csv]`：配置变更留痕（policy P8）。 */
  @Get('admin/config/changes')
  async adminConfigChanges(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'GET',
      `/api/admin/config/changes${strictQueryOf(req, CONFIG_CHANGES_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/config/changes.csv')
  async adminConfigChangesCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'GET',
      `/api/admin/config/changes.csv${strictQueryOf(req, CONFIG_CHANGES_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/login-events[.csv]`：登录事件（policy P8）。 */
  @Get('admin/login-events')
  async adminLoginEvents(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'GET',
      `/api/admin/login-events${strictQueryOf(req, LOGIN_EVENTS_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/login-events.csv')
  async adminLoginEventsCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToConfigSvc(
      'GET',
      `/api/admin/login-events.csv${strictQueryOf(req, LOGIN_EVENTS_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/wallet/ops[.csv]`：资金流水读口（经济面，policy P8；下游 currency-service）。 */
  @Get('admin/wallet/ops')
  async adminWalletOps(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      `/api/admin/wallet/ops${strictQueryOf(req, WALLET_OPS_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/wallet/ops.csv')
  async adminWalletOpsCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      `/api/admin/wallet/ops.csv${strictQueryOf(req, WALLET_OPS_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /**
   * `GET /api/admin/wallet/ops/:opId`：单笔 op 详情（policy P8）。**非列表端点** ——
   * query 静默丢弃（⚙️9 修订版）；R75 一族：`:opId` 编码后拼下游 URL。
   */
  @Get('admin/wallet/ops/:opId')
  async adminWalletOpDetail(@Param('opId') opId: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      `/api/admin/wallet/ops/${encodeURIComponent(opId)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/wallet/summary[.csv]`：汇总（policy P8）；主查询键 `groupBy`。 */
  @Get('admin/wallet/summary')
  async adminWalletSummary(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      `/api/admin/wallet/summary${strictQueryOf(req, WALLET_SUMMARY_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/wallet/summary.csv')
  async adminWalletSummaryCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      `/api/admin/wallet/summary.csv${strictQueryOf(req, WALLET_SUMMARY_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /**
   * `POST /api/admin/wallet/reverse`：冲正（**super_admin | finance**，policy P6）。
   * body 透传（`opId`/`reason` 域校验的单一真源在下游 §2.8）；`@HttpCode(200)` 照 adjust。
   */
  @Post('admin/wallet/reverse')
  @HttpCode(200)
  async adminWalletReverse(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'POST',
      '/api/admin/wallet/reverse',
      body,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/wallet/reconcile`：对账四字段（policy P8）；非列表端点 ⇒ query 静默丢弃。 */
  @Get('admin/wallet/reconcile')
  async adminWalletReconcile(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'GET',
      '/api/admin/wallet/reconcile',
      null,
      res,
      headersOf(req),
    );
  }

  /** `POST /api/admin/wallet/reconcile/run`：立即对账（**super_admin | finance**，policy P7）。 */
  @Post('admin/wallet/reconcile/run')
  @HttpCode(200)
  async adminWalletReconcileRun(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'POST',
      '/api/admin/wallet/reconcile/run',
      null,
      res,
      headersOf(req),
    );
  }

  /**
   * `GET /api/admin/users/:userId`：用户详情（policy P8；下游 **user-service** §2.9）。
   * ⚠️ 必须声明在 `admin/users/lookup`（上一段）**之后**（注册顺序即匹配顺序，见本段头注）。
   * R75 一族：`:userId` 编码后拼下游 URL；query 静默丢弃（非列表端点）。
   */
  @Get('admin/users/:userId')
  async adminUserDetail(@Param('userId') userId: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'GET',
      `/api/admin/users/${encodeURIComponent(userId)}`,
      null,
      res,
      headersOf(req),
    );
  }


  // ─── 玩家管理页（2026-10-22）──────────────────────────────────────────────
  // 授权在 policy P10–P13（super_admin|operator）；列表/过滤端点严格白名单，
  // 非列表端点（games）只认 limit；路径参数 R75 编码。

  /** `GET /api/admin/players`：玩家列表（policy P10）。 */
  @Get('admin/players')
  async adminPlayers(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'GET',
      `/api/admin/players${strictQueryOf(req, PLAYERS_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/players/:userId/games`：最近对局（policy P11）。 */
  @Get('admin/players/:userId/games')
  async adminPlayerGames(@Param('userId') userId: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'GET',
      `/api/admin/players/${encodeURIComponent(userId)}/games${strictQueryOf(req, ['limit'])}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `POST /api/admin/wallet/accounts/batch`：批量余额（policy P12）。 */
  @Post('admin/wallet/accounts/batch')
  @HttpCode(200)
  async adminWalletBatch(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToCurrencySvc(
      'POST',
      '/api/admin/wallet/accounts/batch',
      body,
      res,
      headersOf(req),
    );
  }

  /** `POST /api/admin/pay/players/summary`：批量充值汇总（policy P13）。 */
  @Post('admin/pay/players/summary')
  @HttpCode(200)
  async adminPayPlayersSummary(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'POST',
      '/api/admin/pay/players/summary',
      body,
      res,
      headersOf(req),
    );
  }

  // 风控 T7（规格 §2.9-4 / §2.8 四端点）：管理面风控路由（下游 = **user-service**，
  // T6 已落地）。授权在 policy P-r1..P-r4（`admin-policy.ts`，读三条在 P8 之前）；
  // 本控制器只做「路由 + query 白名单 + 路径参数编码 + 转发形状」。
  // ⚠️ 列表/过滤端点用**严格白名单**（未知键 ⇒ 400 借 10001「未知查询参数：<key>」——
  // 与下游 T6 控制器同句文案的**双层校验**：网关这层管 R75 走私面）；非列表端点
  //（users/:userId）维持静默丢弃。

  /** `GET /api/admin/risk/reviews`：审核队列列表（policy P-r1）。 */
  @Get('admin/risk/reviews')
  async adminRiskReviews(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'GET',
      `/api/admin/risk/reviews${strictQueryOf(req, RISK_REVIEWS_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/risk/users/:userId`：风控详情聚合（policy P-r2 前缀面）。R75：`:userId` 编码后拼下游 URL。 */
  @Get('admin/risk/users/:userId')
  async adminRiskUserDetail(@Param('userId') userId: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'GET',
      `/api/admin/risk/users/${encodeURIComponent(userId)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/risk/actions`：风控审计列表（policy P-r3 第一条精确）。 */
  @Get('admin/risk/actions')
  async adminRiskActions(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'GET',
      `/api/admin/risk/actions${strictQueryOf(req, RISK_ACTIONS_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/risk/actions.csv`：审计导出（policy P-r3 第二条精确；CSV 经 `forward` 字节保真透传）。 */
  @Get('admin/risk/actions.csv')
  async adminRiskActionsCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'GET',
      `/api/admin/risk/actions.csv${strictQueryOf(req, RISK_ACTIONS_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /**
   * `POST /api/admin/risk/actions`：五动作写面（policy P-r4）。body **逐字透传** ——
   * 五值白名单/reason 1..200/源态 409 的单一真源在下游（T6）；`@HttpCode(200)` 照
   * 管理面统一 200 的形态（成功/重放都 200）。
   */
  @Post('admin/risk/actions')
  @HttpCode(200)
  async adminRiskApplyAction(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc('POST', '/api/admin/risk/actions', body, res, headersOf(req));
  }

  /**
   * `DELETE /api/admin/risk/users/:userId/device-binding`：设备绑定片人工解绑（policy P-r5）。
   * 无 body；`:userId` 编码后拼下游 URL（照 P-r2 详情面 R75 同族）。下游 user-service 删绑行 +
   * DEL `risk:binding:{userId}` + 写 `device_unbind` 审计；无绑行借 11004 ⇒ 404。
   */
  @Delete('admin/risk/users/:userId/device-binding')
  @HttpCode(200)
  async adminRiskUnbindDevice(@Param('userId') userId: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToUserSvc(
      'DELETE',
      `/api/admin/risk/users/${encodeURIComponent(userId)}/device-binding`,
      null,
      res,
      headersOf(req),
    );
  }

  // 支付片 T12（规格 §2.4.2 / §2.7.2）：管理面支付路由（下游 = **payment-service**；
  // 授权 = 网关 policy **P-p1..P-p7** —— 读四条显式登记在 P8 之前、写三条 super_admin|finance）。
  // 本控制器只做「路由 + query 白名单 + 路径参数编码 + 转发形状」；业务/契约的单一真源在
  // payment-service 的 admin-pay.controller（双层严格白名单：未知键 ⇒ 400 借 10001）。
  // ⚠️ `.csv` 是**独立尾段**（`admin/pay/orders.csv` 与 `admin/pay/orders/:orderNo` 不同段面），
  // CSV 白名单 = JSON 版去 `cursor`（带上即 400）；详情/写端点维持静默丢弃。

  /** `GET /api/admin/pay/orders`：订单列表（keyset：`cursor` 仅 JSON 版；policy P-p1）。 */
  @Get('admin/pay/orders')
  async adminPayOrders(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/orders${strictQueryOf(req, PAY_ORDERS_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/pay/orders.csv`：订单导出（policy P-p1；CSV 经 `forward` 字节保真透传）。 */
  @Get('admin/pay/orders.csv')
  async adminPayOrdersCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/orders.csv${strictQueryOf(req, PAY_ORDERS_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/pay/orders/:orderNo`：订单详情（policy P-p1 前缀面）。R75：`:orderNo` 编码后拼下游 URL。 */
  @Get('admin/pay/orders/:orderNo')
  async adminPayOrderDetail(@Param('orderNo') orderNo: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/orders/${encodeURIComponent(orderNo)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/pay/refunds[.csv]` + `/:refundNo`：退款读三端点（policy P-p2）。 */
  @Get('admin/pay/refunds')
  async adminPayRefunds(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/refunds${strictQueryOf(req, PAY_REFUNDS_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/pay/refunds.csv')
  async adminPayRefundsCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/refunds.csv${strictQueryOf(req, PAY_REFUNDS_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/pay/refunds/:refundNo')
  async adminPayRefundDetail(@Param('refundNo') refundNo: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/refunds/${encodeURIComponent(refundNo)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /**
   * `POST /api/admin/pay/refunds/:refundNo/review`：退款审（policy P-p5；super_admin|finance）。
   * body **逐字透传**（action/note 校验的单一真源在 payment-service）。
   * ⚠️ approve 在服务端**就地**跑渠道退避表（最长约 12.6 分钟）——网关 5s 兜底超时
   * （`GATEWAY_UPSTREAM_TIMEOUT_MS`）会先掐断回 503/10007，而**服务端继续**；重审由 15009 兜底。
   */
  @Post('admin/pay/refunds/:refundNo/review')
  @HttpCode(200)
  async adminPayRefundReview(
    @Param('refundNo') refundNo: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToPaymentSvc(
      'POST',
      `/api/admin/pay/refunds/${encodeURIComponent(refundNo)}/review`,
      body,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/pay/withdrawals[.csv]` + `/:withdrawNo`：提现读三端点（policy P-p3）。 */
  @Get('admin/pay/withdrawals')
  async adminPayWithdrawals(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/withdrawals${strictQueryOf(req, PAY_WITHDRAWALS_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/pay/withdrawals.csv')
  async adminPayWithdrawalsCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/withdrawals.csv${strictQueryOf(req, PAY_WITHDRAWALS_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/pay/withdrawals/:withdrawNo')
  async adminPayWithdrawDetail(@Param('withdrawNo') withdrawNo: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/withdrawals/${encodeURIComponent(withdrawNo)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `POST /api/admin/pay/withdrawals/:withdrawNo/review`：提现审（policy P-p6；super_admin|finance）。 */
  @Post('admin/pay/withdrawals/:withdrawNo/review')
  @HttpCode(200)
  async adminPayWithdrawReview(
    @Param('withdrawNo') withdrawNo: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToPaymentSvc(
      'POST',
      `/api/admin/pay/withdrawals/${encodeURIComponent(withdrawNo)}/review`,
      body,
      res,
      headersOf(req),
    );
  }

  /** `POST /api/admin/pay/withdrawals/:withdrawNo/confirm`：登记打款（policy P-p7；super_admin|finance）。 */
  @Post('admin/pay/withdrawals/:withdrawNo/confirm')
  @HttpCode(200)
  async adminPayWithdrawConfirm(
    @Param('withdrawNo') withdrawNo: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToPaymentSvc(
      'POST',
      `/api/admin/pay/withdrawals/${encodeURIComponent(withdrawNo)}/confirm`,
      body,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/admin/pay/actions[.csv]`：审计第六源「支付处置」（policy P-p4 两条精确）。 */
  @Get('admin/pay/actions')
  async adminPayActions(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/actions${strictQueryOf(req, PAY_ACTIONS_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Get('admin/pay/actions.csv')
  async adminPayActionsCsv(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/admin/pay/actions.csv${strictQueryOf(req, PAY_ACTIONS_CSV_QUERY_KEYS)}`,
      null,
      res,
      headersOf(req),
    );
  }

  // 支付片 T13（规格 §2.4.1 / §2.7.2）：**玩家面**支付路由（下游 = **payment-service**；
  // 身份 = 用户 JWT —— `JwtMiddleware` 验签后注入 `X-User-Id`，本控制器随 `headersOf()`
  // 转发（照 `/api/wallet/*` 链路逐行）；**不注入任何管理头**——`AdminAuthMiddleware`
  // 在**所有**路径先剥客户端伪造的 `x-admin*`，管理头只可能出现在 `/api/admin/*` 的
  // 验真产物里）。写面限流（下单 10/分 · sync 30/分 · 申请各 5/分；用户维）在
  // `HttpRateLimitMiddleware`（§2.4.1 脚注；阈值/键 = `rate-limit.ts` 的 `PAY_*`）。
  // ⚠️ **路由次序**（§2.4.1 路由注册次序条）：静态段 `pay/orders/mine` 必须先于参数段
  // `pay/orders/:orderNo` 声明（Express 按注册顺序匹配）——`gateway.controller.test.ts`
  // 的真 app 用例钉住（`/mine` 带 query 转发，不得被 `:orderNo` 抢走且 query 静默丢弃）。

  /** `GET /api/pay/orders/mine`：我的订单（keyset；**只本人**——`X-User-Id` 注入）。 */
  @Get('pay/orders/mine')
  async payOrdersMine(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/pay/orders/mine${payMineQueryOf(req)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/pay/orders/:orderNo`：订单详情（不存在/非本人 ⇒ 下游 15002/404）。R75：`:orderNo` 编码后拼下游 URL。 */
  @Get('pay/orders/:orderNo')
  async payOrderDetail(@Param('orderNo') orderNo: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/pay/orders/${encodeURIComponent(orderNo)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `POST /api/pay/orders`：下单（成功 200；15008/10001/15001 的单一真源在下游）。 */
  @Post('pay/orders')
  @HttpCode(200)
  async payCreateOrder(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc('POST', '/api/pay/orders', body, res, headersOf(req));
  }

  /** `POST /api/pay/orders/:orderNo/sync`：主动查询补单（同详情响应形）。 */
  @Post('pay/orders/:orderNo/sync')
  @HttpCode(200)
  async paySyncOrder(@Param('orderNo') orderNo: string, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'POST',
      `/api/pay/orders/${encodeURIComponent(orderNo)}/sync`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `GET /api/pay/wallet/summary`：钱包摘要（余额/可离场额度/当日剩余可申；只本人）。 */
  @Get('pay/wallet/summary')
  async payWalletSummary(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc('GET', '/api/pay/wallet/summary', null, res, headersOf(req));
  }

  /** `POST /api/pay/refunds`：申请退款（申请即冻结；15002/15006；body 逐字透传）。 */
  @Post('pay/refunds')
  @HttpCode(200)
  async payRefundApply(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc('POST', '/api/pay/refunds', body, res, headersOf(req));
  }

  /** `GET /api/pay/refunds/mine`：我的退款（keyset；只本人）。 */
  @Get('pay/refunds/mine')
  async payRefundsMine(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/pay/refunds/mine${payMineQueryOf(req)}`,
      null,
      res,
      headersOf(req),
    );
  }

  /** `POST /api/pay/withdrawals`：申请提现（15003/15004/15005；body 逐字透传）。 */
  @Post('pay/withdrawals')
  @HttpCode(200)
  async payWithdrawApply(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc('POST', '/api/pay/withdrawals', body, res, headersOf(req));
  }

  /** `GET /api/pay/withdrawals/mine`：我的提现（keyset；只本人）。 */
  @Get('pay/withdrawals/mine')
  async payWithdrawalsMine(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToPaymentSvc(
      'GET',
      `/api/pay/withdrawals/mine${payMineQueryOf(req)}`,
      null,
      res,
      headersOf(req),
    );
  }

  // Room routes
  @Get('rooms')
  async getRooms(@Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToRoomSvc(
      'GET',
      `/api/rooms${roomsQueryOf(req)}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Post('rooms')
  async createRoom(@Body() body: unknown, @Res() res: any, @Req() req: any) {
    return this.proxyGateway.forwardToRoomSvc('POST', '/api/rooms', body, res, headersOf(req));
  }

  @Post('rooms/:code/join')
  async joinRoom(
    @Param('code') code: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToRoomSvc(
      'POST',
      `/api/rooms/${encodeURIComponent(this.requireRoomCode(code))}/join`,
      body,
      res,
      headersOf(req),
    );
  }

  // Game routes
  //
  // N5（R137）：`POST /api/games` **不是**客户端路由（§7.1 的路由表里没有它）——
  // 开局由 room-service 服务间调用（P1 的全局中间件要求 `X-Internal-Token`）。
  // S5（R136）：`POST /api/robots/create` 同理（§9.6：只由 room-service 调）。
  // S4（R135）：`POST /api/robots/move` 已经被**删除**（它接收客户端传来的整份
  //             `GameSession`，等于把三家手牌交给 AI，§9.5）。
  // ⚠️ 网关**不再代理 robot-service**（§4.1 的调用表里没有这条边）⇒
  //     `ProxyGateway.forwardToRobotSvc` 已随之删除。
  //
  // 本控制器**只有**对外契约里的路由表：`auth/*`、`config`、`admin/*`（片⑦ T10 起）、
  // `rooms`、`rooms/:code/join`、`games/:roomCode` 与其 bid/play/pass。
  // `/api/health` 与 `/api/health/live` 由 `HealthController` 提供（单一真源，见上面的 R294 说明）。

  /**
   * §7.1: kept for clients, but it must return **only the caller's trimmed view**.
   * The game-service route it proxies to builds a `PlayerView` for `X-User-Id`;
   * it must never return a full `GameSession` (deviations S2/S8).
   *
   * ⚠️ R76（P0 片）在此**被本片取代**，但它的理由仍然成立，只是换了一层：
   *  - 旧约束：网关**不得**在这一跳要求 `X-Internal-Token`，因为 `headersOf()`
   *    从不注入它 ⇒ 加了校验会让客户端全线 401；
   *  - 本片（N7）之后：`headersOf()` **每一跳**都注入它，因此下游 game-service
   *    的全局中间件**可以**（也正在）要求它；
   *  - 但**网关自身仍然不得**在这里校验 —— 网关是**边缘**，客户端必须能到达它
   *    （它自己负责验 JWT）。真正拦住「直连 3003 + 伪造 `X-User-Id`」的是**下游**。
   *
   * 换句话说：加中间件的正确落点是 game-service（已做），不是这里。
   */
  @Get('games/:roomCode')
  async getGame(
    @Param('roomCode') roomCode: string,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToGameSvc(
      'GET',
      `/api/games/${encodeURIComponent(this.requireRoomCode(roomCode))}`,
      null,
      res,
      headersOf(req),
    );
  }

  @Post('games/:roomCode/bid')
  async bid(
    @Param('roomCode') roomCode: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToGameSvc(
      'POST',
      `/api/games/${encodeURIComponent(this.requireRoomCode(roomCode))}/bid`,
      body,
      res,
      headersOf(req),
    );
  }

  @Post('games/:roomCode/play')
  async play(
    @Param('roomCode') roomCode: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToGameSvc(
      'POST',
      `/api/games/${encodeURIComponent(this.requireRoomCode(roomCode))}/play`,
      body,
      res,
      headersOf(req),
    );
  }

  @Post('games/:roomCode/pass')
  async pass(
    @Param('roomCode') roomCode: string,
    @Body() body: unknown,
    @Res() res: any,
    @Req() req: any,
  ) {
    return this.proxyGateway.forwardToGameSvc(
      'POST',
      `/api/games/${encodeURIComponent(this.requireRoomCode(roomCode))}/pass`,
      body,
      res,
      headersOf(req),
    );
  }

  /**
   * R75：路径参数的**第一道闸** —— 先判形状（不合法 → `10001`，不打下游），
   * 再由调用方 `encodeURIComponent` 编码（第二道）。
   *
   * 危险点在于：Express 已经对路径参数做过 `decodeURIComponent`，
   * `GET /api/games/ABC%3Fseat=1` 在控制器里看到的是 `ABC?seat=1` ——
   * **只**编码不校验的话，它会被原样拼成下游 URL 里的查询串（N3 查询走私），
   * 而 `ABC/123`、`../../etc`、超长串还会污染下游 URL 与 Redis 键名。
   */
  private requireRoomCode(raw: unknown): string {
    if (!isRoomCode(raw)) throw badParam('Invalid room code');
    return raw;
  }
}

/**
 * 记录片 T6（I1 / 设计 D4）+ P1-6（战绩筛选）：`GET /api/records/mine` 的 query
 * **白名单** —— `cursor`/`limit`（分页）+ `gameType`（多玩法 Task 5.0：缺省下游按
 * 斗地主）+ `mode`/`from`/`to` 筛选（与客户端 `fetchMyRecords` 及 user-service
 * `records.controller` 的入参逐字同套）。数组顺序即拼装顺序（确定性，便于断言与排障）。
 *
 * ⚠️ 未列键仍然**静默丢弃**（`whitelistedQueryOf` 的玩家面先例）：筛选值本身不在这里
 * 校验 —— `mode` 非法 / `from>to` 由 user-service 的锁内校验给 400（网关不做第二份规则）。
 */
const RECORDS_QUERY_KEYS = ['cursor', 'limit', 'gameType', 'mode', 'from', 'to'] as const;

/**
 * 多玩法（Task 5.0）：`GET /api/rooms` 的 query 白名单 —— 恰 `gameType` 一键。
 * 缺省不传 ⇒ 下游按 `doudizhu` 过滤（旧客户端零破坏）。
 */
const ROOMS_QUERY_KEYS = ['gameType'] as const;

/**
 * 货币片 T7（§2.13 表第四行）：`GET /api/admin/users/lookup` 的 query **白名单** ——
 * 恰好 `phone` 一键（它在 user-service 侧就是查询入参；其余键一律走私面）。
 */
const LOOKUP_QUERY_KEYS = ['phone'] as const;

/**
 * R75 一族（查询走私）的**唯一实现**：把请求 query **按白名单重编码**成下游 URL 的后缀。
 *
 * - 只透传 `keys` 列出的键：其余键（`?smuggle=1` 这类）一律**丢弃** —— 不吸附成下游参数；
 * - 每个值在此**重新** `encodeURIComponent` 后拼装：`req.query` 是 Express 的**解码产物**，
 *   其中值里的 `,`/`&`/`=`/`#`/空格等若以裸形态拼进下游 URL 即为查询走私
 *   （与 `PUT /api/admin/config/:key` 的路径参数同一条纪律，见其上方注释）；
 * - 数组形态取首元素（与 `headersOf` 对头部的取值口径一致）；非字符串/空串丢弃
 *   （缺省 = 第一页 / 无查询）。
 *
 * ⚠️ 本函数是 R75 家族的**唯一实现**——订正后的**实际调用点共五个**：`recordsQueryOf`
 * （records/mine）· `lookupQueryOf`（admin/users/lookup）· `payMineQueryOf`（pay/…/mine）·
 * `strictQueryOf`（③ T5 严格族）· `getWalletRelief` 内联（广告片 T15，`RELIEF_QUERY_KEYS`）：
 * **不得**再抄第二份白名单拼装——那就是给「一处补了校验、另一处漏了」留门（R462 同族的
 * 漂移形态；本条注释曾写「两个调用方」，随支付/③ T5/T15 落地陈旧）。
 */
function whitelistedQueryOf(req: any, keys: readonly string[]): string {
  const query = req?.query;
  if (!query || typeof query !== 'object') return '';
  const parts: string[] = [];
  for (const key of keys) {
    const raw = (query as Record<string, unknown>)[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || value.length === 0) continue;
    parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * ⚠️ 下游 `nextCursor` 的**内部编码必须是 URL 安全字母表**（服务端选 `base64url`）：
 * `+` 在查询串里会被解成空格，往返（客户端 → Express → 本函数 → 下游 Express）后不等值
 * —— 本函数两侧各一次解码/编码**不能**替它兜底。
 *
 * 导出以便单测直接钉住边界（与 `isRoomCode` 同一惯例）。
 */
export function recordsQueryOf(req: any): string {
  return whitelistedQueryOf(req, RECORDS_QUERY_KEYS);
}

/**
 * `GET /api/rooms` 的 query 后缀（多玩法 Task 5.0；白名单见 `ROOMS_QUERY_KEYS`）。
 * 导出以便单测直接钉住边界（同 `recordsQueryOf`）。
 */
export function roomsQueryOf(req: any): string {
  return whitelistedQueryOf(req, ROOMS_QUERY_KEYS);
}

/** `admin/users/lookup` 的 query 后缀（货币片 T7；白名单见 `LOOKUP_QUERY_KEYS`）。 */
export function lookupQueryOf(req: any): string {
  return whitelistedQueryOf(req, LOOKUP_QUERY_KEYS);
}

/**
 * 支付片 T13（§2.4.1 #4/#7/#9）：玩家 `mine` 列表的 query 白名单 —— 恰好 `cursor`/`limit`
 * 两键。口径**同 `records/mine`**（未列键**静默丢弃**）：玩家面列表先例如此；「未知键 ⇒
 * 400」是管理财务/审计面（③ T5 ⚙️9 修订版）的纪律，不扩散到玩家面。
 * `cursor` 是下游**不透明串**——本函数只编码、不解析（同 records 先例）。
 */
const PAY_MINE_QUERY_KEYS = ['cursor', 'limit'] as const;

/** `pay/…/mine` 的 query 后缀（支付片 T13；白名单见 `PAY_MINE_QUERY_KEYS`）。 */
export function payMineQueryOf(req: any): string {
  return whitelistedQueryOf(req, PAY_MINE_QUERY_KEYS);
}

/**
 * 广告片 T15（规格 §2.5）：`GET /api/wallet/relief` 的 query 白名单 —— 恰好 `claim`
 * 一键（轮询票据 nonce）。口径**同玩家面先例**（未列键**静默丢弃**，不 400——「未知键 ⇒
 * 400」是管理财务/审计面的纪律）；拼装经 `whitelistedQueryOf`（唯一实现），
 * `getWalletRelief` 内联调用（无独立 wrapper —— 白名单即唯一差异面）。
 */
const RELIEF_QUERY_KEYS = ['claim'] as const;

/**
 * ③ T5（⚙️9 修订版）：列表/过滤类端点的 query **白名单** —— 与 §2.5/§2.7 的过滤键逐字
 * 一致（顺序即拼装顺序）。
 *
 * ⚠️ 与既有端点（lookup/records）的差异：**未知键一律 400**（借码 10001「未知查询参数：<key>」），
 * 不是静默丢弃 —— 财务/审计面静默丢 `source` 会把「筛过的」与「全量」混同（误导性读数）。
 * 非列表新端点（ops/:opId、reconcile、users/:userId）与既有端点**维持静默丢弃**。
 */
const CONFIG_CHANGES_QUERY_KEYS = ['key', 'actor', 'from', 'to', 'cursor', 'limit'] as const;
const LOGIN_EVENTS_QUERY_KEYS = ['username', 'success', 'from', 'to', 'cursor', 'limit'] as const;
const ACCOUNT_CHANGES_QUERY_KEYS = ['targetId', 'actor', 'action', 'from', 'to', 'cursor', 'limit'] as const;
const WALLET_OPS_QUERY_KEYS = ['source', 'actor', 'ownerId', 'from', 'to', 'cursor', 'limit'] as const;
const WALLET_SUMMARY_QUERY_KEYS = ['from', 'to', 'groupBy'] as const;
/** accounts 列表：不分页（⚙️10）⇒ 白名单为**空**（任何键都是未知键）。 */
const EMPTY_QUERY_KEYS: readonly string[] = [];

/**
 * 风控 T7（规格 §2.9-4）：风控读口的 query 白名单 —— 逐条 = 规格点名键集
 *（`status/limit/cursor/userId/action/actor/from/to`）。与下游 T6 控制器**同套**
 *（键集与其 `REVIEWS_QUERY_KEYS`/`ACTIONS_QUERY_KEYS` 逐字相同；顺序即拼装顺序）。
 */
const RISK_REVIEWS_QUERY_KEYS = ['status', 'cursor', 'limit'] as const;
const RISK_ACTIONS_QUERY_KEYS = ['userId', 'action', 'actor', 'from', 'to', 'cursor', 'limit'] as const;

/**
 * 支付片 T12（规格 §2.4.2）：管理面支付读口的 query 白名单 —— 逐条 = 规格点名键集
 *（orders：`status/userId/from/to/cursor`；refunds/withdrawals：`status/userId`（无分页）；
 * actions：`from/to/actor`）。与下游 admin-pay.controller **同套**（键集逐字相同；顺序即拼装顺序）。
 */
const PAY_ORDERS_QUERY_KEYS = ['status', 'userId', 'from', 'to', 'cursor'] as const;
const PAY_REFUNDS_QUERY_KEYS = ['status', 'userId'] as const;
const PAY_WITHDRAWALS_QUERY_KEYS = ['status', 'userId'] as const;
const PAY_ACTIONS_QUERY_KEYS = ['from', 'to', 'actor'] as const;
/** 玩家管理页列表白名单（2026-10-22）。 */
const PLAYERS_QUERY_KEYS = ['q', 'status', 'online', 'activity', 'page', 'pageSize', 'sort'] as const;

/**
 * ⚙️9 修订版：`.csv` 变体白名单 = JSON 版**去掉 `cursor/limit`**（带上即 400）。
 * **派生**而不是各抄一份：两处手写会在「JSON 版加了一个新过滤键」时漂移
 * （CSV 少一个键 = 导出静默筛不全）。
 */
const WITHOUT_PAGING = (keys: readonly string[]): readonly string[] =>
  keys.filter((key) => key !== 'cursor' && key !== 'limit');

const CONFIG_CHANGES_CSV_QUERY_KEYS = WITHOUT_PAGING(CONFIG_CHANGES_QUERY_KEYS);
const LOGIN_EVENTS_CSV_QUERY_KEYS = WITHOUT_PAGING(LOGIN_EVENTS_QUERY_KEYS);
const ACCOUNT_CHANGES_CSV_QUERY_KEYS = WITHOUT_PAGING(ACCOUNT_CHANGES_QUERY_KEYS);
const WALLET_OPS_CSV_QUERY_KEYS = WITHOUT_PAGING(WALLET_OPS_QUERY_KEYS);
const WALLET_SUMMARY_CSV_QUERY_KEYS = WITHOUT_PAGING(WALLET_SUMMARY_QUERY_KEYS);
const RISK_ACTIONS_CSV_QUERY_KEYS = WITHOUT_PAGING(RISK_ACTIONS_QUERY_KEYS);
/** 支付 T12：orders 的 CSV 白名单去 `cursor`（refunds/withdrawals/actions 的 JSON 版本就无
 *  cursor/limit —— 其 CSV 白名单经同一派生即恒等，保持「一处派生」纪律不手抄）。 */
const PAY_ORDERS_CSV_QUERY_KEYS = WITHOUT_PAGING(PAY_ORDERS_QUERY_KEYS);
const PAY_REFUNDS_CSV_QUERY_KEYS = WITHOUT_PAGING(PAY_REFUNDS_QUERY_KEYS);
const PAY_WITHDRAWALS_CSV_QUERY_KEYS = WITHOUT_PAGING(PAY_WITHDRAWALS_QUERY_KEYS);
const PAY_ACTIONS_CSV_QUERY_KEYS = WITHOUT_PAGING(PAY_ACTIONS_QUERY_KEYS);

/**
 * ③ T5（⚙️9 修订版）**严格白名单**版 `whitelistedQueryOf`：先逐键检查，未知键 ⇒
 * 400 借 10001「未知查询参数：<key>」（逐字文案）；键全部合法后再走共用拼装/编码
 * （R75 查询走私纪律不重复实现）。
 *
 * 判定在**任何转发之前**（handler 第一句就是它）—— 400 的请求一个字节都不会打到下游。
 */
function strictQueryOf(req: any, keys: readonly string[]): string {
  const query = req?.query;
  if (!query || typeof query !== 'object') return '';
  for (const key of Object.keys(query)) {
    if (!keys.includes(key)) throw badParam(`未知查询参数：${key}`);
  }
  return whitelistedQueryOf(req, keys);
}

/** Pick up the headers the middleware injected so downstream services can trust them. */
function headersOf(req: any): DownstreamHeaders {
  const headers: DownstreamHeaders = {};
  const userId = req?.headers?.[USER_ID_HEADER];
  const traceId = req?.headers?.[TRACE_ID_HEADER];
  if (typeof userId === 'string') headers.userId = userId;
  if (typeof traceId === 'string') headers.traceId = traceId;

  // §5.2 规则 3（N7）：**每一跳**下游都注入内部 token。下游四个服务在全部业务路由上
  // 校验它（`/api/health` 豁免），因此「直连端口 + 伪造 `X-User-Id`」不再是可用通道。
  // 客户端无法伪造：`JwtMiddleware` 在边缘即拒掉自带该头的外部请求。
  const internalToken = process.env.INTERNAL_SERVICE_TOKEN;
  if (internalToken) headers.internalToken = internalToken;

  // 片⑦ T10（D6）：管理标记头。`AdminAuthMiddleware` 验完管理令牌后注入 `X-Admin: 1`
  // （并在验签**之前**剥掉客户端伪造值）—— 这里把它转成布尔字段交给 `forward()`
  // 映射回 `X-Admin: 1`。只认**恰好 `'1'`**（与下游 `XAdminGuard` 逐字同形）。
  const admin = req?.headers?.[ADMIN_HEADER];
  if (admin === '1') headers.admin = true;

  // ③ T5（§2.10 第 7 步）：管理身份两枚 —— 与 `admin` 同源（三枚一起由
  // `AdminAuthMiddleware` 在验签 + claims 校验 + policy **通过之后**注入；
  // 失败/拒绝路径上下游只会看到缺席）。`forward()` 映射回同名头。
  const adminActor = req?.headers?.[ADMIN_ACTOR_HEADER];
  if (typeof adminActor === 'string') headers.adminActor = adminActor;
  const adminRole = req?.headers?.[ADMIN_ROLE_HEADER];
  if (typeof adminRole === 'string') headers.adminRole = adminRole;

  const path: string = String(req?.originalUrl ?? req?.url ?? '').split('?')[0] ?? '';

  // ③ T5（§2.10「登录路径 clientIp 注入」）：仅 `POST /api/admin/login` 产出 ——
  // 值由网关**派生**（`requestClientIp`：socket → req.ip → 'unknown' + 可信表解析），
  // **不读**客户端自带的 `x-client-ip`（该头由 `AdminAuthMiddleware` 在所有路径先剥）。
  // R31 的 `X-Token-Jti` 纪律复刻：一条路径一份产出，不得扩散成第二条身份通道。
  if (isAdminLoginPath(path)) {
    headers.clientIp = requestClientIp(req);
  }

  // R31：`X-Token-Jti` **只**服务 `/api/auth/logout`；其他路径一律不带，
  // 免得它悄悄扩散成第二条身份通道。判定与中间件（注入侧）共用
  // `identity-headers.isLogoutPath`，两处不会漂移。
  const tokenJti = req?.headers?.[TOKEN_JTI_HEADER];
  if (isLogoutPath(path) && typeof tokenJti === 'string' && tokenJti.length > 0) {
    headers.tokenJti = tokenJti;
  }

  // P0-3：提现再认证链的两枚**路径限定**头（与 R31 同一条纪律 —— 一条路径一份产出，
  // 不得扩散成通用透传）。
  //  - `/api/auth/reauth`：user-service 的 `JwtAuthGuard` 要从 `Authorization` 提取 Bearer；
  //    其它路径已由 `JwtMiddleware` 验签并注入 `X-User-Id`，无需也不得再转发 token。
  //  - `POST /api/pay/withdrawals`：payment-service 的一次性票据头。
  if (isReauthPath(path)) {
    const authorization = req?.headers?.[AUTHORIZATION_HEADER];
    if (typeof authorization === 'string' && authorization.length > 0) {
      headers.authorization = authorization;
    }
  }
  if (isWithdrawApplyPath(path)) {
    const ticket = req?.headers?.[REAUTH_TICKET_HEADER];
    if (typeof ticket === 'string' && ticket.length > 0) {
      headers.reauthTicket = ticket;
    }
  }
  return headers;
}

import { Body, Controller, Get, Headers, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AuthService } from '../auth/auth.service';
import { UsersService } from './users.service';
import { RegisterDto, LoginDto, UpdateProfileDto, RefreshTokenDto } from './users.dto';
import { httpException, toHttpException } from '../http/errors';

/** 仅 `/api/auth/logout` 使用：网关把验签得到的 access token `jti` 传下来（Task 2 定义并注入）。 */
const TOKEN_JTI_HEADER = 'x-token-jti';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('auth/register')
  async register(@Body() dto: RegisterDto) {
    try {
      return { code: ErrCode.OK, data: await this.authService.register(dto) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    try {
      return { code: ErrCode.OK, data: await this.authService.login(dto) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /** §5.1：公开路径，凭 refresh token 换新的一对（轮换）。 */
  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshTokenDto) {
    try {
      return {
        code: ErrCode.OK,
        data: await this.authService.refresh(dto.refreshToken, dto.deviceId),
      };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /**
   * 提交 3：提现敏感操作再认证——客户端弹密码框，凭 access token + 登录密码换一次性票据。
   *
   *  - `@UseGuards(JwtAuthGuard)` → 从 access token 解出 userId（网关已注入 JWT 白名单）；
   *  - 请求体 `{ password: string }` → bcrypt.compare 校验；
   *  - 成功写 Redis `reauth:{userId}:{uuid}` TTL 300s，返回 `{ ticket: uuid }`；
   *  - 票据一次性消费（payment-service withdraw.apply 里 DEL 吃掉）。
   */
  @Post('auth/reauth')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async reauth(
    @Req() req: { user: { sub: string } },
    @Body() body: { password?: unknown },
  ) {
    if (typeof body?.password !== 'string' || body.password.length === 0) {
      throw httpException(ErrCode.BAD_PARAM, 'password is required');
    }
    try {
      return { code: ErrCode.OK, data: await this.authService.reauth(req.user.sub, body.password) };
    } catch (err) {
      throw toHttpException(err);
    }
  }

  /**
   * §5.1：登出删除**两个** jti。
   *
   * access 的 jti 由网关照常注入（`X-Token-Jti`，**仅这条路径**，见 Task 2 —— 它不进 §5.2
   * 的通用身份契约，也不下发客户端）；refresh 的 jti 从请求体里的 refreshToken 解出。
   */
  @Post('auth/logout')
  @HttpCode(200)
  async logout(
    @Headers(TOKEN_JTI_HEADER) accessJti: string | undefined,
    @Body() dto: Partial<RefreshTokenDto>,
  ) {
    if (!accessJti) throw httpException(ErrCode.UNAUTHENTICATED, 'missing access token');
    await this.authService.logout(accessJti, dto?.refreshToken);
    return { code: ErrCode.OK, data: null };
  }
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getMe(@Req() req: { user: { sub: string } }) {
    return { code: ErrCode.OK, data: await this.usersService.getMe(req.user.sub) };
  }

  @Put('me')
  async updateProfile(@Req() req: { user: { sub: string } }, @Body() dto: UpdateProfileDto) {
    await this.usersService.updateProfile(req.user.sub, dto);
    return { code: ErrCode.OK, data: null };
  }
}

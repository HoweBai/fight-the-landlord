import { Inject, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { ErrCode } from '@fight-the-landlord/protocol';
import { UsersRepository } from '../users/users.repository';
import { userRegistrationsTotal } from '../metrics/player.metrics';
import { RegisterDto, LoginDto } from '../users/users.dto';
import { TokenService, type TokenPair, REDIS } from './token.service';
import { DomainError } from '../http/errors';
import { ConfigCacheService } from '../config/config-cache.service';
import { DeviceBindingsService } from '../risk/device-bindings.service';
// ⚠️ **值导入**（DI 陷阱纪律）：上面两个类型同理 —— 类型导入会被擦除 ⇒ 真容器解析
// 构造参数时只见 undefined、启动即崩（单测直接 new、tsc 都看不见）。
import { CurrencyClient, CurrencyServiceError, TRANSPORT_FAILURE_MESSAGE } from '../currency/currency.client';

export interface AuthResult extends TokenPair {
  user: { id: string; phone: string; nickname: string | null };
}

/** reauth 一次性票据的 Redis key 拼法（唯一入口，勿在别处拼字符串）。 */
export const REAUTH_KEY_PREFIX = 'reauth:';
/** reauth 票据 TTL：5 分钟（一次提现申请的窗口）。 */
export const REAUTH_TTL_SECONDS = 300;

@Injectable()
export class AuthService {
  private readonly saltRounds = 10;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly tokens: TokenService,
    private readonly configCache: ConfigCacheService,
    private readonly currencyClient: CurrencyClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly deviceBindings: DeviceBindingsService,
  ) {}

  /**
   * 设备绑定闸（设备绑定片；总开关第 49 键默认关）：
   * 开关关 ⇒ 一步不进绑定服务（零行为变化）；开关开 ⇒ 委托 `DeviceBindingsService`
   * （无 deviceId 放行不绑 / 无绑定行静默首绑 / 不一致抛 `11005`）。
   */
  private async enforceDeviceBinding(userId: string, deviceId: string | undefined): Promise<void> {
    if (!this.configCache.deviceBindingEnabled()) return;
    await this.deviceBindings.checkOrBind(userId, deviceId);
  }

  /**
   * 注册（货币片 T6：接入规格 §2.7 / 设计 §4.4 的**先货币后落库**时序）。
   *
   * 1. 校验 / 重复预检（既有逻辑）；`userId = uuid`（既有生成点**提前**到发币之前 ——
   *    它是幂等锚 `signup:<userId>` 的组成部分，必须在这一步定下来）；
   * 2. `grant = configCache.signupGrant()`（缺失/坏值 ⇒ 0，见 getter；§2.8）；
   * 3. `grant > 0` ⇒ `currency.apply`（`actionId: signup:<userId>`、source `signup_grant`、
   *    `entries: [{ ownerId: userId, delta: grant }]`、`refId: userId`；**3s 超时/不重试**
   *    见 `currency.client.ts`）—— **任何失败（业务码/传输）⇒ 注册整体失败：503 + 10007
   *    信封、本地零行、重试干净**（⚙️8）；`grant = 0` ⇒ **一步都不进货币服务**（D4 原文）；
   * 4. 落 `users` 行（既有事务）。
   *
   * ⚠️ **顺序不得反过来**：先落库则发币失败会留下「有用户、无赠送」的**静默缺口**；
   * 先发币的唯一残余是「半程失败留下孤儿钱包」—— R1 登记的已知残余，有指标可观测，
   * 不做自动回收。重试幂等：`signup:<userId>` 恒定 ⇒ 同一次注册的任何重发不重复发币。
   * 🔴 **失败一律抛 `DomainError(UPSTREAM_UNAVAILABLE)`**（**不是**裸
   * `CurrencyServiceError`）：`toHttpException()` 只翻 `DomainError` 的码，裸错误会
   * 退化成 400 —— 那是「最像正确答案的错」（HTTP_STATUS 里 10007 ⇒ 503）。
   * 失败原因按「不透传 ≠ 不留痕」只进日志（warn 行），响应固定为 `10007` 信封。
   */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.usersRepo.findByPhone(dto.phone);
    if (existing) throw new DomainError(ErrCode.PHONE_TAKEN, '手机号已注册');

    const userId = randomUUID();
    const grant = this.configCache.signupGrant();
    if (grant > 0) {
      try {
        await this.currencyClient.apply({
          actionId: `signup:${userId}`,
          source: 'signup_grant',
          entries: [{ ownerId: userId, delta: grant }],
          refId: userId,
        });
      } catch (err) {
        const reason = err instanceof CurrencyServiceError ? `code=${err.code}` : String(err);
        this.logger.warn(`signup grant failed (userId=${userId}): ${reason}`);
        throw new DomainError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
      }
    }

    const user = await this.usersRepo.create({
      id: userId,
      phone: dto.phone,
      passwordHash: await bcrypt.hash(dto.password, this.saltRounds),
      nickname: dto.nickname.trim(),
      status: 'active' as const,
    });
    // 设备绑定片：新 userId 不可能已有绑定行 ⇒ 有 deviceId 即静默首绑（开关关则零操作）；
    // 放在签 token 之前——绑定闸不过不发令牌。
    await this.enforceDeviceBinding(user.id, dto.deviceId);
    // 玩家管理页（2026-10-22）：签发成功后才算注册成功。
    const issued = this.issue(user);
    userRegistrationsTotal.inc();
    return issued;
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.usersRepo.findByPhone(dto.phone);
    if (!user) throw new DomainError(ErrCode.USER_NOT_FOUND, '用户不存在');
    if (user.status === 'banned') throw new DomainError(ErrCode.USER_BANNED, '用户已被封禁');
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new DomainError(ErrCode.BAD_CREDENTIALS, '密码错误');
    }
    // 设备绑定片：密码 + 封禁校验之后、签 token 之前过设备闸（首登静默首绑 / 不一致 11005）。
    await this.enforceDeviceBinding(user.id, dto.deviceId);
    return this.issue(user);
  }

  /**
   * §5.1：refresh 轮换。失败一律 `10004`（调用方只暴露「令牌不可用」这一事实）。
   *
   * 设备绑定片：闸在轮换**成功之后**（rotate 的 DEL 是原子防重放硬闸，不可提前）。
   * 设备不一致 ⇒ 旧 refresh jti 已被本次轮换消费、新对不发出（= 偷走会话的一方烧掉落手
   * token 仍一无所获；绑定设备上的会话是另一个 jti，不受影响）。
   */
  async refresh(refreshToken: string, deviceId?: string): Promise<TokenPair> {
    const result = await this.tokens.rotate(refreshToken);
    if (!result.ok) throw new DomainError(ErrCode.TOKEN_EXPIRED, 'refresh token is not usable');
    await this.enforceDeviceBinding(result.userId, deviceId);
    return result.pair;
  }

  /** §5.1：登出删除两个 jti。refresh 与 access 不同属一次会话时只删能解析的那些。 */
  async logout(accessJti: string, refreshToken?: string): Promise<void> {
    await this.tokens.revoke(accessJti);
    if (refreshToken) {
      try {
        await this.tokens.revoke(this.tokens.verify(refreshToken, 'refresh').jti);
      } catch {
        // refresh token 已经不可用 → 目标状态已达成，不算失败
      }
    }
  }

  /**
   * 提现敏感操作再认证（提交 3）。
   *
   *  客户端拿到 access token 后，提现前弹密码框，调本方法验证登录密码：
   *  成功 → 写 Redis `reauth:{userId}:{uuid}` TTL 300s → 返回 `{ ticket: uuid }`；
   *  失败 → 抛 DomainError(BAD_CREDENTIALS)。
   *
   *  票据**一次性消费**——payment-service withdraw.apply 里用 `DEL` 吃掉。
   *  userId 已编入 Redis key，天然防跨用户串用。
   */
  async reauth(userId: string, password: string): Promise<{ ticket: string }> {
    const user = await this.usersRepo.findById(userId);
    if (!user) throw new DomainError(ErrCode.USER_NOT_FOUND, '用户不存在');
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new DomainError(ErrCode.BAD_CREDENTIALS, '密码错误');
    }
    const ticket = randomUUID();
    await this.redis.set(`${REAUTH_KEY_PREFIX}${userId}:${ticket}`, '1', 'EX', REAUTH_TTL_SECONDS);
    return { ticket };
  }

  /**
   * `GET /api/users/me` 的内容，**手工挑选字段**。
   *
   * 原先直接 `return this.usersRepo.findById(userId)` —— 那会把整个 `UserEntity`
   * （含 `passwordHash`）交给调用方。`passwordHash` 属于「永不出口」类字段，
   * 即使当前路由走的是 `UsersService.getMe`、这条路径不可达，也不留这个地雷。
   */
  async getMe(userId: string): Promise<{ id: string; phone: string; nickname: string | null } | null> {
    const user = await this.usersRepo.findById(userId);
    if (!user) return null;
    return { id: user.id, phone: user.phone, nickname: user.nickname };
  }

  private async issue(user: { id: string; phone: string; nickname: string | null }): Promise<AuthResult> {
    const pair = await this.tokens.issuePair({ id: user.id, phone: user.phone });
    return { ...pair, user: { id: user.id, phone: user.phone, nickname: user.nickname } };
  }
}

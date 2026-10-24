import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { ErrCode } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';

/** §5.1：access 2 小时 / refresh 7 天。 */
export const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export type TokenType = 'access' | 'refresh';

/** §5.1 的 `session:{jti}` 白名单键（唯一拼法，勿在别处拼字符串）。 */
export function sessionKey(jti: string): string {
  return `session:${jti}`;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TokenClaims {
  sub: string;
  phone: string;
  jti: string;
  typ: TokenType;
  iat: number;
  exp: number;
}

export const REDIS = 'REDIS';

/**
 * 令牌的签发、校验、轮换与吊销（§5.1）。
 *
 * 两张令牌**都**写入 `session:{jti}`（TTL = 该令牌的剩余有效期），因此都可被吊销。
 * refresh token 会被轮换：`rotate()` 先删旧 jti，再发新的一对。
 */
@Injectable()
export class TokenService {
  /**
   * 注意：计划原稿的第三个参数 `@Optional() @Inject('CLOCK') clock` 从未被读取，
   * 在 `tsconfig.base.json` 的 `noUnusedLocals` 下会让 `pnpm lint` 直接报
   * `TS6138: Property 'clock' is declared but its value is never read.`，因此删除。
   * 有效期由 `sign()` 逐次传入的 TTL 决定，不需要时钟注入点。
   */
  constructor(
    private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async issuePair(user: { id: string; phone: string }): Promise<TokenPair> {
    const access = this.sign(user, 'access', ACCESS_TOKEN_TTL_SECONDS);
    const refresh = this.sign(user, 'refresh', REFRESH_TOKEN_TTL_SECONDS);
    await Promise.all([
      this.redis.set(sessionKey(access.jti), '1', 'EX', ACCESS_TOKEN_TTL_SECONDS),
      this.redis.set(sessionKey(refresh.jti), '1', 'EX', REFRESH_TOKEN_TTL_SECONDS),
    ]);
    return { accessToken: access.token, refreshToken: refresh.token };
  }

  /** 校验签名与 `typ`。失败一律 `DomainError`（调用方翻成契约错误码）。 */
  verify(token: string, typ: TokenType): TokenClaims {
    let claims: TokenClaims;
    try {
      claims = this.jwt.verify(token) as TokenClaims;
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      throw new DomainError(
        name === 'TokenExpiredError' ? ErrCode.TOKEN_EXPIRED : ErrCode.TOKEN_INVALID,
        'Invalid or expired token',
      );
    }
    if (claims?.typ !== typ) {
      throw new DomainError(ErrCode.TOKEN_INVALID, `token typ must be "${typ}"`);
    }
    if (!claims.sub || !claims.jti) {
      throw new DomainError(ErrCode.TOKEN_INVALID, 'token is missing sub or jti');
    }
    return claims;
  }

  /**
   * 轮换（§5.1）：旧 refresh token 立即失效，返回新的一对。
   * 旧 jti 不在白名单 / 已过期 / typ 不对 → `ok: false`。
   */
  /**
   * 轮换（§5.1）：旧 refresh token 立即失效，返回新的一对。
   * 旧 jti 不在白名单 / 已过期 / typ 不对 → `ok: false`。
   *
   * ⚠️ 占用旧 jti 必须是**原子**的：`exists` + `del` 是 check-then-act，两个并发的
   * `refresh` 会双双通过存在性检查然后都发出一对新令牌 —— 「旧 refresh token 立即失效」
   * 就名存实亡了（重放窗口）。`DEL` 的返回值是「我删掉了几个」，因此谁拿到 `1`
   * 谁才是唯一的赢家，其余的（`0`）一律按已失效处理。
   */
  async rotate(
    refreshToken: string,
  ): Promise<{ ok: true; userId: string; pair: TokenPair } | { ok: false; code: ErrCode }> {
    let claims: TokenClaims;
    try {
      claims = this.verify(refreshToken, 'refresh');
    } catch (err) {
      return { ok: false, code: err instanceof DomainError ? err.code : ErrCode.TOKEN_INVALID };
    }

    const claimed = await this.redis.del(sessionKey(claims.jti));
    if (claimed !== 1) return { ok: false, code: ErrCode.TOKEN_EXPIRED };

    const pair = await this.issuePair({ id: claims.sub, phone: claims.phone });
    return { ok: true, userId: claims.sub, pair };
  }

  async revoke(jti: string): Promise<void> {
    await this.redis.del(sessionKey(jti));
  }

  async isActive(jti: string): Promise<boolean> {
    return (await this.redis.exists(sessionKey(jti))) === 1;
  }

  private sign(user: { id: string; phone: string }, typ: TokenType, ttl: number) {
    const jti = randomUUID();
    const token = this.jwt.sign({ sub: user.id, phone: user.phone, jti, typ }, { expiresIn: ttl });
    return { token, jti };
  }
}

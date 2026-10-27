import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import {
  AGENT_JWT_AUDIENCE,
  AGENT_JWT_SECRET_FALLBACK,
  AGENT_JWT_TYP,
  ErrCode,
} from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';
import { REDIS } from '../redis/redis.module';
import { hashPassword, verifyPassword } from './agent-password';
import { maskPhone, normalizePhone, toSafeInt } from './agent.util';
export const AGENT_JWT_TTL_SECONDS = 12 * 60 * 60;
export const AGENT_LOGIN_MAX_FAILURES = 5;
export const AGENT_LOGIN_FAIL_TTL_SECONDS = 300;

/**
 * 代理令牌密钥链：`AGENT_JWT_SECRET || JWT_SECRET || 兜底`。
 * ⚠️ `||` 不是 `??`（compose 空串透传 ⇒ 必须回落；与 admin middleware 同族）。
 * 两侧常量从 protocol 包编译时 import 保证逐字同值。
 */
export function agentJwtSecret(): string {
  return (
    process.env.AGENT_JWT_SECRET ||
    process.env.JWT_SECRET ||
    AGENT_JWT_SECRET_FALLBACK
  );
}

const LOGIN_SELECT_SQL =
  'SELECT `id`, `name`, `phone`, `password_hash`, `rate_bp`, `status`, `must_change_password`, ' +
  '`token_version` FROM `agent_accounts` WHERE `phone` = ?';
const BY_ID_SELECT_SQL =
  'SELECT `id`, `name`, `phone`, `rate_bp`, `status`, `must_change_password`, `token_version` ' +
  'FROM `agent_accounts` WHERE `id` = ?';
const PASSWORD_SELECT_BY_ID_SQL =
  'SELECT `id`, `password_hash` FROM `agent_accounts` WHERE `id` = ?';
const PASSWORD_UPDATE_SQL =
  'UPDATE `agent_accounts` SET `password_hash` = ?, `must_change_password` = 0, ' +
  '`token_version` = `token_version` + 1 WHERE `id` = ?';
const AUDIT_INSERT_SQL =
  'INSERT INTO `agent_admin_audit` (`actor`, `action`, `target_type`, `target_id`, `before_json`, `after_json`, `reason`) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?)';

export interface AgentLoginResult {
  token: string;
  expiresIn: number;
  agent: {
    id: string;
    name: string;
    phoneMasked: string;
    rateBp: number;
    status: string;
    mustChangePassword: boolean;
  };
}

/**
 * 代理门户认证（spec §8.1）：
 * - 按手机号失败计数（5 次/5 分钟）→ 429；成功清零；
 * - JWT `aud:'ftl-agent'` + `typ:'agent-access'` + `ver:token_version`；12h；
 * - 只允许 active/frozen（冻结仍可读+结算）；
 * - 改密/重置递增 `token_version` ⇒ 旧令牌（含本机其它会话）立即失效。
 */
@Injectable()
export class AgentAuthService {
  private readonly logger = new Logger(AgentAuthService.name);
  private readonly jwt = new JwtService({ secret: agentJwtSecret() });

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async login(input: { phone: string; password: string }): Promise<AgentLoginResult> {
    const phone = normalizePhone(input.phone);
    if (phone.length === 0 || typeof input.password !== 'string') {
      throw new DomainError(ErrCode.BAD_PARAM, '手机号或密码不能为空');
    }
    const key = `agent_login_fail:${phone}`;
    await this.assertNotLocked(key);
    const rows = (await this.dataSource.query(LOGIN_SELECT_SQL, [phone])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) {
      await this.recordFailure(key);
      throw new DomainError(ErrCode.BAD_CREDENTIALS, '手机号或密码不正确');
    }
    const row = rows[0]!;
    if (!(await verifyPassword(input.password, String(row.password_hash)))) {
      await this.recordFailure(key);
      throw new DomainError(ErrCode.BAD_CREDENTIALS, '手机号或密码不正确');
    }
    await this.clearFailures(key);
    const ver = toSafeInt(row.token_version, 'agent_accounts.token_version');
    const token = this.jwt.sign(
      {
        sub: String(row.id),
        phone,
        typ: AGENT_JWT_TYP,
        ver,
        jti: randomUUID(),
      },
      { expiresIn: AGENT_JWT_TTL_SECONDS, audience: AGENT_JWT_AUDIENCE },
    );
    return {
      token,
      expiresIn: AGENT_JWT_TTL_SECONDS,
      agent: {
        id: String(row.id),
        name: String(row.name),
        phoneMasked: maskPhone(phone),
        rateBp: toSafeInt(row.rate_bp, 'agent_accounts.rate_bp'),
        status: String(row.status),
        mustChangePassword: Number(row.must_change_password) === 1,
      },
    };
  }

  async changePassword(input: {
    agentId: string;
    oldPassword: string;
    newPassword: string;
  }): Promise<{ relogin: true }> {
    if (typeof input.newPassword !== 'string' || input.newPassword.length < 6 || input.newPassword.length > 64) {
      throw new DomainError(ErrCode.BAD_PARAM, '新密码必须 6–64 字符');
    }
    const rows = (await this.dataSource.query(PASSWORD_SELECT_BY_ID_SQL, [
      input.agentId,
    ])) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new DomainError(ErrCode.UNAUTHENTICATED, '代理不存在');
    const row = rows[0]!;
    if (!(await verifyPassword(input.oldPassword, String(row.password_hash)))) {
      throw new DomainError(ErrCode.BAD_CREDENTIALS, '原密码不正确');
    }
    const hash = await hashPassword(input.newPassword);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(PASSWORD_UPDATE_SQL, [hash, input.agentId]);
      await manager.query(AUDIT_INSERT_SQL, [
        input.agentId,
        'agent.password.change',
        'agent',
        input.agentId,
        null,
        JSON.stringify({ mustChangePassword: false }),
        null,
      ]);
    });
    return { relogin: true };
  }

  async getById(agentId: string): Promise<{
    id: string;
    name: string;
    phone: string;
    rateBp: number;
    status: string;
    mustChangePassword: boolean;
  } | null> {
    const rows = (await this.dataSource.query(BY_ID_SELECT_SQL, [agentId])) as Array<
      Record<string, unknown>
    >;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: String(r.id),
      name: String(r.name),
      phone: String(r.phone),
      rateBp: toSafeInt(r.rate_bp, 'agent_accounts.rate_bp'),
      status: String(r.status),
      mustChangePassword: Number(r.must_change_password) === 1,
    };
  }

  private async assertNotLocked(key: string): Promise<void> {
    try {
      const raw = await this.redis.get(key);
      if (raw !== null && Number(raw) >= AGENT_LOGIN_MAX_FAILURES) {
        throw new DomainError(ErrCode.RATE_LIMITED, '尝试次数过多，请稍后再试');
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
      this.logger.warn(`agent login fail-counter read failed: ${String(err)}`);
      throw new DomainError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试');
    }
  }

  private async recordFailure(key: string): Promise<void> {
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, AGENT_LOGIN_FAIL_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`agent login fail-counter write failed: ${String(err)}`);
    }
  }

  private async clearFailures(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(`agent login fail-counter clear failed: ${String(err)}`);
    }
  }
}

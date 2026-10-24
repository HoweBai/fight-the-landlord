import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toEpochMs, toSafeInt } from './admin-accounts.service';
import { buildListSql, nextCursorOf, type ListResult } from './admin-changes.service';

/**
 * 登录事件落行（规格 §2.3 / ⚙️3；判据 C6 的落行半边）+ 读口（§2.5；判据 C16 的三分之一）。
 *
 * 三条纪律：
 *  - **只落「形状合法」的尝试**（处理序 ④–⑦ 分支）：形状 400 与启用 404 **不落行**
 *    （⚙️3：形状错不是凭据尝试；防灌行）——调用点在 `admin.controller.ts` 登录处理器里逐字对位；
 *  - `account_id` 仅在查行**命中后**回填（④ miss ⇒ NULL；⑤⑥⑦ 回填）；
 *  - `ip` = 请求头 `x-client-ip`（网关注入，§2.10；直接访问本服务时通常缺失）——
 *    **缺失 / 空串 / 超 64 字符 ⇒ NULL，不伪造**（列宽 64 = 迁移 `1789900000000`）。
 */

/**
 * 网关注入的客户端 IP 头名（网关 `identity-headers.ts` 是它的真源；两处各定义一次是本仓
 * 既有惯例——同 `ADMIN_HEADER` / `ADMIN_ACTOR_HEADER`，由 T5 的网关测试与 C9 在真拓扑上钉住）。
 */
export const CLIENT_IP_HEADER = 'x-client-ip';

/** `admin_login_events.ip` 列宽（迁移 `1789900000000`：`varchar(64)`）。 */
export const LOGIN_EVENT_IP_MAX_LENGTH = 64;

export const LOGIN_EVENT_INSERT_SQL =
  'INSERT INTO admin_login_events (username, account_id, ip, success) VALUES (?, ?, ?, ?)';

/** 列表基句（§2.5 行形状）。 */
export const LOGIN_EVENTS_SELECT_BASE =
  'SELECT id, username, account_id, ip, success, created_at FROM admin_login_events';

/** 登录事件（`success` 用 boolean 语义入参；落库转 `tinyint(1)` 的 1/0）。 */
export interface LoginEventInput {
  /** 小写**归一后**的尝试用户名（未知账号也记归一值——§2.3-③④）。 */
  username: string;
  /** 查行命中后回填；未知用户名 ⇒ `null`（§2.3-④）。 */
  accountId: number | null;
  /** `x-client-ip` 头原值；缺失 ⇒ `undefined`（归一为 NULL 由本服务负责）。 */
  ip: string | undefined;
  success: boolean;
}

/** IP 归一：缺失 / 空串 / 超 64 ⇒ `null`（「不伪造」——宁缺勿造，也不截断）。 */
export function normalizeClientIp(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > LOGIN_EVENT_IP_MAX_LENGTH) {
    return null;
  }
  return raw;
}

/** 读口过滤（已由 controller 校验；`success` 为数字 0|1——tinyint 直比）。 */
export interface LoginEventsFilter {
  username?: string;
  success?: 0 | 1;
  from?: number; // epoch ms；`created_at >= from`（含边界）
  to?: number; // epoch ms；`created_at < to`（不含边界）
}

/** 行形状逐字 = §2.5 表（`accountId`/`ip` 可 null；`success` 出站为**布尔**）。 */
export interface LoginEventView {
  id: number;
  username: string;
  accountId: number | null;
  ip: string | null;
  success: boolean;
  createdAt: number;
}

interface RawLoginEventRow {
  id: unknown;
  username: unknown;
  account_id: unknown;
  ip: unknown;
  success: unknown;
  created_at: unknown;
}

function toLoginEventView(row: RawLoginEventRow): LoginEventView {
  return {
    id: toSafeInt(row.id, 'admin_login_events.id'),
    username: String(row.username),
    accountId:
      row.account_id === null || row.account_id === undefined
        ? null
        : toSafeInt(row.account_id, 'admin_login_events.account_id'),
    ip: row.ip === null || row.ip === undefined ? null : String(row.ip),
    // tinyint(1) 的驱动回值 = 数字 0|1（mysql2 默认不做布尔转换）⇒ 出站转 boolean
    success: toSafeInt(row.success, 'admin_login_events.success') === 1,
    createdAt: toEpochMs(row.created_at, 'admin_login_events.created_at'),
  };
}

@Injectable()
export class LoginEventsService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /** 落一行登录事件（裸 SQL；表在 `src/migrations/1789900000000-AdminRbac.ts`）。 */
  async record(event: LoginEventInput): Promise<void> {
    await this.dataSource.query(LOGIN_EVENT_INSERT_SQL, [
      event.username,
      event.accountId,
      normalizeClientIp(event.ip),
      event.success ? 1 : 0,
    ]);
  }

  /** `GET /api/admin/login-events`（§2.5；keyset 组装与 nextCursor 口径同三读口统一实现）。 */
  async list(
    filter: LoginEventsFilter,
    cursor: number | null,
    limit: number | null,
  ): Promise<ListResult<LoginEventView>> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.username !== undefined) {
      conds.push('username = ?');
      params.push(filter.username);
    }
    if (filter.success !== undefined) {
      conds.push('success = ?');
      params.push(filter.success);
    }
    if (filter.from !== undefined) {
      conds.push('created_at >= ?');
      params.push(new Date(filter.from));
    }
    if (filter.to !== undefined) {
      conds.push('created_at < ?');
      params.push(new Date(filter.to));
    }
    if (cursor !== null) {
      conds.push('id < ?');
      params.push(cursor);
    }
    if (limit !== null) params.push(limit);

    const rows = (await this.dataSource.query(
      buildListSql(LOGIN_EVENTS_SELECT_BASE, conds, limit),
      params,
    )) as RawLoginEventRow[];
    const mapped = rows.map(toLoginEventView);
    return { rows: mapped, nextCursor: nextCursorOf(mapped, limit) };
  }
}

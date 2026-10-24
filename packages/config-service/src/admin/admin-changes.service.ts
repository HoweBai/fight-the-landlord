import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toEpochMs, toSafeInt } from './admin-accounts.service';

/**
 * 配置/账号留痕的**读写收口**（规格 §2.5/§2.6；判据 C14〔读半边〕/C15/C16/C22 的 config-service 侧）。
 *
 *  - **写**（§2.6，`platform-config.service.ts` 的 `set()` 事务消费）：锁定读 + 留痕写两条裸 SQL
 *    作为常量活在这里 —— 只有一份实现、`CONFIG_LOCK_SQL` 全文被单测钉（照 `reconcile.service.ts`
 *    先例：改一个字符当场红）。
 *  - **读**（§2.5）：`config_changes` / `admin_account_changes` 两表 keyset 查询
 *    （`ORDER BY id DESC` + `id < cursor`；`nextCursor = rows.length===limit ? 末行 id : null`，
 *    ⚙️18 **不做存在性预查**；`limit=null` ⇒ 无 LIMIT 的 CSV 全量形态）。
 *
 * 访问形态 = **裸 SQL**（同 T2 的 `admin-accounts.service.ts`：锁定读要能被全文钉、管理小表不值
 * 一张 entity 映射）。行时间一律 `toEpochMs`（⚙️1）；过滤值长度/型别由 controller 先自查
 * （超列宽 ⇒ 400，不给 SQL 层留意外路径）。
 */

/**
 * 锁定读（§2.6 序① 逐字；v1.1.6：`key` 为 MySQL **保留字**，标识符必须反引号——旧稿裸写
 * `WHERE key=?` 在真栈 ER_PARSE_ERROR 1064、配置 PUT 全 500（假库单测遮蔽，T10 真栈联测抓获））：
 * 锁住该键行直到事务结束（并发同键写被串行化）。无行 ⇒ 空集 ⇒ `old=NULL` + 走既有无行插入分支。
 * **全文被单测钉**。
 */
export const CONFIG_LOCK_SQL =
  'SELECT value, version FROM platform_config WHERE `key`=? FOR UPDATE';

/**
 * 留痕写（§2.6 序③ 逐字；同事务）。`old_value` 为 NULL 表示首建（该键此前不存在）。
 * ⚠️ `key` 列同为保留字 ⇒ 反引号（同族扫尾；INSERT 列名位置同样要引号）。
 */
export const CONFIG_CHANGES_INSERT_SQL =
  'INSERT INTO config_changes (`key`, old_value, new_value, actor) VALUES (?, ?, ?, ?)';

/** 列表基句（§2.5 行形状；`key` 是 MySQL 保留字 ⇒ 宿体句带反引号）。 */
export const CONFIG_CHANGES_SELECT_BASE =
  'SELECT id, `key`, old_value, new_value, actor, created_at FROM config_changes';
export const ACCOUNT_CHANGES_SELECT_BASE =
  'SELECT id, target_id, username, action, detail, actor, created_at FROM admin_account_changes';

/**
 * keyset 查询组装（三读口统一；登录事件面同样消费本函数）：
 * `<基句>[ WHERE 条件 AND…] ORDER BY id DESC[ LIMIT ?]`。
 * `limit === null` = CSV 的全量形态（§2.11「CSV 无分页」）；条件按调用方传入序拼接。
 */
export function buildListSql(base: string, conds: readonly string[], limit: number | null): string {
  const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
  return limit === null
    ? `${base}${where} ORDER BY id DESC`
    : `${base}${where} ORDER BY id DESC LIMIT ?`;
}

/** `nextCursor = rows.length===limit ? 末行 id : null`（⚙️18：恰满页照给，**不预查**是否真有下一页）。 */
export function nextCursorOf(
  rows: ReadonlyArray<{ id: number }>,
  limit: number | null,
): number | null {
  if (limit === null || rows.length !== limit) return null;
  return rows[rows.length - 1]!.id;
}

export interface ListResult<T> {
  rows: T[];
  nextCursor: number | null;
}

/** 过滤（已由 controller 校验：长度/型别——服务侧只拼 SQL）。 */
export interface ConfigChangesFilter {
  key?: string;
  actor?: string;
  from?: number; // epoch ms；`created_at >= from`（含边界）
  to?: number; // epoch ms；`created_at < to`（不含边界——半开区间，口径同 §2.7）
}

export interface AccountChangesFilter {
  targetId?: number;
  actor?: string;
  action?: string;
  from?: number;
  to?: number;
}

/** 行形状逐字 = §2.5 表（`oldValue` 可 null；`detail` 可 null——password_reset 只记发生）。 */
export interface ConfigChangeView {
  id: number;
  key: string;
  oldValue: unknown;
  newValue: unknown;
  actor: string;
  createdAt: number;
}

export interface AccountChangeView {
  id: number;
  targetId: number;
  username: string;
  action: string;
  detail: unknown;
  actor: string;
  createdAt: number;
}

interface RawConfigChangeRow {
  id: unknown;
  key: unknown;
  old_value: unknown;
  new_value: unknown;
  actor: unknown;
  created_at: unknown;
}

interface RawAccountChangeRow {
  id: unknown;
  target_id: unknown;
  username: unknown;
  action: unknown;
  detail: unknown;
  actor: unknown;
  created_at: unknown;
}

function toConfigChangeView(row: RawConfigChangeRow): ConfigChangeView {
  return {
    id: toSafeInt(row.id, 'config_changes.id'),
    key: String(row.key),
    // mysql2 对 json 列回**已解析值**；NULL（首建）⇒ null（`??` 只吃 null/undefined，不吞 false/0）
    oldValue: row.old_value ?? null,
    newValue: row.new_value,
    actor: String(row.actor),
    createdAt: toEpochMs(row.created_at, 'config_changes.created_at'),
  };
}

function toAccountChangeView(row: RawAccountChangeRow): AccountChangeView {
  return {
    id: toSafeInt(row.id, 'admin_account_changes.id'),
    targetId: toSafeInt(row.target_id, 'admin_account_changes.target_id'),
    username: String(row.username),
    action: String(row.action),
    detail: row.detail ?? null,
    actor: String(row.actor),
    createdAt: toEpochMs(row.created_at, 'admin_account_changes.created_at'),
  };
}

@Injectable()
export class AdminChangesService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /** `GET /api/admin/config/changes`（§2.5）。 */
  async listConfigChanges(
    filter: ConfigChangesFilter,
    cursor: number | null,
    limit: number | null,
  ): Promise<ListResult<ConfigChangeView>> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.key !== undefined) {
      conds.push('`key` = ?');
      params.push(filter.key);
    }
    if (filter.actor !== undefined) {
      conds.push('actor = ?');
      params.push(filter.actor);
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
      buildListSql(CONFIG_CHANGES_SELECT_BASE, conds, limit),
      params,
    )) as RawConfigChangeRow[];
    const mapped = rows.map(toConfigChangeView);
    return { rows: mapped, nextCursor: nextCursorOf(mapped, limit) };
  }

  /** `GET /api/admin/accounts/changes`（§2.5）。 */
  async listAccountChanges(
    filter: AccountChangesFilter,
    cursor: number | null,
    limit: number | null,
  ): Promise<ListResult<AccountChangeView>> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.targetId !== undefined) {
      conds.push('target_id = ?');
      params.push(filter.targetId);
    }
    if (filter.actor !== undefined) {
      conds.push('actor = ?');
      params.push(filter.actor);
    }
    if (filter.action !== undefined) {
      conds.push('action = ?');
      params.push(filter.action);
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
      buildListSql(ACCOUNT_CHANGES_SELECT_BASE, conds, limit),
      params,
    )) as RawAccountChangeRow[];
    const mapped = rows.map(toAccountChangeView);
    return { rows: mapped, nextCursor: nextCursorOf(mapped, limit) };
  }
}

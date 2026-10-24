import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrCode, isAdminUsername } from '@fight-the-landlord/protocol';
import { isDuplicateKeyError } from '../config/platform-config.service';
import { hashPassword, type ScryptParams } from './admin-password';

/**
 * 管理员账号 CRUD + 自锁三闸 + 变更留痕（规格 §2.4；判据 C12/C13/C14）。
 *
 * 访问形态 = **裸 SQL**（`dataSource.query` / 事务内 `manager.query`——不用 TypeORM entity，
 * 同 currency-service 先例）：① `FOR UPDATE` 锁定读要能被单测**全文钉**（`ADMIN_SUPER_LOCK_SQL`
 * 照 `reconcile.service.ts:36-37` 纪律）；② 四张表是管理小表，entity 只会多一份要维护的映射。
 *
 * **授权矩阵不在服务侧**（设计 D2）：角色矩阵在网关单点执行；本服务只信 `X-Admin: 1`（守卫）
 * + `X-Admin-Actor`（写面身份，缺失/非法 ⇒ 401 fail-closed，不回退——§2.14「admin 写面」行）。
 */

/** scrypt 参数注入令牌（生产 = `DEFAULT_SCRYPT_PARAMS`；单测注入小参数——规格 §2.1 口径）。 */
export const ADMIN_SCRYPT_PARAMS = 'ADMIN_SCRYPT_PARAMS';

/** 四角色（设计 D3；**固定矩阵，无自定义权限**）。 */
export const ADMIN_ROLES = ['super_admin', 'finance', 'operator', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** 账号状态两值（设计 §3 `status` 列）。 */
export const ADMIN_STATUSES = ['active', 'disabled'] as const;
export type AdminAccountStatus = (typeof ADMIN_STATUSES)[number];

/**
 * 闸 2 的锁定读（规格 §2.4 逐字，**全文被单测钉**——改一个字符当场红，照
 * `reconcile.service.ts` 的判据形态）。语义：锁住全部 active 超管行，事务内改前执行
 * ——RR 下的普通快照读看不见并发已提交行，两名超管互降会双双通过（同族教训 = 货币 ⚙️14）。
 */
export const ADMIN_SUPER_LOCK_SQL =
  "SELECT id, role, status FROM admin_accounts WHERE role='super_admin' AND status='active' FOR UPDATE";

/** 账号列表防御上限（⚙️10：管理面量级 O(10)；不分页）。 */
export const ACCOUNTS_LIST_LIMIT = 200;

/** 列表 SQL：多取一行（LIMIT 201）用于事后判定「超出上限」（超出照出前 200 并日志）。 */
const ACCOUNTS_LIST_SQL =
  'SELECT id, username, role, status, created_at, last_login_at FROM admin_accounts ORDER BY id ASC LIMIT 201';
/** 事务内取目标行（404 判定 + 闸 1/2 的现值来源）；只选 update 路径**实际消费**的列。 */
const ACCOUNT_BY_ID_SQL = 'SELECT id, username, role, status FROM admin_accounts WHERE id = ?';
const INSERT_ACCOUNT_SQL =
  'INSERT INTO admin_accounts (username, password_hash, role) VALUES (?, ?, ?)';
const INSERT_ACCOUNT_CHANGE_SQL =
  'INSERT INTO admin_account_changes (target_id, username, action, detail, actor) VALUES (?, ?, ?, ?, ?)';

/* 错误文案（规格 §2.4/§2.14：带引号的为规格逐字；其余为就地定死的精确文案）。 */
const USERNAME_FORMAT_MESSAGE = '用户名格式不符：3–32 位小写字母/数字/._-';
const PASSWORD_POLICY_MESSAGE = '口令长度须为 10–72 字符';
const ROLE_MESSAGE = '角色非法：必须是 super_admin/finance/operator/viewer 之一';
const STATUS_MESSAGE = '状态非法：必须是 active/disabled 之一';
const ID_MESSAGE = '账号 ID 非法';
const NOT_FOUND_MESSAGE = '账号不存在';
const DUP_USERNAME_MESSAGE = '用户名已存在';
const SELF_LOCK_MESSAGE = '不能停用或变更自己的角色';
const LAST_SUPER_MESSAGE = '不能停用或降级最后一名超级管理员';
const ACTOR_MISSING_MESSAGE = '管理身份缺失';

/**
 * admin 面错误信封（⚙️11）：一律「HTTP 状态 + `{code, message, data:null}`」；参数/冲突/
 * 不存在**借 `10001` + 精确文案**（409 借码不能走 `http/errors.ts` 的码→状态映射表，
 * 形态照 `admin.controller.ts` 的 `notEnabled404()` 先例）。
 *
 * ③ T4 起由 `audit.controller.ts`（三读口的 query 校验 400）与 `admin.controller.ts`
 * 的配置 PUT（经 `requireActor`）复用——**导出**，勿在调用方复制信封构造。
 */
export function adminHttpException(status: number, code: ErrCode, message: string): HttpException {
  return new HttpException({ code, message, data: null }, status);
}

const badRequest = (message: string) => adminHttpException(400, ErrCode.BAD_PARAM, message);
const notFound = (message: string) => adminHttpException(404, ErrCode.BAD_PARAM, message);
const conflict = (message: string) => adminHttpException(409, ErrCode.BAD_PARAM, message);

/**
 * 网关注入的操作者头（网关 `identity-headers.ts` 是它的真源；`accounts.controller.ts` 有一枚
 * 同值导出——各消费点各定义一次是本仓惯例，同 `ADMIN_HEADER`/`CLIENT_IP_HEADER`，由行为测试
 * 与 T5 的网关测试钉住不漂移）。
 */
export const ADMIN_ACTOR_HEADER = 'x-admin-actor';

/**
 * 写面身份（fail-closed）：缺失或**不匹配**用户名正则 ⇒ 401「管理身份缺失」（不回退任何默认值）。
 * ③ T4 起 `config/admin.controller.ts` 的 PUT 与 `currency-service` 写面（T6，同款形态）共用。
 */
export function requireActor(actor: string | undefined): string {
  if (typeof actor !== 'string' || !isAdminUsername(actor)) {
    throw adminHttpException(401, ErrCode.UNAUTHENTICATED, ACTOR_MISSING_MESSAGE);
  }
  return actor;
}

/** 用户名校验（§2.4：string → `toLowerCase()` → `isAdminUsername`——正则单一真源在 protocol）。 */
function requireUsername(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest(USERNAME_FORMAT_MESSAGE);
  const normalized = raw.toLowerCase();
  if (!isAdminUsername(normalized)) throw badRequest(USERNAME_FORMAT_MESSAGE);
  return normalized;
}

/** 口令策略（**仅设置路径**：建号/重置；登录不校验长度——§5.1 F10a）。 */
function requirePassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 10 || raw.length > 72) {
    throw badRequest(PASSWORD_POLICY_MESSAGE);
  }
  return raw;
}

function requireRole(raw: unknown): AdminRole {
  if (typeof raw !== 'string' || !(ADMIN_ROLES as readonly string[]).includes(raw)) {
    throw badRequest(ROLE_MESSAGE);
  }
  return raw as AdminRole;
}

function requireStatus(raw: unknown): AdminAccountStatus {
  if (typeof raw !== 'string' || !(ADMIN_STATUSES as readonly string[]).includes(raw)) {
    throw badRequest(STATUS_MESSAGE);
  }
  return raw as AdminAccountStatus;
}

/** 驱动读出的 number/bigint ⇒ 安全整数（读不出 ⇒ 抛，不静默 NaN 进 JSON；照 currency 先例）。 */
export function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/** `datetime(3)` 的驱动形态 ⇒ epoch ms 整数（wire 一律 epoch ms——⚙️1）。③ T4 起三读口共享。 */
export function toEpochMs(value: unknown, context: string): number {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : new Date(String(value)).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`${context}：读出的时间不是有限毫秒（收到 ${JSON.stringify(value)}）`);
  }
  return ms;
}

/** 列表行（SQL 已排除 `password_hash`）。 */
interface AccountListRow {
  id: unknown;
  username: unknown;
  role: unknown;
  status: unknown;
  created_at: unknown;
  last_login_at: unknown;
}

/**
 * 目标行（update 路径只消费 `username`/`role`/`status`；`id` 保留作行标识）。
 * ⚠️ **不选 `password_hash`**：改密以**新哈希覆写**，旧哈希从不读——「选了但不消费」的列
 * 只会让人误以为它在参与判定（波2评审 Minor#2 的收窄；值本身在库里，不是出站风险）。
 */
interface AccountRow {
  id: unknown;
  username: unknown;
  role: unknown;
  status: unknown;
}

export interface AdminAccountView {
  id: number;
  username: string;
  role: AdminRole;
  status: AdminAccountStatus;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface CreateAccountInput {
  username?: unknown;
  password?: unknown;
  role?: unknown;
}

export interface UpdateAccountInput {
  role?: unknown;
  status?: unknown;
  password?: unknown;
}

export interface CreatedAccount {
  id: number;
  username: string;
  role: AdminRole;
  status: 'active';
}

export interface UpdatedAccount {
  id: number;
  username: string;
  role: AdminRole;
  status: AdminAccountStatus;
}

function toView(row: AccountListRow): AdminAccountView {
  return {
    id: toSafeInt(row.id, 'admin_accounts.id'),
    username: String(row.username),
    role: String(row.role) as AdminRole,
    status: String(row.status) as AdminAccountStatus,
    createdAt: toEpochMs(row.created_at, 'admin_accounts.created_at'),
    lastLoginAt:
      row.last_login_at === null || row.last_login_at === undefined
        ? null
        : toEpochMs(row.last_login_at, 'admin_accounts.last_login_at'),
  };
}

@Injectable()
export class AdminAccountsService {
  private readonly logger = new Logger(AdminAccountsService.name);

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ADMIN_SCRYPT_PARAMS) private readonly scryptParams: ScryptParams,
  ) {}

  /** `GET /api/admin/accounts`：id ASC、不分页（⚙️10 防御上限 200，超出照出前 200 并日志）。 */
  async list(): Promise<AdminAccountView[]> {
    const rows = (await this.dataSource.query(ACCOUNTS_LIST_SQL)) as AccountListRow[];
    if (rows.length > ACCOUNTS_LIST_LIMIT) {
      this.logger.warn(
        `admin accounts: ${rows.length} rows exceed defensive cap ${ACCOUNTS_LIST_LIMIT}; returning first ${ACCOUNTS_LIST_LIMIT} (LIMIT 201 probe)`,
      );
    }
    return rows.slice(0, ACCOUNTS_LIST_LIMIT).map(toView);
  }

  /** `POST /api/admin/accounts`：校验 → scrypt → 事务（INSERT 账号 + create 留痕同事务）。 */
  async create(body: CreateAccountInput | undefined, actor: string | undefined): Promise<CreatedAccount> {
    const by = requireActor(actor);
    const username = requireUsername(body?.username);
    const password = requirePassword(body?.password); // 形状校验（400）先于哈希（CPU 成本）
    const role = requireRole(body?.role);
    const passwordHash = await hashPassword(password, this.scryptParams);

    let id: number;
    try {
      id = await this.dataSource.transaction(async (manager) => {
        const result = (await manager.query(INSERT_ACCOUNT_SQL, [username, passwordHash, role])) as {
          insertId?: unknown;
        };
        const newId = toSafeInt(result?.insertId, 'admin_accounts.insertId');
        // 留痕（§2.4 逐字：create + detail {role}；同事务）
        await manager.query(INSERT_ACCOUNT_CHANGE_SQL, [
          newId,
          username,
          'create',
          JSON.stringify({ role }),
          by,
        ]);
        return newId;
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict(DUP_USERNAME_MESSAGE);
      throw err;
    }
    return { id, username, role, status: 'active' };
  }

  /**
   * `PATCH /api/admin/accounts/:id`：`{role?, status?, password?}` 任意子集。
   *
   * 事务内逐字序（规格 §2.4）：取目标行（404）→ 子集校验（400）→ **闸 1**（自锁，纯内存判定）
   * → **闸 2**（锁定读，改前）→ UPDATE → 逐动作留痕（同事务）。
   * 闸 3 = 语义约束（password 变更不隐式改 status），从不产生错误路径（S14）。
   */
  async update(
    idRaw: string,
    body: UpdateAccountInput | undefined,
    actor: string | undefined,
  ): Promise<UpdatedAccount> {
    const by = requireActor(actor);
    if (!/^\d+$/.test(idRaw) || !Number.isSafeInteger(Number(idRaw))) {
      throw badRequest(ID_MESSAGE);
    }
    const id = Number(idRaw);

    return await this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(ACCOUNT_BY_ID_SQL, [id])) as AccountRow[];
      if (rows.length === 0) throw notFound(NOT_FOUND_MESSAGE);
      const row = rows[0]!;

      const rolePresent = body?.role !== undefined;
      const statusPresent = body?.status !== undefined;
      const passwordPresent = body?.password !== undefined;

      const newRole = rolePresent ? requireRole(body!.role) : (String(row.role) as AdminRole);
      const newStatus = statusPresent
        ? requireStatus(body!.status)
        : (String(row.status) as AdminAccountStatus);
      // 子集校验先于三闸（规格 §2.4 列序）；口令**归一为字符串**留到闸后哈希（闸拒时不做无谓 CPU）
      const newPassword = passwordPresent ? requirePassword(body!.password) : undefined;

      const roleChanged = rolePresent && newRole !== row.role;
      const statusChanged = statusPresent && newStatus !== row.status;
      const willDisable = statusChanged && newStatus === 'disabled';
      const demotedFromSuper = roleChanged && row.role === 'super_admin';

      // 闸 1（规格 S5）：任何自身角色变更（任何方向）或停用自己 ⇒ 409；改自己口令合法。
      if (row.username === by && (willDisable || roleChanged)) {
        throw conflict(SELF_LOCK_MESSAGE);
      }

      // 闸 2：目标将被停用或降级出 super_admin 时，**事务内锁定读**（改前执行）。
      // size==1 且目标 ∈ 集合 ⇒ 拒（最后一名 active 超管不可停用/降级）。
      if (willDisable || demotedFromSuper) {
        const activeSupers = (await manager.query(ADMIN_SUPER_LOCK_SQL)) as Array<{ id: unknown }>;
        if (activeSupers.length === 1 && toSafeInt(activeSupers[0]!.id, 'admin_accounts.id') === id) {
          throw conflict(LAST_SUPER_MESSAGE);
        }
      }

      // UPDATE：只含有实际变更的字段（同值字段 = 无操作；空子集 = 整段跳过）。
      const sets: string[] = [];
      const params: unknown[] = [];
      if (roleChanged) {
        sets.push('role = ?');
        params.push(newRole);
      }
      if (statusChanged) {
        sets.push('status = ?');
        params.push(newStatus);
      }
      if (passwordPresent) {
        sets.push('password_hash = ?');
        params.push(await hashPassword(newPassword!, this.scryptParams));
      }
      if (sets.length > 0) {
        await manager.query(`UPDATE admin_accounts SET ${sets.join(', ')} WHERE id = ?`, [
          ...params,
          id,
        ]);
      }

      // 变更留痕（§2.4 逐字；一次请求多字段 ⇒ 多行；同事务、固定序 role→disable/enable→password_reset）
      const detailAndAction: Array<{ action: string; detail: string | null }> = [];
      if (roleChanged) {
        detailAndAction.push({ action: 'role', detail: JSON.stringify({ from: row.role, to: newRole }) });
      }
      if (statusChanged) {
        detailAndAction.push({ action: newStatus === 'disabled' ? 'disable' : 'enable', detail: null });
      }
      if (passwordPresent) {
        detailAndAction.push({ action: 'password_reset', detail: null });
      }
      for (const change of detailAndAction) {
        await manager.query(INSERT_ACCOUNT_CHANGE_SQL, [
          id,
          String(row.username),
          change.action,
          change.detail,
          by,
        ]);
      }

      return {
        id,
        username: String(row.username),
        role: newRole,
        status: newStatus,
      };
    });
  }
}

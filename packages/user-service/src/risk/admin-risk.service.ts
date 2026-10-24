// packages/user-service/src/risk/admin-risk.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { ErrCode } from '@fight-the-landlord/protocol';
import { REDIS } from '../auth/token.service';
import { ConfigCacheService } from '../config/config-cache.service';
import { DomainError } from '../http/errors';
import { riskBannedKey, riskLimitKey, RISK_USER_STATUS_SQL } from './reviews.service';
import { DeviceBindingsService } from './device-bindings.service';

/**
 * 风控管理面的**读收口**（风控片 T6 / 规格 §2.8 前两行与第四行；判据 C19 的读半边）。
 * 写面（POST actions）在 `ReviewsService.applyAdminAction` —— 读写分家，队列状态机只有一个
 * 真源。本文件只做四件事：**keyset 列表组装**、**详情聚合**、**旗读 fail-open**、**行形状映射**。
 *
 * ⚠️ 访问形态 = 裸 SQL（同 config-service 审计读口先例）；行时间一律 epoch ms（全链口径）。
 * ⚠️ `limit === null` = CSV 的**全量**形态（「CSV 无分页」；仅 actions 有 CSV 变体）。
 */

/** 审核队列列表基句（keyset `id DESC`；`status` 过滤在 WHERE 拼）。 */
export const REVIEWS_SELECT_BASE =
  'SELECT id, user_id, score, reasons, status, created_at, updated_at, handled_by, handled_at FROM risk_reviews';

/** 处置审计列表基句（过滤键 = userId/action/actor/from/to）。 */
export const ACTIONS_SELECT_BASE =
  'SELECT id, user_id, action, actor, reason, review_id, detail, created_at FROM risk_actions';

/**
 * 详情页 stats 的胜率半边（单用户形态；与扫描 SQL1 同口径：`random|gold`、全量窗口无天数
 * 限制——K4 由记录保留期天然约束）。**刻意不带 users.status 过滤**：封禁用户的战绩照常可见
 * （管理面是诊断视图，不是检测视图）。COUNT/SUM 无行 ⇒ 恒回一行（COALESCE 兜 0）。
 */
export const RISK_STATS_SQL =
  "SELECT COUNT(*) AS games, COALESCE(SUM(p.won), 0) AS wins FROM game_record_players p JOIN game_records r ON r.id = p.record_id WHERE p.user_id = ? AND r.mode IN ('random', 'gold')";

/** 详情页 stats 的设备数（**窗口** = `now − risk.deviceWindowDays` 天；口径同扫描 SQL2 的单用户形）。 */
export const RISK_DEVICE_COUNT_WINDOW_SQL =
  'SELECT COUNT(DISTINCT device_id) AS devices FROM user_devices WHERE user_id = ? AND last_seen_at >= ?';

/** 设备原文（K3；全量不截断——每台带 others 才截）。 */
export const RISK_DEVICES_SELECT_SQL =
  'SELECT device_id, first_seen_at, last_seen_at FROM user_devices WHERE user_id = ? ORDER BY last_seen_at DESC, id DESC';

/** 同设备关联账号（≤20；`u.status` = 对方账号状态，JOIN 掉不存在的幽灵行）。 */
export const RISK_DEVICE_OTHERS_SQL =
  'SELECT d.user_id, u.status FROM user_devices d JOIN users u ON u.id = d.user_id WHERE d.device_id = ? AND d.user_id <> ? ORDER BY d.last_seen_at DESC LIMIT 20';

/** 条目历史（最近 10 条）。 */
export const RISK_ENTRIES_SQL =
  'SELECT id, score, status, handled_by, handled_at, created_at FROM risk_reviews WHERE user_id = ? ORDER BY id DESC LIMIT 10';

/** `risk:hit:{userId}:{predicate}` 键（T2 room 侧 INCR 的读面拼法；详情页 MGET 两键）。 */
export function riskHitKey(userId: string, predicate: 'sameIp' | 'sameDevice'): string {
  return `risk:hit:${userId}:${predicate}`;
}

/** 一天毫秒（设备数窗口换算；不做日期串解析——全链 epoch ms 口径）。 */
const DAY_MS = 86_400_000;

/** `limit` 缺省/上限（与 config-service ⚙️18 同口径；网关侧 T7 白名单放行同名键）。 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export interface RiskReviewListFilter {
  status?: string;
}

/** 审计列表过滤（controller 已做长度/型别校验，服务侧只拼 SQL）。 */
export interface RiskActionListFilter {
  userId?: string;
  action?: string;
  actor?: string;
  from?: number; // epoch ms；`created_at >= from`（含边界）
  to?: number; // epoch ms；`created_at < to`（不含边界——半开区间，口径同 config 读口）
}

export interface RiskListResult<T> {
  items: T[];
  nextCursor: number | null;
}

/** 队列行形状逐字 = 规格 §2.8 第一行（`reasons` 原样透传；时间 epoch ms）。 */
export interface RiskReviewItem {
  id: number;
  userId: string;
  score: number;
  reasons: unknown;
  status: string;
  createdAt: number;
  updatedAt: number;
  handledBy: string | null;
  handledAt: number | null;
}

/** 审计行形状（规格 §2.8 第四行 + `risk_actions` 全列：`detail` 目前恒 null）。 */
export interface RiskActionItem {
  id: number;
  userId: string;
  action: string;
  actor: string;
  reason: string | null;
  reviewId: number | null;
  detail: unknown;
  createdAt: number;
}

/** 详情聚合形状逐字 = 规格 §2.8 第二行（`accountStatus`/`limitSource` 驱动动作按钮可用性）。
 *  `bannedFlagPresent`（终审 F2）：`risk:banned` 旗在场性——**孤儿旗**（`status=active` 但旗在，
 *  unban DEL 失败/崩溃/自愈竞态窗口产出）由此在管理面可见（unban 孤儿分支的后端已支持 200，
 *  此前 UI 仅按 `accountStatus` 解锁 ⇒ 不可达；此字段即解锁面）。 */
export interface RiskUserDetail {
  userId: string;
  accountStatus: string;
  limitSource: 'auto' | 'manual' | null;
  bannedFlagPresent: boolean;
  stats: { games: number; wins: number; winRate: number; deviceCount: number };
  devices: Array<{
    deviceId: string;
    firstSeenAt: number;
    lastSeenAt: number;
    others: Array<{ userId: string; accountStatus: string }>;
  }>;
  entries: Array<{
    id: number;
    score: number;
    status: string;
    handledBy: string | null;
    handledAt: number | null;
    createdAt: number;
  }>;
  hits: { sameIp: number; sameDevice: number };
  /**
   * 设备绑定片：当前 1:1 绑定（无 ⇒ null；与 `devices` 的 1:N 历史链语义分离——
   * 管理面据此渲染「绑定设备」卡片与解绑按钮）。
   */
  binding: { deviceId: string; boundAt: number } | null;
}

/* ------------------------------------------------------------------ *
 * 行映射与局部工具（照 config-service 审计读口先例的就地形态）
 * ------------------------------------------------------------------ */

/** `<基句>[ WHERE 条件 AND…] ORDER BY id DESC[ LIMIT ?]`（`limit === null` = CSV 全量）。 */
function buildListSql(base: string, conds: readonly string[], limit: number | null): string {
  const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
  return limit === null
    ? `${base}${where} ORDER BY id DESC`
    : `${base}${where} ORDER BY id DESC LIMIT ?`;
}

/** `nextCursor = items.length === limit ? 末行 id : null`（恰满页照给，**不做存在性预查**）。 */
function nextCursorOf(items: ReadonlyArray<{ id: number }>, limit: number | null): number | null {
  if (limit === null || items.length !== limit) return null;
  return items[items.length - 1]!.id;
}

/** 从库里读出的 number/bigint ⇒ 安全整数（读不出 ⇒ 抛，不静默放 NaN/错值进 JSON）。 */
function toSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/** `datetime(3)` 的三种驱动形态 ⇒ epoch ms 整数（照 `admin-changes.service.ts` 先例）。 */
function toEpochMs(value: unknown, context: string): number {
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

/** COUNT/SUM 的驱动回值（可能字符串）⇒ 有限数（绝不放 NaN 进响应）。 */
function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

interface RawReviewRow {
  id: unknown;
  user_id: unknown;
  score: unknown;
  reasons: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
  handled_by: unknown;
  handled_at: unknown;
}

function toReviewItem(row: RawReviewRow): RiskReviewItem {
  return {
    id: toSafeInt(row.id, 'risk_reviews.id'),
    userId: String(row.user_id),
    score: toSafeInt(row.score, 'risk_reviews.score'),
    reasons: row.reasons, // json 列：mysql2 回已解析值，原样透传
    status: String(row.status),
    createdAt: toEpochMs(row.created_at, 'risk_reviews.created_at'),
    updatedAt: toEpochMs(row.updated_at, 'risk_reviews.updated_at'),
    handledBy: row.handled_by === null || row.handled_by === undefined ? null : String(row.handled_by),
    handledAt:
      row.handled_at === null || row.handled_at === undefined
        ? null
        : toEpochMs(row.handled_at, 'risk_reviews.handled_at'),
  };
}

interface RawActionRow {
  id: unknown;
  user_id: unknown;
  action: unknown;
  actor: unknown;
  reason: unknown;
  review_id: unknown;
  detail: unknown;
  created_at: unknown;
}

function toActionItem(row: RawActionRow): RiskActionItem {
  return {
    id: toSafeInt(row.id, 'risk_actions.id'),
    userId: String(row.user_id),
    action: String(row.action),
    actor: String(row.actor),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    reviewId:
      row.review_id === null || row.review_id === undefined
        ? null
        : toSafeInt(row.review_id, 'risk_actions.review_id'),
    detail: row.detail ?? null,
    createdAt: toEpochMs(row.created_at, 'risk_actions.created_at'),
  };
}

@Injectable()
export class AdminRiskService {
  private readonly logger = new Logger(AdminRiskService.name);

  constructor(
    /** ⚠️ `DataSource` 是**值导入** + 显式 `@Inject`（DI 陷阱纪律；本仓既有惯例）。 */
    @Inject(DataSource) private readonly dataSource: DataSource,
    /** ⚠️ 旗/计数读面注入 = `REDIS` 令牌（`import type { Redis }` 成例）。 */
    @Inject(REDIS) private readonly redis: Redis,
    private readonly configCache: ConfigCacheService,
    private readonly deviceBindings: DeviceBindingsService,
  ) {}

  /** `GET /api/admin/risk/reviews`（§2.8 第一行：`status` 过滤 + keyset `id DESC`）。 */
  async listReviews(
    filter: RiskReviewListFilter,
    cursor: number | null,
    limit: number | null,
  ): Promise<RiskListResult<RiskReviewItem>> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      conds.push('status = ?');
      params.push(filter.status);
    }
    if (cursor !== null) {
      conds.push('id < ?');
      params.push(cursor);
    }
    if (limit !== null) params.push(limit);

    const rows = (await this.dataSource.query(
      buildListSql(REVIEWS_SELECT_BASE, conds, limit),
      params,
    )) as RawReviewRow[];
    const items = rows.map(toReviewItem);
    return { items, nextCursor: nextCursorOf(items, limit) };
  }

  /** `GET /api/admin/risk/actions(.csv)`（§2.8 第四行：四过滤键 + keyset；全量形态 = CSV）。 */
  async listActions(
    filter: RiskActionListFilter,
    cursor: number | null,
    limit: number | null,
  ): Promise<RiskListResult<RiskActionItem>> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.userId !== undefined) {
      conds.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.action !== undefined) {
      conds.push('action = ?');
      params.push(filter.action);
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
      buildListSql(ACTIONS_SELECT_BASE, conds, limit),
      params,
    )) as RawActionRow[];
    const items = rows.map(toActionItem);
    return { items, nextCursor: nextCursorOf(items, limit) };
  }

  /**
   * `GET /api/admin/risk/users/:userId`（§2.8 第二行；详情聚合）。
   *
   * 404：users 无此人 ⇒ `DomainError(11004)`（控制器翻 404——借既有码，不新造）。
   * `now` 注入 = 设备数窗口的 cutoff（测试钉值）；`limitSource`/`hits`/`bannedFlagPresent`
   * 三处读失败**按无旗/0/false 放行 + 日志**（R11 旗读纪律——显示面绝不因 Redis 故障变 500；
   * 前两者 error、`bannedFlagPresent` warn<终审 F2 写死>）。
   */
  async getUserDetail(userId: string, now: number = Date.now()): Promise<RiskUserDetail> {
    const userRows = (await this.dataSource.query(RISK_USER_STATUS_SQL, [userId])) as Array<{
      status?: unknown;
    }>;
    if (userRows.length === 0) throw new DomainError(ErrCode.USER_NOT_FOUND, '未找到该用户');
    const accountStatus = String(userRows[0]?.status);

    // ── stats（games/wins 全量；deviceCount 按窗口现读配置）──────────────────
    const statsRows = (await this.dataSource.query(RISK_STATS_SQL, [userId])) as Array<{
      games?: unknown;
      wins?: unknown;
    }>;
    const games = toCount(statsRows[0]?.games);
    const wins = toCount(statsRows[0]?.wins);
    const winRate = games > 0 ? wins / games : 0;
    const cutoff = new Date(now - this.configCache.riskDeviceWindowDays() * DAY_MS);
    const countRows = (await this.dataSource.query(RISK_DEVICE_COUNT_WINDOW_SQL, [
      userId,
      cutoff,
    ])) as Array<{ devices?: unknown }>;
    const deviceCount = toCount(countRows[0]?.devices);

    // ── 设备原文 + others（每台至多 20 个关联账号）──────────────────────────
    const deviceRows = (await this.dataSource.query(RISK_DEVICES_SELECT_SQL, [userId])) as Array<{
      device_id: unknown;
      first_seen_at: unknown;
      last_seen_at: unknown;
    }>;
    const devices: RiskUserDetail['devices'] = [];
    for (const row of deviceRows) {
      const deviceId = String(row.device_id);
      const otherRows = (await this.dataSource.query(RISK_DEVICE_OTHERS_SQL, [
        deviceId,
        userId,
      ])) as Array<{ user_id: unknown; status: unknown }>;
      devices.push({
        deviceId,
        firstSeenAt: toEpochMs(row.first_seen_at, 'user_devices.first_seen_at'),
        lastSeenAt: toEpochMs(row.last_seen_at, 'user_devices.last_seen_at'),
        others: otherRows.map((o) => ({
          userId: String(o.user_id),
          accountStatus: String(o.status),
        })),
      });
    }

    // ── 条目历史（最近 10 条）────────────────────────────────────────────
    const entryRows = (await this.dataSource.query(RISK_ENTRIES_SQL, [userId])) as Array<{
      id: unknown;
      score: unknown;
      status: unknown;
      handled_by: unknown;
      handled_at: unknown;
      created_at: unknown;
    }>;
    const entries: RiskUserDetail['entries'] = entryRows.map((r) => ({
      id: toSafeInt(r.id, 'risk_reviews.id'),
      score: toSafeInt(r.score, 'risk_reviews.score'),
      status: String(r.status),
      handledBy: r.handled_by === null || r.handled_by === undefined ? null : String(r.handled_by),
      handledAt:
        r.handled_at === null || r.handled_at === undefined
          ? null
          : toEpochMs(r.handled_at, 'risk_reviews.handled_at'),
      createdAt: toEpochMs(r.created_at, 'risk_reviews.created_at'),
    }));

    // ── 命中计数（MGET 两键，⚙️13：无 SCAN）/ 限流旗来源（F13）/ 封禁旗在场性（终审 F2）──
    const hits = await this.readHits(userId);
    const limitSource = await this.readLimitSource(userId);
    const bannedFlagPresent = await this.readBannedFlagPresent(userId);

    // ── 设备绑定片：1:1 绑定行（读失败不外溢——绑定服务直接点查 MySQL；无行 ⇒ null）────
    const bindingRow = await this.deviceBindings.getBinding(userId);
    const binding = bindingRow
      ? {
          deviceId: bindingRow.deviceId,
          boundAt: toEpochMs(bindingRow.boundAt, 'user_device_bindings.bound_at'),
        }
      : null;

    return {
      userId,
      accountStatus,
      limitSource,
      bannedFlagPresent,
      stats: { games, wins, winRate, deviceCount },
      devices,
      entries,
      hits,
      binding,
    };
  }

  /** `risk:hit:{userId}:{sameIp|sameDevice}` MGET ⇒ 两键计数（失败 ⇒ 0/0 + error 日志）。 */
  private async readHits(userId: string): Promise<{ sameIp: number; sameDevice: number }> {
    try {
      const values = await this.redis.mget(
        riskHitKey(userId, 'sameIp'),
        riskHitKey(userId, 'sameDevice'),
      );
      return { sameIp: toCount(values[0]), sameDevice: toCount(values[1]) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `risk hit counters read failed for userId=${userId} (按 0 处理): ${reason}`,
      );
      return { sameIp: 0, sameDevice: 0 };
    }
  }

  /**
   * `risk:limit:{userId}` 旗来源（`auto`/`manual`/无旗 ⇒ `null`；F13 动作按钮可用性输入）。
   * 旗读纪律（R11/F8）：**单独 try/catch ⇒ 按无旗 + error 日志**（坏 JSON 同路处置）。
   */
  private async readLimitSource(userId: string): Promise<'auto' | 'manual' | null> {
    try {
      const raw = await this.redis.get(riskLimitKey(userId));
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as { source?: unknown };
      return parsed.source === 'auto' || parsed.source === 'manual' ? parsed.source : null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`risk limit flag read failed for userId=${userId} (按无旗处理): ${reason}`);
      return null;
    }
  }

  /**
   * `EXISTS risk:banned:{userId}`（终审 F2：孤儿封禁旗的管理面可见性——unban 按钮解锁输入）。
   * **展示位读**，与检测位同规：失败 ⇒ **false + warn**（绝不 500；按无旗显示）。
   */
  private async readBannedFlagPresent(userId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(riskBannedKey(userId))) === 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `risk banned flag read failed for userId=${userId} (按无旗处理): ${reason}`,
      );
      return false;
    }
  }
}

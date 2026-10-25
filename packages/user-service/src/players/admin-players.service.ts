import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ONLINE_TTL_MS, ONLINE_USERS_KEY, PLAYERS_SUMMARY_KEY } from '@fight-the-landlord/shared';
import type { Redis } from 'ioredis';
import { REDIS } from '../auth/token.service';
import { ConfigCacheService } from '../config/config-cache.service';
import { DomainError } from '../http/errors';
import { ErrCode } from '@fight-the-landlord/protocol';

export type PlayersOnlineFilter = 'online' | 'offline';
export type PlayersActivityFilter = 'active7' | 'active30' | 'inactive14' | 'inactive30';
export type PlayersSort = 'lastActive' | 'created';

export interface PlayersQuery {
  q?: string;
  status?: 'active' | 'banned';
  online?: PlayersOnlineFilter;
  activity?: PlayersActivityFilter;
  page: number;
  pageSize: number;
  sort: PlayersSort;
}

export interface PlayerRow {
  userId: string;
  phone: string;
  nickname: string | null;
  status: string;
  createdAt: number;
  lastActiveAt: number | null;
  online: boolean;
  deviceCount: number;
  games: number;
  wins: number;
  lastGameAt: number | null;
  riskStatus: string | null;
}

export interface PlayersSummary {
  totalPlayers: number;
  onlineNow: number;
  newToday: number;
  new7d: number;
  active1d: number;
  active7d: number;
  active30d: number;
  inactive14d: number;
  inactive30d: number;
  neverActive: number;
}

const DAY_MS = 86_400_000;
const SUMMARY_TTL_MS = 60_000;

/**
 * A2：`lastActiveAt` 的**唯一表达式**（列表 SELECT/ORDER、activity 筛选、summaryBase 复用）。
 *
 * 三类时间统一换 epoch ms 再比较：
 *  - `user_devices.last_seen_at` / DDZ `ended_at`（datetime(3)）用 `TIMESTAMPDIFF` 从
 *    1970-01-01 字面量差微秒再 DIV 1000 —— **不做会话时区换算**（`UNIX_TIMESTAMP` 会）；
 *  - PDK `ended_at` 本身就是 BIGINT ms。
 */
const LAST_ACTIVE_MS_EXPR =
  'CASE WHEN d.last_seen IS NULL AND g.last_game IS NULL AND pg.last_game_ms IS NULL THEN NULL ' +
  'ELSE GREATEST(' +
  "COALESCE(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', d.last_seen) DIV 1000, 0), " +
  "COALESCE(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', g.last_game) DIV 1000, 0), " +
  'COALESCE(pg.last_game_ms, 0)' +
  ') END';

/** 玩家列表/汇总共用的 from 片段（设备 + DDZ 最近局 + PDK 最近局）。 */
const PLAYERS_FROM_SQL = `
  FROM users u
  LEFT JOIN (
    SELECT user_id, MAX(last_seen_at) AS last_seen
    FROM user_devices GROUP BY user_id
  ) d ON d.user_id = u.id
  LEFT JOIN (
    SELECT p.user_id, MAX(p.ended_at) AS last_game
    FROM game_record_players p
    JOIN game_records r ON r.id = p.record_id
    WHERE p.user_id IS NOT NULL AND p.is_robot = 0 AND r.mode IN ('random','gold')
    GROUP BY p.user_id
  ) g ON g.user_id = u.id
  LEFT JOIN (
    SELECT p.user_id, MAX(p.ended_at) AS last_game_ms
    FROM game_record_players_pdk p
    JOIN game_records_pdk r ON r.id = p.record_id
    WHERE p.user_id IS NOT NULL AND p.is_robot = 0 AND r.mode IN ('random','gold')
    GROUP BY p.user_id
  ) pg ON pg.user_id = u.id`;

/**
 * 玩家管理页读面（2026-10-22）。
 *
 * 口径（spec D18）：
 *  - `lastActiveAt = max(user_devices.last_seen_at, 最近一局 ended_at)`；两者都无 ⇒ null；
 *  - 对局/胜场统一 `mode IN ('random','gold')`、`is_robot=0`（与风控详情同口径）；
 *  - 设备数统一 `risk.deviceWindowDays` 窗口（与风控详情同口径）。
 *
 * 在线：Redis ZSET `presence:online`（room-service 写）；Redis 失败降级为全员离线。
 * 汇总：60s 内存缓存（A1 阶段）；B 阶段可由统计任务快照替代，接口不变。
 */
@Injectable()
export class AdminPlayersService {
  private readonly logger = new Logger(AdminPlayersService.name);
  private summaryCache: { at: number; data: Omit<PlayersSummary, 'onlineNow'> } | null = null;

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly configCache: ConfigCacheService,
  ) {}

  async list(query: PlayersQuery): Promise<{
    items: PlayerRow[];
    page: number;
    pageSize: number;
    total: number;
    summary: PlayersSummary;
    onlineDegraded: boolean;
  }> {
    const now = Date.now();
    const onlineIds = await this.onlineIds(now);
    const where = this.buildWhere(query, onlineIds);
    // 在线筛选在集合为空时的短路（offline 不需要 NOT IN 空集）
    if (query.online === 'online' && onlineIds !== null && onlineIds.size === 0) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        summary: await this.summary(now, onlineIds),
        onlineDegraded: onlineIds === null,
      };
    }

    const from = PLAYERS_FROM_SQL;
    const lastActive = LAST_ACTIVE_MS_EXPR;

    const countRows = (await this.dataSource.query(
      `SELECT COUNT(*) AS total ${from} WHERE ${where.sql}`,
      where.params,
    )) as Array<{ total: unknown }>;
    const total = Number(countRows[0]?.total ?? 0);

    const order = query.sort === 'created' ? 'u.createdAt DESC, u.id DESC' : `${lastActive} DESC, u.id DESC`;
    const rows = (await this.dataSource.query(
      `SELECT u.id, u.phone, u.nickname, u.status, u.createdAt, ${lastActive} AS last_active_ms
       ${from} WHERE ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...where.params, query.pageSize, (query.page - 1) * query.pageSize],
    )) as Array<{
      id: unknown;
      phone: unknown;
      nickname: unknown;
      status: unknown;
      createdAt: unknown;
      last_active_ms: unknown;
    }>;

    const ids = rows.map((r) => String(r.id));
    const enrich = await this.enrich(ids, now);
    const items = rows.map((r) => {
      const userId = String(r.id);
      const e = enrich.get(userId) ?? { devices: 0, games: 0, wins: 0, lastGame: null, riskStatus: null };
      return {
        userId,
        phone: String(r.phone),
        nickname: r.nickname === null || r.nickname === undefined ? null : String(r.nickname),
        status: String(r.status),
        createdAt: toEpochMs(r.createdAt),
        lastActiveAt:
          r.last_active_ms === null || r.last_active_ms === undefined
            ? null
            : Number(r.last_active_ms),
        online: onlineIds !== null && onlineIds.has(userId),
        deviceCount: e.devices,
        games: e.games,
        wins: e.wins,
        lastGameAt: e.lastGame,
        riskStatus: e.riskStatus,
      };
    });

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      summary: await this.summary(now, onlineIds),
      onlineDegraded: onlineIds === null,
    };
  }

  async recentGames(userId: string, limit: number): Promise<
    Array<{
      recordId: number;
      gameType: 'doudizhu' | 'paodekuai';
      mode: string;
      baseScore: number;
      role: string | null;
      won: boolean;
      scoreChange: number;
      moneyDelta: number | null;
      endedAt: number;
    }>
  > {
    const users = (await this.dataSource.query('SELECT id FROM users WHERE id = ? LIMIT 1', [
      userId,
    ])) as Array<{ id: unknown }>;
    if (users.length === 0) throw new DomainError(ErrCode.USER_NOT_FOUND, '未找到该用户');

    // 两表各自取 limit 后合并（排序/截断在合并后做；不按 mode 过滤 —— 保留 DDZ 现行为）。
    const [ddzRows, pdkRows] = await Promise.all([
      this.dataSource.query(
        `SELECT p.record_id, r.mode, r.base_score, p.role, p.won, p.score_change, p.money_delta, p.ended_at
         FROM game_record_players p JOIN game_records r ON r.id = p.record_id
         WHERE p.user_id = ? AND p.is_robot = 0
         ORDER BY p.ended_at DESC, p.record_id DESC LIMIT ?`,
        [userId, limit],
      ) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(
        `SELECT p.record_id, r.mode, r.base_score, NULL AS role, p.won, p.score_change,
                p.money_delta, p.ended_at
         FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id
         WHERE p.user_id = ? AND p.is_robot = 0
         ORDER BY p.ended_at DESC, p.record_id DESC LIMIT ?`,
        [userId, limit],
      ) as Promise<Array<Record<string, unknown>>>,
    ]);

    const merged = [
      ...ddzRows.map((r) => ({
        recordId: Number(r.record_id),
        gameType: 'doudizhu' as const,
        mode: String(r.mode),
        baseScore: Number(r.base_score),
        role: String(r.role),
        won: Number(r.won) === 1,
        scoreChange: Number(r.score_change),
        moneyDelta:
          r.money_delta === null || r.money_delta === undefined ? null : Number(r.money_delta),
        endedAt: toEpochMs(r.ended_at),
      })),
      ...pdkRows.map((r) => ({
        recordId: Number(r.record_id),
        gameType: 'paodekuai' as const,
        mode: String(r.mode),
        baseScore: Number(r.base_score),
        role: r.role === null || r.role === undefined ? null : String(r.role),
        won: Number(r.won) === 1,
        scoreChange: Number(r.score_change),
        moneyDelta:
          r.money_delta === null || r.money_delta === undefined ? null : Number(r.money_delta),
        endedAt: Number(r.ended_at),
      })),
    ];
    merged.sort(
      (a, b) =>
        b.endedAt - a.endedAt ||
        b.recordId - a.recordId ||
        a.gameType.localeCompare(b.gameType),
    );
    return merged.slice(0, limit);
  }

  /** 在线集合；Redis 失败 ⇒ null（调用方降级）。 */
  async onlineIds(now: number): Promise<Set<string> | null> {
    try {
      const ids = await this.redis.zrangebyscore(ONLINE_USERS_KEY, `(${now - ONLINE_TTL_MS}`, '+inf');
      // 上限保护：超大在线集不生成巨型 IN (...)；降级为「不筛选 + 全员离线」并提示。
      if (ids.length > 10_000) {
        this.logger.warn(`presence set too large (${ids.length} > 10000) — online filter degraded`);
        return null;
      }
      return new Set(ids.map((id) => String(id)));
    } catch (err) {
      this.logger.warn(`presence read failed: ${String(err)}`);
      return null;
    }
  }

  async isOnline(userId: string, now = Date.now()): Promise<boolean> {
    try {
      const score = await this.redis.zscore(ONLINE_USERS_KEY, userId);
      return score !== null && Number(score) > now - ONLINE_TTL_MS;
    } catch (err) {
      this.logger.warn(`presence zscore failed for ${userId}: ${String(err)}`);
      return false;
    }
  }

  private buildWhere(
    query: PlayersQuery,
    onlineIds: Set<string> | null,
  ): { sql: string; params: unknown[] } {
    const parts: string[] = ['1=1'];
    const params: unknown[] = [];
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      parts.push('(u.phone LIKE ? OR u.nickname LIKE ? OR u.id = ?)');
      params.push(like, like, query.q);
    }
    if (query.status) {
      parts.push('u.status = ?');
      params.push(query.status);
    }
    if (onlineIds !== null && query.online === 'online') {
      if (onlineIds.size === 0) parts.push('1=0');
      else {
        const ids = [...onlineIds];
        parts.push(`u.id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      }
    } else if (onlineIds !== null && query.online === 'offline' && onlineIds.size > 0) {
      const ids = [...onlineIds];
      parts.push(`u.id NOT IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (query.activity) {
      const now = Date.now();
      const lastActive = `(${LAST_ACTIVE_MS_EXPR})`;
      if (query.activity === 'active7' || query.activity === 'active30') {
        const days = query.activity === 'active7' ? 7 : 30;
        parts.push(`${lastActive} >= ?`);
        params.push(now - days * DAY_MS); // epoch ms（不是 Date）
      } else {
        const days = query.activity === 'inactive14' ? 14 : 30;
        // 排除注册不足窗口的新用户；从未活跃且已过窗口的用户计入流失。
        parts.push(`(${lastActive} IS NULL OR ${lastActive} < ?) AND u.createdAt < ?`);
        params.push(now - days * DAY_MS, new Date(now - days * DAY_MS));
      }
    }
    return { sql: parts.join(' AND '), params };
  }

  private async enrich(
    ids: string[],
    now: number,
  ): Promise<Map<string, { devices: number; games: number; wins: number; lastGame: number | null; riskStatus: string | null }>> {
    const out = new Map<string, { devices: number; games: number; wins: number; lastGame: number | null; riskStatus: string | null }>();
    if (ids.length === 0) return out;
    const ph = ids.map(() => '?').join(',');
    const [deviceRows, gameRows, pdkGameRows, riskRows] = await Promise.all([
      this.dataSource.query(
        `SELECT user_id, COUNT(DISTINCT device_id) AS devices FROM user_devices
         WHERE user_id IN (${ph}) AND last_seen_at >= ? GROUP BY user_id`,
        [...ids, new Date(now - this.configCache.riskDeviceWindowDays() * DAY_MS)],
      ) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(
        `SELECT p.user_id, COUNT(*) AS games, SUM(p.won) AS wins, MAX(p.ended_at) AS last_game
         FROM game_record_players p JOIN game_records r ON r.id = p.record_id
         WHERE p.user_id IN (${ph}) AND p.is_robot = 0 AND r.mode IN ('random','gold')
         GROUP BY p.user_id`,
        ids,
      ) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(
        `SELECT p.user_id, COUNT(*) AS games, SUM(p.won) AS wins, MAX(p.ended_at) AS last_game_ms
         FROM game_record_players_pdk p JOIN game_records_pdk r ON r.id = p.record_id
         WHERE p.user_id IN (${ph}) AND p.is_robot = 0 AND r.mode IN ('random','gold')
         GROUP BY p.user_id`,
        ids,
      ) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(
        `SELECT r.user_id, r.status FROM risk_reviews r
         JOIN (SELECT user_id, MAX(id) AS id FROM risk_reviews WHERE user_id IN (${ph}) GROUP BY user_id) m
           ON m.id = r.id`,
        ids,
      ) as Promise<Array<Record<string, unknown>>>,
    ]);
    for (const id of ids) out.set(id, { devices: 0, games: 0, wins: 0, lastGame: null, riskStatus: null });
    for (const r of deviceRows) out.get(String(r.user_id))!.devices = Number(r.devices ?? 0);
    for (const r of gameRows) {
      const e = out.get(String(r.user_id))!;
      e.games = Number(r.games ?? 0);
      e.wins = Number(r.wins ?? 0);
      e.lastGame = r.last_game === null || r.last_game === undefined ? null : toEpochMs(r.last_game);
    }
    // A2：PDK 聚合并入（games/wins 相加；lastGame 取较晚者，BIGINT ms）
    for (const r of pdkGameRows) {
      const e = out.get(String(r.user_id))!;
      e.games += Number(r.games ?? 0);
      e.wins += Number(r.wins ?? 0);
      if (r.last_game_ms !== null && r.last_game_ms !== undefined) {
        const ms = Number(r.last_game_ms);
        if (Number.isFinite(ms)) e.lastGame = e.lastGame === null ? ms : Math.max(e.lastGame, ms);
      }
    }
    for (const r of riskRows) out.get(String(r.user_id))!.riskStatus = String(r.status);
    return out;
  }

  private async summary(now: number, onlineIds: Set<string> | null): Promise<PlayersSummary> {
    // 优先读统计任务写的快照；缺失/损坏/过期 ⇒ 回退实时聚合（60s 缓存）。
    const base = (await this.snapshotSummary()) ?? (await this.summaryBase(now));
    // 在线集合读取失败 ⇒ 在线数按 0 降级（与行的 online=false 同口径，不二次探测）。
    return { ...base, onlineNow: onlineIds === null ? 0 : onlineIds.size };
  }

  /** 读 `players:summary` 快照（统计任务每 5 分钟写）；失败/缺字段 ⇒ null。 */
  private async snapshotSummary(): Promise<Omit<PlayersSummary, 'onlineNow'> | null> {
    try {
      const raw = await this.redis.get(PLAYERS_SUMMARY_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw) as Record<string, unknown>;
      const keys = ['totalPlayers', 'newToday', 'new7d', 'active1d', 'active7d', 'active30d', 'inactive14d', 'inactive30d', 'neverActive'];
      if (!keys.every((k) => typeof j[k] === 'number')) return null;
      return {
        totalPlayers: Number(j.totalPlayers), newToday: Number(j.newToday), new7d: Number(j.new7d),
        active1d: Number(j.active1d), active7d: Number(j.active7d), active30d: Number(j.active30d),
        inactive14d: Number(j.inactive14d), inactive30d: Number(j.inactive30d), neverActive: Number(j.neverActive),
      };
    } catch {
      return null;
    }
  }

  /** 汇总（含 60s 缓存；统计任务直接调用）。 */
  async summaryBase(now: number): Promise<Omit<PlayersSummary, 'onlineNow'>> {
    if (this.summaryCache && now - this.summaryCache.at < SUMMARY_TTL_MS) return this.summaryCache.data;
    const dayStart = beijingDayStart(now);
    const rows = (await this.dataSource.query(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN t.createdAt >= ? THEN 1 ELSE 0 END) AS new_today,
        SUM(CASE WHEN t.createdAt >= ? THEN 1 ELSE 0 END) AS new_7d,
        SUM(CASE WHEN t.last_active_ms >= ? THEN 1 ELSE 0 END) AS active_1d,
        SUM(CASE WHEN t.last_active_ms >= ? THEN 1 ELSE 0 END) AS active_7d,
        SUM(CASE WHEN t.last_active_ms >= ? THEN 1 ELSE 0 END) AS active_30d,
        SUM(CASE WHEN (t.last_active_ms IS NULL OR t.last_active_ms < ?) AND t.createdAt < ? THEN 1 ELSE 0 END) AS inactive_14d,
        SUM(CASE WHEN (t.last_active_ms IS NULL OR t.last_active_ms < ?) AND t.createdAt < ? THEN 1 ELSE 0 END) AS inactive_30d,
        SUM(CASE WHEN t.last_active_ms IS NULL THEN 1 ELSE 0 END) AS never_active
       FROM (
         SELECT u.createdAt, ${LAST_ACTIVE_MS_EXPR} AS last_active_ms
         ${PLAYERS_FROM_SQL}
       ) t`,
      [
        new Date(dayStart),
        new Date(now - 7 * DAY_MS),
        now - 1 * DAY_MS,
        now - 7 * DAY_MS,
        now - 30 * DAY_MS,
        now - 14 * DAY_MS,
        new Date(now - 14 * DAY_MS),
        now - 30 * DAY_MS,
        new Date(now - 30 * DAY_MS),
      ],
    )) as Array<Record<string, unknown>>;
    const r = rows[0] ?? {};
    const data = {
      totalPlayers: Number(r.total ?? 0),
      newToday: Number(r.new_today ?? 0),
      new7d: Number(r.new_7d ?? 0),
      active1d: Number(r.active_1d ?? 0),
      active7d: Number(r.active_7d ?? 0),
      active30d: Number(r.active_30d ?? 0),
      inactive14d: Number(r.inactive_14d ?? 0),
      inactive30d: Number(r.inactive_30d ?? 0),
      neverActive: Number(r.never_active ?? 0),
    };
    this.summaryCache = { at: now, data };
    return data;
  }
}

/** 北京时间自然日 00:00（epoch ms）；照 admin/app.js 的 beijingDayStart 同口径。 */
export function beijingDayStart(ms: number): number {
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
    8 * 60 * 60 * 1000
  );
}

function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(String(value)).getTime();
}

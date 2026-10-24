import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrCode, decodeCards, decodeHand, type Card, type PdkRecord } from '@fight-the-landlord/protocol';
import { DomainError } from '../http/errors';

/**
 * 记录片 T6（规格 §2.3 / 设计 D4）：`GET /api/records/mine` 的**查询面**。
 *
 * ─── 口径（逐条对应规格/设计）────────────────────────────────────────────
 *  - **只本人**（C6）：`WHERE mine.user_id = ?` **等值写死**——身份只来自网关验签后注入的
 *    `X-User-Id`（控制器侧），本文件不接受任何客户端可控的过滤参数；别人的记录行
 *    **从不**出现在任何一次查询的结果里（负对照在 `records.query.test.ts`）。
 *  - **keyset**（`ended_at DESC, id DESC`）：游标 = 服务端内编码的 `(ended_at, mine.id)`。
 *    页大小取 `limit + 1` 行判「还有下一页」；`nextCursor` 出自**本页最后一条**，
 *    终页（`hasMore=false`）为 `null`。
 *  - **`nextCursor` 不透明**：`base64url(epochMs:id)` —— 编码规则收在本文件内部
 *    （客户端/网关只做原样回传）；⚠️ 必须是 **URL 安全**字母表：`+` 在查询串往返里会被
 *    解成空格（网关侧注释有同一条）。
 *  - **`limit` 缺省 20 / 上限 100 / clamp**（非正、非数字 ⇒ 缺省）。
 *  - **DTO 逐字 12 键**（`MyRecord`，② 金币场 +`moneyDelta`）：显式逐键构造（绝不 spread
 *    库行）——`userId`/`playerId`/`robotId`/`isRobot`/`deviceId`/`startedAt` **永不出站**
 *    （C7 的唯一机械防线在 T9 真栈；单测里有同形态的递归恰好键集断言器）。
 *    `money_delta` 只以**我那一行**的值出站（`moneyDelta`；NULL = 非金币场 / 尚未回写 ⇒
 *    客户端显「—」），三家明细里不出现任何一家的 delta。
 *  - **epoch ms**：`ended_at`/`started_at` 是 `datetime(3)` ⇒ 出站前一律转毫秒整数
 *    （不接受 Date 对象直接进 JSON —— 那会变成 ISO 字符串，形状漂移）。
 *  - `mySeat`：**自 JOIN 命中行**（`mine.seat`）——我那一行的座位，不是「猜」出来的。
 *  - `players`：按 `seat` 升序恰 3 条（行由写入侧事务保证成套；这里只组装 + 排序）。
 *
 * ⚠️ `DataSource` 是**值导入**（DI 陷阱：`import type` 会让真容器解析不到 token，而
 * 单测与 tsc 都看不见）。
 * ⚠️ 读取路径**不重编码**牌串（`hand`/`bottom_cards` 落库即 T1 codec 的定长 hex）——
 * 解码的**唯一实现**是 `decodeHand/decodeCards`，本文件不另写一份。
 */

/** 每页缺省条数（规格 §2.3）。 */
export const RECORDS_DEFAULT_LIMIT = 20;
/** 每页上限（服务端 clamp，规格 §2.3）。 */
export const RECORDS_MAX_LIMIT = 100;

/** 合法的 mode 筛选值（与 MyRecord['mode'] 逐字对齐）。 */
export const RECORDS_MODE_VALUES = ['random', 'practice', 'gold'] as const;
export type RecordsMode = (typeof RECORDS_MODE_VALUES)[number];

export interface MyRecordPlayer {
  seat: number;
  nickname: string | null;
  role: 'landlord' | 'farmer';
  scoreChange: number;
  won: boolean;
  hand: Card[];
}

export interface MyRecord {
  roomCode: string;
  /** ② 金币场 §2.1：三值（`gold` 行由战绩页渲染金币列/中文映射）。 */
  mode: 'random' | 'practice' | 'gold';
  endedAt: number;
  baseScore: number;
  winner: 'landlord' | 'farmer';
  landlordSeat: number;
  multiplier: number;
  spring: 'none' | 'spring' | 'anti-spring';
  mySeat: number;
  /** 我那一行的金币变动（② 金币场；NULL = 非金币场 / 尚未回写 ⇒ 客户端显「—」）。 */
  moneyDelta: number | null;
  bottomCards: Card[];
  players: MyRecordPlayer[];
}

export interface MyRecordsPage {
  items: MyRecord[];
  nextCursor: string | null;
}

/* ------------------------------------------------------------------ *
 * 跑得快战绩查询（S7.2 / spec §4.9.2 / D11：**单独的两张表**）
 *
 * 形状与斗地主不同：无地主/底牌；剩余张数/倍数/标记/分差来自父行；
 * `playedCount` 与初始手牌来自玩家行。旧客户端不传 gameType ⇒ 永远只查斗地主表。
 * ------------------------------------------------------------------ */

/** 跑得快一页（`PdkRecord` 由 protocol 定义 —— 客户端/服务端同形）。 */
export interface PdkRecordsPage {
  items: PdkRecord[];
  nextCursor: string | null;
}

/** pdk 页面查询行形态（列名即 SQL 别名）。 */
interface PdkPageRow {
  mine_id: number | string;
  my_seat: number | string;
  money_delta: number | string | null;
  ended_at: number | string;
  record_id: number | string;
  room_code: string;
  mode: string;
  player_count: number | string;
  base_score: number | string;
  winner_seat: number | string;
  remaining: unknown;
  multiplier: number | string;
  bomb_count: number | string;
  guan: unknown;
  spring: unknown;
  baoben_seats: unknown;
  score_changes: unknown;
}

/** pdk 玩家行形态（`won` 由父行 winner_seat 派生，不落库）。 */
interface PdkPlayerRow {
  record_id: number | string;
  seat: number | string;
  nickname: string | null;
  hand: string;
  played_count: number | string;
}

/** JSON 列驱动可能回对象或字符串 ⇒ 归一。 */
function jsonOf<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/** `limit` clamp（缺省 20 / 上限 100；非正、非数字 ⇒ 缺省；小数向下取整）。 */
export function clampRecordsLimit(raw: unknown): number {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim().length > 0) n = Number(raw);
  else return RECORDS_DEFAULT_LIMIT;
  if (!Number.isFinite(n)) return RECORDS_DEFAULT_LIMIT;
  const limit = Math.floor(n);
  if (limit < 1) return RECORDS_DEFAULT_LIMIT;
  return Math.min(limit, RECORDS_MAX_LIMIT);
}

/** 不透明游标的明文形态：`epochMs:playerRowId`（收在服务端内部）。 */
const CURSOR_RE = /^(\d{1,15}):(\d{1,15})$/;

function throwInvalidParam(field: string): never {
  throw new DomainError(ErrCode.BAD_PARAM, `records 筛选参数不合法：${field} 须为 ${RECORDS_MODE_VALUES.join('/')}`);
}

/**
 * 日期范围解析：两个值都是整数 epoch ms 才返回区间（`from` 含、`to` 不含）；否则返回 `null`。
 * 允许只传一个（缺省为 0 / Infinity），允许 to <= from（空区间）。
 * 值非整数 / 非 number 形态 ⇒ `null`（不抛错，筛选静默跳过）。
 */
function parseDateRange(from: unknown, to: unknown): { fromMs: number; toMs: number } | null {
  const fromMs = typeof from === 'number' && Number.isFinite(from) && Number.isInteger(from) ? from : null;
  const toMs = typeof to === 'number' && Number.isFinite(to) && Number.isInteger(to) ? to : null;
  if (fromMs === null && toMs === null) return null;
  // ⚠️ 不能用 Number.MAX_SAFE_INTEGER —— 超过 Date 能表示的范围（±8.64e15ms），会抛 "Invalid time value"
  return {
    fromMs: fromMs ?? 0,
    toMs: toMs ?? 8640000000000000,
  };
}

const invalidCursor = (): DomainError =>
  new DomainError(ErrCode.BAD_PARAM, 'cursor 不合法：须为本服务签发的 nextCursor 原样回传');

/** `(endedAt, id)` ⇒ 不透明串（base64url —— URL 安全，见文件头）。 */
export function encodeRecordsCursor(endedAtMs: number, playerRowId: number): string {
  return Buffer.from(`${endedAtMs}:${playerRowId}`, 'utf8').toString('base64url');
}

/**
 * 不透明串 ⇒ `(endedAt, id)`。非法形态**当场拒**（`10001`），不静默回落第一页 ——
 * 静默回落会让「客户端忘了更新游标」变成永远翻第一页的死循环，而且看不到任何信号。
 * 复核顺序：① 非空字符串；② `decode → re-encode == 原值`（拦 base64url 容错解码下的
 * 非规范形态）；③ 形态 `digits:digits`；④ 安全整数且 id ≥ 1。
 */
export function decodeRecordsCursor(cursor: string): { endedAtMs: number; playerRowId: number } {
  if (typeof cursor !== 'string' || cursor.length === 0) throw invalidCursor();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw invalidCursor();
  const m = CURSOR_RE.exec(decoded);
  if (!m) throw invalidCursor();
  const endedAtMs = Number(m[1]);
  const playerRowId = Number(m[2]);
  if (!Number.isSafeInteger(endedAtMs) || !Number.isSafeInteger(playerRowId) || playerRowId < 1) {
    throw invalidCursor();
  }
  return { endedAtMs, playerRowId };
}

/**
 * BIGINT 毫秒列的驱动形态 ⇒ number（mysql2 对 BIGINT 默认回字符串）。
 * ⚠️ 不能走 `new Date(String(...))`（那是 datetime 列的口径；纯数字串会得到 Invalid Date）。
 */
function bigintMs(value: unknown): number {
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** `datetime(3)` 的三种驱动形态 ⇒ epoch ms 整数。 */
function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(String(value)).getTime();
}

/** 页面查询（JOIN game_records）的行形态——列名即 SQL 别名。 */
interface PageRow {
  mine_id: number | string;
  my_seat: number | string;
  money_delta: number | string | null;
  ended_at: Date | string;
  record_id: number | string;
  room_code: string;
  mode: string;
  base_score: number | string;
  winner: string;
  landlord_seat: number | string;
  multiplier: number | string;
  spring: string;
  bottom_cards: string;
}

/** 附页查询（按 record_id IN）的行形态。 */
interface PlayerRow {
  record_id: number | string;
  seat: number | string;
  nickname: string | null;
  role: string;
  score_change: number | string;
  won: unknown;
  hand: string;
}

@Injectable()
export class RecordsService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /**
   * 「我的历史战绩」一页。`userId` 由控制器从 `X-User-Id` 传入（网关验签产物）——
   * 本方法**不得**接受其它身份过滤参数（只本人）。
   *
   * 筛选参数（可选，全部走参数化绑定）：
   *  - `mode`：精确匹配（'random' | 'practice' | 'gold'）；非法值抛 BAD_PARAM；缺省不过滤。
   *  - `from` / `to`：epoch ms 整数；`from` 含、`to` 不含（`[from, to)`）；缺省不过滤。
   */
  async getMyRecords(
    userId: string,
    query: { cursor?: unknown; limit?: unknown; mode?: unknown; from?: unknown; to?: unknown } = {},
  ): Promise<MyRecordsPage> {
    const limit = clampRecordsLimit(query.limit);
    // 游标**先于任何查询**校验：非法形态 ⇒ 400，不落一次库。
    const cursor = query.cursor === undefined ? null : decodeRecordsCursor(query.cursor as string);

    // mode 筛选：必须是合法值或缺省
    const mode =
      typeof query.mode === 'string' && RECORDS_MODE_VALUES.includes(query.mode as RecordsMode)
        ? (query.mode as RecordsMode)
        : query.mode === undefined
          ? null
          : throwInvalidParam('mode');

    // 日期范围筛选：两个都是整数 epoch ms 才生效
    const dateRange = parseDateRange(query.from, query.to);

    const pageRows = await this.queryPage(userId, cursor, limit, mode, dateRange);
    const hasMore = pageRows.length > limit;
    const rows = hasMore ? pageRows.slice(0, limit) : pageRows;
    if (rows.length === 0) return { items: [], nextCursor: null };

    const playersByRecord = await this.queryPlayers(rows.map((row) => Number(row.record_id)));
    const items = rows.map((row) => this.toDto(row, playersByRecord.get(String(row.record_id)) ?? []));

    const last = rows[rows.length - 1]!;
    const nextCursor = hasMore
      ? encodeRecordsCursor(toEpochMs(last.ended_at), Number(last.mine_id))
      : null;
    return { items, nextCursor };
  }

  /**
   * 跑得快「我的历史战绩」一页（S7.2）。
   *
   * 与斗地主同一条 keyset/游标/分页规则（`(ended_at, mine.id)`），只是换两张 pdk 表；
   * 身份过滤只本人（`mine.user_id = ?`）。日期范围对 BIGINT 毫秒列直接传 number。
   */
  async getMyPdkRecords(
    userId: string,
    query: { cursor?: unknown; limit?: unknown; mode?: unknown; from?: unknown; to?: unknown } = {},
  ): Promise<PdkRecordsPage> {
    const limit = clampRecordsLimit(query.limit);
    const cursor = query.cursor === undefined ? null : decodeRecordsCursor(query.cursor as string);
    const mode =
      typeof query.mode === 'string' && RECORDS_MODE_VALUES.includes(query.mode as RecordsMode)
        ? (query.mode as RecordsMode)
        : query.mode === undefined
          ? null
          : throwInvalidParam('mode');
    const dateRange = parseDateRange(query.from, query.to);

    const pageRows = await this.queryPdkPage(userId, cursor, limit, mode, dateRange);
    const hasMore = pageRows.length > limit;
    const rows = hasMore ? pageRows.slice(0, limit) : pageRows;
    if (rows.length === 0) return { items: [], nextCursor: null };

    const playersByRecord = await this.queryPdkPlayers(rows.map((row) => Number(row.record_id)));
    const items = rows.map((row) =>
      this.toPdkDto(row, playersByRecord.get(String(row.record_id)) ?? []),
    );

    const last = rows[rows.length - 1]!;
    const nextCursor = hasMore
      ? encodeRecordsCursor(bigintMs(last.ended_at), Number(last.mine_id))
      : null;
    return { items, nextCursor };
  }

  /** pdk keyset 页面（同斗地主：`ended_at DESC, mine.id DESC`；`ended_at` 是 BIGINT 毫秒）。 */
  private async queryPdkPage(
    userId: string,
    cursor: { endedAtMs: number; playerRowId: number } | null,
    limit: number,
    mode: RecordsMode | null,
    dateRange: { fromMs: number; toMs: number } | null,
  ): Promise<PdkPageRow[]> {
    const whereClauses: string[] = ['mine.`user_id` = ?'];
    const params: unknown[] = [userId];

    if (mode !== null) {
      whereClauses.push('r.`mode` = ?');
      params.push(mode);
    }
    if (dateRange !== null) {
      whereClauses.push('mine.`ended_at` >= ?');
      params.push(dateRange.fromMs);
      whereClauses.push('mine.`ended_at` < ?');
      params.push(dateRange.toMs);
    }
    if (cursor) {
      whereClauses.push('(mine.`ended_at` < ? OR (mine.`ended_at` = ? AND mine.`id` < ?))');
      params.push(cursor.endedAtMs, cursor.endedAtMs, cursor.playerRowId);
    }

    const sql =
      'SELECT mine.`id` AS `mine_id`, mine.`seat` AS `my_seat`, mine.`money_delta`, mine.`ended_at` AS `ended_at`, ' +
      'r.`id` AS `record_id`, r.`room_code`, r.`mode`, r.`player_count`, r.`base_score`, r.`winner_seat`, ' +
      'r.`remaining`, r.`multiplier`, r.`bomb_count`, r.`guan`, r.`spring`, r.`baoben_seats`, r.`score_changes` ' +
      'FROM `game_record_players_pdk` mine ' +
      'JOIN `game_records_pdk` r ON r.`id` = mine.`record_id` ' +
      `WHERE ${whereClauses.join(' AND ')} ` +
      'ORDER BY mine.`ended_at` DESC, mine.`id` DESC LIMIT ?';

    params.push(limit + 1);
    return (await this.dataSource.query(sql, params)) as PdkPageRow[];
  }

  /** pdk 附页：本页各局的全部玩家行（初始手牌 + playedCount）。 */
  private async queryPdkPlayers(recordIds: number[]): Promise<Map<string, PdkPlayerRow[]>> {
    const byRecord = new Map<string, PdkPlayerRow[]>();
    if (recordIds.length === 0) return byRecord;
    const placeholders = recordIds.map(() => '?').join(', ');
    const rows = (await this.dataSource.query(
      'SELECT `record_id`, `seat`, `nickname`, `hand`, `played_count` ' +
        `FROM \`game_record_players_pdk\` WHERE \`record_id\` IN (${placeholders}) ` +
        'ORDER BY `record_id` ASC, `seat` ASC',
      recordIds,
    )) as PdkPlayerRow[];
    for (const row of rows) {
      const key = String(row.record_id);
      const list = byRecord.get(key) ?? [];
      list.push(row);
      byRecord.set(key, list);
    }
    return byRecord;
  }

  /** 逐键构造 `PdkRecord`（不 spread 库行；`won` 由 winner_seat 派生）。 */
  private toPdkDto(row: PdkPageRow, players: PdkPlayerRow[]): PdkRecord {
    const playerCount = Number(row.player_count) as 2 | 3 | 4;
    const handSize = playerCount === 4 ? 12 : 16;
    const winnerSeat = Number(row.winner_seat);
    const scoreChanges = jsonOf<Array<{ seat: number; delta: number }>>(row.score_changes, []);
    const deltaBySeat = new Map(scoreChanges.map((c) => [Number(c.seat), Number(c.delta)]));
    return {
      gameType: 'paodekuai',
      roomCode: String(row.room_code),
      playerCount,
      mode: row.mode as PdkRecord['mode'],
      endedAt: bigintMs(row.ended_at),
      baseScore: Number(row.base_score),
      winnerSeats: [winnerSeat],
      remaining: jsonOf<number[]>(row.remaining, []).map(Number),
      multiplier: Number(row.multiplier),
      bombCount: Number(row.bomb_count),
      guan: Boolean(Number(row.guan)),
      spring: Boolean(Number(row.spring)),
      baobenSeats: jsonOf<number[]>(row.baoben_seats, []).map(Number),
      scoreChanges: scoreChanges.map((c) => ({ seat: Number(c.seat), delta: Number(c.delta) })),
      mySeat: Number(row.my_seat),
      moneyDelta:
        row.money_delta === null || row.money_delta === undefined ? null : Number(row.money_delta),
      players: [...players]
        .sort((a, b) => Number(a.seat) - Number(b.seat))
        .map((p) => ({
          seat: Number(p.seat),
          nickname: p.nickname,
          scoreChange: deltaBySeat.get(Number(p.seat)) ?? 0,
          won: Number(p.seat) === winnerSeat,
          playedCount: Number(p.played_count),
          hand: decodeHand(String(p.hand), handSize),
        })),
    };
  }

  /**
   * keyset 页面：`WHERE user_id = ? [AND mode = ?] [AND date range] [AND cursor] ORDER BY ... LIMIT ?`。
   * 动态追加 WHERE 条件，全部走参数化绑定。
   */
  private async queryPage(
    userId: string,
    cursor: { endedAtMs: number; playerRowId: number } | null,
    limit: number,
    mode: RecordsMode | null,
    dateRange: { fromMs: number; toMs: number } | null,
  ): Promise<PageRow[]> {
    const whereClauses: string[] = ['mine.`user_id` = ?'];
    const params: unknown[] = [userId];

    if (mode !== null) {
      whereClauses.push('r.`mode` = ?');
      params.push(mode);
    }
    if (dateRange !== null) {
      whereClauses.push('mine.`ended_at` >= ?');
      params.push(new Date(dateRange.fromMs));
      whereClauses.push('mine.`ended_at` < ?');
      params.push(new Date(dateRange.toMs));
    }
    if (cursor) {
      whereClauses.push('(mine.`ended_at` < ? OR (mine.`ended_at` = ? AND mine.`id` < ?))');
      params.push(new Date(cursor.endedAtMs), new Date(cursor.endedAtMs), cursor.playerRowId);
    }

    const sql =
      'SELECT mine.`id` AS `mine_id`, mine.`seat` AS `my_seat`, mine.`money_delta`, mine.`ended_at` AS `ended_at`, ' +
      'r.`id` AS `record_id`, r.`room_code`, r.`mode`, r.`base_score`, r.`winner`, ' +
      'r.`landlord_seat`, r.`multiplier`, r.`spring`, r.`bottom_cards` ' +
      'FROM `game_record_players` mine ' +
      'JOIN `game_records` r ON r.`id` = mine.`record_id` ' +
      `WHERE ${whereClauses.join(' AND ')} ` +
      'ORDER BY mine.`ended_at` DESC, mine.`id` DESC LIMIT ?';

    params.push(limit + 1); // 多取一行：判 hasMore，不入响应
    return (await this.dataSource.query(sql, params)) as PageRow[];
  }

  /** 附页：本页各局的**三家**玩家行（JOIN 只带回我那一行；这里补齐整局明细）。 */
  private async queryPlayers(recordIds: number[]): Promise<Map<string, PlayerRow[]>> {
    const byRecord = new Map<string, PlayerRow[]>();
    if (recordIds.length === 0) return byRecord; // 空页不发出非法 `IN ()`
    const placeholders = recordIds.map(() => '?').join(', ');
    const rows = (await this.dataSource.query(
      'SELECT `record_id`, `seat`, `nickname`, `role`, `score_change`, `won`, `hand` ' +
        `FROM \`game_record_players\` WHERE \`record_id\` IN (${placeholders}) ` +
        'ORDER BY `record_id` ASC, `seat` ASC',
      recordIds,
    )) as PlayerRow[];
    for (const row of rows) {
      const key = String(row.record_id);
      const list = byRecord.get(key) ?? [];
      list.push(row);
      byRecord.set(key, list);
    }
    return byRecord;
  }

  /** 逐键构造 12 键 DTO（**绝不** spread 库行 —— C7 白名单靠这条纪律成立）。 */
  private toDto(row: PageRow, players: PlayerRow[]): MyRecord {
    return {
      roomCode: String(row.room_code),
      mode: row.mode as MyRecord['mode'],
      endedAt: toEpochMs(row.ended_at),
      baseScore: Number(row.base_score),
      winner: row.winner as MyRecord['winner'],
      landlordSeat: Number(row.landlord_seat),
      multiplier: Number(row.multiplier),
      spring: row.spring as MyRecord['spring'],
      mySeat: Number(row.my_seat),
      // NULL 是值（非金币场 / 尚未回写 ⇒「—」），不下沉成 0 也不缺键。
      moneyDelta: row.money_delta === null || row.money_delta === undefined ? null : Number(row.money_delta),
      bottomCards: decodeCards(String(row.bottom_cards)),
      players: [...players]
        .sort((a, b) => Number(a.seat) - Number(b.seat))
        .map((p) => ({
          seat: Number(p.seat),
          nickname: p.nickname === null || p.nickname === undefined ? null : String(p.nickname),
          role: p.role as MyRecordPlayer['role'],
          scoreChange: Number(p.score_change),
          // 库列是 tinyint(1)（0/1）；DTO 契约是布尔 —— 在这里换，不在客户端换。
          won: p.won === 1 || p.won === '1' || p.won === true,
          hand: decodeHand(String(p.hand)),
        })),
    };
  }
}

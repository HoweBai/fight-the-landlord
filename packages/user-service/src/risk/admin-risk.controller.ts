// packages/user-service/src/risk/admin-risk.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CSV_BOM, ErrCode, csvCell } from '@fight-the-landlord/protocol';
import { DomainError, toHttpException, httpException } from '../http/errors';
import { XAdminGuard, adminActorOf, type AdminRequest } from '../http/x-admin.guard';
import {
  AdminRiskService,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type RiskActionItem,
  type RiskActionListFilter,
  type RiskReviewListFilter,
} from './admin-risk.service';
import { ReviewsService, RiskConflictError, type RiskAdminAction } from './reviews.service';
import { DeviceBindingsService } from './device-bindings.service';

/**
 * 风控管理端点（风控片 T6 / 规格 §2.8 四端点逐字；判据 C19 的 HTTP 半边）。
 *
 *  - `GET    /api/admin/risk/reviews`      —— 队列列表（`status&limit(≤100)&cursor&gameType`，keyset）。
 *  - `GET    /api/admin/risk/users/:userId` —— 详情聚合（stats/devices+others/entries/hits/binding）。
 *  - `POST   /api/admin/risk/actions`      —— 五动作（写面；actor fail-closed 在 guard）。
 *  - `GET    /api/admin/risk/actions(.csv)` —— 审计读口 + CSV 变体（BOM/消毒/附件名）。
 *  - `DELETE /api/admin/risk/users/:userId/device-binding` —— 设备绑定片：人工解绑（写面）。
 *
 * 授权 = 网关 policy（T7 的 P-r1..r4 + 设备绑定片 P-r5）；服务侧只认 `X-Admin: 1` +
 * 写面 `X-Admin-Actor`（`XAdminGuard`，风控 T6 已扩展为写面扩强版——DELETE 自动落写面）。
 *
 * 本文件只做三件事：**query/body 白名单与值校验（400 借 10001）**、**响应信封**、**CSV 拼装**
 * （算法本体 = protocol `csvCell`/`CSV_BOM`，**不得复制**；形态照 config-service
 * `audit.controller.ts` 先例）。校验**先于**任何查库（假库零查询被单测钉）。
 *
 * ⚠️ 注册面：本控制器必须在 `src/app.module.ts` 的 `controllers:` 注册 —— 未注册时单测
 * （直接 new）全绿而真容器 404（T6 教训同族）。
 */

type QueryMap = Record<string, unknown>;

/** `GET reviews` 白名单（§2.8：`status&limit&cursor`；B 组加 `gameType`）。 */
export const REVIEWS_QUERY_KEYS: readonly string[] = ['status', 'cursor', 'limit', 'gameType'];
/** `GET actions(.csv)` 白名单（§2.8：`userId&action&actor&from&to` + keyset 两键）。 */
export const ACTIONS_QUERY_KEYS: readonly string[] = [
  'userId',
  'action',
  'actor',
  'from',
  'to',
  'cursor',
  'limit',
];
/** `.csv` 白名单 = JSON 版去掉 `cursor/limit`（带上即视作未知键 ⇒ 400；config 先例同款）。 */
export function csvQueryKeys(keys: readonly string[]): readonly string[] {
  return keys.filter((k) => k !== 'cursor' && k !== 'limit');
}

/** 管理面合法动作集（规格 §2.8 写死：**5 值**；`auto_throttle|reopen` 为系统专用 ⇒ 400）。 */
export const ADMIN_ACTION_VALUES: readonly RiskAdminAction[] = [
  'dismiss',
  'throttle',
  'unthrottle',
  'ban',
  'unban',
];

/* 校验文案（「未知查询参数」为规格逐字；其余就地定死、被单测钉）。 */
const unknownKeyMessage = (key: string) => `未知查询参数：${key}`;
const LIMIT_MESSAGE = `limit 非法：须为 1–${MAX_PAGE_LIMIT} 的整数`;
const CURSOR_MESSAGE = 'cursor 非法：须为正整数';
const EPOCH_MESSAGE = (name: 'from' | 'to') => `${name} 非法：须为非负整数（epoch 毫秒）`;
const LENGTH_MESSAGE = (name: string, max: number) => `${name} 非法：长度须为 1–${max}`;
const USER_ID_MESSAGE = 'userId 非法：长度须为 1–36';
const ACTION_MESSAGE = `action 非法：管理面合法动作 = ${ADMIN_ACTION_VALUES.join('|')}`;
const REASON_MESSAGE = 'reason 非法：须为 1–200 字符的非空字符串';
const REVIEW_ID_MESSAGE = 'reviewId 非法：须为正整数';

function badRequest(message: string): HttpException {
  return httpException(ErrCode.BAD_PARAM, message);
}

/**
 * admin 面借码信封（404/409 借 10001 的状态不在 `http/errors.ts` 的码→状态映射表，需就地
 * 构造——形态同 config-service 的 `adminHttpException` / currency-service 的 `adminError`）。
 */
function adminError(status: number, message: string, code: ErrCode = ErrCode.BAD_PARAM): HttpException {
  return new HttpException({ code, message, data: null }, status);
}

/** 未知 query 键 ⇒ 400（第一个未知键（对象键序）即拒——与网关白名单同句文案）。 */
function assertKnownKeys(query: QueryMap, allowed: readonly string[]): void {
  for (const k of Object.keys(query)) {
    if (!allowed.includes(k)) throw badRequest(unknownKeyMessage(k));
  }
}

/** 十进制非负整数（string ⇒ number；'1.5'/'1e3'/' 1'/超安全整数 一律拒）。 */
function decimalParam(raw: unknown, message: string): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw badRequest(message);
  }
  return Number(raw);
}

function parseCursor(query: QueryMap): number | null {
  const v = query['cursor'];
  if (v === undefined) return null;
  const n = decimalParam(v, CURSOR_MESSAGE);
  if (n < 1) throw badRequest(CURSOR_MESSAGE);
  return n;
}

function parseLimit(query: QueryMap): number {
  const v = query['limit'];
  if (v === undefined) return DEFAULT_PAGE_LIMIT;
  const n = decimalParam(v, LIMIT_MESSAGE);
  if (n < 1 || n > MAX_PAGE_LIMIT) throw badRequest(LIMIT_MESSAGE);
  return n;
}

function parseEpochMs(query: QueryMap, name: 'from' | 'to'): number | undefined {
  const v = query[name];
  if (v === undefined) return undefined;
  const n = decimalParam(v, EPOCH_MESSAGE(name));
  // 上界防线：超 Date 域的值会造出 Invalid Date 绑进 SQL（同 config 读口「不为非法值留 500 路径」）。
  if (Number.isNaN(new Date(n).getTime())) throw badRequest(EPOCH_MESSAGE(name));
  return n;
}

/** 字符串过滤值：非串（含重复参数的数组）/空串/超列宽 ⇒ 400（列宽纪律，同 config 读口）。 */
function parseBoundedString(query: QueryMap, name: string, max: number): string | undefined {
  const v = query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length < 1 || v.length > max) {
    throw badRequest(LENGTH_MESSAGE(name, max));
  }
  return v;
}

/** `GET reviews` 解析（白名单 → 过滤（status ≤12 列宽）→ keyset）。 */
function parseReviewsQuery(query: QueryMap): {
  filter: RiskReviewListFilter;
  cursor: number | null;
  limit: number;
} {
  assertKnownKeys(query, REVIEWS_QUERY_KEYS);
  const filter: RiskReviewListFilter = {};
  const status = parseBoundedString(query, 'status', 12); // risk_reviews.status varchar(12)
  if (status !== undefined) filter.status = status;
  const gameType = parseBoundedString(query, 'gameType', 16); // risk_reviews.game_type varchar(16)
  if (gameType !== undefined) {
    if (
      gameType !== 'doudizhu' &&
      gameType !== 'paodekuai' &&
      gameType !== 'mixed' &&
      gameType !== 'platform'
    ) {
      throw badRequest('gameType 非法：必须是 doudizhu|paodekuai|mixed|platform');
    }
    filter.gameType = gameType;
  }
  return { filter, cursor: parseCursor(query), limit: parseLimit(query) };
}

/** `GET actions[.csv]` 解析（csv 模式：cursor/limit 已在白名单被拒；无分页= 全量）。 */
function parseActionsQuery(
  query: QueryMap,
  csv: boolean,
): { filter: RiskActionListFilter; cursor: number | null; limit: number | null } {
  assertKnownKeys(query, csv ? csvQueryKeys(ACTIONS_QUERY_KEYS) : ACTIONS_QUERY_KEYS);
  const filter: RiskActionListFilter = {};
  const userId = parseBoundedString(query, 'userId', 64); // risk_actions.user_id varchar(64)
  if (userId !== undefined) filter.userId = userId;
  const action = parseBoundedString(query, 'action', 16); // varchar(16)
  if (action !== undefined) filter.action = action;
  const actor = parseBoundedString(query, 'actor', 32); // varchar(32)
  if (actor !== undefined) filter.actor = actor;
  const from = parseEpochMs(query, 'from');
  if (from !== undefined) filter.from = from;
  const to = parseEpochMs(query, 'to');
  if (to !== undefined) filter.to = to;
  return { filter, cursor: csv ? null : parseCursor(query), limit: csv ? null : parseLimit(query) };
}

/** `POST actions` body 解析（形状 = `{userId, action, reviewId?, reason}`；全字段自查 ⇒ 400）。 */
function parseActionBody(body: Record<string, unknown>): {
  userId: string;
  action: RiskAdminAction;
  reviewId?: number;
  reason: string;
} {
  const { userId, action, reason, reviewId } = body;
  if (typeof userId !== 'string' || userId.length < 1 || userId.length > 36) {
    throw badRequest(USER_ID_MESSAGE);
  }
  if (typeof action !== 'string' || !ADMIN_ACTION_VALUES.includes(action as RiskAdminAction)) {
    throw badRequest(ACTION_MESSAGE);
  }
  if (typeof reason !== 'string' || reason.length < 1 || reason.length > 200) {
    throw badRequest(REASON_MESSAGE);
  }
  let rid: number | undefined;
  if (reviewId !== undefined) {
    if (typeof reviewId !== 'number' || !Number.isSafeInteger(reviewId) || reviewId < 1) {
      throw badRequest(REVIEW_ID_MESSAGE);
    }
    rid = reviewId;
  }
  return { userId, action: action as RiskAdminAction, reason, ...(rid === undefined ? {} : { reviewId: rid }) };
}

/* ------------------------------------------------------------------ *
 * CSV 拼装（algorithm 本体 = protocol `csvCell`/`CSV_BOM`，此处只拼行）
 * ------------------------------------------------------------------ */

interface CsvRes {
  setHeader: (name: string, value: string) => void;
}

/** `null`/`undefined` ⇒ 空单元格；对象/数组 ⇒ JSON 串（再经 `csvCell` 转义）——json 列的 CSV 形态。 */
const jsonCell = (v: unknown): string => (v === null || v === undefined ? '' : JSON.stringify(v));

function csvBody(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return CSV_BOM + lines.map((line) => `${line}\r\n`).join('');
}

/** 文件名时间戳 `yyyyMMdd-HHmmss`（UTC——容器 TZ=UTC）。 */
function csvStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

const RISK_ACTIONS_CSV_HEADER = ['ID', '用户ID', '动作', '操作者', '理由', '条目ID', '详情', '时间'];
const riskActionCsvRow = (r: RiskActionItem): unknown[] => [
  r.id,
  r.userId,
  r.action,
  r.actor,
  r.reason ?? '',
  r.reviewId ?? '',
  jsonCell(r.detail),
  r.createdAt,
];

function sendCsv(
  res: CsvRes,
  name: string,
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${csvStamp(new Date())}.csv"`);
  return csvBody(header, rows);
}

@Controller('admin/risk')
@UseGuards(XAdminGuard)
export class AdminRiskController {
  constructor(
    private readonly adminRisk: AdminRiskService,
    private readonly reviewsService: ReviewsService,
    private readonly deviceBindings: DeviceBindingsService,
  ) {}

  /** 队列列表（§2.8 第一行）。 */
  @Get('reviews')
  @HttpCode(200)
  async listReviews(@Query() query: QueryMap) {
    const q = parseReviewsQuery(query);
    return { code: ErrCode.OK, data: await this.adminRisk.listReviews(q.filter, q.cursor, q.limit) };
  }

  /** 详情聚合（§2.8 第二行）；404 借 `11004`。 */
  @Get('users/:userId')
  @HttpCode(200)
  async userDetail(@Param('userId') userId: string) {
    if (typeof userId !== 'string' || userId.length < 1 || userId.length > 36) {
      throw badRequest(USER_ID_MESSAGE);
    }
    try {
      return { code: ErrCode.OK, data: await this.adminRisk.getUserDetail(userId) };
    } catch (err) {
      if (err instanceof DomainError) throw toHttpException(err);
      throw err;
    }
  }

  /**
   * 设备绑定片：人工解绑（删绑定行 + DEL `risk:binding:{userId}` + `device_unbind` 审计）。
   *
   * - DELETE 自动落 `XAdminGuard` 写面 ⇒ actor（`X-Admin-Actor`）fail-closed 必带；
   * - 无绑定行（含用户不存在）⇒ **404 借 `11004`**（管理面借既有码，不新造）；
   * - 成功 ⇒ 200 + `{code:0,data:{ok:true}}`；不踢旧 socket（残余窗口：旧连活到下次握手）。
   */
  @Delete('users/:userId/device-binding')
  @HttpCode(200)
  async unbindDevice(@Param('userId') userId: string, @Req() req: AdminRequest) {
    if (typeof userId !== 'string' || userId.length < 1 || userId.length > 36) {
      throw badRequest(USER_ID_MESSAGE);
    }
    const actor = adminActorOf(req);
    try {
      await this.deviceBindings.unbind(userId, actor);
    } catch (err) {
      if (err instanceof DomainError) throw toHttpException(err);
      throw err;
    }
    return { code: ErrCode.OK, data: { ok: true } };
  }

  /** 审计列表（§2.8 第四行 JSON 形态）。⚠️ 静态段 `actions` 先于本组无参段——无歧义。 */
  @Get('actions')
  @HttpCode(200)
  async listActions(@Query() query: QueryMap) {
    const q = parseActionsQuery(query, false);
    return { code: ErrCode.OK, data: await this.adminRisk.listActions(q.filter, q.cursor, q.limit) };
  }

  /** 审计 CSV（§2.8 第四行 `.csv` 变体；BOM/消毒/附件名 `risk-actions-<ts>.csv`；无分页全量）。 */
  @Get('actions.csv')
  @HttpCode(200)
  async actionsCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    const q = parseActionsQuery(query, true);
    const { items } = await this.adminRisk.listActions(q.filter, null, null);
    return sendCsv(res, 'risk-actions', RISK_ACTIONS_CSV_HEADER, items.map(riskActionCsvRow));
  }

  /**
   * 管理动作（§2.8 第三行；写面）。
   *
   * - actor：由 `XAdminGuard` 对写方法强制 `X-Admin-Actor` 并校验（缺/非法 ⇒ 401，**绝不回退**）；
   * - 参数 5 值白名单/reason 1..200/reviewId 正整数 ⇒ 400 借 `10001`（校验先于任何 IO）；
   * - 源态非法 / 陈旧提交 / 1213 重试耗尽 ⇒ **409 借 10001**（文案由服务层定稿）；
   * - 用户不存在（ban/unban）⇒ 404 借 `11004`；
   * - 成功 ⇒ 200 + `{code:0, data:{ok:true}}`（`@HttpCode(200)`：管理页按 status===200 分流）。
   */
  @Post('actions')
  @HttpCode(200)
  async applyAction(@Body() body: Record<string, unknown> | undefined, @Req() req: AdminRequest) {
    const actor = adminActorOf(req);
    const parsed = parseActionBody(body ?? {});
    try {
      await this.reviewsService.applyAdminAction({ ...parsed, actor, now: Date.now() });
    } catch (err) {
      if (err instanceof RiskConflictError) throw adminError(409, err.message);
      if (err instanceof DomainError) throw toHttpException(err);
      throw err;
    }
    return { code: ErrCode.OK, data: { ok: true } };
  }
}

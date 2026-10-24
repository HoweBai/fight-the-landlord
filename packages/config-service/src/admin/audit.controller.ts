import { Controller, Get, HttpCode, HttpException, Query, Res, UseGuards } from '@nestjs/common';
import { CSV_BOM, ErrCode, csvCell } from '@fight-the-landlord/protocol';
import { XAdminGuard } from '../config/admin.controller';
import { adminHttpException } from './admin-accounts.service';
import {
  AdminChangesService,
  type AccountChangeView,
  type AccountChangesFilter,
  type ConfigChangeView,
  type ConfigChangesFilter,
} from './admin-changes.service';
import { LoginEventsService, type LoginEventsFilter, type LoginEventView } from './login-events.service';

/**
 * 审计三读口 + 三 CSV 变体（规格 §2.5 / §2.10〔⚙️9〕/ §2.11；判据 C16/C22 的 config-service 侧）。
 *
 *  - `GET /api/admin/config/changes[.csv]` · `/api/admin/login-events[.csv]` ·
 *    `/api/admin/accounts/changes[.csv]`（统一挂 `XAdminGuard`——读面只认网关注入的 `X-Admin: 1`；
 *    角色矩阵在网关单点执行，设计 D2）；
 *  - 行形状/过滤键/keyset 组装在服务层（`admin-changes.service.ts` / `login-events.service.ts`），
 *    本文件只做三件事：**query 白名单与值校验（400）**、**响应信封**、**CSV 拼装**。
 *  - query 白名单（⚙️9 修订版）：未知键 ⇒ 400 借 10001「未知查询参数：<key>」；`.csv` 变体
 *    白名单 = JSON 版**去掉 `cursor/limit`**（带上即 400）。校验**先于**任何查库（假库零查询被单测钉）。
 *  - CSV（§2.11）：`csvCell`/`CSV_BOM` 消费自 protocol（**不得复制**）；行尾 `\r\n`、表头中文、
 *    文件名 `<名>-<yyyyMMdd-HHmmss>.csv`（容器 TZ=UTC，⚙️1）；CSV 无分页（全量出，天然小）。
 */

type QueryMap = Record<string, unknown>;

/** JSON 版白名单（§2.10；逐端点 = §2.5 过滤键表）。 */
export const CONFIG_CHANGES_QUERY_KEYS: readonly string[] = [
  'key',
  'actor',
  'from',
  'to',
  'cursor',
  'limit',
];
export const LOGIN_EVENTS_QUERY_KEYS: readonly string[] = [
  'username',
  'success',
  'from',
  'to',
  'cursor',
  'limit',
];
export const ACCOUNT_CHANGES_QUERY_KEYS: readonly string[] = [
  'targetId',
  'actor',
  'action',
  'from',
  'to',
  'cursor',
  'limit',
];
/** `.csv` 白名单 = JSON 版去掉 `cursor/limit`（S16a：带上即视作未知键 ⇒ 400）。 */
export function csvQueryKeys(keys: readonly string[]): readonly string[] {
  return keys.filter((k) => k !== 'cursor' && k !== 'limit');
}

/** ⚙️18：`limit` 缺省/上限（四读口统一——ops 与三读口）。 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/* 校验文案（「未知查询参数」为规格逐字；其余就地定死、被单测钉）。 */
const unknownKeyMessage = (key: string) => `未知查询参数：${key}`;
const LIMIT_MESSAGE = `limit 非法：须为 1–${MAX_PAGE_LIMIT} 的整数`;
const CURSOR_MESSAGE = 'cursor 非法：须为正整数';
const POSITIVE_ID_MESSAGE = (name: string) => `${name} 非法：须为正整数`;
const EPOCH_MESSAGE = (name: string) => `${name} 非法：须为非负整数（epoch 毫秒）`;
const LENGTH_MESSAGE = (name: string, max: number) => `${name} 非法：长度须为 1–${max}`;
const SUCCESS_MESSAGE = 'success 非法：须为 0 或 1';

function badRequest(message: string): HttpException {
  return adminHttpException(400, ErrCode.BAD_PARAM, message);
}

/** 未知 query 键 ⇒ 400（第一个未知键（对象键序）即拒——与网关白名单同句文案，§2.10）。 */
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
  // 上界防线：安全整数可达 9.007e15，而 Date 域止于 ±8.64e15 —— 超域值会造出 Invalid Date，
  // 绑进 SQL 变成驱动/500 的意外面；这里按参数非法拒（同「不为非法值留 500 路径」纪律）。
  if (Number.isNaN(new Date(n).getTime())) throw badRequest(EPOCH_MESSAGE(name));
  return n;
}

/**
 * 字符串过滤值：**非串（含重复参数的数组）/ 空串 / 超列宽 一律 400**（列宽纪律——T3 Critical
 * 的教训：超限值不给 SQL/CSV 层留 500/误导路径）。长度上界 = 对应列宽（key 64 / actor 32 /
 * username 32 / action 16）。
 */
function parseBoundedString(query: QueryMap, name: string, max: number): string | undefined {
  const v = query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length < 1 || v.length > max) {
    throw badRequest(LENGTH_MESSAGE(name, max));
  }
  return v;
}

function parsePositiveId(query: QueryMap, name: string): number | undefined {
  const v = query[name];
  if (v === undefined) return undefined;
  const n = decimalParam(v, POSITIVE_ID_MESSAGE(name));
  if (n < 1) throw badRequest(POSITIVE_ID_MESSAGE(name));
  return n;
}

function parseSuccess(query: QueryMap): 0 | 1 | undefined {
  const v = query['success'];
  if (v === undefined) return undefined;
  if (v !== '0' && v !== '1') throw badRequest(SUCCESS_MESSAGE);
  return v === '1' ? 1 : 0;
}

/** 逐端点解析（校验序 = §2.5 过滤键列序；`csv` 模式下 cursor/limit 已在白名单被拒）。 */
function parseConfigChangesQuery(query: QueryMap, csv: boolean) {
  assertKnownKeys(query, csv ? csvQueryKeys(CONFIG_CHANGES_QUERY_KEYS) : CONFIG_CHANGES_QUERY_KEYS);
  const filter: ConfigChangesFilter = {};
  const key = parseBoundedString(query, 'key', 64);
  if (key !== undefined) filter.key = key;
  const actor = parseBoundedString(query, 'actor', 32);
  if (actor !== undefined) filter.actor = actor;
  const from = parseEpochMs(query, 'from');
  if (from !== undefined) filter.from = from;
  const to = parseEpochMs(query, 'to');
  if (to !== undefined) filter.to = to;
  return { filter, cursor: csv ? null : parseCursor(query), limit: csv ? null : parseLimit(query) };
}

function parseLoginEventsQuery(query: QueryMap, csv: boolean) {
  assertKnownKeys(query, csv ? csvQueryKeys(LOGIN_EVENTS_QUERY_KEYS) : LOGIN_EVENTS_QUERY_KEYS);
  const filter: LoginEventsFilter = {};
  const username = parseBoundedString(query, 'username', 32);
  if (username !== undefined) filter.username = username;
  const success = parseSuccess(query);
  if (success !== undefined) filter.success = success;
  const from = parseEpochMs(query, 'from');
  if (from !== undefined) filter.from = from;
  const to = parseEpochMs(query, 'to');
  if (to !== undefined) filter.to = to;
  return { filter, cursor: csv ? null : parseCursor(query), limit: csv ? null : parseLimit(query) };
}

function parseAccountChangesQuery(query: QueryMap, csv: boolean) {
  assertKnownKeys(query, csv ? csvQueryKeys(ACCOUNT_CHANGES_QUERY_KEYS) : ACCOUNT_CHANGES_QUERY_KEYS);
  const filter: AccountChangesFilter = {};
  const targetId = parsePositiveId(query, 'targetId');
  if (targetId !== undefined) filter.targetId = targetId;
  const actor = parseBoundedString(query, 'actor', 32);
  if (actor !== undefined) filter.actor = actor;
  const action = parseBoundedString(query, 'action', 16);
  if (action !== undefined) filter.action = action;
  const from = parseEpochMs(query, 'from');
  if (from !== undefined) filter.from = from;
  const to = parseEpochMs(query, 'to');
  if (to !== undefined) filter.to = to;
  return { filter, cursor: csv ? null : parseCursor(query), limit: csv ? null : parseLimit(query) };
}

/* ------------------------------------------------------------------ *
 * CSV 拼装（§2.11；算法本体 = protocol `csvCell`/`CSV_BOM`，此处只拼行）
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

/** 文件名时间戳 `yyyyMMdd-HHmmss`（UTC——容器 TZ=UTC，⚙️1）。 */
function csvStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/** 落三枚响应头 + 拼全量 CSV 体（表头 = 各 JSON 行字段语义、去 `traceId`——本面无 traceId）。 */
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

const CONFIG_CHANGES_CSV_HEADER = ['ID', '配置键', '旧值', '新值', '操作者', '时间'];
const LOGIN_EVENTS_CSV_HEADER = ['ID', '用户名', '账号ID', 'IP', '成功', '时间'];
const ACCOUNT_CHANGES_CSV_HEADER = ['ID', '目标账号ID', '用户名', '动作', '详情', '操作者', '时间'];

const configChangeCsvRow = (r: ConfigChangeView): unknown[] => [
  r.id,
  r.key,
  jsonCell(r.oldValue),
  jsonCell(r.newValue),
  r.actor,
  r.createdAt,
];
const loginEventCsvRow = (r: LoginEventView): unknown[] => [
  r.id,
  r.username,
  r.accountId ?? '',
  r.ip ?? '',
  r.success,
  r.createdAt,
];
const accountChangeCsvRow = (r: AccountChangeView): unknown[] => [
  r.id,
  r.targetId,
  r.username,
  r.action,
  jsonCell(r.detail),
  r.actor,
  r.createdAt,
];

/* ------------------------------------------------------------------ *
 * 控制器（六端点；读面全角色——授权在网关，服务侧只认 X-Admin）
 * ------------------------------------------------------------------ */

@Controller('admin')
@UseGuards(XAdminGuard)
export class AuditController {
  constructor(
    private readonly changes: AdminChangesService,
    private readonly events: LoginEventsService,
  ) {}

  /** 配置变更历史（§2.5：`{code:0, data:{rows, nextCursor}}`）。 */
  @Get('config/changes')
  @HttpCode(200)
  async configChanges(@Query() query: QueryMap) {
    const q = parseConfigChangesQuery(query, false);
    return {
      code: ErrCode.OK,
      data: await this.changes.listConfigChanges(q.filter, q.cursor, q.limit),
    };
  }

  @Get('config/changes.csv')
  @HttpCode(200)
  async configChangesCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    const q = parseConfigChangesQuery(query, true);
    const { rows } = await this.changes.listConfigChanges(q.filter, null, null);
    return sendCsv(res, 'config-changes', CONFIG_CHANGES_CSV_HEADER, rows.map(configChangeCsvRow));
  }

  /** 登录事件（§2.5：`success` 出站为布尔）。 */
  @Get('login-events')
  @HttpCode(200)
  async loginEvents(@Query() query: QueryMap) {
    const q = parseLoginEventsQuery(query, false);
    return {
      code: ErrCode.OK,
      data: await this.events.list(q.filter, q.cursor, q.limit),
    };
  }

  @Get('login-events.csv')
  @HttpCode(200)
  async loginEventsCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    const q = parseLoginEventsQuery(query, true);
    const { rows } = await this.events.list(q.filter, null, null);
    return sendCsv(res, 'login-events', LOGIN_EVENTS_CSV_HEADER, rows.map(loginEventCsvRow));
  }

  /** 账号变更历史（§2.5）。⚠️ 静态段路由（`accounts/changes`）先于账号面的 `:id` 参数段——无歧义。 */
  @Get('accounts/changes')
  @HttpCode(200)
  async accountChanges(@Query() query: QueryMap) {
    const q = parseAccountChangesQuery(query, false);
    return {
      code: ErrCode.OK,
      data: await this.changes.listAccountChanges(q.filter, q.cursor, q.limit),
    };
  }

  @Get('accounts/changes.csv')
  @HttpCode(200)
  async accountChangesCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    const q = parseAccountChangesQuery(query, true);
    const { rows } = await this.changes.listAccountChanges(q.filter, null, null);
    return sendCsv(res, 'account-changes', ACCOUNT_CHANGES_CSV_HEADER, rows.map(accountChangeCsvRow));
  }
}

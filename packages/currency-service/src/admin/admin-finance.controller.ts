import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CSV_BOM, CURRENCY_SOURCES, ErrCode, csvCell, isAdminUsername } from '@fight-the-landlord/protocol';
import { ApplyService } from '../apply/apply.service';
import { httpException } from '../http/errors';
import { XAdminGuard, adminActorOf, type AdminRequest } from '../http/x-admin.guard';
import {
  FLOWS_CSV_MAX_ROWS,
  FLOWS_CSV_PROBE_LIMIT,
  FinanceQueryService,
  type AdminOpsRow,
  type OpsListFilter,
  type SummaryGroupBy,
  type SummaryRow,
} from './finance-query.service';
import { ReverseService, type ReverseEntry } from './reverse.service';
import {
  ReconcileInFlightError,
  ReconcileService,
  type CurrencyReconcileRoundResult,
} from '../reconcile/reconcile.service';

/**
 * 财务读口 + 冲正 + 对账（③ T6/T7/T8；规格 §2.7 / §2.8 / §2.11）：
 *
 *  - `GET /api/admin/wallet/ops[.csv]`：流水列表（keyset；`limit` 缺省 50 上限 100；
 *    响应 `{rows, nextCursor}`——`nextCursor = rows.length===limit ? 末行 flowId : null`，⚙️18）；
 *  - `GET /api/admin/wallet/ops/:opId`：op 详情（同 join 无过滤、`f.id` 升序、全 flows；
 *    不存在 ⇒ 404 借 10001「操作不存在」）；
 *  - `GET /api/admin/wallet/summary[.csv]`：汇总（`groupBy ∈ {source, day}` 缺省 source；
 *    缺省窗口 `to = now + 1ms`、`from = to − 30d`；空窗 ⇒ `rows:[], totals:{delta:0,flowCount:0}`）；
 *  - `POST /api/admin/wallet/reverse`（T7）：冲正（§2.8——见 `reverse` 方法头）；
 *  - `GET /api/admin/wallet/reconcile` + `POST /api/admin/wallet/reconcile/run`（T8）：对账面板
 *    读口 + 手动触发（§2.7——状态四字段 + `running`；在跑 ⇒ 409 借 10001「对账正在运行」）。
 *
 * 分工：**SQL 收口在 `finance-query.service.ts` / `reverse.service.ts`**（全文被单测钉），
 * 本文件做查询白名单与值校验（400）、流程编排、响应信封与错误映射、CSV 拼装。
 * ⚠️ 写方法（reverse、reconcile/run）自动落 actor fail-closed（`XAdminGuard` 对非读方法强制
 * `X-Admin-Actor`，见 `x-admin.guard.ts`；v1.1.5：`reconcile/run` 同款——该诊断动作不落审计行）。
 *
 * ─── 列宽纪律（T3 教训：不给 SQL/CSV 层留 500/误导路径）────────────────────
 * 过滤值一律**先于查库**校验并 400：`source` ∈ 协议 allowlist · `actor` 走 `isAdminUsername`
 * （同款判定）· `ownerId` 长度 1..36（字符集不预检——同 `admin-wallet.controller.ts:46-48`
 * 先例）· `cursor/limit` 纯十进制整数域 · `from/to` epoch ms（含 Date 域上界，同 T4 先例）。
 * 未知 query 键 ⇒ 400 借 10001「未知查询参数：<key>」（⚙️9；列表/过滤类端点）。
 *
 * ─── CSV（§2.11）────────────────────────────────────────────────────────
 * `csvCell`/`CSV_BOM` 消费自 protocol（**不得复制**）；首字节 BOM、行尾 `\r\n`、中文表头
 * （列 = JSON 行字段去 `traceId`）、`Content-Disposition: … filename="flows-<ts>.csv"` /
 * `"summary-<ts>.csv"`（`<ts>` = UTC `yyyyMMdd-HHmmss`，⚙️1）；CSV **无分页**（白名单去掉
 * cursor/limit，带上即 400）；`flows.csv` 单次 ≤ 50,000 行（超 ⇒ 400「范围过大，请收窄时间区间」）。
 */

type QueryMap = Record<string, unknown>;

/** ops 白名单（§2.10 = §2.7 过滤键；列序即规格列序）。 */
export const OPS_QUERY_KEYS: readonly string[] = ['source', 'actor', 'ownerId', 'from', 'to', 'cursor', 'limit'];
/** summary 白名单（§2.10：`from/to/groupBy`——summary 无 cursor）。 */
export const SUMMARY_QUERY_KEYS: readonly string[] = ['from', 'to', 'groupBy'];

/** `.csv` 白名单 = JSON 版去掉 `cursor/limit`（S16a：带上即视作未知键 ⇒ 400）。 */
function csvQueryKeys(keys: readonly string[]): readonly string[] {
  return keys.filter((k) => k !== 'cursor' && k !== 'limit');
}

/** ⚙️18：`limit` 缺省/上限（与 T4 三读口同值）。 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** summary 缺省窗口：30 天（§2.7「from = to − 30d」逐字）。 */
export const SUMMARY_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/* 校验文案（带引号的为规格逐字；其余就地定死、被单测钉）。 */
const unknownKeyMessage = (key: string) => `未知查询参数：${key}`;
const LIMIT_MESSAGE = `limit 非法：须为 1–${MAX_PAGE_LIMIT} 的整数`;
const CURSOR_MESSAGE = 'cursor 非法：须为正整数';
const EPOCH_MESSAGE = (name: 'from' | 'to') => `${name} 非法：须为非负整数（epoch 毫秒）`;
const SOURCE_MESSAGE = 'source 非法：须为货币来源 allowlist 之一';
const ACTOR_MESSAGE = 'actor 非法：须为 3–32 位小写字母/数字/._-';
const OWNER_ID_MESSAGE = 'ownerId 非法：长度须为 1–36';
const OP_ID_MESSAGE = 'opId 非法：须为正整数';
const GROUP_BY_MESSAGE = 'groupBy 非法：须为 source 或 day';
const CSV_TOO_LARGE_MESSAGE = '范围过大，请收窄时间区间';
const OP_NOT_FOUND_MESSAGE = '操作不存在';

/* T7 冲正文案（§2.8 步骤 4 / §2.14 表逐字）。 */
const NOT_REVERSIBLE_MESSAGE = '该操作不可冲正';
const ALREADY_REVERSED_MESSAGE = '该操作已冲正';
const REVERSE_INSUFFICIENT_MESSAGE = '余额不足，无法整笔冲正（可能已部分花费）——可改用手工扣减';

/* T8 对账文案（§2.7 逐字；409 借 10001）。 */
const RECONCILE_RUNNING_MESSAGE = '对账正在运行';

const badRequest = (message: string) => httpException(ErrCode.BAD_PARAM, message);

/**
 * admin 面借码信封（⚙️11）：404/409 借 10001 的状态不在 `http/errors.ts` 的码→状态映射表
 * （表里 10001⇒400），需就地构造——形态同 config-service 的 `adminHttpException` 先例。
 * `code` 缺省 10001（借）；T7 的 14001/14002 冲突面以真实业务码入信封（§2.14）。
 */
function adminError(status: number, message: string, code: ErrCode = ErrCode.BAD_PARAM): HttpException {
  return new HttpException({ code, message, data: null }, status);
}

/** 未知 query 键 ⇒ 400（第一个未知键（对象键序）即拒——与网关白名单同句文案，§2.10）。 */
function assertKnownKeys(query: QueryMap, allowed: readonly string[]): void {
  for (const k of Object.keys(query)) {
    if (!allowed.includes(k)) throw badRequest(unknownKeyMessage(k));
  }
}

/** 十进制非负整数（string ⇒ number；'1.5'/'1e3'/'-1'/' 1'/超安全整数 一律拒）。 */
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
  // Date 域上界防线（同 T4）：安全整数可达 9.007e15，而 Date 域止于 ±8.64e15——
  // 超域值会造出 Invalid Date 绑进 SQL，不留这条 500 路径。
  if (Number.isNaN(new Date(n).getTime())) throw badRequest(EPOCH_MESSAGE(name));
  return n;
}

/** 逐端点解析（校验序 = §2.7 过滤键列序；`csv` 模式下 cursor/limit 已在白名单被拒）。 */
function parseOpsQuery(
  query: QueryMap,
  csv: boolean,
): { filter: OpsListFilter; cursor: number | null; limit: number | null } {
  assertKnownKeys(query, csv ? csvQueryKeys(OPS_QUERY_KEYS) : OPS_QUERY_KEYS);
  const filter: OpsListFilter = {};

  const source = query['source'];
  if (source !== undefined) {
    if (typeof source !== 'string' || !(CURRENCY_SOURCES as readonly string[]).includes(source)) {
      throw badRequest(SOURCE_MESSAGE);
    }
    filter.source = source;
  }
  const actor = query['actor'];
  if (actor !== undefined) {
    // 同款判定 = protocol `isAdminUsername`（非串/空串/超长/字符集外都拒）；typeof 前置 = 收窄。
    if (typeof actor !== 'string' || !isAdminUsername(actor)) throw badRequest(ACTOR_MESSAGE);
    filter.actor = actor;
  }
  const ownerId = query['ownerId'];
  if (ownerId !== undefined) {
    if (typeof ownerId !== 'string' || ownerId.length < 1 || ownerId.length > 36) {
      throw badRequest(OWNER_ID_MESSAGE);
    }
    filter.ownerId = ownerId;
  }
  const from = parseEpochMs(query, 'from');
  if (from !== undefined) filter.from = from;
  const to = parseEpochMs(query, 'to');
  if (to !== undefined) filter.to = to;

  return { filter, cursor: csv ? null : parseCursor(query), limit: csv ? null : parseLimit(query) };
}

function parseSummaryQuery(query: QueryMap): {
  groupBy: SummaryGroupBy;
  from?: number;
  to?: number;
} {
  assertKnownKeys(query, SUMMARY_QUERY_KEYS);
  const raw = query['groupBy'];
  let groupBy: SummaryGroupBy = 'source';
  if (raw !== undefined) {
    if (raw !== 'source' && raw !== 'day') throw badRequest(GROUP_BY_MESSAGE);
    groupBy = raw;
  }
  return { groupBy, from: parseEpochMs(query, 'from'), to: parseEpochMs(query, 'to') };
}

/** §2.7 缺省窗口**逐字**：`to = now + 1ms`；`from = to − 30d`（只在缺省时派生——给了就用给的）。 */
function resolveWindow(from?: number, to?: number): { from: number; to: number } {
  const toMs = to ?? Date.now() + 1;
  const fromMs = from ?? toMs - SUMMARY_DEFAULT_WINDOW_MS;
  return { from: fromMs, to: toMs };
}

/* ------------------------------------------------------------------ *
 * 冲正（T7；§2.8）
 * ------------------------------------------------------------------ */

/** §2.8 body：`{opId: number, reason: string}`（值一律 `unknown`——唯一预闸在 `parseReverseBody`）。 */
interface ReverseBody {
  opId?: unknown;
  reason?: unknown;
}

export interface AdminReverseResult {
  /** 新（或重放的）冲正 op 的 id。 */
  opId: number;
  actionId: string;
  replayed: boolean;
  entries: Array<{ ownerId: string; balanceAfter: number }>;
}

/**
 * §2.8 body 预闸（400 借 10001，**先于任何库操作**）：`opId` 正整数（安全整数域——超域值
 * 查库无意义）、`reason` 1..200。⚠️ `reason ≤ 200` 比 apply 内核的列宽闸（≤255）**更严**——
 * 这条更严侧必须在这一层落（S6：不得给内核加 ≤200，否则与 `admin_adjust` 不对称；
 * 端点沿用 `admin-wallet.controller.ts` 的预闸先例）。actor 不在此校验——`XAdminGuard`
 * 对写方法已 fail-closed 校验（缺失/非法 ⇒ 401，绝不会到 handler）。
 */
function parseReverseBody(body: ReverseBody | undefined): { opId: number; reason: string } {
  const opId = body?.opId;
  if (typeof opId !== 'number' || !Number.isSafeInteger(opId) || opId < 1) {
    throw badRequest(OP_ID_MESSAGE);
  }
  const reason = body?.reason;
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 200) {
    throw badRequest(`reason 必须是 1..200 字符的非空字符串（收到 ${JSON.stringify(reason)}）`);
  }
  return { opId, reason };
}

/* ------------------------------------------------------------------ *
 * CSV 拼装（§2.11；算法本体 = protocol `csvCell`/`CSV_BOM`，此处只拼行）
 * ------------------------------------------------------------------ */

interface CsvRes {
  setHeader: (name: string, value: string) => void;
}

function csvBody(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return CSV_BOM + lines.map((line) => `${line}\r\n`).join('');
}

/** 文件名时间戳 `yyyyMMdd-HHmmss`（UTC——容器 TZ=UTC，⚙️1；同 T4 口径）。 */
function csvStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/** 落两枚响应头 + 拼全量 CSV 体（表头 = 各 JSON 行字段语义、去 `traceId`——§2.11 钉）。 */
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

const OPS_CSV_HEADER = [
  '流水ID',
  '操作ID',
  '幂等锚',
  '来源',
  '操作者',
  '原因',
  '关联ID',
  '账户ID',
  '账户类型',
  '金额',
  '操作后余额',
  '时间',
  '手机号',
  '昵称',
  '已冲正',
];
const SUMMARY_CSV_HEADER = ['分组', '金额合计', '流水笔数'];

/** 列集合 = JSON 行字段去 `traceId`（§2.11 钉；null ⇒ 空单元格、boolean ⇒ true/false 由 csvCell 承担）。 */
const opsCsvRow = (r: AdminOpsRow): unknown[] => [
  r.flowId,
  r.opId,
  r.actionId,
  r.source,
  r.actor,
  r.reason,
  r.refId,
  r.ownerId,
  r.ownerType,
  r.delta,
  r.balanceAfter,
  r.createdAt,
  r.phone,
  r.nickname,
  r.reversed,
];
const summaryCsvRow = (r: SummaryRow): unknown[] => [r.k, r.delta, r.flowCount];

/* ------------------------------------------------------------------ *
 * 控制器（五端点；读面全角色——授权在网关，服务侧只认 X-Admin）
 * ------------------------------------------------------------------ */

@Controller('admin/wallet')
@UseGuards(XAdminGuard)
export class AdminFinanceController {
  constructor(
    @Inject(FinanceQueryService) private readonly finance: FinanceQueryService,
    // ⚠️ 属性名不得叫 `reverse`：会遮蔽同名**路由方法**（实例字段覆盖原型方法 ⇒
    // Nest 的 `callback.apply is not a function`——500 且无编译期报错）。
    @Inject(ReverseService) private readonly reverseService: ReverseService,
    @Inject(ApplyService) private readonly applyService: ApplyService,
    // ③ T8：对账面板读口/手动触发直读该服务的内存态与 `inFlight` 旗（面板数据源 = 循环本体）。
    @Inject(ReconcileService) private readonly reconcileService: ReconcileService,
  ) {}

  /** 流水列表（§2.7：`{code:0, data:{rows, nextCursor}}`）。 */
  @Get('ops')
  @HttpCode(200)
  async ops(@Query() query: QueryMap) {
    const q = parseOpsQuery(query, false);
    if (q.limit === null) throw new Error('不变量破坏：JSON 路径的 limit 必为数字');
    return {
      code: ErrCode.OK,
      data: await this.finance.listOps(q.filter, q.cursor, q.limit),
    };
  }

  /** 流水 CSV（§2.11：无分页、50k 上限；50,001 探针 ⇒ 超限 400）。 */
  @Get('ops.csv')
  @HttpCode(200)
  async opsCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    const q = parseOpsQuery(query, true);
    const { rows } = await this.finance.listOps(q.filter, null, FLOWS_CSV_PROBE_LIMIT);
    if (rows.length > FLOWS_CSV_MAX_ROWS) throw badRequest(CSV_TOO_LARGE_MESSAGE);
    return sendCsv(res, 'flows', OPS_CSV_HEADER, rows.map(opsCsvRow));
  }

  /** op 详情（§2.7：同 join 无过滤、`f.id` 升序；不存在 ⇒ 404 借 10001「操作不存在」）。 */
  @Get('ops/:opId')
  @HttpCode(200)
  async opDetail(@Param('opId') opId: string) {
    const id = decimalParam(opId, OP_ID_MESSAGE);
    if (id < 1) throw badRequest(OP_ID_MESSAGE);
    const rows = await this.finance.getOp(id);
    if (rows.length === 0) throw adminError(404, OP_NOT_FOUND_MESSAGE);
    return { code: ErrCode.OK, data: { rows } };
  }

  /** 汇总（§2.7：两分支 + 缺省 30 天窗口）。 */
  @Get('summary')
  @HttpCode(200)
  async summary(@Query() query: QueryMap) {
    const q = parseSummaryQuery(query);
    const window = resolveWindow(q.from, q.to);
    return {
      code: ErrCode.OK,
      data: await this.finance.summary(q.groupBy, window.from, window.to),
    };
  }

  /** 汇总 CSV（§2.11：天然小、无上限面）。 */
  @Get('summary.csv')
  @HttpCode(200)
  async summaryCsv(@Query() query: QueryMap, @Res({ passthrough: true }) res: CsvRes) {
    const q = parseSummaryQuery(query);
    const window = resolveWindow(q.from, q.to);
    const { rows } = await this.finance.summary(q.groupBy, window.from, window.to);
    return sendCsv(res, 'summary', SUMMARY_CSV_HEADER, rows.map(summaryCsvRow));
  }

  /**
   * 冲正（§2.8 逐字；T7）。`POST /api/admin/wallet/reverse` body `{opId, reason}`：
   *
   *  1. 查 `currency_ops`（`reverseService.findOp`）：不存在 ⇒ **404**「操作不存在」；
   *     `source !== 'admin_adjust'` ⇒ **409 借 10001**「该操作不可冲正」；
   *  2. `entries = 原 op 全部 flows 取负`（`reverseService.loadReverseEntries`；ownerId/ownerType 从 flow 取）；
   *  3. 经 `currency.apply`（**唯一写边**）：`actionId='admin:reverse:<opId>'`、`source='admin_reverse'`、
   *     `actor` = 头（guard 已校验）、`reason`、`refId` = 原 `action_id`——entries 多账户**一次
   *     apply**（批量原子），不得逐户循环；
   *  4. 错误映射（§2.14）：`14001` ⇒ **409**「余额不足，无法整笔冲正（可能已部分花费）——可改用
   *     手工扣减」；`14002` ⇒ **409**「该操作已冲正」；其余（10001…）经映射表（⇒400）；
   *  5. 成功/重放 ⇒ **200** `{code:0, data:{opId, actionId, replayed, entries}}`。
   *
   * ⚠️ **不做「已冲正」预检短路**（⚙️6）：重复语义交给 apply 的 `uk_action_id` + 载荷指纹
   * 自然裁决——同操作者且同原因 ⇒ 指纹相同 ⇒ 重放 200 `replayed:true`；异原因 / 异操作者
   * ⇒ 同 actionId 异指纹 ⇒ 14002。T6 的 ops 行 `reversed` 旗（EXISTS）只服务 UI 遮蔽。
   */
  @Post('reverse')
  @HttpCode(200)
  async reverse(
    @Body() body: ReverseBody,
    @Req() req: AdminRequest,
  ): Promise<{ code: ErrCode; data: AdminReverseResult }> {
    const { opId, reason } = parseReverseBody(body);
    const actor = adminActorOf(req);

    // ①②（§2.8）：查 op（404/409）→ 原 flows 取负。
    const op = await this.reverseService.findOp(opId);
    if (op === null) throw adminError(404, OP_NOT_FOUND_MESSAGE);
    if (op.source !== 'admin_adjust') throw adminError(409, NOT_REVERSIBLE_MESSAGE);
    const entries: ReverseEntry[] = await this.reverseService.loadReverseEntries(opId);
    if (entries.length === 0) {
      // 不变量守护：每个 op 与 ≥1 行 flow 在 apply 同事务成对写入（T6 的详情注记同源）。
      throw new Error(`currency_ops id=${opId} 没有任何 flows（不变量破坏：apply 同事务成对写入）`);
    }

    // ③（§2.8）：唯一写边 = currency.apply（一次 apply ⇒ 整批原子）。
    const res = await this.applyService.apply({
      actionId: `admin:reverse:${opId}`,
      source: 'admin_reverse',
      actor,
      reason,
      refId: op.actionId,
      entries,
    });

    // ④ 映射（§2.8 步骤 4 / §2.14）：两条 409 用精确文案 + 真实业务码；其余经码→状态映射表。
    if (!res.ok) {
      if (res.code === ErrCode.E_INSUFFICIENT_FUNDS) {
        throw adminError(409, REVERSE_INSUFFICIENT_MESSAGE, res.code);
      }
      if (res.code === ErrCode.E_ACTION_CONFLICT) {
        throw adminError(409, ALREADY_REVERSED_MESSAGE, res.code);
      }
      throw httpException(res.code, res.message);
    }

    // ⑤ 成功/重放（§2.8 步骤 5）：载荷直译（重放时 opId/entries 即首次冲正的历史值）。
    return {
      code: ErrCode.OK,
      data: {
        opId: res.data.opId,
        actionId: res.data.actionId,
        replayed: res.data.replayed,
        entries: res.data.entries,
      },
    };
  }

  /**
   * 对账面板读口（③ T8；§2.7）：`data` = 状态四字段 + `running`。**内存态**——新进程前四项
   * null = 「未知」，如实呈现（不伪造）；读端点不强求 `x-admin-actor`。非列表新端点 ⇒
   * 未知 query 键**静默丢弃**（⚙️9，不做白名单）。
   */
  @Get('reconcile')
  @HttpCode(200)
  async reconcileStatus() {
    return { code: ErrCode.OK, data: this.reconcileService.getStatus() };
  }

  /**
   * 手动对账一轮（③ T8；§2.7）：`inFlight` ⇒ **409 借 10001**「对账正在运行」；否则执行
   * `runReconcileOnce()`（其自带一次 `runWithTrace` 包裹**不动** —— T8b），⇒ 200 `data` =
   * 一轮读数（`CurrencyReconcileRoundResult`）。
   * ⚠️ 该诊断动作**不落**审计行；POST ⇒ guard 自动强制 `x-admin-actor`（v1.1.5 裁定，
   * 此处不消费该头、仅 fail-closed 校验）。
   */
  @Post('reconcile/run')
  @HttpCode(200)
  async reconcileRun(): Promise<{ code: ErrCode; data: CurrencyReconcileRoundResult }> {
    try {
      return { code: ErrCode.OK, data: await this.reconcileService.runReconcileOnce() };
    } catch (err) {
      // 服务层不碰 HTTP；409 借码信封的构造留在本层（同各 404/409 的 `adminError` 口径）。
      if (err instanceof ReconcileInFlightError) throw adminError(409, RECONCILE_RUNNING_MESSAGE);
      throw err;
    }
  }
}

/**
 * conformance 用例：**财务后台 + RBAC + 审计**（③ 管理面 RBAC+审计片 T11；规格 §6.2 的 G1–G12 组 + 收尾）。
 *
 * ─── 本片的核心价值：三个「只在真栈现形」的 bug 类固化 ────────────────────────
 *  1. **EXISTS 回值漂移（修复 `86525fd`）**：`GET /api/admin/wallet/ops` 的 `reversed` 旗
 *     （`EXISTS(…)` 的 MySQL 回值随查询计划路径在 number 0/1 与字符串 "0"/"1" 间漂移）
 *     ⇒ G10 必须**四形态**（无过滤 / ownerId / from-to / cursor）全覆盖，且**每一行**都断言
 *     `typeof reversed === 'boolean'`（source/actor 过滤形态历史上是「碰巧 200」的路，
 *     不得只测它 —— 计划口径）；
 *  2. **CSV 经网关字节保真（修复 `fde7721`）**：`.csv` 断言一律**读字节** —— 首三字节
 *     `EF BB BF`（BOM 没被 `text()` 的 UTF-8 解码剥掉）+ 每一行尾 `0D 0A`，**不得只断言
 *     200 与文本**（G8 的 config-changes.csv、G10 的 flows.csv 各一轮）；
 *  3. **SQL 真解析（修复 `67939b3`/`9ba1e8d`）**：配置写走**真栈 PUT σ 200 + changes 落行**
 *     （G4/G8 的 old→new 行断言；假库单测遮蔽不了 ER_PARSE_ERROR 1064 这一类）。
 *  4. **大小写路径变体直通管理处理器（修复 T5-F1）**：Express/Nest 路由匹配**大小写不敏感**
 *     而网关路径识别原为大小写敏感 ⇒ `POST /API/admin/login`（持**玩家**令牌）直通 config-service
 *     的**豁免登录路由**（口令比较真实执行、失败桶不计数 = 唯一防爆破控制被旁路）。G5 固化
 *     变体负例：无令牌/玩家令牌 ⇒ **中间件级** 401（文案「Missing admin token」/「…admin token」，
 *     与处理器级「用户名或口令错误」可区分）+ 带有效管理令牌的 POST 变体 ⇒ P9 403 +
 *     小写登录失败**仍正常计数**（桶增量对照）。
 *
 * ─── 断言组（规格 §6.2 逐组对位）────────────────────────────────────────────
 *  G1 起手（五容器 healthy + 起手清登录失败桶 + 登录 + 引导号在 + 四角色一次性账号就位）；
 *  G2 登录矩阵（形状 400 ×3 + 未知 32 字符 ⇒ 401 有事件行 + 错口令 ⇒ 401 同文案 + 停用
 *     ⇒ 403 + 成功 ⇒ 200 带 username/role/expiresIn + ⚙️19 边界两例 33⇒400 无事件行 / İ 扩长⇒400）；
 *  G3 令牌/claims（伪造缺 claims / 旧形（无身份字段）/ 坏 role / 篡改签名 ⇒ 401+10005；
 *     正向对照 = 以公开 dev 默认密钥签出的**完整 claims** 令牌 ⇒ 200（证明四项 401 是
 *     claims/签名判定而非「我们不会签 JWT」——谓词判别力自证，R115 同族））；
 *  G4 伪造头族（x-admin/x-admin-actor/x-admin-roles/x-client-ip：写请求落库 actor 仍是
 *     真 token 的 `admin`；登录事件 IP ≠ 伪造值；玩家面请求零影响；**直连面** = 直连
 *     user-service 伪造 X-Admin 无内部 token ⇒ 401）；
 *  G5 policy 矩阵（P1–P9 逐条正反：四角色 × 每写端点；GET /accounts 超管限定；未登记
 *     非 GET 403；**尾斜杠负例**：`GET /api/admin/accounts/` ⇒ 非超管 403（归一命中 P1，
 *     不得落 P8）；`POST /api/admin/login/` ⇒ 401/403 fail-closed 不到登录处理器；
 *     **大小写变体负例（⚙️20）**：`/API/admin/login` 等 ⇒ 中间件级 401 + 桶对照）；
 *  G6 账号 CRUD + 留痕页签 + **并发互降负例**（两并发 PATCH：恰一成功一 409、超管 ≥1）+
 *     第二账号发 adjust ⇒ `ops.actor` = 其用户名（规格 §4.1#4，防「读了固定值」的假绿）；
 *  G7 冲正全链（正例 actor/refId/entries + 同原因重放 200 + 异原因 14002 + 非 admin_adjust
 *     409 + 14001 原子拒 + reversed 旗翻转）；
 *  G8 配置写 → changes 行（真栈 PUT：old→new，actor）+ 两并发 PUT 链式断言（无错位行）+
 *     config-changes.csv 样本（字节级）；
 *  G9 登录事件（成败双行 + IP 非空/非伪造 + 未知也落行 + 形状 400 不落行〔SQL 直核〕）；
 *  G10 财务读口（ops 四形态 + source/actor 过滤 + limit 边界 + 未知键 400 + summary 两态/
 *     空窗/型别/totals 恒等 + 详情多账户/404/400 + flows.csv 字节级）；
 *  G11 对账读写（GET 四字段+keys 恰好 / POST run ⇒ 重数与漂移 0 / GET after ⇒ 新鲜度+lastResult）；
 *  G12 静态串（经门口拉 `/admin/app.js` 与 `/admin/index.html`：端点串/文案/存储键 + **零
 *     innerHTML** + **服务出的字节 === 仓库现行文件**（防「旧镜像空测」））；
 *  收尾：一次性账号全部**停用**（不删、留档）+ 引导号只读不变量（active super_admin）。
 *
 * ─── 零 skip、零数据依赖分支（基线静态回填的前提）────────────────────────────
 *  全部断言在任何环境下都执行；每条 `checks.*` 都落在**定长**矩阵/单次调用上（循环只踩
 *  常量表；数据驱动的行集一律聚合进单条断言或先 find 后单断言）。
 *
 * ─── 本片对真栈的副作用与复原 ────────────────────────────────────────────
 *  - 一次性账号（`s19*` 前缀、per-run 随机后缀）**只停用不删**（留档；「停用不偷渡」）；
 *  - 引导号 `admin`：**口令从不触碰**；G6 的并发互降负例使其角色被瞬时降至 `finance`
 *    再**当场复原**（恰一成功一 409 的语义要求「活跃超管恰两名」，而 pair 的另一名就是
 *    引导号 —— 无角色高低序可绕）；`finally` 兜底复原；
 *  - `room.matchScanIntervalMs` 临时改值（G4/G8）⇒ 每组内自还原 + `finally` 兜底；
 *  - 直投 RPC 仅造 `signup_grant` 两笔（多账户 op / 非可冲正 op），owner = `s19*` 幽灵账户；
 *  - Redis 登录失败桶：起手清一次（脏卷残留会污染 G2 的 429 边界外计数）。
 *
 * ─── 环境依赖（登记，不跳过）────────────────────────────────────────────────
 *  G3 的伪造链要求本栈管理密钥 = **公开 dev 默认值**（`ADMIN_JWT_SECRET` 空 ⇒ 回落
 *  `JWT_SECRET` = compose 默认 `dev-secret-change-in-production`；CI 无 `.env` ⇒ 同值，
 *  本机 `.env` 亦逐字同值）。密钥被改成其它值时 G3 正对照会**响亮红**（这是有意的：
 *  「四项 401 因签名失败而非 claims 判定」的假绿必须能被看见），处理 = 对齐栈配方重跑。
 */
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  ADMIN_PASSWORD,
  GATEWAY_URL,
  USER_URL,
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  directJson,
  getJson,
  postJson,
  registerUser,
  type Envelope,
  type HarnessUser,
} from '../lib/http';
import { redisRaw, redisReplyText } from '../lib/redis';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-15/18）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** `currency.apply` 的 TCP 监听（宿主直投 = compose override 的 `3104:3104`；照 slice-17/18）。 */
const CURRENCY_RPC: RpcEndpoint = {
  host: process.env.CURRENCY_RPC_HOST ?? 'localhost',
  port: Number(process.env.CURRENCY_RPC_PORT ?? 3104),
};

/** 门口 HTTP 口（G12 经它拉管理页静态件；先起跳再逐跳跟随）。 */
const EDGE_HTTP_PORT = process.env.EDGE_HTTP_PORT ?? '8080';

/** 本 run 起始时刻（epoch ms）——全部时间过滤的 `from`（脏卷上把「上一轮的行」挡在外面）。 */
const RUN_START_MS = Date.now();

/**
 * 公开 dev 默认管理密钥（G3 伪造链用；文件头「环境依赖」块）。与 compose 的
 * `JWT_SECRET=${JWT_SECRET:-dev-secret-change-in-production}` 逐字同源。
 */
const DEV_ADMIN_JWT_SECRET = 'dev-secret-change-in-production';

/** 首启 bootstrap 的引导账号名（§2.13；本片对它恒只读）。 */
const BOOTSTRAP_USERNAME = 'admin';

/**
 * 本 run 的命名空间后缀（lowercase；用户名正则 `^[a-z0-9][a-z0-9._-]{2,31}$` 允许 [a-z0-9-]）。
 * 同栈连续两跑/全序重跑时，账号与 actionId 都靠它唯一（固定名会在第二跑 409/重放）。
 */
const TAG = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(-8);

const AID = (s: string): string => `s19-${TAG}-${s}`;

/* 一次性账号（收尾停用留档；全部 `s19` 前缀 —— 与「只读引导号」互不污染）。 */
const USERNAME_VIEWER = `s19v-${TAG}`;
const USERNAME_OPER = `s19o-${TAG}`;
const USERNAME_FIN = `s19f-${TAG}`;
const USERNAME_SUP = `s19s-${TAG}`;
const USERNAME_CRUD = `s19c-${TAG}`;
const ONE_TIME_PASSWORD = `s19-${TAG}-passw0rd`;
const CRUD_NEW_PASSWORD = `s19-${TAG}-newpass1`;

/** G2 的 32/33 字符边界名（32 恰上界、33 超一位）与 İ 扩长样本（24×'İ' ⇒ 归一 48 字符）。 */
const BOUNDARY_32 = `s19u-${TAG}`.padEnd(32, 'x');
const BOUNDARY_33 = `${BOUNDARY_32}x`;
const EXPANDER_RAW = 'İ'.repeat(24);

/** G6 并发互降的降级目标角色（无角色高低序，任意非 super_admin 都行）。 */
const DEMOTE_ROLE = 'finance';

/* ──────────────────────────────────────────────────────────────────────────
 * 本地助手（形态先例：slice-14/15/17/18）
 * ────────────────────────────────────────────────────────────────────────── */

interface CommandResult {
  code: number;
  out: string;
}

/** `docker compose exec -T <service> …`（`-T` 不能省：无 TTY 环境下缺它会挂住）。 */
function exec(service: string, ...cmd: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', 'exec', '-T', service, ...cmd], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 输出尾部 —— 失败断言里带上它（「跑挂 ≠ 判据红」：原因必须进结论）。 */
function tailOut(out: string, lines = 3): string {
  return out.trim().split('\n').slice(-lines).join(' / ');
}

/** MySQL 查询（`-N` = 不带列名表头；SQL 只许单引号字面量与数字，照 slice-14/15/18）。 */
function mysqlQuery(sql: string): CommandResult {
  return exec(
    'mysql',
    'sh',
    '-c',
    `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE" -N -e "${sql}"`,
  );
}

/** 查询返回**末行文本**（剥掉 mysql 的密码告警行；空 ⇒ 抛，不把空串装成值）。 */
function mysqlText(sql: string): string {
  const r = mysqlQuery(sql);
  if (r.code !== 0) throw new ConformanceError(`mysql 查询失败（exit ${r.code}）：${tailOut(r.out)}`);
  const lines = r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('mysql:'));
  const last = lines[lines.length - 1];
  if (last === undefined) throw new ConformanceError(`mysql 文本读数为空（原文尾部：${tailOut(r.out)}）`);
  return last;
}

/** 等容器 healthy（照 slice-14/18）。 */
async function waitContainerHealthy(container: string, timeoutMs = 90_000): Promise<{ ok: boolean; last: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const r = spawnSync('docker', ['inspect', container, '--format', '{{.State.Health.Status}}'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 20_000,
    });
    last = `${(r.stdout ?? '').trim() || (r.stderr ?? '').trim()}`;
    if (last === 'healthy') return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(1_000);
  }
}

/** 任意方法的网关请求（PATCH/DELETE 与**故意伪造头**的探针用；lib 的助手刻意只开 GET 的头口）。 */
interface RawResult {
  status: number;
  body: Envelope | null;
  headers: Record<string, string>;
}

async function sendJson(
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string; headers?: Record<string, string> } = {},
): Promise<RawResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Envelope | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    parsed = { code: res.status, message: text };
  }
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    responseHeaders[k.toLowerCase()] = v;
  });
  return { status: res.status, body: parsed, headers: responseHeaders };
}

/** 两枚字段的通用断言（HTTP 状态 + 信封 code）。 */
function expectHttp(
  checks: Checks,
  res: { status: number; body: Envelope | null },
  status: number,
  code: number,
  label: string,
): void {
  checks.eq(res.status, status, `${label} ⇒ HTTP ${status}`);
  checks.eq(res.body?.code, code, `${label} ⇒ code ${code}`);
}

/** 读 CSV 的**原始字节**（不经 JSON 解析；证明 BOM/CRLF 在网关两跳之后仍在）。 */
async function fetchCsvRaw(
  path: string,
  token: string,
): Promise<{ status: number; bytes: Uint8Array; headers: Record<string, string> }> {
  const res = await fetch(`${GATEWAY_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, bytes, headers };
}

/**
 * CSV 字节级断言组（定长）：状态 200 + 首三字节 BOM + 全部行尾 CRLF + 两枚响应头 +
 * 文本必须包含的**定长**针脚列表。`mustContain` 由调用方以常量数组给出（计数固定）。
 */
function csvByteChecks(
  checks: Checks,
  raw: { status: number; bytes: Uint8Array; headers: Record<string, string> },
  label: string,
  filenamePrefix: string,
  mustContain: readonly string[],
): void {
  checks.eq(raw.status, 200, `${label} ⇒ HTTP 200`);
  checks.eq(
    [...raw.bytes.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
    'ef bb bf',
    `${label} 首三字节 = EF BB BF（BOM 经「下游→网关」两跳后仍在 —— 字节保真）`,
  );
  const lf: number[] = [];
  for (let i = 0; i < raw.bytes.length; i++) if (raw.bytes[i] === 0x0a) lf.push(i);
  const badLf = lf.filter((i) => raw.bytes[i - 1] !== 0x0d);
  checks.that(
    lf.length > 0 && badLf.length === 0,
    `${label} 行尾全为 CRLF（0d 0a）—— LF 计数 ${lf.length}、违例 ${badLf.length}`,
  );
  checks.eq(raw.headers['content-type'], 'text/csv; charset=utf-8', `${label} Content-Type 逐字`);
  checks.that(
    new RegExp(`^attachment; filename="${filenamePrefix}-\\d{8}-\\d{6}\\.csv"$`).test(
      raw.headers['content-disposition'] ?? '',
    ),
    `${label} Content-Disposition = attachment; filename="${filenamePrefix}-<yyyyMMdd-HHmmss>.csv" —— 实际 ${JSON.stringify(raw.headers['content-disposition'])}`,
  );
  const text = new TextDecoder('utf-8').decode(raw.bytes);
  for (const needle of mustContain) {
    checks.that(text.includes(needle), `${label} 文本含 ${JSON.stringify(needle)}`);
  }
}

/* ── JWT 伪造（G3；只依赖 node:crypto）─────────────────────────────────────── */

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** 以指定密钥签一枚 HS256 JWT（header 固定 JSON 顺序，可复现）。 */
function signHs256(payload: Record<string, unknown>, secret: string = DEV_ADMIN_JWT_SECRET): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/* ── 门口单跳（G12；照 slice-17 的 edgeHop/edgeGetFollowing 手型）────────────── */

function edgeHop(url: URL): Promise<{ status: number; location: string; body: string }> {
  const options: https.RequestOptions = {
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    rejectUnauthorized: false,
  };
  return new Promise((resolve_, reject) => {
    const onRes = (res: http.IncomingMessage): void => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve_({ status: res.statusCode ?? 0, location: String(res.headers.location ?? ''), body }));
    };
    const req = url.protocol === 'https:' ? https.request(options, onRes) : http.request(options, onRes);
    req.on('error', reject);
    req.end();
  });
}

/** 从门口 HTTP 口起跳、逐跳跟随重定向（≤6 跳）。**不设 accept-encoding** ⇒ 拿到逐字原文（G12 比对用）。 */
async function edgeGetFollowing(path: string): Promise<{ status: number; body: string; chain: string[] }> {
  let url = new URL(`http://localhost:${EDGE_HTTP_PORT}${path}`);
  const chain: string[] = [];
  for (let i = 0; i < 6; i++) {
    const hop = await edgeHop(url);
    chain.push(`${url.protocol}//${url.host}${url.pathname} ⇒ ${hop.status}${hop.location ? ` → ${hop.location}` : ''}`);
    if (hop.status >= 300 && hop.status < 400 && hop.location !== '') {
      url = new URL(hop.location, url);
      continue;
    }
    return { status: hop.status, body: hop.body, chain };
  }
  throw new ConformanceError(`G12：重定向超过 6 跳仍未落定（链：${chain.join(' | ')}）`);
}

/* ── 行形状（§2.5/§2.7 的 wire 形状；本文件只声明用到的字段）────────────────── */

interface AdminAccountRow {
  id: number;
  username: string;
  role: string;
  status: string;
  createdAt: number;
  lastLoginAt: number | null;
}

interface AdminOpsRow {
  flowId: number;
  opId: number;
  actionId: string;
  source: string;
  actor: string | null;
  reason: string | null;
  refId: string | null;
  traceId: string | null;
  ownerId: string;
  ownerType: string;
  delta: number;
  balanceAfter: number;
  createdAt: number;
  phone: string | null;
  nickname: string | null;
  reversed: boolean;
}

interface LoginEventRow {
  id: number;
  username: string;
  accountId: number | null;
  ip: string | null;
  success: boolean;
  createdAt: number;
}

interface ConfigChangeRow {
  id: number;
  key: string;
  oldValue: unknown;
  newValue: unknown;
  actor: string;
  createdAt: number;
}

interface AccountChangeRow {
  id: number;
  targetId: number;
  username: string;
  action: string;
  detail: unknown;
  actor: string;
  createdAt: number;
}

interface AdminConfigData {
  config: Record<string, { value: unknown; version: number }>;
  version: number;
}

interface ReconcileRoundResult {
  driftAccounts: number;
  cacheDriftDeleted: number;
  orphanSignupGrants: number;
  robotPoolBalance: number;
  robotAccountsBalanceSum: number;
}

/* ──────────────────────────────────────────────────────────────────────────
 * 主用例
 * ────────────────────────────────────────────────────────────────────────── */

const HEALTH_CONTAINERS = [
  'ftl-api-gateway',
  'ftl-config-service',
  'ftl-currency-service',
  'ftl-user-service',
  'ftl-edge',
] as const;

export async function runSlice19(): Promise<Checks> {
  const checks = new Checks();

  /** 跨组状态（线性赋值；零值只可能出现在「前组失败已抛出」的路径上）。 */
  const s = {
    adminToken: '',
    adminId: 0,
    viewerId: 0,
    operId: 0,
    finId: 0,
    supId: 0,
    crudId: 0,
    viewerToken: '',
    operToken: '',
    finToken: '',
    supToken: '',
    userU: null as HarnessUser | null,
    cfgV0: 0,
  };
  /** 收尾是否已跑完（`finally` 只在**没跑完**时做兜底复原，避免成功路径重复写）。 */
  let cleanupDone = false;

  try {
    /* ════════════════════════════════════════════════════════════════════
     * G1 起手
     * ════════════════════════════════════════════════════════════════════ */
    step('G1 起手：五容器 healthy + 清登录失败桶 + 引导号在 + 四角色一次性账号就位');
    for (const container of HEALTH_CONTAINERS) {
      const h = await waitContainerHealthy(container);
      checks.that(h.ok, `G1 ${container} healthy（${h.last}）`);
    }
    // 起手清桶（**卫生，不是判据**）：脏卷可能带上一轮/其它片留下的失败计数，
    // 会污染 G2 的 401/403 计数语义（桶 5 次达界 ⇒ 429）。形态 = slice-14 C15 的清桶。
    const scan = redisRaw(['--scan', '--pattern', 'ratelimit:admin-login-fail:*']);
    const staleKeys = scan.stdout.split('\n').map((x) => x.trim()).filter((x) => x !== '');
    if (staleKeys.length > 0) {
      const del = redisRaw(['DEL', ...staleKeys]);
      info(`G1 起手清桶：删除 ${staleKeys.length} 个登录失败桶键（DEL ⇒ ${redisReplyText(del) || '（无回复）'}）`);
    } else {
      info('G1 起手清桶：--scan 无残留键');
    }

    s.adminToken = await adminLogin();
    checks.that(s.adminToken.length > 0, 'G1 引导号 admin 登录成功（token 非空）');
    const g1List = await getJson<{ accounts: AdminAccountRow[] }>('/api/admin/accounts', s.adminToken);
    checks.eq(g1List.body?.code, ErrCode.OK, 'G1 GET /api/admin/accounts ⇒ code 0');
    const g1Rows = g1List.body?.data?.accounts ?? [];
    const g1Admin = g1Rows.find((r) => r.username === BOOTSTRAP_USERNAME);
    checks.that(
      g1Admin !== undefined && g1Admin.role === 'super_admin' && g1Admin.status === 'active',
      `G1 引导号在：账号列表中 admin 存在且 role=super_admin/status=active —— 实际 ${JSON.stringify(g1Admin)}`,
    );
    checks.that(
      !JSON.stringify(g1List.body?.data ?? null).includes('password_hash'),
      'G1 账号列表零出现 password_hash（永不出现出站字段）',
    );
    s.adminId = g1Admin!.id;

    // 自愈：本片命名空间（`s19` 前缀）里若有**上一轮崩溃残留的 active 超管**，先停用 ——
    // 否则 G6 的「活跃超管恰两名」前提会被自己上一轮的残骸破坏。**只碰 s19 前缀**。
    const staleSupers = g1Rows.filter(
      (r) => r.username.startsWith('s19') && r.role === 'super_admin' && r.status === 'active',
    );
    for (const stale of staleSupers) {
      await sendJson('PATCH', `/api/admin/accounts/${stale.id}`, { status: 'disabled' }, { token: s.adminToken });
    }
    if (staleSupers.length > 0) {
      info(`G1 自愈：停用 ${staleSupers.length} 个 s19 前缀的残留 active 超管（${staleSupers.map((r) => r.username).join(', ')}）`);
    }

    /** 建号 + 三条断言（定长）。 */
    const createOneTime = async (username: string, role: string, label: string): Promise<number> => {
      const res = await postJson<{ id: number; username: string; role: string; status: string }>(
        '/api/admin/accounts',
        { username, password: ONE_TIME_PASSWORD, role },
        s.adminToken,
      );
      checks.eq(res.status, 200, `G1 建号 ${label}（${username}/${role}）⇒ HTTP 200（管理面统一 200）`);
      checks.eq(res.body?.code, ErrCode.OK, `G1 建号 ${label} ⇒ code 0`);
      checks.that(
        typeof res.body?.data?.id === 'number' &&
          res.body.data.id > 0 &&
          res.body.data.username === username &&
          res.body.data.role === role &&
          res.body.data.status === 'active',
        `G1 建号 ${label} ⇒ {id>0, username, role, status:'active'} —— 实际 ${JSON.stringify(res.body?.data)}`,
      );
      return res.body!.data!.id;
    };
    /** 登录 + 六条断言（定长）。 */
    const loginOneTime = async (username: string, role: string, label: string): Promise<string> => {
      const res = await postJson<{ token: string; expiresIn: number; username: string; role: string }>(
        '/api/admin/login',
        { username, password: ONE_TIME_PASSWORD },
      );
      checks.eq(res.status, 200, `G1 登录 ${label} ⇒ HTTP 200`);
      checks.eq(res.body?.code, ErrCode.OK, `G1 登录 ${label} ⇒ code 0`);
      checks.eq(res.body?.data?.username, username, `G1 登录 ${label} ⇒ username 为归一后值`);
      checks.eq(res.body?.data?.role, role, `G1 登录 ${label} ⇒ role=${role}（随行下发）`);
      checks.eq(res.body?.data?.expiresIn, 7200, `G1 登录 ${label} ⇒ expiresIn=7200`);
      checks.that(
        typeof res.body?.data?.token === 'string' && res.body.data.token.length > 0,
        `G1 登录 ${label} ⇒ token 非空`,
      );
      return res.body!.data!.token;
    };

    s.viewerId = await createOneTime(USERNAME_VIEWER, 'viewer', 'viewer');
    s.operId = await createOneTime(USERNAME_OPER, 'operator', 'operator');
    s.finId = await createOneTime(USERNAME_FIN, 'finance', 'finance');
    s.supId = await createOneTime(USERNAME_SUP, 'super_admin', 'super_admin');
    s.viewerToken = await loginOneTime(USERNAME_VIEWER, 'viewer', 'viewer');
    s.operToken = await loginOneTime(USERNAME_OPER, 'operator', 'operator');
    s.finToken = await loginOneTime(USERNAME_FIN, 'finance', 'finance');
    s.supToken = await loginOneTime(USERNAME_SUP, 'super_admin', 'super_admin');

    /* ════════════════════════════════════════════════════════════════════
     * G2 登录矩阵（5 态 + ⚙️19 边界两例）
     * ════════════════════════════════════════════════════════════════════ */
    step('G2 登录矩阵：形状 400 / 未知 401 / 错口令 401（同文案）/ 停用 403 / 成功 200 + ⚙️19 边界');
    const g2NoPassword = await postJson('/api/admin/login', { username: BOOTSTRAP_USERNAME });
    checks.eq(g2NoPassword.status, 400, 'G2 形状：缺 password ⇒ 400');
    checks.eq(g2NoPassword.body?.code, ErrCode.BAD_PARAM, 'G2 形状：缺 password ⇒ code 10001（借码）');
    checks.eq(g2NoPassword.body?.message, '参数非法', 'G2 形状：缺 password ⇒ 文案「参数非法」');

    const g2LongPassword = await postJson('/api/admin/login', {
      username: BOOTSTRAP_USERNAME,
      password: 'p'.repeat(1025),
    });
    checks.eq(g2LongPassword.status, 400, 'G2 形状：password 1025 字符 ⇒ 400');
    checks.eq(g2LongPassword.body?.code, ErrCode.BAD_PARAM, 'G2 形状：超长 password ⇒ code 10001');

    // ⚙️19 边界一：33 字符未知名 ⇒ 400（形状级、不落事件；防「落事件撞 varchar(32) ⇒ 500」回归）
    const g2Name33 = await postJson('/api/admin/login', { username: BOUNDARY_33, password: 'whatever' });
    checks.eq(g2Name33.status, 400, 'G2 ⚙️19：33 字符用户名 ⇒ 400（不得 500）');
    checks.eq(g2Name33.body?.code, ErrCode.BAD_PARAM, 'G2 ⚙️19：33 字符用户名 ⇒ code 10001');

    // ⚙️19 边界二（同族第二路径）：24×'İ' 原始 24 字符（过形状闸）但 toLowerCase 归一后 48 ⇒ 400
    const g2Expander = await postJson('/api/admin/login', { username: EXPANDER_RAW, password: 'whatever' });
    checks.eq(g2Expander.status, 400, 'G2 ⚙️19：İ×24（归一后 48 字符）⇒ 400（扩长防线）');
    checks.eq(g2Expander.body?.code, ErrCode.BAD_PARAM, 'G2 ⚙️19：İ 扩长例 ⇒ code 10001');

    // 未知用户名（恰 32 字符、形状合法）⇒ 401 且**必须落事件行**
    const g2Unknown = await postJson('/api/admin/login', { username: BOUNDARY_32, password: 'whatever' });
    checks.eq(g2Unknown.status, 401, 'G2 未知用户名（32 字符）⇒ 401');
    checks.eq(g2Unknown.body?.code, ErrCode.UNAUTHENTICATED, 'G2 未知用户名 ⇒ code 10002');
    const unknownMessage = String(g2Unknown.body?.message ?? '');

    // 错口令（真实账号）⇒ 401 且与未知用户名**同一句**文案（防枚举）
    const g2Wrong = await postJson('/api/admin/login', { username: USERNAME_VIEWER, password: 'wrong-pass-000' });
    checks.eq(g2Wrong.status, 401, 'G2 错口令 ⇒ 401');
    checks.eq(g2Wrong.body?.code, ErrCode.UNAUTHENTICATED, 'G2 错口令 ⇒ code 10002');
    checks.eq(g2Wrong.body?.message, unknownMessage, 'G2 错口令与未知用户名**同文案**（防枚举：wire 上不可区分）');

    // 停用 ⇒ 403（先停用 viewer，验完立即复启 —— viewer 还要在 G5 当负例角色）
    const g2Disable = await sendJson('PATCH', `/api/admin/accounts/${s.viewerId}`, { status: 'disabled' }, { token: s.adminToken });
    expectHttp(checks, g2Disable, 200, ErrCode.OK, 'G2 停用 viewer');
    const g2DisabledLogin = await postJson('/api/admin/login', { username: USERNAME_VIEWER, password: ONE_TIME_PASSWORD });
    checks.eq(g2DisabledLogin.status, 403, 'G2 停用账号 ⇒ 403（口令正确也拒）');
    checks.eq(g2DisabledLogin.body?.code, ErrCode.FORBIDDEN, 'G2 停用账号 ⇒ code 10003');
    checks.eq(g2DisabledLogin.body?.message, '账号已停用', 'G2 停用账号 ⇒ 文案「账号已停用」');
    const g2Enable = await sendJson('PATCH', `/api/admin/accounts/${s.viewerId}`, { status: 'active' }, { token: s.adminToken });
    expectHttp(checks, g2Enable, 200, ErrCode.OK, 'G2 复启 viewer');

    // 成功 ⇒ 200 带 username+role+expiresIn+token
    const g2Ok = await postJson<{ token: string; expiresIn: number; username: string; role: string }>(
      '/api/admin/login',
      { username: USERNAME_VIEWER, password: ONE_TIME_PASSWORD },
    );
    checks.eq(g2Ok.status, 200, 'G2 成功：复启后正确口令 ⇒ 200');
    checks.eq(g2Ok.body?.code, ErrCode.OK, 'G2 成功 ⇒ code 0');
    checks.eq(g2Ok.body?.data?.username, USERNAME_VIEWER, 'G2 成功 ⇒ username 随行');
    checks.eq(g2Ok.body?.data?.role, 'viewer', 'G2 成功 ⇒ role 随行');
    checks.eq(g2Ok.body?.data?.expiresIn, 7200, 'G2 成功 ⇒ expiresIn=7200');
    checks.that((g2Ok.body?.data?.token ?? '').length > 0, 'G2 成功 ⇒ token 非空');

    // 32 字符未知名**有事件行**（success=false、accountId=null）
    const g2Events = await getJson<{ rows: LoginEventRow[] }>(
      `/api/admin/login-events?username=${encodeURIComponent(BOUNDARY_32)}&limit=10`,
      s.adminToken,
    );
    expectHttp(checks, g2Events, 200, ErrCode.OK, 'G2 未知用户名的事件行查询');
    const g2EventRows = g2Events.body?.data?.rows ?? [];
    checks.that(g2EventRows.length >= 1, `G2 未知用户名 ⇒ 有事件行（≥1，实测 ${g2EventRows.length}）`);
    checks.eq(g2EventRows[0]?.success, false, 'G2 未知用户名事件行 success=false');
    checks.eq(g2EventRows[0]?.accountId, null, 'G2 未知用户名事件行 accountId=null（查无此人）');

    // 33 字符 ⇒ **无事件行**（SQL 直核 —— 该值超列宽，事件读口的 32 界过滤看不到它）
    checks.eq(
      mysqlText(`SELECT COUNT(*) FROM admin_login_events WHERE username='${BOUNDARY_33}'`),
      '0',
      'G2 ⚙️19：33 字符用户名 ⇒ 事件表零行（形状错不是凭据尝试；⚙️3）',
    );

    /* ════════════════════════════════════════════════════════════════════
     * G3 令牌 / claims
     * ════════════════════════════════════════════════════════════════════ */
    step('G3 令牌/claims：伪造缺 claims / 旧形 / 坏 role / 篡改 ⇒ 401+10005；完整 claims ⇒ 200（正对照）');
    const nowSec = Math.floor(Date.now() / 1000);
    const baseClaims = { aud: 'ftl-admin', iat: nowSec, exp: nowSec + 3600 };

    const g3Missing = await getJson('/api/admin/config', signHs256({ ...baseClaims }));
    expectHttp(checks, g3Missing, 401, ErrCode.TOKEN_INVALID, 'G3 缺 claims（无 sub/username/role）');

    const g3Legacy = await getJson('/api/admin/config', signHs256({ ...baseClaims, sub: '1' }));
    expectHttp(checks, g3Legacy, 401, ErrCode.TOKEN_INVALID, 'G3 旧形令牌（有 sub、无身份字段 —— 升级前格式的等价样本）');

    const g3BadRole = await getJson('/api/admin/config', signHs256({ ...baseClaims, sub: '1', username: 'x', role: 'root' }));
    expectHttp(checks, g3BadRole, 401, ErrCode.TOKEN_INVALID, 'G3 role 不在四值白名单');

    // 篡改：真 token 的 payload 段动一个字符（签名随即不符）
    const parts = s.adminToken.split('.');
    const tamperedBody = `${parts[1]!.slice(0, -1)}${parts[1]!.endsWith('A') ? 'B' : 'A'}`;
    const g3Tampered = await getJson('/api/admin/config', `${parts[0]}.${tamperedBody}.${parts[2]}`);
    expectHttp(checks, g3Tampered, 401, ErrCode.TOKEN_INVALID, 'G3 篡改签名（payload 段动一个字符）');

    // 正对照：以公开 dev 默认密钥签**完整合法 claims** ⇒ 200 —— 证明上面四条 401 是
    // claims/签名判定，而不是「我们签的 JWT 本来就不被接受」（谓词判别力自证）。
    // 走 P1（超管限定）而非 P8，连 `role` claim 的接线也一并钉。
    const g3Control = await getJson(
      '/api/admin/accounts',
      signHs256({ ...baseClaims, sub: '999999', username: BOOTSTRAP_USERNAME, role: 'super_admin' }),
    );
    expectHttp(checks, g3Control, 200, ErrCode.OK, 'G3 正对照（dev 默认密钥 + 完整 claims）⇒ 200');

    /* ════════════════════════════════════════════════════════════════════
     * G4 伪造头族 + 直连面
     * ════════════════════════════════════════════════════════════════════ */
    step('G4 伪造头族：写请求下游 actor 仍是真值 / 登录事件 IP ≠ 伪造值 / 玩家面零影响 / 直连面无内部 token ⇒ 401');
    const g4CfgBefore = await adminGetConfig<AdminConfigData>(s.adminToken);
    const g4V0 = Number(g4CfgBefore.body?.data?.config?.['room.matchScanIntervalMs']?.value);
    s.cfgV0 = g4V0;
    const g4V = g4V0 >= 400_000 ? g4V0 - 50_000 : g4V0 + 50_000;

    const forgedHeaders = {
      'x-admin': '1',
      'x-admin-actor': 'evil-actor',
      'x-admin-roles': 'viewer',
      'x-client-ip': '6.6.6.6',
    };
    // （a）带真 token + 全套伪造头写配置：角色伪造若未被剥除 ⇒ 会按 viewer 拒 403；actor 伪造
    //     若未被剥除 ⇒ 落库的 actor 会是 evil-actor。二者都从**下游可见的出口**断言。
    const g4Put = await sendJson(
      'PUT',
      '/api/admin/config/room.matchScanIntervalMs',
      { value: g4V },
      { token: s.adminToken, headers: forgedHeaders },
    );
    expectHttp(checks, g4Put, 200, ErrCode.OK, 'G4 带伪造头写配置（真 token）⇒ 200（角色伪造已被剥）');
    const g4Changes = await getJson<{ rows: ConfigChangeRow[] }>(
      `/api/admin/config/changes?key=room.matchScanIntervalMs&from=${RUN_START_MS}&limit=10`,
      s.adminToken,
    );
    expectHttp(checks, g4Changes, 200, ErrCode.OK, 'G4 读 config/changes（本次 window）');
    const g4Row = (g4Changes.body?.data?.rows ?? []).find((r) => r.newValue === g4V);
    checks.that(g4Row !== undefined, `G4 留痕行存在（newValue=${g4V}）—— 实际 ${JSON.stringify(g4Changes.body?.data?.rows)}`);
    checks.eq(g4Row?.actor, BOOTSTRAP_USERNAME, 'G4 留痕 actor = 真 token 的用户名（伪造 x-admin-actor 永不达下游）');
    checks.that(
      !JSON.stringify(g4Changes.body?.data ?? null).includes('evil-actor'),
      'G4 伪造值 evil-actor 在留痕面零出现',
    );
    checks.eq(g4Row?.oldValue, g4V0, 'G4 留痕 oldValue = 原值（真栈 PUT 的 old→new）');
    const g4Restore = await adminPutConfig('room.matchScanIntervalMs', g4V0, s.adminToken);
    expectHttp(checks, g4Restore, 200, ErrCode.OK, 'G4 还原 room.matchScanIntervalMs');

    // （b）登录带全套伪造头 ⇒ 200 且响应 role 来自库（finance），伪造 roles 零影响
    const g4Login = await sendJson('POST', '/api/admin/login', { username: USERNAME_FIN, password: ONE_TIME_PASSWORD }, { headers: forgedHeaders });
    expectHttp(checks, g4Login, 200, ErrCode.OK, 'G4 带伪造头登录（finance 账号）⇒ 200');
    checks.eq((g4Login.body?.data as { role?: string } | undefined)?.role, 'finance', 'G4 登录响应 role=finance（伪造 x-admin-roles 零影响）');

    // （c）玩家面请求带伪造管理头 ⇒ 正常玩家面 200（伪造零影响）
    const uP = await registerUser(9);
    s.userU = uP;
    const g4Player = await getJson<{ balance: number }>('/api/wallet/balance', uP.accessToken, forgedHeaders);
    expectHttp(checks, g4Player, 200, ErrCode.OK, 'G4 玩家面 GET /api/wallet/balance 带伪造管理头 ⇒ 200/code 0');

    // （d）直连面：直连 user-service 伪造 X-Admin 但**无内部 token** ⇒ 内部身份边界先拒（401）
    const g4Direct = await directJson(USER_URL, `/api/admin/users/${encodeURIComponent(uP.id)}`, {
      headers: { 'x-admin': '1', 'x-admin-actor': 'evil-actor' },
      internalToken: null,
    });
    expectHttp(checks, g4Direct, 401, ErrCode.UNAUTHENTICATED, 'G4 直连 user-service 伪造 X-Admin（无内部 token）');
    checks.that(
      String(g4Direct.body?.message ?? '').includes('Internal token required'),
      `G4 直连面 401 由内部 token 边界给出（消息点名）—— 实际 ${JSON.stringify(g4Direct.body)}`,
    );

    /* ════════════════════════════════════════════════════════════════════
     * G5 policy 矩阵（P1–P9）
     * ════════════════════════════════════════════════════════════════════ */
    step('G5 policy 矩阵：P1–P9 四角色正反 + 尾斜杠负例（P1 归一命中，不得落 P8）+ 大小写变体负例（⚙️20 终审 F1）');
    const g5 = async (
      _label: string,
      method: string,
      path: string,
      token: string,
      body: unknown,
    ): Promise<RawResult> => sendJson(method, path, body, { token });

    // P1（GET /accounts 精确）：超管 200；其余三角色 403
    const p1Admin = await g5('P1 超管', 'GET', '/api/admin/accounts', s.adminToken, undefined);
    expectHttp(checks, p1Admin, 200, ErrCode.OK, 'G5 P1 超管读账号列表');
    const p1Fin = await g5('P1 财务', 'GET', '/api/admin/accounts', s.finToken, undefined);
    expectHttp(checks, p1Fin, 403, ErrCode.FORBIDDEN, 'G5 P1 财务 ⇒ 403');
    checks.that(
      String(p1Fin.body?.message ?? '').includes('Insufficient role'),
      `G5 P1 403 文案 = fail-closed 的「Insufficient role / endpoint not registered」—— 实际 ${JSON.stringify(p1Fin.body?.message)}`,
    );
    expectHttp(checks, await g5('P1 运营', 'GET', '/api/admin/accounts', s.operToken, undefined), 403, ErrCode.FORBIDDEN, 'G5 P1 运营 ⇒ 403');
    expectHttp(checks, await g5('P1 只读', 'GET', '/api/admin/accounts', s.viewerToken, undefined), 403, ErrCode.FORBIDDEN, 'G5 P1 只读 ⇒ 403');

    // P2（POST /accounts 精确）：超管 放行到下游（body 非法 ⇒ 下游 400 —— 证网关放行而非 403）；其余 403
    expectHttp(checks, await g5('P2 超管', 'POST', '/api/admin/accounts', s.adminToken, {}), 400, ErrCode.BAD_PARAM, 'G5 P2 超管（非法 body ⇒ 下游 400 = 已放行）');
    expectHttp(checks, await g5('P2 财务', 'POST', '/api/admin/accounts', s.finToken, {}), 403, ErrCode.FORBIDDEN, 'G5 P2 财务 ⇒ 403');
    expectHttp(checks, await g5('P2 运营', 'POST', '/api/admin/accounts', s.operToken, {}), 403, ErrCode.FORBIDDEN, 'G5 P2 运营 ⇒ 403');
    expectHttp(checks, await g5('P2 只读', 'POST', '/api/admin/accounts', s.viewerToken, {}), 403, ErrCode.FORBIDDEN, 'G5 P2 只读 ⇒ 403');

    // P3（PATCH /accounts/:id 前缀）：超管 放行（不存在的 id ⇒ 下游 404）；其余 403
    expectHttp(checks, await g5('P3 超管', 'PATCH', '/api/admin/accounts/999999999', s.adminToken, { role: 'viewer' }), 404, ErrCode.BAD_PARAM, 'G5 P3 超管（不存在 id ⇒ 下游 404 = 已放行）');
    expectHttp(checks, await g5('P3 财务', 'PATCH', `/api/admin/accounts/${s.viewerId}`, s.finToken, { role: 'viewer' }), 403, ErrCode.FORBIDDEN, 'G5 P3 财务 ⇒ 403');
    expectHttp(checks, await g5('P3 运营', 'PATCH', `/api/admin/accounts/${s.viewerId}`, s.operToken, { role: 'viewer' }), 403, ErrCode.FORBIDDEN, 'G5 P3 运营 ⇒ 403');
    expectHttp(checks, await g5('P3 只读', 'PATCH', `/api/admin/accounts/${s.viewerId}`, s.viewerToken, { role: 'viewer' }), 403, ErrCode.FORBIDDEN, 'G5 P3 只读 ⇒ 403');

    // P4（PUT /config/:key 前缀，非 changes）：超管+运营 放行（非法值 ⇒ 下游 400）；财务/只读 403
    expectHttp(checks, await g5('P4 超管', 'PUT', '/api/admin/config/room.friendRoomEnabled', s.adminToken, { value: 'yes' }), 400, ErrCode.BAD_PARAM, 'G5 P4 超管（非法值 ⇒ 下游 400 = 已放行）');
    expectHttp(checks, await g5('P4 运营', 'PUT', '/api/admin/config/room.friendRoomEnabled', s.operToken, { value: 'yes' }), 400, ErrCode.BAD_PARAM, 'G5 P4 运营（放行 ⇒ 下游 400）');
    expectHttp(checks, await g5('P4 财务', 'PUT', '/api/admin/config/room.friendRoomEnabled', s.finToken, { value: 'yes' }), 403, ErrCode.FORBIDDEN, 'G5 P4 财务 ⇒ 403');
    expectHttp(checks, await g5('P4 只读', 'PUT', '/api/admin/config/room.friendRoomEnabled', s.viewerToken, { value: 'yes' }), 403, ErrCode.FORBIDDEN, 'G5 P4 只读 ⇒ 403');

    // P5（POST /wallet/adjust 精确）：超管+财务 放行（非法 body ⇒ 下游 400）；运营/只读 403
    expectHttp(checks, await g5('P5 超管', 'POST', '/api/admin/wallet/adjust', s.adminToken, {}), 400, ErrCode.BAD_PARAM, 'G5 P5 超管（放行 ⇒ 下游 400）');
    expectHttp(checks, await g5('P5 财务', 'POST', '/api/admin/wallet/adjust', s.finToken, {}), 400, ErrCode.BAD_PARAM, 'G5 P5 财务（放行 ⇒ 下游 400）');
    expectHttp(checks, await g5('P5 运营', 'POST', '/api/admin/wallet/adjust', s.operToken, {}), 403, ErrCode.FORBIDDEN, 'G5 P5 运营 ⇒ 403');
    expectHttp(checks, await g5('P5 只读', 'POST', '/api/admin/wallet/adjust', s.viewerToken, {}), 403, ErrCode.FORBIDDEN, 'G5 P5 只读 ⇒ 403');

    // P6（POST /wallet/reverse 精确）：超管+财务 放行；运营/只读 403
    expectHttp(checks, await g5('P6 超管', 'POST', '/api/admin/wallet/reverse', s.adminToken, {}), 400, ErrCode.BAD_PARAM, 'G5 P6 超管（放行 ⇒ 下游 400）');
    expectHttp(checks, await g5('P6 财务', 'POST', '/api/admin/wallet/reverse', s.finToken, {}), 400, ErrCode.BAD_PARAM, 'G5 P6 财务（放行 ⇒ 下游 400）');
    expectHttp(checks, await g5('P6 运营', 'POST', '/api/admin/wallet/reverse', s.operToken, {}), 403, ErrCode.FORBIDDEN, 'G5 P6 运营 ⇒ 403');
    expectHttp(checks, await g5('P6 只读', 'POST', '/api/admin/wallet/reverse', s.viewerToken, {}), 403, ErrCode.FORBIDDEN, 'G5 P6 只读 ⇒ 403');

    // P7（POST /wallet/reconcile/run 精确）：超管+财务 放行（真跑一轮 ⇒ 200）；运营/只读 403
    expectHttp(checks, await g5('P7 超管', 'POST', '/api/admin/wallet/reconcile/run', s.adminToken, undefined), 200, ErrCode.OK, 'G5 P7 超管（放行 ⇒ 真跑一轮 200）');
    expectHttp(checks, await g5('P7 财务', 'POST', '/api/admin/wallet/reconcile/run', s.finToken, undefined), 200, ErrCode.OK, 'G5 P7 财务（放行 ⇒ 真跑一轮 200）');
    expectHttp(checks, await g5('P7 运营', 'POST', '/api/admin/wallet/reconcile/run', s.operToken, undefined), 403, ErrCode.FORBIDDEN, 'G5 P7 运营 ⇒ 403');
    expectHttp(checks, await g5('P7 只读', 'POST', '/api/admin/wallet/reconcile/run', s.viewerToken, undefined), 403, ErrCode.FORBIDDEN, 'G5 P7 只读 ⇒ 403');

    // P8（其余 GET：任意已认证角色放行）
    expectHttp(checks, await g5('P8 只读 ops', 'GET', '/api/admin/wallet/ops?limit=1', s.viewerToken, undefined), 200, ErrCode.OK, 'G5 P8 只读 GET ops ⇒ 200');
    expectHttp(checks, await g5('P8 运营 events', 'GET', '/api/admin/login-events?limit=1', s.operToken, undefined), 200, ErrCode.OK, 'G5 P8 运营 GET login-events ⇒ 200');
    expectHttp(checks, await g5('P8 财务 summary', 'GET', '/api/admin/wallet/summary', s.finToken, undefined), 200, ErrCode.OK, 'G5 P8 财务 GET summary ⇒ 200');

    // P9（未登记的非 GET：连超管也 403 fail-closed）
    expectHttp(checks, await g5('P9 DELETE', 'DELETE', '/api/admin/config/room.friendRoomEnabled', s.adminToken, undefined), 403, ErrCode.FORBIDDEN, 'G5 P9 未登记 DELETE ⇒ 403（超管也拒）');
    expectHttp(checks, await g5('P9 POST changes', 'POST', '/api/admin/accounts/changes', s.adminToken, {}), 403, ErrCode.FORBIDDEN, 'G5 P9 未登记 POST /accounts/changes ⇒ 403');
    expectHttp(checks, await g5('P9 PUT adjust', 'PUT', '/api/admin/wallet/adjust', s.adminToken, {}), 403, ErrCode.FORBIDDEN, 'G5 P9 未登记 PUT /wallet/adjust ⇒ 403');

    // ⚙️17 尾斜杠负例：GET /api/admin/accounts/ 归一后命中 P1 ⇒ 非超管 403（**不得落 P8**）；
    // 超管同路径 ⇒ 200（express 非严格路由 = 同一处理器）。
    expectHttp(checks, await g5('尾斜杠 只读', 'GET', '/api/admin/accounts/', s.viewerToken, undefined), 403, ErrCode.FORBIDDEN, 'G5 尾斜杠：只读 GET /accounts/ ⇒ 403（归一命中 P1，查实无越权路径）');
    expectHttp(checks, await g5('尾斜杠 超管', 'GET', '/api/admin/accounts/', s.adminToken, undefined), 200, ErrCode.OK, 'G5 尾斜杠：超管 GET /accounts/ ⇒ 200（与无斜杠同处理器）');
    // ⚙️17 的登录变体 fail-closed：`POST /api/admin/login/` 不落豁免 ⇒ 401（无令牌）/ 403（有令牌，P9）
    const g5SlashLogin = await postJson('/api/admin/login/', { username: BOOTSTRAP_USERNAME, password: ADMIN_PASSWORD });
    expectHttp(checks, g5SlashLogin, 401, ErrCode.UNAUTHENTICATED, 'G5 尾斜杠：POST /api/admin/login/（无令牌）⇒ 401 fail-closed');
    checks.eq(g5SlashLogin.body?.message, 'Missing admin token', 'G5 尾斜杠登录 401 文案 = 中间件「Missing admin token」（根本没到登录处理器）');
    expectHttp(checks, await g5('尾斜杠 带令牌', 'POST', '/api/admin/login/', s.adminToken, {}), 403, ErrCode.FORBIDDEN, 'G5 尾斜杠：POST /api/admin/login/（带令牌）⇒ 403（P9 未登记写路径）');

    // ⚙️20（终审 F1 修复）：**大小写路径变体**按 admin 路径走管理鉴权 —— Express/Nest 路由
    // 匹配大小写不敏感（真栈实证），修复前变体被当**玩家路径**：玩家验签放行、AdminAuth 跳过、
    // 请求直通 config-service 的豁免登录路由（口令比较真实执行而失败桶不计数）⇒
    // 现在：无令牌/玩家令牌一律**中间件级** 401（处理器级文案「用户名或口令错误」= F1 读数形态）。
    const caseLoginVariants = ['/API/admin/login', '/Api/Admin/Login', '/API/ADMIN/LOGIN'];
    for (const variant of caseLoginVariants) {
      const r = await postJson(variant, { username: BOOTSTRAP_USERNAME, password: 'definitely-wrong-pw' });
      expectHttp(checks, r, 401, ErrCode.UNAUTHENTICATED, `G5 ⚙️20：POST ${variant}（无令牌）⇒ 401 fail-closed`);
      checks.eq(
        r.body?.message,
        'Missing admin token',
        `G5 ⚙️20：${variant} 401 文案 = 中间件级「Missing admin token」（未达登录处理器）`,
      );
    }
    // F1 的原读数组合：**玩家令牌 + 变体**（修复前 = 处理器级 401「用户名或口令错误」，证明口令比较真的执行）
    const casePlayerVariant = await postJson(
      '/API/admin/login',
      { username: BOOTSTRAP_USERNAME, password: 'definitely-wrong-pw' },
      s.userU!.accessToken,
    );
    expectHttp(checks, casePlayerVariant, 401, ErrCode.TOKEN_INVALID, 'G5 ⚙️20：玩家令牌 POST /API/admin/login 变体 ⇒ 401（不得作玩家路径直通）');
    checks.that(
      String(casePlayerVariant.body?.message ?? '').includes('admin token'),
      `G5 ⚙️20：变体在 AdminAuth 被拒（中间件级文案）—— 实际 ${JSON.stringify(casePlayerVariant.body?.message)}`,
    );
    checks.that(
      !String(casePlayerVariant.body?.message ?? '').includes('用户名或口令错误'),
      'G5 ⚙️20：文案 ≠ 处理器级「用户名或口令错误」（防「直通处理器」回归）',
    );
    // 无令牌 GET 变体 ⇒ 401（同样不得作玩家路径直通）
    expectHttp(checks, await getJson('/API/admin/accounts'), 401, ErrCode.UNAUTHENTICATED, 'G5 ⚙️20：GET /API/admin/accounts（无令牌）⇒ 401');
    // 带**有效管理令牌**的 POST 变体 ⇒ P9 403（非豁免、非 GET —— 变体不达处理器、不注入）
    expectHttp(checks, await g5('⚙️20 变体带令牌', 'POST', '/Api/Admin/Login', s.adminToken, {}), 403, ErrCode.FORBIDDEN, 'G5 ⚙️20：POST /Api/Admin/Login（带令牌）⇒ 403（P9 未登记写路径）');

    // 对照（C11）：小写登录失败**仍正常计数** —— ⚙️20 的识别归一只关「谁是 admin 路径」，
    // 未伤及正常登录路径的失败桶语义（桶增量 ≥1）。
    // ⚠️ 用**独立探针用户名**（不是 `admin`）：这次失败会真落一条 login_events 行，
    // G9 有一条直核「window 内 admin 的 success=0 行数 = 0」（形状 400 零落行），
    // 借 admin 的用户名会把它污染成假红。
    const CASE_PROBE_USERNAME = 's19caseprobe';
    const bucketSumNow = (): number => {
      const scanNow = redisRaw(['--scan', '--pattern', 'ratelimit:admin-login-fail:*']);
      const keys = scanNow.stdout.split('\n').map((x) => x.trim()).filter((x) => x !== '');
      if (keys.length === 0) return 0;
      return redisRaw(['MGET', ...keys]).stdout
        .split('\n')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n))
        .reduce((a, b) => a + b, 0);
    };
    const g5BucketBefore = bucketSumNow();
    const g5WrongLower = await postJson('/api/admin/login', { username: CASE_PROBE_USERNAME, password: 'definitely-wrong-pw' });
    expectHttp(checks, g5WrongLower, 401, ErrCode.UNAUTHENTICATED, 'G5 ⚙️20 对照：小写错口令 ⇒ 401（仍达处理器）');
    await new Promise((r) => setTimeout(r, 200)); // finish 钩子的异步计数落库
    const g5BucketAfter = bucketSumNow();
    checks.that(
      g5BucketAfter > g5BucketBefore,
      `G5 ⚙️20 对照：小写登录失败**正常计数**（桶 前 ${g5BucketBefore} → 后 ${g5BucketAfter}）`,
    );

    /* ════════════════════════════════════════════════════════════════════
     * G6 账号 CRUD + 留痕页签 + 并发互降 + 第二账号 actor
     * ════════════════════════════════════════════════════════════════════ */
    step('G6 账号 CRUD：建档/重复 409/校验 400/改角色/停用/启用/改密（新旧口令各一次）；留痕页签四动作；并发互降恰一成功一 409');
    s.adminToken = await adminLogin(); // 换新写桶（30 次/5 分钟/令牌指纹 —— 本组写多，避免撞桶）
    const g6Create = await postJson<{ id: number; username: string; role: string; status: string }>(
      '/api/admin/accounts',
      { username: USERNAME_CRUD, password: ONE_TIME_PASSWORD, role: 'viewer' },
      s.adminToken,
    );
    expectHttp(checks, g6Create, 200, ErrCode.OK, 'G6 建 CRUD 账号（viewer）');
    // 唯一键冲突 ⇒ 409 借 10001
    const g6Dup = await postJson('/api/admin/accounts', { username: USERNAME_CRUD, password: ONE_TIME_PASSWORD, role: 'viewer' }, s.adminToken);
    checks.eq(g6Dup.status, 409, 'G6 重复用户名 ⇒ HTTP 409');
    checks.eq(g6Dup.body?.code, ErrCode.BAD_PARAM, 'G6 重复用户名 ⇒ code 10001（借）');
    checks.eq(g6Dup.body?.message, '用户名已存在', 'G6 重复用户名 ⇒ 文案「用户名已存在」');
    // 子集校验 400 ×3
    expectHttp(checks, await postJson('/api/admin/accounts', { username: 'AB', password: ONE_TIME_PASSWORD, role: 'viewer' }, s.adminToken), 400, ErrCode.BAD_PARAM, 'G6 用户名格式（2 字符）⇒ 400');
    expectHttp(checks, await postJson('/api/admin/accounts', { username: `s19p-${TAG}`, password: 'short', role: 'viewer' }, s.adminToken), 400, ErrCode.BAD_PARAM, 'G6 口令 <10 ⇒ 400');
    expectHttp(checks, await postJson('/api/admin/accounts', { username: `s19q-${TAG}`, password: ONE_TIME_PASSWORD, role: 'root' }, s.adminToken), 400, ErrCode.BAD_PARAM, 'G6 角色非法 ⇒ 400');
    s.crudId = g6Create.body!.data!.id;

    // 账号列表：白名单为空 ⇒ 任何查询键 400（⚙️9）
    const g6ListBadKey = await getJson('/api/admin/accounts?limit=5', s.adminToken);
    checks.eq(g6ListBadKey.status, 400, 'G6 账号列表带未知键（limit）⇒ 400');
    checks.eq(g6ListBadKey.body?.code, ErrCode.BAD_PARAM, 'G6 账号列表未知键 ⇒ code 10001');
    checks.that(
      String(g6ListBadKey.body?.message ?? '').includes('未知查询参数：limit'),
      `G6 未知键文案逐字「未知查询参数：<key>」—— 实际 ${JSON.stringify(g6ListBadKey.body?.message)}`,
    );

    // 改角色（viewer→operator）→ 停用 → 启用 → 改密（四动作 + 多字段序）
    expectHttp(checks, await sendJson('PATCH', `/api/admin/accounts/${s.crudId}`, { role: 'operator' }, { token: s.adminToken }), 200, ErrCode.OK, 'G6 改角色 viewer→operator');
    expectHttp(checks, await sendJson('PATCH', `/api/admin/accounts/${s.crudId}`, { status: 'disabled' }, { token: s.adminToken }), 200, ErrCode.OK, 'G6 停用 CRUD 账号');
    expectHttp(checks, await sendJson('PATCH', `/api/admin/accounts/${s.crudId}`, { status: 'active' }, { token: s.adminToken }), 200, ErrCode.OK, 'G6 复启 CRUD 账号');
    expectHttp(checks, await sendJson('PATCH', `/api/admin/accounts/${s.crudId}`, { password: CRUD_NEW_PASSWORD }, { token: s.adminToken }), 200, ErrCode.OK, 'G6 重置口令（password_reset）');

    // 留痕页签：恰五行、动作序 role→disable→enable→password_reset + create，detail 逐字
    const g6Changes = await getJson<{ rows: AccountChangeRow[] }>(
      `/api/admin/accounts/changes?targetId=${s.crudId}&limit=50`,
      s.adminToken,
    );
    expectHttp(checks, g6Changes, 200, ErrCode.OK, 'G6 账号留痕页签读取');
    const g6Rows = g6Changes.body?.data?.rows ?? [];
    checks.eq(g6Rows.length, 5, 'G6 留痕恰 5 行（create + 四动作；targetId 过滤，本 run 独有账号）');
    checks.eq(
      [...g6Rows].map((r) => r.action).sort().join(','),
      'create,disable,enable,password_reset,role',
      'G6 留痕动作集恰 = create/role/disable/enable/password_reset（各一行）',
    );
    const g6ByAction = (a: string): AccountChangeRow | undefined => g6Rows.find((r) => r.action === a);
    // ⚠️ MySQL 的 JSON 列**重排对象键序**（按「短键在前」物化）⇒ 不逐字比 stringify，
    // 逐字段比（create 的 detail={role}；role 的 detail={from,to}）。
    const g6CreateDetail = g6ByAction('create')?.detail as { role?: unknown } | null | undefined;
    checks.eq(g6CreateDetail?.role, 'viewer', 'G6 create 留痕 detail = {role:"viewer"}');
    const g6RoleDetail = g6ByAction('role')?.detail as { from?: unknown; to?: unknown } | null | undefined;
    checks.that(
      g6RoleDetail?.from === 'viewer' && g6RoleDetail?.to === 'operator',
      `G6 role 留痕 detail = {from:"viewer",to:"operator"} —— 实际 ${JSON.stringify(g6ByAction('role')?.detail)}`,
    );
    checks.eq(g6ByAction('disable')?.detail, null, 'G6 disable 留痕 detail = null（只记发生）');
    checks.eq(g6ByAction('password_reset')?.detail, null, 'G6 password_reset 留痕 detail = null');
    checks.that(
      g6Rows.every((r) => r.actor === BOOTSTRAP_USERNAME && r.username === USERNAME_CRUD && r.targetId === s.crudId),
      'G6 留痕每行 actor=admin、username/targetId 指向本账号',
    );

    // 改密真实生效：新口令 200 / 旧口令 401
    expectHttp(checks, await postJson('/api/admin/login', { username: USERNAME_CRUD, password: CRUD_NEW_PASSWORD }), 200, ErrCode.OK, 'G6 改密后新口令可登录');
    expectHttp(checks, await postJson('/api/admin/login', { username: USERNAME_CRUD, password: ONE_TIME_PASSWORD }), 401, ErrCode.UNAUTHENTICATED, 'G6 改密后旧口令 ⇒ 401');

    // ── 并发互降负例（C13/S7）：活跃超管恰两名 {admin, s19s-*} 时，两并发 PATCH 互降至
    //    finance —— 恰一成功 + 一 409（最后一名超管保护），事后活跃超管 ≥1，随后复原 admin。
    step('G6 并发互降：两并发 PATCH（admin→降 s19s*；s19s*→降 admin）——恰一成功一 409，超管 ≥1');
    const g6Pre = await getJson<{ accounts: AdminAccountRow[] }>('/api/admin/accounts', s.adminToken);
    const g6PreSupers = (g6Pre.body?.data?.accounts ?? []).filter((r) => r.role === 'super_admin' && r.status === 'active');
    checks.that(
      g6PreSupers.length === 2 &&
        g6PreSupers.some((r) => r.username === BOOTSTRAP_USERNAME) &&
        g6PreSupers.some((r) => r.username === USERNAME_SUP),
      `G6 互降前提：活跃超管恰两名 {admin, ${USERNAME_SUP}} —— 实际 ${JSON.stringify(g6PreSupers.map((r) => r.username))}`,
    );
    const [g6DemoteSup, g6DemoteAdmin] = await Promise.all([
      sendJson('PATCH', `/api/admin/accounts/${s.supId}`, { role: DEMOTE_ROLE }, { token: s.adminToken }),
      sendJson('PATCH', `/api/admin/accounts/${s.adminId}`, { role: DEMOTE_ROLE }, { token: s.supToken }),
    ]);
    const g6Statuses = [g6DemoteSup.status, g6DemoteAdmin.status].sort((a, b) => a - b).join(',');
    checks.eq(g6Statuses, '200,409', 'G6 互降：两并发 PATCH 恰一 200、一 409（锁定读串行化：后到者见「最后一名超管」）');
    const g6Codes = [g6DemoteSup.body?.code, g6DemoteAdmin.body?.code].sort((a, b) => Number(a) - Number(b)).join(',');
    checks.eq(g6Codes, '0,10001', 'G6 互降：两信封码恰 {0, 10001}（借码冲突）');
    const g6Conflict = g6DemoteSup.status === 409 ? g6DemoteSup : g6DemoteAdmin;
    checks.eq(g6Conflict.body?.message, '不能停用或降级最后一名超级管理员', 'G6 互降 409 ⇒ 文案「不能停用或降级最后一名超级管理员」');
    // 复原 admin（幂等；sup 的 token claims 恒为 super_admin，无论其库内角色）
    expectHttp(checks, await sendJson('PATCH', `/api/admin/accounts/${s.adminId}`, { role: 'super_admin' }, { token: s.supToken }), 200, ErrCode.OK, 'G6 互降现场复原 admin 为 super_admin');
    const g6Post = await getJson<{ accounts: AdminAccountRow[] }>('/api/admin/accounts', s.adminToken);
    const g6PostSupers = (g6Post.body?.data?.accounts ?? []).filter((r) => r.role === 'super_admin' && r.status === 'active');
    checks.that(
      g6PostSupers.length >= 1 && g6PostSupers.some((r) => r.username === BOOTSTRAP_USERNAME),
      `G6 互降后：活跃超管 ≥1 且含引导号（永不 0 超管自锁）—— 实际 ${JSON.stringify(g6PostSupers.map((r) => r.username))}`,
    );

    // ── 第二账号发 adjust ⇒ `ops.actor` = **其用户名**（规格 §4.1#4；防「读了固定值 admin」的假绿）
    step('G6 尾：finance 账号发两笔 adjust ⇒ ops.actor = finance 用户名（非引导号字面量）');
    s.userU = s.userU ?? (await registerUser(9));
    const finAdjust = async (delta: number, actionId: string): Promise<{ status: number; code: number | undefined; opId: number | null; balanceAfter: number | null }> => {
      const res = await postJson<{ balanceBefore: number; balanceAfter: number; opId: number }>(
        '/api/admin/wallet/adjust',
        { userId: s.userU!.id, delta, reason: `slice19 ${TAG}`, actionId },
        s.finToken,
      );
      return { status: res.status, code: res.body?.code, opId: res.body?.data?.opId ?? null, balanceAfter: res.body?.data?.balanceAfter ?? null };
    };
    const adj1 = await finAdjust(500, AID('adj1'));
    checks.eq(adj1.status, 200, 'G6 尾 adj1（+500）⇒ HTTP 200');
    checks.eq(adj1.code, ErrCode.OK, 'G6 尾 adj1 ⇒ code 0');
    checks.that(adj1.opId !== null && adj1.opId > 0, `G6 尾 adj1 ⇒ opId>0（实际 ${adj1.opId}）`);
    const adj2 = await finAdjust(1000, AID('adj2'));
    checks.eq(adj2.status, 200, 'G6 尾 adj2（+1000）⇒ HTTP 200');
    checks.eq(adj2.code, ErrCode.OK, 'G6 尾 adj2 ⇒ code 0');
    checks.eq(adj2.balanceAfter, 1500, 'G6 尾 adj2 ⇒ balanceAfter=1500（500+1000，U 为新注册 0 余额）');
    const g6Ops = await getJson<{ rows: AdminOpsRow[] }>(`/api/admin/wallet/ops?ownerId=${encodeURIComponent(s.userU.id)}&limit=100`, s.adminToken);
    expectHttp(checks, g6Ops, 200, ErrCode.OK, 'G6 尾 ops 读 U 的流水');
    const adj1Row = (g6Ops.body?.data?.rows ?? []).find((r) => r.opId === adj1.opId);
    checks.that(adj1Row !== undefined, 'G6 尾 ops 含 adj1 的流水行');
    checks.eq(adj1Row?.actor, USERNAME_FIN, 'G6 尾 ops.actor = finance 账号用户名（§4.1#4：第二账号 actor 防假绿）');
    checks.eq(adj1Row?.actionId, AID('adj1'), 'G6 尾 ops 行 actionId 回读一致');

    /* ════════════════════════════════════════════════════════════════════
     * G7 冲正全链
     * ════════════════════════════════════════════════════════════════════ */
    step('G7 冲正全链：正例（entries/refId/actor）+ 同原因重放 200 + 异原因 14002 + 非 admin_adjust 409 + 14001 原子拒 + reversed 旗');
    const reverse = async (opId: number, reason: string): Promise<RawResult> =>
      sendJson('POST', '/api/admin/wallet/reverse', { opId, reason }, { token: s.finToken });

    const g7Reverse = await reverse(adj1.opId!, `slice19 ${TAG} 冲正一`);
    expectHttp(checks, g7Reverse, 200, ErrCode.OK, 'G7 冲正 adj1 ⇒ 200');
    const g7Data = g7Reverse.body?.data as
      | { opId: number; actionId: string; replayed: boolean; entries: Array<{ ownerId: string; balanceAfter: number }> }
      | undefined;
    checks.eq(g7Data?.replayed, false, 'G7 首冲 ⇒ replayed=false');
    checks.eq(g7Data?.actionId, `admin:reverse:${adj1.opId}`, 'G7 actionId = admin:reverse:<opId>（§2.8 逐字）');
    checks.eq(g7Data?.entries?.[0]?.ownerId, s.userU.id, 'G7 entries[0].ownerId = 原 flow 的 ownerId');
    checks.eq(g7Data?.entries?.[0]?.balanceAfter, 1000, 'G7 entries[0].balanceAfter = 1000（1500−500）');

    const g7Replay = await reverse(adj1.opId!, `slice19 ${TAG} 冲正一`);
    expectHttp(checks, g7Replay, 200, ErrCode.OK, 'G7 同原因重放 ⇒ 200');
    const g7ReplayData = g7Replay.body?.data as { opId: number; replayed: boolean; entries: Array<{ balanceAfter: number }> } | undefined;
    checks.eq(g7ReplayData?.replayed, true, 'G7 重放 ⇒ replayed=true（载荷指纹相同走 apply 重放）');
    checks.eq(g7ReplayData?.opId, g7Data?.opId, 'G7 重放 ⇒ 同 opId（不重复冲正）');
    checks.eq(g7ReplayData?.entries?.[0]?.balanceAfter, 1000, 'G7 重放 ⇒ 历史快照 balanceAfter=1000');

    const g7DiffReason = await reverse(adj1.opId!, `slice19 ${TAG} 另一个原因`);
    checks.eq(g7DiffReason.status, 409, 'G7 异原因二次冲正 ⇒ HTTP 409');
    checks.eq(g7DiffReason.body?.code, ErrCode.E_ACTION_CONFLICT, 'G7 异原因 ⇒ code 14002（同 actionId 异指纹）');
    checks.eq(g7DiffReason.body?.message, '该操作已冲正', 'G7 异原因 ⇒ 文案「该操作已冲正」');

    // 14001 原子拒：+3000 后整笔花掉 ⇒ 冲正需要 ™余额不足（可能已部分花费）
    const adj3 = await finAdjust(3000, AID('adj3'));
    checks.eq(adj3.balanceAfter, 4000, 'G7 adj3（+3000）⇒ balanceAfter=4000');
    const adj4 = await finAdjust(-4000, AID('adj4'));
    checks.eq(adj4.balanceAfter, 0, 'G7 adj4（−4000 花光）⇒ balanceAfter=0');
    const g7Insuff = await reverse(adj3.opId!, `slice19 ${TAG} 冲正三`);
    checks.eq(g7Insuff.status, 409, 'G7 已花费的 op 冲正 ⇒ HTTP 409（不是 500）');
    checks.eq(g7Insuff.body?.code, ErrCode.E_INSUFFICIENT_FUNDS, 'G7 ⇒ code 14001');
    checks.that(
      String(g7Insuff.body?.message ?? '').includes('余额不足，无法整笔冲正'),
      `G7 14001 文案点名「余额不足，无法整笔冲正…」—— 实际 ${JSON.stringify(g7Insuff.body?.message)}`,
    );
    const g7Bal = await getJson<{ balance: number }>(`/api/admin/wallet/accounts/${encodeURIComponent(s.userU.id)}`, s.adminToken);
    expectHttp(checks, g7Bal, 200, ErrCode.OK, 'G7 14001 后读余额');
    checks.eq(g7Bal.body?.data?.balance, 0, 'G7 14001 原子拒 ⇒ 余额不变（0）');

    // 非 admin_adjust ⇒ 409「该操作不可冲正」（直投 RPC 造一笔 signup_grant；owner = 幽灵账户）
    const g7NonRev = await rpcCall<CurrencyApplyData>(CURRENCY_RPC, RPC_PATTERNS.currencyApply, {
      actionId: AID('nonrev'),
      source: 'signup_grant',
      entries: [{ ownerId: `s19nr-${TAG}`, delta: 5 }],
    } satisfies CurrencyApplyRequest);
    checks.that(g7NonRev.ok === true, `G7 直投 signup_grant op 成功（opId=${g7NonRev.ok ? g7NonRev.data.opId : 'n/a'}）`);
    if (!g7NonRev.ok) {
      throw new ConformanceError(`G7 直投 signup_grant 落败：code=${g7NonRev.code} message=${g7NonRev.message}`);
    }
    const g7NotReversible = await reverse(g7NonRev.data.opId, `slice19 ${TAG} 不可冲正`);
    checks.eq(g7NotReversible.status, 409, 'G7 非 admin_adjust 冲正 ⇒ HTTP 409');
    checks.eq(g7NotReversible.body?.code, ErrCode.BAD_PARAM, 'G7 非 admin_adjust ⇒ code 10001（借）');
    checks.eq(g7NotReversible.body?.message, '该操作不可冲正', 'G7 非 admin_adjust ⇒ 文案「该操作不可冲正」');

    // reversed 旗翻转：adj1 的行 true；adj2/adj3 的行 false；冲正 op 的行 source=admin_reverse
    const g7Ops = await getJson<{ rows: AdminOpsRow[] }>(`/api/admin/wallet/ops?ownerId=${encodeURIComponent(s.userU.id)}&limit=100`, s.adminToken);
    expectHttp(checks, g7Ops, 200, ErrCode.OK, 'G7 ops 读 U 的流水（reversed 旗检查）');
    const g7Rows = g7Ops.body?.data?.rows ?? [];
    const g7Adj1Rows = g7Rows.filter((r) => r.opId === adj1.opId);
    const g7Adj2Rows = g7Rows.filter((r) => r.opId === adj2.opId);
    const g7Adj3Rows = g7Rows.filter((r) => r.opId === adj3.opId);
    const g7RevRows = g7Rows.filter((r) => r.opId === g7Data?.opId);
    checks.that(g7Adj1Rows.length === 1 && g7Adj1Rows[0]!.reversed === true, 'G7 reversed 旗：已冲正的 adj1 行 = true（EXISTS 判定）');
    checks.that(g7Adj2Rows.length === 1 && g7Adj2Rows[0]!.reversed === false, 'G7 reversed 旗：未冲正的 adj2 行 = false');
    checks.that(g7Adj3Rows.length === 1 && g7Adj3Rows[0]!.reversed === false, 'G7 reversed 旗：被 14001 拒的 adj3 行 = false（拒即无留痕）');
    checks.that(
      g7RevRows.length === 1 && g7RevRows[0]!.source === 'admin_reverse' && g7RevRows[0]!.actor === USERNAME_FIN && g7RevRows[0]!.refId === AID('adj1'),
      `G7 冲正 op 行：source=admin_reverse / actor=${USERNAME_FIN} / refId=原 actionId —— 实际 ${JSON.stringify(g7RevRows[0])}`,
    );

    /* ════════════════════════════════════════════════════════════════════
     * G8 配置写 → changes 行 + 两并发 PUT 链式断言 + CSV 字节
     * ════════════════════════════════════════════════════════════════════ */
    step('G8 配置写：真栈 PUT ⇒ changes old→new（actor）；两并发 PUT 链自洽；config-changes.csv 字节级（BOM/CRLF）');
    s.adminToken = await adminLogin(); // 再换写桶
    const CFG_KEY = 'room.matchScanIntervalMs';
    const g8Before = await adminGetConfig<AdminConfigData>(s.adminToken);
    const g8V0 = Number(g8Before.body?.data?.config?.[CFG_KEY]?.value);
    const g8Kv0 = Number(g8Before.body?.data?.config?.[CFG_KEY]?.version);
    checks.eq(g8V0, s.cfgV0, 'G8 起手值 = G4 复原后的基线（本片两次改动都自还原）');

    // 并发两笔不同值（V1/V2 与 V0 相距 100000，绝不与 G4 的 ±50000 行混淆）
    const g8V1 = g8V0 >= 400_000 ? g8V0 - 100_000 : g8V0 + 100_000;
    const g8V2 = g8V1 + 1;
    const [g8PutA, g8PutB] = await Promise.all([
      adminPutConfig(CFG_KEY, g8V1, s.adminToken),
      adminPutConfig(CFG_KEY, g8V2, s.adminToken),
    ]);
    expectHttp(checks, g8PutA, 200, ErrCode.OK, 'G8 并发 PUT #1（value=V1）');
    expectHttp(checks, g8PutB, 200, ErrCode.OK, 'G8 并发 PUT #2（value=V2）');
    const g8Versions = [
      Number((g8PutA.body?.data as { version?: number } | undefined)?.version),
      Number((g8PutB.body?.data as { version?: number } | undefined)?.version),
    ].sort((a, b) => a - b);
    checks.eq(g8Versions.join(','), `${g8Kv0 + 1},${g8Kv0 + 2}`, 'G8 并发两 PUT ⇒ version = kv0+1 与 kv0+2（行锁串行化，无覆盖丢弃）');

    // 链式断言：该键本次 window 的两行 changes 首尾相接（old→new 链自洽，无错位行）
    const g8Changes = await getJson<{ rows: ConfigChangeRow[] }>(
      `/api/admin/config/changes?key=${encodeURIComponent(CFG_KEY)}&from=${RUN_START_MS}&limit=10`,
      s.adminToken,
    );
    expectHttp(checks, g8Changes, 200, ErrCode.OK, 'G8 读 changes（本次 window）');
    const g8ChainRows = (g8Changes.body?.data?.rows ?? [])
      .filter((r) => r.newValue === g8V1 || r.newValue === g8V2)
      .sort((a, b) => a.id - b.id);
    checks.eq(g8ChainRows.length, 2, 'G8 chain：window 内恰两行（V1/V2 各一，无多余/丢行）');
    checks.eq(g8ChainRows[0]?.oldValue, g8V0, 'G8 chain：第一行 oldValue = 基线 V0（起点无错位）');
    checks.eq(g8ChainRows[1]?.oldValue, g8ChainRows[0]?.newValue, 'G8 chain：第二行 oldValue = 第一行 newValue（首尾相接）');
    checks.that(
      g8ChainRows.every((r) => r.actor === BOOTSTRAP_USERNAME),
      'G8 chain：两行 actor 均为网关注入的 admin 用户名',
    );
    const g8After = await adminGetConfig<AdminConfigData>(s.adminToken);
    checks.eq(
      Number(g8After.body?.data?.config?.[CFG_KEY]?.value),
      g8ChainRows[1]?.newValue,
      'G8 chain：当前键值 = 链末行的 newValue（终值 = 串行化后的最后写）',
    );
    // 还原基线
    expectHttp(checks, await adminPutConfig(CFG_KEY, g8V0, s.adminToken), 200, ErrCode.OK, 'G8 还原 CFG_KEY 至基线');
    const g8Back = await adminGetConfig<AdminConfigData>(s.adminToken);
    checks.eq(Number(g8Back.body?.data?.config?.[CFG_KEY]?.value), g8V0, 'G8 还原后键值 = 基线（自证还原到位）');

    // CSV 样本（字节级；经网关 ⇒ 同时是 fde7721 字节保真回归的守卫）
    const g8Csv = await fetchCsvRaw(
      `/api/admin/config/changes.csv?key=${encodeURIComponent(CFG_KEY)}&from=${RUN_START_MS}`,
      s.adminToken,
    );
    csvByteChecks(checks, g8Csv, 'G8 config-changes.csv', 'config-changes', [
      CFG_KEY,
      String(g8V1),
      String(g8V2),
      BOOTSTRAP_USERNAME,
    ]);
    // CSV 变体白名单 = JSON 版去掉 cursor/limit（带上即 400）
    expectHttp(
      checks,
      await getJson(`/api/admin/config/changes.csv?key=${encodeURIComponent(CFG_KEY)}&limit=5`, s.adminToken),
      400,
      ErrCode.BAD_PARAM,
      'G8 CSV 变体带 limit ⇒ 400（⚙️9/S16a）',
    );

    /* ════════════════════════════════════════════════════════════════════
     * G9 登录事件
     * ════════════════════════════════════════════════════════════════════ */
    step('G9 登录事件：成功/失败双行、IP 非空且非伪造值、未知也落行、形状 400 不落行（SQL 直核）');
    const g9Fin = await getJson<{ rows: LoginEventRow[] }>(
      `/api/admin/login-events?username=${encodeURIComponent(USERNAME_FIN)}&from=${RUN_START_MS}&limit=100`,
      s.adminToken,
    );
    expectHttp(checks, g9Fin, 200, ErrCode.OK, 'G9 读 finance 账号事件（window）');
    const g9FinRows = g9Fin.body?.data?.rows ?? [];
    checks.eq(g9FinRows.length, 2, 'G9 finance 恰两行（G1 登录 + G4 带伪造头登录）');
    checks.that(g9FinRows.every((r) => r.success === true), 'G9 finance 两行 success=true（含伪造头那次 —— 伪造头不影响凭据判定）');
    checks.that(
      g9FinRows.every((r) => typeof r.ip === 'string' && r.ip.length > 0 && r.ip !== 'unknown'),
      `G9 finance 两行 ip 非空非 unknown（网关注入的真实客户端 IP）—— 实际 ${JSON.stringify(g9FinRows.map((r) => r.ip))}`,
    );
    checks.that(
      g9FinRows.every((r) => r.ip !== '6.6.6.6'),
      'G9 伪造 x-client-ip 永不达下游：事件 IP ≠ 6.6.6.6',
    );

    const g9Viewer = await getJson<{ rows: LoginEventRow[] }>(
      `/api/admin/login-events?username=${encodeURIComponent(USERNAME_VIEWER)}&from=${RUN_START_MS}&limit=100`,
      s.adminToken,
    );
    expectHttp(checks, g9Viewer, 200, ErrCode.OK, 'G9 读 viewer 账号事件（window）');
    const g9ViewerRows = g9Viewer.body?.data?.rows ?? [];
    checks.eq(g9ViewerRows.length, 4, 'G9 viewer 恰四行（G1 成功 + 错口令失败 + 停用 403 + 复启成功）');
    checks.eq(g9ViewerRows.filter((r) => r.success).length, 2, 'G9 viewer 成功行恰 2（成败双行落库）');
    checks.eq(g9ViewerRows.filter((r) => !r.success).length, 2, 'G9 viewer 失败行恰 2');
    checks.that(
      g9ViewerRows.every((r) => r.accountId === s.viewerId),
      'G9 viewer 每行 accountId = 账号 id（查行命中后回填）',
    );
    checks.that(
      g9ViewerRows.filter((r) => !r.success).every((r) => typeof r.ip === 'string' && r.ip.length > 0),
      'G9 viewer 失败行也带 IP（ip 列在成败两态都落）',
    );
    // 形状 400 不落行的第二直核样本（无 password 的调用带 username=admin ⇒ 若误落会出现
    // 一条 admin 的失败行；用 window + success=0 计数直核「形状错不进事件」）
    checks.eq(
      mysqlText(
        `SELECT COUNT(*) FROM admin_login_events WHERE username='admin' AND success=0 AND created_at >= FROM_UNIXTIME(${Math.floor(RUN_START_MS / 1000)})`,
      ),
      '0',
      'G9 形状 400（缺 password/超长口令/İ）零落行：window 内 admin 的 success=0 行数 = 0（⚙️3）',
    );

    /* ════════════════════════════════════════════════════════════════════
     * G10 财务读口
     * ════════════════════════════════════════════════════════════════════ */
    step('G10 财务读口：ops 四形态（无过滤/ownerId/from-to/cursor）+ source/actor 过滤 + limit 边界 + summary 两态/空窗/型别 + 详情 + flows.csv 字节');
    const uId = s.userU!.id;
    // 形态① 无过滤（EXISTS 漂移的历史高危路径）
    const f1 = await getJson<{ rows: AdminOpsRow[]; nextCursor: number | null }>('/api/admin/wallet/ops?limit=5', s.adminToken);
    expectHttp(checks, f1, 200, ErrCode.OK, 'G10 形态①无过滤 ops?limit=5');
    const f1Rows = f1.body?.data?.rows ?? [];
    checks.that(f1Rows.length >= 1 && f1Rows.length <= 5, `G10 ① rows 1..5 —— 实际 ${f1Rows.length}`);
    checks.that(f1Rows.every((r) => typeof r.reversed === 'boolean'), 'G10 ① 每行 reversed 为布尔（"0"/"1" 字符串漂移的守卫）');
    checks.eq(f1.body?.data?.nextCursor, f1Rows.length === 5 ? f1Rows[4]!.flowId : null, 'G10 ① nextCursor 口径 = rows.length===limit ? 末行 flowId : null');
    // 形态② ownerId
    const f2 = await getJson<{ rows: AdminOpsRow[]; nextCursor: number | null }>(`/api/admin/wallet/ops?ownerId=${encodeURIComponent(uId)}&limit=100`, s.adminToken);
    expectHttp(checks, f2, 200, ErrCode.OK, 'G10 形态②ownerId ops?ownerId=…&limit=100');
    const f2Rows = f2.body?.data?.rows ?? [];
    checks.that(f2Rows.length >= 1 && f2Rows.every((r) => r.ownerId === uId), `G10 ② 每行 ownerId 命中 —— 实际 ${f2Rows.length} 行`);
    checks.that(f2Rows.some((r) => r.opId === adj1.opId), 'G10 ② 含 adj1 的流水（ownerId 过滤真在 SQL 里生效）');
    checks.that(f2Rows.every((r) => typeof r.reversed === 'boolean'), 'G10 ② 每行 reversed 为布尔');
    checks.eq(f2.body?.data?.nextCursor, null, 'G10 ② 行数 < limit ⇒ nextCursor=null（不预查）');
    // 形态③ from-to（时间过滤）
    const g10From = RUN_START_MS - 1_000;
    const g10To = Date.now() + 60_000;
    const f3 = await getJson<{ rows: AdminOpsRow[] }>(`/api/admin/wallet/ops?from=${g10From}&to=${g10To}&limit=100`, s.adminToken);
    expectHttp(checks, f3, 200, ErrCode.OK, 'G10 形态③from-to ops?from=…&to=…');
    const f3Rows = f3.body?.data?.rows ?? [];
    checks.that(f3Rows.length >= 1 && f3Rows.every((r) => r.createdAt >= g10From && r.createdAt < g10To), `G10 ③ 每行 createdAt ∈ [from,to) —— 实际 ${f3Rows.length} 行`);
    checks.that(f3Rows.every((r) => typeof r.reversed === 'boolean'), 'G10 ③ 每行 reversed 为布尔');
    // 形态④ cursor（keyset；DESC ⇒ 第二页 id 更小）
    const f4a = await getJson<{ rows: AdminOpsRow[]; nextCursor: number | null }>(`/api/admin/wallet/ops?ownerId=${encodeURIComponent(uId)}&limit=1`, s.adminToken);
    expectHttp(checks, f4a, 200, ErrCode.OK, 'G10 形态④cursor 第一页（limit=1）');
    const f4aRows = f4a.body?.data?.rows ?? [];
    checks.eq(f4aRows.length, 1, 'G10 ④ 第一页恰 1 行');
    checks.eq(f4a.body?.data?.nextCursor, f4aRows[0]?.flowId, 'G10 ④ nextCursor = 末行 flowId');
    const f4b = await getJson<{ rows: AdminOpsRow[]; nextCursor: number | null }>(`/api/admin/wallet/ops?ownerId=${encodeURIComponent(uId)}&limit=1&cursor=${f4a.body?.data?.nextCursor}`, s.adminToken);
    expectHttp(checks, f4b, 200, ErrCode.OK, 'G10 ④ 第二页（cursor=首页 nextCursor）');
    const f4bRows = f4b.body?.data?.rows ?? [];
    checks.eq(f4bRows.length, 1, 'G10 ④ 第二页恰 1 行（U 的流水 ≥2 笔）');
    checks.that(f4bRows.every((r) => r.flowId < f4aRows[0]!.flowId), 'G10 ④ 第二页 flowId 全部 < cursor（DESC keyset）');
    checks.that(f4bRows.every((r) => typeof r.reversed === 'boolean'), 'G10 ④ 第二页 reversed 为布尔');
    // source / actor 过滤（历史「碰巧 200」形态；非唯一覆盖面）
    const f5 = await getJson<{ rows: AdminOpsRow[] }>('/api/admin/wallet/ops?source=admin_adjust&limit=10', s.adminToken);
    expectHttp(checks, f5, 200, ErrCode.OK, 'G10 过滤 source=admin_adjust');
    checks.that((f5.body?.data?.rows ?? []).length >= 1 && (f5.body?.data?.rows ?? []).every((r) => r.source === 'admin_adjust'), 'G10 source 过滤：每行 source 命中');
    const f6 = await getJson<{ rows: AdminOpsRow[] }>(`/api/admin/wallet/ops?actor=${encodeURIComponent(USERNAME_FIN)}&limit=100`, s.adminToken);
    expectHttp(checks, f6, 200, ErrCode.OK, 'G10 过滤 actor=finance 用户名');
    checks.that((f6.body?.data?.rows ?? []).length >= 1 && (f6.body?.data?.rows ?? []).every((r) => r.actor === USERNAME_FIN), 'G10 actor 过滤：每行 actor 命中（第二账号留痕可筛）');
    // limit 边界 / 非法值 / 未知键
    expectHttp(checks, await getJson('/api/admin/wallet/ops?limit=100', s.adminToken), 200, ErrCode.OK, 'G10 limit=100（上限内）⇒ 200');
    expectHttp(checks, await getJson('/api/admin/wallet/ops?limit=101', s.adminToken), 400, ErrCode.BAD_PARAM, 'G10 limit=101（超上限）⇒ 400');
    expectHttp(checks, await getJson('/api/admin/wallet/ops?limit=0', s.adminToken), 400, ErrCode.BAD_PARAM, 'G10 limit=0 ⇒ 400');
    expectHttp(checks, await getJson('/api/admin/wallet/ops?limit=abc', s.adminToken), 400, ErrCode.BAD_PARAM, 'G10 limit=abc ⇒ 400');
    const g10Unknown = await getJson('/api/admin/wallet/ops?foo=1', s.adminToken);
    checks.eq(g10Unknown.status, 400, 'G10 未知查询键 ⇒ 400');
    checks.that(String(g10Unknown.body?.message ?? '').includes('未知查询参数：foo'), `G10 未知键文案逐字 —— 实际 ${JSON.stringify(g10Unknown.body?.message)}`);

    // summary：source / day 两态（同一显式窗口 ⇒ totals 必须相等）+ 型别钉 + 空窗
    const sumSrc = await getJson<{ rows: Array<{ k: string; delta: number; flowCount: number }>; totals: { delta: number; flowCount: number } }>(
      `/api/admin/wallet/summary?groupBy=source&from=${g10From}&to=${g10To}`, s.adminToken,
    );
    expectHttp(checks, sumSrc, 200, ErrCode.OK, 'G10 summary groupBy=source');
    const sumSrcRows = sumSrc.body?.data?.rows ?? [];
    const sumSrcKeys = sumSrcRows.map((r) => r.k);
    checks.that(
      sumSrcKeys.includes('admin_adjust') && sumSrcKeys.includes('admin_reverse'),
      `G10 summary(source) 含 admin_adjust 与 admin_reverse 两组（本 window 有本片造的数）—— 实际 ${JSON.stringify(sumSrcKeys)}`,
    );
    checks.that(
      sumSrcRows.every((r) => typeof r.k === 'string' && typeof r.delta === 'number' && typeof r.flowCount === 'number') &&
        typeof sumSrc.body?.data?.totals?.delta === 'number' &&
        typeof sumSrc.body?.data?.totals?.flowCount === 'number',
      'G10 summary(source) 型别钉：k=string、delta/flowCount=number（SUM 的 DECIMAL 字符串必须转数字）',
    );
    const sumSrcTotals = sumSrc.body?.data?.totals;
    checks.that(
      sumSrcTotals?.delta === sumSrcRows.reduce((a, r) => a + r.delta, 0) &&
        sumSrcTotals?.flowCount === sumSrcRows.reduce((a, r) => a + r.flowCount, 0),
      'G10 summary(source) totals = 各行聚合（服务端自洽；无需第二 SQL）',
    );
    const sumDay = await getJson<{ rows: Array<{ k: string; delta: number; flowCount: number }>; totals: { delta: number; flowCount: number } }>(
      `/api/admin/wallet/summary?groupBy=day&from=${g10From}&to=${g10To}`, s.adminToken,
    );
    expectHttp(checks, sumDay, 200, ErrCode.OK, 'G10 summary groupBy=day');
    const sumDayRows = sumDay.body?.data?.rows ?? [];
    checks.that(sumDayRows.length >= 1, `G10 summary(day) 行数 ≥1 —— 实际 ${sumDayRows.length}`);
    checks.that(
      sumDayRows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.k)) && typeof r.delta === 'number' && typeof r.flowCount === 'number'),
      'G10 summary(day) k = \'YYYY-MM-DD\' 字符串（DATE() 的 Date 对象必须被格式化）+ 数字型别',
    );
    checks.eq(
      JSON.stringify(sumDay.body?.data?.totals),
      JSON.stringify(sumSrcTotals),
      'G10 summary：同窗口 source/day 两态 totals 恒等（切天不丢/不重）',
    );
    const sumEmpty = await getJson<{ rows: unknown[]; totals: { delta: number; flowCount: number } }>(
      `/api/admin/wallet/summary?from=1&to=2`, s.adminToken,
    );
    expectHttp(checks, sumEmpty, 200, ErrCode.OK, 'G10 summary 空窗（1970 年 [1,2) ms）');
    checks.eq((sumEmpty.body?.data?.rows ?? []).length, 0, 'G10 空窗 ⇒ rows=[]（不是删键/报错）');
    checks.eq(JSON.stringify(sumEmpty.body?.data?.totals), '{"delta":0,"flowCount":0}', 'G10 空窗 ⇒ totals {delta:0, flowCount:0}');
    expectHttp(checks, await getJson('/api/admin/wallet/summary?groupBy=week', s.adminToken), 400, ErrCode.BAD_PARAM, 'G10 groupBy 非法 ⇒ 400');
    expectHttp(checks, await getJson('/api/admin/wallet/summary?cursor=1', s.adminToken), 400, ErrCode.BAD_PARAM, 'G10 summary 无 cursor 键 ⇒ 400（未知键）');

    // 详情：多账户 op 全 flows（直投 RPC 造）；404；非数字 400
    const g10Multi = await rpcCall<CurrencyApplyData>(CURRENCY_RPC, RPC_PATTERNS.currencyApply, {
      actionId: AID('multi'),
      source: 'signup_grant',
      entries: [
        { ownerId: `s19ga-${TAG}`, delta: 7 },
        { ownerId: `s19gb-${TAG}`, delta: 11 },
      ],
    } satisfies CurrencyApplyRequest);
    checks.that(g10Multi.ok === true, `G10 直投多账户 op 成功（opId=${g10Multi.ok ? g10Multi.data.opId : 'n/a'}）`);
    if (!g10Multi.ok) {
      throw new ConformanceError(`G10 直投多账户 op 落败：code=${g10Multi.code} message=${g10Multi.message}`);
    }
    const g10MultiId = g10Multi.data.opId;
    const g10Detail = await getJson<{ rows: AdminOpsRow[] }>(`/api/admin/wallet/ops/${g10MultiId}`, s.adminToken);
    expectHttp(checks, g10Detail, 200, ErrCode.OK, 'G10 op 详情（多账户）');
    const g10DetailRows = g10Detail.body?.data?.rows ?? [];
    checks.eq(g10DetailRows.length, 2, 'G10 详情：多账户 op 全 flows（恰 2 行）');
    checks.that(
      g10DetailRows[0]!.flowId < g10DetailRows[1]!.flowId && g10DetailRows.every((r) => r.opId === g10MultiId),
      'G10 详情：rows 按 f.id 升序、同 opId',
    );
    const g10Detail404 = await getJson('/api/admin/wallet/ops/999999999', s.adminToken);
    checks.eq(g10Detail404.status, 404, 'G10 详情：不存在 op ⇒ HTTP 404');
    checks.eq(g10Detail404.body?.code, ErrCode.BAD_PARAM, 'G10 详情 404 ⇒ 借码 10001');
    checks.eq(g10Detail404.body?.message, '操作不存在', 'G10 详情 404 ⇒ 文案「操作不存在」');
    expectHttp(checks, await getJson('/api/admin/wallet/ops/abc', s.adminToken), 400, ErrCode.BAD_PARAM, 'G10 详情：非数字 opId ⇒ 400');

    // flows.csv（字节级；ownerId 过滤面 ⇒ 同时证明 CSV 白名单接受过滤键）
    const g10Csv = await fetchCsvRaw(`/api/admin/wallet/ops.csv?ownerId=${encodeURIComponent(uId)}`, s.adminToken);
    csvByteChecks(checks, g10Csv, 'G10 flows.csv', 'flows', [uId, '流水ID', 'admin_adjust']);

    /* ════════════════════════════════════════════════════════════════════
     * G11 对账读写
     * ════════════════════════════════════════════════════════════════════ */
    step('G11 对账：GET 四字段+keys 恰好；POST run ⇒ 重数（漂移 0）；GET after ⇒ 新鲜度 + lastResult = 手动轮');
    interface ReconcileStatus {
      lastAttemptAt: number | null;
      lastSuccessAt: number | null;
      lastResult: ReconcileRoundResult | null;
      lastError: string | null;
      running: boolean;
    }
    const g11Before = await getJson<ReconcileStatus>('/api/admin/wallet/reconcile', s.adminToken);
    expectHttp(checks, g11Before, 200, ErrCode.OK, 'G11 GET reconcile');
    checks.eq(
      Object.keys(g11Before.body?.data ?? {}).sort().join(','),
      'lastAttemptAt,lastError,lastResult,lastSuccessAt,running',
      'G11 GET data 键集恰五（四字段 + running）',
    );
    const g11B = g11Before.body?.data;
    checks.that(
      (g11B?.lastAttemptAt === null || typeof g11B?.lastAttemptAt === 'number') &&
        (g11B?.lastSuccessAt === null || typeof g11B?.lastSuccessAt === 'number'),
      'G11 lastAttemptAt/lastSuccessAt 为 number|null（epoch ms）',
    );
    checks.that(g11B?.lastResult === null || typeof g11B?.lastResult === 'object', 'G11 lastResult 为对象|null');
    checks.that(g11B?.lastError === null || (typeof g11B?.lastError === 'string' && g11B.lastError.length <= 500), 'G11 lastError 为 null 或 ≤500 字符串（截断纪律）');
    checks.eq(g11B?.running, false, 'G11 running=false（无并发轮）');

    const g11T0 = Date.now();
    const g11Run = await postJson<ReconcileRoundResult>('/api/admin/wallet/reconcile/run', {}, s.finToken);
    expectHttp(checks, g11Run, 200, ErrCode.OK, 'G11 POST reconcile/run（finance 令牌）');
    const g11RunData = g11Run.body?.data as ReconcileRoundResult | undefined;
    checks.eq(
      Object.keys(g11RunData ?? {}).sort().join(','),
      'cacheDriftDeleted,driftAccounts,orphanSignupGrants,robotAccountsBalanceSum,robotPoolBalance',
      'G11 手动轮 data 键集恰五（CurrencyReconcileRoundResult）',
    );
    checks.eq(g11RunData?.driftAccounts, 0, 'G11 手动轮 driftAccounts=0（账实一致；假漂移即红）');
    checks.that(
      typeof g11RunData?.robotPoolBalance === 'number' && g11RunData.robotPoolBalance >= 0 &&
        typeof g11RunData?.robotAccountsBalanceSum === 'number' && g11RunData.robotAccountsBalanceSum >= 0 &&
        typeof g11RunData?.cacheDriftDeleted === 'number' && typeof g11RunData?.orphanSignupGrants === 'number',
      `G11 手动轮五字段均 number 且池/机器人和 ≥0 —— 实际 ${JSON.stringify(g11RunData)}`,
    );

    const g11After = await getJson<ReconcileStatus>('/api/admin/wallet/reconcile', s.adminToken);
    expectHttp(checks, g11After, 200, ErrCode.OK, 'G11 GET reconcile（手动轮后）');
    const g11A = g11After.body?.data;
    checks.that(
      typeof g11A?.lastAttemptAt === 'number' && g11A.lastAttemptAt >= g11T0,
      `G11 手动轮后 lastAttemptAt 已刷新（≥ ${g11T0}）—— 实际 ${g11A?.lastAttemptAt}`,
    );
    checks.that(
      typeof g11A?.lastSuccessAt === 'number' && g11A.lastSuccessAt >= g11T0,
      `G11 成功轮另刷 lastSuccessAt（≥ ${g11T0}）—— 实际 ${g11A?.lastSuccessAt}`,
    );
    checks.that(g11A?.lastResult !== null && g11A?.lastResult !== undefined, 'G11 lastResult 非 null（成功轮已写）');
    checks.eq(
      JSON.stringify(g11A?.lastResult),
      JSON.stringify(g11RunData),
      'G11 lastResult = 手动轮的完整读数（面板数据源 = 循环本体）',
    );

    /* ════════════════════════════════════════════════════════════════════
     * G12 静态串 + 无 innerHTML（经门口；且服务出的字节 === 仓库现行文件）
     * ════════════════════════════════════════════════════════════════════ */
    step('G12 静态：经门口拉 /admin/app.js 与 /admin/index.html（端点串/文案/存储键 + 零 innerHTML + 与仓库文件逐字一致）');
    const g12App = await edgeGetFollowing('/admin/app.js');
    checks.eq(g12App.status, 200, `G12 /admin/app.js 经门口 ⇒ 200（链：${g12App.chain.join(' | ')}）`);
    const appRepo = readFileSync(resolve(REPO_ROOT, 'admin/app.js'), 'utf8');
    checks.that(
      g12App.body === appRepo,
      `G12 服务出的 app.js 与仓库 admin/app.js **逐字一致**（防「旧镜像 ⇒ 空测」；差 ${Math.abs(g12App.body.length - appRepo.length)} 字符长）`,
    );
    for (const needle of [
      '/api/admin/login',
      '/api/admin/wallet/ops',
      '/api/admin/wallet/summary',
      '/api/admin/wallet/reverse',
      '/api/admin/wallet/reconcile/run',
      '/api/admin/config/changes',
      '/api/admin/login-events',
      '/api/admin/accounts/changes',
      '/api/admin/accounts',
      // 风控片 T11（⚙️17）：风控端点三串（T9 已随 admin/app.js 就位，此处追加针脚）。
      '/api/admin/risk/reviews',
      '/api/admin/risk/users/',
      '/api/admin/risk/actions',
      // 设备绑定片：用户详情「解绑设备」端点串（DELETE；P-r5 仅超管/运营可写）。
      '/device-binding',
      // 支付片 T12（⚙️10/设计 §7）：管理面支付端点四串（T12 已随 admin/app.js 就位，此处追加针脚）。
      '/api/admin/pay/orders',
      '/api/admin/pay/refunds',
      '/api/admin/pay/withdrawals',
      '/api/admin/pay/actions',
      // 支付配置管理化片 T10（规格 §2.8）：支付渠道视图 —— 端点串 + 视图/导航 id + 槽选择器前缀
      //（T10 已随 admin/app.js 就位，此处追加针脚；槽名 = 键末段）。
      '/api/admin/pay-channel/',
      'pay-channel-view',
      'nav-pay-channel-btn',
      'pay-channel-row-',
      // 广告片 T9（规格 §2.3）：广告回调视图 —— 端点串 + 视图/导航 id + 槽选择器前缀
      //（T9 已随 admin/app.js 就位，此处追加针脚；槽名 = 键末段）。
      '/api/admin/ad-channel/',
      'ad-channel-view',
      'nav-ad-channel-btn',
      'ad-channel-row-',
      '管理面未启用（未创建任何管理员账号）',
      '账号已停用，请联系超级管理员',
      'ftl-admin-username',
      'ftl-admin-role',
    ] as const) {
      checks.that(g12App.body.includes(needle), `G12 app.js 含 ${JSON.stringify(needle)}`);
    }
    checks.that(!g12App.body.includes('innerHTML'), 'G12 app.js 零 innerHTML（textContent 输出编码纪律）');
    const g12Html = await edgeGetFollowing('/admin/index.html');
    checks.eq(g12Html.status, 200, `G12 /admin/index.html 经门口 ⇒ 200（链：${g12Html.chain.join(' | ')}）`);
    checks.that(
      g12Html.body === readFileSync(resolve(REPO_ROOT, 'admin/index.html'), 'utf8'),
      'G12 服务出的 index.html 与仓库文件逐字一致（同上，防旧镜像）',
    );
    checks.that(g12Html.body.includes('login-username'), 'G12 index.html 含登录用户名输入框 #login-username');
    checks.that(g12Html.body.includes('FTL 管理面'), 'G12 index.html 含管理页标志串「FTL 管理面」');

    // 支付片 T12（设计 §7 同步面）：三新视图 + 审计第六页签 + 财务「来源」下拉 +5（=12 项）。
    for (const needle of [
      'pay-orders-view',
      'pay-refunds-view',
      'pay-withdrawals-view',
      'audit-tab-pay',
      'nav-pay-orders-btn',
    ] as const) {
      checks.that(g12Html.body.includes(needle), `G12 index.html 含支付面针脚 ${JSON.stringify(needle)}`);
    }
    // 支付配置管理化片 T10（规格 §2.8）：支付渠道视图骨架针脚（新视图 id / 导航按钮 id / 字面量）。
    for (const needle of ['pay-channel-view', 'nav-pay-channel-btn', '支付渠道'] as const) {
      checks.that(g12Html.body.includes(needle), `G12 index.html 含支付渠道面针脚 ${JSON.stringify(needle)}`);
    }
    // 通知通道管理化片 T9（规格 §2.8）：通知通道视图骨架针脚（新视图 id / 导航按钮 id / 字面量）。
    for (const needle of ['notify-channel-view', 'nav-notify-channel-btn', '通知通道'] as const) {
      checks.that(g12Html.body.includes(needle), `G12 index.html 含通知通道面针脚 ${JSON.stringify(needle)}`);
    }
    // 广告片 T9（规格 §2.3）：广告回调视图骨架针脚（新视图 id / 导航按钮 id / 字面量）。
    for (const needle of ['ad-channel-view', 'nav-ad-channel-btn', '广告回调'] as const) {
      checks.that(g12Html.body.includes(needle), `G12 index.html 含广告回调面针脚 ${JSON.stringify(needle)}`);
    }
    // 记牌器收费片 T16：财务「购买/使用」两行针脚 + 来源下拉 card_counter。
    for (const needle of [
      'fin-cardcounter-purchases-line',
      'fin-cardcounter-consumptions-line',
    ] as const) {
      checks.that(g12Html.body.includes(needle), `G12 index.html 含记牌器财务面针脚 ${JSON.stringify(needle)}`);
    }
    {
      const finSelect = /<select id="fin-source">([\s\S]*?)<\/select>/.exec(g12Html.body)?.[1] ?? '';
      const optCount = (finSelect.match(/<option /g) ?? []).length;
      checks.eq(optCount, 14, 'G12 财务「来源」下拉恰 14 项（全部 + 13 源）');
      for (const source of [
        'recharge',
        'refund_hold',
        'refund_rollback',
        'withdraw_hold',
        'withdraw_rollback',
        'entry_fee',
        'card_counter',
      ] as const) {
        checks.that(finSelect.includes(`value="${source}"`), `G12 来源下拉含 value="${source}"`);
      }
    }
    checks.that(g12App.body.includes('六页签'), 'G12 app.js 含「六页签」计数语境（支付处置 = 审计第六源）');

    /* ════════════════════════════════════════════════════════════════════
     * 收尾：一次性账号全停用（不删，留档）+ 引导号只读不变量
     * ════════════════════════════════════════════════════════════════════ */
    step('收尾：五个一次性账号停用（不删）留档；引导号 admin 仍 active/super_admin（只读不变量）');
    s.adminToken = await adminLogin();
    const oneTime: Array<[string, number]> = [
      [USERNAME_VIEWER, s.viewerId],
      [USERNAME_OPER, s.operId],
      [USERNAME_FIN, s.finId],
      [USERNAME_SUP, s.supId],
      [USERNAME_CRUD, s.crudId],
    ];
    for (const [username, id] of oneTime) {
      expectHttp(
        checks,
        await sendJson('PATCH', `/api/admin/accounts/${id}`, { status: 'disabled' }, { token: s.adminToken }),
        200,
        ErrCode.OK,
        `收尾 停用 ${username}`,
      );
    }
    const finalList = await getJson<{ accounts: AdminAccountRow[] }>('/api/admin/accounts', s.adminToken);
    expectHttp(checks, finalList, 200, ErrCode.OK, '收尾 账号列表终检');
    const finalRows = finalList.body?.data?.accounts ?? [];
    checks.that(
      oneTime.every(([username]) => finalRows.find((r) => r.username === username)?.status === 'disabled'),
      '收尾 五个一次性账号全部 disabled（留档不删）',
    );
    checks.that(
      finalRows.find((r) => r.username === BOOTSTRAP_USERNAME)?.status === 'active' &&
        finalRows.find((r) => r.username === BOOTSTRAP_USERNAME)?.role === 'super_admin',
      '收尾 引导号 admin 仍 active/super_admin（口令全程未触碰；角色在 G6 现场已复原）',
    );
    info(`留档：${oneTime.map(([u]) => u).join(', ')}（disabled，未删除）`);

    cleanupDone = true;
    return checks;
  } finally {
    // 兜底复原（成败皆然；失败只 info，不顶掉原始结论）：
    //  ① 引导号角色（G6 并发互降的窗口）—— 用 sup 的 token（claims 恒 super_admin；
    //     admin 自己的 token 过不了闸 1 的「自锁」）；
    //  ② room.matchScanIntervalMs（G4/G8 改为自还原；这里兜「中途抛错」）。
    if (!cleanupDone) {
      try {
        if (s.supToken !== '' && s.adminId > 0) {
          const fixAdmin = await sendJson(
            'PATCH',
            `/api/admin/accounts/${s.adminId}`,
            { role: 'super_admin' },
            { token: s.supToken },
          );
          info(`兜底：admin 角色复原 ⇒ HTTP ${fixAdmin.status} code=${String(fixAdmin.body?.code)}`);
        }
        if (s.cfgV0 > 0) {
          const fixCfg = await adminPutConfig('room.matchScanIntervalMs', s.cfgV0, await adminLogin());
          info(`兜底：room.matchScanIntervalMs 复原 ⇒ code=${String(fixCfg.body?.code)}`);
        }
      } catch (err) {
        info(`兜底复原失败（不影响原始结论，手动检查 admin 角色 / matchScanIntervalMs）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

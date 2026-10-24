/**
 * conformance 用例：**风控片（风控 T11）** —— `slice-20-risk-control`；规格 §6.2 的九组逐条对位。
 *
 * ─── 编排顺序与理由（为什么是这个序）────────────────────────────────────────
 *  ① 配置面：65 键在场 + 8 风险键种子逐值 + 非法写入 400 且不落库（最便宜的一环，先跑）；
 *  ② 谓词组：**开关对照**——`sameDevice` 开（同 deviceId 二人 + 第三人 ⇒ 30s 子集路径成局 +
 *     落单兜底；A/B 永不同房）→ 关（三人同 deviceId 正常成局 = 负对照）→ `sameIp` 开
 *     （**同主机天然同 IP**：三人两两互斥 ⇒ 各自落单补机器人、三房三号）→ 关（复原）；
 *  ③ 数据链：真 WS 入队带 `deviceId` ⇒ `match:meta` 两字段当场读回 ⇒ `risk.deviceReport`
 *     落库（轮询详情）⇒ `GET risk/users/:id` 设备原文可见；
 *  ④ 检测面：管理面 PUT `risk.scanIntervalMs=5000`（本片 ⚙️9 换源）重起 user-service ⇒ 降阈
 *     （域内合法组合 `minGames=1` + `winRateThreshold=0.5`）⇒ 直投 `record.write` 造 2 局 2 胜
 *     （games=2 > 1、winRate=1.0 > 0.5 ⇒ hit1 ⇒ score 25）⇒ 扫描轮打条目 ⇒ operator
 *     dismiss ⇒ 审计行 ⇒ **重扫不复活**（同分抑制）⇒ 阈值与注入双复原；
 *  ④b 设备清理节奏（规格 ⚙️9 新增）：管理面 PUT `risk.devicesCleanupIntervalMs=5000` + 重建 ⇒
 *     启动行 `interval 5000ms` ⇒ **心跳日志 ≥2 行**（每轮一条 `risk devices cleanup done`）⇒
 *     再 PUT 回知基线 3600000 + 重建（`risk.devicesCleanupIntervalMs` 首获端到端）；
 *  ⑤ 限流档：手动 throttle（open ⇒ throttled + manual 旗）⇒ 高频 HTTP 429（3/1s）⇒
 *     unthrottle 恢复（同形态高频零 429 = 判别力正对照）；
 *  ⑥ 封禁面：ban ⇒ 新登录 403/11003 + WS 握手被拒（断开）⇒ unban ⇒ 登录/握手双恢复；
 *  ⑦ 权限面：viewer/finance 对四端点（+写面）403 vs operator 200（证 P-r1..r4 生效）；
 *  ⑧ 审计面：`risk/actions` 列表（userId/action 过滤 + actor/行形状）+ CSV（BOM/CRLF/
 *     消毒——`=1+1…` 理由得 `'=1+1` 前缀）；
 *  ⑨ 回归面：玩家 `records/mine` 键集**不含** `deviceId`（递归键名扫描 + 原文串扫描双保险）。
 *  收尾：三个一次性管理员停用留档（不删）。
 *
 * ─── 手法先例（逐条对应，刻意与既有切片同形）────────────────────────────────
 *  - `compose()` / `exec()` / `tailOut()` / `mysql` 无 / `ndjson()` / `pollUntil()` /
 *    `waitContainerHealthy()`：照 slice-15/18/19。
 *  - **注入换源（本片 ⚙️9 统一形态）** = 管理面 `PUT <间隔键>=值` + **GET 确认=值**（防 PUT
 *    静默失败）⇒ 重建 ⇒ 观测（判据不变）⇒ `PUT` 回**知基线 3600000** + 重建；先例 =
 *    slice-15 C8① / slice-17 ⑨ / slice-18 I。⚠️ `--force-recreate` 不可省（T12 实测：env
 *    退役后 `up -d` 对未变容器是 no-op —— 不动容器就没有新启动行、没有短节奏观测）。
 *  - **配置生效观测** = slice-18 `putConfigAndWaitEffect` 的版本算术（PUT 后版本 =
 *    `max(全局, 本键+1)`）+ **时间锚计数**（本机订正：数 `config snapshot applied
 *    (version=N)` 里 **`ts ≥ PUT 前一刻`** 的行 —— 不用 900s 窗口计数，窗口边缘的旧行
 *    老化会抵消新行 ⇒ 「计数 47→47」假红，slice-18 本机首跑实证）。`refreshOnce` 先换
 *    缓存**后**打日志 ⇒ 看到该行 = 缓存已换，判据确定性成立。
 *  - **直投造数** = slice-15 的 `rpcCall` 打宿主 3101（`record.write`）；**不 import shared**。
 *  - `sendJson` / `expectHttp` / `fetchCsvRaw` / `csvByteChecks`：照 slice-19（CSV 一律
 *    **读字节**——BOM 与 CRLF 是网关两跳后的契约）。
 *
 * ─── 副作用与复原（一条也不许泄漏给 `--list` 下的后续切片）──────────────────
 *  - 谓词开关：用例内**逐次自还原**（关 ⇒ 开 ⇒ 关 ⇒ 开 ⇒ 关）+ `finally` 兜底（**默认关**
 *    是生产种子态；留着开会让后续切片全部崩）；
 *  - 配置：`game.doudizhu.risk.minGames`/`game.doudizhu.risk.winRateThreshold` 降阈后还原种子（100 / 0.8），`finally` 兜底；
 *  - 注入：`risk.scanIntervalMs=5000`（④）与 `risk.devicesCleanupIntervalMs=5000`（④b）用毕即
 *    **PUT 回知基线 3600000 + 重建**，`finally` 兜底（④b 的键同样兜底 —— 5000 不许泄漏）；
 *  - 动作面：dismiss/throttle/unthrottle/ban/unban **全对**（旗在用例内清光：manual 旗
 *    unthrottle 删、banned 旗 unban 删）；
 *  - 一次性管理员（`s20v/s20f/s20o` 前缀）只停用不删；harness 玩家与其记录/设备留库
 *    （既有切片同款）；
 *  - 起手清 `match:queue:random:*`（脏卷残留票会吃掉②组的「恰三人」前提）。
 *
 * ─── 环境依赖（登记，不跳过）───────────────────────────────────────────────
 *  - ② 的 `sameIp` 组依赖**同主机天然同 IP**：全部 conformance 客户端从本机发起、经网关
 *    注入同一 `clientIp`（③ 组会以 `HGET match:meta:<uid> ip` 当场**自证**该前提非
 *    `unknown`）。若该前提被破坏（clientIp 未注入），本组会**响亮红**（三人一组同房），
 *    处理 = 查网关 clientIp 注入链，不是放宽断言。
 *  - ④ 的注入重起要求 user-service 镜像为**当次源码**（旧镜像无风险链 ⇒ 组内断言响亮红，
 *    不是假绿——同 slice-16/18 的「旧镜像 ⇒ 空测」教训）。
 *  - 零 `skip()`、零数据依赖分支：全部断言在任何环境下都执行；数据驱动的行集一律聚合成
 *    单条断言（或先 find 后单断言）——基线静态回填的前提。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  CONFIG_KEYS,
  ErrCode,
  RPC_PATTERNS,
  encodeCards,
  encodeHand,
  type Card,
  type RecordWriteRequest,
  type DdzSettlementResult,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, fieldSetViolations, info, sleep, step } from '../lib/assert';
import {
  HARNESS_PASSWORD,
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  getJson,
  login,
  postJson,
  registerUser,
  type Envelope,
  type HarnessUser,
} from '../lib/http';
import { HarnessClient, type AckResult } from '../lib/client';
import { redisRaw, redisReplyText } from '../lib/redis';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';
import { MATCH_BASE_SCORE } from '../lib/ddz-driver';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-15/18/19）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** `record.write` 的 TCP 监听（宿主直投 = compose override 的 `3101:3101`；照 slice-15）。 */
const USER_RPC: RpcEndpoint = {
  host: process.env.USER_RPC_HOST ?? 'localhost',
  port: Number(process.env.USER_RPC_PORT ?? 3101),
};

/** 起手 healthy 的四容器（本片全部判据的依靠面；监控/edge 由 slice-16/19 各自核）。 */
const HEALTH_CONTAINERS = [
  'ftl-api-gateway',
  'ftl-config-service',
  'ftl-user-service',
  'ftl-room-service',
] as const;

/**
 * ④ 扫描间隔注入值（本片 ⚙️9 换源：管理面 PUT `risk.scanIntervalMs` —— 旧 env 注入面已退役；
 * 3–5s 一轮足够秒级观测）。数值型：`parseIntervalMs` 拒字符串。
 */
const RISK_SCAN_INTERVAL_INJECT = 5000;
/** ④ 的还原**知基线值**（= stack 种子 = 代码缺省 1h；还原不写「现值」）。 */
const RISK_SCAN_INTERVAL_RESTORE = 3_600_000;

/** 配置键（逐字；规格 §2.1-3 第 18–25 键）。 */
const K_PRED_SAME_DEVICE = 'risk.predicate.sameDevice';
const K_PRED_SAME_IP = 'risk.predicate.sameIp';
const K_WIN_RATE = 'game.doudizhu.risk.winRateThreshold';
const K_MIN_GAMES = 'game.doudizhu.risk.minGames';
const K_DEVICE_LIMIT = 'risk.deviceLimit';
const K_DEVICE_WINDOW_DAYS = 'risk.deviceWindowDays';
const K_AUTO_THROTTLE = 'risk.autoThrottle';
const K_DEVICE_RETENTION_DAYS = 'risk.deviceRetentionDays';

/** 八风险键的**种子态**（① 组逐值断言 + 收尾复原值；规格 §2.1-3 表）。 */
const RISK_SEED_VALUES: ReadonlyArray<readonly [string, unknown]> = [
  [K_PRED_SAME_DEVICE, false],
  [K_PRED_SAME_IP, false],
  [K_WIN_RATE, 0.8],
  [K_MIN_GAMES, 100],
  [K_DEVICE_LIMIT, 3],
  [K_DEVICE_WINDOW_DAYS, 30],
  [K_AUTO_THROTTLE, true],
  [K_DEVICE_RETENTION_DAYS, 365],
];

/** 总键数取自 protocol 单一真源（加键时自动跟随；本片合并记牌器片后自动为 50）。 */
const TOTAL_CONFIG_KEYS = CONFIG_KEYS.length;

/** ④ 的降阈组合（**域内合法**：F4 教训——0.01/0.0 类值写入必 400，构造不出目标态）。 */
const WIN_RATE_LOW = 0.5;
const MIN_GAMES_LOW = 1;

/** room.matched 的等待上界（② 的 30s 子集路径 + 落单兜底 + 扫描周期全部覆盖）。 */
const MATCH_WAIT_MS = 90_000;

/* ── 本 run 的命名空间（同栈「先单跑、后全序」跑两遍；固定名会在第二跑撞唯一键/重放）── */
const TAG = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(-8);
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-6);

const USERNAME_VIEWER = `s20v-${TAG}`;
const USERNAME_FIN = `s20f-${TAG}`;
const USERNAME_OPER = `s20o-${TAG}`;
const ONE_TIME_PASSWORD = `s20-${TAG}-passw0rd`;

/** 造数房号（per-run 唯一 ⇒ 第二跑不会幂等命中 `written=false`）。 */
const ROOM_HIT_1 = `H1${RUN_TAG}`;
const ROOM_HIT_2 = `H2${RUN_TAG}`;
const ROOM_THROTTLE_1 = `T1${RUN_TAG}`;
const ROOM_THROTTLE_2 = `T2${RUN_TAG}`;

/** deviceId 样本（protocol 域内：8..64 且 `/^[A-Za-z0-9._-]+$/`）。 */
const DEV_A = `s20-dev-${TAG}-a`;
const DEV_B = `s20-dev-${TAG}-b`;
const DEV_C = `s20-dev-${TAG}-c`;

/* ──────────────────────────────────────────────────────────────────────────
 * 本地助手（形态先例：slice-15/18/19）
 * ────────────────────────────────────────────────────────────────────────── */

interface CommandResult {
  code: number;
  out: string;
}

/** `docker compose …`（照 slice-15 的 spawnSync 手型，逐字同参）。 */
function compose(extraEnv: Record<string, string>, ...args: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 输出尾部 —— 失败断言里带上它（「跑挂 ≠ 判据红」：原因必须进结论）。 */
function tailOut(out: string, lines = 3): string {
  return out.trim().split('\n').slice(-lines).join(' / ');
}

/** 某服务最近的容器日志（照 slice-12/15；`--no-color` 必须有：ANSI 会让「找那一行」恒假）。 */
function composeLogs(service: string, sinceSeconds: number): string {
  const r = spawnSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, service],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 一行日志里抽出 NDJSON 记录（前缀 `ftl-x | ` 与非 JSON 行一律返回 null；照 slice-12）。 */
function safeJson(line: string): Record<string, any> | null {
  const at = line.indexOf('{');
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(at)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/** 某服务近 `sinceSeconds` 秒的全部 NDJSON 记录。 */
function ndjson(service: string, sinceSeconds: number): Array<Record<string, any>> {
  return composeLogs(service, sinceSeconds)
    .split('\n')
    .map(safeJson)
    .filter((r): r is Record<string, any> => r !== null);
}

/** 轮询直至谓词成立（有上界）。返回最后一次读数 —— **由调用方断言**（超时 = 判据不成立）。 */
async function pollUntil<T>(
  read: () => Promise<T> | T,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<{ ok: boolean; last: T }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await read();
    if (ok(last)) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(intervalMs);
  }
}

/** 等容器 healthy（照 slice-14/18/19）。 */
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

/** Redis 把文本回复当**数字**读（EXISTS 一类；空 ⇒ 抛，不把空串装成 0）。 */
function redisInt(args: string[]): number {
  const reply = redisRaw(args);
  if (reply.status !== 0) {
    throw new ConformanceError(`redis-cli ${args.join(' ')} 失败：${redisReplyText(reply) || '（无输出）'}`);
  }
  const n = Number(reply.stdout.trim());
  if (!Number.isFinite(n)) {
    throw new ConformanceError(`redis-cli ${args.join(' ')} 回复不是数字：${JSON.stringify(reply.stdout)}`);
  }
  return n;
}

/** Redis 原文回复（GET 一类；调用方自己判空串/JSON）。 */
function redisText(args: string[]): string {
  const reply = redisRaw(args);
  if (reply.status !== 0) {
    throw new ConformanceError(`redis-cli ${args.join(' ')} 失败：${redisReplyText(reply) || '（无输出）'}`);
  }
  return reply.stdout.trim();
}

/* ── 管理面 HTTP 手型（照 slice-19 的 sendJson / expectHttp / CSV 字节组）──────── */

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
  const res = await fetch(`${process.env.GW ?? 'http://localhost:3000'}${path}`, {
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
  const res = await fetch(`${process.env.GW ?? 'http://localhost:3000'}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, bytes, headers };
}

/** CSV 字节级断言组（定长；照 slice-19 逐字）。 */
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

/* ── 配置生效观测（版本算术；照 slice-18 `putConfigAndWaitEffect`）────────────── */

interface AdminConfigData {
  config: Record<string, { value: unknown; version: number }>;
  version: number;
}

/**
 * 目标服务日志里 **`ts ≥ sinceMs`** 且 `config snapshot applied (version=N)` 的**行计数**。
 *
 * ⚠️ 用**时间锚**而不是「900s 窗口计数」（本机实测的收口订正）：窗口是滑动的 ——
 * `docker compose logs --since 900s` 里**旧行老化**会与**新行到达**相抵，出现
 * 「PUT 后计数 47→47」的**假红**（slice-18 本机首跑实证；触发条件 = 早前 15 分钟处
 * 有一次推送密集段，恰好横在窗口边缘）。时间锚只数「本次 PUT 之后」的行 ⇒ 老化无关。
 */
function snapshotAppliedCountSince(service: string, version: number, sinceMs: number): number {
  return ndjson(service, 900).filter((r) => {
    const msg = String(r.msg);
    const ts = Date.parse(String(r.ts));
    return (
      msg.includes('config snapshot applied') &&
      Number.isFinite(ts) &&
      ts >= sinceMs &&
      new RegExp(`version=${version}\\b`).test(msg)
    );
  }).length;
}

/**
 * `PUT /api/admin/config/:key` + **等目标服务的快照生效**（`refreshOnce` 先换缓存后打日志
 * ⇒ 看到新版本行 = 缓存已换；判定确定性成立）。时间锚在 PUT **之前**取（发布→响应只有
 * 毫秒级窗口，取后取会漏掉自己那行 ⇒ 假红）。
 */
async function putConfigAndWaitEffect(
  checks: Checks,
  admin: string,
  key: string,
  value: unknown,
  service: string,
): Promise<void> {
  const before = await adminGetConfig<AdminConfigData>(admin);
  const gv0 = Number(before.body?.data?.version ?? 0);
  const kv0 = Number(before.body?.data?.config?.[key]?.version ?? 0);
  const expected = Math.max(gv0, kv0 + 1);
  const sinceMs = Date.now();
  const put = await adminPutConfig(key, value, admin);
  checks.eq(put.body?.code, ErrCode.OK, `PUT ${key}=${JSON.stringify(value)} ⇒ code 0`);
  const refresh = await pollUntil(
    () => snapshotAppliedCountSince(service, expected, sinceMs),
    (n) => n > 0,
    30_000,
  );
  checks.that(
    refresh.ok,
    `${service} ≤30s 应用 ${key}=${JSON.stringify(value)}（PUT 之后新增 \`config snapshot applied (version=${expected})\` 行 ${refresh.last} 条；推送路径）`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 管理面间隔注入（本片 ⚙️9 换源：统一形态的 PUT 腿 —— PUT + GET 确认，取代旧 env 通道）
// ────────────────────────────────────────────────────────────────────────────

/** `GET /api/admin/config` 的单键值（PUT 后的 **GET 确认** 读口）。 */
async function adminGetConfigValue(admin: string, key: string): Promise<unknown> {
  const res = await adminGetConfig<{ config: Record<string, { value: unknown }> }>(admin);
  if (res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`GET /api/admin/config 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data?.config?.[key]?.value;
}

/**
 * 规格 ⚙️9 统一形态的 **PUT 腿**：`PUT key=ms` ⇒ **GET 确认 = ms**（防 PUT 静默失败）。
 * 任一环不合 ⇒ **抛**（失败响亮；`why` 入消息）。其后的「重建 → 观测」由调用方承接。
 * ⚠️ 还原调用一律传**知基线值**（= stack 种子 = 代码缺省），不写「现值」。
 */
async function putInterval(admin: string, key: string, ms: number, why: string): Promise<void> {
  const put = await adminPutConfig(key, ms, admin);
  if (put.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`${why}：PUT ${key}=${ms} 失败：HTTP ${put.status} ${JSON.stringify(put.body)}`);
  }
  const read = await adminGetConfigValue(admin, key);
  if (read !== ms) {
    throw new ConformanceError(`${why}：PUT 后 GET 确认不符 —— ${key}=${JSON.stringify(read)}，期望 ${ms}`);
  }
  info(`${why}：PUT ${key}=${ms} ⇒ GET 确认一致`);
}

/* ── 匹配探针（真 WS；带 deviceId 的 room.match）────────────────────────────── */

interface MatchedInfo {
  roomCode: string;
  seat: number;
  at: number;
  sentAt: number;
}

/**
 * 连一个客户端并发出带 `deviceId` 的 `room.match`（协议帧 = T8 客户端的同形）。
 * `matched` 把手在 **send 之前**注册（waitFor 也认历史，双保险）。ack 由调用方断言。
 */
async function enqueueWithDevice(
  label: string,
  user: HarnessUser,
  deviceId: string,
): Promise<{ client: HarnessClient; ack: AckResult; sentAt: number; matched: Promise<MatchedInfo> }> {
  const client = await HarnessClient.connect(label, user);
  const sentAt = Date.now();
  const matched = client.waitFor('room.matched', MATCH_WAIT_MS).then((m: any) => ({
    roomCode: String(m.payload.roomCode),
    seat: Number(m.payload.seat),
    at: Date.now(),
    sentAt,
  }));
  // R156 同族护栏：本把手**可能不被消费**（③ 组入队后即 `room.unmatch` ⇒ 永不 matched）——
  // 预先挂一个 no-op catch，防 90s 后**未处理拒绝打崩整个进程**（本机首跑实测；await 的
  // 调用方照常收到拒绝，语义零变化）。
  void matched.catch(() => undefined);
  const ack = await client.send('room.match', { mode: 'random', baseScore: MATCH_BASE_SCORE, deviceId });
  return { client, ack, sentAt, matched };
}

/* ── 造数（`record.write` 直投 3101；照 slice-15 的 craftRecord，按需裁剪）──────── */

/** 从 codec 合法集取 `count` 张 —— 固定遍历序 ⇒ 可复读（不模拟真牌堆；不是本判据的对象）。 */
function sampleCards(offset: number, count: number): Card[] {
  const ranks = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30];
  const pool: Card[] = [];
  for (const r of ranks) for (let s = 0; s < 5; s += 1) pool.push({ r, s });
  const out: Card[] = [];
  for (let i = 0; i < count; i += 1) out.push(pool[(offset + i) % pool.length]!);
  return out;
}

interface CraftSeat {
  seat: number;
  userId: string | null;
  isRobot: boolean;
  robotId: string | null;
}

/** 单真人（seat 0，地主胜 ⇒ `won=1`）+ 两机器人。 */
function humanWinsSeats(userId: string): CraftSeat[] {
  return [
    { seat: 0, userId, isRobot: false, robotId: null },
    { seat: 1, userId: null, isRobot: true, robotId: 'bot-s20-h1' },
    { seat: 2, userId: null, isRobot: true, robotId: 'bot-s20-h2' },
  ];
}

/** 造一份合法的 `RecordWriteRequest`（校验面口径同 `record.rpc.controller`）。 */
function craftWinningRecord(roomCode: string, userId: string, endedAt: number): RecordWriteRequest {
  const baseScore = MATCH_BASE_SCORE;
  const multiplier = 2;
  const landlordSeat = 0;
  const winner = 'landlord' as const;
  const result: DdzSettlementResult = {
    roomCode,
    baseScore,
    winner,
    landlordSeat,
    farmerSeats: [1, 2],
    multiplier,
    spring: 'none',
    landlordScoreChange: baseScore * multiplier * 2,
    farmerScoreChange: -baseScore * multiplier,
  };
  return {
    roomCode,
    gameVersion: 1,
    mode: 'random',
    baseScore,
    result,
    seats: humanWinsSeats(userId).map((seat, i) => ({ ...seat, hand: encodeHand(sampleCards(i * 17, 17)) })),
    bottomCards: encodeCards(sampleCards(51, 3)),
    startedAt: endedAt - 600_000,
    endedAt,
  };
}

/** rpcCall 直投一条记录；返回 `written` 读数（失败 ⇒ 抛，带原始信封）。 */
async function writeRecord(req: RecordWriteRequest, what: string): Promise<boolean> {
  const res = await rpcCall<{ written: boolean }>(USER_RPC, RPC_PATTERNS.recordWrite, req, 5_000);
  if (!res.ok) {
    throw new ConformanceError(`${what}：RPC 返回 {ok:false} —— ${JSON.stringify(res)}`);
  }
  return res.data.written;
}

/* ── 风险面行形状（本文件只声明用到的字段）─────────────────────────────────── */

interface RiskEntry {
  id: number;
  score: number;
  status: string;
  handledBy: string | null;
  handledAt: number | null;
  createdAt: number;
}

interface RiskReviewRow extends RiskEntry {
  userId: string;
  reasons: unknown;
  updatedAt: number;
}

interface RiskUserDetail {
  userId: string;
  accountStatus: string;
  /** 终审 F2（`f830495`）：`risk:banned` 旗在场性（孤儿旗可诊断）—— ③ 的键集断言随之八键。 */
  bannedFlagPresent: boolean;
  limitSource: 'auto' | 'manual' | null;
  stats: { games: number; wins: number; winRate: number; deviceCount: number };
  devices: Array<{ deviceId: string; firstSeenAt: number; lastSeenAt: number; others: unknown[] }>;
  entries: RiskEntry[];
  hits: { sameIp: number; sameDevice: number };
}

interface RiskActionRow {
  id: number;
  userId: string;
  action: string;
  actor: string;
  reason: string | null;
  reviewId: number | null;
  detail: unknown;
  createdAt: number;
}

/** 递归键名扫描：返回所有**键名**等于 `needle` 的路径（数组下标也进路径）。 */
function keyPathsNamed(value: unknown, needle: string, path = '$', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => keyPathsNamed(v, needle, `${path}[${i}]`, out));
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (k === needle) out.push(`${path}.${k}`);
      keyPathsNamed(v, needle, `${path}.${k}`, out);
    }
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * 主用例
 * ────────────────────────────────────────────────────────────────────────── */

export async function runSlice20(): Promise<Checks> {
  const checks = new Checks();

  /** 跨组状态（线性赋值；零值只可能出现在「前组失败已抛出」的路径上）。 */
  const s = {
    adminToken: '',
    viewerToken: '',
    finToken: '',
    operToken: '',
    viewerId: 0,
    finId: 0,
    operId: 0,
    userHit: null as HarnessUser | null,
    userThrottle: null as HarnessUser | null,
    hitEntryId: 0,
    throttleEntryId: 0,
  };
  /** 收尾是否已跑完（`finally` 只在**没跑完**时做兜底复原，避免成功路径重复写）。 */
  let cleanupDone = false;
  /** 已开连接（成功/失败路径都要收干净 —— R156：socket 吊住事件循环 ⇒ 进程永不退出）。 */
  const openClients: HarnessClient[] = [];
  const closeAll = (): void => {
    for (const c of openClients.splice(0)) c.close();
  };

  try {
    /* ════════════════════════════════════════════════════════════════════
     * ⓪ 起手
     * ════════════════════════════════════════════════════════════════════ */
    step('⓪ 起手：四容器 healthy + 清 random 队列源 + 引导号登录 + 三只一次性管理员就位');
    for (const container of HEALTH_CONTAINERS) {
      const h = await waitContainerHealthy(container);
      checks.that(h.ok, `⓪ ${container} healthy（${h.last}）`);
    }
    // 清源（**卫生，不是判据**）：脏卷上的残留票会吃掉②组「队里恰这三人」的前提。
    const staleQueues = redisText(['--scan', '--pattern', 'match:queue:random:*'])
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => x !== '');
    if (staleQueues.length > 0) {
      const del = redisRaw(['DEL', ...staleQueues]);
      info(`⓪ 清源：删除 ${staleQueues.length} 个 random 队列键（DEL ⇒ ${redisReplyText(del) || '（无回复）'}）`);
    } else {
      info('⓪ 清源：--scan match:queue:random:* 无残留键');
    }
    checks.eq(
      redisText(['--scan', '--pattern', 'match:queue:random:*']).trim(),
      '',
      '⓪ 清源后 match:queue:random:* 无键',
    );

    s.adminToken = await adminLogin();
    checks.that(s.adminToken.length > 0, '⓪ 引导号 admin 登录成功（token 非空）');

    /** 建号（定长两条断言）+ 登录（定长两条断言）。 */
    const createOneTime = async (username: string, role: string, label: string): Promise<number> => {
      const res = await postJson<{ id: number; username: string; role: string; status: string }>(
        '/api/admin/accounts',
        { username, password: ONE_TIME_PASSWORD, role },
        s.adminToken,
      );
      checks.eq(res.status, 200, `⓪ 建号 ${label}（${username}/${role}）⇒ HTTP 200（管理面统一 200）`);
      checks.that(
        typeof res.body?.data?.id === 'number' && res.body.data.id > 0 &&
          res.body.data.role === role && res.body.data.status === 'active',
        `⓪ 建号 ${label} ⇒ {id>0, role, status:'active'} —— 实际 ${JSON.stringify(res.body?.data)}`,
      );
      return res.body!.data!.id;
    };
    const loginOneTime = async (username: string, label: string): Promise<string> => {
      const res = await postJson<{ token: string; role: string }>(
        '/api/admin/login',
        { username, password: ONE_TIME_PASSWORD },
      );
      checks.eq(res.body?.code, ErrCode.OK, `⓪ 登录 ${label} ⇒ code 0`);
      checks.that(
        typeof res.body?.data?.token === 'string' && res.body.data.token.length > 0,
        `⓪ 登录 ${label} ⇒ token 非空`,
      );
      return res.body!.data!.token;
    };
    s.viewerId = await createOneTime(USERNAME_VIEWER, 'viewer', 'viewer');
    s.finId = await createOneTime(USERNAME_FIN, 'finance', 'finance');
    s.operId = await createOneTime(USERNAME_OPER, 'operator', 'operator');
    s.viewerToken = await loginOneTime(USERNAME_VIEWER, 'viewer');
    s.finToken = await loginOneTime(USERNAME_FIN, 'finance');
    s.operToken = await loginOneTime(USERNAME_OPER, 'operator');

    /* ════════════════════════════════════════════════════════════════════
     * ① 配置面（§6.2-1）
     * ════════════════════════════════════════════════════════════════════ */
    step('① 配置面：65 键在场 + 8 风险键种子逐值 + 非法写入（0.785）⇒ 400 且不落库');
    const g1Cfg = await adminGetConfig<AdminConfigData>(s.adminToken);
    checks.eq(g1Cfg.body?.code, ErrCode.OK, '① GET /api/admin/config ⇒ code 0');
    const g1Keys = Object.keys(g1Cfg.body?.data?.config ?? {});
    checks.eq(g1Keys.length, TOTAL_CONFIG_KEYS, `① 管理面键总数 ${TOTAL_CONFIG_KEYS}（= protocol CONFIG_KEYS 长度，单一真源）`);
    // 本片 ⚙️1 六节奏键有两键落在 `risk.` 命名空间（第 38/39 键）⇒ 8 种子 + 2 节奏 = 十；
    // 其后两片又各加一键（均未同步本断言，2026-10-17 T9 全序抓出）：
    //   `risk.withdrawReAuthEnabled`（第 48 键，ws-token-renew）· `risk.deviceBindingEnabled`（第 49 键，device-binding）
    // ⇒ 现态恰十二。
    // （计划 T13 未列此项：41 键现态下「恰八」必红 —— 实施期红跑实证，见报告偏差 D-1）。
    const g1RiskKeys = g1Keys.filter((k) => k.startsWith('risk.')).sort();
    checks.that(
      fieldSetViolations(g1RiskKeys, [
        ...RISK_SEED_VALUES.map(([k]) => k),
        'risk.scanIntervalMs',
        'risk.devicesCleanupIntervalMs',
        'risk.withdrawReAuthEnabled',
        'risk.deviceBindingEnabled',
      ]).length === 0,
      `① risk.* 键集恰十二（8 种子 + 2 节奏 + 2 后片键：withdrawReAuthEnabled/deviceBindingEnabled）—— 实际 ${JSON.stringify(g1RiskKeys)}`,
    );
    const g1SeedActual = RISK_SEED_VALUES.map(([k]) => [k, g1Cfg.body?.data?.config?.[k]?.value]);
    checks.that(
      JSON.stringify(g1SeedActual) === JSON.stringify(RISK_SEED_VALUES.map(([k, v]) => [k, v])),
      `① 八风险键种子逐值（sameDevice/sameIp=false · winRate=0.8 · minGames=100 · deviceLimit=3 · windowDays=30 · autoThrottle=true · retention=365）—— 实际 ${JSON.stringify(g1SeedActual)}`,
    );
    // 非法写入（域外/三位小数都非法；0.785 是规格 §2.1-3 的点名样本）⇒ 400 且**不落库**。
    const g1Illegal = await adminPutConfig(K_WIN_RATE, 0.785, s.adminToken);
    checks.eq(g1Illegal.status, 400, '① PUT game.doudizhu.risk.winRateThreshold=0.785（三位小数）⇒ HTTP 400');
    checks.eq(g1Illegal.body?.code, ErrCode.BAD_PARAM, '① 非法写入 ⇒ code 10001（借）');
    const g1Readback = await adminGetConfig<AdminConfigData>(s.adminToken);
    checks.eq(
      g1Readback.body?.data?.config?.[K_WIN_RATE]?.value,
      0.8,
      '① 非法写入不落库：winRateThreshold 仍为 0.8',
    );

    /* ════════════════════════════════════════════════════════════════════
     * ② 谓词组（§6.2-2；开关对照 —— 用例内逐次自还原，终态 = 默认关）
     * ════════════════════════════════════════════════════════════════════ */
    step('② 谓词组：确保默认关 ⇒ sameDevice 开（同设备二人永不同房 + 落单兜底）⇒ 关（负对照）⇒ sameIp 开（同主机互斥三房）⇒ 关（复原）');
    // 确保期望态（脏卷兼容；两键各等一次快照生效 —— 之后的匹配探针必须跑在**已生效**的配置上）。
    await putConfigAndWaitEffect(checks, s.adminToken, K_PRED_SAME_DEVICE, false, 'room-service');
    await putConfigAndWaitEffect(checks, s.adminToken, K_PRED_SAME_IP, false, 'room-service');

    // ── ②a sameDevice 开：A/B 同 deviceId=D，C 用 E ──────────────────────────
    step('②a sameDevice 开：两同 deviceId 客户端 + 第三人 ⇒ 30s 子集路径成局 + 落单兜底；同设备二人永不同房');
    await putConfigAndWaitEffect(checks, s.adminToken, K_PRED_SAME_DEVICE, true, 'room-service');
    const g2Users = [await registerUser(41), await registerUser(42), await registerUser(43)];
    const g2A = await enqueueWithDevice('S20-2a-A', g2Users[0]!, DEV_A);
    const g2B = await enqueueWithDevice('S20-2a-B', g2Users[1]!, DEV_A);
    const g2C = await enqueueWithDevice('S20-2a-C', g2Users[2]!, DEV_B);
    openClients.push(g2A.client, g2B.client, g2C.client);
    checks.that(
      [g2A.ack, g2B.ack, g2C.ack].every((a) => a.code === ErrCode.OK),
      `②a 三人入队 ack 全 0（谓词只挡成组、不挡入队）—— 实际 ${JSON.stringify([g2A.ack.code, g2B.ack.code, g2C.ack.code])}`,
    );
    const g2SentAt = g2A.sentAt;
    const [m2A, m2B, m2C] = await Promise.all([g2A.matched, g2B.matched, g2C.matched]);
    const g2Codes = [m2A.roomCode, m2B.roomCode, m2C.roomCode];
    checks.that(
      new Set(g2Codes).size === 2,
      `②a 实开两房（同设备二人不同房 + 第三人与其一同房）—— 实际房号 ${JSON.stringify(g2Codes)}`,
    );
    checks.that(
      m2A.roomCode !== m2B.roomCode,
      `②a 同 deviceId 的 A/B **永不同房**（30s 子集路径 + 落单兜底各开一房）—— A=${m2A.roomCode} B=${m2B.roomCode}`,
    );
    checks.that(
      m2A.roomCode === m2C.roomCode || m2B.roomCode === m2C.roomCode,
      `②a 第三人 C 与 A/B 恰一人在同房（|S|=2 子集路径）—— C=${m2C.roomCode}`,
    );
    checks.that(
      Math.min(m2A.at, m2B.at, m2C.at) - g2SentAt >= 29_000,
      `②a 走的是 **30s 子集路径**（最早 room.matched ≥30s —— 谓词拒绝使正常三人抽取不可能）—— 实测最早 ${Math.min(m2A.at, m2B.at, m2C.at) - g2SentAt}ms`,
    );
    // 谓词拒绝的**机制计数**（risk:hit INCR；C 是负对照：他从未被拒 ⇒ 恒 0）。
    const g2DetailA = await getJson<RiskUserDetail>(`/api/admin/risk/users/${encodeURIComponent(g2Users[0]!.id)}`, s.adminToken);
    expectHttp(checks, g2DetailA, 200, ErrCode.OK, '②a 详情（A）');
    const g2DetailC = await getJson<RiskUserDetail>(`/api/admin/risk/users/${encodeURIComponent(g2Users[2]!.id)}`, s.adminToken);
    expectHttp(checks, g2DetailC, 200, ErrCode.OK, '②a 详情（C）');
    checks.that(
      (g2DetailA.body?.data?.hits?.sameDevice ?? 0) >= 1,
      `②a A 的 risk:hit:sameDevice ≥1（谓词拒绝真记账）—— 实际 ${g2DetailA.body?.data?.hits?.sameDevice}`,
    );
    checks.eq(g2DetailC.body?.data?.hits?.sameDevice, 0, '②a C 的 risk:hit:sameDevice = 0（未被拒过的负对照）');
    closeAll();

    // ── ②b sameDevice 关（负对照）：三人**同** deviceId 也正常成一房 ───────────
    step('②b sameDevice 关（负对照）：三人同 deviceId（=D2）⇒ 正常三人成局（谓词关 = 零新增行为）');
    await putConfigAndWaitEffect(checks, s.adminToken, K_PRED_SAME_DEVICE, false, 'room-service');
    const g2bUsers = [await registerUser(44), await registerUser(45), await registerUser(46)];
    const g2bDev = `s20-dev-${TAG}-shared`;
    const g2b = await Promise.all([
      enqueueWithDevice('S20-2b-A', g2bUsers[0]!, g2bDev),
      enqueueWithDevice('S20-2b-B', g2bUsers[1]!, g2bDev),
      enqueueWithDevice('S20-2b-C', g2bUsers[2]!, g2bDev),
    ]);
    openClients.push(...g2b.map((x) => x.client));
    checks.that(
      g2b.every((x) => x.ack.code === ErrCode.OK),
      `②b 三人入队 ack 全 0 —— 实际 ${JSON.stringify(g2b.map((x) => x.ack.code))}`,
    );
    const g2bMatch = await Promise.all(g2b.map((x) => x.matched));
    checks.that(
      new Set(g2bMatch.map((m) => m.roomCode)).size === 1,
      `②b 三人同 deviceId **合成一房**（谓词关 ⇒ 什么也不挡）—— 实际房号 ${JSON.stringify(g2bMatch.map((m) => m.roomCode))}`,
    );
    checks.that(
      Math.max(...g2bMatch.map((m) => m.at)) - g2b[0]!.sentAt < 30_000,
      `②b 正常抽取路径（不经过 30s 子集窗口）—— 实测最晚 ${Math.max(...g2bMatch.map((m) => m.at)) - g2b[0]!.sentAt}ms`,
    );
    closeAll();

    // ── ②c sameIp 开：同主机天然同 IP ⇒ 三人两两互斥、各自落单补机器人 ─────────
    step('②c sameIp 开：同主机三客户端（天然同 IP、deviceId 全不同）⇒ 两两互斥 ⇒ 三房三号（各 1 真人 + 2 机器人）');
    await putConfigAndWaitEffect(checks, s.adminToken, K_PRED_SAME_IP, true, 'room-service');
    const g2cUsers = [await registerUser(47), await registerUser(48), await registerUser(49)];
    const g2c = await Promise.all([
      enqueueWithDevice('S20-2c-A', g2cUsers[0]!, DEV_A),
      enqueueWithDevice('S20-2c-B', g2cUsers[1]!, DEV_B),
      enqueueWithDevice('S20-2c-C', g2cUsers[2]!, DEV_C),
    ]);
    openClients.push(...g2c.map((x) => x.client));
    checks.that(
      g2c.every((x) => x.ack.code === ErrCode.OK),
      `②c 三人入队 ack 全 0 —— 实际 ${JSON.stringify(g2c.map((x) => x.ack.code))}`,
    );
    const g2cMatch = await Promise.all(g2c.map((x) => x.matched));
    checks.that(
      new Set(g2cMatch.map((m) => m.roomCode)).size === 3,
      `②c 同 IP 三人**两两不同房**（各自落单 + 补机器人 ⇒ 三房三号）—— 实际房号 ${JSON.stringify(g2cMatch.map((m) => m.roomCode))}`,
    );
    checks.that(
      Math.min(...g2cMatch.map((m) => m.at)) - g2c[0]!.sentAt >= 29_000,
      `②c 全员走的是 **30s 越窗路径**（最早 room.matched ≥30s）—— 实测最早 ${Math.min(...g2cMatch.map((m) => m.at)) - g2c[0]!.sentAt}ms`,
    );
    closeAll();

    // ── ②还原：两谓词回默认关（**必须在后续组之前生效**）──────────────────────
    await putConfigAndWaitEffect(checks, s.adminToken, K_PRED_SAME_IP, false, 'room-service');

    /* ════════════════════════════════════════════════════════════════════
     * ③ 数据链（§6.2-3）
     * ════════════════════════════════════════════════════════════════════ */
    step('③ 数据链：入队带 deviceId ⇒ match:meta 两字段读回（含 ip 非 unknown —— ②c 的前提自证）⇒ deviceReport 落库 ⇒ 详情设备原文可见');
    const g3User = await registerUser(50);
    s.userHit = g3User; // ④ 的造数玩家 = 本组玩家（设备已落库，详情形状一次看全）
    const g3Dev = `s20-dev-${TAG}-chain`;
    const g3 = await enqueueWithDevice('S20-3-chain', g3User, g3Dev);
    openClients.push(g3.client);
    checks.eq(g3.ack.code, ErrCode.OK, '③ 入队 ack code 0');
    const g3MetaIp = redisText(['HGET', `match:meta:${g3User.id}`, 'ip']);
    const g3MetaDev = redisText(['HGET', `match:meta:${g3User.id}`, 'deviceId']);
    checks.that(
      g3MetaIp.length > 0 && g3MetaIp !== 'unknown',
      `③ match:meta 的 ip 字段在场且非 unknown（= 同主机 clientIp，②c 同 IP 前提的当场自证）—— 实际 ${JSON.stringify(g3MetaIp)}`,
    );
    checks.eq(g3MetaDev, g3Dev, '③ match:meta 的 deviceId 字段 = 上行发送值（原文）');
    const g3Poll = await pollUntil(
      () => getJson<RiskUserDetail>(`/api/admin/risk/users/${encodeURIComponent(g3User.id)}`, s.adminToken),
      (r) => (r.body?.data?.devices ?? []).some((d) => d.deviceId === g3Dev),
      25_000,
      2_000,
    );
    expectHttp(checks, { status: g3Poll.last.status, body: g3Poll.last.body }, 200, ErrCode.OK, '③ 详情轮询末次读');
    checks.that(
      g3Poll.ok,
      `③ risk.deviceReport 落库（≤25s 详情 devices 含 ${g3Dev}）—— 末次 ${JSON.stringify(g3Poll.last.body?.data?.devices)}`,
    );
    const g3DevRow = (g3Poll.last.body?.data?.devices ?? []).find((d) => d.deviceId === g3Dev);
    checks.that(
      (g3Poll.last.body?.data?.devices ?? []).length === 1 &&
        typeof g3DevRow?.firstSeenAt === 'number' && g3DevRow.firstSeenAt > 0 &&
        typeof g3DevRow?.lastSeenAt === 'number' && g3DevRow.lastSeenAt > 0,
      `③ 设备原文：恰一行 + firstSeenAt/lastSeenAt 为 epoch ms —— 实际 ${JSON.stringify(g3DevRow)}`,
    );
    checks.that(
      fieldSetViolations(Object.keys(g3Poll.last.body?.data ?? {}).sort(), [
        // `binding`（device-binding 86425de 追加的详情聚合：{deviceId,boundAt}|null）—— 与上条同因，
        // 该合并未同步本断言，T9 全序抓出。
        'accountStatus', 'bannedFlagPresent', 'binding', 'devices', 'entries', 'hits', 'limitSource', 'stats', 'userId',
      ]).length === 0,
      `③ 详情键集恰九（§2.8 第二行 + 终审 F2 的 bannedFlagPresent + 设备绑定片 binding）—— 实际 ${JSON.stringify(Object.keys(g3Poll.last.body?.data ?? {}).sort())}`,
    );
    checks.that(
      g3Poll.last.body?.data?.accountStatus === 'active' && g3Poll.last.body?.data?.limitSource === null,
      `③ accountStatus='active' / limitSource=null（无旗态）—— 实际 ${JSON.stringify({ a: g3Poll.last.body?.data?.accountStatus, l: g3Poll.last.body?.data?.limitSource })}`,
    );
    const g3Unmatch = await g3.client.send('room.unmatch', {});
    checks.eq(g3Unmatch.code, ErrCode.OK, '③ 收尾 room.unmatch ack code 0（清票，②组的队列洁癖）');
    g3.client.close();
    openClients.splice(openClients.indexOf(g3.client), 1);

    /* ════════════════════════════════════════════════════════════════════
     * ④ 检测面（§6.2-4）：注入缩间隔 + 降阈 + 造数 ⇒ 条目 ⇒ dismiss ⇒ 审计 ⇒ 重扫不复活
     * ════════════════════════════════════════════════════════════════════ */
    step(`④ 检测面：PUT risk.scanIntervalMs=${RISK_SCAN_INTERVAL_INJECT}（管理面注入）+ 重起 user-service ⇒ 降阈（minGames=1 + winRate=0.5）⇒ 造 2 局 2 胜 ⇒ 条目 ⇒ dismiss ⇒ 审计 ⇒ 重扫不复活 ⇒ 双复原`);
    await putInterval(s.adminToken, 'risk.scanIntervalMs', RISK_SCAN_INTERVAL_INJECT, '④ 注入');
    // ⚠️ `--force-recreate` 不可省（T12 实测 / 全场性）：env 退役后 `compose({})` 与现容器规格逐字
    //    一致 ⇒ 默认 no-op（容器 ID 不变、无新启动行）；而启动行断言与短间隔观测都以**真重启**为前提。
    const g4Up = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'user-service');
    checks.eq(g4Up.code, 0, `④ 注入重建 user-service —— 输出尾部：${tailOut(g4Up.out)}`);
    const g4Healthy = await waitContainerHealthy('ftl-user-service');
    checks.that(g4Healthy.ok, `④ 注入态 user-service 就绪 —— ${g4Healthy.last}`);
    const g4BootPoll = await pollUntil(
      () => ndjson('user-service', 600).filter((r) => String(r.msg).includes(`interval ${RISK_SCAN_INTERVAL_INJECT}ms`)).length,
      (n) => n > 0,
      30_000,
    );
    checks.that(
      g4BootPoll.ok,
      `④ 启动日志确认注入生效（\`Risk scan loop started (… interval ${RISK_SCAN_INTERVAL_INJECT}ms)\` 在场）`,
    );

    await putConfigAndWaitEffect(checks, s.adminToken, K_MIN_GAMES, MIN_GAMES_LOW, 'user-service');
    await putConfigAndWaitEffect(checks, s.adminToken, K_WIN_RATE, WIN_RATE_LOW, 'user-service');

    // 造数：两玩家各 2 局 2 胜（games=2 > 1、winRate=1.0 > 0.5 ⇒ hit1 ⇒ score 25；无设备票
    // ⇒ hit2=false ⇒ score 恰 25，<50 ⇒ **不会触发自动限流**，⑤ 的手动档才有干净起点）。
    s.userThrottle = await registerUser(51);
    const g4Stamps = Date.now();
    const g4Writes = [
      await writeRecord(craftWinningRecord(ROOM_HIT_1, s.userHit.id, g4Stamps), '④ 造数 H1'),
      await writeRecord(craftWinningRecord(ROOM_HIT_2, s.userHit.id, g4Stamps), '④ 造数 H2'),
      await writeRecord(craftWinningRecord(ROOM_THROTTLE_1, s.userThrottle.id, g4Stamps), '④ 造数 T1'),
      await writeRecord(craftWinningRecord(ROOM_THROTTLE_2, s.userThrottle.id, g4Stamps), '④ 造数 T2'),
    ];
    checks.that(
      g4Writes.every((w) => w === true),
      `④ 四条造数记录 written=true（新写入，非幂等命中）—— 实际 ${JSON.stringify(g4Writes)}`,
    );

    // 扫描轮打条目（启动后 30s 首轮 + 5s 间隔；90s 上界足够多轮）。
    const g4EntryPoll = await pollUntil(
      () => getJson<RiskUserDetail>(`/api/admin/risk/users/${encodeURIComponent(s.userHit!.id)}`, s.adminToken),
      (r) => r.body?.data?.entries?.[0]?.status === 'open',
      90_000,
      2_000,
    );
    checks.that(
      g4EntryPoll.ok,
      `④ 扫描打条目：≤90s 详情 entries[0].status=open —— 末次 ${JSON.stringify(g4EntryPoll.last.body?.data?.entries?.[0])}`,
    );
    const g4Entry = g4EntryPoll.last.body!.data!.entries[0]!;
    s.hitEntryId = g4Entry.id;
    checks.that(
      g4Entry.id > 0 && g4Entry.score === 25 && g4Entry.handledBy === null && g4Entry.handledAt === null,
      `④ 条目形状：{id>0, score:25（恰一命中项）, status:'open', handledBy/handledAt:null} —— 实际 ${JSON.stringify(g4Entry)}`,
    );
    const g4ReviewRow = await findOpenReviewByUser(s.adminToken, s.userHit.id, 10);
    checks.that(
      g4ReviewRow.found !== null && g4ReviewRow.found.id === g4Entry.id,
      `④ 队列列表（status=open，keyset 翻页 ≤10 页）含本用户条目 id=${g4Entry.id} —— 翻页 ${g4ReviewRow.pages} 页、实读 ${g4ReviewRow.scanned} 行`,
    );
    checks.that(
      g4ReviewRow.found !== null &&
        Array.isArray(g4ReviewRow.found.reasons) &&
        (g4ReviewRow.found.reasons as Array<{ check?: string }>).some((r) => r.check === 'winRate'),
      `④ 条目 reasons 含 {check:'winRate'}（判定面数值快照）—— 实际 ${JSON.stringify(g4ReviewRow.found?.reasons)}`,
    );

    // dismiss（**operator** 执行 —— 顺带证明 P-r4 的真动作 200 与审计 actor）。
    const g4DismissAt = Date.now(); // 「重扫」的时间锚（只数 dismiss 之后完成的轮）
    const g4Dismiss = await sendJson(
      'POST',
      '/api/admin/risk/actions',
      { userId: s.userHit.id, action: 'dismiss', reviewId: g4Entry.id, reason: `s20 ${TAG} 演练判定` },
      { token: s.operToken },
    );
    expectHttp(checks, g4Dismiss, 200, ErrCode.OK, '④ operator dismiss（open ⇒ dismissed）');
    // 审计行（同事务落 risk_actions；actor = operator 用户名）。
    const g4Audit = await getJson<{ items: RiskActionRow[] }>(
      `/api/admin/risk/actions?userId=${encodeURIComponent(s.userHit.id)}&limit=50`,
      s.operToken,
    );
    expectHttp(checks, g4Audit, 200, ErrCode.OK, '④ 审计读口（userId 过滤）');
    const g4AuditRow = (g4Audit.body?.data?.items ?? [])[0];
    checks.that(
      g4AuditRow?.action === 'dismiss' && g4AuditRow.actor === USERNAME_OPER &&
        g4AuditRow.reviewId === g4Entry.id && (g4AuditRow.reason ?? '').includes('演练判定'),
      `④ 审计行 = {action:'dismiss', actor:'${USERNAME_OPER}', reviewId:${g4Entry.id}, reason 命中} —— 实际 ${JSON.stringify(g4AuditRow)}`,
    );

    // 重扫不复活：等**≥2 轮新扫描**跑过（5s 间隔 ⇒ ~10s；30s 上界），再点掉。
    // ⚠️ 时间锚（非窗口计数）：只数 **dismiss 之后**完成的轮（窗口边缘老化不参与）。
    const g4ScanDoneAfter = (sinceMs: number): number =>
      ndjson('user-service', 600).filter((r) => {
        const ts = Date.parse(String(r.ts));
        return (
          String(r.msg).startsWith('risk scan done') && Number.isFinite(ts) && ts >= sinceMs
        );
      }).length;
    const g4RoundsPoll = await pollUntil(
      () => g4ScanDoneAfter(g4DismissAt),
      (n) => n >= 2,
      30_000,
    );
    checks.that(
      g4RoundsPoll.ok,
      `④ 反空测：dismiss 后 ≥2 轮扫描已跑（dismiss 之后新增 ${g4RoundsPoll.last} 轮；没有它们「不复活」无从说起）`,
    );
    const g4After = await getJson<RiskUserDetail>(`/api/admin/risk/users/${encodeURIComponent(s.userHit.id)}`, s.adminToken);
    expectHttp(checks, g4After, 200, ErrCode.OK, '④ 重扫后详情');
    checks.that(
      g4After.body?.data?.entries?.length === 1 && g4After.body?.data?.entries?.[0]?.status === 'dismissed',
      `④ 重扫**不复活**：entries 仍恰 1 条且为 dismissed（同分抑制）—— 实际 ${JSON.stringify(g4After.body?.data?.entries)}`,
    );
    const g4RowAfter = await findOpenReviewByUser(s.adminToken, s.userHit.id, 10);
    checks.that(
      g4RowAfter.found === null,
      `④ open 列表翻页不再含本用户（≤10 页、实读 ${g4RowAfter.scanned} 行）`,
    );

    // 双复原：阈值先回种子（等生效），间隔键 PUT 回知基线 3600000 + 重建（⚙️9 换源）。
    await putConfigAndWaitEffect(checks, s.adminToken, K_MIN_GAMES, 100, 'user-service');
    await putConfigAndWaitEffect(checks, s.adminToken, K_WIN_RATE, 0.8, 'user-service');
    await putInterval(s.adminToken, 'risk.scanIntervalMs', RISK_SCAN_INTERVAL_RESTORE, '④ 还原基线');
    const g4RestoreT0 = Date.now();
    const g4Restore = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'user-service');
    checks.eq(g4Restore.code, 0, `④ 还原重建（知基线 ${RISK_SCAN_INTERVAL_RESTORE}）—— 输出尾部：${tailOut(g4Restore.out)}`);
    const g4Healthy2 = await waitContainerHealthy('ftl-user-service');
    checks.that(g4Healthy2.ok, `④ 复原态 user-service 就绪 —— ${g4Healthy2.last}`);
    const g4BootBack = await pollUntil(
      () =>
        ndjson('user-service', 600).filter(
          (r) =>
            String(r.msg).includes('interval 3600000ms') &&
            Number.isFinite(Date.parse(String(r.ts))) && Date.parse(String(r.ts)) >= g4RestoreT0,
        ).length,
      (n) => n > 0,
      30_000,
    );
    checks.that(g4BootBack.ok, '④ 复原启动日志确认（本 run 重启后有 `interval 3600000ms` 行）');

    /* ════════════════════════════════════════════════════════════════════
     * ④b 设备清理节奏（规格 ⚙️9 新增；位置钉死：④ 之后、⑤ 之前 —— 判据 = 心跳日志 ≥2 行）
     * ════════════════════════════════════════════════════════════════════ */
    step('④b 设备清理节奏：PUT risk.devicesCleanupIntervalMs=5000 + 重建 ⇒ 心跳 ≥2 行 ⇒ 还原 3600000');
    await putInterval(s.adminToken, 'risk.devicesCleanupIntervalMs', 5000, '④b 注入');
    // `--force-recreate` 理由同 ④（no-op 重建 ⇒ 无新启动行、无 5s 心跳）。
    const g4bUp = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'user-service');
    checks.eq(g4bUp.code, 0, `④b 注入重建 user-service —— 输出尾部：${tailOut(g4bUp.out)}`);
    checks.that((await waitContainerHealthy('ftl-user-service')).ok, '④b 注入态就绪');
    const g4bBoot = await pollUntil(
      () =>
        ndjson('user-service', 600).filter(
          (r) =>
            String(r.msg).includes('interval 5000ms') && String(r.msg).includes('Risk devices cleanup loop started'),
        ).length,
      (n) => n > 0,
      30_000,
    );
    checks.that(g4bBoot.ok, '④b 启动行 `interval 5000ms`（解析值=配置值）');
    // 心跳行实文（`devices-cleanup.service.ts` 的 `runCleanupInner` 每轮一条，零删除轮也留）：
    // `risk devices cleanup done: retentionDays=… cutoffMs=… deletedDevices=… durationMs=…`。
    // ⚠️ 重建换容器 ⇒ 容器日志只含本实例 ⇒ 计数不会数到旧实例的旧心跳（本判据的判别力前提）。
    const g4bRounds = await pollUntil(
      () => ndjson('user-service', 1200).filter((r) => String(r.msg).includes('risk devices cleanup done')).length,
      (n) => n >= 2,
      45_000,
    );
    checks.that(g4bRounds.ok, `④b 心跳日志 ≥2 行（30s 首轮 + 5s 间隔；观测窗 ≥45s）—— 实际 ${g4bRounds.last}`);
    const g4bT0 = Date.now();
    await putInterval(s.adminToken, 'risk.devicesCleanupIntervalMs', 3600000, '④b 还原基线');
    const g4bDown = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'user-service');
    checks.eq(g4bDown.code, 0, `④b 还原重建 —— 输出尾部：${tailOut(g4bDown.out)}`);
    const g4bBack = await pollUntil(
      () =>
        ndjson('user-service', 600).filter(
          (r) =>
            String(r.msg).includes('interval 3600000ms') &&
            String(r.msg).includes('Risk devices cleanup loop started') &&
            Number.isFinite(Date.parse(String(r.ts))) &&
            Date.parse(String(r.ts)) >= g4bT0,
        ).length,
      (n) => n > 0,
      30_000,
    );
    checks.that(g4bBack.ok, '④b 还原启动行确认（本 run 新 `interval 3600000ms`）');

    /* ════════════════════════════════════════════════════════════════════
     * ⑤ 限流档（§6.2-5）：手动 throttle ⇒ 高频 HTTP 429（3/1s）⇒ unthrottle 恢复
     * ════════════════════════════════════════════════════════════════════ */
    step('⑤ 限流档：operator throttle（open ⇒ throttled + manual 旗）⇒ 高频 HTTP 恰 429/10006 ⇒ unthrottle ⇒ 同形态高频零 429');
    const g5User = s.userThrottle!;
    const g5EntryPoll = await pollUntil(
      () => getJson<RiskUserDetail>(`/api/admin/risk/users/${encodeURIComponent(g5User.id)}`, s.adminToken),
      (r) => r.body?.data?.entries?.[0]?.status === 'open',
      30_000,
      2_000,
    );
    checks.that(
      g5EntryPoll.ok,
      `⑤ 前置：被造数玩家有 open 条目（throttle 的源态条件）—— 末次 ${JSON.stringify(g5EntryPoll.last.body?.data?.entries?.[0])}`,
    );
    s.throttleEntryId = g5EntryPoll.last.body!.data!.entries[0]!.id;
    const g5Throttle = await sendJson(
      'POST',
      '/api/admin/risk/actions',
      { userId: g5User.id, action: 'throttle', reviewId: s.throttleEntryId, reason: `s20 ${TAG} 限流演练` },
      { token: s.operToken },
    );
    expectHttp(checks, g5Throttle, 200, ErrCode.OK, '⑤ operator throttle（open ⇒ throttled）');
    checks.eq(redisInt(['EXISTS', `risk:limit:${g5User.id}`]), 1, '⑤ risk:limit 旗在场（manual）');
    const g5FlagRaw = redisText(['GET', `risk:limit:${g5User.id}`]);
    checks.that(
      (() => {
        try {
          return (JSON.parse(g5FlagRaw) as { source?: unknown }).source === 'manual';
        } catch {
          return false;
        }
      })(),
      `⑤ 旗值 = JSON {source:'manual',…}（人工档）—— 实际 ${JSON.stringify(g5FlagRaw)}`,
    );
    const g5Detail = await getJson<RiskUserDetail>(`/api/admin/risk/users/${encodeURIComponent(g5User.id)}`, s.adminToken);
    expectHttp(checks, g5Detail, 200, ErrCode.OK, '⑤ 详情（limitSource）');
    checks.eq(g5Detail.body?.data?.limitSource, 'manual', '⑤ 详情 limitSource = manual（F13 读面）');

    // 高频 6 连（并发；Player 面 GET /api/config —— 走用户维 peek）：档位在 ⇒ ≥1 个 429/10006。
    const g5Burst = await burstConfigProbes(g5User.accessToken, 6);
    const g5Passed = g5Burst.filter((r) => r.status === 200 && r.code === ErrCode.OK);
    const g5Blocked = g5Burst.filter((r) => r.status === 429);
    checks.that(
      g5Blocked.length >= 1 && g5Passed.length >= 1,
      `⑤ 限流档生效：首批 6 连里 ≥1 个 429 且 ≥1 个放行（3/1s 档）—— 实际 ${JSON.stringify(g5Burst)}`,
    );
    checks.that(
      g5Blocked.length > 0 && g5Blocked.every((r) => r.code === ErrCode.RATE_LIMITED),
      `⑤ 全部 429 的 code = 10006 —— 实际 ${JSON.stringify(g5Blocked)}`,
    );

    // unthrottle（旗在 ⇒ 删旗 + 审计；条目 throttled ⇒ 顺带 dismissed）。
    const g5Unthrottle = await sendJson(
      'POST',
      '/api/admin/risk/actions',
      { userId: g5User.id, action: 'unthrottle', reviewId: s.throttleEntryId, reason: '=1+1 消毒样本' },
      { token: s.operToken },
    );
    expectHttp(checks, g5Unthrottle, 200, ErrCode.OK, '⑤ operator unthrottle（旗在 ⇒ 删旗）');
    checks.eq(redisInt(['EXISTS', `risk:limit:${g5User.id}`]), 0, '⑤ 解除后旗已删（EXISTS=0）');
    const g5After = await getJson<RiskUserDetail>(`/api/admin/risk/users/${encodeURIComponent(g5User.id)}`, s.adminToken);
    checks.that(
      g5After.body?.data?.entries?.[0]?.status === 'dismissed' && g5After.body?.data?.limitSource === null,
      `⑤ unthrottle 顺带迁 dismissed 且 limitSource 回 null —— 实际 ${JSON.stringify({ e: g5After.body?.data?.entries?.[0]?.status, l: g5After.body?.data?.limitSource })}`,
    );
    // 恢复正对照：同形态 6 连零 429（判别力——429 来自档位而不是别的桶）。
    const g5Burst2 = await burstConfigProbes(g5User.accessToken, 6);
    checks.that(
      g5Burst2.every((r) => r.status === 200 && r.code === ErrCode.OK),
      `⑤ 解除后同形态 6 连全放行（正对照：429 确由档位而来）—— 实际 ${JSON.stringify(g5Burst2)}`,
    );

    /* ════════════════════════════════════════════════════════════════════
     * ⑥ 封禁面（§6.2-6）：ban ⇒ 登录 403/11003 + 握手断开 ⇒ unban ⇒ 双恢复
     * ════════════════════════════════════════════════════════════════════ */
    step('⑥ 封禁面：operator ban ⇒ 新登录 403/11003 + WS 握手被拒（断开）⇒ unban ⇒ 登录与握手双恢复');
    const g6User = await registerUser(52);
    const g6Ban = await sendJson(
      'POST',
      '/api/admin/risk/actions',
      { userId: g6User.id, action: 'ban', reason: `s20 ${TAG} 封禁演练` },
      { token: s.operToken },
    );
    expectHttp(checks, g6Ban, 200, ErrCode.OK, '⑥ operator ban（users.status + 旗）');
    checks.eq(redisInt(['EXISTS', `risk:banned:${g6User.id}`]), 1, '⑥ risk:banned 旗在场（后置写实达）');
    const g6Login = await login(g6User.phone, HARNESS_PASSWORD);
    checks.eq(g6Login.status, 403, '⑥ 封禁后新登录 ⇒ HTTP 403');
    checks.eq(g6Login.body?.code, ErrCode.USER_BANNED, '⑥ 封禁后新登录 ⇒ code 11003');
    checks.that(
      String(g6Login.body?.message ?? '').includes('封禁'),
      `⑥ 封禁文案含「封禁」—— 实际 ${JSON.stringify(g6Login.body?.message)}`,
    );
    let g6HandshakeRejected = false;
    let g6HandshakeDetail = '';
    try {
      // T7 实证的客户端形态（slice 演练读数）：**先 connect、随后被服务端断开** ——
      // `rejectHandshake` = `disconnect(true)` + 尽力 `system.error` 11003；权威信号 =
      // **断开本身**（spec §2.7-2②：客户端不得把「没收到 system.error」当成握手成功）。
      const banned = await HarnessClient.connect('S20-6-ban', g6User);
      openClients.push(banned);
      const dropped = await pollUntil(() => banned.connected, (c) => c === false, 5_000, 200);
      g6HandshakeRejected = dropped.ok;
      const saw11003 = banned.received.some(
        (r) => r.type === 'system.error' && (r.message?.payload as { code?: number } | undefined)?.code === ErrCode.USER_BANNED,
      );
      g6HandshakeDetail = `5s 内 connected=${dropped.last}；system.error 11003 ${saw11003 ? '在场' : '未收到（best-effort，允许）'}`;
      banned.close();
      openClients.splice(openClients.indexOf(banned), 1);
    } catch (err) {
      // 另一条合法形态：直接 `connect_error`（中间件级拒绝）—— 同样算「握手被拒」。
      g6HandshakeRejected = true;
      g6HandshakeDetail = `connect_error：${err instanceof Error ? err.message : String(err)}`;
    }
    checks.that(
      g6HandshakeRejected,
      `⑥ 封禁中 WS 握手被拒（服务端断开连接；权威信号=断开本身）—— ${g6HandshakeDetail}`,
    );
    const g6Unban = await sendJson(
      'POST',
      '/api/admin/risk/actions',
      { userId: g6User.id, action: 'unban', reason: `s20 ${TAG} 解封演练` },
      { token: s.operToken },
    );
    expectHttp(checks, g6Unban, 200, ErrCode.OK, '⑥ operator unban（status⇒active + 删旗）');
    checks.eq(redisInt(['EXISTS', `risk:banned:${g6User.id}`]), 0, '⑥ 解封后旗已删（EXISTS=0）');
    const g6Login2 = await login(g6User.phone, HARNESS_PASSWORD);
    checks.eq(g6Login2.status, 200, '⑥ 解封后登录 ⇒ HTTP 200');
    checks.eq(g6Login2.body?.code, ErrCode.OK, '⑥ 解封后登录 ⇒ code 0（即时全通）');
    const g6Back = await HarnessClient.connect('S20-6-unban', g6User);
    await sleep(1_000); // 判别力：封禁态同窗口内必已被服务端断开 ⇒ 存活 1s = 未命中封禁读旗
    checks.that(g6Back.connected, '⑥ 解封后 WS 握手恢复（连接建立且 1s 后仍存活）');
    g6Back.close();

    /* ════════════════════════════════════════════════════════════════════
     * ⑦ 权限面（§6.2-7）：viewer/finance 四端点（+写面）403 vs operator 200
     *   + 波 3 F1 转办：**混大小写路径**（Express 路由大小写不敏感 ⇒ 必须与全小写同判）
     * ════════════════════════════════════════════════════════════════════ */
    step('⑦ 权限面：viewer/finance 对 reviews/users:/actions/actions.csv/POST-actions ⇒ 403（证未落 P8）；operator 四读端点 ⇒ 200；混大小写路径同判（波 3 F1）');
    const g7Paths = [
      ['GET', '/api/admin/risk/reviews'],
      ['GET', `/api/admin/risk/users/${encodeURIComponent(s.userHit!.id)}`],
      ['GET', '/api/admin/risk/actions'],
      ['GET', '/api/admin/risk/actions.csv'],
    ] as const;
    for (const [role, token] of [
      ['viewer', () => s.viewerToken],
      ['finance', () => s.finToken],
    ] as const) {
      for (const [method, path] of g7Paths) {
        const r = await sendJson(method, path, undefined, { token: token() });
        checks.eq(r.status, 403, `⑦ ${role} ${method} ${path} ⇒ 403（P-r1..r3 生效）`);
      }
      const rWrite = await sendJson(
        'POST',
        '/api/admin/risk/actions',
        { userId: s.userHit!.id, action: 'dismiss', reason: 'x' },
        { token: token() },
      );
      checks.eq(rWrite.status, 403, `⑦ ${role} POST /api/admin/risk/actions ⇒ 403（P-r4 生效；不达下游）`);
    }
    expectHttp(checks, await getJson('/api/admin/risk/reviews?limit=5', s.operToken), 200, ErrCode.OK, '⑦ operator GET reviews');
    expectHttp(checks, await getJson(`/api/admin/risk/users/${encodeURIComponent(s.userHit!.id)}`, s.operToken), 200, ErrCode.OK, '⑦ operator GET users/:id');
    expectHttp(checks, await getJson('/api/admin/risk/actions?limit=5', s.operToken), 200, ErrCode.OK, '⑦ operator GET actions');
    const g7Csv = await fetchCsvRaw('/api/admin/risk/actions.csv', s.operToken);
    checks.eq(g7Csv.status, 200, '⑦ operator GET actions.csv ⇒ 200（字节面在下组细验）');

    // ── 波 3 F1 转办：**混大小写路径**（Express/Nest 路由大小写不敏感）必须与全小写**同判** ──
    // 背景（T7 `4bfea46`）：策略表字面量全小写，此前按原文匹配 ⇒ 混大小写 GET 落 P8
    // 「任意已认证角色」**放行**（viewer 越权读——🔴 实证）。修复 = `authorizeAdmin` 内
    // 匹配用小写折叠（豁免/`isAdminPath`/限流桶仍用原值）。
    // viewer + GET 变体是本洞的**判别样本**（修复前 200，修复后 403）；POST 变体是
    // fail-closed 侧的伴例。operator 变体 200 = 正对照（证明变体**到达真处理器**且按
    // P-r1 放行——不是被 AdminAuth 一刀切成 401）。
    const g7CaseGet = await sendJson('GET', '/API/admin/risk/reviews', undefined, { token: s.viewerToken });
    expectHttp(checks, g7CaseGet, 403, ErrCode.FORBIDDEN, '⑦ 波3F1：viewer GET /API/admin/risk/reviews（混大小写）⇒ 403（修复前落 P8 ⇒ 200；也不得 401）');
    const g7CasePost = await sendJson(
      'POST',
      '/API/ADMIN/risk/ACTIONS',
      { userId: s.userHit!.id, action: 'dismiss', reason: 'x' },
      { token: s.viewerToken },
    );
    expectHttp(checks, g7CasePost, 403, ErrCode.FORBIDDEN, '⑦ 波3F1：viewer POST /API/ADMIN/risk/ACTIONS（混大小写）⇒ 403（fail-closed，不达下游）');
    expectHttp(checks, await sendJson('GET', '/API/ADMIN/risk/reviews', undefined, { token: s.operToken }), 200, ErrCode.OK, '⑦ 波3F1 正对照：operator GET /API/ADMIN/risk/reviews（混大小写）⇒ 200（变体达真处理器、按 P-r1 放行）');

    /* ════════════════════════════════════════════════════════════════════
     * ⑧ 审计面（§6.2-8）：列表过滤 + 行形状 + CSV（BOM/CRLF/消毒）
     * ════════════════════════════════════════════════════════════════════ */
    step('⑧ 审计面：risk/actions 列表（userId/action 过滤 + 恰八键 + actor）+ CSV 字节级（BOM/CRLF/消毒 =1+1 ⇒ \'=1+1）');
    const g8HitRows = await getJson<{ items: RiskActionRow[] }>(
      `/api/admin/risk/actions?userId=${encodeURIComponent(s.userHit!.id)}&limit=50`,
      s.operToken,
    );
    expectHttp(checks, g8HitRows, 200, ErrCode.OK, '⑧ 列表 userId=userHit');
    checks.that(
      (g8HitRows.body?.data?.items ?? []).length === 1 &&
        g8HitRows.body?.data?.items?.[0]?.action === 'dismiss' &&
        g8HitRows.body?.data?.items?.[0]?.actor === USERNAME_OPER,
      `⑧ userHit 恰 1 行 dismiss/actor=${USERNAME_OPER} —— 实际 ${JSON.stringify(g8HitRows.body?.data?.items)}`,
    );
    const g8ThrottleRows = await getJson<{ items: RiskActionRow[] }>(
      `/api/admin/risk/actions?userId=${encodeURIComponent(s.userThrottle!.id)}&limit=50`,
      s.operToken,
    );
    expectHttp(checks, g8ThrottleRows, 200, ErrCode.OK, '⑧ 列表 userId=userThrottle');
    const g8ThrottleItems = g8ThrottleRows.body?.data?.items ?? [];
    checks.that(
      g8ThrottleItems.length === 2 &&
        [...g8ThrottleItems].map((r) => r.action).sort().join(',') === 'throttle,unthrottle' &&
        g8ThrottleItems.every((r) => r.actor === USERNAME_OPER),
      `⑧ userThrottle 恰 2 行 {throttle, unthrottle}（actor 均 ${USERNAME_OPER}；id DESC）—— 实际 ${JSON.stringify(g8ThrottleItems.map((r) => r.action))}`,
    );
    checks.that(
      fieldSetViolations(Object.keys(g8ThrottleItems[0] ?? {}).sort(), [
        'action', 'actor', 'createdAt', 'detail', 'id', 'reason', 'reviewId', 'userId',
      ]).length === 0,
      `⑧ 审计行键集恰八（§2.8 第四行）—— 实际 ${JSON.stringify(Object.keys(g8ThrottleItems[0] ?? {}).sort())}`,
    );
    const g8BanRows = await getJson<{ items: RiskActionRow[] }>(
      `/api/admin/risk/actions?userId=${encodeURIComponent(g6User.id)}&action=ban&limit=50`,
      s.operToken,
    );
    expectHttp(checks, g8BanRows, 200, ErrCode.OK, '⑧ 列表 action=ban 过滤');
    checks.that(
      (g8BanRows.body?.data?.items ?? []).length === 1 && g8BanRows.body?.data?.items?.[0]?.action === 'ban',
      `⑧ action=ban 过滤恰 1 行 —— 实际 ${JSON.stringify((g8BanRows.body?.data?.items ?? []).map((r) => r.action))}`,
    );
    const g8Csv = await fetchCsvRaw(
      `/api/admin/risk/actions.csv?userId=${encodeURIComponent(s.userThrottle!.id)}`,
      s.operToken,
    );
    csvByteChecks(checks, g8Csv, '⑧ risk-actions.csv', 'risk-actions', [
      'ID,用户ID,动作,操作者,理由,条目ID,详情,时间',
      s.userThrottle!.id,
      USERNAME_OPER,
      "'=1+1",
      'unthrottle',
    ]);

    /* ════════════════════════════════════════════════════════════════════
     * ⑨ 回归面（§6.2-9）：玩家 records/mine 键集不含 deviceId
     * ════════════════════════════════════════════════════════════════════ */
    step('⑨ 回归面：records/mine（④ 造数的玩家）键集不含 deviceId（递归键名 + 原文串双扫描）');
    const g9Mine = await getJson<{ items: Array<Record<string, unknown>> }>('/api/records/mine', s.userHit!.accessToken);
    expectHttp(checks, g9Mine, 200, ErrCode.OK, '⑨ GET /api/records/mine');
    checks.that(
      (g9Mine.body?.data?.items ?? []).length >= 1 &&
        (g9Mine.body?.data?.items ?? []).some((it) => it.roomCode === ROOM_HIT_1 || it.roomCode === ROOM_HIT_2),
      `⑨ 战绩含本 run 造数对局（否则「不含 deviceId」是空测）—— 实际 ${JSON.stringify((g9Mine.body?.data?.items ?? []).map((it) => it.roomCode))}`,
    );
    const g9KeyHits = keyPathsNamed(g9Mine.body?.data, 'deviceId');
    checks.that(
      g9KeyHits.length === 0,
      `⑨ 递归键名扫描零 deviceId 键（任意深度）—— 实际 ${JSON.stringify(g9KeyHits)}`,
    );
    const g9Raw = JSON.stringify(g9Mine.body?.data ?? null);
    checks.that(
      !g9Raw.includes('deviceId'),
      `⑨ 原文串扫描零 'deviceId'（值面同样不出站）—— 命中 ${JSON.stringify(g9Raw.match(/.{0,20}deviceId.{0,20}/g) ?? [])}`,
    );

    /* ════════════════════════════════════════════════════════════════════
     * 收尾：一次性管理员停用（不删，留档）
     * ════════════════════════════════════════════════════════════════════ */
    step('收尾：三个一次性管理员停用留档（不删）；谓词开关/阈值/注入复原已在前文各自落地');
    const oneTime = [
      [USERNAME_VIEWER, s.viewerId],
      [USERNAME_FIN, s.finId],
      [USERNAME_OPER, s.operId],
    ] as const;
    for (const [username, id] of oneTime) {
      expectHttp(
        checks,
        await sendJson('PATCH', `/api/admin/accounts/${id}`, { status: 'disabled' }, { token: s.adminToken }),
        200,
        ErrCode.OK,
        `收尾 停用 ${username}`,
      );
    }
    info(`留档：${oneTime.map(([u]) => u).join(', ')}（disabled，未删除）；harness 玩家与记录/设备留库（既有切片同款）`);
    closeAll();

    cleanupDone = true;
    return checks;
  } finally {
    closeAll();
    // 兜底复原（成败皆然；只 info，不顶掉原始结论）：谓词开关回默认关 + 阈值回种子 +
    // 两间隔键 PUT 回知基线 3600000（⚙️9 换源：旧 env 注入面已退役）+ user-service 重建。
    if (!cleanupDone) {
      try {
        const admin2 = await adminLogin();
        for (const [key, value] of [
          [K_PRED_SAME_DEVICE, false],
          [K_PRED_SAME_IP, false],
          [K_MIN_GAMES, 100],
          [K_WIN_RATE, 0.8],
        ] as const) {
          const res = await adminPutConfig(key, value, admin2);
          info(`兜底复原：PUT ${key}=${JSON.stringify(value)} ⇒ HTTP ${res.status} code=${String(res.body?.code)}`);
        }
        await putInterval(admin2, 'risk.scanIntervalMs', RISK_SCAN_INTERVAL_RESTORE, 'finally 兜底：④ 还原基线');
        // ④b 的键一并兜底：crash 在 ④b 注入与还原之间时，5000 不许泄漏给后续切片（本片不变量）。
        await putInterval(admin2, 'risk.devicesCleanupIntervalMs', 3_600_000, 'finally 兜底：④b 还原基线');
        const up = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'user-service');
        info(`兜底复原：user-service 重建（两间隔键已 PUT 回知基线）⇒ exit ${up.code}`);
        const healthy = await waitContainerHealthy('ftl-user-service', 60_000);
        info(`兜底复原：user-service ${healthy.last}`);
      } catch (err) {
        info(
          `兜底复原失败（不影响原始结论，手动检查谓词开关 / 阈值 / user-service 注入态）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * 高频并发探针（⑤ 组）：以玩家令牌并发发 `n` 条 `GET /api/config`（走网关**用户维**
 * 限流 peek —— 档位在 ⇒ `THROTTLED_RATE_LIMIT` 3/1s）。返回逐条 {status, code}。
 */
async function burstConfigProbes(
  token: string,
  n: number,
): Promise<Array<{ status: number; code: number | undefined }>> {
  const results = await Promise.all(
    Array.from({ length: n }, () => getJson<Record<string, unknown>>('/api/config', token)),
  );
  return results.map((r) => ({ status: r.status, code: r.body?.code }));
}

/**
 * 在 `status=open` 的队列里按 userId 找本用户的条目（keyset `id DESC` 翻页，≤`maxPages` 页；
 * 页/行读数进断言消息）。**先 find 后单断言**（不逐行 checks —— 数据相关循环的计数纪律）。
 */
async function findOpenReviewByUser(
  token: string,
  userId: string,
  maxPages: number,
): Promise<{ found: RiskReviewRow | null; pages: number; scanned: number }> {
  let cursor: number | null = null;
  let pages = 0;
  let scanned = 0;
  for (let i = 0; i < maxPages; i += 1) {
    const query: string = cursor === null ? '' : `&cursor=${cursor}`;
    const pagePath: string = `/api/admin/risk/reviews?status=open&limit=100${query}`;
    const res: { status: number; body: Envelope<{ items: RiskReviewRow[]; nextCursor: number | null }> | null } =
      await getJson<{ items: RiskReviewRow[]; nextCursor: number | null }>(pagePath, token);
    if (res.status !== 200 || res.body?.code !== ErrCode.OK) {
      throw new ConformanceError(
        `open 队列翻页失败（第 ${i + 1} 页）：HTTP ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    pages += 1;
    const items: RiskReviewRow[] = res.body?.data?.items ?? [];
    scanned += items.length;
    const hit = items.find((r: RiskReviewRow) => r.userId === userId);
    if (hit) return { found: hit, pages, scanned };
    cursor = res.body?.data?.nextCursor ?? null;
    if (cursor === null) break;
  }
  return { found: null, pages, scanned };
}

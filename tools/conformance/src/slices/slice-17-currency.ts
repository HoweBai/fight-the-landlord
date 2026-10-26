/**
 * conformance 用例：**货币核心（P2-①）T10** —— 真栈判据（规格 §6.2 十一组；判据 C2–C16 的
 * conformance 侧载体 + C20 登记）。
 *
 * ─── 编排顺序与理由（为什么是这个序）────────────────────────────────────────
 *  ① 前置与收尾：起手自证（adminLogin）+ 容器 healthy + **测试行/键清源**（固定前缀 `s17`
 *     的残留一并回收——「零痕迹」类判据要求起手读数确定）+ 把 `currency.signupGrant` 落回 0
 *     并等缓存刷新（后组「新用户余额=0」才有确定前提）；
 *  ② C1：exec 探针（健康豁免正/负、9004 两向）+ 3104 RPC 直投可通；
 *  ③ C2：`compose exec mysql` 三表逐列（列名+类型**完整串**）/逐索引/迁移表行；
 *  ④ apply 四组（正常入账 / 重放同 id / 冲突 14002 / 不足 14001 + 多账户原子）——先跑，
 *     因为它给后面所有组**造出确定余额**；
 *  ④b 并发 burst（C7 **主载体**：真栈并行 N 扣减 ⇒ 终止余额 = 初值 − 成功×单额 + 全程无负；
 *     假 DB 只证控制流，原子性语义只有真库担得起）；
 *  ⑤ get 组（同序/重复/exists=false/不建行/读穿写缓存/⚙️15 不写 0）；
 *  ⑥ 玩家 REST（经网关：0 ⇒ 调整 ⇒ 新值；缺/伪造身份打不进——伪造 = 带别人的 X-User-Id，
 *     网关在边缘剥离后只认验签身份）；
 *  ⑦ 管理 REST（adjust 成功/重放同 opId/audit 落 ops；**≤20 条倒序**的 recentFlows 用
 *     **RPC 直投造 22 条流水**——管理写桶 30 次/5 分钟（`ADMIN_WRITE`），22 次 REST 调整
 *     会把桶打爆（429 假红）；判据对象是 accounts 端点的读面，不是写面来路）；14001/14002
 *     经网关的状态码；lookup 命中/404/400；未开户空态；非管理令牌 401；
 *  ⑧ 注册赠送两态（PUT 777 + 等缓存刷新 ⇒ 注册即到账 + ops/flows 各 1 行 + `signup:<id>`
 *     重放不重复；PUT 回 0 + 等刷新 ⇒ 新注册**按 userId 零痕迹**（不按全局计数——前组已造行）、
 *     旧户余额不变）。两处读法照 C13 钉死：零痕迹按 userId；缓存刷新以
 *     `config snapshot applied (version=…)` 行**计数**为观测量（容器启动首拉也会打一行，
 *     只凭「有没有」会把启动读数误当生效）；
 *  ⑧b 销毁上账（本片）：直投 burn 两态 + summary 增量 + V3/V1 反例 + 空窗（固定 owner 前缀 s17burn*）。
 *  ⑨ reconcile（7 条指标名齐 + 三系列在 ⇒ 管理面 PUT `currency.reconcileIntervalMs=3000` + 重起 ⇒
 *     runs≥2、last_success 前进 ⇒ 构造账实漂移（+7）⇒ gauge=1 + error 日志 + **不自修**
 *     ⇒ 修回归零 ⇒ 缓存漂移（SET 错值）⇒ counter 增 + 键被 DEL（自愈）⇒ 孤儿（固定前缀
 *     的 ops+flows 直插）⇒ gauge 增 + 日志 ⇒ PUT 回知基线 3600000 + 重起）；
 *  ⑩ prometheus 15/15（含 currency-service；支付片 T15 +payment-service）；
 *  ⑪ 静态/负例（C8 负例抽样 + ownerType 异型 10001 与响亮日志；C12 经门口拉 `/admin/app.js`
 *     断言「钱包调整」与三端点串；C14 `/api/config` 键集负对照）；
 *  收尾：测试行/键清理（断言归零）+ 注入/键值兜底复原（`finally`）。
 *
 * ─── 手法先例（逐条对应）─────────────────────────────────────────────────
 *  - `compose()` / `exec()` / `tailOut()` / `mysqlQuery()`：照 `slice-15-records.ts`
 *    （spawnSync 手型、`exec` 必带 `-T`、失败断言带输出尾部）；注入重起 = `up -d --no-deps`
 *    + `--force-recreate`（slice-15 C8 / slice-14 C17a；本片起注入走配置面、compose 无 env
 *    变化 ⇒ 保重建必须件——W5-M1）。
 *  - `composeLogs()` / `safeJson()`：照 `slice-12`；`waitContainerHealthy`：照 `slice-14`。
 *  - `execCurl` / `parseProm` / `sumMetric` / `seriesValue`：照 `slice-16-monitoring.ts`
 *    （`docker exec … curl` 抓 9004——指标端口不发布宿主口）。
 *  - `adminLogin/adminPutConfig/adminGetConfig`（lib/http 既有）；`redisRaw`（lib/redis 既有）；
 *    经门口取静态页 = node:https + `rejectUnauthorized: false`（照 slice-14 C20 的手型）。
 *  - **不 import `@fight-the-landlord/shared`**（R168：不拿被测实现当裁判）；`protocol`
 *    只用于造合法输入与契约常量（`RPC_PATTERNS`/`ErrCode`）——
 *    判定对象永远是**真后端的回答**（库行 / 服务响应 / 容器日志 / prometheus API）。
 *    ⚠️ ② 金币场 T12 起 C14 的键集断言改为**逐字名单**（7 键），不再 import `CLIENT_CONFIG_KEYS`；
 *    支付片 T5 同步：逐字名单 7 → 14（⚙️11 七裸名）；广告片 T23 同步：14 → 15 键（+裸名
 *    `reliefAdpid`，第 15 键）；台费阶段 2 删除派生字段 `entryFeePercents` 后 21 键。
 *  - **零 `skip()`、零分支**（基线静态回填的前提）：全部断言在任何环境下都执行。
 *
 * ─── 本片对真栈的副作用与复原 ────────────────────────────────────────────
 *  注入 `currency.reconcileIntervalMs=3000`（管理面 PUT + 重起 currency-service，⑨ 末即
 *  PUT 回知基线 3600000）、`currency.signupGrant` 临时改 777 后**必改回 0**、固定前缀
 *  `s17*` 的库行与 Redis 键—— 收官统一复原（`finally` 兜底），一条也不许泄漏给后续运行。
 */
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import {
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type CurrencyGetData,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  INTERNAL_TOKEN,
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
} from '../lib/http';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';
import { redisRaw, redisReplyText } from '../lib/redis';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-15）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * `currency.apply` / `currency.get` 的 TCP 监听（宿主直投 = compose override 的 `3104:3104`；
 * `lib/rpc.ts` 只登记了 game/robot 两处端点 —— 本文件自带一个，**不碰**既有 lib，照 slice-15）。
 */
const CURRENCY_RPC: RpcEndpoint = {
  host: process.env.CURRENCY_RPC_HOST ?? 'localhost',
  port: Number(process.env.CURRENCY_RPC_PORT ?? 3104),
};

const PROM_URL = process.env.PROM_URL ?? 'http://localhost:9090';
const EDGE_HTTP_PORT = process.env.EDGE_HTTP_PORT ?? '8080';

/** 第 11 键（§2.8，写死）；注入值 777 与复原值 0。 */
const SIGNUP_GRANT_KEY = 'currency.signupGrant';
const GRANT_ON = 777;
const GRANT_OFF = 0;

/**
 * ⑨ 的注入值（本片 ⚙️9 换源：管理面 PUT `currency.reconcileIntervalMs` —— 旧 env 注入面已退役；
 * 3s 一轮，够在秒级窗口观测 ≥2 轮）。数值型：`parseIntervalMs` 拒字符串。
 */
const RECONCILE_INTERVAL_INJECT = 3000;
/** ⑨ 的还原**知基线值**（= stack 种子 = 代码缺省 1h；还原不写「现值」）。 */
const RECONCILE_INTERVAL_RESTORE = 3_600_000;

/**
 * 本 run 的动作号后缀（照 slice-15 的 per-run 后缀纪律：同栈「先单跑、后全序」跑两遍，
 * 固定 actionId 会让「首发 ⇒ replayed=false」在第二遍变成幂等命中（假红）。
 * 字符集 ⊆ [0-9A-Z]，进 SQL 字面量与 actionId 形状都安全）。
 */
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-4);
const AID = (s: string): string => `s17-${RUN_TAG}-${s}`;

/** 固定测试 ownerId（全部以 `s17` 开头 ⇒ 清理谓词 `LIKE 's17%'` 一次收干净）。 */
const OWNER_C4 = 's17c4';
const OWNER_C6A = 's17c6a';
const OWNER_C6B = 's17c6b';
const OWNER_NEG_NS = 's17negns';
const OWNER_C7 = 's17c7';
const OWNER_GHOST = 's17ghost';
const OWNER_ORPHAN = 's17orphan';

/** ④b 并发 burst 的参数（初值 1000、单笔 -150 ⇒ 串行条件下恰 6 成功 / 4 个 14001）。 */
const BURST_N = 10;
const BURST_INIT = 1000;
const BURST_STEP = 150;

// ────────────────────────────────────────────────────────────────────────────
// docker / mysql 助手（形态先例见文件头）
// ────────────────────────────────────────────────────────────────────────────

/** `compose()` 的返回：退出码 + stdout/stderr 合流（失败断言里带上尾部，结论才看得见原因）。 */
interface CommandResult {
  code: number;
  out: string;
}

/** `docker compose …`（照 slice-15 / slice-14 的 spawnSync 手型，逐字同参）。 */
function compose(extraEnv: Record<string, string>, ...args: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // 日志超 spawnSync 默认上限（1MiB）会以 ENOBUFS 失败 ⇒ status=null ⇒ 看起来像「compose 退 1」的误导性红。
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
    env: { ...process.env, ...extraEnv },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
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

/**
 * MySQL 查询（`-N` = 不带列名表头）。⚠️ SQL 里**只许**单引号字符串字面量与数字
 * （整段进 sh 的双引号参数，禁 `$` / 反引号 / 双引号——会改变 sh 语义；照 slice-15）。
 * 表名/列名都是简单标识符，**不用反引号**。
 * ⚠️ `--default-character-set=utf8mb4` 不能省：客户端在无 locale 的容器里默认会把
 * 不可映射字符转成 `?`（本片要读回中文 reason 做 audit 断言——首跑实测：不带它读到
 * `slice17 ???`，判据假红的风险方向反着来也一样危险）。
 */
function mysqlQuery(sql: string): CommandResult {
  return exec(
    'mysql',
    'sh',
    '-c',
    `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE" -N -e "${sql}"`,
  );
}

/** 查询返回**单个整数**；形态异常当场抛（不让空串伪装成 0）。 */
function mysqlCount(sql: string): number {
  const r = mysqlQuery(sql);
  if (r.code !== 0) throw new ConformanceError(`mysql 查询失败（exit ${r.code}）：${tailOut(r.out)}`);
  const numeric = r.out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^-?\d+$/.test(s));
  const last = numeric[numeric.length - 1];
  if (last === undefined) {
    throw new ConformanceError(`mysql 读数不是整数（原文尾部：${tailOut(r.out)}）`);
  }
  return Number(last);
}

/** 查询返回**末行文本**（列名/许可串一类的串读数；剥掉 mysql 的密码告警行）。 */
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

/** 执行一条写语句（DELETE/UPDATE/INSERT）；非 0 退出码抛。 */
function mysqlExec(sql: string): void {
  const r = mysqlQuery(sql);
  if (r.code !== 0) throw new ConformanceError(`mysql 写语句失败（exit ${r.code}）：${tailOut(r.out)}`);
}

/** 某服务最近的容器日志（照 slice-12 / slice-15；`--no-color` 必须有：ANSI 会让「找那一行」恒假）。 */
function composeLogs(service: string, sinceSeconds: number): string {
  const r = spawnSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, service],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 一行日志里抽出 NDJSON 记录（前缀 `ftl-x | ` 与非 JSON 行一律返回 null）。 */
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

/** user-service 的「配置快照已应用」日志里 `version=V` 的行数（缓存刷新的**计数**读数）。 */
function snapshotVersionCount(version: number): number {
  return ndjson('user-service', 900).filter((r) => {
    const msg = String(r.msg);
    return msg.includes('config snapshot applied') && new RegExp(`version=${version}\\b`).test(msg);
  }).length;
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

/** 等容器 healthy（`docker inspect … {{.State.Health.Status}}`；照 slice-14）。 */
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

/** `/metrics` 的 exec 入口（照 slice-16）：返回 HTTP 状态码 + body（curl `-w` 哨兵行拆开）。 */
function execCurl(container: string, port: number, path = '/metrics', token: string | null = null): { status: number; body: string } {
  const args = ['exec', container, 'curl', '-s', '-w', '\n__STATUS__%{http_code}'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push(`http://127.0.0.1:${port}${path}`);
  const r = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  const out = String(r.stdout ?? '');
  const m = /__STATUS__(\d+)\s*$/.exec(out);
  return { status: m ? Number(m[1]) : 0, body: out.replace(/__STATUS__\d+\s*$/, '') };
}

/** 读 currency-service 的 `/metrics` 全文（带真 token——dev 栈守卫口令与 conformance 同源）。 */
function readCurrencyMetrics(): string {
  return execCurl('ftl-currency-service', 9004, '/metrics', INTERNAL_TOKEN).body;
}

// ── Prom 文本解析（照 slice-16；判定面只用 sum / 精确标签匹配两个读法）────────

interface PromSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseProm(text: string): PromSeries[] {
  const out: PromSeries[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const kv = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"(.*)"\s*$/.exec(part);
        if (kv) labels[kv[1]!] = kv[2]!;
      }
    }
    const value = Number(m[3]);
    out.push({ name: m[1]!, labels, value: Number.isFinite(value) ? value : NaN });
  }
  return out;
}

/** 某指标全部序列的值求和（无标签 gauge/counter 与多序列 counter 都适用；缺席 = 0）。 */
function sumMetric(text: string, name: string): number {
  return parseProm(text)
    .filter((s) => s.name === name)
    .reduce((acc, s) => acc + (Number.isFinite(s.value) ? s.value : 0), 0);
}

/** 某指标**恰好匹配这些标签**的序列值（缺席返回 `null` —— 与「值是 0」分开，别混）。 */
function seriesValue(text: string, name: string, want: Record<string, string>): number | null {
  for (const s of parseProm(text)) {
    if (s.name !== name) continue;
    const hit = Object.entries(want).every(([k, v]) => s.labels[k] === v);
    if (hit) return s.value;
  }
  return null;
}

// ── Redis 键清源（lib/redis 的 raw 助手；--scan 只读、DEL 是构造面）────────────

function scanRedisKeys(pattern: string): string[] {
  const reply = redisRaw(['--scan', '--pattern', pattern]);
  if (reply.status !== 0) {
    throw new ConformanceError(`redis-cli --scan 失败（退出码 ${reply.status}）：${redisReplyText(reply) || '（无输出）'}`);
  }
  return reply.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// ────────────────────────────────────────────────────────────────────────────
// 造数 / 判定助手
// ────────────────────────────────────────────────────────────────────────────

const rpcApply = (req: CurrencyApplyRequest, timeoutMs = 8_000): Promise<RpcResult<CurrencyApplyData>> =>
  rpcCall<CurrencyApplyData>(CURRENCY_RPC, RPC_PATTERNS.currencyApply, req, timeoutMs);
const rpcGet = (ownerIds: string[], timeoutMs = 5_000): Promise<RpcResult<CurrencyGetData>> =>
  rpcCall<CurrencyGetData>(CURRENCY_RPC, RPC_PATTERNS.currencyGet, { ownerIds }, timeoutMs);

/** 直投 apply 并断言 `ok:true`（失败抛，带原始读数）；返回 data 供后续逐字段断言。 */
function expectApplyOk(res: RpcResult<CurrencyApplyData>, what: string): CurrencyApplyData {
  if (!res.ok) {
    throw new ConformanceError(`${what}：期望 ok:true，实际 {ok:false, code=${res.code}, message=${res.message}}`);
  }
  return res.data;
}

/** 直投 apply 并断言 `ok:false` + 指定码（失败抛，带原始读数）；返回 message 供包含断言。 */
function expectApplyReject(res: RpcResult<CurrencyApplyData>, code: ErrCode, what: string): string {
  if (res.ok) {
    throw new ConformanceError(`${what}：期望 {ok:false, code=${code}}，实际 ok:true（data=${JSON.stringify(res.data)}）`);
  }
  if (res.code !== code) {
    throw new ConformanceError(`${what}：期望 code=${code}，实际 code=${res.code}（message=${res.message}）`);
  }
  return res.message;
}

/** 单条 admin_adjust 直投载荷（批量造数用；actor/reason 必填已满足）。 */
function adminAdjustReq(actionId: string, ownerId: string, delta: number, reason: string): CurrencyApplyRequest {
  return { actionId, source: 'admin_adjust', actor: 'admin', reason, entries: [{ ownerId, delta }] };
}

const accountsCount = (ownerId: string): number =>
  mysqlCount(`SELECT COUNT(*) FROM currency_accounts WHERE owner_id='${ownerId}'`);
const balanceOf = (ownerId: string): number =>
  mysqlCount(`SELECT balance FROM currency_accounts WHERE owner_id='${ownerId}'`);
const opsCountByAction = (actionId: string): number =>
  mysqlCount(`SELECT COUNT(*) FROM currency_ops WHERE action_id='${actionId}'`);
const flowsCountByOwner = (ownerId: string): number =>
  mysqlCount(`SELECT COUNT(*) FROM currency_flows WHERE owner_id='${ownerId}'`);
const flowsCountByOp = (opId: number): number =>
  mysqlCount(`SELECT COUNT(*) FROM currency_flows WHERE op_id=${opId}`);

// ────────────────────────────────────────────────────────────────────────────
// 测试行 / 键 清源（前置 + 收尾 + finally 兜底共用）
// ────────────────────────────────────────────────────────────────────────────

/** `IN` 列表（全部是 [a-z0-9-] 形态；进单引号字面量安全）。 */
function sqlInList(ids: readonly string[]): string {
  return ids.map((id) => `'${id}'`).join(',');
}

/**
 * 删本片命名的库行：固定前缀 `s17*` + 本 run 注册的 harness 用户（userId 登录时才知道，
 * 调用方收集传入）。顺序 flows → ops → accounts（无外键，但语义上先删子行）。
 */
function deleteTestRows(harnessOwners: readonly string[]): void {
  const flowExtra = harnessOwners.length > 0 ? ` OR owner_id IN (${sqlInList(harnessOwners)})` : '';
  const opExtra = harnessOwners.length > 0 ? ` OR action_id IN (${sqlInList(harnessOwners.map((id) => `signup:${id}`))})` : '';
  const accountExtra = flowExtra;
  mysqlExec(`DELETE FROM currency_flows WHERE owner_id LIKE 's17%'${flowExtra}`);
  mysqlExec(`DELETE FROM currency_ops WHERE action_id LIKE 's17-%'${opExtra}`);
  mysqlExec(`DELETE FROM currency_accounts WHERE owner_id LIKE 's17%'${accountExtra}`);
}

/** 删本片命名的缓存键：`s17*` 前缀扫描 + 本 run 的 harness 用户逐 id（不碰别人的键）。 */
function deleteTestKeys(harnessOwners: readonly string[]): void {
  for (const key of scanRedisKeys('currency:balance:s17*')) {
    redisRaw(['DEL', key]);
  }
  for (const id of harnessOwners) {
    redisRaw(['DEL', `currency:balance:${id}`]);
  }
}

/**
 * 管理面 PUT 一键 + **等缓存刷新**（观测 = `config snapshot applied (version=…)` 行**计数**）。
 *
 * 版本算术：全局 version = 每键 MAX；本键 PUT 后 = kv0+1 ⇒ 快照行的 version = max(gv0, kv0+1)。
 * 基线计数在 PUT **之前**读（同一 version 的既有行通常为 0；安全网轮也会打同版本行 ⇒ 只认增量）。
 * 返回 `{putCode, refreshOk, observed, baseline}` 由调用方断言（不用异常顶掉结论）。
 */
async function putConfigAndWaitRefresh(
  admin: string,
  key: string,
  value: number,
): Promise<{ putCode: number | undefined; refreshOk: boolean; observed: number; baseline: number; expected: number }> {
  interface AdminConfigData {
    config: Record<string, { value: unknown; version: number }>;
    version: number;
  }
  const before = await adminGetConfig<AdminConfigData>(admin);
  const gv0 = before.body?.data?.version ?? 0;
  const kv0 = before.body?.data?.config?.[key]?.version ?? 0;
  const expected = Math.max(gv0, kv0 + 1);
  const baseline = snapshotVersionCount(expected);
  const put = await adminPutConfig(key, value, admin);
  const refresh = await pollUntil(() => snapshotVersionCount(expected), (n) => n > baseline, 30_000);
  return { putCode: put.body?.code, refreshOk: refresh.ok, observed: refresh.last, baseline, expected };
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
 * ⚠️ 还原调用一律传**知基线值**（`RECONCILE_INTERVAL_RESTORE`），不写「现值」。
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

// ────────────────────────────────────────────────────────────────────────────
// ⑩ prometheus / ⑪ 门口静态页 的小工具
// ────────────────────────────────────────────────────────────────────────────

async function httpText(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return { status: res.status, text: await res.text() };
}

interface TargetSnapshot {
  job: string;
  health: string;
}

async function fetchTargets(): Promise<TargetSnapshot[]> {
  try {
    const r = await httpText(`${PROM_URL}/api/v1/targets`);
    const parsed = JSON.parse(r.text) as { data?: { activeTargets?: Array<{ labels?: { job?: string }; health?: string }> } };
    return (parsed.data?.activeTargets ?? []).map((t) => ({ job: t.labels?.job ?? '', health: t.health ?? '' }));
  } catch {
    return [];
  }
}

/** 单跳（http 或 https；https 自签 ⇒ 不校验证书；照 slice-14 C20）。 */
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
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve_({ status: res.statusCode ?? 0, location: String(res.headers.location ?? ''), body }));
    };
    const req = url.protocol === 'https:' ? https.request(options, onRes) : http.request(options, onRes);
    req.on('error', reject);
    req.end();
  });
}

/** 从门口 HTTP 口起跳、逐跳跟随重定向（≤6 跳）；跳转链原样带回（301 形态可见）。 */
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
  throw new ConformanceError(`⑪ C12：重定向超过 6 跳仍未落定（链：${chain.join(' | ')}）`);
}

// ────────────────────────────────────────────────────────────────────────────
// 主体
// ────────────────────────────────────────────────────────────────────────────

export async function runSlice17(): Promise<Checks> {
  const checks = new Checks();
  // 起手自证：管理面口令与栈一致（不一致时整片从第一行就响亮失败，而不是退化成几十条误导性红）。
  const admin = await adminLogin();
  // 本 run 注册的 harness 用户（清源用；注册点随手收集）。
  const harnessOwners: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════════
    // ① 前置：容器 healthy + 测试行/键清源 + signupGrant 落回 0
    // ══════════════════════════════════════════════════════════════════════
    step('① 前置：currency-service healthy；`s17*` 测试行/键清源；config `currency.signupGrant` 落回 0（等缓存刷新）');
    const c0Health = await waitContainerHealthy('ftl-currency-service');
    checks.that(c0Health.ok, `① 前置：ftl-currency-service healthy —— 实际 ${c0Health.last}`);
    deleteTestRows(harnessOwners);
    deleteTestKeys(harnessOwners);
    checks.eq(mysqlCount(`SELECT COUNT(*) FROM currency_flows WHERE owner_id LIKE 's17%'`), 0, '① 前置：s17* 流水行清零（含前次中断残留）');
    checks.eq(mysqlCount(`SELECT COUNT(*) FROM currency_ops WHERE action_id LIKE 's17-%'`), 0, '① 前置：s17-* 操作行清零');
    checks.eq(mysqlCount(`SELECT COUNT(*) FROM currency_accounts WHERE owner_id LIKE 's17%'`), 0, '① 前置：s17* 账户行清零');
    checks.eq(scanRedisKeys('currency:balance:s17*').length, 0, '① 前置：s17* 缓存键清零');
    const c0Grant = await putConfigAndWaitRefresh(admin, SIGNUP_GRANT_KEY, GRANT_OFF);
    checks.eq(c0Grant.putCode, ErrCode.OK, `① 前置：PUT ${SIGNUP_GRANT_KEY}=0 ⇒ code 0`);
    checks.that(
      c0Grant.refreshOk,
      `① 前置：user-service ≤30s 刷新到 version=${c0Grant.expected}（行数 ${c0Grant.baseline} ⇒ ${c0Grant.observed}；后组「新用户余额=0」的确定前提）`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // ② C1：exec 探针（健康豁免正/负 + 9004 两向）+ 3104 RPC 直投
    // ══════════════════════════════════════════════════════════════════════
    step('② C1：/api/health 与 /api/health/live 200（token 豁免面精确）、/api/healthz 401（负对照）、9004 无 Bearer 401 / 带 Bearer 200、3104 直投可通');
    const c1Health = execCurl('ftl-currency-service', 3004, '/api/health', null);
    checks.eq(c1Health.status, 200, '② C1：容器内 GET /api/health ⇒ 200（豁免免内部 token）');
    const c1Live = execCurl('ftl-currency-service', 3004, '/api/health/live', null);
    checks.eq(c1Live.status, 200, '② C1：容器内 GET /api/health/live ⇒ 200');
    const c1Healthz = execCurl('ftl-currency-service', 3004, '/api/healthz', null);
    checks.eq(c1Healthz.status, 401, '② C1 负对照：/api/healthz ⇒ 401（豁免面是**精确两路径**，不是前缀）');
    const c1MetricsNoAuth = execCurl('ftl-currency-service', 9004, '/metrics', null);
    checks.eq(c1MetricsNoAuth.status, 401, '② C1：9004 /metrics 无 Bearer ⇒ 401');
    const c1MetricsAuth = execCurl('ftl-currency-service', 9004, '/metrics', INTERNAL_TOKEN);
    checks.eq(c1MetricsAuth.status, 200, '② C1：9004 /metrics 带 Bearer ⇒ 200');
    checks.that(
      c1MetricsAuth.body.includes('http_requests_total'),
      '② C1：9004 /metrics 含 http_requests_total（真指标，不是空壳 200）',
    );
    const c1Rpc = await rpcGet([OWNER_GHOST]);
    checks.that(
      c1Rpc.ok,
      `② C1：3104 直投 currency.get 可通（信封 ok:true）—— 实际 ${JSON.stringify(c1Rpc)}`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // ③ C2：三表逐列（列名+类型完整串）/逐索引 + migrations_currency 行
    // ══════════════════════════════════════════════════════════════════════
    step('③ C2：`compose exec mysql` 三表逐列（列名+类型完整串）/逐索引/`migrations_currency` 恰 2 行');
    checks.eq(
      mysqlCount(
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('currency_accounts','currency_ops','currency_flows')`,
      ),
      3,
      '③ C2：三表存在（accounts/ops/flows）',
    );
    checks.eq(
      mysqlText(
        `SELECT GROUP_CONCAT(CONCAT(column_name,':',column_type) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='currency_accounts'`,
      ),
      'owner_id:varchar(36),owner_type:varchar(8),balance:int,updated_at:datetime(3)',
      '③ C2：currency_accounts 逐列名+类型（§2.10 逐字）',
    );
    checks.eq(
      mysqlText(
        `SELECT GROUP_CONCAT(CONCAT(column_name,':',column_type) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='currency_ops'`,
      ),
      'id:bigint,action_id:varchar(128),request_hash:char(64),source:varchar(32),actor:varchar(64),reason:varchar(255),ref_id:varchar(128),trace_id:varchar(64),created_at:datetime(3),burned_residue:int,burned_rake:int,game_type:varchar(16)',
      '③ C2：currency_ops 逐列名+类型（§2.10 逐字；burn 两列 + A2 game_type 尾追）',
    );
    checks.eq(
      mysqlText(
        `SELECT GROUP_CONCAT(CONCAT(column_name,':',column_type) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='currency_flows'`,
      ),
      'id:bigint,op_id:bigint,owner_id:varchar(36),owner_type:varchar(8),delta:int,balance_after:int,created_at:datetime(3)',
      '③ C2：currency_flows 逐列名+类型（§2.10 逐字）',
    );
    checks.eq(
      mysqlCount(
        `SELECT non_unique FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='currency_ops' AND index_name='uk_action_id'`,
      ),
      0,
      '③ C2：uk_action_id 存在且 UNIQUE（non_unique=0 —— 幂等锚的最终硬闸）',
    );
    checks.eq(
      mysqlText(
        `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='currency_flows' AND index_name='idx_flow_owner'`,
      ),
      'owner_id,id',
      '③ C2：idx_flow_owner = (owner_id,id) 复合索引',
    );
    checks.eq(
      mysqlText(
        `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='currency_flows' AND index_name='idx_flow_op'`,
      ),
      'op_id',
      '③ C2：idx_flow_op = (op_id)',
    );
    checks.eq(
      mysqlText(
        `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='currency_ops' AND index_name='idx_ops_source_created'`,
      ),
      'source,created_at',
      '③ C2：idx_ops_source_created = (source,created_at) 复合索引（本片）',
    );
    checks.eq(
      mysqlText(
        `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='currency_ops' AND index_name='idx_ops_game_created'`,
      ),
      'game_type,created_at',
      '③ C2：idx_ops_game_created = (game_type,created_at)（A2）',
    );
    checks.eq(mysqlCount(`SELECT COUNT(*) FROM migrations_currency`), 8, '③ C2：migrations_currency 恰 8 行（AgentDomain 迁移 +1；真库读过）');
    checks.eq(
      mysqlText(`SELECT GROUP_CONCAT(name ORDER BY id) FROM migrations_currency`),
      'Currency1789600000000,BurnOnOp1792022400000,EntryFeeSkips1792108800000,CardCounterEntitlements1795900000000,GameTypeOnOpsDdl1797000000000,GameTypeOnOpsBackfill1797000000001,EntryFeeSkipsGameType1797000000002,AgentDomain1798000000000',
      '③ C2：八行 = 既有四行 + A2 三条 + 代理 AgentDomain（顺序=执行序）',
    );

    // ══════════════════════════════════════════════════════════════════════
    // ④ apply 四组：正常入账 / 重放同 id / 冲突 14002 / 不足 14001 + 多账户原子
    // ══════════════════════════════════════════════════════════════════════
    step(`④ C4：单笔入账 +250（owner=${OWNER_C4}）⇒ 建行；逐字重放 ⇒ replayed:true 同 opId/同余额、行数不变`);
    const c4Req = adminAdjustReq(AID('c4'), OWNER_C4, 250, 'slice17 C4');
    const c4First = expectApplyOk(await rpcApply(c4Req), 'C4① 首发');
    checks.eq(c4First.replayed, false, 'C4① 首发 replayed=false（真写，不是幂等命中）');
    checks.eq(c4First.actionId, c4Req.actionId, 'C4① actionId 原样回显');
    checks.that(c4First.opId > 0, `C4① opId>0 —— 实际 ${c4First.opId}`);
    checks.eq(
      JSON.stringify(c4First.entries),
      JSON.stringify([{ ownerId: OWNER_C4, balanceAfter: 250 }]),
      'C4① entries=[{s17c4, balanceAfter:250}]（单条、快照=新值）',
    );
    checks.eq(opsCountByAction(c4Req.actionId), 1, 'C4① 库中 ops 恰 1 行（uk_action_id）');
    checks.eq(flowsCountByOwner(OWNER_C4), 1, 'C4① 库中 flows 恰 1 行');
    checks.eq(balanceOf(OWNER_C4), 250, 'C4① 库中余额 = 250');

    const c4Replay = expectApplyOk(await rpcApply(c4Req), 'C4② 逐字重放');
    checks.eq(c4Replay.replayed, true, 'C4② 重放 replayed=true');
    checks.eq(c4Replay.opId, c4First.opId, 'C4② 重放 opId 与首发一致');
    checks.eq(
      JSON.stringify(c4Replay.entries),
      JSON.stringify(c4First.entries),
      'C4② 重放 entries 与首发逐字一致（历史快照重建）',
    );
    checks.eq(opsCountByAction(c4Req.actionId), 1, 'C4② 重放不新增 ops 行（仍 1）');
    checks.eq(flowsCountByOwner(OWNER_C4), 1, 'C4② 重放不重复入账（flows 仍 1）');
    checks.eq(balanceOf(OWNER_C4), 250, 'C4② 重放后余额不变（250）');

    step('④ C5：同 actionId 异载荷（delta 250→300）⇒ 14002；库行数与余额不变；error 日志含 actionId');
    const c5Conflict = await rpcApply(adminAdjustReq(c4Req.actionId, OWNER_C4, 300, 'slice17 C4'));
    const c5Msg = expectApplyReject(c5Conflict, ErrCode.E_ACTION_CONFLICT, 'C5 同 id 异载荷');
    checks.that(c5Msg.length > 0, `C5 14002 带非空 message —— 实际 ${JSON.stringify(c5Msg)}`);
    checks.eq(opsCountByAction(c4Req.actionId), 1, 'C5 库 ops 行数不变（仍 1）');
    checks.eq(flowsCountByOwner(OWNER_C4), 1, 'C5 库 flows 行数不变（仍 1）');
    checks.eq(balanceOf(OWNER_C4), 250, 'C5 余额不变（250）');
    const c5Log = await pollUntil(
      () => ndjson('currency-service', 300).filter((r) => String(r.msg).includes(`actionId=${c4Req.actionId}`) && String(r.msg).includes('14002')),
      (lines) => lines.length > 0,
      15_000,
    );
    checks.that(c5Log.ok, `C5 error 日志含 actionId=${c4Req.actionId} 与 14002（15s 内）`);
    checks.eq(c5Log.last[0]?.level, 'error', 'C5 该行是 error 级（「同 id 不同内容」永远响亮）');

    step('④ C6：多账户批原子（同 op_id 多行）⇒ 不足整批回滚（批内其他账户零变化 + 不产垃圾行 + ops 行也回滚）');
    const c6Req: CurrencyApplyRequest = {
      actionId: AID('c6ok'),
      source: 'admin_adjust',
      actor: 'admin',
      reason: 'slice17 C6 批量',
      entries: [
        { ownerId: OWNER_C6B, delta: 30 },
        { ownerId: OWNER_C6A, delta: 10 },
      ],
    };
    const c6Ok = expectApplyOk(await rpcApply(c6Req), 'C6① 多账户批');
    checks.eq(
      JSON.stringify(c6Ok.entries),
      JSON.stringify([
        { ownerId: OWNER_C6A, balanceAfter: 10 },
        { ownerId: OWNER_C6B, balanceAfter: 30 },
      ]),
      'C6① entries 按 ownerId 升序（乱序请求 ⇒ 升序执行/回包）',
    );
    checks.eq(flowsCountByOp(c6Ok.opId), 2, 'C6① 同一 op_id 恰 2 行 flows（整批一个操作）');
    const c6RbReq: CurrencyApplyRequest = {
      actionId: AID('c6rb'),
      source: 'admin_adjust',
      actor: 'admin',
      reason: 'slice17 C6 回滚',
      entries: [
        { ownerId: OWNER_C6A, delta: 5 },
        { ownerId: OWNER_NEG_NS, delta: -5 },
      ],
    };
    const c6Rb = await rpcApply(c6RbReq);
    const c6RbMsg = expectApplyReject(c6Rb, ErrCode.E_INSUFFICIENT_FUNDS, 'C6② 不足整批回滚');
    checks.that(c6RbMsg.includes(OWNER_NEG_NS), `C6② 14001 message 指向不足账户 ${OWNER_NEG_NS} —— 实际 ${JSON.stringify(c6RbMsg)}`);
    checks.eq(balanceOf(OWNER_C6A), 10, 'C6② 批内先成功的账户也回滚（仍 10 —— 整批原子）');
    checks.eq(accountsCount(OWNER_NEG_NS), 0, 'C6② 不足账户不留垃圾行（INSERT IGNORE 也被回滚）');
    checks.eq(opsCountByAction(c6RbReq.actionId), 0, 'C6② 撞业务的 ops 行一并回滚（0 行）');

    // ══════════════════════════════════════════════════════════════════════
    // ④b C7 并发 burst（真栈主载体）：并行 N 扣减 ⇒ 终值不变量 + 全程无负
    // ══════════════════════════════════════════════════════════════════════
    step(`④b C7：真栈并行 ${BURST_N} 笔 -${BURST_STEP} 直投 ×（初值 ${BURST_INIT}）⇒ 成功恰 ${Math.floor(BURST_INIT / BURST_STEP)} 笔、余额=初值−成功×单额、全程无负`);
    const c7Init = expectApplyOk(
      await rpcApply(adminAdjustReq(AID('c7-init'), OWNER_C7, BURST_INIT, 'slice17 C7 初值')),
      'C7 初值',
    );
    checks.eq(c7Init.entries[0]?.balanceAfter, BURST_INIT, `C7 初值入账 ⇒ 余额 ${BURST_INIT}`);
    const burstReqs = Array.from({ length: BURST_N }, (_, i) =>
      adminAdjustReq(AID(`c7-${i}`), OWNER_C7, -BURST_STEP, 'slice17 C7 burst'),
    );
    const burstRes = await Promise.all(burstReqs.map((r) => rpcApply(r, 10_000)));
    const burstOk = burstRes.filter((r) => r.ok);
    type ApplyFail = Extract<RpcResult<CurrencyApplyData>, { ok: false }>;
    const burstFail = burstRes.filter((r): r is ApplyFail => !r.ok);
    const expectedOk = Math.floor(BURST_INIT / BURST_STEP);
    checks.eq(burstOk.length, expectedOk, `C7 并发 ${BURST_N} 笔 ⇒ 成功恰 ${expectedOk} 笔（行锁下条件更新逐笔裁决）`);
    checks.that(
      burstFail.every((r) => r.code === ErrCode.E_INSUFFICIENT_FUNDS),
      `C7 全失败笔都是 14001 —— 实际 ${JSON.stringify(burstRes.map((r) => (r.ok ? 'ok' : r.code)))}`,
    );
    const c7Final = balanceOf(OWNER_C7);
    checks.eq(c7Final, BURST_INIT - expectedOk * BURST_STEP, 'C7 终止余额 = 初值 − 成功笔数×单额（不变量）');
    checks.that(c7Final >= 0, `C7 终止余额无负 —— 实际 ${c7Final}`);
    checks.eq(
      mysqlCount(`SELECT MIN(balance_after) FROM currency_flows WHERE owner_id='${OWNER_C7}'`),
      BURST_INIT - expectedOk * BURST_STEP,
      'C7 全程无负：flows 的 min(balance_after) = 终值（逐笔快照都 ≥0）',
    );
    const burstOpMismatch = burstRes
      .map((r, i) => ({ r, id: burstReqs[i]!.actionId }))
      .map(({ r, id }) => ({ id, want: r.ok ? 1 : 0, got: opsCountByAction(id) }))
      .filter(({ want, got }) => want !== got);
    checks.that(
      burstOpMismatch.length === 0,
      `C7 逐笔 ops 行数与结果一致（成功 1 / 失败 0 —— 失败笔的 ops 随事务回滚）` +
        `${burstOpMismatch.length > 0 ? `；违例：${JSON.stringify(burstOpMismatch)}` : ''}`,
    );
    checks.eq(
      mysqlCount(`SELECT COUNT(*) FROM currency_ops WHERE action_id LIKE 's17-${RUN_TAG}-c7%'`),
      1 + expectedOk,
      `C7 库 ops = 1 初值 + ${expectedOk} 成功（失败笔的 ops 随事务回滚）`,
    );
    checks.eq(flowsCountByOwner(OWNER_C7), 1 + expectedOk, `C7 库 flows = 1 + ${expectedOk}`);

    // ══════════════════════════════════════════════════════════════════════
    // ⑤ get 组：同序/重复/exists=false/不建行/读穿写缓存/不写 0
    // ══════════════════════════════════════════════════════════════════════
    step(`⑤ C9：currency.get [${OWNER_C4}, ${OWNER_GHOST}, ${OWNER_C4}] ⇒ 同序一一对应（含重复位）；exists=false ⇒ 0 且不建行不写缓存`);
    const c9Get = await rpcGet([OWNER_C4, OWNER_GHOST, OWNER_C4]);
    if (!c9Get.ok) throw new ConformanceError(`C9 直投 get 期望 ok:true，实际 ${JSON.stringify(c9Get)}`);
    checks.eq(
      JSON.stringify(c9Get.data.balances),
      JSON.stringify([
        { ownerId: OWNER_C4, balance: 250, exists: true },
        { ownerId: OWNER_GHOST, balance: 0, exists: false },
        { ownerId: OWNER_C4, balance: 250, exists: true },
      ]),
      'C9 响应与请求同序一一对应（含重复位；不存在 ⇒ balance:0+exists:false）',
    );
    checks.eq(accountsCount(OWNER_GHOST), 0, 'C9 读路径不建行（ghost 账户行 0）');
    checks.eq(accountsCount(OWNER_C4), 1, 'C9 既有账户行数不变（1）');
    checks.eq(
      redisReplyText(redisRaw(['EXISTS', `currency:balance:${OWNER_C4}`])),
      '1',
      'C9 读穿/写穿：命中账户的缓存键在（值见下）',
    );
    checks.eq(
      redisReplyText(redisRaw(['GET', `currency:balance:${OWNER_C4}`])),
      '250',
      'C9 缓存值 = 十进制串 250（写穿口径）',
    );
    checks.eq(
      redisReplyText(redisRaw(['EXISTS', `currency:balance:${OWNER_GHOST}`])),
      '0',
      'C9 ⚙️15：exists=false **不写缓存**（写 0 会让对账把它判成漂移）',
    );

    // ══════════════════════════════════════════════════════════════════════
    // ⑥ 玩家 REST（经网关）：新用户 0 ⇒ 调整后新值；缺/伪造身份打不进
    // ══════════════════════════════════════════════════════════════════════
    step('⑥ C10：经网关新用户 GET /api/wallet/balance ⇒ 0；管理调整 +500 ⇒ 再查 = 500；缺 token / 伪造 X-User-Id 打不进');
    const userP = await registerUser(40);
    harnessOwners.push(userP.id);
    const c10Zero = await getJson<{ balance: number }>('/api/wallet/balance', userP.accessToken);
    checks.eq(c10Zero.body?.code, ErrCode.OK, 'C10 新用户查余额 code 0');
    checks.eq(c10Zero.body?.data?.balance, 0, 'C10 新用户余额 = 0（grant=0 注册 ⇒ 零货币痕迹的玩家面读数）');
    const c10Adjust = await postJson<{ balanceBefore: number; balanceAfter: number }>(
      '/api/admin/wallet/adjust',
      { userId: userP.id, delta: 500, reason: 'slice17 玩家面', actionId: AID('p500') },
      admin,
    );
    checks.eq(c10Adjust.status, 200, 'C10 管理调整 HTTP 200（POST 成功/重放同码）');
    checks.eq(c10Adjust.body?.code, ErrCode.OK, 'C10 管理调整 code 0');
    checks.eq(c10Adjust.body?.data?.balanceAfter, 500, 'C10 调整后 balanceAfter=500');
    const c10After = await getJson<{ balance: number }>('/api/wallet/balance', userP.accessToken);
    checks.eq(c10After.body?.data?.balance, 500, 'C10 调整后再查 = 500（经网关的新值）');
    const c10NoAuth = await getJson('/api/wallet/balance');
    checks.eq(c10NoAuth.status, 401, 'C10 缺 Authorization ⇒ 401（余额面不在公开白名单）');
    const c10Forged = await getJson<{ balance: number }>('/api/wallet/balance', userP.accessToken, {
      'x-user-id': OWNER_C4,
    });
    checks.eq(c10Forged.status, 200, 'C10 带伪造 X-User-Id 的合法请求仍 200（网关注入自己的身份，不构成拒绝）');
    checks.eq(
      c10Forged.body?.data?.balance,
      500,
      `C10 伪造 X-User-Id=${OWNER_C4}（余额 250）**打不进**：读回的还是本人 500（网关边缘剥伪造头后按验签身份注入）`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // ⑦ 管理 REST 组：adjust + 重放同 opId + accounts（≤20 倒序 JOIN ops）+ lookup
    // ══════════════════════════════════════════════════════════════════════
    step('⑦ C11：管理 adjust（audit 落 ops）+ 同 actionId 重发同 opId；accounts 直读/≤20 条倒序；lookup 命中/404/400；非管理令牌 401');
    const userR = await registerUser(41);
    harnessOwners.push(userR.id);
    const c11Adjust = await postJson<{ balanceBefore: number; balanceAfter: number; opId: number }>(
      '/api/admin/wallet/adjust',
      { userId: userR.id, delta: 500, reason: 'slice17 管理面', actionId: AID('adm1') },
      admin,
    );
    checks.eq(c11Adjust.body?.code, ErrCode.OK, 'C11 adjust code 0');
    checks.eq(
      JSON.stringify([c11Adjust.body?.data?.balanceBefore, c11Adjust.body?.data?.balanceAfter]),
      JSON.stringify([0, 500]),
      'C11 adjust 返回 {balanceBefore:0, balanceAfter:500}',
    );
    checks.that((c11Adjust.body?.data?.opId ?? 0) > 0, `C11 adjust 返回 opId>0 —— 实际 ${c11Adjust.body?.data?.opId}`);
    checks.eq(
      mysqlText(`SELECT actor FROM currency_ops WHERE action_id='${AID('adm1')}'`),
      'admin',
      'C11 audit：ops.actor=admin（管理面留痕）',
    );
    checks.eq(
      mysqlText(`SELECT reason FROM currency_ops WHERE action_id='${AID('adm1')}'`),
      'slice17 管理面',
      'C11 audit：ops.reason=提交词条',
    );
    const c11Replay = await postJson<{ balanceBefore: number; balanceAfter: number; opId: number }>(
      '/api/admin/wallet/adjust',
      { userId: userR.id, delta: 500, reason: 'slice17 管理面', actionId: AID('adm1') },
      admin,
    );
    checks.eq(c11Replay.body?.code, ErrCode.OK, 'C11 同 actionId 同载荷重发 code 0（200 重放，不是 409）');
    checks.eq(c11Replay.status, 200, 'C11 重放 HTTP 200');
    checks.eq(c11Replay.body?.data?.opId, c11Adjust.body?.data?.opId, 'C11 重放同 opId（不重复发放）');
    checks.eq(c11Replay.body?.data?.balanceAfter, 500, 'C11 重放重建 balanceAfter=500（自 flows 历史快照）');
    checks.eq(flowsCountByOp(c11Adjust.body!.data!.opId!), 1, 'C11 重放不新增 flows 行（仍 1）');

    step(`⑦ accounts：RPC 直投**顺序**再造 22 条流水（管理写桶 30/5min —— 23 次 REST 调整会爆桶；判据对象是 accounts 读面。顺序直投而非并发：flow id 序 = 下组「最新 20 条」断言的确定前提）`);
    const c11Extra: Array<RpcResult<CurrencyApplyData>> = [];
    for (let i = 1; i <= 22; i++) {
      c11Extra.push(await rpcApply(adminAdjustReq(AID(`adm-r${i}`), userR.id, i, `slice17 管理面 r${i}`), 8_000));
    }
    checks.that(
      c11Extra.every((r) => r.ok),
      `C11 22 笔 +1..+22 直投全部 ok —— 实际失败 ${JSON.stringify(c11Extra.filter((r) => !r.ok))}`,
    );
    const c11Accounts = await getJson<{
      balance: number;
      recentFlows: Array<{ delta: number; balanceAfter: number; source: string; reason: string | null; createdAt: number }>;
    }>(`/api/admin/wallet/accounts/${userR.id}`, admin);
    checks.eq(c11Accounts.body?.code, ErrCode.OK, 'C11 accounts code 0');
    checks.eq(c11Accounts.body?.data?.balance, 753, 'C11 accounts 余额 = 500 + (1+..+22) = 753（MySQL 直读）');
    const rf = c11Accounts.body?.data?.recentFlows ?? [];
    checks.eq(rf.length, 20, 'C11 recentFlows 恰 20 条（≤20 上限：23 条流水里取最新 20）');
    checks.eq(
      JSON.stringify([rf[0]?.delta, rf[0]?.balanceAfter]),
      JSON.stringify([22, 753]),
      'C11 recentFlows[0] = 最新一笔（delta 22、balanceAfter 753 —— id DESC 新→旧）',
    );
    checks.eq(
      JSON.stringify([rf[19]?.delta, rf[19]?.balanceAfter]),
      JSON.stringify([3, 506]),
      'C11 recentFlows[19] = 第 20 新（delta 3、balanceAfter 506 —— 旧的一头被截掉的是更早的）',
    );
    checks.eq(rf[0]?.source, 'admin_adjust', 'C11 recentFlows 带 JOIN ops 的 source');
    checks.eq(rf[0]?.reason, 'slice17 管理面 r22', 'C11 recentFlows 带 JOIN ops 的 reason');
    checks.eq(typeof rf[0]?.createdAt, 'number', 'C11 createdAt = epoch ms（number）');

    step('⑦ 错误面：14001⇒409、14002⇒409、未开户空态 200、lookup 命中/404/400、非管理令牌 401');
    const c11Insufficient = await postJson('/api/admin/wallet/adjust', {
      userId: userR.id,
      delta: -1_000_000,
      reason: 'slice17 扣过头',
      actionId: AID('adm-over'),
    }, admin);
    checks.eq(c11Insufficient.status, 409, 'C11 余额不足 ⇒ HTTP 409（映射表收口，非 500）');
    checks.eq(c11Insufficient.body?.code, ErrCode.E_INSUFFICIENT_FUNDS, 'C11 余额不足 ⇒ code 14001');
    checks.eq(balanceOf(userR.id), 753, 'C11 14001 后余额不变（753 —— 整批回滚）');
    const c11Conflict = await postJson('/api/admin/wallet/adjust', {
      userId: userR.id,
      delta: 501,
      reason: 'slice17 管理面',
      actionId: AID('adm1'),
    }, admin);
    checks.eq(c11Conflict.status, 409, 'C11 同 actionId 异载荷 ⇒ HTTP 409');
    checks.eq(c11Conflict.body?.code, ErrCode.E_ACTION_CONFLICT, 'C11 同 actionId 异载荷 ⇒ code 14002');
    checks.eq(balanceOf(userR.id), 753, 'C11 14002 后余额不变（753）');
    const c11Empty = await getJson<{ balance: number; recentFlows: unknown[] }>(
      `/api/admin/wallet/accounts/${OWNER_GHOST}`,
      admin,
    );
    checks.eq(c11Empty.status, 200, 'C11 未开户 accounts ⇒ HTTP 200（「未开户」是合法态，非 404）');
    checks.eq(
      JSON.stringify([c11Empty.body?.data?.balance, c11Empty.body?.data?.recentFlows]),
      JSON.stringify([0, []]),
      'C11 未开户空态 = {balance:0, recentFlows:[]}',
    );
    const c11Lookup = await getJson<{ userId: string }>(`/api/admin/users/lookup?phone=${userR.phone}`, admin);
    checks.eq(c11Lookup.body?.code, ErrCode.OK, 'C11 lookup 命中 code 0');
    checks.eq(c11Lookup.body?.data?.userId, userR.id, 'C11 lookup 返回的 userId = 注册用户 id');
    const c11LookupMiss = await getJson('/api/admin/users/lookup?phone=13000000000', admin);
    checks.eq(c11LookupMiss.status, 404, 'C11 lookup 未找到 ⇒ HTTP 404');
    checks.eq(c11LookupMiss.body?.code, ErrCode.USER_NOT_FOUND, 'C11 lookup 未找到 ⇒ code 11004');
    const c11LookupBad = await getJson('/api/admin/users/lookup', admin);
    checks.eq(c11LookupBad.status, 400, 'C11 lookup 缺 phone ⇒ HTTP 400');
    checks.eq(c11LookupBad.body?.code, ErrCode.BAD_PARAM, 'C11 lookup 缺 phone ⇒ code 10001');
    const c11Guard = await postJson('/api/admin/wallet/adjust', {
      userId: userR.id,
      delta: 1,
      reason: 'slice17 守卫',
    }, userP.accessToken);
    checks.eq(c11Guard.status, 401, 'C11 玩家令牌打管理面 ⇒ 401（XAdminGuard/管理中间件 fail-closed）');

    // ══════════════════════════════════════════════════════════════════════
    // ⑧ 注册赠送两态：grant=777 ⇒ 到账 + ops 1 行；回 0 ⇒ 新注册按 userId 零痕迹、旧户不变
    // ══════════════════════════════════════════════════════════════════════
    step(`⑧ C13：PUT ${SIGNUP_GRANT_KEY}=777（等缓存刷新）⇒ 注册即到账；signup:<id> 重放不重复；PUT 回 0 ⇒ 新注册零痕迹（按 userId）`);
    const c13On = await putConfigAndWaitRefresh(admin, SIGNUP_GRANT_KEY, GRANT_ON);
    checks.eq(c13On.putCode, ErrCode.OK, `⑧ PUT ${SIGNUP_GRANT_KEY}=777 ⇒ code 0`);
    checks.that(
      c13On.refreshOk,
      `⑧ user-service ≤30s 刷新到 version=${c13On.expected}（行数 ${c13On.baseline} ⇒ ${c13On.observed} —— grant 快照已换）`,
    );
    interface AdminConfigData {
      config: Record<string, { value: unknown; version: number }>;
      version: number;
    }
    const c13Readback = await adminGetConfig<AdminConfigData>(admin);
    checks.eq(c13Readback.body?.data?.config?.[SIGNUP_GRANT_KEY]?.value, GRANT_ON, '⑧ 回读库值 = 777（config-service 写面）');
    const userS1 = await registerUser(42);
    harnessOwners.push(userS1.id);
    const c13Bal1 = await getJson<{ balance: number }>('/api/wallet/balance', userS1.accessToken);
    checks.eq(c13Bal1.body?.code, ErrCode.OK, '⑧ grant=777 注册成功且余额可查（code 0）');
    checks.eq(c13Bal1.body?.data?.balance, GRANT_ON, `⑧ 注册后余额 = ${GRANT_ON}（先货币后落库链路）`);
    checks.eq(opsCountByAction(`signup:${userS1.id}`), 1, '⑧ ops 恰 1 行（actionId=signup:<userId>）');
    checks.eq(
      mysqlText(`SELECT source FROM currency_ops WHERE action_id='signup:${userS1.id}'`),
      'signup_grant',
      '⑧ 该 ops 行 source=signup_grant',
    );
    checks.eq(
      mysqlText(`SELECT CONCAT(delta, ':', balance_after) FROM currency_flows WHERE owner_id='${userS1.id}'`),
      `${GRANT_ON}:${GRANT_ON}`,
      '⑧ flows 恰 1 行且 delta=balance_after=777',
    );
    const c13Replay = expectApplyOk(
      await rpcApply({
        actionId: `signup:${userS1.id}`,
        source: 'signup_grant',
        entries: [{ ownerId: userS1.id, delta: GRANT_ON }],
        refId: userS1.id,
      }),
      '⑧ signup:<id> 重放',
    );
    checks.eq(c13Replay.replayed, true, '⑧ signup:<userId> 重放 ⇒ replayed:true（uk_action_id 兜底）');
    checks.eq(c13Replay.entries[0]?.balanceAfter, GRANT_ON, '⑧ 重放 balanceAfter 仍 777（不重复发币）');
    checks.eq(flowsCountByOwner(userS1.id), 1, '⑧ 重放后 flows 仍 1 行');

    const c13Off = await putConfigAndWaitRefresh(admin, SIGNUP_GRANT_KEY, GRANT_OFF);
    checks.eq(c13Off.putCode, ErrCode.OK, `⑧ PUT ${SIGNUP_GRANT_KEY}=0 回 ⇒ code 0`);
    checks.that(
      c13Off.refreshOk,
      `⑧ user-service ≤30s 刷新回 version=${c13Off.expected}（行数 ${c13Off.baseline} ⇒ ${c13Off.observed}）`,
    );
    const userS2 = await registerUser(43);
    harnessOwners.push(userS2.id);
    const c13Bal2 = await getJson<{ balance: number }>('/api/wallet/balance', userS2.accessToken);
    checks.eq(c13Bal2.body?.code, ErrCode.OK, '⑧ grant=0 注册成功（余额面可查）');
    checks.eq(c13Bal2.body?.data?.balance, 0, '⑧ grant=0 新注册 ⇒ 余额 0');
    checks.eq(opsCountByAction(`signup:${userS2.id}`), 0, '⑧ 零痕迹**按 userId**：该用户 ops 0 行（不按全局计数——前组已造行）');
    checks.eq(flowsCountByOwner(userS2.id), 0, '⑧ 零痕迹：该用户 flows 0 行');
    checks.eq(accountsCount(userS2.id), 0, '⑧ 零痕迹：该用户账户 0 行');
    const c13Bal1Again = await getJson<{ balance: number }>('/api/wallet/balance', userS1.accessToken);
    checks.eq(c13Bal1Again.body?.data?.balance, GRANT_ON, '⑧ 改回 0 后**已注册用户不受影响**（快照语义，仍 777）');

    // ══════════════════════════════════════════════════════════════════════
    // ⑧b 销毁上账（本片，C13 五判定）：直投带 burn 的 game_settle ⇒ 两列 + summary 增量；
    //     不带 ⇒ 两列 NULL 且 unrecordedOps +1；V3/V1 反例 ⇒ 10001 零库行；1970 空窗 ⇒ 0/0/0
    // ══════════════════════════════════════════════════════════════════════
    step('⑧b 销毁上账：直投 burn 两态 + summary burn 块增量 + V3/V1 反例 + 1970 空窗');
    const OWNER_BURN_A = 's17burna';
    const OWNER_BURN_B = 's17burnb';
    const OWNER_BURN_C = 's17burnc';
    harnessOwners.push(OWNER_BURN_A, OWNER_BURN_B, OWNER_BURN_C);
    const burnSummary = async (
      from: number,
      to: number,
    ): Promise<{ residue: number; rake: number; unrecordedOps: number }> => {
      const res = await getJson<{
        rows: unknown[];
        totals: unknown;
        burn: { residue: number; rake: number; unrecordedOps: number };
      }>(`/api/admin/wallet/summary?from=${from}&to=${to}`, admin);
      if (res.body?.code !== ErrCode.OK || !res.body.data) {
        throw new ConformanceError(`GET /api/admin/wallet/summary 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res.body.data.burn;
    };

    const burnBefore = await burnSummary(0, Date.now());

    // 🔴 垫资（先例 = C7 先 +1000）：三个 owner 全新且起手被清源 ⇒ 余额 0；负 delta 的账户
    // 必须先从 0 起步（条件 UPDATE 的 `balance+delta>=0` 裁决 ⇒ 否则 14001，⑧b 全组不可达）。
    // admin_adjust 不进 burn 窗口（source 过滤），清源前缀已覆盖。
    expectApplyOk(
      await rpcApply(adminAdjustReq(AID('burn-fund'), OWNER_BURN_B, 100, 'slice17 burn 垫资')),
      '⑧b 垫资 OWNER_BURN_B +100',
    );

    // ① 带 burn：用户示例局（−25/+12/+12，残差 1）的手工 burn 载荷 ⇒ ok + 两列落库
    //    （2026-10-26 起结算算法不再产生该残差——本组只测 burn 协议，与分配算法无关）
    const b1Aid = AID('burn-1');
    const b1 = expectApplyOk(
      await rpcApply({
        actionId: b1Aid,
        source: 'game_settle',
        refId: 's17-burn',
        entries: [
          { ownerId: OWNER_BURN_A, delta: 12 },
          { ownerId: OWNER_BURN_B, delta: -25 },
          { ownerId: OWNER_BURN_C, delta: 12 },
        ],
        burn: { residue: 1, rake: 0 },
      } satisfies CurrencyApplyRequest),
      '⑧b① 带 burn 直投',
    );
    checks.eq(b1.replayed, false, '⑧b① 首发 replayed=false（真写）');
    checks.eq(
      mysqlText(`SELECT CONCAT(burned_residue,':',burned_rake) FROM currency_ops WHERE action_id='${b1Aid}'`),
      '1:0',
      '⑧b① 两列实读 residue:rake = 1:0',
    );
    checks.eq(
      mysqlText(`SELECT game_type FROM currency_ops WHERE action_id='${b1Aid}'`),
      'doudizhu',
      'A2：game_settle 旧载荷（无 gameType）按来源归一落 doudizhu',
    );
    checks.eq(opsCountByAction(b1Aid), 1, '⑧b① ops 恰 1 行');

    // ② 不带 burn（D3）：两列 NULL、unrecordedOps +1 ——「未记录 ≠ 0」
    const b2Aid = AID('burn-2');
    expectApplyOk(
      await rpcApply({
        actionId: b2Aid,
        source: 'game_settle',
        refId: 's17-burn',
        entries: [
          { ownerId: OWNER_BURN_A, delta: 7 },
          { ownerId: OWNER_BURN_B, delta: -7 },
        ],
      } satisfies CurrencyApplyRequest),
      '⑧b② 不带 burn 直投（D3 合法性）',
    );
    checks.eq(
      mysqlText(`SELECT IFNULL(CONCAT(burned_residue,':',burned_rake),'NULL') FROM currency_ops WHERE action_id='${b2Aid}'`),
      'NULL',
      '⑧b② 两列 NULL（未记录 ≠ 0）',
    );

    // ③ V3 反例：burn 与分录不符 ⇒ 10001、零库行
    const b3Aid = AID('burn-3');
    const b3Msg = expectApplyReject(
      await rpcApply({
        actionId: b3Aid,
        source: 'game_settle',
        refId: 's17-burn',
        entries: [{ ownerId: OWNER_BURN_A, delta: 5 }],
        burn: { residue: 1, rake: 0 },
      } satisfies CurrencyApplyRequest),
      ErrCode.BAD_PARAM,
      '⑧b③ 不变量不符',
    );
    checks.that(b3Msg.includes('burn 与分录金额不符'), `⑧b③ 拒因文案（实际：${b3Msg}）`);
    checks.eq(opsCountByAction(b3Aid), 0, '⑧b③ 零库行（确定性回滚）');

    // ④ V1 反例：非 game_settle 携带 burn ⇒ 10001、零库行
    const b4Aid = AID('burn-4');
    expectApplyReject(
      await rpcApply({
        actionId: b4Aid,
        source: 'signup_grant',
        refId: 's17-burn',
        entries: [{ ownerId: OWNER_BURN_A, delta: -3 }],
        burn: { residue: 3, rake: 0 },
      } satisfies CurrencyApplyRequest),
      ErrCode.BAD_PARAM,
      '⑧b④ 非 game_settle 携带 burn',
    );
    checks.eq(opsCountByAction(b4Aid), 0, '⑧b④ 零库行');

    // ⑤ summary burn 块增量（窗口 [0, now)；只断言增量——共享脏栈上存量不定）
    const burnAfter = await burnSummary(0, Date.now());
    checks.eq(burnAfter.residue - burnBefore.residue, 1, '⑧b⑤ residue 增量 +1');
    checks.eq(burnAfter.rake - burnBefore.rake, 0, '⑧b⑤ rake 增量 +0');
    checks.eq(burnAfter.unrecordedOps - burnBefore.unrecordedOps, 1, '⑧b⑤ unrecordedOps 增量 +1（b2 旧格式那条）');

    // ⑥ 1970 [1, 2) 空窗 ⇒ 0/0/0（窗口过滤生效；slice-19 先例）
    const burnEpoch = await burnSummary(1, 2);
    checks.eq(
      JSON.stringify(burnEpoch),
      JSON.stringify({ residue: 0, rake: 0, unrecordedOps: 0 }),
      '⑧b⑥ 1970 [1,2) 空窗 ⇒ 0/0/0',
    );

    // ══════════════════════════════════════════════════════════════════════
    // ⑨ reconcile：指标齐 + 注入短间隔 + 账实漂移两向 + 缓存漂移自愈 + 孤儿 gauge
    // ══════════════════════════════════════════════════════════════════════
    step('⑨ C16①：7 条指标名齐 + apply 三系列（ok/replay/reject）在（容器重启前读，后者清零）');
    const c16Metrics = readCurrencyMetrics();
    const missingMetrics = [
      'currency_apply_total',
      'currency_apply_entries_total',
      'currency_reconcile_runs_total',
      'currency_reconcile_last_success_timestamp_seconds',
      'currency_reconcile_drift_accounts',
      'currency_reconcile_cache_drift_total',
      'currency_orphan_signup_grants',
    ].filter((name) => !c16Metrics.includes(name));
    checks.that(missingMetrics.length === 0, `⑨ 7 条指标名齐全${missingMetrics.length > 0 ? `（缺：${missingMetrics.join(', ')}）` : ''}`);
    checks.that(
      seriesValue(c16Metrics, 'currency_apply_total', { source: 'admin_adjust', result: 'ok' }) !== null,
      '⑨ currency_apply_total{source=admin_adjust,result=ok} 系列在（本片前组真实调用过）',
    );
    checks.that(
      seriesValue(c16Metrics, 'currency_apply_total', { source: 'admin_adjust', result: 'replay' }) !== null,
      '⑨ currency_apply_total{...result=replay} 系列在（C4② 重放）',
    );
    checks.that(
      seriesValue(c16Metrics, 'currency_apply_total', { source: 'admin_adjust', result: 'reject' }) !== null,
      '⑨ currency_apply_total{...result=reject} 系列在（C5 14002 / C6② 14001）',
    );

    step(`⑨ C16②：PUT currency.reconcileIntervalMs=${RECONCILE_INTERVAL_INJECT}（管理面注入）+ 重建 currency-service ⇒ runs≥2、last_success 前进`);
    await putInterval(admin, 'currency.reconcileIntervalMs', RECONCILE_INTERVAL_INJECT, '⑨ 注入');
    // ⚠️ `--force-recreate` 不可省（slice-14 C16 同款截断）：`up -d` 对**未变**容器是 no-op，
    //    而「已排定的一轮不撤、其后按现读值排期」（本片 ⚙️7）⇒ 不真重启就只在**旧间隔**后
    //    才有下一轮对账（1h ⇒ runs≥2 的 60s 观测窗必红）。
    const c16Up = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'currency-service');
    checks.eq(c16Up.code, 0, `⑨ 注入重建 currency-service —— 输出尾部：${tailOut(c16Up.out)}`);
    const c16Healthy = await waitContainerHealthy('ftl-currency-service');
    checks.that(c16Healthy.ok, `⑨ 重建后 currency-service 就绪 —— ${c16Healthy.last}`);
    // 窗口复算（本片 ⚙️9 换源后）：等快照 ≤10s（首排动作的有界等待）+ 首跑 10s + 每 3s
    // ⇒ ≥2 轮最坏 ≈ 26s ⇒ 60s 窗余量足（数字不改）。
    const c16Runs = await pollUntil(() => sumMetric(readCurrencyMetrics(), 'currency_reconcile_runs_total'), (n) => n >= 2, 60_000);
    checks.that(c16Runs.ok, `⑨ ≤60s 内对账轮 ≥2（首跑 10s + 每 3s）—— 最后一次读数 ${c16Runs.last}`);
    const c16LastSuccess = await pollUntil(() => sumMetric(readCurrencyMetrics(), 'currency_reconcile_last_success_timestamp_seconds'), (n) => n > 0, 60_000);
    checks.that(c16LastSuccess.ok, `⑨ last_success 已 set（epoch 秒 >0）—— 最后一次读数 ${c16LastSuccess.last}`);
    const c16Advance = await pollUntil(
      () => sumMetric(readCurrencyMetrics(), 'currency_reconcile_last_success_timestamp_seconds'),
      (n) => n > c16LastSuccess.last,
      30_000,
    );
    checks.that(c16Advance.ok, `⑨ last_success 继续前进（轮轮成功才前进）—— ${c16LastSuccess.last} ⇒ ${c16Advance.last}`);

    step('⑨ C16③：构造账实漂移（s17c4 +7）⇒ gauge=1 + error 日志 + **不自修** ⇒ 修回归零');
    mysqlExec(`UPDATE currency_accounts SET balance = balance + 7 WHERE owner_id = '${OWNER_C4}'`);
    const c16Drift = await pollUntil(
      () => sumMetric(readCurrencyMetrics(), 'currency_reconcile_drift_accounts'),
      (n) => n === 1,
      30_000,
    );
    checks.that(c16Drift.ok, `⑨ 账实漂移 ⇒ drift_accounts gauge=1（最后读数 ${c16Drift.last}）`);
    const c16DriftLog = await pollUntil(
      () =>
        ndjson('currency-service', 300).filter((r) => {
          const msg = String(r.msg);
          return msg.includes(`currency reconcile drift ownerId=${OWNER_C4}`) && msg.includes('diff=7');
        }),
      (lines) => lines.length > 0,
      30_000,
    );
    checks.that(c16DriftLog.ok, `⑨ 漂移逐行 error 日志（ownerId=${OWNER_C4} diff=7）出现（30s 内）`);
    checks.eq(c16DriftLog.last[0]?.level, 'error', '⑨ 该行是 error 级（钱的事只报不改，但不许静默）');
    checks.eq(balanceOf(OWNER_C4), 257, '⑨ 不自修：漂移观测后账户余额仍是 257（上一轮**没有**改库）');
    mysqlExec(`UPDATE currency_accounts SET balance = balance - 7 WHERE owner_id = '${OWNER_C4}'`);
    const c16DriftBack = await pollUntil(
      () => sumMetric(readCurrencyMetrics(), 'currency_reconcile_drift_accounts'),
      (n) => n === 0,
      30_000,
    );
    checks.that(c16DriftBack.ok, `⑨ 修回后漂移 gauge 归零（最后读数 ${c16DriftBack.last}）`);

    step('⑨ C16④：缓存漂移（SET 错值）⇒ 对账 DEL 键（自愈）+ counter 增');
    const c16CacheBefore = sumMetric(readCurrencyMetrics(), 'currency_reconcile_cache_drift_total');
    const c16Set = redisRaw(['SET', `currency:balance:${OWNER_C4}`, '999999']);
    checks.eq(c16Set.status, 0, `⑨ 构造缓存漂移：redis SET …=999999（redisReply=${JSON.stringify(redisReplyText(c16Set))}）`);
    const c16Heal = await pollUntil(
      () => ({
        counter: sumMetric(readCurrencyMetrics(), 'currency_reconcile_cache_drift_total'),
        exists: redisReplyText(redisRaw(['EXISTS', `currency:balance:${OWNER_C4}`])),
      }),
      (v) => v.counter > c16CacheBefore && v.exists === '0',
      30_000,
    );
    checks.that(
      c16Heal.ok,
      `⑨ 缓存漂移自愈：counter ↑（${c16CacheBefore} ⇒ ${c16Heal.last.counter}）且键被 DEL（EXISTS=${c16Heal.last.exists}）`,
    );
    checks.eq(c16Heal.last.exists, '0', '⑨ 漂移键已删（下读回源）');

    step('⑨ C16⑤：孤儿赠送（固定前缀直插 ops+flows，用户不存在）⇒ gauge 增 + 日志');
    const c16OrphanBefore = sumMetric(readCurrencyMetrics(), 'currency_orphan_signup_grants');
    const orphanHash = 'a'.repeat(64);
    mysqlExec(
      `INSERT INTO currency_ops (action_id, request_hash, source) VALUES ('${AID('orphan')}', '${orphanHash}', 'signup_grant')`,
    );
    const orphanOpId = mysqlCount(`SELECT id FROM currency_ops WHERE action_id='${AID('orphan')}'`);
    mysqlExec(
      `INSERT INTO currency_flows (op_id, owner_id, owner_type, delta, balance_after) VALUES (${orphanOpId}, '${OWNER_ORPHAN}', 'user', 5, 5)`,
    );
    const c16Orphan = await pollUntil(
      () => sumMetric(readCurrencyMetrics(), 'currency_orphan_signup_grants'),
      (n) => n > c16OrphanBefore,
      30_000,
    );
    checks.that(
      c16Orphan.ok,
      `⑨ 孤儿计数 gauge 增（${c16OrphanBefore} ⇒ ${c16Orphan.last}；固定 owner=${OWNER_ORPHAN} 的直插流水）`,
    );
    const c16OrphanLog = await pollUntil(
      () => ndjson('currency-service', 300).filter((r) => String(r.msg).includes('currency reconcile orphan signup grants: count=')),
      (lines) => lines.length > 0,
      30_000,
    );
    checks.that(c16OrphanLog.ok, '⑨ 孤儿 >0 记日志（`currency reconcile orphan signup grants: count=…`）');

    step(`⑨ 收尾：PUT currency.reconcileIntervalMs=${RECONCILE_INTERVAL_RESTORE}（知基线）+ 重建 currency-service`);
    await putInterval(admin, 'currency.reconcileIntervalMs', RECONCILE_INTERVAL_RESTORE, '⑨ 还原基线');
    const c16Restore = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'currency-service');
    checks.eq(c16Restore.code, 0, `⑨ 还原重建（知基线 ${RECONCILE_INTERVAL_RESTORE}）—— 输出尾部：${tailOut(c16Restore.out)}`);
    const c16RestoreHealthy = await waitContainerHealthy('ftl-currency-service');
    checks.that(c16RestoreHealthy.ok, `⑨ 还原后 currency-service 就绪 —— ${c16RestoreHealthy.last}`);

    // ══════════════════════════════════════════════════════════════════════
    // ⑩ prometheus 15/15（含 currency-service；支付片 T15 +payment-service）
    // ══════════════════════════════════════════════════════════════════════
    step('⑩ prometheus：15 个抓取目标逐个 up（含 currency-service）');
    const c17Targets = await pollUntil(
      () => fetchTargets(),
      (t) => t.length === 15 && t.every((x) => x.health === 'up'),
      90_000,
      3_000,
    );
    checks.eq(c17Targets.last.length, 15, '⑩ /api/v1/targets 恰 15 个 activeTargets（15 个 job 逐个在场）');
    const downTargets = c17Targets.last.filter((t) => t.health !== 'up').map((t) => `${t.job}:${t.health}`);
    checks.that(downTargets.length === 0, `⑩ 15/15 全 up${downTargets.length > 0 ? `（down：${downTargets.join(', ')}）` : ''}`);
    checks.eq(
      c17Targets.last.find((t) => t.job === 'currency-service')?.health,
      'up',
      '⑩ currency-service 目标 up（货币片新增 job 真抓到）',
    );

    // ══════════════════════════════════════════════════════════════════════
    // ⑪ 静态/负例组：C8 负例抽样 + ownerType 异型 + C12 门口静态 + C14 负对照
    // ══════════════════════════════════════════════════════════════════════
    step('⑪ C8 负例抽样（直投）：source 非 allowlist / delta=0 / |delta|>1e6 / 重复 ownerId / actionId 空 ⇒ 10001，且零库写');
    const negSrc = await rpcApply({
      actionId: AID('neg-src'),
      source: 'no_such_source',
      entries: [{ ownerId: OWNER_GHOST, delta: 1 }],
    });
    const negSrcMsg = expectApplyReject(negSrc, ErrCode.BAD_PARAM, '⑪ 负例 source');
    checks.that(negSrcMsg.includes('source'), `⑪ 拒绝原因指向 source —— 实际 ${JSON.stringify(negSrcMsg)}`);
    const negZero = await rpcApply(adminAdjustReq(AID('neg-d0'), OWNER_GHOST, 0, 'slice17 负例'));
    const negZeroMsg = expectApplyReject(negZero, ErrCode.BAD_PARAM, '⑪ 负例 delta=0');
    checks.that(negZeroMsg.includes('delta'), `⑪ 拒绝原因指向 delta —— 实际 ${JSON.stringify(negZeroMsg)}`);
    const negMax = await rpcApply(adminAdjustReq(AID('neg-dmax'), OWNER_GHOST, 1_000_001, 'slice17 负例'));
    expectApplyReject(negMax, ErrCode.BAD_PARAM, '⑪ 负例 |delta|>1e6');
    checks.ok('⑪ |delta| > 1,000,000 ⇒ 10001（上限闸）');
    const negDupReq: CurrencyApplyRequest = {
      actionId: AID('neg-dup'),
      source: 'admin_adjust',
      actor: 'admin',
      reason: 'slice17 负例',
      entries: [
        { ownerId: OWNER_GHOST, delta: 1 },
        { ownerId: OWNER_GHOST, delta: 2 },
      ],
    };
    const negDup = await rpcApply(negDupReq);
    const negDupMsg = expectApplyReject(negDup, ErrCode.BAD_PARAM, '⑪ 负例 重复 ownerId');
    checks.that(negDupMsg.includes('重复'), `⑪ 重复 ownerId 拒绝（message 含「重复」）—— 实际 ${JSON.stringify(negDupMsg)}`);
    const negAid = await rpcApply(adminAdjustReq('', OWNER_GHOST, 1, 'slice17 负例'));
    expectApplyReject(negAid, ErrCode.BAD_PARAM, '⑪ 负例 actionId 空');
    checks.ok('⑪ actionId 空 ⇒ 10001');
    checks.eq(
      mysqlCount(
        `SELECT COUNT(*) FROM currency_ops WHERE action_id IN ('${AID('neg-src')}','${AID('neg-d0')}','${AID('neg-dmax')}','${AID('neg-dup')}')`,
      ),
      0,
      '⑪ 校验失败零库写（四个负例 actionId 的 ops 行 0 —— 拒绝发生在任何库操作之前）',
    );
    checks.eq(accountsCount(OWNER_GHOST), 0, '⑪ 负例全部未建账户行（ghost 仍 0）');

    step('⑪ C8 ownerType 不可变：既有 user 账户按 robot 再写 ⇒ 10001 + 响亮 error 日志 + 余额不变');
    const negType = await rpcApply({
      actionId: AID('neg-type'),
      source: 'signup_grant',
      entries: [{ ownerId: OWNER_C4, ownerType: 'robot', delta: 1 }],
    });
    const negTypeMsg = expectApplyReject(negType, ErrCode.BAD_PARAM, '⑪ ownerType 异型');
    checks.that(negTypeMsg.includes('ownerType'), `⑪ 拒绝原因指向 ownerType —— 实际 ${JSON.stringify(negTypeMsg)}`);
    checks.eq(balanceOf(OWNER_C4), 250, '⑪ ownerType 异型整批回滚（余额仍 250）');
    const negTypeLog = await pollUntil(
      () => ndjson('currency-service', 300).filter((r) => String(r.msg).includes(`actionId=${AID('neg-type')}`) && String(r.msg).includes('ownerType')),
      (lines) => lines.length > 0,
      15_000,
    );
    checks.that(negTypeLog.ok, '⑪ ownerType 异型是响亮 error 日志（含 actionId 与 ownerType 词）');
    checks.eq(negTypeLog.last[0]?.level, 'error', '⑪ 该行 error 级（首写固化的违规不许静默）');

    step('⑪ C12 静态：经门口拉 /admin/app.js ⇒ 200 且含「钱包调整」section 与三端点串');
    const c12Page = await edgeGetFollowing('/admin/app.js');
    checks.eq(c12Page.status, 200, `⑪ C12 /admin/app.js 经门口 ⇒ 200（跳转链：${c12Page.chain.join(' | ')}）`);
    checks.that(c12Page.body.includes('钱包调整'), '⑪ C12 app.js 含「钱包调整」section（静态锚点）');
    checks.that(c12Page.body.includes('/api/admin/users/lookup'), '⑪ C12 app.js 含 lookup 端点串');
    checks.that(c12Page.body.includes('/api/admin/wallet/accounts/'), '⑪ C12 app.js 含 accounts 端点串');
    checks.that(c12Page.body.includes('/api/admin/wallet/adjust'), '⑪ C12 app.js 含 adjust 端点串');
    checks.that(c12Page.body.includes('销毁：残差 '), '⑪ C12 app.js 含销毁行文案针脚（本片）');

    step('⑪ C14 负对照：/api/config 键集 = 客户端 22 键，绝不含内部键（signupGrant/rakePercent/reliefAmount）');
    const c14Config = await getJson<Record<string, unknown>>('/api/config', userP.accessToken);
    checks.eq(c14Config.body?.code, ErrCode.OK, '⑪ C14 /api/config code 0');
    const c14Keys = Object.keys(c14Config.body?.data ?? {});
    // ② 金币场 T12 同步：3 → 7 键；支付片 T5 同步：7 → 14；广告片 T23 同步：14 → 15 键；台费阶段 2：派生字段删除后 21 键
    // （§2.5/⚙️11；逐字名单，不随协议常量漂）。
    checks.eq(
      c14Keys.sort().join(','),
      'agentInviteEnabled,baseScoreLevels,cardCounterEnabled,cardCounterPricePerGameCoins,cardCounterPricePerHourCoins,coinPerYuan,entryMultiplier,freeRoomEnabled,friendRoomEnabled,games,goldRoomEnabled,rechargeEnabled,rechargePackages,reliefAdpid,reliefEnabled,reliefThresholdCoins,version,withdrawDailyMaxCoins,withdrawEnabled,withdrawMaxCoinsPerOrder,withdrawMinCoins,withdrawReAuthEnabled',
      '⑪ C14 键集（排序后）恰好客户端 22 键',
    );
    // 内部键**显式名单**（T12 起含 rakePercent/reliefAmount；前缀兜底断言在 slice-18 A 组）。
    const c14InternalLeaks = ['currency.signupGrant', 'game.doudizhu.rakePercent', 'currency.reliefAmount'].filter((key) =>
      JSON.stringify(c14Config.body?.data ?? null).includes(key),
    );
    checks.that(
      c14InternalLeaks.length === 0,
      `⑪ C14 内部键零泄漏（显式名单）—— 命中 ${JSON.stringify(c14InternalLeaks)}`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // 收尾：测试行/键清理（断言归零）
    // ══════════════════════════════════════════════════════════════════════
    step('收尾：s17* 与本 run harness 用户的库行/缓存键清理（断言归零）');
    deleteTestRows(harnessOwners);
    deleteTestKeys(harnessOwners);
    checks.eq(mysqlCount(`SELECT COUNT(*) FROM currency_flows WHERE owner_id LIKE 's17%'`), 0, '收尾：s17* 流水行清零');
    checks.eq(mysqlCount(`SELECT COUNT(*) FROM currency_ops WHERE action_id LIKE 's17-%'`), 0, '收尾：s17-* 操作行清零');
    checks.eq(mysqlCount(`SELECT COUNT(*) FROM currency_accounts WHERE owner_id LIKE 's17%'`), 0, '收尾：s17* 账户行清零');
    checks.eq(scanRedisKeys('currency:balance:s17*').length, 0, '收尾：s17* 缓存键清零');

    return checks;
  } finally {
    // ── 注入态 / 键值 / 测试行**兜底复原**（成败皆然）──────────────────────────
    // 正常路径已复原与清理；这里兜「前文抛错或被中断」。整段吞错只 info：
    // 兜底复原**不许**顶掉原始结论。
    try {
      deleteTestRows(harnessOwners);
      deleteTestKeys(harnessOwners);
      await putInterval(admin, 'currency.reconcileIntervalMs', RECONCILE_INTERVAL_RESTORE, 'finally 兜底：还原基线');
      compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'currency-service');
      await adminPutConfig(SIGNUP_GRANT_KEY, GRANT_OFF, admin);
    } catch (err) {
      info(`兜底复原失败（不影响原始结论；手动检查 currency-service 注入态与 ${SIGNUP_GRANT_KEY}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

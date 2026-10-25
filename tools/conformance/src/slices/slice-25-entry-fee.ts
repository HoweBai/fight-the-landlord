/**
 * slice-25 —— 台费（入场费）真栈组（本片 C32–C34 载体 + C25/C26 真栈半边）。
 *
 * 分组：⓪ 起手（五容器 healthy + gold 队列清源）· A 费率临时开启 · B C32 真栈收费（完整金币局）
 * · C C25 报表面（ops/CSV）· D C33 免单（管理端扣减构造 14001）· E C34 重放/冲突（真栈可构造半边）
 * · 收尾（费率还原 + 队列零残留 + 读数自证）。
 *
 * 🔴 费率纪律（规格 §5 逐字）：用例「**临时开费率 ⇒ 还原**」（先例 slice-15:45 / slice-13 J22 /
 * slice-18 F）。2026-10-21 起台费在 `game.levels.doudizhu[].entryFeePercent`：进入前**快照实际档位表**，
 * 只临时改 15 档；正常/`finally` 都写回**语义快照**（每条显式 `entryFeePercent ?? 0`，避免旧形态 400）。
 * **正常路径还原失败 = 片内硬失败**；不硬编码种子、不覆盖测试服人工配置。
 *
 * 清理/命名纪律：actionId 一律经 `AID`（RUN_TAG 运行期唯一，**不得固定字面量**，同栈连跑两轮
 * 不互撞）；owner 一律 `registerUser` 运行期生成并登记入 `harnessOwners`（收尾 info 落档）；
 * 本片**不做** DB 行硬清（共享脏栈容忍；所有读数一律**增量/房间维度**断言——照 slice-18/19 口径）。
 *
 * C34 登记（预置口径，规格评审 E 组结论）：「room-service 同房二开 ⇒ 同锚重放」是**并发竞态**
 * （正常单入口在 waiting 守卫处早返）⇒ 真栈不可稳定构造，判据落 room-service 单测
 * （`rooms.entry-fee.test.ts` 的 C12：同锚同载荷 + 重放回写）；本片 E 组只收**可确定性构造**的
 * 重放/冲突半边（同锚直投）。
 *
 * ⚠️ C25 的「可提现 cap 不含台费」**不在本片加真栈探针**：本片轻量流（无充值/无正结算流）
 * 造不出正 cap 用户 ⇒ **范围取舍**（非不可判别）——判据沿用 payment 面「恰 6 源集合」单测
 * （规格 C25 定；`withdrawable.test.ts` 独立持有 6 源字面量 + 参数次序**全文相等**识别 ⇒
 * 误纳 entry_fee 必红）。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ErrCode,
  RPC_PATTERNS,
  type BaseScoreLevel,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
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
  type HarnessUser,
} from '../lib/http';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';
import { redisRaw, redisReplyText } from '../lib/redis';
import {
  MATCH_BASE_SCORE,
  playFullGameToEnd,
  startFreshRoom,
  type FreshRoom,
} from '../lib/ddz-driver';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-15/17/18）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** `currency.apply` 的 TCP 监听（宿主直投 = compose override 的 `3104:3104`）。 */
const CURRENCY_RPC: RpcEndpoint = {
  host: process.env.CURRENCY_RPC_HOST ?? 'localhost',
  port: Number(process.env.CURRENCY_RPC_PORT ?? 3104),
};

/** 本 run 的动作号后缀（照 slice-15/17/18 的 per-run 后缀纪律）。 */
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-4);
const AID = (s: string): string => `s25-${RUN_TAG}-${s}`;

const HEALTH_CONTAINERS = [
  'ftl-room-service',
  'ftl-user-service',
  'ftl-currency-service',
  'ftl-api-gateway',
  'ftl-config-service',
] as const;

/** 台费唯一来源（2026-10-21 起）：档位表的第三列。 */
const LEVELS_KEY = 'game.levels.doudizhu';
/** 临时开启态的台费金额：15 档 10% ⇒ fee = max(1, floor(15×10/100)) = 1（金额=公式的载体）。 */
const ENTRY_FEE_AMOUNT = 1;
/** 两真人预充（规格 §12.1 同族：5,000,000 = 5 笔 ×1e6；admin 单笔上限 1e6）。 */
const PRE_CHARGE_TOTAL = 5_000_000;
const PRE_CHARGE_STEP = 1_000_000;
const PRE_CHARGE_OPS = PRE_CHARGE_TOTAL / PRE_CHARGE_STEP;
const GOLD_HUMANS = 2;

// ────────────────────────────────────────────────────────────────────────────
// docker / mysql / redis / metrics 助手（形态先例见文件头；③ 段照 slice-18 逐字）
// ⚠️ **任务书字面修正（T9 实施期）**：slice-18 的 `compose()` / `sumMetric()` 两件
//    本片零调用点 —— `noUnusedLocals` 下未使用声明即 TS6133 构建错 ⇒ 不予复制
//    （其余 ③ 段函数一字不改；`replyReplyText` 等间接使用链见各自注释）。
// ────────────────────────────────────────────────────────────────────────────

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

/** MySQL 查询（`-N` = 不带列名表头；SQL 只许单引号字面量与数字，照 slice-15/17）。 */
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

/** 某服务最近的容器日志（`--no-color` 必须有：ANSI 会让「找那一行」恒假）。 */
function composeLogs(service: string, sinceSeconds: number): string {
  const r = spawnSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, service],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 一行日志里抽出 NDJSON 记录（前缀 `ftl-x | ` 与非 JSON 行一律 null）。 */
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

/** 轮询直至谓词成立（有上界）。返回最后一次读数 —— **由调用方断言**。 */
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

/** 等容器 healthy（照 slice-14/17）。 */
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

/** `/metrics` 的 exec 入口（照 slice-16/17）：容器内 curl（指标端口不发布宿主口）。 */
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

/** room-service 的 `/metrics` 全文（9002；带真 token —— dev 栈守卫口令与 conformance 同源）。 */
function readRoomMetrics(): string {
  return execCurl('ftl-room-service', 9002, '/metrics', INTERNAL_TOKEN).body;
}

// ── Prom 文本解析（照 slice-16/17；只用 sum / 精确标签匹配两个读法）───────────

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

/** 某指标**恰好匹配这些标签**的序列值（缺席返回 `null` —— 与「值是 0」分开）。 */
function seriesValue(text: string, name: string, want: Record<string, string>): number | null {
  for (const s of parseProm(text)) {
    if (s.name !== name) continue;
    const hit = Object.entries(want).every(([k, v]) => s.labels[k] === v);
    if (hit) return s.value;
  }
  return null;
}

// ── Redis 只读/构造探针（lib/redis 的 raw 助手）────────────────────────────

function scanRedisKeys(pattern: string): string[] {
  const reply = redisRaw(['--scan', '--pattern', pattern]);
  if (reply.status !== 0) {
    throw new ConformanceError(`redis-cli --scan 失败（退出码 ${reply.status}）：${redisReplyText(reply) || '（无输出）'}`);
  }
  return reply.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 一行一个值的回复（`ZRANGE`/`ZSCORE` 等；空串 ⇒ `''`）。 */
function redisCliText(args: string[]): string {
  const reply = redisRaw(args);
  if (reply.status !== 0) {
    throw new ConformanceError(`redis-cli ${args.join(' ')} 失败（退出码 ${reply.status}）：${redisReplyText(reply) || '（无输出）'}`);
  }
  return replyReplyText(reply);
}

/** stdout 优先、回落 stderr（`redisReplyText` 的同款语义，供上面单条命令用）。 */
function replyReplyText(reply: { stdout: string; stderr: string }): string {
  return (reply.stdout.trim() || reply.stderr.trim()).trim();
}

/** `ZSCORE match:queue:gold:<baseScore>:global <userId>`（空串 = 不在队列）。 */
function goldQueueScore(userId: string, baseScore: number): string {
  return redisCliText(['ZSCORE', `match:queue:gold:${baseScore}:global`, userId]);
}

/** 清源：删除全部 `match:queue:gold:*` 键 + 逐 seat 判定删除 gold 票的 `match:meta:*`。 */
function purgeGoldQueues(): { deletedQueues: number; deletedMetas: number } {
  let deletedQueues = 0;
  for (const key of scanRedisKeys('match:queue:gold:*')) {
    redisRaw(['DEL', key]);
    deletedQueues += 1;
  }
  let deletedMetas = 0;
  for (const key of scanRedisKeys('match:meta:*')) {
    const mode = replyReplyText(redisRaw(['HGET', key, 'mode']));
    if (mode === 'gold') {
      redisRaw(['DEL', key]);
      deletedMetas += 1;
    }
  }
  return { deletedQueues, deletedMetas };
}

/** 余下 gold 票的 meta 数（清源与收尾共用同一读数）。 */
function goldMetaCount(): number {
  let n = 0;
  for (const key of scanRedisKeys('match:meta:*')) {
    if (replyReplyText(redisRaw(['HGET', key, 'mode'])) === 'gold') n += 1;
  }
  return n;
}

// ────────────────────────────────────────────────────────────────────────────
// 管理面 / RPC / 配置生效 助手（③ 段照 slice-18 逐字；④ 段为本片新助手）
// ────────────────────────────────────────────────────────────────────────────

/** `POST /api/admin/wallet/adjust`（管理面单笔；`ownerType` 缺省 = user）。 */
async function adminAdjust(
  admin: string,
  userId: string,
  delta: number,
  actionId: string,
  ownerType?: 'robot',
): Promise<{ status: number; code: number | undefined; balanceAfter: number | null }> {
  const res = await postJson<{ balanceBefore: number; balanceAfter: number; opId: number }>(
    '/api/admin/wallet/adjust',
    // `ownerType` 只在显式传入时出现（缺省 = 服务端归一 `'user'`，§7）。
    { userId, delta, reason: `slice25 ${RUN_TAG}`, actionId, ...(ownerType ? { ownerType } : {}) },
    admin,
  );
  return {
    status: res.status,
    code: res.body?.code,
    balanceAfter: res.body?.data?.balanceAfter ?? null,
  };
}

/** `GET /api/admin/wallet/accounts/:userId`（MySQL 直读；未开户 = 200 空态）。 */
async function adminAccounts(
  admin: string,
  userId: string,
): Promise<{ balance: number; recentFlows: Array<{ delta: number; source: string }> }> {
  const res = await getJson<{ balance: number; recentFlows: Array<{ delta: number; source: string }> }>(
    `/api/admin/wallet/accounts/${encodeURIComponent(userId)}`,
    admin,
  );
  if (res.status !== 200 || res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`管理面查账失败 userId=${userId}：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { balance: res.body.data!.balance, recentFlows: res.body.data!.recentFlows ?? [] };
}

/**
 * `PUT /api/admin/config/:key` + **等目标服务的快照生效**。
 *
 * 生效观测 = `<service>` 日志里 `config snapshot applied (version=…)` 行**计数**增量
 * （版本算术照 slice-17 的 `putConfigAndWaitRefresh`：PUT 后版本 = `max(全局, 本键+1)`）——
 * 计数口径把「容器启动首拉 / 安全网轮 / 上一次同版本行」全部排除，只认**本次** PUT 触发的拉取。
 */
async function putConfigAndWaitEffect(
  admin: string,
  key: string,
  value: unknown,
  service: string,
): Promise<{ putCode: number | undefined; refreshOk: boolean; observed: number; baseline: number; expected: number }> {
  interface AdminConfigData {
    config: Record<string, { value: unknown; version: number }>;
    version: number;
  }
  const countWithVersion = (version: number): number =>
    ndjson(service, 900).filter((r) => {
      const msg = String(r.msg);
      return msg.includes('config snapshot applied') && new RegExp(`version=${version}\\b`).test(msg);
    }).length;

  const before = await adminGetConfig<AdminConfigData>(admin);
  const gv0 = before.body?.data?.version ?? 0;
  const kv0 = before.body?.data?.config?.[key]?.version ?? 0;
  const expected = Math.max(gv0, kv0 + 1);
  const baseline = countWithVersion(expected);
  const put = await adminPutConfig(key, value, admin);
  const refresh = await pollUntil(() => countWithVersion(expected), (n) => n > baseline, 30_000);
  return { putCode: put.body?.code, refreshOk: refresh.ok, observed: refresh.last, baseline, expected };
}

/** `GET /api/admin/config` 的单键值（PUT 后的 **GET 确认** 读口）。 */
async function adminGetConfigValue(admin: string, key: string): Promise<unknown> {
  const res = await adminGetConfig<{ config: Record<string, { value: unknown }> }>(admin);
  if (res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`GET /api/admin/config 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data?.config?.[key]?.value;
}

/** `currency.apply` 直投（本片 E 组用）。 */
const rpcApply = (req: CurrencyApplyRequest, timeoutMs = 8_000): Promise<RpcResult<CurrencyApplyData>> =>
  rpcCall<CurrencyApplyData>(CURRENCY_RPC, RPC_PATTERNS.currencyApply, req, timeoutMs);

/**
 * 档位表的规范序重建（数组顺序保留；字段按 name→baseScore→entryFeePercent 固定）。
 */
const canonicalLevels = (v: unknown): string =>
  JSON.stringify(
    ((v ?? []) as BaseScoreLevel[]).map((r) => ({
      name: r.name,
      baseScore: r.baseScore,
      entryFeePercent: r.entryFeePercent ?? 0,
    })),
  );

/** 财务汇总的**源行**读数（共享脏栈 ⇒ 只断增量；行缺席 ⇒ 0/0）。 */
async function summarySourceDelta(
  admin: string,
  source: string,
  from: number,
  to: number,
): Promise<{ delta: number; flowCount: number }> {
  const res = await getJson<{ rows: Array<{ k: string; delta: number; flowCount: number }> }>(
    `/api/admin/wallet/summary?from=${from}&to=${to}`,
    admin,
  );
  if (res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`GET /api/admin/wallet/summary 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  const rows = (res.body.data?.rows ?? []).filter((r) => r.k === source);
  return {
    delta: rows.reduce((acc, row) => acc + row.delta, 0),
    flowCount: rows.reduce((acc, row) => acc + row.flowCount, 0),
  };
}

/** 财务汇总的**漏收块**读数（同上：只断增量）。 */
async function summaryEntryFeeSkips(
  admin: string,
  from: number,
  to: number,
): Promise<{ cnt: number; players: number; amount: number }> {
  const res = await getJson<{ entryFeeSkips: { cnt: number; players: number; amount: number } }>(
    `/api/admin/wallet/summary?from=${from}&to=${to}`,
    admin,
  );
  if (res.body?.code !== ErrCode.OK || res.body.data?.entryFeeSkips === undefined) {
    throw new ConformanceError(`GET /api/admin/wallet/summary 失败（缺 entryFeeSkips）：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.entryFeeSkips;
}

/** 财务汇总的 **burn 块**读数（C26：台费不得污染结算销毁块）。 */
async function summaryBurnBlock(
  admin: string,
  from: number,
  to: number,
): Promise<{ residue: number; rake: number; unrecordedOps: number }> {
  const res = await getJson<{ burn: { residue: number; rake: number; unrecordedOps: number } }>(
    `/api/admin/wallet/summary?from=${from}&to=${to}`,
    admin,
  );
  if (res.body?.code !== ErrCode.OK || res.body.data?.burn === undefined) {
    throw new ConformanceError(`GET /api/admin/wallet/summary 失败（缺 burn）：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.burn;
}

/** 管理面拆笔预充（照 slice-18 runGoldGame 的形态；返回**最终**读数）。 */
async function precharge(admin: string, userId: string, label: string): Promise<number | null> {
  let lastBalance: number | null = null;
  for (let op = 1; op <= PRE_CHARGE_OPS; op += 1) {
    const res = await adminAdjust(admin, userId, PRE_CHARGE_STEP, AID(`${label}-pre-${op}`));
    if (res.status !== 200 || res.code !== ErrCode.OK) {
      throw new ConformanceError(`预充第 ${op} 笔失败 HTTP ${res.status} code=${res.code}（user=${userId}）`);
    }
    lastBalance = res.balanceAfter;
  }
  return lastBalance;
}

/**
 * 管理面拆笔归零（`precharge` 的镜像；返回**最终**读数）。
 *
 * ⚠️ **任务书字面修正（T9 实施期）**：任务书原写单笔 `adminAdjust(−PRE_CHARGE_TOTAL)`——
 * 但 admin_adjust 的单笔 upper bound 是协议缺省 `MAX_ABS_DELTA` = 1,000,000（无 source 化
 * 豁免，`currency.test.ts` 有「delta ±1,000,000」边界用例与端点注释互锁）⇒ 单笔 −5e6
 * 必 400/10001，构造必挂。改为 5 笔 ×−1e6（与 `precharge` 同拆分，终值同为 0）。
 */
async function zeroBalance(admin: string, userId: string, label: string): Promise<number | null> {
  let lastBalance: number | null = null;
  for (let op = 1; op <= PRE_CHARGE_OPS; op += 1) {
    const res = await adminAdjust(admin, userId, -PRE_CHARGE_STEP, AID(`${label}-zero-${op}`));
    if (res.status !== 200 || res.code !== ErrCode.OK) {
      throw new ConformanceError(`归零第 ${op} 笔失败 HTTP ${res.status} code=${res.code}（user=${userId}）`);
    }
    lastBalance = res.balanceAfter;
  }
  return lastBalance;
}

// ────────────────────────────────────────────────────────────────────────────
// 主用例
// ────────────────────────────────────────────────────────────────────────────

export async function runSlice25(): Promise<Checks> {
  const checks = new Checks();
  let admin = await adminLogin();
  /** finally 兜底：还开着的房间客户端（R156 —— 失败路径也必须收干净）。 */
  const openRooms: FreshRoom[] = [];
  /** 本 run 登记的本 run owner（收尾 info 落档；增量断言口径，不做行硬清——照 slice-18 脏栈容忍）。 */
  const harnessOwners: string[] = [];
  /** 档位表语义快照（进入前取得；finally 兜底用）。null = 尚未取得或已恢复。 */
  let levelsForWrite: BaseScoreLevel[] | null = null;

  try {
    // ══════════════════════════════════════════════════════════════════════
    // ⓪ 起手自证 + 清源
    // ══════════════════════════════════════════════════════════════════════
    step('⓪ 起手：五个容器 healthy + gold 队列清源（陈旧票会污染本片的局）');
    for (const container of HEALTH_CONTAINERS) {
      const h = await waitContainerHealthy(container);
      checks.that(h.ok, `⓪ ${container} healthy（${h.last}）`);
    }
    const purged = purgeGoldQueues();
    info(`清源：删除 gold 队列键 ${purged.deletedQueues} 个、gold 票 meta ${purged.deletedMetas} 个`);
    checks.eq(scanRedisKeys('match:queue:gold:*').length, 0, '⓪ 清源后 match:queue:gold:* 无键');
    checks.eq(goldMetaCount(), 0, '⓪ 清源后 gold 票的 match:meta 无残留');

    // ══════════════════════════════════════════════════════════════════════
    // A 费率临时开启 + 起手读数
    // ══════════════════════════════════════════════════════════════════════
    step('A：快照档位表 → 临时把 15 档台费改为 10% ⇒ room-service 快照生效 + 起手读数');
    const levelsBefore = (await adminGetConfigValue(admin, LEVELS_KEY)) as BaseScoreLevel[] | undefined;
    if (
      !Array.isArray(levelsBefore) ||
      levelsBefore.length === 0 ||
      !levelsBefore.some((l) => l.baseScore === 15)
    ) {
      throw new ConformanceError(
        `前置不满足：${LEVELS_KEY} 必须是非空数组且含 15 档（实际 ${JSON.stringify(levelsBefore)}）`,
      );
    }
    levelsForWrite = levelsBefore.map((l) => ({ ...l, entryFeePercent: l.entryFeePercent ?? 0 }));
    const levelsFeeOn = levelsForWrite.map((l) =>
      l.baseScore === 15 ? { ...l, entryFeePercent: 10 } : l,
    );
    const feeOn = await putConfigAndWaitEffect(admin, LEVELS_KEY, levelsFeeOn, 'room-service');
    checks.that(
      feeOn.putCode === ErrCode.OK && feeOn.refreshOk,
      `A PUT ${LEVELS_KEY} ⇒ 200 且 room-service 快照生效（version=${feeOn.expected} 计数 ${feeOn.baseline}→${feeOn.observed}）`,
    );
    checks.eq(
      canonicalLevels(await adminGetConfigValue(admin, LEVELS_KEY)),
      canonicalLevels(levelsFeeOn),
      'A PUT 后 GET 确认 = 临时档位表（15⇒10%；规范序重建后比较）',
    );
    const WIN_FROM = 0;
    const sumBase = await summarySourceDelta(admin, 'entry_fee', WIN_FROM, Date.now());
    const skipsBase = await summaryEntryFeeSkips(admin, WIN_FROM, Date.now());
    const burnBase = await summaryBurnBlock(admin, WIN_FROM, Date.now());
    const metricsBase = readRoomMetrics();
    const skippedBase = seriesValue(metricsBase, 'entry_fee_skipped_total', { reason: 'insufficient_funds' }) ?? 0;

    // ══════════════════════════════════════════════════════════════════════
    // B C32 真栈收费（完整金币局）
    // ══════════════════════════════════════════════════════════════════════
    step('B C32：两真人预充 → 金币局（费率 15⇒10%）→ 逐人 entry_fee op（形状/金额=公式/refId）+ 余额=扣后 + 回写键 + summary 源行增量；C26 两列 NULL/漏收块不增；打完整局');
    const humans: HarnessUser[] = [await registerUser(0), await registerUser(1)];
    harnessOwners.push(humans[0]!.id, humans[1]!.id);

    // 玩家面断言（config-service 面）：收费金额只证明 room-service 从档位表派生；
    // 这里证明 `/api/config` 的 `baseScoreLevels` 与同一真源（客户端入场费不再读派生字段）。
    const cfgRes = await getJson<{
      baseScoreLevels: BaseScoreLevel[];
    }>('/api/config', humans[0]!.accessToken);
    checks.eq(cfgRes.status, 200, 'B GET /api/config 状态');
    checks.eq(
      canonicalLevels(cfgRes.body?.data?.baseScoreLevels),
      canonicalLevels(levelsFeeOn),
      'B /api/config 的 baseScoreLevels = 临时档位表（15⇒10%，其余按快照）',
    );
    checks.that(
      !('entryFeePercents' in (cfgRes.body?.data ?? {})),
      'B /api/config 不含派生字段 entryFeePercents（阶段 2）',
    );
    for (const [i, user] of humans.entries()) {
      const last = await precharge(admin, user.id, `c32-h${i + 1}`);
      checks.eq(last, PRE_CHARGE_TOTAL, `B 真人 ${i + 1} 拆 ${PRE_CHARGE_OPS} 笔 ×${PRE_CHARGE_STEP} 预充后 = ${PRE_CHARGE_TOTAL}`);
    }
    const roomB = await startFreshRoom('S25B', {
      mode: 'gold',
      baseScore: MATCH_BASE_SCORE,
      humans: GOLD_HUMANS,
      users: humans,
    });
    openRooms.push(roomB); // R156：创建即 push
    checks.that(roomB.roomCode.length > 0, `B 已开局：roomCode=${roomB.roomCode}（${GOLD_HUMANS} 真人经补位窗口）`);

    for (const user of humans) {
      const actionId = `entryfee:${roomB.roomCode}:${user.id}`;
      const hit = await pollUntil(
        () => mysqlText(`SELECT COUNT(*) FROM currency_ops WHERE action_id='${actionId}'`),
        (v) => v === '1',
        20_000,
      );
      checks.that(hit.ok, `B 收费 op 落库 actionId=${actionId}（20s 轮询）—— 实际 ${JSON.stringify(hit.last)}`);
    }
    checks.eq(
      mysqlText(
        `SELECT CONCAT(o.source,':',o.ref_id,':',f.delta) FROM currency_ops o JOIN currency_flows f ON f.op_id=o.id WHERE o.action_id='entryfee:${roomB.roomCode}:${humans[0]!.id}'`,
      ),
      `entry_fee:${roomB.roomCode}:-${ENTRY_FEE_AMOUNT}`,
      'B 单人 op 形状：source=entry_fee / refId=房号 / delta=−fee（fee = max(1, floor(15×10%)) = 1）',
    );
    checks.eq(
      mysqlText(`SELECT COUNT(*) FROM currency_ops WHERE source='entry_fee' AND ref_id='${roomB.roomCode}'`),
      String(GOLD_HUMANS),
      `B 本房 entry_fee op 恰 ${GOLD_HUMANS} 条（机器人零条）`,
    );
    for (const user of humans) {
      const acct = await adminAccounts(admin, user.id);
      checks.eq(acct.balance, PRE_CHARGE_TOTAL - ENTRY_FEE_AMOUNT, `B 余额 = 预充 − fee（管理面直读；user=${user.id}）`);
    }
    for (const [seat] of roomB.bySeat.entries()) {
      const read = await pollUntil(
        () => redisCliText(['HGET', `room:${roomB.roomCode}:balances`, String(seat)]),
        (v) => v === String(PRE_CHARGE_TOTAL - ENTRY_FEE_AMOUNT),
        10_000,
      );
      checks.that(
        read.ok,
        `B 派生键 room:{code}:balances seat=${seat} = 扣后（回写生效）—— 实际 ${JSON.stringify(read.last)}`,
      );
    }
    const sumAfter = await summarySourceDelta(admin, 'entry_fee', WIN_FROM, Date.now());
    checks.eq(sumAfter.delta - sumBase.delta, -ENTRY_FEE_AMOUNT * GOLD_HUMANS, 'C32 summary 源行 entry_fee 增量 = 收款合计（−2×1）');
    checks.eq(sumAfter.flowCount - sumBase.flowCount, GOLD_HUMANS, 'C32 summary 源行 flowCount 增量 = 真人条数');
    checks.eq(
      mysqlText(
        `SELECT COUNT(*) FROM currency_ops WHERE ref_id='${roomB.roomCode}' AND source='entry_fee' AND (burned_residue IS NOT NULL OR burned_rake IS NOT NULL)`,
      ),
      '0',
      'C26 台费 op burned_residue/burned_rake 两列恒 NULL',
    );
    const burnMid = await summaryBurnBlock(admin, WIN_FROM, Date.now());
    checks.eq(
      JSON.stringify({
        r: burnMid.residue - burnBase.residue,
        k: burnMid.rake - burnBase.rake,
        u: burnMid.unrecordedOps - burnBase.unrecordedOps,
      }),
      JSON.stringify({ r: 0, k: 0, u: 0 }),
      'C26 burn 块不因台费变化（本局尚未结算：residue/rake/unrecordedOps 增量全 0）',
    );
    await playFullGameToEnd(roomB, 'B C32 完整金币局');
    const settleB = await roomB.clients[0]!.waitFor('game.settlement', 10_000);
    checks.that(
      (settleB.payload as { roomCode: string }).roomCode === roomB.roomCode,
      'B 完整局收束：game.settlement 到达且 roomCode 一致',
    );

    // ══════════════════════════════════════════════════════════════════════
    // C C25 报表面（ops/CSV；summary 已在 B 断；提现口径沿用 payment 面——头注登记）
    // ══════════════════════════════════════════════════════════════════════
    step('C C25：entry_fee 源进 ops 列表与 flows CSV（过滤白名单自动放行新源）');
    const opsFee = await getJson<{ rows: Array<{ actionId: string; source: string }> }>(
      '/api/admin/wallet/ops?source=entry_fee&limit=50',
      admin,
    );
    checks.eq(opsFee.body?.code, ErrCode.OK, 'C ops?source=entry_fee ⇒ code 0（allowlist 放行新源）');
    const feeRows = (opsFee.body?.data?.rows ?? []).filter((r) => r.actionId.startsWith(`entryfee:${roomB.roomCode}:`));
    checks.eq(feeRows.length, GOLD_HUMANS, 'C ops 列表含本房两条 entry_fee（source 过滤 + 房号维度）');
    const csvFee = await getJson('/api/admin/wallet/ops.csv?source=entry_fee', admin);
    const csvText = String((csvFee.body as { message?: unknown } | null)?.message ?? '');
    checks.that(csvText.includes(`entryfee:${roomB.roomCode}:`), 'C flows CSV 含本房 entry_fee 行（CSV 自动含新源）');

    // ══════════════════════════════════════════════════════════════════════
    // D C33 免单（管理端扣减构造 14001）
    // ══════════════════════════════════════════════════════════════════════
    step('D C33：u1 入队后管理端扣减归零 → 局照开 → 该人 skips 行 + 指标/日志 + summary 漏收块 +1；同房另一人照收（归因精确到人）');
    admin = await adminLogin(); // 写桶纪律（X-Admin 非 GET 计 30 次/5 分钟）——D 段续跑换令牌
    const u1 = await registerUser(2);
    const u2 = await registerUser(3);
    harnessOwners.push(u1.id, u2.id);
    for (const [i, user] of [u1, u2].entries()) {
      checks.eq(await precharge(admin, user.id, `c33-h${i + 1}`), PRE_CHARGE_TOTAL, `D 预充 ${user.id} = ${PRE_CHARGE_TOTAL}`);
    }

    const roomPromise = startFreshRoom('S25C', {
      mode: 'gold',
      baseScore: MATCH_BASE_SCORE,
      humans: GOLD_HUMANS,
      users: [u1, u2],
    });
    const queued = await pollUntil(() => goldQueueScore(u1.id, MATCH_BASE_SCORE), (v) => v !== '', 15_000);
    if (!queued.ok) {
      await roomPromise.catch(() => undefined); // 先吞在途 promise（防 unhandled rejection）再抛
      throw new ConformanceError(`D 构造① 失败：u1 未在 15s 内入队（ZSCORE=${JSON.stringify(queued.last)}）`);
    }
    checks.that(queued.ok, 'D 构造①：u1 已入队（**先入队后扣**是 14001 构造本身——门槛只在入队时查，D8 窗口）');
    let zeroed: number | null;
    try {
      zeroed = await zeroBalance(admin, u1.id, 'c33');
    } catch (err) {
      await roomPromise.catch(() => undefined); // 先吞在途 promise（防 unhandled rejection）再抛
      throw err;
    }
    if (zeroed !== 0) {
      await roomPromise.catch(() => undefined);
      throw new ConformanceError(`D 构造② 失败：管理端扣减后余额 ≠ 0（实际 ${JSON.stringify(zeroed)}）`);
    }
    checks.eq(zeroed, 0, 'D 构造②：管理端扣减 ⇒ 余额归零（入队后、开局前；5 笔 ×−1e6 镜像预充）');
    const roomC = await roomPromise;
    openRooms.push(roomC);
    checks.that(
      roomC.roomCode.length > 0 && roomC.roomCode !== roomB.roomCode,
      `D 局照开：roomCode=${roomC.roomCode}`,
    );

    const u2Hit = await pollUntil(
      () => mysqlText(`SELECT COUNT(*) FROM currency_ops WHERE action_id='entryfee:${roomC.roomCode}:${u2.id}'`),
      (v) => v === '1',
      20_000,
    );
    checks.that(u2Hit.ok, `D 同房另一人照收（u2 op 落库）—— 实际 ${JSON.stringify(u2Hit.last)}`);
    const u1Seat = [...roomC.bySeat.entries()].find(([, c]) => c.user.id === u1.id)?.[0];
    if (u1Seat === undefined) throw new ConformanceError('D：roomC.bySeat 找不到 u1 的座位（座位表不变量破坏）');
    const skipHit = await pollUntil(
      () =>
        mysqlQuery(
          `SELECT CONCAT(reason,':',seat,':',base_score,':',fee_amount,':',game_type) FROM currency_entry_fee_skips WHERE room_code='${roomC.roomCode}' AND owner_id='${u1.id}'`,
        ).out,
      (out) => out.includes('insufficient_funds'),
      20_000,
    );
    checks.that(skipHit.ok, `D skips 行落库（20s 轮询）—— 实际 ${JSON.stringify(skipHit.last)}`);
    checks.eq(
      mysqlText(
        `SELECT CONCAT(reason,':',seat,':',base_score,':',fee_amount) FROM currency_entry_fee_skips WHERE room_code='${roomC.roomCode}' AND owner_id='${u1.id}'`,
      ),
      `insufficient_funds:${u1Seat}:${MATCH_BASE_SCORE}:${ENTRY_FEE_AMOUNT}:doudizhu`,
      'C33 skips 行逐字段（reason/seat/baseScore/feeAmount/gameType）',
    );
    const metricsAfter = readRoomMetrics();
    checks.that(
      (seriesValue(metricsAfter, 'entry_fee_skipped_total', { reason: 'insufficient_funds' }) ?? 0) >= skippedBase + 1,
      'C33 指标增量：entry_fee_skipped_total{reason="insufficient_funds"} ≥ +1',
    );
    const skipLog = await pollUntil(
      () =>
        ndjson('room-service', 300).filter(
          (r) => String(r.msg).includes('entry_fee.skipped') && String(r.msg).includes(`roomCode=${roomC.roomCode}`),
        ),
      (rows) => rows.length > 0,
      20_000,
    );
    checks.that(skipLog.ok, 'C33 逐笔日志：entry_fee.skipped 且含 roomCode（NDJSON）');
    checks.that(
      skipLog.ok &&
        skipLog.last.some(
          (r) =>
            String(r.msg).includes('reason=insufficient_funds') &&
            String(r.msg).includes(`ownerId=${u1.id}`) &&
            String(r.msg).includes(`opActionId=entryfee:${roomC.roomCode}:${u1.id}`),
        ),
      'C33 日志字段逐笔在场（ownerId/reason/opActionId；绝不合并）',
    );
    const skipsAfter = await summaryEntryFeeSkips(admin, WIN_FROM, Date.now());
    checks.eq(skipsAfter.cnt - skipsBase.cnt, 1, 'C33 summary 漏收块 cnt 增量 = +1');
    checks.eq(skipsAfter.amount - skipsBase.amount, ENTRY_FEE_AMOUNT, 'C33 summary 漏收块 amount 增量 = fee');
    checks.eq((await adminAccounts(admin, u1.id)).balance, 0, 'C33 该人余额不变（未收；开打前时刻读）');
    await playFullGameToEnd(roomC, 'D C33 完整金币局');

    // ══════════════════════════════════════════════════════════════════════
    // E C34 重放 / 冲突（真栈可构造半边）
    // ══════════════════════════════════════════════════════════════════════
    step('E C34：对 B 组同一锚直投（同载荷 ⇒ replayed:true 钱不动 + 历史余额；异载荷 ⇒ 14002）；room 侧「同房二开重放」= 并发竞态 ⇒ 判据落单测（登记）');
    info(
      'E 登记（C34 预置口径，规格评审 E 组结论）：room-service 的「第二次 startRoom 触发同锚重放」是并发竞态' +
        '（正常单入口在 waiting 守卫处早返）⇒ 真栈不可稳定构造，判据 = room-service 单测 rooms.entry-fee.test.ts 的 C12' +
        '（同锚同载荷 + 重放回写）；本组只收可确定性构造的重放/冲突半边。',
    );
    const b1 = humans[1]!;
    const b1Action = `entryfee:${roomB.roomCode}:${b1.id}`;
    const replay = await rpcApply({
      actionId: b1Action,
      source: 'entry_fee',
      entries: [{ ownerId: b1.id, delta: -ENTRY_FEE_AMOUNT }],
      refId: roomB.roomCode,
    });
    checks.that(replay.ok === true && replay.data.replayed === true, `E 同锚同载荷直投 ⇒ replayed:true —— 实际 ${JSON.stringify(replay)}`);
    if (replay.ok) {
      checks.eq(
        JSON.stringify(replay.data.entries),
        JSON.stringify([{ ownerId: b1.id, balanceAfter: PRE_CHARGE_TOTAL - ENTRY_FEE_AMOUNT }]),
        'E 重放返回历史余额（balanceAfter = 收费当刻值，钱未再动）',
      );
    }
    const conflict = await rpcApply({
      actionId: b1Action,
      source: 'entry_fee',
      entries: [{ ownerId: b1.id, delta: -ENTRY_FEE_AMOUNT - 1 }],
      refId: roomB.roomCode,
    });
    checks.that(
      conflict.ok === false && conflict.code === ErrCode.E_ACTION_CONFLICT,
      `E 同锚异载荷直投 ⇒ 14002（同 id 不同内容）—— 实际 ${JSON.stringify(conflict)}`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // 收尾：费率还原（知基线值）+ 读数自证 + 队列零残留
    // ══════════════════════════════════════════════════════════════════════
    step('收尾：档位表还原为进入前的语义快照 + GET 确认 + 玩家面派生确认 + 队列零残留');
    if (levelsForWrite === null) throw new ConformanceError('收尾时缺少档位表快照（不应发生）');
    const feeOff = await putConfigAndWaitEffect(admin, LEVELS_KEY, levelsForWrite, 'room-service');
    checks.that(
      feeOff.putCode === ErrCode.OK && feeOff.refreshOk,
      `收尾 PUT ${LEVELS_KEY} ⇒ 200 且 room-service 快照生效（version=${feeOff.expected}）`,
    );
    checks.eq(
      canonicalLevels(await adminGetConfigValue(admin, LEVELS_KEY)),
      canonicalLevels(levelsForWrite),
      '收尾读数自证：档位表 = 进入前的语义快照 —— 不得静默留下收费态',
    );
    const cfgOff = await getJson<{
      baseScoreLevels: BaseScoreLevel[];
    }>('/api/config', humans[0]!.accessToken);
    checks.eq(
      canonicalLevels(cfgOff.body?.data?.baseScoreLevels),
      canonicalLevels(levelsForWrite),
      '收尾 /api/config 的 baseScoreLevels = 快照（玩家面无残留收费态）',
    );
    levelsForWrite = null;
    checks.eq(scanRedisKeys('match:queue:gold:*').length, 0, '收尾：match:queue:gold:* 零键（零残留）');
    checks.eq(goldMetaCount(), 0, '收尾：gold 票 meta 零残留');
    info(`本 run 的 owner 登记（harnessOwners；增量断言口径，不做行硬清）：${harnessOwners.join(', ')}`);

    for (const room of openRooms) for (const c of room.clients) c.close();
    return checks;
  } finally {
    // ── 兜底复原（成败皆然）──────────────────────────────────────────────
    // 正常路径已还原并断言；这里兜「前文抛错或被中断」。整段吞错只 info：
    // 兜底复原**不许**顶掉原始结论（照 slice-18 的 finally 形态）。
    try {
      for (const room of openRooms) for (const c of room.clients) c.close();
      if (levelsForWrite !== null) {
        await adminPutConfig(LEVELS_KEY, levelsForWrite, admin);
        info(`finally 兜底：${LEVELS_KEY} 已尽力写回进入前的语义快照`);
      } else {
        info('finally 兜底：档位表快照未取得或已恢复，跳过写回');
      }
    } catch (err) {
      info(
        `兜底复原失败（不影响原始结论；手动检查 ${LEVELS_KEY} 是否已回快照）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

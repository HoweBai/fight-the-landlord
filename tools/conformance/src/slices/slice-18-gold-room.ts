/**
 * conformance 用例：**金币场（② 金币场 T12）** —— 真栈判据（规格 §12.1 的 A–J 十组）。
 *
 * ─── 编排顺序与理由（为什么是这个序）────────────────────────────────────────
 *  ⓪ 起手自证 + 清源：五个容器 healthy（room/user/currency/gateway/config）+ **金币队列清源**
 *     （`match:queue:gold:*` 与 gold 票的 `match:meta:*`——E 组的补位谓词是「队里恰好这两个
 *     真人」，任何上一轮崩溃留下的陈旧票都会把第三个座位吃掉）；
 *  A 配置：`/api/config` 恰 21 键 + 内部键零泄漏 + 管理面全键种子 + 改金开关后生效；
 *  B 开关：gold 关 ⇒ 12010、开 ⇒ 不再 12010；free 关 ⇒ random 12010、恢复；
 *  C 门槛：0 余额 ⇒ 14003（含所需金额）→ 管理面补足 ⇒ 入队成功；
 *  D 取消排队（C21）：入队 → 探针（ZSCORE/meta 指纹，`slice-12:438-473` 先例）→ unmatch →
 *     三个可观测面全清 + 窗口内不被撮合（结构式负判据，含探针正/负对照）→ 再入队复核 12009；
 *  E 完整金币局：两真人**管理面预充 5,000,000（拆 5 笔 ×1e6）** + 60s 补位窗口的机器人 →
 *     打完整局 → 结算广播 + `game.balances` 恰 3 座 + **按结算前余额复算期望 delta 逐座比对**
 *     （复算内含截断/分摊/残差公式；**不直断和=0**）+ botId 局中读 + robots 账户形态 +
 *     战绩 moneyDelta = 实际变动；
 *  F 抽水：`game.doudizhu.rakePercent=10` 再打一局（同 E 口径）→ 赢家实收 = g − floor(g×10/100)、
 *     entries 和 = −(抽水+残差)（管理面读余额核对）→ 复原 0；
 *  G 救助（**广告片 T22 原位改写为新链驱动**）：GET 裁决 reason 面 + 签名 GET 回调样本
 *     （v1.4：query 八字段 + sha256(secret:trans_id)，终态 200 `{"isValid":true}`）
 *     四态确定性构造（granted=正路 / replayed=先 GET 签发、后 RPC 预置同锚流水、再投回调 /
 *     rejected×2=中途切开关·中途充值后回调）+「已领优先于余额闸」追加覆盖——H 组三桶
 *     数据源仍由本组承接；
 *  H 观测：room-service /metrics 六新指标名 + 终态/残差/补偿队列读数；currency-service
 *     /metrics 池与机器人 gauge 在场 + 救助三桶；Prometheus /api/v1/rules 恰 27 条
 *     （13 既有 + 3 金币 + 2 风控 + 5 支付 + 2 通知 + 2 救助）；
 *  I 对账：管理面 PUT 3s 间隔（`currency.reconcileIntervalMs`）+ 重起 currency-service ⇒ 跑够两轮 ⇒
 *     `currency_reconcile_drift_accounts==0`
 *     **与两个 robot gauge 的新鲜值**（默认 1h 间隔下启动轮早于 E 的池注资 ⇒ H 只断言序列
 *     在场、值断言落这里）⇒ PUT 回知基线 3600000 + 重起（slice-17 ⑨ 的先例，本片 ⚙️9）；⚠️ 放在 H **之后**
 *     （重起会清进程内计数 —— 救助三桶在 G 已计，H 的读数必须赶在它的重起之前）；
 *  J 记录：金币局记录 `mode='gold'` + 战绩列表含该局（复用 E 的 roomCode）。
 *  收尾：配置复原（gold=true〔2026-10-04 裁决后的种子态〕 / rake=0 / relief=false）+
 *  取回读数自证 + 队列零残留。
 *
 * ─── 手法先例（逐条对应）─────────────────────────────────────────────────
 *  - `compose()` / `exec()` / `mysqlQuery()` / `composeLogs()` / `ndjson()` / `pollUntil()` /
 *    `waitContainerHealthy()` / `execCurl()` / `parseProm()` / `sumMetric()` / `seriesValue()`：
 *    照 `slice-17-currency.ts`（货币片 T10 的同族助手；本片按需裁剪）。
 *  - **RPC 直投**（`CURRENCY_RPC` = compose override 的 3104）：造数与池抽干 —— 照 slice-17
 *    （**不碰**既有 `lib/rpc.ts` 的端点表）。
 *  - 驱动：`lib/ddz-driver`（T12 扩展：`mode/baseScore/humans/users` 参数化 +
 *    `playFullGameToEnd`（机器人回合推进自 slice-11 mustAdvance 区抽的共享 helper）+
 *    `readRoomBots`（slice-11:404-407 先例））。
 *  - **不 import `@fight-the-landlord/shared`**（R168：不拿被测实现当裁判）；`protocol`
 *    只用于契约常量（`ErrCode`/`RPC_PATTERNS`）；结算复算在**本文件内**按规格 §4 逐字重写
 *    （不是 import 生产实现）。
 *  - **零 `skip()`、零数据依赖分支**（基线静态回填的前提）：全部断言在任何环境下都执行，
 *    且每条 `checks.*` 都不落在「长度随数据变」的循环里（金币局的三座/两真人都是定长）。
 *
 * ─── 本片对真栈的副作用与复原 ────────────────────────────────────────────
 *  配置：`game.doudizhu.freeRoomEnabled` 临时 FALSE、`game.doudizhu.rakePercent` 临时 10、
 *  `currency.reliefEnabled` 临时 TRUE；`game.doudizhu.goldRoomEnabled` 的**种子已是 TRUE**
 *  （2026-10-04 用户裁决「金币场默认开」）—— A 组开头**确保**它开着（管理面 PUT，
 *  兼容旧库/上一轮留下的 false），B 组内临时 FALSE 后还原 —— 收官与 `finally`
 *  双重复原（阈值见 §1.1 种子）；注入 `currency.reconcileIntervalMs=3000`（管理面 PUT）重起
 *  currency-service（I 末即 PUT 回知基线 3600000）；管理面 `robot-pool` 注资 +1e6 与空闲机器人**抽干**
 *  （回收式，钱回池、不销毁）；注册的 harness 用户留库（既有切片同款，不做删除）。
 */
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import { resolve } from 'node:path';
import {
  CONFIG_KEYS,
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type CurrencyGetData,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import { HarnessClient } from '../lib/client';
import {
  INTERNAL_TOKEN,
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
  type HarnessUser,
  type HttpResult,
} from '../lib/http';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';
import { redisRaw, redisReplyText } from '../lib/redis';
import {
  MATCH_BASE_SCORE,
  playFullGameToEnd,
  readRoomBots,
  sendThrottled,
  startFreshRoom,
  type FreshRoom,
} from '../lib/ddz-driver';
import {
  AdCallbackSecretLoadError,
  loadAdCallbackSecret,
  signAdCallback,
  toQueryString,
  type AdCallbackFields,
  type AdCallbackParams,
} from '../lib/ad-callback';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-15）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** `currency.apply` / `currency.get` 的 TCP 监听（宿主直投 = compose override 的 `3104:3104`）。 */
const CURRENCY_RPC: RpcEndpoint = {
  host: process.env.CURRENCY_RPC_HOST ?? 'localhost',
  port: Number(process.env.CURRENCY_RPC_PORT ?? 3104),
};

const PROM_URL = process.env.PROM_URL ?? 'http://localhost:9090';

/** G 组（广告片 T22 新链）：门口 HTTPS 口（回调样本经它投递——同时验收 Caddy
 *  `handle /ad/notify/*`；照 slice-21/24 的 `EDGE_HTTPS_PORT` 形态）。 */
const EDGE_HTTPS_PORT = process.env.EDGE_HTTPS_PORT ?? '8443';

/** G 组：公开回调路径（**精确豁免对钉**的消费面；字面写死 = wire 级断言，不引实现常量）。 */
const AD_NOTIFY_PATH = '/ad/notify/uniad';

/** G 组回调 adpid 探针值（base62 合法；wire 八字段之一，仅信息性——身份只来自 extra claim）。 */
const CALLBACK_ADPID = 's18ProbeAdpid';

/**
 * 回调密钥（**惰性单例**：fixtures/ad-callback/callback-secret.txt，与栈 PUT 值 byte-exact 同源）。
 * 不得模块顶层装载——run.ts 静态 import 全部 slice，缺夹具时 `--list`/其它片会启动即崩。
 */
let cachedAdSecret: string | null = null;
const adSecret = (): string => (cachedAdSecret ??= loadAdCallbackSecret());

/** §12.1 A 组：`/api/config` 的**恰好**键集（排序后逐字；记牌器收费片起 = 20 键——
 *  阶段 2 已删除派生字段 `entryFeePercents`；
 *  `reliefAdpid` 插于 `rechargePackages`/`reliefEnabled` 间，UTF-16 `'A'<'E'`）。 */
const CLIENT_CONFIG_KEYS_SORTED =
  'baseScoreLevels,cardCounterEnabled,cardCounterPricePerGameCoins,cardCounterPricePerHourCoins,coinPerYuan,entryMultiplier,freeRoomEnabled,friendRoomEnabled,games,goldRoomEnabled,rechargeEnabled,rechargePackages,reliefAdpid,reliefEnabled,reliefThresholdCoins,version,withdrawDailyMaxCoins,withdrawEnabled,withdrawMaxCoinsPerOrder,withdrawMinCoins,withdrawReAuthEnabled';

/** §12.1 A 组：内部键零泄漏的**显式名单**（+ 全量 `currency.` 前缀扫描兜底）。 */
const INTERNAL_KEY_NAMES = ['currency.signupGrant', 'game.doudizhu.rakePercent', 'currency.reliefAmount'] as const;

/** §1.1 的六新键（A 组对管理面 65 键的核对名单）。 */
const NEW_KEYS = [
  'game.doudizhu.freeRoomEnabled',
  'game.doudizhu.goldRoomEnabled',
  'game.doudizhu.entryMultiplier',
  'game.doudizhu.rakePercent',
  'currency.reliefEnabled',
  'currency.reliefAmount',
] as const;

/** §11.2 的三条新告警规则名（H 组；总数 18（风控 T11 同步）+ 全名单由 slice-16 承接）。 */
const NEW_ALERT_RULES = ['CurrencySettleOutboxStuck', 'CurrencyReconcileDrift', 'CurrencyRobotPoolLow'] as const;

/** E/F 的两真人预充（规格 §12.1：5,000,000 = 5 笔 ×1e6；admin 单笔上限 1e6）。 */
const PRE_CHARGE_TOTAL = 5_000_000;
const PRE_CHARGE_STEP = 1_000_000;
const PRE_CHARGE_OPS = PRE_CHARGE_TOTAL / PRE_CHARGE_STEP;

/** E/F 每局的真人数量（补位窗口 30s 由驱动承接）。 */
const GOLD_HUMANS = 2;

/** G 组：救助金额种子（§1.1 第 17 键缺省 200）与门槛公式（15 × entryMultiplier）。 */
const RELIEF_AMOUNT_SEED = 200;

/**
 * I 组对账的注入值（本片 ⚙️9 换源：管理面 PUT `currency.reconcileIntervalMs` —— 旧 env 注入面
 * 已退役；3s 一轮）。数值型：`parseIntervalMs` 拒字符串。
 */
const RECONCILE_INTERVAL_INJECT = 3000;
/** I 组的还原**知基线值**（= stack 种子 = 代码缺省 1h；还原不写「现值」）。 */
const RECONCILE_INTERVAL_RESTORE = 3_600_000;

/**
 * 本 run 的动作号后缀（照 slice-15/17 的 per-run 后缀纪律：同栈「先单跑、后全序」跑两遍，
 * 固定 actionId 会让「首发」在第二遍变成幂等重放）。字符集 ⊆ [0-9A-Za-z]，进 actionId 安全。
 */
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-4);
const AID = (s: string): string => `s18-${RUN_TAG}-${s}`;

// ────────────────────────────────────────────────────────────────────────────
// docker / mysql / redis / metrics 助手（形态先例见文件头）
// ────────────────────────────────────────────────────────────────────────────

interface CommandResult {
  code: number;
  out: string;
}

/** `docker compose …`（照 slice-15 / slice-17 的 spawnSync 手型，逐字同参）。 */
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

/** currency-service 的 `/metrics` 全文（9004）。 */
function readCurrencyMetrics(): string {
  return execCurl('ftl-currency-service', 9004, '/metrics', INTERNAL_TOKEN).body;
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

/** 某指标全部序列的值求和（缺席 = 0）。 */
function sumMetric(text: string, name: string): number {
  return parseProm(text)
    .filter((s) => s.name === name)
    .reduce((acc, s) => acc + (Number.isFinite(s.value) ? s.value : 0), 0);
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

/** `EXISTS match:meta:<userId>` 的布尔读法。 */
function matchMetaExists(userId: string): boolean {
  return redisCliText(['EXISTS', `match:meta:${userId}`]) === '1';
}

/** `HGET match:meta:<userId> mode`（meta 不在 ⇒ 空串）。 */
function matchMetaField(userId: string, field: string): string {
  return redisCliText(['HGET', `match:meta:${userId}`, field]);
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
// 管理面 / RPC / 配置生效 助手
// ────────────────────────────────────────────────────────────────────────────

const rpcApply = (req: CurrencyApplyRequest, timeoutMs = 8_000): Promise<RpcResult<CurrencyApplyData>> =>
  rpcCall<CurrencyApplyData>(CURRENCY_RPC, RPC_PATTERNS.currencyApply, req, timeoutMs);
const rpcGet = (ownerIds: string[], timeoutMs = 5_000): Promise<RpcResult<CurrencyGetData>> =>
  rpcCall<CurrencyGetData>(CURRENCY_RPC, RPC_PATTERNS.currencyGet, { ownerIds }, timeoutMs);

/** 直投 apply 并断言 `ok:true`（失败抛，带原始读数）。 */
function expectApplyOk(res: RpcResult<CurrencyApplyData>, what: string): CurrencyApplyData {
  if (!res.ok) {
    throw new ConformanceError(`${what}：期望 ok:true，实际 {ok:false, code=${res.code}, message=${res.message}}`);
  }
  return res.data;
}

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
    { userId, delta, reason: `slice18 ${RUN_TAG}`, actionId, ...(ownerType ? { ownerType } : {}) },
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

/** `GET /api/wallet/balance`（玩家面；只本人）。 */
async function playerBalance(user: HarnessUser): Promise<number> {
  const res = await getJson<{ balance: number }>('/api/wallet/balance', user.accessToken);
  if (res.status !== 200 || res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`玩家余额查询失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data!.balance;
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

/**
 * 匹配尝试的**有界轮询**（B 组用）：反复发 `room.match` 直到谓词成立。
 *
 * 副作用纪律：任一次尝试**成功入队**（code 0）时立刻 `room.unmatch` 清票 —— 否则队列里
 * 会留一张别人的票（E 组补位谓词要求「队里恰好两个真人」）。
 */
async function pollMatchUntil(
  client: HarnessClient,
  mode: 'random' | 'gold',
  predicate: (code: number) => boolean,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; code: number; message?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ack = await sendThrottled(client, 'room.match', { mode, baseScore: MATCH_BASE_SCORE }, 0);
    if (ack.code === ErrCode.OK) {
      const unmatch = await client.send('room.unmatch', {});
      if (unmatch.code !== ErrCode.OK) throw new ConformanceError(`轮询收尾 room.unmatch code=${unmatch.code}`);
    }
    if (predicate(ack.code)) return { ok: true, code: ack.code, message: ack.message };
    if (Date.now() >= deadline) return { ok: false, code: ack.code, message: ack.message };
    await sleep(1_000);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// E/F：结算复算（规格 §4 逐字，在本文件内独立重写 —— 不是 import 生产实现）
// ────────────────────────────────────────────────────────────────────────────

interface SettlementWire {
  roomCode: string;
  baseScore: number;
  winner: 'landlord' | 'farmer';
  landlordSeat: number;
  farmerSeats: number[];
  multiplier: number;
  spring: 'none' | 'spring' | 'anti-spring';
  landlordScoreChange: number;
  farmerScoreChange: number;
}

interface SettleRecount {
  /** seat 升序的期望 delta（含 0）。 */
  expected: number[];
  /** 输光截断前的应付池 `P`。 */
  pool: number;
  /** `P − Σg`（∈ [0, 赢家数)）。 */
  residue: number;
  /** 赢家数（residue 的上界用）。 */
  winners: number;
  rakeTotal: number;
}

/**
 * 期望 delta 复算（规格 §4 公式**逐字**）：
 * ```
 * raw[i]   = seat i 是 landlord ? landlordScoreChange : farmerScoreChange
 * 输家:  pay = min(−raw, 结算前余额);  delta = −pay;  P += pay
 * 赢家:  g = floor(raw × P / Σraw[赢家]);  rake = floor(g × rakePercent / 100);  delta = g − rake
 * residue = P − Σg
 * ```
 * **不直断「和 = 0」**（炸弹局会因机器人侧截断产生残差）：族内恒等式是
 * `Σdelta = −(residue + rakeTotal)`。
 */
function recountSettlement(
  s: SettlementWire,
  preBalances: Map<number, number>,
  rakePercent: number,
): SettleRecount {
  const seats = [0, 1, 2];
  const raw = seats.map((seat) => (seat === s.landlordSeat ? s.landlordScoreChange : s.farmerScoreChange));
  const expected = seats.map(() => 0);
  let pool = 0;
  seats.forEach((_, i) => {
    if (raw[i]! < 0) {
      const pay = Math.min(-raw[i]!, preBalances.get(seats[i]!) ?? 0);
      expected[i] = pay === 0 ? 0 : -pay;
      pool += pay;
    }
  });
  const winnerIdx = seats.map((_, i) => i).filter((i) => raw[i]! > 0);
  const rawWinSum = winnerIdx.reduce((acc, i) => acc + raw[i]!, 0);
  let gainedSum = 0;
  let rakeTotal = 0;
  for (const i of winnerIdx) {
    const gain = Math.floor((raw[i]! * pool) / rawWinSum);
    const rake = Math.floor((gain * rakePercent) / 100);
    expected[i] = gain - rake;
    gainedSum += gain;
    rakeTotal += rake;
  }
  return { expected, pool, residue: pool - gainedSum, winners: winnerIdx.length, rakeTotal };
}

/** 一局金币局的线上收束证据（结算广播 + balances + 复算输入）。 */
interface GoldGameEvidence {
  room: FreshRoom;
  settlement: SettlementWire;
  settlementVersion: number;
  balances: Array<{ seat: number; balance: number }>;
  balancesVersion: number;
  /** seat → 结算前余额（真人 = 入队前管理面读数；机器人 = 局中读数）。 */
  preBalances: Map<number, number>;
  /** 真人 seat → userId。 */
  humanSeats: Map<number, string>;
  robotSeat: number;
  botId: string;
}

/**
 * 两真人金币局：预充 → 入队（30s 补位窗口）→ 局中读 bots → 打完整局 → 收广播。
 *
 * 只做**机制**与**取证**（断言全部留在调用方）：超时/拒动一律抛。
 *
 * ⚠️ R156：房间**创建成功即入 `openRooms`**（slice-10「创建即 push」先例）—— 本函数中途
 *    任一步抛错时调用方拿不到返回值，只有创建即 push 过，`runSlice18` 的 finally 才收得到
 *    这些客户端并 close 掉（否则失败路径泄 socket）。
 */
async function runGoldGame(
  checks: Checks,
  admin: string,
  what: string,
  label: string,
  openRooms: FreshRoom[],
): Promise<GoldGameEvidence> {
  // 1) 两个真人 + 5 笔 ×1e6 预充（管理面单笔上限 1e6 ⇒ 拆笔）。
  const humans: HarnessUser[] = [await registerUser(0), await registerUser(1)];
  const humanSeats = new Map<number, string>();
  const preBalances = new Map<number, number>();
  for (const [i, user] of humans.entries()) {
    let lastBalance: number | null = null;
    for (let op = 1; op <= PRE_CHARGE_OPS; op += 1) {
      const res = await adminAdjust(admin, user.id, PRE_CHARGE_STEP, AID(`${label}-pre-${i + 1}-${op}`));
      if (res.status !== 200 || res.code !== ErrCode.OK) {
        throw new ConformanceError(`${what}：预充第 ${op} 笔失败 HTTP ${res.status} code=${res.code}`);
      }
      lastBalance = res.balanceAfter;
    }
    checks.eq(
      lastBalance,
      PRE_CHARGE_TOTAL,
      `${what}：真人 ${i + 1} 管理面拆 ${PRE_CHARGE_OPS} 笔 ×${PRE_CHARGE_STEP} 预充后 = ${PRE_CHARGE_TOTAL}`,
    );
  }

  // 2) 入队（两真人经 30s 补位窗口由机器人补第三席）。
  const room = await startFreshRoom(label, {
    mode: 'gold',
    baseScore: MATCH_BASE_SCORE,
    humans: GOLD_HUMANS,
    users: humans,
  });
  // R156：创建即 push（slice-10 先例）—— 后续步骤（读 bots / 打完整局 / 收广播）任一步抛错
  // 时 finally 也收得到本房的客户端。
  openRooms.push(room);

  // 3) 局中读 botId（局终 DEL ⇒ 只能局中读；slice-11:404-407 先例）。
  const bots = readRoomBots(room.roomCode);
  const botEntries = Object.entries(bots).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (botEntries.length !== 1) {
    throw new ConformanceError(`${what}：局中 room:${room.roomCode}:bots 应恰 1 席，实际 ${JSON.stringify(bots)}`);
  }
  const [robotSeatStr, botId] = botEntries[0]!;
  const robotSeat = Number(robotSeatStr);

  // 4) 结算前余额：真人 = 预充后读数（上面已置入）；机器人 = 局中读数（ensure 已完成）。
  for (const [i, user] of humans.entries()) {
    const seat = [...room.bySeat.entries()].find(([, c]) => c.label === `${label}${i}`)?.[0];
    if (seat === undefined) throw new ConformanceError(`${what}：找不到 ${label}${i} 的座位`);
    humanSeats.set(seat, user.id);
    preBalances.set(seat, PRE_CHARGE_TOTAL);
  }
  const robotAccount = await adminAccounts(admin, botId);
  preBalances.set(robotSeat, robotAccount.balance);

  // 5) 打完整局 + 收广播。
  const outcome = await playFullGameToEnd(room, what);
  void outcome;
  const settlements = await Promise.all(room.clients.map((c) => c.waitFor('game.settlement', 10_000)));
  const balancesMsgs = await Promise.all(room.clients.map((c) => c.waitFor('game.balances', 10_000)));
  const settlement = settlements[0]!.payload as SettlementWire;
  const balances = (balancesMsgs[0]!.payload as { balances: Array<{ seat: number; balance: number }> }).balances;
  return {
    room,
    settlement,
    settlementVersion: settlements[0]!.version as number,
    balances,
    balancesVersion: balancesMsgs[0]!.version as number,
    preBalances,
    humanSeats,
    robotSeat,
    botId,
  };
}

/** 从管理面 recentFlows 里取「这一局」的 game_settle 行（回写后可能被 afterSettle 的 refill 顶到第二行）。 */
function settleFlowDelta(flows: Array<{ delta: number; source: string }>): number | null {
  const hit = flows.find((f) => f.source === 'game_settle');
  return hit ? hit.delta : null;
}

/**
 * E/F 共用：一局金币局的**复算断言**（定长：2 条族内恒等式 + 3 座逐座 + 2 真人管理面读数 = 7）。
 *
 * ⚠️ **不直断「和 = 0」** —— 族内恒等式是 `Σdelta = −(residue + rakeTotal)`。
 */
async function assertGoldGame(
  checks: Checks,
  admin: string,
  ev: GoldGameEvidence,
  expectedRakePercent: number,
  what: string,
): Promise<SettleRecount> {
  const recount = recountSettlement(ev.settlement, ev.preBalances, expectedRakePercent);
  checks.that(
    recount.residue >= 0 && recount.residue < recount.winners,
    `${what}：残差落在 [0, 赢家数)（residue=${recount.residue}，赢家 ${recount.winners}）—— 复算口径：` +
      `P=${recount.pool} − Σg；炸弹局的机器人侧截断会在机器人赢时产生残差`,
  );
  const expectedSum = recount.expected.reduce((a, b) => a + b, 0);
  // 本式 = 复算**自检**（抓复算笔误），非产品判据；产品判别力由同函数逐座（game.balances 差）/
  // 管理面读数/流水比对承接（见下）。
  checks.eq(
    expectedSum,
    -(recount.residue + recount.rakeTotal),
    `${what}：复算 delta 和 = −(残差 ${recount.residue} + 抽水 ${recount.rakeTotal})（**不得**直断和=0）`,
  );
  // 逐座：结算广播的余额差 == 复算期望 delta（三座定长）。
  for (const seat of [0, 1, 2]) {
    const entry = ev.balances.find((b) => b.seat === seat);
    const actualDelta = entry === undefined ? NaN : entry.balance - (ev.preBalances.get(seat) ?? 0);
    checks.eq(
      actualDelta,
      recount.expected[seat]!,
      `${what}：seat ${seat} 实际 delta（game.balances）= 复算期望（实际 ${actualDelta}，期望 ${recount.expected[seat]!}）`,
    );
  }
  // 两真人：管理面（MySQL 直读）结算后余额 == 广播值（机器人座豁免 —— afterSettle 可能已补给，另断言）。
  for (const seat of [0, 1, 2]) {
    const ownerId = ev.humanSeats.get(seat);
    if (!ownerId) continue;
    const post = await adminAccounts(admin, ownerId);
    const entry = ev.balances.find((b) => b.seat === seat);
    checks.eq(
      post.balance,
      entry?.balance,
      `${what}：seat ${seat}（真人）管理面结算后余额 == 结算广播值（${post.balance} vs ${entry?.balance}）`,
    );
  }
  return recount;
}

// ────────────────────────────────────────────────────────────────────────────
// 战绩读取（E/J 共用）
// ────────────────────────────────────────────────────────────────────────────

interface MyRecordWire {
  roomCode: string;
  mode: string;
  endedAt: number;
  mySeat: number;
  moneyDelta: number | null;
}

/** 轮询本人战绩直到出现该局的 moneyDelta 回写（回写发生在结算收尾链，异步于广播）。 */
async function waitRecordWithDelta(
  token: string,
  roomCode: string,
  timeoutMs = 30_000,
): Promise<{ found: boolean; record: MyRecordWire | null; items: number }> {
  const read = await pollUntil(
    async () => {
      const res = await getJson<{ items: MyRecordWire[] }>('/api/records/mine', token);
      if (res.status !== 200 || res.body?.code !== ErrCode.OK) {
        throw new ConformanceError(`战绩查询失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
      const items = res.body.data!.items;
      return { items, record: items.find((r) => r.roomCode === roomCode) ?? null };
    },
    (v) => v.record !== null && v.record.moneyDelta !== null,
    timeoutMs,
  );
  return { found: read.ok, record: read.last.record, items: read.last.items.length };
}

// ────────────────────────────────────────────────────────────────────────────
// G 组（广告片 T22 新链）：GET 裁决读 + 签名回调样本 + 门口投递 + claim 记录读
// ────────────────────────────────────────────────────────────────────────────

/** `GET /api/wallet/relief[?claim=]` 的 data 形状（广告片 §2.5；经网关，本人）。 */
interface ReliefQueryData {
  eligible: boolean;
  grantedToday: boolean;
  amount: number;
  balance: number;
  claim?: string;
  reason?: string;
}

/** `GET /api/wallet/relief[?claim=]`（经网关；无 claim 入参 = 裁决 + eligible 时签发/复用）。 */
const getRelief = (user: HarnessUser, claim?: string): Promise<HttpResult<ReliefQueryData>> =>
  getJson<ReliefQueryData>(
    `/api/wallet/relief${claim === undefined ? '' : `?claim=${encodeURIComponent(claim)}`}`,
    user.accessToken,
  );

/** 读一条 claim 记录的 JSON（不存在/畸形 ⇒ null；T12 键形 `relief:claim:{nonce}`）。 */
function claimRecordJson(nonce: string): Record<string, unknown> | null {
  const raw = redisCliText(['GET', `relief:claim:${nonce}`]);
  if (raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 回调字段（v1.4 §2.4 wire 八字段；`user_id` 仅信息性——身份只来自 extra claim）。
 * `user_id` 取**空串**：与真机平台一致（未绑定用户时平台发 `user_id=`，2026-10-18 实抓）。
 */
const callbackFields = (_user: HarnessUser, extra: string, slug: string): AdCallbackFields => ({
  adpid: CALLBACK_ADPID,
  provider: 'china',
  platform: 'Android',
  trans_id: `s18-${RUN_TAG}-${slug}`,
  user_id: '',
  extra,
});

/**
 * 签名样本构造（v1.4 真算法）：密钥惰性取共享夹具单例（与栈 PUT 值同源）。
 * 夹具缺/空 ⇒ helper 抛 `AdCallbackSecretLoadError`，本包装转 ConformanceError 指引跑生成器。
 */
function signedParams(fields: AdCallbackFields, what: string): AdCallbackParams {
  try {
    return signAdCallback(fields, adSecret());
  } catch (err) {
    if (err instanceof AdCallbackSecretLoadError) {
      throw new ConformanceError(`${what}：签名样本构造不可用 —— ${err.message}`);
    }
    throw err;
  }
}

/**
 * 门口（TLS 自签）请求 —— 回调投递路径（照 slice-21/24 的 `edgeRequest` 形态逐字；
 * 经门口同时验收 Caddy 的 `handle /ad/notify/*`）。
 */
function edgeRequest(
  method: 'GET' | 'POST',
  path: string,
  body: string | null,
  contentType = 'application/x-www-form-urlencoded',
): Promise<{ status: number; body: string }> {
  const u = new URL(`https://localhost:${EDGE_HTTPS_PORT}${path}`);
  return new Promise((resolveP, reject) => {
    const headers: Record<string, string> = {};
    if (body !== null) {
      headers['content-type'] = contentType;
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const req = https.request(
      { hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, rejectUnauthorized: false, headers },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          b += c;
        });
        res.on('end', () => resolveP({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** 经门口投递一条回调（v1.4：**GET + query**，无 body；返回状态码 + 应答体）。 */
function getNotifyViaEdge(params: AdCallbackParams): Promise<{ status: number; body: string }> {
  return edgeRequest('GET', `${AD_NOTIFY_PATH}?${toQueryString(params)}`, null);
}

// ────────────────────────────────────────────────────────────────────────────
// 主用例
// ────────────────────────────────────────────────────────────────────────────

const HEALTH_CONTAINERS = [
  'ftl-room-service',
  'ftl-user-service',
  'ftl-currency-service',
  'ftl-api-gateway',
  'ftl-config-service',
] as const;

export async function runSlice18(): Promise<Checks> {
  const checks = new Checks();
  // ⚠️ `let`（不是 `const`）：③ 起写桶覆盖**全部非 GET**（含 POST adjust，T5/规格 F8），
  //    本片一个令牌的写预算会逼近 30 次/5 分钟（A 1 + B 4 + C 1 + E 11 + F 12 + G 6 ≈ 35）
  //    ⇒ F 组前**换一次令牌**（FIT 注释见该处），否则 G 组的 PUT 会撞 429（快速机器上
  //    全片 ≤5 分钟时**确定性**触发；CI 因更慢而侥幸绿过 —— T11 受影响片单跑抓获）。
  let admin = await adminLogin();
  /** finally 兜底：还开着的房间客户端（R156 —— 失败路径也必须收干净）。 */
  const openRooms: FreshRoom[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════════
    // ⓪ 起手自证 + 清源
    // ══════════════════════════════════════════════════════════════════════
    step('⓪ 起手：五个容器 healthy + 金币队列清源（陈旧票会吃掉 E 组的补位谓词）');
    for (const container of HEALTH_CONTAINERS) {
      const h = await waitContainerHealthy(container);
      checks.that(h.ok, `⓪ ${container} healthy（${h.last}）`);
    }
    const purged = purgeGoldQueues();
    info(`清源：删除 gold 队列键 ${purged.deletedQueues} 个、gold 票 meta ${purged.deletedMetas} 个`);
    checks.eq(scanRedisKeys('match:queue:gold:*').length, 0, '⓪ 清源后 match:queue:gold:* 无键');
    checks.eq(goldMetaCount(), 0, '⓪ 清源后 gold 票的 match:meta 无残留');

    // ══════════════════════════════════════════════════════════════════════
    // A 配置
    // ══════════════════════════════════════════════════════════════════════
    step('A：/api/config 恰 21 键 + 内部键零泄漏 + 管理面六新键种子 + 确保 gold 开（种子态）后客户端面生效');
    const uCfg = await registerUser(2);
    const cfgA = await getJson<Record<string, unknown>>('/api/config', uCfg.accessToken);
    checks.eq(cfgA.body?.code, ErrCode.OK, 'A /api/config code 0');
    const cfgKeys = Object.keys(cfgA.body?.data ?? {});
    checks.eq(cfgKeys.sort().join(','), CLIENT_CONFIG_KEYS_SORTED, 'A /api/config 键集（排序后）恰 21 键');
    checks.that(
      Array.isArray((cfgA.body?.data as any)?.baseScoreLevels) &&
        ((cfgA.body!.data as any).baseScoreLevels as unknown[]).length > 0,
      `A baseScoreLevels 数组非空 —— 实际 ${JSON.stringify((cfgA.body?.data as any)?.baseScoreLevels)?.slice(0, 120)}`,
    );
    checks.that(
      typeof (cfgA.body?.data as any)?.freeRoomEnabled === 'boolean' &&
        typeof (cfgA.body?.data as any)?.goldRoomEnabled === 'boolean' &&
        typeof (cfgA.body?.data as any)?.reliefEnabled === 'boolean',
      `A 三新布尔键类型正确（free/gold/relief）—— 实际 ${JSON.stringify(cfgA.body?.data)?.slice(0, 240)}`,
    );
    checks.that(
      typeof (cfgA.body?.data as any)?.entryMultiplier === 'number' &&
        typeof (cfgA.body?.data as any)?.version === 'number',
      `A entryMultiplier / version 类型正确（number）`,
    );
    const cfgRaw = JSON.stringify(cfgA.body?.data ?? null);
    checks.that(
      !cfgRaw.includes('currency.'),
      `A 原始载荷零出现 'currency.' 前缀（内部键前缀扫描兜底）—— 实际命中 ${cfgRaw.match(/currency\.[A-Za-z]+/g)?.join(',') ?? '无'}`,
    );
    const leaked = INTERNAL_KEY_NAMES.filter((k) => cfgRaw.includes(k));
    checks.that(leaked.length === 0, `A 显式名单零泄漏（signupGrant/rakePercent/reliefAmount）—— 命中 ${JSON.stringify(leaked)}`);

    interface AdminConfigData {
      config: Record<string, { value: unknown; version: number }>;
      version: number;
    }
    const adminCfg = await adminGetConfig<AdminConfigData>(admin);
    const adminKeys = Object.keys(adminCfg.body?.data?.config ?? {});
    checks.eq(adminKeys.length, CONFIG_KEYS.length, 'A 管理面键总数 = CONFIG_KEYS.length（含跑得快 14 键与斗地主总开关）');
    const missingNewKeys = NEW_KEYS.filter((k) => !adminKeys.includes(k));
    checks.that(
      missingNewKeys.length === 0,
      `A 管理面含六新键（缺 ${JSON.stringify(missingNewKeys)}；实读 ${adminKeys.length} 键）`,
    );
    const sixValues = {
      entryMultiplier: adminCfg.body?.data?.config?.['game.doudizhu.entryMultiplier']?.value,
      rakePercent: adminCfg.body?.data?.config?.['game.doudizhu.rakePercent']?.value,
      reliefAmount: adminCfg.body?.data?.config?.['currency.reliefAmount']?.value,
      reliefThresholdCoins:
        adminCfg.body?.data?.config?.['currency.reliefThresholdCoins']?.value,
    };
    checks.eq(
      JSON.stringify(sixValues),
      JSON.stringify({
        entryMultiplier: 10,
        rakePercent: 0,
        reliefAmount: RELIEF_AMOUNT_SEED,
        reliefThresholdCoins: 150,
      }),
      'A 四枚稳定种子逐字（entryMultiplier=10 / rakePercent=0 / reliefAmount=200 / reliefThresholdCoins=150）',
    );
    const entryMultiplier = Number(sixValues.entryMultiplier);
    const needed = MATCH_BASE_SCORE * entryMultiplier;
    const reliefThreshold = Number(sixValues.reliefThresholdCoins);

    // 2026-10-04 用户裁决后**种子即 true** ⇒ 本 PUT 是「**确保期望态**」（自管理：dev 库
    // 可能带着旧库/上一轮留下的 false）—— 同时保留「管理面 → 客户端面生效」的链路断言。
    const putOn = await adminPutConfig('game.doudizhu.goldRoomEnabled', true, admin);
    checks.eq(putOn.body?.code, ErrCode.OK, 'A 管理面 PUT game.doudizhu.goldRoomEnabled=true（确保态）⇒ code 0');
    const cfgA2 = await getJson<Record<string, unknown>>('/api/config', uCfg.accessToken);
    checks.eq(
      (cfgA2.body?.data as any)?.goldRoomEnabled,
      true,
      'A PUT 后 GET /api/config ⇒ goldRoomEnabled=true（管理面改动对客户端面生效）',
    );

    // ══════════════════════════════════════════════════════════════════════
    // B 开关
    // ══════════════════════════════════════════════════════════════════════
    step('B：gold 关 ⇒ 12010；开 ⇒ 不再 12010；free 关 ⇒ random 12010；恢复');
    const userB = await registerUser(3);
    const clientB = await HarnessClient.connect('S18B', userB);
    try {
      const offGold = await putConfigAndWaitEffect(admin, 'game.doudizhu.goldRoomEnabled', false, 'room-service');
      checks.that(
        offGold.putCode === ErrCode.OK && offGold.refreshOk,
        `B PUT gold=false ⇒ 200 且 room-service 快照生效（version=${offGold.expected} 计数 ${offGold.baseline}→${offGold.observed}）`,
      );
      const goldOff = await pollMatchUntil(clientB, 'gold', (code) => code === ErrCode.ROOM_MODE_DISABLED);
      checks.that(
        goldOff.ok,
        `B gold 关 ⇒ room.match gold = 12010（该场次暂未开放）—— 实测 code=${goldOff.code}`,
      );
      const onGold = await putConfigAndWaitEffect(admin, 'game.doudizhu.goldRoomEnabled', true, 'room-service');
      checks.that(
        onGold.putCode === ErrCode.OK && onGold.refreshOk,
        `B PUT gold=true ⇒ 200 且 room-service 快照生效（version=${onGold.expected} 计数 ${onGold.baseline}→${onGold.observed}）`,
      );
      const goldOn = await pollMatchUntil(clientB, 'gold', (code) => code !== ErrCode.ROOM_MODE_DISABLED);
      checks.that(
        goldOn.ok && goldOn.code !== ErrCode.ROOM_MODE_DISABLED,
        `B gold 开 ⇒ 不再 12010（实测 code=${goldOn.code} message=${JSON.stringify(goldOn.message)}；0 余额 ⇒ 落 14003 是门槛组的门）`,
      );
      const offFree = await putConfigAndWaitEffect(admin, 'game.doudizhu.freeRoomEnabled', false, 'room-service');
      checks.that(
        offFree.putCode === ErrCode.OK && offFree.refreshOk,
        `B PUT free=false ⇒ 200 且 room-service 快照生效（version=${offFree.expected} 计数 ${offFree.baseline}→${offFree.observed}）`,
      );
      const freeOff = await pollMatchUntil(clientB, 'random', (code) => code === ErrCode.ROOM_MODE_DISABLED);
      checks.that(
        freeOff.ok,
        `B free 关 ⇒ room.match random = 12010 —— 实测 code=${freeOff.code}`,
      );
      const onFree = await putConfigAndWaitEffect(admin, 'game.doudizhu.freeRoomEnabled', true, 'room-service');
      checks.that(
        onFree.putCode === ErrCode.OK && onFree.refreshOk,
        `B PUT free=true ⇒ 200 且 room-service 快照生效（version=${onFree.expected} 计数 ${onFree.baseline}→${onFree.observed}）`,
      );
      const freeOn = await pollMatchUntil(clientB, 'random', (code) => code === ErrCode.OK);
      checks.that(
        freeOn.ok && freeOn.code === ErrCode.OK,
        `B free 恢复 ⇒ random 入队成功（实测 code=${freeOn.code}；助手已在成功时 room.unmatch 清票）`,
      );
      checks.eq(goldQueueScore(userB.id, MATCH_BASE_SCORE), '', 'B 收尾：B 不在 gold 队列（轮询助手未留票）');
    } finally {
      clientB.close();
    }

    // ══════════════════════════════════════════════════════════════════════
    // C 门槛
    // ══════════════════════════════════════════════════════════════════════
    step('C：0 余额 gold 匹配 15 ⇒ 14003（含所需金额）；管理面补足 ⇒ 入队成功（随后 unmatch）');
    const userC = await registerUser(4);
    const clientC = await HarnessClient.connect('S18C', userC);
    try {
      const c1 = await sendThrottled(clientC, 'room.match', { mode: 'gold', baseScore: MATCH_BASE_SCORE }, 0);
      checks.eq(c1.code, ErrCode.E_ENTRY_THRESHOLD, 'C 0 余额 ⇒ 14003');
      checks.that(
        String(c1.message ?? '').includes(String(needed)) && String(c1.message ?? '').includes('金币不足'),
        `C 14003 消息含所需金额（needed=${needed}）—— 实际 ${JSON.stringify(c1.message)}`,
      );
      const topUp = await adminAdjust(admin, userC.id, needed, AID('c-topup'));
      checks.that(
        topUp.status === 200 && topUp.code === ErrCode.OK && topUp.balanceAfter === needed,
        `C 管理面补足 +${needed} ⇒ 200/code 0/balanceAfter=${needed}（实测 ${topUp.status}/${topUp.code}/${topUp.balanceAfter}）`,
      );
      const c2 = await sendThrottled(clientC, 'room.match', { mode: 'gold', baseScore: MATCH_BASE_SCORE }, 0);
      checks.eq(c2.code, ErrCode.OK, 'C 补足后 ⇒ 入队成功');
      const c3 = await sendThrottled(clientC, 'room.unmatch', {}, 0);
      checks.eq(c3.code, ErrCode.OK, 'C 收尾 unmatch code');
      checks.eq(goldQueueScore(userC.id, MATCH_BASE_SCORE), '', 'C 收尾：C 不在 gold 队列');
    } finally {
      clientC.close();
    }

    // ══════════════════════════════════════════════════════════════════════
    // D 取消排队（C21）
    // ══════════════════════════════════════════════════════════════════════
    step('D：gold 入队 → Redis 指纹 → unmatch → 三个可观测面全清 + 窗口内不被撮合 → 再入队复核 12009');
    const userD = await registerUser(5);
    const fundD = await rpcApply({
      actionId: AID(`d-fund-${userD.id}`),
      source: 'admin_adjust',
      actor: 'admin',
      reason: `slice18 ${RUN_TAG} D 组造数`,
      entries: [{ ownerId: userD.id, delta: needed }],
    });
    expectApplyOk(fundD, 'D 组直投造数（+needed）');
    checks.eq(await playerBalance(userD), needed, `D 造数到位：玩家面余额 = ${needed}（RPC 直投，与入队路径分离）`);
    const clientD = await HarnessClient.connect('S18D', userD);
    try {
      const d1 = await sendThrottled(clientD, 'room.match', { mode: 'gold', baseScore: MATCH_BASE_SCORE }, 0);
      checks.eq(d1.code, ErrCode.OK, 'D gold 入队 code');
      checks.that(goldQueueScore(userD.id, MATCH_BASE_SCORE).length > 0, 'D 探针：ZSCORE match:queue:gold:15:global 命中（票在队里）');
      checks.eq(matchMetaExists(userD.id), true, 'D 探针：match:meta 在场');
      checks.eq(matchMetaField(userD.id, 'mode'), 'gold', 'D 探针：meta.mode 保真三值 = gold（C21 的 readMeta 落点）');

      const d2 = await sendThrottled(clientD, 'room.unmatch', {}, 0);
      checks.eq(d2.code, ErrCode.OK, 'D room.unmatch code');
      checks.eq(goldQueueScore(userD.id, MATCH_BASE_SCORE), '', 'D 取消后 ZSCORE 空（票已 ZREM）');
      checks.eq(matchMetaExists(userD.id), false, 'D 取消后 match:meta 已清');

      step('D：取消后窗口内不被撮合（结构式负判据 + 探针正/负对照）');
      const countRoomMatched = (received: ReadonlyArray<{ type: string }>): number =>
        received.filter((r) => r.type === 'room.matched').length;
      checks.eq(countRoomMatched([{ type: 'room.matched' }]), 1, 'D 探针正对照：计数器能观测到 room.matched');
      checks.eq(countRoomMatched([{ type: 'game.deal' }]), 0, 'D 探针负对照：其它消息不被误计');
      await sleep(12_000); // > 两轮扫描周期（≤5s），< 30s 补位窗口
      const matchedInWindow = countRoomMatched(clientD.received);
      checks.eq(
        matchedInWindow,
        0,
        'D 取消后 12s 窗口内 0 条 room.matched（配合上一条 ZSCORE 空 = 票真的没了，不是恰好在窗口外）',
      );

      const d3 = await sendThrottled(clientD, 'room.match', { mode: 'gold', baseScore: MATCH_BASE_SCORE }, 0);
      checks.eq(d3.code, ErrCode.OK, 'D 取消后**再入队** ⇒ code 0（复用路径正确）');
      checks.that(goldQueueScore(userD.id, MATCH_BASE_SCORE).length > 0, 'D 再入队探针：ZSCORE 重新命中');
      const d4 = await sendThrottled(clientD, 'room.match', { mode: 'gold', baseScore: MATCH_BASE_SCORE }, 0);
      checks.eq(d4.code, ErrCode.ALREADY_IN_QUEUE, 'D 队列中重复 room.match ⇒ 12009（语义正确）');
      const d5 = await sendThrottled(clientD, 'room.unmatch', {}, 0);
      checks.eq(d5.code, ErrCode.OK, 'D 终收尾 unmatch code');
      checks.eq(goldQueueScore(userD.id, MATCH_BASE_SCORE), '', 'D 终收尾：ZSCORE 空（零残留）');
    } finally {
      clientD.close();
    }

    // ══════════════════════════════════════════════════════════════════════
    // E 完整金币局
    // ══════════════════════════════════════════════════════════════════════
    step('E：池注资 + 空闲机器人抽干（ensure 必真补给）→ 两真人 5,000,000 预充 → 完整金币局 → 复算逐座比对');
    const poolSeed = await adminAdjust(admin, 'robot-pool', PRE_CHARGE_STEP, AID('pool-seed'), 'robot');
    checks.that(
      poolSeed.status === 200 && poolSeed.code === ErrCode.OK && (poolSeed.balanceAfter ?? 0) >= PRE_CHARGE_STEP,
      `E 管理面给 robot-pool 注资 +${PRE_CHARGE_STEP}（ownerType 透传）⇒ 200 且余额 ≥ ${PRE_CHARGE_STEP}（实测 ${poolSeed.status}/${poolSeed.code}/${poolSeed.balanceAfter}）`,
    );
    // 抽干池内空闲机器人的余额（回收式：钱回池、不销毁）—— 抽干后 E 局中余额 ≥ 12000
    // 只可能来自 ensure 的真实补给（C6），且 H 组的 topup 指标序列由此**必然**存在（重跑亦然）。
    // S2 起规范池 = bot:pool:doudizhu；旧 bot:pool:ddz 只在迁移窗口可能仍有空闲机器人。
    const idleBots = [...scanRedisKeys('bot:pool:doudizhu'), ...scanRedisKeys('bot:pool:ddz')];
    if (idleBots.length > 0) {
      const got = await rpcGet(idleBots);
      let recalled = 0;
      for (const b of got.ok ? got.data.balances : []) {
        if (b.exists && b.balance > 0) {
          expectApplyOk(
            await rpcApply({
              actionId: AID(`drain-${b.ownerId}-${b.balance}`),
              source: 'robot_pool',
              refId: b.ownerId,
              entries: [
                { ownerId: b.ownerId, ownerType: 'robot', delta: -b.balance },
                { ownerId: 'robot-pool', ownerType: 'robot', delta: b.balance },
              ],
            }),
            `E 抽干 ${b.ownerId}`,
          );
          recalled += 1;
        }
      }
      info(`E 抽干 ${recalled}/${idleBots.length} 个空闲机器人（余额回池）`);
    } else {
      info('E 池中无空闲机器人（新局 acquire 会新建 —— 余额 0，ensure 同样必真补给）');
    }
    const drained = await rpcGet(idleBots);
    const drainViolations = (drained.ok ? drained.data.balances : []).filter((b) => b.exists && b.balance !== 0);
    checks.that(
      drainViolations.length === 0,
      `E 抽干后池内全部空闲机器人余额 = 0（${drainViolations.length} 个违例；池内 ${idleBots.length} 个）`,
    );

    // 房间已在 runGoldGame 内「创建即 push」入 openRooms（R156）。
    const evE = await runGoldGame(checks, admin, 'E 完整金币局', 'S18E', openRooms);
    checks.that(
      evE.room.clients.length === GOLD_HUMANS && evE.room.roomCode.length > 0,
      `E 已开局：roomCode=${evE.room.roomCode}（${GOLD_HUMANS} 真人经 30s 补位窗口 + 机器人补位）`,
    );
    checks.that(
      /^bot-[0-9a-f]{8}$/.test(evE.botId),
      `E 局中读到的 botId 形态 = bot-+8hex（内部 id 永不出站 —— 这里经 Redis 键读到）—— 实际 ${evE.botId}`,
    );
    checks.eq(Object.keys(readRoomBots(evE.room.roomCode) as object).length, 0, 'E 局终后 room:{code}:bots 已 DEL（局内读先例的正确性面）');
    {
      const balances = evE.balances;
      checks.eq(balances.length, 3, 'E game.balances 恰 3 座');
      checks.eq(
        balances.map((b) => b.seat).join(','),
        '0,1,2',
        'E game.balances 座位升序 [0,1,2]',
      );
      checks.eq(evE.balancesVersion, evE.settlementVersion, 'E game.balances.version = game.settlement.version（同一局同一 version）');
    }
    checks.eq(evE.settlement.roomCode, evE.room.roomCode, 'E game.settlement.roomCode 与房间一致');
    checks.eq(
      Object.keys(evE.settlement).sort().join(','),
      'baseScore,farmerScoreChange,farmerSeats,landlordScoreChange,landlordSeat,multiplier,roomCode,spring,winner',
      'E game.settlement 字段集恰 9 键（契约 §8.5）',
    );
    const recountE = await assertGoldGame(checks, admin, evE, 0, 'E');
    // 机器人座：owner_type='robot'（MySQL 面）+ 结算前余额 ≥ 12000（ensure 的真实补给）
    const robotType = mysqlText(`SELECT owner_type FROM currency_accounts WHERE owner_id='${evE.botId}'`);
    checks.eq(robotType, 'robot', `E 机器人账户 owner_type='robot'（botId=${evE.botId}）`);
    checks.that(
      (evE.preBalances.get(evE.robotSeat) ?? 0) >= 12_000,
      `E 机器人结算前余额 ≥ 12000（实测 ${evE.preBalances.get(evE.robotSeat)}；抽干后只能来自 ensure 补给）`,
    );
    const robotPost = await adminAccounts(admin, evE.botId);
    checks.eq(
      settleFlowDelta(robotPost.recentFlows),
      recountE.expected[evE.robotSeat]!,
      `E 机器人 game_settle 流水 delta = 复算期望（实测 ${settleFlowDelta(robotPost.recentFlows)}，期望 ${recountE.expected[evE.robotSeat]!}）`,
    );
    // 本片 C14：真实金币局的 settle op 两列非 NULL 且 = 复算（新代码恒带 burn）
    checks.eq(
      mysqlText(
        `SELECT CONCAT(burned_residue,':',burned_rake) FROM currency_ops WHERE action_id='settle:${evE.settlement.roomCode}:${evE.settlementVersion}'`,
      ),
      `${recountE.residue}:${recountE.rakeTotal}`,
      `E settle op burn 两列 = 复算（residue:rake；新代码恒带）`,
    );
    // 真人战绩：moneyDelta = 复算期望（= 实际变动）
    for (const [seat, userId] of evE.humanSeats.entries()) {
      const user = evE.room.clients.find((c) => c.user.id === userId)!.user;
      const rec = await waitRecordWithDelta(user.accessToken, evE.room.roomCode);
      checks.that(
        rec.found && rec.record?.moneyDelta === recountE.expected[seat]!,
        `E seat ${seat} 战绩 moneyDelta = 复算期望（实测 ${rec.record?.moneyDelta}，期望 ${recountE.expected[seat]!}；` +
          `战绩 ${rec.items} 条）`,
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // F 抽水
    // ══════════════════════════════════════════════════════════════════════
    step('F：rakePercent=10 → 再打一局（同 E 口径）→ 赢家实收 = g − floor(g×10/100)、entries 和 = −(抽水+残差) → 复原 0');
    // ③ T5（写桶扩边：X-Admin 且非 GET ⇒ POST adjust 也计数）之后，本片的令牌写预算
    // 在快速机器上会贴边 30/5 分钟（机制复现：第 31 笔 ⇒ 429）⇒ F/G 两段换新令牌续跑。
    // ⚠️ 这不是放宽判据：换令牌后每段写量（≈12）仍受**同一条桶规则**约束。
    admin = await adminLogin();
    const putRake = await putConfigAndWaitEffect(admin, 'game.doudizhu.rakePercent', 10, 'room-service');
    checks.that(
      putRake.putCode === ErrCode.OK && putRake.refreshOk,
      `F PUT rakePercent=10 ⇒ 200 且 room-service 快照生效（version=${putRake.expected} 计数 ${putRake.baseline}→${putRake.observed}）`,
    );
    // 同 E：房间已在 runGoldGame 内「创建即 push」入 openRooms（R156）。
    const evF = await runGoldGame(checks, admin, 'F 抽水局', 'S18F', openRooms);
    checks.eq(evF.balancesVersion, evF.settlementVersion, 'F game.balances.version = game.settlement.version');
    const recountF = await assertGoldGame(checks, admin, evF, 10, 'F');
    checks.that(recountF.rakeTotal > 0, `F 抽水总额 > 0（实测 ${recountF.rakeTotal}；赢家实收已逐座 = g − floor(g×10/100) 口径）`);
    // entries 和 = −(抽水+残差)：管理面读余额核对（真人 = MySQL 直读；机器人 = 本局 game_settle 流水）。
    const humanRows: Array<{ seat: number; delta: number }> = [];
    for (const [seat, userId] of evF.humanSeats.entries()) {
      const post = await adminAccounts(admin, userId);
      humanRows.push({ seat, delta: post.balance - (evF.preBalances.get(seat) ?? 0) });
    }
    const robotFlow = settleFlowDelta((await adminAccounts(admin, evF.botId)).recentFlows);
    const entriesSum =
      humanRows.reduce((a, r) => a + r.delta, 0) + (robotFlow === null ? Number.NaN : robotFlow);
    checks.eq(
      entriesSum,
      -(recountF.rakeTotal + recountF.residue),
      `F entries 和（管理面读数：真人余额差 + 机器人 game_settle 流水）= −(抽水 ${recountF.rakeTotal} + 残差 ${recountF.residue})`,
    );
    const putRakeOff = await putConfigAndWaitEffect(admin, 'game.doudizhu.rakePercent', 0, 'room-service');
    checks.that(
      putRakeOff.putCode === ErrCode.OK && putRakeOff.refreshOk,
      `F 复原 rakePercent=0 ⇒ 200 且 room-service 快照生效（version=${putRakeOff.expected}）`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // G 救助（广告片 T22 **原位改写为新链驱动**：GET 裁决 + 签名回调样本）
    //   旧链（POST /api/wallet/relief）已退役；旧构造「扣回后再领 ⇒ replayed」在新链
    //   **不可达**（`今日已发` 闸挡第二张凭证）——删正（设计 v1.4 r4 🟠-1）。四态确定性构造：
    //    · granted  = 正路（GET 签发 + 签名回调 ⇒ apply granted）；
    //    · replayed = 先 GET 签发、后 RPC 预置同锚流水（actionId 逐字 `relief:<userId>:<签发日>`）、
    //      再投回调（账本先行判重放；**不得以「记录移除」构造**——那走 claim_invalid）；
    //    · rejected×2 = 中途切开关（done:disabled）·中途充值（done:balance_ok）后回调。
    //   追加覆盖：GET「已领优先于余额闸」（发放后余额 200 ≥ 门槛 150 ⇒ 仍报「今天已经领过了」）。
    //   H 组三桶（granted/replayed/rejected ≥1/≥1/≥2）数据源由本组四态承接（断言逻辑原位）。
    //   签名样本走 T20 helper（v1.4：GET + query 八字段，sha256(secret:trans_id)，密钥惰性取夹具）。
    // ══════════════════════════════════════════════════════════════════════
    step('G：GET 裁决 reason 面（开关关）+ 签名 GET 回调四态（granted / replayed / disabled / balance_ok，终态 200/{"isValid":true}）+ 已领优先于余额闸');

    // ── 开关关 ⇒ GET 裁决 reason 面「救助暂未开放」（非签名步；裁决序③）────────
    const gOff0 = await putConfigAndWaitEffect(admin, 'currency.reliefEnabled', false, 'currency-service');
    checks.that(
      gOff0.putCode === ErrCode.OK && gOff0.refreshOk,
      `G PUT reliefEnabled=false ⇒ 200 且 currency-service 快照生效（version=${gOff0.expected} 计数 ${gOff0.baseline}→${gOff0.observed}）`,
    );
    const userG1 = await registerUser(6);
    const g1 = await getRelief(userG1);
    checks.that(
      g1.status === 200 && g1.body?.code === ErrCode.OK &&
        g1.body.data?.eligible === false && g1.body.data?.grantedToday === false &&
        g1.body.data?.reason === '救助暂未开放' && g1.body.data?.claim === undefined,
      `G 开关关 ⇒ GET 裁决 200/0 + reason「救助暂未开放」且不签发（实测 ${g1.status}/${g1.body?.code} ${JSON.stringify(g1.body?.data)}）`,
    );

    // ── granted：正路（GET 签发 + 签名回调 ⇒ apply granted）──────────────────
    const gOn = await putConfigAndWaitEffect(admin, 'currency.reliefEnabled', true, 'currency-service');
    checks.that(
      gOn.putCode === ErrCode.OK && gOn.refreshOk,
      `G PUT reliefEnabled=true ⇒ 200 且 currency-service 快照生效（version=${gOn.expected} 计数 ${gOn.baseline}→${gOn.observed}）`,
    );
    const g2 = await getRelief(userG1);
    const claimGranted = g2.body?.data?.claim ?? '';
    checks.that(
      g2.status === 200 && g2.body?.code === ErrCode.OK &&
        g2.body.data?.eligible === true && g2.body.data?.grantedToday === false && claimGranted.length > 0,
      `G 低余额（0 < 门槛）⇒ eligible GET 签发（eligible=true/grantedToday=false/claim 在场）—— 实测 ${g2.status} ${JSON.stringify(g2.body?.data)}`,
    );
    checks.that(
      /^[A-Za-z0-9_-]{22}$/.test(claimGranted),
      `G claim 形态 = 22 字符 base64url（T12 nonce 契约）—— 实测 ${JSON.stringify(claimGranted)}`,
    );
    const grantRes = await getNotifyViaEdge(signedParams(callbackFields(userG1, claimGranted, 'granted'), 'G granted 正路样本'));
    checks.that(
      grantRes.status === 200 && grantRes.body === JSON.stringify({ isValid: true }),
      `G granted 回调 ⇒ 200/{"isValid":true}（经门口 ${AD_NOTIFY_PATH} GET 全链）—— 实测 ${grantRes.status} ${JSON.stringify(grantRes.body)}`,
    );
    const accG1 = await adminAccounts(admin, userG1.id);
    checks.eq(accG1.balance, RELIEF_AMOUNT_SEED, `G 发放：余额 0 → ${RELIEF_AMOUNT_SEED}（apply granted；管理面直读）`);
    checks.that(
      claimRecordJson(claimGranted)?.state === 'done' && claimRecordJson(claimGranted)?.result === 'granted',
      `G 记录落 done:granted —— 实测 ${JSON.stringify(claimRecordJson(claimGranted))}`,
    );

    // ── 追加覆盖：GET「已领优先于余额闸」（裁决序②先于④）────────────────────
    const g3 = await getRelief(userG1);
    checks.that(
      g3.status === 200 && g3.body?.code === ErrCode.OK &&
        g3.body.data?.grantedToday === true && g3.body.data?.eligible === false &&
        g3.body.data?.reason === '今天已经领过了' && g3.body.data?.balance === RELIEF_AMOUNT_SEED,
      `G 已领优先于余额闸：发放后余额 ${RELIEF_AMOUNT_SEED} ≥ 门槛（${reliefThreshold}）仍报「今天已经领过了」而非「余额充足」—— 实测 ${JSON.stringify(g3.body?.data)}`,
    );

    // ── replayed：先 GET 签发、后 RPC 预置同锚流水、再投回调（账本先行判重放）──
    const userG2 = await registerUser(7);
    const g4 = await getRelief(userG2);
    const claimReplayed = g4.body?.data?.claim ?? '';
    checks.that(
      g4.status === 200 && g4.body?.code === ErrCode.OK &&
        g4.body.data?.eligible === true && g4.body.data?.grantedToday === false && claimReplayed.length > 0,
      `G replayed 组：eligible GET 签发（实测 ${g4.status} ${JSON.stringify(g4.body?.data)}）`,
    );
    const recG2 = claimRecordJson(claimReplayed);
    const dateG2 = String(recG2?.date ?? '');
    checks.that(
      recG2?.state === 'issued' && /^\d{4}-\d{2}-\d{2}$/.test(dateG2),
      `G replayed 组：记录 issued 且签发日在场（上海日历日——账本锚的日期源）—— 实测 ${JSON.stringify(recG2)}`,
    );
    const preset = await rpcApply({
      actionId: `relief:${userG2.id}:${dateG2}`,
      source: 'relief_grant',
      entries: [{ ownerId: userG2.id, delta: RELIEF_AMOUNT_SEED }],
      refId: userG2.id,
    });
    checks.that(
      preset.ok === true,
      `G replayed 组：RPC 预置同锚流水（actionId 逐字 relief:${userG2.id}:${dateG2}）⇒ ok:true —— 实测 ${JSON.stringify(preset)}`,
    );
    const accG2a = await adminAccounts(admin, userG2.id);
    checks.eq(accG2a.balance, RELIEF_AMOUNT_SEED, 'G replayed 组：预置后余额 = 200（账本已有、记录仍 issued——重投判重放的构造面）');
    const replayRes = await getNotifyViaEdge(signedParams(callbackFields(userG2, claimReplayed, 'replayed'), 'G replayed 账本先行样本'));
    checks.that(
      replayRes.status === 200 && replayRes.body === JSON.stringify({ isValid: true }),
      `G replayed 回调 ⇒ 200/{"isValid":true} —— 实测 ${replayRes.status} ${JSON.stringify(replayRes.body)}`,
    );
    const accG2b = await adminAccounts(admin, userG2.id);
    checks.eq(accG2b.balance, RELIEF_AMOUNT_SEED, 'G replayed：余额不变（只翻终态、不迁移金额）');
    checks.that(
      claimRecordJson(claimReplayed)?.state === 'done' && claimRecordJson(claimReplayed)?.result === 'replayed',
      `G 记录落 done:replayed（账本=唯一真源）—— 实测 ${JSON.stringify(claimRecordJson(claimReplayed))}`,
    );

    // ── rejected①：中途切开关（GET 签发后关闸 ⇒ 回调落 done:disabled）────────
    const userG3 = await registerUser(8);
    const g5 = await getRelief(userG3);
    const claimDisabled = g5.body?.data?.claim ?? '';
    checks.that(
      g5.status === 200 && g5.body?.code === ErrCode.OK &&
        g5.body.data?.eligible === true && g5.body.data?.grantedToday === false && claimDisabled.length > 0,
      `G disabled 组：eligible GET 签发（实测 ${g5.status} ${JSON.stringify(g5.body?.data)}）`,
    );
    const gOffMid = await putConfigAndWaitEffect(admin, 'currency.reliefEnabled', false, 'currency-service');
    checks.that(
      gOffMid.putCode === ErrCode.OK && gOffMid.refreshOk,
      `G 中途切开关 PUT reliefEnabled=false ⇒ 200 且快照生效（version=${gOffMid.expected} 计数 ${gOffMid.baseline}→${gOffMid.observed}）`,
    );
    const disabledRes = await getNotifyViaEdge(signedParams(callbackFields(userG3, claimDisabled, 'mid-off'), 'G 中途切开关样本'));
    checks.that(
      disabledRes.status === 200 && disabledRes.body === JSON.stringify({ isValid: true }),
      `G 中途切开关回调 ⇒ 200/{"isValid":true}（正向裁决拒绝属终态接受面）—— 实测 ${disabledRes.status} ${JSON.stringify(disabledRes.body)}`,
    );
    checks.that(
      claimRecordJson(claimDisabled)?.state === 'done' && claimRecordJson(claimDisabled)?.result === 'disabled',
      `G 记录落 done:disabled —— 实测 ${JSON.stringify(claimRecordJson(claimDisabled))}`,
    );
    const accG3 = await adminAccounts(admin, userG3.id);
    checks.eq(accG3.balance, 0, 'G disabled：拒绝零发放（余额仍 0）');
    const gOnMid = await putConfigAndWaitEffect(admin, 'currency.reliefEnabled', true, 'currency-service');
    checks.that(
      gOnMid.putCode === ErrCode.OK && gOnMid.refreshOk,
      `G 组内复闸 PUT reliefEnabled=true ⇒ 200 且快照生效（version=${gOnMid.expected}）`,
    );

    // ── rejected②：中途充值（GET 签发后补足门槛 ⇒ 回调落 done:balance_ok）────
    const userG4 = await registerUser(9);
    const g6 = await getRelief(userG4);
    const claimBalanceOk = g6.body?.data?.claim ?? '';
    checks.that(
      g6.status === 200 && g6.body?.code === ErrCode.OK &&
        g6.body.data?.eligible === true && g6.body.data?.grantedToday === false && claimBalanceOk.length > 0,
      `G balance_ok 组：eligible GET 签发（实测 ${g6.status} ${JSON.stringify(g6.body?.data)}）`,
    );
    const topUpG = await adminAdjust(admin, userG4.id, reliefThreshold, AID('g-topup'));
    checks.that(
      topUpG.status === 200 && topUpG.code === ErrCode.OK && topUpG.balanceAfter === reliefThreshold,
      `G 中途充值 +${reliefThreshold}（= 平台救助门槛）⇒ 200/code 0/balanceAfter=${reliefThreshold}（实测 ${topUpG.status}/${topUpG.code}/${topUpG.balanceAfter}）`,
    );
    const balOkRes = await getNotifyViaEdge(signedParams(callbackFields(userG4, claimBalanceOk, 'balance-ok'), 'G 中途充值样本'));
    checks.that(
      balOkRes.status === 200 && balOkRes.body === JSON.stringify({ isValid: true }),
      `G 中途充值后回调 ⇒ 200/{"isValid":true} —— 实测 ${balOkRes.status} ${JSON.stringify(balOkRes.body)}`,
    );
    checks.that(
      claimRecordJson(claimBalanceOk)?.state === 'done' && claimRecordJson(claimBalanceOk)?.result === 'balance_ok',
      `G 记录落 done:balance_ok —— 实测 ${JSON.stringify(claimRecordJson(claimBalanceOk))}`,
    );
    const g7 = await getRelief(userG4);
    checks.that(
      g7.status === 200 && g7.body?.code === ErrCode.OK &&
        g7.body.data?.reason === '余额充足，无需救助' && g7.body.data?.eligible === false,
      `G GET 裁决余额闸 reason 面（余额 ${reliefThreshold} ≥ 门槛）⇒「余额充足，无需救助」—— 实测 ${JSON.stringify(g7.body?.data)}`,
    );

    // ── G 终态：切回关（收尾组的 relief=false 读数自证依赖本组复原）────────────
    const gOff1 = await putConfigAndWaitEffect(admin, 'currency.reliefEnabled', false, 'currency-service');
    checks.that(
      gOff1.putCode === ErrCode.OK && gOff1.refreshOk,
      `G 终态 PUT reliefEnabled=false ⇒ 200 且快照生效（version=${gOff1.expected}）—— 供收尾读数自证`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // H 观测
    // ══════════════════════════════════════════════════════════════════════
    step('H：room-service 六新指标名 + 终态/残差/补偿队列读数；currency-service 池与救助读数；Prometheus 27 条规则');
    const roomMetrics = readRoomMetrics();
    for (const name of [
      'currency_settle_result_total',
      'currency_settle_residue_total',
      'currency_settle_outbox_size',
      'currency_settle_outbox_oldest_seconds',
      'currency_robot_topup_total',
      'currency_robot_ensure_failed_total',
    ]) {
      checks.that(roomMetrics.includes(name), `H room-service /metrics 含 ${name}`);
    }
    const terminalSettles =
      (seriesValue(roomMetrics, 'currency_settle_result_total', { result: 'ok' }) ?? 0) +
      (seriesValue(roomMetrics, 'currency_settle_result_total', { result: 'replayed' }) ?? 0);
    checks.that(
      terminalSettles >= 1,
      `H 终态结算序列（ok|replayed）≥ 1（实测 ${terminalSettles}；E/F 两局必现）`,
    );
    checks.that(
      seriesValue(roomMetrics, 'currency_settle_residue_total', {}) !== null,
      'H 残差序列在场（零和局也 inc 0）',
    );
    const outboxSize = seriesValue(roomMetrics, 'currency_settle_outbox_size', {});
    const outboxOldest = seriesValue(roomMetrics, 'currency_settle_outbox_oldest_seconds', {});
    checks.that(
      outboxSize === 0 && outboxOldest === 0,
      `H 补偿队列静默：outbox_size=${outboxSize}、oldest=${outboxOldest}（E/F 全成功 ⇒ 两箱空）`,
    );
    const topupRefill = seriesValue(roomMetrics, 'currency_robot_topup_total', { action: 'refill' }) ?? 0;
    checks.that(
      topupRefill >= 1,
      `H 机器人补给计数（refill）≥ 1（实测 ${topupRefill}；E 组抽干/新建后 ensure 必真补给）`,
    );

    const currMetrics = readCurrencyMetrics();
    for (const name of ['currency_robot_pool_balance', 'currency_robot_accounts_balance_sum', 'currency_relief_total']) {
      checks.that(currMetrics.includes(name), `H currency-service /metrics 含 ${name}`);
    }
    // ⚠️ 两个 robot gauge 的**值**不在这里断言：它们由对账轮**每轮刷新**（默认 1h）——
    //    启动轮早于 E 的池注资 ⇒ 这里读到的 0 是**陈旧值**不是缺陷。值断言落在 I 组
    //    （注入 3s 轮之后、同一轮刮擦里读）。
    checks.that(
      seriesValue(currMetrics, 'currency_robot_pool_balance', {}) !== null &&
        seriesValue(currMetrics, 'currency_robot_accounts_balance_sum', {}) !== null,
      'H 两个 robot gauge 序列已注册并在场（值的新鲜度由 I 组的注入轮承接）',
    );
    const reliefGranted = seriesValue(currMetrics, 'currency_relief_total', { result: 'granted' }) ?? 0;
    const reliefReplayed = seriesValue(currMetrics, 'currency_relief_total', { result: 'replayed' }) ?? 0;
    const reliefRejected = seriesValue(currMetrics, 'currency_relief_total', { result: 'rejected' }) ?? 0;
    checks.that(
      reliefGranted >= 1 && reliefReplayed >= 1 && reliefRejected >= 2,
      `H 救助三桶：granted=${reliefGranted}(≥1) replayed=${reliefReplayed}(≥1) rejected=${reliefRejected}(≥2) —— 与 G 组四态一致`,
    );

    const rulesResp = await fetch(`${PROM_URL}/api/v1/rules`, { signal: AbortSignal.timeout(15_000) });
    const rulesText = await rulesResp.text();
    const rulesParsed = JSON.parse(rulesText) as {
      data?: { groups?: Array<{ rules?: Array<{ name?: string; type?: string }> }> };
    };
    const ruleNames = (rulesParsed.data?.groups ?? []).flatMap((g) => g.rules ?? []).map((r) => r.name ?? '');
    checks.eq(ruleNames.length, 27, 'H Prometheus /api/v1/rules 恰 27 条（13 既有 + 3 金币 + 2 风控 + 5 支付 + 2 通知 + 2 救助；风控 T11 / 支付 T15 / 通知 T11 / 广告 T16 同步）');
    const missingRules = NEW_ALERT_RULES.filter((n) => !ruleNames.includes(n));
    checks.that(missingRules.length === 0, `H 三条新规则名逐个在场（缺 ${JSON.stringify(missingRules)}）`);

    // ══════════════════════════════════════════════════════════════════════
    // I 对账
    // ══════════════════════════════════════════════════════════════════════
    step(`I：PUT currency.reconcileIntervalMs=${RECONCILE_INTERVAL_INJECT}（管理面注入）+ 重起 currency-service ⇒ 跑够两轮 ⇒ drift_accounts==0 + 两个 robot gauge 新鲜读数 ⇒ PUT 还原 ${RECONCILE_INTERVAL_RESTORE}（知基线）+ 重起`);
    const runsBefore = sumMetric(readCurrencyMetrics(), 'currency_reconcile_runs_total');
    await putInterval(admin, 'currency.reconcileIntervalMs', RECONCILE_INTERVAL_INJECT, 'I 注入');
    // ⚠️ `--force-recreate` 不可省（slice-14 C16 同款截断）：`up -d` 对**未变**容器是 no-op，
    //    而「已排定的一轮不撤、其后按现读值排期」（本片 ⚙️7）⇒ 不真重启就只在**旧间隔**后
    //    才有下一轮对账（1h ⇒ runs+2 的 90s 观测窗必红）。
    const inject = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'currency-service');
    checks.eq(inject.code, 0, `I 注入重起 currency-service —— 输出尾部：${tailOut(inject.out)}`);
    const injectHealthy = await waitContainerHealthy('ftl-currency-service');
    checks.that(injectHealthy.ok, `I 注入态 currency-service 就绪 —— ${injectHealthy.last}`);
    // 90s 窗复算（本片 ⚙️9 换源后）：等快照 ≤10s（首排动作的有界等待）+ 10s 首跑 + 3s×2
    // ≈ 26s ⇒ 数字不改（90s 余量足）。
    const rounds = await pollUntil(
      () => {
        const text = readCurrencyMetrics();
        return {
          runs: sumMetric(text, 'currency_reconcile_runs_total'),
          drift: seriesValue(text, 'currency_reconcile_drift_accounts', {}),
          pool: seriesValue(text, 'currency_robot_pool_balance', {}),
          robotsSum: seriesValue(text, 'currency_robot_accounts_balance_sum', {}),
        };
      },
      (v) => v.runs >= runsBefore + 2,
      90_000,
      2_000,
    );
    checks.that(
      rounds.ok,
      `I 重起后跑够两轮（runs ${runsBefore} → ${rounds.last.runs}；注入 ${RECONCILE_INTERVAL_INJECT}ms）`,
    );
    checks.eq(
      rounds.last.drift,
      0,
      `I 金币局后对账漂移 = 0（drift_accounts=${rounds.last.drift}；E/F 两局的 robot-pool/机器人/真人账户全自洽）`,
    );
    // 两个 robot gauge 的**新鲜值**（同一轮刮擦；刷新点 = 对账轮末，注入 3s ⇒ 读数 ≤3s 旧）：
    // 默认 1h 间隔下这两条无法在 H 组成立（启动轮早于 E 的注资）——这里才是有判别力的时点。
    checks.that(
      (rounds.last.pool ?? 0) > 0,
      `I 对账轮刷新后的池余额 gauge > 0（实测 ${rounds.last.pool}；E 注资 +1e6 与机器人回收后必为正）`,
    );
    checks.that(
      (rounds.last.robotsSum ?? 0) > 0,
      `I 对账轮刷新后的机器人账户余额和 gauge > 0（实测 ${rounds.last.robotsSum}；E 补给后 ≥ 12000）`,
    );
    await putInterval(admin, 'currency.reconcileIntervalMs', RECONCILE_INTERVAL_RESTORE, 'I 还原基线');
    const restore = compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'currency-service');
    checks.eq(restore.code, 0, `I 还原重建（知基线 ${RECONCILE_INTERVAL_RESTORE}）—— 输出尾部：${tailOut(restore.out)}`);
    const restoreHealthy = await waitContainerHealthy('ftl-currency-service');
    checks.that(restoreHealthy.ok, `I 还原后 currency-service 就绪 —— ${restoreHealthy.last}`);

    // ══════════════════════════════════════════════════════════════════════
    // J 记录
    // ══════════════════════════════════════════════════════════════════════
    step('J：金币局记录 mode=gold + 战绩列表含该局（复用 E 的 roomCode）');
    for (const [seat, userId] of evE.humanSeats.entries()) {
      const user = evE.room.clients.find((c) => c.user.id === userId)!.user;
      const rec = await waitRecordWithDelta(user.accessToken, evE.room.roomCode, 10_000);
      checks.that(
        rec.found && rec.record?.mode === 'gold',
        `J seat ${seat} 战绩含该局且 mode='gold'（roomCode=${evE.room.roomCode}；实测 ${rec.record?.mode}）`,
      );
      checks.that(
        (rec.record?.endedAt ?? 0) > 0 && rec.record?.mySeat === seat,
        `J seat ${seat} 记录的 endedAt>0 且 mySeat=${seat}（快照语义）`,
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    // 收尾：配置复原 + 读数自证 + 队列零残留
    // ══════════════════════════════════════════════════════════════════════
    step('收尾：gold=true（裁决后的种子态）/ rake=0 / relief=false 复原 + 读数自证 + 队列零残留');
    const finalOn = await putConfigAndWaitEffect(admin, 'game.doudizhu.goldRoomEnabled', true, 'room-service');
    checks.that(
      finalOn.putCode === ErrCode.OK && finalOn.refreshOk,
      `收尾 PUT gold=true ⇒ 200 且 room-service 快照生效（version=${finalOn.expected}）`,
    );
    const finalCfg = await adminGetConfig<AdminConfigData>(admin);
    const finalValues = {
      gold: finalCfg.body?.data?.config?.['game.doudizhu.goldRoomEnabled']?.value,
      rake: finalCfg.body?.data?.config?.['game.doudizhu.rakePercent']?.value,
      relief: finalCfg.body?.data?.config?.['currency.reliefEnabled']?.value,
      reliefAmount: finalCfg.body?.data?.config?.['currency.reliefAmount']?.value,
    };
    checks.eq(
      JSON.stringify(finalValues),
      JSON.stringify({ gold: true, rake: 0, relief: false, reliefAmount: RELIEF_AMOUNT_SEED }),
      '收尾读数自证：gold=true / rake=0 / relief=false / reliefAmount=200（全部回种子；gold 经 2026-10-04 裁决为 true）',
    );
    checks.eq(scanRedisKeys('match:queue:gold:*').length, 0, '收尾：match:queue:gold:* 零键（零残留）');
    checks.eq(goldMetaCount(), 0, '收尾：gold 票 meta 零残留');

    for (const room of openRooms) for (const c of room.clients) c.close();
    return checks;
  } finally {
    // ── 兜底复原（成败皆然）──────────────────────────────────────────────
    // 正常路径已复原；这里兜「前文抛错或被中断」。整段吞错只 info：
    // 兜底复原**不许**顶掉原始结论。
    try {
      for (const room of openRooms) for (const c of room.clients) c.close();
      await putInterval(admin, 'currency.reconcileIntervalMs', RECONCILE_INTERVAL_RESTORE, 'finally 兜底：还原基线');
      compose({}, 'up', '-d', '--no-deps', '--force-recreate', 'currency-service');
      await adminPutConfig('game.doudizhu.goldRoomEnabled', true, admin);
      await adminPutConfig('game.doudizhu.rakePercent', 0, admin);
      await adminPutConfig('currency.reliefEnabled', false, admin);
    } catch (err) {
      info(
        `兜底复原失败（不影响原始结论；手动检查 gold/rake/relief 三键与 currency-service 注入态）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

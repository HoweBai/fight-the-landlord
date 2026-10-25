/**
 * conformance 用例：**广告小片 —— 激励视频 → 金币场「每日救助」**（`slice-24-ads-relief`；
 * 规格 v1.4 §5.2 的 ⓪–⑫ **十二组** + 收尾）。
 *
 * ─── 判据载体（真栈面）────────────────────────────────────────────────────────
 *  - 全链经**真栈**：玩家面走网关（`http://localhost:3000`，`GET /api/wallet/relief[?claim=]`）；
 *    回调面**经门口**（`https://localhost:8443/ad/notify/uniad`，自签——顺带验收 Caddy 的
 *    `handle /ad/notify/*`，照 slice-21:101-102 的 `EDGE_HTTPS_PORT`/`NOTIFY_PATH` 形态）；
 *    管理面走网关（`/api/admin/ad-channel` 三端点 + `/api/admin/config/:key` + 钱包 adjust/读账）；
 *    观测面 = currency-service 9004 `/metrics`（exec+Bearer，指标端口不发布宿主口——照 slice-17/18）
 *    + Prometheus `/api/v1/rules`（照 slice-16/23）；Redis 构造/回读面 = `lib/redis` 的 `redisRaw`
 *    （`docker compose exec -T redis redis-cli …`）。
 *  - 签名样本 = **T20 helper**（`lib/ad-callback.ts`：`signAdCallback`/`toQueryString`/
 *    `loadAdCallbackSecret`）。回调线 = **HTTP GET + query 八字段**，签名
 *    `sign = sha256hex(secret + ':' + trans_id)`；终态一律 200 `{"isValid":true}`。
 *
 * ─── 密钥夹具（v1.4 已落定）─────────────────────────────────────────────────────
 *  回调密钥 = `fixtures/ad-callback/callback-secret.txt`（32B hex；`generate-fixtures.mjs` 生成，
 *  与 `conformance-stack.sh` PUT 入库值 byte-exact 同源）。**惰性单例装载**（首签名步触发）：
 *  run.ts 静态 import 全部 slice，模块顶层读夹具会让缺夹具时 `--list` 与其它片启动即崩。
 *  缺/空夹具 ⇒ helper 抛 `AdCallbackSecretLoadError`，本片转 ConformanceError 指引重跑生成器。
 *
 * ─── 十二组（组序与状态链；未列组沿用前组末态——规格 §5.2 前言）────────────────────
 *  ⓪ 起手自证（前置 = 空/脏库任意；末态 = 干净命名空间 + 种子态自证）：四容器 healthy ·
 *     `relief:claim:*`/`ad:notify:rate` 清源归零 · 开关=false / adpid='' 种子态自证 ·
 *     第四键空间种子在场 · Prometheus rules 恰 31 含两新告警。
 *  ① 键空间面（ad-channel 管理面）：掩码读（value 恒 null+指纹=宿主复算）· super_admin
 *     写读回 · 非 SA（operator/finance/viewer）×（PUT/DELETE）⇒ 403 · 种子密钥生效
 *     （末态 = 四键空间回种子）。
 *  ② 键面（**此处起重启状态=开关关**）：`/api/config` 恰 21 键（排序字面，含第 15 键
 *     `reliefAdpid`）· 内部键零泄漏（`ad.`/`currency.` 前缀扫描）· 管理面 65 键 ·
 *     adpid 空串种子方向 + 非空下发生效 + 还原（末态 = adpid=''）。
 *  ③ 签发面（前置 = ③ 内 PUT `reliefEnabled=true` 并等到快照生效；末态 = 开关 ON）：
 *     eligible GET ⇒ claim（形态/双键/TTL）· 复用同 nonce + 续期 · 连发键数不增 ·
 *     **悬垂**（`redisRaw` DEL 记录留索引 ⇒ 新签且索引更新）· **同实例并发两发**（T12 登记面
 *     判定项：只钉「不产生双凭证 / 键数不增」的可观测性质——接纳结论见文件尾登记节）。
 *  ④ 拒发穷尽（末态 = 开关 ON）：**公开路径不得 404 反例钉**（T11 双钉的切片级扩展）：
 *     裸 GET 缺参 ⇒ 200 `{"isValid":true}`（走到链形状面 = malformed）；经门口 POST ⇒ **恰 405**
 *     `failure`（方法闸；404=exclude 复发 / 401=豁免失效 判别语进消息）；
 *     近邻 `/ad/notify/uniadx` 匿名 ⇒ 401 · `/api/ad/notify/uniad` 匿名 ⇒ 401（豁免面精确）·
 *     且 405/401 三枚**均不入 `relief_callback_total`**（链前拒）· 畸形（真签样本缺业务必填）
 *     ⇒ 200/true（malformed）· 坏签名 ⇒ 200/true（bad_sign）· **改串归 claim_invalid**
 *     （v1.4：sign 只覆盖 secret+trans_id，改 extra 不破坏签名，随机 nonce 无 claim）·
 *     未签发/过期 ⇒ 200/true（claim_invalid）·
 *     中途切开关 ⇒ `done:disabled` + rejected · 中途充值 ⇒ `done:balance_ok` + rejected。
 *  ⑤ **正路一次（经门口）**：GET 签发 ⇒ 签名 GET 回调 ⇒ 200 `{"isValid":true}` + 余额 +200 +
 *     GET 已发（`今天已经领过了`）+ 记录 done:granted + 索引删（done 落定）+ 两指标 +1。
 *  ⑥ 重投幂等：同载荷二次 ⇒ 200 + 余额不变 + 记录零改写 + 发放面不重复计 `granted`。
 *  ⑦ **账本先行重放**：GET 签发 → `rpcApply` 预置同锚流水（actionId 逐字
 *     `relief:<userId>:<claim.date>`——**slice-18 形态 `:411/:1006`**，可自定义 actionId；
 *     ⚠️ **不得以「记录移除」构造**——那走 claim_invalid）→ 回调 ⇒ 200 + 余额不变 +
 *     记录 done:replayed + 指标 replayed+1/granted+0 + GET 已发（账本=唯一真源）。
 *  ⑧ **跨零点重投**：`redisRaw` 把记录 `date` 回写为昨日（KEEPTTL）⇒ 回调按**昨日锚** ⇒
 *     apply 成功（余额 +200、`relief:<u>:<昨日>` 流水在场）且**今日** `grantedToday`
 *     未翻转（无 claim GET ⇒ `余额充足，无需救助`——账本锚按记录日期，不按时钟当日）。
 *  ⑨ 轮询四态（携 claim，只读）：pending（+**只读自证**：TTL 不回 900、索引不变、键数不变）/
 *     成功 / 终态拒绝（disabled·balance_ok 各自 reason）/ 失效（未见过的 nonce）+
 *     跨主体按不存在（amount/balance 恒取 JWT 侧）。
 *  ⑩ `claim_invalid` 不建键：签名回调打「未见过的 nonce」⇒ 200 + Redis `relief:claim:*`
 *     键数前后相等 + 该记录键仍不存在 + 指标 claim_invalid +1。
 *  ⑪ 旧 POST ⇒ 404（经网关；`{code:10001}` 统一信封）· GET 新面语义：未见过的 claim ⇒
 *     失效面（claim 确实透传）· `?claim=` 空串 ⇒ 视同未携（网关丢弃口径同形）。
 *  ⑫ 收尾：开关关（PUT+快照生效自证）· adpid '' · claim 命名空间/限流桶零残留 + 客户端面
 *     四断言自证（末态 = 种子态）。
 *
 * ─── T12 登记面的接纳结论（记录，非断言；派单逐字）────────────────────────────
 *  「单连接 WATCH 交错退化」（ioredis WATCH=连接级 + redis.module 单连接 ⇒ 并发交错时
 *  条件删退化为非条件删；金额面 actionId 兜底、窗口有界）**已被控制者裁「接纳 + 注册」**。
 *  ③ 的同实例并发判定项**只钉可观测性质**（不产生双凭证 / 键数不增 / 索引仍指在场的
 *  issued 记录），**不测试残窗本身**——残窗的完整处置在 T24 台账；后续若替换为 Lua
 *  等价物，改动点集中 `conditionalDelIdx`/`markDone` 两处（与 slice 无关）。
 *
 * ─── 副作用与复原（登记）────────────────────────────────────────────────────
 *  - 探针用户 `s24` 全 fresh 注册（phone 带时间戳不撞）；claim 命名空间 `relief:claim:*`
 *    只有本片会产生 ⇒ ⓪/⑫ 的「清源 + 零键」是**确定性构造**（上一轮中途崩溃的残留会被
 *    ⓪ 清掉而不是假红）。
 *  - `currency.reliefEnabled` 由 ③ 置 true、④ 中途往返、⑫ 归 false；`finally` 兜底 false。
 *  - `ad.reliefAdpid` 由 ② 临时置非空并**组内还原**；`finally` 兜底（tracked by flag）。
 *  - ad-channel 键由 ① 轮换并**组内还原为栈种子**；`ad:notify:rate` 桶 ⓪/⑫ 清（片内数十次
 *    回调远低于 600/分，但清桶保「下一轮从零计」）。
 *  - ① 建三枚一次性管理账号（`s24o/s24f/s24v-` 前缀）：组内停用（只停用不删，照 slice-19/23）；
 *    `finally` 兜底停用。
 *  - ⑦ 的 RPC 预置流水与 ④/⑤/⑥/⑦/⑧ 的真实发放金额=种子 200 全部为**探针数据**（dev 栈先例）。
 *
 * ─── 零 skip、零数据依赖分支（基线回填的前提）──────────────────────────────────
 *  全部断言在任何环境下都执行；行集/键数断言一律先聚合（scan 计数、series 差分）后单条比较。
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import https from 'node:https';
import { resolve } from 'node:path';
import {
  CONFIG_KEYS,
  ErrCode,
  RPC_PATTERNS,
  type CurrencyApplyData,
  type CurrencyApplyRequest,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  GATEWAY_URL,
  INTERNAL_TOKEN,
  adminAdChannelDelete,
  adminAdChannelGet,
  adminAdChannelPut,
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
  type Envelope,
  type HarnessUser,
  type HttpResult,
} from '../lib/http';
import { redisRaw, redisReplyText } from '../lib/redis';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';
import {
  AdCallbackSecretLoadError,
  loadAdCallbackSecret,
  signAdCallback,
  toQueryString,
  type AdCallbackFields,
  type AdCallbackParams,
} from '../lib/ad-callback';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-16/22/23）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/* ── 真栈坐标（与 slice-21/23 同款）────────────────────────────────────────── */
/** 门口 HTTPS 口（回调正路经它——同时验收 Caddy 的 `handle /ad/notify/*`）。 */
const EDGE_HTTPS_PORT = process.env.EDGE_HTTPS_PORT ?? '8443';
/** 公开回调路径（**精确豁免对钉**的消费面：字面写死 = wire 级断言，不引实现常量）。 */
const AD_NOTIFY_PATH = '/ad/notify/uniad';
/** 近邻路径（豁免面**不得扩大**的反例：`/ad/notify/uniadx` 匿名 ⇒ 中间件 401）。 */
const AD_NOTIFY_NEIGHBOR = '/ad/notify/uniadx';
const PROM_URL = process.env.PROM_URL ?? 'http://localhost:9090';
/** `currency.apply` 的 TCP 监听（宿主直投 = compose override 的 `3104:3104`；⑦ 预置流水用）。 */
const CURRENCY_RPC: RpcEndpoint = {
  host: process.env.CURRENCY_RPC_HOST ?? 'localhost',
  port: Number(process.env.CURRENCY_RPC_PORT ?? 3104),
};

/* ── 键空间/种子（**字面写死 = wire 级断言**；与 conformance-stack.sh 种子段同字面）──── */
/** 第四键空间唯一键（v1.4 落定——本片对字面锁死）。 */
const AD_KEY = 'ad.callbackSecret';
const AD_KEY_LABEL = '回调密钥';
/**
 * 栈种子密钥（**惰性单例**：与 `conformance-stack.sh` PUT 入库的 `callback-secret.txt`
 * byte-exact 同源）。⚠️ **不得模块顶层装载**——run.ts 静态 import 全部 slice，
 * 顶层读夹具会让缺夹具时 `--list`/其它片启动即崩；首次签名/指纹步才装载并缓存。
 */
let cachedAdSecret: string | null = null;
const adSecret = (): string => (cachedAdSecret ??= loadAdCallbackSecret());
/** ① 轮换读回用的探针值（唯一后缀；组内还原为种子）。 */
/** ② 的 adpid 探针值（base62 合法；组内还原为空串）。 */
const PROBE_ADPID = 's24ProbeAdpid';
/** 第 41 键（管理面键名）/ 客户端裸名（第 15 键）。 */
const AD_KEY_CONFIG = 'ad.reliefAdpid';
const AD_KEY_CLIENT = 'reliefAdpid';
/** 救助金额种子（§12.1 第 17 键缺省 200——④ 中途充值的「门槛之上」读数应高于平台门槛 `currency.reliefThresholdCoins`）。 */
const RELIEF_AMOUNT_SEED = 200;
/** `/api/config` 的**恰好**键集（排序后逐字；记牌器收费片起 = 20 键——阶段 2 已删除派生字段 `entryFeePercents`；
 *  广告片起 `reliefAdpid` 插于 `rechargePackages`/`reliefEnabled` 间）。 */
const CLIENT_CONFIG_KEYS_SORTED =
  'baseScoreLevels,cardCounterEnabled,cardCounterPricePerGameCoins,cardCounterPricePerHourCoins,coinPerYuan,entryMultiplier,freeRoomEnabled,friendRoomEnabled,games,goldRoomEnabled,rechargeEnabled,rechargePackages,reliefAdpid,reliefEnabled,reliefThresholdCoins,version,withdrawDailyMaxCoins,withdrawEnabled,withdrawMaxCoinsPerOrder,withdrawMinCoins,withdrawReAuthEnabled';
/** §2.7 新告警两条（⓪ 的「规则 27 就位」面）。 */
const AD_ALERT_RULES = ['ReliefCallbackBroken', 'ReliefGrantZero'] as const;
/** ⓪ 的容器健康面（本片依赖的真栈容器——含门口与 Prometheus）。 */
const HEALTH_CONTAINERS = ['ftl-currency-service', 'ftl-config-service', 'ftl-edge', 'ftl-prometheus'] as const;

/** 本 run 唯一后缀（账号/trans_id/actionId；同栈连跑两轮不互撞）。 */
const TAG = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(-8);

/** 管理面 ad-channel 条目（键空间恰 1 键；照 slice-22/23 的条目投影形态）。 */
interface AdminAdEntry {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  value: string | null;
  fingerprint: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** 值指纹 = `sha256(值) hex 前 12`（§2.3；服务侧同口径——本片全部指纹断言由此独立复算）。 */
const fpOf = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

/** Asia/Shanghai 的 `YYYY-MM-DD`（en-CA `formatToParts` 装配——与后端 `shanghai-date.ts` 同口径）。 */
function shanghaiDateOf(t: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(t));
  const partOf = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${partOf('year')}-${partOf('month')}-${partOf('day')}`;
}

/** 由上海日历日串推前一天（`dateStr` 的 UTC 零点 - 86400s 再回上海日历窗 ⇒ 前一日）。 */
function prevShanghaiDay(dateStr: string): string {
  return shanghaiDateOf(Date.parse(`${dateStr}T00:00:00Z`) - 86_400_000);
}

/** 22 字符 base64url 随机串（nonce 形态；「未见过的 claim」样本构造面）。 */
const randomNonce = (): string => randomBytes(16).toString('base64url');

/**
 * 回调字段（v1.4 §2.4 wire 八字段；`user_id` 仅信息性——身份只来自 extra claim）。
 * `user_id` 取**空串**：与真机平台一致（未绑定用户时平台发 `user_id=`，2026-10-18 实抓；
 * 服务端不得因它拒绝回调）。`_user` 保留入参位以维持各调用点形状。
 */
const callbackFields = (_user: HarnessUser, extra: string, slug: string): AdCallbackFields => ({
  adpid: PROBE_ADPID,
  provider: 'china',
  platform: 'Android',
  trans_id: `s24-${TAG}-${slug}`,
  user_id: '',
  extra,
});

/* ──────────────────────────────────────────────────────────────────────────
 * docker / redis / metrics 助手（形态先例：slice-17/18/23）
 * ────────────────────────────────────────────────────────────────────────── */

/** 跑一条 `docker` 命令（带超时 + MSYS 防路径转写；照 slice-16/22/23）。 */
function docker(args: string[], timeoutMs = 60_000): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/** 某容器最近的日志（`docker logs --since`；`--no-color` 必须有——ANSI 会让「找那一行」恒假）。 */
function composeLogs(service: string, sinceSeconds: number): string {
  const r = spawnSync('docker', ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, service], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 一行日志里抽出 NDJSON 记录（前缀 `ftl-x | ` 与非 JSON 行一律 null；照 slice-18/21）。 */
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

/** 有界轮询：读一处观测值直到条件满足（返回末次读数，调用方断言；照 slice-16/23）。 */
async function pollUntil<T>(
  read: () => T | Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<{ ok: boolean; last: T | undefined }> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    try {
      last = await read();
      if (ok(last)) return { ok: true, last };
    } catch {
      /* 未就绪：继续等 */
    }
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(intervalMs);
  }
}

/** 等容器 healthy（有界；返回末次读数 —— 由调用方断言；照 slice-23）。 */
async function waitContainerHealthy(container: string, timeoutMs = 90_000): Promise<{ ok: boolean; last: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const r = docker(['inspect', container, '--format', '{{.State.Health.Status}}']);
    last = (r.stdout ?? '').trim() || (r.stderr ?? '').trim();
    if (last === 'healthy') return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(1_000);
  }
}

/** `redis-cli …` 单条回复文本（stdout 优先回落 stderr；照 slice-18 的口径）。 */
function redisCliText(args: string[]): string {
  return redisReplyText(redisRaw(args));
}

/** `--scan --pattern` 的键清单（只读；照 slice-17/18）。 */
function scanRedisKeys(pattern: string): string[] {
  const reply = redisRaw(['--scan', '--pattern', pattern]);
  if (reply.status !== 0) {
    throw new ConformanceError(`redis-cli --scan 失败（退出码 ${reply.status}）：${redisReplyText(reply) || '（无输出）'}`);
  }
  return reply.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** claim 命名空间键数（⑩ 的「前后对照」与 ③ 的「键数不增」共用同一读数）。 */
const claimKeyCount = (): number => scanRedisKeys('relief:claim:*').length;

/** claim 命名空间清源（⓪/⑫/`finally`；构造面——本命名空间只有本片会产生键）。 */
function purgeClaimKeys(): number {
  const keys = scanRedisKeys('relief:claim:*');
  for (const key of keys) redisRaw(['DEL', key]);
  return keys.length;
}

/** 读一条 claim 记录的**原文**（不存在 ⇒ `''`）。 */
const claimRecordRaw = (nonce: string): string => redisCliText(['GET', `relief:claim:${nonce}`]);

/** 读一条 claim 记录的 JSON（不存在/畸形 ⇒ null）。 */
function claimRecordJson(nonce: string): Record<string, unknown> | null {
  const raw = claimRecordRaw(nonce);
  if (raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `/metrics` 的 exec 入口（照 slice-16/17）：返回 HTTP 状态码 + body（curl `-w` 哨兵行拆开）。 */
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

/* ── Prom 文本解析（照 slice-16/17；判定面只用「精确标签匹配」一个读法）────────── */

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

/** 某指标**恰好匹配这些标签**的序列值（缺席返回 `null` —— 与「值是 0」分开，别混）。 */
function seriesValue(text: string, name: string, want: Record<string, string>): number | null {
  for (const s of parseProm(text)) {
    if (s.name !== name) continue;
    const hit = Object.entries(want).every(([k, v]) => s.labels[k] === v);
    if (hit) return s.value;
  }
  return null;
}

/** 某指标全部序列的值求和（「405/401 不入桶」的总量差分用）。 */
function sumMetric(text: string, name: string): number {
  return parseProm(text)
    .filter((s) => s.name === name)
    .reduce((acc, s) => acc + (Number.isFinite(s.value) ? s.value : 0), 0);
}

/** 一次读回的全部相关计数（差分口径；prom-client 首次 inc 前无样本 ⇒ 缺席按 0）。 */
interface MetricCounts {
  cbAccepted: number;
  cbClaimInvalid: number;
  cbBadSign: number;
  cbMalformed: number;
  cbError: number;
  cbSum: number;
  reliefGranted: number;
  reliefReplayed: number;
  reliefRejected: number;
}

function readMetricCounts(): MetricCounts {
  const text = readCurrencyMetrics();
  const s = (name: string, result: string): number => seriesValue(text, name, { result }) ?? 0;
  return {
    cbAccepted: s('relief_callback_total', 'accepted'),
    cbClaimInvalid: s('relief_callback_total', 'claim_invalid'),
    cbBadSign: s('relief_callback_total', 'bad_sign'),
    cbMalformed: s('relief_callback_total', 'malformed'),
    cbError: s('relief_callback_total', 'error'),
    cbSum: sumMetric(text, 'relief_callback_total'),
    reliefGranted: s('currency_relief_total', 'granted'),
    reliefReplayed: s('currency_relief_total', 'replayed'),
    reliefRejected: s('currency_relief_total', 'rejected'),
  };
}

/** Prometheus 规则名清单（⓪；照 slice-16 C2 的读法）。 */
async function fetchPromRuleNames(): Promise<string[]> {
  const res = await fetch(`${PROM_URL}/api/v1/rules`, { signal: AbortSignal.timeout(15_000) });
  const parsed = JSON.parse(await res.text()) as {
    data?: { groups?: Array<{ rules?: Array<{ name?: string }> }> };
  };
  return (parsed.data?.groups ?? []).flatMap((g) => g.rules ?? []).map((r) => r.name ?? '');
}

/* ── 门口（TLS 自签）请求 —— 回调投递路径（照 slice-21 的 `edgeRequest`）────── */

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

/* ── 管理面助手（照 slice-18/19/23 形态）──────────────────────────────────── */

async function loginAdminAs(username: string, password: string): Promise<string> {
  const res = await postJson<{ token: string }>('/api/admin/login', { username, password });
  const token = res.body?.data?.token;
  if (res.body?.code !== ErrCode.OK || !token) {
    throw new ConformanceError(`管理登录 ${username} 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return token;
}

/** 任意方法/路径的网关请求（非 SA 矩阵与近邻面用；照 slice-22/23）。 */
async function sendRaw(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: Envelope | null }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
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
    parsed = { code: res.status, message: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

function expectHttp(checks: Checks, res: { status: number; body: Envelope | null }, status: number, code: number, label: string): void {
  checks.eq(res.status, status, `${label} ⇒ HTTP ${status}`);
  checks.eq(res.body?.code, code, `${label} ⇒ code ${code}`);
}

/**
 * 清管理写桶（`ratelimit:admin-write:<sha256(token)[:16]>`；键指纹算法 = 网关 `adminTokenFp`）。
 * 本片管理写面十余次（阈值 30/5min）——在每个写突发前清一次，防 429 假红（照 slice-23）。
 */
function clearAdminWriteBucket(token: string): void {
  const fp = createHash('sha256').update(token).digest('hex').slice(0, 16);
  redisRaw(['DEL', `ratelimit:admin-write:${fp}`]);
}

/**
 * `PUT /api/admin/config/:key` + **等目标服务的快照生效**（照 slice-18 的 `putConfigAndWaitEffect`
 * ——生效观测 = currency-service 日志里 `config snapshot applied (version=…)` 行**计数**增量；
 * 版本算术 = `max(全局, 本键+1)`；计数口径把「容器启动首拉/安全网轮/上一次同版本行」全排除）。
 */
async function putConfigAndWaitEffect(
  admin: string,
  key: string,
  value: unknown,
  service: string,
): Promise<{ putCode: number | undefined; refreshOk: boolean; observed: number | undefined; baseline: number; expected: number }> {
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

/** `POST /api/admin/wallet/adjust`（管理面单笔；照 slice-18 形态——⑦ 之外的「中途充值」用）。 */
async function adminAdjust(
  admin: string,
  userId: string,
  delta: number,
  actionId: string,
): Promise<{ status: number; code: number | undefined; balanceAfter: number | null }> {
  const res = await postJson<{ balanceBefore: number; balanceAfter: number; opId: number }>(
    '/api/admin/wallet/adjust',
    { userId, delta, reason: `slice24 ${TAG}`, actionId },
    admin,
  );
  return {
    status: res.status,
    code: res.body?.code,
    balanceAfter: res.body?.data?.balanceAfter ?? null,
  };
}

/** `GET /api/admin/wallet/accounts/:userId`（管理面读账；未开户 = 200 空态。照 slice-18）。 */
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

/* ── 玩家面 / 回调面助手（本片判据核心）───────────────────────────────────── */

interface ReliefData {
  eligible: boolean;
  grantedToday: boolean;
  amount: number;
  balance: number;
  claim?: string;
  reason?: string;
}

/** `GET /api/wallet/relief[?claim=]`（经网关；携 claim 时经 `encodeURIComponent`）。 */
const getRelief = (user: HarnessUser, claim?: string): Promise<HttpResult<ReliefData>> =>
  getJson<ReliefData>(
    `/api/wallet/relief${claim === undefined ? '' : `?claim=${encodeURIComponent(claim)}`}`,
    user.accessToken,
  );

const rpcApply = (req: CurrencyApplyRequest, timeoutMs = 8_000): Promise<RpcResult<CurrencyApplyData>> =>
  rpcCall<CurrencyApplyData>(CURRENCY_RPC, RPC_PATTERNS.currencyApply, req, timeoutMs);

/**
 * 签名样本构造（v1.4 真算法）：密钥惰性取共享夹具单例（与栈 PUT 值同源）。
 * 夹具缺/空 ⇒ helper 抛 `AdCallbackSecretLoadError`，本包装转 ConformanceError 指引跑生成器。
 */
function signedParams(fields: AdCallbackFields, what: string): AdCallbackParams {
  try {
    return signAdCallback(fields, adSecret());
  } catch (err) {
    if (err instanceof AdCallbackSecretLoadError) {
      throw new ConformanceError(
        `${what}：签名样本构造不可用 —— ${err.message}`,
      );
    }
    throw err;
  }
}

/** 经门口投递一条回调（v1.4：**GET + query**，无 body；返回状态码 + 应答体）。 */
function getNotifyViaEdge(params: AdCallbackParams): Promise<{ status: number; body: string }> {
  return edgeRequest('GET', `${AD_NOTIFY_PATH}?${toQueryString(params)}`, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════════ */

export async function runSlice24(): Promise<Checks> {
  const checks = new Checks();
  /** 管理令牌（引导号 super_admin）。 */
  let adminToken = '';
  /** 本片是否把开关置过 true（finally 兜底复原 false）。 */
  let reliefEnabledTripped = false;
  /** adpid 是否处于非空探针态（finally 兜底复原 ''）。 */
  let adpidTripped = false;
  /** ① 建的一次性账号（收尾/finally 停用留档）。 */
  const probeAccounts: Array<{ id: number; username: string }> = [];
  /** ⑤ 成功面的 claim（⑨ 的「成功」态复用；⑥ 重投复用它）。 */
  let claimGranted = '';
  /** ④ 中途切开关的 claim（⑨ 的「终态拒绝 disabled」复用）。 */
  let claimDisabled = '';
  /** ④ 中途充值的 claim（⑨ 的「终态拒绝 balance_ok」复用）。 */
  let claimBalanceOk = '';
  /** ⑨ pending 的 claim（跨主体面复用）。 */
  let claimPending = '';
  let pendingUser: HarnessUser | null = null;
  /** 主路径是否已完整收尾（finally 的复原只在异常路径才必要，但幂等无害）。 */
  let wrappedUp = false;

  try {
    /* ── ⓪ 起手自证 ──────────────────────────────────────────────────────── */
    step('⓪ 起手自证：四容器 healthy · relief:claim/ad:notify:rate 清源归零 · 开关=false/adpid=空串种子态 · 第四键空间种子在场 · rules 恰 31 含两新告警');
    for (const container of HEALTH_CONTAINERS) {
      const h = await waitContainerHealthy(container);
      checks.that(h.ok, `⓪ ${container} healthy（${h.last}）`);
    }
    const purged = purgeClaimKeys();
    info(`清源：relief:claim:* 删除 ${purged} 键（上一轮中途崩溃的残留会被清掉而非假红）`);
    checks.eq(claimKeyCount(), 0, `⓪ 清源后 relief:claim:* 零键`);
    redisRaw(['DEL', 'ad:notify:rate']);
    checks.eq(redisCliText(['EXISTS', 'ad:notify:rate']), '0', '⓪ 限流桶 ad:notify:rate 已清（本 run 从零计数）');
    const metricsBoot = readCurrencyMetrics();
    checks.that(
      metricsBoot.includes('relief_callback_total') && metricsBoot.includes('currency_relief_total'),
      '⓪ 9004 /metrics 可读且两指标族在场（后续全部差分断言的判据面非空转）',
    );

    adminToken = await adminLogin();
    checks.that(adminToken.length > 0, '⓪ 引导号管理登录 ⇒ token（本片全部管理面的 actor 真源）');
    clearAdminWriteBucket(adminToken);

    const cfg0 = await adminGetConfig<{ config: Record<string, { value: unknown; version: number }> }>(adminToken);
    checks.eq(
      cfg0.body?.data?.config?.['currency.reliefEnabled']?.value,
      false,
      '⓪ currency.reliefEnabled 种子态 = false（上一轮未收尾的会在 ⑫/finally 复原——此处是前置自证）',
    );
    checks.eq(cfg0.body?.data?.config?.[AD_KEY_CONFIG]?.value, '', `⓪ 第 41 键 ${AD_KEY_CONFIG} 种子态 = 空串（暗上线方向）`);

    const g0 = await adminAdChannelGet<{ keys: AdminAdEntry[] }>(adminToken);
    expectHttp(checks, g0, 200, ErrCode.OK, '⓪ GET /api/admin/ad-channel（第四键空间种子在场自证）');
    checks.that(
      g0.body?.data?.keys?.[0]?.configured === true,
      `⓪ 第四键空间种子在场（configured=true——栈种子段已跑）—— 实际 ${JSON.stringify(g0.body?.data?.keys?.[0])}`,
    );

    const ruleNames0 = await fetchPromRuleNames();
    checks.that(ruleNames0.length === 31, `⓪ Prometheus /api/v1/rules 恰 31 条（29 既有 + 2 救助；A1 同步面）—— 实际 ${ruleNames0.length}`);
    checks.that(
      AD_ALERT_RULES.every((n) => ruleNames0.includes(n)),
      `⓪ 两新告警名逐个在场（${AD_ALERT_RULES.join('/')}；只钉数量的话 31 条错规则也绿）`,
    );
    const A1_ALERT_RULES = [
      'GameStartFailuresHigh', 'GameSettleFailures', 'SettleDroppedByGame', 'RecordWriteFailuresHigh',
    ];
    checks.that(
      A1_ALERT_RULES.every((n) => ruleNames0.includes(n)),
      `⓪ A1 四条按玩法告警逐个在场（${A1_ALERT_RULES.join('/')}）`,
    );

    /* ── ① 键空间面（ad-channel 管理面）──────────────────────────────────── */
    step('① 键空间面：掩码读（value 恒 null + 指纹=宿主复算）· super_admin 写读回 · 非 SA（三角色×两方法）⇒ 403 · 种子密钥生效（组末态=回种子）');
    const g1 = await adminAdChannelGet<{ keys: AdminAdEntry[] }>(adminToken);
    expectHttp(checks, g1, 200, ErrCode.OK, '① GET /api/admin/ad-channel（掩码读）');
    const keys1 = g1.body?.data?.keys ?? [];
    checks.eq(keys1.length, 1, `① 条目恰一项（第四键空间恰 1 键）`);
    checks.that(
      keys1[0]?.key === AD_KEY && keys1[0]?.label === AD_KEY_LABEL,
      `① 键名/标签逐字（${AD_KEY} / ${AD_KEY_LABEL}）—— 实际 ${JSON.stringify([keys1[0]?.key, keys1[0]?.label])}`,
    );
    checks.that(
      keys1[0]?.secret === true && keys1[0]?.value === null,
      `① 密键掩码：secret=true 且 value 恒 null（读口不回明文）—— 实际 ${JSON.stringify({ secret: keys1[0]?.secret, value: keys1[0]?.value })}`,
    );
    checks.eq(
      keys1[0]?.fingerprint,
      fpOf(adSecret()),
      '① 种子指纹 = 宿主 sha256(callback-secret.txt 值) 前 12（服务侧指纹的同口径独立复算——种子字节逐字落地）',
    );
    checks.that(
      keys1[0]?.configured === true && typeof keys1[0]?.updatedAt === 'number',
      `① configured=true 且 updatedAt 为数字（种子写者）—— 实际 ${JSON.stringify({ configured: keys1[0]?.configured, updatedAt: keys1[0]?.updatedAt })}`,
    );

    // super_admin 写读回（轮换 → 读回 → 清空 → 读回 → 回种子）。
    clearAdminWriteBucket(adminToken);
    const rotated = `s24-rotated-${TAG}-secret`;
    const putR = await adminAdChannelPut(AD_KEY, rotated, adminToken);
    expectHttp(checks, putR, 200, ErrCode.OK, '① SA PUT 轮换值');
    checks.eq(putR.body?.data?.fingerprint, fpOf(rotated), '① PUT 返回指纹 = 宿主复算（canonical 逐字 = trim 原文）');
    const g1b = await adminAdChannelGet<{ keys: AdminAdEntry[] }>(adminToken);
    checks.that(
      g1b.body?.data?.keys?.[0]?.fingerprint === fpOf(rotated) && g1b.body?.data?.keys?.[0]?.value === null,
      `① 写读回自证：指纹 = 轮换值且 value 仍 null —— 实际 ${JSON.stringify(g1b.body?.data?.keys?.[0]?.fingerprint)}`,
    );
    const delR = await adminAdChannelDelete(AD_KEY, adminToken);
    expectHttp(checks, delR, 200, ErrCode.OK, '① SA DELETE（清空）');
    checks.eq(delR.body?.data?.saved, true, '① DELETE ⇒ {saved:true}（幂等契约）');
    const g1c = await adminAdChannelGet<{ keys: AdminAdEntry[] }>(adminToken);
    checks.eq(g1c.body?.data?.keys?.[0]?.configured, false, '① 清空已生效（configured=false）');
    const putS = await adminAdChannelPut(AD_KEY, adSecret(), adminToken);
    expectHttp(checks, putS, 200, ErrCode.OK, '① PUT 回种子值（组末态恢复栈种子 = callback-secret.txt）');
    checks.eq(putS.body?.data?.fingerprint, fpOf(adSecret()), '① 回写返回指纹 = 种子指纹（还原自证）');

    // 非 SA 403 矩阵（三角色 × 两方法；P-a1/P-a2 仅 super_admin）。
    clearAdminWriteBucket(adminToken);
    const oneTimePw = `s24-${TAG}-passw0rd`;
    const accounts: Array<{ role: 'operator' | 'finance' | 'viewer'; username: string }> = [
      { role: 'operator', username: `s24o-${TAG}` },
      { role: 'finance', username: `s24f-${TAG}` },
      { role: 'viewer', username: `s24v-${TAG}` },
    ];
    const tokens: Record<string, string> = {};
    for (const a of accounts) {
      const cre = await postJson<{ id: number }>('/api/admin/accounts', { username: a.username, password: oneTimePw, role: a.role }, adminToken);
      expectHttp(checks, cre, 200, ErrCode.OK, `① 建一次性 ${a.role} 账号`);
      probeAccounts.push({ id: cre.body?.data?.id ?? -1, username: a.username });
      tokens[a.role] = await loginAdminAs(a.username, oneTimePw);
      checks.that(tokens[a.role].length > 0, `① ${a.role} 登录成功（矩阵的凭据）`);
    }
    const nonSaCodes: Array<number | undefined> = [];
    for (const role of ['operator', 'finance', 'viewer'] as const) {
      for (const method of ['PUT', 'DELETE'] as const) {
        const r = await sendRaw(method, `/api/admin/ad-channel/${AD_KEY}`, tokens[role], method === 'PUT' ? { value: rotated } : undefined);
        checks.eq(r.status, 403, `① 非 SA ${role} ${method} /api/admin/ad-channel/${AD_KEY} ⇒ 403（P-a1/P-a2 仅 super_admin）`);
        nonSaCodes.push(r.body?.code);
      }
    }
    checks.that(
      nonSaCodes.every((c) => c === ErrCode.FORBIDDEN),
      `① 非 SA 6 格全为 10003（FORBIDDEN）—— 实际码集 ${JSON.stringify([...new Set(nonSaCodes)])}`,
    );
    for (const a of probeAccounts) {
      const dis = await sendRaw('PATCH', `/api/admin/accounts/${a.id}`, adminToken, { status: 'disabled' });
      checks.eq(dis.status, 200, `① 组内停用一次性账号 ${a.username} ⇒ 200`);
    }
    const accList = await getJson<{ accounts: Array<{ username: string; status: string }> }>('/api/admin/accounts', adminToken);
    expectHttp(checks, accList as { status: number; body: Envelope | null }, 200, ErrCode.OK, '① GET /api/admin/accounts（停用自证读口）');
    const activeLeft = (accList.body?.data?.accounts ?? []).filter(
      (x) => probeAccounts.some((a) => a.username === x.username) && x.status === 'active',
    );
    checks.that(activeLeft.length === 0, `① 三枚一次性账号均已 disabled（不留活跃凭据）—— 残留 ${JSON.stringify(activeLeft)}`);

    /* ── ② 键面 ─────────────────────────────────────────────────────────── */
    step('② 键面：/api/config 恰 21 键（排序字面）· 内部键零泄漏（ad./currency. 前缀扫描）· 管理面 65 键 · adpid 空串种子方向 + 非空下发生效 + 还原');
    const uCfg = await registerUser(61);
    const cfgA = await getJson<Record<string, unknown>>('/api/config', uCfg.accessToken);
    expectHttp(checks, cfgA as { status: number; body: Envelope | null }, 200, ErrCode.OK, '② GET /api/config（玩家面）');
    const cfgKeys = Object.keys(cfgA.body?.data ?? {});
    checks.eq(cfgKeys.sort().join(','), CLIENT_CONFIG_KEYS_SORTED, '② /api/config 键集（排序后）恰 21 键逐字（reliefAdpid 插于 rechargePackages/reliefEnabled 间）');
    checks.eq((cfgA.body?.data as Record<string, unknown>)?.[AD_KEY_CLIENT], '', `② ${AD_KEY_CLIENT} 空串种子方向（fail 方向 = 空串 ⇒ 入口不渲染）`);
    const cfgRaw = JSON.stringify(cfgA.body?.data ?? null);
    checks.that(
      !cfgRaw.includes('ad.') && !cfgRaw.includes('currency.'),
      `② 原始载荷零出现 'ad.'/'currency.' 内部前缀 —— 命中 ${JSON.stringify([...(cfgRaw.match(/(?:ad|currency)\.[A-Za-z]+/g) ?? [])])}`,
    );
    const adminCfg = await adminGetConfig<{ config: Record<string, { value: unknown; version: number }> }>(adminToken);
    expectHttp(checks, adminCfg as { status: number; body: Envelope | null }, 200, ErrCode.OK, '② GET /api/admin/config（管理面）');
    checks.eq(Object.keys(adminCfg.body?.data?.config ?? {}).length, CONFIG_KEYS.length, '② 管理面键总数 = CONFIG_KEYS.length（含跑得快/斗地主玩法键与斗地主总开关）');
    checks.eq(adminCfg.body?.data?.config?.[AD_KEY_CONFIG]?.value, '', '② 管理面 ad.reliefAdpid 值 = 空串（string 种子首例的 JSON 字面量落地）');

    // adpid 非空 ⇒ 客户端面生效（每次查库；组内还原）。
    const putAd = await adminPutConfig(AD_KEY_CONFIG, PROBE_ADPID, adminToken);
    expectHttp(checks, putAd as { status: number; body: Envelope | null }, 200, ErrCode.OK, `② 管理面 PUT ${AD_KEY_CONFIG}=${PROBE_ADPID}`);
    const cfgB = await getJson<Record<string, unknown>>('/api/config', uCfg.accessToken);
    checks.eq((cfgB.body?.data as Record<string, unknown>)?.[AD_KEY_CLIENT], PROBE_ADPID, `② adpid 非空 ⇒ 客户端面生效（下发裸名 ${AD_KEY_CLIENT}）`);
    adpidTripped = true;
    const putAdBack = await adminPutConfig(AD_KEY_CONFIG, '', adminToken);
    expectHttp(checks, putAdBack as { status: number; body: Envelope | null }, 200, ErrCode.OK, `② 组内还原 ${AD_KEY_CONFIG}=''`);
    adpidTripped = false;
    const cfgC = await getJson<Record<string, unknown>>('/api/config', uCfg.accessToken);
    checks.eq((cfgC.body?.data as Record<string, unknown>)?.[AD_KEY_CLIENT], '', '② 还原空串已生效（组末态 = 种子态）');

    /* ── ③ 签发面 ───────────────────────────────────────────────────────── */
    step('③ 签发面：PUT reliefEnabled=true（快照生效）⇒ eligible GET ⇒ claim 形态/双键/TTL · 复用同 nonce+续期 · 键数不增 · 悬垂恢复（删记录留索引）· 同实例并发两发（T12 判定项：不产生双凭证/键数不增）');
    clearAdminWriteBucket(adminToken);
    const on3 = await putConfigAndWaitEffect(adminToken, 'currency.reliefEnabled', true, 'currency-service');
    checks.eq(on3.putCode, ErrCode.OK, `③ PUT currency.reliefEnabled=true ⇒ code 0（期望快照 version=${on3.expected}）`);
    checks.that(
      on3.refreshOk,
      `③ ≤30s currency-service 快照生效（version=${on3.expected} 计数 ${on3.baseline}→${on3.observed}）——「中途切开关」的观测路径自证`,
    );
    reliefEnabledTripped = true;

    const uC = await registerUser(62);
    const r1 = await getRelief(uC);
    expectHttp(checks, r1 as { status: number; body: Envelope | null }, 200, ErrCode.OK, '③ GET /api/wallet/relief（无 claim；开关 ON/余额 0 ⇒ eligible）');
    const d1 = r1.body?.data as ReliefData;
    checks.that(d1?.eligible === true && d1?.grantedToday === false, `③ eligible=true / grantedToday=false —— 实际 ${JSON.stringify(d1)}`);
    checks.eq(d1?.amount, RELIEF_AMOUNT_SEED, '③ amount = 200 种子（响应恒在场）');
    checks.eq(d1?.balance, 0, '③ 新用户余额 0（< 平台门槛 currency.reliefThresholdCoins ⇒ 走 ⑤ 签发枝）');
    const claim1 = d1?.claim ?? '';
    checks.that(
      /^[A-Za-z0-9_-]{22}$/.test(claim1),
      `③ claim 形态 = 22 字符 base64url（nonce = randomBytes(16).toString('base64url')）—— 实际 ${JSON.stringify(claim1)}`,
    );
    checks.that(!('reason' in (d1 ?? {})), '③ eligible 面无 reason 字段（reason 仅不可领/终态拒绝/失效在场）');
    checks.eq(redisCliText(['GET', `relief:claim:u:${uC.id}`]), claim1, '③ 索引键 relief:claim:u:{userId} = nonce（双键型 A）');
    const rec1 = claimRecordJson(claim1);
    checks.that(
      rec1?.userId === uC.id && rec1?.date === shanghaiDateOf(Date.now()) && rec1?.state === 'issued',
      `③ 记录 JSON 逐字 {userId, date=今日(上海), state:'issued'} —— 实际 ${JSON.stringify(rec1)}`,
    );
    const ttlRec1 = Number(redisCliText(['TTL', `relief:claim:${claim1}`]));
    const ttlIdx1 = Number(redisCliText(['TTL', `relief:claim:u:${uC.id}`]));
    checks.that(
      ttlRec1 > 0 && ttlRec1 <= 900 && ttlIdx1 > 0 && ttlIdx1 <= 900,
      `③ 双键 TTL ∈ (0,900]（issued 窗 = 900s 常量）—— 实际 rec=${ttlRec1} idx=${ttlIdx1}`,
    );

    // 复用 + 续期（两键 EXPIRE 同置回 900；同 nonce、date 不重锚）。
    const count3a = claimKeyCount();
    const r2 = await getRelief(uC);
    expectHttp(checks, r2 as { status: number; body: Envelope | null }, 200, ErrCode.OK, '③ 二发 GET（复用支）');
    checks.eq((r2.body?.data as ReliefData)?.claim, claim1, '③ 复用同 nonce（find-or-create 复用分支：不重签）');
    redisRaw(['EXPIRE', `relief:claim:${claim1}`, '111']);
    redisRaw(['EXPIRE', `relief:claim:u:${uC.id}`, '111']);
    const r3 = await getRelief(uC);
    checks.eq((r3.body?.data as ReliefData)?.claim, claim1, '③ 三发 GET（TTL 扰动后）仍为同一 nonce（续期不另签）');
    const ttlRec3 = Number(redisCliText(['TTL', `relief:claim:${claim1}`]));
    checks.that(
      ttlRec3 > 800,
      `③ 复用 = 两键 EXPIRE 同置回 900（续期生效；扰动 111 → 实际 ${ttlRec3}）——「只读/不续期」的判别面在 ⑨ pending`,
    );
    checks.eq(claimKeyCount(), count3a, '③ 连发 GET 键数不增（复用不产生新键）');

    // 悬垂：删记录留索引 ⇒ 新签且索引更新（E 裁定的悬垂恢复）。
    redisRaw(['DEL', `relief:claim:${claim1}`]);
    const r4 = await getRelief(uC);
    expectHttp(checks, r4 as { status: number; body: Envelope | null }, 200, ErrCode.OK, '③ 悬垂后 GET（索引在/记录不在 ⇒ 按无凭证新签）');
    const claim2 = (r4.body?.data as ReliefData)?.claim ?? '';
    checks.that(
      claim2 !== claim1 && /^[A-Za-z0-9_-]{22}$/.test(claim2),
      `③ 悬垂恢复：新签（nonce 变）—— 旧 ${JSON.stringify(claim1)} → 新 ${JSON.stringify(claim2)}`,
    );
    checks.eq(redisCliText(['GET', `relief:claim:u:${uC.id}`]), claim2, '③ 索引已被更新指向新 nonce（条件删悬垂 + 新签落地）');
    const rec2 = claimRecordJson(claim2);
    checks.that(rec2?.state === 'issued', `③ 新记录在场且 issued —— 实际 ${JSON.stringify(rec2)}`);
    checks.eq(claimRecordRaw(claim1), '', '③ 旧记录键仍不存在（悬垂被恢复而非复活）');

    // 同实例并发两发（T12 登记面判定项——只钉可观测性质；接纳结论见文件头）。
    checks.eq(claimKeyCount(), 2, '③ 并发前基线：恰 2 键（索引 + 当前记录）');
    const [crA, crB] = await Promise.all([getRelief(uC), getRelief(uC)]);
    expectHttp(checks, crA as { status: number; body: Envelope | null }, 200, ErrCode.OK, '③ 并发发 A');
    expectHttp(checks, crB as { status: number; body: Envelope | null }, 200, ErrCode.OK, '③ 并发发 B');
    const nonceA = (crA.body?.data as ReliefData)?.claim ?? '';
    const nonceB = (crB.body?.data as ReliefData)?.claim ?? '';
    checks.that(
      (nonceA === claim2 || nonceA === nonceB) && (nonceB === claim2 || nonceA === nonceB),
      `③ 并发两发均持有当前凭证 nonce（${JSON.stringify([nonceA, nonceB])} ∈ {当前 ${JSON.stringify(claim2)}, 彼此}——无双签发）`,
    );
    checks.eq(redisCliText(['GET', `relief:claim:u:${uC.id}`]), claim2, '③ 并发后索引仍指在场的 issued 记录（T12 判定项：不产生双凭证的可观测性质）');
    checks.eq(claimKeyCount(), 2, '③ 并发后键数仍 2（不产生双凭证/无孤儿记录——T12 已接纳残窗：单连接 WATCH 交错退化只钉可观测性质，不测残窗本身）');
    info('T12 登记面接纳结论：单连接 WATCH 交错退化（条件删→非条件删）已由控制者裁「接纳+注册」；本判定项钉不变量，残窗处置在 T24 台账。');

    /* ── ④ 拒发穷尽 ─────────────────────────────────────────────────────── */
    step('④ 拒发穷尽：公开路径不得 404 反例钉（裸 GET 缺参 ⇒ 200 {"isValid":true} 走 malformed / POST ⇒ 恰 405 / 近邻 uiadx 匿名 ⇒ 401 / /api 面匿名 ⇒ 401）· 405/401 不入计数 · 畸形 200/true · 坏签名 200/true · 改串归 claim_invalid · 未签发/过期 200/true · 中途切开关/充值 ⇒ 终态拒绝');
    const m0 = readMetricCounts();
    /** v1.4 终态确认信号（逐字 JSON；坏签名/畸形等全体确定性拒绝同形）。 */
    const ANSWER_TRUE = JSON.stringify({ isValid: true });

    // (1) 公开路径「不得 404」反例钉（T11 双钉的切片级扩展；经门口）。
    const bareGet = await edgeRequest('GET', AD_NOTIFY_PATH, null);
    checks.that(
      bareGet.status === 200 && bareGet.body === ANSWER_TRUE,
      `④ 经门口裸 GET /ad/notify/uniad（无 query）⇒ 200/${ANSWER_TRUE}（方法闸通 + 路由在场 + 走到链形状面 malformed 的同义证据；404=exclude 复发 / 401=豁免失效）—— 实测 ${bareGet.status} ${JSON.stringify(bareGet.body)}`,
    );
    const noCt = await edgeRequest('POST', AD_NOTIFY_PATH, null);
    checks.that(
      noCt.status === 405 && noCt.body === 'failure',
      `④ 经门口 POST /ad/notify/uniad（无内容类型）⇒ 恰 405/failure（v1.4 方法闸：非 GET ⇒ 纯文本 failure、无 isValid 语义）—— 实测 ${noCt.status} ${JSON.stringify(noCt.body)}`,
    );
    const neighbor = await edgeRequest('POST', AD_NOTIFY_NEIGHBOR, null);
    checks.eq(neighbor.status, 401, `④ 近邻 ${AD_NOTIFY_NEIGHBOR} 匿名 ⇒ 401（豁免面**不得**扩大：精确对钉的负例）`);
    const apiFace = await fetch(`${GATEWAY_URL}/api/ad/notify/uniad`, { method: 'POST' });
    checks.eq(apiFace.status, 401, '④ /api 前缀面（经网关 /api/ad/notify/uniad）匿名 ⇒ 401（公开面不经网关——豁免只给门口直连面）');

    // (2) 畸形（真签样本删一枚业务必填 provider）⇒ 200/true（形状分类不依赖密钥——签名都不验）。
    const malformedSample = signedParams(callbackFields(uC, randomNonce(), 'malformed'), '④ 畸形样本');
    delete malformedSample.provider;
    const malformed = await getNotifyViaEdge(malformedSample);
    checks.eq(malformed.status, 200, '④ 畸形（真签样本缺 provider）⇒ 200（确定性拒绝终态，不重试）');
    checks.eq(malformed.body, ANSWER_TRUE, '④ 畸形应答 = {"isValid":true}（终态止投）');
    const m1 = readMetricCounts();
    checks.eq(m1.cbMalformed - m0.cbMalformed, 2, '④ 裸 GET 缺参 + 缺字段样本 ⇒ relief_callback_total{malformed} +2（两枚都到链形状面就近入桶）');
    checks.eq(m1.cbSum - m0.cbSum, 2, '④ 405/401 三枚**不入桶**（都在链前拒——「一回调一计」只对到链的回调；两枚 GET 缺参各 +1）');

    // (3) 坏签名（首个签名依赖步；密钥惰性装载的第一现场）。
    const claimBadSignUser = await registerUser(63);
    const rBad = await getRelief(claimBadSignUser);
    expectHttp(checks, rBad as { status: number; body: Envelope | null }, 200, ErrCode.OK, '④ 坏签名组：预备一条 issued 凭证');
    const nonceBadTarget = (rBad.body?.data as ReliefData)?.claim ?? '';
    const badSample = signedParams(callbackFields(claimBadSignUser, nonceBadTarget, 'bad-sign'), '④ 首个签名依赖步（坏签名样本）');
    // 确定性翻转：首字换成**必不相同**的另一 hex 数字（≥'8'→'0'，否则→'8'）。
    // 旧 'A'/'B' 翻法在真签为小写 hex 时存在空翻/越字集风险；v1.4 下坏签名空翻 = 合法签名直穿链 ⇒ 误发真钱。
    badSample.sign = (badSample.sign[0] >= '8' ? '0' : '8') + badSample.sign.slice(1);
    const badRes = await getNotifyViaEdge(badSample);
    checks.eq(badRes.status, 200, '④ 坏签名 ⇒ 200（确定性拒绝终态——回 true 止投；告警 ReliefCallbackBroken 对 bad_sign 兜底）');
    checks.eq(badRes.body, ANSWER_TRUE, '④ 坏签名应答 = {"isValid":true}（终态封闭词面）');
    checks.that(claimRecordJson(nonceBadTarget)?.state === 'issued', '④ 坏签名后目标记录仍 issued（验签未过 ⇒ 链未动任何状态）');

    // (4) 未签发（签名合法但 nonce 未见）⇒ 200 {"isValid":true}（claim_invalid）。
    const unseenA = randomNonce();
    const notIssued = await getNotifyViaEdge(signedParams(callbackFields(uC, unseenA, 'not-issued'), '④ 未签发样本'));
    checks.eq(notIssued.status, 200, '④ 未签发（合法签名 + 未见 nonce）⇒ 200（claim_invalid 属终态接受面——重投不可改变结局）');
    checks.eq(notIssued.body, ANSWER_TRUE, '④ 未签发应答 = {"isValid":true}（词面封闭）');
    checks.eq(claimRecordRaw(unseenA), '', '④ 未签发不建键（该 nonce 记录仍不存在）');

    // (5) 过期（曾签发、双键已消失）⇒ 200 {"isValid":true}。
    const uExp = await registerUser(64);
    const rExp = await getRelief(uExp);
    const nonceExp = (rExp.body?.data as ReliefData)?.claim ?? '';
    redisRaw(['DEL', `relief:claim:${nonceExp}`, `relief:claim:u:${uExp.id}`]);
    const expired = await getNotifyViaEdge(signedParams(callbackFields(uExp, nonceExp, 'expired'), '④ 过期样本'));
    checks.eq(expired.status, 200, '④ 过期（记录已消失）⇒ 200（与未签发同面——claim_invalid）');
    checks.eq(expired.body, ANSWER_TRUE, '④ 过期应答 = {"isValid":true}');

    // (6) 改串（签名后篡改 extra）——v1.4 语义翻转：sign 只吃 secret+trans_id，
    //     改 extra **不破坏签名** ⇒ 链按随机未见 nonce 查 ⇒ 无 claim ⇒ claim_invalid（非 bad_sign）。
    const uTamper = await registerUser(65);
    const rTamper = await getRelief(uTamper);
    const nonceTamper = (rTamper.body?.data as ReliefData)?.claim ?? '';
    const tamperSample = signedParams(callbackFields(uTamper, nonceTamper, 'tamper'), '④ 改串样本');
    tamperSample.extra = randomNonce(); // 合法签名 + 未见 nonce（签名面不感知 extra）
    const tampered = await getNotifyViaEdge(tamperSample);
    checks.eq(tampered.status, 200, '④ 改串（合法签名 + 随机未见 extra）⇒ 200（claim_invalid——v1.4 签名不覆盖 extra）');
    checks.eq(tampered.body, ANSWER_TRUE, '④ 改串应答 = {"isValid":true}');
    checks.that(
      claimRecordJson(nonceTamper)?.state === 'issued',
      '④ 改串后原凭证记录仍 issued（链查的是新随机 nonce——原凭证未被消费，身份只来自 claim 的正面证据）',
    );

    const m2 = readMetricCounts();
    checks.eq(m2.cbBadSign - m1.cbBadSign, 1, '④ 仅坏签名一枚 ⇒ bad_sign 桶 +1（改串在 v1.4 下归 claim_invalid）');
    checks.eq(m2.cbClaimInvalid - m1.cbClaimInvalid, 3, '④ 未签发 + 过期 + 改串 ⇒ claim_invalid 桶 +3');
    checks.eq(m2.cbAccepted - m1.cbAccepted, 0, '④ 坏签名一枚与 claim_invalid 三枚**不进 accepted**（桶互斥）');
    checks.eq(m2.reliefGranted - m1.reliefGranted, 0, '④ 全程零发放（currency_relief_total{granted} 差分 0——拒发穷尽的发放面）');

    // (7) 中途切开关：签发后关闸 ⇒ done:disabled + rejected。
    const uDisabled = await registerUser(66);
    const rDis = await getRelief(uDisabled);
    expectHttp(checks, rDis as { status: number; body: Envelope | null }, 200, ErrCode.OK, '④ 中途切开关组：预备 issued 凭证');
    claimDisabled = (rDis.body?.data as ReliefData)?.claim ?? '';
    const offMid = await putConfigAndWaitEffect(adminToken, 'currency.reliefEnabled', false, 'currency-service');
    checks.eq(offMid.putCode, ErrCode.OK, `④ 中途 PUT reliefEnabled=false ⇒ code 0（快照 version=${offMid.expected}）`);
    checks.that(offMid.refreshOk, `④ ≤30s 关闸生效（计数 ${offMid.baseline}→${offMid.observed}）`);
    const disabledRes = await getNotifyViaEdge(signedParams(callbackFields(uDisabled, claimDisabled, 'mid-off'), '④ 中途切开关样本'));
    checks.eq(disabledRes.status, 200, '④ 关闸后回调 ⇒ 200（正向裁决拒绝属终态接受面；JSON true 止投）');
    checks.eq(disabledRes.body, ANSWER_TRUE, '④ 关闸拒绝应答 = {"isValid":true}');
    checks.that(
      claimRecordJson(claimDisabled)?.state === 'done' && claimRecordJson(claimDisabled)?.result === 'disabled',
      `④ 记录落 done:disabled —— 实际 ${JSON.stringify(claimRecordJson(claimDisabled))}`,
    );
    const onMid = await putConfigAndWaitEffect(adminToken, 'currency.reliefEnabled', true, 'currency-service');
    checks.eq(onMid.putCode, ErrCode.OK, `④ 组内复闸 PUT reliefEnabled=true ⇒ code 0（快照 version=${onMid.expected}）`);
    checks.that(onMid.refreshOk, `④ ≤30s 复闸生效（计数 ${onMid.baseline}→${onMid.observed}）`);

    // (8) 中途充值：签发后余额 ≥ 门槛 ⇒ done:balance_ok + rejected。
    const uBalanceOk = await registerUser(67);
    const rBal = await getRelief(uBalanceOk);
    expectHttp(checks, rBal as { status: number; body: Envelope | null }, 200, ErrCode.OK, '④ 中途充值组：预备 issued 凭证');
    claimBalanceOk = (rBal.body?.data as ReliefData)?.claim ?? '';
    const topUp = await adminAdjust(adminToken, uBalanceOk.id, RELIEF_AMOUNT_SEED, `s24-${TAG}-topup`);
    checks.that(
      topUp.status === 200 && topUp.code === ErrCode.OK && topUp.balanceAfter === RELIEF_AMOUNT_SEED,
      `④ 中途充值（+${RELIEF_AMOUNT_SEED}）⇒ 余额 ${topUp.balanceAfter} ≥ 平台门槛 —— 实际 HTTP ${topUp.status} code=${topUp.code}`,
    );
    const balOkRes = await getNotifyViaEdge(signedParams(callbackFields(uBalanceOk, claimBalanceOk, 'mid-topup'), '④ 中途充值样本'));
    checks.eq(balOkRes.status, 200, '④ 充值后回调 ⇒ 200（余额闸拒绝；终态 JSON true 止投）');
    checks.that(
      claimRecordJson(claimBalanceOk)?.state === 'done' && claimRecordJson(claimBalanceOk)?.result === 'balance_ok',
      `④ 记录落 done:balance_ok —— 实际 ${JSON.stringify(claimRecordJson(claimBalanceOk))}`,
    );
    const balAfter = await adminAccounts(adminToken, uBalanceOk.id);
    checks.eq(balAfter.balance, RELIEF_AMOUNT_SEED, '④ 充值后余额未再变化（拒绝 ≠ 发放）');

    const m3 = readMetricCounts();
    checks.eq(m3.cbAccepted - m2.cbAccepted, 2, '④ 两枚终态拒绝 ⇒ accepted +2');
    checks.eq(m3.reliefRejected - m2.reliefRejected, 2, '④ 中途切开关/充值 ⇒ currency_relief_total{rejected} +2');
    checks.eq(m3.reliefGranted - m2.reliefGranted, 0, '④ 终态拒绝零发放（rejected 与 granted 互斥）');

    /* ── ⑤ 正路一次（经门口）────────────────────────────────────────────── */
    step('⑤ 正路一次（经门口 https://localhost:8443/ad/notify/uniad）：GET 签发 ⇒ 签名 GET 回调 ⇒ 200 {"isValid":true} + 余额 +200 + GET 已发（今天已经领过了）+ 记录 done:granted + 索引删（done 落定）+ 两指标 +1');
    const uE = await registerUser(68);
    const rE1 = await getRelief(uE);
    expectHttp(checks, rE1 as { status: number; body: Envelope | null }, 200, ErrCode.OK, '⑤ GET 签发（正路）');
    claimGranted = (rE1.body?.data as ReliefData)?.claim ?? '';
    checks.that(/^[A-Za-z0-9_-]{22}$/.test(claimGranted), '⑤ 正路凭证在场（形态自证）');
    const grantParams = signedParams(callbackFields(uE, claimGranted, 'grant'), '⑤ 正路样本');
    const grantRes = await getNotifyViaEdge(grantParams);
    checks.eq(grantRes.status, 200, '⑤ 经门口 GET 回调 ⇒ 200（Caddy handle /ad/notify/* 路由验收 + 全链）');
    checks.eq(grantRes.body, ANSWER_TRUE, '⑤ 应答 = {"isValid":true}（终态确认）');
    const acc5 = await adminAccounts(adminToken, uE.id);
    checks.eq(acc5.balance, RELIEF_AMOUNT_SEED, '⑤ 余额 +200（apply granted 同点）');
    const rE2 = await getRelief(uE);
    const dE = rE2.body?.data as ReliefData;
    checks.that(
      dE?.grantedToday === true && dE?.eligible === false && dE.reason === '今天已经领过了',
      `⑤ 已发后再 GET（无 claim）⇒ grantedToday=true/eligible=false/reason=「今天已经领过了」—— 实际 ${JSON.stringify(dE)}`,
    );
    checks.eq(dE?.balance, RELIEF_AMOUNT_SEED, '⑤ GET 的 balance 与账一致（恒在场值）');
    const rec5 = claimRecordJson(claimGranted);
    checks.that(
      rec5?.state === 'done' && rec5?.result === 'granted',
      `⑤ 记录落 done:granted —— 实际 ${JSON.stringify(rec5)}`,
    );
    checks.eq(redisCliText(['GET', `relief:claim:u:${uE.id}`]), '', '⑤ done 落定删除索引键（无自致悬垂——E 裁定）');
    const m5 = readMetricCounts();
    checks.eq(m5.cbAccepted - m3.cbAccepted, 1, '⑤ 回调面 accepted +1');
    checks.eq(m5.reliefGranted - m3.reliefGranted, 1, '⑤ 发放面 granted +1（与 apply 返回同点）');

    /* ── ⑥ 重投幂等 ─────────────────────────────────────────────────────── */
    step('⑥ 重投幂等：同载荷（逐字复用 ⑤ 的签名 GET 载荷）二次 ⇒ 200/{"isValid":true} + 余额不变 + 记录零改写（done 短路）+ 发放面不重复计 granted');
    const rawBefore6 = claimRecordRaw(claimGranted);
    const again = await getNotifyViaEdge(grantParams);
    checks.eq(again.status, 200, '⑥ 同载荷二次投递 ⇒ 200（done 短路：顺序重投）');
    checks.eq(again.body, ANSWER_TRUE, '⑥ 重投应答 = {"isValid":true}（终态同形）');
    const acc6 = await adminAccounts(adminToken, uE.id);
    checks.eq(acc6.balance, RELIEF_AMOUNT_SEED, '⑥ 余额不变（短路不重放 apply）');
    checks.eq(claimRecordRaw(claimGranted), rawBefore6, '⑥ 记录零改写（done 短路只读——原文逐字相等）');
    const m6 = readMetricCounts();
    checks.eq(m6.cbAccepted - m5.cbAccepted, 1, '⑥ 回调面 accepted +1（一回调一计）');
    checks.eq(m6.reliefGranted - m5.reliefGranted, 0, '⑥ 发放面 granted 不重复计（🟠-2 禁令的正面：只能走 done 短路，而非记录移除）');

    /* ── ⑦ 账本先行重放 ─────────────────────────────────────────────────── */
    step('⑦ 账本先行重放：GET 签发 → rpcApply 预置同锚流水（relief:<u>:<claim.date>；不得以记录移除构造）→ 回调 ⇒ 200 + 余额不变 + done:replayed + replayed+1/granted+0 + GET 已发（账本=唯一真源）');
    const uF = await registerUser(69);
    const rF = await getRelief(uF);
    expectHttp(checks, rF as { status: number; body: Envelope | null }, 200, ErrCode.OK, '⑦ GET 签发（账本先行组）');
    const claimF = (rF.body?.data as ReliefData)?.claim ?? '';
    const recF = claimRecordJson(claimF);
    const dateF = String(recF?.date ?? '');
    checks.that(/^\d{4}-\d{2}-\d{2}$/.test(dateF), `⑦ claim 记录 date 在场（上海日历日）—— 实际 ${JSON.stringify(dateF)}`);
    const preset = await rpcApply({
      actionId: `relief:${uF.id}:${dateF}`,
      source: 'relief_grant',
      entries: [{ ownerId: uF.id, delta: RELIEF_AMOUNT_SEED }],
      refId: uF.id,
    });
    checks.that(
      preset.ok === true,
      `⑦ 预置同锚流水 rpcApply（actionId 逐字 relief:${uF.id}:${dateF}；slice-18 形态可自定义 actionId）⇒ ok:true —— 实际 ${JSON.stringify(preset)}`,
    );
    const accF1 = await adminAccounts(adminToken, uF.id);
    checks.eq(accF1.balance, RELIEF_AMOUNT_SEED, '⑦ 预置后余额 = 200（账本已有、记录仍 issued——重投判重放的构造面）');
    checks.that(claimRecordJson(claimF)?.state === 'issued', '⑦ 预置不改记录（记录仍 issued——**不得以记录移除构造**：那走 claim_invalid 到不了账本先行）');
    const replayedRes = await getNotifyViaEdge(signedParams(callbackFields(uF, claimF, 'replay'), '⑦ 账本先行样本'));
    checks.eq(replayedRes.status, 200, '⑦ 账本先行命中 ⇒ 200（{"isValid":true}；重放属接受面）');
    const accF2 = await adminAccounts(adminToken, uF.id);
    checks.eq(accF2.balance, RELIEF_AMOUNT_SEED, '⑦ 余额不变（replayed：只翻终态，不迁移金额）');
    const recF2 = claimRecordJson(claimF);
    checks.that(
      recF2?.state === 'done' && recF2?.result === 'replayed',
      `⑦ Redis 读证 done:replayed —— 实际 ${JSON.stringify(recF2)}`,
    );
    checks.eq(redisCliText(['GET', `relief:claim:u:${uF.id}`]), '', '⑦ done 落定删索引（同 ⑤ 口径）');
    const rF2 = await getRelief(uF);
    checks.that(
      (rF2.body?.data as ReliefData)?.grantedToday === true && (rF2.body?.data as ReliefData)?.reason === '今天已经领过了',
      '⑦ 账本=唯一真源：GET（无 claim）按今日锚命中账本 ⇒ 「今天已经领过了」',
    );
    const m7 = readMetricCounts();
    checks.eq(m7.cbAccepted - m6.cbAccepted, 1, '⑦ 回调面 accepted +1');
    checks.eq(m7.reliefReplayed - m6.reliefReplayed, 1, '⑦ 发放面 replayed +1（账本先行判重放）');
    checks.eq(m7.reliefGranted - m6.reliefGranted, 0, '⑦ granted 差分 0（账本先行短路——不撞余额闸、不污染 granted 桶）');

    /* ── ⑧ 跨零点重投 ───────────────────────────────────────────────────── */
    step('⑧ 跨零点重投：redisRaw 回写记录 date=昨日（KEEPTTL）⇒ 回调按昨日锚 ⇒ apply 成功（余额 +200/昨日锚流水在场）且今日 grantedToday 未翻转');
    const uG = await registerUser(70);
    const rG = await getRelief(uG);
    expectHttp(checks, rG as { status: number; body: Envelope | null }, 200, ErrCode.OK, '⑧ GET 签发（跨零点组）');
    const claimG = (rG.body?.data as ReliefData)?.claim ?? '';
    const recG = claimRecordJson(claimG);
    const dateG = String(recG?.date ?? '');
    const dateGYesterday = prevShanghaiDay(dateG);
    const wroteG = redisRaw([
      'SET',
      `relief:claim:${claimG}`,
      JSON.stringify({ userId: uG.id, date: dateGYesterday, state: 'issued' }),
      'KEEPTTL',
    ]);
    checks.eq(redisReplyText(wroteG), 'OK', `⑧ 回写记录 date=${dateGYesterday}（KEEPTTL——TTL 不重置）`);
    checks.eq(claimRecordJson(claimG)?.date, dateGYesterday, '⑧ 回写已落地（回读逐字）');
    const crossRes = await getNotifyViaEdge(signedParams(callbackFields(uG, claimG, 'cross-midnight'), '⑧ 跨零点样本'));
    checks.eq(crossRes.status, 200, '⑧ 跨零点回调 ⇒ 200（{"isValid":true}；按 claim 签发日锚，昨日账本无流水 ⇒ 走到 apply）');
    const accG = await adminAccounts(adminToken, uG.id);
    checks.eq(accG.balance, RELIEF_AMOUNT_SEED, '⑧ apply 成功：余额 0 → 200（按昨日锚发放）');
    checks.that(
      accG.recentFlows.some((f) => f.source === 'relief_grant' && f.delta === RELIEF_AMOUNT_SEED),
      `⑧ fresh 锚流水在场（relief:${uG.id}:${dateGYesterday}）—— 实际 ${JSON.stringify(accG.recentFlows.slice(0, 3))}`,
    );
    const recG2 = claimRecordJson(claimG);
    checks.that(
      recG2?.state === 'done' && recG2?.result === 'granted' && recG2?.date === dateGYesterday,
      `⑧ 记录落 done:granted 且 date 保持昨日（markDone 不重锚）—— 实际 ${JSON.stringify(recG2)}`,
    );
    const rG2 = await getRelief(uG);
    const dG2 = rG2.body?.data as ReliefData;
    checks.that(
      dG2?.grantedToday === false && dG2?.reason === '余额充足，无需救助',
      `⑧ **今日** grantedToday 未翻转（时钟当日账本无流水；余额 200 ≥ 平台门槛 ⇒ 余额闸面）—— 实际 ${JSON.stringify(dG2)}`,
    );
    const m8 = readMetricCounts();
    checks.eq(m8.cbAccepted - m7.cbAccepted, 1, '⑧ 回调面 accepted +1');
    checks.eq(m8.reliefGranted - m7.reliefGranted, 1, '⑧ 发放面 granted +1（昨日锚的 granted 照计）');

    /* ── ⑨ 轮询四态（携 claim，只读）────────────────────────────────────── */
    step('⑨ 轮询四态：pending（+只读自证：TTL 不回 900、索引不变、键数不变）+ 成功 + 终态拒绝（disabled/balance_ok 各自 reason）+ 失效 + 跨主体按不存在（amount/balance 恒取 JWT 侧）');
    pendingUser = await registerUser(71);
    const rP = await getRelief(pendingUser);
    expectHttp(checks, rP as { status: number; body: Envelope | null }, 200, ErrCode.OK, '⑨ 预备 pending 凭证');
    claimPending = (rP.body?.data as ReliefData)?.claim ?? '';
    redisRaw(['EXPIRE', `relief:claim:${claimPending}`, '472']);
    redisRaw(['EXPIRE', `relief:claim:u:${pendingUser.id}`, '472']);
    const countP = claimKeyCount();
    const rP2 = await getRelief(pendingUser, claimPending);
    expectHttp(checks, rP2 as { status: number; body: Envelope | null }, 200, ErrCode.OK, '⑨ pending：携 claim 轮询');
    const dP2 = rP2.body?.data as ReliefData;
    checks.that(
      dP2?.eligible === true && dP2?.grantedToday === false && !('reason' in (dP2 ?? {})) && !('claim' in (dP2 ?? {})),
      `⑨ pending 面逐字 {eligible:true, grantedToday:false} 无 reason 无 claim（轮询只读返回——不重发凭证）—— 实际 ${JSON.stringify(dP2)}`,
    );
    const ttlP = Number(redisCliText(['TTL', `relief:claim:${claimPending}`]));
    checks.that(
      ttlP > 0 && ttlP <= 475,
      `⑨ **只读自证**：轮询不续期（TTL 472 扰动后未被置回 900——续期只存在于无 claim 的 ⑤ 签发枝）—— 实际 ${ttlP}`,
    );
    checks.eq(redisCliText(['GET', `relief:claim:u:${pendingUser.id}`]), claimPending, '⑨ 只读自证：索引不变（未重签/未改写）');
    checks.eq(claimKeyCount(), countP, '⑨ 只读自证：键数不变（携 claim 分支零 Redis 写）');

    const rG3 = await getRelief(uE, claimGranted);
    const dG3 = rG3.body?.data as ReliefData;
    checks.that(
      dG3?.grantedToday === true && dG3?.eligible === false && !('reason' in (dG3 ?? {})),
      `⑨ 成功态（⑤ 的 granted 凭证）⇒ 成功面无 reason —— 实际 ${JSON.stringify(dG3)}`,
    );
    const rD = await getRelief(uDisabled, claimDisabled);
    checks.that(
      (rD.body?.data as ReliefData)?.reason === '救助暂未开放',
      `⑨ 终态拒绝（disabled）⇒ reason「救助暂未开放」—— 实际 ${JSON.stringify(rD.body?.data)}`,
    );
    const rB = await getRelief(uBalanceOk, claimBalanceOk);
    checks.that(
      (rB.body?.data as ReliefData)?.reason === '余额充足，无需救助',
      `⑨ 终态拒绝（balance_ok）⇒ reason「余额充足，无需救助」—— 实际 ${JSON.stringify(rB.body?.data)}`,
    );
    const unseenC = randomNonce();
    const rLost = await getRelief(uC, unseenC);
    const dLost = rLost.body?.data as ReliefData;
    checks.that(
      dLost?.reason === '领取凭证已失效，请重试' && dLost?.eligible === false && typeof dLost?.amount === 'number' && typeof dLost?.balance === 'number',
      `⑨ 失效（未见过的 nonce）⇒ reason「领取凭证已失效，请重试」且 amount/balance 恒在场 —— 实际 ${JSON.stringify(dLost)}`,
    );
    const uOther = await registerUser(72);
    const rCross = await getRelief(uOther, claimPending);
    const dCross = rCross.body?.data as ReliefData;
    checks.that(
      dCross?.reason === '领取凭证已失效，请重试',
      `⑨ 跨主体（他人凭证）⇒ 按不存在处理（不泄露他人凭证状态）—— 实际 ${JSON.stringify(dCross)}`,
    );
    checks.eq(dCross?.balance, 0, '⑨ 跨主体响应 amount/balance 恒取 JWT 侧（他人的凭证不影响本人读数）');

    /* ── ⑩ claim_invalid 不建键 ─────────────────────────────────────────── */
    step('⑩ claim_invalid 不建键：签名 GET 回调打未见过的 nonce ⇒ 200 {"isValid":true} + redisRaw 键数前后相等 + 记录键仍不存在 + 指标 claim_invalid +1');
    const count10 = claimKeyCount();
    const unseenD = randomNonce();
    const invalidRes = await getNotifyViaEdge(signedParams(callbackFields(uC, unseenD, 'claim-invalid'), '⑩ 未见过 nonce 样本'));
    checks.eq(invalidRes.status, 200, '⑩ claim_invalid ⇒ 200（{"isValid":true}；线上编码与其它终态相同）');
    checks.eq(invalidRes.body, ANSWER_TRUE, '⑩ 应答 = {"isValid":true}（终态同形）');
    checks.eq(claimRecordRaw(unseenD), '', '⑩ 该 nonce 记录键仍不存在（不建键——读路径容忍且不落任何写）');
    checks.eq(claimKeyCount(), count10, '⑩ 回调前后 relief:claim:* 键数相等（claim_invalid 零键创建）');
    const m10 = readMetricCounts();
    checks.eq(m10.cbClaimInvalid - m8.cbClaimInvalid, 1, '⑩ 指标 claim_invalid +1');

    /* ── ⑪ 旧 POST ⇒ 404 + GET 新面语义 ─────────────────────────────────── */
    step('⑪ 旧 POST /api/wallet/relief ⇒ 404（经网关；{code:10001} 统一信封）· GET 面：未见过的 claim ⇒ 失效面（claim 确实透传）· ?claim= 空串 ⇒ 视同未携');
    const uNew = await registerUser(73);
    const oldPost = await postJson('/api/wallet/relief', {}, uNew.accessToken);
    checks.eq(oldPost.status, 404, '⑪ 旧 POST /api/wallet/relief ⇒ 404（路由退役；发放唯一入口 = 广告回调）');
    checks.eq(oldPost.body?.code, ErrCode.BAD_PARAM, '⑪ 404 走网关统一信封（code=10001 BAD_PARAM——R244）');
    checks.that(
      typeof oldPost.body?.message === 'string' && oldPost.body.message.includes('Cannot POST'),
      `⑪ 404 message 逐字含 Cannot POST（路由层 404 的原文）—— 实际 ${JSON.stringify(oldPost.body?.message)}`,
    );
    const forwardProbe = await getJson<ReliefData>(`/api/wallet/relief?claim=${encodeURIComponent(randomNonce())}`, uNew.accessToken);
    expectHttp(checks, forwardProbe as { status: number; body: Envelope | null }, 200, ErrCode.OK, '⑪ GET 携未知 claim（经网关）');
    checks.that(
      (forwardProbe.body?.data as ReliefData)?.reason === '领取凭证已失效，请重试',
      `⑪ claim 确实透传下游（未知 claim ⇒ 失效面；若 query 被吞会走无 claim 签发枝给出 eligible:true）—— 实际 ${JSON.stringify(forwardProbe.body?.data)}`,
    );
    const emptyClaim = await getJson<ReliefData>('/api/wallet/relief?claim=', uNew.accessToken);
    const dEmpty = emptyClaim.body?.data as ReliefData;
    checks.that(
      dEmpty?.eligible === true && typeof dEmpty?.claim === 'string' && dEmpty.claim.length > 0,
      `⑪ ?claim= 空串 ⇒ 视同未携（网关丢弃口径同形）⇒ 走签发枝（eligible:true + claim 在场）—— 实际 ${JSON.stringify(dEmpty)}`,
    );

    /* ── ⑫ 收尾 ─────────────────────────────────────────────────────────── */
    step('⑫ 收尾：PUT reliefEnabled=false（快照生效自证）· adpid 空串 · claim 命名空间/限流桶零残留 + 客户端面自证');
    clearAdminWriteBucket(adminToken);
    const off12 = await putConfigAndWaitEffect(adminToken, 'currency.reliefEnabled', false, 'currency-service');
    checks.eq(off12.putCode, ErrCode.OK, `⑫ 收尾 PUT reliefEnabled=false ⇒ code 0（快照 version=${off12.expected}）`);
    checks.that(off12.refreshOk, `⑫ ≤30s 关闸生效（计数 ${off12.baseline}→${off12.observed}）`);
    reliefEnabledTripped = false;
    const finalCfg = await adminGetConfig<{ config: Record<string, { value: unknown; version: number }> }>(adminToken);
    checks.eq(finalCfg.body?.data?.config?.['currency.reliefEnabled']?.value, false, '⑫ 开关管理面读数 = false（种子态）');
    checks.eq(finalCfg.body?.data?.config?.[AD_KEY_CONFIG]?.value, '', '⑫ adpid 管理面读数 = 空串（种子态）');
    const uEnd = await registerUser(74);
    const cfgEnd = await getJson<Record<string, unknown>>('/api/config', uEnd.accessToken);
    expectHttp(checks, cfgEnd as { status: number; body: Envelope | null }, 200, ErrCode.OK, '⑫ 客户端面收尾读');
    checks.eq((cfgEnd.body?.data as Record<string, unknown>)?.['reliefEnabled'], false, '⑫ 客户端面 reliefEnabled=false（入口关闭）');
    checks.eq((cfgEnd.body?.data as Record<string, unknown>)?.[AD_KEY_CLIENT], '', '⑫ 客户端面 reliefAdpid 空串（入口双保险）');
    const purgedEnd = purgeClaimKeys();
    info(`收尾：relief:claim:* 删除 ${purgedEnd} 键（本 run 造的全部凭证/索引）`);
    checks.eq(claimKeyCount(), 0, '⑫ claim 命名空间零残留（relief:claim:* 扫描为空）');
    redisRaw(['DEL', 'ad:notify:rate']);
    checks.eq(redisCliText(['EXISTS', 'ad:notify:rate']), '0', '⑫ 限流桶零残留（ad:notify:rate 已清）');
    wrappedUp = true;

    return checks;
  } finally {
    /* ── 兜底复原（异常路径也执行；每步吞异常——清理不许顶掉结论）────────────── */
    try {
      if (reliefEnabledTripped && adminToken.length > 0) {
        await adminPutConfig('currency.reliefEnabled', false, adminToken);
        info('收尾兜底：currency.reliefEnabled 已复原 false（异常路径）');
      }
    } catch { /* 兜底 */ }
    try {
      if (adpidTripped && adminToken.length > 0) {
        await adminPutConfig(AD_KEY_CONFIG, '', adminToken);
        info('收尾兜底：ad.reliefAdpid 已复原空串（异常路径）');
      }
    } catch { /* 兜底 */ }
    try {
      purgeClaimKeys();
      if (!wrappedUp) info('收尾兜底：relief:claim:* 已清（异常路径——下一轮从零起）');
    } catch { /* 兜底 */ }
    try {
      redisRaw(['DEL', 'ad:notify:rate']);
    } catch { /* 兜底 */ }
    try {
      if (adminToken.length === 0) adminToken = await adminLogin();
    } catch { /* 兜底 */ }
    try {
      if (adminToken.length > 0) {
        for (const a of probeAccounts) {
          await sendRaw('PATCH', `/api/admin/accounts/${a.id}`, adminToken, { status: 'disabled' });
        }
      }
    } catch { /* 兜底 */ }
  }
}

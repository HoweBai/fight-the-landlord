/**
 * conformance 用例：**支付配置管理化**（`slice-22-pay-channel`；规格 §5.2 的 ⓪–⑩ 十组 + 收尾）。
 *
 * ─── 判据载体（真栈面）────────────────────────────────────────────────────────
 *  - 渠道凭据六键的唯一落点 = config-service 的 `pay_channel_config`（管理三端点 +
 *    专用 RPC `config.payChannel.get`）；下单链由 payment-service **每调用现拉 + 整图回落**
 *    消费（规格 §3.3/§3.4）——「管理页/API 一写、下一次渠道调用即生效」是 ① 的同进程顺序组。
 *  - 订单成功/失败以真栈 stub 判：`wap_pay` 出站被 stub 用**应用公钥**验签（金标方向①）——
 *    ② 的轮换演练 = 换 stub 侧公钥 ⇒ 现私钥下单必败；PUT 新私钥 ⇒ 必成且 stub 侧验签通过。
 *  - 主钥窗口步（⑨）走 `docker compose up --force-recreate` **两服务冷启**（spec S-1：
 *    只冷 config 会借暖回落 ⇒ 15001 恒不可达；payment 必须同步冷——其 `lastGood` 已被
 *    ① 的成功下单整图替换）。两枚新 env 的 runner 供给链 = `run.ts` 启动处 `??=`（T-1）：
 *    窗口步显式覆盖**只有** `PAY_CONFIG_ENC_KEY` 为空 ⇒ 判据可归因到「主钥缺失」这一因。
 *  - 探针用户 fresh 注册（`registerUser`）；⑧ 的 operator/finance/viewer 账号按 slice-19
 *    形态建号登录，收尾**只停用不删**（留档、「停用不偷渡」）。
 *
 * ─── 十组（规格 §5.2 逐组对位）────────────────────────────────────────────────
 *  ⓪ 起手态：种子六项 configured + ⚙️1 顺序/标签逐字（W2-1 的真栈落点）+ 开关归一 false →
 *    recharge 开 + 下单就绪探针（15008 容忍窗口，防「配置推送未达」被误读成渠道失败）。
 *  ① 未配置 ⇒ 15001 ⇒ 配回种子 ⇒ 200 ⇒**同进程顺序组**（再删 ⇒ 同一下单调用面回到 15001，
 *    判别整图替换非单调）。
 *  ② 轮换：切片内 `node:crypto` 现生成密钥对 B；stub 换公钥 B ⇒ 现私钥 A 下单必败（负前置）
 *    ⇒ PUT B 私钥 ⇒ 下一单 200 + stub 验签通过（宿主侧独立复验对 B 公钥亦成立）⇒ 恢复 A。
 *  ③ 私钥读不回：value 恒 null / 仅指纹；覆盖 ⇒ 指纹变化；清空 ⇒ configured:false；PUT 回种子。
 *  ④ 审计：管理读口（`config/changes?key=`）+ SQL 直查——密键行 = redacted 对象（无 base64
 *    私钥子串）、非密键行 = 原文 JSON 串；清空行 **`JSON_TYPE(new_value)='NULL'`**（不是
 *    `IS NULL`）；首写 old_value = SQL NULL（JSON 两列 null 形态分开钉，⚙️17）。
 *  ⑤ 不进广播 + 通道专用性：`config.snapshot` 响应无 `pay.channel` 子串且 65 键在；payment
 *    容器 env 六项退役负断言；RPC 错令牌 ⇒ `ok:false`（10002）/ 对令牌 ⇒ `ok:true` 六键。
 *  ⑥ 静态加密：`value_enc` 前缀 `v1:`、全表无 base64 私钥子串。
 *  ⑦ 日志无密钥：payment + config 两容器自切片起点的日志窗口，grep base64 私钥子串与
 *    pullToken 皆零命中；**判别力自证**（合成行喂同一 grep 逻辑必命中）+ 窗口正向对照行。
 *  ⑧ 权限矩阵（E′）+ 变体矩阵：非 SA × {PUT,DELETE} × {字面,%2E,%4B,混合大小写} ⇒ 403；
 *    SA 字面/键段变体 ⇒ 200（临时值改完 PUT 回种子）；`%2F` 前缀段/裸/尾斜杠 ⇒ 403（含 SA）；
 *    GET 任意角色 200；近邻 `PUT /api/admin/config/pay.channel.*` ⇒ 400（非 200/非 500）。
 *  ⑨ 主钥 fail-closed（冷启四件套）：pick 现钥 → 空构造重建两服务 + 等 healthy ⇒ GET/PUT 503 ·
 *    下单 15001 · 同时 65 键面 200 不受影响 ⇒ 用存的钥重建两服务 ⇒ 下单复绿（冷 payment
 *    无回落可借 ⇒ 复绿 = 新鲜拉取强证）。
 *  ⑩ 回落：停 config-service ⇒ 下单照常 200（上次成功值）+ 回落 WARN 逐字；恢复。
 *  收尾：**六键逐个 PUT 回种子值**（禁 DELETE 收尾——① 的种子前置与连跑 slice-21 都靠它）+
 *    stub 公钥恢复 A（唯一路径：`/_control/set-app-public`）+ 开关归 false + 一次性账号停用。
 *
 * ─── 副作用与复原（登记）────────────────────────────────────────────────────
 *  - 探针用户的 `payment_orders` created 行留档（dev 栈先例；CI 每轮全新卷）——不入账、不动钱。
 *  - ② 的密钥对 B 只在切片内存生成；收尾以 A 复原（管理面 + stub 双侧双验）。
 *  - ⑨/⑩ 各重建/停起 config+payment 容器；`finally` 兜底还原主钥、两服务运行态与六键种子。
 *  - 一次性管理账号三枚（`s22*` 前缀）：只停用不删。
 *
 * ─── 零 skip、零数据依赖分支（基线回填的前提）──────────────────────────────────
 *  全部断言在任何环境下都执行；行集断言一律定长（本片自己写入的行数确定）或先聚合后单条。
 */
import { spawnSync } from 'node:child_process';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { CONFIG_KEYS, ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import type { PayCreateOrderResponse } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  GATEWAY_URL,
  adminGetConfig,
  adminLogin,
  adminPayChannelDelete,
  adminPayChannelGet,
  adminPayChannelPut,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
  type Envelope,
  type HarnessUser,
  type HttpResult,
} from '../lib/http';
import { redisLines } from '../lib/redis';
import { CONFIG_RPC, rpcCall } from '../lib/rpc';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-16/19）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** 四 PEM 夹具目录（宿主侧读；与 stub 的 `/keys` 只读挂载同源 = T6 同一对测试密钥）。 */
const FIXTURES = join(REPO_ROOT, 'tools', 'conformance', 'fixtures', 'alipay-test');

/* ── 种子值与夹具材料（三处同源：本片 / `conformance-stack.sh` 种子块 / stub 常量）── */

/** 应用私钥 = base64(PEM)（**种子形态**；§2.5「密钥类值 = base64(PEM)，旧 env 格式」）。 */
const appPrivatePemB64 = readFileSync(join(FIXTURES, 'app-private.pem')).toString('base64');
/** 支付宝公钥 = base64(PEM)（非密键，④ 的「原文行」用它验；stub 用它签响应）。 */
const alipayPublicB64 = readFileSync(join(FIXTURES, 'alipay-public.pem')).toString('base64');
/** 应用公钥 PEM 原文（stub 的启动默认值；② 恢复与「A 指纹」的本地复算用它）。 */
const appPublicPemA = readFileSync(join(FIXTURES, 'app-public.pem'), 'utf8');
/**
 * ④⑥⑦ 三组共用的 needle = base64(应用私钥) 前 40 字符。夹具文件尾恰一个 `\n` ⇒
 * canonical（`base64(trim(pem)+'\n')`，§2.3）= 种子 PUT 的值**逐字相等**（首 40 字符必同）。
 */
const privateKeyNeedle = appPrivatePemB64.slice(0, 40);

/** 值指纹 = `sha256(值) hex 前 12`（§2.3；服务侧同口径——本片全部指纹断言由此独立复算）。 */
const fpOf = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
/** 种子应用私钥的期望指纹（⓪/②/③/⑨/收尾多处复验；现场实测值 983406cce31c）。 */
const FP_PRIVATE_A = fpOf(appPrivatePemB64);
/** 种子支付宝公钥（非密键）的期望指纹。 */
const FP_PUBLIC_SEED = fpOf(alipayPublicB64);
/** stub 侧应用公钥指纹 = `sha256(PEM 原文)[:12]`（`alipay-stub.mjs` 的 `fingerprintOf` 同口径）。 */
const FP_STUB_A = fpOf(appPublicPemA);

/** 与 stub 常量 / 种子块**三处同源**（不一致 ⇒ 回调四项校验不过 ⇒ 邻居切片当场红）。 */
const TEST_APP_ID = '9021000000000000';
const TEST_SELLER_ID = '2088721087500000';
/** 渠道网关种子值（stub 网内地址；桥接页表单的 POST 目标，管理面读口断言也用它）。 */
const SEED_GATEWAY = 'http://ftl-alipay-stub:8801';
/** 站点基址种子值（字面 8443 —— slice-21 三处断言同为字面值，S-2 订正）。 */
const SEED_PUBLIC_BASE = 'https://localhost:8443';

/** ⚙️1 六键（**顺序即契约**；字面写死 = wire 级断言，不引实现常量）。 */
const CHANNEL_KEY_ORDER = [
  'pay.channel.gatewayUrl',
  'pay.channel.appId',
  'pay.channel.privateKey',
  'pay.channel.publicKey',
  'pay.channel.sellerId',
  'pay.channel.publicBaseUrl',
] as const;
/** §2.4 label 逐字。 */
const CHANNEL_LABELS: Record<(typeof CHANNEL_KEY_ORDER)[number], string> = {
  'pay.channel.gatewayUrl': '渠道网关地址',
  'pay.channel.appId': '应用 APPID',
  'pay.channel.privateKey': '应用私钥',
  'pay.channel.publicKey': '支付宝公钥',
  'pay.channel.sellerId': '商户 PID',
  'pay.channel.publicBaseUrl': '对外站点基址',
};
/** 六键种子值（收尾回填的唯一形态；与 `conformance-stack.sh` 种子块逐字同源）。 */
const SEED_VALUES: Record<(typeof CHANNEL_KEY_ORDER)[number], string> = {
  'pay.channel.gatewayUrl': SEED_GATEWAY,
  'pay.channel.appId': TEST_APP_ID,
  'pay.channel.privateKey': appPrivatePemB64,
  'pay.channel.publicKey': alipayPublicB64,
  'pay.channel.sellerId': TEST_SELLER_ID,
  'pay.channel.publicBaseUrl': SEED_PUBLIC_BASE,
};

/** 已退役的渠道六项 env（T11 起；payment 容器出现任一 ⇒ 管理化回流——⑤ 负断言）。 */
const RETIRED_CHANNEL_ENVS = [
  'ALIPAY_GATEWAY_URL',
  'ALIPAY_APP_ID',
  'ALIPAY_PRIVATE_KEY',
  'ALIPAY_PUBLIC_KEY',
  'ALIPAY_SELLER_ID',
  'PAY_PUBLIC_BASE_URL',
] as const;

/** 本 run 的唯一后缀（用户名/needle 全带它；同栈连跑两轮不互撞）。 */
const TAG = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(-8);
/** 本 run 起始时刻（④ 的 `from`/SQL since 过滤；脏卷上把上一轮的行挡在外面）。 */
const RUN_START_MS = Date.now();
const RUN_START_SEC = Math.floor(RUN_START_MS / 1000);

/** ⑧ 的 SA 临时网关值（改完必 PUT 回种子；落点端口 9801 无人听，⑧ 全程不下单，零副作用）。 */
const TEMP_GATEWAY_URL = 'http://ftl-alipay-stub:9801';
/** ⑩ 的回落 WARN 逐字（§2.9；判据面 = 该句在场 ⇒ 文案不含值由构造保证）。 */
const FALLBACK_WARN_TEXT = '渠道配置拉取失败，使用上次成功值（trace 见 meta）';

/** ⑨窗口步的合法 PUT 值（§3.5 观测序：400 先于 503 ⇒ 以 503 为判据必须用合法值）。 */
const WINDOW_LEGAL_URL = 'https://localhost:8443';

/**
 * 拉取令牌（runner 供给链 T-1：`run.ts` 启动处 `??=` —— **必须惰性读**：slice 模块顶层
 * 先于 run.ts 模块体求值，顶层捕获会在 `??=` 之前拿到 undefined）。
 */
function pullToken(): string {
  return process.env.PAY_CHANNEL_PULL_TOKEN || '';
}

/* ──────────────────────────────────────────────────────────────────────────
 * docker / compose / mysql / stub 助手（形态先例：slice-14/16/19/21）
 * ────────────────────────────────────────────────────────────────────────── */

interface CommandResult {
  code: number;
  out: string;
}

/** 跑一条 `docker` 命令（带超时 + MSYS 防路径转写；照 slice-21）。 */
function docker(args: string[], timeoutMs = 60_000): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/**
 * `docker compose …`（`extraEnv` 覆盖宿主 env；照 slice-14 的同名助手）。
 * ⑨/⑩ 的窗口/恢复重建全走它——`env: {...process.env, ...extraEnv}` 让 run.ts 供给的
 * 两枚新 env（§5.4 T-1）随每次重建照常透传，仅显式覆盖项（如空主钥）生效。
 */
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

/** `docker compose exec -T <service> …`（`-T` 不能省；照 slice-19/21）。 */
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
 * MySQL 查询（`-N` = 不带列表头；SQL 里 `key` 这类保留字列名写成 `` \` `` ——
 * **转义链**：JS 串里 `\\\`` ⇒ sh 收到 `\`` ⇒ 双引号内还原为字面反引号 ⇒ mysql 收到反引号。
 * 照 slice-14 `MYSQL_FLIP_TRUE_SH` 先例；不要裸写反引号（容器 sh 会当命令替换）。
 */
function mysqlQuery(sql: string): CommandResult {
  return exec('mysql', 'sh', '-c', `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE" -N -e "${sql}"`);
}

/** SQL 读**末行文本**（剥 mysql 密码告警行；空 ⇒ 抛，不把空串装成值；照 slice-19/21）。 */
function mysqlScalar(sql: string): string {
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

/** `docker inspect <容器>` 的 env 数组（解析失败 ⇒ 空数组，由调用方响亮处理）。 */
function containerEnv(name: string): string[] {
  const r = docker(['inspect', name, '--format', '{{json .Config.Env}}']);
  try {
    return JSON.parse(r.stdout.trim()) as string[];
  } catch {
    return [];
  }
}

/** 从 env 数组里取单键值（缺 ⇒ 空串——调用方自己判空并响亮）。 */
function pickEnv(envs: readonly string[], name: string): string {
  const hit = envs.find((e) => e.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
}

/** 等容器 healthy（有界；返回末次读数 —— 由调用方断言）。 */
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

/** 某服务最近 `sinceSeconds` 秒的容器日志（`--no-color` 必须有：ANSI 会让「找那一行」恒假）。 */
function composeLogs(service: string, sinceSeconds: number): string {
  const r = spawnSync(
    'docker',
    ['compose', 'logs', '--no-color', '--since', `${sinceSeconds}s`, service],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/*
 * ── 容器日志（NDJSON）与有界轮询 —— ⑨ 启动行自证读口（T15 换源时补入）──────────
 * 逐字照 slice-20 `:208`–`:241`（先例 = slice-12/13/15；本片原无此两件——r1 🟠4 实核）。
 */

/** 一行日志里抽出 NDJSON 记录（前缀 `ftl-x | ` 与非 JSON 行一律返回 null）。 */
function safeJson(line: string): Record<string, unknown> | null {
  const at = line.indexOf('{');
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(at)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 某服务近 `sinceSeconds` 秒的全部 NDJSON 记录。 */
function ndjson(service: string, sinceSeconds: number): Array<Record<string, unknown>> {
  return composeLogs(service, sinceSeconds)
    .split('\n')
    .map(safeJson)
    .filter((r): r is Record<string, unknown> => r !== null);
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

/**
 * 同一份 grep 逻辑（⑦ 的判别力自证与真实判定**共用** —— 合成输入必命中、真实日志零命中，
 * 两条走的是同一个 `includes` 扫描，不允许「自证用另一套」）。
 */
function grepHits(text: string, needles: readonly string[]): string[] {
  return needles.filter((n) => n.length > 0 && text.includes(n));
}

/* ── stub 控制面（`docker exec` + busybox wget；stub 无宿主端口——照 slice-21）────────── */

const STUB_CONTAINER = 'ftl-alipay-stub';

function stubControl(pathAndQuery: string): string {
  const r = docker(['exec', STUB_CONTAINER, 'wget', '-qO-', `http://127.0.0.1:8801${pathAndQuery}`], 20_000);
  if (r.status !== 0) {
    throw new ConformanceError(`stub 控制面 ${pathAndQuery} 失败（exit ${r.status}）：${(r.stderr || r.stdout).slice(-300)}`);
  }
  return r.stdout;
}

interface StubOrderState {
  wapPayVerified: boolean;
  wapPayRequests: number;
  queryRequests: number;
}
interface StubState {
  keys: { appPublic: boolean; appPublicFingerprint: string | null; alipayPrivate: boolean };
  counters: Record<string, number>;
  orders: Record<string, StubOrderState>;
}
function stubState(): StubState {
  return JSON.parse(stubControl('/_control/state')) as StubState;
}
/** `/_control/set-app-public?pem=<urlencoded PEM 原文>`（② 轮换/恢复的驱动面；回指纹不回整稿）。 */
function stubSetAppPublic(pem: string): { ok: boolean; fingerprint: string } {
  return JSON.parse(stubControl(`/_control/set-app-public?pem=${encodeURIComponent(pem)}`)) as { ok: boolean; fingerprint: string };
}

/**
 * 宿主侧**独立复验**我们的出站请求签名（app 侧公钥可指定——② 轮换后要对 **B 公钥**复验）。
 * 规范化 = `sign_type` 参与、按名 ASCII 升序 —— 与 stub 的 `requestSource` 同口径（第三份复写）。
 */
function verifyAppRequestSignature(form: string, appPublicPem: string): boolean {
  const params = Object.fromEntries(new URLSearchParams(form));
  const sign = params.sign ?? '';
  const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const src = [...Object.entries(params).filter(([k]) => k !== 'sign' && k !== 'sign_type'), ['sign_type', 'RSA2'] as [string, string]]
    .sort((x, y) => asc(x[0], y[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  try {
    return createVerify('RSA-SHA256').update(src, 'utf8').verify(appPublicPem, Buffer.from(sign, 'base64'));
  } catch {
    return false;
  }
}

/* ── wap.pay 桥接半程：门口 GET 桥接页 → 解析 hidden inputs → 模拟浏览器 POST 回 stub ── */

/** 门口 HTTPS 口（自签；与 slice-21 同形态）。 */
const EDGE_HTTPS_PORT = process.env.EDGE_HTTPS_PORT ?? '8443';

function edgeGet(pathWithQuery: string): Promise<{ status: number; body: string }> {
  const u = new URL(`https://localhost:${EDGE_HTTPS_PORT}${pathWithQuery}`);
  return new Promise((resolveP, reject) => {
    const req = https.request(
      { hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'GET', rejectUnauthorized: false },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolveP({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function unescapeHtmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 从桥接页 HTML 抽 hidden inputs（浏览器将 POST 的表单事实；照 slice-21 同一份口径）。 */
function parseHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input\s+type="hidden"\s+name="([^"]*)"\s+value="([^"]*)"\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out[unescapeHtmlAttr(m[1]!)] = unescapeHtmlAttr(m[2]!);
  }
  return out;
}

interface BridgeWalk {
  pageStatus: number;
  html: string;
  inputs: Record<string, string>;
  /** 浏览器将 POST 出去的 application/x-www-form-urlencoded 字节（宿主复验喂它）。 */
  formBody: string;
  wapReply: { alipay_trade_wap_pay_response?: { code?: string; sub_code?: string; out_trade_no?: string } };
}

/**
 * 走完 wap.pay 的**页面执行半程**：① 玩家浏览器 GET 桥接 URL（经门口，HMAC token 自守）；
 * ② 从 HTML 抽出已签名表单；③ 在 stub 容器内 wget 模拟浏览器自动 POST（stub 无宿主端口）。
 * 服务端自身只发 query 凭证探针，**绝不 POST wap.pay**——本助手把浏览器那一跳补回来。
 */
async function browserWalkBridge(payUrl: string): Promise<BridgeWalk> {
  const u = new URL(payUrl);
  const page = await edgeGet(`${u.pathname}${u.search}`);
  const inputs = parseHiddenInputs(page.body);
  const formBody = new URLSearchParams(Object.entries(inputs)).toString();
  const r = docker(
    ['exec', STUB_CONTAINER, 'wget', '-qO-', '--post-data', formBody, 'http://127.0.0.1:8801/gateway.do'],
    20_000,
  );
  if (r.status !== 0) {
    throw new ConformanceError(`② 浏览器模拟 POST stub 网关失败（exit ${r.status}）：${(r.stderr || r.stdout).slice(-300)}`);
  }
  return { pageStatus: page.status, html: page.body, inputs, formBody, wapReply: JSON.parse(r.stdout) as BridgeWalk['wapReply'] };
}

/* ── 限流桶助手（探针自证不比「上一发的余温」；键形状抄自 rate-limit.ts 的导出函数）───── */

/** 清某用户的通用/下单桶（burst 前清；键形状 = `ratelimit:http:{uid}` / `ratelimit:pay-order:{uid}`）。 */
function clearUserBuckets(userId: string): void {
  redisLines(['DEL', `ratelimit:http:${userId}`, `ratelimit:pay-order:${userId}`]);
}

/** 清空**全部** IP 维桶（上一片的 burst 会在 60s 窗口里波及本片起手；slice-21 先例）。 */
function clearIpBuckets(): void {
  const keys = redisLines(['KEYS', 'ratelimit:http-ip:*']);
  if (keys.length > 0) redisLines(['DEL', ...keys]);
}

/**
 * 清管理写桶（`ratelimit:admin-write:<sha256(token)[:16]>`；键指纹算法 = 网关 `adminTokenFp`）。
 * 本片的管理写面 >30 次（ADMIN_WRITE = 30/5min）⇒ 在写突发前清一次，防 429 假红
 * （429 会被 ⑧ 的 403/200 矩阵误读）。**只清本片自己登录拿到的令牌的桶**——不动别人的。
 */
function clearAdminWriteBucket(token: string): void {
  const fp = createHash('sha256').update(token).digest('hex').slice(0, 16);
  redisLines(['DEL', `ratelimit:admin-write:${fp}`]);
}

/* ── 网关面小助手 ───────────────────────────────────────────────────────── */

/** 任意方法/路径的网关请求（⑧ 的变体矩阵用；lib 的助手不复现变体路径形态）。 */
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

/* ── 管理面账号助手（⑧ 的角色矩阵；照 slice-19/21 形态）──────────────────── */

async function loginAdminAs(username: string, password: string): Promise<string> {
  const res = await postJson<{ token: string }>('/api/admin/login', { username, password });
  const token = res.body?.data?.token;
  if (res.body?.code !== ErrCode.OK || !token) {
    throw new ConformanceError(`管理登录 ${username} 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return token;
}

/* ── 下单链助手 ─────────────────────────────────────────────────────────── */

/**
 * 轮询下单直到观测到 `want` 码；`tolerate` 里的码 = **就绪窗口**（不是判据）：payment 冷启后
 * 快照/推送未达时 `rechargeEnabled` 回落 false ⇒ 15008；RPC 桥未就绪 ⇒ 15001——两者都只是
 * 「还没到可观测态」，有界重试；其余码（尤以 200/意外码）**立即响亮红**（不掩盖真状态）。
 */

/**
 * 下单探针的**死套接字守卫**（CI 2/2 实证的环境性红，修于 2026-10-06 上线轮）：
 * `compose()`/`exec()` 全是 `spawnSync`——**同步冻结宿主事件循环**；冻结期间网关
 * （Node http，keepAliveTimeout=5s）会关掉空闲 keep-alive 套接字。共享库
 * `fetchDeadSocketRetry`（`lib/http.ts:95-135`）只重试 **GET**（POST 可能已改服务端状态、
 * 刻意不重试）⇒ 本片 ⑩「`stop config-service`（长冻结）之后**第一个动作就是 POST**」是全片
 * 唯一裸奔点：CI 2/2 必红（`fetch failed / SocketError: other side closed`），本地 3/3 不触发。
 *
 * ⚠️ **为什么本片可以重试 POST**：`POST /api/pay/orders` 有**幂等复用**契约（同用户 pending 单
 * 原样返回；支付片 ③ 已证），且触发条件是**连接级失败 = 请求字节根本没送达**（写死套接字，
 * 1–10ms 内失败）——重试不会产生第二张单。共享库「POST 不重试」纪律**不动**（那是全局语义面）。
 * 恰一次、必打日志（不许静默），照本仓「有界重试 + 响亮留痕」先例。
 */
async function postOrderGuarded(user: HarnessUser, packageYuan: number): Promise<HttpResult<PayCreateOrderResponse>> {
  const attempt = (): Promise<HttpResult<PayCreateOrderResponse>> =>
    postJson<PayCreateOrderResponse>('/api/pay/orders', { packageYuan }, user.accessToken);
  try {
    return await attempt();
  } catch (err) {
    const cause = (err as { cause?: unknown })?.cause;
    const text = `${err instanceof Error ? err.message : String(err)} ${cause instanceof Error ? cause.message : String(cause ?? '')} ${(cause as { code?: string })?.code ?? ''}`;
    if (!/other side closed|UND_ERR_SOCKET|ECONNRESET/i.test(text)) throw err;
    info(`↻ 冻结后下单 POST 连接级失败（死套接字，请求未送达）—— 幂等复用契约 ⇒ 有界重试一次：${text.slice(0, 120)}`);
    return await attempt();
  }
}

async function orderUntilCode(
  user: HarnessUser,
  packageYuan: number,
  want: number,
  timeoutMs: number,
  label: string,
  tolerate: readonly number[] = [],
): Promise<HttpResult<PayCreateOrderResponse>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    clearUserBuckets(user.id);
    const res = await postOrderGuarded(user, packageYuan);
    const code = res.body?.code;
    if (code === want) return res;
    if (code !== undefined && tolerate.includes(code) && Date.now() < deadline) {
      await sleep(1_200);
      continue;
    }
    throw new ConformanceError(
      `${label}：期望 code ${want}，实际 HTTP ${res.status} ${JSON.stringify(res.body)}` +
        (code !== undefined && tolerate.includes(code) ? `（${timeoutMs}ms 就绪窗口耗尽）` : ''),
    );
  }
}

/** 管理面 GET 的六项条目（§2.4；只列本片读的字段——含 label/updatedBy 供 ⓪ 逐字断言）。 */
interface PayChannelAdminEntry {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  value: string | null;
  fingerprint: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════════ */

export async function runSlice22(): Promise<Checks> {
  const checks = new Checks();
  let adminToken = '';
  /** ⑨ 窗口步存下的现容器主钥（恢复步与 finally 兜底都靠它；空串 = 尚未取到）。 */
  let encKeySaved = '';
  /** ⑨ 窗口是否开着（窗口重建后、恢复完成前置 true —— finally 据此兜底还原）。 */
  let windowOpen = false;
  /** ⑨ 重建时**必须随行透传**的栈注入值（现容器 pick：引导口令——compose 里它是空默认
   *  `${ADMIN_PASSWORD:-}`，不进 runner env；不 pick ⇒ 重建把栈注入态弄丢）。
   *  节奏两键已随换源退役（T15）：值由 config 面供给，重建后改「启动行自证」（见 ⑨）。 */
  let adminPwSaved = '';
  /** ⑩ config-service 是否被本片停过（finally 兜底 start）。 */
  let configStopped = false;
  /** ⑧ 建的一次性账号（收尾停用留档）。 */
  const probeAccounts: Array<{ id: number; username: string }> = [];
  /** 收尾（主路径）是否已完成（finally 的六键回填只在异常路径才必要，但幂等无害）。 */
  let wrappedUp = false;

  try {
    /* ── ⓪ 起手态 ───────────────────────────────────────────────────────── */
    step('⓪ 起手态：stub 在跑 · 种子六项 configured + ⚙️1 顺序/标签逐字 · 开关归一 false → recharge 开 · 下单就绪');
    const stubPs = docker(['inspect', STUB_CONTAINER, '--format', '{{.State.Running}}']);
    checks.eq(stubPs.stdout.trim(), 'true', `stub 容器 ${STUB_CONTAINER} 必须在运行（conformance-stack.sh up 负责起它）`);
    const stub0 = stubState();
    checks.that(stub0.keys.appPublic && stub0.keys.alipayPrivate, `stub 双侧密钥在场（appPublic/alipayPrivate）—— 实际 ${JSON.stringify(stub0.keys)}`);
    checks.eq(
      stub0.keys.appPublicFingerprint,
      FP_STUB_A,
      '⓪ stub 应用公钥指纹 = sha256(夹具 app-public.pem)[:12]（宿主独立复算——② 的「恢复 A」以此为准）',
    );

    clearIpBuckets();
    adminToken = await adminLogin(); // 引导号 super_admin
    checks.that(adminToken.length > 0, '⓪ 引导号管理登录 ⇒ token（后续全部管理写面的 actor 真源）');
    clearAdminWriteBucket(adminToken); // 同秒重跑会复用同一 JWT ⇒ 清一次自己的写桶（防 429 假红）

    // 种子生效（T14：栈脚本 up 末尾经管理面 PUT ×6）——渠道面消费的**唯一**来源。
    const chGet = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    expectHttp(checks, chGet, 200, ErrCode.OK, '⓪ 管理面 GET /api/admin/pay-channel（种子生效读口）');
    const chKeys = chGet.body?.data?.keys ?? [];
    checks.eq(chKeys.length, 6, `⓪ 渠道条目恰六项 —— 实际 ${chKeys.length}`);
    checks.eq(
      chKeys.map((k) => k.key).join(','),
      CHANNEL_KEY_ORDER.join(','),
      '⓪ ⚙️1 顺序逐字（W2-1 的真栈落点：有数据面必须是固定序组装，不是行序/字母序）',
    );
    checks.eq(
      chKeys.map((k) => k.label).join(','),
      CHANNEL_KEY_ORDER.map((k) => CHANNEL_LABELS[k]).join(','),
      '⓪ 六项 label 逐字（§2.4 表下注文）',
    );
    checks.that(
      chKeys.every((k) => k.configured === true && typeof k.updatedAt === 'number' && k.updatedBy === 'admin'),
      `⓪ 六项全 configured=true 且 updatedAt 为数字、updatedBy=admin（种子写者）—— 实际 ${JSON.stringify(chKeys.map((k) => [k.key, k.configured, k.updatedBy]))}`,
    );
    checks.eq(
      chKeys.map((k) => `${k.key}:${k.fingerprint}`).join('|'),
      [
        `pay.channel.gatewayUrl:${fpOf(SEED_GATEWAY)}`,
        `pay.channel.appId:${fpOf(TEST_APP_ID)}`,
        `pay.channel.privateKey:${FP_PRIVATE_A}`,
        `pay.channel.publicKey:${FP_PUBLIC_SEED}`,
        `pay.channel.sellerId:${fpOf(TEST_SELLER_ID)}`,
        `pay.channel.publicBaseUrl:${fpOf(SEED_PUBLIC_BASE)}`,
      ].join('|'),
      '⓪ 六项指纹 = 宿主对种子值独立复算（种子字节逐字落地；之后 ②③ 的「指纹变化」皆以此基线判）',
    );
    const chEntry = (key: string): PayChannelAdminEntry | undefined => chKeys.find((k) => k.key === key);
    const chPriv0 = chEntry('pay.channel.privateKey');
    checks.that(
      chPriv0?.secret === true && chPriv0.value === null && /^[0-9a-f]{12}$/.test(chPriv0.fingerprint ?? ''),
      `⓪ 私钥条目 secret=true / value 恒 null（密键读不回）/ fingerprint=12hex —— 实际 ${JSON.stringify(chPriv0)}`,
    );
    checks.that(
      chEntry('pay.channel.appId')?.value === TEST_APP_ID && chEntry('pay.channel.sellerId')?.value === TEST_SELLER_ID,
      `⓪ appId/sellerId 种子值与 stub 常量逐字一致（三处同源）—— 实际 ${JSON.stringify([chEntry('pay.channel.appId')?.value, chEntry('pay.channel.sellerId')?.value])}`,
    );

    // 开关归一（照 slice-21 ⓪）：先归 false（收拢上一轮 crashed run 的残留），再开 recharge（下单前置）。
    const norm1 = await adminPutConfigFalse('pay.rechargeEnabled');
    checks.eq(norm1.body?.code, ErrCode.OK, '⓪ 归一 pay.rechargeEnabled=false ⇒ code 0');
    const norm2 = await adminPutConfigFalse('pay.withdrawEnabled');
    checks.eq(norm2.body?.code, ErrCode.OK, '⓪ 归一 pay.withdrawEnabled=false ⇒ code 0');
    const en1 = await adminPutConfigTrue('pay.rechargeEnabled');
    checks.eq(en1.body?.code, ErrCode.OK, '⓪ pay.rechargeEnabled=true（① 起下单链的前置；推送 ≤30s 由下面探针兜）');

    // 下单就绪探针（容忍推送未达的 15008 窗口；OK = 种子图 + stub 全链已通）。
    const uCfg = await registerUser(41);
    const warm = await orderUntilCode(uCfg, 30, ErrCode.OK, 30_000, '⓪ 下单就绪探针', [ErrCode.PAY_DISABLED]);
    expectHttp(checks, warm, 200, ErrCode.OK, '⓪ recharge 开启后下单就绪探针（种子图端到端）');
    checks.that(
      typeof warm.body?.data?.orderNo === 'string' && warm.body.data.orderNo.length > 0,
      `⓪ 探针单号在场 —— 实际 ${JSON.stringify(warm.body?.data?.orderNo)}`,
    );

    /* ── ① 未配置 ⇒ 15001 ⇒ 配置 ⇒ 200 ⇒ 同进程顺序组 ────────────────────── */
    step('① 未配置 ⇒ 下单 15001 ⇒ PUT 回种子 ⇒ 200 ⇒「配→成功→删→15001」同进程顺序组（整图替换判别）');
    // 第一腿：删 appId ⇒ 读配置缺键 ⇒ readConfig() null ⇒ 15001（行保留；同调用面 = uCfg/pkg30）。
    const del1 = await adminPayChannelDelete('pay.channel.appId', adminToken);
    checks.eq(del1.body?.code, ErrCode.OK, '① DELETE pay.channel.appId ⇒ code 0');
    checks.eq(del1.body?.data?.saved, true, '① DELETE 响应 {saved:true}（幂等契约）');
    const miss1 = await orderUntilCode(uCfg, 30, ErrCode.PAY_CHANNEL_ERROR, 15_000, '① 缺 appId 下单');
    expectHttp(checks, miss1, 502, ErrCode.PAY_CHANNEL_ERROR, '① 未配置渠道下单');
    checks.eq(miss1.body?.message, '支付渠道暂时不可用，请稍后重试', '① 15001 文案逐字（orders.service）');
    const getMiss = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    checks.that(
      getMiss.body?.data?.keys?.find((k) => k.key === 'pay.channel.appId')?.configured === false,
      `① 删后管理读口 appId configured=false —— 实际 ${JSON.stringify(getMiss.body?.data?.keys?.find((k) => k.key === 'pay.channel.appId'))}`,
    );

    // 第二腿：配回种子 ⇒ 同一下单调用面 ⇒ 200（整图替换生效）。
    const put1 = await adminPayChannelPut('pay.channel.appId', TEST_APP_ID, adminToken);
    expectHttp(checks, put1, 200, ErrCode.OK, '① PUT 回 appId 种子值');
    checks.eq(put1.body?.data?.saved, true, '① PUT 回种子 {saved:true}');
    checks.eq(put1.body?.data?.fingerprint, fpOf(TEST_APP_ID), '① PUT 返回指纹 = sha256(appId 种子值)[:12]');
    const ok1 = await orderUntilCode(uCfg, 30, ErrCode.OK, 15_000, '① 配回后下单');
    expectHttp(checks, ok1, 200, ErrCode.OK, '① 配回种子后同调用面 ⇒ 200（保存后下一次渠道调用即生效）');
    {
      const no = ok1.body?.data?.orderNo ?? '';
      const pay = ok1.body?.data?.payUrl ?? '';
      checks.that(
        pay.startsWith(`${SEED_PUBLIC_BASE}/pay/cashier/${no}?t=`),
        `① payUrl = 本站桥接页（门口 + /pay/cashier/<单号> + HMAC token）—— 实际前缀 ${JSON.stringify(pay.slice(0, 64))}`,
      );
      // 服务端唯一渠道出站 = query 凭证探针（stub 全局 query 计数自证）；wap.pay 由浏览器半程补。
      checks.that((stubState().counters.query ?? 0) >= 1, '① 下单触发 query 凭证探针（counters.query≥1；wap.pay 零服务端出站）');
      const walk = await browserWalkBridge(pay);
      checks.eq(walk.pageStatus, 200, '① 桥接页经门口 ⇒ 200');
      checks.eq(walk.wapReply.alipay_trade_wap_pay_response?.code, '10000', '① 浏览器 POST wap.pay ⇒ stub 10000（通道链闭合）');
      checks.that(verifyAppRequestSignature(walk.formBody, appPublicPemA), '① 宿主复验：桥接表单签名对 A 公钥成立');
      const so = stubState().orders[no];
      checks.eq(so?.wapPayVerified, true, '① 该单 stub 侧验签通过（浏览器半程后）');
      checks.eq(so?.wapPayRequests, 1, '① stub 恰收 1 次 wap.pay（来自浏览器，非服务端）');
    }

    // 第三腿（顺序组）：再删 ⇒ 同一调用面回到 15001 ⇒ 读口回 503 面之外的 fail 语义（15001）。
    const del2 = await adminPayChannelDelete('pay.channel.appId', adminToken);
    checks.eq(del2.body?.code, ErrCode.OK, '① 顺序组：再次 DELETE appId ⇒ code 0');
    const miss2 = await orderUntilCode(uCfg, 30, ErrCode.PAY_CHANNEL_ERROR, 15_000, '① 顺序组：再删后下单');
    expectHttp(checks, miss2, 502, ErrCode.PAY_CHANNEL_ERROR, '① 顺序组：同一下单调用面回到 15001（整图替换按次现拉，非单调）');
    // 末态 = 六键种子齐；补一发下单正对照收束本组。
    const put2 = await adminPayChannelPut('pay.channel.appId', TEST_APP_ID, adminToken);
    expectHttp(checks, put2, 200, ErrCode.OK, '① 顺序组末：PUT 回 appId 种子 ⇒ 200');
    const ok2 = await orderUntilCode(uCfg, 30, ErrCode.OK, 15_000, '① 顺序组末下单');
    expectHttp(checks, ok2, 200, ErrCode.OK, '① 组末正对照：下单 200（本组末态可下单）');
    const getOk = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    checks.that(
      getOk.body?.data?.keys?.every((k) => k.configured === true) === true,
      `① 组末态：六键全 configured（种子齐）—— 实际 ${JSON.stringify(getOk.body?.data?.keys?.map((k) => [k.key, k.configured]))}`,
    );

    /* ── ② 轮换 ─────────────────────────────────────────────────────────── */
    step('② 轮换：切片内生成密钥对 B · stub 换 B 公钥 ⇒ 现私钥 A 必败（负前置）⇒ PUT B 私钥 ⇒ 下单 200 + 双向验签 ⇒ 恢复 A');
    const { publicKey: pubB, privateKey: privB } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const privBB64 = Buffer.from(privB, 'utf8').toString('base64');
    const FP_PRIVATE_B = fpOf(privBB64);
    checks.that(FP_PRIVATE_B !== FP_PRIVATE_A, `② 密钥对 B 现生成、指纹必不同于 A（B=${FP_PRIVATE_B} / A=${FP_PRIVATE_A}）`);

    const setB = stubSetAppPublic(pubB);
    checks.that(setB.ok === true, '② stub /_control/set-app-public 换 B 公钥 ⇒ ok');
    checks.eq(setB.fingerprint, fpOf(pubB), '② stub 回报指纹 = sha256(B 公钥原文)[:12]（换的确实是 B 的字节）');
    checks.that(setB.fingerprint !== FP_STUB_A, '② stub 指纹已异于 A（换钥动作真实发生）');

    const uRot = await registerUser(42);
    // 负前置：管理面私钥仍是 A ⇒ stub 用 B 公钥验 query 探针签名 ⇒ INVALID_SIGN ⇒ 15001。
    const missB = await orderUntilCode(uRot, 30, ErrCode.PAY_CHANNEL_ERROR, 15_000, '② 负前置（旧钥 A vs stub 新公钥 B）');
    expectHttp(checks, missB, 502, ErrCode.PAY_CHANNEL_ERROR, '② 现私钥 A 下单必败 ⇒ 15001（负前置成立）');
    checks.that(
      (stubState().counters.badSignature ?? 0) >= 1,
      `② 错钥被 stub 响亮拒绝（query 探针 badSignature≥1；本地签名对错钥无感知，探针使其当场暴露）—— 实际 ${JSON.stringify(stubState().counters.badSignature)}`,
    );

    const putB = await adminPayChannelPut('pay.channel.privateKey', privBB64, adminToken);
    expectHttp(checks, putB, 200, ErrCode.OK, '② PUT 新私钥 B（base64(PEM) 形态）');
    checks.eq(putB.body?.data?.fingerprint, FP_PRIVATE_B, '② PUT 返回指纹 = 宿主对 B 独立复算（canonical 归一逐字）');
    const okB = await orderUntilCode(uRot, 30, ErrCode.OK, 15_000, '② 轮换后下单');
    expectHttp(checks, okB, 200, ErrCode.OK, '② 下一单 200（下一次渠道调用即用新私钥签名）');
    const orderBNo = okB.body?.data?.orderNo ?? '';
    {
      const payB = okB.body?.data?.payUrl ?? '';
      checks.that(payB.startsWith(`${SEED_PUBLIC_BASE}/pay/cashier/${orderBNo}?t=`), `② 轮换单 payUrl 同样是本站桥接页 —— 实际 ${JSON.stringify(payB.slice(0, 64))}`);
      const walkB = await browserWalkBridge(payB);
      checks.eq(walkB.pageStatus, 200, '② B↔B 配对：桥接页 200（query 探针 TRADE_NOT_EXIST 放行）');
      checks.eq(walkB.wapReply.alipay_trade_wap_pay_response?.code, '10000', '② 浏览器 POST wap.pay ⇒ stub 10000');
      checks.eq(stubState().orders[orderBNo]?.wapPayVerified, true, '② stub 侧验签通过（方向①：B 私钥对 B 公钥；浏览器表单）');
      checks.that(verifyAppRequestSignature(walkB.formBody, pubB), '② 宿主侧独立复验：桥接表单签名对 B 公钥成立（人证 + 机械证两向）');
    }
    const getB = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    checks.eq(
      getB.body?.data?.keys?.find((k) => k.key === 'pay.channel.privateKey')?.fingerprint,
      FP_PRIVATE_B,
      '② 管理读口私钥指纹同步为 B（读口与写口同一事实）',
    );

    // 恢复（本组末态 = 应用私钥 A + stub A + 六键种子；S-4：唯一路径 = 再 set-app-public）。
    const putA = await adminPayChannelPut('pay.channel.privateKey', appPrivatePemB64, adminToken);
    expectHttp(checks, putA, 200, ErrCode.OK, '② 恢复：PUT 回应用私钥 A');
    checks.eq(putA.body?.data?.fingerprint, FP_PRIVATE_A, '② 恢复后指纹回 A');
    const setA = stubSetAppPublic(appPublicPemA);
    checks.that(setA.ok === true, '② 恢复：stub 公钥回 A ⇒ ok');
    checks.eq(setA.fingerprint, FP_STUB_A, '② 恢复后 stub 指纹 = A（与 ⓪ 基线逐字相等）');
    const okA2 = await orderUntilCode(uRot, 30, ErrCode.OK, 15_000, '② 恢复后正对照下单');
    expectHttp(checks, okA2, 200, ErrCode.OK, '② 恢复后正对照：A↔A 配对可下单（末态自洽）');

    /* ── ③ 私钥读不回 ───────────────────────────────────────────────────── */
    step('③ 私钥读不回：GET 仅指纹（value 恒 null）· 覆盖 ⇒ 指纹变化 · DELETE ⇒ configured:false · PUT 回种子');
    const g1 = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    const priv1 = g1.body?.data?.keys?.find((k) => k.key === 'pay.channel.privateKey');
    checks.that(priv1?.value === null && priv1?.fingerprint === FP_PRIVATE_A, `③ 私钥条目 value 恒 null 且指纹=基线 A —— 实际 ${JSON.stringify(priv1)}`);

    const putTmp = await adminPayChannelPut('pay.channel.privateKey', privBB64, adminToken);
    expectHttp(checks, putTmp, 200, ErrCode.OK, '③ 临时覆盖（B）');
    checks.eq(putTmp.body?.data?.fingerprint, FP_PRIVATE_B, '③ 覆盖返回 B 指纹');
    const g2 = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    const priv2 = g2.body?.data?.keys?.find((k) => k.key === 'pay.channel.privateKey');
    checks.that(
      priv2?.value === null && priv2?.fingerprint === FP_PRIVATE_B && priv2.fingerprint !== FP_PRIVATE_A,
      `③ 覆盖后指纹已变化（A→B）且 value 仍 null —— 实际 ${JSON.stringify(priv2)}`,
    );

    const delPriv = await adminPayChannelDelete('pay.channel.privateKey', adminToken);
    expectHttp(checks, delPriv, 200, ErrCode.OK, '③ DELETE 私钥');
    checks.eq(delPriv.body?.data?.saved, true, '③ DELETE 响应 {saved:true}');
    const g3 = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    const priv3 = g3.body?.data?.keys?.find((k) => k.key === 'pay.channel.privateKey');
    checks.that(
      priv3?.configured === false && priv3.value === null && priv3.fingerprint === null && priv3.updatedAt === null,
      `③ 清空 ⇒ configured:false 全 null 投影 —— 实际 ${JSON.stringify(priv3)}`,
    );

    const putBack = await adminPayChannelPut('pay.channel.privateKey', appPrivatePemB64, adminToken);
    expectHttp(checks, putBack, 200, ErrCode.OK, '③ PUT 回种子 A');
    const g4 = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    const priv4 = g4.body?.data?.keys?.find((k) => k.key === 'pay.channel.privateKey');
    checks.that(priv4?.configured === true && priv4?.fingerprint === FP_PRIVATE_A, `③ PUT 回种子后 configured=true 且指纹回 A —— 实际 ${JSON.stringify(priv4)}`);
    // 非密键同值幂等写（④ 的「原文行」素材；值不变 ⇒ 零风险）。
    const gwNoop = await adminPayChannelPut('pay.channel.gatewayUrl', SEED_GATEWAY, adminToken);
    expectHttp(checks, gwNoop, 200, ErrCode.OK, '③ 收束：gatewayUrl 同值幂等写（非密键原文行素材）');
    checks.that(
      g4.body?.data?.keys?.map((k) => k.key).join(',') === CHANNEL_KEY_ORDER.join(',') &&
        g4.body?.data?.keys?.every((k) => k.configured === true) === true,
      '③ 组末 ⚙️1 顺序再断言 + 六项 configured（本组末态 = ②末态 + 新写，读口一致）',
    );

    /* ── ④ 审计 ─────────────────────────────────────────────────────────── */
    step('④ 审计：密键行 redacted 对象（无 base64 私钥子串）· 非密键行原文 · 清空行 JSON_TYPE(new_value)=\'NULL\' · 首写 old=SQL NULL');
    const changesPriv = await getJson<{ rows: Array<{ id: number; key: string; oldValue: unknown; newValue: unknown; actor: string; createdAt: number }>; nextCursor: number | null }>(
      `/api/admin/config/changes?key=${encodeURIComponent('pay.channel.privateKey')}&from=${RUN_START_MS}&limit=100`,
      adminToken,
    );
    expectHttp(checks, changesPriv, 200, ErrCode.OK, '④ GET /api/admin/config/changes?key=pay.channel.privateKey（本 run 窗口）');
    const privRows = changesPriv.body?.data?.rows ?? [];
    checks.eq(privRows.length, 5, `④ 本 run 私钥行恰 5（②B 写 / ②A 恢复 / ③B 覆盖 / ③清空 / ③回种子）—— 实际 ${privRows.length}`);
    checks.that(
      privRows.every((r) => r.actor === 'admin' && r.createdAt >= RUN_START_MS),
      '④ 私钥行全部 actor=admin 且落在本 run 窗口（from 过滤生效）',
    );
    const redactedOf = (v: unknown): { redacted?: unknown; fingerprint?: unknown } | null =>
      v !== null && typeof v === 'object' ? (v as { redacted?: unknown; fingerprint?: unknown }) : null;
    checks.that(
      privRows.every((r) => {
        const ser = `${JSON.stringify(r.oldValue)}|${JSON.stringify(r.newValue)}`;
        return !ser.includes(privateKeyNeedle);
      }),
      `④ 私钥行 old/new **序列化串不含** base64 私钥子串（needle=${privateKeyNeedle.slice(0, 8)}…）`,
    );
    const setPrivRows = privRows.filter((r) => r.newValue !== null);
    checks.eq(setPrivRows.length, 4, `④ 私钥 set 行恰 4（②×2 + ③×2）—— 实际 ${setPrivRows.length}`);
    checks.that(
      setPrivRows.every((r) => {
        const nv = redactedOf(r.newValue);
        return nv?.redacted === true && typeof nv.fingerprint === 'string' && /^[0-9a-f]{12}$/.test(nv.fingerprint);
      }),
      `④ 私钥 set 行 new 值全为 {"redacted":true,"fingerprint":12hex} 对象 —— 实际 ${JSON.stringify(setPrivRows.map((r) => r.newValue))}`,
    );
    checks.that(
      setPrivRows.some((r) => JSON.stringify(r.newValue).includes('{"redacted":true')),
      '④ 序列化串含 {"redacted":true（§3.1 ⚙️17 逐字形态）',
    );
    checks.that(
      privRows.every((r) => {
        const ov = redactedOf(r.oldValue);
        return r.oldValue === null || ov?.redacted === true;
      }),
      '④ 私钥行 old 值或为 null（无旧行）或为 redacted 对象（旧密文不出原文）',
    );
    const clearPrivRows = privRows.filter((r) => r.newValue === null);
    checks.eq(clearPrivRows.length, 1, `④ 私钥清空行恰 1 —— 实际 ${clearPrivRows.length}`);

    const changesGw = await getJson<{ rows: Array<{ key: string; oldValue: unknown; newValue: unknown; actor: string }> }>(
      `/api/admin/config/changes?key=${encodeURIComponent('pay.channel.gatewayUrl')}&from=${RUN_START_MS}&limit=100`,
      adminToken,
    );
    expectHttp(checks, changesGw, 200, ErrCode.OK, '④ 非密键读口（gatewayUrl 本 run 窗口）');
    const gwRows = changesGw.body?.data?.rows ?? [];
    checks.eq(gwRows.length, 1, `④ gatewayUrl 本 run 恰 1 行（③ 的同值幂等写）—— 实际 ${gwRows.length}`);
    checks.that(
      gwRows[0]?.newValue === SEED_GATEWAY && gwRows[0]?.oldValue === SEED_GATEWAY && gwRows[0]?.actor === 'admin',
      `④ 非密键行落**原文**（old==new==种子值，非 redacted 对象）—— 实际 ${JSON.stringify(gwRows[0])}`,
    );

    const changesApp = await getJson<{ rows: Array<{ key: string; oldValue: unknown; newValue: unknown }> }>(
      `/api/admin/config/changes?key=${encodeURIComponent('pay.channel.appId')}&from=${RUN_START_MS}&limit=100`,
      adminToken,
    );
    const appRows = changesApp.body?.data?.rows ?? [];
    checks.eq(appRows.length, 4, `④ appId 本 run 恰 4 行（① 两轮删/配）—— 实际 ${appRows.length}`);
    checks.that(
      appRows.filter((r) => r.newValue === TEST_APP_ID).length === 2 && appRows.filter((r) => r.newValue === null).length === 2,
      `④ appId 行 = 两条原文 JSON 串 + 两条清空（null）—— 实际 ${JSON.stringify(appRows.map((r) => r.newValue))}`,
    );

    // SQL 直查（四钉：全表无 needle / 清空 JSON_TYPE='NULL' / new_value 绝无 SQL NULL / 首写 old=SQL NULL）。
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM config_changes WHERE old_value LIKE '%${privateKeyNeedle}%' OR new_value LIKE '%${privateKeyNeedle}%'`),
      '0',
      '④ SQL 全表（含历史行）old/new 原文无 base64 私钥子串',
    );
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM config_changes WHERE \\\`key\\\`='pay.channel.privateKey' AND JSON_TYPE(new_value)='NULL' AND created_at >= FROM_UNIXTIME(${RUN_START_SEC})`),
      '1',
      `④ SQL 清空行 JSON_TYPE(new_value)='NULL'（JSON 串的 'null'——⚠️ 不是 SQL NULL，写 IS NULL 会错红）`,
    );
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM config_changes WHERE \\\`key\\\`='pay.channel.privateKey' AND new_value IS NULL AND created_at >= FROM_UNIXTIME(${RUN_START_SEC})`),
      '0',
      '④ SQL new_value 列**绝无** SQL NULL（清空走 JSON \'null\'，两列形态不混用）',
    );
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM config_changes WHERE \\\`key\\\`='pay.channel.appId' AND old_value IS NULL AND created_at >= FROM_UNIXTIME(${RUN_START_SEC})`),
      '2',
      '④ SQL 首写（删后回配）行 old_value = SQL NULL（⚙️17①；两条 = ① 两轮各一）',
    );
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM config_changes WHERE \\\`key\\\`='pay.channel.privateKey' AND new_value LIKE '%"redacted"%' AND created_at >= FROM_UNIXTIME(${RUN_START_SEC})`),
      '4',
      '④ SQL 原文层：私钥 set 行 new_value 文本含 "redacted"（4 行）',
    );

    /* ── ⑤ 不进广播 + 通道专用性 ─────────────────────────────────────────── */
    step('⑤ 不进广播：config.snapshot 无 pay.channel 子串（65 键在）· payment env 六项退役 · RPC 错/对令牌正负例');
    const snap = await rpcCall<{ config: Record<string, unknown>; version: number }>(CONFIG_RPC, RPC_PATTERNS.configSnapshot, {}, 3_000);
    const snapSer = JSON.stringify(snap);
    checks.that(snap.ok === true && !snapSer.includes('pay.channel'), `⑤ config.snapshot ok:true 且响应串**无** pay.channel 子串 —— ok=${snap.ok}`);
    checks.eq(
      Object.keys(snap.ok ? snap.data.config : {}).length,
      CONFIG_KEYS.length,
      `⑤ snapshot 恰 ${CONFIG_KEYS.length} 键（负断言非空转：快照真实在场且完整）`,
    );

    const payEnv = containerEnv('ftl-payment-service');
    for (const name of RETIRED_CHANNEL_ENVS) {
      const hits = payEnv.filter((e) => e.startsWith(`${name}=`));
      checks.eq(hits.length, 0, `⑤ payment-service 容器 env 无 ${name}（渠道凭据已管理化，env 出现即回流）—— 实际 ${JSON.stringify(hits)}`);
    }

    const rpcBad = await rpcCall(CONFIG_RPC, RPC_PATTERNS.configPayChannelGet, { pullToken: `wrong-${TAG}` }, 4_000);
    checks.that(
      !rpcBad.ok && rpcBad.code === ErrCode.UNAUTHENTICATED,
      `⑤ RPC 错令牌 ⇒ ok:false / 10002 —— 实际 ${JSON.stringify(rpcBad)}`,
    );
    checks.that(
      !rpcBad.ok && rpcBad.message === '拉取令牌不匹配',
      `⑤ 错令牌文案逐字且不含令牌内容 —— 实际 ${JSON.stringify(!rpcBad.ok ? rpcBad.message : '（竟然 ok）')}`,
    );
    checks.that(pullToken().length > 0, '⑤ 正确令牌在场（runner 供给链 §5.4 T-1 的自证；缺 ⇒ 下一断言会红在错误归因上）');
    const rpcGood = await rpcCall<{ values: Record<string, string> }>(CONFIG_RPC, RPC_PATTERNS.configPayChannelGet, { pullToken: pullToken() }, 4_000);
    checks.that(rpcGood.ok === true, `⑤ RPC 对令牌 ⇒ ok:true（正对照）—— 实际 ${JSON.stringify(rpcGood.ok ? { ok: true } : rpcGood)}`);
    const rpcValues = rpcGood.ok ? rpcGood.data.values : {};
    checks.eq(Object.keys(rpcValues).sort().join(','), [...CHANNEL_KEY_ORDER].sort().join(','), '⑤ 拉取值含恰六键');
    checks.eq(rpcValues['pay.channel.privateKey'], appPrivatePemB64, '⑤ 私钥拉取值 = base64(PEM) 种子（读侧零改格式）');
    checks.eq(rpcValues['pay.channel.gatewayUrl'], SEED_GATEWAY, '⑤ 网关拉取值 = 种子');

    /* ── ⑥ 静态加密 ─────────────────────────────────────────────────────── */
    step('⑥ 静态加密：value_enc 前缀 v1: · 全表无 base64 私钥子串');
    checks.eq(
      mysqlScalar(`SELECT LEFT(value_enc,3) FROM pay_channel_config WHERE \\\`key\\\`='pay.channel.privateKey'`),
      'v1:',
      "⑥ 私钥列存储值前缀 'v1:'（AES-256-GCM 信封）",
    );
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM pay_channel_config WHERE value_enc LIKE '%${privateKeyNeedle}%'`),
      '0',
      '⑥ pay_channel_config 全表 value_enc 无 base64 私钥子串（静态加密在）',
    );

    /* ── ⑦ 日志无密钥 ───────────────────────────────────────────────────── */
    step('⑦ 日志无密钥：payment+config 两容器窗口零命中（base64 私钥子串 / pullToken）+ 判别力自证 + 正向对照行');
    const needles = [privateKeyNeedle, pullToken()].filter((n) => n.length > 0);
    // 判别力自证：**同一 grep 逻辑**喂合成行必命中（两个 needle 各自命中一次）。
    const synthetic = `synthetic-probe-needle-a ${privateKeyNeedle} b ${pullToken()} synthetic-${TAG}`;
    checks.eq(grepHits(synthetic, needles).length, needles.length, `⑦ 判别力自证：合成行喂同一 grep 逻辑 ⇒ ${needles.length} 个 needle 全命中（grep 有牙）`);
    const logWindowSec = Math.ceil((Date.now() - RUN_START_MS) / 1000) + 2;
    const payLogs = composeLogs('payment-service', logWindowSec);
    const cfgLogs = composeLogs('config-service', logWindowSec);
    checks.that(
      payLogs.includes('alipay wap_pay failed'),
      '⑦ 窗口正向对照：payment 日志窗口含 ② 的出站失败行（证明窗口真的读到了本 run 的日志，grep 非空转）',
    );
    checks.eq(grepHits(payLogs, needles).length, 0, `⑦ payment-service 日志窗口（自切片起点 ${logWindowSec}s）零命中 base64 私钥子串与 pullToken`);
    checks.eq(grepHits(cfgLogs, needles).length, 0, '⑦ config-service 日志窗口零命中 base64 私钥子串与 pullToken');

    /* ── ⑧ 权限矩阵（E′）+ 变体矩阵 ──────────────────────────────────────── */
    step('⑧ 权限矩阵（E′）+ 变体：非 SA × {字面,%2E,%4B,混合大小写} × {PUT,DELETE} ⇒ 403 · SA 变体 ⇒ 200 · %2F/裸/尾斜杠 403 · GET 任意角色 200 · 近邻 400');
    const oneTimePw = `s22-${TAG}-passw0rd`;
    const accounts: Array<{ role: 'operator' | 'finance' | 'viewer'; username: string }> = [
      { role: 'operator', username: `s22o-${TAG}` },
      { role: 'finance', username: `s22f-${TAG}` },
      { role: 'viewer', username: `s22v-${TAG}` },
    ];
    const tokens: Record<string, string> = {};
    for (const a of accounts) {
      const cre = await postJson<{ id: number }>('/api/admin/accounts', { username: a.username, password: oneTimePw, role: a.role }, adminToken);
      expectHttp(checks, cre, 200, ErrCode.OK, `⑧ 建一次性 ${a.role} 账号`);
      probeAccounts.push({ id: cre.body?.data?.id ?? -1, username: a.username });
      tokens[a.role] = await loginAdminAs(a.username, oneTimePw);
      checks.that(tokens[a.role].length > 0, `⑧ ${a.role} 登录成功（读面正对照的凭据）`);
    }

    const everyToken: Array<{ label: string; token: string }> = [
      { label: 'super_admin', token: adminToken },
      { label: 'operator', token: tokens.operator ?? '' },
      { label: 'finance', token: tokens.finance ?? '' },
      { label: 'viewer', token: tokens.viewer ?? '' },
    ];
    for (const t of everyToken) {
      const g = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(t.token);
      checks.eq(g.status, 200, `⑧ GET /api/admin/pay-channel（${t.label}）⇒ 200（读面任意已认证角色）`);
      checks.eq(g.body?.data?.keys?.length, 6, `⑧ GET（${t.label}）六项在`);
    }

    // 非 SA × 两方法 × 四变体 ⇒ 全 403（策略层先于一切；B1 攻击链闭合面）。
    const variantPaths: Array<{ label: string; path: string }> = [
      { label: '字面', path: '/api/admin/pay-channel/pay.channel.gatewayUrl' },
      { label: '键段 %2E', path: '/api/admin/pay-channel/pay%2Echannel%2EgatewayUrl' },
      { label: '键段 %4B', path: '/api/admin/pay-channel/pay.channel.private%4Bey' },
      { label: '混合大小写前缀', path: '/API/ADMIN/PAY-CHANNEL/pay.channel.gatewayUrl' },
    ];
    const nonSaCodes: Array<number | undefined> = [];
    for (const role of ['operator', 'finance', 'viewer'] as const) {
      for (const method of ['PUT', 'DELETE'] as const) {
        for (const v of variantPaths) {
          const r = await sendRaw(method, v.path, tokens[role], method === 'PUT' ? { value: 'http://localhost:1' } : undefined);
          checks.eq(r.status, 403, `⑧ ${role} ${method} ${v.label} ⇒ 403（E′ 写面仅 super_admin；policy 匹配未解码原值路径）`);
          nonSaCodes.push(r.body?.code);
        }
      }
    }
    checks.that(
      nonSaCodes.every((c) => c === ErrCode.FORBIDDEN),
      `⑧ 非 SA 24 格全为 10003（FORBIDDEN）—— 实际码集 ${JSON.stringify([...new Set(nonSaCodes)])}`,
    );

    // SA 正格：字面/键段变体 ⇒ 200（临时值改完 PUT 回种子）。
    clearAdminWriteBucket(adminToken);
    const saPut1 = await sendRaw('PUT', '/api/admin/pay-channel/pay.channel.gatewayUrl', adminToken, { value: TEMP_GATEWAY_URL });
    checks.that(saPut1.status === 200 && saPut1.body?.data?.saved === true, `⑧ SA PUT 字面 ⇒ 200 saved:true —— 实际 HTTP ${saPut1.status} ${JSON.stringify(saPut1.body)}`);
    const saGet1 = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    checks.eq(saGet1.body?.data?.keys?.find((k) => k.key === 'pay.channel.gatewayUrl')?.value, TEMP_GATEWAY_URL, '⑧ SA 写已落（读口回临时值——写真的发生过，防「200 假绿」）');

    const saPut2 = await sendRaw('PUT', '/api/admin/pay-channel/pay%2Echannel%2EgatewayUrl', adminToken, { value: TEMP_GATEWAY_URL });
    checks.that(saPut2.status === 200 && saPut2.body?.data?.saved === true, `⑧ SA PUT 键段 %2E ⇒ 200（编码变体命中前缀规则）—— 实际 HTTP ${saPut2.status} ${JSON.stringify(saPut2.body)}`);
    const saPut3 = await sendRaw('PUT', '/api/admin/pay-channel/pay.channel.public%4Bey', adminToken, { value: alipayPublicB64 });
    checks.that(saPut3.status === 200 && saPut3.body?.data?.saved === true, `⑧ SA PUT 键段 %4B（publicKey 种子值重写）⇒ 200 —— 实际 HTTP ${saPut3.status} ${JSON.stringify(saPut3.body)}`);
    checks.eq(saPut3.body?.data?.fingerprint, FP_PUBLIC_SEED, '⑧ %4B 变体解码后键正确（指纹 = 公钥种子指纹；零状态变化）');
    const saPut4 = await sendRaw('PUT', '/API/ADMIN/PAY-CHANNEL/pay.channel.gatewayUrl', adminToken, { value: TEMP_GATEWAY_URL });
    checks.that(saPut4.status === 200 && saPut4.body?.data?.saved === true, `⑧ SA PUT 混合大小写前缀 ⇒ 200（policy 折叠命中）—— 实际 HTTP ${saPut4.status} ${JSON.stringify(saPut4.body)}`);

    const saDel = await sendRaw('DELETE', '/api/admin/pay-channel/pay.channel.gatewayUrl', adminToken);
    checks.that(saDel.status === 200 && saDel.body?.data?.saved === true, `⑧ SA DELETE 字面 ⇒ 200 saved:true —— 实际 HTTP ${saDel.status} ${JSON.stringify(saDel.body)}`);
    const saGet2 = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    checks.eq(saGet2.body?.data?.keys?.find((k) => k.key === 'pay.channel.gatewayUrl')?.configured, false, '⑧ SA 删除已生效（读口 configured:false）');
    const saBack = await adminPayChannelPut('pay.channel.gatewayUrl', SEED_GATEWAY, adminToken);
    expectHttp(checks, saBack, 200, ErrCode.OK, '⑧ SA PUT 回种子（组内复原）');
    const saGet3 = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    const gwEntry = saGet3.body?.data?.keys?.find((k) => k.key === 'pay.channel.gatewayUrl');
    checks.that(
      gwEntry?.configured === true && gwEntry?.value === SEED_GATEWAY && gwEntry?.fingerprint === fpOf(SEED_GATEWAY),
      `⑧ 复原自证：gatewayUrl 回种子值/指纹 —— 实际 ${JSON.stringify(gwEntry)}`,
    );

    // fail-closed 面（含 SA）：%2F 前缀段 / 裸路径 / 尾斜杠 ⇒ 403。
    const pct2fSaPut = await sendRaw('PUT', '/api/admin/pay-channel%2Fpay.channel.gatewayUrl', adminToken, { value: 'http://localhost:1' });
    checks.eq(pct2fSaPut.status, 403, '⑧ %2F 前缀段（SA PUT）⇒ 403（不中任何写规则 ⇒ P9 fail-closed）');
    checks.eq(pct2fSaPut.body?.code, ErrCode.FORBIDDEN, '⑧ %2F（SA）信封码 10003');
    const pct2fSaDel = await sendRaw('DELETE', '/api/admin/pay-channel%2Fpay.channel.gatewayUrl', adminToken);
    checks.eq(pct2fSaDel.status, 403, '⑧ %2F 前缀段（SA DELETE）⇒ 403');
    const pct2fOper = await sendRaw('PUT', '/api/admin/pay-channel%2Fpay.channel.gatewayUrl', tokens.operator ?? '', { value: 'http://localhost:1' });
    checks.eq(pct2fOper.status, 403, '⑧ %2F 前缀段（operator PUT）⇒ 403');
    const barePut = await sendRaw('PUT', '/api/admin/pay-channel', adminToken, { value: 'http://localhost:1' });
    checks.eq(barePut.status, 403, '⑧ 裸路径（SA PUT /api/admin/pay-channel）⇒ 403（前缀面带尾斜杠，不做通配）');
    const slashPut = await sendRaw('PUT', '/api/admin/pay-channel/', adminToken, { value: 'http://localhost:1' });
    checks.eq(slashPut.status, 403, '⑧ 尾斜杠归一后 = 裸路径（SA PUT /api/admin/pay-channel/）⇒ 403');

    // 近邻：PUT /api/admin/config/pay.channel.* 过 policy（P4）但被下游 parseConfigValue 判未知键 ⇒ 400。
    const neighborSa = await sendRaw('PUT', '/api/admin/config/pay.channel.privateKey', adminToken, { value: appPrivatePemB64 });
    checks.eq(neighborSa.status, 400, '⑧ 近邻 SA PUT /api/admin/config/pay.channel.privateKey ⇒ 400（非 200/非 500）');
    checks.eq(neighborSa.body?.code, ErrCode.BAD_PARAM, '⑧ 近邻（SA）信封码 10001（未知键）');
    const neighborOper = await sendRaw('PUT', '/api/admin/config/pay.channel.privateKey', tokens.operator ?? '', { value: appPrivatePemB64 });
    checks.eq(neighborOper.status, 400, '⑧ 近邻 operator PUT 同路径 ⇒ 400（P4 放行到下游、未知键 400 拦截）');
    checks.eq(neighborOper.body?.code, ErrCode.BAD_PARAM, '⑧ 近邻（operator）信封码 10001');
    const afterNeighbor = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    checks.eq(
      afterNeighbor.body?.data?.keys?.find((k) => k.key === 'pay.channel.privateKey')?.fingerprint,
      FP_PRIVATE_A,
      '⑧ 近邻写口**碰不到** pay_channel_config（私钥指纹仍为 A——新表只此一条写路）',
    );

    // 一次性账号停用（只停用不删；照 slice-19）。
    for (const a of probeAccounts) {
      const dis = await sendRaw('PATCH', `/api/admin/accounts/${a.id}`, adminToken, { status: 'disabled' });
      checks.eq(dis.status, 200, `⑧ 收尾：停用一次性 ${a.username} ⇒ 200`);
    }
    const accList = await getJson<{ accounts: Array<{ username: string; status: string }> }>('/api/admin/accounts', adminToken);
    const stillActive = (accList.body?.data?.accounts ?? []).filter(
      (x) => probeAccounts.some((a) => a.username === x.username) && x.status === 'active',
    );
    checks.that(stillActive.length === 0, `⑧ 收尾：三枚一次性账号均已 disabled（不留活跃凭据）—— 实际残留 ${JSON.stringify(stillActive)}`);

    /* ── ⑨ 主钥 fail-closed（冷启四件套）────────────────────────────────── */
    step('⑨ 主钥 fail-closed：空构造重建两服务（冷 payment）⇒ GET/PUT 503 · 下单 15001 · 65 键面 200 ⇒ 存钥重建 ⇒ 下单复绿');
    checks.that(pullToken().length > 0, '⑨ 前置：拉取令牌照常在场（否则窗口步「令牌也空」会侥幸同结果，判据证不到「主钥缺失」这一因）');
    const cfgEnvBefore = containerEnv('ftl-config-service');
    encKeySaved = pickEnv(cfgEnvBefore, 'PAY_CONFIG_ENC_KEY');
    checks.that(encKeySaved.length > 0, `⑨ 现容器 PAY_CONFIG_ENC_KEY 非空（栈脚本/run.ts 供给链在场；实际长度 ${encKeySaved.length}）`);
    // 重建**保真面**（引导口令：栈脚本 export、compose 空默认 ⇒ 不经 runner env）——pick 现容器，
    // 四次重建（窗口/恢复 × config/payment）全随行透传；下方 after-recreate 等值断言 = 保真自证。
    // （节奏两键已随换源退役（T15）：值由 config 面供给 ⇒ 窗口/恢复侧改「重建后启动行自证」。）
    adminPwSaved = pickEnv(cfgEnvBefore, 'ADMIN_PASSWORD');
    info(`⑨ 重建透传面：ADMIN_PASSWORD=${adminPwSaved.length > 0 ? '<非空>' : JSON.stringify('')}`);

    // 窗口：空主钥重建 config-service（先等它 healthy，再冷 payment——错序会让 payment
    // 启动快照拉取落空，把 15008 混进 15001 的判据窗口）。
    windowOpen = true;
    const win1 = compose({ PAY_CONFIG_ENC_KEY: '', ADMIN_PASSWORD: adminPwSaved }, 'up', '-d', '--force-recreate', 'config-service');
    checks.eq(win1.code, 0, `⑨ 窗口① 以 PAY_CONFIG_ENC_KEY=（空）重建 config-service —— 输出尾部：${tailOut(win1.out)}`);
    const win1h = await waitContainerHealthy('ftl-config-service');
    checks.that(win1h.ok, `⑨ 窗口① config-service healthy —— ${win1h.last}`);
    checks.eq(pickEnv(containerEnv('ftl-config-service'), 'ADMIN_PASSWORD'), adminPwSaved, '⑨ 窗口① 保真：ADMIN_PASSWORD 随行透传（栈注入态不丢）');
    const win2T0 = Date.now();
    const win2 = compose({ PAY_CONFIG_ENC_KEY: '' }, 'up', '-d', '--no-deps', '--force-recreate', 'payment-service');
    checks.eq(win2.code, 0, `⑨ 窗口② 冷启 payment-service（lastGood 不可能借暖——回落面已清）—— 输出尾部：${tailOut(win2.out)}`);
    const win2h = await waitContainerHealthy('ftl-payment-service');
    checks.that(win2h.ok, `⑨ 窗口② payment-service healthy —— ${win2h.last}`);
    // 换源自证（T15）：节奏两键的值不再经宿主 env 透传，改由 config 面供给 —— 重建后的**启动行**
    // 即「解析值 = 配置值」的观测物（config 值不受容器重建影响；ts 时间锚 = 只认本次重建后产生的
    // 行，防 no-op 重建吃陈旧行——Global #0/T14 ⓪ 先例）。
    const win2Boot = await pollUntil(
      () =>
        ndjson('payment-service', 600).filter(
          (r) =>
            String(r.msg).includes('first round in 2000ms') &&
            Number.isFinite(Date.parse(String(r.ts))) &&
            Date.parse(String(r.ts)) >= win2T0,
        ).length,
      (n) => n > 0,
      30_000,
    );
    checks.that(win2Boot.ok, '⑨ 窗口② 重建后启动行 `first round in 2000ms`（config 值不受容器重建影响；连跑 slice-21 ⓪ 的判据对象）');
    const win2BootR = await pollUntil(
      () =>
        ndjson('payment-service', 600).filter(
          (r) =>
            String(r.msg).includes('interval 2000ms') &&
            Number.isFinite(Date.parse(String(r.ts))) &&
            Date.parse(String(r.ts)) >= win2T0,
        ).length,
      (n) => n > 0,
      30_000,
    );
    checks.that(win2BootR.ok, '⑨ 窗口② 日自检链启动行 `interval 2000ms`（双链同证）');
    checks.eq(pickEnv(containerEnv('ftl-config-service'), 'PAY_CONFIG_ENC_KEY'), '', '⑨ 窗口实证：容器 env 的 PAY_CONFIG_ENC_KEY 是空串（空构造真的落地了）');

    const wGet = await adminPayChannelGet(adminToken);
    checks.eq(wGet.status, 503, '⑨ 窗口：GET /api/admin/pay-channel ⇒ 503（渠道块整体 fail-closed）');
    checks.that(
      wGet.body?.code === ErrCode.UPSTREAM_UNAVAILABLE && wGet.body?.message === '渠道密钥存储未启用（缺主钥）',
      `⑨ 窗口：GET 503 信封 = 10007 + ⚙️18 逐字文案 —— 实际 ${JSON.stringify(wGet.body)}`,
    );
    const wPut = await adminPayChannelPut('pay.channel.gatewayUrl', WINDOW_LEGAL_URL, adminToken);
    checks.eq(wPut.status, 503, '⑨ 窗口：PUT（**合法值**——§3.5 观测序 400 先于 503）⇒ 503');
    checks.that(
      wPut.body?.code === ErrCode.UPSTREAM_UNAVAILABLE && wPut.body?.message === '渠道密钥存储未启用（缺主钥）',
      `⑨ 窗口：PUT 503 信封逐字 —— 实际 ${JSON.stringify(wPut.body)}`,
    );
    const uK = await registerUser(43);
    const wOrder = await orderUntilCode(uK, 30, ErrCode.PAY_CHANNEL_ERROR, 30_000, '⑨ 窗口步下单', [ErrCode.PAY_DISABLED]);
    expectHttp(checks, wOrder, 502, ErrCode.PAY_CHANNEL_ERROR, '⑨ 窗口步：下单必败 ⇒ 15001（冷 payment，无回落可借）');
    const wCfg = await adminGetConfig<{ config: Record<string, unknown> }>(adminToken);
    expectHttp(checks, wCfg, 200, ErrCode.OK, '⑨ 窗口：GET /api/admin/config ⇒ 200（其它面不受影响）');
    checks.eq(Object.keys(wCfg.body?.data?.config ?? {}).length, CONFIG_KEYS.length, `⑨ 窗口：${CONFIG_KEYS.length} 键面完整（懒校验，渠道块故障不外溢）`);

    // 恢复：用存下的钥重建两服务（payment 再冷一次）⇒ 复绿 = 新鲜拉取强证。
    const rec1 = compose({ PAY_CONFIG_ENC_KEY: encKeySaved, ADMIN_PASSWORD: adminPwSaved }, 'up', '-d', '--force-recreate', 'config-service');
    checks.eq(rec1.code, 0, `⑨ 恢复① 以存钥重建 config-service —— 输出尾部：${tailOut(rec1.out)}`);
    const rec1h = await waitContainerHealthy('ftl-config-service');
    checks.that(rec1h.ok, `⑨ 恢复① config-service healthy —— ${rec1h.last}`);
    checks.eq(pickEnv(containerEnv('ftl-config-service'), 'PAY_CONFIG_ENC_KEY'), encKeySaved, '⑨ 恢复实证：容器 env 主钥 = 存下的值');
    const recGet = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    checks.that(
      recGet.status === 200 && recGet.body?.data?.keys?.every((k) => k.configured === true) === true &&
        recGet.body?.data?.keys?.find((k) => k.key === 'pay.channel.privateKey')?.fingerprint === FP_PRIVATE_A,
      `⑨ 恢复：GET 200 且六项 configured、私钥指纹仍为 A（窗口步零写入副作用）—— 实际 HTTP ${recGet.status}`,
    );
    const rec2T0 = Date.now();
    const rec2 = compose({ PAY_CONFIG_ENC_KEY: encKeySaved }, 'up', '-d', '--no-deps', '--force-recreate', 'payment-service');
    checks.eq(rec2.code, 0, `⑨ 恢复② 再冷 payment-service（又无回落可借——复绿必为新鲜拉取）—— 输出尾部：${tailOut(rec2.out)}`);
    const rec2h = await waitContainerHealthy('ftl-payment-service');
    checks.that(rec2h.ok, `⑨ 恢复② payment-service healthy —— ${rec2h.last}`);
    const rec2Boot = await pollUntil(
      () =>
        ndjson('payment-service', 600).filter(
          (r) =>
            String(r.msg).includes('first round in 2000ms') &&
            Number.isFinite(Date.parse(String(r.ts))) &&
            Date.parse(String(r.ts)) >= rec2T0,
        ).length,
      (n) => n > 0,
      30_000,
    );
    checks.that(rec2Boot.ok, '⑨ 恢复② 重建后启动行 `first round in 2000ms`（连跑 slice-21 的前置）');
    windowOpen = false;
    const recOrder = await orderUntilCode(uK, 30, ErrCode.OK, 60_000, '⑨ 恢复后复绿下单', [ErrCode.PAY_DISABLED, ErrCode.PAY_CHANNEL_ERROR]);
    expectHttp(checks, recOrder, 200, ErrCode.OK, '⑨ 复绿：下单 200（空窗后即恢复；冷 payment ⇒ 新鲜拉取强证）');
    {
      const recNo = recOrder.body?.data?.orderNo ?? '';
      const walk9 = await browserWalkBridge(recOrder.body?.data?.payUrl ?? '');
      checks.eq(walk9.pageStatus, 200, '⑨ 复绿单桥接页 200');
      checks.eq(walk9.wapReply.alipay_trade_wap_pay_response?.code, '10000', '⑨ 复绿单浏览器 POST ⇒ stub 10000');
      checks.eq(stubState().orders[recNo]?.wapPayVerified, true, '⑨ 复绿单 stub 验签通过（整图逐键正确）');
      checks.that(verifyAppRequestSignature(walk9.formBody, appPublicPemA), '⑨ 复绿单桥接表单对 A 公钥成立');
    }

    /* ── ⑩ 回落 ─────────────────────────────────────────────────────────── */
    step('⑩ 回落：停 config-service ⇒ 下单照常 200（上次成功值）+ 回落 WARN 逐字；恢复 config-service');
    const uFall = await registerUser(44);
    const warmFall = await orderUntilCode(uFall, 68, ErrCode.OK, 30_000, '⑩ 前置：拉过一次（lastGood 暖）', [ErrCode.PAY_DISABLED]);
    expectHttp(checks, warmFall, 200, ErrCode.OK, '⑩ 前置：config-service 在位时下单 200（并暖起 lastGood）');
    const warnMarkerMs = Date.now();
    const stopR = compose({}, 'stop', 'config-service');
    checks.eq(stopR.code, 0, `⑩ 停 config-service —— 输出尾部：${tailOut(stopR.out)}`);
    configStopped = true;
    clearUserBuckets(uFall.id);
    const fallRes = await postOrderGuarded(uFall, 128);
    expectHttp(checks, fallRes, 200, ErrCode.OK, '⑩ 停 config 后下单照常 200（回落 = 上次成功值整图）');
    {
      // 回落的是「上次成功值整图」⇒ 桥接页重签的浏览器表单仍被 stub（种子公钥 A）验过。
      const walk10 = await browserWalkBridge(fallRes.body?.data?.payUrl ?? '');
      checks.eq(walk10.pageStatus, 200, '⑩ 回落单桥接页 200（回落整图签得出有效表单）');
      checks.eq(walk10.wapReply.alipay_trade_wap_pay_response?.code, '10000', '⑩ 回落单浏览器 POST 仍被 stub 接受');
      checks.that(
        stubState().orders[fallRes.body?.data?.orderNo ?? '']?.wapPayVerified === true &&
          verifyAppRequestSignature(walk10.formBody, appPublicPemA),
        '⑩ 回落单桥接表单打到种子网关且 stub 验签通过、宿主复验对 A 公钥成立（回落的是整图，不是残图）',
      );
    }
    {
      let hit = false;
      const deadline = Date.now() + 20_000;
      for (;;) {
        const logs = composeLogs('payment-service', Math.ceil((Date.now() - warnMarkerMs) / 1000) + 2);
        if (logs.includes(FALLBACK_WARN_TEXT)) { hit = true; break; }
        if (Date.now() >= deadline) break;
        await sleep(1_000);
      }
      checks.that(hit, `⑩ payment-service 日志出现回落 WARN 逐字「${FALLBACK_WARN_TEXT}」（不含值——由文案构造保证）`);
    }
    const startR = compose({}, 'start', 'config-service');
    checks.eq(startR.code, 0, '⑩ 恢复：start config-service');
    configStopped = false;
    const startH = await waitContainerHealthy('ftl-config-service');
    checks.that(startH.ok, `⑩ config-service 恢复 healthy —— ${startH.last}`);
    const ctlFall = await orderUntilCode(uFall, 328, ErrCode.OK, 30_000, '⑩ 恢复后正对照下单', [ErrCode.PAY_DISABLED]);
    expectHttp(checks, ctlFall, 200, ErrCode.OK, '⑩ 恢复后正对照：下单 200（新鲜拉取链路照常）');

    /* ── 收尾（钉唯一形态：PUT 回六键种子，禁 DELETE；stub 公钥恢复 A；开关归 false）──── */
    step('收尾：六键逐个 PUT 回种子值（禁 DELETE）· stub 公钥恢复 A · 开关归 false');
    clearAdminWriteBucket(adminToken);
    for (const key of CHANNEL_KEY_ORDER) {
      const put = await adminPayChannelPut(key, SEED_VALUES[key], adminToken);
      checks.eq(put.body?.code, ErrCode.OK, `收尾 PUT ${key} ⇒ code 0`);
      checks.eq(put.body?.data?.saved, true, `收尾 PUT ${key} ⇒ {saved:true}`);
    }
    const finalGet = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    checks.that(
      finalGet.body?.data?.keys?.length === 6 &&
        finalGet.body?.data?.keys?.every((k) => k.configured === true) &&
        finalGet.body?.data?.keys?.find((k) => k.key === 'pay.channel.privateKey')?.fingerprint === FP_PRIVATE_A &&
        finalGet.body?.data?.keys?.find((k) => k.key === 'pay.channel.appId')?.value === TEST_APP_ID &&
        finalGet.body?.data?.keys?.find((k) => k.key === 'pay.channel.gatewayUrl')?.value === SEED_GATEWAY,
      '收尾自证：六键 configured 且主要值/指纹 = 种子（下一轮/连跑 slice-21 的种子前置）',
    );
    const setAend = stubSetAppPublic(appPublicPemA);
    checks.that(setAend.ok === true && setAend.fingerprint === FP_STUB_A, `收尾：stub 公钥恢复 A（指纹 ${FP_STUB_A}）—— 实际 ${JSON.stringify(setAend)}`);
    const offEnd1 = await adminPutConfigFalse('pay.rechargeEnabled');
    checks.eq(offEnd1.body?.code, ErrCode.OK, '收尾：pay.rechargeEnabled 归 false');
    const offEnd2 = await adminPutConfigFalse('pay.withdrawEnabled');
    checks.eq(offEnd2.body?.code, ErrCode.OK, '收尾：pay.withdrawEnabled 归 false');
    wrappedUp = true;

    return checks;
  } finally {
    /* ── 兜底复原（异常路径也执行；每步吞异常——清理不许顶掉结论）────────────────── */
    try {
      if (configStopped) {
        compose({}, 'start', 'config-service');
        info('收尾兜底：config-service 已 start（⑩ 异常路径）');
      }
    } catch { /* 兜底 */ }
    try {
      if (windowOpen && encKeySaved.length > 0) {
        compose({ PAY_CONFIG_ENC_KEY: encKeySaved, ADMIN_PASSWORD: adminPwSaved }, 'up', '-d', '--force-recreate', 'config-service');
        await waitContainerHealthy('ftl-config-service', 60_000);
        compose({ PAY_CONFIG_ENC_KEY: encKeySaved }, 'up', '-d', '--no-deps', '--force-recreate', 'payment-service');
        await waitContainerHealthy('ftl-payment-service', 60_000);
        info('收尾兜底：⑨ 窗口中断 ⇒ 已用存钥重建 config/payment 两服务（口令随行透传）');
      }
    } catch { /* 兜底 */ }
    if (adminToken.length === 0) {
      try {
        adminToken = await adminLogin();
      } catch { /* 兜底 */ }
    }
    try {
      if (adminToken.length > 0 && !wrappedUp) {
        for (const key of CHANNEL_KEY_ORDER) {
          await adminPayChannelPut(key, SEED_VALUES[key], adminToken);
        }
        info('收尾兜底：六键种子已回填（异常路径）');
      }
    } catch { /* 兜底 */ }
    try {
      stubSetAppPublic(appPublicPemA);
    } catch { /* stub 不在 ⇒ 无 A 可复 */ }
    try {
      if (adminToken.length > 0) {
        for (const a of probeAccounts) {
          await sendRaw('PATCH', `/api/admin/accounts/${a.id}`, adminToken, { status: 'disabled' });
        }
      }
    } catch { /* 兜底 */ }
    try {
      if (adminToken.length > 0) {
        await adminPutConfigFalse('pay.rechargeEnabled');
        await adminPutConfigFalse('pay.withdrawEnabled');
        info('收尾兜底：pay 开关已复原 false');
      }
    } catch { /* 兜底 */ }
  }

  /* 本地小助手（只服务本函数；借闭包拿 adminToken）───────────────────────────── */

  function adminPutConfigFalse(key: string): Promise<HttpResult> {
    return adminPutConfig(key, false, adminToken);
  }
  function adminPutConfigTrue(key: string): Promise<HttpResult> {
    return adminPutConfig(key, true, adminToken);
  }
}

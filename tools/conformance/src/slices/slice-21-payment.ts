/**
 * conformance 用例：**支付片**（`slice-21-payment`；规格 §6.2 的 ①–⑱ **十八组** + ⓪ 起手态）。
 *
 * ─── 判据载体（真栈面）────────────────────────────────────────────────────────
 *  - 全链经**真栈**：玩家面走网关（`http://localhost:3000`）· 回调面**经门口**
 *    （`https://localhost:8443/pay/notify/alipay`，自签；顺带验收 Caddyfile 的
 *    `handle /pay/notify/*` handler）· 渠道面走 `ftl-alipay-stub`（8801，网内 DNS）。
 *  - stub 由 `conformance-stack.sh up` 起（⚙️14 逐字 + 第二只读挂载 `/keys`）；
 *    **不发布宿主端口** ⇒ 控制面（`/_control/*`）经 `docker exec … wget` 驱动
 *    （「控制面只对 docker 控制者开放」与「宿主绑挂仅限测试容器」同一条纪律）。
 *  - 扫描/日自检节奏（本片 ⚙️9 换源：两 env 注入面已退役）：**管理面种子基线**
 *    （`conformance-stack.sh up` 末尾六键种子段 ⇒ `pay.scanIntervalMs=2000` /
 *    `pay.reconcileIntervalMs=2000`）+ **切片内 PUT 注入**（⑬ 冻扫 600000 ↔ 还原 2000）——
 *    ⓪ 以「PUT 归一 2000 + 重建 + 启动行 `first round in 2000ms` 自证」守观测路径可执行
 *    （缺失/漂移 = 环境缺陷，**响亮红**，不静默慢跑）。**渠道六项 env 已退役**（T15 起；
 *    六值唯一来源 = 管理面「支付渠道」种子，
 *    `conformance-stack.sh up` 末尾 PUT ×6）：⓪ 以「env 无六项」负断言 + 管理面 GET（六项
 *    configured）双边守——一个判「旧路死」、一个判「新路活」。
 *
 * ─── 支付配置管理化片 T15 改造（2026-10-06；偏离登记）────────────────────────────
 *  - ⓪ 的「渠道六项 env 实读」四条正向判据**替换**为「env 无六项」负断言 ×6 + 「管理面种子
 *    生效」正断言组——**机制面替换，非判据消减**（旧注入面已被产品退役；同强度守点 = 负断言
 *    + 管理面读口）；`PAY_SCAN_*` 两断言**本片 T15 时**逐字保留（⚙️9 换源后已改「PUT + 重建 +
 *    启动行自证」）；appId/sellerId 值同源复查随种子读口保留
 *    （旧「两处同源」实质的机制面延续）。
 *  - ⑬ 重建 helper 的 env 透传面**收窄**：删五处 `ALIPAY_*` pick，只透传扫描两值（⚙️9 换源后
 *    两值通道一并退役——改 PUT + 启动行自证）；渠道凭据经管理面种子（不经 env）。
 *  - ③ `notify_url`/`return_url` 族断言值来源改种子（`pay.channel.publicBaseUrl` 字面与旧
 *    override 值逐字相同 ⇒ 断言串零改，仅来源标注更新）。
 *
 * ─── 十八组（规格 §6.2 逐组对位；组内断言尽量密）────────────────────────────────
 *  ①配置键种子 + 客户端键集 15 · ②开关关拒单（15008）· ③下单（payUrl=本站 wap.pay 桥接页：
 *  query 凭证探针 + 桥接页表单宿主复验 + docker exec 模拟浏览器 POST 由 stub 验签 +
 *  log_skip 守 token 不落 edge 日志 + 幂等复用）· ④回调正例 ⇒ 入账 ⇒ 余额/流水/锚/notify_log · ⑤伪造签名拒 +
 *  bad_sign · ⑥金额不符（amount_mismatch）· ⑦重放幂等 · ⑧并发双通知恰一次 · ⑨迟到回调重开
 *  （SQL 回填 expires_at 构造过期单）· ⑩过期关闭含 trade.close 已付分支（stub mark-paid ⇒
 *  close 报已付 ⇒ 重开）· ⑪提现全链（门槛/单笔/在途/审/确认；hold 流水逐字）· ⑫超时回滚
 *  （SQL 回拨 timeout_at；claim 互斥负例）· ⑬cap 场景组（§2.2.1 演算表①–⑤ + 15005 +
 *  跨面占位拒 + **fail-closed**（停 currency-service ⇒ 申请必拒 ⇒ 恢复））· ⑭退款全链
 *  （冻结→审→stub 退款→refunded；驳回回滚；15006 双负例；渠道失败停 approved）· ⑮权限矩阵
 *  + 审计第六源 + 两路 CSV 字节 · ⑯日自检（SQL 造孤儿锚 ⇒ `payment_reconcile_diff` 秒级
 *  变化 ⇒ 清脏回 0）· ⑰回调防护（405/415/413/429；429 前先自证 INCR 记账）· ⑱三族 `mine`
 *  真栈翻页（各造 21 行 ⇒ 两跳、零重叠、行集全等；cursor 严格读的真 SQL 面）。
 *
 * ─── 零 skip、零数据依赖分支（基线回填的前提）──────────────────────────────────
 *  全部断言在任何环境下都执行；数据驱动的行集一律聚合进单条断言。**本机读数已回填
 *  baselines.json，CI 权威轮复核/校正**（照近例口径）。
 *
 * ─── 副作用与复原（登记）────────────────────────────────────────────────────
 *  - 探针用户 `t21*` 全部 fresh 注册（phone 带时间戳，不撞既有）；money 动作全走真实代码
 *    路径（充值/提现/退款/入账），余额与行**留档为探针数据**（dev 栈先例；CI 每轮全新卷）。
 *  - 探针**合成行**（跨面占位 holding 两行、未入账单 SQL 关单、孤儿锚 op）用后即删/收敛归零。
 *  - `pay.rechargeEnabled`/`pay.withdrawEnabled` 起手归 false、中途置 true、**finally 兜底复原
 *    false**；`pay:notify:rate` 桶用后即删；本 run 命名空间的 `ratelimit:*` 桶在关键批量前清。
 *  - ⑬ 停 currency-service 的窗口 ≤ 一次 HTTP+启动等待；`finally` 兜底确保它回到运行态。
 *  - ⑭ 的「渠道失败」组会留一条 `approved`+后台退避的表（产品语义；12.6 分钟后退避自然穷尽，
 *    明确失败 ⇒ 不标 unknown、不重放）——**登记为有意残留**（人工面）。
 *
 * ─── 不变量：本片只读断言，不写生产数据 ───────────────────────────────────────
 *  以上全部写面都是**测试栈**的探针数据；对「生产密钥/生产数据」零接触。
 */
import { spawnSync } from 'node:child_process';
import { createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import type { PayCreateOrderResponse, PayOrderInfo } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  GATEWAY_URL,
  INTERNAL_TOKEN,
  adminGetConfig,
  adminLogin,
  adminPayChannelGet,
  adminPutConfig,
  getJson,
  postJson,
  registerUser,
  type Envelope,
  type HarnessUser,
} from '../lib/http';
import { redisLines } from '../lib/redis';
import { rpcCall, type RpcEndpoint } from '../lib/rpc';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-16/19）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');
/** 门口 HTTPS 口（通知投递路径；自签 ⇒ 每请求 rejectUnauthorized:false，照 slice-07.3）。 */
const EDGE_HTTPS_PORT = process.env.EDGE_HTTPS_PORT ?? '8443';
/** 栈的平台网络宿主名（stub 在网内；payment-service 经渠道网关基址 `pay.channel.gatewayUrl` 种子打它）。 */
const STUB_CONTAINER = 'ftl-alipay-stub';
/** 门口容器（Caddy；③ 验收桥接页 `log_skip` —— 能力 token 不得进 edge 访问日志）。 */
const EDGE_CONTAINER = 'ftl-edge';
/** `currency.apply`/`withdrawable` 的 TCP 监听（宿主直投 = compose override 的 `3104:3104`）。 */
const CURRENCY_RPC: RpcEndpoint = {
  host: process.env.CURRENCY_RPC_HOST ?? 'localhost',
  port: Number(process.env.CURRENCY_RPC_PORT ?? 3104),
};
/** 与 `conformance-stack.sh` 种子块 / `alipay-stub.mjs` 常量三处同源（不一致 ⇒ 组④ 当场红）；⓪ 以管理面种子读值复验同源。 */
const TEST_APP_ID = '9021000000000000';
const TEST_SELLER_ID = '2088721087500000';
/** 已退役的渠道六项 env（支付配置管理化片 T11/T15；⓪ 逐名扫 `containerEnv` 负断言——出现即回流）。 */
const RETIRED_CHANNEL_ENVS = ['ALIPAY_GATEWAY_URL', 'ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY', 'ALIPAY_SELLER_ID', 'PAY_PUBLIC_BASE_URL'] as const;
/** 通知投递路径（**经门口**——同时验收 Caddyfile 的 `handle /pay/notify/*`）。 */
const NOTIFY_PATH = '/pay/notify/alipay';
/** 本 run 的唯一后缀（用户名/单号/锚全带它；同栈连跑两轮不互撞）。 */
const TAG = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(-8);
/** 本 run 起始时刻（⑮ 的 `from` 过滤；脏卷上把上一轮的行挡在外面）。 */
const RUN_START_MS = Date.now();

/** 四 PEM 夹具（宿主侧读；与 stub 的 /keys 挂载同源 = T6 同一对测试密钥）。 */
const FIXTURES = join(REPO_ROOT, 'tools', 'conformance', 'fixtures', 'alipay-test');
const appPublicPem = readFileSync(join(FIXTURES, 'app-public.pem'), 'utf8');

/* ──────────────────────────────────────────────────────────────────────────
 * 本地助手（形态先例：slice-16/19/20）
 * ────────────────────────────────────────────────────────────────────────── */

interface DockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一条 `docker` 命令（带超时 + MSYS 防路径转写；照 slice-16）。 */
function docker(args: string[], timeoutMs = 60_000): DockerResult {
  const res = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

interface CommandResult {
  code: number;
  out: string;
}

/** `docker compose exec -T <service> …`（`-T` 不能省：无 TTY 环境缺它会挂住；照 slice-19）。 */
function exec(service: string, ...cmd: string[]): CommandResult {
  const r = spawnSync('docker', ['compose', 'exec', '-T', service, ...cmd], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function tailOut(out: string, lines = 3): string {
  return out.trim().split('\n').slice(-lines).join(' / ');
}

/* ── 容器日志（NDJSON）与有界轮询 —— ⓪/⑬ 启动行自证读口 ─────────────────────
 * 逐字照 slice-20 `:198`–`:241`（先例 = slice-12/15；本片 T14 换源时补入——原片内无此两件）。 */

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

/** MySQL 查询（`-N` = 不带列名表头；SQL 只许单引号字面量与数字，照 slice-14/19）。 */
function mysqlQuery(sql: string): CommandResult {
  return exec('mysql', 'sh', '-c', `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE" -N -e "${sql}"`);
}

/** SQL 读**末行文本**（剥 mysql 密码告警行；空 ⇒ 抛，不把空串装成值；照 slice-19）。 */
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

/** SQL 读全部行（每行按 TAB 拆列；空行/告警行剔除）。 */
function mysqlRows(sql: string): string[][] {
  const r = mysqlQuery(sql);
  if (r.code !== 0) throw new ConformanceError(`mysql 查询失败（exit ${r.code}）：${tailOut(r.out)}`);
  return r.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('mysql:'))
    .map((s) => s.split('\t'));
}

/** 有界轮询 SQL 读数直到满足谓词（失败 = 带末次读数抛；不算 skip）。 */
async function pollSql(sql: string, want: (v: string) => boolean, what: string, timeoutMs = 20_000, intervalMs = 1_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = mysqlScalar(sql);
    if (want(last)) return last;
    if (Date.now() >= deadline) {
      throw new ConformanceError(`${what}：${timeoutMs}ms 内未达期望（末次读数 ${JSON.stringify(last)}）`);
    }
    await sleep(intervalMs);
  }
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

/** 管理面 `GET /api/admin/pay-channel` 条目（片规格 §2.4 投影；只列本片经 `adminPayChannelGet` 读取的字段）。 */
interface PayChannelAdminEntry {
  key: string;
  secret: boolean;
  configured: boolean;
  value: string | null;
  fingerprint: string | null;
}

/** stub 控制面（`docker exec` + busybox wget；stub 无宿主端口——见文件头）。 */
function stubControl(pathAndQuery: string): string {
  const r = docker(['exec', STUB_CONTAINER, 'wget', '-qO-', `http://127.0.0.1:8801${pathAndQuery}`], 20_000);
  if (r.status !== 0) {
    throw new ConformanceError(`stub 控制面 ${pathAndQuery} 失败（exit ${r.status}）：${(r.stderr || r.stdout).slice(-300)}`);
  }
  return r.stdout;
}

interface StubOrderState {
  status: string;
  total_amount: string | null;
  trade_no: string;
  wapPayVerified: boolean;
  wapPayRequests: number;
  queryRequests: number;
  closeRequests: number;
  subject: string | null;
  notify_url: string | null;
  return_url: string | null;
  timeout_express: string | null;
  refundCalls: Record<string, number>;
  refunds: Array<{ out_request_no: string; amount: string }>;
}
interface StubState {
  keys: { appPublic: boolean; alipayPrivate: boolean };
  counters: Record<string, number>;
  failRefunds: string[];
  orders: Record<string, StubOrderState>;
}
function stubState(): StubState {
  return JSON.parse(stubControl('/_control/state')) as StubState;
}
/** 以渠道私钥签一条通知（控制面）——切片经门口投递。 */
function stubSignNotify(outTradeNo: string, totalAmount: string, tradeStatus = 'TRADE_SUCCESS'): { params: Record<string, string>; form: string } {
  const q = new URLSearchParams({ out_trade_no: outTradeNo, total_amount: totalAmount, trade_status: tradeStatus }).toString();
  return JSON.parse(stubControl(`/_control/sign-notify?${q}`)) as { params: Record<string, string>; form: string };
}

/* ── 门口（TLS 自签）请求 —— 通知投递路径 ─────────────────────────────────── */

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
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolveP({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function deliverNotify(form: string): Promise<{ status: number; body: string }> {
  return edgeRequest('POST', NOTIFY_PATH, form);
}

/** HTML 实体逆映射（桥接页 hidden inputs 解析用；&amp; 必须最后解，序错会二次破坏）。 */
function unescapeHtmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 从桥接页 HTML 抽出全部 hidden inputs（浏览器视角的表单事实）：
 * 服务端下发什么，「浏览器自动 POST 出去的」就是什么——不采信任何服务端侧中间态。
 */
function parseHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<input\s+type="hidden"\s+name="([^"]*)"\s+value="([^"]*)"\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out[unescapeHtmlAttr(m[1]!)] = unescapeHtmlAttr(m[2]!);
  }
  return out;
}

/**
 * 模拟「玩家浏览器执行桥接页自动表单」——在 stub 容器内 busybox wget POST
 * （stub 无宿主端口；数组直传 spawn，不经 shell，签名字节零壳层转义）。
 * 返回 stub 的 JSON 应答文本。
 */
function browserPostWapForm(formBody: string): string {
  const r = docker(
    ['exec', STUB_CONTAINER, 'wget', '-qO-', '--post-data', formBody, 'http://127.0.0.1:8801/gateway.do'],
    20_000,
  );
  if (r.status !== 0) {
    throw new ConformanceError(`浏览器模拟 POST stub 网关失败（exit ${r.status}）：${(r.stderr || r.stdout).slice(-300)}`);
  }
  return r.stdout;
}

/**
 * 宿主侧**独立复验**货我们的出站请求签名（⚙️6 出站口径；app-public.pem）——
 * 与 stub 的验签（方向 ①）互为对照：本条证明「桥接页表单里的签名字节**确实**对我们的
 * 私钥成立」，不依赖 stub 是否严格。
 */
function verifyAppRequestSignature(form: string): boolean {
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

/* ── payment-service `/metrics`（exec curl；Bearer = 栈内口令）────────────── */

/** Prom 文本解析（照 slice-16：剥注释；只支持双引号标签形态）。 */
function parseProm(text: string): Array<{ name: string; labels: Record<string, string>; value: number }> {
  const out: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const kv = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"(.*)"\s*$/.exec(part);
        if (kv) labels[kv[1]!] = kv[2]!.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    const value = Number(m[3]);
    out.push({ name: m[1]!, labels, value: Number.isFinite(value) ? value : NaN });
  }
  return out;
}
function seriesValue(text: string, name: string, want: Record<string, string>): number | null {
  for (const s of parseProm(text)) {
    if (s.name !== name) continue;
    if (Object.entries(want).every(([k, v]) => s.labels[k] === v)) return s.value;
  }
  return null;
}
function execCurl(container: string, port: number, path: string, token: string | null): { status: number; body: string } {
  const args = ['exec', container, 'curl', '-s', '-w', '\n__STATUS__%{http_code}'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push(`http://127.0.0.1:${port}${path}`);
  const out = docker(args, 30_000);
  const m = /__STATUS__(\d+)\s*$/.exec(out.stdout);
  return { status: m ? Number(m[1]) : 0, body: out.stdout.replace(/__STATUS__\d+\s*$/, '') };
}
function paymentMetrics(): string {
  return execCurl('ftl-payment-service', 9007, '/metrics', INTERNAL_TOKEN).body;
}
/** 读 `payment_notify_total{result}`（缺席 = 0）。 */
function notifyMetric(result: string): number {
  return seriesValue(paymentMetrics(), 'payment_notify_total', { result }) ?? 0;
}

/** 等容器 healthy（照 slice-19）。 */
async function waitContainerHealthy(container: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = docker(['inspect', container, '--format', '{{.State.Health.Status}}']);
    if (r.stdout.trim() === 'healthy') return true;
    if (Date.now() >= deadline) return false;
    await sleep(1_000);
  }
}

/**
 * ⚙️9 换源后的**真重建**段（⓪ 归一与 ⑬ 冻扫/还原共用）：`docker compose up -d --no-deps
 * --force-recreate <service>`（即原内联 rebuild 段的逐字形态，只删两扫描 env 透传面）。
 *
 * ⚠️ `--force-recreate` 不可省（T12 全场性实测）：env 退役后 compose 规格与原容器**逐字一致**
 * ⇒ 默认 `up -d` 是 no-op（容器 ID 不变、没有新启动行）；而启动行断言与短节奏观测都以
 * **真重启**（重读配置面）为前提。渠道拉取令牌 `PAY_CHANNEL_PULL_TOKEN`（compose `${VAR:-}`
 * 空默认透传行）由 run.ts 启动处 `??=` 供给、随 `...process.env` 透传（T14 单一供给点）——
 * 重建后拉取链照常。
 */
function composeWithRecreate(service: string): { code: number; out: string } {
  const r = spawnSync('docker', ['compose', 'up', '-d', '--no-deps', '--force-recreate', service], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 管理面 PUT `pay.scanIntervalMs`（`code===OK` 校验）→ GET **实值比较**确认 → 重建
 * payment-service（⑬ 冻扫/还原共用；不再经 env —— 观测路径由调用方以启动行自证承接）。
 *
 * 为什么 ⑬ 必须「冻结」扫描：`resolveHolding()`（循环④/⑥）会在一轮（2s）内把**任何**
 * `status='holding'` 行拿去重放 `withdraw:<no>`/`refund:<no>`——SQL 造的两条占位行（真栈无其它
 * 途径制造「未解析 holding」）会在「插入 → 负例断言 → 删除」的窗口里被扫描**抢先收敛**：轻则
 * 断言竞态，重则留下「ops 有锚、本地无行」的孤儿（还真扣钱）——本片 ⑯ 的日自检当场把它抓出来过
 * （登记在案）。冻扫 = PUT 600000（上界顶格合法）+ 重建 ⇒ 窗口内无扫描轮（启动行自证）。
 *
 * ⚠️ GET 比较是**实值形态**（读回值 ≠ 目标 ⇒ 抛）——不得写成恒 false 的空转检查（T14 新-2）。
 */
async function setScanIntervalAndRecreate(paymentMs: number, token: string): Promise<void> {
  const put = await adminPutConfig('pay.scanIntervalMs', paymentMs, token);
  if (put.body?.code !== ErrCode.OK) throw new ConformanceError(`PUT pay.scanIntervalMs=${paymentMs} 失败`);
  const got = await adminGetConfig<{ config: Record<string, { value: unknown }> }>(token); // 读口形态照 ① 的 adminGetConfig
  const gotValue = got.body?.data?.config?.['pay.scanIntervalMs']?.value;
  if (gotValue !== paymentMs) throw new ConformanceError(`GET 确认 pay.scanIntervalMs ≠ ${paymentMs}（实际 ${JSON.stringify(gotValue)}）`);
  const r = composeWithRecreate('payment-service');
  if (r.code !== 0) throw new ConformanceError(`⑬ 重建 payment-service 失败：${tailOut(r.out)}`);
}

/* ── 网关面小助手 ───────────────────────────────────────────────────────── */

function expectHttp(checks: Checks, res: { status: number; body: Envelope | null }, status: number, code: number, label: string): void {
  checks.eq(res.status, status, `${label} ⇒ HTTP ${status}`);
  checks.eq(res.body?.code, code, `${label} ⇒ code ${code}`);
}

/** 任意方法的网关请求（本片只用 PATCH——停用一次性账号；照 slice-19 的 `sendJson` 形态）。 */
async function sendPatch(path: string, body: unknown, token?: string): Promise<{ status: number; body: Envelope | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${GATEWAY_URL}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Envelope | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    parsed = { code: res.status, message: text };
  }
  return { status: res.status, body: parsed };
}

/** 清某个用户在本栈的限流桶（滑窗键；burst 前清——探针自证不比「上一发的余温」）。 */
function clearUserBuckets(userId: string): void {
  redisLines(['DEL', `ratelimit:http:${userId}`, `ratelimit:pay-order:${userId}`, `ratelimit:pay-sync:${userId}`, `ratelimit:pay-refund:${userId}`, `ratelimit:pay-withdraw:${userId}`]);
}
/** 清空**全部** IP 维桶（上一片的大 burst 会在 60s 窗口里波及本片起手；07.3 先例）。 */
function clearIpBuckets(): void {
  const keys = redisLines(['KEYS', 'ratelimit:http-ip:*']);
  if (keys.length > 0) redisLines(['DEL', ...keys]);
}

/* ── 玩家面业务助手 ─────────────────────────────────────────────────────── */

async function createOrder(user: HarnessUser, packageYuan: number): Promise<PayCreateOrderResponse> {
  const res = await postJson<PayCreateOrderResponse>('/api/pay/orders', { packageYuan }, user.accessToken);
  if (res.status !== 200 || res.body?.code !== ErrCode.OK || !res.body.data) {
    throw new ConformanceError(`下单 packageYuan=${packageYuan} 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

async function getOrder(user: HarnessUser, orderNo: string): Promise<{ status: number; body: Envelope<PayOrderInfo> | null }> {
  return getJson<PayOrderInfo>(`/api/pay/orders/${orderNo}`, user.accessToken);
}

async function walletSummary(user: HarnessUser): Promise<{ status: number; body: Envelope<{ balance: number; withdrawable: number; dailyWithdrawRemainingCoins: number }> | null }> {
  return getJson('/api/pay/wallet/summary', user.accessToken);
}

/** 下单 + stub 签通知 + 经门口投递 ⇒ 等待 `credited`（返回后调用方可继续断言）。 */
async function payAndCredit(user: HarnessUser, packageYuan: number, checks: Checks): Promise<string> {
  const o = await createOrder(user, packageYuan);
  const { form } = stubSignNotify(o.orderNo, `${packageYuan}.00`);
  const r = await deliverNotify(form);
  if (r.status !== 200 || r.body !== 'success') {
    throw new ConformanceError(`充值通知投递失败 order=${o.orderNo}：HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  await pollSql(
    `SELECT status FROM payment_orders WHERE order_no='${o.orderNo}'`,
    (v) => v === 'credited',
    `订单 ${o.orderNo} 入账`,
  );
  checks.ok(`（前置）订单 ${o.orderNo} 经通知入账（credited）`);
  return o.orderNo;
}

/** 直接给某用户造余额/场景（真 TCP RPC `currency.apply`；来源按场景给）。 */
async function rpcApply(ownerId: string, source: string, delta: number, slug: string): Promise<void> {
  const actionId = `t21-${TAG}-${slug}`;
  const res = await rpcCall(CURRENCY_RPC, RPC_PATTERNS.currencyApply, {
    actionId,
    source,
    refId: actionId,
    entries: [{ ownerId, delta }],
  });
  if (!res.ok || res.data === undefined) {
    throw new ConformanceError(`RPC currency.apply 失败（${slug}）：${JSON.stringify(res)}`);
  }
}

/** 管理登录（非引导号）：token。 */
async function loginAdminAs(username: string, password: string): Promise<string> {
  const res = await postJson<{ token: string }>('/api/admin/login', { username, password });
  const token = res.body?.data?.token;
  if (res.body?.code !== ErrCode.OK || !token) {
    throw new ConformanceError(`管理登录 ${username} 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return token;
}

/** CSV 原始字节（经网关；证明 BOM/CRLF 在两跳之后仍在；照 slice-19）。 */
async function fetchCsvRaw(path: string, token: string): Promise<{ status: number; bytes: Uint8Array; headers: Record<string, string> }> {
  const res = await fetch(`${GATEWAY_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, bytes, headers };
}

/** CSV 字节级断言组（定长；照 slice-19 的同名助手）。 */
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
  checks.that(lf.length > 0 && badLf.length === 0, `${label} 行尾全为 CRLF（0d 0a）—— LF 计数 ${lf.length}、违例 ${badLf.length}`);
  checks.eq(raw.headers['content-type'], 'text/csv; charset=utf-8', `${label} Content-Type 逐字`);
  checks.that(
    new RegExp(`^attachment; filename="${filenamePrefix}-\\d{8}-\\d{6}\\.csv"$`).test(raw.headers['content-disposition'] ?? ''),
    `${label} Content-Disposition = attachment; filename="${filenamePrefix}-<yyyyMMdd-HHmmss>.csv" —— 实际 ${JSON.stringify(raw.headers['content-disposition'])}`,
  );
  const text = new TextDecoder('utf-8').decode(raw.bytes);
  for (const needle of mustContain) {
    checks.that(text.includes(needle), `${label} 文本含 ${JSON.stringify(needle)}`);
  }
}

/* ── ⑱ 造数助手：单条 SQL 插 N 行（同一 created_at ⇒ 翻页边界专砸 id 平手分支） ── */

function insertPagingRows(table: string, columns: string, rows: readonly string[]): void {
  // ⚠️ **不用反引号包表名**：`mysqlQuery` 走 `sh -c "…"`，反引号会被 shell 当命令替换
  //    （实测："payment_orders: command not found"）。表名是本地常量，裸写安全。
  const sql = `INSERT INTO ${table} (${columns}) VALUES ${rows.join(',')}`;
  const r = mysqlQuery(sql);
  if (r.code !== 0) throw new ConformanceError(`⑱ 造数失败（${table}）：${tailOut(r.out)}`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════════ */

export async function runSlice21(): Promise<Checks> {
  const checks = new Checks();
  let adminToken = '';
  /** ⑬ 的 fail-closed 段：currency-service 是否被本片停过（finally 兜底回运行态）。 */
  let currencyStopped = false;
  /** ⑭ 的合成 holding 行（异常路径兜底删除——正常路径现场删）。 */
  const syntheticHoldings: string[] = [];

  try {
    /* ── ⓪ 起手态 ───────────────────────────────────────────────────────── */
    step('⓪ 起手态：stub 在跑且双侧密钥在场 · 渠道 env 退役（负断言）+ 管理面种子生效 · 清限流余温 · 开关归一 false · 节奏双键归一 2000（重建 + 启动行自证）');
    const stubPs = docker(['inspect', STUB_CONTAINER, '--format', '{{.State.Running}}']);
    checks.eq(stubPs.stdout.trim(), 'true', `stub 容器 ${STUB_CONTAINER} 必须在运行（conformance-stack.sh up 负责起它）`);
    const stub0 = stubState();
    checks.that(stub0.keys.appPublic && stub0.keys.alipayPrivate, `stub 双侧密钥在场（appPublic/alipayPrivate）—— 实际 ${JSON.stringify(stub0.keys)}`);

    // 渠道六项 env 已退役（T11 compose 差异；六值唯一来源 = 管理面种子）——容器 env 出现任一
    // ⇒ 管理化回流（响亮红）。负断言（旧路死）×6 与下面的「种子生效」正断言（新路活）同源同向。
    const payEnv = containerEnv('ftl-payment-service');
    for (const name of RETIRED_CHANNEL_ENVS) {
      const hits = payEnv.filter((e) => e.startsWith(`${name}=`));
      checks.eq(hits.length, 0, `payment-service 容器 env 无 ${name}（渠道凭据已管理化，env 出现即回流）—— 实际 ${JSON.stringify(hits)}`);
    }

    clearIpBuckets();
    adminToken = await adminLogin(); // 引导号 super_admin
    checks.that(adminToken.length > 0, '引导号管理登录 ⇒ token（后续管理写面的 actor 真源）');

    // 种子生效（T14：`conformance-stack.sh up` 末尾经管理面 PUT ×6 ⇒ `pay_channel_config`）——
    // 渠道面消费的**唯一**来源；管理面 GET = 「六项 configured」的自证读口（fail ⇒ 环境缺陷，响亮红）。
    const chGet = await adminPayChannelGet<{ keys: PayChannelAdminEntry[] }>(adminToken);
    expectHttp(checks, chGet, 200, ErrCode.OK, '⓪ 管理面 GET /api/admin/pay-channel（种子生效读口）');
    const chKeys = chGet.body?.data?.keys ?? [];
    checks.eq(chKeys.length, 6, `⓪ 渠道条目恰六项（⚙️1 顺序）—— 实际 ${chKeys.length}`);
    checks.that(chKeys.every((k) => k.configured === true), `⓪ 六项全 configured=true（种子生效）—— 实际 ${JSON.stringify(chKeys.map((k) => [k.key, k.configured]))}`);
    const chEntry = (key: string): PayChannelAdminEntry | undefined => chKeys.find((k) => k.key === key);
    const chPriv = chEntry('pay.channel.privateKey');
    checks.that(chPriv?.value === null && /^[0-9a-f]{12}$/.test(chPriv?.fingerprint ?? ''), `⓪ 私钥条目 value 恒 null（密键读不回）且 fingerprint=12hex —— 实际 ${JSON.stringify(chPriv)}`);
    checks.that(chEntry('pay.channel.appId')?.value === TEST_APP_ID && chEntry('pay.channel.sellerId')?.value === TEST_SELLER_ID, `⓪ appId/sellerId 种子值与 stub 常量逐字一致（两处同源；旧 env 同源断言的机制面延续）—— 实际 ${JSON.stringify([chEntry('pay.channel.appId')?.value, chEntry('pay.channel.sellerId')?.value])}`);
    // 归一：开关回 false（上一轮 crashed run 的残留会被这里收拢——② 的 15008 判据由此可判别）。
    const norm1 = await adminPutConfig('pay.rechargeEnabled', false, adminToken);
    const norm2 = await adminPutConfig('pay.withdrawEnabled', false, adminToken);
    checks.eq(norm1.body?.code, ErrCode.OK, '归一 pay.rechargeEnabled=false ⇒ code 0');
    checks.eq(norm2.body?.code, ErrCode.OK, '归一 pay.withdrawEnabled=false ⇒ code 0');

    // 归一（本片 ⚙️9）：两节奏键 PUT 回知基线 2000 + 重建 —— crashed run 残留与「起栈未走
    // stack.sh（种子缺失）」缺陷在此收拢；重启后**启动行自证**观测路径（⑨⑩⑫⑯）可执行
    // （config 实读替 env 实读）。时间锚：只认本次重建后产生的启动行 ts（新实例真重启的自证，
    // 照 Global #0；重建即换容器 ⇒ 旧实例日志随之销毁，行来源天然唯一）。
    const normI1 = await adminPutConfig('pay.scanIntervalMs', 2000, adminToken);
    const normI2 = await adminPutConfig('pay.reconcileIntervalMs', 2000, adminToken);
    checks.eq(normI1.body?.code, ErrCode.OK, '⓪ 归一 pay.scanIntervalMs=2000 ⇒ code 0');
    checks.eq(normI2.body?.code, ErrCode.OK, '⓪ 归一 pay.reconcileIntervalMs=2000 ⇒ code 0');
    const normT0 = Date.now();
    const normUp = composeWithRecreate('payment-service');
    checks.eq(normUp.code, 0, `⓪ 归一重建 payment-service —— 输出尾部：${tailOut(normUp.out)}`);
    checks.that(await waitContainerHealthy('ftl-payment-service'), '⓪ 归一态 payment-service 就绪');
    const boot2000 = await pollUntil(
      () =>
        ndjson('payment-service', 600).filter(
          (r) =>
            String(r.msg).includes('first round in 2000ms') &&
            Number.isFinite(Date.parse(String(r.ts))) &&
            Date.parse(String(r.ts)) >= normT0,
        ).length,
      (n) => n > 0,
      30_000,
    );
    checks.that(boot2000.ok, '⓪ 启动行自证 `first round in 2000ms`（⑨⑩⑫⑯ 的观测路径由此可执行；config 实读替 env 实读）');

    /* ── ① 配置键种子 + 客户端键集 15 ────────────────────────────────────── */
    step('① 配置键种子（pay.* 十一键逐字：九种子 + 两节奏基线）+ 客户端键集恰 16');
    const adminCfg = await adminGetConfig<{ config: Record<string, { value: unknown }> }>(adminToken);
    const cfgOf = (key: string): unknown => adminCfg.body?.data?.config?.[key]?.value;
    checks.eq(cfgOf('pay.rechargeEnabled'), false, '① pay.rechargeEnabled 种子 false');
    checks.eq(cfgOf('pay.withdrawEnabled'), false, '① pay.withdrawEnabled 种子 false');
    checks.eq(cfgOf('pay.coinPerYuan'), 100, '① pay.coinPerYuan 种子 100');
    checks.eq(JSON.stringify(cfgOf('pay.rechargePackages')), '[6,30,68,128,328]', '① pay.rechargePackages 种子 [6,30,68,128,328]');
    checks.eq(cfgOf('pay.withdrawMinCoins'), 1000, '① pay.withdrawMinCoins 种子 1000');
    checks.eq(cfgOf('pay.withdrawMaxCoinsPerOrder'), 50000, '① pay.withdrawMaxCoinsPerOrder 种子 50000');
    checks.eq(cfgOf('pay.withdrawDailyMaxCoins'), 100000, '① pay.withdrawDailyMaxCoins 种子 100000');
    checks.eq(cfgOf('pay.orderExpireMinutes'), 30, '① pay.orderExpireMinutes 种子 30');
    checks.eq(cfgOf('pay.withdrawTimeoutMinutes'), 4320, '① pay.withdrawTimeoutMinutes 种子 4320');
    checks.eq(cfgOf('pay.scanIntervalMs'), 2000, '① pay.scanIntervalMs=2000（=stack 种子基线，非出厂种子 60000）');
    checks.eq(cfgOf('pay.reconcileIntervalMs'), 2000, '① pay.reconcileIntervalMs=2000（=stack 种子基线，非出厂种子 86400000）');

    const uOrder = await registerUser(31);
    const c1 = await getJson<Record<string, unknown>>('/api/config', uOrder.accessToken);
    checks.eq(
      Object.keys(c1.body?.data ?? {}).sort().join(','),
      'baseScoreLevels,cardCounterEnabled,cardCounterPricePerGameCoins,cardCounterPricePerHourCoins,coinPerYuan,entryMultiplier,freeRoomEnabled,friendRoomEnabled,games,goldRoomEnabled,rechargeEnabled,rechargePackages,reliefAdpid,reliefEnabled,version,withdrawDailyMaxCoins,withdrawEnabled,withdrawMaxCoinsPerOrder,withdrawMinCoins,withdrawReAuthEnabled',
      '① 客户端键集（排序后）恰 20 键（含九裸名 + cardCounterEnabled）',
    );
    const c1d = c1.body?.data ?? {};
    checks.that(
      c1d.rechargeEnabled === false && c1d.withdrawEnabled === false && c1d.coinPerYuan === 100 &&
        JSON.stringify(c1d.rechargePackages) === '[6,30,68,128,328]' && c1d.withdrawMinCoins === 1000 &&
        c1d.withdrawMaxCoinsPerOrder === 50000 && c1d.withdrawDailyMaxCoins === 100000,
      `① 七新裸名值逐字（false/false/100/档位/1000/50000/100000）—— 实际 ${JSON.stringify({ r: c1d.rechargeEnabled, w: c1d.withdrawEnabled, c: c1d.coinPerYuan, p: c1d.rechargePackages, mn: c1d.withdrawMinCoins, mx: c1d.withdrawMaxCoinsPerOrder, dm: c1d.withdrawDailyMaxCoins })}`,
    );

    /* ── ② 开关关拒单（15008）────────────────────────────────────────────── */
    step('② 充值开关关 ⇒ 拒绝下单（409/15008 逐字文案）');
    clearUserBuckets(uOrder.id);
    const off = await postJson('/api/pay/orders', { packageYuan: 30 }, uOrder.accessToken);
    expectHttp(checks, off, 409, ErrCode.PAY_DISABLED, '② 开关关下单');
    checks.eq(off.body?.message, '充值暂未开放', '② 拒绝文案逐字 §2.8');
    checks.eq(mysqlScalar(`SELECT COUNT(*) FROM payment_orders WHERE user_id='${uOrder.id}'`), '0', '② 被拒单零落行（校验先于 INSERT）');

    // 开两开关（后续组的公共前置）；recharge 以**行为**探到生效（推送 <1s，界 30s）。
    const en1 = await adminPutConfig('pay.rechargeEnabled', true, adminToken);
    const en2 = await adminPutConfig('pay.withdrawEnabled', true, adminToken);
    checks.eq(en1.body?.code, ErrCode.OK, '开关开口一：pay.rechargeEnabled=true ⇒ code 0');
    checks.eq(en2.body?.code, ErrCode.OK, '开关开口二：pay.withdrawEnabled=true ⇒ code 0');
    let firstOrder: PayCreateOrderResponse | null = null;
    {
      const deadline = Date.now() + 30_000;
      for (;;) {
        clearUserBuckets(uOrder.id);
        const probe = await postJson<PayCreateOrderResponse>('/api/pay/orders', { packageYuan: 30 }, uOrder.accessToken);
        if (probe.body?.code === ErrCode.OK && probe.body.data) {
          firstOrder = probe.body.data;
          break;
        }
        if (probe.body?.code !== ErrCode.PAY_DISABLED) {
          throw new ConformanceError(`开开关后下单既不是 15008 也不是成功：HTTP ${probe.status} ${JSON.stringify(probe.body)}`);
        }
        if (Date.now() >= deadline) throw new ConformanceError('pay.rechargeEnabled=true 30s 内未生效（配置推送链断？）');
        await sleep(1_500);
      }
    }

    /* ── ③ 下单：桥接 URL + 桥接页表单 + 浏览器 POST stub + 幂等复用 ───────── */
    step('③ 下单：payUrl=本站桥接页（HMAC token）；桥接页表单两处独立验签；浏览器 POST 由 stub 验签；同档复用不新行');
    const orderA = firstOrder!;
    checks.that(/^pay_[0-9a-z]{6,31}$/.test(orderA.orderNo), `③ 单号形状 ⚙️4（pay_ + base36）—— 实际 ${orderA.orderNo}`);

    // 3.1 payUrl = **本站桥接页**（不再下发渠道网关能力 URL；wap.pay 是页面执行型接口）。
    const payUrl = new URL(orderA.payUrl);
    checks.eq(payUrl.origin, `https://localhost:${EDGE_HTTPS_PORT}`, `③ payUrl 站点 = 门口本站（非渠道网关）—— 实际 ${payUrl.origin}`);
    checks.eq(payUrl.pathname, `/pay/cashier/${orderA.orderNo}`, `③ payUrl 路径 = /pay/cashier/<单号> —— 实际 ${payUrl.pathname}`);
    const bridgeToken = payUrl.searchParams.get('t') ?? '';
    checks.that(/^[\w-]+\.[\w-]+$/.test(bridgeToken), `③ payUrl 带 HMAC 能力 token（<b64url>.<b64url>）—— 实际 ${JSON.stringify(bridgeToken.slice(0, 16))}…`);

    // 下单的唯一渠道出站 = query 凭证探针（stub 对 query 亦建行 —— `orderOf` 首见即建；
    // 判据取「该单尚无 wap.pay 记录」= 服务端没碰 wap.pay，浏览器 POST 才建 wap 记录）。
    const stubAfterProbe = stubState();
    checks.that((stubAfterProbe.counters.query ?? 0) >= 1, `③ 下单触发 query 凭证探针（counters.query≥1）—— 实际 ${JSON.stringify(stubAfterProbe.counters.query)}`);
    checks.that(
      (stubAfterProbe.orders[orderA.orderNo]?.wapPayRequests ?? 0) === 0,
      `③ 探针未触达 wap.pay（stub 侧该单 wapPayRequests=0；浏览器 POST 才建 wap 记录）—— 实际 ${JSON.stringify(stubAfterProbe.orders[orderA.orderNo]?.wapPayRequests)}`,
    );

    // 3.2 玩家浏览器打开桥接页（经门口；真 Caddy handle /pay/cashier/* 路由）。
    const bridgePath = `${payUrl.pathname}?${payUrl.searchParams.toString()}`;
    const bridge = await edgeRequest('GET', bridgePath, null);
    checks.eq(bridge.status, 200, '③ 桥接页经门口 ⇒ HTTP 200');
    checks.that(bridge.body.includes('method="post" action="http://ftl-alipay-stub:8801"'), `③ 桥接页表单 POST 到渠道网关 —— 实际 action 片段 ${JSON.stringify(bridge.body.match(/action="[^"]*"/)?.[0])}`);
    checks.that(/document\.forms\[0\]\.submit\(\)/.test(bridge.body), '③ 桥接页自动提交（noscript 兜底）');

    // 3.3 从 HTML 抽出 hidden inputs（浏览器视角事实）逐字断言 + 宿主侧独立复验签名。
    const formParams = parseHiddenInputs(bridge.body);
    checks.eq(formParams.method, 'alipay.trade.wap.pay', '③ 桥接表单 method=alipay.trade.wap.pay');
    checks.eq(formParams.app_id, TEST_APP_ID, '③ 桥接表单 app_id = 测试 APP_ID');
    checks.eq(formParams.sign_type, 'RSA2', '③ 桥接表单 sign_type=RSA2');
    checks.eq(formParams.charset, 'utf-8', '③ 桥接表单 charset=utf-8');
    checks.eq(formParams.version, '1.0', '③ 桥接表单 version=1.0');
    checks.that(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(formParams.timestamp ?? ''), `③ 表单 timestamp = 支付宝形态（yyyy-MM-dd HH:mm:ss 北京时间）—— 实际 ${JSON.stringify(formParams.timestamp)}`);
    const biz = JSON.parse(formParams.biz_content ?? '{}') as Record<string, string>;
    checks.eq(biz.out_trade_no, orderA.orderNo, '③ biz_content.out_trade_no = 订单号');
    checks.eq(biz.total_amount, '30.00', '③ biz_content.total_amount = 30.00（⚙️5 fen2yuan）');
    checks.eq(biz.subject, '金币充值 30 元', '③ biz_content.subject 文案');
    checks.eq(biz.product_code, 'QUICK_WAP_WAY', '③ biz_content.product_code = QUICK_WAP_WAY（wap 形态）');
    checks.eq(biz.timeout_express, '30m', '③ biz_content.timeout_express = 30m（种子快照）');
    checks.eq(formParams.notify_url, `https://localhost:8443${NOTIFY_PATH}`, '③ notify_url = 站点基址（管理面种子 pay.channel.publicBaseUrl）+ /pay/notify/alipay');
    checks.eq(formParams.return_url, `https://localhost:8443/?pay=${orderA.orderNo}`, '③ return_url = 回跳素材（?pay=<单号>）');
    const formBody = new URLSearchParams(Object.entries(formParams)).toString();
    checks.that(verifyAppRequestSignature(formBody), '③ 宿主侧独立复验：桥接表单签名对 app-public.pem **成立**（浏览器将 POST 出去的字节）');

    // 3.4 模拟浏览器执行自动表单（stub 容器内 wget POST）——必须排在 ④ 回调之前：
    // stub 侧订单由这次 wap.pay 首见建立（与真实渠道「订单在渠道侧也有分身」同形）。
    const stubReply = JSON.parse(browserPostWapForm(formBody)) as Record<string, Record<string, unknown>>;
    const wapNode = stubReply.alipay_trade_wap_pay_response;
    checks.eq(wapNode?.code, '10000', `③ stub 接受浏览器 POST（签名有效）⇒ 10000 —— 实际 ${JSON.stringify(wapNode).slice(0, 200)}`);
    const stubOrderA = stubState().orders[orderA.orderNo];
    checks.that(stubOrderA?.wapPayVerified === true, `③ stub 侧「验浏览器表单签名通过」（方向① 的 stub 人证）—— 实际 ${JSON.stringify(stubOrderA?.wapPayVerified)}`);
    checks.eq(stubOrderA?.wapPayRequests, 1, '③ stub 恰收到 1 次 wap.pay 浏览器 POST（服务端零 wap 出站）');
    checks.eq(stubOrderA?.notify_url, `https://localhost:8443${NOTIFY_PATH}`, '③ stub 记录 notify_url 逐字（回调素材的真实去向）');

    // 3.5 log_skip：能力 token 不落 edge 访问日志（先打一条必被记录的对照请求，证明日志面活着）。
    await edgeRequest('GET', '/__conformance_log_probe__', null);
    const edgeLogs = docker(['logs', EDGE_CONTAINER, '--since', '3m'], 20_000);
    const edgeLogText = `${edgeLogs.stdout}\n${edgeLogs.stderr}`;
    checks.that(edgeLogText.includes('__conformance_log_probe__'), '③ edge 访问日志面活着（对照请求已记录；否则 log_skip 断言无意义）');
    checks.that(!edgeLogText.includes(bridgeToken), '③ log_skip：桥接能力 token 不出现在 edge 访问日志（?t= 不落盘）');
    checks.that(!edgeLogText.includes(`/pay/cashier/${orderA.orderNo}`), '③ log_skip：/pay/cashier/* 请求整条跳过（path 亦不记录）');

    // 幂等复用：同用户 + 同档位 + 未过期 created ⇒ 同单号、不新行。
    clearUserBuckets(uOrder.id);
    const reuse = await createOrder(uOrder, 30);
    checks.eq(reuse.orderNo, orderA.orderNo, '③ 同档再下单 ⇒ 复用同单号（§2.1 短时幂等）');
    checks.that(reuse.payUrl !== orderA.payUrl, '③ 复用单重签桥接 URL（新 token；不重放旧链接）');
    checks.eq(mysqlScalar(`SELECT COUNT(*) FROM payment_orders WHERE user_id='${uOrder.id}' AND package_yuan=30`), '1', '③ 复用不新行（恰 1 行）');

    /* ── ④ 回调正例 ⇒ 入账 ⇒ 余额/流水/锚/notify_log ─────────────────────── */
    step('④ 回调正例（经门口；stub 私钥签名）⇒ 入账 ⇒ 余额/流水/锚/notify_log 逐字');
    const okBefore = notifyMetric('ok');
    const { form: formA } = stubSignNotify(orderA.orderNo, '30.00');
    const notifyA = await deliverNotify(formA);
    checks.eq(notifyA.status, 200, '④ 通知经门口（Caddyfile handler）⇒ HTTP 200');
    checks.eq(notifyA.body, 'success', '④ 应答恰一词 success（⚙️7）');
    await pollSql(`SELECT status FROM payment_orders WHERE order_no='${orderA.orderNo}'`, (v) => v === 'credited', '④ 订单入账（credited）', 20_000, 1_000);
    checks.eq(mysqlScalar(`SELECT credited_at IS NOT NULL FROM payment_orders WHERE order_no='${orderA.orderNo}'`), '1', '④ credited_at 已落（写点逐字 §2.3）');
    const detailA = await getOrder(uOrder, orderA.orderNo);
    expectHttp(checks, detailA, 200, ErrCode.OK, '④ 订单详情读（#2 端点）');
    checks.eq(detailA.body?.data?.status, 'credited', '④ 详情 status=credited');
    checks.eq(detailA.body?.data?.amountYuan, '30.00', '④ 详情 amountYuan=30.00（⚙️5 字符串元）');
    checks.eq(detailA.body?.data?.coins, 3000, '④ 详情 coins=3000（快照）');
    const flowA = mysqlRows(`SELECT o.action_id, o.source, o.ref_id, f.delta FROM currency_ops o JOIN currency_flows f ON f.op_id=o.id WHERE o.action_id='pay:${orderA.orderNo}'`);
    checks.eq(flowA.length, 1, '④ 锚恰 1 行 op⋈flow（pay:<orderNo>）');
    checks.eq(flowA[0]?.join('|') ?? '', `pay:${orderA.orderNo}|recharge|${orderA.orderNo}|3000`, '④ 流水逐字：锚 pay:<no> / source recharge / refId=单号 / delta +3000');
    const sumA = await walletSummary(uOrder);
    checks.eq(sumA.body?.data?.withdrawable, 3000, '④ 可离场额度 cap = 3000（充值入 cap 源集合 §2.2.1）');
    checks.eq(sumA.body?.data?.balance, Number(mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uOrder.id}'`)), '④ 钱包余额 == 货币账户余额（同一事实两个读口）');
    checks.eq(mysqlScalar(`SELECT result FROM payment_notify_log WHERE order_no='${orderA.orderNo}' ORDER BY id DESC LIMIT 1`), 'ok', '④ notify_log 尾行 result=ok');
    checks.eq(mysqlScalar(`SELECT trade_status FROM payment_notify_log WHERE order_no='${orderA.orderNo}' ORDER BY id DESC LIMIT 1`), 'TRADE_SUCCESS', '④ notify_log trade_status 逐字');
    checks.eq(notifyMetric('ok') - okBefore, 1, '④ payment_notify_total{ok} 恰 +1');

    /* ── ⑤ 伪造签名拒 + bad_sign 计数 ────────────────────────────────────── */
    step('⑤ 伪造签名（篡改金额、sign 留旧）⇒ 拒 + bad_sign 计数 + notify_log 零行');
    const badBefore = notifyMetric('bad_sign');
    const tampered = { ...stubSignNotify(orderA.orderNo, '30.00').params, total_amount: '30.01' };
    const badRes = await deliverNotify(new URLSearchParams(tampered).toString());
    checks.eq(badRes.status, 200, '⑤ 伪造签名 ⇒ HTTP 200（应答语义在 body；⚙️7）');
    checks.eq(badRes.body, 'failure', '⑤ 伪造签名 ⇒ failure');
    checks.eq(notifyMetric('bad_sign') - badBefore, 1, '⑤ payment_notify_total{bad_sign} 恰 +1（哨兵）');
    checks.eq(mysqlScalar(`SELECT COUNT(*) FROM payment_notify_log WHERE order_no='${orderA.orderNo}' AND result='bad_sign'`), '0', '⑤ 验签失败**零落行**（§2.3 仅存验签通过件）');
    checks.eq(mysqlScalar(`SELECT status FROM payment_orders WHERE order_no='${orderA.orderNo}'`), 'credited', '⑤ 拒后订单态不动');

    /* ── ⑥ 金额不符拒（amount_mismatch）──────────────────────────────────── */
    step('⑥ 签名有效但金额不符 ⇒ amount_mismatch + notify_log 落行');
    const mmBefore = notifyMetric('amount_mismatch');
    const mmForm = stubSignNotify(orderA.orderNo, '31.00').form; // stub 对 31.00 真签名（≠ 订单 3000 分）
    const mmRes = await deliverNotify(mmForm);
    checks.eq(mmRes.status, 200, '⑥ 金额不符（签名有效）⇒ HTTP 200');
    checks.eq(mmRes.body, 'failure', '⑥ 金额不符 ⇒ failure');
    checks.eq(notifyMetric('amount_mismatch') - mmBefore, 1, '⑥ payment_notify_total{amount_mismatch} 恰 +1');
    checks.eq(mysqlScalar(`SELECT result FROM payment_notify_log WHERE order_no='${orderA.orderNo}' ORDER BY id DESC LIMIT 1`), 'amount_mismatch', '⑥ notify_log 落行 result=amount_mismatch（验签通过类）');
    checks.eq(mysqlScalar(`SELECT status FROM payment_orders WHERE order_no='${orderA.orderNo}'`), 'credited', '⑥ 金额不符不动订单');

    /* ── ⑦ 重放幂等 ──────────────────────────────────────────────────────── */
    step('⑦ 重放同一条正例通知 ⇒ 幂等 success：不二次入账、锚不增行');
    const creditedAtA = mysqlScalar(`SELECT credited_at FROM payment_orders WHERE order_no='${orderA.orderNo}'`);
    const okBefore7 = notifyMetric('ok');
    const replayA = await deliverNotify(formA);
    checks.eq(replayA.status, 200, '⑦ 重放 ⇒ HTTP 200');
    checks.eq(replayA.body, 'success', '⑦ 重放 ⇒ success（幂等面 already）');
    checks.eq(mysqlScalar(`SELECT credited_at FROM payment_orders WHERE order_no='${orderA.orderNo}'`), creditedAtA, '⑦ credited_at 不被改写');
    checks.eq(mysqlScalar(`SELECT COUNT(*) FROM currency_ops WHERE action_id='pay:${orderA.orderNo}'`), '1', '⑦ 入账锚恰 1 行（同锚重放不再落账）');
    checks.eq(notifyMetric('ok') - okBefore7, 1, '⑦ 重放计 ok（每一条回调恰一计）');

    /* ── ⑧ 并发双通知恰一次 ─────────────────────────────────────────────── */
    step('⑧ 并发双通知（同一签名表单同时两发）⇒ 双 success、入账恰一次');
    clearUserBuckets(uOrder.id);
    const orderB = await createOrder(uOrder, 6);
    const { form: formB } = stubSignNotify(orderB.orderNo, '6.00');
    const [p1, p2] = await Promise.all([deliverNotify(formB), deliverNotify(formB)]);
    checks.eq(p1.status, 200, '⑧ 并发发一 ⇒ HTTP 200');
    checks.eq(p2.status, 200, '⑧ 并发发二 ⇒ HTTP 200');
    checks.eq(p1.body, 'success', '⑧ 发一 success');
    checks.eq(p2.body, 'success', '⑧ 发二 success（幂等面与首达面都 success）');
    await pollSql(`SELECT status FROM payment_orders WHERE order_no='${orderB.orderNo}'`, (v) => v === 'credited', '⑧ 订单入账', 20_000, 1_000);
    checks.eq(mysqlScalar(`SELECT COUNT(*) FROM currency_ops WHERE action_id='pay:${orderB.orderNo}'`), '1', '⑧ 并发入账恰一次（同锚 UK 兜底）');
    checks.eq(mysqlScalar(`SELECT COUNT(*) FROM payment_notify_log WHERE order_no='${orderB.orderNo}'`), '2', '⑧ 两条通知各落一行（都通过验签）');

    /* ── ⑨ 迟到回调重开（SQL 回填 expires_at 构造过期单）──────────────────── */
    step('⑨ 迟到回调重开：SQL 回填 expires_at ⇒ 扫描关闭 ⇒ 迟到通知 ⇒ reopen 计数 + 入账');
    clearUserBuckets(uOrder.id);
    const orderC = await createOrder(uOrder, 68);
    mysqlQuery(`UPDATE payment_orders SET expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE order_no='${orderC.orderNo}'`);
    await pollSql(`SELECT status FROM payment_orders WHERE order_no='${orderC.orderNo}'`, (v) => v === 'closed', '⑨ 过期扫描关闭（循环①；2s 周期注入）', 20_000, 1_000);
    checks.eq(mysqlScalar(`SELECT closed_at IS NOT NULL FROM payment_orders WHERE order_no='${orderC.orderNo}'`), '1', '⑨ 关闭落 closed_at');
    const reopenBefore = notifyMetric('reopen');
    const lateRes = await deliverNotify(stubSignNotify(orderC.orderNo, '68.00').form);
    checks.eq(lateRes.status, 200, '⑨ 迟到通知 ⇒ HTTP 200');
    checks.eq(lateRes.body, 'success', '⑨ 迟到通知 ⇒ success（closed ⇒ 重开路径）');
    checks.eq(notifyMetric('reopen') - reopenBefore, 1, '⑨ payment_notify_total{reopen} 恰 +1（告警 PaymentLateNotifyReopen 的哨兵）');
    checks.eq(mysqlScalar(`SELECT late_reopen_at IS NOT NULL FROM payment_orders WHERE order_no='${orderC.orderNo}'`), '1', '⑨ late_reopen_at 已落（重开时刻）');
    await pollSql(`SELECT status FROM payment_orders WHERE order_no='${orderC.orderNo}'`, (v) => v === 'credited', '⑨ 重开单入账', 20_000, 1_000);
    checks.eq(mysqlScalar(`SELECT result FROM payment_notify_log WHERE order_no='${orderC.orderNo}' ORDER BY id DESC LIMIT 1`), 'reopen', '⑨ notify_log result=reopen');

    /* ── ⑩ 过期关闭（含 trade.close 已付分支：stub mark-paid ⇒ close 报已付 ⇒ 重开）── */
    step('⑩ trade.close 报「已支付」⇒ 已付被关重开：stub mark-paid ⇒ SQL 回填过期 ⇒ 扫描重开+入账');
    clearUserBuckets(uOrder.id);
    const orderD = await createOrder(uOrder, 128);
    const markD = JSON.parse(stubControl(`/_control/mark-paid?out_trade_no=${orderD.orderNo}`)) as { ok: boolean; status: string };
    checks.that(markD.ok && markD.status === 'paid', '⑩ stub 侧标记已付（渠道侧事实先行）');
    mysqlQuery(`UPDATE payment_orders SET expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE order_no='${orderD.orderNo}'`);
    // 循环①：本地关（closed）→ close 被 stub 拒「已付」⇒ 重开 paid ⇒ 循环③ 入账。
    await pollSql(`SELECT status FROM payment_orders WHERE order_no='${orderD.orderNo}'`, (v) => v === 'credited', '⑩ 已付被关重开并入账', 30_000, 1_000);
    checks.eq(mysqlScalar(`SELECT late_reopen_at IS NOT NULL FROM payment_orders WHERE order_no='${orderD.orderNo}'`), '1', '⑩ late_reopen_at 已落（close 已付分支 ⇒ 重开）');
    checks.eq(mysqlScalar(`SELECT closed_at IS NOT NULL FROM payment_orders WHERE order_no='${orderD.orderNo}'`), '1', '⑩ 曾被本地关闭（closed_at 在）——重开不清史');
    checks.eq(stubState().orders[orderD.orderNo]?.status, 'paid', '⑩ stub 仍持 paid（close 被拒、未误关渠道单）');
    checks.eq(mysqlScalar(`SELECT COUNT(*) FROM currency_ops WHERE action_id='pay:${orderD.orderNo}'`), '1', '⑩ 重开单入账锚恰 1 行');

    /* ⑭ 的「未入账」负例素材（created 单；用后 SQL 关单收尾）——此处在 U_ORDER 上先建 */
    clearUserBuckets(uOrder.id);
    const orderECreated = await createOrder(uOrder, 328);

    /* ── ⑪ 提现全链 ─────────────────────────────────────────────────────── */
    step('⑪ 提现全链：门槛/单笔负例 · 申请（锁内三段）· 在途拒 · 审通过 · 登记打款（台账）');
    const uWd = await registerUser(32);
    await rpcApply(uWd.id, 'game_settle', 5000, 'wdfund'); // cap 源集合内 ⇒ 可离场额度真给
    clearUserBuckets(uWd.id);
    const wdLow = await postJson('/api/pay/withdrawals', { coins: 999 }, uWd.accessToken);
    expectHttp(checks, wdLow, 409, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '⑪ 低于门槛(999)');
    checks.that((wdLow.body?.message ?? '').includes('低于门槛'), `⑪ 门槛文案变体逐字 —— 实际 ${JSON.stringify(wdLow.body?.message)}`);
    const wdHigh = await postJson('/api/pay/withdrawals', { coins: 50001 }, uWd.accessToken);
    expectHttp(checks, wdHigh, 409, ErrCode.PAY_WITHDRAW_LIMIT, '⑪ 超单笔上限(50001)');
    checks.that((wdHigh.body?.message ?? '').includes('单笔'), `⑪ 单笔文案变体逐字 —— 实际 ${JSON.stringify(wdHigh.body?.message)}`);
    const wdSum0 = await walletSummary(uWd);
    checks.eq(wdSum0.body?.data?.withdrawable, 5000, '⑪ 前置：cap = 5000（game_settle 在 cap 源集合 §2.2.1）');

    clearUserBuckets(uWd.id);
    const wdApply = await postJson<{ withdrawNo: string; status: string }>('/api/pay/withdrawals', { coins: 1000 }, uWd.accessToken);
    expectHttp(checks, wdApply, 200, ErrCode.OK, '⑪ 申请 1000');
    const wdNo1 = wdApply.body?.data?.withdrawNo ?? '';
    checks.that(/^wd_[0-9a-z]{6,31}$/.test(wdNo1), `⑪ 提现单号形状 ⚙️4 —— 实际 ${wdNo1}`);
    checks.eq(wdApply.body?.data?.status, 'pending', '⑪ 状态 = pending（冻结落账后）');
    const wdRow1 = mysqlRows(`SELECT status, coins, amount_fen, active_slot, hold_confirmed_at IS NOT NULL, TIMESTAMPDIFF(HOUR, created_at, timeout_at) FROM payment_withdrawals WHERE withdraw_no='${wdNo1}'`);
    checks.eq(wdRow1[0]?.join('|') ?? '', 'pending|1000|1000|1|1|72', '⑪ 行逐字：pending / 1000 币 / 1000 分 / 槽 1 / hold_confirmed_at 有 / 超时 72h');
    const wdFlow1 = mysqlRows(`SELECT o.action_id, o.source, o.ref_id, f.delta, f.balance_after FROM currency_ops o JOIN currency_flows f ON f.op_id=o.id WHERE o.action_id='withdraw:${wdNo1}'`);
    checks.eq(wdFlow1.length, 1, '⑪ hold 锚恰 1 行 op⋈flow');
    checks.eq(wdFlow1[0]?.join('|') ?? '', `withdraw:${wdNo1}|withdraw_hold|${wdNo1}|-1000|${mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uWd.id}'`)}`, '⑪ hold 流水逐字：锚/源/refId/Δ−1000/balance_after=当前余额');
    const wdSum1 = await walletSummary(uWd);
    checks.eq(wdSum1.body?.data?.withdrawable, 4000, '⑪ 提现后 cap = 5000−1000 = 4000（自然符号计入）');

    const wdDup = await postJson('/api/pay/withdrawals', { coins: 1000 }, uWd.accessToken);
    expectHttp(checks, wdDup, 409, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '⑪ 已有在途再申');
    checks.that((wdDup.body?.message ?? '').includes('已有在途'), `⑪ 在途文案变体逐字 —— 实际 ${JSON.stringify(wdDup.body?.message)}`);

    const wdApprove = await postJson<{ withdrawNo: string; status: string }>(`/api/admin/pay/withdrawals/${wdNo1}/review`, { action: 'approve', note: `t21-${TAG}` }, adminToken);
    expectHttp(checks, wdApprove, 200, ErrCode.OK, '⑪ 审通过');
    checks.eq(wdApprove.body?.data?.status, 'approved', '⑪ 审后状态 approved');
    checks.eq(mysqlScalar(`SELECT reviewed_by FROM payment_withdrawals WHERE withdraw_no='${wdNo1}'`), 'admin', '⑪ reviewed_by = 管理 actor（网关注入）');
    const balBeforeConfirm = mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uWd.id}'`);
    const wdConfirm = await postJson<{ withdrawNo: string; status: string }>(`/api/admin/pay/withdrawals/${wdNo1}/confirm`, { voucher: `t21v-${TAG}`, note: '线下打款' }, adminToken);
    expectHttp(checks, wdConfirm, 200, ErrCode.OK, '⑪ 登记打款');
    checks.eq(wdConfirm.body?.data?.status, 'paid', '⑪ 确认后状态 paid');
    const wdRow1b = mysqlRows(`SELECT confirmed_by, voucher, active_slot IS NULL, rolled_back_at IS NULL FROM payment_withdrawals WHERE withdraw_no='${wdNo1}'`);
    checks.eq(wdRow1b[0]?.join('|') ?? '', `admin|t21v-${TAG}|1|1`, '⑪ 台账逐字：confirmed_by / voucher / 释槽 / 未回滚');
    checks.eq(mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uWd.id}'`), balBeforeConfirm, '⑪ 确认打款不动钱（台账语义；冻结早已落账）');
    const wdConfirmAgain = await postJson(`/api/admin/pay/withdrawals/${wdNo1}/confirm`, { voucher: `t21v2-${TAG}` }, adminToken);
    expectHttp(checks, wdConfirmAgain, 409, ErrCode.PAY_STATE_CONFLICT, '⑪ 已 paid 再 confirm');
    checks.that((wdConfirmAgain.body?.message ?? '').includes('paid'), `⑪ 15009 message 含当前态 —— 实际 ${JSON.stringify(wdConfirmAgain.body?.message)}`);

    /* ── ⑫ 超时回滚（SQL 回拨 timeout_at；claim 互斥负例）──────────────────── */
    step('⑫ 超时回滚：SQL 回拨 timeout_at ⇒ 循环⑤ claim+rb ⇒ timeout_rolled_back；claim 互斥');
    clearUserBuckets(uWd.id);
    const balBeforeT = mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uWd.id}'`);
    const wdApply2 = await postJson<{ withdrawNo: string; status: string }>('/api/pay/withdrawals', { coins: 1500 }, uWd.accessToken);
    expectHttp(checks, wdApply2, 200, ErrCode.OK, '⑫ 申请 1500');
    const wdNo2 = wdApply2.body?.data?.withdrawNo ?? '';
    mysqlQuery(`UPDATE payment_withdrawals SET timeout_at = NOW(3) - INTERVAL 1 MINUTE WHERE withdraw_no='${wdNo2}'`);
    await pollSql(`SELECT status FROM payment_withdrawals WHERE withdraw_no='${wdNo2}'`, (v) => v === 'timeout_rolled_back', '⑫ 超时回滚收敛（循环⑤；2s 周期）', 20_000, 1_000);
    const wdRow2 = mysqlRows(`SELECT active_slot IS NULL, rolled_back_at IS NOT NULL, rollback_reason FROM payment_withdrawals WHERE withdraw_no='${wdNo2}'`);
    checks.eq(wdRow2[0]?.join('|') ?? '', '1|1|timeout', '⑫ 终态行：释槽 / rolled_back_at 有 / reason=timeout');
    const wdFlow2 = mysqlRows(`SELECT o.action_id, o.source, f.delta FROM currency_ops o JOIN currency_flows f ON f.op_id=o.id WHERE o.action_id='withdraw_rb:${wdNo2}'`);
    checks.eq(wdFlow2[0]?.join('|') ?? '', `withdraw_rb:${wdNo2}|withdraw_rollback|1500`, '⑫ 回滚流水逐字：withdraw_rb 锚 / withdraw_rollback / Δ+1500');
    checks.eq(mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uWd.id}'`), balBeforeT, '⑫ 回滚后余额复原（钱退回）');
    const wdConfirmT = await postJson(`/api/admin/pay/withdrawals/${wdNo2}/confirm`, { voucher: `t21t-${TAG}` }, adminToken);
    expectHttp(checks, wdConfirmT, 409, ErrCode.PAY_STATE_CONFLICT, '⑫ claim 互斥负例：超时终态上 confirm');
    checks.that((wdConfirmT.body?.message ?? '').includes('timeout_rolled_back'), `⑫ 15009 message 含当前态 —— 实际 ${JSON.stringify(wdConfirmT.body?.message)}`);
    const wdApproveT = await postJson(`/api/admin/pay/withdrawals/${wdNo2}/review`, { action: 'approve' }, adminToken);
    expectHttp(checks, wdApproveT, 409, ErrCode.PAY_STATE_CONFLICT, '⑫ claim 互斥负例：超时终态上 review');

    /* ── ⑬ cap 场景组（§2.2.1 演算表①–⑤ + 15005 + 跨面占位拒 + fail-closed）── */
    step('⑬ cap 演算表①–⑤（真栈 withdrawable）+ 15005 + 跨面占位拒 + fail-closed（停 currency-service）');
    const uCap1 = await registerUser(34);
    const uCap2 = await registerUser(35);
    const uCap3 = await registerUser(36);
    const capOf = async (u: HarnessUser, label: string): Promise<number> => {
      const s = await walletSummary(u);
      const v = s.body?.data?.withdrawable;
      checks.that(typeof v === 'number', `${label}：withdrawable 读数为数字 —— 实际 ${JSON.stringify(s.body)}`);
      return v as number;
    };
    checks.eq(await capOf(uCap1, '①前置'), 0, '⑬ 演算表前置：fresh 用户 cap=0（signup 不入 cap 源集合）');
    await payAndCredit(uCap1, 6, checks);
    checks.eq(await capOf(uCap1, '①'), 600, '⑬ 演算表①：充值 600 未动 ⇒ cap 600');
    await rpcApply(uCap1.id, 'relief_grant', 200, 'cap1-relief');
    checks.eq(await capOf(uCap1, '②'), 600, '⑬ 演算表②：+救助 200 ⇒ cap 仍 600（沉淀不可离场）');
    await rpcApply(uCap1.id, 'game_settle', -150, 'cap1-settle');
    checks.eq(await capOf(uCap1, '③'), 450, '⑬ 演算表③：净输 150 ⇒ cap 450（垫白来的钱，按净额收缩）');
    await rpcApply(uCap2.id, 'relief_grant', 200, 'cap2-relief');
    await rpcApply(uCap2.id, 'game_settle', 300, 'cap2-settle');
    checks.eq(await capOf(uCap2, '④'), 300, '⑬ 演算表④：无充值+救助 200+净赢 300 ⇒ cap 300（赢取可提）');
    await payAndCredit(uCap3, 6, checks);
    checks.eq(await capOf(uCap3, '⑤前置'), 600, '⑬ 演算表⑤前置：充值 600 ⇒ cap 600');
    clearUserBuckets(uCap3.id);
    const rfCap3 = await postJson<{ refundNo: string; status: string }>('/api/pay/refunds', { orderNo: mysqlScalar(`SELECT order_no FROM payment_orders WHERE user_id='${uCap3.id}' AND status='credited' ORDER BY id DESC LIMIT 1`), reason: `t21 cap ⑤ ${TAG}` }, uCap3.accessToken);
    expectHttp(checks, rfCap3, 200, ErrCode.OK, '⑬ 演算表⑤：对充值 600 申请退款（冻结）');
    checks.eq(await capOf(uCap3, '⑤'), 0, '⑬ 演算表⑤：充值 600 + 已冻 600 ⇒ cap 0（冻结/回滚按自然符号计入）');
    const rfCap3Reject = await postJson<{ status: string }>(`/api/admin/pay/refunds/${rfCap3.body?.data?.refundNo}/review`, { action: 'reject', note: 'cap⑤ 收尾' }, adminToken);
    expectHttp(checks, rfCap3Reject, 200, ErrCode.OK, '⑬ 演算表⑤收尾：驳回 ⇒ 回滚');
    checks.eq(await capOf(uCap3, '⑤回滚后'), 600, '⑬ 演算表⑤回滚后：refund_rb 计入 ⇒ cap 回 600（自然符号往返）');

    clearUserBuckets(uCap2.id);
    const capInsuf = await postJson('/api/pay/withdrawals', { coins: 1000 }, uCap2.accessToken);
    expectHttp(checks, capInsuf, 409, ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT, '⑬ 15005 负例：cap 300 申请 1000');
    checks.eq(capInsuf.body?.message, '可提余额不足', '⑬ 15005 文案逐字 §2.8');

    // 跨面占位拒（两向）：SQL 造**未解析 holding** ⇒ 另一消费面必拒（资金动作前的占位闸）。
    // 🔴 **先冻结扫描**（PUT `pay.scanIntervalMs=600000`（上界顶格合法）+ 重建 payment-service；
    //    见 helper 注释）——不冻结则 2s 扫描会在「插入 → 断言 → 删除」窗口里抢先重放占位行
    //    （断言竞态；且首轮实测留下「ops 有锚、本地无行」的孤儿锚（真扣了钱），被本片 ⑯ 的
    //    日自检当场抓出——登记在案）。
    const frozenT0 = Date.now(); // 时间锚（照 slice-20 ④b 还原侧）：只认本次重建后产生的启动行 ts
    await setScanIntervalAndRecreate(600000, adminToken);
    checks.that(await waitContainerHealthy('ftl-payment-service'), '⑬ 冻扫窗口：payment-service 重建 healthy（扫描周期 600s）');
    const frozenBoot = await pollUntil(
      () =>
        ndjson('payment-service', 600).filter(
          (r) =>
            String(r.msg).includes('first round in 600000ms') &&
            Number.isFinite(Date.parse(String(r.ts))) &&
            Date.parse(String(r.ts)) >= frozenT0,
        ).length,
      (n) => n > 0,
      30_000,
    );
    checks.that(frozenBoot.ok, '⑬ 冻扫启动行自证 `first round in 600000ms`（冻结真发生——重建后 2s 扫描不抢占位行）');
    try {
      const fakeRefundNo = `rf_t21hold${TAG}`;
      mysqlQuery(`INSERT INTO payment_refunds (refund_no, order_no, user_id, amount_fen, coins, status, reason, channel_out_request_no, active_slot) VALUES ('${fakeRefundNo}', 'pay_t21fake${TAG}', '${uWd.id}', 100, 100, 'holding', 't21 cross-face probe', '${fakeRefundNo}', 1)`);
      syntheticHoldings.push(`DELETE FROM payment_refunds WHERE refund_no='${fakeRefundNo}'`);
      clearUserBuckets(uWd.id);
      const crossWd = await postJson('/api/pay/withdrawals', { coins: 1000 }, uWd.accessToken);
      expectHttp(checks, crossWd, 409, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '⑬ 跨面串行负例：退款 holding 在 ⇒ 提现拒');
      checks.that((crossWd.body?.message ?? '').includes('有处理中申请'), `⑬ 占位文案变体逐字 —— 实际 ${JSON.stringify(crossWd.body?.message)}`);
      mysqlQuery(syntheticHoldings.pop()!);

      const fakeWithdrawNo = `wd_t21hold${TAG}`;
      mysqlQuery(`INSERT INTO payment_withdrawals (withdraw_no, user_id, coins, amount_fen, status, timeout_at, active_slot) VALUES ('${fakeWithdrawNo}', '${uOrder.id}', 100, 100, 'holding', NOW(3) + INTERVAL 72 HOUR, 1)`);
      syntheticHoldings.push(`DELETE FROM payment_withdrawals WHERE withdraw_no='${fakeWithdrawNo}'`);
      clearUserBuckets(uOrder.id);
      const crossRf = await postJson('/api/pay/refunds', { orderNo: orderB.orderNo, reason: 't21 cross-face probe' }, uOrder.accessToken);
      expectHttp(checks, crossRf, 409, ErrCode.PAY_REFUND_UNAVAILABLE, '⑬ 跨面串行负例：提现 holding 在 ⇒ 退款拒');
      checks.that((crossRf.body?.message ?? '').includes('有处理中申请'), `⑬ 占位文案变体逐字（15006 侧）—— 实际 ${JSON.stringify(crossRf.body?.message)}`);
      mysqlQuery(syntheticHoldings.pop()!);

      checks.eq(mysqlScalar(`SELECT COUNT(*) FROM payment_withdrawals WHERE withdraw_no='${fakeWithdrawNo}'`), '0', '⑬ 占位探针行已删除（零残渣；冻扫窗口内无旁路收敛）');
    } finally {
      const restoreT0 = Date.now(); // 时间锚：只认本次重建后产生的启动行 ts（新实例真重启的自证——旧实例日志已随重建销毁）
      await setScanIntervalAndRecreate(2000, adminToken);
      checks.that(await waitContainerHealthy('ftl-payment-service'), '⑬ 冻扫窗口收束：payment-service 还原 healthy（扫描周期 2000ms）');
      const restoredBoot = await pollUntil(
        () =>
          ndjson('payment-service', 600).filter(
            (r) =>
              String(r.msg).includes('first round in 2000ms') &&
              Number.isFinite(Date.parse(String(r.ts))) &&
              Date.parse(String(r.ts)) >= restoreT0,
          ).length,
        (n) => n > 0,
        30_000,
      );
      checks.that(restoredBoot.ok, '⑬ 扫描周期已还原：启动行 `first round in 2000ms`（解析值=配置值——⑨⑩⑫⑯ 观测路径不受扰）');
    }

    // fail-closed：停 currency-service ⇒ cap 取数失败 ⇒ 拒（15003 服务暂时不可用变体）⇒ 恢复。
    step('⑬ fail-closed：停 currency-service ⇒ 提现申请必拒（15003 变体）⇒ 恢复 ⇒ 正对照');
    const stopC = docker(['stop', 'ftl-currency-service'], 60_000);
    checks.eq(stopC.status, 0, '⑬ 停 currency-service（失败前置：容器名/权限——错误必须在这里露出）');
    currencyStopped = true;
    clearUserBuckets(uWd.id);
    const rowsBeforeFail = mysqlScalar(`SELECT COUNT(*) FROM payment_withdrawals WHERE user_id='${uWd.id}'`);
    const failClosed = await postJson('/api/pay/withdrawals', { coins: 1000 }, uWd.accessToken);
    expectHttp(checks, failClosed, 409, ErrCode.PAY_WITHDRAW_UNAVAILABLE, '⑬ fail-closed 负例：cap 取数失败 ⇒ 拒');
    checks.eq(failClosed.body?.message, '提现暂不可用（服务暂时不可用，请稍后重试）', '⑬ fail-closed 文案逐字（§2.8 变体）');
    checks.eq(mysqlScalar(`SELECT COUNT(*) FROM payment_withdrawals WHERE user_id='${uWd.id}'`), rowsBeforeFail, '⑬ fail-closed 拒**零落行**（锁内事务整体回滚）');
    const startC = docker(['start', 'ftl-currency-service'], 60_000);
    checks.eq(startC.status, 0, '⑬ 恢复 currency-service（start）');
    currencyStopped = false;
    {
      const deadline = Date.now() + 90_000;
      let health = '';
      for (;;) {
        health = docker(['inspect', 'ftl-currency-service', '--format', '{{.State.Health.Status}}']).stdout.trim();
        if (health === 'healthy') break;
        if (Date.now() >= deadline) throw new ConformanceError(`⑬ currency-service 90s 未回 healthy（实际 ${health}）`);
        await sleep(1_000);
      }
    }
    checks.ok('⑬ currency-service 已恢复 healthy（fail-closed 窗口封闭）');
    clearUserBuckets(uWd.id);
    const wdControl = await postJson<{ withdrawNo: string; status: string }>('/api/pay/withdrawals', { coins: 1000 }, uWd.accessToken);
    expectHttp(checks, wdControl, 200, ErrCode.OK, '⑬ 恢复正对照：申请 1000 ⇒ 200 pending');
    const wdControlNo = wdControl.body?.data?.withdrawNo ?? '';
    const wdControlReject = await postJson<{ status: string }>(`/api/admin/pay/withdrawals/${wdControlNo}/review`, { action: 'reject', note: 'fixture 收尾' }, adminToken);
    expectHttp(checks, wdControlReject, 200, ErrCode.OK, '⑬ 正对照收尾：驳回 ⇒ 回滚（余额净零）');
    checks.eq(mysqlScalar(`SELECT status FROM payment_withdrawals WHERE withdraw_no='${wdControlNo}'`), 'rejected', '⑬ 正对照单终态 rejected（锚成对：hold+rb）');

    /* ── ⑭ 退款全链 ─────────────────────────────────────────────────────── */
    step('⑭ 退款全链：申请即冻结 ⇒ 审 ⇒ stub 退款 ⇒ refunded；驳回回滚；15006 双负例；渠道失败停 approved');
    const uRef = await registerUser(33);
    const r1 = await payAndCredit(uRef, 6, checks);
    clearUserBuckets(uRef.id);
    const rf1res = await postJson<{ refundNo: string; status: string }>('/api/pay/refunds', { orderNo: r1, reason: `t21 退款链 ${TAG}` }, uRef.accessToken);
    expectHttp(checks, rf1res, 200, ErrCode.OK, '⑭ 申请退款（对已入账单）');
    const rf1 = rf1res.body?.data?.refundNo ?? '';
    checks.eq(rf1res.body?.data?.status, 'pending', '⑭ 冻结成功 ⇒ pending');
    checks.eq(mysqlScalar(`SELECT channel_out_request_no FROM payment_refunds WHERE refund_no='${rf1}'`), rf1, '⑭ channel_out_request_no = refund_no（渠道幂等键）');
    const rf1flow = mysqlRows(`SELECT o.action_id, o.source, f.delta FROM currency_ops o JOIN currency_flows f ON f.op_id=o.id WHERE o.action_id='refund:${rf1}'`);
    checks.eq(rf1flow[0]?.join('|') ?? '', `refund:${rf1}|refund_hold|-600`, '⑭ 冻结流水逐字：refund_hold −600');

    const rf1dup = await postJson('/api/pay/refunds', { orderNo: r1, reason: 'dup' }, uRef.accessToken);
    expectHttp(checks, rf1dup, 409, ErrCode.PAY_REFUND_UNAVAILABLE, '⑭ 同单在途再申请');
    checks.that((rf1dup.body?.message ?? '').includes('处理中'), `⑭ 处理中文案变体 —— 实际 ${JSON.stringify(rf1dup.body?.message)}`);

    const balBeforeApprove = mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uRef.id}'`);
    const rf1approve = await postJson<{ refundNo: string; status: string }>(`/api/admin/pay/refunds/${rf1}/review`, { action: 'approve', note: `t21-${TAG}` }, adminToken);
    expectHttp(checks, rf1approve, 200, ErrCode.OK, '⑭ 审通过（同步渠道退款）');
    checks.eq(rf1approve.body?.data?.status, 'refunded', '⑭ 渠道成功 ⇒ refunded');
    const rf1row = mysqlRows(`SELECT status, active_slot, channel_refund_no IS NOT NULL, refunded_at IS NOT NULL FROM payment_refunds WHERE refund_no='${rf1}'`);
    checks.eq(rf1row[0]?.join('|') ?? '', 'refunded|1|1|1', '⑭ 终态行：refunded / **保留槽** 1 / 渠道单号有 / refunded_at 有');
    checks.eq(mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uRef.id}'`), balBeforeApprove, '⑭ 退款成功**零后续钱动作**（refund_hold 即实际扣减）');
    const stubRf1 = stubState();
    checks.eq(stubRf1.orders[r1]?.refundCalls?.[rf1], 1, '⑭ stub 侧 out_request_no 幂等记忆：恰 1 次调用');
    checks.eq(stubRf1.orders[r1]?.refunds?.[0]?.amount, '6.00', '⑭ stub 收到的退款金额 = 6.00（fen2yuan(600) 逐字）');
    checks.eq(mysqlScalar(`SELECT channel_refund_no FROM payment_refunds WHERE refund_no='${rf1}'`), stubRf1.orders[r1]?.trade_no ?? '', '⑭ channel_refund_no = 渠道 trade_no（响应取值语义）');

    clearUserBuckets(uRef.id);
    const rf1again = await postJson('/api/pay/refunds', { orderNo: r1, reason: 'again' }, uRef.accessToken);
    expectHttp(checks, rf1again, 409, ErrCode.PAY_REFUND_UNAVAILABLE, '⑭ 15006 负例：已退过再申请');
    checks.that((rf1again.body?.message ?? '').includes('已退过'), `⑭ 已退过文案变体（保留槽封死）—— 实际 ${JSON.stringify(rf1again.body?.message)}`);

    // R2：驳回回滚（第二笔 6 元订单——R1 不是 created ⇒ 不复用）。
    const r2 = await payAndCredit(uRef, 6, checks);
    const balBeforeR2 = mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uRef.id}'`);
    const rf2res = await postJson<{ refundNo: string; status: string }>('/api/pay/refunds', { orderNo: r2, reason: `t21 驳回回滚 ${TAG}` }, uRef.accessToken);
    expectHttp(checks, rf2res, 200, ErrCode.OK, '⑭ 第二单申请退款');
    const rf2 = rf2res.body?.data?.refundNo ?? '';
    const rf2reject = await postJson<{ refundNo: string; status: string }>(`/api/admin/pay/refunds/${rf2}/review`, { action: 'reject', note: '驳回' }, adminToken);
    expectHttp(checks, rf2reject, 200, ErrCode.OK, '⑭ 审驳回');
    checks.eq(rf2reject.body?.data?.status, 'rejected', '⑭ 驳回 ⇒ 回滚落账 ⇒ rejected');
    checks.eq(mysqlScalar(`SELECT active_slot IS NULL FROM payment_refunds WHERE refund_no='${rf2}'`), '1', '⑭ rejected 释槽');
    const rf2rb = mysqlRows(`SELECT o.action_id, o.source, f.delta FROM currency_ops o JOIN currency_flows f ON f.op_id=o.id WHERE o.action_id='refund_rb:${rf2}'`);
    checks.eq(rf2rb[0]?.join('|') ?? '', `refund_rb:${rf2}|refund_rollback|600`, '⑭ 回滚流水逐字：refund_rb +600');
    checks.eq(mysqlScalar(`SELECT balance FROM currency_accounts WHERE owner_id='${uRef.id}'`), balBeforeR2, '⑭ 回滚后余额复原');

    // 15006「未入账」负例（U_ORDER 的 328 元 created 单）⇒ 收尾 SQL 关单。
    clearUserBuckets(uOrder.id);
    const rfUncredited = await postJson('/api/pay/refunds', { orderNo: orderECreated.orderNo, reason: 'uncredited' }, uOrder.accessToken);
    expectHttp(checks, rfUncredited, 409, ErrCode.PAY_REFUND_UNAVAILABLE, '⑭ 15006 负例：未入账单申请退款');
    checks.that((rfUncredited.body?.message ?? '').includes('未入账'), `⑭ 未入账文案变体 —— 实际 ${JSON.stringify(rfUncredited.body?.message)}`);
    mysqlQuery(`UPDATE payment_orders SET status='closed', closed_at=NOW(3) WHERE order_no='${orderECreated.orderNo}'`);

    // 渠道失败停 approved：R4 + stub fail-refund ⇒ 网关 5s 先掐断（503/10007），服务端继续退避（登记）。
    clearUserBuckets(uRef.id);
    const r4 = await payAndCredit(uRef, 128, checks);
    clearUserBuckets(uRef.id);
    const rf4res = await postJson<{ refundNo: string; status: string }>('/api/pay/refunds', { orderNo: r4, reason: `t21 渠道失败 ${TAG}` }, uRef.accessToken);
    expectHttp(checks, rf4res, 200, ErrCode.OK, '⑭ 第三单申请退款（渠道失败组）');
    const rf4 = rf4res.body?.data?.refundNo ?? '';
    const failCfg = JSON.parse(stubControl(`/_control/fail-refund?out_request_no=${rf4}&on=1`)) as { ok: boolean };
    checks.that(failCfg.ok === true, '⑭ stub 已配置该 out_request_no 业务拒绝');
    const stubRefundCallsBefore = stubState().counters.refund ?? 0;
    const approveHang = await postJson(`/api/admin/pay/refunds/${rf4}/review`, { action: 'approve', note: '渠道失败组' }, adminToken);
    expectHttp(checks, approveHang, 503, ErrCode.UPSTREAM_UNAVAILABLE, '⑭ 审批长挂：网关 5s 先掐断（503/10007；服务端继续退避——登记）');
    await pollSql(`SELECT status FROM payment_refunds WHERE refund_no='${rf4}'`, (v) => v === 'approved', '⑭ 渠道失败停 approved', 15_000, 1_000);
    checks.eq(mysqlScalar(`SELECT active_slot FROM payment_refunds WHERE refund_no='${rf4}'`), '1', '⑭ 渠道失败槽**不释放**（钱已冻结）');
    checks.that((stubState().counters.refund ?? 0) >= stubRefundCallsBefore + 1, `⑭ stub 侧已收到渠道退款第 1 发（业务拒绝）—— 实际 ${stubState().counters.refund}`);
    await sleep(2_500);
    checks.eq(mysqlScalar(`SELECT status FROM payment_refunds WHERE refund_no='${rf4}'`), 'approved', '⑭ 2.5s 后仍在 approved（就地退避重试进行中，非终态落地）');
    checks.that((stubState().counters.refund ?? 0) >= stubRefundCallsBefore + 2, `⑭ 退避第 2 发已到 stub（1s 间隔逐字）—— 实际 ${stubState().counters.refund}`);

    /* ── ⑮ 权限矩阵 + 审计第六源 + CSV 字节 ──────────────────────────────── */
    step('⑮ 权限矩阵（operator 读通/写 403；finance 写面过 policy 落 15009）+ 第六源 + 两路 CSV 字节');
    const operName = `t21oper-${TAG}`;
    const finName = `t21fin-${TAG}`;
    const oneTimePw = `t21-${TAG}-passw0rd`;
    const crOper = await postJson<{ id: number }>('/api/admin/accounts', { username: operName, password: oneTimePw, role: 'operator' }, adminToken);
    expectHttp(checks, crOper, 200, ErrCode.OK, '⑮ 建一次性 operator 账号');
    const crFin = await postJson<{ id: number }>('/api/admin/accounts', { username: finName, password: oneTimePw, role: 'finance' }, adminToken);
    expectHttp(checks, crFin, 200, ErrCode.OK, '⑮ 建一次性 finance 账号');
    const operToken = await loginAdminAs(operName, oneTimePw);
    const finToken = await loginAdminAs(finName, oneTimePw);
    checks.that(operToken.length > 0 && finToken.length > 0, '⑮ 两账号登录成功（401 面之外的正对照）');

    const mRead1 = await getJson('/api/admin/pay/orders', operToken);
    expectHttp(checks, mRead1, 200, ErrCode.OK, '⑮ operator 读 P-p1（orders）⇒ 200（读面任意角色）');
    const mRead2 = await getJson('/api/admin/pay/actions', operToken);
    expectHttp(checks, mRead2, 200, ErrCode.OK, '⑮ operator 读 P-p4（actions）⇒ 200');
    const mDeny1 = await postJson(`/api/admin/pay/refunds/${rf2}/review`, { action: 'reject' }, operToken);
    checks.eq(mDeny1.status, 403, '⑮ operator 写 P-p5（退款审）⇒ 403（policy 拒）');
    checks.eq(mysqlScalar(`SELECT status FROM payment_refunds WHERE refund_no='${rf2}'`), 'rejected', '⑮ 403 拒后行态不动（拒在网关，没到服务）');
    const mDeny2 = await postJson(`/api/admin/pay/withdrawals/${wdNo1}/confirm`, { voucher: 'x' }, operToken);
    checks.eq(mDeny2.status, 403, '⑮ operator 写 P-p7（打款登记）⇒ 403');
    const mFin1 = await postJson(`/api/admin/pay/refunds/${rf2}/review`, { action: 'reject' }, finToken);
    expectHttp(checks, mFin1, 409, ErrCode.PAY_STATE_CONFLICT, '⑮ finance 写 P-p5 ⇒ 过 policy、落服务端 15009（正对照）');
    const mFin2 = await postJson(`/api/admin/pay/withdrawals/${wdNo1}/confirm`, { voucher: 'x' }, finToken);
    expectHttp(checks, mFin2, 409, ErrCode.PAY_STATE_CONFLICT, '⑮ finance 写 P-p7 ⇒ 过 policy、落 15009');
    const mAnon = await getJson('/api/admin/pay/orders');
    checks.eq(mAnon.status, 401, '⑮ 无令牌 ⇒ 401（管理面第一道门）');

    const actions = await getJson<{ items: Array<Record<string, unknown>> }>(`/api/admin/pay/actions?from=${RUN_START_MS}&actor=admin`, adminToken);
    expectHttp(checks, actions, 200, ErrCode.OK, '⑮ 第六源 actions 读（from=本 run 起 + actor=admin）');
    const actItems = actions.body?.data?.items ?? [];
    checks.that(actItems.length > 0, `⑮ 第六源非空（本 run 的处置事件流）—— 实际 ${actItems.length} 行`);
    checks.eq(Object.keys(actItems[0] ?? {}).sort().join(','), 'actor,at,detail,kind,refNo', '⑮ 事件行投影恰五键（at/actor/kind/refNo/detail）');
    const findByRef = (kind: string, refNo: string): Record<string, unknown> | undefined =>
      actItems.find((r) => r.kind === kind && r.refNo === refNo);
    checks.that(findByRef('confirmed', wdNo1) !== undefined, `⑮ 第六源含 confirmed 事件（打款登记 refNo=${wdNo1}）`);
    checks.that(findByRef('rejected', rf2) !== undefined, `⑮ 第六源含 rejected 事件（退款驳回 refNo=${rf2}）`);
    checks.that(findByRef('approved', rf1) !== undefined, `⑮ 第六源含 approved 事件（退款通过 refNo=${rf1}）`);
    checks.that(actItems.every((r) => typeof r.actor === 'string' && (r.actor as string).length > 0), '⑮ 每行 actor 非空（留痕纪律；绝不回退值）');

    const csvOrders = await fetchCsvRaw('/api/admin/pay/orders.csv', adminToken);
    csvByteChecks(checks, csvOrders, '⑮ orders.csv', 'pay-orders', [
      'order_no,user_id,package_yuan,amount_fen,coins,status,channel,trade_no,paid_at,credited_at,closed_at,created_at',
      orderA.orderNo,
    ]);
    const csvActions = await fetchCsvRaw('/api/admin/pay/actions.csv', adminToken);
    csvByteChecks(checks, csvActions, '⑮ actions.csv', 'pay-actions', [
      'at,actor,kind,ref_no,detail',
      wdNo1,
    ]);

    // 一次性账号**停用**（照 slice-19「只停用不删、停用不偷渡」；两账号均 active 角色，不得留作活跃凭据）。
    const disOper = await sendPatch(`/api/admin/accounts/${crOper.body?.data?.id}`, { status: 'disabled' }, adminToken);
    expectHttp(checks, disOper, 200, ErrCode.OK, '⑮ 收尾：停用一次性 operator 账号');
    const disFin = await sendPatch(`/api/admin/accounts/${crFin.body?.data?.id}`, { status: 'disabled' }, adminToken);
    expectHttp(checks, disFin, 200, ErrCode.OK, '⑮ 收尾：停用一次性 finance 账号');
    const accountsList = await getJson<{ accounts: Array<{ username: string; status: string }> }>('/api/admin/accounts', adminToken);
    const stillActive = (accountsList.body?.data?.accounts ?? []).filter(
      (a) => (a.username === operName || a.username === finName) && a.status === 'active',
    );
    checks.that(stillActive.length === 0, `⑮ 收尾：两一次性账号均已 disabled（不得留活跃凭据）—— 实际残留 ${JSON.stringify(stillActive)}`);

    /* ── ⑯ 日自检指标（SQL 造孤儿锚 ⇒ 秒级 >0 ⇒ 清脏回 0）──────────────────── */
    step('⑯ 日自检：造孤儿锚 ⇒ 2s 循环内 payment_reconcile_diff > 0 ⇒ 删除 ⇒ 回 0（两跳互证基线）');
    const diffRead = (): number => {
      const m = seriesValue(paymentMetrics(), 'payment_reconcile_diff', {});
      return m ?? 0;
    };
    // ⚠️ **不做「先断言基线 0」的第三跳**：循环重启后首跑要 30s（⑬ 冻扫窗口重建过容器），
    //    「0 读数」无法与「循环还没跑」区分 ⇒ 那一条会**周期性空转通过**。裁决改由两跳承担：
    //    「造脏 ⇒ >0」（循环真在跑，否则超时红） + 「清脏 ⇒ 0」（本 run 全部写面无残留）。
    info(`⑯ 起手 diff 读数 = ${diffRead()}（信息性——裁决见下两跳）`);
    const orphanAnchor = `pay:t21orphan${TAG}`;
    mysqlQuery(`INSERT INTO currency_ops (action_id, request_hash, source, created_at) VALUES ('${orphanAnchor}', '${'a'.repeat(64)}', 'recharge', NOW(3))`);
    {
      // 45s 窗复算（本片 ⚙️9 换源后）：30s 首跑常数 + 2s 一轮（pay.reconcileIntervalMs=2000 解析值）
      // + 等待 ≤10s 增量 ≈ 42s ≤ 45s。⑯ 距 ⑬ 还原重建已隔 ⑭/⑮（分钟级）⇒ 实际命中为秒级，窗为上界。
      const deadline = Date.now() + 45_000;
      let v = diffRead();
      while (v === 0 && Date.now() < deadline) {
        await sleep(1_000);
        v = diffRead();
      }
      checks.that(v > 0, `⑯ 孤儿锚插入 ⇒ 秒级内 diff > 0（pay.reconcileIntervalMs=2000 配置基线的观测路径）—— 实际 ${v}`);
    }
    mysqlQuery(`DELETE FROM currency_ops WHERE action_id='${orphanAnchor}'`);
    {
      const deadline = Date.now() + 25_000;
      let v = diffRead();
      while (v !== 0 && Date.now() < deadline) {
        await sleep(1_000);
        v = diffRead();
      }
      checks.eq(v, 0, '⑯ 清脏 ⇒ diff 回 0（同时证明：本 run 全部写面勾稽一致——告警 PaymentReconcileDiff 的复位面）');
    }

    /* ── ⑰ 回调防护（经门口）─────────────────────────────────────────────── */
    step('⑰ 回调防护：非 POST⇒405 · 非 form⇒415 · >16KB⇒413 · 边缘单桶 INCR 自证 ⇒ 429');
    const g405 = await edgeRequest('GET', NOTIFY_PATH, null);
    checks.eq(g405.status, 405, '⑰ GET ⇒ 405（方法闸）');
    checks.eq(g405.body, 'failure', '⑰ 405 应答词封闭（两词域）');
    const g415 = await edgeRequest('POST', NOTIFY_PATH, JSON.stringify({ a: 1 }), 'application/json');
    checks.eq(g415.status, 415, '⑰ json body ⇒ 415（内容类型闸）');
    checks.eq(g415.body, 'failure', '⑰ 415 应答词封闭');
    const big = `x=${'a'.repeat(17 * 1024)}`;
    const g413 = await edgeRequest('POST', NOTIFY_PATH, big);
    checks.eq(g413.status, 413, '⑰ 17KB body ⇒ 413（体积闸 ≤16KB；fail-closed 一侧）');
    // 先清桶（TTL 内旧键会让「记账自证」空转——07.3 同款纪律），并证明 405/415/413 **不计入**桶。
    redisLines(['DEL', 'pay:notify:rate']);
    checks.eq(redisLines(['GET', 'pay:notify:rate']).length, 0, '⑰ 起手：pay:notify:rate 已清（记账自证非空转）');
    await edgeRequest('GET', NOTIFY_PATH, null);
    await edgeRequest('POST', NOTIFY_PATH, JSON.stringify({ a: 1 }), 'application/json');
    checks.eq(redisLines(['GET', 'pay:notify:rate']).length, 0, '⑰ 405/415 **零计数副作用**（闸在桶之前）');
    for (let i = 0; i < 3; i++) await deliverNotify('a=b&sign=x');
    checks.eq(redisLines(['GET', 'pay:notify:rate']).join(''), '3', '⑰ 3 发 form POST ⇒ 桶计数 = 3（INCR 记账自证）');
    redisLines(['SET', 'pay:notify:rate', '600']);
    const g429 = await deliverNotify('a=b&sign=x');
    checks.eq(g429.status, 429, '⑰ 超边缘单桶（600/分）⇒ 429');
    checks.eq(g429.body, 'failure', '⑰ 429 应答词封闭');
    redisLines(['DEL', 'pay:notify:rate']);
    checks.eq(redisLines(['GET', 'pay:notify:rate']).length, 0, '⑰ 桶已复位（不给下一片留限流余温）');

    /* ── ⑱ 三族 mine 真栈翻页（>20 行；cursor 严格读的真 SQL 面）────────────── */
    step('⑱ 三族 mine 翻页：各造 21 行（同 created_at ⇒ 边界砸 id 平手分支）⇒ 两跳零重叠、行集全等');
    const uMine = await registerUser(37);
    const pgOrders: string[] = [];
    const pgWithdraws: string[] = [];
    const pgRefunds: string[] = [];
    for (let i = 0; i < 21; i++) {
      const suffix = `${TAG}${String(i).padStart(2, '0')}`;
      pgOrders.push(`pay_t21pg${suffix}`);
      pgWithdraws.push(`wd_t21pg${suffix}`);
      pgRefunds.push(`rf_t21pg${suffix}`);
    }
    insertPagingRows(
      'payment_orders',
      'order_no, user_id, package_yuan, amount_fen, coins, coin_per_yuan, status, expires_at, created_at',
      pgOrders.map((no) => `('${no}', '${uMine.id}', 6, 600, 600, 100, 'closed', NOW(3) - INTERVAL 1 DAY, NOW(3))`),
    );
    insertPagingRows(
      'payment_withdrawals',
      'withdraw_no, user_id, coins, amount_fen, status, timeout_at, created_at',
      pgWithdraws.map((no) => `('${no}', '${uMine.id}', 100, 100, 'paid', NOW(3) + INTERVAL 72 HOUR, NOW(3))`),
    );
    insertPagingRows(
      'payment_refunds',
      'refund_no, order_no, user_id, amount_fen, coins, status, reason, channel_out_request_no, active_slot, created_at',
      // ⚠️ 每行**各自的** order_no（`uk_refunds_order_active` = (order_no, active_slot)——
      //    21 行共用同一 order_no + slot=1 会当场撞 UK；每行对一单是最自然的终态形状）。
      pgRefunds.map((no, i) => `('${no}', '${pgOrders[i]}', '${uMine.id}', 100, 100, 'refunded', 't21 paging probe', '${no}', 1, NOW(3))`),
    );

    /** 一族翻页断言（定长 8 条）：20+1 两跳 / 零重叠 / 行集全等 / 次页恰为插入首行 / 投影键集。 */
    const pagingChecks = async (
      label: string,
      path: string,
      idOf: (r: Record<string, unknown>) => string,
      inserted: readonly string[],
      rowKeys: string,
    ): Promise<void> => {
      const page1 = await getJson<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(`${path}?limit=20`, uMine.accessToken);
      checks.eq(page1.status, 200, `⑱ ${label} 第一页 ⇒ HTTP 200`);
      const items1 = page1.body?.data?.items ?? [];
      const cur1 = page1.body?.data?.nextCursor ?? null;
      checks.eq(items1.length, 20, `⑱ ${label} 第一页恰 20 行（>20 才有 hasMore——本片要砸的就是这条分支）`);
      checks.that(typeof cur1 === 'string' && cur1.length > 0, `⑱ ${label} 第一页 nextCursor 非空（严格读 id + 真 SQL 游标条件由下一跳见证）`);
      const page2 = await getJson<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(`${path}?limit=20&cursor=${encodeURIComponent(cur1 ?? '')}`, uMine.accessToken);
      checks.eq(page2.status, 200, `⑱ ${label} 第二页（带 cursor 的真查）⇒ HTTP 200`);
      const items2 = page2.body?.data?.items ?? [];
      checks.eq(items2.length, 1, `⑱ ${label} 第二页恰 1 行（21 行全等分页的余数）`);
      const ids1 = items1.map(idOf);
      const ids2 = items2.map(idOf);
      checks.eq(ids2[0] ?? '', inserted[0] ?? '', `⑱ ${label} 第二页 = 插入首行（同 created_at ⇒ id 平手分支在页界被真实执行）`);
      checks.that(ids2.every((v) => !ids1.includes(v)), `⑱ ${label} 两页零重叠 —— 交集 ${JSON.stringify(ids2.filter((v) => ids1.includes(v)))}`);
      checks.eq([...ids1, ...ids2].sort().join(','), [...inserted].sort().join(','), `⑱ ${label} 两页并集 = 插入的 21 行全等`);
      checks.eq(Object.keys(items1[0] ?? {}).sort().join(','), rowKeys, `⑱ ${label} 行投影键集逐字（${rowKeys}）`);
      checks.eq(page2.body?.data?.nextCursor, null, `⑱ ${label} 第二页 nextCursor=null（终页）`);
    };
    await pagingChecks('orders', '/api/pay/orders/mine', (r) => String(r.orderNo), pgOrders, 'amountYuan,closedAt,coins,createdAt,creditedAt,orderNo,packageYuan,paidAt,status');
    await pagingChecks('withdrawals', '/api/pay/withdrawals/mine', (r) => String(r.withdrawNo), pgWithdraws, 'amountYuan,coins,confirmedAt,createdAt,reviewNote,reviewedAt,rolledBackAt,status,timeoutAt,withdrawNo');
    await pagingChecks('refunds', '/api/pay/refunds/mine', (r) => String(r.refundNo), pgRefunds, 'amountYuan,coins,createdAt,orderNo,reason,refundNo,refundedAt,reviewNote,reviewedAt,status');
    const badCursor = await getJson('/api/pay/orders/mine?cursor=%25%25%25bad%23%23%23', uMine.accessToken);
    expectHttp(checks, badCursor, 400, ErrCode.BAD_PARAM, '⑱ 非法游标 ⇒ 10001（游标先于任何查询校验）');

    return checks;
  } finally {
    /* ── 收尾（异常路径也执行；每步吞异常——清理不许顶掉结论）───────────────── */
    try {
      for (const sql of syntheticHoldings) mysqlQuery(sql);
    } catch { /* 清理路径吞错 */ }
    try {
      redisLines(['DEL', 'pay:notify:rate']);
    } catch { /* redis 不可达时无键可清 */ }
    if (currencyStopped) {
      try {
        docker(['start', 'ftl-currency-service'], 60_000);
        info('收尾：currency-service 已兜底 start（fail-closed 段异常路径）');
      } catch { /* 兜底 */ }
    }
    if (adminToken.length === 0) {
      // 极早期失败（admin 未登录）⇒ 尽力补登，好把开关归一；登不上则交给下一轮 ⓪ 归一。
      try {
        adminToken = await adminLogin();
      } catch { /* 兜底 */ }
    }
    try {
      if (adminToken.length > 0) {
        await adminPutConfig('pay.rechargeEnabled', false, adminToken);
        await adminPutConfig('pay.withdrawEnabled', false, adminToken);
        info('收尾：pay.rechargeEnabled/withdrawEnabled 已复原 false（兜底）');
      }
    } catch { /* 兜底 */ }
  }
}

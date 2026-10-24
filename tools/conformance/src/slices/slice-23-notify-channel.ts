/**
 * conformance 用例：**通知通道管理化**（`slice-23-notify-channel`；规格 §5.2 的 ①–⑪ 十一组 + 收尾）。
 *
 * ─── 判据载体（真栈面）────────────────────────────────────────────────────────
 *  - 九键（SMTP 五 + IM 四）唯一落点 = config-service 的 `notify_channel_config`（管理三端点 +
 *    专用 RPC `config.notifyChannel.get`）；两消费面不相交（⚙️1）：alert-relay 拉四 IM 键
 *    （30s 轮询、拉后即裁、last-good 落 `/data/notify-config.json`）、am-renderer 拉五邮件键
 *    （渲染 `/alertmanager-live/alertmanager.yml` 共享卷 + 原地 `/-/reload`）。
 *  - 投递 stub = 本片①自起的 `node:20-alpine` 内联 HTTP 收集端（挂 `pokergame_ftl-platform`
 *    网络 ⇒ relay 按容器名直投；`/_received` 回读、按**路径分桶**，一律 **delta 口径**）。
 *    种子/探针值全部圈在 stub 与不可解析域内；hint 探针轮的**真实平台域**短暂在位
 *    （该轮不触发投递——⑥ 首步以「/data 含四 IM 种子值」为界，注入发生时活性槽全是 stub）。
 *  - relay 投递触发的观察步**一律直打 `/webhook`**（`fetch` + Bearer + 合成 AM payload，
 *    同步扇出、确定性）；**仅 ⑥ 首步**经 AM API 注入一次全链（`POST /api/v2/alerts`、
 *    alertname 互异、短 `endsAt`、≤45s 有界轮询）——判据台新机制、全仓 0 先例（登记）。
 *    resolved 通知（`endsAt` 到期后、受 `group_interval` 节流多投一次）只可能落在**当时活性**
 *    的槽位上 ⇒ 一切负向断言（已停用路径「计数不变」）免疫；正向断言除 ⑥ 首步外全走**同步**
 *    直打（无窗口重叠面），⑥ 首步的 ≤45s 窗在任何 resolved 通知（≥注入 +5.5min）之前。
 *  - AM 侧观测 = `/api/v2/status`（内存已载配置的 redacted 原文——reload 成功的真凭据）
 *    + 卷 yml（`docker exec` 容器内读）。gauge 面 = config-service 9006（exec+Bearer，照
 *    slice-16 C1）；规则面 = Prometheus `/api/v1/alerts`（照 slice-16 有界轮询先例）。
 *
 * ─── 十一组（组序与状态链；未列组沿用前组末态——规格 §5.2 前言）────────────────────
 *  ① 种子回读与取值（前置 = 空/脏库任意；末态 = 九键种子态）：九键 PUT ⇒ GET 顺序/标签逐字、
 *    密键 value=null+指纹、四非密键明文；hint 六例独立 PUT/GET 探针轮（三平台 origin +
 *    example.com + 两仿冒 → 外部地址；完成即 PUT 回种子）。
 *  ② 不进广播（前置 = ①末态，无状态变更）：snapshot 无 `notify.` 且恰 65 键 · /api/config 恰
 *    20 键 · 三容器（AM/relay/renderer）env 无退役九键。
 *  ③ 静态加密（前置 = ①末态）：SQL 直查 value_enc 全 `v1:` 前缀、无任一值明文子串。
 *  ④ 审计脱敏（前置 = ①末态）：本组含 smtp.pass「清空+回写」一轮（清空行形态的唯一来源）；
 *    密键行无原文+redacted 对象+actor；四非密行落原文；SQL `JSON_TYPE(new_value)='NULL'`。
 *  ⑤ 权限矩阵四段式（前置 = ①末态；末态 = ①末态）：非 SA×四变体×两方法 403；SA 字面/%2E/%55/
 *    混合大小写 200（%4B→未知键一格 400）；%2F/裸/尾斜杠 403（含 SA）；GET 任意角色 200；
 *    近邻 `PUT /api/admin/config/notify.*` ⇒ 400；SA 正格 DELETE smtp.host + 组内回写自证。
 *  ⑥ relay 端到端（前置 = ①末态；末态 = IM 零键、SMTP 5/5）：AM 注入 ProbeWecomA 全链 ⇒
 *    换址/删址/半配/清空四形态（直打观察 + WARN 逐字）。
 *  ⑦ AM 渲染端到端（前置 = ⑥末态；末态 = SMTP 4/5、IM 零键）：PUT 五键 ⇒ 卷 yml 逐字/status/
 *    amtool ⇒ DELETE pass ⇒ 邮件段消失（reload 成功）。
 *  ⑧ 回落（前置 = ⑧自种四 IM 键；末态 = IM 四键·SMTP 4/5·config 恢复）：a–e 五形态 + /data 断言。
 *  ⑨ fail-closed（前置 = ⑧末态；末态 = ⑧末态）：空主钥窗口 ⇒ 503 逐字/10007/其余面照常 ⇒ 恢复。
 *  ⑩ gauge/规则（前置 = SMTP 4/5）：4/5 ⇒ gauge 4+0 + 规则 pending|firing（≤120s）+ 负例 ⇒
 *    补第 5 键 ⇒ 1 ⇒ 清空 ⇒ 0/0（末态 = 邮件 0/0）。
 *  ⑪ 日志无凭据（前置 = ⑩末态）：三容器（relay/renderer/config-service——不含 AM）窗口 grep
 *    needle 集全空 + 逐容器正向对照 + 判别力自证。
 *  收尾：九键全 DELETE ⇒ ≤90s 收敛自证（卷 yml 回 baseline 且 reload 成功；relay 零槽 +
 *    `/data`=`{}`）；stub 停；注入告警自然过期（`endsAt` 短）。
 *
 * ─── 副作用与复原（登记）────────────────────────────────────────────────────
 *  - 命名卷 `alertmanager-live`/`relay-data` 跨 run 延续：崩在 ⑦–收尾之间的轮次可能留下
 *    `smtp.invalid` 的卷 yml，下一轮首拉 ≤30s 收敛；AM 以其启动无害（smtp.invalid 只在真发信
 *    时失败）。`finally` 兜底 DELETE 九键 + 停 stub + 复原 config-service/主钥/一次性账号。
 *  - ⑧/⑨ 重建容器（relay×2 / renderer×1 / config-service×2）；compose 插值走 runner env
 *    （`run.ts` 的 `??=` 供给 `NOTIFY_CHANNEL_PULL_TOKEN`；`PAY_CONFIG_ENC_KEY`/`ADMIN_PASSWORD`
 *    按现容器 pick 随行透传）。
 *  - ⑤ 一次性管理账号三枚（`s23*` 前缀）：只停用不删（留档，照 slice-19/22）。
 *
 * ─── 零 skip、零数据依赖分支（基线回填的前提）──────────────────────────────────
 *  全部断言在任何环境下都执行；行集断言一律定长（本片自己写入的行数确定）或先聚合后单条；
 *  对「脏库残留」的口径 = 审计一律走 `from=RUN_START` 窗口过滤，首写 old 值不设等值期望
 *  （空/null 两形态都合法）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  GATEWAY_URL,
  INTERNAL_TOKEN,
  adminGetConfig,
  adminLogin,
  adminNotifyChannelDelete,
  adminNotifyChannelGet,
  adminNotifyChannelPut,
  getJson,
  postJson,
  registerUser,
  type Envelope,
  type HttpResult,
} from '../lib/http';
import { redisLines } from '../lib/redis';
import { CONFIG_RPC, rpcCall } from '../lib/rpc';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-16/22）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/* ── 真栈坐标（dev 形态发布口——与 slice-16 同款）───────────────────────────── */
const RELAY_URL = process.env.RELAY_URL ?? 'http://localhost:8090';
const AM_URL = process.env.AM_URL ?? 'http://localhost:9093';
const PROM_URL = process.env.PROM_URL ?? 'http://localhost:9090';
const RELAY_CONTAINER = 'ftl-alert-relay';
const RENDERER_CONTAINER = 'ftl-am-renderer';
const AM_CONTAINER = 'ftl-alertmanager';
const CFG_CONTAINER = 'ftl-config-service';
/** 平台网络（stub 挂它 ⇒ relay 按容器名直投；与 slice-16 的 A5 同值）。 */
const COMPOSE_NETWORK = 'pokergame_ftl-platform';
/** stub 内监听端口（容器命名空间内，与栈内端口不撞；照 slice-16）。 */
const STUB_PORT = 18990;
const STUB_IMAGE = 'node:20-alpine';
/** 本 run 的探针前缀（stub 名唯一 ⇒ 种子 URL 唯一 ⇒ /data 里出现它必属本 run 的拉取）。 */
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`;
const PROBE_PREFIX = `ftl-probe-${RUN_ID}`;
const STUB_NAME = `${PROBE_PREFIX}-stub`;
const STUB_BASE = `http://${STUB_NAME}:${STUB_PORT}`;

/* ── 键空间/文案（§2.4/§2.9 逐字；**字面写死 = wire 级断言**，不引实现常量）────── */

/** ⚙️1 九键（顺序即契约：UI 显示序与拉取地图组装序）。 */
const NOTIFY_KEY_ORDER = [
  'notify.smtp.host',
  'notify.smtp.port',
  'notify.smtp.user',
  'notify.smtp.pass',
  'notify.email.to',
  'notify.webhook.feishuUrl',
  'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl',
  'notify.webhook.dingtalkSecret',
] as const;
type NotifyKey = (typeof NOTIFY_KEY_ORDER)[number];

/** §2.4 label 逐字（键序 = ⚙️1）。 */
const NOTIFY_LABELS: Record<NotifyKey, string> = {
  'notify.smtp.host': '邮件服务器',
  'notify.smtp.port': '邮件端口',
  'notify.smtp.user': '邮件账号',
  'notify.smtp.pass': '邮件授权码',
  'notify.email.to': '告警收件地址',
  'notify.webhook.feishuUrl': '飞书机器人地址',
  'notify.webhook.wecomUrl': '企业微信机器人地址',
  'notify.webhook.dingtalkUrl': '钉钉机器人地址',
  'notify.webhook.dingtalkSecret': '钉钉加签密钥',
};

/** 五密键（⚙️1 机密集；NOTIFY_CHANNEL_SECRET_KEYS 的字面副本 = wire 级）。 */
const SECRET_KEYS: readonly NotifyKey[] = [
  'notify.smtp.pass',
  'notify.webhook.feishuUrl',
  'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl',
  'notify.webhook.dingtalkSecret',
];
/** 四非密键（读口给明文）。 */
const PLAIN_KEYS: readonly NotifyKey[] = ['notify.smtp.host', 'notify.smtp.port', 'notify.smtp.user', 'notify.email.to'];
/** 四 IM 键（relay 消费面）。 */
const IM_KEYS: readonly NotifyKey[] = [
  'notify.webhook.feishuUrl',
  'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl',
  'notify.webhook.dingtalkSecret',
];

/**
 * 种子值逐键（①钉死；可达面全部圈在 stub 与不可解析域内）。⚠️ stub 名带本 run 的唯一 id
 * ⇒ 种子 URL 逐字唯一（脏卷/连跑第二轮的 /data、审计、日志都用它当「本 run 产物」的判据）。
 */
const SEED_VALUES: Record<NotifyKey, string> = {
  'notify.smtp.host': 'smtp.invalid',
  'notify.smtp.port': '465',
  'notify.smtp.user': 'probe@example.invalid',
  'notify.smtp.pass': 'probe-pass',
  'notify.email.to': 'probe@example.invalid',
  'notify.webhook.feishuUrl': `${STUB_BASE}/feishu`,
  'notify.webhook.wecomUrl': `${STUB_BASE}/wecom`,
  'notify.webhook.dingtalkUrl': `${STUB_BASE}/dingtalk`,
  'notify.webhook.dingtalkSecret': 'probe-dingtalk-secret',
};
/** ⑥ 换址轮的 wecom 第二地址（stub 的 `/wecom2` 路径——分桶断言靠「路径逐字」）。 */
const WECOM2 = `${STUB_BASE}/wecom2`;
/** ⑤ SA 正格的临时端口值（合法、组内复原为 465）。 */
const TEMP_PORT = '587';

/** 退役九 env（§2.6；② 的防回流负断言对象）。 */
const RETIRED_ENV_NAMES = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ALERT_EMAIL_TO',
  'FEISHU_WEBHOOK_URL', 'DINGTALK_WEBHOOK_URL', 'DINGTALK_SECRET', 'WECOM_WEBHOOK_URL',
] as const;

/* §2.9 逐字文案（判据面 = 在场/等值；文案不含值由构造保证）。 */
const HALF_CONFIG_WARN = '钉钉 URL 与加签密钥须成对（当前半配）——该槽位已停用';
const MASTER_KEY_503_MESSAGE = '通知通道密钥存储未启用（缺主钥）';
const RPC_DISABLED_MESSAGE = '通知通道密钥存储未启用';
const NO_SINKS_BODY = 'no sinks configured';
const UNAVAILABLE_BODY = 'notify config unavailable';

/** 本 run 起始（审计窗口过滤；脏卷上把上一轮的行挡在外面）。 */
const RUN_START_MS = Date.now();
const RUN_START_SEC = Math.floor(RUN_START_MS / 1000);
/** 本 run 唯一后缀（账号/自证串用；同栈连跑两轮不互撞）。 */
const TAG = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(-8);

/** 值指纹 = `sha256(值) hex 前 12`（§2.3；服务侧同口径——本片全部指纹断言由此独立复算）。 */
const fpOf = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

/**
 * 拉取令牌（runner 供给链：`run.ts` 启动处 `??=` —— **必须惰性读**：slice 模块顶层先于
 * run.ts 模块体求值，顶层捕获会在 `??=` 之前拿到 undefined）。
 */
function pullToken(): string {
  return process.env.NOTIFY_CHANNEL_PULL_TOKEN || '';
}

/* ──────────────────────────────────────────────────────────────────────────
 * docker / compose / mysql / stub 助手（形态先例：slice-16/22）
 * ────────────────────────────────────────────────────────────────────────── */

interface CommandResult {
  code: number;
  out: string;
}

/** 跑一条 `docker` 命令（带超时 + MSYS 防路径转写；照 slice-16/22）。 */
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
 * `docker compose …`（`extraEnv` 覆盖宿主 env；照 slice-14/22 的同名助手）。
 * ⑧/⑨ 的重建全走它——`env: {...process.env, ...extraEnv}` 让 run.ts 供给的
 * `NOTIFY_CHANNEL_PULL_TOKEN`（§5.4 供给链）随每次重建照常透传，仅显式覆盖项生效。
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

/** `docker compose exec -T <service> …`（`-T` 不能省；照 slice-19/22）。 */
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
 * 照 slice-14/22 先例；不要裸写反引号（容器 sh 会当命令替换）。
 */
function mysqlQuery(sql: string): CommandResult {
  return exec('mysql', 'sh', '-c', `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4 "$MYSQL_DATABASE" -N -e "${sql}"`);
}

/** SQL 读**末行文本**（剥 mysql 密码告警行；空 ⇒ 抛，不把空串装成值；照 slice-19/22）。 */
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

/** 自切片起点的秒数（日志窗口 `--since`；+2s 余量）。 */
function sinceRunStartSec(): number {
  return Math.ceil((Date.now() - RUN_START_MS) / 1000) + 2;
}

/** 某容器最近 sinceSec 秒的日志（直用 `docker logs`；本栈应用侧输出无 ANSI——无需剥色）。 */
function containerLogs(container: string, sinceSec: number): string {
  const r = docker(['logs', '--since', `${sinceSec}s`, container], 20_000);
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/**
 * 同一份 grep 逻辑（⑪ 的判别力自证与真实判定**共用**——合成输入必命中、真实日志零命中，
 * 两条走的是同一个 `includes` 扫描，不允许「自证用另一套」；照 slice-22）。
 */
function grepHits(text: string, needles: readonly string[]): string[] {
  return needles.filter((n) => n.length > 0 && text.includes(n));
}

/**
 * 清管理写桶（`ratelimit:admin-write:<sha256(token)[:16]>`；键指纹算法 = 网关 `adminTokenFp`）。
 * 本片管理写面数百次（阈值 ADMIN_WRITE = 30/5min）⇒ 在每个写突发前清一次，防 429 假红
 * （429 会被 ⑤ 的 403/200 矩阵误读）。**只清本片自己登录拿到的令牌的桶**——不动别人的。
 */
function clearAdminWriteBucket(token: string): void {
  const fp = createHash('sha256').update(token).digest('hex').slice(0, 16);
  redisLines(['DEL', `ratelimit:admin-write:${fp}`]);
}

/* ── 投递 stub（`docker run` 探针容器；`/*_received` 回读）────────────────────── */

/** stub 内联脚本（照 slice-16 `STUB_SCRIPT` 形态；本片不造拉取面——relay 走真 config-service）。 */
const STUB_SCRIPT = `
const http = require('http');
const rec = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/_received') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(rec));
      return;
    }
    if (req.method === 'GET' && path === '/_reset') { rec.length = 0; res.end('reset'); return; }
    rec.push({ method: req.method, url: req.url, body });
    res.end('stub');
  });
}).listen(${STUB_PORT}, '0.0.0.0', () => console.error('ftl-probe-stub ready'));
`;

interface StubHit {
  method: string;
  url: string;
  body: string;
}

/** stub 的回读（`docker exec wget`——读回是探针自身，不经宿主端口；照 slice-16）。 */
function stubHits(): StubHit[] {
  const out = docker(['exec', STUB_NAME, 'wget', '-qO-', `http://127.0.0.1:${STUB_PORT}/_received`], 30_000);
  if (out.status !== 0) throw new ConformanceError(`读 stub 记录失败：${(out.stderr || out.stdout).slice(0, 300)}`);
  return JSON.parse(out.stdout) as StubHit[];
}

/** 按**路径分桶**计数（query 剥掉——钉钉槽会带 timestamp/sign 参数）。 */
function stubCount(path: string): number {
  return stubHits().filter((h) => (h.url || '').split('?')[0] === path).length;
}

/** 起 stub 并等它应答（有界；`/_received` 能读回即就绪）。失败抛（带退出输出尾）。 */
async function startStub(): Promise<void> {
  const res = docker(['run', '--rm', '-d', '--name', STUB_NAME, '--network', COMPOSE_NETWORK, STUB_IMAGE, 'node', '-e', STUB_SCRIPT], 120_000);
  if (res.status !== 0) {
    throw new ConformanceError(`投递 stub 起不来（退出码 ${res.status}）：${(res.stderr || res.stdout).slice(-600)}`);
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      stubHits();
      return;
    } catch {
      /* 未就绪：继续等 */
    }
    if (Date.now() >= deadline) throw new ConformanceError(`stub ${STUB_NAME} 60s 内未就绪`);
    await sleep(1_000);
  }
}

/* ── relay /data 与 renderer yml / AM status 读取面 ─────────────────────────── */

/** relay 容器内 `/data/notify-config.json` 原文（文件不在 ⇒ null——「从未拉到」的 ⑧e 观测面）。 */
function relayDataRaw(): string | null {
  const r = docker(['exec', RELAY_CONTAINER, 'cat', '/data/notify-config.json'], 20_000);
  return r.status === 0 ? r.stdout : null;
}

/** 解析后的 /data（坏内容 ⇒ null；不存在 ⇒ null）。 */
function relayDataJson(): Record<string, unknown> | null {
  const raw = relayDataRaw();
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `/data` 文件 mtime（秒；`stat` 失败 ⇒ null）——⑨「拉取恢复」的观测面（每次成功拉取必重写）。 */
function relayDataMtime(): number | null {
  const r = docker(['exec', RELAY_CONTAINER, 'stat', '-c', '%Y', '/data/notify-config.json'], 20_000);
  const n = Number((r.stdout ?? '').trim());
  return r.status === 0 && Number.isFinite(n) ? n : null;
}

/** 卷上渲染产物原文（`docker exec` 进 renderer 容器读；失败 ⇒ null）。 */
function readAmYml(): string | null {
  const r = docker(['exec', RENDERER_CONTAINER, 'cat', '/alertmanager-live/alertmanager.yml'], 20_000);
  return r.status === 0 ? r.stdout : null;
}

/** 内容 sha256（hex）——「hash 前后相等/不变」类断言的宿主侧独立复算。 */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** AM 内存已载配置的 redacted 原文（`/api/v2/status` 的 `config.original`；失败 ⇒ 空串）。 */
async function amStatusOriginal(): Promise<string> {
  try {
    const res = await fetch(`${AM_URL}/api/v2/status`, { signal: AbortSignal.timeout(15_000) });
    const parsed = JSON.parse(await res.text()) as { config?: { original?: string } };
    return parsed.config?.original ?? '';
  } catch {
    return '';
  }
}

/* ── HTTP 小助手（宿主 → 发布端口；带超时，Docker 端口代理会先收 TCP 再等应答）────── */

async function httpText(url: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  return { status: res.status, text };
}

/** 合成 AM payload（v4 schema；`formatAlert` 只消费 labels/annotations/startsAt/endsAt/status）。 */
function syntheticPayload(alertname: string, summary: string): unknown {
  const labels = { alertname, severity: 'warning', job: 'ftl-probe' };
  const alert = {
    status: 'firing',
    labels,
    annotations: { summary },
    startsAt: new Date().toISOString(),
    endsAt: '0001-01-01T00:00:00Z',
    generatorURL: 'http://prometheus.local/graph?g0.expr=probe',
    fingerprint: '0123456789abcdef',
  };
  return {
    version: '4',
    groupKey: `{}:{alertname="${alertname}"}`,
    truncatedAlerts: 0,
    status: 'firing',
    receiver: 'webhook',
    groupLabels: { alertname },
    commonLabels: labels,
    commonAnnotations: { summary },
    externalURL: 'http://alertmanager.local',
    alerts: [alert],
  };
}

/** **直打** relay `/webhook`（Bearer + 合成 payload；同步扇出——确定性观察面）。 */
function postWebhookDirect(payload: unknown): Promise<{ status: number; text: string }> {
  return httpText(`${RELAY_URL}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_TOKEN}` },
    body: JSON.stringify(payload),
  });
}

/** ⑥ 首步：经 **AM API** 注入一次合成告警（`POST /api/v2/alerts`；短 `endsAt` 自然过期）。 */
function injectAmAlert(alertname: string, ttlMs: number): Promise<{ status: number; text: string }> {
  const body = [
    {
      labels: { alertname, severity: 'warning', job: 'ftl-probe' },
      annotations: { summary: `slice-23 合成告警：${alertname}` },
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + ttlMs).toISOString(),
    },
  ];
  return httpText(`${AM_URL}/api/v2/alerts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* ── Prometheus / gauge 读取面 ────────────────────────────────────────────── */

interface PromAlert {
  name: string;
  state: string;
}

/** `/api/v1/alerts`（新面）——规则 Alert 的 label alertname 与状态。 */
async function fetchPromAlerts(): Promise<PromAlert[]> {
  const r = await httpText(`${PROM_URL}/api/v1/alerts`);
  const parsed = JSON.parse(r.text) as { data?: { alerts?: Array<{ labels?: { alertname?: string }; state?: string }> } };
  return (parsed.data?.alerts ?? []).map((a) => ({ name: a.labels?.alertname ?? '', state: a.state ?? '' }));
}

/**
 * config-service 9006 的两条 gauge（exec+Bearer，照 slice-16 C1；group 只取 email 面——
 * 本片 ⑩ 的判定对象）。标签形态 = `notify_config_keys_configured{group="email"} <值>`。
 */
function readNotifyGauges(): { keys: number | null; complete: number | null } {
  const r = docker(
    ['exec', CFG_CONTAINER, 'curl', '-s', '-H', `Authorization: Bearer ${INTERNAL_TOKEN}`, 'http://127.0.0.1:9006/metrics'],
    30_000,
  );
  const body = r.status === 0 ? r.stdout : '';
  const pick = (name: string): number | null => {
    const m = new RegExp(`^${name}\\{group="email"\\}\\s+(\\S+)\\s*$`, 'm').exec(body);
    return m ? Number(m[1]) : null;
  };
  return { keys: pick('notify_config_keys_configured'), complete: pick('notify_config_group_complete') };
}

/* ── 有界轮询 ─────────────────────────────────────────────────────────────── */

/** 有界轮询：读一处观测值直到条件满足（返回末次读数，调用方断言；照 slice-16 `pollRead`）。 */
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

/* ── 网关面小助手（⑤ 的变体矩阵）─────────────────────────────────────────── */

/** 任意方法/路径的网关请求（lib 的助手不复现变体路径形态；照 slice-22）。 */
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

/* ── 管理面账号助手（⑤ 的角色矩阵；照 slice-19/22 形态）────────────────────── */

async function loginAdminAs(username: string, password: string): Promise<string> {
  const res = await postJson<{ token: string }>('/api/admin/login', { username, password });
  const token = res.body?.data?.token;
  if (res.body?.code !== ErrCode.OK || !token) {
    throw new ConformanceError(`管理登录 ${username} 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return token;
}

/** 管理面九项条目（§2.4；只列本片读的字段——含 label/hint 供 ① 逐字断言）。 */
interface NotifyAdminEntry {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  value: string | null;
  fingerprint: string | null;
  hint: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** 审计行（`GET /api/admin/config/changes` 的形状；照 slice-22 ④）。 */
interface ChangeRow {
  id: number;
  key: string;
  oldValue: unknown;
  newValue: unknown;
  actor: string;
  createdAt: number;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════════ */

export async function runSlice23(): Promise<Checks> {
  const checks = new Checks();
  let adminToken = '';
  /** stub 是否由本片起过（finally 兜底停）。 */
  let stubStarted = false;
  /** ⑧/⑨ 期间 config-service 是否停过（finally 兜底 start）。 */
  let configStopped = false;
  /** ⑨ 窗口是否开着（窗口重建后、恢复完成前置 true —— finally 据此兜底还原）。 */
  let windowOpen = false;
  /** ⑨ 窗口步存下的现容器主钥/管理口令（恢复步与 finally 兜底都靠它）。 */
  let encKeySaved = '';
  let adminPwSaved = '';
  /** ⑤ 建的一次性账号（收尾停用留档）。 */
  const probeAccounts: Array<{ id: number; username: string }> = [];
  /** ④ 的密键「已写值」台账（每个写过的明文都必须在审计行的序列化串里找不到）。 */
  const secretLedger: string[] = [];
  /** ⑧c 的卷 yml hash（⑨ 的「保持」断言与它比）。 */
  let ymlHash8c = '';
  /** 收尾（主路径）是否已完成（finally 的九键 DELETE 只在异常路径才必要，但幂等无害）。 */
  let wrappedUp = false;

  /** 局部助手：PUT 一个键（密键的值写入台账——④ 的「序列化不含任何写过原文」依据）。 */
  const putKey = (key: NotifyKey, value: string): Promise<HttpResult> => {
    if (SECRET_KEYS.includes(key) && !secretLedger.includes(value)) secretLedger.push(value);
    return adminNotifyChannelPut(key, value, adminToken);
  };
  const getStatus = (): Promise<HttpResult<{ keys: NotifyAdminEntry[] }>> =>
    adminNotifyChannelGet<{ keys: NotifyAdminEntry[] }>(adminToken);
  const entryOf = (items: NotifyAdminEntry[] | undefined, key: NotifyKey): NotifyAdminEntry | undefined =>
    items?.find((k) => k.key === key);

  try {
    /* ── ① 种子回读与取值 ─────────────────────────────────────────────────── */
    step('① 种子回读与取值：九键种子 PUT ⇒ GET 顺序/标签逐字 · 密键 value=null+指纹 · 四非密键明文 · URL 三键 hint 六例（独立 PUT/GET 探针轮，跑完回种子）');
    await startStub();
    stubStarted = true;
    checks.that(stubHits().length === 0, `① 投递 stub（${STUB_NAME}）已就绪且账本为空（本 run 计数基线）`);

    adminToken = await adminLogin(); // 引导号 super_admin
    checks.that(adminToken.length > 0, '① 引导号管理登录 ⇒ token（本片全部管理写面的 actor 真源）');
    clearAdminWriteBucket(adminToken); // 本片首个写突发（①21 写）前清一次自己的写桶（防 429 假红）

    for (const key of NOTIFY_KEY_ORDER) {
      const put = await putKey(key, SEED_VALUES[key]);
      expectHttp(checks, put, 200, ErrCode.OK, `① PUT ${key} 种子值`);
      checks.eq(put.body?.data?.saved, true, `① PUT ${key} ⇒ {saved:true}`);
    }

    const g1 = await getStatus();
    expectHttp(checks, g1, 200, ErrCode.OK, '① GET /api/admin/notify-channel（种子回读）');
    const keys1 = g1.body?.data?.keys ?? [];
    checks.eq(keys1.length, 9, `① 条目恰九项 —— 实际 ${keys1.length}`);
    checks.eq(keys1.map((k) => k.key).join(','), NOTIFY_KEY_ORDER.join(','), '① ⚙️1 顺序逐字（读口按固定序组装，不是行序/字母序）');
    checks.eq(
      keys1.map((k) => k.label).join(','),
      NOTIFY_KEY_ORDER.map((k) => NOTIFY_LABELS[k]).join(','),
      '① 九项 label 逐字（§2.4 表下注文）',
    );
    checks.that(
      keys1.every((k) => k.configured === true && typeof k.updatedAt === 'number' && k.updatedBy === 'admin'),
      `① 九项全 configured=true 且 updatedAt 为数字、updatedBy=admin（种子写者）—— 实际 ${JSON.stringify(keys1.map((k) => [k.key, k.configured, k.updatedBy]))}`,
    );
    checks.eq(
      keys1.map((k) => `${k.key}:${k.fingerprint}`).join('|'),
      NOTIFY_KEY_ORDER.map((k) => `${k}:${fpOf(SEED_VALUES[k])}`).join('|'),
      '① 九项指纹 = 宿主对种子值独立复算（种子字节逐字落地；④ 的 redacted 指纹以此为准）',
    );
    checks.that(
      SECRET_KEYS.every((k) => {
        const e = entryOf(keys1, k);
        return e?.secret === true && e.value === null && /^[0-9a-f]{12}$/.test(e.fingerprint ?? '');
      }),
      `① 五密键 secret=true / value 恒 null（密键读不回）/ fingerprint=12hex —— 实际 ${JSON.stringify(SECRET_KEYS.map((k) => entryOf(keys1, k)))}`,
    );
    checks.that(
      PLAIN_KEYS.every((k) => {
        const e = entryOf(keys1, k);
        return e?.secret === false && e.value === SEED_VALUES[k] && e.hint === null;
      }),
      `① 四非密键 value=明文种子且 hint 恒 null —— 实际 ${JSON.stringify(PLAIN_KEYS.map((k) => entryOf(keys1, k)))}`,
    );

    // hint 六例（§2.4 规则；**独立 PUT/GET 探针轮**，每轮完成即 PUT 回种子——探针值不驻留）。
    const hintCases: Array<{ key: NotifyKey; value: string; hint: string; what: string }> = [
      { key: 'notify.webhook.wecomUrl', value: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=probe', hint: 'https://qyapi.weixin.qq.com', what: '企微平台域 ⇒ origin' },
      { key: 'notify.webhook.feishuUrl', value: 'https://open.feishu.cn/open-apis/bot/v2/hook/probe', hint: 'https://open.feishu.cn', what: '飞书平台域 ⇒ origin' },
      { key: 'notify.webhook.dingtalkUrl', value: 'https://oapi.dingtalk.com/robot/send?access_token=probe', hint: 'https://oapi.dingtalk.com', what: '钉钉平台域 ⇒ origin' },
      { key: 'notify.webhook.feishuUrl', value: 'https://example.com/hook', hint: '外部地址', what: '普通外部域 ⇒ 外部地址' },
      { key: 'notify.webhook.wecomUrl', value: 'https://evilqyapi.weixin.qq.com.hk/h', hint: '外部地址', what: '仿冒①（后缀）⇒ 外部地址' },
      { key: 'notify.webhook.dingtalkUrl', value: 'https://qyapi.weixin.qq.com.evil.com/h', hint: '外部地址', what: '仿冒②（前缀域名）⇒ 外部地址' },
    ];
    let hintCaseNo = 0;
    for (const c of hintCases) {
      hintCaseNo += 1;
      const put = await putKey(c.key, c.value);
      expectHttp(checks, put, 200, ErrCode.OK, `① hint 探针轮 ${hintCaseNo}（${c.what}）PUT ${c.key}`);
      const g = await getStatus();
      checks.eq(entryOf(g.body?.data?.keys, c.key)?.hint, c.hint, `① hint 探针轮 ${hintCaseNo}：${c.what}（全等匹配，仿冒不命中）`);
      const back = await putKey(c.key, SEED_VALUES[c.key]);
      expectHttp(checks, back, 200, ErrCode.OK, `① hint 探针轮 ${hintCaseNo}：PUT ${c.key} 回种子值`);
    }

    /* ── ② 不进广播（前置 = ①末态；无状态变更）─────────────────────────────── */
    step('② 不进广播：RPC config.snapshot 无 notify. 子串 + 恰 65 键 · GET /api/config 恰 20 键 · 三容器 env 无退役九键（防回流）');
    const snap = await rpcCall<{ config: Record<string, unknown>; version: number }>(CONFIG_RPC, RPC_PATTERNS.configSnapshot, {}, 3_000);
    const snapSer = JSON.stringify(snap);
    checks.that(snap.ok === true && !snapSer.includes('notify.'), `② config.snapshot ok:true 且响应串**无** notify. 子串 —— ok=${snap.ok}`);
    checks.eq(Object.keys(snap.ok ? snap.data.config : {}).length, 65, '② snapshot 恰 65 键（负断言非空转：快照真实在场且完整）');

    const uCfg = await registerUser(51);
    const cfg15 = await getJson<Record<string, unknown>>('/api/config', uCfg.accessToken);
    expectHttp(checks, cfg15 as { status: number; body: Envelope | null }, 200, ErrCode.OK, '② GET /api/config（玩家面）');
    const cfgData = cfg15.body?.data ?? {};
    checks.eq(Object.keys(cfgData).length, 20, `② /api/config 恰 20 键 —— 实际 ${Object.keys(cfgData).length}`);
    checks.that(!JSON.stringify(cfgData).includes('notify'), '② /api/config 响应无 notify 子串（九键不入客户端面）');

    for (const name of RETIRED_ENV_NAMES) {
      const counts = [AM_CONTAINER, RELAY_CONTAINER, RENDERER_CONTAINER].map(
        (c) => containerEnv(c).filter((e) => e.startsWith(`${name}=`)).length,
      );
      checks.eq(counts.join(','), '0,0,0', `② alertmanager/alert-relay/am-renderer 容器 env 无 ${name}（退役 env 防回流）`);
    }

    /* ── ③ 静态加密（前置 = ①末态）─────────────────────────────────────────── */
    step('③ 静态加密：SQL 直查 notify_channel_config.value_enc ⇒ 全 v1: 前缀、无任一值明文子串');
    checks.eq(mysqlScalar('SELECT COUNT(*) FROM notify_channel_config'), '9', '③ 表内恰 9 行（①种子态——负断言的判据面非空转）');
    checks.eq(mysqlScalar("SELECT COUNT(*) FROM notify_channel_config WHERE LEFT(value_enc,3) <> 'v1:'"), '0', "③ 全部 value_enc 前缀 'v1:'（AES-256-GCM 信封）");
    // ⚠️ '465' 有意**不进** needle 集（短路数值在 base64 密文里有 ~0.3% 假红面——与 ⑪「不 grep 465」同一条纪律）。
    const encNeedles = [
      SEED_VALUES['notify.smtp.host'],
      SEED_VALUES['notify.smtp.user'],
      ...SECRET_KEYS.map((k) => SEED_VALUES[k]),
    ];
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM notify_channel_config WHERE ${encNeedles.map((n) => `value_enc LIKE '%${n}%'`).join(' OR ')}`),
      '0',
      '③ 全表 value_enc 无任一值明文子串（host/user/pass + 四 IM 种子值——含去引号长串）',
    );

    /* ── ④ 审计脱敏（前置 = ①末态）─────────────────────────────────────────── */
    step("④ 审计：密键行 old/new 无原文+redacted 对象+actor · 四非密行落原文 · 清空行 JSON_TYPE(new_value)='NULL'（本组含 smtp.pass 清空+回写一轮——清空行形态的唯一来源）");
    const delPass = await adminNotifyChannelDelete('notify.smtp.pass', adminToken);
    expectHttp(checks, delPass, 200, ErrCode.OK, '④ DELETE notify.smtp.pass（清空行素材）');
    checks.eq(delPass.body?.data?.saved, true, '④ DELETE ⇒ {saved:true}（幂等契约）');
    const backPass = await putKey('notify.smtp.pass', SEED_VALUES['notify.smtp.pass']);
    expectHttp(checks, backPass, 200, ErrCode.OK, '④ PUT 回 smtp.pass 种子（清空后的首写）');
    checks.eq(backPass.body?.data?.fingerprint, fpOf(SEED_VALUES['notify.smtp.pass']), '④ 回写返回指纹 = 宿主复算（canonical 逐字）');

    // 五密键行：本 run 窗口内的读取（行数定长：smtp.pass 3 = ①写/④清/④回；三 URL 键各 5 = ①+两探针轮×2；dingtalkSecret 1）。
    const secretRowCounts: Record<string, number> = {
      'notify.smtp.pass': 3,
      'notify.webhook.feishuUrl': 5,
      'notify.webhook.wecomUrl': 5,
      'notify.webhook.dingtalkUrl': 5,
      'notify.webhook.dingtalkSecret': 1,
    };
    const allSecretRows: ChangeRow[] = [];
    for (const key of SECRET_KEYS) {
      const ch = await getJson<{ rows: ChangeRow[] }>(
        `/api/admin/config/changes?key=${encodeURIComponent(key)}&from=${RUN_START_MS}&limit=100`,
        adminToken,
      );
      expectHttp(checks, ch as { status: number; body: Envelope | null }, 200, ErrCode.OK, `④ 审计读口 ${key}（本 run 窗口）`);
      const rows = ch.body?.data?.rows ?? [];
      checks.eq(rows.length, secretRowCounts[key], `④ ${key} 本 run 恰 ${secretRowCounts[key]} 行（写轮次定长）`);
      allSecretRows.push(...rows);
    }
    checks.that(
      allSecretRows.every((r) => r.actor === 'admin' && r.createdAt >= RUN_START_MS),
      '④ 五密键行全部 actor=admin（审计 actor 列）且落在本 run 窗口（from 过滤生效）',
    );
    checks.that(
      allSecretRows.every((r) => {
        const ser = `${JSON.stringify(r.oldValue)}|${JSON.stringify(r.newValue)}`;
        return secretLedger.every((v) => !ser.includes(v));
      }),
      `④ 五密键行 old/new **序列化串不含任何写过的原文**（台账 ${secretLedger.length} 个值：种子+探针轮）`,
    );
    const setRows = allSecretRows.filter((r) => r.newValue !== null);
    checks.that(
      setRows.every((r) => {
        const nv = r.newValue as { redacted?: unknown; fingerprint?: unknown } | null;
        return nv !== null && typeof nv === 'object' && nv.redacted === true && typeof nv.fingerprint === 'string' && /^[0-9a-f]{12}$/.test(nv.fingerprint);
      }),
      `④ 密键 set 行 new 值全为 {"redacted":true,"fingerprint":12hex} 对象 —— 实际 ${JSON.stringify(setRows.map((r) => r.newValue).slice(0, 3))}…`,
    );
    checks.that(
      setRows.some((r) => JSON.stringify(r.newValue).includes('{"redacted":true')),
      '④ 序列化串含 {"redacted":true（§3.1 逐字形态）',
    );
    const clearRows = allSecretRows.filter((r) => r.newValue === null);
    checks.eq(clearRows.length, 1, `④ smtp.pass 清空行恰 1 —— 实际 ${clearRows.length}`);
    const clearOld = clearRows[0]?.oldValue as { redacted?: unknown } | null;
    checks.that(
      clearOld !== null && typeof clearOld === 'object' && clearOld.redacted === true,
      `④ 清空行 old 值亦为 redacted 对象（旧密文不出原文）—— 实际 ${JSON.stringify(clearRows[0]?.oldValue)}`,
    );
    checks.that(
      setRows.filter((r) => r.key === 'notify.smtp.pass').length === 2 &&
        setRows.every((r) => r.oldValue === null || (typeof r.oldValue === 'object' && (r.oldValue as { redacted?: unknown }).redacted === true)),
      '④ 密键行 old 或为 null（首写）或为 redacted 对象（两形态皆合法——不做环境相关等值期望）',
    );

    // 四非密行：本 run 窗口内各恰 1 行、落**原文**（JSON 字符串），actor=admin。
    for (const key of PLAIN_KEYS) {
      const ch = await getJson<{ rows: ChangeRow[] }>(
        `/api/admin/config/changes?key=${encodeURIComponent(key)}&from=${RUN_START_MS}&limit=100`,
        adminToken,
      );
      expectHttp(checks, ch as { status: number; body: Envelope | null }, 200, ErrCode.OK, `④ 审计读口 ${key}（本 run 窗口）`);
      const rows = ch.body?.data?.rows ?? [];
      checks.that(
        rows.length === 1 && rows[0]?.newValue === SEED_VALUES[key] && rows[0]?.actor === 'admin',
        `④ ${key} 本 run 恰 1 行且 new=原文种子/actor=admin —— 实际 ${JSON.stringify(rows[0])}`,
      );
    }

    // SQL 直查（照 slice-22 ④ 口径：JSON_TYPE='NULL' / new_value 绝无 SQL NULL / 全表无原文子串）。
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM config_changes WHERE \\\`key\\\`='notify.smtp.pass' AND JSON_TYPE(new_value)='NULL' AND created_at >= FROM_UNIXTIME(${RUN_START_SEC})`),
      '1',
      "④ SQL 清空行 JSON_TYPE(new_value)='NULL'（JSON 串的 'null'——⚠️ 不是 SQL NULL，写 IS NULL 会错红）",
    );
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM config_changes WHERE \\\`key\\\`='notify.smtp.pass' AND new_value IS NULL AND created_at >= FROM_UNIXTIME(${RUN_START_SEC})`),
      '0',
      "④ SQL new_value 列**绝无** SQL NULL（清空走 JSON 'null'，两列形态不混用）",
    );
    checks.eq(
      mysqlScalar(`SELECT COUNT(*) FROM config_changes WHERE old_value LIKE '%${SEED_VALUES['notify.smtp.pass']}%' OR new_value LIKE '%${SEED_VALUES['notify.smtp.pass']}%'`),
      '0',
      '④ SQL 全表（含历史行）old/new 原文无 smtp.pass 种子子串',
    );

    /* ── ⑤ 权限矩阵+变体（前置 = ①末态；末态 = ①末态）──────────────────────── */
    step('⑤ 权限矩阵四段式：非 SA 三角色×(字面,%2E,%4B,混合大小写)×(PUT,DELETE) ⇒ 403 · SA×{字面,%2E,%55,混合大小写} ⇒ 200（%4B 未知键一格 ⇒ 400）· %2F/裸/尾斜杠 ⇒ 403（含 SA）· GET 任意角色 200 · 近邻 400 · SA 正格 DELETE smtp.host + 回写自证');
    clearAdminWriteBucket(adminToken);
    const oneTimePw = `s23-${TAG}-passw0rd`;
    const accounts: Array<{ role: 'operator' | 'finance' | 'viewer'; username: string }> = [
      { role: 'operator', username: `s23o-${TAG}` },
      { role: 'finance', username: `s23f-${TAG}` },
      { role: 'viewer', username: `s23v-${TAG}` },
    ];
    const tokens: Record<string, string> = {};
    for (const a of accounts) {
      const cre = await postJson<{ id: number }>('/api/admin/accounts', { username: a.username, password: oneTimePw, role: a.role }, adminToken);
      expectHttp(checks, cre, 200, ErrCode.OK, `⑤ 建一次性 ${a.role} 账号`);
      probeAccounts.push({ id: cre.body?.data?.id ?? -1, username: a.username });
      tokens[a.role] = await loginAdminAs(a.username, oneTimePw);
      checks.that(tokens[a.role].length > 0, `⑤ ${a.role} 登录成功（矩阵的凭据）`);
    }

    const everyToken: Array<{ label: string; token: string }> = [
      { label: 'super_admin', token: adminToken },
      { label: 'operator', token: tokens.operator ?? '' },
      { label: 'finance', token: tokens.finance ?? '' },
      { label: 'viewer', token: tokens.viewer ?? '' },
    ];
    for (const t of everyToken) {
      const g = await adminNotifyChannelGet<{ keys: NotifyAdminEntry[] }>(t.token);
      checks.eq(g.status, 200, `⑤ GET /api/admin/notify-channel（${t.label}）⇒ 200（读面任意已认证角色）`);
      checks.eq(g.body?.data?.keys?.length, 9, `⑤ GET（${t.label}）九项在`);
    }

    // 非 SA × 两方法 × 四变体 ⇒ 全 403（策略层先于一切；policy 匹配**未解码原值路径**）。
    clearAdminWriteBucket(adminToken); // 24 格写计数 + 后续 SA 正格——先清一次
    const variantPaths: Array<{ label: string; path: string }> = [
      { label: '字面', path: '/api/admin/notify-channel/notify.smtp.host' },
      { label: '键段 %2E', path: '/api/admin/notify-channel/notify%2Esmtp%2Ehost' },
      { label: '键段 %4B', path: '/api/admin/notify-channel/notify.webhoo%4B.feishuUrl' },
      { label: '混合大小写前缀', path: '/API/ADMIN/NOTIFY-CHANNEL/notify.smtp.host' },
    ];
    const nonSaCodes: Array<number | undefined> = [];
    for (const role of ['operator', 'finance', 'viewer'] as const) {
      for (const method of ['PUT', 'DELETE'] as const) {
        for (const v of variantPaths) {
          const r = await sendRaw(method, v.path, tokens[role], method === 'PUT' ? { value: 'http://localhost:1' } : undefined);
          checks.eq(r.status, 403, `⑤ ${role} ${method} ${v.label} ⇒ 403（E′ 写面仅 super_admin）`);
          nonSaCodes.push(r.body?.code);
        }
      }
    }
    checks.that(
      nonSaCodes.every((c) => c === ErrCode.FORBIDDEN),
      `⑤ 非 SA 24 格全为 10003（FORBIDDEN）—— 实际码集 ${JSON.stringify([...new Set(nonSaCodes)])}`,
    );

    // SA 正格：字面/键段变体 ⇒ 200（临时值改完 PUT 回种子）。
    clearAdminWriteBucket(adminToken);
    const saPut1 = await sendRaw('PUT', '/api/admin/notify-channel/notify.smtp.port', adminToken, { value: TEMP_PORT });
    checks.that(saPut1.status === 200 && saPut1.body?.data?.saved === true, `⑤ SA PUT 字面 ⇒ 200 saved:true —— 实际 HTTP ${saPut1.status} ${JSON.stringify(saPut1.body)}`);
    checks.eq(saPut1.body?.data?.fingerprint, fpOf(TEMP_PORT), '⑤ SA 字面写返回指纹 = 宿主复算（canonical 逐字）');
    const saGet1 = await getStatus();
    checks.eq(entryOf(saGet1.body?.data?.keys, 'notify.smtp.port')?.value, TEMP_PORT, '⑤ SA 写已落（读口回临时值——写真的发生过，防「200 假绿」）');

    const saPut2 = await sendRaw('PUT', '/api/admin/notify-channel/notify%2Esmtp%2Eport', adminToken, { value: TEMP_PORT });
    checks.that(saPut2.status === 200 && saPut2.body?.data?.saved === true, `⑤ SA PUT 键段 %2E（= 点）⇒ 200（编码变体命中前缀规则）—— 实际 HTTP ${saPut2.status} ${JSON.stringify(saPut2.body)}`);
    const saPut3 = await sendRaw('PUT', '/api/admin/notify-channel/notify.webhook.feishu%55rl', adminToken, { value: SEED_VALUES['notify.webhook.feishuUrl'] });
    checks.that(saPut3.status === 200 && saPut3.body?.data?.saved === true, `⑤ SA PUT 键段 %55（=U，解码后落 feishuUrl；微审 v1.6）⇒ 200 —— 实际 HTTP ${saPut3.status} ${JSON.stringify(saPut3.body)}`);
    checks.eq(saPut3.body?.data?.fingerprint, fpOf(SEED_VALUES['notify.webhook.feishuUrl']), '⑤ %55 变体解码后键正确（指纹 = feishuUrl 种子指纹；零状态变化）');
    const saPut4 = await sendRaw('PUT', '/API/ADMIN/NOTIFY-CHANNEL/notify.smtp.port', adminToken, { value: TEMP_PORT });
    checks.that(saPut4.status === 200 && saPut4.body?.data?.saved === true, `⑤ SA PUT 混合大小写前缀 ⇒ 200（policy 折叠命中）—— 实际 HTTP ${saPut4.status} ${JSON.stringify(saPut4.body)}`);
    // %4B（=K）格：九键无 K ⇒ 解码后为未知键 ⇒ 下游白名单 400（「policy 命中 + 下游白名单拒」双层结构；微审 v1.6）。
    const saPutK = await sendRaw('PUT', '/api/admin/notify-channel/notify.smtp.host%4B', adminToken, { value: 'http://localhost:1' });
    checks.eq(saPutK.status, 400, '⑤ SA PUT %4B（解码后为未知键）⇒ 400（policy 命中 + 下游白名单拒——双层结构）');
    checks.eq(saPutK.body?.code, ErrCode.BAD_PARAM, '⑤ %4B 格信封码 10001（BAD_PARAM）');

    const saDel = await sendRaw('DELETE', '/api/admin/notify-channel/notify.smtp.host', adminToken);
    checks.that(saDel.status === 200 && saDel.body?.data?.saved === true, `⑤ SA 正格 DELETE smtp.host ⇒ 200 saved:true —— 实际 HTTP ${saDel.status} ${JSON.stringify(saDel.body)}`);
    const saGet2 = await getStatus();
    checks.eq(entryOf(saGet2.body?.data?.keys, 'notify.smtp.host')?.configured, false, '⑤ SA 删除已生效（读口 configured:false）');
    const saBack = await adminNotifyChannelPut('notify.smtp.host', SEED_VALUES['notify.smtp.host'], adminToken);
    expectHttp(checks, saBack, 200, ErrCode.OK, '⑤ 正格组内：PUT smtp.host 回原值');
    const saGet3 = await getStatus();
    const hostEntry = entryOf(saGet3.body?.data?.keys, 'notify.smtp.host');
    checks.that(
      hostEntry?.configured === true && hostEntry?.value === SEED_VALUES['notify.smtp.host'] && hostEntry?.fingerprint === fpOf(SEED_VALUES['notify.smtp.host']),
      `⑤ 正格自证：smtp.host 回种子值/指纹（照 slice-22:936-947）—— 实际 ${JSON.stringify(hostEntry)}`,
    );
    const portBack = await adminNotifyChannelPut('notify.smtp.port', SEED_VALUES['notify.smtp.port'], adminToken);
    expectHttp(checks, portBack, 200, ErrCode.OK, '⑤ 组内复原：PUT smtp.port 回种子（临时值收束）');
    const saGet4 = await getStatus();
    checks.that(
      saGet4.body?.data?.keys?.every((k) => k.configured === true) === true &&
        entryOf(saGet4.body?.data?.keys, 'notify.smtp.port')?.value === SEED_VALUES['notify.smtp.port'],
      `⑤ 组末态自证：九键全 configured 且 port 回种子（末态 = ①末态）—— 实际 ${JSON.stringify(saGet4.body?.data?.keys?.map((k) => [k.key, k.configured]))}`,
    );

    // fail-closed 面（含 SA）：%2F 前缀段 / 裸路径 / 尾斜杠 ⇒ 403（policy 先于路由，本系统无 404 来源）。
    const pct2fSaPut = await sendRaw('PUT', '/api/admin/notify-channel%2Fnotify.smtp.host', adminToken, { value: 'http://localhost:1' });
    checks.eq(pct2fSaPut.status, 403, '⑤ %2F 前缀段（SA PUT）⇒ 403（不中任何写规则 ⇒ P9 fail-closed）');
    checks.eq(pct2fSaPut.body?.code, ErrCode.FORBIDDEN, '⑤ %2F（SA）信封码 10003');
    const pct2fSaDel = await sendRaw('DELETE', '/api/admin/notify-channel%2Fnotify.smtp.host', adminToken);
    checks.eq(pct2fSaDel.status, 403, '⑤ %2F 前缀段（SA DELETE）⇒ 403');
    const pct2fOper = await sendRaw('PUT', '/api/admin/notify-channel%2Fnotify.smtp.host', tokens.operator ?? '', { value: 'http://localhost:1' });
    checks.eq(pct2fOper.status, 403, '⑤ %2F 前缀段（operator PUT）⇒ 403');
    const barePut = await sendRaw('PUT', '/api/admin/notify-channel', adminToken, { value: 'http://localhost:1' });
    checks.eq(barePut.status, 403, '⑤ 裸路径（SA PUT /api/admin/notify-channel）⇒ 403（前缀面带尾斜杠，不做通配）');
    const slashPut = await sendRaw('PUT', '/api/admin/notify-channel/', adminToken, { value: 'http://localhost:1' });
    checks.eq(slashPut.status, 403, '⑤ 尾斜杠归一后 = 裸路径（SA PUT /api/admin/notify-channel/）⇒ 403');

    // 近邻：PUT /api/admin/config/notify.* 过 policy（P4）但被下游 parseConfigValue 判未知键 ⇒ 400。
    const neighborSa = await sendRaw('PUT', '/api/admin/config/notify.smtp.pass', adminToken, { value: 'probe-x' });
    checks.eq(neighborSa.status, 400, '⑤ 近邻 SA PUT /api/admin/config/notify.smtp.pass ⇒ 400（非 200/非 500）');
    checks.eq(neighborSa.body?.code, ErrCode.BAD_PARAM, '⑤ 近邻（SA）信封码 10001（未知键）');
    const neighborOper = await sendRaw('PUT', '/api/admin/config/notify.smtp.pass', tokens.operator ?? '', { value: 'probe-x' });
    checks.eq(neighborOper.status, 400, '⑤ 近邻 operator PUT 同路径 ⇒ 400（P4 放行到下游、未知键 400 拦截）');
    checks.eq(neighborOper.body?.code, ErrCode.BAD_PARAM, '⑤ 近邻（operator）信封码 10001');
    const afterNeighbor = await getStatus();
    checks.eq(
      entryOf(afterNeighbor.body?.data?.keys, 'notify.smtp.pass')?.fingerprint,
      fpOf(SEED_VALUES['notify.smtp.pass']),
      '⑤ 近邻写口**碰不到** notify_channel_config（smtp.pass 指纹仍为种子——新表只此一条写路）',
    );

    // 一次性账号停用（只停用不删；照 slice-19/22）。
    for (const a of probeAccounts) {
      const dis = await sendRaw('PATCH', `/api/admin/accounts/${a.id}`, adminToken, { status: 'disabled' });
      checks.eq(dis.status, 200, `⑤ 收尾：停用一次性 ${a.username} ⇒ 200`);
    }
    const accList = await getJson<{ accounts: Array<{ username: string; status: string }> }>('/api/admin/accounts', adminToken);
    const stillActive = (accList.body?.data?.accounts ?? []).filter(
      (x) => probeAccounts.some((a) => a.username === x.username) && x.status === 'active',
    );
    checks.that(stillActive.length === 0, `⑤ 收尾：三枚一次性账号均已 disabled（不留活跃凭据）—— 实际残留 ${JSON.stringify(stillActive)}`);

    /* ── ⑥ relay 端到端（前置 = ①末态；末态 = IM 零键、SMTP 5/5）───────────── */
    step('⑥ relay 端到端（真栈）：PUT wecomUrl(种子) ⇒ /data 自证 ⇒ AM API 注入 ProbeWecomA ⇒ ≤45s stub /wecom 收 ⇒ 换址 /wecom2 ⇒ 直打（新收旧停）⇒ DELETE wecomUrl ⇒ 不投 ⇒ 钉钉半配 ⇒ 不投 + WARN 逐字 ⇒ DELETE 四 IM 键 ⇒ 200 no-op');
    clearAdminWriteBucket(adminToken);
    checks.that(pullToken().length > 0, '⑥ 前置：NOTIFY_CHANNEL_PULL_TOKEN 在场（runner 供给链 `??=` 自证）');
    const putW = await putKey('notify.webhook.wecomUrl', SEED_VALUES['notify.webhook.wecomUrl']);
    expectHttp(checks, putW, 200, ErrCode.OK, '⑥ PUT wecomUrl=种子（stub 地址）');
    const dSeed = await pollUntil(
      () => relayDataJson(),
      (j) => j !== null && IM_KEYS.every((k) => j[k] === SEED_VALUES[k]),
      60_000,
    );
    checks.that(
      dSeed.ok,
      `⑥ ≤60s（30s 轮询 + 余量）：relay /data 含四 IM 种子值（活性槽 = feishu/dingtalk/wecom@stub；stub 名唯一 ⇒ 出现即本 run 的拉取）—— 实际 ${JSON.stringify(dSeed.last)}`,
    );
    const gW = await getStatus();
    checks.eq(entryOf(gW.body?.data?.keys, 'notify.webhook.wecomUrl')?.configured, true, '⑥ GET 自证：wecomUrl configured（config 侧）');

    const inj = await injectAmAlert('ProbeWecomA', 90_000);
    checks.eq(inj.status, 200, '⑥ AM API 注入合成告警（alertname ProbeWecomA、endsAt=+90s）⇒ 200（判据台新机制）');
    const gotWecom = await pollUntil(() => stubCount('/wecom'), (n) => n >= 1, 45_000);
    checks.that(
      gotWecom.ok,
      `⑥ ≤45s（group_wait 30s 余量）：stub /wecom 路径收到投递（≥1）—— 实际 ${gotWecom.last}（AM 全链：注入⇒路由⇒webhook⇒格式化⇒投递）`,
    );
    const firstWecom = stubHits().find((h) => (h.url || '').split('?')[0] === '/wecom');
    checks.that(
      (firstWecom?.body ?? '').includes('ProbeWecomA'),
      `⑥ 首投正文含 alertname（确认经 AM 注入那条链，非直打）—— 实际 ${JSON.stringify(firstWecom?.body ?? '').slice(0, 160)}`,
    );

    // 换址：/wecom ⇒ /wecom2（新地址收到、旧地址计数不再增长——基线在 /data 换址后才取，窗口内旧地址无活性）。
    const putW2 = await putKey('notify.webhook.wecomUrl', WECOM2);
    expectHttp(checks, putW2, 200, ErrCode.OK, '⑥ PUT wecomUrl=/wecom2');
    const dW2 = await pollUntil(() => relayDataJson(), (j) => j !== null && j['notify.webhook.wecomUrl'] === WECOM2, 60_000);
    checks.that(dW2.ok, `⑥ ≤60s：relay /data 已换 /wecom2（轮询热更新到位）—— 实际 ${JSON.stringify(dW2.last?.['notify.webhook.wecomUrl'])}`);
    const oldWecomBase = stubCount('/wecom');
    const directA = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(directA.status, 200, '⑥ 直打 /webhook（换址后）⇒ 200（同步扇出）');
    checks.atLeast(stubCount('/wecom2'), 1, '⑥ 新地址 /wecom2 收到（直打同步扇出）');
    checks.eq(stubCount('/wecom'), oldWecomBase, '⑥ 旧地址 /wecom 计数不再增长（槽位已换）');

    // 删址：DELETE wecomUrl ⇒ 不投。
    const delW = await adminNotifyChannelDelete('notify.webhook.wecomUrl', adminToken);
    expectHttp(checks, delW, 200, ErrCode.OK, '⑥ DELETE wecomUrl');
    const dNoW = await pollUntil(() => relayDataJson(), (j) => j !== null && !('notify.webhook.wecomUrl' in j), 60_000);
    checks.that(dNoW.ok, '⑥ ≤60s：/data 已无 wecomUrl（删除已下发）');
    const w2Base = stubCount('/wecom2');
    const directB = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(directB.status, 200, '⑥ 直打（wecom 已删）⇒ 200（其余槽照达）');
    checks.eq(stubCount('/wecom2'), w2Base, '⑥ 已删地址 /wecom2 计数不变（不投——槽位关闭）');

    // 钉钉半配：DELETE dingtalkSecret ⇒ PUT dingtalkUrl（= 半配态）。
    const delSec = await adminNotifyChannelDelete('notify.webhook.dingtalkSecret', adminToken);
    expectHttp(checks, delSec, 200, ErrCode.OK, '⑥ DELETE dingtalkSecret');
    const putD = await adminNotifyChannelPut('notify.webhook.dingtalkUrl', SEED_VALUES['notify.webhook.dingtalkUrl'], adminToken);
    expectHttp(checks, putD, 200, ErrCode.OK, '⑥ PUT dingtalkUrl（= 半配态素材）');
    const dHalf = await pollUntil(
      () => relayDataJson(),
      (j) => j !== null && j['notify.webhook.dingtalkUrl'] === SEED_VALUES['notify.webhook.dingtalkUrl'] && !('notify.webhook.dingtalkSecret' in j),
      60_000,
    );
    checks.that(dHalf.ok, '⑥ ≤60s：/data 已呈半配形态（URL 在、secret 不在）');
    const halfWarn = await pollUntil(
      () => (containerLogs(RELAY_CONTAINER, sinceRunStartSec()).includes(HALF_CONFIG_WARN) ? 1 : 0),
      (n) => n === 1,
      60_000,
    );
    checks.that(halfWarn.ok, `⑥ relay WARN 逐字「${HALF_CONFIG_WARN}」（状态变化时一条；不含值）`);
    const dtBase = stubCount('/dingtalk');
    const directC = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(directC.status, 200, '⑥ 直打（钉钉半配）⇒ 200（其余槽照达）');
    checks.eq(stubCount('/dingtalk'), dtBase, '⑥ 半配期 /dingtalk 计数不变（槽位停用不投）');

    // 清空：DELETE 四 IM 键 ⇒ 零槽 200 no-op。
    for (const key of IM_KEYS) {
      const del = await adminNotifyChannelDelete(key, adminToken);
      expectHttp(checks, del, 200, ErrCode.OK, `⑥ DELETE ${key}`);
    }
    const dEmpty = await pollUntil(() => relayDataJson(), (j) => j !== null && Object.keys(j).length === 0, 60_000);
    checks.that(dEmpty.ok, '⑥ ≤60s：/data = {}（成功空图 ≠ 从未拉到）');
    const directD = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(directD.status, 200, '⑥ 零槽直打 ⇒ 200（明示 no-op）');
    checks.that(directD.text.includes(NO_SINKS_BODY), `⑥ 零槽正文逐字 \`${NO_SINKS_BODY}\`（≠ 500——「明确未配」语义）`);

    /* ── ⑦ AM 渲染端到端（前置 = ⑥末态；末态 = SMTP 4/5、IM 零键）──────────── */
    step('⑦ AM 渲染端到端：PUT SMTP 五键 ⇒ ≤60s 卷 yml 逐字含五值 + /api/v2/status（密码 <secret>）+ amtool 预检绿 ⇒ DELETE smtp.pass ⇒ ≤60s 邮件段消失（reload 成功）');
    clearAdminWriteBucket(adminToken);
    for (const key of ['notify.smtp.host', 'notify.smtp.port', 'notify.smtp.user', 'notify.smtp.pass', 'notify.email.to'] as const) {
      const put = await adminNotifyChannelPut(key, SEED_VALUES[key], adminToken);
      expectHttp(checks, put, 200, ErrCode.OK, `⑦ PUT ${key} 种子（五键齐）`);
    }
    const ymlPoll = await pollUntil(
      () => readAmYml() ?? '',
      (y) => y.includes('smtp_smarthost'),
      60_000,
    );
    checks.that(ymlPoll.ok, '⑦ ① ≤60s：卷 yml 出现邮件段（renderer 渲染+落盘完成）');
    const ymlFull = ymlPoll.last ?? '';
    checks.that(
      ymlFull.includes(`smtp_smarthost: ${JSON.stringify(`${SEED_VALUES['notify.smtp.host']}:${SEED_VALUES['notify.smtp.port']}`)}`),
      `⑦ ① 卷 yml 逐字含 smtp_smarthost（host+port 合成 JSON 标量）—— 实际 ${JSON.stringify(ymlFull.split('\n').find((l) => l.includes('smtp_smarthost')) ?? '')}`,
    );
    checks.that(
      ymlFull.includes(`smtp_from: ${JSON.stringify(SEED_VALUES['notify.smtp.user'])}`) &&
        ymlFull.includes(`smtp_auth_username: ${JSON.stringify(SEED_VALUES['notify.smtp.user'])}`),
      '⑦ ① 卷 yml 逐字含 smtp_from/smtp_auth_username=邮件账号（user 双写）',
    );
    checks.that(
      ymlFull.includes(`smtp_auth_password: ${JSON.stringify(SEED_VALUES['notify.smtp.pass'])}`),
      '⑦ ① 卷 yml 逐字含 smtp_auth_password=授权码（值经 JSON 标量）',
    );
    checks.that(
      ymlFull.includes(`- to: ${JSON.stringify(SEED_VALUES['notify.email.to'])}`),
      '⑦ ① 卷 yml 逐字含 email_configs 的 to=收件地址',
    );
    const stPoll = await pollUntil(() => amStatusOriginal(), (o) => o.includes('smtp_smarthost'), 60_000);
    checks.that(stPoll.ok, '⑦ ② ≤60s：GET /api/v2/status 显示邮件段（AM 内存已载）');
    const stFull = stPoll.last ?? '';
    checks.that(
      stFull.includes('smtp_smarthost') && stFull.includes('smtp_from') && stFull.includes(`to: ${SEED_VALUES['notify.email.to']}`),
      '⑦ ② status 显示 smtp_smarthost/smtp_from/to（三面逐字）',
    );
    checks.that(
      stFull.includes('smtp_auth_password: <secret>'),
      '⑦ ② status 密码渲染为 `smtp_auth_password: <secret>`（AM redaction——真密码不出状态面）',
    );
    checks.that(!stFull.includes(SEED_VALUES['notify.smtp.pass']), '⑦ ② status 原文不含授权码明文（redaction 实证）');
    const amtool = docker(['exec', RENDERER_CONTAINER, '/bin/amtool', 'check-config', '/alertmanager-live/alertmanager.yml'], 30_000);
    checks.that(
      amtool.status === 0 && `${amtool.stdout}${amtool.stderr}`.includes('SUCCESS'),
      `⑦ ③ amtool check-config 全量形态 ⇒ 0 + SUCCESS（renderer 成功写入 + AM 启动承接）—— 实际退出码 ${amtool.status}：${(amtool.stdout + amtool.stderr).trim().slice(0, 200)}`,
    );

    const delPass7 = await adminNotifyChannelDelete('notify.smtp.pass', adminToken);
    expectHttp(checks, delPass7, 200, ErrCode.OK, '⑦ DELETE smtp.pass（邮件段消失的驱动）');
    const ymlBasePoll = await pollUntil(
      () => readAmYml() ?? '',
      (y) => !y.includes('smtp_smarthost') && !y.includes('email_configs') && y.includes('receivers:'),
      60_000,
    );
    checks.that(ymlBasePoll.ok, '⑦ ≤60s：卷 yml 邮件段消失（回归 baseline 态——无 global/email_configs）');
    const stBasePoll = await pollUntil(() => amStatusOriginal(), (o) => o.length > 0 && !o.includes('smtp_smarthost'), 60_000);
    checks.that(stBasePoll.ok, '⑦ ≤60s：status 亦无邮件段（reload 成功——AM 内存换成新形态）');

    /* ── ⑧ 回落（前置 = ⑧自种四 IM 键；末态 = IM 四键·SMTP 4/5·config 恢复）── */
    step('⑧ 回落：自种四 IM 键 ⇒ 停 config-service ⇒ a) 直打仍收 + yml hash 不变（renderer 保持）· b) 重建 relay ⇒ 仍收（/data 持久化）· c) 重建 renderer ⇒ 卷 yml 逐字不变 + status 不变 + Running（存活）· d) /data 仅四键无 SMTP 面 · e) 清 /data + 冷 relay ⇒ 500（未知≠成功）⇒ 恢复复绿');
    clearAdminWriteBucket(adminToken);
    for (const key of IM_KEYS) {
      const put = await adminNotifyChannelPut(key, SEED_VALUES[key], adminToken);
      expectHttp(checks, put, 200, ErrCode.OK, `⑧ 自种 PUT ${key}（本次 stub）`);
    }
    const gIM = await getStatus();
    checks.that(
      IM_KEYS.every((k) => entryOf(gIM.body?.data?.keys, k)?.configured === true),
      '⑧ 自种自证：四 IM 键 GET configured',
    );
    const dIM = await pollUntil(() => relayDataJson(), (j) => j !== null && IM_KEYS.every((k) => j[k] === SEED_VALUES[k]), 60_000);
    checks.that(dIM.ok, '⑧ ≤60s：/data 含四键（relay 已拉取）');

    const ymlHashPre = sha256Hex(readAmYml() ?? '');
    const stPre = await amStatusOriginal();
    const stopR = compose({}, 'stop', 'config-service');
    checks.eq(stopR.code, 0, `⑧a 停 config-service —— 输出尾部：${tailOut(stopR.out)}`);
    configStopped = true;
    const feBaseA = stubCount('/feishu');
    const aDirect = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(aDirect.status, 200, '⑧a 停 config 后直打 ⇒ 200（relay lastGood 保持——回落语义）');
    checks.atLeast(stubCount('/feishu') - feBaseA, 1, '⑧a 直打仍收（stub /feishu delta ≥1）');
    checks.eq(sha256Hex(readAmYml() ?? ''), ymlHashPre, '⑧a renderer 卷 yml hash 前后相等（拉取失败不动文件）');

    const rcB = compose({}, '--profile', 'monitoring', 'up', '-d', '--force-recreate', '--no-deps', 'alert-relay');
    checks.eq(rcB.code, 0, `⑧b 重建 alert-relay（config 仍停）—— 输出尾部：${tailOut(rcB.out)}`);
    const hbB = await pollUntil(
      () => httpText(`${RELAY_URL}/health`).then((r) => r.status).catch(() => 0),
      (s) => s === 200,
      60_000,
      1_000,
    );
    checks.that(hbB.ok, `⑧b 重建后 relay /health ⇒ 200 —— 实际 ${hbB.last}`);
    const feBaseB = stubCount('/feishu');
    const bDirect = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(bDirect.status, 200, '⑧b 重建 relay（全新进程）后直打 ⇒ 200');
    checks.atLeast(stubCount('/feishu') - feBaseB, 1, '⑧b 仍收（投递来自 /data 持久化——内存已随重建清零）');

    const ymlBeforeC = readAmYml() ?? '';
    const rcC = compose({}, '--profile', 'monitoring', 'up', '-d', '--force-recreate', '--no-deps', 'am-renderer');
    checks.eq(rcC.code, 0, `⑧c 重建 am-renderer（config 仍停）—— 输出尾部：${tailOut(rcC.out)}`);
    const startLogC = await pollUntil(
      () => (containerLogs(RENDERER_CONTAINER, sinceRunStartSec()).includes('[am-renderer] 启动；') ? 1 : 0),
      (n) => n === 1,
      30_000,
      1_000,
    );
    checks.that(startLogC.ok, '⑧c 重建后 renderer 完成启动段（启动行在场）');
    await sleep(2_500); // 沉降：防「起完即崩」
    const inspC = docker(['inspect', RENDERER_CONTAINER, '--format', '{{.State.Running}}']);
    checks.eq(inspC.stdout.trim(), 'true', '⑧c ftl-am-renderer State.Running=true（存活断言，防「重建即崩」假绿——评审 S-Y6）');
    checks.eq(readAmYml() ?? '', ymlBeforeC, '⑧c 卷 yml 逐字不变（重建不降级卷上配置）');
    checks.eq(await amStatusOriginal(), stPre, '⑧c /api/v2/status 逐字不变（AM 内存配置未动）');
    ymlHash8c = sha256Hex(readAmYml() ?? '');

    const dData = relayDataJson();
    const dDataText = relayDataRaw() ?? '';
    checks.that(
      dData !== null && Object.keys(dData).length === 4 && IM_KEYS.every((k) => dData[k] === SEED_VALUES[k]),
      `⑧d /data 恰含 IM 四键（值逐字种子）—— 实际 ${JSON.stringify(dData)}`,
    );
    checks.that(
      !dDataText.includes('notify.smtp') && !dDataText.includes(SEED_VALUES['notify.smtp.host']) &&
        !dDataText.includes(SEED_VALUES['notify.smtp.user']) && !dDataText.includes(SEED_VALUES['notify.smtp.pass']),
      '⑧d /data 无 `notify.smtp` 子串/无 SMTP 值（按消费方裁剪——relay 侧不见邮件五键）',
    );

    const rmData = docker(['exec', RELAY_CONTAINER, 'sh', '-c', 'rm -f /data/notify-config.json /data/notify-config.json.tmp'], 20_000);
    checks.eq(rmData.status, 0, '⑧e 清 /data（notify-config.json 与残余 tmp）');
    checks.eq(relayDataRaw(), null, '⑧e 清后 /data 文件不在（从未拉到形态的构造）');
    const rcE = compose({}, '--profile', 'monitoring', 'up', '-d', '--force-recreate', '--no-deps', 'alert-relay');
    checks.eq(rcE.code, 0, `⑧e 冷启 relay（config 自 ⑧a 起持续停止——不再重复 stop）—— 输出尾部：${tailOut(rcE.out)}`);
    const hbE = await pollUntil(
      () => httpText(`${RELAY_URL}/health`).then((r) => r.status).catch(() => 0),
      (s) => s === 200,
      60_000,
      1_000,
    );
    checks.that(hbE.ok, `⑧e 冷启后 relay /health ⇒ 200 —— 实际 ${hbE.last}`);
    const e500 = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(e500.status, 500, '⑧e 从未拉到（无 /data + 停 config）⇒ 直打 500（未知 ≠ 成功）');
    checks.that(e500.text.includes(UNAVAILABLE_BODY), `⑧e 500 正文逐字 \`${UNAVAILABLE_BODY}\`（AM 据此按 repeat_interval 重投）`);

    const startR8 = compose({}, 'start', 'config-service');
    checks.eq(startR8.code, 0, '⑧e 恢复：start config-service');
    configStopped = false;
    const startH8 = await waitContainerHealthy(CFG_CONTAINER);
    checks.that(startH8.ok, `⑧e config-service 恢复 healthy —— ${startH8.last}`);
    const dBack = await pollUntil(() => relayDataJson(), (j) => j !== null && IM_KEYS.every((k) => j[k] === SEED_VALUES[k]), 60_000);
    checks.that(dBack.ok, '⑧e ≤60s：拉取恢复（/data 重写四键）');
    const feBaseE = stubCount('/feishu');
    const eDirect = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(eDirect.status, 200, '⑧e 复绿：直打 ⇒ 200');
    checks.atLeast(stubCount('/feishu') - feBaseE, 1, '⑧e 复绿：stub 复投收到（delta ≥1）');

    /* ── ⑨ fail-closed（前置 = ⑧末态；末态 = ⑧末态）────────────────────────── */
    step('⑨ fail-closed：pick 现容器主钥 ⇒ 空值重建 config-service ⇒ GET/PUT 503 逐字（合法值 PUT——400 先于 503）· RPC 10007 逐字 · relay 保持 lastGood（直打仍收）· renderer 卷 yml hash 与 ⑧c 相同 · 65 键面 200 ⇒ 存钥重建 ⇒ 复绿（PUT 成功 + 拉取恢复 + 直打复投）');
    checks.that(pullToken().length > 0, '⑨ 前置：拉取令牌照常在场（否则窗口步「令牌也空」会侥幸同结果，判据证不到「主钥缺失」这一因）');
    const cfgEnvBefore = containerEnv(CFG_CONTAINER);
    encKeySaved = pickEnv(cfgEnvBefore, 'PAY_CONFIG_ENC_KEY');
    adminPwSaved = pickEnv(cfgEnvBefore, 'ADMIN_PASSWORD');
    checks.that(encKeySaved.length > 0, `⑨ 现容器 PAY_CONFIG_ENC_KEY 非空（栈供给链在场；实际长度 ${encKeySaved.length}）`);
    info(`⑨ 重建透传面：ADMIN_PASSWORD=${adminPwSaved.length > 0 ? '<非空>' : JSON.stringify('')} · NOTIFY_CHANNEL_PULL_TOKEN=${pullToken().length > 0 ? '<非空>' : JSON.stringify('')}`);

    windowOpen = true;
    const win9 = compose({ PAY_CONFIG_ENC_KEY: '', ADMIN_PASSWORD: adminPwSaved }, 'up', '-d', '--force-recreate', 'config-service');
    checks.eq(win9.code, 0, `⑨ 窗口：以 PAY_CONFIG_ENC_KEY=（空）重建 config-service —— 输出尾部：${tailOut(win9.out)}`);
    const win9h = await waitContainerHealthy(CFG_CONTAINER);
    checks.that(win9h.ok, `⑨ 窗口 config-service healthy —— ${win9h.last}`);
    checks.eq(pickEnv(containerEnv(CFG_CONTAINER), 'PAY_CONFIG_ENC_KEY'), '', '⑨ 窗口实证：容器 env 的 PAY_CONFIG_ENC_KEY 是空串（空构造真的落地了）');
    checks.eq(pickEnv(containerEnv(CFG_CONTAINER), 'NOTIFY_CHANNEL_PULL_TOKEN'), pullToken(), '⑨ 窗口保真：NOTIFY_CHANNEL_PULL_TOKEN 随行透传（runner `??=` 供给链）');

    const mtimeWindow = relayDataMtime();
    checks.that(typeof mtimeWindow === 'number', `⑨ 窗口：/data mtime 可读（拉取恢复的基线读数）—— 实际 ${JSON.stringify(mtimeWindow)}`);
    const wGet = await adminNotifyChannelGet(adminToken);
    checks.eq(wGet.status, 503, '⑨ 窗口：GET /api/admin/notify-channel ⇒ 503（通知块整体 fail-closed）');
    checks.that(
      wGet.body?.code === ErrCode.UPSTREAM_UNAVAILABLE && wGet.body?.message === MASTER_KEY_503_MESSAGE,
      `⑨ 窗口：GET 503 信封 = 10007 + §2.9 逐字文案 —— 实际 ${JSON.stringify(wGet.body)}`,
    );
    const wPut = await adminNotifyChannelPut('notify.smtp.host', SEED_VALUES['notify.smtp.host'], adminToken);
    checks.eq(wPut.status, 503, '⑨ 窗口：PUT（**合法值**——§3.1 观测序 400 先于 503）⇒ 503');
    checks.that(
      wPut.body?.code === ErrCode.UPSTREAM_UNAVAILABLE && wPut.body?.message === MASTER_KEY_503_MESSAGE,
      `⑨ 窗口：PUT 503 信封逐字 —— 实际 ${JSON.stringify(wPut.body)}`,
    );
    const rpcW = await rpcCall(CONFIG_RPC, RPC_PATTERNS.configNotifyChannelGet, { pullToken: pullToken() }, 4_000);
    checks.that(
      !rpcW.ok && rpcW.code === ErrCode.UPSTREAM_UNAVAILABLE,
      `⑨ 窗口：RPC（对令牌）⇒ ok:false / 10007 —— 实际 ${JSON.stringify(rpcW)}`,
    );
    checks.that(
      !rpcW.ok && rpcW.message === RPC_DISABLED_MESSAGE,
      `⑨ 窗口：RPC 文案逐字「${RPC_DISABLED_MESSAGE}」（**无**「（缺主钥）」后缀——两处钉子分开）`,
    );
    const feBaseW = stubCount('/feishu');
    const wDirect = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(wDirect.status, 200, '⑨ 窗口：relay 保持 lastGood ⇒ 直打仍 200');
    checks.atLeast(stubCount('/feishu') - feBaseW, 1, '⑨ 窗口：stub 仍收（拉取被拒不改 lastGood）');
    checks.eq(sha256Hex(readAmYml() ?? ''), ymlHash8c, '⑨ 窗口：renderer 卷 yml hash 与 ⑧c 读数相同（其「保持」由 ⑧a/c 承接）');
    const wCfg = await adminGetConfig<{ config: Record<string, unknown> }>(adminToken);
    expectHttp(checks, wCfg as { status: number; body: Envelope | null }, 200, ErrCode.OK, '⑨ 窗口：GET /api/admin/config ⇒ 200（其它面不受影响）');
    checks.eq(Object.keys(wCfg.body?.data?.config ?? {}).length, 65, '⑨ 窗口：65 键面完整（通知块故障不外溢）');

    const rec9 = compose({ PAY_CONFIG_ENC_KEY: encKeySaved, ADMIN_PASSWORD: adminPwSaved }, 'up', '-d', '--force-recreate', 'config-service');
    checks.eq(rec9.code, 0, `⑨ 恢复：以存钥重建 config-service —— 输出尾部：${tailOut(rec9.out)}`);
    const rec9h = await waitContainerHealthy(CFG_CONTAINER);
    checks.that(rec9h.ok, `⑨ 恢复 config-service healthy —— ${rec9h.last}`);
    checks.eq(pickEnv(containerEnv(CFG_CONTAINER), 'PAY_CONFIG_ENC_KEY'), encKeySaved, '⑨ 恢复实证：容器 env 主钥 = 存下的值');
    windowOpen = false;
    const recPut = await adminNotifyChannelPut('notify.smtp.host', SEED_VALUES['notify.smtp.host'], adminToken);
    expectHttp(checks, recPut, 200, ErrCode.OK, '⑨ 复绿：PUT 成功（同值幂等写——窗口步的 503 与它的对照即「钥在场与否」）');
    const mtimeBack = await pollUntil(() => relayDataMtime(), (m) => typeof m === 'number' && m > (mtimeWindow ?? 0), 60_000);
    checks.that(mtimeBack.ok, `⑨ 拉取恢复：/data mtime 前进（窗口后成功拉取重新落盘；基线 ${mtimeWindow}）—— 实际 ${mtimeBack.last}`);
    const feBaseR = stubCount('/feishu');
    const recDirect = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 直打观察'));
    checks.eq(recDirect.status, 200, '⑨ 复绿：直打复投 ⇒ 200');
    checks.atLeast(stubCount('/feishu') - feBaseR, 1, '⑨ 复绿：stub delta ≥1（新鲜拉取链路照常）');

    /* ── ⑩ gauge/规则（前置 = SMTP 4/5；末态 = 邮件 0/0）────────────────────── */
    step('⑩ gauge/规则：4/5 在位 ⇒ 9006 keys_configured{email}=4 且 group_complete{email}=0 · ≤120s /api/v1/alerts 读到 NotifyEmailIncomplete(pending|firing) + 负例 ⇒ 补第 5 键 ⇒ gauge 1 ⇒ 清空 ⇒ 0/0');
    clearAdminWriteBucket(adminToken);
    const g10 = await getStatus();
    checks.that(
      entryOf(g10.body?.data?.keys, 'notify.smtp.pass')?.configured === false &&
        (['notify.smtp.host', 'notify.smtp.port', 'notify.smtp.user', 'notify.email.to'] as const).every(
          (k) => entryOf(g10.body?.data?.keys, k)?.configured === true,
        ),
      '⑩ 前置自证：SMTP 4/5（⑦ 继承；pass 缺）',
    );
    const gauge45 = readNotifyGauges();
    checks.that(
      gauge45.keys === 4 && gauge45.complete === 0,
      `⑩ 9006（exec+Bearer）：keys_configured{email}=4 且 group_complete{email}=0 —— 实际 ${JSON.stringify(gauge45)}`,
    );
    const alertPoll = await pollUntil(
      async () => {
        const list = await fetchPromAlerts();
        const hit = list.find((a) => a.name === 'NotifyEmailIncomplete');
        return hit ? { found: true as const, state: hit.state, list } : { found: false as const, state: '', list };
      },
      (v) => v.found,
      120_000,
      3_000,
    );
    checks.that(
      alertPoll.ok && (alertPoll.last?.state === 'pending' || alertPoll.last?.state === 'firing'),
      `⑩ ≤120s（scrape 15s + eval 周期）：/api/v1/alerts 读到 NotifyEmailIncomplete state∈{pending,firing} —— 实际 ${JSON.stringify(alertPoll.last?.state ?? null)}`,
    );
    const alertsAtHit = alertPoll.last?.list ?? [];
    checks.that(
      !alertsAtHit.some((a) => a.name === 'NotifyEmailIncompleteProbe'),
      '⑩ 负例①：另造 alertname（NotifyEmailIncompleteProbe）不命中（谓词有判别力，非「存在即真」）',
    );
    checks.that(
      !alertsAtHit.some((a) => a.name === 'NotifyDingtalkIncomplete'),
      '⑩ 负例②：NotifyDingtalkIncomplete 不在（钉钉组 2/2 ⇒ 规则不响——同一次读取的区分力）',
    );
    const put5th = await adminNotifyChannelPut('notify.smtp.pass', SEED_VALUES['notify.smtp.pass'], adminToken);
    expectHttp(checks, put5th, 200, ErrCode.OK, '⑩ 补第 5 键（PUT smtp.pass 回种子）');
    const gauge51 = readNotifyGauges();
    checks.that(
      gauge51.keys === 5 && gauge51.complete === 1,
      `⑩ 补第 5 键 ⇒ gauge 5/1（写路径现算）—— 实际 ${JSON.stringify(gauge51)}`,
    );
    for (const key of ['notify.smtp.host', 'notify.smtp.port', 'notify.smtp.user', 'notify.smtp.pass', 'notify.email.to'] as const) {
      const del = await adminNotifyChannelDelete(key, adminToken);
      expectHttp(checks, del, 200, ErrCode.OK, `⑩ 清空 ${key}`);
    }
    const gauge00 = readNotifyGauges();
    checks.that(
      gauge00.keys === 0 && gauge00.complete === 0,
      `⑩ 再清空 ⇒ gauge 0/0（末态 = 邮件 0/0）—— 实际 ${JSON.stringify(gauge00)}`,
    );

    /* ── ⑪ 日志无凭据（前置 = ⑩末态）───────────────────────────────────────── */
    step('⑪ 日志无凭据：三容器（alert-relay/am-renderer/config-service——不含 alertmanager）全链窗口 grep needle 集全空 + 逐容器正向对照 + 判别力自证');
    // needle 集 = 五密键种子值 + smtp.invalid + probe@example.invalid + pullToken（**不含 '465'**——
    // 短值裸 substring 有假红面（NDJSON ts 毫秒域）；③ 同理排除）。
    const needles = [
      SEED_VALUES['notify.smtp.pass'],
      SEED_VALUES['notify.webhook.feishuUrl'],
      SEED_VALUES['notify.webhook.wecomUrl'],
      SEED_VALUES['notify.webhook.dingtalkUrl'],
      SEED_VALUES['notify.webhook.dingtalkSecret'],
      SEED_VALUES['notify.smtp.host'],
      SEED_VALUES['notify.smtp.user'],
      pullToken(),
    ].filter((n) => n.length > 0);
    // 判别力自证：**同一 grep 逻辑**喂合成行必命中（每个 needle 各命中一次）。
    const synthetic = `synthetic-probe-needle-a ${needles.join(' b ')} synthetic-${TAG}`;
    checks.eq(grepHits(synthetic, needles).length, needles.length, `⑪ 判别力自证：合成行喂同一 grep 逻辑 ⇒ ${needles.length} 个 needle 全命中（grep 有牙）`);
    const winSec = sinceRunStartSec();
    const relayLogs = containerLogs(RELAY_CONTAINER, winSec);
    const rendererLogs = containerLogs(RENDERER_CONTAINER, winSec);
    const cfgLogs = containerLogs(CFG_CONTAINER, winSec);
    checks.eq(grepHits(relayLogs, needles).length, 0, `⑪ alert-relay 日志窗口（自切片起点 ${winSec}s）零命中 needle 集（五密键种子值+smtp.invalid+probe@example.invalid+pullToken）`);
    checks.eq(grepHits(rendererLogs, needles).length, 0, '⑪ am-renderer 日志窗口零命中 needle 集');
    checks.eq(grepHits(cfgLogs, needles).length, 0, '⑪ config-service 日志窗口零命中 needle 集');
    // 窗口正向对照（每容器一行本 run 产物——证明窗口真的读到了本次的日志，grep 非空转）。
    checks.that(relayLogs.includes('[alert-relay] listening on :8090'), '⑪ 正向对照：relay 窗口含 ⑧ 重建的 listening 行（本 run 产物）');
    checks.that(rendererLogs.includes('[am-renderer] 启动；'), '⑪ 正向对照：renderer 窗口含 ⑧c 重建的启动行（本 run 产物）');
    checks.that(cfgLogs.includes('Config Service running on port'), '⑪ 正向对照：config-service 窗口含 ⑨ 恢复重建的启动横幅（本 run 产物）');

    /* ── 收尾（收敛自证；残留登记见文件头）──────────────────────────────────── */
    step('收尾：九键全 DELETE（幂等）⇒ ≤90s 收敛自证（①卷 yml 回 baseline 且 reload 成功 ②relay 零槽 + /data = {} 直打 200 no-op ③stub 停）');
    clearAdminWriteBucket(adminToken);
    for (const key of NOTIFY_KEY_ORDER) {
      const del = await adminNotifyChannelDelete(key, adminToken);
      expectHttp(checks, del, 200, ErrCode.OK, `收尾 DELETE ${key}（幂等）`);
    }
    const gEnd = await getStatus();
    checks.that(
      gEnd.body?.data?.keys?.every((k) => k.configured === false) === true,
      `收尾自证：九键全 configured=false —— 实际 ${JSON.stringify(gEnd.body?.data?.keys?.map((k) => [k.key, k.configured]))}`,
    );
    const convYml = await pollUntil(
      () => readAmYml() ?? '',
      (y) => y.includes('receivers:') && !y.includes('smtp_smarthost') && !y.includes('email_configs'),
      90_000,
      3_000,
    );
    checks.that(convYml.ok, '收尾① ≤90s：卷 yml 回 baseline（无 smtp 段）——收敛');
    const convSt = await pollUntil(() => amStatusOriginal(), (o) => o.length > 0 && !o.includes('smtp_smarthost'), 90_000, 3_000);
    checks.that(convSt.ok, '收尾① ≤90s：reload 成功（AM 内存 = 无 smtp 段形态）');
    const convData = await pollUntil(() => relayDataRaw(), (t) => t !== null && t.trim() === '{}', 90_000, 3_000);
    checks.that(convData.ok, `收尾② ≤90s：relay /data = {}（零槽收敛）—— 实际 ${JSON.stringify(convData.last)}`);
    const endDirect = await postWebhookDirect(syntheticPayload('S23DirectProbe', 'slice-23 收尾'));
    checks.eq(endDirect.status, 200, '收尾② 零槽直打 ⇒ 200 no-op');
    checks.that(endDirect.text.includes(NO_SINKS_BODY), `收尾② 正文逐字 \`${NO_SINKS_BODY}\``);
    const rmStub = docker(['rm', '-f', STUB_NAME], 30_000);
    checks.eq(rmStub.status, 0, '收尾③ stub 停（rm -f）');
    stubStarted = false;
    const stubLeft = docker(['ps', '-a', '--filter', `name=^/${STUB_NAME}$`, '--format', '{{.Names}}']).stdout.trim();
    checks.eq(stubLeft, '', '收尾③ stub 零残留（本 run 的探针容器已清）');
    wrappedUp = true;

    return checks;
  } finally {
    /* ── 兜底复原（异常路径也执行；每步吞异常——清理不许顶掉结论）────────────── */
    try {
      if (configStopped) {
        compose({}, 'start', 'config-service');
        info('收尾兜底：config-service 已 start（⑧ 异常路径）');
      }
    } catch { /* 兜底 */ }
    try {
      if (windowOpen && encKeySaved.length > 0) {
        compose({ PAY_CONFIG_ENC_KEY: encKeySaved, ADMIN_PASSWORD: adminPwSaved }, 'up', '-d', '--force-recreate', 'config-service');
        await waitContainerHealthy(CFG_CONTAINER, 60_000);
        info('收尾兜底：⑨ 窗口中断 ⇒ 已用存钥重建 config-service');
      }
    } catch { /* 兜底 */ }
    if (adminToken.length === 0) {
      try {
        adminToken = await adminLogin();
      } catch { /* 兜底 */ }
    }
    try {
      if (adminToken.length > 0 && !wrappedUp) {
        for (const key of NOTIFY_KEY_ORDER) {
          await adminNotifyChannelDelete(key, adminToken);
        }
        info('收尾兜底：九键已 DELETE（异常路径——下一轮/后续切片从「未配置」起）');
      }
    } catch { /* 兜底 */ }
    try {
      if (stubStarted) {
        docker(['rm', '-f', STUB_NAME], 30_000);
        info('收尾兜底：投递 stub 已停');
      }
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

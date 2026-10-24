/**
 * conformance 用例：**监控片**（指标面 / 守卫 / 告警链 / 边缘路由 / 供给链）—— `slice-16`。
 *
 * 计划：`docs/superpowers/plans/2026-10-03-monitoring.md` Task 12；
 * 规格：`docs/superpowers/specs/2026-10-03-monitoring-spec.md` §3 的 C1–C14。
 *
 * 判据载体分工（片内**只注明、不重复**）：
 *  - **C8**（relay 单测：三 sink golden · 钉钉签名固定对照向量 + 时钟注入 · 禁用槽不发 ·
 *    失败隔离 · URL/secret 不进日志/标签 · 空串=未设）：由 `packages/alert-relay/test/*` 承载。
 *  - **C13**（渲染面：六新块 R1303 命名 / 生产零 ports / logging 上限）：已由 T10 落入
 *    `slice-07.2-deploy` / `slice-07.4-pipeline` / `slice-07.2-hardening` / `slice-07.3-edge`
 *    的既有断言（同提交硬约束），本片不重复。
 *  - C14 的「真 up/down 一轮零残留」由 CI 每轮起栈/收栈**天然覆盖**（切片内拆栈会中途
 *    打断套件——Y2）；本片只做静态三断言 + 两形态 `docker compose config`。
 *
 * 探针手段（**本片全部自包含，不改 compose/脚本**）：
 *  - 八 Nest 的 `/metrics`：`docker exec <容器> curl`（镜像内自带 curl；未发布宿主口 —— D2）；
 *  - douzero：容器内无 curl ⇒ `python -c urllib`；
 *  - promtool：`docker exec` 进**运行中**的 prometheus 容器（token 已由 entrypoint 落盘
 *    600 —— 静态层跑会报 credentials_file 缺，那不是缺陷）；
 *  - stub / relay 探针：`docker run --rm -d --network pokergame_ftl-platform` 自包含
 *    （node:20-alpine 内联 http server 记录请求 + `GET /_received` 回读；relay 探针 = 同 tag
 *    的 `pokergame-alert-relay:latest` 镜像 + **每实例内联 stub 拉取源**（⚙️22：node net server
 *    回 JsonSocket 帧 + `/_pulls` 计数面；就绪 = `/health` 200 且 `/_pulls`≥1 且 200ms 沉降）
 *    —— 注入机制 = 拉取图，不再是 env）；**结尾清理全部 `ftl-probe-<pid>-*`**。
 *  - 备份 textfile（C7③）：**经容器写**（O6：路径由 daemon 侧解析，Linux CI 与 Windows dev 通吃）。
 *
 * ⚙️ 真栈核对组（结果回填见 T12 报告 / 规格 C2 行）：
 *  ① route 模板形（带 query 的请求 ⇒ metrics 里**无**原始 URL；route 标签是模板）；
 *  ② `container_last_seen` 可用性（不可用 ⇒ 按规格从 relabel 白名单去掉并回填）；
 *  ③ cadvisor relabel 的标签口径（`name` 有无前导 `/` —— C2 的正则自证 `>= 6` 当场判）；
 *  ④ AM payload golden dump = T12 报告里的实施期动作（一次性，不进本切片——切片只跑合成载荷）；
 *  ⑤ grafana `/metrics` 鉴权（Y9：若需鉴权 ⇒ scrape 加 basic_auth 并回填规格 C2 行）；
 *  ⑥ node-exporter `--help`/procfs-sysfs 收缩核（`node_filesystem_*` 与 `node_memory_*` 必须在——
 *    否则 HostDisk/Memory 两条规则**静默哑火**；本片把它固化成三条断言）。
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ErrCode } from '@fight-the-landlord/protocol';
import { Checks, ConformanceError, fieldSetViolations, info, sleep, step } from '../lib/assert';
import { GATEWAY_URL, INTERNAL_TOKEN, registerUser } from '../lib/http';
import { HarnessClient } from '../lib/client';
import { redisCli, redisLines } from '../lib/redis';
import { MATCH_BASE_SCORE, sendThrottled } from '../lib/ddz-driver';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度 ⇒ 同一个相对路径）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');
const STACK_SCRIPT = join(REPO_ROOT, 'scripts', 'deploy', 'conformance-stack.sh');
const BACKUP_SH = join(REPO_ROOT, 'scripts', 'ops', 'backup.sh');

/** dev 形态发布的宿主端口（`docker-compose.override.yml` 六条 + edge 两条；本片探针的落点）。 */
const PROM_URL = process.env.PROM_URL ?? 'http://localhost:9090';
const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://localhost:3010';
/** dev 默认口令（与 `docker-compose.override.yml` 的 `GF_SECURITY_ADMIN_PASSWORD` 默认**逐字一致**）。 */
const GRAFANA_PASSWORD = process.env.GRAFANA_ADMIN_PASSWORD ?? 'dev-grafana-pass';
const EDGE_HTTPS_PORT = process.env.EDGE_HTTPS_PORT ?? '8443';
const EDGE_BASE = `https://localhost:${EDGE_HTTPS_PORT}`;

/** 栈的平台网络（与 `slice-07.3-edge` 的 A5 同值；stub/relay 探针挂它才能互访、且不新建网络）。 */
const COMPOSE_NETWORK = 'pokergame_ftl-platform';

/** stub 探针容器内的监听端口（与任何栈内端口不撞）。 */
const STUB_PORT = 18990;

/** 拉取 stub 的 JsonSocket(TCP) 端口（每组合一只容器 ⇒ 容器间不撞；relay 探针按容器名互访）。 */
const PULL_STUB_TCP_PORT = 18991;

/** node-exporter 的 textfile bind 源（compose 逐字；daemon 侧解析，Windows dev 与 Linux CI 通吃）。 */
const TEXTFILE_HOST_DIR = process.env.TEXTFILE_HOST_DIR ?? '/home/ubuntu/ftl-monitoring/textfile';

/** 本 run 的探针容器前缀（pid 唯一 ⇒ 收尾清理与「无残留」断言都按它做，见 slice-07.5 的纪律）。 */
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`;
const PROBE_PREFIX = `ftl-probe-${RUN_ID}`;

/**
 * cadvisor 降级开关（规格 C2 的降级配方，Y3）：默认 `1`（正常形态——**本仓唯一在跑**的形态）；
 * `0` = 「cadvisor 已按 checklist 摘除」的形态，断言面换成「其余 14 个 up、cadvisor 不要求 up」。
 * 注入点：CI 由 conformance.yml 的 job env、本机 `export`（随动清单见规格 §3 C2 行）。
 */
const EXPECT_CADVISOR = (process.env.MONITORING_EXPECT_CADVISOR ?? '1') !== '0';

/** C2：15 个抓取目标（= `deploy/monitoring/prometheus/prometheus.yml` 的 15 个 job，逐个钉；支付片 T15 +payment-service）。 */
const EXPECTED_JOBS = [
  'api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service', 'config-service',
  'currency-service', 'payment-service',
  'douzero', 'node-exporter', 'cadvisor', 'prometheus', 'alertmanager', 'grafana', 'alert-relay',
] as const;

/** C2：27 条规则的**名字集合**（数量之外再钉集合——只有数量的话，27 条错规则也绿）。 */
const EXPECTED_RULES = [
  'Watchdog', 'ServiceDown', 'Http5xxRatioHigh', 'Http5xxRatioCritical',
  'HostDiskSpaceLow', 'HostDiskSpaceCritical', 'HostMemoryAvailableLow',
  'WsConnectionsHigh', 'WsConnectionsCritical', 'ContainerRestartFlapping',
  'RecordsCleanupStalled', 'RecordsCleanupFailing', 'AlertDeliveryFailing',
  'CurrencySettleOutboxStuck', 'CurrencyReconcileDrift', 'CurrencyRobotPoolLow',
  // 风控片 T10（§2.12）：两条新规则（T11 同步——数量 16→18 与名集同提交）。
  'RiskScanStalled', 'MatchPredicateRejectionHigh',
  // 支付片 T15（§2.6 逐字）：五条新规则（数量 18→23 与名集同提交）。
  'PaymentFundOpStalled', 'PaymentNotifyBadSignSpike', 'WithdrawBacklog',
  'PaymentLateNotifyReopen', 'PaymentReconcileDiff',
  // 通知片 T11（§3.8 逐字）：两条新规则（数量 23→25 与名集同提交）。
  'NotifyEmailIncomplete', 'NotifyDingtalkIncomplete',
  // 广告小片 T16（§2.7 逐字）：两条新规则（数量 25→27 与名集同提交）。
  'ReliefCallbackBroken', 'ReliefGrantZero',
] as const;

/** C1：九个目标的 exec 探测面（八 Nest + douzero；指标端口**不发布宿主口**——D2）。 */
const NEST_TARGETS = [
  { name: 'api-gateway', container: 'ftl-api-gateway', port: 9000 },
  { name: 'user-service', container: 'ftl-user-service', port: 9001 },
  { name: 'room-service', container: 'ftl-room-service', port: 9002 },
  { name: 'game-service', container: 'ftl-game-service', port: 9003 },
  { name: 'robot-service', container: 'ftl-robot-service', port: 9005 },
  { name: 'config-service', container: 'ftl-config-service', port: 9006 },
  { name: 'currency-service', container: 'ftl-currency-service', port: 9004 },
  { name: 'payment-service', container: 'ftl-payment-service', port: 9007 },
] as const;
const DOUZERO_CONTAINER = 'ftl-douzero';
const DOUZERO_PORT = 2021;

/** C5/C7/其它探针用到的镜像/容器名（同 tag 的既有产物；探针实例不改 compose）。 */
const RELAY_IMAGE = 'pokergame-alert-relay:latest';
const GRAFANA_IMAGE = 'pokergame-grafana:latest';
const STUB_IMAGE = 'node:20-alpine';

/** 拉取令牌的探针值（stub 不校验令牌；字面 = ⚙️13 dev 值——走真供给链形态）。 */
const PULL_TOKEN = 'dev-notify-channel-pull-token-change-in-production';

/** C14：`conformance-stack.sh` 的 SERVICES 必须是这 14 个（+ 无 cadvisor——订正④；支付片 T2 +payment-service）。 */
const EXPECTED_SERVICES = [
  'api-gateway', 'config-service', 'currency-service', 'douzero', 'edge', 'game-service', 'payment-service',
  'robot-service', 'room-service', 'user-service', 'prometheus', 'grafana', 'alertmanager', 'alert-relay',
] as const;

/** C14：生产形态渲染里其余服务也可能有的端口字样 —— prod 面断言「一个 published 都没有」。 */
const DEV_PUBLISHED_PORTS = ['3010', '9090', '9093', '9100', '8081', '8090'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 小工具（docker / Prom 文本 / HTTP —— 形状照 slice-13 与 slice-07.5 的成例）
// ─────────────────────────────────────────────────────────────────────────────

interface DockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** 到点被本进程的原生超时 SIGTERM 杀掉（`error.code === 'ETIMEDOUT'`）。 */
  timedOut: boolean;
}

/**
 * 跑一条 `docker` / `docker compose` 命令（**必需** `timeoutMs`：daemon 卡住必须红，
 * 不许整个切片悬挂——slice-07.2-deploy 成例）。`spawnSync` 不经 shell ⇒ 参数原样传，
 * `MSYS_NO_PATHCONV=1` 防 Git Bash 的路径转写（slice-13 纪律）。
 */
function docker(args: string[], timeoutMs: number, input?: string): DockerResult {
  const res = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: timeoutMs,
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    timedOut: (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

/** 本 run 起的探针容器名（收尾按名单清 + pid 前缀扫，两道）。 */
const spawned: string[] = [];

/** 起一只 `--rm -d` 探针容器（名字带 run 前缀 ⇒ 清理是确定的）；失败抛（带日志尾）。 */
function startProbe(name: string, args: string[], timeoutMs = 120_000): void {
  spawned.push(name);
  const res = docker(['run', '--rm', '-d', '--name', name, ...args], timeoutMs);
  if (res.status !== 0) {
    throw new ConformanceError(
      `探针容器 ${name} 起不来（退出码 ${res.status}${res.timedOut ? '，超时' : ''}）：` +
        `${(res.stderr || res.stdout).slice(-600)}`,
    );
  }
}

/** 收尾：删本 run 起的全部探针容器（失败吞掉——清理路径不许顶掉结论）+ 死 run 的安全回收。 */
function cleanupProbes(): void {
  for (const name of spawned.splice(0)) docker(['rm', '-f', name], 30_000);
  // pid 前缀扫（防 `spawned` 漏登记的路径）；**不**按裸 `ftl-probe-` 扫：同机并发 run 的活着。
  const mine = docker(['ps', '-a', '--filter', `name=^/${PROBE_PREFIX}`, '--format', '{{.Names}}'], 30_000);
  for (const name of mine.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    docker(['rm', '-f', name], 30_000);
  }
}

/** 回收**死 run** 的探针残留（名字第二段 pid 已不存在；活 run 一律跳过——slice-07.5 同款）。 */
function reapDeadProbeRuns(checks: Checks): void {
  const names = docker(['ps', '-a', '--filter', 'name=^/ftl-probe-', '--format', '{{.Names}}'], 30_000)
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    const pid = Number(name.split('-')[2]);
    if (!Number.isInteger(pid)) continue;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      alive = (err as NodeJS.ErrnoException).code === 'EPERM';
    }
    if (alive || pid === process.pid) continue;
    info(`回收死 run 残留：docker rm -f ${name}（进程 ${pid} 已不存在）`);
    docker(['rm', '-f', name], 30_000);
  }
  const left = docker(['ps', '-a', '--filter', `name=^/${PROBE_PREFIX}`, '--format', '{{.Names}}'], 30_000)
    .stdout.trim();
  checks.that(left === '', `起手态：本 run 前缀（${PROBE_PREFIX}）无残留探针容器 —— 实际 ${JSON.stringify(left)}`);
}

// ── Prometheus 文本格式（`/metrics` 与 textfile 共用一套解析）────────────────

interface PromSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** 解析 Prom 文本（剥 `#` 注释；标签只支持本仓会生成的双引号形态）。 */
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
        if (kv) {
          labels[kv[1]!] = kv[2]!.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
      }
    }
    const value = Number(m[3]);
    out.push({ name: m[1]!, labels, value: Number.isFinite(value) ? value : NaN });
  }
  return out;
}

/** 某指标全部序列的值求和（无标签的 gauge/counter 与多序列 counter 都适用；缺席 = 0）。 */
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

/** 某指标**存在多少条**序列（`container_last_seen` 可用性一类只判存在性的用）。 */
function seriesCount(text: string, name: string): number {
  return parseProm(text).filter((s) => s.name === name).length;
}

// ── HTTP（宿主 → 发布端口；带超时，Docker 端口代理会先收 TCP 再等应答——lib/http.ts 教训）──

async function httpText(url: string, init: RequestInit = {}): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

/** `/metrics` 的 exec 入口：返回 **HTTP 状态码 + body**（curl 的 `-w` 哨兵行拆开）。 */
function execCurl(container: string, port: number, path = '/metrics', token: string | null = null): { status: number; body: string } {
  const args = ['exec', container, 'curl', '-s', '-w', '\n__STATUS__%{http_code}'];
  if (token) args.push('-H', `Authorization: Bearer ${token}`);
  args.push(`http://127.0.0.1:${port}${path}`);
  const out = docker(args, 30_000);
  const m = /__STATUS__(\d+)\s*$/.exec(out.stdout);
  return { status: m ? Number(m[1]) : 0, body: out.stdout.replace(/__STATUS__\d+\s*$/, '') };
}

/** 读一个 Nest 服务的 `/metrics` 全文（带真 token——dev 栈的守卫口令与 conformance 同源）。 */
function readNestMetrics(service: (typeof NEST_TARGETS)[number]): string {
  return execCurl(service.container, service.port, '/metrics', INTERNAL_TOKEN).body;
}

/** Prometheus 即时查询（把结果向量的值相加——`count(...)`/单序列都适用；无结果 = 0）。 */
async function promInstant(expr: string): Promise<number> {
  const r = await httpText(`${PROM_URL}/api/v1/query?query=${encodeURIComponent(expr)}`);
  if (r.status !== 200) throw new ConformanceError(`Prometheus 查询 ${expr} ⇒ HTTP ${r.status}：${r.text.slice(0, 200)}`);
  const parsed = JSON.parse(r.text) as { status?: string; data?: { result?: Array<{ value?: [number, string] }> } };
  if (parsed.status !== 'success') throw new ConformanceError(`Prometheus 查询 ${expr} 非 success：${r.text.slice(0, 200)}`);
  return (parsed.data?.result ?? []).reduce((acc, s) => acc + (s.value ? Number(s.value[1]) : 0), 0);
}

/** 有界轮询：读一处读数直到条件满足（返回末次读数，调用方断言）。 */
async function pollRead(
  read: () => string | Promise<string>,
  metric: string,
  want: (n: number) => boolean,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<{ ok: boolean; last: number }> {
  const deadline = Date.now() + timeoutMs;
  let last = NaN;
  for (;;) {
    try {
      last = sumMetric(await read(), metric);
    } catch {
      last = NaN;
    }
    if (want(last)) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(intervalMs);
  }
}

// ── 边缘（TLS 自签）访问法 —— 照 slice-07.3-edge（node:https，per-request rejectUnauthorized）──

function edgeRequest(path: string): Promise<{ status: number; location: string | null; body: string }> {
  const u = new URL(`${EDGE_BASE}${path}`);
  return new Promise((resolvePromise, reject) => {
    const req = https.request(
      { hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'GET', rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === 'string' ? res.headers.location : null,
            body,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 跟随重定向（≤6 跳，**每一跳都回门口**）。
 *
 * ⚠️ grafana 的 302 Location 在 dev 形态是 `http://localhost:3010/grafana/login…`（root_url
 * 由 override 显式给容器自己的地址）——若照字面直连 3010，**最后一跳就绕开了门口**、
 * 「经门口跟随 ⇒ 200」变成对 grafana 直连的断言（空测的一半）。⇒ 对指向本机 grafana
 * 端口的绝对 Location **重写回门口**（路径原样）：三跳全程经 Caddy，才是 C4 想测的那条链。
 */
async function followViaEdge(path: string): Promise<{ status: number; finalPath: string; hops: number }> {
  let current = path;
  for (let hop = 0; hop <= 6; hop += 1) {
    const res = await edgeRequest(current);
    if (res.status >= 300 && res.status < 400 && res.location) {
      const loc = res.location;
      if (/^https?:\/\//.test(loc)) {
        const abs = new URL(loc);
        if (abs.pathname.startsWith('/grafana')) {
          current = `${abs.pathname}${abs.search}`;
          continue;
        }
        throw new ConformanceError(`边缘跳转指向了门口之外（${loc}）—— 本栈的 grafana Location 应指回 /grafana*`);
      }
      current = loc.startsWith('/') ? loc : `/${loc}`;
      continue;
    }
    return { status: res.status, finalPath: current, hops: hop };
  }
  throw new ConformanceError(`跟随 ${path} 超过 6 跳仍未收敛`);
}

// ─────────────────────────────────────────────────────────────────────────────
// C2 的纯谓词（正/负对照与实判**共用同一实现** ⇒ 判别力可用合成样本直接证明）
// ─────────────────────────────────────────────────────────────────────────────

export interface TargetSnapshot {
  job: string;
  health: string;
}

/**
 * 目标面违规清单（空 = 合规）。
 *
 * 正常形态（`expectCadvisor=true`）：15 个 job **恰好逐个在场**且 `health=up`。
 * 降级形态（`false`）：其余 14 个必须逐个在场且 up，且 cadvisor **必须缺席**（在场却 down
 * 同样判违规——降级形态是「按清单把 cadvisor 摘掉」，不是「放着不管」；T12 审查②订正注释）。
 */
export function targetHealthViolations(targets: readonly TargetSnapshot[], expectCadvisor: boolean): string[] {
  const violations: string[] = [];
  const expected = expectCadvisor ? [...EXPECTED_JOBS] : EXPECTED_JOBS.filter((j) => j !== 'cadvisor');
  const present = targets.map((t) => t.job);
  violations.push(...fieldSetViolations(present, expected));
  for (const t of targets) {
    if (!expected.includes(t.job as (typeof EXPECTED_JOBS)[number])) continue;
    if (t.health !== 'up') violations.push(`${t.job}: health=${t.health}（期望 up）`);
  }
  return violations;
}

/** 目标快照的唯一读取口（`/api/v1/targets` 的 activeTargets）。 */
async function fetchTargets(): Promise<TargetSnapshot[]> {
  const r = await httpText(`${PROM_URL}/api/v1/targets`);
  const parsed = JSON.parse(r.text) as { data?: { activeTargets?: Array<{ labels?: { job?: string }; health?: string }> } };
  return (parsed.data?.activeTargets ?? []).map((t) => ({ job: t.labels?.job ?? '', health: t.health ?? '' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// C5：容器化 stub 与 relay 探针
// ─────────────────────────────────────────────────────────────────────────────

/**
 * stub 的内联脚本（`node -e`；**同一份**给 C5 与 AM golden dump 用）。
 * 记录 `/fail*` 前缀的路径返回 500（失败隔离的构造）；`/_received` 回读、`/_reset` 清空。
 */
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
    rec.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.statusCode = path.indexOf('/fail') === 0 ? 500 : 200;
    res.end('stub');
  });
}).listen(${STUB_PORT}, '0.0.0.0', () => console.error('ftl-probe-stub ready'));
`;

interface StubHit {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** stub 的回读（`docker exec wget`——brief 的机制 a；读回是探针自身，不经宿主端口）。 */
function stubReceived(stub: string): StubHit[] {
  const out = docker(['exec', stub, 'wget', '-qO-', `http://127.0.0.1:${STUB_PORT}/_received`], 30_000);
  if (out.status !== 0) throw new ConformanceError(`读 stub 记录失败：${(out.stderr || out.stdout).slice(0, 300)}`);
  return JSON.parse(out.stdout) as StubHit[];
}

function stubReset(stub: string): void {
  const out = docker(['exec', stub, 'wget', '-qO-', `http://127.0.0.1:${STUB_PORT}/_reset`], 30_000);
  if (out.status !== 0) throw new ConformanceError(`清 stub 记录失败：${(out.stderr || out.stdout).slice(0, 300)}`);
}

/** 起 stub 并等它应答（有界；`/_received` 能读回即就绪）。 */
async function startStub(name: string): Promise<void> {
  startProbe(name, ['--network', COMPOSE_NETWORK, STUB_IMAGE, 'node', '-e', STUB_SCRIPT]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      stubReceived(name);
      return;
    } catch {
      /* 未就绪：继续等 */
    }
    if (Date.now() >= deadline) throw new ConformanceError(`stub ${name} 60s 内未就绪`);
    await sleep(1_000);
  }
}

/**
 * 拉取 stub 的内联脚本（`node -e`；⚙️22）：一只容器**两面**——TCP 面 = `config.notifyChannel.get`
 * 的 JsonSocket 对端（`<字符数>#<json>`；解析纪律照 `lib/rpc.ts:131-241`：按字符计长、`#` 分帧、
 * `id` 回验），HTTP 控制面 = `GET /_pulls` 回读累计拉取次数（照 C5 `docker exec wget` 读法，
 * 评审 S-Y5）。图值由调用方注入（`JSON.stringify` 替换进脚本；`spawnSync` 数组传参不经 shell，
 * 无转义面）。`/_pulls` 在 TCP 面 listening 前回 503 ⇒ 「能读计数」= 两面都在听。
 */
function pullStubScript(values: Record<string, string>): string {
  return `
const net = require('net');
const http = require('http');
const VALUES = ${JSON.stringify(values)};
let pulls = 0;
let tcpReady = false;
net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  let need = -1;
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      if (need < 0) {
        const i = buffer.indexOf('#');
        if (i === -1) return;
        need = parseInt(buffer.slice(0, i), 10);
        buffer = buffer.slice(i + 1);
      }
      if (buffer.length < need) return;
      const raw = buffer.slice(0, need);
      buffer = buffer.slice(need);
      need = -1;
      const req = JSON.parse(raw);
      pulls += 1;
      const reply = JSON.stringify({ id: req.id, response: { ok: true, data: { values: VALUES } } });
      socket.write(reply.length + '#' + reply, 'utf8');
    }
  });
  socket.on('error', () => {});
}).listen(${PULL_STUB_TCP_PORT}, '0.0.0.0', () => { tcpReady = true; });
http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (req.method === 'GET' && path === '/_pulls') {
    if (!tcpReady) { res.statusCode = 503; res.end('tcp not ready'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ pulls }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
}).listen(${STUB_PORT}, '0.0.0.0', () => console.error('ftl-probe-pull-stub ready'));
`;
}

/** 读一只拉取 stub 的累计拉取次数（`docker exec wget`——与 `stubReceived` 同款读法）。 */
function pullStubPulls(stub: string): number {
  const out = docker(['exec', stub, 'wget', '-qO-', `http://127.0.0.1:${STUB_PORT}/_pulls`], 30_000);
  if (out.status !== 0) throw new ConformanceError(`读拉取 stub 计数失败：${(out.stderr || out.stdout).slice(0, 300)}`);
  return (JSON.parse(out.stdout) as { pulls: number }).pulls;
}

/** 起一只拉取 stub（图值注入）并等它就绪（`/_pulls` 能读回 ⇒ TCP/HTTP 两面都在听）。 */
async function startPullStub(name: string, values: Record<string, string>): Promise<void> {
  startProbe(name, ['--network', COMPOSE_NETWORK, STUB_IMAGE, 'node', '-e', pullStubScript(values)]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      pullStubPulls(name);
      return;
    } catch {
      /* 未就绪：继续等 */
    }
    if (Date.now() >= deadline) throw new ConformanceError(`拉取 stub ${name} 60s 内未就绪`);
    await sleep(1_000);
  }
}

/**
 * 起一只 relay 探针实例（同 tag 镜像 + **stub 拉取源注入**；宿主端口显式发布 —— 宿主是驱动方）。
 *
 * ⚙️22：注入机制 = 每实例一只内联 stub 拉取源（`startPullStub`；relay 经
 * `CONFIG_SERVICE_RPC_HOST/PORT` 指到它，每调用一条新连接 ⇒ stub 计数 +1）——不再是 env。
 * 就绪语义 = `/health` 200 **且** `/_pulls` ≥1 **且** 200ms 沉降（拉取回包已应答与
 * `lastGood` 更换之间有间歇，待「首轮槽位应用」完成后再断言）。
 */
async function startRelay(name: string, hostPort: number, stubName: string, values: Record<string, string>): Promise<void> {
  await startPullStub(stubName, values);
  startProbe(name, [
    '--network', COMPOSE_NETWORK,
    '-p', `${hostPort}:8090`,
    '-e', `INTERNAL_SERVICE_TOKEN=${INTERNAL_TOKEN}`,
    '-e', `CONFIG_SERVICE_RPC_HOST=${stubName}`,
    '-e', `CONFIG_SERVICE_RPC_PORT=${PULL_STUB_TCP_PORT}`,
    '-e', `NOTIFY_CHANNEL_PULL_TOKEN=${PULL_TOKEN}`,
    RELAY_IMAGE,
  ]);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await httpText(`http://localhost:${hostPort}/health`);
      if (r.status === 200 && pullStubPulls(stubName) >= 1) {
        await sleep(200); // 沉降（⚙️22）：计数已 +1（请求已应答）⇒ 再等首轮槽位应用完成
        return;
      }
    } catch {
      /* 未就绪：继续等 */
    }
    if (Date.now() >= deadline) {
      const logs = docker(['logs', '--tail', '20', name], 20_000);
      const stubLogs = docker(['logs', '--tail', '10', stubName], 20_000);
      throw new ConformanceError(
        `relay 探针 ${name} 30s 内未就绪（/health 200 且 /_pulls≥1）：${(logs.stdout + logs.stderr).slice(-400)}` +
          `｜拉取 stub 日志尾：${(stubLogs.stdout + stubLogs.stderr).slice(-200)}`,
      );
    }
    await sleep(250);
  }
}

/** C5 的合成 AM payload（v4 schema；`formatAlert` 只消费 labels/annotations/startsAt/status）。 */
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

/** POST /webhook（Bearer 守卫；`token=null` ⇒ 故意不带，测 401）。 */
async function postWebhook(base: string, payload: unknown, token: string | null = INTERNAL_TOKEN): Promise<{ status: number; text: string }> {
  return httpText(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export async function runSlice16(): Promise<Checks> {
  const checks = new Checks();
  reapDeadProbeRuns(checks);

  try {
    // ═════════════════════════════════════════════════════════════════════════
    // C1：九目标 /metrics —— 无凭据 401 / 带 Bearer 200（douzero 免凭据）
    // ═════════════════════════════════════════════════════════════════════════
    step('C1：九目标 /metrics 的两向（八 Nest 无凭据 401 / 带 Bearer 200 含 http_requests_total；douzero 免凭据）');
    for (const svc of NEST_TARGETS) {
      const noAuth = execCurl(svc.container, svc.port, '/metrics', null);
      checks.eq(noAuth.status, 401, `C1：${svc.name} 无凭据 ⇒ 401（fail-closed）`);
      const withAuth = execCurl(svc.container, svc.port, '/metrics', INTERNAL_TOKEN);
      checks.that(
        withAuth.status === 200 && withAuth.body.includes('http_requests_total'),
        `C1：${svc.name} 带 Bearer ⇒ 200 且含 http_requests_total —— 实际 HTTP ${withAuth.status}，` +
          `body ${withAuth.body.includes('http_requests_total') ? '含' : '**不含**'}该指标（${withAuth.body.slice(0, 120)}）`,
      );
    }
    // douzero：无守卫（网络内口径），容器内无 curl ⇒ python 的 urllib。
    const douzeroProbe = docker(
      ['exec', DOUZERO_CONTAINER, 'python', '-c',
        `import urllib.request\nprint(urllib.request.urlopen('http://127.0.0.1:${DOUZERO_PORT}/metrics', timeout=10).read().decode())`],
      60_000,
    );
    const douzeroBody = douzeroProbe.stdout;
    checks.that(
      douzeroProbe.status === 0 && douzeroBody.includes('douzero_decides_total'),
      `C1：douzero /metrics（免凭据）⇒ 200 且含 douzero_decides_total —— 实际退出码 ${douzeroProbe.status}，` +
        `${douzeroBody.includes('douzero_decides_total') ? '含' : '**不含**'}该指标（${douzeroProbe.stderr.slice(0, 160)}）`,
    );

    // ⚙️①：route 模板形 —— 带 query 的请求后，metrics 里**不得**出现原始 URL（探针哨兵逐字找）。
    const sentinel = `t12-probe-${randomUUID().slice(0, 8)}`;
    const healthProbe = await httpText(`${GATEWAY_URL}/api/health?${sentinel}=1`);
    checks.eq(healthProbe.status, 200, `C1-⚙️①：带 query 的 /api/health ⇒ 200（哨兵 ${sentinel}）`);
    const gwMetrics = readNestMetrics(NEST_TARGETS[0]);
    checks.that(
      !gwMetrics.includes(sentinel),
      'C1-⚙️①：metrics 里**不得**出现原始 URL 的任何部分（哨兵串零命中 —— 出现即 route 取了 req.url 而非 req.route.path）',
    );
    const routeLabels = parseProm(gwMetrics)
      .filter((s) => s.name === 'http_requests_total' && s.labels.route !== undefined)
      .map((s) => s.labels.route!);
    checks.that(
      routeLabels.includes('/api/health') && !routeLabels.some((r) => r.includes('?')),
      `C1-⚙️①：route 标签必须是**模板形**（含 /api/health、全部无 query）—— 实际样本 ${JSON.stringify([...new Set(routeLabels)].slice(0, 12))}`,
    );

    // ═════════════════════════════════════════════════════════════════════════
    // C3：promtool（**运行中**的容器内跑——token 已由 entrypoint 落盘；静态层会误报凭据缺）
    // ═════════════════════════════════════════════════════════════════════════
    step('C3：promtool check config + check rules（docker exec 进运行中的 ftl-prometheus）');
    const checkConfig = docker(['exec', 'ftl-prometheus', '/bin/promtool', 'check', 'config', '/etc/prometheus/prometheus.yml'], 60_000);
    checks.that(
      checkConfig.status === 0 && `${checkConfig.stdout}${checkConfig.stderr}`.includes('SUCCESS'),
      `C3：promtool check config ⇒ 0 + SUCCESS —— 实际退出码 ${checkConfig.status}：` +
        `${(checkConfig.stdout + checkConfig.stderr).trim().slice(0, 300)}`,
    );
    const checkRules = docker(
      ['exec', 'ftl-prometheus', 'sh', '-c', '/bin/promtool check rules /etc/prometheus/rules/*.yml'],
      60_000,
    );
    const rulesOut = `${checkRules.stdout}${checkRules.stderr}`;
    const rulesFound = /SUCCESS: (\d+) rules found/.exec(rulesOut);
    checks.that(
      checkRules.status === 0 && rulesFound?.[1] === '27',
      `C3：promtool check rules ⇒ 0 且 **27 rules found** —— 实际退出码 ${checkRules.status}：${rulesOut.trim().slice(0, 300)}`,
    );

    // ═════════════════════════════════════════════════════════════════════════
    // C2：Prometheus 目标面（15 恰逐个 up）+ 规则 27 + 正则自证 + 降级开关
    // ═════════════════════════════════════════════════════════════════════════
    step(`C2：/api/v1/targets 15 目标逐个 up · /api/v1/rules = 27 · 容器名正则自证 · MONITORING_EXPECT_CADVISOR=${EXPECT_CADVISOR ? '1' : '0'}`);
    // 谓词正/负对照（R115 同族）：判别力用合成样本自证，防「谓词写瞎 ⇒ 恒绿」。
    const SYN_FULL: TargetSnapshot[] = EXPECTED_JOBS.map((job) => ({ job, health: 'up' }));
    checks.that(
      targetHealthViolations(SYN_FULL, true).length === 0,
      'C2 谓词正对照：15 目标全 up（正常形态）⇒ 零违规',
    );
    checks.that(
      targetHealthViolations(SYN_FULL.map((t) => (t.job === 'cadvisor' ? { ...t, health: 'down' } : t)), true).length > 0,
      'C2 谓词负对照：cadvisor down（正常形态）⇒ 必须违规',
    );
    checks.that(
      targetHealthViolations(SYN_FULL.slice(1), true).length > 0,
      'C2 谓词负对照：缺一个目标 ⇒ 必须违规（防「缺席静默」）',
    );
    const SYN_DEGRADED: TargetSnapshot[] = EXPECTED_JOBS.filter((j) => j !== 'cadvisor').map((job) => ({ job, health: 'up' }));
    checks.that(
      targetHealthViolations(SYN_DEGRADED, false).length === 0,
      'C2 谓词正对照：降级形态（14 目标 up、cadvisor 缺席）⇒ 零违规',
    );
    checks.that(
      targetHealthViolations(SYN_DEGRADED.map((t) => (t.job === 'grafana' ? { ...t, health: 'down' } : t)), false).length > 0,
      'C2 谓词负对照：降级形态里某个目标 down ⇒ 必须违规（降级不是免检）',
    );
    // 实判（有界重试窗：relay/grafana 冷启 + 15s×4 → 90s 足够）。
    let targets: TargetSnapshot[] = [];
    let targetsOk = false;
    let targetsErr = '';
    const targetsDeadline = Date.now() + 120_000;
    for (;;) {
      try {
        targets = await fetchTargets();
        if (targetHealthViolations(targets, EXPECT_CADVISOR).length === 0) {
          targetsOk = true;
          break;
        }
      } catch (err) {
        targetsErr = err instanceof Error ? err.message : String(err);
      }
      if (Date.now() >= targetsDeadline) break;
      await sleep(3_000);
    }
    const tViolations = targetHealthViolations(targets, EXPECT_CADVISOR);
    checks.that(
      targetsOk,
      `C2：15 目标**恰好逐个在场**且 up（降级形态 = 其余 14 up、cadvisor 不要求 up）—— ` +
        `违规：${tViolations.join(' | ') || '无'}${targetsErr ? `（末次读取错误：${targetsErr}）` : ''}` +
        ` 实测快照 ${JSON.stringify(targets.map((t) => `${t.job}:${t.health}`))}`,
    );
    // rules：数量 + **名字集合**（只钉数量的话，27 条错规则也绿）。
    const rulesResp = await httpText(`${PROM_URL}/api/v1/rules`);
    const rulesParsed = JSON.parse(rulesResp.text) as {
      data?: { groups?: Array<{ rules?: Array<{ name?: string; type?: string }> }> };
    };
    const ruleNames = (rulesParsed.data?.groups ?? []).flatMap((g) => g.rules ?? []).map((r) => r.name ?? '');
    checks.that(
      ruleNames.length === 27 && fieldSetViolations(ruleNames, [...EXPECTED_RULES]).length === 0,
      `C2：/api/v1/rules 恰 27 条且**名字逐个** —— 实际 ${ruleNames.length} 条；` +
        `差异 ${JSON.stringify(fieldSetViolations(ruleNames, [...EXPECTED_RULES]))}`,
    );
    // 容器名正则自证（Y7）：`/?(ftl-.*)` 失配不许静默 —— 正常形态下必须 ≥6 条序列。
    // 降级形态（cadvisor 已按 checklist 摘除、prometheus.yml 的 job 同步摘掉）：反过来断言
    // 该指标族**整体缺席**（>0 = 随动清单没走完，或 TSDB 里 5 分钟内的陈旧序列）。
    const containerSeries = await promInstant('count(container_start_time_seconds{name=~"/?(ftl-.*)"})');
    checks.that(
      EXPECT_CADVISOR ? containerSeries >= 6 : containerSeries === 0,
      EXPECT_CADVISOR
        ? `C2：容器名正则自证 count(container_start_time_seconds{name=~"/?(ftl-.*)"}) ≥ 6 —— 实际 ${containerSeries}（正则失配会是 0）`
        : `C2 降级形态：container_start_time_seconds **整体缺席**（cadvisor 已摘）—— 实际 ${containerSeries}` +
            '（>0 ⇒ 随动清单没走完，或 TSDB 陈旧序列；降级不是免检）',
    );
    // ⚙️⑥：node-exporter 收缩核 —— HostDisk/Memory 两条规则依赖的指标必须在（否则静默哑火）。
    const fsAvail = await promInstant('count(node_filesystem_avail_bytes)');
    const fsSize = await promInstant('count(node_filesystem_size_bytes)');
    const memAvail = await promInstant('count(node_memory_MemAvailable_bytes)');
    checks.that(
      fsAvail >= 1 && fsSize >= 1,
      `C2-⚙️⑥：node_filesystem_avail_bytes/size_bytes 在场（HostDiskSpace* 规则的读面）—— 实际 ${fsAvail}/${fsSize} 条序列`,
    );
    checks.that(
      memAvail >= 1,
      `C2-⚙️⑥：node_memory_MemAvailable_bytes 在场（HostMemoryAvailableLow 的读面）—— 实际 ${memAvail} 条序列`,
    );
    // ⚙️②：container_last_seen 可用性（白名单里的最后一项）—— 读回并如实登记。
    const lastSeenSeries = await promInstant('count(container_last_seen)');
    info(`C2-⚙️②：container_last_seen 实测 ${lastSeenSeries} 条序列（0 = 该指标在 cadvisor v0.60.6 已不可用 ⇒ 报告回填、按规格处置白名单）`);

    // ═════════════════════════════════════════════════════════════════════════
    // C4：边缘面（TLS 自签）—— /grafana ⇒ 301；跟随 ⇒ 200；/metrics ⇒ 404 负对照
    // ═════════════════════════════════════════════════════════════════════════
    step('C4：经门口 /grafana ⇒ 301 → 跟随 ⇒ 200（全程经门口）；负对照 /metrics ⇒ 404');
    const grafanaRedirect = await edgeRequest('/grafana');
    checks.that(
      grafanaRedirect.status === 301 && (grafanaRedirect.location ?? '').endsWith('/grafana/'),
      `C4：经门口 GET /grafana ⇒ 301 且 Location 指向 /grafana/ —— 实际 ${grafanaRedirect.status} / ` +
        `${JSON.stringify(grafanaRedirect.location)}`,
    );
    const followed = await followViaEdge('/grafana');
    checks.that(
      followed.status === 200,
      `C4：跟随重定向后 ⇒ 200（未登录 = 302 → /grafana/login，每一跳都经门口）—— 实际 ${followed.status}（落点 ${followed.finalPath}）`,
    );
    const edgeMetrics = await edgeRequest('/metrics');
    checks.eq(edgeMetrics.status, 404, 'C4 负对照：经门口 GET /metrics ⇒ 404（指标面不出网）');

    // ═════════════════════════════════════════════════════════════════════════
    // C6：Grafana —— 七面板 + datasource uid + 未设口令不启动
    // ═════════════════════════════════════════════════════════════════════════
    step('C6：Grafana 七面板（provisioning 真生效）· datasource uid=ftl-prometheus · 未设口令 ⇒ 容器不启动');
    const basicAuth = `Basic ${Buffer.from(`admin:${GRAFANA_PASSWORD}`).toString('base64')}`;
    const search = await httpText(`${GRAFANA_URL}/api/search?type=dash-db`, { headers: { authorization: basicAuth } });
    let dashTitles: string[] = [];
    try {
      dashTitles = (JSON.parse(search.text) as Array<{ title?: string }>).map((d) => d.title ?? '');
    } catch {
      dashTitles = [];
    }
    const expectedTitles = ['FTL 总览', 'FTL 业务与队列', 'FTL 主机与容器', 'FTL 记录与备份', '资金面 / Currency', '风控 / Risk', '支付 / Payment', 'FTL 玩家与营收'];
    checks.that(
      dashTitles.length === 8 && fieldSetViolations(dashTitles, expectedTitles).length === 0,
      `C6：登录后 /api/search 恰八块面板且**名字逐个** —— 实际 HTTP ${search.status}：${JSON.stringify(dashTitles)}` +
        `（差异 ${JSON.stringify(fieldSetViolations(dashTitles, expectedTitles))}）`,
    );
    const ds = await httpText(`${GRAFANA_URL}/api/datasources/uid/ftl-prometheus`, { headers: { authorization: basicAuth } });
    let dsUid = '';
    try {
      dsUid = (JSON.parse(ds.text) as { uid?: string }).uid ?? '';
    } catch {
      dsUid = '';
    }
    checks.that(
      ds.status === 200 && dsUid === 'ftl-prometheus',
      `C6：datasource uid = ftl-prometheus（provisioning 落点）—— 实际 HTTP ${ds.status} uid=${JSON.stringify(dsUid)}`,
    );
    const guardRun = docker(['run', '--rm', '-e', 'GF_SECURITY_ADMIN_PASSWORD=', GRAFANA_IMAGE], 90_000);
    checks.that(
      guardRun.status !== null && guardRun.status !== 0,
      `C6：未设口令（空串）⇒ grafana 容器**不启动**（非零退出；${'$'}{VAR:?} 的 fail-closed）—— ` +
        `实际退出码 ${guardRun.status}；输出尾 ${(guardRun.stdout + guardRun.stderr).trim().slice(-200)}`,
    );

    // ═════════════════════════════════════════════════════════════════════════
    // C5：relay 真栈探针（stub 记录回读）—— 拉取注入四组合 / 失败隔离 / 守卫
    // ═════════════════════════════════════════════════════════════════════════
    step('C5：relay 探针实例（stub 拉取注入：全未配/部分配/全配+stub500/全槽失败）+ 容器化 stub 回读');
    const stub = `${PROBE_PREFIX}-stub`;
    await startStub(stub);
    const stubBase = `http://${stub}:${STUB_PORT}`;
    const relayPorts = { a: 18091, b: 18092, c: 18093, d: 18094 };
    const relayA = `${PROBE_PREFIX}-relay-a`;
    const relayB = `${PROBE_PREFIX}-relay-b`;
    const relayC = `${PROBE_PREFIX}-relay-c`;
    const relayD = `${PROBE_PREFIX}-relay-d`;
    const payload = syntheticPayload('FTLProbeAlert', 'T12 合成载荷：告警链探针');
    const expectTitle = '[warning] FTLProbeAlert';

    stubReset(stub);
    // 组合①：拉取图 = 空图 `{}`（**成功空图**——零槽；≠ 从未拉到）⇒ 200 no-op；未配槽位不发（负对照）。
    await startRelay(relayA, relayPorts.a, `${PROBE_PREFIX}-pull-a`, {});
    const aResp = await postWebhook(`http://localhost:${relayPorts.a}`, payload);
    checks.eq(aResp.status, 200, 'C5①：全未配（成功空图）⇒ /webhook 200（明示 no-op，无「失败」可重投）');
    checks.eq(stubReceived(stub).length, 0, 'C5① 负对照：全未配 ⇒ stub 一个请求都不该收到');

    // 组合②：拉取图只含飞书 ⇒ 逐字格式正确的飞书载荷；其余槽位不发。
    stubReset(stub);
    await startRelay(relayB, relayPorts.b, `${PROBE_PREFIX}-pull-b`, {
      'notify.webhook.feishuUrl': `${stubBase}/feishu`,
    });
    const bResp = await postWebhook(`http://localhost:${relayPorts.b}`, payload);
    checks.eq(bResp.status, 200, 'C5②：部分配（只飞书）⇒ 200（至少一个已配置 sink 成功）');
    const bHits = stubReceived(stub);
    checks.eq(bHits.length, 1, 'C5②：stub 恰收到 1 条（未配槽位不发 —— wecom/dingtalk 负对照）');
    checks.eq(bHits[0]?.url ?? '', '/feishu', 'C5②：收到的就是**飞书**槽（路径逐字）');
    let feishuBody: { msg_type?: string; content?: { text?: string } } = {};
    try {
      feishuBody = JSON.parse(bHits[0]?.body ?? '{}');
    } catch {
      feishuBody = {};
    }
    checks.that(
      feishuBody.msg_type === 'text'
        && (feishuBody.content?.text ?? '').startsWith(`${expectTitle}\n`)
        && (feishuBody.content?.text ?? '').includes('T12 合成载荷'),
      `C5②：飞书载荷逐字格式（msg_type=text；正文首行 "[warning] FTLProbeAlert"；含 summary）—— ` +
        `实际 ${JSON.stringify(feishuBody).slice(0, 240)}`,
    );

    // 组合③：拉取图四键全配 + stub 对飞书 500 ⇒ 仅该槽 error、其余照达、HTTP 200；守卫两向。
    stubReset(stub);
    await startRelay(relayC, relayPorts.c, `${PROBE_PREFIX}-pull-c`, {
      'notify.webhook.feishuUrl': `${stubBase}/fail-feishu`,
      'notify.webhook.wecomUrl': `${stubBase}/wecom`,
      'notify.webhook.dingtalkUrl': `${stubBase}/dingtalk`,
      'notify.webhook.dingtalkSecret': 'probe-secret-123',
    });
    const cMetricsBefore = (await httpText(`http://localhost:${relayPorts.c}/metrics`, {
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })).text;
    const cNoAuth = await httpText(`http://localhost:${relayPorts.c}/metrics`);
    checks.eq(cNoAuth.status, 401, 'C5③ 守卫：relay /metrics 无 Bearer ⇒ 401');
    const cWebhookNoAuth = await postWebhook(`http://localhost:${relayPorts.c}`, payload, null);
    checks.eq(cWebhookNoAuth.status, 401, 'C5③ 守卫：relay /webhook 无 Bearer ⇒ 401（fail-closed）');
    const cResp = await postWebhook(`http://localhost:${relayPorts.c}`, payload);
    checks.eq(cResp.status, 200, 'C5③：一槽 500 但其余成功 ⇒ HTTP 200（单槽失败隔离）');
    const cHits = stubReceived(stub);
    checks.eq(cHits.length, 3, 'C5③：全配 ⇒ stub 恰收到 3 条（三槽各一次）');
    const dingHit = cHits.find((h) => h.url.startsWith('/dingtalk'));
    const cMetricsAfter = (await httpText(`http://localhost:${relayPorts.c}/metrics`, {
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })).text;
    const feishuErr = seriesValue(cMetricsAfter, 'alert_deliveries_total', { sink: 'feishu', result: 'error' }) ?? 0;
    const wecomOk = seriesValue(cMetricsAfter, 'alert_deliveries_total', { sink: 'wecom', result: 'ok' }) ?? 0;
    const dingOk = seriesValue(cMetricsAfter, 'alert_deliveries_total', { sink: 'dingtalk', result: 'ok' }) ?? 0;
    checks.that(
      feishuErr === 1,
      `C5③：飞书槽（stub 500）⇒ {result="error"} 恰 +1（新实例、无前序流量）—— 实际 ${feishuErr}` +
        `（before 里该序列 = ${seriesValue(cMetricsBefore, 'alert_deliveries_total', { sink: 'feishu', result: 'error' }) ?? 0}）`,
    );
    checks.that(
      wecomOk === 1 && dingOk === 1,
      `C5③：企微/钉钉照达（{result="ok"} 各恰 +1）—— 实际 wecom=${wecomOk} dingtalk=${dingOk}`,
    );
    const dingUrl = new URL(`http://stub${dingHit?.url ?? '/'}`);
    const dingTs = Number(dingUrl.searchParams.get('timestamp') ?? '0');
    checks.that(
      dingTs > 1_000_000_000_000 && (dingUrl.searchParams.get('sign') ?? '') !== '',
      `C5③：钉钉 URL 带毫秒 timestamp 与 sign（Y12：秒级会被平台静默拒收）—— 实际 ts=${dingTs}`,
    );
    let dingBody: { msgtype?: string; markdown?: { title?: string; text?: string } } = {};
    try {
      dingBody = JSON.parse(dingHit?.body ?? '{}');
    } catch {
      dingBody = {};
    }
    checks.that(
      dingBody.msgtype === 'markdown' && dingBody.markdown?.title === expectTitle
        && (dingBody.markdown?.text ?? '').startsWith(`**${expectTitle}**`),
      `C5③：钉钉载荷逐字（msgtype=markdown；title=[warning] FTLProbeAlert；text 首行加粗标题）—— ` +
        `实际 ${JSON.stringify(dingBody).slice(0, 240)}`,
    );
    const wecomHit = cHits.find((h) => h.url === '/wecom');
    let wecomBody: { msgtype?: string; markdown?: { content?: string } } = {};
    try {
      wecomBody = JSON.parse(wecomHit?.body ?? '{}');
    } catch {
      wecomBody = {};
    }
    checks.that(
      wecomBody.msgtype === 'markdown' && (wecomBody.markdown?.content ?? '').startsWith(`**${expectTitle}**`),
      `C5③：企微载荷逐字（msgtype=markdown；content 首行加粗标题）—— 实际 ${JSON.stringify(wecomBody).slice(0, 240)}`,
    );

    // 组合④：拉取图四键、已配置 sink **全部**失败（三槽路径全走 stub 的 500 面）⇒ 500
    //（让 AM 按 repeat_interval 重投）。
    stubReset(stub);
    await startRelay(relayD, relayPorts.d, `${PROBE_PREFIX}-pull-d`, {
      'notify.webhook.feishuUrl': `${stubBase}/fail-feishu`,
      'notify.webhook.wecomUrl': `${stubBase}/fail-wecom`,
      'notify.webhook.dingtalkUrl': `${stubBase}/fail-dingtalk`,
      'notify.webhook.dingtalkSecret': 'probe-secret-123',
    });
    const dResp = await postWebhook(`http://localhost:${relayPorts.d}`, payload);
    checks.eq(dResp.status, 500, 'C5④：全槽失败 ⇒ 500（AM 重投的语义依据）');
    const dMetrics = (await httpText(`http://localhost:${relayPorts.d}/metrics`, {
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })).text;
    checks.that(
      (seriesValue(dMetrics, 'alert_deliveries_total', { sink: 'feishu', result: 'error' }) ?? 0) === 1
        && (seriesValue(dMetrics, 'alert_deliveries_total', { sink: 'wecom', result: 'error' }) ?? 0) === 1
        && (seriesValue(dMetrics, 'alert_deliveries_total', { sink: 'dingtalk', result: 'error' }) ?? 0) === 1,
      'C5④：三槽 {result="error"} 各 +1（全失败真的被记成失败，不是静默 500）',
    );

    // ═════════════════════════════════════════════════════════════════════════
    // C7：备份 textfile 两向 + 上板链路（经容器写样例）
    // ═════════════════════════════════════════════════════════════════════════
    step('C7：backup.sh 真 CLI flags（scratch 替身）—— ok 两跑 + 失败注入 carry-forward；经容器写样例上板');
    const c7Root = mkdtempSync(join(tmpdir(), 'ftl-probe-c7-'));
    const c7Dest = join(c7Root, 'dest');
    const c7Textfile = join(c7Root, 'textfile');
    const c7EnvFile = join(c7Root, '.env');
    const c7CaddyDir = join(c7Root, 'caddy-data');
    mkdirSync(c7Dest, { recursive: true });
    mkdirSync(c7Textfile, { recursive: true });
    mkdirSync(c7CaddyDir, { recursive: true });
    writeFileSync(c7EnvFile, 'JWT_SECRET=probe\nDB_PASSWORD=probe-root\n');
    writeFileSync(join(c7CaddyDir, 'certificates.pem'), 'PROBE-CERT\n');
    const c7Mysql = `${PROBE_PREFIX}-c7-mysql`;
    const c7Prom = join(c7Textfile, 'backup.prom');
    /** Windows 反斜杠路径 → 正斜杠形态（交给 bash/env/coreutils 一律用这份；Linux 上无变化）。 */
    const posix = (p: string): string => p.replace(/\\/g, '/');
    try {
      startProbe(c7Mysql, [
        '-e', 'MYSQL_ROOT_PASSWORD=probe-root',
        '-e', 'MYSQL_DATABASE=ftl_probe',
        // 挂 /data：backup.sh ⓑ 是 `docker exec <edge> tar … -C /data .` ⇒ 替身要有卷持有者。
        '-v', `${posix(c7CaddyDir)}:/data`,
        'mysql:8.0',
      ]);
      // 就绪（与 slice-07.5 同款、同一收紧口径）：谓词 = `SELECT @@port` 必须 = 3306。
      // ⚠️ `mysqladmin ping` 与 `SELECT 1` 都会**被临时服务器骗过**（首次初始化时 entrypoint 的
      //    临时服务器 skip-networking，但库建好后照样答 SELECT 1）⇒ 提前放行正好落进「临停/真未起」
      //    的窗口吃 `ERROR 2002 socket (2)`（2026-10-03 CI 实证：slice-07.5 同款闸真吃过）。
      let ready = false;
      const c7Deadline = Date.now() + 180_000;
      while (Date.now() < c7Deadline) {
        const probe = docker(['exec', c7Mysql, 'mysql', '-uroot', '-pprobe-root', '-N', '-B', '-e', 'SELECT @@port;'], 30_000);
        if (probe.status === 0 && probe.stdout.trim() === '3306') {
          ready = true;
          break;
        }
        await sleep(2_000);
      }
      checks.that(ready, 'C7 前置：scratch MySQL 就绪（SELECT @@port = 3306；不是 ping、也不是 SELECT 1）');

      const backupArgs = (extra: string[] = []): string[] => [
        BACKUP_SH, '--dest', posix(c7Dest), '--mysql-container', c7Mysql, '--db-name', 'ftl_probe',
        '--edge-container', c7Mysql, '--env-file', posix(c7EnvFile), '--stack-container', c7Mysql,
        '--min-free-mb', '0', ...extra,
      ];
      const runBackup = (extra: string[] = []): { status: number | null; log: string } => {
        const r = spawnSync('bash', backupArgs(extra), {
          encoding: 'utf8',
          env: { ...process.env, TEXTFILE_DIR: posix(c7Textfile), MSYS_NO_PATHCONV: '1' },
        });
        const logPath = join(c7Dest, 'backup.log');
        let log = '';
        try {
          log = readFileSync(logPath, 'utf8');
        } catch {
          log = '';
        }
        return { status: r.status, log };
      };

      // ① 成功一轮：两指标出现且时间戳前进（首跑：attempt == success）。
      const run1 = runBackup();
      checks.eq(run1.status, 0, 'C7①：backup.sh 对 scratch 替身成功（exit 0）');
      const prom1 = readFileSync(c7Prom, 'utf8');
      const attempt1 = seriesValue(prom1, 'backup_last_attempt_timestamp_seconds', {});
      const success1 = seriesValue(prom1, 'backup_last_success_timestamp_seconds', {});
      const result1 = seriesValue(prom1, 'backup_last_attempt_result', { result: 'ok' });
      checks.that(
        (attempt1 ?? 0) > 0 && (success1 ?? 0) > 0 && result1 === 1,
        `C7①：backup.prom 出现且 ok 两指标齐（attempt=${attempt1}, success=${success1}, result=ok:${result1}）—— ` +
          `文件 ${JSON.stringify(prom1)}`,
      );
      checks.eq(attempt1, success1, 'C7①：首跑（无 prev）attempt == success（成功时间戳就写在本轮）');

      // ①b 再跑一轮（跨 ≥1s）：时间戳必须**前进**（防「写死/没写」的空转绿）。
      await sleep(1_100);
      const run2 = runBackup();
      checks.eq(run2.status, 0, 'C7①b：第二跑仍成功（exit 0）');
      const prom2 = readFileSync(c7Prom, 'utf8');
      const attempt2 = seriesValue(prom2, 'backup_last_attempt_timestamp_seconds', {}) ?? 0;
      const success2 = seriesValue(prom2, 'backup_last_success_timestamp_seconds', {}) ?? 0;
      checks.that(
        attempt2 > (attempt1 ?? 0) && success2 === attempt2,
        `C7①b：第二跑时间戳**前进**且 success 跟着走（attempt ${attempt1} → ${attempt2}）`,
      );

      // ② 失败注入（不存在的库名——最廉价的注入，slice-07.5 判据 f 成例）：
      //    result=failure 且**上次成功时间戳保留**（carry-forward）。
      await sleep(1_100);
      const run3 = runBackup(['--db-name', 'ftl_probe_missing']);
      checks.that(
        run3.status !== null && run3.status !== 0,
        `C7②：mysqldump 失败注入 ⇒ backup.sh 非零退出 —— 实际 ${run3.status}；log 尾 ${run3.log.trim().split('\n').slice(-2).join(' / ')}`,
      );
      const prom3 = readFileSync(c7Prom, 'utf8');
      const attempt3 = seriesValue(prom3, 'backup_last_attempt_timestamp_seconds', {}) ?? 0;
      const success3 = seriesValue(prom3, 'backup_last_success_timestamp_seconds', {});
      const result3 = seriesValue(prom3, 'backup_last_attempt_result', { result: 'failure' });
      checks.that(
        attempt3 > attempt2 && result3 === 1,
        `C7②：失败轮 result="failure" 且 attempt 前进（${attempt2} → ${attempt3}）—— 文件 ${JSON.stringify(prom3)}`,
      );
      checks.eq(success3, success2, 'C7②：失败**不擦**上次成功时间戳（carry-forward —— 新鲜度面板要读到真值）');
    } finally {
      docker(['rm', '-f', c7Mysql], 60_000);
      try {
        rmSync(c7Root, { recursive: true, force: true });
      } catch (err) {
        info(`C7 scratch 目录清理失败（不影响判据）：${String(err)}`);
      }
    }

    // ③ 上板链路：**经容器写**样例（O6）→ node-exporter textfile → Prometheus 查到 → 清掉。
    const sampleName = 'ftl_probe_sample';
    const writeSample = docker(
      ['run', '--rm', '-v', `${TEXTFILE_HOST_DIR}:/t`, STUB_IMAGE, 'sh', '-c',
        // 路径由 daemon 侧解析 ⇒ Linux CI 与 Windows dev 同一份写法（O6）。
        `printf '# HELP ftl_probe_sample T12 上板链路样例\\n# TYPE ftl_probe_sample gauge\\n${sampleName} 42\\n' > /t/${sampleName}.prom && chmod 644 /t/${sampleName}.prom`],
      120_000,
    );
    checks.eq(writeSample.status, 0, 'C7③：经容器把样例 .prom 写进 textfile 挂载源（daemon 侧解析路径）');
    let sampledValue = NaN;
    const sampleDeadline = Date.now() + 60_000;
    for (;;) {
      try {
        sampledValue = await promInstant(sampleName);
      } catch {
        sampledValue = NaN;
      }
      if (sampledValue === 42) break;
      if (Date.now() >= sampleDeadline) break;
      await sleep(3_000);
    }
    checks.eq(sampledValue, 42, 'C7③：Prometheus 查到样例指标 = 42（node-exporter textfile → 抓取整链通）');
    const cleanSample = docker(
      ['run', '--rm', '-v', `${TEXTFILE_HOST_DIR}:/t`, STUB_IMAGE, 'rm', '-f', `/t/${sampleName}.prom`],
      120_000,
    );
    const listAfter = docker(['run', '--rm', '-v', `${TEXTFILE_HOST_DIR}:/t`, STUB_IMAGE, 'ls', '/t'], 120_000);
    checks.that(
      cleanSample.status === 0 && !listAfter.stdout.includes(`${sampleName}.prom`),
      `C7③：样例**用完清掉**（textfile 目录不留探针文件）—— 实际目录：${JSON.stringify(listAfter.stdout.trim())}`,
    );

    // ═════════════════════════════════════════════════════════════════════════
    // C10：WS gauge —— 基线化口径（基线 → +1 → 断线 → 回基）
    // ═════════════════════════════════════════════════════════════════════════
    step('C10：ws_connections 真栈探针（先读基线 → 连接一条 → 基线+1 → 断开 → 回基）');
    const roomSvc = NEST_TARGETS[2]!;
    const wsBase = sumMetric(readNestMetrics(roomSvc), 'ws_connections');
    checks.that(Number.isFinite(wsBase) && wsBase >= 0, `C10：基线读数可判（ws_connections=${wsBase}）`);
    const wsUser = await registerUser(8);
    const wsClient = await HarnessClient.connect('S16-C10', wsUser);
    try {
      const up = await pollRead(() => readNestMetrics(roomSvc), 'ws_connections', (n) => n === wsBase + 1, 20_000);
      checks.that(up.ok, `C10：连接一条 ⇒ 基线+1（${wsBase} → ${wsBase + 1}）—— 实际末次读数 ${up.last}`);
    } finally {
      wsClient.disconnect();
    }
    const down = await pollRead(() => readNestMetrics(roomSvc), 'ws_connections', (n) => n === wsBase, 20_000);
    checks.that(down.ok, `C10：断开 ⇒ 回基（${wsBase}）—— 实际末次读数 ${down.last}`);
    wsClient.close();

    // ═════════════════════════════════════════════════════════════════════════
    // C11：业务 gauge 存在性 + 弱活动信号（造票 → 补位开局 → 机器人决策）
    // ═════════════════════════════════════════════════════════════════════════
    step('C11：match_queue_length（造票 ≥1 且与 Redis ZCARD 对账）· rooms_active/games_active 开局后上升 · robot_decisions_total 上升');
    const gameSvc = NEST_TARGETS[3]!;
    const robotSvc = NEST_TARGETS[4]!;
    const roomsBefore = sumMetric(readNestMetrics(roomSvc), 'rooms_active');
    const gamesBefore = sumMetric(readNestMetrics(gameSvc), 'games_active');
    const robotBefore = sumMetric(readNestMetrics(robotSvc), 'robot_decisions_total');
    info(`C11 基线：rooms_active=${roomsBefore} · games_active=${gamesBefore} · robot_decisions_total=${robotBefore}`);
    const mUser = await registerUser(7);
    const mClient = await HarnessClient.connect('S16-C11', mUser);
    let queueOk = false;
    let queueGauge = NaN;
    let queueZcard = NaN;
    let joinedRoom = '';
    let dealSeat = -1;
    let dealVersion = -1;
    let humanFirstBidder = false;
    let bidCode = -999;
    try {
      const matchAck = await sendThrottled(mClient, 'room.match', { mode: 'random', baseScore: MATCH_BASE_SCORE }, 0);
      checks.eq(matchAck.code, ErrCode.OK, 'C11：room.match 成功入队（底分 = 最小档）');
      // 队列读数：gauge 与 Redis ZCARD 对账（同一次轮询里读两处；票在 30s 补位窗口里）。
      const queueDeadline = Date.now() + 25_000;
      for (;;) {
        const gauge = sumMetric(readNestMetrics(roomSvc), 'match_queue_length');
        const keys = redisLines(['KEYS', 'match:queue:*']);
        const zcard = keys.reduce((acc, k) => acc + Number(redisCli(['ZCARD', k]).trim() || '0'), 0);
        queueGauge = gauge;
        queueZcard = zcard;
        if (gauge >= 1 && gauge === zcard) {
          queueOk = true;
          break;
        }
        if (Date.now() >= queueDeadline) break;
        await sleep(1_000);
      }
      checks.that(
        queueOk,
        `C11：造一张票后 match_queue_length ≥ 1 且与 Redis ZCARD 对账相等 —— 实际 gauge=${queueGauge}，zcard=${queueZcard}`,
      );
      const matched = await mClient.waitFor('room.matched', 45_000);
      joinedRoom = matched.payload.roomCode as string;
      const joinAck = await sendThrottled(mClient, 'room.join', { roomCode: joinedRoom }, 0);
      checks.eq(joinAck.code, ErrCode.OK, `C11：room.matched（${joinedRoom}）→ room.join 成功`);
      const deal = await mClient.waitFor('game.deal', 25_000);
      dealSeat = deal.payload.seat as number;
      dealVersion = deal.payload.version as number;
      humanFirstBidder = deal.payload.bidPhase?.currentBidder === dealSeat;
      checks.that(
        typeof dealSeat === 'number' && dealVersion > 0 && Array.isArray(deal.payload.hand) && deal.payload.hand.length > 0,
        `C11：game.deal 到手（seat=${dealSeat} v${dealVersion} 手牌 ${deal.payload.hand?.length} 张 —— 开局真的发生了）`,
      );
      // rooms_active：**与 Redis 真值对账 + 本局房在册**（确定性口径）。
      // ⚠️ T13b CI 首跑订正：原断言是「净增量 ≥ 基线+1」——共享计数器上的**净差**会被
      //    同期其他房间到期抵消（CI 实测 19→19：本房其实在册，但净差被吃掉/采样相位错开）；
      //    新的两条件对**本房**成立且与采样器契约（gauge == SCAN 真值）直接对齐，不再受他房涨落影响。
      let roomsGauge = NaN;
      let roomsTruth = NaN;
      let roomsHasOurs = false;
      const roomsDeadline = Date.now() + 30_000;
      for (;;) {
        roomsGauge = sumMetric(readNestMetrics(roomSvc), 'rooms_active');
        const roomKeys = redisLines(['KEYS', 'room:*']).filter((k) => !k.slice('room:'.length).includes(':'));
        roomsTruth = roomKeys.length;
        roomsHasOurs = roomKeys.includes(`room:${joinedRoom}`);
        if (roomsGauge === roomsTruth && roomsHasOurs) break;
        if (Date.now() >= roomsDeadline) break;
        await sleep(1_000);
      }
      checks.that(
        roomsGauge === roomsTruth && roomsHasOurs,
        `C11：rooms_active 与 Redis 真值一致且本局房在册（${joinedRoom}）—— 实际 gauge=${roomsGauge}，truth=${roomsTruth}，本房在册=${roomsHasOurs}`,
      );
      const gamesUp = await pollRead(() => readNestMetrics(gameSvc), 'games_active', (n) => n >= gamesBefore + 1, 30_000);
      checks.that(
        gamesUp.ok,
        `C11：games_active 开局后 ≥ 基线+1（per-instance，cache.size；${gamesBefore} → ${gamesBefore + 1}）—— 实际末次 ${gamesUp.last}`,
      );
      // 机器人决策：叫抢期恒 result=rule（不是失败信号——Y4）；人类是首叫者时先行动一次**解锁**机器人回合。
      if (humanFirstBidder) {
        bidCode = (await sendThrottled(mClient, 'game.bid', { grab: true }, dealVersion)).code;
      }
      checks.that(
        !humanFirstBidder || bidCode === ErrCode.OK,
        `C11：人类首叫时 game.bid 成功（解锁机器人回合）—— humanFirstBidder=${humanFirstBidder} bidCode=${bidCode}`,
      );
      const robotUp = await pollRead(
        () => readNestMetrics(robotSvc),
        'robot_decisions_total',
        (n) => n > robotBefore,
        30_000,
      );
      checks.that(
        robotUp.ok,
        `C11：robot_decisions_total 在一局含机器人后上升（${robotBefore} → 末次 ${robotUp.last}）`,
      );
    } finally {
      mClient.close();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // C12：记录清理四指标 —— 等首轮成功（≤90s 窗口）读 last_success > 0
    // ═════════════════════════════════════════════════════════════════════════
    step('C12：user-service 记录清理四指标（等首轮成功 ⇒ last_success > 0）');
    const userSvc = NEST_TARGETS[1]!;
    const cleanupPoll = await pollRead(
      () => readNestMetrics(userSvc),
      'records_cleanup_last_success_timestamp_seconds',
      (n) => n > 0,
      90_000,
      3_000,
    );
    checks.that(
      cleanupPoll.ok,
      `C12：records_cleanup_last_success_timestamp_seconds > 0（首轮 30s 内应已成功；启动置 0 ⇒ 从未成功会被规则命中）—— ` +
        `实际末次读数 ${cleanupPoll.last}`,
    );
    const userMetrics = readNestMetrics(userSvc);
    const otherPresence = ['records_cleanup_failures_total', 'records_rows_deleted_total', 'records_table_bytes']
      .filter((name) => seriesCount(userMetrics, name) === 0);
    checks.that(
      otherPresence.length === 0,
      `C12：其余三个指标也在场（failures/rows_deleted/table_bytes）—— 缺席 ${JSON.stringify(otherPresence)}`,
    );

    // ═════════════════════════════════════════════════════════════════════════
    // C14：供给链静态三断言 + 两形态 `docker compose config`
    // ═════════════════════════════════════════════════════════════════════════
    step('C14：conformance-stack.sh 静态三断言（up×2 profile / down 点名 rm 六容器 / SERVICES 恰 14 无 cadvisor）+ 两形态渲染');
    const stackSrc = readFileSync(STACK_SCRIPT, 'utf8');
    const upWithProfiles = stackSrc.match(/docker compose --profile edge --profile monitoring up /g) ?? [];
    checks.that(
      upWithProfiles.length === 2,
      `C14：两处 up（PULL_MODE 0/1）**都**带 --profile edge --profile monitoring —— 实际带两 profile 的 up ${upWithProfiles.length} 处`,
    );
    const downRm = 'docker compose --profile monitoring rm -sf prometheus grafana alertmanager node-exporter cadvisor alert-relay';
    checks.that(
      stackSrc.includes(downRm),
      'C14：down 前置**点名 rm 六容器**（down 删不掉带 profile 的服务 —— R1209；漏删 ⇒ 下一轮无残留判据空测）',
    );
    const servicesMatch = /SERVICES=\(([^)]*)\)/.exec(stackSrc);
    const services = servicesMatch ? servicesMatch[1]!.trim().split(/\s+/) : [];
    checks.that(
      servicesMatch !== null && services.length === 14
        && fieldSetViolations(services, [...EXPECTED_SERVICES]).length === 0
        && !services.includes('cadvisor'),
      `C14：SERVICES 恰 14 项、不含 cadvisor（订正④：官方字面名直拉、无搬运）—— 实际 ${services.length} 项：` +
        `${JSON.stringify(fieldSetViolations(services, [...EXPECTED_SERVICES]))}`,
    );
    // 两形态渲染（纯渲染，不需要 daemon 之外的东西；生产 = 零 published —— 监控片不破此口径）。
    const prodRender = docker(['compose', '-f', 'docker-compose.yml', 'config'], 120_000);
    checks.eq(prodRender.status, 0, 'C14：docker compose -f docker-compose.yml config（生产形态）⇒ 0');
    // ⚠️ 「零 published」的**绝对**口径是 slice-07.2-deploy 的 A 系列（基文件里门口本来就有 80/443）。
    //    本片只钉自己引进的面：六个监控宿主端口（dev override 的六条）**不得**漏进生产渲染。
    const leakedProdPorts = DEV_PUBLISHED_PORTS.filter((p) => prodRender.stdout.includes(`published: "${p}"`));
    checks.that(
      leakedProdPorts.length === 0,
      `C14：生产形态**不发布**任何监控宿主端口（3010/9090/9093/9100/8081/8090 —— 六新块一律 expose）—— ` +
        `实际泄漏 ${JSON.stringify(leakedProdPorts)}`,
    );
    const prodServices = docker(['compose', '-f', 'docker-compose.yml', 'config', '--services'], 120_000);
    const prodNames = prodServices.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    checks.that(
      ['prometheus', 'grafana', 'alertmanager', 'node-exporter', 'cadvisor', 'alert-relay']
        .every((n) => prodNames.includes(n)),
      `C14：生产形态六监控服务齐（container 块渲染生效）—— 实际服务数 ${prodNames.length}`,
    );
    // ⚠️ dev 渲染**必须带 `--profile monitoring`**：`config` 与 `up` 同规 —— 带 profile 的服务
    //    不带对应 `--profile` 时根本不进渲染（实测：裸 `config` 里六监控块整块缺席）。
    const devRender = docker(['compose', '--profile', 'monitoring', 'config'], 120_000);
    checks.eq(devRender.status, 0, 'C14：docker compose --profile monitoring config（dev 合并形态）⇒ 0');
    const missingPublished = DEV_PUBLISHED_PORTS.filter((p) => !devRender.stdout.includes(`published: "${p}"`));
    checks.that(
      missingPublished.length === 0,
      `C14：dev 形态六监控宿主端口全发布（3010/9090/9093/9100/8081/8090）—— 缺 ${JSON.stringify(missingPublished)}`,
    );

    // ═════════════════════════════════════════════════════════════════════════
    // 收尾：清理本 run 的全部探针容器，并断言「零残留」（正常路径；失败路径由 finally 兜底清）
    // ═════════════════════════════════════════════════════════════════════════
    cleanupProbes();
    const leftover = docker(['ps', '-a', '--filter', `name=^/${PROBE_PREFIX}`, '--format', '{{.Names}}'], 30_000)
      .stdout.trim();
    checks.that(leftover === '', `收尾：本 run 的 ftl-probe-* 容器全部清理（零残留）—— 实际 ${JSON.stringify(leftover)}`);

    return checks;
  } finally {
    // 收尾（**无论成败**）：残留会污染下一轮与 `conformance-stack.sh down` 的无残留断言。
    cleanupProbes();
  }
}

/**
 * slice-26 —— 客户端接入开关（端闸）真栈组（C17 真栈半边 / C19 / C23 真栈半边 /
 * C25 真栈半边 / C26 / C36–C39 载体）。
 *
 * 分组：⓪ 起手（两键知基线自证 true + /metrics 基线读数）· A h5 关（闸矩阵 + 非法值格）
 * · B 真链序（关闸端 + 无令牌 + 非豁免路径 ⇒ 10008 不是 10002）· C 三豁免（admin/login ·
 * health ×2 · `/api/config` 令牌正/负对照）· D app 关（h5 回开；闸矩阵第二维）· E socket
 * 新连接（⚠️ 锚断连不锚帧——`rejectHandshake` 的 `system.error` 自述 best-effort，帧级断言
 * 留单测 mock 面）· E′ **拦新不踢旧**（C19——本裁决核心，唯一验证方式=conformance）·
 * **E″ 双开态 app socket（C39 闭合面——T8 登记「app socket 双开态未单独探针」的边界，T9 补）**·
 * F 留痕（/metrics 两计数器增量 + 网关日志实读）· 收尾（两键还原 true + 复验探针 + 连接全断）。
 *
 * ─── 纪律块 ──────────────────────────────────────────────────────────────
 *  - **临时关闸 ⇒ 还原 true**：两键的**知基线** = 种子/暗上线态 `ENTRY_GATE_SEED = true`
 *    （`client.h5Enabled` / `client.appEnabled`；T2 种子迁移）。正常路径还原失败 = 片内
 *    **硬失败**；finally 兜底只为异常路径尽力回种子态（不得静默留下关闸态——关的是玩家入口）。
 *  - 命名/清理：本片**无 actionId 面**（配置 PUT / HTTP / socket 探针均无锚）⇒ AID 纪律
 *    不适用；`RUN_TAG` 仅作日志标注。**不做 DB 硬清**：两键是配置行，PUT 还原即还原。
 *  - 读数一律**增量维度**（/metrics 是全仓共享量 ⇒ 只断本片引起的增量；对账口径见 F 组）。
 *  - socket 探针 = 片内**直用 `io()`**（C17 登记：`lib/client.ts:52` HarnessClient 的 auth
 *    写死 `{token}` ⇒ 本片需要 `auth.clientPlatform` 透传，照 `slice-07.2-hardening:406-434`
 *    的 settle 探针先例片内直用；**不改 lib/client.ts**，默认行为零触碰）。
 *  - ⚠️ **前置（计划 r2 次要 4 钉死）**：以**本分支源码**重建并重启 `api-gateway` +
 *    `config-service` 两容器（旧发布镜像无本片代码 ⇒ ⓪ 前置自证反成归因难题；quirk 9/16
 *    同族）。config-service 重启时 `migrationsRun` 自动跑 T2 种子迁移（两键 = true 入库）。
 *
 * ─── 关键探针纪律（计划逐字）─────────────────────────────────────────────
 *  - B 组真链序路径 = `GET /api/rooms`（`gateway.controller.ts:1038` 的真路由；⛔ 不是
 *    不存在的 `/api/users/me`）。
 *  - C 组 `/api/config` **经玩家验签**（不在公开白名单）⇒ 须带 registerUser 真 token。
 *  - E′ 组**每轮探针成功即断开**（计划 r2 次要 3）：同时在场 ≤2 名额——否则 waitFor 的
 *    「不 connected」有二义面（端闸拒 vs `allowRequest` 5/ip 传输层限流拒），C38 判别力受损。
 *  - 有界轮询代替 sleep 断言（规格 §124「≤5s×N」形态）：12 轮 × 500ms；另有 C23 的
 *    「翻转 ≤5s 即刷」独立读数断言（超窗即红——安全网 ≤60s 形态刻意不在真栈覆盖，属单测注入面）。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ErrCode } from '@fight-the-landlord/protocol';
import { io, type Socket } from 'socket.io-client';
import { Checks, ConformanceError, info, sleep, step } from '../lib/assert';
import {
  GATEWAY_URL,
  INTERNAL_TOKEN,
  NAMESPACE,
  adminGetConfig,
  adminLogin,
  adminPutConfig,
  registerUser,
  type HarnessUser,
} from '../lib/http';
import { redisRaw } from '../lib/redis';

/** 仓库根（`dist/slices/*.js` 与 `dist/lib/*.js` 同深度；照 slice-15/17/18/25）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** 本 run 的日志标注（本片无 actionId 面——纪律块）。 */
const RUN_TAG = Date.now().toString(36).toUpperCase().slice(-4);

/** 两键（§0 逐字）+ **知基线**（种子 = 暗上线全开；T2 迁移）。 */
const H5_KEY = 'client.h5Enabled';
const APP_KEY = 'client.appEnabled';
const ENTRY_GATE_SEED = true;

/** 端标识头（§0 逐字：头值恰 `app`/`h5` 小写；其余一律未识别桶）。 */
const PLATFORM_HEADER = 'X-Client-Platform';

/** 有界轮询参数（规格 §124 的「≤5s×N」形态；C23 的 ≤5s 断言另设）。 */
const GATE_WAIT_ROUNDS = 12;
const GATE_WAIT_INTERVAL_MS = 500;
/** C23：写面翻转后**广播即刷**的断言窗（安全网 ≤60s 不在此口径内）。 */
const C23_MAX_EFFECT_MS = 5_000;

/** E′ 的 socket 探针参数（r2 次要 3：每轮成功即断开，同时在场 ≤2 名额）。 */
const SOCKET_BITE_ROUNDS = 8;
const SOCKET_BITE_SETTLE_MS = 800;
const SOCKET_BITE_INTERVAL_MS = 250;

// ────────────────────────────────────────────────────────────────────────────
// docker / metrics / 日志助手（形态先例：slice-25 :208-222 / slice-16 的 /metrics 读数）
// ⚠️ 纪律同 slice-25「任务书字面修正」：`exec` / `tailOut` 两件在本片零调用点 ⇒
//    `noUnusedLocals` 下未使用声明即 TS6133 构建错 ⇒ 不予复制（其余助手一字不改）。
// ────────────────────────────────────────────────────────────────────────────

/** `/metrics` 的 exec 入口（照 slice-25 :208 同形）：容器内 curl（指标端口不发布宿主口）。 */
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

/** 某容器近 `sinceSeconds` 秒的日志（`docker logs` 无 `--no-color`——那是 compose 子命令的旗标）。 */
function dockerLogsSince(container: string, sinceSeconds: number): string {
  const r = spawnSync('docker', ['logs', '--since', `${sinceSeconds}s`, container], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/** 一行日志里抽出 NDJSON 记录（非 JSON 行一律 null —— 引导行/边框行容错）。 */
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

// ── Prom 文本解析（照 slice-25 :231-265；只用 sum / 精确标签匹配两个读法）────────

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

// ────────────────────────────────────────────────────────────────────────────
// HTTP 端闸探针（§7.1 网关边缘；探针经 GATEWAY_URL 直打网关）
// ────────────────────────────────────────────────────────────────────────────

interface ProbeResult {
  status: number;
  code: number | undefined;
  message: string | undefined;
}

/** 经网关的原始探针（**不**走 lib/http 的信封助手——探针要读「业务/闸」原始四元组）。 */
async function fetchJson(
  path: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; token?: string } = {},
): Promise<ProbeResult> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    // 单次尝试自带超时（fetch 无默认超时；死挂会让「有界」变假——slice-25/assertGatewayHealthy 同纪律）。
    signal: AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  let body: { code?: unknown; message?: unknown } | null = null;
  try {
    body = text ? (JSON.parse(text) as { code?: unknown; message?: unknown }) : null;
  } catch {
    body = null;
  }
  return {
    status: res.status,
    code: typeof body?.code === 'number' ? body.code : undefined,
    message: typeof body?.message === 'string' ? body.message : undefined,
  };
}

/**
 * 探针的端标识形态：`h5`/`app` 合法值；`none` = 无头；其余字面量 = 非法值格（原样发送，
 * 覆盖大小写变体与陌生值——r1 次要 13）。
 */
type PlatformProbe = 'h5' | 'app' | 'none' | 'App' | 'android';

function platformModeHeaders(mode: PlatformProbe): Record<string, string> {
  return mode === 'none' ? {} : { [PLATFORM_HEADER]: mode };
}

/**
 * 本片探针的**服务端计数对账**（F 组与 /metrics 增量逐一对账；口径 = 中间件的两个收口）：
 *  - 返回 10008 ⇒ 服务端 `client_gate_blocked_total{platform}` +1；
 *  - 未识别形态（无头/非法值）返回非 10008 ⇒ 服务端 `client_gate_unidentified_total` +1。
 * ⚠️ `counted:false` 仅用于**豁免路径**探针（C27：豁免面既不进制 blocked 也不进 unidentified；
 *    那里若意外返回 10008，前置断言必先红，不会走到 F 的对账）。
 */
const observed = { h5: 0, app: 0, unidentified: 0 };

async function gateProbe(
  mode: PlatformProbe,
  req: { path: string; method?: 'GET' | 'POST'; body?: unknown; token?: string },
  counted = true,
): Promise<ProbeResult> {
  const res = await fetchJson(req.path, {
    method: req.method,
    headers: platformModeHeaders(mode),
    body: req.body,
    token: req.token,
  });
  if (counted) {
    if (res.code === ErrCode.CLIENT_DISABLED) {
      if (mode === 'h5') observed.h5 += 1;
      else if (mode === 'app') observed.app += 1;
    } else if (mode === 'none' || mode === 'App' || mode === 'android') {
      observed.unidentified += 1;
    }
  }
  return res;
}

/** 闸矩阵的主探针：非豁免路径 `POST /api/auth/login` + 空 creds（计划 A/D 组逐字）。 */
function loginProbe(mode: PlatformProbe): Promise<ProbeResult> {
  return gateProbe(mode, { path: '/api/auth/login', method: 'POST', body: {} });
}

interface WaitOutcome {
  hit: boolean;
  rounds: number;
  elapsedMs: number;
  last: ProbeResult;
}

/**
 * 有界轮询：等 login 探针到达目标态（`blocked` = 10008 / `open` = 非 10008）。
 * 12 轮 × 500ms（规格 §124）；命中返回首达读数——**由调用方断言**（含 C23 的 ≤5s 窗）。
 */
async function waitForLoginGate(mode: 'h5' | 'app', want: 'blocked' | 'open'): Promise<WaitOutcome> {
  const t0 = Date.now();
  let last: ProbeResult = { status: 0, code: undefined, message: undefined };
  for (let round = 1; round <= GATE_WAIT_ROUNDS; round += 1) {
    last = await loginProbe(mode);
    const blocked = last.code === ErrCode.CLIENT_DISABLED;
    if (blocked === (want === 'blocked')) {
      return { hit: true, rounds: round, elapsedMs: Date.now() - t0, last };
    }
    if (round < GATE_WAIT_ROUNDS) await sleep(GATE_WAIT_INTERVAL_MS);
  }
  return { hit: false, rounds: GATE_WAIT_ROUNDS, elapsedMs: Date.now() - t0, last };
}

// ────────────────────────────────────────────────────────────────────────────
// socket 探针（片内直用 io()；形态照 slice-07.2-hardening :406-434 的 settle 探针）
// ────────────────────────────────────────────────────────────────────────────

interface SocketState {
  socket: Socket;
  /** **静置之后**的 `socket.connected`（权威锚 = 断连本身，不锚帧——C17）。 */
  connected: boolean;
  /** 观测到过 `connect` 事件（服务端在 handleConnectionInner 拒绝时客户端可能先见 connect）。 */
  sawConnect: boolean;
  /** 观测到过 `connect_error`（传输层拒绝——⚠️ 也是 allowRequest 限流拒的通道，故本片守 ≤2 名额纪律）。 */
  sawConnectError: boolean;
  errorMessage?: string;
  /** `disconnect` 事件计数（E′ 的「窗口内无 disconnect」判据靠它）。 */
  disconnects: number;
  /** 服务端**主动**踢（`io server disconnect`）——只作 info。 */
  kicked: boolean;
}

/** 本 run 在场 socket 登记（⚠️ 模块级但安全：run.ts 一进程只跑一片 —— 集合的读写都在本片生命周期内）。 */
const activeSockets = new Set<Socket>();

function openSocket(user: HarnessUser, platform: 'h5' | 'app'): SocketState {
  const socket = io(`${GATEWAY_URL}${NAMESPACE}`, {
    path: '/socket.io/',
    transports: ['websocket'],
    auth: { token: user.accessToken, clientPlatform: platform },
    // conformance 自己控制重连（socket.io 自动重连会掩盖「被拒后重试」的形态）。
    reconnection: false,
  });
  activeSockets.add(socket);
  const state: SocketState = { socket, connected: false, sawConnect: false, sawConnectError: false, disconnects: 0, kicked: false };
  socket.on('connect', () => {
    state.sawConnect = true;
  });
  socket.on('connect_error', (err: Error) => {
    state.sawConnectError = true;
    state.errorMessage = err?.message ?? String(err);
  });
  socket.on('disconnect', (reason: string) => {
    state.disconnects += 1;
    if (reason === 'io server disconnect') state.kicked = true;
  });
  return state;
}

/** 静置 `settleMs` 后读 `connected`（锚断连）。 */
async function settleSocket(state: SocketState, settleMs: number): Promise<SocketState> {
  await sleep(settleMs);
  state.connected = state.socket.connected;
  return state;
}

/** 收尾断开（幂等）：先摘监听再 disconnect —— 本地不断言「自己发起的断开」。 */
function closeSocket(state: SocketState): void {
  state.socket.removeAllListeners();
  state.socket.disconnect();
  activeSockets.delete(state.socket);
}

/** 探针观测值的一行渲染（归因靠它；形态照 hardening 的 describeProbe）。 */
function describeSocket(label: string, s: SocketState): string {
  return (
    `${label}：静置后 connected=${s.connected}，sawConnect=${s.sawConnect}，` +
    `sawConnectError=${s.sawConnectError}，kicked=${s.kicked}${s.errorMessage ? `，error=${s.errorMessage}` : ''}`
  );
}

interface SocketBiteOutcome {
  hit: boolean;
  rounds: number;
  elapsedMs: number;
  last: SocketState | null;
}

/**
 * E′ 的「闸已咬」探针：每轮新建一条 h5 raw socket ⇒ 静置 ⇒ **成功即断开**（r2 次要 3）——
 * `不 connected` 即命中（闸咬）；仍 connected ⇒ 断开重试（广播未到时）。有界轮询。
 */
async function waitForSocketBite(user: HarnessUser): Promise<SocketBiteOutcome> {
  const t0 = Date.now();
  let last: SocketState | null = null;
  for (let round = 1; round <= SOCKET_BITE_ROUNDS; round += 1) {
    const state = openSocket(user, 'h5');
    await settleSocket(state, SOCKET_BITE_SETTLE_MS);
    last = state;
    closeSocket(state); // 命中/未命中一律立即断开（≤2 名额纪律）
    if (!state.connected) {
      return { hit: true, rounds: round, elapsedMs: Date.now() - t0, last: state };
    }
    if (round < SOCKET_BITE_ROUNDS) await sleep(SOCKET_BITE_INTERVAL_MS);
  }
  return { hit: false, rounds: SOCKET_BITE_ROUNDS, elapsedMs: Date.now() - t0, last };
}

// ── ws 名额只读诊断（info 级：为报告提供「同时在场名额」实读；⛔ 非判据）────────

function wsConnSlotReport(): string {
  const scan = redisRaw(['--scan', '--pattern', 'ratelimit:ws-conn:*']);
  const keys = scan.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) return 'ratelimit:ws-conn:* 无键（0 名额在场）';
  return keys
    .map((key) => {
      const z = redisRaw(['ZCARD', key]);
      return `${key}=${(z.stdout.trim() || z.stderr.trim()).trim()}`;
    })
    .join('，');
}

// ────────────────────────────────────────────────────────────────────────────
// 管理面助手（`adminGetConfigValue` 照 slice-25 :397-403 同形）
// ────────────────────────────────────────────────────────────────────────────

/** `GET /api/admin/config` 的单键值（⓪ 前置自证与收尾读数自证共用的读口）。 */
async function adminGetConfigValue(admin: string, key: string): Promise<unknown> {
  const res = await adminGetConfig<{ config: Record<string, { value: unknown }> }>(admin);
  if (res.body?.code !== ErrCode.OK) {
    throw new ConformanceError(`GET /api/admin/config 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data?.config?.[key]?.value;
}

// ────────────────────────────────────────────────────────────────────────────
// 主用例
// ────────────────────────────────────────────────────────────────────────────

export async function runSlice26(): Promise<Checks> {
  const checks = new Checks();
  const admin = await adminLogin();
  const sliceT0 = Date.now();

  try {
    // ══════════════════════════════════════════════════════════════════════
    // ⓪ 起手自证 + /metrics 基线读数
    // ══════════════════════════════════════════════════════════════════════
    step('⓪ 起手：两键知基线自证（种子 = true，⛔ 不满足即显式失败）+ /metrics 两计数器基线');
    info(`RUN_TAG=${RUN_TAG}（本片无 actionId 面——配置 PUT / HTTP / socket 探针均无锚；RUN_TAG 仅作日志标注）`);
    const h5BaseValue = await adminGetConfigValue(admin, H5_KEY);
    checks.eq(h5BaseValue, ENTRY_GATE_SEED, `⓪ 前置自证：${H5_KEY} 基线 = ${JSON.stringify(ENTRY_GATE_SEED)}（⛔ 不满足=硬失败，先查上次跑是否留下关态）`);
    const appBaseValue = await adminGetConfigValue(admin, APP_KEY);
    checks.eq(appBaseValue, ENTRY_GATE_SEED, `⓪ 前置自证：${APP_KEY} 基线 = ${JSON.stringify(ENTRY_GATE_SEED)}`);
    const metricsBase = execCurl('ftl-api-gateway', 9000, '/metrics', INTERNAL_TOKEN);
    checks.eq(metricsBase.status, 200, '⓪ /metrics 读数可达（ftl-api-gateway:9000 + 内部令牌）');
    const unidBase = seriesValue(metricsBase.body, 'client_gate_unidentified_total', {}) ?? 0;
    const h5BlockedBase = seriesValue(metricsBase.body, 'client_gate_blocked_total', { platform: 'h5' }) ?? 0;
    const appBlockedBase = seriesValue(metricsBase.body, 'client_gate_blocked_total', { platform: 'app' }) ?? 0;
    info(`⓪ 基线读数：unidentified=${unidBase}，blocked{h5}=${h5BlockedBase}，blocked{app}=${appBlockedBase}（增量对账基准）`);

    // ══════════════════════════════════════════════════════════════════════
    // A h5 关：闸矩阵（h5 ⇒ 10008；无头/app/非法值 ⇒ 非 10008）
    // ══════════════════════════════════════════════════════════════════════
    step('A：临时关 h5（client.h5Enabled=false）⇒ 有界轮询至「响应码 10008」（C23：广播即刷 ≤5s）');
    const putH5Off = await adminPutConfig(H5_KEY, false, admin);
    checks.eq(putH5Off.body?.code, ErrCode.OK, `A PUT ${H5_KEY}=false ⇒ code 0`);
    const h5Off = await waitForLoginGate('h5', 'blocked');
    checks.that(
      h5Off.hit && h5Off.last.code === ErrCode.CLIENT_DISABLED,
      `A h5 头探针 ⇒ 10008（${h5Off.rounds} 轮 / ${h5Off.elapsedMs}ms；末次 ${h5Off.last.status}/${JSON.stringify(h5Off.last.code)}）`,
    );
    checks.that(h5Off.elapsedMs <= C23_MAX_EFFECT_MS, `A C23 生效窗：翻转后 ${h5Off.elapsedMs}ms ≤ ${C23_MAX_EFFECT_MS}ms（广播即刷；安全网形态不在本口径）`);

    step('A 对照（同一窗口）：无头 / app 头 / 非法值（App、android）⇒ 均非 10008');
    const aNoHeader = await loginProbe('none');
    checks.that(
      aNoHeader.code !== ErrCode.CLIENT_DISABLED && aNoHeader.status === 400,
      `A 无头 ⇒ 非 10008（实测 ${aNoHeader.status}/${JSON.stringify(aNoHeader.code)} —— 400 业务族 = 真到了下游校验）`,
    );
    const aAppHeader = await loginProbe('app');
    checks.that(
      aAppHeader.code !== ErrCode.CLIENT_DISABLED && aAppHeader.status === 400,
      `A app 头（该端开）⇒ 非 10008（实测 ${aAppHeader.status}/${JSON.stringify(aAppHeader.code)}）`,
    );
    const aAppVariant = await loginProbe('App');
    checks.that(
      aAppVariant.code !== ErrCode.CLIENT_DISABLED && aAppVariant.status === 400,
      `A 非法值「App」（大小写变体）⇒ 非 10008（未识别桶 fail-open；实测 ${aAppVariant.status}/${JSON.stringify(aAppVariant.code)}）`,
    );
    const aAndroid = await loginProbe('android');
    checks.that(
      aAndroid.code !== ErrCode.CLIENT_DISABLED && aAndroid.status === 400,
      `A 非法值「android」⇒ 非 10008（实测 ${aAndroid.status}/${JSON.stringify(aAndroid.code)}）`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // B 真链序：关闸端 + 无 Authorization + 非豁免路径 ⇒ 10008（⛔ ≠ 10002）
    // ══════════════════════════════════════════════════════════════════════
    step('B：真链序——`GET /api/rooms`（真路由）+ h5 头 + 无 Authorization ⇒ 10008（闸先于验签；⛔ ≠ 10002）');
    const bRooms = await gateProbe('h5', { path: '/api/rooms', method: 'GET' });
    checks.that(
      bRooms.status === 403 && bRooms.code === ErrCode.CLIENT_DISABLED,
      `B /api/rooms 无令牌 + 关闸端 ⇒ 403/10008（实测 ${bRooms.status}/${JSON.stringify(bRooms.code)}；⛔ ≠ 10002——闸先于验签）`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // C 三豁免（显式带头 + h5 关）：豁免的是端闸，不是鉴权
    // ══════════════════════════════════════════════════════════════════════
    step('C：三豁免（显式带头 + h5 关）——admin/login · health ×2 · /api/config（玩家验签正/负对照）');
    const player = await registerUser(0); // ⚠️ 无头注册（未识别桶照常放行）⇒ unidentified +1（对账见 F）
    const cAdminLogin = await gateProbe('h5', { path: '/api/admin/login', method: 'POST', body: {} }, false);
    checks.that(
      cAdminLogin.status === 400 && cAdminLogin.code !== ErrCode.CLIENT_DISABLED,
      `C POST /api/admin/login（空体）⇒ 400 业务族且非 10008（实测 ${cAdminLogin.status}/${JSON.stringify(cAdminLogin.code)}）`,
    );
    const cHealth = await gateProbe('h5', { path: '/api/health', method: 'GET' }, false);
    checks.eq(cHealth.status, 200, 'C GET /api/health（带头）⇒ 200（豁免：监控/编排生死线）');
    const cHealthLive = await gateProbe('h5', { path: '/api/health/live', method: 'GET' }, false);
    checks.eq(cHealthLive.status, 200, 'C GET /api/health/live（带头）⇒ 200');
    const cConfigToken = await gateProbe('h5', { path: '/api/config', method: 'GET', token: player.accessToken }, false);
    checks.that(
      cConfigToken.status === 200 && cConfigToken.code === ErrCode.OK,
      `C GET /api/config + 真 token（带头）⇒ 200/code 0（豁免成立且玩家验签照常；实测 ${cConfigToken.status}/${JSON.stringify(cConfigToken.code)}）`,
    );
    const cConfigNoToken = await gateProbe('h5', { path: '/api/config', method: 'GET' }, false);
    checks.that(
      cConfigNoToken.status === 401 && cConfigNoToken.code === ErrCode.UNAUTHENTICATED,
      `C GET /api/config 无 token ⇒ 401/10002（⛔ 非 10008——豁免的是端闸不是鉴权；实测 ${cConfigNoToken.status}/${JSON.stringify(cConfigNoToken.code)}）`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // D app 关（h5 回开）：闸矩阵第二维 + 两键独立
    // ══════════════════════════════════════════════════════════════════════
    step('D：h5 回开（有界轮询至非 10008）⇒ 关 app（client.appEnabled=false）⇒ app 头 10008、h5/非法值非 10008');
    const putH5On = await adminPutConfig(H5_KEY, true, admin);
    checks.eq(putH5On.body?.code, ErrCode.OK, `D PUT ${H5_KEY}=true ⇒ code 0`);
    const h5Back = await waitForLoginGate('h5', 'open');
    checks.that(
      h5Back.hit && h5Back.last.code !== ErrCode.CLIENT_DISABLED,
      `D h5 回开生效（${h5Back.rounds} 轮 / ${h5Back.elapsedMs}ms；末次 ${h5Back.last.status}/${JSON.stringify(h5Back.last.code)}）`,
    );
    checks.that(h5Back.elapsedMs <= C23_MAX_EFFECT_MS, `D C23 生效窗（回开）：${h5Back.elapsedMs}ms ≤ ${C23_MAX_EFFECT_MS}ms`);

    const putAppOff = await adminPutConfig(APP_KEY, false, admin);
    checks.eq(putAppOff.body?.code, ErrCode.OK, `D PUT ${APP_KEY}=false ⇒ code 0`);
    const appOff = await waitForLoginGate('app', 'blocked');
    checks.that(
      appOff.hit && appOff.last.code === ErrCode.CLIENT_DISABLED,
      `D app 头探针 ⇒ 10008（${appOff.rounds} 轮 / ${appOff.elapsedMs}ms；末次 ${appOff.last.status}/${JSON.stringify(appOff.last.code)}）`,
    );
    checks.that(appOff.elapsedMs <= C23_MAX_EFFECT_MS, `D C23 生效窗（app 键）：${appOff.elapsedMs}ms ≤ ${C23_MAX_EFFECT_MS}ms`);
    const dH5Header = await loginProbe('h5');
    checks.that(
      dH5Header.code !== ErrCode.CLIENT_DISABLED && dH5Header.status === 400,
      `D h5 头（该端开）⇒ 非 10008（两键独立：app 关不塌缩 h5；实测 ${dH5Header.status}/${JSON.stringify(dH5Header.code)}）`,
    );
    const dAppVariant = await loginProbe('App');
    checks.that(
      dAppVariant.code !== ErrCode.CLIENT_DISABLED && dAppVariant.status === 400,
      `D 非法值「App」（app 关态下）⇒ 非 10008（实测 ${dAppVariant.status}/${JSON.stringify(dAppVariant.code)}）`,
    );

    // ══════════════════════════════════════════════════════════════════════
    // E socket 新连接：关闸端 ⇒ settle 后不 connected（锚断连不锚帧）；开 ⇒ 正常建连
    // （当前态：app 关 / h5 开）
    // ══════════════════════════════════════════════════════════════════════
    step('E：socket 新连接——raw io(auth.clientPlatform) settle 1.5s：【app 关态】不 connected；【h5 开态】connected');
    const eApp = openSocket(player, 'app');
    await settleSocket(eApp, 1_500);
    info(describeSocket('E app 探针', eApp));
    checks.that(!eApp.connected, `E app socket（app 关）⇒ settle 后**不 connected**（锚断连不锚帧，含 sawConnect=${eApp.sawConnect}）`);
    closeSocket(eApp);
    const eH5 = openSocket(player, 'h5');
    await settleSocket(eH5, 1_000);
    info(describeSocket('E h5 对照', eH5));
    checks.that(eH5.connected, 'E h5 socket（h5 开）⇒ connected（对照：闸只拦关闸端）');
    closeSocket(eH5); // 每轮探针成功即断开（r2 次要 3：同时在场 ≤2 名额）

    // ══════════════════════════════════════════════════════════════════════
    // E′ C19 拦新不踢旧（本裁决核心；唯一验证方式=conformance）
    // ══════════════════════════════════════════════════════════════════════
    step('E′：两键复原 true → 连一条 h5 真 socket（旧连接）⇒ 再关 h5 → waitFor 新连接确认闸已咬 → 断言旧连接仍 connected 且窗口内无 disconnect（settle 2s）');
    const putH5OnPrime = await adminPutConfig(H5_KEY, true, admin);
    checks.eq(putH5OnPrime.body?.code, ErrCode.OK, `E′ PUT ${H5_KEY}=true（先复原）⇒ code 0`);
    const putAppOn = await adminPutConfig(APP_KEY, true, admin);
    checks.eq(putAppOn.body?.code, ErrCode.OK, `E′ PUT ${APP_KEY}=true（先复原）⇒ code 0`);
    const ePrimeReopen = await waitForLoginGate('h5', 'open');
    checks.that(
      ePrimeReopen.hit && ePrimeReopen.last.code !== ErrCode.CLIENT_DISABLED,
      `E′ h5 复原生效（${ePrimeReopen.rounds} 轮 / ${ePrimeReopen.elapsedMs}ms；末次 ${ePrimeReopen.last.status}/${JSON.stringify(ePrimeReopen.last.code)}）`,
    );

    // ── E″：C39 闭合（T9 小增量；T8 §5 登记的覆盖边界）─────────────────────────
    // 「app 平台 socket 在**双开态**（两键均 true）也连」——T8 矩阵把 app socket 探针
    // 放在 app 关窗口、双开态只有 h5 旧连接 ⇒ 此处以同口径（HTTP 有界轮询复证 + raw
    // socket settle 1s）补上 app 半边；成功即断开（r2 次要 3：同时在场 ≤2 名额）。
    step('E″：双开态（两键均 true）app socket 探针 —— C39 覆盖边界闭合（T8 登记面）');
    const eAppReopen = await waitForLoginGate('app', 'open');
    checks.that(
      eAppReopen.hit && eAppReopen.last.code !== ErrCode.CLIENT_DISABLED,
      `E″ app 复原生效（双开态：两键均 true；${eAppReopen.rounds} 轮 / ${eAppReopen.elapsedMs}ms；末次 ${eAppReopen.last.status}/${JSON.stringify(eAppReopen.last.code)}）`,
    );
    const eAppDualOpen = openSocket(player, 'app');
    await settleSocket(eAppDualOpen, 1_000);
    info(describeSocket('E″ app 双开态探针', eAppDualOpen));
    checks.that(eAppDualOpen.connected, 'E″ app socket（auth.clientPlatform=app，两键 true 双开态）⇒ connected（C39 覆盖边界闭合）');
    closeSocket(eAppDualOpen); // 成功即断开（r2 次要 3：同时在场 ≤2 名额）

    const oldSocket = openSocket(player, 'h5');
    await settleSocket(oldSocket, 1_000);
    info(describeSocket('E′ 旧连接', oldSocket));
    checks.that(oldSocket.connected, 'E′ 旧连接（h5 开态建立）⇒ connected（建立时点自证）');
    info(`E′ 名额实读（旧连接在场）：${wsConnSlotReport()}`);

    const putH5OffPrime = await adminPutConfig(H5_KEY, false, admin);
    checks.eq(putH5OffPrime.body?.code, ErrCode.OK, `E′ PUT ${H5_KEY}=false（翻关）⇒ code 0`);
    const bite = await waitForSocketBite(player);
    info(bite.last ? describeSocket('E′ 闸已咬探针（末轮）', bite.last) : 'E′ 闸已咬探针：无轮次');
    checks.that(
      bite.hit && bite.last !== null && !bite.last.connected,
      `E′ 新连接探针确认闸已咬（第 ${bite.rounds} 轮 / ${bite.elapsedMs}ms 内第二条 h5 socket ⇒ 不 connected）`,
    );
    info(`E′ 名额实读（咬后、旧连接在场）：${wsConnSlotReport()}`);

    await sleep(2_000); // 窗口内静置（计划逐字：settle 2s）
    oldSocket.connected = oldSocket.socket.connected; // 窗口后的**现场**读（权威值）
    checks.that(
      oldSocket.connected,
      'E′ **拦新不踢旧**：翻关后旧连接**仍 connected**（C19——只拦新连接，不主动踢已连接的 socket）',
    );
    checks.eq(oldSocket.disconnects, 0, 'E′ 旧连接窗口内**无 disconnect 事件**（拦新不踢旧的同一条判据另一半）');
    closeSocket(oldSocket); // 最后断开

    // ══════════════════════════════════════════════════════════════════════
    // F 留痕：两计数器增量（/metrics）+ 网关日志实读
    // ══════════════════════════════════════════════════════════════════════
    step('F：/metrics 两计数器增量对账（blocked{h5}/blocked{app} 精确等式 + unidentified ≥）+ 日志 client-gate blocked 抽样（含 platform=）');
    const metricsAfter = execCurl('ftl-api-gateway', 9000, '/metrics', INTERNAL_TOKEN);
    checks.eq(metricsAfter.status, 200, 'F /metrics 读数可达（增量采样点）');
    const h5BlockedAfter = seriesValue(metricsAfter.body, 'client_gate_blocked_total', { platform: 'h5' });
    const appBlockedAfter = seriesValue(metricsAfter.body, 'client_gate_blocked_total', { platform: 'app' });
    const unidAfter = seriesValue(metricsAfter.body, 'client_gate_unidentified_total', {});
    checks.that(
      h5BlockedAfter !== null && appBlockedAfter !== null && unidAfter !== null,
      `F C26：两计数器在 /metrics 可见（blocked 双端 + unidentified 序列均在场；实测 h5=${JSON.stringify(h5BlockedAfter)} app=${JSON.stringify(appBlockedAfter)} unid=${JSON.stringify(unidAfter)}）`,
    );
    checks.eq(
      (h5BlockedAfter ?? 0) - h5BlockedBase,
      observed.h5,
      `F client_gate_blocked_total{platform="h5"} 增量 = 本片 h5 探针 10008 计数（闸咬到了——C38 判别力：非「全落未识别桶」）`,
    );
    checks.eq(
      (appBlockedAfter ?? 0) - appBlockedBase,
      observed.app,
      `F client_gate_blocked_total{platform="app"} 增量 = 本片 app 探针 10008 计数`,
    );
    checks.atLeast(
      (unidAfter ?? 0) - unidBase,
      observed.unidentified,
      `F client_gate_unidentified_total 增量 ≥ 本片未识别探针数（${observed.unidentified}）——存在性信号，与 blocked 互补（C38：两计数器都要读）`,
    );

    const sinceSec = Math.ceil((Date.now() - sliceT0) / 1000) + 10;
    const logText = dockerLogsSince('ftl-api-gateway', sinceSec);
    const blockedLines = logText.split(/\r?\n/).filter((l) => l.includes('client-gate blocked'));
    checks.atLeast(
      blockedLines.length,
      observed.h5 + observed.app,
      `F 网关日志 client-gate blocked 行数 ≥ 本片 10008 次数（${observed.h5 + observed.app}；窗口 ${sinceSec}s）`,
    );
    const sampleLines = blockedLines.slice(0, 3);
    checks.that(
      sampleLines.length > 0 && sampleLines.every((l) => l.includes('platform=')),
      `F 抽样断言：client-gate blocked 行含 platform=（不钉整行格式；r1 次要 15）——样本 ${sampleLines.length} 行`,
    );
    const sampleJson = sampleLines.map(safeJson).filter((r): r is Record<string, any> => r !== null);
    checks.that(
      sampleJson.length > 0 && sampleJson.some((r) => String(r.msg).includes('path=') && String(r.msg).includes('trigger=switch-off')),
      'F 抽样行含 path= 与 trigger=switch-off（C25 三要素之三，NDJSON msg 面）',
    );
    checks.that(
      sampleJson.some((r) => typeof r.traceId === 'string' && r.traceId.length > 0),
      'F 抽样行 traceId 在场（NDJSON 日志层由 ALS 附带——C25 第四要素，本层不手工拼）',
    );

    // ══════════════════════════════════════════════════════════════════════
    // 收尾：两键还原 true（知基线）+ GET 确认 + 复验探针 + 连接全断
    // ══════════════════════════════════════════════════════════════════════
    step('收尾：两键还原 true + GET 确认 + 复验探针（无头/带头均非 10008）+ 连接全断 + owner 落档');
    const putH5Seed = await adminPutConfig(H5_KEY, ENTRY_GATE_SEED, admin);
    checks.eq(putH5Seed.body?.code, ErrCode.OK, `收尾 PUT ${H5_KEY}=${ENTRY_GATE_SEED}（知基线）⇒ code 0`);
    const putAppSeed = await adminPutConfig(APP_KEY, ENTRY_GATE_SEED, admin);
    checks.eq(putAppSeed.body?.code, ErrCode.OK, `收尾 PUT ${APP_KEY}=${ENTRY_GATE_SEED}（知基线）⇒ code 0`);
    checks.eq(await adminGetConfigValue(admin, H5_KEY), ENTRY_GATE_SEED, `收尾读数自证：${H5_KEY} = 种子（不得静默留下关闸态）`);
    checks.eq(await adminGetConfigValue(admin, APP_KEY), ENTRY_GATE_SEED, `收尾读数自证：${APP_KEY} = 种子`);

    const h5Final = await waitForLoginGate('h5', 'open');
    checks.that(
      h5Final.hit && h5Final.last.code !== ErrCode.CLIENT_DISABLED,
      `收尾复验：h5 头 ⇒ 非 10008（${h5Final.rounds} 轮 / ${h5Final.elapsedMs}ms；末次 ${h5Final.last.status}/${JSON.stringify(h5Final.last.code)}）`,
    );
    const appFinal = await loginProbe('app');
    checks.that(
      appFinal.code !== ErrCode.CLIENT_DISABLED && appFinal.status === 400,
      `收尾复验：app 头 ⇒ 非 10008（实测 ${appFinal.status}/${JSON.stringify(appFinal.code)}）`,
    );
    const noneFinal = await loginProbe('none');
    checks.that(
      noneFinal.code !== ErrCode.CLIENT_DISABLED && noneFinal.status === 400,
      `收尾复验：无头 ⇒ 非 10008（实测 ${noneFinal.status}/${JSON.stringify(noneFinal.code)}）`,
    );
    checks.eq(activeSockets.size, 0, '收尾：全部 socket 连接已断开（连接全断）');
    info(`本 run 的 owner 登记（增量断言口径，不做行硬清）：${player.id}`);

    return checks;
  } finally {
    // ── 兜底复原（成败皆然）──────────────────────────────────────────────
    // 正常路径已还原并断言；这里兜「前文抛错或被中断」。整段吞错只 info：
    // 兜底复原**不许**顶掉原始结论（照 slice-18/25 的 finally 形态）。
    try {
      for (const socket of [...activeSockets]) {
        socket.removeAllListeners();
        socket.disconnect();
      }
      activeSockets.clear();
      for (const key of [H5_KEY, APP_KEY]) {
        const res = await adminPutConfig(key, ENTRY_GATE_SEED, admin);
        info(`finally 兜底：${key} 已尽力写回 ${JSON.stringify(ENTRY_GATE_SEED)}（code=${JSON.stringify(res.body?.code)}）`);
      }
    } catch (err) {
      info(
        `兜底复原失败（不影响原始结论；手动检查 ${H5_KEY}/${APP_KEY} 是否已回 true）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

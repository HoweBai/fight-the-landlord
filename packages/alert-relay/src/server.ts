import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dingtalkHalfConfigured, loadConfig, sinksFromValues } from './config';
import type { NotifyValues, RelayConfig, SinkConfigs } from './config';
import { formatAlert } from './format';
import type { AlertmanagerWebhookPayload } from './format';
import { configuredSinkNames, createSinks } from './sinks';
import { recordDelivery, renderMetrics } from './metrics';
import {
  NOTIFY_PULL_INTERVAL_MS,
  pullNotifyConfig,
  readLastGood,
  trimForRelay,
  writeLastGood,
} from './notify-config';

/**
 * relay 的 HTTP 面 + 拉取轮询衔接（规格 §3.3 逐条；纯 `node:http`，无框架）。
 *
 * ```
 * POST /webhook   Authorization: Bearer <INTERNAL_SERVICE_TOKEN>（env 未设 ⇒ 一律 401，fail-closed）
 *                 body = Alertmanager webhook v4 载荷；三态（§3.3）：
 *                 · lastGood===null（从未成功拉到）⇒ 500 `notify config unavailable`
 *                   （未知 ≠ 成功：回 200 会让 AM 记成投递成功、不重投 = 假成功静默丢告警）
 *                 · 成功空图/零派生槽 ⇒ 200 `no sinks configured`（= 今天「明确未配」）
 *                 · 否则扇出：≥1 个槽成功 ⇒ 200；全失败 ⇒ 500（AM 按 repeat_interval 重投，
 *                   **不内置重试** —— 首投失败到重投最长 4h，规格接受）
 * GET  /health    无守卫（容器 healthcheck 用）
 * GET  /metrics   Bearer 守卫；alert_deliveries_total{sink,result} + 默认集
 * ```
 *
 * 槽位装配已改**拉取驱动**：`/webhook` 每次现取「当前槽位闭包」的**新快照**（轮询每轮
 * 整图替换 `lastGood` ⇒ 下一请求即新槽位；在途投递用本次快照完成，天然不撕裂）。
 *
 * 日志面**只允许 sink 名与状态码**（S2③）：Webhook URL 本身就是凭据，错误对象里
 * 又最容易夹带 URL ⇒ 这里的 console 行永远只有 `{sink,status}` 两个字段（轮询面的
 * WARN 同理，文案逐字且不含任何值）。
 */

/** 请求体上限（AM 载荷是 KB 级；5MiB 是防内存面的宽上限，不是业务约束）。 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * 投递面运行时状态：`lastGood` = **裁剪后**四键图（最新成功拉取图）；`null` = 从未成功拉到。
 * 语义边界只有一个（设计 D4）：`null` ⇒ `/webhook` 500；`{}` 是**有效图** ⇒ 200 no-op。
 */
export interface RelayRuntimeState {
  lastGood: NotifyValues | null;
}

/** 由运行时状态造「当前槽位闭包」（`main` 与测试同此一处口径）。 */
export function sinkConfigsFromState(state: RelayRuntimeState): SinkConfigs | null {
  return state.lastGood === null ? null : sinksFromValues(state.lastGood);
}

export interface RelayServerOptions {
  /** 注入时钟（测试 golden 用）——传给文案渲染与钉钉加签。 */
  clock?: () => number;
  /** 出站超时覆盖（测试用；生产缺省 5000 = 规格钉死值）。 */
  timeoutMs?: number;
  /** 监听成功回调：启动日志挂 `'listening'` 事件（EADDRINUSE 时不再先打一条**假的** listening）。 */
  onListening?: () => void;
  /**
   * **当前槽位闭包**（热更新核心；轮询侧每轮重算引用）：每次 `/webhook` 现取。
   * `null` = 从未成功拉到 ⇒ **500**；`{}`（成功空图）⇒ 200 明示 no-op。
   * 缺省 ⇒ 恒 `null`（fail-closed：没接线就没有可投递面 —— 未知按未拉到处理）。
   */
  currentSinks?: () => SinkConfigs | null;
}

/** `/webhook` 的运行时依赖（快照粒度 = 单请求：在途不停旧引用更换）。 */
interface WebhookRuntime {
  currentSinks: () => SinkConfigs | null;
  clock: () => number;
  timeoutMs?: number;
}

/**
 * 起 relay 服务器（`cfg.port` 直接监听；调用方负责进程生命周期）。
 * 返回的 `close()` 语义与 shared 的指标监听同款（server.close 的 promise 化）。
 */
export function startRelayServer(cfg: RelayConfig, opts: RelayServerOptions = {}): { close(): Promise<void> } {
  const clock = opts.clock ?? ((): number => Date.now());
  // ⚠️ 不再在启动时装配 sink：闭包在每次 /webhook 现取（轮询热更新），槽位语义已由
  //    sinksFromValues 归一（空串/半配 ⇒ 未启用）。
  const runtime: WebhookRuntime = {
    currentSinks: opts.currentSinks ?? ((): SinkConfigs | null => null),
    clock,
    timeoutMs: opts.timeoutMs,
  };

  const server = createServer((req, res) => {
    handle(req, res, runtime).catch(() => {
      // 兜底：handler 自身出 bug 也必须在**响应**上响亮（500），且绝不回声错误内容。
      if (!res.headersSent) respond(res, 500, 'internal error\n');
      else res.end();
    });
  });
  // 不传 host：监听全部接口（AM 按容器名访问）；本机测试连 127.0.0.1。
  // ⚠️ 监听失败（端口被占等）必须**显式**处理（T8 审查 M1：无 handler 时 Node emit 'error'
  //    无监听者 ⇒ Unhandled 'error' ⇒ 裸堆栈卸载；与 shared 指标监听 R2 同口径）：
  //    结构化错误（含端口号、**不回声任何配置内容**）后 exit(1) —— fail-loud 但可读。
  server.on('error', (err: Error) => {
    console.error(
      JSON.stringify({ level: 'fatal', service: 'alert-relay', msg: 'listener failed', port: cfg.port, error: err.message }),
    );
    process.exit(1);
  });
  if (opts.onListening) server.on('listening', opts.onListening);
  server.listen(cfg.port);

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** 守卫（fail-closed）：token 从 `process.env` **逐请求**读取（env 轮换/演练立即生效）。 */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  return !!expected && req.headers.authorization === `Bearer ${expected}`;
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse, runtime: WebhookRuntime): Promise<void> {
  const path = (req.url ?? '').split('?')[0];
  const method = req.method ?? '';

  // 路由先行（只有恰好这三个方法+路径组合存在；其余一律 404，不给探测留面）。
  if (method === 'GET' && path === '/health') {
    respond(res, 200, 'ok\n');
    return;
  }
  if (method === 'GET' && path === '/metrics') {
    if (!authorized(req)) {
      respond(res, 401, 'unauthorized\n');
      return;
    }
    try {
      const body = await renderMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' }).end(body);
    } catch {
      // 采集失败 fail-loud：500 会让 Prometheus 目标 down ⇒ ServiceDown 规则命中
      respond(res, 500, 'metrics collection failed\n');
    }
    return;
  }
  if (method === 'POST' && path === '/webhook') {
    await handleWebhook(req, res, runtime);
    return;
  }
  respond(res, 404, 'not found\n');
}

type BodyRead = { ok: true; text: string } | { ok: false; code: 400 | 413 };

/**
 * 读请求体（上限 `MAX_BODY_BYTES`）。
 * ⚠️ 超限后**继续排空但不存储**（不是 destroy）：内存有界，同时应答发出的时机对
 * 客户端是确定的（不会出现「服务器已回 413、客户端还在写 ⇒ ECONNRESET」的竞态）。
 */
async function readBody(req: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      if (overflow) continue; // 已超限：只排空
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0; // 立即还内存
        continue;
      }
      chunks.push(buf);
    }
  } catch {
    return { ok: false, code: 400 }; // 连接中断等
  }
  if (overflow) return { ok: false, code: 413 };
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse, runtime: WebhookRuntime): Promise<void> {
  if (!authorized(req)) {
    respond(res, 401, 'unauthorized\n');
    return;
  }

  const read = await readBody(req);
  if (!read.ok) {
    respond(res, read.code, read.code === 413 ? 'payload too large\n' : 'bad request\n');
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    respond(res, 400, 'bad request\n'); // 不回声正文（正文可能含任何东西）
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    respond(res, 400, 'bad request\n');
    return;
  }

  // 现取「当前槽位闭包」（热更新：上一轮轮询换的新引用在这一刻生效）。
  const cfg = runtime.currentSinks();
  if (cfg === null) {
    // 从未成功拉到 ⇒ 500（§3.3；未知 ≠ 成功）：AM 按 repeat_interval 重投，直到拉取恢复。
    respond(res, 500, 'notify config unavailable\n');
    return;
  }
  const sinks = createSinks(cfg, { clock: runtime.clock, timeoutMs: runtime.timeoutMs });
  if (sinks.length === 0) {
    // 明示 no-op：成功空图/零派生槽 ⇒ 没有任何「失败」，AM 不该重投（= 今天「明确未配」）。
    respond(res, 200, 'no sinks configured\n');
    return;
  }

  const msg = formatAlert(parsed as AlertmanagerWebhookPayload, runtime.clock());
  // 并发扇出 + 单槽失败隔离（sink.deliver 永不 reject；allSettled 是第二道保险）。
  // ⚠️ 本请求使用**本次取到的** sinks 快照完成 —— 轮询换引用不影响在途投递（不撕裂）。
  const results = await Promise.allSettled(sinks.map((sink) => sink.deliver(msg)));

  let delivered = 0;
  results.forEach((result, index) => {
    const sink = sinks[index].name;
    const fulfilled = result.status === 'fulfilled';
    const ok = fulfilled && result.value.ok;
    if (ok) delivered += 1;
    recordDelivery(sink, ok ? 'ok' : 'error');
    // 「日志只允许 sink 名与状态码」：失败路径**不落**任何错误原文（URL/secret 的常见夹带点）。
    console.error(JSON.stringify({ sink, status: fulfilled ? result.value.status : 0 }));
  });

  if (delivered > 0) respond(res, 200, 'ok\n');
  else respond(res, 500, 'delivery failed\n');
}

/** 轮询依赖注入面（测试用；生产全缺省 = `pullNotifyConfig` + `writeLastGood` + 30s 常量）。 */
export interface NotifyLoopDeps {
  pull?: () => Promise<NotifyValues>;
  persist?: (values: NotifyValues) => Promise<void>;
  intervalMs?: number;
}

export interface NotifyLoop {
  /** 停掉定时器（常驻进程无需；测试清理用）。 */
  stop(): void;
  /** 第一次 tick（启动**立即**先拉一次，⚙️8）—— 测试的确定性等待点。 */
  firstTick: Promise<void>;
  /** 手动推进一轮（与定时器共享防重入闸）；测试的确定性推进点。 */
  tick(): Promise<void>;
}

/**
 * 轮询线程（⚙️8 + §3.3；设计 D4：`setInterval` + 防重入，每轮 try/catch 收全，
 * 任何异常**不得**打穿常驻进程）：拉取 ⇒ 裁剪 ⇒ **整图替换** `lastGood`（`{}` 亦替换）
 * ⇒ 原子落盘 ⇒ 槽位状态日志（半配 WARN，**状态变化时一条**）；失败 ⇒ WARN（状态变化时一条）
 * + 保持上次成功值。
 */
export function startNotifyLoop(state: RelayRuntimeState, deps: NotifyLoopDeps = {}): NotifyLoop {
  const pull = deps.pull ?? ((): Promise<NotifyValues> => pullNotifyConfig());
  const persist = deps.persist ?? ((values: NotifyValues) => writeLastGood(values));
  const intervalMs = deps.intervalMs ?? NOTIFY_PULL_INTERVAL_MS;

  // 「状态变化时一条」的三个哨兵（成功即复位 ⇒ 恢复后再坏会再报；持续坏不刷屏）。
  let pullFailLogged = false;
  let persistFailLogged = false;
  let loopFailLogged = false;
  // 槽位状态签名（含 disabled 原因类别，§3.6）：null = 尚未应用过任何一轮。
  let lastSinkSignature: string | null = null;
  let inFlight: Promise<void> | null = null;

  const applyOnce = async (): Promise<void> => {
    let values: NotifyValues;
    try {
      values = await pull();
    } catch {
      // 拉取失败 WARN 逐字（§2.9；不含任何值——错误对象一律不外带）。
      if (!pullFailLogged) {
        console.warn('通知配置拉取失败，使用上次成功值');
        pullFailLogged = true;
      }
      return;
    }
    pullFailLogged = false;

    const trimmed = trimForRelay(values);
    state.lastGood = trimmed; // 整图替换（引用一次换新；在途投递用旧快照完成，不撕裂）

    // 槽位状态变化日志（§3.6）：槽位集（含 disabled 原因类别）与上轮不同才打。
    const half = dingtalkHalfConfigured(trimmed);
    const signature = `${configuredSinkNames(sinksFromValues(trimmed)).join(',')}${half ? '|dingtalk-half' : ''}`;
    if (signature !== lastSinkSignature) {
      // 半配 WARN 逐字（§2.9）；半配持续在位不重复报。
      if (half) console.warn('钉钉 URL 与加签密钥须成对（当前半配）——该槽位已停用');
      lastSinkSignature = signature;
    }

    try {
      await persist(trimmed);
      persistFailLogged = false;
    } catch {
      // 持久化失败不影响内存 lastGood（本进程照常投递）；文案不含值。
      if (!persistFailLogged) {
        console.warn('通知配置持久化失败（last-good 仅存内存）');
        persistFailLogged = true;
      }
    }
  };

  const tick = (): Promise<void> => {
    if (inFlight !== null) return inFlight; // 防重入（D4）：定时器与手动推进共用此闸
    inFlight = (async () => {
      try {
        await applyOnce();
        loopFailLogged = false;
      } catch {
        // 兜底（D4「任何异常不得打穿常驻进程」）：真实失败面已在 applyOnce 内逐类 WARN，
        // 走到这里 = 自身代码 bug —— 报一声（状态变化一条），但绝不外抛。
        if (!loopFailLogged) {
          console.warn('通知配置轮询内部错误（本轮保持上次成功值）');
          loopFailLogged = true;
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref(); // 常驻进程由 HTTP 面持有 event loop；测试侧不因定时器吊住

  return { stop: () => clearInterval(timer), firstTick: tick(), tick };
}

/**
 * 进程入口：`PORT` 装配（非法 ⇒ 响亮 `exit 1`）⇒ 先读 `/data` last-good
 * （命中 ⇒ **进程启动即可投递**，⚙️9）⇒ 起 HTTP 面（启动日志只列**槽位名**）⇒
 * 衔接轮询（立即先拉一次 + 30s；⚙️8）。
 */
export async function main(): Promise<void> {
  let cfg: RelayConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    // ⚠️ 消息由 loadConfig 保证只含变量名（值即凭据，不许进日志）。
    console.error(`[alert-relay] 配置错误，拒启动：${err instanceof Error ? err.message : 'unknown'}`);
    process.exit(1);
  }

  // 先读持久化：命中 ⇒ 首拉完成前也可投递（config-service 故障期重启 relay 不丢通道）。
  const state: RelayRuntimeState = { lastGood: await readLastGood() };

  // 启动日志只在**真的** listening 后打（M1）：EADDRINUSE 时先前的写法会先印一条假的
  // 「listening on :port」再崩，排障时误导。槽位面 = 此刻的 last-good（/data 初值）。
  startRelayServer(cfg, {
    currentSinks: () => sinkConfigsFromState(state),
    onListening: () => {
      const names = configuredSinkNames(sinkConfigsFromState(state) ?? {});
      console.error(
        names.length === 0
          ? `[alert-relay] listening on :${cfg.port}; sinks: 无`
          : `[alert-relay] listening on :${cfg.port}; sinks: ${names.join(', ')}`,
      );
    },
  });

  startNotifyLoop(state); // 立即先拉一次，此后 30s 一轮（⚙️8）
}

/**
 * 「直接运行才自启」的守卫。
 *
 * ⚠️ 刻意**不**用 `require.main === module`：vitest 走 ESM 变换导入本文件，
 * `require` 在那里不存在 ⇒ import 期直接 ReferenceError，全部单测被这行拖死。
 * ⚠️ 也**不**用 `import.meta`：本包编译目标是 NodeNext/CJS（无 `"type": "module"`），
 * `import.meta` 在 CJS 产物里是 TS1343 语法错误。
 * 按 argv 判入口在两种世界里都成立，且 `node dist/server.js`（T9 的 CMD）天然命中。
 */
const entry = process.argv[1] ?? '';
if (/[\\/]server\.(js|ts)$/.test(entry)) void main();

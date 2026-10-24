/**
 * 轻量错误上报（项 8）。
 *
 * ## 边界（2026-10-12 裁决）
 *
 * - **不引 Sentry/SaaS SDK**：依赖闸④只放行 pinia / socket.io-client / vue，不得为单一
 *   功能加裸依赖。这里交付的是一个通用 JSON POST 通道，任何兼容收集端
 *   （自建 collector / 日志网关 / webhook 适配层）都能接。
 * - **未配置 `VITE_ERROR_REPORT_URL` 时数据不出端**：降级为 `console.warn`
 *   （dev 零配置即可见）；部署侧的接入是一行环境变量配置。本期不含收集端服务。
 *
 * ## 策略
 *
 * - `uni.request` 直接成员调用（H5 发行构建的 uni API 改写前提，见 uni-api-access 闸）；
 * - fire-and-forget：不 await、失败静默（上报本身永远不打断业务）；
 * - 同一 `scope|message` 10 秒去重（防止错误循环打爆收集端）；
 * - 采样率 `VITE_ERROR_REPORT_SAMPLE_RATE`（0–1，缺省 1 全采）；
 * - 本地脱敏：`token/secret/password/authorization` 以及牌局数据
 *   （hand/cards/bottomCards/recentActions）不出端 —— 哑终端不信任客户端，
 *   但错误负载也不该把用户手牌发去第三方。
 */

/** 调用方补充的结构化上下文（会脱敏后随报）。 */
export type ErrorReportContext = Record<string, unknown>;

/** 同 message 去重窗口。 */
const DEDUP_WINDOW_MS = 10_000;
/** 字符串字段最长保留字符数（stack/context 都可能很大）。 */
const MAX_TEXT_LENGTH = 2_000;
/** 脱敏递归深度上限。 */
const MAX_REDACT_DEPTH = 3;

/** 命中即整值替换为该占位的敏感键（名字即语义）。 */
const SENSITIVE_KEY =
  /token|secret|password|authorization|^cards$|^hand$|bottomcards|recentactions/i;
const REDACTED = '[redacted]';

/** scope|message → 最近一次上报时间戳。模块级：全应用共享一条去重流。 */
const recentReports = new Map<string, number>();

function endpoint(): string {
  return (import.meta.env.VITE_ERROR_REPORT_URL ?? '').trim();
}

function sampleRate(): number {
  // ⚠️ 不能直接 Number(raw)：`Number('') === 0`，空配置会被当成「全不采」。
  const raw = (import.meta.env.VITE_ERROR_REPORT_SAMPLE_RATE ?? '').trim();
  if (raw === '') return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
}

/** 当前页面路由（uni 全局 API，非 uni.* 成员；宿主缺失时 null）。 */
function currentPageRoute(): string | null {
  const getPages = (
    globalThis as { getCurrentPages?: () => Array<{ route?: string }> }
  ).getCurrentPages;
  if (typeof getPages !== 'function') return null;
  try {
    const pages = getPages();
    return pages[pages.length - 1]?.route ?? null;
  } catch {
    return null;
  }
}

function clipText(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…[truncated]` : value;
}

/** 递归脱敏：敏感键整值抹掉；深对象/数组逐层处理；基本类型截断长字符串。 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return clipText(value);
  if (typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[object]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

function normalizeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      message: clipText(error.message || error.name || 'Error'),
      stack: error.stack ? clipText(error.stack) : null,
    };
  }
  if (error === null || error === undefined) {
    return { message: 'unknown error', stack: null };
  }
  try {
    return { message: clipText(String(error)), stack: null };
  } catch {
    return { message: '[unserializable error]', stack: null };
  }
}

/**
 * 上报一个错误。
 * @param scope 来源标记（如 `'app.onError'`、`'vue.errorHandler'`）
 * @param error 任意异常值（onUnhandledRejection 的 reason 不保证是 Error）
 * @param context 可选结构化上下文（脱敏后发送）
 */
export function reportError(
  scope: string,
  error: unknown,
  context?: ErrorReportContext,
): void {
  const { message, stack } = normalizeError(error);

  // 未配置收集端 ⇒ console 降级（不去重：dev 下每个错误都该被看见）。
  if (!endpoint()) {
    console.warn(`[ftl:${scope}]`, error, context ?? '');
    return;
  }

  // 去重：同 scope|message 在窗口内只发第一次。
  const dedupKey = `${scope}|${message}`;
  const now = Date.now();
  const lastSent = recentReports.get(dedupKey);
  if (lastSent !== undefined && now - lastSent < DEDUP_WINDOW_MS) return;

  // 采样（0 = 全不采，1 = 全采）；未采中的也不进去重表，让下一次有机会被采。
  if (Math.random() >= sampleRate()) return;
  recentReports.set(dedupKey, now);

  const appVersion =
    typeof __FTL_APP_VERSION__ !== 'undefined' ? __FTL_APP_VERSION__ : 'dev';

  let payload: Record<string, unknown>;
  try {
    payload = {
      scope,
      message,
      stack,
      appVersion,
      page: currentPageRoute(),
      at: now,
      ...(context !== undefined ? { context: redact(context) } : {}),
    };
  } catch (buildError) {
    // 上下文序列化都失败时，放弃这次上报（上报自身不得再抛）。
    console.warn('[ftl:reporter] payload build failed', buildError);
    return;
  }

  // fire-and-forget：success/fail 都不做事，业务零感知。
  uni.request({
    url: endpoint(),
    method: 'POST',
    header: { 'content-type': 'application/json' },
    data: payload,
    fail: () => {},
  });
}

/** 测试用：清空去重表（生产代码勿调）。 */
export function __resetReporterForTest(): void {
  recentReports.clear();
}

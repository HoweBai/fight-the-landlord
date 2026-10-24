/**
 * 中文文案渲染（规格 §2.6「文案」段）。
 *
 * ## 不变量：**只含服务名/指标/数值 —— 无用户数据、无 URL**
 *
 * 飞书/钉钉/企微是**第三方**（设计 §D5）：文案进的是别人的服务器，因此这里的
 * 「无 URL」不是顺手，是判据 ——
 *  - `generatorURL`/`externalURL` 这类载荷字段**从不消费**；
 *  - 注释文本里的链接被替换为占位符（`注释内容` 是自由文本，不能靠调用方自觉）；
 *  - `*_url` 结尾的注释**键**（如 `runbook_url`）在回落取值时被跳过。
 *
 * ## 容错（webhook 载荷是**外部输入**）
 *
 * 载荷形状按 v4 schema 的类型描述（`alerts[]/commonLabels/status`），但所有字段都
 * 当作可缺失：坏字段降级成 `unknown`/`未知`/整段省略，**任何形状都不许抛** ——
 * 抛出去就是 500，会让 AM 把「我们自己的渲染 bug」当成「投递失败」重投 4h。
 *
 * ⚠️ 时间渲染固定 **UTC**、持续固定由**注入的 `nowMs`** 决定：golden 不看墙上时钟，
 * 单测输出逐字可预期（时钟注入点另见 sinks.ts 的钉钉加签）。
 */

/** 一个 alert 的最小形状（字段全可选 —— 外部输入按保守取用）。 */
export interface AlertmanagerAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  /** 从不消费（无 URL 不变量）。列出来是为了「刻意不读」可见。 */
  generatorURL?: string;
  fingerprint?: string;
}

/** Alertmanager webhook 载荷（v4；真栈 golden fixture 由 T12 dump 回填）。 */
export interface AlertmanagerWebhookPayload {
  version?: string;
  groupKey?: string;
  truncatedAlerts?: number;
  status?: string;
  receiver?: string;
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  /** 从不消费（无 URL 不变量）。 */
  externalURL?: string;
  alerts?: AlertmanagerAlert[];
}

export interface FormattedMessage {
  /** `[severity] alertname`（规格 §2.6 逐字）。 */
  title: string;
  /** 逐 alert 一行的正文。 */
  body: string;
}

type Loose = Record<string, unknown>;

function asRecord(value: unknown): Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Loose) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 链接占位符：注释文本里出现的 URL 一律替换成它（「文案无 URL」的机械落点）。 */
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

/**
 * 单行化 + 去链接：正文每行是一个结构（`a · b · c`），字段值里的换行/制表
 * 不得破坏行结构；URL 不得出境。对 label 值与注释文本统一施加。
 */
function clean(text: string): string {
  return text.replace(URL_PATTERN, '（链接已省略）').replace(/\s+/g, ' ').trim();
}

/** 注释取值：`summary` 优先；否则**首条**非 `*_url` 键的非空注释（规格「首条 annotation 或摘要」）。 */
function pickSummary(annotations: Loose): string | undefined {
  const summary = asString(annotations.summary);
  if (summary && summary.trim()) return clean(summary);
  for (const [key, value] of Object.entries(annotations)) {
    // URL 即凭据：runbook_url 这类键按语义跳过（它们必然携带链接）
    if (/(^|_)url$/i.test(key)) continue;
    const text = asString(value);
    if (text && text.trim()) return clean(text);
  }
  return undefined;
}

/** `YYYY-MM-DD HH:mm UTC`（固定 UTC：容器 TZ 不定，golden 必须跨机同字）。 */
function formatUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/**
 * 持续时长（规格「持续」）：紧凑两段式（`5m` / `1h1m` / `1d1h`），负值钳零。
 * 导出是为了直接钉渲染口径（format.test.ts 的表驱动）。
 */
export function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m${s}s` : `${m}m`;
  return `${s}s`;
}

/** 单 alert 行：`- job/实例 · 摘要 · 开始 … · 持续 …`（摘要缺失则整段省略）。 */
function formatAlertLine(alert: Loose, nowMs: number): string {
  const labels = asRecord(alert.labels);
  const job = clean(asString(labels.job) ?? '') || 'unknown';
  const instance = clean(asString(labels.instance) ?? '');
  const who = instance ? `${job}/${instance}` : job;

  const summary = pickSummary(asRecord(alert.annotations));

  const startsAt = asString(alert.startsAt);
  const startMs = startsAt === undefined ? Number.NaN : Date.parse(startsAt);
  const time = Number.isNaN(startMs) ? '未知' : formatUtc(startMs);

  let duration = '未知';
  if (!Number.isNaN(startMs)) {
    const endsAt = asString(alert.endsAt);
    const endMs = endsAt === undefined ? Number.NaN : Date.parse(endsAt);
    // firing 的 endsAt 是零值（0001-01-01）⇒ 走「到现在」；resolved 的真实 endsAt ⇒ 走两端差。
    const spanMs = !Number.isNaN(endMs) && endMs > startMs ? endMs - startMs : nowMs - startMs;
    duration = humanDuration(spanMs);
  }

  const parts = [who, ...(summary ? [summary] : []), `开始 ${time}`, `持续 ${duration}`];
  return `- ${parts.join(' · ')}`;
}

/**
 * 载荷 ⇒ 文案。标题取自 `commonLabels`（组内公共），缺则回落**首条 alert** 的 labels，
 * 再缺为 `unknown` —— 标题永不缺位（IM 推送的题干）。
 */
export function formatAlert(payload: AlertmanagerWebhookPayload, nowMs: number): FormattedMessage {
  const root = asRecord(payload);
  const commonLabels = asRecord(root.commonLabels);
  const alerts = (Array.isArray(root.alerts) ? root.alerts : []).filter(
    (a): a is Loose => typeof a === 'object' && a !== null && !Array.isArray(a),
  );
  const firstLabels = asRecord(asRecord(alerts[0]).labels);

  const pick = (key: string): string => {
    const value = asString(commonLabels[key]) ?? asString(firstLabels[key]);
    return (value && clean(value)) || 'unknown';
  };

  const title = `[${pick('severity')}] ${pick('alertname')}`;
  const body =
    alerts.length === 0
      ? '- （无 alert 明细）'
      : alerts.map((alert) => formatAlertLine(alert, nowMs)).join('\n');

  return { title, body };
}

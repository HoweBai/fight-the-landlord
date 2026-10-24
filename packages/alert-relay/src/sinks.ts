import { createHmac } from 'node:crypto';
import type { FormattedMessage } from './format';
import type { SinkConfigs, SinkName } from './config';

/**
 * 三 IM sink（规格 §2.6「三 sink」段逐字）。
 *
 * ## 几条钉死的纪律
 *
 *  - **每槽出站超时 5s**（`AbortSignal.timeout`）：没有超时，一个挂起的对端会把
 *    `/webhook` 的应答拖到 AM 的 webhook 超时 —— 那时 AM 认为投递失败、整组重投，
 *    而我们已经发出去的槽位会收到**重复**消息。5s × 并发 = 单次投递上限。
 *  - **失败不外抛**：`deliver` 把一切异常收敛成 `{ok:false,status}` —— 单槽失败隔离
 *    （`Promise.allSettled` 的语义）要靠这个前提，不然一个槽的语法错会把整次扇出炸掉。
 *  - ⚠️ **URL/secret 永不进日志/错误/指标**（S2③）：catch 块**不记录错误对象** ——
 *    undici 的 URL 解析错误会把完整 URL（含 `access_token`/`sign`）带进 message，
 *    「把错误打出来」就等于把凭据打进日志。没有响应可判时一律记 `status: 0`。
 *  - 成败判定只看 **HTTP 状态码**（2xx = 成功），**不解析**平台返回体里的
 *    `code/errcode`：那三个平台的 body 形状各说各话，而规格把「310000 静默拒收」
 *    这个风险**前置**解决了（timestamp 用毫秒，见 `buildDingtalkUrl`）。
 *
 * ## 钉钉加签（Y12 的时间单位）
 *
 * `sign = base64(HMAC-SHA256(secret, timestamp + "\n" + secret))`，再 percent-encode；
 * timestamp 单位 **毫秒** —— 秒级会被钉钉以 `310000`（HTTP 200！）静默拒收，
 * 而本包按状态码判定 ⇒ 秒级错误在本仓**内部不可见**，只有单测的固定对照向量拦得住。
 */

/** 出站超时（规格钉死 5s；测试可用 `timeoutMs` 注入短值）。 */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 5000;

export interface DeliveryResult {
  sink: SinkName;
  ok: boolean;
  /** HTTP 状态码；**0 = 未收到响应**（超时/连接层错误 —— 日志允许面的约定值）。 */
  status: number;
}

export interface Sink {
  readonly name: SinkName;
  /** 永不 reject（见文件头「失败不外抛」）；失败收敛为 `ok:false`。 */
  deliver(msg: FormattedMessage): Promise<DeliveryResult>;
}

/**
 * 钉钉加签（base64，**未** percent-encode；URL 拼接由 `buildDingtalkUrl` 负责）。
 * ⚠️ `timestampMs` 必须毫秒 —— 单位错 = 310000 静默拒收（文件头）。
 */
export function dingtalkSign(secret: string, timestampMs: number): string {
  return createHmac('sha256', secret).update(`${timestampMs}\n${secret}`).digest('base64');
}

/**
 * 拼加签后的钉钉 URL：`…&timestamp=<毫秒>&sign=<percent-encode 的 base64>`。
 * base64 的 `+`/`/`/`=` 必须转义（裸着放 query 里会被当作分隔符/空格 —— sign 不匹配）。
 */
export function buildDingtalkUrl(baseUrl: string, secret: string, timestampMs: number): string {
  const sign = encodeURIComponent(dingtalkSign(secret, timestampMs));
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}timestamp=${timestampMs}&sign=${sign}`;
}

function feishuPayload(msg: FormattedMessage): unknown {
  return { msg_type: 'text', content: { text: `${msg.title}\n${msg.body}` } };
}

function wecomPayload(msg: FormattedMessage): unknown {
  return { msgtype: 'markdown', markdown: { content: `**${msg.title}**\n${msg.body}` } };
}

/**
 * 钉钉：`title` 字段供推送预览，`text` 与企微同形（markdown 加粗标题 + 正文）——
 * 规格只钉字段名（`{"msgtype":"markdown","markdown":{"title","text"}}`），
 * 「正文含标题」取与另两槽一致的口径（官方示例同样是 title 在 text 里重现）。
 */
function dingtalkPayload(msg: FormattedMessage): unknown {
  return { msgtype: 'markdown', markdown: { title: msg.title, text: `**${msg.title}**\n${msg.body}` } };
}

/** 单次 POST；一切异常在**这里**收敛（见文件头：失败不外抛，错误不外带）。 */
async function postJson(
  sink: SinkName,
  url: string,
  payload: unknown,
  timeoutMs: number,
): Promise<DeliveryResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      // ⚠️ **不跟随重定向**（T8 审查 M2 实证）：`fetch` 默认跟随——302 终态 2xx 会被记成
      //    「投递成功」（假成功），307 还会**跨主机重放方法与正文**（正文含告警详情）。
      //    webhook 端点应直连配置的地址；一旦走了重定向 ⇒ 响亮失败（AM 按 repeat_interval 重投）。
      redirect: 'error',
    });
    return { sink, ok: res.ok, status: res.status };
  } catch {
    // ⚠️ 刻意**不**记录/外带错误对象：undici 的 URL 解析错误会把完整 URL（凭据）带进 message。
    return { sink, ok: false, status: 0 };
  }
}

/**
 * 按启用槽位造 sink 列表（**顺序固定 feishu → dingtalk → wecom**：扇出、日志与
 * 结果数组都以此为准，测试与排障不要依赖任何随机顺序）。
 *
 * `clock` 注入点：钉钉的 timestamp 由它给（golden 测试用固定值，生产用墙上时钟）；
 * 每次 `deliver` 现取 —— 长驻进程不会把启动时刻的时间戳用过期。
 */
export function createSinks(
  cfg: SinkConfigs,
  opts: { clock?: () => number; timeoutMs?: number } = {},
): Sink[] {
  const clock = opts.clock ?? ((): number => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;
  const sinks: Sink[] = [];

  if (cfg.feishu) {
    const { url } = cfg.feishu;
    sinks.push({ name: 'feishu', deliver: (msg) => postJson('feishu', url, feishuPayload(msg), timeoutMs) });
  }
  if (cfg.dingtalk) {
    const { url, secret } = cfg.dingtalk;
    sinks.push({
      name: 'dingtalk',
      deliver: (msg) => postJson('dingtalk', buildDingtalkUrl(url, secret, clock()), dingtalkPayload(msg), timeoutMs),
    });
  }
  if (cfg.wecom) {
    const { url } = cfg.wecom;
    sinks.push({ name: 'wecom', deliver: (msg) => postJson('wecom', url, wecomPayload(msg), timeoutMs) });
  }

  return sinks;
}

/** 已启用槽位名（供启动日志与测试；顺序同 `createSinks`）。 */
export function configuredSinkNames(cfg: SinkConfigs): SinkName[] {
  const names: SinkName[] = [];
  if (cfg.feishu) names.push('feishu');
  if (cfg.dingtalk) names.push('dingtalk');
  if (cfg.wecom) names.push('wecom');
  return names;
}

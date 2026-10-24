/**
 * relay 的槽位派生（规格 §3.3「槽位派生（纯函数 `sinksFromValues`）」+ §3.6 状态日志依据面）。
 *
 * ## 本片（通知通道管理化）语义变更
 *
 *  - **env 装配退役**：原 `FEISHU_WEBHOOK_URL` / `WECOM_WEBHOOK_URL` /
 *    `DINGTALK_WEBHOOK_URL` / `DINGTALK_SECRET` 四键不再读取（权威值改由
 *    `config.notifyChannel.get` 拉取图下发，见 `notify-config.ts`）；`PORT` 保留（§3.3）。
 *  - **钉钉半配不再拒启动**（设计 D7）：URL/SECRET 半配 ⇒ 该槽位**停用 + WARN**
 *    （WARN 在 `server.ts` 的轮询面，状态变化时一条）——relay 必须常驻投递其它通道。
 *
 * ## 两条不变的 fail-closed 纪律（自 env 时代原样保留）
 *
 *  1. **空串 = 未设**（全仓口径）：拉取图里的空串/空白值一律按「未配」处理 ——
 *     若按 `!== undefined` 判断，空串会被当成「配了」，槽位带着空 URL 出站
 *     ⇒ 全失败 ⇒ 该条告警整体 500，把 Alertmanager 拖进 4h 重投循环。
 *  2. **钉钉 URL 与 SECRET 成对**：只配其一会让**每一次**投递都必然失败 ——
 *     半配在派生面就把该槽位摘掉（`dingtalkHalfConfigured` 供状态 WARN）。
 *  3. 在场判定的值 = **存储 canonical 逐字**（URL 保真：空白只在「是否在场」里参与判定，
 *     不裁剪值本身 —— 拉取图的权威清洗在 config-service 校验面）。
 */
import type { NotifyChannelKey } from '@fight-the-landlord/protocol';

/** 默认端口（`PORT` env 可覆写；规格 §3.3「`PORT` env 保留」）。 */
export const DEFAULT_PORT = 8090;

/** 配置装配错误（非法 PORT）。`main()` 对它 `exit 1`。 */
export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

/** 三个槽位的名字（顺序 = 扇出与日志顺序，全仓同此一处）。 */
export type SinkName = 'feishu' | 'dingtalk' | 'wecom';

export interface FeishuSinkConfig {
  url: string;
}
/** 钉钉：URL 与加签 SECRET **成对**（半配 ⇒ `sinksFromValues` 摘掉该槽位）。 */
export interface DingtalkSinkConfig {
  url: string;
  secret: string;
}
export interface WecomSinkConfig {
  url: string;
}

/** 已启用的槽位集合（未启用 = 键不存在；空串/半配已在派生面归一掉）。 */
export interface SinkConfigs {
  feishu?: FeishuSinkConfig;
  dingtalk?: DingtalkSinkConfig;
  wecom?: WecomSinkConfig;
}

/** `PORT` 的 env 装配结果 —— **槽位不在 env 面**（权威值 = 拉取图，`notify-config.ts`）。 */
export interface RelayConfig {
  port: number;
}

/** 拉取图（九键，仅已配置键在场）；relay 侧只持久化/使用裁剪后的四 IM 键。 */
export type NotifyValues = Partial<Record<NotifyChannelKey, string>>;

/**
 * relay 只消费的四 IM 键（⚙️1 分组；顺序照 ⚙️1 = 拉取地图组装序）。
 * 「邮件组」五键（SMTP）归 am-renderer —— 两处消费面**不相交**（⚙️1）。
 */
export const RELAY_IM_KEYS = [
  'notify.webhook.feishuUrl',
  'notify.webhook.wecomUrl',
  'notify.webhook.dingtalkUrl',
  'notify.webhook.dingtalkSecret',
] as const satisfies readonly NotifyChannelKey[];

const FEISHU_URL_KEY = RELAY_IM_KEYS[0];
const WECOM_URL_KEY = RELAY_IM_KEYS[1];
const DINGTALK_URL_KEY = RELAY_IM_KEYS[2];
const DINGTALK_SECRET_KEY = RELAY_IM_KEYS[3];

/** 读一个「空串 = 未设」的拉取值：仅非空字符串在场；值**逐字**（不裁剪）。 */
function present(values: NotifyValues, key: NotifyChannelKey): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 拉取图 ⇒ 槽位配置（纯函数，规格 §3.3 逐字）：四键各自在场 ⇒ 对应槽位；
 * 钉钉 **URL/SECRET 皆在场**才启用（半配 ⇒ 停用——另经 `dingtalkHalfConfigured` 出 WARN）。
 * 槽位顺序 feishu→dingtalk→wecom 由 `sinks.ts` 的 `configuredSinkNames`/`createSinks` 保证。
 */
export function sinksFromValues(values: NotifyValues): SinkConfigs {
  const sinks: SinkConfigs = {};

  const feishuUrl = present(values, FEISHU_URL_KEY);
  if (feishuUrl !== undefined) sinks.feishu = { url: feishuUrl };

  const wecomUrl = present(values, WECOM_URL_KEY);
  if (wecomUrl !== undefined) sinks.wecom = { url: wecomUrl };

  const dingtalkUrl = present(values, DINGTALK_URL_KEY);
  const dingtalkSecret = present(values, DINGTALK_SECRET_KEY);
  if (dingtalkUrl !== undefined && dingtalkSecret !== undefined) {
    sinks.dingtalk = { url: dingtalkUrl, secret: dingtalkSecret };
  }

  return sinks;
}

/**
 * 钉钉半配判定（URL/SECRET 恰在场其一）——`server.ts` 据此打「状态变化时一条」的半配 WARN。
 * 在场口径与 `sinksFromValues` 完全一致（空串/空白 = 未设）。
 */
export function dingtalkHalfConfigured(values: NotifyValues): boolean {
  const hasUrl = present(values, DINGTALK_URL_KEY) !== undefined;
  const hasSecret = present(values, DINGTALK_SECRET_KEY) !== undefined;
  return hasUrl !== hasSecret;
}

/** `PORT`：未设/空白 ⇒ 默认；给值必须是 1–65535 的整数（拒启动，别静默回退）。 */
function parsePort(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) {
    throw new RelayConfigError('PORT 必须是 1–65535 的整数（当前值不是合法端口）');
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new RelayConfigError('PORT 必须是 1–65535 的整数（当前值超出范围）');
  }
  return port;
}

/**
 * 从 env 装配配置（默认读 `process.env`；测试注入任意映射）。抛 `RelayConfigError` = 拒启动。
 * ⚠️ 本片后只剩 `PORT` 一项 —— 四 IM 键退役，槽位从拉取图派生（`sinksFromValues`）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return { port: parsePort(env.PORT) };
}

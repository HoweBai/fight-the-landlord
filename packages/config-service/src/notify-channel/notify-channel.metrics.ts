import { Logger } from '@nestjs/common';
import { createGauge, metricsRegistry } from '@fight-the-landlord/shared';
import type { NotifyChannelKey } from '@fight-the-landlord/protocol';

/**
 * 通知通道完整性 gauges（⚙️17 / §3.8；T5 交付物）。
 *
 * 两条指标、两组标签（`group ∈ {email, dingtalk}`）：
 *  - `notify_config_keys_configured{group}`：组内已配置键数（email 口径 = SMTP 5 键、dingtalk 口径 = 钉钉 2 键）；
 *  - `notify_config_group_complete{group}`：1 = 组内键全配、0 = 未齐（§3.8 两条告警规则的判据）。
 *
 * ─── 采集口径（「写路径现算」；设计 D7 / 规格 §3.1）──────────────────────────
 *  - 刷新点 = `NotifyChannelService.set()/clear()` **事务成功后** + `OnModuleInit` 启动各一次
 *    （本键空间的一切变更都经管理端点 ⇒ 值不漂移）；
 *  - **不引入 scrape 回调**：shared `createGauge` 无 collect 参数，且 collect 抛错会把整个
 *    `/metrics` 打成 500（设计 D7 评审 Y2）；
 *  - 读取 SQL 只 `SELECT `key`` **数行不解密**（⚙️17 逐字）、**无占位符**
 *    （写路径**不得内嵌值**——gauge 面只承载计数）；
 *  - **读失败 ⇒ 保持旧值 + WARN**（`refreshNotifyGauges` 内部 try/catch——「不得打穿 /metrics」，
 *    也不得影响写响应：本函数**不抛**）。
 *
 * ⚠️ 两组大小恒非 0（email 5 / dingtalk 2）且**模块加载即把两组序列定到 0**
 * ——「恒有定义」：告警规则/判据读 `{group="email"}` 序列必存在，`complete = configured == 组大小`
 * 的比较永不出现退化形态。
 */

/** ⚙️17 逐字（唯一消费点 = 本文件的刷新函数；被单测钉全文）。 */
export const NOTIFY_CHANNEL_GAUGE_SQL = 'SELECT `key` FROM notify_channel_config';

/**
 * gauge 分组（⚙️1 键集的分组切分，**只此两组的完整性口径**——「邮件组」前 5 键（renderer）与
 * 「钉钉组」2 键（relay 的半配判定））。IM 其余两键（feishu/wecom）为「在场即启用」，无完整性口径。
 */
export const NOTIFY_CONFIG_GROUP_KEYS = {
  email: [
    'notify.smtp.host',
    'notify.smtp.port',
    'notify.smtp.user',
    'notify.smtp.pass',
    'notify.email.to',
  ],
  dingtalk: ['notify.webhook.dingtalkUrl', 'notify.webhook.dingtalkSecret'],
} as const satisfies Readonly<Record<string, readonly NotifyChannelKey[]>>;

export type NotifyConfigGroup = keyof typeof NOTIFY_CONFIG_GROUP_KEYS;

/**
 * 注册**幂等**化（⚠️ 只为「同进程模块重估」面——`vi.resetModules()` + 动态 import 的
 * fresh-module 用例〔主钥缺用例〕会在**同一** registry 上二次求值本模块；shared 的 registry
 * 是进程单例，直呼 `createGauge` 必撞 prom-client 的「already been registered」硬抛）。
 * 复用已注册实例语义等价（同名/同 help/同标签；值仍由 `refreshNotifyGauges` 覆盖）。
 * 注册本身仍**只经** shared 的 `createGauge`（registry 同一性纪律不变）；生产路径本模块
 * 只求值一次，复用分支不可达。
 */
function ensureGauge(name: string, help: string): ReturnType<typeof createGauge> {
  const existing = metricsRegistry().getSingleMetric(name);
  if (existing) return existing as ReturnType<typeof createGauge>;
  return createGauge(name, help, ['group']);
}

/**
 * `notify_config_keys_configured{group}`（⚙️17 逐字名）：组内已配置键数。
 * 告警规则以 `> 0` 作为「这组被动过」的判据（§3.8）。
 */
export const notifyConfigKeysConfigured: ReturnType<typeof createGauge> = ensureGauge(
  'notify_config_keys_configured',
  '通知通道组内已配置键数（group ∈ {email(5), dingtalk(2)}）；写路径现算（只数行不解密）。',
);

/** `notify_config_group_complete{group}`（⚙️17 逐字名）：1 = 组内键全配、0 = 未齐。 */
export const notifyConfigGroupComplete: ReturnType<typeof createGauge> = ensureGauge(
  'notify_config_group_complete',
  '通知通道分组完整性（1 = 组内键全配；0 = 未齐，§3.8 半配告警判据）。',
);

/** 「恒有定义」：模块加载即定形两组序列（值 0；成功刷新后按实算值覆盖）。 */
for (const group of Object.keys(NOTIFY_CONFIG_GROUP_KEYS) as NotifyConfigGroup[]) {
  notifyConfigKeysConfigured.set({ group }, 0);
  notifyConfigGroupComplete.set({ group }, 0);
}

const logger = new Logger('NotifyChannelMetrics');

/**
 * 刷新读取面的**结构收窄**（`DataSource` 在结构上满足之；单测可喂任意 stub）。
 */
export interface NotifyGaugesQuerySource {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * ⚙️17「写路径现算」的唯一写点：`SELECT `key`` → 数行 → 两组 set。
 * **不抛**（读失败 ⇒ 保持旧值 + WARN）；参数只有 SQL 常量本身、**不含任何值**。
 */
export async function refreshNotifyGauges(source: NotifyGaugesQuerySource): Promise<void> {
  try {
    const rows = (await source.query(NOTIFY_CHANNEL_GAUGE_SQL)) as Array<{ key: unknown }>;
    const present = new Set(rows.map((row) => String(row.key)));
    for (const group of Object.keys(NOTIFY_CONFIG_GROUP_KEYS) as NotifyConfigGroup[]) {
      const keys = NOTIFY_CONFIG_GROUP_KEYS[group];
      const configured = keys.filter((key) => present.has(key)).length;
      notifyConfigKeysConfigured.set({ group }, configured);
      notifyConfigGroupComplete.set({ group }, configured === keys.length ? 1 : 0);
    }
  } catch (err) {
    // 保持旧值（时序上 = 上一次成功刷新或模块加载的 0）；消息不含任何凭据值（SQL 无参数）。
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`通知通道完整性 gauge 刷新失败（保持旧值）——${reason}`);
  }
}

/**
 * Asia/Shanghai 的 `YYYY-MM-DD`（**服务端口径的唯一实现点**；广告片 T12 抽出）。
 *
 * 两处消费**互指**（两处必须逐字同源——审计锚与凭证锚是同一把尺子）：
 *  - `wallet/wallet.controller.ts` 的 `reliefActionId`（救助幂等锚 `relief:<userId>:<日期>`，
 *    金币场 T8 起；本文件即从该函数逐字抽出，行为不变）；
 *  - `ads/claim.service.ts` 的私有 `todayShanghai()`（claim 签发日 —— 规格 §2.6：
 *    `date` = Asia/Shanghai 签发日，且 actionId 锚 = `relief:<claim.userId>:<claim.date>`，
 *    两处若用不同实现会在 UTC 日界两侧产生「凭证锚 A 日、账本查 B 日」的分歧）。
 *
 * 实现形态照 `reliefActionId` 抽出前的原文：`formatToParts` 式装配，**不依赖 locale 的
 * 字段顺序**（en-CA 的 `.format()` 直出虽同为 `YYYY-MM-DD`，但 partOf 式是既有先例的
 * 逐字口径，抽取时保持零行为变化）。日界定值向量由单测钉住（UTC 日界两侧）。
 */
export function shanghaiDateOf(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const partOf = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${partOf('year')}-${partOf('month')}-${partOf('day')}`;
}

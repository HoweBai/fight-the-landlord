/**
 * 支付片：**手机端 UA 判别**（桥接「服务端代发 → 直跳手机收银台」的唯一开关）。
 *
 * 背景（线上沙箱裁决，2026-10）：wap 表单 POST 到沙箱网关后，边缘按 **UA + 出口**
 * 分流——手机 UA 进 `mobileclientgw-sandbox` 手机收银台（域内支付密码登录可完成付款）；
 * 桌面 UA 进 `openapi` 集群，其登录按钮跳**生产 SSO**（`authsa128.alipay.com`），
 * 沙箱账号必败。玩家真机浏览器偶发被分到桌面集群即为死路，故手机端改由服务端
 * （稳定命中手机集群的出口）代发，回收手机收银台签发地址后 302 直达。
 *
 * 纯函数、零依赖：命中主流移动端标记即 true；空值/桌面 UA = false（维持浏览器自发表单）。
 */

/** 移动端 UA 标记（Android/iPhone/iPad/iPod/鸿蒙 HarmonyOS；`mobile` 兜底各类移动内核标识）。 */
const MOBILE_UA_PATTERN = /android|iphone|ipod|ipad|harmony|mobile/i;

export function isMobileUserAgent(ua: string | null | undefined): boolean {
  return typeof ua === 'string' && MOBILE_UA_PATTERN.test(ua);
}

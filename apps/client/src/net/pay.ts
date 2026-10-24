/**
 * 支付片 T14：玩家钱包 REST 的**九端点封装**（规格 v1.1.5 §2.4.1 表 1–9；网关转发面由 T13 落地）。
 *
 * 口径全照既有 `rest.ts` 先例，本文件**不造第二份请求实现**：
 *  - 走 `authedRequest`/`authedGet`（带 `Authorization`、`10004` 轮换一次后**重放一次**、
 *    统一信封 `{ code, message, data }` 解析）；
 *  - 重放安全性：`10004` 是**网关验签阶段**的拒绝（请求从未转发给下游）⇒ 不存在「第一次
 *    其实已生效、响应丢了」的形态（`rest.ts#createRoom` 的同一条论证）。提现/退款申请的
 *    服务端幂等槽（`active_slot` UK）是第二层兜底。
 *  - 错误面**不在这里分支**：调用方拿非 0 的信封走 `dispatchRestFailure` 查 `CLIENT_ACTION`
 *    表（15001–15006/15008/15009 全 `TOAST`，文案逐字取服务端 `message`，§2.8）。
 *
 * 单号进 URL 一律 `encodeURIComponent`（R75 先例）：单号字符集 `[0-9a-z_]`（⚙️4）理论上
 * 无需编码，但「原样拼」会在字符集放宽时静默造出错误路径——编码不是加工内容，是让请求本身合法。
 */
import type {
  PayCreateOrderResponse,
  PayOrderInfo,
  PayOrdersPage,
  PayRefundApplyResponse,
  PayRefundsPage,
  PayWalletSummary,
  PayWithdrawApplyResponse,
  PayWithdrawalsPage,
} from '@fight-the-landlord/protocol';
import { authedGet, authedRequest, type RestResponse } from './rest';

/* ------------------------------------------------------------------ *
 * ①–⑨ 九端点（编号 = 规格 §2.4.1 表行号）
 * ------------------------------------------------------------------ */

/** ① `POST /api/pay/orders`：下单（档位为元；非法档位 10001 / 开关关 15008 / 渠道 15001 由服务端裁）。 */
export function createPayOrder(
  packageYuan: number,
): Promise<RestResponse<PayCreateOrderResponse>> {
  return authedRequest<PayCreateOrderResponse>('POST', '/pay/orders', { packageYuan });
}

/** ② `GET /api/pay/orders/:orderNo`：订单详情（不存在/非本人 ⇒ 15002）。回跳轮询的读数点。 */
export function fetchPayOrder(orderNo: string): Promise<RestResponse<PayOrderInfo>> {
  return authedGet<PayOrderInfo>(`/pay/orders/${encodeURIComponent(orderNo)}`);
}

/** ③ `POST /api/pay/orders/:orderNo/sync`：主动查询补单（同详情响应形）。轮询窗耗尽后的「刷新」。 */
export function syncPayOrder(orderNo: string): Promise<RestResponse<PayOrderInfo>> {
  return authedRequest<PayOrderInfo>('POST', `/pay/orders/${encodeURIComponent(orderNo)}/sync`, {});
}

/** ④ `GET /api/pay/orders/mine`：我的订单（keyset；`cursor` 是不透明串，**原样回传**——记录片同款）。 */
export function fetchMyPayOrders(cursor?: string): Promise<RestResponse<PayOrdersPage>> {
  return authedGet<PayOrdersPage>(payMinePath('/pay/orders/mine', cursor));
}

/** ⑤ `GET /api/pay/wallet/summary`：钱包摘要（余额/可离场额度/当日剩余可申——提现区三个读数源）。 */
export function fetchPayWalletSummary(): Promise<RestResponse<PayWalletSummary>> {
  return authedGet<PayWalletSummary>('/pay/wallet/summary');
}

/**
 * ⑥ `POST /api/pay/refunds`：申请退款（申请即冻结；15002/15006 由服务端裁）。
 * ⚠️ 钱包页 v1 **没有**申请退款的 UI（规格 §4 只含充值/提现/记录）——本函数按卡封装九端点，
 * 消费面留给后续（驳回可重报；§7)。
 */
export function applyPayRefund(
  orderNo: string,
  reason: string,
): Promise<RestResponse<PayRefundApplyResponse>> {
  return authedRequest<PayRefundApplyResponse>('POST', '/pay/refunds', { orderNo, reason });
}

/** ⑦ `GET /api/pay/refunds/mine`：我的退款（keyset）。 */
export function fetchMyPayRefunds(cursor?: string): Promise<RestResponse<PayRefundsPage>> {
  return authedGet<PayRefundsPage>(payMinePath('/pay/refunds/mine', cursor));
}

/** ⑧ `POST /api/pay/withdrawals`：申请提现（15003/15004/15005 由服务端裁；档位等本地校验只是预检）。 */
export function applyPayWithdrawal(
  coins: number,
  reauthTicket?: string,
): Promise<RestResponse<PayWithdrawApplyResponse>> {
  const headers: Record<string, string> = {};
  if (reauthTicket) headers['x-reauth-ticket'] = reauthTicket;
  return authedRequest<PayWithdrawApplyResponse>('POST', '/pay/withdrawals', { coins }, headers);
}

/** ⑨ `GET /api/pay/withdrawals/mine`：我的提现（keyset）。14006/14007 行内提示的读数点。 */
export function fetchMyPayWithdrawals(cursor?: string): Promise<RestResponse<PayWithdrawalsPage>> {
  return authedGet<PayWithdrawalsPage>(payMinePath('/pay/withdrawals/mine', cursor));
}

/**
 * keyset 页码 URL 的唯一拼法（三个 `mine` 端点共用）：
 * `cursor === undefined` = 第一页（不带参数）；否则原样回传（`encodeURIComponent` 是让请求
 * 本身合法——游标里可能带 URL 保留字符，`records/mine` 记过同款）。
 */
function payMinePath(base: string, cursor?: string): string {
  return cursor === undefined ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
}

/* ------------------------------------------------------------------ *
 * 回跳（`return_url = <PAY_PUBLIC_BASE_URL>/?pay=<orderNo>`；T7 起服务端如此拼）
 * ------------------------------------------------------------------ */

/** App/无浏览器宿主上的降级引导（§2.8 逐字：「请用浏览器打开完成支付」）。 */
export const PAY_BROWSER_HINT = '请用浏览器打开完成支付';

/**
 * 宿主不支持 `replaceState` 时的一次性兜底（正常路径下「摘参」即消费，不需要它）。
 * ⚠️ 模块级 ⇒ 一个应用生命周期内至多命中一次；整页刷新是新的生命周期（模块重新加载）。
 */
let consumedFallback = false;

/**
 * 消费 URL 里的回跳单号 `?pay=<orderNo>`（应用启动 / 钱包页挂载时读；§2.8 回跳）。
 *
 * **消费语义 = 从地址栏摘掉这个参数**（`history.replaceState`）——不这么做的话，
 * 「钱包页返回大厅 → 大厅重新挂载 → 又读到 `?pay=` → 又把用户弹回钱包页」会成一个环。
 * 宿主没有 URL（App/小程序）或没有 `pay` 参数 ⇒ `null`（回跳只发生在浏览器里）。
 *
 * ⚠️ 读的是 `location.search`（**问号段**）——服务端的 `return_url` 正是
 * `<base>/?pay=<orderNo>`（`orders.service.ts:476`）；uni-app H5 的 hash 路由段不含它。
 */
export function consumePayReturnOrderNo(): string | null {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return null;
  if (consumedFallback) return null;
  let search = '';
  let pathname = '';
  let hash = '';
  try {
    search = window.location.search ?? '';
    pathname = window.location.pathname ?? '';
    hash = window.location.hash ?? '';
  } catch {
    return null;
  }
  if (!search) return null;
  const params = new URLSearchParams(search);
  const orderNo = params.get('pay');
  if (!orderNo) return null;
  params.delete('pay');
  const query = params.toString();
  try {
    window.history.replaceState(null, '', `${pathname}${query ? `?${query}` : ''}${hash}`);
  } catch {
    // 摘不掉（宿主限制）⇒ 退化为进程内一次性；至少不会形成「回大厅又弹回」的环。
    consumedFallback = true;
  }
  return orderNo;
}

/**
 * 跳支付宝收银台（三分支；设计 §11.4「App 宿主经 `plus.runtime.openURL` 尽力唤起」）。
 *
 *  ① **App 宿主**（HTML5+ 运行时全局 `plus` 在场）：`plus.runtime.openURL(payUrl)`
 *     —— 把 URL 交给系统打开（系统浏览器 → wap 收银台 → 唤起支付宝）=「尽力唤起」。
 *     App 的页面 JS 跑在 service（非 webview）上下文，**没有 `window`/`location`**
 *     （`http.ts` 记过同款）⇒ 这一支必须先于 ② 判定，且探测只能读裸全局 `plus`
 *     （`@dcloudio/types` 的 `declare const plus: Plus` 即此形态；没有 Window 增补，
 *     写 `window.plus` 在 App 上永不命中）。调用**同步抛错**（唤起失败）⇒ 返回 `false`，
 *     回落 ③ 的降级文案路径。
 *  ② **H5**：`window.location.href = payUrl`（浏览器直跳 wap 收银台；支付宝唤起链
 *     由收银台页面自身承接）。
 *  ③ **两者皆无 / 唤起失败**：返回 `false` ⇒ 调用方显示降级引导
 *     （`PAY_BROWSER_HINT`，§2.8「请用浏览器打开完成支付」）。
 *
 * ⚠️ `plus.runtime.openURL(url, errorCB)` 的 errorCB 是**异步**回调，本函数是同步
 * boolean 契约——异步结果没有回送通道（要送回页面就得改 wallet.vue 的接线，超出本卡）：
 * 异步失败 = 用户留在 App 内可重试，「尽力唤起」的边界照此成立（可用性并入 App 真机走查）。
 */
export function jumpToCashier(payUrl: string): boolean {
  if (typeof plus !== 'undefined' && typeof plus.runtime?.openURL === 'function') {
    try {
      plus.runtime.openURL(payUrl);
      return true;
    } catch {
      return false;
    }
  }
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return false;
  window.location.href = payUrl;
  return true;
}

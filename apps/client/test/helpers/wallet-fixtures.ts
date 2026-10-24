/**
 * 钱包族页面测试的共享夹具（2026-10-23 钱包拆分）。
 *
 * 为什么单独成文件：钱包页 / 充值页 / 提现页三个测试文件共用同一套 fetch 路由与
 * 契约夹具；复制三份会在 `noUnusedLocals`（`vue-tsc --noEmit` 覆盖 `test/**`）下
 * 因「本文件没用到某个 fixture」变红。
 *
 * ⚠️ 每个测试文件**只导入自己用到的符号**。
 */
import { vi } from 'vitest';

/** 记录 `fetch` 的每一次调用（`rest.ts` 只用到 `status` 与 `text()`）。 */
export interface FetchCall {
  url: string;
  init?: RequestInit;
}

export type Responder = (call: FetchCall, index: number) => unknown;

export function stubFetch(route: Responder, status = 200) {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, text: async () => JSON.stringify(route({ url, init }, calls.length - 1)) };
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

export const ok = (data: unknown) => ({ code: 0, data });
export const err = (code: number, message: string) => ({ code, message, data: null });

/** 2026-10-05 12:00（本地时区构造——展示格式按本地时间渲染，跨时区跑也稳定）。 */
export const T0 = new Date(2026, 9, 5, 12, 0).getTime();

export function orderFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderNo: 'pay_o1',
    status: 'created',
    coins: 600,
    amountYuan: '6.00',
    packageYuan: 6,
    createdAt: T0,
    paidAt: null,
    creditedAt: null,
    closedAt: null,
    ...over,
  };
}

export function refundFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    refundNo: 'rf_o1',
    orderNo: 'pay_o1',
    coins: 600,
    amountYuan: '6.00',
    status: 'pending',
    reason: '不想要了',
    reviewNote: null,
    reviewedAt: null,
    refundedAt: null,
    createdAt: T0,
    ...over,
  };
}

export function withdrawFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    withdrawNo: 'wd_o1',
    coins: 2000,
    amountYuan: '20.00',
    status: 'pending',
    timeoutAt: T0,
    reviewNote: null,
    reviewedAt: null,
    confirmedAt: null,
    rolledBackAt: null,
    createdAt: T0,
    ...over,
  };
}

export function summaryData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { balance: 4200, withdrawable: 3000, dailyWithdrawRemainingCoins: 95000, ...over };
}

export interface WalletRouteSlots {
  summary?: Responder;
  ordersMine?: Responder;
  refundsMine?: Responder;
  withdrawalsMine?: Responder;
  /** GET `/pay/orders/:no`（详情/轮询读数）。 */
  orderDetail?: Responder;
  /** POST `/pay/orders`（下单）。 */
  createOrder?: Responder;
  /** POST `/pay/orders/:no/sync`（手动刷新）。 */
  syncOrder?: Responder;
  /** POST `/pay/withdrawals`（提现申请）。 */
  applyWithdraw?: Responder;
  /** POST `/auth/reauth`（提现再认证；`withdrawReAuthEnabled` 开时才发）。 */
  reauth?: Responder;
}

/** 钱包族页面标准路由（各端点默认成功；测试只覆盖关心的槽）。 */
export function makeRoute(slots: WalletRouteSlots = {}): Responder {
  return (call, index) => {
    const url = call.url;
    const method = call.init?.method ?? 'GET';
    if (url.includes('/pay/wallet/summary')) return (slots.summary ?? (() => ok(summaryData())))(call, index);
    if (url.includes('/pay/orders/mine')) {
      return (slots.ordersMine ?? (() => ok({ items: [], nextCursor: null })))(call, index);
    }
    if (url.includes('/pay/refunds/mine')) {
      return (slots.refundsMine ?? (() => ok({ items: [], nextCursor: null })))(call, index);
    }
    if (url.includes('/pay/withdrawals/mine')) {
      return (slots.withdrawalsMine ?? (() => ok({ items: [], nextCursor: null })))(call, index);
    }
    if (url.endsWith('/sync')) {
      return (slots.syncOrder ?? (() => ok(orderFixture({ status: 'credited' }))))(call, index);
    }
    if (url.endsWith('/pay/orders') && method === 'POST') {
      return (
        slots.createOrder ??
        (() => ok({ orderNo: 'pay_new', payUrl: 'https://cashier.example/pay_new', expiresAt: T0 }))
      )(call, index);
    }
    if (url.endsWith('/pay/withdrawals') && method === 'POST') {
      return (slots.applyWithdraw ?? (() => ok({ withdrawNo: 'wd_new', status: 'pending' })))(call, index);
    }
    if (url.includes('/auth/reauth')) {
      return (slots.reauth ?? (() => ok({ ticket: 'reauth_tk' })))(call, index);
    }
    if (method === 'GET' && /\/pay\/orders\/[^/]+$/.test(url)) {
      return (slots.orderDetail ?? (() => ok(orderFixture())))(call, index);
    }
    return ok(null);
  };
}

/** 某个端点的调用计数（URL 子串判据）。 */
export function countCalls(calls: FetchCall[], segment: string): number {
  return calls.filter((c) => c.url.includes(segment)).length;
}

/**
 * 支付七键的默认配置（两开关开 + 四数值给全）。
 * 测试只传要覆盖的键（`setClientConfig` 是整对象写入，必须每次给全 16 键）。
 */
export function walletClientConfig(over: Record<string, unknown> = {}) {
  return {
    baseScoreLevels: [],
    friendRoomEnabled: false,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    reliefAdpid: '',
    entryMultiplier: 10,
    rechargeEnabled: true,
    withdrawEnabled: true,
    coinPerYuan: 100,
    rechargePackages: [6, 30, 68],
    withdrawMinCoins: 1000,
    withdrawMaxCoinsPerOrder: 50000,
    withdrawDailyMaxCoins: 100000,
    withdrawReAuthEnabled: false,
    version: 3,
    ...over,
  };
}

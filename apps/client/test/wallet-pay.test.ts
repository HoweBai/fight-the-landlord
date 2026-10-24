/**
 * 支付片 T14（规格 v1.1.5 §2.4.1 表 1–9 · §2.8）：`net/pay.ts` 的**九端点封装** + 回跳 helpers。
 *
 * 判别矩阵（每条对着一种「最像正确答案」的错实现）：
 *  ① **九端点**：URL/方法/请求体逐条（①`POST /pay/orders` 带 `{packageYuan}` ·
 *     ②/③ 详情与 sync 的 `:orderNo` 段 · ④/⑦/⑨ 三个 `mine` keyset —— 无游标**不带参数**、
 *     有游标**原样透传 + `encodeURIComponent`**（拿含 URL 保留字符的样例才有判别力）·
 *     ⑤ summary · ⑥ `{orderNo,reason}` · ⑧ `{coins}`）；
 *  ② **复用既有封装**：带 `Authorization`（`authedRequest` —— 不另造第二份请求实现）、
 *     非 0 信封**原样交回**（不伪造成功）；
 *  ③ **回跳解析**：`?pay=` 读到即**从地址栏摘参**（消费一次 ⇒ 回大厅不弹回；其余 query 保留）；
 *     无参/无 window ⇒ `null`；宿主禁 `replaceState` ⇒ 退化为进程内一次性（**该用例放最后**：
 *     它置模块级兜底位）；
 *  ④ **跳收银台（三分支）**：App 宿主（全局 `plus`；service 上下文**无** `window`）⇒ 走
 *     `plus.runtime.openURL` 尽力唤起（不导航；设计 §11.4 / 波 5 🟡-1）；H5（无 `plus`）
 *     ⇒ 赋值 `location.href`；`openURL` 抛错 / 两者皆无 ⇒ 返 `false`（调用方据此显示
 *     §2.8 降级文案）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pay from '../src/net/pay';
import { clientConfig } from '../src/config';
import { clearSession, saveSession } from '../src/net/storage';

/** 记录 `fetch` 的每一次调用（`rest.ts` 只用到 `status` 与 `text()`）。 */
interface FetchCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(route: (call: FetchCall) => unknown, status = 200) {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, text: async () => JSON.stringify(route({ url, init })) };
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

beforeEach(() => {
  localStorage.clear();
  clientConfig.token = '';
});

afterEach(() => {
  clearSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('① 九端点：URL / 方法 / 请求体（§2.4.1 表 1–9）', () => {
  it('① POST /pay/orders + body {packageYuan} + 信封解析', async () => {
    const { calls } = stubFetch(() => ({
      code: 0,
      data: { orderNo: 'pay_a1', payUrl: 'https://cashier.example/x', expiresAt: 123 },
    }));

    const res = await pay.createPayOrder(6);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith('/pay/orders')).toBe(true);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ packageYuan: 6 });
    expect(res.code).toBe(0);
    expect(res.data?.payUrl).toBe('https://cashier.example/x');
  });

  it('② GET /pay/orders/:orderNo（详情）', async () => {
    const { calls } = stubFetch(() => ({
      code: 0,
      data: { orderNo: 'pay_a1', status: 'paid', coins: 600, amountYuan: '6.00', packageYuan: 6, createdAt: 1, paidAt: 2, creditedAt: null, closedAt: null },
    }));

    const res = await pay.fetchPayOrder('pay_a1');

    expect(calls[0]!.url.endsWith('/pay/orders/pay_a1')).toBe(true);
    expect(calls[0]!.init?.method).toBe('GET');
    expect(res.data?.status).toBe('paid');
  });

  it('③ POST /pay/orders/:orderNo/sync（手动刷新 ⇒ 主动查询补单）', async () => {
    const { calls } = stubFetch(() => ({
      code: 0,
      data: { orderNo: 'pay_a1', status: 'credited', coins: 600, amountYuan: '6.00', packageYuan: 6, createdAt: 1, paidAt: 2, creditedAt: 3, closedAt: null },
    }));

    const res = await pay.syncPayOrder('pay_a1');

    expect(calls[0]!.url.endsWith('/pay/orders/pay_a1/sync')).toBe(true);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(res.data?.status).toBe('credited');
  });

  it('④ GET /pay/orders/mine（无游标**不带** cursor 参数）', async () => {
    const { calls } = stubFetch(() => ({ code: 0, data: { items: [], nextCursor: null } }));

    const res = await pay.fetchMyPayOrders();

    expect(calls[0]!.url.endsWith('/pay/orders/mine')).toBe(true);
    expect(calls[0]!.url).not.toContain('cursor=');
    expect(res.data?.nextCursor).toBeNull();
  });

  it('④ 游标**原样透传 + encodeURIComponent**（含 URL 保留字符的样例；漏编码会在解码面现形）', async () => {
    const cursor = 'a+b/c==d e';
    const { calls } = stubFetch(() => ({ code: 0, data: { items: [], nextCursor: null } }));

    await pay.fetchMyPayOrders(cursor);

    expect(calls[0]!.url).toContain(`cursor=${encodeURIComponent(cursor)}`);
    expect(calls[0]!.url).not.toContain('cursor=a+b/c==d e');
  });

  it('⑤ GET /pay/wallet/summary（三字段）', async () => {
    const { calls } = stubFetch(() => ({
      code: 0,
      data: { balance: 4200, withdrawable: 3000, dailyWithdrawRemainingCoins: 95000 },
    }));

    const res = await pay.fetchPayWalletSummary();

    expect(calls[0]!.url.endsWith('/pay/wallet/summary')).toBe(true);
    expect(res.data).toEqual({ balance: 4200, withdrawable: 3000, dailyWithdrawRemainingCoins: 95000 });
  });

  it('⑥ POST /pay/refunds + body {orderNo, reason}', async () => {
    const { calls } = stubFetch(() => ({ code: 0, data: { refundNo: 'rf_a1', status: 'holding' } }));

    const res = await pay.applyPayRefund('pay_a1', '不要了');

    expect(calls[0]!.url.endsWith('/pay/refunds')).toBe(true);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ orderNo: 'pay_a1', reason: '不要了' });
    expect(res.data?.refundNo).toBe('rf_a1');
  });

  it('⑦ GET /pay/refunds/mine（keyset）', async () => {
    const { calls } = stubFetch(() => ({ code: 0, data: { items: [], nextCursor: null } }));

    await pay.fetchMyPayRefunds('cur-1');

    expect(calls[0]!.url).toContain('/pay/refunds/mine?cursor=cur-1');
  });

  it('⑧ POST /pay/withdrawals + body {coins}（整数）', async () => {
    const { calls } = stubFetch(() => ({ code: 0, data: { withdrawNo: 'wd_a1', status: 'pending' } }));

    const res = await pay.applyPayWithdrawal(2000);

    expect(calls[0]!.url.endsWith('/pay/withdrawals')).toBe(true);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ coins: 2000 });
    expect(res.data?.status).toBe('pending');
  });

  it('⑨ GET /pay/withdrawals/mine（keyset）', async () => {
    const { calls } = stubFetch(() => ({ code: 0, data: { items: [], nextCursor: null } }));

    await pay.fetchMyPayWithdrawals('cur-2');

    expect(calls[0]!.url).toContain('/pay/withdrawals/mine?cursor=cur-2');
  });

  it('非 0 的信封原样交回调用方，不伪造成功（§11.1）', async () => {
    stubFetch(() => ({ code: 15008, message: '充值暂未开放', data: null }));

    const res = await pay.createPayOrder(6);

    expect(res.code).toBe(15008);
    expect(res.message).toBe('充值暂未开放');
    expect(res.data).toBeNull();
  });

  it('带 Authorization（走 authedRequest 的既有封装，不另造第二份请求实现）', async () => {
    clientConfig.token = 'a1';
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const { calls } = stubFetch(() => ({ code: 0, data: { items: [], nextCursor: null } }));

    await pay.fetchMyPayOrders();

    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });
  });
});

/* ------------------------------------------------------------------ *
 * 回跳 helpers（③④）—— 这些用例整体替换 globalThis.window（本文件不挂组件，
 * 替换是局部的；afterEach `unstubAllGlobals` 复原）。
 * ------------------------------------------------------------------ */

interface FakeWindow {
  location: { search: string; pathname: string; hash: string; href: string };
  history: { replaceState: (state: unknown, title: string, url: string) => void };
  replaceCalls: string[];
}

/** 造一个「replaceState 真的会改地址」的 window 替身（消费语义靠它成立）。 */
function fakeWindow(search: string): FakeWindow {
  const fake: FakeWindow = {
    location: { search, pathname: '/', hash: '', href: '' },
    replaceCalls: [],
    history: {
      replaceState: (_state, _title, url) => {
        fake.replaceCalls.push(url);
        const q = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
        fake.location.search = q ? `?${q}` : '';
      },
    },
  };
  return fake;
}

describe('③ 回跳单号解析：consumePayReturnOrderNo（读 + 摘参 = 消费一次）', () => {
  it('读到 ?pay= ⇒ 返回单号并把它从地址栏摘掉；第二次读 ⇒ null（消费一次）', () => {
    const fake = fakeWindow('?pay=pay_ret_1');
    vi.stubGlobal('window', fake);

    expect(pay.consumePayReturnOrderNo()).toBe('pay_ret_1');
    expect(fake.replaceCalls).toEqual(['/']);
    expect(fake.location.search, '摘参后地址栏不再带 pay').toBe('');
    expect(pay.consumePayReturnOrderNo(), '消费一次：回大厅/重挂载不再弹回').toBeNull();
  });

  it('其余 query 保留（只摘 pay 这一个键）', () => {
    const fake = fakeWindow('?pay=pay_ret_2&from=alipay');
    vi.stubGlobal('window', fake);

    expect(pay.consumePayReturnOrderNo()).toBe('pay_ret_2');
    expect(fake.replaceCalls).toEqual(['/?from=alipay']);
  });

  it('无 query / 无 pay 参数 ⇒ null，且**不动**地址栏', () => {
    const empty = fakeWindow('');
    vi.stubGlobal('window', empty);
    expect(pay.consumePayReturnOrderNo()).toBeNull();
    expect(empty.replaceCalls).toEqual([]);

    const other = fakeWindow('?other=1');
    vi.stubGlobal('window', other);
    expect(pay.consumePayReturnOrderNo()).toBeNull();
    expect(other.replaceCalls).toEqual([]);
  });

  it('没有 window（App/小程序 service 侧 / 纯 node）⇒ null（回跳只发生在浏览器里）', () => {
    vi.stubGlobal('window', undefined);
    expect(pay.consumePayReturnOrderNo()).toBeNull();
  });

  it('⚠️ 放最后：宿主禁 replaceState ⇒ 退化为进程内一次性（本用例置模块级兜底位）', () => {
    const fake = fakeWindow('?pay=pay_ret_3');
    fake.history.replaceState = () => {
      throw new Error('sandboxed');
    };
    vi.stubGlobal('window', fake);

    expect(pay.consumePayReturnOrderNo()).toBe('pay_ret_3');
    expect(pay.consumePayReturnOrderNo(), '摘不掉 ⇒ 至少进程内只消费一次').toBeNull();
  });
});

describe('④ 跳收银台：jumpToCashier（App 宿主 ⇒ plus.runtime.openURL；H5 ⇒ location.href；皆无/失败 ⇒ false）', () => {
  it('有 plus（App 宿主；window 也在场）⇒ 走 plus.runtime.openURL 恰一次、**不**导航 location', () => {
    const fake = fakeWindow('');
    vi.stubGlobal('window', fake);
    const openURL = vi.fn();
    vi.stubGlobal('plus', { runtime: { openURL } });

    expect(pay.jumpToCashier('https://cashier.example/pay')).toBe(true);
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL).toHaveBeenCalledWith('https://cashier.example/pay');
    expect(fake.location.href, 'plus 分支优先——不该落到 H5 导航').toBe('');
  });

  it('有 plus 且**无 window**（App service 上下文的真实形态）⇒ 仍走 openURL（旧实现在此直接 false = 🟡-1 本体）', () => {
    vi.stubGlobal('window', undefined);
    const openURL = vi.fn();
    vi.stubGlobal('plus', { runtime: { openURL } });

    expect(pay.jumpToCashier('https://cashier.example/pay')).toBe(true);
    expect(openURL).toHaveBeenCalledWith('https://cashier.example/pay');
  });

  it('无 plus（H5）⇒ 赋值 location.href 并返回 true（现行为不变）', () => {
    const fake = fakeWindow('');
    vi.stubGlobal('window', fake);

    expect(pay.jumpToCashier('https://cashier.example/pay')).toBe(true);
    expect(fake.location.href).toBe('https://cashier.example/pay');
  });

  it('plus.runtime.openURL 抛错（唤起失败）⇒ false 且**不**落 H5 分支（调用方回落 §2.8 降级文案）', () => {
    const fake = fakeWindow('');
    vi.stubGlobal('window', fake);
    vi.stubGlobal('plus', {
      runtime: {
        openURL: () => {
          throw new Error('唤起失败');
        },
      },
    });

    expect(pay.jumpToCashier('https://cashier.example/pay')).toBe(false);
    expect(fake.location.href, 'App 分支失败也不回落到 location').toBe('');
  });

  it('无 window 且无 plus ⇒ false（小程序/纯 node：调用方显示 §2.8「请用浏览器打开完成支付」）', () => {
    vi.stubGlobal('window', undefined);
    expect(pay.jumpToCashier('https://cashier.example/pay')).toBe(false);
  });
});

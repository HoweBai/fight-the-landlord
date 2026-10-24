/**
 * 钱包页（支付片 T14；2026-10-23 拆分为 A1 布局 + 两个子页）。
 *
 * 判别矩阵（每条对着一种「最像正确答案」的错实现）：
 *  ① **A1 + 入口卡**：顶部横条（余额 + 双入口）· 充值/提现入口 ⊆ 各自开关 ·
 *     记录区全宽且不随开关隐藏 · 入口 `navigateTo` 目标与 `pages.json` 逐字一致；
 *  ② **共享摘要**：余额/可提额度来自摘要（未知显「—」不伪造 0）· 失败态跨页退场/重试出口 ·
 *     乱序与 reset 由 `wallet-summary.test.ts` 专测；
 *  ③ **记录失效**：提现子页成功 ⇒ 本页重取提现 tab（已加载过也要重取；在途不丢刷新；
 *     H5 重挂挂载首查）；
 *  ④ **记录区**：三 tab 懒加载；订单状态中文映射（待支付/处理中/已到账）；keyset 原样透传 +
 *     追加；14006/14007 **两条逐字**行内提示；失败 ⇒ 错误行（**不得**伪装成空态）；
 *  ⑤ **回跳 `?pay=`**：订单详情面板 + 轮询 **3s × 10**（终态即停；照发不重不漏）；窗耗尽
 *     ⇒「处理中」+「刷新」⇒ sync；到账刷余额与订单列表；载体保留到终态/关闭；卸载停表；
 *  ⑥ **钩子**：`wallet-recharge-entry` / `wallet-withdraw-entry` / `order-row-{orderNo}`
 *     （`pay-package-*` / `withdraw-*` 随 UI 移到两个子页测试）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WalletPage from '../src/pages/wallet/wallet.vue';
import * as payModule from '../src/net/pay';
import { useGameStore } from '../src/stores/game';
import { clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { stopGameSession } from '../src/composables/useGameSession';
import { installUniStub } from './helpers/uni-stub';
import { SRC_ROOT } from './helpers/source-scan';
import {
  countCalls,
  err,
  makeRoute,
  ok,
  orderFixture,
  refundFixture,
  summaryData,
  stubFetch,
  walletClientConfig,
  withdrawFixture,
  type FetchCall,
  type Responder,
} from './helpers/wallet-fixtures';

/** 部分替身：只换「跳收银台」与「读回跳 URL」（真实现分别动 `location.href` 与
 *  `location.search`，jsdom 里无法观察；两者的真实语义由 `wallet-pay.test.ts` ③④ 组
 *  用真 window 替身逐条覆盖）。 */
vi.mock('../src/net/pay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/net/pay')>();
  return { ...actual, jumpToCashier: vi.fn(() => true), consumePayReturnOrderNo: vi.fn(() => null) };
});

let pinia: ReturnType<typeof createPinia>;
let uniStub: ReturnType<typeof installUniStub>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  uniStub = installUniStub();
  localStorage.clear();
  clientConfig.token = '';
  // 支付片：两开关开 + 四数值给全（锚住「区块可见」态；关态的用例就地覆盖）。
  useGameStore().setClientConfig(walletClientConfig());
  // 跳收银台恢复缺省「有浏览器」（App 降级用例就地 Once 覆盖）。
  vi.mocked(payModule.jumpToCashier).mockReset();
  vi.mocked(payModule.jumpToCashier).mockReturnValue(true);
  // 回跳 URL 读取缺省「读不到」（直读 URL 的用例就地 Once 覆盖）。
  vi.mocked(payModule.consumePayReturnOrderNo).mockReset();
  vi.mocked(payModule.consumePayReturnOrderNo).mockReturnValue(null);
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mountWallet(route: Responder = makeRoute()) {
  const { calls } = stubFetch(route);
  const wrapper = mount(WalletPage, { global: { plugins: [pinia] } });
  return { wrapper, calls };
}

// ---------------------------------------------------------------------------
// ⓪ G3 浮层挂载闸（Task 7）
// ---------------------------------------------------------------------------

describe('⓪ 提示浮层化（G3）', () => {
  it('冒烟：NoticeStack 挂载且无 .wallet__error（逐类断言由迁移用例承担）', async () => {
    const wrapper = mount(WalletPage, { global: { plugins: [pinia] } });
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
    await flushPromises();
    expect(wrapper.find('.wallet__error').exists()).toBe(false);
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ① A1 布局 + 入口卡 + 开关隐藏
// ---------------------------------------------------------------------------

describe('① A1 布局 + 入口卡 + 开关隐藏（2026-10-23 拆分）', () => {
  it('顶部横条：余额/可提额度来自摘要 + 两张入口卡 + 记录区（全宽）', async () => {
    const { wrapper } = mountWallet();
    await flushPromises();

    expect(wrapper.find('.wallet__top').exists(), '顶部横条').toBe(true);
    expect(wrapper.find('.wallet__balance').exists(), '余额区恒在').toBe(true);
    expect(wrapper.find('.wallet-recharge-entry').exists()).toBe(true);
    expect(wrapper.find('.wallet-withdraw-entry').exists()).toBe(true);
    expect(wrapper.find('.wallet__records').exists()).toBe(true);
    expect(wrapper.find('.wallet__left').exists(), '旧左列已删').toBe(false);
    expect(wrapper.find('.wallet__balance .chip__currency').text()).toBe('4200');
    expect(wrapper.find('.wallet__withdrawable').text()).toContain('3000');
    expect(useGameStore().walletBalance, '摘要余额同步回 store（大厅 chip 共用）').toBe(4200);
    expect(wrapper.find('.wallet__error').exists()).toBe(false);
    expect(wrapper.find('[data-notice-id="summary"]').exists()).toBe(false);
    expect(wrapper.find('[data-notice-id="list-orders"]').exists()).toBe(false);
  });

  it('点入口卡 ⇒ navigateTo 子页；URL 与 pages.json 声明逐字一致', async () => {
    const { wrapper } = mountWallet();
    await flushPromises();

    await wrapper.find('.wallet-recharge-entry').trigger('click');
    await wrapper.find('.wallet-withdraw-entry').trigger('click');
    expect(uniStub.calls.navigateTo).toEqual([
      '/pages/wallet/recharge',
      '/pages/wallet/withdraw',
    ]);

    const pagesJson = JSON.parse(readFileSync(join(SRC_ROOT, 'pages.json'), 'utf8')) as {
      subPackages: { root: string; pages: { path: string }[] }[];
    };
    const declared = pagesJson.subPackages.flatMap((sp) =>
      sp.pages.map((p) => `/${sp.root}/${p.path}`),
    );
    for (const url of uniStub.calls.navigateTo) {
      expect(declared, `${url} 必须在 pages.json 声明`).toContain(url);
    }
  });

  it('开关分别隐藏入口卡；两开关全关 ⇒ 页面不空（余额/记录仍在）', async () => {
    const store = useGameStore();
    store.setClientConfig(walletClientConfig({ rechargeEnabled: false }));
    const first = mountWallet();
    await flushPromises();
    expect(first.wrapper.find('.wallet-recharge-entry').exists(), '充值入口隐藏').toBe(false);
    expect(first.wrapper.find('.wallet-withdraw-entry').exists(), '提现入口不受牵连').toBe(true);

    store.setClientConfig(walletClientConfig({ withdrawEnabled: false }));
    const second = mountWallet();
    await flushPromises();
    expect(second.wrapper.find('.wallet-withdraw-entry').exists(), '提现入口隐藏').toBe(false);
    expect(second.wrapper.find('.wallet-recharge-entry').exists(), '充值入口不受牵连').toBe(true);

    store.setClientConfig(walletClientConfig({ rechargeEnabled: false, withdrawEnabled: false }));
    const third = mountWallet();
    await flushPromises();
    expect(third.wrapper.find('.wallet-recharge-entry').exists()).toBe(false);
    expect(third.wrapper.find('.wallet-withdraw-entry').exists()).toBe(false);
    expect(third.wrapper.find('.wallet__balance').exists(), '余额区不随开关隐藏').toBe(true);
    expect(third.wrapper.find('.wallet__records').exists(), '记录区不随开关隐藏').toBe(true);
  });

  it('summary 失败 ⇒ 显「—」+ 静态失败态 + 浮层错误项（**不伪造 0**；不打断其余区块）', async () => {
    const { wrapper } = mountWallet(makeRoute({ summary: () => err(10007, '下游不可用') }));
    await flushPromises();

    expect(wrapper.find('.wallet__balance .chip__currency').text()).toBe('—');
    expect(wrapper.find('[data-notice-id="summary"] .notice__text').text()).toContain(
      '服务暂时不可用，请稍后重试',
    );
    expect(
      wrapper.find('[data-notice-id="summary"] .notice__action').text(),
      '失败项带「重试」出口',
    ).toContain('重试');
    expect(wrapper.find('.wallet__balance .wallet__failure').text()).toBe('钱包信息暂不可用');
    expect(wrapper.find('.wallet__error').exists(), '内联错误行已退役').toBe(false);
    expect(wrapper.find('.wallet-recharge-entry').exists(), '摘要失败不牵连入口渲染').toBe(true);
    expect(useGameStore().walletBalance, '失败不写 store（不擦掉大厅已有的真值）').toBeNull();
  });

  it('summary 重试成功 ⇒ 浮层 `summary` 项与静态失败态一起退场（sticky 不得滞留）', async () => {
    let summaryLoads = 0;
    const { wrapper } = mountWallet(
      makeRoute({
        summary: () => {
          summaryLoads += 1;
          return summaryLoads === 1 ? err(10007, '下游不可用') : ok(summaryData());
        },
      }),
    );
    await flushPromises();
    expect(wrapper.find('[data-notice-id="summary"]').exists()).toBe(true);
    expect(wrapper.find('.wallet__balance .wallet__failure').exists()).toBe(true);

    await wrapper.find('[data-notice-id="summary"] .notice__action').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-notice-id="summary"]').exists(), '成功 ⇒ dismiss(summary)').toBe(false);
    expect(wrapper.find('.wallet__balance .wallet__failure').exists()).toBe(false);
    expect(wrapper.find('.wallet__balance .chip__currency').text()).toBe('4200');
  });

  it('跨页失败态：另一处取数成功 ⇒ 本页失败行与 sticky 项退场', async () => {
    const { wrapper } = mountWallet(makeRoute({ summary: () => err(10007, '下游不可用') }));
    await flushPromises();
    expect(wrapper.find('.wallet__balance .wallet__failure').exists()).toBe(true);
    expect(wrapper.find('[data-notice-id="summary"]').exists()).toBe(true);

    const store = useGameStore();
    store.applyWalletSummary(
      { balance: 4200, withdrawable: 3000, dailyWithdrawRemainingCoins: 95000 },
      store.beginWalletSummaryRequest(),
    );
    await flushPromises();

    expect(wrapper.find('.wallet__balance .wallet__failure').exists(), '共享错误清空 ⇒ 失败行退场').toBe(false);
    expect(wrapper.find('[data-notice-id="summary"]').exists(), 'sticky 项同步退场').toBe(false);
    expect(wrapper.find('.wallet__balance .chip__currency').text()).toBe('4200');
  });

  it('已看过的提现列表：置标记 ⇒ 不切 tab 也重取（B1 回归）', async () => {
    let withdrawalLoads = 0;
    const { wrapper, calls } = mountWallet(
      makeRoute({
        withdrawalsMine: () => {
          withdrawalLoads += 1;
          return ok({
            items: [withdrawFixture({ withdrawNo: `wd_${withdrawalLoads}` })],
            nextCursor: null,
          });
        },
      }),
    );
    await flushPromises();

    // 先看一次提现 tab（`loaded=true`），再切回订单。
    await wrapper.findAll('.wallet__tab')[2]!.trigger('click');
    await flushPromises();
    expect(countCalls(calls, '/pay/withdrawals/mine')).toBe(1);
    await wrapper.findAll('.wallet__tab')[0]!.trigger('click');
    await flushPromises();

    useGameStore().walletRecordsStale = true;
    await flushPromises();

    // 关键：`selectTab` 的懒加载不会再请求 ⇒ 必须由标记消费强制重取。
    expect(countCalls(calls, '/pay/withdrawals/mine'), '已加载过的提现列表必须重取').toBe(2);
    expect(wrapper.find('.wallet__tab--active').text(), '不得把用户切到别的 tab').toBe('订单');
    expect(useGameStore().walletRecordsStale, '标记被消费').toBe(false);

    // 再切回提现：直接用重取后的数据（不新增请求）。
    await wrapper.findAll('.wallet__tab')[2]!.trigger('click');
    await flushPromises();
    expect(countCalls(calls, '/pay/withdrawals/mine')).toBe(2);
    expect(wrapper.text()).toContain('wd_2');
  });

  it('H5 重挂形态：挂载时消费失效标记', async () => {
    useGameStore().walletRecordsStale = true;
    const { calls } = mountWallet();
    await flushPromises();

    expect(countCalls(calls, '/pay/withdrawals/mine'), '挂载首查也要重取').toBe(1);
    expect(useGameStore().walletRecordsStale).toBe(false);
  });

  it('提现列表加载中置标记 ⇒ finally 之后补一次重取（不丢刷新）', async () => {
    let release: (() => void) | null = null;
    const calls: FetchCall[] = [];
    const route = makeRoute();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const respond = () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(route({ url, init }, calls.length - 1)),
        });
        if (url.includes('/pay/withdrawals/mine')) {
          return new Promise((resolve) => {
            release = () => resolve(respond());
          });
        }
        return Promise.resolve(respond());
      }),
    );
    const wrapper = mount(WalletPage, { global: { plugins: [pinia] } });
    await flushPromises();

    // 切到提现 tab：第一发挂起。
    await wrapper.findAll('.wallet__tab')[2]!.trigger('click');
    await flushPromises();
    expect(countCalls(calls, '/pay/withdrawals/mine')).toBe(1);

    // 在途期间收到失效标记 ⇒ 不得丢刷新。
    useGameStore().walletRecordsStale = true;
    await flushPromises();
    expect(countCalls(calls, '/pay/withdrawals/mine')).toBe(1);

    release!();
    await flushPromises();
    await flushPromises();
    expect(countCalls(calls, '/pay/withdrawals/mine'), 'finally 后补发').toBe(2);
    expect(useGameStore().walletRecordsStale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ④ 记录区
// ---------------------------------------------------------------------------

describe('④ 记录区：三 tab 懒加载 / 状态映射 / keyset / 14006-14007', () => {
  it('默认订单 tab：行渲染 + order-row-{orderNo} 钩子 + 三态中文映射逐字', async () => {
    const { wrapper, calls } = mountWallet(
      makeRoute({
        ordersMine: () =>
          ok({
            items: [
              orderFixture({ orderNo: 'pay_a', status: 'created' }),
              orderFixture({ orderNo: 'pay_b', status: 'paid' }),
              orderFixture({ orderNo: 'pay_c', status: 'credited' }),
            ],
            nextCursor: null,
          }),
      }),
    );
    await flushPromises();

    expect(countCalls(calls, '/pay/refunds/mine'), '其余 tab 懒加载（挂载时不发）').toBe(0);
    expect(countCalls(calls, '/pay/withdrawals/mine')).toBe(0);
    expect(wrapper.find('.order-row-pay_a').exists(), '测试钩子（规格 §4 逐字）').toBe(true);
    expect(wrapper.find('.order-row-pay_b').exists()).toBe(true);
    expect(wrapper.find('.order-row-pay_c').exists()).toBe(true);
    const rows = wrapper.findAll('.wallet__row');
    expect(rows[0]!.text()).toContain('待支付');
    expect(rows[1]!.text()).toContain('处理中');
    expect(rows[2]!.text()).toContain('已到账');
    expect(rows[0]!.text()).toContain('600 金币');
    expect(rows[0]!.text()).toContain('6.00 元');
    expect(rows[0]!.text()).toContain('pay_a');
  });

  it('切 tab 才加载对应端点；退款行渲染状态中文', async () => {
    const { wrapper, calls } = mountWallet(
      makeRoute({
        refundsMine: () =>
          ok({ items: [refundFixture({ status: 'refunded', refundNo: 'rf_z' })], nextCursor: null }),
      }),
    );
    await flushPromises();

    const tabs = wrapper.findAll('.wallet__tab');
    expect(tabs.map((t) => t.text())).toEqual(['订单', '退款', '提现']);
    await tabs[1]!.trigger('click');
    await flushPromises();

    expect(countCalls(calls, '/pay/refunds/mine')).toBe(1);
    const row = wrapper.find('.wallet__row');
    expect(row.text()).toContain('已退款');
    expect(row.text()).toContain('rf_z');
  });

  it('提现 tab：14006/14007 **两条逐字**行内提示（rolling_back / timeout_rolled_back）', async () => {
    const { wrapper } = mountWallet(
      makeRoute({
        withdrawalsMine: () =>
          ok({
            items: [
              withdrawFixture({ withdrawNo: 'wd_a', status: 'rolling_back' }),
              withdrawFixture({ withdrawNo: 'wd_b', status: 'timeout_rolled_back' }),
              withdrawFixture({ withdrawNo: 'wd_c', status: 'pending' }),
            ],
            nextCursor: null,
          }),
      }),
    );
    await flushPromises();

    await wrapper.findAll('.wallet__tab')[2]!.trigger('click');
    await flushPromises();

    const notes = wrapper.findAll('.wallet__row-note').map((n) => n.text());
    expect(notes, '14006/14007 两条文案逐字（§2.8）').toEqual([
      '申请已超时，金币已退回',
      '超时自动退回，金币已到账',
    ]);
    const rows = wrapper.findAll('.wallet__row');
    expect(rows[0]!.text()).toContain('退回中');
    expect(rows[1]!.text()).toContain('已超时退回');
    expect(rows[2]!.text()).toContain('审核中');
    expect(rows[2]!.find('.wallet__row-note').exists(), '正常态行不得带超时提示').toBe(false);
  });

  it('keyset：cursor 原样透传（含保留字符）+ 追加不替换 + 终页后不再发', async () => {
    /** ⚠️ 计数必须按**本端点**的调用序（`Responder` 的第二参是全局 fetch 序号——
     * 用它当「第几页」会在 summary 先发时错位，正是本用例第一版咬到的坑）。 */
    let ordersLoads = 0;
    const { wrapper, calls } = mountWallet(
      makeRoute({
        ordersMine: () => {
          ordersLoads += 1;
          return ordersLoads === 1
            ? ok({ items: [orderFixture({ orderNo: 'pay_a' })], nextCursor: 'cur 1+2' })
            : ok({ items: [orderFixture({ orderNo: 'pay_b' })], nextCursor: null });
        },
      }),
    );
    await flushPromises();

    await wrapper.find('.wallet__list').trigger('scrolltolower');
    await flushPromises();

    const second = calls.filter((c) => c.url.includes('/pay/orders/mine'))[1];
    expect(second!.url).toContain(`cursor=${encodeURIComponent('cur 1+2')}`);
    expect(wrapper.find('.order-row-pay_a').exists(), '追加不替换').toBe(true);
    expect(wrapper.find('.order-row-pay_b').exists()).toBe(true);

    await wrapper.find('.wallet__list').trigger('scrolltolower');
    await flushPromises();
    expect(countCalls(calls, '/pay/orders/mine'), '终页后不得再发').toBe(2);
  });

  it('列表失败 ⇒ 静态失败态 + 浮层错误项（**不得**伪装成「暂无记录」）', async () => {
    const { wrapper } = mountWallet(makeRoute({ ordersMine: () => err(10007, '下游不可用') }));
    await flushPromises();

    // Task 7：10007 是 FIXED 码 —— 固定文案，服务端措辞不透传。
    expect(wrapper.find('[data-notice-id="list-orders"] .notice__text').text()).toContain(
      '服务暂时不可用，请稍后重试',
    );
    expect(
      wrapper.find('[data-notice-id="list-orders"] .notice__action').text(),
      '失败项带「重试」出口',
    ).toContain('重试');
    expect(wrapper.find('.wallet__records .wallet__failure').text()).toBe('记录加载失败');
    expect(wrapper.find('.wallet__error').exists(), '内联错误行已退役').toBe(false);
    expect(wrapper.find('.wallet__records .wallet__muted').exists(), '失败不得同时显示空态').toBe(false);
  });

  it('列表重试成功 ⇒ 浮层 `list-orders` 项与静态失败态退场 + 列表渲染（sticky 不得滞留）', async () => {
    let orderLoads = 0;
    const { wrapper } = mountWallet(
      makeRoute({
        ordersMine: () => {
          orderLoads += 1;
          return orderLoads === 1
            ? err(10007, '下游不可用')
            : ok({ items: [orderFixture({ orderNo: 'pay_a' })], nextCursor: null });
        },
      }),
    );
    await flushPromises();
    expect(wrapper.find('[data-notice-id="list-orders"]').exists()).toBe(true);
    expect(wrapper.find('.wallet__records .wallet__failure').exists()).toBe(true);

    await wrapper.find('[data-notice-id="list-orders"] .notice__action').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-notice-id="list-orders"]').exists(), '成功 ⇒ dismiss(list-orders)').toBe(
      false,
    );
    expect(wrapper.find('.wallet__records .wallet__failure').exists()).toBe(false);
    expect(wrapper.find('.order-row-pay_a').exists()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 回跳 ?pay=（fake timers：轮询 3s × 10）
// ---------------------------------------------------------------------------

describe('⑤ 回跳 ?pay=：详情面板 + 轮询 3s×10 + 手动刷新', () => {
  /** 记录是否在 fake timers 下（mount 后的冲洗方式不同）。 */
  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
  }

  it('载体单号 ⇒ 面板 + 首查立即 + 载体保留到终态；每 3s 一发、恰 10 发后「处理中」+「刷新」', async () => {
    vi.useFakeTimers();
    useGameStore().setWalletReturnOrderNo('pay_r1');
    const { wrapper, calls } = mountWallet(makeRoute({ orderDetail: () => ok(orderFixture({ orderNo: 'pay_r1', status: 'paid' })) }));
    await settle();

    expect(wrapper.find('.wallet__return').exists(), '回跳面板出现').toBe(true);
    expect(wrapper.find('.wallet__return-no').text()).toBe('pay_r1');
    expect(useGameStore().walletReturnOrderNo, '载体保留到终态/关闭（H5 重挂可重启轮询）').toBe(
      'pay_r1',
    );
    expect(countCalls(calls, '/pay/orders/pay_r1'), '首查立即（t=0）').toBe(1);

    await vi.advanceTimersByTimeAsync(3000 * 9); // t=3s..27s 共 9 个 tick
    expect(countCalls(calls, '/pay/orders/pay_r1'), '3s × 10 恰 10 发（首查 + 9 tick）').toBe(10);

    expect(wrapper.find('.wallet__return-hint').text(), '窗耗尽 ⇒「处理中」').toBe('处理中');
    const refresh = wrapper.find('.wallet__return-refresh');
    expect(refresh.exists(), '刷新按钮出现（手动 ⇒ sync）').toBe(true);
    expect(wrapper.find('.wallet__return-status').text()).toContain('处理中');

    await vi.advanceTimersByTimeAsync(30000);
    expect(countCalls(calls, '/pay/orders/pay_r1'), '停表：不再继续发').toBe(10);
  });

  it('终态即停：第 3 发到账 ⇒ 面板「已到账」+ 摘要/订单列表重取，之后不再轮询', async () => {
    vi.useFakeTimers();
    useGameStore().setWalletReturnOrderNo('pay_r2');
    /** 按**详情端点**的调用序给状态（第 3 发转 credited）。 */
    let detailLoads = 0;
    const { wrapper, calls } = mountWallet(
      makeRoute({
        orderDetail: () => {
          detailLoads += 1;
          return ok(
            orderFixture({ orderNo: 'pay_r2', status: detailLoads >= 3 ? 'credited' : 'paid' }),
          );
        },
      }),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(3000); // 第 2 发
    await vi.advanceTimersByTimeAsync(3000); // 第 3 发 ⇒ credited

    expect(countCalls(calls, '/pay/orders/pay_r2')).toBe(3);
    expect(wrapper.find('.wallet__return-status').text()).toContain('已到账');
    expect(wrapper.find('.wallet__return-hint').exists(), '终态后不再显示「自动查询中」/「处理中」' ).toBe(false);
    expect(useGameStore().walletReturnOrderNo, '终态 ⇒ 载体退役').toBeNull();
    expect(countCalls(calls, '/pay/wallet/summary'), '到账 ⇒ 余额重取').toBe(2);
    expect(countCalls(calls, '/pay/orders/mine'), '到账 ⇒ 订单列表重取').toBe(2);

    await vi.advanceTimersByTimeAsync(30000);
    expect(countCalls(calls, '/pay/orders/pay_r2'), '终态停表').toBe(3);
  });

  it('closed 也是终态（停表 + 「已关闭」）', async () => {
    vi.useFakeTimers();
    useGameStore().setWalletReturnOrderNo('pay_r3');
    const { wrapper, calls } = mountWallet(
      makeRoute({ orderDetail: () => ok(orderFixture({ orderNo: 'pay_r3', status: 'closed' })) }),
    );
    await settle();

    expect(wrapper.find('.wallet__return-status').text()).toContain('已关闭');
    expect(useGameStore().walletReturnOrderNo, 'closed 也是终态 ⇒ 载体退役').toBeNull();
    await vi.advanceTimersByTimeAsync(30000);
    expect(countCalls(calls, '/pay/orders/pay_r3'), '终态停表').toBe(1);
  });

  it('手动刷新 ⇒ POST :orderNo/sync；仍非终态 ⇒ 保持「处理中」手动面', async () => {
    vi.useFakeTimers();
    useGameStore().setWalletReturnOrderNo('pay_r4');
    const { wrapper, calls } = mountWallet(
      makeRoute({
        orderDetail: () => ok(orderFixture({ orderNo: 'pay_r4', status: 'paid' })),
        syncOrder: () => ok(orderFixture({ orderNo: 'pay_r4', status: 'paid' })),
      }),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(3000 * 9); // 耗尽

    await wrapper.find('.wallet__return-refresh').trigger('click');
    await settle();

    const sync = calls.find((c) => c.url.endsWith('/pay/orders/pay_r4/sync'));
    expect(sync, '刷新 = sync（主动查询补单）').toBeDefined();
    expect(sync!.init?.method).toBe('POST');
    expect(wrapper.find('.wallet__return-hint').text(), '仍未终态 ⇒ 保持手动面').toBe('处理中');
  });

  it('负对照：无载体 ⇒ 无面板、无额外详情请求', async () => {
    const { wrapper, calls } = mountWallet();
    await flushPromises();

    expect(wrapper.find('.wallet__return').exists()).toBe(false);
    // 「详情」= `/pay/orders/:no` 且**不是** `mine`（`mine` 也会命中 `[^/]+$`——第一版断言咬到的坑）。
    expect(
      calls.some((c) => /\/pay\/orders\/[^/]+$/.test(c.url) && !c.url.includes('/mine')),
    ).toBe(false);
  });

  it('直读 URL（读到 ?pay=）⇒ 同一流程（覆盖「已在钱包页刷新」形态）', async () => {
    vi.mocked(payModule.consumePayReturnOrderNo).mockReturnValueOnce('pay_url_1');
    const { wrapper } = mountWallet(
      makeRoute({ orderDetail: () => ok(orderFixture({ orderNo: 'pay_url_1', status: 'credited' })) }),
    );
    await flushPromises();

    expect(wrapper.find('.wallet__return-no').text()).toBe('pay_url_1');
    expect(wrapper.find('.wallet__return-status').text()).toContain('已到账');
  });

  it('卸载停表（窗未耗尽也不得再发——定时器泄漏就是「离开页面后还在打接口」）', async () => {
    vi.useFakeTimers();
    useGameStore().setWalletReturnOrderNo('pay_r5');
    const { wrapper, calls } = mountWallet(
      makeRoute({ orderDetail: () => ok(orderFixture({ orderNo: 'pay_r5', status: 'paid' })) }),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(countCalls(calls, '/pay/orders/pay_r5')).toBe(2);

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(30000);
    expect(countCalls(calls, '/pay/orders/pay_r5'), '卸载后定时器必须已清').toBe(2);
  });
});

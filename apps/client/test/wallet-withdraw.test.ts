/**
 * 提现子页（2026-10-23 钱包拆分）：从钱包页搬出的「③ 提现 / ③-B 再认证」用例 + 子页判据。
 *
 * 判别矩阵：
 *  · 数据卡（可提额度 / 当日剩余）与说明卡（门槛 / 单笔 / 单日）数值全部来自服务端；
 *    `summary=null` ⇒ 数据卡「—」（不回落 0）、`null` 说明卡不渲染；
 *  · 五项本地预检先于任何请求；再认证失败不提交；服务端文案逐字；
 *  · 成功 ⇒ 摘要重取 + `walletRecordsStale=true`（提现列表由钱包页重取）；
 *  · 开关关闭守卫；输入与按钮等高走源码级规则体（jsdom 无布局）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WithdrawPage from '../src/pages/wallet/withdraw.vue';
import { useGameStore } from '../src/stores/game';
import { stopGameSession } from '../src/composables/useGameSession';
import { installUniStub } from './helpers/uni-stub';
import { SRC_ROOT } from './helpers/source-scan';
import {
  countCalls,
  err,
  makeRoute,
  ok,
  summaryData,
  walletClientConfig,
  type FetchCall,
} from './helpers/wallet-fixtures';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  useGameStore().setClientConfig(walletClientConfig());
});

afterEach(() => {
  stopGameSession();
  vi.restoreAllMocks();
});

function mountWithdraw(route = makeRoute()) {
  const { calls } = stubRoute(route);
  const wrapper = mount(WithdrawPage, { global: { plugins: [pinia] } });
  return { wrapper, calls };
}

/** 本文件不 mock `net/pay`：提现走真 `applyPayWithdrawal` + fetch 桩。 */
function stubRoute(route: ReturnType<typeof makeRoute>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(route({ url, init }, calls.length - 1)) };
    }),
  );
  return { calls };
}

describe('① 提现子页：数据卡 / 说明卡 / 开关守卫', () => {
  it('数值全部来自服务端：可提额度、当日剩余、门槛、单笔、单日', async () => {
    const { wrapper } = mountWithdraw();
    await flushPromises();

    const text = wrapper.text().replace(/\s+/g, ' ');
    expect(text).toContain('可提额度');
    expect(text).toContain('3000');
    expect(text).toContain('当日剩余');
    expect(text).toContain('95000');
    expect(text).toContain('门槛');
    expect(text).toContain('1000');
    expect(text).toContain('单笔上限');
    expect(text).toContain('50000');
    expect(text).toContain('单日上限');
    expect(text).toContain('100000');
    expect(
      wrapper.find('.withdraw-input').attributes('placeholder'),
      '占位 = 门槛（§4 逐字）',
    ).toBe('1000');
  });

  it('summary=null ⇒ 数据卡显「—」（不回落 0）+ 静态失败行；说明卡仍来自配置', async () => {
    const { wrapper } = mountWithdraw(makeRoute({ summary: () => err(10007, '下游不可用') }));
    await flushPromises();

    const stats = wrapper.findAll('.wallet-withdraw__stat');
    expect(stats.map((s) => s.text().replace(/\s+/g, ' ').trim())).toEqual([
      '可提额度—',
      '当日剩余—',
    ]);
    expect(wrapper.find('.wallet-withdraw__failure').text()).toBe('钱包信息暂不可用');
    expect(wrapper.find('[data-notice-id="summary"] .notice__action').text()).toContain('重试');
    expect(wrapper.text()).toContain('门槛');
  });

  it('开关关闭 ⇒「提现暂未开放」，不渲染输入、不发摘要请求', async () => {
    useGameStore().setClientConfig(walletClientConfig({ withdrawEnabled: false }));
    const { wrapper, calls } = mountWithdraw();
    await flushPromises();

    expect(wrapper.find('.withdraw-input').exists()).toBe(false);
    expect(wrapper.find('.withdraw-submit').exists()).toBe(false);
    expect(wrapper.text()).toContain('提现暂未开放');
    expect(countCalls(calls, '/pay/wallet/summary')).toBe(0);
  });

  it('summary=null 不阻断提交（服务端锁内校验是唯一权威）', async () => {
    const { wrapper, calls } = mountWithdraw(makeRoute({ summary: () => err(10007, '下游不可用') }));
    await flushPromises();

    expect(wrapper.find('.wallet-withdraw__submit').attributes('disabled')).toBeUndefined();
    await wrapper.find('.withdraw-input').setValue('2000');
    await wrapper.find('.withdraw-submit').trigger('click');
    await flushPromises();

    expect(
      calls.some((c) => c.url.endsWith('/pay/withdrawals') && c.init?.method === 'POST'),
      'summary 未知 ⇒ 预检跳过、照常提交',
    ).toBe(true);
  });

  it('三项限额全 null ⇒ 说明卡全不渲染、预检不误拒', async () => {
    useGameStore().setClientConfig(
      walletClientConfig({
        withdrawMinCoins: null,
        withdrawMaxCoinsPerOrder: null,
        withdrawDailyMaxCoins: null,
      }),
    );
    const { wrapper, calls } = mountWithdraw();
    await flushPromises();

    expect(wrapper.findAll('.wallet-withdraw__limit')).toHaveLength(0);
    await wrapper.find('.withdraw-input').setValue('1');
    await wrapper.find('.withdraw-submit').trigger('click');
    await flushPromises();
    expect(
      calls.some((c) => c.url.endsWith('/pay/withdrawals') && c.init?.method === 'POST'),
      '没有配置门槛时不得本地误拒',
    ).toBe(true);
  });

  it('共享错误：另一处成功取数 ⇒ 本页错误项退场；后台失败 ⇒ 本页有重试出口', async () => {
    const { wrapper } = mountWithdraw(makeRoute({ summary: () => err(10007, '下游不可用') }));
    await flushPromises();
    expect(wrapper.find('[data-notice-id="summary"]').exists()).toBe(true);

    const store = useGameStore();
    store.applyWalletSummary(
      { balance: 4200, withdrawable: 3000, dailyWithdrawRemainingCoins: 95000 },
      store.beginWalletSummaryRequest(),
    );
    await flushPromises();
    expect(wrapper.find('[data-notice-id="summary"]').exists(), '成功在别处发生 ⇒ 本页退场').toBe(
      false,
    );
    expect(wrapper.find('.wallet-withdraw__failure').exists()).toBe(false);

    // 反向：后台页失败（本页不发起请求）⇒ 本页也要给出重试出口。
    store.setWalletSummaryError('服务暂时不可用，请稍后重试', store.beginWalletSummaryRequest());
    await flushPromises();
    expect(wrapper.find('[data-notice-id="summary"] .notice__text').text()).toContain(
      '服务暂时不可用',
    );
    expect(wrapper.find('[data-notice-id="summary"] .notice__action').text()).toContain('重试');
  });

  it('输入与提交按钮等高（源码级：两规则体都取 $ftl-control-h）', () => {
    const src = readFileSync(join(SRC_ROOT, 'pages/wallet/withdraw.vue'), 'utf8');
    const inputRule = /\.wallet-withdraw__input\s*\{[^}]*\}/.exec(src)?.[0];
    const submitRule = /\.wallet-withdraw__submit\s*\{[^}]*\}/.exec(src)?.[0];
    expect(inputRule, '`.wallet-withdraw__input` 规则体必须存在').toBeDefined();
    expect(submitRule, '`.wallet-withdraw__submit` 规则体必须存在').toBeDefined();
    expect(inputRule, '输入高度').toContain('$ftl-control-h');
    expect(submitRule, '按钮高度').toContain('$ftl-control-h');
  });
});

describe('② 提现：本地预检五项 + 提交', () => {
  async function trySubmit(value: string) {
    const mounted = mountWithdraw();
    await flushPromises();
    await mounted.wrapper.find('.withdraw-input').setValue(value);
    await mounted.wrapper.find('.withdraw-submit').trigger('click');
    await flushPromises();
    return mounted;
  }

  it('预检 1：非整数 ⇒ 就地拒绝（先于任何请求）', async () => {
    const { wrapper, calls } = await trySubmit('1.5');
    expect(wrapper.find('[data-notice-id="withdraw"] .notice__text').text()).toContain('整数');
    expect(countCalls(calls, '/pay/withdrawals'), '预检不过不得发请求').toBe(0);
  });

  it('预检 2：低于门槛（min）⇒ 就地拒绝', async () => {
    const { wrapper, calls } = await trySubmit('500');
    expect(wrapper.find('[data-notice-id="withdraw"] .notice__text').text()).toContain(
      '不能低于门槛 1000',
    );
    expect(countCalls(calls, '/pay/withdrawals')).toBe(0);
  });

  it('预检 3：超过单笔上限（max）⇒ 就地拒绝', async () => {
    const { wrapper } = await trySubmit('60000');
    expect(wrapper.find('[data-notice-id="withdraw"] .notice__text').text()).toContain(
      '不能超过单笔上限 50000',
    );
  });

  it('预检 4：超过当日剩余 ⇒ 就地拒绝（当日剩余是 summary 的实算值）', async () => {
    const mounted = mountWithdraw(
      makeRoute({ summary: () => ok(summaryData({ dailyWithdrawRemainingCoins: 4000 })) }),
    );
    await flushPromises();
    await mounted.wrapper.find('.withdraw-input').setValue('4500');
    await mounted.wrapper.find('.withdraw-submit').trigger('click');
    await flushPromises();

    expect(mounted.wrapper.find('[data-notice-id="withdraw"] .notice__text').text()).toContain(
      '不能超过当日剩余可申额度 4000',
    );
    expect(countCalls(mounted.calls, '/pay/withdrawals')).toBe(0);
  });

  it('预检 5：超过可提额度（cap）⇒ 就地拒绝', async () => {
    const mounted = mountWithdraw(
      makeRoute({ summary: () => ok(summaryData({ withdrawable: 3000 })) }),
    );
    await flushPromises();
    await mounted.wrapper.find('.withdraw-input').setValue('4000');
    await mounted.wrapper.find('.withdraw-submit').trigger('click');
    await flushPromises();

    expect(mounted.wrapper.find('[data-notice-id="withdraw"] .notice__text').text()).toContain(
      '不能超过可提额度 3000',
    );
    expect(countCalls(mounted.calls, '/pay/withdrawals')).toBe(0);
  });

  it('合法提交 ⇒ POST {coins} + 浮层成功项 + 静态状态行 + 输入清空 + 摘要重取 + 置记录失效标记', async () => {
    const { wrapper, calls } = await trySubmit('2000');

    const apply = calls.find((c) => c.url.endsWith('/pay/withdrawals') && c.init?.method === 'POST');
    expect(apply, '必须真的提交').toBeDefined();
    expect(JSON.parse(String(apply!.init?.body))).toEqual({ coins: 2000 });
    const stackText = wrapper.find('[data-notice-id="withdraw-result"] .notice__text');
    expect(stackText.text()).toContain('申请已提交：审核中');
    expect(stackText.text()).toContain('wd_new');
    const staticText = wrapper.find('.wallet-withdraw__result');
    expect(staticText.exists(), '静态状态行').toBe(true);
    expect(staticText.text()).toContain('申请已提交：审核中');
    expect(staticText.text()).toContain('wd_new');
    expect((wrapper.find('.withdraw-input').element as HTMLInputElement).value).toBe('');
    expect(countCalls(calls, '/pay/wallet/summary'), '摘要重取（余额/cap/日限都变了）').toBe(2);
    expect(
      useGameStore().walletRecordsStale,
      '提现列表由钱包页消费标记后重取（子页不直接拉列表）',
    ).toBe(true);
    expect(countCalls(calls, '/pay/withdrawals/mine'), '本页不拉提现列表').toBe(0);
  });

  it('提交失败（15005）⇒ 服务端 message 逐字（§2.8「可提余额不足」）', async () => {
    const { wrapper } = mountWithdraw(makeRoute({ applyWithdraw: () => err(15005, '可提余额不足') }));
    await flushPromises();
    await wrapper.find('.withdraw-input').setValue('2000');
    await wrapper.find('.withdraw-submit').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-notice-id="withdraw"] .notice__text').text()).toBe('可提余额不足');
    expect(wrapper.find('.wallet-withdraw__result').exists(), '失败不得出现成功状态行').toBe(false);
  });
});

describe('③ 提现再认证', () => {
  it('reauth 失败（11002）⇒ 浮层 `withdraw` 项取服务端 message + 不提交提现申请', async () => {
    const uniStub = installUniStub();
    useGameStore().setClientConfig(walletClientConfig({ withdrawReAuthEnabled: true }));
    const { wrapper, calls } = mountWithdraw(makeRoute({ reauth: () => err(11002, '密码错误') }));
    await flushPromises();

    await wrapper.find('.withdraw-input').setValue('2000');
    await wrapper.find('.withdraw-submit').trigger('click');
    await flushPromises();

    expect(uniStub.calls.showModal, '开关开 ⇒ 必弹一次密码框').toHaveLength(1);
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();

    // 11002 是 message-first 码：服务端 message 逐字进浮层 `withdraw` 项（无自动重放）。
    expect(wrapper.find('[data-notice-id="withdraw"] .notice__text').text()).toBe('密码错误');
    expect(countCalls(calls, '/pay/withdrawals'), 'reauth 不过不得提交').toBe(0);
    expect(uniStub.calls.showModal, '不得为 reauth 失败自动重弹密码框').toHaveLength(1);
  });
});

/**
 * P1-5：再认证期间的**按钮闸门**与网络异常。
 *
 * 旧实现把 `withdrawBusy = true` 放在 reauth 之后 ⇒ 密码框未决期间按钮仍可点：
 * 双击会弹两次密码框、发两次 reauth、最终提交两笔；而 reauth 的 fetch 异常没人接
 *（`reauth()` 抛错，与 11002 的响应分支不同）⇒ 无提示、无复位。
 */
describe('P1-5：再认证的双击与网络异常', () => {
  it('双击提交（密码框未决期间）⇒ 只弹一次密码框、只发一笔提现', async () => {
    const uniStub = installUniStub();
    useGameStore().setClientConfig(walletClientConfig({ withdrawReAuthEnabled: true }));
    const { wrapper, calls } = mountWithdraw();
    await flushPromises();

    await wrapper.find('.withdraw-input').setValue('2000');
    await wrapper.find('.withdraw-submit').trigger('click');
    // 密码框尚未确认（busy 必须已置位）⇒ 第二次点击不得再开一个密码框。
    await wrapper.find('.withdraw-submit').trigger('click');
    await flushPromises();

    expect(uniStub.calls.showModal).toHaveLength(1);
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();

    expect(countCalls(calls, '/auth/reauth')).toBe(1);
    expect(countCalls(calls, '/pay/withdrawals')).toBe(1);
  });

  it('reauth 网络异常（fetch reject）⇒ busy 复位 + 可见错误提示、不提交提现', async () => {
    const uniStub = installUniStub();
    useGameStore().setClientConfig(walletClientConfig({ withdrawReAuthEnabled: true }));
    const { wrapper, calls } = mountWithdraw(
      makeRoute({
        reauth: () => {
          throw new Error('network down');
        },
      }),
    );
    await flushPromises();

    await wrapper.find('.withdraw-input').setValue('2000');
    await wrapper.find('.withdraw-submit').trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();

    expect(
      wrapper.find('.wallet-withdraw__submit').attributes('disabled'),
      '失败后必须复位，不能把按钮永久锁死',
    ).toBeUndefined();
    expect(wrapper.find('[data-notice-id="withdraw"] .notice__text').text()).toContain(
      '密码验证失败',
    );
    expect(countCalls(calls, '/pay/withdrawals'), 'reauth 异常不得提交').toBe(0);
  });
});

/**
 * 充值子页（2026-10-23 钱包拆分）：从钱包页搬出的「② 充值」用例 + 子页新判据。
 *
 * 判别矩阵：
 *  · 档位卡两行文案逐字（`{N} 元` / `{N×coinPerYuan} 金币`），比率未知只显金额；
 *  · 卡网格**等高**走源码级规则体（jsdom 无布局，运行时几何恒 0）；
 *  · 下单 ⇒ 跳收银台；无宿主降级；`pay-hint` 不滞留；在途全禁用；服务端文案逐字；
 *  · 开关关闭守卫 / 空档位态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import RechargePage from '../src/pages/wallet/recharge.vue';
import * as payModule from '../src/net/pay';
import { useGameStore } from '../src/stores/game';
import { clientConfig } from '../src/config';
import { stopGameSession } from '../src/composables/useGameSession';
import { SRC_ROOT } from './helpers/source-scan';
import {
  err,
  makeRoute,
  ok,
  stubFetch,
  T0,
  walletClientConfig,
  type FetchCall,
} from './helpers/wallet-fixtures';

/** 部分替身：只换「跳收银台」（真实现动 `location.href`，jsdom 里无法观察）。 */
vi.mock('../src/net/pay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/net/pay')>();
  return { ...actual, jumpToCashier: vi.fn(() => true) };
});

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  clientConfig.token = '';
  useGameStore().setClientConfig(walletClientConfig());
  vi.mocked(payModule.jumpToCashier).mockReset();
  vi.mocked(payModule.jumpToCashier).mockReturnValue(true);
});

afterEach(() => {
  stopGameSession();
  vi.restoreAllMocks();
});

function mountRecharge(route = makeRoute()) {
  const { calls } = stubFetch(route);
  const wrapper = mount(RechargePage, { global: { plugins: [pinia] } });
  return { wrapper, calls };
}

describe('① 充值子页：档位卡 / 下单 / 收银台', () => {
  it('档位卡：恰 N 个 + 两行文案逐字 + 钩子 pay-package-{yuan}', async () => {
    const { wrapper } = mountRecharge();
    await flushPromises();

    const cards = wrapper.findAll('.wallet-recharge__package');
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.text().replace(/\s+/g, ' ').trim())).toEqual([
      '6 元600 金币',
      '30 元3000 金币',
      '68 元6800 金币',
    ]);
    expect(wrapper.find('.pay-package-6').exists(), '测试钩子（规格 §4 逐字）').toBe(true);
    expect(wrapper.find('.pay-package-30').exists()).toBe(true);
    expect(wrapper.find('.pay-package-68').exists()).toBe(true);
  });

  it('coinPerYuan 未知（null）⇒ 只显「{N} 元」（不编比率）；卡仍按等高规则渲染', async () => {
    useGameStore().setClientConfig(walletClientConfig({ coinPerYuan: null, rechargePackages: [6] }));
    const { wrapper } = mountRecharge();
    await flushPromises();

    expect(wrapper.find('.pay-package-6').text().trim()).toBe('6 元');

    // jsdom 没有布局引擎 ⇒ 等高只能钉源码规则体（判别力：删掉 min-height 即红）。
    const src = readFileSync(join(SRC_ROOT, 'pages/wallet/recharge.vue'), 'utf8');
    const start = src.search(/\.wallet-recharge__package\s*\{/);
    expect(start, '`.wallet-recharge__package` 基础块必须存在').toBeGreaterThanOrEqual(0);
    const end = src.indexOf('.wallet-recharge__muted', start);
    expect(end, '`.wallet-recharge__muted` 必须排在卡规则之后（切片边界）').toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block, '单行文案（比率未知）时同排卡不得一长一短').toMatch(/min-height\s*:/);
  });

  it('空档位 ⇒「暂无充值档位」', async () => {
    useGameStore().setClientConfig(walletClientConfig({ rechargePackages: [] }));
    const { wrapper } = mountRecharge();
    await flushPromises();

    expect(wrapper.findAll('.wallet-recharge__package')).toHaveLength(0);
    expect(wrapper.text()).toContain('暂无充值档位');
  });

  it('开关关闭 ⇒「充值暂未开放」，不渲染档位', async () => {
    useGameStore().setClientConfig(walletClientConfig({ rechargeEnabled: false }));
    const { wrapper } = mountRecharge();
    await flushPromises();

    expect(wrapper.findAll('.wallet-recharge__package')).toHaveLength(0);
    expect(wrapper.text()).toContain('充值暂未开放');
  });

  it('点档位 ⇒ POST /pay/orders {packageYuan} ⇒ jumpToCashier(响应 payUrl)', async () => {
    const { wrapper, calls } = mountRecharge(
      makeRoute({
        createOrder: () =>
          ok({ orderNo: 'pay_new', payUrl: 'https://cashier.example/pay_new', expiresAt: T0 }),
      }),
    );
    await flushPromises();

    await wrapper.find('.pay-package-6').trigger('click');
    await flushPromises();

    const create = calls.find((c) => c.url.endsWith('/pay/orders') && c.init?.method === 'POST');
    expect(create, '必须真的下单').toBeDefined();
    expect(JSON.parse(String(create!.init?.body))).toEqual({ packageYuan: 6 });
    expect(vi.mocked(payModule.jumpToCashier)).toHaveBeenCalledWith('https://cashier.example/pay_new');
    expect(wrapper.find('[data-notice-id="recharge"]').exists(), '成功不留失败项').toBe(false);
    expect(
      wrapper.find('[data-notice-id="pay-hint"]').exists(),
      '成功唤起收银台不得留下降级引导',
    ).toBe(false);
  });

  it('无浏览器宿主（jumpToCashier ⇒ false）⇒ §2.8 降级文案逐字（sticky pay-hint）', async () => {
    vi.mocked(payModule.jumpToCashier).mockReturnValueOnce(false);
    const { wrapper } = mountRecharge();
    await flushPromises();

    await wrapper.find('.pay-package-6').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-notice-id="pay-hint"] .notice__text').text()).toBe(
      '请用浏览器打开完成支付',
    );
  });

  it('pay-hint 在下一次下单**开始**时收起（成功/失败收口后也不得滞留）', async () => {
    vi.mocked(payModule.jumpToCashier).mockReturnValueOnce(false);
    const { wrapper } = mountRecharge();
    await flushPromises();

    await wrapper.find('.pay-package-6').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-notice-id="pay-hint"]').exists()).toBe(true);

    await wrapper.find('.pay-package-6').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-notice-id="pay-hint"]').exists()).toBe(false);
  });

  it('下单失败（15008）⇒ 服务端 message 逐字展示（message-first 码）', async () => {
    const { wrapper } = mountRecharge(makeRoute({ createOrder: () => err(15008, '充值暂未开放') }));
    await flushPromises();

    await wrapper.find('.pay-package-6').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-notice-id="recharge"] .notice__text').text()).toBe('充值暂未开放');
  });

  it('下单在途：档位卡全部禁用（响应到达后恢复）', async () => {
    const calls: FetchCall[] = [];
    const holder: { release?: () => void } = {};
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
        if (url.endsWith('/pay/orders') && init?.method === 'POST') {
          return new Promise((resolve) => {
            holder.release = () => resolve(respond());
          });
        }
        return Promise.resolve(respond());
      }),
    );
    const wrapper = mount(RechargePage, { global: { plugins: [pinia] } });
    await flushPromises();

    await wrapper.find('.pay-package-6').trigger('click');
    await flushPromises();

    for (const card of wrapper.findAll('.wallet-recharge__package')) {
      expect(card.attributes('disabled'), '在途必须禁用（防双击双单）').toBeDefined();
    }

    holder.release?.();
    await flushPromises();
    for (const card of wrapper.findAll('.wallet-recharge__package')) {
      expect(card.attributes('disabled')).toBeUndefined();
    }
  });
});

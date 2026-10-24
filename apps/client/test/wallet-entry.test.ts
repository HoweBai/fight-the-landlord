/**
 * 支付片 T14（规格 §4 · 设计 §11.1）：**大厅钱包入口** + **配置 +7 键接入**（T5 起的
 * 客户端类型面过渡红在本片愈合的判据面）。
 *
 * 判别矩阵（每条对着一种「最像正确答案」的错实现）：
 *  ① **入口（拆分的可证伪语义）**：`.wallet-entry`（金币显示处）与 `.lobby__player-entry`
 *     （身份 ⇒ 玩家菜单）是**兄弟** —— 钱包按钮里有金币视图、菜单按钮里**没有**
 *     （「点了金币显示处打开的却是玩家菜单」是最像正确答案的错实现）；
 *  ② **导航**：`navigateTo('/pages/wallet/wallet')`（子页压栈；**不是** reLaunch）、
 *     目标与 `pages.json` **同提交**登记（两处漂移 = 真机导航失败）；
 *  ③ **入口恒在**（§4「入口保留」）：两开关全关（种子暗上线态）入口仍在、仍可点进；
 *  ④ **?pay= 回跳**：应用启动读到 ⇒ 写跨页载体（`store.walletReturnOrderNo`）+ 自动压栈钱包页；
 *     读不到 ⇒ **不**跳（负对照）；
 *  ⑤ **配置 +7 键**：成功响应 ⇒ 逐键落 store（哑终端）；**缺键**（旧版服务端）⇒ 按
 *     「关/`null`/空表」归一（未知的新能力不渲染）；**失败/违约** ⇒ FAILSAFE（同一口径）；
 *     `setClientConfig` 十五键**同生共死**（没有「只更一半」的姿势）。
 *     广告片 T19：键族扩到 **15 键**（第 15 键 `reliefAdpid`，空串 = 未配置）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import PlayerChip from '../src/components/PlayerChip.vue';
import * as payModule from '../src/net/pay';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import { clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { stopGameSession } from '../src/composables/useGameSession';
import { SRC_ROOT } from './helpers/source-scan';
import { installUniStub, type UniStub } from './helpers/uni-stub';

/**
 * 部分替身：只把 `consumePayReturnOrderNo` 换成记账函数 —— 真实实现的解析语义由
 * `wallet-pay.test.ts` ③ 组用真 window 替身逐条覆盖，这里只需要「读到/读不到」两个输入。
 */
vi.mock('../src/net/pay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/net/pay')>();
  return { ...actual, consumePayReturnOrderNo: vi.fn(() => null) };
});

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

/** 广告片 T19 后的完整 15 键配置响应（支付七键值逐字 = 规格 §2.5 的种子；`reliefAdpid` = 第 15 键）。 */
const CONFIG_15 = {
  code: 0,
  data: {
    baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
    friendRoomEnabled: false,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    reliefAdpid: 'adpid_w15',
    entryMultiplier: 10,
    rechargeEnabled: true,
    withdrawEnabled: true,
    coinPerYuan: 100,
    rechargePackages: [6, 30, 68, 128, 328],
    withdrawMinCoins: 1000,
    withdrawMaxCoinsPerOrder: 50000,
    withdrawDailyMaxCoins: 100000,
    withdrawReAuthEnabled: false,
    version: 9,
  },
};

/** 支付片前的 7 键响应（旧版服务端：支付七键 + `reliefAdpid` 一个都没有——缺键语义的输入）。 */
const CONFIG_LEGACY_7 = {
  code: 0,
  data: {
    baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
    friendRoomEnabled: false,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    entryMultiplier: 10,
    version: 8,
  },
};

let pinia: ReturnType<typeof createPinia>;
let uni: UniStub;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  uni = installUniStub();
  localStorage.clear();
  clientConfig.token = '';
  // 默认「读不到 ?pay=」（真实现的负路径另有专测；本文件的回跳用例用 Once 覆盖）。
  vi.mocked(payModule.consumePayReturnOrderNo).mockReset();
  vi.mocked(payModule.consumePayReturnOrderNo).mockReturnValue(null);
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
});

/** 挂大厅（入口所在页）：`/config` 与 `/wallet/balance` 各给一条应答。 */
function mountLobby(config: unknown = CONFIG_15, balance = 880) {
  stubFetch((call) => {
    if (call.url.includes('/config')) return config;
    if (call.url.includes('/wallet/balance')) return { code: 0, data: { balance } };
    return { code: 0, data: [] };
  });
  useAuthStore().navigate('lobby');
  uni.resetCalls();
  return mount(LobbyPage, { global: { plugins: [pinia] } });
}

// ---------------------------------------------------------------------------
// ① / ② 入口：结构与导航
// ---------------------------------------------------------------------------

describe('①/② 入口：金币显示处（兄弟按钮）⇒ navigateTo 钱包页', () => {
  it('两个按钮是**兄弟**：钱包按钮里是金币视图、菜单按钮里没有（拆分判别力）', async () => {
    const wrapper = mountLobby();
    await flushPromises();

    const walletEntry = wrapper.find('.wallet-entry');
    expect(walletEntry.exists(), '大厅必须有钱包入口（钩子 `wallet-entry`，规格 §4）').toBe(true);
    expect(
      walletEntry.find('.chip__coin').exists(),
      '钱包入口里必须**就是**金币显示处（`PlayerChip part="coin"`）',
    ).toBe(true);
    expect(
      wrapper.find('.lobby__player .chip__coin').exists(),
      '菜单按钮（身份）里不得再有金币视图 —— 否则「点了金币显示处打开的是菜单」不可证伪',
    ).toBe(false);
    // 菜单侧：身份部件与既有结构都在（记录片 T8 的入口判据一条不少）。
    expect(wrapper.find('.lobby__player .chip__name').exists()).toBe(true);
    expect(wrapper.findComponent(PlayerChip).exists()).toBe(true);
  });

  it('点钱包入口 ⇒ navigateTo /pages/wallet/wallet（压栈，不是 reLaunch）+ 不打开菜单', async () => {
    const wrapper = mountLobby();
    await flushPromises();

    await wrapper.find('.wallet-entry').trigger('click');

    expect(uni.calls.navigateTo, '子页是**压栈**形态（历史页同款）').toEqual([
      '/pages/wallet/wallet',
    ]);
    expect(uni.calls.reLaunch, '不得动 auth.page 的四页投影').toEqual([]);
    expect(wrapper.find('.lobby__menu').exists(), '进钱包页不开玩家菜单').toBe(false);
  });

  it('目标与 pages.json **同提交**登记的第 6 页逐字一致（两处漂移会红）', async () => {
    const wrapper = mountLobby();
    await flushPromises();
    await wrapper.find('.wallet-entry').trigger('click');

    const pagesJson = JSON.parse(readFileSync(join(SRC_ROOT, 'pages.json'), 'utf8')) as {
      pages: { path: string }[];
      subPackages?: { root: string; pages: { path: string }[] }[];
    };
    // 项 6：钱包页已移到 subPackages，主包与分包声明一起展开。
    const declared = [
      ...pagesJson.pages.map((p) => `/${p.path}`),
      ...(pagesJson.subPackages ?? []).flatMap((sp) => sp.pages.map((p) => `/${sp.root}/${p.path}`)),
    ];
    expect(
      declared,
      'navigateTo 的目标必须是 pages.json 里声明过的页面',
    ).toContain(uni.calls.navigateTo[0]);
  });

  it('③ 入口恒在（§4「入口保留」）：两开关全关（暗上线种子态）入口仍在、仍可点进', async () => {
    const wrapper = mountLobby({
      code: 0,
      data: { ...CONFIG_15.data, rechargeEnabled: false, withdrawEnabled: false },
    });
    await flushPromises();

    expect(
      wrapper.find('.wallet-entry').exists(),
      '两开关全关 ≠ 页面无内容（余额区/记录区不随开关隐藏）⇒ 入口保留',
    ).toBe(true);
    await wrapper.find('.wallet-entry').trigger('click');
    expect(uni.calls.navigateTo).toEqual(['/pages/wallet/wallet']);
  });
});

// ---------------------------------------------------------------------------
// ④ ?pay= 回跳：写跨页载体 + 自动压栈
// ---------------------------------------------------------------------------

describe('④ ?pay= 回跳（应用启动消费 ⇒ 进钱包页订单详情）', () => {
  it('读到 ?pay= ⇒ 写 store.walletReturnOrderNo + 自动压栈钱包页', async () => {
    vi.mocked(payModule.consumePayReturnOrderNo).mockReturnValueOnce('pay_ret_1');
    const wrapper = mountLobby();
    await flushPromises();

    expect(useGameStore().walletReturnOrderNo).toBe('pay_ret_1');
    expect(uni.calls.navigateTo).toEqual(['/pages/wallet/wallet']);
    expect(wrapper.find('.wallet-entry').exists(), '入口照常渲染').toBe(true);
  });

  it('负对照：读不到 ⇒ 不跳、载体为空', async () => {
    mountLobby();
    await flushPromises();

    expect(uni.calls.navigateTo).toEqual([]);
    expect(useGameStore().walletReturnOrderNo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ⑤ 配置 +7 键 + 第 15 键：成功 / 缺键 / 失败 三条面孔（T5 过渡红的客户端侧愈合点）
// ---------------------------------------------------------------------------

describe('⑤ 配置 15 键落 store（归一化 + FAILSAFE）', () => {
  it('成功响应（15 键）⇒ 支付七键逐字 + `reliefAdpid` 落 store（哑终端）', async () => {
    mountLobby();
    await flushPromises();

    const store = useGameStore();
    expect(store.rechargeEnabled).toBe(true);
    expect(store.withdrawEnabled).toBe(true);
    expect(store.coinPerYuan).toBe(100);
    expect(store.rechargePackages).toEqual([6, 30, 68, 128, 328]);
    expect(store.withdrawMinCoins).toBe(1000);
    expect(store.withdrawMaxCoinsPerOrder).toBe(50000);
    expect(store.withdrawDailyMaxCoins).toBe(100000);
    // 广告片 T19 第 15 键：非空值才证明「真的写到了」（store 缺省就是空串）。
    expect(store.reliefAdpid, '`reliefAdpid` 逐字落 store').toBe('adpid_w15');
  });

  it('缺键语义（旧版服务端只有 7 键）：支付七键按「关 / null / 空表」+ adpid 按空串归一 —— 未知的新能力不渲染', async () => {
    const wrapper = mountLobby(CONFIG_LEGACY_7);
    await flushPromises();

    const store = useGameStore();
    expect(store.rechargeEnabled, '缺 ⇒ 关（不用 `=== true` 以外的写法都算放行）').toBe(false);
    expect(store.withdrawEnabled).toBe(false);
    expect(store.coinPerYuan, '数值缺 ⇒ null（不编一个比率）').toBeNull();
    expect(store.rechargePackages).toEqual([]);
    expect(store.withdrawMinCoins).toBeNull();
    expect(store.withdrawMaxCoinsPerOrder).toBeNull();
    expect(store.withdrawDailyMaxCoins).toBeNull();
    expect(store.reliefAdpid, '缺 ⇒ 空串（未配置 ⇒ 救助入口不渲染，规格冻结条 K）').toBe('');
    // 正对照：既有七键的缺键语义一字未动（free 缺 ⇒ 开等由 `lobby-modes` 专测；此处只钉不回归）。
    expect(store.freeRoomEnabled).toBe(true);
    // 入口不因配置缺键而消失（§4：入口保留）。
    expect(wrapper.find('.wallet-entry').exists()).toBe(true);
  });

  it('失败 ⇒ FAILSAFE（支付七键同一口径：关 / null / 空表；adpid 空串），入口不受影响', async () => {
    const wrapper = mountLobby({ code: 10007, message: '下游不可用', data: null });
    await flushPromises();

    const store = useGameStore();
    expect(store.rechargeEnabled).toBe(false);
    expect(store.withdrawEnabled).toBe(false);
    expect(store.coinPerYuan).toBeNull();
    expect(store.rechargePackages).toEqual([]);
    expect(store.withdrawMinCoins).toBeNull();
    expect(store.withdrawMaxCoinsPerOrder).toBeNull();
    expect(store.withdrawDailyMaxCoins).toBeNull();
    expect(store.reliefAdpid, '失败 ⇒ FAILSAFE 空串（未知 = 入口不渲染）').toBe('');
    expect(wrapper.find('.wallet-entry').exists()).toBe(true);
  });

  it('setClientConfig 十六键**同生共死**：一次调用逐键全写（隔离 store 直测）', () => {
    const store = useGameStore();
    store.setClientConfig({
      baseScoreLevels: [{ name: '标准场', baseScore: 80 }],
      friendRoomEnabled: true,
      freeRoomEnabled: false,
      goldRoomEnabled: true,
      reliefEnabled: true,
      reliefAdpid: 'adpid_direct',
      entryMultiplier: 25,
      rechargeEnabled: true,
      withdrawEnabled: false,
      coinPerYuan: 100,
      rechargePackages: [6],
      withdrawMinCoins: 1000,
      withdrawMaxCoinsPerOrder: 50000,
      withdrawDailyMaxCoins: 100000,
      withdrawReAuthEnabled: false,
      version: 42,
    });

    expect(store.baseScoreLevels).toEqual([{ name: '标准场', baseScore: 80 }]);
    expect(store.friendRoomEnabled).toBe(true);
    expect(store.freeRoomEnabled).toBe(false);
    expect(store.goldRoomEnabled).toBe(true);
    expect(store.reliefEnabled).toBe(true);
    expect(store.reliefAdpid).toBe('adpid_direct');
    expect(store.entryMultiplier).toBe(25);
    expect(store.rechargeEnabled).toBe(true);
    expect(store.withdrawEnabled).toBe(false);
    expect(store.coinPerYuan).toBe(100);
    expect(store.rechargePackages).toEqual([6]);
    expect(store.withdrawMinCoins).toBe(1000);
    expect(store.withdrawMaxCoinsPerOrder).toBe(50000);
    expect(store.withdrawDailyMaxCoins).toBe(100000);
  });
});

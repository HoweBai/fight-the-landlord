/**
 * 记牌器收费片 T12：开始游戏页购买入口与购买流（规格 §2.7；C31–C34 的单测半边）。
 *
 * 2026-10-19 入口改造（设计 2026-10-19-card-counter-entry-design.md）：购买面板从主界面
 * 迁到**顶栏入口 + 弹层**；本文件同步改锚 `.game__bar .game__cardcounter-entry` /
 * `.game__cardcounter-mask` / `.game__cardcounter`。
 *
 * 覆盖：入口条件（总开关/金币场/两价格数值/旧服务端/免费态/单键 0）、弹层开合、
 * 状态加载失败、确认购买（requestId/expectedPrice/成功回写）、取消、14009 刷新、14001、
 * 10007 保留待确认记录、重挂载同号重试、14003 预检、匹配中隐藏。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import GamePage from '../src/pages/game/game.vue';
import { useGameStore } from '../src/stores/game';
import { useAuthStore } from '../src/stores/auth';
import {
  clearPendingCardCounterPurchase,
  loadPendingCardCounterPurchase,
  savePendingCardCounterPurchase,
} from '../src/net/storage';
import { installUniStub, type UniStub } from './helpers/uni-stub';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

interface FetchCall {
  url: string;
  body?: Record<string, unknown>;
}

function stubFetch(over: {
  status?: unknown;
  /** `'hang'` = 购买请求永不 resolve（用于钉「待确认记录」单独驱动圆点、ccError 仍为空）。 */
  purchase?: unknown | 'hang';
  config?: unknown;
  /** `/rooms` 请求抛错 ⇒ 浮层 `rooms` 项（用于「弹层打开时提示仍可见且不挤压弹层」的驱动）。 */
  roomsThrows?: boolean;
} = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, ...(body === undefined ? {} : { body }) });
      if (over.roomsThrows === true && url.includes('/rooms')) {
        throw new Error('rooms down');
      }
      if (url.includes('/card-counter/purchase') && over.purchase === 'hang') {
        return new Promise<never>(() => {});
      }
      const payload = url.includes('/card-counter/status')
        ? (over.status ?? { code: 0, data: { credits: 0, passExpiresAt: null } })
        : url.includes('/card-counter/purchase')
          ? (over.purchase ?? {
              code: 0,
              data: { credits: 1, passExpiresAt: null, priceCharged: 10, balanceAfter: 990 },
            })
          : url.includes('/api/config')
            ? (over.config ?? {
                code: 0,
                data: {
                  baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
                  freeRoomEnabled: true,
                  goldRoomEnabled: true,
                  cardCounterEnabled: true,
                  cardCounterPricePerGameCoins: 20,
                  cardCounterPricePerHourCoins: 100,
                  version: 2,
                },
              })
            : { code: 0, data: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    }),
  );
  return calls;
}

const purchaseCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes('/card-counter/purchase'));

async function mountGame(over: {
  enabled?: boolean;
  mode?: 'random' | 'gold';
  /** 选中的玩法（`store.activeMode`）；缺省斗地主（开始游戏页从大厅拿到的那一项）。 */
  gameType?: 'doudizhu' | 'paodekuai';
  perGame?: number | null;
  perHour?: number | null;
  wallet?: number | null;
  matching?: boolean;
} = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.userId = 'u1';
  const store = useGameStore();
  store.setActiveMode(over.gameType ?? 'doudizhu');
  store.cardCounterEnabled = over.enabled ?? true;
  store.roomMode = over.mode ?? 'gold';
  store.setRoomMode(over.mode ?? 'gold');
  store.cardCounterPricePerGameCoins = over.perGame === undefined ? 10 : over.perGame;
  store.cardCounterPricePerHourCoins = over.perHour === undefined ? 100 : over.perHour;
  store.baseScoreLevels = [{ name: '休闲场', baseScore: 15 }];
  store.selectedBaseScore = 15;
  store.entryMultiplier = 10;
  store.setWalletBalance(over.wallet === undefined ? 1000 : over.wallet);
  if (over.matching === true) store.setMatching(true);
  const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
  await flushPromises();
  return { wrapper, store, auth };
}

/**
 * 打开记牌器购买弹层（入口在顶栏）。
 * 点入口后 `openCounterShop()` 会复拉一次权益状态 ⇒ 必须 `flushPromises` 等它落地。
 */
async function openShop(wrapper: Awaited<ReturnType<typeof mountGame>>['wrapper']) {
  await wrapper.find('.game__bar .game__cardcounter-entry').trigger('click');
  await flushPromises();
}

describe('开始游戏页：记牌器购买入口 + 弹层', () => {
  let uniStub: UniStub;

  beforeEach(() => {
    localStorage.clear();
    clearPendingCardCounterPurchase();
    uniStub = installUniStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearPendingCardCounterPurchase();
  });

  it('条件：总开关/金币场/两价格数值齐 ⇒ 顶栏入口；旧服务端（null）/免费场/开关关 ⇒ 不渲染', async () => {
    stubFetch();
    const on = await mountGame();
    // 入口必须在**顶栏**（作用域断言：把入口挪回中央区/弹层里都必须红）
    expect(on.wrapper.find('.game__bar .game__cardcounter-entry').exists()).toBe(true);
    expect(on.wrapper.find('.game__stage .game__cardcounter-entry').exists()).toBe(false);
    // 默认弹层关闭 —— v-if 语义：内容不得在 DOM 里（禁止 v-show 蒙混）
    expect(on.wrapper.find('.game__cardcounter').exists()).toBe(false);
    expect(on.wrapper.findAll('.game__cardcounter-buy')).toHaveLength(0);
    // aria-expanded 随开合翻转
    expect(on.wrapper.find('.game__bar .game__cardcounter-entry').attributes('aria-expanded')).toBe(
      'false',
    );
    await openShop(on.wrapper);
    expect(on.wrapper.find('.game__cardcounter').exists()).toBe(true);
    expect(on.wrapper.find('.game__bar .game__cardcounter-entry').attributes('aria-expanded')).toBe(
      'true',
    );
    on.wrapper.unmount();

    stubFetch();
    const oldServer = await mountGame({ perGame: null });
    expect(oldServer.wrapper.find('.game__bar .game__cardcounter-entry').exists()).toBe(false);
    oldServer.wrapper.unmount();

    stubFetch();
    const free = await mountGame({ mode: 'random' });
    expect(free.wrapper.find('.game__bar .game__cardcounter-entry').exists()).toBe(false);
    free.wrapper.unmount();

    stubFetch();
    const disabled = await mountGame({ enabled: false });
    expect(disabled.wrapper.find('.game__bar .game__cardcounter-entry').exists()).toBe(false);
    disabled.wrapper.unmount();
  });

  it('跑得快（能力位 cardCounter=false）⇒ 金币场也不渲染入口、弹层不可达（D17）', async () => {
    stubFetch();
    const pdk = await mountGame({ gameType: 'paodekuai' });
    expect(pdk.wrapper.find('.game__bar .game__cardcounter-entry').exists()).toBe(false);
    // v-if 语义：弹层内容同样不得在 DOM（入口不在 ⇒ 无从打开）
    expect(pdk.wrapper.find('.game__cardcounter').exists()).toBe(false);
    pdk.wrapper.unmount();
  });

  it('免费态（两价皆 0）⇒「金币场免费」、无购买按钮；单键 0 ⇒ 只渲染另一商品', async () => {
    stubFetch();
    const free = await mountGame({ perGame: 0, perHour: 0 });
    // 开层前：内容不得在 DOM（免费文案在这里才具判别力 —— v-show 会立刻被抓）
    expect(free.wrapper.text()).not.toContain('金币场免费');
    await openShop(free.wrapper);
    expect(free.wrapper.text()).toContain('金币场免费');
    expect(free.wrapper.findAll('.game__cardcounter-buy')).toHaveLength(0);
    free.wrapper.unmount();

    stubFetch();
    const single = await mountGame({ perGame: 0, perHour: 100 });
    await openShop(single.wrapper);
    expect(single.wrapper.findAll('.game__cardcounter-buy')).toHaveLength(1);
    expect(single.wrapper.text()).toContain('包时卡');
    expect(single.wrapper.text()).not.toContain('单局卡');
    single.wrapper.unmount();
  });

  it('状态加载失败 ⇒「—」/加载失败提示，不阻塞购买', async () => {
    stubFetch({ status: { code: 10007, message: 'down', data: null } });
    const { wrapper } = await mountGame();
    await openShop(wrapper);
    expect(wrapper.text()).toContain('权益信息加载失败');
    expect(wrapper.findAll('.game__cardcounter-buy')).toHaveLength(2);
    wrapper.unmount();
  });

  it('卡片布局：卡头（名称｜状态）与操作行（单价｜stepper｜购买）分离，按钮文案只有「购买」', async () => {
    stubFetch();
    const { wrapper } = await mountGame();
    await openShop(wrapper);

    const cards = wrapper.findAll('.game__cardcounter-card');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      // 名称与权益状态同处卡头（曾因三列挤压被排成一字一行 —— 这里钉住结构）。
      const head = card.find('.game__cardcounter-card-head');
      expect(head.exists()).toBe(true);
      expect(head.find('.game__cardcounter-card-name').text()).not.toBe('');
      expect(head.find('.game__cardcounter-card-desc').text()).not.toBe('');

      // 单价、stepper、购买按钮同处操作行；按钮只保留「购买」两字（数量/总价见 stepper 与确认框）。
      const row = card.find('.game__cardcounter-card-row');
      expect(row.exists()).toBe(true);
      expect(row.find('.game__cardcounter-price').exists()).toBe(true);
      expect(row.find('.game__cardcounter-stepper').exists()).toBe(true);
      expect(row.find('.game__cardcounter-buy').text()).toBe('购买');
    }
    wrapper.unmount();
  });

  it('购买单局卡：确认 → 请求体（kind/requestId/expectedPrice=总价）→ 成功回写面板与余额', async () => {
    const calls = stubFetch();
    const { wrapper, store } = await mountGame();

    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    expect(uniStub.calls.showModal).toHaveLength(1);
    expect(String(uniStub.calls.showModal[0]!.content)).toContain('10 金币/局');
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();

    const purchases = purchaseCalls(calls);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.body).toMatchObject({
      kind: 'game',
      expectedPrice: 10,
      requestId: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
    });
    expect(purchases[0]!.body).not.toHaveProperty('hours');
    expect(wrapper.text()).toContain('剩余 1 张');
    expect(store.walletBalance).toBe(990);
    expect(loadPendingCardCounterPurchase()).toBeNull();
    wrapper.unmount();
  });

  it('取消确认 ⇒ 不发请求、不写待确认记录', async () => {
    const calls = stubFetch();
    const { wrapper } = await mountGame();
    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: false });
    await flushPromises();
    expect(purchaseCalls(calls)).toHaveLength(0);
    expect(loadPendingCardCounterPurchase()).toBeNull();
    wrapper.unmount();
  });

  it('14009 价格已更新 ⇒ 刷新 /api/config、清待确认、提示重试', async () => {
    const calls = stubFetch({
      purchase: { code: 14009, message: '价格已更新', data: null },
    });
    const { wrapper, store } = await mountGame();
    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();

    expect(calls.some((c) => c.url.includes('/api/config'))).toBe(true);
    expect(wrapper.find('[data-notice-id="cc-error"] .notice__text').text()).toContain('价格已更新');
    expect(loadPendingCardCounterPurchase()).toBeNull();
    // 配置刷新后价格落到 store（20）
    expect(store.cardCounterPricePerGameCoins).toBe(20);
    wrapper.unmount();
  });

  it('14009 且配置刷新失败 ⇒「价格刷新失败，请重试」并**保留**待确认记录', async () => {
    stubFetch({
      purchase: { code: 14009, message: '价格已更新', data: null },
      config: { code: 10007, message: 'down', data: null },
    });
    const { wrapper } = await mountGame();
    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();

    expect(wrapper.find('[data-notice-id="cc-error"] .notice__text').text()).toContain('价格刷新失败');
    expect(loadPendingCardCounterPurchase(), '刷新失败 ⇒ 记录保留（同 requestId 可重试）').not.toBeNull();
    wrapper.unmount();
  });

  it('14001 金币不足 ⇒ 提示、清待确认', async () => {
    stubFetch({ purchase: { code: 14001, message: '余额不足', data: null } });
    const { wrapper } = await mountGame();
    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();
    expect(wrapper.find('[data-notice-id="cc-error"] .notice__text').text()).toContain('金币不足');
    expect(loadPendingCardCounterPurchase()).toBeNull();
    wrapper.unmount();
  });

  it('10007 未知结局 ⇒「结果确认中」并**保留**待确认记录（同 requestId 可重试）', async () => {
    stubFetch({ purchase: { code: 10007, message: 'down', data: null } });
    const { wrapper } = await mountGame();
    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();

    expect(wrapper.find('[data-notice-id="cc-error"] .notice__text').text()).toContain('结果确认中');
    const pending = loadPendingCardCounterPurchase();
    expect(pending).not.toBeNull();
    expect(pending!.kind).toBe('game');
    wrapper.unmount();
  });

  it('10007 后再点购买 ⇒ **同 requestId 重试**、不生成新号、不再弹确认框（Critical C-1 回归）', async () => {
    const calls = stubFetch({ purchase: { code: 10007, message: 'down', data: null } });
    const { wrapper } = await mountGame();

    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();
    const first = purchaseCalls(calls)[0]!.body as { requestId: string };
    expect(uniStub.calls.showModal).toHaveLength(1);

    // 未决记录在场 ⇒ 再点购买应直接重试原号（不得开新确认框/新 actionId）
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    const second = purchaseCalls(calls)[1]!.body as { requestId: string };
    expect(second.requestId).toBe(first.requestId);
    expect(uniStub.calls.showModal).toHaveLength(1);
    expect(loadPendingCardCounterPurchase()?.requestId).toBe(first.requestId);
    wrapper.unmount();
  });

  it('待确认记录 ⇒ 入口圆点（不依赖 ccError：请求在途时 ccError 仍为空）', async () => {
    stubFetch({ purchase: 'hang' });
    savePendingCardCounterPurchase({
      userId: 'u1',
      kind: 'hour',
      hours: 1,
      expectedPrice: 100,
      requestId: 'cc-pending-dot',
      createdAt: Date.now(),
    });
    const { wrapper } = await mountGame();
    expect(
      wrapper.find('.game__bar .game__cardcounter-entry .game__cardcounter-dot').exists(),
      '待确认记录必须驱动入口圆点',
    ).toBe(true);
    // 判别力：ccError 仍为空（没有「结果确认中」），圆点只能来自 ccPending
    expect(wrapper.text()).not.toContain('结果确认中');
    wrapper.unmount();
  });

  it('购买失败（10007）⇒ 入口圆点', async () => {
    stubFetch({ purchase: { code: 10007, message: 'down', data: null } });
    const { wrapper } = await mountGame();
    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();
    expect(
      wrapper.find('.game__bar .game__cardcounter-entry .game__cardcounter-dot').exists(),
    ).toBe(true);
    wrapper.unmount();
  });

  it('圆点随「同 requestId 重试成功」消失', async () => {
    const firstCalls = stubFetch({ purchase: { code: 10007, message: 'down', data: null } });
    const { wrapper } = await mountGame();
    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();
    const firstId = (purchaseCalls(firstCalls)[0]!.body as { requestId: string }).requestId;
    const dot = () => wrapper.find('.game__bar .game__cardcounter-entry .game__cardcounter-dot');
    expect(dot().exists(), '失败后必须有圆点').toBe(true);

    // 换成功桩：同一定待确认记录在场 ⇒ 同 requestId 重试（不再弹确认框）
    const secondCalls = stubFetch();
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    expect(uniStub.calls.showModal).toHaveLength(1);
    expect(
      (purchaseCalls(secondCalls)[0]!.body as { requestId: string }).requestId,
      '必须复用原 requestId',
    ).toBe(firstId);
    expect(dot().exists(), '成功后圆点必须消失').toBe(false);
    expect(loadPendingCardCounterPurchase()).toBeNull();
    wrapper.unmount();
  });

  it('本页发起购买后请求挂起 ⇒ 记录已保存，关层后入口即有圆点', async () => {
    stubFetch({ purchase: 'hang' });
    const { wrapper } = await mountGame();
    await openShop(wrapper);
    await wrapper.findAll('.game__cardcounter-buy')[0]!.trigger('click');
    await flushPromises();
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();

    // 请求在途（永不 resolve）：此时记录已落盘，关掉弹层后入口必须已经提示
    await wrapper.find('.game__cardcounter-mask').trigger('click');
    await flushPromises();
    expect(
      wrapper.find('.game__bar .game__cardcounter-entry .game__cardcounter-dot').exists(),
      '记录已保存 ⇒ 入口必须提示（不能等请求落地才提示）',
    ).toBe(true);
    expect(wrapper.text()).not.toContain('结果确认中');
    wrapper.unmount();
  });

  it('异用户的待确认记录 ⇒ 无圆点且被清除（resume 对账纪律）', async () => {
    stubFetch();
    savePendingCardCounterPurchase({
      userId: 'u2',
      kind: 'hour',
      hours: 1,
      expectedPrice: 100,
      requestId: 'cc-other-user',
      createdAt: Date.now(),
    });
    const { wrapper } = await mountGame();
    expect(
      wrapper.find('.game__bar .game__cardcounter-entry .game__cardcounter-dot').exists(),
    ).toBe(false);
    expect(loadPendingCardCounterPurchase(), '异用户记录必须被清除').toBeNull();
    wrapper.unmount();
  });

  it('过期待确认记录 ⇒ 无圆点且被清除', async () => {
    stubFetch();
    savePendingCardCounterPurchase({
      userId: 'u1',
      kind: 'hour',
      hours: 1,
      expectedPrice: 100,
      requestId: 'cc-expired',
      createdAt: Date.now() - 24 * 60 * 60 * 1000 - 1000,
    });
    const { wrapper } = await mountGame();
    expect(
      wrapper.find('.game__bar .game__cardcounter-entry .game__cardcounter-dot').exists(),
    ).toBe(false);
    expect(loadPendingCardCounterPurchase(), '过期记录必须被清除').toBeNull();
    wrapper.unmount();
  });

  it('重挂载：未超 24h 的同用户待确认记录 ⇒ 同 requestId 自动重试，成功后清除', async () => {
    const calls = stubFetch();
    savePendingCardCounterPurchase({
      userId: 'u1',
      kind: 'hour',
      hours: 1,
      expectedPrice: 100,
      requestId: 'cc-saved-request',
      createdAt: Date.now(),
    });
    const { wrapper } = await mountGame();

    const purchases = purchaseCalls(calls);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.body).toMatchObject({
      kind: 'hour',
      hours: 1,
      requestId: 'cc-saved-request',
      expectedPrice: 100,
    });
    expect(loadPendingCardCounterPurchase()).toBeNull();
    wrapper.unmount();
  });

  it('14003 预检：买后余额低于门槛 ⇒ 按钮禁用 + 警示（160-10 < 150 不触发；155-10 < 150 触发）', async () => {
    stubFetch();
    const ok = await mountGame({ wallet: 160 });
    await openShop(ok.wrapper);
    const okBtn = ok.wrapper.findAll('.game__cardcounter-buy')[0]!;
    expect(okBtn.attributes('disabled')).toBeUndefined();
    ok.wrapper.unmount();

    stubFetch();
    const blocked = await mountGame({ wallet: 155 });
    await openShop(blocked.wrapper);
    const btn = blocked.wrapper.findAll('.game__cardcounter-buy')[0]!;
    expect(btn.attributes('disabled')).toBeDefined();
    expect(blocked.wrapper.text()).toContain('低于本场门槛');
    blocked.wrapper.unmount();
  });

  it('匹配中：入口与弹层都不渲染', async () => {
    stubFetch();
    const { wrapper } = await mountGame({ matching: true });
    expect(wrapper.find('.game__bar .game__cardcounter-entry').exists()).toBe(false);
    expect(wrapper.find('.game__cardcounter').exists()).toBe(false);
    wrapper.unmount();
  });

  it('弹层打开后匹配开始 ⇒ 强制关闭，且结束后不自动重开', async () => {
    stubFetch();
    const { wrapper, store } = await mountGame();
    await openShop(wrapper);
    expect(wrapper.find('.game__cardcounter').exists()).toBe(true);

    store.setMatching(true);
    await flushPromises();
    expect(wrapper.find('.game__cardcounter').exists()).toBe(false);

    store.setMatching(false);
    await flushPromises();
    expect(wrapper.find('.game__cardcounter').exists()).toBe(false);
    wrapper.unmount();
  });

  it('打开弹层复拉一次权益状态', async () => {
    const calls = stubFetch();
    const { wrapper } = await mountGame();
    const statusCalls = () => calls.filter((c) => c.url.includes('/card-counter/status')).length;
    const before = statusCalls();
    await openShop(wrapper);
    expect(statusCalls(), '打开弹层必须复拉权益（包时余量随时间变化）').toBe(before + 1);
    wrapper.unmount();
  });

  it('房间列表失败提示在弹层打开期间仍可见（Stack z=15 高于弹层）、且不挤压弹层', async () => {
    stubFetch({ roomsThrows: true });
    const { wrapper } = await mountGame();
    const roomsNotice = () => wrapper.find('[data-notice-id="rooms"]');
    expect(roomsNotice().exists()).toBe(true);
    expect(roomsNotice().find('.notice__text').text()).toContain('房间列表加载失败');

    await openShop(wrapper);
    /**
     * Task 9 反转旧语义：提示不再“让位”，而是浮层在弹层**之上**继续可见。
     */
    expect(roomsNotice().exists(), '弹层打开时提示仍必须可见').toBe(true);
    expect(roomsNotice().find('.notice__text').text()).toContain('房间列表加载失败');
    // 结构判据：提示不在弹层内部（不占它的文档流）⇒ 不会挤压弹层布局。
    expect(wrapper.find('.game__cardcounter [data-notice-id="rooms"]').exists()).toBe(false);
    expect(wrapper.find('.stage__overlay [data-notice-id="rooms"]').exists()).toBe(true);

    await wrapper.find('.game__cardcounter-mask').trigger('click');
    await flushPromises();
    expect(roomsNotice().exists(), '关闭弹层后提示仍在').toBe(true);
    wrapper.unmount();
  });

  it('开合：入口开 / 面板内点不关 / 遮罩关 / 关闭按钮关', async () => {
    stubFetch();
    const { wrapper } = await mountGame();

    await openShop(wrapper);
    expect(wrapper.find('.game__cardcounter').exists()).toBe(true);

    // 面板内部点击**不得**冒泡到遮罩（`@click.stop`）
    await wrapper.find('.game__cardcounter').trigger('click');
    await flushPromises();
    expect(wrapper.find('.game__cardcounter').exists()).toBe(true);

    // 遮罩是裸 click：点遮罩关闭
    await wrapper.find('.game__cardcounter-mask').trigger('click');
    await flushPromises();
    expect(wrapper.find('.game__cardcounter').exists()).toBe(false);
    expect(
      wrapper.find('.game__bar .game__cardcounter-entry').attributes('aria-expanded'),
    ).toBe('false');

    // 关闭按钮
    await openShop(wrapper);
    await wrapper.find('.game__cardcounter-close').trigger('click');
    await flushPromises();
    expect(wrapper.find('.game__cardcounter').exists()).toBe(false);
    wrapper.unmount();
  });

  it('源码级：遮罩关闭不是 `.self`；是「裸 click + 面板根 .stop」', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/pages/game/game.vue');
    expect(file, '扫描器必须真的读到 game.vue（否则本闸恒绿）').toBeDefined();
    const code = stripComments(file!.content);

    expect(code, '`.self` 在这条管线上恒被吞 —— 不得再出现').not.toMatch(/@click\.self/);
    // 正对照：旧写法必须被**同一条正则**报出（否则「没有 .self」可能只是这条正则从没匹配过东西）
    expect(
      `<view class="game__cardcounter-mask" @click.self="ccShopOpen = false">`,
      '正对照：旧形态必须被本闸的同一正则报出',
    ).toMatch(/@click\.self/);

    expect(code, '遮罩必须是**裸** `@click`').toMatch(
      /game__cardcounter-mask"[^>]*@click=/,
    );
    expect(code, '面板根必须有 `@click.stop`（否则点面板内部会被遮罩的裸 click 关掉）').toMatch(
      /game__cardcounter"[^>]*@click\.stop/,
    );
  });
});

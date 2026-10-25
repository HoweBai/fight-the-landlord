import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Card, PdkPlayerView } from '@fight-the-landlord/protocol';
import PdkBoard from '../src/components/table/pdk/PdkBoard.vue';
import TablePage from '../src/pages/table/table.vue';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import { useAuthStore } from '../src/stores/auth';
import { FakeSocket, makeCards } from './helpers/fake-socket';

/** 断言模板文本时先折叠空白。 */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * S6.1（spec §4.10.2）：跑得快牌桌。
 *
 * 判据：2/3/4 人渲染（无叫抢/底牌/地主徽标/记牌器）；动作栏 出牌/不出/提示；
 * `view.canPass` 控制「不出」；提示用 `pdkRules`；5 人合成视图 ⇒ 壳提示并回大厅。
 */
const RULES = {
  bareTrioEnabled: true,
  trioWithPairEnabled: false,
  bareAirplaneEnabled: false,
  fourWithTwoEnabled: true,
  fourWithTwoPairKickerAllowed: false,
  airplaneWings: 'pairs' as const,
  bombMultiplierEnabled: true,
  guanMultiplierEnabled: true,
  springMultiplierEnabled: true,
  multiplierCap: 64,
  baobenEnabled: true,
};

function pdkView(over: Partial<PdkPlayerView> = {}): PdkPlayerView {
  const hand = over.hand ?? makeCards(3, 4, 5);
  return {
    roomCode: 'PDK1',
    gameType: 'paodekuai',
    playerCount: 3,
    version: 1,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand,
    cardCounts: [hand.length, 16, 16],
    trustees: [false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 1_700_000_030_000,
    canPass: false,
    bombCount: 0,
    pdkRules: RULES,
    ...over,
  };
}

function boardProps(over: Partial<Record<string, unknown>> = {}) {
  return {
    view: pdkView(),
    mySeat: 0,
    seconds: 25,
    busy: false,
    interactive: true,
    settlementArrived: false,
    settlementRevealed: false,
    waitingForDeal: false,
    roomCode: 'PDK1',
    seatNames: { 1: '甲', 2: '乙' },
    balances: [null, null, null],
    levelName: '休闲场',
    ...over,
  };
}

describe('S6.1：PdkBoard', () => {
  it('3 人渲染：无叫抢/底牌/地主徽标/记牌器；手牌与剩余张数来自视图', () => {
    const wrapper = mount(PdkBoard, { props: boardProps() });

    expect(wrapper.find('.pdk').exists()).toBe(true);
    expect(wrapper.findAll('.pdk__me .card')).toHaveLength(3);
    expect(wrapper.find('.table__bid-grab').exists(), '跑得快没有叫抢').toBe(false);
    expect(wrapper.find('.bottom-cards').exists(), '跑得快没有底牌').toBe(false);
    expect(wrapper.findAll('.seat__badge'), '跑得快不画地主徽标').toHaveLength(0);
    expect(wrapper.find('.counter').exists(), '跑得快没有记牌器').toBe(false);
    expect(wrapper.text()).toContain('炸弹 0');
    expect(wrapper.text()).toContain('底分 15');
  });

  it('3 人布局：两个对手座 + 右列在场；左=上家(seat2)、右=下家(seat1)；无顶部行', () => {
    const wrapper = mount(PdkBoard, { props: boardProps() });
    expect(wrapper.findAll('.pdk__seat')).toHaveLength(2);
    expect(wrapper.find('.pdk__play-col--right').exists()).toBe(true);
    expect(wrapper.find('.pdk__top').exists(), '3 人无顶部对家').toBe(false);
    expect(wrapper.find('.pdk__mid--four').exists()).toBe(false);
    expect(flat(wrapper.find('.pdk__seat--right .seat__name').text())).toBe('甲');
    const left = wrapper
      .findAll('.pdk__seat')
      .find((w) => !w.classes().includes('pdk__seat--right') && !w.classes().includes('pdk__seat--top'));
    expect(flat(left!.find('.seat__name').text())).toBe('乙');
  });

  it('2 人布局：单对手座、无右座/右列/顶部行', () => {
    const wrapper = mount(PdkBoard, {
      props: boardProps({
        view: pdkView({ playerCount: 2, cardCounts: [3, 16], trustees: [false, false] }),
        seatNames: { 1: '甲' },
        balances: [null, null],
      }),
    });

    expect(wrapper.findAll('.pdk__seat')).toHaveLength(1);
    expect(wrapper.find('.pdk__seat--right').exists()).toBe(false);
    expect(wrapper.find('.pdk__play-col--right').exists()).toBe(false);
    expect(wrapper.find('.pdk__top').exists()).toBe(false);
    expect(wrapper.find('.pdk__mid--two').exists()).toBe(true);
    expect(wrapper.find('.pdk__mid--four').exists()).toBe(false);
    expect(wrapper.findAll('.pdk__me .card')).toHaveLength(3);
  });

  it('4 人布局：三个对手座；左=seat3、右=seat1、上=seat2；12 张手牌', () => {
    const hand12 = makeCards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14);
    const wrapper = mount(PdkBoard, {
      props: boardProps({
        view: pdkView({
          playerCount: 4,
          hand: hand12,
          cardCounts: [12, 12, 12, 12],
          trustees: [false, false, false, false],
        }),
        seatNames: { 1: '甲', 2: '乙', 3: '丁' },
        balances: [null, null, null, null],
      }),
    });

    expect(wrapper.findAll('.pdk__seat')).toHaveLength(3);
    expect(wrapper.find('.pdk__seat--top').exists()).toBe(true);
    expect(flat(wrapper.find('.pdk__seat--top .seat__name').text())).toBe('乙');
    expect(flat(wrapper.find('.pdk__seat--right .seat__name').text())).toBe('甲');
    const left = wrapper
      .findAll('.pdk__seat')
      .find((w) => !w.classes().includes('pdk__seat--right') && !w.classes().includes('pdk__seat--top'));
    expect(flat(left!.find('.seat__name').text())).toBe('丁');
    expect(wrapper.find('.pdk--four').exists()).toBe(true);
    expect(wrapper.find('.pdk__mid--four').exists()).toBe(true);
    expect(wrapper.findAll('.pdk__me .card')).toHaveLength(12);
  });

  it('4 人跟牌：窗口 3（出牌+两次过牌）仍按目标跟牌（提示选 8，不是首出的 3）', async () => {
    const wrapper = mount(PdkBoard, {
      props: boardProps({
        view: pdkView({
          playerCount: 4,
          hand: makeCards(3, 8),
          cardCounts: [2, 12, 12, 12],
          trustees: [false, false, false, false],
          canPass: true,
          recentActions: [
            { seat: 2, cards: makeCards(3) },
            { seat: 3, cards: null },
            { seat: 1, cards: null },
          ],
        }),
        seatNames: { 1: '甲', 2: '乙', 3: '丁' },
        balances: [null, null, null, null],
      }),
    });

    expect(wrapper.find('.pdk__hint').exists()).toBe(true);
    await wrapper.find('.pdk__hint').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('.pdk__play').trigger('click');
    expect(wrapper.emitted('play')?.[0]?.[0]).toEqual([{ r: 8, s: 0 }]);
  });

  it('4 人跟牌：手牌全 ≤ 目标 ⇒ 只出现「不出」（窗口坏掉会误出牌）', () => {
    const wrapper = mount(PdkBoard, {
      props: boardProps({
        view: pdkView({
          playerCount: 4,
          hand: makeCards(3, 4),
          cardCounts: [2, 12, 12, 12],
          trustees: [false, false, false, false],
          canPass: true,
          recentActions: [
            { seat: 2, cards: makeCards(8) },
            { seat: 3, cards: null },
            { seat: 1, cards: null },
          ],
        }),
        seatNames: { 1: '甲', 2: '乙', 3: '丁' },
        balances: [null, null, null, null],
      }),
    });

    expect(wrapper.find('.pdk__pass').exists()).toBe(true);
    expect(wrapper.find('.pdk__play').exists(), '无解时不得出现出牌').toBe(false);
    expect(wrapper.find('.pdk__hint').exists(), '无解时不得出现提示').toBe(false);
  });

  it('动作栏：首出不可过（无「不出」）；跟牌 canPass=true 时有「不出」', () => {
    const lead = mount(PdkBoard, { props: boardProps() });
    expect(lead.find('.pdk__pass').exists()).toBe(false);
    expect(lead.find('.pdk__play').exists()).toBe(true);

    const follow = mount(PdkBoard, {
      props: boardProps({
        view: pdkView({ canPass: true, recentActions: [{ seat: 1, cards: makeCards(3) }] }),
      }),
    });
    expect(follow.find('.pdk__pass').exists()).toBe(true);
  });

  it('出牌/不出上抛：选中一张合法单张 → play；点不出 → pass', async () => {
    const wrapper = mount(PdkBoard, { props: boardProps() });
    await wrapper.find('.pdk__me .card').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('.pdk__play').trigger('click');
    const played = wrapper.emitted('play')?.[0]?.[0] as Card[];
    expect(played).toHaveLength(1);

    const follow = mount(PdkBoard, {
      props: boardProps({
        view: pdkView({ hand: makeCards(5), canPass: true, recentActions: [{ seat: 1, cards: makeCards(3) }] }),
      }),
    });
    await follow.find('.pdk__pass').trigger('click');
    expect(follow.emitted('pass')).toHaveLength(1);
  });

  it('提示：跟单张时选出能压过的最小单张（用 pdkRules，不本地判规则）', async () => {
    const wrapper = mount(PdkBoard, {
      props: boardProps({
        view: pdkView({
          hand: makeCards(4, 8),
          canPass: true,
          recentActions: [{ seat: 1, cards: makeCards(3) }],
        }),
      }),
    });
    expect(wrapper.find('.pdk__hint').exists()).toBe(true);
    await wrapper.find('.pdk__hint').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('.pdk__play').trigger('click');

    const played = wrapper.emitted('play')?.[0]?.[0] as Card[];
    expect(played).toEqual([{ r: 4, s: 0 }]);
  });

  it('提示：窗口 = [对手出牌, 另一对手过牌] 时，跟牌目标仍是那张真牌（过牌不重置目标）', async () => {
    const wrapper = mount(PdkBoard, {
      props: boardProps({
        view: pdkView({
          hand: makeCards(4, 8),
          canPass: true,
          recentActions: [
            { seat: 1, cards: makeCards(3) },
            { seat: 2, cards: null },
          ],
        }),
      }),
    });
    await wrapper.find('.pdk__hint').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('.pdk__play').trigger('click');
    const played = wrapper.emitted('play')?.[0]?.[0] as Card[];
    expect(played).toEqual([{ r: 4, s: 0 }]);
  });

  it('更多 / 返回大厅上抛；结算揭示时动作按钮让位', async () => {
    const wrapper = mount(PdkBoard, { props: boardProps() });
    await wrapper.find('.pdk__more').trigger('click');
    await wrapper.find('.pdk__back').trigger('click');
    expect(wrapper.emitted('more')).toHaveLength(1);
    expect(wrapper.emitted('leave')).toHaveLength(1);

    const revealed = mount(PdkBoard, {
      props: boardProps({ settlementArrived: true, settlementRevealed: true }),
    });
    expect(revealed.find('.pdk__play').exists()).toBe(false);
  });
});

describe('S6.1：壳对 2/4 人的处置', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });
  afterEach(() => {
    stopGameSession();
  });

  it('收到 5 人合成 pdk 视图 ⇒ 提示「暂不支持该人数」并回大厅（store 级防御，协议入站不可达）', async () => {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const auth = useAuthStore();
    auth.enterAsDevUser();
    auth.navigate('table');
    const store = useGameStore();

    store.applySnapshot(
      pdkView({
        playerCount: 5 as unknown as PdkPlayerView['playerCount'],
        hand: makeCards(3, 4, 5),
        cardCounts: [3, 12, 12, 12, 12],
        trustees: [false, false, false, false, false],
      }),
    );
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(store.view, '不支持的人数必须复位（不渲染成 3 人桌）').toBeNull();
    expect(auth.page).toBe('lobby');
    expect(wrapper.text()).toContain('当前客户端暂不支持该人数的跑得快');
    const leaves = socket.emittedOf('room.leave');
    expect(leaves, '退房必须带 roomCode').toHaveLength(1);
    expect(leaves[0]!.env.payload).toEqual({ roomCode: 'PDK1' });
  });

  it('收到 2 人 pdk 视图 ⇒ 正常渲染（不再回大厅）', async () => {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const auth = useAuthStore();
    auth.enterAsDevUser();
    auth.navigate('table');
    const store = useGameStore();

    store.applySnapshot(
      pdkView({
        playerCount: 2,
        hand: makeCards(3, 4, 5),
        cardCounts: [3, 16],
        trustees: [false, false],
      }),
    );
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(store.view).not.toBeNull();
    expect(auth.page).toBe('table');
    expect(wrapper.findAll('.pdk__seat')).toHaveLength(1);
    expect(socket.emittedOf('room.leave')).toHaveLength(0);
  });

  it('收到 4 人 pdk 视图 ⇒ 正常渲染（3 个对手座 + 顶部行）', async () => {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const auth = useAuthStore();
    auth.enterAsDevUser();
    auth.navigate('table');
    const store = useGameStore();

    store.applySnapshot(
      pdkView({
        playerCount: 4,
        hand: makeCards(3, 4, 5),
        cardCounts: [3, 12, 12, 12],
        trustees: [false, false, false, false],
      }),
    );
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();

    expect(store.view).not.toBeNull();
    expect(auth.page).toBe('table');
    expect(wrapper.findAll('.pdk__seat')).toHaveLength(3);
    expect(wrapper.find('.pdk__seat--top').exists()).toBe(true);
    expect(socket.emittedOf('room.leave')).toHaveLength(0);
  });

  it('4 人视图：seat 3 的余额按人数投影显示（不再写死 3 座）', async () => {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const auth = useAuthStore();
    auth.enterAsDevUser();
    auth.navigate('table');
    const store = useGameStore();

    store.applySnapshot(
      pdkView({
        playerCount: 4,
        hand: makeCards(3, 4, 5),
        cardCounts: [3, 12, 12, 12],
        trustees: [false, false, false, false],
      }),
    );
    store.applyBalances({
      balances: [
        { seat: 0, balance: 100 },
        { seat: 1, balance: 200 },
        { seat: 2, balance: 300 },
        { seat: 3, balance: 9999 },
      ],
    });
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();

    const values = wrapper.findAll('.seat__coin-value').map((w) => flat(w.text()));
    expect(values).toContain('9999');
  });
});

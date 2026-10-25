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

/**
 * S6.1（spec §4.10.2）：跑得快牌桌。
 *
 * 判据：3 人渲染（无叫抢/底牌/地主徽标/记牌器）；动作栏 出牌/不出/提示；
 * `view.canPass` 控制「不出」；提示用 `pdkRules`；2/4 人 ⇒ 壳提示并回大厅。
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

  it('3 人布局：两个对手座 + 右列在场', () => {
    const wrapper = mount(PdkBoard, { props: boardProps() });
    expect(wrapper.findAll('.pdk__seat')).toHaveLength(2);
    expect(wrapper.find('.pdk__play-col--right').exists()).toBe(true);
  });

  it('2 人布局：单对手座、无右座/右列/右计时器', () => {
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
    expect(wrapper.find('.pdk__mid--two').exists()).toBe(true);
    expect(wrapper.findAll('.pdk__me .card')).toHaveLength(3);
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

  it('收到 4 人 pdk 视图 ⇒ 提示「暂不支持该人数」并回大厅（不渲染成 3 人桌）', async () => {
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
});

/**
 * 项 3：记牌器。
 *
 * 分两层：
 *  A 组 —— `usePlayedCards` / `computeRemaining` 的纯逻辑（守恒、底牌不减、空值跳过、换局清空）；
 *  B 组 —— `CardCounter.vue` 的渲染（15 列、绝牌高亮、我手牌标记、三家张数头）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PlayerView } from '@fight-the-landlord/protocol';
import { makeCards, playerViewFixture, serverMessage } from './helpers/fake-socket';
import { FakeSocket } from './helpers/fake-socket';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import {
  usePlayedCards,
  __resetPlayedCardsForTest,
  computeRemaining,
  CARD_RANK_ORDER,
  TOTAL_PER_RANK,
  __debugTotalConservation,
} from '../src/composables/usePlayedCards';

/** A 组：纯逻辑。 */
describe('computeRemaining（纯算术）', () => {
  it('所有点数的「手牌 + 已打出 + 剩余」恒等于 54（一副牌守恒）', () => {
    const hand = makeCards(3, 3, 4, 5, 17, 20, 30);
    const played = new Set<string>([
      `${3}-2`, `${4}-0`, `${14}-0`, `${14}-1`,
    ]);
    expect(__debugTotalConservation(hand, played)).toBe(54);
  });

  it('空手牌 + 空已打出 ⇒ 每列剩余 = 总数（4，王=1）', () => {
    const r = computeRemaining([], new Set());
    for (const rank of CARD_RANK_ORDER) {
      expect(r.get(rank), `rank ${rank}`).toBe(TOTAL_PER_RANK.get(rank));
    }
  });

  it('我手牌里的牌从剩余里扣，但已打出的也扣', () => {
    // 我手里有 2 张 3（s=0,1）；桌面上又打出了 1 张 3（s=2）⇒ 剩 1 张 3
    const hand = makeCards(3, 3); // {r:3,s:0}, {r:3,s:1}
    const played = new Set<string>(['3-2']);
    expect(computeRemaining(hand, played).get(3)).toBe(1);
  });

  it('王牌：总数 1，手里有 ⇒ 剩余 0（绝牌）', () => {
    const hand = makeCards(30); // 大王
    const played = new Set<string>();
    expect(computeRemaining(hand, played).get(30)).toBe(0);
  });

  it('底牌不计入「已打出」也不计入「我手牌」⇒ 它属于外面剩余（不减）', () => {
    // 底牌是 3 张 5，但 computeRemaining 只看 hand + played，不看 bottomCards
    const hand: { r: number; s: number }[] = [];
    const played = new Set<string>();
    // 5 剩余应为 4（底牌那 3 张仍算「外面」）
    expect(computeRemaining(hand, played).get(5)).toBe(4);
  });
});

/** B 组：累积器接线。 */
describe('usePlayedCards（累积器）', () => {
  beforeEach(() => {
    __resetPlayedCardsForTest();
  });

  afterEach(() => {
    stopGameSession();
  });

  function setupStore(initial?: PlayerView) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useGameStore();
    // 记牌器片：门控开启后累积器才工作（门控本身由 card-counter-gate 覆盖）。
    store.cardCounterEnabled = true;
    if (initial) {
      store.setRoom(initial.roomCode, initial.seat);
      store.applySnapshot(initial);
    }
    return store;
  }

  it('只累积 cards 非 null 的动作；pass（null）跳过', () => {
    setupStore(
      playerViewFixture({
        state: 'playing',
        recentActions: [
          { seat: 1, cards: makeCards(5, 5) }, // 出对 5
          { seat: 2, cards: null }, // 过牌
        ],
      }),
    );
    const tracker = usePlayedCards();
    // applySnapshot 同步写入；watch 是异步的 ⇒ flush
    return flushPromises().then(() => {
      expect(tracker.size).toBe(2);
      expect(tracker.has({ r: 5, s: 0 })).toBe(true);
      expect(tracker.has({ r: 5, s: 1 })).toBe(true);
      // 确保没有把 pass 当成空数组塞进去
      expect(tracker.size).toBe(2);
    });
  });

  it('换局（roomCode 变化）清空累积', () => {
    const store = setupStore(
      playerViewFixture({
        roomCode: 'ROOM_A',
        state: 'playing',
        recentActions: [{ seat: 1, cards: makeCards(7) }],
      }),
    );
    const tracker = usePlayedCards();
    return flushPromises()
      .then(() => {
        expect(tracker.size).toBe(1);
        // 换局
        store.setRoom('ROOM_B', 0);
        store.applySnapshot(
          playerViewFixture({ roomCode: 'ROOM_B', state: 'playing', recentActions: [] }),
        );
        return flushPromises();
      })
      .then(() => {
        expect(tracker.size, '换局 ⇒ 清空').toBe(0);
      });
  });
  it('牌桌卸载 → 换房重进：累积器仍工作（detached scope 回归）', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const store = useGameStore();
    store.cardCounterEnabled = true;
    store.setRoom('R1', 0);

    const w1 = mount(TablePage, { global: { plugins: [pinia] } });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          roomCode: 'R1',
          state: 'playing',
          seat: 0,
          hand: makeCards(3),
          recentActions: [{ seat: 1, cards: makeCards(5) }],
        }),
        1,
      ),
    );
    await flushPromises();
    const tracker = usePlayedCards();
    expect(tracker.has({ r: 5, s: 0 })).toBe(true);

    w1.unmount();
    store.setRoom('R2', 0);
    const w2 = mount(TablePage, { global: { plugins: [pinia] } });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          roomCode: 'R2',
          version: 2,
          state: 'playing',
          seat: 0,
          hand: makeCards(3),
          recentActions: [{ seat: 2, cards: makeCards(7) }],
        }),
        2,
      ),
    );
    await flushPromises();

    expect(tracker.has({ r: 5, s: 0 }), '换房后旧牌应清空').toBe(false);
    expect(tracker.has({ r: 7, s: 0 }), '重进后新牌仍应记录').toBe(true);
    w2.unmount();
    stopGameSession();
  });

  it('开关关闭 ⇒ 不累积；从开切到关 ⇒ 清空', () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useGameStore();
    store.cardCounterEnabled = false;
    store.setRoom('R1', 0);
    store.applySnapshot(
      playerViewFixture({
        state: 'playing',
        recentActions: [{ seat: 1, cards: makeCards(5) }],
      }),
    );
    const tracker = usePlayedCards();
    expect(tracker.size, '关闭时不累积').toBe(0);

    store.cardCounterEnabled = true;
    expect(tracker.size, '打开后开始累积').toBe(1);

    store.cardCounterEnabled = false;
    expect(tracker.size, '切到关 ⇒ 清空').toBe(0);
  });
});

/** C 组：组件渲染（左上角横条）。 */
describe('CardCounter.vue（左上角横条）', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    __resetPlayedCardsForTest();
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
  });

  function mountTable(mySeat = 0, enabled = true) {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const store = useGameStore();
    store.cardCounterEnabled = enabled;
    store.setRoom('ROOM1', mySeat);
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    return { wrapper, socket, store };
  }

  afterEach(() => {
    stopGameSession();
  });

  it('开关开：横条直接在顶栏，15 列倒序，剩余值/绝牌正确', async () => {
    const { wrapper, socket } = mountTable(0);
    // 我手里只有大王（不含 3）；座位 1 把 4 张 3 全打出 ⇒ 3 绝牌；大王在我手里（剩余 0 但非绝牌）
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 1,
          hand: makeCards(30),
          recentActions: [{ seat: 1, cards: makeCards(3, 3, 3, 3) }],
        }),
        1,
      ),
    );
    await flushPromises();

    // 有权益（旧服务端回退场景 gate=true）⇒ 横条直接显示，不需要按钮
    expect(wrapper.find('.counter').exists(), '横条直接在 DOM').toBe(true);
    expect(wrapper.find('.table__counter').exists(), '不再有按钮').toBe(false);

    const cols = wrapper.findAll('.counter__col');
    expect(cols, '15 列').toHaveLength(15);
    expect(cols.map((c) => c.find('.counter__rank').text())).toEqual([
      '大王', '小王', '2', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3',
    ]);

    // rank=3（最后一列）：手里 0 张 + 桌面 4 张 ⇒ 剩余 0 ⇒ 绝牌高亮
    const col3 = cols[14]!;
    expect(col3.find('.counter__remain').text()).toBe('0');
    expect(col3.classes()).toContain('counter__col--gone');

    // 大王列（第一列）：我手里 1 张 ⇒ 剩余 0，但手里有 ⇒ 非绝牌
    const colJoker = cols[0]!;
    expect(colJoker.find('.counter__remain').text()).toBe('0');
    expect(colJoker.classes()).not.toContain('counter__col--gone');
  });

  it('开关关：横条不在 DOM', () => {
    const { wrapper } = mountTable(0, false);
    expect(wrapper.find('.table__counter').exists()).toBe(false);
    expect(wrapper.find('.counter').exists()).toBe(false);
  });

  it('结算揭示 ⇒ 横条让位', async () => {
    const { wrapper, socket } = mountTable(0);
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({ state: 'playing', version: 2 }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    // 有 gate ⇒ 横条直接在 DOM
    expect(wrapper.find('.counter').exists(), '前提：横条直接在 DOM').toBe(true);

    socket.push(
      serverMessage(
        'game.settlement',
        {
          roomCode: 'ROOM01',
          baseScore: 100,
          winner: 'landlord',
          landlordSeat: 2,
          farmerSeats: [0, 1],
          multiplier: 4,
          spring: 'spring',
          landlordScoreChange: 777,
          farmerScoreChange: -388.5,
        },
        3,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.counter').exists()).toBe(false);
  });
});

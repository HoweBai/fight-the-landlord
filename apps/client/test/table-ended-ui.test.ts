/**
 * 切片 10 / Task F2：终局态 UI（R189 / N17）。
 *
 * 判别力说明（这里**不**断言谁赢，也不读 `winner` 拼结果文案 —— 那是 M07 的禁区）：
 *  ① `state === 'ended'` ⇒ 渲染 `.table__ended`（「本局结束」），且四个动作 class
 *     （`.table__play` / `.table__pass` / `.table__bid-grab` / `.table__bid-pass`）**一个都不存在**。
 *     断言的是「DOM 里没有该节点」，**不是**「点了没反应」（R115：jsdom 里点 disabled 是静默 no-op）。
 *  ② **正对照**：同一套装配先喂 `state === 'playing'` 且轮到我 ⇒ `.table__play`/`.table__pass`
 *     确实存在 ⇒ 证明选择器与夹具能观测到「存在」，「终局不存在」不是坏探针。
 *  ③ 终局**不渲染倒计时**：`store.actorSeat` 在 `ended` 下为 `null`（没有「下一步动作」，
 *     也就没有下一回合的 `turnDeadlineAt`）；正对照是「playing 且轮到我时倒计时确实在」。
 *
 * ⚠️ 夹具约束（读 `helpers/fake-socket.ts` 后收敛的）：
 *  - `playerViewFixture` 只做**顶层**覆盖；
 *  - `validateInbound` 强制 `hand.length === cardCounts[seat]` ⇒ `hand: []` 时第 `seat` 位必须是 0
 *    （夹具会按 `hand.length` 重算该位，写不写等价）；
 *  - 快照类消息的**载荷 version 必须等于信封 version**，否则协议层先抛。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PlayerView } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { FakeSocket, playerViewFixture, serverMessage, makeCards } from './helpers/fake-socket';

/** 四个动作按钮的稳定 class（R107/R189）。终局下它们必须**全部不存在**。 */
const ACTION_SELECTORS = ['.table__play', '.table__pass', '.table__bid-grab', '.table__bid-pass'] as const;

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  stopGameSession();
});

/**
 * 终局视图：`state='ended'` + `winner`（§4.2 / N17）。
 *
 * ⚠️ `winner` / `landlordSeat` 只作为**服务端下发的字段**出现；本用例集**不**用它推导任何文案。
 */
function endedView(over: Partial<PlayerView> = {}): PlayerView {
  return playerViewFixture({
    state: 'ended',
    version: 3,
    seat: 0,
    hand: [],
    cardCounts: [0, 17, 17],
    winner: 'landlord',
    landlordSeat: 0,
    currentPlayer: 0,
    turnDeadlineAt: Date.now() + 30_000,
    ...over,
  });
}

function playingView(over: Partial<PlayerView> = {}): PlayerView {
  return playerViewFixture({
    state: 'playing',
    version: 2,
    seat: 0,
    hand: makeCards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30, 3, 4),
    bottomCards: makeCards(3, 4, 5),
    landlordSeat: 0,
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: Date.now() + 30_000,
    ...over,
  });
}

function mountTable(mySeat = 0) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', mySeat);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}

describe('终局态 UI（N17 / R189）', () => {
  it('state=ended ⇒ 只显示「本局结束」，四个动作 class 一个都不存在', async () => {
    const { wrapper, socket, store } = mountTable(0);
    socket.push(serverMessage('game.state_update', endedView(), 3));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__ended').exists()).toBe(true);
    expect(store.isEnded).toBe(true);
    for (const selector of ACTION_SELECTORS) {
      expect(wrapper.find(selector).exists(), `${selector} 在终局不得存在`).toBe(false);
    }

    const bar = wrapper.find('.table__bar').text();
    expect(bar).not.toContain('出牌中');
    expect(bar).not.toContain('叫抢中');

    // phase 文字（叫抢中/出牌中/已结束）已从 bar 移到 .table__phase-overlay
    const overlay = wrapper.find('.table__phase-overlay');
    expect(overlay.exists()).toBe(true);
    expect(overlay.text()).toContain('已结束');
  });

  it('正对照：state=playing 且轮到我 ⇒ .table__play/.table__pass 存在（§R115：先证明探针能观测到「存在」）', async () => {
    const { wrapper, socket, store } = mountTable(0);
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, landlordSeat: 1 }), 2));
    await wrapper.vm.$nextTick();

    expect(store.isPlaying).toBe(true);
    expect(wrapper.find('.table__play').exists()).toBe(true);
    expect(wrapper.find('.table__pass').exists()).toBe(true);
    expect(wrapper.find('.table__ended').exists()).toBe(false);
  });

  it('终局不渲染倒计时（actorSeat 在 ended 下为 null）；正对照：playing 且轮到我时中央钟确实在', async () => {
    const { wrapper, socket } = mountTable(0);
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    // 正对照：倒计时探针在有回合时能观测到「在」
    // （2026-10-10 起我的钟在中央两按钮之间，座位上不再挂钟）
    expect(wrapper.find('.table__clock-value').exists()).toBe(true);
    expect(wrapper.find('.table__clock').exists()).toBe(true);

    socket.push(serverMessage('game.state_update', endedView(), 3));
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.turn-timer'), '终局没有「下一回合」⇒ 对手出牌/状态列不得挂迷你钟').toHaveLength(0);
    expect(wrapper.find('.table__clock').exists(), '终局中央钟也不得残留').toBe(false);
  });
});

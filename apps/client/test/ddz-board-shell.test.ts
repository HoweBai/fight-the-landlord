import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { PlayerView } from '@fight-the-landlord/protocol';
import DdzBoard from '../src/components/table/ddz/DdzBoard.vue';
import { playerViewFixture, makeCards } from './helpers/fake-socket';
import { bidPhase } from './helpers/bid-phase';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

/**
 * S5.2a（spec §4.10.2）：**shell / board 边界**。
 *
 * 判据：
 *  - `DdzBoard` 可独立挂载（只靠 props，不读 store），渲染斗地主牌桌并 emit 动作；
 *  - 动作边界：bid/play/pass/trustee/more/leave 全部上抛，board 不直接发送；
 *  - 壳 `table.vue` 持有 DdzBoard 与 #overlays 槽（结算/弹层/连接）；
 *  - 源码闸：board 不得 import store（防隐性重写）。
 */
const BOARD_PATH = 'src/components/table/ddz/DdzBoard.vue';

function boardProps(over: Partial<Record<string, unknown>> = {}) {
  return {
    view: playerViewFixture({
      seat: 0,
      hand: makeCards(3, 4),
      cardCounts: [2, 17, 17],
      currentPlayer: 0,
      recentActions: [],
    }) as PlayerView,
    mySeat: 0,
    seconds: 25,
    busy: false,
    interactive: true,
    settlementArrived: false,
    settlementRevealed: false,
    waitingForDeal: false,
    roomCode: 'ROOM1',
    seatNames: { 1: '甲', 2: '乙' },
    balances: [null, null, null],
    levelName: '休闲场',
    cardCounterGate: false,
    redealVisible: false,
    redealEpoch: 0,
    dealEnterMode: 'deal' as const,
    ...over,
  };
}

describe('S5.2a：DdzBoard（独立挂载 + 动作上抛）', () => {
  it('只靠 props 渲染牌桌（不读 store）：顶栏/中段/动作行/手牌都在', () => {
    const wrapper = mount(DdzBoard, { props: boardProps() });

    expect(wrapper.find('.table').exists()).toBe(true);
    expect(wrapper.find('.table__bar').exists()).toBe(true);
    expect(wrapper.find('.table__mid').exists()).toBe(true);
    expect(wrapper.find('.table__action-bar').exists()).toBe(true);
    expect(wrapper.findAll('.table__me .card')).toHaveLength(2);
    expect(wrapper.find('.table__lobby-back').exists()).toBe(true);
  });

  it('叫抢动作上抛（bid）：点击叫/抢与不叫', async () => {
    const view = playerViewFixture({
      seat: 0,
      state: 'bidding',
      bidPhase: bidPhase({ currentBidder: 0, kind: 'call' }),
    }) as PlayerView;
    const wrapper = mount(DdzBoard, { props: boardProps({ view }) });

    await wrapper.find('.table__bid-grab').trigger('click');
    await wrapper.find('.table__bid-pass').trigger('click');
    expect(wrapper.emitted('bid')).toEqual([[true], [false]]);
  });

  it('出牌/过牌动作上抛（play/pass）：board 不自己发送', async () => {
    const view = playerViewFixture({
      seat: 0,
      state: 'playing',
      hand: makeCards(3),
      cardCounts: [1, 17, 17],
      currentPlayer: 0,
      recentActions: [],
      landlordSeat: 0,
    }) as PlayerView;
    const wrapper = mount(DdzBoard, { props: boardProps({ view }) });

    await wrapper.find('.table__me .card').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('.table__play').trigger('click');
    expect(wrapper.emitted('play')).toEqual([[[{ r: 3, s: 0 }]]]);

    // 跟牌场景才有过牌按钮（地主首出不可过）；换一个非地主、跟牌视图
    const followView = playerViewFixture({
      seat: 1,
      state: 'playing',
      hand: makeCards(4),
      cardCounts: [17, 1, 17],
      currentPlayer: 1,
      landlordSeat: 0,
      recentActions: [{ seat: 0, cards: makeCards(3) }],
    }) as PlayerView;
    const follow = mount(DdzBoard, {
      props: boardProps({ view: followView, mySeat: 1 }),
    });
    await follow.find('.table__pass').trigger('click');
    expect(follow.emitted('pass')).toHaveLength(1);
  });

  it('托管 / 更多 / 返回大厅上抛（trustee/more/leave）', async () => {
    const wrapper = mount(DdzBoard, { props: boardProps() });

    await wrapper.find('.table__trustee').trigger('click');
    await wrapper.find('.table__more').trigger('click');
    await wrapper.find('.table__lobby-back').trigger('click');

    expect(wrapper.emitted('trustee')).toEqual([[true]]);
    expect(wrapper.emitted('more')).toHaveLength(1);
    expect(wrapper.emitted('leave')).toHaveLength(1);
  });

  it('结算揭示：动作行让位（按钮不在 DOM）、遮罩由壳的 slot 提供', async () => {
    const wrapper = mount(DdzBoard, {
      props: boardProps({ settlementArrived: true, settlementRevealed: true }),
      slots: { overlays: '<div class="shell-overlay-probe" />' },
    });

    expect(wrapper.find('.table__play').exists()).toBe(false);
    expect(wrapper.find('.shell-overlay-probe').exists()).toBe(true);
  });
});

describe('S5.2a：壳 / board 源码边界', () => {
  const sources = collectSourceFiles();

  it('board 不 import store（防隐性重写）', () => {
    const board = sources.find((f) => f.path === BOARD_PATH);
    expect(board, `扫描器必须真的读到 ${BOARD_PATH}`).toBeDefined();
    const code = stripComments(board!.content);
    expect(code).not.toMatch(/stores\/game/);
    expect(code).not.toMatch(/useGameStore/);
    expect(code).not.toMatch(/useAuthStore/);
  });

  it('壳持有 DdzBoard 与 #overlays 槽（结算/MoreMenu/连接），不直接渲染斗地主内容', () => {
    const shell = sources.find((f) => f.path === 'src/pages/table/table.vue');
    expect(shell).toBeDefined();
    const code = stripComments(shell!.content);
    expect(code).toMatch(/<DdzBoard/);
    expect(code).toMatch(/<template #overlays>/);
    // 斗地主的动作按钮/底牌不再长在壳里
    expect(code).not.toMatch(/table__bid-grab/);
    expect(code).not.toMatch(/filter\(\(i\) => hand\[i\]/);
  });
});

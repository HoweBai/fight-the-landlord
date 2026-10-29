import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import {
  DEFAULT_CHENGDU_RULES,
  type MahjongClaimOption,
  type MahjongPlayerView,
  type Tile,
} from '@fight-the-landlord/protocol';
import MahjongBoard from '../src/components/table/mahjong/MahjongBoard.vue';

/**
 * T11：MahjongBoard 的边界与动作上抛。
 *
 * 判据：
 *  - 只靠 props 渲染（不读 store），手牌/牌墙/座位信息都在；
 *  - 换三张（3 张同花色）/ 定缺 / 出牌 / 碰杠胡过 全部 emit（带窗口 id）；
 *  - 自摸窗口的「胡」映射成 `selfDrawHu`，杠按手牌/副露映射成暗杠或补杠。
 */
function tile(s: 0 | 1 | 2, r: number): Tile {
  return { s, r };
}

function view(over: Partial<MahjongPlayerView> = {}): MahjongPlayerView {
  return {
    roomCode: 'MJ1',
    gameType: 'mahjong',
    playerCount: 4,
    version: 1,
    state: 'play',
    baseScore: 1,
    seat: 0,
    hand: [
      tile(0, 1), tile(0, 1), tile(0, 1), tile(0, 1), tile(0, 2), tile(0, 3),
      tile(0, 4), tile(1, 5), tile(1, 5), tile(1, 6), tile(1, 7), tile(2, 8),
      tile(2, 9),
    ],
    cardCounts: [13, 13, 13, 13],
    trustees: [false, false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 1_700_000_030_000,
    activeSeats: [0],
    tingSeats: [],
    dealerSeat: 0,
    wallCount: 40,
    lackSuits: [0, 1, 2, null],
    melds: [[], [], [], []],
    discards: [[], [], [], []],
    isOut: [false, false, false, false],
    huInfos: [],
    claimsForMe: [],
    mahjongRules: DEFAULT_CHENGDU_RULES,
    revealedHands: [],
    windowId: 'turn:1',
    ...over,
  };
}

function props(over: Partial<Record<string, unknown>> = {}) {
  return {
    view: view(),
    mySeat: 0,
    seconds: 15,
    busy: false,
    interactive: true,
    settlementArrived: false,
    settlementRevealed: false,
    waitingForDeal: false,
    roomCode: 'MJ1',
    seatNames: { 1: '甲', 2: '乙', 3: '丙' },
    balances: [null, null, null, null],
    levelName: '休闲场',
    ...over,
  };
}

describe('T11：MahjongBoard（独立挂载 + 动作上抛）', () => {
  it('只靠 props 渲染：顶栏/牌墙/手牌/座位都在', () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    expect(wrapper.find('.mj').exists()).toBe(true);
    expect(wrapper.find('.mj__bar').exists()).toBe(true);
    expect(wrapper.findAll('.mj__hand .mj-tile')).toHaveLength(13);
    expect(wrapper.text()).toContain('牌墙 40');
    expect(wrapper.text()).toContain('底分 1');
  });

  it('换三张：选 3 张同花色后 emit exchange（带 windowId）', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ state: 'exchange', activeSeats: [0], windowId: 'exchange' }) }),
    });
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    await tiles[0]!.trigger('click');
    await tiles[1]!.trigger('click');
    await tiles[2]!.trigger('click');
    const confirm = wrapper.find('.mj__confirm');
    expect(confirm.attributes('disabled')).toBeUndefined();
    await confirm.trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({
      type: 'exchange',
      tiles: [tile(0, 1), tile(0, 1), tile(0, 1)],
    });
    expect(wrapper.emitted('mahjong')?.[0]?.[1]).toBe('exchange');
  });

  it('定缺：点「缺万」emit lack(0)', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ state: 'lack', activeSeats: [0], windowId: 'lack' }) }),
    });
    const btn = wrapper.findAll('button').find((b) => b.text().includes('缺万'))!;
    await btn.trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({ type: 'lack', suit: 0 });
  });

  it('出牌：选中一张手牌后 emit discard', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    const first = wrapper.findAll('.mj__hand .mj-tile')[0]!;
    await first.trigger('click');
    const discard = wrapper.find('.mj__discard');
    expect(discard.attributes('disabled')).toBeUndefined();
    await discard.trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({ type: 'discard', tile: tile(0, 1) });
    expect(wrapper.emitted('mahjong')?.[0]?.[1]).toBe('turn:1');
  });

  it('响应窗口：碰/过按钮来自 claimsForMe，emit claim（窗口 id 原样回传）', async () => {
    const claims: MahjongClaimOption[] = [{ claim: 'peng', tile: tile(0, 1) }, { claim: 'pass' }];
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'claim',
          activeSeats: [0],
          windowId: 'claim:3',
          claimsForMe: claims,
        }),
      }),
    });
    const peng = wrapper.findAll('button').find((b) => b.text() === '碰')!;
    await peng.trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]).toEqual([{ type: 'claim', claim: 'peng' }, 'claim:3']);
    const pass = wrapper.findAll('button').find((b) => b.text() === '过')!;
    await pass.trigger('click');
    expect(wrapper.emitted('mahjong')?.[1]).toEqual([{ type: 'claim', claim: 'pass' }, 'claim:3']);
  });

  it('自摸窗口：胡 ⇒ selfDrawHu；手上 4 张的杠 ⇒ concealedGang', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'play',
          activeSeats: [0],
          windowId: 'turn:5',
          claimsForMe: [{ claim: 'hu', tile: tile(0, 4) }, { claim: 'gang', tile: tile(0, 1) }],
        }),
      }),
    });
    const hu = wrapper.findAll('button').find((b) => b.text() === '自摸胡')!;
    await hu.trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({ type: 'selfDrawHu' });
    const gang = wrapper.findAll('button').find((b) => b.text() === '暗杠')!;
    await gang.trigger('click');
    expect(wrapper.emitted('mahjong')?.[1]?.[0]).toEqual({
      type: 'concealedGang',
      tile: tile(0, 1),
    });
  });

  describe('自己胡牌后：手牌不重复渲染', () => {
    it('myRevealed 不为空时，.mj__hand 隐藏，.mj__my-revealed 展示手牌', () => {
      const revealedTiles: Tile[] = [
        tile(0, 1), tile(0, 2), tile(0, 3), tile(0, 4), tile(0, 5), tile(0, 6),
        tile(0, 7), tile(0, 8), tile(0, 9), tile(1, 1), tile(1, 2), tile(1, 3), tile(1, 4),
      ];
      const wrapper = mount(MahjongBoard, {
        props: props({
          view: view({
            state: 'play',
            isOut: [true, false, false, false],
            huInfos: [{
              seat: 0,
              fromSeat: null,
              tile: tile(0, 5),
              fan: 1,
              multiplier: 1,
              items: ['平胡'],
              selfDraw: true,
            }],
            revealedHands: [
              { seat: 0, tiles: revealedTiles, huTile: tile(0, 5) },
            ],
            activeSeats: [1], // 只有对手在 action 中
          }),
        }),
      });
      // .mj__hand 应该隐藏
      expect(wrapper.find('.mj__hand').exists()).toBe(false);
      // .mj__my-revealed 应该展示 revealed tiles
      const revealed = wrapper.find('.mj__my-revealed');
      expect(revealed.exists()).toBe(true);
      expect(revealed.findAll('.mj-tile')).toHaveLength(revealedTiles.length);
    });

    it('没胡时，.mj__hand 正常显示手牌', () => {
      const wrapper = mount(MahjongBoard, { props: props() });
      expect(wrapper.find('.mj__hand').exists()).toBe(true);
      expect(wrapper.findAll('.mj__hand .mj-tile')).toHaveLength(13);
    });

    it('claim 阶段自己不 active 时，底部不重复显示 phaseText', () => {
      const wrapper = mount(MahjongBoard, {
        props: props({
          view: view({
            state: 'claim',
            activeSeats: [1, 2], // 自己不在 active 中
            windowId: 'claim:2',
          }),
        }),
      });
      // 中央应该有 phaseText
      expect(wrapper.find('.mj__phase').text()).toContain('等待其他玩家响应');
      // 底部动作栏不应该再出现同样的 muted text
      const actionMuted = wrapper.find('.mj__action .mj__muted');
      expect(actionMuted.exists()).toBe(false);
    });
  });
});

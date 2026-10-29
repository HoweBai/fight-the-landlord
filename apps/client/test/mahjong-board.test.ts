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
});
import { computed } from 'vue';
import { CANVAS_METRICS_KEY } from '../src/composables/useLandscapeCanvas';
import { mahjongTableLayout } from '../src/game/mahjong-layout';

describe('T12：四家分区重排', () => {
  it('四个座位卡、四个牌河、中央井', () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ cardCounts: [14, 10, 7, 0] }) }),
    });
    expect(wrapper.findAll('.mj-chip')).toHaveLength(4);
    expect(wrapper.findAll('.mj-river')).toHaveLength(4);
    expect(wrapper.find('.mj-center').text()).toContain('牌墙 40');
  });

  it('对手牌背数量与 src 逐座对位（不是只数个数）', () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ cardCounts: [14, 10, 7, 0] }) }),
    });
    // me=0：right=1 → 10，top=2 → 7，left=3 → 0
    expect(wrapper.findAll('.mj-backs-slot--right .mj-tile')).toHaveLength(10);
    expect(wrapper.findAll('.mj-backs-slot--top .mj-tile')).toHaveLength(7);
    expect(wrapper.findAll('.mj-backs-slot--left .mj-tile')).toHaveLength(0);
    for (const img of wrapper.findAll('.mj-backs-slot image')) {
      expect(img.attributes('src') ?? '').toMatch(/back\.png$/);
    }
  });

  it('提供画布尺寸时手牌尺寸与纯函数逐值一致', () => {
    // 用 4:3：s≈1.127，手牌 80.9×121.9；1623×750 的 s 与兜底同为 1，验不出注入
    const metrics = computed(() => ({ width: 1334, height: 1000, scale: 1 }));
    const wrapper = mount(MahjongBoard, {
      props: props(),
      global: { provide: { [CANVAS_METRICS_KEY]: metrics } },
    });
    const layout = mahjongTableLayout(1334, 1000);
    const first = wrapper.find('.mj__hand .mj-tile');
    expect(first.attributes('style')).toContain(`width: ${layout.hand.tile.w}px`);
    expect(first.attributes('style')).toContain(`height: ${layout.hand.tile.h}px`);
  });

  it('左右家已胡：牌河区亮牌；对家已胡：牌背位亮牌', () => {
    const leftHu = mount(MahjongBoard, {
      props: props({
        view: view({
          isOut: [false, false, false, true],
          revealedHands: [
            { seat: 3, tiles: [{ s: 0, r: 1 }, { s: 1, r: 2 }], huTile: { s: 1, r: 2 } },
          ],
        }),
      }),
    });
    expect(leftHu.find('.mj-river--left .mj-river__revealed').exists()).toBe(true);
    expect(leftHu.findAll('.mj-backs-slot--left .mj-tile')).toHaveLength(0);

    const topHu = mount(MahjongBoard, {
      props: props({
        view: view({
          isOut: [false, false, true, false],
          revealedHands: [
            { seat: 2, tiles: [{ s: 0, r: 1 }, { s: 1, r: 2 }], huTile: { s: 1, r: 2 } },
          ],
        }),
      }),
    });
    const topTiles = topHu.findAll('.mj-backs-slot--top .mj-tile');
    expect(topTiles).toHaveLength(2);
    expect(topTiles[0]!.attributes('src') ?? '').not.toMatch(/back\.png$/);
  });

  it('claim 窗口点击弃牌过滤，再点同一张取消', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'claim',
          activeSeats: [0],
          windowId: 'claim:9',
          claimsForMe: [
            { claim: 'peng', tile: { s: 0, r: 1 } },
            { claim: 'hu', tile: { s: 1, r: 1 }, fan: 2 },
          ],
          discards: [[], [], [{ s: 0, r: 1 }], []],
        }),
      }),
    });
    const topTile = wrapper.find('.mj-river--top .mj-tile');
    await topTile.trigger('click');
    expect(wrapper.findAll('.mj-claim-tile__opt').map((b) => b.text())).toEqual(['碰']);
    await topTile.trigger('click');
    const all = wrapper.findAll('.mj-claim-tile__opt').map((b) => b.text());
    expect(all).toContain('碰');
    expect(all).toContain('2 番胡');
  });
});
import { nextTick } from 'vue';

describe('T13：摸牌分离与 display 下标', () => {
  const baseHand = view().hand;

  it('13→14：新增牌移到行尾并标 drawn', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.setProps({
      view: view({ hand: [...baseHand, { s: 1, r: 9 }] }),
    });
    await nextTick();
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    expect(tiles).toHaveLength(14);
    const last = tiles[tiles.length - 1]!;
    expect(last.classes()).toContain('mj__hand-tile--drawn');
    expect(last.attributes('aria-label')).toBe('筒9');
  });

  it('14→13 / 13→13 不标 drawn', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ hand: [...baseHand, { s: 1, r: 9 }] }) }),
    });
    await wrapper.setProps({ view: view({ hand: baseHand }) });
    await nextTick();
    expect(wrapper.findAll('.mj__hand-tile--drawn')).toHaveLength(0);
  });

  it('点行尾摸牌再出牌，emit 的是那张摸牌（不是下标错位）', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.setProps({ view: view({ hand: [...baseHand, { s: 1, r: 9 }] }) });
    await nextTick();
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    await tiles[tiles.length - 1]!.trigger('click');
    await wrapper.find('.mj__discard').trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({
      type: 'discard',
      tile: { s: 1, r: 9 },
    });
  });

  it('换三张仍按 display 下标选牌', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ state: 'exchange', activeSeats: [0], windowId: 'exchange' }) }),
    });
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    await tiles[0]!.trigger('click');
    await tiles[1]!.trigger('click');
    await tiles[2]!.trigger('click');
    await wrapper.find('.mj__confirm').trigger('click');
    const emitted = wrapper.emitted('mahjong')?.[0]?.[0] as { tiles: unknown[] };
    expect(emitted.tiles).toHaveLength(3);
  });
});

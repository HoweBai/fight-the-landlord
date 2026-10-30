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
    for (const d of ['top', 'left', 'right', 'my']) {
      expect(wrapper.find(`.mj-river--${d}`).exists()).toBe(true);
    }
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

  it('跨座位同型副露不互相触发 pop', async () => {
    const meld = { kind: 'peng' as const, tiles: [tile(0, 1), tile(0, 1), tile(0, 1)] };
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ melds: [[], [], [meld], []] }) }),
    });
    expect(wrapper.findAll('.anim-meld-pop')).toHaveLength(0);
    await wrapper.setProps({ view: view({ melds: [[], [], [meld], [meld]] }) });
    await nextTick();
    expect(wrapper.find('.mj-melds-slot--left .anim-meld-pop').exists()).toBe(true);
    expect(wrapper.find('.mj-melds-slot--top-right .anim-meld-pop').exists()).toBe(false);
  });

  it('自己已胡：手牌行显示亮牌且不可选', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          isOut: [true, false, false, false],
          revealedHands: [
            { seat: 0, tiles: [{ s: 0, r: 1 }, { s: 1, r: 2 }], huTile: { s: 1, r: 2 } },
          ],
        }),
      }),
    });
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]!.attributes('src') ?? '').not.toMatch(/back.png$/);
    await tiles[0]!.trigger('click');
    expect(wrapper.find('.mj__discard').attributes('disabled')).toBeDefined();
  });

  it('结束态只出现一次「本局结束」', () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ state: 'ended', activeSeats: [] }) }),
    });
    const matches = wrapper.find('.mj-center').text().match(/本局结束/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('claim 窗口只响应来源座弃牌，再点同一张取消', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'claim',
          currentPlayer: 2,
          activeSeats: [0],
          windowId: 'claim:9',
          claimsForMe: [
            { claim: 'peng', tile: { s: 0, r: 1 } },
            { claim: 'hu', tile: { s: 1, r: 1 }, fan: 2 },
          ],
          discards: [[{ s: 0, r: 1 }], [], [{ s: 0, r: 1 }], []],
        }),
      }),
    });
    // 自家弃牌不是本次 claim 来源：点击不过滤
    await wrapper.find('.mj-river--my .mj-tile').trigger('click');
    const before = wrapper.findAll('.mj-claim-tile__opt').map((b) => b.text());
    expect(before).toContain('碰');
    expect(before).toContain('2 番胡');
    // 来源座（对家）弃牌：过滤到只剩碰
    const topTile = wrapper.find('.mj-river--top .mj-tile');
    await topTile.trigger('click');
    expect(wrapper.findAll('.mj-claim-tile__opt').map((b) => b.text())).toEqual(['碰']);
    await topTile.trigger('click');
    const all = wrapper.findAll('.mj-claim-tile__opt').map((b) => b.text());
    expect(all).toContain('碰');
    expect(all).toContain('2 番胡');
  });

  it('四道与信息格 rect 与纯函数逐值一致（1334×1000）', () => {
    const metrics = computed(() => ({ width: 1334, height: 1000, scale: 1 }));
    const wrapper = mount(MahjongBoard, {
      props: props(),
      global: { provide: { [CANVAS_METRICS_KEY]: metrics } },
    });
    const l = mahjongTableLayout(1334, 1000);
    const expectRect = (
      sel: string,
      r: { left: number; top: number; width: number; height: number },
    ) => {
      const el = wrapper.find(sel);
      expect(el.exists(), sel).toBe(true);
      expect(el.attributes('style'), sel).toContain(`left: ${r.left}px`);
      expect(el.attributes('style'), sel).toContain(`top: ${r.top}px`);
      expect(el.attributes('style'), sel).toContain(`width: ${r.width}px`);
      expect(el.attributes('style'), sel).toContain(`height: ${r.height}px`);
    };
    expectRect('.mj-river-slot--top', l.topLane.rect);
    expectRect('.mj-river-slot--left', l.leftLane.rect);
    expectRect('.mj-river-slot--right', l.rightLane.rect);
    expectRect('.mj-river-slot--self', l.bottomLane.rect);
    expectRect('.mj-info-slot', l.info);
    expect(wrapper.find('.mj-info-slot').text()).toContain('牌墙 40');
  });

  it('claim 窗口只有来源道带 source 类', () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'claim',
          currentPlayer: 2,
          activeSeats: [0],
          claimsForMe: [{ claim: 'peng', tile: tile(0, 1) }],
        }),
      }),
    });
    expect(wrapper.find('.mj-river--top').classes()).toContain('mj-river--source');
    expect(wrapper.find('.mj-river--left').classes()).not.toContain('mj-river--source');
    expect(wrapper.find('.mj-river--my').classes()).not.toContain('mj-river--source');
  });

  it('1334×833 对家 4 杠：下移条存在、两翼不渲染（互斥）', () => {
    const metrics = computed(() => ({ width: 1334, height: 833, scale: 1 }));
    const gang = { kind: 'gang' as const, tiles: [tile(0, 1), tile(0, 1), tile(0, 1), tile(0, 2)] };
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ melds: [[], [], [gang, gang, gang, gang], []] }) }),
      global: { provide: { [CANVAS_METRICS_KEY]: metrics } },
    });
    expect(wrapper.find('.mj-melds-slot--top-below').exists()).toBe(true);
    expect(wrapper.find('.mj-melds-slot--top-right').exists()).toBe(false);
    expect(wrapper.find('.mj-melds-slot--top-left').exists()).toBe(false);
    const l = mahjongTableLayout(1334, 833, {
      top: { discards: 0, melds: 4, gangMelds: 4 },
      self: { discards: 0, melds: 0 },
    });
    const below = wrapper.find('.mj-melds-slot--top-below');
    expect(below.attributes('style')).toContain(`left: ${l.topMelds.below.rect.left}px`);
    expect(below.attributes('style')).toContain(`width: ${l.topMelds.below.rect.width}px`);
  });

  it('对家 3 组副露：右翼拿前 2 组、左翼拿其余（分翼按顺序）', () => {
    const peng = { kind: 'peng' as const, tiles: [tile(0, 1), tile(0, 1), tile(0, 1)] };
    const gang = { kind: 'gang' as const, tiles: [tile(1, 2), tile(1, 2), tile(1, 2), tile(1, 3)] };
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ melds: [[], [], [peng, gang, peng], []] }) }),
    });
    expect(wrapper.findAll('.mj-melds-slot--top-right .mj-strip__group')).toHaveLength(2);
    expect(wrapper.findAll('.mj-melds-slot--top-left .mj-strip__group')).toHaveLength(1);
    expect(wrapper.find('.mj-melds-slot--top-below').exists()).toBe(false);
  });
});
import { nextTick } from 'vue';

describe('T13：摸牌分离与 display 下标', () => {
  const baseHand = view().hand;

  it('13→14：新增牌移到行尾并标 drawn', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.setProps({
      view: view({ hand: [...baseHand, tile(1, 9)] }),
    });
    await nextTick();
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    expect(tiles).toHaveLength(14);
    const last = tiles[tiles.length - 1]!;
    expect(last.classes()).toContain('mj__hand-tile--drawn');
    expect(last.attributes('aria-label')).toBe('筒9');
    const layout = mahjongTableLayout(1334, 750);
    expect(last.attributes('style')).toContain(
      `margin-left: ${layout.hand.drawnGap - layout.hand.gap}px`,
    );
  });

  it('13→14 标出后丢一张非摸牌 → 标记消失；13→13 不标', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.setProps({ view: view({ hand: [...baseHand, tile(1, 9)] }) });
    await nextTick();
    expect(wrapper.findAll('.mj__hand-tile--drawn')).toHaveLength(1);
    // 去掉一张非摸牌（排序后第一张 wan1），手牌回到 13
    const afterDiscard = [...baseHand.slice(1), tile(1, 9)];
    await wrapper.setProps({ view: view({ hand: afterDiscard }) });
    await nextTick();
    expect(wrapper.findAll('.mj__hand-tile--drawn')).toHaveLength(0);
    // 13→13 同内容不标
    await wrapper.setProps({ view: view({ hand: afterDiscard }) });
    await nextTick();
    expect(wrapper.findAll('.mj__hand-tile--drawn')).toHaveLength(0);
  });

  it('同内容新版本不清摸牌标记，选中行尾摸牌仍出同一张', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    const hand14 = [...baseHand, tile(1, 9)];
    await wrapper.setProps({ view: view({ hand: hand14 }) });
    await nextTick();
    await wrapper.findAll('.mj__hand .mj-tile')[13]!.trigger('click');
    // 同内容、不同对象的新 version 包（模拟别人托管/resync）
    await wrapper.setProps({ view: view({ hand: [...hand14] }) });
    await nextTick();
    expect(wrapper.findAll('.mj__hand-tile--drawn')).toHaveLength(1);
    expect(wrapper.find('.mj__discard').attributes('disabled')).toBeUndefined();
    await wrapper.find('.mj__discard').trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({
      type: 'discard',
      tile: { s: 1, r: 9 },
    });
  });

  it('同内容新版本不清选择，选中非摸牌仍出同一张', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    const hand14 = [...baseHand, tile(1, 9)];
    await wrapper.setProps({ view: view({ hand: hand14 }) });
    await nextTick();
    await wrapper.findAll('.mj__hand .mj-tile')[0]!.trigger('click');
    await wrapper.setProps({ view: view({ hand: [...hand14] }) });
    await nextTick();
    await wrapper.find('.mj__discard').trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({
      type: 'discard',
      tile: baseHand[0],
    });
  });

  it('点行尾摸牌再出牌，emit 的是那张摸牌（不是下标错位）', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.setProps({ view: view({ hand: [...baseHand, tile(1, 9)] }) });
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

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, nextTick } from 'vue';
import {
  DEFAULT_CHENGDU_RULES,
  type MahjongClaimOption,
  type MahjongHuInfo,
  type MahjongMeldView,
  type MahjongPlayerView,
  type Tile,
} from '@fight-the-landlord/protocol';
import MahjongBoard from '../src/components/table/mahjong/MahjongBoard.vue';
import MahjongActionBar from '../src/components/table/mahjong/MahjongActionBar.vue';
import MahjongHuBanner from '../src/components/table/mahjong/MahjongHuBanner.vue';
import MahjongRiver from '../src/components/table/mahjong/MahjongRiver.vue';
import { CANVAS_METRICS_KEY } from '../src/composables/useLandscapeCanvas';
import { mahjongTableLayoutV2 } from '../src/game/mahjong-layout-v2';

/**
 * Task 8：MahjongBoard v2 装配与交互契约。
 *
 * 判据：
 *  - 只靠 props 渲染（不读 store）：血战盘 / 四座位 / 四河 / 手牌 / 动作区；
 *  - 全部动作经 MahjongActionBar 上抛（带窗口 id）；
 *  - claimed 过滤 + claimSourceIndex（来源座最后一枚可点、rob 无点击）；
 *  - lastDiscardAbs 映射（碰后不亮旧牌，再出牌亮新牌）；
 *  - dealEpoch/dealNonce 发牌动画契约；bannerSeq + reduced-motion 出队。
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

function hu(seat: number, fan = 1): MahjongHuInfo {
  return {
    seat,
    fromSeat: null,
    tile: tile(0, 5),
    fan,
    multiplier: 1,
    items: ['平胡'],
    selfDraw: true,
  };
}

const PENG_5: MahjongMeldView = {
  kind: 'peng',
  tiles: [tile(0, 5), tile(0, 5), tile(0, 5)],
  fromSeat: 0,
};

type Wrapper = ReturnType<typeof mount>;

function buttonByText(wrapper: Wrapper, text: string) {
  const btn = wrapper.findAll('.mj-action-bar button').find((b) => b.text() === text);
  expect(btn, `动作区按钮「${text}」`).toBeDefined();
  return btn!;
}

function buttonTexts(wrapper: Wrapper): string[] {
  return wrapper.findAll('.mj-action-bar button').map((b) => b.text());
}

describe('MahjongBoard：装配与动作上抛', () => {
  it('只靠 props 渲染：顶栏（返回/房间/场次/底分）/血战盘/四座位/四河/手牌', () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    expect(wrapper.find('.mj').exists()).toBe(true);
    expect(wrapper.find('.mj__bar').exists()).toBe(true);
    expect(wrapper.find('.mj__back').exists()).toBe(true);
    expect(wrapper.text()).toContain('MJ1');
    expect(wrapper.text()).toContain('底分 1');
    expect(wrapper.text()).toContain('休闲场');
    expect(wrapper.find('.mj-hub').text()).toContain('40');
    expect(wrapper.findAll('.mj-chip')).toHaveLength(4);
    expect(wrapper.findAll('.mj-river')).toHaveLength(4);
    for (const d of ['top', 'left', 'right', 'my']) {
      expect(wrapper.find(`.mj-river--${d}`).exists()).toBe(true);
    }
    expect(wrapper.findAll('.mj__hand .mj-tile')).toHaveLength(13);
    // 旧中央井/ClaimTile 已删除
    expect(wrapper.find('.mj-center').exists()).toBe(false);
    expect(wrapper.find('.mj-claim-tile').exists()).toBe(false);
  });

  it('返回按钮 emit leave', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.find('.mj__back').trigger('click');
    expect(wrapper.emitted('leave')).toHaveLength(1);
  });

  it('换三张：选 3 张同花色后 emit exchange（带 windowId）', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ state: 'exchange', activeSeats: [0], windowId: 'exchange' }) }),
    });
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    await tiles[0]!.trigger('click');
    await tiles[1]!.trigger('click');
    await tiles[2]!.trigger('click');
    const confirm = buttonByText(wrapper, '换三张');
    expect(confirm.attributes('disabled')).toBeUndefined();
    await confirm.trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({
      type: 'exchange',
      tiles: [tile(0, 1), tile(0, 1), tile(0, 1)],
    });
    expect(wrapper.emitted('mahjong')?.[0]?.[1]).toBe('exchange');
  });

  it('定缺：点「万」emit lack(0)', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ state: 'lack', activeSeats: [0], windowId: 'lack' }) }),
    });
    const btn = wrapper.findAll('button').find((b) => b.text().startsWith('万'))!;
    expect(btn).toBeDefined();
    await btn.trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({ type: 'lack', suit: 0 });
  });

  it('出牌：选中一张手牌后点「出牌」emit discard', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    const first = wrapper.findAll('.mj__hand .mj-tile')[0]!;
    await first.trigger('click');
    const discard = buttonByText(wrapper, '出牌');
    await discard.trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({ type: 'discard', tile: tile(0, 1) });
    expect(wrapper.emitted('mahjong')?.[0]?.[1]).toBe('turn:1');
  });

  it('手牌点选：可选时 emit select（换三张多选 / 出牌单击与双击）；不可选时不 emit', async () => {
    // 出牌窗口：单击 / 双击（400ms 内同一张）都先 emit select（选牌音效由页面接线）
    const wrapper = mount(MahjongBoard, { props: props() });
    const first = wrapper.findAll('.mj__hand .mj-tile')[0]!;
    await first.trigger('click');
    expect(wrapper.emitted('select')).toHaveLength(1);
    await first.trigger('click'); // 双击 ⇒ 出牌路径，select 仍要 emit
    expect(wrapper.emitted('select')).toHaveLength(2);
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({ type: 'discard', tile: tile(0, 1) });

    // 换三张：多选路径同样 emit select
    const exchange = mount(MahjongBoard, {
      props: props({ view: view({ state: 'exchange', activeSeats: [0], windowId: 'exchange' }) }),
    });
    await exchange.findAll('.mj__hand .mj-tile')[0]!.trigger('click');
    expect(exchange.emitted('select')).toHaveLength(1);

    // 不可选（interactive=false）⇒ 一次都不 emit
    const locked = mount(MahjongBoard, { props: props({ interactive: false }) });
    await locked.findAll('.mj__hand .mj-tile')[0]!.trigger('click');
    expect(locked.emitted('select')).toBeUndefined();
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
    await buttonByText(wrapper, '碰').trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]).toEqual([{ type: 'claim', claim: 'peng' }, 'claim:3']);
    await buttonByText(wrapper, '过').trigger('click');
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
    await buttonByText(wrapper, '胡').trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]?.[0]).toEqual({ type: 'selfDrawHu' });
    await buttonByText(wrapper, '杠').trigger('click');
    expect(wrapper.emitted('mahjong')?.[1]?.[0]).toEqual({
      type: 'concealedGang',
      tile: tile(0, 1),
    });
  });

  it('claim 阶段自己不 active：血战盘显示等待文案，动作区不渲染', () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'claim',
          activeSeats: [1, 2],
          windowId: 'claim:2',
        }),
      }),
    });
    expect(wrapper.find('.mj-hub__status').text()).toContain('等待响应');
    expect(wrapper.find('.mj-action-bar').exists()).toBe(false);
  });

  it('结束态「本局结束」只出现一次；有胡家时显示已胡 N 家', () => {
    const ended = mount(MahjongBoard, {
      props: props({ view: view({ state: 'ended', activeSeats: [] }) }),
    });
    expect(ended.find('.mj-hub__status').text()).toBe('本局结束');
    expect((ended.text().match(/本局结束/g) ?? [])).toHaveLength(1);

    const withHu = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'ended',
          activeSeats: [],
          isOut: [true, false, true, false],
          huInfos: [hu(0), hu(2)],
        }),
      }),
    });
    expect(withHu.find('.mj-hub__status').text()).toBe('已胡 2 家');
  });

  describe('自己胡牌后：手牌不重复渲染', () => {
    it('myRevealed 不为空时，.mj__hand 展示亮牌且不可选', async () => {
      const revealedTiles: Tile[] = [
        tile(0, 1), tile(0, 2), tile(0, 3), tile(0, 4), tile(0, 5), tile(0, 6),
        tile(0, 7), tile(0, 8), tile(0, 9), tile(1, 1), tile(1, 2), tile(1, 3), tile(1, 4),
      ];
      const wrapper = mount(MahjongBoard, {
        props: props({
          view: view({
            state: 'play',
            isOut: [true, false, false, false],
            huInfos: [hu(0, 1)],
            revealedHands: [{ seat: 0, tiles: revealedTiles, huTile: tile(0, 5) }],
            activeSeats: [1],
          }),
        }),
      });
      expect(wrapper.find('.mj__hand').exists()).toBe(true);
      expect(wrapper.findAll('.mj__hand .mj-tile')).toHaveLength(revealedTiles.length);
      expect(wrapper.findAll('.mj__hand .anim-deal-in-radial')).toHaveLength(0);
      await wrapper.findAll('.mj__hand .mj-tile')[0]!.trigger('click');
      expect(wrapper.findAll('.mj-tile--selected')).toHaveLength(0);
      expect(wrapper.emitted('mahjong')).toBeUndefined();
    });
  });
});

describe('MahjongBoard：牌河契约（claimed / claimSource / lastDiscard）', () => {
  it('claim 保护来源河最后一张：只渲染 [3万,5万]，最后一枚描边可点，点旧牌不改选项', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'claim',
          currentPlayer: 0,
          activeSeats: [0],
          windowId: 'claim:0',
          discards: [[tile(0, 5), tile(0, 3), tile(0, 5)], [], [], []],
          melds: [[], [PENG_5], [], []],
          claimsForMe: [{ claim: 'peng', tile: tile(0, 5) }],
        }),
      }),
    });
    const tiles = wrapper.findAll('.mj-river--my .mj-tile');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]!.attributes('aria-label')).toBe('万3');
    expect(tiles[1]!.attributes('aria-label')).toBe('万5');
    expect(tiles[1]!.classes()).toContain('mj-river__tile--latest');
    expect(tiles[1]!.classes()).toContain('mj-river__tile--filtered');
    expect(tiles[0]!.classes()).not.toContain('mj-river__tile--filtered');

    // 河级/窗口契约
    const ownRiver = wrapper
      .findAllComponents(MahjongRiver)
      .find((r) => r.classes().includes('mj-river--my'))!;
    expect(ownRiver.props('interactive')).toBe(true);
    expect(ownRiver.props('claimSourceIndex')).toBe(1);
    expect(ownRiver.props('windowStart')).toBe(0);
    expect(ownRiver.props('windowCount')).toBe(2);
    expect(ownRiver.props('latestIndex')).toBe(1);

    // 碰选项仍在；点旧牌（3万）不改选项、不上抛。
    expect(buttonTexts(wrapper)).toContain('碰');
    await tiles[0]!.trigger('click');
    expect(wrapper.emitted('mahjong')).toBeUndefined();
    expect(buttonTexts(wrapper)).toContain('碰');
  });

  it('claim 来源牌点击 toggle：点来源保持碰、再点清除；点旧牌无效果', async () => {
    const claims: MahjongClaimOption[] = [
      { claim: 'peng', tile: tile(0, 5) },
      { claim: 'pass' },
    ];
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'claim',
          currentPlayer: 0,
          activeSeats: [0],
          windowId: 'claim:0',
          discards: [[tile(0, 5), tile(0, 3), tile(0, 5)], [], [], []],
          melds: [[], [PENG_5], [], []],
          claimsForMe: claims,
        }),
      }),
    });
    const tiles = wrapper.findAll('.mj-river--my .mj-tile');
    expect(tiles).toHaveLength(2);
    const older = tiles[0]!; // 3万：旧牌，不可点
    const source = tiles[1]!; // 5万：claim 来源

    const barOptions = () =>
      wrapper.findComponent(MahjongActionBar).props('options') as MahjongClaimOption[];

    // 初始：全量 options（pass 无 tile，toggle 后会被过滤；过按钮由 showPass 单独渲染）。
    expect(barOptions()).toHaveLength(2);

    // 第一次点来源牌：toggle 生效，碰仍在（同型选项保留）。
    await source.trigger('click');
    expect(barOptions()).toEqual([{ claim: 'peng', tile: tile(0, 5) }]);
    expect(buttonTexts(wrapper)).toContain('碰');

    // 再点同型来源牌：toggle 清除，options 回到全量。
    await source.trigger('click');
    expect(barOptions()).toHaveLength(2);

    // 点旧牌（非来源）：River 不 emit，options 不变、无动作上抛。
    await older.trigger('click');
    expect(barOptions()).toHaveLength(2);
    expect(wrapper.emitted('mahjong')).toBeUndefined();

    // toggle 后碰仍可正常上抛（带窗口 id）。
    await source.trigger('click');
    await buttonByText(wrapper, '碰').trigger('click');
    expect(wrapper.emitted('mahjong')?.[0]).toEqual([{ type: 'claim', claim: 'peng' }, 'claim:0']);
  });

  it('rob 窗口（生产形态 state=claim + windowId=rob:N）：无河牌可点，胡按钮显示待响应牌、无过', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'claim',
          currentPlayer: 1,
          activeSeats: [0],
          windowId: 'rob:1',
          discards: [[tile(0, 5)], [], [tile(0, 3)], []],
          melds: [[], [PENG_5], [], []],
          claimsForMe: [{ claim: 'hu', tile: tile(0, 5) }],
        }),
      }),
    });
    for (const river of wrapper.findAllComponents(MahjongRiver)) {
      expect(river.props('interactive')).toBe(false);
      expect(river.props('claimSourceIndex')).toBeNull();
    }
    const riverTile = wrapper.find('.mj-river--top .mj-tile');
    expect(riverTile.exists()).toBe(true);
    await riverTile.trigger('click');
    expect(wrapper.emitted('mahjong')).toBeUndefined();

    expect(buttonTexts(wrapper)).toEqual(['胡 5万']);
    expect(wrapper.findAll('button').some((b) => b.text() === '过')).toBe(false);
  });

  it('强制胡（options 只有 hu）：不渲染「过」', () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          state: 'claim',
          currentPlayer: 1,
          activeSeats: [0],
          windowId: 'claim:1',
          claimsForMe: [{ claim: 'hu', tile: tile(0, 5) }],
        }),
      }),
    });
    expect(buttonTexts(wrapper)).toEqual(['胡 5万']);
    expect(wrapper.findAll('button').some((b) => b.text() === '过')).toBe(false);
  });

  it('碰后旧牌不亮：碰走 5 万后该座河清空，下一次出 4 万亮新牌', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ discards: [[tile(0, 5)], [], [], []] }) }),
    });
    expect(wrapper.findAll('.mj-river--my .mj-tile')).toHaveLength(1);
    expect(wrapper.find('.mj-river--my .mj-river__tile--latest').exists()).toBe(true);

    // view B：同一弃牌被碰走（server discards 不变，visible 变 0）→ 不亮旧牌。
    await wrapper.setProps({
      view: view({
        version: 2,
        discards: [[tile(0, 5)], [], [], []],
        melds: [[], [PENG_5], [], []],
      }),
    });
    await nextTick();
    expect(wrapper.findAll('.mj-river--my .mj-tile')).toHaveLength(0);
    expect(wrapper.find('.mj-river--my .mj-river__tile--latest').exists()).toBe(false);

    // view C：同座再出 4 万 → 高亮在新牌。
    await wrapper.setProps({
      view: view({
        version: 3,
        discards: [[tile(0, 5), tile(0, 4)], [], [], []],
        melds: [[], [PENG_5], [], []],
      }),
    });
    await nextTick();
    const tiles = wrapper.findAll('.mj-river--my .mj-tile');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.attributes('aria-label')).toBe('万4');
    expect(tiles[0]!.classes()).toContain('mj-river__tile--latest');
  });

  it('peng→addedGang（单组 gang 保留 fromSeat）只隐藏 1 张', () => {
    const wrapper = mount(MahjongBoard, {
      props: props({
        view: view({
          discards: [[tile(0, 5), tile(0, 5)], [], [], []],
          melds: [
            [],
            [{ kind: 'gang', tiles: [tile(0, 5), tile(0, 5), tile(0, 5), tile(0, 5)], fromSeat: 0 }],
            [],
            [],
          ],
        }),
      }),
    });
    // server 2 张 − 1 张被杠走 = 可见 1 张
    expect(wrapper.findAll('.mj-river--my .mj-tile')).toHaveLength(1);
  });
});

describe('MahjongBoard：发牌 dealEpoch / dealNonce', () => {
  it('v1 exchange 挂载：手牌播发牌动画', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ version: 1, state: 'exchange', activeSeats: [0], windowId: 'exchange' }) }),
    });
    await nextTick();
    expect(wrapper.findAll('.mj__hand .mj-tile')).toHaveLength(13);
    expect(wrapper.findAll('.mj__hand .anim-deal-in-radial')).toHaveLength(13);
  });

  it('v1 lack 挂载：同样播发牌动画', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ version: 1, state: 'lack', activeSeats: [0], windowId: 'lack' }) }),
    });
    await nextTick();
    expect(wrapper.findAll('.mj__hand .anim-deal-in-radial')).toHaveLength(13);
  });

  it('v5 play 挂载（中途进房/重连）：不播', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ version: 5, state: 'play' }) }),
    });
    await nextTick();
    expect(wrapper.findAll('.mj__hand .anim-deal-in-radial')).toHaveLength(0);
  });

  it('第二局新挂载（v1 exchange）重新播', async () => {
    const first = mount(MahjongBoard, {
      props: props({ view: view({ version: 5, state: 'play' }) }),
    });
    await nextTick();
    expect(first.findAll('.mj__hand .anim-deal-in-radial')).toHaveLength(0);
    const second = mount(MahjongBoard, {
      props: props({ view: view({ version: 1, state: 'exchange', activeSeats: [0], windowId: 'exchange' }) }),
    });
    await nextTick();
    expect(second.findAll('.mj__hand .anim-deal-in-radial')).toHaveLength(13);
  });

  it('摸牌位不带发牌类（v1 exchange → play 摸牌）', async () => {
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ version: 1, state: 'exchange', activeSeats: [0], windowId: 'exchange' }) }),
    });
    await nextTick();
    await wrapper.setProps({ view: view({ version: 2, state: 'play', hand: [...view().hand, tile(1, 9)] }) });
    await nextTick();
    const drawn = wrapper.findAll('.mj__hand .mj-tile').at(-1)!;
    expect(drawn.classes()).toContain('mj__hand-tile--drawn');
    expect(drawn.classes()).not.toContain('anim-deal-in-radial');
  });
});

describe('MahjongBoard：胡牌 banner（bannerSeq + reduced-motion）', () => {
  it('双胡：两条依次出队，第二条锚点不同（新节点）', async () => {
    const wrapper = mount(MahjongBoard, { props: props({ view: view({ huInfos: [] }) }) });
    await wrapper.setProps({ view: view({ version: 2, huInfos: [hu(0), hu(2)] }) });
    await nextTick();
    expect(wrapper.findAll('.mj-hu-banner')).toHaveLength(1);
    const firstEl = wrapper.find('.mj-hu-banner').element;
    const firstStyle = wrapper.find('.mj-hu-banner').attributes('style');
    wrapper.findComponent(MahjongHuBanner).vm.$emit('done');
    await nextTick();
    expect(wrapper.findAll('.mj-hu-banner')).toHaveLength(1);
    // bannerSeq 递增 ⇒ 新节点（不同 key），第二条锚点也不同。
    expect(wrapper.find('.mj-hu-banner').element).not.toBe(firstEl);
    expect(wrapper.find('.mj-hu-banner').attributes('style')).not.toBe(firstStyle);
  });

  it('settlementArrived 不截断正常动画', async () => {
    const wrapper = mount(MahjongBoard, { props: props({ view: view({ huInfos: [] }) }) });
    await wrapper.setProps({ view: view({ version: 2, huInfos: [hu(0)] }) });
    await nextTick();
    expect(wrapper.find('.mj-hu-banner').exists()).toBe(true);
    await wrapper.setProps({ settlementArrived: true });
    await nextTick();
    expect(wrapper.find('.mj-hu-banner').exists()).toBe(true);
  });

  it('reduced-motion：settlementRevealed 清空整队，DOM 无残留', async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    try {
      const wrapper = mount(MahjongBoard, { props: props({ view: view({ huInfos: [] }) }) });
      await wrapper.setProps({ view: view({ version: 2, huInfos: [hu(0), hu(2)] }) });
      await nextTick();
      expect(wrapper.find('.mj-hu-banner').exists()).toBe(true);
      await wrapper.setProps({ settlementRevealed: true });
      await nextTick();
      expect(wrapper.find('.mj-hu-banner').exists()).toBe(false);
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  it('reduced-motion：无 animationend ⇒ 下一版 view 出队当前 banner（同版本重复下发不出队）', async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    try {
      const wrapper = mount(MahjongBoard, { props: props({ view: view({ huInfos: [] }) }) });
      await wrapper.setProps({ view: view({ version: 2, huInfos: [hu(0), hu(2)] }) });
      await nextTick();
      const firstEl = wrapper.find('.mj-hu-banner').element;

      // 同一 version 的重复下发（resync）不得出队 —— 出队只认**之后**的版本变化。
      await wrapper.setProps({ view: view({ version: 2, huInfos: [hu(0), hu(2)] }) });
      await nextTick();
      expect(wrapper.find('.mj-hu-banner').element).toBe(firstEl);

      // 下一版（v3）⇒ 第一条出队、第二条顶上（新节点，bannerSeq 递增）。
      await wrapper.setProps({ view: view({ version: 3, huInfos: [hu(0), hu(2)] }) });
      await nextTick();
      expect(wrapper.find('.mj-hu-banner').exists()).toBe(true);
      expect(wrapper.find('.mj-hu-banner').element).not.toBe(firstEl);

      // 再下一版（v4）⇒ 第二条也出队，队列空 ⇒ DOM 无残留。
      await wrapper.setProps({ view: view({ version: 4, huInfos: [hu(0), hu(2)] }) });
      await nextTick();
      expect(wrapper.find('.mj-hu-banner').exists()).toBe(false);
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  it('挂载时已有 huInfos：seed 后无新增胡的版本更新不补播 banner', async () => {
    const wrapper = mount(MahjongBoard, { props: props({ view: view({ huInfos: [hu(1)] }) }) });
    expect(wrapper.find('.mj-hu-banner').exists(), '挂载即已有的胡不重播').toBe(false);

    // 同内容的新版本包（别人动作/resync）：仍无新胡 ⇒ 不播。
    await wrapper.setProps({ view: view({ version: 2, huInfos: [hu(1)] }) });
    await nextTick();
    expect(wrapper.find('.mj-hu-banner').exists()).toBe(false);

    // 真正新增胡（seat 2）⇒ 照常播（seed 不得把后续新胡也吞掉）。
    await wrapper.setProps({ view: view({ version: 3, huInfos: [hu(1), hu(2)] }) });
    await nextTick();
    expect(wrapper.find('.mj-hu-banner').exists()).toBe(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('MahjongBoard：v2 布局接线', () => {
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

  it('提供画布尺寸时手牌尺寸与 v2 纯函数逐值一致', () => {
    const metrics = computed(() => ({ width: 1334, height: 1000, scale: 1 }));
    const wrapper = mount(MahjongBoard, {
      props: props(),
      global: { provide: { [CANVAS_METRICS_KEY]: metrics } },
    });
    const layout = mahjongTableLayoutV2(1334, 1000);
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
    const meld: MahjongMeldView = { kind: 'peng', tiles: [tile(0, 1), tile(0, 1), tile(0, 1)] };
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ melds: [[], [], [meld], []] }) }),
    });
    expect(wrapper.findAll('.anim-meld-pop')).toHaveLength(0);
    await wrapper.setProps({ view: view({ version: 2, melds: [[], [], [meld], [meld]] }) });
    await nextTick();
    expect(wrapper.find('.mj-river--left .anim-meld-pop').exists()).toBe(true);
    expect(wrapper.find('.mj-river--top .anim-meld-pop').exists()).toBe(false);
  });
});

describe('MahjongBoard：摸牌分离与 display 下标', () => {
  const baseHand = view().hand;

  it('13→14：新增牌移到行尾并标 drawn', async () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    await wrapper.setProps({ view: view({ hand: [...baseHand, tile(1, 9)] }) });
    await nextTick();
    const tiles = wrapper.findAll('.mj__hand .mj-tile');
    expect(tiles).toHaveLength(14);
    const last = tiles[tiles.length - 1]!;
    expect(last.classes()).toContain('mj__hand-tile--drawn');
    expect(last.attributes('aria-label')).toBe('筒9');
    const layout = mahjongTableLayoutV2(1334, 750);
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
    expect(buttonByText(wrapper, '出牌').attributes('disabled')).toBeUndefined();
    await buttonByText(wrapper, '出牌').trigger('click');
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
    await buttonByText(wrapper, '出牌').trigger('click');
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
    await buttonByText(wrapper, '出牌').trigger('click');
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
    await buttonByText(wrapper, '换三张').trigger('click');
    const emitted = wrapper.emitted('mahjong')?.[0]?.[0] as { tiles: unknown[] };
    expect(emitted.tiles).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 红金皮肤（2026-11-08 Task 1）—— 牌桌 / 顶栏
// ---------------------------------------------------------------------------

const boardSfc = readFileSync('src/components/table/mahjong/MahjongBoard.vue', 'utf8');
const boardStyle = [...boardSfc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
  .map((m) => m[1]!)
  .join('\n');

/** 取一条选择器规则的声明体（本文件的这些规则没有嵌套块）。 */
function ruleBody(style: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(style);
  expect(m, `${selector} 规则必须存在`).not.toBeNull();
  return m![1]!;
}

describe('MahjongBoard：红金皮肤（Task 1：牌桌/顶栏）', () => {
  it('.mj 用 stage 底色；无旧绿背景 / 绿边框 / 多层 box-shadow', () => {
    const root = ruleBody(boardStyle, '.mj');
    expect(root).toContain('background: $ftl-color-mj-stage');
    expect(root).not.toContain('box-shadow');
    expect(boardStyle).not.toContain('$ftl-color-mahjong-table');
    expect(boardStyle).not.toContain('rgba(20, 50, 30');
    expect(boardStyle).not.toContain('3px solid');
  });

  it('.mj__felt 是第一个子元素：offset+1334u×750u 构图，radial + 双层 inset 框线', () => {
    const wrapper = mount(MahjongBoard, { props: props() });
    const felt = wrapper.find('.mj__felt');
    expect(felt.exists(), '.mj__felt 必须存在').toBe(true);
    expect(wrapper.find('.mj').element.firstElementChild, '.mj__felt 必须是第一个子元素').toBe(
      felt.element,
    );
    const inline = felt.attributes('style') ?? '';
    expect(inline).toContain(
      'radial-gradient(ellipse at 50% 46%, rgb(106 36 32) 0%, rgb(74 21 21) 46%, rgb(43 12 12) 100%)',
    );
    expect(inline).toContain('inset 0 0 0 calc(12px * var(--mj-u))');
    expect(inline).toContain('inset 0 0 0 calc(14px * var(--mj-u))');
    expect(inline).toContain('position: absolute');
    expect(inline).toContain('pointer-events: none');
    expect(inline).toContain('width: 1334px');
    expect(inline).toContain('height: 750px');
    expect(inline).toContain('left: 0px');
    expect(inline).toContain('top: 0px');
    // 内圈金线：牌桌子层（发丝线 token），随 --mj-u 内缩 12px
    expect(wrapper.find('.mj__felt .mj__felt-line').exists()).toBe(true);
    const line = ruleBody(boardStyle, '.mj__felt-line');
    expect(line).toContain('inset: calc(12px * var(--mj-u))');
    expect(line).toContain('border: $ftl-hairline solid $ftl-color-mj-gold-line');
  });

  it('宽画布：绒面跟随 1334×750 构图居中（offset 而不是铺满画布）', () => {
    const metrics = computed(() => ({ width: 1623, height: 750, scale: 1 }));
    const wrapper = mount(MahjongBoard, {
      props: props(),
      global: { provide: { [CANVAS_METRICS_KEY]: metrics } },
    });
    const layout = mahjongTableLayoutV2(1623, 750);
    const inline = wrapper.find('.mj__felt').attributes('style') ?? '';
    expect(inline).toContain(`left: ${layout.offsetX}px`);
    expect(inline).toContain(`top: ${layout.offsetY}px`);
    expect(inline).toContain(`width: ${1334 * layout.u}px`);
    expect(inline).toContain(`height: ${750 * layout.u}px`);
  });

  it('顶栏：bar-top→lacquer 渐变 + 金线底；标题 22 cream / 房间 16 muted', () => {
    const bar = ruleBody(boardStyle, '.mj__bar');
    expect(bar).toContain('linear-gradient($ftl-color-mj-bar-top, $ftl-color-mj-lacquer)');
    expect(bar).toContain('border-bottom: $ftl-hairline solid $ftl-color-mj-gold');
    expect(bar).toContain('padding: 0 14px');
    const title = ruleBody(boardStyle, '.mj__bar-title');
    expect(title).toContain('font-size: 22px');
    expect(title).toContain('$ftl-color-mj-cream');
    expect(title).toContain('letter-spacing: 0.4px');
    const sub = ruleBody(boardStyle, '.mj__bar-sub');
    expect(sub).toContain('font-size: 16px');
    expect(sub).toContain('$ftl-color-mj-muted');

    const wrapper = mount(MahjongBoard, { props: props() });
    expect(wrapper.find('.mj__bar-title').text()).toBe('休闲场 · 底分 1');
    expect(wrapper.find('.mj__bar-sub').text()).toContain('MJ1');
  });

  it('顶栏左右组可收缩（flex: 0 1 auto + min-width: 0）：长场次名挤占并省略', () => {
    const m = /\.mj__bar-left,\s*\.mj__bar-right\s*\{([^}]*)\}/.exec(boardStyle);
    expect(m, '.mj__bar-left/.mj__bar-right 分组规则必须存在').not.toBeNull();
    expect(m![1]).toContain('flex: 0 1 auto');
    expect(m![1]).toContain('min-width: 0');
    expect(m![1]).not.toContain('flex: 0 0 auto');
  });

  it('等待发牌文案：绝对定位居中、z-index 高于绒面（lacquer 底 + cream 字）', () => {
    const wrapper = mount(MahjongBoard, { props: props({ waitingForDeal: true }) });
    const waiting = wrapper.find('.mj__waiting');
    expect(waiting.exists()).toBe(true);
    expect(waiting.text()).toContain('等待服务端发牌');

    const rule = ruleBody(boardStyle, '.mj__waiting');
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('left: 50%');
    expect(rule).toContain('top: 50%');
    expect(rule).toContain('transform: translate(-50%, -50%)');
    expect(rule).toContain('color: $ftl-color-mj-cream');
    expect(rule).toContain('background: rgba($ftl-color-mj-lacquer');

    // 绒面（.mj__felt）是定位元素但没有 z-index（auto ⇒ 0 层）；
    // 等待文案必须有正的 z-index 才能画在绒面/顶栏之上。
    const feltInline = wrapper.find('.mj__felt').attributes('style') ?? '';
    expect(feltInline).toContain('position: absolute');
    expect(feltInline).not.toContain('z-index');
    const z = /z-index:\s*(\d+)/.exec(rule);
    expect(z, '.mj__waiting 必须设数值 z-index').not.toBeNull();
    expect(Number(z![1])).toBeGreaterThan(0);
  });

  it('返回按钮：40×40 金框 flex 居中 ‹（不再依赖 PNG 箭头）', () => {
    const back = ruleBody(boardStyle, '.mj__back');
    expect(back).toContain('width: 40px');
    expect(back).toContain('height: 40px');
    expect(back).toContain('border: $ftl-hairline solid $ftl-color-mj-gold');
    expect(back).toContain('color: $ftl-color-mj-gold');
    expect(back).toContain('font-size: 28px');

    const wrapper = mount(MahjongBoard, { props: props() });
    expect(wrapper.find('.mj__back').text()).toBe('‹');
    expect(wrapper.find('.mj__back image').exists()).toBe(false);
  });

  it('托管 / 更多：16px muted 纯文字按钮（透明底、无边框、无灰蓝渐变）', () => {
    const action = ruleBody(boardStyle, '.mj__bar-action');
    expect(action).toContain('font-size: 16px');
    expect(action).toContain('color: $ftl-color-mj-muted');
    expect(action).toContain('background: transparent');
    expect(action).toContain('border: none');
    expect(boardStyle).not.toContain('rgba(120, 130, 150');
    expect(boardStyle).not.toContain('rgba(80, 90, 110');

    const wrapper = mount(MahjongBoard, { props: props() });
    expect(wrapper.find('.mj__trustee').text()).toBe('托管');
    expect(wrapper.find('.mj__more').text()).toBe('更多');
  });

  it('托管中：状态色 $ftl-color-mj-status', () => {
    const on = ruleBody(boardStyle, '.mj__bar-action--on');
    expect(on).toContain('color: $ftl-color-mj-status');
    const wrapper = mount(MahjongBoard, {
      props: props({ view: view({ trustees: [true, false, false, false] }) }),
    });
    expect(wrapper.find('.mj__trustee').classes()).toContain('mj__bar-action--on');
  });
});

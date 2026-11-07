import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { tileType, type MahjongMeldView, type Tile } from '@fight-the-landlord/protocol';
import MahjongRiver from '../src/components/table/mahjong/MahjongRiver.vue';
import MahjongMeld from '../src/components/table/mahjong/MahjongMeld.vue';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };
const tong1: Tile = { s: 1, r: 1 };

/** 第 i 张牌的牌面（27 种循环，牌面互不相同的足够长序列）。 */
function tileAt(i: number): Tile {
  return { s: (Math.floor(i / 9) % 3) as 0 | 1 | 2, r: (i % 9) + 1 };
}

function makeDiscards(n: number): Tile[] {
  return Array.from({ length: n }, (_, i) => tileAt(i));
}

/** 从内联 style 里取 `prop: <n>px`（按属性名边界匹配，避免子串误命中）。 */
function stylePx(style: string, prop: string): number {
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`));
  if (!m) throw new Error(`inline style 缺少 ${prop}px：${style}`);
  return Number(m[1]);
}

function props(over: Record<string, unknown> = {}) {
  return {
    discards: [wan1, wan2, tong1],
    melds: [] as Array<{ key: string; meld: MahjongMeldView; pop: boolean }>,
    direction: 'my' as const,
    tileW: 50,
    tileH: 75,
    gap: 2,
    cols: 12,
    rows: 2,
    meldTileW: 40,
    meldTileH: 60,
    meldOverlap: 8,
    meldPlacement: 'above' as const,
    meldGap: 8,
    meldGroupGap: 4,
    meldHeight: 0,
    filterTileType: null,
    interactive: false,
    revealed: null,
    ...over,
  };
}

describe('MahjongRiver', () => {
  it('弃牌按顺序渲染，最后一张高亮', () => {
    const w = mount(MahjongRiver, { props: props() });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(3);
    expect(tiles[2]!.classes()).toContain('mj-river__tile--latest');
    expect(tiles[2]!.classes()).toContain('anim-discard-land');
    expect(tiles[1]!.classes()).not.toContain('anim-discard-land');
    const grid = w.find('.mj-river__grid');
    expect(grid.attributes('style')).toContain('grid-template-columns: repeat(12, 50px)');
    expect(grid.attributes('style')).toContain('gap: 2px');
  });

  it('点击弃牌 emit discard-click {tile,index}（interactive=true，index 为窗口相对下标）', async () => {
    const w = mount(MahjongRiver, { props: props({ interactive: true }) });
    await w.findAll('.mj-tile')[0]!.trigger('click');
    expect(w.emitted('discard-click')?.[0]).toEqual([{ tile: wan1, index: 0 }]);
  });

  it('interactive=false 时点击不 emit', async () => {
    const w = mount(MahjongRiver, { props: props() });
    await w.findAll('.mj-tile')[0]!.trigger('click');
    expect(w.emitted('discard-click')).toBeUndefined();
  });

  it('filterTileType 命中加 outline 类（claimSourceIndex 缺席时的 legacy 回退）', () => {
    const w = mount(MahjongRiver, { props: props({ filterTileType: tileType(wan1) }) });
    const tiles = w.findAll('.mj-tile');
    expect(tiles[0]!.classes()).toContain('mj-river__tile--filtered');
    expect(tiles[1]!.classes()).not.toContain('mj-river__tile--filtered');
  });

  it('窗口：29 张只渲染 slice(6, 29)，+6 徽标落在 badgeRect（局部坐标），最后一张 latest', () => {
    const discards = makeDiscards(29);
    const badgeRect = { left: 100, top: 4, width: 50, height: 75 };
    const w = mount(MahjongRiver, {
      props: props({
        discards,
        windowStart: 6,
        windowCount: 23,
        latestIndex: 22,
        badgeCount: 6,
        badgeRect,
      }),
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(23);
    // 第一张 = discards[6]（suit 0, rank 7 → wan-7）
    expect(tiles[0]!.attributes('src')).toMatch(/\/my\/wan-7\.png$/);
    expect(tiles[22]!.classes()).toContain('mj-river__tile--latest');
    expect(w.findAll('.mj-river__tile--latest')).toHaveLength(1);

    const badge = w.find('.mj-river__badge');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('+6');
    const style = badge.attributes('style') ?? '';
    expect(stylePx(style, 'left')).toBe(100);
    expect(stylePx(style, 'top')).toBe(4);
    expect(stylePx(style, 'width')).toBe(50);
    expect(stylePx(style, 'height')).toBe(75);
  });

  it('窗口内点击：index 是窗口相对下标（首张 → 0）', async () => {
    const discards = makeDiscards(29);
    const w = mount(MahjongRiver, {
      props: props({ discards, windowStart: 6, windowCount: 23, interactive: true }),
    });
    await w.findAll('.mj-tile')[0]!.trigger('click');
    expect(w.emitted('discard-click')?.[0]).toEqual([{ tile: discards[6], index: 0 }]);
  });

  it('claimSourceIndex=5：只描边窗口第 6 张（即使同型多张）；点同型非来源不 emit', async () => {
    // 窗口下标 0/2/4/5/7 都是 wan1；来源是下标 5。
    const discards = [wan1, wan2, wan1, tong1, wan1, wan1, wan2, wan1];
    const w = mount(MahjongRiver, {
      props: props({
        discards,
        interactive: true,
        claimSourceIndex: 5,
        // 同时给 legacy 过滤：claimSourceIndex 存在时必须被压过（只描边单张）。
        filterTileType: tileType(wan1),
      }),
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles[5]!.classes()).toContain('mj-river__tile--filtered');
    for (const i of [0, 2, 4, 7]) {
      expect(tiles[i]!.classes()).not.toContain('mj-river__tile--filtered');
    }
    expect(w.findAll('.mj-river__tile--filtered')).toHaveLength(1);

    // 同型非来源点击不 emit。
    await tiles[4]!.trigger('click');
    expect(w.emitted('discard-click')).toBeUndefined();

    // 来源点击 emit 窗口相对 index。
    await tiles[5]!.trigger('click');
    expect(w.emitted('discard-click')?.[0]).toEqual([{ tile: discards[5], index: 5 }]);
  });

  it('revealed 14 张：替换弃牌网格，无徽标、无 latest 高亮', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: makeDiscards(29),
        windowStart: 6,
        windowCount: 23,
        badgeCount: 0,
        latestIndex: 22,
        revealed: { tiles: makeDiscards(14), huTile: wan1 },
      }),
    });
    expect(w.findAll('.mj-tile')).toHaveLength(14);
    expect(w.find('.mj-river__badge').exists()).toBe(false);
    expect(w.findAll('.mj-river__tile--latest')).toHaveLength(0);
  });

  it('revealed 时即使 badgeCount>0 + badgeRect 也不渲染徽标', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: makeDiscards(29),
        badgeCount: 6,
        badgeRect: { left: 100, top: 4, width: 50, height: 75 },
        revealed: { tiles: makeDiscards(14), huTile: wan1 },
      }),
    });
    expect(w.find('.mj-river__badge').exists()).toBe(false);
  });

  it('副露条：碰 3 张 + 杠 4 张，标签/位置正确', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [
          { key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false },
          { key: 'gang:0_0_0_1', meld: { kind: 'gang', tiles: [wan1, wan1, wan1, wan2] }, pop: true },
        ],
        meldHeight: 60,
      }),
    });
    expect(w.findAll('.mj-river__meld')).toHaveLength(2);
    expect(w.findAll('.mj-tile')).toHaveLength(7);
    expect(w.text()).toContain('碰');
    expect(w.text()).toContain('杠');
    const strip = w.find('.mj-river__melds');
    expect(strip.attributes('style')).toContain('bottom: calc(100% + 8px)');
    expect(strip.attributes('style')).toContain('height: 60px');
    expect(strip.attributes('style')).toContain('gap: 4px');
    const meldComps = w.findAllComponents(MahjongMeld);
    expect(meldComps).toHaveLength(2);
    // 第二个是 pop:true 的杠（第一个是 pop:false 的碰）
    expect(meldComps[1]!.classes()).toContain('anim-meld-pop');
  });

  it('meldRect：侧家 lane 用局部坐标定位，Meld 竖叠并透传 w/h/overlap', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        direction: 'left',
        melds: [
          { key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false },
        ],
        meldRect: { left: 8, top: 12, width: 40, height: 300 },
        laneWidth: 30,
      }),
    });
    const strip = w.find('.mj-river__melds');
    const style = strip.attributes('style') ?? '';
    expect(stylePx(style, 'left')).toBe(8);
    expect(stylePx(style, 'top')).toBe(12);
    expect(stylePx(style, 'width')).toBe(40);
    expect(stylePx(style, 'height')).toBe(300);
    expect(style).toContain('flex-direction: column');
    expect(style).toContain('overflow: visible');

    const meld = w.findComponent(MahjongMeld);
    expect(meld.classes()).toContain('mj-meld--vertical');
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(3);
    expect(stylePx(tiles[0]!.attributes('style') ?? '', 'width')).toBe(40);
    expect(stylePx(tiles[0]!.attributes('style') ?? '', 'height')).toBe(60);
    for (const t of tiles.slice(1)) {
      expect(stylePx(t.attributes('style') ?? '', 'margin-top')).toBe(-8);
    }
  });

  it('meldRect 缺省：保持 legacy 绝对定位（meldPlacement/meldGap/meldHeight）', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [{ key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false }],
        meldHeight: 60,
      }),
    });
    const style = w.find('.mj-river__melds').attributes('style') ?? '';
    expect(style).toContain('bottom: calc(100% + 8px)');
    expect(style).toContain('height: 60px');
    expect(style).not.toContain('top: 12px');
  });

  it('暗杠副露 4 张全牌背', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [
          {
            key: 'angang',
            meld: { kind: 'angang', tiles: [wan1, wan1, wan1, wan1] },
            pop: false,
          },
        ],
        meldHeight: 60,
      }),
    });
    const srcs = w.findAll('image').map((i) => i.attributes('src') ?? '');
    expect(srcs).toHaveLength(4);
    expect(srcs.every((src) => src.endsWith('/back.png'))).toBe(true);
  });

  it('meldPlacement=below 时条带在下方', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [{ key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false }],
        meldPlacement: 'below',
        meldHeight: 60,
      }),
    });
    expect(w.find('.mj-river__melds').attributes('style')).toContain('top: calc(100% + 8px)');
  });

  it('副露 pop-done 原样上抛 key', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [{ key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: true }],
        meldHeight: 60,
      }),
    });
    w.findComponent(MahjongMeld).vm.$emit('pop-done');
    expect(w.emitted('meld-pop-done')?.[0]).toEqual(['peng:0_0_0']);
  });

  it('direction 类名正确', () => {
    for (const direction of ['my', 'top', 'left', 'right'] as const) {
      expect(mount(MahjongRiver, { props: props({ direction }) }).classes()).toContain(
        `mj-river--${direction}`,
      );
    }
  });

  it('revealed：亮牌网格替换 discards，不响应点击', async () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [wan2],
        revealed: { tiles: [wan1, tong1], huTile: tong1 },
      }),
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(2);
    expect(w.find('.mj-river__revealed').exists()).toBe(true);
    expect(w.text()).toContain('已胡');
    await tiles[0]!.trigger('click');
    expect(w.emitted('discard-click')).toBeUndefined();
  });
});

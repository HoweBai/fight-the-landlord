import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { tileType, type MahjongMeldView, type Tile } from '@fight-the-landlord/protocol';
import MahjongRiver from '../src/components/table/mahjong/MahjongRiver.vue';
import MahjongMeld from '../src/components/table/mahjong/MahjongMeld.vue';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };
const tong1: Tile = { s: 1, r: 1 };

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
    const grid = w.find('.mj-river__grid');
    expect(grid.attributes('style')).toContain('grid-template-columns: repeat(12, 50px)');
    expect(grid.attributes('style')).toContain('gap: 2px');
  });

  it('点击弃牌 emit discard-click（interactive=true）', async () => {
    const w = mount(MahjongRiver, { props: props({ interactive: true }) });
    await w.findAll('.mj-tile')[0]!.trigger('click');
    expect(w.emitted('discard-click')?.[0]).toEqual([wan1]);
  });

  it('interactive=false 时点击不 emit', async () => {
    const w = mount(MahjongRiver, { props: props() });
    await w.findAll('.mj-tile')[0]!.trigger('click');
    expect(w.emitted('discard-click')).toBeUndefined();
  });

  it('filterTileType 命中加 outline 类', () => {
    const w = mount(MahjongRiver, { props: props({ filterTileType: tileType(wan1) }) });
    const tiles = w.findAll('.mj-tile');
    expect(tiles[0]!.classes()).toContain('mj-river__tile--filtered');
    expect(tiles[1]!.classes()).not.toContain('mj-river__tile--filtered');
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

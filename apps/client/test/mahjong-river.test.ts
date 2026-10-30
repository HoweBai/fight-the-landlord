import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { tileType, type Tile } from '@fight-the-landlord/protocol';
import MahjongRiver from '../src/components/table/mahjong/MahjongRiver.vue';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };
const tong1: Tile = { s: 1, r: 1 };

function props(over: Record<string, unknown> = {}) {
  return {
    discards: [wan1, wan2, tong1],
    direction: 'my' as const,
    tileW: 50,
    tileH: 75,
    gap: 2,
    cols: 12,
    rows: 2,
    filterTileType: null,
    interactive: false,
    source: false,
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

  it('source=true 加来源道类', () => {
    expect(
      mount(MahjongRiver, { props: props({ source: true }) }).classes(),
    ).toContain('mj-river--source');
    expect(mount(MahjongRiver, { props: props() }).classes()).not.toContain('mj-river--source');
  });

  it('网格从左上起排（源码闸，防行数增长时整块漂移）', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongRiver.vue', 'utf8');
    expect(src).toMatch(/\.mj-river\s*\{[^}]*align-items:\s*flex-start/);
    expect(src).toMatch(/\.mj-river\s*\{[^}]*justify-content:\s*flex-start/);
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

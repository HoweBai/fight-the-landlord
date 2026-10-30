import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongMeldView, Tile } from '@fight-the-landlord/protocol';
import MahjongMeldStrip from '../src/components/table/mahjong/MahjongMeldStrip.vue';
import MahjongMeld from '../src/components/table/mahjong/MahjongMeld.vue';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };

type Group = { key: string; meld: MahjongMeldView; pop: boolean };
function group(key: string, meld: MahjongMeldView, pop = false): Group {
  return { key, meld, pop };
}
function props(over: Record<string, unknown> = {}) {
  return {
    melds: [] as Group[],
    direction: 'my' as const,
    tileW: 40,
    tileH: 60,
    overlap: 8,
    groupGap: 8,
    layout: 'row' as const,
    ...over,
  };
}

describe('MahjongMeldStrip', () => {
  it('空副露不渲染根', () => {
    const w = mount(MahjongMeldStrip, { props: props() });
    expect(w.find('.mj-strip').exists()).toBe(false);
  });

  it('碰 3 张 + 杠 4 张同行，标签与组数正确', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({
        melds: [
          group('peng:0_0_0', { kind: 'peng', tiles: [wan1, wan1, wan1] }),
          group('gang:0_0_0_1', { kind: 'gang', tiles: [wan1, wan1, wan1, wan2] }),
        ],
      }),
    });
    expect(w.findAll('.mj-strip__group')).toHaveLength(2);
    expect(w.findAll('.mj-tile')).toHaveLength(7);
    expect(w.text()).toContain('碰');
    expect(w.text()).toContain('杠');
    expect(w.classes()).toContain('mj-strip--row');
  });

  it('暗杠 4 张全牌背', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({ melds: [group('angang', { kind: 'angang', tiles: [wan1, wan1, wan1, wan1] })] }),
    });
    const srcs = w.findAll('image').map((i) => i.attributes('src') ?? '');
    expect(srcs).toHaveLength(4);
    expect(srcs.every((s) => s.endsWith('/back.png'))).toBe(true);
  });

  it('layout=column 加竖排类；组间距落到 style', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({
        layout: 'column',
        groupGap: 4,
        melds: [group('peng:0_0_0', { kind: 'peng', tiles: [wan1, wan1, wan1] })],
      }),
    });
    expect(w.classes()).toContain('mj-strip--column');
    expect(w.attributes('style')).toContain('gap: 4px');
  });

  it('pop 透传 + pop-done 原样上抛 key', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({ melds: [group('peng:0_0_0', { kind: 'peng', tiles: [wan1, wan1, wan1] }, true)] }),
    });
    expect(w.findComponent(MahjongMeld).classes()).toContain('anim-meld-pop');
    w.findComponent(MahjongMeld).vm.$emit('pop-done');
    expect(w.emitted('pop-done')?.[0]).toEqual(['peng:0_0_0']);
  });

  it('justify 贴靠方向落到 style', () => {
    const make = (justify: 'start' | 'end') =>
      mount(MahjongMeldStrip, {
        props: props({
          justify,
          melds: [group('peng:0_0_0', { kind: 'peng', tiles: [wan1, wan1, wan1] })],
        }),
      });
    expect(make('start').attributes('style')).toContain('justify-content: flex-start');
    expect(make('end').attributes('style')).toContain('justify-content: flex-end');
  });

  it('tileW/tileH/overlap 透传到每张牌', () => {
    const w = mount(MahjongMeldStrip, {
      props: props({ melds: [group('gang', { kind: 'gang', tiles: [wan1, wan1, wan1, wan2] })] }),
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.attributes('style')).toContain('width: 40px');
      expect(t.attributes('style')).toContain('height: 60px');
    }
    expect(tiles[0]!.attributes('style') ?? '').not.toContain('margin-left');
    expect(tiles[1]!.attributes('style')).toContain('margin-left: -8px');
  });
});

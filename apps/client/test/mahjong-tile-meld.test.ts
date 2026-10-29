import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongMeldView, Tile } from '@fight-the-landlord/protocol';
import MahjongTile from '../src/components/table/mahjong/MahjongTile.vue';
import MahjongMeld from '../src/components/table/mahjong/MahjongMeld.vue';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };

function meld(kind: MahjongMeldView['kind'], tiles: Tile[]): MahjongMeldView {
  return { kind, tiles };
}

describe('MahjongTile 显式尺寸', () => {
  it('w/h 同时给出时内联 style 覆盖 size 档位', () => {
    const w = mount(MahjongTile, { props: { tile: wan1, w: 72, h: 108 } });
    expect(w.attributes('style')).toContain('width: 72px');
    expect(w.attributes('style')).toContain('height: 108px');
  });

  it('不给 w/h 时仍走 size 类，无内联尺寸', () => {
    const w = mount(MahjongTile, { props: { tile: wan1, size: 'lg' } });
    expect(w.classes()).toContain('mj-tile--lg');
    expect(w.attributes('style')).toBeUndefined();
  });
});

describe('MahjongMeld 可变尺寸与杠/暗杠', () => {
  it('碰 3 张、杠 4 张同行，无绝对定位 cap', () => {
    const peng = mount(MahjongMeld, { props: { meld: meld('peng', [wan1, wan1, wan1]) } });
    expect(peng.findAll('.mj-tile')).toHaveLength(3);
    expect(peng.find('.mj-meld__cap').exists()).toBe(false);

    const gang = mount(MahjongMeld, {
      props: { meld: meld('gang', [wan1, wan1, wan1, wan2]) },
    });
    expect(gang.findAll('.mj-tile')).toHaveLength(4);
    expect(gang.find('.mj-meld__cap').exists()).toBe(false);
  });

  it('暗杠 4 张全部是牌背', () => {
    const w = mount(MahjongMeld, {
      props: { meld: meld('angang', [wan1, wan1, wan1, wan1]) },
    });
    const srcs = w.findAll('image').map((i) => i.attributes('src') ?? '');
    expect(srcs).toHaveLength(4);
    expect(srcs.every((s) => s.endsWith('/back.png'))).toBe(true);
  });

  it('tileW/tileH/overlap 透传到每张牌', () => {
    const w = mount(MahjongMeld, {
      props: {
        meld: meld('gang', [wan1, wan1, wan1, wan2]),
        tileW: 40,
        tileH: 60,
        overlap: 8,
      },
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.attributes('style')).toContain('width: 40px');
      expect(t.attributes('style')).toContain('height: 60px');
    }
    expect(tiles[0]!.attributes('style') ?? '').not.toContain('margin-left');
    for (const t of tiles.slice(1)) {
      expect(t.attributes('style')).toContain('margin-left: -8px');
    }
  });

  it('pop 类按 kind 保留', () => {
    const w = mount(MahjongMeld, {
      props: { meld: meld('gang', [wan1, wan1, wan1, wan2]), pop: true },
    });
    expect(w.classes()).toContain('anim-meld-pop');
    expect(w.classes()).toContain('anim-meld-pop--gang');
  });
});

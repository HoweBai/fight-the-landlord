import { readFileSync } from 'node:fs';
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

  it('四方向素材路径映射', () => {
    for (const direction of ['my', 'top', 'left', 'right'] as const) {
      const w = mount(MahjongTile, { props: { tile: wan1, direction } });
      expect(w.attributes('src')).toBe(`/pages/table/static/mahjong/${direction}/wan-1.png`);
    }
    const back = mount(MahjongTile, { props: { back: true, direction: 'left' } });
    expect(back.attributes('src')).toBe('/pages/table/static/mahjong/left/back.png');
  });

  it('牌面尺寸 3:4，左右家横置交换宽高', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongTile.vue', 'utf8');
    expect(src).toMatch(/\.mj-tile--sm\s*\{[^}]*width:\s*34px;[^}]*height:\s*45px/);
    expect(src).toMatch(/\.mj-tile--md\s*\{[^}]*width:\s*46px;[^}]*height:\s*61px/);
    expect(src).toMatch(/\.mj-tile--lg\s*\{[^}]*width:\s*60px;[^}]*height:\s*80px/);
    expect(src).toMatch(
      /\.mj-tile--dir-left,[\s\S]*?\.mj-tile--sm\s*\{[^}]*width:\s*45px;[^}]*height:\s*34px/,
    );
    expect(src).toContain('border-radius: 12%');
    expect(src).toContain('$ftl-color-mj-gold');
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
    for (const t of gang.findAll('.mj-tile')) {
      const style = t.attributes('style') ?? '';
      expect(style).not.toContain('position');
      expect(style).not.toContain('top');
      expect(style).not.toContain('bottom');
    }
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

  it('副露底托类', () => {
    const w = mount(MahjongMeld, { props: { meld: meld('peng', [wan1, wan1, wan1]) } });
    expect(w.classes()).toContain('mj-meld--tray');
    const src = readFileSync('src/components/table/mahjong/MahjongMeld.vue', 'utf8');
    expect(src).toContain('$ftl-color-mj-glass-soft');
    // 负 margin 抵消 padding：底托不改变布局足迹（4 杠组仍 ≤ 牌河宽）
    expect(src).toContain('margin: -$ftl-space-2');
  });
});

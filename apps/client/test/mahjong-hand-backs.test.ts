import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MahjongHandBacks from '../src/components/table/mahjong/MahjongHandBacks.vue';

describe('MahjongHandBacks', () => {
  it('top：13 张牌背横排，gap 生效', () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 13, direction: 'top', tileW: 36, tileH: 54, gap: 2 },
    });
    expect(w.findAll('.mj-tile')).toHaveLength(13);
    expect(w.classes()).toContain('mj-backs--top');
    expect(w.attributes('style')).toContain('gap: 2px');
    expect(w.findAll('image').every((i) => (i.attributes('src') ?? '').endsWith('/back.png'))).toBe(
      true,
    );
  });

  it('left：竖排，pitch 24 / tileH 45 → 第 2 张起 margin-top -21px', () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 13, direction: 'left', tileW: 30, tileH: 45, pitch: 24 },
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(13);
    expect(w.classes()).toContain('mj-backs--vertical');
    expect(tiles[0]!.attributes('style') ?? '').not.toContain('margin-top');
    expect(tiles[1]!.attributes('style')).toContain('margin-top: -21px');
  });

  it('count 0 不渲染；count > 14 截到 14', () => {
    expect(
      mount(MahjongHandBacks, {
        props: { count: 0, direction: 'top', tileW: 36, tileH: 54 },
      }).findAll('.mj-tile'),
    ).toHaveLength(0);
    expect(
      mount(MahjongHandBacks, {
        props: { count: 99, direction: 'top', tileW: 36, tileH: 54 },
      }).findAll('.mj-tile'),
    ).toHaveLength(14);
  });

  it('revealed：渲染牌面而不是牌背', () => {
    const w = mount(MahjongHandBacks, {
      props: {
        count: 13,
        direction: 'top',
        tileW: 36,
        tileH: 54,
        revealed: { tiles: [{ s: 0, r: 1 }, { s: 1, r: 2 }], huTile: { s: 1, r: 2 } },
      },
    });
    const srcs = w.findAll('image').map((i) => i.attributes('src') ?? '');
    expect(srcs).toHaveLength(2);
    expect(srcs[0]).toContain('/top/wan-1.png');
    expect(srcs[1]).toContain('/top/tong-2.png');
    expect(srcs.some((s) => s.endsWith('/back.png'))).toBe(false);
  });
});

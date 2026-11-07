import { readFileSync } from 'node:fs';
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

  it('dealNonce 非空：所有牌背带 anim-deal-in-side', () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 13, direction: 'top', tileW: 36, tileH: 54, dealNonce: 7 },
    });
    expect(w.findAll('.mj-tile')).toHaveLength(13);
    expect(w.findAll('.anim-deal-in-side')).toHaveLength(13);
  });

  it('dealNonce null（缺省）：牌背无发牌类', () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 13, direction: 'top', tileW: 36, tileH: 54 },
    });
    expect(w.findAll('.anim-deal-in-side')).toHaveLength(0);
  });

  it('发牌错峰（Task 4）：每张牌背 --ftl-delay = (i-1)*20ms（0/20/40）', () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 3, direction: 'top', tileW: 36, tileH: 54, dealNonce: 1 },
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(3);
    expect(tiles[0]!.attributes('style')).toContain('--ftl-delay: 0ms');
    expect(tiles[1]!.attributes('style')).toContain('--ftl-delay: 20ms');
    expect(tiles[2]!.attributes('style')).toContain('--ftl-delay: 40ms');
  });

  it('发牌错峰与竖排 marginTop 合并（不是二选一）', () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 3, direction: 'left', tileW: 30, tileH: 45, pitch: 24, dealNonce: 1 },
    });
    const tiles = w.findAll('.mj-tile');
    const second = tiles[1]!.attributes('style') ?? '';
    expect(second, '原有叠压样式必须保留').toContain('margin-top: -21px');
    expect(second, '错峰延迟同时存在').toContain('--ftl-delay: 20ms');
  });

  it('tail：第 14 张尾部牌背不带发牌类（13→14 摸牌不重播发牌）', async () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 13, direction: 'left', tileW: 30, tileH: 45, pitch: 24, dealNonce: 7 },
    });
    expect(w.findAll('.anim-deal-in-side')).toHaveLength(13);
    await w.setProps({ count: 14, tail: true });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(14);
    // 原有 13 张仍是同 key 的发牌节点；新增尾部只算摸牌节点。
    expect(w.findAll('.anim-deal-in-side')).toHaveLength(13);
    expect(tiles[13]!.classes()).not.toContain('anim-deal-in-side');
  });

  it('tail=false：第 14 张仍带发牌类（对照）', () => {
    const w = mount(MahjongHandBacks, {
      props: { count: 14, direction: 'top', tileW: 36, tileH: 54, dealNonce: 7, tail: false },
    });
    expect(w.findAll('.anim-deal-in-side')).toHaveLength(14);
  });

  it('源码闸：模板使用 anim- 类时，scoped 样式必须 @import animations.scss', () => {
    // scoped CSS 会把 @keyframes 按组件重命名 ⇒ Board 里的动画类匹配不到本组件元素，
    // 必须把 animations.scss 导进本组件（MahjongMeld/HuBanner 同款纪律）。
    const src = readFileSync('src/components/table/mahjong/MahjongHandBacks.vue', 'utf8');
    expect(src).toMatch(/['"]anim-[a-z]/);
    const style = src.slice(src.indexOf('<style'));
    expect(style).toMatch(/@import\s+['"][^'"]*styles\/animations\.scss['"]/);
  });
});

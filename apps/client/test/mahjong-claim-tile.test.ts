import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongClaimOption } from '@fight-the-landlord/protocol';
import ClaimTile from '../src/components/table/mahjong/ClaimTile.vue';
import MahjongHuBanner from '../src/components/table/mahjong/MahjongHuBanner.vue';

const options: MahjongClaimOption[] = [
  { claim: 'hu', tile: { s: 0, r: 5 }, fan: 3 },
  { claim: 'peng', tile: { s: 0, r: 5 } },
  { claim: 'gang', tile: { s: 0, r: 5 } },
];

describe('ClaimTile', () => {
  it('炭黑面板 + 2 列 + 文案/emit', async () => {
    const w = mount(ClaimTile, { props: { options } });
    expect(w.find('.mj-claim-tile').classes()).toContain('mj-claim-tile--panel');
    const labels = w.findAll('.mj-claim-tile__opt-label').map((b) => b.text());
    expect(labels).toEqual(['胡', '碰', '杠']);
    expect(w.find('.mj-claim-tile__fan').text()).toBe('3番');
    const buttons = w.findAll('.mj-claim-tile__opt');
    await buttons[1]!.trigger('click');
    expect(w.emitted('claim')?.[0]).toEqual([options[1]]);
    await w.find('.mj-claim-tile__pass').trigger('click');
    expect(w.emitted('pass')).toHaveLength(1);
  });

  it('顶部牌面预览：取第一张 tile，且在选项之前', () => {
    const w = mount(ClaimTile, { props: { options } });
    const preview = w.find('.mj-claim-tile__preview');
    expect(preview.exists()).toBe(true);
    const img = w.find('.mj-claim-tile__preview image');
    expect(img.attributes('src')).toBe('/pages/table/static/mahjong/my/wan-5.png');
    expect(img.attributes('style')).toContain('width: 34px');
    expect(img.attributes('style')).toContain('height: 45px');
    // 预览在 opts 之前
    const html = w.html();
    expect(html.indexOf('mj-claim-tile__preview')).toBeLessThan(
      html.indexOf('mj-claim-tile__opts'),
    );
  });

  it('只有 pass/无 tile：不渲染预览', () => {
    const w = mount(ClaimTile, { props: { options: [{ claim: 'pass' }] } });
    expect(w.find('.mj-claim-tile__preview').exists()).toBe(false);
    expect(w.find('.mj-claim-tile__pass').exists()).toBe(true);
  });

  it('filteredOptions 优先；过滤为空回退 options', () => {
    const a = mount(ClaimTile, {
      props: {
        options,
        filteredOptions: [{ claim: 'peng', tile: { s: 1, r: 2 } }],
      },
    });
    expect(a.find('.mj-claim-tile__preview image').attributes('src')).toBe(
      '/pages/table/static/mahjong/my/tong-2.png',
    );
    const b = mount(ClaimTile, { props: { options, filteredOptions: [] } });
    expect(b.find('.mj-claim-tile__preview image').attributes('src')).toBe(
      '/pages/table/static/mahjong/my/wan-5.png',
    );
  });

  it('源码闸：炭黑 panel token、2 列网格、无旧绿色', () => {
    const src = readFileSync('src/components/table/mahjong/ClaimTile.vue', 'utf8');
    expect(src).toContain('$ftl-color-mj-panel');
    const style = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const opts = /\.mj-claim-tile__opts\s*\{([^}]*)\}/.exec(style)?.[1] ?? '';
    expect(opts).toContain('grid-template-columns: repeat(2');
    expect(src).toContain('$ftl-font-mj-mini');
    expect(src).not.toMatch(/rgba\(\s*30\s*,\s*60\s*,\s*40/);
    expect(src).not.toMatch(/rgba\(\s*60\s*,\s*110\s*,\s*75/);
    expect(src).not.toMatch(/rgba\(\s*35\s*,\s*75\s*,\s*50/);
  });
});

describe('MahjongHuBanner', () => {
  it('天月风根类 + 文案', () => {
    const w = mount(MahjongHuBanner, {
      props: { seat: 0, fan: 3, selfDraw: true, leftPct: 50, topPct: 50 },
    });
    expect(w.find('.mj-hu-banner').classes()).toContain('mj-hu-banner--navy');
    expect(w.text()).toContain('自摸');
    expect(w.text()).toContain('3 番');
  });

  it('源码闸：海军蓝/金 token，橙色消失', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongHuBanner.vue', 'utf8');
    expect(src).toContain('$ftl-color-mj-navy');
    expect(src).toContain('$ftl-color-mj-gold');
    expect(src).not.toMatch(/rgba\(\s*255\s*,\s*180\s*,\s*60/);
    expect(src).not.toMatch(/rgba\(\s*220\s*,\s*100\s*,\s*30/);
  });
});

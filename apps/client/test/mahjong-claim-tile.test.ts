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
  it('天月风根类 + 按钮文案/emit', async () => {
    const w = mount(ClaimTile, { props: { options } });
    expect(w.find('.mj-claim-tile').classes()).toContain('mj-claim-tile--navy');
    const buttons = w.findAll('.mj-claim-tile__opt');
    expect(buttons.map((b) => b.text())).toEqual(['3 番胡', '碰', '杠']);
    await buttons[1]!.trigger('click');
    expect(w.emitted('claim')?.[0]).toEqual([options[1]]);
    await w.find('.mj-claim-tile__pass').trigger('click');
    expect(w.emitted('pass')).toHaveLength(1);
  });

  it('源码闸：海军蓝/金 token，旧绿色消失', () => {
    const src = readFileSync('src/components/table/mahjong/ClaimTile.vue', 'utf8');
    expect(src).toContain('$ftl-color-mj-navy');
    expect(src).toContain('$ftl-color-mj-gold');
    expect(src).toContain('$ftl-color-mj-on-gold');
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

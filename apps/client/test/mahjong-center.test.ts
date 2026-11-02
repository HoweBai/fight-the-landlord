import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Tile } from '@fight-the-landlord/protocol';
import MahjongCenter from '../src/components/table/mahjong/MahjongCenter.vue';

const base = {
  wallCount: 42,
  phaseText: '请出牌',
  seconds: 12,
  active: true,
  claimW: 34,
  claimH: 45,
  tingW: 20,
  tingH: 27,
};

describe('MahjongCenter', () => {
  it('active + seconds>0：圆盘显示秒数', () => {
    const w = mount(MahjongCenter, { props: base });
    expect(w.find('.mj-center__value').text()).toContain('12');
    expect(w.text()).toContain('牌墙 42');
    expect(w.text()).toContain('请出牌');
  });

  it('无 claim/ting/endedText 时右列不渲染（圆盘居中）', () => {
    const w = mount(MahjongCenter, { props: base });
    expect(w.find('.mj-center__side').exists()).toBe(false);
  });

  it('active=false：圆盘显示牌墙数，不显示 12', () => {
    const w = mount(MahjongCenter, { props: { ...base, active: false } });
    expect(w.find('.mj-center__value').text()).toContain('42');
    expect(w.find('.mj-center__value').text()).not.toContain('12');
  });

  it('active + seconds=0：显示牌墙数，无 urgent', () => {
    const w = mount(MahjongCenter, { props: { ...base, seconds: 0 } });
    expect(w.find('.mj-center__value').text()).toContain('42');
    expect(w.find('.mj-center__dial').classes()).not.toContain('mj-center__dial--urgent');
  });

  it('active + seconds=6：非 urgent', () => {
    const w = mount(MahjongCenter, { props: { ...base, seconds: 6 } });
    expect(w.find('.mj-center__dial').classes()).not.toContain('mj-center__dial--urgent');
  });

  it('active + seconds=5：urgent + anim-urgent-pulse', () => {
    const w = mount(MahjongCenter, { props: { ...base, seconds: 5 } });
    expect(w.find('.mj-center__dial').classes()).toContain('mj-center__dial--urgent');
    expect(w.find('.mj-center__dial').classes()).toContain('anim-urgent-pulse');
  });

  it('ended：圆盘显示终，endedText 仍是次要行', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, ended: true, endedText: '已胡 2 家' },
    });
    expect(w.find('.mj-center__value').text()).toContain('终');
    expect(w.text()).toContain('已胡 2 家');
  });

  it('未结束的 endedText 不抢圆盘', () => {
    const w = mount(MahjongCenter, { props: { ...base, endedText: '已胡 1 家' } });
    expect(w.find('.mj-center__value').text()).toContain('12');
    expect(w.text()).toContain('已胡 1 家');
  });

  it('待响应牌 + 听牌 + maxFan', () => {
    const w = mount(MahjongCenter, {
      props: {
        ...base,
        claimTile: { s: 0, r: 5 },
        tingTiles: [{ s: 0, r: 5 }, { s: 0, r: 8 }],
        maxFan: 5,
      },
    });
    expect(w.findAll('image')).toHaveLength(3);
    expect(w.text()).toContain('可响应');
    expect(w.text()).toContain('5 番');
    expect(w.findAll('.mj-tile')[0]!.attributes('style')).toContain('width: 34px');
    expect(w.findAll('.mj-tile')[1]!.attributes('style')).toContain('width: 20px');
  });

  it('13 张听牌：最多 12 张 + "+1"', () => {
    const tingTiles: Tile[] = Array.from({ length: 13 }, (_, i) => ({
      s: 0 as const,
      r: ((i % 9) + 1) as Tile['r'],
    }));
    const w = mount(MahjongCenter, { props: { ...base, tingTiles } });
    expect(w.findAll('.mj-tile')).toHaveLength(12);
    expect(w.text()).toContain('+1');
  });

  it('紧凑模式：单行、不出牌面、只出文字', () => {
    const w = mount(MahjongCenter, {
      props: { ...base, compact: true, claimTile: { s: 0, r: 5 } },
    });
    expect(w.classes()).toContain('mj-center--compact');
    expect(w.findAll('image')).toHaveLength(0);
    expect(w.text()).toContain('可响应');
    expect(w.text()).toContain('万5');
  });

  it('默认 claimH=45 / tingH=27', () => {
    const w = mount(MahjongCenter, {
      props: {
        wallCount: 42,
        phaseText: '请出牌',
        seconds: 12,
        active: true,
        claimTile: { s: 0, r: 5 },
        tingTiles: [{ s: 0, r: 8 }],
      },
    });
    expect(w.findAll('.mj-tile')[0]!.attributes('style')).toContain('height: 45px');
    expect(w.findAll('.mj-tile')[1]!.attributes('style')).toContain('height: 27px');
  });

  it('源码闸：@import animations + 紧凑 11px', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongCenter.vue', 'utf8');
    expect(src).toContain("@import '../../../styles/animations.scss'");
    expect(src).toMatch(/\.mj-center--compact \.mj-center__strip,[\s\S]*?font-size: 11px/);
  });
});

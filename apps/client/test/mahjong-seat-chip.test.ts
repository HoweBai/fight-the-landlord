import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MahjongSeatChip from '../src/components/table/mahjong/MahjongSeatChip.vue';

const base = {
  name: '北家乙',
  cardCount: 13,
  balance: 15500,
  avatar: 56,
  variant: 'side' as const,
};

describe('MahjongSeatChip', () => {
  it('side 变体：头像/名字/张数/分数', () => {
    const w = mount(MahjongSeatChip, { props: base });
    expect(w.find('.mj-chip').classes()).toContain('mj-chip--side');
    expect(w.find('image').attributes('src')).toBe('/static/ui/default.png');
    expect(w.text()).toContain('北家乙');
    expect(w.text()).toContain('13 张');
    expect(w.text()).toContain('15500');
  });

  it('庄/缺/听/托管/出局/胡/番/临时分徽标各自出现', () => {
    const w = mount(MahjongSeatChip, {
      props: {
        ...base,
        isDealer: true,
        lackSuit: 0,
        ting: true,
        trustee: true,
        pendingDelta: 12,
      },
    });
    expect(w.text()).toContain('庄');
    expect(w.text()).toContain('缺万');
    expect(w.text()).toContain('听');
    expect(w.text()).toContain('托管');
    expect(w.text()).toContain('+12');

    const hu = mount(MahjongSeatChip, {
      props: {
        ...base,
        hu: { seat: 2, fromSeat: 0, tile: { s: 0, r: 1 }, fan: 3, multiplier: 2, selfDraw: false, items: ['清一色', '根'] },
        isOut: true,
      },
    });
    expect(hu.text()).toContain('胡');
    expect(hu.text()).toContain('3 番');
    expect(hu.text()).toContain('清一色');
    expect(hu.text()).toContain('等2种');
    expect(hu.text()).not.toContain('已出局');
  });

  it('bar 变体不显示张数，只显示分数', () => {
    const w = mount(MahjongSeatChip, { props: { ...base, variant: 'bar' } });
    expect(w.text()).toContain('15500');
    expect(w.text()).not.toContain('13 张');
  });

  it('self 变体：不渲染名字，显示分数', () => {
    const w = mount(MahjongSeatChip, { props: { ...base, isMe: true, variant: 'self' } });
    expect(w.find('.mj-chip__name').exists()).toBe(false);
    expect(w.text()).toContain('15500');
  });

  it('activeLevel 发光类', () => {
    expect(
      mount(MahjongSeatChip, { props: { ...base, activeLevel: 'strong' } })
        .find('.mj-chip')
        .classes(),
    ).toContain('mj-chip--active-strong');
    expect(
      mount(MahjongSeatChip, { props: { ...base, activeLevel: 'weak' } })
        .find('.mj-chip')
        .classes(),
    ).toContain('mj-chip--active-weak');
  });

  it('头像尺寸跟随 avatar prop', () => {
    const w = mount(MahjongSeatChip, { props: { ...base, avatar: 40 } });
    expect(w.find('.mj-chip__avatar-box').attributes('style')).toContain('width: 40px');
    expect(w.find('.mj-chip__avatar-box').attributes('style')).toContain('height: 40px');
  });
});

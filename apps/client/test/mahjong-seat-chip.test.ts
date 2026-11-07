import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MahjongSeatChip from '../src/components/table/mahjong/MahjongSeatChip.vue';

/**
 * Task 6：SeatChip 四变体 / 角标 / 静态金边。
 * 设计：docs/superpowers/specs/2026-11-05-mahjong-table-redgold-design-v6.md §3.4、§4。
 * 约束：无张数、无番行/徽标行、无 animation/infinite；角标最多 2（右上 1 字 + 左下 2 字）。
 */
const base = {
  name: '北家乙',
  cardCount: 13,
  balance: 15500,
  avatar: 56,
  variant: 'corner-tr' as const,
};

const huInfo = {
  seat: 2,
  fromSeat: 0,
  tile: { s: 0, r: 1 },
  fan: 3,
  multiplier: 2,
  selfDraw: false,
  items: ['清一色'],
};

function mountChip(props: Record<string, unknown> = {}) {
  return mount(MahjongSeatChip, { props: { ...base, ...props } });
}

describe('MahjongSeatChip', () => {
  it('四变体各自渲染 mj-chip--<variant> class', () => {
    for (const v of ['corner-tl', 'corner-tr', 'corner-top', 'self'] as const) {
      const w = mountChip({ variant: v });
      expect(w.find('.mj-chip').classes()).toContain(`mj-chip--${v}`);
    }
  });

  it('角标：庄 + 缺万 → 右上 1 + 左下 1，共 2 个', () => {
    const w = mountChip({ isDealer: true, lackSuit: 0 });
    const tr = w.findAll('.mj-chip__corner--tr');
    expect(tr).toHaveLength(1);
    expect(tr[0].text()).toBe('庄');
    expect(tr[0].classes()).toContain('mj-chip__corner--dealer');
    const bl = w.findAll('.mj-chip__corner--bl');
    expect(bl).toHaveLength(1);
    expect(bl[0].text()).toBe('缺万');
    expect(bl[0].classes()).toContain('mj-chip__corner--lack');
    expect(w.findAll('.mj-chip__corner')).toHaveLength(2);
  });

  it('角标优先级：胡 > 听 > 托 > 庄，每槽最多一个', () => {
    const w = mountChip({
      hu: huInfo,
      ting: true,
      trustee: true,
      isDealer: true,
      lackSuit: 1,
    });
    const tr = w.findAll('.mj-chip__corner--tr');
    expect(tr).toHaveLength(1);
    expect(tr[0].text()).toBe('胡');
    expect(tr[0].classes()).toContain('mj-chip__corner--hu');
    const bl = w.findAll('.mj-chip__corner--bl');
    expect(bl).toHaveLength(1);
    expect(bl[0].text()).toBe('缺筒');
    expect(w.findAll('.mj-chip__corner')).toHaveLength(2);
  });

  it('听 / 托 / 庄 单独出现', () => {
    const ting = mountChip({ ting: true });
    expect(ting.find('.mj-chip__corner--tr').text()).toBe('听');
    expect(ting.find('.mj-chip__corner--ting').exists()).toBe(true);

    const trustee = mountChip({ trustee: true });
    expect(trustee.find('.mj-chip__corner--tr').text()).toBe('托');
    expect(trustee.find('.mj-chip__corner--trustee').exists()).toBe(true);

    const dealer = mountChip({ isDealer: true });
    expect(dealer.find('.mj-chip__corner--tr').text()).toBe('庄');
  });

  it('不渲染张数（无「N 张」）', () => {
    const w = mountChip({ cardCount: 13 });
    expect(w.text()).not.toContain('13 张');
    expect(w.text()).not.toContain('张');
  });

  it('无番行 / 徽标行（清一色、番、已出局、托管文案都不出现）', () => {
    const w = mountChip({ hu: huInfo, isOut: true, trustee: true });
    expect(w.text()).not.toContain('清一色');
    expect(w.text()).not.toContain('番');
    expect(w.text()).not.toContain('已出局');
    expect(w.text()).not.toContain('托管');
    expect(w.find('.mj-chip__badges').exists()).toBe(false);
    expect(w.find('.mj-chip__badge').exists()).toBe(false);
  });

  it('静态金边：strong / line(weak 别名) / winner', () => {
    expect(mountChip({ activeLevel: 'strong' }).find('.mj-chip').classes()).toContain(
      'mj-chip--active-strong',
    );
    for (const level of ['line', 'weak'] as const) {
      const w = mountChip({ activeLevel: level });
      expect(w.find('.mj-chip').classes()).toContain('mj-chip--active-line');
      expect(w.find('.mj-chip').classes()).not.toContain('mj-chip--active-weak');
    }
    expect(mountChip({ winner: true }).find('.mj-chip').classes()).toContain('mj-chip--winner');
  });

  it('源码闸：本组件不含 animation / infinite', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongSeatChip.vue', 'utf8');
    expect(src).not.toContain('animation');
    expect(src).not.toContain('infinite');
  });

  it('内联字号：对手 名字18/分数18/delta14；自己 分数16/delta10', () => {
    const opponent = mountChip({ pendingDelta: 12 });
    expect(opponent.find('.mj-chip__name').attributes('style')).toContain('font-size: 18px');
    expect(opponent.find('.mj-chip__score').attributes('style')).toContain('font-size: 18px');
    expect(opponent.find('.mj-chip__delta').attributes('style')).toContain('font-size: 14px');

    const me = mountChip({ variant: 'self', isMe: true, pendingDelta: -5 });
    expect(me.find('.mj-chip__score').attributes('style')).toContain('font-size: 16px');
    expect(me.find('.mj-chip__delta').attributes('style')).toContain('font-size: 10px');
  });

  it('legacy side / bar 仍可挂载并显示名字与分数（Task 8 移除）', () => {
    for (const v of ['side', 'bar'] as const) {
      const w = mountChip({ variant: v });
      expect(w.find('.mj-chip').classes()).toContain(`mj-chip--${v}`);
      expect(w.text()).toContain('北家乙');
      expect(w.text()).toContain('15500');
    }
  });

  it('头像框尺寸跟随 avatar prop', () => {
    const w = mountChip({ avatar: 44 });
    expect(w.find('.mj-chip__avatar-box').attributes('style')).toContain('width: 44px');
    expect(w.find('.mj-chip__avatar-box').attributes('style')).toContain('height: 44px');
  });
});

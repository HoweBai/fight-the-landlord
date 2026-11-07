import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongPhase } from '@fight-the-landlord/protocol';
import MahjongHub from '../src/components/table/mahjong/MahjongHub.vue';

/** 血战盘：牌墙/倒计时/四向方位点/四家徽标/听 N/状态行；无分数、无中央 claim 牌。 */

const hub = {
  left: 0,
  top: 0,
  width: 200,
  height: 200,
  cx: 100,
  cy: 100,
  r: 100,
  compact: false,
};

const DIRS = ['top', 'left', 'right', 'self'] as const;

const seats = [
  { seat: 0, dir: 'self' as const },
  { seat: 1, dir: 'right' as const },
  { seat: 2, dir: 'top' as const },
  { seat: 3, dir: 'left' as const },
];

const base = {
  hub,
  wallCount: 42,
  seconds: 12,
  phase: 'play' as MahjongPhase,
  currentPlayer: 2,
  activeSeats: [0, 2],
  seats,
  tingCount: 0,
  statusText: '等待出牌',
  endedText: '',
};

type Props = typeof base;

/** 挂载后返回被点亮的方位（固定 top/left/right/self 顺序）。 */
function litDirs(over: Partial<Props> = {}): string[] {
  const w = mount(MahjongHub, { props: { ...base, ...over } });
  return DIRS.filter((dir) =>
    w.find(`.mj-hub__dot--${dir}`).classes().includes('mj-hub__dot--lit'),
  );
}

describe('MahjongHub（血战盘）', () => {
  it('牌墙/倒计时/状态行/四向点/金环/牌墙标签', () => {
    const w = mount(MahjongHub, { props: base });
    expect(w.find('.mj-hub').exists()).toBe(true);
    expect(w.find('.mj-hub__ring').exists()).toBe(true);
    expect(w.find('.mj-hub__wall-count').text()).toBe('42');
    expect(w.find('.mj-hub__wall-label').text()).toBe('牌墙');
    expect(w.find('.mj-hub__clock').text()).toBe('12s');
    expect(w.find('.mj-hub__status').text()).toBe('等待出牌');
    expect(w.findAll('.mj-hub__dot')).toHaveLength(4);
  });

  it('倒计时最后 5 秒加紧迫类', () => {
    const urgent = mount(MahjongHub, { props: { ...base, seconds: 4 } });
    expect(urgent.find('.mj-hub__clock').classes()).toContain('mj-hub__clock--urgent');
    const calm = mount(MahjongHub, { props: { ...base, seconds: 6 } });
    expect(calm.find('.mj-hub__clock').classes()).not.toContain('mj-hub__clock--urgent');
    const zero = mount(MahjongHub, { props: { ...base, seconds: 0 } });
    expect(zero.find('.mj-hub__clock').classes()).not.toContain('mj-hub__clock--urgent');
  });

  it('方位点：play 亮 currentPlayer', () => {
    expect(litDirs({ phase: 'play', currentPlayer: 2 })).toEqual(['top']);
  });

  it('方位点：claim 亮 currentPlayer', () => {
    expect(litDirs({ phase: 'claim', currentPlayer: 1 })).toEqual(['right']);
  });

  it('方位点：rob 同 claim 亮 currentPlayer', () => {
    expect(litDirs({ phase: 'rob', currentPlayer: 1 })).toEqual(['right']);
  });

  it('方位点：exchange/lack 亮 activeSeats', () => {
    expect(litDirs({ phase: 'exchange', activeSeats: [0, 3] })).toEqual(['left', 'self']);
    expect(litDirs({ phase: 'lack', activeSeats: [1] })).toEqual(['right']);
  });

  it('方位点：ended 一个都不亮', () => {
    expect(litDirs({ phase: 'ended', activeSeats: [0, 1, 2, 3] })).toEqual([]);
  });

  it('方位点：没有映射座位的方向永不点亮', () => {
    expect(
      litDirs({
        phase: 'play',
        currentPlayer: 2,
        seats: seats.filter((s) => s.dir !== 'top'),
      }),
    ).toEqual([]);
  });

  it('徽标：四向各一，方向类 + 种类修饰 + 文案', () => {
    const w = mount(MahjongHub, {
      props: {
        ...base,
        seats: [
          { seat: 0, dir: 'self', badge: 'hu', badgeText: '胡 3' },
          { seat: 1, dir: 'right', badge: 'lack', badgeText: '缺万' },
          { seat: 2, dir: 'top', badge: 'ting', badgeText: '听' },
          { seat: 3, dir: 'left', badge: 'trustee', badgeText: '托管' },
        ],
      },
    });
    expect(w.findAll('.mj-hub__badge')).toHaveLength(4);
    const expected: Array<[string, string, string]> = [
      ['top', 'ting', '听'],
      ['left', 'trustee', '托管'],
      ['right', 'lack', '缺万'],
      ['self', 'hu', '胡 3'],
    ];
    for (const [dir, kind, text] of expected) {
      const el = w.find(`.mj-hub__badge--${dir}`);
      expect(el.exists()).toBe(true);
      expect(el.text()).toBe(text);
      expect(el.classes()).toContain(`mj-hub__badge--${kind}`);
    }
  });

  it('徽标：badge 为 null 或 badgeText 为空都不渲染', () => {
    const none = mount(MahjongHub, {
      props: { ...base, seats: [{ seat: 0, dir: 'self', badge: null, badgeText: '听' }] },
    });
    expect(none.findAll('.mj-hub__badge')).toHaveLength(0);
    const empty = mount(MahjongHub, {
      props: { ...base, seats: [{ seat: 0, dir: 'self', badge: 'ting', badgeText: '' }] },
    });
    expect(empty.findAll('.mj-hub__badge')).toHaveLength(0);
  });

  it('听牌：tingCount>0 显示「听 N 张」，0 不渲染', () => {
    const w = mount(MahjongHub, { props: { ...base, tingCount: 3 } });
    expect(w.find('.mj-hub__ting').text()).toBe('听 3 张');
    const zero = mount(MahjongHub, { props: { ...base, tingCount: 0 } });
    expect(zero.find('.mj-hub__ting').exists()).toBe(false);
  });

  it('endedText 覆盖状态行', () => {
    const w = mount(MahjongHub, { props: { ...base, endedText: '已胡 2 家' } });
    expect(w.find('.mj-hub__status').text()).toBe('已胡 2 家');
  });

  it('normal 字号内联：牌墙 40 / 秒 22 / 状态 14 / 听 14 / 徽标 16 / 点 10', () => {
    const w = mount(MahjongHub, {
      props: {
        ...base,
        tingCount: 2,
        seats: [{ seat: 0, dir: 'self', badge: 'hu', badgeText: '胡 3' }],
      },
    });
    expect(w.find('.mj-hub__wall-count').attributes('style')).toContain('font-size: 40px');
    expect(w.find('.mj-hub__clock').attributes('style')).toContain('font-size: 22px');
    expect(w.find('.mj-hub__status').attributes('style')).toContain('font-size: 14px');
    expect(w.find('.mj-hub__ting').attributes('style')).toContain('font-size: 14px');
    expect(w.find('.mj-hub__badge').attributes('style')).toContain('font-size: 16px');
    expect(w.find('.mj-hub__dot').attributes('style')).toContain('font-size: 10px');
    expect(w.find('.mj-hub__wall-label').exists()).toBe(true);
  });

  it('compact 字号内联：牌墙 32 / 秒 18 / 状态 12 / 听 12 / 徽标 14 / 点 8，且隐藏牌墙标签', () => {
    const w = mount(MahjongHub, {
      props: {
        ...base,
        compact: true,
        tingCount: 2,
        seats: [{ seat: 0, dir: 'self', badge: 'hu', badgeText: '胡 3' }],
      },
    });
    expect(w.classes()).toContain('mj-hub--compact');
    expect(w.find('.mj-hub__wall-count').attributes('style')).toContain('font-size: 32px');
    expect(w.find('.mj-hub__clock').attributes('style')).toContain('font-size: 18px');
    expect(w.find('.mj-hub__status').attributes('style')).toContain('font-size: 12px');
    expect(w.find('.mj-hub__ting').attributes('style')).toContain('font-size: 12px');
    expect(w.find('.mj-hub__badge').attributes('style')).toContain('font-size: 14px');
    expect(w.find('.mj-hub__dot').attributes('style')).toContain('font-size: 8px');
    expect(w.find('.mj-hub__wall-label').exists()).toBe(false);
  });

  it('compact 未显式传 prop 时回退 hub.compact', () => {
    const w = mount(MahjongHub, {
      props: { ...base, compact: undefined, hub: { ...hub, compact: true } },
    });
    expect(w.classes()).toContain('mj-hub--compact');
  });

  it('状态行截断：normal 10 字 + …，compact 8 字 + …，不换行', () => {
    const long = '一二三四五六七八九十甲乙';
    const normal = mount(MahjongHub, { props: { ...base, statusText: long } });
    expect(normal.find('.mj-hub__status').text()).toBe('一二三四五六七八九十…');
    const compact = mount(MahjongHub, {
      props: { ...base, compact: true, statusText: long },
    });
    expect(compact.find('.mj-hub__status').text()).toBe('一二三四五六七八…');
    expect(compact.find('.mj-hub__status').text().length).toBe(9);
  });

  it('无分数、无中央 claim 牌、无 MahjongTile 图片', () => {
    const w = mount(MahjongHub, { props: base });
    expect(w.find('.mj-hub__score').exists()).toBe(false);
    expect(w.find('.mj-hub__claim').exists()).toBe(false);
    expect(w.find('image').exists()).toBe(false);
    expect(w.text()).not.toMatch(/分数|底分|积分/);
  });

  it('源码闸：本组件不含 animation/infinite（动效归 Task 10）', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongHub.vue', 'utf8');
    expect(src).not.toMatch(/animation/);
    expect(src).not.toMatch(/infinite/);
  });

  it('源码闸：金环 inline border 走 2px（与 $ftl-hairline 等价；1px 缩放后不可见）', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongHub.vue', 'utf8');
    expect(src).not.toMatch(/border:\s*'1px/);
    expect(src).toMatch(/border:\s*'2px solid/);
  });
});

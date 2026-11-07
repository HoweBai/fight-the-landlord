import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongPhase } from '@fight-the-landlord/protocol';
import MahjongHub from '../src/components/table/mahjong/MahjongHub.vue';

/**
 * 血战盘：牌墙 / 倒计时 / 状态行 / 四向方位点 / 四家徽标 / 胡牌金光；
 * 无分数、无中央 claim 牌、无听 N（听 N 已移到牌桌的行标签，Task 2）。
 */

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
  statusText: '等待出牌',
  endedText: '',
};

type Props = typeof base;

const src = readFileSync('src/components/table/mahjong/MahjongHub.vue', 'utf8');
const style = src.slice(src.indexOf('<style'));

/** 取一条选择器规则的声明体（本组件这些规则没有嵌套块）。 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `${selector} 规则必须存在`).not.toBeNull();
  return m![1]!;
}

/** 挂载后返回被点亮的方位（固定 top/left/right/self 顺序）。 */
function litDirs(over: Partial<Props> = {}): string[] {
  const w = mount(MahjongHub, { props: { ...base, ...over } });
  return DIRS.filter((dir) =>
    w.find(`.mj-hub__dot--${dir}`).classes().includes('mj-hub__dot--lit'),
  );
}

describe('MahjongHub（血战盘）', () => {
  it('牌墙/倒计时/状态行/四向点/牌墙标签；旧金环已删除', () => {
    const w = mount(MahjongHub, { props: base });
    expect(w.find('.mj-hub').exists()).toBe(true);
    expect(w.find('.mj-hub__ring').exists()).toBe(false);
    expect(w.find('.mj-hub__wall-count').text()).toBe('42');
    expect(w.find('.mj-hub__wall-label').text()).toBe('牌墙');
    expect(w.find('.mj-hub__clock').text()).toBe('12s');
    expect(w.find('.mj-hub__status').text()).toBe('等待出牌');
    expect(w.findAll('.mj-hub__dot')).toHaveLength(4);
  });

  it('源码闸：根用 6px 金环（border-box）+ 径向漆底 + 三段 box-shadow', () => {
    const root = ruleBody(style, '.mj-hub');
    expect(root).toContain('box-sizing: border-box');
    expect(root).toContain('border: 6px solid $ftl-color-mj-gold');
    expect(root).toContain('border-radius: 50%');
    expect(root).toContain(
      'radial-gradient(circle at 50% 42%, $ftl-color-mj-hub-core 0%, $ftl-color-mj-lacquer 70%)',
    );
    expect(root).toContain('0 0 0 $ftl-hairline $ftl-color-mj-border');
    expect(root).toContain('0 0 28px rgba($ftl-color-mj-gold');
    expect(root).toContain('inset 0 0 24px rgba(0, 0, 0, .6)');
    expect(root).toContain('color: $ftl-color-mj-cream');
    expect(root).toContain('text-align: center');
    // 根**不得**剪裁：四角徽标（14%/86%）与方位点外缘会压在圆外，overflow: hidden 会把
    // 字形裁掉（mockup 的 `.hub` 也没有 overflow）。金光层/状态行各自持有裁切。
    expect(root).not.toContain('overflow: hidden');
    expect(ruleBody(style, '.mj-hub__status')).toContain('overflow: hidden');
    expect(ruleBody(style, '.mj-hub__flash')).toContain('border-radius: 50%');
    // 旧结构：ring 与内联色值都不允许残留。
    expect(src).not.toContain('mj-hub__ring');
    expect(src).not.toMatch(/ringStyle/);
    expect(src).not.toMatch(/#D4A24C/i);
    expect(src).not.toContain('mj-hub__body');
  });

  it('源码闸：牌墙 48/40（14% / 12%）、标签 14（38%，compact 也显示）', () => {
    const wall = ruleBody(style, '.mj-hub__wall-count');
    expect(wall).toContain('top: 14%');
    expect(wall).toContain('color: $ftl-color-mj-sheen');
    expect(wall).toContain('font-weight: 700');
    expect(wall).toContain('tabular-nums');
    expect(ruleBody(style, '.mj-hub--compact .mj-hub__wall-count')).toContain('top: 12%');

    const label = ruleBody(style, '.mj-hub__wall-label');
    expect(label).toContain('top: 38%');
    expect(label).toContain('color: $ftl-color-mj-muted');
    // compact 不再隐藏标签（无 display: none / 无 compact 覆盖规则隐藏）。
    expect(style).not.toMatch(/\.mj-hub__wall-label[^{]*\{[^}]*display:\s*none/);
  });

  it('源码闸：秒 48%、状态 64%/66% + status 色 + 84% 省略', () => {
    expect(ruleBody(style, '.mj-hub__clock')).toContain('top: 48%');
    expect(ruleBody(style, '.mj-hub__clock')).toContain('color: $ftl-color-mj-cream');
    const status = ruleBody(style, '.mj-hub__status');
    expect(status).toContain('top: 64%');
    expect(status).toContain('color: $ftl-color-mj-status');
    expect(status).toContain('max-width: 84%');
    expect(status).toContain('text-overflow: ellipsis');
    expect(ruleBody(style, '.mj-hub--compact .mj-hub__status')).toContain('top: 66%');
  });

  it('源码闸：方位点 10/8 + dot/highlight token + 过渡；四向 2%/50%/98% 锚点', () => {
    const dot = ruleBody(style, '.mj-hub__dot');
    expect(dot).toContain('width: 10px');
    expect(dot).toContain('height: 10px');
    expect(dot).toContain('background: $ftl-color-mj-dot');
    expect(dot).toContain('transition: background .3s, box-shadow .3s');
    expect(ruleBody(style, '.mj-hub--compact .mj-hub__dot')).toContain('width: 8px');

    const top = ruleBody(style, '.mj-hub__dot--top');
    expect(top).toContain('top: 2%');
    expect(top).toContain('left: 50%');
    const right = ruleBody(style, '.mj-hub__dot--right');
    expect(right).toContain('right: 2%');
    expect(right).toContain('top: 50%');
    const self = ruleBody(style, '.mj-hub__dot--self');
    expect(self).toContain('bottom: 2%');
    expect(self).toContain('left: 50%');
    const left = ruleBody(style, '.mj-hub__dot--left');
    expect(left).toContain('left: 2%');
    expect(left).toContain('top: 50%');

    const lit = ruleBody(style, '.mj-hub__dot--lit');
    expect(lit).toContain('background: $ftl-color-mj-highlight');
    expect(lit).toContain('box-shadow: 0 0 8px $ftl-color-mj-highlight');
  });

  it('源码闸：徽标 12px 统一漆底金边（无绿/蓝/金语义色），四角映射', () => {
    const badge = ruleBody(style, '.mj-hub__badge');
    expect(badge).toContain('padding: 2px 5px');
    expect(badge).toContain('border: $ftl-hairline solid $ftl-color-mj-border');
    expect(badge).toContain('border-radius: 8px');
    expect(badge).toContain('background: $ftl-color-mj-lacquer');
    expect(badge).toContain('color: $ftl-color-mj-cream');
    expect(badge).toContain('transform: translate(-50%, -50%)');

    const corners: Array<[string, string, string]> = [
      ['.mj-hub__badge--left', 'top: 14%', 'left: 14%'],
      ['.mj-hub__badge--top', 'top: 14%', 'left: 86%'],
      ['.mj-hub__badge--right', 'top: 86%', 'left: 86%'],
      ['.mj-hub__badge--self', 'top: 86%', 'left: 14%'],
    ];
    for (const [selector, top, left] of corners) {
      const body = ruleBody(style, selector);
      expect(body, selector).toContain(top);
      expect(body, selector).toContain(left);
    }

    // 语义色修饰符全部删除。
    expect(style).not.toMatch(/\.mj-hub__badge--(?:hu|ting|lack|trustee)/);
    expect(style).not.toMatch(/rgba?\(\s*74,\s*222,\s*128/);
    expect(style).not.toMatch(/rgba?\(\s*120,\s*170,\s*255/);
  });

  it('无听 N：文案与 prop 都已移除（听 N 改到牌桌行标签）', () => {
    const w = mount(MahjongHub, { props: base });
    expect(w.find('.mj-hub__ting').exists()).toBe(false);
    expect(w.text()).not.toContain('听');
    expect(src).not.toContain('tingCount');
    expect(src).not.toContain('mj-hub__ting');
  });

  it('urgent：仅我方 play 且末 5 秒', () => {
    const selfTurn = (over: Partial<Props> = {}) =>
      mount(MahjongHub, { props: { ...base, currentPlayer: 0, seconds: 4, ...over } });

    const urgent = selfTurn();
    expect(urgent.find('.mj-hub__clock').classes()).toContain('mj-hub__clock--urgent');
    expect(urgent.find('.mj-hub__clock').classes()).toContain('anim-mj-urgent');

    for (const phase of ['claim', 'exchange', 'lack'] as MahjongPhase[]) {
      const w = selfTurn({ phase });
      expect(w.find('.mj-hub__clock').classes(), `${phase} 不得 urgent`).not.toContain(
        'mj-hub__clock--urgent',
      );
      expect(w.find('.mj-hub__clock').classes()).not.toContain('anim-mj-urgent');
    }

    // 非我方出牌。
    const other = selfTurn({ currentPlayer: 2 });
    expect(other.find('.mj-hub__clock').classes()).not.toContain('mj-hub__clock--urgent');

    // 6 秒不 urgent、0 秒不 urgent。
    expect(selfTurn({ seconds: 6 }).find('.mj-hub__clock').classes()).not.toContain(
      'mj-hub__clock--urgent',
    );
    expect(selfTurn({ seconds: 0 }).find('.mj-hub__clock').classes()).not.toContain(
      'mj-hub__clock--urgent',
    );

    // 没有映射 self 座位 ⇒ undefined ⇒ 永不 urgent。
    const noSelf = selfTurn({ seats: seats.filter((s) => s.dir !== 'self') });
    expect(noSelf.find('.mj-hub__clock').classes()).not.toContain('mj-hub__clock--urgent');
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

  it('endedText 覆盖状态行', () => {
    const w = mount(MahjongHub, { props: { ...base, endedText: '已胡 2 家' } });
    expect(w.find('.mj-hub__status').text()).toBe('已胡 2 家');
  });

  it('normal 字号内联：牌墙 48 / 标签 14 / 秒 22 / 状态 14 / 徽标 12 / 点 10', () => {
    const w = mount(MahjongHub, {
      props: {
        ...base,
        seats: [{ seat: 0, dir: 'self', badge: 'hu', badgeText: '胡 3' }],
      },
    });
    expect(w.find('.mj-hub__wall-count').attributes('style')).toContain('font-size: 48px');
    expect(w.find('.mj-hub__wall-label').attributes('style')).toContain('font-size: 14px');
    expect(w.find('.mj-hub__clock').attributes('style')).toContain('font-size: 22px');
    expect(w.find('.mj-hub__status').attributes('style')).toContain('font-size: 14px');
    expect(w.find('.mj-hub__badge').attributes('style')).toContain('font-size: 12px');
    expect(w.find('.mj-hub__dot').attributes('style')).toContain('font-size: 10px');
  });

  it('compact 字号内联：牌墙 40 / 标签 14（仍显示）/ 秒 18 / 状态 12 / 徽标 12 / 点 8', () => {
    const w = mount(MahjongHub, {
      props: {
        ...base,
        compact: true,
        seats: [{ seat: 0, dir: 'self', badge: 'hu', badgeText: '胡 3' }],
      },
    });
    expect(w.classes()).toContain('mj-hub--compact');
    expect(w.find('.mj-hub__wall-count').attributes('style')).toContain('font-size: 40px');
    expect(w.find('.mj-hub__wall-label').exists()).toBe(true);
    expect(w.find('.mj-hub__wall-label').text()).toBe('牌墙');
    expect(w.find('.mj-hub__wall-label').attributes('style')).toContain('font-size: 14px');
    expect(w.find('.mj-hub__clock').attributes('style')).toContain('font-size: 18px');
    expect(w.find('.mj-hub__status').attributes('style')).toContain('font-size: 12px');
    expect(w.find('.mj-hub__badge').attributes('style')).toContain('font-size: 12px');
    expect(w.find('.mj-hub__dot').attributes('style')).toContain('font-size: 8px');
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

  it('盘金光：flashKey>0 渲染覆盖层，key 变化重挂载，animationend 才 emit flash-done', async () => {
    const w = mount(MahjongHub, { props: base });
    expect(w.find('.mj-hub__flash').exists()).toBe(false);

    await w.setProps({ flashKey: 1 });
    const flash = w.find('.mj-hub__flash');
    expect(flash.exists()).toBe(true);
    expect(flash.classes()).toContain('anim-mj-hub-flash');

    // :key=flashKey ⇒ 键变化必须重挂载（重播动画）。
    const firstEl = flash.element;
    await w.setProps({ flashKey: 2 });
    expect(w.find('.mj-hub__flash').element).not.toBe(firstEl);

    // 无关动画的 animationend（例如内部其它元素冒泡）不得 emit。
    await w.find('.mj-hub__flash').trigger('animationend', { animationName: 'other-anim' });
    expect(w.emitted('flash-done')).toBeUndefined();

    // scoped 会重命名 @keyframes（前缀 + hash）⇒ startsWith 必须放行。
    await w.find('.mj-hub__flash').trigger('animationend', {
      animationName: 'ftl-mj-hub-flash-7ba3f1',
    });
    expect(w.emitted('flash-done')).toHaveLength(1);
  });

  it('源码闸：金光覆盖层 inset 0 / 圆角 / pointer-events none / 径向金色高光', () => {
    const flash = ruleBody(style, '.mj-hub__flash');
    expect(flash).toContain('position: absolute');
    expect(flash).toContain('inset: 0');
    expect(flash).toContain('border-radius: 50%');
    expect(flash).toContain('pointer-events: none');
    expect(flash).toContain('radial-gradient');
    expect(flash).toContain('rgba($ftl-color-mj-gold');
    // 模板接线：类 + animationend。
    expect(src).toContain('anim-mj-hub-flash');
    expect(src).toContain('@animationend="onFlashEnd"');
    expect(src).toContain("startsWith('ftl-mj-hub-flash')");
  });

  it('无分数、无中央 claim 牌、无 MahjongTile 图片', () => {
    const w = mount(MahjongHub, { props: base });
    expect(w.find('.mj-hub__score').exists()).toBe(false);
    expect(w.find('.mj-hub__claim').exists()).toBe(false);
    expect(w.find('image').exists()).toBe(false);
    expect(w.text()).not.toMatch(/分数|底分|积分/);
  });

  it('源码闸：本组件不定义 animation / infinite（动效类由 animations.scss 提供）', () => {
    // 组件自己不写 animation 声明（类与 keyframes 全在 animations.scss；scoped 需 import）。
    expect(style).not.toMatch(/animation\s*:/);
    expect(src).not.toMatch(/infinite/);
    // Task 10 接线：紧迫钟必须引用有限脉动类，且样式块必须导入动画文件。
    expect(src).toContain('anim-mj-urgent');
    expect(style).toMatch(/@import\s+['"][^'"]*styles\/animations\.scss['"]/);
  });

  it('源码闸：组件样式无裸 1px（发丝线走 $ftl-hairline）', () => {
    expect(style).not.toMatch(/(?:^|[^\d])1px\b/);
  });
});

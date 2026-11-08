import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongPhase } from '@fight-the-landlord/protocol';
import MahjongHub from '../src/components/table/mahjong/MahjongHub.vue';

/**
 * 铜钱信息井：中央方孔（牌墙 + 操作提示）+ 四扇形（倒计时/胡听缺托）+ 胡牌金光。
 * 视觉恒为紧凑档（160×160 设计 px，由 Board 定位/缩放）。
 */

const DIRS = ['top', 'left', 'right', 'self'] as const;

type TestSeat = {
  seat: number;
  dir: 'top' | 'left' | 'right' | 'self';
  badge?: 'hu' | 'ting' | 'lack' | 'trustee' | null;
  badgeText?: string;
};
const seats: TestSeat[] = [
  { seat: 0, dir: 'self' },
  { seat: 1, dir: 'right' },
  { seat: 2, dir: 'top' },
  { seat: 3, dir: 'left' },
];

const base = {
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
const styleCode = style.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `${selector} 规则必须存在`).not.toBeNull();
  return m![1]!;
}

function mountHub(over: Partial<Props> = {}) {
  return mount(MahjongHub, { props: { ...base, ...over } });
}

function litDirs(over: Partial<Props> = {}): string[] {
  const w = mountHub(over);
  return DIRS.filter((dir) =>
    w.find(`.mj-hub__sector--${dir}`).classes().includes('mj-hub__sector--lit'),
  );
}

function slot(w: ReturnType<typeof mountHub>, dir: string) {
  return w.find(`.mj-hub__slot--${dir}`);
}

describe('MahjongHub（铜钱信息井）', () => {
  it('结构：方孔 42 + 等待出牌；4 扇形 + 2 对角发丝；旧点/徽标/状态行/牌墙标签全部移除', () => {
    const w = mountHub();
    expect(w.find('.mj-hub').exists()).toBe(true);
    expect(w.findAll('.mj-hub__sector')).toHaveLength(4);
    expect(w.findAll('.mj-hub__diag')).toHaveLength(2);
    expect(w.find('.mj-hub__hole .mj-hub__wall-count').text()).toBe('42');
    expect(w.find('.mj-hub__hole .mj-hub__hint').text()).toBe('等待出牌');
    expect(w.find('.mj-hub__wall-label').exists()).toBe(false);
    expect(w.find('.mj-hub__status').exists()).toBe(false);
    expect(w.find('.mj-hub__dot').exists()).toBe(false);
    expect(w.find('.mj-hub__badge').exists()).toBe(false);
    expect(w.find('.mj-hub__clock').exists()).toBe(false);
    expect(w.find('.mj-hub__ring').exists()).toBe(false);
  });

  it('扇形亮灭：play/claim/rob 亮 currentPlayer', () => {
    expect(litDirs({ phase: 'play', currentPlayer: 2 })).toEqual(['top']);
    expect(litDirs({ phase: 'claim', currentPlayer: 1 })).toEqual(['right']);
    expect(litDirs({ phase: 'rob', currentPlayer: 1 })).toEqual(['right']);
  });

  it('扇形亮灭：exchange/lack 亮 activeSeats；ended/draw 全灭；无映射座位不亮', () => {
    expect(litDirs({ phase: 'exchange', activeSeats: [0, 3] })).toEqual(['left', 'self']);
    expect(litDirs({ phase: 'lack', activeSeats: [1] })).toEqual(['right']);
    expect(litDirs({ phase: 'ended', activeSeats: [0, 1, 2, 3] })).toEqual([]);
    expect(litDirs({ phase: 'draw', activeSeats: [0, 1, 2, 3] })).toEqual([]);
    expect(
      litDirs({ phase: 'play', currentPlayer: 2, seats: seats.filter((s) => s.dir !== 'top') }),
    ).toEqual([]);
  });

  it('槽轮换：lit 显示倒计时，未 lit 显示徽标，无徽标为空', () => {
    const w = mountHub({
      seats: [
        { seat: 0, dir: 'self', badge: 'ting', badgeText: '听' },
        { seat: 1, dir: 'right' },
        { seat: 2, dir: 'top', badge: 'hu', badgeText: '胡' },
        { seat: 3, dir: 'left', badge: 'lack', badgeText: '缺' },
      ],
      currentPlayer: 2,
    });
    expect(slot(w, 'top').text()).toBe('12s'); // lit 覆盖徽标
    expect(slot(w, 'self').text()).toBe('听');
    expect(slot(w, 'left').text()).toBe('缺');
    expect(slot(w, 'right').exists()).toBe(false);
    expect(slot(w, 'top').classes()).not.toContain('mj-hub__slot--badge');
    expect(slot(w, 'self').classes()).toContain('mj-hub__slot--badge');
  });

  it('徽标：badge 为 null 或 badgeText 为空都不渲染', () => {
    const none = mountHub({ seats: [{ seat: 0, dir: 'self', badge: null, badgeText: '听' }] });
    expect(none.findAll('.mj-hub__slot')).toHaveLength(0);
    const empty = mountHub({ seats: [{ seat: 0, dir: 'self', badge: 'ting', badgeText: '' }] });
    expect(empty.findAll('.mj-hub__slot')).toHaveLength(0);
  });

  it('多块同时亮（exchange）：每块显示同一 seconds，徽标被覆盖', () => {
    const w = mountHub({
      phase: 'exchange',
      activeSeats: [0, 3],
      seats: [
        { seat: 0, dir: 'self', badge: 'hu', badgeText: '胡' },
        { seat: 1, dir: 'right' },
        { seat: 2, dir: 'top' },
        { seat: 3, dir: 'left', badge: 'ting', badgeText: '听' },
      ],
    });
    expect(slot(w, 'self').text()).toBe('12s');
    expect(slot(w, 'left').text()).toBe('12s');
    expect(slot(w, 'self').classes()).not.toContain('mj-hub__slot--badge');
  });

  it('无人行动（ended）：四块徽标各自显示，无倒计时', () => {
    const w = mountHub({
      phase: 'ended',
      seats: [
        { seat: 0, dir: 'self', badge: 'hu', badgeText: '胡' },
        { seat: 1, dir: 'right', badge: 'trustee', badgeText: '托' },
        { seat: 2, dir: 'top', badge: 'ting', badgeText: '听' },
        { seat: 3, dir: 'left', badge: 'lack', badgeText: '缺' },
      ],
    });
    expect(slot(w, 'self').text()).toBe('胡');
    expect(slot(w, 'right').text()).toBe('托');
    expect(slot(w, 'top').text()).toBe('听');
    expect(slot(w, 'left').text()).toBe('缺');
    expect(w.findAll('.mj-hub__slot')[0]!.text()).not.toMatch(/s$/);
  });

  it('0 秒显示 0s 且不 urgent', () => {
    const w = mountHub({ currentPlayer: 0, seconds: 0 });
    expect(slot(w, 'self').text()).toBe('0s');
    expect(slot(w, 'self').classes()).not.toContain('mj-hub__slot--urgent');
  });

  it('urgent：仅自家 play 末 5 秒，且只挂自家槽', () => {
    const selfTurn = (over: Partial<Props> = {}) =>
      mountHub({ currentPlayer: 0, seconds: 4, ...over });
    const urgent = selfTurn();
    expect(slot(urgent, 'self').classes()).toContain('mj-hub__slot--urgent');
    expect(slot(urgent, 'self').classes()).toContain('anim-mj-urgent');
    for (const phase of ['claim', 'exchange', 'lack'] as MahjongPhase[]) {
      const w = selfTurn({ phase });
      expect(slot(w, 'self').classes(), `${phase} 不得 urgent`).not.toContain(
        'mj-hub__slot--urgent',
      );
      expect(slot(w, 'self').classes()).not.toContain('anim-mj-urgent');
    }
    expect(selfTurn({ seconds: 6 }).find('.mj-hub__slot--urgent').exists()).toBe(false);
    expect(selfTurn({ seconds: 0 }).find('.mj-hub__slot--urgent').exists()).toBe(false);
    // 非我方出牌：他座亮也不得 urgent（v15 负例，重写时丢失）
    expect(selfTurn({ currentPlayer: 2 }).find('.mj-hub__slot--urgent').exists()).toBe(false);
  });

  it('提示截断 5 字 + …；endedText 优先', () => {
    const long = '一二三四五六七八九十';
    const w = mountHub({ statusText: long });
    expect(w.find('.mj-hub__hint').text()).toBe('一二三四五…');
    const ended = mountHub({ endedText: '已胡2家' });
    expect(ended.find('.mj-hub__hint').text()).toBe('已胡2家');
  });

  it('无 seats：四槽全空、方孔仍显示', () => {
    const w = mountHub({ seats: [] });
    expect(w.findAll('.mj-hub__slot')).toHaveLength(0);
    expect(w.find('.mj-hub__wall-count').text()).toBe('42');
  });

  it('源码闸：根 6px 金环 + 径向漆底 + 不剪裁', () => {
    const root = ruleBody(styleCode, '.mj-hub');
    expect(root).toContain('box-sizing: border-box');
    expect(root).toContain('border: 6px solid $ftl-color-mj-gold');
    expect(root).toContain('border-radius: 50%');
    expect(root).toContain(
      'radial-gradient(circle at 50% 42%, $ftl-color-mj-hub-core 0%, $ftl-color-mj-lacquer 70%)',
    );
    expect(root).toContain('0 0 0 $ftl-hairline $ftl-color-mj-border');
    expect(root).not.toContain('overflow: hidden');
  });

  it('源码闸：4 扇形 conic-gradient（单色标）+ 亮块 opacity 1 + 待机 .4 + 过渡', () => {
    const sector = ruleBody(styleCode, '.mj-hub__sector');
    expect(sector).toContain('position: absolute');
    expect(sector).toContain('inset: 0');
    expect(sector).toContain('border-radius: 50%');
    expect(sector).toContain('opacity: .4');
    expect(sector).toContain('transition: opacity .3s');
    expect(ruleBody(styleCode, '.mj-hub__sector--lit')).toContain('opacity: 1');
    for (const [sel, from] of [
      ['.mj-hub__sector--top', '-45deg'],
      ['.mj-hub__sector--right', '45deg'],
      ['.mj-hub__sector--self', '135deg'],
      ['.mj-hub__sector--left', '225deg'],
    ] as const) {
      const body = ruleBody(styleCode, sel);
      expect(body).toContain(`conic-gradient(from ${from}`);
      expect(body).toContain('90deg, transparent 90deg, transparent 360deg');
    }
  });

  it('源码闸：对角线发丝层 $ftl-hairline + ±45°', () => {
    const diag = ruleBody(styleCode, '.mj-hub__diag');
    expect(diag).toContain('height: $ftl-hairline');
    expect(diag).toContain('rgba($ftl-color-mj-gold, .16)');
    expect(ruleBody(styleCode, '.mj-hub__diag--a')).toContain('rotate(45deg)');
    expect(ruleBody(styleCode, '.mj-hub__diag--b')).toContain('rotate(-45deg)');
  });

  it('源码闸：方孔 66 border-box / $ftl-hairline / 漆底；牌墙 30；提示 10 + 5 字省略', () => {
    const hole = ruleBody(styleCode, '.mj-hub__hole');
    expect(hole).toContain('box-sizing: border-box');
    expect(hole).toContain('width: 66px');
    expect(hole).toContain('height: 66px');
    expect(hole).toContain('border: $ftl-hairline solid $ftl-color-mj-border');
    expect(hole).toContain('background: rgba($ftl-color-mj-lacquer, .84)');
    const wall = ruleBody(styleCode, '.mj-hub__wall-count');
    expect(wall).toContain('color: $ftl-color-mj-sheen');
    expect(wall).toContain('font-size: 30px');
    expect(wall).toContain('font-weight: 700');
    expect(wall).toContain('tabular-nums');
    const hint = ruleBody(styleCode, '.mj-hub__hint');
    expect(hint).toContain('font-size: 10px');
    expect(hint).toContain('max-width: 100%');
    expect(hint).toContain('text-overflow: ellipsis');
    expect(hint).toContain('white-space: nowrap');
    expect(hint).toContain('color: $ftl-color-mj-status');
  });

  it('源码闸：槽 18px + 四向位置 + 上/下无 transform + 左右 translate + 徽标 11px', () => {
    const slotRule = ruleBody(styleCode, '.mj-hub__slot');
    expect(slotRule).toContain('font-size: 18px');
    expect(slotRule).toContain('font-weight: 700');
    expect(slotRule).toContain('tabular-nums');
    expect(slotRule).not.toContain('transform');
    const top = ruleBody(styleCode, '.mj-hub__slot--top');
    expect(top).toContain('top: 12%');
    expect(top).toContain('text-align: center');
    expect(top).not.toContain('transform');
    const self = ruleBody(styleCode, '.mj-hub__slot--self');
    expect(self).toContain('bottom: 6%');
    expect(self).toContain('text-align: center');
    expect(self).not.toContain('transform');
    const left = ruleBody(styleCode, '.mj-hub__slot--left');
    expect(left).toContain('left: 11%');
    expect(left).toContain('translate(-50%, -50%)');
    const right = ruleBody(styleCode, '.mj-hub__slot--right');
    expect(right).toContain('right: 11%');
    expect(right).toContain('translate(50%, -50%)');
    expect(ruleBody(styleCode, '.mj-hub__slot--urgent')).toContain('$ftl-color-mj-urgent');
    const badge = ruleBody(styleCode, '.mj-hub__slot--badge');
    expect(badge).toContain('width: max-content');
    expect(badge).toContain('margin: 0 auto');
    expect(badge).toContain('font-size: 11px');
    expect(badge).toContain('padding: 0 5px');
    expect(badge).toContain('border: $ftl-hairline solid $ftl-color-mj-border');
    expect(badge).toContain('background: rgba($ftl-color-mj-lacquer, .85)');
  });

  it('源码闸：无裸 1px；旧选择器/旧 props 删除；保留 anim-mj-urgent 与动画 import', () => {
    expect(styleCode).not.toMatch(/(?:^|[^\d])1px\b/);
    expect(src).not.toContain('mj-hub__dot');
    expect(src).not.toContain('mj-hub__badge');
    expect(src).not.toContain('mj-hub__status');
    expect(src).not.toContain('mj-hub__wall-label');
    expect(src).not.toContain('mj-hub--compact');
    expect(src).not.toContain('compact');
    expect(src).not.toMatch(/hub\s*:\s*HubRect/);
    expect(src).not.toMatch(/props\.hub/);
    expect(src).toContain('anim-mj-urgent');
    expect(styleCode).toMatch(/@import\s+['"][^'"]*styles\/animations\.scss['"]/);
  });

  it('盘金光：flashKey>0 渲染覆盖层，key 变化重挂载，animationend 才 emit flash-done', async () => {
    const w = mountHub();
    expect(w.find('.mj-hub__flash').exists()).toBe(false);
    await w.setProps({ flashKey: 1 });
    const flash = w.find('.mj-hub__flash');
    expect(flash.exists()).toBe(true);
    expect(flash.classes()).toContain('anim-mj-hub-flash');
    const firstEl = flash.element;
    await w.setProps({ flashKey: 2 });
    expect(w.find('.mj-hub__flash').element).not.toBe(firstEl);
    await w.find('.mj-hub__flash').trigger('animationend', { animationName: 'other-anim' });
    expect(w.emitted('flash-done')).toBeUndefined();
    await w.find('.mj-hub__flash').trigger('animationend', {
      animationName: 'ftl-mj-hub-flash-7ba3f1',
    });
    expect(w.emitted('flash-done')).toHaveLength(1);
  });

  it('源码闸：金光覆盖层 inset 0 / 圆角 / pointer-events none / 径向金色', () => {
    const flash = ruleBody(styleCode, '.mj-hub__flash');
    expect(flash).toContain('position: absolute');
    expect(flash).toContain('inset: 0');
    expect(flash).toContain('border-radius: 50%');
    expect(flash).toContain('pointer-events: none');
    expect(flash).toContain('radial-gradient');
    expect(flash).toContain('rgba($ftl-color-mj-gold');
    expect(src).toContain('anim-mj-hub-flash');
    expect(src).toContain('@animationend="onFlashEnd"');
    expect(src).toContain("startsWith('ftl-mj-hub-flash')");
  });

  it('无分数、无中央 claim 牌、无图片、不定义 animation/infinite', () => {
    const w = mountHub();
    expect(w.find('.mj-hub__score').exists()).toBe(false);
    expect(w.find('.mj-hub__claim').exists()).toBe(false);
    expect(w.find('image').exists()).toBe(false);
    expect(w.text()).not.toMatch(/分数|底分|积分/);
    expect(styleCode).not.toMatch(/animation\s*:/);
    expect(src).not.toMatch(/infinite/);
  });
});

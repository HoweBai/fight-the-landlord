import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongClaimOption } from '@fight-the-landlord/protocol';
import MahjongActionBar from '../src/components/table/mahjong/MahjongActionBar.vue';
import { stripComments } from './helpers/source-scan';

/**
 * Task 7：ActionBar 统一 claim / 多杠 / 换三张 / 定缺。
 * 设计：docs/superpowers/specs/2026-11-05-mahjong-table-redgold-design-v4.md §4.6；
 *      v12 §2（showPass 只认 claimsForMe 的 pass；options 排除 pass）；
 *      v13 §10.2（rob 胡按钮显示待响应牌）。
 */

const peng: MahjongClaimOption = { claim: 'peng' };
const pass: MahjongClaimOption = { claim: 'pass' };
const hu5: MahjongClaimOption = { claim: 'hu', tile: { s: 0, r: 5 } };
const gang3: MahjongClaimOption = { claim: 'gang', tile: { s: 1, r: 3 } };

function mountBar(props: Record<string, unknown> = {}) {
  return mount(MahjongActionBar, { props: { mode: 'play', ...props } });
}

/** 主按钮（不含多杠选择器行）。 */
function mainButtonTexts(w: ReturnType<typeof mountBar>): string[] {
  return w.findAll('.mj-action-bar__btn').map((b) => b.text());
}

describe('MahjongActionBar', () => {
  it('claim [碰,过] + showPass：恰好一个过、一个碰；pass 不渲染为选项按钮', () => {
    const w = mountBar({ mode: 'claim', options: [peng, pass], showPass: true });
    const buttons = w.findAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons.filter((b) => b.text() === '过')).toHaveLength(1);
    expect(buttons.filter((b) => b.text() === '碰')).toHaveLength(1);
    // options 里的 pass 被过滤：碰/过之外没有第三个按钮
    expect(mainButtonTexts(w)).toEqual(['碰', '过']);
    // Task 10：claim 窗口的按钮挂唯一 infinite 类（定义在 animations.scss）。
    for (const b of buttons) expect(b.classes()).toContain('anim-claim-pulse');
    expect(
      mountBar({ mode: 'play', selectedCount: 1 }).findAll('.anim-claim-pulse'),
    ).toHaveLength(0);
  });

  it('强制胡（options 只有 hu、showPass=false）：没有过', () => {
    const w = mountBar({ mode: 'claim', options: [hu5], showPass: false });
    expect(w.findAll('button')).toHaveLength(1);
    expect(w.findAll('button').some((b) => b.text() === '过')).toBe(false);
  });

  it('claim 4 个动作：2×2 网格 + 每个按钮内联 84×84', () => {
    const w = mountBar({
      mode: 'claim',
      options: [peng, gang3, hu5, pass],
      showPass: true,
    });
    const grid = w.find('.mj-action-bar__grid');
    expect(grid.exists()).toBe(true);
    expect(grid.attributes('style')).toContain('repeat(2, 84px)');

    const buttons = w.findAll('.mj-action-bar__btn');
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      const style = b.attributes('style') ?? '';
      expect(style).toContain('width: 84px');
      expect(style).toContain('height: 84px');
    }
  });

  it('play：出牌是宽主按钮，点击 emit discard；胡按钮 emit 其 option', async () => {
    const w = mountBar({ mode: 'play', options: [hu5], selectedCount: 1 });
    const discard = w.findAll('.mj-action-bar__btn').find((b) => b.text() === '出牌');
    expect(discard).toBeDefined();
    const discardStyle = discard!.attributes('style') ?? '';
    expect(discardStyle).toContain('width: 176px');
    expect(discardStyle).toContain('grid-column: span 2');

    const hu = w.findAll('.mj-action-bar__btn').find((b) => b.text().includes('胡'));
    expect(hu).toBeDefined();
    expect(hu!.attributes('style')).toContain('width: 84px');

    await discard!.trigger('click');
    await hu!.trigger('click');
    expect(w.emitted('action')).toEqual([
      [{ kind: 'discard' }],
      [{ kind: 'claim', option: hu5 }],
    ]);
  });

  it('play：出牌只在恰好选中 1 张时可用（0/2 张禁用，胡/杠不受影响）', () => {
    const discardOf = (w: ReturnType<typeof mountBar>) =>
      w.findAll('.mj-action-bar__btn').find((b) => b.text() === '出牌')!.element as HTMLButtonElement;

    expect(discardOf(mountBar({ mode: 'play', selectedCount: 0 })).disabled).toBe(true);
    expect(discardOf(mountBar({ mode: 'play', selectedCount: 2 })).disabled).toBe(true);

    const one = mountBar({ mode: 'play', selectedCount: 1, options: [hu5] });
    expect(discardOf(one).disabled).toBe(false);
    const hu = one.findAll('.mj-action-bar__btn').find((b) => b.text() === '胡')!.element;
    expect((hu as HTMLButtonElement).disabled).toBe(false);
  });

  it('多杠：两个杠 → 恰好一个「杠 2」；点开出 5万/6万，点 5万 emit 第一个 option', async () => {
    const gang5: MahjongClaimOption = { claim: 'gang', tile: { s: 0, r: 5 } };
    const gang6: MahjongClaimOption = { claim: 'gang', tile: { s: 0, r: 6 } };
    const w = mountBar({ mode: 'play', options: [gang5, gang6] });

    const gangButtons = w.findAll('.mj-action-bar__btn').filter((b) => b.text().startsWith('杠'));
    expect(gangButtons).toHaveLength(1);
    expect(gangButtons[0]!.text()).toBe('杠 2');
    expect(w.find('.mj-action-bar__gang-selector').exists()).toBe(false);

    await gangButtons[0]!.trigger('click');
    const selector = w.find('.mj-action-bar__gang-selector');
    expect(selector.exists()).toBe(true);
    expect(selector.text()).toContain('5万');
    expect(selector.text()).toContain('6万');

    const rows = w.findAll('.mj-action-bar__gang-item');
    expect(rows).toHaveLength(2);
    await rows[0]!.trigger('click');
    expect(w.emitted('action')![0]![0]).toEqual({ kind: 'claim', option: gang5 });
  });

  it('claim rob 胡：胡按钮显示待响应牌「胡 5万」', () => {
    const w = mountBar({ mode: 'claim', options: [hu5], showPass: false });
    expect(w.find('.mj-action-bar__btn').text()).toContain('胡 5万');
  });

  it('exchange：宽按钮换三张 + 已选 1/3；点击 emit exchange', async () => {
    const w = mountBar({ mode: 'exchange', selectedCount: 1 });
    const btn = w.findAll('.mj-action-bar__btn').find((b) => b.text() === '换三张');
    expect(btn).toBeDefined();
    const style = btn!.attributes('style') ?? '';
    expect(style).toContain('width: 176px');
    expect(style).toContain('grid-column: span 2');
    expect(w.text()).toContain('已选 1/3');

    await btn!.trigger('click');
    expect(w.emitted('action')![0]![0]).toEqual({ kind: 'exchange' });
  });

  it('lack：万/筒/条三键；recommendedSuit=1 给筒挂 --recommended + 推荐；点万 emit suit 0', async () => {
    const w = mountBar({ mode: 'lack', recommendedSuit: 1 });
    const buttons = w.findAll('.mj-action-bar__btn');
    expect(buttons).toHaveLength(3);

    expect(buttons[0]!.text().startsWith('万')).toBe(true);
    expect(buttons[1]!.text().startsWith('筒')).toBe(true);
    expect(buttons[2]!.text().startsWith('条')).toBe(true);

    expect(buttons[1]!.classes()).toContain('mj-action-bar__btn--recommended');
    expect(buttons[1]!.text()).toContain('推荐');
    expect(buttons[0]!.classes()).not.toContain('mj-action-bar__btn--recommended');
    expect(buttons[2]!.classes()).not.toContain('mj-action-bar__btn--recommended');

    await buttons[0]!.trigger('click');
    expect(w.emitted('action')![0]![0]).toEqual({ kind: 'lack', suit: 0 });
  });

  it('busy 时所有按钮 disabled（claim / lack）', () => {
    const claim = mountBar({
      mode: 'claim',
      options: [peng, gang3, hu5, pass],
      showPass: true,
      busy: true,
    });
    const claimButtons = claim.findAll('button');
    expect(claimButtons).toHaveLength(4);
    for (const b of claimButtons) {
      expect((b.element as HTMLButtonElement).disabled).toBe(true);
    }

    const lack = mountBar({ mode: 'lack', busy: true });
    for (const b of lack.findAll('button')) {
      expect((b.element as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('源码闸：SFC 无 1px、无 infinite（注释已剥：Task 10 起 claim 呼吸类在 code 里）', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongActionBar.vue', 'utf8');
    expect(src).not.toMatch(/1px/);
    // Task 10：claim 按钮引用 `anim-claim-pulse`（定义在 animations.scss），
    // 组件自身仍不得写 `infinite` 声明；只看**代码**，注释里的解释不算违规。
    expect(stripComments(src)).not.toContain('infinite');
  });
});

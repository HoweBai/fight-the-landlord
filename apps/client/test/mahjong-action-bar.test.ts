import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { MahjongClaimOption } from '@fight-the-landlord/protocol';
import MahjongActionBar from '../src/components/table/mahjong/MahjongActionBar.vue';
import { stripComments } from './helpers/source-scan';

const tile = (s: 0 | 1 | 2, r: number) => ({ s, r });
const peng = { claim: 'peng', tile: tile(0, 5) } as MahjongClaimOption;
const gang3 = { claim: 'gang', tile: tile(0, 3) } as MahjongClaimOption;
const gang7 = { claim: 'gang', tile: tile(0, 7) } as MahjongClaimOption;
const hu5 = { claim: 'hu', tile: tile(0, 5) } as MahjongClaimOption;
const pass = { claim: 'pass' } as MahjongClaimOption;

const baseProps = {
  mode: 'claim' as 'play' | 'claim' | 'exchange' | 'lack',
  options: [] as MahjongClaimOption[],
  showPass: false,
  busy: false,
  selectedCount: 0,
  recommendedSuit: null as 0 | 1 | 2 | null,
};

function mountBar(over: Partial<typeof baseProps> = {}) {
  return mount(MahjongActionBar, { props: { ...baseProps, ...over } });
}

function btnStyle(b: { attributes(name: string): string | undefined }): string {
  return b.attributes('style') ?? '';
}

const barSrc = readFileSync('src/components/table/mahjong/MahjongActionBar.vue', 'utf8');
const barStyle = [...barSrc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
  .map((m) => m[1] ?? '')
  .join('\n');

/** 取一条选择器规则的声明体（本文件的这些规则没有嵌套块）。 */
function barRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(barStyle);
  expect(m, `${selector} 规则必须存在`).not.toBeNull();
  return m![1]!;
}

describe('MahjongActionBar（v17 单行）', () => {
  it('claim 4 键：一行 50×64，gap 6，根宽 218；无 grid', () => {
    const w = mountBar({ mode: 'claim', options: [peng, gang3, hu5, pass], showPass: true });
    const buttons = w.findAll('.mj-action-bar__btn');
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      const s = btnStyle(b);
      expect(s).toContain('width: calc(50px * var(--mj-u, 1))');
      expect(s).toContain('height: calc(64px * var(--mj-u, 1))');
      expect(s).not.toContain('grid-column');
      expect(s).not.toContain('grid-row');
    }
    const root = w.find('.mj-action-bar');
    expect(root.attributes('style')).toContain('width: calc(218px * var(--mj-u, 1))');
    expect(barStyle).toContain('gap: calc(6px * var(--mj-u, 1))');
    expect(stripComments(barSrc)).not.toMatch(/grid-template|gridTemplate/);
    expect(barStyle).not.toMatch(/display:\s*grid/);
  });

  it('play：1/2/3 键宽度 176/102/66，根宽 176/210/210，出牌最右', () => {
    const one = mountBar({ mode: 'play', selectedCount: 1 });
    expect(one.findAll('.mj-action-bar__btn')).toHaveLength(1);
    expect(btnStyle(one.find('.mj-action-bar__btn'))).toContain('width: calc(176px * var(--mj-u, 1))');
    expect(one.find('.mj-action-bar__btn').text()).toBe('出牌');
    expect(one.find('.mj-action-bar').attributes('style')).toContain('width: calc(176px * var(--mj-u, 1))');

    const two = mountBar({ mode: 'play', options: [hu5], selectedCount: 1 });
    const twoBtns = two.findAll('.mj-action-bar__btn');
    expect(twoBtns).toHaveLength(2);
    for (const b of twoBtns) expect(btnStyle(b)).toContain('width: calc(102px * var(--mj-u, 1))');
    expect(twoBtns.map((b) => b.text())).toEqual(['胡', '出牌']);
    expect(two.find('.mj-action-bar').attributes('style')).toContain('width: calc(210px * var(--mj-u, 1))');

    const three = mountBar({ mode: 'play', options: [hu5, gang3], selectedCount: 1 });
    const threeBtns = three.findAll('.mj-action-bar__btn');
    expect(threeBtns).toHaveLength(3);
    for (const b of threeBtns) expect(btnStyle(b)).toContain('width: calc(66px * var(--mj-u, 1))');
    expect(threeBtns.map((b) => b.text())).toEqual(['胡', '杠', '出牌']);
    expect(three.find('.mj-action-bar').attributes('style')).toContain('width: calc(210px * var(--mj-u, 1))');
  });

  it('claim：1/2/3/4 键宽度 102/102/66/50；过固定在最后', () => {
    const cases: Array<[number, number, MahjongClaimOption[], boolean]> = [
      [1, 102, [hu5], false],
      [1, 102, [], true],
      [2, 102, [hu5], true],
      [3, 66, [peng, hu5], true],
      [4, 50, [peng, gang3, hu5], true],
    ];
    for (const [count, width, options, showPass] of cases) {
      const w = mountBar({ mode: 'claim', options, showPass });
      const buttons = w.findAll('.mj-action-bar__btn');
      expect(buttons, `count ${count}`).toHaveLength(count);
      for (const b of buttons) {
        expect(btnStyle(b), `count ${count}`).toContain(`width: calc(${width}px * var(--mj-u, 1))`);
      }
      if (showPass) expect(buttons.at(-1)!.text()).toBe('过');
      const rootW = count === 1 ? 102 : count === 2 || count === 3 ? 210 : 218;
      expect(w.find('.mj-action-bar').attributes('style'), `count ${count} root`)
        .toContain(`width: calc(${rootW}px * var(--mj-u, 1))`);
    }
  });

  it('claim 胡带 20×30 牌面 + 文本「胡」（不是「胡 5万」）；play 胡不带牌面', () => {
    const claim = mountBar({ mode: 'claim', options: [hu5], showPass: false });
    const huBtn = claim.find('.mj-action-bar__btn');
    expect(huBtn.text()).toBe('胡');
    expect(huBtn.text()).not.toContain('5万');
    const img = huBtn.find('image');
    expect(img.exists()).toBe(true);
    expect(img.attributes('style')).toContain('width: 20px');
    expect(img.attributes('style')).toContain('height: 30px');
    expect(img.attributes('aria-label')).toBe('万5');

    const noTile = mountBar({ mode: 'claim', options: [{ claim: 'hu' } as MahjongClaimOption] });
    expect(noTile.find('.mj-action-bar__btn').text()).toBe('胡');
    expect(noTile.find('.mj-action-bar__btn').find('image').exists()).toBe(false);

    const play = mountBar({ mode: 'play', options: [hu5], selectedCount: 1 });
    expect(play.findAll('.mj-action-bar__btn').find((b) => b.text() === '胡')!.find('image').exists()).toBe(false);
  });

  it('多杠：单杠纯「杠」；多杠「杠」+ 数字；面板在条上方、2 列、不占行', async () => {
    const sole = mountBar({ mode: 'play', options: [gang3], selectedCount: 1 });
    expect(sole.findAll('.mj-action-bar__btn').find((b) => b.text() === '杠')).toBeDefined();

    const multi = mountBar({ mode: 'play', options: [gang3, gang7], selectedCount: 1 });
    const gangBtn = multi.findAll('.mj-action-bar__btn').find((b) => b.text().includes('杠'))!;
    expect(gangBtn.text()).toContain('杠');
    expect(gangBtn.text()).toContain('2');
    expect(gangBtn.find('.mj-action-bar__sub').exists()).toBe(true);

    await gangBtn.trigger('click');
    const panel = multi.find('.mj-action-bar__gang-selector');
    expect(panel.exists()).toBe(true);
    const ps = panel.attributes('style') ?? '';
    expect(ps).toContain('position: absolute');
    expect(ps).toContain('bottom: calc(100% + 8px * var(--mj-u, 1))');
    expect(ps).toContain('width: calc(218px * var(--mj-u, 1))');
    expect(ps).toContain('flex-wrap: wrap');
    // 面板是根的直接子元素（不占行）
    expect(panel.element.parentElement?.classList.contains('mj-action-bar')).toBe(true);
    const items = panel.findAll('.mj-action-bar__gang-item');
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.attributes('style')).toContain('flex: 0 0 calc(50% - 3px * var(--mj-u, 1))');
    }
    expect(items.map((i) => i.text())).toEqual(['3万', '7万']);
    await items[0]!.trigger('click');
    expect(multi.emitted('action')).toEqual([[{ kind: 'claim', option: gang3 }]]);
    expect(multi.find('.mj-action-bar__gang-selector').exists()).toBe(false);
  });

  it('出牌禁用：未选/多选禁用；胡/杠不受 selectedCount 影响', () => {
    const zero = mountBar({ mode: 'play', options: [hu5, gang3], selectedCount: 0 });
    const byText = (text: string) =>
      zero.findAll('.mj-action-bar__btn').find((b) => b.text() === text)!;
    expect(byText('出牌').attributes('disabled')).toBeDefined();
    expect(byText('胡').attributes('disabled')).toBeUndefined();
    expect(byText('杠').attributes('disabled')).toBeUndefined();

    const two = mountBar({ mode: 'play', options: [hu5], selectedCount: 2 });
    expect(
      two.findAll('.mj-action-bar__btn').find((b) => b.text() === '出牌')!.attributes('disabled'),
    ).toBeDefined();
    const one = mountBar({ mode: 'play', options: [hu5], selectedCount: 1 });
    expect(
      one.findAll('.mj-action-bar__btn').find((b) => b.text() === '出牌')!.attributes('disabled'),
    ).toBeUndefined();
  });

  it('claim 过不是主按钮；胡是主按钮', () => {
    const w = mountBar({ mode: 'claim', options: [peng, hu5], showPass: true });
    const passBtn = w.findAll('.mj-action-bar__btn').find((b) => b.text() === '过')!;
    expect(passBtn.classes()).toContain('mj-action-bar__btn--pass');
    expect(passBtn.classes()).not.toContain('mj-action-bar__btn--primary');
    expect(
      w.findAll('.mj-action-bar__btn').find((b) => b.text() === '胡')!.classes(),
    ).toContain('mj-action-bar__btn--primary');
  });

  it('exchange：单按钮「换三张」+ 副字「已选 x/3」，宽 140', () => {
    const w = mountBar({ mode: 'exchange', selectedCount: 2 });
    const btn = w.find('.mj-action-bar__btn');
    expect(btn.text()).toContain('换三张');
    expect(btn.text()).toContain('已选 2/3');
    expect(btn.find('.mj-action-bar__sub').exists()).toBe(true);
    expect(btnStyle(btn)).toContain('width: calc(140px * var(--mj-u, 1))');
    expect(w.find('.mj-action-bar').attributes('style')).toContain('width: calc(140px * var(--mj-u, 1))');
  });

  it('lack：3×66 + 推荐副字 + 根宽 210；点击 emit；busy 禁用', async () => {
    const w = mountBar({ mode: 'lack', recommendedSuit: 1 });
    const buttons = w.findAll('.mj-action-bar__btn');
    expect(buttons).toHaveLength(3);
    for (const b of buttons) expect(btnStyle(b)).toContain('width: calc(66px * var(--mj-u, 1))');
    expect(w.find('.mj-action-bar').attributes('style')).toContain('width: calc(210px * var(--mj-u, 1))');
    expect(buttons[1]!.find('.mj-action-bar__rec').text()).toBe('推荐');
    await buttons[0]!.trigger('click');
    expect(w.emitted('action')?.[0]?.[0]).toEqual({ kind: 'lack', suit: 0 });

    const busy = mountBar({ mode: 'lack', busy: true });
    for (const b of busy.findAll('.mj-action-bar__btn')) expect(b.attributes('disabled')).toBeDefined();
  });

  it('claim 呼吸只在 claim；禁用态/emit 不变', async () => {
    const claim = mountBar({ mode: 'claim', options: [peng], showPass: true });
    expect(claim.findAll('.anim-claim-pulse')).toHaveLength(2);
    const play = mountBar({ mode: 'play', selectedCount: 1 });
    expect(play.findAll('.anim-claim-pulse')).toHaveLength(0);

    const busy = mountBar({ mode: 'claim', options: [peng], showPass: true, busy: true });
    for (const b of busy.findAll('.mj-action-bar__btn')) expect(b.attributes('disabled')).toBeDefined();

    const w = mountBar({ mode: 'claim', options: [peng], showPass: true });
    await w.findAll('.mj-action-bar__btn')[0]!.trigger('click');
    await w.findAll('.mj-action-bar__btn')[1]!.trigger('click');
    expect(w.emitted('action')).toEqual([[{ kind: 'claim', option: peng }], [{ kind: 'pass' }]]);
  });

  it('源码闸：按钮 line-height 1；无裸 1px / em / rem / vw / vh / pt；动画 import 保留', () => {
    expect(barRule('.mj-action-bar__btn')).toMatch(/line-height:\s*1\s*;/);
    expect(stripComments(barSrc)).not.toMatch(/(?:^|[^\d])1px\b/);
    expect(barStyle).not.toMatch(/\b(?:em|rem|vw|vh|pt)\b/);
    expect(barStyle).toMatch(/@import\s+['"][^'"]*styles\/animations\.scss['"]/);
    expect(barSrc).toContain('anim-action-slide-in');
    expect(barSrc).toContain('anim-claim-pulse');
  });
});

// 红金皮肤（2026-11-08 Task 3）：v17 只改布局，皮肤与动画断言原样保留。
describe('MahjongActionBar：红金皮肤（Task 3）', () => {
  it('按钮：漆底 / 金棕发丝边 / 12px 圆角 / 24px cream / 3D 阴影', () => {
    const body = barRule('.mj-action-bar__btn');
    expect(body).toContain('background: rgba($ftl-color-mj-lacquer, .92)');
    expect(body).toContain('border: $ftl-hairline solid $ftl-color-mj-border');
    expect(body).toContain('border-radius: 12px');
    expect(body).toContain('color: $ftl-color-mj-cream');
    expect(body).toContain('font-size: 24px');
    expect(body).toContain('font-weight: 700');
    expect(body).toContain('box-shadow: 0 4px 0 $ftl-color-mj-border');
    expect(body).not.toMatch(/rgba\(40, 76, 51|rgba\(23, 50, 33/);
  });

  it('主按钮：status→gold 渐变 + ink 字 + edge 描边', () => {
    const body = barRule('.mj-action-bar__btn--primary');
    expect(body).toContain('background: linear-gradient($ftl-color-mj-status, $ftl-color-mj-gold)');
    expect(body).toContain('color: $ftl-color-mj-ink');
    expect(body).toContain('border-color: $ftl-color-mj-edge');
  });

  it('过 / 幽灵：muted 字 + 半透明漆底', () => {
    const body = barRule('.mj-action-bar__btn--pass');
    expect(body).toContain('$ftl-color-mj-muted');
    expect(body).toContain('rgba($ftl-color-mj-lacquer');
  });

  it('多杠选择器项：漆底金边（绿色渐变已删）', () => {
    const body = barRule('.mj-action-bar__gang-item');
    expect(body).toContain('rgba($ftl-color-mj-lacquer');
    expect(body).toContain('$ftl-color-mj-gold');
    expect(body).not.toMatch(/rgba\(60, 110, 75|rgba\(35, 75, 50/);
  });

  it('推荐缺：金色描边（recommended 保留）', () => {
    const body = barRule('.mj-action-bar__btn--recommended');
    expect(body).toContain('$ftl-color-mj-gold');
  });

  it('推荐缺：金环与 3D 底边合并（不丢 `0 4px 0` 的立体感）', () => {
    const body = barRule('.mj-action-bar__btn--recommended');
    expect(body).toContain('rgba($ftl-color-mj-gold, .5)');
    expect(body).toContain('0 4px 0 $ftl-color-mj-border');
  });

  it('根挂 anim-action-slide-in（入场滑入）', () => {
    const w = mountBar();
    expect(w.find('.mj-action-bar').classes()).toContain('anim-action-slide-in');
  });
});

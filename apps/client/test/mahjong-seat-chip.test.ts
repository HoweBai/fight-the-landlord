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

/** `<style>` 块拼接（红金皮肤源码闸用）。 */
function chipStyle(): string {
  const src = readFileSync('src/components/table/mahjong/MahjongSeatChip.vue', 'utf8');
  return [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join('\n');
}

/** 取一条选择器规则的声明体（这些规则没有嵌套块）。 */
function ruleBody(style: string, selector: string): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escape(selector)}\\s*\\{([^}]*)\\}`).exec(style);
  expect(m, `${selector} 规则必须存在`).not.toBeNull();
  return m![1]!;
}

describe('MahjongSeatChip', () => {
  it('四变体各自渲染 mj-chip--<variant> class', () => {
    for (const v of ['corner-tl', 'corner-tr', 'corner-top', 'self'] as const) {
      const w = mountChip({ variant: v });
      expect(w.find('.mj-chip').classes()).toContain(`mj-chip--${v}`);
    }
  });

  it('角标：庄 + 缺万 → 左上 1 + 左下 1，共 2 个（v13 mockup：左上一字 / 左下缺）', () => {
    const w = mountChip({ isDealer: true, lackSuit: 0 });
    const tl = w.findAll('.mj-chip__corner--tl');
    expect(tl).toHaveLength(1);
    expect(tl[0].text()).toBe('庄');
    expect(tl[0].classes()).toContain('mj-chip__corner--dealer');
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
    const tl = w.findAll('.mj-chip__corner--tl');
    expect(tl).toHaveLength(1);
    expect(tl[0].text()).toBe('胡');
    expect(tl[0].classes()).toContain('mj-chip__corner--hu');
    const bl = w.findAll('.mj-chip__corner--bl');
    expect(bl).toHaveLength(1);
    expect(bl[0].text()).toBe('缺筒');
    expect(w.findAll('.mj-chip__corner')).toHaveLength(2);
  });

  it('听 / 托 / 庄 单独出现', () => {
    const ting = mountChip({ ting: true });
    expect(ting.find('.mj-chip__corner--tl').text()).toBe('听');
    expect(ting.find('.mj-chip__corner--ting').exists()).toBe(true);

    const trustee = mountChip({ trustee: true });
    expect(trustee.find('.mj-chip__corner--tl').text()).toBe('托');
    expect(trustee.find('.mj-chip__corner--trustee').exists()).toBe(true);

    const dealer = mountChip({ isDealer: true });
    expect(dealer.find('.mj-chip__corner--tl').text()).toBe('庄');
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

  it('分数省略：`.mj-chip__score` 规则含 text-overflow: ellipsis（v6 §3.4 分数省略）', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongSeatChip.vue', 'utf8');
    const style = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1]!)
      .join('\n');
    const rule = /\.mj-chip__score\s*\{([^}]*)\}/.exec(style);
    expect(rule, '.mj-chip__score 规则必须存在').not.toBeNull();
    const body = rule![1]!;
    expect(body).toContain('text-overflow: ellipsis');
    expect(body).toContain('overflow: hidden');
    expect(body).toContain('white-space: nowrap');
    expect(body).toContain('min-width: 0');
  });

  it('源码闸：`<style>` 内无裸 1px（发丝线一律走 $ftl-hairline）', () => {
    const src = readFileSync('src/components/table/mahjong/MahjongSeatChip.vue', 'utf8');
    const style = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1]!)
      .join('\n');
    // 与 test/ui-tokens.test.ts 的 hairlineOffenders 同型：避开 241px 这类子串误报。
    const offenders = style
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /(?:^|[^\d])1px\b/.test(l));
    expect(offenders, '发丝线必须走 $ftl-hairline（2px），不得手写 1px').toEqual([]);
  });

  it('内联字号：对手 名字18/分数18/delta12；自己 分数16/delta12', () => {
    const opponent = mountChip({ pendingDelta: 12 });
    expect(opponent.find('.mj-chip__name').attributes('style')).toContain('font-size: 18px');
    expect(opponent.find('.mj-chip__score').attributes('style')).toContain('font-size: 18px');
    expect(opponent.find('.mj-chip__delta').attributes('style')).toContain('font-size: 12px');

    const me = mountChip({ variant: 'self', isMe: true, pendingDelta: -5 });
    expect(me.find('.mj-chip__score').attributes('style')).toContain('font-size: 16px');
    expect(me.find('.mj-chip__delta').attributes('style')).toContain('font-size: 12px');
  });

  it('self 变体：分数与 delta 同一行（.mj-chip__self-sub），不竖排堆叠（64×76 不裁 delta）', () => {
    const w = mountChip({
      variant: 'self',
      isMe: true,
      avatar: 44,
      balance: 15500,
      pendingDelta: 12,
    });
    const sub = w.find('.mj-chip__self-sub');
    expect(sub.exists(), '自己分数行 .mj-chip__self-sub 必须存在').toBe(true);
    expect(sub.find('.mj-chip__score').text()).toBe('15,500');
    expect(sub.find('.mj-chip__delta').text()).toBe('+12');
    // DOM 父元素检查：score 与 delta 的父元素相同（同一行），不是各自整行。
    expect(sub.find('.mj-chip__score').element.parentElement).toBe(sub.element);
    expect(sub.find('.mj-chip__delta').element.parentElement).toBe(sub.element);

    // 源码闸：self 行是横向 row（与 .mj-chip__sub 同型）；旧竖排 .mj-chip__self-info 已删除。
    const rule = ruleBody(chipStyle(), '.mj-chip__self-sub');
    expect(rule).toContain('flex-direction: row');
    expect(rule).not.toContain('flex-direction: column');
    expect(chipStyle()).not.toContain('mj-chip__self-info');
  });

  it('self 变体列向居中（mockup：align-items center + 2px padding）', () => {
    const rule = ruleBody(chipStyle(), '.mj-chip--self');
    expect(rule).toContain('flex-direction: column');
    expect(rule).toContain('align-items: center');
    expect(rule).toContain('padding: 2px');
  });

  it('分数千分位（显式 en-US）：4200→4,200 / 15500→15,500 / 1234567→1,234,567 / null→—', () => {
    expect(mountChip({ balance: 4200 }).find('.mj-chip__score').text()).toBe('4,200');
    expect(mountChip({ balance: 15500 }).find('.mj-chip__score').text()).toBe('15,500');
    expect(mountChip({ balance: 1234567 }).find('.mj-chip__score').text()).toBe('1,234,567');
    expect(mountChip({ balance: null }).find('.mj-chip__score').text()).toBe('—');
  });

  it('两行布局：名字行 + 分数/delta 行（.mj-chip__sub）', () => {
    const w = mountChip({ pendingDelta: 12 });
    const info = w.find('.mj-chip__info');
    expect(info.find('.mj-chip__name').exists()).toBe(true);
    const sub = info.find('.mj-chip__sub');
    expect(sub.exists(), '分数与 delta 必须同在第二行 .mj-chip__sub').toBe(true);
    expect(sub.find('.mj-chip__score').exists()).toBe(true);
    expect(sub.find('.mj-chip__delta').exists()).toBe(true);
    // 名字不得与分数同行（两行布局）
    expect(w.find('.mj-chip__name + .mj-chip__score').exists()).toBe(false);
  });

  it('legacy side / bar 仍可挂载并显示名字与（千分位）分数（Task 8 移除）', () => {
    for (const v of ['side', 'bar'] as const) {
      const w = mountChip({ variant: v });
      expect(w.find('.mj-chip').classes()).toContain(`mj-chip--${v}`);
      expect(w.text()).toContain('北家乙');
      expect(w.text()).toContain('15,500');
    }
  });

  it('头像框尺寸跟随 avatar prop', () => {
    const w = mountChip({ avatar: 44 });
    expect(w.find('.mj-chip__avatar-box').attributes('style')).toContain('width: 44px');
    expect(w.find('.mj-chip__avatar-box').attributes('style')).toContain('height: 44px');
  });

  // -------------------------------------------------------------------------
  // 红金皮肤（2026-11-08 Task 1）—— 牌面 / 角标 / 头像
  // -------------------------------------------------------------------------

  it('牌面皮肤：漆底 88% / 金棕发丝边 / 12px 圆角 / cream 字 / padding 0 4px / overflow hidden', () => {
    const rule = ruleBody(chipStyle(), '.mj-chip');
    expect(rule).toContain('background: rgba($ftl-color-mj-lacquer, 0.88)');
    expect(rule).toContain('border: $ftl-hairline solid $ftl-color-mj-border');
    expect(rule).toContain('border-radius: 12px');
    expect(rule).toContain('color: $ftl-color-mj-cream');
    expect(rule).toContain('padding: 0 4px');
    expect(rule).toContain('overflow: hidden');
  });

  it('信息列两行：flex-direction column + flex-start + gap 2px', () => {
    const rule = ruleBody(chipStyle(), '.mj-chip__info');
    expect(rule).toContain('flex-direction: column');
    expect(rule).toContain('align-items: flex-start');
    expect(rule).toContain('gap: 2px');
  });

  it('名字 / 分数 / delta 一律 normal weight（源码无 600/700/bold）', () => {
    expect(chipStyle()).not.toMatch(/font-weight:\s*(600|700|bold)/);
  });

  it('分数样式：sheen 色 + tabular-nums（省略号闸见上）', () => {
    const rule = ruleBody(chipStyle(), '.mj-chip__score');
    expect(rule).toContain('color: $ftl-color-mj-sheen');
    expect(rule).toContain('font-variant-numeric: tabular-nums');
  });

  it('delta 颜色：正 = $ftl-color-mj-positive，负 = $ftl-color-mj-urgent', () => {
    expect(ruleBody(chipStyle(), '.mj-chip__delta--pos')).toContain('$ftl-color-mj-positive');
    expect(ruleBody(chipStyle(), '.mj-chip__delta--neg')).toContain('$ftl-color-mj-urgent');
  });

  it('角标：10px / hairline 金棕边 / 6px 圆角 / padding 0 2px / 漆底 cream', () => {
    const rule = ruleBody(chipStyle(), '.mj-chip__corner');
    expect(rule).toContain('font-size: 10px');
    expect(rule).toContain('border: $ftl-hairline solid $ftl-color-mj-border');
    expect(rule).toContain('border-radius: 6px');
    expect(rule).toContain('padding: 0 2px');
    expect(rule).toContain('background: $ftl-color-mj-lacquer');
    expect(rule).toContain('color: $ftl-color-mj-cream');
  });

  it('角标挂在牌面根上（不在头像框内）：左上 left:30px / 左下 bottom:0 left:0', () => {
    const tlRule = ruleBody(chipStyle(), '.mj-chip__corner--tl');
    expect(tlRule).toContain('top: 0');
    expect(tlRule).toContain('left: 30px');
    const blRule = ruleBody(chipStyle(), '.mj-chip__corner--bl');
    expect(blRule).toContain('bottom: 0');
    expect(blRule).toContain('left: 0');

    const w = mountChip({ isDealer: true, lackSuit: 0 });
    expect(w.find('.mj-chip__avatar-box .mj-chip__corner').exists()).toBe(false);
    expect(w.find('.mj-chip__corner--tl').element.parentElement?.className).toContain('mj-chip');
    expect(w.find('.mj-chip__corner--bl').element.parentElement?.className).toContain('mj-chip');
  });

  it('无旧语义色：无 $ftl-color-accent / 绿 / 蓝 / 橙角标', () => {
    const style = chipStyle();
    expect(style).not.toContain('$ftl-color-accent');
    expect(style).not.toContain('rgba(74, 222, 128');
    expect(style).not.toContain('rgba(120, 170, 255');
    expect(style).not.toContain('$ftl-color-night-deep');
    expect(style).not.toContain('$ftl-color-gold-light');
  });

  it('头像：10px 圆角 + 内金环（inset hairline）+ hub-core 半透明底', () => {
    const rule = ruleBody(chipStyle(), '.mj-chip__avatar-box');
    expect(rule).toContain('border-radius: 10px');
    expect(rule).toContain('background: rgba($ftl-color-mj-hub-core, 0.6)');
    expect(chipStyle()).toContain(
      'box-shadow: inset 0 0 0 $ftl-hairline rgba($ftl-color-mj-gold, 0.5)',
    );
  });

  it('激活态：strong / winner = 金边 + 12px 辉光；line 只变金边', () => {
    const strong = ruleBody(chipStyle(), '.mj-chip--active-strong');
    expect(strong).toContain('border-color: $ftl-color-mj-gold');
    expect(strong).toContain('box-shadow: 0 0 12px rgba($ftl-color-mj-gold, 0.55)');
    const line = ruleBody(chipStyle(), '.mj-chip--active-line');
    expect(line).toContain('border-color: $ftl-color-mj-gold');
    expect(line).not.toContain('box-shadow');
    const winner = ruleBody(chipStyle(), '.mj-chip--winner');
    expect(winner).toContain('border-color: $ftl-color-mj-gold');
  });
});

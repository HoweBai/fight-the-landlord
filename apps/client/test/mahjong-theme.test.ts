import { describe, expect, it } from 'vitest';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

const files = collectSourceFiles();
const vue = (p: string) => files.find((f) => f.path === `src/${p}`)!;

function style(content: string): string {
  return [...content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) =>
      m[1]!
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '),
    )
    .join('\n');
}

const BOARD = 'components/table/mahjong/MahjongBoard.vue';

describe('麻将主题源码闸', () => {
  it('Board 用新 token，且旧绿色 token/字面量消失', () => {
    const s = style(vue(BOARD).content);
    for (const t of [
      '$ftl-color-mj-table-light',
      '$ftl-color-mj-table-mid',
      '$ftl-color-mj-table-deep',
      '$ftl-color-mj-navy',
    ]) {
      expect(s).toContain(t);
    }
    expect(s).not.toMatch(/\$ftl-color-mahjong-table/);
    expect(s).not.toMatch(/rgba\(\s*20\s*,\s*50\s*,\s*30/);
    expect(s).not.toMatch(/rgba\(\s*0\s*,\s*25\s*,\s*12/);
  });

  it('各麻将组件样式含 mj token，旧绿/橙字面量消失', () => {
    const comps = [
      'MahjongTile.vue',
      'MahjongHandBacks.vue',
      'MahjongRiver.vue',
      'MahjongMeld.vue',
      'MahjongSeatChip.vue',
      'ClaimTile.vue',
      'MahjongHuBanner.vue',
      'MahjongCenter.vue',
    ];
    for (const c of comps) {
      expect(style(vue(`components/table/mahjong/${c}`).content)).toContain(
        '$ftl-color-mj-',
      );
    }
    for (const c of ['ClaimTile.vue', 'MahjongHuBanner.vue', 'MahjongRiver.vue']) {
      const s = style(vue(`components/table/mahjong/${c}`).content);
      expect(s).not.toMatch(/rgba\(\s*30\s*,\s*60\s*,\s*40/);
      expect(s).not.toMatch(/rgba\(\s*60\s*,\s*110\s*,\s*75/);
      expect(s).not.toMatch(/rgba\(\s*255\s*,\s*180\s*,\s*60/);
      expect(s).not.toMatch(/rgba\(\s*220\s*,\s*100\s*,\s*30/);
    }
  });

  it('死 prop 不残留', () => {
    for (const c of ['MahjongTile.vue', 'MahjongMeld.vue']) {
      const s = style(vue(`components/table/mahjong/${c}`).content);
      expect(s).not.toContain('mj-tile--rotate');
      expect(s).not.toContain('mj-meld--vertical');
      // 整份 SFC（去注释）也不得重新引入死 prop
      const whole = stripComments(vue(`components/table/mahjong/${c}`).content);
      expect(whole).not.toMatch(/rotate\?:/);
      expect(whole).not.toMatch(/vertical\?:/);
      expect(whole).not.toMatch(/props\.(rotate|vertical)/);
      expect(whole).not.toMatch(/\b(rotate|vertical)=/);
    }
  });

  it('主按钮 hover 保持海军蓝字（不被 .btn:hover 白字覆盖）', () => {
    const board = style(vue(BOARD).content);
    expect(board).toMatch(
      /\.btn--primary\s*\{[\s\S]*?&:hover\s*\{[^}]*color:\s*\$ftl-color-mj-on-gold/,
    );
    const settle = style(vue('components/MahjongSettlement.vue').content);
    expect(settle).toMatch(
      /\.btn--primary\s*\{[\s\S]*?&:hover\s*\{[^}]*color:\s*\$ftl-color-mj-on-gold/,
    );
  });

  it('uni.scss 定义全部 mj token', () => {
    const s = files.find((f) => f.path === 'src/uni.scss')!.content;
    for (const t of [
      'table-light',
      'table-mid',
      'table-deep',
      'navy',
      'glass',
      'gold',
      'cyan',
      'urgent',
      'muted',
      'on-gold',
    ]) {
      expect(s).toContain(`$ftl-color-mj-${t}:`);
    }
  });
});

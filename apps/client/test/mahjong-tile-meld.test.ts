import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { MahjongMeldView, Tile } from '@fight-the-landlord/protocol';
import MahjongTile from '../src/components/table/mahjong/MahjongTile.vue';
import MahjongMeld from '../src/components/table/mahjong/MahjongMeld.vue';
import { SRC_ROOT, stripComments } from './helpers/source-scan';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };

function meld(kind: MahjongMeldView['kind'], tiles: Tile[]): MahjongMeldView {
  return { kind, tiles };
}

/** 从内联 style 里取 `prop: <n>px`（按属性名边界匹配，避免子串误命中）。 */
function stylePx(style: string, prop: string): number {
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`));
  if (!m) throw new Error(`inline style 缺少 ${prop}px：${style}`);
  return Number(m[1]);
}

/** 组高 = 首张高 + 其余每张「高 + 负 marginTop」；直接从渲染结果算，不读 props。 */
function verticalGroupHeight(wrapper: VueWrapper): number {
  const tiles = wrapper.findAll('.mj-tile');
  const first = tiles[0]!.attributes('style') ?? '';
  const firstH = stylePx(first, 'height');
  return tiles.slice(1).reduce((acc, t) => {
    const style = t.attributes('style') ?? '';
    return acc + stylePx(style, 'height') + stylePx(style, 'margin-top');
  }, firstH);
}

describe('MahjongTile 显式尺寸', () => {
  it('w/h 同时给出时内联 style 覆盖 size 档位', () => {
    const w = mount(MahjongTile, { props: { tile: wan1, w: 72, h: 108 } });
    expect(w.attributes('style')).toContain('width: 72px');
    expect(w.attributes('style')).toContain('height: 108px');
  });

  it('不给 w/h 时仍走 size 类，无内联尺寸', () => {
    const w = mount(MahjongTile, { props: { tile: wan1, size: 'lg' } });
    expect(w.classes()).toContain('mj-tile--lg');
    expect(w.attributes('style')).toBeUndefined();
  });
});

describe('MahjongMeld 可变尺寸与杠/暗杠', () => {
  it('碰 3 张、杠 4 张同行，无绝对定位 cap', () => {
    const peng = mount(MahjongMeld, { props: { meld: meld('peng', [wan1, wan1, wan1]) } });
    expect(peng.findAll('.mj-tile')).toHaveLength(3);
    expect(peng.find('.mj-meld__cap').exists()).toBe(false);

    const gang = mount(MahjongMeld, {
      props: { meld: meld('gang', [wan1, wan1, wan1, wan2]) },
    });
    expect(gang.findAll('.mj-tile')).toHaveLength(4);
    expect(gang.find('.mj-meld__cap').exists()).toBe(false);
    for (const t of gang.findAll('.mj-tile')) {
      const style = t.attributes('style') ?? '';
      expect(style).not.toContain('position');
      expect(style).not.toContain('top');
      expect(style).not.toContain('bottom');
    }
  });

  it('暗杠 4 张全部是牌背', () => {
    const w = mount(MahjongMeld, {
      props: { meld: meld('angang', [wan1, wan1, wan1, wan1]) },
    });
    const srcs = w.findAll('image').map((i) => i.attributes('src') ?? '');
    expect(srcs).toHaveLength(4);
    expect(srcs.every((s) => s.endsWith('/back.png'))).toBe(true);
  });

  it('tileW/tileH/overlap 透传到每张牌', () => {
    const w = mount(MahjongMeld, {
      props: {
        meld: meld('gang', [wan1, wan1, wan1, wan2]),
        tileW: 40,
        tileH: 60,
        overlap: 8,
      },
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.attributes('style')).toContain('width: 40px');
      expect(t.attributes('style')).toContain('height: 60px');
    }
    expect(tiles[0]!.attributes('style') ?? '').not.toContain('margin-left');
    for (const t of tiles.slice(1)) {
      expect(t.attributes('style')).toContain('margin-left: -8px');
    }
  });

  it('pop 类按 kind 保留', () => {
    const w = mount(MahjongMeld, {
      props: { meld: meld('gang', [wan1, wan1, wan1, wan2]), pop: true },
    });
    expect(w.classes()).toContain('anim-meld-pop');
    expect(w.classes()).toContain('anim-meld-pop--gang');
  });
});

describe('MahjongMeld pop-done（scoped keyframes 重命名）', () => {
  function mountWithPop(kind: MahjongMeldView['kind']) {
    return mount(MahjongMeld, { props: { meld: meld(kind, [wan1, wan1, wan1]), pop: true } });
  }

  function fire(w: VueWrapper, name: string): void {
    const e = new Event('animationend') as AnimationEvent;
    Object.defineProperty(e, 'animationName', { value: name });
    w.element.dispatchEvent(e);
  }

  it('scoped 重命名后的 ftl-*-pop-<hash> 仍 emit pop-done', () => {
    for (const [kind, name] of [
      ['peng', 'ftl-peng-pop-abc123'],
      ['gang', 'ftl-gang-pop-def456'],
      ['angang', 'ftl-angang-pop-ghi789'],
    ] as const) {
      const w = mountWithPop(kind);
      fire(w, name);
      expect(w.emitted('pop-done'), name).toHaveLength(1);
    }
  });

  it('无关动画名（其他 ftl 动画）不 emit', () => {
    const w = mountWithPop('peng');
    fire(w, 'ftl-deal-in-abc123');
    expect(w.emitted('pop-done')).toBeUndefined();
  });
});

describe('MahjongTile image mode', () => {
  it('默认 mode=aspectFit', () => {
    const w = mount(MahjongTile, { props: { tile: wan1 } });
    expect(w.attributes('mode')).toBe('aspectFit');
  });

  it('mode=aspectFill 透传到 image', () => {
    const w = mount(MahjongTile, { props: { tile: wan1, mode: 'aspectFill' } });
    expect(w.attributes('mode')).toBe('aspectFill');
  });
});

describe('MahjongMeld vertical（侧家竖叠，不旋转）', () => {
  const TILE_W = 36.4;
  const TILE_H = 29.714;
  const OVERLAP = 4;

  function verticalMeld(kind: 'peng' | 'gang', tiles: Tile[]) {
    return mount(MahjongMeld, {
      props: {
        meld: meld(kind, tiles),
        vertical: true,
        tileW: TILE_W,
        tileH: TILE_H,
        overlap: OVERLAP,
      },
    });
  }

  it('root 带 mj-meld--vertical；非首张 margin-top: -overlap（不是硬编码）', () => {
    const w = verticalMeld('gang', [wan1, wan1, wan1, wan2]);
    expect(w.classes()).toContain('mj-meld--vertical');
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(4);
    expect(tiles[0]!.attributes('style') ?? '').not.toContain('margin-top');
    for (const t of tiles.slice(1)) {
      const style = t.attributes('style') ?? '';
      expect(style).toContain('margin-top: -4px');
      expect(style).not.toContain('margin-left');
    }
  });

  it('overlap 变化时 marginTop 跟随（overlap=6 → -6px）', () => {
    const w = mount(MahjongMeld, {
      props: {
        meld: meld('peng', [wan1, wan1, wan1]),
        vertical: true,
        tileH: TILE_H,
        overlap: 6,
      },
    });
    for (const t of w.findAll('.mj-tile').slice(1)) {
      expect(t.attributes('style')).toContain('margin-top: -6px');
    }
  });

  it('组高 = 4*tileH - 3*overlap = 106.856 ≈ 106.86（按渲染结果计算）', () => {
    const w = verticalMeld('gang', [wan1, wan1, wan1, wan2]);
    expect(verticalGroupHeight(w)).toBeCloseTo(4 * TILE_H - 3 * OVERLAP, 5);
    expect(verticalGroupHeight(w)).toBeCloseTo(106.86, 2);
  });
});

describe('MahjongMeld horizontal（默认，保持原行为）', () => {
  it('非首张 margin-left: -overlap，无 margin-top', () => {
    const w = mount(MahjongMeld, {
      props: { meld: meld('gang', [wan1, wan1, wan1, wan2]), tileH: 29.714, overlap: 4 },
    });
    expect(w.classes()).not.toContain('mj-meld--vertical');
    const tiles = w.findAll('.mj-tile');
    expect(tiles[0]!.attributes('style') ?? '').not.toContain('margin-left');
    for (const t of tiles.slice(1)) {
      const style = t.attributes('style') ?? '';
      expect(style).toContain('margin-left: -4px');
      expect(style).not.toContain('margin-top');
    }
  });
});

describe('暗杠：aspectFill 牌背 + 与杠组高一致', () => {
  const TILE_W = 36.4;
  const TILE_H = 29.714;
  const OVERLAP = 4;

  it('4 张全部 back.png 且 mode=aspectFill', () => {
    const w = mount(MahjongMeld, {
      props: {
        meld: meld('angang', [wan1, wan1, wan1, wan1]),
        vertical: true,
        tileW: TILE_W,
        tileH: TILE_H,
        overlap: OVERLAP,
      },
    });
    const imgs = w.findAll('image');
    expect(imgs).toHaveLength(4);
    for (const img of imgs) {
      expect(img.attributes('src') ?? '').toMatch(/\/back\.png$/);
      expect(img.attributes('mode')).toBe('aspectFill');
    }
  });

  it('组高与 4 张杠一致（都是 4*tileH - 3*overlap）', () => {
    const angang = mount(MahjongMeld, {
      props: {
        meld: meld('angang', [wan1, wan1, wan1, wan1]),
        vertical: true,
        tileW: TILE_W,
        tileH: TILE_H,
        overlap: OVERLAP,
      },
    });
    const gang = mount(MahjongMeld, {
      props: {
        meld: meld('gang', [wan1, wan1, wan1, wan2]),
        vertical: true,
        tileW: TILE_W,
        tileH: TILE_H,
        overlap: OVERLAP,
      },
    });
    expect(verticalGroupHeight(angang)).toBeCloseTo(verticalGroupHeight(gang), 5);
    expect(verticalGroupHeight(angang)).toBeCloseTo(4 * TILE_H - 3 * OVERLAP, 5);
  });

  it('非暗杠的牌面仍走默认 aspectFit', () => {
    const w = mount(MahjongMeld, {
      props: { meld: meld('gang', [wan1, wan1, wan1, wan2]), vertical: true },
    });
    for (const img of w.findAll('image')) {
      expect(img.attributes('mode')).toBe('aspectFit');
    }
  });

  it('暗杠金边：outline 走 $ftl-hairline/$ftl-color-mj-gold，不用 border / inset 阴影', () => {
    const src = stripComments(
      readFileSync(join(SRC_ROOT, 'components/table/mahjong/MahjongMeld.vue'), 'utf8'),
    );
    const rule = /\.mj-meld--angang\s+:deep\(\.mj-tile\)\s*\{([^}]*)\}/.exec(src);
    expect(rule, '暗杠金边规则必须存在').not.toBeNull();
    const body = rule![1]!;
    expect(body, '描边必须走发丝线变量 + 红金令牌').toMatch(
      /outline:\s*\$ftl-hairline\s+solid\s+\$ftl-color-mj-gold\s*;/,
    );
    expect(body, 'offset 必须用负发丝线（内描边）').toMatch(
      /outline-offset:\s*-\$ftl-hairline\s*;/,
    );
    expect(body, '不得用 border（会改盒模型）').not.toMatch(/border\s*:/);
    expect(body, '不得用 inset 阴影（会被牌面图盖住）').not.toContain('inset');
  });
});

describe('方向只靠左右横置素材 + 竖叠，不用 rotate', () => {
  for (const file of ['MahjongTile.vue', 'MahjongMeld.vue']) {
    it(`${file} 去掉注释后不含 rotate 字面量`, () => {
      const src = stripComments(
        readFileSync(join(SRC_ROOT, 'components/table/mahjong', file), 'utf8'),
      );
      expect(src.toLowerCase()).not.toContain('rotate');
    });
  }
});

// ---------------------------------------------------------------------------
// 红金皮肤（2026-11-08 Task 3）—— 牌面投影 / 置灰合并 / 选中金边
// ---------------------------------------------------------------------------

describe('MahjongTile：红金皮肤（Task 3）', () => {
  const tileSrc = stripComments(
    readFileSync(join(SRC_ROOT, 'components/table/mahjong/MahjongTile.vue'), 'utf8'),
  );
  const style = [...tileSrc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1]!)
    .join('\n');

  it('face-up（非牌背）统一投影 drop-shadow', () => {
    const rule = /\.mj-tile:not\(\.mj-tile--back\)\s*\{([^}]*)\}/.exec(style);
    expect(rule, 'face-up 投影规则必须存在').not.toBeNull();
    expect(rule![1]).toContain('filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.45))');
  });

  it('置灰牌合并 grayscale + 投影（不得单独声明 filter 覆盖掉阴影）', () => {
    const rule = /\.mj-tile:not\(\.mj-tile--back\)\.mj-tile--dim\s*\{([^}]*)\}/.exec(style);
    expect(rule, '.mj-tile--dim 合并 filter 规则必须存在').not.toBeNull();
    expect(rule![1]).toContain(
      'filter: grayscale(.6) drop-shadow(0 2px 2px rgba(0, 0, 0, 0.45))',
    );
    // 反面对照：单独的 `.mj-tile--dim { filter: grayscale(...) }` 会把 face-up 投影覆盖掉。
    const loneDim = /(?:^|\n)\s*\.mj-tile--dim\s*\{([^}]*)\}/.exec(style);
    if (loneDim) expect(loneDim[1], '单独 .mj-tile--dim 规则不得带 filter').not.toContain('filter');
  });

  it('牌背不加 filter（性能）', () => {
    // 不得有独立 `.mj-tile--back { filter: … }` 规则（`:not(.mj-tile--back)` 不算）。
    expect(/(?:^|\n)\s*\.mj-tile--back\s*\{[^}]*filter\s*:/m.test(style)).toBe(false);
  });

  it('selected 描边用红金令牌 $ftl-color-mj-gold（不是旧 $ftl-color-gold），保留抬升', () => {
    const rule = /\.mj-tile--selected\s*\{([^}]*)\}/.exec(style);
    expect(rule, '.mj-tile--selected 规则必须存在').not.toBeNull();
    expect(rule![1]).toContain('$ftl-color-mj-gold');
    expect(rule![1]).not.toMatch(/\$ftl-color-gold\b/);
    expect(rule![1], '保留选中抬升').toContain('translateY');
  });
});

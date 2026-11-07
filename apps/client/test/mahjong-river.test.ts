import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount } from '@vue/test-utils';
import { tileType, type MahjongMeldView, type Tile } from '@fight-the-landlord/protocol';
import MahjongRiver from '../src/components/table/mahjong/MahjongRiver.vue';
import MahjongMeld from '../src/components/table/mahjong/MahjongMeld.vue';
import { collectSourceFiles, SRC_ROOT, stripComments } from './helpers/source-scan';

const wan1: Tile = { s: 0, r: 1 };
const wan2: Tile = { s: 0, r: 2 };
const tong1: Tile = { s: 1, r: 1 };

/** 第 i 张牌的牌面（27 种循环，牌面互不相同的足够长序列）。 */
function tileAt(i: number): Tile {
  return { s: (Math.floor(i / 9) % 3) as 0 | 1 | 2, r: (i % 9) + 1 };
}

function makeDiscards(n: number): Tile[] {
  return Array.from({ length: n }, (_, i) => tileAt(i));
}

/** 从内联 style 里取 `prop: <n>px`（按属性名边界匹配，避免子串误命中）。 */
function stylePx(style: string, prop: string): number {
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`));
  if (!m) throw new Error(`inline style 缺少 ${prop}px：${style}`);
  return Number(m[1]);
}

function props(over: Record<string, unknown> = {}) {
  return {
    discards: [wan1, wan2, tong1],
    melds: [] as Array<{ key: string; meld: MahjongMeldView; pop: boolean }>,
    direction: 'my' as const,
    tileW: 50,
    tileH: 75,
    gap: 2,
    cols: 12,
    rows: 2,
    meldTileW: 40,
    meldTileH: 60,
    meldOverlap: 8,
    meldPlacement: 'above' as const,
    meldGap: 8,
    meldGroupGap: 4,
    meldHeight: 0,
    filterTileType: null,
    interactive: false,
    revealed: null,
    ...over,
  };
}

describe('MahjongRiver', () => {
  it('弃牌按顺序渲染，最后一张高亮', () => {
    const w = mount(MahjongRiver, { props: props() });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(3);
    expect(tiles[2]!.classes()).toContain('mj-river__tile--latest');
    expect(tiles[2]!.classes()).toContain('anim-discard-land');
    expect(tiles[1]!.classes()).not.toContain('anim-discard-land');
    const grid = w.find('.mj-river__grid');
    expect(grid.attributes('style')).toContain('grid-template-columns: repeat(12, 50px)');
    expect(grid.attributes('style')).toContain('gap: 2px');
  });

  it('点击弃牌 emit discard-click {tile,index}（interactive=true，index 为窗口相对下标）', async () => {
    const w = mount(MahjongRiver, { props: props({ interactive: true }) });
    await w.findAll('.mj-tile')[0]!.trigger('click');
    expect(w.emitted('discard-click')?.[0]).toEqual([{ tile: wan1, index: 0 }]);
  });

  it('interactive=false 时点击不 emit', async () => {
    const w = mount(MahjongRiver, { props: props() });
    await w.findAll('.mj-tile')[0]!.trigger('click');
    expect(w.emitted('discard-click')).toBeUndefined();
  });

  it('filterTileType 命中加 outline 类（claimSourceIndex 缺席时的 legacy 回退）', () => {
    const w = mount(MahjongRiver, { props: props({ filterTileType: tileType(wan1) }) });
    const tiles = w.findAll('.mj-tile');
    expect(tiles[0]!.classes()).toContain('mj-river__tile--filtered');
    expect(tiles[1]!.classes()).not.toContain('mj-river__tile--filtered');
  });

  it('窗口：29 张只渲染 slice(6, 29)，+6 徽标落在 badgeRect（局部坐标），最后一张 latest', () => {
    const discards = makeDiscards(29);
    const badgeRect = { left: 100, top: 4, width: 50, height: 75 };
    const w = mount(MahjongRiver, {
      props: props({
        discards,
        windowStart: 6,
        windowCount: 23,
        latestIndex: 22,
        badgeCount: 6,
        badgeRect,
      }),
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(23);
    // 第一张 = discards[6]（suit 0, rank 7 → wan-7）
    expect(tiles[0]!.attributes('src')).toMatch(/\/my\/wan-7\.png$/);
    expect(tiles[22]!.classes()).toContain('mj-river__tile--latest');
    expect(w.findAll('.mj-river__tile--latest')).toHaveLength(1);

    const badge = w.find('.mj-river__badge');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('+6');
    const style = badge.attributes('style') ?? '';
    // 红金皮肤（Task 3）：内容尺寸药丸，绝对定位在 badgeRect **中心**（不再铺满整格）。
    expect(stylePx(style, 'left')).toBe(badgeRect.left + badgeRect.width / 2);
    expect(stylePx(style, 'top')).toBe(badgeRect.top + badgeRect.height / 2);
    expect(style).toContain('translate(-50%, -50%)');
    expect(style).not.toContain('width');
    expect(style).not.toContain('height');
  });

  it('窗口内点击：index 是窗口相对下标（首张 → 0）', async () => {
    const discards = makeDiscards(29);
    const w = mount(MahjongRiver, {
      props: props({ discards, windowStart: 6, windowCount: 23, interactive: true }),
    });
    await w.findAll('.mj-tile')[0]!.trigger('click');
    expect(w.emitted('discard-click')?.[0]).toEqual([{ tile: discards[6], index: 0 }]);
  });

  it('claimSourceIndex=5：只描边窗口第 6 张（即使同型多张）；点同型非来源不 emit', async () => {
    // 窗口下标 0/2/4/5/7 都是 wan1；来源是下标 5。
    const discards = [wan1, wan2, wan1, tong1, wan1, wan1, wan2, wan1];
    const w = mount(MahjongRiver, {
      props: props({
        discards,
        interactive: true,
        claimSourceIndex: 5,
        // 同时给 legacy 过滤：claimSourceIndex 存在时必须被压过（只描边单张）。
        filterTileType: tileType(wan1),
      }),
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles[5]!.classes()).toContain('mj-river__tile--filtered');
    for (const i of [0, 2, 4, 7]) {
      expect(tiles[i]!.classes()).not.toContain('mj-river__tile--filtered');
    }
    expect(w.findAll('.mj-river__tile--filtered')).toHaveLength(1);

    // 同型非来源点击不 emit。
    await tiles[4]!.trigger('click');
    expect(w.emitted('discard-click')).toBeUndefined();

    // 来源点击 emit 窗口相对 index。
    await tiles[5]!.trigger('click');
    expect(w.emitted('discard-click')?.[0]).toEqual([{ tile: discards[5], index: 5 }]);
  });

  it('revealed 14 张：替换弃牌网格，无徽标、无 latest 高亮', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: makeDiscards(29),
        windowStart: 6,
        windowCount: 23,
        badgeCount: 0,
        latestIndex: 22,
        revealed: { tiles: makeDiscards(14), huTile: wan1 },
      }),
    });
    expect(w.findAll('.mj-tile')).toHaveLength(14);
    expect(w.find('.mj-river__badge').exists()).toBe(false);
    expect(w.findAll('.mj-river__tile--latest')).toHaveLength(0);
  });

  it('revealed 时即使 badgeCount>0 + badgeRect 也不渲染徽标', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: makeDiscards(29),
        badgeCount: 6,
        badgeRect: { left: 100, top: 4, width: 50, height: 75 },
        revealed: { tiles: makeDiscards(14), huTile: wan1 },
      }),
    });
    expect(w.find('.mj-river__badge').exists()).toBe(false);
  });

  it('副露条：碰 3 张 + 杠 4 张，只剩牌组、无碰/杠/暗杠文字标签', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [
          { key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false },
          { key: 'gang:0_0_0_1', meld: { kind: 'gang', tiles: [wan1, wan1, wan1, wan2] }, pop: true },
        ],
        meldHeight: 60,
      }),
    });
    expect(w.findAll('.mj-river__meld')).toHaveLength(2);
    expect(w.findAll('.mj-tile')).toHaveLength(7);
    // 红金皮肤（Task 3）：mockup 无副露文字标签 ⇒ 整片移除（只留副露牌组）。
    expect(w.find('.mj-river__meld-label').exists()).toBe(false);
    expect(w.text()).not.toContain('碰');
    expect(w.text()).not.toContain('杠');
    expect(w.text()).not.toContain('暗杠');
    const strip = w.find('.mj-river__melds');
    expect(strip.attributes('style')).toContain('bottom: calc(100% + 8px)');
    expect(strip.attributes('style')).toContain('height: 60px');
    expect(strip.attributes('style')).toContain('gap: 4px');
    const meldComps = w.findAllComponents(MahjongMeld);
    expect(meldComps).toHaveLength(2);
    // 第二个是 pop:true 的杠（第一个是 pop:false 的碰）
    expect(meldComps[1]!.classes()).toContain('anim-meld-pop');
  });

  it('meldRect：侧家 lane 用局部坐标定位，Meld 竖叠并透传 w/h/overlap', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        direction: 'left',
        melds: [
          { key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false },
        ],
        meldRect: { left: 8, top: 12, width: 40, height: 300 },
        laneWidth: 30,
      }),
    });
    const strip = w.find('.mj-river__melds');
    const style = strip.attributes('style') ?? '';
    expect(stylePx(style, 'left')).toBe(8);
    expect(stylePx(style, 'top')).toBe(12);
    expect(stylePx(style, 'width')).toBe(40);
    expect(stylePx(style, 'height')).toBe(300);
    expect(style).toContain('flex-direction: column');
    expect(style).toContain('overflow: visible');

    const meld = w.findComponent(MahjongMeld);
    expect(meld.classes()).toContain('mj-meld--vertical');
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(3);
    expect(stylePx(tiles[0]!.attributes('style') ?? '', 'width')).toBe(40);
    expect(stylePx(tiles[0]!.attributes('style') ?? '', 'height')).toBe(60);
    for (const t of tiles.slice(1)) {
      expect(stylePx(t.attributes('style') ?? '', 'margin-top')).toBe(-8);
    }
  });

  it('meldRect 缺省：保持 legacy 绝对定位（meldPlacement/meldGap/meldHeight）', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [{ key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false }],
        meldHeight: 60,
      }),
    });
    const style = w.find('.mj-river__melds').attributes('style') ?? '';
    expect(style).toContain('bottom: calc(100% + 8px)');
    expect(style).toContain('height: 60px');
    expect(style).not.toContain('top: 12px');
  });

  it('暗杠副露 4 张全牌背', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [
          {
            key: 'angang',
            meld: { kind: 'angang', tiles: [wan1, wan1, wan1, wan1] },
            pop: false,
          },
        ],
        meldHeight: 60,
      }),
    });
    const srcs = w.findAll('image').map((i) => i.attributes('src') ?? '');
    expect(srcs).toHaveLength(4);
    expect(srcs.every((src) => src.endsWith('/back.png'))).toBe(true);
  });

  it('meldPlacement=below 时条带在下方', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [{ key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: false }],
        meldPlacement: 'below',
        meldHeight: 60,
      }),
    });
    expect(w.find('.mj-river__melds').attributes('style')).toContain('top: calc(100% + 8px)');
  });

  it('副露 pop-done 原样上抛 key', () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [],
        melds: [{ key: 'peng:0_0_0', meld: { kind: 'peng', tiles: [wan1, wan1, wan1] }, pop: true }],
        meldHeight: 60,
      }),
    });
    w.findComponent(MahjongMeld).vm.$emit('pop-done');
    expect(w.emitted('meld-pop-done')?.[0]).toEqual(['peng:0_0_0']);
  });

  it('direction 类名正确', () => {
    for (const direction of ['my', 'top', 'left', 'right'] as const) {
      expect(mount(MahjongRiver, { props: props({ direction }) }).classes()).toContain(
        `mj-river--${direction}`,
      );
    }
  });

  it('revealed：亮牌网格替换 discards，不响应点击', async () => {
    const w = mount(MahjongRiver, {
      props: props({
        discards: [wan2],
        revealed: { tiles: [wan1, tong1], huTile: tong1 },
      }),
    });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(2);
    expect(w.find('.mj-river__revealed').exists()).toBe(true);
    expect(w.text()).toContain('已胡');
    await tiles[0]!.trigger('click');
    expect(w.emitted('discard-click')).toBeUndefined();
  });
});

/**
 * 终审 Important 1：侧河 `+N` 徽标与网格对齐（v13 §10.4）。
 *
 * 布局的 `badgeRect` 按**容量行数**顶对齐推算，而网格实际只铺已用行且默认居中。
 * 侧河 raw>24 时（容量 10 行、只铺 8 行）居中会把网格下移 24–48px，+N 就压到牌上。
 * 修法：有徽标时网格改顶对齐（`mj-river__grid--badged`），徽标仍在 `badgeRect` 绝对定位。
 */
describe('MahjongRiver：+N 徽标与网格对齐', () => {
  /** 侧河 25 张：窗口 24 张（3 列 × 8 行），容量 10 行 ⇒ 徽标 1 张。 */
  const sideBadgeProps = (over: Record<string, unknown> = {}) =>
    props({
      discards: makeDiscards(25),
      direction: 'right',
      windowStart: 1,
      windowCount: 24,
      latestIndex: 23,
      cols: 3,
      rows: 10,
      tileW: 56,
      tileH: 45.714,
      gap: 2,
      ...over,
    });
  const badgeRect = { left: 100, top: 4, width: 56, height: 45.714 };

  it('badgeCount > 0：网格加 mj-river__grid--badged（顶对齐），徽标不进网格流', () => {
    const w = mount(MahjongRiver, {
      props: sideBadgeProps({ badgeCount: 1, badgeRect }),
    });
    const grid = w.find('.mj-river__grid');
    expect(grid.exists()).toBe(true);
    expect(grid.classes()).toContain('mj-river__grid--badged');
    expect(w.findAll('.mj-tile')).toHaveLength(24);
    // 徽标仍以 badgeRect 绝对定位（v13 §10.4 要求），不在网格内。
    const badge = w.find('.mj-river__badge');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('+1');
    expect(w.findAll('.mj-river__grid .mj-river__badge')).toHaveLength(0);
    expect(stylePx(badge.attributes('style') ?? '', 'top')).toBeCloseTo(
      badgeRect.top + badgeRect.height / 2,
      3,
    );
  });

  it('badgeCount = 0：网格不加 mj-river__grid--badged（保持居中）', () => {
    const w = mount(MahjongRiver, {
      props: sideBadgeProps({ windowStart: 0, windowCount: 25, latestIndex: 24 }),
    });
    const grid = w.find('.mj-river__grid');
    expect(grid.classes()).not.toContain('mj-river__grid--badged');
    expect(w.find('.mj-river__badge').exists()).toBe(false);
  });

  it('源码闸：--badged 规则必须是 align-self: flex-start（顶对齐）', () => {
    const river = collectSourceFiles().find(
      (f) => f.path === 'src/components/table/mahjong/MahjongRiver.vue',
    );
    expect(river, 'MahjongRiver.vue 必须在源码扫描集合里').toBeDefined();
    const rule = /\.mj-river__grid--badged\s*\{([^}]*)\}/.exec(stripComments(river!.content));
    expect(rule, '.mj-river__grid--badged 规则必须存在').not.toBeNull();
    expect(rule![1], '有徽标时网格必须顶对齐，才能与 badgeRect 的顶对齐数学同口径').toContain(
      'align-self: flex-start',
    );
    // 判别力：只有居中网格的合成样本不得命中。
    const bad = '.mj-river__grid { align-content: center; justify-content: center; }';
    expect(/\.mj-river__grid--badged\s*\{([^}]*)\}/.exec(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 红金皮肤（2026-11-08 Task 3）—— 最新/来源描边 / +N 药丸 / 已胡标签 / 亮牌翻转
// ---------------------------------------------------------------------------

const riverSrc = stripComments(
  readFileSync(join(SRC_ROOT, 'components/table/mahjong/MahjongRiver.vue'), 'utf8'),
);
const riverStyle = [...riverSrc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
  .map((m) => m[1]!)
  .join('\n');

/** 取源码里一条选择器规则的声明体（本文件的这些规则没有嵌套块）。 */
function riverRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(riverStyle);
  expect(m, `${selector} 规则必须存在`).not.toBeNull();
  return m![1]!;
}

describe('MahjongRiver：红金皮肤（Task 3：描边 / 徽标 / 标签）', () => {
  it('最新牌：发丝线高亮 outline + offset 0 + 高亮色光晕（旧 box-shadow 已删）', () => {
    const body = riverRule('.mj-river__tile--latest');
    expect(body).toContain('outline: $ftl-hairline solid $ftl-color-mj-highlight');
    expect(body).toContain('outline-offset: 0');
    expect(body).toContain('filter: drop-shadow(0 0 6px rgba($ftl-color-mj-highlight, .8))');
    expect(body).not.toContain('box-shadow');
  });

  it('最新牌用内联 filter 金光（压过 Tile 自带落影），只限最新一张', () => {
    // 终审 Important 1：River 的 scoped 类规则 (0,2,0) 恒输给 MahjongTile 的
    // `.mj-tile:not(.mj-tile--back)` (0,3,0) ⇒ 光晕必须是内联样式，类规则只作兜底。
    const w = mount(MahjongRiver, { props: props() });
    const tiles = w.findAll('.mj-tile');
    const latestStyle = tiles[2]!.attributes('style') ?? '';
    expect(latestStyle).toContain('drop-shadow(0 0 6px');
    expect(latestStyle).toContain('rgba(255, 216, 115, 0.8)');
    // 替代底影（mockup `.tile.latest` 行为），不是叠加。
    expect(latestStyle).not.toContain('rgba(0, 0, 0');
    // 内联 filter 与 Tile 自己的宽高 style 是**合并**（fallthrough），不是覆盖。
    expect(stylePx(latestStyle, 'width')).toBe(50);
    expect(stylePx(latestStyle, 'height')).toBe(75);
    for (const i of [0, 1]) {
      expect(tiles[i]!.attributes('style') ?? '').not.toContain('drop-shadow');
    }

    // latestIndex=null（不高亮）⇒ 整组都没有内联 filter。
    const none = mount(MahjongRiver, { props: props({ latestIndex: null }) });
    for (const t of none.findAll('.mj-tile')) {
      expect(t.attributes('style') ?? '').not.toContain('drop-shadow');
    }
  });

  it('claimed 来源描边用红金 $ftl-color-mj-gold（不再用 $ftl-color-primary 蓝）', () => {
    const body = riverRule('.mj-river__tile--filtered');
    expect(body).toContain('outline: $ftl-hairline solid $ftl-color-mj-gold');
    expect(body).toContain('outline-offset: 0');
    expect(body).not.toContain('$ftl-color-primary');
  });

  it('+N 徽标：内容尺寸金底药丸（16px / 700 / ink 字），不铺满整格', () => {
    const body = riverRule('.mj-river__badge');
    expect(body).toContain('padding: 2px 4px');
    expect(body).toContain('border-radius: 6px');
    expect(body).toContain('background: $ftl-color-mj-gold');
    expect(body).toContain('color: $ftl-color-mj-ink');
    expect(body).toContain('font-size: 16px');
    expect(body).toContain('font-weight: 700');
  });

  it('已胡标签移到河内底部（bottom: 0 / top: auto），金底深字', () => {
    const body = riverRule('.mj-river__revealed-label');
    expect(body).toContain('bottom: 0');
    expect(body).toContain('top: auto');
    expect(body).toContain('left: 0');
    expect(body).toContain('background: $ftl-color-mj-gold');
    expect(body).toContain('color: $ftl-color-mj-ink');
    // DOM 侧确认标签仍渲染。
    const w = mount(MahjongRiver, {
      props: props({ revealed: { tiles: [wan1], huTile: wan1 } }),
    });
    expect(w.find('.mj-river__revealed-label').text()).toBe('已胡');
  });

  it('副露标签整片移除（MELD_LABEL / 模板 / 样式）', () => {
    expect(riverSrc).not.toContain('MELD_LABEL');
    expect(riverSrc).not.toContain('mj-river__meld-label');
  });
});

describe('MahjongRiver：亮牌翻转（revealNonce）', () => {
  const revealed = { tiles: makeDiscards(3), huTile: wan1 };

  it('seed（revealNonce 缺省 / 0）不播翻转：无 anim-reveal-in', () => {
    const dflt = mount(MahjongRiver, { props: props({ revealed }) });
    expect(dflt.findAll('.anim-reveal-in')).toHaveLength(0);
    const zero = mount(MahjongRiver, { props: props({ revealed, revealNonce: 0 }) });
    expect(zero.findAll('.anim-reveal-in')).toHaveLength(0);
  });

  it('revealNonce > 0：每张挂 anim-reveal-in + 40ms 错峰', () => {
    const w = mount(MahjongRiver, { props: props({ revealed, revealNonce: 1 }) });
    const tiles = w.findAll('.mj-tile');
    expect(tiles).toHaveLength(3);
    for (const t of tiles) expect(t.classes()).toContain('anim-reveal-in');
    expect(tiles[0]!.attributes('style')).toContain('--ftl-delay: 0ms');
    expect(tiles[1]!.attributes('style')).toContain('--ftl-delay: 40ms');
    expect(tiles[2]!.attributes('style')).toContain('--ftl-delay: 80ms');
  });

  it('key 含 revealNonce：nonce 变化 ⇒ 整组重挂（重播翻转）', async () => {
    const w = mount(MahjongRiver, { props: props({ revealed, revealNonce: 1 }) });
    const firstEl = w.findAll('.mj-tile')[0]!.element;
    await w.setProps({ revealNonce: 2 });
    expect(w.findAll('.mj-tile')[0]!.element).not.toBe(firstEl);
    expect(w.findAll('.mj-tile')[0]!.classes()).toContain('anim-reveal-in');
  });
});

// ---------------------------------------------------------------------------
// 红金皮肤（2026-11-08 Task 4）—— rob 副露高亮（claimSourceMeldKey）
// ---------------------------------------------------------------------------

describe('MahjongRiver：rob 副露高亮（claimSourceMeldKey）', () => {
  const melds = [
    { key: '1:peng:4', meld: { kind: 'peng' as const, tiles: [wan1, wan1, wan1] }, pop: false },
    { key: '1:peng:8', meld: { kind: 'peng' as const, tiles: [wan2, wan2, wan2] }, pop: false },
  ];

  it('只把与 claimSourceMeldKey 匹配的那组副露传 highlight=true', () => {
    const w = mount(MahjongRiver, {
      props: props({ discards: [], melds, claimSourceMeldKey: '1:peng:4' }),
    });
    const comps = w.findAllComponents(MahjongMeld);
    expect(comps).toHaveLength(2);
    expect(comps[0]!.props('highlight')).toBe(true);
    expect(comps[1]!.props('highlight')).toBe(false);
    expect(w.findAll('.mj-meld--highlight')).toHaveLength(1);
    expect(w.findAll('.mj-river__meld')[0]!.find('.mj-meld--highlight').exists()).toBe(true);
  });

  it('缺省 / null：两组副露都不高亮', () => {
    for (const extra of [{}, { claimSourceMeldKey: null }]) {
      const w = mount(MahjongRiver, { props: props({ discards: [], melds, ...extra }) });
      expect(w.findAllComponents(MahjongMeld).map((m) => m.props('highlight'))).toEqual([
        false,
        false,
      ]);
      expect(w.find('.mj-meld--highlight').exists()).toBe(false);
    }
  });
});

/**
 * 川麻红金皮肤（2026-11-08 Task 4）—— 旧色最终扫描。
 *
 * 判据（v12/v13 + mockup 口径）：
 *  · `src/components/table/mahjong/**` 的**代码/模板/样式**（剥注释后、去空白后）不得再出现
 *    旧深绿牌桌色、旧语义色（绿成功/蓝主色/橙提示）与通用 `$ftl-color-primary`；
 *  · `$ftl-color-accent` 不得出现在 `MahjongSeatChip.vue` / `MahjongHub.vue`
 *    （座位牌与血战盘已整片改红金）；
 *  · `MahjongSettlement.vue` 主按钮规则必须用红金令牌（status / gold / ink）——
 *    结算的橙色 detail/events 按钮**不在本片范围**（v4 §3），本文件不扫描它们。
 *
 * ⚠️ 扫描读**剥注释视图**（`stripComments`）：本仓注释习惯逐字引用旧写法，按原始文本
 *    匹配会把「解释」判红，逼后来人删解释。去空白是为了兼容 `rgba(40, 76, 51` 与
 *    `rgba(40,76,51` 两种书写（格式化器会加空格）。
 * ⚠️ 闸必须有判别力：本文件带合成负对照（旧色样本必须判负、干净样本必须放行）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC_ROOT, collectSourceFiles, stripComments } from './helpers/source-scan';

const sources = collectSourceFiles();
const MAHJONG_DIR = 'src/components/table/mahjong/';
const mahjongFiles = sources.filter((f) => f.path.startsWith(MAHJONG_DIR));

/** 旧深绿牌桌 / 旧语义色 / 通用主色（去空白后匹配，见文件头）。 */
const FORBIDDEN_PALETTE = [
  '$ftl-color-mahjong-table',
  'rgba(20,50,30',
  'rgba(40,76,51',
  'rgba(23,50,33',
  'rgba(60,110,75',
  'rgba(35,75,50',
  'rgba(120,130,150',
  'rgba(74,222,128',
  'rgba(120,170,255',
  'rgba(255,180,60',
  'rgba(220,100,30',
  '$ftl-color-primary',
];

const squash = (text: string): string => text.replace(/\s+/g, '');

/** 命中集合（返回命中的禁止令牌；空数组 = 干净）。 */
function paletteOffenders(
  text: string,
  forbidden: readonly string[] = FORBIDDEN_PALETTE,
): string[] {
  const code = squash(stripComments(text));
  return forbidden.filter((token) => code.includes(squash(token)));
}

describe('川麻红金皮肤：旧色最终扫描', () => {
  it('扫描面自证：mahjong 目录至少 9 个组件源码', () => {
    expect(mahjongFiles.length, '扫描器必须真的读到麻将组件').toBeGreaterThanOrEqual(9);
    const paths = mahjongFiles.map((f) => f.path);
    for (const required of [
      'MahjongBoard.vue',
      'MahjongRiver.vue',
      'MahjongMeld.vue',
      'MahjongTile.vue',
      'MahjongHub.vue',
      'MahjongSeatChip.vue',
      'MahjongHandBacks.vue',
      'MahjongActionBar.vue',
      'MahjongHuBanner.vue',
    ]) {
      expect(paths.some((p) => p.endsWith(required)), `${required} 必须在扫描集合里`).toBe(true);
    }
  });

  it('麻将组件无旧深绿 / 旧语义色 / 通用 $ftl-color-primary（剥注释 + 去空白）', () => {
    const offenders = mahjongFiles.flatMap((f) =>
      paletteOffenders(f.content).map((token) => `${f.path}: ${token}`),
    );
    expect(offenders, `旧色残留：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('$ftl-color-accent 不得出现在 SeatChip / Hub（红金两件已整片换色）', () => {
    for (const file of ['MahjongSeatChip.vue', 'MahjongHub.vue']) {
      const source = mahjongFiles.find((f) => f.path.endsWith(file));
      expect(source, `${file} 必须在扫描集合里`).toBeDefined();
      expect(stripComments(source!.content), `${file} 不得再用 $ftl-color-accent`).not.toContain(
        '$ftl-color-accent',
      );
    }
  });

  it('MahjongSettlement 主按钮：红金渐变（status→gold）+ ink 字 + edge 边', () => {
    const sfc = readFileSync(join(SRC_ROOT, 'components/MahjongSettlement.vue'), 'utf8');
    const source = stripComments(sfc);
    const style = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1]!)
      .join('\n');
    const rule = /\.mj-settlement__again--redgold\s*\{([^}]*)\}/.exec(style);
    expect(rule, '.mj-settlement__again--redgold 规则必须存在').not.toBeNull();
    const body = rule![1]!;
    for (const token of [
      '$ftl-color-mj-status',
      '$ftl-color-mj-gold',
      '$ftl-color-mj-ink',
    ]) {
      expect(body, `主按钮必须使用 ${token}`).toContain(token);
    }
    // 主按钮范围之外的 detail/events 橙色按钮不在本片范围 —— 本判据只锁主按钮规则。
    expect(body).not.toContain('$ftl-color-accent');
  });

  it('合成负对照：rgba(40, 76, 51) 旧色必须被判负，干净样本必须放行', () => {
    expect(
      paletteOffenders('.x { background: rgba(40, 76, 51, 0.85); }'),
      '旧深绿样本必须命中（空格不得影响匹配）',
    ).toEqual(['rgba(40,76,51']);
    expect(
      paletteOffenders('.x { background: $ftl-color-mj-felt-2; color: rgb(106 36 32); }'),
      '红金令牌 / rgb() 样本必须放行',
    ).toEqual([]);
    // 禁止的是「有空格」的旧写法，也要能命中无空格写法
    expect(paletteOffenders('color: rgba(74,222,128,.9);')).toEqual(['rgba(74,222,128']);
  });
});

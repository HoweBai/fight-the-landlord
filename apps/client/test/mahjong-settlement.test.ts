/**
 * 红金皮肤（2026-11-08 Task 4）—— 麻将结算面板：四行 35ms 错峰 + 主按钮红金。
 *
 * 判据：
 *  · 每行 `.mj-settlement__row` 挂 `anim-mj-settlement-row` + 内联 `--ftl-delay = i*35ms`；
 *  · 主按钮 `mj-settlement__again--redgold`（与 `.btn--primary` 同灶时红金态胜出）；
 *  · 主按钮规则的色值全部走红金令牌（status→gold 渐变 / ink 字 / edge 边）；
 *  · 动画登记：keyframe + 独立规则 + reduced-motion 清单。
 *
 * ⚠️ 结算的橙色 detail/events 按钮**不在本片范围**（v4 §3 只要求主按钮 + 行错峰），
 *    本文件不扫描它们。
 * ⚠️ jsdom 不跑动画：观感（错峰顺不顺）只能由真机/真浏览器走查证明。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { MahjongSettlementResult } from '@fight-the-landlord/protocol';
import MahjongSettlement from '../src/components/MahjongSettlement.vue';
import { SRC_ROOT, collectSourceFiles, stripComments } from './helpers/source-scan';

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

/** 最小合法结算载荷：4 座零和（-2 × 3 + 6 = 0），无事件 / 无亮牌。 */
const FIXTURE: MahjongSettlementResult = {
  roomCode: 'MJ1',
  gameType: 'mahjong',
  playerCount: 4,
  baseScore: 1,
  winnerSeats: [1],
  scoreChanges: [
    { seat: 0, delta: -2 },
    { seat: 1, delta: 6 },
    { seat: 2, delta: -2 },
    { seat: 3, delta: -2 },
  ],
  fanDetails: [{ seat: 1, fan: 1, multiplier: 1, items: ['平胡'] }],
  events: [],
  burn: [],
  rakeTotal: 0,
  chajiao: [],
  liuju: false,
  huazhuSeats: [],
  endReason: 'threeWinners',
  writtenOff: [],
  revealedHands: [],
  meldsBySeat: [],
  lackSuits: [null, null, null, null],
  rulesPreset: 'chengdu',
};

function mountSettlement() {
  return mount(MahjongSettlement, {
    props: { settlement: FIXTURE },
    global: { plugins: [pinia] },
  });
}

describe('MahjongSettlement：红金皮肤（Task 4）', () => {
  it('四行错峰入场：anim 类 + --ftl-delay 0/35/70/105ms', () => {
    const w = mountSettlement();
    const rows = w.findAll('.mj-settlement__row');
    expect(rows).toHaveLength(4);
    const delays = ['0ms', '35ms', '70ms', '105ms'];
    rows.forEach((row, i) => {
      expect(row.classes(), `第 ${i + 1} 行必须有错峰类`).toContain('anim-mj-settlement-row');
      expect(row.attributes('style') ?? '', `第 ${i + 1} 行延迟`).toContain(
        `--ftl-delay: ${delays[i]}`,
      );
    });
  });

  it('主按钮：「再来一局」带 mj-settlement__again--redgold（同时保留 .btn--primary）', () => {
    const w = mountSettlement();
    const again = w.find('.mj-settlement__again');
    expect(again.exists()).toBe(true);
    expect(again.text()).toBe('再来一局');
    expect(again.classes()).toContain('mj-settlement__again--redgold');
    // 红金类必须与 `.btn--primary` 同灶出现 —— 测试意图是「压过主态」，不是「换掉类」。
    expect(again.classes()).toContain('btn--primary');
  });

  it('主按钮源码：status→gold 渐变 + ink 字 + edge 边（红金家族）', () => {
    const sfc = readFileSync(join(SRC_ROOT, 'components/MahjongSettlement.vue'), 'utf8');
    const source = stripComments(sfc);
    const style = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1]!)
      .join('\n');
    const rule = /\.mj-settlement__again--redgold\s*\{([^}]*)\}/.exec(style);
    expect(rule, '.mj-settlement__again--redgold 规则必须存在').not.toBeNull();
    const body = rule![1]!;
    expect(body).toContain(
      'linear-gradient(180deg, $ftl-color-mj-status, $ftl-color-mj-gold)',
    );
    expect(body).toContain('color: $ftl-color-mj-ink');
    expect(body).toContain('$ftl-color-mj-edge');
    expect(body, '主按钮不得再用通用 .btn--primary 的金色主态色').not.toContain(
      '$ftl-color-accent',
    );
    // 模板里真的用了这个类（防死规则）
    expect(source).toContain('mj-settlement__again--redgold');
  });

  it('动画登记：keyframe / 独立规则 / 错峰变量 / reduced-motion', () => {
    const anim = collectSourceFiles().find((f) => f.path === 'src/styles/animations.scss');
    expect(anim, 'src/styles/animations.scss 必须在源码扫描集合里').toBeDefined();
    const code = stripComments(anim!.content);

    expect(code, 'keyframe 必须存在').toContain('@keyframes ftl-mj-settlement-row');
    const standalone = /(?:^|[\n}])\s*\.anim-mj-settlement-row\s*\{([^}]*)\}/m.exec(code);
    expect(standalone, '.anim-mj-settlement-row 必须是独立规则（不得分组）').not.toBeNull();
    expect(standalone![1]).toContain('animation-delay: var(--ftl-delay, 0ms)');
    expect(standalone![1]).toContain('backwards');

    // reduced-motion 块（按花括号配对截块，防止类规则自身命中恒绿）
    const at = code.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(at, 'prefers-reduced-motion 块必须存在').toBeGreaterThanOrEqual(0);
    const open = code.indexOf('{', at);
    let depth = 0;
    let block = '';
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          block = code.slice(open + 1, i);
          break;
        }
      }
    }
    expect(block, '降级清单必须覆盖 .anim-mj-settlement-row').toContain(
      '.anim-mj-settlement-row',
    );
  });
});

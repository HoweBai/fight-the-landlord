/**
 * Task 3.2 / spec §5.9：**规则文档对账**。
 *
 * 规则文档 `docs/games/paodekuai.md` 是唯一规则来源；本测试机械校验：
 *  - 每个 pdk 规则配置键都在文档中列出，且**默认值与 `DEFAULT_PDK_RULES` 一致**；
 *  - 用牌/发牌/首出/牌型/比较/保本/计分/超时等关键口径在文档中有明确表述。
 *
 * 改默认值或改口径时，本测试会先红 —— 文档与代码必须同步。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PdkRulesConfig } from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES } from './rules';
import { HEART_LEAD_ORDER } from './deal';

function docPath(): string {
  const candidates = [
    resolve(process.cwd(), '../../docs/games/paodekuai.md'),
    resolve(process.cwd(), 'docs/games/paodekuai.md'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`paodekuai rule doc not found; looked at: ${candidates.join(', ')}`);
  return found;
}

const doc = readFileSync(docPath(), 'utf8');
const lines = doc.split(/\r?\n/);

/** 配置键 ←→ `PdkRulesConfig` 字段（默认值只在 `DEFAULT_PDK_RULES` 定义一次）。 */
const RULE_KEY_FIELDS: Array<[keyof PdkRulesConfig, string]> = [
  ['bareTrioEnabled', 'game.paodekuai.bareTrioEnabled'],
  ['trioWithPairEnabled', 'game.paodekuai.trioWithPairEnabled'],
  ['bareAirplaneEnabled', 'game.paodekuai.bareAirplaneEnabled'],
  ['fourWithTwoEnabled', 'game.paodekuai.fourWithTwoEnabled'],
  ['fourWithTwoPairKickerAllowed', 'game.paodekuai.fourWithTwoPairKickerAllowed'],
  ['airplaneWings', 'game.paodekuai.airplaneWings'],
  ['bombMultiplierEnabled', 'game.paodekuai.bombMultiplierEnabled'],
  ['guanMultiplierEnabled', 'game.paodekuai.guanMultiplierEnabled'],
  ['springMultiplierEnabled', 'game.paodekuai.springMultiplierEnabled'],
  ['multiplierCap', 'game.paodekuai.multiplierCap'],
  ['baobenEnabled', 'game.paodekuai.baobenEnabled'],
];

describe('docs/games/paodekuai.md 对账（Task 3.2）', () => {
  it('每个规则配置键都在文档表格中，且默认值与 DEFAULT_PDK_RULES 逐字一致', () => {
    for (const [field, key] of RULE_KEY_FIELDS) {
      const matching = lines.filter((line) => line.includes(key));
      expect(matching.length, `文档缺少配置键 ${key}`).toBeGreaterThan(0);
      const expected = `\`${String(DEFAULT_PDK_RULES[field])}\``;
      expect(
        matching.some((line) => line.includes(expected)),
        `${key} 的默认值应为 ${expected}（文档与 DEFAULT_PDK_RULES 不一致）`,
      ).toBe(true);
    }
  });

  it('玩法开关/人数闸/档位表在文档中列出（默认值与种子一致）', () => {
    for (const [key, value] of [
      ['game.paodekuai.enabled', '`false`'],
      ['game.paodekuai.twoPlayerEnabled', '`false`'],
      ['game.paodekuai.nonThreePlayerEnabled', '`false`'],
    ] as const) {
      const matching = lines.filter((line) => line.includes(key));
      expect(matching.length, `文档缺少配置键 ${key}`).toBeGreaterThan(0);
      expect(matching.some((line) => line.includes(value))).toBe(true);
    }
    const levelsLine = lines.find((line) => line.includes('game.levels.paodekuai'));
    expect(levelsLine).toBeDefined();
    for (const tier of ['15', '80', '480', '1200']) {
      expect(levelsLine).toContain(tier);
    }
  });

  it('用牌：48 张与六张被去掉的牌（含保留红桃2）写清楚', () => {
    expect(doc).toContain('48 张');
    for (const removed of ['大小王', '黑桃 2', '梅花 2', '方块 2', '黑桃 A']) {
      expect(doc, `文档应写明去掉 ${removed}`).toContain(removed);
    }
    expect(doc).toContain('保留红桃 2');
  });

  it('发牌：2/3/4 人张数与 2 人扣牌写清楚', () => {
    expect(doc).toMatch(/\| 2 人 \| 16 \|/);
    expect(doc).toMatch(/\| 3 人 \| 16 \|/);
    expect(doc).toMatch(/\| 4 人 \| 12 \|/);
    expect(doc).toContain('第三份 16 张扣下');
    expect(doc).toContain('红桃 3 → 红桃 4 → 红桃 5 → … → 红桃 K → 红桃 A → 红桃 2');
    expect(HEART_LEAD_ORDER).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17]);
  });

  it('牌型清单完整；AAA/KKKK/飞机翅膀/炸弹可拆口径都在', () => {
    for (const type of [
      '单张',
      '对子',
      '裸三张',
      '三带一',
      '三带二',
      '四带二',
      '顺子',
      '连对',
      '裸飞机',
      '飞机带翅膀',
      '炸弹',
    ]) {
      expect(doc, `文档缺少牌型 ${type}`).toContain(type);
    }
    expect(doc).toContain('AAA 不是炸弹');
    expect(doc).toContain('KKKK 是最大炸弹');
    expect(doc).toContain('不得拆第 4 个三张');
    expect(doc).toContain('炸弹可以拆开使用');
  });

  it('过牌/胜负/保本/计分/超时口径都在', () => {
    expect(doc).toContain('首出时必须出牌，不能过牌');
    expect(doc).toContain('其余所有玩家都过牌后');
    expect(doc).toContain('出完手中所有牌');
    expect(doc).toContain('保本');
    expect(doc).toContain('剩余张数 × 底分 × 倍数');
    expect(doc).toContain('min(multiplierCap');
    expect(doc).toContain('2 人局不适用');
    expect(doc).toContain('超时');
    expect(doc).toContain('托管');
    expect(doc).toContain('最小的单张');
  });
});

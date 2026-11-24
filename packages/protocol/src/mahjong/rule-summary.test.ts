import { describe, expect, it } from 'vitest';
import {
  MAHJONG_BASE_SUMMARY,
  MAHJONG_DEFAULT_SCORING,
  MAHJONG_RULE_SUMMARY,
  MAHJONG_TIMEOUT_SECTION,
} from './rule-summary';

function sections(text: string): Array<{ title: string; lines: string[] }> {
  return text.split(/\n\n+/).map((raw) => {
    const lines = raw.split('\n');
    const title = lines[0]?.match(/^【(.+?)】$/)?.[1] ?? '';
    return { title, lines: lines.slice(1) };
  });
}

describe('MAHJONG_RULE_SUMMARY fallback', () => {
  it('恰含 5 段且每段非空', () => {
    const s = sections(MAHJONG_RULE_SUMMARY);
    expect(s.map((x) => x.title)).toEqual([
      '基本规则', '血战到底', '刮风下雨', '计分', '超时与托管',
    ]);
    for (const section of s) expect(section.lines.length, section.title).toBeGreaterThan(0);
  });

  it('base 段不含可被后台关闭的完整性断言', () => {
    expect(MAHJONG_BASE_SUMMARY).not.toContain('最后 4 张能胡必胡');
    expect(MAHJONG_BASE_SUMMARY).not.toContain('过水同张锁定');
    expect(MAHJONG_BASE_SUMMARY).not.toContain('直杠：点杠者付');
    expect(MAHJONG_BASE_SUMMARY).not.toContain('强胡时=胡');
  });

  it('默认计分段标注默认口径并提供默认流程', () => {
    expect(MAHJONG_DEFAULT_SCORING).toContain('默认口径');
    expect(MAHJONG_DEFAULT_SCORING).toContain('默认封顶 6 番');
    expect(MAHJONG_DEFAULT_SCORING).toContain('最后 4 张能胡必胡');
    expect(MAHJONG_DEFAULT_SCORING).toContain('直杠仅点杠者付 2×底');
  });

  it('超时段保留托管说明', () => {
    expect(MAHJONG_TIMEOUT_SECTION).toContain('超时与托管');
    expect(MAHJONG_TIMEOUT_SECTION).toContain('托管');
    expect(MAHJONG_TIMEOUT_SECTION).not.toContain('强胡时=胡');
  });
});

import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES } from './rules';
import { mahjongRulesClientView } from './client-view';
import { buildMahjongRuleSummary } from './rule-summary';

const chengdu = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);

describe('buildMahjongRuleSummary', () => {
  it('无参数 ⇒ 与 MAHJONG_RULE_SUMMARY 逐字相等', () => {
    expect(buildMahjongRuleSummary(undefined)).toBe(MAHJONG_RULE_SUMMARY);
  });

  it('默认成都：动态段替换默认计分，含封顶/主番/流程/未启用', () => {
    const text = buildMahjongRuleSummary(chengdu);
    expect(text).toContain('【番型与倍率】');
    expect(text).toContain('【当前流程设置】');
    expect(text).not.toContain('默认封顶 6 番');
    expect(text).toContain('封顶 6 番（×32）');
    expect(text).toContain('清七对 5 番（×16）');
    expect(text).toContain('未启用：');
    expect(text).toContain('最后 4 张：能胡必胡');
    const s = sections(text);
    expect(s.map((x) => x.title)).toEqual([
      '基本规则', '血战到底', '刮风下雨', '番型与倍率',
      '当前流程设置', '超时与托管',
    ]);
    for (const section of s) expect(section.lines.length, section.title).toBeGreaterThan(0);
  });

  it('自定义封顶 5 / 每杠 1 / 关龙七对 生效', () => {
    const view = {
      ...chengdu,
      fanCap: 5,
      fanTable: { ...chengdu.fanTable, longQiDui: 0 },
      optionalFans: { ...chengdu.optionalFans, perGang: 1 },
    };
    const text = buildMahjongRuleSummary(view);
    expect(text).toContain('封顶 5 番（×16）');
    expect(text).toContain('每杠 +1 番');
    expect(text).toContain('龙七对');
    expect(text).toMatch(/未启用：[^\n]*龙七对/);
  });

  it('加法口径只列加法表，并注明不使用可选番', () => {
    const text = buildMahjongRuleSummary(mahjongRulesClientView(DEFAULT_SBR_RULES));
    expect(text).toContain('计分方式：加法番表');
    expect(text).toContain('碰碰胡 +1 番');
    expect(text).toContain('加法口径不使用可选番');
    expect(text).not.toContain('清七对 5 番');
  });

  it('全 0 ⇒ 明确提示未配置任何番型', () => {
    const zero = { ...chengdu, fanTable: {}, optionalFans: { ...chengdu.optionalFans } };
    const text = buildMahjongRuleSummary(zero);
    expect(text).toContain('当前未配置任何番型');
    expect(text).not.toContain('清七对 5 番');
  });

  it('天胡/地胡值 > 0 但 wired=false ⇒ 只进预留列表', () => {
    const view = {
      ...chengdu,
      optionalFans: { ...chengdu.optionalFans, tianHu: 6, diHu: 6 },
    };
    const text = buildMahjongRuleSummary(view);
    expect(text).toContain('预留未启用：天胡、地胡');
    expect(text).not.toMatch(/· 天胡 \d+ 番/);
  });

  it('pingHu=0 ⇒ 明示引擎兜底 1 番，且不混进未启用列表', () => {
    const view = { ...chengdu, fanTable: { ...chengdu.fanTable, pingHu: 0 } };
    const text = buildMahjongRuleSummary(view);
    expect(text).toContain('平胡：表值为 0，但引擎仍按兜底 1 番处理');
    expect(text).not.toMatch(/未启用：[^\n]*平胡/);
  });

  it('起胡番 > 封顶 ⇒ 明示当前配置无法胡牌', () => {
    const view = { ...chengdu, minFanToHu: 6, fanCap: 5 };
    expect(buildMahjongRuleSummary(view)).toContain('当前配置无法胡牌');
  });

  it('主番表值 > 封顶 ⇒ 显示表值与封顶后倍率', () => {
    const view = {
      ...chengdu,
      fanCap: 5,
      fanTable: { ...chengdu.fanTable, qingYiSe: 8 },
    };
    expect(buildMahjongRuleSummary(view)).toContain('清一色 表值 8 番 / 封顶后 ×16');
  });

  it('自摸口径：addFan 读 ziMo；addBase 每家多付', () => {
    const addFan = {
      ...chengdu,
      selfDrawMode: 'addFan' as const,
      fanTable: { ...chengdu.fanTable, ziMo: 2 },
    };
    expect(buildMahjongRuleSummary(addFan)).toContain('自摸：番 +2');
    expect(buildMahjongRuleSummary(chengdu)).toContain('自摸：每家多付 1×底');
  });
});

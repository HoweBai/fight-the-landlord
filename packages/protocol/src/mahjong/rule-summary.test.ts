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

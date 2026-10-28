import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAHJONG_RULE_SUMMARY } from '@fight-the-landlord/protocol';
import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES } from './rules';

const doc = readFileSync(join(__dirname, '../../../../docs/games/mahjong.md'), 'utf8');

describe('mahjong doc-sync', () => {
  it('默认 chengdu：6 番/32×、换三张、平胡 1 番', () => {
    expect(DEFAULT_CHENGDU_RULES.fanCap).toBe(6);
    expect(DEFAULT_CHENGDU_RULES.exchangeThreeEnabled).toBe(true);
    expect(DEFAULT_CHENGDU_RULES.fanTable.pingHu).toBe(1);
    expect(doc).toContain('6 番 = 32×');
    expect(doc).toContain('平胡 = 1 番');
  });

  it('sbr：3 番/8 分、无换三张、花猪 burn48', () => {
    expect(DEFAULT_SBR_RULES.fanCap).toBe(3);
    expect(DEFAULT_SBR_RULES.exchangeThreeEnabled).toBe(false);
    expect(DEFAULT_SBR_RULES.huazhuMode).toBe('burn48');
    expect(doc).toContain('3 番 = 8 分');
    expect(doc).toContain('无换三张');
  });

  it('客户端文案包含关键口径', () => {
    expect(MAHJONG_RULE_SUMMARY).toContain('108 张');
    expect(MAHJONG_RULE_SUMMARY).toContain('血战到底');
    expect(MAHJONG_RULE_SUMMARY).toContain('定缺');
    expect(MAHJONG_RULE_SUMMARY).toContain('刮风下雨');
  });
});

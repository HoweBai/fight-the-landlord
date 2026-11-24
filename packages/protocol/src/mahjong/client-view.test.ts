import { describe, expect, it } from 'vitest';
import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES } from './rules';
import { MAHJONG_RULES_CLIENT_KEYS, mahjongRulesClientView } from './client-view';

describe('MahjongRulesClientView', () => {
  it('键集恰为显式白名单（不含内部调参）', () => {
    const view = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);
    expect(Object.keys(view).sort()).toEqual([...MAHJONG_RULES_CLIENT_KEYS].sort());
    for (const forbidden of [
      'preset', 'rulesVersion', 'claimWindowMs', 'exchangeWindowMs',
      'lackWindowMs', 'refundOnDraw', 'huazhuPayees', 'chajiaoAllSameState',
    ]) {
      expect(view).not.toHaveProperty(forbidden);
    }
  });

  it('成都默认值逐字段映射', () => {
    const view = mahjongRulesClientView(DEFAULT_CHENGDU_RULES);
    expect(view).toMatchObject({
      scoringPolicy: 'named', fanBase: 1, fanCap: 6,
      selfDrawMode: 'addBase', rootIncludesKong: false, minFanToHu: 0,
      exchangeThreeEnabled: true, exchangeDirection: 'random',
      lastFourForcedHu: true, passHuMode: 'sameTileOrHigherFan',
      directGangMode: 'contract', gangTransfer: 'toEachWinner',
      huazhuMode: 'payEach', chajiaoEnabled: true,
    });
    expect(view.fanTable.pingHu).toBe(1);
    expect(view.optionalFans.perGang).toBe(0);
  });

  it('SBR 默认值逐字段映射', () => {
    const view = mahjongRulesClientView(DEFAULT_SBR_RULES);
    expect(view.scoringPolicy).toBe('additive');
    expect(view.fanBase).toBe(0);
    expect(view.fanCap).toBe(3);
    expect(view.additiveFanTable.fullFlush).toBe(2);
  });
});

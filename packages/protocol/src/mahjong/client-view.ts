import type {
  MahjongDirectGangMode,
  MahjongExchangeDirection,
  MahjongGangTransfer,
  MahjongHuazhuMode,
  MahjongOptionalFans,
  MahjongPassHuMode,
  MahjongRulesConfig,
  MahjongScoringPolicy,
  MahjongSelfDrawMode,
} from './rules';

export interface MahjongRulesClientView {
  scoringPolicy: MahjongScoringPolicy;
  fanBase: 0 | 1;
  fanCap: number;
  fanTable: Record<string, number>;
  additiveFanTable: Record<string, number>;
  optionalFans: MahjongOptionalFans;
  rootIncludesKong: boolean;
  selfDrawMode: MahjongSelfDrawMode;
  minFanToHu: number;
  exchangeThreeEnabled: boolean;
  exchangeDirection: MahjongExchangeDirection;
  lastFourForcedHu: boolean;
  passHuMode: MahjongPassHuMode;
  directGangMode: MahjongDirectGangMode;
  gangTransfer: MahjongGangTransfer;
  huazhuMode: MahjongHuazhuMode;
  chajiaoEnabled: boolean;
}

export const MAHJONG_RULES_CLIENT_KEYS = [
  'scoringPolicy', 'fanBase', 'fanCap', 'fanTable', 'additiveFanTable',
  'optionalFans', 'rootIncludesKong', 'selfDrawMode', 'minFanToHu',
  'exchangeThreeEnabled', 'exchangeDirection', 'lastFourForcedHu',
  'passHuMode', 'directGangMode', 'gangTransfer', 'huazhuMode',
  'chajiaoEnabled',
] as const;

export function mahjongRulesClientView(rules: MahjongRulesConfig): MahjongRulesClientView {
  return {
    scoringPolicy: rules.scoringPolicy,
    fanBase: rules.fanBase,
    fanCap: rules.fanCap,
    fanTable: { ...rules.fanTable },
    additiveFanTable: { ...rules.additiveFanTable },
    optionalFans: { ...rules.optionalFans },
    rootIncludesKong: rules.rootIncludesKong,
    selfDrawMode: rules.selfDrawMode,
    minFanToHu: rules.minFanToHu,
    exchangeThreeEnabled: rules.exchangeThreeEnabled,
    exchangeDirection: rules.exchangeDirection,
    lastFourForcedHu: rules.lastFourForcedHu,
    passHuMode: rules.passHuMode,
    directGangMode: rules.directGangMode,
    gangTransfer: rules.gangTransfer,
    huazhuMode: rules.huazhuMode,
    chajiaoEnabled: rules.chajiaoEnabled,
  };
}

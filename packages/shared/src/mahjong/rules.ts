/**
 * 麻将规则默认值/校验的唯一实现 re-export。
 * 真源在 `packages/protocol/src/mahjong/rules.ts`：config-service 只依赖 protocol，
 * 不能反向依赖 shared；shared 这里只做稳定导入路径。
 */
export {
  DEFAULT_CHENGDU_RULES,
  DEFAULT_SBR_RULES,
  MAHJONG_ADDITIVE_FAN_KEYS,
  MAHJONG_NAMED_FAN_KEYS,
  MAHJONG_OPTIONAL_FAN_KEYS,
  mahjongRulesPreset,
  parseMahjongRules,
} from '@fight-the-landlord/protocol';
export type {
  MahjongChajiaoAllSameState,
  MahjongDirectGangMode,
  MahjongExchangeDirection,
  MahjongGangTransfer,
  MahjongHuazhuMode,
  MahjongHuazhuPayees,
  MahjongOptionalFans,
  MahjongPassHuMode,
  MahjongPreset,
  MahjongRefundOnDraw,
  MahjongRulesConfig,
  MahjongRulesPublic,
  MahjongScoringPolicy,
  MahjongSelfDrawMode,
} from '@fight-the-landlord/protocol';

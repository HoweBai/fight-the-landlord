/**
 * 麻将规则快照（协议层类型；默认值/校验在 `shared/mahjong/rules.ts`）。
 *
 * 一个 JSON 配置键 `game.mahjong.rules` 存 preset + 逐项覆盖；开局展开成此完整快照。
 * 字段名不得叫 `rules` 出站；视图用 `mahjongRules`。
 */

export type MahjongPreset = 'chengdu' | 'sbr';
export type MahjongScoringPolicy = 'named' | 'additive';
export type MahjongSelfDrawMode = 'addBase' | 'addFan' | 'addPoint' | 'none';
export type MahjongExchangeDirection = 'random' | 'clockwise' | 'counterclockwise' | 'opposite';
export type MahjongDirectGangMode = 'contract' | 'everyone';
export type MahjongGangTransfer = 'none' | 'toEachWinner' | 'split';
export type MahjongRefundOnDraw = 'nonReadyAll' | 'kongDeclarerOnly';
export type MahjongHuazhuMode = 'payEach' | 'burn48' | 'off';
export type MahjongHuazhuPayees = 'active' | 'nonFlowerPig';
export type MahjongChajiaoAllSameState = 'none' | 'pay';
export type MahjongPassHuMode = 'off' | 'sameTile' | 'sameTileOrHigherFan';

export interface MahjongOptionalFans {
  /** 断幺九：胡牌时没有 1/9。 */
  duanYaoJiu: number;
  /** 海底：最后一张自摸/最后一张弃牌被胡。 */
  haiDi: number;
  /** 每杠：胡牌者每有一杠。 */
  perGang: number;
  /** 双龙七对（七对含 2 个四张）。 */
  shuangLong: number;
  /** 三龙七对。 */
  sanLong: number;
  /** 十八罗汉（4 杠 + 将）。 */
  shiBaLuoHan: number;
  /** 天胡。 */
  tianHu: number;
  /** 地胡。 */
  diHu: number;
}

export interface MahjongRulesConfig {
  preset: MahjongPreset;
  /** 快照版本，只进记录/outbox 指纹，不进 game.start 拒绝条件。 */
  rulesVersion: number;

  scoringPolicy: MahjongScoringPolicy;
  /** 平胡对应的番底：chengdu=1（2^(fan-1)），sbr=0（2^fan）。 */
  fanBase: 0 | 1;
  /** 封顶番；chengdu 默认 6（32×），sbr 3（8 分）。 */
  fanCap: number;
  /** 命名番值（chengdu）。 */
  fanTable: Record<string, number>;
  /** 叠加番值（sbr）。 */
  additiveFanTable: Record<string, number>;
  /** 根是否含杠；chengdu=false，sbr=true。 */
  rootIncludesKong: boolean;
  selfDrawMode: MahjongSelfDrawMode;
  /** 起胡番；0 = 不限制，3 = 三番起胡。 */
  minFanToHu: number;

  exchangeThreeEnabled: boolean;
  exchangeDirection: MahjongExchangeDirection;
  lastFourForcedHu: boolean;
  passHuMode: MahjongPassHuMode;

  directGangMode: MahjongDirectGangMode;
  gangTransfer: MahjongGangTransfer;
  refundOnDraw: MahjongRefundOnDraw;
  huazhuMode: MahjongHuazhuMode;
  huazhuPayees: MahjongHuazhuPayees;
  chajiaoEnabled: boolean;
  chajiaoAllSameState: MahjongChajiaoAllSameState;

  optionalFans: MahjongOptionalFans;

  claimWindowMs: number;
  exchangeWindowMs: number;
  lackWindowMs: number;
}

/** 视图公开的规则快照；当前与完整快照同形（无密钥字段）。 */
export type MahjongRulesPublic = MahjongRulesConfig;

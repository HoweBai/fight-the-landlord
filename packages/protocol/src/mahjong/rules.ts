/**
 * 麻将规则快照（协议层唯一定义 + 默认值/严格校验）。
 *
 * 放在 protocol 是硬约束：config-service 的写入口只依赖 protocol，不能 import shared。
 * shared 只 re-export 这里的 parser/defaults。
 */
import { ProtocolError } from '../validate';

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
  duanYaoJiu: number;
  haiDi: number;
  perGang: number;
  shuangLong: number;
  sanLong: number;
  shiBaLuoHan: number;
  tianHu: number;
  diHu: number;
}

export interface MahjongRulesConfig {
  preset: MahjongPreset;
  rulesVersion: number;

  scoringPolicy: MahjongScoringPolicy;
  fanBase: 0 | 1;
  fanCap: number;
  fanTable: Record<string, number>;
  additiveFanTable: Record<string, number>;
  rootIncludesKong: boolean;
  selfDrawMode: MahjongSelfDrawMode;
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

export type MahjongRulesPublic = MahjongRulesConfig;

export const MAHJONG_NAMED_FAN_KEYS = [
  'pingHu',
  'duiDuiHu',
  'qingYiSe',
  'daiYaoJiu',
  'qiDui',
  'qingDui',
  'jiangDui',
  'longQiDui',
  'qingQiDui',
  'qingYaoJiu',
  'qingLongQiDui',
  'gangShangHua',
  'gangShangPao',
  'qiangGangHu',
  'jinGouDiao',
  'gen',
  'ziMo',
] as const;

export const MAHJONG_ADDITIVE_FAN_KEYS = [
  'root',
  'allPungs',
  'goldenWait',
  'fullFlush',
  'sevenPairs',
  'winAfterKong',
  'shootAfterKong',
  'robbingKong',
  'underTheSea',
] as const;

export const MAHJONG_OPTIONAL_FAN_KEYS = [
  'duanYaoJiu',
  'haiDi',
  'perGang',
  'shuangLong',
  'sanLong',
  'shiBaLuoHan',
  'tianHu',
  'diHu',
] as const;

const zeroOptionalFans: MahjongOptionalFans = {
  duanYaoJiu: 0,
  haiDi: 0,
  perGang: 0,
  shuangLong: 0,
  sanLong: 0,
  shiBaLuoHan: 0,
  tianHu: 0,
  diHu: 0,
};

const chengduFanTable: Record<string, number> = {
  pingHu: 1,
  duiDuiHu: 2,
  qingYiSe: 3,
  daiYaoJiu: 3,
  qiDui: 3,
  qingDui: 4,
  jiangDui: 4,
  longQiDui: 5,
  qingQiDui: 5,
  qingYaoJiu: 5,
  qingLongQiDui: 6,
  gangShangHua: 1,
  gangShangPao: 1,
  qiangGangHu: 1,
  jinGouDiao: 1,
  gen: 1,
  ziMo: 1,
};

const sbrAdditiveFanTable: Record<string, number> = {
  root: 1,
  allPungs: 1,
  goldenWait: 1,
  fullFlush: 2,
  sevenPairs: 2,
  winAfterKong: 1,
  shootAfterKong: 1,
  robbingKong: 1,
  underTheSea: 1,
};

export const DEFAULT_CHENGDU_RULES: Readonly<MahjongRulesConfig> = Object.freeze({
  preset: 'chengdu',
  rulesVersion: 1,
  scoringPolicy: 'named',
  fanBase: 1,
  fanCap: 6,
  fanTable: Object.freeze({ ...chengduFanTable }) as Record<string, number>,
  additiveFanTable: Object.freeze({}) as Record<string, number>,
  rootIncludesKong: false,
  selfDrawMode: 'addBase',
  minFanToHu: 0,
  exchangeThreeEnabled: true,
  exchangeDirection: 'random',
  lastFourForcedHu: true,
  passHuMode: 'sameTileOrHigherFan',
  directGangMode: 'contract',
  gangTransfer: 'toEachWinner',
  refundOnDraw: 'nonReadyAll',
  huazhuMode: 'payEach',
  huazhuPayees: 'active',
  chajiaoEnabled: true,
  chajiaoAllSameState: 'pay',
  optionalFans: Object.freeze({ ...zeroOptionalFans }) as MahjongOptionalFans,
  claimWindowMs: 5000,
  exchangeWindowMs: 15000,
  lackWindowMs: 15000,
});

export const DEFAULT_SBR_RULES: Readonly<MahjongRulesConfig> = Object.freeze({
  preset: 'sbr',
  rulesVersion: 1,
  scoringPolicy: 'additive',
  fanBase: 0,
  fanCap: 3,
  fanTable: Object.freeze({}) as Record<string, number>,
  additiveFanTable: Object.freeze({ ...sbrAdditiveFanTable }) as Record<string, number>,
  rootIncludesKong: true,
  selfDrawMode: 'addPoint',
  minFanToHu: 0,
  exchangeThreeEnabled: false,
  exchangeDirection: 'random',
  lastFourForcedHu: true,
  passHuMode: 'sameTile',
  directGangMode: 'contract',
  gangTransfer: 'none',
  refundOnDraw: 'kongDeclarerOnly',
  huazhuMode: 'burn48',
  huazhuPayees: 'active',
  chajiaoEnabled: true,
  chajiaoAllSameState: 'none',
  optionalFans: Object.freeze({ ...zeroOptionalFans }) as MahjongOptionalFans,
  claimWindowMs: 5000,
  exchangeWindowMs: 15000,
  lackWindowMs: 15000,
});

const TOP_KEYS = new Set<string>([
  'preset',
  'rulesVersion',
  'scoringPolicy',
  'fanBase',
  'fanCap',
  'fanTable',
  'additiveFanTable',
  'rootIncludesKong',
  'selfDrawMode',
  'minFanToHu',
  'exchangeThreeEnabled',
  'exchangeDirection',
  'lastFourForcedHu',
  'passHuMode',
  'directGangMode',
  'gangTransfer',
  'refundOnDraw',
  'huazhuMode',
  'huazhuPayees',
  'chajiaoEnabled',
  'chajiaoAllSameState',
  'optionalFans',
  'claimWindowMs',
  'exchangeWindowMs',
  'lackWindowMs',
]);

const BOOLEAN_KEYS = [
  'rootIncludesKong',
  'exchangeThreeEnabled',
  'lastFourForcedHu',
  'chajiaoEnabled',
] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function intIn(key: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ProtocolError(`${key} 必须是 ${min}..${max} 的整数（收到 ${JSON.stringify(v)}）`);
  }
  return v;
}

function oneOf<T extends string>(key: string, v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new ProtocolError(`${key} 必须是 ${values.join(' | ')} 之一（收到 ${JSON.stringify(v)}）`);
  }
  return v as T;
}

function fanTableOf(key: string, v: unknown, allowed: readonly string[]): Record<string, number> {
  if (!isObj(v)) throw new ProtocolError(`${key} 必须是对象`);
  const out: Record<string, number> = {};
  for (const [fanKey, value] of Object.entries(v)) {
    if (!allowed.includes(fanKey)) throw new ProtocolError(`${key} 含未知番种 "${fanKey}"`);
    out[fanKey] = intIn(`${key}.${fanKey}`, value, 0, 20);
  }
  return out;
}

/**
 * 合并 preset 默认值并严格校验；未知键/越界 ⇒ `ProtocolError`。
 * `undefined`/`null` ⇒ chengdu 默认副本（旧配置缺段）。
 */
export function parseMahjongRules(input: unknown): MahjongRulesConfig {
  if (input === undefined || input === null) return clone(DEFAULT_CHENGDU_RULES);
  if (!isObj(input)) throw new ProtocolError('mahjongRules must be an object');
  const preset = input.preset === undefined ? 'chengdu' : oneOf('preset', input.preset, ['chengdu', 'sbr'] as const);
  const out = clone(
    preset === 'sbr' ? DEFAULT_SBR_RULES : DEFAULT_CHENGDU_RULES,
  ) as MahjongRulesConfig;
  out.preset = preset;

  for (const key of Object.keys(input)) {
    if (key === 'preset') continue;
    if (!TOP_KEYS.has(key)) throw new ProtocolError(`mahjongRules contains unknown key "${key}"`);
  }
  for (const key of BOOLEAN_KEYS) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new ProtocolError(`mahjongRules.${key} must be a boolean`);
    out[key] = v;
  }
  if (input.rulesVersion !== undefined) {
    out.rulesVersion = intIn('mahjongRules.rulesVersion', input.rulesVersion, 1, 1_000_000_000);
  }
  if (input.scoringPolicy !== undefined) {
    out.scoringPolicy = oneOf('mahjongRules.scoringPolicy', input.scoringPolicy, ['named', 'additive'] as const);
  }
  if (input.fanBase !== undefined) {
    const v = input.fanBase;
    if (v !== 0 && v !== 1) throw new ProtocolError('mahjongRules.fanBase must be 0 or 1');
    out.fanBase = v;
  }
  if (input.fanCap !== undefined) out.fanCap = intIn('mahjongRules.fanCap', input.fanCap, 1, 8);
  if (input.fanTable !== undefined) {
    out.fanTable = { ...out.fanTable, ...fanTableOf('mahjongRules.fanTable', input.fanTable, MAHJONG_NAMED_FAN_KEYS) };
  }
  if (input.additiveFanTable !== undefined) {
    out.additiveFanTable = {
      ...out.additiveFanTable,
      ...fanTableOf('mahjongRules.additiveFanTable', input.additiveFanTable, MAHJONG_ADDITIVE_FAN_KEYS),
    };
  }
  if (input.selfDrawMode !== undefined) {
    out.selfDrawMode = oneOf('mahjongRules.selfDrawMode', input.selfDrawMode, [
      'addBase', 'addFan', 'addPoint', 'none',
    ] as const);
  }
  if (input.minFanToHu !== undefined) out.minFanToHu = intIn('mahjongRules.minFanToHu', input.minFanToHu, 0, 6);
  if (input.exchangeDirection !== undefined) {
    out.exchangeDirection = oneOf('mahjongRules.exchangeDirection', input.exchangeDirection, [
      'random', 'clockwise', 'counterclockwise', 'opposite',
    ] as const);
  }
  if (input.passHuMode !== undefined) {
    out.passHuMode = oneOf('mahjongRules.passHuMode', input.passHuMode, [
      'off', 'sameTile', 'sameTileOrHigherFan',
    ] as const);
  }
  if (input.directGangMode !== undefined) {
    out.directGangMode = oneOf('mahjongRules.directGangMode', input.directGangMode, ['contract', 'everyone'] as const);
  }
  if (input.gangTransfer !== undefined) {
    out.gangTransfer = oneOf('mahjongRules.gangTransfer', input.gangTransfer, [
      'none', 'toEachWinner', 'split',
    ] as const);
  }
  if (input.refundOnDraw !== undefined) {
    out.refundOnDraw = oneOf('mahjongRules.refundOnDraw', input.refundOnDraw, [
      'nonReadyAll', 'kongDeclarerOnly',
    ] as const);
  }
  if (input.huazhuMode !== undefined) {
    out.huazhuMode = oneOf('mahjongRules.huazhuMode', input.huazhuMode, ['payEach', 'burn48', 'off'] as const);
  }
  if (input.huazhuPayees !== undefined) {
    out.huazhuPayees = oneOf('mahjongRules.huazhuPayees', input.huazhuPayees, ['active', 'nonFlowerPig'] as const);
  }
  if (input.chajiaoAllSameState !== undefined) {
    out.chajiaoAllSameState = oneOf('mahjongRules.chajiaoAllSameState', input.chajiaoAllSameState, [
      'none', 'pay',
    ] as const);
  }
  if (input.optionalFans !== undefined) {
    const fans = fanTableOf('mahjongRules.optionalFans', input.optionalFans, MAHJONG_OPTIONAL_FAN_KEYS);
    out.optionalFans = { ...out.optionalFans, ...fans } as MahjongOptionalFans;
  }
  for (const key of ['claimWindowMs', 'exchangeWindowMs', 'lackWindowMs'] as const) {
    const v = input[key];
    if (v !== undefined) out[key] = intIn(`mahjongRules.${key}`, v, 1000, 60_000);
  }
  return out;
}

export function mahjongRulesPreset(preset: MahjongPreset): MahjongRulesConfig {
  return clone(preset === 'sbr' ? DEFAULT_SBR_RULES : DEFAULT_CHENGDU_RULES) as MahjongRulesConfig;
}

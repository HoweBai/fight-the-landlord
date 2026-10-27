/**
 * 计分策略：
 * - `named`（成都）：取单一最高命名番 + 另加番；被取代的组成番不相加。
 * - `additive`（SBR）：规范特征逐项相加，3 番封顶。
 *
 * 多分解取最终番最大者；并列用固定优先级，保证真人/机器人/回放同结果。
 */
import {
  ProtocolError,
  type MahjongMeldView,
  type MahjongRulesConfig,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';
import { huDecompositions } from './hu';
import { deriveFeatures, type HandFeatures, type HuContext } from './features';

export interface ScoreItem {
  name: string;
  fan: number;
}

export interface ScoreResult {
  fan: number;
  multiplier: number;
  items: string[];
  baseName: string;
  /** 自摸加底/加分的“每付款人额外 1×底”标记（0/1）。 */
  selfDrawBonusBase: number;
  features: HandFeatures;
}

/** 并列主番的固定优先级（越靠前越优先）。 */
export const NAMED_PRIORITY = [
  'qingLongQiDui',
  'qingQiDui',
  'qingYaoJiu',
  'longQiDui',
  'qingDui',
  'jiangDui',
  'qingYiSe',
  'daiYaoJiu',
  'qiDui',
  'duiDuiHu',
  'pingHu',
  'tianHu',
  'diHu',
  'shuangLong',
  'sanLong',
  'shiBaLuoHan',
] as const;

const NAMED_LABELS: Record<string, string> = {
  pingHu: '平胡',
  duiDuiHu: '对对胡',
  qingYiSe: '清一色',
  daiYaoJiu: '带幺九',
  qiDui: '七对',
  qingDui: '清对',
  jiangDui: '将对',
  longQiDui: '龙七对',
  qingQiDui: '清七对',
  qingYaoJiu: '清幺九',
  qingLongQiDui: '清龙七对',
  tianHu: '天胡',
  diHu: '地胡',
  shuangLong: '双龙七对',
  sanLong: '三龙七对',
  shiBaLuoHan: '十八罗汉',
  gangShangHua: '杠上花',
  gangShangPao: '杠上炮',
  qiangGangHu: '抢杠胡',
  jinGouDiao: '金钩钓',
  gen: '根',
  ziMo: '自摸',
  duanYaoJiu: '断幺九',
  haiDi: '海底',
  perGang: '每杠',
};

function label(key: string): string {
  return NAMED_LABELS[key] ?? key;
}

function tableValue(table: Record<string, number>, key: string): number {
  return Number.isFinite(table[key]) ? (table[key] as number) : 0;
}

function push(items: ScoreItem[], name: string, fan: number): void {
  if (fan > 0) items.push({ name, fan });
}

function namedBase(features: HandFeatures, rules: MahjongRulesConfig): ScoreItem {
  const t = rules.fanTable;
  const candidates: ScoreItem[] = [];
  const add = (name: string, fan: number): void => {
    if (fan > 0) candidates.push({ name, fan });
  };
  add('pingHu', tableValue(t, 'pingHu'));
  if (features.allPungs) add('duiDuiHu', tableValue(t, 'duiDuiHu'));
  if (features.fullFlush) add('qingYiSe', tableValue(t, 'qingYiSe'));
  if (features.terminals) add('daiYaoJiu', tableValue(t, 'daiYaoJiu'));
  if (features.sevenPairs) add('qiDui', tableValue(t, 'qiDui'));
  if (features.fullFlush && features.allPungs) add('qingDui', tableValue(t, 'qingDui'));
  if (features.allPungs && features.all258) add('jiangDui', tableValue(t, 'jiangDui'));
  if (features.sevenPairs && features.rootCount >= 1) add('longQiDui', tableValue(t, 'longQiDui'));
  if (features.fullFlush && features.sevenPairs) add('qingQiDui', tableValue(t, 'qingQiDui'));
  if (features.fullFlush && features.terminals) add('qingYaoJiu', tableValue(t, 'qingYaoJiu'));
  if (features.fullFlush && features.sevenPairs && features.rootCount >= 1) {
    add('qingLongQiDui', tableValue(t, 'qingLongQiDui'));
  }

  const opt = rules.optionalFans;
  if (opt.shuangLong > 0 && features.sevenPairs && features.rootCount >= 2) {
    add('shuangLong', opt.shuangLong);
  }
  if (opt.sanLong > 0 && features.sevenPairs && features.rootCount >= 3) {
    add('sanLong', opt.sanLong);
  }
  if (opt.shiBaLuoHan > 0 && features.allPungs && features.kongCount >= 4) {
    add('shiBaLuoHan', opt.shiBaLuoHan);
  }
  if (opt.tianHu > 0 && features.context.tianHu) add('tianHu', opt.tianHu);
  if (opt.diHu > 0 && features.context.diHu) add('diHu', opt.diHu);

  const priority = (name: string): number => {
    const idx = NAMED_PRIORITY.indexOf(name as (typeof NAMED_PRIORITY)[number]);
    return idx < 0 ? NAMED_PRIORITY.length : idx;
  };
  const sorted = candidates.sort(
    (a, b) => b.fan - a.fan || priority(a.name) - priority(b.name) || a.name.localeCompare(b.name),
  );
  return sorted[0] ?? { name: 'pingHu', fan: Math.max(1, rules.fanBase) };
}

function scoreNamed(features: HandFeatures, rules: MahjongRulesConfig): ScoreResult {
  const base = namedBase(features, rules);
  const items: ScoreItem[] = [base];
  let fan = base.fan;
  const t = rules.fanTable;
  const ctx = features.context;

  if (base.name === 'tianHu' || base.name === 'diHu') {
    const capped = Math.min(rules.fanCap, fan);
    return {
      fan: capped,
      multiplier: 2 ** Math.max(0, capped - rules.fanBase),
      items: [`${label(base.name)}+${base.fan}`],
      baseName: base.name,
      selfDrawBonusBase: 0,
      features,
    };
  }

  if (ctx.winAfterKong) {
    const v = tableValue(t, 'gangShangHua');
    fan += v;
    push(items, 'gangShangHua', v);
  }
  if (ctx.shootAfterKong) {
    const v = tableValue(t, 'gangShangPao');
    fan += v;
    push(items, 'gangShangPao', v);
  }
  if (ctx.robbingKong) {
    const v = tableValue(t, 'qiangGangHu');
    fan += v;
    push(items, 'qiangGangHu', v);
  }
  if (features.goldenWait) {
    const v = tableValue(t, 'jinGouDiao');
    fan += v;
    push(items, 'jinGouDiao', v);
  }

  const longBase = base.name === 'longQiDui' || base.name === 'qingLongQiDui';
  const rootsForFan = Math.max(0, features.rootCount - (longBase ? 1 : 0));
  const genFan = tableValue(t, 'gen') * rootsForFan;
  fan += genFan;
  push(items, 'gen', genFan);

  if (ctx.selfDraw && rules.selfDrawMode === 'addFan') {
    const v = tableValue(t, 'ziMo');
    fan += v;
    push(items, 'ziMo', v);
  }
  if (!features.hasTerminalTile) {
    const v = rules.optionalFans.duanYaoJiu;
    fan += v;
    push(items, 'duanYaoJiu', v);
  }
  if (ctx.underTheSea) {
    const v = rules.optionalFans.haiDi;
    fan += v;
    push(items, 'haiDi', v);
  }
  if (features.kongCount > 0) {
    const v = rules.optionalFans.perGang * features.kongCount;
    fan += v;
    push(items, 'perGang', v);
  }

  const capped = Math.min(rules.fanCap, fan);
  const selfDrawBonusBase =
    ctx.selfDraw && (rules.selfDrawMode === 'addBase' || rules.selfDrawMode === 'addPoint') ? 1 : 0;
  return {
    fan: capped,
    multiplier: 2 ** Math.max(0, capped - rules.fanBase),
    items: items.map((i) => `${label(i.name)}+${i.fan}`),
    baseName: base.name,
    selfDrawBonusBase,
    features,
  };
}

function scoreAdditive(features: HandFeatures, rules: MahjongRulesConfig): ScoreResult {
  const t = rules.additiveFanTable;
  const items: ScoreItem[] = [];
  let fan = 0;
  const add = (key: string, n: number): void => {
    const v = tableValue(t, key) * n;
    fan += v;
    push(items, key, v);
  };
  add('root', features.rootCount);
  if (features.allPungs) add('allPungs', 1);
  if (features.goldenWait) add('goldenWait', 1);
  if (features.fullFlush) add('fullFlush', 1);
  if (features.sevenPairs) add('sevenPairs', 1);
  if (features.context.winAfterKong) add('winAfterKong', 1);
  if (features.context.shootAfterKong) add('shootAfterKong', 1);
  if (features.context.robbingKong) add('robbingKong', 1);
  if (features.context.underTheSea) add('underTheSea', 1);

  if (features.context.selfDraw && rules.selfDrawMode === 'addFan') {
    const v = tableValue(rules.fanTable, 'ziMo');
    fan += v;
    push(items, 'ziMo', v);
  }
  const capped = Math.min(rules.fanCap, fan);
  const selfDrawBonusBase =
    features.context.selfDraw &&
    (rules.selfDrawMode === 'addBase' || rules.selfDrawMode === 'addPoint')
      ? 1
      : 0;
  return {
    fan: capped,
    multiplier: 2 ** Math.max(0, capped - rules.fanBase),
    items: items.map((i) => `${label(i.name)}+${i.fan}`),
    baseName: 'sbr',
    selfDrawBonusBase,
    features,
  };
}

export function scoreFeatures(features: HandFeatures, rules: MahjongRulesConfig): ScoreResult {
  return rules.scoringPolicy === 'additive'
    ? scoreAdditive(features, rules)
    : scoreNamed(features, rules);
}

/** 多分解取最优；并列按 items 字典序稳定裁决。 */
export function scoreBestHand(input: {
  hand: readonly Tile[];
  melds: readonly MahjongMeldView[];
  lackSuit: MahjongSuit;
  winningTile: Tile;
  context: HuContext;
  rules: MahjongRulesConfig;
}): ScoreResult {
  const decomps = huDecompositions(input.hand, input.melds, input.lackSuit);
  if (decomps.length === 0) throw new ProtocolError('手牌不是合法胡牌型');
  let best: ScoreResult | undefined;
  for (const d of decomps) {
    const features = deriveFeatures(
      input.hand,
      input.melds,
      d,
      input.winningTile,
      input.context,
      input.rules.rootIncludesKong,
    );
    const score = scoreFeatures(features, input.rules);
    if (
      best === undefined ||
      score.fan > best.fan ||
      (score.fan === best.fan && score.multiplier > best.multiplier) ||
      (score.fan === best.fan &&
        score.multiplier === best.multiplier &&
        score.items.join('|') < best.items.join('|'))
    ) {
      best = score;
    }
  }
  return best!;
}

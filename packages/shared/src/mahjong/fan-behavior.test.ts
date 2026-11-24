import { describe, expect, it } from 'vitest';
import type {
  MahjongMeldView, MahjongRulesConfig, Tile,
} from '@fight-the-landlord/protocol';
import { DEFAULT_CHENGDU_RULES, DEFAULT_SBR_RULES } from './rules';
import { EMPTY_HU_CONTEXT, type HuContext } from './features';
import { scoreBestHand } from './scoring';
import {
  MAHJONG_ADDITIVE_FAN_KEYS,
  MAHJONG_FAN_INFO,
  MAHJONG_NAMED_FAN_KEYS,
  MAHJONG_OPTIONAL_FAN_KEYS,
} from '@fight-the-landlord/protocol';
import { huContext } from './claims';
import type { MahjongSession } from './session';

const t = (s: 0 | 1 | 2, r: number): Tile => ({ s, r });
const T = (s: 0 | 1 | 2, ranks: number[]): Tile[] => ranks.map((r) => t(s, r));

interface Case {
  key: string;
  hand: Tile[];
  melds?: MahjongMeldView[];
  lack?: 0 | 1 | 2;
  winning?: Tile;
  context?: HuContext;
  rules?: MahjongRulesConfig;
  expectedBase?: string;
  expectedItem?: string;
}

const gang = (s: 0 | 1 | 2, r: number, fromSeat = 1): MahjongMeldView => ({
  kind: 'gang', tiles: [t(s, r), t(s, r), t(s, r), t(s, r)], fromSeat,
});

const plainHand = [...T(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3]), t(1, 5), t(1, 5)];
const pungsHand = [...T(0, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]), t(1, 5), t(1, 5)];
const flushHand = [...T(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4]), t(0, 5), t(0, 5)];
const sevenPairsHand = [...T(0, [1, 1, 2, 2, 3, 3]), ...T(1, [4, 4, 5, 5, 6, 6, 7, 7])];
const dragonPairsHand = [...T(0, [1, 1, 1, 1, 2, 2, 3, 3]), ...T(1, [4, 4, 5, 5, 6, 6])];
const noTerminalsHand = [
  ...T(0, [2, 3, 4, 5, 6, 7]), ...T(1, [3, 4, 5, 6, 7, 8]), t(1, 5), t(1, 5),
];

const withOptional = (
  base: MahjongRulesConfig,
  patch: Partial<MahjongRulesConfig['optionalFans']>,
  fanCap = base.fanCap,
): MahjongRulesConfig => ({
  ...base,
  fanCap,
  optionalFans: { ...base.optionalFans, ...patch },
});

const CASES: Case[] = [
  { key: 'pingHu', hand: plainHand, expectedBase: 'pingHu' },
  { key: 'duiDuiHu', hand: pungsHand, winning: t(0, 4), expectedBase: 'duiDuiHu' },
  { key: 'qingYiSe', hand: flushHand, lack: 1, expectedBase: 'qingYiSe' },
  {
    key: 'daiYaoJiu', lack: 2, expectedBase: 'daiYaoJiu',
    hand: [...T(0, [1, 2, 3, 7, 8, 9]), ...T(1, [1, 1, 1, 9, 9, 9]), t(0, 9), t(0, 9)],
  },
  { key: 'qiDui', hand: sevenPairsHand, expectedBase: 'qiDui' },
  {
    key: 'qingDui', lack: 2, expectedBase: 'qingDui',
    hand: [...T(0, [1, 1, 1, 3, 3, 3, 5, 5, 5, 7, 7, 7]), t(0, 9), t(0, 9)],
  },
  {
    key: 'jiangDui', lack: 2, expectedBase: 'jiangDui',
    hand: [...T(0, [2, 2, 2, 5, 5, 5, 8, 8, 8]), ...T(1, [2, 2, 2]), t(1, 5), t(1, 5)],
  },
  { key: 'longQiDui', hand: dragonPairsHand, expectedBase: 'longQiDui' },
  {
    key: 'qingQiDui', lack: 2, expectedBase: 'qingQiDui',
    hand: [...T(0, [1, 1, 2, 2, 3, 3, 5, 5, 7, 7, 8, 8, 9, 9])],
  },
  {
    key: 'qingYaoJiu', lack: 2, expectedBase: 'qingYaoJiu',
    hand: [...T(0, [1, 2, 3, 1, 2, 3, 7, 8, 9, 7, 8, 9, 1, 1])],
  },
  {
    key: 'qingLongQiDui', lack: 2, expectedBase: 'qingLongQiDui',
    hand: [...T(0, [1, 1, 2, 2, 3, 3, 5, 5, 5, 5, 7, 7, 9, 9])],
  },
  {
    key: 'gangShangHua', hand: plainHand, expectedItem: '杠上花',
    context: { ...EMPTY_HU_CONTEXT, selfDraw: true, winAfterKong: true },
  },
  {
    key: 'gangShangPao', hand: plainHand, expectedItem: '杠上炮',
    context: { ...EMPTY_HU_CONTEXT, shootAfterKong: true },
  },
  {
    key: 'qiangGangHu', hand: plainHand, expectedItem: '抢杠胡',
    context: { ...EMPTY_HU_CONTEXT, robbingKong: true },
  },
  {
    key: 'jinGouDiao', lack: 2, expectedItem: '金钩钓',
    hand: [...T(0, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]), t(1, 5), t(1, 5)],
    winning: t(1, 5),
  },
  {
    key: 'gen', lack: 2, expectedItem: '根',
    hand: [...T(0, [1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9]), t(1, 5), t(1, 5)],
  },
  {
    key: 'ziMo', hand: plainHand, expectedItem: '自摸',
    rules: {
      ...DEFAULT_CHENGDU_RULES,
      selfDrawMode: 'addFan',
      fanTable: { ...DEFAULT_CHENGDU_RULES.fanTable, ziMo: 1 },
    },
    context: { ...EMPTY_HU_CONTEXT, selfDraw: true },
  },

  // 加法口径
  { key: 'root', hand: [...T(0, [1, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9]), t(1, 5), t(1, 5)], lack: 2, rules: DEFAULT_SBR_RULES, expectedItem: '根（每组）' },
  { key: 'allPungs', hand: pungsHand, winning: t(0, 4), rules: DEFAULT_SBR_RULES, expectedItem: '碰碰胡' },
  { key: 'goldenWait', hand: pungsHand, winning: t(1, 5), rules: DEFAULT_SBR_RULES, expectedItem: '金钩钓' },
  { key: 'fullFlush', hand: flushHand, lack: 1, rules: DEFAULT_SBR_RULES, expectedItem: '清一色' },
  { key: 'sevenPairs', hand: sevenPairsHand, rules: DEFAULT_SBR_RULES, expectedItem: '七对' },
  { key: 'winAfterKong', hand: plainHand, rules: DEFAULT_SBR_RULES, context: { ...EMPTY_HU_CONTEXT, selfDraw: true, winAfterKong: true }, expectedItem: '杠上花' },
  { key: 'shootAfterKong', hand: plainHand, rules: DEFAULT_SBR_RULES, context: { ...EMPTY_HU_CONTEXT, shootAfterKong: true }, expectedItem: '杠上炮' },
  { key: 'robbingKong', hand: plainHand, rules: DEFAULT_SBR_RULES, context: { ...EMPTY_HU_CONTEXT, robbingKong: true }, expectedItem: '抢杠胡' },
  { key: 'underTheSea', hand: plainHand, rules: DEFAULT_SBR_RULES, context: { ...EMPTY_HU_CONTEXT, underTheSea: true }, expectedItem: '海底' },

  // 可选番
  { key: 'duanYaoJiu', hand: noTerminalsHand, lack: 2, rules: withOptional(DEFAULT_CHENGDU_RULES, { duanYaoJiu: 1 }), expectedItem: '断幺九' },
  { key: 'haiDi', hand: plainHand, rules: withOptional(DEFAULT_CHENGDU_RULES, { haiDi: 1 }), context: { ...EMPTY_HU_CONTEXT, underTheSea: true }, expectedItem: '海底' },
  {
    key: 'perGang', melds: [gang(0, 1)], lack: 2,
    hand: [...T(0, [2, 3, 4, 5, 6, 7, 7, 8, 9]), t(1, 5), t(1, 5)],
    rules: withOptional(DEFAULT_CHENGDU_RULES, { perGang: 1 }),
    expectedItem: '每杠',
  },
  {
    key: 'shuangLong', lack: 2, expectedBase: 'shuangLong',
    hand: [...T(0, [1, 1, 1, 1, 2, 2, 2, 2]), ...T(1, [3, 3, 4, 4, 5, 5])],
    rules: withOptional(DEFAULT_CHENGDU_RULES, { shuangLong: 8 }, 8),
  },
  {
    key: 'sanLong', lack: 2, expectedBase: 'sanLong',
    hand: [...T(0, [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]), t(1, 4), t(1, 4)],
    rules: withOptional(DEFAULT_CHENGDU_RULES, { sanLong: 8 }, 8),
  },
  {
    key: 'shiBaLuoHan', lack: 2, expectedBase: 'shiBaLuoHan',
    melds: [gang(0, 1), gang(0, 2), gang(0, 3), gang(0, 4)],
    hand: [t(1, 5), t(1, 5)],
    rules: withOptional(DEFAULT_CHENGDU_RULES, { shiBaLuoHan: 8 }, 8),
  },
  {
    key: 'tianHu', hand: plainHand, expectedBase: 'tianHu',
    rules: withOptional(DEFAULT_CHENGDU_RULES, { tianHu: 6 }),
    context: { ...EMPTY_HU_CONTEXT, selfDraw: true, tianHu: true },
  },
  {
    key: 'diHu', hand: plainHand, expectedBase: 'diHu',
    rules: withOptional(DEFAULT_CHENGDU_RULES, { diHu: 6 }),
    context: { ...EMPTY_HU_CONTEXT, diHu: true },
  },
];

describe('番型行为审计', () => {
  for (const c of CASES) {
    it(`${c.key} 正例`, () => {
      const r = scoreBestHand({
        hand: c.hand,
        melds: c.melds ?? [],
        lackSuit: c.lack ?? 2,
        winningTile: c.winning ?? c.hand[c.hand.length - 1]!,
        context: c.context ?? EMPTY_HU_CONTEXT,
        rules: c.rules ?? DEFAULT_CHENGDU_RULES,
      });
      if (c.expectedBase) expect(r.baseName).toBe(c.expectedBase);
      if (c.expectedItem) expect(r.items.join('|')).toContain(c.expectedItem);
    });
  }

  it('反例：平胡手不触发任何其他番（平胡自身除外）', () => {
    const r = scoreBestHand({
      hand: plainHand, melds: [], lackSuit: 2,
      winningTile: plainHand[plainHand.length - 1]!,
      context: EMPTY_HU_CONTEXT, rules: DEFAULT_CHENGDU_RULES,
    });
    for (const [key, info] of Object.entries(MAHJONG_FAN_INFO)) {
      if (key === 'pingHu') continue;
      expect(r.items.join('|'), key).not.toContain(info.label);
    }
  });

  it('CASES 覆盖全部番键', () => {
    const covered = new Set(CASES.map((c) => c.key));
    for (const key of [
      ...MAHJONG_NAMED_FAN_KEYS,
      ...MAHJONG_ADDITIVE_FAN_KEYS,
      ...MAHJONG_OPTIONAL_FAN_KEYS,
    ]) {
      expect(covered.has(key), key).toBe(true);
    }
  });

  const negativeScore = (hand: Tile[], rules: MahjongRulesConfig) =>
    scoreBestHand({
      hand, melds: [], lackSuit: 2,
      winningTile: hand[hand.length - 1]!,
      context: EMPTY_HU_CONTEXT, rules,
    });

  it('duanYaoJiu 反例：有幺九不成立', () => {
    const r = negativeScore(plainHand, withOptional(DEFAULT_CHENGDU_RULES, { duanYaoJiu: 1 }));
    expect(r.items.join('|')).not.toContain('断幺九');
  });

  it('haiDi 反例：非海底不成立', () => {
    const r = negativeScore(plainHand, withOptional(DEFAULT_CHENGDU_RULES, { haiDi: 1 }));
    expect(r.items.join('|')).not.toContain('海底');
  });

  it('perGang 反例：无杠不成立', () => {
    const r = negativeScore(plainHand, withOptional(DEFAULT_CHENGDU_RULES, { perGang: 1 }));
    expect(r.items.join('|')).not.toContain('每杠');
  });

  it('shuangLong 反例：只有 1 组四张不成立', () => {
    const r = negativeScore(
      dragonPairsHand,
      withOptional(DEFAULT_CHENGDU_RULES, { shuangLong: 8 }, 8),
    );
    expect(r.baseName).not.toBe('shuangLong');
  });

  it('sanLong 反例：只有 2 组四张不成立', () => {
    const twoQuads = [...T(0, [1, 1, 1, 1, 2, 2, 2, 2]), ...T(1, [3, 3, 4, 4, 5, 5])];
    const r = negativeScore(twoQuads, withOptional(DEFAULT_CHENGDU_RULES, { sanLong: 8 }, 8));
    expect(r.baseName).not.toBe('sanLong');
  });

  it('shiBaLuoHan 反例：只有 3 个杠不成立', () => {
    const r = scoreBestHand({
      hand: [...T(0, [4, 4, 4]), t(1, 5), t(1, 5)],
      melds: [gang(0, 1), gang(0, 2), gang(0, 3)],
      lackSuit: 2,
      winningTile: t(1, 5),
      context: EMPTY_HU_CONTEXT,
      rules: withOptional(DEFAULT_CHENGDU_RULES, { shiBaLuoHan: 8 }, 8),
    });
    expect(r.baseName).toBe('duiDuiHu');
    expect(r.baseName).not.toBe('shiBaLuoHan');
  });

  it('huContext 不置位天胡/地胡（接线守卫）', () => {
    const fake = { lastDraw: null, wall: [] } as unknown as MahjongSession;
    expect(huContext(fake, 0, true).tianHu).toBe(false);
    expect(huContext(fake, 0, true).diHu).toBe(false);
  });
});

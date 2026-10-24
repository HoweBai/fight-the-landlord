/**
 * 牌型播报映射（spec 2026-10-22 · U5-2）。
 *
 * ⚠️ 射程：这里只证明「给定牌面 → 选中哪条 cue」，不证明真的听见；
 * 也不证明出牌合法性（合法性由服务端裁决，`parseHand` 只用于选音）。
 */
import { describe, expect, it } from 'vitest';
import type { Card } from '@fight-the-landlord/protocol';
import { CUES } from '../src/audio/cues';
import { cueForPlay } from '../src/audio/play-cues';

const c = (r: number, s = 0): Card => ({ r, s });
const same = (r: number, n: number): Card[] => Array.from({ length: n }, (_, i) => c(r, i));

const SINGLE_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const PAIR_RANKS = [...SINGLE_RANKS, 17];
const NAMED_CASES: Array<[string, Card[], string]> = [
  ['顺子', [3, 4, 5, 6, 7].map((r) => c(r)), 'Straight'],
  ['连对', [...same(3, 2), ...same(4, 2), ...same(5, 2)], 'PairStraight'],
  ['飞机', [...same(3, 3), ...same(4, 3)], 'Plane'],
  ['飞机带单', [...same(3, 3), ...same(4, 3), c(5), c(6)], 'Plane'],
  ['飞机带对', [...same(3, 3), ...same(4, 3), ...same(5, 2), ...same(6, 2)], 'Plane'],
  ['三带一', [...same(3, 3), c(4)], 'TrioWithSingle'],
  ['三带二', [...same(3, 3), ...same(4, 2)], 'TrioWithPair'],
  ['四带二', [...same(3, 4), c(4), c(5)], 'FourWithTwo'],
  ['四带两对', [...same(3, 4), ...same(4, 2), ...same(5, 2)], 'FourWithTwoPairs'],
  ['炸弹', same(3, 4), 'Bomb'],
  ['王炸', [c(20, 4), c(30, 4)], 'Rocket'],
];

/** 50 个播报 cue 名（单测与「cue 名 → 文件」判据共用）。 */
const PLAY_CUE_NAMES: readonly string[] = [
  ...SINGLE_RANKS.map((r) => `Single${r}`),
  'Single15',
  'SingleLittleJoker',
  'SingleBigJoker',
  ...SINGLE_RANKS.map((r) => `Pair${r}`),
  'Pair15',
  ...SINGLE_RANKS.map((r) => `Trio${r}`),
  'Trio15',
  ...NAMED_CASES.map(([, , name]) => name),
];

describe('cueForPlay：50 条出牌播报', () => {
  it.each(SINGLE_RANKS.map((r) => [r, `Single${r}`] as const))(
    '单张 %i → %s',
    (r, name) => {
      expect(cueForPlay([c(r)])).toBe(name);
    },
  );

  it('单张 2（rank 17）→ Single15', () => {
    expect(cueForPlay([c(17)])).toBe('Single15');
  });

  it('小王 / 大王单张 → SingleLittleJoker / SingleBigJoker', () => {
    expect(cueForPlay([c(20, 4)])).toBe('SingleLittleJoker');
    expect(cueForPlay([c(30, 4)])).toBe('SingleBigJoker');
  });

  it.each(PAIR_RANKS.map((r) => [r, r === 17 ? 'Pair15' : `Pair${r}`] as const))(
    '对子 %i → %s',
    (r, name) => {
      expect(cueForPlay(same(r, 2))).toBe(name);
    },
  );

  it.each(PAIR_RANKS.map((r) => [r, r === 17 ? 'Trio15' : `Trio${r}`] as const))(
    '三张 %i → %s',
    (r, name) => {
      expect(cueForPlay(same(r, 3))).toBe(name);
    },
  );

  it.each(NAMED_CASES)('%s → %s', (_label, cards, name) => {
    expect(cueForPlay(cards)).toBe(name);
  });

  it('50 个 cue 名全部被覆盖且都在 CUES 里', () => {
    const expected = new Set<string>(PLAY_CUE_NAMES);
    expect(expected.size).toBe(50);

    const actual = new Set<string>();
    for (const r of SINGLE_RANKS) actual.add(cueForPlay([c(r)])!);
    actual.add(cueForPlay([c(17)])!);
    actual.add(cueForPlay([c(20, 4)])!);
    actual.add(cueForPlay([c(30, 4)])!);
    for (const r of PAIR_RANKS) {
      actual.add(cueForPlay(same(r, 2))!);
      actual.add(cueForPlay(same(r, 3))!);
    }
    for (const [, cards] of NAMED_CASES) actual.add(cueForPlay(cards)!);
    expect(actual).toEqual(expected);
    for (const name of actual) {
      expect(CUES[name as keyof typeof CUES], `${name} 必须在 CUES 里`).toBeTruthy();
    }
  });

  it('每个 cue 名指向正确的素材文件（防 Single12 → Woman_13 这类错配）', () => {
    const namedFiles: Record<string, string> = {
      Straight: 'Woman_shunzi.mp3',
      PairStraight: 'Woman_liandui.mp3',
      Plane: 'Woman_feiji.mp3',
      TrioWithSingle: 'Woman_sandaiyi.mp3',
      TrioWithPair: 'Woman_sandaiyidui.mp3',
      FourWithTwo: 'Woman_sidaier.mp3',
      FourWithTwoPairs: 'Woman_sidailiangdui.mp3',
      Bomb: 'Woman_zhadan.mp3',
      Rocket: 'Woman_wangzha.mp3',
    };
    const expectedFile = (name: string): string => {
      if (name === 'SingleLittleJoker') return 'Woman_100.mp3';
      if (name === 'SingleBigJoker') return 'Woman_200.mp3';
      const single = /^Single(\d+)$/.exec(name);
      if (single) return `Woman_${single[1]}.mp3`;
      const pair = /^Pair(\d+)$/.exec(name);
      if (pair) return `Woman_dui${pair[1]}.mp3`;
      const trio = /^Trio(\d+)$/.exec(name);
      if (trio) return `Woman_tuple${trio[1]}.mp3`;
      const file = namedFiles[name];
      if (!file) throw new Error(`未知 cue 名：${name}`);
      return file;
    };

    for (const name of PLAY_CUE_NAMES) {
      expect(CUES[name as keyof typeof CUES], name).toBe(
        `/pages/table/static/audio/${expectedFile(name)}`,
      );
    }
  });

  it('空牌 / 非法牌型 / 未映射 rank / parseHand 抛错 ⇒ null（绝不抛）', () => {
    expect(cueForPlay([])).toBeNull();
    expect(cueForPlay([c(3), c(4)])).toBeNull(); // Invalid
    expect(cueForPlay([c(15)])).toBeNull(); // 未映射 rank
    expect(cueForPlay([c(18)])).toBeNull();
    expect(cueForPlay([null as unknown as Card])).toBeNull(); // parseHand 抛错被吞
    expect(() => cueForPlay([c(3), c(4)])).not.toThrow();
  });
});

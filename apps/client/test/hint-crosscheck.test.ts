/**
 * 交叉验证（提交前对抗轮，2026-10-13）：`hasBeatablePlay` 的「零误杀」承诺。
 *
 * 承诺：返回 `false` ⇒ 手里**确实没有任何一手**能压过目标。
 * 本件用**独立真值**对照：把整手牌的全部子集逐个 `parseHand + canBeat`
 * （暴力枚举，不借道 `hasBeatablePlay` 的任何枚举逻辑），存在能压的子集即为真值 true。
 *
 * 反方向（函数 true 而暴力 false = 保守多显按钮）**不算违规**，只计数。
 *
 * 固定种子（mulberry32）⇒ 确定性、非 flaky；规模上界即测试时长上界。
 */
import { describe, expect, it } from 'vitest';
import {
  canBeat,
  HandType,
  parseHand,
  type Card,
  type ParsedHand,
} from '@fight-the-landlord/protocol';
import { hasBeatablePlay } from '../src/game/hint';

/** 确定性 PRNG（mulberry32）——固定种子，样本可复现。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一副牌（54 张，含花色身份）。 */
function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (let r = 3; r <= 14; r++) for (let s = 0; s < 4; s++) deck.push({ r, s });
  for (let s = 0; s < 4; s++) deck.push({ r: 17, s });
  deck.push({ r: 20, s: 4 }, { r: 30, s: 4 });
  return deck;
}

/** 无放回抽 n 张。 */
function draw(rnd: () => number, deck: readonly Card[], n: number): Card[] {
  const pool = [...deck];
  const out: Card[] = [];
  for (let i = 0; i < n; i++) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]!);
  return out;
}

/** 独立真值：枚举全部非空子集，存在一手合法且能压过目标 ⇒ true。 */
function bruteForceBeats(hand: readonly Card[], target: ParsedHand): boolean {
  const n = hand.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset: Card[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(hand[i]!);
    let parsed: ParsedHand;
    try {
      parsed = parseHand(subset);
    } catch {
      continue;
    }
    if (parsed.type === HandType.Invalid) continue;
    if (canBeat(parsed, target)) return true;
  }
  return false;
}

/** 对一组 (hand, target) 做对照；返回统计与违规样本。 */
function crossCheck(
  cases: ReadonlyArray<{ hand: Card[]; target: ParsedHand }>,
): { checked: number; saidFalse: number; conservative: number; violations: string[] } {
  let saidFalse = 0;
  let conservative = 0;
  const violations: string[] = [];
  for (const { hand, target } of cases) {
    const fn = hasBeatablePlay(hand, target);
    const brute = bruteForceBeats(hand, target);
    if (!fn) {
      saidFalse += 1;
      if (brute) {
        violations.push(`hand=${JSON.stringify(hand)} target=${HandType[target.type]}/${target.keyRank}/${target.length}`);
      }
    } else if (!brute) {
      conservative += 1;
    }
  }
  return { checked: cases.length, saidFalse, conservative, violations };
}

/** 从种子牌堆抽一个随机合法目标（大小 1..8）。 */
function randomTarget(rnd: () => number, deck: readonly Card[]): ParsedHand | null {
  for (let tries = 0; tries < 60; tries++) {
    const cards = draw(rnd, deck, 1 + Math.floor(rnd() * 8));
    let parsed: ParsedHand;
    try {
      parsed = parseHand(cards);
    } catch {
      continue;
    }
    if (parsed.type === HandType.Invalid) continue;
    return parsed;
  }
  return null;
}

describe('交叉验证：hasBeatablePlay「零误杀」vs 全子集暴力（固定种子）', () => {
  it('随机 300 组（手牌 8–12 张、随机合法目标）：判「压不过」时暴力枚举也必须找不到', () => {
    const rnd = rng(0xc0ffee);
    const deck = fullDeck();
    const cases: Array<{ hand: Card[]; target: ParsedHand }> = [];
    while (cases.length < 300) {
      const hand = draw(rnd, deck, 8 + Math.floor(rnd() * 5));
      const target = randomTarget(rnd, deck);
      if (target) cases.push({ hand, target });
    }
    const r = crossCheck(cases);
    expect(r.violations, `误杀样本（fn=false 但暴力找到能压的子集）：\n${r.violations.slice(0, 3).join('\n')}`).toEqual([]);
    expect(r.saidFalse, '探针：必须真的出现过「压不过」样本（否则本件恒真）').toBeGreaterThan(20);
  });

  it('组合型目标定向扫（飞机带翼 / 四带二 / 连对 / 三带…）：各 30 手随机牌', () => {
    const rnd = rng(0xbeef);
    const deck = fullDeck();
    /** 固定目标：直接点名构造输入（不是本地重写规则——目标一律过 parseHand 解析）。 */
    const fixedTargets: Card[][] = [
      [card(5, 0), card(5, 1), card(5, 2), card(7, 0)], // 三带一
      [card(5, 0), card(5, 1), card(5, 2), card(7, 0), card(7, 1)], // 三带二
      [card(3, 0), card(4, 0), card(5, 0), card(6, 0), card(7, 0)], // 顺子 3-7
      [card(10, 0), card(10, 1), card(11, 0), card(11, 1), card(12, 0), card(12, 1)], // 连对 10-J-Q
      [card(3, 0), card(3, 1), card(3, 2), card(4, 0), card(4, 1), card(4, 2)], // 裸飞机 333444
      [card(3, 0), card(3, 1), card(3, 2), card(4, 0), card(4, 1), card(4, 2), card(8, 0), card(9, 0)], // 飞机带单
      [card(3, 0), card(3, 1), card(3, 2), card(4, 0), card(4, 1), card(4, 2), card(8, 0), card(8, 1)], // 飞机带单（对子翅膀）
      [card(3, 0), card(3, 1), card(3, 2), card(4, 0), card(4, 1), card(4, 2), card(8, 0), card(8, 1), card(9, 0), card(9, 1)], // 飞机带对
      [card(6, 0), card(6, 1), card(6, 2), card(6, 3)], // 炸弹
      [card(5, 0), card(5, 1), card(5, 2), card(5, 3), card(7, 0), card(8, 0)], // 四带二（两单）
      [card(5, 0), card(5, 1), card(5, 2), card(5, 3), card(9, 0), card(9, 1), card(10, 0), card(10, 1)], // 四带两对
      [card(20, 4), card(30, 4)], // 王炸
    ];
    const cases: Array<{ hand: Card[]; target: ParsedHand }> = [];
    for (const cards of fixedTargets) {
      const target = parseHand(cards); // 目标自身先过真规则（构造错会当场红）
      expect(target.type, `固定目标构造不合法：${JSON.stringify(cards)}`).not.toBe(HandType.Invalid);
      for (let i = 0; i < 30; i++) {
        const hand = draw(rnd, deck, 8 + Math.floor(rnd() * 5));
        cases.push({ hand, target });
      }
    }
    const r = crossCheck(cases);
    expect(r.violations, `误杀样本：\n${r.violations.slice(0, 3).join('\n')}`).toEqual([]);
  });
});

/** 简写：构造一张牌（只用于固定目标的输入构造）。 */
function card(r: number, s: number): Card {
  return { r, s };
}

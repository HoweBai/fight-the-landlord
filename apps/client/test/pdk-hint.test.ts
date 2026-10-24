import { describe, expect, it } from 'vitest';
import type { Card, PdkParsedHand, PdkRulesConfig } from '@fight-the-landlord/protocol';
import { parsePdkHand } from '@fight-the-landlord/protocol';
import { suggestPdkPlays } from '../src/game/pdk-hint';

/**
 * S6.2（spec D45）：跑得快提示。
 *
 * 判据：候选**全部**由 `protocol.parsePdkHand`/`canBeatPdk` 认可（客户端不实现规则）；
 * 关闭的牌型不产出；跟牌只给能压过的；首出给合法牌型。
 */
const RULES: PdkRulesConfig = {
  bareTrioEnabled: true,
  trioWithPairEnabled: false,
  bareAirplaneEnabled: false,
  fourWithTwoEnabled: true,
  fourWithTwoPairKickerAllowed: false,
  airplaneWings: 'pairs',
  bombMultiplierEnabled: true,
  guanMultiplierEnabled: true,
  springMultiplierEnabled: true,
  multiplierCap: 64,
  baobenEnabled: true,
};

const card = (r: number, s: number): Card => ({ r, s });
const key = (c: Card): string => `${c.r},${c.s}`;
const asSet = (cards: Card[]): string[] => cards.map(key).sort();

function parsedOf(cards: Card[]): PdkParsedHand {
  return parsePdkHand(cards, RULES);
}

describe('S6.2：suggestPdkPlays（hint）', () => {
  it('首出：每个候选都是合法牌型；单张/对子/三张/炸弹按牌型产出', () => {
    const hand = [card(3, 1), card(3, 2), card(4, 0), card(4, 1), card(5, 0), card(6, 0), card(6, 1), card(6, 2), card(7, 0), card(7, 1), card(7, 2), card(7, 3)];
    const plays = suggestPdkPlays(hand, null, RULES);
    expect(plays.length).toBeGreaterThan(0);
    for (const cards of plays) {
      expect(cards.length).toBeGreaterThan(0);
      expect(parsedOf(cards).type).not.toBe(0);
      // 全部来自手牌（按 (r,s) 多重集）
      const pool = hand.map(key);
      for (const c of cards) {
        const at = pool.indexOf(key(c));
        expect(at, `候选牌 ${key(c)} 不在手牌里`).toBeGreaterThanOrEqual(0);
        pool.splice(at, 1);
      }
    }
    // 首出候选里必须包含最小单张（3♥/3♣ 之一）
    expect(plays.some((p) => p.length === 1 && p[0]!.r === 3)).toBe(true);
    // 炸弹（四张 7）在首出候选里
    expect(plays.some((p) => asSet(p).length === 4 && p.every((c) => c.r === 7))).toBe(true);
  });

  it('跟单张：只返回能压过的同型牌；炸弹可压但排在后面', () => {
    const hand = [card(4, 0), card(5, 0), card(9, 0), card(9, 1), card(9, 2), card(9, 3), card(10, 0)];
    const target = parsedOf([card(8, 0)]); // 单张 8
    const plays = suggestPdkPlays(hand, target, RULES);

    expect(plays.length).toBeGreaterThan(0);
    for (const cards of plays) {
      const parsed = parsedOf(cards);
      // 炸弹可以压任何非炸弹；其余候选必须同型且主键更大。
      if (parsed.type !== 11) {
        expect(parsed.type).toBe(target.type);
        expect(parsed.keyRank).toBeGreaterThan(target.keyRank);
      }
    }
    // 最小可压单张 9 在最前；炸弹（四张 9）也在候选里（炸弹可压非炸弹）
    expect(plays[0]!.map((c) => c.r)).toEqual([9]);
    expect(plays.some((p) => p.length === 4 && p.every((c) => c.r === 9))).toBe(true);
  });

  it('关闭四带二 ⇒ 不产出四带二候选（rules 过滤）', () => {
    const hand = [card(8, 0), card(8, 1), card(8, 2), card(8, 3), card(9, 0), card(10, 0)];
    const on = suggestPdkPlays(hand, null, RULES).some((p) => parsedOf(p).type === 6); // FourWithTwo
    const off = suggestPdkPlays(hand, null, { ...RULES, fourWithTwoEnabled: false }).some(
      (p) => parsedOf(p).type === 6,
    );
    expect(on).toBe(true);
    expect(off).toBe(false);
  });

  it('跟牌无解 ⇒ 空数组（页面隐藏/降级提示入口）', () => {
    const target = parsedOf([card(17, 1)]); // 单张红桃 2（最大单张）
    const hand = [card(3, 0), card(4, 0)];
    expect(suggestPdkPlays(hand, target, RULES)).toEqual([]);
  });
});

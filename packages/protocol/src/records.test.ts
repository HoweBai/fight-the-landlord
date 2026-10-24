/**
 * C1（记录片规格 §2.1）：牌编码 codec —— 54 张全集往返、定长（34/6）、
 * 张数不符 / 值域外 / 包络内非法值 / 非规范形态 ⇒ 抛。
 *
 * ⚠️ 负例的**判别力**：`{r:15,s:0}`（字节 75）与 `{r:31,s:0}`（字节 155 的邻居）
 * 都在「包络 15–154」内/邻 —— 只做 floor/mod 的解码器会把 75 解成 {15,0} 而**不抛**，
 * 本文件的用例专门拦这种「像正确答案的错实现」。
 */
import { describe, expect, it } from 'vitest';
import { encodeCards, decodeCards, encodeHand, decodeHand } from './records';
import { ProtocolError } from './validate';
import type { Card } from './views';

/** 一整副物理牌（54 张）：3–14 与 2（17）× 四花色 + 两王（s=4）。 */
function fullDeck(): Card[] {
  const cards: Card[] = [];
  for (const r of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17]) {
    for (let s = 0; s < 4; s++) cards.push({ r, s });
  }
  cards.push({ r: 20, s: 4 }, { r: 30, s: 4 });
  return cards;
}

/** 样例手 A（含 2 与两王 ⇒ hex 里必含字母，供「大写非规范」用例当前置）。 */
const SAMPLE_HAND_A: Card[] = [
  { r: 3, s: 0 }, { r: 4, s: 1 }, { r: 5, s: 2 }, { r: 6, s: 3 }, { r: 7, s: 0 },
  { r: 8, s: 1 }, { r: 9, s: 2 }, { r: 10, s: 3 }, { r: 11, s: 0 }, { r: 12, s: 1 },
  { r: 13, s: 2 }, { r: 14, s: 3 }, { r: 17, s: 0 }, { r: 17, s: 1 }, { r: 17, s: 2 },
  { r: 20, s: 4 }, { r: 30, s: 4 },
];

/** 样例手 B（第二副牌的花色/点数组合，与 A 不同的乱序）。 */
const SAMPLE_HAND_B: Card[] = [
  { r: 3, s: 3 }, { r: 5, s: 0 }, { r: 6, s: 1 }, { r: 8, s: 2 }, { r: 10, s: 0 },
  { r: 11, s: 1 }, { r: 13, s: 0 }, { r: 14, s: 0 }, { r: 17, s: 3 }, { r: 20, s: 4 },
  { r: 30, s: 4 }, { r: 3, s: 1 }, { r: 9, s: 3 }, { r: 12, s: 2 }, { r: 7, s: 1 },
  { r: 4, s: 0 }, { r: 13, s: 3 },
];

describe('C1：牌编码 codec（规格 §2.1）', () => {
  it('54 张全集逐张往返：字节 = r*5+s、两两互异、恒在包络 15–154 内', () => {
    const deck = fullDeck();
    expect(deck).toHaveLength(54);

    const seen = new Set<string>();
    for (let i = 0; i < deck.length; i += 3) {
      const triple = deck.slice(i, i + 3);
      const hex = encodeCards(triple);
      expect(hex, `3 张 ⇒ 定长 6`).toHaveLength(6);
      expect(hex).toMatch(/^[0-9a-f]{6}$/);
      expect(decodeCards(hex)).toEqual(triple);

      triple.forEach((c, j) => {
        const pair = hex.slice(j * 2, j * 2 + 2);
        const v = Number.parseInt(pair, 16);
        expect(pair, `${JSON.stringify(c)} 的字节必须是 r*5+s`).toBe((c.r * 5 + c.s).toString(16).padStart(2, '0'));
        expect(v, '包络下界').toBeGreaterThanOrEqual(15);
        expect(v, '包络上界').toBeLessThanOrEqual(154);
        seen.add(pair);
      });
    }
    // 注入性：54 张的编码两两互异（= 54 个不同字节）
    expect(seen.size).toBe(54);
  });

  it('两副样例手逐张往返：encodeHand 恰 34 字符、decodeHand 互为逆', () => {
    for (const hand of [SAMPLE_HAND_A, SAMPLE_HAND_B]) {
      const hex = encodeHand(hand);
      expect(hex, '17 张 ⇒ 定长 34').toHaveLength(34);
      expect(hex).toMatch(/^[0-9a-f]{34}$/);
      expect(decodeHand(hex)).toEqual(hand);
    }
  });

  it('定长零填充口径：最小 {3,0} ⇒ "0f"、最大 {30,4} ⇒ "9a"', () => {
    expect(encodeCards([{ r: 3, s: 0 }, { r: 3, s: 0 }, { r: 30, s: 4 }])).toBe('0f0f9a');
    expect(decodeCards('0f0f9a')).toEqual([{ r: 3, s: 0 }, { r: 3, s: 0 }, { r: 30, s: 4 }]);
  });

  it('张数不符 ⇒ 抛（encodeHand 16/18 张、encodeCards 2/4 张；中文原因）', () => {
    const deck = fullDeck();
    expect(() => encodeHand(deck.slice(0, 16))).toThrow(ProtocolError);
    expect(() => encodeHand(deck.slice(0, 16))).toThrow(/17/);
    expect(() => encodeHand(deck.slice(0, 18))).toThrow(/17/);
    expect(() => encodeCards(deck.slice(0, 2))).toThrow(/3/);
    expect(() => encodeCards(deck.slice(0, 4))).toThrow(/3/);
  });

  it('值域外/非法值 ⇒ 抛（{15,0} = 字节 75、{16,0}、s=5、非整数）', () => {
    const deck = fullDeck();
    const withR15: Card[] = [...deck.slice(0, 16), { r: 15, s: 0 }];
    expect(() => encodeHand(withR15)).toThrow(ProtocolError);
    expect(() => encodeHand(withR15)).toThrow(/15/);
    expect(() => encodeCards([{ r: 16, s: 0 }, { r: 3, s: 1 }, { r: 3, s: 2 }])).toThrow(ProtocolError);
    expect(() => encodeCards([{ r: 3, s: 0 }, { r: 3, s: 1 }, { r: 3, s: 5 }])).toThrow(ProtocolError);
    expect(() => encodeCards([{ r: 3, s: 0 }, { r: 3, s: 1 }, { r: 3.5, s: 2 }])).toThrow(ProtocolError);
  });

  it('decodeHand：长度不是 34 ⇒ 抛（35/33 字符）', () => {
    const hex = encodeHand(SAMPLE_HAND_A);
    expect(() => decodeHand(hex + 'a')).toThrow(ProtocolError);
    expect(() => decodeHand(hex + 'a')).toThrow(/34/);
    expect(() => decodeHand(hex.slice(0, 33))).toThrow(/34/);
  });

  it('decodeHand：包络内非法值 ⇒ 抛（75 = r15；155 = r31 —— 非「只做 floor/mod」能拦）', () => {
    const hex = encodeHand(SAMPLE_HAND_A);
    expect(() => decodeHand('4b' + hex.slice(2))).toThrow(ProtocolError);
    expect(() => decodeHand('4b' + hex.slice(2))).toThrow(/75|15/);
    expect(() => decodeHand('9b' + hex.slice(2))).toThrow(ProtocolError);
  });

  it('decodeHand：非法 hex 字符 / 大写非规范形态 ⇒ 抛（复核 = decode→re-encode == 原值）', () => {
    expect(() => decodeHand('zz'.repeat(17))).toThrow(ProtocolError);
    expect(() => decodeHand('g'.repeat(34))).toThrow(ProtocolError);
    const hex = encodeHand(SAMPLE_HAND_A);
    expect(hex, '前置：样例必须含字母，否则大写断言是空测').toMatch(/[a-f]/);
    expect(() => decodeHand(hex.toUpperCase())).toThrow(ProtocolError);
  });

  it('decodeCards：长度不是 6 / 含非法字节 ⇒ 抛', () => {
    expect(() => decodeCards('0f0f')).toThrow(ProtocolError);
    expect(() => decodeCards('0f0f0f0f')).toThrow(ProtocolError);
    expect(() => decodeCards('0f4b0f')).toThrow(ProtocolError); // 中间一张 = 75
    expect(() => decodeCards('0f0fzz')).toThrow(ProtocolError);
  });
});

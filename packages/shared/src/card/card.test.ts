import { describe, it, expect } from 'vitest';
import { suitSymbol } from '@fight-the-landlord/protocol';
import { Suit, Rank, createDeck, shuffleDeck } from './card';

describe('createDeck', () => {
  it('creates 54 cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(54);
  });

  it('no duplicate cards', () => {
    const deck = createDeck();
    const keys = new Set(deck.map(c => `${c.s}-${c.r}`));
    expect(keys.size).toBe(54);
  });

  it('contains black and red joker', () => {
    const deck = createDeck();
    const jokers = deck.filter(c => c.s === Suit.Joker);
    expect(jokers).toHaveLength(2);
    expect(jokers.some(c => c.r === Rank.RankBlackJoker)).toBe(true);
    expect(jokers.some(c => c.r === Rank.RankRedJoker)).toBe(true);
  });

  it('R695：四张 2 都在，且编码是 17（不是 15、也不是 16）', () => {
    // 这个地雷有两个失败方向，两条都实测过：
    //  上界沿用 <= Rank2 ⇒ 62 张（含非法值 15/16）
    //  上界改成 <= RankA ⇒ 50 张（四张 2 全丢）
    const twos = createDeck().filter(c => c.r === Rank.Rank2);
    expect(twos).toHaveLength(4);
    expect(Rank.Rank2).toBe(17);
  });

  it('每张牌都是合法 DouZero 值（3–14 / 17 / 20 / 30）', () => {
    const legal = (r: number) => (r >= 3 && r <= 14) || r === 17 || r === 20 || r === 30;
    expect(createDeck().every(c => legal(c.r))).toBe(true);
  });
});

describe('shuffleDeck', () => {
  it('mutates deck in place', () => {
    const deck = createDeck();
    const id = deck;
    shuffleDeck(deck);
    expect(deck).toBe(id);
    expect(deck).toHaveLength(54);
  });
});

describe('Suit 与 protocol 的 s 同值（§3.1 的契约测试）', () => {
  // protocol 出于「零依赖」不导出枚举，只把值域写在 Card.s 的文档里。
  // 本枚举是它在服务端的落点 ⇒ 两者必须对齐，否则服务端画出的花色与客户端不一致。
  it('每个 Suit 经由 protocol.suitSymbol 得到正确的符号', () => {
    expect(suitSymbol(Suit.Spade)).toBe('♠');
    expect(suitSymbol(Suit.Heart)).toBe('♥');
    expect(suitSymbol(Suit.Club)).toBe('♣');
    expect(suitSymbol(Suit.Diamond)).toBe('♦');
    expect(suitSymbol(Suit.Joker)).toBe('');
  });

  it('值域恰好是 0–4，两个王共用一个 Suit', () => {
    expect([Suit.Spade, Suit.Heart, Suit.Club, Suit.Diamond, Suit.Joker]).toEqual([0, 1, 2, 3, 4]);
    const jokers = createDeck().filter(c => c.r >= 20);
    expect(jokers.every(c => c.s === Suit.Joker)).toBe(true);
  });
});

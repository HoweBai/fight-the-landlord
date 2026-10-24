/**
 * C7 + C8（R205）：`buildPublicFeatures()` 是 `actionLog` 的**唯一**投影，
 * 且只含**公开信息**（已出的牌），不得派生任何**未出**的手牌。
 *
 * 判据形态：
 *  ① 空 `actionLog` ⇒ 三项特征全空；
 *  ② 一次出牌 + 一次过牌 ⇒ `playedCards` 只含**打出的**牌（pass 不产生牌）、
 *     `actionSeq` 顺序正确（pass = 空数组）；
 *  ③ **反例（C8 的核心）**：地主手里**没出过**的牌不得出现在任何 `playedCards` 里
 *     —— 旧实现（`bot.player.ts` 的 `computePlayedCards()`）用「总牌堆 − 当前手牌」
 *     反推，会把没出的牌也「估」出来并按 `lastPlayerIdx` 倒序硬分配给三家。
 */
import { describe, expect, it } from 'vitest';
import type { Card } from '@fight-the-landlord/protocol';
import { GameState } from './types';
import type { GameSession } from './types';
import { buildPublicFeatures, botPositionOf } from './features';

/**
 * R696：牌是 `{r, s}`。本文件的断言只关心**点数** ——
 * `playedCards` / `actionSeq` / `lastMove` 都是 DouZero 点数（AI 契约不带花色），
 * 投影在 `features.ts` 里完成。故夹具的 `s` 取常量即可。
 */
const h = (...ranks: number[]): Card[] => ranks.map(r => ({ r, s: 0 }));

/** 手工构造一个已进入出牌阶段的会话（座位 0 是地主）。 */
function playingSession(): GameSession {
  return {
    roomCode: 'ROOM-F',
    gameType: 'doudizhu',
    playerCount: 3,
    baseScore: 100,
    state: GameState.Playing,
    players: [
      { id: 'p0', seat: 0, hand: h(3, 4, 5, 9), isLandlord: true, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      { id: 'p1', seat: 1, hand: h(6, 7), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      { id: 'p2', seat: 2, hand: h(8, 10, 11), isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
    ],
    bottomCards: h(12, 13, 14),
    currentPlayer: 1,
    lastPlayedHand: { cards: h(9), type: 1, keyRank: 9, length: 0 },
    lastPlayerIdx: 0,
    version: 4,
    actionLog: [],
    bidPhase: {
      currentBidder: 0,
      landlordCaller: 0,
      landlordCandidate: 0,
      bidPasses: 0,
      grabActions: 3,
      bidMultiplier: 2,
      redealCount: 0,
      decisions: [],
      firstCaller: -1,
      antiRobGranted: false,
    },
    playPhase: { bombCount: 0, landlordPlays: 1, farmerPlays: 0, consecutivePasses: 0 },
    turnDeadlineAt: 0,
    createdAt: 0,
    finishedAt: null,
  };
}

describe('buildPublicFeatures（C8/R205）', () => {
  it('① 空 actionLog ⇒ playedCards 全空、actionSeq 空', () => {
    const f = buildPublicFeatures(playingSession(), 1);

    expect(f.playedCards).toEqual({ landlord: [], landlord_down: [], landlord_up: [] });
    expect(f.actionSeq).toEqual([]);
    // 上一手牌是**公开**信息（不走 actionLog 也照样下发）
    expect(f.lastMove).toEqual([9]);
    expect(f.lastMovePosition).toBe('landlord');
  });

  it('② 一次出牌 + 一次过牌 ⇒ playedCards 只含打出的牌、actionSeq 顺序正确', () => {
    const session = playingSession();
    session.actionLog = [
      { version: 2, seat: 0, cards: h(9), kind: 'play' },
      { version: 3, seat: 1, cards: [], kind: 'pass' },
      { version: 4, seat: 2, cards: h(8, 10, 11), kind: 'play' },
    ];

    const f = buildPublicFeatures(session, 1);

    // pass 不产生任何牌
    expect(f.playedCards.landlord).toEqual([9]);
    expect(f.playedCards.landlord_up).toEqual([8, 10, 11]);
    expect(f.playedCards.landlord_down).toEqual([]);
    // actionSeq 按出牌顺序，pass 是空数组
    expect(f.actionSeq).toEqual([[9], [], [8, 10, 11]]);
  });

  it('③ 反例：地主手里**没出过**的牌不得出现在任何 playedCards（C8 的核心判据）', () => {
    const session = playingSession();
    // 地主只打出过 9；它手里还有 3 / 4 / 5
    session.actionLog = [{ version: 4, seat: 0, cards: h(9), kind: 'play' }];

    const f = buildPublicFeatures(session, 1);
    const allPlayed = [
      ...f.playedCards.landlord,
      ...f.playedCards.landlord_down,
      ...f.playedCards.landlord_up,
    ];

    expect(allPlayed).toEqual([9]);
    for (const unplayed of [3, 4, 5]) {
      expect(allPlayed, `未出的手牌 ${unplayed} 不得出现在 playedCards 里`).not.toContain(unplayed);
    }
    // 张数是公开的，可以下发（它是 cardCounts 级信息）
    expect(f.numCardsLeft.landlord).toBe(4);
    expect(f.numCardsLeft.landlord_down).toBe(2);
    expect(f.numCardsLeft.landlord_up).toBe(3);
  });

  it('协议④的连带面：lastMoveMeta 与 session.lastPlayedHand 的规则字段一致', () => {
    const s = playingSession();
    s.lastPlayedHand = { cards: h(5), type: 1, keyRank: 5, length: 0 };
    s.lastPlayerIdx = 1;
    const f = buildPublicFeatures(s, 0);
    expect(f.lastMoveMeta).toEqual({ type: 1, keyRank: 5, length: 0 });
    expect(f.lastMove).toEqual([5]); // 既有字段不变
    expect(f.lastMovePosition).toBe(botPositionOf(s, 1));
  });

  it('没有上一手牌 ⇒ lastMoveMeta 为 null（而不是一个「空手」对象）', () => {
    const s = playingSession();
    s.lastPlayedHand = null;
    expect(buildPublicFeatures(s, 0).lastMoveMeta).toBeNull();
  });

  it('多玩法（Task 2.6）：斗地主公开特征带 gameType=doudizhu（联合类型判别位）', () => {
    expect(buildPublicFeatures(playingSession(), 0).gameType).toBe('doudizhu');
  });

  it('位置映射：地主/下家/上家按座位轮转，叫抢阶段无地主时为 null', () => {    const playing = playingSession();
    expect(botPositionOf(playing, 0)).toBe('landlord');
    expect(botPositionOf(playing, 1)).toBe('landlord_down');
    expect(botPositionOf(playing, 2)).toBe('landlord_up');

    const bidding = {
      ...playing,
      state: GameState.Bidding,
      players: playing.players.map((p) => ({ ...p, isLandlord: false })),
      bidPhase: { ...playing.bidPhase, landlordCandidate: -1 },
    };
    expect(botPositionOf(bidding, 0)).toBeNull();
    // 位置未定时也不得抛错（`decide` 可能被叫抢阶段调用）
    expect(() => buildPublicFeatures(bidding, 0)).not.toThrow();
  });
});

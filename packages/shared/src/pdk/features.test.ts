/**
 * Task 3.5 / spec §4.8 + §9.5：跑得快机器人公开特征。
 *
 * 只投影**公开**信息：上一手（含规则字段与 wings 形状）、各家剩余张数、已打出的牌、
 * 动作序列、连续过牌数、炸弹数、canPass、本局规则快照。
 * **绝不包含**任何人的手牌或 2 人局扣牌（`unusedCards`）。
 */
import { describe, expect, it } from 'vitest';
import {
  PdkHandType,
  type Card,
  type PdkParsedHand,
  type PdkRulesConfig,
} from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES } from './rules';
import type { PdkPlayer, PdkSession } from './types';
import { buildPdkFeatures } from './features';

const C = (r: number, s = 0): Card => ({ r, s });

function player(id: string, seat: number, hand: Card[]): PdkPlayer {
  return {
    id,
    seat,
    hand,
    isBot: false,
    isOffline: false,
    timeoutCount: 0,
    trustee: false,
    playedCount: 0,
  };
}

function fixture(over: Partial<PdkSession> = {}): PdkSession {
  const rules: PdkRulesConfig = DEFAULT_PDK_RULES;
  return {
    roomCode: 'PDK001',
    gameType: 'paodekuai',
    playerCount: 3,
    baseScore: 15,
    state: 'playing',
    players: [
      player('a', 0, [C(3, 0), C(3, 1)]),
      player('b', 1, [C(4), C(4, 1), C(4, 2)]),
      player('c', 2, [C(5, 1), C(5, 2)]),
    ],
    currentPlayer: 1,
    turnDeadlineAt: 0,
    version: 5,
    actionLog: [
      { version: 2, seat: 0, cards: [C(3, 0), C(3, 1)], kind: 'play' },
      { version: 3, seat: 1, cards: [], kind: 'pass' },
      { version: 4, seat: 2, cards: [C(5, 1), C(5, 2)], kind: 'play' },
      { version: 5, seat: 0, cards: [], kind: 'pass' },
    ],
    createdAt: 0,
    finishedAt: null,
    rules,
    lastPlayedHand: { type: PdkHandType.Pair, keyRank: 5, length: 0 },
    lastPlayerIdx: 2,
    consecutivePasses: 1,
    bombCount: 2,
    ...over,
  };
}

describe('buildPdkFeatures（Task 3.5）', () => {
  it('完整投影公开信息：lastMove/剩余张数/已出牌/动作序列/计数/canPass/规则快照', () => {
    const f = buildPdkFeatures(fixture(), 1);

    expect(f).toEqual({
      gameType: 'paodekuai',
      seat: 1,
      lastMove: { type: PdkHandType.Pair, keyRank: 5, length: 0, cards: [5, 5] },
      numCardsLeft: [2, 3, 2],
      playedCards: [
        [3, 3], // seat0 已出
        [], // seat1 只有过牌
        [5, 5], // seat2 已出
      ],
      actionSeq: [[3, 3], [], [5, 5], []],
      passCount: 1,
      bombCount: 2,
      canPass: true, // 上一手是 seat2 出的，seat1 可过
      pdkRules: DEFAULT_PDK_RULES,
    });
    expect(f.pdkRules).toBe(DEFAULT_PDK_RULES);
  });

  it('canPass：首出为 false；自己就是最后出牌者为 false', () => {
    const leading = buildPdkFeatures(
      fixture({ lastPlayedHand: null, lastPlayerIdx: -1, consecutivePasses: 0 }),
      1,
    );
    expect(leading.lastMove).toBeNull();
    expect(leading.canPass).toBe(false);

    const lastPlayer = buildPdkFeatures(fixture(), 2);
    expect(lastPlayer.canPass).toBe(false);
  });

  it('lastMove 带 wingMode（飞机带对/带单的形状判别）', () => {
    const played = Array.from({ length: 10 }, (_, i) => C(5 + (i % 2), i % 4));
    const parsed: PdkParsedHand = {
      type: PdkHandType.AirplaneWithWings,
      keyRank: 6,
      length: 2,
      wingMode: 'pairs',
    };
    const f = buildPdkFeatures(
      fixture({
        lastPlayedHand: parsed,
        lastPlayerIdx: 1,
        actionLog: [{ version: 2, seat: 1, cards: played, kind: 'play' }],
      }),
      0,
    );
    expect(f.lastMove).toMatchObject({ wingMode: 'pairs', keyRank: 6, length: 2 });
    expect(f.lastMove!.cards).toEqual(played.map((c) => c.r).sort((a, b) => a - b));
  });

  it('不泄漏：不含手牌/扣牌等内部字段（D43 / §9.5）', () => {
    const f = buildPdkFeatures(
      fixture({
        unusedCards: [C(17, 1)],
        playerCount: 2,
        players: [player('a', 0, [C(3)]), player('b', 1, [C(4)])],
        actionLog: [],
        lastPlayedHand: null,
        lastPlayerIdx: -1,
        consecutivePasses: 0,
      }),
      0,
    );
    expect('hand' in f).toBe(false);
    expect('unusedCards' in f).toBe(false);
    expect('players' in f).toBe(false);
    expect(JSON.stringify(f)).not.toContain('unusedCards');
    expect(JSON.stringify(f)).not.toContain('"hand"');
  });

  it('非法座位 ⇒ 抛错（不得静默编造特征）', () => {
    expect(() => buildPdkFeatures(fixture(), 3)).toThrow();
    expect(() => buildPdkFeatures(fixture(), -1)).toThrow();
  });

  it('座位按 seat 取值，不依赖数组下标顺序', () => {
    const shuffled = fixture({
      players: [player('c', 2, [C(5)]), player('a', 0, [C(3), C(3)]), player('b', 1, [C(4)])],
    });
    const f = buildPdkFeatures(shuffled, 1);
    expect(f.numCardsLeft).toEqual([2, 1, 1]);
  });
});

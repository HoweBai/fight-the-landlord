/**
 * Task 3.1：跑得快会话类型（形状基类 `GameSessionBase` 的实例化）。
 *
 * 本文件同时是**编译期**判据：`PdkSession` 必须可赋给 `GameSessionBase<Card>`，
 * 且 pdk 专有字段（`unusedCards` / `lastPlayedHand` / 计数）留在自己的类型里。
 */
import { describe, expect, it } from 'vitest';
import type { Card } from '@fight-the-landlord/protocol';
import type { GameSessionBase } from '../core/session';
import { DEFAULT_PDK_RULES } from './rules';
import type { PdkPlayer, PdkSession } from './types';

const card: Card = { r: 3, s: 0 };

function player(seat: number, over: Partial<PdkPlayer> = {}): PdkPlayer {
  return {
    id: `p${seat}`,
    seat,
    hand: [card],
    isBot: false,
    isOffline: false,
    timeoutCount: 0,
    trustee: false,
    playedCount: 0,
    ...over,
  };
}

function session(over: Partial<PdkSession> = {}): PdkSession {
  return {
    roomCode: 'PDK001',
    gameType: 'paodekuai',
    playerCount: 3,
    baseScore: 15,
    state: 'playing',
    players: [0, 1, 2].map((seat) => player(seat)),
    currentPlayer: 0,
    turnDeadlineAt: 0,
    version: 1,
    actionLog: [],
    createdAt: 0,
    finishedAt: null,
    rules: DEFAULT_PDK_RULES,
    lastPlayedHand: null,
    lastPlayerIdx: -1,
    consecutivePasses: 0,
    bombCount: 0,
    ...over,
  };
}

describe('PdkSession 类型（Task 3.1）', () => {
  it('可赋给玩法无关基类；玩法/人数/状态是 pdk 语义', () => {
    const pdk = session();
    const base: GameSessionBase<Card> = pdk; // 编译期判据：形状兼容
    expect(base.gameType).toBe('paodekuai');
    expect(base.playerCount).toBe(3);
    expect(base.state).toBe('playing');
    expect(base.rules).toEqual(DEFAULT_PDK_RULES);
  });

  it('PdkPlayer 带 playedCount（结算/关牌用），并继承会话玩家基字段', () => {
    const p = player(1, { playedCount: 7 });
    expect(p).toMatchObject({
      seat: 1,
      playedCount: 7,
      hand: [card],
      isBot: false,
      isOffline: false,
      timeoutCount: 0,
      trustee: false,
    });
  });

  it('2 人局的扣牌字段可选（3/4 人局缺省）', () => {
    const two = session({
      playerCount: 2,
      players: [0, 1].map((seat) => player(seat)),
      unusedCards: [{ r: 17, s: 1 }],
    });
    expect(two.unusedCards).toEqual([{ r: 17, s: 1 }]);
    expect('unusedCards' in session()).toBe(false);
  });

  it('pdk 专有规则字段：lastPlayedHand 存解析结果（出站视图另走 recentActions）', () => {
    const parsed = { type: 1, keyRank: 7, length: 0 };
    const s = session({ lastPlayedHand: parsed, lastPlayerIdx: 2 });
    expect(s.lastPlayedHand).toEqual(parsed);
    expect(s.lastPlayerIdx).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import type { DdzSettlementResult as ContractSettlementResult } from '@fight-the-landlord/protocol';
import { GameState, GamePlayer, GameSession, DdzSettlementResult } from './types';
import { createSession } from './game';

describe('GameState', () => {
  it('has expected values', () => {
    expect(GameState.Init).toBe('init');
    expect(GameState.Bidding).toBe('bidding');
    expect(GameState.Playing).toBe('playing');
    expect(GameState.Ended).toBe('ended');
  });
});

describe('GamePlayer', () => {
  it('creates valid player', () => {
    const player: GamePlayer = {
      id: 'user-1',
      seat: 0,
      hand: [],
      isLandlord: false,
      isBot: false,
      isOffline: false,
      timeoutCount: 0,
      trustee: false,
    };
    expect(player.seat).toBe(0);
    expect(player.isBot).toBe(false);
  });
});

describe('GameSession', () => {
  it('creates valid session', () => {
    const session: GameSession = {
      roomCode: 'ABC123',
      gameType: 'doudizhu',
      playerCount: 3,
      baseScore: 15,
      state: GameState.Init,
      players: [
        { id: 'user-1', seat: 0, hand: [], isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'user-2', seat: 1, hand: [], isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
        { id: 'user-3', seat: 2, hand: [], isLandlord: false, isBot: false, isOffline: false, timeoutCount: 0, trustee: false },
      ],
      bottomCards: [],
      currentPlayer: 0,
      lastPlayedHand: null,
      lastPlayerIdx: -1,
      version: 0,
      actionLog: [],
      bidPhase: {
        currentBidder: 0,
        landlordCaller: -1,
        landlordCandidate: -1,
        bidPasses: 0,
        grabActions: 0,
        bidMultiplier: 1,
        redealCount: 0,
        decisions: [],
        firstCaller: -1,
        antiRobGranted: false,
      },
      playPhase: {
        bombCount: 0,
        landlordPlays: 0,
        farmerPlays: 0,
        consecutivePasses: 0,
      },
      turnDeadlineAt: 0,
      createdAt: 0,
      finishedAt: null,
    };
    expect(session.players).toHaveLength(3);
    expect(session.version).toBe(0);
  });
});

describe('createSession', () => {
  it('createSession 写入传入的底分（唯一生产调用方 game.start 负责给值）', () => {
    const session = createSession('ROOM1', ['u1', 'u2', 'u3'], Math.random, 80);
    expect(session.baseScore).toBe(80);
  });

  it('省略第 4 参 ⇒ 0 哨兵（由 game.start 强校验拦下、settleGame 兜底）', () => {
    const session = createSession('ROOM1', ['u1', 'u2', 'u3']);
    expect(session.baseScore).toBe(0);
  });
});

describe('SettlementResult', () => {
  /** R182：shared 的 `SettlementResult` **就是** protocol 的那一个（没有第二个形状）。 */
  it('has the contract structure (roomCode/baseScore/landlordSeat/spring)', () => {
    const result: DdzSettlementResult = {
      roomCode: 'ROOM1',
      baseScore: 100,
      winner: 'landlord',
      landlordSeat: 0,
      farmerSeats: [1, 2],
      multiplier: 2,
      spring: 'none',
      landlordScoreChange: 400,
      farmerScoreChange: -200,
    };
    expect(result.landlordSeat).toBe(0);
    expect(result.farmerSeats).toHaveLength(2);
    expect(Object.keys(result)).toHaveLength(9);
  });

  /**
   * R182 的类型级判据：**双向**可赋值才叫「同一个形状」。
   * 任一侧漂移（多一个 `landlordSeats`、少一个 `baseScore`）都会让本文件 `tsc --noEmit` 红。
   */
  it('is exactly the protocol contract type (双向可赋值)', () => {
    const fromShared: DdzSettlementResult = {
      roomCode: 'ROOM1',
      baseScore: 100,
      winner: 'landlord',
      landlordSeat: 0,
      farmerSeats: [1, 2],
      multiplier: 2,
      spring: 'none',
      landlordScoreChange: 400,
      farmerScoreChange: -200,
    };
    const fromContract: ContractSettlementResult = fromShared;
    const backToShared: DdzSettlementResult = fromContract;
    expect(backToShared).toBe(fromShared);
  });
});

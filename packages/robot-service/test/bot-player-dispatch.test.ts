/**
 * Task 2.6：`bot.player` 的**玩法分派**。
 *
 * - 斗地主：既有路径逐字不变（DouZero → 规则降级）；
 * - 跑得快：S3.6 才实现规则 bot —— 在此之前必须**响亮拒绝**，绝不能拿 ddz 逻辑瞎猜。
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type {
  Card,
  PdkPlayerView,
  PdkRobotFeatures,
  PlayerView,
  RobotDecideRequest,
} from '@fight-the-landlord/protocol';
import { BotPlayer } from '../src/robot/bot.player';
import type { DouZeroClient } from '../src/robot/douzero.client';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';

const asCards = (ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));

function ddzRequest(): RobotDecideRequest {
  const view: PlayerView = {
    roomCode: 'ROOM-BOT',
    gameType: 'doudizhu',
    playerCount: 3,
    version: 5,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: asCards([3, 4, 5]),
    cardCounts: [3, 3, 3],
    trustees: [false, false, false],
    bottomCards: null,
    landlordSeat: 0,
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 0,
    bidPhase: {
      currentBidder: 0,
      bidMultiplier: 2,
      landlordCandidate: 0,
      grabActions: 3,
      redealCount: 0,
      kind: 'rob',
      decisions: [],
    },
    playPhase: { bombCount: 0 },
  };
  return {
    roomCode: 'ROOM-BOT',
    botId: 'bot-1234abcd',
    skillLevel: 'beginner',
    gameType: 'doudizhu',
    view,
    features: {
      gameType: 'doudizhu',
      position: 'landlord',
      lastMove: [],
      lastMovePosition: '',
      lastMoveMeta: null,
      numCardsLeft: { landlord: 3, landlord_down: 3, landlord_up: 3 },
      playedCards: { landlord: [], landlord_down: [], landlord_up: [] },
      actionSeq: [],
    },
  };
}

function pdkRequest(): RobotDecideRequest {
  const view: PdkPlayerView = {
    roomCode: 'ROOM-PDK',
    gameType: 'paodekuai',
    playerCount: 3,
    version: 2,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: asCards([3, 4, 5]),
    cardCounts: [3, 3, 3],
    trustees: [false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 0,
    canPass: false,
    bombCount: 0,
    pdkRules: {
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
    },
  };
  const features: PdkRobotFeatures = {
    gameType: 'paodekuai',
    seat: 0,
    lastMove: null,
    numCardsLeft: [3, 3, 3],
    playedCards: [[], [], []],
    actionSeq: [],
    passCount: 0,
    bombCount: 0,
    canPass: false,
    pdkRules: view.pdkRules,
  };
  return {
    roomCode: 'ROOM-PDK',
    botId: 'bot-1234abcd',
    skillLevel: 'beginner',
    gameType: 'paodekuai',
    view,
    features,
  };
}

describe('BotPlayer 玩法分派（Task 2.6）', () => {
  it('ddz：仍走既有 DouZero 路径（分派不改变斗地主行为）', async () => {
    const getMove = vi.fn().mockResolvedValue([3]);
    const player = new BotPlayer(
      { getMove } as unknown as DouZeroClient,
      asConfigCache(makeConfigCache()),
    );

    const decision = await player.decide(ddzRequest());

    expect(decision).toEqual({ kind: 'play', cards: [3], source: 'douzero' });
    expect(getMove).toHaveBeenCalledTimes(1);
  });

  it('pdk：走规则 bot（Task 3.6），绝不调用 DouZero、绝不套用 ddz 规则', async () => {
    const getMove = vi.fn();
    const player = new BotPlayer(
      { getMove } as unknown as DouZeroClient,
      asConfigCache(makeConfigCache()),
    );

    const decision = await player.decide(pdkRequest());

    expect(decision).toEqual({ kind: 'play', cards: [3], source: 'rule' });
    expect(getMove).not.toHaveBeenCalled();
  });
});

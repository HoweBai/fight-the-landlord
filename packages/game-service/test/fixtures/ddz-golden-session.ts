// packages/game-service/test/fixtures/ddz-golden-session.ts
//
// Task 0.1：斗地主 golden 夹具的**唯一会话构造**。
//
// 不依赖完整随机对局：手牌/底牌/叫抢/炸弹数全部写死，保证 fixture 可复现。
// 生成与回归测试共用本文件，避免两处各写一份会话。
import {
  GameState,
  createDeck,
  type GamePlayer,
  type GameSession,
} from '@fight-the-landlord/shared';

/** 固定时间戳（毫秒），避免 fixture 随运行时间漂移。 */
export const GOLDEN_CREATED_AT = 1_700_000_000_000;
export const GOLDEN_FINISHED_AT = 1_700_000_001_000;
export const GOLDEN_DEADLINE_AT = 1_700_000_030_000;

/**
 * 构造一局“地主已出完、农民各剩 17/17 张”的终局会话。
 *
 * - 地主 = seat 0，手牌为空 ⇒ `checkWinCondition` 返回 `landlord`；
 * - 炸弹数 = 1、叫抢倍数 = 2、无春天 ⇒ multiplier = 2 * 2 = 4；
 * - baseScore = 80 ⇒ landlordScoreChange = 640、farmerScoreChange = -320，零和。
 */
export function makeDdzGoldenSession(): GameSession {
  const deck = createDeck();
  const farmerOne = deck.slice(0, 17);
  const farmerTwo = deck.slice(17, 34);
  const bottomCards = deck.slice(34, 37);

  const players: GamePlayer[] = [
    {
      id: 'p_golden_0',
      seat: 0,
      hand: [],
      isLandlord: true,
      isBot: false,
      isOffline: false,
      timeoutCount: 0,
      trustee: false,
    },
    {
      id: 'p_golden_1',
      seat: 1,
      hand: farmerOne,
      isLandlord: false,
      isBot: false,
      isOffline: false,
      timeoutCount: 0,
      trustee: false,
    },
    {
      id: 'p_golden_2',
      seat: 2,
      hand: farmerTwo,
      isLandlord: false,
      isBot: false,
      isOffline: false,
      timeoutCount: 0,
      trustee: false,
    },
  ];

  return {
    roomCode: 'GOLDEN01',
    gameType: 'doudizhu',
    playerCount: 3,
    baseScore: 80,
    state: GameState.Ended,
    players,
    bottomCards,
    currentPlayer: 1,
    lastPlayedHand: null,
    lastPlayerIdx: 0,
    turnDeadlineAt: GOLDEN_DEADLINE_AT,
    version: 42,
    actionLog: [],
    bidPhase: {
      currentBidder: 0,
      landlordCaller: 0,
      landlordCandidate: 0,
      bidPasses: 0,
      grabActions: 3,
      bidMultiplier: 2,
      redealCount: 0,
      decisions: [
        { seat: 0, kind: 'call', grab: true },
        { seat: 1, kind: 'rob', grab: false },
        { seat: 2, kind: 'rob', grab: false },
      ],
      firstCaller: 0,
      antiRobGranted: false,
    },
    playPhase: {
      bombCount: 1,
      landlordPlays: 3,
      farmerPlays: 2,
      consecutivePasses: 0,
    },
    winner: 'landlord',
    createdAt: GOLDEN_CREATED_AT,
    finishedAt: GOLDEN_FINISHED_AT,
  };
}

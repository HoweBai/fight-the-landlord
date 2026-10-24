/**
 * 斗地主 runtime（S1 适配层）。
 *
 * ⚠️ **行为零变化**：本类只把既有 `shared/ddz/*` 纯函数与既有 view/record 投影接到
 * `GameRuntime` 接口上；任何规则判定都不在 game-service 里重写。
 */
import {
  GAME_META,
  encodeCards,
  encodeHand,
  type GameType,
  type GameView,
  type RobotFeatures,
  type SettlementResult,
} from '@fight-the-landlord/protocol';
import {
  GameState,
  HandType,
  buildPublicFeatures,
  checkWinCondition,
  createSession,
  dealCards,
  findSmallestBeatingCards,
  handleBid,
  handlePass,
  handlePlayCards,
  handlePlayTimeout,
  settleGame,
  turnDurationFor,
  type BeatTarget,
  type GameAction,
  type GameSession,
  type GovernanceDurations,
} from '@fight-the-landlord/shared';
import type {
  CreateGameInput,
  GameRobotInput,
  GameRuntime,
  RecordEnvelope,
  RuntimeCtx,
  Transition,
} from '../runtime';
import { buildAllSeatViews, buildPlayerView } from './view';

export class DdzRuntime implements GameRuntime<GameSession> {
  readonly gameType: GameType = 'doudizhu';
  readonly meta = GAME_META.doudizhu;

  create(input: CreateGameInput): GameSession {
    const session = createSession(
      input.roomCode,
      input.players.map((p) => p.id),
      input.random,
      input.baseScore,
    );
    session.botIds = input.players.map((p) => (p.isRobot ? p.botId : undefined));
    session.botSkillLevels = input.players.map((p) => (p.isRobot ? p.skillLevel : undefined));
    session.botThinkingSpeeds = input.players.map((p) => (p.isRobot ? p.thinkingSpeed : undefined));
    return dealCards(session);
  }

  applyAction(
    session: GameSession,
    action: GameAction,
    ctx: RuntimeCtx,
  ): Transition<GameSession> {
    const playerId = session.players[ctx.actorSeat]?.id;
    if (!playerId) throw new Error(`ddz action impossible: seat ${ctx.actorSeat} has no player`);

    let updated: GameSession;
    if (action.kind === 'bid') {
      updated = handleBid(session, playerId, action.grab, ctx.random);
    } else if (action.kind === 'play') {
      updated = handlePlayCards(session, playerId, action.cards);
    } else {
      updated = handlePass(session, playerId);
    }
    return { session: updated, ended: this.isFinished(updated) };
  }

  onTimeout(session: GameSession, ctx: RuntimeCtx): Transition<GameSession> {
    const playerId = session.players[ctx.actorSeat]?.id;
    if (!playerId) throw new Error(`ddz timeout impossible: seat ${ctx.actorSeat} has no player`);
    const updated =
      session.state === GameState.Bidding
        ? handleBid(session, playerId, false, ctx.random)
        : handlePlayTimeout(session, playerId);
    return { session: updated, ended: this.isFinished(updated) };
  }

  isFinished(session: GameSession): boolean {
    return checkWinCondition(session) !== null;
  }

  finish(session: GameSession, now: number): GameSession {
    const winner = checkWinCondition(session);
    if (!winner) return session;
    return {
      ...session,
      winner,
      state: GameState.Ended,
      finishedAt: now,
    };
  }

  settle(session: GameSession): SettlementResult {
    return settleGame(session);
  }

  buildView(session: GameSession, seat: number): GameView {
    return buildPlayerView(session, seat);
  }

  buildAllViews(session: GameSession): GameView[] {
    return buildAllSeatViews(session);
  }

  buildRobotInput(session: GameSession, seat: number): GameRobotInput {
    const features: RobotFeatures = buildPublicFeatures(session, seat);
    return { view: buildPlayerView(session, seat), features };
  }

  buildRecord(session: GameSession): RecordEnvelope | undefined {
    const initialHands = session.initialHands;
    if (!initialHands) return undefined;
    try {
      return {
        startedAt: session.createdAt,
        seats: session.players.map((p, seat) => ({
          seat,
          playerId: p.id,
          hand: encodeHand(initialHands[seat]!, 17),
        })),
        bottomCards: encodeCards(session.bottomCards, 3),
        gameType: 'doudizhu',
        playerCount: 3,
      };
    } catch {
      // 记录面绝不因编码失败阻断终局发布（既有窗口守卫同口径）。
      return undefined;
    }
  }

  currentActor(session: GameSession): number {
    return session.state === GameState.Bidding
      ? session.bidPhase.currentBidder
      : session.currentPlayer;
  }

  timerPhase(session: GameSession): 'bid' | 'play' {
    return session.state === GameState.Bidding ? 'bid' : 'play';
  }

  turnDuration(session: GameSession, seat: number, policy: GovernanceDurations): number {
    return turnDurationFor(session.players[seat]!, policy);
  }

  autoAction(session: GameSession, seat: number): GameAction {
    if (session.state === GameState.Bidding) return { kind: 'bid', grab: false };
    const hand = session.players[seat]!.hand;
    const target: BeatTarget = session.lastPlayedHand ?? {
      type: HandType.Invalid,
      keyRank: 0,
      length: 0,
    };
    const beating = findSmallestBeatingCards(hand, target);
    return beating && beating.length > 0
      ? { kind: 'play', cards: beating }
      : { kind: 'pass' };
  }
}

/** 四川麻将 runtime（game-service 适配层；规则全在 shared/mahjong）。 */
import {
  GAME_META,
  type GameType,
  type GameView,
  type MahjongPlayerView,
  type MahjongRecordEnvelope,
  type MahjongRobotFeatures,
  type SettlementResult,
  type Tile,
} from '@fight-the-landlord/protocol';
import {
  applyMahjongAction,
  autoAction,
  createMahjongSession,
  finishMahjong,
  isMahjongFinished,
  parseMahjongRules,
  settleMahjong,
  timeoutMahjong,
  turnDurationFor,
  type GameAction,
  type GovernanceDurations,
  type MahjongSession,
} from '@fight-the-landlord/shared';
import type {
  CreateGameInput,
  GameRobotInput,
  GameRuntime,
  RecordEnvelope,
  RuntimeCtx,
  Transition,
} from '../runtime';
import { buildAllMahjongViews, buildMahjongView } from './view';
import { buildMahjongRecord } from './record';

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class MahjongRuntime implements GameRuntime<MahjongSession> {
  readonly gameType: GameType = 'mahjong';
  readonly meta = GAME_META.mahjong;

  create(input: CreateGameInput): MahjongSession {
    if (input.gameType !== 'mahjong') {
      throw new Error(`MahjongRuntime.create requires gameType=mahjong, got ${input.gameType}`);
    }
    if (input.playerCount !== 4) {
      throw new Error(`mahjong requires playerCount 4, got ${String(input.playerCount)}`);
    }
    const rules = parseMahjongRules(input.rules);
    const ordered = [...input.players].sort((a, b) => a.seat - b.seat);
    const session = createMahjongSession({
      roomCode: input.roomCode,
      baseScore: input.baseScore,
      rules,
      players: ordered.map((p) => ({ id: p.id, seat: p.seat, isBot: p.isRobot })),
      random: input.seed === undefined ? input.random : seededRandom(input.seed),
      testWall: input.testTiles,
      rngSeed: input.seed === undefined ? undefined : String(input.seed),
      createdAt: Date.now(),
    });
    session.botIds = ordered.map((p) => (p.isRobot ? p.botId : undefined));
    session.botSkillLevels = ordered.map((p) => (p.isRobot ? p.skillLevel : undefined));
    session.botThinkingSpeeds = ordered.map((p) => (p.isRobot ? p.thinkingSpeed : undefined));
    return session;
  }

  applyAction(
    session: MahjongSession,
    action: GameAction,
    ctx: RuntimeCtx,
  ): Transition<MahjongSession> {
    if (action.kind !== 'mahjong') {
      throw new Error(`mahjong does not support action kind "${action.kind}"`);
    }
    const updated = applyMahjongAction(session, ctx.actorSeat, action.action, ctx.random);
    updated.actionLog = [
      ...updated.actionLog,
      { version: updated.version, seat: ctx.actorSeat, action: action.action },
    ];
    return { session: updated, ended: this.isFinished(updated) };
  }

  onTimeout(session: MahjongSession, ctx: RuntimeCtx): Transition<MahjongSession> {
    const updated = timeoutMahjong(session, ctx.random);
    return { session: updated, ended: this.isFinished(updated) };
  }

  isFinished(session: MahjongSession): boolean {
    return isMahjongFinished(session);
  }

  finish(session: MahjongSession, now: number): MahjongSession {
    return finishMahjong(session, now);
  }

  settle(session: MahjongSession): SettlementResult {
    return settleMahjong(session);
  }

  buildView(session: MahjongSession, seat: number): GameView {
    return buildMahjongView(session, seat);
  }

  buildAllViews(session: MahjongSession): GameView[] {
    return buildAllMahjongViews(session);
  }

  buildRobotInput(session: MahjongSession, seat: number): GameRobotInput {
    const view = buildMahjongView(session, seat) as MahjongPlayerView;
    const features: MahjongRobotFeatures = {
      gameType: 'mahjong',
      seat,
      phase: session.state,
      wallCount: session.wall.length,
      melds: session.players.map((p) => p.melds.map((m) => ({ ...m, tiles: [...m.tiles] }))),
      discards: session.players.map((p) => [...p.discards]),
      lackSuits: session.players.map((p) => p.lackSuit),
      isOut: session.players.map((p) => p.isOut),
      activeSeats: this.pendingActors(session),
      lastDiscard: session.lastDiscard,
      lastDraw: session.lastDraw === null ? null : { seat: session.lastDraw.seat, fromKong: session.lastDraw.fromKong },
      claimsForMe: view.claimsForMe,
    };
    return { view, features };
  }

  buildRecord(session: MahjongSession): RecordEnvelope | undefined {
    return buildMahjongRecord(session) as MahjongRecordEnvelope;
  }

  currentActor(session: MahjongSession): number {
    if (session.state === 'exchange') {
      return session.players.find((p) => p.exchangePick.length === 0)?.seat ?? -1;
    }
    if (session.state === 'lack') {
      return session.players.find((p) => p.lackSuit === null)?.seat ?? -1;
    }
    if (session.state === 'play') return session.currentPlayer;
    if (session.state === 'claim') {
      const pc = session.pendingClaims;
      if (!pc) return -1;
      return pc.candidates.find((s) => !pc.responses.some((r) => r.seat === s)) ?? -1;
    }
    return -1;
  }

  timerPhase(_session: MahjongSession): 'bid' | 'play' {
    return 'play';
  }

  turnDuration(session: MahjongSession, seat: number, policy: GovernanceDurations): number {
    const player = session.players.find((p) => p.seat === seat);
    if (!player) throw new Error(`Player at seat ${seat} not found`);
    return turnDurationFor(player, policy);
  }

  autoAction(session: MahjongSession, seat: number): GameAction {
    return { kind: 'mahjong', action: autoAction(session, seat) };
  }

  pendingActors(session: MahjongSession): number[] {
    if (session.state === 'exchange') {
      return session.players.filter((p) => p.exchangePick.length === 0).map((p) => p.seat);
    }
    if (session.state === 'lack') {
      return session.players.filter((p) => p.lackSuit === null).map((p) => p.seat);
    }
    if (session.state === 'claim') {
      const pc = session.pendingClaims;
      if (!pc) return [];
      return pc.candidates.filter((s) => !pc.responses.some((r) => r.seat === s));
    }
    if (session.state === 'play') return [session.currentPlayer];
    return [];
  }

  acceptsAction(session: MahjongSession, seat: number): boolean {
    return this.pendingActors(session).includes(seat);
  }

  windowId(session: MahjongSession): string {
    return session.windowId;
  }

  windowDuration(session: MahjongSession, policy: GovernanceDurations): number {
    if (session.state === 'exchange') return session.rules.exchangeWindowMs;
    if (session.state === 'lack') return session.rules.lackWindowMs;
    if (session.state === 'claim') return session.rules.claimWindowMs;
    if (session.state === 'play') return this.turnDuration(session, session.currentPlayer, policy);
    return policy.normal;
  }
}

export { seededRandom };
export type { Tile };

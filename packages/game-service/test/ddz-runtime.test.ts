import { describe, it, expect, vi } from 'vitest';
import { GameState, createDeck, settleGame, type GameSession } from '@fight-the-landlord/shared';
import { DdzRuntime } from '../src/games/ddz/runtime';
import { buildPlayerView } from '../src/game/view.builder';
import { makeDdzGoldenSession } from './fixtures/ddz-golden-session';

const PLAYERS = [
  { id: 'p0', seat: 0, isRobot: false },
  { id: 'p1', seat: 1, isRobot: false },
  { id: 'p2', seat: 2, isRobot: false },
];
const POLICY = { normal: 30_000, accel: 10_000, trustee: 2_000, after: 3 };

function biddingSession(): GameSession {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  try {
    return new DdzRuntime().create({
      roomCode: 'RT01',
      gameType: 'doudizhu',
      playerCount: 3,
      baseScore: 80,
      players: PLAYERS,
      random: () => 0.5,
    });
  } finally {
    spy.mockRestore();
  }
}

describe('DdzRuntime（适配层，行为不变）', () => {
  it('create：发牌到 bidding，三家 17 张 + 底牌 3 张', () => {
    const session = biddingSession();
    expect(session.gameType).toBe('doudizhu');
    expect(session.playerCount).toBe(3);
    expect(session.state).toBe(GameState.Bidding);
    expect(session.players.map((p) => p.hand.length)).toEqual([17, 17, 17]);
    expect(session.bottomCards).toHaveLength(3);
    expect(session.version).toBe(1);
  });

  it('applyAction bid：版本 +1，走既有 handleBid', () => {
    const session = biddingSession();
    const seat = new DdzRuntime().currentActor(session);
    const result = new DdzRuntime().applyAction(
      session,
      { kind: 'bid', grab: true },
      { now: 0, random: () => 0.5, governance: POLICY, actorSeat: seat },
    );
    expect(result.session.version).toBe(session.version + 1);
    expect(result.ended).toBe(false);
  });

  it('onTimeout 叫抢：恒不抢（handleBid false）', () => {
    const session = biddingSession();
    const runtime = new DdzRuntime();
    const seat = runtime.currentActor(session);
    const result = runtime.onTimeout(session, {
      now: 0,
      random: () => 0.5,
      governance: POLICY,
      actorSeat: seat,
    });
    expect(result.session.version).toBe(session.version + 1);
  });

  it('finish/settle/view 与既有函数一致', () => {
    const golden = makeDdzGoldenSession();
    const runtime = new DdzRuntime();

    const finished = runtime.finish({ ...golden, state: GameState.Playing, winner: undefined }, 123);
    expect(finished.state).toBe(GameState.Ended);
    expect(finished.winner).toBe('landlord');
    expect(finished.finishedAt).toBe(123);

    expect(runtime.settle(golden)).toEqual(settleGame(golden));
    expect(runtime.buildView(golden, 1)).toEqual(buildPlayerView(golden, 1));
    expect(runtime.buildAllViews(golden)).toHaveLength(3);
  });

  it('buildRecord：无 initialHands ⇒ undefined；有 ⇒ 16/3 张编码', () => {
    const golden = makeDdzGoldenSession();
    const runtime = new DdzRuntime();
    expect(runtime.buildRecord(golden)).toBeUndefined();

    const deck = createDeck();
    const withHands = {
      ...golden,
      initialHands: [deck.slice(0, 17), deck.slice(17, 34), deck.slice(34, 51)],
    };
    const record = runtime.buildRecord(withHands);
    expect(record).toBeDefined();
    if (!record || !('bottomCards' in record)) throw new Error('expected ddz record envelope');
    expect(record.seats).toHaveLength(3);
    expect(record.bottomCards).toHaveLength(6);
    expect(record.seats[0]!.hand).toHaveLength(34); // 初始手牌快照：17 张 × 2 hex
  });

  it('currentActor/timerPhase/turnDuration/autoAction', () => {
    const session = biddingSession();
    const runtime = new DdzRuntime();
    expect(runtime.timerPhase(session)).toBe('bid');
    expect(runtime.currentActor(session)).toBe(session.bidPhase.currentBidder);
    expect(runtime.turnDuration(session, 0, POLICY)).toBe(POLICY.normal);
    expect(runtime.autoAction(session, runtime.currentActor(session))).toEqual({
      kind: 'bid',
      grab: false,
    });

    const playing = { ...session, state: GameState.Playing };
    expect(runtime.timerPhase(playing)).toBe('play');
    const action = runtime.autoAction(playing, 1);
    expect(['play', 'pass']).toContain(action.kind);
  });
});

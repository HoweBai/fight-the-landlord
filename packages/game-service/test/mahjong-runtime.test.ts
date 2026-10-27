import { describe, expect, it } from 'vitest';
import { createMahjongDeck, DEFAULT_CHENGDU_RULES } from '@fight-the-landlord/shared';
import { MahjongRuntime } from '../src/games/mahjong/runtime';

const runtime = new MahjongRuntime();
const ctx = (seat: number) => ({ now: Date.now(), random: () => 0, governance: { normal: 1500, accel: 1000, trustee: 400, after: 3 }, actorSeat: seat });

function create() {
  return runtime.create({
    roomCode: 'MJ1',
    gameType: 'mahjong',
    playerCount: 4,
    baseScore: 10,
    players: [0, 1, 2, 3].map((seat) => ({ id: `p${seat}`, seat, isRobot: false })),
    rules: DEFAULT_CHENGDU_RULES,
    random: () => 0,
    testTiles: createMahjongDeck(),
  });
}

describe('MahjongRuntime', () => {
  it('换三张/定缺 → play；窗口与视图', () => {
    let s = create();
    expect(s.state).toBe('exchange');
    for (const seat of [0, 1, 2, 3]) {
      s = runtime.applyAction(s, runtime.autoAction(s, seat), ctx(seat)).session;
    }
    expect(s.state).toBe('lack');
    for (const seat of [0, 1, 2, 3]) {
      s = runtime.applyAction(s, runtime.autoAction(s, seat), ctx(seat)).session;
    }
    expect(s.state).toBe('play');
    expect(s.players[s.dealerSeat]!.hand.length).toBe(14);
    expect(s.wall.length).toBe(55);
    expect(runtime.pendingActors(s)).toEqual([s.currentPlayer]);
    const view = runtime.buildView(s, 0);
    expect(view.gameType).toBe('mahjong');
    expect((view as unknown as Record<string, unknown>).wall).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).rngSeed).toBeUndefined();
    expect(Array.isArray(view.hand)).toBe(true);
  });

  it('windowId/windowDuration：exchange/claim/play 不同', () => {
    const s = create();
    expect(runtime.windowId(s)).toBe('exchange');
    expect(runtime.windowDuration(s, ctx(0).governance)).toBe(DEFAULT_CHENGDU_RULES.exchangeWindowMs);
    s.state = 'claim';
    s.pendingClaims = { kind: 'claim', discard: { s: 0, r: 1 }, fromSeat: 0, candidates: [1], responses: [] };
    expect(runtime.windowDuration(s, ctx(0).governance)).toBe(DEFAULT_CHENGDU_RULES.claimWindowMs);
    s.state = 'play';
    expect(runtime.windowDuration(s, ctx(0).governance)).toBe(1500);
  });
});

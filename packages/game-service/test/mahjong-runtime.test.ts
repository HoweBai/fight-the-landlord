import { describe, expect, it } from 'vitest';
import { canDiscard, createMahjongDeck, DEFAULT_CHENGDU_RULES, hasLackTiles } from '@fight-the-landlord/shared';
import { validateOutbound, type MahjongPlayerView } from '@fight-the-landlord/protocol';
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

function advanceToPlay() {
  let s = create();
  for (const seat of [0, 1, 2, 3]) {
    s = runtime.applyAction(s, runtime.autoAction(s, seat), ctx(seat)).session;
  }
  for (const seat of [0, 1, 2, 3]) {
    s = runtime.applyAction(s, runtime.autoAction(s, seat), ctx(seat)).session;
  }
  return s;
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

  it('mustDiscardSuit 按查看者投影（不跟 currentPlayer 走）', () => {
    const s = advanceToPlay();
    const t = (suit: 0 | 1 | 2, rank: number) => ({ s: suit, r: rank });
    s.players[0]!.lackSuit = 0;
    s.players[0]!.hand = [t(0, 1), ...Array.from({ length: 12 }, (_, i) => t(1, (i % 9) + 1))];
    s.players[1]!.lackSuit = 1;
    s.players[1]!.hand = Array.from({ length: 13 }, (_, i) => t(0, (i % 9) + 1));
    s.currentPlayer = 0;
    const view0 = runtime.buildView(s, 0) as MahjongPlayerView;
    const view1 = runtime.buildView(s, 1) as MahjongPlayerView;
    expect(view0.mustDiscardSuit).toBe(0);
    expect(view1.mustDiscardSuit).toBe(null);
    s.currentPlayer = 1;
    expect((runtime.buildView(s, 0) as MahjongPlayerView).mustDiscardSuit).toBe(0);
    expect((runtime.buildView(s, 1) as MahjongPlayerView).mustDiscardSuit).toBe(null);
    // 此处与生产共用 hasLackTiles（抓接线错误）；公式级独立 oracle 在 conformance driver。
    for (const v of [view0, view1]) {
      const lack = v.lackSuits[v.seat]!;
      const expected = lack !== null && hasLackTiles(v.hand, lack) ? lack : null;
      expect(v.mustDiscardSuit ?? null, `seat ${v.seat}`).toBe(expected);
    }
    expect(canDiscard(view0.hand, 0, { s: 1, r: 1 })).toBe(false);
    expect(canDiscard(view0.hand, 0, { s: 0, r: 1 })).toBe(true);
    expect(canDiscard(view1.hand, 1, { s: 0, r: 1 })).toBe(true);
    s.players[0]!.hand = Array.from({ length: 13 }, (_, i) => t(1, (i % 9) + 1));
    expect((runtime.buildView(s, 0) as MahjongPlayerView).mustDiscardSuit).toBe(null);
    // 未定缺 ⇒ null
    s.players[2]!.lackSuit = null;
    expect((runtime.buildView(s, 2) as MahjongPlayerView).mustDiscardSuit).toBe(null);
    // 与生产同源的出站校验（gateway 会整帧丢弃不一致视图）
    expect(() =>
      validateOutbound({ type: 'game.state_update', version: view0.version, payload: view0 }),
    ).not.toThrow();
    // 非 play 阶段也带（客户端自行按阶段使用）
    s.state = 'lack';
    s.players[0]!.hand = [t(0, 1), ...Array.from({ length: 12 }, (_, i) => t(1, (i % 9) + 1))];
    expect((runtime.buildView(s, 0) as MahjongPlayerView).mustDiscardSuit).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { Tile } from '@fight-the-landlord/protocol';
import { createMahjongDeck } from './deck';
import { createMahjongSession, finishMahjong } from './session';
import { applyMahjongAction, autoAction, timeoutMahjong } from './actions';
import { DEFAULT_CHENGDU_RULES } from './rules';
import { settleMahjong } from './settle';

const t = (s: 0 | 1 | 2, r: number): Tile => ({ s, r });
const ranks = (s: 0 | 1 | 2, rs: number[]): Tile[] => rs.map((r) => t(s, r));

function makeGame(hands: Tile[][], currentPlayer = 0) {
  const s = createMahjongSession({
    roomCode: 'R',
    baseScore: 10,
    players: [0, 1, 2, 3].map((seat) => ({ id: `p${seat}`, seat, isBot: false })),
    rules: DEFAULT_CHENGDU_RULES,
    random: () => 0,
    testWall: createMahjongDeck(),
  });
  s.players.forEach((p, i) => {
    p.hand = [...hands[i]!];
    p.lackSuit = 2; // 缺条
    p.exchangePick = [];
    p.isOut = false;
    p.hu = null;
  });
  s.wall = createMahjongDeck().slice(52);
  s.wallCount = s.wall.length;
  s.state = 'play';
  s.currentPlayer = currentPlayer;
  s.windowId = 'turn:1';
  s.windowSeq = 1;
  s.lastDraw = null;
  s.lastDiscard = null;
  s.pendingClaims = null;
  return s;
}

describe('mahjong exchange/lack flow', () => {
  it('换三张 → 定缺 → 庄家摸第 14 张', () => {
    let s = createMahjongSession({
      roomCode: 'R',
      baseScore: 10,
      players: [0, 1, 2, 3].map((seat) => ({ id: `p${seat}`, seat, isBot: false })),
      rules: DEFAULT_CHENGDU_RULES,
      random: () => 0,
      testWall: createMahjongDeck(),
    });
    expect(s.state).toBe('exchange');
    for (const seat of [0, 1, 2, 3]) {
      s = applyMahjongAction(s, seat, autoAction(s, seat), () => 0);
    }
    expect(s.state).toBe('lack');
    expect(s.players.every((p) => p.hand.length === 13)).toBe(true);
    for (const seat of [0, 1, 2, 3]) {
      s = applyMahjongAction(s, seat, autoAction(s, seat), () => 0);
    }
    expect(s.state).toBe('play');
    expect(s.players[s.dealerSeat]!.hand.length).toBe(14);
    expect(s.wall.length).toBe(55);
  });

  it('超时自动完成换三张/定缺', () => {
    let s = createMahjongSession({
      roomCode: 'R',
      baseScore: 10,
      players: [0, 1, 2, 3].map((seat) => ({ id: `p${seat}`, seat, isBot: false })),
      rules: DEFAULT_CHENGDU_RULES,
      random: () => 0,
      testWall: createMahjongDeck(),
    });
    s = timeoutMahjong(s, () => 0);
    expect(s.state).toBe('lack');
    s = timeoutMahjong(s, () => 0);
    expect(s.state).toBe('play');
  });
});

describe('mahjong discard/claim/settle', () => {
  const waiting = [...ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9]), ...ranks(1, [1, 1, 2, 3])];
  const discarder = [t(1, 4), ...ranks(0, [1, 1, 2, 2, 3, 3, 5, 5, 6, 6, 7, 7])];
  const junk = ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4]);

  it('点炮胡：候选、胡事件、离场、下一家摸牌', () => {
    let s = makeGame([discarder, waiting, junk, junk], 0);
    s = applyMahjongAction(s, 0, { type: 'discard', tile: t(1, 4) }, () => 0);
    expect(s.state).toBe('claim');
    expect(s.pendingClaims?.candidates).toContain(1);
    s = applyMahjongAction(s, 1, { type: 'claim', claim: 'hu' }, () => 0);
    expect(s.players[1]!.isOut).toBe(true);
    expect(s.players[1]!.hu?.fromSeat).toBe(0);
    const hu = s.scoreEvents.find((e) => e.kind === 'hu');
    expect(hu).toBeTruthy();
    expect(s.state === 'play' || s.state === 'ended').toBe(true);
  });

  it('结算事件账零和；点炮者付赢家', () => {
    let s = makeGame([discarder, waiting, junk, junk], 0);
    s = applyMahjongAction(s, 0, { type: 'discard', tile: t(1, 4) }, () => 0);
    s = applyMahjongAction(s, 1, { type: 'claim', claim: 'hu' }, () => 0);
    s.endReason = 'threeWinners';
    s.liuju = false;
    const ended = finishMahjong(s, Date.now());
    const result = settleMahjong(ended);
    expect(result.scoreChanges.reduce((a, b) => a + b.delta, 0)).toBe(0);
    const hu = result.events.find((e) => e.kind === 'hu');
    expect(hu).toBeTruthy();
    expect(result.winnerSeats).toContain(1);
  });

  it('最后四张强胡：pass 被拒', () => {
    let s = makeGame([discarder, waiting, junk, junk], 0);
    s.wall = s.wall.slice(0, 3);
    s.wallCount = 3;
    s = applyMahjongAction(s, 0, { type: 'discard', tile: t(1, 4) }, () => 0);
    expect(() => applyMahjongAction(s, 1, { type: 'claim', claim: 'pass' }, () => 0)).toThrow(/能胡必胡/);
  });
});

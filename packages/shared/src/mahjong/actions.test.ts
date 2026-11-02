import { describe, expect, it } from 'vitest';
import type { Tile } from '@fight-the-landlord/protocol';
import { createMahjongDeck } from './deck';
import { createMahjongSession, finishMahjong } from './session';
import { applyMahjongAction, autoAction, timeoutMahjong } from './actions';
import { DEFAULT_CHENGDU_RULES } from './rules';
import { settleMahjong } from './settle';

const t = (s: 0 | 1 | 2, r: number): Tile => ({ s, r });
const ranks = (s: 0 | 1 | 2, rs: number[]): Tile[] => rs.map((r) => t(s, r));

function makeGame(hands: Tile[][], currentPlayer = 0, rules = DEFAULT_CHENGDU_RULES) {
  const s = createMahjongSession({
    roomCode: 'R',
    baseScore: 10,
    players: [0, 1, 2, 3].map((seat) => ({ id: `p${seat}`, seat, isBot: false })),
    rules,
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

describe('杠上炮：呼叫转移 / 退回', () => {
  // p0 暗杠 5筒 → 补牌 4筒 → 打 4筒；p1 手牌听 4筒。
  const gangHand = [...ranks(1, [5, 5, 5, 5]), ...ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9])];
  const waiting4 = [...ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9]), ...ranks(1, [1, 1, 2, 3])];
  const junk = ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4]);

  function gangShoot(rules = DEFAULT_CHENGDU_RULES) {
    let s = makeGame([gangHand, waiting4, junk, junk], 0, rules);
    s.wall = [t(1, 4), ...createMahjongDeck().slice(52)];
    s.wallCount = s.wall.length;
    s = applyMahjongAction(s, 0, { type: 'concealedGang', tile: t(1, 5) }, () => 0);
    s = applyMahjongAction(s, 0, { type: 'discard', tile: t(1, 4) }, () => 0);
    s = applyMahjongAction(s, 1, { type: 'claim', claim: 'hu' }, () => 0);
    return s;
  }

  it('toEachWinner：杠分全额转给每个赢家（事件顺序在胡之前）', () => {
    const s = gangShoot();
    const gang = s.scoreEvents.find((e) => e.kind === 'gang')!;
    expect(gang.kind).toBe('gang');
    // 暗杠：其余 3 家各 2×底 = 20 ⇒ 总 60。
    const total = gang.kind === 'gang' ? gang.payers.reduce((a, p) => a + p.amount, 0) : 0;
    expect(total).toBe(60);
    const transferIdx = s.scoreEvents.findIndex(
      (e) => e.kind === 'transfer' && e.ref === gang.seq,
    );
    const huIdx = s.scoreEvents.findIndex((e) => e.kind === 'hu');
    expect(transferIdx).toBeGreaterThan(-1);
    expect(transferIdx).toBeLessThan(huIdx);
    const transfer = s.scoreEvents[transferIdx]!;
    expect(transfer).toMatchObject({
      kind: 'transfer',
      fromSeat: 0,
      toSeat: 1,
      amount: 60,
      reason: 'gangShoot',
    });
    const hu = s.scoreEvents.find((e) => e.kind === 'hu');
    expect(hu && hu.kind === 'hu' ? hu.items.join('|') : '').toContain('杠上炮');
  });

  it('none：杠分退回原付款人（shootAfterGang），不产生转移', () => {
    const s = gangShoot({ ...DEFAULT_CHENGDU_RULES, gangTransfer: 'none' });
    const gang = s.scoreEvents.find((e) => e.kind === 'gang')!;
    const refund = s.scoreEvents.find((e) => e.kind === 'refund' && e.ref === gang.seq);
    expect(refund).toMatchObject({ kind: 'refund', reason: 'shootAfterGang', fromSeat: 0 });
    if (refund?.kind === 'refund') {
      expect(refund.toSeats.map((x) => x.amount)).toEqual([20, 20, 20]);
    }
    expect(s.scoreEvents.some((e) => e.kind === 'transfer')).toBe(false);
  });

  it('荒庄退税不得重复退已转移/已退回的杠分', () => {
    const s = gangShoot();
    s.endReason = 'wallEmpty';
    s.liuju = true;
    const resulted = settleMahjong(finishMahjong(s, Date.now()));
    const gang = resulted.events.find((e) => e.kind === 'gang')!;
    const refs = resulted.events.filter(
      (e) => (e.kind === 'transfer' || e.kind === 'refund') && e.ref === gang.seq,
    );
    expect(refs).toHaveLength(1);
    expect(resulted.events.every((e) => !(e.kind === 'refund' && e.reason === 'notReady' && e.ref === gang.seq))).toBe(true);
  });
});

describe('整局自动推进（超时/托管同一条自动决策）', () => {
  it('从发牌到结束：状态机不卡死，结算零和且事件账可重算', () => {
    let s = createMahjongSession({
      roomCode: 'AUTO',
      baseScore: 1,
      players: [0, 1, 2, 3].map((seat) => ({ id: `p${seat}`, seat, isBot: true })),
      rules: DEFAULT_CHENGDU_RULES,
      random: () => 0,
      testWall: createMahjongDeck(),
    });
    let guard = 0;
    while (s.state !== 'ended' && guard < 2000) {
      s = timeoutMahjong(s, () => 0);
      guard += 1;
    }
    expect(s.state, `状态机在 ${guard} 步后仍未结束`).toBe('ended');
    const result = settleMahjong(s);
    expect(result.scoreChanges.reduce((a, b) => a + b.delta, 0)).toBe(0);
    // 事件账独立重算必须与 scoreChanges 一致（资金层截断前的前置）。
    const deltas = [0, 0, 0, 0];
    for (const e of result.events) {
      if (e.kind === 'gang' || e.kind === 'hu') {
        for (const p of e.payers) {
          deltas[p.seat]! -= p.amount;
          deltas[e.seat]! += p.amount;
        }
      } else if (e.kind === 'transfer') {
        deltas[e.fromSeat]! -= e.amount;
        deltas[e.toSeat]! += e.amount;
      } else if (e.kind === 'refund') {
        for (const p of e.toSeats) {
          deltas[e.fromSeat]! -= p.amount;
          deltas[p.seat]! += p.amount;
        }
      } else if (e.kind === 'chajiao') {
        deltas[e.fromSeat]! -= e.amount;
        deltas[e.toSeat]! += e.amount;
      } else if (e.kind === 'huazhu' && e.mode === 'payEach') {
        for (const p of e.payees) {
          deltas[e.seat]! -= p.amount;
          deltas[p.seat]! += p.amount;
        }
      }
    }
    expect(result.scoreChanges.map((c) => c.delta)).toEqual(deltas);
  });
});

describe('缺门与抢杠边界', () => {
  it('缺门牌不能暗杠（即使手上有 4 张）', () => {
    const hand = [t(0, 1), t(0, 1), t(0, 1), t(0, 1), ...ranks(1, [2, 3, 4, 5, 6, 7, 8, 9, 1])];
    const s = makeGame([hand, ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4]), ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4]), ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4])], 0);
    s.players[0]!.lackSuit = 0; // 缺万
    expect(() => applyMahjongAction(s, 0, { type: 'concealedGang', tile: t(0, 1) }, () => 0)).toThrow(
      /缺门牌不能杠/,
    );
  });

  it('抢杠一炮多响：两个赢家都能胡（物理牌只移除一次）', () => {
    const p0 = [t(1, 7), ...ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9])];
    const wait7 = [...ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9]), ...ranks(1, [4, 5, 6]), t(1, 7)];
    const junk = ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4]);
    let s = makeGame([p0, wait7, wait7, junk], 0);
    s.players[0]!.melds = [{ kind: 'peng', tiles: [t(1, 7), t(1, 7), t(1, 7)], fromSeat: 1 }];
    s = applyMahjongAction(s, 0, { type: 'addedGang', tile: t(1, 7) }, () => 0);
    expect(s.state).toBe('claim');
    expect(s.pendingClaims?.kind).toBe('rob');
    s = applyMahjongAction(s, 1, { type: 'claim', claim: 'hu' }, () => 0);
    s = applyMahjongAction(s, 2, { type: 'claim', claim: 'hu' }, () => 0);
    const ended = s;
    expect(ended.players[1]!.isOut).toBe(true);
    expect(ended.players[2]!.isOut).toBe(true);
    // 抢杠窗口不继承杠后补牌标志 ⇒ 不额外算杠上炮。
    const hu2 = ended.scoreEvents.filter((e) => e.kind === 'hu');
    expect(hu2).toHaveLength(2);
    for (const e of hu2) {
      if (e.kind === 'hu') expect(e.items.join('|')).not.toContain('杠上炮');
    }
  });
});

describe('endReason 修复 + 结算新字段', () => {
  it('wallEmptyWithHu：墙空但有人已胡 → 不生成 wallEmpty 专属事件', () => {
    let s = makeGame([
      ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ranks(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ranks(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ranks(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ], 0);
    // 手动让 seat 1 胡了
    s.players[1]!.isOut = true;
    s.players[1]!.hu = {
      seat: 1,
      fromSeat: null,
      tile: t(0, 1),
      fan: 1,
      multiplier: 1,
      items: ['平胡+1'],
      selfDraw: true,
    };
    s.scoreEvents.push({
      kind: 'hu',
      seq: 1,
      seat: 1,
      fromSeat: null,
      fan: 1,
      multiplier: 1,
      payers: [
        { seat: 0, amount: 20 },
        { seat: 2, amount: 20 },
        { seat: 3, amount: 20 },
      ],
      items: ['平胡+1'],
    });
    // wall 空
    s.wall = [];
    s.wallCount = 0;
    s.state = 'ended';
    s.endReason = 'wallEmptyWithHu';
    s.liuju = false;
    s = finishMahjong(s, Date.now());
    const result = settleMahjong(s);
    expect(result.endReason).toBe('wallEmptyWithHu');
    expect(result.liuju).toBe(false);
    expect(result.events.filter((e) => e.kind === 'chajiao')).toHaveLength(0);
    expect(result.events.filter((e) => e.kind === 'huazhu')).toHaveLength(0);
    expect(result.events.filter((e) => e.kind === 'refund')).toHaveLength(0);
  });

  it('wallEmpty：墙空且无人胡 → liuju=true, 生成 wallEmpty 专属事件', () => {
    let s = makeGame([
      ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ranks(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ranks(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ranks(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ], 0);
    // wall 空，无人胡
    s.wall = [];
    s.wallCount = 0;
    s.state = 'ended';
    s.endReason = 'wallEmpty';
    s.liuju = true;
    s = finishMahjong(s, Date.now());
    const result = settleMahjong(s);
    expect(result.endReason).toBe('wallEmpty');
    expect(result.liuju).toBe(true);
  });

  it('settleMahjong 返回 revealedHands / meldsBySeat / lackSuits / rulesPreset', () => {
    let s = makeGame([
      ranks(0, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ranks(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ranks(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ranks(1, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ], 0);
    // 让 seat 1 胡了
    const huTile = t(0, 1);
    s.players[1]!.isOut = true;
    s.players[1]!.hu = {
      seat: 1,
      fromSeat: null,
      tile: huTile,
      fan: 1,
      multiplier: 1,
      items: ['平胡+1'],
      selfDraw: true,
    };
    s.scoreEvents.push({
      kind: 'hu',
      seq: 1,
      seat: 1,
      fromSeat: null,
      fan: 1,
      multiplier: 1,
      payers: [
        { seat: 0, amount: 20 },
        { seat: 2, amount: 20 },
        { seat: 3, amount: 20 },
      ],
      items: ['平胡+1'],
    });
    // seat 2 有一个碰
    s.players[2]!.melds.push({ kind: 'peng', tiles: ranks(1, [5, 5, 5]), fromSeat: 1 });
    s.state = 'ended';
    s.endReason = 'threeWinners';
    s = finishMahjong(s, Date.now());
    const result = settleMahjong(s);

    // revealedHands
    expect(result.revealedHands).toBeDefined();
    expect(result.revealedHands).toHaveLength(1);
    expect(result.revealedHands![0]!.seat).toBe(1);
    expect(result.revealedHands![0]!.huTile).toEqual(huTile);
    // 手牌应该已排序
    const hand = result.revealedHands![0]!.tiles;
    for (let i = 1; i < hand.length; i += 1) {
      expect(hand[i]!.s * 10 + hand[i]!.r).toBeGreaterThanOrEqual(
        hand[i - 1]!.s * 10 + hand[i - 1]!.r,
      );
    }

    // meldsBySeat：全部 4 座，seat 升序
    expect(result.meldsBySeat).toHaveLength(4);
    for (let i = 0; i < 4; i += 1) expect(result.meldsBySeat![i]!.seat).toBe(i);
    expect(result.meldsBySeat![2]!.melds).toHaveLength(1);
    expect(result.meldsBySeat![2]!.melds[0]!.kind).toBe('peng');

    // lackSuits：4 座都有定缺
    expect(result.lackSuits).toHaveLength(4);
    expect(result.lackSuits!.every((l) => l === 2)).toBe(true);

    // rulesPreset
    expect(result.rulesPreset).toBe('chengdu');
  });
});

/** 麻将视图投影（只给自己的手牌；牌墙/他人手牌/RNG 永不出站）。 */
import {
  countTiles,
  tileFromType,
  type MahjongClaimOption,
  type MahjongPlayerView,
  type Tile,
} from '@fight-the-landlord/protocol';
import type { MahjongSession } from '@fight-the-landlord/shared';
import {
  activeSeats,
  canGangFromDiscard,
  canPeng,
  checkHu,
  isForcedHu,
  isTing,
  tingResult,
} from '@fight-the-landlord/shared';

function pendingSeats(session: MahjongSession): number[] {
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

/** Batch 5：收集所有听牌座位。零作弊风险——只广播座位号。 */
function tingSeatsOf(session: MahjongSession): number[] {
  const out: number[] = [];
  for (const p of session.players) {
    if (!p || p.isOut) continue;
    if (p.lackSuit === null) continue; // 未定缺不可能听
    if (isTing(p.hand, p.melds, p.lackSuit, session.rules)) out.push(p.seat);
  }
  return out;
}

function claimsForMe(session: MahjongSession, seat: number): MahjongClaimOption[] {
  const player = session.players[seat];
  if (!player || player.isOut) return [];
  const out: MahjongClaimOption[] = [];
  const pc = session.pendingClaims;
  if (session.state === 'claim' && pc?.candidates.includes(seat)) {
    if (pc.responses.some((r) => r.seat === seat)) return [];
    const hu = checkHu(
      session,
      seat,
      pc.discard,
      false,
      pc.kind === 'rob',
      pc.kind === 'claim' && pc.gangShootSeq !== undefined,
    );
    if (hu.ok) out.push({ claim: 'hu', tile: pc.discard, fan: hu.score!.fan });
    if (pc.kind === 'claim') {
      if (canGangFromDiscard(session, seat, pc.discard)) out.push({ claim: 'gang', tile: pc.discard });
      if (canPeng(session, seat, pc.discard)) out.push({ claim: 'peng', tile: pc.discard });
    }
    if (!isForcedHu(session, seat, pc.discard)) out.push({ claim: 'pass' });
    return out;
  }
  if (session.state === 'play' && session.currentPlayer === seat) {
    const last = session.lastDraw?.tile;
    if (last) {
      const hu = checkHu(session, seat, last, true);
      if (hu.ok) out.push({ claim: 'hu', tile: last, fan: hu.score!.fan });
    }
    const counts = countTiles(player.hand);
    for (let type = 0; type < counts.length; type += 1) {
      if (counts[type] === 4) {
        const tile = tileFromType(type);
        // 缺门牌不能杠（与 canPeng/canMeldedGang 同一条规则）。
        if (tile.s !== player.lackSuit) out.push({ claim: 'gang', tile });
      }
    }
    for (const meld of player.melds) {
      if (meld.kind !== 'peng') continue;
      const tile = meld.tiles[0]!;
      if (player.hand.some((t) => t.s === tile.s && t.r === tile.r)) {
        out.push({ claim: 'gang', tile });
      }
    }
  }
  return out;
}

function pendingScoreChanges(session: MahjongSession): Array<{ seat: number; delta: number }> {
  const deltas = [0, 0, 0, 0];
  for (const e of session.scoreEvents) {
    if (e.kind !== 'gang') continue;
    for (const p of e.payers) {
      deltas[p.seat] -= p.amount;
      deltas[e.seat] += p.amount;
    }
  }
  return deltas.map((delta, seat) => ({ seat, delta })).filter((x) => x.delta !== 0);
}

export function buildMahjongView(session: MahjongSession, seat: number): MahjongPlayerView {
  const player = session.players[seat];
  if (!player) throw new Error(`mahjong view: seat ${seat} missing`);
  const ting =
    player.lackSuit === null
      ? undefined
      : tingResult(player.hand, player.melds, player.lackSuit, session.rules);
  const huInfos = session.players
    .filter((p) => p.hu !== null)
    .map((p) => p.hu!);
  const revealedHands = session.players
    .filter((p) => p.isOut && p.hu !== null)
    .map((p) => ({ seat: p.seat, tiles: [...p.hand] as Tile[], huTile: p.hu!.tile }));
  return {
    roomCode: session.roomCode,
    gameType: 'mahjong',
    playerCount: 4,
    version: session.version,
    state: session.state,
    baseScore: session.baseScore,
    seat,
    hand: [...player.hand],
    cardCounts: session.players.map((p) => p.hand.length),
    trustees: session.players.map((p) => p.trustee),
    currentPlayer: session.currentPlayer,
    recentActions: [],
    turnDeadlineAt: session.turnDeadlineAt,
    activeSeats: pendingSeats(session),
    tingSeats: tingSeatsOf(session),
    dealerSeat: session.dealerSeat,
    wallCount: session.wall.length,
    lackSuits: session.players.map((p) => p.lackSuit),
    melds: session.players.map((p) => p.melds.map((m) => ({ ...m, tiles: [...m.tiles] }))),
    discards: session.players.map((p) => [...p.discards]),
    isOut: session.players.map((p) => p.isOut),
    huInfos,
    claimsForMe: claimsForMe(session, seat),
    ...(ting === undefined ? {} : { tingTiles: ting.tiles, maxFanForMe: ting.maxFan }),
    mahjongRules: session.rules,
    pendingScoreChanges: pendingScoreChanges(session),
    revealedHands,
    windowId: session.windowId,
  };
}

export function buildAllMahjongViews(session: MahjongSession): MahjongPlayerView[] {
  return [0, 1, 2, 3].map((seat) => buildMahjongView(session, seat));
}

export { activeSeats };

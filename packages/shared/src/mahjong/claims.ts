/** 响应窗口候选/胡牌合法性（服务端唯一裁决）。 */
import {
  tileType,
  type MahjongMeldView,
  type Tile,
} from '@fight-the-landlord/protocol';
import type { MahjongPlayer, MahjongSession } from './session';
import { canMeldedGang, hasLackTiles } from './lack';
import { huDecompositions } from './hu';
import { scoreBestHand, type ScoreResult } from './scoring';
import { EMPTY_HU_CONTEXT, type HuContext } from './features';

export function activeSeats(session: MahjongSession): number[] {
  return session.players.filter((p) => !p.isOut).map((p) => p.seat);
}

export function nextActiveSeat(session: MahjongSession, from: number): number {
  for (let step = 1; step <= 4; step += 1) {
    const seat = (from + step) % 4;
    if (!session.players[seat]?.isOut) return seat;
  }
  return -1;
}

export function meldsOf(player: MahjongPlayer): MahjongMeldView[] {
  return player.melds;
}

export function huContext(
  session: MahjongSession,
  seat: number,
  selfDraw: boolean,
  robbingKong = false,
): HuContext {
  const last = session.lastDraw;
  return {
    ...EMPTY_HU_CONTEXT,
    selfDraw,
    winAfterKong: selfDraw && last?.seat === seat && last.fromKong === true,
    shootAfterKong: !selfDraw && last?.fromKong === true && last.seat !== seat,
    robbingKong,
    underTheSea: session.wallCount === 0,
    lastFour: session.wallCount <= 4,
  };
}

export interface HuCheck {
  ok: boolean;
  score?: ScoreResult;
}

/** 该座位用 `tile` 能否胡；`selfDraw` 时 hand 已含 tile。 */
export function checkHu(
  session: MahjongSession,
  seat: number,
  tile: Tile,
  selfDraw: boolean,
  robbingKong = false,
): HuCheck {
  const player = session.players[seat];
  if (!player || player.isOut) return { ok: false };
  if (tile.s === player.lackSuit) return { ok: false };
  const hand = selfDraw ? player.hand : [...player.hand, tile];
  if (huDecompositions(hand, player.melds, player.lackSuit!).length === 0) return { ok: false };
  const score = scoreBestHand({
    hand,
    melds: player.melds,
    lackSuit: player.lackSuit!,
    winningTile: tile,
    context: huContext(session, seat, selfDraw, robbingKong),
    rules: session.rules,
  });
  if (score.fan < session.rules.minFanToHu) return { ok: false };
  if (!selfDraw && !robbingKong) {
    const passed = player.passedHu.find((p) => p.tile === tileType(tile));
    if (passed) {
      if (session.rules.passHuMode === 'sameTile') return { ok: false };
      if (session.rules.passHuMode === 'sameTileOrHigherFan' && score.fan <= passed.fan) {
        return { ok: false };
      }
    }
  }
  return { ok: true, score };
}

export function canPeng(session: MahjongSession, seat: number, tile: Tile): boolean {
  const player = session.players[seat];
  if (!player || player.isOut) return false;
  if (tile.s === player.lackSuit) return false;
  return player.hand.filter((t) => t.s === tile.s && t.r === tile.r).length >= 2;
}

export function canGangFromDiscard(session: MahjongSession, seat: number, tile: Tile): boolean {
  const player = session.players[seat];
  if (!player || player.isOut) return false;
  return canMeldedGang(player.hand, player.lackSuit!, tile);
}

/** 窗口候选：胡优先；非抢杠窗口才可杠/碰。 */
export function claimCandidates(session: MahjongSession): number[] {
  const pc = session.pendingClaims;
  if (!pc) return [];
  const out: number[] = [];
  for (const seat of activeSeats(session)) {
    if (seat === pc.fromSeat) continue;
    if (checkHu(session, seat, pc.discard, false, pc.kind === 'rob').ok) {
      out.push(seat);
      continue;
    }
    if (pc.kind === 'claim' && canGangFromDiscard(session, seat, pc.discard)) {
      out.push(seat);
      continue;
    }
    if (pc.kind === 'claim' && canPeng(session, seat, pc.discard)) out.push(seat);
  }
  return out;
}

export function isForcedHu(session: MahjongSession, seat: number, tile: Tile): boolean {
  return (
    session.rules.lastFourForcedHu &&
    session.wallCount <= 4 &&
    checkHu(session, seat, tile, false, session.pendingClaims?.kind === 'rob').ok
  );
}

/** 有缺门牌的玩家不能碰/杠（lookup 用）。 */
export function mustClearLack(player: MahjongPlayer): boolean {
  return player.lackSuit !== null && hasLackTiles(player.hand, player.lackSuit);
}

/** 定缺：强制规则、缺门优先、碰/杠限制。 */
import { MAHJONG_SUITS, ProtocolError, type MahjongSuit, type Tile } from '@fight-the-landlord/protocol';
import { suitCounts } from './exchange';

export function presentSuits(hand: readonly Tile[]): MahjongSuit[] {
  const counts = suitCounts(hand);
  return MAHJONG_SUITS.filter((s) => counts[s]! > 0);
}

/** 3 门任选；2 门强制缺第三门；1 门只能在另两门中选。 */
export function validateLackSuit(hand: readonly Tile[], suit: MahjongSuit): void {
  if (!MAHJONG_SUITS.includes(suit)) throw new ProtocolError(`定缺花色必须是 0|1|2，收到 ${String(suit)}`);
  const present = presentSuits(hand);
  if (present.length === 1 && present[0] === suit) {
    throw new ProtocolError('手牌只有一门时，定缺必须选另外两门之一');
  }
  if (present.length === 2 && present.includes(suit)) {
    throw new ProtocolError('手牌只有两门时，定缺必须选缺少的那门');
  }
}

export function autoLackSuit(hand: readonly Tile[]): MahjongSuit {
  const present = presentSuits(hand);
  if (present.length === 1) {
    return MAHJONG_SUITS.find((s) => s !== present[0])!;
  }
  if (present.length === 2) {
    return MAHJONG_SUITS.find((s) => !present.includes(s))!;
  }
  const counts = suitCounts(hand);
  return [...MAHJONG_SUITS].sort((a, b) => counts[a]! - counts[b]! || a - b)[0]!;
}

export function hasLackTiles(hand: readonly Tile[], lack: MahjongSuit): boolean {
  return hand.some((t) => t.s === lack);
}

/** 有缺门牌 ⇒ 只能打缺门；否则任意手牌。 */
export function canDiscard(hand: readonly Tile[], lack: MahjongSuit, tile: Tile): boolean {
  if (!hand.some((t) => t.s === tile.s && t.r === tile.r)) return false;
  return hasLackTiles(hand, lack) ? tile.s === lack : true;
}

/** 缺门牌不能碰/杠。 */
export function canPengOrGang(hand: readonly Tile[], lack: MahjongSuit, tile: Tile): boolean {
  if (tile.s === lack) return false;
  return hand.filter((t) => t.s === tile.s && t.r === tile.r).length >= 2;
}

export function canMeldedGang(hand: readonly Tile[], lack: MahjongSuit, tile: Tile): boolean {
  if (!canPengOrGang(hand, lack, tile)) return false;
  return hand.filter((t) => t.s === tile.s && t.r === tile.r).length >= 3;
}

export function removeTile(hand: readonly Tile[], tile: Tile): Tile[] {
  const idx = hand.findIndex((t) => t.s === tile.s && t.r === tile.r);
  if (idx < 0) throw new ProtocolError(`牌不在手牌中：${tile.s}-${tile.r}`);
  const out = [...hand];
  out.splice(idx, 1);
  return out;
}

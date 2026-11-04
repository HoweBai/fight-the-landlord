/** 碰/杠副露构造（纯函数；不修改入参）。 */
import { ProtocolError, type MahjongMeldView, type Tile } from '@fight-the-landlord/protocol';

function take(hand: readonly Tile[], tile: Tile, n: number): { removed: Tile[]; rest: Tile[] } {
  const rest = [...hand];
  const removed: Tile[] = [];
  for (let i = 0; i < n; i += 1) {
    const idx = rest.findIndex((t) => t.s === tile.s && t.r === tile.r);
    if (idx < 0) throw new ProtocolError(`手牌中没有足够的 ${tile.s}-${tile.r}（需要 ${n} 张）`);
    removed.push(rest[idx]!);
    rest.splice(idx, 1);
  }
  return { removed, rest };
}

export function makePeng(
  hand: readonly Tile[],
  tile: Tile,
  fromSeat: number,
): { meld: MahjongMeldView; hand: Tile[] } {
  const { removed, rest } = take(hand, tile, 2);
  return { meld: { kind: 'peng', tiles: [...removed, tile], fromSeat }, hand: rest };
}

export function makeMeldedGang(
  hand: readonly Tile[],
  tile: Tile,
  fromSeat: number,
): { meld: MahjongMeldView; hand: Tile[] } {
  const { removed, rest } = take(hand, tile, 3);
  return { meld: { kind: 'gang', tiles: [...removed, tile], fromSeat }, hand: rest };
}

export function makeConcealedGang(
  hand: readonly Tile[],
  tile: Tile,
): { meld: MahjongMeldView; hand: Tile[] } {
  const { removed, rest } = take(hand, tile, 4);
  return { meld: { kind: 'angang', tiles: removed }, hand: rest };
}

export function makeAddedGang(
  hand: readonly Tile[],
  meld: MahjongMeldView,
  tile: Tile,
): { meld: MahjongMeldView; hand: Tile[] } {
  if (meld.kind !== 'peng') throw new ProtocolError('补杠只能从碰升级');
  if (!meld.tiles.every((t) => t.s === meld.tiles[0]!.s && t.r === meld.tiles[0]!.r)) {
    throw new ProtocolError('补杠的碰副露形状非法');
  }
  const { removed, rest } = take(hand, tile, 1);
  return {
    meld: { kind: 'gang', tiles: [...meld.tiles, ...removed], fromSeat: meld.fromSeat },
    hand: rest,
  };
}

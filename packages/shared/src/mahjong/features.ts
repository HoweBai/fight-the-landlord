/** 胡牌后的规范特征（计分策略的唯一输入）。 */
import {
  MAHJONG_TILE_TYPES,
  tileType,
  type MahjongMeldView,
  type Tile,
} from '@fight-the-landlord/protocol';
import type { Decomposition, SetDesc } from './hu';

export interface HuContext {
  selfDraw: boolean;
  winAfterKong: boolean;
  shootAfterKong: boolean;
  robbingKong: boolean;
  underTheSea: boolean;
  lastFour: boolean;
  tianHu?: boolean;
  diHu?: boolean;
}

export interface HandFeatures {
  sevenPairs: boolean;
  allPungs: boolean;
  goldenWait: boolean;
  fullFlush: boolean;
  terminals: boolean;
  all258: boolean;
  hasTerminalTile: boolean;
  /** 根数：手中四张相同 + 配置含杠时的杠副露。 */
  rootCount: number;
  kongCount: number;
  pairType: number;
  sets: SetDesc[];
  winningTile: Tile;
  context: HuContext;
}

export function allTiles(hand: readonly Tile[], melds: readonly MahjongMeldView[]): Tile[] {
  return [...hand, ...melds.flatMap((m) => m.tiles)];
}

function isTerminalRank(type: number): boolean {
  const rank = (type % 9) + 1;
  return rank === 1 || rank === 9;
}

function setContainsTerminal(set: SetDesc): boolean {
  const startRank = (set.start % 9) + 1;
  return set.kind === 'triplet' ? startRank === 1 || startRank === 9 : startRank === 1 || startRank === 7;
}

function meldContainsTerminal(meld: MahjongMeldView): boolean {
  const tile = meld.tiles[0]!;
  return isTerminalRank(tileType(tile));
}

export function deriveFeatures(
  hand: readonly Tile[],
  melds: readonly MahjongMeldView[],
  decomp: Decomposition,
  winningTile: Tile,
  context: HuContext,
  rootIncludesKong: boolean,
): HandFeatures {
  const tiles = allTiles(hand, melds);
  const fullFlush = tiles.every((t) => t.s === tiles[0]!.s);
  const all258 = tiles.every((t) => [2, 5, 8].includes(t.r));
  const hasTerminalTile = tiles.some((t) => t.r === 1 || t.r === 9);
  const sevenPairs = decomp.sevenPairs;
  const allPungs = !sevenPairs && decomp.sets.every((s) => s.kind === 'triplet');
  const goldenWait =
    !sevenPairs &&
    allPungs &&
    decomp.pair === tileType(winningTile);

  const terminals = sevenPairs
    ? hand.every((t) => t.r === 1 || t.r === 9)
    : decomp.sets.every(setContainsTerminal) &&
      melds.every(meldContainsTerminal) &&
      isTerminalRank(decomp.pair);

  const counts = new Array<number>(MAHJONG_TILE_TYPES).fill(0);
  for (const t of hand) counts[tileType(t)] += 1;
  const handQuads = counts.filter((n) => n === 4).length;
  const kongMelds = melds.filter((m) => m.kind === 'gang' || m.kind === 'angang').length;
  const rootCount = handQuads + (rootIncludesKong ? kongMelds : 0);

  return {
    sevenPairs,
    allPungs,
    goldenWait,
    fullFlush,
    terminals,
    all258,
    hasTerminalTile,
    rootCount,
    kongCount: kongMelds,
    pairType: decomp.pair,
    sets: decomp.sets,
    winningTile,
    context,
  };
}

export const EMPTY_HU_CONTEXT: HuContext = Object.freeze({
  selfDraw: false,
  winAfterKong: false,
  shootAfterKong: false,
  robbingKong: false,
  underTheSea: false,
  lastFour: false,
  tianHu: false,
  diHu: false,
});

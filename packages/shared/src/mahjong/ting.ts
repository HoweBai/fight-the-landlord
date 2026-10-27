/** 听牌枚举与最大番（hint/查叫/机器人共用）。 */
import {
  MAHJONG_TILE_TYPES,
  countTiles,
  tileFromType,
  type MahjongMeldView,
  type MahjongRulesConfig,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';
import { EMPTY_HU_CONTEXT } from './features';
import { huDecompositions } from './hu';
import { scoreBestHand } from './scoring';

export interface TingResult {
  tiles: Tile[];
  maxFan: number;
}

/** 所有能胡的牌型（去重、按牌型序）。 */
export function tingTiles(
  hand: readonly Tile[],
  melds: readonly MahjongMeldView[],
  lackSuit: MahjongSuit,
  rules: MahjongRulesConfig,
): Tile[] {
  const counts = countTiles(hand);
  const out: Tile[] = [];
  for (let type = 0; type < MAHJONG_TILE_TYPES; type += 1) {
    if (counts[type]! >= 4) continue;
    const tile = tileFromType(type);
    if (tile.s === lackSuit) continue;
    const candidate = [...hand, tile];
    if (huDecompositions(candidate, melds, lackSuit).length === 0) continue;
    const score = scoreBestHand({
      hand: candidate,
      melds,
      lackSuit,
      winningTile: tile,
      context: EMPTY_HU_CONTEXT,
      rules,
    });
    if (score.fan >= rules.minFanToHu) out.push(tile);
  }
  return out;
}

export function tingResult(
  hand: readonly Tile[],
  melds: readonly MahjongMeldView[],
  lackSuit: MahjongSuit,
  rules: MahjongRulesConfig,
): TingResult {
  const tiles = tingTiles(hand, melds, lackSuit, rules);
  let maxFan = 0;
  for (const tile of tiles) {
    const score = scoreBestHand({
      hand: [...hand, tile],
      melds,
      lackSuit,
      winningTile: tile,
      context: EMPTY_HU_CONTEXT,
      rules,
    });
    if (score.fan > maxFan) maxFan = score.fan;
  }
  return { tiles, maxFan };
}

export function isTing(
  hand: readonly Tile[],
  melds: readonly MahjongMeldView[],
  lackSuit: MahjongSuit,
  rules: MahjongRulesConfig,
): boolean {
  return tingTiles(hand, melds, lackSuit, rules).length > 0;
}

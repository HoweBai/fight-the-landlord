/**
 * 胡牌分解（纯函数）。
 *
 * 输出**全部**合法分解；计分策略在 `scoring.ts` 里按规则选最优。
 * 缺门/张数/副露形状在这里统一校验。
 */
import {
  MAHJONG_TILE_TYPES,
  ProtocolError,
  tileType,
  type MahjongMeldView,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';

export interface SetDesc {
  kind: 'triplet' | 'sequence';
  /** 三张：牌型 id；顺子：起始牌型 id（同花色，start%9<=6）。 */
  start: number;
}

export interface Decomposition {
  /** 标准型：4 副（含副露）；七对：空数组。 */
  sets: SetDesc[];
  /** 标准型将牌牌型；七对 -1。 */
  pair: number;
  sevenPairs: boolean;
  /** 手中 4 张相同的牌型（含七对/标准型；不含已杠副露）。 */
  quadTypes: number[];
}

function countsOf(tiles: readonly Tile[]): number[] {
  const counts = new Array<number>(MAHJONG_TILE_TYPES).fill(0);
  for (const t of tiles) counts[tileType(t)] += 1;
  return counts;
}

/** 七对：14 张、无副露、所有计数为偶数、对子数恰 7（四张算两对）。 */
export function isSevenPairs(hand: readonly Tile[]): boolean {
  if (hand.length !== 14) return false;
  const counts = countsOf(hand);
  let pairs = 0;
  for (const n of counts) {
    if (n % 2 !== 0) return false;
    pairs += n / 2;
  }
  return pairs === 7;
}

function splitSets(
  counts: number[],
  needSets: number,
  sets: SetDesc[],
): SetDesc[][] {
  if (needSets === 0) {
    return counts.every((n) => n === 0) ? [sets] : [];
  }
  const first = counts.findIndex((n) => n > 0);
  if (first < 0) return [];
  const out: SetDesc[][] = [];
  // 刻子
  if (counts[first]! >= 3) {
    const next = [...counts];
    next[first] -= 3;
    out.push(...splitSets(next, needSets - 1, [...sets, { kind: 'triplet', start: first }]));
  }
  // 顺子（同花色；first%9 <= 6 才能 start..start+2）
  if (first % 9 <= 6 && counts[first + 1]! > 0 && counts[first + 2]! > 0) {
    const next = [...counts];
    next[first] -= 1;
    next[first + 1] -= 1;
    next[first + 2] -= 1;
    out.push(...splitSets(next, needSets - 1, [...sets, { kind: 'sequence', start: first }]));
  }
  return out;
}

function dedup(decomps: Decomposition[]): Decomposition[] {
  const seen = new Set<string>();
  const out: Decomposition[] = [];
  for (const d of decomps) {
    const key = `${d.sevenPairs ? '7' : 's'}:${d.pair}:${d.sets
      .map((s) => `${s.kind}${s.start}`)
      .sort()
      .join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** 标准型分解：副露占 (4 - needSets) 副。 */
export function standardDecompositions(
  hand: readonly Tile[],
  melds: readonly MahjongMeldView[],
): Decomposition[] {
  const needSets = 4 - melds.length;
  if (needSets < 0 || hand.length !== needSets * 3 + 2) return [];
  const counts = countsOf(hand);
  const quadTypes = counts
    .map((n, type) => (n === 4 ? type : -1))
    .filter((type) => type >= 0);
  const out: Decomposition[] = [];
  for (let pair = 0; pair < MAHJONG_TILE_TYPES; pair += 1) {
    if (counts[pair]! < 2) continue;
    const rest = [...counts];
    rest[pair] -= 2;
    for (const sets of splitSets(rest, needSets, [])) {
      out.push({ sets, pair, sevenPairs: false, quadTypes });
    }
  }
  return dedup(out);
}

/**
 * 全部合法分解。缺门有牌 ⇒ 空；张数不符 ⇒ 空。
 * 七对只允许无副露。
 */
export function huDecompositions(
  hand: readonly Tile[],
  melds: readonly MahjongMeldView[],
  lackSuit: MahjongSuit,
): Decomposition[] {
  if (hand.some((t) => t.s === lackSuit)) return [];
  const out: Decomposition[] = [];
  if (melds.length === 0 && isSevenPairs(hand)) {
    const counts = countsOf(hand);
    out.push({
      sets: [],
      pair: -1,
      sevenPairs: true,
      quadTypes: counts.map((n, type) => (n === 4 ? type : -1)).filter((t) => t >= 0),
    });
  }
  out.push(...standardDecompositions(hand, melds));
  return dedup(out);
}

export function canHuShape(
  hand: readonly Tile[],
  melds: readonly MahjongMeldView[],
  lackSuit: MahjongSuit,
): boolean {
  return huDecompositions(hand, melds, lackSuit).length > 0;
}

/** 缺门/副露/张数形状校验（抛错版本，供动作入口用）。 */
export function assertHuInput(
  hand: readonly Tile[],
  melds: readonly MahjongMeldView[],
  lackSuit: MahjongSuit,
): void {
  if (hand.some((t) => t.s === lackSuit)) {
    throw new ProtocolError('手中有缺门牌，不能胡');
  }
  const needSets = 4 - melds.length;
  if (needSets < 0 || hand.length !== needSets * 3 + 2) {
    throw new ProtocolError(
      `手牌张数非法：副露 ${melds.length} 副时应为 ${needSets * 3 + 2} 张，收到 ${hand.length}`,
    );
  }
}

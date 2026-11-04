/** 换三张：3 张同花色；方向（下家/上家/对家）同时交换。 */
import { MAHJONG_SUITS, ProtocolError, tileType, type MahjongSuit, type Tile } from '@fight-the-landlord/protocol';

export type ExchangeDirection = 'clockwise' | 'counterclockwise' | 'opposite';

export function suitCounts(hand: readonly Tile[]): number[] {
  const counts = [0, 0, 0];
  for (const t of hand) counts[t.s] += 1;
  return counts;
}

export function validateExchangePick(hand: readonly Tile[], pick: readonly Tile[]): void {
  if (!Array.isArray(pick) || pick.length !== 3) {
    throw new ProtocolError(`换三张必须恰好 3 张，收到 ${Array.isArray(pick) ? pick.length : typeof pick}`);
  }
  const suit = pick[0]!.s;
  if (!MAHJONG_SUITS.includes(suit) || pick.some((t) => t.s !== suit)) {
    throw new ProtocolError('换三张的 3 张必须同花色');
  }
  const need = new Map<number, number>();
  for (const t of pick) need.set(tileType(t), (need.get(tileType(t)) ?? 0) + 1);
  const have = new Map<number, number>();
  for (const t of hand) have.set(tileType(t), (have.get(tileType(t)) ?? 0) + 1);
  for (const [type, n] of need) {
    if ((have.get(type) ?? 0) < n) {
      throw new ProtocolError(`换三张的牌不在手牌中（牌型 ${type} 需要 ${n} 张）`);
    }
  }
}

export function exchangeDirectionFor(
  random: () => number,
  mode: ExchangeDirection | 'random',
): ExchangeDirection {
  if (mode !== 'random') return mode;
  const directions: ExchangeDirection[] = ['clockwise', 'counterclockwise', 'opposite'];
  return directions[Math.floor(random() * directions.length)]!;
}

/** 给牌目标：顺时针 i→i+1；逆时针 i→i-1；对家 i→i+2。 */
export function exchangeTarget(seat: number, direction: ExchangeDirection): number {
  if (direction === 'clockwise') return (seat + 1) % 4;
  if (direction === 'counterclockwise') return (seat + 3) % 4;
  return (seat + 2) % 4;
}

/**
 * 同时交换：每家给出自己的 3 张，收到指向自己的那家的 3 张。
 * 返回新 hands（不修改入参）。
 */
export function exchangeHands(
  hands: readonly Tile[][],
  picks: readonly Tile[][],
  direction: ExchangeDirection,
): Tile[][] {
  if (hands.length !== 4 || picks.length !== 4) {
    throw new ProtocolError('换三张需要 4 家手牌与 4 份选择');
  }
  hands.forEach((hand, seat) => validateExchangePick(hand, picks[seat]!));
  return hands.map((hand, seat) => {
    const own = [...hand];
    for (const t of picks[seat]!) {
      const idx = own.findIndex((x) => x.s === t.s && x.r === t.r);
      if (idx < 0) throw new ProtocolError(`座位 ${seat} 的换三张牌不在手牌中`);
      own.splice(idx, 1);
    }
    const from = [0, 1, 2, 3].find((s) => exchangeTarget(s, direction) === seat);
    if (from === undefined) throw new ProtocolError(`换三张方向映射缺少座位 ${seat}`);
    return [...own, ...picks[from]!];
  });
}

/** 超时自动：在张数 ≥3 的花色里选最少的一门，取最小 3 张。 */
export function autoExchangePick(hand: readonly Tile[]): Tile[] {
  const counts = suitCounts(hand);
  const candidates = MAHJONG_SUITS.filter((s) => counts[s]! >= 3).sort(
    (a, b) => counts[a]! - counts[b]! || a - b,
  );
  const suit = candidates[0];
  if (suit === undefined) {
    // 13 张牌必有一门 ≥5，理论不可达；防御性抛错。
    throw new ProtocolError('手牌不足 3 张同花色，无法自动换三张');
  }
  const ofSuit = hand
    .filter((t) => t.s === (suit as MahjongSuit))
    .sort((a, b) => a.r - b.r)
    .slice(0, 3);
  return ofSuit;
}

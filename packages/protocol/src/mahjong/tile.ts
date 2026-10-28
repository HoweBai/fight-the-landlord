/**
 * 麻将牌（协议层唯一形状）。
 *
 * - `s`：0=万、1=筒、2=条（`MAHJONG_SUIT_NAMES` 逐字钉死）；
 * - `r`：1..9；
 * - 一张牌没有独立 id：同花色同点数的 4 张完全等价。
 *
 * 编码：27 位计数串（每位 0..4），用于记录/日志；出站视图用 `Tile[]`。
 * 本文件不 import `validate.ts`（避免与 views→mahjong→validate 成环）；
 * 解码抛普通 `Error`，由调用方包成 `ProtocolError`。
 */

export type MahjongSuit = 0 | 1 | 2;

export const MAHJONG_SUITS: readonly MahjongSuit[] = [0, 1, 2] as const;

/** 0=万、1=筒、2=条。客户端/规则文档必须用同一顺序。 */
export const MAHJONG_SUIT_NAMES: readonly string[] = ['万', '筒', '条'] as const;

export interface Tile {
  s: MahjongSuit;
  r: number;
}

export const MAHJONG_TILE_TYPES = 27;
export const MAHJONG_HAND_SIZE = 14;
export const MAHJONG_WALL_SIZE = 108;

export function isTile(value: unknown): value is Tile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const t = value as { s?: unknown; r?: unknown };
  return Number.isInteger(t.s) && (t.s === 0 || t.s === 1 || t.s === 2) &&
    Number.isInteger(t.r) && (t.r as number) >= 1 && (t.r as number) <= 9;
}

/** 牌型 id：0..26（万1..9=0..8，筒1..9=9..17，条1..9=18..26）。 */
export function tileType(t: Tile): number {
  return t.s * 9 + (t.r - 1);
}

export function tileFromType(type: number): Tile {
  if (!Number.isInteger(type) || type < 0 || type >= MAHJONG_TILE_TYPES) {
    throw new Error(`tile type out of range: ${type}`);
  }
  return { s: Math.floor(type / 9) as MahjongSuit, r: (type % 9) + 1 };
}

/** 按牌型稳定升序；不修改入参。 */
export function sortTiles(tiles: readonly Tile[]): Tile[] {
  return [...tiles].sort((a, b) => tileType(a) - tileType(b));
}

export function countTiles(tiles: readonly Tile[]): number[] {
  const counts = new Array<number>(MAHJONG_TILE_TYPES).fill(0);
  for (const tile of tiles) {
    if (!isTile(tile)) throw new Error(`invalid tile: ${JSON.stringify(tile)}`);
    counts[tileType(tile)] += 1;
  }
  return counts;
}

export function tilesFromCounts(counts: readonly number[]): Tile[] {
  if (!Array.isArray(counts) || counts.length !== MAHJONG_TILE_TYPES) {
    throw new Error(`mahjong counts must have ${MAHJONG_TILE_TYPES} entries`);
  }
  const out: Tile[] = [];
  counts.forEach((n, type) => {
    if (!Number.isInteger(n) || n < 0 || n > 4) {
      throw new Error(`mahjong count at ${type} must be 0..4, got ${String(n)}`);
    }
    for (let i = 0; i < n; i += 1) out.push(tileFromType(type));
  });
  return out;
}

/** 27 位计数串；不校验总和（13/14 由调用方按场景校验）。 */
export function encodeMahjongHand(tiles: readonly Tile[]): string {
  return countTiles(tiles).join('');
}

/**
 * 27 位计数串 → 牌。`expectedCards` 给定时校验总张数（记录写入用 13/14）。
 * 非法长度/字符/越界/张数不符 ⇒ 抛普通 `Error`。
 */
export function decodeMahjongHand(s: string, expectedCards?: number): Tile[] {
  if (typeof s !== 'string' || s.length !== MAHJONG_TILE_TYPES) {
    throw new Error(`mahjong hand must be ${MAHJONG_TILE_TYPES} chars, got ${typeof s === 'string' ? s.length : typeof s}`);
  }
  const counts = [...s].map((ch, i) => {
    if (!/^[0-4]$/.test(ch)) throw new Error(`mahjong hand char ${i} must be 0..4, got ${JSON.stringify(ch)}`);
    return Number(ch);
  });
  const total = counts.reduce((a, b) => a + b, 0);
  if (expectedCards !== undefined && total !== expectedCards) {
    throw new Error(`mahjong hand must sum to ${expectedCards}, got ${total}`);
  }
  return tilesFromCounts(counts);
}

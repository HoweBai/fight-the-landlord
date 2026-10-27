/** 四川麻将牌堆：108 张（万/筒/条 1–9 各 4）。 */
import { MAHJONG_HAND_SIZE, MAHJONG_WALL_SIZE, type Tile } from '@fight-the-landlord/protocol';

export const MAHJONG_DEAL_SIZE = 13;
export const MAHJONG_SEATS = 4;
/** 发牌后牌墙：108 − 52 = 56。 */
export const MAHJONG_WALL_AFTER_DEAL = MAHJONG_WALL_SIZE - MAHJONG_SEATS * MAHJONG_DEAL_SIZE;

export function createMahjongDeck(): Tile[] {
  const out: Tile[] = [];
  for (let s = 0 as 0 | 1 | 2; s <= 2; s = (s + 1) as 0 | 1 | 2) {
    for (let r = 1; r <= 9; r += 1) {
      for (let copy = 0; copy < 4; copy += 1) out.push({ s, r });
    }
  }
  return out;
}

/** Fisher–Yates；不修改入参。 */
export function shuffleTiles(tiles: readonly Tile[], random: () => number): Tile[] {
  const out = [...tiles];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface MahjongDeal {
  /** 4 家各 13 张（按座位）。 */
  hands: Tile[][];
  /** 56 张牌墙（服务端内部）。 */
  wall: Tile[];
}

/**
 * 发牌：4×13 + 56。`testWall` 给定时必须恰 108 张（确定性测试）；
 * 先按座位切 13，再留牌墙；不替庄家摸第 14 张。
 */
export function dealMahjong(random: () => number, testWall?: readonly Tile[]): MahjongDeal {
  const wall = testWall === undefined ? shuffleTiles(createMahjongDeck(), random) : [...testWall];
  if (wall.length !== MAHJONG_WALL_SIZE) {
    throw new Error(`mahjong wall must be ${MAHJONG_WALL_SIZE} tiles, got ${wall.length}`);
  }
  const hands: Tile[][] = [];
  let cursor = 0;
  for (let seat = 0; seat < MAHJONG_SEATS; seat += 1) {
    hands.push(wall.slice(cursor, cursor + MAHJONG_DEAL_SIZE));
    cursor += MAHJONG_DEAL_SIZE;
  }
  return { hands, wall: wall.slice(cursor) };
}

export { MAHJONG_HAND_SIZE };

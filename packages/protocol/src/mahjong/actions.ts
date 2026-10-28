/**
 * 麻将所有 C→S 动作（嵌套在 `GameAction` 的 `{kind:'mahjong', action}` 里）。
 *
 * 线格式：`game.play` 载荷 `mahjong?: MahjongAction`（与 `cards` 二选一）。
 * 动作合法性一律由服务端按会话重算；客户端载荷只表达意图。
 */
import type { MahjongSuit, Tile } from './tile';

export type MahjongClaim = 'hu' | 'gang' | 'peng' | 'pass';

export type MahjongAction =
  | { type: 'exchange'; tiles: Tile[] }
  | { type: 'lack'; suit: MahjongSuit }
  | { type: 'discard'; tile: Tile }
  | { type: 'concealedGang'; tile: Tile }
  | { type: 'addedGang'; tile: Tile }
  | { type: 'selfDrawHu' }
  | { type: 'claim'; claim: MahjongClaim };

/** 规则动作 + 服务端内部摸牌记录（只进记录/回放，不出站为动作）。 */
export type MahjongActionRecord =
  | { version: number; seat: number; action: MahjongAction; auto?: boolean }
  | { version: number; seat: number; action: { type: 'draw'; tile: Tile; fromKong: boolean }; auto?: boolean };

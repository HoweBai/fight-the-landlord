/**
 * 麻将副露稳定 key（纯函数，零依赖）。
 *
 * 格式：`${seat}:${kind}:${首张牌的 tileType}`（type 为协议 0..26）。
 * 同一座位、同一副露种类、同一牌型视为同一条副露 —— 服务端增量追加时 key 稳定，
 * 供 Board（pop 增量）、River（`claimSourceMeldKey`）与 useTableSound 共用。
 */

import {
  tileType,
  type MahjongMeldKind,
  type MahjongMeldView,
} from '@fight-the-landlord/protocol';

export interface ParsedMeldKey {
  seat: number;
  kind: MahjongMeldKind;
  tileType: number;
}

/**
 * 副露 key：`${seat}:${kind}:${首张 type}`。
 *
 * 空 `tiles`（服务端不应出站）时回退为 `-1`，保证 key 仍是三段可解析字符串；
 * 解析端把 `-1` 当作普通整数保留，不额外抛错。
 */
export function meldKey(seat: number, meld: MahjongMeldView): string {
  const first = meld.tiles[0];
  const meldedTileType = first ? tileType(first) : -1;
  return `${seat}:${meld.kind}:${meldedTileType}`;
}

/**
 * 解析副露 key ⇒ `{ seat, kind, tileType }`；非法格式一律返回 null：
 * - 段数不是 3；
 * - seat 不是非负整数；
 * - kind 不是 `peng` / `gang` / `angang`；
 * - tileType 不是整数。
 */
export function parseMeldKey(key: string): ParsedMeldKey | null {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [seatRaw, kindRaw, typeRaw] = parts as [string, string, string];
  if (!/^\d+$/.test(seatRaw)) return null;
  if (kindRaw !== 'peng' && kindRaw !== 'gang' && kindRaw !== 'angang') return null;
  if (!/^-?\d+$/.test(typeRaw)) return null;
  const seat = Number(seatRaw);
  const type = Number(typeRaw);
  if (!Number.isSafeInteger(seat) || !Number.isSafeInteger(type)) return null;
  return { seat, kind: kindRaw, tileType: type };
}

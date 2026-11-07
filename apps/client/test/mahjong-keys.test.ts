import { describe, expect, it } from 'vitest';
import {
  tileFromType,
  tileType,
  type MahjongMeldView,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';
import { meldKey, parseMeldKey } from '../src/game/mahjong-keys';

/**
 * T2：副露稳定 key（`seat:kind:首张 type`）与结构化解析。
 *
 * key 同时被 Board（pop 增量）、River（claimSourceMeldKey）与 useTableSound 共用；
 * 解析用于音频/高亮把 key 还原成结构，避免字符串前缀匹配。
 */

const t = (s: MahjongSuit, r: number): Tile => ({ s, r });

describe('meldKey', () => {
  it('brief 契约：seat:kind:首张 type', () => {
    // 牌型 id 0-based：tileType(5) = 5（万 6）
    const typeFive = tileFromType(5);
    expect(tileType(typeFive)).toBe(5);
    expect(meldKey(1, { kind: 'peng', tiles: [typeFive] })).toBe('1:peng:5');
  });

  it('0-based 映射：5 万 = type 4', () => {
    expect(meldKey(1, { kind: 'peng', tiles: [t(0, 5)] })).toBe('1:peng:4');
  });

  it('三种副露都支持', () => {
    expect(meldKey(0, { kind: 'peng', tiles: [t(0, 1), t(0, 1), t(0, 1)] })).toBe('0:peng:0');
    expect(meldKey(2, { kind: 'gang', tiles: [t(1, 9), t(1, 9), t(1, 9), t(1, 9)] })).toBe(
      `2:gang:${tileType(t(1, 9))}`,
    );
    expect(meldKey(3, { kind: 'angang', tiles: [t(2, 6), t(2, 6), t(2, 6), t(2, 6)] })).toBe(
      `3:angang:${tileType(t(2, 6))}`,
    );
  });

  it('只看首张：同组其它牌不参与 key', () => {
    const m: MahjongMeldView = {
      kind: 'gang',
      tiles: [t(2, 9), t(0, 1), t(1, 1), t(0, 5)],
    };
    expect(meldKey(2, m)).toBe(`2:gang:${tileType(t(2, 9))}`);
  });

  it('空 tiles 的防御值 -1（服务端不应出站，但 key 必须仍可解析）', () => {
    expect(meldKey(0, { kind: 'angang', tiles: [] })).toBe('0:angang:-1');
  });
});

describe('parseMeldKey', () => {
  it('round-trip：meldKey → parseMeldKey', () => {
    const cases: Array<[number, MahjongMeldView]> = [
      [0, { kind: 'peng', tiles: [t(0, 3), t(0, 3), t(0, 3)] }],
      [1, { kind: 'gang', tiles: [t(1, 7), t(1, 7), t(1, 7), t(1, 7)], fromSeat: 2 }],
      [3, { kind: 'angang', tiles: [t(2, 2), t(2, 2), t(2, 2), t(2, 2)] }],
    ];
    for (const [seat, meld] of cases) {
      expect(parseMeldKey(meldKey(seat, meld))).toEqual({
        seat,
        kind: meld.kind,
        tileType: tileType(meld.tiles[0] as Tile),
      });
    }
  });

  it('防御值 -1 可解析（空 tiles 哨兵）', () => {
    expect(parseMeldKey('0:angang:-1')).toEqual({ seat: 0, kind: 'angang', tileType: -1 });
  });

  it('tileType 协议范围 0..26 + -1 哨兵：边界合法、越界拒绝', () => {
    expect(parseMeldKey('0:peng:0')).toEqual({ seat: 0, kind: 'peng', tileType: 0 });
    expect(parseMeldKey('0:peng:26')).toEqual({ seat: 0, kind: 'peng', tileType: 26 });
    expect(parseMeldKey('0:peng:-1')).toEqual({ seat: 0, kind: 'peng', tileType: -1 });
    expect(parseMeldKey('0:peng:27')).toBeNull();
    expect(parseMeldKey('0:peng:99')).toBeNull();
    expect(parseMeldKey('0:peng:-2')).toBeNull();
  });

  it('非法 key ⇒ null', () => {
    const malformed = [
      '',
      '0',
      '0:peng',
      '0:peng:1:2',
      'x:peng:1',
      '-1:peng:1',
      '0.5:peng:1',
      '0:chi:1',
      '0:PENG:1',
      '0:peng:1.5',
      '0:peng:x',
      '0:peng: 1',
      '0:peng:',
      '0:peng:27',
      '0:peng:99',
      '0:peng:-2',
    ];
    for (const key of malformed) {
      expect(parseMeldKey(key)).toBeNull();
    }
  });
});

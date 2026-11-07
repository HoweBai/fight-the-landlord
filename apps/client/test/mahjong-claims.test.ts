import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHENGDU_RULES,
  tileType,
  type MahjongMeldView,
  type MahjongPlayerView,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';
import { claimSource, riverWindow, visibleDiscards } from '../src/game/mahjong-claims';

/**
 * T2：claimed 过滤 / 牌河窗口 / claimSource 纯函数。
 *
 * 判据（spec v12 §1/§2 + v13 §4）：
 *  - claim 窗口保护来源座最后一枚弃牌；同 type 旧副露按 latest-first 隐藏；
 *  - 窗口结束后不再保护，按 meld 数隐藏（`[5旧,3,5当前]` ⇒ `[3]`）；
 *  - 窗口字段与布局 v1 一致（29 张 ⇒ visible 24 / window 23 / badge +6）；
 *  - claimSource 只让 claim: 窗口的当前弃牌可点；rob: 窗口派生同 type 最新碰的 meldKey。
 */

const t = (s: MahjongSuit, r: number): Tile => ({ s, r });

function threeOf(s: MahjongSuit, r: number): Tile[] {
  return [t(s, r), t(s, r), t(s, r)];
}

function fourOf(s: MahjongSuit, r: number): Tile[] {
  return [t(s, r), t(s, r), t(s, r), t(s, r)];
}

/** 按座位索引的副露；本任务只关心 `fromSeat` 与首张 type。 */
function meldsAt(entries: Array<[number, MahjongMeldView]>): MahjongMeldView[][] {
  const out: MahjongMeldView[][] = [[], [], [], []];
  for (const [seat, meld] of entries) out[seat].push(meld);
  return out;
}

describe('visibleDiscards', () => {
  it('claim 窗口保护最后一张，隐藏旧的同 type（brief 用例）', () => {
    // 5(旧碰) 3 5(当前胡)
    const raw = [t(0, 5), t(0, 3), t(0, 5)];
    const melds = meldsAt([[1, { kind: 'peng', tiles: threeOf(0, 5), fromSeat: 0 }]]);
    const visible = visibleDiscards(raw, melds, {
      phase: 'claim',
      windowId: 'claim:3',
      sourceSeat: 0,
    });
    expect(visible.map(tileType)).toEqual([tileType(t(0, 3)), tileType(t(0, 5))]);
  });

  it('窗口结束后不再保护：两张 5 万都被 meld 计数藏掉，只剩 3 万', () => {
    const raw = [t(0, 5), t(0, 3), t(0, 5)];
    const melds = meldsAt([
      [1, { kind: 'peng', tiles: threeOf(0, 5), fromSeat: 0 }],
      [1, { kind: 'gang', tiles: fourOf(0, 5), fromSeat: 0 }],
    ]);
    const visible = visibleDiscards(raw, melds, { phase: 'play' });
    expect(visible.map(tileType)).toEqual([tileType(t(0, 3))]);
  });

  it('peng→addedGang：一个保留 fromSeat 的杠只藏 1 张', () => {
    const raw = [t(0, 5), t(0, 5)];
    const melds = meldsAt([[0, { kind: 'gang', tiles: fourOf(0, 5), fromSeat: 0 }]]);
    const visible = visibleDiscards(raw, melds, { phase: 'play' });
    expect(visible.map(tileType)).toEqual([tileType(t(0, 5))]);
    expect(visible).toHaveLength(1);
  });

  it('按座位隔离：seat 1 的副露不影响 seat 0 的河（seat:0）', () => {
    const raw = [t(0, 5), t(0, 3)];
    const melds = meldsAt([[1, { kind: 'peng', tiles: threeOf(0, 5), fromSeat: 1 }]]);
    const visible = visibleDiscards(raw, melds, {
      phase: 'claim',
      windowId: 'claim:1',
      sourceSeat: 1,
      seat: 0,
    });
    expect(visible.map(tileType)).toEqual([tileType(t(0, 5)), tileType(t(0, 3))]);
    // 反证：不传 seat（全量计数）时同一副露会藏掉一张
    const all = visibleDiscards(raw, melds, {
      phase: 'claim',
      windowId: 'claim:1',
      sourceSeat: 1,
    });
    expect(all.map(tileType)).toEqual([tileType(t(0, 3))]);
  });

  it('29 张 claim：藏 index 27、保护 index 28（最后一枚仍在）', () => {
    const raw = Array.from({ length: 29 }, () => t(0, 5));
    const melds = meldsAt([[0, { kind: 'peng', tiles: threeOf(0, 5), fromSeat: 0 }]]);
    const visible = visibleDiscards(raw, melds, {
      phase: 'claim',
      windowId: 'claim:0',
      sourceSeat: 0,
      seat: 0,
    });
    expect(visible).toHaveLength(28);
    expect(visible[visible.length - 1]).toBe(raw[28]);
    expect(visible).not.toContain(raw[27]);
    expect(visible).toContain(raw[0]);
  });

  it('不修改入参，返回新数组', () => {
    const raw = [t(0, 5), t(0, 3), t(0, 5)];
    const melds = meldsAt([[1, { kind: 'peng', tiles: threeOf(0, 5), fromSeat: 0 }]]);
    const rawSnapshot = raw.map((tile) => ({ ...tile }));
    const meldsSnapshot = JSON.parse(JSON.stringify(melds)) as unknown;
    const visible = visibleDiscards(raw, melds, {
      phase: 'claim',
      windowId: 'claim:3',
      sourceSeat: 0,
    });
    expect(visible).not.toBe(raw);
    expect(raw).toEqual(rawSnapshot);
    expect(melds).toEqual(meldsSnapshot);
  });
});

describe('riverWindow', () => {
  it('29 张（brief 用例）', () => {
    expect(riverWindow(29)).toEqual({
      visible: 24,
      overflow: 5,
      windowStart: 6,
      windowCount: 23,
      badgeCount: 6,
      latestIndex: 22,
    });
  });

  it('0 / 13 / 24 / 25 张边界', () => {
    expect(riverWindow(0)).toEqual({
      visible: 0,
      overflow: 0,
      windowStart: 0,
      windowCount: 0,
      badgeCount: 0,
      latestIndex: -1,
    });
    expect(riverWindow(13)).toEqual({
      visible: 13,
      overflow: 0,
      windowStart: 0,
      windowCount: 13,
      badgeCount: 0,
      latestIndex: 12,
    });
    expect(riverWindow(24)).toEqual({
      visible: 24,
      overflow: 0,
      windowStart: 0,
      windowCount: 24,
      badgeCount: 0,
      latestIndex: 23,
    });
    expect(riverWindow(25)).toEqual({
      visible: 24,
      overflow: 1,
      windowStart: 2,
      windowCount: 23,
      badgeCount: 2,
      latestIndex: 22,
    });
  });
});

/**
 * claimSource 的 view 工厂（同 `mahjong-board.test.ts` 的基线，只补默认值）。
 */
function view(over: Partial<MahjongPlayerView> = {}): MahjongPlayerView {
  return {
    roomCode: 'MJ1',
    gameType: 'mahjong',
    playerCount: 4,
    version: 1,
    state: 'play',
    baseScore: 1,
    seat: 0,
    hand: [],
    cardCounts: [13, 13, 13, 13],
    trustees: [false, false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 1_700_000_030_000,
    activeSeats: [0],
    tingSeats: [],
    dealerSeat: 0,
    wallCount: 40,
    lackSuits: [null, null, null, null],
    melds: [[], [], [], []],
    discards: [[], [], [], []],
    isOut: [false, false, false, false],
    huInfos: [],
    claimsForMe: [],
    mahjongRules: DEFAULT_CHENGDU_RULES,
    revealedHands: [],
    windowId: 'turn:1',
    ...over,
  };
}

describe('claimSource', () => {
  it('claim 窗口 + 碰选项：来源座 = currentPlayer，可点', () => {
    const first = t(1, 5);
    const second = t(1, 6);
    const info = claimSource(
      view({
        windowId: 'claim:2',
        currentPlayer: 2,
        activeSeats: [0, 2],
        claimsForMe: [
          { claim: 'pass' },
          { claim: 'peng', tile: first },
          { claim: 'hu', tile: second },
        ],
      }),
      0,
    );
    // 第一个带 tile 的候选（pass 无 tile）
    expect(info.tile).toBe(first);
    expect(info.sourceSeat).toBe(2);
    expect(info.canClick).toBe(true);
    expect(info.claimSourceMeldKey).toBeNull();
    // 非 activeSeats 成员不可点
    expect(claimSource(
      view({
        windowId: 'claim:2',
        currentPlayer: 2,
        activeSeats: [0, 2],
        claimsForMe: [{ claim: 'peng', tile: first }],
      }),
      1,
    ).canClick).toBe(false);
  });

  it('rob 窗口：sourceSeat null、不可点、派生 currentPlayer 同 type 最新碰', () => {
    const source = t(2, 7);
    const target: MahjongMeldView = { kind: 'peng', tiles: threeOf(2, 7), fromSeat: 0 };
    const info = claimSource(
      view({
        windowId: 'rob:1',
        currentPlayer: 1,
        activeSeats: [0],
        claimsForMe: [{ claim: 'hu', tile: source }],
        melds: [
          [],
          [{ kind: 'peng', tiles: threeOf(0, 1), fromSeat: 0 }, target],
          [],
          [],
        ],
      }),
      0,
    );
    expect(info.tile).toBe(source);
    expect(info.sourceSeat).toBeNull();
    expect(info.canClick).toBe(false);
    // 条 7 = type 2*9 + 6 = 24
    expect(info.claimSourceMeldKey).toBe('1:peng:24');
  });

  it('rob 窗口：无同 type 碰（同 type 杠不算）⇒ claimSourceMeldKey null', () => {
    const source = t(2, 7);
    const info = claimSource(
      view({
        windowId: 'rob:1',
        currentPlayer: 1,
        activeSeats: [0],
        claimsForMe: [{ claim: 'hu', tile: source }],
        melds: [
          [],
          [
            { kind: 'peng', tiles: threeOf(0, 1), fromSeat: 0 },
            { kind: 'gang', tiles: fourOf(2, 7), fromSeat: 0 },
          ],
          [],
          [],
        ],
      }),
      0,
    );
    expect(info.claimSourceMeldKey).toBeNull();
  });

  it('无带 tile 的候选：tile null、canClick false', () => {
    const info = claimSource(
      view({
        windowId: 'claim:3',
        currentPlayer: 3,
        activeSeats: [0, 3],
        claimsForMe: [{ claim: 'pass' }, { claim: 'hu' }],
      }),
      0,
    );
    expect(info.tile).toBeNull();
    expect(info.sourceSeat).toBe(3);
    expect(info.canClick).toBe(false);
    expect(info.claimSourceMeldKey).toBeNull();
  });

  it('不修改 view', () => {
    const source = t(2, 7);
    const v = view({
      windowId: 'rob:1',
      currentPlayer: 1,
      activeSeats: [0],
      claimsForMe: [{ claim: 'hu', tile: source }],
      melds: [[], [{ kind: 'peng', tiles: threeOf(2, 7), fromSeat: 0 }], [], []],
    });
    const snapshot = JSON.parse(JSON.stringify(v)) as unknown;
    claimSource(v, 0);
    expect(v).toEqual(snapshot);
  });
});

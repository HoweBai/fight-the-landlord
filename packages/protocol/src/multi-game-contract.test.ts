// packages/protocol/src/multi-game-contract.test.ts
//
// Task 0.4：多玩法**可选字段**（不联合）的契约面。
// 旧 ddz 形状必须继续通过；新增字段只有 undefined 算缺省，空串/非法值报错。
import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_OUTBOUND_KEYS,
  ProtocolError,
  assertNoLeak,
  validateClientMessage,
  validateOutbound,
} from './validate';
import { decodeHand, encodeCards, encodeHand } from './records';
import { PdkHandType, type PdkPlayerView } from './pdk/types';
import { pdkRecentActionsWindow } from './pdk/window';
import type { Card, PlayerView } from './views';

const c = (r: number, s = 0): Card => ({ r, s });

function view(over: Partial<PlayerView> = {}): PlayerView {
  return {
    roomCode: 'MG01',
    version: 3,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: [c(3), c(4), c(5)],
    cardCounts: [3, 17, 17],
    trustees: [false, false, false],
    bottomCards: null,
    landlordSeat: 1,
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 1_700_000_000_000,
    bidPhase: {
      currentBidder: 0,
      bidMultiplier: 2,
      landlordCandidate: 1,
      grabActions: 3,
      redealCount: 0,
      kind: 'rob',
      decisions: [],
    },
    playPhase: { bombCount: 0 },
    ...over,
  };
}

const meta = { reqId: 'req-1', baseVersion: 0, timestamp: 1_700_000_000_000 };

describe('可选 gameType/playerCount', () => {
  it('旧 ddz 视图（无字段）仍通过', () => {
    const v = view();
    expect(() =>
      validateOutbound({ type: 'game.state_update', version: v.version, payload: v }),
    ).not.toThrow();
  });

  it('带 doudizhu/3 的 ddz 视图通过', () => {
    const v = view({ gameType: 'doudizhu', playerCount: 3 });
    expect(() =>
      validateOutbound({ type: 'game.state_update', version: v.version, payload: v }),
    ).not.toThrow();
  });

  it('空串/未知 gameType 与非 2..4 人数报错', () => {
    for (const bad of ['', 'ddz', 'mahjong']) {
      const v = view({ gameType: bad as never });
      expect(() =>
        validateOutbound({ type: 'game.state_update', version: v.version, payload: v }),
        bad,
      ).toThrow(ProtocolError);
    }
    for (const bad of [1, 5, 3.5]) {
      const v = view({ playerCount: bad });
      expect(() =>
        validateOutbound({ type: 'game.state_update', version: v.version, payload: v }),
        String(bad),
      ).toThrow(ProtocolError);
    }
  });

  it('room.match / room.join 接受可选玩法字段；非法值报错', () => {
    expect(() =>
      validateClientMessage('room.match', {
        ...meta,
        payload: { mode: 'random', baseScore: 15, gameType: 'paodekuai', playerCount: 2 },
      }),
    ).not.toThrow();
    expect(() =>
      validateClientMessage('room.join', {
        ...meta,
        payload: { roomCode: 'R1', gameType: 'paodekuai' },
      }),
    ).not.toThrow();
    expect(() =>
      validateClientMessage('room.match', {
        ...meta,
        payload: { mode: 'random', baseScore: 15, gameType: '' },
      }),
    ).toThrow(ProtocolError);
  });

  it('game.balances 按 playerCount 校验长度', () => {
    const two = {
      type: 'game.balances' as const,
      version: 1,
      payload: {
        gameType: 'paodekuai',
        playerCount: 2,
        balances: [
          { seat: 0, balance: 10 },
          { seat: 1, balance: 20 },
        ],
      },
    };
    expect(() => validateOutbound(two)).not.toThrow();
    expect(() =>
      validateOutbound({ ...two, payload: { ...two.payload, playerCount: 4 } }),
    ).toThrow(ProtocolError);
  });
});

describe('禁出站键', () => {
  it('包含 pdk 内部字段；pdkRules 不在禁键里', () => {
    for (const key of [
      'rules',
      'lastPlayedHand',
      'unusedCards',
      'initialHands',
      'botIds',
      'botSkillLevels',
      'botThinkingSpeeds',
    ]) {
      expect(FORBIDDEN_OUTBOUND_KEYS).toContain(key);
    }
    expect(FORBIDDEN_OUTBOUND_KEYS).not.toContain('pdkRules');
  });

  it('rules 与 lastPlayedHand 出现即抛；pdkRules 允许', () => {
    expect(() => assertNoLeak({ rules: {} })).toThrow(/rules/);
    expect(() => assertNoLeak({ lastPlayedHand: {} })).toThrow(/lastPlayedHand/);
    expect(() => assertNoLeak({ pdkRules: {} })).not.toThrow();
  });
});

describe('记录 codec 变长', () => {
  const hand16 = Array.from({ length: 16 }, (_, i) => c(3 + (i % 12), i % 4));

  it('16 张手牌 ⇒ 32 hex，往返一致；默认 17 张仍拒绝', () => {
    const hex = encodeHand(hand16, 16);
    expect(hex).toHaveLength(32);
    expect(decodeHand(hex, 16)).toEqual(hand16);
    expect(() => encodeHand(hand16)).toThrow(ProtocolError);
  });

  it('2 张底牌 ⇒ 4 hex（跑得快不调用，但 codec 支持变长）', () => {
    expect(encodeCards([c(3), c(4)], 2)).toHaveLength(4);
  });
});

describe('pdk 类型', () => {
  it('PdkHandType 值稳定', () => {
    expect(PdkHandType.Bomb).toBe(11);
    expect(PdkHandType.AirplaneWithWings).toBe(10);
  });

  it('PdkPlayerView 形状可赋值（类型级）', () => {
    const pdk: PdkPlayerView = {
      roomCode: 'PDK01',
      gameType: 'paodekuai',
      playerCount: 3,
      version: 1,
      state: 'playing',
      baseScore: 15,
      seat: 0,
      hand: [c(3)],
      cardCounts: [1, 16, 16],
      trustees: [false, false, false],
      currentPlayer: 0,
      recentActions: [],
      turnDeadlineAt: 1,
      canPass: false,
      bombCount: 0,
      pdkRules: {
        bareTrioEnabled: true,
        trioWithPairEnabled: false,
        bareAirplaneEnabled: false,
        fourWithTwoEnabled: true,
        fourWithTwoPairKickerAllowed: false,
        airplaneWings: 'pairs',
        bombMultiplierEnabled: true,
        guanMultiplierEnabled: true,
        springMultiplierEnabled: true,
        multiplierCap: 64,
        baobenEnabled: true,
      },
    };
    expect(pdk.pdkRules.multiplierCap).toBe(64);
  });
});

describe('pdk recentActions 窗口按人数（2026-10-25 4 人场）', () => {
  const rules = {
    bareTrioEnabled: true,
    trioWithPairEnabled: false,
    bareAirplaneEnabled: false,
    fourWithTwoEnabled: true,
    fourWithTwoPairKickerAllowed: false,
    airplaneWings: 'pairs' as const,
    bombMultiplierEnabled: true,
    guanMultiplierEnabled: true,
    springMultiplierEnabled: true,
    multiplierCap: 64,
    baobenEnabled: true,
  };

  function pdkView(over: Partial<PdkPlayerView> = {}): PdkPlayerView {
    const pc = (over.playerCount ?? 4) as 2 | 3 | 4;
    const perSeat = pc === 4 ? 12 : 16;
    return {
      roomCode: 'PDK04',
      gameType: 'paodekuai',
      playerCount: pc,
      version: 1,
      state: 'playing',
      baseScore: 15,
      seat: 0,
      hand: [c(3)],
      cardCounts: Array.from({ length: pc }, (_, i) => (i === 0 ? 1 : perSeat)),
      trustees: Array.from({ length: pc }, () => false),
      currentPlayer: 0,
      recentActions: [],
      turnDeadlineAt: 1,
      canPass: false,
      bombCount: 0,
      pdkRules: rules,
      ...over,
    };
  }

  const actions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ seat: i, cards: i === 0 ? [c(3)] : null }));

  it('窗口函数：2/3 人 2、4 人 3', () => {
    expect(pdkRecentActionsWindow(2)).toBe(2);
    expect(pdkRecentActionsWindow(3)).toBe(2);
    expect(pdkRecentActionsWindow(4)).toBe(3);
  });

  it('4 人视图 3 条通过、4 条拒绝', () => {
    expect(() =>
      validateOutbound({
        type: 'game.state_update',
        version: 1,
        payload: pdkView({ recentActions: actions(3) as PdkPlayerView['recentActions'] }),
      }),
    ).not.toThrow();
    expect(() =>
      validateOutbound({
        type: 'game.state_update',
        version: 1,
        payload: pdkView({ recentActions: actions(4) as PdkPlayerView['recentActions'] }),
      }),
    ).toThrow(ProtocolError);
  });

  it('3 人/2 人视图 3 条拒绝（窗口仍 2）', () => {
    for (const pc of [2, 3] as const) {
      expect(() =>
        validateOutbound({
          type: 'game.state_update',
          version: 1,
          payload: pdkView({ playerCount: pc, recentActions: actions(3) as PdkPlayerView['recentActions'] }),
        }),
        String(pc),
      ).toThrow(ProtocolError);
    }
  });
});

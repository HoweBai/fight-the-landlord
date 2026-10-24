// packages/protocol/src/legacy-compat.test.ts
//
// Task 0.1：旧客户端 × 新服务 / 新校验器 × 旧消息 的双向兼容。
// 旧校验器是冻结副本（fixtures/legacy-validator.ts），不得用新校验器自证。
import { describe, it, expect } from 'vitest';
import { validateOutbound } from './validate';
import { validateLegacyOutbound } from './fixtures/legacy-validator';
import type { PlayerView, DdzSettlementResult } from './views';

const ddzView = (): PlayerView => ({
  roomCode: 'COMPAT01',
  version: 7,
  state: 'playing',
  baseScore: 80,
  seat: 0,
  hand: [{ r: 3, s: 0 }],
  cardCounts: [1, 0, 0],
  trustees: [false, false, false],
  bottomCards: null,
  landlordSeat: 0,
  currentPlayer: 0,
  recentActions: [],
  turnDeadlineAt: 1_700_000_000_000,
  bidPhase: {
    currentBidder: 0,
    bidMultiplier: 1,
    landlordCandidate: 0,
    grabActions: 1,
    redealCount: 0,
    kind: 'call',
    decisions: [],
  },
  playPhase: { bombCount: 0 },
  winner: 'landlord',
});

const ddzSettlement = (): DdzSettlementResult => ({
  roomCode: 'COMPAT01',
  baseScore: 80,
  winner: 'landlord',
  landlordSeat: 0,
  farmerSeats: [1, 2],
  multiplier: 2,
  spring: 'none',
  landlordScoreChange: 320,
  farmerScoreChange: -160,
});

describe('旧客户端 × 新服务（冻结旧校验器）', () => {
  it('旧校验器接受带新增字段的 ddz 视图', () => {
    const view = { ...ddzView(), gameType: 'doudizhu', playerCount: 3 };
    expect(() =>
      validateLegacyOutbound({ type: 'game.deal', version: view.version, payload: view }),
    ).not.toThrow();
  });

  it('旧校验器接受带 scoreChanges/winnerSeats 的 ddz 结算', () => {
    const result = {
      ...ddzSettlement(),
      gameType: 'doudizhu',
      playerCount: 3,
      winnerSeats: [0],
      scoreChanges: [
        { seat: 0, delta: 320 },
        { seat: 1, delta: -160 },
        { seat: 2, delta: -160 },
      ],
    };
    expect(() =>
      validateLegacyOutbound({ type: 'game.settlement', version: 1, payload: result }),
    ).not.toThrow();
  });

  it('旧校验器接受带 gameType/playerCount 的余额广播', () => {
    expect(() =>
      validateLegacyOutbound({
        type: 'game.balances',
        version: 1,
        payload: {
          gameType: 'doudizhu',
          playerCount: 3,
          balances: [
            { seat: 0, balance: 100 },
            { seat: 1, balance: 100 },
            { seat: 2, balance: 100 },
          ],
        },
      }),
    ).not.toThrow();
  });
});

describe('新校验器 × 旧 ddz 消息', () => {
  it('旧 ddz 视图（无 gameType/playerCount）通过', () => {
    const view = ddzView();
    expect(() =>
      validateOutbound({ type: 'game.state_update', version: view.version, payload: view }),
    ).not.toThrow();
  });

  it('旧 9 键结算通过', () => {
    expect(() =>
      validateOutbound({ type: 'game.settlement', version: 1, payload: ddzSettlement() }),
    ).not.toThrow();
  });

  it('旧 game.finished {winner} 通过', () => {
    expect(() =>
      validateOutbound({ type: 'game.finished', version: 1, payload: { winner: 'landlord' } }),
    ).not.toThrow();
  });
});

/**
 * S7.4 / spec §4.11：**旧 gateway × 新 pdk 消息**的负对照。
 *
 * 部署顺序要求 api-gateway 先于跑得快开关打开 —— 旧 gateway 的冻结校验器只认识斗地主形状，
 * 遇到 pdk 视图必须**当场拒绝**（这正是它会把 pdk 消息丢掉的原因）；新校验器接受同一载荷。
 * 真栈正向（新 gateway 放行 pdk）由 conformance `slice-29` 覆盖。
 */
describe('旧 gateway × 新 pdk 消息（负对照 · H16）', () => {
  const pdkView = {
    roomCode: 'PDK1',
    gameType: 'paodekuai' as const,
    playerCount: 3 as const,
    version: 3,
    state: 'playing' as const,
    baseScore: 15,
    seat: 0,
    hand: [{ r: 3, s: 1 }],
    cardCounts: [1, 16, 16],
    trustees: [false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 0,
    canPass: false,
    bombCount: 0,
    pdkRules: { bareTrioEnabled: true },
  };

  it('旧校验器拒绝 pdk 视图（缺 bottomCards/bidPhase 等斗地主字段）', () => {
    expect(() =>
      validateLegacyOutbound({ type: 'game.state_update', version: 3, payload: pdkView }),
    ).toThrow();
  });

  it('新校验器接受同一 pdk 视图（正向对照）', () => {
    expect(() =>
      validateOutbound({ type: 'game.state_update', version: 3, payload: pdkView }),
    ).not.toThrow();
  });
});

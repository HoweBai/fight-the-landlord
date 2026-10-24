/**
 * 契约行为断言 ②：version 丢弃规则（§6.2「同一版本的多条推送」/ M02 / M08）。
 *
 * 这是本项目最容易写错的一条：一次状态转移会发**两条**推送
 * （`game.state_update` → `game.current_turn`），它们**共享同一个 version**。
 * 所以「version <= currentVersion 即丢弃」这个直觉写法是错的——
 * 第二条 `game.current_turn` 会被丢掉，玩家永远收不到自己的回合（F07/M06 随之失效）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../src/stores/game';
import type { ReconnectReason } from '../src/net/socket';
import { playerViewFixture, makeCards } from './helpers/fake-socket';

function freshStore(onReconnect?: (r: ReconnectReason) => void) {
  setActivePinia(createPinia());
  return useGameStore().bindRuntime({ reconnect: (r) => onReconnect?.(r) });
}

describe('② 快照类的 version 判定（§6.2 表第 1 行 / M02 / M08）', () => {
  it('version > currentVersion → 应用，并推进 currentVersion', () => {
    const store = freshStore();

    expect(store.applySnapshot(playerViewFixture({ version: 3, hand: makeCards(3, 4, 5) }))).toBe('applied');
    expect(store.currentVersion).toBe(3);
    expect(store.view?.hand).toEqual(makeCards(3, 4, 5));

    expect(store.applySnapshot(playerViewFixture({ version: 4, hand: makeCards(3, 4) }))).toBe('applied');
    expect(store.currentVersion).toBe(4);
    expect(store.view?.hand).toEqual(makeCards(3, 4));
  });

  it('version === currentVersion → 丢弃（重复送达），本地状态不变', () => {
    const store = freshStore();
    store.applySnapshot(playerViewFixture({ version: 5, hand: makeCards(3, 4) }));

    const outcome = store.applySnapshot(playerViewFixture({ version: 5, hand: makeCards(9, 9, 9) }));

    expect(outcome).toBe('discarded');
    expect(store.currentVersion).toBe(5);
    expect(store.view?.hand).toEqual(makeCards(3, 4));
  });

  it('version < currentVersion → 回退：触发主动重连（M08），且不本地修复', () => {
    const reconnect = vi.fn();
    const store = freshStore(reconnect);
    store.applySnapshot(playerViewFixture({ version: 10, hand: makeCards(3, 4) }));

    const outcome = store.applySnapshot(playerViewFixture({ version: 9, hand: makeCards(9, 9, 9) }));

    expect(outcome).toBe('rollback');
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect.mock.calls[0]![0]).toMatchObject({ kind: 'version_rollback', version: 9 });
    // 不尝试本地修复：保留已应用的更高版本视图
    expect(store.currentVersion).toBe(10);
    expect(store.view?.hand).toEqual(makeCards(3, 4));
  });
});

describe('② 事件类不按 version 丢弃（§6.2 表第 2 行）', () => {
  /** 叫抢阶段的快照：行动者是 bidPhase.currentBidder（玩法 §9.1），currentPlayer 仍是 0 */
  const biddingSnapshot = (version: number, bidder: number, seat = 1) =>
    playerViewFixture({
      version,
      seat,
      state: 'bidding',
      currentPlayer: 0,
      bidPhase: {
        currentBidder: bidder,
        bidMultiplier: 1,
        landlordCandidate: -1,
        grabActions: 0,
        redealCount: 0,
        kind: 'call',
        decisions: [],
      },
    });

  it('与快照同版本的 game.current_turn 必须被处理（否则玩家永远收不到回合）', () => {
    const store = freshStore();
    store.applySnapshot(biddingSnapshot(7, 1));

    store.applyEvent({ type: 'game.current_turn', version: 7, payload: { seat: 1, timeoutMs: 30_000 } });

    expect(store.activeTurn).not.toBeNull();
    expect(store.activeTurnSeat).toBe(1);
    expect(store.actorSeat).toBe(1);
    expect(store.isMyTurn).toBe(true);
  });

  it('同一 version 的同一事件重复到达只渲染一次（幂等）', () => {
    const store = freshStore();
    store.applySnapshot(biddingSnapshot(7, 1));
    const applyTurn = () => {
      const seen = store.appliedEventKeys.length;
      store.applyEvent({ type: 'game.current_turn', version: 7, payload: { seat: 1, timeoutMs: 30_000 } });
      return store.appliedEventKeys.length - seen;
    };
    // 首次：记录一条
    expect(applyTurn()).toBe(1);
    // 第二次：同 version 同 type → 幂等，不再重复记录
    expect(applyTurn()).toBe(0);
    expect(store.appliedEventKeys.filter((k) => k.endsWith('@7')).length).toBe(1);
  });

  it('快照推进到新版本后，同类型事件可以再次处理', () => {
    const store = freshStore();
    store.applySnapshot(biddingSnapshot(7, 1));
    store.applyEvent({ type: 'game.current_turn', version: 7, payload: { seat: 1, timeoutMs: 30_000 } });
    expect(store.appliedEventKeys).toHaveLength(1);

    store.applySnapshot(biddingSnapshot(8, 2));
    store.applyEvent({ type: 'game.current_turn', version: 8, payload: { seat: 2, timeoutMs: 30_000 } });

    expect(store.appliedEventKeys).toHaveLength(2);
    expect(store.activeTurnSeat).toBe(2);
    expect(store.actorSeat).toBe(2);
  });

  it('game.finished / game.settlement 不被 version 判定拦截', () => {
    const store = freshStore();
    store.applySnapshot(playerViewFixture({ version: 12 }));

    store.applyEvent({ type: 'game.finished', version: 12, payload: { winner: 'landlord' } });
    store.applyEvent({
      type: 'game.settlement',
      version: 12,
      payload: {
        roomCode: 'MOCK01',
        baseScore: 100,
        winner: 'landlord',
        landlordSeat: 0,
        farmerSeats: [1, 2],
        multiplier: 2,
        spring: 'none',
        landlordScoreChange: 400,
        farmerScoreChange: -200,
      },
    });

    expect(store.finished).toMatchObject({ winner: 'landlord' });
    expect(store.settlement).toMatchObject({ winner: 'landlord' });
  });
});

describe('② 行动者定位：叫抢阶段读 bidPhase.currentBidder（玩法 §9.1）', () => {
  it('state === bidding 时，行动者是 currentBidder（即使 currentPlayer 仍是 0）', () => {
    const store = freshStore();
    // currentPlayer 在叫抢期间从不被更新（保持 0）；真正的行动者是 2 号
    store.applySnapshot(
      playerViewFixture({
        version: 2,
        seat: 2,
        state: 'bidding',
        currentPlayer: 0,
        bidPhase: {
          currentBidder: 2,
          bidMultiplier: 1,
          landlordCandidate: -1,
          grabActions: 2,
          redealCount: 0,
          kind: 'call',
          decisions: [],
        },
      }),
    );

    expect(store.actorSeat).toBe(2);
    expect(store.isMyTurn).toBe(true);
  });

  it('state === playing 时，行动者是 currentPlayer', () => {
    const store = freshStore();
    store.applySnapshot(
      playerViewFixture({
        version: 3,
        seat: 1,
        state: 'playing',
        currentPlayer: 1,
        landlordSeat: 0,
        bidPhase: {
          currentBidder: 2,
          bidMultiplier: 2,
          landlordCandidate: 0,
          grabActions: 3,
          redealCount: 0,
          kind: 'rob',
          decisions: [],
        },
      }),
    );

    expect(store.actorSeat).toBe(1);
  });

  it('底牌在叫抢阶段恒为 null，state === playing 后才可见（§6.4）', () => {
    const store = freshStore();
    store.applySnapshot(playerViewFixture({ version: 1, state: 'bidding' }));
    expect(store.ddzView?.bottomCards).toBeNull();

    store.applySnapshot(
      playerViewFixture({ version: 2, state: 'playing', landlordSeat: 0, bottomCards: makeCards(20, 30, 17) }),
    );
    expect(store.ddzView?.bottomCards).toEqual(makeCards(20, 30, 17));
    expect(store.landlordSeat).toBe(0);
  });
});

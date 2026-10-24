import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { PdkPlayerView } from '@fight-the-landlord/protocol';
import { useGameStore } from '../src/stores/game';
import { playerViewFixture, makeCards } from './helpers/fake-socket';

/**
 * S5.3（spec §4.10.1）：store 的**玩法感知**。
 *
 * - 旧 ddz 视图（无 gameType）按斗地主解析；新 pdk 视图按 gameType 解析；
 * - pdk 专属字段存在但 `gameType` 缺失 ⇒ **丢弃**（绝不按斗地主渲染）；
 * - `activeMode`/`playerCount` 随快照写回，ddz getter 在 pdk 局为 null。
 */
function pdkView(over: Partial<PdkPlayerView> = {}): PdkPlayerView {
  return {
    roomCode: 'PDK1',
    gameType: 'paodekuai',
    playerCount: 3,
    version: 1,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: makeCards(3, 4),
    cardCounts: [2, 16, 16],
    trustees: [false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 1_700_000_030_000,
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
    ...over,
  };
}

describe('S5.3：store 视图玩法解析', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('旧 ddz 视图（无 gameType）⇒ doudizhu/3；ddz getter 正常', () => {
    const store = useGameStore();
    const view = playerViewFixture({ version: 1, seat: 1 });
    expect(store.applySnapshot(view)).toBe('applied');

    expect(store.gameType).toBe('doudizhu');
    expect(store.activeMode).toBe('doudizhu');
    expect(store.playerCount).toBe(3);
    expect(store.ddzView).not.toBeNull();
    expect(store.pdkView).toBeNull();
    expect(store.actorSeat).toBe(0);
  });

  it('pdk 视图 ⇒ 保留视图、activeMode/playerCount 写回；ddz getter 全部让位', () => {
    const store = useGameStore();
    const view = pdkView({ playerCount: 3, canPass: true, bombCount: 2 });
    expect(store.applySnapshot(view)).toBe('applied');

    expect(store.gameType).toBe('paodekuai');
    expect(store.activeMode).toBe('paodekuai');
    expect(store.playerCount).toBe(3);
    expect(store.view?.roomCode).toBe('PDK1');
    expect(store.hand).toEqual(makeCards(3, 4));
    expect(store.pdkView?.canPass).toBe(true);
    expect(store.canPass).toBe(true);
    expect(store.pdkBombCount).toBe(2);
    expect(store.pdkRules?.multiplierCap).toBe(64);
    // ddz 专属 getter 不得把 pdk 视图当斗地主
    expect(store.ddzView).toBeNull();
    expect(store.landlordSeat).toBeNull();
    expect(store.bottomCards).toBeNull();
    expect(store.ddzBidPhase).toBeNull();
    expect(store.ddzPlayPhase).toBeNull();
  });

  it('pdk 专属字段存在但缺 gameType ⇒ 丢弃（fail closed，view 保持 null）', () => {
    const store = useGameStore();
    const malformed = { ...pdkView(), gameType: undefined };
    expect(store.applySnapshot(malformed as never)).toBe('discarded');
    expect(store.view).toBeNull();
    expect(store.currentVersion).toBe(-1);
  });

  it('pdk 视图同样参与 version 幂等/回退判定', () => {
    const store = useGameStore();
    expect(store.applySnapshot(pdkView({ version: 3 }))).toBe('applied');
    expect(store.applySnapshot(pdkView({ version: 3 }))).toBe('discarded');
    expect(store.applySnapshot(pdkView({ version: 2 }))).toBe('rollback');
  });
});

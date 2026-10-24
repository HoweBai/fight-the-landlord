import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PdkPlayerView } from '@fight-the-landlord/protocol';
import { audioContexts, installUniStub } from './helpers/uni-stub';
import { FakeSocket, makeCards } from './helpers/fake-socket';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { __resetAudioForTest, setMuted, stopBgm } from '../src/audio';

/**
 * S6.2：跑得快音效策略。
 *
 * 只播出牌/过牌/输赢：非炸弹出牌**不播**斗地主牌型播报；炸弹播 `Bomb`；
 * 过牌播 `Buyao*`；结算按 `winnerSeats` 播 Win/Lose。
 */
const RULES = {
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
  const hand = over.hand ?? makeCards(3, 4, 5);
  return {
    roomCode: 'PDK-SND',
    gameType: 'paodekuai',
    playerCount: 3,
    version: 1,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand,
    cardCounts: [hand.length, 16, 16],
    trustees: [false, false, false],
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 1_700_000_030_000,
    canPass: false,
    bombCount: 0,
    pdkRules: RULES,
    ...over,
  };
}

const srcs = () => audioContexts.map((c) => c.src.at(-1));

describe('S6.2：跑得快音效', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    installUniStub();
    audioContexts.length = 0;
    stopBgm();
    setMuted(false);
    __resetAudioForTest();
    pinia = createPinia();
    setActivePinia(pinia);
    startGameSession(() => new FakeSocket());
  });
  afterEach(() => {
    stopGameSession();
  });

  it('非炸弹出牌不播牌型播报；炸弹播 Bomb；过牌播 Buyao；结算按 winnerSeats 播 Win', async () => {
    const store = useGameStore();
    store.applySnapshot(pdkView());
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();
    // 预热/挂载产生的上下文清掉，只看本次视图 diff
    audioContexts.length = 0;

    // ① 单张出牌 ⇒ 不播任何牌型播报
    store.applySnapshot(
      pdkView({ version: 2, recentActions: [{ seat: 1, cards: makeCards(6) }] }),
    );
    await flushPromises();
    expect(srcs().filter(Boolean)).toEqual([]);

    // ② 炸弹出牌 ⇒ Bomb
    store.applySnapshot(
      pdkView({
        version: 3,
        bombCount: 1,
        recentActions: [{ seat: 1, cards: makeCards(7, 7, 7, 7) }],
      }),
    );
    await flushPromises();
    expect(srcs()).toContain('/pages/table/static/audio/Woman_zhadan.mp3');

    // ③ 过牌 ⇒ Buyao
    audioContexts.length = 0;
    store.applySnapshot(
      pdkView({
        version: 4,
        bombCount: 1,
        recentActions: [
          { seat: 1, cards: makeCards(7, 7, 7, 7) },
          { seat: 0, cards: null },
        ],
      }),
    );
    await flushPromises();
    expect(srcs().some((s) => s?.includes('Woman_buyao'))).toBe(true);

    // ④ 结算：我在 winnerSeats ⇒ Win
    audioContexts.length = 0;
    store.applyEvent({
      type: 'game.settlement',
      version: 5,
      payload: {
        roomCode: 'PDK-SND',
        gameType: 'paodekuai',
        playerCount: 3,
        baseScore: 15,
        winnerSeats: [0],
        scoreChanges: [
          { seat: 0, delta: 30 },
          { seat: 1, delta: -30 },
          { seat: 2, delta: 0 },
        ],
        remaining: [0, 4, 2],
        multiplier: 1,
        bombCount: 1,
        guan: false,
        spring: false,
        baobenSeats: [],
      },
    });
    await flushPromises();
    expect(srcs()).toContain('/pages/table/static/audio/MusicEx_Win.mp3');
    wrapper.unmount();
  });
});

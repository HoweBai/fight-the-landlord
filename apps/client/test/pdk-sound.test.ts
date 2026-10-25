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
 * S6.2：跑得快音效策略（2026-10-25 语音复用）。
 *
 * 复用斗地主素材：牌型播报（点数/牌型名）、过牌、报单/报双、输赢；
 * 不播王/王炸/叫抢（跑得快没有）。4 人 seat 3 过牌回退 `Buyao1`。
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
  const playerCount = (over.playerCount ?? 3) as 2 | 3 | 4;
  const perSeat = playerCount === 4 ? 12 : 16;
  return {
    roomCode: 'PDK-SND',
    gameType: 'paodekuai',
    playerCount,
    version: 1,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand,
    cardCounts: Array.from({ length: playerCount }, (_, i) => (i === 0 ? hand.length : perSeat)),
    trustees: Array.from({ length: playerCount }, () => false),
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
const AUDIO = '/pages/table/static/audio';

describe('S6.2：跑得快音效', () => {
  let pinia: ReturnType<typeof createPinia>;
  let uniStub: ReturnType<typeof installUniStub>;
  beforeEach(() => {
    uniStub = installUniStub();
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

  it('牌型播报：单张/对子/连对/炸弹精确选音', async () => {
    const store = useGameStore();
    store.applySnapshot(pdkView());
    mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();
    audioContexts.length = 0;

    store.applySnapshot(pdkView({ version: 2, recentActions: [{ seat: 1, cards: makeCards(6) }] }));
    await flushPromises();
    expect(srcs()).toContain(`${AUDIO}/Woman_6.mp3`);

    audioContexts.length = 0;
    store.applySnapshot(
      pdkView({ version: 3, recentActions: [{ seat: 1, cards: makeCards(8, 8) }] }),
    );
    await flushPromises();
    expect(srcs()).toContain(`${AUDIO}/Woman_dui8.mp3`);

    audioContexts.length = 0;
    store.applySnapshot(
      pdkView({
        version: 4,
        recentActions: [{ seat: 1, cards: makeCards(3, 3, 4, 4) }],
      }),
    );
    await flushPromises();
    expect(srcs()).toContain(`${AUDIO}/Woman_liandui.mp3`);

    audioContexts.length = 0;
    store.applySnapshot(
      pdkView({
        version: 5,
        bombCount: 1,
        recentActions: [{ seat: 1, cards: makeCards(7, 7, 7, 7) }],
      }),
    );
    await flushPromises();
    expect(srcs()).toContain(`${AUDIO}/Woman_zhadan.mp3`);
  });

  it('过牌按座位：4 人 seat 3 → Buyao1；seat 1 → Buyao2', async () => {
    const store = useGameStore();
    store.applySnapshot(pdkView({ playerCount: 4, hand: makeCards(3, 4, 5) }));
    mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();
    audioContexts.length = 0;

    store.applySnapshot(
      pdkView({
        playerCount: 4,
        hand: makeCards(3, 4, 5),
        version: 2,
        recentActions: [{ seat: 3, cards: null }],
      }),
    );
    await flushPromises();
    expect(store.view?.playerCount, '前置：4 人视图').toBe(4);
    expect(store.recentActions.at(-1)?.seat, '前置：最新动作是 seat 3').toBe(3);
    expect(srcs()).toContain(`${AUDIO}/Woman_buyao1.mp3`);

    audioContexts.length = 0;
    store.applySnapshot(
      pdkView({
        playerCount: 4,
        hand: makeCards(3, 4, 5),
        version: 3,
        recentActions: [
          { seat: 3, cards: null },
          { seat: 1, cards: null },
        ],
      }),
    );
    await flushPromises();
    expect(srcs()).toContain(`${AUDIO}/Woman_buyao2.mp3`);
  });

  it('报单/报双：首版快照不补播，真实跃迁才播并震动', async () => {
    const store = useGameStore();
    mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();
    const before = audioContexts.length;

    // 首版快照：seat1 已剩 2 张 + 一条历史出牌 ⇒ 只登记游标，零 cue
    store.applySnapshot(
      pdkView({
        version: 1,
        cardCounts: [3, 2, 16],
        recentActions: [{ seat: 1, cards: makeCards(6) }],
      }),
    );
    await flushPromises();
    expect(store.view, '首版快照必须真的进了 store').not.toBeNull();
    expect(srcs().slice(before), '首版快照不得补播').toEqual([]);
    expect(uniStub.calls.vibrateShort).toBe(0);

    // 真实跃迁 2→1 ⇒ 报单（长震）
    store.applySnapshot(
      pdkView({
        version: 2,
        cardCounts: [3, 1, 16],
        recentActions: [{ seat: 1, cards: makeCards(6) }],
      }),
    );
    await flushPromises();
    expect(srcs()).toContain(`${AUDIO}/Woman_baojing1.mp3`);
    expect(uniStub.calls.vibrateLong).toBe(1);
  });

  it('报双：3→2 播 Baojing2 并短震', async () => {
    const store = useGameStore();
    store.applySnapshot(pdkView({ cardCounts: [3, 3, 16] }));
    mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();
    audioContexts.length = 0;

    store.applySnapshot(pdkView({ version: 2, cardCounts: [3, 2, 16] }));
    await flushPromises();
    expect(srcs()).toContain(`${AUDIO}/Woman_baojing2.mp3`);
    expect(uniStub.calls.vibrateShort).toBe(1);
  });

  it('结算按 winnerSeats 播 Win；结算后不再播牌型', async () => {
    const store = useGameStore();
    store.applySnapshot(pdkView());
    mount(TablePage, { global: { plugins: [pinia] } });
    await flushPromises();
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
    expect(srcs()).toContain(`${AUDIO}/MusicEx_Win.mp3`);

    audioContexts.length = 0;
    store.applySnapshot(
      pdkView({ version: 6, recentActions: [{ seat: 1, cards: makeCards(6) }] }),
    );
    await flushPromises();
    expect(srcs(), '结算锁：不再播牌型').toEqual([]);
  });
});

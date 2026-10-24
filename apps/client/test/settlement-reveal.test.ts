import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { DdzSettlementResult } from '@fight-the-landlord/protocol';
import { useGameStore } from '../src/stores/game';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import TablePage from '../src/pages/table/table.vue';
import { FakeSocket, makeCards, playerViewFixture, serverMessage } from './helpers/fake-socket';
import { collectSourceFiles, stripComments } from './helpers/source-scan';
import {
  SETTLEMENT_REVEAL_DELAY_MS,
  __resetSettlementRevealDelayForTest,
  __setSettlementRevealDelayForTest,
  getSettlementRevealDelayMs,
} from '../src/composables/settlementRevealDelay';
import {
  useSettlementReveal,
  __resetSettlementRevealArrivalsForTest,
} from '../src/composables/useSettlementReveal';

const FIXTURE: DdzSettlementResult = {
  roomCode: 'ROOM01',
  baseScore: 100,
  winner: 'landlord',
  landlordSeat: 2,
  farmerSeats: [0, 1],
  multiplier: 4,
  spring: 'spring',
  landlordScoreChange: 777,
  farmerScoreChange: -388.5,
};

/**
 * 模块顶层读取：早于任何 `beforeEach`（`test/setup.ts` 的 0ms 覆写尚未执行）⇒
 * 这是**生产模块初值**，不会被 `__reset` 掩盖。
 */
const INITIAL_DELAY_MS = getSettlementRevealDelayMs();

function settlement(): DdzSettlementResult {
  return { ...FIXTURE };
}

function mountComposable() {
  const scope = effectScope();
  const api = scope.run(() => useSettlementReveal())!;
  return { scope, ...api };
}

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
});

function mountTable() {
  const socket = new FakeSocket();
  // 🔴 顺序：先 setActivePinia（文件级 beforeEach），再 startGameSession。
  // 反了会让 createSessionOptions 在无 active pinia 时抛，或把消息写进旧 store。
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}

describe('useSettlementReveal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    __resetSettlementRevealArrivalsForTest();
    // D8：用 __reset 验证生产默认值，不用 __set(常量)（后者会掩盖模块初值被改错）。
    __resetSettlementRevealDelayForTest();
    expect(getSettlementRevealDelayMs()).toBe(SETTLEMENT_REVEAL_DELAY_MS);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __setSettlementRevealDelayForTest(0);
  });

  it('生产默认 2000ms：1999ms 不揭示，2000ms 揭示', async () => {
    const store = useGameStore();
    const { revealed } = mountComposable();
    store.settlement = settlement();
    await nextTick();
    expect(revealed.value).toBe(false);

    vi.advanceTimersByTime(1999);
    await nextTick();
    expect(revealed.value).toBe(false);

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(revealed.value).toBe(true);
  });

  it('重挂载按剩余时间：1000ms 后卸载，重挂再等 999ms 不揭示、1ms 揭示', async () => {
    const store = useGameStore();
    store.settlement = settlement();

    const first = mountComposable();
    await nextTick();
    vi.advanceTimersByTime(1000);
    first.scope.stop();

    const second = mountComposable();
    await nextTick();
    vi.advanceTimersByTime(999);
    await nextTick();
    expect(second.revealed.value).toBe(false);

    vi.advanceTimersByTime(1);
    await nextTick();
    expect(second.revealed.value).toBe(true);
  });

  it('已揭示后同一 settlement 的副本再次进入 watch ⇒ 不重新隐藏', async () => {
    const store = useGameStore();
    const s = settlement();
    const { revealed } = mountComposable();
    store.settlement = s;
    await nextTick();
    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(revealed.value).toBe(true);

    store.settlement = { ...s };
    await nextTick();
    expect(revealed.value).toBe(true);
  });

  it('settlement 置 null ⇒ 复位 revealed/receivedAt 并清表', async () => {
    const store = useGameStore();
    const { revealed, receivedAt } = mountComposable();
    store.settlement = settlement();
    await nextTick();
    expect(receivedAt.value).not.toBeNull();

    store.settlement = null;
    await nextTick();
    expect(revealed.value).toBe(false);
    expect(receivedAt.value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('scope 停止 ⇒ 清定时器，推进时钟不再改 revealed', async () => {
    const store = useGameStore();
    const { scope, revealed } = mountComposable();
    store.settlement = settlement();
    await nextTick();
    expect(vi.getTimerCount()).toBe(1);

    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    await nextTick();
    expect(revealed.value).toBe(false);
  });

  it('测试覆写校验：负数 / NaN / Infinity 抛错', () => {
    expect(() => __setSettlementRevealDelayForTest(-1)).toThrow(/finite and >= 0/);
    expect(() => __setSettlementRevealDelayForTest(Number.NaN)).toThrow(/finite and >= 0/);
    expect(() => __setSettlementRevealDelayForTest(Number.POSITIVE_INFINITY)).toThrow(
      /finite and >= 0/,
    );
  });

  it('常量值恰为 2000（辅助断言）', () => {
    expect(SETTLEMENT_REVEAL_DELAY_MS).toBe(2000);
  });

  it('模块顶层观测到的生产初值 = 2000（防 let delayMs = 0 被 __reset 掩盖）', () => {
    expect(INITIAL_DELAY_MS).toBe(2000);
  });
});

describe('table.vue 结算延迟揭示', () => {
  it('延迟窗口内更多/记牌器可用；揭示时触发器与面板一起离开 DOM', async () => {
    __resetSettlementRevealDelayForTest();
    __resetSettlementRevealArrivalsForTest();
    vi.useFakeTimers();
    try {
      const { wrapper, socket, store } = mountTable();
      store.cardCounterEnabled = true;
      socket.push(
        serverMessage('game.state_update', playerViewFixture({ state: 'playing', version: 2 }), 2),
      );
      await nextTick();
      socket.push(serverMessage('game.settlement', FIXTURE, 3));
      await nextTick();

      // 0ms：横条仍在（gate=true + settlementRevealed 还没到）
      expect(wrapper.find('.table__more').exists()).toBe(true);
      await wrapper.find('.table__more').trigger('click');
      expect(wrapper.find('.table__more-mask').exists()).toBe(true);
      // 有 gate ⇒ 横条直接显示，不需要按钮
      expect(wrapper.find('.counter').exists()).toBe(true);
      expect(wrapper.find('.table__counter').exists(), '记牌器按钮已移除').toBe(false);
      expect(wrapper.find('.table__settlement').exists()).toBe(false);

      // 1999ms：仍可用，结算仍未出现
      vi.advanceTimersByTime(1999);
      await nextTick();
      expect(wrapper.find('.table__more-mask').exists()).toBe(true);
      expect(wrapper.find('.counter').exists()).toBe(true);
      expect(wrapper.find('.table__settlement').exists()).toBe(false);

      // 2000ms：面板、横条一起消失
      vi.advanceTimersByTime(1);
      await nextTick();
      expect(wrapper.find('.table__more-mask').exists(), '揭示时弹层卸载').toBe(false);
      expect(wrapper.find('.table__more').exists(), '揭示时更多触发器卸载').toBe(false);
      expect(wrapper.find('.counter').exists(), '揭示时记牌器横条让位').toBe(false);
      expect(wrapper.find('.table__settlement').exists()).toBe(true);

      // 复位后横条重新出现（gate 还在，settlementRevealed 没了）
      store.settlement = null;
      await nextTick();
      expect(wrapper.find('.table__more-mask').exists(), '弹层已复位').toBe(false);
      expect(wrapper.find('.counter').exists(), '横条重新出现（gate 仍 true）').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('table.vue 终局最后一手与动作 fail-safe', () => {
  it('核心场景：我自己打出最后一手 ⇒ 2s 内 .table__my-play 仍在，结算不出现', async () => {
    __resetSettlementRevealDelayForTest();
    __resetSettlementRevealArrivalsForTest();
    vi.useFakeTimers();
    try {
      const { wrapper, socket, store } = mountTable();
      socket.push(
        serverMessage(
          'game.state_update',
          playerViewFixture({
            state: 'ended',
            version: 2,
            seat: 0,
            recentActions: [{ seat: 0, cards: makeCards(9, 9) }],
          }),
          2,
        ),
      );
      await nextTick();
      socket.push(serverMessage('game.settlement', FIXTURE, 3));
      await nextTick();

      expect(store.isEnded).toBe(true);
      expect(wrapper.find('.table__scrim').exists()).toBe(false);
      expect(wrapper.find('.table__settlement').exists()).toBe(false);
      expect(wrapper.find('.settlement__again').exists()).toBe(false);
      expect(wrapper.find('.settlement__lobby').exists()).toBe(false);
      expect(
        wrapper.findAll('.table__my-play .card').map((c) => c.attributes('data-value')),
        '我的最后一手（按槽位限定，不数对手槽位）',
      ).toEqual(['9', '9']);

      vi.advanceTimersByTime(1999);
      await nextTick();
      expect(wrapper.find('.table__my-play').exists()).toBe(true);
      expect(wrapper.find('.table__scrim').exists(), '1999ms 仍不压暗').toBe(false);
      expect(wrapper.find('.table__settlement').exists()).toBe(false);
      expect(wrapper.find('.settlement__again').exists()).toBe(false);
      expect(wrapper.find('.settlement__lobby').exists()).toBe(false);

      vi.advanceTimersByTime(1);
      await nextTick();
      expect(wrapper.find('.table__scrim').exists(), '揭示时压暗').toBe(true);
      expect(wrapper.find('.table__settlement').exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('对手打出最后一手：对手槽位仍渲染最后一手（正对照）', async () => {
    const { wrapper, socket } = mountTable();
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'ended',
          version: 2,
          seat: 0,
          recentActions: [{ seat: 1, cards: makeCards(10, 10) }],
        }),
        2,
      ),
    );
    await nextTick();
    expect(
      wrapper.findAll('.table__play-col--right .card').map((c) => c.attributes('data-value')),
      'mySeat=0 时座位 1 是右列（seats = [2,1]）',
    ).toEqual(['10', '10']);
    expect(
      wrapper.findAll('.table__play-col--left .card'),
      '左列（座位 2）没有最后一手',
    ).toHaveLength(0);
  });

  it('ended 且我的动作是「不出」⇒ 不渲染空 PlayArea，仍显示「本局结束」', async () => {
    const { wrapper, socket } = mountTable();
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'ended',
          version: 2,
          seat: 0,
          recentActions: [{ seat: 0, cards: null }],
        }),
        2,
      ),
    );
    await nextTick();
    expect(wrapper.find('.table__my-play').exists()).toBe(false);
    expect(wrapper.find('.table__ended').text()).toBe('本局结束');
  });

  it('ended 且窗口里没有我的动作 ⇒ 仍显示「本局结束」', async () => {
    const { wrapper, socket } = mountTable();
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({ state: 'ended', version: 2, seat: 0, recentActions: [] }),
        2,
      ),
    );
    await nextTick();
    expect(wrapper.find('.table__ended').text()).toBe('本局结束');
    expect(wrapper.find('.table__my-play').exists()).toBe(false);
  });

  it('fail-safe：settlement 已到但 ended 视图缺失 ⇒ 动作行不渲染、手牌禁用、不发请求', async () => {
    const { wrapper, socket, store } = mountTable();
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          version: 2,
          seat: 0,
          currentPlayer: 0,
          hand: makeCards(3, 4, 5),
        }),
        2,
      ),
    );
    await nextTick();
    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await nextTick();

    expect(wrapper.find('.table__play').exists()).toBe(false);
    expect(wrapper.find('.table__pass').exists()).toBe(false);
    expect(wrapper.find('.table__hint').exists()).toBe(false);
    expect(wrapper.find('.table__ended').exists()).toBe(true);
    expect(wrapper.findAll('.table__me .card--disabled')).toHaveLength(store.hand.length);

    // 点击手牌：disabled 的原生 button 不应派发事件 ⇒ 不选中、不发请求。
    await wrapper.find('.table__me .card').trigger('click');
    expect(wrapper.findAll('.table__me .card--selected')).toHaveLength(0);
    expect(socket.emittedOf('game.play')).toHaveLength(0);
    expect(socket.emittedOf('game.pass')).toHaveLength(0);
  });

  it('fail-safe：settlement 到达时我的上一手回显也必须消失', async () => {
    const { wrapper, socket } = mountTable();
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          version: 2,
          seat: 0,
          recentActions: [{ seat: 0, cards: makeCards(9) }],
        }),
        2,
      ),
    );
    await nextTick();
    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await nextTick();

    expect(wrapper.find('.table__my-play').exists()).toBe(false);
    expect(wrapper.find('.table__ended').exists()).toBe(true);
  });

  it('fail-safe：settlement 到达时我的「不出」回显也必须消失', async () => {
    const { wrapper, socket } = mountTable();
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          version: 2,
          seat: 0,
          recentActions: [{ seat: 0, cards: null }],
        }),
        2,
      ),
    );
    await nextTick();
    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await nextTick();

    expect(wrapper.find('.table__my-pass').exists()).toBe(false);
    expect(wrapper.find('.table__ended').exists()).toBe(true);
  });

  it('fail-safe：settlement 到达时叫抢按钮也不渲染', async () => {
    const { wrapper, socket } = mountTable();
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'bidding',
          version: 2,
          seat: 0,
          bidPhase: {
            currentBidder: 0,
            bidMultiplier: 1,
            landlordCandidate: -1,
            grabActions: 0,
            redealCount: 0,
            kind: 'call',
            decisions: [],
          },
        }),
        2,
      ),
    );
    await nextTick();
    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await nextTick();

    expect(wrapper.find('.table__bid-grab').exists()).toBe(false);
    expect(wrapper.find('.table__bid-pass').exists()).toBe(false);
    expect(wrapper.find('.table__ended').exists()).toBe(true);
    expect(socket.emittedOf('game.bid')).toHaveLength(0);
  });
});

describe('结算延迟源码闸', () => {
  it('src/** 不得使用测试专用延迟函数（排除两个定义文件；含正对照）', () => {
    const TEST_HOOK =
      /__(?:setSettlementRevealDelayForTest|resetSettlementRevealDelayForTest|resetSettlementRevealArrivalsForTest)\b/;
    const DEFINITION_FILES = new Set([
      'src/composables/settlementRevealDelay.ts',
      'src/composables/useSettlementReveal.ts',
    ]);

    // 正对照：import / namespace / dynamic 三种形态都必须被同一条正则命中。
    expect(TEST_HOOK.test("import { __setSettlementRevealDelayForTest } from './x'")).toBe(true);
    expect(TEST_HOOK.test('m.__setSettlementRevealDelayForTest(0)')).toBe(true);
    expect(
      TEST_HOOK.test(
        "const m = await import('./settlementRevealDelay'); m.__setSettlementRevealDelayForTest(0)",
      ),
    ).toBe(true);
    expect(TEST_HOOK.test("await import('./x')"), '无反例：纯 import 不含函数名').toBe(false);

    const offenders = collectSourceFiles()
      .filter((f) => f.path.startsWith('src/') && !DEFINITION_FILES.has(f.path))
      .filter((f) => TEST_HOOK.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

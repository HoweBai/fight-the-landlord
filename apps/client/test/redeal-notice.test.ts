/**
 * 重新发牌可感知化（2026-10-22 片）。
 *
 * 判据射程（诚实版）：
 *  · composable 单测：服务端 `redealCount` 的**递增**是否被正确译成
 *    「横幅可见 + 动画世代」两个展示位；第 3 次流局（不再重发）不得触发；
 *    首版视图只做基线；换局/视图销毁必须把计时器清干净。
 *  · 页面集成：横幅真的渲染、手牌真的整手重挂载、2 秒后收掉、震动真的调用。
 *
 * ⚠️ jsdom 不跑 CSS：这里**不证明**动画好看/流畅，只钉会静默失效的机械事实。
 * ⚠️ 计时器只在 composable 里：牌桌区组件的「不新造时钟」闸见 animations.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../src/stores/game';
import { REDEAL_BANNER_MS, useRedealNotice } from '../src/composables/useRedealNotice';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { setHapticsEnabled } from '../src/feedback/haptics';
import TablePage from '../src/pages/table/table.vue';
import { bidPhase } from './helpers/bid-phase';
import { FakeSocket, makeCards, playerViewFixture, serverMessage } from './helpers/fake-socket';
import { installUniStub } from './helpers/uni-stub';
import type { Card as ProtocolCard, PlayerView } from '@fight-the-landlord/protocol';

/** 一版叫抢/出牌视图；`version` 递增只为贴近真实快照语义（本文件的 `$patch` 不走 version 闸）。 */
function view(count: number, state: PlayerView['state'] = 'bidding'): PlayerView {
  return playerViewFixture({
    state,
    version: count + 10,
    bidPhase: bidPhase({ redealCount: count }),
  });
}

let pinia: ReturnType<typeof createPinia>;
const scopes: Array<ReturnType<typeof effectScope>> = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.useRealTimers();
});

function mountComposable() {
  const scope = effectScope();
  const api = scope.run(() => useRedealNotice())!;
  scopes.push(scope);
  return { scope, ...api };
}

describe('useRedealNotice', () => {
  it('T1 首版视图只做基线：挂载时已有 redealCount=1 不弹横幅、不重放动画', async () => {
    const store = useGameStore();
    store.$patch({ view: view(1) });

    const { visible, epoch } = mountComposable();
    await nextTick();

    expect(visible.value, '进房/重连时已有重发次数 ⇒ 不得补播').toBe(false);
    expect(epoch.value).toBe(0);
  });

  it('T2 真重发触发横幅，REDEAL_BANNER_MS 到点自动收掉', async () => {
    const store = useGameStore();
    const { visible, epoch } = mountComposable();

    store.$patch({ view: view(0) }); // 首版基线
    await nextTick();
    expect(visible.value, '首版不触发').toBe(false);

    store.$patch({ view: view(1) }); // 真重发
    await nextTick();
    expect(visible.value).toBe(true);
    expect(epoch.value).toBe(1);

    vi.advanceTimersByTime(REDEAL_BANNER_MS - 1);
    expect(visible.value, '未到时长仍在').toBe(true);
    vi.advanceTimersByTime(1);
    expect(visible.value, '到点必须收掉').toBe(false);
  });

  it('T3 2 秒内连续两次重发：epoch 累加，计时器从第二次重新起算', async () => {
    const store = useGameStore();
    const { visible, epoch } = mountComposable();

    store.$patch({ view: view(0) });
    await nextTick();
    store.$patch({ view: view(1) });
    await nextTick();
    expect(epoch.value).toBe(1);

    vi.advanceTimersByTime(1000); // 第一次的 2s 还没到
    store.$patch({ view: view(2) });
    await nextTick();
    expect(epoch.value).toBe(2);

    vi.advanceTimersByTime(REDEAL_BANNER_MS - 1);
    expect(visible.value, '若沿用第一次的计时器，这里已经被掐掉').toBe(true);
    vi.advanceTimersByTime(1);
    expect(visible.value).toBe(false);
  });

  it('T4 第 3 次流局（同版视图 state=playing，不再重发）不触发', async () => {
    const store = useGameStore();
    const { visible, epoch } = mountComposable();

    store.$patch({ view: view(2) }); // 首版基线（例如重连回来就是第 2 次流局后）
    await nextTick();
    store.$patch({ view: view(3, 'playing') }); // 第 3 次流局 ⇒ 直接随机指定地主
    await nextTick();

    expect(visible.value).toBe(false);
    expect(epoch.value).toBe(0);
  });

  it('T5 count 回落（新局）清横幅、清计时器、epoch 归零', async () => {
    const store = useGameStore();
    const { visible, epoch } = mountComposable();

    store.$patch({ view: view(0) });
    await nextTick();
    store.$patch({ view: view(1) });
    await nextTick();
    expect(visible.value).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    store.$patch({ view: view(0) }); // 新的一局
    await nextTick();
    expect(visible.value).toBe(false);
    expect(epoch.value).toBe(0);
    expect(vi.getTimerCount(), '陈旧计时器必须被清掉').toBe(0);
  });

  it('T6 视图销毁（view=null）清横幅、清计时器、epoch 归零', async () => {
    const store = useGameStore();
    const { visible, epoch } = mountComposable();

    store.$patch({ view: view(0) });
    await nextTick();
    store.$patch({ view: view(1) });
    await nextTick();
    expect(visible.value).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    store.$patch({ view: null });
    await nextTick();
    expect(visible.value).toBe(false);
    expect(epoch.value).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T6b 页面卸载（scope.stop）清计时器：不留悬挂回调', async () => {
    const store = useGameStore();
    const { scope, visible } = mountComposable();

    store.$patch({ view: view(0) });
    await nextTick();
    store.$patch({ view: view(1) });
    await nextTick();
    expect(visible.value).toBe(true);
    expect(vi.getTimerCount(), '横幅可见时确实有一个计时器').toBe(1);

    scope.stop();
    expect(vi.getTimerCount(), 'onScopeDispose 必须把它清掉').toBe(0);
  });

  it('T13 横幅可见时 state 离开 bidding：立即隐藏（不等计时器），epoch 不变', async () => {
    const store = useGameStore();
    const { visible, epoch } = mountComposable();

    store.$patch({ view: view(0) });
    await nextTick();
    store.$patch({ view: view(1) });
    await nextTick();
    expect(visible.value).toBe(true);

    store.$patch({ view: view(1, 'playing') }); // 同一秒内机器人把地主定下来
    await nextTick();
    expect(visible.value, '不能把“重新发牌”滞留在出牌期').toBe(false);
    expect(epoch.value).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T14 同页面重连（view 保留、resync count 升高）照常触发', async () => {
    const store = useGameStore();
    const { visible, epoch } = mountComposable();

    store.$patch({ view: view(1) }); // 首版视图（进房/重连回来）
    await nextTick();
    expect(visible.value, '首版只做基线').toBe(false);

    store.$patch({ view: view(2) }); // 页面未卸载，resync 拿到更高 count ⇒ 真实重发
    await nextTick();
    expect(visible.value).toBe(true);
    expect(epoch.value).toBe(1);
  });
});

/* ───────────────────────── 页面集成 ───────────────────────── */

/**
 * 两套 17 张手牌**都含大王 `{r:30,s:4}`**：降序展示后第一张恒为大王。
 * 若 `:key="redealEpoch"` 没生效，第一张牌的 key 不变 ⇒ DOM 元素会被复用
 * ⇒ 元素身份断言有判别力（不是“换了手牌所以当然重建”）。
 */
const HAND_A: ProtocolCard[] = makeCards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30, 3, 4);
const HAND_B: ProtocolCard[] = makeCards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30, 3, 5);

function viewOf(over: {
  version: number;
  redealCount: number;
  hand: ProtocolCard[];
  state?: PlayerView['state'];
}): PlayerView {
  const playing = over.state === 'playing';
  return playerViewFixture({
    version: over.version,
    state: over.state ?? 'bidding',
    hand: over.hand,
    landlordSeat: playing ? 1 : null,
    currentPlayer: playing ? 1 : 0,
    bidPhase: bidPhase({ redealCount: over.redealCount }),
  });
}

describe('table.vue 集成：重新发牌的可感知化', () => {
  let stub: ReturnType<typeof installUniStub>;
  const mounted: VueWrapper[] = [];

  beforeEach(() => {
    // ⚠️ 替身句柄要留着做计数断言（setHapticsEnabled 不会清计数）。
    stub = installUniStub();
    setHapticsEnabled(true);
  });

  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    stopGameSession();
  });

  function mountTable() {
    const socket = new FakeSocket();
    // 顺序：外层 beforeEach 已 setActivePinia ⇒ startGameSession → setRoom → mount。
    startGameSession(() => socket);
    const store = useGameStore();
    store.setRoom('ROOM1', 0);
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    mounted.push(wrapper);
    return { wrapper, socket, store };
  }

  /** 推一版叫抢视图（`game.deal` 首版 / `game.state_update` 后续）。 */
  async function pushView(
    socket: FakeSocket,
    wrapper: VueWrapper,
    type: 'game.deal' | 'game.state_update',
    view: PlayerView,
  ) {
    socket.push(serverMessage(type, view, view.version));
    await wrapper.vm.$nextTick();
  }

  it('T7/T8 重发：横幅出现、阶段文字让位、整手牌重挂载且全部走重发档', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 0, hand: HAND_A }));

    const before = wrapper.find('.table__me .hand .card').element;
    expect(wrapper.find('.table__redeal-banner').exists()).toBe(false);

    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 2, redealCount: 1, hand: HAND_B }),
    );

    const banner = wrapper.find('.table__redeal-banner');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toBe('都不叫，重新发牌');
    expect(wrapper.find('.table__phase').exists(), '横幅显示期间让出「叫抢中」').toBe(false);

    const after = wrapper.find('.table__me .hand .card').element;
    expect(after, '整手牌必须以新 key 重挂载').not.toBe(before);
    const cards = wrapper.findAll('.table__me .hand .card');
    expect(cards).toHaveLength(17);
    for (const card of cards) {
      expect(card.classes()).toContain('anim-redeal-in');
    }
    // 正对照：底牌位在叫抢期也渲染 3 张牌背，它们不得被套上重发档。
    expect(wrapper.findAll('.table__bottom .card')).toHaveLength(3);
    expect(wrapper.find('.table__bottom .card').classes()).not.toContain('anim-redeal-in');
  });

  it('T9 横幅到点消失，「叫抢中」回来', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 0, hand: HAND_A }));
    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 2, redealCount: 1, hand: HAND_B }),
    );
    expect(wrapper.find('.table__redeal-banner').exists()).toBe(true);

    vi.advanceTimersByTime(REDEAL_BANNER_MS);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__redeal-banner').exists()).toBe(false);
    expect(wrapper.find('.table__phase').text()).toBe('叫抢中');
  });

  it('T10 首版视图已带 redealCount=1：不误播横幅/重发档', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 1, hand: HAND_A }));

    expect(wrapper.find('.table__redeal-banner').exists()).toBe(false);
    const cards = wrapper.findAll('.table__me .hand .card');
    expect(cards, '选择器必须命中 17 张手牌（否则下面的循环空转）').toHaveLength(17);
    for (const card of cards) {
      expect(card.classes()).toContain('anim-deal-in');
      expect(card.classes()).not.toContain('anim-redeal-in');
    }
  });

  it('T11a 首版 count=2 → 第 3 次流局（playing）：不弹横幅、手牌照旧普通发牌档', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 2, hand: HAND_A }));
    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 2, redealCount: 3, hand: HAND_A, state: 'playing' }),
    );

    expect(wrapper.find('.table__redeal-banner').exists()).toBe(false);
    const cards = wrapper.findAll('.table__me .hand .card');
    expect(cards, '选择器必须命中 17 张手牌（否则下面的循环空转）').toHaveLength(17);
    for (const card of cards) {
      expect(card.classes()).toContain('anim-deal-in');
      expect(card.classes()).not.toContain('anim-redeal-in');
    }
  });

  it('T11b 已观测重发后第 3 次流局：不弹横幅、手牌不重挂载', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 0, hand: HAND_A }));
    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 2, redealCount: 1, hand: HAND_B }),
    );
    const firstAfterRedeal = wrapper.find('.table__me .hand .card').element;

    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 3, redealCount: 3, hand: HAND_B, state: 'playing' }),
    );

    expect(wrapper.find('.table__redeal-banner').exists()).toBe(false);
    expect(
      wrapper.find('.table__me .hand .card').element,
      '第 3 次流局不再重发 ⇒ 手牌不得重挂载',
    ).toBe(firstAfterRedeal);
  });

  it('T12 真重发震一次；第 3 次流局不震', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 0, hand: HAND_A }));
    expect(stub.calls.vibrateShort).toBe(0);

    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 2, redealCount: 1, hand: HAND_B }),
    );
    expect(stub.calls.vibrateShort).toBe(1);

    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 3, redealCount: 3, hand: HAND_B, state: 'playing' }),
    );
    expect(stub.calls.vibrateShort, '第 3 次流局不是重发，不得再震').toBe(1);
  });

  it('T12b 2 秒内两次重发：两次都要震（震动必须绑 epoch，不能绑 visible）', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 0, hand: HAND_A }));
    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 2, redealCount: 1, hand: HAND_B }),
    );
    expect(stub.calls.vibrateShort).toBe(1);

    vi.advanceTimersByTime(1000); // 横幅仍可见（visible=true）
    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 3, redealCount: 2, hand: HAND_A }),
    );
    expect(
      stub.calls.vibrateShort,
      'visible 一直是 true；绑 visible 会漏掉第二次重发的震动',
    ).toBe(2);
  });

  it('T13 横幅可见时 state 离开 bidding：立即收掉（不等计时器）', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 0, hand: HAND_A }));
    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 2, redealCount: 1, hand: HAND_B }),
    );
    expect(wrapper.find('.table__redeal-banner').exists()).toBe(true);

    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 3, redealCount: 1, hand: HAND_B, state: 'playing' }),
    );
    expect(wrapper.find('.table__redeal-banner').exists()).toBe(false);
    expect(wrapper.find('.table__phase').text()).toBe('出牌中');
  });

  it('T15 横幅消失后不得重放整手动画（enter 不得绑定 visible）', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 0, hand: HAND_A }));
    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 2, redealCount: 1, hand: HAND_B }),
    );
    const first = wrapper.find('.table__me .hand .card').element;

    vi.advanceTimersByTime(REDEAL_BANNER_MS);
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__redeal-banner').exists()).toBe(false);
    expect(wrapper.find('.table__me .hand .card').element, '横幅消失不得重挂载手牌').toBe(first);
    const classes = wrapper.find('.table__me .hand .card').classes();
    expect(classes, '类切回 anim-deal-in 会让 CSS 动画重放').toContain('anim-redeal-in');
    expect(classes).not.toContain('anim-deal-in');
  });

  it('T16 2 秒内第二次重发：横幅元素重建重播，计时器重置', async () => {
    const { wrapper, socket } = mountTable();
    await pushView(socket, wrapper, 'game.deal', viewOf({ version: 1, redealCount: 0, hand: HAND_A }));
    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 2, redealCount: 1, hand: HAND_B }),
    );
    const firstBanner = wrapper.find('.table__redeal-banner').element;

    vi.advanceTimersByTime(1000);
    await pushView(
      socket,
      wrapper,
      'game.state_update',
      viewOf({ version: 3, redealCount: 2, hand: HAND_A }),
    );

    const secondBanner = wrapper.find('.table__redeal-banner');
    expect(secondBanner.exists()).toBe(true);
    expect(secondBanner.element, ':key=redealEpoch 必须重建横幅以重播入场').not.toBe(firstBanner);

    vi.advanceTimersByTime(REDEAL_BANNER_MS - 1);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__redeal-banner').exists(), '计时器必须从第二次重新起算').toBe(true);
    vi.advanceTimersByTime(1);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__redeal-banner').exists()).toBe(false);
  });
});

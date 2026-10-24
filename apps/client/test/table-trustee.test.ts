/**
 * 挂机治理（C27 / C28）：托管按钮的状态面 + 座位「托管中」徽标。
 *
 * 判据（规格 H 组）：
 *  - **C27**：「托管」按钮翻活 —— 点击发 `game.trustee { on }`（经 `table.vue` 的
 *    既有 `send()` 链）；按钮态来自 `view.trustees[自己的座位]`（不是座位 0，也不是本地推断）。
 *  - **C28**：座位徽标按 `trustees[i]` 渲染；**文案是常量字面量「托管中」**；
 *    倒计时零改动；**缺字段不崩** —— `scripts/browser-e2e.mjs` 的 `seedFinishedGame`
 *    注入的 store view **没有** `trustees` 且 `turnDeadlineAt: null`（照 R661 先例，
 *    页面对 `view.trustees` 必须 `?.` + `?? false` 防御读）。
 *
 * ⚠️ 判别力约定：每条「有徽标 / 无徽标」都配一条正对照 —— 先证明座位真的渲染出来了
 * （4 个 Seat 实例 = 3 个逻辑座位，见 `table-seat-geometry.test.ts`），否则「0 个徽标」
 * 可能只是「页面根本没渲染」的假绿。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PlayerView } from '@fight-the-landlord/protocol';
import TablePage from '../src/pages/table/table.vue';
import { useGameStore } from '../src/stores/game';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { FakeSocket, playerViewFixture, serverMessage } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

afterEach(() => {
  // ⚠️ `useCountdown` 在页面挂载时就起了 250ms 的 setInterval；不卸载会留下常驻定时器。
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  stopGameSession();
});

/** 挂一张「等待发牌」的牌桌（视图由用例自行推送 / 注入，形态与 `more-menu.test.ts` 同款）。 */
function mountTable(opts: { mySeat: number } = { mySeat: 0 }) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', opts.mySeat);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, store, socket };
}

/** 出牌期快照（`currentPlayer` 给 1 让对手侧有钟可观测，C28 的「倒计时零改动」对照）。 */
function dealingView(over: Partial<PlayerView> = {}): PlayerView {
  return playerViewFixture({
    state: 'playing',
    version: 1,
    seat: 0,
    currentPlayer: 1,
    ...over,
  });
}

describe('C28 座位「托管中」徽标', () => {
  it('按 trustees[i] 渲染：只有 trustees[1]=true 的座位挂徽标，文案是常量「托管中」', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', dealingView({ trustees: [false, true, false] }), 1),
    );
    await wrapper.vm.$nextTick();

    // 正对照：座位真的渲染出来了（4 个 Seat 实例 = 3 个逻辑座位）
    expect(wrapper.findAll('.seat')).toHaveLength(4);

    const badged = wrapper.findAll('.seat').filter((s) => s.find('.seat__trustee').exists());
    expect(badged, 'trustees=[false,true,false] ⇒ 恰一个座位挂徽标').toHaveLength(1);
    expect(badged[0]!.text(), '徽标挂在座位 1 身上（与 trustees 的下标对应）').toContain('玩家1');
    // 文案是**常量字面量**（规格 §0 钉子：不许就地变体）
    expect(badged[0]!.find('.seat__trustee').text()).toBe('托管中');

    // C28 附带：倒计时零改动 —— 行动者（座位 1）的钟照常渲染，徽标不挤掉它
    expect(wrapper.find('.turn-timer').exists(), '倒计时零改动：托管徽标不影响钟').toBe(true);
  });

  it('自己座位的徽标来自 trustees[mySeat]（挂 me 档的 meta 件，不冒充对手位）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', dealingView({ trustees: [true, false, false] }), 1),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.seat')).toHaveLength(4);
    const badged = wrapper.findAll('.seat').filter((s) => s.find('.seat__trustee').exists());
    expect(badged, '只有我（座位 0）被托管 ⇒ 恰一个徽标').toHaveLength(1);
    // 我的座位挂两个 Seat 实例（avatar / meta 分件）—— 徽标只该出现在 meta 件里
    expect(wrapper.find('.table__me').find('.seat__trustee').text()).toBe('托管中');
    expect(wrapper.findAll('.table__me .seat__trustee')).toHaveLength(1);
  });

  it('缺字段不崩（R661 先例）：探针注入的 store view 没有 trustees ⇒ 4 个座位照常渲染、零徽标、不抛错', async () => {
    const { wrapper, store } = mountTable({ mySeat: 0 });
    let renderError: unknown = null;
    try {
      /**
       * 与 `scripts/browser-e2e.mjs` 的 `seedFinishedGame` 注入**同形**：
       * `state:'ended'` · 三键 `bidPhase` · **没有** `recentActions` / `playPhase` /
       * **`trustees`** · `turnDeadlineAt: null`。
       * 注入方式必须是 `store.$patch`（协议校验层会拒掉缺键的快照 ⇒ 到不了 socket 那条路）。
       */
      store.$patch({
        view: {
          roomCode: 'ZZZZZZ',
          seat: 0,
          version: 1,
          state: 'ended',
          hand: [],
          cardCounts: [0, 0, 0],
          landlordSeat: 0,
          bottomCards: null,
          currentPlayer: 0,
          turnDeadlineAt: null,
          bidPhase: { currentBidder: 0, bidMultiplier: 1, landlordCandidate: 0 },
        } as unknown as PlayerView,
      });
      await wrapper.vm.$nextTick();
    } catch (error) {
      renderError = error;
    }
    expect(renderError, '缺 trustees 的视图不得让渲染抛错（C28 / R661）').toBeNull();
    // 正对照：座位真的渲染了（防御读 `trustees?.[i] ?? false` 走的正是这条路径）
    expect(wrapper.findAll('.seat')).toHaveLength(4);
    expect(wrapper.findAll('.seat__trustee')).toHaveLength(0);
  });
});

describe('C27 托管按钮（页面接线）', () => {
  /**
   * 2026-10-18 用户裁决：托管按钮放**顶栏右侧、更多左边**（不再收在「更多」弹层里）。
   * 下面的 finder 同时钉住位置：它必须在 `.table__bar-right` 里（找不到会返回空 wrapper，
   * `attributes()` 读不到 `aria-pressed` ⇒ 用例当场红）。
   */
  function trusteeButton(wrapper: VueWrapper) {
    return wrapper.find('.table__bar-right .table__trustee');
  }

  it('位置：顶栏右侧且「托管」在「更多」左边（不再属于弹层）；点击发 game.trustee{on:true}；回显来自服务端', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.deal', dealingView(), 1));
    await wrapper.vm.$nextTick();

    // 位置判据：右段按钮顺序恰为「托管 → 更多」（托管在更多左边）
    const rightTexts = wrapper.findAll('.table__bar-right button').map((b) => b.text());
    expect(rightTexts, '托管必须在「更多」左边').toEqual(['托管', '更多']);
    // 且弹层里不再有托管（开弹层后仍找不到）
    await wrapper.find('.table__more').trigger('click');
    expect(
      wrapper.findAll('.table__art-btn').some((b) => b.text() === '托管'),
      '托管不得再收在「更多」弹层里',
    ).toBe(false);

    const btn = trusteeButton(wrapper);
    expect(btn.exists(), '托管按钮必须在顶栏右侧').toBe(true);
    expect(btn.attributes('disabled'), '托管按钮已翻活（不是 disabled 占位）').toBeUndefined();
    expect(btn.attributes('aria-pressed'), '初始：服务端说未托管').toBe('false');

    await btn.trigger('click');
    const sent = socket.emittedOf('game.trustee');
    expect(sent, '点击必须真的发出一条 game.trustee（否则本用例恒真）').toHaveLength(1);
    expect(sent[0]!.env.payload).toEqual({ on: true });

    // 结算 ack（释放 send() 的 busy 闸，否则下一次点击会被当成「操作未确认」）
    sent[0]!.ack(null, { code: 0 });
    await wrapper.vm.$nextTick();

    // 状态回显：服务端快照（不是本地翻转）—— trustees[我的座位]=true
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({ state: 'playing', version: 2, seat: 0, currentPlayer: 1, trustees: [true, false, false] }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(btn.attributes('aria-pressed'), '按钮态来自 view.trustees[自己的座位]').toBe('true');
    expect(btn.classes(), '托管中按钮有可辨的 on 档样式').toContain('table__trustee--on');

    // 再点一次 ⇒ 发出关闭指令
    await btn.trigger('click');
    const again = socket.emittedOf('game.trustee');
    expect(again).toHaveLength(2);
    expect(again[1]!.env.payload).toEqual({ on: false });
  });

  it('按钮读的是**自己**的座位：mySeat=1 时 trustees[0]=true 不得把它点亮', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 1 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({ state: 'playing', version: 1, seat: 1, currentPlayer: 0, trustees: [true, false, false] }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();

    const btn = trusteeButton(wrapper);
    expect(btn.attributes('aria-pressed'), '座位 0 被托管 ≠ 我被托管').toBe('false');

    // 正对照：把 trustees[1] 置 true 后按钮点亮（同上一条回显路径，证明读的确实是我的座位）
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({ state: 'playing', version: 2, seat: 1, currentPlayer: 0, trustees: [true, true, false] }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(btn.attributes('aria-pressed')).toBe('true');
  });
});

describe('托管遮罩（C4′ 恢复入口）', () => {
  function trusteeMask(wrapper: VueWrapper) {
    return wrapper.find('.table__me .table__trustee-mask');
  }

  it('playing + trustees[me]=true ⇒ 遮罩在 .table__me 内，含文案与按钮；不盖动作行', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.deal', dealingView({ trustees: [true, false, false] }), 1));
    await wrapper.vm.$nextTick();

    const mask = trusteeMask(wrapper);
    expect(mask.exists()).toBe(true);
    expect(mask.text()).toContain('托管中');
    expect(mask.text()).toContain('轮到你时将自动出牌');
    expect(mask.find('.table__trustee-cancel').text()).toBe('取消托管');
    expect(wrapper.find('.table__action-bar .table__trustee-mask').exists()).toBe(false);
    // 正对照：牌桌真的渲染了
    expect(wrapper.findAll('.seat')).toHaveLength(4);
  });

  it('bidding + trustees[me]=true ⇒ 遮罩同样显示', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.deal', dealingView({ state: 'bidding', trustees: [true, false, false] }), 1),
    );
    await wrapper.vm.$nextTick();
    expect(trusteeMask(wrapper).exists()).toBe(true);
    expect(wrapper.find('.table__action-bar .table__trustee-mask').exists()).toBe(false);
  });

  it('trustees[me]=false ⇒ 无遮罩（正对照：牌桌已渲染）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.deal', dealingView({ trustees: [false, false, false] }), 1));
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.seat')).toHaveLength(4);
    expect(trusteeMask(wrapper).exists()).toBe(false);
  });

  it('只有别人被托管 ⇒ 无遮罩', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.deal', dealingView({ trustees: [false, true, false] }), 1));
    await wrapper.vm.$nextTick();
    // 正对照：牌桌真的渲染了（否则「无遮罩」可能是页面根本没渲染）
    expect(wrapper.findAll('.seat')).toHaveLength(4);
    expect(trusteeMask(wrapper).exists()).toBe(false);
  });

  it('点击取消 ⇒ 发一条 game.trustee{on:false}；ack 后不本地翻转；服务端回 false 才消失', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.deal', dealingView({ trustees: [true, false, false] }), 1));
    await wrapper.vm.$nextTick();

    await wrapper.find('.table__trustee-cancel').trigger('click');
    const sent = socket.emittedOf('game.trustee');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.env.payload).toEqual({ on: false });

    sent[0]!.ack(null, { code: 0 });
    await wrapper.vm.$nextTick();
    expect(trusteeMask(wrapper).exists(), 'ack 后不得本地翻转').toBe(true);

    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          version: 2,
          seat: 0,
          currentPlayer: 1,
          trustees: [false, false, false],
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(trusteeMask(wrapper).exists()).toBe(false);
  });

  it('第一下未 ack 时按钮 disabled；绕过 disabled 原生派发也不重复发送（busy 闸）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.deal', dealingView({ trustees: [true, false, false] }), 1));
    await wrapper.vm.$nextTick();

    const btn = wrapper.find('.table__trustee-cancel');
    await btn.trigger('click');
    expect(btn.attributes('disabled')).toBeDefined();
    // `disabled` 只是展示闸；原生派发绕过浏览器的激活抑制、直达 handler，验证 send() 的 busy 闸
    btn.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(socket.emittedOf('game.trustee')).toHaveLength(1);
  });

  it('state=ended + trustees[me]=true ⇒ 遮罩不显示', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.deal', dealingView({ state: 'ended', trustees: [true, false, false] }), 1));
    await wrapper.vm.$nextTick();
    // 正对照：终局牌桌仍渲染（否则「无遮罩」可能只是视图没到达）
    expect(wrapper.findAll('.seat')).toHaveLength(4);
    expect(trusteeMask(wrapper).exists()).toBe(false);
  });

  it('playing 视图缺 trustees 字段 ⇒ 无遮罩、不抛错、牌桌已渲染', async () => {
    const { wrapper, store } = mountTable({ mySeat: 0 });
    const { trustees: _omit, ...withoutTrustees } = dealingView();
    let renderError: unknown = null;
    try {
      store.$patch({ view: withoutTrustees as unknown as PlayerView });
      await wrapper.vm.$nextTick();
    } catch (error) {
      renderError = error;
    }
    expect(renderError, '缺 trustees 不得让渲染抛错').toBeNull();
    expect(wrapper.findAll('.seat')).toHaveLength(4);
    expect(trusteeMask(wrapper).exists()).toBe(false);
  });
});

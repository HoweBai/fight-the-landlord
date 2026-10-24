/**
 * ➏ 叫抢面板与底牌位（spec §5-➏ + R657/R661 + R647）。
 *
 * 判据：
 *  ① 保锚：`.table__bid-grab` / `.table__bid-pass` 仍是 `<button>`；叫抢面板**只在轮到我时渲染**
 *     （2026-10-13 真机走查：非我轮次按钮整个消失，不是 disabled —— 与出牌相位同款纪律），
 *     `disabled` 只随 `busy` 变化；
 *  ② 阶段互斥不变（叫抢期无 `.table__play`/`.table__pass`，出牌期无抢/不抢）；
 *  ③ 底牌翻开时机：`bottomCards === null` ⇒ `.table__bottom--hidden` 内**零** `data-value`
 *     （牌背不得泄漏牌面）；非 null ⇒ 3 张牌面；
 *  ④ 当前倍数是服务端数字的**原样**展示（改名/改值都能被观测），且缺 `bidPhase` 时不崩。
 *
 * 判别力说明（这里**不**断言任何规则，规则全在服务端）：
 *  - **R657（改形态 · 协议③）**：判断「现在该叫还是该抢」只能从 `grabActions`/`landlordCandidate`
 *    推断 = 前端规则判定（§1.1 明令禁止）⇒ 措辞**只能**从服务端的 `bidPhase.kind` 派生。
 *    本文件用**两反一正**钉住它：同一 `kind` 下计数怎么变文案都不动（**反例**），
 *    `kind` 一变文案就变（**正例** —— 只有反例的话，把它写成恒定常量也能过）。
 *    ⚠️ 旧形态断言的是「两组相反形态下文案**恒定**（逐字「抢」/「不抢」）」——
 *    协议③ 之后那个「恒定」是**错的**（叫与抢本来就该有两套措辞），故成对迁移。
 *  - **R647**：两个按钮必须仍是 `<button>`（真浏览器探针走 `el.click()`），且 `.table__me .card`
 *    只数得到我的**手牌**（底牌那 3 张不许混进去）——两个锚点各一条断言。
 *  - **R661**：`bidPhase` 可能缺失、也可能只有四个键（探针 `seedFinishedGame` 注入的形态）
 *    ⇒ 取倍数一律 `store.ddzBidPhase?.bidMultiplier ?? null`，缺值由 HUD / 顶栏徽章渲染「—」
 *    （不得抛错）。2026-10-11 第五轮起 BidPanel 不再展示倍数，本文件不再断言它。
 *
 * ⚠️ 夹具约束（与 `table-bid-ui.test.ts` 一致）：
 *  1. `playerViewFixture(over)` 只做**顶层**覆盖，`bidPhase` **整体替换、不合并**
 *     ⇒ 需要完整 `bidPhase` 时用 `helpers/bid-phase.ts` 的 `bidPhase()`
 *     （10 份逐字副本的**唯一定义**，B3 评审 Minor 1 合流）；
 *  2. `validateInbound` 强制 `hand.length === cardCounts[seat]`（夹具会按 `hand.length` 重算）；
 *  3. 快照类消息的**载荷 version 必须等于信封 version**，否则协议层先抛。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PlayerView } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import BidPanel from '../src/components/BidPanel.vue';
import BottomCards from '../src/components/BottomCards.vue';
import { bidPhase } from './helpers/bid-phase';
import { FakeSocket, playerViewFixture, serverMessage, makeCards } from './helpers/fake-socket';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

afterEach(() => {
  // ⚠️ `useCountdown` 在页面挂载时就起了 250ms 的 setInterval；不卸载会让本文件留下若干常驻定时器。
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  stopGameSession();
});

function mountTable(opts: { mySeat: number }) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', opts.mySeat);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}

/** 底牌位的「牌面」：`.table__bottom` 里所有牌实例的 `data-value`（牌背没有这个属性）。 */
function bottomFaces(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.table__bottom .card')
    .map((card) => card.attributes('data-value'))
    .filter((value): value is string => value !== undefined);
}

describe('➏ 叫抢面板与底牌位（§5-➏ / R657 / R647 / R661）', () => {
  it('`.table__bid-grab` / `.table__bid-pass` 仍是 button，文案由 `kind` 派生（R647 + R657 改形态）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          currentPlayer: 0,
          // 轮到我（`bidPhase.currentBidder` 才决定行动者，§9.1）
          bidPhase: bidPhase({ currentBidder: 0, grabActions: 3, landlordCandidate: 1 }),
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();

    const grab = wrapper.find('.table__bid-grab');
    const pass = wrapper.find('.table__bid-pass');
    expect(grab.exists(), '抢 按钮必须有稳定 class .table__bid-grab（R107/R647）').toBe(true);
    expect(pass.exists(), '不抢 按钮必须有稳定 class .table__bid-pass（R107/R647）').toBe(true);
    // R647：必须是原生 `<button>`（真浏览器探针走 `el.click()`），不是 view/text 伪装的按钮。
    expect(grab.element.tagName, 'R647：抢 必须仍是 <button>').toBe('BUTTON');
    expect(pass.element.tagName, 'R647：不抢 必须仍是 <button>').toBe('BUTTON');
    /**
     * R657（改形态）：文案**由 `kind` 派生** —— 这里断言的是本夹具那一套（`rob`）。
     * ⚠️ 先钉住夹具的前提（`grabActions=3` + `landlordCandidate=1` ⇒ helper 推出 `kind='rob'`）：
     * 推导规则若漂了，这一行当场红，而不是让下面两条断言**静默**对上错的措辞。
     * 「`call` ⇒ 叫地主/不叫」的那一半在 `table-bid-stage.test.ts`（页面级）与下一条用例（正例）。
     */
    expect(store.ddzBidPhase?.kind, '夹具前提：抢形态 ⇒ kind=rob').toBe('rob');
    expect(grab.text()).toBe('抢地主');
    expect(pass.text()).toBe('不抢');
    expect(grab.attributes('disabled')).toBeUndefined();
    expect(pass.attributes('disabled')).toBeUndefined();
  });

  /**
   * 🔴 **R657 改形态（规格 §4 的硬要求）**：文案**只能从 `kind` 派生**。
   *
   *  · **反例（三版）**：同一 `kind` 下 `grabActions` / `bidMultiplier` 怎么变，文案**一个字不动**
   *    —— 其中 ②′ 是**服务端可达**的组合（两次「不叫」），掐掉「反例② 靠不可达组合才成立」
   *    这一可能的话柄；
   *  · **正例（新增）**：与反例①**只差 `kind`**（`currentBidder`/倍数/计数逐字相同）⇒
   *    文案**必须**跟着变。
   *
   * ⚠️ **只有反例是不够的**：那样「把文案写成恒定常量」（旧形态的实现！）照样全绿 ——
   * 协议③ 之后「恒定」本身是错的（叫与抢本来就该有两套措辞）⇒ 正例是这条判据的判别力所在。
   * ⚠️ **但「正例」的夹具本身也必须选对**（B3 评审 Important 1 实测教训）：反例①② 的
   * `(kind, landlordCandidate)` 都是**自洽**的（helper 按 candidate 推导）⇒ 光靠它们，
   * 把措辞实现成「按 `landlordCandidate` 反推」（= 服务端 `bidKindOf` 的原样复刻 ——
   * 正是本节要禁的那件事）**仍然全绿**。⇒ 正例刻意让 `candidate` 与 `kind` **不一致**
   *（`landlordCandidate: -1` 而 `kind: 'rob'`），那种实现会在正例上当场红（变异 M10 自证）。
   */
  it('R657：文案只能从 kind 派生（计数怎么变都不动 + kind 一变文案就变）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    const texts = () => [wrapper.find('.table__bid-grab').text(), wrapper.find('.table__bid-pass').text()];

    // 反例 ①：`kind=call` + 首叫形态（`grabActions=0`、倍数 1、无人声称）
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          currentPlayer: 0,
          bidPhase: bidPhase({ currentBidder: 0, kind: 'call', bidMultiplier: 1, grabActions: 0, landlordCandidate: -1 }),
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(store.ddzBidPhase?.grabActions).toBe(0);
    const callLow = texts();
    expect(callLow, 'kind=call ⇒ 叫地主/不叫').toEqual(['叫地主', '不叫']);

    // 反例 ②：**同一个 `kind=call`**，计数全动了（`grabActions` 0→2、倍数 1→4）
    // ⚠️ 这一版**刻意让计数与 `kind` 不一致**（无人声称时倍数本不会涨到 4；helper 的推导规则
    //    也拦不住**显式**传进来的 `kind`）—— 它隔离的正是「按计数反推措辞」的实现：那种实现
    //    在这里必须红。判据要测的是**客户端只认 `kind`**，不是「夹具能不能被服务端产生」。
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          version: 2,
          currentPlayer: 0,
          bidPhase: bidPhase({ currentBidder: 0, kind: 'call', bidMultiplier: 4, grabActions: 2, landlordCandidate: -1 }),
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(store.ddzBidPhase?.grabActions).toBe(2);
    expect(texts(), 'R657 反例：同一 kind 下计数怎么变，文案逐字不动').toEqual(callLow);

    // 正例：与反例①**只差 `kind`**（`currentBidder`/倍数/计数逐字相同，call → rob）⇒ 文案必须跟着变。
    // ⚠️ 这一版**刻意让 `candidate` 与 `kind` 不一致**（`landlordCandidate=-1` 时服务端
    //    `bidKindOf` 会说 'call'）—— 判据测的是客户端**只认 `kind`**，不是「夹具能不能被服务端
    //    产生」。它隔离的正是「按 `landlordCandidate` 反推措辞」（服务端 `bidKindOf` 的原样复刻，
    //    R657 改形态要禁的那件事）：反例①②′ 的 `(kind, candidate)` 都自洽、拦不住它，这里必须红
    //    （B3 评审 Important 1；变异 M10 自证）。
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          version: 3,
          currentPlayer: 0,
          bidPhase: bidPhase({ currentBidder: 0, kind: 'rob', bidMultiplier: 1, grabActions: 0, landlordCandidate: -1 }),
        }),
        3,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(store.ddzBidPhase?.kind).toBe('rob');
    expect(texts(), 'R657 正例：kind 一变，文案必须跟着变').toEqual(['抢地主', '不抢']);

    /**
     * 反例 ②′（**可达**对照）：同一 `kind=call` 的这一版**服务端产生得了** ——
     * 两次「不叫」：`grabActions=2`、倍数不涨仍为 1、无人声称 ⇒ `bidKindOf` 说 `'call'`。
     * 反例② 的组合（无人声称 + 倍数 4）服务端不可达 ⇒ 这一版掐掉「反例② 靠不可达组合成立」
     * 这一可能的话柄：同 kind 下计数变化，文案仍然一个字不动。
     *
     * ⚠️ **B3 评审 Minor 1（本 Task B4 顺手订正）：这一版此前不是真实快照** —— 它写 `currentBidder: 0`，
     * 而服务端每完成一次决策都会推进 `currentBidder = (playerIdx + 1) % 3`（`bid.ts` 的
     * 「唯一的 currentBidder 推进点」），并且 `decisions` 与 `grabActions` 同生同长。
     * ⇒ 「服务端产生得了」这句话当时**不成立**（两次不叫之后必然是 `currentBidder = 2`
     * 且 `decisions` 有两条）。现在按服务端的真实产物补齐：
     * `currentBidder: 2` · `decisions: [seat0 不叫, seat1 不叫]`（`kind` 按决策那一刻算，
     * 两次都是 `'call'` —— 当时还没有人声称）。
     *
     * ⚠️ **2026-10-13 走查修复后拆成第二个 mount**：叫抢面板只在**轮到我**时渲染
     * （非我轮次按钮整个消失）⇒ 这个「两次不叫之后轮到座位 2」的可达快照，必须从
     * **座位 2 的视角**（`mySeat: 2`、`seat: 2`）喂给页面才看得到按钮文案 ——
     * 这也是它更贴真的形态：现实中「轮到我」就是每个座位各自收到的快照。
     * ⚠️ 换 mount 前必须 `stopGameSession()`：会话是单例，直接再 `startGameSession`
     * 不会把新 socket 接线（实测报「no handler registered for push type」），
     * 且 stop 会 reset store ⇒ 新 mount 里 version 从 1 重新计。
     */
    stopGameSession();
    const asSeat2 = mountTable({ mySeat: 2 });
    asSeat2.socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'bidding',
          seat: 2,
          version: 1,
          currentPlayer: 2,
          bidPhase: bidPhase({
            currentBidder: 2,
            kind: 'call',
            bidMultiplier: 1,
            grabActions: 2,
            landlordCandidate: -1,
            decisions: [
              { seat: 0, kind: 'call', grab: false },
              { seat: 1, kind: 'call', grab: false },
            ],
          }),
        }),
        1,
      ),
    );
    await asSeat2.wrapper.vm.$nextTick();
    expect(asSeat2.store.isMyTurn, '夹具前提：两次不叫后轮到座位 2（我在座位 2）').toBe(true);
    expect(asSeat2.store.ddzBidPhase?.grabActions, '夹具前提：计数确实动了（与本用例的反例②同形）').toBe(2);
    expect(
      [asSeat2.wrapper.find('.table__bid-grab').text(), asSeat2.wrapper.find('.table__bid-pass').text()],
      'R657 反例②′（可达组合）：同 kind 下计数变化，文案逐字不动',
    ).toEqual(callLow);
  });

  it('底牌 null ⇒ `.table__bottom--hidden` 内 3 张牌背且零 data-value（正反对照）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          currentPlayer: 0,
          bottomCards: null,
          bidPhase: bidPhase({ currentBidder: 0 }),
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();

    const hidden = wrapper.find('.table__bottom--hidden');
    expect(hidden.exists(), '叫抢期（bottomCards === null）必须有 .table__bottom--hidden').toBe(true);
    // 3 张牌背：复用 ➌ 的牌背实现（`.card--back`），不得另写一份牌背样式。
    expect(hidden.findAll('.card--back')).toHaveLength(3);
    // 牌背不得泄漏牌面：**整块一个 data-value 都没有**。
    expect(hidden.attributes('data-value')).toBeUndefined();
    expect(hidden.findAll('[data-value]'), '牌背不得渲染 data-value').toHaveLength(0);
    // 判别力正对照：同一条 `[data-value]` 选择器在**牌面**上确实命中（下面那条用例的
    // `.table__bottom .card[data-value]` 就是它）⇒「零 data-value」不是选择器写坏了。
    expect(wrapper.findAll('.table__me .card[data-value]').length).toBeGreaterThan(0);
    // 牌背不得渲染任何**牌面文字**：这块 DOM 里除那句提示之外没有任何文本。
    expect(hidden.findAll('.card').map((card) => card.text())).toEqual(['', '', '']);
    expect(wrapper.find('.table__bottom .table__muted').text()).toBe('底牌');

    // 正对照：同一夹具把我的座位线喂好 ⇒ `.table__me .card` 只数得到**我的 17 张手牌**
    //（底牌那 3 张没有混进手牌锚点），且它们**确实**带 data-value ⇒ 上面「零 data-value」不是空扫描。
    const mine = wrapper.findAll('.table__me .card');
    expect(mine, '手牌锚点只数我的手牌').toHaveLength(17);
    expect(mine.filter((card) => card.attributes('data-value') !== undefined).length).toBe(17);
  });

  it('底牌非 null ⇒ 3 张牌面（`.card[data-value]` 逐张对上服务端数组）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 2,
          landlordSeat: 0,
          currentPlayer: 0,
          bottomCards: makeCards(17, 20, 30),
          bidPhase: bidPhase({ currentBidder: 0, bidMultiplier: 4, landlordCandidate: 0, grabActions: 3 }),
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    const bottom = wrapper.find('.table__bottom');
    expect(bottom.exists(), '底牌位必须有稳定 class .table__bottom').toBe(true);
    expect(bottom.findAll('.card'), '翻开后是 3 张牌面').toHaveLength(3);
    expect(bottomFaces(wrapper)).toEqual(['17', '20', '30']);
    expect(bottom.findAll('.card--back'), '翻开后不再有牌背').toHaveLength(0);
    expect(bottom.find('.table__muted').exists(), '翻开后不再显示「底牌」标签').toBe(false);
  });

  it('缺字段的视图不抛错（R661：探针 `seedFinishedGame` 注入的三键 bidPhase）', async () => {
    // 探针注入的 view：`bidPhase` 只有三个键（没有 `redealCount`）、没有 `playPhase`
    //（`turnDeadlineAt` 在探针里是 null，但这里给一个合法值，只保留「对象缺键」这个真正
    //  到得了页面的形态）。
    //
    // ⚠️ 注入方式**必须**是 `store.$patch`（＝探针 `seedFinishedGame` 的真实机制，见
    // `scripts/browser-e2e.mjs`）：协议⑥⑦ 之后 `validateInbound` 强制
    // `baseScore` / `bidPhase.kind` / `bidPhase.decisions` 三个新键 ⇒ 缺这些键的视图
    // **走不通** socket 那条路，只能经 store 注入到达页面（这正是探针的形态）。
    // 本用例钉的性质不变：「探针形态到页面后不崩」。
    //
    // ⚠️ **协议 ④ 起这份残缺视图刻意不补 `recentActions`**（与探针的假视图同步）——
    // 页面必须用 `?.` + 缺值兜底（`store.recentActions` 缺字段 ⇒ `[]`，R661）。
    const { wrapper, store } = mountTable({ mySeat: 0 });
    let renderError: unknown = null;
    try {
      store.$patch({
        view: {
          roomCode: 'ZZZZZZ',
          seat: 0,
          version: 1,
          state: 'bidding',
          hand: [],
          cardCounts: [0, 17, 17],
          landlordSeat: null,
          bottomCards: null,
          currentPlayer: 0,
          turnDeadlineAt: Date.now() + 30_000,
          bidPhase: { currentBidder: 0, bidMultiplier: 1, grabActions: 0 },
        } as unknown as PlayerView,
      });
      await wrapper.vm.$nextTick();
    } catch (error) {
      renderError = error;
    }
    expect(renderError, '缺字段的视图不得让渲染抛错（R661）').toBeNull();

    expect(wrapper.find('.table__bid-grab').exists()).toBe(true);
    expect(wrapper.find('.table__bid-pass').exists()).toBe(true);
    // 同一条视图里的底牌位：`bottomCards` 为 null ⇒ 仍是 3 张牌背那支（R661 不改变翻开时机）。
    expect(wrapper.find('.table__bottom--hidden').exists()).toBe(true);
  });

  it('两个组件自己也不崩：BidPanel 只渲染两颗按钮；BottomCards 收 null ⇒ 3 张牌背（R661 的最小面）', async () => {
    // ⚠️ 2026-10-11 第五轮走查：BidPanel 的「当前倍数 N」展示位已应用户裁决删除
    //（倍数仍由 HUD / 顶栏徽章展示），本用例只钉两颗按钮的契约。
    const panel = mount(BidPanel, { props: { disabled: false, kind: 'call' } });
    const bottom = mount(BottomCards, { props: { cards: null } });
    mounted.push(panel, bottom);
    await panel.vm.$nextTick();

    // ⚠️ `kind` 是**必填 prop**（协议③ 的契约）：传 `'call'` ⇒ 叫地主/不叫那一套。
    expect(panel.find('.table__bid-grab').text()).toBe('叫地主');
    expect(panel.find('.table__bid-pass').text()).toBe('不叫');
    expect(panel.find('.table__bid-grab').attributes('disabled')).toBeUndefined();
    expect(bottom.findAll('.card--back')).toHaveLength(3);
    expect(bottom.findAll('[data-value]')).toHaveLength(0);

    // `disabled` 只是 props：改传 true ⇒ 两个按钮都禁用（行为的唯一依据仍在页面手里）。
    const disabledPanel = mount(BidPanel, { props: { disabled: true, kind: 'rob' } });
    mounted.push(disabledPanel);
    expect(disabledPanel.find('.table__bid-grab').attributes('disabled')).toBeDefined();
    expect(disabledPanel.find('.table__bid-pass').attributes('disabled')).toBeDefined();
    // 同一组件、另一档 `kind` ⇒ 另一套措辞（**prop 名即契约**，见 `Interfaces`）。
    expect(disabledPanel.find('.table__bid-grab').text()).toBe('抢地主');
    expect(disabledPanel.find('.table__bid-pass').text()).toBe('不抢');

    // 反面：`cards` 非 null 时**不再**是牌背那支（R661 的「—」与「牌背」都只服务于缺值/未翻开）。
    const shown = mount(BottomCards, { props: { cards: makeCards(3, 17, 30) } });
    mounted.push(shown);
    expect(shown.findAll('.card--back')).toHaveLength(0);
    expect(shown.findAll('.card[data-value]').map((card) => card.attributes('data-value'))).toEqual([
      '3',
      '17',
      '30',
    ]);
  });

  it('阶段互斥：叫抢期无出牌/过牌，出牌期无抢/不抢（R647 的既有判据面）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          currentPlayer: 1,
          bidPhase: bidPhase({ currentBidder: 0 }),
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__bid-grab').exists()).toBe(true);
    expect(wrapper.find('.table__bid-pass').exists()).toBe(true);
    expect(wrapper.find('.table__play').exists()).toBe(false);
    expect(wrapper.find('.table__pass').exists()).toBe(false);

    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 2,
          landlordSeat: 1,
          currentPlayer: 0,
          bottomCards: makeCards(3, 4, 5),
          bidPhase: bidPhase({ currentBidder: 0, landlordCandidate: 1, grabActions: 3 }),
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__bid-grab').exists()).toBe(false);
    expect(wrapper.find('.table__bid-pass').exists()).toBe(false);
    expect(wrapper.find('.table__play').exists()).toBe(true);
    expect(wrapper.find('.table__pass').exists()).toBe(true);
  });
});

/**
 * 组件内按钮的样式自持（评审 F1/F3 的机械闸）。
 *
 * ## 为什么必须有这条闸
 *
 * Vue SFC 的 `scoped` 样式**只**作用于「本组件自己的模板 + 子组件的**根节点**」：
 * 编译后的选择器是 `.btn[data-v-<本组件 scope>]`，而**子组件模板内部**的元素只带子组件自己的
 * scope id ⇒ **父组件的 `.btn` 规则进不去**。
 *
 * 实测事故（本 Task 评审 F1）：两个叫抢按钮从 `table.vue` 抽进 `BidPanel.vue` 之后，
 * `.btn { @include ftl-btn }` / `.btn--primary` / `.table__actions .btn` 仍只写在 `table.vue` 的
 * scoped 块里 ⇒ 三端产物里按钮只带 `data-v-<BidPanel>`，`.btn[data-v-<table>]` 一条都不命中：
 * 「抢」丢主色，两个按钮丢 min-height / padding / border / border-radius / font-size /
 * `:disabled` opacity / `flex: 1 1 0`（mp-weixin 实证：`BidPanel.wxss` 里只有面板与按钮几条规则）。
 *
 * ⚠️ **jsdom 抓不到它**：`@vue/test-utils` 的 `mount()` 会注入**完整**的 SFC 样式（不做 scope 过滤）
 * ⇒ 任何「断言 computedStyle / class 存在」的用例都会在坏产物上照样绿。所以这条闸只能是
 * **机械源码扫描**：组件模板里渲染 `class="btn"` 的，**它自己的 `<style>` 块里必须自己
 * `@include ftl-btn`**。
 *
 * ## 合法替代（为什么**不**放宽到「父级 `:deep(.btn)`」）
 *
 * 本仓 `src/components/**` 下**没有**任何 `:deep(.btn)`（实测 grep 零命中），而唯一的
 * 「父级穿透」先例（`table.vue` 的 `.table__me :deep(.card)`）穿的是**另一个组件的根节点**，
 * 与 `.btn` 无关。给这条闸加一条「某个父级含 `:deep(.btn)`」的逃生口，会让它下次**更难**
 * 抓同一类事故（只要有人往别处抄一份 `:deep(.btn)` 就能把红骗成绿），而扫源码本身就无法在
 * 「节点级」上证明那条 `:deep` 规则真的命中这个按钮 ⇒ **宁严勿松（R435）**。
 */
describe('组件内按钮的样式必须自持（F3：父组件 scoped 规则进不来 · §5.2.1：主按钮不带贴图）', () => {
  /**
   * ⚠️ 闭合标签用 `</${tag}\s*>`：`table__label` 是**另一个** class，不能被 `</text>` 误判；
   * 本仓模板里按钮/文本标签都独占一行（缩进 4 空格起）⇒ 起止匹配是确定性的。
   */
  const BTN_TAG = /<([a-z][a-z0-9-]*)\b[^<>]*\bclass="[^"]*\bbtn\b[^"]*"[^<>]*>(?:(?!<\/\1\s*>)[\s\S])*<\/\1\s*>/;

  /** 组件自己 `@include ftl-btn`（剥模板注释，R572：解释里的字符串不算实现）。 */
  function stylesOwnBtn(componentSource: string): boolean {
    return styleBlocks(componentSource).some((block) => /@include\s+ftl-btn\b/.test(block));
  }

  /** 组件自己的 `<style>` 块（剥模板注释；`<style>` 无匹配时为 `[]`）。 */
  function styleBlocks(componentSource: string): string[] {
    return stripComments(componentSource).match(/<style\b[^>]*>[\s\S]*?<\/style>/g) ?? [];
  }

  /**
   * F1 的另一半：「抢」的**主色**。主按钮是 `class="btn--primary"` ⇒ 该 class 必须在**同一个**
   * style 块里有自己的 `background` 规则，否则按钮会退回 `.btn` 的白底（主操作没有视觉主次）。
   * 判据只看「有没有 background 声明」，不管它长什么样（令牌取值仍是 `ui-tokens` 的活）。
   */
  function stylesOwnPrimaryBackground(componentSource: string): boolean {
    return styleBlocks(componentSource).some((block) =>
      /\.btn--primary\b[^{]*\{[^}]*\bbackground\s*:/.test(block),
    );
  }

  it('渲染 `class="btn"` 的组件必须自己 `@include ftl-btn`（正反对照 + 合成样本）', () => {
    const files = collectSourceFiles().filter((f) => f.path.startsWith('src/components/') && f.path.endsWith('.vue'));
    expect(files.length, '扫描面必须真的有组件（否则本条恒绿）').toBeGreaterThan(0);

    const rendering = files.filter((f) => BTN_TAG.test(f.content));
    expect(
      rendering.length,
      '本仓 `src/components/**` 里至少要有一个真正渲染 class="btn" 的组件（➏ 的 BidPanel）',
    ).toBeGreaterThan(0);

    const violations = rendering
      .filter((f) => !stylesOwnBtn(f.content))
      .map((f) => `${f.path}：模板渲染了 class="btn"，但它自己的 <style> 块里没有 @include ftl-btn`);

    // 这条用例**当初**就会红（F1 的真实形态）：BidPanel 渲染 class="btn" 却不自带 mixin。
    expect(violations, '子组件里的 .btn 必须自持样式（父组件 scoped 规则进不来）').toEqual([]);
    // 具体到本体：BidPanel 必须自己 include（不是「清单里恰好有个别人」）。
    const bidPanel = files.find((f) => f.path === 'src/components/BidPanel.vue');
    expect(bidPanel, 'BidPanel.vue 必须被扫描到').toBeDefined();
    expect(stylesOwnBtn(bidPanel!.content), 'BidPanel 必须自己 @include ftl-btn').toBe(true);

    // ── F1 的另一半：主按钮的主色也必须自持（合成样本的正对照在下面） ──
    const missingPrimary = rendering
      .filter((f) => /class="[^"]*\bbtn--primary\b[^"]*"/.test(BTN_TAG.exec(f.content)?.[0] ?? ''))
      .filter((f) => !stylesOwnPrimaryBackground(f.content))
      .map((f) => `${f.path}：渲染了 class="btn--primary"，但自己的 <style> 里没有 .btn--primary 的 background`);
    expect(missingPrimary, '主按钮的主色必须自持（否则退回 .btn 的白底）').toEqual([]);
    expect(
      stylesOwnPrimaryBackground(bidPanel!.content),
      'BidPanel 必须自己给 .btn--primary 一个 background',
    ).toBe(true);

    // ── 正对照：合成样本「渲染 .btn 但不 include」必须被同一条判据报出 ──
    const syntheticMissing = [
      '<template>',
      '  <button type="button" class="btn btn--primary table__x">好</button>',
      '</template>',
      '<style scoped lang="scss">',
      '.table__x { color: red; }',
      '</style>',
    ].join('\n');
    expect(BTN_TAG.test(syntheticMissing), '合成样本必须命中「渲染 class=btn」').toBe(true);
    expect(stylesOwnBtn(syntheticMissing), '合成样本确实没有 mixin').toBe(false);

    // ── 反面对照：同一模板 + 自带 mixin ⇒ 不报 ──
    const syntheticOk = syntheticMissing.replace(
      '.table__x { color: red; }',
      '.btn { @include ftl-btn; }\n.table__x { color: red; }',
    );
    expect(stylesOwnBtn(syntheticOk), '自带 mixin 的样本必须放行').toBe(true);

    // ── 反面对照 ②：`table__label` 之类的 class 不能被误判成 `btn`（词边界） ──
    const syntheticLookalike = '<template>\n  <text class="table__btn-label">x</text>\n</template>';
    expect(BTN_TAG.test(syntheticLookalike), 'class 名里含 btn 子串但没有独立的 btn class ⇒ 不命中').toBe(false);

    // ── 反面对照 ③：**注释里**出现 `@include ftl-btn` 不算实现（R572：判据读剥注释视图） ──
    const syntheticCommentOnly = syntheticMissing.replace(
      '.table__x { color: red; }',
      '/* 这里本该 @include ftl-btn */\n.table__x { color: red; }',
    );
    expect(stylesOwnBtn(syntheticCommentOnly), '注释里的 mixin 不算实现').toBe(false);

    // ── 正对照 ②：主按钮自持 mixin、却**没有** `.btn--primary` 的 background ⇒ 必须报出 ──
    const syntheticNoPrimaryBg = syntheticOk.replace(
      '.table__x { color: red; }',
      '.table__x { color: red; }\n.btn--primary { color: #fff; }',
    );
    expect(stylesOwnBtn(syntheticNoPrimaryBg), '它仍然自持 mixin（所以只该被主色那条抓）').toBe(true);
    expect(
      stylesOwnPrimaryBackground(syntheticNoPrimaryBg),
      '只有 color、没有 background ⇒ 主色判据必须报出',
    ).toBe(false);
    // ── 反面对照 ④：补上 background 后放行 ──
    const syntheticPrimaryBg = syntheticOk.replace(
      '.table__x { color: red; }',
      '.table__x { color: red; }\n.btn--primary { background: $ftl-btn-primary-bg; color: $ftl-color-on-primary; }',
    );
    expect(stylesOwnPrimaryBackground(syntheticPrimaryBg), '有 background 的样本必须放行').toBe(true);
  });

  /**
   * 🔴 **§5.2.1 的另一半：主按钮不得带贴图**（片③ 阶段 B 新增）。
   *
   * 上位规格逐字：「主按钮 = `background: $ftl-color-gold` + 描边 `$ftl-color-gold-deep` + 白字；
   * **不带贴图** —— 原处的 `background-image: url($ftl-btn-plate-primary)` / `background-size`
   * **必须一并删掉**（留着会盖住金色）」。
   *
   * ⚠️ **为什么必须有这条**：上面那条「主按钮必须自持主色」只钉**有没有 `background:` 声明**
   * —— 留着贴图的实现**照样满足它**（`background:` 在、贴图盖在金色上面；而「盖住了」是
   * **观感**，jsdom 看不见、探针也不管）。本片之前牌桌的三个主按钮**正是**那个形态
   * （旧 Material 蓝 + `btn1.png` 贴图）⇒ 没有这条闸，「贴图两行已删」**没有任何判据**
   * （`game.vue` 的注释记着同一句：那条既有闸射程只到 `src/components/**`，页面不在内）。
   *
   * 射程 = **全部 `.vue`**（组件 + 页面）：三个目标里有一个在**页面** `table.vue` 上，
   * 照既有闸的 `src/components/**` 面会**漏掉它**（下面有「三个目标都在射程内」的自证）。
   * ⚠️ 选择器要**剥掉 `:not(...)`** 再判：`.game__friends .btn:not(.btn--primary)` 是
   * **排除**主按钮的规则（它里面确实有 `background-image: none`）—— 不剥会误报
   * `game.vue`（本仓 `:not(` 全仓只有两处，都是这一族：`game.vue` / `login.vue`）。
   */
  it('主按钮不得带贴图（§5.2.1：`background-image` / `background-size` 必须一并删掉）', () => {
    /**
     * 「给 `.btn--primary` 上样式」的**正向**规则块里，**本闸看不进去**的东西（去重前的原文）：
     * · `background-(image|size):` —— 字面贴图声明；
     * · `@include <mixin>` —— **B5 遗留 Minor 3 的加固**：字面扫描看不见 mixin 体内，
     *   一个含 `background-image` 的 mixin 被 `@include` 进来就等于把贴图加回来了
     *   （本闸放行过那种实现）。⇒ 看不进就**报出**，让实现者成对改闸 ——
     *   与「`.btn--primary` 必须是字面 `background:` 简写」同族：这条闸要求字面实现。
     * · 选择器剥掉 `:not(...)`：那是**排除**主按钮，不是给它上样式；
     * · 规则块 = 一层大括号（本仓的 `.btn--primary` 没有嵌套规则）；
     * · `\bbackground-(image|size)\s*:` 不误吃 `background:` 简写（要求连字符）。
     */
    function primaryPlateDeclarations(componentSource: string): string[] {
      return styleBlocks(componentSource)
        .flatMap((block) => [...block.matchAll(/([^{}]*)\{([^{}]*)\}/g)])
        .filter((m) => /\.btn--primary\b/.test(m[1]!.replace(/:not\([^)]*\)/g, '')))
        .flatMap((m) => [
          ...[...m[2]!.matchAll(/\bbackground-(?:image|size)\s*:/g)].map((hit) => hit[0]!),
          ...[...m[2]!.matchAll(/@include\s+[\w-]+/g)].map((hit) => hit[0]!),
        ]);
    }

    const files = collectSourceFiles().filter((f) => f.path.endsWith('.vue'));
    // 判据读**剥注释**视图（R572：解释里的字符串不算实现；本文件里就有大段逐字引用）。
    const rendering = files.filter((f) =>
      /class="[^"]*\bbtn--primary\b[^"]*"/.test(stripComments(f.content)),
    );

    // 射程自证：本片改的三个目标**必须**在集合里 —— 否则这条闸可能是「空集合恒绿」。
    const paths = rendering.map((f) => f.path);
    for (const must of [
      'src/components/BidPanel.vue',
      'src/components/Settlement.vue',
      'src/components/table/ddz/DdzBoard.vue',
    ]) {
      expect(paths, `${must} 渲染 class="btn--primary" ⇒ 必须落在本闸射程内`).toContain(must);
    }

    const offenders = rendering
      .map((f) => ({ path: f.path, decls: primaryPlateDeclarations(f.content) }))
      .filter((x) => x.decls.length > 0)
      .map(
        (x) =>
          `${x.path}：.btn--primary 规则里有本闸看不进去的贴图来源（字面贴图声明 / @include 的 mixin）${x.decls.join('、')}`,
      );
    expect(offenders, '§5.2.1：主按钮**不带贴图**（贴图会盖住金色）').toEqual([]);

    // ── 正对照：**留着贴图两行**的实现必须被报出（这正是本片之前牌桌三个按钮的形态） ──
    const syntheticPlate = [
      '<template>',
      '  <button type="button" class="btn btn--primary table__x">好</button>',
      '</template>',
      '<style scoped lang="scss">',
      '.btn { @include ftl-btn; }',
      '.btn--primary {',
      '  background: $ftl-btn-primary-bg;',
      '  background-image: url($ftl-btn-plate-primary);',
      '  background-size: 100% 100%;',
      '}',
      '</style>',
    ].join('\n');
    expect(primaryPlateDeclarations(syntheticPlate), '贴图两行必须被报出（判别力所在）').toEqual([
      'background-image:',
      'background-size:',
    ]);

    // ── 反面对照 ①：金色简写、无贴图 ⇒ 放行（本片落地后的形态） ──
    const syntheticGold = syntheticPlate.replace(
      '  background: $ftl-btn-primary-bg;\n  background-image: url($ftl-btn-plate-primary);\n  background-size: 100% 100%;',
      '  background: $ftl-color-gold;',
    );
    expect(primaryPlateDeclarations(syntheticGold), '金色简写（无贴图）必须放行').toEqual([]);

    // ── 反面对照 ②：`:not(.btn--primary)` 里的 `background-image: none` **不是**主按钮的贴图 ──
    const syntheticNot = syntheticGold.replace(
      '.btn { @include ftl-btn; }',
      '.btn { @include ftl-btn; }\n.game__friends .btn:not(.btn--primary) { background: transparent; background-image: none; }',
    );
    expect(
      primaryPlateDeclarations(syntheticNot),
      '`:not(.btn--primary)` 是排除规则 ⇒ 不得误报（game.vue 的真实形态）',
    ).toEqual([]);

    // ── 正对照 ③（B5 遗留 Minor 3 的加固）：`@include` 一个（可能）含贴图的 mixin ──
    //    字面扫描看不见 mixin 体内 ⇒ 若放行，把贴图加回来就有了静默通道。本闸看不进就报出。
    const syntheticInclude = syntheticGold.replace(
      '.btn { @include ftl-btn; }',
      '.btn { @include ftl-btn; }\n.btn--primary { @include ftl-btn; }',
    );
    expect(
      primaryPlateDeclarations(syntheticInclude),
      '`@include` 未展开 ⇒ 必须报出（含 `.btn` 上那个合法的 include 不得混进来）',
    ).toEqual(['@include ftl-btn']);
  });
});

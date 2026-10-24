/**
 * ➐ HUD（spec §5-➐ + R654 + §9.1 红线）。
 *
 * ⚠️ 这一块最容易越线（「倍数展示 vs 倍数计算」）。判据写死三件事：
 *  ① **只展示服务端字段**：倍数随 `bidPhase.bidMultiplier` 变化、炸弹数随 `playPhase.bombCount` 变化；
 *  ② **前端零换算**：HUD 源码不得出现任何把炸弹数变成倍数、或对倍数做运算的写法（R659 的闸 + 本条正对照）；
 *  ③ **缺字段不崩**（R661：探针 `seedFinishedGame` 注入的 view 没有 `playPhase`）。
 *
 * ⚠️ **R654 的实测前提（协议⑥ 起已按实况订正）**：`PlayerView`（`packages/protocol/src/views.ts`）
 * **有** `baseScore` 了（协议⑥ 扩的就是它）—— 但它的显示位是**中央**（`table.vue` 的
 * `.table__scene-base`，片规格 §3.2 已落地），**不在 HUD**。HUD 仍**只**渲染
 * `PlayerView` 里 HUD 位置上该有的三个数字：`倍数` / `炸弹`（**个数**，不是倍数）/ `房间`。
 * ⚠️ 旧注释的前提（「`PlayerView` **没有** `baseScore`……想显示底分必须先扩协议」）**已成假话** ——
 *    「不得凭空多出底分」这条性质如今的守卫是**两道**：`table-center.test.ts` 的正负对照
 *    （服务端给 ⇒ 精确文本 `底分 15`；不给 ⇒ 整页零「底分」）+ R659 的底分**字面量**闸
 *    （`helpers/scoring-traces.ts` 的旧形态，本 HUD 也在扫描面里）。
 *    「我的分」仍不在 `PlayerView` 里（它只在 `SettlementResult`）。
 *
 * ⚠️ 夹具约束（照抄 `table-bid-ui.test.ts` 收敛后的形态）：
 *  - `playerViewFixture` 只做**顶层**替换，`bidPhase` 是**整体替换、不合并** ⇒ 每条用例给完整 `bidPhase`；
 *  - `validateInbound` 强制 `hand.length === cardCounts[seat]`，牌值只有 3–14 / 17 / 20 / 30。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Component } from 'vue';
import type { PlayerView, SettlementResult } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import TableHud from '../src/components/TableHud.vue';
import BidPanel from '../src/components/BidPanel.vue';
import BottomCards from '../src/components/BottomCards.vue';
import Card from '../src/components/Card.vue';
import Hand from '../src/components/Hand.vue';
import MoreMenu from '../src/components/MoreMenu.vue';
import PlayArea from '../src/components/PlayArea.vue';
import Seat from '../src/components/Seat.vue';
import Settlement from '../src/components/Settlement.vue';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import LoginPage from '../src/pages/login/login.vue';
import GamePage from '../src/pages/game/game.vue';
import HistoryPage from '../src/pages/history/history.vue';
import WalletPage from '../src/pages/wallet/wallet.vue';
import RechargePage from '../src/pages/wallet/recharge.vue';
import WithdrawPage from '../src/pages/wallet/withdraw.vue';
import { FakeSocket, playerViewFixture, serverMessage, makeCards } from './helpers/fake-socket';
import { bidPhase } from './helpers/bid-phase';
import { collectSourceFiles, stripComments } from './helpers/source-scan';
import { LOCAL_SCORING_TRACES_LEGACY, localScoringTraces } from './helpers/scoring-traces';

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

/**
 * 🔵 **B1 评审裁决：消掉分叉。** 本文件原先自带一份 `LOCAL_SCORING_TRACES`
 * （旧形态 5 条的**第二份副本**，只扫 `TableHud.vue` —— 因为那条扫描面当时零命中，
 * 分叉不可观测）⇒ 同一道闸悄悄有了两种形态。现改为从 `helpers/scoring-traces.ts`
 * 引**唯一定义**；`TableHud.vue` 属于**除 `table.vue` 外的**牌桌区组件（协议⑥ 只豁免
 * `table.vue`）⇒ 用**旧形态**（新形态 ∪ 两条裸禁令，是超集不是回退）。
 *
 * 本条是**源码级**断言：渲染文本不含这些字样没有判别力（只要没人写就恒绿），
 * 机械扫描才能拦住「当前分支走不到、但代码里确实在前端换算」的写法。
 */

describe('➐ HUD：只展示服务端数字，前端零换算', () => {
  it('倍数随视图更新（服务端说几就是几）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          version: 1,
          bidPhase: bidPhase({ bidMultiplier: 1 }),
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.hud__item--multiplier').text()).toBe('倍数 1');

    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'bidding',
          seat: 0,
          version: 2,
          bidPhase: bidPhase({ bidMultiplier: 4 }),
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.hud__item--multiplier').text()).toBe('倍数 4');
  });

  it('炸弹数是**个数**、原样展示（不做 2^n 换算）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({ state: 'playing', seat: 0, version: 1, playPhase: { bombCount: 2 } }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.hud__item--bomb').text()).toBe('炸弹 2');
    // 2^2 = 4 是**前端换算**的形态：倍数项仍是服务端给的 1，全 HUD 不得出现 4
    expect(wrapper.find('.table__hud').text()).not.toContain('4');
    // R654（B1 评审按实况订正注释；**断言本身保留** —— 它仍绿且仍正确）：协议⑥ 之后
    // `PlayerView` **有** `baseScore` 了，但它的显示位是**中央**（`table.vue` 的
    // `.table__scene-base`）⇒ HUD 仍不得凭空多出「底分」这一项（HUD 三项 = 倍数/炸弹/房间，没变）。
    // 「牌桌必须显示服务端底分」那半由 `table-center.test.ts` 的正负对照守；
    // 「不得凭空多出底分」这半由本条 + R659 的底分**字面量**闸（旧形态，HUD 在扫描面里）共同守。
    expect(wrapper.find('.table__hud').text()).not.toContain('底分');
    // 三个数字各有稳定锚点（房间码是**弱化**的次级信息，但读数仍必须来自 store）
    expect(wrapper.find('.hud__item--room').text()).toContain(store.roomCode!);
  });

  it('缺 playPhase/bidPhase 的视图渲染「—」且不抛错（R661：探针受控注入形态）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage('game.state_update', playerViewFixture({ state: 'ended', seat: 0, version: 3 }), 3),
    );
    await wrapper.vm.$nextTick();

    // 抹掉两个阶段字段 —— 与探针 `seedFinishedGame` 注入的形状等价（它只给 bidPhase 的三个键、没有 playPhase）
    const view = store.view!;
    store.$patch({
      view: { ...view, playPhase: undefined, bidPhase: undefined } as unknown as PlayerView,
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__hud').exists(), '缺字段也必须渲染出 HUD（不得整块消失）').toBe(true);
    expect(wrapper.find('.table__hud').text()).toContain('—');
    // 逐个数字锚点都必须是「—」，而不是空字符串 / undefined 文案
    expect(wrapper.find('.hud__item--multiplier').text()).toBe('倍数 —');
    expect(wrapper.find('.hud__item--bomb').text()).toBe('炸弹 —');
  });

  it('源码级：HUD 无 ×N / 底分 / baseScore / 幂运算 / 倍数相乘（+ 正对照）', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/components/TableHud.vue');
    expect(file, 'TableHud.vue 必须在源码扫描集合里').toBeDefined();
    // R572/R622：违规类断言读剥注释视图（解释一个禁词的注释不该把闸打红）
    expect(
      localScoringTraces(stripComments(file!.content), LOCAL_SCORING_TRACES_LEGACY),
      'TableHud.vue 出现本地算分/凭空造数痕迹',
    ).toEqual([]);
    /**
     * 正对照：合成样本必须被同一组正则报出。
     *
     * ⚠️ 样本里 `multiplier` **紧跟一个运算符**（`multiplier * bombCount`）——
     * 计划原文的样本写成 `… * multiplier }} ×2 底分 baseScore`，那里 `multiplier` 后面是 `}}`，
     * 「对倍数做本地运算」那条**匹配不到**，实测只报 4 条 ⇒ 照抄会得到一条**假红**。
     */
    const synthetic = '{{ Math.pow(2, bombCount) }} ×2 底分 baseScore {{ multiplier * bombCount }}';
    /**
     * ⚠️ 这里钉**字面 5**（而不是 `LOCAL_SCORING_TRACES_LEGACY.length`（= 9））——
     * 自我引用会让「删掉一条正则」时本条仍然绿（判据跟着实现一起萎缩）。
     *
     * ⚠️ **核过（B1 修复轮合流时实测）**：换用合流后的旧形态（9 条）本样本仍恰好报出 **5** 条 ——
     * `×N` · `对倍数做本地运算` · `本地按 2 的幂算倍数` · 裸『底分』 · 裸 `baseScore`；
     * 另外 4 条（底分数值字面量 / 本地声明 / 两条对底分运算）在本样本里**不命中**
     * （样本里 `底分` 后面是 `baseScore` 而不是数字、也没有声明与运算符）。
     */
    expect(
      localScoringTraces(synthetic, LOCAL_SCORING_TRACES_LEGACY),
      '5 条痕迹必须全被同一组正则报出',
    ).toHaveLength(5);
    // 反向对照：干净的样本一条都不报（证明上面那 5 条不是「什么字符串都命中」）
    expect(
      localScoringTraces('<text>{{ multiplier ?? 0 }}</text>', LOCAL_SCORING_TRACES_LEGACY),
    ).toEqual([]);
  });

  /**
   * **F1（评审 Important）：单根闸。**
   *
   * 模板里 `<!-- … -->` 若放在**根元素之前**，SFC 就真的成了**多根**组件
   * （实测 render = `_createElementBlock(_Fragment, null, [_createCommentVNode(…), …])`）。
   * 后果不是「渲染不出来」，而是 `@vue/test-utils` 的 `wrapper.classes()` / `attributes()`
   * **静默**返回 `[]` / `{}`（`$el` 落在 fragment 锚点上），父组件再给它挂 `class`
   * 还会走 Vue 的 fragment-attrs 警告路径 —— 今天 jsdom 里不红，只是因为**没有测试直接 mount 它**，
   * 而 mp-weixin 编译会把模板注释压平、端上也看不出来（➍ 清理轮在 `progress.md:93` 踩过同一个坑）。
   *
   * ⚠️ `classes()` 失真的两个来源：**多根**（本条的靶子）与 **scoped**
   *（后者在单测里不成立：`mount()` 注入的是**完整** SFC 样式、不做 scope 过滤，
   *  见 `table-bid-bottom.test.ts` 关于「jsdom 抓不到组件自持样式」的说明）。
   */
  it('TableHud 是**单根**组件：直接 mount 后根节点 class 就是 .table__hud', () => {
    const hud = mount(TableHud, { props: { multiplier: 3, bombCount: 1, roomCode: 'R1' } });
    mounted.push(hud);

    // 多根 ⇒ `classes()` 返回 `[]`（fragment 的 `$el` 是注释锚点）⇒ 这条当场红。
    expect(hud.classes(), '模板注释若放在根元素之前，组件会变多根 ⇒ classes() 为 []').toContain(
      'table__hud',
    );
    // 顺带把「根就是那个 view 元素」钉住（多根时 `$el` 是 text/comment 锚点，不是元素节点）。
    expect(hud.element.tagName.toLowerCase()).toBe('view');
    // 内容也仍然对（单根闸不是「换了个空壳」）
    expect(hud.find('.hud__item--room').text()).toBe('房间 R1');
  });

  /**
   * **F1 的推广**：牌桌区**能独立 mount 的**组件，`$el` 必须就是组件自己的根元素。
   *
   * 做法与理由和上面那条完全一样（`classes()` 在多根时静默返回 `[]`），
   * 只是换成 `it.each` 把「注释写歪成多根」这一类回归**一次盖住整片牌桌区**。
   *
   * 覆盖面（9 个组件）：TableHud（上面单独一条，判据更细）· Card · Hand · PlayArea ·
   * BidPanel · BottomCards · Seat · Settlement（➑ / R681：它此前正是**多根**形态，
   * 本 Task 修好并纳入本闸 —— 见下面 `Settlement` 那条夹具注释）· MoreMenu（B4 / D16：
   * 二级弹层 —— 它的两段注释都在根元素**之内**，正是本闸要钉的形态）。
   * ⚠️ **没做 `table.vue`**：它是**页面**不是组件，独立 mount 需要 pinia + 真会话
   * （`mountTable` 那套脚手架）⇒ 它由紧随其后的第 2 条（`.table` 单根）覆盖。
   *
   * ⚠️ `props` 显式标成 `Record<string, unknown>`：`it.each` 直接吃对象字面量数组时，
   * TS 会把不同形状的 props **并成一个联合类型**塞给 `mount()` 的第二个参数
   * （`Type 'undefined' is not assignable to type 'number'`）—— 那不是运行时问题，
   * 但会让 `vue-tsc` 红。
   */
  /**
   * ➑ 的结算载荷夹具（**非乘积**：`100 · 4 = 400` 而载荷给 `777`、分数仍守恒）。
   * 只用于「把组件挂起来」这一件事 —— 本闸不断言任何数字。
   */
  const SETTLEMENT_FIXTURE: SettlementResult = {
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

  const SINGLE_ROOT_CASES: Array<{
    name: string;
    comp: Component;
    /** ⚠️ 可省（B5：`MoreMenu` 的 `open` prop 退役后它是唯一不需要 props 的一格）。 */
    props?: Record<string, unknown>;
    root: string;
  }> = [
    { name: 'Card', comp: Card, props: { value: 5 }, root: 'card' },
    // ⚠️ `cards` 必须是**真的 `Card[]`**（`{r, s}`）：旧写法传的是裸数字 `[3, 4]`，
    // `Hand` 把 `card.r` 交给 `Card` ⇒ `value` 收 `undefined` ⇒ 每次挂载都打两条
    // `[Vue warn]: Invalid prop: type check failed for prop "value"` 警告。
    // 本闸只断言根节点 class（传什么形状都不影响它），但**测试输出必须干净**（本仓要求 pristine）
    // —— 与 `multiplier: null`（B3 评审 Minor 2）同一类订正，零行为变化。
    { name: 'Hand', comp: Hand, props: { cards: makeCards(3, 4) }, root: 'hand' },
    {
      name: 'PlayArea',
      comp: PlayArea,
      props: { cards: null },
      root: 'table__play-area',
    },
    /**
     * ⚠️ `kind` 是协议③ 起 BidPanel 的**必填 prop**，这里必须带上（B3 评审 Important 3）：
     * 缺它时运行时 `kind === undefined` ⇒ `GRAB_LABEL[undefined]` 渲染**空文案**
     * + Vue 的 missing-required-prop 警告，而**没有闸会红** —— 本 `it.each` 的 props
     * 显式标成 `Record<string, unknown>`（见上面注释），`vue-tsc` 也抓不到。
     * ⚠️ `multiplier` 同样是**必填 prop**（B3 评审 Minor 2）：不传会打
     * `Missing required prop: "multiplier"` 警告 —— 虽然它有 `null` 缺省、渲染与传值**逐字相同**
     * （都渲染「—」），但**测试输出必须干净**（本仓要求 pristine）。
     */
    {
      name: 'BidPanel',
      comp: BidPanel,
      props: { disabled: false, multiplier: null, kind: 'call' },
      root: 'table__bid-panel',
    },
    { name: 'BottomCards', comp: BottomCards, props: { cards: null }, root: 'table__bottom-slot' },
    {
      name: 'Seat',
      comp: Seat,
      props: { seat: 0, name: '玩家1', cardCount: 17, isLandlord: false, isActive: false },
      root: 'seat',
    },
    /**
     * ➑ / R681：`Settlement.vue` 的模板注释此前写在**根元素之前** ⇒ 组件是多根
     * （编译成 `_Fragment`），`classes()` 因此静默返回 `[]`、父组件挂 class 也走 fragment 路径。
     * 本 Task 把注释挪进根元素内部，并把它纳入本闸钉住。
     */
    {
      name: 'Settlement',
      comp: Settlement,
      props: { settlement: SETTLEMENT_FIXTURE },
      root: 'table__settlement',
    },
    /**
     * B4（D16）：二级弹层。它**真的会踩**这个坑 —— 两个模板注释（文件头那段「为什么要单根」
     * 与「本注释必须在根元素内部」）都写在根元素**之内**是刻意的；变异 M6 把它挪到根元素
     * **之前**，本闸当场红（`classes()` 静默返回 `[]`）。
     * ⚠️ **本格不传 props**（B5 / B4 遗留 Minor 1）：`open` prop 已退役 —— 组件是
     * **无条件渲染**的（开合是宿主 `v-if` 的事），裸 mount 挂到的就是三端产物里的真实形态。
     * 若哪天有人在组件**内部**加一层 `v-if="open"` 之类的闸，这里会挂出空壳 ⇒ 本闸照样红
     * —— 那正是当初「`open: true` 不能省」那句要防的形态，现在**退役 prop 就是防线本身**。
     */
    { name: 'MoreMenu', comp: MoreMenu, root: 'table__more-mask' },
  ];

  it.each(SINGLE_ROOT_CASES)(
    '$name 是单根组件：$root 就在根节点上（多根时 classes() 会是 []）',
    ({ comp, props, root }) => {
      const wrapper = mount(comp, { props });
      mounted.push(wrapper);
      expect(wrapper.classes()).toContain(root);
    },
  );

  /**
   * 页面也不能多根（片① 迁移后**更强**）。
   *
   * 原判据：`wrapper.classes()` 必须含页面自己的根 class（`.table`）。
   * 它防的是「模板注释写在根元素之前 ⇒ fragment root ⇒ `classes()` 静默返回 `[]`」。
   *
   * ⚠️ **片① 的迁移**（spec R710）：四页现在都套了 `<LandscapeStage>` ⇒ **组件根变成 `.stage`**，
   * 页面自己的根 class 下沉一层。原断言因此**必然为假** —— 但它防的东西**没有消失**
   * （多根仍会让 `classes()` 为 `[]`）。
   * ⇒ 改成两条：根是 `.stage`**且** `.table` 仍在。比原来强（多钉了一条「页面根没被弄丢」）。
   *
   * 本条走**页面级 mount**（带 game session 的 `mountTable`），与下面那条 bare mount 的
   * `it.each` 覆盖面不同：这里考的是真实页面挂载路径。
   */
  it('table.vue 经页面级 mount 也是单根：根节点是 .stage，`.table` 在其内', () => {
    const { wrapper } = mountTable({ mySeat: 0 });
    expect(wrapper.classes(), '组件根 = LandscapeStage 的 .stage').toContain('stage');
    expect(wrapper.find('.table').exists(), '页面自己的根 class 必须还在').toBe(true);
  });

  /**
   * **F2（评审 / R685）：另外三个页面也纳入单根闸。**
   *
   * `lobby.vue` / `login.vue` 的模板注释此前写在**根元素之前** ⇒ 两者都是 **fragment root**
   * （`@vue/compiler-sfc`：root children = `[comment, element]`），症状与上面的组件闸完全一样：
   * `wrapper.classes()` 静默返回 `[]`、父级挂 `class` 走 fragment 警告路径，而 mp-weixin
   * 编译会把模板注释压平、端上也看不出来。⇒ 注释移进根元素内部，并由本条钉死。
   *
   * ⚠️ 片① 起各页都套了 `<LandscapeStage>` ⇒ 断言迁移为「根是 `.stage` 且页面自己的根 class 仍在」。
   *
   * 页面 mount 需要 pinia（`useAuthStore()` 在 `<script setup>` 顶层调用），
   * 故用 `global.plugins`（与 `lobby-modes.test.ts` / `login-screen.test.ts` 同法）。
   */
  const SINGLE_ROOT_PAGES: Array<{ name: string; comp: Component; ownRoot: string }> = [
    { name: 'lobby.vue', comp: LobbyPage, ownRoot: 'lobby' },
    { name: 'login.vue', comp: LoginPage, ownRoot: 'login' },
    { name: 'game.vue', comp: GamePage, ownRoot: 'game' },
    // 记录片 T8：第 5 页（历史战绩子页）纳入单根闸；裸挂载即可（REST 被拒会被页面收口成错误行）。
    { name: 'history.vue', comp: HistoryPage, ownRoot: 'history' },
    // 支付片 T14：第 6 页（钱包子页）同族纳入（REST 被拒同款收口成错误行；无「未配 fetch」逃逸）。
    { name: 'wallet.vue', comp: WalletPage, ownRoot: 'wallet' },
    // 钱包拆分（2026-10-23）：第 7 页（充值子页）纳入单根闸。
    { name: 'recharge.vue', comp: RechargePage, ownRoot: 'wallet-recharge' },
    // 第 8 页（提现子页）。
    { name: 'withdraw.vue', comp: WithdrawPage, ownRoot: 'wallet-withdraw' },
    // ⚠️ `table.vue` **不在这里** —— 它裸挂载会抛「会话尚未建立：请先调用 startGameSession()」
    //    （`table.vue` 在 setup 里就要 game session）。它由上面那条走 `mountTable` 的用例覆盖。
  ];

  it.each(SINGLE_ROOT_PAGES)(
    '$name 是单根页面：根是 .stage 且 .$ownRoot 仍在（多根时 classes() 会是 []）',
    ({ comp, ownRoot }) => {
      const wrapper = mount(comp, { global: { plugins: [pinia] } });
      mounted.push(wrapper);
      expect(wrapper.classes(), '组件根 = LandscapeStage 的 .stage').toContain('stage');
      expect(
        wrapper.find(`.${ownRoot}`).exists(),
        '页面自己的根 class 必须还在（套画布不得把页面根弄丢）',
      ).toBe(true);
    },
  );
});

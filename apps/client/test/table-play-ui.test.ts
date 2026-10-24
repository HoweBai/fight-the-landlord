/**
 * 切片 9：出牌/过牌 UI 的**接线**（§12 F01/F06/F10 + R165）。
 *
 * 判别力说明：这里**不**断言任何规则（什么牌能出、能不能过、牌型是什么），
 * 那些是服务端的。只断言六件事：
 *  ① 不是我的回合 ⇒ 两个按钮 `disabled`（断言属性本身，R115：jsdom 里点 disabled 是静默 no-op）；
 *  ② 选牌后可点，点击发 `game.play`，载荷是选中的 **DouZero 值**、`baseVersion` = 已应用版本；
 *  ③ 点击发 `game.pass`，载荷为 `{}`；
 *  ④ 倒计时以服务端 `turnDeadlineAt` 为基准，到 0 **不**动任何按钮、**不**发任何请求（F06）；
 *  ⑤ **F01 判别力**：首出（窗口里没有出牌项）时过牌按钮**不得**被禁用 ——
 *     「首出不能过牌」是规则，由服务端判 `13001`；前端若自行禁用，这条立刻红。
 *  ⑥ 「提示」按钮（2026-10-13 死按钮修）：有候选 ⇒ 可点、点击只选牌**不**发请求；
 *     **能出、但提示器枚举不到候选**（如只能靠更大的三带一压）⇒ `disabled`
 *     —— 此前是点了静默无反应。⚠️ 与 ⑦ 的分工：确凿「要不起」时按钮被 ⑦ 整个隐藏，
 *     谈不到禁用；本档只在「能出」的前提下可见。
 *  ⑦ 「要不起」保守隐藏：跟牌且穷尽判定手里**没有任何一手**能压过目标 ⇒ 出牌/提示
 *     两个按钮整个不在 DOM（钟与过牌恒在）；首出恒四件全在。
 *
 * ⚠️ 夹具约束（读 `helpers/fake-socket.ts` + `protocol/validate.ts` 后收敛的）：
 *  1. `playerViewFixture` 只做**顶层**覆盖，`bidPhase` 这类嵌套对象**整体替换、不合并**；
 *  2. `validateInbound` 逐张校验牌值（只允许 3–14 / 17 / 20 / 30）且强制
 *     `hand.length === cardCounts[seat]`；
 *  3. `game.play`/`game.pass` 是 CAS 消息：ack 0 之后串行队列要等 `game.state_update`
 *     把 version 推过 `baseVersion` 才释放（§6.5/R112）⇒ 「一次 mount 里连点两次」发不出第二个请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ErrCode, type PlayerView } from '@fight-the-landlord/protocol';
import { getGameSession, startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import { useAuthStore } from '../src/stores/auth';
import TablePage from '../src/pages/table/table.vue';
import { bidPhase } from './helpers/bid-phase';
import { FakeSocket, playerViewFixture, serverMessage, makeCards } from './helpers/fake-socket';
import { installUniStub, type UniStub } from './helpers/uni-stub';

let pinia: ReturnType<typeof createPinia>;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  stopGameSession();
});

/** 出牌阶段的合法手牌：17 张、全部是合法 DouZero 值。 */
const PLAYING_HAND = makeCards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30, 3, 4);

/**
 * 手牌的**展示顺序**：2026-10-10 起手牌恒降序（先点数、再花色），与 `Hand.vue` 的
 * 比较器同口径 ⇒ DOM 第 k 张牌就是 `displayOrder(hand)[k]`（实例本身仍是 store.hand 的牌）。
 */
function displayOrder<T extends { r: number; s: number }>(hand: readonly T[]): T[] {
  return [...hand].sort((a, b) => b.r - a.r || b.s - a.s);
}

/** `playerViewFixture` 的 `...over` 是**顶层覆盖**，`bidPhase` 必须整份给出（R171 / 切片 8 教训 3）。 */
function playingView(over: Partial<PlayerView> = {}): PlayerView {
  return playerViewFixture({
    state: 'playing',
    version: 2,
    landlordSeat: 0,
    bottomCards: makeCards(3, 4, 5),
    hand: PLAYING_HAND,
    // 协议 ④：座位 0 刚出了一张王（旧 `lastPlayedHand` + `lastPlayerIdx: 0` 的等价窗口）
    recentActions: [{ seat: 0, cards: makeCards(20) }],
    bidPhase: bidPhase(),
    ...over,
  });
}

function mountTable(opts: { mySeat: number }) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', opts.mySeat);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}

describe('table.vue 的出牌/过牌 UI（R165）', () => {
  it('不是我的回合时动作行不渲染出牌/过牌按钮（2026-10-11 第三轮：按钮消失，不是 disabled）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 1 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 1, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    expect(store.isMyTurn).toBe(false);
    expect(wrapper.find('.table__play').exists(), '非我回合出牌按钮必须整个不存在').toBe(false);
    expect(wrapper.find('.table__pass').exists(), '非我回合过牌按钮必须整个不存在').toBe(false);
  });

  it('轮到我且已选牌时可点，点击发 game.play（DouZero 值 + baseVersion = 已应用版本）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    // 未选牌 ⇒ 出牌禁用（否则会发出空牌，服务端只能回 13006）
    expect(wrapper.find('.table__play').attributes('disabled')).toBeDefined();

    /**
     * ⚠️ 选择器必须**限定在我方选牌区** `.table__me`：牌桌中间还渲染了两手**不可交互**的牌
     * （上一手 `.table__play-area` + 底牌 `.table__bottom`），`.card` 会先命中它们。
     *
     * ⚠️ 这里原先写的是 `.table__middle` —— 那个 class **在 `src/` 里根本不存在**
     * （今天是 `.table__play-area`）。注释与代码不一致属于静默过期，已订正。
     */
    const myCards = wrapper.findAll('.table__me .card');
    expect(myCards).toHaveLength(PLAYING_HAND.length);
    // 手牌恒降序 ⇒ 第一张是整手最大的牌（小王 30）；payload 必须就是这个实例，不是位置 0 的 3。
    const firstShown = displayOrder(PLAYING_HAND)[0]!;
    await myCards[0]!.trigger('click'); // 展示序第 1 张
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__play').attributes('disabled')).toBeUndefined();

    await wrapper.find('.table__play').trigger('click');

    const sent = socket.emittedOf('game.play');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.env.payload).toEqual({ cards: [firstShown] });
    expect(sent[0]!.env.baseVersion).toBe(2);
  });

  /**
   * R173 / N18：选中态必须按**牌实例下标**记录（`selected` 的语义 = `store.hand` 的下标）。
   *
   * 旧实现把选中态存成**牌值**（`toggleCard` 用 `indexOf(value)` / `splice`），后果有两面：
   *  - 同一个点数**最多只能选一张** ⇒ 点第二张同点数的牌会把第一张**取消**掉
   *    ⇒ 对子 / 三张 / 炸弹 / 四带二 / 连对……**从 UI 永远送不出去**（这局打不完）；
   *  - `Hand.vue` 用 `selected.includes(value)` 标记 ⇒ 点一张同点数的牌会**整组高亮**（UI 在说谎）。
   *
   * 判别力就在 `PLAYING_HAND` 的两个 `3`：旧实现下第一次点击的 `card--selected` 是 **2 个**
   * 而不是 1 个，第二次点击的载荷是 `[3]`（甚至是空）而不是 `[3,3]`。
   */
  it('同点数的两张牌各选各的：选中态按实例下标记录，payload 能送出 [3,3]（R173/N18）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    const countSelected = () => wrapper.findAll('.table__me .card--selected').length;
    const threes = wrapper.findAll('.table__me .card[data-value="3"]');
    expect(threes, 'PLAYING_HAND 必须含两个同点数的 3（本用例的判别力来源）').toHaveLength(2);

    // 降序下两张 3 的展示序为「花色大的在前」（s:1 → s:0）；点哪张就送哪个实例。
    // 点**第一张** 3：恰好只有它被选中（旧实现下两张 3 会一起高亮 ⇒ 这里是 2）
    await threes[0]!.trigger('click');
    await wrapper.vm.$nextTick();
    expect(countSelected(), '点一张 3 只能选中一张（按牌值存的旧实现会整组高亮）').toBe(1);
    expect(wrapper.find('.table__play').attributes('disabled')).toBeUndefined();

    await wrapper.find('.table__play').trigger('click');
    expect(socket.emittedOf('game.play')).toHaveLength(1);
    expect(socket.emittedOf('game.play')[0]!.env.payload).toEqual({ cards: [{ r: 3, s: 1 }] });
  });

  it('同点数连点两张 ⇒ 载荷 [3,3]（对子能送出去，R173/N18）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    const countSelected = () => wrapper.findAll('.table__me .card--selected').length;
    const threes = wrapper.findAll('.table__me .card[data-value="3"]');
    expect(threes).toHaveLength(2);

    await threes[0]!.trigger('click');
    await wrapper.vm.$nextTick();
    await threes[1]!.trigger('click');
    await wrapper.vm.$nextTick();

    expect(countSelected(), '两张 3 都选中后应恰好 2 个高亮').toBe(2);

    await wrapper.find('.table__play').trigger('click');
    const sent = socket.emittedOf('game.play');
    expect(sent).toHaveLength(1);
    // 点第二张把第一张取消掉（旧实现）⇒ 载荷是 [3]；这里必须是 [3,3]。
    // 载荷按点击顺序（降序下先点到的是 s:1 实例，再是 s:0）。
    expect(sent[0]!.env.payload).toEqual({
      cards: [
        { r: 3, s: 1 },
        { r: 3, s: 0 },
      ],
    });
  });

  /**
   * R173 第 3 条：下标会**过期** —— 我方手牌内容一变（重新同步/重连取回的快照、reorder），
   * 旧下标指向的可能是另一张牌。因此手牌内容变化时必须**清空**选中态。
   *
   * 反向判别力：用例先证明「点一张牌确实会置位选中态」，再证明换手牌后它被清空
   *（否则这条断言可能只是「选中态从来没生效过」）。
   */
  it('手牌内容变化 ⇒ 清空选中态（下标新鲜度，R173）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    const countSelected = () => wrapper.findAll('.table__me .card--selected').length;

    // ① 正对照：点一张牌 ⇒ 选中态真的生效（旧下标此刻是有意义的）
    const mine = wrapper.findAll('.table__me .card');
    expect(mine).toHaveLength(PLAYING_HAND.length);
    // 手牌恒降序 ⇒ 不再依赖「展示位 12」，直接按点数定位 A（DouZero 17）那张实例。
    await wrapper.find('.table__me .card[data-value="17"]').trigger('click');
    await wrapper.vm.$nextTick();
    expect(countSelected(), '点一张牌必须置位选中态（正对照，否则本条用例是空测）').toBe(1);

    // ② 手牌内容变化（同长度、不同排列 ⇒ 原选中实例的下标可能指向另一张牌）
    const reordered = [...PLAYING_HAND].reverse();
    expect(reordered).toHaveLength(PLAYING_HAND.length);
    socket.push(
      serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, version: 3, hand: reordered }), 3),
    );
    await wrapper.vm.$nextTick();

    expect(countSelected(), '手牌内容变化后必须清空选中态（否则会发出用户没选的那张牌）').toBe(0);
    // 清空后出牌按钮回到「未选牌」态，点它不会发出任何请求
    expect(wrapper.find('.table__play').attributes('disabled')).toBeDefined();
    await wrapper.find('.table__play').trigger('click');
    expect(socket.emittedOf('game.play')).toHaveLength(0);
  });

  it('点击过牌发 game.pass，载荷为空对象', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, landlordSeat: 1 }), 2));
    await wrapper.vm.$nextTick();

    await wrapper.find('.table__pass').trigger('click');

    const sent = socket.emittedOf('game.pass');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.env.payload).toEqual({});
    expect(sent[0]!.env.baseVersion).toBe(2);
  });

  /**
   * F01 / R165⑤：首出（窗口里没有出牌项）时过牌**是服务端要拒绝的动作**，
   * 前端**不得**替服务端判断合法性（若「好心」禁用，这条立刻红）。
   */
  it('首出时过牌按钮不禁用，点击照发 game.pass（合法性归服务端，F01）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({ seat: 0, currentPlayer: 0, recentActions: [], landlordSeat: 1 }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    const pass = wrapper.find('.table__pass');
    expect(pass.exists()).toBe(true);
    expect(pass.attributes('disabled'), '首出时前端不得自行禁用过牌（那是规则，属服务端）').toBeUndefined();

    await pass.trigger('click');
    expect(socket.emittedOf('game.pass')).toHaveLength(1);
  });

  it('倒计时以服务端 turnDeadlineAt 为基准；到 0 不动按钮、不发任何请求（F06）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00.000Z'));

    const { wrapper, socket } = mountTable({ mySeat: 0 });
    const deadline = Date.now() + 5000;
    socket.push(
      serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, turnDeadlineAt: deadline, landlordSeat: 1 }), 2),
    );
    await wrapper.vm.$nextTick();

    // 2026-10-10 起我的钟在中央两按钮之间（`.table__clock-value`），座位上不再挂钟。
    expect(wrapper.find('.table__clock-value').text()).toBe('5s');

    await vi.advanceTimersByTimeAsync(3000);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__clock-value').text()).toBe('2s');

    await vi.advanceTimersByTimeAsync(3000); // 越过 deadline
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__clock-value').text()).toBe('0s');
    // F06：本地时间不参与规则判定 —— 到点后前端既不替服务端发动作，也不改按钮可用性
    expect(socket.emitted).toHaveLength(0);
    expect(wrapper.find('.table__play').attributes('disabled')).toBeDefined(); // 仍在「未选牌」态
    expect(wrapper.find('.table__pass').attributes('disabled')).toBeUndefined();
  });
});

/**
 * 「返回大厅」的**确认退出流**（本片 2026-10-12 Task 3；判据 C9-C12，规格 §2.5/§0.3-7/8/11）。
 *
 * 判别力来自三处：
 *  ① 弹窗经 `uni-stub` **显式驱动**（`calls.showModal[0].success?.({ confirm })`）——
 *     替身不自动回调 ⇒「取消留守」与「确认弃局」是两条真的分开走的路；
 *  ② `room.leave` 的**信封**逐字断言（`{ roomCode }`）+ 手工 ack 驱动三种收尾
 *     （0 = 成功离场 / 非零 = 留守 / 不回 = 本地 5s 超时留守）；
 *  ③ 只导航的两支（ended / view null）**每次都同时断言「无弹窗 + `room.leave` 为空」**——
 *     任一被拖进确认流（或反向补发 leave）都会红。
 */
describe('「返回大厅」确认退出流（C9-C12）', () => {
  let uniStub: UniStub;

  beforeEach(() => {
    // 新装一个替身 ⇒ 调用流水清空，`calls.showModal` 从零开始（文件级 beforeEach 只清存储）。
    uniStub = installUniStub();
  });

  /**
   * 进行中视图：房号钉 `ROOM1`（与 `mountTable` 的 `setRoom` 同值 —— leave 信封里那个
   * 房号因此只有**一个**可能来源：页面读的 `store.roomCode`）。
   */
  function activeView(over: Partial<PlayerView> = {}): PlayerView {
    return playingView({ seat: 0, currentPlayer: 0, roomCode: 'ROOM1', ...over });
  }

  /** 顶栏「返回大厅」——`.table__bar` 里唯一的 `.btn`（探针按文本匹配，测试按结构）。 */
  function backButton(wrapper: VueWrapper) {
    return wrapper.find('.table__bar .btn');
  }

  /** 挂桌上牌桌 + 推一条进行中快照（「局中」的公共前置）。`over` 顶层覆盖活动视图。 */
  async function setupPlaying(over: Partial<PlayerView> = {}) {
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', activeView(over), 2));
    await wrapper.vm.$nextTick();
    return { wrapper, socket, store, auth: useAuthStore() };
  }

  it('进行中点「返回大厅」⇒ 弹确认；参数逐字、此时未发 leave 未导航（C9）', async () => {
    const { wrapper, socket, store, auth } = await setupPlaying();

    await backButton(wrapper).trigger('click');

    expect(uniStub.calls.showModal, '进行中必须弹一个确认（且只有一个）').toHaveLength(1);
    const opts = uniStub.calls.showModal[0]!;
    // §0.3-8 逐字：四段文字一个字都不许漂（承诺的是服务端的实际行为）
    expect({
      title: opts.title,
      content: opts.content,
      confirmText: opts.confirmText,
      cancelText: opts.cancelText,
    }).toEqual({
      title: '退出本局',
      content: '本局将由系统自动打完（金币场按结果结算），期间无法回到本局。',
      confirmText: '退出',
      cancelText: '取消',
    });
    expect(typeof opts.success, '弹窗必须挂 success —— 确认/取消在这里分流').toBe('function');
    // 弹窗还没被回答 ⇒ 什么都不该发生（确认前零副作用）
    expect(socket.emittedOf('room.leave')).toHaveLength(0);
    expect(auth.page).not.toBe('lobby');
    expect(store.roomCode).toBe('ROOM1');
  });

  it('弹窗取消 ⇒ 不发 leave、不导航、不写 localError（C9）', async () => {
    const { wrapper, socket, store, auth } = await setupPlaying();
    await backButton(wrapper).trigger('click');

    uniStub.calls.showModal[0]!.success?.({ confirm: false });
    await flushPromises();

    expect(socket.emittedOf('room.leave'), '取消 ≠ 弃局：一条 leave 都不许发').toHaveLength(0);
    expect(auth.page).not.toBe('lobby');
    expect(store.roomCode).toBe('ROOM1');
    expect(
      wrapper.find('[data-notice-id="table-local"]').exists(),
      '取消不是失败，不得留本地错误项',
    ).toBe(false);
  });

  it('确认 ⇒ 发 room.leave{roomCode}（信封逐字）⇒ ack 0 ⇒ store.reset + 回大厅（C9）', async () => {
    const { wrapper, socket, store, auth } = await setupPlaying();
    await backButton(wrapper).trigger('click');

    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();

    const sent = socket.emittedOf('room.leave');
    expect(sent, '确认必须真的发 room.leave（真弃局，不是纯导航）').toHaveLength(1);
    expect(sent[0]!.env.payload).toEqual({ roomCode: 'ROOM1' });

    sent[0]!.ack(null, { code: 0 });
    await flushPromises();

    // `store.reset()` 的可观测效果（页面不得直写 currentVersion=-1 —— 闸在 game-store-session-reset）
    expect(store.roomCode).toBeNull();
    expect(store.view).toBeNull();
    expect(auth.page).toBe('lobby');
    expect(
      wrapper.find('[data-notice-id="table-local"]').exists(),
      '成功离场不得留本地错误项',
    ).toBe(false);
  });

  it('leave ack 非零（10006）⇒ 就地「退出失败，请重试」；store 不动、留守牌桌（C10）', async () => {
    const { wrapper, socket, store, auth } = await setupPlaying();
    await backButton(wrapper).trigger('click');

    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();
    socket.emittedOf('room.leave')[0]!.ack(null, { code: 10006, message: 'too many requests' });
    await flushPromises();
    await wrapper.vm.$nextTick();

    /* 本地失败项（规格 §2.5 的留守分支）——同一时刻可能还挂着 CLIENT_ACTION 发的
       session notice（10006 在文案表里有独立文案，落 `session-notice` 项），
       因此按 `data-notice-id` + **文本**精确定位。 */
    const local = wrapper.findAll('[data-notice-id="table-local"] .notice__text');
    expect(local.filter((b) => b.text() === '退出失败，请重试'), '非零 ack 必须给出本地失败文案').toHaveLength(1);
    expect(store.roomCode).toBe('ROOM1');
    expect(store.view).not.toBeNull();
    expect(auth.page, '留守 ⇒ 不导航').not.toBe('lobby');
  });

  /**
   * 🔴 **12001 = 视为成功离场**（规格 §2.5 的注释 / 设计 §5#2：房在读与写之间被删 ⇒
   * 服务端凭据已清，留守只会把玩家卡在死房间）。
   *
   * ⚠️ **判别力只能挂在「不落任何提示」上，不能只挂导航/reset**：12001 在 `CLIENT_ACTION`
   * 表里是 `BACK_TO_LOBBY` ⇒ ack 一到，**处置链自身**就会「warn 提示 + `store.reset()` +
   * 回大厅」——把 `doLeave` 的 `|| outcome.code === ErrCode.ROOM_NOT_FOUND` 半边删掉（变异），
   * 「reset 生效 / 已到 lobby」仍然成立（处置链兜着），**只有** `doLeave` 会掉进末尾的
   * 非零分支、把「退出失败，请重试」写成 `table-local` 错误项 ⇒ 下面两条按**文本/id**
   * 定位的断言正是那个变异唯一打红的地方。
   *
   * 🔴 **Task 10 反转**：处置链的 `BACK_TO_LOBBY` warn（「房间不存在」）由 `doLeave` 在
   * 收口后 `clearNotice()` 清掉 —— 成功离场**不得**留下这条提示（旧断言要求它「必须在场」）。
   * 「页面能渲染提示」的正对照改为 13001 的真实拒绝（下一条用例）。
   */
  it('leave ack 12001（房已不存在）⇒ 视为成功离场：reset + 回大厅、无「房间不存在」提示（C10）', async () => {
    const { wrapper, socket, store, auth } = await setupPlaying();
    await backButton(wrapper).trigger('click');

    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();
    socket.emittedOf('room.leave')[0]!.ack(null, { code: 12001, message: 'room not found' });
    await flushPromises();
    await wrapper.vm.$nextTick();

    // ① 成功离场的可观测效果（doLeave 的 12001 半边与处置链同向 ⇒ 这里单独不构成判别力）
    expect(store.roomCode).toBeNull();
    expect(store.view).toBeNull();
    expect(auth.page).toBe('lobby');

    // ② 判别力核心：不得出现「退出失败，请重试」那条本地留守错误项。
    expect(
      wrapper.findAll('[data-notice-id="table-local"] .notice__text').filter((b) => b.text() === '退出失败，请重试'),
      '12001 ⇒ 必须走成功离场路（删掉 doLeave 的 ROOM_NOT_FOUND 半边时本条即红）',
    ).toHaveLength(0);
    // ③ 反转：处置链的「房间不存在」warn 已在收口后清掉（成功离场不留提示）。
    expect(
      wrapper.findAll('.notice__text').filter((b) => b.text().includes('房间不存在')),
      '12001 视为成功离场 ⇒ BACK_TO_LOBBY 的「房间不存在」提示必须被 clearNotice 清掉',
    ).toHaveLength(0);
  });

  /**
   * 正对照（Task 10）：上一条的「无提示」断言必须排除「页面根本渲染不了提示」的假绿。
   * 13001（真实拒绝，`CLIENT_ACTION = TOAST`）走 session notice 通道 ⇒ `NoticeStack`
   * 必须把它呈现出来；且服务端错误**不得**再写本地项（来源分流）。
   */
  it('正对照：13001 的真实拒绝由 session notice 经 NoticeStack 呈现、无本地项', async () => {
    // 非地主 ⇒ 首出也能过牌（`canPass`），点击后服务端拒绝（13001）。
    const { wrapper, socket } = await setupPlaying({ landlordSeat: 1 });
    await wrapper.find('.table__pass').trigger('click');
    socket.emittedOf('game.pass')[0]!.ack(null, { code: ErrCode.ILLEGAL_ACTION });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(
      wrapper.find('[data-notice-id="session-notice"] .notice__text').text(),
      '正对照：真实拒绝必须由 NoticeStack 呈现在页面里',
    ).toBe('服务端判定这手牌不合法，换一手再试');
    expect(
      wrapper.find('[data-notice-id="table-local"]').exists(),
      '服务端错误只走 session notice，不得再写本地项',
    ).toBe(false);
  });

  it('leave 本地超时（假定时器 5s，服务端不回）⇒「退出失败，请重试」+ 留守（C10）', async () => {
    vi.useFakeTimers();
    const { wrapper, socket, store, auth } = await setupPlaying();
    await backButton(wrapper).trigger('click');

    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    // 前置自证：leave 已经真的发出去了（假定时器不阻碍 socket emit —— 它是同步的）；
    // 没有它的话「超时留守」可能只是「什么都没发」的假绿。
    expect(socket.emittedOf('room.leave')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('退出失败，请重试');
    expect(store.roomCode, '超时 ≠ 离场：store 不得被动过').toBe('ROOM1');
    expect(auth.page).not.toBe('lobby');
  });

  it('超时后**迟到**的 ack（code 0）⇒ 不导航、不 reset —— doLeave 已收口（C10）', async () => {
    vi.useFakeTimers();
    const { wrapper, socket, store, auth } = await setupPlaying();
    await backButton(wrapper).trigger('click');

    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await vi.advanceTimersByTimeAsync(5000);

    // 前置自证：超时分支已经落地（否则本用例就没有「迟到」可言）
    expect(wrapper.text()).toContain('退出失败，请重试');

    socket.emittedOf('room.leave')[0]!.ack(null, { code: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await wrapper.vm.$nextTick();

    expect(store.roomCode, '迟到 ack 不得触发 store.reset').toBe('ROOM1');
    expect(store.view).not.toBeNull();
    expect(auth.page, '迟到 ack 不得把用户从牌桌拽走').not.toBe('lobby');
  });

  it('会话已拆除（sendQueued reject）⇒ 收敛成留守，不导航不抛（C10 的 F5 收敛）', async () => {
    const { wrapper, socket, store, auth } = await setupPlaying();
    /**
     * 触发「会话已拆除」：`GameClient.destroy()` 之后所有 `send()` 以 `ClientDestroyedError`
     * **reject**（与登出/销毁会话同形）。doLeave 里 `.catch(() => null)` 把它收敛进留守分支。
     *
     * 「不抛」的证据：确认后本用例照常跑完 —— 若那条拒绝没被收敛，它会以未处理拒绝
     * 让这个测试文件当场红（vitest 默认把 unhandled rejection 记成失败），
     * 而不是等真机上探针的 `Runtime.exceptionThrown`。
     */
    getGameSession().client.destroy();

    await backButton(wrapper).trigger('click');
    uniStub.calls.showModal[0]!.success?.({ confirm: true });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(socket.emittedOf('room.leave'), 'destroy 之后不得再 emit').toHaveLength(0);
    expect(wrapper.text()).toContain('退出失败，请重试');
    expect(store.roomCode).toBe('ROOM1');
    expect(auth.page).not.toBe('lobby');
  });

  it('ended ⇒ 无弹窗、不发 leave、只导航（房号非空也不进确认 —— 次序先 ended）（C11/C12）', async () => {
    const { wrapper, socket, store, auth } = await setupPlaying();
    socket.push(
      serverMessage(
        'game.state_update',
        activeView({
          state: 'ended',
          version: 3,
          hand: [],
          cardCounts: [0, 17, 17],
          winner: 'landlord',
        }),
        3,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(store.roomCode, '前提：ended 态房号仍在（K3：结算页保持现状，不清凭据）').toBe('ROOM1');

    await backButton(wrapper).trigger('click');

    expect(uniStub.calls.showModal, 'ended 不得弹确认（次序：ended 在「进行中」之前）').toHaveLength(0);
    expect(socket.emittedOf('room.leave'), 'ended 不得发 leave（放弃已结束的局无副作用）').toHaveLength(0);
    expect(auth.page).toBe('lobby');
  });

  it('view null（等待房）⇒ 无弹窗、不发 leave、只导航（次序后 view null）（C11/C12）', async () => {
    // 刻意**不推任何快照**：`store.view === null`（已进房、等发牌；fail-open 边角同形）
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    const auth = useAuthStore();
    expect(store.roomCode, '前提：等待房已持有房号（导航守卫会满足）').toBe('ROOM1');
    expect(store.view).toBeNull();

    await backButton(wrapper).trigger('click');

    expect(uniStub.calls.showModal, '等待房不得弹确认（K3：席位留存契约保持现状）').toHaveLength(0);
    expect(socket.emittedOf('room.leave'), '等待房不得发 leave（范围收紧后只导航）').toHaveLength(0);
    expect(auth.page).toBe('lobby');
  });
});

// ───────────────────────────────────────── ⑥ 「提示」按钮（2026-10-13 死按钮修）

describe('「提示」按钮：有候选可点（只选牌不发请求）、无候选 disabled', () => {
  it('有候选（跟单张 5）：可点；点击只选牌、解锁出牌按钮，但不发任何请求', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({
          seat: 0,
          currentPlayer: 0,
          recentActions: [{ seat: 1, cards: makeCards(5) }],
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    const hint = wrapper.find('.table__hint');
    expect(hint.exists()).toBe(true);
    expect(hint.attributes('disabled'), '有候选 ⇒ 提示可点').toBeUndefined();
    expect(wrapper.find('.table__play').attributes('disabled'), '前提：尚未选牌').toBeDefined();

    await hint.trigger('click');
    await wrapper.vm.$nextTick();

    expect(
      wrapper.findAll('.table__me .card--selected').length,
      '提示 = 只做选牌（选中数 > 0）',
    ).toBeGreaterThan(0);
    expect(
      wrapper.find('.table__play').attributes('disabled'),
      '选牌后出牌按钮解锁（但请求仍要用户点「出牌」才发）',
    ).toBeUndefined();
    expect(socket.emittedOf('game.play'), '提示本身不得代替出牌').toHaveLength(0);
  });

  it('能出但提示器枚举不到（跟三带一、只能靠更大的三带一压）：出牌在、提示 disabled —— 不得静默吞点击', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    // 上家出三带一 333+4。手牌：无炸弹无王；可压的只有 555+翼（三带一），
    // 而提示器只枚举单/对/三/炸弹/王炸/顺子 ⇒ 候选为空；「要不起」隐藏不触发。
    const trioWingHand = makeCards(5, 5, 5, 6, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 3, 4, 6);
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({
          seat: 0,
          currentPlayer: 0,
          hand: trioWingHand,
          recentActions: [{ seat: 1, cards: makeCards(3, 3, 3, 4) }],
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__play').exists(), '能出 ⇒ 出牌入口保留').toBe(true);
    const hint = wrapper.find('.table__hint');
    expect(hint.exists(), '能出 ⇒ 提示按钮在（不被「要不起」隐藏）').toBe(true);
    expect(
      hint.attributes('disabled'),
      '提示器枚举不到候选 ⇒ disabled（旧行为：点了静默无反应 = 死按钮）',
    ).toBeDefined();

    await hint.trigger('click');
    await wrapper.vm.$nextTick();
    expect(
      wrapper.findAll('.table__me .card--selected').length,
      'disabled 点击不得产生任何选牌',
    ).toBe(0);
    expect(socket.emittedOf('game.play')).toHaveLength(0);
  });
});

/**
 * 提示单通道（Task 10）：牌桌的会话提示 / 本地项统一由 `NoticeStack` 浮层渲染
 * （挂在 `LandscapeStage` 的 `overlay` 槽）——旧的文档流内 `.table__notices` /
 * `.table__notice` 宿主整块退役。
 */
describe('提示单通道（Task 10）', () => {
  it('牌桌动作拒绝只出现一条 .notice，无 .table__notice', async () => {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    mounted.push(wrapper);
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
    await flushPromises();
    expect(wrapper.find('.table__notices').exists()).toBe(false);
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  });
});

/**
 * 「要不起」保守隐藏（hasBeatablePlay 接线）：
 * 跟牌（窗口最后一手是对手）且手里没有任何一手能压过目标 ⇒ 动作行只剩
 * 倒计时 + 过牌；压得过 / 我首出 ⇒ 出牌 / 提示 / 钟 / 过牌四件全在。
 */
describe('table.vue 动作行「要不起」保守隐藏', () => {
  /**
   * 17 张合法手牌：最大单张 2、点数最多两张（4/5/6/7 各一对），
   * **没有任何四张同点、也没有王炸** ⇒ 对炸弹目标确凿「要不起」。
   */
  const WEAK_HAND = makeCards(
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17,
    4, 5, 6, 7,
  );

  it('对手出炸弹而我无炸无王 ⇒ 出牌/提示整个不在 DOM，钟与过牌保留', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({
          seat: 0,
          currentPlayer: 0,
          hand: WEAK_HAND,
          recentActions: [{ seat: 1, cards: makeCards(3, 3, 3, 3) }],
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__play').exists(), '要不起：出牌按钮必须整个不存在').toBe(false);
    expect(wrapper.find('.table__hint').exists(), '要不起：提示按钮必须整个不存在').toBe(false);
    // 钟与过牌任何情况下都在；过牌不禁用（前端不替服务端判轮次/合法性）。
    expect(wrapper.find('.table__clock').exists()).toBe(true);
    const pass = wrapper.find('.table__pass');
    expect(pass.exists()).toBe(true);
    expect(pass.attributes('disabled')).toBeUndefined();

    // 视图推进成「我首出」（窗口清空）⇒ 两个按钮立刻回来（computed 响应式）。
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({ seat: 0, currentPlayer: 0, version: 3, hand: WEAK_HAND, recentActions: [] }),
        3,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__play').exists()).toBe(true);
    expect(wrapper.find('.table__hint').exists()).toBe(true);
  });

  it('对手出单张而我手里有王炸 ⇒ 四件全在', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        // PLAYING_HAND 同时含小王 20 与大王 30（王炸越级压一切非王炸）。
        playingView({ seat: 0, currentPlayer: 0, recentActions: [{ seat: 1, cards: makeCards(5) }] }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__play').exists()).toBe(true);
    expect(wrapper.find('.table__hint').exists()).toBe(true);
    expect(wrapper.find('.table__clock').exists()).toBe(true);
    expect(wrapper.find('.table__pass').exists()).toBe(true);
  });

  it('我首出（空窗口）⇒ 哪怕牌力再小也四件全在', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({ seat: 0, currentPlayer: 0, hand: WEAK_HAND, recentActions: [], landlordSeat: 1 }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__play').exists()).toBe(true);
    expect(wrapper.find('.table__hint').exists()).toBe(true);
    expect(wrapper.find('.table__clock').exists()).toBe(true);
    expect(wrapper.find('.table__pass').exists()).toBe(true);
  });
});

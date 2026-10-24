/**
 * 叫抢阶段感（**用户卡点③**）：`kind` 文案 · 回显 · 中央倒计时。
 *
 * 判别力说明（每条都写清「什么样的实现会让它红」）：
 *  ① **文案只能由 `kind` 派生**：同一 `kind` 下 `grabActions`/`bidMultiplier` 怎么变文案都不动
 *     （反例），`kind` 一变文案就变（正例）；
 *  ② **中央倒计时只在叫抢期且轮到我**出现（含**负例**：出牌期轮到我、终局 —— 都不得有钟），
 *     且它的秒数与座位钟**读同一个 `seconds`**
 *     （页面唯一的 `useCountdown`；§9.6 / R675：UI 层不得新造时钟）；
 *  ③ **回显按座位分派**：对手的贴各自的出牌/状态列（`.table__play-bid-echo`）、我的贴出牌区域（动作行 `.table__my-bid-echo`，不再占中央）；
 *  ④ **四种 (kind, grab) 组合 ⇒ 四句唯一措辞**，且措辞读的是**决策自己**的 `kind`
 *     （不是阶段当前的 `kind`）。
 *     🔴 这一条是本任务对 `action-feedback.test.ts` 那条**已删除**判据（「不抢 ⇒ 出气泡」，
 *     Task B2 退役）的替代物 —— 该文件头注释 `:13` 写明的承接就在这里。它**可能失败**：
 *     只按 `grab` 分支的实现会把 `['rob', false]` 渲染成「不叫」（红）；
 *  ⑤ 进 `playing` ⇒ 回显让位（**显式取舍**：第 3 条决策当场结束叫抢，由地主徽章 + 翻底牌接管）。
 *     ⚠️ **片① R2 起「第 3 条决策当场结束叫抢」这条前提已作废**（反抢 ⇒ 本轮以 **3 或 4 条**
 *     决策收口、同一轮内同一玩家可决策两次）；本条判据（进 playing ⇒ 回显让位）本身**不变** ——
 *     同源的「回显 + 钟不可达」论证作废与实测读数见 `table-center.test.ts` 的注记与规格 §9。
 *
 * ⚠️ 夹具约束（与 `table-center.test.ts` 同形）：`playerViewFixture(over)` 只做**顶层**覆盖，
 * `bidPhase` **整体替换、不合并** ⇒ 用 `helpers/bid-phase.ts` 的 `bidPhase()` 给全 7 个键
 *（本文件按旧名 `fullBidPhase` 引入；10 份逐字副本 B3 评审 Minor 1 已合流为那一份）。
 * 本文件走 `store.applySnapshot` 直灌（不经 socket / 不过 `validateInbound`）——
 * 判的是**页面对视图的反应**，与 `table-center.test.ts` 同一姿势。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PlayerView } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { bidPhase as fullBidPhase } from './helpers/bid-phase';
import { FakeSocket, playerViewFixture } from './helpers/fake-socket';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

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

/**
 * 挂起牌桌并直灌一个叫抢期视图。
 *
 * ⚠️ `turnDeadlineAt` 取**未来**时刻：中央钟与座位钟因此都有非零秒数 ——
 * 「钟面是活的倒计时、不是空盒/常量」才有可观测的判别力（写死过去时刻会只得到 `0s`）。
 */
function mountBidding(
  phase: Partial<PlayerView['bidPhase']> = {},
  mySeat = 0,
  /** 截止时刻距现在的毫秒数（紧迫态用例传 ≤5000）。默认 30s。 */
  deadlineInMs = 30_000,
) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', mySeat);
  store.applySnapshot(
    playerViewFixture({
      state: 'bidding',
      seat: mySeat,
      turnDeadlineAt: Date.now() + deadlineInMs,
      bidPhase: fullBidPhase({ currentBidder: mySeat, ...phase }),
    }),
  );
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}

describe('叫抢阶段感（用户卡点③）', () => {
  it('kind=call ⇒ 「叫地主 / 不叫」；kind=rob ⇒ 「抢地主 / 不抢」', () => {
    const call = mountBidding({ kind: 'call' });
    expect(call.wrapper.find('.table__bid-grab').text()).toBe('叫地主');
    expect(call.wrapper.find('.table__bid-pass').text()).toBe('不叫');

    const rob = mountBidding({ kind: 'rob', landlordCandidate: 1 });
    expect(rob.wrapper.find('.table__bid-grab').text()).toBe('抢地主');
    expect(rob.wrapper.find('.table__bid-pass').text()).toBe('不抢');
  });

  /** 🔴 反例（判据改形态后的**判别力**所在）：同一 `kind` 下文案**恒定**，不随任何计数变化。 */
  it('同一 kind 下文案恒定（grabActions / bidMultiplier 怎么变都不动）', () => {
    for (const g of [0, 1, 2]) {
      const { wrapper } = mountBidding({ kind: 'call', grabActions: g, bidMultiplier: 2 ** g });
      // 反推：`grabActions > 0 ⇒ '抢地主'` / `bidMultiplier > 1 ⇒ '抢地主'` 这类
      // 「前端自己反推现在是叫还是抢」的实现在 g=1、g=2 两轮立刻红。
      expect(wrapper.find('.table__bid-grab').text(), `grabActions=${g}`).toBe('叫地主');
      expect(wrapper.find('.table__bid-pass').text(), `grabActions=${g}`).toBe('不叫');
    }
  });

  /**
   * 中央倒计时：**只在轮到我**时出现（叫抢期夹在 BidPanel 两按钮之间）。
   * 2026-10-10 牌桌重做：我的钟从「我的座位」搬到中央两按钮之间，叫分/出牌统一；
   * 对手行动时中央无钟，钟以迷你钟形态贴行动对手头像。
   */
  it('中央倒计时只在我行动时出现，且与座位迷你钟读同一个倒计时', async () => {
    const mine = mountBidding({ currentBidder: 0 }, 0);
    const clock = mine.wrapper.find('.table__clock');
    expect(clock.exists(), '叫抢期且轮到我 ⇒ 中央必须有钟').toBe(true);
    const value = clock.find('.table__clock-value');
    expect(value.exists(), '钟面上必须有秒数（中央钟的形态照座位钟）').toBe(true);
    // 反推 ①：把钟做成**静态盒子**（无数字）⇒ `.table__clock-value` 不存在 ⇒ 红。
    expect(value.text(), '钟面必须带秒数与单位').toMatch(/^\d+s$/);
    // 反推 ②：钟面写死 `0s`（不看服务端截止时刻）⇒ 红（夹具给的是 30s 之后）。
    expect(value.text(), '钟面必须是活的倒计时（夹具给的是 30s 之后）').not.toBe('0s');
    // 我行动时：我档座位不再挂钟，也没有行动中的对手 ⇒ 全页没有任何对手迷你钟
    expect(
      mine.wrapper.findAll('.turn-timer'),
      '我的钟在中央：出牌/状态列不得再出现第二个钟',
    ).toHaveLength(0);

    const theirs = mountBidding({ currentBidder: 1 }, 0);
    expect(theirs.wrapper.find('.table__clock').exists(), '别人行动 ⇒ 中央不得有钟').toBe(false);
    // 正对照：同一夹具下**行动对手的出牌/状态列**里迷你钟仍在，且是活的倒计时
    // （证明上面的「没有中央钟」不是「整页什么都没渲染」）。
    const seatTimer = theirs.wrapper.find('.table__play-col .turn-timer');
    expect(seatTimer.exists(), '行动对手的出牌/状态列必须有迷你钟').toBe(true);
    expect(seatTimer.text()).toMatch(/^\d+s$/);
    expect(seatTimer.text()).not.toBe('0s');

    // 源码级（S5.2 拆分后）：**壳**持有唯一 `useCountdown`；**board** 把它作为 prop
    // 同时喂给中央钟与对手迷你钟 —— 两处仍读**同一个** seconds。
    const shellFile = collectSourceFiles().find((f) => f.path === 'src/pages/table/table.vue');
    const boardFile = collectSourceFiles().find(
      (f) => f.path === 'src/components/table/ddz/DdzBoard.vue',
    );
    expect(shellFile, '扫描器必须真的读到 table.vue（壳）').toBeDefined();
    expect(boardFile, '扫描器必须真的读到 DdzBoard.vue（board）').toBeDefined();
    expect(stripComments(shellFile!.content)).toMatch(/useCountdown\s*\(/);
    const boardCode = stripComments(boardFile!.content);
    expect(boardCode, 'timerProps 必须把同一个 seconds 传给对手迷你钟').toMatch(/seconds:\s*props\.seconds/);
    expect(boardCode, '中央钟必须绑同一个 seconds').toMatch(/\{\{\s*seconds\s*\}\}s/);

    /**
     * 出牌期轮到我：中央钟**仍然在**，且 DOM 序 =「过牌 → 钟 → 提示 → 出牌」
     * （2026-10-18 用户裁决：过牌、倒计时、提示、出牌；钟保持**正中央**）。
     */
    const playing = mountBidding({ currentBidder: 0 }, 0);
    playing.store.applySnapshot(
      playerViewFixture({
        state: 'playing',
        seat: 0,
        version: 2,
        landlordSeat: 1,
        currentPlayer: 0, // 轮到我出牌
        turnDeadlineAt: Date.now() + 30_000,
        bidPhase: fullBidPhase({ currentBidder: 0, landlordCandidate: 1, grabActions: 3 }),
      }),
    );
    await playing.wrapper.vm.$nextTick();
    // 夹具前提：出牌期确实轮到**我**（否则本条测不到 isMyTurn 那一半）。
    expect(playing.store.isMyTurn, '夹具前提：出牌期轮到我（currentPlayer = mySeat）').toBe(true);
    const playClock = playing.wrapper.find('.table__clock');
    expect(playClock.exists(), '出牌期轮到我 ⇒ 中央两按钮之间必须有钟').toBe(true);
    // 位置：DOM 序「过牌 → 钟 → 提示 → 出牌」。
    // ⚠️ 两侧按钮各自包在 `.table__actions-side`（`1fr auto 1fr` 网格配平 ⇒ 钟恒居中）
    // ⇒ 不能用「直接子元素下标」，改用 compareDocumentPosition。
    const actions = playing.wrapper.find('.table__actions');
    expect(actions.find('.table__clock').exists(), '钟必须在 .table__actions 内').toBe(true);
    const el = (sel: string) => actions.element.querySelector(sel) as Element | null;
    const before = (a: Element | null, b: Element | null) =>
      a !== null && b !== null && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(el('.table__pass'), '过牌按钮必须存在于动作行').not.toBeNull();
    expect(el('.table__clock'), '钟必须存在于动作行').not.toBeNull();
    expect(el('.table__hint'), '提示按钮必须存在（首出：有提示可选）').not.toBeNull();
    expect(el('.table__play'), '出牌按钮必须存在（首出）').not.toBeNull();
    expect(before(el('.table__pass'), el('.table__clock')), '过牌必须在钟左边').toBe(true);
    expect(before(el('.table__clock'), el('.table__hint')), '钟必须在提示左边（钟居中）').toBe(true);
    expect(before(el('.table__hint'), el('.table__play')), '提示必须在出牌左边').toBe(true);

    playing.store.applySnapshot(
      playerViewFixture({
        state: 'ended',
        seat: 0,
        version: 3,
        landlordSeat: 1,
        currentPlayer: 0,
        turnDeadlineAt: Date.now() + 30_000,
        bidPhase: fullBidPhase({ currentBidder: 0, landlordCandidate: 1, grabActions: 3 }),
      }),
    );
    await playing.wrapper.vm.$nextTick();
    expect(playing.wrapper.find('.table__clock').exists(), '终局 ⇒ 中央不得有钟').toBe(false);
  });

  /** A 档第⑥片：末 5 秒中央钟（与行动对手的迷你钟）挂紧迫态；秒数充裕时不挂。 */
  it('倒计时末 5 秒：中央钟与行动对手迷你钟挂紧迫态（危险色类 + 脉动类）', () => {
    // 4.5s ⇒ ceil = 5（落在 1–5 紧迫档）
    const urgent = mountBidding({ currentBidder: 0 }, 0, 4_500);
    const clock = urgent.wrapper.find('.table__clock');
    expect(clock.classes()).toContain('table__clock--urgent');
    expect(clock.classes()).toContain('anim-urgent-pulse');
    expect(clock.find('.table__clock-value').classes()).toContain('table__clock-value--urgent');

    // 同一个 seconds 阈值驱动对手档迷你钟（不分叉两套阈值）：另挂一个「对手行动」的 4.5s 局
    const opponentUrgent = mountBidding({ currentBidder: 1 }, 0, 4_500);
    expect(
      opponentUrgent.wrapper.find('.turn-timer').classes(),
      '行动对手迷你钟同档紧迫',
    ).toContain('turn-timer--urgent');

    // 负对照：30s 常规态不挂
    const calm = mountBidding({ currentBidder: 0 }, 0, 30_000);
    expect(calm.wrapper.find('.table__clock').classes()).not.toContain('table__clock--urgent');
    expect(calm.wrapper.find('.table__clock').classes()).not.toContain('anim-urgent-pulse');
  });

  /**
   * 回显：对手的贴**各自的出牌/状态列**（`.table__play-bid-echo`），我的贴**出牌区域**
   * （动作行 `.table__my-bid-echo`，2026-10-17 用户裁决：不再占中央）。
   */
  it('回显按座位分派：对手的贴出牌列、我的贴出牌区域（动作行）', () => {
    const { wrapper } = mountBidding({
      // 决策后行动权已交给别人 ⇒ 我的回显才在动作行（轮到我时按钮优先）。
      currentBidder: 1,
      decisions: [
        { seat: 1, kind: 'call', grab: false }, // 玩家1 不叫
        { seat: 0, kind: 'call', grab: true }, // 我 叫地主
      ],
    });
    // 中央不再是我的回显的宿主。
    expect(wrapper.find('.table__center-echo').exists(), '我的回显不得再占中央').toBe(false);
    expect(
      wrapper.find('.table__center').text(),
      '中央不得出现我的叫抢措辞',
    ).not.toContain('叫地主');
    // 我的回显挂在动作行（出牌区域）。
    expect(
      wrapper.find('.table__action-bar .table__my-bid-echo').text(),
      '我的回显贴出牌区域（动作行）',
    ).toBe('叫地主');
    const echoes = wrapper.findAll('.table__play-bid-echo');
    expect(echoes, '只有玩家1 一个对手做了决策 ⇒ 恰好一处对手回显').toHaveLength(1);
    expect(echoes[0]!.text()).toBe('不叫');
    // mySeat=0 逆时针座序：玩家1 = 下家 = 右座（seats[1]）⇒ 回显必须挂在右出牌/状态列，不能跑到左列。
    expect(
      wrapper.find('.table__play-col--left').findAll('.table__play-bid-echo'),
      '左出牌列不得串味',
    ).toHaveLength(0);
    expect(
      wrapper.find('.table__play-col--right').findAll('.table__play-bid-echo'),
      '右对手（下家）的回显挂右出牌列',
    ).toHaveLength(1);
    // 「我的座位卡」里**不得**再有一份（否则同一句话出现两处）。
    expect(wrapper.find('.table__me').findAll('.table__my-bid-echo'), '我的回显只在动作行一处').toHaveLength(0);
  });

  /** 措辞由 `kind` + `grab` **两个字段**推出（四种组合唯一确定一句）。 */
  it('四种组合 ⇒ 四句唯一措辞（读**决策自己**的 kind）', () => {
    const cases: Array<['call' | 'rob', boolean, string]> = [
      ['call', true, '叫地主'],
      ['call', false, '不叫'],
      ['rob', true, '抢地主'],
      ['rob', false, '不抢'],
    ];
    for (const [kind, grab, label] of cases) {
      /**
       * ⚠️ 阶段的 `kind` 刻意保持 `'call'`：回显必须读**决策自己**的 `kind`
       *（协议⑦：`kind` 是决策发生那一刻算好的）——
       * 拿阶段当前 `kind` 顶班的实现会在 `['rob', *]` 两格上红。
       * 🔴 这一格 `['rob', false, '不抢']` 就是「不抢 ⇒ 出气泡」那条已删判据的替代物：
       * 只按 `grab` 分支的实现会渲染成「不叫」⇒ 当场红。
       */
      const { wrapper } = mountBidding({ currentBidder: 1, kind: 'call', decisions: [{ seat: 0, kind, grab }] });
      expect(
        wrapper.find('.table__action-bar .table__my-bid-echo').text(),
        `${kind}/${grab}`,
      ).toBe(label);
      expect(wrapper.find('.table__center-echo').exists(), '中央不得再承载我的回显').toBe(false);
    }
  });

  /** 进 `playing` ⇒ 回显让位（这是**显式取舍**：第 3 条决策看不见，由地主徽章接管）。 */
  it('state=playing ⇒ 回显不显示', async () => {
    const { wrapper, store } = mountBidding({
      currentBidder: 0,
      decisions: [{ seat: 1, kind: 'rob', grab: true }],
    });
    expect(wrapper.find('.table__play-bid-echo').exists()).toBe(true);
    /**
     * ⚠️ `version: 2` 不可省：`applySnapshot` 对 `version === currentVersion` 的快照**丢弃**
     *（§6.2 重复送达）—— 上面那次直灌已是 v1，这里再灌 v1 会静默不生效，本用例永远看不到切换。
     * ⚠️ **`decisions` 必须带着**：协议⑦ 里地主确定后 `decisions` **仍留在视图里**
     *（`shared/ddz/bid.test.ts`「地主确定后 decisions 仍在」）—— 让位只由 `store.isBidding`
     * 承担。若不带着它，这条断言就成了「让位闸删掉也能过」的**恒真判据**
     *（变异 M5 实测：`showBidEcho` 改成恒 `true` 时本用例照样绿）。
     */
    store.applySnapshot(
      playerViewFixture({
        state: 'playing',
        seat: 0,
        version: 2,
        landlordSeat: 1,
        currentPlayer: 1,
        bidPhase: fullBidPhase({
          currentBidder: 0,
          landlordCandidate: 1,
          grabActions: 3,
          decisions: [{ seat: 1, kind: 'rob', grab: true }],
        }),
      }),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__play-bid-echo').exists(), '出牌期不得再占着出牌列').toBe(false);
    expect(wrapper.find('.table__my-bid-echo').exists(), '出牌期不得再占着动作行').toBe(false);
    expect(wrapper.find('.table__center-echo').exists(), '中央从不承载我的回显').toBe(false);
  });
});

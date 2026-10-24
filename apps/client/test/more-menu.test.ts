/**
 * 顶栏瘦身 + 二级弹层（D16 / 片③ spec §3.1）。
 *
 * 判别力说明：本文件**不**断言任何规则（底分/倍数/牌型），只断言四件结构性质：
 *  ① **「收进弹层」的语义 = 关着的时候它们不在 DOM 里**（否则这件事无法证伪 ——
 *     `v-show` 那种「CSS 藏着但还在 DOM」的实现会让「收进弹层」变成一句空话）；
 *  ② 顶栏仍是三段（左「返回大厅 · 阶段状态」· 中「底牌 · 倍数徽章」· 右「托管 · 更多」）
 *     —— 弹层里的入口（背包 / 设置）**一个都不在** `.table__bar` 里；
 *     ⚠️ 托管按钮（挂机治理 C27）自 2026-10-18 用户裁决起**就在顶栏右侧**（更多左边），
 *     不在弹层里 —— 它的判据在 `table-trustee.test.ts`；
 *  ③ 开/关两个方向都可观测：点「更多」开、点关闭收（回到 ①）；
 *  ④ 🔴 **结算揭示即让位**（B4 遗留 Minor 3 + 结算延迟片）：弹层 `z-index: 10` 会**浮在
 *     结算遮罩（`z-index: 1`）之上**、盖住「再来一局 / 返回大厅」⇒ 结算揭示后弹层必须
 *     **不在 DOM**（宿主 `v-if="moreOpen && !settlementRevealed"`；测试环境延迟为 0）。
 *
 * ⚠️ **红线**：两个入口里，**只剩「背包」是 `disabled` 占位**；**「设置」已翻活**（A 档第①片）—— 点开
 * 面板内的音频/震动设置区。记牌器入口已移到顶栏左侧（记牌器片，`.table__counter`）；「托管」按钮
 * （挂机治理 C27）**已移到顶栏右侧、更多左边**（`.table__trustee`），不再属于本弹层。
 * 本仓明文忌讳「造一排点了没反应的活按钮」—— 占位功能落地时**只翻 `disabled` 这一个属性**。
 *
 * ⚠️ **探针锚点**：`.table__bar .btn` 的**逐字文案**「返回大厅」是真浏览器探针
 * （`scripts/browser-e2e.mjs` 的 `clickByText`，按 `textContent.trim() === '返回大厅'` 匹配）
 * 的锚点 ⇒ 本文件也逐字断言它（改名/改文案会当场红）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { SettlementResult } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import MoreMenu from '../src/components/MoreMenu.vue';
import { FakeSocket, makeCards, playerViewFixture, serverMessage } from './helpers/fake-socket';
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
  for (const w of mounted.splice(0)) w.unmount();
  stopGameSession();
});

function mountTable() {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  // 直灌一版合法快照：牌桌挂载即进「叫抢中」（`.table__bar` 的三段与弹层都不依赖阶段，这里只是给它一个真实底座）
  store.applySnapshot(playerViewFixture());
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, store, socket };
}

/** 出牌期视图（结算块在 `v-else` 里 ⇒ 要先喂一条 state_update 让 `store.view` 就位）。 */
const playingView = () =>
  playerViewFixture({ state: 'playing', version: 2, landlordSeat: 2, bottomCards: makeCards(3, 4, 5) });

/**
 * 结算是**守恒**的（`777 + (-388.5 × 2) === 0`）：不守恒的载荷会被 `validateInbound`
 * 先拒掉、根本到不了 UI（与 `table-settlement-ui.test.ts` 的夹具同款）。
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

/** 两个入口按钮的**逐字**文案与顺序（R728 的排位；翻活只改 `disabled`/状态，不改文案与顺序）。 */
const ART_LABELS = ['背包', '设置'];

/** 直接挂载组件（不需要 pinia / 牌桌 —— 哑就是这个意思）。 */
function mountMenu(props: Record<string, unknown> = {}) {
  return mount(MoreMenu, {
    props: { musicOn: true, sfxOn: true, hapticsOn: true, volume: 1, ...props },
  });
}

describe('顶栏瘦身 + 二级弹层（D16）', () => {
  /** 🔴 「收进弹层」的语义：**关着的时候它们不在 DOM 里**（否则这件事无法证伪）。 */
  it('弹层关着 ⇒ 入口按钮不在 DOM；顶栏 = 返回大厅 · 托管 · 更多（记牌器按配置门控）', () => {
    const { wrapper } = mountTable();

    // ① 红线：收进弹层 = 关着时**不在 DOM**（`v-show` 实现会让这一条当场红 —— 见 §变异 M1）
    expect(wrapper.findAll('.table__art-btn')).toHaveLength(0);
    // 连同弹层整棵子树都不在（不是「挂载了但空着」）
    expect(wrapper.find('.table__more-mask').exists()).toBe(false);

    // ② 返回大厅按钮（纯 ← 图标）仍在顶栏左侧
    expect(wrapper.find('.table__bar .table__lobby-back').exists()).toBe(true);
    expect(wrapper.find('.table__bar .table__lobby-back').text()).toBe('←');
    // ③ 顶栏按钮集合：左「←」+ 右「托管 · 更多」—— 弹层里的入口一个都不在栏里。
    //    ⚠️ 托管按钮（挂机治理 C27）自 2026-10-18 用户裁决起**本来就在顶栏**（更多左边）。
    expect(
      wrapper.findAll('.table__bar .btn').map((b) => b.text()),
      '顶栏瘦身：弹层入口不在栏里；栏里是「←」+ 顶栏托管 + 「更多」',
    ).toEqual(['←', '托管', '更多']);
    // ④ 中段（底牌 + 倍数徽章）与右段的入口都还在 —— 且**都在 `.table__bar` 之内**（三段是本条的性质）
    // ⚠️ 同 ⑤：选择器**必须带 `.table__bar` 前缀**，否则「把中段挪出顶栏」照样绿（变异 M9 自证）。
    expect(wrapper.find('.table__bar .table__bar-center').exists()).toBe(true);
    // ⚠️ **同 ⑤：选择器必须带 `.table__bar` 前缀**（B4 遗留 Minor 2）：只写 `.table__more`
    // 的话，「把入口挪出顶栏」照样绿 —— 与 `aafbd76` 收窄的另外两条同类。
    expect(wrapper.find('.table__bar .table__more').exists()).toBe(true);
    // ⑤ 阶段状态在牌桌中央 `.table__phase-overlay`（参考欢乐斗地主 2026-10-20 重排）
    expect(wrapper.find('.table__phase-overlay .table__phase').exists()).toBe(true);
  });

  it('点「更多」⇒ 弹层打开，两个入口出现：设置已翻活，背包仍 disabled 占位', async () => {
    const { wrapper } = mountTable();
    await wrapper.find('.table__more').trigger('click');

    expect(wrapper.find('.table__more-mask').exists(), '「更多」是**活按钮**：它真的有反应').toBe(true);
    expect(wrapper.find('.table__more-panel').exists()).toBe(true);

    const btns = wrapper.findAll('.table__art-btn');
    expect(btns).toHaveLength(2);
    expect(btns.map((b) => b.text())).toEqual(ART_LABELS);
    // 背包仍 **disabled 占位**；托管已移到顶栏右侧（`.table__trustee`），不在本弹层。
    expect(btns.find((x) => x.text() === '背包')!.attributes('disabled'), '背包仍是占位').toBeDefined();
    expect(
      btns.some((x) => x.text() === '托管'),
      '托管按钮不得再出现在「更多」弹层里',
    ).toBe(false);
    // 「设置」已翻活（A 档第①片），且设置区初始收着
    const settingsBtn = btns.find((x) => x.text() === '设置')!;
    expect(settingsBtn.attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.table__more-settings').exists()).toBe(false);
  });

  it('点「设置」⇒ 展开音频/震动设置区；再点收起（v-if，不留 DOM）', async () => {
    const { wrapper } = mountTable();
    await wrapper.find('.table__more').trigger('click');
    const settingsBtn = wrapper.findAll('.table__art-btn').find((x) => x.text() === '设置')!;

    await settingsBtn.trigger('click');
    expect(wrapper.find('.table__more-settings').exists()).toBe(true);
    expect(settingsBtn.attributes('aria-expanded')).toBe('true');
    // 三枚开关 + 音量行都在
    expect(wrapper.findAll('.table__switch')).toHaveLength(3);
    expect(wrapper.find('.table__vol-value').text()).toBe('100%');

    await settingsBtn.trigger('click');
    expect(wrapper.find('.table__more-settings').exists()).toBe(false);
  });

  it('点关闭 ⇒ 弹层收起、入口按钮重新不在 DOM', async () => {
    const { wrapper } = mountTable();
    await wrapper.find('.table__more').trigger('click');
    expect(wrapper.findAll('.table__art-btn')).toHaveLength(2); // 先证明「开着」这一半能观测到（R115）

    await wrapper.find('.table__more-close').trigger('click');
    expect(wrapper.findAll('.table__art-btn')).toHaveLength(0);
    expect(wrapper.find('.table__more-mask').exists()).toBe(false);
  });

  it('弹层的开合语义：点面板内部**不**关，点遮罩自身才关', async () => {
    const { wrapper } = mountTable();
    await wrapper.find('.table__more').trigger('click');

    // 面板内部（非遮罩自身）的点击不得把弹层关掉 —— 否则点标题/空白就把面板收了。
    // ⚠️ 机制是**面板根的 `@click.stop`**（不是 `.self`：uni 补丁运行时 `@dcloudio/uni-h5-vue`
    // 下 `.self` 的 target/currentTarget 恒为两个 facade ⇒ 守卫恒真、handler 恒被吞；
    // 根因与真浏览器取证见 2026-09-29 修复轮②报告/账本）。
    await wrapper.find('.table__more-panel').trigger('click');
    expect(wrapper.findAll('.table__art-btn'), '点面板内部不得关闭（面板根的 `@click.stop`）').toHaveLength(2);

    await wrapper.find('.table__more-mask').trigger('click');
    expect(wrapper.findAll('.table__art-btn')).toHaveLength(0);
  });

  /**
   * 🔴 **源码级**：遮罩关闭**不得**回到 `.self` 形态（2026-09-29 修复轮②）。
   *
   * 判别力：`.self` 在本仓的运行时里**结构性不可用**（uni 补丁运行时的 `$nne` 归一化让
   * `e.target !== e.currentTarget` 恒真 ⇒ handler 恒被吞；真栈直证见账本），而
   * **jsdom 单测看不见这个差异**（stock vue）⇒ 只能靠源码闸 + 真浏览器探针两层合起来看。
   * 本闸钉住**形态**：遮罩 = 裸 `@click`；面板根 = `@click.stop`（点面板内部不冒泡到遮罩）。
   */
  it('源码级：遮罩关闭不是 `.self`；是「裸 click + 面板根 .stop」', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/components/MoreMenu.vue');
    expect(file, '扫描器必须真的读到 MoreMenu.vue（否则本闸恒绿）').toBeDefined();
    const code = stripComments(file!.content);

    expect(code, '`.self` 在这条管线上恒被吞 —— 不得再出现').not.toMatch(/@click\.self/);
    // 正对照：旧写法必须被**同一条正则**报出（否则「没有 .self」可能只是这条正则从没匹配过东西）
    expect(
      `<view class="table__more-mask" @click.self="emit('close')">`,
      '正对照：旧形态必须被本闸的同一正则报出',
    ).toMatch(/@click\.self/);

    expect(code, '遮罩必须是**裸** `@click`（去掉 .self 之后的形态）').toMatch(
      /table__more-mask"[^>]*@click="emit\('close'\)"/,
    );
    expect(code, '面板根必须有 `@click.stop`（否则点面板内部会被遮罩的裸 click 关掉）').toMatch(
      /table__more-panel"[^>]*@click\.stop/,
    );
  });

  /**
   * ④ 🔴 **结算揭示即让位**（B4 遗留 Minor 3 + 结算延迟片）。
   *
   * **可达态**（这是它存在的理由）：弹层开着时结算到达 —— 真实触发路径是**对家出完牌**，
   * 而玩家恰好点开了「更多」。弹层 `z-index: 10`、结算遮罩 `z-index: 1`（`table.vue`）⇒
   * 弹层**浮在结算之上**，把「再来一局 / 返回大厅」盖住：两个按钮点不到（探针走 DOM
   * `.click()` 不受遮挡影响，所以**只有这条 DOM 判据**能钉住它）。
   *
   * **判别力（反着推）**：把宿主的 `&& !settlementRevealed` 删掉 ⇒ 弹层仍在 DOM ⇒ 本条当场红。
   * ⚠️ 先断言「弹层真的开着」与「结算真的到了」——否则「结算后不在 DOM」可能是
   * 「根本没开过 / 载荷被协议层拒了」的**假绿**（R115：先证明观测面有效）。
   */
  it('弹层开着时结算揭示 ⇒ 弹层让位（整棵子树离开 DOM），不再盖住结算的两个按钮', async () => {
    const { wrapper, socket, store } = mountTable();
    socket.push(serverMessage('game.state_update', playingView(), 2));
    await wrapper.vm.$nextTick();

    await wrapper.find('.table__more').trigger('click');
    // 前提一：弹层真的开着（入口按钮在 DOM 里）
    expect(wrapper.find('.table__more-mask').exists(), '前提：弹层真的开着').toBe(true);
    expect(wrapper.findAll('.table__art-btn')).toHaveLength(2);

    socket.push(serverMessage('game.settlement', SETTLEMENT_FIXTURE, 3));
    await wrapper.vm.$nextTick();

    // 前提二：结算真的到了（否则下面两条断言是假绿）
    expect(store.settlement, '前提：载荷通过了 validateInbound 并进了 store').not.toBeNull();
    expect(wrapper.find('.table__settlement').exists(), '前提：结算面板真的渲染出来了').toBe(true);
    expect(wrapper.find('.settlement__again').exists()).toBe(true);

    // 红线：弹层让位 —— 整棵子树不在 DOM（不是 CSS 藏着）
    expect(wrapper.find('.table__more-mask').exists(), '结算揭示 ⇒ 弹层让位（z-index 10 会盖住它）').toBe(false);
    expect(wrapper.findAll('.table__art-btn')).toHaveLength(0);
  });
});

/**
 * 设置区是**受控哑组件**：值由 props 决定（开关的 on 态 / aria / 音量文案），
 * 变更只 emit，组件自己不落存储、不读音频模块。
 */
describe('MoreMenu 设置区（哑组件契约）', () => {
  /** 展开设置区（宿主挂载时它默认收着）。 */
  async function openSettings(w: ReturnType<typeof mountMenu>) {
    await w.findAll('.table__art-btn').find((x) => x.text() === '设置')!.trigger('click');
  }

  it('props 决定开关的 on 态与 aria-checked', async () => {
    const w = mountMenu({ musicOn: false, sfxOn: true, hapticsOn: false });
    await openSettings(w);
    const switches = w.findAll('.table__switch');
    expect(switches.map((s) => s.attributes('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(switches.map((s) => s.classes().includes('table__switch--on'))).toEqual([false, true, false]);
    expect(switches.map((s) => s.text())).toEqual(['关', '开', '关']);
  });

  it('点开关只 emit 翻转值（music / sfx / haptics），组件内不改状态', async () => {
    const w = mountMenu();
    await openSettings(w);
    const [music, sfx, haptics] = w.findAll('.table__switch');

    await music!.trigger('click');
    await sfx!.trigger('click');
    await haptics!.trigger('click');

    expect(w.emitted('music')).toEqual([[false]]);
    expect(w.emitted('sfx')).toEqual([[false]]);
    expect(w.emitted('haptics')).toEqual([[false]]);
    // props 没变 ⇒ 视图也不变（受控：父不回灌，它就不自翻）
    expect(w.findAll('.table__switch').every((s) => s.attributes('aria-checked') === 'true')).toBe(true);
  });

  it('音量：0.25 步进、百分比文案、边界禁用步进键', async () => {
    const w = mountMenu({ volume: 0.5 });
    await openSettings(w);
    expect(w.find('.table__vol-value').text()).toBe('50%');

    const minus = w.find('.table__vol .table__vol-btn:first-child');
    const plus = w.findAll('.table__vol-btn')[1]!;
    expect(minus.attributes('disabled')).toBeUndefined();
    expect(plus.attributes('disabled')).toBeUndefined();

    await plus.trigger('click');
    expect(w.emitted('volume')).toEqual([[0.75]]);
  });

  it('音量边界：100% 时「+」禁用且点击不 emit；25% 时「-」禁用', async () => {
    const max = mountMenu({ volume: 1 });
    // openSettings 的帮助函数绑定了另一处 wrapper，这里手动展开
    await max.findAll('.table__art-btn').find((x) => x.text() === '设置')!.trigger('click');
    const plus = max.findAll('.table__vol-btn')[1]!;
    expect(plus.attributes('disabled')).toBeDefined();
    await plus.trigger('click');
    expect(max.emitted('volume')).toBeUndefined();

    const min = mountMenu({ volume: 0.25 });
    await min.findAll('.table__art-btn').find((x) => x.text() === '设置')!.trigger('click');
    const minus = min.find('.table__vol .table__vol-btn:first-child');
    expect(minus.attributes('disabled')).toBeDefined();
    await minus.trigger('click');
    expect(min.emitted('volume')).toBeUndefined();
  });
});

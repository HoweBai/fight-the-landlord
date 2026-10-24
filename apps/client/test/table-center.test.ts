/**
 * 中央的「场次名 + 底分」（协议⑥ / 片规格 §3.2）。
 *
 * 判别力说明（三条，每条都写清**什么实现会让它红**）：
 *  ① **数字来自服务端字段**（`PlayerView.baseScore`），名字**按那个数字**去档位表查 ——
 *     夹具刻意让「用户选中的档」（80 = 标准场）与「服务端给的档」（15 = 休闲场）**不同**
 *     ⇒ 拿 `selectedLevelName` 顶班的实现会把场次名显示成「标准场」，当场红。
 *  ② **查不到就不编**（片② §4 的既有纪律）：999 不在档位表里 ⇒ 只显示底分、零场次名。
 *  ③ **缺字段整块不显示、不抛错**（R661 同族）：真浏览器探针的 `seedFinishedGame`
 *     （`scripts/browser-e2e.mjs`）往 store 里**直接注入**一份不过校验器的残缺视图
 *     （它没有 `baseScore`）⇒ 中央这块必须消失，且页面上不得出现**任何**「底分」字样
 *     （不得替服务端编一个数字）。
 *
 * ⚠️ 夹具约束（与 `table-bid-ui.test.ts` 一致）：`playerViewFixture(over)` 只做**顶层**覆盖，
 * 嵌套对象（`bidPhase` 等）要**整份**给。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PlayerView } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
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
  // ⚠️ `useCountdown` 在页面挂载时就起了 250ms 的 setInterval；不卸载会让本文件留下若干常驻定时器。
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  stopGameSession();
});

/** 档位表：15 = 休闲场、80 = 标准场（与 `base-score-selection.test.ts` 同形）。 */
const LEVELS = [
  { name: '休闲场', baseScore: 15 },
  { name: '标准场', baseScore: 80 },
];

/**
 * 挂起牌桌，`view` 里给的都是**服务端字段**。
 *
 * ⚠️ **`setSelectedBaseScore(80)` 是判别力的一部分**：用户选中的是标准场，
 * 而视图给的是 15（休闲场）⇒ 「拿选中档顶班」的实现会显示「标准场」⇒ 用例红。
 */
function mountTable(view: Partial<PlayerView> = {}) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  // 片⑦：档位表与好友房开关同一条响应（`GET /api/config`）⇒ 走生产 action 一次写入
  // （支付片 T14 扩至 14 键 + 广告片 T19 第 15 键 `reliefAdpid`——本文件无 oracle 读它们）。
  store.setClientConfig({
    baseScoreLevels: LEVELS,
    friendRoomEnabled: false,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    reliefAdpid: '',
    entryMultiplier: 10,
    // 支付片 T14：扩至 14 键（本文件无 oracle 读支付七键；稳定关态即可）。
    rechargeEnabled: false,
    withdrawEnabled: false,
    coinPerYuan: null,
    rechargePackages: [],
    withdrawMinCoins: null,
    withdrawMaxCoinsPerOrder: null,
    withdrawDailyMaxCoins: null,
    withdrawReAuthEnabled: false,
    version: 1,
  });
  store.setSelectedBaseScore(80);
  store.applySnapshot(playerViewFixture({ baseScore: 15, ...view }));
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, store };
}

describe('store.viewLevelName：按**服务端说的**底分查场次名（协议⑥）', () => {
  it('查的是 view.baseScore；它与 selectedLevelName 是**两件事**；查不到 ⇒ null', () => {
    const store = useGameStore();
    store.setClientConfig({
      baseScoreLevels: LEVELS,
      friendRoomEnabled: false,
      freeRoomEnabled: true,
      goldRoomEnabled: false,
      reliefEnabled: false,
      reliefAdpid: '',
      entryMultiplier: 10,
      // 支付片 T14：扩至 14 键（无 oracle 读支付七键；稳定关态即可）。
      rechargeEnabled: false,
      withdrawEnabled: false,
      coinPerYuan: null,
      rechargePackages: [],
      withdrawMinCoins: null,
      withdrawMaxCoinsPerOrder: null,
      withdrawDailyMaxCoins: null,
      withdrawReAuthEnabled: false,
      version: 1,
    });
    store.setSelectedBaseScore(80);
    expect(store.viewLevelName, '还没有视图 ⇒ null（不编名字）').toBeNull();

    store.applySnapshot(playerViewFixture({ baseScore: 15 }));

    expect(store.viewLevelName, '服务端说这局是 15 ⇒ 休闲场').toBe('休闲场');
    // 判别力：用户选中的 80 仍然是「标准场」—— 两个 getter 查的是**不同的输入**，
    // 谁把它们合并（或互相顶班）这条就红。
    expect(store.selectedLevelName, '用户选中的那个（进房前）不受影响').toBe('标准场');

    store.applySnapshot(playerViewFixture({ baseScore: 999, version: 2 }));
    expect(store.viewLevelName, '999 不在档位表里 ⇒ null（**不编名字**）').toBeNull();
  });
});

describe('中央：场次名 + 底分（协议⑥ / §3.2）', () => {
  it('底分来自服务端字段，场次名按**那个数字**查档位表', () => {
    const { wrapper, store } = mountTable();
    /**
     * 🔵 **判别力前提（B1 评审 Minor 补的变异演示）**：本用例的判别力**靠夹具** ——
     * 「用户选中的档」（80 = 标准场）必须与「服务端说的档」（15 = 休闲场）**真的不同**。
     * 谁把页面改成读 `selectedLevelName` 顶班，下面的断言当场红（B1 修复轮实测 M9）；
     * 若哪天夹具把两者写成同一个值，**这条先红** —— 判别力不许这样静默消失。
     */
    expect(
      store.selectedLevelName,
      '夹具前提：选中的档（80）与服务端给的档（15）必须不同，否则本用例失去判别力',
    ).toBe('标准场');
    // 红的一半：拿 `selectedLevelName`（= 标准场）顶班的实现会显示「标准场」。
    expect(wrapper.find('.table__scene-name').text()).toBe('休闲场');
    // 红的另一半：数字必须是**服务端给的那个** —— 断言**精确文本**（`toContain('15')` 会让
    // 「本地算出来的 150」蒙混过关；`.toBe` 不给它机会）。
    expect(wrapper.find('.table__scene-base').text()).toBe('底分 15');
  });

  /**
   * 🔴 **查不到名字就不编** —— 既有纪律（片② §4：查不到返回 `null`，不编名字）。
   * 底分 999 不在档位表里 ⇒ 只显示底分，**不得**出现任何场次名。
   */
  it('档位表里查不到 ⇒ 只显示底分，不编名字', () => {
    const { wrapper } = mountTable({ baseScore: 999 });
    expect(
      wrapper.find('.table__scene-name').exists(),
      '查不到就把名字藏起来 —— 不得回落到第一档、也不得编一个名字',
    ).toBe(false);
    expect(
      wrapper.find('.table__scene-base').text(),
      '底分块必须**还在**（查不到的是名字，不是底分），且数字就是服务端那个',
    ).toBe('底分 999');
  });

  /**
   * 🔴 **缺字段必须容忍**（R661 同族）：真浏览器探针的 `seedFinishedGame` 往 store 里
   * 直接注入一个**不过校验器**的残缺视图（它没有 `baseScore`）⇒ 本块必须整块不显示、**不抛错**。
   *
   * ⚠️ 注入姿势：探针走 `store.$patch`（`scripts/browser-e2e.mjs`），但它是在**已有视图**上
   * 深合并 ⇒ 删不掉旧键；这里要的是「视图对象**没有** `baseScore` 这个键」这个**状态**，
   * 所以直接换掉整个 `view`（`table-bid-bottom.test.ts` 的同形夹具断言的是同一种状态）。
   */
  it('缺 baseScore ⇒ 中央整块不显示，且页面上零「底分」字样（R661 同族）', async () => {
    const { wrapper, store } = mountTable();
    const v = { ...store.view! } as Record<string, unknown>;
    delete v.baseScore;
    store.view = v as never;
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__scene-name').exists()).toBe(false);
    expect(wrapper.find('.table__scene-base').exists()).toBe(false);
    // 负对照（§4 账本 R654 行的「服务端不给 ⇒ 不得出现任何底分数字」）：
    // 缺字段时**整页**不得出现「底分」二字 —— 挡住「底分 —」「底分 undefined」这类编造。
    expect(wrapper.text(), '服务端没给底分 ⇒ 不得替它编一个').not.toContain('底分');
  });

  /**
   * 🔴 **查询入口必须进 store**（§3.2 逐字）：拿 `view.baseScore` 去档位表查名字
   * **不得在页面里就地 `find()`** —— 那会变成第二个查询实现，两边迟早不一致。
   *
   * 判别力：把查询写回页面（必然要引用 `store.baseScoreLevels`）⇒ 当场红；
   * 走 `store.viewLevelName` 的实现根本不碰这张表 ⇒ 绿。
   */
  it('源码级：页面不得自己查档位表（第二个查询实现）', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(file, '扫描器必须真的读到 DdzBoard.vue（否则本闸恒绿）').toBeDefined();
    const code = stripComments(file!.content);
    expect(code, '场次名必须走 store.viewLevelName（§3.2：查询入口进 store）').not.toMatch(
      /baseScoreLevels/,
    );
    /**
     * 🔵 **正对照（B1 评审 Minor 补的变异演示）**：把查询写回页面的形态（就地 `find()`）
     * 必须被**同一条正则**报出 —— 少了它，「页面里没有 `baseScoreLevels`」可能只是
     * 「这条正则从来没匹配过任何东西」（恒绿）。实测（B1 修复轮 M8）：真把页面改成
     * `store.baseScoreLevels.find(...)` ⇒ 上面那条断言当场红。
     */
    expect(
      'const name = store.baseScoreLevels.find((l) => l.baseScore === store.view!.baseScore)?.name;',
      '就地查表的实现必须被本闸的同一正则报出',
    ).toMatch(/baseScoreLevels/);
  });
});

/**
 * 🔴 **动作区：手牌正上方的独立动作行**（2026-10-11 用户裁决「仿欢乐斗地主」）。
 *
 * 位置演变：`.table__me` 绝对定位浮层（片③ 之前）→ `.table__center`（片③，与左右出牌槽
 * 共享横排 ⇒ 对手一出牌按钮就横跳）→ **`.table__action-bar`**（手牌正上方的独立整行）。
 *
 * 判别力：
 *  · 结构（渲染级）：`.table__actions` 必须在 `.table__action-bar` 内，且
 *    **不在** `.table__mid`（对手出牌槽所在的横排）/ `.table__center` / `.table__me` 内
 *    —— 搬回任意一个旧宿主 ⇒ 前几条当场红；
 *  · 顺序（渲染级）：DOM 列序 `.table__mid` → `.table__action-bar` → `.table__me`
 *    （按钮紧贴手牌，且在「我出的牌」之下）；
 *  · 形态（源码级）：`.table__actions` 的规则里不得有**浮层四件套**
 *    （`position` / `transform` / `top` / `left`）（含正对照）；
 *    `.table__action-bar` 必须预留钟高（`min-height: $ftl-size-clock-h`）。
 */
describe('动作区：手牌正上方的独立动作行（2026-10-11 仿欢乐斗地主）', () => {
  it('叫抢期：BidPanel 在 `.table__action-bar` 内；旧三处宿主（mid/center/me）都没有动作区', () => {
    const { wrapper } = mountTable(); // 夹具底座即 bidding 态
    expect(
      wrapper.find('.table__action-bar .table__actions').exists(),
      '动作区必须挂在手牌上方的独立动作行内',
    ).toBe(true);
    expect(wrapper.find('.table__action-bar .table__bid-panel').exists()).toBe(true);
    expect(wrapper.findAll('.table__mid .table__actions'), '动作区不得在对手出牌槽的横排里（否则会被对手出牌推动）').toHaveLength(0);
    expect(wrapper.findAll('.table__center .table__actions'), '中央容器里不得再有动作区').toHaveLength(0);
    expect(wrapper.findAll('.table__me .table__actions'), '旧浮层宿主里不得再有动作区').toHaveLength(0);
  });

  it('出牌期：出牌/过牌两个按钮在动作行、仍是原 class 与**逐字**文案', () => {
    const { wrapper } = mountTable({ state: 'playing', currentPlayer: 0 });
    const actions = wrapper.find('.table__action-bar .table__actions');
    expect(actions.exists(), '出牌期的动作区也必须在动作行').toBe(true);
    // 逐字文案 + 稳定 class（探针与 4 个测试文件的锚点 —— 一个字都不许改）
    expect(actions.find('.table__play').text()).toBe('出牌（0）');
    expect(actions.find('.table__pass').text()).toBe('过牌');
    expect(wrapper.findAll('.table__me .table__play'), '旧宿主里不得再有出牌按钮').toHaveLength(0);
  });

  it('DOM 列序：中段（对手出牌槽）→ 动作行 → 我的手牌区；中央只留场次名', () => {
    const { wrapper } = mountTable({
      bidPhase: {
        ...playerViewFixture().bidPhase,
        decisions: [{ seat: 0, kind: 'call', grab: true }],
      },
    });
    // 中央只剩场次名（2026-10-17 起我的叫抢回显移到动作行）。
    const centerOrder = wrapper
      .findAll('.table__center .table__scene')
      .map((el) => el.classes().find((c) => c === 'table__scene'));
    expect(centerOrder).toEqual(['table__scene']);
    expect(wrapper.find('.table__center-echo').exists(), '中央不再承载我的回显').toBe(false);
    // 列序：mid → action-bar → me（在 `.table` 的直接子树里按文档序）。
    const doc = wrapper.find('.table').element;
    const idx = (sel: string) => Array.from(doc.querySelectorAll(':scope > *')).indexOf(
      doc.querySelector(sel)!,
    );
    const midIdx = idx('.table__mid');
    const barIdx = idx('.table__action-bar');
    const meIdx = idx('.table__me');
    expect(midIdx).toBeGreaterThanOrEqual(0);
    expect(barIdx).toBeGreaterThan(midIdx);
    expect(meIdx).toBeGreaterThan(barIdx);
    // 钟在动作行内（两按钮之间的结构由 table-bid-stage 另钉）。
    expect(wrapper.find('.table__action-bar .table__clock').exists()).toBe(true);
  });

  it('源码级：`.table__actions` 规则里没有浮层四件套（position/transform/top/left）', () => {
    /** 取 `.table__actions` 的规则体，判它是否带浮层属性。 */
    const hasFloatProps = (src: string): boolean => {
      const m = /\.table__actions\s*\{([^}]*)\}/.exec(src);
      return m ? /position\s*:|transform\s*:|\b(top|left)\s*:/.test(m[1]!) : false;
    };
    const file = collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(file, '扫描器必须真的读到 DdzBoard.vue（否则本闸恒绿）').toBeDefined();
    const code = stripComments(file!.content);
    expect(
      /\.table__actions\s*\{([^}]*)\}/.exec(code),
      '必须能取到 `.table__actions` 的规则块（取不到说明类名被改了）',
    ).not.toBeNull();
    expect(hasFloatProps(code), '动作区不得再是绝对定位浮层（R735 退役）').toBe(false);
    // 正对照：旧形态必须被**同一条判据**判为违规
    expect(
      hasFloatProps(
        '.table__actions { position: absolute; top: 0; left: 50%; transform: translate(-50%, -100%); }',
      ),
      '正对照：浮层形态必须判为违规（否则本闸可能恒绿）',
    ).toBe(true);
  });

  it('源码级：`.table__action-bar` 必须锁固定高度（height: $ftl-size-action-bar-h）且不在中段内', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(file, '扫描器必须真的读到 DdzBoard.vue（否则本闸恒绿）').toBeDefined();
    const code = stripComments(file!.content);
    const m = /\.table__action-bar\s*\{([^}]*)\}/.exec(code);
    expect(m, '必须能取到 `.table__action-bar` 的规则块').not.toBeNull();
    expect(m![1], '动作行固定高度（不是 min-height）：按钮/我出的牌/不出各态切换手牌不跳').toMatch(
      /height:\s*\$ftl-size-action-bar-h\s*;/,
    );
    // 模板级（只看 <style> 之前，避免命中间名相同的 CSS 规则）：动作行标签必须出现在
    // `.table__mid` 开标签之后（不与对手出牌槽同横排）。
    const template = code.slice(0, code.indexOf('<style'));
    const midOpen = template.indexOf('class="table__mid"');
    const barTag = template.indexOf('class="table__action-bar"');
    expect(midOpen).toBeGreaterThanOrEqual(0);
    expect(barTag).toBeGreaterThan(midOpen);
  });
});

/**
 * 🔴 **我的区域不得再有白色底板**（2026-10-11 用户裁决）：欢乐斗地主的手牌与底栏直接
 * 浮在牌桌底纹上。源码闸钉住 `.table__me` 规则块内不得声明任何 `background`
 * （重新铺白卡 ⇒ 当场红）。
 */
describe('我的区域：无白色底板（2026-10-11 仿欢乐斗地主）', () => {
  it('源码级：`.table__me` 规则块不得声明 background / border-radius', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(file, '扫描器必须真的读到 DdzBoard.vue（否则本闸恒绿）').toBeDefined();
    const code = stripComments(file!.content);
    const m = /\.table__me\s*\{([^}]*)\}/.exec(code);
    expect(m, '必须能取到 `.table__me` 的规则块').not.toBeNull();
    expect(m![1], '底栏白卡必须整段删除（不得保留任何 background 声明）').not.toMatch(/background/);
    // 正对照：旧形态必须被同一条判据判为违规
    expect(
      /background/.test(
        '.table__me { padding: 4px 8px; border-radius: 12px; background: #fafafa; }',
      ),
      '正对照：铺底板的形态必须判为违规',
    ).toBe(true);
  });
});

/**
 * 🔴 **中央钟：不许被纵向压扁**（修复轮② 的量具结论落成闸）。
 *
 * 真浏览器量具（`final-check` 两轮 · 旧/新树同态对比）：
 *  · 旧树（搬移前）：真实可达态的中央余量 ~93.7 ⇒ 钟恒 88×92；
 *  · 新树（动作区搬进中央后）：真实可达态（叫抢期 + 轮到我 + 钟）内容 325.0 / 可用 324.7
 *    ⇒ 钟已被压 0.2px（88×91.8，亚像素）；注入的「回显 + 钟同场」态被压到 88×37.8
 *    （该态原判**不可达**：一轮制叫抢下「我决策后当前叫抢者必已前进」，真机时间序列直证两者从不同场。
 *    ⚠️ **片① R2 起此论证已作废**：反抢让「同一轮内同一玩家决策两次」可达（反抢者的两次决策
 *    **不连续**、中间夹第 3 拍）⇒「**我的（中央）回显 + 我的钟**」**同场可达**。护栏仍在、钟不会被压扁
 *    —— **Task 9 实测两轮**：该态下钟恒 88×92、`centerOverflowPx` = 0，但**内容**在盒外对称外溢 ±19.1px
 *    ⇒ 决定**不加裁切、不调中段**（裁切会切可见文字）。原始读数见
 *    `.tmp_shots/table-fix/bid2-measure-bid2.json` · `bid2-run2-measure-bid2.json`（规格 §9）——
 *    量尺那半仍由真浏览器量具背书，本文件的判据只管源码形态）。
 *  钟是中央里**唯一**的可压缩项（`overflow: hidden` 让它的自动最小高不再等于内容）⇒
 *  不设防就会被当作纵向缓冲。
 *
 * 判别力：删掉 `flex-shrink: 0`（或改成 1）⇒ 当场红。判据只做**源码级**——
 * jsdom 不布局、量不出 0.2px 的差（量尺那半由真浏览器量具背书）。
 */
describe('中央钟：不许被纵向压扁（修复轮②）', () => {
  it('源码级：`.table__clock` 规则必须有 `flex-shrink: 0`', () => {
    /** 取 `.table__clock` 的规则体，判它是否声明了不可压缩。 */
    const hasClockGuard = (src: string): boolean => {
      const m = /\.table__clock\s*\{([^}]*)\}/.exec(src);
      return m ? /flex-shrink\s*:\s*0/.test(m[1]!) : false;
    };
    const file = collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(file, '扫描器必须真的读到 DdzBoard.vue（否则本闸恒绿）').toBeDefined();
    const code = stripComments(file!.content);
    expect(
      /\.table__clock\s*\{([^}]*)\}/.exec(code),
      '必须能取到 `.table__clock` 的规则块（取不到说明类名被改了）',
    ).not.toBeNull();
    expect(hasClockGuard(code), '钟不得被当作中央的纵向缓冲（`flex-shrink: 0`）').toBe(true);
    // 正对照：不设防的形态必须被**同一条判据**判为违规
    expect(
      hasClockGuard('.table__clock { width: 88px; height: 92px; }'),
      '正对照：无护栏形态必须判为违规（否则本闸可能恒绿）',
    ).toBe(false);
    expect(
      hasClockGuard('.table__clock { flex-shrink: 1; }'),
      '正对照：`flex-shrink: 1`（可压缩）同样必须判为违规',
    ).toBe(false);
  });
});

/**
 * 中央钟秒数位数压缩档（2026-10，用户卡点：两位秒溢出闹钟金边）。
 * 88×92 钟灰玻璃内径 ~45.8 画布 px，xl(40) 的两位秒实宽 ~63.6 ⇒ 两位必须降到 md(28)，
 * 三位（timeoutMs 理论 >99s）再降到 `$ftl-font-clock-compact`(18)。jsdom 不布局 ⇒ 源码闸，
 * 贴合量尺由真浏览器量具背书。
 */
describe('中央钟：多位秒数压缩档', () => {
  it('源码级：digits-2 → $ftl-font-md、digits-3 → $ftl-font-clock-compact，阈值沿 10/100', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(file, '扫描器必须真的读到 DdzBoard.vue（否则本闸恒绿）').toBeDefined();
    const code = stripComments(file!.content);

    expect(
      /\.table__clock-value--digits-2\s*\{[^}]*font-size:\s*\$ftl-font-md\s*;/.test(code),
      '两位秒必须降到 $ftl-font-md（28，实测贴入 88 钟钟面）',
    ).toBe(true);
    expect(
      /\.table__clock-value--digits-3\s*\{[^}]*font-size:\s*\$ftl-font-clock-compact\s*;/.test(code),
      '三位秒必须降到 $ftl-font-clock-compact（18）',
    ).toBe(true);
    expect(code).toMatch(/seconds\s*>=\s*10\s*&&\s*seconds\s*<=\s*99/);
    expect(code).toMatch(/seconds\s*>=\s*100/);
  });
});

/**
 * ② 金币场（§14 / D7）：牌桌三座的余额 —— **服务端给了就显真值、没给整块不渲染**。
 *
 * 判别力两半：
 *  · 免费场（正对照）：`players[].balance` 从不出现 ⇒ 三座都没有货币位
 *    （走查修复：旧版三座恒「—」，一排破折号是噪音；不补 0、不编数）；
 *  · 金币场：`room.join` ack / `room.state_update` 的 `players[].balance` 到达 ⇒
 * 三座各显**自己的**那个数（DOM 顺序：左对手 → 右对手 → 我，取值按座位号核对，
 *    防「三座显同一个数」的假实现）。2026-10-12 逆时针座序起 mySeat=0 ⇒
 *    左对手 = 座2（上家）、右对手 = 座1（下家）。
 */
describe('② 金币场：座位余额（Seat 占位转真值；缺字段整块退场）', () => {
  it('免费场：三座都没有货币位；金币场的 players[].balance 到达 ⇒ 逐座显真值', async () => {
    const { wrapper, store } = mountTable();

    expect(
      wrapper.findAll('.seat__coin'),
      '免费场（服务端从不下发余额）⇒ 三座整块没有货币位（不是一排「—」）',
    ).toHaveLength(0);
    expect(wrapper.findAll('.seat__coin-value')).toHaveLength(0);

    // 金币场：join ack 与 state_update **同一个形状**（`buildRoomPlayers`）⇒ 这里直接走 store 的消费点
    store.applyRoomState({
      players: [
        { id: 'p0', seat: 0, balance: 111 },
        { id: 'p1', seat: 1, balance: 222 },
        { id: 'p2', seat: 2, balance: 333 },
      ],
    });
    await wrapper.vm.$nextTick();

    expect(
      wrapper.findAll('.seat__coin-value').map((t) => t.text()),
      'DOM 顺序 = 左对手上家(座2) / 右对手下家(座1) / 我(座0)',
    ).toEqual(['333', '222', '111']);
  });

  it('读失败（服务端省略该字段）⇒ 该座货币位整块消失，**不补 0**（其余座真值不受影响）', async () => {
    const { wrapper, store } = mountTable();
    store.applyRoomState({
      players: [
        { id: 'p0', seat: 0, balance: 111 },
        { id: 'p1', seat: 1 }, // 缺字段 = 这局没有这个座的真值
        { id: 'p2', seat: 2, balance: 333 },
      ],
    });
    await wrapper.vm.$nextTick();

    // 座1（右对手/下家）整块没有货币位；左对手上家(座2)=333、我(座0)=111 照常
    expect(wrapper.findAll('.seat__coin')).toHaveLength(2);
    expect(wrapper.findAll('.seat__coin-value').map((t) => t.text())).toEqual(['333', '111']);
  });
});

/**
 * 切片 8：叫抢 UI 的**接线**（§12 F01/F09/F10 + R107）。
 *
 * 判别力说明：这里**不**断言任何规则（倍数、谁能抢、几张牌），那些是服务端的；
 * 只断言三件事：
 *  ① 行动者取自服务端的 `bidPhase.currentBidder`（不是 `currentPlayer`）；
 *  ② 点击发 `game.bid` 且 `payload.grab` 正确；
 *  ③ 阶段互斥：叫抢阶段没有出牌/过牌按钮，出牌阶段没有抢/不抢按钮。
 * 第 ③ 条是真实缺陷面：旧模板两处都用 `.btn--primary` 裸选择器，
 * 任何样式/结构调整都会让「UI 走查」静默失配 —— 因此四个动作按钮钉上稳定 class（R107）。
 *
 * ⚠️ 夹具的真实约束（读 `helpers/fake-socket.ts` + `protocol/validate.ts` 之后收敛的，
 * 与计划 Task 5 Step 1 的两处写法有出入，见用例内注释）：
 *  1. `playerViewFixture(over)` 用 `{...默认, ...over}` 覆盖**顶层**字段，`bidPhase` **整体替换、不合并**
 *     ⇒ 每条用例都给出完整 `bidPhase`（只写 `{ currentBidder: 0 }` 会得到残缺对象）；
 *  2. `validateInbound` 逐张校验牌值（合法值只有 3–14 / 17 / 20 / 30）并强制
 *     `hand.length === cardCounts[seat]` ⇒ 计划里的 20 张手牌字面量含非法的 15/16，必须换掉；
 *  3. `game.bid` 是 **CAS 请求**（`CAS_MESSAGES`），ack `code 0` 之后串行队列要等到
 *     `game.state_update` 把 version 推过 `baseVersion` 才释放（M06/§6.5）
 *     ⇒ 「一次 mount 里连点两次」发不出第二个请求，真/假两个 grab 用两次独立 mount 断言。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { bidPhase } from './helpers/bid-phase';
import { FakeSocket, playerViewFixture, serverMessage, makeCards } from './helpers/fake-socket';
import { collectSourceFiles, stripComments } from './helpers/source-scan';
import {
  LOCAL_SCORING_TRACES,
  LOCAL_SCORING_TRACES_LEGACY,
  localScoringTraces,
} from './helpers/scoring-traces';

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
 * §12.4 的 MVP 形态（机械源码扫描）：找出「本地算分数/倍数」的痕迹。
 *
 * ⚠️ 只扫**牌桌模板**：`底分` 字样在 `lobby.vue` 是**直接展示服务端下发的字段**
 * （`room.baseScore`，合法；M09 禁的是**常量**与**本地计算**，不是展示服务端值）。
 *
 * 🔴 **两种形态、按文件维度选用（协议⑥ 起）**：规则表的**唯一定义**在
 * `helpers/scoring-traces.ts` —— B1 评审把原先这里的新形态 7 条与 `table-hud.test.ts`
 * 里的旧形态第二份副本**合流**成了一份（同一道闸不得有两种形态）。
 *   · `src/pages/table/table.vue` ⇒ `LOCAL_SCORING_TRACES`（**新形态**）：牌桌**必须**
 *     显示服务端下发的底分（片规格 §3.2），而那个数字只能来自 `view.baseScore`
 *     ⇒ 「底分」与 `baseScore` 本身不再是违规词，违规的是**凭空造数字**与**本地运算**；
 *   · **其余 10 个** `TABLE_AREA` 组件 ⇒ `LOCAL_SCORING_TRACES_LEGACY`（**旧形态** =
 *     新形态 ∪ 两条裸禁令**原样加回**）：它们**没有任何理由**出现「底分」或 `baseScore`
 *     （底分只显示在中央）—— 改形态时不带上它们会把这条闸**净变松**（B1 评审裁决）。
 * 规则逐条的来历（三条一个字不动 / 两条改形态 / 一条新增 / 误报面）写在 helper 的文件头。
 */

/**
 * 牌桌区组件清单（R659）：每新增一个牌桌组件，必须在这里 **+1**。
 *
 * 它是 R659 源码闸的扫描面（`table.vue` 走**新形态**、其余 10 个走**旧形态**，见
 * `helpers/scoring-traces.ts` 的「两种形态」）—— 不上清单的组件等于**静默漏扫**
 *（收敛前只扫 `table.vue`，新增组件后覆盖面反而更窄）。清单长度由
 * 「R659：牌桌区组件清单正好 N 个」那条用例**钉住**：少登记会红，多登记也会红。
 * ⚠️ U3（2026-09-21）：8 → **9**（新增 `Panel.vue`，见清单里的说明）。
 * ⚠️ B4（2026-09-28）：9 → **10**（新增 `MoreMenu.vue` —— D16 的二级弹层，
 *    四个恒灰按钮从顶栏收进它；见清单里的说明）。
 * ⚠️ 提示收敛 Task 3：10 → **11**（新增 `NoticeStack.vue` —— 统一提示浮层，
 *    后续迁移任务把它挂到牌桌；见清单里的说明）。
 *
 * ⚠️ 显式排除 `src/components/Settlement.vue`：它是**结算载荷**的展示面板，
 *    `底分/倍数` 在那里是**载荷字段名**（`SettlementResult.baseScore/multiplier`），
 *    与「牌桌模板本地推导」是两件事（➑ 另有「明细数字全部来自载荷」的独立判据）。
 */
const TABLE_AREA = [
  'src/pages/table/table.vue',
  // S5.2：斗地主 board（从 table.vue 迁出的玩法牌桌）—— 新增组件必须 +1。
  'src/components/table/ddz/DdzBoard.vue',
  // S6：跑得快 board 与结算面板（同样在牌桌区渲染，进同一张扫描面）。
  'src/components/table/pdk/PdkBoard.vue',
  'src/components/PdkSettlement.vue',
  'src/components/Seat.vue',
  'src/components/Card.vue', // ➌ 起它承载牌背（➍ 起承载牌面）
  'src/components/Hand.vue', // ➍：`sort` 只重排展示顺序（R662），顺带纳入同一张扫描面
  'src/components/PlayArea.vue', // ➎：出牌区（窗口 2 的一格：牌面 / 不出 / 归属指向）
  'src/components/BidPanel.vue', // ➏：叫抢面板（叫/抢两个锚点；文案随 kind。倍数展示 2026-10-11 第五轮已删）
  'src/components/BottomCards.vue', // ➏：底牌位（叫抢期 3 张牌背、零 data-value；翻开后牌面）
  'src/components/TableHud.vue', // ➐：HUD 状态条（倍数 / 炸弹**个数** / 房间；全部原样展示，零换算）
  // U3：9-slice 面板（§6.4）。本片它被 `Settlement.vue` 用作根元素，**且**是通用容器
  // ⇒ 按本条注释自己的规矩「牌桌区每新增一个组件必须 +1（不上清单 = 静默漏扫）」登记。
  // ⚠️ 与 `Settlement.vue` 的**显式排除**不冲突：那条排除的理由是「结算载荷的展示面板，
  //    底分/倍数在那里是载荷字段名」，而 `Panel` 是**无逻辑的容器**、将来也会被别处复用
  //    ⇒ 登记它只会**扩大**扫描面（安全方向），不会掩盖任何东西。
  'src/components/Panel.vue',
  // B4（2026-09-28 / D16）：二级弹层。按本条注释自己的规矩「牌桌区每新增一个组件必须 +1」登记。
  // ⚠️ 它**不读 store、不含任何规则**（哑组件：`open` prop + `close` 事件）⇒ 旧形态对它零命中，
  //    登记它是把**未来的**改动也罩进扫描面（片③ 之后还会有别的组件挂上牌桌）。
  'src/components/MoreMenu.vue',
  // 提示收敛 Task 3（2026-10-21）：统一提示浮层（`items`/`surface` + `dismiss` 事件，零计时器、
  // 零规则）。迁移任务会把它挂到牌桌 ⇒ 按同一条规矩登记（对旧形态零命中，登记是扩大扫描面）。
  'src/components/NoticeStack.vue',
];

/** R675 的违规形态：**本地计时器**（§9.6：UI 层不新造时钟）。 */
const TIMER_TRACES: RegExp[] = [/\bsetTimeout\s*\(/, /\bsetInterval\s*\(/];

function timerTraces(source: string): string[] {
  return TIMER_TRACES.filter((re) => re.test(source)).map((re) => String(re));
}

describe('table.vue 的叫抢 UI（§9.1 / R107）', () => {
  it('轮到别人叫抢时两个按钮**整个不渲染**（2026-10-13 真机走查：消失，不是 disabled）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 1 });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat: 1,
          /**
           * 判别力①（行动者来源）：`currentPlayer` 刻意落在**我**的座位上（1）。
           * 只有「叫抢阶段读 `bidPhase.currentBidder`」的实现才会把按钮藏掉；
           * 谁把它改回 `currentPlayer`（玩法 §9.1 明令禁止），这条用例立刻红。
           */
          currentPlayer: 1,
          bidPhase: bidPhase({ currentBidder: 0 }),
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(store.view?.currentPlayer).toBe(1); // 服务端说 currentPlayer 是我
    expect(store.actorSeat).toBe(0); // 但叫抢的行动者是座位 0（§9.1）
    expect(store.isMyTurn).toBe(false);

    /**
     * 判别力②（**消失，不是 disabled**）：2026-10-13 真机走查 —— 非我轮次时动作行仍渲染
     * 两颗灰按钮，与出牌相位的既有纪律（「不是我的回合 ⇒ 出牌/过牌按钮消失，不是 disabled」，
     * 见 `table-play-ui.test.ts:90` 与 2026-10-11 第三轮裁决）不一致。
     * 把门控改回「恒渲染 + disabled」的实现（哪怕 disabled 恒 true）在本条当场红。
     */
    expect(wrapper.find('.table__bid-grab').exists(), '非我轮次：抢/叫 按钮必须整个不存在').toBe(false);
    expect(wrapper.find('.table__bid-pass').exists(), '非我轮次：不抢/不叫 按钮必须整个不存在').toBe(false);
    // 正对照：行动行不空转 —— 等待态文案在场（与出牌相位等待态同款措辞）。
    // ⚠️ 选择器必须限定动作行：`.table__muted` 在底牌位还有一处（「底牌」标签），
    //    裸 `.table__muted` 会先命中它（实测报 '底牌'）。
    expect(wrapper.find('.table__action-bar .table__muted').text()).toBe('等待其他玩家…');
  });

  /**
   * 真 / 假两个 grab 各断言一次。
   *
   * ⚠️ 两次**独立 mount**（而不是「一次 mount 里连点两次」）：`game.bid` 是 CAS 请求，
   * ack `code 0` 之后 `finishRequest` 仍占着串行队列，直到 `game.state_update` 把 version
   * 推过 `baseVersion`（M06/§6.5）。第二次点击此刻既被 `busy` 拦住、也会被串行队列判 `blocked`
   * —— 计划里「ack 之后接着点第二个按钮」的写法在真实实现上发不出第二个请求。
   */
  it.each([
    { grab: true, seat: 1 },
    { grab: false, seat: 2 },
  ])('轮到我叫抢时可点，点击发 game.bid 且 payload.grab=$grab', async ({ grab, seat }) => {
    const { wrapper, socket, store } = mountTable({ mySeat: seat });
    socket.push(
      serverMessage(
        'game.deal',
        playerViewFixture({
          state: 'bidding',
          seat,
          // 反向判别力：currentPlayer 不是我，只有读 currentBidder 的实现才可点。
          currentPlayer: 0,
          bidPhase: bidPhase({ currentBidder: seat }),
        }),
        1,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(store.actorSeat).toBe(seat);
    expect(store.isMyTurn).toBe(true);

    const selector = grab ? '.table__bid-grab' : '.table__bid-pass';
    const button = wrapper.find(selector);
    expect(button.exists(), `${selector} 必须存在（R107）`).toBe(true);
    expect(button.attributes('disabled')).toBeUndefined();

    await button.trigger('click');

    const sent = socket.emittedOf('game.bid');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.env.payload).toEqual({ grab });
    // §6.5：CAS 请求的 baseVersion 必须是**已应用的快照版本**（刚收到的 game.deal = 1），
    // 不是 0、也不是别的猜测值 —— 否则服务端会按 CAS 拒绝每一次叫抢。
    expect(sent[0]!.env.baseVersion).toBe(1);
  });

  it('叫抢阶段不得出现出牌/过牌按钮，出牌阶段不得出现抢/不抢按钮（阶段互斥）', async () => {
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
        playerViewFixture({ state: 'playing', seat: 0, version: 2, landlordSeat: 1, currentPlayer: 0 }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__bid-grab').exists()).toBe(false);
    expect(wrapper.find('.table__bid-pass').exists()).toBe(false);
    expect(wrapper.find('.table__play').exists()).toBe(true);
    expect(wrapper.find('.table__pass').exists()).toBe(true);
  });

  it('模板里没有任何本地倍数/底分计算（§12 F02/F10 + M09）', async () => {
    const { wrapper, socket, store } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          seat: 0,
          version: 2,
          landlordSeat: 0,
          currentPlayer: 0,
          cardCounts: [20, 17, 17],
          // 合法牌值只有 3–14 / 17 / 20 / 30（`validateInbound` 逐张校验）+ `hand.length === cardCounts[seat]`。
          hand: makeCards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 17, 20, 20, 30, 30, 3, 5),
          bidPhase: bidPhase({ currentBidder: 0, bidMultiplier: 4, landlordCandidate: 0, grabActions: 3 }),
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    const text = wrapper.text();
    // 倍数只允许是服务端字段的原样展示（若模板要显示，必须直接绑 store 里的字段）；
    // 这里做**反向**断言：不得出现「×2 / x2」这类本地推导出来的倍数。
    expect(text).not.toMatch(/×\s*\d/);
    /**
     * 🔵 协议⑥ 起「底分」字样**合法**（牌桌必须显示服务端下发的底分，片规格 §3.2）
     * ⇒ 原来的 `not.toContain('底分')` 换形态：改成**正对照** ——
     * 服务端给了多少，页面上就必须真的出现**那个数字**
     *（判别力：把它藏起来、显示成别的数、或本地换算过的实现都会红）。
     */
    expect(text, '服务端给的底分必须真的出现在页面上（R659 改形态后的正对照）').toContain(
      `底分 ${store.view!.baseScore}`,
    );
    // 走查 P0-4：出牌期**大字场名退场**（不与中央出牌区争纵向空间），但承载底分的块仍在。
    expect(wrapper.find('.table__scene-name').exists(), '出牌期场名退场').toBe(false);
    expect(wrapper.find('.table__scene-base').text(), '底分一行出牌期保留（§3.2）').toBe(
      `底分 ${store.view!.baseScore}`,
    );

    /**
     * ⚠️ 只断言**渲染文本**没有判别力：旧模板同样不含这些字样，加不加 class 都过。
     * 因此再钉一条**机械源码扫描**（§12.4 的 MVP 形态）：一旦有人在牌桌模板里就地拼倍数/底分
     * （`{{ bidMultiplier * 2 }}`、`×2`、`底分 15`），即便当前渲染分支走不到，也会被拦下。
     */
    const table = collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(table, '源码扫描器必须真的读到 DdzBoard.vue').toBeDefined();
    // ⚠️ 违规类断言读**剥注释**视图（R572/R622，与紧随其后的 R659 全组件扫描同一口径）：
    //    判据（同一份正则）不变，只是不再把注释当代码 —— 否则「惩罚准确的注释」，
    //    解释一个禁词反而把闸打红（本片已被咬两次，注释被迫改写成绕口的说法）。
    expect(
      localScoringTraces(stripComments(table!.content)),
      'table.vue 的**代码**里出现了本地倍数/底分计算痕迹',
    ).toEqual([]);

    // 正对照：① 扫描器对合成样本确实报错（否则「什么也没扫到」可能只是它自己写错了）；
    // ② 剥注释视图**不认识**注释里写的同一段字面量（判据强度未放宽）。
    expect(localScoringTraces('{{ store.view.bidPhase.bidMultiplier * 2 }}')).toHaveLength(1);
    /**
     * 🔴 **钉住第 1 条（`/×\s*\d/`，控制回退；B1 评审 Important）**。
     *
     * 上面那条只证明「倍数的运算」被抓；改形态时原控制 `'<span>×2 底分</span>'`（长 2）
     * 被换掉后，**新样本群没有任何一条**会命中第 1 条 —— 把 `/×\s*\d/` 整条删掉，
     * 全套判据照样绿（B1 修复轮实测 M6：删掉它本行即红）。
     * 它正是「三条一个字不动、它们才是判别力所在」之一 ⇒ 必须有自己的控制。
     */
    expect(
      localScoringTraces('<span>×2</span>'),
      '「×N」那条必须有自己的正对照（否则删掉它全套判据还绿）',
    ).toHaveLength(1);
    /** 🔴 **顺手钉住第 7 条（`/Math\.pow\s*\(\s*2/`）**：它与第 1 条同类（base 时就没有控制，属既有欠账；M7）。 */
    expect(
      localScoringTraces('{{ Math.pow(2, n) }}'),
      '「2 的幂」那条必须有自己的正对照（既有欠账，B1 修复轮补）',
    ).toHaveLength(1);
    // ⚠️ 协议⑥ 之后违规形态是「**凭空造数字 / 本地声明 / 本地运算**」—— 逐条钉住
    //（上面那条只证明倍数的运算被抓，这几条证明底分那一半**换了形态、没有消失**）。
    expect(localScoringTraces('.x { content: "底分 15"; }')).toContain(
      '底分的**数值字面量**（服务端字段以外的数字）',
    );
    expect(localScoringTraces('const baseScore = 15;')).toContain('本地声明底分变量');
    expect(localScoringTraces('const n = baseScore * 3;')).toContain('对底分做本地运算');
    // ➕ 新增的那条的判别力自证：变量名**不叫** `baseScore` 也要报（这正是旧形态的洞）。
    expect(
      localScoringTraces('底分 {{ sceneBase * 2 }}'),
      '对服务端底分值算一遍的写法必须被拦下（哪怕变量名不叫 baseScore）',
    ).toContain('对底分**变量**做本地运算（如 `sceneBase * 2`）');
    expect(
      localScoringTraces('<text>{{ store.view?.bidPhase?.bidMultiplier ?? 0 }}</text>'),
      '原样引用服务端倍数字段不是违规形态（反向对照：证明上面几条不是「什么字符串都命中」）',
    ).toEqual([]);
    /**
     * 🔵 **反向对照（Task B1 新增）**：合法形态**一条都不许报** ——
     * 少了它，「改了形态」会**静默变成**「闸变松」。
     * 下面这段就是 `table.vue` 里本 Task 的真实写法（模板展示 + computed 读取各一行）。
     */
    const legal = `
      <text class="table__scene-base">底分 {{ sceneBase }}</text>
      const sceneBase = computed(() => store.view?.baseScore ?? null);
    `;
    expect(localScoringTraces(legal), '引用服务端底分字段是**合法**的').toEqual([]);
    expect(
      localScoringTraces(stripComments('// 注释：bidMultiplier * 2（解释性文字，不是代码）')),
      '剥注释视图必须把注释里的字面量抹掉（否则本条的「注释免税」是假的）',
    ).toEqual([]);
  });

  it('R659：牌桌区全部组件都不含本地算分/凭空造数痕迹（扫描面随组件增加而扩大；table.vue 走新形态、其余 9 个走旧形态）', () => {
    const sources = collectSourceFiles();
    for (const path of TABLE_AREA) {
      const file = sources.find((f) => f.path === path);
      expect(file, `${path} 必须在源码扫描集合里（否则本闸恒绿）`).toBeDefined();
      /**
       * 🔴 **文件维度（B1 评审裁决）**：协议⑥ 起豁免 `table.vue`（它**必须**显示底分）⇒
       * 2026-10 C 方案起**新增豁免** `Seat.vue`（免费场底分占位，牌桌左下角）。
       * 这两个走**新形态**；其余 9 个组件没有任何理由出现「底分」/`baseScore`
       * ⇒ 走**旧形态**（新形态 ∪ 两条裸禁令，是超集不是回退）。
       */
      const rules =
        path === 'src/pages/table/table.vue' ||
        path === 'src/components/Seat.vue' ||
        path === 'src/components/table/ddz/DdzBoard.vue' ||
        path === 'src/components/table/pdk/PdkBoard.vue' ||
        path === 'src/components/PdkSettlement.vue'
          ? LOCAL_SCORING_TRACES
          : LOCAL_SCORING_TRACES_LEGACY;
      // ⚠️ 违规类断言读**剥注释**视图（R572/R622）：让解释一个禁词的注释不会把闸打红。
      expect(
        localScoringTraces(stripComments(file!.content), rules),
        `${path} 出现本地算分/凭空造数痕迹`,
      ).toEqual([]);
    }
  });

  it('R659：牌桌区组件清单正好 14 个（新增组件必须显式登记，否则闸会静默漏扫）', () => {
    expect(TABLE_AREA).toHaveLength(14);
    expect(TABLE_AREA).toContain('src/components/TableHud.vue'); // 本 Task 刚加的那个在清单里
    // ⚠️ B4（D16）：**只钉长度是不够的** —— 「减一个旧的、加一个新的」也能凑够 14，
    // 而那样新组件根本没进扫描面。⇒ 本片刚加的那个必须**按名字**钉住。
    expect(TABLE_AREA).toContain('src/components/MoreMenu.vue');
    // 提示收敛 Task 3：新登记的浮层同样按名字钉住（防「凑数」）。
    expect(TABLE_AREA).toContain('src/components/NoticeStack.vue');
    expect(TABLE_AREA).not.toContain('src/components/Settlement.vue'); // 显式排除（理由见清单注释）
    // 清单（14）：table.vue · Seat.vue · Card.vue · Hand.vue · PlayArea.vue · BidPanel.vue ·
    //            BottomCards.vue · TableHud.vue · Panel.vue · MoreMenu.vue · NoticeStack.vue
  });

  /**
   * **R675（协调者新增）**：§9.6「倒计时不得在 UI 层新造时钟」。
   *
   * 牌桌区**全部 14 个源文件**（含页面 `table.vue`）都不得自带 `setTimeout`/`setInterval`。
   * 页面唯一被允许的时钟是 `composables/useCountdown`——它**不在 `TABLE_AREA` 上**
   *（本闸的扫描面是牌桌区，不是整个 `src/**`），由 `table.vue` **消费**；
   * 消费者自己也**不得**另起一个计时器（➎ 的过牌气泡就是按这条把「本地计时器」
   * 换成「下一版快照到达即清」的）。
   *
   * ⚠️ **F2 订正（评审 Minor）：`table.vue` 必须留在扫描面里。** 首版把它排除、
   * 理由写成「它是消费倒计时的地方」—— 那条理由**不成立**：本闸读的是**剥注释视图**
   *（`helpers/source-scan.ts` 的 `stripComments`），而 `table.vue` 里那几处提及
   *（`useCountdown` 的调用、以及「不引入任何本地计时器」的 JSDoc）**全部落在注释里**，
   * 剥完实测 **0 命中**。排除它只会让「在 `table.vue` 里写一个裸 `setInterval`」逃过本闸。
   */
  it('R675：牌桌区全部 14 个文件（含 table.vue）都不得自带 setTimeout/setInterval（§9.6；+ 正对照）', () => {
    expect(TABLE_AREA, 'R675 的扫描面 = 牌桌区全部文件（含消费倒计时的 table.vue）').toHaveLength(14);

    const sources = collectSourceFiles();
    for (const path of TABLE_AREA) {
      const file = sources.find((f) => f.path === path);
      expect(file, `${path} 必须在源码扫描集合里（否则本闸恒绿）`).toBeDefined();
      // 违规类断言读剥注释视图（R572/R622）：`table.vue` 与 `Seat.vue` 的注释都**点名**了
      // 这两个 API（那是「解释为什么不用它」的文档），按原始文本匹配会把解释本身打红。
      expect(timerTraces(stripComments(file!.content)), `${path} 出现了本地计时器（§9.6）`).toEqual([]);
    }

    // 正对照：合成样本必须被同一组正则报出 —— 否则「一条都没扫到」可能只是闸自己写错了。
    expect(timerTraces('setInterval(() => { tick(); }, 250);')).toHaveLength(1);
    expect(timerTraces('const t = setTimeout(go, 1000);')).toHaveLength(1);
    // 反向对照：干净样本一条都不报（证明上面两条不是「什么字符串都命中」）
    expect(timerTraces('const x = hand.length;')).toEqual([]);
  });
});

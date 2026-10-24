/**
 * 切片 10 / Task F1：结算页的**接线**（R188）。
 *
 * 判别力说明（这里**不**断言任何规则，一个数都不算）：
 *  ① 六个数字/文本字段**逐字**等于服务端载荷 —— 夹具刻意用「算不出来」的数：
 *     `multiplier: 4` + `baseScore: 100` 若前端偷偷自行结算，地主变动会是 `800`，
 *     而载荷给的是 `777`（分数仍守恒：`777 + (-388.5 × 2) === 0`，因此过得了
 *     `validateInbound` 的守恒不变式）。前端一旦介入算术，这条立刻红（§12.1 F02/F10）。
 *  ② `spring` 三态的**展示文案**映射（`none|spring|anti-spring` → 中文）——
 *     这是枚举到文案的翻译，不是规则判断；键集少一个就会渲染出 `undefined`。
 *  ③ `table.vue` 只在 `store.settlement` 非 null 时渲染结算（M07：不得预判胜负）：
 *     只喂 `game.finished` 不得出现结算面板。
 *
 * ⚠️ 夹具约束（读 `helpers/fake-socket.ts` 后收敛的，与 `table-play-ui.test.ts` 同款）：
 *  - `playerViewFixture` 只做**顶层**覆盖；`game.settlement` 的载荷必须**分数守恒**，
 *    否则 `validateInbound` 会先抛（协议层拦截，根本到不了 UI）。
 *  - 结算块在 `table.vue` 的 `v-else`（`waitingForDeal === false`）内，因此必须先喂一条
 *    `game.state_update` 让 `store.view` 就位。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PlayerView, DdzSettlementResult } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import {
  __resetSettlementRevealDelayForTest,
  __setSettlementRevealDelayForTest,
} from '../src/composables/settlementRevealDelay';
import { __resetSettlementRevealArrivalsForTest } from '../src/composables/useSettlementReveal';
import Settlement from '../src/components/Settlement.vue';
import TablePage from '../src/pages/table/table.vue';
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
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  stopGameSession();
});

/**
 * 夹具的分数**刻意与「自己算一遍」的答案不一致**：`100 × 4 × 2 = 800 ≠ 777`。
 * 守恒不变式仍然成立（`777 + (-388.5 × 2) === 0`），所以它能合法地过 `validateInbound`。
 */
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

function playingView(over: Partial<PlayerView> = {}): PlayerView {
  return playerViewFixture({
    state: 'playing',
    version: 2,
    landlordSeat: 0,
    bottomCards: makeCards(3, 4, 5),
    ...over,
  });
}

function mountTable(mySeat = 0) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', mySeat);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket, store };
}

/** 结算载荷夹具（顶层覆盖；默认仍是**非乘积**的 `777`）。 */
function defaultSettlement(over: Partial<DdzSettlementResult> = {}): DdzSettlementResult {
  return { ...FIXTURE, ...over };
}

/**
 * 直接 mount `Settlement`（➑ 的脚手架）。
 *
 * `wd-*` 有预设替身（`test/setup/uni-easycom.ts`），替身把自定义 class 透传到根元素 ⇒
 * 断言可以落在真实渲染出的 class 上。`afterEach` 会统一 unmount（`mounted` 数组）。
 */
function mountSettlement(over: Partial<DdzSettlementResult> = {}): VueWrapper {
  const w = mount(Settlement, { props: { settlement: defaultSettlement(over) } });
  mounted.push(w);
  return w;
}

describe('Settlement.vue（§12.1 F02：只展示服务端下发的值，零计算）', () => {
  it('六个数字/文本字段逐字渲染服务端载荷（含刻意的「算不出来」的 777）', () => {
    const w = mount(Settlement, { props: { settlement: FIXTURE } });
    mounted.push(w);

    /**
     * Task 2（P10）改锚点：`Settlement.vue` 的根从原生 `div` 换成了 `wd-card`
     * （easycom；自定义 class 由 Vue 的 attrs 继承落到**渲染后的根元素**上）。
     * 对**组件包装器**调 `classes()` 拿到的是组件自身的 class（现在是空数组），
     * 因此改成断言「渲染后的根元素带着这个 class」—— 判据不变：稳定锚点仍在 DOM 根上。
     */
    expect(w.find('.table__settlement').classes()).toContain('table__settlement');
    // 走查修复：调试期两个英文/裸值 wd-tag 已删（胜方与春天改由标题、公式行承载）。
    expect(w.find('.settlement__tags').exists(), '旧的 wd-tag 行已删除').toBe(false);
    expect(w.find('.settlement__winner').exists()).toBe(false);
    expect(w.find('.settlement__spring').exists()).toBe(false);
    expect(w.text(), '玩家可见文本里不得泄漏裸枚举 landlord').not.toContain('landlord');
    /**
     * ⚠️ **片② 表格化（R737）：这四个字段现在是表格单元格里的「裸值」**，标签由表头承担
     * （参考图二的形态：表头写「倍数」，格子里只写 `4`）。**判据强度不变** ——
     * 仍然是「逐字等于服务端载荷」，只是不再带「倍数：」前缀。
     */
    expect(w.get('.settlement__multiplier').text()).toBe('4');
    expect(w.get('.settlement__base-score').text()).toBe('100');
    // 走查修复：「地主座位/农民座位」原始字段行已删（角色在三行徽章里，座位号不再念给玩家听）。
    expect(w.find('.settlement__meta').exists()).toBe(false);
    expect(w.find('.settlement__landlord-seat').exists()).toBe(false);
    expect(w.find('.settlement__farmer-seats').exists()).toBe(false);
    expect(w.get('.settlement__landlord-delta').text()).toBe('777');
    expect(w.get('.settlement__farmer-delta').text()).toBe('-388.5');

    // 判别力：若前端自行按 100 × 4 × 2 计算，这里会是 800
    expect(w.get('.settlement__landlord-delta').text()).not.toContain('800');

    // 没有房间信息（mySeat === null）⇒ 标题回退为不带人称的胜方文案（不猜「我」是谁）
    expect(w.get('.settlement__headline').text()).toBe('地主胜');

    // 表头（参考图二：昵称 / 底分 / 倍数 / 分差）—— 标签住在表头，值住在格子里
    expect(w.findAll('.settlement__th').map((h) => h.text())).toEqual(['昵称', '底分', '倍数', '分差']);
  });

  it.each([
    ['none', ''],
    ['spring', '春天 春天'],
    ['anti-spring', '春天 反春天'],
  ] as const)(
    'spring=%s 公式行的春天片段（none 整段不提；其余枚举→文案），旧 wd-tag 不复活',
    (spring, fragment) => {
      const w = mount(Settlement, { props: { settlement: { ...FIXTURE, spring } } });
      mounted.push(w);
      expect(w.find('.settlement__tags').exists(), '旧的 wd-tag 行已删除').toBe(false);
      const formula = w.get('.settlement__formula').text();
      if (fragment === '') {
        // 走查修复：没有春天的局不再自说自话「春天 无」。
        expect(formula).not.toContain('春天');
      } else {
        expect(formula).toContain(fragment);
      }
    },
  );

  /**
   * ➑ 新增：胜负标题 + 三家分数行 + 载荷构成明细（R658）。
   *
   * 判别力就在这里：夹具体的三个数字**乘不出来**（`100 · 4 = 400`，而载荷给的是 `777`），
   * 因此只要面板里出现 `400`，就说明有人在前端自行结算了 —— 而 `底分 100` 与 `倍数 4`
   * 又必须**逐字**出现在明细里（否则这条会因为「什么都没渲染」而假绿）。
   */
  it('➑ 明细与三家分数行：数字**全部来自载荷**（用非乘积夹具证明不是前端自算）；当前玩家行高亮', () => {
    /**
     * ⚠️ 片② 新增：**高亮行 = 身份映射**（R737）——`mySeat` 与行的座位号对上，
     * **不是**结果推导（谁赢由服务端 `winner` 说了算，本组件一个数都不算）。
     * 这里把 `mySeat` 设成 **2**（= 夹具的 `landlordSeat`）⇒ 高亮的必须是**地主那一行**，
     * 证明它认的是**座位号**而不是角色。
     */
    useGameStore().setRoom('ROOM1', 2);
    const w = mountSettlement({ baseScore: 100, multiplier: 4, landlordScoreChange: 777, farmerScoreChange: -388.5 });
    // 标题讲「我」的输赢与「我」的分差（夹具 mySeat=2 = 地主座，winner=landlord ⇒ 赢；777 原文）
    expect(w.get('.settlement__headline').text().replace(/\s+/g, '')).toBe('你赢了777');
    expect(w.get('.settlement__formula').text()).toContain('底分 100');
    expect(w.get('.settlement__formula').text()).toContain('倍数 4');
    expect(w.get('.settlement__formula').text()).toContain('春天 春天');
    const rows = w.findAll('.settlement__row');
    expect(rows).toHaveLength(3); // 地主 1 + 农民 2
    expect(rows.map((r) => r.text()).join(' | ')).toContain('777');
    expect(rows.map((r) => r.text()).join(' | ')).toContain('-388.5');
    expect(w.text(), '不得出现「底分 乘 倍数」的乘积（那是前端自算）').not.toContain('400');

    // 行名：我 = 「我」，其余 = 「玩家N」（行序：地主座 2 → 农民座 0、1）
    expect(w.findAll('.settlement__row-name').map((n) => n.text())).toEqual(['我', '玩家0', '玩家1']);
    expect(w.text(), '不再有调试腔的「座位 N」行名').not.toContain('座位 2');
    // 高亮：**恰好一行**，且是座位 2（地主）那一行
    const mine = w.findAll('.settlement__row--me');
    expect(mine, '必须恰好高亮一行').toHaveLength(1);
    expect(mine[0]!.get('.settlement__row-name').text(), '高亮的是座位号 2 那一行（不是按角色）').toBe('我');
    expect(mine[0]!.classes(), '高亮行同时保留它的角色底色').toContain('settlement__row--landlord');

    expect(w.find('.settlement__again').exists()).toBe(true);
    expect(w.find('.settlement__lobby').exists()).toBe(true);
  });

  it('结算行名优先用座位昵称，缺省回落「玩家N」', () => {
    useGameStore().setRoom('ROOM1', 2);
    useGameStore().applyRoomState({
      players: [
        { id: 'p0', seat: 0, nickname: '阿豆' },
        { id: 'p1', seat: 1 },
        { id: 'p2', seat: 2, nickname: '我本名' },
      ],
    });
    const w = mountSettlement();
    // 行序：地主座 2 → 农民座 0、1；自己那行恒「我」
    expect(w.findAll('.settlement__row-name').map((n) => n.text())).toEqual(['我', '阿豆', '玩家1']);
  });

  /**
   * 高亮的**反面对照**（片② / R737）：`mySeat` 是**农民**时，高亮的必须是农民那一行。
   * ⚠️ 没有这一条，「高亮」就有可能是写死的（恒高亮第一行也会让上面那条通过）。
   */
  it('高亮跟随 `mySeat`（反面：mySeat=1 是农民 ⇒ 高亮农民行，不是地主行）；标题讲我的输赢', () => {
    useGameStore().setRoom('ROOM1', 1);
    const w = mountSettlement();
    // winner=landlord、我是农民 ⇒ 我输了；分差取**农民那一份**载荷原文（-388.5）
    expect(w.get('.settlement__headline').text().replace(/\s+/g, '')).toBe('你输了-388.5');
    const mine = w.findAll('.settlement__row--me');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.classes()).toContain('settlement__row--farmer');
    expect(mine[0]!.get('.settlement__row-name').text()).toBe('我');
    // 行序是地主（玩家2）→ 农民数组原序（座 0、座 1）；我（座 1）在**第三行**
    expect(w.findAll('.settlement__row-name').map((n) => n.text())).toEqual(['玩家2', '玩家0', '我']);
  });

  /**
   * ⚠️ **不确定就不高亮**：`mySeat` 为 `null`（没有房间信息）时一行都不高亮 ——
   * 宁可不高亮，也不要高亮错行（那是在展示错误信息）。
   */
  it('`mySeat` 缺失时不高亮任何行（宁可不亮，也不亮错）；标题回退胜方文案、行名用玩家N', () => {
    const w = mountSettlement();
    expect(useGameStore().mySeat).toBeNull();
    expect(w.findAll('.settlement__row--me')).toHaveLength(0);
    expect(w.findAll('.settlement__row')).toHaveLength(3); // 正对照：三行本身还在
    expect(w.get('.settlement__headline').text(), '没有「我」的信息 ⇒ 只说哪边赢').toBe('地主胜');
    expect(w.findAll('.settlement__row-name').map((n) => n.text())).toEqual([
      '玩家2',
      '玩家0',
      '玩家1',
    ]);
  });

  /**
   * 绶带标题带（B5 / 片③ spec §3.5）：`jujsidai.png` 走**新增的第 8 个素材槽**
   * `$ftl-art-settlement-ribbon`。两条性质：
   *
   *  ① **素材只做底**：文字仍由 DOM 画（art brief §0 的总则：「素材只做底 / 框 / 图标，
   *     **一个字都不要画**」；实测 `jujsidai.png` 是纯绶带、无字）⇒「结算」两个字必须在
   *     `.settlement__ribbon` **里面**、由 `.settlement__title` 渲染 —— 若有人把标题换成
   *     贴图画的字（或把 `__title` 挪出绶带），这条当场红；
   *  ② **槽位真的接上了**：`.settlement__ribbon` 的规则里逐字写着
   *     `border-image: $ftl-art-settlement-ribbon …`。
   *     ⚠️ **机制由 `background-image` 换成 `border-image`**（2026-09-29 用户裁决：整图拉伸
   *     会把两端卷曲翼压扁 ⇒ 改九宫格）—— 本半条**判据不变、形态随裁决更新**：
   *     仍钉「槽位令牌真的出现在本规则里」（写成字面 `url('/static/ui/…')` 会被
   *     `art-slots` 的「用了槽位就不得再写字面路径」闸抓住；而**整个不写**没有别的闸
   *     看得见 ⇒ 只能由这条钉住）。四个切片参数的**齐备性**由下面那条 9-slice 用例承担。
   *
   * ⚠️ 槽挂 `Settlement.vue`、**不挂 `Panel.vue`** 这一半，由 `art-slots.test.ts` 的
   * **按文件**规则钉住（`Panel.vue` 里有 `panel-*.png` 字面路径 ⇒ 挂过去当场红），
   * 是本任务变异自证的一格（报告 M-B5-3）。
   */
  it('绶带标题带（B5）：素材只做底、文字仍由 DOM 画；且槽位真的接在本组件上', () => {
    const w = mountSettlement();
    expect(w.find('.settlement__ribbon').exists(), '绶带是标题带的容器').toBe(true);
    // ① 文字在绶带**里面**、由 DOM 渲染（不是贴图画的字）
    expect(w.get('.settlement__ribbon .settlement__title').text()).toBe('结算');

    // ② 源码级：`.settlement__ribbon` 的规则用**槽位令牌**（不是字面路径、也不是没接）。
    //    读剥注释视图（R572：解释里逐字写出令牌名不算实现）。
    const settlementSrc = stripComments(
      collectSourceFiles().find((f) => f.path === 'src/components/Settlement.vue')!.content,
    );
    expect(
      /\.settlement__ribbon\b[^{]*\{[^}]*border-image\s*:\s*\$ftl-art-settlement-ribbon\b/.test(
        settlementSrc,
      ),
      '绶带必须走 $ftl-art-settlement-ribbon 槽位（换素材只改 uni.scss 一行）',
    ).toBe(true);
  });

  /**
   * 绶带 9-slice（2026-09-29 用户裁决；形态照 `Panel.vue` 的 `$ftl-panel-slice` 先例）。
   *
   * **为什么必须有这条闸**：`border-image` 的四个参数**缺一就静默退化成「一张被拉伸的图」**
   * ——不报错、页面照常显示，而「拉伸」正是这次裁决要消灭的观感（卷曲端拉歪）。
   * 判据**按字面**匹配源码（与 `panel.test.ts` 同款形态），并做过变异自证（见 B6-fix 报告）。
   *
   * 五个断言各拦一类真实回归：
   *  · 源图 + 切片四数：删掉任一数 / 换成字面路径 / 退回 `background-image` ⇒ 红；
   *  · `fill`：不写 ⇒ 中心（padding box）变空洞（透出面板底色）；
   *  · `stretch`：不写退回初始值 `stretch` 之外的东西（如 `repeat`）由这条钉住；
   *  · `border-width` 走令牌：改成字面量 ⇒ 红（保留「源图像素 vs 渲染尺寸是两个量」的接口）；
   *  · `background-clip: padding-box`：删掉 ⇒ 兜底橙底会从素材透明处透出（实测截图证明）。
   */
  it('绶带 9-slice：四个参数在源码里齐备（缺一就静默退化成拉伸图）', () => {
    const settlementSrc = stripComments(
      collectSourceFiles().find((f) => f.path === 'src/components/Settlement.vue')!.content,
    );
    const rule = /\.settlement__ribbon\b[^{]*\{([^}]*)\}/.exec(settlementSrc)?.[1] ?? '';
    // 射程自证：断言全部锚在这条规则块上（块没抓到 ⇒ 下面逐条红，而不是空跑绿）。
    expect(rule.length, 'Settlement.vue 里必须有 .settlement__ribbon 的规则块').toBeGreaterThan(0);

    expect(rule, '源图 + 切片四个数（无单位 = **源图像素**）').toMatch(
      /border-image:\s*\$ftl-art-settlement-ribbon\s+\d+\s+\d+\s+\d+\s+\d+/,
    );
    expect(rule, 'fill：保留中心区域（否则 padding box 是空洞）').toMatch(/\b\d+\s+fill\b/);
    expect(rule, 'repeat：显式写死 stretch（不写就不是这次的形态）').toMatch(/\bstretch\b/);
    expect(rule, 'width：渲染尺寸走令牌（与源图像素是**两个量**）').toMatch(
      /border-width:\s*[^;]*\$ftl-ribbon-slice-x[^;]*;/,
    );
    expect(rule, 'border 区必须有宽度（style: solid；none 时 border-image 整个不画）').toMatch(
      /border-style:\s*solid\b/,
    );
    expect(rule, '兜底橙底必须被裁到 padding box（否则从素材透明处透出）').toMatch(
      /background-clip:\s*padding-box/,
    );
    expect(rule, '旧形态不得回来：整图拉伸 100% 100%（用户裁决要消灭的=压扁卷曲端）').not.toMatch(
      /background-size\s*:\s*100%\s+100%/,
    );
    expect(rule, '兜底：实色底仍在（R693：素材缺失不许白屏）').toMatch(
      /background(-color)?:\s*\$ftl-color-/,
    );
  });
});

describe('table.vue 接结算页（M07：只由 game.settlement 驱动）', () => {
  it('未收到 game.settlement 时没有结算面板；只喂 game.finished 也不预判（M07）', async () => {
    const { wrapper, socket, store } = mountTable(0);
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    expect(store.settlement).toBeNull();
    expect(wrapper.find('.table__settlement').exists()).toBe(false);

    socket.push(serverMessage('game.finished', { winner: 'landlord' }, 3));
    await wrapper.vm.$nextTick();

    expect(store.finished).toEqual({ winner: 'landlord' });
    expect(wrapper.find('.table__settlement').exists(), '结算面板只由 game.settlement 驱动').toBe(
      false,
    );
  });

  it('收到 game.settlement ⇒ 渲染 .table__settlement 且数字逐字来自载荷（正对照）', async () => {
    const { wrapper, socket, store } = mountTable(0);
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.table__settlement').exists()).toBe(false); // 探针起点：此刻确实不存在

    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await wrapper.vm.$nextTick();

    expect(store.settlement).not.toBeNull();
    expect(wrapper.find('.table__settlement').exists()).toBe(true);
    // ⚠️ 表格化后 `__landlord-delta` 是格子里的裸值（R737）。
    expect(wrapper.get('.settlement__landlord-delta').text()).toBe('777');
    // 走查修复：旧的「农民座位：0、1」调试字段行不再渲染；
    // 端到端下 mySeat=0（农民、败方）⇒ 标题是「你输了 -388.5」（分差取农民那份载荷原文）。
    expect(wrapper.find('.settlement__meta').exists()).toBe(false);
    expect(wrapper.get('.settlement__headline').text().replace(/\s+/g, '')).toBe('你输了-388.5');
  });
});

/**
 * ② 金币场（§14）：结算页**金币列**的三态。
 *
 * 判别矩阵（每一格对应一种「最像正确答案」的错实现）：
 *  ① **免费场不加列**：服务端从不下发余额 ⇒ 整列（含表头格）不存在
 *     —— 拦「永远加一列空壳」；
 *  ② **到达 ⇒ 显值**：`game.balances` 的**该座**数字（行序：地主 → 农民，按座位取值
 *     —— 拦「三行显同一个数」）；且我那一座**本地更新余额 chip**（§14 逐字）；
 *  ③ **5s 未达 ⇒ 定格「—」**：不得永久「结算中…」（假时钟推 5000ms）；
 *  ④ **迟到仍是真值**：定格之后消息到达仍切成值（值优先于「—」——outbox 补偿
 *     后的重发也是服务端真值）。
 *
 * 端到端那条走**生产会话**（`socket.push` → `messageTypeList` → `validateInbound` →
 * session 分流 → store → UI）：`net/socket.ts` 的接收表少一条 `game.balances`
 * 就是给它准备的（消息到达但无源 ⇒ 本用例红）。
 */
describe('② 结算页金币列三态（game.balances / 5s 定格 / 免费场不加列）', () => {
  it('🔴 免费场（服务端从不下发余额）⇒ 不加列：表头恰 4 格、无金币格', () => {
    const w = mountSettlement();
    expect(w.findAll('.settlement__th').map((h) => h.text())).toEqual(['昵称', '底分', '倍数', '分差']);
    expect(w.find('.settlement__gold').exists(), '免费场整列不存在（不是空壳列）').toBe(false);
  });

  it('端到端（socket 推送走生产会话）：未达 ⇒「结算中…」；game.balances 到达 ⇒ 逐座显值 + 刷余额 chip', async () => {
    const { wrapper, socket, store } = mountTable(0);
    // 前置：金币场（join ack / state_update 的 players[].balance 先到）⇒ 列「存在」
    store.applyRoomState({
      players: [
        { id: 'p0', seat: 0, balance: 1000 },
        { id: 'p1', seat: 1, balance: 2000 },
        { id: 'p2', seat: 2, balance: 3000 },
      ],
    });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
    await wrapper.vm.$nextTick();

    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await wrapper.vm.$nextTick();

    expect(
      wrapper.findAll('.settlement__gold').map((t) => t.text()),
      '这条消息未到 ⇒ 三行「结算中…」（不是 —、不是空）',
    ).toEqual(['结算中…', '结算中…', '结算中…']);

    socket.push(
      serverMessage(
        'game.balances',
        {
          balances: [
            { seat: 0, balance: 111 },
            { seat: 1, balance: 222 },
            { seat: 2, balance: 333 },
          ],
        },
        3,
      ),
    );
    await wrapper.vm.$nextTick();

    expect(store.settlementBalances, 'store 接收（net/session 分流接线）').toEqual({
      0: 111,
      1: 222,
      2: 333,
    });
    expect(store.walletBalance, '§14：我那一座本地更新余额 chip').toBe(111);
    expect(
      wrapper.findAll('.settlement__gold').map((t) => t.text()),
      '行序：地主（座 2）→ 农民（座 0、座 1），各取**自己**那个数',
    ).toEqual(['333', '111', '222']);
  });

  it('🔴 5s 未达 ⇒ 定格「—」（不永久「结算中…」）；迟到到达仍切成真值', async () => {
    vi.useFakeTimers();
    try {
      const store = useGameStore();
      store.setRoom('ROOM1', 0);
      store.applyRoomState({
        players: [
          { id: 'p0', seat: 0, balance: 10 },
          { id: 'p1', seat: 1, balance: 20 },
          { id: 'p2', seat: 2, balance: 30 },
        ],
      });

      const w = mountSettlement();
      expect(w.findAll('.settlement__gold').map((t) => t.text())).toEqual([
        '结算中…',
        '结算中…',
        '结算中…',
      ]);

      vi.advanceTimersByTime(5000);
      await w.vm.$nextTick();

      expect(w.findAll('.settlement__gold').map((t) => t.text()), '5s 到点 ⇒ 定格「—」').toEqual([
        '—',
        '—',
        '—',
      ]);
      expect(w.text(), '整页不得再出现「结算中」').not.toContain('结算中');

      // 迟到的「结算时刻余额」仍是服务端真值 ⇒ 值优先于「—」
      store.applyBalances({
        balances: [
          { seat: 0, balance: 11 },
          { seat: 1, balance: 22 },
          { seat: 2, balance: 33 },
        ],
      });
      await w.vm.$nextTick();
      expect(w.findAll('.settlement__gold').map((t) => t.text())).toEqual(['33', '11', '22']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('结算延迟片：金币列 5s 绝对契约', () => {
  it('延迟揭示不拖长金币兜底：settlement t=0，面板 t=2s 挂载，总计 5s 定格', async () => {
    vi.useFakeTimers();
    __resetSettlementRevealDelayForTest();
    __resetSettlementRevealArrivalsForTest();
    try {
      const { wrapper, socket, store } = mountTable(0);
      store.applyRoomState({
        players: [
          { id: 'p0', seat: 0, balance: 1000 },
          { id: 'p1', seat: 1, balance: 2000 },
          { id: 'p2', seat: 2, balance: 3000 },
        ],
      });
      socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
      await wrapper.vm.$nextTick();
      socket.push(serverMessage('game.settlement', FIXTURE, 3));
      await wrapper.vm.$nextTick();

      vi.advanceTimersByTime(2000);
      await wrapper.vm.$nextTick();
      expect(wrapper.findAll('.settlement__gold').map((t) => t.text())).toEqual([
        '结算中…', '结算中…', '结算中…',
      ]);

      vi.advanceTimersByTime(2999);
      await wrapper.vm.$nextTick();
      expect(wrapper.findAll('.settlement__gold').map((t) => t.text())).toEqual([
        '结算中…', '结算中…', '结算中…',
      ]);

      vi.advanceTimersByTime(1);
      await wrapper.vm.$nextTick();
      expect(wrapper.findAll('.settlement__gold').map((t) => t.text())).toEqual(['—', '—', '—']);
    } finally {
      vi.useRealTimers();
      __setSettlementRevealDelayForTest(0);
    }
  });

  it('延迟窗口内 balances 到达 ⇒ 面板挂载即显真值，不出现「结算中…」', async () => {
    vi.useFakeTimers();
    __resetSettlementRevealDelayForTest();
    __resetSettlementRevealArrivalsForTest();
    try {
      const { wrapper, socket, store } = mountTable(0);
      store.applyRoomState({
        players: [
          { id: 'p0', seat: 0, balance: 1000 },
          { id: 'p1', seat: 1, balance: 2000 },
          { id: 'p2', seat: 2, balance: 3000 },
        ],
      });
      socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0 }), 2));
      await wrapper.vm.$nextTick();
      socket.push(serverMessage('game.settlement', FIXTURE, 3));
      await wrapper.vm.$nextTick();

      vi.advanceTimersByTime(1000);
      await wrapper.vm.$nextTick();
      socket.push(
        serverMessage(
          'game.balances',
          {
            balances: [
              { seat: 0, balance: 111 },
              { seat: 1, balance: 222 },
              { seat: 2, balance: 333 },
            ],
          },
          3,
        ),
      );
      await wrapper.vm.$nextTick();

      vi.advanceTimersByTime(1000);
      await wrapper.vm.$nextTick();
      expect(wrapper.findAll('.settlement__gold').map((t) => t.text())).toEqual([
        '333', '111', '222',
      ]);
    } finally {
      vi.useRealTimers();
      __setSettlementRevealDelayForTest(0);
    }
  });
});

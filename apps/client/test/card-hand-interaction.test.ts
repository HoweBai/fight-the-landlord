/**
 * ➍ 卡牌与手牌交互（spec §5-➍ + R655/R662 + F10）。
 *
 * 判据四组：
 *  ① 牌面只来自 `toDisplay`（源码级：不得自制点数映射 —— 与既有 source-boundary 同向，这里补**组件级**断言）；
 *  ② 牌背：无文字、无 `data-value`、不可交互；
 *  ③ 排序是**展示顺序**：排序后点击「第 k 张」仍然作用于**同一个牌实例**（N18 回归），
 *     同点数的 4 张牌都能全部选中；
 *  ④ 组件缺省 `sort='none'` ⇒ 顺序与 `cards` 一致；**页面层**自 2026-10-10 起恒降序
 *     （理牌三按钮已按用户裁决删除）。
 *
 * ⚠️ 夹具约束（同 `table-play-ui`，读 `helpers/fake-socket.ts` + `protocol/validate.ts` 后收敛的）：
 *  1. `playerViewFixture` 只做**顶层**覆盖（`bidPhase` 这类嵌套对象必须整份给出）；
 *  2. `validateInbound` 逐张校验牌值（只允许 3–14 / 17 / 20 / 30）且强制 `hand.length === cardCounts[seat]`。
 *
 * ⚠️ `useCountdown` 在页面挂载时就起了 250ms 的 `setInterval` ⇒ `afterEach` 必须 unmount，
 *    否则本文件会留下若干常驻定时器。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
/** 别名：本文件另有一个 `Card`（`../src/components/Card.vue` 组件），类型不能同名。 */
import type { Card as ProtocolCard, PlayerView } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import Card from '../src/components/Card.vue';
import Hand from '../src/components/Hand.vue';
import { bidPhase } from './helpers/bid-phase';
import { FakeSocket, playerViewFixture, serverMessage, makeCards } from './helpers/fake-socket';
import { collectSourceFiles, stripComments, SRC_ROOT } from './helpers/source-scan';

/**
 * 牌面映射表（R702）。**从真实文件读**，不在测试里抄一份 ——
 * 抄一份就是第二个真源，图一换这条判据就开始说谎。
 *
 * ⚠️ 不能用 `new URL('.', import.meta.url)`：本仓 vitest 跑在 jsdom 里，
 * 那里 `import.meta.url` 不是 `file://` URL（`fileURLToPath` 会抛）。
 * 复用 `source-scan` 已经算好的 `SRC_ROOT`。
 */
const FACE_MANIFEST = JSON.parse(
  // 项 6：牌面随 table 分包 ⇒ pages/table/static/cards/manifest.json
  readFileSync(join(SRC_ROOT, 'pages', 'table', 'static', 'cards', 'manifest.json'), 'utf8'),
) as Record<string, string>;

/**
 * `src/uni.scss` 的**剥注释**文本 —— 读令牌的**真值**用。
 *
 * ⚠️ 同一份令牌值**不要在测试里再抄一遍**：抄一份就是第二个真源，
 * 令牌一改判据就开始说谎（本仓已有前科）。
 */
const UNI_SCSS = stripComments(
  collectSourceFiles().find((f) => f.path === 'src/uni.scss')!.content,
);

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

/** 出牌阶段的合法手牌：17 张、全部是合法 DouZero 值（含两个同点数的 3）。 */
const PLAYING_HAND = makeCards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30, 3, 4);

/** **四个**同点数的 3：恒降序下它们占据展示序的最后四位（「同点数全部选中」的判别力来源）。 */
const FOUR_THREES_HAND = makeCards(3, 5, 6, 7, 3, 3, 8, 9, 10, 11, 12, 13, 14, 3, 17, 20, 30);

function playingView(over: Partial<PlayerView> = {}): PlayerView {
  return playerViewFixture({
    state: 'playing',
    version: 2,
    landlordSeat: 0,
    bottomCards: makeCards(3, 4, 5),
    hand: PLAYING_HAND,
    recentActions: [],
    bidPhase: bidPhase(),
    ...over,
  });
}

/** 挂载牌桌并推入一份**出牌阶段**的裁剪视图（座位 0 = 我）。 */
async function mountPlayingTable(hand: ProtocolCard[] = PLAYING_HAND) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, hand }), 2));
  await wrapper.vm.$nextTick();
  return { wrapper, socket, store };
}

/** `Card` 的 props 子集（显式写出来：`mount` 的类型检查要看到 `value` 这类必填项）。 */
interface CardProps {
  value: number;
  /** R696 的花色：0♠ 1♥ 2♣ 3♦ 4王。缺省 = 4（王）⇒ 查不到映射、走文本兜底。 */
  suit?: number;
  selected?: boolean;
  disabled?: boolean;
  size?: 'normal' | 'small';
  faceDown?: boolean;
}

/** `Hand` 的 props 子集（同上）。 */
interface HandProps {
  /** R696：牌是 `{r, s}`（`selected` 仍是**下标**，见 `Hand.vue` 的 R173/N18）。 */
  cards: readonly ProtocolCard[];
  interactive?: boolean;
  selected?: readonly number[];
  size?: 'normal' | 'small';
  emptyText?: string;
  sort?: 'none' | 'asc' | 'desc';
  enter?: 'deal' | 'played' | 'none' | 'redeal';
}

function mountCard(props: CardProps) {
  const wrapper = mount(Card, { props });
  mounted.push(wrapper);
  return wrapper;
}

function mountHand(props: HandProps) {
  const wrapper = mount(Hand, { props });
  mounted.push(wrapper);
  return wrapper;
}

/** 手牌区（`.table__me`）**展示顺序**上的牌值。 */
function displayedValues(wrapper: VueWrapper): number[] {
  return wrapper.findAll('.table__me .card').map((c) => Number(c.attributes('data-value')));
}

/** 当前高亮的牌（按 DOM 顺序 = 展示顺序）的牌值。 */
function selectedValues(wrapper: VueWrapper): number[] {
  return wrapper.findAll('.table__me .card--selected').map((c) => Number(c.attributes('data-value')));
}

describe('➍ 卡牌渲染（R655 + F10）', () => {
  /**
   * ⚠️ **R696 判据迁移**（spec §6.3）：牌面换真卡图后，**有素材时不渲染文本层**
   * ⇒ 「角标 / 中央的文字 = `toDisplay` 的结果」这条**不能再按文本读**。
   *
   * 迁移后的落点是 **`aria-label`**（同一份 `toDisplay` 结果），
   * 而**文本断言本身没有删** —— 它搬到了「素材缺失」那条分支上（见下一个 it）。
   * 两条合起来比原来强：原判据只覆盖一条路径，现在覆盖两条。
   */
  it('牌面文字 = toDisplay 的结果（有素材时读 aria-label；F10）', () => {
    // 3 → 黑；17（DouZero 的 2）→ 红；30（大王）→ 红。
    const three = mountCard({ value: 3, suit: 0 });
    expect(three.attributes('aria-label')).toBe('3');
    expect(three.classes()).toContain('card--normal');
    expect(three.classes()).toContain('card--black');
    expect(three.attributes('data-value')).toBe('3'); // 锚点不得改语义（38 行 / 8 文件引用）

    const two = mountCard({ value: 17, suit: 0 });
    expect(two.attributes('aria-label')).toBe('2');
    expect(two.classes()).toContain('card--red');

    const joker = mountCard({ value: 30, suit: 4 });
    expect(joker.attributes('aria-label')).toBe('大王');
    expect(joker.classes()).toContain('card--red');
    expect(joker.attributes('data-value')).toBe('30');

    // F4：`小王` 不含「大」且不等于 `'2'` ⇒ **黑**（`tone` 的另一个分支，与上一条互为正反对照）。
    const smallJoker = mountCard({ value: 20, suit: 4 });
    expect(smallJoker.attributes('aria-label')).toBe('小王');
    expect(smallJoker.classes(), '小王 ⇒ 黑（正对照：大王 ⇒ 红）').toContain('card--black');
  });

  it('素材缺失时：文本层逐字 = toDisplay 的结果（R693 兜底分支的牌面来源）', () => {
    // `suit: 9` = 未登记的花色 ⇒ 走兜底 ⇒ 文本层渲染
    const three = mountCard({ value: 3, suit: 9 });
    expect(three.findAll('.card__corner').map((n) => n.text())).toEqual(['3']);
    expect(three.findAll('.card__center').map((n) => n.text())).toEqual(['3']);

    const two = mountCard({ value: 17, suit: 9 });
    expect(two.find('.card__corner').text()).toBe('2');
    expect(two.find('.card__center').text()).toBe('2');

    const joker = mountCard({ value: 30, suit: 9 });
    expect(joker.find('.card__corner').text()).toBe('大王');
    expect(joker.find('.card__center').text()).toBe('大王');

    // F4：`小王` 不含「大」且不等于 `'2'` ⇒ **黑**（`tone` 的另一个分支）。
    const smallJoker = mountCard({ value: 20, suit: 9 });
    expect(smallJoker.find('.card__center').text()).toBe('小王');
    expect(smallJoker.classes(), '小王 ⇒ 黑（正对照：大王 ⇒ 红）').toContain('card--black');
  });

  /**
   * F3：双字符面值（`10` / 小王 / 大王）在 `$ftl-card-w-small`（96px）里放不下单档字号
   * ⇒ 命中 `.card--wide`（角标与中央点数一起降到 `$ftl-font-card-small` 档）。
   *
   * ⚠️ 判据射程：jsdom 不注入 CSS，**这条不证明布局**（看不见宽度/折行）；它只钉住
   * 「哪些面值进宽档」这个**分类**，让字号降档的开关有据可依（布局在真浏览器走查里看）。
   */
  it('双字符面值（10 / 小王 / 大王）走 .card--wide，单字符不走（正反两面）', () => {
    for (const value of [10, 20, 30]) {
      expect(mountCard({ value }).classes(), `value=${value}（双字符面值）必须命中 .card--wide`).toContain(
        'card--wide',
      );
    }
    for (const value of [3, 9, 11, 14, 17]) {
      expect(
        mountCard({ value }).classes(),
        `value=${value}（单字符面值）不得命中 .card--wide`,
      ).not.toContain('card--wide');
    }
    // 牌背没有牌面（`face === ''`）⇒ 不命中（➌ 的牌背行为不受 F3 影响）
    expect(mountCard({ value: 30, faceDown: true }).classes()).not.toContain('card--wide');
  });

  it('faceDown ⇒ .card--back、无文字、无 data-value、点击不 emit', async () => {
    const back = mountCard({ value: 30, faceDown: true });
    expect(back.classes()).toContain('card--back');
    expect(back.text(), '牌背不渲染任何文字').toBe('');
    expect(back.findAll('.card__corner')).toHaveLength(0);
    expect(back.findAll('.card__center')).toHaveLength(0);
    expect(back.attributes('data-value'), '牌背不渲染 data-value').toBeUndefined();
    expect(back.attributes('disabled')).toBeDefined();

    await back.trigger('click');
    expect(back.emitted('toggle'), '牌背点击不 emit').toBeUndefined();

    // 正对照：同一牌值的牌面卡必须带 data-value 且点击 emit（否则上面「无 data-value」可能只是没渲染）
    const face = mountCard({ value: 30 });
    expect(face.attributes('data-value')).toBe('30');
    await face.trigger('click');
    expect(face.emitted('toggle')).toEqual([[30]]);
  });
});

/**
 * R696：牌面走**真卡图**。两条路径都要判：
 *  - **有素材**：渲染 `<image class="card__face">`，`src = /pages/table/static/cards/<manifest[{s}-{r}]>`（项 6 分包后）；
 *  - **素材缺失**（R693 兜底）：回落文本牌面 —— 用**未登记的 `suit`** 模拟。
 *
 * ⚠️ **判据射程（诚实版）**：jsdom 既**不加载图片**、也**不注入 CSS** ⇒
 * 这里只钉「`src` 算对了」「该走哪条分支」，**不证明图真的显示出来了**。
 * 图像是否可见只能由真浏览器 / App 走查证明（spec §9.2-7：**不要造假判据**）。
 */
describe('➍ R696：真牌面图 + 兜底分支（R693/R702）', () => {
  it('有素材：渲染 .card__face，src 由 (r, s) 合成键查出', () => {
    const wrapper = mountCard({ value: 3, suit: 0 }); // ♠3
    expect(wrapper.find('.card__face').attributes('src')).toBe(`/pages/table/static/cards/${FACE_MANIFEST['0-3']}`);
    expect(wrapper.find('.card__corner').exists(), '有素材时不渲染文本层（同一张牌不得有两份牌面来源）').toBe(
      false,
    );
  });

  it('花色不同 ⇒ 图不同（正对照：证明键真的用了 s，不是只用 r）', () => {
    const spade = mountCard({ value: 3, suit: 0 });
    const heart = mountCard({ value: 3, suit: 1 });
    expect(spade.find('.card__face').attributes('src')).not.toBe(
      heart.find('.card__face').attributes('src'),
    );
  });

  it('两张王各自查到自己的图（4-20 / 4-30，不是同一张）', () => {
    const small = mountCard({ value: 20, suit: 4 });
    const big = mountCard({ value: 30, suit: 4 });
    expect(small.find('.card__face').attributes('src')).toBe(`/pages/table/static/cards/${FACE_MANIFEST['4-20']}`);
    expect(big.find('.card__face').attributes('src')).toBe(`/pages/table/static/cards/${FACE_MANIFEST['4-30']}`);
    expect(small.find('.card__face').attributes('src')).not.toBe(big.find('.card__face').attributes('src'));
  });

  it('素材缺失 ⇒ 回落文本牌面（R693 兜底；不是第二套视觉，也不是白屏）', () => {
    // `suit: 9` 是未登记的花色 ⇒ 查不到映射 ⇒ 走兜底分支
    const wrapper = mountCard({ value: 30, suit: 9 });
    expect(wrapper.find('.card__face').exists()).toBe(false);
    expect(wrapper.find('.card__corner').text()).toBe('大王');
    expect(wrapper.find('.card__center').text()).toBe('大王');
  });

  it('`aria-label` = toDisplay(r)：F10 的机械保障新落点', () => {
    for (const [value, expected] of [
      [3, '3'],
      [14, 'A'],
      [17, '2'],
      [20, '小王'],
      [30, '大王'],
    ] as const) {
      expect(mountCard({ value, suit: 0 }).attributes('aria-label'), `value=${value}`).toBe(expected);
    }
  });

  /**
   * ⚠️ **2026-09-21 判据迁移**：这条原来断言「面朝下**不渲染任何图**」—— 那描述的是
   * 当时的实现（牌背是 CSS 斜纹画的），而不是**意图**。意图是「面朝下**不渲染牌面**」。
   *
   * 补接 `CardBack.png` 之后，牌背**也有图**了，所以判据改成「渲染的是**牌背图**」。
   * 这比原判据强：原来只钉「没有图」，现在钉「是哪一张图」，并带正对照。
   */
  it('牌背渲染的是**牌背图**（`manifest.back`），不是牌面图 —— 且零文字、零角标', () => {
    const back = mountCard({ value: 0, suit: 4, faceDown: true });
    expect(back.find('.card__face').attributes('src')).toBe(`/pages/table/static/cards/${FACE_MANIFEST.back}`);

    // 正对照：牌面朝上时用的是**另一张**图 ⇒ 证明「朝向」真的换了图，不是写死一张
    const faceUp = mountCard({ value: 3, suit: 0 });
    expect(faceUp.find('.card__face').attributes('src')).not.toBe(
      back.find('.card__face').attributes('src'),
    );

    // 牌背不泄漏牌面：无文字、无角标 / 中央层
    expect(back.text()).toBe('');
    expect(back.findAll('.card__corner')).toHaveLength(0);
    expect(back.findAll('.card__center')).toHaveLength(0);
  });
});

describe('➍ 手牌排序（R662 / N18）', () => {
  /**
   * 2026-10-10 用户裁决：页面上的三颗理牌按钮删除，手牌**恒降序**（先点数、再花色）。
   * 组件 `Hand` 的 `sort` prop 三档仍保留（出牌区/底牌与组件级用例在用），
   * 这里钉页面层的新形态：无按钮 + 恒降序 + 实例选择语义不变。
   */
  it('页面层：理牌按钮已删除，手牌恒降序；点击第 k 张仍选中同一实例（payload 按点击顺序）', async () => {
    const { wrapper, socket } = await mountPlayingTable();

    // 三颗理牌按钮整组删除（默认 / 点数升序 / 点数降序）
    expect(wrapper.find('.table__sort-none').exists(), '不再有「默认」理牌按钮').toBe(false);
    expect(wrapper.find('.table__sort-asc').exists(), '不再有「点数升序」按钮').toBe(false);
    expect(wrapper.find('.table__sort-desc').exists(), '不再有「点数降序」按钮').toBe(false);

    // 恒降序 = 按（点数, 花色）降序（比较器与 Hand.vue 同口径）
    expect(displayedValues(wrapper), '手牌恒为（点数, 花色）降序').toEqual(
      [...PLAYING_HAND].sort((a, b) => b.r - a.r || b.s - a.s).map((c) => c.r),
    );

    const cards = wrapper.findAll('.table__me .card');
    const last = cards.length - 1;
    // 降序形态：最后两张是两个 3（s:1 在前、s:0 在最后）—— 对子 [3,3] 是合法牌型。
    await cards[last - 1]!.trigger('click'); // 3（s:1 实例）
    await wrapper.vm.$nextTick();
    expect(cards[last - 1]!.classes(), '被点的那张实例（不是按值整组）高亮').toContain('card--selected');
    await cards[last]!.trigger('click'); // 3（s:0 实例）
    await wrapper.vm.$nextTick();
    expect(cards[last - 1]!.classes()).toContain('card--selected');
    expect(cards[last]!.classes()).toContain('card--selected');
    expect(selectedValues(wrapper), '同点数的两张 3 各选各的（按实例，不是按值）').toEqual([3, 3]);

    // 再点一次倒数第 2 张 ⇒ 只取消**这一个实例**（同值的另一张仍然在选）
    await cards[last - 1]!.trigger('click');
    await wrapper.vm.$nextTick();
    expect(selectedValues(wrapper), '取消的是实例而不是值').toEqual([3]);

    await wrapper.find('.table__play').trigger('click');
    const sent = socket.emittedOf('game.play');
    expect(sent).toHaveLength(1);
    // 剩单张 3（对子取消一张后），payload 就是那一个实例。
    const payload = sent[0]!.env.payload as { cards: ProtocolCard[] };
    expect(payload.cards).toHaveLength(1);
    expect(payload.cards[0]!.r).toBe(3);
  });

  it('同点数 4 张在恒降序下可全部选中 ⇒ 载荷 4 张', async () => {
    const { wrapper, socket } = await mountPlayingTable(FOUR_THREES_HAND);
    const threes = wrapper.findAll('.table__me .card[data-value="3"]');
    expect(
      threes,
      '判别力来源：这手牌有 4 个同点数的 3（恒降序下排在展示序最后四位）',
    ).toHaveLength(4);

    for (const card of threes) {
      await card.trigger('click');
      await wrapper.vm.$nextTick();
    }
    expect(wrapper.findAll('.table__me .card--selected'), '四个 3 都能选中').toHaveLength(4);

    await wrapper.find('.table__play').trigger('click');
    // 降序下同点牌按花色降序展示 ⇒ 点击顺序 = s:3 → s:0（payload 不排序，按点击顺序）。
    expect(socket.emittedOf('game.play')[0]!.env.payload, '四张 3 全部送出').toEqual({
      cards: [
        { r: 3, s: 3 },
        { r: 3, s: 2 },
        { r: 3, s: 1 },
        { r: 3, s: 0 },
      ],
    });
  });

  it('组件 sort prop 三档仍可用；页面层手牌恒为降序（正对照）', async () => {
    // ① 组件层：缺省 sort='none' ⇒ 逐字是 cards 顺序；升/降序只改**展示**顺序
    const cards = makeCards(3, 5, 4, 30, 17);
    const plain = mountHand({ cards });
    expect(plain.findAll('.card').map((c) => Number(c.attributes('data-value')))).toEqual([3, 5, 4, 30, 17]);
    // ⚠️ R696 判据迁移：有素材时文本层不渲染 ⇒ 读 `aria-label`（同一份 `toDisplay` 结果）。
    expect(plain.findAll('.card').map((c) => c.attributes('aria-label'))).toEqual(['3', '5', '4', '大王', '2']);

    const asc = mountHand({ cards, sort: 'asc' });
    expect(asc.findAll('.card').map((c) => Number(c.attributes('data-value')))).toEqual([3, 4, 5, 17, 30]);

    const desc = mountHand({ cards, sort: 'desc' });
    expect(desc.findAll('.card').map((c) => Number(c.attributes('data-value')))).toEqual([30, 17, 5, 4, 3]);

    // ② R662：排序后点击「第 k 张」，emit 的仍是 cards 的**原始下标**（不是展示位置）
    const probe = mountHand({ cards, sort: 'asc', interactive: true });
    const shown = probe.findAll('.card');
    await shown[0]!.trigger('click'); // 展示序 0 = 值 3 = 原始下标 0
    await shown[2]!.trigger('click'); // 展示序 2 = 值 5 = 原始下标 1
    await shown[4]!.trigger('click'); // 展示序 4 = 值 30 = 原始下标 3
    expect(probe.emitted('toggle'), 'toggle 恒为原始下标（R662）').toEqual([[0], [1], [3]]);

    // ③ 页面层：`.table__me .card` 恒为降序（2026-10-10 起），store.hand 原始顺序不受影响
    const { wrapper, store } = await mountPlayingTable();
    expect(store.hand).toEqual(PLAYING_HAND);
    expect(displayedValues(wrapper)).toEqual(
      [...store.hand].sort((a, b) => b.r - a.r || b.s - a.s).map((c) => c.r),
    );
    // R696：**页面级**也走真牌面图（只在组件级成立是不够的 —— 手牌这条链路
    // `table.vue → Hand → Card` 上任何一环漏传 `suit` 都会让这里静默回落成文本）。
    expect(
      wrapper.findAll('.table__me .card__face'),
      '17 张手牌每张都应渲染真牌面图（漏传 suit ⇒ 查不到映射 ⇒ 静默回落文本）',
    ).toHaveLength(PLAYING_HAND.length);
    // 降序后 A（DouZero 17）在展示序第 3 张（大王、小王之后），用点数定位而非位置下标。
    expect(
      Number(wrapper.find('.table__me .card[data-value="17"]').attributes('data-value')),
      '手牌里必须能按点数找到 A（17）',
    ).toBe(17);
  });
});

describe('➍ 源码级判据（F10）', () => {
  it('源码级：Card.vue 只经 toDisplay 取牌面，无自制映射', () => {
    const sources = collectSourceFiles();

    const card = sources.find((f) => f.path === 'src/components/Card.vue');
    expect(card, '源码扫描器必须真的读到 Card.vue').toBeDefined();
    const cardCode = stripComments(card!.content);
    expect(card!.content, '存在性断言读原始文本：牌面来源必须点名 toDisplay').toContain('toDisplay');
    expect(cardCode, '不得自制点数映射').not.toMatch(/['"](?:大王|小王)['"]/);
    // ⚠️ R696：原来的 `/toInternalRank|toDouZero/` 已是**死条目**（两个符号全仓删除，
    //    R377）。换成**仍然存在**的规则面标识符 —— 意图不变（牌面不得走规则面映射），
    //    但断言重新变得**可触发**。
    expect(cardCode, '牌面不得走规则面映射').not.toMatch(/HandType|parseHand|canBeat|isBomb/);

    const hand = sources.find((f) => f.path === 'src/components/Hand.vue');
    expect(hand, '源码扫描器必须真的读到 Hand.vue（R659 清单 +1 的前提）').toBeDefined();
    const handCode = stripComments(hand!.content);
    // F2：`'order'` 会被 `border` 之类的子串满足 ⇒ 钉到**声明形态**（与生产实现同形）
    expect(handCode, 'R662：排序用 order 计算属性（原始下标数组）').toMatch(/\bconst order\b/);
    // ⚠️ R696：原来的 `/toInternalRank|toDouZero/` 已是**死条目**（两个符号全仓删除，R377）。
    // 换成**仍然存在**的规则面标识符 —— 意图不变（排序不得走规则面映射），断言重新可触发。
    expect(handCode, 'R662：排序不得走规则面映射').not.toMatch(/HandType|parseHand|canBeat|isBomb/);
    expect(handCode, '不得自制点数映射').not.toMatch(/['"](?:大王|小王)['"]/);

    // 存在性判据（读**原始文本**）：牌背只有一份实现 —— `Card.vue`；➌ 的座位与➏ 的底牌位共用它
    const backImplementations = sources
      .filter((f) => /\bcard--back\b/.test(stripComments(f.content)))
      .map((f) => f.path);
    expect(backImplementations, '牌背不得另写第二份样式').toEqual(['src/components/Card.vue']);

    /**
     * ⚠️ **牌背的 CSS 纹样必须留着**（2026-09-21）：它是 `CardBack.png` **加载失败时的兜底**。
     *
     * 主视觉已经是那张图（上面那条 `manifest.back` 的断言钉住了）；
     * 但如果有人看到「反正有图了」就把 `repeating-linear-gradient` 删掉，
     * 图一旦缺失牌背就是**一片空白**（R693：不白屏）。
     * ⇒ 这条防的是**过度清理**，不是防缺素材。
     */
    expect(
      cardCode,
      '牌背的 CSS 纹样是 CardBack.png 加载失败时的兜底，不得删除',
    ).toMatch(/repeating-linear-gradient/);
  });

  /**
   * 走查 P2-18：非交互牌（出牌区 / 亮出的底牌 / 牌背）的禁用态**不得做透明度惩罚**。
   * `Hand.vue` 对所有非交互场景传 `disabled`，旧规则 `opacity: .6` 让他人打出的牌和
   * 底牌整体泛白；点击拦截只靠原生 `disabled` / `faceDown` 守卫，视觉不降级。
   */
  it('源码级：.card--disabled 不得带 opacity（非交互牌是信息，不是禁用控件；P2-18）', () => {
    const card = collectSourceFiles().find((f) => f.path === 'src/components/Card.vue');
    expect(card, '源码扫描器必须真的读到 Card.vue').toBeDefined();
    const rule = /\.card--disabled\s*\{([^}]*)\}/.exec(stripComments(card!.content));
    expect(rule, '.card--disabled 规则必须还在（禁用语义不靠删除类名表达）').not.toBeNull();
    expect(rule![1], '禁用牌不得被透明度打灰（出牌区/底牌泛白的根因）').not.toMatch(/opacity/);
  });

  /**
   * F1（R672 复审）：手牌区**净重叠 = |margin-left| − 容器的 `column-gap`** 这个账目的一半。
   *
   * ⚠️ **判据射程（诚实版）**：jsdom 不注入 CSS ⇒ **本判据不证明布局**，它只防「账目再次漂移」
   * （`Hand.vue` 自带 `gap: $ftl-space-2`(8px)，只覆盖 `row-gap` 时净重叠只剩 96−8 = 88px
   * ⇒ 20 张 `155 + 19×67 = 1428` > 16:9 最紧档可用宽 1294 ⇒ 地主 20 张换行；1294 是最坏值，
   * 2026-10-11 起舞台全出血，非 16:9 设计宽更大，但账目判据仍按最紧档守）。
   * 真正的框宽验证在**产物 CSS** 与真浏览器探针里。两条断言都读**剥注释视图**：
   * 写在注释里的「column-gap: 0」不算数。
   */
  it('源码级：手牌重叠账目 = column-gap 归零 + 相邻牌负 margin-left（F1；U1 改档后）', () => {
    const table = collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(table, '源码扫描器必须真的读到 DdzBoard.vue').toBeDefined();
    const tableCode = stripComments(table!.content);

    /** 手牌容器规则里必须显式把 `column-gap` 归零（否则 `Hand.vue` 的 8px gap 吃掉重叠）。 */
    const zeroesColumnGap = (src: string) => /:deep\(\.hand\)\s*\{[^}]*column-gap:\s*0;/.test(src);
    /**
     * 重叠本身必须落在相邻牌的负 `margin-left` 上（负 `gap` 非法、会被三端丢弃）。
     *
     * ⚠️ **U1（2026-09-21）**：牌宽 48→72rpx（片① 后再 ×2 = 144px）后，重叠改由**专用令牌**
     * `$ftl-card-overlap` 表达（不再是 `$ftl-space-6`）—— 因为它是**牌面几何**的一部分，
     * 与间距阶无关，改牌宽时它必须跟着一起算（见下一条判据）。
     */
    const overlapsByMargin = (src: string) =>
      /\.card \+ \.card\)\s*\{[^}]*margin-left:\s*-\$ftl-card-overlap;/.test(src);

    expect(zeroesColumnGap(tableCode), '手牌容器必须 column-gap: 0（净重叠才是重叠令牌的全额）').toBe(
      true,
    );
    expect(overlapsByMargin(tableCode), '重叠必须是 .card + .card 的负 margin-left').toBe(true);

    // 正对照：合规样本两条都命中
    const ok =
      '.table__me :deep(.hand) { column-gap: 0; } .table__me :deep(.hand .card + .card) { margin-left: -$ftl-card-overlap; }';
    expect(zeroesColumnGap(ok) && overlapsByMargin(ok), '正对照：合规样本必须判为合规').toBe(true);
    // 反面对照①：漏写 column-gap 归零（净重叠只剩一部分）⇒ 必须被拦下
    const forgotZero =
      '.table__me :deep(.hand) { row-gap: $ftl-space-4; } .table__me :deep(.hand .card + .card) { margin-left: -$ftl-card-overlap; }';
    expect(zeroesColumnGap(forgotZero), '反面对照：漏写 column-gap:0 必须报错').toBe(false);
    // 反面对照②：负 gap（非法，三端直接丢声明）⇒ 不满足「归零」
    expect(zeroesColumnGap('.table__me :deep(.hand) { column-gap: -$ftl-space-6; }')).toBe(false);
    // 反面对照③：重叠退回旧的间距阶令牌 ⇒ U1 之后必须报错（防止改档改了一半）
    expect(
      overlapsByMargin('.table__me :deep(.hand .card + .card) { margin-left: -$ftl-space-6; }'),
      '重叠不得退回 $ftl-space-* 间距阶',
    ).toBe(false);
  });

  /**
   * 拉伸真因（2026-10-10 浏览器实测）：H5 的 `<button>` 编译成 `uni-button`，
   * 宿主基样式带 `margin-left/right: auto`。`.card + .card` 只覆盖 margin-left，
   * 右侧 auto 会把行内剩余空间**均摊到牌间**（牌越少间距越大 = 用户看到的「拉伸」）。
   * ⇒ `.card` 基类必须 `margin: 0`。jsdom 不布局 ⇒ 钉源码。
   */
  it('源码级：.card 基类必须 margin: 0（压掉 uni-button 的 margin:auto 均摊，间距才固定）', () => {
    const card = collectSourceFiles().find((f) => f.path === 'src/components/Card.vue');
    expect(card, '源码扫描器必须真的读到 Card.vue').toBeDefined();
    const rule = /\.card\s*\{([\s\S]*?)\n\}/.exec(stripComments(card!.content));
    expect(rule, '.card 基类规则必须存在').not.toBeNull();
    expect(rule![1], '.card 必须显式 margin: 0（uni-button 默认 margin:auto 会均摊拉伸牌间）').toMatch(
      /margin:\s*0;/,
    );
    // 判别力自证
    expect(/margin:\s*0;/.test('.card { box-sizing: border-box; margin: 0; }')).toBe(true);
    expect(/margin:\s*0;/.test('.card { box-sizing: border-box; }')).toBe(false);
  });

  /**
   * U1（2026-09-21 用户裁决）：牌框采纳**真牌比例**（源图 54 张面全部 80×104 px = 0.769）。
   *
   * 旧档 56×96（比例 0.583）是「零素材 / 纯 CSS 画牌」时代的权宜，参考拆解报告 §3 点过名。
   *
   * ⚠️ **判据射程（诚实版）**：jsdom 不注入 CSS ⇒ **本判据不渲染、不量像素**。
   * 它只做两件**可以机械判定**的事：
   *  ① 令牌之间的**算术关系**（比例贴住源图、20 张单行放得下、净露率在档位区间）；
   *  ② 让「改了牌宽却忘记重算重叠」当场变红。
   *  真正的观感（牌好不好看、角标看不看得清）**只能**由真浏览器/App 走查证明。
   *
   * ⚠️ **2026-10-10 用户裁决：重叠恒等**（参考欢乐斗地主）：间距不随张数变化，
   * 不再有 `handOverlap` 压缩分支 —— 令牌值直接按最密极端（20 张）取档。
   */
  it('源码级：三档牌框各自贴住真牌 0.769；手牌重叠恒等且 1..20 张全部单行（U1 算账；固定间距）', () => {
    /** 从 `uni.scss` 现读一个 **px** 令牌的数值。 */
    const token = (name: string): number => {
      const m = new RegExp(`^\\$${name}:\\s*(\\d+)px;`, 'm').exec(UNI_SCSS);
      expect(m, `未找到令牌 $${name}`).not.toBeNull();
      return Number(m![1]);
    };

    const sourceRatio = 80 / 104; // 源图 54 张面全部 80×104

    // ① **三档**牌框各自贴住源图比例（差 < 1.5%，即取值取整带来的误差）。
    //    ⚠️ 片② 起是三档（手牌 / 出牌 / 底牌）—— 参考图的 225/303 = 0.743 是**它的画稿**比例，
    //    我方画稿是 0.769 ⇒ **以我方为准**（照抄参考图会差 3.6%、这条当场红）。
    const tiers: ReadonlyArray<readonly [string, string, string]> = [
      ['手牌', 'ftl-card-w', 'ftl-card-h'],
      ['出牌', 'ftl-card-mid-w', 'ftl-card-mid-h'],
      ['底牌', 'ftl-card-w-small', 'ftl-card-h-small'],
    ];
    for (const [label, wTok, hTok] of tiers) {
      const tw = token(wTok);
      const th = token(hTok);
      expect(
        Math.abs(tw / th - sourceRatio) / sourceRatio,
        `${label}档 ${tw}×${th}（比例 ${(tw / th).toFixed(3)}）必须贴住源图 ${sourceRatio.toFixed(3)}`,
      ).toBeLessThan(0.015);
    }

    // ② 手牌：**恒等重叠**（不随张数变化）⇒ n=1..20 全部单行。
    //    可用宽 = 1334 − `.table` 两侧 `$ftl-space-5`(12) − `.table__me` 两侧 `$ftl-space-4`(8) = 1294。
    //    这两个内边距必须与 `table.vue` 的实际写法一致 —— 改内边距就要重算这里（下面 ⑤ 有源码闸）。
    const AVAILABLE = 1294;
    const w = token('ftl-card-w');
    const overlap = token('ftl-card-overlap');
    const pitch = w - overlap;
    for (let n = 1; n <= 20; n += 1) {
      expect(w + (n - 1) * pitch, `n=${n} 固定间距下必须单行放得下`).toBeLessThanOrEqual(AVAILABLE);
    }

    // ③ 净露率落在档位区间：下限保证角标可读（角标左 8px 起、24px 字号，双字符「10」≈35px），
    //    上限防止牌与牌几乎不重叠、失去扇形形态。
    const exposure = pitch / w;
    expect(exposure, `净露率 ${(exposure * 100).toFixed(0)}% 过低 ⇒ 看不清角标`).toBeGreaterThanOrEqual(0.35);
    expect(exposure, `净露率 ${(exposure * 100).toFixed(0)}% 过高 ⇒ 失去扇形重叠形态`).toBeLessThanOrEqual(
      0.6,
    );

    // ④ 「按张数自适应」**不得复活**（2026-10-10 用户裁决：间距固定，不拉伸/不压密）：
    //    纯函数模块已删、Hand 不再有 fitWidth / 变量注入、宿主只消费字面令牌。
    const hand = collectSourceFiles().find((f) => f.path === 'src/components/Hand.vue');
    expect(hand, '源码扫描器必须真的读到 Hand.vue').toBeDefined();
    const handCode = stripComments(hand!.content);
    expect(handCode, 'Hand.vue 不得再引入 handLayout（间距固定，自适应已删）').not.toMatch(/handLayout/);
    expect(handCode, 'Hand.vue 不得再有 fitWidth prop').not.toMatch(/fitWidth/);
    expect(handCode, 'Hand.vue 不得再注入 --ftl-hand-overlap').not.toMatch(/--ftl-hand-overlap/);
    const tableCode = stripComments(
      collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue')!.content,
    );
    const marginRule = /\.card \+ \.card\)\s*\{([^}]*)\}/.exec(tableCode);
    expect(marginRule, '相邻牌 margin 规则必须存在').not.toBeNull();
    expect(marginRule![1], 'margin 只能是字面令牌，不得再消费按张数算出的变量').not.toMatch(
      /var\(--ftl-hand-overlap/,
    );
    expect(
      collectSourceFiles().some((f) => f.path === 'src/composables/handLayout.ts'),
      'src/composables/handLayout.ts 必须已删除（自适应机制的尸体不得保留）',
    ).toBe(false);

    // ④-bis 出牌区（mid 90×117）：2026-10-10 用户裁决「出牌的牌也要像手牌一样紧凑叠放」——
    // PlayArea.vue 必须 nowrap + 归零 Hand 自带 gap + 相邻牌负 margin 消费 $ftl-card-overlap-mid，
    // 且 mid 净露率与手牌**同口径**（差 ≤2pp），防止令牌被改成散开的并排 gap。
    const midW = token('ftl-card-mid-w');
    const midOverlap = token('ftl-card-overlap-mid');
    const midExposure = (midW - midOverlap) / midW;
    expect(
      Math.abs(midExposure - exposure),
      `出牌区净露率 ${(midExposure * 100).toFixed(0)}% 必须与手牌 ${(exposure * 100).toFixed(0)}% 同口径（差 ≤2pp）`,
    ).toBeLessThanOrEqual(0.02);
    const playAreaFile = collectSourceFiles().find((f) => f.path === 'src/components/PlayArea.vue');
    expect(playAreaFile, '源码扫描器必须真的读到 PlayArea.vue').toBeDefined();
    const playAreaCode = stripComments(playAreaFile!.content);
    expect(playAreaCode, '出牌牌行必须 flex-wrap: nowrap（不得散开换行）').toMatch(
      /\.table__played\s*\{[^}]*flex-wrap:\s*nowrap;/,
    );
    expect(playAreaCode, '出牌区必须归零 Hand 自带的 column-gap').toMatch(
      /:deep\(\.hand\)\s*\{[^}]*column-gap:\s*0;/,
    );
    expect(playAreaCode, '出牌区相邻牌必须用负 margin-left 消费 $ftl-card-overlap-mid').toMatch(
      /margin-left:\s*-\$ftl-card-overlap-mid;/,
    );

    // ⑤ AVAILABLE 算式的前提（`.table` / `.table__me` 的内边距用法）——源码级钉住，
    //    从已删除的 hand-layout.test.ts 迁入：改用法必须先重算 ② 的 AVAILABLE。
    expect(tableCode, '`.table` 的两侧内边距必须是 $ftl-space-5（AVAILABLE 账目的一项）').toMatch(
      /\.table\s*\{[^}]*padding:\s*\$ftl-space-2\s+\$ftl-space-5;/,
    );
    expect(tableCode, '`.table__me` 的两侧内边距必须是 $ftl-space-4（AVAILABLE 账目的另一项）').toMatch(
      /\.table__me\s*\{[^}]*padding:\s*\$ftl-space-2\s+\$ftl-space-4;/,
    );
  });

  /**
   * 选牌抬起**不得遮挡邻牌**（2026-10-10 用户裁决 + 浏览器实测）：
   * 扇形里牌按 DOM 顺序绘制，后一张本来压着前一张右缘；若选中牌带 `z-index`，
   * 它会跳到后一张之上、盖住邻牌左上角的点数角标。jsdom 不布局 ⇒ 只能钉源码。
   */
  it('源码级：.card--selected 不得声明 z-index（抬起不改变绘制顺序 ⇒ 不新增遮挡）', () => {
    const card = collectSourceFiles().find((f) => f.path === 'src/components/Card.vue');
    expect(card, '源码扫描器必须真的读到 Card.vue').toBeDefined();
    const rule = /\.card--selected\s*\{([^}]*)\}/.exec(stripComments(card!.content));
    expect(rule, '.card--selected 规则必须存在').not.toBeNull();
    expect(rule![1], '选中牌不得靠 z-index 浮到邻牌之上（会盖住后一张的点数角标）').not.toMatch(
      /z-index/,
    );
    // 判别力自证：等价的合规/违规短样本
    const hasNoZ = (s: string) => !/z-index/.test(s);
    expect(hasNoZ('transform: translateY(-24px); border-color: red;')).toBe(true);
    expect(hasNoZ('z-index: 1; transform: translateY(-24px);')).toBe(false);
  });

  it('源码级：Hand 的 FLIP 必须做 $el 兜底、H5 门控、scale 换算与独立 translate', () => {
    const files = collectSourceFiles();
    const flip = files.find((f) => f.path === 'src/components/hand-flip.ts');
    expect(flip, '源码扫描器必须真的读到 hand-flip.ts').toBeDefined();
    const flipCode = stripComments(flip!.content);
    expect(flipCode, 'H5 的 <view> ref 是组件实例，必须取 $el').toMatch(/\$el/);
    expect(flipCode, 'scale 必须用 root offsetWidth 计算').toMatch(/offsetWidth/);

    const hand = files.find((f) => f.path === 'src/components/Hand.vue');
    expect(hand, '源码扫描器必须真的读到 Hand.vue').toBeDefined();
    const code = stripComments(hand!.content);
    expect(code, '必须有 H5 运行时门控（canFlip 内实际使用）').toMatch(
      // 2026-10-24：原判据钉 `if (!props.reflow || !isH5Runtime)`；569830b6 把常量
      // **等价展开**成两条独立检查（isH5Runtime 的定义就是 window+document 双存在），
      // 语义未变 ⇒ 判据改为接受展开式（仍要求 reflow 与两个全局都真的被检查）。
      /if\s*\(\s*!props\.reflow\s*\)\s*return\s+false;[\s\S]*?typeof window\s*===\s*'undefined'[\s\S]*?typeof document\s*===\s*'undefined'/,
    );
    expect(code, 'FLIP 位移必须除以 scale').toMatch(
      /oldRect\.left\s*-\s*newRect\.left\)\s*\/\s*scale/,
    );
    expect(code, 'FLIP 必须使用独立 translate 属性').toMatch(/translate:\s*`?\$\{dx\}px/);
  });

  it('源码级：手牌必须传 reflow，出牌区/底牌不得传', () => {
    const files = collectSourceFiles();
    const table = files.find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(table, '源码扫描器必须真的读到 DdzBoard.vue').toBeDefined();
    const handBlock = /<Hand[\s\S]*?\/>/.exec(stripComments(table!.content));
    expect(handBlock, 'DdzBoard.vue 必须存在手牌 <Hand>').not.toBeNull();
    expect(handBlock![0], '手牌必须启用裸 reflow（不是 :reflow="false"）').toMatch(
      /\breflow(?:\s|\/?>)/,
    );

    for (const path of ['src/components/PlayArea.vue', 'src/components/BottomCards.vue']) {
      const file = files.find((f) => f.path === path);
      expect(file, `源码扫描器必须真的读到 ${path}`).toBeDefined();
      expect(stripComments(file!.content), `${path} 不得启用 reflow`).not.toMatch(/\breflow\b/);
    }
  });
});

/**
 * 重新发牌片的 Hand 入场档（2026-10-22）。
 *
 * D12：`enter='redeal'` 只作用于**重挂载时的首批牌**；之后在同一实例里新出现的牌
 * （地主摸的 3 张底牌 / 断线补齐）必须降回普通发牌档，否则“定地主”会被画成“重发”。
 */
describe('重新发牌：Hand 的 redeal 入场档', () => {
  it("enter='redeal' 挂 anim-redeal-in；默认仍是 anim-deal-in（正对照）", () => {
    const redeal = mountHand({ cards: makeCards(3, 4, 5), enter: 'redeal' });
    const card = redeal.find('.card');
    expect(card.classes()).toContain('anim-redeal-in');
    expect(card.classes()).not.toContain('anim-deal-in');

    const normal = mountHand({ cards: makeCards(3, 4, 5) });
    expect(normal.find('.card').classes()).toContain('anim-deal-in');
    expect(normal.find('.card').classes()).not.toContain('anim-redeal-in');
  });

  it('D12：重发档只作用于首批牌，后来新增的牌降回发牌档（首批牌的类不得变化）', async () => {
    const first = makeCards(3, 4, 5);
    const wrapper = mountHand({ cards: first, enter: 'redeal', sort: 'none' });
    for (const n of wrapper.findAll('.card')) {
      expect(n.classes()).toContain('anim-redeal-in');
    }

    await wrapper.setProps({ cards: makeCards(3, 4, 5, 6) });
    const classes = wrapper.findAll('.card').map((n) => n.classes());
    expect(classes, '应有 4 张牌').toHaveLength(4);
    expect(classes[3], '新增的第 4 张必须是普通发牌档').toContain('anim-deal-in');
    expect(classes[3]).not.toContain('anim-redeal-in');
    expect(classes[0], '首批牌不得因 props 更新而改类（类变化会让 CSS 动画重放）').toContain(
      'anim-redeal-in',
    );
    expect(classes[0]).not.toContain('anim-deal-in');
  });
});

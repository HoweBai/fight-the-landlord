/**
 * 出牌区：**窗口 2**（协议 ④ / 上位 §4.4）。
 *
 * 判别力说明（每个用例「什么样的实现会让它红」，逐条写清）：
 *  ① 窗口为空 ⇒ **没有任何出牌槽**，也没有「（无）」占位（走查修复：占位已整条删除，
 *     空中央就是空的；仍渲染一个空 PlayArea 或换个文案占位 ⇒ 红）；
 *  ② 窗口满 2 项 ⇒ **两个** `PlayArea` 实例、各在自己的槽（把两个 action 渲染到同一处 ⇒ 红）；
 *  ③ `cards: null` + 有效 `seat` ⇒ 对手的「不出」挂在**他那侧出牌/状态列**
 *     （`.table__play-pass`，与牌、迷你钟同一条固定带），该侧**不挂出牌槽**
 *     （2026-10-11 第三轮：旧形态挂座位卡、更早的黑药丸压中央按钮，均已退役；仍在出牌槽渲染 ⇒ 红）；
 *  ④ 我出的那一手在 `.table__me` **之外**（挪进 `.table__me` ⇒ `.table__me .card` 变成 18 ⇒ 红）；
 *     2026-10-11 第三轮起它挂在动作行**原按钮位**（`.table__action-bar .table__my-play`）。
 *  ⑤ 槽位限定的选择器各数到**自己的那一格**（文档级后代选择器会跨实例数到两处之和 ——
 *     见 ⑤ 里的「见证」断言与 `action-feedback.test.ts` 的槽位限定迁移）。
 *
 * ⚠️ 装配姿势与 `table-center.test.ts` 同族：`store.applySnapshot` 直接灌视图（不过 socket），
 * 因为本文件考的是**渲染**，不是传输。`afterEach` 必须 unmount（`useCountdown` 有常驻 setInterval）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { RecentAction } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { bidPhase } from './helpers/bid-phase';
import { FakeSocket, playerViewFixture, makeCards } from './helpers/fake-socket';

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
 * 挂起牌桌，`recentActions` 就是服务端给的窗口（主变量）。
 * `currentPlayer` 可显式指定：第三轮布局起「轮到我 ⇒ 动作行显按钮（优先于窗口里我上一手）；
 * 不是我 ⇒ 我上一手占原按钮位」，两类用例需要不同回合归属。
 */
function mountTable(recentActions: RecentAction[], mySeat = 0, currentPlayer = 0) {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', mySeat);
  store.applySnapshot(
    playerViewFixture({
      state: 'playing',
      version: 2,
      seat: mySeat,
      currentPlayer,
      landlordSeat: 0,
      bottomCards: makeCards(3, 4, 5),
      bidPhase: bidPhase(),
      recentActions,
    }),
  );
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, store };
}

describe('出牌区：窗口 2（协议④ / 上位 §4.4）', () => {
  it('窗口为空 ⇒ 没有出牌槽、没有「（无）」占位（中央保持空）', () => {
    const { wrapper } = mountTable([]);
    expect(wrapper.findAll('.table__play-area')).toHaveLength(0);
    expect(wrapper.findAll('.table__played-slot')).toHaveLength(0);
    // 旧的中央「（无）」占位已整条删除（走查修复；轮到我 ⇒ 动作行显按钮，不是等待文案）。
    expect(wrapper.find('.table__muted').exists()).toBe(false);
    // 三家都没有行动 ⇒ 出牌/状态列与动作行都没有「不出」。
    expect(wrapper.findAll('.table__play-pass')).toHaveLength(0);
    expect(wrapper.findAll('.table__my-pass')).toHaveLength(0);
  });

  it('两家各出一手 ⇒ **两个**实例，各在自己的槽位', () => {
    const { wrapper } = mountTable([
      { seat: 1, cards: makeCards(3, 4) },
      { seat: 2, cards: makeCards(5, 6, 7) },
    ]);
    const slots = wrapper.findAll('.table__played-slot');
    expect(slots, '窗口 2 的两项 ⇒ 每侧一个实例').toHaveLength(2);
    expect(wrapper.findAll('.table__play-area')).toHaveLength(2);
    // 逆时针座序（2026-10-12）：mySeat=0 ⇒ 左槽 = 上家座位 2、右槽 = 下家座位 1。
    // 两家的**牌数不同** —— 「把两个 action 都渲染到同一处」的实现会在这里红。
    expect(slots[0]!.findAll('.card')).toHaveLength(3);
    expect(slots[1]!.findAll('.card')).toHaveLength(2);
    // 归属标签「玩家N 出」已按 2026-10-11 用户裁决删除（牌在谁一侧即谁出）——反向断言防腐烂。
    expect(slots[0]!.find('.table__played-owner').exists()).toBe(false);
    expect(slots[1]!.find('.table__played-owner').exists()).toBe(false);
    // 没有占位：「（无）」占位已整条删除（走查修复）。
    expect(wrapper.find('.table__muted').exists()).toBe(false);
  });

  /**
   * 🔴 右侧镜像**不能按座位号推断**（2026-10-10 走查 / 2026-10-12 逆时针座序）：
   * 座位随庄家轮换，`mySeat=2` 时右侧坐的是 **0 座**（下家）、左侧坐的是 **1 座**（上家）。
   * 右槽的 PlayArea 必须由宿主显式给 `mirror`（根节点挂 `.table__play-area--mirror`），
   * 左槽永远不挂 —— 拿出牌项的固定座位号当右槽判据的实现会在本用例红。
   */
  it('mySeat=2（右家是 0 座）⇒ 右槽照样挂镜像类，左槽不挂', () => {
    const { wrapper } = mountTable(
      [
        { seat: 0, cards: makeCards(3, 4) },
        { seat: 1, cards: makeCards(5, 6, 7) },
      ],
      2,
    );
    const slots = wrapper.findAll('.table__played-slot');
    expect(slots).toHaveLength(2);
    // 左槽 = 上家 1 座（3 张），右槽 = 下家 0 座（2 张）——镜像只认「右槽」这个方位，不认座位号。
    expect(slots[0]!.findAll('.card')).toHaveLength(3);
    expect(slots[1]!.findAll('.card')).toHaveLength(2);
    // 宿主 class 会透传到 PlayArea 的单根上 ⇒ 直接看槽元素自己的 class 表。
    expect(slots[0]!.classes()).not.toContain('table__play-area--mirror');
    expect(slots[1]!.classes()).toContain('table__play-area--mirror');
  });

  /**
   * 🔗 「不出」占一手 —— 2026-10-11 第三轮起挂在当事人那侧的**出牌/状态列**
   * （`.table__play-pass`，与牌、迷你钟同一条固定带）。
   */
  it('cards 为 null 且 seat 有效 ⇒ 当事人列挂「不出」，该侧不挂出牌槽', () => {
    const { wrapper } = mountTable([
      { seat: 1, cards: makeCards(4) },
      { seat: 2, cards: null },
    ]);
    // mySeat=0 逆时针座序：上家座位 2 在左列（「不出」），下家座位 1 在右列（真牌挂出牌槽）。
    const slots = wrapper.findAll('.table__played-slot');
    expect(slots).toHaveLength(1);
    expect(slots[0]!.findAll('.card')).toHaveLength(1);
    expect(wrapper.findAll('.table__play-area')).toHaveLength(1);
    // 左右出牌/状态列（`.table__mid` 内）DOM 顺序 = 左列(座位 2)、右列(座位 1)。
    const cols = wrapper.findAll('.table__play-col');
    expect(cols).toHaveLength(2);
    // 上家（座位 2）没有真牌 ⇒ 左列挂「不出」。
    expect(cols[0]!.find('.table__play-pass').text()).toBe('不出');
    // 下家（座位 1）出了真牌 ⇒ 右列不挂「不出」。
    expect(cols[1]!.find('.table__play-pass').exists(), '出牌的一侧不挂「不出」').toBe(false);
    // 出牌槽里不再有旧的黑药丸/「（无）」分支，动作行也没有等待占位（轮到我）。
    expect(wrapper.find('.table__pass-note').exists()).toBe(false);
    expect(wrapper.find('.table__muted').exists()).toBe(false);
  });

  /**
   * 🔴 **我出的那一手不得进 `.table__me`** —— 放进去会让 R660 的数法变了
   * （17 手牌 + 1 张已出的牌 = 18），而探针与 `table-play-ui` 都断言它**恰好是手牌**。
   * 第三轮起它占动作行**原按钮位** ⇒ 本用例必须是「**不是我的回合**」（轮到我时按钮优先）。
   */
  it('非我回合：我出的那一手在动作行原按钮位（.table__me 之外），按钮不存在', () => {
    const { wrapper } = mountTable([{ seat: 0, cards: makeCards(9) }], 0, 1);
    expect(wrapper.find('.table__action-bar .table__my-play').exists()).toBe(true);
    // 出牌后按钮**消失**（不是 disabled）：动作行里不得有出牌/过牌按钮。
    expect(wrapper.find('.table__play').exists()).toBe(false);
    expect(wrapper.find('.table__pass').exists()).toBe(false);
    expect(wrapper.findAll('.table__me .card')).toHaveLength(17);
    expect(wrapper.findAll('.table__my-play .card')).toHaveLength(1);
    // 是我出的那一张（牌值对得上），不是随手糊上去的第 18 张手牌
    expect(wrapper.find('.table__my-play .card').attributes('data-value')).toBe('9');
  });

  /** 🔴 窗口满 2 项时，后代选择器**不得**跨实例数错（这是本任务单独成步的理由）。 */
  it('窗口满 2 项时，槽位限定的选择器各数到自己的那几张', () => {
    const { wrapper } = mountTable([
      { seat: 1, cards: makeCards(3, 4) },
      { seat: 2, cards: makeCards(5, 6, 7) },
    ]);
    const slots = wrapper.findAll('.table__played-slot');
    expect(slots).toHaveLength(2);
    // 逆时针座序：左槽 = 座位 2（3 张），右槽 = 座位 1（2 张）。
    expect(slots[0]!.findAll('.card')).toHaveLength(3);
    expect(slots[1]!.findAll('.card')).toHaveLength(2);
    /**
     * 见证（不是「性质」，是**危险的证明**）：**文档级**后代选择器会把两处加在一起 ——
     * 旧形态 `wrapper.findAll('.table__play-area .table__played .card')` 在这里数到 **5**（3+2），
     * 而不是任何一格的真值。这正是 `action-feedback.test.ts` 的同类写法**必须**按槽位限定的理由
     *（本片规格：两个实例下的文档级 find 会**静默数错**）。
     */
    expect(
      wrapper.findAll('.table__play-area .table__played .card'),
      '文档级后代选择器 = 两处之和（本任务必须按槽位限定的实证）',
    ).toHaveLength(5);
  });
});

/**
 * ➎ 出牌区与动作反馈（spec §5-➎ + §9.1 红线 + R656）。
 *
 * 判据三组（**每组都写死「文案 ≠ 判定」这条红线**）：
 *  ① 错误码 → 人话：逐条对账 + `0` 不产生文案 + 未知码兜底带码；
 *  ② **纯查表**：模块只 import `ErrCode`、函数**只有 code 一个入参**、模块内不得出现
 *     `cards`/`hand`/`view`/`lastPlayedHand`/`isValid` 这类「拿着牌面做判断」的痕迹；
 *  ③ 交互面：出牌区按**服务端窗口**渲染（协议 ④ 窗口 2：每侧一格，「不出」= `cards: null`）；
 *     被拒时**不产生任何展示**；**按钮的禁用只由 busy/轮次决定**（不得因牌面而禁用）。
 *     ⚠️ Task B2 起本地回声气泡（旧形态：「ack 0 ⇒ 本地造一颗气泡」）整条退役 ——
 *     两条气泡用例各自处置（**不许静默少一条**）：
 *       · 「过牌 ⇒ 出不出气泡」⇒ **成对迁移**到服务端窗口（本文件下半段）；
 *       · 「不抢 ⇒ 出气泡」⇒ **删除**：叫抢回显由 Task B3 的 `bidPhase.decisions` 驱动，
 *         B3 补上新形态的判据（服务端没有「不出」之外的本地回声可测了）。
 *
 * ⚠️ 交互面照 `table-play-ui.test.ts` 的 `mountTable` 装配（`startGameSession` + pinia +
 * `store.setRoom`），并用 `FakeSocket` **记下的 ack 回调**手工造服务端应答。
 * `afterEach` 必须 unmount：`useCountdown` 在挂载时就起了 250ms 的 `setInterval`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ErrCode, type PlayerView } from '@fight-the-landlord/protocol';
import { actionCopyFor, actionErrorMessage } from '../src/net/action-copy';
import { startGameSession, stopGameSession, getGameSession } from '../src/composables/useGameSession';
import { useGameStore } from '../src/stores/game';
import TablePage from '../src/pages/table/table.vue';
import { bidPhase } from './helpers/bid-phase';
import { FakeSocket, playerViewFixture, serverMessage, makeCards } from './helpers/fake-socket';
import { installUniStub } from './helpers/uni-stub';
import { collectSourceFiles, stripComments } from './helpers/source-scan';

describe('➎ 错误码 → 人话（只做文案，不做规则判定）', () => {
  it.each([
    [ErrCode.ILLEGAL_ACTION, '服务端判定这手牌不合法，换一手再试'],
    [ErrCode.INVALID_CARDS, '选中的牌无法组成合法牌型（服务端判定）'],
    [ErrCode.VERSION_CONFLICT, '牌局状态有更新，正在同步…'],
    [ErrCode.GAME_OVER, '本局已经结束'],
    [ErrCode.RATE_LIMITED, '操作太频繁，请稍后再试'],
    [ErrCode.UPSTREAM_UNAVAILABLE, '服务暂时不可用，请稍后重试'],
    [ErrCode.ACTION_TIMEOUT, '这一步超时了，已由服务端处理'],
    [ErrCode.GAME_NOT_STARTED, '本局还没开始'],
    /**
     * 2026-10-13 用户反馈补登：13010 此前**没有表项** ⇒ 重连失败时玩家看到的是
     * 调试兜底串「[13010] back_to_lobby — No recoverable game to reconnect to」
     * （英文+内部动作名，真机截图实证）。文案是**去尾**款（同 12011 的教训：
     * 导航守卫不发导航时，尾句「已回到大厅」会失真）。
     */
    [ErrCode.RECONNECT_RECORD_MISSING, '没有可恢复的对局'],
  ])('码 %i → %s', (code, copy) => {
    expect(actionErrorMessage(code)).toBe(copy);
  });

  /**
   * 12003（NOT_YOUR_TURN）的处置 = IGNORE ⇒ `actionErrorMessage` 不再产出文案；
   * 但会话提示通道仍可通过 `actionCopyFor` 取到那句「现在还没轮到你」。
   */
  it('12003（IGNORED）⇒ actionErrorMessage 空串；actionCopyFor 仍给「现在还没轮到你」', () => {
    expect(actionErrorMessage(ErrCode.NOT_YOUR_TURN)).toBe('');
    expect(actionCopyFor(ErrCode.NOT_YOUR_TURN)).toBe('现在还没轮到你');
  });

  /**
   * 本片 C14（2026-10-12「返回大厅」弃局出口 + 匹配守卫）：12011 的玩家文案**逐字**。
   *
   * ⚠️ **去尾**：规格 §0.3-2 裁定的定稿是「你还有未结束的对局或房间」——**不带**
   * 「，已返回牌局」尾句（`store.roomCode` 空时导航守卫不发导航，尾句会失真；v1.0 的
   * 带尾版本是残留笔误，v1.1.1 已勘误）。这条按**全等式**钉住，多一个逗号都会红。
   * 语境：进行中与等待房共用这一句（中性款——等待房语境下「对局未结束」会误导）。
   */
  it('本片 C14：12011（在局/在房守卫）⇒「你还有未结束的对局或房间」（逐字、去尾）', () => {
    expect(actionErrorMessage(ErrCode.ALREADY_IN_GAME)).toBe('你还有未结束的对局或房间');
  });

  it('成功码 0 **不得**产生任何文案（成功不报错）', () => {
    expect(actionErrorMessage(ErrCode.OK)).toBe('');
  });

  it('未知码兜底中性化（不再带码）', () => {
    expect(actionErrorMessage(424242)).toBe('操作未成功，请稍后重试');
  });

  it('纯查表：action-copy 只再导出 copy.ts，不引入规则面', () => {
    const file = collectSourceFiles().find((f) => f.path === 'src/net/action-copy.ts');
    expect(file).toBeDefined();
    const targets = [...file!.content.matchAll(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(targets.sort()).toEqual(['./copy']);
    const copy = collectSourceFiles().find((f) => f.path === 'src/net/copy.ts')!;
    const code = stripComments(copy.content);
    expect(code).toMatch(/export function actionErrorMessage\(\s*code:\s*number\s*\)\s*:\s*string/);
    expect(code).not.toMatch(/cards|hand|lastPlayed|isValid|canBeat|牌型\s*=/);
  });
});

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

/** 出牌阶段的合法手牌：17 张、全部是合法 DouZero 值。 */
const PLAYING_HAND = makeCards(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20, 30, 3, 4);

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

describe('➎ 出牌区的交互面（窗口渲染 / 就地提示 / 禁用依据）', () => {
  it('被拒（13001）⇒ 出人话提示、**不产生任何展示**', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, landlordSeat: 1 }), 2));
    await wrapper.vm.$nextTick();

    await wrapper.find('.table__pass').trigger('click');
    // FakeSocket.emit 记下了 ack 回调 ⇒ 手工回一个「服务端拒绝」
    socket.emittedOf('game.pass')[0]!.ack(null, { code: ErrCode.ILLEGAL_ACTION });
    await flushPromises();
    await wrapper.vm.$nextTick();

    /* Task 10：服务端错误只由 session notice 呈现（`NoticeStack` 的 `session-notice` 项）。 */
    expect(
      wrapper.find('[data-notice-id="session-notice"] .notice__text').text(),
      '被拒必须出人话提示（session notice 唯一通道）',
    ).toBe(actionErrorMessage(ErrCode.ILLEGAL_ACTION));
    expect(
      wrapper.find('[data-notice-id="table-local"]').exists(),
      '服务端错误不得再写本地项（来源分流：页面只负责本地条件与 12003）',
    ).toBe(false);
    /**
     * 🔴 性质**不变**（旧断言锚在 `.table__bubble` → `.seat__pass`，2026-10-11 第三轮
     * 再迁到出牌/状态带与动作行）：被拒不是「已发生的事实」⇒ 不得产生任何「我操作了」
     * 的展示。协议 ④ 起「不出」是**服务端窗口**的原话（`cards: null`）—— 对手的挂
     * `.table__play-pass`、我的挂 `.table__my-pass`，客户端没有任何路径能在被拒后摆出来。
     * ⚠️ 这里刻意**不**按槽位限定（与文件里其余几处的纪律相反）：本断言问的是
     * 「**整页**有没有「不出」」，两类选择器一起盖住。
     */
    expect(wrapper.findAll('.table__play-pass'), '被拒后对手列不得有「不出」').toHaveLength(0);
    expect(wrapper.findAll('.table__my-pass'), '被拒后我的动作行不得有「不出」').toHaveLength(0);
    /**
     * 正对照：轮到我时动作行**确实在渲染按钮**（证明上面的「0 个」不是「页面上什么都没画」）。
     */
    expect(wrapper.find('.table__actions .table__play').exists()).toBe(true);
    expect(wrapper.find('.table__actions .table__pass').exists()).toBe(true);
    /**
     * 正对照②：服务端窗口推进、轮到别人（currentPlayer=1）后，我上一手（王，data-value 20）
     * 在原按钮位渲染、按钮消失 —— 出牌槽始终只显示**服务端窗口里那一手**，与被拒无关。
     */
    socket.push(
      serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 1, version: 3 }), 3),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__action-bar .table__my-play .card').attributes('data-value')).toBe('20');
    expect(wrapper.find('.table__play').exists()).toBe(false);
  });

  /**
   * Task 10（提示单通道）新语义：一次拒绝的两种来源各自独立——
   *  - 12003（`IGNORE_WITH_COPY_CODES`）由请求方写本地项 `table-12003`，**不进** session notice；
   *  - 其余非 0 码只走 session notice（`source:'action'`），页面**不写**本地文案。
   * 下一次动作开始时清本地项（`table-12003` / `table-local`）；session notice 按自身 TTL
   * 存在，**不得**因本地项清空而复制出第二条（旧 `suppressedNoticeText` 的「复活」语义已退役）。
   */
  it('下一次动作只清本地项；session notice 独立存在且不复制出第二条', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, landlordSeat: 1 }), 2));
    await wrapper.vm.$nextTick();

    // ① 12003：CLIENT_ACTION = IGNORE ⇒ 执行器不播报；请求方就地提示一次（本地项）。
    await wrapper.find('.table__pass').trigger('click');
    socket.emittedOf('game.pass')[0]!.ack(null, { code: ErrCode.NOT_YOUR_TURN });
    await flushPromises();
    await wrapper.vm.$nextTick();
    expect(getGameSession().notice.value, '12003 不进 session notice（IGNORE）').toBeNull();
    expect(
      wrapper.find('[data-notice-id="table-12003"] .notice__text').text(),
      '12003 由请求方就地提示一句人话',
    ).toBe(actionCopyFor(ErrCode.NOT_YOUR_TURN));

    // ② 下一次动作：本地项被清掉；服务端拒绝只由 session notice 呈现（恰好一条）。
    await wrapper.find('.table__pass').trigger('click');
    await wrapper.vm.$nextTick();
    expect(
      wrapper.find('[data-notice-id="table-12003"]').exists(),
      '下一次动作开始 ⇒ 本地项清除',
    ).toBe(false);
    socket.emittedOf('game.pass')[1]!.ack(null, { code: ErrCode.INVALID_CARDS });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(getGameSession().notice.value).toMatchObject({
      source: 'action',
      text: actionErrorMessage(ErrCode.INVALID_CARDS),
    });
    expect(
      wrapper.findAll('[data-notice-id="session-notice"] .notice__text'),
      '服务端拒绝只渲染一条（session notice），页面不复制本地副本',
    ).toHaveLength(1);
    expect(
      wrapper.find('[data-notice-id="table-local"]').exists(),
      '服务端错误不得再写本地项',
    ).toBe(false);

    // ③ 再下一次动作：session notice 仍在 store（TTL 未到，无事件清它）⇒ 页面仍只渲染一条。
    await wrapper.find('.table__pass').trigger('click');
    await wrapper.vm.$nextTick();
    expect(getGameSession().notice.value, '前置：session notice 仍在 store 中').not.toBeNull();
    expect(
      wrapper.findAll('[data-notice-id="session-notice"] .notice__text'),
      'session notice 按自身 TTL 存在，页面只渲染一条（不因本地项清空而复制）',
    ).toHaveLength(1);
    socket.emittedOf('game.pass')[2]!.ack(null, { code: 0 });
    await flushPromises();
  });

  /**
   * 手感判据（Task 10 复审修正）：12003（UI 过期 / 没轮到）在 `CLIENT_ACTION` 里是
   * IGNORE，提示来源被分流到「请求方就地提示」，但**触感不随来源分流改变** ——
   * 基线是任何非 0 ack 都长震「被拒」（heavy 走 `uni.vibrateLong`，~400ms）。
   * 曾因在 `haptic("heavy")` 之前提前 return，12003 只剩文案、零触感。
   *
   * 判别力（变异验证）：删掉 12003 分支的 `haptic("heavy")` ⇒ `vibrateLong` 为 0，本用例红。
   */
  it('12003（NOT_YOUR_TURN）⇒ 就地提示一次 + 长震（与其余非 0 被拒同手感）', async () => {
    // 全新替身 ⇒ 计数从 0 起，只反映本用例的动作（全局 setup 装的替身计数跨用例累积）。
    const uniStub = installUniStub();
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, landlordSeat: 1 }), 2));
    await wrapper.vm.$nextTick();

    await wrapper.find('.table__pass').trigger('click');
    socket.emittedOf('game.pass')[0]!.ack(null, { code: ErrCode.NOT_YOUR_TURN });
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(
      wrapper.find('[data-notice-id="table-12003"] .notice__text').text(),
      '前置：12003 由请求方就地提示一句人话',
    ).toBe(actionCopyFor(ErrCode.NOT_YOUR_TURN));
    expect(uniStub.calls.vibrateLong, '12003 被拒必须长震一次（heavy）').toBe(1);
    expect(uniStub.calls.vibrateShort, '12003 不是轻触确认，不得落到短震档').toBe(0);
  });

  /**
   * 未知码（Task 10 的「unknown」面）：`CLIENT_ACTION` 查不到 ⇒ 执行器兜底 TOAST；
   * 玩家文案走 `playerMessage` 的中性兜底（**不带码**——码只进 reporter）。
   * 页面同样不写本地项（来源分流）。
   */
  it('未知码（424242）⇒ session notice 中性文案、无本地项、不带码', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, landlordSeat: 1 }), 2));
    await wrapper.vm.$nextTick();

    await wrapper.find('.table__pass').trigger('click');
    socket.emittedOf('game.pass')[0]!.ack(null, { code: 424242 });
    await flushPromises();
    await wrapper.vm.$nextTick();

    const text = wrapper.find('[data-notice-id="session-notice"] .notice__text').text();
    expect(text, '未知码兜底中性文案').toBe('操作未成功，请稍后重试');
    expect(text, '码不得带给玩家').not.toContain('424242');
    expect(wrapper.find('[data-notice-id="table-local"]').exists()).toBe(false);
  });

  /**
   * 🔴 **成对迁移**（协议 ④ / Task B2；第三轮布局**再迁一次**）：旧形态是「点 `.table__pass`
   * ⇒ ack 0 ⇒ **本地造**一颗「不出」气泡，下一版快照到达后清」；协议 ④ 改为「**服务端窗口**
   * 给了 `cards: null`」；第三轮起我的「不出」挂在动作行**原按钮位**（`.table__my-pass`，
   * 出牌后按钮消失、原位显「不出」），窗口推进（那一手落出窗口）时随之消失。
   * ⚠️ **不再依赖 ack** —— 它现在是服务端事实，客户端没有「造」这一手的能力。
   * ⚠️ 用例夹具必须是「**不是我的回合**」（我 pass 后行动者本就换成别人）：轮到我时按钮优先，
   * 动作行不显「不出」。
   */
  it('服务端窗口给了 cards: null（座位 0，非我回合）⇒ 「不出」占动作行原按钮位；窗口推进后消失', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({ seat: 0, currentPlayer: 1, recentActions: [{ seat: 0, cards: null }] }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    // 「不出」不占出牌槽：`.table__my-play` 此时**不存在**（cards 为 null 的一手不挂 PlayArea）。
    expect(wrapper.find('.table__my-play').exists()).toBe(false);
    // 按钮整个消失（不是 disabled），原位只显示「不出」。
    expect(wrapper.find('.table__play').exists()).toBe(false);
    expect(wrapper.find('.table__pass').exists()).toBe(false);
    const note = wrapper.find('.table__action-bar .table__my-pass');
    expect(note.exists(), '「不出」必须占**原按钮位**（服务端说座位 0 这一手没出牌）').toBe(true);
    expect(note.text()).toBe('不出');
    // 出牌槽的旧黑药丸分支已删，整页都不该再出现它。
    expect(wrapper.find('.table__pass-note').exists()).toBe(false);

    // 窗口推进两拍 ⇒ 那一手落出窗口 ⇒ 我这一侧不再有内容（对手两家都是真牌 ⇒ 也没有「不出」）。
    // （旧形态靠「下一版快照到达即清」；新形态由**服务端窗口本身**表达 ⇒ 同样**零本地计时器**。）
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({
          seat: 0,
          currentPlayer: 1,
          version: 3,
          recentActions: [
            { seat: 1, cards: makeCards(5) },
            { seat: 2, cards: makeCards(6) },
          ],
        }),
        3,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__my-play').exists()).toBe(false);
    expect(wrapper.findAll('.table__my-pass')).toHaveLength(0);
    expect(wrapper.findAll('.table__play-pass')).toHaveLength(0);
  });

  it('按钮禁用只由 busy/轮次决定：首出（窗口里没有出牌项）时 `.table__pass` 仍可点（F01 不回退）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    socket.push(serverMessage('game.state_update', playingView({ seat: 0, currentPlayer: 0, recentActions: [], landlordSeat: 1 }), 2));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.table__pass').attributes('disabled')).toBeUndefined();
    await wrapper.find('.table__pass').trigger('click');
    expect(socket.emittedOf('game.pass')).toHaveLength(1);
  });

  it('出牌区按窗口渲染（R656；不伪造三家历史；归属标签已按用户裁决删除）', async () => {
    const { wrapper, socket } = mountTable({ mySeat: 0 });
    // 窗口里那一手是**座位 1** 出的（不是我）⇒ mySeat=0 逆时针座序下落**右槽**（下家，`seats[1]` = 1）
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({ seat: 0, currentPlayer: 0, recentActions: [{ seat: 1, cards: makeCards(20) }] }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();

    /**
     * ⚠️ **必须按槽位限定**（Task B2）：本页现在**最多两个** `PlayArea` 实例（窗口 2）——
     * 旧的文档级写法 `.table__play-area .table__played .card` 在两个实例下会数到**两处之和**
     *（`table-play-area-window.test.ts` 里有一条「见证」断言实测 = 2+3）。窄到槽位之后，
     * `slots[0]` 才是**有内容的那一格**（空槽不渲染，`seats` 已按 mySeat 过滤）。
     */
    const slots = wrapper.findAll('.table__played-slot');
    expect(slots, '窗口里只有一条 ⇒ 只有下家（右列）那槽有内容').toHaveLength(1);
    const played = slots[0]!.findAll('.card');
    expect(played, '出牌区只渲染窗口里**那一项**（1 张），不得伪造三家历史').toHaveLength(1);
    expect(played[0]!.attributes('data-value')).toBe('20');
    // 归属标签「玩家1 出」已按 2026-10-11 用户裁决删除（牌在谁一侧即谁出，标签冗余）——
    // 反向断言防腐烂：任何槽位都不得再渲染归属标签。
    expect(slots[0]!.find('.table__played-owner').exists()).toBe(false);

    // 反向：还没有人出过牌 ⇒ 空窗口 ⇒ 没有任何出牌槽/占位（走查修复：中央「（无）」已删），
    // 没有「不出」回显。
    socket.push(
      serverMessage(
        'game.state_update',
        playingView({ seat: 0, currentPlayer: 1, version: 3, recentActions: [] }),
        3,
      ),
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.table__played-slot')).toHaveLength(0);
    expect(wrapper.findAll('.table__play-area')).toHaveLength(0);
    expect(wrapper.findAll('.table__play-pass')).toHaveLength(0);
    expect(wrapper.findAll('.table__my-pass')).toHaveLength(0);
    expect(wrapper.find('.table__played-owner').exists()).toBe(false);
  });

  /**
   * 🔴 **换锚点**（Task B2）：原锚点守的是「气泡的**清除时机**」——那条 watch
   *（`watch(() => store.currentVersion, …)`）随本地回声整条退役，机制**已经不存在**了。
   * 锚点必须跟着**性质**走（不得留着一条恒红的锚、也不得直接删）：
   * 新性质 = **出牌区按服务端窗口渲染**（`actionOf(seat)` 的座位分派），且本地回声零残留。
   */
  it('出牌区按**窗口**渲染（源码里存在 `actionOf(seat)` 的座位分派），本地回声零残留', () => {
    const table = collectSourceFiles().find((f) => f.path === 'src/components/table/ddz/DdzBoard.vue');
    expect(table, '源码扫描器必须真的读到 DdzBoard.vue').toBeDefined();
    // 存在性断言读**原始文本**（R572/R622：剥注释视图只给违规类断言用）
    const perSeatDispatch = /actionOf\(/;
    expect(
      table!.content,
      '窗口渲染必须是按座位分派的（`actionOf(seat)`）—— 「最近一手」的旧分派（`playedAt`）已退役',
    ).toMatch(perSeatDispatch);
    // 正对照：没有这条分派的样本不被命中（否则本判据可能只是恒真）
    expect('const noDispatchHere = 1;').not.toMatch(perSeatDispatch);
    /**
     * 负向锚点（**违规类** ⇒ 读剥注释视图，R572/R622）：本地回声不得复活 ——
     * 它守的是同一条性质的另一面：「谁刚过了牌」的唯一来源是**服务端窗口**。
     * 解释这段历史（「气泡已退役」）的注释不该把闸打红。
     */
    expect(
      stripComments(table!.content),
      '本地回声气泡（bubble）不得复活：`cards: null` 的服务端窗口是唯一来源',
    ).not.toMatch(/bubble/);
  });
});

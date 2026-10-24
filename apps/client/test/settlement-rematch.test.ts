/**
 * ➑「再来一局」（R658 + 片③ R760）：牌桌只**写下意向**并回**玩法页**；
 * `room.match` 仍只有**玩法页**一处实现。
 *
 * 判别力说明（五条各打一个面，都不碰规则）：
 *  ① **store 单元**：`requestRematch()` 写意向；`consumeRematch()` **读后即清**
 *     ⇒ 第二次必须返回 `false`（否则「回玩法页」/刷新会把上一局的意向重复兑现成一次匹配）。
 *  ② **store 生命周期**：`reset()`（换局 / 销毁会话边界）必须把它清掉 —— 与
 *     `game-store-session-reset.test.ts` 同一条纪律：上一局的意图不得跨局存活。
 *  ③ **组件级**：`.settlement__again` ⇒ `emit('again')`；`.settlement__lobby` ⇒ `emit('back')`
 *     （逐按钮各发各的，证明两个锚点不是同一件事的两个名字）。
 *  ④ **页面级**：`table.vue` 收到 `again` ⇒ **恰好两件事** —— 写意向 + `auth.page === 'game'`
 *     （片③ R760：消费意向的 `match()` 在玩法页）；全程**没有** `room.match`（匹配的唯一实现在玩法页）。
 *  ⑤ **源码级**：`game.vue` 里 `send('room.match'` **仍恰好 1 处**
 *     （同 `lobby-ux.test.ts` 对 `room.join` 的同形判据 —— 不得复制第二份实现）。
 *
 * ⚠️ 夹具约束：`game.settlement` 载荷必须**分数守恒**（`777 + (-388.5 × 2) === 0`），
 * 否则 `validateInbound` 会先抛，根本到不了 UI（`table-settlement-ui.test.ts` 同款）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { SettlementResult } from '@fight-the-landlord/protocol';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
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

/** 与 `table-settlement-ui.test.ts` 同款：数字**乘不出来**（`100 × 4 ≠ 777`），但分数守恒。 */
const FIXTURE: SettlementResult = {
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

describe('R658「再来一局」：一次性意向 + 回大厅（room.match 不复制）', () => {
  it('① requestRematch() 写意向；consumeRematch() 读后即清（第二次 false，幂等）', () => {
    const store = useGameStore();
    expect(store.rematchPending, '起始态不得有意向').toBe(false);

    store.requestRematch();
    expect(store.rematchPending).toBe(true);

    expect(store.consumeRematch(), '第一次必须消费掉').toBe(true);
    expect(store.rematchPending, '读后即清').toBe(false);
    expect(store.consumeRematch(), '第二次必须 false（幂等，不得重复兑现）').toBe(false);
  });

  it('② reset() 清掉 rematchPending（换局边界不得把上一局的意向带过去）', () => {
    const store = useGameStore();
    store.requestRematch();
    expect(store.rematchPending).toBe(true);

    store.reset();

    expect(store.rematchPending, 'reset 必须清掉意向').toBe(false);
    // 正对照：reset 之后消费必须是 false —— 否则这条与「reset 什么也没做」不可区分
    expect(store.consumeRematch()).toBe(false);
  });

  it('③ 组件级：点 .settlement__again ⇒ emit again；点 .settlement__lobby ⇒ emit back', async () => {
    const w = mount(Settlement, { props: { settlement: FIXTURE } });
    mounted.push(w);

    // 正对照起点：两个事件此刻都还没有
    expect(w.emitted('again')).toBeUndefined();
    expect(w.emitted('back')).toBeUndefined();

    await w.get('.settlement__again').trigger('click');
    expect(w.emitted('again'), '.settlement__again 必须 emit again').toHaveLength(1);
    expect(w.emitted('back'), 'again 不得污染 back').toBeUndefined();

    await w.get('.settlement__lobby').trigger('click');
    expect(w.emitted('back'), '.settlement__lobby 必须 emit back').toHaveLength(1);
    expect(w.emitted('again'), 'back 不得污染 again').toHaveLength(1);
  });

  it('④ 页面级：table.vue 收到 again ⇒ auth.page=game 且 rematchPending=true（牌桌不发 room.match）', async () => {
    const socket = new FakeSocket();
    startGameSession(() => socket);
    const store = useGameStore();
    const auth = useAuthStore();
    store.setRoom('ROOM1', 0);
    const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
    mounted.push(wrapper);

    socket.push(
      serverMessage(
        'game.state_update',
        playerViewFixture({
          state: 'playing',
          version: 2,
          seat: 0,
          landlordSeat: 0,
          bottomCards: makeCards(3, 4, 5),
        }),
        2,
      ),
    );
    await wrapper.vm.$nextTick();
    // 起点：结算面板尚未出现（探针能观测到「不存在」）
    expect(wrapper.find('.settlement__again').exists()).toBe(false);

    socket.push(serverMessage('game.settlement', FIXTURE, 3));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.settlement__again').exists()).toBe(true);

    await wrapper.get('.settlement__again').trigger('click');

    expect(store.rematchPending, '牌桌只写下意向').toBe(true);
    expect(auth.page, '牌桌把用户送回**玩法页**（房间列表与开局按钮在那里，R760）').toBe('game');
    // R658/R760：匹配的唯一实现在玩法页 —— 牌桌侧一条 room.match 都没有
    expect(socket.emittedOf('room.match'), '牌桌不得复制第二份匹配实现').toHaveLength(0);
  });

  it("⑤ 源码级：game.vue 里 send('room.match' 仍恰好 1 处（读**剥注释**视图，R572/R622）", () => {
    /**
     * ⚠️ 片③ Task 3 的**迁移**（R761）：`room.match` 的唯一实现随开局区搬到了**玩法页**
     * ⇒ 本条**跟着实现走**（继续指着 `lobby.vue` 只会数到 0 处 —— 那里已经没有匹配了）。
     * **判别力不降**：仍是「同一处实现恰好 1 个调用点」，且下面两条合成样本的正/反对照照旧。
     */
    const game = collectSourceFiles().find((f) => f.path === 'src/pages/game/game.vue');
    expect(game, 'game.vue 必须存在（否则本条恒绿）').toBeDefined();
    /**
     * ⚠️ R572/R622：**计数类**断言同样读剥注释视图 —— 本仓的注释习惯是逐字引用真实写法
     *（`table.vue` 的 JSDoc 就点名了 `send('room.match'`），按原始文本计数会把
     * 「解释」当成第二处实现。
     */
    const code = stripComments(game!.content);
    // 引号风格不限（仓内格式化器会输出双引号）。
    const callSites = [...code.matchAll(/send\(\s*(['"])room\.match\1/g)];
    expect(callSites, '同一条 room.match 只能有一种实现').toHaveLength(1);
    // 正对照：合成样本里「注释 1 处 + 真代码 1 处」⇒ 剥注释后**只剩真代码那 1 处**。
    const synthetic = [
      "// 反例：这里解释为什么不能有第二处 send('room.match'",
      "const outcome = await client.send('room.match', { mode: 'random' });",
    ].join('\n');
    expect(
      [...stripComments(synthetic).matchAll(/send\(\s*(['"])room\.match\1/g)],
      '注释里的同名写法不得被计入（否则「解释」会被算成第二处实现）',
    ).toHaveLength(1);
    // 反向对照：这条正对照不是「什么字符串都命中」
    expect([...stripComments('const x = 1; // 无匹配').matchAll(/send\(\s*'room\.match'/g)]).toEqual([]);
  });
});

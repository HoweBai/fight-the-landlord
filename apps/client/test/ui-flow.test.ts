/**
 * 前端 UI 走查（**默认跳过**，需要 mock/真实后端在跑）。
 *
 * 运行方式：
 *   CLIENT_E2E=1 pnpm test
 *
 * 它验证的是「页面真的能渲染服务端下发的数据」这件事——契约测试只覆盖纯逻辑，
 * 抓不到模板里绑错字段这类问题（例如把 `bidPhase.currentBidder` 写成 `currentPlayer`）。
 */
import { describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { io } from 'socket.io-client';
/**
 * ⚠️ 切片 P10 Task 3：过渡期的「页壳」（`src/pages/index/index.vue`，按 `auth.page` 三分支渲染）
 * 已被 `pages.json` 的**真实页面栈**取代并被删除。生产里换页由 `auth.navigate()` → `uni.reLaunch`
 * 完成；单测里没有页面栈（`uni` 是替身，`reLaunch` 只记账）⇒ 用例自己按 `auth.page` 换挂载的页面。
 * **语义不变**：仍然是「登录 → 大厅 → 牌桌，每一步都渲染服务端下发的数据」。
 */
import LoginPage from '../src/pages/login/login.vue';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import GamePage from '../src/pages/game/game.vue';
import TablePage from '../src/pages/table/table.vue';
import { createSocketIoFactory } from '../src/net/transport';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import type { RouteName } from '../src/router';

/** page → 页面组件。**仅测试脚手架**：生产里这张表就是 `pages.json` 声明的页面栈。 */
const PAGES = { login: LoginPage, lobby: LobbyPage, game: GamePage, table: TablePage } as const;

function mountPage(pinia: ReturnType<typeof createPinia>, page: RouteName): VueWrapper {
  return mount(PAGES[page], { global: { plugins: [pinia] } });
}

const ENABLED = process.env.CLIENT_E2E === '1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!ENABLED)('UI 走查（对 mock / 真实后端）', () => {
  it(
    '登录 → 大厅 → 匹配 → 牌桌：手牌/底牌/地主都来自服务端裁剪视图',
    async () => {
      const pinia = createPinia();
      setActivePinia(pinia);
      const session = startGameSession(createSocketIoFactory(io));
      const auth = useAuthStore();
      const store = useGameStore();
      let wrapper = mountPage(pinia, 'login');

      try {
        // 登录页 → 大厅（开发身份，直连 mock）：navigate() 把 page 写进唯一真源
        auth.enterAsDevUser();
        expect(auth.page).toBe('lobby');
        wrapper.unmount();
        wrapper = mountPage(pinia, auth.page);
        await wrapper.vm.$nextTick();
        /**
         * ⚠️ 片③ R745/R749（评审修复轮 1 的**迁移**）：开局区搬到了**玩法页**
         * ⇒ 先在大厅点玩法卡（**只切换选中**）、再点底分卡进入，然后在玩法页上断言文案。
         * 判据没变（「页面真的渲染出来」），只是断言对象跟着实现走。单测里没有页面栈 ⇒ 换页仍由
         * 用例自己按 `auth.page` 重挂（见文件顶注释）。
         */
        expect(wrapper.find('.lobby__mode').exists(), '大厅必须有玩法卡（R762）').toBe(true);
        await wrapper.find('.lobby__mode').trigger('click');
        expect(auth.page, '点玩法卡**只切换选中**、不跳页（片规格 §3 裁决一）').toBe('lobby');

        /**
         * 底分卡的数据来自 REST（走查跑在**真后端**上 ⇒ 真 I/O，一个微任务等不到）
         * ⇒ **先有界地等它出现，再无条件点它**。
         *
         * 🔴 **不得写成 `if (wrapper.find('.lobby__level').exists()) { … } else { auth.navigate('game') }`**
         * （初稿就是这么写的，复核时判为**恒真**）：那种写法下「点底分卡」这一步
         * **一次都没点过**，而且照样绿 —— 换成「点底分卡什么也不做」的实现也绿。
         * 本用例的判别力**全在**「点了它、页面才变成 game」这一条上。
         * ⚠️ 用文件里既有的 `sleep`（`ui-flow.test.ts:38`）而不是 `vi.waitFor`：本文件没 import `vi`。
         */
        for (let i = 0; i < 40 && !wrapper.find('.lobby__level').exists(); i += 1) {
          await sleep(250);
          await wrapper.vm.$nextTick();
        }
        expect(wrapper.find('.lobby__level').exists(), '大厅必须渲染出底分卡（真后端下 REST 应当已回）').toBe(true);
        await wrapper.find('.lobby__level').trigger('click');
        expect(auth.page, '点底分卡才进开始游戏页（片规格 §3 裁决一）').toBe('game');
        wrapper.unmount();
        wrapper = mountPage(pinia, auth.page);
        await wrapper.vm.$nextTick();
        expect(wrapper.html(), '主按钮文案按规格 §4 是「开始游戏」').toContain('开始游戏');

        // 协议②（片规格 §2.4）：`baseScore` 必填 —— 15 = 档位表里的最小档（缺省档）。
        const matched = await session.client.send('room.match', { mode: 'random', baseScore: 15 });
        expect(matched.status === 'sent' && matched.code).toBe(0);
        await sleep(400);
        // room.matched 推送后应自动进牌桌
        expect(auth.page).toBe('table');
        expect(store.roomCode).toBeTruthy();

        // R50：room.matched 之后前端已自动 room.join（不必也不该再发一次）。
        // ⚠️ N38：这里原有一条断言「store 里的房间成员列表长度为 3」，钉的是一簇**零消费者**的
        // 死状态（客户端从来不缓存房间成员列表；张数来源是 `PlayerView.cardCounts`）。
        // 「自动 join 真的发了且恰好一次」由 `room-matched-join.test.ts` 的
        // `socket.emittedOf('room.join')` 计数断言覆盖，判据没有被放宽。
        await sleep(400);

        // 叫抢阶段：底牌恒为 null（§6.4），state === 'bidding'
        expect(store.view?.state).toBe('bidding');
        expect(store.bottomCards).toBeNull();
        expect(store.hand.length).toBe(store.cardCounts[store.mySeat!]);

        // 进牌桌（页面栈的投影在单测里由用例自己完成）
        wrapper.unmount();
        wrapper = mountPage(pinia, auth.page);
        await wrapper.vm.$nextTick();

        const bid = await session.client.send('game.bid', { grab: true });
        expect(bid.status === 'sent' && bid.code).toBe(0);
        await sleep(400);
        await wrapper.vm.$nextTick();

        const html = wrapper.html();
        // 叫抢结束后：地主确定、底牌可见、手牌 20 张
        expect(store.landlordSeat).not.toBeNull();
        expect(store.bottomCards).not.toBeNull();
        expect(html).toContain('地主');

        // 手牌 + 底牌 + 上一手牌全部渲染出来（每张一个 Card 组件）
        const renderedCards = wrapper.findAllComponents({ name: 'Card' }).length;
        expect(renderedCards).toBeGreaterThanOrEqual(store.hand.length);
      } finally {
        wrapper.unmount();
        stopGameSession();
      }
    },
    25_000,
  );
});

/**
 * C19（片⑦ 规格 §2.8 / §3）：好友房入口的 **fail-safe 门控**。
 *
 * `stores/game.ts` 的 `friendRoomEnabled` **初值写死 `false`**；`GET /api/config`
 * 失败 ⇒ 保持 `false`（**未知 = 隐藏**，不是 fail-open）；成功且 `true` ⇒ 入口渲染。
 *
 * 判别矩阵（每一格都对应一种"最像正确答案"的错实现，缺一格就放它逃逸）：
 *  ① 初值格：`=== false`（**不是** `undefined`/`null` —— 那会让入口在配置到达前闪现，
 *     且 `v-if` 对 `undefined` 恒假只是巧合，换个写法就漏）；
 *  ② 失败格：信封非 0 ⇒ `false` ⇒ **入口不渲染**（拦「配置未知 ⇒ 索性显示入口」的 fail-open）；
 *  ③ 回写格：先成功后失败 ⇒ 开关被**写回 `false`**（拦「失败分支只写空表、不动开关」
 *     —— 故障期会把上一次的 `true` 继续放行）；
 *  ④ 成功且 `false` 格：不渲染（拦「拿到配置就显示」—— 它无视布尔值本体）；
 *  ⑤ 成功且 `true` 格：渲染（拦「永远隐藏」）。
 *
 * ⚠️ 渲染格挂**真实页面**（`game.vue`）而不是只断 store：C19 的谓语是「入口**不渲染**」，
 * 只断 store 字段的话，「`v-if` 绑错字段 / 根本没绑」这类实现在这里全绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import GamePage from '../src/pages/game/game.vue';
import { useGameStore } from '../src/stores/game';
import { useAuthStore } from '../src/stores/auth';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { FakeSocket } from './helpers/fake-socket';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  clientConfig.token = '';
});

afterEach(() => {
  stopGameSession();
  clearSession();
  vi.restoreAllMocks();
});

/**
 * `fetch` 替身：按 URL 分流。
 *
 * ⚠️ **对象是活的**：fetch 闭包在**每次请求时**重新读 `routes` ⇒ 用例可以在两次挂载之间
 * 改写 `routes['/config']`（③ 回写格正是这么驱动的）。
 * fallback 覆盖玩法页挂载时的 `GET /api/rooms`。
 */
function stubRoutes(routes: Record<string, unknown>, fallback: unknown = { code: 0, data: [] }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => url.includes(k));
      return { ok: true, status: 200, text: async () => JSON.stringify(key ? routes[key] : fallback) };
    }),
  );
  return calls;
}

/** ② 金币场：配置夹具按 7 键给全（本文件只消费 `friendRoomEnabled`，其余给服务端缺省态值）。 */
const CONFIG_TRUE = {
  code: 0,
  data: {
    baseScoreLevels: [
      { name: '休闲场', baseScore: 15 },
      { name: '标准场', baseScore: 80 },
    ],
    friendRoomEnabled: true,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    entryMultiplier: 10,
    version: 7,
  },
};

const CONFIG_FALSE = {
  code: 0,
  data: {
    baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
    friendRoomEnabled: false,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    entryMultiplier: 10,
    version: 8,
  },
};

const CONFIG_FAILED = { code: 10007, message: '下游不可用', data: null };

/** 挂大厅（配置的**唯一取数点**，片规格 §2.8：到 game 页必经大厅挂载）。 */
function mountLobby(): VueWrapper {
  startGameSession(() => new FakeSocket());
  useAuthStore().navigate('lobby');
  return mount(LobbyPage, { global: { plugins: [pinia] } });
}

/** 挂玩法页（入口所在的页面）。 */
function mountGame(): VueWrapper {
  return mount(GamePage, { global: { plugins: [pinia] } });
}

describe('C19：好友房入口 fail-safe 门控（片⑦ §2.8）', () => {
  it('① 初值格：store 初值 = false（写死；undefined 初值 = 配置到达前闪现入口）', () => {
    const store = useGameStore();
    expect(store.friendRoomEnabled, '初值必须是布尔 false —— **不是** undefined/null').toBe(false);
  });

  it('① 初值格的渲染形态：配置从未取过（直挂玩法页）⇒ 入口不渲染', async () => {
    stubRoutes({});
    const wrapper = mountGame();
    await flushPromises();

    expect(
      wrapper.find('.game__friends-open').exists(),
      '配置未知 ⇒ 入口必须隐藏（fail-safe：未知 = 隐藏）',
    ).toBe(false);
  });

  it('② 失败格：`GET /api/config` 信封非 0 ⇒ 保持 false ⇒ 入口不渲染（拦 fail-open）', async () => {
    stubRoutes({ '/config': CONFIG_FAILED });
    const lobby = mountLobby();
    await flushPromises();
    expect(useGameStore().friendRoomEnabled, '拉取失败不得把开关改成任何"可能开着"的值').toBe(false);
    lobby.unmount();

    const wrapper = mountGame();
    await flushPromises();
    expect(
      wrapper.find('.game__friends-open').exists(),
      '配置未知时**显示**入口 = fail-open —— 本条正是拦它的那格',
    ).toBe(false);
  });

  it('② 失败格（另一半）：fetch 被拒（H5 上会抛出）⇒ 同样保持 false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    mountLobby();
    await flushPromises();

    expect(useGameStore().friendRoomEnabled, '网络故障与信封失败是同一类事实 ⇒ 同一条 fail-safe').toBe(
      false,
    );
  });

  it('③ 回写格：先成功后失败 ⇒ 开关被写回 false（不是只写空表、留着旧 true）', async () => {
    const routes: Record<string, unknown> = { '/config': CONFIG_TRUE };
    stubRoutes(routes);

    const first = mountLobby();
    await flushPromises();
    expect(useGameStore().friendRoomEnabled, '前置：第一次拉取成功且开关为 true').toBe(true);
    first.unmount();

    // 服务端故障后重新进大厅：失败分支必须把开关也写回 false
    routes['/config'] = CONFIG_FAILED;
    mountLobby();
    await flushPromises();

    expect(
      useGameStore().friendRoomEnabled,
      '失败 ⇒ 按 fail-safe 写回 false（否则故障期会拿上一次的 true 继续放行入口）',
    ).toBe(false);
  });

  it('④ 成功且 false 格：拿到配置但开关关 ⇒ 不渲染（拦「拿到配置就显示」）', async () => {
    stubRoutes({ '/config': CONFIG_FALSE });
    const lobby = mountLobby();
    await flushPromises();
    expect(useGameStore().friendRoomEnabled, '前置：配置成功到达且开关为 false').toBe(false);
    lobby.unmount();

    const wrapper = mountGame();
    await flushPromises();
    expect(
      wrapper.find('.game__friends-open').exists(),
      '开关关（服务端默认态）⇒ 不得渲染入口本体',
    ).toBe(false);
  });

  it('⑤ 成功且 true 格：开关开 ⇒ 入口渲染（拦「永远隐藏」）', async () => {
    stubRoutes({ '/config': CONFIG_TRUE });
    const lobby = mountLobby();
    await flushPromises();
    expect(useGameStore().friendRoomEnabled, '前置：配置成功到达且开关为 true').toBe(true);
    lobby.unmount();

    const wrapper = mountGame();
    await flushPromises();
    const entry = wrapper.find('.game__friends-open');
    expect(entry.exists(), '开关开 ⇒ 入口必须渲染').toBe(true);
    expect(entry.text(), '入口文案逐字保留（探针锚点）').toBe('好友房');
  });

  it('⑥ per-game 好友房：ddz 开 / pdk 关 ⇒ ddz 显示、pdk 隐藏（顶层 true 不得兜底）', async () => {
    const perGame = {
      code: 0,
      data: {
        ...CONFIG_TRUE.data,
        games: {
          doudizhu: {
            enabled: true,
            supportedPlayerCounts: [3],
            defaultPlayerCount: 3,
            baseScoreLevels: [{ name: '休闲场', baseScore: 15 }],
            freeRoomEnabled: true,
            goldRoomEnabled: false,
            friendRoomEnabled: true,
            entryMultiplier: 10,
          },
          paodekuai: {
            enabled: true,
            supportedPlayerCounts: [3],
            defaultPlayerCount: 3,
            baseScoreLevels: [{ name: '快跑场', baseScore: 80 }],
            freeRoomEnabled: true,
            goldRoomEnabled: false,
            friendRoomEnabled: false,
            entryMultiplier: 10,
          },
        },
      },
    };
    stubRoutes({ '/config': perGame });
    const lobby = mountLobby();
    await flushPromises();
    lobby.unmount();

    const store = useGameStore();
    store.setActiveMode('doudizhu');
    const ddz = mountGame();
    await flushPromises();
    expect(ddz.find('.game__friends-open').exists(), 'ddz 好友房开 ⇒ 入口渲染').toBe(true);
    ddz.unmount();

    store.setActiveMode('paodekuai');
    const pdk = mountGame();
    await flushPromises();
    expect(pdk.find('.game__friends-open').exists(), 'pdk 好友房关 ⇒ 入口隐藏').toBe(false);
    pdk.unmount();
  });
});

/**
 * 页面接线：**玩法页**（片③ 起）按 **R22** 的统一信封读房间列表、按 **§6.3/R51** 发匹配；
 * `lobby.vue` 只剩登出按钮；`login.vue` 登录后重建会话。
 *
 * 这些是「模板/接线」层面的断言——纯逻辑契约测试抓不到「绑错字段」「还在兼容裸数组」。
 *
 * ⚠️ 片③ Task 3：房间列表与匹配按钮随开局区搬到了 `pages/game/game.vue`（R749）⇒
 * 本文件里**涉及开局区的用例挂 `GamePage`**、锚点前缀 `lobby__` → `game__`。
 * 「退出」是**大厅自己的按钮**，仍挂 `LobbyPage`（它的锚点与断言一个字符没改）。
 *
 * ⚠️ **片② 客户端（本片）的两处迁移**：
 *  ① **档位表失败用例搬走了**：`match()` 此前自己 fetch `GET /api/base-score-levels`，
 *     本片把这个 fetch 搬到了**大厅**（`lobby.vue`，片规格 §3）⇒ 三条「档位表加载失败 /
 *     空表 / fetch 被拒 ⇒ 不猜底分」的判据**跟着实现走**，现在在
 *     `base-score-selection.test.ts` 的 ④ 组。性质**不降反升**：那边断言的是
 *     「**一张档位卡都不渲染**」（用户无从选），而这里的旧断言「没发 room.match」
 *     在新结构里是恒真的（开始游戏页不再关心档位表）。
 *  ② **开局三入口移进「好友房」弹层**（片规格 §4 裁决二）⇒ 读 DOM 前先 `openFriends()`。
 *     判据本身一条没少，还多了一条「关着时三个入口都不在 DOM 里」。
 *
 * ⚠️ **片⑦（配置中心）**：片⑦ 起「好友房」入口按 `store.friendRoomEnabled` **门控**
 * （C19 fail-safe，初值 `false`）⇒ 本文件 `beforeEach` 把配置预置成**开启**
 * （这些用例测的是「开关开着」时既有功能的行为；**关闭 / 失败态**的判据在
 * `friend-room-gate.test.ts` 的 C19 —— 判据一条没少，只是夹具补上「配置=开」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { ErrCode, type RoomInfo } from '@fight-the-landlord/protocol';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import GamePage from '../src/pages/game/game.vue';
import LoginPage from '../src/pages/login/login.vue';
import { clientConfig } from '../src/config';
import { clearSession, getDeviceId, loadSession, saveSession } from '../src/net/storage';
import {
  getGameSession,
  isGameSessionReady,
  startGameSession,
  stopGameSession,
} from '../src/composables/useGameSession';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import type { SocketAuth, SocketFactory } from '../src/net/transport';
import { FakeSocket, resolveHandshakeAuth, flushHandshakes, serverMessage } from './helpers/fake-socket';
import { SRC_ROOT } from './helpers/source-scan';

/** 断言模板文本时先折叠空白，避免被模板换行干扰。 */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function roomFixture(code: string, over: Partial<RoomInfo> = {}): RoomInfo {
  return {
    code,
    mode: 'random',
    status: 'waiting',
    playerCount: 1,
    maxPlayers: 3,
    baseScore: 100,
    ...over,
  };
}

/**
 * `fetch` 替身。
 *
 * `body` 既可以是**统一信封**（所有 URL 都回它），也可以是**按 URL 分流**的函数
 * （片② 客户端起，开始游戏页只剩 `GET /api/rooms` 一条 REST —— 档位表归**大厅**取；
 * 形态与 `lobby-ux.test.ts` 的 `stubFetch` 一致）。
 */
function stubFetch(body: unknown | ((url: string, init?: RequestInit) => unknown), status = 200) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(typeof body === 'function' ? body(url, init) : body),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function capturingFactory() {
  const handshakes: Array<SocketAuth> = [];
  const sockets: FakeSocket[] = [];
  const pending: Array<Promise<void>> = [];
  const factory: SocketFactory = (_url, opts) => {
    pending.push(
      resolveHandshakeAuth(opts.auth).then((resolved) => {
        handshakes.push(resolved);
      }),
    );
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const flush = async (): Promise<void> => {
    await flushHandshakes(pending);
  };
  return { factory, handshakes, sockets, flush };
}

/**
 * 打开「好友房」弹层（片规格 §4 裁决二：建房 / 房号加入 / 房间列表**整体**收进弹层）。
 *
 * ⚠️ 这三条入口的既有用例**判据一条没少**，只是动手前多一步「用户真的点开了它」——
 * 而这正是弹层形态的语义：**关着的时候它们不在 DOM 里**。
 *
 * ⚠️ 片⑦：入口本体先过 `store.friendRoomEnabled` 门控 ⇒ 本助手读 DOM 的**前提**
 * 由 `beforeEach` 的「配置=开启」夹具保证（见文件头的片⑦ 段）。
 */
async function openFriends(wrapper: ReturnType<typeof mount>) {
  const open = wrapper.findAll('button').find((b) => flat(b.text()) === '好友房');
  expect(open, '开始游戏页必须有「好友房」入口').toBeDefined();
  await open!.trigger('click');
  await flushPromises();
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  clientConfig.token = '';
  /**
   * 片⑦ 夹具：好友房入口按配置门控（C19）⇒ 本文件测「开启」态下的既有功能。
   * 走**生产 action**（`setClientConfig`）而不是直接改 state —— 写入路径只有一条。
   * ② 金币场：配置扩到 7 键（免费场开 / 金币场关 / 救助关 / 倍率 10）—— 与本文件
   * 既有用例的语义一致（它们测的是免费场一侧的既有行为）。
   * 支付片 T14：再扩至 14 键（支付七键给**稳定的关态**——本文件无 oracle 读它们；
   * T5 起必填字段的「过渡红」由这一处补齐而在本片愈合）。
   * 广告片 T19：再加第 15 键 `reliefAdpid: ''`（未配置 ⇒ 救助入口不渲染）。
   */
  useGameStore().setClientConfig({
    baseScoreLevels: [],
    friendRoomEnabled: true,
    freeRoomEnabled: true,
    goldRoomEnabled: false,
    reliefEnabled: false,
    reliefAdpid: '',
    entryMultiplier: 10,
    rechargeEnabled: false,
    withdrawEnabled: false,
    coinPerYuan: null,
    rechargePackages: [],
    withdrawMinCoins: null,
    withdrawMaxCoinsPerOrder: null,
    withdrawDailyMaxCoins: null,
    withdrawReAuthEnabled: false,
    version: 0,
  });
});

afterEach(() => {
  stopGameSession();
  clearSession();
});

/**
 * ⚠️ 片③ Task 3：房间列表从大厅搬到了**玩法页**（R749）⇒ 本组里**读房间列表**的用例
 * （信封解析 / 裸数组 / TOAST / BACK_TO_LOBBY / 13004 重放）全部挂 `GamePage`；
 * 最后一条「退出」是**大厅自己的按钮**，仍挂 `LobbyPage`。
 */
describe('房间列表（§3.1 / R22）与大厅登出', () => {
  it('按统一信封 `{ code, message, data: RoomInfo[] }` 渲染（含 baseScore）', async () => {
    stubFetch({
      code: 0,
      message: 'ok',
      data: [roomFixture('ROOM01', { status: 'playing', playerCount: 2, baseScore: 200 })],
    });

    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();

    await openFriends(wrapper);
    const text = flat(wrapper.text());
    expect(text).toContain('ROOM01');
    expect(text).toContain('playing · 2/3 · 底分 200');
  });

  it('裸数组不再被兼容（R22 已裁决：只按信封解析）', async () => {
    stubFetch([roomFixture('ROOM02')]);

    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();

    await openFriends(wrapper);
    expect(flat(wrapper.text())).not.toContain('ROOM02');
    expect(flat(wrapper.text())).toContain('房间列表加载失败');
  });

  it('10001（TOAST）→ 只提示 message、列表清空，**不动**会话（R34）', async () => {
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const auth = useAuthStore();
    auth.hydrate();
    stubFetch({ code: 10001, message: '参数错误', data: null });

    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();

    await openFriends(wrapper);
    expect(flat(wrapper.text())).toContain('参数错误');
    expect(flat(wrapper.text())).toContain('暂无房间');
    expect(auth.loggedIn).toBe(true);
    expect(auth.page).toBe('lobby');
    expect(loadSession()).not.toBeNull();
  });

  /**
   * 片③ §9 **F7** / 本片修法（R809）：空态文案**必须走 `finished-text` prop**。
   *
   * 实测组件源码（`wot-design-uni/components/wd-loadmore/wd-loadmore.vue:12`）：
   *   `<wd-divider v-if="state === 'finished'">{{ finishedText || translate('finished') }}</wd-divider>`
   * 模板里**没有 `<slot/>`** ⇒ 写在标签之间的文案**被丢弃**，生产里显示的是组件库默认的
   * 「已加载完毕」。上面那条 `toContain('暂无房间')` 因此曾在生产里**没有对应物**
   * （片③ §9 F7 附带发现）。
   *
   * ⚠️ 这条源码级断言钉的是**形状**（文案不许再放插槽），上面那条钉的是**文案**
   * —— 两条一起才防得住「又搬回插槽」。
   */
  it('F7：空态文案走 finished-text（不得再放进插槽 —— 组件没有 slot）', () => {
    const src = readFileSync(join(SRC_ROOT, 'pages/game/game.vue'), 'utf8');    expect(src, '空态必须用 finished-text 传文案').toContain('finished-text="暂无房间"');
    expect(
      /<wd-loadmore[^>]*>\s*[^<\s]/.test(src),
      '空态文案不得写在 <wd-loadmore> 标签之间（那是被丢弃的插槽内容）',
    ).toBe(false);
  });

  for (const [code, label] of [
    [10002, '未登录'],
    [10005, '签名无效'],
  ] as const) {
    it(`${code}（BACK_TO_LOBBY）→ 销毁本地会话 + 清认证状态回登录页，且**不**调服务端登出（R34/R36）`, async () => {
      // 先建一条会话（应用启动时就有：main.ts 在 hydrate 之后无条件建连）
      const { factory, sockets } = capturingFactory();
      startGameSession(factory);
      expect(isGameSessionReady()).toBe(true);

      saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
      const auth = useAuthStore();
      auth.hydrate();
      const fetchMock = stubFetch({ code, message: label, data: null });

      mount(GamePage, { global: { plugins: [pinia] } });
      await flushPromises();

      expect(auth.loggedIn).toBe(false);
      expect(auth.page).toBe('login');
      expect(auth.userId).toBe('');
      expect(clientConfig.token).toBe('');
      expect(loadSession()).toBeNull();
      // R36：用户已被判定为未认证，不得留着一条仍可能活着的下游 WS 连接
      expect(sockets[0]!.disconnected).toBe(true);
      expect(isGameSessionReady()).toBe(false);
      // 令牌已不可用：这里必须**只**清本地，不能再调服务端登出（它也会返回同一个码）
      // 记牌器收费片起本页挂载还会多一条 `/card-counter/status` 只读（不影响「不登出」语义）。
      const roomCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/rooms'));
      expect(roomCalls).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/logout'))).toHaveLength(0);
    });
  }

  it('13004（REFRESH_SNAPSHOT）→ REST 语境下重放一次当前请求，且只重放一次（R34）', async () => {
    let roomsCalls = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      roomsCalls += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            roomsCalls === 1
              ? { code: 13004, message: '版本冲突', data: null }
              : { code: 0, data: [roomFixture('ROOM03')] },
          ),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();

    await openFriends(wrapper);
    expect(roomsCalls).toBe(2); // 第一次 13004 → 重放一次 → 成功；不循环
    expect(flat(wrapper.text())).toContain('ROOM03');
  });

  it('「退出」调服务端登出并清本地，且销毁本地会话（R28：WS 不会自动断）', async () => {
    const { factory } = capturingFactory();
    startGameSession(factory);
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const auth = useAuthStore();
    auth.hydrate();

    const fetchMock = stubFetch({ code: 0, data: null });
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    await flushPromises();

    const signOut = wrapper.findAll('button').find((b) => b.text() === '退出');
    expect(signOut, '大厅必须有「退出」按钮').toBeDefined();
    await signOut!.trigger('click');
    await flushPromises();

    const logoutCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/auth/logout'));
    expect(logoutCall, '登出必须调服务端（§5.1）').toBeDefined();
    expect((logoutCall![1]?.headers as Record<string, string>).Authorization).toBe('Bearer a1');
    expect(loadSession()).toBeNull();
    expect(clientConfig.token).toBe('');
    expect(auth.page).toBe('login');
    expect(() => getGameSession()).toThrow(); // 本地会话已销毁
  });
});

describe('玩法页的匹配按钮（§6.3 / R51）', () => {
  /**
   * 片③：匹配按钮随开局区搬到了**玩法页**（R749）⇒ 本组用例挂 `GamePage`。
   *
   * ⚠️ 本助手**取代**了原来的 `mountLobbyWithSocket`：它原先的五个用户（开始游戏 /
   * 12009 / 取消匹配 / 12007 复位 / 手动加入）**全部是开局区用例** ⇒ 一起搬到了玩法页，
   * 留下的旧助手是死代码（`noUnusedLocals` 实测报 TS6133）⇒ 按「不留空壳」的纪律删掉。
   * 脚手架沿用既有形态（`capturingFactory` + `startGameSession` + 挂载页面），本片在它里面
   * **新增了一行** `useGameStore().setSelectedBaseScore(80)` —— 理由见下。
   *
   * ⚠️ `room.match` 的 `baseScore` 现在来自**用户选中的那一档**（`store.selectedBaseScore`）
   * ⇒ 本助手把它预置成 **80**（**不是**第一档 15）：这样「用的是**选中的**那个值」
   * 才有判别力 —— 「取档位表第一档」的实现会在 `baseScore: 80` 上当场红。
   */
  function mountGameWithSocket() {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    useGameStore().setSelectedBaseScore(80);
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    // 片② D8：新用例要直接断 `handle.notice` / `handle.clearNotice` ⇒ 一并返回会话句柄。
    return { wrapper, socket: sockets[0]!, session: getGameSession() };
  }

  /**
   * ⚠️ 片② 客户端起，开始游戏页**不再自己取档位表**（那是大厅的事，片规格 §3）——
   * 本页唯一会发的 REST 就是 `GET /api/rooms`（房间列表）。原 `stubLevelsFetch`
   * 因此改名并简化（它此前还要按 URL 给档位表分流）。
   */
  function stubRoomsFetch() {
    return stubFetch({ code: 0, data: [] });
  }

  it('玩法页匹配失败只出现一条 NoticeStack 项，无 .game__error', async () => {
    stubRoomsFetch();
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
    await flushPromises();
    expect(wrapper.find('.game__error').exists()).toBe(false);
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  });

  it('点「开始游戏」发 room.match；ack 0 → 切换到「正在匹配…/取消匹配」', async () => {
    stubRoomsFetch();
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();

    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    expect(socket.emittedOf('room.match')).toHaveLength(1);
    // 协议②：`baseScore` 必须是**用户选中的那一档**（M09：前端不得写死规则常量）
    // 风控 T8：`deviceId` 随行，且必须是**持久化的同一枚**——把页面那份换成另生成一个
    // 随机串（不落存储）的实现，会让这里的 `getDeviceId()` 生成出另一个值 ⇒ 当场红。
    expect(socket.emittedOf('room.match')[0]!.env.payload).toEqual({
      mode: 'random',
      baseScore: 80,
      gameType: 'doudizhu',
      playerCount: 3,
      deviceId: getDeviceId(),
    });

    socket.emittedOf('room.match')[0]!.ack(null, { code: 0 });
    await flushPromises();

    expect(flat(wrapper.text())).toContain('正在匹配');
    expect(flat(wrapper.text())).toContain('取消匹配');
    expect(flat(wrapper.text())).not.toContain('匹配失败');
  });

  it('S5.4：切到跑得快后匹配载荷带 gameType=paodekuai（人数取玩法缺省 3）', async () => {
    stubRoomsFetch();
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();

    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setSelectedBaseScore(80);

    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();

    expect(socket.emittedOf('room.match')[0]!.env.payload).toEqual({
      mode: 'random',
      baseScore: 80,
      gameType: 'paodekuai',
      playerCount: 3,
      deviceId: getDeviceId(),
    });
  });

  /**
   * 匹配用时秒表（2026-10 需求）：匹配中省略号后直接显示「Ns」**递增**（1s 起，无「用时」前缀、
   * 样式与「正在匹配」同款）；取消（或任何 matching 复位）后秒表节点随 v-else 一起消失，
   * interval 必须被清掉（防后台空转）；卸载也不得残留定时器。
   */
  it('匹配用时：省略号后「1s」起每秒递增（无「用时」字样）；取消后消失且无残留定时器；卸载同样清理', async () => {
    vi.useFakeTimers();
    try {
      stubRoomsFetch();
      const { wrapper, socket } = mountGameWithSocket();
      await flushPromises();

      await wrapper.find('.game__match button').trigger('click');
      await flushPromises();
      socket.emittedOf('room.match')[0]!.ack(null, { code: 0 });
      await flushPromises();

      const elapsedText = () => wrapper.find('.game__matching-elapsed').text();
      // 起表即「第 1 秒」（不是 0s，也不是倒计时）；无「用时」前缀
      expect(elapsedText()).toBe('1s');
      expect(flat(wrapper.text()), '不得出现「用时」前缀').not.toContain('用时');
      await vi.advanceTimersByTimeAsync(1000);
      expect(elapsedText()).toBe('2s');
      await vi.advanceTimersByTimeAsync(3000);
      expect(elapsedText()).toBe('5s');

      const timersWhileMatching = vi.getTimerCount();
      expect(timersWhileMatching, '匹配中秒表 interval 必须在跑').toBeGreaterThanOrEqual(1);

      // 取消 → ack 0 → matching 复位 → 用时节点消失、interval 被清
      const cancel = wrapper.findAll('button').find((b) => b.text() === '取消匹配');
      await cancel!.trigger('click');
      await flushPromises();
      socket.emittedOf('room.unmatch')[0]!.ack(null, { code: 0 });
      await flushPromises();
      expect(wrapper.find('.game__matching-elapsed').exists()).toBe(false);
      expect(vi.getTimerCount(), '取消后秒表 interval 不得残留').toBe(timersWhileMatching - 1);

      // 再次匹配：从 1s 重新起（不接着上次数）
      await wrapper.find('.game__match button').trigger('click');
      await flushPromises();
      socket.emittedOf('room.match').at(-1)!.ack(null, { code: 0 });
      await flushPromises();
      expect(elapsedText()).toBe('1s');

      wrapper.unmount();
      const afterUnmount = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.getTimerCount(), '卸载后不得再生成定时器回调').toBe(afterUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 实机走查（2026-10-18）：匹配中点「返回大厅」（纯导航、不撤票）⇒ `matching` 仍是 true；
   * 回开始游戏页（页面重挂载）后，秒表必须按 **store 里的起点**续算，不得停在 0s。
   * 判别力：起点若仍是页面局部变量，重挂载后 `watch(matching)` 不触发 ⇒ 读数会是 0s/1s。
   */
  it('匹配中离开页面 5 秒后重挂载 ⇒ 秒表按 store 起点续算（不是 0s/1s）', async () => {
    vi.useFakeTimers();
    try {
      stubRoomsFetch();
      const store = useGameStore();
      vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
      store.setMatching(true); // 匹配已在别处发生（页面尚未挂载）
      vi.setSystemTime(new Date('2026-10-18T00:00:05Z'));

      const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
      await flushPromises();

      const elapsedText = () => wrapper.find('.game__matching-elapsed').text();
      expect(elapsedText(), '重挂载后必须按真实等待时长续算').toBe('6s');
      await vi.advanceTimersByTimeAsync(1000);
      expect(elapsedText()).toBe('7s');
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ② 金币场（§14）：`room.match` 的 `mode` = **大厅所选场次**（`store.roomMode`）——
   * 替换 :139 那处硬编码的 `'random'`。这就是「开始游戏 mode 接线」的判据（本文件是落点）。
   *
   * 判别力：上面的默认用例（roomMode 缺省 `'random'`）与这一条（先写 `'gold'`）**成对** ——
   * 任何硬编码成 `'random'`（或 `'gold'`）的实现都会让其中一条红。
   */
  it('② 开始游戏 mode 接线：所选场次 = 金币场 ⇒ 载荷 mode="gold"（不是硬编码 random）', async () => {
    stubRoomsFetch();
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();

    useGameStore().setRoomMode('gold');
    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();

    const matches = socket.emittedOf('room.match');
    expect(matches, '必须真的发了 room.match').toHaveLength(1);
    expect(matches[0]!.env.payload, 'mode 必须读 store.roomMode（替换 :139 的硬编码）').toEqual({
      mode: 'gold',
      baseScore: 80,
      gameType: 'doudizhu',
      playerCount: 3,
      // 风控 T8：设备指纹随 room.match 上行（同一枚持久化值）
      deviceId: getDeviceId(),
    });
  });

  /**
   * ② §10：`14003`（E_ENTRY_THRESHOLD）的客户端处置 = **TOAST**，且**消息直接用服务端
   * `message`**（客户端不另写文案 —— 那串数字只有服务端知道）。
   *
   * 判别力：断言的是**服务端那句原文**出现在会话提示里；把 14003 加进 `action-copy.ts`
   * 的静态文案表（或吞掉 message）会当场红。
   */
  it('② 14003（TOAST）⇒ 提示直接用服务端 message，客户端不另写文案（§10）', async () => {
    stubRoomsFetch();
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();

    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    socket.emittedOf('room.match')[0]!.ack(null, {
      code: 14003,
      message: '金币不足：该场次需要 ≥ 800',
    });
    await flushPromises();

    expect(
      wrapper.find('[data-notice-id="session-notice"] .notice__text').text(),
    ).toContain('金币不足：该场次需要 ≥ 800');
    // Task 9 来源分流：WS ack 非 0 只由 session notice 呈现，页面不得再写本地文案。
    expect(wrapper.find('[data-notice-id="game-error"]').exists()).toBe(false);
  });

  /**
   * ② 金币场（§14 / D7）：开始游戏页左下信息条的余额 —— **金币场选中时**显真值，
   * 免费场恒「—」（余额只属于金币语境；牌桌的「整场统一 —」是同一口径）。
   *
   * 判别力两半：同一个 `walletBalance`（12345）在两种场次下必须给出**不同**的显示 ——
   * 「永远显示余额」与「永远 —」的实现各红一半。
   */
  it('② 信息条余额按所选场次：金币场 ⇒ 真值；免费场 ⇒「—」（同一个余额值）', async () => {
    stubRoomsFetch();
    const store = useGameStore();
    store.setWalletBalance(12345);

    const free = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(free.find('.game__player .chip__currency').text(), '免费场恒「—」').toBe('—');
    free.unmount();

    store.setRoomMode('gold');
    const gold = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(
      gold.find('.game__player .chip__currency').text(),
      '金币场显余额真值（同一个 12345）',
    ).toBe('12345');
    gold.unmount();
  });

  it('ack 12009（已在队列中）是**幂等成功**：进入匹配中，不报错（R51）', async () => {
    stubRoomsFetch();
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();

    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    socket.emittedOf('room.match')[0]!.ack(null, { code: 12009, message: 'Already in the match queue' });
    await flushPromises();

    expect(flat(wrapper.text())).toContain('取消匹配');
    expect(flat(wrapper.text())).not.toContain('匹配失败');
  });

  /**
   * 本片（「返回大厅」弃局出口 + 匹配守卫 / 判据 C13）：`room.match` 的 **12011**
   * （在局/在房守卫拒绝）——**只导航、不写 `error`**。
   *
   * 两半互为判别力：
   *  ① `store.roomCode` 非空（在局/在房都在此列）⇒ 送回牌桌（`canShowTable` 同族守卫：有真局才回）；
   *  ② store 空（多端 B 端补推未到的空壳形态）⇒ **不导航**，只留 TOAST。
   * 文案**只走 TOAST 通道**（session notice；查表 = `net/action-copy.ts` 的 12011 条目）——
   * 若实现把它也写进本地 `game-error` 项，浮层里会**同句双呈现**，①以 `.game__error` 不存在 &&
   * `[data-notice-id="session-notice"]` 唯一钉住。
   */
  it('本片 C13：ack 12011（在局/在房）⇒ 不写 error；roomCode 非空 ⇒ 导航回牌桌', async () => {
    stubRoomsFetch();
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();
    const store = useGameStore();
    const auth = useAuthStore();
    store.setRoom('ROOM1', 0); // 在局/在房：roomCode 非空（导航守卫的前提）
    const navigate = vi.spyOn(auth, 'navigate');

    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    socket.emittedOf('room.match')[0]!.ack(null, { code: 12011, message: 'You are still in an active game' });
    await flushPromises();

    expect(navigate, 'roomCode 非空 ⇒ 必须被送回牌桌（不再出现双坐局/双结算）').toHaveBeenCalledWith('table');
    expect(auth.page).toBe('table');
    expect(
      wrapper.find('[data-notice-id="game-error"]').exists(),
      '12011 不得写本地文案（防与 session notice 双呈现）',
    ).toBe(false);
    expect(wrapper.find('.game__error').exists(), '旧页内错误行不得复现').toBe(false);
    // 文案只走 session notice 通道，且是客户端文案表的逐字（不是服务端 message）
    expect(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()).toBe('你还有未结束的对局或房间');
  });

  it('本片 C13 负半：ack 12011 但 store 空 ⇒ 不导航（只 toast）', async () => {
    stubRoomsFetch();
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();
    const auth = useAuthStore();
    const navigate = vi.spyOn(auth, 'navigate');

    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    socket.emittedOf('room.match')[0]!.ack(null, { code: 12011, message: 'You are still in an active game' });
    await flushPromises();

    expect(navigate, 'store 空（无局可回）⇒ 不得导航到空壳牌桌').not.toHaveBeenCalled();
    expect(auth.page).not.toBe('table');
    expect(wrapper.find('[data-notice-id="game-error"]').exists()).toBe(false);
    expect(wrapper.find('.game__error').exists()).toBe(false);
    expect(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()).toBe('你还有未结束的对局或房间');
  });

  it('取消匹配发 room.unmatch；ack 0 → 回到「开始游戏」', async () => {
    stubRoomsFetch();
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();

    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    socket.emittedOf('room.match')[0]!.ack(null, { code: 0 });
    await flushPromises();

    await wrapper.find('.game__match button').trigger('click'); // 现在这个按钮是「取消匹配」
    expect(socket.emittedOf('room.unmatch')).toHaveLength(1);
    socket.emittedOf('room.unmatch')[0]!.ack(null, { code: 0 });
    await flushPromises();

    expect(flat(wrapper.text())).toContain('开始游戏');
  });

  /**
   * R49 闭环：`12007` 是**推送**（`system.error`）而不是 `room.match` 的 ack。
   *
   * 这正是「匹配中状态不能留在页面局部 ref」的原因——页面局部 ref 收不到这条推送，
   * 按钮会永久停在「正在匹配…」，用户再也点不了第二次。
   */
  it('12007 经 system.error 推送到达 → 按钮从「取消匹配」回到可再次点击的「开始游戏」（R49）', async () => {
    stubRoomsFetch();
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();

    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    socket.emittedOf('room.match')[0]!.ack(null, { code: 0 });
    await flushPromises();
    expect(flat(wrapper.text())).toContain('取消匹配');

    socket.push(serverMessage('system.error', { code: 12007, message: 'Match timed out' }, 0));
    await flushPromises();

    expect(flat(wrapper.text())).toContain('开始游戏');
    expect(flat(wrapper.text())).not.toContain('取消匹配');
  });

  /**
   * 机器人补位开关片（补机器人开关关时的客户端形态）：
   * 缺人越过等待窗口 ⇒ 服务端推 `match.wait_prompt` ⇒ 玩法页在底部弹**悬浮卡片**，
   * 给「重新匹配」（先 unmatch 再走唯一 match 入口）与「继续等待」（room.match.extend，
   * 票留队、matching 不终止）两个动作。浮层在 `.game__match` **外面**：
   * `.game__match button` 必须始终唯一（既有探针纪律）。
   */
  describe('机器人补位开关关：match.wait_prompt 底部悬浮卡片', () => {
    /** 入队并 ack 0（前置：让页面进入「正在匹配」）。 */
    async function enterMatching(wrapper: ReturnType<typeof mount>, socket: FakeSocket) {
      await wrapper.find('.game__match button').trigger('click');
      await flushPromises();
      socket.emittedOf('room.match')[0]!.ack(null, { code: 0 });
      await flushPromises();
    }

    const PROMPT_TEXT = '正在为你安排牌桌，请稍等片刻。';
    const waitItem = (wrapper: ReturnType<typeof mount>) => wrapper.find('.game__waitprompt');

    it('匹配中收到 match.wait_prompt ⇒ 底部浮层 + 两个动作；.game__match 内仍只有「取消匹配」', async () => {
      stubRoomsFetch();
      const { wrapper, socket } = mountGameWithSocket();
      await flushPromises();
      await enterMatching(wrapper, socket);

      socket.push(serverMessage('match.wait_prompt', { message: PROMPT_TEXT }, 0));
      await flushPromises();

      expect(wrapper.find('.game__waitprompt-layer').exists()).toBe(true);
      expect(wrapper.find('.game__waitprompt').exists()).toBe(true);
      expect(wrapper.find('.game__waitprompt-text').text()).toBe(PROMPT_TEXT);
      // 浮层必须在中央舞台之外，且是 .game 的直接子元素（不参与布局的结构证据）。
      expect(wrapper.find('.game__stage .game__waitprompt').exists()).toBe(false);
      expect(
        wrapper.find('.game__waitprompt-layer').element.parentElement?.classList.contains(
          'game',
        ),
      ).toBe(true);
      const labels = wrapper.findAll('.game__waitprompt-btn').map((b) => flat(b.text()));
      expect(labels).toEqual(['重新匹配', '继续等待']);
      // 数量断言：匹配区容器内仍恰好一个按钮（取消匹配），浮层按钮没有混进去。
      const matchButtons = wrapper.findAll('.game__match button');
      expect(matchButtons).toHaveLength(1);
      expect(matchButtons[0]!.text()).toBe('取消匹配');
    });

    it('C14：匹配中好友房入口视觉隐藏但保留布局盒；匹配结束恢复', async () => {
      stubRoomsFetch();
      const { wrapper, socket } = mountGameWithSocket();
      await flushPromises();
      const friends = wrapper.find('.game__friends-open');
      expect(friends.exists()).toBe(true);
      expect(friends.classes()).not.toContain('game__friends-open--matching');

      await enterMatching(wrapper, socket);
      expect(wrapper.find('.game__friends-open').classes()).toContain(
        'game__friends-open--matching',
      );
      expect(wrapper.find('.game__friends-open').attributes('disabled')).toBeDefined();

      socket.push(serverMessage('system.error', { code: 12007, message: 'Match timed out' }, 0));
      await flushPromises();
      expect(wrapper.find('.game__friends-open').classes()).not.toContain(
        'game__friends-open--matching',
      );
    });

    it('C14b：取消匹配（ack 0）也清掉好友房隐藏类（不只 12007 路径）', async () => {
      stubRoomsFetch();
      const { wrapper, socket } = mountGameWithSocket();
      await flushPromises();
      await enterMatching(wrapper, socket);
      expect(wrapper.find('.game__friends-open').classes()).toContain(
        'game__friends-open--matching',
      );

      const cancel = wrapper.findAll('button').find((b) => b.text() === '取消匹配');
      await cancel!.trigger('click');
      await flushPromises();
      socket.emittedOf('room.unmatch')[0]!.ack(null, { code: 0 });
      await flushPromises();

      expect(wrapper.find('.game__friends-open').classes()).not.toContain(
        'game__friends-open--matching',
      );
    });

    it('🔴 未在匹配中收到 match.wait_prompt ⇒ 不显示浮层（迟到推送不凭空弹出）', async () => {
      stubRoomsFetch();
      const { wrapper, socket } = mountGameWithSocket();
      await flushPromises();

      socket.push(serverMessage('match.wait_prompt', { message: PROMPT_TEXT }, 0));
      await flushPromises();

      expect(waitItem(wrapper).exists()).toBe(false);
    });

    it('点「继续等待」⇒ 发 room.match.extend；ack 0 关浮层、仍匹配中，且不发 unmatch/新 match', async () => {
      stubRoomsFetch();
      const { wrapper, socket } = mountGameWithSocket();
      await flushPromises();
      await enterMatching(wrapper, socket);
      socket.push(serverMessage('match.wait_prompt', { message: PROMPT_TEXT }, 0));
      await flushPromises();

      const extendBtn = wrapper.findAll('button').find((b) => b.text() === '继续等待');
      await extendBtn!.trigger('click');
      await flushPromises();
      expect(socket.emittedOf('room.match.extend')).toHaveLength(1);
      expect(socket.emittedOf('room.match.extend')[0]!.env.payload).toEqual({});
      socket.emittedOf('room.match.extend')[0]!.ack(null, { code: 0 });
      await flushPromises();

      expect(waitItem(wrapper).exists()).toBe(false);
      expect(flat(wrapper.text())).toContain('取消匹配'); // 匹配没终止：票留在原队列
      expect(socket.emittedOf('room.unmatch')).toHaveLength(0);
      expect(socket.emittedOf('room.match')).toHaveLength(1); // 没有重新入队
    });

    it('点「重新匹配」⇒ 先发 room.unmatch（ack 0）再经唯一 match 入口重发 room.match；浮层关', async () => {
      stubRoomsFetch();
      const { wrapper, socket } = mountGameWithSocket();
      await flushPromises();
      await enterMatching(wrapper, socket);
      socket.push(serverMessage('match.wait_prompt', { message: PROMPT_TEXT }, 0));
      await flushPromises();

      const rematchBtn = wrapper.findAll('button').find((b) => b.text() === '重新匹配');
      await rematchBtn!.trigger('click');
      await flushPromises();
      expect(socket.emittedOf('room.unmatch')).toHaveLength(1);
      socket.emittedOf('room.unmatch')[0]!.ack(null, { code: 0 });
      await flushPromises();
      // unmatch ack 0 后唯一的 match() 入口被复用 ⇒ 第二次 room.match（发送点仍只此一处）
      expect(socket.emittedOf('room.match')).toHaveLength(2);
      socket.emittedOf('room.match').at(-1)!.ack(null, { code: 0 });
      await flushPromises();

      expect(waitItem(wrapper).exists()).toBe(false);
      expect(flat(wrapper.text())).toContain('取消匹配'); // 重新入队成功
    });

    it('匹配终止（12007）⇒ 未应答的浮层随之消失', async () => {
      stubRoomsFetch();
      const { wrapper, socket } = mountGameWithSocket();
      await flushPromises();
      await enterMatching(wrapper, socket);
      socket.push(serverMessage('match.wait_prompt', { message: PROMPT_TEXT }, 0));
      await flushPromises();
      expect(waitItem(wrapper).exists()).toBe(true);

      socket.push(serverMessage('system.error', { code: 12007, message: 'Match timed out' }, 0));
      await flushPromises();

      expect(waitItem(wrapper).exists()).toBe(false);
      expect(flat(wrapper.text())).toContain('开始游戏');
    });
  });

  it('片② D8/J14：推送 12007 ⇒ 等待页显示「当前无匹配的玩家」', async () => {
    const { wrapper, socket } = await mountGameWithSocket();
    socket.push(serverMessage('system.error', { code: 12007, message: 'Match timed out' }, 0));
    await nextTick();
    expect(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()).toBe('当前无匹配的玩家');
  });

  it('片② D8/J15：推送 10004（BACK_TO_LOBBY 类）不得导航；10007 仍产 notice', async () => {
    const { wrapper, socket } = await mountGameWithSocket();
    socket.push(serverMessage('system.error', { code: 10004, message: 'token expired' }, 0));
    await nextTick();
    expect(wrapper.find('[data-notice-id="session-notice"]').exists()).toBe(false);        // 导航类不从推送路径消费
    socket.push(serverMessage('system.error', { code: 10007, message: 'upstream down' }, 0));
    await nextTick();
    expect(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()).toBe('服务暂时不可用，请稍后重试');   // ← 5 码文案的判据
  });

  /**
   * 片② D8 + Task 2（source 归属 + TTL）：
   *  - `system.error` 推送的 TOAST 播报 = `source:'system'`（规格 §4.2）⇒ `clearNotice()`
   *    （= `clearAction()`）**不清它**，由 8s TTL 自消；
   *  - **action 源**（动作 ack 的失败提示）才是「重新匹配要清掉」的那一类；
   *  - `transport` 源（连接不可用）同样不受影响。
   */
  it('片② D8/J16：clearNotice 只清 action 源；system 推送与连接不可用仍在', async () => {
    const { wrapper, socket, session } = await mountGameWithSocket();
    socket.push(serverMessage('system.error', { code: 12007, message: 'Match timed out' }, 0));
    await nextTick();
    expect(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()).toBe('当前无匹配的玩家');
    expect(session.notice.value?.source).toBe('system');
    session.clearNotice();                                              // 等价于玩家再点「开始游戏」
    await nextTick();
    expect(session.notice.value?.source, 'system 推送不被 clearAction 清除').toBe('system');

    // action 源（动作 ack 的失败提示）= 重新匹配清掉的那一类
    session.client.reportErrorCode(ErrCode.MATCH_TIMEOUT, '');
    expect(session.notice.value?.source).toBe('action');
    session.clearNotice();
    await nextTick();
    expect(wrapper.find('[data-notice-id="session-notice"]').exists()).toBe(false);
    // 连接不可用那条**不受** clearNotice 影响（它带 source:'transport'）
    session.notice.value = { level: 'error', text: '连接不可用', source: 'transport' };
    session.clearNotice();
    expect(session.notice.value?.text).toBe('连接不可用');
  });

  /**
   * 片② D8 的另一半（补判据）：J16 用「直接调 `clearNotice()`」等价表达了玩家重开匹配，
   * 但 `game.vue` 的 `match()` 开头那句 `clearNotice()` 因此**无人看守**（删掉也全绿）。
   * 这里补上**真实点击路径**：点「开始游戏」⇒ 上一次的**action 源**匹配失败提示必须被清掉
   *（Task 2 起 `system.error` 推送是 system 源、由 TTL 自消，不再是本判据的样本）。
   */
  it('片② D8：点「开始游戏」（真实路径）⇒ 上一次的匹配失败提示被清掉', async () => {
    const { wrapper, session } = await mountGameWithSocket();
    session.client.reportErrorCode(ErrCode.MATCH_TIMEOUT, '');
    await nextTick();
    expect(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()).toBe('当前无匹配的玩家');

    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-notice-id="session-notice"]').exists()).toBe(false);
  });

  /**
   * R61：**同一条 `room.join` 只能有一种状态写入方式**。
   *
   * 自动进房（`useGameSession.joinMatchedRoom`）与玩法页手动「加入」是**同一条消息、
   * 同一个 ack 载荷**，两条路径都必须走同一个 `applyRoomState`——否则「进房后座位立即
   * 可用」在两条路径上表现不一致（这正是修复前的缺陷）。
   * 同样地，ack 里没有 `status`，**不得**伪造。
   */
  it('手动「加入」也消费 ack 的 players 并校正座位，且不伪造 roomStatus（R61）', async () => {
    stubFetch({ code: 0, data: roomFixture('ROOM7') });
    const { wrapper, socket } = mountGameWithSocket();
    await flushPromises();

    /**
     * ⚠️ **片② 客户端起必须多这一步**（brief 的清单漏了它，Step 4 的「整文件 PASS」会红）：
     * 房号输入框 `.game__join` 也随三入口收进了「好友房」弹层 ⇒ 弹层关着时
     * `find('.game__join input')` 落在空气上。判据本身**一条没改**（仍是「消费 ack 的
     * `players`、座位以 ack 为准、不伪造 `status`」），变的只是动手前先点开弹层。
     */
    await openFriends(wrapper);

    await wrapper.find('.game__join input').setValue('ROOM7');
    await wrapper.find('.game__join button').trigger('click');
    /**
     * ⚠️ **本片（手动进房修复 / R802）之后这里必须 flush 一次**：`join()` 现在是**两步**
     * —— 先 REST 占座、**再**发 WS `room.join`。不 flush 的话第一条请求还没回来，
     * socket 上自然一条 `room.join` 都没有。
     * （旧实现只有一步、`emit` 是同步的，所以那时不需要 flush —— 这正是本片改掉的形状。）
     */
    await flushPromises();
    expect(socket.emittedOf('room.join')).toHaveLength(1);

    socket.emittedOf('room.join')[0]!.ack(null, {
      code: 0,
      data: {
        roomCode: 'ROOM7',
        seat: 1,
        players: [
          { id: 'p0', seat: 0 },
          { id: 'p1', seat: 1 },
          { id: 'p2', seat: 2 },
        ],
      },
    });
    await flushPromises();

    const store = useGameStore();
    expect(store.roomCode).toBe('ROOM7');
    expect(store.mySeat).toBe(1);
    expect(store.roomStatus).toBeNull(); // ack 没给 status → 不得编一个
    expect(useAuthStore().page).toBe('table');
  });

  it('🔴 没选底分（selectedBaseScore 为 null）⇒ 按钮**真的禁用** + 一行说明 + **不发** room.match', async () => {
    stubRoomsFetch();
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    // 刻意**不**预置选中底分
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();

    /**
     * 🔴 **先断言 `disabled` 属性本身**，再谈「不发匹配」：
     * `trigger('click')` 走的是 `dispatchEvent` —— 它**绕过** `disabled`（只有用户驱动的
     * 激活才会被浏览器抑制）⇒ 若只断言「没发 room.match」，在「点击根本没生效」的世界里
     * 也是绿的（**恒真**）。属性那条与点击是否生效**无关**，判别力有保障。
     */
    expect(
      wrapper.find('.game__match button').attributes('disabled'),
      '未选底分时「开始游戏」必须禁用（不是点得动但发不出去）',
    ).toBeDefined();
    expect(wrapper.find('.game__hint').text(), '要说清为什么不能点（忌讳「点了没反应的活按钮」）').toContain(
      '选择底分',
    );

    // 第二半：即便处理函数真的跑了，也**不得**猜一个底分发出去
    await wrapper.find('.game__match button').trigger('click');
    await flushPromises();
    expect(sockets[0]!.emittedOf('room.match'), '没选底分就不得猜一个发出去').toHaveLength(0);
  });
});

describe('login.vue 登录成功后重建会话', () => {
  it('登录成功后用新令牌重新握手（否则新令牌永远用不上）', async () => {
    const { factory, handshakes, flush } = capturingFactory();
    startGameSession(factory);
    /**
     * 客户端接入片 C31：建连 auth 恒带 `clientPlatform`（端标识，网关握手闸在验签前
     * 读它）。这里的 'h5'：vitest setup 装全局 `uni` 替身、默认 `uniPlatform = 'web'`
     *（`test/helpers/uni-stub.ts:243-245`）⇒ `detectPlatform() === 'browser'` ⇒ 'h5'。
     */
    await flush();
    expect(handshakes).toEqual([{ userId: clientConfig.devUserId, clientPlatform: 'h5' }]); // 登录前：退化为开发身份（仅 mock 接受）

    stubFetch({
      code: 0,
      data: { accessToken: 'a2', refreshToken: 'r2', user: { id: 'u2', phone: '13800000000' } },
    });

    const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('input[type="password"]').setValue('secret');
    /**
     * Task 2（P10）改锚点：`form` → `view`（派工单 A 的标签映射）⇒ 不再有原生 `submit` 事件，
     * 驱动登录的入口就是 `.login__actions` 里的主按钮。
     * **语义不变**：断言仍然是「用户在登录表单上提交 ⇒ 用新令牌重新握手」。
     */
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    await flushPromises();
    await flush();

    // 客户端接入片 C31 + 设备绑定片：真实路径握手恒带端标识与 deviceId
    //（deviceId 域内 8..64，与登录载荷同源）；mock/开发身份路径不带 deviceId。
    expect(handshakes).toHaveLength(2);
    expect(handshakes[0]).toEqual({ userId: clientConfig.devUserId, clientPlatform: 'h5' });
    expect(handshakes[1]!.token).toBe('a2');
    expect(handshakes[1]!.clientPlatform).toBe('h5');
    expect(handshakes[1]!.deviceId as string).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    expect(loadSession()).toEqual({
      accessToken: 'a2',
      refreshToken: 'r2',
      userId: 'u2',
      // Task 2R：展示资料与令牌**同一次写入**（`applySession` 的持久化带上这两项）
      phone: '13800000000',
      nickname: '',
    });
    expect(useAuthStore().page).toBe('lobby');
  });

  it('登录失败不重建会话，错误按信封的 message 展示', async () => {
    const { factory, handshakes, flush } = capturingFactory();
    startGameSession(factory);
    await flush();
    stubFetch({ code: 11002, message: '密码错误', data: null });

    const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('input[type="password"]').setValue('wrong');
    // Task 2（P10）：同上一处，`form` → `view`，锚点改为登录按钮（语义不变：提交登录表单）。
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    await flushPromises();
    await flush();

    expect(handshakes).toHaveLength(1);
    expect(flat(wrapper.find('[data-notice-id="auth"] .notice__text').text())).toBe('密码错误');
    expect(useAuthStore().page).toBe('login');
  });

  /**
   * T13 收口 F-T13-1（红级）：被封账号登录**零提示**的修复判据。
   *
   * 根因链（实读）：11003 在协议表映到 `BACK_TO_LOBBY`（`errors.ts:92`）⇒
   * `dispatchRestFailure` 的该分支**只**执行 `signOutLocally`、从不执行 `toast`
   * （`net/errors.ts:147-149`）⇒ `stores/auth.ts` 的 K1 文案分支不可达。
   * 仪器化实测：403 到达但页面四面全空（loginError/fieldError/toast/notice 皆 null）。
   *
   * 裁决（写死）：登录语境必须**可见 K1 全串**，且**以客户端文案为准**
   *（`copy.ts`；不用服务端 message「用户已被封禁」）。
   */
  it('封禁登录（11003/BACK_TO_LOBBY）⇒ 可见 K1 全串（客户端文案为准，不是服务端 message）', async () => {
    const { factory, handshakes, flush } = capturingFactory();
    startGameSession(factory);
    await flush();
    stubFetch({ code: 11003, message: '用户已被封禁', data: null }, 403);

    const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('input[type="password"]').setValue('secret');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    await flushPromises();
    await flush();

    expect(flat(wrapper.find('[data-notice-id="auth"] .notice__text').text())).toBe('该账号已被封禁，如有异议请联系客服');
    expect(flat(wrapper.text()), '以客户端文案为准：不得显示服务端 message').not.toContain('用户已被封禁');
    expect(useAuthStore().page).toBe('login');
    expect(handshakes).toHaveLength(1); // 未登录成功 ⇒ 不得重建会话
  });

  /**
   * 客户端接入片 C34b：端闸（10008）登录失败 ⇒ 可见 §0 全串，且**即使服务端 message
   * 非空也以客户端文案为准**（§0 显示链：网关 `CodedForbidden` 的短串不作显示承诺 ——
   * 它只与其余三面不一致）。
   *
   * ⚠️ 落点 = **toast 路径**（10008 的 `CLIENT_ACTION` = TOAST ⇒ `net/errors.ts` 的
   * TOAST 分派 ⇒ `stores/auth.ts` 的 toast handler）——**不是**下面 11003 所在的
   * BACK_TO_LOBBY 分支位置：那个分支的存在理由是「BACK_TO_LOBBY 只调 signOutLocally、
   * toast 不可达」，10008 本身就走 toast，不存在那个可达性问题（照位置直搬会复刻
   * 同一教训）。
   */
  it('客户端接入片 C34b：10008（TOAST）⇒ 显示 §0 全串（覆盖服务端 message）', async () => {
    const { factory, handshakes } = capturingFactory();
    startGameSession(factory);
    stubFetch({ code: 10008, message: '服务端自己的短说明', data: null }, 403);

    const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('input[type="password"]').setValue('secret');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    await flushPromises();

    expect(flat(wrapper.find('[data-notice-id="auth"] .notice__text').text())).toBe(
      '当前客户端已暂停服务，请稍后再试或更换客户端',
    );
    expect(flat(wrapper.text()), '以客户端文案为准：不得显示服务端 message').not.toContain(
      '服务端自己的短说明',
    );
    expect(useAuthStore().page).toBe('login');
    expect(handshakes).toHaveLength(1); // 未登录成功 ⇒ 不得重建会话
  });

  /**
   * 负对照：修复**只**对 11003 生效 —— 其余 `BACK_TO_LOBBY` 码（10005）在登录页
   * 仍是既有形态（静默回登录页，不新增任何提示）。
   */
  it('负对照：其它 BACK_TO_LOBBY 码（10005）在登录页不新增提示（既有行为一字不动）', async () => {
    const { factory, handshakes, flush } = capturingFactory();
    startGameSession(factory);
    await flush();
    stubFetch({ code: 10005, message: '签名无效', data: null }, 401);

    const wrapper = mount(LoginPage, { global: { plugins: [pinia] } });
    await wrapper.find('.login__field--phone input').setValue('13800000000');
    await wrapper.find('input[type="password"]').setValue('secret');
    await wrapper.find('.login__actions .btn--primary').trigger('click');
    await flushPromises();
    await flush();

    expect(wrapper.find('.notice').exists(), '10005 不得新增可见信息').toBe(false);
    expect(useAuthStore().error).toBe('');
    expect(useAuthStore().page).toBe('login');
    expect(handshakes).toHaveLength(1);
  });
});

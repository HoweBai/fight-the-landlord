/**
 * 大厅体验的两条真缺口（台账 N30①③，切片 P11 的 Task 3 / Task 4）：
 *
 *  - **N30③ / R454**：大厅没有「创建房间」入口、房间列表项不可点。
 *    新增 `rest.createRoom()`（`POST /api/rooms`，§7.1）+ 建房按钮 + 列表项可点。
 *    ⚠️ **硬纪律**：同一条 `room.join` 只能有**一种**实现（R61）——三条入口
 *    （手动输入房号 / 点击列表项 / 创建房间后进房）全部复用大厅里那一个 `join()`。
 *  - **N30① / R455**：socket 连不上时 UI 只显示内部的「匹配失败（code=-1）」。
 *    修法**只做「把已有信号呈现出来」**：`connect_error` 写一条 error 级 notice，
 *    页面只读 notice（**不**在页面里判断 socket 状态）。
 *
 * R455 的「notice 不被后续信号覆盖」与既有裁决 R16/N1 同族（见
 * `reconnect-flow.test.ts` 的「13010 的处置 notice 不得被 snapshot_unavailable 覆盖」）
 * ⇒ 本文件包含**正对照**：链路恢复后不得留下 error 级 notice（否则是恒红），
 * 且同一次断线周期内反复 `connect_error` 只提示一次（不刷屏）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import type { RoomInfo } from '@fight-the-landlord/protocol';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import GamePage from '../src/pages/game/game.vue';
import * as rest from '../src/net/rest';
import { RECONNECT_DEBOUNCE_MS } from '../src/net/transport';
import type { SocketFactory } from '../src/net/transport';
import { createGameSession, type GameSession, type SessionNotice } from '../src/net/session';
import {
  createSessionOptions,
  getGameSession,
  startGameSession,
  stopGameSession,
} from '../src/composables/useGameSession';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import { clearSession, getDeviceId, saveSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { collectSourceFiles, stripComments } from './helpers/source-scan';
import { installUniStub } from './helpers/uni-stub';
import { FakeSocket } from './helpers/fake-socket';

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

/** 跑得快 2 人场夹具：服务端开放人数由参数决定（客户端能力 ∩ 服务端）。 */
function pdkCountsConfig(counts: number[]) {
  return {
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
    version: 2,
    games: {
      paodekuai: {
        enabled: true,
        supportedPlayerCounts: counts,
        defaultPlayerCount: 3,
        baseScoreLevels: [{ name: '休闲场', baseScore: 15, entryFeePercent: 0 }],
        freeRoomEnabled: true,
        goldRoomEnabled: false,
        friendRoomEnabled: true,
        entryMultiplier: 10,
      },
    },
  };
}

/** 记录 `fetch` 的每一次调用（`rest.ts` 只用到 `status` 与 `text()`）。 */
interface FetchCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(
  route: (call: FetchCall) => unknown,
  status = 200,
): { calls: FetchCall[]; mock: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, text: async () => JSON.stringify(route({ url, init })) };
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

function capturingFactory() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

/**
 * 打开「好友房」弹层（片规格 §4 裁决二：建房 / 房号加入 / 房间列表**整体**收进弹层）。
 *
 * ⚠️ 这三条入口的既有用例**判据一条没少**，只是动手前多一步「用户真的点开了它」——
 * 而这正是弹层形态的语义：**关着的时候它们不在 DOM 里**。
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
   * 片⑦ 夹具：好友房入口按 `store.friendRoomEnabled` 门控（C19 fail-safe，初值 `false`）⇒
   * 本文件涉及好友房的用例（建房 / 列表 / 手动进房）都是**开关开启**态的行为 ——
   * 夹具把配置置成开启。**关闭 / 失败态**的判据在 `friend-room-gate.test.ts`（C19）；
   * 本文件判据**一条不动**，只是补上前提。
   * ⚠️ 走**生产 action**（`setClientConfig`）而不是直接改 state —— 写入路径只有一条。
   * ② 金币场：配置扩到 7 键（免费场开 / 金币场关 / 救助关 / 倍率 10）。
   * 支付片 T14：再扩到 14 键（支付七键给稳定关态——本文件无 oracle 读它们）。
   * 广告片 T19：+第 15 键 `reliefAdpid`（空串 = 未配置 ⇒ 救助入口不渲染；本文件
   * 非救助用例的平台是默认 `web`（非 App）⇒ 入口本就不可达，给关态即可）。
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
  vi.restoreAllMocks();
});

describe('提示浮层化（Task 8）：大厅的本地提示不再占文档流', () => {
  /**
   * ⚠️ **判别力边界**（修复轮 1）：本用例的挂载面上**没有**会话 notice、也**没有**发版提示
   * ⇒ 下面三条「旧宿主 class 不在」在**新旧实现上都成立**（vacuously true），它们钉的只是
   * 「浮层根常驻 + 旧 class 不复现」的形态。真正有判别力的两条「旧组件被摘除」守卫在
   * 有内容可渲染的场合：
   *  - 会话 notice 在场时 `.lobby__notice` 不得复现（本文件 N30 端到端用例）；
   *  - 旧组件类名不得复现（`notice-presentation.test.ts` 的 `src/**` 剥注释扫描是唯一兜底；
   *    `ConnectionDeadBar.vue` 已随 Task 11 删除，本文件不再单独断言旧横条）。
   */
  it('大厅提示全部浮层化：无 .lobby__notice/.lobby__levels-error/.lobby__update-bar', async () => {
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
    await flushPromises();
    expect(wrapper.find('.lobby__notice').exists()).toBe(false);
    expect(wrapper.find('.lobby__levels-error').exists()).toBe(false);
    expect(wrapper.find('.lobby__update-bar').exists()).toBe(false);
    expect(wrapper.find('.stage__overlay .notice-stack').exists()).toBe(true);
  });
});

describe('N30③ / R454：rest.createRoom 走 POST /api/rooms', () => {
  it('POST /api/rooms + 带鉴权 + 统一信封解析（§7.1 / §11.1）', async () => {
    const { calls } = stubFetch(() => ({
      code: 0,
      message: 'ok',
      data: roomFixture('ABC123', { mode: 'practice' }),
    }));

    const res = await rest.createRoom({ mode: 'practice' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/rooms');
    expect(calls[0]!.init?.method).toBe('POST');
    // 复用既有 `send()`：body 是 JSON、content-type 也在（body 由调用方给的是对象）
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ mode: 'practice' });
    expect(res.code).toBe(0);
    expect(res.data?.code).toBe('ABC123');
  });

  it('非 0 的信封原样交回调用方，不伪造成功（§11.1）', async () => {
    stubFetch(() => ({ code: 12001, message: '房间不存在', data: null }));

    const res = await rest.createRoom({ mode: 'random' });

    expect(res.code).toBe(12001);
    expect(res.data).toBeNull();
  });

  it('带 Authorization（走 authedRequest 的既有封装，不另造第二份请求实现）', async () => {
    clientConfig.token = 'a1';
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const { calls } = stubFetch(() => ({ code: 0, data: roomFixture('ABC123') }));

    await rest.createRoom({ mode: 'practice' });

    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });
  });
});

describe('R802 / R805：rest.joinRoom 走 POST /api/rooms/:code/join（**占座**）', () => {
  it('URL 形状 + POST + 带鉴权（复用 authedRequest，不另造第二份请求实现）', async () => {
    clientConfig.token = 'a1';
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const { calls } = stubFetch(() => ({
      code: 0,
      data: roomFixture('ABC123', { playerCount: 1 }),
    }));

    const res = await rest.joinRoom('abc123');

    expect(calls).toHaveLength(1);
    // ⚠️ 大小写归一化在**页面**（`join()` 里 `.trim().toUpperCase()`），不在传输层 ——
    // `net/rest.ts` 只负责「把服务端说的话搬回来」（哑终端），连房号都要它去猜就更不对了。
    expect(calls[0]!.url).toContain('/rooms/abc123/join');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });
    expect(res.code).toBe(0);
    expect(res.data?.playerCount).toBe(1);
  });

  it('非 0 的信封原样交回调用方（占座被拒不得伪造成成功，R807）', async () => {
    stubFetch(() => ({ code: 12002, message: '房间已满', data: null }));

    const res = await rest.joinRoom('ABC123');

    expect(res.code).toBe(12002);
    expect(res.data).toBeNull();
  });

  it('房号过 encodeURIComponent（非法字符不得越出路径段）', async () => {
    const { calls } = stubFetch(() => ({ code: 0, data: roomFixture('ABC123') }));

    await rest.joinRoom('a/../b');

    // `/` 被编码 ⇒ 仍在**同一段**路径里，不会变成 `/rooms/a/../b/join`
    expect(calls[0]!.url).toContain('/rooms/a%2F..%2Fb/join');
  });
});

describe('N30③ / R454：玩法页建房入口与房间列表可点（复用唯一的 room.join）', () => {
  /**
   * 片③：开局区搬到玩法页之后，**涉及开局区的用例挂这一页**。
   *
   * ⚠️ 本助手**取代**了原来的 `mountLobby`：它原先唯一的四个用户（建房 / 建房失败 /
   * 点列表项 / 房号归一化）**全部是开局区用例** ⇒ 一起搬到了玩法页，留下的 `mountLobby`
   * 是**死代码**（`noUnusedLocals` 实测报 TS6133）⇒ 按「不留空壳」的既有纪律删掉。
   * 脚手架与原实现**逐字相同**（`stubFetch` / `capturingFactory` / `startGameSession`）——
   * 玩法页与大厅读的是**同一套** net 层，差别只有挂载的组件（`GamePage` 而非 `LobbyPage`）。
   */
  function mountGame(list: RoomInfo[] = []) {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    const { calls } = stubFetch((call) =>
      call.init?.method === 'POST'
        ? { code: 0, data: roomFixture('NEW123', { mode: 'practice' }) }
        : { code: 0, data: list },
    );
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    return { wrapper, socket: sockets[0]!, calls };
  }

  it('S5.4：房间列表按当前玩法查询（GET /api/rooms?gameType=paodekuai）', async () => {
    useGameStore().setActiveMode('paodekuai');
    const { calls } = mountGame([]);
    await flushPromises();

    const roomGets = calls.filter((c) => (c.init?.method ?? 'GET') === 'GET');
    expect(
      roomGets.some((c) => c.url.includes('/rooms?gameType=paodekuai')),
      '大厅/玩法页的 GET /api/rooms 必须带 activeMode（否则 pdk 模式只看到斗地主房）',
    ).toBe(true);
  });

  it('点「创建房间」→ POST /api/rooms，然后用**同一条** room.join 进房（R61）', async () => {
    const { wrapper, socket, calls } = mountGame();
    await flushPromises();
    /**
     * 片② 客户端：建房也带上**大厅选中的底分**（与 `match()` 同一条纪律）——
     * 预置 **80**（**不是**服务端缺省档 15）才有判别力：「省略不发」或「写死 15」的实现
     * 会在 `baseScore: 80` 上当场红。
     */
    useGameStore().setSelectedBaseScore(80);

    await openFriends(wrapper);
    const create = wrapper.findAll('button').find((b) => flat(b.text()) === '创建房间');
    expect(create, '玩法页必须有「创建房间」按钮（N30③）').toBeDefined();
    await create!.trigger('click');
    await flushPromises();

    // ① REST 建房（POST，body 带 mode + **选中的**底分）
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post, '必须真的发 POST /api/rooms').toBeDefined();
    expect(post!.url).toContain('/rooms');
    expect(JSON.parse(String(post!.init?.body))).toEqual({
      mode: 'practice',
      baseScore: 80,
      gameType: 'doudizhu',
      playerCount: 3,
    });

    // ② 进房走的是**既有**的 room.join（只此一条消息，不复制第二份实现）
    const joins = socket.emittedOf('room.join');
    expect(joins).toHaveLength(1);
    expect(joins[0]!.env.payload).toEqual({ roomCode: 'NEW123', gameType: 'doudizhu' });
    expect(socket.emittedOf('room.match')).toHaveLength(0);

    // ③ R61：ack 里的 players 由这条路径消费 → 座位进 store 并进牌桌
    joins[0]!.ack(null, {
      code: 0,
      data: { roomCode: 'NEW123', seat: 2, players: [{ id: 'u1', seat: 2 }] },
    });
    await flushPromises();

    const store = useGameStore();
    expect(store.roomCode).toBe('NEW123');
    expect(store.mySeat).toBe(2);
    expect(useAuthStore().page).toBe('table');
  });

  it('没选底分（null）⇒ POST body 仍是 `{ mode: \'practice\' }`（**省略键**，不是 `baseScore: null`）', async () => {
    const { wrapper, calls } = mountGame();
    await flushPromises();
    expect(useGameStore().selectedBaseScore, '前置：大厅没选过底分').toBeNull();

    await openFriends(wrapper);
    const create = wrapper.findAll('button').find((b) => flat(b.text()) === '创建房间');
    expect(create, '玩法页必须有「创建房间」按钮（N30③）').toBeDefined();
    await create!.trigger('click');
    await flushPromises();

    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post, '必须真的发 POST /api/rooms').toBeDefined();
    /**
     * 「没选」的唯一正确编码是**省略 `baseScore` 这个键**（服务端据此走它自己的缺省档）。
     * ⚠️ 传 `baseScore: null` **不是**「没传」：`null !== undefined` ⇒ 服务端会把它拿去
     * 档位表里查、查不到 ⇒ `10001`「底分不属于档位表」（`rooms.service.ts:190` 那个分支）。
     * ⚠️ 到线上形态（`JSON.stringify`）为止，「`baseScore: undefined`」与「省略」不可区分 ——
     * 所以这里钉的正是 body 里**没有**这个键。
     */
    expect(JSON.parse(String(post!.init?.body))).toEqual({
      mode: 'practice',
      gameType: 'doudizhu',
      playerCount: 3,
    });
  });

  it('创建失败（非 0）→ 只提示，**不发** room.join、不进牌桌', async () => {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    stubFetch((call) =>
      call.init?.method === 'POST'
        ? { code: 12005, message: '房间数已达上限', data: null }
        : { code: 0, data: [] },
    );
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();

    await openFriends(wrapper);
    const create = wrapper.findAll('button').find((b) => flat(b.text()) === '创建房间');
    await create!.trigger('click');
    await flushPromises();

    expect(sockets[0]!.emittedOf('room.join')).toHaveLength(0);
    /**
     * Task 9：REST 建房失败的文案走统一文案链（`playerMessage`，固定码不再透传服务端措辞）
     * —— 12005 的固定文案是 `没有权限进行该操作`（`net/copy.ts` 的 FIXED_COPY）。
     */
    expect(
      flat(wrapper.find('[data-notice-id="game-error"] .notice__text').text()),
    ).toContain('创建房间失败：没有权限进行该操作');
    expect(useAuthStore().page).not.toBe('table');
  });

  it('点房间列表项 → 走同一条 room.join（房号取自该项）', async () => {
    const { wrapper, socket } = mountGame([roomFixture('ROOM09', { playerCount: 1 })]);
    await flushPromises();

    await openFriends(wrapper);
    const item = wrapper.find('.game__item');
    expect(item.exists(), '房间列表项必须存在').toBe(true);
    await item.trigger('click');
    await flushPromises();

    const joins = socket.emittedOf('room.join');
    expect(joins).toHaveLength(1);
    expect(joins[0]!.env.payload).toEqual({ roomCode: 'ROOM09', gameType: 'doudizhu' });
  });

  it('两种入口共用同一个房号归一化（列表项同样大写、去空白）', async () => {
    const { wrapper, socket } = mountGame([roomFixture('room-ab')]);
    await flushPromises();

    await openFriends(wrapper);
    await wrapper.find('.game__item').trigger('click');
    await flushPromises();

    expect(socket.emittedOf('room.join')[0]!.env.payload).toEqual({ roomCode: 'ROOM-AB', gameType: 'doudizhu' });
  });

  it('🔴 弹层关着时，建房/房号/列表三个入口**都不在 DOM 里**（否则「收进弹层」无法证伪）', async () => {
    const { wrapper } = mountGame();
    await flushPromises();

    expect(wrapper.find('.game__create-room').exists(), '关着时不得渲染建房按钮').toBe(false);
    expect(wrapper.find('.game__join input').exists(), '关着时不得渲染房号输入框').toBe(false);
    expect(wrapper.find('.game__rooms').exists(), '关着时不得渲染房间列表').toBe(false);

    await openFriends(wrapper);

    expect(wrapper.find('.game__create-room').exists(), '开了就得都在').toBe(true);
    expect(wrapper.find('.game__join input').exists()).toBe(true);
    expect(wrapper.find('.game__rooms').exists()).toBe(true);
  });

  it('源码级：game.vue 里 room.join 只有**一个**调用点（R454：不得复制第二份实现）', () => {
    /**
     * ⚠️ 片③ Task 3 的**迁移**：开局区（连同它唯一的 `join()`）整体搬到了玩法页
     * ⇒ 本条**跟着实现走**。延续指着 `lobby.vue` 只会数到 0 处（那里已经没有
     * `room.join` 了）—— 判据的本意是「同一条消息只有一处实现」，实现搬到哪、判据跟到哪。
     * **判别力不变**：仍是「这一条消息的调用点恰好 1 处」。
     */
    const game = collectSourceFiles().find((f) => f.path === 'src/pages/game/game.vue');
    expect(game, 'game.vue 必须存在').toBeDefined();
    // 引号风格不限（仓内格式化器会输出双引号）。
    const callSites = [...game!.content.matchAll(/send\(\s*(['"])room\.join\1/g)];
    expect(callSites, '同一条 room.join 只能有一种实现').toHaveLength(1);
  });

  it('跑得快 2 人场：人数控件出现、默认 3、在 .game__match 之外', async () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(pdkCountsConfig([2, 3]));
    const { wrapper } = mountGame();
    await flushPromises();

    const options = wrapper.findAll('.game__player-option');
    expect(options.map((o) => flat(o.text()))).toEqual(['2 人', '3 人']);
    expect(wrapper.find('.game__match .game__player-option').exists(), '控件不得进 .game__match').toBe(false);
    expect(wrapper.findAll('.game__match button'), '.game__match button 恒唯一').toHaveLength(1);
    expect(store.effectivePlayerCount).toBe(3);
    expect(flat(wrapper.find('.game__player-option--active').text())).toBe('3 人');
  });

  it('服务端只开 3 人 ⇒ 人数控件不渲染', async () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(pdkCountsConfig([3]));
    const { wrapper } = mountGame();
    await flushPromises();
    expect(wrapper.find('.game__players').exists()).toBe(false);
  });

  it('选 2 人后开始游戏：room.match 载荷 playerCount=2（number）', async () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(pdkCountsConfig([2, 3]));
    store.setSelectedBaseScore(15);
    const { wrapper, socket } = mountGame();
    await flushPromises();

    const two = wrapper.findAll('.game__player-option').find((o) => flat(o.text()) === '2 人');
    expect(two).toBeDefined();
    await two!.trigger('click');
    expect(flat(wrapper.find('.game__player-option--active').text())).toBe('2 人');
    const start = wrapper.findAll('.game__match button').find((b) => flat(b.text()) === '开始游戏');
    expect(start).toBeDefined();
    await start!.trigger('click');
    await flushPromises();

    const matches = socket.emittedOf('room.match');
    expect(matches).toHaveLength(1);
    const payload = matches[0]!.env.payload as { playerCount?: unknown };
    expect(payload.playerCount).toBe(2);
    expect(typeof payload.playerCount).toBe('number');
  });

  it('选 4 人后开始游戏：room.match 载荷 playerCount=4', async () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(pdkCountsConfig([2, 3, 4]));
    store.setSelectedBaseScore(15);
    const { wrapper, socket } = mountGame();
    await flushPromises();

    const four = wrapper.findAll('.game__player-option').find((o) => flat(o.text()) === '4 人');
    expect(four).toBeDefined();
    await four!.trigger('click');
    const start = wrapper.findAll('.game__match button').find((b) => flat(b.text()) === '开始游戏');
    expect(start).toBeDefined();
    await start!.trigger('click');
    await flushPromises();

    const matches = socket.emittedOf('room.match');
    expect(matches).toHaveLength(1);
    expect((matches[0]!.env.payload as { playerCount?: unknown }).playerCount).toBe(4);
  });

  it('再来一局：上一局 2 人 ⇒ 选择回写 2 且载荷 2', async () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(pdkCountsConfig([2, 3]));
    store.setSelectedBaseScore(15);
    store.setPlayerCount(2);
    store.requestRematch();
    const { socket } = mountGame();
    await flushPromises();

    expect(store.selectedPlayerCount).toBe(2);
    const matches = socket.emittedOf('room.match');
    expect(matches).toHaveLength(1);
    expect((matches[0]!.env.payload as { playerCount?: unknown }).playerCount).toBe(2);
  });

  it('2 人闸已关 ⇒ 再来一局回写被拒、载荷回落 3', async () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(pdkCountsConfig([3]));
    store.setSelectedBaseScore(15);
    store.setPlayerCount(2);
    store.requestRematch();
    const { socket } = mountGame();
    await flushPromises();

    expect(store.selectedPlayerCount, 'setter 拒绝写入 2').toBe(3);
    const matches = socket.emittedOf('room.match');
    expect(matches).toHaveLength(1);
    expect((matches[0]!.env.payload as { playerCount?: unknown }).playerCount).toBe(3);
  });

  it('好友房建房带选中人数 2', async () => {
    const store = useGameStore();
    store.setActiveMode('paodekuai');
    store.setClientConfig(pdkCountsConfig([2, 3]));
    store.setSelectedPlayerCount(2);
    const { wrapper, calls } = mountGame();
    await flushPromises();

    await openFriends(wrapper);
    const create = wrapper.findAll('button').find((b) => flat(b.text()) === '创建房间');
    expect(create).toBeDefined();
    await create!.trigger('click');
    await flushPromises();

    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post, '必须真的发 POST /api/rooms').toBeDefined();
    expect(JSON.parse(String(post!.init?.body)).playerCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 手动进房：**忠实替身**（spec §5.1 / R808）
// ---------------------------------------------------------------------------

/**
 * 上面那组用例的替身是**宽容**的：WS `room.join` 的 ack 由用例**手写**（恒 `code 0`），
 * `stubFetch` 对任何 POST 都回 `code 0`。那是**结构的**替身，够用来验 UI 接线，
 * 但它**不能**验「客户端有没有按真服务端的规矩办事」——
 *
 * 真服务端的规矩（`packages/room-service/src/gateway/message.router.ts:214-223`）是：
 *   `room.join` **只**对「已入座」或「有 `match:pending`」的连接放行，否则 **12004**。
 * 而占座**只能**经 REST `POST /api/rooms/:code/join`（`rooms.controller.ts:42-50`）。
 *
 * ⇒ 这里换一个**有状态**的替身：WS 的放行取决于 REST 那一步有没有真的发生。
 * ⚠️ **这就是 spec §0.5 那条缺口**：旧替身让「先 REST 后 WS」这个因果**不可判**，
 * 于是 F6（创建房间在真后端上 12004 ⇒ 被踢回大厅）在单测里**永远是绿的**。
 */
describe('手动进房：REST 入座必须先于 WS room.join（F6 / R802 / R808）', () => {
  /**
   * 一个只模拟「真服务端对 `room.join` 的规矩」的替身。
   *
   * ⚠️ 它**不立刻答复**，而是把 ack 收着 —— 由用例在**确认 REST 那一步做完了**之后
   * 再放行。这样「REST 有没有先发生」是**用例断言的对象**，不是替身替我们猜的前提
   *（替身猜时序 = 又一次「判据在空测上恒真」）。
   */
  function faithfulJoin(socket: FakeSocket) {
    const pending: Array<() => void> = [];
    const origEmit = socket.emit.bind(socket);
    socket.emit = ((type: string, env: unknown, ack?: (e: Error | null, r?: unknown) => void) => {
      origEmit(type, env, ack);
      if (type !== 'room.join') return;
      const roomCode = String((env as { payload?: { roomCode?: string } })?.payload?.roomCode ?? '');
      pending.push(() => ack?.(null, { code: 12004, message: 'You are not in this room' })); // 未入座
      pending.push(() =>
        ack?.(null, { code: 0, data: { roomCode, seat: 0, players: [{ id: 'me', seat: 0 }] } }),
      ); // 已入座
    }) as FakeSocket['emit'];
    /** 放行第 n 个 `room.join` 的 ack：`true` = 按「已入座」答复，`false` = 按「未入座」答复。 */
    const release = (n: number, seated: boolean) => pending[n * 2 + (seated ? 1 : 0)]?.();
    return { release };
  }

  /**
   * 玩法页 + **忠实替身**。
   *
   * ⚠️ 顺序的判据用 `claimedFirst`（**同一时间轴**上的一个断言），不是「两个数组各比下标」——
   * fetch 与 WS 是两套替身、各记各的，光看下标比不出先后。
   *
   * 归零的时机：`room.join` 被**触发**时把标记清零 ⇒ 若那一刻占座还没兑现，
   * 之后 REST 再成功也不会把它置回 true（标记只在**占座响应**里被置位）。
   */
  function mountFaithfulGame(options: { rejectClaim?: boolean } = {}) {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    const calls: FetchCall[] = [];
    const flags = { claimed: false, claimedFirst: false };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const isClaim = /\/join$/.test(url);
        if (isClaim) {
          if (options.rejectClaim) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 12002, message: '房间已满', data: null }) };
          flags.claimed = true;
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ code: 0, data: roomFixture('NEW123', { mode: 'practice', playerCount: 1 }) }),
          };
        }
        const body =
          init?.method === 'POST'
            ? { code: 0, data: roomFixture('NEW123', { mode: 'practice' }) }
            : { code: 0, data: [] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }),
    );
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    const socket = sockets[0]!;
    const join = faithfulJoin(socket);
    const origEmit = socket.emit.bind(socket);
    socket.emit = ((type: string, env: unknown, ack?: (e: Error | null, r?: unknown) => void) => {
      // 挂载被触发的那一刻：占座**是否已经兑现**，就是「顺序对不对」的全部内容
      if (type === 'room.join') flags.claimedFirst = flags.claimed;
      origEmit(type, env, ack);
    }) as FakeSocket['emit'];
    return { wrapper, socket, calls, flags, join };
  }

  /** 点「创建房间」并等一轮微任务（两条 REST + `room.join` 的前摇都在里面）。 */
  const clickCreate = async (wrapper: VueWrapper<any>) => {
    // ⚠️ 建房按钮在「好友房」弹层里（片规格 §4 裁决二）⇒ 弹层关着时它**不在 DOM 里**。
    await openFriends(wrapper);
    const create = wrapper.findAll('button').find((b) => flat(b.text()) === '创建房间');
    expect(create, '玩法页必须有「创建房间」按钮').toBeDefined();
    await create!.trigger('click');
    await flushPromises();
  };

  it('建房 → REST 占座 → WS 挂载 → 进牌桌（旧实现被 12004 踢回大厅）', async () => {
    const { wrapper, socket, calls, flags, join } = mountFaithfulGame();

    await clickCreate(wrapper);

    // ① 占座**确实**经 REST 发生了（真服务端里这是唯一的占座方式）
    const claim = calls.find((c) => /\/rooms\/NEW123\/join$/.test(c.url));
    expect(claim, '必须先 REST 占座：POST /api/rooms/NEW123/join').toBeDefined();
    expect(claim!.init?.method).toBe('POST');

    // ② **顺序**：WS 挂载被触发时，占座已经兑现（spec §3.2 / R802）
    expect(socket.emittedOf('room.join'), '手动进房恰好一条 room.join').toHaveLength(1);
    expect(flags.claimedFirst, 'WS 挂载之前必须已经占过座（顺序错了就会被服务端 12004）').toBe(true);

    // ③ 服务端入座之后 WS 才被放行 ⇒ 两步都成功 ⇒ 进牌桌
    join.release(0, true);
    await flushPromises();

    const store = useGameStore();
    expect(store.roomCode, '进房后 store 里必须有房间号').toBe('NEW123');
    expect(store.mySeat, '座位来自 room.join 的 ack（R61：不伪造）').toBe(0);
    expect(useAuthStore().page, '两步都成功 ⇒ 进牌桌（旧实现会回到大厅）').toBe('table');
  });

  it('REST 占座失败 ⇒ **零** room.join、留在玩法页、本地提示（R807 / Task 9）', async () => {
    const auth = useAuthStore();
    auth.loggedIn = true; // 前置：已登录（sessionEnded/clearLocalSession 会把它置回 false）
    auth.navigate('game'); // 玩法页的真实状态（默认 page='login'，那会让「未登出」断言失去判别力）
    const { wrapper, socket } = mountFaithfulGame({ rejectClaim: true });

    await clickCreate(wrapper);

    expect(socket.emittedOf('room.join'), '占座失败就不得再发 room.join').toHaveLength(0);
    /**
     * Task 9：REST 占座被拒**不是**会话失效 —— 12002 只做本地提示（带「加入房间失败：」前缀），
     * 绝不走 `dispatchRestFailure` 的 BACK_TO_LOBBY 分支（否则「房间已满」会把玩家登出）。
     */
    expect(
      flat(wrapper.find('[data-notice-id="game-error"] .notice__text').text()),
      'REST 占座失败 ⇒ 本地 game-error 项（带前缀）',
    ).toContain('加入房间失败：房间已满');
    expect(auth.page, '不得登出（仍留在玩法页）').toBe('game');
    expect(auth.loggedIn, '不得清本地会话').toBe(true);
    expect(useAuthStore().page, '不得进牌桌').not.toBe('table');
    expect(useGameStore().roomCode, '不得留下半个房间状态').toBeNull();
  });

  it('WS `room.join` ack 12002 ⇒ 只由 session notice 呈现「房间已满」（无本地前缀）', async () => {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    stubFetch((call) =>
      call.init?.method === 'POST'
        ? { code: 0, data: roomFixture('ROOM09', { mode: 'practice' }) }
        : { code: 0, data: [roomFixture('ROOM09', { playerCount: 1 })] },
    );
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();
    const socket = sockets[0]!;

    await openFriends(wrapper);
    await wrapper.find('.game__item').trigger('click');
    await flushPromises();

    expect(socket.emittedOf('room.join'), '前置：REST 占座成功后发 WS room.join').toHaveLength(1);
    socket.emittedOf('room.join')[0]!.ack(null, { code: 12002, message: '房间已满' });
    await flushPromises();

    // 来源分流（Task 9）：WS ack 非 0 只由 session notice 呈现，页面零本地文案。
    expect(
      flat(wrapper.find('[data-notice-id="session-notice"] .notice__text').text()),
    ).toBe('房间已满');
    expect(wrapper.find('[data-notice-id="game-error"]').exists()).toBe(false);
    expect(flat(wrapper.text()), '不得出现 REST 失败的「加入房间失败：」前缀').not.toContain(
      '加入房间失败：',
    );
  });
});

// ---------------------------------------------------------------------------
// N30① / R455：连不上时的连接状态呈现
// ---------------------------------------------------------------------------

/** 生产装配（`startGameSession`）+ 假 socket；notice 由会话层持有。 */
function liveSession() {
  const { factory, sockets } = capturingFactory();
  const handle = startGameSession(factory);
  return { socket: sockets[0]!, notice: handle.notice };
}

/**
 * 生产接线 + **观察者**：在 `createSessionOptions` 产出的选项上再包一层 `onNotice`，
 * 记录「会话层究竟写了几条 notice」——去重/不刷屏这类性质只能这样数出来。
 * （不另抄一份选项对象：`socketFactory` 等全部来自生产接线。）
 */
function countingSession() {
  const socket = new FakeSocket();
  const sessionRef: { client?: GameSession['client'] } = {};
  const { options, notice } = createSessionOptions(() => socket, sessionRef);
  const written: SessionNotice[] = [];
  const original = options.onNotice!;
  options.onNotice = (n) => {
    written.push(n);
    original(n);
  };
  const session = createGameSession(options);
  sessionRef.client = session.client;
  return { socket, notice, written, session };
}

describe('N30① / R455：socket 连不上时必须给出「连接不可用」', () => {
  it('connect_error → error 级 notice（用户看不出「连接不可用」正是 N30①）', () => {
    const { socket, notice } = liveSession();
    expect(notice.value).toBeNull(); // 前置：还没失败过

    socket.emitConnectError(new Error('websocket error'));

    expect(notice.value).toMatchObject({ level: 'error' });
    expect(notice.value!.text).toContain('连接不可用');
  });

  it('正对照：正常 connect 不得留下任何 notice（否则是恒红）', () => {
    const { socket, notice } = liveSession();

    socket.emitConnect();

    expect(notice.value).toBeNull();
  });

  it('正对照：链路恢复 ⇒ 「连接不可用」被撤下（不留恒红）', () => {
    const { socket, notice } = liveSession();

    socket.emitConnectError(new Error('websocket error'));
    expect(notice.value?.level).toBe('error');

    socket.emitConnect();

    expect(notice.value?.level).not.toBe('error');
    expect(notice.value?.text).toContain('连接已恢复');
  });

  it('正对照：同一次断线周期内反复 connect_error 只写一条 notice（socket.io 自动重连不刷屏）', () => {
    const { socket, written } = countingSession();

    socket.emitConnectError(new Error('websocket error'));
    socket.emitConnectError(new Error('websocket error'));
    socket.emitConnectError(new Error('websocket error'));

    expect(written.filter((n) => n.level === 'error')).toHaveLength(1);

    // 去重按**断线周期**，不是一次性永久静音：链路恢复后再次断线必须重新提示
    socket.emitConnect();
    socket.emitConnectError(new Error('websocket error'));

    expect(written.filter((n) => n.level === 'error')).toHaveLength(2);
  });

  it('正对照（R16/N1 同族）：先写的 error notice 不被后续异步续体覆盖', async () => {
    const { socket, notice } = liveSession();

    socket.emitConnectError(new Error('websocket error'));
    const first = notice.value!.text;

    // 等过既有去抖窗口（RECONNECT_DEBOUNCE_MS）+ 所有异步续体跑完
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DEBOUNCE_MS + 300));

    expect(notice.value!.text).toBe(first);
    expect(notice.value!.level).toBe('error');
  });

  it('R16/N1 正对照：恢复提示不得盖住随后的**确定答复**（13010 处置 notice 最终生效）', async () => {
    const { socket, notice } = liveSession();
    socket.emitConnect(); // 首次连接（此后才有「重连」语义）

    socket.emitDisconnect('transport close');
    socket.emitConnectError(new Error('websocket error'));
    expect(notice.value?.level).toBe('error');

    // 链路回来 → net 层自动 game.reconnect；服务端给了确定答复 13010（BACK_TO_LOBBY）
    socket.emitConnect();
    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
    socket.lastRequest()!.ack(null, { code: 13010, message: 'gone' });

    await vi.waitFor(() => expect(useAuthStore().page).toBe('lobby'));
    // 确定答复是最后写的那条：既不被「连接已恢复」也不被 snapshot_unavailable 覆盖（R16/N1）
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DEBOUNCE_MS + 300));
    // 2026-10-13 起 13010 已登记玩家文案（不再是诊断串）——判别词随之迁移。
    expect(notice.value!.text).toContain('没有可恢复的对局');
    expect(notice.value!.text).not.toContain('未能取回当前快照');
  });

  /**
   * 2026-10-18 用户提问「提示框什么时候消失」时发现的标注遗漏：
   * 13010/13005 是 `CLIENT_ACTION` 表里的**错误码处置**，但 notice 没带 `source: 'action'`
   * ⇒ 按「非 ACTION」待遇、`clearNotice()` 清不掉 ⇒ 「没有可恢复的对局」会永久滞留在顶部。
   * 本用例钉两件：① 通知对象带 `{ code, source: 'action' }`；② 可被 `clearNotice()` 清除。
   */
  it('13010 处置提示标为 action 源（带 code）且可被 clearNotice 清掉（不再永久滞留）', async () => {
    const { socket, notice } = liveSession();
    socket.emitConnect(); // 首次连接（此后才有「重连」语义）
    socket.emitDisconnect('transport close');
    socket.emitConnect(); // 链路回来 → 自动 game.reconnect
    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
    socket.lastRequest()!.ack(null, { code: 13010, message: 'gone' });

    await vi.waitFor(() => expect(notice.value?.text).toContain('没有可恢复的对局'));
    expect(notice.value, '13010 是错误码处置 ⇒ 必须带 source: action 与 code').toMatchObject({
      level: 'warn',
      code: 13010,
      source: 'action',
    });

    getGameSession().clearNotice();
    await nextTick();
    expect(notice.value, 'clearNotice 必须能清掉它（否则会永久滞留在页面顶部）').toBeNull();
  });

  it('端到端（用户能看见的那一步）：connect_error 后大厅真的渲染「连接不可用」', async () => {
    const { socket } = liveSession();
    stubFetch(() => ({ code: 0, data: [] }));
    const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(wrapper.find('[data-notice-id="session-notice"]').exists()).toBe(false);

    socket.emitConnectError(new Error('websocket error'));
    await nextTick();

    const banner = wrapper.find('[data-notice-id="session-notice"]');
    expect(banner.exists(), '大厅必须渲染会话 notice（N30①）').toBe(true);
    expect(
      wrapper.findAll('[data-notice-id="session-notice"]'),
      '会话提示只出现一条（Stack 内不重复）',
    ).toHaveLength(1);
    /**
     * 🔴 **旧宿主摘除的真实守卫**（修复轮 1）：旧 `SessionNotice` 由大厅以
     * `class="lobby__notice"` 挂载，且它读的是**同一个** `currentSession.notice`
     * ⇒ 页面若把旧组件挂回来，这条活会话 notice 会让它渲染出**第二条**.
     * 没有会话时断言 `.lobby__notice` 不存在是恒真的（见本文件开头的浮层化用例），
     * 这里才是可证伪的那一格。
     */
    expect(
      wrapper.find('.lobby__notice').exists(),
      '旧 SessionNotice 宿主不得复现（提示只走 Stack 的 session-notice 项）',
    ).toBe(false);
    /**
     * ⚠️ 片③ Task 3：**级别 class 由共用件发**（`SessionNotice.vue`，R751）；提示收敛
     * Task 8 起会话提示改由 `NoticeStack` 渲染 —— `data-notice-id="session-notice"` 是
     * 该条目的锚点，级别 class（`notice--{level}`）落在**条目自己**身上（不断言容器）。
     * 断言的对象没变：**error 级**的会话提示条。
     */
    expect(banner.classes()).toContain('notice--error');
    expect(flat(banner.text())).toContain('连接不可用');
  });

  it('源码级红线：页面**只读** notice，不自己判断 socket 是否连上（R455）', () => {
    /**
     * ⚠️ 评审修复轮 1：`SessionNotice` 的宿主现在有**两页**（大厅 + 玩法页）⇒
     * 同一条红线必须**两页都扫**。只扫大厅时，「玩法页自己判断连接状态」是无人看守的空档。
     */
    const sources = collectSourceFiles();
    for (const path of ['src/pages/lobby/lobby.vue', 'src/pages/game/game.vue']) {
      const page = sources.find((f) => f.path === path);
      expect(page, `${path} 必须在源码扫描集合里`).toBeDefined();
      expect(page!.content).not.toMatch(/hasConnected/);
      expect(page!.content).not.toMatch(/\.connected\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// R658/R760：玩法页消费「再来一局」的一次性意向（唯一的 room.match 在这里兑现）
// ---------------------------------------------------------------------------

/**
 * **评审 F1（Important）**：`settlement-rematch.test.ts` ⑤ 只数了 `game.vue` 里
 * `send('room.match'` 的出现次数，**从不断言玩法页真的消费了意向** —— 实测把消费行
 * （`onMounted` 里那一句）删掉，整套测试**仍然全绿**，探针也看不到
 *（`full` 场景从 `.table__bar .btn` 退出、不点 `.settlement__again`）。
 * ⇒ 接收半边此前**没有任何保护**，这里补上页面级判据。
 *
 * ⚠️ **片③ R760 改了链路**：消费点随开局区（`match()`）从大厅搬到**玩法页** ⇒
 * 本组的挂载对象由 `LobbyPage` 换成 `GamePage`。判据本身**一条没少**：
 * 仍是「无意向 ⇒ 不匹配」的正对照 + 「有意向 ⇒ 恰好一条、读后即清」+ 幂等三条半边。
 *
 * 脚手架照抄上面 `mountGame` 的 `capturingFactory` + `stubFetch` 替身。
 * ⚠️ 「第二次挂载」**刻意不再调 `startGameSession`**：它遇到已存在的 handle 会早退
 *（不建新 socket），而我们要的正是「同一个会话/同一个 socket 上会不会出现第二条
 * `room.match`」—— 那才是幂等的可观测形态。
 */
describe('R658/R760：玩法页挂载时消费「再来一局」的一次性意向（room.match 只兑现一次）', () => {
  /**
   * ⚠️ 片② 客户端起：`match()` 用的是 **`store.selectedBaseScore`**（用户在大厅选的那一档），
   * 而本组直接挂页面（没有走大厅）⇒ 必须**先预置**它。
   *
   * 预置 **80** 挡的是**另一类**错误实现：`baseScore` 写死 15（M09 违例）或「从档位表数组取第一档」
   * —— 那两种在 `toEqual({ mode: 'random', baseScore: 80, deviceId: … })` 上当场红。
   * ⚠️ **但本组的 fixture 下「取第一档」的旧实现会先以「0 条」红**（下面的替身不喂档位表 ⇒
   * 旧实现拿不到 levels 就早退）⇒ 这条用例的**第一道**判别力是条数，不是 80 这个值。
   */
  function mountGameForRematch() {
    const { factory, sockets } = capturingFactory();
    startGameSession(factory);
    useGameStore().setSelectedBaseScore(80);
    stubRoomsFetch();
    const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
    return { wrapper, socket: sockets[0]! };
  }

  /**
   * 本页唯一会发的 REST 是 `GET /api/rooms`（档位表归大厅取，见 `match()` 的头注释）。
   *
   * 🔴 **必须写成函数形态**：`lobby-ux.test.ts` 自己的 `stubFetch` 签名是
   * `(route: (call: FetchCall) => unknown, status = 200)` —— **只吃函数**，传对象会
   * TS2345 且该次 fetch 的 `text()` 抛错。（能收对象的是 `auth-ui-wiring.test.ts` 的
   * 同名助手，签名不同。同名不同签名是本仓既有事实，照抄时按**本文件**的来。）
   */
  function stubRoomsFetch() {
    return stubFetch(() => ({ code: 0, data: [] }));
  }

  it('正对照两半：无意向 ⇒ 不发 room.match；有意向 ⇒ 挂载后恰好一条（且读后即清）', async () => {
    const store = useGameStore();

    const { socket } = mountGameForRematch();
    await flushPromises();
    expect(socket.emittedOf('room.match'), '没有意向时玩法页不得自己发匹配').toHaveLength(0);

    // 同一 store / 同一会话再挂一个玩法页实例（= 真浏览器里「牌桌回玩法页」的那一次挂载）
    store.requestRematch();
    mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();

    const matches = socket.emittedOf('room.match');
    expect(matches, '牌桌留下的一次性意向必须被玩法页兑现成一次匹配').toHaveLength(1);
    // 协议②：`baseScore` 必填，且必须来自**用户选中的那一档**（不得写死 —— M09）
    // 风控 T8：`deviceId` 随行（持久化的同一枚 —— 意向兑现与手动匹配走的是同一条 send）
    expect(matches[0]!.env.payload).toEqual({
      mode: 'random',
      baseScore: 80,
      gameType: 'doudizhu',
      playerCount: 3,
      deviceId: getDeviceId(),
    });
    expect(store.rematchPending, '读后即清').toBe(false);
  });

  it('幂等：意向只兑现一次（第二次挂载不再发 room.match，consumeRematch() 返回 false）', async () => {
    const store = useGameStore();
    store.requestRematch();

    const { socket } = mountGameForRematch();
    await flushPromises();
    expect(socket.emittedOf('room.match')).toHaveLength(1);

    mount(GamePage, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(
      socket.emittedOf('room.match'),
      '第二次必须仍只有 1 条（读后即清 ⇒ 不得重复兑现）',
    ).toHaveLength(1);
    expect(store.consumeRematch(), 'consumeRematch 第二次必须 false').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ② 金币场：大厅的四件新行为（§14）—— 余额 chip / 门槛提示 / 置灰 / 救助
// ---------------------------------------------------------------------------

/** `GET /api/config` 的 7 键成功后端 + 广告片第 15 键 `reliefAdpid`（可按用例覆盖任意键）。 */
function goldConfig(over: Record<string, unknown> = {}): unknown {
  return {
    code: 0,
    data: {
      baseScoreLevels: [
        { name: '休闲场', baseScore: 15 },
        { name: '标准场', baseScore: 80 },
      ],
      friendRoomEnabled: true,
      freeRoomEnabled: true,
      goldRoomEnabled: true,
      reliefEnabled: true,
      reliefAdpid: 'adpid_test_1',
      entryMultiplier: 10,
      version: 9,
      ...over,
    },
  };
}

/**
 * 挂大厅（生产会话 + **按平台两条传输**的响应替身）。返回 `calls` 供 REST 面断言。
 *
 * `routes.balance` 缺省 `{ balance: 100000 }`（够高：默认不触发置灰/救助 —— 那两件事
 * 由传值显式驱动，判据不靠缺省）。
 * `routes.relief` 缺省是**不可领**面（广告片 T19 的 GET 契约形状）——救助流程的用例显式传值。
 *
 * ⚠️ **`platform: 'app'`（广告片 T19 追加）**：真实平台链上 App 的 REST 走 `uni.request`
 * （`net/http.ts`：App 的 service 侧没有可用的 fetch —— N39 实测）⇒ 替身接在
 * `uni.request` 的 `requestResponder` 上、**一次都不碰 fetch**（与真机同形）；
 * `calls` 的记账形状两条路一致（`{ url, init: { method, headers } }`），断言不用分叉。
 * 入口复合门控（`isRewardedAdSupported()`）只有在 `'app'` 下才为真 —— 本文件用**真实现**
 * 走真平台链，替身只换住宿主（`uni`）。
 */
function mountLobbyRoutes(
  routes: { config?: unknown; balance?: unknown; relief?: unknown } = {},
  platform: 'web' | 'app' = 'web',
) {
  const { factory } = capturingFactory();
  startGameSession(factory);
  const calls: FetchCall[] = [];
  const routeBody = (url: string): unknown =>
    url.includes('/wallet/relief')
      ? (routes.relief ?? {
          code: 0,
          data: { eligible: false, grantedToday: false, amount: 200, balance: 100000, reason: '救助暂未开放' },
        })
      : url.includes('/wallet/balance')
        ? (routes.balance ?? { code: 0, data: { balance: 100000 } })
        : url.includes('/config')
          ? (routes.config ?? goldConfig())
          : { code: 0, data: [] };

  if (platform === 'app') {
    const stub = installUniStub({ platform: 'app' });
    stub.requestResponder = (options) => {
      calls.push({ url: options.url, init: { method: options.method, headers: options.header } });
      // `data` 给**对象**：真 uni 的 dataType 默认 json ⇒ 服务端 JSON 在宿主层已 parse
      // （`http.ts#toText` 会序列化回文本；替身照真形态，不走捷径）。
      return { statusCode: 200, data: routeBody(options.url) };
    };
  } else {
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(routeBody(url)) };
    });
    vi.stubGlobal('fetch', mock);
  }
  useAuthStore().navigate('lobby');
  const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
  return { wrapper, calls };
}

describe('② 余额 chip（GET /api/wallet/balance；登录后拉 / 回厅刷新）', () => {
  /**
   * ⚠️ 支付片 T14 的成对变更：金币视图从「玩家信息条」拆进了**钱包入口按钮**
   * （`.wallet-entry` —— 规格 §4「金币显示处点击 ⇒ 跳钱包页」的前提；身份/钱包是兄弟按钮）。
   * 断言语义一条没变（余额真值 / 「—」fail-safe / 响应直刷），只换了宿主选择器。
   */
  it('挂载取余额 ⇒ chip 显真值；重挂（回厅）⇒ 重取并刷新', async () => {
    clientConfig.token = 'a1';
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });

    const first = mountLobbyRoutes({ balance: { code: 0, data: { balance: 880 } } });
    await flushPromises();
    expect(first.wrapper.find('.wallet-entry .chip__currency').text()).toBe('880');
    const call = first.calls.find((c) => c.url.includes('/wallet/balance'));
    expect(call, '必须真的发 GET /api/wallet/balance').toBeDefined();
    expect(call!.init?.method ?? 'GET', '只读 GET').toBe('GET');
    expect(call!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });
    first.wrapper.unmount();

    // 「回厅刷新」：重新挂载 = 真浏览器里回大厅那一次挂载 ⇒ 再取一次
    const again = mountLobbyRoutes({ balance: { code: 0, data: { balance: 990 } } });
    await flushPromises();
    expect(again.wrapper.find('.wallet-entry .chip__currency').text(), '回厅重取').toBe('990');
    expect(
      again.calls.filter((c) => c.url.includes('/wallet/balance')),
      '每次挂载都重取（服务端侧不缓存）',
    ).toHaveLength(1);
  });

  it('🔴 余额取不到（信封非 0 / fetch 被拒 / 违约）⇒ 写回 null ⇒ chip 显「—」（fail-safe）', async () => {
    const bad = mountLobbyRoutes({ balance: { code: 10007, message: '下游不可用', data: null } });
    await flushPromises();
    expect(bad.wrapper.find('.wallet-entry .chip__currency').text()).toBe('—');
    expect(useGameStore().walletBalance, '未知一律写回 null —— 不保留上一次的值').toBeNull();
    bad.wrapper.unmount();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    useAuthStore().navigate('lobby');
    const thrown = mount(LobbyPage, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(thrown.find('.wallet-entry .chip__currency').text()).toBe('—');
  });
});

describe('② 金币档位卡：门槛提示 / 余额不足置灰（§14）', () => {
  it('金币场选中 ⇒ 每档提示「需 ≥ baseScore×entryMultiplier」；免费场无提示（正对照）', async () => {
    // 倍率刻意取 7（而不是缺省 10）：150/800 这类硬编码在 105/560 上当场红。
    const { wrapper } = mountLobbyRoutes({ config: goldConfig({ entryMultiplier: 7 }) });
    await flushPromises();

    expect(wrapper.find('.lobby__level-need').exists(), '免费场没有门槛提示').toBe(false);

    await wrapper.findAll('.lobby__session')[1]!.trigger('click'); // 金币场

    expect(wrapper.findAll('.lobby__level-need').map((n) => flat(n.text()))).toEqual([
      '需 ≥ 105 金币', // 15 × 7
      '需 ≥ 560 金币', // 80 × 7
    ]);
  });

  it('余额不足 ⇒ 该档置灰；点击**不跳页**、出 14003 同形消息；余额足的档照常进页', async () => {
    const { wrapper } = mountLobbyRoutes({
      config: goldConfig({ entryMultiplier: 10 }),
      balance: { code: 0, data: { balance: 200 } },
    });
    await flushPromises();
    await wrapper.findAll('.lobby__session')[1]!.trigger('click'); // 金币场

    const cards = wrapper.findAll('.lobby__level');
    expect(cards[0]!.classes(), '15×10=150 ≤ 200 ⇒ 不置灰').not.toContain('lobby__level--locked');
    expect(cards[1]!.classes(), '80×10=800 > 200 ⇒ 置灰').toContain('lobby__level--locked');

    await cards[1]!.trigger('click');
    expect(flat(wrapper.get('[data-notice-id="entry"] .notice__text').text()), '消息与服务端 14003 同形').toBe(
      '金币不足：该场次需要 ≥ 800',
    );
    expect(useAuthStore().page, '已判明不足 ⇒ 不跳页').toBe('lobby');

    await cards[0]!.trigger('click');
    expect(useAuthStore().page, '余额足的档照常进页（正对照）').toBe('game');
    expect(useGameStore().selectedBaseScore).toBe(15);
  });

  it('边界：余额**恰等于**门槛 ⇒ 可进（服务端判据是 `<`，客户端不得用 `<=`）', async () => {
    const { wrapper } = mountLobbyRoutes({
      config: goldConfig({ entryMultiplier: 10 }),
      balance: { code: 0, data: { balance: 150 } }, // 15×10 = 150
    });
    await flushPromises();
    await wrapper.findAll('.lobby__session')[1]!.trigger('click');

    const first = wrapper.findAll('.lobby__level')[0]!;
    expect(first.classes(), '余额恰等于门槛 ⇒ 不置灰').not.toContain('lobby__level--locked');
    await first.trigger('click');
    expect(useAuthStore().page, '恰等于门槛可进页').toBe('game');
  });

  it('余额未知（取数失败）⇒ 不置灰、不提示（服务端仍是权威）', async () => {
    const { wrapper } = mountLobbyRoutes({
      config: goldConfig({ entryMultiplier: 10 }),
      balance: { code: 10007, message: '下游不可用', data: null },
    });
    await flushPromises();
    await wrapper.findAll('.lobby__session')[1]!.trigger('click');

    expect(wrapper.find('.lobby__level--locked').exists(), '余额未知 ⇒ 客户端不猜').toBe(false);
    expect(wrapper.findAll('.lobby__level-need'), '门槛提示与余额无关，仍要显示').toHaveLength(2);
  });
});

describe('② 领取救助：入口复合门控（§14 · 广告片 T19）', () => {
  /** ② 组的 apiBase 备份（本组按 P26/R632 给绝对端点，afterEach 还原）。 */
  let originalApiBase = '';
  /**
   * 救助入口是**复合门控**（规格 §2.9 逐字）：`store.reliefAvailable`
   * （`reliefEnabled ∧ 余额 < 档位表最低档 × entryMultiplier` —— store getter 的既有判据）
   * ∧ `isRewardedAdSupported()`（**真实现**：读 uni 平台，非 App ⇒ false）
   * ∧ `store.reliefAdpid !== ''`（第 15 键；空串 = 未配置）。
   *
   * ⚠️ 本组故意**不替身 `net/ads`**：走真实现 + uni 替身 ⇒ 「平台收口链」
   * （uni.getSystemInfoSync → detectPlatform → isRewardedAdSupported）一并被验；
   * 流程编排（四分支 + 轮询）在 `ads-flow.test.ts`（那里才换成 ads 替身）。
   */
  beforeEach(() => {
    installUniStub({ platform: 'app' });
    /**
     * ⚠️ P26/R632：App 是**无「同源」平台** —— 相对 `/api` 会按设计**响亮抛错**
     * （发布构建的端点来自 `scripts/build-app.mjs` / `.env.production.local` 的绝对注入）。
     * 本组还原真实 App 构建形态：给绝对地址；用例里的 URL 断言一律 `includes` ⇒ 不受影响。
     */
    originalApiBase = clientConfig.apiBase;
    clientConfig.apiBase = 'https://api.example.com/api';
  });
  afterEach(() => {
    clientConfig.apiBase = originalApiBase;
    installUniStub(); // 恢复默认 `web`（H5 的真实取值），不泄漏给后续用例
  });

  /** App 平台挂载（门控需要平台 = App；App 的 REST 走 uni.request —— 见 `mountLobbyRoutes` 注）。 */
  const mountApp = (routes: Parameters<typeof mountLobbyRoutes>[0] = {}) =>
    mountLobbyRoutes(routes, 'app');

  it('点亮条件：reliefAvailable ∧ App 平台 ∧ adpid 非空（边界两半 + 各未知态各自熄灭）', async () => {
    // 149 < 150 ⇒ 点亮
    const low = mountApp({ balance: { code: 0, data: { balance: 149 } } });
    await flushPromises();
    expect(low.wrapper.find('.lobby__relief').exists()).toBe(true);
    low.wrapper.unmount();

    // 150 = 门槛 ⇒ 不点亮（服务端判据是 `<`）
    const at = mountApp({ balance: { code: 0, data: { balance: 150 } } });
    await flushPromises();
    expect(at.wrapper.find('.lobby__relief').exists()).toBe(false);
    at.wrapper.unmount();

    // 开关关 ⇒ 不点亮
    const off = mountApp({
      config: goldConfig({ reliefEnabled: false }),
      balance: { code: 0, data: { balance: 0 } },
    });
    await flushPromises();
    expect(off.wrapper.find('.lobby__relief').exists()).toBe(false);
    off.wrapper.unmount();

    // 余额未知 ⇒ 不点亮（fail-safe：未知不放行）
    const unknown = mountApp({ balance: { code: 10007, message: 'x', data: null } });
    await flushPromises();
    expect(unknown.wrapper.find('.lobby__relief').exists()).toBe(false);
    unknown.wrapper.unmount();

    // adpid = 空串（暗上线种子态：服务端没配广告位）⇒ 不点亮
    const noAdpid = mountApp({
      config: goldConfig({ reliefAdpid: '' }),
      balance: { code: 0, data: { balance: 149 } },
    });
    await flushPromises();
    expect(
      noAdpid.wrapper.find('.lobby__relief').exists(),
      '空串 = 未配置 ⇒ 入口不渲染（规格冻结条 K）',
    ).toBe(false);
    noAdpid.wrapper.unmount();

    // adpid 缺键（旧版服务端）⇒ 归一回空串 ⇒ 不点亮（缺键语义）
    const legacy = mountApp({
      config: goldConfig({ reliefAdpid: undefined }),
      balance: { code: 0, data: { balance: 149 } },
    });
    await flushPromises();
    expect(legacy.wrapper.find('.lobby__relief').exists(), '缺键 ⇒ 空串 ⇒ 不点亮').toBe(false);
  });

  /**
   * 2026-10-21：救助门槛 = 服务端档位表**最低档** × entryMultiplier（无代码常量）。
   * 🔴 判别力：表首项是 80、最低档是 5 ⇒ 门槛 50。若实现用首项（800）或常量 15（150），
   * 「50 熄灭」这一格会红（50 < 150 / 50 < 800 都会误点亮）。
   */
  it('🔴 门槛取档位表最低档：[80,5] ⇒ 49 点亮、50 熄灭；空表 ⇒ 熄灭', async () => {
    const levels = [
      { name: '大场', baseScore: 80 },
      { name: '小场', baseScore: 5 },
    ];

    const low = mountApp({
      config: goldConfig({ baseScoreLevels: levels }),
      balance: { code: 0, data: { balance: 49 } },
    });
    await flushPromises();
    expect(low.wrapper.find('.lobby__relief').exists(), '49 < 5×10 = 50 ⇒ 点亮').toBe(true);
    low.wrapper.unmount();

    const at = mountApp({
      config: goldConfig({ baseScoreLevels: levels }),
      balance: { code: 0, data: { balance: 50 } },
    });
    await flushPromises();
    expect(at.wrapper.find('.lobby__relief').exists(), '50 = 门槛 ⇒ 熄灭').toBe(false);
    at.wrapper.unmount();

    const empty = mountApp({
      config: goldConfig({ baseScoreLevels: [] }),
      balance: { code: 0, data: { balance: 0 } },
    });
    await flushPromises();
    expect(empty.wrapper.find('.lobby__relief').exists(), '空表 = 门槛未知 ⇒ 熄灭').toBe(false);
    empty.wrapper.unmount();
  });

  it('非 App 平台（H5 真实取值 `web`）⇒ 入口不渲染（平台否；其余条件全满足）', async () => {
    installUniStub({ platform: 'web' });
    const { wrapper } = mountLobbyRoutes({ balance: { code: 0, data: { balance: 149 } } });
    await flushPromises();
    expect(
      wrapper.find('.lobby__relief').exists(),
      'H5 隐藏（K4）：平台否 + 服务端不下发 adpid 的双保险之一必须成立',
    ).toBe(false);
  });

  it('点击 ⇒ 预检 GET 可领 ⇒ 弹层（正片文案、不再写「占位」）；开层不发第二个请求；取消关层', async () => {
    clientConfig.token = 'a1';
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const { wrapper, calls } = mountApp({
      balance: { code: 0, data: { balance: 90 } },
      relief: {
        code: 0,
        data: { eligible: true, grantedToday: false, amount: 200, balance: 90, claim: 'c1' },
      },
    });
    await flushPromises();

    await wrapper.find('.lobby__relief').trigger('click');
    await flushPromises();

    const relief = calls.filter((c) => c.url.includes('/wallet/relief'));
    expect(relief, '点击 ⇒ 一发**无 claim** 的预检 GET（签发/复用走服务端裁决路径）').toHaveLength(1);
    expect(relief[0]!.init?.method ?? 'GET', '只读 GET（旧 POST 面已退役）').toBe('GET');
    expect(relief[0]!.url).toMatch(/\/wallet\/relief$/);
    expect(relief[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });

    const panel = wrapper.find('.lobby__relief-panel');
    expect(panel.exists(), '可领 ⇒ 弹层').toBe(true);
    expect(flat(panel.text()), '弹层说明「先看激励视频」').toContain('激励视频');
    expect(flat(panel.text()), '「占位」字样不得残留（正片已上线）').not.toContain('占位');
    expect(
      calls.filter((c) => c.url.includes('/wallet/relief')),
      '弹层打开本身不发第二个请求',
    ).toHaveLength(1);

    // 取消 ⇒ 关层（不产生请求）
    await panel.findAll('button').find((b) => flat(b.text()) === '取消')!.trigger('click');
    expect(wrapper.find('.lobby__relief-panel').exists(), '取消 ⇒ 关层').toBe(false);
    expect(calls.filter((c) => c.url.includes('/wallet/relief'))).toHaveLength(1);
  });

  it('点击时不可领 ⇒ 服务端 reason 落提示行、**不开层**', async () => {
    const { wrapper, calls } = mountApp({
      balance: { code: 0, data: { balance: 90 } },
      relief: {
        code: 0,
        data: { eligible: false, grantedToday: true, amount: 200, balance: 90, reason: '今天已经领过了' },
      },
    });
    await flushPromises();

    await wrapper.find('.lobby__relief').trigger('click');
    await flushPromises();

    expect(wrapper.find('.lobby__relief-dialog').exists(), '不可领 ⇒ 不开层').toBe(false);
    expect(flat(wrapper.get('[data-notice-id="relief"] .notice__text').text())).toBe('今天已经领过了');
    expect(calls.filter((c) => c.url.includes('/wallet/relief'))).toHaveLength(1);
  });

  it('点击时失败（非 0 / 传输拒绝）⇒「网络异常，请重试」、不开层（客户端本地文案）', async () => {
    const { wrapper } = mountApp({
      balance: { code: 0, data: { balance: 90 } },
      relief: { code: 10007, message: '下游不可用', data: null },
    });
    await flushPromises();

    await wrapper.find('.lobby__relief').trigger('click');
    await flushPromises();

    expect(wrapper.find('.lobby__relief-dialog').exists()).toBe(false);
    expect(flat(wrapper.get('[data-notice-id="relief"] .notice__text').text())).toBe('网络异常，请重试');
  });
});

describe('② 源码闸：旧 POST 面已退役（客户端不得再出现）', () => {
  /**
   * 广告片 T19：发放的唯一入口 = 服务端广告回调链 —— 客户端对救助端点的旧写面
   * （`POST /api/wallet/relief` 与 `rest.claimRelief`）整体退役（规格 §2.9 源码闸逐字）。
   *
   * 判据形态照既有源码闸（`source-boundary` / `lobby-modes`）：`collectSourceFiles()` +
   * **剥注释视图**（`stripComments`——登记退役的文档注释不算违规；记法同 R572）。
   */
  const OLD_POST = /(?:['"]POST[^'\n]*\/api\/wallet\/relief|'POST'\s*,\s*['"][^'"]*\/wallet\/relief)/;
  const OLD_FN = /\bclaimRelief\b/;

  it('src/**（剥注释）零命中：`POST /api/wallet/relief` / `claimRelief`', () => {
    const code = collectSourceFiles().map((f) => ({ path: f.path, content: stripComments(f.content) }));
    expect(code.find((f) => f.path === 'src/pages/lobby/lobby.vue'), '扫描面自证：lobby.vue 在集合里').toBeDefined();
    expect(code.find((f) => f.path === 'src/net/rest.ts'), '扫描面自证：rest.ts 在集合里').toBeDefined();

    const offenders: string[] = [];
    for (const file of code) {
      if (OLD_POST.test(file.content)) offenders.push(`${file.path}: POST /api/wallet/relief`);
      if (OLD_FN.test(file.content)) offenders.push(`${file.path}: claimRelief`);
    }
    expect(
      offenders,
      `旧写面残留（发放的唯一入口 = 服务端回调链）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('判别力自证：旧形态两式都命中；新形态放行', () => {
    // 旧写法两式：单串形（注释/文档里出现过）+ `authedRequest('POST', …)` 实参形
    expect(OLD_POST.test("authedRequest<ReliefData>('POST', '/wallet/relief', {})")).toBe(true);
    expect(OLD_POST.test("const p = 'POST /api/wallet/relief';")).toBe(true);
    expect(OLD_FN.test('const res = await rest.claimRelief();')).toBe(true);
    expect(OLD_FN.test('export function claimRelief(): Promise<RestResponse<ReliefData>> {')).toBe(true);
    // 新形态必须放行（T19 落地后的实际写法）
    expect(OLD_POST.test("authedRequest<ReliefQueryData>('GET', '/wallet/relief')")).toBe(false);
    expect(OLD_FN.test('const res = await rest.getRelief(claim);')).toBe(false);
  });
});

describe('② rest.fetchWalletBalance / rest.getRelief（REST 接线，与 createRoom 同族）', () => {
  it('GET /api/wallet/balance：带鉴权 + 统一信封解析', async () => {
    clientConfig.token = 'a1';
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const { calls } = stubFetch(() => ({ code: 0, data: { balance: 3418 } }));

    const res = await rest.fetchWalletBalance();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/wallet/balance');
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET');
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });
    expect(res.code).toBe(0);
    expect(res.data?.balance).toBe(3418);
  });

  it('GET /api/wallet/relief：GET + 带鉴权；data 六字段**原样**交回（哑终端）', async () => {
    clientConfig.token = 'a1';
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const payload = { eligible: true, grantedToday: false, amount: 200, balance: 90, claim: 'claim_x1' };
    const { calls } = stubFetch(() => ({ code: 0, data: payload }));

    const res = await rest.getRelief();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url, '无 claim 入参 ⇒ 不带 query（裁决 + 签发/复用路径）').toMatch(/\/wallet\/relief$/);
    expect(calls[0]!.init?.method ?? 'GET', '只读 GET（发放唯一入口 = 广告回调链，客户端永不 POST 发放）').toBe(
      'GET',
    );
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer a1' });
    expect(res.data).toEqual(payload);
  });

  it('携 claim ⇒ encodeURIComponent 进 query（保留字符不得越出查询串）', async () => {
    const { calls } = stubFetch(() => ({
      code: 0,
      data: { eligible: true, grantedToday: false, amount: 200, balance: 90 },
    }));

    await rest.getRelief('a b+c/d');

    expect(calls[0]!.url).toContain(`/wallet/relief?claim=${encodeURIComponent('a b+c/d')}`);
  });

  it('非 0 的信封原样交回（10007 不得伪造成成功）', async () => {
    stubFetch(() => ({ code: 10007, message: '下游不可用', data: null }));

    const res = await rest.getRelief('c1');

    expect(res.code).toBe(10007);
    expect(res.message).toBe('下游不可用');
    expect(res.data).toBeNull();
  });
});


/**
 * 档位卡行：窄画布（最小设计宽 1334）下四张卡必须**全部完整显示**（2026-10-13 真机走查）。
 *
 * 根因（算术级）：`.lobby__level` 的 `min-width: 240` × 4 + 3×`gap 8` = **984**，
 * 而画布恰为最小设计宽 1334 时 `.lobby__levels` 面板内的列表可用宽 ≈ **824**
 * ⇒ 单行必然溢出 116（实测：豪侠场卡被面板右缘切掉一半 —— 用户原话「底分外面的框显示不全」）。
 * 1334 是**最小设计宽**：真机 16:9 或更窄的横屏都会落到它 ⇒ 该缺陷在窄机上必现。
 *
 * 修复 = 卡行允许**换行**（`flex-wrap: wrap`；面板纵向空间充裕，折行后四张卡完整、
 * 宽画布仍单行），不再以横向滚动兜底（滚动 = 的「框被切」观感本身就是缺陷本身）。
 * ⚠️ 观感（折行后的排布）由模拟器截图复核；本用例钉的是**形态**（jsdom 无布局）。
 */
describe('档位卡行的窄画布形态（最小设计宽 1334 算账）', () => {
  it('源码级：.lobby__level-list 必须 flex-wrap: wrap、且不再有 overflow-x: auto', () => {
    const src = collectSourceFiles().find((f) => f.path === 'src/pages/lobby/lobby.vue');
    expect(src, 'lobby.vue 必须在源码扫描集合里').toBeDefined();
    const m = /\.lobby__level-list\s*\{([^}]*)\}/.exec(stripComments(src!.content));
    expect(m, '.lobby__level-list 规则必须存在（否则本断言空转）').not.toBeNull();
    const body = m![1]!;
    expect(body, '单行溢出 ⇒ 必须允许换行').toContain('flex-wrap: wrap');
    expect(body, '换行后不再需要横向滚动兜底').not.toContain('overflow-x: auto');

    // 判别力自证：旧形态样本（单行 + 横向滚动）过同一组检查必须红。
    const oldSample = '.lobby__level-list { display: flex; overflow-x: auto; }';
    expect(oldSample).toContain('overflow-x: auto');
    expect(oldSample.includes('flex-wrap: wrap')).toBe(false);
  });
});

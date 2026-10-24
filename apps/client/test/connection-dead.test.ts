/**
 * 死态 fail-fast + 非牌桌页恢复入口（用户裁决：**「断线重连以超过 30 秒仍自动回为准」**）。
 *
 * 背景：自动重连窗口从 8 次 / 封顶 10s（≈45–60s）扩到 22 次 / 封顶 20s（≈5.9–6.4 分钟，
 * 推导见 `connection-overlay.test.ts` 的 A2 组）。窗口一大，**死态下请求不得悬挂**就变成
 * 硬要求：give-up 后 socket.io 缓冲永远不会被冲刷（重连链已停），旧行为会把请求挂在
 * `pending` 里把串行队列永久占死。
 *
 * 三层判据：
 *  A. GameClient：give-up/dead 且链路未连通 ⇒ `send()` fail-fast（`blocked` +
 *     `ConnectionDeadError`，**不入** socket.io 缓冲）；give-up 转换点释放悬挂 pending；
 *     `sendQueued` 在 5 次配额内收敛；快照类重试循环（`reconnect()`）有限步返回
 *     `unavailable`（对一条真实的「无限微任务自旋」回归设闸）。
 *  B. 非牌桌页死态入口：lobby / game 两页挂载后，dead ⇒ 可见；「重新连接」按钮直达
 *     `client.retryConnect()`；11003 ⇒ 无按钮（文案 = K1 全串）；connected ⇒ 不可见。
 *     ⚠️ Task 8/9 起两页的呈现都由 `NoticeStack` 内置 `connection-dead` 项承担
 *     （文案/动作同源于 `connection-copy.ts`），旧 `ConnectionDeadBar` 横条退役。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import LobbyPage from '../src/pages/lobby/lobby.vue';
import GamePage from '../src/pages/game/game.vue';
import { createGameSession, type GameSession } from '../src/net/session';
import { ConnectionDeadError, type RequestOutcome } from '../src/net/socket';
import { RECONNECT_GIVE_UP_ATTEMPTS } from '../src/net/transport';
import type { SocketFactory } from '../src/net/transport';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import { useAuthStore } from '../src/stores/auth';
import { useGameStore } from '../src/stores/game';
import { FakeSocket, serverMessage } from './helpers/fake-socket';

const blockedReason = (outcome: RequestOutcome): unknown => {
  expect(outcome.status).toBe('blocked');
  return (outcome as Extract<RequestOutcome, { status: 'blocked' }>).reason;
};

// ---------------------------------------------------------------- A. GameClient

let socket: FakeSocket;
let session: GameSession;

function bootClient(): void {
  socket = new FakeSocket();
  session = createGameSession({
    socketFactory: () => socket,
    currentVersion: () => 0,
    applySnapshot: () => {},
    applyEvent: () => {},
    onRoomMatched: () => {},
    onRoomState: () => {},
    onRefreshSnapshot: () => {},
    onReconnect: () => {},
    onNotice: () => {},
  });
}

/** 断线 + 把 Manager 的 reconnect_attempt 打到 give-up（与 A2 组同一驱动方式）。 */
function driveToGiveUp(): void {
  socket.emitConnect();
  socket.emitDisconnect('transport close');
  for (let i = 1; i <= RECONNECT_GIVE_UP_ATTEMPTS; i += 1) {
    socket.io.emit('reconnect_attempt', i);
  }
}

describe('A. give-up / dead 的 send() fail-fast', () => {
  beforeEach(() => bootClient());
  afterEach(() => session.disconnect());

  it('死态 send()：立即 blocked + ConnectionDeadError，不入缓冲、串行队列不占位', async () => {
    driveToGiveUp();
    expect(session.client.connectionState.phase).toBe('dead');

    const emittedBefore = socket.emitted.length;
    const outcome = await session.client.send('room.match', { mode: 'random', baseScore: 15 });

    expect(blockedReason(outcome)).toBeInstanceOf(ConnectionDeadError);
    expect(socket.emitted.length, '死态请求**不得**交给 socket.io 缓冲').toBe(emittedBefore);
    expect(session.client.busy, 'fail-fast 不占串行队列').toBe(false);
  });

  it('服务端踢线（dead / server_rejected）同样 fail-fast', async () => {
    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 11003, message: '用户已被封禁' }, 0));
    socket.emitDisconnect('io server disconnect');

    const outcome = await session.client.send('room.unmatch', {});
    expect(blockedReason(outcome)).toBeInstanceOf(ConnectionDeadError);
    expect(socket.emittedOf('room.unmatch')).toHaveLength(0);
  });

  it('重连进行中（未判死）不受影响：请求照旧进缓冲（既有语义）——正对照', async () => {
    socket.emitConnect();
    socket.emitDisconnect('transport close');
    socket.io.emit('reconnect_attempt', 1);

    const hanging = session.client.send('room.match', { mode: 'random' });
    expect(socket.emittedOf('room.match'), 'reconnecting 相位仍走 socket.io 缓冲').toHaveLength(1);

    // 收口（避免悬挂 promise 泄漏进下一条用例）：give-up 转换点必须释放它
    for (let i = 2; i <= RECONNECT_GIVE_UP_ATTEMPTS; i += 1) socket.io.emit('reconnect_attempt', i);
    await expect(hanging).resolves.toMatchObject({ status: 'sent', code: -1 });
  });

  it('give-up 转换点释放悬挂 pending 并唤醒 whenIdle 等待者（不永久 loading / 不无限空转）', async () => {
    socket.emitConnect();
    socket.emitDisconnect('transport close');
    // 断线期发出的请求（无安全计时器；只在 ack/断线/give-up 时结算）
    const hanging = session.client.send('room.match', { mode: 'random' });
    expect(session.client.busy).toBe(true);

    for (let i = 1; i <= RECONNECT_GIVE_UP_ATTEMPTS; i += 1) socket.io.emit('reconnect_attempt', i);

    await expect(hanging).resolves.toMatchObject({ status: 'sent', code: -1 });
    expect(session.client.busy).toBe(false);
  });

  it('死态 sendQueued：5 次配额内收敛（≤5 次 send），返回 ConnectionDeadError', async () => {
    driveToGiveUp();
    const emittedBefore = socket.emitted.length;
    const sendSpy = vi.spyOn(session.client, 'send');

    const outcome = await session.client.sendQueued('room.unmatch', {}, 5);

    expect(blockedReason(outcome)).toBeInstanceOf(ConnectionDeadError);
    expect(sendSpy.mock.calls.length, '尝试次数受 maxAttempts 界住').toBeLessThanOrEqual(5);
    expect(socket.emitted.length).toBe(emittedBefore);
    sendSpy.mockRestore();
  });

  it('死态下的快照重试循环有限步收口：reconnect() ⇒ unavailable（曾会无限微任务自旋）', async () => {
    driveToGiveUp();
    const result = await session.client.reconnect(0);
    expect(result.status).toBe('unavailable');
  });

  it('retryConnect 后 fail-fast 解除：resync 请求重新可以发出', async () => {
    driveToGiveUp();
    session.client.retryConnect(); // 相位回 reconnecting、giveUpRequested 复位
    socket.emitConnect(); // 手动重连成功（socket 层随之自动发出一条 game.reconnect）

    // 先把自动恢复的 game.reconnect 结算掉（它同步占着串行队列；其恢复语义不在本条判据内）
    expect(socket.emittedOf('game.reconnect')).toHaveLength(1);
    socket.lastRequest()!.ack(null, { code: 0 });

    const p = session.client.send('room.match', { mode: 'random' });
    expect(socket.emittedOf('room.match')).toHaveLength(1);
    socket.lastRequest()!.ack(null, { code: 0 });
    await expect(p).resolves.toMatchObject({ status: 'sent', code: 0 });
  });

  it('踢线时刻正有 whenIdle 等待者：唤醒的重试不进死缓冲（释放点必须在判死之后）', async () => {
    socket.emitConnect();
    // ① 在途请求占住串行队列（不 ack）
    const inflight = session.client.send('room.match', { mode: 'random' });
    expect(session.client.busy).toBe(true);
    // ② 第二个请求被串行队列拦下 ⇒ 注册 whenIdle 等待者（踢线到来前就挂着）
    const queued = session.client.sendQueued('room.leave', {});
    await flushPromises();
    expect(socket.emittedOf('room.leave'), '前提：等待者尚未抢到槽位').toHaveLength(0);

    /**
     * ③ 服务端踢线（11003）。`whenIdle` 的等待者是**同步回调** ⇒ 若释放点在判死
     *    之前，被唤醒的 `send()` 会把 room.leave emit 进永远不会被冲刷的缓冲
     *    （修复前行为：room.leave 进缓冲、`pending` 永久占死、`queued` 悬挂）。
     */
    socket.push(serverMessage('system.error', { code: 11003, message: '用户已被封禁' }, 0));
    socket.emitDisconnect('io server disconnect');

    const raced = await queued;
    expect(blockedReason(raced)).toBeInstanceOf(ConnectionDeadError);
    expect(socket.emittedOf('room.leave'), '唤醒的重试**不得**进死缓冲').toHaveLength(0);
    expect(session.client.busy, '没有僵尸 pending').toBe(false);
    await expect(inflight).resolves.toMatchObject({ status: 'sent', code: -1 });
  });
});

// ---------------------------------------------------------------- B. 页面挂载

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
  vi.restoreAllMocks();
});

/** 记录 `fetch` 的每一次调用（`rest.ts` 只用到 `status` 与 `text()`；照抄 lobby-modes 脚手架）。 */
function stubFetch(route: (call: { url: string; init?: RequestInit }) => unknown) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(route({ url, init })),
  }));
  vi.stubGlobal('fetch', mock);
  return { mock };
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

function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function mountLobbyWithSession() {
  const { factory, sockets } = capturingFactory();
  startGameSession(factory);
  stubFetch((call) => {
    if (call.url.includes('/config'))
      return { code: 0, data: { baseScoreLevels: [], friendRoomEnabled: false, freeRoomEnabled: true, goldRoomEnabled: false, reliefEnabled: false, entryMultiplier: 10, version: 3 } };
    if (call.url.includes('/wallet/balance')) return { code: 0, data: { balance: 0 } };
    return { code: 0, data: [] };
  });
  useAuthStore().navigate('lobby');
  const wrapper = mount(LobbyPage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket: sockets[0]! };
}

function mountGameWithSession() {
  const { factory, sockets } = capturingFactory();
  startGameSession(factory);
  stubFetch(() => ({ code: 0, data: [] }));
  const wrapper = mount(GamePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket: sockets[0]! };
}

describe('B1. 大厅页：dead ⇒ 出现死态项、按钮接通 retryConnect、11003 ⇒ 只文案（Task 8 迁入 NoticeStack）', () => {
  /**
   * 大厅的死态呈现（Task 8 起）：`ConnectionDeadBar` 退役，由 `NoticeStack` 内置的
   * `connection-dead` 项承担（同一份文案/动作策略 —— `connection-copy.ts` 单一真源）。
   * 动作按钮形状是 Stack 的 `.notice__action`；「重新连接」/「重新登录」用**标签**区分
   * （旧 `__retry` / `__relogin` 两个 class 不再存在）。
   */
  const deadItem = (wrapper: VueWrapper) => wrapper.find('[data-notice-id="connection-dead"]');
  const deadText = (wrapper: VueWrapper) => flat(deadItem(wrapper).find('.notice__text').text());
  const deadActions = (wrapper: VueWrapper) =>
    deadItem(wrapper)
      .findAll('.notice__action')
      .map((a) => flat(a.text()));

  it('connected ⇒ 死态项不在 DOM；give-up ⇒ 出现 + 点「重新连接」真正建链；恢复后消失', async () => {
    const { wrapper, socket } = mountLobbyWithSession();
    await flushPromises();
    socket.emitConnect();
    await wrapper.vm.$nextTick();
    expect(deadItem(wrapper).exists()).toBe(false);

    socket.emitDisconnect('transport close');
    for (let i = 1; i <= RECONNECT_GIVE_UP_ATTEMPTS; i += 1) socket.io.emit('reconnect_attempt', i);
    await wrapper.vm.$nextTick();
    expect(deadItem(wrapper).exists(), 'give-up ⇒ 大厅出现恢复项').toBe(true);
    expect(deadText(wrapper)).toContain('多次自动重连仍未成功');

    const callsBefore = socket.connectCalls;
    await deadItem(wrapper).find('.notice__action').trigger('click');
    expect(socket.connectCalls, '点按钮 = client.retryConnect()').toBe(callsBefore + 1);
    await wrapper.vm.$nextTick();
    expect(deadItem(wrapper).exists(), '重连进行中 ⇒ 恢复项撤下').toBe(false);

    socket.emitConnect();
    await wrapper.vm.$nextTick();
    expect(deadItem(wrapper).exists()).toBe(false);
  });

  it('11003 封禁踢线 ⇒ 死态项可见，文案 = 登录同源 K1 全串，给「重新登录」出口', async () => {
    const { wrapper, socket } = mountLobbyWithSession();
    await flushPromises();
    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 11003, message: '用户已被封禁' }, 0));
    socket.emitDisconnect('io server disconnect');
    await wrapper.vm.$nextTick();

    expect(deadItem(wrapper).exists()).toBe(true);
    /**
     * 旧组件 `ConnectionDeadBar.vue` 已随 Task 11 删除 —— 本文件不再引用旧横条类名；
     * 「旧锚点不得复现」由 `notice-presentation.test.ts` 的 `src/**` 剥注释扫描兜底
     *（那里是旧类名的唯一允许出现点）。
     */
    expect(deadActions(wrapper), '11003 不给重试，但给回登录页的出口').toEqual(['重新登录']);
    expect(deadText(wrapper)).toContain('如有异议请联系客服');
  });

  it('10006 并发上限踢线 ⇒ 给重试（与 ConnectionOverlay 的 canRetry 同一口径）', async () => {
    const { wrapper, socket } = mountLobbyWithSession();
    await flushPromises();
    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 10006, message: 'too many' }, 0));
    socket.emitDisconnect('io server disconnect');
    await wrapper.vm.$nextTick();

    expect(deadActions(wrapper)).toContain('重新连接');
    // Task 4：文案与 ConnectionOverlay / socket 踢线同源（connection-copy.ts，「同一网络」口径）。
    expect(deadText(wrapper)).toContain('同一网络的连接数已达上限');
  });

  it('无码的服务端踢线 ⇒ 给「重新连接」+「重新登录」（空闲踢线可恢复）', async () => {
    const { wrapper, socket } = mountLobbyWithSession();
    await flushPromises();
    socket.emitConnect();
    await wrapper.vm.$nextTick();
    // 无 system.error ⇒ lastServerErrorCode 为 null（无码踢线）
    socket.emitDisconnect('io server disconnect');
    await wrapper.vm.$nextTick();

    expect(deadItem(wrapper).exists()).toBe(true);
    const labels = deadActions(wrapper);
    expect(labels, '无码踢线给重试（空闲踢线可恢复）').toContain('重新连接');
    expect(labels, '再次被拒时可回登录页').toContain('重新登录');
    expect(deadText(wrapper)).toContain('服务端主动断开了连接');

    const callsBefore = socket.connectCalls;
    const retryBtn = deadItem(wrapper).findAll('.notice__action')[labels.indexOf('重新连接')]!;
    await retryBtn.trigger('click');
    expect(socket.connectCalls, '点「重新连接」= client.retryConnect()').toBe(callsBefore + 1);
  });

  it('换会话（重启）⇒ 旧会话的死态项与拒绝提示都不得残留（2026-10-13 App 首登实测缺陷回归）', async () => {
    const { wrapper, socket } = mountLobbyWithSession();
    await flushPromises();
    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 11003, message: '用户已被封禁' }, 0));
    socket.emitDisconnect('io server disconnect');
    await wrapper.vm.$nextTick();

    /**
     * 拒绝提示在 dead 相位由**死态项**承载（transport 提示被 Stack 抑制、不双显——
     * `NoticeStack` 的连接所有权矩阵）。「不残留」的两半：死态项不在 + 全页无旧拒绝文案。
     */
    const sessionItem = () => wrapper.find('[data-notice-id="session-notice"]');

    // 前提自证：旧会话死态 + 拒绝提示都在场（11003 的文案 = K1 全串）
    expect(deadItem(wrapper).exists(), '前提：旧会话死态项在场').toBe(true);
    expect(flat(wrapper.text()), '前提：旧会话的拒绝提示在场').toContain('该账号已被封禁');

    // 换会话 = 登录后 `restartGameSession()` 的同形（stop + start）
    stopGameSession();
    startGameSession(() => new FakeSocket());
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(
      deadItem(wrapper).exists(),
      '新会话下旧死态不得残留（死态项读 currentSession）',
    ).toBe(false);
    expect(
      sessionItem().exists(),
      '新会话没有 notice ⇒ 旧「服务端拒绝」提示不得残留（Stack 读 currentSession；旧实现钉在旧会话 ref 上永不重算）',
    ).toBe(false);
    expect(flat(wrapper.text()), '旧拒绝文案不得残留').not.toContain('该账号已被封禁');
  });

  it('session_expired ⇒ 死态项可见、文案含「登录已失效」、给「重新登录」按钮（无重试按钮）', async () => {
    const { wrapper, socket } = mountLobbyWithSession();
    await flushPromises();
    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 10004, message: 'expired' }, 0));
    socket.emitDisconnect('io server disconnect');
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(deadItem(wrapper).exists()).toBe(true);
    expect(deadText(wrapper)).toContain('登录状态已失效');
    const labels = deadActions(wrapper);
    expect(labels, 'session_expired 不给重试').not.toContain('重新连接');
    expect(labels, 'session_expired 给重新登录').toContain('重新登录');
  });
});

describe('B2. 开始游戏页：死态与大厅同源（NoticeStack connection-dead）', () => {
  /**
   * 玩法页死态呈现（Task 11 收敛）：ConnectionDeadBar 退役，和大厅一样走
   * NoticeStack 内置 connection-dead 项（surface="game" 已加入判定矩阵）。
   */
  const deadItem = (wrapper: VueWrapper) => wrapper.find('[data-notice-id="connection-dead"]');
  const deadText = (wrapper: VueWrapper) => flat(deadItem(wrapper).find('.notice__text').text());
  const deadActions = (wrapper: VueWrapper) =>
    deadItem(wrapper)
      .findAll('.notice__action')
      .map((a) => flat(a.text()));

  it('session_expired ⇒ 死态项可见、文案含「登录已失效」、给「重新登录」按钮（无重试按钮）', async () => {
    const { wrapper, socket } = mountGameWithSession();
    await flushPromises();
    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 10004, message: 'expired' }, 0));
    socket.emitDisconnect('io server disconnect');
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(deadItem(wrapper).exists(), 'session_expired ⇒ 玩法页 connection-dead 项出现').toBe(true);
    expect(deadText(wrapper)).toContain('登录状态已失效');
    const labels = deadActions(wrapper);
    expect(labels, 'session_expired 不给重试').not.toContain('重新连接');
    expect(labels, 'session_expired 给重新登录').toContain('重新登录');
  });

  it('give-up ⇒ 可见且点「重新连接」调 retryConnect；connected ⇒ 不可见', async () => {
    const { wrapper, socket } = mountGameWithSession();
    await flushPromises();
    socket.emitConnect();
    await wrapper.vm.$nextTick();
    expect(deadItem(wrapper).exists(), 'connected ⇒ 死态项不在 DOM').toBe(false);

    socket.emitDisconnect('transport close');
    for (let i = 1; i <= RECONNECT_GIVE_UP_ATTEMPTS; i += 1) socket.io.emit('reconnect_attempt', i);
    await wrapper.vm.$nextTick();
    expect(deadItem(wrapper).exists(), 'give-up ⇒ 玩法页 connection-dead 项出现').toBe(true);

    const callsBefore = socket.connectCalls;
    const retryBtn = deadItem(wrapper).find('.notice__action--primary');
    expect(retryBtn.exists(), 'give-up 给主色「重新连接」按钮').toBe(true);
    await retryBtn.trigger('click');
    expect(socket.connectCalls).toBe(callsBefore + 1);
  });

  it('I2：死态 ⇒ 等待卡片让位（connectionDead 从 currentSession 直接读）', async () => {
    const { wrapper, socket } = mountGameWithSession();
    await flushPromises();
    socket.emitConnect();

    const store = useGameStore();
    store.setMatching(true);
    store.showMatchWaitPrompt('正在为你安排牌桌，请稍等片刻。');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.game__waitprompt').exists(), '前提：卡片在场').toBe(true);

    socket.emitDisconnect('transport close');
    for (let i = 1; i <= RECONNECT_GIVE_UP_ATTEMPTS; i += 1) socket.io.emit('reconnect_attempt', i);
    await wrapper.vm.$nextTick();

    expect(deadItem(wrapper).exists(), 'give-up ⇒ connection-dead 项出现').toBe(true);
    expect(wrapper.find('.game__waitprompt').exists(), '死态 ⇒ 等待卡片让位').toBe(false);
    store.setMatching(false);
  });
});

describe('B2b. 开始游戏页：换会话后旧死态/旧提示不残留', () => {
  it('stop + start 后旧死态项与旧拒绝提示都消失', async () => {
    const { wrapper, socket } = mountGameWithSession();
    await flushPromises();
    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 11003, message: '用户已被封禁' }, 0));
    socket.emitDisconnect('io server disconnect');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-notice-id="connection-dead"]').exists(), '前提：旧会话死态项在场').toBe(true);
    expect(flat(wrapper.text()), '前提：旧会话的拒绝提示在场').toContain('该账号已被封禁');

    stopGameSession();
    startGameSession(() => new FakeSocket());
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-notice-id="connection-dead"]').exists(), '新会话下旧死态不得残留').toBe(false);
    expect(wrapper.find('[data-notice-id="session-notice"]').exists(), '旧拒绝提示不得残留').toBe(false);
    expect(flat(wrapper.text()), '旧拒绝文案不得残留').not.toContain('该账号已被封禁');
  });
});

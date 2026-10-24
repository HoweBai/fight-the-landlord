/**
 * 项 2：重连终态 UI。
 *
 * 三层判据：
 *  A. GameClient 状态机：首连 connected；attempt 计数；第 `RECONNECT_GIVE_UP_ATTEMPTS` 次
 *     （现 22，退避窗口 ≈ 5.9–6.4 分钟）give-up 判死并主动断链；
 *     服务端踢线（11003）判死；retryConnect 复位重连；
 *  A2. 退避窗口的**计算型**下界（用户裁决「断线重连以超过 30 秒仍自动回为准」的量化）；
 *  B. ConnectionOverlay 哑组件：reconnecting 显示提示条，dead 显示遮罩，
 *     11003 不给重试、give-up / 10006 给重试；
 *  C. 牌桌集成：浮层只在非 connected 进 DOM，按钮接通 retry / 返回大厅。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import TablePage from '../src/pages/table/table.vue';
import ConnectionOverlay from '../src/components/ConnectionOverlay.vue';
import { useGameStore } from '../src/stores/game';
import { useAuthStore } from '../src/stores/auth';
import { startGameSession, stopGameSession } from '../src/composables/useGameSession';
import {
  createGameSession,
  type GameSession,
} from '../src/net/session';
import {
  RECONNECT_DELAY_MAX_MS,
  RECONNECT_DELAY_MS,
  RECONNECT_GIVE_UP_ATTEMPTS,
  createSocketIoFactory,
} from '../src/net/transport';
import type { ConnectionState } from '../src/net/socket';
import { FakeSocket, serverMessage } from './helpers/fake-socket';

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

// ---------------------------------------------------------------- A. 状态机

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

/** 把 Manager 的 reconnect_attempt 从 1 打到 n。 */
function emitAttempts(n: number): void {
  for (let i = 1; i <= n; i += 1) socket.io.emit('reconnect_attempt', i);
}

describe('A. GameClient 连接状态机', () => {
  beforeEach(() => bootClient());
  afterEach(() => session.disconnect());

  it('初始 reconnecting；首次 connect 后 connected', () => {
    expect(socket.emitted.length >= 0).toBe(true);
    expect(session.client.connectionState).toMatchObject({ phase: 'reconnecting', attempt: 0 });
    socket.emitConnect();
    expect(session.client.connectionState.phase).toBe('connected');
  });

  it(`attempt 1..${RECONNECT_GIVE_UP_ATTEMPTS - 1} 保持 reconnecting 且计数递增；第 ${RECONNECT_GIVE_UP_ATTEMPTS} 次判死并主动断链`, () => {
    socket.emitConnect();
    socket.emitDisconnect('transport close');
    expect(session.client.connectionState.phase).toBe('reconnecting');

    emitAttempts(RECONNECT_GIVE_UP_ATTEMPTS - 1);
    const before = session.client.connectionState;
    expect(before.phase).toBe('reconnecting');
    expect(before.attempt).toBe(RECONNECT_GIVE_UP_ATTEMPTS - 1);

    // give-up 的动作 = 主动调一次 disconnect（前 7 次尝试期间一次都不该有）
    const disconnectsBefore = socket.disconnectCalls;
    socket.io.emit('reconnect_attempt', RECONNECT_GIVE_UP_ATTEMPTS);
    const dead = session.client.connectionState;
    expect(dead.phase).toBe('dead');
    expect(dead.deadReason).toBe('give_up');
    expect(socket.disconnectCalls).toBe(disconnectsBefore + 1);
  });

  it('give-up 后 retryConnect：复位相位并重新建链；connect 事件到达后回 connected', () => {
    socket.emitConnect();
    socket.emitDisconnect('transport close');
    emitAttempts(RECONNECT_GIVE_UP_ATTEMPTS);
    expect(session.client.connectionState.phase).toBe('dead');

    const connectCallsBefore = socket.connectCalls;
    session.client.retryConnect();
    expect(socket.connectCalls).toBe(connectCallsBefore + 1);
    expect(session.client.connectionState.phase).toBe('reconnecting');

    socket.emitConnect();
    const state = session.client.connectionState;
    expect(state.phase).toBe('connected');
    expect(state.attempt).toBe(0);
    expect(state.deadReason).toBeNull();
  });

  it('11003 服务端踢线：dead / server_rejected / deadCode=11003', () => {
    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 11003, message: '用户已被封禁' }, 0));
    socket.emitDisconnect('io server disconnect');

    const state = session.client.connectionState;
    expect(state.phase).toBe('dead');
    expect(state.deadReason).toBe('server_rejected');
    expect(state.deadCode).toBe(11003);
  });

  it('10006 并发上限踢线：同样判死，码为 10006（由 UI 决定给不给重试）', () => {
    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 10006, message: 'too many' }, 0));
    socket.emitDisconnect('io server disconnect');

    expect(session.client.connectionState).toMatchObject({
      phase: 'dead',
      deadReason: 'server_rejected',
      deadCode: 10006,
    });
  });

  it('订阅 API：状态变化推送，注销后不再收到', () => {
    const seen: ConnectionState[] = [];
    const off = session.client.onConnectionState((s) => seen.push(s));
    socket.emitConnect();
    expect(seen.at(-1)?.phase).toBe('connected');
    off();
    socket.emitDisconnect('transport close');
    expect(seen.some((s) => s.phase === 'reconnecting')).toBe(false);
  });
});

// ------------------------------------------------- A2. 退避窗口（计算型）

/**
 * 用户裁决（2026-10-13）：「断线重连以**超过 30 秒仍自动回**为准」；上片设计
 * （`docs/superpowers/specs/2026-10-12-reconnect-until-game-end-design.md` §1 / §7 判据 1）
 * 也要求「同页断网 > 30s 仍能自动恢复」。旧值 8 次尝试（退避 1s→10s 封顶）窗口实测
 * ≈ 45.5–60.5s（「约 1 分钟出头」）—— 只是勉强跨过 30s，本次扩到 **22 次 + 封顶 20s**。
 *
 * 窗口用**与 socket.io-client 4.8.4 相同的退避公式**推导
 *（`contrib/backo2.js#duration` + `manager.js`）：第 k 次 `reconnect_attempt` 前的等待
 * = `min(RECONNECT_DELAY_MS × 2^(k-1) × j, RECONNECT_DELAY_MAX_MS)`，jitter j ∈ [0.5, 1.5]
 *（`randomizationFactor` 缺省 0.5；**先乘 jitter、再封顶**——`Math.min(ms, max)` 在
 * 抖动之后执行）。仅计退避等待之和，不含每次尝试自身的建链耗时。
 */
describe('A2. 自动重连窗口（计算型：下界 ≥ 180s 是承诺的量化底线）', () => {
  /** 与 backo2 同一套公式的下/上界（jitter 取两端）。 */
  function windowBounds(): { lower: number; upper: number } {
    let lower = 0;
    let upper = 0;
    for (let k = 1; k <= RECONNECT_GIVE_UP_ATTEMPTS; k += 1) {
      const base = RECONNECT_DELAY_MS * 2 ** (k - 1);
      lower += Math.min(base * 0.5, RECONNECT_DELAY_MAX_MS);
      upper += Math.min(base * 1.5, RECONNECT_DELAY_MAX_MS);
    }
    return { lower, upper };
  }

  it('窗口下界 ≥ 180s（≥ 用户裁决 30s 的 6 倍；当前推导 = 351.5s ≈ 5 分 52 秒）', () => {
    expect(windowBounds().lower).toBeGreaterThanOrEqual(180_000);
  });

  it('上下界钉在推导值（351.5s / 382.5s ≈ 5 分 52 秒–6 分 23 秒），防单边改小而窗口静默缩水', () => {
    expect(windowBounds()).toEqual({ lower: 351_500, upper: 382_500 });
  });

  it('createSocketIoFactory 把退避参数真的装进 socket.io（1s 起、封顶 20s）', () => {
    const optsCalls: Record<string, unknown>[] = [];
    const factory = createSocketIoFactory((_url, opts) => {
      optsCalls.push(opts);
      return new FakeSocket();
    });
    factory('http://mock.test', { path: '/socket.io', auth: {}, transports: ['websocket'] });

    expect(optsCalls).toHaveLength(1);
    expect(optsCalls[0]).toMatchObject({
      reconnection: true,
      reconnectionDelay: RECONNECT_DELAY_MS,
      reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
    });
  });
});

// ---------------------------------------------------------------- B. 哑组件

function overlayState(over: Partial<ConnectionState> = {}): ConnectionState {
  return {
    phase: 'reconnecting',
    deadReason: null,
    deadCode: null,
    attempt: 0,
    ...over,
  };
}

describe('B. ConnectionOverlay 组件', () => {
  it('reconnecting：只有提示条，没有遮罩；attempt>0 时显示第几次', () => {
    const wrapper = mount(ConnectionOverlay, {
      props: { state: overlayState({ attempt: 3 }) },
    });
    expect(wrapper.find('.connection-overlay__toast').exists()).toBe(true);
    expect(wrapper.find('.connection-overlay__scrim').exists()).toBe(false);
    expect(wrapper.text()).toContain('第 3 次');
  });

  it('give-up：遮罩 + 重试 + 返回大厅，点按分别发事件', async () => {
    const wrapper = mount(ConnectionOverlay, {
      props: { state: overlayState({ phase: 'dead', deadReason: 'give_up' }) },
    });
    expect(wrapper.find('.connection-overlay__scrim').exists()).toBe(true);
    expect(wrapper.text()).toContain('连接已断开');
    const retry = wrapper.find('.connection-overlay__retry');
    const back = wrapper.find('.connection-overlay__back');
    expect(retry.exists()).toBe(true);
    expect(back.exists()).toBe(true);

    await retry.trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
    await back.trigger('click');
    expect(wrapper.emitted('back')).toHaveLength(1);
  });

  it('11003：遮罩里**没有重试**，文案是封禁 K1 全串，给「重新登录」+ 返回大厅', async () => {
    const wrapper = mount(ConnectionOverlay, {
      props: {
        state: overlayState({ phase: 'dead', deadReason: 'server_rejected', deadCode: 11003 }),
      },
    });
    expect(wrapper.find('.connection-overlay__retry').exists()).toBe(false);
    expect(wrapper.find('.connection-overlay__back').exists()).toBe(true);
    const relogin = wrapper.find('.connection-overlay__relogin');
    expect(relogin.exists(), '再次被拒时给回登录页的出口').toBe(true);
    await relogin.trigger('click');
    expect(wrapper.emitted('relogin')).toHaveLength(1);
    expect(wrapper.text()).toContain('封禁');
  });

  it('10006：给重试（用户可能已关掉其它窗口）；文案与死态横条/踢线同源（「同一网络」口径）', () => {
    const wrapper = mount(ConnectionOverlay, {
      props: {
        state: overlayState({ phase: 'dead', deadReason: 'server_rejected', deadCode: 10006 }),
      },
    });
    expect(wrapper.find('.connection-overlay__retry').exists()).toBe(true);
    // Task 4：文案来自 `connection-copy.ts` 单一真源（「同一网络…」完整话术，
    // 与 `connectionKickMessage` 逐字一致；旧的「同一账号…若你已在其它窗口…」口径已退役）。
    expect(wrapper.text()).toContain('同一网络的连接数已达上限');
  });

  it('无码服务端断开：给重试（空闲踢线可恢复）+ 重新登录', () => {
    const wrapper = mount(ConnectionOverlay, {
      props: { state: overlayState({ phase: 'dead', deadReason: 'server_rejected' }) },
    });
    expect(wrapper.find('.connection-overlay__retry').exists()).toBe(true);
    expect(wrapper.find('.connection-overlay__relogin').exists()).toBe(true);
  });

  it('session_expired：遮罩 + 「重新登录」按钮（无重试、无返回大厅），点按发 relogin 事件', async () => {
    const wrapper = mount(ConnectionOverlay, {
      props: { state: overlayState({ phase: 'dead', deadReason: 'session_expired' }) },
    });
    expect(wrapper.find('.connection-overlay__scrim').exists()).toBe(true);
    expect(wrapper.text()).toContain('登录已过期');
    expect(wrapper.find('.connection-overlay__retry').exists()).toBe(false);
    expect(wrapper.find('.connection-overlay__back').exists()).toBe(false);
    const relogin = wrapper.find('.connection-overlay__relogin');
    expect(relogin.exists()).toBe(true);
    await relogin.trigger('click');
    expect(wrapper.emitted('relogin')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- C. 牌桌集成

function mountTable() {
  const socket = new FakeSocket();
  startGameSession(() => socket);
  const store = useGameStore();
  store.setRoom('ROOM1', 0);
  const wrapper = mount(TablePage, { global: { plugins: [pinia] } });
  mounted.push(wrapper);
  return { wrapper, socket };
}

describe('C. 牌桌接线', () => {
  it('connected 时浮层不在 DOM；断线进重连提示条，attempt 随 Manager 推进', async () => {
    const { wrapper, socket } = mountTable();
    socket.emitConnect();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.connection-overlay').exists()).toBe(false);

    socket.emitDisconnect('transport close');
    socket.io.emit('reconnect_attempt', 1);
    socket.io.emit('reconnect_attempt', 2);
    socket.io.emit('reconnect_attempt', 3);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.connection-overlay__toast').exists()).toBe(true);
    expect(wrapper.find('.connection-overlay__scrim').exists()).toBe(false);
    expect(wrapper.text()).toContain('第 3 次');
  });

  it('give-up：遮罩出现；点「重新连接」回到重连态，建链成功后浮层消失', async () => {
    const { wrapper, socket } = mountTable();
    socket.emitConnect();
    socket.emitDisconnect('transport close');
    for (let i = 1; i <= RECONNECT_GIVE_UP_ATTEMPTS; i += 1) {
      socket.io.emit('reconnect_attempt', i);
    }
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.connection-overlay__scrim').exists()).toBe(true);

    const callsBefore = socket.connectCalls;
    await wrapper.find('.connection-overlay__retry').trigger('click');
    expect(socket.connectCalls).toBe(callsBefore + 1);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.connection-overlay__toast').exists()).toBe(true);

    socket.emitConnect();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.connection-overlay').exists()).toBe(false);
  });

  it('11003：无重试按钮；点「返回大厅」导航到 lobby', async () => {
    const { wrapper, socket } = mountTable();
    const auth = useAuthStore();
    const navigate = vi.fn();
    const original = auth.navigate.bind(auth);
    auth.navigate = navigate as typeof auth.navigate;

    socket.emitConnect();
    socket.push(serverMessage('system.error', { code: 11003, message: '封禁' }, 0));
    socket.emitDisconnect('io server disconnect');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.connection-overlay__retry').exists()).toBe(false);
    await wrapper.find('.connection-overlay__back').trigger('click');
    expect(navigate).toHaveBeenCalledWith('lobby');

    auth.navigate = original;
  });
});

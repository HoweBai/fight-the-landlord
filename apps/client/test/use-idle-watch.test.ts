/**
 * useIdleWatch：应用层空闲超时断连。
 *
 * 核心判据：
 *  A. 非对局态 + 25min 无应用帧 → GameClient.disconnect()
 *  B. 对局中（view !== null || roomCode !== null）→ 豁免
 *  C. 前后台切换 → 后台暂停、回前台立即检查
 *  D. 收发帧 → 重置 lastActivity
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { GameClient } from '../src/net/socket';
import { startIdleWatch, IDLE_TIMEOUT_MS } from '../src/composables/useIdleWatch';
import { connectionDeadCopy } from '../src/net/connection-copy';
import { FakeSocket, playerViewFixture, serverMessage } from './helpers/fake-socket';
import { triggerAppHide, triggerAppShow } from './helpers/uni-stub';

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // 清理 uni-stub 的残留状态（不影响其他测试文件的 beforeEach）
});

function makeClient(socket: FakeSocket, now?: () => number): GameClient {
  return new GameClient({
    socketFactory: () => socket,
    currentVersion: () => 0,
    auth: {},
    now,
  });
}

describe('useIdleWatch', () => {
  it('非对局态 + 25min 无应用帧 → disconnect', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    // 模拟一次 connect（touchActivity 置时间戳）
    socket.emitConnect();

    let view: unknown = null;
    const ctrl = startIdleWatch({
      client,
      isInGame: () => view !== null,
      now: () => Date.now(),
    });

    // 推进 25min 到点
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 1000);
    expect(socket.disconnectCalls).toBeGreaterThanOrEqual(1);

    ctrl.stop();
    client.destroy();
  });

  it('对局中（view !== null）→ 豁免，不踢', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    socket.emitConnect();

    let view = playerViewFixture({ state: 'playing', seat: 0 });
    const ctrl = startIdleWatch({
      client,
      isInGame: () => view !== null,
      now: () => Date.now(),
    });

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 10_000);
    expect(socket.disconnectCalls).toBe(0);

    ctrl.stop();
    client.destroy();
  });

  it('前后台切换 → 后台暂停计时，回前台立即检查', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    socket.emitConnect();

    const ctrl = startIdleWatch({
      client,
      isInGame: () => false,
      now: () => Date.now(),
    });

    // 切后台 → 暂停
    triggerAppHide();
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 10_000);
    // 后台期间计时器门住，不踢
    expect(socket.disconnectCalls).toBe(0);

    // 回前台 → 立即检查（前后台加起来已经超 25min）
    triggerAppShow();
    expect(socket.disconnectCalls).toBeGreaterThanOrEqual(1);

    ctrl.stop();
    client.destroy();
  });

  it('发送 C→S 请求 → 重置计时，25min 不踢', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    socket.emitConnect();

    const ctrl = startIdleWatch({
      client,
      isInGame: () => false,
      now: () => Date.now(),
    });

    // 10min 后发一个请求 → 重置
    vi.advanceTimersByTime(10 * 60 * 1000);
    void client.send('room.match');
    // 再等 16min → 总共 26min，但重置后只过了 16min，不踢
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(socket.disconnectCalls).toBe(0);

    // 再等 10min → 累计 26min（从重置起算）→ 踢
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(socket.disconnectCalls).toBeGreaterThanOrEqual(1);

    ctrl.stop();
    client.destroy();
  });

  it('接收 S→C 消息 → 重置计时', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    socket.emitConnect();

    const ctrl = startIdleWatch({
      client,
      isInGame: () => false,
      now: () => Date.now(),
    });

    // 10min 后收一条消息
    vi.advanceTimersByTime(10 * 60 * 1000);
    socket.push(serverMessage('game.state_update', playerViewFixture({ state: 'playing', seat: 0, version: 2 }), 2));
    // 再等 20min → 总共 30min，但重置后只过了 20min，不踢
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(socket.disconnectCalls).toBe(0);

    ctrl.stop();
    client.destroy();
  });

  it('会话刚创建（lastActivity=0）→ 跳过', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    // 不调 simulateConnect → lastActivity 保持 0

    const ctrl = startIdleWatch({
      client,
      isInGame: () => false,
      now: () => Date.now(),
    });

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(socket.disconnectCalls).toBe(0);

    ctrl.stop();
    client.destroy();
  });

  it('底层未连接 → 跳过空闲判定', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    socket.emitConnect();
    socket.disconnect(); // 底层断

    const ctrl = startIdleWatch({
      client,
      isInGame: () => false,
      now: () => Date.now(),
    });

    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 10_000);
    // 已断开的不再触发 disconnect（否则会多算 disconnectCalls）
    // 关键断言：没有因为空闲判定又多调一次 disconnect
    expect(socket.disconnectCalls).toBe(1); // 只有我们手动调的那一次

    ctrl.stop();
    client.destroy();
  });

  it('stop 后不再触发 disconnect', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    socket.emitConnect();

    const ctrl = startIdleWatch({
      client,
      isInGame: () => false,
      now: () => Date.now(),
    });
    ctrl.stop();

    vi.advanceTimersByTime(60 * 60 * 1000); // 1h
    expect(socket.disconnectCalls).toBe(0);

    client.destroy();
  });
});

/**
 * P0-4：空闲断连**不得**把客户端卡进「永不重连」。
 *
 * 机制：`socket.disconnect()`（socket.io）会置 `skipReconnect = true` —— 自动重连就此
 * 停摆，而旧的 `GameClient.disconnect()` 只留相位 `reconnecting`：NoticeStack 的内置
 * 重连入口只在 `dead` 出现 ⇒ 大厅用户看到「重连中」却永远不会重连，`room.match` 等
 * 请求一直缓冲。
 *
 * 判据：空闲挂起后相位 = `dead` + 死因 `idle`（可重试），用户点「重新连接」直达
 * `client.retryConnect()` → `socket.connect()`；对局中（大厅 vs 牌桌两种页面状态）豁免。
 */
describe('P0-4：空闲挂起后的重连出口', () => {
  it('大厅空闲超时 ⇒ dead/idle（可重试），不是停在 reconnecting', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    socket.emitConnect();

    const phases: string[] = [];
    client.onConnectionState((s) => phases.push(`${s.phase}:${s.deadReason ?? '-'}`));

    const ctrl = startIdleWatch({ client, isInGame: () => false, now: () => Date.now() });
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 1000);

    const state = client.connectionState;
    expect(state.phase).toBe('dead');
    expect(state.deadReason).toBe('idle');
    // 重连入口（NoticeStack / ConnectionOverlay 共用 connectionDeadCopy）必须可用。
    expect(connectionDeadCopy(state).canRetry).toBe(true);
    // 中间不得闪一下 reconnecting：它会让 UI 显示「重连中」，而自动重连已被禁用。
    expect(phases).toEqual(['dead:idle']);

    client.retryConnect();
    expect(socket.connectCalls).toBeGreaterThanOrEqual(1);
    expect(client.connectionState.phase).toBe('reconnecting');
    expect(client.connectionState.deadReason).toBeNull();

    ctrl.stop();
    client.destroy();
  });

  it('对局中（view/roomCode 非空）⇒ 空闲不断连，相位保持 connected', () => {
    const socket = new FakeSocket();
    const client = makeClient(socket);
    socket.emitConnect();

    const view = playerViewFixture({ state: 'playing', seat: 0 });
    const ctrl = startIdleWatch({ client, isInGame: () => view !== null, now: () => Date.now() });
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 10_000);

    expect(socket.disconnectCalls).toBe(0);
    expect(client.connectionState.phase).toBe('connected');

    ctrl.stop();
    client.destroy();
  });
});

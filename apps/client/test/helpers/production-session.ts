/**
 * 用**生产装配**（`startGameSession` / `createSessionOptions`）建立会话的测试助手。
 *
 * ⚠️ 存在的理由：`reconnect-flow.test.ts` 与 `session-notice-lifecycle.test.ts` 都要
 * 「真实接线 + 假 socket」，各抄一份选项对象会让生产接线失去覆盖（见既有注释）。
 */
import { createPinia, setActivePinia } from 'pinia';
import type { ReconnectReason } from '../../src/net/socket';
import { startGameSession } from '../../src/composables/useGameSession';
import { useAuthStore } from '../../src/stores/auth';
import { useGameStore } from '../../src/stores/game';
import { FakeSocket } from './fake-socket';

/** 记录每次 `auth.navigate` 的目标，用来断言「用户被切到哪一页」。 */
function trackNavigation() {
  const auth = useAuthStore();
  const visited: string[] = [];
  const original = auth.navigate.bind(auth);
  auth.navigate = (page) => {
    visited.push(page);
    original(page);
  };
  return visited;
}

/**
 * 用**生产装配**（`startGameSession`）建立一个会话，socketFactory 注入假 socket。
 *
 * ⚠️ 工厂必须**每次调用都返回新的假 socket**：真实 socket.io 在旧连接被替换时
 * 会重建连接，若工厂返回同一个实例，重连相关的断言就会作用在一个「已死」的 socket 上。
 * 这里返回首次创建的那个（也就是当前在用的）。
 */
export function fresh() {
  setActivePinia(createPinia());
  const socket = new FakeSocket();
  const visited = trackNavigation();
  const session = startGameSession(() => socket);
  const store = useGameStore();
  return { socket, store, session, auth: useAuthStore(), visited };
}

/**
 * 建一个**完整生产装配**的会话：走 `startGameSession`（含 `store.bindRuntime`），
 * 只把 socketFactory 换成假 socket。这样 M08 的「回退 → 主动重连」链路也是真的。
 */
export function productionSession() {
  const { socket, store, session, visited } = fresh();
  const signals: ReconnectReason[] = [];
  session.client.onReconnect((r) => signals.push(r));
  // 导航类处置走单独通道（不进去抖窗口），必须一起观察
  session.onDisposition((r) => signals.push(r));
  return { socket, store, session, auth: useAuthStore(), notice: session.notice, visited, signals };
}

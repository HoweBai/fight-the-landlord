/**
 * `useGameSession.restartGameSession()`（登录/登出后重建 WS 会话）。
 *
 * 依据：§5.1 令牌在**握手**时校验，而握手只在建连时读一次 `clientConfig.token`
 * （`createGameSession` 里 `auth: buildSocketAuth()`）。因此：
 *  - 入口必须**先** `auth.hydrate()` **再** `startGameSession()`；
 *  - 登录成功后必须**重建**连接，否则新令牌永远用不上。
 *
 * `restartGameSession()` 的工厂由 `startGameSession()` 记住，**不从 `main.ts` 导出**
 * （否则 `main.ts → App.vue → login.vue → main.ts` 构成入口模块循环依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketAuth, SocketFactory } from '../src/net/transport';
import { FakeSocket, resolveHandshakeAuth, flushHandshakes } from './helpers/fake-socket';

/**
 * 测试替身：一个能观察每次建连握手 `auth` 的假工厂（每次调用返回新 socket）。
 *
 * `auth` 可能是函数形（`SocketAuthProvider`），需要先解析成 `SocketAuth` 才能断言。
 * 用 `pending` Promise 数组收集未 resolve 的握手，外部在断言前 `await flush` 即可。
 */
function capturingFactory() {
  const sockets: FakeSocket[] = [];
  const handshakes: Array<SocketAuth> = [];
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
  return { factory, sockets, handshakes, flush };
}

describe('restartGameSession（登录后用新令牌重建连接）', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('会话尚未初始化时抛错（不静默假装建好了）', async () => {
    const { restartGameSession } = await import('../src/composables/useGameSession');
    expect(() => restartGameSession()).toThrow(/startGameSession/);
  });

  it('hydrate 的令牌进首次握手；登录后重建的握手带新令牌，旧连接被销毁', async () => {
    const { createPinia, setActivePinia } = await import('pinia');
    setActivePinia(createPinia());
    const { saveSession, loadSession } = await import('../src/net/storage');
    const { useAuthStore } = await import('../src/stores/auth');
    const session = await import('../src/composables/useGameSession');

    // 入口顺序：先恢复令牌，再建连
    saveSession({ accessToken: 'a1', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    const auth = useAuthStore();
    auth.hydrate();

    const { factory, sockets, handshakes, flush } = capturingFactory();
    const first = session.startGameSession(factory);
    // 客户端接入片 C31 + 设备绑定片：握手 auth 恒带端标识与 deviceId（域内 8..64）
    await flush();
    expect(handshakes).toHaveLength(1);
    expect(handshakes[0]!.token).toBe('a1');
    expect(handshakes[0]!.clientPlatform).toBe('h5');
    expect(handshakes[0]!.deviceId as string).toMatch(/^[A-Za-z0-9._-]{8,64}$/);

    // 登录成功：新的一对令牌写入 store + 本地存储（R25）；展示资料与令牌**同一次写入**（Task 2R）
    auth.applySession({
      accessToken: 'a2',
      refreshToken: 'r2',
      user: { id: 'u2', phone: '13800000000' },
    });
    const second = session.restartGameSession();
    await flush();

    expect(handshakes).toHaveLength(2);
    expect(handshakes[0]!.clientPlatform).toBe('h5');
    expect(handshakes[1]!.token).toBe('a2');
    expect(handshakes[1]!.clientPlatform).toBe('h5');
    expect(handshakes[1]!.deviceId).toBe(handshakes[0]!.deviceId); // 同一枚持久指纹
    expect(sockets[0]!.disconnected).toBe(true);
    expect(second).not.toBe(first);
    expect(loadSession()).toEqual({
      accessToken: 'a2',
      refreshToken: 'r2',
      userId: 'u2',
      phone: '13800000000',
      nickname: '',
    });

    session.stopGameSession();
  });
});

/**
 * App 端 socket 包装的判据（N39 第二处，2026-09-19）。
 *
 * ## 它守的是什么
 *
 * `uni.connectSocket` 在 **App 端不返回 `SocketTask`** —— 回的对象没有 `onOpen`/`onMessage`。
 * 直接照 `SocketTask` 那条路挂监听会抛
 * `TypeError: this.task.onOpen is not a function`，而那时 app 级 `onError` 还没接上
 * ⇒ **完全静默的白屏**（真机实测原文，见 `mp-transport.ts` 的 `appConnector`）。
 *
 * App 端的正确形态是**进程级全局事件**：`uni.onSocketOpen/Message/Error/Close` +
 * `uni.sendSocketMessage` + `uni.closeSocket`。而 `@dcloudio/types` 里**没有 `offSocket*`**
 * ⇒ 那些处理器**注册后无法注销**，所以只允许注册**一次**，再分发给当前活跃实例。
 * 上面这条正是本文件第 1 条判据 —— 它是**没有 off 的直接后果**，不是风格偏好。
 *
 * ## 为什么要 `vi.resetModules()`
 *
 * 「只注册一次」是**模块级状态**（真实语义就是进程内一次）。同一个模块实例里跑多条用例会让
 * 状态跨用例泄漏 ⇒ 每条用例各自 `resetModules()` + 动态 import，拿到干净的一份。
 */
import { describe, expect, it, vi } from 'vitest';

type Handler = (...args: never[]) => void;

/** 装一个最小的 `uni` 替身，只补本测试用到的 API。 */
function installFakeUni() {
  const handlers: Record<'open' | 'message' | 'error' | 'close', Handler[]> = {
    open: [],
    message: [],
    error: [],
    close: [],
  };
  const calls = { connect: [] as { url: string }[], send: [] as { data: unknown }[], close: 0 };
  const record = (key: keyof typeof handlers) => (callback: Handler) => {
    handlers[key].push(callback);
  };

  vi.stubGlobal('uni', {
    // 平台判定读这里（`detectPlatform` → `uni.getSystemInfoSync().uniPlatform`）。
    getSystemInfoSync: () => ({ uniPlatform: 'app' }),
    connectSocket: (options: { url: string }) => {
      calls.connect.push(options);
    },
    onSocketOpen: record('open'),
    onSocketMessage: record('message'),
    onSocketError: record('error'),
    onSocketClose: record('close'),
    sendSocketMessage: (options: { data: unknown }) => {
      calls.send.push(options);
    },
    closeSocket: () => {
      calls.close += 1;
    },
  });

  return { calls, handlers };
}

const OPTS = {
  query: { EIO: 4, transport: 'websocket' },
  path: '/socket.io/',
  hostname: 'gw.test',
  port: 3000,
  secure: false,
};

async function loadTransport() {
  vi.resetModules();
  const mod = await import('../src/net/mp-transport');
  return mod.MpWebSocketTransport;
}

describe('App 端 socket 包装：uni.onSocket* 全局事件 → MpSocketTaskLike', () => {
  it('⚠️ App 上 `wx` 也存在 ⇒ 必须按平台选 uni，不能被特性探测骗走（N39 回归）', async () => {
    const { calls } = installFakeUni();
    // 实测：App 上 `typeof wx=object` 且 `wx.connectSocket` 是函数（uni 的 base 提供的 shim）。
    // 它既不返回 SocketTask、也不派发事件 ⇒ 特性探测会静默选中它，
    // 连接根本发不出去（网关侧零日志），socket.io ~20 秒后报 connect_error。
    const wxConnect = vi.fn();
    vi.stubGlobal('wx', { connectSocket: wxConnect });

    const Transport = await loadTransport();
    new Transport(OPTS).open();

    expect(wxConnect).not.toHaveBeenCalled();
    expect(calls.connect).toHaveLength(1);
  });

  it('全局处理器只注册一次（没有 offSocket* ⇒ 每次连接都注册就会泄漏）', async () => {
    const { calls, handlers } = installFakeUni();
    const Transport = await loadTransport();

    new Transport(OPTS).open();
    new Transport(OPTS).open(); // 模拟一次重连

    expect(calls.connect).toHaveLength(2);
    expect(handlers.open).toHaveLength(1);
    expect(handlers.message).toHaveLength(1);
    expect(handlers.error).toHaveLength(1);
    expect(handlers.close).toHaveLength(1);
  });

  it('事件只转发给「当前活跃」的实例：旧实例不再收到', async () => {
    const { handlers } = installFakeUni();
    const Transport = await loadTransport();

    const first: string[] = [];
    const firstTransport = new Transport(OPTS);
    firstTransport.on('open', () => void first.push('open'));
    firstTransport.open();

    const second: string[] = [];
    const secondTransport = new Transport(OPTS);
    secondTransport.on('open', () => void second.push('open'));
    secondTransport.open();

    handlers.open.forEach((handler) => handler());

    expect(second).toEqual(['open']);
    expect(first).toEqual([]);
  });

  it('send / close 走 uni.sendSocketMessage / uni.closeSocket（不是 SocketTask）', async () => {
    const { calls, handlers } = installFakeUni();
    const Transport = await loadTransport();

    const transport = new Transport(OPTS);
    transport.on('open', () => {
      transport.send([{ type: 'message', data: 'ping' }]);
    });
    transport.open();

    handlers.open.forEach((handler) => handler());
    expect(calls.send).toEqual([{ data: '4ping' }]);

    transport.close();
    expect(calls.close).toBe(1);
  });
});

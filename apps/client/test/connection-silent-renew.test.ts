/**
 * `net/socket.ts#attemptSilentRenewal`：WS 握手 10004 拒绝后的静默续期 + 无感重连五态。
 *
 * 场景：网关拒握手（access token 过期 → `system.error{10004}` → `io server disconnect`），
 * 客户端不判死、尝试 refresh。五态 + 配额保护 + onTokensRenewed 回调 + session_expired 终态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGameSession, type GameSession } from '../src/net/session';
import type { SocketAuth, SocketFactory } from '../src/net/transport';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  FakeSocket,
  resolveHandshakeAuth,
  serverMessage,
} from './helpers/fake-socket';
import { installUniStub } from './helpers/uni-stub';
import { saveSession, loadSession, clearSession } from '../src/net/storage';
import { clientConfig } from '../src/config';
import { ConnectionDeadError } from '../src/net/socket';

let socket: FakeSocket;
let session: GameSession;
let onTokensRenewedCalls: number;
/** 工厂闭包持有的 auth 函数（函数接缝），测试可重新解析以观察刷新后的握手载荷。 */
let lastAuthFn: (cb: (auth: SocketAuth) => void) => void;

/** 等待最近一次 fire-and-forget async attemptSilentRenewal 跑完。 */
async function flushAsync(): Promise<void> {
  const p = session.client.pendingSilentRenewal;
  if (p) {
    await p;
  }
  await Promise.resolve();
  await Promise.resolve();
}

function boot(): GameSession {
  socket = new FakeSocket();
  onTokensRenewedCalls = 0;
  const factory: SocketFactory = (_url, opts) => {
    if (typeof opts.auth === 'function') {
      lastAuthFn = opts.auth;
    }
    return socket;
  };
  session = createGameSession({
    socketFactory: factory,
    currentVersion: () => 5,
    applySnapshot: () => {},
    applyEvent: () => {},
    onRoomMatched: () => {},
    onRoomState: () => {},
    onRefreshSnapshot: () => {},
    onReconnect: () => {},
    onNotice: () => {},
    onTokensRenewed: () => { onTokensRenewedCalls += 1; },
  });
  socket.emitConnect();
  return session;
}

beforeEach(() => {
  installUniStub();
});

afterEach(() => {
  session?.disconnect();
});

describe('WS 10004 静默续期：场景与配额', () => {
  it('refresh 成功 → 回到 reconnecting、socket.connect() 被调、握手 token 换新；再 emitConnect 后 connected', async () => {
    clearSession();
    saveSession({ accessToken: 'old-access', refreshToken: 'refresh-1', userId: 'u1', phone: '', nickname: '' });
    clientConfig.token = 'old-access';

    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ code: 0, data: { accessToken: 'new-access', refreshToken: 'refresh-2' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    boot();

    socket.push(serverMessage('system.error', { code: ErrCode.TOKEN_EXPIRED, message: 'expired' }, 0));
    socket.emitDisconnect('io server disconnect');
    await flushAsync();

    expect(session.client.connectionState.phase).toBe('reconnecting');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onTokensRenewedCalls).toBe(1);
    expect(clientConfig.token).toBe('new-access');
    expect(loadSession()?.accessToken).toBe('new-access');

    // 重新解析 auth 函数（函数接缝），观察刷新后的握手载荷
    const handshake = await resolveHandshakeAuth(lastAuthFn);
    expect(handshake.token).toBe('new-access');

    socket.emitConnect();
    await flushAsync();
    expect(session.client.connectionState.phase).toBe('connected');
  });

  it('refresh 回 10004（确定性拒绝）→ session_expired 终态；send fail-fast', async () => {
    clearSession();
    saveSession({ accessToken: 'old', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    clientConfig.token = 'old';

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401,
      text: async () => JSON.stringify({ code: 10004, message: 'expired', data: null }),
    })));

    boot();

    socket.push(serverMessage('system.error', { code: ErrCode.TOKEN_EXPIRED, message: 'expired' }, 0));
    socket.emitDisconnect('io server disconnect');

    // 直接 await attemptSilentRenewal 的 Promise
    await session.client.pendingSilentRenewal;
    const state = session.client.connectionState;

    expect(state.phase).toBe('dead');
    expect(state.deadReason).toBe('session_expired');
    expect(state.deadCode).toBe(ErrCode.TOKEN_EXPIRED);

    // send() 在死态下 fail-fast：返回 { status: 'blocked', reason: ConnectionDeadError }
    const result = await session.client.send('room.leave');
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toBeInstanceOf(ConnectionDeadError);
    }
  });

  it('refresh 传输失败 → 保持 reconnecting；再断链仍能续期（配额未消耗）', async () => {
    clearSession();
    saveSession({ accessToken: 'old', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    clientConfig.token = 'old';

    let fetchNum = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetchNum += 1;
      if (fetchNum === 1) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { accessToken: 'new', refreshToken: 'r2' } }) };
    }));

    boot();

    // 第一次 10004 → refresh 传输失败（unavailable）→ 保持 reconnecting，不消耗配额
    socket.push(serverMessage('system.error', { code: ErrCode.TOKEN_EXPIRED, message: 'expired' }, 0));
    socket.emitDisconnect('io server disconnect');
    await flushAsync();

    expect(session.client.connectionState.phase).toBe('reconnecting');
    expect(fetchNum).toBe(1);

    // 再断链 → 这次 refresh 成功（配额没消耗，unavailable 不占配额）
    socket.push(serverMessage('system.error', { code: ErrCode.TOKEN_EXPIRED, message: 'expired' }, 0));
    socket.emitDisconnect('io server disconnect');
    await flushAsync();

    expect(clientConfig.token).toBe('new');
    expect(fetchNum).toBe(2);
  });

  it('恢复成功后再被 10004 拒 → 配额耗尽（rotated 后不重置）→ session_expired', async () => {
    clearSession();
    saveSession({ accessToken: 'old', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    clientConfig.token = 'old';

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ code: 0, data: { accessToken: 'rotated', refreshToken: 'r2' } }),
    })));

    boot();

    // 第一次 10004 → rotated（consumed 置位，不因 connect 重置）
    socket.push(serverMessage('system.error', { code: ErrCode.TOKEN_EXPIRED, message: 'expired' }, 0));
    socket.emitDisconnect('io server disconnect');
    await flushAsync();
    socket.emitConnect();
    await flushAsync();
    expect(session.client.connectionState.phase).toBe('connected');

    // 再断链 → consumed=true → session_expired
    socket.push(serverMessage('system.error', { code: ErrCode.TOKEN_EXPIRED, message: 'expired' }, 0));
    socket.emitDisconnect('io server disconnect');
    await flushAsync();

    const state = session.client.connectionState;
    expect(state.phase).toBe('dead');
    expect(state.deadReason).toBe('session_expired');
  });

  it('无 refresh token → session_expired', async () => {
    clearSession();
    saveSession({ accessToken: 'old', refreshToken: '', userId: 'u1', phone: '', nickname: '' });
    clientConfig.token = 'old';

    boot();

    socket.push(serverMessage('system.error', { code: ErrCode.TOKEN_EXPIRED, message: 'expired' }, 0));
    socket.emitDisconnect('io server disconnect');
    await flushAsync();

    const state = session.client.connectionState;
    expect(state.phase).toBe('dead');
    expect(state.deadReason).toBe('session_expired');
  });

  it('10006（并发上限）→ 不走静默恢复，直接判死 server_rejected（负对照）', async () => {
    clearSession();
    saveSession({ accessToken: 'old', refreshToken: 'r1', userId: 'u1', phone: '', nickname: '' });
    clientConfig.token = 'old';

    boot();

    socket.push(serverMessage('system.error', { code: ErrCode.RATE_LIMITED, message: 'too many connections' }, 0));
    socket.emitDisconnect('io server disconnect');
    await flushAsync();

    const state = session.client.connectionState;
    expect(state.phase).toBe('dead');
    expect(state.deadReason).toBe('server_rejected');
    expect(state.deadCode).toBe(ErrCode.RATE_LIMITED);
  });
});
